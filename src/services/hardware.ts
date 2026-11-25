/**
 * Client hardware capability detection and transparent execution-mode recommendation.
 *
 * Strictly reports only properties exposed by browser APIs — never fabricates
 * GPU VRAM values or hardware metrics that the browser does not provide.
 */

import type {
  EngineBackend,
  EngineId,
  ExecutionMode,
  HardwareCompatibilityReport,
} from '../types';

export interface WebGPUAdapterInfoSnapshot {
  vendor?: string;
  architecture?: string;
  device?: string;
  description?: string;
  isFallbackAdapter?: boolean;
}

export interface HardwareCapabilities {
  /** Whether `navigator.gpu` is exposed. */
  webgpuSupported: boolean;
  /** Whether `navigator.gpu.requestAdapter()` returned a non-null adapter. */
  webgpuAdapterAvailable: boolean;
  /** Whether the WebGPU adapter supports `shader-f16`. */
  shaderF16Supported: boolean;
  /** Adapter `limits.maxBufferSize` in bytes if exposed, else null. */
  webgpuMaxBufferSize: number | null;
  /** Adapter metadata (`adapter.info`) if exposed, else null. */
  webgpuAdapterInfo: WebGPUAdapterInfoSnapshot | null;
  /** Whether WebAssembly is available and validates basic modules. */
  wasmSupported: boolean;
  /** Whether WebAssembly 128-bit SIMD is supported. */
  wasmSimdSupported: boolean;
  /** Whether multi-threaded WASM (`crossOriginIsolated` + `SharedArrayBuffer`) is available. */
  wasmThreadsSupported: boolean;
  /** Value of `globalThis.crossOriginIsolated`. */
  crossOriginIsolated: boolean;
  /** Whether `SharedArrayBuffer` constructor is available. */
  sharedArrayBufferAvailable: boolean;
  /** Logical CPU cores reported by `navigator.hardwareConcurrency` (defaults to 1). */
  hardwareConcurrency: number;
  /** Approximate device RAM in GB from `navigator.deviceMemory`, or null if unavailable. */
  deviceMemoryGb: number | null;
  /** Approximate device RAM in MB derived from `deviceMemoryGb`, or null if unavailable. */
  estimatedDeviceMemoryMb: number | null;
  /** Origin storage quota in bytes from `navigator.storage.estimate()`, or null if unavailable. */
  storageQuotaBytes: number | null;
  /** Origin storage usage in bytes from `navigator.storage.estimate()`, or null if unavailable. */
  storageUsageBytes: number | null;
  /** Recommended WASM thread count (1 when not crossOriginIsolated, otherwise capped at 4). */
  recommendedWasmThreads: number;
  /** Transparently computed execution mode recommendation. */
  recommendedExecutionMode: ExecutionMode;
  /** Human-readable diagnostic notes explaining detected constraints. */
  notes: string[];
}

export type ExecutionModeInput = Partial<
  Pick<
    HardwareCapabilities,
    | 'webgpuSupported'
    | 'webgpuAdapterAvailable'
    | 'shaderF16Supported'
    | 'webgpuMaxBufferSize'
    | 'estimatedDeviceMemoryMb'
    | 'wasmSimdSupported'
    | 'wasmThreadsSupported'
    | 'hardwareConcurrency'
  >
> & {
  webgpuSupported: boolean;
  shaderF16Supported: boolean;
  estimatedDeviceMemoryMb: number | null;
};

interface NavigatorGpuAdapterLike {
  features?: { has(feature: string): boolean };
  limits?: { maxBufferSize?: number };
  info?: WebGPUAdapterInfoSnapshot;
  requestAdapterInfo?: () => Promise<WebGPUAdapterInfoSnapshot>;
  isFallbackAdapter?: boolean;
}

interface NavigatorGpuLike {
  requestAdapter?: (options?: {
    powerPreference?: 'high-performance' | 'low-power';
  }) => Promise<NavigatorGpuAdapterLike | null>;
}

/** Minimal valid WASM module: `() -> void`. */
const BASE_WASM_PROBE = new Uint8Array([
  0x00, 0x61, 0x73, 0x6d, 0x01, 0x00, 0x00, 0x00,
  0x01, 0x04, 0x01, 0x60, 0x00, 0x00,
  0x03, 0x02, 0x01, 0x00,
  0x0a, 0x04, 0x01, 0x02, 0x00, 0x0b,
]);

/** Minimal valid WASM SIMD128 module: `() -> v128` (`i32.const 0; i8x16.splat`). */
const SIMD_WASM_PROBE = new Uint8Array([
  0x00, 0x61, 0x73, 0x6d, 0x01, 0x00, 0x00, 0x00,
  0x01, 0x05, 0x01, 0x60, 0x00, 0x01, 0x7b,
  0x03, 0x02, 0x01, 0x00,
  0x0a, 0x08, 0x01, 0x06, 0x00, 0x41, 0x00, 0xfd, 0x0f, 0x0b,
]);

const MIN_QUALITY_MEMORY_MB = 4096;
const MIN_BALANCED_MEMORY_MB = 2048;
const MIN_QUALITY_MAX_BUFFER_BYTES = 256 * 1024 * 1024;

/**
 * Probe whether core WebAssembly validation succeeds in the current runtime.
 */
export function detectWasmSupport(): boolean {
  try {
    if (typeof WebAssembly !== 'object' || typeof WebAssembly.validate !== 'function') {
      return false;
    }
    return WebAssembly.validate(BASE_WASM_PROBE);
  } catch {
    return false;
  }
}

/**
 * Probe whether WebAssembly 128-bit SIMD instructions are supported.
 */
export function detectWasmSimdSupport(): boolean {
  try {
    if (typeof WebAssembly !== 'object' || typeof WebAssembly.validate !== 'function') {
      return false;
    }
    return WebAssembly.validate(SIMD_WASM_PROBE);
  } catch {
    return false;
  }
}

/**
 * Detect whether multi-threaded WASM (`SharedArrayBuffer` under `crossOriginIsolated`) is available.
 */
export function detectWasmThreadsSupport(): {
  crossOriginIsolated: boolean;
  sharedArrayBufferAvailable: boolean;
  wasmThreadsSupported: boolean;
} {
  const crossOriginIsolated =
    typeof globalThis.crossOriginIsolated === 'boolean'
      ? globalThis.crossOriginIsolated
      : false;
  const sharedArrayBufferAvailable = typeof SharedArrayBuffer === 'function';
  return {
    crossOriginIsolated,
    sharedArrayBufferAvailable,
    wasmThreadsSupported: crossOriginIsolated && sharedArrayBufferAvailable,
  };
}

function sanitizeAdapterInfo(
  raw: WebGPUAdapterInfoSnapshot | undefined,
  adapterFallbackFlag?: boolean
): WebGPUAdapterInfoSnapshot | null {
  if (!raw && typeof adapterFallbackFlag !== 'boolean') {
    return null;
  }
  const snapshot: WebGPUAdapterInfoSnapshot = {};
  if (raw?.vendor) snapshot.vendor = raw.vendor;
  if (raw?.architecture) snapshot.architecture = raw.architecture;
  if (raw?.device) snapshot.device = raw.device;
  if (raw?.description) snapshot.description = raw.description;
  const fallback =
    typeof raw?.isFallbackAdapter === 'boolean'
      ? raw.isFallbackAdapter
      : typeof adapterFallbackFlag === 'boolean'
        ? adapterFallbackFlag
        : undefined;
  if (typeof fallback === 'boolean') {
    snapshot.isFallbackAdapter = fallback;
  }
  return Object.keys(snapshot).length > 0 ? snapshot : null;
}

/**
 * Recommend an execution mode (`'quality' | 'balanced' | 'cpu'`) transparently
 * from detected browser capabilities.
 */
export function recommendExecutionMode(report: ExecutionModeInput): ExecutionMode {
  const hasUsableWebGpu =
    report.webgpuSupported && report.webgpuAdapterAvailable !== false;

  if (!hasUsableWebGpu) {
    return 'cpu';
  }

  if (
    report.estimatedDeviceMemoryMb !== null &&
    report.estimatedDeviceMemoryMb < MIN_BALANCED_MEMORY_MB
  ) {
    return 'cpu';
  }

  const meetsMemoryForQuality =
    report.estimatedDeviceMemoryMb === null ||
    report.estimatedDeviceMemoryMb >= MIN_QUALITY_MEMORY_MB;

  const meetsBufferForQuality =
    report.webgpuMaxBufferSize === undefined ||
    report.webgpuMaxBufferSize === null ||
    report.webgpuMaxBufferSize >= MIN_QUALITY_MAX_BUFFER_BYTES;

  if (report.shaderF16Supported && meetsMemoryForQuality && meetsBufferForQuality) {
    return 'quality';
  }

  return 'balanced';
}

/**
 * Collect hardware, WebGPU, WebAssembly, memory, and storage capabilities
 * from browser APIs.
 */
export async function detectHardwareCapabilities(): Promise<HardwareCapabilities> {
  const nav = typeof navigator !== 'undefined' ? navigator : undefined;
  const notes: string[] = [];

  const wasmSupported = detectWasmSupport();
  const wasmSimdSupported = wasmSupported && detectWasmSimdSupport();
  const threadSupport = detectWasmThreadsSupport();

  const rawConcurrency = nav?.hardwareConcurrency;
  const hardwareConcurrency =
    typeof rawConcurrency === 'number' && Number.isFinite(rawConcurrency) && rawConcurrency >= 1
      ? Math.floor(rawConcurrency)
      : 1;

  const rawDeviceMemory = (nav as { deviceMemory?: unknown } | undefined)?.deviceMemory;
  const deviceMemoryGb =
    typeof rawDeviceMemory === 'number' &&
    Number.isFinite(rawDeviceMemory) &&
    rawDeviceMemory > 0
      ? rawDeviceMemory
      : null;
  const estimatedDeviceMemoryMb =
    deviceMemoryGb !== null ? Math.round(deviceMemoryGb * 1024) : null;

  let storageQuotaBytes: number | null = null;
  let storageUsageBytes: number | null = null;
  if (nav?.storage && typeof nav.storage.estimate === 'function') {
    try {
      const estimate = await nav.storage.estimate();
      if (typeof estimate.quota === 'number' && Number.isFinite(estimate.quota)) {
        storageQuotaBytes = estimate.quota;
      }
      if (typeof estimate.usage === 'number' && Number.isFinite(estimate.usage)) {
        storageUsageBytes = estimate.usage;
      }
    } catch {
      notes.push('navigator.storage.estimate() failed or is restricted.');
    }
  }

  const gpu = (nav as { gpu?: NavigatorGpuLike } | undefined)?.gpu;
  const webgpuSupported = Boolean(gpu && typeof gpu.requestAdapter === 'function');
  let webgpuAdapterAvailable = false;
  let shaderF16Supported = false;
  let webgpuMaxBufferSize: number | null = null;
  let webgpuAdapterInfo: WebGPUAdapterInfoSnapshot | null = null;

  if (webgpuSupported && gpu?.requestAdapter) {
    try {
      let adapter = await gpu.requestAdapter({ powerPreference: 'high-performance' });
      if (!adapter) {
        adapter = await gpu.requestAdapter();
      }
      if (adapter) {
        webgpuAdapterAvailable = true;
        shaderF16Supported = Boolean(adapter.features?.has('shader-f16'));
        const maxBuf = adapter.limits?.maxBufferSize;
        webgpuMaxBufferSize =
          typeof maxBuf === 'number' && Number.isFinite(maxBuf) ? maxBuf : null;

        let rawInfo = adapter.info;
        if (!rawInfo && typeof adapter.requestAdapterInfo === 'function') {
          try {
            rawInfo = await adapter.requestAdapterInfo();
          } catch {
            // Optional adapter info unavailable.
          }
        }
        webgpuAdapterInfo = sanitizeAdapterInfo(rawInfo, adapter.isFallbackAdapter);
      } else {
        notes.push('WebGPU API is present, but no GPU adapter was returned.');
      }
    } catch {
      notes.push('WebGPU adapter probe failed.');
    }
  }

  if (!threadSupport.crossOriginIsolated) {
    notes.push(
      'crossOriginIsolated is false; WASM execution will run single-threaded (numThreads = 1).'
    );
  }
  if (!wasmSimdSupported) {
    notes.push('WebAssembly SIMD is unavailable; CPU inference will be significantly slower.');
  }
  if (deviceMemoryGb === null) {
    notes.push('navigator.deviceMemory is not exposed by this browser.');
  }

  const recommendedWasmThreads = threadSupport.wasmThreadsSupported
    ? Math.min(Math.max(hardwareConcurrency, 1), 4)
    : 1;

  const recommendedExecutionMode = recommendExecutionMode({
    webgpuSupported,
    webgpuAdapterAvailable,
    shaderF16Supported,
    webgpuMaxBufferSize,
    estimatedDeviceMemoryMb,
    wasmSimdSupported,
    wasmThreadsSupported: threadSupport.wasmThreadsSupported,
    hardwareConcurrency,
  });

  return {
    webgpuSupported,
    webgpuAdapterAvailable,
    shaderF16Supported,
    webgpuMaxBufferSize,
    webgpuAdapterInfo,
    wasmSupported,
    wasmSimdSupported,
    wasmThreadsSupported: threadSupport.wasmThreadsSupported,
    crossOriginIsolated: threadSupport.crossOriginIsolated,
    sharedArrayBufferAvailable: threadSupport.sharedArrayBufferAvailable,
    hardwareConcurrency,
    deviceMemoryGb,
    estimatedDeviceMemoryMb,
    storageQuotaBytes,
    storageUsageBytes,
    recommendedWasmThreads,
    recommendedExecutionMode,
    notes,
  };
}

/**
 * Helper to derive a per-engine `HardwareCompatibilityReport` from detected capabilities.
 */
export function buildEngineCompatibilityReport(
  engineId: EngineId,
  capabilities: HardwareCapabilities,
  requirements: {
    supportsWasm: boolean;
    supportsWebGpu: boolean;
    requiresWebGpu?: boolean;
    requiresShaderF16?: boolean;
    minEstimatedMemoryMb?: number;
  }
): HardwareCompatibilityReport {
  const blockers: string[] = [];
  const warnings: string[] = [...capabilities.notes];

  if (!capabilities.wasmSupported && requirements.supportsWasm && !requirements.supportsWebGpu) {
    blockers.push('WebAssembly is not supported in this browser.');
  }

  const webgpuUsable =
    capabilities.webgpuSupported && capabilities.webgpuAdapterAvailable;

  if (requirements.requiresWebGpu && !webgpuUsable) {
    blockers.push('This engine requires WebGPU, which is unavailable on this device/browser.');
  }

  if (requirements.requiresShaderF16 && !capabilities.shaderF16Supported) {
    blockers.push('This engine requires WebGPU shader-f16 support.');
  }

  if (
    requirements.minEstimatedMemoryMb !== undefined &&
    capabilities.estimatedDeviceMemoryMb !== null &&
    capabilities.estimatedDeviceMemoryMb < requirements.minEstimatedMemoryMb
  ) {
    warnings.push(
      `Reported device memory (${capabilities.estimatedDeviceMemoryMb} MB) is below recommended ${requirements.minEstimatedMemoryMb} MB.`
    );
  }

  if (!requirements.supportsWasm && !webgpuUsable && blockers.length === 0) {
    blockers.push('No supported execution backend is available.');
  }

  let recommendedBackend: EngineBackend = 'wasm';
  if (requirements.supportsWebGpu && webgpuUsable && (!requirements.supportsWasm || capabilities.shaderF16Supported)) {
    recommendedBackend = 'webgpu';
  }

  const recommendedExecutionMode: ExecutionMode =
    recommendedBackend === 'wasm' ? 'cpu' : capabilities.recommendedExecutionMode;

  return {
    engineId,
    webgpuSupported: capabilities.webgpuSupported,
    shaderF16Supported: capabilities.shaderF16Supported,
    wasmSimdSupported: capabilities.wasmSimdSupported,
    wasmThreadsSupported: capabilities.wasmThreadsSupported,
    crossOriginIsolated: capabilities.crossOriginIsolated,
    estimatedDeviceMemoryMb: capabilities.estimatedDeviceMemoryMb,
    compatible: blockers.length === 0,
    recommendedBackend,
    recommendedExecutionMode,
    blockers,
    warnings,
  };
}
