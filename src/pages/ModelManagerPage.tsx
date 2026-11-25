import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import {
  CheckCircle2,
  ChevronDown,
  ChevronUp,
  Download,
  ExternalLink,
  FolderUp,
  Globe,
  HardDrive,
  RefreshCw,
  ShieldCheck,
  Trash2,
  TriangleAlert,
  Upload,
  XCircle,
} from 'lucide-react';
import {
  getChatterboxManifestEntry,
  type ChatterboxLmPrecision,
} from '../engines/chatterbox';
import { defaultEngineRegistry } from '../engines/registry';
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
import { useAppStore } from '../stores/appStore';
import { useModelStore } from '../stores/modelStore';
import type { ModelManifestEntry } from '../types';
import { ProgressBar, toast } from '../components/common';

function formatBytes(bytes: number): string {
  if (!Number.isFinite(bytes) || bytes <= 0) return '0 B';
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  if (bytes < 1024 * 1024 * 1024) return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
  return `${(bytes / (1024 * 1024 * 1024)).toFixed(2)} GB`;
}

interface VariantRuntimeOverride {
  offlineReady: boolean;
  cachedSizeBytes: number;
  downloading: boolean;
  verifying: boolean;
  progress: ModelDownloadProgress | null;
  report: ModelVerificationReport | null;
  error: string | null;
}

export function ModelManagerPage() {
  const customModelBaseUrl = useAppStore((s) => s.customModelBaseUrl);
  const hardwareCapabilities = useAppStore((s) => s.hardwareCapabilities);
  const hardwareReport = useAppStore((s) => s.hardwareReport);
  const detectHardware = useAppStore((s) => s.detectHardware);
  const setActiveRoute = useAppStore((s) => s.setActiveRoute);

  const manifest = useModelStore((s) => s.manifest);
  const manifestLoading = useModelStore((s) => s.manifestLoading);
  const manifestError = useModelStore((s) => s.manifestError);
  const models = useModelStore((s) => s.models);
  const loadManifest = useModelStore((s) => s.loadManifest);
  const refreshCacheStatus = useModelStore((s) => s.refreshCacheStatus);
  const downloadModel = useModelStore((s) => s.downloadModel);
  const abortDownload = useModelStore((s) => s.abortDownload);
  const verifyModel = useModelStore((s) => s.verifyModel);
  const deleteModel = useModelStore((s) => s.deleteModel);
  const importLocalBundle = useModelStore((s) => s.importLocalBundle);

  const [chatterboxPrecision, setChatterboxPrecision] =
    useState<ChatterboxLmPrecision>('q4f16');
  const [q4State, setQ4State] = useState<VariantRuntimeOverride>({
    offlineReady: false,
    cachedSizeBytes: 0,
    downloading: false,
    verifying: false,
    progress: null,
    report: null,
    error: null,
  });
  const q4AbortRef = useRef<AbortController | null>(null);
  const [expandedArtifacts, setExpandedArtifacts] = useState<Record<string, boolean>>({});

  const q4Entry = useMemo(() => getChatterboxManifestEntry('q4'), []);

  const refreshQ4Status = useCallback(async () => {
    const [offlineReady, cachedSizeBytes] = await Promise.all([
      isModelOfflineReady(q4Entry),
      getCachedSizeBytes(q4Entry.engineId, q4Entry.revision),
    ]);
    setQ4State((prev) => ({
      ...prev,
      offlineReady,
      cachedSizeBytes,
    }));
  }, [q4Entry]);

  useEffect(() => {
    if (!manifest && !manifestLoading) {
      void loadManifest().catch(() => undefined);
    }
    if (!hardwareCapabilities) {
      void detectHardware().catch(() => undefined);
    }
    void refreshQ4Status();
  }, [manifest, manifestLoading, hardwareCapabilities, loadManifest, detectHardware, refreshQ4Status]);

  const navigateSettings = () => {
    setActiveRoute('settings');
  };

  const getLanguagesLabel = (engineId: string): string => {
    const engine = defaultEngineRegistry.get(engineId);
    if (!engine) return 'English (en)';
    const langs = engine.getSupportedLanguages();
    return langs.map((l) => `${l.name} (${l.code})`).join(', ');
  };

  const handleDownload = async (entry: ModelManifestEntry, isChatterboxQ4: boolean) => {
    if (!isChatterboxQ4) {
      try {
        await downloadModel(entry.engineId, customModelBaseUrl || undefined);
        toast.success('Model cached & verified', `${entry.displayName} is ready offline.`);
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        toast.error('Download failed', msg);
      }
      return;
    }

    if (q4AbortRef.current) return;
    const controller = new AbortController();
    q4AbortRef.current = controller;
    setQ4State((prev) => ({ ...prev, downloading: true, progress: null, error: null }));
    try {
      await downloadAndCacheModel(q4Entry, {
        customBaseUrl: customModelBaseUrl || undefined,
        signal: controller.signal,
        onProgress: (progress) => {
          setQ4State((prev) => ({ ...prev, progress }));
        },
      });
      await refreshQ4Status();
      await refreshCacheStatus('chatterbox');
      setQ4State((prev) => ({ ...prev, downloading: false }));
      toast.success('Model cached & verified', `${q4Entry.displayName} is ready offline.`);
    } catch (err) {
      const aborted =
        err instanceof Error &&
        (err.name === 'AbortError' || err.message.toLowerCase().includes('abort'));
      await refreshQ4Status();
      setQ4State((prev) => ({
        ...prev,
        downloading: false,
        progress: null,
        error: aborted ? null : err instanceof Error ? err.message : String(err),
      }));
      if (!aborted) {
        toast.error('Download failed', err instanceof Error ? err.message : String(err));
      }
    } finally {
      q4AbortRef.current = null;
    }
  };

  const handleCancel = (engineId: string, isChatterboxQ4: boolean) => {
    if (isChatterboxQ4) {
      q4AbortRef.current?.abort();
    } else {
      abortDownload(engineId);
    }
    toast.info('Download cancelled');
  };

  const handleVerify = async (entry: ModelManifestEntry, isChatterboxQ4: boolean) => {
    try {
      if (isChatterboxQ4) {
        setQ4State((prev) => ({ ...prev, verifying: true, error: null }));
        const report = await verifyCachedModel(q4Entry);
        await refreshQ4Status();
        setQ4State((prev) => ({
          ...prev,
          verifying: false,
          report,
          error: report.ok ? null : 'One or more cached artifacts failed SHA-256 verification.',
        }));
        if (report.ok) {
          toast.success('SHA-256 verified', `${q4Entry.displayName} passed all checks.`);
        } else {
          toast.error('Integrity check failed', 'Missing or corrupted artifacts detected.');
        }
      } else {
        const report = await verifyModel(entry.engineId);
        if (report.ok) {
          toast.success('SHA-256 verified', `${entry.displayName} passed all checks.`);
        } else {
          toast.error('Integrity check failed', 'Missing or corrupted artifacts detected.');
        }
      }
    } catch (err) {
      toast.error('Verification error', err instanceof Error ? err.message : String(err));
    }
  };

  const handleDelete = async (entry: ModelManifestEntry, isChatterboxQ4: boolean) => {
    try {
      if (isChatterboxQ4) {
        q4AbortRef.current?.abort();
        await deleteCachedModel(q4Entry.engineId, q4Entry.revision);
        await refreshQ4Status();
        setQ4State((prev) => ({ ...prev, report: null, progress: null, error: null }));
      }
      await deleteModel(entry.engineId);
      await refreshQ4Status();
      toast.info('Cache cleared', `Deleted local files for ${entry.displayName}.`);
    } catch (err) {
      toast.error('Delete failed', err instanceof Error ? err.message : String(err));
    }
  };

  const handleLocalImport = async (
    entry: ModelManifestEntry,
    isChatterboxQ4: boolean,
    files: FileList | null
  ) => {
    if (!files || files.length === 0) return;
    try {
      if (isChatterboxQ4) {
        await importLocalModelBundle(q4Entry, files);
        await refreshQ4Status();
        await refreshCacheStatus('chatterbox');
      } else {
        await importLocalBundle(entry.engineId, files);
        if (entry.engineId === 'chatterbox') {
          await refreshQ4Status();
        }
      }
      toast.success(
        'Local bundle imported',
        `Verified SHA-256 and cached ${entry.displayName}.`
      );
    } catch (err) {
      toast.error('Bundle import failed', err instanceof Error ? err.message : String(err));
    }
  };

  const modelStates = Object.values(models);

  return (
    <div className="space-y-6">
      {/* Mirror / Source Banner */}
      <section className="rounded-2xl border border-[var(--vf-border)] bg-[var(--vf-surface)] p-4 sm:p-5 flex flex-col sm:flex-row sm:items-center justify-between gap-4">
        <div className="space-y-1">
          <div className="flex items-center gap-2 text-xs font-medium text-[var(--vf-text-muted)]">
            <Globe className="h-4 w-4 text-[var(--vf-accent)]" />
            <span>Active Model Download Source</span>
          </div>
          <p className="text-sm font-medium">
            {customModelBaseUrl ? (
              <>
                Self-hosted mirror:{' '}
                <code className="rounded bg-[var(--vf-surface-muted)] px-1.5 py-0.5 text-xs font-mono text-[var(--vf-accent)]">
                  {customModelBaseUrl}
                </code>
              </>
            ) : (
              'Pinned Hugging Face Repositories (Commit-SHA Locked, Ungated)'
            )}
          </p>
          <p className="text-xs text-[var(--vf-text-muted)]">
            Every downloaded or locally imported file is verified byte-for-byte against its manifest SHA-256 digest before caching.
          </p>
        </div>

        <div className="flex items-center gap-2 shrink-0">
          <button
            type="button"
            onClick={() => void loadManifest().catch(() => undefined)}
            className="inline-flex items-center gap-1.5 rounded-xl border border-[var(--vf-border)] bg-[var(--vf-surface-elevated)] px-3 py-2 text-xs font-medium hover:border-[var(--vf-accent)]/40 cursor-pointer"
          >
            <RefreshCw className={`h-3.5 w-3.5 ${manifestLoading ? 'animate-spin' : ''}`} />
            <span>Refresh Status</span>
          </button>
          <button
            type="button"
            onClick={navigateSettings}
            className="inline-flex items-center gap-1.5 rounded-xl border border-[var(--vf-border)] bg-[var(--vf-surface-elevated)] px-3 py-2 text-xs font-medium hover:border-[var(--vf-accent)]/40 cursor-pointer"
          >
            <span>Configure Mirror</span>
          </button>
        </div>
      </section>

      {manifestError && (
        <div className="rounded-xl border border-rose-500/30 bg-rose-500/10 p-4 text-xs text-rose-300">
          Failed to load pinned model manifest: {manifestError}
        </div>
      )}

      {/* Model Cards */}
      <div className="space-y-5">
        {modelStates.map((runtime) => {
          const isChatterbox = runtime.entry.engineId === 'chatterbox';
          const isQ4 = isChatterbox && chatterboxPrecision === 'q4';
          const activeEntry = isQ4 ? q4Entry : runtime.entry;

          const offlineReady = isQ4 ? q4State.offlineReady : runtime.offlineReady;
          const cachedSizeBytes = isQ4 ? q4State.cachedSizeBytes : runtime.cachedSizeBytes;
          const isDownloading = isQ4
            ? q4State.downloading
            : runtime.status === 'downloading' ||
              runtime.status === 'checking' ||
              runtime.status === 'verifying';
          const progress = isQ4 ? q4State.progress : runtime.progress;
          const verificationReport = isQ4 ? q4State.report : runtime.verificationReport;
          const errorMsg = isQ4 ? q4State.error : runtime.error;

          const compat = hardwareReport[runtime.entry.engineId];
          const publisher = activeEntry.repoId.split('/')[0] ?? activeEntry.repoId;
          const showArtifacts = Boolean(expandedArtifacts[activeEntry.engineId]);

          return (
            <article
              key={runtime.entry.engineId}
              className="rounded-2xl border border-[var(--vf-border)] bg-[var(--vf-surface)] p-5 sm:p-6 space-y-5"
            >
              {/* Header */}
              <div className="flex flex-col lg:flex-row lg:items-start justify-between gap-4">
                <div className="space-y-1.5">
                  <div className="flex flex-wrap items-center gap-2">
                    <h2 className="text-base sm:text-lg font-semibold tracking-tight">
                      {activeEntry.displayName}
                    </h2>
                    <span
                      className={`inline-flex items-center gap-1 rounded-full px-2.5 py-0.5 text-xs font-medium ${
                        offlineReady
                          ? 'bg-emerald-500/15 text-emerald-400 border border-emerald-500/30'
                          : 'bg-[var(--vf-surface-muted)] text-[var(--vf-text-muted)] border border-[var(--vf-border)]'
                      }`}
                    >
                      {offlineReady ? (
                        <CheckCircle2 className="h-3.5 w-3.5" />
                      ) : (
                        <HardDrive className="h-3.5 w-3.5" />
                      )}
                      <span>
                        {offlineReady ? 'Offline Ready (100% Verified)' : 'Not Cached Offline'}
                      </span>
                    </span>
                    <span className="rounded-full bg-[var(--vf-accent-soft)] px-2.5 py-0.5 text-[11px] font-mono font-medium text-[var(--vf-accent)]">
                      {activeEntry.precision}
                    </span>
                  </div>

                  <p className="text-xs text-[var(--vf-text-muted)]">
                    Publisher: <strong className="text-[var(--vf-text)]">{publisher}</strong> •
                    Repo: <code className="font-mono">{activeEntry.repoId}</code> • Commit:{' '}
                    <code className="font-mono" title={activeEntry.revision}>
                      {activeEntry.revision.slice(0, 12)}
                    </code>
                  </p>
                </div>

                {/* Header Actions: Download/Cancel prominently at top-right alongside Precision */}
                <div className="flex flex-wrap items-center gap-2.5 shrink-0">
                  {isChatterbox && (
                    <div className="flex items-center gap-2">
                      <label
                        htmlFor="chatterbox-precision-select"
                        className="text-xs text-[var(--vf-text-muted)]"
                      >
                        Precision:
                      </label>
                      <select
                        id="chatterbox-precision-select"
                        value={chatterboxPrecision}
                        onChange={(e) =>
                          setChatterboxPrecision(e.target.value as ChatterboxLmPrecision)
                        }
                        disabled={isDownloading}
                        className="rounded-xl border border-[var(--vf-border)] bg-[var(--vf-surface-elevated)] px-3 py-1.5 text-xs font-mono text-[var(--vf-text)] focus:outline-none focus:border-[var(--vf-accent)]"
                      >
                        <option value="q4f16">q4f16 (WebGPU f16)</option>
                        <option value="q4">q4 (WebGPU f32 / WASM)</option>
                      </select>
                    </div>
                  )}

                  {!isDownloading ? (
                    <button
                      type="button"
                      onClick={() => void handleDownload(activeEntry, isQ4)}
                      className="inline-flex items-center gap-2 rounded-xl bg-[var(--vf-accent)] hover:bg-[var(--vf-accent-hover)] text-white px-4 py-2 text-xs font-semibold shadow-sm shadow-[#7C5CFF]/25 transition-colors cursor-pointer"
                    >
                      <Download className="h-3.5 w-3.5" />
                      <span>{offlineReady ? 'Verify / Re-sync Cache' : 'Download & Cache'}</span>
                    </button>
                  ) : (
                    <button
                      type="button"
                      onClick={() => handleCancel(activeEntry.engineId, isQ4)}
                      className="inline-flex items-center gap-2 rounded-xl bg-rose-600 hover:bg-rose-500 text-white px-4 py-2 text-xs font-semibold transition-colors cursor-pointer"
                    >
                      <XCircle className="h-3.5 w-3.5" />
                      <span>Cancel Download</span>
                    </button>
                  )}
                </div>
              </div>

              {/* Metadata Grid */}
              <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-4 gap-3 text-xs">
                <div className="rounded-xl border border-[var(--vf-border-subtle)] bg-[var(--vf-surface-elevated)] p-3">
                  <div className="text-[var(--vf-text-muted)]">Download / Cached Size</div>
                  <div className="mt-1 font-mono font-medium">
                    {formatBytes(activeEntry.totalSizeBytes)} •{' '}
                    <span className={offlineReady ? 'text-emerald-400' : 'text-[var(--vf-text-muted)]'}>
                      {formatBytes(cachedSizeBytes)} cached
                    </span>
                  </div>
                </div>

                <div className="rounded-xl border border-[var(--vf-border-subtle)] bg-[var(--vf-surface-elevated)] p-3">
                  <div className="text-[var(--vf-text-muted)]">License &amp; Languages</div>
                  <div className="mt-1 font-medium flex flex-wrap items-center gap-1.5">
                    {activeEntry.licenseUrl ? (
                      <a
                        href={activeEntry.licenseUrl}
                        target="_blank"
                        rel="noreferrer"
                        className="inline-flex items-center gap-1 text-[var(--vf-accent)] hover:underline"
                      >
                        <span>{activeEntry.license}</span>
                        <ExternalLink className="h-3 w-3" />
                      </a>
                    ) : (
                      <span>{activeEntry.license}</span>
                    )}
                    <span className="text-[var(--vf-text-subtle)]">•</span>
                    <span>{getLanguagesLabel(activeEntry.engineId)}</span>
                  </div>
                </div>

                <div className="rounded-xl border border-[var(--vf-border-subtle)] bg-[var(--vf-surface-elevated)] p-3">
                  <div className="text-[var(--vf-text-muted)]">Hardware Requirements</div>
                  <div className="mt-1 font-medium">
                    ~{activeEntry.estimatedMemoryMb} MB RAM/VRAM •{' '}
                    <span className="uppercase font-mono">{activeEntry.recommendedExecutionMode}</span>
                  </div>
                </div>

                <div className="rounded-xl border border-[var(--vf-border-subtle)] bg-[var(--vf-surface-elevated)] p-3">
                  <div className="text-[var(--vf-text-muted)]">Measured RTF on This Device</div>
                  <div className="mt-1 font-mono font-medium">
                    {runtime.measuredRtf
                      ? `${runtime.measuredRtf.rtf.toFixed(2)}x (${runtime.measuredRtf.sampleCount} runs)`
                      : 'Not measured yet'}
                  </div>
                </div>
              </div>

              {/* Browser Compatibility & Notes */}
              <div className="space-y-2 text-xs">
                {compat && (
                  <div
                    className={`rounded-xl border p-3 flex flex-col gap-1 ${
                      compat.compatible
                        ? 'border-emerald-500/25 bg-emerald-500/5'
                        : 'border-rose-500/30 bg-rose-500/10'
                    }`}
                  >
                    <div className="flex items-center justify-between">
                      <span className="font-medium flex items-center gap-1.5">
                        {compat.compatible ? (
                          <CheckCircle2 className="h-4 w-4 text-emerald-400" />
                        ) : (
                          <XCircle className="h-4 w-4 text-rose-400" />
                        )}
                        <span>
                          Browser Compatibility:{' '}
                          {compat.compatible
                            ? `Compatible (Recommended: ${compat.recommendedBackend.toUpperCase()})`
                            : 'Incompatible on this browser'}
                        </span>
                      </span>
                    </div>
                    {isChatterbox && !compat.shaderF16Supported && chatterboxPrecision === 'q4f16' && (
                      <p className="text-amber-400 flex items-center gap-1.5">
                        <TriangleAlert className="h-3.5 w-3.5 shrink-0" />
                        <span>
                          WebGPU shader-f16 was not detected; switch precision above to{' '}
                          <code className="font-mono">q4</code> for float32 KV cache compatibility.
                        </span>
                      </p>
                    )}
                    {compat.blockers.map((b, idx) => (
                      <p key={idx} className="text-rose-400">
                        {b}
                      </p>
                    ))}
                  </div>
                )}

                {activeEntry.notes && activeEntry.notes.length > 0 && (
                  <ul className="list-disc list-inside text-[var(--vf-text-muted)] space-y-0.5 pl-1">
                    {activeEntry.notes.map((note, idx) => (
                      <li key={idx}>{note}</li>
                    ))}
                    {activeEntry.engineId === 'pocket-tts' && (
                      <li>
                        Subject to Kyutai CC-BY-4.0 attribution &amp; Prohibited Use terms (no unauthorized voice impersonation or fraud).
                      </li>
                    )}
                  </ul>
                )}
              </div>

              {/* Live Progress Bar */}
              {(isDownloading || progress) && (
                <div className="rounded-xl border border-[var(--vf-accent)]/30 bg-[var(--vf-surface-elevated)] p-3.5">
                  <ProgressBar
                    value={progress?.fraction ?? 0}
                    indeterminate={!progress}
                    label={
                      progress
                        ? `${progress.phase.toUpperCase()}: ${progress.artifact.relativePath} (${
                            progress.completedArtifacts + 1
                          }/${progress.totalArtifacts})`
                        : 'Preparing model download...'
                    }
                    sublabel={
                      progress
                        ? `${formatBytes(progress.loadedBytes)} / ${formatBytes(progress.totalBytes)}`
                        : undefined
                    }
                  />
                </div>
              )}

              {errorMsg && (
                <div className="rounded-xl border border-rose-500/30 bg-rose-500/10 p-3 text-xs text-rose-300">
                  {errorMsg}
                </div>
              )}

              {/* Secondary Management Actions */}
              <div className="flex flex-wrap items-center gap-2.5">
                <button
                  type="button"
                  disabled={isDownloading}
                  onClick={() => void handleVerify(activeEntry, isQ4)}
                  className="inline-flex items-center gap-1.5 rounded-xl border border-[var(--vf-border)] bg-[var(--vf-surface-elevated)] hover:border-[var(--vf-accent)]/40 px-3.5 py-2 text-xs font-medium transition-colors cursor-pointer disabled:opacity-50"
                >
                  <ShieldCheck className="h-3.5 w-3.5 text-emerald-400" />
                  <span>Verify SHA-256</span>
                </button>

                {/* Folder Import */}
                <label className="inline-flex items-center gap-1.5 rounded-xl border border-[var(--vf-border)] bg-[var(--vf-surface-elevated)] hover:border-[var(--vf-accent)]/40 px-3.5 py-2 text-xs font-medium transition-colors cursor-pointer">
                  <FolderUp className="h-3.5 w-3.5 text-[var(--vf-accent)]" />
                  <span>Import Folder</span>
                  <input
                    type="file"
                    className="sr-only"
                    multiple
                    {...({ webkitdirectory: '' } as Record<string, string>)}
                    onChange={(e) => {
                      void handleLocalImport(activeEntry, isQ4, e.target.files);
                      e.target.value = '';
                    }}
                  />
                </label>

                {/* Individual Files Import */}
                <label className="inline-flex items-center gap-1.5 rounded-xl border border-[var(--vf-border)] bg-[var(--vf-surface-elevated)] hover:border-[var(--vf-accent)]/40 px-3.5 py-2 text-xs font-medium transition-colors cursor-pointer">
                  <Upload className="h-3.5 w-3.5 text-[var(--vf-accent)]" />
                  <span>Import Files</span>
                  <input
                    type="file"
                    className="sr-only"
                    multiple
                    onChange={(e) => {
                      void handleLocalImport(activeEntry, isQ4, e.target.files);
                      e.target.value = '';
                    }}
                  />
                </label>

                {cachedSizeBytes > 0 && (
                  <button
                    type="button"
                    disabled={isDownloading}
                    onClick={() => void handleDelete(activeEntry, isQ4)}
                    className="inline-flex items-center gap-1.5 rounded-xl border border-rose-500/30 bg-rose-500/10 hover:bg-rose-500/20 text-rose-400 px-3.5 py-2 text-xs font-medium transition-colors cursor-pointer disabled:opacity-50"
                  >
                    <Trash2 className="h-3.5 w-3.5" />
                    <span>Clear Cache</span>
                  </button>
                )}

                <button
                  type="button"
                  onClick={() =>
                    setExpandedArtifacts((prev) => ({
                      ...prev,
                      [activeEntry.engineId]: !showArtifacts,
                    }))
                  }
                  className="ml-auto inline-flex items-center gap-1 text-xs text-[var(--vf-text-muted)] hover:text-[var(--vf-text)] cursor-pointer"
                >
                  <span>Artifacts ({activeEntry.artifacts.length})</span>
                  {showArtifacts ? (
                    <ChevronUp className="h-3.5 w-3.5" />
                  ) : (
                    <ChevronDown className="h-3.5 w-3.5" />
                  )}
                </button>
              </div>

              {/* Artifact Manifest & Verification Breakdown */}
              {showArtifacts && (
                <div className="overflow-x-auto rounded-xl border border-[var(--vf-border-subtle)]">
                  <table className="w-full text-left text-xs">
                    <thead className="bg-[var(--vf-surface-elevated)] text-[var(--vf-text-muted)]">
                      <tr>
                        <th className="px-3 py-2 font-medium">Role</th>
                        <th className="px-3 py-2 font-medium">Relative Path</th>
                        <th className="px-3 py-2 font-medium">Size</th>
                        <th className="px-3 py-2 font-medium">Pinned SHA-256</th>
                        <th className="px-3 py-2 font-medium">Verification</th>
                      </tr>
                    </thead>
                    <tbody className="divide-y divide-[var(--vf-border-subtle)]">
                      {activeEntry.artifacts.map((artifact) => {
                        const res = verificationReport?.artifacts.find(
                          (r) => r.relativePath === artifact.relativePath
                        );
                        return (
                          <tr key={artifact.relativePath} className="hover:bg-[var(--vf-surface-elevated)]/50">
                            <td className="px-3 py-2 font-mono">{artifact.role}</td>
                            <td className="px-3 py-2 font-mono text-[var(--vf-text-muted)]">
                              {artifact.relativePath}
                            </td>
                            <td className="px-3 py-2 font-mono">{formatBytes(artifact.sizeBytes)}</td>
                            <td className="px-3 py-2 font-mono text-[var(--vf-text-subtle)]" title={artifact.sha256}>
                              {artifact.sha256.slice(0, 14)}…
                            </td>
                            <td className="px-3 py-2">
                              {res ? (
                                res.ok ? (
                                  <span className="text-emerald-400 font-medium">Verified</span>
                                ) : (
                                  <span className="text-rose-400">{res.reason ?? 'Failed'}</span>
                                )
                              ) : (
                                <span className="text-[var(--vf-text-subtle)]">Not run</span>
                              )}
                            </td>
                          </tr>
                        );
                      })}
                    </tbody>
                  </table>
                </div>
              )}
            </article>
          );
        })}
      </div>
    </div>
  );
}
