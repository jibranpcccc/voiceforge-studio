import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import {
  AlertTriangle,
  AudioLines,
  BookOpen,
  CheckCircle2,
  Cpu,
  Download,
  History,
  Loader2,
  Play,
  Radio,
  RefreshCw,
  Save,
  Volume2,
  VolumeX,
} from 'lucide-react';
import {
  OrderedStreamAudioPlayer,
  masterNarrationChunks,
  type MasteringExtraOptions,
} from '../audio';
import { WaveformPlayer } from '../components/audio/WaveformPlayer';
import {
  ExportModal,
  HistoryDrawer,
  MasteringPanel,
  ParameterControls,
  PronunciationModal,
  QueueProgressBar,
  ScriptEditor,
  ensureDefaultEnginesRegistered,
  ensureEngineInitialized,
  formatDurationCompact,
  getProfileEngineIds,
  isVoiceCompatibleWithEngine,
  loadProjectAudioChunkMap,
} from '../components/studio';
import { STUDIO_PRESET_LIST, extractEngineParametersForEngine } from '../services/presets';
import {
  BUILTIN_VOICES,
  DEFAULT_BUILTIN_VOICE_ID,
  ensureBuiltinVoiceEncoded,
  getBuiltinVoiceById,
} from '../services/builtinVoices';
import {
  computeQueueState,
  narrationQueue,
  type RunQueueOptions,
} from '../services/narrationQueue';
import {
  getDefaultMaxCharsForEngine,
  segmentScript,
} from '../services/segmenter';
import {
  deleteHistoryEntry,
  getAudioChunk,
  listHistoryEntries,
  saveHistoryEntry,
  type GenerationHistoryEntry,
} from '../storage/db';
import {
  resolveEffectiveWorkerCount,
  useAppStore,
  useModelStore,
  useProjectStore,
  useStudioStore,
  useVoiceStore,
} from '../stores';
import type {
  AudioBufferData,
  EngineLoadProgress,
  NarrationProject,
  ScriptChunk,
  StudioPresetId,
  VoiceProfile,
} from '../types';

export function StudioPage() {
  const customModelBaseUrl = useAppStore((s) => s.customModelBaseUrl);
  const executionMode = useAppStore((s) => s.executionMode);
  const parallelWorkers = useAppStore((s) => s.parallelWorkers);
  const setParallelWorkers = useAppStore((s) => s.setParallelWorkers);
  const hardwareCapabilities = useAppStore((s) => s.hardwareCapabilities);

  const voices = useVoiceStore((s) => s.voices);
  const defaultVoiceId = useVoiceStore((s) => s.defaultVoiceId);
  const loadVoices = useVoiceStore((s) => s.loadVoices);

  const models = useModelStore((s) => s.models);
  const manifest = useModelStore((s) => s.manifest);
  const loadManifest = useModelStore((s) => s.loadManifest);
  const recordMeasuredRtf = useModelStore((s) => s.recordMeasuredRtf);

  const activeProject = useProjectStore((s) => s.activeProject);
  const queueState = useProjectStore((s) => s.queueState);
  const selectProject = useProjectStore((s) => s.selectProject);
  const createProject = useProjectStore((s) => s.createProject);
  const saveProjectRecord = useProjectStore((s) => s.saveProjectRecord);
  const startProjectQueue = useProjectStore((s) => s.startProjectQueue);
  const resumeProjectQueue = useProjectStore((s) => s.resumeProjectQueue);
  const pauseProjectQueue = useProjectStore((s) => s.pauseProjectQueue);
  const cancelProjectQueue = useProjectStore((s) => s.cancelProjectQueue);
  const retryFailedProjectChunks = useProjectStore((s) => s.retryFailedProjectChunks);
  const regenerateSingleChunk = useProjectStore((s) => s.regenerateSingleChunk);

  const {
    projectTitle,
    activeProjectId,
    scriptText,
    undoStack,
    redoStack,
    lastDraftSavedAt,
    selectedVoiceId,
    selectedEngineId,
    selectedPresetId,
    engineParameters,
    mastering,
    preprocessing,
    sentencePauseMs,
    paragraphPauseMs,
    chunkCrossfadeMs,
    maxChunkChars,
    pronunciationRules,
    setProjectTitle,
    setActiveProjectId,
    setScriptText,
    undo,
    redo,
    selectVoice,
    selectEngine,
    applyPreset,
    setEngineParameter,
    setMastering,
    setTiming,
    loadPronunciationRules,
    addOrUpdatePronunciationRule,
    togglePronunciationRuleById,
    deletePronunciationRuleById,
    setActiveProjectChunks,
  } = useStudioStore();

  const textareaRef = useRef<HTMLTextAreaElement | null>(null);
  const [selectedLanguage, setSelectedLanguage] = useState('en');
  const [selectedChunkIndex, setSelectedChunkIndex] = useState<number | null>(null);
  const [rawChunkMap, setRawChunkMap] = useState<Map<string, AudioBufferData>>(new Map());
  const [masteredAudio, setMasteredAudio] = useState<AudioBufferData | null>(null);
  const [playerTitle, setPlayerTitle] = useState<string>('Mastered Narration');
  const [masteringExtra, setMasteringExtra] = useState<
    Required<Pick<MasteringExtraOptions, 'speed' | 'reduceExcessiveSilence' | 'maxInternalSilenceMs'>>
  >({
    speed: 1.0,
    reduceExcessiveSilence: false,
    maxInternalSilenceMs: 600,
  });
  const [isMastering, setIsMastering] = useState(false);
  const [initProgress, setInitProgress] = useState<EngineLoadProgress | null>(null);
  const [studioError, setStudioError] = useState<string | null>(null);
  const [studioNotice, setStudioNotice] = useState<string | null>(null);
  const [regeneratingChunkId, setRegeneratingChunkId] = useState<string | null>(null);

  const [exportOpen, setExportOpen] = useState(false);
  const [pronunciationOpen, setPronunciationOpen] = useState(false);
  const [historyOpen, setHistoryOpen] = useState(false);
  const [historyEntries, setHistoryEntries] = useState<GenerationHistoryEntry[]>([]);
  const [liveStreamEnabled, setLiveStreamEnabled] = useState(true);
  const [isStreamingLive, setIsStreamingLive] = useState(false);
  const streamPlayerRef = useRef<OrderedStreamAudioPlayer | null>(null);

  const stopLiveStream = useCallback(() => {
    const player = streamPlayerRef.current;
    streamPlayerRef.current = null;
    setIsStreamingLive(false);
    if (player) {
      player.stop();
      void player.dispose();
    }
  }, []);

  useEffect(() => {
    return () => {
      const player = streamPlayerRef.current;
      streamPlayerRef.current = null;
      if (player) {
        void player.dispose();
      }
    };
  }, []);

  const registry = useMemo(
    () => ensureDefaultEnginesRegistered(customModelBaseUrl),
    [customModelBaseUrl]
  );

  const availableEngines = useMemo(() => registry.list(), [registry]);
  const activeEngine = useMemo(
    () => registry.get(selectedEngineId) ?? availableEngines[0],
    [registry, selectedEngineId, availableEngines]
  );

  const selectedVoice = useMemo(
    () => voices.find((v) => v.id === selectedVoiceId) ?? null,
    [voices, selectedVoiceId]
  );

  const selectedBuiltinVoice = useMemo(
    () => getBuiltinVoiceById(selectedVoiceId) ?? null,
    [selectedVoiceId]
  );

  const unencodedBuiltinVoices = useMemo(() => {
    const savedIds = new Set(voices.map((v) => v.id));
    return BUILTIN_VOICES.filter((b) => !savedIds.has(b.id));
  }, [voices]);

  const voiceCompatible = useMemo(() => {
    if (isVoiceCompatibleWithEngine(selectedVoice, activeEngine)) {
      return true;
    }
    return Boolean(selectedBuiltinVoice && activeEngine);
  }, [selectedVoice, selectedBuiltinVoice, activeEngine]);

  const hasSelectedVoice = Boolean(selectedVoice || selectedBuiltinVoice);

  const supportedLanguages = useMemo(
    () => activeEngine?.getSupportedLanguages() ?? [{ code: 'en', name: 'English', nativeName: 'English' }],
    [activeEngine]
  );

  const effectiveLanguage = useMemo(
    () =>
      supportedLanguages.some((l) => l.code === selectedLanguage)
        ? selectedLanguage
        : supportedLanguages[0]?.code ?? 'en',
    [supportedLanguages, selectedLanguage]
  );

  const parameterSpecs = useMemo(
    () => activeEngine?.getGenerationParameters() ?? [],
    [activeEngine]
  );

  // Initial data load
  useEffect(() => {
    void loadVoices();
    void loadPronunciationRules();
    if (!manifest) {
      void loadManifest().catch(() => undefined);
    }
    void listHistoryEntries(30).then(setHistoryEntries).catch(() => undefined);
  }, [loadVoices, loadPronunciationRules, loadManifest, manifest]);

  // Auto-select default voice (or built-in open-licensed narrator) if none chosen yet
  useEffect(() => {
    if (!selectedVoiceId) {
      selectVoice(defaultVoiceId ?? voices[0]?.id ?? DEFAULT_BUILTIN_VOICE_ID);
    }
  }, [selectedVoiceId, voices, defaultVoiceId, selectVoice]);

  const remasterFromMap = useCallback(
    (
      project: NarrationProject | null,
      chunkMap: Map<string, AudioBufferData>,
      overrideTitle?: string
    ) => {
      if (!project || chunkMap.size === 0) {
        setMasteredAudio(null);
        return;
      }
      const completedInOrder = project.chunks.filter(
        (c) => c.status === 'completed' && chunkMap.has(c.id)
      );
      if (completedInOrder.length === 0) {
        setMasteredAudio(null);
        return;
      }

      setIsMastering(true);
      try {
        const buffers = completedInOrder.map((c) => chunkMap.get(c.id)!);
        // Derive paragraph boundaries from segmenter so MasteringPanel pause sliders adjust non-destructively
        const segMeta = segmentScript(project.scriptText, {
          engineId: project.engineId,
          maxCharsPerChunk: maxChunkChars,
          sentencePauseMs,
          paragraphPauseMs,
          pronunciationRules: project.pronunciationRules,
        });
        const pauseDurationsMs = completedInOrder.slice(0, -1).map((chunk, idx) => {
          if (chunk.explicitPauseAfterMs) {
            return chunk.pauseAfterMs;
          }
          const seg = segMeta[chunk.index] ?? segMeta[idx];
          if (seg) {
            return seg.explicitPauseAfterMs
              ? seg.pauseAfterMs
              : seg.isParagraphEnd
                ? paragraphPauseMs
                : sentencePauseMs;
          }
          return chunk.pauseAfterMs ?? sentencePauseMs;
        });

        const mastered = masterNarrationChunks(
          buffers,
          {
            ...mastering,
            speed: masteringExtra.speed,
            reduceExcessiveSilence: masteringExtra.reduceExcessiveSilence,
            maxInternalSilenceMs: masteringExtra.maxInternalSilenceMs,
          },
          {
            pauseDurationMs: sentencePauseMs,
            pauseDurationsMs,
            chunkDspHints: completedInOrder.map((c) => c.dspHints),
            crossfadeMs: chunkCrossfadeMs,
          }
        );
        setMasteredAudio(mastered);
        setPlayerTitle(overrideTitle ?? `${project.name} (Mastered)`);
      } finally {
        setIsMastering(false);
      }
    },
    [
      chunkCrossfadeMs,
      mastering,
      masteringExtra,
      maxChunkChars,
      paragraphPauseMs,
      sentencePauseMs,
    ]
  );

  // Recover active project from IndexedDB when reloading #/studio directly
  useEffect(() => {
    if (!activeProjectId) return;
    if (activeProject && activeProject.id === activeProjectId) return;
    void selectProject(activeProjectId).then((loaded) => {
      if (!loaded) {
        setActiveProjectId(null);
      }
    });
  }, [activeProjectId, activeProject, selectProject, setActiveProjectId]);

  // Sync chunks & audio when activeProject changes (e.g. opened from ProjectsPage or updated by queue)
  useEffect(() => {
    if (!activeProject) return;
    setActiveProjectChunks(activeProject.chunks);
    let cancelled = false;
    void loadProjectAudioChunkMap(activeProject.id).then((map) => {
      if (cancelled) return;
      setRawChunkMap(map);
      if (map.size > 0) {
        remasterFromMap(activeProject, map);
      }
    });
    return () => {
      cancelled = true;
    };
  }, [activeProject, setActiveProjectChunks, remasterFromMap]);

  // Live segmented preview chunks
  const segmentedPreview = useMemo(
    () =>
      segmentScript(scriptText, {
        engineId: selectedEngineId,
        maxCharsPerChunk: maxChunkChars || getDefaultMaxCharsForEngine(selectedEngineId),
        sentencePauseMs,
        paragraphPauseMs,
        pronunciationRules,
      }),
    [
      scriptText,
      selectedEngineId,
      maxChunkChars,
      sentencePauseMs,
      paragraphPauseMs,
      pronunciationRules,
    ]
  );

  const usingSavedProjectChunks = Boolean(
    activeProject &&
      activeProject.id === activeProjectId &&
      activeProject.scriptText === scriptText &&
      activeProject.chunks.length > 0
  );

  const navigatorItems: Array<{
    id: string;
    index: number;
    paragraphIndex?: number;
    rawText: string;
    normalizedText: string;
    status: ScriptChunk['status'];
    audioDurationSec?: number;
    errorMessage?: string;
    directionTags?: string[];
    pauseAfterMs?: number;
    explicitPauseAfterMs?: boolean;
  }> = useMemo(() => {
    if (usingSavedProjectChunks && activeProject) {
      return activeProject.chunks.map((c) => ({
        id: c.id,
        index: c.index,
        rawText: c.rawText,
        normalizedText: c.normalizedText,
        status: c.status,
        audioDurationSec: c.audioDurationSec,
        errorMessage: c.errorMessage,
        directionTags: c.directionTags,
        pauseAfterMs: c.pauseAfterMs,
        explicitPauseAfterMs: c.explicitPauseAfterMs,
      }));
    }
    return segmentedPreview.map((seg) => ({
      id: `preview-${seg.index + 1}`,
      index: seg.index,
      paragraphIndex: seg.paragraphIndex,
      rawText: seg.text,
      normalizedText: seg.normalizedText,
      status: 'pending' as const,
      directionTags: seg.directionTags,
      pauseAfterMs: seg.pauseAfterMs,
      explicitPauseAfterMs: seg.explicitPauseAfterMs,
    }));
  }, [usingSavedProjectChunks, activeProject, segmentedPreview]);

  const effectiveQueueState = useMemo(() => {
    if (queueState.isRunning) {
      return queueState;
    }
    if (!usingSavedProjectChunks || !activeProject) {
      return computeQueueState(null, {
        isRunning: false,
        isPaused: false,
        activeChunkId: null,
      });
    }
    if (queueState.totalChunks === 0 && activeProject.chunks.length > 0) {
      return computeQueueState(activeProject, {
        isRunning: false,
        isPaused: queueState.isPaused,
        activeChunkId: null,
      });
    }
    return queueState;
  }, [queueState, usingSavedProjectChunks, activeProject]);

  const activeQueueChunkIndex = useMemo(() => {
    if (!effectiveQueueState.activeChunkId || !activeProject) return null;
    const found = activeProject.chunks.find((c) => c.id === effectiveQueueState.activeChunkId);
    return found ? found.index : null;
  }, [effectiveQueueState.activeChunkId, activeProject]);

  const jumpToChunkInEditor = (chunkText: string, index: number) => {
    setSelectedChunkIndex(index);
    const el = textareaRef.current;
    if (!el || !scriptText) return;
    const snippet = chunkText.slice(0, 48);
    const pos = scriptText.indexOf(snippet);
    if (pos >= 0) {
      el.focus();
      el.setSelectionRange(pos, pos + chunkText.length);
    }
  };

  const handleSaveProject = async (): Promise<NarrationProject> => {
    setStudioError(null);
    if (activeProject && activeProject.id === activeProjectId) {
      const updated = await createProject({
        id: activeProject.id,
        name: projectTitle,
        voiceProfileId: selectedVoiceId,
        engineId: selectedEngineId,
        executionMode,
        presetId: selectedPresetId,
        scriptText,
        pronunciationRules,
        preprocessing,
        mastering,
        sentencePauseMs,
        paragraphPauseMs,
        chunkCrossfadeMs,
        maxChunkChars,
        engineParameters: extractEngineParametersForEngine(engineParameters, selectedEngineId),
      });
      setActiveProjectId(updated.id);
      setStudioNotice('Project saved to IndexedDB.');
      return updated;
    }

    const created = await createProject({
      name: projectTitle,
      voiceProfileId: selectedVoiceId,
      engineId: selectedEngineId,
      executionMode,
      presetId: selectedPresetId,
      scriptText,
      pronunciationRules,
      preprocessing,
      mastering,
      sentencePauseMs,
      paragraphPauseMs,
      chunkCrossfadeMs,
      maxChunkChars,
      engineParameters: extractEngineParametersForEngine(engineParameters, selectedEngineId),
    });
    setActiveProjectId(created.id);
    setStudioNotice('Project created and saved locally.');
    return created;
  };

  const recordRunInHistory = async (finishedProject: NarrationProject) => {
    const map = await loadProjectAudioChunkMap(finishedProject.id);
    setRawChunkMap(map);
    const completedChunks = finishedProject.chunks.filter(
      (c) => c.status === 'completed' && map.has(c.id)
    );
    if (completedChunks.length === 0) return;

    const buffers = completedChunks.map((c) => map.get(c.id)!);
    const mastered = masterNarrationChunks(
      buffers,
      {
        ...mastering,
        speed: masteringExtra.speed,
        reduceExcessiveSilence: masteringExtra.reduceExcessiveSilence,
        maxInternalSilenceMs: masteringExtra.maxInternalSilenceMs,
      },
      {
        pauseDurationMs: sentencePauseMs,
        pauseDurationsMs: completedChunks.slice(0, -1).map((c) => c.pauseAfterMs ?? sentencePauseMs),
        crossfadeMs: chunkCrossfadeMs,
      }
    );
    setMasteredAudio(mastered);
    setPlayerTitle(`${finishedProject.name} (Mastered)`);

    const totalGenMs = completedChunks.reduce(
      (sum, c) => sum + (c.generationTimeMs ?? 0),
      0
    );
    const rtf =
      mastered.durationSec > 0 && totalGenMs > 0
        ? totalGenMs / 1000 / mastered.durationSec
        : 0;
    if (rtf > 0) {
      recordMeasuredRtf(finishedProject.engineId, rtf, totalGenMs);
    }

    const voiceName =
      voices.find((v) => v.id === finishedProject.voiceProfileId)?.name ?? 'Unknown Voice';
    const meta = activeEngine?.getModelMetadata();
    const audioBytes =
      mastered.samples.byteLength <= 48 * 1024 * 1024
        ? mastered.samples.buffer.slice(
            mastered.samples.byteOffset,
            mastered.samples.byteOffset + mastered.samples.byteLength
          )
        : undefined;

    await saveHistoryEntry({
      id: `hist-${Date.now()}-${Math.random().toString(36).slice(2, 7)}`,
      text: finishedProject.scriptText.slice(0, 500),
      voiceProfileId: finishedProject.voiceProfileId ?? '',
      voiceName,
      engineId: finishedProject.engineId,
      modelRevision: meta?.modelRevision ?? 'pinned',
      language: effectiveLanguage,
      parameters: finishedProject.engineParameters,
      sampleRate: mastered.sampleRate,
      durationSec: mastered.durationSec,
      generationTimeMs: totalGenMs,
      realTimeFactor: rtf,
      audioBytes: audioBytes as ArrayBuffer | undefined,
      createdAt: new Date().toISOString(),
    });
    const updatedHistory = await listHistoryEntries(30);
    setHistoryEntries(updatedHistory);
  };

  const executeQueueWithStreaming = async (
    project: NarrationProject,
    runner: (projectId: string, options?: RunQueueOptions) => Promise<NarrationProject>,
    voiceProfile: VoiceProfile | null
  ): Promise<NarrationProject> => {
    const pendingChunks = project.chunks.filter(
      (c) => c.status !== 'completed' && c.status !== 'failed'
    );
    const hwCores =
      hardwareCapabilities?.hardwareConcurrency ??
      (typeof navigator !== 'undefined' && typeof navigator.hardwareConcurrency === 'number'
        ? navigator.hardwareConcurrency
        : 4);
    const effectiveWorkers = resolveEffectiveWorkerCount(
      parallelWorkers,
      hwCores,
      hardwareCapabilities?.estimatedDeviceMemoryMb ?? null,
      pendingChunks.length,
      project.engineId
    );

    stopLiveStream();
    let unsubChunkComplete: (() => void) | null = null;
    let player: OrderedStreamAudioPlayer | null = null;

    if (liveStreamEnabled && pendingChunks.length > 0) {
      const startIndex = pendingChunks[0].index;
      player = new OrderedStreamAudioPlayer(undefined, startIndex);
      await player.prime();
      streamPlayerRef.current = player;
      setIsStreamingLive(true);
      unsubChunkComplete = narrationQueue.subscribeChunkComplete((projId, finishedChunk) => {
        if (projId === project.id && player) {
          player.markChunkFinished(finishedChunk.index, finishedChunk.pauseAfterMs ?? sentencePauseMs);
        }
      });
    }

    try {
      return await runner(project.id, {
        ...(voiceProfile ? { voiceProfile } : {}),
        parallelWorkers: effectiveWorkers,
        customModelBaseUrl: customModelBaseUrl || undefined,
        onStreamChunk: player
          ? (chunkIdx, _chunkId, audioChunk) => {
              player?.pushChunk(chunkIdx, audioChunk.samples, audioChunk.sampleRate);
            }
          : undefined,
      });
    } finally {
      unsubChunkComplete?.();
      setIsStreamingLive(false);
    }
  };

  const handleGenerate = async () => {
    setStudioError(null);
    setStudioNotice(null);

    if (!scriptText.trim()) {
      setStudioError('Enter or import a narration script before generating.');
      return;
    }
    if (!hasSelectedVoice) {
      setStudioError('Select a Voice Profile first (built-in or cloned in Voice Cloning).');
      return;
    }
    if (!activeEngine) {
      setStudioError('Selected synthesis engine is unavailable.');
      return;
    }
    if (!voiceCompatible) {
      setStudioError(
        `Voice '${selectedVoice?.name ?? selectedVoiceId}' does not have conditioning for '${activeEngine.name}'. Switch engine or encode it for ${activeEngine.name}.`
      );
      return;
    }

    try {
      await ensureEngineInitialized(activeEngine, executionMode, (progress) => {
        setInitProgress(progress);
      });
      setInitProgress(null);

      let effectiveVoice: VoiceProfile | null = selectedVoice;
      if (!effectiveVoice || !isVoiceCompatibleWithEngine(effectiveVoice, activeEngine)) {
        if (!selectedBuiltinVoice) {
          setStudioError(
            `Voice '${selectedVoice?.name ?? selectedVoiceId}' is not encoded for '${activeEngine.name}'.`
          );
          return;
        }
        setStudioNotice(
          `Preparing built-in voice "${selectedBuiltinVoice.name}" locally (${selectedBuiltinVoice.license})...`
        );
        effectiveVoice = await ensureBuiltinVoiceEncoded(selectedBuiltinVoice, activeEngine);
        await loadVoices();
        setStudioNotice(null);
      }

      // Reuse active project if same script & voice & engine and already has completed chunks, else create fresh project
      let project: NarrationProject;
      if (
        activeProject &&
        activeProject.id === activeProjectId &&
        activeProject.scriptText === scriptText &&
        activeProject.voiceProfileId === effectiveVoice.id &&
        activeProject.engineId === activeEngine.id
      ) {
        project = await saveProjectRecord({
          ...activeProject,
          name: projectTitle.trim() || activeProject.name,
          presetId: selectedPresetId,
          pronunciationRules,
          mastering,
          sentencePauseMs,
          paragraphPauseMs,
          chunkCrossfadeMs,
          engineParameters: extractEngineParametersForEngine(
            engineParameters,
            activeEngine.id
          ),
        });
      } else {
        project = await createProject({
          name: projectTitle,
          voiceProfileId: effectiveVoice.id,
          engineId: activeEngine.id,
          executionMode,
          presetId: selectedPresetId,
          scriptText,
          pronunciationRules,
          preprocessing,
          mastering,
          sentencePauseMs,
          paragraphPauseMs,
          chunkCrossfadeMs,
          maxChunkChars,
          engineParameters: extractEngineParametersForEngine(
            engineParameters,
            activeEngine.id
          ),
        });
        setActiveProjectId(project.id);
      }

      const finished = await executeQueueWithStreaming(
        project,
        startProjectQueue,
        effectiveVoice
      );
      await recordRunInHistory(finished);
    } catch (err) {
      stopLiveStream();
      setInitProgress(null);
      setStudioError(err instanceof Error ? err.message : String(err));
    }
  };

  const runRecoveredQueueAction = async (
    action: (
      projectId: string,
      options?: RunQueueOptions
    ) => Promise<NarrationProject>
  ) => {
    if (!activeProject) return;
    const targetEngine = registry.get(activeProject.engineId) ?? activeEngine;
    if (!targetEngine) {
      setStudioError('Selected synthesis engine is unavailable.');
      return;
    }
    const voiceToUse =
      selectedVoice ??
      voices.find((v) => v.id === activeProject.voiceProfileId) ??
      null;
    if (!voiceToUse && !activeProject.voiceProfileId) {
      setStudioError('Select a Voice Profile first (or create one in Voice Cloning).');
      return;
    }
    setStudioError(null);
    setStudioNotice(null);
    try {
      await ensureEngineInitialized(
        targetEngine,
        activeProject.executionMode ?? executionMode,
        (progress) => {
          setInitProgress(progress);
        }
      );
      setInitProgress(null);
      const finished = await executeQueueWithStreaming(activeProject, action, voiceToUse);
      await recordRunInHistory(finished);
    } catch (err) {
      stopLiveStream();
      setInitProgress(null);
      setStudioError(err instanceof Error ? err.message : String(err));
    }
  };

  const handleResumeQueue = async () => {
    await runRecoveredQueueAction(resumeProjectQueue);
  };

  const handleRetryFailed = async () => {
    await runRecoveredQueueAction(retryFailedProjectChunks);
  };

  const handleRegenerateChunk = async (chunkId: string) => {
    if (!activeProject || !hasSelectedVoice || !activeEngine || queueState.isRunning) return;
    setStudioError(null);
    setRegeneratingChunkId(chunkId);
    try {
      await ensureEngineInitialized(activeEngine, executionMode, (progress) => {
        setInitProgress(progress);
      });
      setInitProgress(null);
      let effectiveVoice = selectedVoice;
      if (!effectiveVoice || !isVoiceCompatibleWithEngine(effectiveVoice, activeEngine)) {
        if (!selectedBuiltinVoice) {
          throw new Error(`Voice '${selectedVoice?.name ?? selectedVoiceId}' is not encoded for '${activeEngine.name}'.`);
        }
        effectiveVoice = await ensureBuiltinVoiceEncoded(selectedBuiltinVoice, activeEngine);
        await loadVoices();
      }
      const updated = await regenerateSingleChunk(activeProject.id, chunkId, {
        voiceProfile: effectiveVoice,
      });
      const map = await loadProjectAudioChunkMap(updated.id);
      setRawChunkMap(map);
      remasterFromMap(updated, map);
      setStudioNotice('Paragraph regenerated and re-mastered cleanly.');
    } catch (err) {
      setInitProgress(null);
      setStudioError(err instanceof Error ? err.message : String(err));
    } finally {
      setRegeneratingChunkId(null);
    }
  };

  const handlePlaySingleChunk = async (chunk: { id: string; index: number }) => {
    if (!activeProject) return;
    let audio = rawChunkMap.get(chunk.id);
    if (!audio) {
      const rec = await getAudioChunk(activeProject.id, chunk.id);
      if (rec) {
        audio = {
          samples: new Float32Array(rec.pcmBytes.slice(0)),
          sampleRate: rec.sampleRate,
          channels: 1,
          durationSec: rec.durationSec,
        };
      }
    }
    if (audio) {
      setMasteredAudio(audio);
      setPlayerTitle(`Paragraph #${chunk.index + 1} (Raw Chunk Preview)`);
    }
  };

  const handleReplayHistory = (entry: GenerationHistoryEntry) => {
    if (!entry.audioBytes) return;
    const samples = new Float32Array(entry.audioBytes.slice(0));
    setMasteredAudio({
      samples,
      sampleRate: entry.sampleRate,
      channels: 1,
      durationSec: entry.durationSec,
    });
    setPlayerTitle(`History Replay: ${entry.voiceName} (${entry.engineId})`);
    setHistoryOpen(false);
  };

  const hasPendingWork = Boolean(
    usingSavedProjectChunks &&
      activeProject &&
      activeProject.chunks.some(
        (c) => c.status === 'pending' || c.status === 'cancelled' || c.status === 'queued'
      )
  );

  const activeModelState = models[selectedEngineId];

  return (
    <div className="space-y-4">
      {/* Compact Studio Disclosure & Cache Telemetry Strip */}
      <div className="rounded-lg border border-[var(--vf-border-subtle)] bg-[var(--vf-surface)] px-3.5 py-2 flex flex-wrap items-center justify-between gap-2 text-xs text-[var(--vf-text-muted)]">
        <div className="flex items-center gap-2">
          <Radio className="w-3.5 h-3.5 text-[var(--vf-text-subtle)] shrink-0" />
          <span>
            <strong className="font-medium text-[var(--vf-text)]">
              Synthetic Audio Disclosure:
            </strong>{' '}
            Generated audio is synthetic AI speech synthesized 100% locally in your browser.
          </span>
        </div>
        {activeModelState && (
          <span className="inline-flex items-center gap-1.5 text-[11px] font-mono tabular-nums text-[var(--vf-text-muted)]">
            <span
              className={`w-1.5 h-1.5 rounded-full ${
                activeModelState.offlineReady
                  ? 'bg-[var(--vf-success)]'
                  : 'bg-[var(--vf-warning)]'
              }`}
            />
            Model cache: {activeModelState.offlineReady ? 'Offline Ready' : activeModelState.status}
          </span>
        )}
      </div>

      {/* Top Console Toolbar */}
      <div className="flex flex-wrap items-center justify-between gap-3 rounded-lg border border-[var(--vf-border)] bg-[var(--vf-surface)] px-4 py-3">
        <div className="flex items-center gap-2.5 flex-1 min-w-[220px]">
          <input
            type="text"
            value={projectTitle}
            onChange={(e) => setProjectTitle(e.target.value)}
            aria-label="Project title"
            placeholder="Project Title"
            className="w-full max-w-sm rounded-md border border-[var(--vf-border)] bg-[var(--vf-bg)] px-3 py-1.5 text-sm font-semibold text-[var(--vf-text)] placeholder:text-[var(--vf-text-subtle)] focus:border-[var(--vf-accent)] focus:outline-none"
          />
          <button
            type="button"
            onClick={() => void handleSaveProject()}
            className="inline-flex items-center gap-1.5 px-3 py-1.5 rounded-md text-xs font-medium border border-[var(--vf-border)] bg-[var(--vf-surface-elevated)] text-[var(--vf-text)] hover:border-[var(--vf-text-subtle)] transition"
          >
            <Save className="w-3.5 h-3.5 text-[var(--vf-text-muted)]" />
            Save Project
          </button>
        </div>

        <div className="flex flex-wrap items-center gap-2">
          <button
            type="button"
            onClick={() => setPronunciationOpen(true)}
            className="inline-flex items-center gap-1.5 px-3 py-1.5 rounded-md text-xs font-medium border border-[var(--vf-border)] bg-[var(--vf-surface-elevated)] text-[var(--vf-text)] hover:border-[var(--vf-text-subtle)] tabular-nums transition"
          >
            <BookOpen className="w-3.5 h-3.5 text-[var(--vf-accent)]" />
            Pronunciation ({pronunciationRules.filter((r) => r.enabled).length})
          </button>

          <button
            type="button"
            onClick={() => setHistoryOpen(true)}
            className="inline-flex items-center gap-1.5 px-3 py-1.5 rounded-md text-xs font-medium border border-[var(--vf-border)] bg-[var(--vf-surface-elevated)] text-[var(--vf-text)] hover:border-[var(--vf-text-subtle)] tabular-nums transition"
          >
            <History className="w-3.5 h-3.5 text-[var(--vf-accent)]" />
            History ({historyEntries.length})
          </button>

          <button
            type="button"
            disabled={!masteredAudio && rawChunkMap.size === 0}
            onClick={() => setExportOpen(true)}
            className="inline-flex items-center gap-1.5 px-3.5 py-1.5 rounded-md text-xs font-semibold bg-[var(--vf-accent)] text-white hover:bg-[var(--vf-accent-hover)] disabled:opacity-40 disabled:cursor-not-allowed transition"
          >
            <Download className="w-3.5 h-3.5" />
            Export
          </button>
        </div>
      </div>

      {/* Voice, Engine, Language & Quality Preset Strip */}
      <div className="grid grid-cols-1 md:grid-cols-2 xl:grid-cols-4 gap-3">
        {/* Voice Profile */}
        <div className="rounded-lg border border-[var(--vf-border)] bg-[var(--vf-surface)] p-3 space-y-1.5">
          <label className="block text-[11px] font-semibold uppercase tracking-wider text-[var(--vf-text-muted)]">
            Voice Profile
          </label>
          <select
            value={selectedVoiceId ?? ''}
            onChange={(e) => selectVoice(e.target.value || null)}
            disabled={queueState.isRunning}
            className="w-full rounded-md border border-[var(--vf-border)] bg-[var(--vf-bg)] px-2.5 py-1.5 text-xs text-[var(--vf-text)] focus:border-[var(--vf-accent)] focus:outline-none"
          >
            {voices.length > 0 && (
              <optgroup label="My Saved &amp; Cloned Voices">
                {voices.map((voice) => {
                  const engIds = getProfileEngineIds(voice);
                  return (
                    <option key={voice.id} value={voice.id}>
                      {voice.name} ({engIds.join(', ') || 'unencoded'})
                    </option>
                  );
                })}
              </optgroup>
            )}
            {unencodedBuiltinVoices.length > 0 && (
              <optgroup label="Built-In Open-Licensed Voices (Ready to Use)">
                {unencodedBuiltinVoices.map((b) => (
                  <option key={b.id} value={b.id}>
                    {b.name} ({b.license} · Built-in)
                  </option>
                ))}
              </optgroup>
            )}
          </select>
        </div>

        {/* AI Engine */}
        <div className="rounded-lg border border-[var(--vf-border)] bg-[var(--vf-surface)] p-3 space-y-1.5">
          <label className="block text-[11px] font-semibold uppercase tracking-wider text-[var(--vf-text-muted)]">
            AI Synthesis Engine
          </label>
          <select
            value={selectedEngineId}
            onChange={(e) => selectEngine(e.target.value)}
            disabled={queueState.isRunning}
            className="w-full rounded-md border border-[var(--vf-border)] bg-[var(--vf-bg)] px-2.5 py-1.5 text-xs text-[var(--vf-text)] focus:border-[var(--vf-accent)] focus:outline-none"
          >
            {availableEngines.map((eng) => {
              const compat = selectedVoice ? isVoiceCompatibleWithEngine(selectedVoice, eng) : true;
              return (
                <option key={eng.id} value={eng.id}>
                  {eng.name}
                  {!compat ? ' (Voice not encoded for engine)' : ''}
                </option>
              );
            })}
          </select>
        </div>

        {/* Language */}
        <div className="rounded-lg border border-[var(--vf-border)] bg-[var(--vf-surface)] p-3 space-y-1.5">
          <label className="block text-[11px] font-semibold uppercase tracking-wider text-[var(--vf-text-muted)]">
            Language
          </label>
          <select
            value={effectiveLanguage}
            onChange={(e) => setSelectedLanguage(e.target.value)}
            disabled={queueState.isRunning}
            className="w-full rounded-md border border-[var(--vf-border)] bg-[var(--vf-bg)] px-2.5 py-1.5 text-xs text-[var(--vf-text)] focus:border-[var(--vf-accent)] focus:outline-none"
          >
            {supportedLanguages.map((lang) => (
              <option key={lang.code} value={lang.code}>
                {lang.name} ({lang.code})
              </option>
            ))}
          </select>
        </div>

        {/* 7 Quality Presets */}
        <div className="rounded-lg border border-[var(--vf-border)] bg-[var(--vf-surface)] p-3 space-y-1.5">
          <label className="block text-[11px] font-semibold uppercase tracking-wider text-[var(--vf-text-muted)]">
            Studio Quality Preset
          </label>
          <select
            value={selectedPresetId}
            onChange={(e) => applyPreset(e.target.value as StudioPresetId)}
            disabled={queueState.isRunning}
            className="w-full rounded-md border border-[var(--vf-border)] bg-[var(--vf-bg)] px-2.5 py-1.5 text-xs text-[var(--vf-text)] focus:border-[var(--vf-accent)] focus:outline-none"
          >
            {STUDIO_PRESET_LIST.map((preset) => (
              <option key={preset.id} value={preset.id}>
                {preset.name}
              </option>
            ))}
          </select>
        </div>
      </div>

      {/* Voice / Engine Compatibility Warning */}
      {selectedVoice && !selectedBuiltinVoice && activeEngine && !voiceCompatible && (
        <div className="rounded-lg border border-[var(--vf-warning)]/30 bg-[var(--vf-warning)]/10 px-4 py-2.5 flex flex-wrap items-center justify-between gap-2 text-xs text-[var(--vf-text)]">
          <div className="flex items-center gap-2">
            <AlertTriangle className="w-4 h-4 text-[var(--vf-warning)] shrink-0" />
            <span>
              Voice profile <strong>{selectedVoice.name}</strong> has conditioning for{' '}
              <code className="font-mono">{getProfileEngineIds(selectedVoice).join(', ') || 'none'}</code>, not{' '}
              <strong>{activeEngine.name}</strong>. Switch to a compatible engine or encode this
              voice for {activeEngine.name} in Voice Cloning.
            </span>
          </div>
          {getProfileEngineIds(selectedVoice)[0] && (
            <button
              type="button"
              onClick={() => selectEngine(getProfileEngineIds(selectedVoice)[0])}
              className="px-2.5 py-1 rounded-md bg-[var(--vf-warning)]/15 border border-[var(--vf-warning)]/30 text-[var(--vf-warning)] font-semibold hover:bg-[var(--vf-warning)]/25 transition"
            >
              Switch to {getProfileEngineIds(selectedVoice)[0]}
            </button>
          )}
        </div>
      )}

      {/* Engine Download / Init Progress */}
      {initProgress && (
        <div className="rounded-lg border border-[var(--vf-accent)]/35 bg-[var(--vf-surface)] px-4 py-3 space-y-1.5 text-xs">
          <div className="flex items-center justify-between">
            <span className="font-semibold text-[var(--vf-text)] flex items-center gap-2">
              <Loader2 className="w-3.5 h-3.5 animate-spin text-[var(--vf-accent)]" />
              Initializing {activeEngine?.name}: {initProgress.item}
            </span>
            <span className="font-mono tabular-nums text-[var(--vf-accent)]">
              {Math.round(initProgress.progress * 100)}%
            </span>
          </div>
          <div className="text-[11px] text-[var(--vf-text-muted)]">{initProgress.message}</div>
        </div>
      )}

      {studioError && (
        <div className="rounded-lg border border-[var(--vf-danger)]/30 bg-[var(--vf-danger)]/10 px-4 py-2.5 text-xs text-[var(--vf-danger)]">
          {studioError}
        </div>
      )}
      {studioNotice && (
        <div className="rounded-lg border border-[var(--vf-success)]/30 bg-[var(--vf-success)]/10 px-4 py-2.5 text-xs text-[var(--vf-success)]">
          {studioNotice}
        </div>
      )}

      {/* Main Workspace Grid: Editor + Paragraph Navigator */}
      <div className="grid grid-cols-1 lg:grid-cols-12 gap-4">
        {/* Left/Center Column */}
        <div className="lg:col-span-8 space-y-4">
          <ScriptEditor
            scriptText={scriptText}
            onChange={(text) => setScriptText(text)}
            canUndo={undoStack.length > 0}
            canRedo={redoStack.length > 0}
            onUndo={undo}
            onRedo={redo}
            lastDraftSavedAt={lastDraftSavedAt}
            textareaRef={textareaRef}
            disabled={queueState.isRunning}
            onClear={() => setScriptText('')}
          />

          {/* Primary Generate Action & Queue Progress */}
          <div className="flex flex-wrap items-center justify-between gap-3">
            <div className="flex flex-wrap items-center gap-2">
              <button
                type="button"
                disabled={
                  queueState.isRunning ||
                  !scriptText.trim() ||
                  !hasSelectedVoice ||
                  !voiceCompatible
                }
                onClick={() => void handleGenerate()}
                className="inline-flex items-center gap-2 px-5 py-2.5 rounded-md text-sm font-semibold bg-[var(--vf-accent)] text-white hover:bg-[var(--vf-accent-hover)] disabled:opacity-40 disabled:cursor-not-allowed transition"
              >
                {queueState.isRunning ? (
                  <Loader2 className="w-4 h-4 animate-spin" />
                ) : (
                  <AudioLines className="w-4 h-4" />
                )}
                {queueState.isRunning ? 'Synthesizing Narration...' : 'Generate Narration'}
              </button>

              <button
                type="button"
                onClick={() => {
                  if (isStreamingLive) {
                    stopLiveStream();
                    setLiveStreamEnabled(false);
                  } else {
                    setLiveStreamEnabled((prev) => !prev);
                  }
                }}
                title="Stream audio chunks live as they generate (~0.6s start latency)"
                className={`inline-flex items-center gap-1.5 px-3 py-2 rounded-md text-xs font-medium border transition ${
                  liveStreamEnabled
                    ? 'border-[var(--vf-accent)]/40 bg-[var(--vf-accent)]/12 text-[var(--vf-accent)]'
                    : 'border-[var(--vf-border)] bg-[var(--vf-surface)] text-[var(--vf-text-muted)] hover:text-[var(--vf-text)]'
                }`}
              >
                {liveStreamEnabled ? (
                  <Volume2 className="w-3.5 h-3.5" />
                ) : (
                  <VolumeX className="w-3.5 h-3.5" />
                )}
                <span>
                  {isStreamingLive
                    ? 'Streaming Live (Mute)'
                    : liveStreamEnabled
                      ? 'Live Stream: ON'
                      : 'Live Stream: OFF'}
                </span>
              </button>

              {selectedEngineId === 'pocket-tts' && (
                <label className="inline-flex items-center gap-1.5 rounded-md border border-[var(--vf-border)] bg-[var(--vf-surface)] px-2.5 py-2 text-xs text-[var(--vf-text-muted)]">
                  <Cpu className="w-3.5 h-3.5 text-[var(--vf-accent)]" />
                  <span>Workers:</span>
                  <select
                    aria-label="Parallel synthesis workers"
                    value={parallelWorkers}
                    disabled={queueState.isRunning}
                    onChange={(e) => setParallelWorkers(Number(e.target.value))}
                    className="bg-transparent font-mono tabular-nums text-xs text-[var(--vf-text)] focus:outline-none"
                  >
                    <option value={0}>Auto</option>
                    <option value={1}>1</option>
                    <option value={2}>2</option>
                    <option value={3}>3</option>
                    <option value={4}>4</option>
                  </select>
                </label>
              )}
            </div>

            <span className="text-xs text-[var(--vf-text-muted)] tabular-nums">
              {navigatorItems.length} synthesis segment{navigatorItems.length === 1 ? '' : 's'} ·
              100% local IndexedDB queue
            </span>
          </div>

          <QueueProgressBar
            queueState={effectiveQueueState}
            activeChunkIndex={activeQueueChunkIndex}
            onPause={pauseProjectQueue}
            onResume={() => void handleResumeQueue()}
            onCancel={() => {
              stopLiveStream();
              void cancelProjectQueue();
            }}
            onRetryFailed={() => void handleRetryFailed()}
            hasPendingWork={hasPendingWork}
          />

          {/* Audio Playback Deck */}
          <div className="rounded-lg border border-[var(--vf-border)] bg-[var(--vf-surface)] p-4 space-y-2.5">
            <div className="flex items-center justify-between text-xs text-[var(--vf-text-muted)]">
              <span className="font-semibold text-[var(--vf-text)]">
                Audio Playback
              </span>
              {masteredAudio && (
                <span className="font-mono tabular-nums">
                  {masteredAudio.sampleRate} Hz · {formatDurationCompact(masteredAudio.durationSec)}
                </span>
              )}
            </div>
            <WaveformPlayer
              samples={masteredAudio?.samples ?? null}
              sampleRate={masteredAudio?.sampleRate ?? 24000}
              title={playerTitle}
              height={96}
              downloadFilename={projectTitle || 'voiceforge-narration'}
              onOpenExportModal={() => setExportOpen(true)}
            />
          </div>

          {/* Dynamic Engine Parameters */}
          {activeEngine && (
            <ParameterControls
              engineName={activeEngine.name}
              specs={parameterSpecs}
              values={engineParameters}
              onChange={(key, value) => setEngineParameter(key, value)}
              onResetDefaults={() => applyPreset(selectedPresetId)}
              disabled={queueState.isRunning}
            />
          )}

          {/* Non-Destructive Mastering Panel */}
          <MasteringPanel
            settings={mastering}
            extra={masteringExtra}
            sentencePauseMs={sentencePauseMs}
            paragraphPauseMs={paragraphPauseMs}
            chunkCrossfadeMs={chunkCrossfadeMs}
            hasAudio={rawChunkMap.size > 0}
            isMastering={isMastering}
            onChangeSettings={(partial) => setMastering(partial)}
            onChangeExtra={(partial) =>
              setMasteringExtra((prev) => ({ ...prev, ...partial }))
            }
            onChangeTiming={(partial) => setTiming(partial)}
            onRemaster={() => remasterFromMap(activeProject, rawChunkMap)}
          />
        </div>

        {/* Right Sidebar: Paragraph / Chunk Navigator */}
        <aside className="lg:col-span-4 rounded-lg border border-[var(--vf-border)] bg-[var(--vf-surface)] flex flex-col max-h-[820px]">
          <div className="px-4 py-3 border-b border-[var(--vf-border-subtle)] flex items-center justify-between">
            <div>
              <h3 className="text-sm font-semibold text-[var(--vf-text)]">
                Paragraph Navigator
              </h3>
              <p className="text-[11px] text-[var(--vf-text-muted)]">
                Click to jump · Play or regenerate any chunk
              </p>
            </div>
            <span className="text-xs font-mono tabular-nums px-2 py-0.5 rounded-md bg-[var(--vf-surface-muted)] text-[var(--vf-text-muted)]">
              {navigatorItems.length}
            </span>
          </div>

          <div className="flex-1 overflow-y-auto p-3 space-y-2.5">
            {navigatorItems.length === 0 ? (
              <div className="rounded-lg border border-dashed border-[var(--vf-border)] p-6 text-center text-xs text-[var(--vf-text-muted)]">
                Type or import a script to preview segmented paragraphs and chunks.
              </div>
            ) : (
              navigatorItems.map((item) => {
                const isSelected = selectedChunkIndex === item.index;
                const isCompleted = item.status === 'completed';
                const isGenerating =
                  item.status === 'synthesizing' || regeneratingChunkId === item.id;
                const isFailed = item.status === 'failed';

                return (
                  <div
                    key={item.id}
                    className={`rounded-lg border p-3 transition cursor-pointer ${
                      isSelected
                        ? 'border-[var(--vf-accent)] bg-[var(--vf-accent)]/10'
                        : 'border-[var(--vf-border)] bg-[var(--vf-bg)] hover:border-[var(--vf-text-subtle)]'
                    }`}
                    onClick={() => jumpToChunkInEditor(item.rawText, item.index)}
                  >
                    <div className="flex items-center justify-between gap-2 mb-1.5">
                      <span className="text-[11px] font-mono tabular-nums font-semibold text-[var(--vf-text)]">
                        Chunk #{item.index + 1}
                        {item.audioDurationSec !== undefined
                          ? ` · ${item.audioDurationSec.toFixed(1)}s`
                          : ''}
                        {item.explicitPauseAfterMs && item.pauseAfterMs
                          ? ` · ${item.pauseAfterMs}ms pause`
                          : ''}
                      </span>
                      <span
                        className={`inline-flex items-center gap-1 px-2 py-0.5 rounded-sm text-[10px] font-mono font-semibold uppercase ${
                          isCompleted
                            ? 'bg-[var(--vf-success)]/15 text-[var(--vf-success)]'
                            : isGenerating
                              ? 'bg-[var(--vf-accent)]/15 text-[var(--vf-accent)]'
                              : isFailed
                                ? 'bg-[var(--vf-danger)]/15 text-[var(--vf-danger)]'
                                : 'bg-[var(--vf-surface-muted)] text-[var(--vf-text-muted)]'
                        }`}
                      >
                        {isGenerating && <Loader2 className="w-2.5 h-2.5 animate-spin" />}
                        {isCompleted && <CheckCircle2 className="w-2.5 h-2.5" />}
                        {item.status === 'synthesizing' ? 'generating' : item.status}
                      </span>
                    </div>

                    {item.directionTags && item.directionTags.length > 0 && (
                      <div className="flex flex-wrap gap-1 mb-1.5">
                        {item.directionTags.map((tag) => (
                          <span
                            key={tag}
                            className="inline-flex items-center rounded-sm border border-[var(--vf-accent)]/35 bg-[var(--vf-accent-soft)] px-1.5 py-0.5 text-[10px] font-mono text-[var(--vf-accent)]"
                          >
                            [{tag}]
                          </span>
                        ))}
                      </div>
                    )}

                    <p className="text-xs text-[var(--vf-text-muted)] line-clamp-3">
                      {item.rawText}
                    </p>

                    {item.errorMessage && (
                      <p className="text-[11px] text-[var(--vf-danger)] mt-1">
                        {item.errorMessage}
                      </p>
                    )}

                    {usingSavedProjectChunks && (
                      <div
                        className="flex items-center gap-2 mt-2 pt-2 border-t border-[var(--vf-border-subtle)]"
                        onClick={(e) => e.stopPropagation()}
                      >
                        {isCompleted && (
                          <button
                            type="button"
                            onClick={() => void handlePlaySingleChunk(item)}
                            className="inline-flex items-center gap-1 px-2 py-1 rounded-md text-[11px] font-medium bg-[var(--vf-success)]/12 text-[var(--vf-success)] hover:bg-[var(--vf-success)]/20 transition"
                          >
                            <Play className="w-3 h-3" />
                            Play
                          </button>
                        )}
                        <button
                          type="button"
                          disabled={queueState.isRunning || !voiceCompatible}
                          onClick={() => void handleRegenerateChunk(item.id)}
                          className="inline-flex items-center gap-1 px-2 py-1 rounded-md text-[11px] font-medium bg-[var(--vf-accent)]/15 text-[var(--vf-accent)] hover:bg-[var(--vf-accent)]/25 disabled:opacity-40 transition"
                        >
                          <RefreshCw
                            className={`w-3 h-3 ${
                              regeneratingChunkId === item.id ? 'animate-spin' : ''
                            }`}
                          />
                          Regenerate
                        </button>
                      </div>
                    )}
                  </div>
                );
              })
            )}
          </div>

          {masteredAudio && rawChunkMap.size > 0 && (
            <div className="p-3 border-t border-[var(--vf-border-subtle)]">
              <button
                type="button"
                onClick={() => remasterFromMap(activeProject, rawChunkMap)}
                className="w-full inline-flex items-center justify-center gap-1.5 px-3 py-1.5 rounded-md text-xs font-medium border border-[var(--vf-border)] bg-[var(--vf-surface-elevated)] text-[var(--vf-text)] hover:border-[var(--vf-text-subtle)] transition"
              >
                <AudioLines className="w-3.5 h-3.5 text-[var(--vf-accent)]" />
                Play Full Mastered Timeline
              </button>
            </div>
          )}
        </aside>
      </div>

      {/* Modals & Drawers */}
      <ExportModal
        open={exportOpen}
        onClose={() => setExportOpen(false)}
        projectTitle={projectTitle}
        project={activeProject}
        masteredAudio={masteredAudio}
        rawChunkMap={rawChunkMap}
        chunks={activeProject?.chunks ?? []}
        mastering={mastering}
        sentencePauseMs={sentencePauseMs}
        paragraphPauseMs={paragraphPauseMs}
      />

      <PronunciationModal
        open={pronunciationOpen}
        onClose={() => setPronunciationOpen(false)}
        rules={pronunciationRules}
        onSaveRule={addOrUpdatePronunciationRule}
        onToggleRule={togglePronunciationRuleById}
        onDeleteRule={deletePronunciationRuleById}
      />

      <HistoryDrawer
        open={historyOpen}
        onClose={() => setHistoryOpen(false)}
        entries={historyEntries}
        onReplay={handleReplayHistory}
        onDelete={(id) => {
          void deleteHistoryEntry(id).then(() =>
            setHistoryEntries((prev) => prev.filter((item) => item.id !== id))
          );
        }}
      />
    </div>
  );
}
