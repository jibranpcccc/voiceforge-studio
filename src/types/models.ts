/**
 * Pinned model manifest, artifact integrity, and execution mode contracts.
 */

export type ExecutionMode = 'quality' | 'balanced' | 'cpu';

export type ModelDownloadStatus =
  | 'not-downloaded'
  | 'checking'
  | 'downloading'
  | 'verifying'
  | 'cached'
  | 'error'
  | 'update-available';

export interface ModelArtifact {
  /** Logical artifact role (e.g. 'text_conditioner', 'flow_lm_main', 'mimi_decoder', 'tokenizer'). */
  role: string;
  /** Relative path within the remote repository or local model folder. */
  relativePath: string;
  /** Direct download URL resolved from pinned repository and commit SHA. */
  url: string;
  /** Exact expected byte size from repository metadata. */
  sizeBytes: number;
  /** Expected SHA-256 hex digest (LFS OID or verified file SHA-256). */
  sha256: string;
  /** Optional runtime format hint. */
  format: 'onnx' | 'onnx_data' | 'json' | 'bin' | 'spm' | 'txt' | 'other';
  /** Whether this artifact is required for inference. */
  required: boolean;
}

export interface ModelManifestEntry {
  /** Engine identifier matching VoiceCloningEngine.id. */
  engineId: string;
  /** Human-readable model name. */
  displayName: string;
  /** Upstream HuggingFace repo or source identifier (e.g. 'KevinAHM/pocket-tts-onnx'). */
  repoId: string;
  /** Pinned immutable git commit SHA from upstream repository. */
  revision: string;
  /** SPDX or upstream license identifier. */
  license: string;
  /** Upstream license URL or notice. */
  licenseUrl?: string;
  /** Whether the upstream repository is ungated and publicly downloadable without auth. */
  ungated: boolean;
  /** Precision / quantization label (e.g. 'fp32', 'int8', 'q4f16'). */
  precision: string;
  /** Native output audio sample rate in Hz. */
  sampleRate: number;
  /** Minimum recommended execution mode. */
  recommendedExecutionMode: ExecutionMode;
  /** Estimated peak RAM/VRAM requirement in MB. */
  estimatedMemoryMb: number;
  /** Total download size across all required artifacts in bytes. */
  totalSizeBytes: number;
  /** All artifacts required to run this engine locally. */
  artifacts: ModelArtifact[];
  /** Explicit notes, caveats, or hardware requirements. */
  notes?: string[];
}

export interface PinnedModelManifest {
  /** Manifest schema version. */
  schemaVersion: 1;
  /** ISO-8601 timestamp when manifest was generated/verified. */
  generatedAt: string;
  /** Default recommended engine ID. */
  defaultEngineId: string;
  /** Keyed or ordered list of pinned model entries. */
  models: ModelManifestEntry[];
}
