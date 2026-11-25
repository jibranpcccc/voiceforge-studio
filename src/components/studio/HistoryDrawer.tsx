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
      <div className="w-full max-w-md h-full bg-white dark:bg-[#121622] border-l border-slate-200 dark:border-slate-800 flex flex-col shadow-2xl">
        <div className="flex items-center justify-between px-5 py-4 border-b border-slate-200 dark:border-slate-800">
          <div className="flex items-center gap-2">
            <History className="w-4 h-4 text-[#7C5CFF]" />
            <h2 className="text-sm font-semibold text-slate-900 dark:text-slate-100">
              Generation History ({entries.length})
            </h2>
          </div>
          <button
            type="button"
            onClick={onClose}
            className="p-1.5 rounded-lg text-slate-400 hover:text-slate-200 hover:bg-slate-800 transition"
          >
            <X className="w-4 h-4" />
          </button>
        </div>

        <div className="flex-1 overflow-y-auto p-4 space-y-3">
          {entries.length === 0 ? (
            <div className="rounded-xl border border-dashed border-slate-300 dark:border-slate-700 p-8 text-center text-xs text-slate-500 dark:text-slate-400">
              No generation history recorded yet. Synthesize a narration to see quick replays here.
            </div>
          ) : (
            entries.map((entry) => (
              <div
                key={entry.id}
                className="rounded-xl border border-slate-200 dark:border-slate-800 bg-slate-50 dark:bg-[#0B0D12]/60 p-3.5 space-y-2"
              >
                <div className="flex items-start justify-between gap-2">
                  <div className="min-w-0">
                    <div className="text-xs font-semibold text-slate-900 dark:text-slate-100 truncate">
                      {entry.voiceName} · {entry.engineId}
                    </div>
                    <div className="text-[11px] text-slate-500 dark:text-slate-400">
                      {new Date(entry.createdAt).toLocaleString()}
                    </div>
                  </div>
                  <button
                    type="button"
                    onClick={() => onDelete(entry.id)}
                    className="p-1 rounded text-slate-400 hover:text-rose-400 hover:bg-rose-500/10 transition"
                    title="Delete history entry"
                  >
                    <Trash2 className="w-3.5 h-3.5" />
                  </button>
                </div>

                <p className="text-xs text-slate-700 dark:text-slate-300 line-clamp-2">
                  {entry.text}
                </p>

                <div className="flex items-center justify-between gap-2 pt-1">
                  <div className="text-[11px] font-mono text-slate-500 dark:text-slate-400">
                    {formatDurationCompact(entry.durationSec)} · RTF{' '}
                    {entry.realTimeFactor.toFixed(2)}x
                  </div>
                  <button
                    type="button"
                    disabled={!entry.audioBytes}
                    onClick={() => onReplay(entry)}
                    className="inline-flex items-center gap-1 px-2.5 py-1 rounded-lg text-xs font-medium bg-[#7C5CFF]/15 text-[#7C5CFF] hover:bg-[#7C5CFF]/25 disabled:opacity-40 transition"
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
