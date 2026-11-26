import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import {
  AlertCircle,
  ArrowRight,
  Check,
  Copy,
  Download,
  Edit3,
  Loader2,
  Plus,
  Search,
  ShieldCheck,
  Star,
  Trash2,
  Upload,
  Volume2,
  X,
} from 'lucide-react';
import { WaveformPlayer } from '../components/audio/WaveformPlayer';
import {
  BUILTIN_VOICES,
  fetchBuiltinVoiceAudioBuffer,
  type BuiltinVoiceCatalogEntry,
} from '../services/builtinVoices';
import { VoiceProfileImportError } from '../services/voiceProfileIO';
import {
  deleteAudioChunk,
  getAudioChunk,
  getAudioChunkByKey,
} from '../storage/db';
import { useStudioStore, useVoiceStore } from '../stores';
import type { VoiceProfile } from '../types';

interface LoadedPreviewAudio {
  voiceId: string;
  label: string;
  samples: Float32Array;
  sampleRate: number;
}

function formatEngineBadge(engineId: string): string {
  if (engineId === 'pocket-tts') return 'Pocket TTS';
  if (engineId === 'chatterbox') return 'Chatterbox ONNX';
  return engineId;
}

function slugifyFilename(name: string): string {
  const slug = name
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '');
  return slug || 'voice-profile';
}

function triggerJsonDownload(jsonText: string, filename: string): void {
  const blob = new Blob([jsonText], { type: 'application/json' });
  const url = URL.createObjectURL(blob);
  const link = document.createElement('a');
  link.href = url;
  link.download = filename;
  document.body.appendChild(link);
  link.click();
  document.body.removeChild(link);
  URL.revokeObjectURL(url);
}

export function MyVoicesPage() {
  const voices = useVoiceStore((s) => s.voices);
  const defaultVoiceId = useVoiceStore((s) => s.defaultVoiceId);
  const loading = useVoiceStore((s) => s.loading);
  const loadVoices = useVoiceStore((s) => s.loadVoices);
  const setDefaultNarrator = useVoiceStore((s) => s.setDefaultNarrator);
  const renameVoice = useVoiceStore((s) => s.renameVoice);
  const duplicateVoice = useVoiceStore((s) => s.duplicateVoice);
  const deleteVoiceProfile = useVoiceStore((s) => s.deleteVoiceProfile);
  const exportVoice = useVoiceStore((s) => s.exportVoice);
  const importVoice = useVoiceStore((s) => s.importVoice);

  const selectStudioVoice = useStudioStore((s) => s.selectVoice);
  const selectStudioEngine = useStudioStore((s) => s.selectEngine);
  const currentStudioEngine = useStudioStore((s) => s.selectedEngineId);

  const [searchQuery, setSearchQuery] = useState('');
  const [engineFilter, setEngineFilter] = useState<string>('all');

  const [renamingId, setRenamingId] = useState<string | null>(null);
  const [renameDraft, setRenameDraft] = useState('');
  const [deleteTarget, setDeleteTarget] = useState<VoiceProfile | null>(null);

  const [activePreview, setActivePreview] = useState<LoadedPreviewAudio | null>(null);
  const [loadingBuiltinId, setLoadingBuiltinId] = useState<string | null>(null);
  const [previewNotice, setPreviewNotice] = useState<{ voiceId: string; message: string } | null>(
    null
  );

  const [alertBanner, setAlertBanner] = useState<{
    kind: 'error' | 'success';
    message: string;
  } | null>(null);

  const importInputRef = useRef<HTMLInputElement | null>(null);

  useEffect(() => {
    void loadVoices().catch((err) => {
      setAlertBanner({
        kind: 'error',
        message: err instanceof Error ? err.message : String(err),
      });
    });
  }, [loadVoices]);

  const filteredVoices = useMemo(() => {
    const q = searchQuery.trim().toLowerCase();
    return voices.filter((voice) => {
      const payloads = Object.values(voice.conditioningPayloads);
      if (engineFilter !== 'all') {
        const hasEngine = payloads.some((p) => p.engineId === engineFilter);
        if (!hasEngine) return false;
      }
      if (!q) return true;
      const haystack = [
        voice.name,
        voice.description ?? '',
        voice.language,
        ...voice.tags,
        ...payloads.map((p) => p.engineId),
      ]
        .join(' ')
        .toLowerCase();
      return haystack.includes(q);
    });
  }, [engineFilter, searchQuery, voices]);

  const handleStartRename = useCallback((voice: VoiceProfile) => {
    setRenamingId(voice.id);
    setRenameDraft(voice.name);
  }, []);

  const handleCommitRename = useCallback(
    async (id: string) => {
      const trimmed = renameDraft.trim();
      if (!trimmed) {
        setAlertBanner({ kind: 'error', message: 'Voice name cannot be empty.' });
        return;
      }
      try {
        await renameVoice(id, trimmed);
        setRenamingId(null);
        setAlertBanner({ kind: 'success', message: `Renamed voice profile to "${trimmed}".` });
      } catch (err) {
        setAlertBanner({
          kind: 'error',
          message: err instanceof Error ? err.message : String(err),
        });
      }
    },
    [renameDraft, renameVoice]
  );

  const handleDuplicate = useCallback(
    async (voice: VoiceProfile) => {
      try {
        const copy = await duplicateVoice(voice.id);
        setAlertBanner({
          kind: 'success',
          message: `Duplicated "${voice.name}" as "${copy.name}".`,
        });
      } catch (err) {
        setAlertBanner({
          kind: 'error',
          message: err instanceof Error ? err.message : String(err),
        });
      }
    },
    [duplicateVoice]
  );

  const handleExport = useCallback(
    async (voice: VoiceProfile) => {
      try {
        const json = await exportVoice(voice.id);
        triggerJsonDownload(json, `${slugifyFilename(voice.name)}.vfvoice.json`);
        setAlertBanner({
          kind: 'success',
          message: `Exported "${voice.name}" as ${slugifyFilename(voice.name)}.vfvoice.json.`,
        });
      } catch (err) {
        setAlertBanner({
          kind: 'error',
          message: err instanceof Error ? err.message : String(err),
        });
      }
    },
    [exportVoice]
  );

  const handleImportFileChange = useCallback(
    async (e: React.ChangeEvent<HTMLInputElement>) => {
      const file = e.target.files?.[0];
      e.target.value = '';
      if (!file) return;

      setAlertBanner(null);
      try {
        const text = await file.text();
        const imported = await importVoice(text);
        setAlertBanner({
          kind: 'success',
          message: `Imported voice profile "${imported.name}" successfully.`,
        });
      } catch (err) {
        if (err instanceof VoiceProfileImportError) {
          setAlertBanner({
            kind: 'error',
            message: `Voice import rejected [${err.code}]: ${err.message}`,
          });
        } else {
          setAlertBanner({
            kind: 'error',
            message: `Voice import failed: ${err instanceof Error ? err.message : String(err)}`,
          });
        }
      }
    },
    [importVoice]
  );

  const handlePlayStoredAudio = useCallback(
    async (voice: VoiceProfile, kind: 'reference' | 'synth') => {
      setPreviewNotice(null);
      if (
        activePreview?.voiceId === voice.id &&
        ((kind === 'reference' && activePreview.label === 'Reference Audio') ||
          (kind === 'synth' && activePreview.label === 'Synthesized Preview'))
      ) {
        setActivePreview(null);
        return;
      }

      try {
        let chunk =
          kind === 'synth'
            ? await getAudioChunk('voice-preview-synth', voice.id)
            : voice.previewClipId
              ? await getAudioChunkByKey(voice.previewClipId)
              : await getAudioChunk('voice-preview', voice.id);

        if (!chunk && kind === 'reference') {
          chunk = await getAudioChunk('voice-preview-synth', voice.id);
        }

        if (!chunk) {
          setPreviewNotice({
            voiceId: voice.id,
            message:
              kind === 'synth'
                ? 'No synthesized preview saved for this voice yet.'
                : 'No local reference audio stored in IndexedDB (common for imported .vfvoice.json bundles).',
          });
          return;
        }

        const samples = new Float32Array(chunk.pcmBytes);
        setActivePreview({
          voiceId: voice.id,
          label: kind === 'synth' ? 'Synthesized Preview' : 'Reference Audio',
          samples,
          sampleRate: chunk.sampleRate,
        });
      } catch (err) {
        setPreviewNotice({
          voiceId: voice.id,
          message: err instanceof Error ? err.message : String(err),
        });
      }
    },
    [activePreview]
  );

  const handleUseInStudio = useCallback(
    (voice: VoiceProfile) => {
      const payloads = Object.values(voice.conditioningPayloads);
      const supportsCurrent = payloads.some((p) => p.engineId === currentStudioEngine);
      if (!supportsCurrent && payloads[0]?.engineId) {
        selectStudioEngine(payloads[0].engineId);
      }
      selectStudioVoice(voice.id);
      window.location.hash = '#/studio';
    },
    [currentStudioEngine, selectStudioEngine, selectStudioVoice]
  );

  const handlePreviewBuiltinVoice = useCallback(
    async (entry: BuiltinVoiceCatalogEntry) => {
      setPreviewNotice(null);
      if (activePreview?.voiceId === entry.id) {
        setActivePreview(null);
        return;
      }
      setLoadingBuiltinId(entry.id);
      try {
        const buf = await fetchBuiltinVoiceAudioBuffer(entry);
        setActivePreview({
          voiceId: entry.id,
          label: `${entry.license} Sample`,
          samples: buf.samples,
          sampleRate: buf.sampleRate,
        });
      } catch (err) {
        setPreviewNotice({
          voiceId: entry.id,
          message: err instanceof Error ? err.message : String(err),
        });
      } finally {
        setLoadingBuiltinId(null);
      }
    },
    [activePreview]
  );

  const handleUseBuiltinInStudio = useCallback(
    (entry: BuiltinVoiceCatalogEntry) => {
      selectStudioVoice(entry.id);
      window.location.hash = '#/studio';
    },
    [selectStudioVoice]
  );

  const handleConfirmDelete = useCallback(async () => {
    if (!deleteTarget) return;
    const target = deleteTarget;
    setDeleteTarget(null);
    try {
      await deleteVoiceProfile(target.id);
      await Promise.all([
        deleteAudioChunk('voice-preview', target.id).catch(() => undefined),
        deleteAudioChunk('voice-preview-synth', target.id).catch(() => undefined),
      ]);
      setActivePreview((prev) => (prev?.voiceId === target.id ? null : prev));
      setAlertBanner({
        kind: 'success',
        message: `Permanently deleted voice profile "${target.name}".`,
      });
    } catch (err) {
      setAlertBanner({
        kind: 'error',
        message: err instanceof Error ? err.message : String(err),
      });
    }
  }, [deleteTarget, deleteVoiceProfile]);

  return (
    <div className="max-w-6xl mx-auto space-y-5 pb-10">
      {/* Header */}
      <div className="flex flex-wrap items-start justify-between gap-4 pb-3 border-b border-[var(--vf-border-subtle)]">
        <div className="space-y-1">
          <h1 className="text-xl font-semibold tracking-tight text-[var(--vf-text)]">
            My Voices
          </h1>
          <p className="text-xs text-[var(--vf-text-muted)]">
            Manage locally encoded voice profiles, default narrator selection, and portable{' '}
            <code className="font-mono">.vfvoice.json</code> bundles.
          </p>
        </div>

        <div className="flex flex-wrap items-center gap-2">
          <input
            ref={importInputRef}
            type="file"
            accept=".vfvoice.json,.json,application/json"
            onChange={handleImportFileChange}
            className="sr-only"
          />
          <button
            type="button"
            onClick={() => importInputRef.current?.click()}
            className="inline-flex items-center gap-1.5 rounded-md border border-[var(--vf-border)] bg-[var(--vf-surface-elevated)] px-3 py-1.5 text-xs font-semibold text-[var(--vf-text)] hover:border-[var(--vf-accent)]/50 transition-colors cursor-pointer"
          >
            <Upload className="h-3.5 w-3.5" />
            Import .vfvoice.json
          </button>

          <button
            type="button"
            onClick={() => {
              window.location.hash = '#/clone';
            }}
            className="inline-flex items-center gap-1.5 rounded-md bg-[var(--vf-accent)] hover:bg-[var(--vf-accent-hover)] px-3.5 py-1.5 text-xs font-semibold text-white transition-colors cursor-pointer"
          >
            <Plus className="h-3.5 w-3.5" />
            Clone New Voice
          </button>
        </div>
      </div>

      {/* Alert Banner */}
      {alertBanner && (
        <div
          role={alertBanner.kind === 'error' ? 'alert' : 'status'}
          className={`flex items-start justify-between gap-3 rounded-lg border p-3.5 text-xs ${
            alertBanner.kind === 'error'
              ? 'border-[var(--vf-danger)]/35 bg-[var(--vf-danger)]/10 text-[var(--vf-danger)]'
              : 'border-[var(--vf-success)]/35 bg-[var(--vf-success)]/10 text-[var(--vf-success)]'
          }`}
        >
          <div className="flex items-start gap-2">
            {alertBanner.kind === 'error' ? (
              <AlertCircle className="h-4 w-4 shrink-0 mt-0.5" />
            ) : (
              <Check className="h-4 w-4 shrink-0 mt-0.5" />
            )}
            <span>{alertBanner.message}</span>
          </div>
          <button
            type="button"
            onClick={() => setAlertBanner(null)}
            aria-label="Dismiss notification"
            className="opacity-70 hover:opacity-100 cursor-pointer"
          >
            <X className="h-4 w-4" />
          </button>
        </div>
      )}

      {/* Search & Filter Toolbar */}
      <div className="flex flex-col sm:flex-row gap-3">
        <div className="relative flex-1">
          <Search className="absolute left-3 top-1/2 -translate-y-1/2 h-3.5 w-3.5 text-[var(--vf-text-subtle)]" />
          <input
            type="search"
            value={searchQuery}
            onChange={(e) => setSearchQuery(e.target.value)}
            placeholder="Search by voice name, tag, language, or description..."
            className="w-full rounded-md border border-[var(--vf-border)] bg-[var(--vf-surface)] pl-9 pr-3 py-2 text-xs text-[var(--vf-text)] placeholder:text-[var(--vf-text-subtle)] focus:outline-none focus:border-[var(--vf-accent)] focus:ring-1 focus:ring-[var(--vf-accent)]/40"
          />
        </div>

        <div className="inline-flex rounded-md border border-[var(--vf-border)] bg-[var(--vf-surface)] p-0.5 self-start">
          {[
            { id: 'all', label: 'All Engines' },
            { id: 'pocket-tts', label: 'Pocket TTS' },
            { id: 'chatterbox', label: 'Chatterbox' },
          ].map((opt) => (
            <button
              key={opt.id}
              type="button"
              onClick={() => setEngineFilter(opt.id)}
              className={`rounded-sm px-3 py-1.5 text-xs font-medium transition-colors cursor-pointer ${
                engineFilter === opt.id
                  ? 'bg-[var(--vf-accent)] text-white'
                  : 'text-[var(--vf-text-muted)] hover:text-[var(--vf-text)]'
              }`}
            >
              {opt.label}
            </button>
          ))}
        </div>
      </div>

      {/* Voice List */}
      {loading && voices.length === 0 ? (
        <div className="rounded-lg border border-[var(--vf-border)] bg-[var(--vf-surface)] p-10 text-center text-xs font-mono text-[var(--vf-text-muted)]">
          Loading saved voice profiles from IndexedDB...
        </div>
      ) : filteredVoices.length === 0 ? (
        <div className="rounded-lg border border-dashed border-[var(--vf-border)] bg-[var(--vf-surface)] p-10 text-center space-y-3">
          <p className="text-sm font-medium text-[var(--vf-text)]">
            {voices.length === 0
              ? 'No voice profiles saved yet'
              : 'No voice profiles match your current search or filter'}
          </p>
          <p className="text-xs text-[var(--vf-text-muted)]">
            {voices.length === 0
              ? 'Clone an authorized voice locally or import a verified .vfvoice.json bundle.'
              : 'Try clearing your search query or switching the engine filter.'}
          </p>
          {voices.length === 0 && (
            <button
              type="button"
              onClick={() => {
                window.location.hash = '#/clone';
              }}
              className="inline-flex items-center gap-1.5 rounded-md bg-[var(--vf-accent)] hover:bg-[var(--vf-accent-hover)] px-4 py-2 text-xs font-semibold text-white cursor-pointer"
            >
              <Plus className="h-3.5 w-3.5" />
              Clone Your First Voice
            </button>
          )}
        </div>
      ) : (
        <div className="grid grid-cols-1 lg:grid-cols-2 gap-4">
          {filteredVoices.map((voice) => {
            const isDefault = defaultVoiceId === voice.id;
            const payloads = Object.values(voice.conditioningPayloads);
            const isRenaming = renamingId === voice.id;
            const isPreviewOpen = activePreview?.voiceId === voice.id;

            return (
              <article
                key={voice.id}
                className={`rounded-lg border bg-[var(--vf-surface)] p-4 space-y-3.5 transition-colors ${
                  isDefault
                    ? 'border-[var(--vf-accent)]'
                    : 'border-[var(--vf-border)]'
                }`}
              >
                {/* Top Row: Name + Default Narrator Star */}
                <div className="flex items-start justify-between gap-3">
                  <div className="min-w-0 flex-1">
                    {isRenaming ? (
                      <div className="flex items-center gap-1.5">
                        <input
                          type="text"
                          value={renameDraft}
                          onChange={(e) => setRenameDraft(e.target.value)}
                          onKeyDown={(e) => {
                            if (e.key === 'Enter') void handleCommitRename(voice.id);
                            if (e.key === 'Escape') setRenamingId(null);
                          }}
                          autoFocus
                          className="flex-1 rounded-md border border-[var(--vf-accent)] bg-[var(--vf-bg)] px-2.5 py-1 text-sm font-semibold text-[var(--vf-text)] focus:outline-none"
                        />
                        <button
                          type="button"
                          onClick={() => void handleCommitRename(voice.id)}
                          aria-label="Save name"
                          className="rounded-md bg-emerald-600 hover:bg-emerald-500 p-1.5 text-white cursor-pointer"
                        >
                          <Check className="h-3.5 w-3.5" />
                        </button>
                        <button
                          type="button"
                          onClick={() => setRenamingId(null)}
                          aria-label="Cancel rename"
                          className="rounded-md border border-[var(--vf-border)] bg-[var(--vf-bg)] p-1.5 text-[var(--vf-text-muted)] cursor-pointer"
                        >
                          <X className="h-3.5 w-3.5" />
                        </button>
                      </div>
                    ) : (
                      <div className="flex items-center gap-2">
                        <h2 className="truncate text-base font-semibold text-[var(--vf-text)]">
                          {voice.name}
                        </h2>
                        {isDefault && (
                          <span className="shrink-0 rounded-sm bg-[var(--vf-warning)]/15 border border-[var(--vf-warning)]/35 px-2 py-0.5 text-[10px] font-mono uppercase tracking-wider font-semibold text-[var(--vf-warning)]">
                            Default Narrator
                          </span>
                        )}
                      </div>
                    )}

                    {voice.description && (
                      <p className="mt-1 text-xs text-[var(--vf-text-muted)] line-clamp-2">
                        {voice.description}
                      </p>
                    )}
                  </div>

                  <button
                    type="button"
                    onClick={() => void setDefaultNarrator(voice.id)}
                    title={isDefault ? 'Default narrator' : 'Set as default narrator'}
                    aria-label={isDefault ? 'Default narrator' : 'Set as default narrator'}
                    className={`rounded-md border p-2 transition-colors cursor-pointer ${
                      isDefault
                        ? 'border-[var(--vf-warning)]/45 bg-[var(--vf-warning)]/15 text-[var(--vf-warning)]'
                        : 'border-[var(--vf-border)] bg-[var(--vf-bg)] text-[var(--vf-text-subtle)] hover:text-[var(--vf-warning)] hover:border-[var(--vf-warning)]/40'
                    }`}
                  >
                    <Star className={`h-4 w-4 ${isDefault ? 'fill-current' : ''}`} />
                  </button>
                </div>

                {/* Engine Specs, Revision, Language, Duration & Quality Score */}
                <div className="flex flex-wrap items-center gap-1.5 text-[11px]">
                  {payloads.map((payload) => (
                    <span
                      key={`${payload.engineId}::${payload.modelRevision}`}
                      title={`Pinned revision: ${payload.modelRevision}`}
                      className="inline-flex items-center gap-1 rounded-sm bg-[var(--vf-accent-soft)] border border-[var(--vf-accent)]/35 px-2 py-0.5 font-medium text-[var(--vf-accent)]"
                    >
                      {formatEngineBadge(payload.engineId)}
                      <code className="font-mono text-[10px] opacity-85">
                        @{payload.modelRevision.slice(0, 7)}
                      </code>
                    </span>
                  ))}

                  <span className="rounded-sm border border-[var(--vf-border-subtle)] bg-[var(--vf-bg)] px-2 py-0.5 font-mono uppercase text-[var(--vf-text-muted)]">
                    {voice.language}
                  </span>

                  <span className="rounded-sm border border-[var(--vf-border-subtle)] bg-[var(--vf-bg)] px-2 py-0.5 font-mono tabular-nums text-[var(--vf-text-muted)]">
                    Ref {voice.referenceClip.durationSec.toFixed(1)}s
                  </span>

                  <span
                    className={`rounded-sm border px-2 py-0.5 font-mono tabular-nums font-semibold ${
                      voice.qualityAnalysis.overallScore >= 80
                        ? 'border-[var(--vf-success)]/35 bg-[var(--vf-success)]/15 text-[var(--vf-success)]'
                        : voice.qualityAnalysis.overallScore >= 55
                          ? 'border-[var(--vf-warning)]/35 bg-[var(--vf-warning)]/15 text-[var(--vf-warning)]'
                          : 'border-[var(--vf-danger)]/35 bg-[var(--vf-danger)]/15 text-[var(--vf-danger)]'
                    }`}
                  >
                    Quality {voice.qualityAnalysis.overallScore}/100
                  </span>

                  <span
                    title={voice.authorizedUse.attestationText}
                    className="inline-flex items-center gap-1 rounded-sm border border-[var(--vf-success)]/30 bg-[var(--vf-success)]/10 px-2 py-0.5 text-[var(--vf-success)]"
                  >
                    <ShieldCheck className="h-3 w-3" />
                    {voice.authorizedUse.sourceBasis}
                  </span>
                </div>

                {/* Tags */}
                {voice.tags.length > 0 && (
                  <div className="flex flex-wrap gap-1">
                    {voice.tags.map((tag) => (
                      <span
                        key={tag}
                        className="rounded-sm bg-[var(--vf-bg)] border border-[var(--vf-border-subtle)] px-2 py-0.5 font-mono text-[10px] text-[var(--vf-text-muted)]"
                      >
                        #{tag}
                      </span>
                    ))}
                  </div>
                )}

                {/* Stored Audio Playback Controls */}
                <div className="flex flex-wrap items-center gap-2 pt-1">
                  <button
                    type="button"
                    onClick={() => void handlePlayStoredAudio(voice, 'reference')}
                    className="inline-flex items-center gap-1.5 rounded-md border border-[var(--vf-border)] bg-[var(--vf-bg)] px-2.5 py-1.5 text-xs font-medium text-[var(--vf-text)] hover:border-[var(--vf-accent)]/50 transition-colors cursor-pointer"
                  >
                    <Volume2 className="h-3.5 w-3.5 text-[var(--vf-accent)]" />
                    {isPreviewOpen && activePreview?.label === 'Reference Audio'
                      ? 'Hide Reference Player'
                      : 'Play Reference'}
                  </button>

                  <button
                    type="button"
                    onClick={() => void handlePlayStoredAudio(voice, 'synth')}
                    className="inline-flex items-center gap-1.5 rounded-md border border-[var(--vf-border)] bg-[var(--vf-bg)] px-2.5 py-1.5 text-xs font-medium text-[var(--vf-text)] hover:border-[var(--vf-success)]/50 transition-colors cursor-pointer"
                  >
                    <Volume2 className="h-3.5 w-3.5 text-[var(--vf-success)]" />
                    {isPreviewOpen && activePreview?.label === 'Synthesized Preview'
                      ? 'Hide Preview Player'
                      : 'Play Synth Preview'}
                  </button>
                </div>

                {previewNotice?.voiceId === voice.id && (
                  <p className="text-[11px] text-[var(--vf-warning)]">
                    {previewNotice.message}
                  </p>
                )}

                {isPreviewOpen && activePreview && (
                  <WaveformPlayer
                    samples={activePreview.samples}
                    sampleRate={activePreview.sampleRate}
                    title={`${voice.name} — ${activePreview.label}`}
                    compact
                  />
                )}

                {/* Card Footer Actions */}
                <div className="flex flex-wrap items-center justify-between gap-2 pt-2.5 border-t border-[var(--vf-border-subtle)]">
                  <div className="flex flex-wrap items-center gap-1">
                    <button
                      type="button"
                      onClick={() => handleStartRename(voice)}
                      title="Rename voice"
                      className="inline-flex items-center gap-1 rounded-md px-2 py-1 text-xs text-[var(--vf-text-muted)] hover:text-[var(--vf-text)] hover:bg-[var(--vf-surface-elevated)] cursor-pointer"
                    >
                      <Edit3 className="h-3.5 w-3.5" />
                      Rename
                    </button>

                    <button
                      type="button"
                      onClick={() => void handleDuplicate(voice)}
                      title="Duplicate voice"
                      className="inline-flex items-center gap-1 rounded-md px-2 py-1 text-xs text-[var(--vf-text-muted)] hover:text-[var(--vf-text)] hover:bg-[var(--vf-surface-elevated)] cursor-pointer"
                    >
                      <Copy className="h-3.5 w-3.5" />
                      Duplicate
                    </button>

                    <button
                      type="button"
                      onClick={() => void handleExport(voice)}
                      title="Export .vfvoice.json"
                      className="inline-flex items-center gap-1 rounded-md px-2 py-1 text-xs text-[var(--vf-text-muted)] hover:text-[var(--vf-text)] hover:bg-[var(--vf-surface-elevated)] cursor-pointer"
                    >
                      <Download className="h-3.5 w-3.5" />
                      Export
                    </button>

                    <button
                      type="button"
                      onClick={() => setDeleteTarget(voice)}
                      title="Delete voice permanently"
                      className="inline-flex items-center gap-1 rounded-md px-2 py-1 text-xs text-[var(--vf-danger)] hover:bg-[var(--vf-danger)]/10 cursor-pointer"
                    >
                      <Trash2 className="h-3.5 w-3.5" />
                      Delete
                    </button>
                  </div>

                  <button
                    type="button"
                    onClick={() => handleUseInStudio(voice)}
                    className="inline-flex items-center gap-1.5 rounded-md bg-[var(--vf-accent)] hover:bg-[var(--vf-accent-hover)] px-3 py-1.5 text-xs font-semibold text-white transition-colors cursor-pointer"
                  >
                    Use in Studio
                    <ArrowRight className="h-3.5 w-3.5" />
                  </button>
                </div>
              </article>
            );
          })}
        </div>
      )}

      {/* Built-In Open-Licensed Voices */}
      <section className="space-y-3 pt-2 border-t border-[var(--vf-border-subtle)]">
        <div className="flex flex-wrap items-center justify-between gap-2">
          <div>
            <h2 className="text-base font-semibold tracking-tight text-[var(--vf-text)]">
              Built-In Open-Licensed Voices
            </h2>
            <p className="text-xs text-[var(--vf-text-muted)]">
              Ready-to-use permissive voices ({BUILTIN_VOICES.length} narrators, CC0 / CC-BY-4.0 / MIT). Cached locally and auto-encoded in your browser on first Studio run — no manual cloning needed.
            </p>
          </div>
          <span className="rounded-sm border border-[var(--vf-border)] bg-[var(--vf-surface)] px-2.5 py-1 text-[11px] font-mono text-[var(--vf-text-muted)]">
            0 API keys · Unlimited chars
          </span>
        </div>

        <div className="grid grid-cols-1 lg:grid-cols-2 gap-3.5">
          {BUILTIN_VOICES.map((entry) => {
            const isPreviewOpen = activePreview?.voiceId === entry.id;
            const isLoadingSample = loadingBuiltinId === entry.id;
            const isSavedLocally = voices.some((v) => v.id === entry.id);

            return (
              <article
                key={entry.id}
                className="rounded-lg border border-[var(--vf-border)] bg-[var(--vf-surface)] p-4 space-y-2.5"
              >
                <div className="flex items-start justify-between gap-3">
                  <div className="min-w-0">
                    <div className="flex flex-wrap items-center gap-2">
                      <h3 className="text-sm font-semibold text-[var(--vf-text)] truncate">
                        {entry.name}
                      </h3>
                      <span className="rounded-sm border border-[var(--vf-success)]/35 bg-[var(--vf-success)]/12 px-1.5 py-0.5 text-[10px] font-mono font-semibold text-[var(--vf-success)]">
                        {entry.license}
                      </span>
                      {isSavedLocally && (
                        <span className="rounded-sm border border-[var(--vf-accent)]/35 bg-[var(--vf-accent-soft)] px-1.5 py-0.5 text-[10px] font-mono font-semibold text-[var(--vf-accent)]">
                          Encoded Locally
                        </span>
                      )}
                    </div>
                    <p className="text-[11px] font-mono text-[var(--vf-text-subtle)] mt-0.5">
                      {entry.role}
                    </p>
                  </div>
                </div>

                <p className="text-xs text-[var(--vf-text-muted)] leading-relaxed">
                  {entry.description}
                </p>

                <p className="text-[11px] text-[var(--vf-text-subtle)] truncate" title={entry.attribution}>
                  Source: {entry.attribution}
                </p>

                {previewNotice?.voiceId === entry.id && (
                  <p className="text-[11px] text-[var(--vf-warning)]">
                    {previewNotice.message}
                  </p>
                )}

                {isPreviewOpen && activePreview && (
                  <WaveformPlayer
                    samples={activePreview.samples}
                    sampleRate={activePreview.sampleRate}
                    title={`${entry.name} — ${activePreview.label}`}
                    compact
                  />
                )}

                <div className="flex flex-wrap items-center justify-between gap-2 pt-2 border-t border-[var(--vf-border-subtle)]">
                  <button
                    type="button"
                    disabled={isLoadingSample}
                    onClick={() => void handlePreviewBuiltinVoice(entry)}
                    className="inline-flex items-center gap-1.5 rounded-md border border-[var(--vf-border)] bg-[var(--vf-bg)] px-2.5 py-1.5 text-xs font-medium text-[var(--vf-text)] hover:border-[var(--vf-accent)]/50 transition-colors cursor-pointer disabled:opacity-50"
                  >
                    {isLoadingSample ? (
                      <Loader2 className="h-3.5 w-3.5 animate-spin text-[var(--vf-accent)]" />
                    ) : (
                      <Volume2 className="h-3.5 w-3.5 text-[var(--vf-accent)]" />
                    )}
                    {isLoadingSample
                      ? 'Fetching Sample...'
                      : isPreviewOpen
                        ? 'Hide Sample'
                        : 'Listen Sample'}
                  </button>

                  <button
                    type="button"
                    onClick={() => handleUseBuiltinInStudio(entry)}
                    className="inline-flex items-center gap-1.5 rounded-md bg-[var(--vf-accent)] hover:bg-[var(--vf-accent-hover)] px-3 py-1.5 text-xs font-semibold text-white transition-colors cursor-pointer"
                  >
                    Use in Studio
                    <ArrowRight className="h-3.5 w-3.5" />
                  </button>
                </div>
              </article>
            );
          })}
        </div>
      </section>

      {/* Permanent Delete Confirmation Modal */}
      {deleteTarget && (
        <div
          role="dialog"
          aria-modal="true"
          aria-labelledby="delete-voice-title"
          className="fixed inset-0 z-50 flex items-center justify-center bg-black/70 p-4"
        >
          <div className="max-w-md w-full rounded-lg border border-[var(--vf-border)] bg-[var(--vf-surface)] p-5 shadow-2xl space-y-4">
            <div className="flex items-start gap-3">
              <div className="h-9 w-9 rounded-md bg-[var(--vf-danger)]/15 border border-[var(--vf-danger)]/35 flex items-center justify-center text-[var(--vf-danger)] shrink-0">
                <Trash2 className="h-4 w-4" />
              </div>
              <div className="space-y-1">
                <h2
                  id="delete-voice-title"
                  className="text-base font-semibold text-[var(--vf-text)]"
                >
                  Delete &ldquo;{deleteTarget.name}&rdquo;?
                </h2>
                <p className="text-xs text-[var(--vf-text-muted)] leading-relaxed">
                  This permanently deletes the voice profile, its encoded conditioning tensors,
                  and its locally stored reference/preview audio from IndexedDB. This action
                  cannot be undone.
                </p>
              </div>
            </div>

            <div className="flex items-center justify-end gap-2 pt-2 border-t border-[var(--vf-border-subtle)]">
              <button
                type="button"
                onClick={() => setDeleteTarget(null)}
                className="rounded-md border border-[var(--vf-border)] bg-[var(--vf-surface-elevated)] px-3.5 py-2 text-xs font-semibold text-[var(--vf-text)] hover:border-[var(--vf-text-subtle)] cursor-pointer"
              >
                Cancel
              </button>
              <button
                type="button"
                onClick={() => void handleConfirmDelete()}
                className="rounded-md bg-rose-600 hover:bg-rose-500 px-3.5 py-2 text-xs font-semibold text-white cursor-pointer"
              >
                Delete Permanently
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
