/**
 * Portable VoiceProfile JSON export and strict, adversarial-safe import/validation.
 *
 * Converts `ArrayBuffer` conditioning tensors to base64 with SHA-256 integrity
 * metadata on export, and enforces strict schema, size, dtype/dims, HTML/script
 * sanitization, and engine/revision validation on import.
 */

import { computeSha256Hex } from '../storage/modelCache';
import type {
  AuthorizedUseConfirmation,
  AudioQualityAnalysis,
  ReferenceClipMetadata,
  SerializedTensorData,
  VoiceConditioningPayload,
  VoiceProfile,
} from '../types';

export const VOICE_PROFILE_BUNDLE_FORMAT = 'voiceforge-voice-profile' as const;
export const VOICE_PROFILE_SCHEMA_VERSION = 1 as const;
export const MAX_IMPORT_PAYLOAD_BYTES = 32 * 1024 * 1024; // 32 MB JSON ceiling
export const MAX_TENSOR_BYTE_LENGTH = 16 * 1024 * 1024; // 16 MB per tensor
export const MAX_TENSOR_COUNT_PER_PAYLOAD = 64;

const MAX_SHORT_STRING = 120;
const MAX_LONG_STRING = 2_000;
const MAX_TAGS = 20;

const VALID_DTYPES = new Set<SerializedTensorData['dtype']>([
  'float32',
  'float16',
  'int64',
  'int32',
  'uint8',
  'bool',
]);

const DTYPE_BYTES: Record<SerializedTensorData['dtype'], number> = {
  float32: 4,
  float16: 2,
  int64: 8,
  int32: 4,
  uint8: 1,
  bool: 1,
};

const VALID_SOURCES = new Set<ReferenceClipMetadata['source']>([
  'microphone',
  'file-upload',
  'sample',
]);

const VALID_AUTH_BASIS = new Set<AuthorizedUseConfirmation['sourceBasis']>([
  'self',
  'written-consent',
  'licensed-talent',
  'synthetic-character',
  'other',
]);

const FORBIDDEN_KEYS = new Set(['__proto__', 'constructor', 'prototype']);
const BASE64_RE = /^[A-Za-z0-9+/]*={0,2}$/;

export class VoiceProfileImportError extends Error {
  readonly code:
    | 'PAYLOAD_TOO_LARGE'
    | 'MALFORMED_JSON'
    | 'UNSUPPORTED_SCHEMA'
    | 'MISSING_FIELD'
    | 'INVALID_FIELD'
    | 'TENSOR_MISMATCH'
    | 'INTEGRITY_MISMATCH'
    | 'ENGINE_INCOMPATIBLE';

  constructor(
    code: VoiceProfileImportError['code'],
    message: string
  ) {
    super(message);
    this.name = 'VoiceProfileImportError';
    this.code = code;
  }
}

export interface ExportedSerializedTensor {
  dtype: SerializedTensorData['dtype'];
  dims: number[];
  byteLength: number;
  sha256: string;
  dataBase64: string;
}

export interface ExportedVoiceConditioningPayload {
  engineId: string;
  modelRevision: string;
  payloadVersion: number;
  precision: string;
  tensors: Record<string, ExportedSerializedTensor>;
  createdAt: string;
  metadata?: Record<string, string | number | boolean>;
}

export interface VoiceProfileBundle {
  format: typeof VOICE_PROFILE_BUNDLE_FORMAT;
  schemaVersion: typeof VOICE_PROFILE_SCHEMA_VERSION;
  exportedAt: string;
  integrity: {
    algorithm: 'SHA-256';
    bundleSha256: string;
    tensorCount: number;
    totalTensorBytes: number;
  };
  profile: Omit<VoiceProfile, 'conditioningPayloads'> & {
    conditioningPayloads: Record<string, ExportedVoiceConditioningPayload>;
  };
}

export interface ImportVoiceProfileOptions {
  /** Optional required engineId that the imported profile must support. */
  expectedEngineId?: string;
  /** Optional required modelRevision (paired with expectedEngineId). */
  expectedModelRevision?: string;
  /** Optional custom max raw JSON size in bytes (defaults to 32 MB). */
  maxPayloadBytes?: number;
  /** Generate a new UUID if true (default: false, keeps validated ID). */
  assignNewId?: boolean;
}

export interface VoiceProfileImportResult {
  profile: VoiceProfile;
  compatibleTargets: Array<{ engineId: string; modelRevision: string }>;
  warnings: string[];
}

function arrayBufferToBase64(buffer: ArrayBuffer): string {
  const bytes = new Uint8Array(buffer);
  const chunkSize = 0x8000;
  let binary = '';
  for (let i = 0; i < bytes.length; i += chunkSize) {
    const slice = bytes.subarray(i, Math.min(i + chunkSize, bytes.length));
    binary += String.fromCharCode(...slice);
  }
  return btoa(binary);
}

function base64ToArrayBuffer(base64: string, fieldName: string): ArrayBuffer {
  const clean = base64.replace(/\s+/g, '');
  if (clean.length % 4 !== 0 || !BASE64_RE.test(clean)) {
    throw new VoiceProfileImportError(
      'INVALID_FIELD',
      `Invalid base64 encoding in tensor '${fieldName}'.`
    );
  }
  let binary: string;
  try {
    binary = atob(clean);
  } catch {
    throw new VoiceProfileImportError(
      'INVALID_FIELD',
      `Malformed base64 data in tensor '${fieldName}'.`
    );
  }
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i += 1) {
    bytes[i] = binary.charCodeAt(i);
  }
  return bytes.buffer;
}

function stripControlChars(input: string): string {
  let out = '';
  for (let i = 0; i < input.length; i += 1) {
    const code = input.charCodeAt(i);
    if ((code >= 0x00 && code <= 0x08) || code === 0x0b || code === 0x0c || (code >= 0x0e && code <= 0x1f) || code === 0x7f) {
      continue;
    }
    out += input[i];
  }
  return out;
}

/**
 * Strip `<script>/<style>` blocks, HTML tags, and control characters, and bound string length.
 */
export function sanitizeProfileText(
  value: string,
  maxLength: number = MAX_SHORT_STRING
): string {
  // Remove script/style tag blocks including their inner text first
  let clean = value.replace(/<(script|style)\b[^>]*>[\s\S]*?<\/\1>/gi, '');
  // Strip remaining HTML tags
  clean = clean.replace(/<[^>]*>/g, '');
  clean = stripControlChars(clean);
  clean = clean.replace(/\s+/g, ' ').trim();
  if (clean.length > maxLength) {
    clean = clean.slice(0, maxLength).trim();
  }
  return clean;
}

function isPlainRecord(value: unknown): value is Record<string, unknown> {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    return false;
  }
  const keys = Object.keys(value);
  return !keys.some((k) => FORBIDDEN_KEYS.has(k));
}

function assertNonEmptyString(
  raw: unknown,
  field: string,
  maxLength: number
): string {
  if (typeof raw !== 'string') {
    throw new VoiceProfileImportError('MISSING_FIELD', `Field '${field}' must be a string.`);
  }
  const sanitized = sanitizeProfileText(raw, maxLength);
  if (!sanitized) {
    throw new VoiceProfileImportError(
      'MISSING_FIELD',
      `Field '${field}' must be a non-empty string after sanitization.`
    );
  }
  return sanitized;
}

function assertOptionalString(
  raw: unknown,
  field: string,
  maxLength: number
): string | undefined {
  if (raw === undefined || raw === null) return undefined;
  if (typeof raw !== 'string') {
    throw new VoiceProfileImportError('INVALID_FIELD', `Field '${field}' must be a string.`);
  }
  const sanitized = sanitizeProfileText(raw, maxLength);
  return sanitized || undefined;
}

function assertFiniteNumber(
  raw: unknown,
  field: string,
  min = -Infinity,
  max = Infinity
): number {
  if (typeof raw !== 'number' || !Number.isFinite(raw) || raw < min || raw > max) {
    throw new VoiceProfileImportError(
      'INVALID_FIELD',
      `Field '${field}' must be a finite number within [${min}, ${max}].`
    );
  }
  return raw;
}

function assertIsoDate(raw: unknown, field: string): string {
  if (typeof raw !== 'string' || Number.isNaN(Date.parse(raw))) {
    throw new VoiceProfileImportError(
      'INVALID_FIELD',
      `Field '${field}' must be a valid ISO-8601 timestamp.`
    );
  }
  return raw;
}

/**
 * Compute deterministic bundle SHA-256 over the exported profile payload
 * (excluding the `integrity.bundleSha256` field itself).
 */
async function computeBundleIntegrityHash(
  payload: Omit<VoiceProfileBundle, 'integrity'> & {
    integrity: Omit<VoiceProfileBundle['integrity'], 'bundleSha256'>;
  }
): Promise<string> {
  const encoded = new TextEncoder().encode(JSON.stringify(payload));
  return await computeSha256Hex(encoded);
}

/**
 * Export a `VoiceProfile` into a portable JSON-serializable bundle with base64 tensors
 * and SHA-256 integrity metadata.
 */
export async function exportVoiceProfile(
  profile: VoiceProfile
): Promise<VoiceProfileBundle> {
  const exportedPayloads: Record<string, ExportedVoiceConditioningPayload> = {};
  let tensorCount = 0;
  let totalTensorBytes = 0;

  for (const [key, payload] of Object.entries(profile.conditioningPayloads)) {
    const exportedTensors: Record<string, ExportedSerializedTensor> = {};
    for (const [tensorName, tensor] of Object.entries(payload.tensors)) {
      const sha256 = await computeSha256Hex(tensor.data);
      tensorCount += 1;
      totalTensorBytes += tensor.data.byteLength;
      exportedTensors[tensorName] = {
        dtype: tensor.dtype,
        dims: [...tensor.dims],
        byteLength: tensor.data.byteLength,
        sha256,
        dataBase64: arrayBufferToBase64(tensor.data),
      };
    }

    exportedPayloads[key] = {
      engineId: payload.engineId,
      modelRevision: payload.modelRevision,
      payloadVersion: payload.payloadVersion,
      precision: payload.precision,
      tensors: exportedTensors,
      createdAt: payload.createdAt,
      ...(payload.metadata ? { metadata: { ...payload.metadata } } : {}),
    };
  }

  const baseBundle = {
    format: VOICE_PROFILE_BUNDLE_FORMAT,
    schemaVersion: VOICE_PROFILE_SCHEMA_VERSION,
    exportedAt: new Date().toISOString(),
    integrity: {
      algorithm: 'SHA-256' as const,
      tensorCount,
      totalTensorBytes,
    },
    profile: {
      id: profile.id,
      name: profile.name,
      ...(profile.description !== undefined ? { description: profile.description } : {}),
      language: profile.language,
      tags: [...profile.tags],
      referenceClip: { ...profile.referenceClip },
      qualityAnalysis: {
        ...profile.qualityAnalysis,
        clipping: { ...profile.qualityAnalysis.clipping },
        silence: { ...profile.qualityAnalysis.silence },
        reverbEstimate: { ...profile.qualityAnalysis.reverbEstimate },
        multiSpeakerEstimate: { ...profile.qualityAnalysis.multiSpeakerEstimate },
        warnings: [...profile.qualityAnalysis.warnings],
        recommendations: [...profile.qualityAnalysis.recommendations],
      },
      authorizedUse: { ...profile.authorizedUse },
      conditioningPayloads: exportedPayloads,
      ...(profile.previewClipId !== undefined ? { previewClipId: profile.previewClipId } : {}),
      createdAt: profile.createdAt,
      updatedAt: profile.updatedAt,
    },
  };

  const bundleSha256 = await computeBundleIntegrityHash(baseBundle);

  return {
    ...baseBundle,
    integrity: {
      ...baseBundle.integrity,
      bundleSha256,
    },
  };
}

/**
 * Convenience wrapper returning pretty-printed JSON for download/export.
 */
export async function exportVoiceProfileJson(profile: VoiceProfile): Promise<string> {
  const bundle = await exportVoiceProfile(profile);
  return JSON.stringify(bundle, null, 2);
}

function parseQualityAnalysis(raw: unknown): AudioQualityAnalysis {
  if (!isPlainRecord(raw)) {
    throw new VoiceProfileImportError('MISSING_FIELD', 'qualityAnalysis must be an object.');
  }
  if (!isPlainRecord(raw.clipping) || !isPlainRecord(raw.silence)) {
    throw new VoiceProfileImportError(
      'MISSING_FIELD',
      'qualityAnalysis.clipping and qualityAnalysis.silence are required.'
    );
  }
  if (!isPlainRecord(raw.reverbEstimate) || !isPlainRecord(raw.multiSpeakerEstimate)) {
    throw new VoiceProfileImportError(
      'MISSING_FIELD',
      'qualityAnalysis.reverbEstimate and qualityAnalysis.multiSpeakerEstimate are required.'
    );
  }

  const reverbLevel = raw.reverbEstimate.level;
  if (reverbLevel !== 'dry' && reverbLevel !== 'moderate' && reverbLevel !== 'reverberant') {
    throw new VoiceProfileImportError('INVALID_FIELD', 'Invalid reverbEstimate.level.');
  }

  return {
    clipping: {
      clippedSampleCount: assertFiniteNumber(raw.clipping.clippedSampleCount, 'clipping.clippedSampleCount', 0),
      clippedPercentage: assertFiniteNumber(raw.clipping.clippedPercentage, 'clipping.clippedPercentage', 0, 100),
      hasSevereClipping: Boolean(raw.clipping.hasSevereClipping),
    },
    silence: {
      leadingSilenceSec: assertFiniteNumber(raw.silence.leadingSilenceSec, 'silence.leadingSilenceSec', 0),
      trailingSilenceSec: assertFiniteNumber(raw.silence.trailingSilenceSec, 'silence.trailingSilenceSec', 0),
      silenceRatio: assertFiniteNumber(raw.silence.silenceRatio, 'silence.silenceRatio', 0, 1),
      activeSpeechDurationSec: assertFiniteNumber(raw.silence.activeSpeechDurationSec, 'silence.activeSpeechDurationSec', 0),
    },
    noiseFloorDb: assertFiniteNumber(raw.noiseFloorDb, 'qualityAnalysis.noiseFloorDb', -160, 0),
    estimatedSnrDb: assertFiniteNumber(raw.estimatedSnrDb, 'qualityAnalysis.estimatedSnrDb', -40, 160),
    rmsDb: assertFiniteNumber(raw.rmsDb, 'qualityAnalysis.rmsDb', -160, 0),
    peakDb: assertFiniteNumber(raw.peakDb, 'qualityAnalysis.peakDb', -160, 20),
    reverbEstimate: {
      score: assertFiniteNumber(raw.reverbEstimate.score, 'reverbEstimate.score', 0, 1),
      level: reverbLevel,
    },
    multiSpeakerEstimate: {
      score: assertFiniteNumber(raw.multiSpeakerEstimate.score, 'multiSpeakerEstimate.score', 0, 1),
      suspectedMultipleSpeakers: Boolean(raw.multiSpeakerEstimate.suspectedMultipleSpeakers),
    },
    durationSec: assertFiniteNumber(raw.durationSec, 'qualityAnalysis.durationSec', 0, 3600),
    sampleRate: assertFiniteNumber(raw.sampleRate, 'qualityAnalysis.sampleRate', 8000, 192000),
    channels: assertFiniteNumber(raw.channels, 'qualityAnalysis.channels', 1, 8),
    overallScore: assertFiniteNumber(raw.overallScore, 'qualityAnalysis.overallScore', 0, 100),
    warnings: Array.isArray(raw.warnings)
      ? raw.warnings.slice(0, 20).map((w) => sanitizeProfileText(String(w), 240)).filter(Boolean)
      : [],
    recommendations: Array.isArray(raw.recommendations)
      ? raw.recommendations.slice(0, 20).map((r) => sanitizeProfileText(String(r), 240)).filter(Boolean)
      : [],
  };
}

/**
 * Strictly parse, sanitize, and validate a serialized `VoiceProfileBundle`.
 * Never uses `eval` or executes imported strings.
 */
export async function importVoiceProfile(
  input: string | unknown,
  options: ImportVoiceProfileOptions = {}
): Promise<VoiceProfileImportResult> {
  const maxBytes = options.maxPayloadBytes ?? MAX_IMPORT_PAYLOAD_BYTES;

  let parsed: unknown;
  if (typeof input === 'string') {
    if (input.length > maxBytes) {
      throw new VoiceProfileImportError(
        'PAYLOAD_TOO_LARGE',
        `Imported voice profile exceeds maximum allowed size (${maxBytes} bytes).`
      );
    }
    try {
      parsed = JSON.parse(input);
    } catch {
      throw new VoiceProfileImportError('MALFORMED_JSON', 'Imported file is not valid JSON.');
    }
  } else {
    parsed = input;
  }

  if (!isPlainRecord(parsed)) {
    throw new VoiceProfileImportError('MALFORMED_JSON', 'Bundle root must be a plain JSON object.');
  }

  if (parsed.format !== VOICE_PROFILE_BUNDLE_FORMAT) {
    throw new VoiceProfileImportError(
      'UNSUPPORTED_SCHEMA',
      `Unsupported voice profile bundle format '${String(parsed.format)}'.`
    );
  }

  if (parsed.schemaVersion !== VOICE_PROFILE_SCHEMA_VERSION) {
    throw new VoiceProfileImportError(
      'UNSUPPORTED_SCHEMA',
      `Unsupported schemaVersion '${String(parsed.schemaVersion)}'. Expected ${VOICE_PROFILE_SCHEMA_VERSION}.`
    );
  }

  if (!isPlainRecord(parsed.integrity)) {
    throw new VoiceProfileImportError('MISSING_FIELD', 'Bundle integrity metadata is missing.');
  }

  const rawProfile = parsed.profile;
  if (!isPlainRecord(rawProfile)) {
    throw new VoiceProfileImportError('MISSING_FIELD', 'Bundle profile object is missing.');
  }

  // Verify bundle-level SHA-256 if provided
  if (typeof parsed.integrity.bundleSha256 === 'string') {
    const { bundleSha256, ...restIntegrity } = parsed.integrity;
    const expectedHash = await computeBundleIntegrityHash({
      format: VOICE_PROFILE_BUNDLE_FORMAT,
      schemaVersion: VOICE_PROFILE_SCHEMA_VERSION,
      exportedAt: String(parsed.exportedAt ?? ''),
      integrity: {
        algorithm: 'SHA-256',
        tensorCount: Number(restIntegrity.tensorCount ?? 0),
        totalTensorBytes: Number(restIntegrity.totalTensorBytes ?? 0),
      },
      profile: rawProfile as VoiceProfileBundle['profile'],
    });
    if (expectedHash !== bundleSha256.toLowerCase()) {
      throw new VoiceProfileImportError(
        'INTEGRITY_MISMATCH',
        'Bundle integrity SHA-256 checksum does not match file contents.'
      );
    }
  }

  const id = options.assignNewId
    ? typeof crypto !== 'undefined' && typeof crypto.randomUUID === 'function'
      ? crypto.randomUUID()
      : `voice-${Date.now()}`
    : assertNonEmptyString(rawProfile.id, 'profile.id', MAX_SHORT_STRING);
  const name = assertNonEmptyString(rawProfile.name, 'profile.name', MAX_SHORT_STRING);
  const description = assertOptionalString(rawProfile.description, 'profile.description', MAX_LONG_STRING);
  const language = assertNonEmptyString(rawProfile.language, 'profile.language', 24);
  const createdAt = assertIsoDate(rawProfile.createdAt, 'profile.createdAt');
  const updatedAt = assertIsoDate(rawProfile.updatedAt, 'profile.updatedAt');

  if (!Array.isArray(rawProfile.tags)) {
    throw new VoiceProfileImportError('MISSING_FIELD', 'profile.tags must be an array.');
  }
  const tags = rawProfile.tags
    .slice(0, MAX_TAGS)
    .map((t) => (typeof t === 'string' ? sanitizeProfileText(t, 40) : ''))
    .filter(Boolean);

  if (!isPlainRecord(rawProfile.referenceClip)) {
    throw new VoiceProfileImportError('MISSING_FIELD', 'profile.referenceClip is required.');
  }
  const rawClip = rawProfile.referenceClip;
  if (typeof rawClip.source !== 'string' || !VALID_SOURCES.has(rawClip.source as ReferenceClipMetadata['source'])) {
    throw new VoiceProfileImportError('INVALID_FIELD', 'referenceClip.source is invalid.');
  }
  const referenceClip: ReferenceClipMetadata = {
    clipId: assertNonEmptyString(rawClip.clipId, 'referenceClip.clipId', MAX_SHORT_STRING),
    filename: assertNonEmptyString(rawClip.filename, 'referenceClip.filename', MAX_SHORT_STRING),
    mimeType: assertNonEmptyString(rawClip.mimeType, 'referenceClip.mimeType', MAX_SHORT_STRING),
    source: rawClip.source as ReferenceClipMetadata['source'],
    durationSec: assertFiniteNumber(rawClip.durationSec, 'referenceClip.durationSec', 0.1, 3600),
    sampleRate: assertFiniteNumber(rawClip.sampleRate, 'referenceClip.sampleRate', 8000, 192000),
    channels: assertFiniteNumber(rawClip.channels, 'referenceClip.channels', 1, 8),
    ...(assertOptionalString(rawClip.transcript, 'referenceClip.transcript', MAX_LONG_STRING)
      ? { transcript: assertOptionalString(rawClip.transcript, 'referenceClip.transcript', MAX_LONG_STRING) }
      : {}),
    ...(assertOptionalString(rawClip.language, 'referenceClip.language', 24)
      ? { language: assertOptionalString(rawClip.language, 'referenceClip.language', 24) }
      : {}),
    ...(assertOptionalString(rawClip.pcmSha256, 'referenceClip.pcmSha256', 64)
      ? { pcmSha256: assertOptionalString(rawClip.pcmSha256, 'referenceClip.pcmSha256', 64) }
      : {}),
    capturedAt: assertIsoDate(rawClip.capturedAt, 'referenceClip.capturedAt'),
  };

  const qualityAnalysis = parseQualityAnalysis(rawProfile.qualityAnalysis);

  if (!isPlainRecord(rawProfile.authorizedUse)) {
    throw new VoiceProfileImportError('MISSING_FIELD', 'profile.authorizedUse is required.');
  }
  const rawAuth = rawProfile.authorizedUse;
  if (typeof rawAuth.confirmed !== 'boolean') {
    throw new VoiceProfileImportError('INVALID_FIELD', 'authorizedUse.confirmed must be a boolean.');
  }
  if (
    typeof rawAuth.sourceBasis !== 'string' ||
    !VALID_AUTH_BASIS.has(rawAuth.sourceBasis as AuthorizedUseConfirmation['sourceBasis'])
  ) {
    throw new VoiceProfileImportError('INVALID_FIELD', 'authorizedUse.sourceBasis is invalid.');
  }
  const authorizedUse: AuthorizedUseConfirmation = {
    confirmed: rawAuth.confirmed,
    confirmedAt: assertIsoDate(rawAuth.confirmedAt, 'authorizedUse.confirmedAt'),
    attestationText: assertNonEmptyString(
      rawAuth.attestationText,
      'authorizedUse.attestationText',
      MAX_LONG_STRING
    ),
    sourceBasis: rawAuth.sourceBasis as AuthorizedUseConfirmation['sourceBasis'],
    verificationScope: 'client-self-attested',
  };

  if (!isPlainRecord(rawProfile.conditioningPayloads)) {
    throw new VoiceProfileImportError(
      'MISSING_FIELD',
      'profile.conditioningPayloads must be an object.'
    );
  }

  const conditioningPayloads: Record<string, VoiceConditioningPayload> = {};
  const compatibleTargets: Array<{ engineId: string; modelRevision: string }> = [];
  const warnings: string[] = [];

  for (const [payloadKey, rawPayload] of Object.entries(rawProfile.conditioningPayloads)) {
    if (!isPlainRecord(rawPayload)) {
      throw new VoiceProfileImportError(
        'INVALID_FIELD',
        `Conditioning payload '${payloadKey}' must be an object.`
      );
    }

    const engineId = assertNonEmptyString(rawPayload.engineId, `conditioningPayloads[${payloadKey}].engineId`, 64);
    const modelRevision = assertNonEmptyString(
      rawPayload.modelRevision,
      `conditioningPayloads[${payloadKey}].modelRevision`,
      128
    );
    const expectedKey = `${engineId}::${modelRevision}`;
    if (payloadKey !== expectedKey) {
      throw new VoiceProfileImportError(
        'ENGINE_INCOMPATIBLE',
        `Conditioning payload key '${payloadKey}' does not match tagged '${expectedKey}'.`
      );
    }

    const payloadVersion = assertFiniteNumber(
      rawPayload.payloadVersion,
      `conditioningPayloads[${payloadKey}].payloadVersion`,
      1,
      100
    );
    const precision = assertNonEmptyString(
      rawPayload.precision,
      `conditioningPayloads[${payloadKey}].precision`,
      32
    );
    const payloadCreatedAt = assertIsoDate(
      rawPayload.createdAt,
      `conditioningPayloads[${payloadKey}].createdAt`
    );

    if (!isPlainRecord(rawPayload.tensors)) {
      throw new VoiceProfileImportError(
        'MISSING_FIELD',
        `Conditioning payload '${payloadKey}' must contain tensors.`
      );
    }

    const tensorEntries = Object.entries(rawPayload.tensors);
    if (tensorEntries.length > MAX_TENSOR_COUNT_PER_PAYLOAD) {
      throw new VoiceProfileImportError(
        'PAYLOAD_TOO_LARGE',
        `Conditioning payload '${payloadKey}' exceeds maximum tensor count (${MAX_TENSOR_COUNT_PER_PAYLOAD}).`
      );
    }

    const tensors: Record<string, SerializedTensorData> = {};
    for (const [tensorName, rawTensor] of tensorEntries) {
      const cleanName = sanitizeProfileText(tensorName, 64);
      if (!cleanName || !isPlainRecord(rawTensor)) {
        throw new VoiceProfileImportError(
          'INVALID_FIELD',
          `Tensor '${tensorName}' in '${payloadKey}' is malformed.`
        );
      }

      if (typeof rawTensor.dtype !== 'string' || !VALID_DTYPES.has(rawTensor.dtype as SerializedTensorData['dtype'])) {
        throw new VoiceProfileImportError(
          'INVALID_FIELD',
          `Tensor '${cleanName}' has unsupported dtype '${String(rawTensor.dtype)}'.`
        );
      }
      const dtype = rawTensor.dtype as SerializedTensorData['dtype'];

      if (!Array.isArray(rawTensor.dims) || rawTensor.dims.length > 8) {
        throw new VoiceProfileImportError(
          'INVALID_FIELD',
          `Tensor '${cleanName}' dims must be an array of at most 8 dimensions.`
        );
      }
      const dims = rawTensor.dims.map((d) => {
        if (typeof d !== 'number' || !Number.isInteger(d) || d < 0 || d > 10_000_000) {
          throw new VoiceProfileImportError(
            'INVALID_FIELD',
            `Tensor '${cleanName}' contains invalid dimension '${String(d)}'.`
          );
        }
        return d;
      });

      const elementCount = dims.reduce((acc, dim) => acc * dim, 1);
      const expectedByteLength = elementCount * DTYPE_BYTES[dtype];
      if (!Number.isSafeInteger(expectedByteLength) || expectedByteLength > MAX_TENSOR_BYTE_LENGTH) {
        throw new VoiceProfileImportError(
          'PAYLOAD_TOO_LARGE',
          `Tensor '${cleanName}' byte size exceeds safety limit.`
        );
      }

      if (typeof rawTensor.dataBase64 !== 'string') {
        throw new VoiceProfileImportError(
          'MISSING_FIELD',
          `Tensor '${cleanName}' is missing dataBase64.`
        );
      }

      const decodedBuffer = base64ToArrayBuffer(rawTensor.dataBase64, cleanName);
      if (decodedBuffer.byteLength !== expectedByteLength) {
        throw new VoiceProfileImportError(
          'TENSOR_MISMATCH',
          `Tensor '${cleanName}' byte length (${decodedBuffer.byteLength}) does not match dims [${dims.join(', ')}] x ${dtype} (${expectedByteLength} bytes).`
        );
      }

      if (typeof rawTensor.byteLength === 'number' && rawTensor.byteLength !== decodedBuffer.byteLength) {
        throw new VoiceProfileImportError(
          'TENSOR_MISMATCH',
          `Tensor '${cleanName}' declared byteLength (${rawTensor.byteLength}) does not match decoded bytes (${decodedBuffer.byteLength}).`
        );
      }

      if (typeof rawTensor.sha256 === 'string') {
        const actualSha = await computeSha256Hex(decodedBuffer);
        if (actualSha !== rawTensor.sha256.toLowerCase()) {
          throw new VoiceProfileImportError(
            'INTEGRITY_MISMATCH',
            `Tensor '${cleanName}' SHA-256 mismatch.`
          );
        }
      }

      tensors[cleanName] = {
        dtype,
        dims,
        data: decodedBuffer,
      };
    }

    let sanitizedMetadata: Record<string, string | number | boolean> | undefined;
    if (rawPayload.metadata !== undefined) {
      if (!isPlainRecord(rawPayload.metadata)) {
        throw new VoiceProfileImportError('INVALID_FIELD', 'Payload metadata must be an object.');
      }
      sanitizedMetadata = {};
      for (const [mKey, mVal] of Object.entries(rawPayload.metadata)) {
        const cleanKey = sanitizeProfileText(mKey, 64);
        if (!cleanKey) continue;
        if (typeof mVal === 'string') {
          sanitizedMetadata[cleanKey] = sanitizeProfileText(mVal, 256);
        } else if ((typeof mVal === 'number' && Number.isFinite(mVal)) || typeof mVal === 'boolean') {
          sanitizedMetadata[cleanKey] = mVal;
        }
      }
    }

    conditioningPayloads[expectedKey] = {
      engineId,
      modelRevision,
      payloadVersion,
      precision,
      tensors,
      createdAt: payloadCreatedAt,
      ...(sanitizedMetadata ? { metadata: sanitizedMetadata } : {}),
    };
    compatibleTargets.push({ engineId, modelRevision });
  }

  if (compatibleTargets.length === 0) {
    throw new VoiceProfileImportError(
      'ENGINE_INCOMPATIBLE',
      'Imported voice profile contains zero conditioning payloads.'
    );
  }

  if (options.expectedEngineId) {
    const match = compatibleTargets.find(
      (target) =>
        target.engineId === options.expectedEngineId &&
        (!options.expectedModelRevision || target.modelRevision === options.expectedModelRevision)
    );
    if (!match) {
      const targetLabel = options.expectedModelRevision
        ? `${options.expectedEngineId}::${options.expectedModelRevision}`
        : options.expectedEngineId;
      throw new VoiceProfileImportError(
        'ENGINE_INCOMPATIBLE',
        `Imported voice profile has no compatible conditioning payload for '${targetLabel}'.`
      );
    }
  }

  const profile: VoiceProfile = {
    id,
    name,
    ...(description !== undefined ? { description } : {}),
    language,
    tags,
    referenceClip,
    qualityAnalysis,
    authorizedUse,
    conditioningPayloads,
    createdAt,
    updatedAt,
  };

  return {
    profile,
    compatibleTargets,
    warnings,
  };
}
