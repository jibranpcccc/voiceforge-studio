/**
 * Model artifact cache built on Cache Storage API (`voiceforge-models-v1`)
 * with OPFS fallback/support and zero duplicate storage.
 *
 * All downloaded or locally imported model artifacts are verified for exact
 * `sizeBytes` and SHA-256 digest via Web Crypto before being committed.
 */

import { resolveArtifactUrl } from '../models/manifest';
import type { ModelArtifact, ModelManifestEntry } from '../types';

export const MODEL_CACHE_NAME = 'voiceforge-models-v1';
export const DEFAULT_ARTIFACT_MAX_ATTEMPTS = 3;
export const DEFAULT_RETRY_BASE_DELAY_MS = 500;
const TRANSIENT_HTTP_STATUSES = new Set([408, 429, 500, 502, 503, 504]);
const CACHE_URL_ORIGIN = 'https://voiceforge-cache.local';
const HEADER_SHA256 = 'X-VoiceForge-Sha256';
const HEADER_SIZE_BYTES = 'X-VoiceForge-Size-Bytes';
const HEADER_ENGINE_ID = 'X-VoiceForge-Engine-Id';
const HEADER_REVISION = 'X-VoiceForge-Revision';
const HEADER_RELATIVE_PATH = 'X-VoiceForge-Relative-Path';

export type ModelCacheBackend = 'cache-storage' | 'opfs';

export interface ArtifactDownloadProgress {
  artifact: ModelArtifact;
  loadedBytes: number;
  totalBytes: number;
  fraction: number;
}

export interface ModelDownloadProgress {
  phase: 'checking' | 'downloading' | 'verifying' | 'ready';
  artifact: ModelArtifact;
  completedArtifacts: number;
  totalArtifacts: number;
  loadedBytes: number;
  totalBytes: number;
  fraction: number;
}

export interface DownloadModelOptions {
  /** Custom base URL for self-hosted model files. */
  customBaseUrl?: string;
  /** Optional AbortSignal to cancel in-flight downloads. */
  signal?: AbortSignal;
  /** Custom fetch implementation (primarily for testing). */
  fetchImpl?: typeof fetch;
  /** Progress callback fired during streaming downloads and verification. */
  onProgress?: (progress: ModelDownloadProgress) => void;
  /** Preferred storage backend; falls back automatically if unavailable. */
  preferredBackend?: ModelCacheBackend;
  /** Also download non-required artifacts if present (default: false). */
  includeOptional?: boolean;
  /** Maximum attempts per artifact on transient network/stream errors (default: 3). */
  maxAttempts?: number;
  /** Base delay in ms for exponential backoff between retry attempts (default: 500). */
  retryBaseDelayMs?: number;
}

export interface ArtifactVerificationResult {
  relativePath: string;
  role: string;
  ok: boolean;
  reason?: string;
  actualSizeBytes?: number;
  actualSha256?: string;
}

export interface ModelVerificationReport {
  engineId: string;
  revision: string;
  ok: boolean;
  artifacts: ArtifactVerificationResult[];
}

export class ArtifactIntegrityError extends Error {
  readonly relativePath: string;
  readonly expected: string;
  readonly actual: string;

  constructor(message: string, relativePath: string, expected: string, actual: string) {
    super(message);
    this.name = 'ArtifactIntegrityError';
    this.relativePath = relativePath;
    this.expected = expected;
    this.actual = actual;
  }
}

/**
 * Build a normalized artifact cache key: `${engineId}/${revision}/${relativePath}`.
 */
export function buildArtifactCacheKey(
  engineId: string,
  revision: string,
  relativePath: string
): string {
  const cleanEngine = engineId.replace(/^\/+|\/+$/g, '');
  const cleanRevision = revision.replace(/^\/+|\/+$/g, '');
  const cleanPath = relativePath.replace(/^\/+/, '');
  return `${cleanEngine}/${cleanRevision}/${cleanPath}`;
}

function buildCacheStorageUrl(cacheKey: string): string {
  return `${CACHE_URL_ORIGIN}/${cacheKey}`;
}

function parseCacheStorageUrl(url: string): string | null {
  const prefix = `${CACHE_URL_ORIGIN}/`;
  if (!url.startsWith(prefix)) return null;
  return url.slice(prefix.length);
}

/**
 * Compute lowercase hex SHA-256 digest using Web Crypto (`crypto.subtle.digest`).
 */
export async function computeSha256Hex(
  data: ArrayBuffer | Uint8Array
): Promise<string> {
  if (!globalThis.crypto?.subtle) {
    throw new Error('Web Crypto API (crypto.subtle.digest) is unavailable in this context.');
  }
  const view =
    data instanceof Uint8Array
      ? new Uint8Array(data.buffer, data.byteOffset, data.byteLength)
      : new Uint8Array(data);
  // Copy into a clean ArrayBuffer-backed Uint8Array so TypeScript strict BufferSource checks pass cleanly.
  const copy = new Uint8Array(view.byteLength);
  copy.set(view);
  const digest = await globalThis.crypto.subtle.digest('SHA-256', copy.buffer);
  const bytes = new Uint8Array(digest);
  let hex = '';
  for (let i = 0; i < bytes.length; i += 1) {
    hex += bytes[i].toString(16).padStart(2, '0');
  }
  return hex;
}

function hasCacheStorage(): boolean {
  return typeof globalThis.caches !== 'undefined' && typeof globalThis.caches.open === 'function';
}

function hasOpfs(): boolean {
  return (
    typeof navigator !== 'undefined' &&
    typeof navigator.storage?.getDirectory === 'function'
  );
}

function createAbortError(): Error {
  if (typeof DOMException !== 'undefined') {
    return new DOMException('Operation aborted', 'AbortError');
  }
  const err = new Error('Operation aborted');
  err.name = 'AbortError';
  return err;
}

function throwIfAborted(signal?: AbortSignal): void {
  if (signal?.aborted) {
    throw createAbortError();
  }
}

function isAbortError(err: unknown): boolean {
  if (err instanceof Error && err.name === 'AbortError') {
    return true;
  }
  return (
    typeof DOMException !== 'undefined' &&
    err instanceof DOMException &&
    err.name === 'AbortError'
  );
}

class TransientHttpError extends Error {
  readonly status: number;

  constructor(message: string, status: number) {
    super(message);
    this.name = 'TransientHttpError';
    this.status = status;
  }
}

function isTransientDownloadError(err: unknown): boolean {
  if (isAbortError(err)) return false;
  if (err instanceof ArtifactIntegrityError) {
    return err.message.startsWith('Truncated download ');
  }
  if (err instanceof TransientHttpError) return true;
  if (err instanceof TypeError) return true;
  if (err instanceof Error) {
    return /network|fetch|timeout|econnreset|socket|stream/i.test(err.message);
  }
  return false;
}

function sleepWithAbort(ms: number, signal?: AbortSignal): Promise<void> {
  throwIfAborted(signal);
  if (ms <= 0) return Promise.resolve();
  return new Promise<void>((resolve, reject) => {
    const timer = setTimeout(() => {
      signal?.removeEventListener('abort', onAbort);
      resolve();
    }, ms);
    const onAbort = () => {
      clearTimeout(timer);
      signal?.removeEventListener('abort', onAbort);
      reject(createAbortError());
    };
    signal?.addEventListener('abort', onAbort, { once: true });
  });
}

async function getOpfsRootDir(create: boolean): Promise<FileSystemDirectoryHandle | null> {
  if (!hasOpfs()) return null;
  try {
    const root = await navigator.storage.getDirectory();
    return await root.getDirectoryHandle(MODEL_CACHE_NAME, { create });
  } catch {
    return null;
  }
}

async function getOpfsNestedFile(
  rootDir: FileSystemDirectoryHandle,
  segments: string[],
  create: boolean
): Promise<FileSystemFileHandle | null> {
  try {
    let dir = rootDir;
    for (let i = 0; i < segments.length - 1; i += 1) {
      dir = await dir.getDirectoryHandle(segments[i], { create });
    }
    return await dir.getFileHandle(segments[segments.length - 1], { create });
  } catch {
    return null;
  }
}

async function writeToOpfs(cacheKey: string, bytes: Uint8Array): Promise<boolean> {
  const rootDir = await getOpfsRootDir(true);
  if (!rootDir) return false;
  const segments = cacheKey.split('/').filter(Boolean);
  const fileHandle = await getOpfsNestedFile(rootDir, segments, true);
  if (!fileHandle) return false;
  const writable = await fileHandle.createWritable();
  try {
    const copy = new Uint8Array(bytes.byteLength);
    copy.set(bytes);
    await writable.write(copy.buffer);
    await writable.close();
    return true;
  } catch (err) {
    await writable.abort();
    throw err;
  }
}

async function readFromOpfs(cacheKey: string): Promise<{ bytes: ArrayBuffer; size: number } | null> {
  const rootDir = await getOpfsRootDir(false);
  if (!rootDir) return null;
  const segments = cacheKey.split('/').filter(Boolean);
  const fileHandle = await getOpfsNestedFile(rootDir, segments, false);
  if (!fileHandle) return null;
  const file = await fileHandle.getFile();
  return { bytes: await file.arrayBuffer(), size: file.size };
}

async function statOpfs(cacheKey: string): Promise<number | null> {
  const rootDir = await getOpfsRootDir(false);
  if (!rootDir) return null;
  const segments = cacheKey.split('/').filter(Boolean);
  const fileHandle = await getOpfsNestedFile(rootDir, segments, false);
  if (!fileHandle) return null;
  const file = await fileHandle.getFile();
  return file.size;
}

async function deleteOpfsEntry(cacheKey: string): Promise<boolean> {
  const rootDir = await getOpfsRootDir(false);
  if (!rootDir) return false;
  const segments = cacheKey.split('/').filter(Boolean);
  try {
    let dir = rootDir;
    for (let i = 0; i < segments.length - 1; i += 1) {
      dir = await dir.getDirectoryHandle(segments[i], { create: false });
    }
    await dir.removeEntry(segments[segments.length - 1]);
    return true;
  } catch {
    return false;
  }
}

async function listOpfsFileSizes(
  dir: FileSystemDirectoryHandle,
  prefix: string = ''
): Promise<Array<{ key: string; size: number }>> {
  const results: Array<{ key: string; size: number }> = [];
  const entries = (
    dir as unknown as {
      entries?: () => AsyncIterable<[string, FileSystemHandle]>;
    }
  ).entries;
  if (typeof entries !== 'function') {
    return results;
  }
  for await (const [name, handle] of entries.call(dir)) {
    const currentPath = prefix ? `${prefix}/${name}` : name;
    if (handle.kind === 'file') {
      const file = await (handle as FileSystemFileHandle).getFile();
      results.push({ key: currentPath, size: file.size });
    } else if (handle.kind === 'directory') {
      const nested = await listOpfsFileSizes(handle as FileSystemDirectoryHandle, currentPath);
      results.push(...nested);
    }
  }
  return results;
}

async function writeToCacheStorage(
  entry: ModelManifestEntry,
  artifact: ModelArtifact,
  bytes: Uint8Array
): Promise<void> {
  const cache = await caches.open(MODEL_CACHE_NAME);
  const key = buildArtifactCacheKey(entry.engineId, entry.revision, artifact.relativePath);
  const url = buildCacheStorageUrl(key);
  const copy = new Uint8Array(bytes.byteLength);
  copy.set(bytes);
  const headers = new Headers({
    'Content-Type': artifact.format === 'json' ? 'application/json' : 'application/octet-stream',
    'Content-Length': String(bytes.byteLength),
    [HEADER_SHA256]: artifact.sha256.toLowerCase(),
    [HEADER_SIZE_BYTES]: String(artifact.sizeBytes),
    [HEADER_ENGINE_ID]: entry.engineId,
    [HEADER_REVISION]: entry.revision,
    [HEADER_RELATIVE_PATH]: artifact.relativePath,
  });
  await cache.put(url, new Response(copy.buffer, { status: 200, headers }));
}

async function commitVerifiedArtifact(
  entry: ModelManifestEntry,
  artifact: ModelArtifact,
  bytes: Uint8Array,
  preferredBackend?: ModelCacheBackend
): Promise<ModelCacheBackend> {
  const key = buildArtifactCacheKey(entry.engineId, entry.revision, artifact.relativePath);
  const tryOrder: ModelCacheBackend[] =
    preferredBackend === 'opfs'
      ? ['opfs', 'cache-storage']
      : ['cache-storage', 'opfs'];

  let lastError: unknown;
  for (const backend of tryOrder) {
    if (backend === 'cache-storage' && hasCacheStorage()) {
      try {
        await writeToCacheStorage(entry, artifact, bytes);
        // Ensure zero duplicate storage across backends.
        await deleteOpfsEntry(key);
        return 'cache-storage';
      } catch (err) {
        lastError = err;
      }
    }
    if (backend === 'opfs' && hasOpfs()) {
      try {
        const written = await writeToOpfs(key, bytes);
        if (written) {
          if (hasCacheStorage()) {
            const cache = await caches.open(MODEL_CACHE_NAME);
            await cache.delete(buildCacheStorageUrl(key));
          }
          return 'opfs';
        }
      } catch (err) {
        lastError = err;
      }
    }
  }

  throw new Error(
    `No browser model storage backend (Cache Storage or OPFS) succeeded for ${key}${
      lastError instanceof Error ? `: ${lastError.message}` : ''
    }`
  );
}

/**
 * Verify byte size and SHA-256 digest of raw artifact bytes before committing to cache.
 */
export async function verifyArtifactBytes(
  artifact: Pick<ModelArtifact, 'relativePath' | 'sizeBytes' | 'sha256'>,
  bytes: Uint8Array | ArrayBuffer
): Promise<string> {
  const view =
    bytes instanceof Uint8Array
      ? bytes
      : new Uint8Array(bytes);

  if (view.byteLength !== artifact.sizeBytes) {
    throw new ArtifactIntegrityError(
      `Size mismatch for ${artifact.relativePath}: expected ${artifact.sizeBytes} bytes, got ${view.byteLength} bytes`,
      artifact.relativePath,
      String(artifact.sizeBytes),
      String(view.byteLength)
    );
  }

  const actualSha256 = await computeSha256Hex(view);
  if (actualSha256 !== artifact.sha256.toLowerCase()) {
    throw new ArtifactIntegrityError(
      `SHA-256 mismatch for ${artifact.relativePath}: expected ${artifact.sha256.toLowerCase()}, got ${actualSha256}`,
      artifact.relativePath,
      artifact.sha256.toLowerCase(),
      actualSha256
    );
  }

  return actualSha256;
}

async function readStreamWithProgress(
  response: Response,
  artifact: ModelArtifact,
  signal?: AbortSignal,
  onChunk?: (loadedBytes: number) => void
): Promise<Uint8Array> {
  if (!response.body || typeof response.body.getReader !== 'function') {
    throwIfAborted(signal);
    const buffer = await response.arrayBuffer();
    throwIfAborted(signal);
    const bytes = new Uint8Array(buffer);
    onChunk?.(bytes.byteLength);
    return bytes;
  }

  const reader = response.body.getReader();
  const output = new Uint8Array(artifact.sizeBytes);
  let receivedBytes = 0;

  try {
    while (true) {
      throwIfAborted(signal);
      const { done, value } = await reader.read();
      if (done) break;
      if (!value || value.byteLength === 0) continue;

      if (receivedBytes + value.byteLength > artifact.sizeBytes) {
        await reader.cancel();
        throw new ArtifactIntegrityError(
          `Downloaded stream for ${artifact.relativePath} exceeded expected ${artifact.sizeBytes} bytes`,
          artifact.relativePath,
          String(artifact.sizeBytes),
          `>${artifact.sizeBytes}`
        );
      }

      output.set(value, receivedBytes);
      receivedBytes += value.byteLength;
      onChunk?.(receivedBytes);
    }
  } catch (err) {
    try {
      await reader.cancel();
    } catch {
      // Ignore cancel errors.
    }
    throw err;
  }

  if (receivedBytes !== artifact.sizeBytes) {
    throw new ArtifactIntegrityError(
      `Truncated download for ${artifact.relativePath}: expected ${artifact.sizeBytes} bytes, received ${receivedBytes} bytes`,
      artifact.relativePath,
      String(artifact.sizeBytes),
      String(receivedBytes)
    );
  }

  return output;
}

/**
 * Retrieve a cached artifact's raw `ArrayBuffer` if present in Cache Storage or OPFS.
 */
export async function getCachedArtifact(
  engineId: string,
  revision: string,
  relativePath: string
): Promise<ArrayBuffer | null> {
  const key = buildArtifactCacheKey(engineId, revision, relativePath);

  if (hasCacheStorage()) {
    const cache = await caches.open(MODEL_CACHE_NAME);
    const matched = await cache.match(buildCacheStorageUrl(key));
    if (matched) {
      return await matched.arrayBuffer();
    }
  }

  const opfsEntry = await readFromOpfs(key);
  return opfsEntry ? opfsEntry.bytes : null;
}

/**
 * Fast manifest + byte-size readiness check for an artifact without re-hashing.
 * Returns the backend where the matching artifact is stored, or `null` if absent/mismatched.
 */
async function findCachedArtifactBackend(
  entry: ModelManifestEntry,
  artifact: ModelArtifact
): Promise<ModelCacheBackend | null> {
  const key = buildArtifactCacheKey(entry.engineId, entry.revision, artifact.relativePath);

  if (hasCacheStorage()) {
    const cache = await caches.open(MODEL_CACHE_NAME);
    const matched = await cache.match(buildCacheStorageUrl(key));
    if (matched) {
      const headerSize = matched.headers.get(HEADER_SIZE_BYTES) ?? matched.headers.get('Content-Length');
      const headerSha = matched.headers.get(HEADER_SHA256);
      if (headerSha && headerSha.toLowerCase() !== artifact.sha256.toLowerCase()) {
        return null;
      }
      if (headerSize !== null && headerSize.trim() !== '') {
        const parsedSize = Number(headerSize);
        if (Number.isFinite(parsedSize)) {
          return parsedSize === artifact.sizeBytes ? 'cache-storage' : null;
        }
      }
      const buffer = await matched.arrayBuffer();
      return buffer.byteLength === artifact.sizeBytes ? 'cache-storage' : null;
    }
  }

  const opfsSize = await statOpfs(key);
  return opfsSize !== null && opfsSize === artifact.sizeBytes ? 'opfs' : null;
}

async function isArtifactCachedWithExpectedMetadata(
  entry: ModelManifestEntry,
  artifact: ModelArtifact
): Promise<boolean> {
  return (await findCachedArtifactBackend(entry, artifact)) !== null;
}

/**
 * Return `true` ONLY when 100% of `required` artifacts for `entry` exist in cache
 * and match expected byte sizes and manifest metadata.
 */
export async function isModelOfflineReady(entry: ModelManifestEntry): Promise<boolean> {
  const requiredArtifacts = entry.artifacts.filter((a) => a.required);
  if (requiredArtifacts.length === 0) return false;

  for (const artifact of requiredArtifacts) {
    const present = await isArtifactCachedWithExpectedMetadata(entry, artifact);
    if (!present) {
      return false;
    }
  }

  return true;
}

async function downloadVerifyAndCommitAttempt(
  entry: ModelManifestEntry,
  artifact: ModelArtifact,
  url: string,
  fetchImpl: typeof fetch,
  options: {
    signal?: AbortSignal;
    preferredBackend?: ModelCacheBackend;
    onProgress?: (progress: ArtifactDownloadProgress) => void;
  }
): Promise<ModelCacheBackend> {
  throwIfAborted(options.signal);
  const response = await fetchImpl(url, { signal: options.signal });
  if (!response.ok) {
    const message = `Failed to download ${artifact.relativePath} (${url}): HTTP ${response.status}`;
    if (TRANSIENT_HTTP_STATUSES.has(response.status)) {
      throw new TransientHttpError(message, response.status);
    }
    throw new Error(message);
  }

  const bytes = await readStreamWithProgress(
    response,
    artifact,
    options.signal,
    (loadedBytes) => {
      options.onProgress?.({
        artifact,
        loadedBytes,
        totalBytes: artifact.sizeBytes,
        fraction: artifact.sizeBytes > 0 ? loadedBytes / artifact.sizeBytes : 1,
      });
    }
  );

  throwIfAborted(options.signal);
  await verifyArtifactBytes(artifact, bytes);
  throwIfAborted(options.signal);

  return await commitVerifiedArtifact(entry, artifact, bytes, options.preferredBackend);
}

/**
 * Download, stream-verify (`sizeBytes` + SHA-256), and cache a single artifact,
 * automatically retrying transient network/stream failures with exponential backoff.
 */
export async function downloadAndCacheArtifact(
  entry: ModelManifestEntry,
  artifact: ModelArtifact,
  options: {
    customBaseUrl?: string;
    signal?: AbortSignal;
    fetchImpl?: typeof fetch;
    preferredBackend?: ModelCacheBackend;
    onProgress?: (progress: ArtifactDownloadProgress) => void;
    maxAttempts?: number;
    retryBaseDelayMs?: number;
    force?: boolean;
  } = {}
): Promise<ModelCacheBackend> {
  throwIfAborted(options.signal);

  if (!options.force) {
    const cachedBackend = await findCachedArtifactBackend(entry, artifact);
    if (cachedBackend) {
      options.onProgress?.({
        artifact,
        loadedBytes: artifact.sizeBytes,
        totalBytes: artifact.sizeBytes,
        fraction: 1,
      });
      return cachedBackend;
    }
  }

  const fetchImpl = options.fetchImpl ?? fetch;
  const url = resolveArtifactUrl(artifact, {
    customBaseUrl: options.customBaseUrl,
    engineId: entry.engineId,
  });

  const maxAttempts = Math.max(
    1,
    Math.floor(options.maxAttempts ?? DEFAULT_ARTIFACT_MAX_ATTEMPTS)
  );
  const retryBaseDelayMs = Math.max(
    0,
    options.retryBaseDelayMs ?? DEFAULT_RETRY_BASE_DELAY_MS
  );

  let lastError: unknown;
  for (let attempt = 1; attempt <= maxAttempts; attempt += 1) {
    throwIfAborted(options.signal);
    try {
      return await downloadVerifyAndCommitAttempt(entry, artifact, url, fetchImpl, options);
    } catch (err) {
      if (options.signal?.aborted || isAbortError(err)) {
        throw options.signal?.aborted ? createAbortError() : err;
      }
      lastError = err;
      const shouldRetry = attempt < maxAttempts && isTransientDownloadError(err);
      if (!shouldRetry) {
        throw err;
      }
      const delayMs = retryBaseDelayMs * 2 ** (attempt - 1);
      await sleepWithAbort(delayMs, options.signal);
    }
  }

  throw lastError;
}

/**
 * Download and verify all required (or all) artifacts for a pinned model manifest entry.
 */
export async function downloadAndCacheModel(
  entry: ModelManifestEntry,
  options: DownloadModelOptions = {}
): Promise<void> {
  const targetArtifacts = options.includeOptional
    ? entry.artifacts
    : entry.artifacts.filter((a) => a.required);

  const totalBytes = targetArtifacts.reduce((sum, a) => sum + a.sizeBytes, 0);
  let completedArtifacts = 0;
  let completedBytes = 0;

  for (const artifact of targetArtifacts) {
    throwIfAborted(options.signal);

    options.onProgress?.({
      phase: 'checking',
      artifact,
      completedArtifacts,
      totalArtifacts: targetArtifacts.length,
      loadedBytes: completedBytes,
      totalBytes,
      fraction: totalBytes > 0 ? completedBytes / totalBytes : 0,
    });

    const alreadyCached = await isArtifactCachedWithExpectedMetadata(entry, artifact);
    if (alreadyCached) {
      completedArtifacts += 1;
      completedBytes += artifact.sizeBytes;
      continue;
    }

    await downloadAndCacheArtifact(entry, artifact, {
      customBaseUrl: options.customBaseUrl,
      signal: options.signal,
      fetchImpl: options.fetchImpl,
      preferredBackend: options.preferredBackend,
      maxAttempts: options.maxAttempts,
      retryBaseDelayMs: options.retryBaseDelayMs,
      onProgress: (itemProgress) => {
        const aggregateLoaded = completedBytes + itemProgress.loadedBytes;
        options.onProgress?.({
          phase:
            itemProgress.loadedBytes >= itemProgress.totalBytes
              ? 'verifying'
              : 'downloading',
          artifact,
          completedArtifacts,
          totalArtifacts: targetArtifacts.length,
          loadedBytes: aggregateLoaded,
          totalBytes,
          fraction: totalBytes > 0 ? aggregateLoaded / totalBytes : 1,
        });
      },
    });

    completedArtifacts += 1;
    completedBytes += artifact.sizeBytes;
  }

  if (targetArtifacts.length > 0) {
    options.onProgress?.({
      phase: 'ready',
      artifact: targetArtifacts[targetArtifacts.length - 1],
      completedArtifacts,
      totalArtifacts: targetArtifacts.length,
      loadedBytes: totalBytes,
      totalBytes,
      fraction: 1,
    });
  }
}

/**
 * Re-read and cryptographically re-hash every cached artifact for `entry`.
 */
export async function verifyCachedModel(
  entry: ModelManifestEntry
): Promise<ModelVerificationReport> {
  const results: ArtifactVerificationResult[] = [];

  for (const artifact of entry.artifacts) {
    const buffer = await getCachedArtifact(
      entry.engineId,
      entry.revision,
      artifact.relativePath
    );

    if (!buffer) {
      results.push({
        relativePath: artifact.relativePath,
        role: artifact.role,
        ok: !artifact.required,
        reason: artifact.required ? 'Missing from cache' : 'Optional artifact not cached',
      });
      continue;
    }

    try {
      const actualSha256 = await verifyArtifactBytes(artifact, buffer);
      results.push({
        relativePath: artifact.relativePath,
        role: artifact.role,
        ok: true,
        actualSizeBytes: buffer.byteLength,
        actualSha256,
      });
    } catch (err) {
      results.push({
        relativePath: artifact.relativePath,
        role: artifact.role,
        ok: false,
        reason: err instanceof Error ? err.message : String(err),
        actualSizeBytes: buffer.byteLength,
      });
    }
  }

  return {
    engineId: entry.engineId,
    revision: entry.revision,
    ok: results.every((r) => r.ok),
    artifacts: results,
  };
}

/**
 * Calculate total cached bytes for a given `engineId` (optionally scoped to `revision`).
 * Deduplicates across Cache Storage and OPFS if any legacy overlap exists.
 */
export async function getCachedSizeBytes(
  engineId: string,
  revision?: string
): Promise<number> {
  const prefix = revision
    ? `${engineId.replace(/^\/+|\/+$/g, '')}/${revision.replace(/^\/+|\/+$/g, '')}/`
    : `${engineId.replace(/^\/+|\/+$/g, '')}/`;

  const sizesByKey = new Map<string, number>();

  if (hasCacheStorage()) {
    const cache = await caches.open(MODEL_CACHE_NAME);
    const requests = await cache.keys();
    for (const req of requests) {
      const key = parseCacheStorageUrl(req.url);
      if (!key || !key.startsWith(prefix)) continue;
      const resp = await cache.match(req);
      if (!resp) continue;
      const headerSize =
        resp.headers.get(HEADER_SIZE_BYTES) ?? resp.headers.get('Content-Length');
      const size =
        headerSize !== null
          ? Number(headerSize)
          : (await resp.arrayBuffer()).byteLength;
      if (Number.isFinite(size) && size >= 0) {
        sizesByKey.set(key, size);
      }
    }
  }

  const rootDir = await getOpfsRootDir(false);
  if (rootDir) {
    const opfsFiles = await listOpfsFileSizes(rootDir);
    for (const item of opfsFiles) {
      if (item.key.startsWith(prefix) && !sizesByKey.has(item.key)) {
        sizesByKey.set(item.key, item.size);
      }
    }
  }

  let total = 0;
  for (const size of sizesByKey.values()) {
    total += size;
  }
  return total;
}

/**
 * Delete cached model artifacts for `engineId` (optionally scoped to a specific `revision`).
 */
export async function deleteCachedModel(
  engineId: string,
  revision?: string
): Promise<void> {
  const prefix = revision
    ? `${engineId.replace(/^\/+|\/+$/g, '')}/${revision.replace(/^\/+|\/+$/g, '')}/`
    : `${engineId.replace(/^\/+|\/+$/g, '')}/`;

  if (hasCacheStorage()) {
    const cache = await caches.open(MODEL_CACHE_NAME);
    const requests = await cache.keys();
    for (const req of requests) {
      const key = parseCacheStorageUrl(req.url);
      if (key && key.startsWith(prefix)) {
        await cache.delete(req);
      }
    }
  }

  const rootDir = await getOpfsRootDir(false);
  if (rootDir) {
    if (revision) {
      try {
        const engineDir = await rootDir.getDirectoryHandle(engineId, { create: false });
        await engineDir.removeEntry(revision, { recursive: true });
      } catch {
        // Not present in OPFS.
      }
    } else {
      try {
        await rootDir.removeEntry(engineId, { recursive: true });
      } catch {
        // Not present in OPFS.
      }
    }
  }
}

/**
 * Delete all cached model bundles across Cache Storage and OPFS.
 */
export async function clearAllModelCaches(): Promise<void> {
  if (hasCacheStorage()) {
    await caches.delete(MODEL_CACHE_NAME);
  }

  if (hasOpfs()) {
    try {
      const root = await navigator.storage.getDirectory();
      await root.removeEntry(MODEL_CACHE_NAME, { recursive: true });
    } catch {
      // Directory may not exist.
    }
  }
}

function getBasename(path: string): string {
  const normalized = path.replaceAll('\\', '/');
  const idx = normalized.lastIndexOf('/');
  return idx >= 0 ? normalized.slice(idx + 1) : normalized;
}

async function normalizeImportedFiles(
  files: FileList | File[] | Record<string, ArrayBuffer | Uint8Array>
): Promise<Map<string, ArrayBuffer>> {
  const byKey = new Map<string, ArrayBuffer>();

  const isFileListLike =
    typeof FileList !== 'undefined' && files instanceof FileList;

  if (Array.isArray(files) || isFileListLike) {
    const list = Array.from(files as ArrayLike<File>);
    for (const file of list) {
      const rel = (file as File & { webkitRelativePath?: string }).webkitRelativePath;
      const buffer = await file.arrayBuffer();
      if (rel) {
        byKey.set(rel.replace(/^\/+/, ''), buffer);
      }
      byKey.set(file.name, buffer);
    }
    return byKey;
  }

  for (const [name, value] of Object.entries(files)) {
    const cleanName = name.replaceAll('\\', '/').replace(/^\/+/, '');
    if (value instanceof Uint8Array) {
      const copy = new ArrayBuffer(value.byteLength);
      new Uint8Array(copy).set(value);
      byKey.set(cleanName, copy);
    } else {
      byKey.set(cleanName, value);
    }
  }

  return byKey;
}

/**
 * Import a locally supplied folder or file map (e.g. air-gapped / offline bundle),
 * verifying every required artifact's exact byte size and SHA-256 hash BEFORE caching.
 */
export async function importLocalModelBundle(
  entry: ModelManifestEntry,
  files: FileList | File[] | Record<string, ArrayBuffer | Uint8Array>,
  options: {
    preferredBackend?: ModelCacheBackend;
    includeOptional?: boolean;
  } = {}
): Promise<void> {
  const fileMap = await normalizeImportedFiles(files);
  const targetArtifacts = options.includeOptional
    ? entry.artifacts
    : entry.artifacts.filter((a) => a.required);

  const verifiedPayloads: Array<{ artifact: ModelArtifact; bytes: Uint8Array }> = [];

  for (const artifact of targetArtifacts) {
    const cleanRel = artifact.relativePath.replace(/^\/+/, '');
    const baseName = getBasename(cleanRel);

    let matchedBuffer = fileMap.get(cleanRel);
    if (!matchedBuffer) {
      // Match trailing relative path (e.g. user selected outer folder `pocket-tts-onnx/onnx/...`)
      for (const [candidateKey, buf] of fileMap.entries()) {
        if (candidateKey.endsWith(`/${cleanRel}`) || candidateKey === baseName) {
          matchedBuffer = buf;
          break;
        }
      }
    }

    if (!matchedBuffer) {
      throw new Error(
        `Missing required artifact '${artifact.relativePath}' in local model bundle.`
      );
    }

    const bytes = new Uint8Array(matchedBuffer);
    await verifyArtifactBytes(artifact, bytes);
    verifiedPayloads.push({ artifact, bytes });
  }

  // Commit only after 100% of artifacts pass size + SHA-256 verification.
  for (const { artifact, bytes } of verifiedPayloads) {
    await commitVerifiedArtifact(entry, artifact, bytes, options.preferredBackend);
  }
}
