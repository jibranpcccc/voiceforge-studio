import { useState } from 'react';
import {
  Cpu,
  Globe,
  Moon,
  ShieldAlert,
  ShieldCheck,
  Sun,
  Trash2,
} from 'lucide-react';
import { useAppStore } from '../stores/appStore';
import { useModelStore } from '../stores/modelStore';
import { useProjectStore } from '../stores/projectStore';
import { useStudioStore } from '../stores/studioStore';
import { useVoiceStore } from '../stores/voiceStore';
import type { ExecutionMode, ExportFormat, ExportSampleRate } from '../types';
import { Modal, toast } from '../components/common';

const EXECUTION_MODE_OPTIONS: Array<{
  mode: ExecutionMode;
  title: string;
  description: string;
}> = [
  {
    mode: 'quality',
    title: 'Quality (WebGPU Preferred)',
    description:
      'Uses WebGPU acceleration (with shader-f16 where supported) for highest-speed Chatterbox synthesis and balanced Pocket TTS.',
  },
  {
    mode: 'balanced',
    title: 'Balanced (Adaptive)',
    description:
      'Uses WebGPU when available or falls back gracefully to WASM SIMD.',
  },
  {
    mode: 'cpu',
    title: 'CPU Only (WASM)',
    description:
      'Forces WebAssembly CPU execution across engines (ideal for devices without WebGPU or low GPU VRAM).',
  },
];

export function SettingsPage() {
  const theme = useAppStore((s) => s.theme);
  const setTheme = useAppStore((s) => s.setTheme);
  const executionMode = useAppStore((s) => s.executionMode);
  const setExecutionMode = useAppStore((s) => s.setExecutionMode);
  const customModelBaseUrl = useAppStore((s) => s.customModelBaseUrl);
  const setCustomModelBaseUrl = useAppStore((s) => s.setCustomModelBaseUrl);
  const defaultExportFormat = useAppStore((s) => s.defaultExportFormat);
  const setDefaultExportFormat = useAppStore((s) => s.setDefaultExportFormat);
  const defaultExportSampleRate = useAppStore((s) => s.defaultExportSampleRate);
  const setDefaultExportSampleRate = useAppStore((s) => s.setDefaultExportSampleRate);
  const hardwareCapabilities = useAppStore((s) => s.hardwareCapabilities);
  const parallelWorkers = useAppStore((s) => s.parallelWorkers);
  const setParallelWorkers = useAppStore((s) => s.setParallelWorkers);
  const wipeAllData = useAppStore((s) => s.wipeAllData);
  const isWipingData = useAppStore((s) => s.isWipingData);

  const [baseUrlDraft, setBaseUrlDraft] = useState(customModelBaseUrl);
  const [wipeModalOpen, setWipeModalOpen] = useState(false);

  const handleSaveBaseUrl = (nextUrl: string) => {
    setCustomModelBaseUrl(nextUrl);
    setBaseUrlDraft(nextUrl.trim());
    toast.success(
      'Model source updated',
      nextUrl.trim()
        ? `Downloads will resolve relative to ${nextUrl.trim()}`
        : 'Using pinned Hugging Face URLs.'
    );
  };

  const handleConfirmWipe = async () => {
    try {
      await wipeAllData();
      useVoiceStore.getState().clearInMemoryVoices();
      useProjectStore.getState().clearInMemoryProjects();
      useModelStore.getState().resetModelStates();
      useStudioStore.getState().clearDraft();
      setBaseUrlDraft('');
      setWipeModalOpen(false);
      toast.success('Local data deleted', 'IndexedDB, cached weights, and preferences were wiped.');
    } catch (err) {
      toast.error('Reset failed', err instanceof Error ? err.message : String(err));
    }
  };

  return (
    <div className="max-w-4xl mx-auto space-y-5 pb-10">
      {/* Execution Mode */}
      <section className="rounded-lg border border-[var(--vf-border)] bg-[var(--vf-surface)] p-5 space-y-4">
        <div className="flex flex-wrap items-center justify-between gap-2 pb-2.5 border-b border-[var(--vf-border-subtle)]">
          <div className="flex items-center gap-2">
            <Cpu className="h-4 w-4 text-[var(--vf-accent)]" />
            <h2 className="text-sm font-semibold text-[var(--vf-text)]">Execution Mode</h2>
          </div>
          {hardwareCapabilities && (
            <span className="text-xs text-[var(--vf-text-muted)]">
              Hardware recommendation:{' '}
              <strong className="font-mono uppercase text-[var(--vf-text)]">
                {hardwareCapabilities.recommendedExecutionMode}
              </strong>
            </span>
          )}
        </div>

        <div className="grid grid-cols-1 md:grid-cols-3 gap-3">
          {EXECUTION_MODE_OPTIONS.map((opt) => {
            const active = executionMode === opt.mode;
            return (
              <button
                key={opt.mode}
                type="button"
                onClick={() => {
                  setExecutionMode(opt.mode);
                  toast.info('Execution mode updated', opt.title);
                }}
                className={`text-left rounded-md border p-3.5 transition-colors cursor-pointer ${
                  active
                    ? 'border-[var(--vf-accent)] bg-[var(--vf-accent-soft)]'
                    : 'border-[var(--vf-border-subtle)] bg-[var(--vf-bg)] hover:border-[var(--vf-accent)]/40'
                }`}
              >
                <div className="text-xs font-semibold text-[var(--vf-text)]">{opt.title}</div>
                <p className="text-[11px] text-[var(--vf-text-muted)] mt-1 leading-relaxed">
                  {opt.description}
                </p>
              </button>
            );
          })}
        </div>

        <div className="border-t border-[var(--vf-border-subtle)] pt-4 flex flex-col sm:flex-row sm:items-center justify-between gap-3">
          <div>
            <label htmlFor="parallel-workers-select" className="block text-xs font-semibold text-[var(--vf-text)]">
              Parallel Workers (Long-Form Pocket TTS Speed)
            </label>
            <p className="text-[11px] text-[var(--vf-text-muted)] mt-0.5">
              Runs multiple Web Workers in parallel across paragraphs on multi-core CPUs (~250–350 MB extra RAM per worker).
            </p>
          </div>
          <select
            id="parallel-workers-select"
            value={parallelWorkers}
            onChange={(e) => setParallelWorkers(Number(e.target.value))}
            className="rounded-md border border-[var(--vf-border)] bg-[var(--vf-bg)] px-3 py-2 text-xs font-mono text-[var(--vf-text)] focus:outline-none focus:border-[var(--vf-accent)] shrink-0"
          >
            <option value={0}>Auto (Recommended)</option>
            <option value={1}>1 Worker (Lowest RAM)</option>
            <option value={2}>2 Workers</option>
            <option value={3}>3 Workers</option>
            <option value={4}>4 Workers (Max Throughput)</option>
          </select>
        </div>
      </section>

      {/* Appearance & Default Export Settings */}
      <section className="rounded-lg border border-[var(--vf-border)] bg-[var(--vf-surface)] p-5 space-y-5">
        <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-3">
          <div>
            <h2 className="text-sm font-semibold text-[var(--vf-text)]">Appearance Theme</h2>
            <p className="text-xs text-[var(--vf-text-muted)]">
              Switch between Dark Console and Light Console workspace themes.
            </p>
          </div>
          <div className="inline-flex rounded-md border border-[var(--vf-border)] bg-[var(--vf-bg)] p-0.5 self-start">
            <button
              type="button"
              onClick={() => setTheme('dark')}
              className={`inline-flex items-center gap-1.5 rounded-sm px-3 py-1.5 text-xs font-medium cursor-pointer transition-colors ${
                theme === 'dark'
                  ? 'bg-[var(--vf-accent)] text-white'
                  : 'text-[var(--vf-text-muted)] hover:text-[var(--vf-text)]'
              }`}
            >
              <Moon className="h-3.5 w-3.5" />
              <span>Dark</span>
            </button>
            <button
              type="button"
              onClick={() => setTheme('light')}
              className={`inline-flex items-center gap-1.5 rounded-sm px-3 py-1.5 text-xs font-medium cursor-pointer transition-colors ${
                theme === 'light'
                  ? 'bg-[var(--vf-accent)] text-white'
                  : 'text-[var(--vf-text-muted)] hover:text-[var(--vf-text)]'
              }`}
            >
              <Sun className="h-3.5 w-3.5" />
              <span>Light</span>
            </button>
          </div>
        </div>

        <div className="border-t border-[var(--vf-border-subtle)] pt-4 grid grid-cols-1 sm:grid-cols-2 gap-4">
          <div className="space-y-1.5">
            <label
              htmlFor="default-export-format"
              className="block text-[11px] font-mono uppercase tracking-wider font-medium text-[var(--vf-text-muted)]"
            >
              Default Export Format
            </label>
            <select
              id="default-export-format"
              value={defaultExportFormat}
              onChange={(e) => setDefaultExportFormat(e.target.value as ExportFormat)}
              className="w-full rounded-md border border-[var(--vf-border)] bg-[var(--vf-bg)] px-3 py-2 text-xs text-[var(--vf-text)] focus:outline-none focus:border-[var(--vf-accent)]"
            >
              <option value="wav16">WAV 16-bit PCM (Lossless)</option>
              <option value="wav24">WAV 24-bit PCM (Master Lossless)</option>
              <option value="mp3_128">MP3 128 kbps</option>
              <option value="mp3_192">MP3 192 kbps</option>
              <option value="mp3_256">MP3 256 kbps</option>
              <option value="mp3_320">MP3 320 kbps</option>
            </select>
          </div>

          <div className="space-y-1.5">
            <label
              htmlFor="default-export-sr"
              className="block text-[11px] font-mono uppercase tracking-wider font-medium text-[var(--vf-text-muted)]"
            >
              Default Export Sample Rate
            </label>
            <select
              id="default-export-sr"
              value={String(defaultExportSampleRate)}
              onChange={(e) => {
                const raw = e.target.value;
                const val: ExportSampleRate =
                  raw === '44100' ? 44100 : raw === '48000' ? 48000 : 'native';
                setDefaultExportSampleRate(val);
              }}
              className="w-full rounded-md border border-[var(--vf-border)] bg-[var(--vf-bg)] px-3 py-2 text-xs text-[var(--vf-text)] focus:outline-none focus:border-[var(--vf-accent)]"
            >
              <option value="native">Native Engine Rate (24,000 Hz)</option>
              <option value="44100">44,100 Hz (Resampled)</option>
              <option value="48000">48,000 Hz (Resampled)</option>
            </select>
            <p className="text-[11px] text-[var(--vf-text-muted)]">
              Resampling to 44.1 kHz or 48 kHz improves DAW/video compatibility but does not add audio detail above the model&apos;s native 24 kHz output.
            </p>
          </div>
        </div>
      </section>

      {/* Self-Hosted Model Mirror URL */}
      <section className="rounded-lg border border-[var(--vf-border)] bg-[var(--vf-surface)] p-5 space-y-3">
        <div className="flex items-center gap-2 pb-2 border-b border-[var(--vf-border-subtle)]">
          <Globe className="h-4 w-4 text-[var(--vf-accent)]" />
          <h2 className="text-sm font-semibold text-[var(--vf-text)]">Self-Hosted Model Base URL</h2>
        </div>
        <p className="text-xs text-[var(--vf-text-muted)]">
          Leave empty to download directly from commit-pinned Hugging Face repositories (GitHub Pages mode). For self-hosted cPanel or static mirrors, enter a base path such as{' '}
          <code className="font-mono text-[var(--vf-text)]">./models/</code> or{' '}
          <code className="font-mono text-[var(--vf-text)]">./models/{'{engineId}'}/</code>.
        </p>

        <div className="flex flex-col sm:flex-row gap-2">
          <input
            type="text"
            value={baseUrlDraft}
            onChange={(e) => setBaseUrlDraft(e.target.value)}
            placeholder="Empty = Pinned Hugging Face URLs (e.g. ./models/{engineId}/)"
            aria-label="Self-hosted model base URL"
            className="flex-1 rounded-md border border-[var(--vf-border)] bg-[var(--vf-bg)] px-3 py-2 text-xs font-mono text-[var(--vf-text)] placeholder:text-[var(--vf-text-subtle)] focus:outline-none focus:border-[var(--vf-accent)]"
          />
          <button
            type="button"
            onClick={() => handleSaveBaseUrl(baseUrlDraft)}
            className="rounded-md bg-[var(--vf-accent)] hover:bg-[var(--vf-accent-hover)] text-white px-4 py-2 text-xs font-semibold cursor-pointer shrink-0 transition-colors"
          >
            Save URL
          </button>
        </div>

        <div className="flex flex-wrap gap-2 text-xs">
          <button
            type="button"
            onClick={() => handleSaveBaseUrl('')}
            className="rounded-md border border-[var(--vf-border)] bg-[var(--vf-bg)] px-2.5 py-1 text-[var(--vf-text-muted)] hover:text-[var(--vf-text)] hover:border-[var(--vf-accent)]/50 cursor-pointer transition-colors"
          >
            Use Pinned Hugging Face
          </button>
          <button
            type="button"
            onClick={() => handleSaveBaseUrl('./models/{engineId}/')}
            className="rounded-md border border-[var(--vf-border)] bg-[var(--vf-bg)] px-2.5 py-1 font-mono text-[var(--vf-text-muted)] hover:text-[var(--vf-text)] hover:border-[var(--vf-accent)]/50 cursor-pointer transition-colors"
          >
            Use Self-Hosted ./models/{'{engineId}'}/
          </button>
          <button
            type="button"
            onClick={() => handleSaveBaseUrl('./models/')}
            className="rounded-md border border-[var(--vf-border)] bg-[var(--vf-bg)] px-2.5 py-1 font-mono text-[var(--vf-text-muted)] hover:text-[var(--vf-text)] hover:border-[var(--vf-accent)]/50 cursor-pointer transition-colors"
          >
            Use ./models/
          </button>
        </div>
      </section>

      {/* Privacy, Consent & License Disclosures */}
      <section className="rounded-lg border border-[var(--vf-border)] bg-[var(--vf-surface)] p-5 space-y-3 text-xs">
        <div className="flex items-center gap-2 pb-2 border-b border-[var(--vf-border-subtle)]">
          <ShieldCheck className="h-4 w-4 text-[var(--vf-success)]" />
          <h2 className="text-sm font-semibold text-[var(--vf-text)]">
            Privacy, Authorized-Use &amp; License Disclosures
          </h2>
        </div>

        <div className="rounded-md border border-[var(--vf-success)]/30 bg-[var(--vf-success)]/5 p-3.5 space-y-1.5 text-[var(--vf-text-muted)]">
          <p className="font-medium text-[var(--vf-text)]">
            100% Client-Side Local Processing
          </p>
          <p>
            Voice recordings, speaker conditioning embeddings, scripts, projects, and exported audio never leave your browser. VoiceForge Studio includes zero analytics, zero telemetry, and zero server-side inference calls.
          </p>
        </div>

        <div className="rounded-md border border-[var(--vf-warning)]/35 bg-[var(--vf-warning)]/5 p-3.5 space-y-1.5 text-[var(--vf-text-muted)]">
          <p className="font-medium text-[var(--vf-warning)] flex items-center gap-1.5">
            <ShieldAlert className="h-4 w-4 shrink-0" />
            <span>Self-Attested Authorization Notice</span>
          </p>
          <p>
            Because VoiceForge Studio runs entirely offline without user accounts or server verification, the authorized-use confirmation checkbox during voice cloning is{' '}
            <strong className="text-[var(--vf-text)]">
              client-self-attested only and is NOT independently verified consent
            </strong>
            . You are solely responsible for obtaining legal rights and explicit permission before cloning any voice and for complying with model prohibited-use restrictions.
          </p>
        </div>

        <div className="text-[11px] text-[var(--vf-text-muted)] space-y-1 pt-1">
          <p>
            <strong className="text-[var(--vf-text)]">Licenses:</strong> Application source (MIT) · Pocket TTS weights (CC-BY-4.0 + Kyutai Prohibited Use) · Chatterbox ONNX (MIT) · MP3 encoder <code className="font-mono">@breezystack/lamejs</code> (LGPL-3.0).
          </p>
        </div>
      </section>

      {/* Danger Zone: Delete All Local Data */}
      <section className="rounded-lg border border-[var(--vf-danger)]/35 bg-[var(--vf-danger)]/5 p-5 flex flex-col sm:flex-row sm:items-center justify-between gap-4">
        <div>
          <h2 className="text-sm font-semibold text-[var(--vf-danger)]">Delete All Local Data</h2>
          <p className="text-xs text-[var(--vf-text-muted)] mt-0.5">
            Permanently deletes all voice profiles, projects, synthesized audio chunks, pronunciation rules, lab runs, cached AI model weights, and local preferences.
          </p>
        </div>
        <button
          type="button"
          onClick={() => setWipeModalOpen(true)}
          className="inline-flex items-center gap-2 rounded-md bg-rose-600 hover:bg-rose-500 text-white px-4 py-2 text-xs font-semibold cursor-pointer shrink-0 transition-colors"
        >
          <Trash2 className="h-3.5 w-3.5" />
          <span>Delete All Local Data</span>
        </button>
      </section>

      <Modal
        open={wipeModalOpen}
        onClose={() => !isWipingData && setWipeModalOpen(false)}
        title="Delete All Local Data?"
        description="This action cannot be undone."
        footer={
          <>
            <button
              type="button"
              disabled={isWipingData}
              onClick={() => setWipeModalOpen(false)}
              className="rounded-md border border-[var(--vf-border)] bg-[var(--vf-surface-elevated)] px-4 py-2 text-xs font-medium text-[var(--vf-text)] cursor-pointer"
            >
              Cancel
            </button>
            <button
              type="button"
              disabled={isWipingData}
              onClick={() => void handleConfirmWipe()}
              className="rounded-md bg-rose-600 hover:bg-rose-500 text-white px-4 py-2 text-xs font-semibold cursor-pointer disabled:opacity-50"
            >
              {isWipingData ? 'Deleting...' : 'Yes, Delete Everything'}
            </button>
          </>
        }
      >
        <p className="text-xs text-[var(--vf-text-muted)] leading-relaxed">
          All saved voices, long-form narration projects, cached audio chunks, pronunciation dictionaries, Audio Lab runs, and downloaded ONNX model weights stored in IndexedDB, Cache Storage, OPFS, and localStorage will be permanently erased from this browser.
        </p>
      </Modal>
    </div>
  );
}
