import { useEffect, useRef, useState } from 'react';
import {
  AlertTriangle,
  Copy,
  Download,
  FolderOpen,
  Play,
  Plus,
  Search,
  Trash2,
  Upload,
} from 'lucide-react';
import {
  navigateToHash,
  sanitizeImportedProjectJson,
  triggerBrowserDownload,
} from '../components/studio';
import {
  useAppStore,
  useProjectStore,
  useStudioStore,
  useVoiceStore,
} from '../stores';
import type { NarrationProject } from '../types';

export function ProjectsPage() {
  const projects = useProjectStore((s) => s.projects);
  const loading = useProjectStore((s) => s.loading);
  const error = useProjectStore((s) => s.error);
  const loadProjects = useProjectStore((s) => s.loadProjects);
  const selectProject = useProjectStore((s) => s.selectProject);
  const createProject = useProjectStore((s) => s.createProject);
  const saveProjectRecord = useProjectStore((s) => s.saveProjectRecord);
  const deleteProjectRecord = useProjectStore((s) => s.deleteProjectRecord);

  const voices = useVoiceStore((s) => s.voices);
  const loadVoices = useVoiceStore((s) => s.loadVoices);

  const setActiveRoute = useAppStore((s) => s.setActiveRoute);

  const [query, setQuery] = useState('');
  const [confirmDeleteId, setConfirmDeleteId] = useState<string | null>(null);
  const [importError, setImportError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const fileInputRef = useRef<HTMLInputElement | null>(null);

  useEffect(() => {
    void loadProjects();
    void loadVoices();
  }, [loadProjects, loadVoices]);

  const voiceNameMap = new Map(voices.map((v) => [v.id, v.name]));

  const filtered = projects.filter((p) => {
    const q = query.trim().toLowerCase();
    if (!q) return true;
    const voiceName = (p.voiceProfileId ? voiceNameMap.get(p.voiceProfileId) : '') ?? '';
    return (
      p.name.toLowerCase().includes(q) ||
      p.engineId.toLowerCase().includes(q) ||
      voiceName.toLowerCase().includes(q)
    );
  });

  const handleOpenInStudio = async (project: NarrationProject) => {
    const loaded = await selectProject(project.id);
    if (!loaded) return;

    useStudioStore.setState({
      activeProjectId: loaded.id,
      projectTitle: loaded.name,
      scriptText: loaded.scriptText,
      undoStack: [],
      redoStack: [],
      selectedVoiceId: loaded.voiceProfileId,
      selectedEngineId: loaded.engineId,
      selectedPresetId: loaded.presetId,
      engineParameters: { ...loaded.engineParameters },
      mastering: { ...loaded.mastering },
      preprocessing: { ...loaded.preprocessing },
      sentencePauseMs: loaded.sentencePauseMs,
      paragraphPauseMs: loaded.paragraphPauseMs,
      chunkCrossfadeMs: loaded.chunkCrossfadeMs,
      activeProjectChunks: loaded.chunks,
    });
    useStudioStore.getState().saveDraft();

    setActiveRoute('studio');
    navigateToHash('#/studio');
  };

  const handleDuplicate = async (project: NarrationProject) => {
    setNotice(null);
    await createProject({
      name: `${project.name} (Copy)`,
      description: project.description,
      voiceProfileId: project.voiceProfileId,
      engineId: project.engineId,
      executionMode: project.executionMode,
      presetId: project.presetId,
      scriptText: project.scriptText,
      pronunciationRules: project.pronunciationRules,
      preprocessing: project.preprocessing,
      mastering: project.mastering,
      sentencePauseMs: project.sentencePauseMs,
      paragraphPauseMs: project.paragraphPauseMs,
      chunkCrossfadeMs: project.chunkCrossfadeMs,
      engineParameters: project.engineParameters,
    });
    setNotice(`Duplicated "${project.name}".`);
  };

  const handleExportJson = (project: NarrationProject) => {
    const cleanName = project.name.trim().replace(/[^a-zA-Z0-9._-]+/g, '_') || 'project';
    triggerBrowserDownload(
      JSON.stringify(project, null, 2),
      'application/json',
      `${cleanName}.voiceforge.json`
    );
  };

  const handleImportJsonFile = async (file: File) => {
    setImportError(null);
    setNotice(null);
    try {
      if (file.size > 16 * 1024 * 1024) {
        throw new Error('Project JSON exceeds 16 MB safety limit.');
      }
      const rawText = await file.text();
      const parsed: unknown = JSON.parse(rawText);
      const sanitized = sanitizeImportedProjectJson(parsed, { assignNewId: true });
      await saveProjectRecord(sanitized);
      setNotice(`Imported project "${sanitized.name}".`);
    } catch (err) {
      setImportError(err instanceof Error ? err.message : String(err));
    }
  };

  const handleNewBlankProject = () => {
    useStudioStore.getState().clearDraft();
    void selectProject(null);
    setActiveRoute('studio');
    navigateToHash('#/studio');
  };

  return (
    <div className="max-w-6xl mx-auto space-y-5 pb-10">
      <div className="flex flex-wrap items-center justify-between gap-3 pb-3 border-b border-[var(--vf-border-subtle)]">
        <div className="space-y-1">
          <h1 className="text-xl font-semibold tracking-tight text-[var(--vf-text)]">
            Narration Projects
          </h1>
          <p className="text-xs text-[var(--vf-text-muted)]">
            Manage long-form narration scripts, recover interrupted queues, and export portable project JSON.
          </p>
        </div>

        <div className="flex flex-wrap items-center gap-2">
          <input
            ref={fileInputRef}
            type="file"
            accept=".json,application/json"
            className="hidden"
            onChange={(e) => {
              const file = e.target.files?.[0];
              if (file) void handleImportJsonFile(file);
              e.target.value = '';
            }}
          />
          <button
            type="button"
            onClick={() => fileInputRef.current?.click()}
            className="inline-flex items-center gap-1.5 px-3 py-1.5 rounded-md text-xs font-semibold border border-[var(--vf-border)] bg-[var(--vf-surface-elevated)] text-[var(--vf-text)] hover:border-[var(--vf-accent)]/50 transition-colors cursor-pointer"
          >
            <Upload className="w-3.5 h-3.5" />
            Import Project JSON
          </button>
          <button
            type="button"
            onClick={handleNewBlankProject}
            className="inline-flex items-center gap-1.5 px-3.5 py-1.5 rounded-md text-xs font-semibold bg-[var(--vf-accent)] text-white hover:bg-[var(--vf-accent-hover)] transition-colors cursor-pointer"
          >
            <Plus className="w-3.5 h-3.5" />
            New Narration
          </button>
        </div>
      </div>

      {/* Search */}
      <div className="relative max-w-md">
        <Search className="w-3.5 h-3.5 text-[var(--vf-text-subtle)] absolute left-3 top-1/2 -translate-y-1/2" />
        <input
          type="text"
          value={query}
          onChange={(e) => setQuery(e.target.value)}
          placeholder="Search projects by title, voice, or engine..."
          className="w-full rounded-md border border-[var(--vf-border)] bg-[var(--vf-surface)] pl-9 pr-3 py-2 text-xs text-[var(--vf-text)] placeholder:text-[var(--vf-text-subtle)] focus:border-[var(--vf-accent)] focus:outline-none focus:ring-1 focus:ring-[var(--vf-accent)]/40"
        />
      </div>

      {importError && (
        <div className="rounded-lg border border-[var(--vf-danger)]/35 bg-[var(--vf-danger)]/10 px-4 py-2.5 text-xs text-[var(--vf-danger)]">
          {importError}
        </div>
      )}
      {error && (
        <div className="rounded-lg border border-[var(--vf-danger)]/35 bg-[var(--vf-danger)]/10 px-4 py-2.5 text-xs text-[var(--vf-danger)]">
          {error}
        </div>
      )}
      {notice && (
        <div className="rounded-lg border border-[var(--vf-success)]/35 bg-[var(--vf-success)]/10 px-4 py-2.5 text-xs text-[var(--vf-success)]">
          {notice}
        </div>
      )}

      {loading && projects.length === 0 ? (
        <div className="rounded-lg border border-[var(--vf-border)] bg-[var(--vf-surface)] p-8 text-center text-xs font-mono text-[var(--vf-text-muted)]">
          Loading saved projects from IndexedDB...
        </div>
      ) : filtered.length === 0 ? (
        <div className="rounded-lg border border-dashed border-[var(--vf-border)] bg-[var(--vf-surface)] p-10 text-center space-y-2">
          <FolderOpen className="w-8 h-8 text-[var(--vf-text-subtle)] mx-auto" />
          <div className="text-sm font-medium text-[var(--vf-text)]">
            {projects.length === 0 ? 'No saved projects yet' : 'No matching projects'}
          </div>
          <p className="text-xs text-[var(--vf-text-muted)]">
            Create a narration in Text to Speech Studio or import a `.voiceforge.json` file.
          </p>
        </div>
      ) : (
        <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
          {filtered.map((project) => {
            const total = project.chunks.length;
            const completed = project.chunks.filter((c) => c.status === 'completed').length;
            const failed = project.chunks.filter((c) => c.status === 'failed').length;
            const pendingOrCancelled = project.chunks.filter(
              (c) => c.status === 'pending' || c.status === 'cancelled'
            ).length;
            const pct = total > 0 ? Math.round((completed / total) * 100) : 0;
            const voiceName = project.voiceProfileId
              ? voiceNameMap.get(project.voiceProfileId) ?? 'Missing Voice'
              : 'Unassigned';

            return (
              <div
                key={project.id}
                className="rounded-lg border border-[var(--vf-border)] bg-[var(--vf-surface)] p-4 space-y-3 flex flex-col justify-between"
              >
                <div className="space-y-2.5">
                  <div className="flex items-start justify-between gap-2">
                    <div className="min-w-0">
                      <h2 className="text-sm font-semibold text-[var(--vf-text)] truncate">
                        {project.name}
                      </h2>
                      <div className="text-[11px] text-[var(--vf-text-muted)]">
                        Voice: <strong className="text-[var(--vf-text)]">{voiceName}</strong> ·
                        Engine:{' '}
                        <code className="font-mono text-[var(--vf-accent)]">{project.engineId}</code>
                      </div>
                    </div>
                    <span className="text-[11px] font-mono tabular-nums text-[var(--vf-text-subtle)] shrink-0">
                      {new Date(project.updatedAt).toLocaleDateString()}
                    </span>
                  </div>

                  <p className="rounded-md border border-[var(--vf-border-subtle)] bg-[var(--vf-bg)] px-2.5 py-2 text-xs text-[var(--vf-text-muted)] line-clamp-2">
                    {project.scriptText || '(Empty script)'}
                  </p>

                  {/* Queue Progress Well */}
                  <div className="space-y-1.5 pt-0.5">
                    <div className="flex items-center justify-between text-[11px]">
                      <span className="font-mono tabular-nums text-[var(--vf-text-muted)]">
                        Chunks: <strong className="text-[var(--vf-text)]">{completed}</strong> / {total} ({pct}%)
                      </span>
                      {failed > 0 && (
                        <span className="font-mono tabular-nums text-[var(--vf-danger)] font-medium">
                          {failed} failed
                        </span>
                      )}
                    </div>
                    <div className="w-full h-1.5 rounded-sm bg-[var(--vf-bg)] border border-[var(--vf-border-subtle)] overflow-hidden">
                      <div
                        className={`h-full ${
                          failed > 0 ? 'bg-[var(--vf-warning)]' : 'bg-[var(--vf-accent)]'
                        }`}
                        style={{ width: `${pct}%` }}
                      />
                    </div>
                    {completed > 0 && pendingOrCancelled > 0 && (
                      <div className="inline-flex items-center gap-1.5 text-[11px] text-[var(--vf-warning)] pt-0.5">
                        <AlertTriangle className="w-3 h-3 shrink-0" />
                        Interrupted job ({pendingOrCancelled} remaining) — ready to resume in Studio
                      </div>
                    )}
                  </div>
                </div>

                {/* Actions */}
                <div className="pt-2.5 border-t border-[var(--vf-border-subtle)] flex flex-wrap items-center justify-between gap-2">
                  <button
                    type="button"
                    onClick={() => void handleOpenInStudio(project)}
                    className="inline-flex items-center gap-1.5 px-3 py-1.5 rounded-md text-xs font-semibold bg-[var(--vf-accent)] text-white hover:bg-[var(--vf-accent-hover)] transition-colors cursor-pointer"
                  >
                    <Play className="w-3.5 h-3.5" />
                    {completed > 0 && pendingOrCancelled > 0 ? 'Resume in Studio' : 'Open in Studio'}
                  </button>

                  <div className="flex items-center gap-1">
                    <button
                      type="button"
                      onClick={() => void handleDuplicate(project)}
                      className="p-1.5 rounded-md text-[var(--vf-text-muted)] hover:text-[var(--vf-text)] hover:bg-[var(--vf-surface-elevated)] transition-colors cursor-pointer"
                      title="Duplicate project"
                    >
                      <Copy className="w-3.5 h-3.5" />
                    </button>
                    <button
                      type="button"
                      onClick={() => handleExportJson(project)}
                      className="p-1.5 rounded-md text-[var(--vf-text-muted)] hover:text-[var(--vf-text)] hover:bg-[var(--vf-surface-elevated)] transition-colors cursor-pointer"
                      title="Export Project JSON"
                    >
                      <Download className="w-3.5 h-3.5" />
                    </button>

                    {confirmDeleteId === project.id ? (
                      <div className="inline-flex items-center gap-1 ml-1">
                        <button
                          type="button"
                          onClick={() => {
                            void deleteProjectRecord(project.id).then(() => {
                              if (useStudioStore.getState().activeProjectId === project.id) {
                                useStudioStore.getState().setActiveProjectId(null);
                              }
                              setConfirmDeleteId(null);
                              setNotice(`Deleted "${project.name}" and its cached audio chunks.`);
                            });
                          }}
                          className="px-2 py-1 rounded-md bg-rose-600 text-white text-[11px] font-semibold hover:bg-rose-500 cursor-pointer"
                        >
                          Confirm
                        </button>
                        <button
                          type="button"
                          onClick={() => setConfirmDeleteId(null)}
                          className="px-2 py-1 rounded-md border border-[var(--vf-border)] bg-[var(--vf-bg)] text-[11px] text-[var(--vf-text-muted)] hover:text-[var(--vf-text)] cursor-pointer"
                        >
                          Cancel
                        </button>
                      </div>
                    ) : (
                      <button
                        type="button"
                        onClick={() => setConfirmDeleteId(project.id)}
                        className="p-1.5 rounded-md text-[var(--vf-text-muted)] hover:text-[var(--vf-danger)] hover:bg-[var(--vf-danger)]/10 transition-colors cursor-pointer"
                        title="Delete project and audio chunks"
                      >
                        <Trash2 className="w-3.5 h-3.5" />
                      </button>
                    )}
                  </div>
                </div>
              </div>
            );
          })}
        </div>
      )}
    </div>
  );
}
