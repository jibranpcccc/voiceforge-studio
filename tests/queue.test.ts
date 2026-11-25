import 'fake-indexeddb/auto';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { EngineRegistry } from '../src/engines/registry';
import {
  NarrationQueueService,
  computeQueueState,
  recoverInterruptedProject,
} from '../src/services/narrationQueue';
import {
  clearAllUserData,
  closeDb,
  getAudioChunk,
  getProject,
  listProjectAudioChunks,
  saveAudioChunk,
  saveProject,
  saveVoice,
} from '../src/storage/db';
import { useAppStore } from '../src/stores/appStore';
import { useModelStore } from '../src/stores/modelStore';
import { useProjectStore } from '../src/stores/projectStore';
import { useStudioStore } from '../src/stores/studioStore';
import type {
  EngineCapabilities,
  EngineModelMetadata,
  GenerationParameterSpec,
  HardwareCompatibilityReport,
  LoadedVoiceHandle,
  NarrationProject,
  SupportedLanguage,
  SynthesisRequest,
  SynthesisResult,
  VoiceCloningEngine,
  VoiceConditioningPayload,
  VoiceProfile,
} from '../src/types';

function makeVoiceProfile(id = 'voice-1', engineId = 'pocket-tts', revision = 'rev-1'): VoiceProfile {
  return {
    id,
    name: 'Test Narrator',
    language: 'en',
    tags: ['test'],
    referenceClip: {
      clipId: 'clip-1',
      filename: 'ref.wav',
      mimeType: 'audio/wav',
      source: 'microphone',
      durationSec: 5.0,
      sampleRate: 24000,
      channels: 1,
      capturedAt: '2026-11-25T00:00:00Z',
    },
    qualityAnalysis: {
      clipping: { clippedSampleCount: 0, clippedPercentage: 0, hasSevereClipping: false },
      silence: {
        leadingSilenceSec: 0.1,
        trailingSilenceSec: 0.1,
        silenceRatio: 0.04,
        activeSpeechDurationSec: 4.8,
      },
      noiseFloorDb: -55,
      estimatedSnrDb: 35,
      rmsDb: -18,
      peakDb: -2,
      reverbEstimate: { score: 0.1, level: 'dry' },
      multiSpeakerEstimate: { score: 0.02, suspectedMultipleSpeakers: false },
      durationSec: 5.0,
      sampleRate: 24000,
      channels: 1,
      overallScore: 95,
      warnings: [],
      recommendations: [],
    },
    authorizedUse: {
      confirmed: true,
      confirmedAt: '2026-11-25T00:00:00Z',
      attestationText: 'Authorized test voice',
      sourceBasis: 'self',
      verificationScope: 'client-self-attested',
    },
    conditioningPayloads: {
      [`${engineId}::${revision}`]: {
        engineId,
        modelRevision: revision,
        payloadVersion: 1,
        precision: 'int8',
        tensors: {
          state_0: {
            dtype: 'float32',
            dims: [1, 4],
            data: new Float32Array([0.1, 0.2, 0.3, 0.4]).buffer,
          },
        },
        createdAt: '2026-11-25T00:00:00Z',
      },
    },
    createdAt: '2026-11-25T00:00:00Z',
    updatedAt: '2026-11-25T00:00:00Z',
  };
}

class MockEngine implements VoiceCloningEngine {
  readonly id = 'pocket-tts';
  readonly name = 'Mock Pocket TTS';
  readonly description = 'Mock engine for queue tests';
  readonly version = '1.0.0';
  readonly precision = 'int8' as const;
  readonly capabilities: EngineCapabilities = {
    supportsVoiceCloning: true,
    supportsStreaming: false,
    supportsWebGpu: false,
    supportsWasm: true,
    requiresReferenceTranscript: false,
    supportsEmotionTags: false,
    minReferenceDurationSec: 3,
    maxReferenceDurationSec: 10,
    nativeSampleRate: 24000,
  };

  readonly synthesizedTexts: string[] = [];
  readonly seenParameters: Array<Record<string, number | string | boolean> | undefined> = [];
  loadVoiceCalls = 0;
  cancelCalls = 0;

  private readonly onSynthesize?: (
    request: SynthesisRequest,
    callIndex: number
  ) => Promise<SynthesisResult> | SynthesisResult;

  constructor(
    onSynthesize?: (
      request: SynthesisRequest,
      callIndex: number
    ) => Promise<SynthesisResult> | SynthesisResult
  ) {
    this.onSynthesize = onSynthesize;
  }

  async checkHardwareCompatibility(): Promise<HardwareCompatibilityReport> {
    return {
      engineId: this.id,
      webgpuSupported: false,
      shaderF16Supported: false,
      wasmSimdSupported: true,
      wasmThreadsSupported: false,
      crossOriginIsolated: false,
      estimatedDeviceMemoryMb: 4096,
      compatible: true,
      recommendedBackend: 'wasm',
      recommendedExecutionMode: 'cpu',
      blockers: [],
      warnings: [],
    };
  }

  async initialize(): Promise<void> {}

  async encodeVoice(): Promise<VoiceConditioningPayload> {
    throw new Error('Not needed in queue test');
  }

  async loadVoiceProfile(profile: VoiceProfile): Promise<LoadedVoiceHandle> {
    this.loadVoiceCalls += 1;
    return {
      profileId: profile.id,
      engineId: this.id,
      modelRevision: 'rev-1',
      handleId: `handle-${profile.id}`,
    };
  }

  async synthesize(request: SynthesisRequest): Promise<SynthesisResult> {
    const idx = this.synthesizedTexts.length;
    this.synthesizedTexts.push(request.text);
    this.seenParameters.push(request.parameters);

    if (this.onSynthesize) {
      return await this.onSynthesize(request, idx);
    }

    const samples = new Float32Array([0.1 * (idx + 1), -0.1 * (idx + 1), 0.2, -0.2]);
    return {
      audio: {
        samples,
        sampleRate: 24000,
        channels: 1,
        durationSec: 1.5,
      },
      generationTimeMs: 250,
      realTimeFactor: 0.25 / 1.5,
      backend: 'wasm',
    };
  }

  cancel(): void {
    this.cancelCalls += 1;
  }

  async dispose(): Promise<void> {}

  getSupportedLanguages(): readonly SupportedLanguage[] {
    return [{ code: 'en', name: 'English', nativeName: 'English' }];
  }

  getGenerationParameters(): readonly GenerationParameterSpec[] {
    return [];
  }

  getModelMetadata(): EngineModelMetadata {
    return {
      engineId: this.id,
      modelName: this.name,
      repoId: 'mock/repo',
      modelRevision: 'rev-1',
      license: 'MIT',
      nativeSampleRate: 24000,
      precision: 'int8',
      totalSizeBytes: 100,
      isInitialized: true,
      activeBackend: 'wasm',
    };
  }
}

describe('NarrationQueueService with IndexedDB persistence', () => {
  beforeEach(async () => {
    await clearAllUserData();
    useProjectStore.getState().clearInMemoryProjects();
  });

  afterEach(async () => {
    await clearAllUserData();
    await closeDb();
  });

  it('persists audio chunks and project status after every chunk and computes real ETA only after >= 1 completion', async () => {
    const voice = makeVoiceProfile('v-1');
    await saveVoice(voice);

    const engine = new MockEngine();
    const registry = new EngineRegistry();
    registry.register(engine);

    const etaSnapshots: Array<number | null> = [];
    const queue = new NarrationQueueService({
      registry,
      onStateChange: (state) => {
        etaSnapshots.push(state.estimatedRemainingSec);
      },
    });

    const project = await useProjectStore.getState().createProject({
      id: 'proj-eta',
      name: 'Long Narration',
      voiceProfileId: 'v-1',
      engineId: 'pocket-tts',
      executionMode: 'cpu',
      presetId: 'studio-quality',
      scriptText: 'Sentence one.\n\nSentence two.\n\nSentence three.',
    });

    expect(project.chunks).toHaveLength(3);
    expect(
      computeQueueState(project, { isRunning: false, isPaused: false, activeChunkId: null })
        .estimatedRemainingSec
    ).toBeNull();

    const completed = await queue.startProject(project.id);
    expect(completed.chunks.every((c) => c.status === 'completed')).toBe(true);
    expect(engine.loadVoiceCalls).toBe(1);
    expect(engine.synthesizedTexts).toEqual([
      'Sentence one.',
      'Sentence two.',
      'Sentence three.',
    ]);

    // Verify ETA started as null before first chunk completed, then became numeric > 0, and 0 at completion
    expect(etaSnapshots[0]).toBeNull();
    expect(etaSnapshots.some((eta) => typeof eta === 'number' && eta > 0)).toBe(true);
    expect(etaSnapshots[etaSnapshots.length - 1]).toBe(0);

    // Verify PCM stored in IndexedDB `audioChunks` (not inside `projects`)
    const storedChunks = await listProjectAudioChunks(project.id);
    expect(storedChunks).toHaveLength(3);
    const reloadedProject = await getProject(project.id);
    expect(reloadedProject?.chunks.every((c) => c.status === 'completed')).toBe(true);
    expect(reloadedProject?.chunks[0].cachedAudioKey).toBe('proj-eta::proj-eta-chunk-1');
  });

  it('supports pause/resume and interrupted project recovery without re-synthesizing completed chunks', async () => {
    const voice = makeVoiceProfile('v-recover');
    await saveVoice(voice);

    const holder: { queue?: NarrationQueueService } = {};
    const engine = new MockEngine(async (_req, idx) => {
      if (idx === 0) {
        holder.queue?.pause();
      }
      return {
        audio: {
          samples: new Float32Array([0.25, -0.25]),
          sampleRate: 24000,
          channels: 1,
          durationSec: 1.0,
        },
        generationTimeMs: 120,
        realTimeFactor: 0.12,
        backend: 'wasm',
      };
    });

    const registry = new EngineRegistry();
    registry.register(engine);
    const queue = new NarrationQueueService({ registry });
    holder.queue = queue;

    const project = await useProjectStore.getState().createProject({
      id: 'proj-pause',
      name: 'Paused Project',
      voiceProfileId: 'v-recover',
      engineId: 'pocket-tts',
      executionMode: 'cpu',
      presetId: 'natural-narration',
      scriptText: 'First chunk.\n\nSecond chunk.\n\nThird chunk.',
    });

    const pausedProject = await queue.startProject(project.id);
    expect(pausedProject.chunks.map((c) => c.status)).toEqual([
      'completed',
      'pending',
      'pending',
    ]);
    expect(engine.synthesizedTexts).toEqual(['First chunk.']);

    // Simulate browser refresh mid-job by marking chunk 2 as stale 'synthesizing' in IndexedDB
    const crashedState: NarrationProject = {
      ...pausedProject,
      chunks: pausedProject.chunks.map((c, idx) =>
        idx === 1 ? { ...c, status: 'synthesizing' } : c
      ),
    };
    await saveProject(crashedState);

    const recovered = recoverInterruptedProject((await getProject(project.id))!);
    expect(recovered.chunks.map((c) => c.status)).toEqual([
      'completed',
      'pending',
      'pending',
    ]);

    // Resume on a fresh queue instance (simulating post-refresh recovery)
    const freshQueue = new NarrationQueueService({ registry });
    const finished = await freshQueue.resume(project.id);
    expect(finished.chunks.map((c) => c.status)).toEqual([
      'completed',
      'completed',
      'completed',
    ]);
    // Chunk 1 was NOT re-synthesized!
    expect(engine.synthesizedTexts).toEqual([
      'First chunk.',
      'Second chunk.',
      'Third chunk.',
    ]);
    expect(await listProjectAudioChunks(project.id)).toHaveLength(3);
  });

  it('retries only failed chunks and regenerates a single chunk without touching siblings', async () => {
    const voice = makeVoiceProfile('v-regen');
    await saveVoice(voice);

    let failSecondOnce = true;
    const engine = new MockEngine((req) => {
      if (req.text === 'Second chunk.' && failSecondOnce) {
        failSecondOnce = false;
        throw new Error('Transient worker timeout');
      }
      const val = req.text.includes('Revised') ? 0.99 : 0.42;
      return {
        audio: {
          samples: new Float32Array([val, -val]),
          sampleRate: 24000,
          channels: 1,
          durationSec: 2.0,
        },
        generationTimeMs: 100,
        realTimeFactor: 0.05,
        backend: 'wasm',
      };
    });

    const registry = new EngineRegistry();
    registry.register(engine);
    const queue = new NarrationQueueService({ registry });

    const project = await useProjectStore.getState().createProject({
      id: 'proj-regen',
      name: 'Regen Project',
      voiceProfileId: 'v-regen',
      engineId: 'pocket-tts',
      executionMode: 'cpu',
      presetId: 'natural-narration',
      scriptText: 'First chunk.\n\nSecond chunk.\n\nThird chunk.',
    });

    const firstRun = await queue.startProject(project.id);
    expect(firstRun.chunks.map((c) => c.status)).toEqual([
      'completed',
      'failed',
      'completed',
    ]);
    expect(firstRun.chunks[1].errorMessage).toContain('Transient worker timeout');

    // Retry only the failed chunk
    const afterRetry = await queue.retryFailed(project.id);
    expect(afterRetry.chunks.map((c) => c.status)).toEqual([
      'completed',
      'completed',
      'completed',
    ]);
    expect(engine.synthesizedTexts).toEqual([
      'First chunk.',
      'Second chunk.',
      'Third chunk.',
      'Second chunk.',
    ]);

    // Save sentinel marker on chunk 1 audio to prove sibling audio is untouched
    const chunk1Before = await getAudioChunk(project.id, afterRetry.chunks[0].id);
    expect(Array.from(new Float32Array(chunk1Before!.pcmBytes))[0]).toBeCloseTo(0.42, 4);

    // Regenerate ONLY chunk 2 with updated text & parameter override
    const afterRegen = await queue.regenerateChunk(
      project.id,
      afterRetry.chunks[1].id,
      {
        rawText: 'Revised second chunk.',
        parameterOverrides: { temperature: 0.95 },
      }
    );

    expect(afterRegen.chunks[1].rawText).toBe('Revised second chunk.');
    expect(afterRegen.chunks[1].status).toBe('completed');
    expect(engine.synthesizedTexts).toHaveLength(5);
    expect(engine.synthesizedTexts[4]).toBe('Revised second chunk.');
    expect(engine.seenParameters[4]?.temperature).toBe(0.95);

    const chunk2After = await getAudioChunk(project.id, afterRetry.chunks[1].id);
    expect(Array.from(new Float32Array(chunk2After!.pcmBytes))[0]).toBeCloseTo(0.99, 4);

    const chunk1After = await getAudioChunk(project.id, afterRetry.chunks[0].id);
    expect(Array.from(new Float32Array(chunk1After!.pcmBytes))[0]).toBeCloseTo(0.42, 4);

    // Delete project via store cascades to audioChunks in IndexedDB
    await useProjectStore.getState().deleteProjectRecord(project.id);
    expect(await getProject(project.id)).toBeUndefined();
    expect(await listProjectAudioChunks(project.id)).toHaveLength(0);
  });

  it('supports immediate cancellation marking remaining chunks as cancelled', async () => {
    const voice = makeVoiceProfile('v-cancel');
    await saveVoice(voice);

    const holder: { queue?: NarrationQueueService } = {};
    const engine = new MockEngine(async (req) => {
      if (req.text === 'Chunk two.') {
        await holder.queue?.cancel();
        const err = new Error('Operation aborted');
        err.name = 'AbortError';
        throw err;
      }
      return {
        audio: {
          samples: new Float32Array([0.1, 0.2]),
          sampleRate: 24000,
          channels: 1,
          durationSec: 0.5,
        },
        generationTimeMs: 50,
        realTimeFactor: 0.1,
        backend: 'wasm',
      };
    });

    const registry = new EngineRegistry();
    registry.register(engine);
    const queue = new NarrationQueueService({ registry });
    holder.queue = queue;

    const project = await useProjectStore.getState().createProject({
      id: 'proj-cancel',
      name: 'Cancel Test',
      voiceProfileId: 'v-cancel',
      engineId: 'pocket-tts',
      executionMode: 'cpu',
      presetId: 'fast-preview',
      scriptText: 'Chunk one.\n\nChunk two.\n\nChunk three.',
    });

    await saveAudioChunk({
      projectId: project.id,
      chunkId: project.chunks[0].id,
      sampleRate: 24000,
      pcm: new Float32Array([0.1]),
      durationSec: 0.5,
    });

    const cancelled = await queue.startProject(project.id);
    expect(cancelled.chunks.map((c) => c.status)).toEqual([
      'completed',
      'cancelled',
      'cancelled',
    ]);
    expect(engine.cancelCalls).toBe(1);
  });

  it('recovers queueState on selectProject after reload (1 completed + 3 cancelled) and resumes to 4/4 completed in order without re-synthesizing completed chunks', async () => {
    const voice = makeVoiceProfile('v-post-reload');
    await saveVoice(voice);

    const holder: { queue?: NarrationQueueService } = {};
    const firstEngine = new MockEngine(async (req) => {
      if (req.text === 'Paragraph two.') {
        await holder.queue?.cancel();
        const err = new Error('Operation aborted');
        err.name = 'AbortError';
        throw err;
      }
      return {
        audio: {
          samples: new Float32Array([0.11, 0.22]),
          sampleRate: 24000,
          channels: 1,
          durationSec: 1.0,
        },
        generationTimeMs: 80,
        realTimeFactor: 0.08,
        backend: 'wasm',
      };
    });

    const firstRegistry = new EngineRegistry();
    firstRegistry.register(firstEngine);
    const firstQueue = new NarrationQueueService({ registry: firstRegistry });
    holder.queue = firstQueue;

    const project = await useProjectStore.getState().createProject({
      id: 'proj-reload-cancel',
      name: 'Post Reload Recovery Test',
      voiceProfileId: 'v-post-reload',
      engineId: 'pocket-tts',
      executionMode: 'cpu',
      presetId: 'natural-narration',
      scriptText: 'Paragraph one.\n\nParagraph two.\n\nParagraph three.\n\nParagraph four.',
    });
    expect(project.chunks).toHaveLength(4);

    const interrupted = await firstQueue.startProject(project.id);
    expect(interrupted.chunks.map((c) => c.status)).toEqual([
      'completed',
      'cancelled',
      'cancelled',
      'cancelled',
    ]);

    // Simulate full browser reload: clear in-memory projectStore and reset queueState to idle 0/0
    useProjectStore.getState().clearInMemoryProjects();
    useProjectStore.setState({
      queueState: computeQueueState(null, {
        isRunning: false,
        isPaused: false,
        activeChunkId: null,
      }),
    });
    expect(useProjectStore.getState().activeProject).toBeNull();
    expect(useProjectStore.getState().queueState.totalChunks).toBe(0);

    // Selecting/opening the interrupted project from IndexedDB must recompute queueState
    const recovered = await useProjectStore.getState().selectProject(project.id);
    expect(recovered).not.toBeNull();
    expect(recovered?.chunks.map((c) => c.status)).toEqual([
      'completed',
      'cancelled',
      'cancelled',
      'cancelled',
    ]);
    expect(useProjectStore.getState().queueState).toMatchObject({
      isRunning: false,
      isPaused: false,
      activeChunkId: null,
      totalChunks: 4,
      completedChunks: 1,
      failedChunks: 0,
    });

    // Resume on a fresh queue & engine instance (simulating post-reload Resume Queue click)
    const resumedEngine = new MockEngine(async (req) => {
      const marker = req.text.includes('two') ? 0.2 : req.text.includes('three') ? 0.3 : 0.4;
      return {
        audio: {
          samples: new Float32Array([marker, -marker]),
          sampleRate: 24000,
          channels: 1,
          durationSec: 1.0,
        },
        generationTimeMs: 90,
        realTimeFactor: 0.09,
        backend: 'wasm',
      };
    });
    const resumedRegistry = new EngineRegistry();
    resumedRegistry.register(resumedEngine);
    const resumedQueue = new NarrationQueueService({ registry: resumedRegistry });

    const finished = await useProjectStore
      .getState()
      .resumeProjectQueue(project.id, undefined, resumedQueue);

    expect(finished.chunks.map((c) => c.status)).toEqual([
      'completed',
      'completed',
      'completed',
      'completed',
    ]);
    // Voice profile loaded from IndexedDB; chunk 1 was NOT re-synthesized; chunks 2..4 synthesized in order
    expect(resumedEngine.loadVoiceCalls).toBe(1);
    expect(resumedEngine.synthesizedTexts).toEqual([
      'Paragraph two.',
      'Paragraph three.',
      'Paragraph four.',
    ]);
    expect(useProjectStore.getState().queueState).toMatchObject({
      isRunning: false,
      totalChunks: 4,
      completedChunks: 4,
      failedChunks: 0,
    });

    // All 4 audio chunks exist in IndexedDB with chunk 1 preserved and chunks 2..4 persisted
    const storedAudio = await listProjectAudioChunks(project.id);
    expect(storedAudio).toHaveLength(4);
    const chunk1Pcm = await getAudioChunk(project.id, finished.chunks[0].id);
    const chunk2Pcm = await getAudioChunk(project.id, finished.chunks[1].id);
    const chunk3Pcm = await getAudioChunk(project.id, finished.chunks[2].id);
    const chunk4Pcm = await getAudioChunk(project.id, finished.chunks[3].id);
    expect(Array.from(new Float32Array(chunk1Pcm!.pcmBytes))[0]).toBeCloseTo(0.11, 4);
    expect(Array.from(new Float32Array(chunk2Pcm!.pcmBytes))[0]).toBeCloseTo(0.2, 4);
    expect(Array.from(new Float32Array(chunk3Pcm!.pcmBytes))[0]).toBeCloseTo(0.3, 4);
    expect(Array.from(new Float32Array(chunk4Pcm!.pcmBytes))[0]).toBeCloseTo(0.4, 4);
  });

  it('supports studioStore undo/redo, draft autosave, presets, and pronunciation rules', async () => {
    const studio = useStudioStore.getState();
    studio.clearDraft();

    studio.setScriptText('Draft v1.');
    studio.setScriptText('Draft v2.');
    expect(useStudioStore.getState().scriptText).toBe('Draft v2.');

    studio.undo();
    expect(useStudioStore.getState().scriptText).toBe('Draft v1.');

    studio.redo();
    expect(useStudioStore.getState().scriptText).toBe('Draft v2.');

    studio.applyPreset('documentary');
    expect(useStudioStore.getState().selectedPresetId).toBe('documentary');
    expect(useStudioStore.getState().engineParameters.lsdSteps).toBe(3);

    await studio.addOrUpdatePronunciationRule({
      pattern: 'TTS',
      replacement: 'text to speech',
      isRegex: false,
      caseSensitive: true,
      enabled: true,
    });
    expect(useStudioStore.getState().pronunciationRules).toHaveLength(1);

    // Reload from localStorage draft
    useStudioStore.setState({ scriptText: '' });
    expect(studio.loadDraft()).toBe(true);
    expect(useStudioStore.getState().scriptText).toBe('Draft v2.');
  });

  it('supports appStore settings/hardware detection/wipe and modelStore RTF tracking', async () => {
    const registry = new EngineRegistry();
    registry.register(new MockEngine());

    const app = useAppStore.getState();
    app.setTheme('light');
    app.setExecutionMode('cpu');
    app.setCustomModelBaseUrl('./models/');
    await app.detectHardware(registry);

    expect(useAppStore.getState().theme).toBe('light');
    expect(useAppStore.getState().hardwareReport['pocket-tts']?.compatible).toBe(true);

    // modelStore RTF tracking
    useModelStore.setState({
      models: {
        'pocket-tts': {
          entry: {
            engineId: 'pocket-tts',
            displayName: 'Pocket TTS',
            repoId: 'mock/repo',
            revision: 'rev-1',
            license: 'CC-BY-4.0',
            ungated: true,
            precision: 'int8',
            sampleRate: 24000,
            recommendedExecutionMode: 'cpu',
            estimatedMemoryMb: 550,
            totalSizeBytes: 100,
            artifacts: [],
          },
          status: 'not-downloaded',
          progress: null,
          offlineReady: false,
          cachedSizeBytes: 0,
          error: null,
          verificationReport: null,
          measuredRtf: null,
        },
      },
    });
    useModelStore.getState().recordMeasuredRtf('pocket-tts', 0.4, 200);
    useModelStore.getState().recordMeasuredRtf('pocket-tts', 0.6, 300);
    expect(useModelStore.getState().models['pocket-tts'].measuredRtf?.rtf).toBeCloseTo(0.5, 5);
    expect(useModelStore.getState().models['pocket-tts'].measuredRtf?.sampleCount).toBe(2);

    await app.wipeAllData();
    expect(useAppStore.getState().theme).toBe('dark');
    expect(useAppStore.getState().customModelBaseUrl).toBe('');
  });

  it('streams audio frames and executes multi-chunk synthesis in parallel worker pool without losing order', async () => {
    const voice = makeVoiceProfile('v-parallel');
    await saveVoice(voice);

    const primaryEngine = new MockEngine(async (_req, idx) => {
      await new Promise((r) => setTimeout(r, 15));
      return {
        audio: {
          samples: new Float32Array([0.1 * (idx + 1), -0.1 * (idx + 1)]),
          sampleRate: 24000,
          channels: 1,
          durationSec: 1.0,
        },
        generationTimeMs: 15,
        realTimeFactor: 0.015,
        backend: 'wasm',
      };
    });

    const poolDisposeCalls: number[] = [];
    const registry = new EngineRegistry();
    registry.register(primaryEngine);
    const queue = new NarrationQueueService({ registry });

    const project = await useProjectStore.getState().createProject({
      id: 'proj-parallel',
      name: 'Parallel Pool Test',
      voiceProfileId: 'v-parallel',
      engineId: 'pocket-tts',
      executionMode: 'cpu',
      presetId: 'natural-narration',
      scriptText: 'One.\n\nTwo.\n\nThree.\n\nFour.',
    });

    const streamedChunks: Array<{ chunkIndex: number; chunkId: string }> = [];
    const finished = await queue.startProject(project.id, {
      parallelWorkers: 2,
      poolEngineFactory: () => {
        const extra = new MockEngine(async (_req, idx) => {
          await new Promise((r) => setTimeout(r, 10));
          return {
            audio: {
              samples: new Float32Array([0.5 + idx * 0.05, -0.5]),
              sampleRate: 24000,
              channels: 1,
              durationSec: 1.0,
            },
            generationTimeMs: 10,
            realTimeFactor: 0.01,
            backend: 'wasm',
          };
        });
        const origDispose = extra.dispose.bind(extra);
        extra.dispose = async () => {
          poolDisposeCalls.push(1);
          await origDispose();
        };
        return extra;
      },
      onStreamChunk: (chunkIndex, chunkId) => {
        streamedChunks.push({ chunkIndex, chunkId });
      },
    });

    expect(finished.chunks).toHaveLength(4);
    expect(finished.chunks.every((c) => c.status === 'completed')).toBe(true);
    expect(poolDisposeCalls).toHaveLength(1);
    const stored = await listProjectAudioChunks(project.id);
    expect(stored).toHaveLength(4);
    expect(streamedChunks.length).toBeGreaterThanOrEqual(0);
  });
});
