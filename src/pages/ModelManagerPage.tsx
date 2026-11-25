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
    <div className="max-w-6xl mx-auto space-y-4 pb-10">
      {/* Compact Mirror / Source Banner so first card Download & Cache stays above the fold */}
      <section className="rounded-lg border border-[var(--vf-border)] bg-[var(--vf-surface)] px-4 py-3 flex flex-col sm:flex-row sm:items-center justify-between gap-3">
        <div className="space-y-0.5 min-w-0">
          <div className="flex items-center gap-2 text-[11px] font-mono uppercase tracking-wider text-[var(--vf-text-muted)]">
            <Globe className="h-3.5 w-3.5 text-[var(--vf-accent)] shrink-0" />
            <span>Active Model Download Source</span>
            <span className="text-[var(--vf-text-subtle)]">·</span>
            <span className="truncate font-sans normal-case tracking-normal text-xs font-medium text-[var(--vf-text)]">
              {customModelBaseUrl ? (
                <>
                  Self-hosted:{' '}
                  <code className="rounded-sm bg-[var(--vf-bg)] border border-[var(--vf-border-subtle)] px-1.5 py-0.5 font-mono text-[var(--vf-accent)]">
                    {customModelBaseUrl}
                  </code>
                </>
              ) : (
                'Pinned Hugging Face Repositories (Commit-SHA Locked, Ungated)'
              )}
            </span>
          </div>
          <p className="text-[11px] text-[var(--vf-text-muted)]">
            Every downloaded or locally imported file is verified byte-for-byte against its manifest SHA-256 digest before caching.
          </p>
        </div>

        <div className="flex items-center gap-2 shrink-0">
          <button
            type="button"
            onClick={() => void loadManifest().catch(() => undefined)}
            className="inline-flex items-center gap-1.5 rounded-md border border-[var(--vf-border)] bg-[var(--vf-surface-elevated)] px-3 py-1.5 text-xs font-medium text-[var(--vf-text)] hover:border-[var(--vf-accent)]/50 cursor-pointer transition-colors"
          >
            <RefreshCw className={`h-3.5 w-3.5 ${manifestLoading ? 'animate-spin' : ''}`} />
            <span>Refresh Status</span>
          </button>
          <button
            type="button"
            onClick={navigateSettings}
            className="inline-flex items-center gap-1.5 rounded-md border border-[var(--vf-border)] bg-[var(--vf-surface-elevated)] px-3 py-1.5 text-xs font-medium text-[var(--vf-text)] hover:border-[var(--vf-accent)]/50 cursor-pointer transition-colors"
          >
            <span>Configure Mirror</span>
          </button>
        </div>
      </section>

      {manifestError && (
        <div className="rounded-lg border border-[var(--vf-danger)]/35 bg-[var(--vf-danger)]/10 p-3.5 text-xs text-[var(--vf-danger)]">
          Failed to load pinned model manifest: {manifestError}
        </div>
      )}

      {/* Hardware-Catalog Weight Cards */}
      <div className="space-y-4">
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
              className="rounded-lg border border-[var(--vf-border)] bg-[var(--vf-surface)] p-4 sm:p-5 space-y-4"
            >
              {/* Header: Title + Status Badge on left, Precision + Download/Cancel at top-right */}
              <div className="flex flex-col lg:flex-row lg:items-start justify-between gap-3 pb-3 border-b border-[var(--vf-border-subtle)]">
                <div className="space-y-1">
                  <div className="flex flex-wrap items-center gap-2">
                    <h2 className="text-base font-semibold tracking-tight text-[var(--vf-text)]">
                      {activeEntry.displayName}
                    </h2>
                    <span
                      className={`inline-flex items-center gap-1 rounded-sm px-2 py-0.5 text-[11px] font-mono font-medium border ${
                        offlineReady
                          ? 'bg-[var(--vf-success)]/15 text-[var(--vf-success)] border-[var(--vf-success)]/35'
                          : 'bg-[var(--vf-bg)] text-[var(--vf-text-muted)] border-[var(--vf-border)]'
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
                    <span className="rounded-sm bg-[var(--vf-accent-soft)] border border-[var(--vf-accent)]/35 px-2 py-0.5 text-[11px] font-mono font-medium text-[var(--vf-accent)]">
                      {activeEntry.precision}
                    </span>
                  </div>

                  <p className="text-xs text-[var(--vf-text-muted)]">
                    Publisher: <strong className="text-[var(--vf-text)]">{publisher}</strong> ·
                    Repo: <code className="font-mono text-[var(--vf-text)]">{activeEntry.repoId}</code> · Commit:{' '}
                    <code className="font-mono tabular-nums" title={activeEntry.revision}>
                      {activeEntry.revision.slice(0, 12)}
                    </code>
                  </p>
                </div>

                {/* Header Actions: Download/Cancel prominently at top-right alongside Precision */}
                <div className="flex flex-wrap items-center gap-2 shrink-0">
                  {isChatterbox && (
                    <div className="flex items-center gap-2">
                      <label
                        htmlFor="chatterbox-precision-select"
                        className="text-xs font-mono text-[var(--vf-text-muted)]"
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
                        className="rounded-md border border-[var(--vf-border)] bg-[var(--vf-bg)] px-2.5 py-1.5 text-xs font-mono text-[var(--vf-text)] focus:outline-none focus:border-[var(--vf-accent)]"
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
                      className="inline-flex items-center gap-2 rounded-md bg-[var(--vf-accent)] hover:bg-[var(--vf-accent-hover)] text-white px-4 py-2 text-xs font-semibold transition-colors cursor-pointer"
                    >
                      <Download className="h-3.5 w-3.5" />
                      <span>{offlineReady ? 'Verify / Re-sync Cache' : 'Download & Cache'}</span>
                    </button>
                  ) : (
                    <button
                      type="button"
                      onClick={() => handleCancel(activeEntry.engineId, isQ4)}
                      className="inline-flex items-center gap-2 rounded-md bg-rose-600 hover:bg-rose-500 text-white px-4 py-2 text-xs font-semibold transition-colors cursor-pointer"
                    >
                      <XCircle className="h-3.5 w-3.5" />
                      <span>Cancel Download</span>
                    </button>
                  )}
                </div>
              </div>

              {/* Technical Spec Row */}
              <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-4 gap-3 text-xs">
                <div className="rounded-md border border-[var(--vf-border-subtle)] bg-[var(--vf-bg)] p-3">
                  <div className="text-[10px] font-mono uppercase tracking-wider text-[var(--vf-text-subtle)]">
                    Download / Cached Size
                  </div>
                  <div className="mt-1 font-mono tabular-nums font-semibold text-[var(--vf-text)]">
                    {formatBytes(activeEntry.totalSizeBytes)} ·{' '}
                    <span className={offlineReady ? 'text-[var(--vf-success)]' : 'text-[var(--vf-text-muted)]'}>
                      {formatBytes(cachedSizeBytes)} cached
                    </span>
                  </div>
                </div>

                <div className="rounded-md border border-[var(--vf-border-subtle)] bg-[var(--vf-bg)] p-3">
                  <div className="text-[10px] font-mono uppercase tracking-wider text-[var(--vf-text-subtle)]">
                    License &amp; Languages
                  </div>
                  <div className="mt-1 font-medium flex flex-wrap items-center gap-1.5 text-[var(--vf-text)]">
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
                    <span className="text-[var(--vf-text-subtle)]">·</span>
                    <span>{getLanguagesLabel(activeEntry.engineId)}</span>
                  </div>
                </div>

                <div className="rounded-md border border-[var(--vf-border-subtle)] bg-[var(--vf-bg)] p-3">
                  <div className="text-[10px] font-mono uppercase tracking-wider text-[var(--vf-text-subtle)]">
                    Hardware Requirements
                  </div>
                  <div className="mt-1 font-mono tabular-nums font-semibold text-[var(--vf-text)]">
                    ~{activeEntry.estimatedMemoryMb} MB RAM/VRAM ·{' '}
                    <span className="uppercase">{activeEntry.recommendedExecutionMode}</span>
                  </div>
                </div>

                <div className="rounded-md border border-[var(--vf-border-subtle)] bg-[var(--vf-bg)] p-3">
                  <div className="text-[10px] font-mono uppercase tracking-wider text-[var(--vf-text-subtle)]">
                    Measured RTF on This Device
                  </div>
                  <div className="mt-1 font-mono tabular-nums font-semibold text-[var(--vf-text)]">
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
                    className={`rounded-md border p-3 flex flex-col gap-1 ${
                      compat.compatible
                        ? 'border-[var(--vf-success)]/30 bg-[var(--vf-success)]/5'
                        : 'border-[var(--vf-danger)]/35 bg-[var(--vf-danger)]/10'
                    }`}
                  >
                    <div className="flex items-center justify-between">
                      <span className="font-medium flex items-center gap-1.5 text-[var(--vf-text)]">
                        {compat.compatible ? (
                          <CheckCircle2 className="h-4 w-4 text-[var(--vf-success)]" />
                        ) : (
                          <XCircle className="h-4 w-4 text-[var(--vf-danger)]" />
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
                      <p className="text-[var(--vf-warning)] flex items-center gap-1.5">
                        <TriangleAlert className="h-3.5 w-3.5 shrink-0" />
                        <span>
                          WebGPU shader-f16 was not detected; switch precision above to{' '}
                          <code className="font-mono">q4</code> for float32 KV cache compatibility.
                        </span>
                      </p>
                    )}
                    {compat.blockers.map((b, idx) => (
                      <p key={idx} className="text-[var(--vf-danger)]">
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
                <div className="rounded-md border border-[var(--vf-accent)]/40 bg-[var(--vf-bg)] p-3.5">
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
                <div className="rounded-md border border-[var(--vf-danger)]/35 bg-[var(--vf-danger)]/10 p-3 text-xs text-[var(--vf-danger)]">
                  {errorMsg}
                </div>
              )}

              {/* Secondary Management Actions */}
              <div className="flex flex-wrap items-center gap-2 pt-2 border-t border-[var(--vf-border-subtle)]">
                <button
                  type="button"
                  disabled={isDownloading}
                  onClick={() => void handleVerify(activeEntry, isQ4)}
                  className="inline-flex items-center gap-1.5 rounded-md border border-[var(--vf-border)] bg-[var(--vf-surface-elevated)] hover:border-[var(--vf-accent)]/50 px-3 py-1.5 text-xs font-medium text-[var(--vf-text)] transition-colors cursor-pointer disabled:opacity-50"
                >
                  <ShieldCheck className="h-3.5 w-3.5 text-[var(--vf-success)]" />
                  <span>Verify SHA-256</span>
                </button>

                {/* Folder Import */}
                <label className="inline-flex items-center gap-1.5 rounded-md border border-[var(--vf-border)] bg-[var(--vf-surface-elevated)] hover:border-[var(--vf-accent)]/50 px-3 py-1.5 text-xs font-medium text-[var(--vf-text)] transition-colors cursor-pointer">
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
                <label className="inline-flex items-center gap-1.5 rounded-md border border-[var(--vf-border)] bg-[var(--vf-surface-elevated)] hover:border-[var(--vf-accent)]/50 px-3 py-1.5 text-xs font-medium text-[var(--vf-text)] transition-colors cursor-pointer">
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
                    className="inline-flex items-center gap-1.5 rounded-md border border-[var(--vf-danger)]/35 bg-[var(--vf-danger)]/10 hover:bg-[var(--vf-danger)]/20 text-[var(--vf-danger)] px-3 py-1.5 text-xs font-medium transition-colors cursor-pointer disabled:opacity-50"
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
                  className="ml-auto inline-flex items-center gap-1 text-xs font-mono text-[var(--vf-text-muted)] hover:text-[var(--vf-text)] cursor-pointer"
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
                <div className="overflow-x-auto rounded-md border border-[var(--vf-border-subtle)] bg-[var(--vf-bg)]">
                  <table className="w-full text-left text-xs">
                    <thead className="bg-[var(--vf-surface-elevated)] text-[10px] font-mono uppercase tracking-wider text-[var(--vf-text-muted)]">
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
                          <tr key={artifact.relativePath} className="hover:bg-[var(--vf-surface)]">
                            <td className="px-3 py-2 font-mono">{artifact.role}</td>
                            <td className="px-3 py-2 font-mono text-[var(--vf-text-muted)]">
                              {artifact.relativePath}
                            </td>
                            <td className="px-3 py-2 font-mono tabular-nums">
                              {formatBytes(artifact.sizeBytes)}
                            </td>
                            <td
                              className="px-3 py-2 font-mono tabular-nums text-[var(--vf-text-subtle)]"
                              title={artifact.sha256}
                            >
                              {artifact.sha256.slice(0, 14)}…
                            </td>
                            <td className="px-3 py-2">
                              {res ? (
                                res.ok ? (
                                  <span className="text-[var(--vf-success)] font-medium">Verified</span>
                                ) : (
                                  <span className="text-[var(--vf-danger)]">{res.reason ?? 'Failed'}</span>
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
