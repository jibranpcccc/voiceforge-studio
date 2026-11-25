import 'fake-indexeddb/auto';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  ArtifactIntegrityError,
  MODEL_CACHE_NAME,
  buildArtifactCacheKey,
  clearAllModelCaches,
  computeSha256Hex,
  deleteCachedModel,
  downloadAndCacheModel,
  getCachedArtifact,
  getCachedSizeBytes,
  importLocalModelBundle,
  isModelOfflineReady,
  verifyArtifactBytes,
  verifyCachedModel,
} from '../src/storage/modelCache';
import {
  clearAllUserData,
  closeDb,
  deleteAudioChunk,
  deleteHistoryEntry,
  deleteLabRun,
  deleteProject,
  deletePronunciationRule,
  deleteVoice,
  getAudioChunk,
  getHistoryEntry,
  getLabRun,
  getProject,
  getPronunciationRule,
  getVoice,
  listHistoryEntries,
  listLabRuns,
  listProjectAudioChunks,
  listProjects,
  listPronunciationRules,
  listVoices,
  saveAudioChunk,
  saveHistoryEntry,
  saveLabRun,
  saveProject,
  savePronunciationRule,
  saveVoice,
  setDefaultVoice,
} from '../src/storage/db';
import type {
  ModelManifestEntry,
  NarrationProject,
  PronunciationRule,
  VoiceProfile,
} from '../src/types';

class MemoryCache implements Cache {
  private readonly store = new Map<string, Response>();

  async match(request: RequestInfo | URL): Promise<Response | undefined> {
    const key = typeof request === 'string' ? request : request instanceof URL ? request.toString() : request.url;
    const hit = this.store.get(key);
    return hit ? hit.clone() : undefined;
  }

  async put(request: RequestInfo | URL, response: Response): Promise<void> {
    const key = typeof request === 'string' ? request : request instanceof URL ? request.toString() : request.url;
    this.store.set(key, response.clone());
  }

  async delete(request: RequestInfo | URL): Promise<boolean> {
    const key = typeof request === 'string' ? request : request instanceof URL ? request.toString() : request.url;
    return this.store.delete(key);
  }

  async keys(): Promise<readonly Request[]> {
    return Array.from(this.store.keys()).map((url) => new Request(url));
  }

  async add(): Promise<void> {
    throw new Error('Not implemented in test mock');
  }
  async addAll(): Promise<void> {
    throw new Error('Not implemented in test mock');
  }
  async matchAll(): Promise<readonly Response[]> {
    return [];
  }
}

class MemoryCacheStorage implements CacheStorage {
  private readonly cachesMap = new Map<string, MemoryCache>();

  async open(cacheName: string): Promise<Cache> {
    let cache = this.cachesMap.get(cacheName);
    if (!cache) {
      cache = new MemoryCache();
      this.cachesMap.set(cacheName, cache);
    }
    return cache;
  }

  async has(cacheName: string): Promise<boolean> {
    return this.cachesMap.has(cacheName);
  }

  async delete(cacheName: string): Promise<boolean> {
    return this.cachesMap.delete(cacheName);
  }

  async keys(): Promise<string[]> {
    return Array.from(this.cachesMap.keys());
  }

  async match(request: RequestInfo | URL): Promise<Response | undefined> {
    for (const cache of this.cachesMap.values()) {
      const hit = await cache.match(request);
      if (hit) return hit;
    }
    return undefined;
  }
}

function createSampleVoice(id: string, engineId = 'pocket-tts'): VoiceProfile {
  return {
    id,
    name: `Voice ${id}`,
    language: 'en',
    tags: ['narrator'],
    referenceClip: {
      clipId: `clip-${id}`,
      filename: 'ref.wav',
      mimeType: 'audio/wav',
      source: 'microphone',
      durationSec: 5.2,
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
        activeSpeechDurationSec: 5.0,
      },
      noiseFloorDb: -55,
      estimatedSnrDb: 34,
      rmsDb: -18,
      peakDb: -2,
      reverbEstimate: { score: 0.1, level: 'dry' },
      multiSpeakerEstimate: { score: 0.05, suspectedMultipleSpeakers: false },
      durationSec: 5.2,
      sampleRate: 24000,
      channels: 1,
      overallScore: 90,
      warnings: [],
      recommendations: [],
    },
    authorizedUse: {
      confirmed: true,
      confirmedAt: '2026-11-25T00:00:00Z',
      attestationText: 'Authorized',
      sourceBasis: 'self',
      verificationScope: 'client-self-attested',
    },
    conditioningPayloads: {
      [`${engineId}::rev-1`]: {
        engineId,
        modelRevision: 'rev-1',
        payloadVersion: 1,
        precision: 'int8',
        tensors: {},
        createdAt: '2026-11-25T00:00:00Z',
      },
    },
    createdAt: `2026-11-25T00:00:0${id.endsWith('2') ? '2' : '1'}Z`,
    updatedAt: '2026-11-25T00:00:01Z',
  };
}

function createSampleProject(id: string): NarrationProject {
  return {
    id,
    name: `Project ${id}`,
    voiceProfileId: 'voice-1',
    engineId: 'pocket-tts',
    executionMode: 'cpu',
    presetId: 'natural-narration',
    scriptText: 'Hello world. Second sentence.',
    chunks: [
      {
        id: 'chunk-1',
        index: 0,
        rawText: 'Hello world.',
        normalizedText: 'Hello world.',
        pauseAfterMs: 250,
        status: 'completed',
        audioDurationSec: 1.2,
        cachedAudioKey: `${id}::chunk-1`,
      },
    ],
    pronunciationRules: [],
    preprocessing: {
      trimSilence: true,
      silenceThresholdDb: -45,
      minSilenceDurationMs: 150,
      normalizeLoudness: true,
      targetLufs: -18,
      highPassFilterHz: 80,
      noiseGateEnabled: false,
      noiseGateThresholdDb: -50,
      deEssingEnabled: false,
      targetSampleRate: 24000,
      maxDurationSec: 30,
    },
    mastering: {
      preset: 'natural',
      eqLowGainDb: 0,
      eqMidGainDb: 0,
      eqHighGainDb: 0,
      warmth: 0.1,
      clarity: 0.1,
      deEsserAmount: 0,
      compressorEnabled: false,
      compressorThresholdDb: -18,
      compressorRatio: 2,
      targetLufs: -16,
      truePeakLimitDb: -1,
      fadeInMs: 10,
      fadeOutMs: 20,
    },
    sentencePauseMs: 250,
    paragraphPauseMs: 500,
    chunkCrossfadeMs: 25,
    engineParameters: { temperature: 0.7, lsdSteps: 1 },
    createdAt: '2026-11-25T00:00:00Z',
    updatedAt: '2026-11-25T00:00:01Z',
  };
}

async function createTestEntry(
  payloads: Record<string, Uint8Array>
): Promise<ModelManifestEntry> {
  const artifacts = await Promise.all(
    Object.entries(payloads).map(async ([relativePath, bytes], idx) => ({
      role: `role_${idx}`,
      relativePath,
      url: `https://example.test/models/${relativePath}`,
      sizeBytes: bytes.byteLength,
      sha256: await computeSha256Hex(bytes),
      format: relativePath.endsWith('.json') ? ('json' as const) : ('onnx' as const),
      required: true,
    }))
  );

  return {
    engineId: 'pocket-tts',
    displayName: 'Pocket TTS Test',
    repoId: 'KevinAHM/pocket-tts-onnx',
    revision: '58a6d00cf13d239b6748cb0769f35c580a8f606c',
    license: 'CC-BY-4.0',
    ungated: true,
    precision: 'int8',
    sampleRate: 24000,
    recommendedExecutionMode: 'cpu',
    estimatedMemoryMb: 550,
    totalSizeBytes: artifacts.reduce((s, a) => s + a.sizeBytes, 0),
    artifacts,
  };
}

describe('modelCache with streaming SHA-256 verification', () => {
  const originalCaches = globalThis.caches;

  beforeEach(() => {
    Object.defineProperty(globalThis, 'caches', {
      configurable: true,
      value: new MemoryCacheStorage(),
    });
  });

  afterEach(async () => {
    await clearAllModelCaches();
    Object.defineProperty(globalThis, 'caches', {
      configurable: true,
      value: originalCaches,
    });
  });

  it('computes and verifies SHA-256 digests and rejects size/hash mismatches', async () => {
    const data = new TextEncoder().encode('voiceforge-model-bytes');
    const digest = await computeSha256Hex(data);
    expect(digest).toHaveLength(64);

    await expect(
      verifyArtifactBytes(
        { relativePath: 'a.bin', sizeBytes: data.byteLength, sha256: digest },
        data
      )
    ).resolves.toBe(digest);

    await expect(
      verifyArtifactBytes(
        { relativePath: 'a.bin', sizeBytes: data.byteLength + 1, sha256: digest },
        data
      )
    ).rejects.toThrow(ArtifactIntegrityError);

    await expect(
      verifyArtifactBytes(
        { relativePath: 'a.bin', sizeBytes: data.byteLength, sha256: '0'.repeat(64) },
        data
      )
    ).rejects.toThrow(ArtifactIntegrityError);
  });

  it('streams downloads, verifies hashes before committing, and reports offline readiness', async () => {
    const fileA = new Uint8Array([1, 2, 3, 4, 5, 6, 7, 8]);
    const fileB = new TextEncoder().encode('{"ok":true}');
    const entry = await createTestEntry({
      'onnx/model_a.onnx': fileA,
      'onnx/bundle.json': fileB,
    });

    expect(await isModelOfflineReady(entry)).toBe(false);

    const progressEvents: number[] = [];
    const fetchImpl: typeof fetch = async (input) => {
      const url = typeof input === 'string' ? input : input instanceof URL ? input.toString() : input.url;
      const bytes = url.endsWith('model_a.onnx') ? fileA : fileB;
      const mid = Math.floor(bytes.byteLength / 2);
      const stream = new ReadableStream<Uint8Array>({
        start(controller) {
          controller.enqueue(bytes.slice(0, mid));
          controller.enqueue(bytes.slice(mid));
          controller.close();
        },
      });
      return new Response(stream, { status: 200 });
    };

    await downloadAndCacheModel(entry, {
      fetchImpl,
      onProgress: (p) => progressEvents.push(p.loadedBytes),
    });

    expect(progressEvents.length).toBeGreaterThan(0);
    expect(await isModelOfflineReady(entry)).toBe(true);
    expect(await getCachedSizeBytes(entry.engineId)).toBe(entry.totalSizeBytes);

    const report = await verifyCachedModel(entry);
    expect(report.ok).toBe(true);
    expect(report.artifacts.every((a) => a.ok)).toBe(true);

    const cachedA = await getCachedArtifact(
      entry.engineId,
      entry.revision,
      'onnx/model_a.onnx'
    );
    expect(new Uint8Array(cachedA!)).toEqual(fileA);

    // Corrupting a cached entry must be caught by verifyCachedModel
    const cache = await caches.open(MODEL_CACHE_NAME);
    const cacheKey = buildArtifactCacheKey(
      entry.engineId,
      entry.revision,
      'onnx/model_a.onnx'
    );
    await cache.put(
      `https://voiceforge-cache.local/${cacheKey}`,
      new Response(new Uint8Array([9, 9, 9, 9, 9, 9, 9, 9]))
    );
    const tamperedReport = await verifyCachedModel(entry);
    expect(tamperedReport.ok).toBe(false);

    await deleteCachedModel(entry.engineId);
    expect(await isModelOfflineReady(entry)).toBe(false);
    expect(await getCachedSizeBytes(entry.engineId)).toBe(0);
  });

  it('does NOT commit to cache when downloaded SHA-256 is corrupted and supports AbortSignal', async () => {
    const good = new Uint8Array([10, 20, 30, 40]);
    const entry = await createTestEntry({ 'onnx/model.onnx': good });

    const corruptFetch: typeof fetch = async () =>
      new Response(new Uint8Array([10, 20, 30, 99]), { status: 200 });

    await expect(
      downloadAndCacheModel(entry, { fetchImpl: corruptFetch })
    ).rejects.toThrow(ArtifactIntegrityError);

    expect(await isModelOfflineReady(entry)).toBe(false);
    expect(await getCachedSizeBytes(entry.engineId)).toBe(0);

    const controller = new AbortController();
    controller.abort();
    await expect(
      downloadAndCacheModel(entry, { signal: controller.signal })
    ).rejects.toMatchObject({ name: 'AbortError' });
  });

  it('imports and verifies local offline bundles cleanly', async () => {
    const fileA = new Uint8Array([11, 22, 33, 44]);
    const fileB = new TextEncoder().encode('{"local":1}');
    const entry = await createTestEntry({
      'onnx/english/a.onnx': fileA,
      'onnx/english/bundle.json': fileB,
    });

    await expect(
      importLocalModelBundle(entry, {
        'a.onnx': new Uint8Array([0, 0, 0, 0]),
        'bundle.json': fileB,
      })
    ).rejects.toThrow(ArtifactIntegrityError);
    expect(await isModelOfflineReady(entry)).toBe(false);

    await importLocalModelBundle(entry, {
      'a.onnx': fileA,
      'bundle.json': fileB,
    });
    expect(await isModelOfflineReady(entry)).toBe(true);
  });

  it('retries transient network/stream errors with exponential backoff and skips already-cached artifacts', async () => {
    const fileA = new Uint8Array([1, 3, 5, 7, 9, 11]);
    const fileB = new Uint8Array([2, 4, 6, 8, 10, 12]);
    const fileC = new TextEncoder().encode('{"resumed":true}');
    const entry = await createTestEntry({
      'onnx/part_a.onnx': fileA,
      'onnx/part_b.onnx': fileB,
      'onnx/config.json': fileC,
    });

    // Simulate an interrupted multi-file download where part_a.onnx is already in
    // Cache Storage (`voiceforge-models-v1`) with matching sizeBytes.
    const cache = await caches.open(MODEL_CACHE_NAME);
    const partAKey = buildArtifactCacheKey(entry.engineId, entry.revision, 'onnx/part_a.onnx');
    await cache.put(
      `https://voiceforge-cache.local/${partAKey}`,
      new Response(fileA, {
        status: 200,
        headers: {
          'Content-Length': String(fileA.byteLength),
        },
      })
    );

    const requestedUrls: string[] = [];
    let partBAttempts = 0;
    let configAttempts = 0;

    const flakyFetch: typeof fetch = async (input) => {
      const url = typeof input === 'string' ? input : input instanceof URL ? input.toString() : input.url;
      requestedUrls.push(url);

      if (url.endsWith('part_a.onnx')) {
        throw new Error('part_a.onnx was already cached and must not be re-downloaded');
      }

      if (url.endsWith('part_b.onnx')) {
        partBAttempts += 1;
        if (partBAttempts === 1) {
          throw new TypeError('network error');
        }
        if (partBAttempts === 2) {
          // Simulate a mid-stream drop (`TypeError: network error`) during chunk reading
          const failingStream = new ReadableStream<Uint8Array>({
            start(controller) {
              controller.enqueue(fileB.slice(0, 2));
              controller.error(new TypeError('network error'));
            },
          });
          return new Response(failingStream, { status: 200 });
        }
        return new Response(fileB, { status: 200 });
      }

      configAttempts += 1;
      return new Response(fileC, { status: 200 });
    };

    await downloadAndCacheModel(entry, {
      fetchImpl: flakyFetch,
      maxAttempts: 3,
      retryBaseDelayMs: 5,
    });

    expect(requestedUrls.some((u) => u.endsWith('part_a.onnx'))).toBe(false);
    expect(partBAttempts).toBe(3);
    expect(configAttempts).toBe(1);
    expect(await isModelOfflineReady(entry)).toBe(true);
    expect(await getCachedSizeBytes(entry.engineId)).toBe(entry.totalSizeBytes);

    // Exhausting retries on persistent transient failures rejects with the network error
    const failingEntry = await createTestEntry({ 'onnx/always_drops.onnx': fileA });
    let dropAttempts = 0;
    await expect(
      downloadAndCacheModel(failingEntry, {
        maxAttempts: 3,
        retryBaseDelayMs: 5,
        fetchImpl: async () => {
          dropAttempts += 1;
          throw new TypeError('network error');
        },
      })
    ).rejects.toThrow(TypeError);
    expect(dropAttempts).toBe(3);

    // Aborting during exponential backoff immediately cancels with AbortError
    const abortController = new AbortController();
    let abortedAttempts = 0;
    const abortPromise = downloadAndCacheModel(failingEntry, {
      signal: abortController.signal,
      maxAttempts: 3,
      retryBaseDelayMs: 5000,
      fetchImpl: async () => {
        abortedAttempts += 1;
        setTimeout(() => abortController.abort(), 10);
        throw new TypeError('network error');
      },
    });
    await expect(abortPromise).rejects.toMatchObject({ name: 'AbortError' });
    expect(abortedAttempts).toBe(1);
  });
});

describe('IndexedDB persistence (voiceforge-db)', () => {
  beforeEach(async () => {
    Object.defineProperty(globalThis, 'caches', {
      configurable: true,
      value: new MemoryCacheStorage(),
    });
    await clearAllUserData();
  });

  afterEach(async () => {
    await clearAllUserData();
    await closeDb();
  });

  it('performs full CRUD for voices, projects, disk-backed audio chunks, rules, history, and labRuns', async () => {
    const v1 = createSampleVoice('v1', 'pocket-tts');
    const v2 = createSampleVoice('v2', 'chatterbox');
    await saveVoice(v1, { isDefault: true });
    await saveVoice(v2, { isDefault: false });

    expect((await getVoice('v1'))?.name).toBe('Voice v1');
    expect(await listVoices({ isDefault: true })).toHaveLength(1);
    expect(await listVoices({ engineId: 'chatterbox' })).toHaveLength(1);

    await setDefaultVoice('v2');
    const defaults = await listVoices({ isDefault: true });
    expect(defaults).toHaveLength(1);
    expect(defaults[0].id).toBe('v2');

    const project = createSampleProject('proj-1');
    await saveProject(project);
    expect((await getProject('proj-1'))?.name).toBe('Project proj-1');
    expect(await listProjects()).toHaveLength(1);

    const pcm = new Float32Array([0.1, -0.2, 0.3, -0.4]);
    await saveAudioChunk({
      projectId: 'proj-1',
      chunkId: 'chunk-1',
      sampleRate: 24000,
      pcm,
      durationSec: 4 / 24000,
    });
    const loadedChunk = await getAudioChunk('proj-1', 'chunk-1');
    expect(loadedChunk).toBeDefined();
    expect(Array.from(new Float32Array(loadedChunk!.pcmBytes))).toEqual(
      Array.from(pcm)
    );
    expect(await listProjectAudioChunks('proj-1')).toHaveLength(1);

    const rule: PronunciationRule = {
      id: 'rule-1',
      pattern: 'API',
      replacement: 'A P I',
      isRegex: false,
      caseSensitive: true,
      enabled: true,
    };
    await savePronunciationRule(rule);
    expect((await getPronunciationRule('rule-1'))?.replacement).toBe('A P I');
    expect(await listPronunciationRules()).toHaveLength(1);

    await saveHistoryEntry({
      id: 'hist-1',
      text: 'Hello',
      voiceProfileId: 'v1',
      voiceName: 'Voice v1',
      engineId: 'pocket-tts',
      modelRevision: 'rev-1',
      language: 'en',
      parameters: { temperature: 0.7 },
      sampleRate: 24000,
      durationSec: 1.0,
      generationTimeMs: 200,
      realTimeFactor: 0.2,
      createdAt: '2026-11-25T00:00:00Z',
    });
    expect(await getHistoryEntry('hist-1')).toBeDefined();
    expect(await listHistoryEntries()).toHaveLength(1);

    await saveLabRun({
      id: 'lab-1',
      title: 'A/B Test',
      text: 'Test sentence.',
      voiceProfileId: 'v1',
      variants: [
        {
          label: 'Variant A',
          engineId: 'pocket-tts',
          modelRevision: 'rev-1',
          executionMode: 'cpu',
          parameters: { temperature: 0.5 },
          sampleRate: 24000,
          durationSec: 1.1,
          generationTimeMs: 250,
          realTimeFactor: 0.22,
        },
      ],
      createdAt: '2026-11-25T00:00:00Z',
    });
    expect(await getLabRun('lab-1')).toBeDefined();
    expect(await listLabRuns()).toHaveLength(1);

    // Deleting project cascades to its audioChunks
    await deleteProject('proj-1');
    expect(await getProject('proj-1')).toBeUndefined();
    expect(await listProjectAudioChunks('proj-1')).toHaveLength(0);

    await deleteAudioChunk('proj-1', 'chunk-1');
    await deleteVoice('v1');
    await deletePronunciationRule('rule-1');
    await deleteHistoryEntry('hist-1');
    await deleteLabRun('lab-1');
  });

  it('clearAllUserData removes all IndexedDB stores, model caches, and localStorage', async () => {
    await saveVoice(createSampleVoice('v-clear'));
    await saveProject(createSampleProject('p-clear'));
    await saveAudioChunk({
      projectId: 'p-clear',
      chunkId: 'c-1',
      sampleRate: 24000,
      pcm: new Float32Array([0.5, -0.5]),
      durationSec: 0.01,
    });
    globalThis.localStorage.setItem('vf_pref', 'cpu');

    const bytes = new Uint8Array([1, 2, 3]);
    const entry = await createTestEntry({ 'onnx/tiny.onnx': bytes });
    await importLocalModelBundle(entry, { 'tiny.onnx': bytes });
    expect(await isModelOfflineReady(entry)).toBe(true);

    await clearAllUserData();

    expect(await listVoices()).toHaveLength(0);
    expect(await listProjects()).toHaveLength(0);
    expect(await listProjectAudioChunks('p-clear')).toHaveLength(0);
    expect(await isModelOfflineReady(entry)).toBe(false);
    expect(globalThis.localStorage.getItem('vf_pref')).toBeNull();
  });
});
