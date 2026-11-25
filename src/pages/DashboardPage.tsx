import { useEffect } from 'react';
import {
  ArrowRight,
  Boxes,
  CheckCircle2,
  Cpu,
  FlaskConical,
  FolderKanban,
  HardDrive,
  Mic,
  RefreshCw,
  Sparkles,
  TriangleAlert,
  Users,
  XCircle,
} from 'lucide-react';
import { useAppStore, type AppRoute } from '../stores/appStore';
import { useModelStore } from '../stores/modelStore';
import { useProjectStore } from '../stores/projectStore';
import { useStudioStore } from '../stores/studioStore';
import { useVoiceStore } from '../stores/voiceStore';
import type { NarrationProject } from '../types';
import { EmptyState } from '../components/common';

function formatBytes(bytes: number | null | undefined): string {
  if (bytes === null || bytes === undefined || !Number.isFinite(bytes)) return 'Not exposed';
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  if (bytes < 1024 * 1024 * 1024) return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
  return `${(bytes / (1024 * 1024 * 1024)).toFixed(2)} GB`;
}

export function DashboardPage() {
  const executionMode = useAppStore((s) => s.executionMode);
  const hardwareCapabilities = useAppStore((s) => s.hardwareCapabilities);
  const hardwareReport = useAppStore((s) => s.hardwareReport);
  const hardwareLoading = useAppStore((s) => s.hardwareLoading);
  const hardwareError = useAppStore((s) => s.hardwareError);
  const detectHardware = useAppStore((s) => s.detectHardware);
  const setActiveRoute = useAppStore((s) => s.setActiveRoute);

  const manifest = useModelStore((s) => s.manifest);
  const models = useModelStore((s) => s.models);
  const loadManifest = useModelStore((s) => s.loadManifest);

  const voices = useVoiceStore((s) => s.voices);
  const loadVoices = useVoiceStore((s) => s.loadVoices);

  const projects = useProjectStore((s) => s.projects);
  const loadProjects = useProjectStore((s) => s.loadProjects);
  const selectProject = useProjectStore((s) => s.selectProject);

  useEffect(() => {
    if (!hardwareCapabilities && !hardwareLoading) {
      void detectHardware().catch(() => undefined);
    }
    if (!manifest) {
      void loadManifest().catch(() => undefined);
    }
    void loadVoices().catch(() => undefined);
    void loadProjects().catch(() => undefined);
  }, [hardwareCapabilities, hardwareLoading, manifest, detectHardware, loadManifest, loadVoices, loadProjects]);

  const navigate = (route: AppRoute) => {
    setActiveRoute(route);
  };

  const openProjectInStudio = async (project: NarrationProject) => {
    const loaded = await selectProject(project.id);
    if (!loaded) return;
    const studio = useStudioStore.getState();
    studio.setActiveProjectId(loaded.id);
    studio.setProjectTitle(loaded.name);
    studio.setScriptText(loaded.scriptText, false);
    studio.selectVoice(loaded.voiceProfileId);
    studio.selectEngine(loaded.engineId);
    studio.setActiveProjectChunks(loaded.chunks);
    navigate('studio');
  };

  const modelEntries = Object.values(models);
  const offlineReadyModels = modelEntries.filter((m) => m.offlineReady);
  const totalCachedBytes = modelEntries.reduce((sum, m) => sum + m.cachedSizeBytes, 0);
  const recentProjects = projects.slice(0, 5);

  return (
    <div className="space-y-6">
      {/* Quick Studio Launch */}
      <section className="rounded-2xl border border-[var(--vf-border)] bg-[var(--vf-surface)] p-5 sm:p-6">
        <div className="flex flex-col lg:flex-row lg:items-center justify-between gap-4">
          <div>
            <div className="inline-flex items-center gap-2 rounded-full border border-[var(--vf-accent)]/30 bg-[var(--vf-accent-soft)] px-3 py-1 text-xs font-medium text-[var(--vf-accent)] mb-2.5">
              <Cpu className="h-3.5 w-3.5" />
              <span>Execution Mode: {executionMode.toUpperCase()}</span>
            </div>
            <h2 className="text-lg sm:text-xl font-semibold tracking-tight">
              Local Browser Voice Cloning &amp; Narration Workspace
            </h2>
            <p className="text-xs sm:text-sm text-[var(--vf-text-muted)] mt-1 max-w-2xl">
              Clone reference voices, manage local voice profiles, and generate long-form narration
              completely inside your browser using ONNX Runtime Web (WebGPU &amp; WASM).
            </p>
          </div>

          <div className="flex flex-wrap items-center gap-2.5 shrink-0">
            <button
              type="button"
              onClick={() => navigate('clone')}
              className="inline-flex items-center gap-2 rounded-xl bg-[var(--vf-accent)] hover:bg-[var(--vf-accent-hover)] text-white px-4 py-2.5 text-xs font-semibold transition-colors cursor-pointer"
            >
              <Mic className="h-4 w-4" />
              <span>Clone a Voice</span>
            </button>
            <button
              type="button"
              onClick={() => navigate('studio')}
              className="inline-flex items-center gap-2 rounded-xl border border-[var(--vf-border)] bg-[var(--vf-surface-elevated)] hover:border-[var(--vf-accent)]/50 px-4 py-2.5 text-xs font-semibold transition-colors cursor-pointer"
            >
              <Sparkles className="h-4 w-4 text-[var(--vf-accent)]" />
              <span>Open Studio</span>
            </button>
            <button
              type="button"
              onClick={() => navigate('models')}
              className="inline-flex items-center gap-2 rounded-xl border border-[var(--vf-border)] bg-[var(--vf-surface-elevated)] hover:border-[var(--vf-accent)]/50 px-4 py-2.5 text-xs font-semibold transition-colors cursor-pointer"
            >
              <Boxes className="h-4 w-4 text-[var(--vf-accent)]" />
              <span>Model Manager</span>
            </button>
          </div>
        </div>
      </section>

      {/* Real Workspace Summary Cards */}
      <section className="grid grid-cols-1 sm:grid-cols-2 xl:grid-cols-4 gap-4">
        <div className="rounded-2xl border border-[var(--vf-border)] bg-[var(--vf-surface)] p-4">
          <div className="flex items-center justify-between text-xs text-[var(--vf-text-muted)]">
            <span>Offline-Ready Models</span>
            <Boxes className="h-4 w-4 text-[var(--vf-accent)]" />
          </div>
          <div className="mt-2 text-2xl font-semibold font-mono">
            {offlineReadyModels.length} / {modelEntries.length}
          </div>
          <p className="text-xs text-[var(--vf-text-muted)] mt-1">
            {formatBytes(totalCachedBytes)} cached locally
          </p>
        </div>

        <div className="rounded-2xl border border-[var(--vf-border)] bg-[var(--vf-surface)] p-4">
          <div className="flex items-center justify-between text-xs text-[var(--vf-text-muted)]">
            <span>Saved Voice Profiles</span>
            <Users className="h-4 w-4 text-[var(--vf-accent)]" />
          </div>
          <div className="mt-2 text-2xl font-semibold font-mono">{voices.length}</div>
          <button
            type="button"
            onClick={() => navigate('voices')}
            className="text-xs text-[var(--vf-accent)] hover:underline mt-1 inline-flex items-center gap-1 cursor-pointer"
          >
            <span>Browse My Voices</span>
            <ArrowRight className="h-3 w-3" />
          </button>
        </div>

        <div className="rounded-2xl border border-[var(--vf-border)] bg-[var(--vf-surface)] p-4">
          <div className="flex items-center justify-between text-xs text-[var(--vf-text-muted)]">
            <span>Saved Projects</span>
            <FolderKanban className="h-4 w-4 text-[var(--vf-accent)]" />
          </div>
          <div className="mt-2 text-2xl font-semibold font-mono">{projects.length}</div>
          <button
            type="button"
            onClick={() => navigate('projects')}
            className="text-xs text-[var(--vf-accent)] hover:underline mt-1 inline-flex items-center gap-1 cursor-pointer"
          >
            <span>View All Projects</span>
            <ArrowRight className="h-3 w-3" />
          </button>
        </div>

        <div className="rounded-2xl border border-[var(--vf-border)] bg-[var(--vf-surface)] p-4">
          <div className="flex items-center justify-between text-xs text-[var(--vf-text-muted)]">
            <span>Audio Comparison Lab</span>
            <FlaskConical className="h-4 w-4 text-[var(--vf-accent)]" />
          </div>
          <div className="mt-2 text-sm font-semibold">Real A/B Telemetry</div>
          <button
            type="button"
            onClick={() => navigate('lab')}
            className="text-xs text-[var(--vf-accent)] hover:underline mt-2 inline-flex items-center gap-1 cursor-pointer"
          >
            <span>Launch Audio Lab</span>
            <ArrowRight className="h-3 w-3" />
          </button>
        </div>
      </section>

      <div className="grid grid-cols-1 xl:grid-cols-3 gap-6">
        {/* Hardware Capability Summary */}
        <section className="xl:col-span-2 rounded-2xl border border-[var(--vf-border)] bg-[var(--vf-surface)] p-5 space-y-4">
          <div className="flex items-center justify-between gap-3">
            <div>
              <h3 className="text-sm font-semibold">Hardware &amp; Browser Runtime Probe</h3>
              <p className="text-xs text-[var(--vf-text-muted)]">
                Live capabilities reported directly by browser APIs (no estimated or fabricated metrics).
              </p>
            </div>
            <button
              type="button"
              onClick={() => void detectHardware().catch(() => undefined)}
              disabled={hardwareLoading}
              className="inline-flex items-center gap-1.5 rounded-lg border border-[var(--vf-border)] bg-[var(--vf-surface-elevated)] px-3 py-1.5 text-xs font-medium hover:border-[var(--vf-accent)]/40 transition-colors cursor-pointer disabled:opacity-50"
            >
              <RefreshCw className={`h-3.5 w-3.5 ${hardwareLoading ? 'animate-spin' : ''}`} />
              <span>Re-probe</span>
            </button>
          </div>

          {hardwareError && (
            <div className="rounded-xl border border-rose-500/30 bg-rose-500/10 p-3 text-xs text-rose-300">
              Hardware probe failed: {hardwareError}
            </div>
          )}

          {hardwareCapabilities ? (
            <>
              <div className="grid grid-cols-1 sm:grid-cols-2 md:grid-cols-3 gap-3 text-xs">
                <div className="rounded-xl border border-[var(--vf-border-subtle)] bg-[var(--vf-surface-elevated)] p-3">
                  <div className="text-[var(--vf-text-muted)]">WebGPU Adapter</div>
                  <div className="mt-1 font-medium">
                    {hardwareCapabilities.webgpuAdapterAvailable
                      ? hardwareCapabilities.webgpuAdapterInfo?.description ||
                        hardwareCapabilities.webgpuAdapterInfo?.device ||
                        hardwareCapabilities.webgpuAdapterInfo?.vendor ||
                        'Available'
                      : hardwareCapabilities.webgpuSupported
                        ? 'API present, no adapter'
                        : 'Unavailable'}
                  </div>
                </div>

                <div className="rounded-xl border border-[var(--vf-border-subtle)] bg-[var(--vf-surface-elevated)] p-3">
                  <div className="text-[var(--vf-text-muted)]">WebGPU shader-f16</div>
                  <div className="mt-1 font-medium">
                    {hardwareCapabilities.shaderF16Supported ? 'Supported' : 'Not supported'}
                  </div>
                </div>

                <div className="rounded-xl border border-[var(--vf-border-subtle)] bg-[var(--vf-surface-elevated)] p-3">
                  <div className="text-[var(--vf-text-muted)]">WebGPU Max Buffer</div>
                  <div className="mt-1 font-medium font-mono">
                    {formatBytes(hardwareCapabilities.webgpuMaxBufferSize)}
                  </div>
                </div>

                <div className="rounded-xl border border-[var(--vf-border-subtle)] bg-[var(--vf-surface-elevated)] p-3">
                  <div className="text-[var(--vf-text-muted)]">WASM SIMD &amp; Threads</div>
                  <div className="mt-1 font-medium">
                    {hardwareCapabilities.wasmSimdSupported ? 'SIMD Ready' : 'No SIMD'} •{' '}
                    {hardwareCapabilities.wasmThreadsSupported
                      ? `${hardwareCapabilities.recommendedWasmThreads} threads`
                      : '1 thread (no COOP/COEP)'}
                  </div>
                </div>

                <div className="rounded-xl border border-[var(--vf-border-subtle)] bg-[var(--vf-surface-elevated)] p-3">
                  <div className="text-[var(--vf-text-muted)]">CPU Cores &amp; Device RAM</div>
                  <div className="mt-1 font-medium font-mono">
                    {hardwareCapabilities.hardwareConcurrency} cores •{' '}
                    {hardwareCapabilities.deviceMemoryGb !== null
                      ? `${hardwareCapabilities.deviceMemoryGb} GB`
                      : 'RAM not exposed'}
                  </div>
                </div>

                <div className="rounded-xl border border-[var(--vf-border-subtle)] bg-[var(--vf-surface-elevated)] p-3">
                  <div className="text-[var(--vf-text-muted)] flex items-center gap-1">
                    <HardDrive className="h-3 w-3" />
                    <span>Origin Storage</span>
                  </div>
                  <div className="mt-1 font-medium font-mono">
                    {hardwareCapabilities.storageQuotaBytes !== null
                      ? `${formatBytes(hardwareCapabilities.storageUsageBytes)} / ${formatBytes(
                          hardwareCapabilities.storageQuotaBytes
                        )}`
                      : 'Not exposed'}
                  </div>
                </div>
              </div>

              {/* Per-Engine Compatibility */}
              {Object.values(hardwareReport).length > 0 && (
                <div className="space-y-2">
                  <div className="text-xs font-medium text-[var(--vf-text-muted)]">
                    Engine Compatibility Assessment (Recommended Mode:{' '}
                    <span className="text-[var(--vf-text)] uppercase font-mono">
                      {hardwareCapabilities.recommendedExecutionMode}
                    </span>
                    )
                  </div>
                  <div className="grid grid-cols-1 md:grid-cols-2 gap-3">
                    {Object.values(hardwareReport).map((rep) => (
                      <div
                        key={rep.engineId}
                        className="rounded-xl border border-[var(--vf-border-subtle)] bg-[var(--vf-surface-elevated)] p-3 text-xs space-y-1.5"
                      >
                        <div className="flex items-center justify-between">
                          <span className="font-semibold font-mono">{rep.engineId}</span>
                          <span
                            className={`inline-flex items-center gap-1 rounded-full px-2 py-0.5 text-[11px] font-medium ${
                              rep.compatible
                                ? 'bg-emerald-500/15 text-emerald-400'
                                : 'bg-rose-500/15 text-rose-400'
                            }`}
                          >
                            {rep.compatible ? (
                              <CheckCircle2 className="h-3 w-3" />
                            ) : (
                              <XCircle className="h-3 w-3" />
                            )}
                            <span>
                              {rep.compatible ? `Ready (${rep.recommendedBackend.toUpperCase()})` : 'Blocked'}
                            </span>
                          </span>
                        </div>
                        {rep.blockers.map((b, i) => (
                          <p key={i} className="text-rose-400 flex items-start gap-1.5">
                            <XCircle className="h-3.5 w-3.5 shrink-0 mt-0.5" />
                            <span>{b}</span>
                          </p>
                        ))}
                        {rep.warnings.slice(0, 2).map((w, i) => (
                          <p key={i} className="text-[var(--vf-text-muted)] flex items-start gap-1.5">
                            <TriangleAlert className="h-3.5 w-3.5 text-amber-400 shrink-0 mt-0.5" />
                            <span>{w}</span>
                          </p>
                        ))}
                      </div>
                    ))}
                  </div>
                </div>
              )}
            </>
          ) : (
            <div className="text-xs text-[var(--vf-text-muted)] py-6 text-center">
              Probing browser hardware capabilities...
            </div>
          )}
        </section>

        {/* Installed Models + Recent Projects */}
        <div className="space-y-6">
          <section className="rounded-2xl border border-[var(--vf-border)] bg-[var(--vf-surface)] p-5 space-y-3">
            <div className="flex items-center justify-between">
              <h3 className="text-sm font-semibold">Pinned Model Cache</h3>
              <button
                type="button"
                onClick={() => navigate('models')}
                className="text-xs text-[var(--vf-accent)] hover:underline cursor-pointer"
              >
                Manage
              </button>
            </div>

            {modelEntries.length === 0 ? (
              <p className="text-xs text-[var(--vf-text-muted)]">Loading pinned manifest...</p>
            ) : (
              <div className="space-y-2.5">
                {modelEntries.map((m) => (
                  <div
                    key={m.entry.engineId}
                    className="rounded-xl border border-[var(--vf-border-subtle)] bg-[var(--vf-surface-elevated)] p-3 text-xs"
                  >
                    <div className="flex items-center justify-between gap-2">
                      <span className="font-medium truncate">{m.entry.displayName}</span>
                      <span
                        className={`shrink-0 rounded-full px-2 py-0.5 text-[10px] font-medium ${
                          m.offlineReady
                            ? 'bg-emerald-500/15 text-emerald-400'
                            : 'bg-[var(--vf-surface-muted)] text-[var(--vf-text-muted)]'
                        }`}
                      >
                        {m.offlineReady ? 'Offline Ready' : 'Not Cached'}
                      </span>
                    </div>
                    <div className="mt-1 flex items-center justify-between text-[11px] text-[var(--vf-text-muted)] font-mono">
                      <span>{formatBytes(m.cachedSizeBytes)} cached</span>
                      <span>{formatBytes(m.entry.totalSizeBytes)} total</span>
                    </div>
                  </div>
                ))}
              </div>
            )}
          </section>

          <section className="rounded-2xl border border-[var(--vf-border)] bg-[var(--vf-surface)] p-5 space-y-3">
            <div className="flex items-center justify-between">
              <h3 className="text-sm font-semibold">Recent Projects</h3>
              <button
                type="button"
                onClick={() => navigate('projects')}
                className="text-xs text-[var(--vf-accent)] hover:underline cursor-pointer"
              >
                All ({projects.length})
              </button>
            </div>

            {recentProjects.length === 0 ? (
              <EmptyState
                title="No saved projects yet"
                description="Start a narration in Text to Speech Studio to save chunks and audio locally."
                action={
                  <button
                    type="button"
                    onClick={() => navigate('studio')}
                    className="rounded-lg bg-[var(--vf-accent)] hover:bg-[var(--vf-accent-hover)] text-white px-3 py-1.5 text-xs font-medium cursor-pointer"
                  >
                    Open Studio
                  </button>
                }
              />
            ) : (
              <div className="space-y-2">
                {recentProjects.map((project) => {
                  const completed = project.chunks.filter((c) => c.status === 'completed').length;
                  return (
                    <button
                      key={project.id}
                      type="button"
                      onClick={() => void openProjectInStudio(project)}
                      className="w-full text-left rounded-xl border border-[var(--vf-border-subtle)] bg-[var(--vf-surface-elevated)] hover:border-[var(--vf-accent)]/40 p-3 transition-colors cursor-pointer"
                    >
                      <div className="flex items-center justify-between gap-2 text-xs">
                        <span className="font-medium truncate">{project.name}</span>
                        <span className="font-mono text-[11px] text-[var(--vf-text-muted)] shrink-0">
                          {completed}/{project.chunks.length} chunks
                        </span>
                      </div>
                      <div className="mt-1 flex items-center justify-between text-[11px] text-[var(--vf-text-subtle)]">
                        <span className="font-mono">{project.engineId}</span>
                        <span>{new Date(project.updatedAt).toLocaleDateString()}</span>
                      </div>
                    </button>
                  );
                })}
              </div>
            )}
          </section>
        </div>
      </div>
    </div>
  );
}
