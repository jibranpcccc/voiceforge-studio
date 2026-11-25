import { History, Play, Trash2, X } from 'lucide-react';
import type { GenerationHistoryEntry } from '../../storage/db';
import { formatDurationCompact } from './studioHelpers';

export interface HistoryDrawerProps {
  open: boolean;
  onClose: () => void;
  entries: GenerationHistoryEntry[];
  onReplay: (entry: GenerationHistoryEntry) => void;
  onDelete: (id: string) => void;
}

export function HistoryDrawer({
  open,
  onClose,
  entries,
  onReplay,
  onDelete,
}: HistoryDrawerProps) {
  if (!open) return null;

  return (
    <div className="fixed inset-0 z-50 flex justify-end bg-black/60 backdrop-blur-sm">
      <div className="w-full max-w-md h-full bg-[var(--vf-surface)] border-l border-[var(--vf-border)] flex flex-col shadow-2xl">
        <div className="flex items-center justify-between px-5 py-4 border-b border-[var(--vf-border-subtle)]">
          <div className="flex items-center gap-2">
            <History className="w-4 h-4 text-[var(--vf-accent)]" />
            <h2 className="text-sm font-semibold text-[var(--vf-text)] tabular-nums">
              Generation History ({entries.length})
            </h2>
          </div>
          <button
            type="button"
            onClick={onClose}
            className="p-1.5 rounded-md text-[var(--vf-text-muted)] hover:text-[var(--vf-text)] hover:bg-[var(--vf-surface-muted)] transition"
            aria-label="Close history drawer"
          >
            <X className="w-4 h-4" />
          </button>
        </div>

        <div className="flex-1 overflow-y-auto p-4 space-y-3">
          {entries.length === 0 ? (
            <div className="rounded-lg border border-dashed border-[var(--vf-border)] p-8 text-center text-xs text-[var(--vf-text-muted)]">
              No generation history recorded yet. Synthesize a narration to see quick replays here.
            </div>
          ) : (
            entries.map((entry) => (
              <div
                key={entry.id}
                className="rounded-lg border border-[var(--vf-border)] bg-[var(--vf-bg)] p-3.5 space-y-2"
              >
                <div className="flex items-start justify-between gap-2">
                  <div className="min-w-0">
                    <div className="text-xs font-semibold text-[var(--vf-text)] truncate">
                      {entry.voiceName} · {entry.engineId}
                    </div>
                    <div className="text-[11px] text-[var(--vf-text-muted)] tabular-nums">
                      {new Date(entry.createdAt).toLocaleString()}
                    </div>
                  </div>
                  <button
                    type="button"
                    onClick={() => onDelete(entry.id)}
                    className="p-1 rounded-md text-[var(--vf-text-muted)] hover:text-[var(--vf-danger)] hover:bg-[var(--vf-danger)]/10 transition"
                    title="Delete history entry"
                  >
                    <Trash2 className="w-3.5 h-3.5" />
                  </button>
                </div>

                <p className="text-xs text-[var(--vf-text-muted)] line-clamp-2">
                  {entry.text}
                </p>

                <div className="flex items-center justify-between gap-2 pt-1">
                  <div className="text-[11px] font-mono tabular-nums text-[var(--vf-text-muted)]">
                    {formatDurationCompact(entry.durationSec)} · RTF{' '}
                    {entry.realTimeFactor.toFixed(2)}x
                  </div>
                  <button
                    type="button"
                    disabled={!entry.audioBytes}
                    onClick={() => onReplay(entry)}
                    className="inline-flex items-center gap-1 px-2.5 py-1 rounded-md text-xs font-medium bg-[var(--vf-accent)]/15 text-[var(--vf-accent)] hover:bg-[var(--vf-accent)]/25 disabled:opacity-40 transition"
                  >
                    <Play className="w-3 h-3" />
                    Load Replay
                  </button>
                </div>
              </div>
            ))
          )}
        </div>
      </div>
    </div>
  );
}
