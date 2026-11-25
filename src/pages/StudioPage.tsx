import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import {
  AlertTriangle,
  BookOpen,
  CheckCircle2,
  Download,
  History,
  Loader2,
  Play,
  RefreshCw,
  Save,
  ShieldAlert,
  Sparkles,
  Wand2,
} from 'lucide-react';
import {
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
} from '../types';

export function StudioPage() {
  const customModelBaseUrl = useAppStore((s) => s.customModelBaseUrl);
  const executionMode = useAppStore((s) => s.executionMode);

  const voices = useVoiceStore((s) => s.voices);
  const defaultVoiceId = useVoiceStore((s) => s.defaultVoiceId);
  const loadVoices = useVoiceStore((s) => s.loadVoices);

  const models = useModelStore((s) => s.models);
  const manifest = useModelStore((s) => s.manifest);
  const loadManifest = useModelStore((s) => s.loadManifest);
  const recordMeasuredRtf = useModelStore((s) => s.recordMeasuredRtf);

  const activeProject = useProjectStore((s) => s.activeProject);
  const queueState = useProjectStore((s) => s.queueState);
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

  const voiceCompatible = useMemo(
    () => isVoiceCompatibleWithEngine(selectedVoice, activeEngine),
    [selectedVoice, activeEngine]
  );

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

  // Auto-select default voice if none chosen yet
  useEffect(() => {
    if (!selectedVoiceId && voices.length > 0) {
      selectVoice(defaultVoiceId ?? voices[0].id);
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
          const seg = segMeta[chunk.index] ?? segMeta[idx];
          if (seg) {
            return seg.isParagraphEnd ? paragraphPauseMs : sentencePauseMs;
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
      }));
    }
    return segmentedPreview.map((seg) => ({
      id: `preview-${seg.index + 1}`,
      index: seg.index,
      paragraphIndex: seg.paragraphIndex,
      rawText: seg.text,
      normalizedText: seg.normalizedText,
      status: 'pending' as const,
    }));
  }, [usingSavedProjectChunks, activeProject, segmentedPreview]);

  const activeQueueChunkIndex = useMemo(() => {
    if (!queueState.activeChunkId || !activeProject) return null;
    const found = activeProject.chunks.find((c) => c.id === queueState.activeChunkId);
    return found ? found.index : null;
  }, [queueState.activeChunkId, activeProject]);

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

  const handleGenerate = async () => {
    setStudioError(null);
    setStudioNotice(null);

    if (!scriptText.trim()) {
      setStudioError('Enter or import a narration script before generating.');
      return;
    }
    if (!selectedVoice) {
      setStudioError('Select a Voice Profile first (or create one in Voice Cloning).');
      return;
    }
    if (!activeEngine) {
      setStudioError('Selected synthesis engine is unavailable.');
      return;
    }
    if (!voiceCompatible) {
      setStudioError(
        `Voice '${selectedVoice.name}' does not have conditioning for '${activeEngine.name}'. Switch engine or encode it for ${activeEngine.name}.`
      );
      return;
    }

    try {
      await ensureEngineInitialized(activeEngine, executionMode, (progress) => {
        setInitProgress(progress);
      });
      setInitProgress(null);

      // Reuse active project if same script & voice & engine and already has completed chunks, else create fresh project
      let project: NarrationProject;
      if (
        activeProject &&
        activeProject.id === activeProjectId &&
        activeProject.scriptText === scriptText &&
        activeProject.voiceProfileId === selectedVoice.id &&
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
          voiceProfileId: selectedVoice.id,
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

      const finished = await startProjectQueue(project.id, { voiceProfile: selectedVoice });
      await recordRunInHistory(finished);
    } catch (err) {
      setInitProgress(null);
      setStudioError(err instanceof Error ? err.message : String(err));
    }
  };

  const handleResumeQueue = async () => {
    if (!activeProject || !selectedVoice || !activeEngine) return;
    setStudioError(null);
    try {
      await ensureEngineInitialized(activeEngine, executionMode, (progress) => {
        setInitProgress(progress);
      });
      setInitProgress(null);
      const finished = await resumeProjectQueue(activeProject.id, {
        voiceProfile: selectedVoice,
      });
      await recordRunInHistory(finished);
    } catch (err) {
      setInitProgress(null);
      setStudioError(err instanceof Error ? err.message : String(err));
    }
  };

  const handleRetryFailed = async () => {
    if (!activeProject || !selectedVoice || !activeEngine) return;
    setStudioError(null);
    try {
      await ensureEngineInitialized(activeEngine, executionMode, (progress) => {
        setInitProgress(progress);
      });
      setInitProgress(null);
      const finished = await retryFailedProjectChunks(activeProject.id, {
        voiceProfile: selectedVoice,
      });
      await recordRunInHistory(finished);
    } catch (err) {
      setInitProgress(null);
      setStudioError(err instanceof Error ? err.message : String(err));
    }
  };

  const handleRegenerateChunk = async (chunkId: string) => {
    if (!activeProject || !selectedVoice || !activeEngine || queueState.isRunning) return;
    setStudioError(null);
    setRegeneratingChunkId(chunkId);
    try {
      await ensureEngineInitialized(activeEngine, executionMode, (progress) => {
        setInitProgress(progress);
      });
      setInitProgress(null);
      const updated = await regenerateSingleChunk(activeProject.id, chunkId, {
        voiceProfile: selectedVoice,
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
    activeProject &&
      activeProject.chunks.some(
        (c) => c.status === 'pending' || c.status === 'cancelled' || c.status === 'queued'
      )
  );

  const activeModelState = models[selectedEngineId];

  return (
    <div className="space-y-5">
      {/* Persistent Synthetic Speech Disclosure Banner */}
      <div className="rounded-xl border border-[#7C5CFF]/30 bg-[#7C5CFF]/10 px-4 py-2.5 flex flex-wrap items-center justify-between gap-2 text-xs text-slate-800 dark:text-slate-200">
        <div className="flex items-center gap-2">
          <ShieldAlert className="w-4 h-4 text-[#7C5CFF] shrink-0" />
          <span>
            <strong>Synthetic Audio Disclosure:</strong> Generated audio is synthetic AI speech
            synthesized 100% locally in your browser.
          </span>
        </div>
        {activeModelState && (
          <span className="text-[11px] font-mono text-slate-600 dark:text-slate-400">
            Model cache: {activeModelState.offlineReady ? 'Offline Ready' : activeModelState.status}
          </span>
        )}
      </div>

      {/* Top Workspace Header */}
      <div className="flex flex-wrap items-center justify-between gap-3 rounded-xl border border-slate-200 dark:border-slate-800 bg-white dark:bg-[#121622] px-4 py-3">
        <div className="flex items-center gap-3 flex-1 min-w-[220px]">
          <input
            type="text"
            value={projectTitle}
            onChange={(e) => setProjectTitle(e.target.value)}
            aria-label="Project title"
            placeholder="Project Title"
            className="w-full max-w-sm rounded-lg border border-slate-200 dark:border-slate-700 bg-slate-50 dark:bg-[#0B0D12] px-3 py-1.5 text-sm font-semibold text-slate-900 dark:text-slate-100 focus:border-[#7C5CFF] focus:outline-none"
          />
          <button
            type="button"
            onClick={() => void handleSaveProject()}
            className="inline-flex items-center gap-1.5 px-3 py-1.5 rounded-lg text-xs font-medium border border-slate-200 dark:border-slate-700 text-slate-700 dark:text-slate-200 hover:bg-slate-100 dark:hover:bg-slate-800 transition"
          >
            <Save className="w-3.5 h-3.5" />
            Save Project
          </button>
        </div>

        <div className="flex flex-wrap items-center gap-2">
          <button
            type="button"
            onClick={() => setPronunciationOpen(true)}
            className="inline-flex items-center gap-1.5 px-3 py-1.5 rounded-lg text-xs font-medium border border-slate-200 dark:border-slate-700 text-slate-700 dark:text-slate-200 hover:bg-slate-100 dark:hover:bg-slate-800 transition"
          >
            <BookOpen className="w-3.5 h-3.5 text-[#7C5CFF]" />
            Pronunciation ({pronunciationRules.filter((r) => r.enabled).length})
          </button>

          <button
            type="button"
            onClick={() => setHistoryOpen(true)}
            className="inline-flex items-center gap-1.5 px-3 py-1.5 rounded-lg text-xs font-medium border border-slate-200 dark:border-slate-700 text-slate-700 dark:text-slate-200 hover:bg-slate-100 dark:hover:bg-slate-800 transition"
          >
            <History className="w-3.5 h-3.5 text-[#7C5CFF]" />
            History ({historyEntries.length})
          </button>

          <button
            type="button"
            disabled={!masteredAudio && rawChunkMap.size === 0}
            onClick={() => setExportOpen(true)}
            className="inline-flex items-center gap-1.5 px-3.5 py-1.5 rounded-lg text-xs font-semibold bg-[#7C5CFF] text-white hover:bg-[#6A48F5] disabled:opacity-40 disabled:cursor-not-allowed transition"
          >
            <Download className="w-3.5 h-3.5" />
            Export
          </button>
        </div>
      </div>

      {/* Voice, Engine, Language & Quality Preset Selectors */}
      <div className="grid grid-cols-1 md:grid-cols-2 xl:grid-cols-4 gap-3">
        {/* Voice Profile */}
        <div className="rounded-xl border border-slate-200 dark:border-slate-800 bg-white dark:bg-[#121622] p-3 space-y-1.5">
          <label className="block text-[11px] font-semibold uppercase tracking-wider text-slate-500 dark:text-slate-400">
            Voice Profile
          </label>
          <select
            value={selectedVoiceId ?? ''}
            onChange={(e) => selectVoice(e.target.value || null)}
            disabled={queueState.isRunning}
            className="w-full rounded-lg border border-slate-200 dark:border-slate-700 bg-slate-50 dark:bg-[#0B0D12] px-2.5 py-2 text-xs text-slate-900 dark:text-slate-100 focus:border-[#7C5CFF] focus:outline-none"
          >
            {voices.length === 0 ? (
              <option value="">No saved voices (create in Voice Cloning)</option>
            ) : (
              voices.map((voice) => {
                const engIds = getProfileEngineIds(voice);
                return (
                  <option key={voice.id} value={voice.id}>
                    {voice.name} ({engIds.join(', ') || 'unencoded'})
                  </option>
                );
              })
            )}
          </select>
        </div>

        {/* AI Engine */}
        <div className="rounded-xl border border-slate-200 dark:border-slate-800 bg-white dark:bg-[#121622] p-3 space-y-1.5">
          <label className="block text-[11px] font-semibold uppercase tracking-wider text-slate-500 dark:text-slate-400">
            AI Synthesis Engine
          </label>
          <select
            value={selectedEngineId}
            onChange={(e) => selectEngine(e.target.value)}
            disabled={queueState.isRunning}
            className="w-full rounded-lg border border-slate-200 dark:border-slate-700 bg-slate-50 dark:bg-[#0B0D12] px-2.5 py-2 text-xs text-slate-900 dark:text-slate-100 focus:border-[#7C5CFF] focus:outline-none"
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
        <div className="rounded-xl border border-slate-200 dark:border-slate-800 bg-white dark:bg-[#121622] p-3 space-y-1.5">
          <label className="block text-[11px] font-semibold uppercase tracking-wider text-slate-500 dark:text-slate-400">
            Language
          </label>
          <select
            value={effectiveLanguage}
            onChange={(e) => setSelectedLanguage(e.target.value)}
            disabled={queueState.isRunning}
            className="w-full rounded-lg border border-slate-200 dark:border-slate-700 bg-slate-50 dark:bg-[#0B0D12] px-2.5 py-2 text-xs text-slate-900 dark:text-slate-100 focus:border-[#7C5CFF] focus:outline-none"
          >
            {supportedLanguages.map((lang) => (
              <option key={lang.code} value={lang.code}>
                {lang.name} ({lang.code})
              </option>
            ))}
          </select>
        </div>

        {/* 7 Quality Presets */}
        <div className="rounded-xl border border-slate-200 dark:border-slate-800 bg-white dark:bg-[#121622] p-3 space-y-1.5">
          <label className="block text-[11px] font-semibold uppercase tracking-wider text-slate-500 dark:text-slate-400">
            Studio Quality Preset
          </label>
          <select
            value={selectedPresetId}
            onChange={(e) => applyPreset(e.target.value as StudioPresetId)}
            disabled={queueState.isRunning}
            className="w-full rounded-lg border border-slate-200 dark:border-slate-700 bg-slate-50 dark:bg-[#0B0D12] px-2.5 py-2 text-xs text-slate-900 dark:text-slate-100 focus:border-[#7C5CFF] focus:outline-none"
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
      {selectedVoice && activeEngine && !voiceCompatible && (
        <div className="rounded-xl border border-amber-500/30 bg-amber-500/10 px-4 py-3 flex flex-wrap items-center justify-between gap-2 text-xs text-amber-800 dark:text-amber-200">
          <div className="flex items-center gap-2">
            <AlertTriangle className="w-4 h-4 text-amber-500 shrink-0" />
            <span>
              Voice profile <strong>{selectedVoice.name}</strong> has conditioning for{' '}
              <code>{getProfileEngineIds(selectedVoice).join(', ') || 'none'}</code>, not{' '}
              <strong>{activeEngine.name}</strong>. Switch to a compatible engine or encode this
              voice for {activeEngine.name} in Voice Cloning.
            </span>
          </div>
          {getProfileEngineIds(selectedVoice)[0] && (
            <button
              type="button"
              onClick={() => selectEngine(getProfileEngineIds(selectedVoice)[0])}
              className="px-2.5 py-1 rounded-lg bg-amber-500/20 border border-amber-500/30 font-semibold hover:bg-amber-500/30 transition"
            >
              Switch to {getProfileEngineIds(selectedVoice)[0]}
            </button>
          )}
        </div>
      )}

      {/* Engine Download / Init Progress */}
      {initProgress && (
        <div className="rounded-xl border border-[#7C5CFF]/30 bg-[#7C5CFF]/10 px-4 py-3 space-y-1.5 text-xs">
          <div className="flex items-center justify-between">
            <span className="font-semibold text-slate-900 dark:text-slate-100 flex items-center gap-2">
              <Loader2 className="w-3.5 h-3.5 animate-spin text-[#7C5CFF]" />
              Initializing {activeEngine?.name}: {initProgress.item}
            </span>
            <span className="font-mono text-[#7C5CFF]">
              {Math.round(initProgress.progress * 100)}%
            </span>
          </div>
          <div className="text-[11px] text-slate-600 dark:text-slate-300">{initProgress.message}</div>
        </div>
      )}

      {studioError && (
        <div className="rounded-xl border border-rose-500/30 bg-rose-500/10 px-4 py-2.5 text-xs text-rose-700 dark:text-rose-300">
          {studioError}
        </div>
      )}
      {studioNotice && (
        <div className="rounded-xl border border-emerald-500/30 bg-emerald-500/10 px-4 py-2.5 text-xs text-emerald-700 dark:text-emerald-300">
          {studioNotice}
        </div>
      )}

      {/* Main Workspace Grid: Editor + Paragraph Navigator */}
      <div className="grid grid-cols-1 lg:grid-cols-12 gap-5">
        {/* Left/Center Column */}
        <div className="lg:col-span-8 space-y-5">
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
            <button
              type="button"
              disabled={
                queueState.isRunning ||
                !scriptText.trim() ||
                !selectedVoice ||
                !voiceCompatible
              }
              onClick={() => void handleGenerate()}
              className="inline-flex items-center gap-2 px-5 py-2.5 rounded-xl text-sm font-semibold bg-[#7C5CFF] text-white hover:bg-[#6A48F5] disabled:opacity-40 disabled:cursor-not-allowed shadow-lg shadow-[#7C5CFF]/20 transition"
            >
              {queueState.isRunning ? (
                <Loader2 className="w-4 h-4 animate-spin" />
              ) : (
                <Wand2 className="w-4 h-4" />
              )}
              {queueState.isRunning ? 'Synthesizing Narration...' : 'Generate Narration'}
            </button>

            <span className="text-xs text-slate-500 dark:text-slate-400">
              {navigatorItems.length} synthesis segment{navigatorItems.length === 1 ? '' : 's'} ·
              100% local IndexedDB queue
            </span>
          </div>

          <QueueProgressBar
            queueState={queueState}
            activeChunkIndex={activeQueueChunkIndex}
            onPause={pauseProjectQueue}
            onResume={() => void handleResumeQueue()}
            onCancel={() => void cancelProjectQueue()}
            onRetryFailed={() => void handleRetryFailed()}
            hasPendingWork={hasPendingWork}
          />

          {/* Waveform Player */}
          <div className="rounded-xl border border-slate-200 dark:border-slate-800 bg-white dark:bg-[#121622] p-4 space-y-2">
            <div className="flex items-center justify-between text-xs text-slate-500 dark:text-slate-400">
              <span className="font-semibold text-slate-800 dark:text-slate-200">
                Audio Playback
              </span>
              {masteredAudio && (
                <span className="font-mono">
                  {masteredAudio.sampleRate} Hz · {formatDurationCompact(masteredAudio.durationSec)}
                </span>
              )}
            </div>
            <WaveformPlayer
              samples={masteredAudio?.samples ?? null}
              sampleRate={masteredAudio?.sampleRate ?? 24000}
              title={playerTitle}
              height={96}
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
        <aside className="lg:col-span-4 rounded-xl border border-slate-200 dark:border-slate-800 bg-white dark:bg-[#121622] flex flex-col max-h-[820px]">
          <div className="px-4 py-3 border-b border-slate-200 dark:border-slate-800 flex items-center justify-between">
            <div>
              <h3 className="text-sm font-semibold text-slate-900 dark:text-slate-100">
                Paragraph Navigator
              </h3>
              <p className="text-[11px] text-slate-500 dark:text-slate-400">
                Click to jump · Play or regenerate any chunk
              </p>
            </div>
            <span className="text-xs font-mono px-2 py-0.5 rounded-full bg-slate-100 dark:bg-slate-800 text-slate-600 dark:text-slate-300">
              {navigatorItems.length}
            </span>
          </div>

          <div className="flex-1 overflow-y-auto p-3 space-y-2.5">
            {navigatorItems.length === 0 ? (
              <div className="rounded-lg border border-dashed border-slate-300 dark:border-slate-700 p-6 text-center text-xs text-slate-500 dark:text-slate-400">
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
                        ? 'border-[#7C5CFF] bg-[#7C5CFF]/10'
                        : 'border-slate-200 dark:border-slate-800 bg-slate-50 dark:bg-[#0B0D12]/60 hover:border-slate-300 dark:hover:border-slate-700'
                    }`}
                    onClick={() => jumpToChunkInEditor(item.rawText, item.index)}
                  >
                    <div className="flex items-center justify-between gap-2 mb-1.5">
                      <span className="text-[11px] font-mono font-semibold text-slate-700 dark:text-slate-300">
                        Chunk #{item.index + 1}
                        {item.audioDurationSec !== undefined
                          ? ` · ${item.audioDurationSec.toFixed(1)}s`
                          : ''}
                      </span>
                      <span
                        className={`inline-flex items-center gap-1 px-2 py-0.5 rounded-full text-[10px] font-semibold uppercase ${
                          isCompleted
                            ? 'bg-emerald-500/15 text-emerald-500'
                            : isGenerating
                              ? 'bg-[#7C5CFF]/20 text-[#7C5CFF]'
                              : isFailed
                                ? 'bg-rose-500/15 text-rose-500'
                                : 'bg-slate-200 dark:bg-slate-800 text-slate-500 dark:text-slate-400'
                        }`}
                      >
                        {isGenerating && <Loader2 className="w-2.5 h-2.5 animate-spin" />}
                        {isCompleted && <CheckCircle2 className="w-2.5 h-2.5" />}
                        {item.status === 'synthesizing' ? 'generating' : item.status}
                      </span>
                    </div>

                    <p className="text-xs text-slate-700 dark:text-slate-300 line-clamp-3">
                      {item.rawText}
                    </p>

                    {item.errorMessage && (
                      <p className="text-[11px] text-rose-500 mt-1">{item.errorMessage}</p>
                    )}

                    {usingSavedProjectChunks && (
                      <div
                        className="flex items-center gap-2 mt-2 pt-2 border-t border-slate-200 dark:border-slate-800/80"
                        onClick={(e) => e.stopPropagation()}
                      >
                        {isCompleted && (
                          <button
                            type="button"
                            onClick={() => void handlePlaySingleChunk(item)}
                            className="inline-flex items-center gap-1 px-2 py-1 rounded text-[11px] font-medium bg-emerald-500/10 text-emerald-600 dark:text-emerald-300 hover:bg-emerald-500/20 transition"
                          >
                            <Play className="w-3 h-3" />
                            Play
                          </button>
                        )}
                        <button
                          type="button"
                          disabled={queueState.isRunning || !voiceCompatible}
                          onClick={() => void handleRegenerateChunk(item.id)}
                          className="inline-flex items-center gap-1 px-2 py-1 rounded text-[11px] font-medium bg-[#7C5CFF]/15 text-[#7C5CFF] hover:bg-[#7C5CFF]/25 disabled:opacity-40 transition"
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
            <div className="p-3 border-t border-slate-200 dark:border-slate-800">
              <button
                type="button"
                onClick={() => remasterFromMap(activeProject, rawChunkMap)}
                className="w-full inline-flex items-center justify-center gap-1.5 px-3 py-1.5 rounded-lg text-xs font-medium border border-slate-200 dark:border-slate-700 text-slate-700 dark:text-slate-200 hover:bg-slate-100 dark:hover:bg-slate-800 transition"
              >
                <Sparkles className="w-3.5 h-3.5 text-[#7C5CFF]" />
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
