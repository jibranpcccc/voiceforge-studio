/**
 * Engine A: Chatterbox ONNX (`onnx-community/chatterbox-ONNX`, MIT)
 *
 * Implements `VoiceCloningEngine` using `onnxruntime-web` with:
 * - Pre-flight WebGPU `shader-f16` detection (`q4f16` vs `q4` fallback, plus WASM warning)
 * - 300,000 ms WebGPU shader compilation timeout
 * - Cache Storage (`voiceforge-models-v1`) artifact loading + `externalData` binding
 * - Real zero-shot voice conditioning (`speech_encoder.onnx`) with strict engine/revision scoping
 * - Exact `EnTokenizer` + `embed_tokens.onnx` + 30-layer KV-cache `language_model` + `conditional_decoder`
 * - Explicit GPU tensor disposal on every step & AbortSignal/cancel support
 */

import * as ort from 'onnxruntime-web';
import { getCachedArtifact, downloadAndCacheModel } from '../../storage/modelCache';
import {
  detectHardwareCapabilities,
  type HardwareCapabilities,
} from '../../services/hardware';
import type {
  AudioBufferData,
  EngineBackend,
  EngineCapabilities,
  EngineInitOptions,
  EngineLoadProgress,
  EngineModelMetadata,
  EnginePrecision,
  ExecutionMode,
  GenerationParameterSpec,
  HardwareCompatibilityReport,
  LoadedVoiceHandle,
  ModelArtifact,
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
  EngineConditioningMismatchError,
  assertCompatibleConditioningPayload,
  validateVoiceHandleForEngine,
} from '../registry';
import {
  EnTokenizer,
  SILENCE_TOKEN,
  START_SPEECH_TOKEN,
  STOP_SPEECH_TOKEN,
  calculateTokenBudget,
  computeChatterboxPositionIds,
  normalizeChatterboxText,
} from './tokenizer';

export const CHATTERBOX_ENGINE_ID = 'chatterbox';
export const CHATTERBOX_MODEL_NAME = 'Chatterbox ONNX (English)';
export const CHATTERBOX_REPO_ID = 'onnx-community/chatterbox-ONNX';
export const CHATTERBOX_MODEL_REVISION = '3cab09af388d3f02bba43443fce88c1f4525ac43';
export const CHATTERBOX_LICENSE = 'MIT';
export const CHATTERBOX_LICENSE_URL = `https://huggingface.co/${CHATTERBOX_REPO_ID}/blob/${CHATTERBOX_MODEL_REVISION}/README.md`;

export const CHATTERBOX_SAMPLE_RATE = 24_000;
export const CHATTERBOX_S3_SAMPLE_RATE = 16_000;
export const CHATTERBOX_ENC_COND_SEC = 6;
export const CHATTERBOX_DEC_COND_SEC = 10;
export const CHATTERBOX_MAX_REFERENCE_SAMPLES = CHATTERBOX_DEC_COND_SEC * CHATTERBOX_SAMPLE_RATE;

export const CHATTERBOX_SESSION_COMPILE_TIMEOUT_MS = 300_000;
export const CHATTERBOX_LM_NUM_LAYERS = 30;
export const CHATTERBOX_LM_NUM_KV_HEADS = 16;
export const CHATTERBOX_LM_HEAD_DIM = 64;
export const CHATTERBOX_LM_VOCAB_SIZE = 8194;
export const CHATTERBOX_HIDDEN_SIZE = 1024;
export const CHATTERBOX_SILENCE_PAD_COUNT = 3;

export const CHATTERBOX_WASM_SLOW_WARNING =
  'Chatterbox WASM CPU fallback is ~5.8x slower than real-time; WebGPU is strongly recommended.';

/**
 * Engine B (`ResembleAI/chatterbox-turbo-ONNX`, commit `d21799bd0354adb85e348b8a0442a8405110a2cf`)
 * evaluation status: intentionally NOT enabled in Wave 1.
 *
 * Verified blockers requiring Wave 2 live browser WebGPU PoC before creating `src/engines/chatterbox-turbo/`:
 * 1. All quantized subgraphs (`q4f16`, `q4`, `q8`) emit `com.microsoft:GatherBlockQuantized`,
 *    which ORT Web's WASM EP lacks (zero CPU fallback).
 * 2. Requires live browser WebGPU verification of `GatherBlockQuantized` + 24-layer GPT2 LM (`position_ids`)
 *    + 1-step MeanFlow `conditional_decoder` (`122` `MultiHeadAttention` ops) without driver/VRAM crashes.
 */
export const CHATTERBOX_TURBO_EVALUATION_STATUS = {
  enabled: false,
  repoId: 'ResembleAI/chatterbox-turbo-ONNX',
  revision: 'd21799bd0354adb85e348b8a0442a8405110a2cf',
  blockers: [
    'Quantized graphs emit com.microsoft:GatherBlockQuantized which has no ORT Web WASM EP implementation.',
    'Untested in live browser WebGPU against real hardware; pending Wave 2 browser PoC before enabling.',
  ],
} as const;

export type ChatterboxLmPrecision = 'q4f16' | 'q4';
export type ChatterboxKvCacheDtype = 'float16' | 'float32';

export interface ChatterboxRuntimePlan {
  backend: EngineBackend;
  precision: ChatterboxLmPrecision;
  kvCacheDtype: ChatterboxKvCacheDtype;
  warnings: string[];
}

export interface ChatterboxHardwareProbe {
  webgpuSupported: boolean;
  webgpuAdapterAvailable?: boolean;
  shaderF16Supported: boolean;
}

const HF_RESOLVE_BASE = `https://huggingface.co/${CHATTERBOX_REPO_ID}/resolve/${CHATTERBOX_MODEL_REVISION}`;

function hfArtifact(
  role: string,
  relativePath: string,
  sizeBytes: number,
  sha256: string,
  format: ModelArtifact['format'],
  required = true
): ModelArtifact {
  return {
    role,
    relativePath,
    url: `${HF_RESOLVE_BASE}/${relativePath}`,
    sizeBytes,
    sha256,
    format,
    required,
  };
}

const SHARED_CHATTERBOX_ARTIFACTS: readonly ModelArtifact[] = [
  hfArtifact(
    'config',
    'config.json',
    1097,
    'a7d8518edd1cf6346e4d2be33201747ea4c476718db756f42e6959e4828f4955',
    'json'
  ),
  hfArtifact(
    'generation_config',
    'generation_config.json',
    93,
    '1b6fbb953861089ebe7da64df46eeef570d53f47a44b7cc1b4d543669fc9cd50',
    'json'
  ),
  hfArtifact(
    'preprocessor_config',
    'preprocessor_config.json',
    130,
    '1c320b2eea5f45678d17d891d51c38467775091dbf26a074635ba5e98ede5950',
    'json'
  ),
  hfArtifact(
    'tokenizer',
    'tokenizer.json',
    28543,
    'ecddf6aaae85e271610a2743409f7e447886957d0b0836687c1eaec5ccac2891',
    'json'
  ),
  hfArtifact(
    'tokenizer_config',
    'tokenizer_config.json',
    244,
    'b35967f93e30313d05fc9d520721ca9f671aaa5b3edbb03059aed3ff68b4c4c0',
    'json'
  ),
  hfArtifact(
    'speech_encoder',
    'onnx/speech_encoder.onnx',
    1_184_608,
    '8f1c8a0f89b77bf9cd5dd8f2e034eb2c79dc00fe70d41196b28c257643b00ccb',
    'onnx'
  ),
  hfArtifact(
    'speech_encoder_data',
    'onnx/speech_encoder.onnx_data',
    591_274_880,
    '04431dcef6325c54b02de2219845888b464bcd1f1ac2f8839c2fecd1ed2ef294',
    'onnx_data'
  ),
  hfArtifact(
    'embed_tokens',
    'onnx/embed_tokens.onnx',
    13_286,
    '160722ec14789f616abdb1e31916cbbf9223c03fde0ab546d64ca74fb72e430b',
    'onnx'
  ),
  hfArtifact(
    'embed_tokens_data',
    'onnx/embed_tokens.onnx_data',
    61_640_704,
    '898c563c3a5ca1b9ea10ce89b0cdcf252b0bb5ab460dfc4eadea003b56e5d2ee',
    'onnx_data'
  ),
  hfArtifact(
    'conditional_decoder',
    'onnx/conditional_decoder.onnx',
    6_350_448,
    '1656d0d31332bae1854839959a3139300ebb67c178651dfa3f8c5fbfa5351351',
    'onnx'
  ),
  hfArtifact(
    'conditional_decoder_data',
    'onnx/conditional_decoder.onnx_data',
    533_970_816,
    '51d58345a272747665ec9d5bb61e01835258a940e321a288582ac4c18cf01b5a',
    'onnx_data'
  ),
];

const LM_ARTIFACTS_BY_PRECISION: Record<ChatterboxLmPrecision, readonly ModelArtifact[]> = {
  q4f16: [
    hfArtifact(
      'language_model',
      'onnx/language_model_q4f16.onnx',
      229_388,
      '3b78e9235be5e2e2a811e482399155cb30415f6d87c98c21d12bf48843fc928f',
      'onnx'
    ),
    hfArtifact(
      'language_model_data',
      'onnx/language_model_q4f16.onnx_data',
      304_737_408,
      '2480da95471e4cd41a6b1876686e65e8a594c82459f2e5d6fd7592a5bad4e6da',
      'onnx_data'
    ),
  ],
  q4: [
    hfArtifact(
      'language_model',
      'onnx/language_model_q4.onnx',
      227_911,
      '7f8cdca83b2493536cbf3acf421199808a3d68736f55f4eabd20ef8a99da4313',
      'onnx'
    ),
    hfArtifact(
      'language_model_data',
      'onnx/language_model_q4.onnx_data',
      353_621_248,
      '5203d1e83c159316f9923c5c83759f6a34f87be1322ce4ad0facd9fc4aef4790',
      'onnx_data'
    ),
  ],
};

/**
 * Build the pinned `ModelManifestEntry` for Chatterbox ONNX (`q4f16` or `q4`).
 */
export function getChatterboxManifestEntry(
  precision: ChatterboxLmPrecision = 'q4f16'
): ModelManifestEntry {
  const artifacts: ModelArtifact[] = [
    ...SHARED_CHATTERBOX_ARTIFACTS,
    ...LM_ARTIFACTS_BY_PRECISION[precision],
  ];
  const totalSizeBytes = artifacts.reduce((sum, item) => sum + item.sizeBytes, 0);

  return {
    engineId: CHATTERBOX_ENGINE_ID,
    displayName:
      precision === 'q4f16'
        ? 'Chatterbox ONNX (WebGPU q4f16)'
        : 'Chatterbox ONNX (q4 / float32 KV)',
    repoId: CHATTERBOX_REPO_ID,
    revision: CHATTERBOX_MODEL_REVISION,
    license: CHATTERBOX_LICENSE,
    licenseUrl: CHATTERBOX_LICENSE_URL,
    ungated: true,
    precision,
    sampleRate: CHATTERBOX_SAMPLE_RATE,
    recommendedExecutionMode: precision === 'q4f16' ? 'quality' : 'balanced',
    estimatedMemoryMb: precision === 'q4f16' ? 2400 : 2600,
    totalSizeBytes,
    artifacts,
    notes: [
      'Uses onnx-community/chatterbox-ONNX pinned at commit 3cab09af388d3f02bba43443fce88c1f4525ac43.',
      precision === 'q4f16'
        ? 'Requires WebGPU adapter with shader-f16 (float16 KV cache).'
        : 'Uses q4 language_model with float32 KV cache for WebGPU without shader-f16 or WASM fallback.',
      'WASM CPU fallback runs ~5.8x slower than real-time; WebGPU is strongly recommended.',
    ],
  };
}

/**
 * Select backend (`webgpu` vs `wasm`), language model precision (`q4f16` vs `q4`),
 * and KV cache dtype (`float16` vs `float32`) BEFORE loading model weights.
 */
export function selectChatterboxRuntimePlan(
  hardware: ChatterboxHardwareProbe,
  options: { executionMode?: ExecutionMode; preferredBackend?: EngineBackend } = {}
): ChatterboxRuntimePlan {
  const warnings: string[] = [];
  const webgpuUsable =
    hardware.webgpuSupported && hardware.webgpuAdapterAvailable !== false;

  const forceCpu =
    options.preferredBackend === 'wasm' || options.executionMode === 'cpu';

  if (options.preferredBackend === 'webgpu' && !webgpuUsable) {
    throw new Error(
      'WebGPU backend was explicitly requested, but no WebGPU adapter is available.'
    );
  }

  if (!forceCpu && webgpuUsable) {
    if (hardware.shaderF16Supported) {
      return {
        backend: 'webgpu',
        precision: 'q4f16',
        kvCacheDtype: 'float16',
        warnings,
      };
    }
    warnings.push(
      'WebGPU adapter does not support shader-f16; selecting q4 (float32 KV cache) instead of q4f16.'
    );
    return {
      backend: 'webgpu',
      precision: 'q4',
      kvCacheDtype: 'float32',
      warnings,
    };
  }

  warnings.push(CHATTERBOX_WASM_SLOW_WARNING);
  return {
    backend: 'wasm',
    precision: 'q4',
    kvCacheDtype: 'float32',
    warnings,
  };
}

export function getDefaultWasmBasePath(): string {
  const baseUrl =
    typeof import.meta !== 'undefined' &&
    typeof import.meta.env?.BASE_URL === 'string'
      ? import.meta.env.BASE_URL
      : './';
  const normalized = baseUrl.endsWith('/') ? baseUrl : `${baseUrl}/`;
  return `${normalized}runtime/`;
}

function createAbortError(message = 'Operation aborted'): Error {
  if (typeof DOMException !== 'undefined') {
    return new DOMException(message, 'AbortError');
  }
  const err = new Error(message);
  err.name = 'AbortError';
  return err;
}

function throwIfAborted(signal?: AbortSignal, cancelled?: boolean): void {
  if (cancelled || signal?.aborted) {
    throw createAbortError();
  }
}

function linkAbortSignals(
  primary: AbortSignal | undefined,
  secondary: AbortSignal
): { signal: AbortSignal; cleanup: () => void } {
  if (!primary) {
    return { signal: secondary, cleanup: () => undefined };
  }
  const controller = new AbortController();
  const forward = () => {
    if (!controller.signal.aborted) {
      controller.abort();
    }
  };
  if (primary.aborted || secondary.aborted) {
    controller.abort();
    return { signal: controller.signal, cleanup: () => undefined };
  }
  primary.addEventListener('abort', forward, { once: true });
  secondary.addEventListener('abort', forward, { once: true });
  return {
    signal: controller.signal,
    cleanup: () => {
      primary.removeEventListener('abort', forward);
      secondary.removeEventListener('abort', forward);
    },
  };
}

/**
 * Downmix interleaved PCM to mono and resample linearly to 24,000 Hz,
 * capping to `CHATTERBOX_MAX_REFERENCE_SAMPLES` (10 seconds).
 */
export function prepareReferenceAudio24k(audio: AudioBufferData): Float32Array {
  if (!audio.samples || audio.samples.length === 0) {
    throw new Error('Reference audio buffer is empty.');
  }
  if (!Number.isFinite(audio.sampleRate) || audio.sampleRate <= 0) {
    throw new Error(`Invalid reference audio sampleRate: ${audio.sampleRate}`);
  }

  const channels = Math.max(1, Math.floor(audio.channels || 1));
  let mono: Float32Array;
  if (channels === 1) {
    mono = audio.samples;
  } else {
    const frames = Math.floor(audio.samples.length / channels);
    mono = new Float32Array(frames);
    for (let i = 0; i < frames; i += 1) {
      let sum = 0;
      const base = i * channels;
      for (let c = 0; c < channels; c += 1) {
        sum += audio.samples[base + c];
      }
      mono[i] = sum / channels;
    }
  }

  if (mono.length === 0) {
    throw new Error('Reference audio contains zero frames.');
  }

  let resampled: Float32Array;
  if (audio.sampleRate === CHATTERBOX_SAMPLE_RATE) {
    resampled = mono;
  } else {
    const ratio = audio.sampleRate / CHATTERBOX_SAMPLE_RATE;
    const outLength = Math.max(1, Math.round(mono.length / ratio));
    resampled = new Float32Array(outLength);
    for (let i = 0; i < outLength; i += 1) {
      const srcPos = i * ratio;
      const idx0 = Math.floor(srcPos);
      const idx1 = Math.min(idx0 + 1, mono.length - 1);
      const frac = srcPos - idx0;
      resampled[i] = mono[idx0] * (1 - frac) + mono[idx1] * frac;
    }
  }

  if (resampled.length > CHATTERBOX_MAX_REFERENCE_SAMPLES) {
    return resampled.slice(0, CHATTERBOX_MAX_REFERENCE_SAMPLES);
  }
  return resampled;
}

const REQUIRED_CONDITIONING_TENSORS: ReadonlyArray<{
  name: string;
  dtype: SerializedTensorData['dtype'];
  rank: number;
}> = [
  { name: 'audio_features', dtype: 'float32', rank: 3 },
  { name: 'audio_tokens', dtype: 'int64', rank: 2 },
  { name: 'speaker_embeddings', dtype: 'float32', rank: 2 },
  { name: 'speaker_features', dtype: 'float32', rank: 3 },
];

/**
 * Validate that a `VoiceConditioningPayload` strictly matches Chatterbox ONNX
 * (`engineId: 'chatterbox'`, pinned `modelRevision`) and carries all 4 required tensors.
 */
export function validateChatterboxConditioningPayload(
  payload: VoiceConditioningPayload
): void {
  if (
    payload.engineId !== CHATTERBOX_ENGINE_ID ||
    payload.modelRevision !== CHATTERBOX_MODEL_REVISION
  ) {
    throw new EngineConditioningMismatchError(
      `Conditioning payload '${payload.engineId}::${payload.modelRevision}' is incompatible with '${CHATTERBOX_ENGINE_ID}::${CHATTERBOX_MODEL_REVISION}'.`,
      CHATTERBOX_ENGINE_ID,
      CHATTERBOX_MODEL_REVISION
    );
  }

  for (const spec of REQUIRED_CONDITIONING_TENSORS) {
    const tensor = payload.tensors[spec.name];
    if (!tensor) {
      throw new Error(`Chatterbox conditioning payload is missing '${spec.name}'.`);
    }
    if (tensor.dtype !== spec.dtype) {
      throw new Error(
        `Chatterbox conditioning tensor '${spec.name}' has dtype '${tensor.dtype}', expected '${spec.dtype}'.`
      );
    }
    if (tensor.dims.length !== spec.rank) {
      throw new Error(
        `Chatterbox conditioning tensor '${spec.name}' has rank ${tensor.dims.length}, expected ${spec.rank}.`
      );
    }
  }
}

function clamp(value: number, min: number, max: number): number {
  return Math.min(max, Math.max(min, value));
}

function createMulberry32(seed: number): () => number {
  let state = seed >>> 0;
  return () => {
    state = (state + 0x6d2b79f5) >>> 0;
    let t = Math.imul(state ^ (state >>> 15), 1 | state);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

export interface ChatterboxSamplingOptions {
  temperature: number;
  repetitionPenalty: number;
  topP: number;
  topK?: number;
  rng?: () => number;
}

/**
 * Sample the next speech token from raw logits (`[vocabSize]`) using:
 * 1. Repetition penalty over prior tokens
 * 2. Suppression of invalid control tokens (`START_SPEECH_TOKEN` and `> STOP_SPEECH_TOKEN`)
 * 3. Temperature scaling
 * 4. Optional top-k and nucleus top-p filtering
 * 5. Categorical sampling
 */
export function sampleNextSpeechToken(
  rawLogits: Float32Array,
  historyTokens: readonly number[],
  options: ChatterboxSamplingOptions
): number {
  const vocabSize = rawLogits.length;
  const logits = new Float32Array(rawLogits);

  // 1. Repetition penalty
  if (options.repetitionPenalty !== 1.0 && historyTokens.length > 0) {
    const penalty = options.repetitionPenalty;
    const seen = new Set<number>(historyTokens);
    for (const tokenId of seen) {
      if (tokenId >= 0 && tokenId < vocabSize) {
        const score = logits[tokenId];
        logits[tokenId] = score < 0 ? score * penalty : score / penalty;
      }
    }
  }

  // 2. Prevent emitting START_SPEECH_TOKEN (6561) or non-speech vocab IDs (> 6562)
  if (START_SPEECH_TOKEN < vocabSize) {
    logits[START_SPEECH_TOKEN] = -Infinity;
  }
  for (let i = STOP_SPEECH_TOKEN + 1; i < vocabSize; i += 1) {
    logits[i] = -Infinity;
  }

  // 3. Temperature scaling
  const temp = Math.max(1e-4, options.temperature);
  if (temp !== 1.0) {
    for (let i = 0; i < vocabSize; i += 1) {
      if (Number.isFinite(logits[i])) {
        logits[i] /= temp;
      }
    }
  }

  // Build candidate indices (only finite logits)
  const candidates: Array<{ id: number; logit: number }> = [];
  for (let i = 0; i <= Math.min(STOP_SPEECH_TOKEN, vocabSize - 1); i += 1) {
    if (Number.isFinite(logits[i])) {
      candidates.push({ id: i, logit: logits[i] });
    }
  }
  if (candidates.length === 0) {
    return STOP_SPEECH_TOKEN;
  }

  candidates.sort((a, b) => b.logit - a.logit);

  // 4. Optional Top-K truncation
  let activeCount = candidates.length;
  if (options.topK && options.topK > 0 && options.topK < activeCount) {
    activeCount = options.topK;
  }

  // Softmax over top-k candidates
  const maxLogit = candidates[0].logit;
  const probs = new Float64Array(activeCount);
  let sumExp = 0;
  for (let i = 0; i < activeCount; i += 1) {
    const p = Math.exp(candidates[i].logit - maxLogit);
    probs[i] = p;
    sumExp += p;
  }
  if (sumExp <= 0 || !Number.isFinite(sumExp)) {
    return candidates[0].id;
  }
  for (let i = 0; i < activeCount; i += 1) {
    probs[i] /= sumExp;
  }

  // Nucleus (Top-P) truncation
  const topP = clamp(options.topP, 0.01, 1.0);
  let nucleusCount = activeCount;
  if (topP < 1.0) {
    let cumProb = 0;
    nucleusCount = 0;
    for (let i = 0; i < activeCount; i += 1) {
      cumProb += probs[i];
      nucleusCount += 1;
      if (cumProb >= topP) {
        break;
      }
    }
    nucleusCount = Math.max(1, nucleusCount);
  }

  let renormSum = 0;
  for (let i = 0; i < nucleusCount; i += 1) {
    renormSum += probs[i];
  }
  const rng = options.rng ?? Math.random;
  const target = rng() * renormSum;
  let running = 0;
  for (let i = 0; i < nucleusCount; i += 1) {
    running += probs[i];
    if (target <= running) {
      return candidates[i].id;
    }
  }
  return candidates[nucleusCount - 1].id;
}

export interface OrtTensorLike {
  readonly dims: readonly number[];
  readonly type: string;
  readonly data?: unknown;
  getData(releaseData?: boolean): Promise<unknown>;
  dispose(): void;
}

export interface OrtSessionLike {
  readonly inputNames: readonly string[];
  readonly outputNames: readonly string[];
  run(feeds: Record<string, unknown>): Promise<Record<string, OrtTensorLike>>;
  release(): Promise<void>;
}

export interface ChatterboxDependencies {
  /** Override hardware capability detection (primarily for testing). */
  detectHardware?: () => Promise<HardwareCapabilities>;
  /** Override model download/cache step (primarily for testing). */
  downloadModel?: (
    entry: ModelManifestEntry,
    options: {
      signal?: AbortSignal;
      onProgress?: (progress: {
        phase: 'checking' | 'downloading' | 'verifying' | 'ready';
        artifact: ModelArtifact;
        loadedBytes: number;
        totalBytes: number;
        fraction: number;
      }) => void;
    }
  ) => Promise<void>;
  /** Override reading a cached artifact buffer (primarily for testing). */
  readArtifact?: (
    engineId: string,
    revision: string,
    relativePath: string
  ) => Promise<ArrayBuffer | null>;
  /** Override ORT session creation (primarily for testing). */
  createSession?: (
    modelBytes: Uint8Array,
    options: ort.InferenceSession.SessionOptions
  ) => Promise<OrtSessionLike>;
  /** Override ORT tensor construction (primarily for testing). */
  createTensor?: (
    type: ort.Tensor.Type,
    data: Float32Array | BigInt64Array | Uint16Array,
    dims: readonly number[]
  ) => OrtTensorLike;
  /** Override session compilation timeout in ms (defaults to 300,000 ms). */
  compileTimeoutMs?: number;
}

async function withTimeoutAndAbort<T>(
  promise: Promise<T>,
  timeoutMs: number,
  label: string,
  signal?: AbortSignal
): Promise<T> {
  if (signal?.aborted) {
    throw createAbortError();
  }

  return await new Promise<T>((resolve, reject) => {
    let settled = false;
    const cleanup = () => {
      if (timer !== undefined) clearTimeout(timer);
      if (signal && onAbort) signal.removeEventListener('abort', onAbort);
    };

    const timer =
      timeoutMs > 0 && Number.isFinite(timeoutMs)
        ? setTimeout(() => {
            if (settled) return;
            settled = true;
            cleanup();
            reject(
              new Error(
                `Timed out after ${timeoutMs} ms while compiling/loading ${label}.`
              )
            );
          }, timeoutMs)
        : undefined;

    const onAbort = signal
      ? () => {
          if (settled) return;
          settled = true;
          cleanup();
          reject(createAbortError());
        }
      : undefined;

    if (signal && onAbort) {
      signal.addEventListener('abort', onAbort, { once: true });
    }

    promise.then(
      (value) => {
        if (settled) return;
        settled = true;
        cleanup();
        resolve(value);
      },
      (err: unknown) => {
        if (settled) return;
        settled = true;
        cleanup();
        reject(err);
      }
    );
  });
}

function serializeFloat32Tensor(
  dims: readonly number[],
  rawData: Float32Array
): SerializedTensorData {
  const copy = new Float32Array(rawData.length);
  copy.set(rawData);
  return {
    dtype: 'float32',
    dims: [...dims],
    data: copy.buffer,
  };
}

function serializeInt64Tensor(
  dims: readonly number[],
  rawData: BigInt64Array
): SerializedTensorData {
  const copy = new BigInt64Array(rawData.length);
  copy.set(rawData);
  return {
    dtype: 'int64',
    dims: [...dims],
    data: copy.buffer,
  };
}

function toFloat32Array(data: unknown): Float32Array {
  if (data instanceof Float32Array) {
    return data;
  }
  if (ArrayBuffer.isView(data)) {
    return new Float32Array(
      data.buffer,
      data.byteOffset,
      Math.floor(data.byteLength / Float32Array.BYTES_PER_ELEMENT)
    );
  }
  throw new Error('Expected Float32Array tensor output.');
}

function toBigInt64Array(data: unknown): BigInt64Array {
  if (data instanceof BigInt64Array) {
    return data;
  }
  if (ArrayBuffer.isView(data)) {
    return new BigInt64Array(
      data.buffer,
      data.byteOffset,
      Math.floor(data.byteLength / BigInt64Array.BYTES_PER_ELEMENT)
    );
  }
  throw new Error('Expected BigInt64Array tensor output.');
}

function safeDisposeTensor(tensor: OrtTensorLike | undefined | null): void {
  if (!tensor) return;
  try {
    tensor.dispose();
  } catch {
    // Ignore double-dispose errors.
  }
}

function defaultCreateTensor(
  type: ort.Tensor.Type,
  data: Float32Array | BigInt64Array | Uint16Array,
  dims: readonly number[]
): OrtTensorLike {
  return new ort.Tensor(type, data, dims) as unknown as OrtTensorLike;
}

function defaultCreateSession(
  modelBytes: Uint8Array,
  options: ort.InferenceSession.SessionOptions
): Promise<OrtSessionLike> {
  return ort.InferenceSession.create(
    modelBytes,
    options
  ) as unknown as Promise<OrtSessionLike>;
}

const SUPPORTED_LANGUAGES: readonly SupportedLanguage[] = [
  { code: 'en', name: 'English', nativeName: 'English' },
];

const GENERATION_PARAMETERS: readonly GenerationParameterSpec[] = [
  {
    key: 'exaggeration',
    label: 'Emotion Exaggeration',
    description: 'Controls emotional expressiveness and prosodic intensity (0.0–1.5).',
    type: 'number',
    defaultValue: 0.5,
    min: 0.0,
    max: 1.5,
    step: 0.05,
  },
  {
    key: 'temperature',
    label: 'Temperature',
    description: 'Sampling randomness for speech token generation (0.2–1.2).',
    type: 'number',
    defaultValue: 0.8,
    min: 0.2,
    max: 1.2,
    step: 0.05,
  },
  {
    key: 'repetitionPenalty',
    label: 'Repetition Penalty',
    description: 'Discourages repeating speech tokens and stuttering loops (1.0–1.6).',
    type: 'number',
    defaultValue: 1.2,
    min: 1.0,
    max: 1.6,
    step: 0.05,
  },
  {
    key: 'topP',
    label: 'Top-P (Nucleus)',
    description: 'Cumulative probability threshold for token sampling (0.5–1.0).',
    type: 'number',
    defaultValue: 0.95,
    min: 0.5,
    max: 1.0,
    step: 0.01,
  },
  {
    key: 'seed',
    label: 'Random Seed',
    description: 'Optional deterministic seed for reproducible synthesis.',
    type: 'number',
    defaultValue: 0,
    min: 0,
    max: 2_147_483_647,
    step: 1,
  },
];

const CHATTERBOX_CAPABILITIES: EngineCapabilities = {
  supportsVoiceCloning: true,
  supportsStreaming: true,
  supportsWebGpu: true,
  supportsWasm: true,
  requiresReferenceTranscript: false,
  supportsEmotionTags: true,
  minReferenceDurationSec: 3,
  maxReferenceDurationSec: 10,
  nativeSampleRate: CHATTERBOX_SAMPLE_RATE,
};

/**
 * Direct ONNX Runtime Web implementation of Chatterbox ONNX.
 * Instantiated inside `src/workers/chatterbox.worker.ts` (and directly in unit tests).
 */
export class ChatterboxCoreEngine implements VoiceCloningEngine {
  readonly id = CHATTERBOX_ENGINE_ID;
  readonly name = CHATTERBOX_MODEL_NAME;
  readonly description =
    'Resemble AI Chatterbox ONNX zero-shot English voice cloning with emotion exaggeration control (24 kHz).';
  readonly version = '1.0.0';
  readonly capabilities: EngineCapabilities = CHATTERBOX_CAPABILITIES;

  private activePrecision: ChatterboxLmPrecision = 'q4f16';
  private activeKvDtype: ChatterboxKvCacheDtype = 'float16';
  private activeBackend: EngineBackend | null = null;
  private isInitialized = false;
  private totalSizeBytes = getChatterboxManifestEntry('q4f16').totalSizeBytes;

  private speechEncoderSession: OrtSessionLike | null = null;
  private embedTokensSession: OrtSessionLike | null = null;
  private languageModelSession: OrtSessionLike | null = null;
  private conditionalDecoderSession: OrtSessionLike | null = null;

  private tokenizer: EnTokenizer = new EnTokenizer();
  private readonly loadedVoices = new Map<string, VoiceConditioningPayload>();
  private cancelled = false;
  private activeAbortController: AbortController | null = null;
  private readonly deps: ChatterboxDependencies;

  constructor(deps: ChatterboxDependencies = {}) {
    this.deps = deps;
  }

  get precision(): EnginePrecision {
    return this.activePrecision;
  }

  get kvCacheDtype(): ChatterboxKvCacheDtype {
    return this.activeKvDtype;
  }

  async checkHardwareCompatibility(): Promise<HardwareCompatibilityReport> {
    const detectHw = this.deps.detectHardware ?? detectHardwareCapabilities;
    const caps = await detectHw();
    const plan = selectChatterboxRuntimePlan(caps);

    const compatible =
      caps.wasmSupported || (caps.webgpuSupported && caps.webgpuAdapterAvailable);
    const blockers: string[] = [];
    if (!compatible) {
      blockers.push('Neither WebGPU nor WebAssembly is available in this environment.');
    }

    const warnings = [...caps.notes, ...plan.warnings];
    if (caps.estimatedDeviceMemoryMb !== null && caps.estimatedDeviceMemoryMb < 4096) {
      warnings.push(
        `Reported device memory (${caps.estimatedDeviceMemoryMb} MB) may be tight for Chatterbox (~1.50 GB weights + WebGPU/KV memory).`
      );
    }

    const recommendedExecutionMode: ExecutionMode =
      plan.backend === 'wasm'
        ? 'cpu'
        : plan.precision === 'q4f16'
          ? 'quality'
          : 'balanced';

    return {
      engineId: this.id,
      webgpuSupported: caps.webgpuSupported,
      shaderF16Supported: caps.shaderF16Supported,
      wasmSimdSupported: caps.wasmSimdSupported,
      wasmThreadsSupported: caps.wasmThreadsSupported,
      crossOriginIsolated: caps.crossOriginIsolated,
      estimatedDeviceMemoryMb: caps.estimatedDeviceMemoryMb,
      compatible,
      recommendedBackend: plan.backend,
      recommendedExecutionMode,
      blockers,
      warnings,
    };
  }

  async initialize(
    options: EngineInitOptions,
    onProgress?: (progress: EngineLoadProgress) => void
  ): Promise<void> {
    if (options.modelRevision && options.modelRevision !== CHATTERBOX_MODEL_REVISION) {
      throw new Error(
        `Unsupported Chatterbox model revision '${options.modelRevision}'. Expected pinned commit '${CHATTERBOX_MODEL_REVISION}'.`
      );
    }

    await this.releaseSessions();
    this.cancelled = false;
    const initController = new AbortController();
    this.activeAbortController = initController;
    const { signal: linkedSignal, cleanup: cleanupSignals } = linkAbortSignals(
      options.signal,
      initController.signal
    );

    try {
      throwIfAborted(linkedSignal, this.cancelled);

      onProgress?.({
        phase: 'checking',
        item: 'hardware',
        progress: 0,
        message: 'Inspecting WebGPU shader-f16 and WebAssembly capabilities...',
      });

      const detectHw = this.deps.detectHardware ?? detectHardwareCapabilities;
      const caps = await detectHw();
      let plan = selectChatterboxRuntimePlan(caps, {
        executionMode: options.executionMode,
        preferredBackend: options.preferredBackend,
      });

      this.configureOrtEnv(options, caps);

      const entry = getChatterboxManifestEntry(plan.precision);
      this.activePrecision = plan.precision;
      this.activeKvDtype = plan.kvCacheDtype;
      this.totalSizeBytes = entry.totalSizeBytes;

      for (const warning of plan.warnings) {
        onProgress?.({
          phase: 'checking',
          item: 'runtime-plan',
          progress: 0.05,
          message: warning,
        });
      }

      const downloadModel =
        this.deps.downloadModel ??
        ((manifestEntry, dlOpts) => downloadAndCacheModel(manifestEntry, dlOpts));
      await downloadModel(entry, {
        signal: linkedSignal,
        onProgress: (dlProgress) => {
          onProgress?.({
            phase:
              dlProgress.phase === 'ready'
                ? 'verifying'
                : dlProgress.phase,
            item: dlProgress.artifact.role,
            progress: dlProgress.fraction,
            loadedBytes: dlProgress.loadedBytes,
            totalBytes: dlProgress.totalBytes,
            message: `${dlProgress.phase === 'verifying' ? 'Verifying' : 'Downloading'} ${dlProgress.artifact.relativePath}`,
          });
        },
      });

      throwIfAborted(linkedSignal, this.cancelled);

      // Load tokenizer.json from cache when present (identical to built-in EnTokenizer)
      const readArtifact = this.deps.readArtifact ?? getCachedArtifact;
      const tokenizerBuf = await readArtifact(
        CHATTERBOX_ENGINE_ID,
        CHATTERBOX_MODEL_REVISION,
        'tokenizer.json'
      );
      if (tokenizerBuf) {
        this.tokenizer = EnTokenizer.fromJSON(new TextDecoder().decode(tokenizerBuf));
      } else {
        this.tokenizer = new EnTokenizer();
      }

      try {
        await this.createAllSessions(plan, entry, readArtifact, linkedSignal, onProgress);
      } catch (err) {
        // Fallback to WASM q4 only when WebGPU was NOT explicitly forced and wasn't aborted
        if (
          plan.backend === 'webgpu' &&
          options.preferredBackend !== 'webgpu' &&
          !linkedSignal.aborted &&
          !this.cancelled &&
          caps.wasmSupported
        ) {
          await this.releaseSessions();
          plan = selectChatterboxRuntimePlan(caps, {
            executionMode: 'cpu',
            preferredBackend: 'wasm',
          });
          const wasmEntry = getChatterboxManifestEntry(plan.precision);
          this.activePrecision = plan.precision;
          this.activeKvDtype = plan.kvCacheDtype;
          this.totalSizeBytes = wasmEntry.totalSizeBytes;

          onProgress?.({
            phase: 'checking',
            item: 'fallback',
            progress: 0.1,
            message: `WebGPU session initialization failed (${
              err instanceof Error ? err.message : String(err)
            }); falling back to WASM q4 (${CHATTERBOX_WASM_SLOW_WARNING}).`,
          });

          await downloadModel(wasmEntry, {
            signal: linkedSignal,
            onProgress: (dlProgress) => {
              onProgress?.({
                phase: dlProgress.phase === 'ready' ? 'verifying' : dlProgress.phase,
                item: dlProgress.artifact.role,
                progress: dlProgress.fraction,
                loadedBytes: dlProgress.loadedBytes,
                totalBytes: dlProgress.totalBytes,
                message: `Downloading ${dlProgress.artifact.relativePath}`,
              });
            },
          });

          await this.createAllSessions(
            plan,
            wasmEntry,
            readArtifact,
            linkedSignal,
            onProgress
          );
        } else {
          throw err;
        }
      }

      this.activeBackend = plan.backend;
      this.isInitialized = true;

      onProgress?.({
        phase: 'ready',
        item: 'chatterbox',
        progress: 1,
        message: `Chatterbox ONNX ready (${plan.backend}/${plan.precision}).`,
      });
    } catch (err) {
      await this.releaseSessions();
      throw err;
    } finally {
      cleanupSignals();
      if (this.activeAbortController === initController) {
        this.activeAbortController = null;
      }
    }
  }

  private configureOrtEnv(options: EngineInitOptions, caps: HardwareCapabilities): void {
    ort.env.wasm.wasmPaths = options.wasmBasePath ?? getDefaultWasmBasePath();
    ort.env.wasm.simd = true;

    const isCrossOriginIsolated =
      typeof globalThis.crossOriginIsolated === 'boolean'
        ? globalThis.crossOriginIsolated
        : caps.crossOriginIsolated;

    if (!isCrossOriginIsolated) {
      ort.env.wasm.numThreads = 1;
    } else {
      const requested = options.wasmThreads ?? caps.recommendedWasmThreads ?? 1;
      ort.env.wasm.numThreads = Math.min(Math.max(1, Math.floor(requested)), 4);
    }
  }

  private async createAllSessions(
    plan: ChatterboxRuntimePlan,
    entry: ModelManifestEntry,
    readArtifact: NonNullable<ChatterboxDependencies['readArtifact']>,
    signal: AbortSignal,
    onProgress?: (progress: EngineLoadProgress) => void
  ): Promise<void> {
    const createSession = this.deps.createSession ?? defaultCreateSession;
    const timeoutMs = this.deps.compileTimeoutMs ?? CHATTERBOX_SESSION_COMPILE_TIMEOUT_MS;

    const loadPair = async (
      onnxRole: string,
      dataRole: string,
      stepIndex: number
    ): Promise<OrtSessionLike> => {
      throwIfAborted(signal, this.cancelled);
      const onnxArt = entry.artifacts.find((a) => a.role === onnxRole);
      const dataArt = entry.artifacts.find((a) => a.role === dataRole);
      if (!onnxArt || !dataArt) {
        throw new Error(`Missing manifest artifacts for ${onnxRole}/${dataRole}`);
      }

      onProgress?.({
        phase: 'creating-session',
        item: onnxRole,
        progress: stepIndex / 4,
        message: `Compiling ${onnxRole} on ${plan.backend} (${plan.precision}); WebGPU shader compilation may take 35–120s...`,
      });

      const [onnxBuf, dataBuf] = await Promise.all([
        readArtifact(entry.engineId, entry.revision, onnxArt.relativePath),
        readArtifact(entry.engineId, entry.revision, dataArt.relativePath),
      ]);
      if (!onnxBuf || !dataBuf) {
        throw new Error(
          `Cached model bytes missing for ${onnxArt.relativePath} or ${dataArt.relativePath}`
        );
      }

      const dataFileName = dataArt.relativePath.split('/').pop() ?? dataArt.relativePath;
      const sessionOptions: ort.InferenceSession.SessionOptions = {
        executionProviders: [plan.backend],
        externalData: [
          {
            path: dataFileName,
            data: new Uint8Array(dataBuf),
          },
        ],
      };

      return await withTimeoutAndAbort(
        createSession(new Uint8Array(onnxBuf), sessionOptions),
        timeoutMs,
        `${onnxArt.relativePath} (${plan.backend})`,
        signal
      );
    };

    this.speechEncoderSession = await loadPair('speech_encoder', 'speech_encoder_data', 0);
    this.embedTokensSession = await loadPair('embed_tokens', 'embed_tokens_data', 1);
    this.languageModelSession = await loadPair('language_model', 'language_model_data', 2);
    this.conditionalDecoderSession = await loadPair(
      'conditional_decoder',
      'conditional_decoder_data',
      3
    );
  }

  async encodeVoice(
    audio: AudioBufferData,
    metadata: ReferenceClipMetadata
  ): Promise<VoiceConditioningPayload> {
    if (!this.isInitialized || !this.speechEncoderSession) {
      throw new Error('ChatterboxEngine must be initialized before encodeVoice().');
    }

    const mono24k = prepareReferenceAudio24k(audio);
    const makeTensor = this.deps.createTensor ?? defaultCreateTensor;
    const audioTensor = makeTensor('float32', mono24k, [1, mono24k.length]);

    let outputs: Record<string, OrtTensorLike> | null = null;
    try {
      outputs = await this.speechEncoderSession.run({ audio_values: audioTensor });

      const audioFeaturesTensor = outputs.audio_features;
      const audioTokensTensor = outputs.audio_tokens;
      const speakerEmbeddingsTensor = outputs.speaker_embeddings;
      const speakerFeaturesTensor = outputs.speaker_features;

      if (
        !audioFeaturesTensor ||
        !audioTokensTensor ||
        !speakerEmbeddingsTensor ||
        !speakerFeaturesTensor
      ) {
        throw new Error(
          'speech_encoder.onnx did not return all 4 expected conditioning outputs.'
        );
      }

      const [audioFeaturesData, audioTokensData, speakerEmbeddingsData, speakerFeaturesData] =
        await Promise.all([
          audioFeaturesTensor.getData(),
          audioTokensTensor.getData(),
          speakerEmbeddingsTensor.getData(),
          speakerFeaturesTensor.getData(),
        ]);

      return {
        engineId: CHATTERBOX_ENGINE_ID,
        modelRevision: CHATTERBOX_MODEL_REVISION,
        payloadVersion: 1,
        precision: this.activePrecision,
        tensors: {
          audio_features: serializeFloat32Tensor(
            audioFeaturesTensor.dims,
            toFloat32Array(audioFeaturesData)
          ),
          audio_tokens: serializeInt64Tensor(
            audioTokensTensor.dims,
            toBigInt64Array(audioTokensData)
          ),
          speaker_embeddings: serializeFloat32Tensor(
            speakerEmbeddingsTensor.dims,
            toFloat32Array(speakerEmbeddingsData)
          ),
          speaker_features: serializeFloat32Tensor(
            speakerFeaturesTensor.dims,
            toFloat32Array(speakerFeaturesData)
          ),
        },
        createdAt: new Date().toISOString(),
        metadata: {
          clipId: metadata.clipId,
          sourceSampleRate: audio.sampleRate,
          encodedSampleRate: CHATTERBOX_SAMPLE_RATE,
          encodedSamples: mono24k.length,
          encodedDurationSec: Number((mono24k.length / CHATTERBOX_SAMPLE_RATE).toFixed(3)),
        },
      };
    } finally {
      safeDisposeTensor(audioTensor);
      if (outputs) {
        for (const tensor of Object.values(outputs)) {
          safeDisposeTensor(tensor);
        }
      }
    }
  }

  async loadVoiceProfile(profile: VoiceProfile): Promise<LoadedVoiceHandle> {
    const payload = assertCompatibleConditioningPayload(profile, this);
    validateChatterboxConditioningPayload(payload);

    const handleId = `${profile.id}::${CHATTERBOX_ENGINE_ID}::${CHATTERBOX_MODEL_REVISION}`;
    this.loadedVoices.set(handleId, payload);

    return {
      profileId: profile.id,
      engineId: CHATTERBOX_ENGINE_ID,
      modelRevision: CHATTERBOX_MODEL_REVISION,
      handleId,
    };
  }

  async synthesize(
    request: SynthesisRequest,
    onChunk?: (chunk: SynthesizedAudioChunk) => void
  ): Promise<SynthesisResult> {
    if (
      !this.isInitialized ||
      !this.embedTokensSession ||
      !this.languageModelSession ||
      !this.conditionalDecoderSession
    ) {
      throw new Error('ChatterboxEngine must be initialized before synthesize().');
    }

    validateVoiceHandleForEngine(request.voiceHandle, this);
    const conditioning = this.loadedVoices.get(request.voiceHandle.handleId);
    if (!conditioning) {
      throw new Error(
        `Voice handle '${request.voiceHandle.handleId}' is not loaded in ChatterboxEngine.`
      );
    }

    this.cancelled = false;
    const synthController = new AbortController();
    this.activeAbortController = synthController;
    const { signal: linkedSignal, cleanup: cleanupSignals } = linkAbortSignals(
      request.signal,
      synthController.signal
    );

    const startTimeMs = performance.now();
    const makeTensor = this.deps.createTensor ?? defaultCreateTensor;

    const params = request.parameters ?? {};
    const exaggeration = clamp(
      typeof params.exaggeration === 'number' ? params.exaggeration : 0.5,
      0.0,
      1.5
    );
    const temperature = clamp(
      typeof params.temperature === 'number' ? params.temperature : 0.8,
      0.2,
      1.2
    );
    const repetitionPenalty = clamp(
      typeof params.repetitionPenalty === 'number' ? params.repetitionPenalty : 1.2,
      1.0,
      1.6
    );
    const topP = clamp(typeof params.topP === 'number' ? params.topP : 0.95, 0.5, 1.0);
    const topK =
      typeof params.topK === 'number' && Number.isInteger(params.topK) && params.topK > 0
        ? params.topK
        : undefined;
    const seed =
      typeof params.seed === 'number' && Number.isFinite(params.seed) && params.seed > 0
        ? Math.floor(params.seed)
        : undefined;
    const rng = seed !== undefined ? createMulberry32(seed) : Math.random;

    const normalizedText = normalizeChatterboxText(request.text);
    const inputIds = this.tokenizer.encode(normalizedText);
    const positionIds = computeChatterboxPositionIds(inputIds);

    const requestedMaxTokens =
      typeof params.maxNewTokens === 'number' &&
      Number.isInteger(params.maxNewTokens) &&
      params.maxNewTokens >= 1
        ? params.maxNewTokens
        : undefined;
    const maxNewTokens = requestedMaxTokens ?? calculateTokenBudget(normalizedText);

    const audioFeaturesSer = conditioning.tensors.audio_features;
    const audioTokensSer = conditioning.tensors.audio_tokens;
    const speakerEmbeddingsSer = conditioning.tensors.speaker_embeddings;
    const speakerFeaturesSer = conditioning.tensors.speaker_features;

    const audioFeaturesArray = new Float32Array(audioFeaturesSer.data);
    const condSeqLen = audioFeaturesSer.dims[1];
    const hiddenSize = audioFeaturesSer.dims[2] ?? CHATTERBOX_HIDDEN_SIZE;

    const pastKeyValues = new Map<string, OrtTensorLike>();
    let currentEmbedsTensor: OrtTensorLike | null = null;
    let attentionMaskTensor: OrtTensorLike | null = null;

    try {
      throwIfAborted(linkedSignal, this.cancelled);

      // Step 0: Embed prompt tokens + concat audio_features + text inputs_embeds
      const promptEmbeds = await this.runEmbedTokens(inputIds, positionIds, exaggeration);
      const textSeqLen = inputIds.length;
      const totalInitialSeqLen = condSeqLen + textSeqLen;

      const combinedEmbeds = new Float32Array(totalInitialSeqLen * hiddenSize);
      combinedEmbeds.set(audioFeaturesArray, 0);
      combinedEmbeds.set(promptEmbeds, audioFeaturesArray.length);

      currentEmbedsTensor = makeTensor('float32', combinedEmbeds, [
        1,
        totalInitialSeqLen,
        hiddenSize,
      ]);

      const initMask = new BigInt64Array(totalInitialSeqLen).fill(1n);
      attentionMaskTensor = makeTensor('int64', initMask, [1, totalInitialSeqLen]);

      // Initialize empty 30-layer KV cache
      for (let layer = 0; layer < CHATTERBOX_LM_NUM_LAYERS; layer += 1) {
        for (const kv of ['key', 'value'] as const) {
          const emptyBuffer =
            this.activeKvDtype === 'float16'
              ? new Uint16Array(0)
              : new Float32Array(0);
          pastKeyValues.set(
            `past_key_values.${layer}.${kv}`,
            makeTensor(this.activeKvDtype, emptyBuffer, [
              1,
              CHATTERBOX_LM_NUM_KV_HEADS,
              0,
              CHATTERBOX_LM_HEAD_DIM,
            ])
          );
        }
      }

      const generatedHistory: number[] = [START_SPEECH_TOKEN];
      const generatedSpeechTokens: number[] = [];

      for (let step = 0; step < maxNewTokens; step += 1) {
        throwIfAborted(linkedSignal, this.cancelled);

        const feeds: Record<string, unknown> = {
          inputs_embeds: currentEmbedsTensor,
          attention_mask: attentionMaskTensor,
        };
        for (const [k, v] of pastKeyValues.entries()) {
          feeds[k] = v;
        }

        const lmOutputs = await this.languageModelSession.run(feeds);

        safeDisposeTensor(currentEmbedsTensor);
        currentEmbedsTensor = null;
        safeDisposeTensor(attentionMaskTensor);
        attentionMaskTensor = null;

        // Swap KV cache tensors and dispose the previous step's KV tensors
        for (let layer = 0; layer < CHATTERBOX_LM_NUM_LAYERS; layer += 1) {
          for (const kv of ['key', 'value'] as const) {
            const pastKey = `past_key_values.${layer}.${kv}`;
            const presentKey = `present.${layer}.${kv}`;
            const oldTensor = pastKeyValues.get(pastKey);
            const nextTensor = lmOutputs[presentKey];
            if (!nextTensor) {
              throw new Error(`language_model did not output '${presentKey}'.`);
            }
            pastKeyValues.set(pastKey, nextTensor);
            safeDisposeTensor(oldTensor);
          }
        }

        const logitsTensor = lmOutputs.logits;
        if (!logitsTensor) {
          throw new Error('language_model did not output logits.');
        }

        let lastStepLogits: Float32Array;
        try {
          const fullLogits = toFloat32Array(await logitsTensor.getData());
          const seqDim = logitsTensor.dims[1] ?? 1;
          const vocabDim = logitsTensor.dims[2] ?? CHATTERBOX_LM_VOCAB_SIZE;
          const offset = (seqDim - 1) * vocabDim;
          lastStepLogits = fullLogits.slice(offset, offset + vocabDim);
        } finally {
          safeDisposeTensor(logitsTensor);
        }

        const nextToken = sampleNextSpeechToken(lastStepLogits, generatedHistory, {
          temperature,
          repetitionPenalty,
          topP,
          topK,
          rng,
        });

        generatedHistory.push(nextToken);

        if (nextToken === STOP_SPEECH_TOKEN) {
          break;
        }

        if (nextToken < START_SPEECH_TOKEN) {
          generatedSpeechTokens.push(nextToken);
        }

        if (step + 1 < maxNewTokens) {
          throwIfAborted(linkedSignal, this.cancelled);
          const nextEmbeds = await this.runEmbedTokens([nextToken], [step + 1], exaggeration);
          currentEmbedsTensor = makeTensor('float32', nextEmbeds, [1, 1, hiddenSize]);

          const nextMaskLen = totalInitialSeqLen + step + 1;
          const nextMask = new BigInt64Array(nextMaskLen).fill(1n);
          attentionMaskTensor = makeTensor('int64', nextMask, [1, nextMaskLen]);
        }
      }

      throwIfAborted(linkedSignal, this.cancelled);

      // Build speech_tokens: [audio_tokens, generatedSpeechTokens, 4299, 4299, 4299]
      const promptSpeechTokens = new BigInt64Array(audioTokensSer.data);
      const totalSpeechLen =
        promptSpeechTokens.length +
        generatedSpeechTokens.length +
        CHATTERBOX_SILENCE_PAD_COUNT;
      const combinedSpeechTokens = new BigInt64Array(totalSpeechLen);
      combinedSpeechTokens.set(promptSpeechTokens, 0);
      let cursor = promptSpeechTokens.length;
      for (let i = 0; i < generatedSpeechTokens.length; i += 1) {
        combinedSpeechTokens[cursor++] = BigInt(generatedSpeechTokens[i]);
      }
      for (let i = 0; i < CHATTERBOX_SILENCE_PAD_COUNT; i += 1) {
        combinedSpeechTokens[cursor++] = BigInt(SILENCE_TOKEN);
      }

      const speechTokensTensor = makeTensor('int64', combinedSpeechTokens, [
        1,
        totalSpeechLen,
      ]);
      const speakerEmbeddingsTensor = makeTensor(
        'float32',
        new Float32Array(speakerEmbeddingsSer.data),
        speakerEmbeddingsSer.dims
      );
      const speakerFeaturesTensor = makeTensor(
        'float32',
        new Float32Array(speakerFeaturesSer.data),
        speakerFeaturesSer.dims
      );

      let decOutputs: Record<string, OrtTensorLike> | null = null;
      let waveformSamples: Float32Array;
      try {
        decOutputs = await this.conditionalDecoderSession.run({
          speech_tokens: speechTokensTensor,
          speaker_embeddings: speakerEmbeddingsTensor,
          speaker_features: speakerFeaturesTensor,
        });
        const waveformTensor = decOutputs.waveform;
        if (!waveformTensor) {
          throw new Error('conditional_decoder.onnx did not output waveform.');
        }
        const rawWave = toFloat32Array(await waveformTensor.getData());
        waveformSamples = new Float32Array(rawWave.length);
        waveformSamples.set(rawWave);
      } finally {
        safeDisposeTensor(speechTokensTensor);
        safeDisposeTensor(speakerEmbeddingsTensor);
        safeDisposeTensor(speakerFeaturesTensor);
        if (decOutputs) {
          for (const tensor of Object.values(decOutputs)) {
            safeDisposeTensor(tensor);
          }
        }
      }

      const durationSec = waveformSamples.length / CHATTERBOX_SAMPLE_RATE;
      const generationTimeMs = Math.max(0, performance.now() - startTimeMs);
      const realTimeFactor = durationSec > 0 ? generationTimeMs / 1000 / durationSec : 0;

      onChunk?.({
        chunkIndex: 0,
        samples: waveformSamples,
        sampleRate: CHATTERBOX_SAMPLE_RATE,
        durationSec,
        isFinal: true,
      });

      return {
        audio: {
          samples: waveformSamples,
          sampleRate: CHATTERBOX_SAMPLE_RATE,
          channels: 1,
          durationSec,
        },
        generationTimeMs,
        realTimeFactor,
        backend: this.activeBackend ?? 'webgpu',
      };
    } finally {
      safeDisposeTensor(currentEmbedsTensor);
      safeDisposeTensor(attentionMaskTensor);
      for (const kvTensor of pastKeyValues.values()) {
        safeDisposeTensor(kvTensor);
      }
      pastKeyValues.clear();
      cleanupSignals();
      if (this.activeAbortController === synthController) {
        this.activeAbortController = null;
      }
    }
  }

  private async runEmbedTokens(
    inputIds: readonly number[],
    positionIds: readonly number[],
    exaggeration: number
  ): Promise<Float32Array> {
    if (!this.embedTokensSession) {
      throw new Error('embed_tokens session is not initialized.');
    }

    const makeTensor = this.deps.createTensor ?? defaultCreateTensor;
    const seqLen = inputIds.length;
    const inputIdsTensor = makeTensor(
      'int64',
      BigInt64Array.from(inputIds, (id) => BigInt(id)),
      [1, seqLen]
    );
    const positionIdsTensor = makeTensor(
      'int64',
      BigInt64Array.from(positionIds, (pos) => BigInt(pos)),
      [1, seqLen]
    );
    const exaggerationTensor = makeTensor(
      'float32',
      new Float32Array([exaggeration]),
      [1]
    );

    const feeds: Record<string, unknown> = {
      input_ids: inputIdsTensor,
    };
    if (this.embedTokensSession.inputNames.includes('position_ids')) {
      feeds.position_ids = positionIdsTensor;
    }
    if (this.embedTokensSession.inputNames.includes('exaggeration')) {
      feeds.exaggeration = exaggerationTensor;
    }

    let out: Record<string, OrtTensorLike> | null = null;
    try {
      out = await this.embedTokensSession.run(feeds);
      const embedsTensor = out.inputs_embeds;
      if (!embedsTensor) {
        throw new Error('embed_tokens.onnx did not return inputs_embeds.');
      }
      const raw = toFloat32Array(await embedsTensor.getData());
      const copy = new Float32Array(raw.length);
      copy.set(raw);
      return copy;
    } finally {
      safeDisposeTensor(inputIdsTensor);
      safeDisposeTensor(positionIdsTensor);
      safeDisposeTensor(exaggerationTensor);
      if (out) {
        for (const tensor of Object.values(out)) {
          safeDisposeTensor(tensor);
        }
      }
    }
  }

  cancel(): void {
    this.cancelled = true;
    this.activeAbortController?.abort();
  }

  private async releaseSessions(): Promise<void> {
    const sessions = [
      this.speechEncoderSession,
      this.embedTokensSession,
      this.languageModelSession,
      this.conditionalDecoderSession,
    ];
    this.speechEncoderSession = null;
    this.embedTokensSession = null;
    this.languageModelSession = null;
    this.conditionalDecoderSession = null;

    await Promise.all(
      sessions.map((s) => (s ? s.release().catch(() => undefined) : Promise.resolve()))
    );
    this.isInitialized = false;
    this.activeBackend = null;
  }

  async dispose(): Promise<void> {
    this.cancel();
    this.loadedVoices.clear();
    await this.releaseSessions();
  }

  getSupportedLanguages(): readonly SupportedLanguage[] {
    return SUPPORTED_LANGUAGES;
  }

  getGenerationParameters(): readonly GenerationParameterSpec[] {
    return GENERATION_PARAMETERS;
  }

  getModelMetadata(): EngineModelMetadata {
    return {
      engineId: CHATTERBOX_ENGINE_ID,
      modelName: CHATTERBOX_MODEL_NAME,
      repoId: CHATTERBOX_REPO_ID,
      modelRevision: CHATTERBOX_MODEL_REVISION,
      license: CHATTERBOX_LICENSE,
      nativeSampleRate: CHATTERBOX_SAMPLE_RATE,
      precision: this.activePrecision,
      totalSizeBytes: this.totalSizeBytes,
      isInitialized: this.isInitialized,
      activeBackend: this.activeBackend,
    };
  }
}

export type ChatterboxWorkerRequest =
  | {
      id: string;
      type: 'initialize';
      options: Omit<EngineInitOptions, 'signal'>;
    }
  | {
      id: string;
      type: 'encodeVoice';
      audio: AudioBufferData;
      metadata: ReferenceClipMetadata;
    }
  | {
      id: string;
      type: 'loadVoiceProfile';
      profile: VoiceProfile;
    }
  | {
      id: string;
      type: 'synthesize';
      request: Omit<SynthesisRequest, 'signal'>;
    }
  | {
      id: string;
      type: 'cancel';
    }
  | {
      id: string;
      type: 'dispose';
    };

export type ChatterboxWorkerResponse =
  | {
      id: string;
      type: 'progress';
      progress: EngineLoadProgress;
    }
  | {
      id: string;
      type: 'chunk';
      chunk: SynthesizedAudioChunk;
    }
  | {
      id: string;
      type: 'result';
      result: unknown;
    }
  | {
      id: string;
      type: 'error';
      error: { name: string; message: string };
    };

export interface ChatterboxEngineOptions {
  /**
   * Run ONNX inference inside the dedicated `chatterbox.worker.ts` Web Worker.
   * Defaults to `true` when `Worker` is available; falls back to direct execution in Node/tests.
   */
  useWorker?: boolean;
  /** Optional dependency overrides for unit testing direct mode. */
  dependencies?: ChatterboxDependencies;
}

/**
 * Public Chatterbox Engine A facade implementing `VoiceCloningEngine`.
 * Offloads all ONNX Runtime Web inference to `src/workers/chatterbox.worker.ts`
 * in browser environments so WebGPU compilation and autoregressive loops never block the UI thread.
 */
export class ChatterboxEngine implements VoiceCloningEngine {
  readonly id = CHATTERBOX_ENGINE_ID;
  readonly name = CHATTERBOX_MODEL_NAME;
  readonly description =
    'Resemble AI Chatterbox ONNX zero-shot English voice cloning with emotion exaggeration control (24 kHz).';
  readonly version = '1.0.0';
  readonly capabilities: EngineCapabilities = CHATTERBOX_CAPABILITIES;

  private readonly directEngine: ChatterboxCoreEngine;
  private readonly useWorker: boolean;
  private worker: Worker | null = null;
  private requestCounter = 0;

  private activePrecision: ChatterboxLmPrecision = 'q4f16';
  private activeBackend: EngineBackend | null = null;
  private isInitialized = false;
  private totalSizeBytes = getChatterboxManifestEntry('q4f16').totalSizeBytes;

  private readonly pending = new Map<
    string,
    {
      resolve: (value: unknown) => void;
      reject: (reason?: unknown) => void;
      onProgress?: (progress: EngineLoadProgress) => void;
      onChunk?: (chunk: SynthesizedAudioChunk) => void;
    }
  >();

  constructor(options: ChatterboxEngineOptions = {}) {
    this.directEngine = new ChatterboxCoreEngine(options.dependencies);
    const hasWorker = typeof Worker !== 'undefined';
    this.useWorker = options.useWorker ?? hasWorker;
  }

  get precision(): EnginePrecision {
    return this.useWorker ? this.activePrecision : this.directEngine.precision;
  }

  async checkHardwareCompatibility(): Promise<HardwareCompatibilityReport> {
    return await this.directEngine.checkHardwareCompatibility();
  }

  private ensureWorker(): Worker {
    if (this.worker) return this.worker;
    const worker = new Worker(
      new URL('../../workers/chatterbox.worker.ts', import.meta.url),
      { type: 'module' }
    );
    worker.onmessage = (event: MessageEvent<ChatterboxWorkerResponse>) => {
      const msg = event.data;
      const entry = this.pending.get(msg.id);
      if (!entry) return;

      if (msg.type === 'progress') {
        entry.onProgress?.(msg.progress);
      } else if (msg.type === 'chunk') {
        entry.onChunk?.(msg.chunk);
      } else if (msg.type === 'result') {
        this.pending.delete(msg.id);
        entry.resolve(msg.result);
      } else if (msg.type === 'error') {
        this.pending.delete(msg.id);
        const err = new Error(msg.error.message);
        err.name = msg.error.name || 'Error';
        entry.reject(err);
      }
    };
    worker.onerror = (event: ErrorEvent) => {
      const err = new Error(event.message || 'Chatterbox worker error');
      for (const [id, entry] of this.pending.entries()) {
        this.pending.delete(id);
        entry.reject(err);
      }
    };
    this.worker = worker;
    return worker;
  }

  private callWorker<T>(
    message: Record<string, unknown>,
    callbacks?: {
      onProgress?: (progress: EngineLoadProgress) => void;
      onChunk?: (chunk: SynthesizedAudioChunk) => void;
      signal?: AbortSignal;
    }
  ): Promise<T> {
    const id = `cb-${++this.requestCounter}`;
    const worker = this.ensureWorker();

    return new Promise<T>((resolve, reject) => {
      if (callbacks?.signal?.aborted) {
        reject(createAbortError());
        return;
      }

      const onAbort = () => {
        void this.cancel();
      };
      callbacks?.signal?.addEventListener('abort', onAbort, { once: true });

      this.pending.set(id, {
        resolve: (value) => {
          callbacks?.signal?.removeEventListener('abort', onAbort);
          resolve(value as T);
        },
        reject: (err) => {
          callbacks?.signal?.removeEventListener('abort', onAbort);
          reject(err);
        },
        onProgress: callbacks?.onProgress,
        onChunk: callbacks?.onChunk,
      });

      worker.postMessage({ ...message, id });
    });
  }

  async initialize(
    options: EngineInitOptions,
    onProgress?: (progress: EngineLoadProgress) => void
  ): Promise<void> {
    if (!this.useWorker) {
      await this.directEngine.initialize(options, onProgress);
      const meta = this.directEngine.getModelMetadata();
      this.activePrecision = meta.precision as ChatterboxLmPrecision;
      this.activeBackend = meta.activeBackend;
      this.totalSizeBytes = meta.totalSizeBytes;
      this.isInitialized = meta.isInitialized;
      return;
    }

    const { signal, ...serializableOptions } = options;
    const meta = await this.callWorker<EngineModelMetadata>(
      {
        type: 'initialize',
        options: serializableOptions,
      },
      { onProgress, signal }
    );
    this.activePrecision = meta.precision as ChatterboxLmPrecision;
    this.activeBackend = meta.activeBackend;
    this.totalSizeBytes = meta.totalSizeBytes;
    this.isInitialized = meta.isInitialized;
  }

  async encodeVoice(
    audio: AudioBufferData,
    metadata: ReferenceClipMetadata
  ): Promise<VoiceConditioningPayload> {
    if (!this.useWorker) {
      return await this.directEngine.encodeVoice(audio, metadata);
    }
    return await this.callWorker<VoiceConditioningPayload>({
      type: 'encodeVoice',
      audio,
      metadata,
    });
  }

  async loadVoiceProfile(profile: VoiceProfile): Promise<LoadedVoiceHandle> {
    const payload = assertCompatibleConditioningPayload(profile, this);
    validateChatterboxConditioningPayload(payload);

    if (!this.useWorker) {
      return await this.directEngine.loadVoiceProfile(profile);
    }
    return await this.callWorker<LoadedVoiceHandle>({
      type: 'loadVoiceProfile',
      profile,
    });
  }

  async synthesize(
    request: SynthesisRequest,
    onChunk?: (chunk: SynthesizedAudioChunk) => void
  ): Promise<SynthesisResult> {
    validateVoiceHandleForEngine(request.voiceHandle, this);
    if (!this.useWorker) {
      return await this.directEngine.synthesize(request, onChunk);
    }
    const { signal, ...serializableRequest } = request;
    return await this.callWorker<SynthesisResult>(
      {
        type: 'synthesize',
        request: serializableRequest,
      },
      { onChunk, signal }
    );
  }

  async cancel(): Promise<void> {
    if (!this.useWorker) {
      this.directEngine.cancel();
      return;
    }
    if (this.worker) {
      this.worker.postMessage({ id: `cb-cancel-${++this.requestCounter}`, type: 'cancel' });
    }
  }

  async dispose(): Promise<void> {
    if (!this.useWorker) {
      await this.directEngine.dispose();
      this.isInitialized = false;
      this.activeBackend = null;
      return;
    }

    if (this.worker) {
      try {
        await this.callWorker<void>({ type: 'dispose' });
      } catch {
        // Ignore errors during worker shutdown.
      }
      for (const [id, entry] of this.pending.entries()) {
        this.pending.delete(id);
        entry.reject(createAbortError('ChatterboxEngine disposed'));
      }
      this.worker.terminate();
      this.worker = null;
    }
    this.isInitialized = false;
    this.activeBackend = null;
  }

  getSupportedLanguages(): readonly SupportedLanguage[] {
    return SUPPORTED_LANGUAGES;
  }

  getGenerationParameters(): readonly GenerationParameterSpec[] {
    return GENERATION_PARAMETERS;
  }

  getModelMetadata(): EngineModelMetadata {
    if (!this.useWorker) {
      return this.directEngine.getModelMetadata();
    }
    return {
      engineId: CHATTERBOX_ENGINE_ID,
      modelName: CHATTERBOX_MODEL_NAME,
      repoId: CHATTERBOX_REPO_ID,
      modelRevision: CHATTERBOX_MODEL_REVISION,
      license: CHATTERBOX_LICENSE,
      nativeSampleRate: CHATTERBOX_SAMPLE_RATE,
      precision: this.activePrecision,
      totalSizeBytes: this.totalSizeBytes,
      isInitialized: this.isInitialized,
      activeBackend: this.activeBackend,
    };
  }
}
