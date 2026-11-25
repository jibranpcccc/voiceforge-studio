import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import {
  AlertCircle,
  ArrowRight,
  CheckCircle2,
  Cpu,
  Download,
  Film,
  Info,
  Loader2,
  Mic,
  Music,
  Play,
  Radio,
  Scissors,
  Sparkles,
  Square,
  Trash2,
  Upload,
  Volume2,
} from 'lucide-react';
import {
  DEFAULT_PREPROCESSING_OPTIONS,
  analyzeReferenceAudio,
  pcmToAudioBufferData,
  preprocessReferenceAudio,
  type ReferencePreprocessingOptions,
} from '../audio';
import {
  AuthorizationGate,
  MicRecorder,
  PreprocessingPanel,
  QualityReportPanel,
  ReferenceUploader,
  VOICE_AUTHORIZATION_ATTESTATION_TEXT,
  type AuthorizationSourceBasis,
  type MicRecorderResult,
  type ReferenceUploaderClipResult,
} from '../components/cloning';
import { WaveformPlayer } from '../components/audio/WaveformPlayer';
import { ChatterboxEngine } from '../engines/chatterbox';
import { PocketTtsEngine } from '../engines/pocket';
import { defaultEngineRegistry } from '../engines/registry';
import { buildAudioChunkKey, saveAudioChunk } from '../storage/db';
import { useAppStore, useModelStore, useStudioStore, useVoiceStore } from '../stores';
import type {
  AudioBufferData,
  AudioQualityAnalysis,
  EngineId,
  EngineLoadProgress,
  HardwareCompatibilityReport,
  ReferenceClipMetadata,
  SynthesisResult,
  VoiceCloningEngine,
  VoiceConditioningPayload,
  VoiceProfile,
} from '../types';

type CloningEngineChoice = 'pocket-tts' | 'chatterbox';

interface SessionClip {
  id: string;
  audio: AudioBufferData;
  metadata: ReferenceClipMetadata;
  extractedFromVideo: boolean;
  quickScore: number;
}

const ENGINE_SPECS: Record<
  CloningEngineChoice,
  {
    label: string;
    shortLabel: string;
    minRecommendedSec: number;
    maxRecommendedSec: number;
    maxSupportedSec: number;
    conditioningSummary: string;
    sizeLabel: string;
  }
> = {
  'pocket-tts': {
    label: 'Pocket TTS ONNX (6L INT8)',
    shortLabel: 'Pocket TTS',
    minRecommendedSec: 5,
    maxRecommendedSec: 10,
    maxSupportedSec: 30,
    conditioningSummary:
      'Pocket TTS (mimi_encoder_int8) conditions exclusively on a single continuous Primary Reference Clip (5–10s recommended, 30s max). Additional session clips are never silently averaged or concatenated.',
    sizeLabel: '~146 MB',
  },
  chatterbox: {
    label: 'Chatterbox ONNX (WebGPU)',
    shortLabel: 'Chatterbox ONNX',
    minRecommendedSec: 6,
    maxRecommendedSec: 10,
    maxSupportedSec: 10,
    conditioningSummary:
      'Chatterbox (speech_encoder) conditions exclusively on a single continuous Primary Reference Clip (6–10s recommended, 10s max cap). Additional session clips are never silently averaged or concatenated.',
    sizeLabel: '~1.50 GB',
  },
};

const PREVIEW_SAMPLE_SENTENCES = [
  'Hello! This is an instant local voice clone preview running privately inside my browser.',
  'The crisp autumn morning air drifted across the quiet studio as the narrator began.',
  'Every waveform and neural conditioning tensor stays completely on your own device.',
];

function getOrRegisterEngine(
  engineId: CloningEngineChoice,
  customModelBaseUrl?: string
): VoiceCloningEngine {
  const existing = defaultEngineRegistry.get(engineId);
  if (existing) return existing;

  const instance: VoiceCloningEngine =
    engineId === 'pocket-tts'
      ? new PocketTtsEngine({
          customModelBaseUrl: customModelBaseUrl || undefined,
        })
      : new ChatterboxEngine();

  defaultEngineRegistry.register(instance, { replace: true });
  return instance;
}

function sliceAudioBufferData(
  audio: AudioBufferData,
  startSec: number,
  endSec: number
): AudioBufferData {
  const channels = Math.max(1, audio.channels || 1);
  const totalFrames = Math.floor(audio.samples.length / channels);
  const clampedStart = Math.max(0, Math.min(startSec, audio.durationSec));
  const clampedEnd = Math.max(clampedStart + 0.05, Math.min(endSec, audio.durationSec));

  const startFrame = Math.max(0, Math.min(totalFrames - 1, Math.floor(clampedStart * audio.sampleRate)));
  const endFrame = Math.max(
    startFrame + 1,
    Math.min(totalFrames, Math.ceil(clampedEnd * audio.sampleRate))
  );

  const sliced = audio.samples.subarray(startFrame * channels, endFrame * channels);
  return pcmToAudioBufferData(sliced, audio.sampleRate, channels);
}

function generateVoiceId(): string {
  if (typeof crypto !== 'undefined' && typeof crypto.randomUUID === 'function') {
    return crypto.randomUUID();
  }
  return `voice-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
}

function formatBytes(bytes: number): string {
  if (bytes >= 1024 * 1024 * 1024) {
    return `${(bytes / (1024 * 1024 * 1024)).toFixed(2)} GB`;
  }
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

export function VoiceCloningPage() {
  const executionMode = useAppStore((s) => s.executionMode);
  const customModelBaseUrl = useAppStore((s) => s.customModelBaseUrl);
  const modelStates = useModelStore((s) => s.models);
  const loadManifest = useModelStore((s) => s.loadManifest);
  const refreshCacheStatus = useModelStore((s) => s.refreshCacheStatus);
  const recordMeasuredRtf = useModelStore((s) => s.recordMeasuredRtf);
  const saveVoiceProfile = useVoiceStore((s) => s.saveVoiceProfile);
  const selectStudioVoice = useStudioStore((s) => s.selectVoice);
  const selectStudioEngine = useStudioStore((s) => s.selectEngine);

  const [inputTab, setInputTab] = useState<'upload' | 'mic'>('upload');
  const [clips, setClips] = useState<SessionClip[]>([]);
  const [primaryClipId, setPrimaryClipId] = useState<string | null>(null);

  const [selectedEngineId, setSelectedEngineId] = useState<CloningEngineChoice>('pocket-tts');
  const [trimStartSec, setTrimStartSec] = useState<number>(0);
  const [trimEndSec, setTrimEndSec] = useState<number>(10);
  const [abMode, setAbMode] = useState<'original' | 'processed'>('processed');
  const [preprocessingOpts, setPreprocessingOpts] = useState<ReferencePreprocessingOptions>({
    ...DEFAULT_PREPROCESSING_OPTIONS,
    maxDurationSec: 10,
  });

  const [voiceName, setVoiceName] = useState('');
  const [voiceDescription, setVoiceDescription] = useState('');
  const [voiceLanguage, setVoiceLanguage] = useState('en');
  const [voiceTagsRaw, setVoiceTagsRaw] = useState('');

  const [authConfirmed, setAuthConfirmed] = useState(false);
  const [authSourceBasis, setAuthSourceBasis] = useState<AuthorizationSourceBasis>('self');

  const [hwReports, setHwReports] = useState<Partial<Record<EngineId, HardwareCompatibilityReport>>>({});
  const [engineInitializedMap, setEngineInitializedMap] = useState<Record<string, boolean>>({});
  const [initProgress, setInitProgress] = useState<EngineLoadProgress | null>(null);
  const [isInitializingEngine, setIsInitializingEngine] = useState(false);
  const [engineError, setEngineError] = useState<string | null>(null);
  const initAbortRef = useRef<AbortController | null>(null);

  const [isEncoding, setIsEncoding] = useState(false);
  const [encodeStageMessage, setEncodeStageMessage] = useState<string | null>(null);
  const [savedProfile, setSavedProfile] = useState<VoiceProfile | null>(null);

  const [previewText, setPreviewText] = useState(PREVIEW_SAMPLE_SENTENCES[0]);
  const [isSynthesizingPreview, setIsSynthesizingPreview] = useState(false);
  const [previewResult, setPreviewResult] = useState<SynthesisResult | null>(null);
  const [previewError, setPreviewError] = useState<string | null>(null);
  const synthAbortRef = useRef<AbortController | null>(null);

  const engineSpec = ENGINE_SPECS[selectedEngineId];

  // Load model manifest & hardware reports on mount
  useEffect(() => {
    void loadManifest().catch(() => undefined);

    let cancelled = false;
    const probe = async () => {
      const pocket = getOrRegisterEngine('pocket-tts', customModelBaseUrl);
      const chatterbox = getOrRegisterEngine('chatterbox', customModelBaseUrl);
      setEngineInitializedMap({
        'pocket-tts': pocket.getModelMetadata().isInitialized,
        chatterbox: chatterbox.getModelMetadata().isInitialized,
      });

      const [pocketHw, chatterHw] = await Promise.all([
        pocket.checkHardwareCompatibility().catch(() => null),
        chatterbox.checkHardwareCompatibility().catch(() => null),
      ]);
      if (cancelled) return;
      setHwReports({
        ...(pocketHw ? { 'pocket-tts': pocketHw } : {}),
        ...(chatterHw ? { chatterbox: chatterHw } : {}),
      });
    };
    void probe();

    return () => {
      cancelled = true;
    };
  }, [customModelBaseUrl, loadManifest]);

  const activeEngine = useMemo(
    () => getOrRegisterEngine(selectedEngineId, customModelBaseUrl),
    [selectedEngineId, customModelBaseUrl]
  );

  const supportedLanguages = useMemo(
    () => activeEngine.getSupportedLanguages(),
    [activeEngine]
  );

  const resolvedVoiceLanguage = useMemo(() => {
    if (supportedLanguages.some((l) => l.code === voiceLanguage)) {
      return voiceLanguage;
    }
    return supportedLanguages[0]?.code ?? 'en';
  }, [supportedLanguages, voiceLanguage]);

  const primaryClip = useMemo(
    () => clips.find((c) => c.id === primaryClipId) ?? clips[0] ?? null,
    [clips, primaryClipId]
  );

  // Sync trim bounds whenever primary clip changes
  const resetTrimForClip = useCallback((clip: SessionClip | null) => {
    if (!clip) {
      setTrimStartSec(0);
      setTrimEndSec(0);
      return;
    }
    setTrimStartSec(0);
    setTrimEndSec(Number(clip.audio.durationSec.toFixed(2)));
  }, []);

  const handleAddUploadedClips = useCallback(
    (incoming: ReferenceUploaderClipResult[]) => {
      const created: SessionClip[] = incoming.map((item) => {
        const analysis = analyzeReferenceAudio(item.audio, {
          minRecommendedSec: engineSpec.minRecommendedSec,
          maxRecommendedSec: engineSpec.maxRecommendedSec,
        });
        return {
          id: item.metadata.clipId,
          audio: item.audio,
          metadata: item.metadata,
          extractedFromVideo: item.extractedFromVideo,
          quickScore: analysis.overallScore,
        };
      });

      setClips((prev) => {
        const next = [...prev, ...created];
        if (!primaryClipId && created.length > 0) {
          setPrimaryClipId(created[0].id);
          resetTrimForClip(created[0]);
        }
        return next;
      });

      if (!voiceName.trim() && created.length > 0) {
        const base = created[0].metadata.filename.replace(/\.[^/.]+$/, '');
        setVoiceName(base.slice(0, 60));
      }
    },
    [engineSpec.maxRecommendedSec, engineSpec.minRecommendedSec, primaryClipId, resetTrimForClip, voiceName]
  );

  const handleMicRecorded = useCallback(
    (recorded: MicRecorderResult) => {
      const analysis = analyzeReferenceAudio(recorded.audio, {
        minRecommendedSec: engineSpec.minRecommendedSec,
        maxRecommendedSec: engineSpec.maxRecommendedSec,
      });
      const sessionClip: SessionClip = {
        id: recorded.metadata.clipId,
        audio: recorded.audio,
        metadata: recorded.metadata,
        extractedFromVideo: false,
        quickScore: analysis.overallScore,
      };
      setClips((prev) => {
        const next = [...prev, sessionClip];
        if (!primaryClipId) {
          setPrimaryClipId(sessionClip.id);
          resetTrimForClip(sessionClip);
        }
        return next;
      });
      if (!voiceName.trim()) {
        setVoiceName('My Recorded Voice');
      }
    },
    [engineSpec.maxRecommendedSec, engineSpec.minRecommendedSec, primaryClipId, resetTrimForClip, voiceName]
  );

  const handleSelectPrimaryClip = useCallback(
    (clip: SessionClip) => {
      setPrimaryClipId(clip.id);
      resetTrimForClip(clip);
    },
    [resetTrimForClip]
  );

  const handleRemoveClip = useCallback(
    (clipId: string) => {
      setClips((prev) => {
        const filtered = prev.filter((c) => c.id !== clipId);
        if (primaryClipId === clipId) {
          const nextPrimary = filtered[0] ?? null;
          setPrimaryClipId(nextPrimary?.id ?? null);
          resetTrimForClip(nextPrimary);
        }
        return filtered;
      });
    },
    [primaryClipId, resetTrimForClip]
  );

  const handleTrimChange = useCallback(
    (start: number, end: number) => {
      if (!primaryClip) return;
      const maxDur = primaryClip.audio.durationSec;
      const safeStart = Math.max(0, Math.min(start, Math.max(0, maxDur - 0.25)));
      const safeEnd = Math.max(safeStart + 0.25, Math.min(end, maxDur));
      setTrimStartSec(Number(safeStart.toFixed(2)));
      setTrimEndSec(Number(safeEnd.toFixed(2)));
    },
    [primaryClip]
  );

  // Trimmed original audio
  const trimmedOriginalAudio = useMemo<AudioBufferData | null>(() => {
    if (!primaryClip) return null;
    return sliceAudioBufferData(primaryClip.audio, trimStartSec, trimEndSec);
  }, [primaryClip, trimStartSec, trimEndSec]);

  // Non-destructive preprocessed audio derived from trimmed selection
  const processedAudio = useMemo<AudioBufferData | null>(() => {
    if (!trimmedOriginalAudio) return null;
    try {
      return preprocessReferenceAudio(trimmedOriginalAudio, {
        ...preprocessingOpts,
        maxDurationSec: Math.min(
          preprocessingOpts.maxDurationSec,
          engineSpec.maxSupportedSec
        ),
      });
    } catch {
      return trimmedOriginalAudio;
    }
  }, [trimmedOriginalAudio, preprocessingOpts, engineSpec.maxSupportedSec]);

  const originalAnalysis = useMemo<AudioQualityAnalysis | null>(() => {
    if (!trimmedOriginalAudio) return null;
    try {
      return analyzeReferenceAudio(trimmedOriginalAudio, {
        minRecommendedSec: engineSpec.minRecommendedSec,
        maxRecommendedSec: engineSpec.maxRecommendedSec,
      });
    } catch {
      return null;
    }
  }, [trimmedOriginalAudio, engineSpec.maxRecommendedSec, engineSpec.minRecommendedSec]);

  const processedAnalysis = useMemo<AudioQualityAnalysis | null>(() => {
    if (!processedAudio) return null;
    try {
      return analyzeReferenceAudio(processedAudio, {
        minRecommendedSec: engineSpec.minRecommendedSec,
        maxRecommendedSec: engineSpec.maxRecommendedSec,
      });
    } catch {
      return null;
    }
  }, [processedAudio, engineSpec.maxRecommendedSec, engineSpec.minRecommendedSec]);

  const activeWaveformAudio =
    abMode === 'processed' ? processedAudio : primaryClip?.audio ?? null;
  const activeAnalysis =
    abMode === 'processed' ? processedAnalysis : originalAnalysis;

  const modelRuntime = modelStates[selectedEngineId];
  const isEngineInitialized =
    Boolean(engineInitializedMap[selectedEngineId]) ||
    activeEngine.getModelMetadata().isInitialized;
  const isModelCached = Boolean(modelRuntime?.offlineReady);

  const handleInitializeEngine = useCallback(async () => {
    setEngineError(null);
    setIsInitializingEngine(true);
    setInitProgress({
      phase: 'checking',
      item: selectedEngineId,
      progress: 0,
      message: 'Preparing local engine initialization...',
    });

    const controller = new AbortController();
    initAbortRef.current = controller;

    try {
      await activeEngine.initialize(
        {
          executionMode,
          signal: controller.signal,
        },
        (progress) => {
          setInitProgress(progress);
        }
      );

      setEngineInitializedMap((prev) => ({
        ...prev,
        [selectedEngineId]: true,
      }));
      await refreshCacheStatus(selectedEngineId).catch(() => undefined);
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      if (!(err instanceof Error && err.name === 'AbortError')) {
        setEngineError(msg);
      }
    } finally {
      initAbortRef.current = null;
      setIsInitializingEngine(false);
    }
  }, [activeEngine, executionMode, refreshCacheStatus, selectedEngineId]);

  const handleCancelInit = useCallback(() => {
    initAbortRef.current?.abort();
    void activeEngine.cancel();
  }, [activeEngine]);

  const handleEncodeAndSave = useCallback(async () => {
    if (!primaryClip || !processedAudio || !processedAnalysis) return;
    if (!authConfirmed) {
      setEngineError('Please confirm authorized voice use before encoding.');
      return;
    }
    const cleanName = voiceName.trim();
    if (!cleanName) {
      setEngineError('Please enter a voice profile name.');
      return;
    }

    setEngineError(null);
    setIsEncoding(true);

    try {
      // Ensure engine is initialized; prompt/initialize cleanly if needed
      if (!activeEngine.getModelMetadata().isInitialized) {
        setEncodeStageMessage(
          isModelCached
            ? `Loading cached ${engineSpec.shortLabel} weights into memory...`
            : `Downloading & initializing ${engineSpec.shortLabel} (${engineSpec.sizeLabel})...`
        );
        const controller = new AbortController();
        initAbortRef.current = controller;
        setIsInitializingEngine(true);
        await activeEngine.initialize(
          { executionMode, signal: controller.signal },
          (progress) => setInitProgress(progress)
        );
        setEngineInitializedMap((prev) => ({
          ...prev,
          [selectedEngineId]: true,
        }));
        setIsInitializingEngine(false);
        await refreshCacheStatus(selectedEngineId).catch(() => undefined);
      }

      setEncodeStageMessage(`Encoding voice conditioning payload with ${engineSpec.shortLabel}...`);
      const audioToEncode = abMode === 'original' && trimmedOriginalAudio ? trimmedOriginalAudio : processedAudio;
      const analysisToSave =
        abMode === 'original' && originalAnalysis ? originalAnalysis : processedAnalysis;

      const clipMetaForEncode: ReferenceClipMetadata = {
        ...primaryClip.metadata,
        durationSec: audioToEncode.durationSec,
        sampleRate: audioToEncode.sampleRate,
        channels: audioToEncode.channels,
        language: resolvedVoiceLanguage,
      };

      const payload: VoiceConditioningPayload = await activeEngine.encodeVoice(
        audioToEncode,
        clipMetaForEncode
      );
      const payloadKey = `${payload.engineId}::${payload.modelRevision}`;

      const now = new Date().toISOString();
      const parsedTags = voiceTagsRaw
        .split(',')
        .map((t) => t.trim())
        .filter(Boolean)
        .slice(0, 20);

      // If updating the profile created earlier in this session with an additional engine payload
      const profileId = savedProfile?.id ?? generateVoiceId();
      const previewClipKey = buildAudioChunkKey('voice-preview', profileId);

      await saveAudioChunk({
        projectId: 'voice-preview',
        chunkId: profileId,
        sampleRate: audioToEncode.sampleRate,
        pcm: audioToEncode.samples,
        durationSec: audioToEncode.durationSec,
      });

      const profileToSave: VoiceProfile = {
        id: profileId,
        name: cleanName,
        ...(voiceDescription.trim() ? { description: voiceDescription.trim() } : {}),
        language: resolvedVoiceLanguage,
        tags: parsedTags,
        referenceClip: clipMetaForEncode,
        qualityAnalysis: analysisToSave,
        authorizedUse: {
          confirmed: true,
          confirmedAt: now,
          attestationText: VOICE_AUTHORIZATION_ATTESTATION_TEXT,
          sourceBasis: authSourceBasis,
          verificationScope: 'client-self-attested',
        },
        conditioningPayloads: {
          ...(savedProfile?.conditioningPayloads ?? {}),
          [payloadKey]: payload,
        },
        previewClipId: previewClipKey,
        createdAt: savedProfile?.createdAt ?? now,
        updatedAt: now,
      };

      await saveVoiceProfile(profileToSave, { engineId: selectedEngineId });
      setSavedProfile(profileToSave);
      setPreviewResult(null);
      setPreviewError(null);
      setEncodeStageMessage(null);
    } catch (err) {
      setEngineError(err instanceof Error ? err.message : String(err));
    } finally {
      initAbortRef.current = null;
      setIsInitializingEngine(false);
      setIsEncoding(false);
      setEncodeStageMessage(null);
    }
  }, [
    abMode,
    activeEngine,
    authConfirmed,
    authSourceBasis,
    engineSpec.shortLabel,
    engineSpec.sizeLabel,
    executionMode,
    isModelCached,
    originalAnalysis,
    primaryClip,
    processedAnalysis,
    processedAudio,
    refreshCacheStatus,
    saveVoiceProfile,
    savedProfile,
    selectedEngineId,
    trimmedOriginalAudio,
    voiceDescription,
    resolvedVoiceLanguage,
    voiceName,
    voiceTagsRaw,
  ]);

  const handleSynthesizePreview = useCallback(async () => {
    if (!savedProfile) return;
    const text = previewText.trim();
    if (!text) {
      setPreviewError('Enter a preview sentence to synthesize.');
      return;
    }

    setPreviewError(null);
    setIsSynthesizingPreview(true);
    const controller = new AbortController();
    synthAbortRef.current = controller;

    try {
      const meta = activeEngine.getModelMetadata();
      const expectedKey = `${meta.engineId}::${meta.modelRevision}`;
      if (!savedProfile.conditioningPayloads[expectedKey]) {
        throw new Error(
          `Profile "${savedProfile.name}" has not been encoded for ${engineSpec.shortLabel} yet. Click "Encode & Save Voice Profile" above first.`
        );
      }

      if (!meta.isInitialized) {
        await activeEngine.initialize({ executionMode, signal: controller.signal });
        setEngineInitializedMap((prev) => ({ ...prev, [selectedEngineId]: true }));
      }

      const handle = await activeEngine.loadVoiceProfile(savedProfile);
      const res = await activeEngine.synthesize({
        text,
        voiceHandle: handle,
        language: resolvedVoiceLanguage,
        signal: controller.signal,
      });

      setPreviewResult(res);
      recordMeasuredRtf(selectedEngineId, res.realTimeFactor, res.generationTimeMs);

      await saveAudioChunk({
        projectId: 'voice-preview-synth',
        chunkId: savedProfile.id,
        sampleRate: res.audio.sampleRate,
        pcm: res.audio.samples,
        durationSec: res.audio.durationSec,
      });
    } catch (err) {
      if (!(err instanceof Error && err.name === 'AbortError')) {
        setPreviewError(err instanceof Error ? err.message : String(err));
      }
    } finally {
      synthAbortRef.current = null;
      setIsSynthesizingPreview(false);
    }
  }, [
    activeEngine,
    engineSpec.shortLabel,
    executionMode,
    previewText,
    recordMeasuredRtf,
    savedProfile,
    selectedEngineId,
    resolvedVoiceLanguage,
  ]);

  const handleCancelPreviewSynth = useCallback(() => {
    synthAbortRef.current?.abort();
    void activeEngine.cancel();
  }, [activeEngine]);

  const handleUseInStudio = useCallback(() => {
    if (!savedProfile) return;
    selectStudioVoice(savedProfile.id);
    selectStudioEngine(selectedEngineId);
    window.location.hash = '#/studio';
  }, [savedProfile, selectStudioEngine, selectStudioVoice, selectedEngineId]);

  const activeHwReport = hwReports[selectedEngineId];
  const savedHasCurrentEngine = Boolean(
    savedProfile?.conditioningPayloads[
      `${activeEngine.id}::${activeEngine.getModelMetadata().modelRevision}`
    ]
  );

  const canEncode =
    Boolean(primaryClip) &&
    Boolean(processedAudio) &&
    authConfirmed &&
    voiceName.trim().length > 0 &&
    !isEncoding &&
    !isInitializingEngine;

  return (
    <div className="max-w-6xl mx-auto space-y-6 pb-10">
      {/* Header */}
      <div className="flex flex-wrap items-start justify-between gap-4">
        <div className="space-y-1">
          <h1 className="text-2xl font-bold tracking-tight text-slate-900 dark:text-slate-100">
            Voice Cloning Lab
          </h1>
          <p className="text-sm text-slate-600 dark:text-slate-400">
            Capture or import authorized speech, inspect acoustic quality non-destructively, and
            encode engine-scoped voice conditioning locally in your browser.
          </p>
        </div>

        <button
          type="button"
          onClick={() => {
            window.location.hash = '#/voices';
          }}
          className="inline-flex items-center gap-1.5 rounded-lg border border-slate-300 dark:border-slate-700 bg-white dark:bg-[#121622] px-3.5 py-2 text-xs font-semibold text-slate-700 dark:text-slate-200 hover:bg-slate-100 dark:hover:bg-slate-800"
        >
          My Voices
          <ArrowRight className="h-3.5 w-3.5" />
        </button>
      </div>

      {/* Step 1: Engine & Conditioning Rule */}
      <section className="rounded-xl border border-slate-200 dark:border-slate-800 bg-white dark:bg-[#121622] p-4 space-y-3">
        <div className="flex flex-wrap items-center justify-between gap-2">
          <div className="flex items-center gap-2">
            <Cpu className="h-4 w-4 text-[#7C5CFF]" />
            <h2 className="text-sm font-semibold text-slate-900 dark:text-slate-100">
              1. Target Voice Cloning Engine
            </h2>
          </div>
          <span className="text-[11px] text-slate-500 dark:text-slate-400">
            Conditioning embeddings are strictly engine &amp; revision scoped
          </span>
        </div>

        <div className="grid grid-cols-1 md:grid-cols-2 gap-3">
          {(['pocket-tts', 'chatterbox'] as const).map((engId) => {
            const spec = ENGINE_SPECS[engId];
            const selected = selectedEngineId === engId;
            const hw = hwReports[engId];
            const cached = Boolean(modelStates[engId]?.offlineReady);
            const initialized = Boolean(engineInitializedMap[engId]);

            return (
              <button
                key={engId}
                type="button"
                onClick={() => {
                  setSelectedEngineId(engId);
                  setEngineError(null);
                  setPreprocessingOpts((prev) => ({
                    ...prev,
                    maxDurationSec: Math.min(prev.maxDurationSec, spec.maxSupportedSec),
                  }));
                }}
                className={`text-left rounded-xl border p-3.5 transition-all ${
                  selected
                    ? 'border-[#7C5CFF] bg-[#7C5CFF]/10 ring-1 ring-[#7C5CFF]/40'
                    : 'border-slate-200 dark:border-slate-800 bg-slate-50/60 dark:bg-[#0B0D12]/60 hover:border-slate-300 dark:hover:border-slate-700'
                }`}
              >
                <div className="flex items-center justify-between gap-2">
                  <span className="text-sm font-semibold text-slate-900 dark:text-slate-100">
                    {spec.label}
                  </span>
                  <span className="text-[11px] font-mono text-slate-500 dark:text-slate-400">
                    {spec.sizeLabel}
                  </span>
                </div>
                <div className="mt-2 flex flex-wrap items-center gap-1.5 text-[11px]">
                  <span className="rounded-md bg-slate-200/70 dark:bg-slate-800 px-2 py-0.5 text-slate-700 dark:text-slate-300">
                    Ideal ref: {spec.minRecommendedSec}–{spec.maxRecommendedSec}s
                  </span>
                  <span
                    className={`rounded-md px-2 py-0.5 font-medium ${
                      initialized
                        ? 'bg-emerald-500/15 text-emerald-600 dark:text-emerald-300'
                        : cached
                          ? 'bg-sky-500/15 text-sky-600 dark:text-sky-300'
                          : 'bg-amber-500/15 text-amber-600 dark:text-amber-300'
                    }`}
                  >
                    {initialized
                      ? 'Engine Loaded'
                      : cached
                        ? 'Cached Offline'
                        : 'Download Required'}
                  </span>
                  {hw && (
                    <span className="rounded-md bg-slate-200/70 dark:bg-slate-800 px-2 py-0.5 text-slate-600 dark:text-slate-300">
                      Backend: {hw.recommendedBackend.toUpperCase()}
                    </span>
                  )}
                </div>
              </button>
            );
          })}
        </div>

        {/* Engine Conditioning Rule Disclosure */}
        <div className="flex items-start gap-2 rounded-lg border border-indigo-500/25 bg-indigo-500/5 p-3 text-xs text-slate-700 dark:text-slate-300">
          <Info className="h-4 w-4 shrink-0 mt-0.5 text-[#7C5CFF]" />
          <div>
            <strong>Engine Conditioning Rule:</strong> {engineSpec.conditioningSummary}
          </div>
        </div>

        {activeHwReport && activeHwReport.warnings.length > 0 && (
          <div className="rounded-lg border border-amber-500/30 bg-amber-500/10 px-3 py-2 text-xs text-amber-800 dark:text-amber-200">
            {activeHwReport.warnings[0]}
          </div>
        )}
      </section>

      {/* Step 2: Audio Input Sources + Session Clips */}
      <section className="grid grid-cols-1 lg:grid-cols-12 gap-5">
        <div className="lg:col-span-7 rounded-xl border border-slate-200 dark:border-slate-800 bg-white dark:bg-[#121622] p-4 space-y-4">
          <div className="flex flex-wrap items-center justify-between gap-2">
            <h2 className="text-sm font-semibold text-slate-900 dark:text-slate-100">
              2. Add Reference Audio Clips
            </h2>
            <div className="inline-flex rounded-lg border border-slate-200 dark:border-slate-800 bg-slate-100 dark:bg-[#0B0D12] p-0.5">
              <button
                type="button"
                onClick={() => setInputTab('upload')}
                className={`inline-flex items-center gap-1.5 rounded-md px-3 py-1 text-xs font-medium transition-colors ${
                  inputTab === 'upload'
                    ? 'bg-[#7C5CFF] text-white'
                    : 'text-slate-600 dark:text-slate-300 hover:text-slate-900 dark:hover:text-white'
                }`}
              >
                <Upload className="h-3.5 w-3.5" />
                File / Video
              </button>
              <button
                type="button"
                onClick={() => setInputTab('mic')}
                className={`inline-flex items-center gap-1.5 rounded-md px-3 py-1 text-xs font-medium transition-colors ${
                  inputTab === 'mic'
                    ? 'bg-[#7C5CFF] text-white'
                    : 'text-slate-600 dark:text-slate-300 hover:text-slate-900 dark:hover:text-white'
                }`}
              >
                <Mic className="h-3.5 w-3.5" />
                Microphone
              </button>
            </div>
          </div>

          {inputTab === 'upload' ? (
            <ReferenceUploader onClipsAdded={handleAddUploadedClips} />
          ) : (
            <MicRecorder
              onClipRecorded={handleMicRecorded}
              minRecommendedSec={engineSpec.minRecommendedSec}
              maxRecommendedSec={engineSpec.maxRecommendedSec}
            />
          )}
        </div>

        {/* Session Clips Manager */}
        <div className="lg:col-span-5 rounded-xl border border-slate-200 dark:border-slate-800 bg-white dark:bg-[#121622] p-4 space-y-3">
          <div className="flex items-center justify-between">
            <h2 className="text-sm font-semibold text-slate-900 dark:text-slate-100">
              Session Clips ({clips.length})
            </h2>
            <span className="text-[11px] text-slate-500 dark:text-slate-400">
              Select 1 Primary Clip
            </span>
          </div>

          {clips.length === 0 ? (
            <div className="rounded-lg border border-dashed border-slate-300 dark:border-slate-800 p-6 text-center text-xs text-slate-500 dark:text-slate-400">
              No reference clips added yet. Upload an audio/video file or record with your
              microphone to start.
            </div>
          ) : (
            <div className="space-y-2 max-h-72 overflow-y-auto pr-1">
              {clips.map((clip) => {
                const isPrimary = primaryClip?.id === clip.id;
                return (
                  <div
                    key={clip.id}
                    className={`rounded-lg border p-2.5 transition-colors ${
                      isPrimary
                        ? 'border-[#7C5CFF] bg-[#7C5CFF]/10'
                        : 'border-slate-200 dark:border-slate-800 bg-slate-50/70 dark:bg-[#0B0D12]/50'
                    }`}
                  >
                    <div className="flex items-start justify-between gap-2">
                      <div className="min-w-0 flex-1 space-y-1">
                        <div className="flex items-center gap-1.5">
                          {clip.metadata.source === 'microphone' ? (
                            <Mic className="h-3.5 w-3.5 shrink-0 text-rose-400" />
                          ) : clip.extractedFromVideo ? (
                            <Film className="h-3.5 w-3.5 shrink-0 text-emerald-400" />
                          ) : (
                            <Music className="h-3.5 w-3.5 shrink-0 text-[#7C5CFF]" />
                          )}
                          <span className="truncate text-xs font-semibold text-slate-900 dark:text-slate-100">
                            {clip.metadata.filename}
                          </span>
                        </div>
                        <div className="flex flex-wrap items-center gap-2 text-[11px] text-slate-500 dark:text-slate-400 font-mono">
                          <span>{clip.audio.durationSec.toFixed(2)}s</span>
                          <span>{(clip.audio.sampleRate / 1000).toFixed(1)}kHz</span>
                          <span>{clip.audio.channels}ch</span>
                          <span className="text-slate-700 dark:text-slate-300">
                            Score {clip.quickScore}/100
                          </span>
                        </div>
                      </div>

                      <div className="flex items-center gap-1.5 shrink-0">
                        <button
                          type="button"
                          onClick={() => handleSelectPrimaryClip(clip)}
                          className={`rounded-md px-2 py-1 text-[11px] font-semibold transition-colors ${
                            isPrimary
                              ? 'bg-[#7C5CFF] text-white'
                              : 'border border-slate-300 dark:border-slate-700 text-slate-700 dark:text-slate-300 hover:bg-slate-200 dark:hover:bg-slate-800'
                          }`}
                        >
                          {isPrimary ? 'Primary' : 'Set Primary'}
                        </button>
                        <button
                          type="button"
                          onClick={() => handleRemoveClip(clip.id)}
                          aria-label={`Remove ${clip.metadata.filename}`}
                          className="rounded-md p-1 text-slate-400 hover:text-rose-500 hover:bg-rose-500/10"
                        >
                          <Trash2 className="h-3.5 w-3.5" />
                        </button>
                      </div>
                    </div>
                  </div>
                );
              })}
            </div>
          )}
        </div>
      </section>

      {/* Step 3: Waveform Trimming, A/B Toggle, Quality Inspection & Preprocessing */}
      {primaryClip && (
        <section className="space-y-5">
          <div className="rounded-xl border border-slate-200 dark:border-slate-800 bg-white dark:bg-[#121622] p-4 space-y-4">
            <div className="flex flex-wrap items-center justify-between gap-3">
              <div className="flex items-center gap-2">
                <Scissors className="h-4 w-4 text-[#7C5CFF]" />
                <h2 className="text-sm font-semibold text-slate-900 dark:text-slate-100">
                  3. Trim, Inspect &amp; A/B Compare
                </h2>
              </div>

              {/* Original vs Processed A/B Toggle right with WaveformPlayer */}
              <div className="flex items-center gap-2">
                <span className="text-[11px] font-medium text-slate-500 dark:text-slate-400">
                  A/B Audition:
                </span>
                <div className="inline-flex rounded-lg border border-slate-200 dark:border-slate-800 bg-slate-100 dark:bg-[#0B0D12] p-0.5">
                  <button
                    type="button"
                    onClick={() => setAbMode('original')}
                    className={`rounded-md px-3 py-1 text-xs font-semibold transition-colors ${
                      abMode === 'original'
                        ? 'bg-slate-900 dark:bg-slate-700 text-white'
                        : 'text-slate-600 dark:text-slate-300 hover:text-slate-900 dark:hover:text-white'
                    }`}
                  >
                    Original
                  </button>
                  <button
                    type="button"
                    onClick={() => setAbMode('processed')}
                    className={`rounded-md px-3 py-1 text-xs font-semibold transition-colors ${
                      abMode === 'processed'
                        ? 'bg-[#7C5CFF] text-white'
                        : 'text-slate-600 dark:text-slate-300 hover:text-slate-900 dark:hover:text-white'
                    }`}
                  >
                    Processed
                  </button>
                </div>
              </div>
            </div>

            <WaveformPlayer
              samples={activeWaveformAudio?.samples ?? null}
              sampleRate={activeWaveformAudio?.sampleRate ?? 24000}
              title={
                abMode === 'original'
                  ? `Original (${primaryClip.metadata.filename}) — drag handles to trim`
                  : `Processed Output (${processedAudio?.durationSec.toFixed(2) ?? '0.00'}s @ 24 kHz mono)`
              }
              height={120}
              trimStartSec={abMode === 'original' ? trimStartSec : undefined}
              trimEndSec={abMode === 'original' ? trimEndSec : undefined}
              onTrimChange={abMode === 'original' ? handleTrimChange : undefined}
            />

            {/* Explicit Manual Trim Sliders & Precise Controls */}
            <div className="grid grid-cols-1 sm:grid-cols-3 gap-3 items-end rounded-lg border border-slate-200/80 dark:border-slate-800 bg-slate-50/70 dark:bg-[#0B0D12]/50 p-3">
              <div className="space-y-1">
                <div className="flex items-center justify-between text-xs">
                  <label htmlFor="trim-start-slider" className="text-slate-600 dark:text-slate-300">
                    Trim Start
                  </label>
                  <span className="font-mono text-slate-900 dark:text-slate-100">
                    {trimStartSec.toFixed(2)}s
                  </span>
                </div>
                <input
                  id="trim-start-slider"
                  type="range"
                  min={0}
                  max={Math.max(0, primaryClip.audio.durationSec - 0.25)}
                  step={0.05}
                  value={trimStartSec}
                  onChange={(e) => handleTrimChange(Number(e.target.value), trimEndSec)}
                  className="w-full accent-[#7C5CFF]"
                />
              </div>

              <div className="space-y-1">
                <div className="flex items-center justify-between text-xs">
                  <label htmlFor="trim-end-slider" className="text-slate-600 dark:text-slate-300">
                    Trim End
                  </label>
                  <span className="font-mono text-slate-900 dark:text-slate-100">
                    {trimEndSec.toFixed(2)}s
                  </span>
                </div>
                <input
                  id="trim-end-slider"
                  type="range"
                  min={0.25}
                  max={primaryClip.audio.durationSec}
                  step={0.05}
                  value={trimEndSec}
                  onChange={(e) => handleTrimChange(trimStartSec, Number(e.target.value))}
                  className="w-full accent-[#7C5CFF]"
                />
              </div>

              <div className="flex items-center justify-between sm:justify-end gap-2">
                <span className="text-xs font-mono text-slate-600 dark:text-slate-300">
                  Selected: {(trimEndSec - trimStartSec).toFixed(2)}s
                </span>
                <button
                  type="button"
                  onClick={() => resetTrimForClip(primaryClip)}
                  className="rounded-lg border border-slate-300 dark:border-slate-700 px-2.5 py-1 text-xs font-medium text-slate-700 dark:text-slate-300 hover:bg-slate-200/70 dark:hover:bg-slate-800"
                >
                  Reset Trim
                </button>
              </div>
            </div>
          </div>

          <div className="grid grid-cols-1 lg:grid-cols-2 gap-5">
            <QualityReportPanel
              analysis={activeAnalysis}
              engineLabel={engineSpec.shortLabel}
              minRecommendedSec={engineSpec.minRecommendedSec}
              maxRecommendedSec={engineSpec.maxRecommendedSec}
              modeLabel={abMode === 'processed' ? 'Processed' : 'Original'}
              baselineScore={originalAnalysis?.overallScore ?? null}
            />

            <PreprocessingPanel
              options={preprocessingOpts}
              onChange={setPreprocessingOpts}
              engineMaxDurationSec={engineSpec.maxSupportedSec}
            />
          </div>
        </section>
      )}

      {/* Step 4: Authorization Gate, Profile Metadata & Voice Encoding */}
      <section className="rounded-xl border border-slate-200 dark:border-slate-800 bg-white dark:bg-[#121622] p-4 space-y-4">
        <h2 className="text-sm font-semibold text-slate-900 dark:text-slate-100">
          4. Authorize, Encode &amp; Save Voice Profile
        </h2>

        <AuthorizationGate
          confirmed={authConfirmed}
          sourceBasis={authSourceBasis}
          onConfirmedChange={setAuthConfirmed}
          onSourceBasisChange={setAuthSourceBasis}
          disabled={isEncoding}
        />

        <div className="grid grid-cols-1 md:grid-cols-3 gap-3">
          <div className="space-y-1">
            <label
              htmlFor="voice-name-input"
              className="block text-xs font-medium text-slate-700 dark:text-slate-300"
            >
              Voice Name <span className="text-rose-500">*</span>
            </label>
            <input
              id="voice-name-input"
              type="text"
              value={voiceName}
              onChange={(e) => setVoiceName(e.target.value)}
              placeholder="e.g. Studio Narrator"
              maxLength={100}
              className="w-full rounded-lg border border-slate-300 dark:border-slate-700 bg-slate-50 dark:bg-[#0B0D12] px-3 py-2 text-xs text-slate-900 dark:text-slate-100 focus:outline-none focus:ring-2 focus:ring-[#7C5CFF]"
            />
          </div>

          <div className="space-y-1">
            <label
              htmlFor="voice-language-select"
              className="block text-xs font-medium text-slate-700 dark:text-slate-300"
            >
              Primary Language
            </label>
            <select
              id="voice-language-select"
              value={resolvedVoiceLanguage}
              onChange={(e) => setVoiceLanguage(e.target.value)}
              className="w-full rounded-lg border border-slate-300 dark:border-slate-700 bg-slate-50 dark:bg-[#0B0D12] px-3 py-2 text-xs text-slate-900 dark:text-slate-100 focus:outline-none focus:ring-2 focus:ring-[#7C5CFF]"
            >
              {supportedLanguages.map((lang) => (
                <option key={lang.code} value={lang.code}>
                  {lang.name} ({lang.code})
                </option>
              ))}
            </select>
          </div>

          <div className="space-y-1">
            <label
              htmlFor="voice-tags-input"
              className="block text-xs font-medium text-slate-700 dark:text-slate-300"
            >
              Tags (comma-separated)
            </label>
            <input
              id="voice-tags-input"
              type="text"
              value={voiceTagsRaw}
              onChange={(e) => setVoiceTagsRaw(e.target.value)}
              placeholder="narration, warm, baritone"
              className="w-full rounded-lg border border-slate-300 dark:border-slate-700 bg-slate-50 dark:bg-[#0B0D12] px-3 py-2 text-xs text-slate-900 dark:text-slate-100 focus:outline-none focus:ring-2 focus:ring-[#7C5CFF]"
            />
          </div>
        </div>

        <div className="space-y-1">
          <label
            htmlFor="voice-desc-input"
            className="block text-xs font-medium text-slate-700 dark:text-slate-300"
          >
            Notes / Description (optional)
          </label>
          <input
            id="voice-desc-input"
            type="text"
            value={voiceDescription}
            onChange={(e) => setVoiceDescription(e.target.value)}
            placeholder="Microphone setup, vocal tone, or intended narration style..."
            maxLength={400}
            className="w-full rounded-lg border border-slate-300 dark:border-slate-700 bg-slate-50 dark:bg-[#0B0D12] px-3 py-2 text-xs text-slate-900 dark:text-slate-100 focus:outline-none focus:ring-2 focus:ring-[#7C5CFF]"
          />
        </div>

        {/* Engine Download / Initialization Prompt */}
        {!isEngineInitialized && (
          <div className="rounded-lg border border-sky-500/30 bg-sky-500/10 p-3.5 space-y-2.5">
            <div className="flex flex-wrap items-center justify-between gap-2">
              <div className="space-y-0.5">
                <div className="text-xs font-semibold text-sky-800 dark:text-sky-200 flex items-center gap-1.5">
                  <Download className="h-3.5 w-3.5" />
                  {isModelCached
                    ? `${engineSpec.shortLabel} is cached offline — initialize runtime to encode`
                    : `${engineSpec.shortLabel} weights (${engineSpec.sizeLabel}) are not cached yet`}
                </div>
                <p className="text-[11px] text-sky-700 dark:text-sky-300">
                  {isModelCached
                    ? 'Weights are verified in browser storage. Initialize ONNX Runtime sessions before encoding.'
                    : 'Initializing will download pinned weights once from Hugging Face (or your configured mirror) and cache them locally.'}
                </p>
              </div>

              {!isInitializingEngine ? (
                <button
                  type="button"
                  onClick={() => void handleInitializeEngine()}
                  className="inline-flex items-center gap-1.5 rounded-lg bg-sky-600 hover:bg-sky-500 px-3 py-1.5 text-xs font-semibold text-white"
                >
                  <Download className="h-3.5 w-3.5" />
                  {isModelCached ? 'Initialize Engine' : `Download & Initialize (${engineSpec.sizeLabel})`}
                </button>
              ) : (
                <button
                  type="button"
                  onClick={handleCancelInit}
                  className="inline-flex items-center gap-1.5 rounded-lg border border-rose-500/40 bg-rose-500/15 px-3 py-1.5 text-xs font-semibold text-rose-500"
                >
                  <Square className="h-3 w-3 fill-current" />
                  Cancel
                </button>
              )}
            </div>

            {isInitializingEngine && initProgress && (
              <div className="space-y-1">
                <div className="flex items-center justify-between text-[11px] text-sky-800 dark:text-sky-200">
                  <span>
                    [{initProgress.phase}] {initProgress.message}
                  </span>
                  <span className="font-mono">
                    {Math.round(initProgress.progress * 100)}%
                    {initProgress.loadedBytes && initProgress.totalBytes
                      ? ` (${formatBytes(initProgress.loadedBytes)} / ${formatBytes(initProgress.totalBytes)})`
                      : ''}
                  </span>
                </div>
                <div className="h-1.5 w-full rounded-full bg-sky-900/30 overflow-hidden">
                  <div
                    className="h-full bg-sky-500 transition-all duration-150"
                    style={{ width: `${Math.round(initProgress.progress * 100)}%` }}
                  />
                </div>
              </div>
            )}
          </div>
        )}

        {engineError && (
          <div
            role="alert"
            className="flex items-start gap-2 rounded-lg border border-rose-500/30 bg-rose-500/10 p-3 text-xs text-rose-700 dark:text-rose-200"
          >
            <AlertCircle className="h-4 w-4 shrink-0 mt-0.5 text-rose-500" />
            <span>{engineError}</span>
          </div>
        )}

        <div className="flex flex-wrap items-center justify-between gap-3 pt-1">
          <div className="text-xs text-slate-500 dark:text-slate-400">
            Encoding input:{' '}
            <span className="font-medium text-slate-800 dark:text-slate-200">
              {abMode === 'original' ? 'Original Trimmed Audio' : 'Preprocessed Audio (24 kHz mono)'}
            </span>
          </div>

          <button
            type="button"
            disabled={!canEncode}
            onClick={() => void handleEncodeAndSave()}
            className="inline-flex items-center gap-2 rounded-lg bg-[#7C5CFF] hover:bg-[#6a48f5] disabled:opacity-45 disabled:cursor-not-allowed px-5 py-2.5 text-xs font-semibold text-white transition-colors"
          >
            {isEncoding ? (
              <>
                <Loader2 className="h-4 w-4 animate-spin" />
                {encodeStageMessage ?? 'Encoding Voice Profile...'}
              </>
            ) : savedProfile && !savedHasCurrentEngine ? (
              <>
                <Sparkles className="h-4 w-4" />
                Add {engineSpec.shortLabel} Conditioning to Profile
              </>
            ) : (
              <>
                <Sparkles className="h-4 w-4" />
                Encode &amp; Save Voice Profile
              </>
            )}
          </button>
        </div>
      </section>

      {/* Step 5: Saved Confirmation & Instant Preview Synthesis */}
      {savedProfile && (
        <section className="rounded-xl border border-emerald-500/35 bg-white dark:bg-[#121622] p-4 space-y-4">
          <div className="flex flex-wrap items-center justify-between gap-3">
            <div className="flex items-center gap-2">
              <CheckCircle2 className="h-5 w-5 text-emerald-500" />
              <div>
                <h2 className="text-sm font-semibold text-slate-900 dark:text-slate-100">
                  Voice Profile Saved: {savedProfile.name}
                </h2>
                <p className="text-xs text-slate-500 dark:text-slate-400">
                  Stored locally in IndexedDB with{' '}
                  {Object.keys(savedProfile.conditioningPayloads).length} engine payload(s).
                </p>
              </div>
            </div>

            <div className="flex items-center gap-2">
              <button
                type="button"
                onClick={handleUseInStudio}
                className="inline-flex items-center gap-1.5 rounded-lg bg-[#7C5CFF] hover:bg-[#6a48f5] px-3.5 py-2 text-xs font-semibold text-white"
              >
                Use in Studio
                <ArrowRight className="h-3.5 w-3.5" />
              </button>
            </div>
          </div>

          <div className="rounded-lg border border-slate-200 dark:border-slate-800 bg-slate-50/70 dark:bg-[#0B0D12]/60 p-3.5 space-y-3">
            <div className="flex items-center justify-between gap-2">
              <div className="flex items-center gap-1.5 text-xs font-semibold text-slate-900 dark:text-slate-100">
                <Radio className="h-4 w-4 text-[#7C5CFF]" />
                Instant Speech Preview ({engineSpec.shortLabel})
              </div>
              <span className="text-[11px] text-amber-600 dark:text-amber-300 font-medium">
                Synthetic AI speech preview
              </span>
            </div>

            <div className="flex flex-wrap gap-1.5">
              {PREVIEW_SAMPLE_SENTENCES.map((sentence, idx) => (
                <button
                  key={idx}
                  type="button"
                  onClick={() => setPreviewText(sentence)}
                  className="rounded-full border border-slate-300 dark:border-slate-700 bg-white dark:bg-[#121622] px-2.5 py-1 text-[11px] text-slate-700 dark:text-slate-300 hover:border-[#7C5CFF]"
                >
                  Sample {idx + 1}
                </button>
              ))}
            </div>

            <div className="flex flex-col sm:flex-row gap-2">
              <input
                type="text"
                value={previewText}
                onChange={(e) => setPreviewText(e.target.value)}
                placeholder="Type a sentence to test your cloned voice immediately..."
                className="flex-1 rounded-lg border border-slate-300 dark:border-slate-700 bg-white dark:bg-[#121622] px-3 py-2 text-xs text-slate-900 dark:text-slate-100 focus:outline-none focus:ring-2 focus:ring-[#7C5CFF]"
              />
              {!isSynthesizingPreview ? (
                <button
                  type="button"
                  disabled={!savedHasCurrentEngine}
                  onClick={() => void handleSynthesizePreview()}
                  className="inline-flex items-center justify-center gap-1.5 rounded-lg bg-emerald-600 hover:bg-emerald-500 disabled:opacity-45 px-4 py-2 text-xs font-semibold text-white shrink-0"
                >
                  <Play className="h-3.5 w-3.5 fill-current" />
                  Synthesize Preview
                </button>
              ) : (
                <button
                  type="button"
                  onClick={handleCancelPreviewSynth}
                  className="inline-flex items-center justify-center gap-1.5 rounded-lg bg-rose-600 hover:bg-rose-500 px-4 py-2 text-xs font-semibold text-white shrink-0"
                >
                  <Square className="h-3.5 w-3.5 fill-current" />
                  Stop
                </button>
              )}
            </div>

            {previewError && (
              <div className="rounded-lg border border-rose-500/30 bg-rose-500/10 p-2.5 text-xs text-rose-700 dark:text-rose-200">
                {previewError}
              </div>
            )}

            {previewResult && (
              <div className="space-y-2 pt-1">
                <div className="flex flex-wrap items-center gap-3 text-[11px] font-mono text-slate-600 dark:text-slate-300">
                  <span className="inline-flex items-center gap-1">
                    <Volume2 className="h-3.5 w-3.5 text-emerald-500" />
                    Duration: {previewResult.audio.durationSec.toFixed(2)}s
                  </span>
                  <span>Latency: {(previewResult.generationTimeMs / 1000).toFixed(2)}s</span>
                  <span>RTF: {previewResult.realTimeFactor.toFixed(2)}x</span>
                  <span>Backend: {previewResult.backend.toUpperCase()}</span>
                </div>
                <WaveformPlayer
                  samples={previewResult.audio.samples}
                  sampleRate={previewResult.audio.sampleRate}
                  title={`Synthesized Preview — ${savedProfile.name}`}
                  compact
                />
              </div>
            )}
          </div>
        </section>
      )}
    </div>
  );
}
