/**
 * Common VoiceCloningEngine contract and runtime diagnostics types.
 */

import type { ExecutionMode } from './models';
import type {
  ReferenceClipMetadata,
  VoiceConditioningPayload,
  VoiceProfile,
} from './voice';

export type EngineId =
  | 'pocket-tts'
  | 'chatterbox'
  | 'chatterbox-turbo'
  | 'qwen3-tts'
  | (string & {});

export type EnginePrecision = 'fp32' | 'fp16' | 'q8' | 'int8' | 'q4' | 'q4f16';

export type EngineBackend = 'webgpu' | 'wasm';

export interface EngineCapabilities {
  /** Supports custom reference-audio voice cloning in browser. */
  supportsVoiceCloning: boolean;
  /** Supports streaming chunk callbacks during synthesis. */
  supportsStreaming: boolean;
  /** Supports WebGPU acceleration. */
  supportsWebGpu: boolean;
  /** Supports WASM CPU execution. */
  supportsWasm: boolean;
  /** Requires transcript of reference audio alongside audio samples. */
  requiresReferenceTranscript: boolean;
  /** Supported emotion / style tags if any. */
  supportsEmotionTags: boolean;
  /** Recommended minimum reference audio duration in seconds. */
  minReferenceDurationSec: number;
  /** Recommended maximum reference audio duration in seconds. */
  maxReferenceDurationSec: number;
  /** Native audio output sample rate in Hz. */
  nativeSampleRate: number;
}

export interface HardwareCompatibilityReport {
  /** Engine identifier evaluated. */
  engineId: EngineId;
  /** Whether the browser supports WebGPU (`navigator.gpu`). */
  webgpuSupported: boolean;
  /** Whether WebGPU adapter supports `shader-f16`. */
  shaderF16Supported: boolean;
  /** Whether WebAssembly SIMD is supported. */
  wasmSimdSupported: boolean;
  /** Whether multi-threaded WASM (`SharedArrayBuffer`) is available. */
  wasmThreadsSupported: boolean;
  /** Whether `window.crossOriginIsolated` is true. */
  crossOriginIsolated: boolean;
  /** Best-effort available device memory estimate in MB, if reported by browser. */
  estimatedDeviceMemoryMb: number | null;
  /** Whether this engine can run in the current browser environment. */
  compatible: boolean;
  /** Best execution backend for this environment. */
  recommendedBackend: EngineBackend;
  /** Best execution mode for this environment. */
  recommendedExecutionMode: ExecutionMode;
  /** Hard blockers preventing execution, if any. */
  blockers: string[];
  /** Non-fatal warnings (e.g. falling back to single-threaded WASM). */
  warnings: string[];
}

export interface EngineInitOptions {
  /** Desired execution mode. */
  executionMode: ExecutionMode;
  /** Preferred backend override ('webgpu' or 'wasm'). */
  preferredBackend?: EngineBackend;
  /** Number of WASM threads (1 when crossOriginIsolated is false). */
  wasmThreads?: number;
  /** Base URL for local ONNX Runtime WASM/MJS assets (defaults to `${BASE_URL}runtime/`). */
  wasmBasePath?: string;
  /** Optional custom model revision override (must match pinned manifest unless user overrides). */
  modelRevision?: string;
  /** Optional AbortSignal to cancel initialization/download. */
  signal?: AbortSignal;
}

export interface EngineLoadProgress {
  /** Current initialization phase. */
  phase: 'checking' | 'downloading' | 'verifying' | 'creating-session' | 'warming-up' | 'ready';
  /** Artifact role or step label currently active. */
  item: string;
  /** Progress fraction 0-1 for the active phase or overall load. */
  progress: number;
  /** Bytes downloaded so far (when phase is 'downloading'). */
  loadedBytes?: number;
  /** Total bytes expected (when phase is 'downloading'). */
  totalBytes?: number;
  /** Human-readable status detail. */
  message: string;
}

export interface AudioBufferData {
  /** Interleaved or mono PCM samples in [-1, 1]. For mono: single Float32Array. */
  samples: Float32Array;
  /** Sample rate in Hz. */
  sampleRate: number;
  /** Number of channels (typically 1 for mono engine input/output). */
  channels: number;
  /** Duration in seconds. */
  durationSec: number;
}

export interface LoadedVoiceHandle {
  /** VoiceProfile ID. */
  profileId: string;
  /** Engine ID that validated and loaded this conditioning state. */
  engineId: string;
  /** Model revision that matches the loaded conditioning state. */
  modelRevision: string;
  /** Engine-internal cache handle identifier. */
  handleId: string;
}

export interface SynthesisRequest {
  /** Text chunk to synthesize (already normalized or raw). */
  text: string;
  /** Loaded engine-scoped voice handle. */
  voiceHandle: LoadedVoiceHandle;
  /** Language code (e.g. 'en'). */
  language: string;
  /** Engine-specific generation parameters (e.g. temperature, lsdSteps, speed, cfgScale). */
  parameters?: Record<string, number | string | boolean>;
  /** Optional AbortSignal for cancellation. */
  signal?: AbortSignal;
}

export interface SynthesizedAudioChunk {
  /** Zero-based streaming frame/chunk sequence index. */
  chunkIndex: number;
  /** Mono PCM float samples in [-1, 1]. */
  samples: Float32Array;
  /** Sample rate in Hz. */
  sampleRate: number;
  /** Duration of this streamed chunk in seconds. */
  durationSec: number;
  /** Whether this is the final chunk for the request. */
  isFinal: boolean;
}

export interface SynthesisResult {
  /** Complete mono PCM output for the synthesized request. */
  audio: AudioBufferData;
  /** Total wall-clock synthesis latency in milliseconds. */
  generationTimeMs: number;
  /** Real-time factor (generationTimeSec / audioDurationSec). */
  realTimeFactor: number;
  /** Backend actually used for synthesis. */
  backend: EngineBackend;
}

export interface SupportedLanguage {
  /** BCP-47 / ISO language code. */
  code: string;
  /** English display name. */
  name: string;
  /** Native display name. */
  nativeName: string;
}

export interface GenerationParameterSpec {
  /** Parameter key passed in SynthesisRequest.parameters. */
  key: string;
  /** UI label. */
  label: string;
  /** Short explanation of parameter effect. */
  description: string;
  /** Control type. */
  type: 'number' | 'boolean' | 'select';
  /** Default value. */
  defaultValue: number | string | boolean;
  min?: number;
  max?: number;
  step?: number;
  options?: Array<{ label: string; value: string | number }>;
}

export interface EngineModelMetadata {
  engineId: EngineId;
  modelName: string;
  repoId: string;
  modelRevision: string;
  license: string;
  nativeSampleRate: number;
  precision: EnginePrecision;
  totalSizeBytes: number;
  isInitialized: boolean;
  activeBackend: EngineBackend | null;
}

/**
 * Common interface implemented by every voice cloning inference engine.
 * Voice conditioning payloads are strictly engine-scoped (`engineId` + `modelRevision`).
 */
export interface VoiceCloningEngine {
  readonly id: EngineId;
  readonly name: string;
  readonly description: string;
  readonly version: string;
  readonly precision: EnginePrecision;
  readonly capabilities: EngineCapabilities;

  /** Inspect browser/device capabilities for this engine without downloading weights. */
  checkHardwareCompatibility(): Promise<HardwareCompatibilityReport>;

  /** Download/verify pinned artifacts and initialize ONNX Runtime sessions. */
  initialize(
    options: EngineInitOptions,
    onProgress?: (progress: EngineLoadProgress) => void
  ): Promise<void>;

  /**
   * Encode a preprocessed reference audio clip into an engine-scoped
   * VoiceConditioningPayload tagged with this engine's `id` and `modelRevision`.
   */
  encodeVoice(
    audio: AudioBufferData,
    metadata: ReferenceClipMetadata
  ): Promise<VoiceConditioningPayload>;

  /**
   * Validate and load an engine-scoped conditioning payload from a VoiceProfile.
   * MUST throw if no conditioning payload matches this engine's `id` and `modelRevision`.
   */
  loadVoiceProfile(profile: VoiceProfile): Promise<LoadedVoiceHandle>;

  /** Synthesize speech for a text chunk, optionally streaming intermediate audio chunks. */
  synthesize(
    request: SynthesisRequest,
    onChunk?: (chunk: SynthesizedAudioChunk) => void
  ): Promise<SynthesisResult>;

  /** Cancel any in-flight initialization or synthesis operation. */
  cancel(): Promise<void> | void;

  /** Release ONNX Runtime sessions, GPU buffers, and worker resources. */
  dispose(): Promise<void>;

  /** Return languages supported by this engine. */
  getSupportedLanguages(): readonly SupportedLanguage[];

  /** Return tunable generation parameters exposed by this engine. */
  getGenerationParameters(): readonly GenerationParameterSpec[];

  /** Return pinned model metadata and current runtime status. */
  getModelMetadata(): EngineModelMetadata;
}
