import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import {
  AlertCircle,
  ArrowRight,
  Check,
  Copy,
  Download,
  Edit3,
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
    <div className="max-w-6xl mx-auto space-y-6 pb-10">
      {/* Header */}
      <div className="flex flex-wrap items-start justify-between gap-4">
        <div className="space-y-1">
          <h1 className="text-2xl font-bold tracking-tight text-slate-900 dark:text-slate-100">
            My Voices
          </h1>
          <p className="text-sm text-slate-600 dark:text-slate-400">
            Manage locally encoded voice profiles, default narrator selection, and portable{' '}
            <code className="font-mono text-xs">.vfvoice.json</code> bundles.
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
            className="inline-flex items-center gap-1.5 rounded-lg border border-slate-300 dark:border-slate-700 bg-white dark:bg-[#121622] px-3.5 py-2 text-xs font-semibold text-slate-700 dark:text-slate-200 hover:bg-slate-100 dark:hover:bg-slate-800"
          >
            <Upload className="h-3.5 w-3.5" />
            Import .vfvoice.json
          </button>

          <button
            type="button"
            onClick={() => {
              window.location.hash = '#/clone';
            }}
            className="inline-flex items-center gap-1.5 rounded-lg bg-[#7C5CFF] hover:bg-[#6a48f5] px-4 py-2 text-xs font-semibold text-white"
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
          className={`flex items-start justify-between gap-3 rounded-xl border p-3.5 text-xs ${
            alertBanner.kind === 'error'
              ? 'border-rose-500/35 bg-rose-500/10 text-rose-700 dark:text-rose-200'
              : 'border-emerald-500/35 bg-emerald-500/10 text-emerald-700 dark:text-emerald-200'
          }`}
        >
          <div className="flex items-start gap-2">
            {alertBanner.kind === 'error' ? (
              <AlertCircle className="h-4 w-4 shrink-0 mt-0.5 text-rose-500" />
            ) : (
              <Check className="h-4 w-4 shrink-0 mt-0.5 text-emerald-500" />
            )}
            <span>{alertBanner.message}</span>
          </div>
          <button
            type="button"
            onClick={() => setAlertBanner(null)}
            aria-label="Dismiss notification"
            className="opacity-70 hover:opacity-100"
          >
            <X className="h-4 w-4" />
          </button>
        </div>
      )}

      {/* Search & Filter Toolbar */}
      <div className="flex flex-col sm:flex-row gap-3">
        <div className="relative flex-1">
          <Search className="absolute left-3 top-1/2 -translate-y-1/2 h-4 w-4 text-slate-400" />
          <input
            type="search"
            value={searchQuery}
            onChange={(e) => setSearchQuery(e.target.value)}
            placeholder="Search by voice name, tag, language, or description..."
            className="w-full rounded-lg border border-slate-300 dark:border-slate-700 bg-white dark:bg-[#121622] pl-9 pr-3 py-2 text-xs text-slate-900 dark:text-slate-100 focus:outline-none focus:ring-2 focus:ring-[#7C5CFF]"
          />
        </div>

        <div className="inline-flex rounded-lg border border-slate-200 dark:border-slate-800 bg-white dark:bg-[#121622] p-0.5 self-start">
          {[
            { id: 'all', label: 'All Engines' },
            { id: 'pocket-tts', label: 'Pocket TTS' },
            { id: 'chatterbox', label: 'Chatterbox' },
          ].map((opt) => (
            <button
              key={opt.id}
              type="button"
              onClick={() => setEngineFilter(opt.id)}
              className={`rounded-md px-3 py-1.5 text-xs font-medium transition-colors ${
                engineFilter === opt.id
                  ? 'bg-[#7C5CFF] text-white'
                  : 'text-slate-600 dark:text-slate-300 hover:text-slate-900 dark:hover:text-white'
              }`}
            >
              {opt.label}
            </button>
          ))}
        </div>
      </div>

      {/* Voice List */}
      {loading && voices.length === 0 ? (
        <div className="rounded-xl border border-slate-200 dark:border-slate-800 bg-white dark:bg-[#121622] p-10 text-center text-sm text-slate-500">
          Loading saved voice profiles from IndexedDB...
        </div>
      ) : filteredVoices.length === 0 ? (
        <div className="rounded-xl border border-dashed border-slate-300 dark:border-slate-800 bg-white/50 dark:bg-[#121622]/60 p-10 text-center space-y-3">
          <p className="text-sm font-medium text-slate-700 dark:text-slate-200">
            {voices.length === 0
              ? 'No voice profiles saved yet'
              : 'No voice profiles match your current search or filter'}
          </p>
          <p className="text-xs text-slate-500 dark:text-slate-400">
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
              className="inline-flex items-center gap-1.5 rounded-lg bg-[#7C5CFF] hover:bg-[#6a48f5] px-4 py-2 text-xs font-semibold text-white"
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
                className={`rounded-xl border bg-white dark:bg-[#121622] p-4 space-y-3.5 transition-colors ${
                  isDefault
                    ? 'border-[#7C5CFF]/60 ring-1 ring-[#7C5CFF]/25'
                    : 'border-slate-200 dark:border-slate-800'
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
                          className="flex-1 rounded-md border border-[#7C5CFF] bg-slate-50 dark:bg-[#0B0D12] px-2.5 py-1 text-sm font-semibold text-slate-900 dark:text-slate-100 focus:outline-none"
                        />
                        <button
                          type="button"
                          onClick={() => void handleCommitRename(voice.id)}
                          aria-label="Save name"
                          className="rounded-md bg-emerald-600 hover:bg-emerald-500 p-1.5 text-white"
                        >
                          <Check className="h-3.5 w-3.5" />
                        </button>
                        <button
                          type="button"
                          onClick={() => setRenamingId(null)}
                          aria-label="Cancel rename"
                          className="rounded-md border border-slate-300 dark:border-slate-700 p-1.5 text-slate-500"
                        >
                          <X className="h-3.5 w-3.5" />
                        </button>
                      </div>
                    ) : (
                      <div className="flex items-center gap-2">
                        <h2 className="truncate text-base font-semibold text-slate-900 dark:text-slate-100">
                          {voice.name}
                        </h2>
                        {isDefault && (
                          <span className="shrink-0 rounded-full bg-amber-500/15 border border-amber-500/30 px-2 py-0.5 text-[10px] font-semibold text-amber-600 dark:text-amber-300">
                            Default Narrator
                          </span>
                        )}
                      </div>
                    )}

                    {voice.description && (
                      <p className="mt-1 text-xs text-slate-600 dark:text-slate-400 line-clamp-2">
                        {voice.description}
                      </p>
                    )}
                  </div>

                  <button
                    type="button"
                    onClick={() => void setDefaultNarrator(voice.id)}
                    title={isDefault ? 'Default narrator' : 'Set as default narrator'}
                    aria-label={isDefault ? 'Default narrator' : 'Set as default narrator'}
                    className={`rounded-lg border p-2 transition-colors ${
                      isDefault
                        ? 'border-amber-500/40 bg-amber-500/15 text-amber-400'
                        : 'border-slate-200 dark:border-slate-800 text-slate-400 hover:text-amber-400 hover:border-amber-500/30'
                    }`}
                  >
                    <Star className={`h-4 w-4 ${isDefault ? 'fill-current' : ''}`} />
                  </button>
                </div>

                {/* Engine Badges, Revision, Language, Duration & Quality Score */}
                <div className="flex flex-wrap items-center gap-1.5 text-[11px]">
                  {payloads.map((payload) => (
                    <span
                      key={`${payload.engineId}::${payload.modelRevision}`}
                      title={`Pinned revision: ${payload.modelRevision}`}
                      className="inline-flex items-center gap-1 rounded-md bg-[#7C5CFF]/15 border border-[#7C5CFF]/30 px-2 py-0.5 font-medium text-[#7C5CFF]"
                    >
                      {formatEngineBadge(payload.engineId)}
                      <code className="font-mono text-[10px] opacity-80">
                        @{payload.modelRevision.slice(0, 7)}
                      </code>
                    </span>
                  ))}

                  <span className="rounded-md bg-slate-100 dark:bg-slate-800 px-2 py-0.5 font-mono uppercase text-slate-700 dark:text-slate-300">
                    {voice.language}
                  </span>

                  <span className="rounded-md bg-slate-100 dark:bg-slate-800 px-2 py-0.5 font-mono text-slate-700 dark:text-slate-300">
                    Ref {voice.referenceClip.durationSec.toFixed(1)}s
                  </span>

                  <span
                    className={`rounded-md px-2 py-0.5 font-mono font-semibold ${
                      voice.qualityAnalysis.overallScore >= 80
                        ? 'bg-emerald-500/15 text-emerald-600 dark:text-emerald-300'
                        : voice.qualityAnalysis.overallScore >= 55
                          ? 'bg-amber-500/15 text-amber-600 dark:text-amber-300'
                          : 'bg-rose-500/15 text-rose-600 dark:text-rose-300'
                    }`}
                  >
                    Quality {voice.qualityAnalysis.overallScore}/100
                  </span>

                  <span
                    title={voice.authorizedUse.attestationText}
                    className="inline-flex items-center gap-1 rounded-md bg-emerald-500/10 px-2 py-0.5 text-emerald-700 dark:text-emerald-300"
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
                        className="rounded-full bg-slate-100 dark:bg-[#0B0D12] border border-slate-200 dark:border-slate-800 px-2 py-0.5 text-[10px] text-slate-600 dark:text-slate-400"
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
                    className="inline-flex items-center gap-1.5 rounded-lg border border-slate-300 dark:border-slate-700 px-2.5 py-1.5 text-xs font-medium text-slate-700 dark:text-slate-200 hover:bg-slate-100 dark:hover:bg-slate-800"
                  >
                    <Volume2 className="h-3.5 w-3.5 text-[#7C5CFF]" />
                    {isPreviewOpen && activePreview?.label === 'Reference Audio'
                      ? 'Hide Reference Player'
                      : 'Play Reference'}
                  </button>

                  <button
                    type="button"
                    onClick={() => void handlePlayStoredAudio(voice, 'synth')}
                    className="inline-flex items-center gap-1.5 rounded-lg border border-slate-300 dark:border-slate-700 px-2.5 py-1.5 text-xs font-medium text-slate-700 dark:text-slate-200 hover:bg-slate-100 dark:hover:bg-slate-800"
                  >
                    <Volume2 className="h-3.5 w-3.5 text-emerald-500" />
                    {isPreviewOpen && activePreview?.label === 'Synthesized Preview'
                      ? 'Hide Preview Player'
                      : 'Play Synth Preview'}
                  </button>
                </div>

                {previewNotice?.voiceId === voice.id && (
                  <p className="text-[11px] text-amber-600 dark:text-amber-300">
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
                <div className="flex flex-wrap items-center justify-between gap-2 pt-2 border-t border-slate-200/80 dark:border-slate-800">
                  <div className="flex flex-wrap items-center gap-1">
                    <button
                      type="button"
                      onClick={() => handleStartRename(voice)}
                      title="Rename voice"
                      className="inline-flex items-center gap-1 rounded-md px-2 py-1 text-xs text-slate-600 dark:text-slate-300 hover:bg-slate-100 dark:hover:bg-slate-800"
                    >
                      <Edit3 className="h-3.5 w-3.5" />
                      Rename
                    </button>

                    <button
                      type="button"
                      onClick={() => void handleDuplicate(voice)}
                      title="Duplicate voice"
                      className="inline-flex items-center gap-1 rounded-md px-2 py-1 text-xs text-slate-600 dark:text-slate-300 hover:bg-slate-100 dark:hover:bg-slate-800"
                    >
                      <Copy className="h-3.5 w-3.5" />
                      Duplicate
                    </button>

                    <button
                      type="button"
                      onClick={() => void handleExport(voice)}
                      title="Export .vfvoice.json"
                      className="inline-flex items-center gap-1 rounded-md px-2 py-1 text-xs text-slate-600 dark:text-slate-300 hover:bg-slate-100 dark:hover:bg-slate-800"
                    >
                      <Download className="h-3.5 w-3.5" />
                      Export
                    </button>

                    <button
                      type="button"
                      onClick={() => setDeleteTarget(voice)}
                      title="Delete voice permanently"
                      className="inline-flex items-center gap-1 rounded-md px-2 py-1 text-xs text-rose-600 dark:text-rose-400 hover:bg-rose-500/10"
                    >
                      <Trash2 className="h-3.5 w-3.5" />
                      Delete
                    </button>
                  </div>

                  <button
                    type="button"
                    onClick={() => handleUseInStudio(voice)}
                    className="inline-flex items-center gap-1.5 rounded-lg bg-[#7C5CFF] hover:bg-[#6a48f5] px-3 py-1.5 text-xs font-semibold text-white"
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

      {/* Permanent Delete Confirmation Modal */}
      {deleteTarget && (
        <div
          role="dialog"
          aria-modal="true"
          aria-labelledby="delete-voice-title"
          className="fixed inset-0 z-50 flex items-center justify-center bg-black/70 p-4"
        >
          <div className="max-w-md w-full rounded-2xl border border-slate-200 dark:border-slate-800 bg-white dark:bg-[#121622] p-5 shadow-2xl space-y-4">
            <div className="flex items-start gap-3">
              <div className="h-9 w-9 rounded-lg bg-rose-500/15 border border-rose-500/30 flex items-center justify-center text-rose-500 shrink-0">
                <Trash2 className="h-4 w-4" />
              </div>
              <div className="space-y-1">
                <h2
                  id="delete-voice-title"
                  className="text-base font-semibold text-slate-900 dark:text-slate-100"
                >
                  Delete &ldquo;{deleteTarget.name}&rdquo;?
                </h2>
                <p className="text-xs text-slate-600 dark:text-slate-400 leading-relaxed">
                  This permanently deletes the voice profile, its encoded conditioning tensors,
                  and its locally stored reference/preview audio from IndexedDB. This action
                  cannot be undone.
                </p>
              </div>
            </div>

            <div className="flex items-center justify-end gap-2">
              <button
                type="button"
                onClick={() => setDeleteTarget(null)}
                className="rounded-lg border border-slate-300 dark:border-slate-700 px-3.5 py-2 text-xs font-semibold text-slate-700 dark:text-slate-200 hover:bg-slate-100 dark:hover:bg-slate-800"
              >
                Cancel
              </button>
              <button
                type="button"
                onClick={() => void handleConfirmDelete()}
                className="rounded-lg bg-rose-600 hover:bg-rose-500 px-3.5 py-2 text-xs font-semibold text-white"
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
