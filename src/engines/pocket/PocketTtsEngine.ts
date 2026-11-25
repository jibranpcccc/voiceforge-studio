import {
  buildEngineCompatibilityReport,
  detectHardwareCapabilities,
} from '../../services/hardware';
import type {
  AudioBufferData,
  EngineBackend,
  EngineCapabilities,
  EngineInitOptions,
  EngineLoadProgress,
  EngineModelMetadata,
  EnginePrecision,
  GenerationParameterSpec,
  HardwareCompatibilityReport,
  LoadedVoiceHandle,
  ModelManifestEntry,
  ReferenceClipMetadata,
  SerializedTensorData,
  SupportedLanguage,
  SynthesisRequest,
  SynthesisResult,
  SynthesizedAudioChunk,
  VoiceCloningEngine,
  VoiceConditioningPayload,
  VoiceProfile,
} from '../../types';
import {
  POCKET_ENGINE_ID,
  POCKET_ENGINE_NAME,
  POCKET_ENGINE_VERSION,
  POCKET_MAX_REFERENCE_SEC,
  POCKET_MODEL_MANIFEST_ENTRY,
  POCKET_MODEL_REVISION,
  POCKET_PAYLOAD_VERSION,
  POCKET_RECOMMENDED_MAX_REF_SEC,
  POCKET_RECOMMENDED_MIN_REF_SEC,
  POCKET_REPO_ID,
  POCKET_SAMPLE_RATE,
  POCKET_TOTAL_SIZE_BYTES,
  type PocketWorkerRequest,
  type PocketWorkerResponse,
} from './constants';
import { preprocessReferenceAudio } from './preprocess';

export interface PocketTtsEngineOptions {
  /** Optional custom model manifest entry (e.g., loaded from `public/model-manifests/models.json`). */
  manifestEntry?: ModelManifestEntry;
  /** Optional custom base URL for self-hosted cPanel model mirror. */
  customModelBaseUrl?: string;
  /** Optional custom worker factory (primarily for unit testing). */
  workerFactory?: () => Worker;
}

interface PendingRpc {
  resolve: (value: unknown) => void;
  reject: (reason: unknown) => void;
  onProgress?: (progress: EngineLoadProgress) => void;
  onChunk?: (chunk: SynthesizedAudioChunk) => void;
  chunks?: SynthesizedAudioChunk[];
}

const REQUIRED_STATE_KEYS = Array.from({ length: 18 }, (_, i) => `state_${i}`);

function createErrorFromWorker(name: string, message: string): Error {
  if (name === 'AbortError') {
    if (typeof DOMException !== 'undefined') {
      return new DOMException(message, 'AbortError');
    }
    const err = new Error(message);
    err.name = 'AbortError';
    return err;
  }
  const err = new Error(message);
  err.name = name || 'Error';
  return err;
}

function resolveDefaultWasmBasePath(): string {
  const baseUrl =
    typeof import.meta !== 'undefined' && typeof import.meta.env?.BASE_URL === 'string'
      ? import.meta.env.BASE_URL
      : './';
  const normalizedBase = baseUrl.endsWith('/') ? baseUrl : `${baseUrl}/`;
  const relative = `${normalizedBase}runtime/`;
  if (typeof globalThis.location?.href === 'string') {
    try {
      return new URL(relative, globalThis.location.href).href;
    } catch {
      return relative;
    }
  }
  return relative;
}

function concatenateAudioChunks(chunks: readonly SynthesizedAudioChunk[]): Float32Array {
  let totalLength = 0;
  for (const chunk of chunks) {
    totalLength += chunk.samples.length;
  }
  const combined = new Float32Array(totalLength);
  let offset = 0;
  for (const chunk of chunks) {
    combined.set(chunk.samples, offset);
    offset += chunk.samples.length;
  }
  return combined;
}

/**
 * Engine C: Kyutai Pocket TTS ONNX (6-layer INT8 + FP32 text conditioner).
 * Runs all ONNX Runtime Web WASM inference inside `src/workers/pocket.worker.ts`.
 */
export class PocketTtsEngine implements VoiceCloningEngine {
  readonly id = POCKET_ENGINE_ID;
  readonly name = POCKET_ENGINE_NAME;
  readonly description =
    'Fast CPU/WASM zero-shot voice cloning engine (~146 MB INT8 bundle) with streaming Mimi codec decoding.';
  readonly version = POCKET_ENGINE_VERSION;
  readonly precision: EnginePrecision = 'int8';
  readonly capabilities: EngineCapabilities = {
    supportsVoiceCloning: true,
    supportsStreaming: true,
    supportsWebGpu: false,
    supportsWasm: true,
    requiresReferenceTranscript: false,
    supportsEmotionTags: false,
    minReferenceDurationSec: POCKET_RECOMMENDED_MIN_REF_SEC,
    maxReferenceDurationSec: POCKET_RECOMMENDED_MAX_REF_SEC,
    nativeSampleRate: POCKET_SAMPLE_RATE,
  };

  private readonly manifestEntry: ModelManifestEntry;
  private readonly customModelBaseUrl?: string;
  private readonly workerFactory: () => Worker;
  private modelRevision: string;
  private worker: Worker | null = null;
  private nextRequestId = 1;
  private readonly pending = new Map<number, PendingRpc>();
  private initialized = false;
  private activeBackend: EngineBackend | null = null;
  private readonly loadedHandles = new Map<string, LoadedVoiceHandle>();

  constructor(options: PocketTtsEngineOptions = {}) {
    this.manifestEntry = options.manifestEntry ?? POCKET_MODEL_MANIFEST_ENTRY;
    this.modelRevision = this.manifestEntry.revision || POCKET_MODEL_REVISION;
    this.customModelBaseUrl = options.customModelBaseUrl;
    this.workerFactory =
      options.workerFactory ??
      (() =>
        new Worker(new URL('../../workers/pocket.worker.ts', import.meta.url), {
          type: 'module',
        }));
  }

  async checkHardwareCompatibility(): Promise<HardwareCompatibilityReport> {
    const caps = await detectHardwareCapabilities();
    return buildEngineCompatibilityReport(this.id, caps, {
      supportsWasm: true,
      supportsWebGpu: false,
      minEstimatedMemoryMb: this.manifestEntry.estimatedMemoryMb || 550,
    });
  }

  private ensureWorker(): Worker {
    if (this.worker) {
      return this.worker;
    }
    const worker = this.workerFactory();
    worker.addEventListener('message', (event: MessageEvent<PocketWorkerResponse>) => {
      this.handleWorkerMessage(event.data);
    });
    worker.addEventListener('error', (event: ErrorEvent) => {
      const err = new Error(event.message || 'Pocket TTS worker error.');
      for (const [id, rpc] of this.pending.entries()) {
        this.pending.delete(id);
        rpc.reject(err);
      }
    });
    this.worker = worker;
    return worker;
  }

  private handleWorkerMessage(msg: PocketWorkerResponse): void {
    if (msg.id === null) {
      return;
    }
    const rpc = this.pending.get(msg.id);
    if (!rpc) {
      return;
    }

    switch (msg.type) {
      case 'progress':
        rpc.onProgress?.(msg.progress);
        break;
      case 'synth-chunk':
        rpc.chunks?.push(msg.chunk);
        rpc.onChunk?.(msg.chunk);
        break;
      case 'init-done':
      case 'encode-voice-done':
      case 'load-voice-done':
      case 'unload-voice-done':
      case 'synth-done':
      case 'dispose-done':
        this.pending.delete(msg.id);
        rpc.resolve(msg);
        break;
      case 'error':
        this.pending.delete(msg.id);
        rpc.reject(createErrorFromWorker(msg.name, msg.message));
        break;
    }
  }

  private callWorker<TRes extends PocketWorkerResponse>(
    requestBuilder: (id: number) => PocketWorkerRequest,
    options: {
      transfer?: Transferable[];
      onProgress?: (progress: EngineLoadProgress) => void;
      onChunk?: (chunk: SynthesizedAudioChunk) => void;
      chunks?: SynthesizedAudioChunk[];
      signal?: AbortSignal;
    } = {}
  ): Promise<TRes> {
    if (options.signal?.aborted) {
      return Promise.reject(createErrorFromWorker('AbortError', 'Operation aborted'));
    }

    const worker = this.ensureWorker();
    const id = this.nextRequestId++;
    const payload = requestBuilder(id);

    return new Promise<TRes>((resolve, reject) => {
      const cleanupSignal = () => {
        if (options.signal && onAbort) {
          options.signal.removeEventListener('abort', onAbort);
        }
      };

      const onAbort = options.signal
        ? () => {
            void this.cancel();
            cleanupSignal();
            const pending = this.pending.get(id);
            if (pending) {
              this.pending.delete(id);
              reject(createErrorFromWorker('AbortError', 'Operation aborted'));
            }
          }
        : null;

      if (options.signal && onAbort) {
        options.signal.addEventListener('abort', onAbort, { once: true });
      }

      this.pending.set(id, {
        resolve: (value) => {
          cleanupSignal();
          resolve(value as TRes);
        },
        reject: (reason) => {
          cleanupSignal();
          reject(reason);
        },
        onProgress: options.onProgress,
        onChunk: options.onChunk,
        chunks: options.chunks,
      });

      if (options.transfer && options.transfer.length > 0) {
        worker.postMessage(payload, options.transfer);
      } else {
        worker.postMessage(payload);
      }
    });
  }

  async initialize(
    options: EngineInitOptions,
    onProgress?: (progress: EngineLoadProgress) => void
  ): Promise<void> {
    if (options.modelRevision && options.modelRevision !== this.modelRevision) {
      throw new Error(
        `Pocket TTS pinned revision mismatch: expected '${this.modelRevision}', received '${options.modelRevision}'.`
      );
    }

    const wasmBasePath = options.wasmBasePath ?? resolveDefaultWasmBasePath();
    this.initialized = false;
    this.activeBackend = null;
    this.loadedHandles.clear();

    const res = await this.callWorker<Extract<PocketWorkerResponse, { type: 'init-done' }>>(
      (id) => ({
        type: 'init',
        id,
        wasmBasePath,
        wasmThreads: options.wasmThreads,
        modelRevision: this.modelRevision,
        manifestEntry: this.manifestEntry,
        customBaseUrl: this.customModelBaseUrl,
      }),
      {
        onProgress,
        signal: options.signal,
      }
    );

    this.modelRevision = res.modelRevision;
    this.initialized = true;
    this.activeBackend = 'wasm';
  }

  async encodeVoice(
    audio: AudioBufferData,
    metadata: ReferenceClipMetadata
  ): Promise<VoiceConditioningPayload> {
    if (!this.initialized) {
      throw new Error('Pocket TTS engine must be initialized before encoding a voice.');
    }

    const preprocessed = preprocessReferenceAudio(audio, POCKET_MAX_REFERENCE_SEC);
    const samplesCopy = new Float32Array(preprocessed.samples);

    const res = await this.callWorker<
      Extract<PocketWorkerResponse, { type: 'encode-voice-done' }>
    >(
      (id) => ({
        type: 'encode-voice',
        id,
        samples: samplesCopy,
        clipId: metadata.clipId,
        durationSec: preprocessed.durationSec,
        truncated: preprocessed.truncated,
      }),
      {
        transfer: [samplesCopy.buffer],
      }
    );

    return {
      engineId: this.id,
      modelRevision: this.modelRevision,
      payloadVersion: POCKET_PAYLOAD_VERSION,
      precision: this.precision,
      tensors: res.tensors,
      createdAt: new Date().toISOString(),
      metadata: {
        ...res.metadata,
        warningCount: preprocessed.warnings.length,
      },
    };
  }

  async loadVoiceProfile(profile: VoiceProfile): Promise<LoadedVoiceHandle> {
    const expectedKey = `${this.id}::${this.modelRevision}`;
    const payload = profile.conditioningPayloads[expectedKey];

    if (!payload) {
      const available = Object.keys(profile.conditioningPayloads);
      throw new Error(
        `Voice profile '${profile.name}' (${profile.id}) lacks conditioning payload for '${expectedKey}'` +
          (available.length > 0 ? ` (found: ${available.join(', ')})` : '') +
          '. Re-encode the reference clip for Pocket TTS.'
      );
    }

    if (payload.engineId !== this.id) {
      throw new Error(
        `Voice conditioning engine mismatch: expected '${this.id}', got '${payload.engineId}'.`
      );
    }

    if (payload.modelRevision !== this.modelRevision) {
      throw new Error(
        `Voice conditioning revision mismatch: expected '${this.modelRevision}', got '${payload.modelRevision}'.`
      );
    }

    if (payload.payloadVersion !== POCKET_PAYLOAD_VERSION) {
      throw new Error(
        `Unsupported Pocket TTS payload version '${payload.payloadVersion}' (expected ${POCKET_PAYLOAD_VERSION}).`
      );
    }

    for (const key of REQUIRED_STATE_KEYS) {
      if (!payload.tensors[key]) {
        throw new Error(
          `Voice conditioning payload for '${profile.name}' is missing required tensor '${key}'.`
        );
      }
    }

    if (!this.initialized) {
      throw new Error('Pocket TTS engine must be initialized before loading a voice profile.');
    }

    const handleId = `${profile.id}::${this.modelRevision}::${crypto.randomUUID?.() ?? Date.now()}`;
    const clonedTensors: Record<string, SerializedTensorData> = {};
    const transfer: Transferable[] = [];

    for (const key of REQUIRED_STATE_KEYS) {
      const src = payload.tensors[key];
      const bufferCopy = src.data.slice(0);
      clonedTensors[key] = {
        dtype: src.dtype,
        dims: [...src.dims],
        data: bufferCopy,
      };
      transfer.push(bufferCopy);
    }

    await this.callWorker<Extract<PocketWorkerResponse, { type: 'load-voice-done' }>>(
      (id) => ({
        type: 'load-voice',
        id,
        handleId,
        tensors: clonedTensors,
      }),
      { transfer }
    );

    const handle: LoadedVoiceHandle = {
      profileId: profile.id,
      engineId: this.id,
      modelRevision: this.modelRevision,
      handleId,
    };
    this.loadedHandles.set(handleId, handle);
    return handle;
  }

  async synthesize(
    request: SynthesisRequest,
    onChunk?: (chunk: SynthesizedAudioChunk) => void
  ): Promise<SynthesisResult> {
    if (!this.initialized) {
      throw new Error('Pocket TTS engine must be initialized before synthesizing.');
    }

    if (
      request.voiceHandle.engineId !== this.id ||
      request.voiceHandle.modelRevision !== this.modelRevision
    ) {
      throw new Error(
        `LoadedVoiceHandle '${request.voiceHandle.handleId}' is scoped to '${request.voiceHandle.engineId}::${request.voiceHandle.modelRevision}', incompatible with '${this.id}::${this.modelRevision}'.`
      );
    }

    if (!this.loadedHandles.has(request.voiceHandle.handleId)) {
      throw new Error(
        `Voice handle '${request.voiceHandle.handleId}' is not currently loaded.`
      );
    }

    const params = request.parameters ?? {};
    const temperature =
      typeof params.temperature === 'number' && Number.isFinite(params.temperature)
        ? Math.max(0.1, Math.min(1.2, params.temperature))
        : 0.7;
    const lsdSteps =
      typeof params.lsdSteps === 'number' && Number.isFinite(params.lsdSteps)
        ? Math.max(1, Math.min(8, Math.round(params.lsdSteps)))
        : 1;
    const framesAfterEos =
      typeof params.framesAfterEos === 'number' && Number.isFinite(params.framesAfterEos)
        ? Math.max(1, Math.min(5, Math.round(params.framesAfterEos)))
        : 2;
    const seed =
      typeof params.seed === 'number' && Number.isFinite(params.seed) && params.seed >= 0
        ? Math.floor(params.seed)
        : undefined;

    const collectedChunks: SynthesizedAudioChunk[] = [];
    const res = await this.callWorker<Extract<PocketWorkerResponse, { type: 'synth-done' }>>(
      (id) => ({
        type: 'synthesize',
        id,
        handleId: request.voiceHandle.handleId,
        text: request.text,
        temperature,
        lsdSteps,
        framesAfterEos,
        seed,
      }),
      {
        chunks: collectedChunks,
        onChunk,
        signal: request.signal,
      }
    );

    const samples = concatenateAudioChunks(collectedChunks);
    const durationSec = samples.length / POCKET_SAMPLE_RATE;
    const realTimeFactor =
      durationSec > 0 ? res.generationTimeMs / 1000 / durationSec : 0;

    return {
      audio: {
        samples,
        sampleRate: POCKET_SAMPLE_RATE,
        channels: 1,
        durationSec,
      },
      generationTimeMs: res.generationTimeMs,
      realTimeFactor,
      backend: 'wasm',
    };
  }

  cancel(): void {
    if (this.worker) {
      const msg: PocketWorkerRequest = { type: 'cancel' };
      this.worker.postMessage(msg);
    }
  }

  async dispose(): Promise<void> {
    this.initialized = false;
    this.activeBackend = null;
    this.loadedHandles.clear();

    if (this.worker) {
      try {
        await this.callWorker<Extract<PocketWorkerResponse, { type: 'dispose-done' }>>((id) => ({
          type: 'dispose',
          id,
        }));
      } catch {
        // Ignore dispose RPC errors during shutdown.
      }
      this.worker.terminate();
      this.worker = null;
    }

    for (const [id, rpc] of this.pending.entries()) {
      this.pending.delete(id);
      rpc.reject(createErrorFromWorker('AbortError', 'Engine disposed'));
    }
  }

  getSupportedLanguages(): readonly SupportedLanguage[] {
    return [{ code: 'en', name: 'English', nativeName: 'English' }];
  }

  getGenerationParameters(): readonly GenerationParameterSpec[] {
    return [
      {
        key: 'temperature',
        label: 'Temperature',
        description: 'Sampling variance for flow matching noise (lower is steadier, higher is more expressive).',
        type: 'number',
        defaultValue: 0.7,
        min: 0.1,
        max: 1.2,
        step: 0.05,
      },
      {
        key: 'lsdSteps',
        label: 'Flow Steps (LSD)',
        description: 'Number of Euler integration steps per audio frame (higher can refine detail).',
        type: 'number',
        defaultValue: 1,
        min: 1,
        max: 8,
        step: 1,
      },
      {
        key: 'framesAfterEos',
        label: 'Tail Frames After EOS',
        description: 'Extra 80ms frames generated after end-of-speech detection.',
        type: 'number',
        defaultValue: 2,
        min: 1,
        max: 5,
        step: 1,
      },
      {
        key: 'seed',
        label: 'Random Seed',
        description: 'Optional non-negative integer seed for reproducible takes (-1 for random).',
        type: 'number',
        defaultValue: -1,
        min: -1,
        max: 2_147_483_647,
        step: 1,
      },
    ];
  }

  getModelMetadata(): EngineModelMetadata {
    return {
      engineId: this.id,
      modelName: this.name,
      repoId: this.manifestEntry.repoId || POCKET_REPO_ID,
      modelRevision: this.modelRevision,
      license: this.manifestEntry.license || 'CC-BY-4.0',
      nativeSampleRate: POCKET_SAMPLE_RATE,
      precision: this.precision,
      totalSizeBytes: this.manifestEntry.totalSizeBytes || POCKET_TOTAL_SIZE_BYTES,
      isInitialized: this.initialized,
      activeBackend: this.activeBackend,
    };
  }
}
