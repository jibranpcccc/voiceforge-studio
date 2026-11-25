import { pcmToAudioBufferData } from '../../audio';
import {
  EngineRegistry,
  createDefaultEngineRegistry,
  defaultEngineRegistry,
  getCompatibleConditioningPayload,
} from '../../engines/registry';
import {
  detectHardwareCapabilities,
  type HardwareCapabilities,
} from '../../services/hardware';
import {
  DEFAULT_PREPROCESSING_OPTIONS,
  getStudioPreset,
} from '../../services/presets';
import { segmentScriptToProjectChunks } from '../../services/segmenter';
import { listProjectAudioChunks } from '../../storage/db';
import type {
  AudioBufferData,
  EngineLoadProgress,
  ExecutionMode,
  NarrationProject,
  PronunciationRule,
  ScriptChunk,
  StudioPresetId,
  VoiceCloningEngine,
  VoiceProfile,
} from '../../types';

/**
 * Ensure `defaultEngineRegistry` has `pocket-tts` and `chatterbox` registered.
 */
export function ensureDefaultEnginesRegistered(
  customModelBaseUrl?: string
): EngineRegistry {
  if (!defaultEngineRegistry.has('pocket-tts') || !defaultEngineRegistry.has('chatterbox')) {
    const fresh = createDefaultEngineRegistry({
      pocket: customModelBaseUrl ? { customModelBaseUrl } : undefined,
    });
    for (const engine of fresh.list()) {
      if (!defaultEngineRegistry.has(engine.id)) {
        defaultEngineRegistry.register(engine);
      }
    }
  }
  return defaultEngineRegistry;
}

/**
 * Check whether a VoiceProfile has a valid conditioning payload for a specific engine.
 */
export function isVoiceCompatibleWithEngine(
  profile: VoiceProfile | undefined | null,
  engine: Pick<VoiceCloningEngine, 'id' | 'getModelMetadata'> | undefined | null
): boolean {
  if (!profile || !engine) return false;
  return getCompatibleConditioningPayload(profile, engine) !== null;
}

/**
 * List engine IDs present in a VoiceProfile's conditioning payloads.
 */
export function getProfileEngineIds(profile: VoiceProfile): string[] {
  const ids = new Set<string>();
  for (const [key, payload] of Object.entries(profile.conditioningPayloads)) {
    if (payload?.engineId) {
      ids.add(payload.engineId);
    } else if (key.includes('::')) {
      ids.add(key.split('::')[0]);
    }
  }
  return Array.from(ids);
}

/**
 * Initialize an engine if not yet initialized, using detected browser thread constraints.
 */
export async function ensureEngineInitialized(
  engine: VoiceCloningEngine,
  executionMode: ExecutionMode,
  onProgress?: (progress: EngineLoadProgress) => void,
  signal?: AbortSignal
): Promise<HardwareCapabilities | null> {
  const meta = engine.getModelMetadata();
  if (meta.isInitialized) {
    return null;
  }
  const caps = await detectHardwareCapabilities();
  const preferredBackend =
    engine.capabilities.supportsWebGpu &&
    caps.webgpuSupported &&
    caps.webgpuAdapterAvailable &&
    executionMode !== 'cpu'
      ? 'webgpu'
      : 'wasm';

  await engine.initialize(
    {
      executionMode,
      preferredBackend,
      wasmThreads: caps.recommendedWasmThreads,
      signal,
    },
    onProgress
  );
  return caps;
}

/**
 * Load all cached PCM audio chunks for a project from IndexedDB keyed by `chunkId`.
 */
export async function loadProjectAudioChunkMap(
  projectId: string
): Promise<Map<string, AudioBufferData>> {
  const records = await listProjectAudioChunks(projectId);
  const map = new Map<string, AudioBufferData>();
  for (const rec of records) {
    const floatView = new Float32Array(rec.pcmBytes.slice(0));
    map.set(rec.chunkId, pcmToAudioBufferData(floatView, rec.sampleRate, 1));
  }
  return map;
}

/**
 * Format seconds into compact `mm:ss` or `hh:mm:ss` display.
 */
export function formatDurationCompact(seconds: number | null | undefined): string {
  if (seconds === null || seconds === undefined || !Number.isFinite(seconds) || seconds < 0) {
    return '0:00';
  }
  const rounded = Math.round(seconds);
  const hrs = Math.floor(rounded / 3600);
  const mins = Math.floor((rounded % 3600) / 60);
  const secs = rounded % 60;
  if (hrs > 0) {
    return `${hrs}:${String(mins).padStart(2, '0')}:${String(secs).padStart(2, '0')}`;
  }
  return `${mins}:${String(secs).padStart(2, '0')}`;
}

/**
 * Format byte count into human-readable MB/GB.
 */
export function formatBytes(bytes: number): string {
  if (!Number.isFinite(bytes) || bytes <= 0) return '0 B';
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  if (bytes < 1024 * 1024 * 1024) return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
  return `${(bytes / (1024 * 1024 * 1024)).toFixed(2)} GB`;
}

/**
 * Trigger a browser file download from bytes or text.
 */
export function triggerBrowserDownload(
  content: Uint8Array | string,
  mimeType: string,
  filename: string
): void {
  let blobPart: BlobPart;
  if (typeof content === 'string') {
    blobPart = content;
  } else {
    const copy = new Uint8Array(content.byteLength);
    copy.set(content);
    blobPart = copy.buffer;
  }
  const blob = new Blob([blobPart], { type: mimeType });
  const url = URL.createObjectURL(blob);
  const anchor = document.createElement('a');
  anchor.href = url;
  anchor.download = filename;
  document.body.appendChild(anchor);
  anchor.click();
  anchor.remove();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}

/**
 * Navigate hash route safely outside React render/effect immutability constraints.
 */
export function navigateToHash(hash: string): void {
  if (typeof globalThis.location !== 'undefined') {
    globalThis.location.hash = hash;
  }
}

const VALID_CHUNK_STATUSES = new Set<ScriptChunk['status']>([
  'pending',
  'queued',
  'synthesizing',
  'completed',
  'failed',
  'cancelled',
]);

const VALID_PRESETS = new Set<StudioPresetId>([
  'studio-quality',
  'natural-narration',
  'documentary',
  'educational',
  'storytelling',
  'fast-preview',
  'custom',
]);

const VALID_EXEC_MODES = new Set<ExecutionMode>(['quality', 'balanced', 'cpu']);

const FORBIDDEN_KEYS = new Set(['__proto__', 'constructor', 'prototype']);

function stripUnsafeText(input: unknown, maxLen: number): string {
  if (typeof input !== 'string') return '';
  return input.replace(/[\u0000-\u0008\u000B\u000C\u000E-\u001F]/g, '').slice(0, maxLen);
}

function isPlainObject(val: unknown): val is Record<string, unknown> {
  return typeof val === 'object' && val !== null && !Array.isArray(val);
}

function sanitizeFlatParams(raw: unknown): Record<string, number | string | boolean> {
  if (!isPlainObject(raw)) return {};
  const out: Record<string, number | string | boolean> = {};
  for (const [k, v] of Object.entries(raw)) {
    if (FORBIDDEN_KEYS.has(k)) continue;
    if (typeof v === 'number' && Number.isFinite(v)) {
      out[k] = v;
    } else if (typeof v === 'boolean') {
      out[k] = v;
    } else if (typeof v === 'string') {
      out[k] = stripUnsafeText(v, 120);
    }
  }
  return out;
}

/**
 * Strictly validate and sanitize an imported NarrationProject JSON payload.
 * Generates a new safe project ID if `assignNewId` is true and resets synthesized
 * audio chunk keys when no local IndexedDB audio blobs exist.
 */
export function sanitizeImportedProjectJson(
  raw: unknown,
  options: { assignNewId?: boolean } = {}
): NarrationProject {
  if (!isPlainObject(raw)) {
    throw new Error('Project JSON must be an object.');
  }
  const source = isPlainObject(raw.project) ? raw.project : raw;

  const name = stripUnsafeText(source.name, 120).trim();
  if (!name) {
    throw new Error('Imported project is missing a valid project name.');
  }

  const scriptText = stripUnsafeText(source.scriptText, 500_000);
  const engineId = stripUnsafeText(source.engineId, 64).trim() || 'pocket-tts';
  const executionMode: ExecutionMode =
    typeof source.executionMode === 'string' &&
    VALID_EXEC_MODES.has(source.executionMode as ExecutionMode)
      ? (source.executionMode as ExecutionMode)
      : 'balanced';

  const presetId: StudioPresetId =
    typeof source.presetId === 'string' && VALID_PRESETS.has(source.presetId as StudioPresetId)
      ? (source.presetId as StudioPresetId)
      : 'natural-narration';

  const preset = getStudioPreset(presetId);

  const sentencePauseMs =
    typeof source.sentencePauseMs === 'number' && Number.isFinite(source.sentencePauseMs)
      ? Math.max(0, Math.min(5000, source.sentencePauseMs))
      : preset.sentencePauseMs;
  const paragraphPauseMs =
    typeof source.paragraphPauseMs === 'number' && Number.isFinite(source.paragraphPauseMs)
      ? Math.max(0, Math.min(10000, source.paragraphPauseMs))
      : preset.paragraphPauseMs;
  const chunkCrossfadeMs =
    typeof source.chunkCrossfadeMs === 'number' && Number.isFinite(source.chunkCrossfadeMs)
      ? Math.max(0, Math.min(50, source.chunkCrossfadeMs))
      : preset.chunkCrossfadeMs;

  const pronunciationRules: PronunciationRule[] = Array.isArray(source.pronunciationRules)
    ? source.pronunciationRules
        .filter(isPlainObject)
        .slice(0, 500)
        .map((r, idx) => ({
          id: stripUnsafeText(r.id, 64).trim() || `imported-rule-${idx + 1}`,
          pattern: stripUnsafeText(r.pattern, 200),
          replacement: stripUnsafeText(r.replacement, 200),
          isRegex: Boolean(r.isRegex),
          caseSensitive: Boolean(r.caseSensitive),
          enabled: r.enabled !== false,
          ...(typeof r.note === 'string' ? { note: stripUnsafeText(r.note, 240) } : {}),
        }))
        .filter((r) => r.pattern.trim().length > 0)
    : [];

  const rawMastering = isPlainObject(source.mastering) ? source.mastering : {};
  const mastering = {
    ...preset.mastering,
    ...Object.fromEntries(
      Object.entries(rawMastering).filter(
        ([k, v]) =>
          !FORBIDDEN_KEYS.has(k) &&
          k in preset.mastering &&
          (typeof v === 'number' || typeof v === 'boolean' || typeof v === 'string')
      )
    ),
  };

  const rawPreproc = isPlainObject(source.preprocessing) ? source.preprocessing : {};
  const preprocessing = {
    ...DEFAULT_PREPROCESSING_OPTIONS,
    ...Object.fromEntries(
      Object.entries(rawPreproc).filter(
        ([k, v]) =>
          !FORBIDDEN_KEYS.has(k) &&
          k in DEFAULT_PREPROCESSING_OPTIONS &&
          (typeof v === 'number' || typeof v === 'boolean')
      )
    ),
  };

  const id =
    !options.assignNewId && typeof source.id === 'string' && source.id.trim()
      ? stripUnsafeText(source.id, 80).trim()
      : typeof crypto !== 'undefined' && typeof crypto.randomUUID === 'function'
        ? crypto.randomUUID()
        : `proj-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;

  const chunks: ScriptChunk[] =
    Array.isArray(source.chunks) && source.chunks.length > 0
      ? source.chunks
          .filter(isPlainObject)
          .slice(0, 5000)
          .map((c, idx) => {
            const rawText = stripUnsafeText(c.rawText, 4000);
            const normalizedText = stripUnsafeText(c.normalizedText, 4000) || rawText;
            const rawStatus =
              typeof c.status === 'string' && VALID_CHUNK_STATUSES.has(c.status as ScriptChunk['status'])
                ? (c.status as ScriptChunk['status'])
                : 'pending';
            // Imported JSON does not carry audio PCM blobs, so reset completed chunks to pending
            const safeStatus: ScriptChunk['status'] =
              rawStatus === 'completed' || rawStatus === 'synthesizing' || rawStatus === 'queued'
                ? 'pending'
                : rawStatus;

            return {
              id: stripUnsafeText(c.id, 80).trim() || `${id}-chunk-${idx + 1}`,
              index: typeof c.index === 'number' && Number.isInteger(c.index) ? c.index : idx,
              rawText,
              normalizedText,
              pauseAfterMs:
                typeof c.pauseAfterMs === 'number' && Number.isFinite(c.pauseAfterMs)
                  ? Math.max(0, Math.min(10000, c.pauseAfterMs))
                  : sentencePauseMs,
              status: safeStatus,
              ...(isPlainObject(c.parameterOverrides)
                ? { parameterOverrides: sanitizeFlatParams(c.parameterOverrides) }
                : {}),
            };
          })
      : segmentScriptToProjectChunks(scriptText, {
          engineId,
          sentencePauseMs,
          paragraphPauseMs,
          pronunciationRules,
          idPrefix: `${id}-chunk`,
        });

  const now = new Date().toISOString();
  return {
    id,
    name,
    ...(typeof source.description === 'string' && source.description.trim()
      ? { description: stripUnsafeText(source.description, 1000).trim() }
      : {}),
    voiceProfileId:
      typeof source.voiceProfileId === 'string' && source.voiceProfileId.trim()
        ? stripUnsafeText(source.voiceProfileId, 80).trim()
        : null,
    engineId,
    executionMode,
    presetId,
    scriptText,
    chunks,
    pronunciationRules,
    preprocessing,
    mastering,
    sentencePauseMs,
    paragraphPauseMs,
    chunkCrossfadeMs,
    engineParameters: {
      ...preset.engineParameters,
      ...sanitizeFlatParams(source.engineParameters),
    },
    createdAt:
      typeof source.createdAt === 'string' && !Number.isNaN(Date.parse(source.createdAt))
        ? source.createdAt
        : now,
    updatedAt: now,
  };
}
