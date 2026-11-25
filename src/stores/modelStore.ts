/**
 * Model cache, pinned manifest loading, download progress/abort, offline readiness,
 * cryptographic integrity verification, and real measured RTF tracking store.
 */

import { create } from 'zustand';
import {
  getDefaultManifestUrl,
  getModelManifestEntry,
  loadPinnedManifest,
} from '../models/manifest';
import {
  deleteCachedModel,
  downloadAndCacheModel,
  getCachedSizeBytes,
  importLocalModelBundle,
  isModelOfflineReady,
  verifyCachedModel,
  type ModelDownloadProgress,
  type ModelVerificationReport,
} from '../storage/modelCache';
import type {
  ModelDownloadStatus,
  ModelManifestEntry,
  PinnedModelManifest,
} from '../types';

const STORAGE_MEASURED_RTF_KEY = 'vf_measured_rtf';

export interface MeasuredRtfRecord {
  rtf: number;
  lastGenerationMs: number | null;
  sampleCount: number;
  updatedAt: string;
}

export interface ModelRuntimeState {
  entry: ModelManifestEntry;
  status: ModelDownloadStatus;
  progress: ModelDownloadProgress | null;
  offlineReady: boolean;
  cachedSizeBytes: number;
  error: string | null;
  verificationReport: ModelVerificationReport | null;
  measuredRtf: MeasuredRtfRecord | null;
}

function readMeasuredRtfMap(): Record<string, MeasuredRtfRecord> {
  try {
    if (typeof globalThis.localStorage === 'undefined') return {};
    const raw = globalThis.localStorage.getItem(STORAGE_MEASURED_RTF_KEY);
    if (!raw) return {};
    const parsed: unknown = JSON.parse(raw);
    if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) {
      return {};
    }
    return parsed as Record<string, MeasuredRtfRecord>;
  } catch {
    return {};
  }
}

function writeMeasuredRtfMap(map: Record<string, MeasuredRtfRecord>): void {
  try {
    if (typeof globalThis.localStorage === 'undefined') return;
    globalThis.localStorage.setItem(STORAGE_MEASURED_RTF_KEY, JSON.stringify(map));
  } catch {
    // Ignore storage errors.
  }
}

const activeDownloads = new Map<string, AbortController>();

export interface ModelStoreState {
  manifest: PinnedModelManifest | null;
  manifestLoading: boolean;
  manifestError: string | null;
  models: Record<string, ModelRuntimeState>;

  loadManifest: (manifestUrl?: string) => Promise<PinnedModelManifest>;
  refreshCacheStatus: (engineId?: string) => Promise<void>;
  downloadModel: (engineId: string, customBaseUrl?: string) => Promise<void>;
  abortDownload: (engineId: string) => void;
  verifyModel: (engineId: string) => Promise<ModelVerificationReport>;
  deleteModel: (engineId: string) => Promise<void>;
  importLocalBundle: (
    engineId: string,
    files: FileList | File[] | Record<string, ArrayBuffer | Uint8Array>
  ) => Promise<void>;
  recordMeasuredRtf: (engineId: string, rtf: number, generationTimeMs?: number) => void;
  resetModelStates: () => void;
}

export const useModelStore = create<ModelStoreState>((set, get) => ({
  manifest: null,
  manifestLoading: false,
  manifestError: null,
  models: {},

  loadManifest: async (manifestUrl = getDefaultManifestUrl()) => {
    set({ manifestLoading: true, manifestError: null });
    try {
      const manifest = await loadPinnedManifest(manifestUrl);
      const savedRtf = readMeasuredRtfMap();
      const models: Record<string, ModelRuntimeState> = {};

      for (const entry of manifest.models) {
        const [offlineReady, cachedSizeBytes] = await Promise.all([
          isModelOfflineReady(entry),
          getCachedSizeBytes(entry.engineId, entry.revision),
        ]);
        models[entry.engineId] = {
          entry,
          status: offlineReady ? 'cached' : 'not-downloaded',
          progress: null,
          offlineReady,
          cachedSizeBytes,
          error: null,
          verificationReport: null,
          measuredRtf: savedRtf[entry.engineId] ?? null,
        };
      }

      set({ manifest, models, manifestLoading: false });
      return manifest;
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      set({ manifestLoading: false, manifestError: message });
      throw err;
    }
  },

  refreshCacheStatus: async (engineId) => {
    const { manifest, models } = get();
    if (!manifest) return;

    const targets = engineId
      ? manifest.models.filter((m) => m.engineId === engineId)
      : manifest.models;

    const updates: Record<string, ModelRuntimeState> = { ...models };
    for (const entry of targets) {
      const [offlineReady, cachedSizeBytes] = await Promise.all([
        isModelOfflineReady(entry),
        getCachedSizeBytes(entry.engineId, entry.revision),
      ]);
      const existing = updates[entry.engineId];
      updates[entry.engineId] = {
        entry,
        status: offlineReady ? 'cached' : 'not-downloaded',
        progress: existing?.progress ?? null,
        offlineReady,
        cachedSizeBytes,
        error: null,
        verificationReport: existing?.verificationReport ?? null,
        measuredRtf: existing?.measuredRtf ?? null,
      };
    }

    set({ models: updates });
  },

  downloadModel: async (engineId, customBaseUrl) => {
    const { manifest, models } = get();
    const entry = manifest ? getModelManifestEntry(manifest, engineId) : undefined;
    if (!entry) {
      throw new Error(`Model manifest entry '${engineId}' is not loaded.`);
    }

    if (activeDownloads.has(engineId)) {
      return;
    }

    const controller = new AbortController();
    activeDownloads.set(engineId, controller);

    const prev = models[engineId];
    set({
      models: {
        ...models,
        [engineId]: {
          ...prev,
          entry,
          status: 'checking',
          progress: null,
          error: null,
        },
      },
    });

    try {
      await downloadAndCacheModel(entry, {
        customBaseUrl: customBaseUrl || undefined,
        signal: controller.signal,
        onProgress: (progress) => {
          const current = get().models[engineId];
          if (!current) return;
          const nextStatus: ModelDownloadStatus =
            progress.phase === 'ready'
              ? 'cached'
              : progress.phase === 'verifying'
                ? 'verifying'
                : progress.phase === 'checking'
                  ? 'checking'
                  : 'downloading';
          set({
            models: {
              ...get().models,
              [engineId]: {
                ...current,
                status: nextStatus,
                progress,
              },
            },
          });
        },
      });

      const [offlineReady, cachedSizeBytes] = await Promise.all([
        isModelOfflineReady(entry),
        getCachedSizeBytes(entry.engineId, entry.revision),
      ]);

      const current = get().models[engineId];
      set({
        models: {
          ...get().models,
          [engineId]: {
            ...current,
            status: offlineReady ? 'cached' : 'error',
            offlineReady,
            cachedSizeBytes,
            error: offlineReady ? null : 'Download completed but required artifacts are incomplete.',
          },
        },
      });
    } catch (err) {
      const aborted =
        err instanceof Error &&
        (err.name === 'AbortError' || err.message.toLowerCase().includes('abort'));
      const [offlineReady, cachedSizeBytes] = await Promise.all([
        isModelOfflineReady(entry),
        getCachedSizeBytes(entry.engineId, entry.revision),
      ]);
      const current = get().models[engineId];
      set({
        models: {
          ...get().models,
          [engineId]: {
            ...current,
            status: aborted ? (offlineReady ? 'cached' : 'not-downloaded') : 'error',
            progress: null,
            offlineReady,
            cachedSizeBytes,
            error: aborted ? null : err instanceof Error ? err.message : String(err),
          },
        },
      });
      if (!aborted) {
        throw err;
      }
    } finally {
      activeDownloads.delete(engineId);
    }
  },

  abortDownload: (engineId) => {
    const controller = activeDownloads.get(engineId);
    if (controller) {
      controller.abort();
    }
  },

  verifyModel: async (engineId) => {
    const { manifest, models } = get();
    const entry = manifest ? getModelManifestEntry(manifest, engineId) : undefined;
    if (!entry) {
      throw new Error(`Model manifest entry '${engineId}' is not loaded.`);
    }

    const current = models[engineId];
    set({
      models: {
        ...models,
        [engineId]: {
          ...current,
          status: 'verifying',
          error: null,
        },
      },
    });

    const report = await verifyCachedModel(entry);
    const [offlineReady, cachedSizeBytes] = await Promise.all([
      isModelOfflineReady(entry),
      getCachedSizeBytes(entry.engineId, entry.revision),
    ]);

    set({
      models: {
        ...get().models,
        [engineId]: {
          ...get().models[engineId],
          status: report.ok && offlineReady ? 'cached' : 'error',
          offlineReady: report.ok && offlineReady,
          cachedSizeBytes,
          verificationReport: report,
          error: report.ok ? null : 'One or more cached artifacts failed SHA-256 verification.',
        },
      },
    });

    return report;
  },

  deleteModel: async (engineId) => {
    get().abortDownload(engineId);
    const entry = get().models[engineId]?.entry;
    await deleteCachedModel(engineId, entry?.revision);

    const current = get().models[engineId];
    if (!current) return;
    set({
      models: {
        ...get().models,
        [engineId]: {
          ...current,
          status: 'not-downloaded',
          progress: null,
          offlineReady: false,
          cachedSizeBytes: 0,
          verificationReport: null,
          error: null,
        },
      },
    });
  },

  importLocalBundle: async (engineId, files) => {
    const entry = get().models[engineId]?.entry;
    if (!entry) {
      throw new Error(`Model manifest entry '${engineId}' is not loaded.`);
    }

    await importLocalModelBundle(entry, files);
    await get().refreshCacheStatus(engineId);
  },

  recordMeasuredRtf: (engineId, rtf, generationTimeMs) => {
    if (!Number.isFinite(rtf) || rtf <= 0) return;

    const current = get().models[engineId];
    const existingMap = readMeasuredRtfMap();
    const prev = current?.measuredRtf ?? existingMap[engineId] ?? null;

    const sampleCount = prev ? prev.sampleCount + 1 : 1;
    const avgRtf = prev ? (prev.rtf * prev.sampleCount + rtf) / sampleCount : rtf;
    const record: MeasuredRtfRecord = {
      rtf: avgRtf,
      lastGenerationMs:
        typeof generationTimeMs === 'number' && Number.isFinite(generationTimeMs)
          ? generationTimeMs
          : prev?.lastGenerationMs ?? null,
      sampleCount,
      updatedAt: new Date().toISOString(),
    };

    existingMap[engineId] = record;
    writeMeasuredRtfMap(existingMap);

    if (current) {
      set({
        models: {
          ...get().models,
          [engineId]: {
            ...current,
            measuredRtf: record,
          },
        },
      });
    }
  },

  resetModelStates: () => {
    for (const controller of activeDownloads.values()) {
      controller.abort();
    }
    activeDownloads.clear();
    const resetModels: Record<string, ModelRuntimeState> = {};
    for (const [id, item] of Object.entries(get().models)) {
      resetModels[id] = {
        ...item,
        status: 'not-downloaded',
        progress: null,
        offlineReady: false,
        cachedSizeBytes: 0,
        error: null,
        verificationReport: null,
        measuredRtf: null,
      };
    }
    set({ models: resetModels });
  },
}));
