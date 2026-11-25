/**
 * Pinned model manifest validation, loading, and URL resolution.
 */

import type {
  ExecutionMode,
  ModelArtifact,
  ModelManifestEntry,
  PinnedModelManifest,
} from '../types';

const VALID_EXECUTION_MODES = new Set<ExecutionMode>(['quality', 'balanced', 'cpu']);
const VALID_ARTIFACT_FORMATS = new Set<ModelArtifact['format']>([
  'onnx',
  'onnx_data',
  'json',
  'bin',
  'spm',
  'txt',
  'other',
]);
const SHA256_HEX_RE = /^[0-9a-f]{64}$/i;
const PINNED_REVISION_RE = /^[0-9a-f]{7,64}$/i;

export class ManifestValidationError extends Error {
  readonly errors: string[];

  constructor(errors: string[]) {
    super(`Invalid model manifest: ${errors.join('; ')}`);
    this.name = 'ManifestValidationError';
    this.errors = errors;
  }
}

export type ManifestValidationResult =
  | { valid: true; manifest: PinnedModelManifest }
  | { valid: false; errors: string[] };

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function isNonEmptyString(value: unknown): value is string {
  return typeof value === 'string' && value.trim().length > 0;
}

function isValidRelativePath(path: string): boolean {
  if (!isNonEmptyString(path)) return false;
  if (path.startsWith('/') || path.includes('\\')) return false;
  const segments = path.split('/');
  return segments.every((segment) => segment.length > 0 && segment !== '.' && segment !== '..');
}

function isValidArtifactUrl(url: string): boolean {
  if (!isNonEmptyString(url)) return false;
  if (url.startsWith('./') || url.startsWith('/')) return true;
  try {
    const parsed = new URL(url);
    return parsed.protocol === 'https:' || parsed.protocol === 'http:';
  } catch {
    return false;
  }
}

function validateArtifact(
  raw: unknown,
  entryIndex: number,
  artifactIndex: number,
  errors: string[]
): ModelArtifact | null {
  const prefix = `models[${entryIndex}].artifacts[${artifactIndex}]`;
  if (!isPlainObject(raw)) {
    errors.push(`${prefix} must be an object`);
    return null;
  }

  if (!isNonEmptyString(raw.role)) {
    errors.push(`${prefix}.role must be a non-empty string`);
  }
  if (typeof raw.relativePath !== 'string' || !isValidRelativePath(raw.relativePath)) {
    errors.push(`${prefix}.relativePath must be a clean relative path without leading '/' or '..'`);
  }
  if (typeof raw.url !== 'string' || !isValidArtifactUrl(raw.url)) {
    errors.push(`${prefix}.url must be a valid http(s) or relative URL`);
  }
  if (typeof raw.sizeBytes !== 'number' || !Number.isInteger(raw.sizeBytes) || raw.sizeBytes <= 0) {
    errors.push(`${prefix}.sizeBytes must be a positive integer`);
  }
  if (typeof raw.sha256 !== 'string' || !SHA256_HEX_RE.test(raw.sha256)) {
    errors.push(`${prefix}.sha256 must be a 64-character hex SHA-256 digest`);
  }
  if (
    typeof raw.format !== 'string' ||
    !VALID_ARTIFACT_FORMATS.has(raw.format as ModelArtifact['format'])
  ) {
    errors.push(`${prefix}.format must be one of onnx, onnx_data, json, bin, spm, txt, other`);
  }
  if (typeof raw.required !== 'boolean') {
    errors.push(`${prefix}.required must be a boolean`);
  }

  if (errors.length > 0) {
    return raw as unknown as ModelArtifact;
  }

  return {
    role: (raw.role as string).trim(),
    relativePath: raw.relativePath as string,
    url: raw.url as string,
    sizeBytes: raw.sizeBytes as number,
    sha256: (raw.sha256 as string).toLowerCase(),
    format: raw.format as ModelArtifact['format'],
    required: raw.required as boolean,
  };
}

function validateManifestEntry(
  raw: unknown,
  index: number,
  errors: string[]
): ModelManifestEntry | null {
  const prefix = `models[${index}]`;
  if (!isPlainObject(raw)) {
    errors.push(`${prefix} must be an object`);
    return null;
  }

  const initialErrorCount = errors.length;

  if (!isNonEmptyString(raw.engineId)) {
    errors.push(`${prefix}.engineId must be a non-empty string`);
  }
  if (!isNonEmptyString(raw.displayName)) {
    errors.push(`${prefix}.displayName must be a non-empty string`);
  }
  if (!isNonEmptyString(raw.repoId)) {
    errors.push(`${prefix}.repoId must be a non-empty string`);
  }
  if (typeof raw.revision !== 'string' || !PINNED_REVISION_RE.test(raw.revision)) {
    errors.push(`${prefix}.revision must be a pinned commit SHA (7-64 hex characters)`);
  }
  if (!isNonEmptyString(raw.license)) {
    errors.push(`${prefix}.license must be a non-empty string`);
  }
  if (raw.licenseUrl !== undefined && (typeof raw.licenseUrl !== 'string' || !isValidArtifactUrl(raw.licenseUrl))) {
    errors.push(`${prefix}.licenseUrl must be a valid URL when provided`);
  }
  if (typeof raw.ungated !== 'boolean') {
    errors.push(`${prefix}.ungated must be a boolean`);
  }
  if (!isNonEmptyString(raw.precision)) {
    errors.push(`${prefix}.precision must be a non-empty string`);
  }
  if (typeof raw.sampleRate !== 'number' || !Number.isInteger(raw.sampleRate) || raw.sampleRate <= 0) {
    errors.push(`${prefix}.sampleRate must be a positive integer`);
  }
  if (
    typeof raw.recommendedExecutionMode !== 'string' ||
    !VALID_EXECUTION_MODES.has(raw.recommendedExecutionMode as ExecutionMode)
  ) {
    errors.push(`${prefix}.recommendedExecutionMode must be 'quality', 'balanced', or 'cpu'`);
  }
  if (
    typeof raw.estimatedMemoryMb !== 'number' ||
    !Number.isFinite(raw.estimatedMemoryMb) ||
    raw.estimatedMemoryMb <= 0
  ) {
    errors.push(`${prefix}.estimatedMemoryMb must be a positive number`);
  }
  if (
    typeof raw.totalSizeBytes !== 'number' ||
    !Number.isInteger(raw.totalSizeBytes) ||
    raw.totalSizeBytes <= 0
  ) {
    errors.push(`${prefix}.totalSizeBytes must be a positive integer`);
  }

  if (!Array.isArray(raw.artifacts) || raw.artifacts.length === 0) {
    errors.push(`${prefix}.artifacts must be a non-empty array`);
  } else {
    const roles = new Set<string>();
    const paths = new Set<string>();
    let requiredBytesSum = 0;

    for (let i = 0; i < raw.artifacts.length; i += 1) {
      const prevCount = errors.length;
      const artifact = validateArtifact(raw.artifacts[i], index, i, errors);
      if (artifact && errors.length === prevCount) {
        if (roles.has(artifact.role)) {
          errors.push(`${prefix}.artifacts[${i}].role '${artifact.role}' is duplicated`);
        }
        roles.add(artifact.role);
        if (paths.has(artifact.relativePath)) {
          errors.push(
            `${prefix}.artifacts[${i}].relativePath '${artifact.relativePath}' is duplicated`
          );
        }
        paths.add(artifact.relativePath);
        if (artifact.required) {
          requiredBytesSum += artifact.sizeBytes;
        }
      }
    }

    if (
      typeof raw.totalSizeBytes === 'number' &&
      errors.length === initialErrorCount &&
      requiredBytesSum !== raw.totalSizeBytes
    ) {
      errors.push(
        `${prefix}.totalSizeBytes (${raw.totalSizeBytes}) does not match sum of required artifacts (${requiredBytesSum})`
      );
    }
  }

  if (raw.notes !== undefined) {
    if (!Array.isArray(raw.notes) || raw.notes.some((n) => typeof n !== 'string')) {
      errors.push(`${prefix}.notes must be an array of strings when provided`);
    }
  }

  if (errors.length > initialErrorCount) {
    return null;
  }

  return raw as unknown as ModelManifestEntry;
}

/**
 * Validate a candidate pinned model manifest without throwing.
 */
export function safeValidateManifest(input: unknown): ManifestValidationResult {
  const errors: string[] = [];

  if (!isPlainObject(input)) {
    return { valid: false, errors: ['Manifest root must be an object'] };
  }

  if (input.schemaVersion !== 1) {
    errors.push('schemaVersion must equal 1');
  }
  if (!isNonEmptyString(input.generatedAt) || Number.isNaN(Date.parse(input.generatedAt))) {
    errors.push('generatedAt must be a valid ISO-8601 timestamp');
  }
  if (!isNonEmptyString(input.defaultEngineId)) {
    errors.push('defaultEngineId must be a non-empty string');
  }

  const validatedModels: ModelManifestEntry[] = [];
  if (!Array.isArray(input.models) || input.models.length === 0) {
    errors.push('models must be a non-empty array');
  } else {
    const engineIds = new Set<string>();
    for (let i = 0; i < input.models.length; i += 1) {
      const entry = validateManifestEntry(input.models[i], i, errors);
      if (entry) {
        if (engineIds.has(entry.engineId)) {
          errors.push(`models[${i}].engineId '${entry.engineId}' is duplicated`);
        }
        engineIds.add(entry.engineId);
        validatedModels.push(entry);
      }
    }

    if (
      isNonEmptyString(input.defaultEngineId) &&
      validatedModels.length > 0 &&
      !engineIds.has(input.defaultEngineId)
    ) {
      errors.push(
        `defaultEngineId '${input.defaultEngineId}' is not present in manifest models`
      );
    }
  }

  if (errors.length > 0) {
    return { valid: false, errors };
  }

  return {
    valid: true,
    manifest: {
      schemaVersion: 1,
      generatedAt: input.generatedAt as string,
      defaultEngineId: input.defaultEngineId as string,
      models: validatedModels,
    },
  };
}

/**
 * Validate a candidate pinned model manifest and return the typed manifest,
 * throwing `ManifestValidationError` on any schema or integrity error.
 */
export function validateManifest(input: unknown): PinnedModelManifest {
  const result = safeValidateManifest(input);
  if (!result.valid) {
    throw new ManifestValidationError(result.errors);
  }
  return result.manifest;
}

export interface ResolveArtifactUrlOptions {
  /** Custom base URL for self-hosted model mirrors (e.g. `./models/pocket-tts/`). */
  customBaseUrl?: string;
  /** Optional engine ID used to expand `{engineId}` placeholders in customBaseUrl. */
  engineId?: string;
}

/**
 * Resolve an artifact download URL.
 *
 * When `customBaseUrl` is omitted or empty, returns the pinned upstream URL
 * (e.g. Hugging Face commit-pinned URL for GitHub Pages mode).
 * When `customBaseUrl` is provided (e.g. `./models/pocket-tts/` for self-hosted
 * cPanel deployments), joins `customBaseUrl` with `artifact.relativePath`.
 */
export function resolveArtifactUrl(
  artifact: Pick<ModelArtifact, 'url' | 'relativePath'>,
  customBaseUrlOrOptions?: string | ResolveArtifactUrlOptions
): string {
  const options =
    typeof customBaseUrlOrOptions === 'string'
      ? { customBaseUrl: customBaseUrlOrOptions }
      : customBaseUrlOrOptions;

  const rawBase = options?.customBaseUrl?.trim();
  if (!rawBase) {
    return artifact.url;
  }

  const expandedBase = options?.engineId
    ? rawBase.replaceAll('{engineId}', encodeURIComponent(options.engineId))
    : rawBase;

  const cleanBase = expandedBase.replace(/\/+$/, '');
  const cleanRel = artifact.relativePath.replace(/^\/+/, '');
  return `${cleanBase}/${cleanRel}`;
}

/**
 * Return a copy of a manifest entry with all artifact URLs resolved against `customBaseUrl`.
 */
export function resolveEntryArtifactUrls(
  entry: ModelManifestEntry,
  customBaseUrl?: string
): ModelManifestEntry {
  if (!customBaseUrl?.trim()) {
    return entry;
  }
  return {
    ...entry,
    artifacts: entry.artifacts.map((artifact) => ({
      ...artifact,
      url: resolveArtifactUrl(artifact, {
        customBaseUrl,
        engineId: entry.engineId,
      }),
    })),
  };
}

/**
 * Look up a model entry by engine ID.
 */
export function getModelManifestEntry(
  manifest: PinnedModelManifest,
  engineId: string
): ModelManifestEntry | undefined {
  return manifest.models.find((model) => model.engineId === engineId);
}

/**
 * Merge or register an additional verified `ModelManifestEntry` into an existing
 * manifest (for example, registering Wave 2 optional engines) and re-validate.
 */
export function registerManifestEntry(
  manifest: PinnedModelManifest,
  entry: ModelManifestEntry
): PinnedModelManifest {
  const existingIndex = manifest.models.findIndex((m) => m.engineId === entry.engineId);
  const nextModels =
    existingIndex >= 0
      ? manifest.models.map((m, idx) => (idx === existingIndex ? entry : m))
      : [...manifest.models, entry];

  return validateManifest({
    ...manifest,
    models: nextModels,
  });
}

/**
 * Build the default manifest path respecting Vite's `BASE_URL`.
 */
export function getDefaultManifestUrl(): string {
  const baseUrl =
    typeof import.meta !== 'undefined' &&
    typeof import.meta.env?.BASE_URL === 'string'
      ? import.meta.env.BASE_URL
      : './';
  const normalizedBase = baseUrl.endsWith('/') ? baseUrl : `${baseUrl}/`;
  return `${normalizedBase}model-manifests/models.json`;
}

/**
 * Fetch and strictly validate the pinned model manifest JSON.
 */
export async function loadPinnedManifest(
  manifestUrl: string = getDefaultManifestUrl(),
  fetchImpl: typeof fetch = fetch
): Promise<PinnedModelManifest> {
  const response = await fetchImpl(manifestUrl, {
    headers: { Accept: 'application/json' },
  });
  if (!response.ok) {
    throw new Error(`Failed to fetch model manifest (${manifestUrl}): HTTP ${response.status}`);
  }
  const raw: unknown = await response.json();
  return validateManifest(raw);
}
