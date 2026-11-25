/**
 * Voice profile, reference clip analysis, and authorization contracts.
 */

export interface AuthorizedUseConfirmation {
  /** Whether the user confirmed they are authorized to clone and use this voice. */
  confirmed: boolean;
  /** ISO-8601 timestamp when confirmation was recorded locally. */
  confirmedAt: string;
  /** Exact attestation text accepted by the user. */
  attestationText: string;
  /** Self-reported source relationship (e.g. own voice, explicit written consent, licensed voice actor). */
  sourceBasis: 'self' | 'written-consent' | 'licensed-talent' | 'synthetic-character' | 'other';
  /**
   * Client-side confirmations are local self-attestations only and are NOT
   * independently verified consent.
   */
  verificationScope: 'client-self-attested';
}

export interface ClippingAnalysis {
  /** Number of clipped samples (|sample| >= 0.999). */
  clippedSampleCount: number;
  /** Percentage of samples clipped (0-100). */
  clippedPercentage: number;
  /** Whether clipping exceeds acceptable threshold. */
  hasSevereClipping: boolean;
}

export interface SilenceAnalysis {
  /** Leading silence duration in seconds. */
  leadingSilenceSec: number;
  /** Trailing silence duration in seconds. */
  trailingSilenceSec: number;
  /** Fraction of total clip composed of silence (0-1). */
  silenceRatio: number;
  /** Active speech duration in seconds after excluding silence. */
  activeSpeechDurationSec: number;
}

export interface ReverbEstimate {
  /** Heuristic reverberation score from 0 (dry) to 1 (very reverberant). */
  score: number;
  /** Human-readable classification. */
  level: 'dry' | 'moderate' | 'reverberant';
}

export interface MultiSpeakerEstimate {
  /** Heuristic likelihood (0-1) that multiple speakers or overlapping voices are present. */
  score: number;
  /** Whether multiple speakers are suspected. */
  suspectedMultipleSpeakers: boolean;
}

export interface AudioQualityAnalysis {
  clipping: ClippingAnalysis;
  silence: SilenceAnalysis;
  /** Estimated noise floor in dBFS (negative value, e.g. -52). */
  noiseFloorDb: number;
  /** Estimated speech-to-noise ratio in dB. */
  estimatedSnrDb: number;
  /** Integrated RMS level in dBFS. */
  rmsDb: number;
  /** Peak sample amplitude in dBFS. */
  peakDb: number;
  reverbEstimate: ReverbEstimate;
  multiSpeakerEstimate: MultiSpeakerEstimate;
  /** Total duration in seconds. */
  durationSec: number;
  /** Original sample rate in Hz. */
  sampleRate: number;
  /** Channel count in source audio. */
  channels: number;
  /** Composite quality score from 0 to 100. */
  overallScore: number;
  /** Actionable warning messages detected during inspection. */
  warnings: string[];
  /** Suggested preprocessing or re-recording recommendations. */
  recommendations: string[];
}

export interface ReferenceClipMetadata {
  /** Unique clip identifier. */
  clipId: string;
  /** Original filename or recording label. */
  filename: string;
  /** MIME type of source recording if imported. */
  mimeType: string;
  /** Origin of the reference clip. */
  source: 'microphone' | 'file-upload' | 'sample';
  /** Duration in seconds (post-preprocessing if preprocessed). */
  durationSec: number;
  /** Sample rate in Hz. */
  sampleRate: number;
  /** Channel count. */
  channels: number;
  /** Optional transcript of the spoken reference clip (needed by some engines). */
  transcript?: string;
  /** Spoken language BCP-47 / ISO code (e.g. 'en', 'en-US'). */
  language?: string;
  /** SHA-256 hex digest of raw PCM samples for deduplication and integrity. */
  pcmSha256?: string;
  /** ISO-8601 timestamp when clip was captured or imported. */
  capturedAt: string;
}

/**
 * Engine-scoped voice conditioning payload.
 * Payloads are strictly tagged by `engineId` and `modelRevision` and MUST NEVER
 * be interchanged across incompatible engine architectures or revisions.
 */
export interface VoiceConditioningPayload {
  /** Engine identifier that produced this conditioning state. */
  engineId: string;
  /** Exact pinned model revision / commit SHA that produced this conditioning state. */
  modelRevision: string;
  /** Schema version of the conditioning payload for forward migration safety. */
  payloadVersion: number;
  /** Precision used when encoding (e.g. 'fp32', 'fp16', 'int8', 'q4'). */
  precision: string;
  /** Named tensor entries serialized as typed arrays or raw ArrayBuffers. */
  tensors: Record<string, SerializedTensorData>;
  /** ISO-8601 creation timestamp. */
  createdAt: string;
  /** Optional metadata specific to the engine. */
  metadata?: Record<string, string | number | boolean>;
}

export interface SerializedTensorData {
  /** Tensor data type matching ONNX Runtime Web tensor types. */
  dtype: 'float32' | 'float16' | 'int64' | 'int32' | 'uint8' | 'bool';
  /** Tensor shape dimensions. */
  dims: number[];
  /** Raw little-endian byte buffer of tensor elements. */
  data: ArrayBuffer;
}

export interface VoiceProfile {
  /** Unique profile ID (UUID). */
  id: string;
  /** Display name chosen by user. */
  name: string;
  /** Optional user notes about tone, accent, or intended use. */
  description?: string;
  /** Primary language code (e.g. 'en'). */
  language: string;
  /** User-defined tags for filtering. */
  tags: string[];
  /** Metadata of the primary reference clip. */
  referenceClip: ReferenceClipMetadata;
  /** Automated quality report for the reference clip. */
  qualityAnalysis: AudioQualityAnalysis;
  /** Local self-attested authorized-use confirmation. */
  authorizedUse: AuthorizedUseConfirmation;
  /**
   * Conditioning payloads keyed by `${engineId}::${modelRevision}` so a single
   * voice profile can store separate, non-interchangeable embeddings per engine.
   */
  conditioningPayloads: Record<string, VoiceConditioningPayload>;
  /** Optional normalized mono preview WAV/PCM stored for reference playback. */
  previewClipId?: string;
  /** ISO-8601 creation timestamp. */
  createdAt: string;
  /** ISO-8601 last update timestamp. */
  updatedAt: string;
}
