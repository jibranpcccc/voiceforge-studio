import {
  AlertTriangle,
  CheckCircle2,
  Loader2,
  Pause,
  Play,
  RefreshCw,
  Square,
} from 'lucide-react';
import type { GenerationQueueState } from '../../types';
import { formatDurationCompact } from './studioHelpers';

export interface QueueProgressBarProps {
  queueState: GenerationQueueState;
  activeChunkIndex?: number | null;
  onPause: () => void;
  onResume: () => void;
  onCancel: () => void;
  onRetryFailed: () => void;
  hasPendingWork?: boolean;
}

export function QueueProgressBar({
  queueState,
  activeChunkIndex,
  onPause,
  onResume,
  onCancel,
  onRetryFailed,
  hasPendingWork = false,
}: QueueProgressBarProps) {
  const {
    isRunning,
    isPaused,
    totalChunks,
    completedChunks,
    failedChunks,
    estimatedRemainingSec,
  } = queueState;

  if (totalChunks === 0 && !isRunning) {
    return null;
  }

  const pct = totalChunks > 0 ? Math.round((completedChunks / totalChunks) * 100) : 0;
  const allDone = totalChunks > 0 && completedChunks === totalChunks && failedChunks === 0;

  return (
    <div className="rounded-xl border border-slate-200 dark:border-slate-800 bg-white dark:bg-[#121622] p-4 space-y-3">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <div className="flex items-center gap-2">
          {isRunning && !isPaused ? (
            <Loader2 className="w-4 h-4 text-[#7C5CFF] animate-spin" />
          ) : allDone ? (
            <CheckCircle2 className="w-4 h-4 text-emerald-500" />
          ) : failedChunks > 0 ? (
            <AlertTriangle className="w-4 h-4 text-amber-500" />
          ) : (
            <Pause className="w-4 h-4 text-slate-400" />
          )}
          <span className="text-sm font-semibold text-slate-900 dark:text-slate-100">
            {isRunning && !isPaused
              ? activeChunkIndex !== null && activeChunkIndex !== undefined
                ? `Synthesizing paragraph ${activeChunkIndex + 1} of ${totalChunks}`
                : 'Synthesizing narration...'
              : isRunning && isPaused
                ? 'Pausing after active chunk...'
                : allDone
                  ? 'All paragraphs synthesized'
                  : isPaused
                    ? 'Generation paused'
                    : 'Generation queue'}
          </span>
        </div>

        <div className="flex items-center gap-3 text-xs text-slate-600 dark:text-slate-400">
          <span>
            <strong className="text-slate-900 dark:text-slate-100">{completedChunks}</strong> / {totalChunks} chunks ({pct}%)
          </span>
          {failedChunks > 0 && (
            <span className="text-rose-500 font-medium">{failedChunks} failed</span>
          )}
          {isRunning && (
            <span>
              ETA:{' '}
              <strong className="text-slate-900 dark:text-slate-100">
                {estimatedRemainingSec === null
                  ? 'Calculating...'
                  : formatDurationCompact(estimatedRemainingSec)}
              </strong>
            </span>
          )}
        </div>
      </div>

      {/* Progress Track */}
      <div className="w-full h-2.5 rounded-full bg-slate-200 dark:bg-slate-800 overflow-hidden">
        <div
          className={`h-full transition-all duration-300 ${
            failedChunks > 0 && !isRunning
              ? 'bg-amber-500'
              : allDone
                ? 'bg-emerald-500'
                : 'bg-[#7C5CFF]'
          }`}
          style={{ width: `${pct}%` }}
        />
      </div>

      {/* Controls */}
      <div className="flex flex-wrap items-center gap-2">
        {isRunning && !isPaused && (
          <button
            type="button"
            onClick={onPause}
            className="inline-flex items-center gap-1.5 px-3 py-1.5 rounded-lg text-xs font-medium border border-slate-200 dark:border-slate-700 text-slate-700 dark:text-slate-200 hover:bg-slate-100 dark:hover:bg-slate-800 transition"
          >
            <Pause className="w-3.5 h-3.5" />
            Pause
          </button>
        )}

        {!isRunning && hasPendingWork && (
          <button
            type="button"
            onClick={onResume}
            className="inline-flex items-center gap-1.5 px-3 py-1.5 rounded-lg text-xs font-medium bg-[#7C5CFF] text-white hover:bg-[#6A48F5] transition"
          >
            <Play className="w-3.5 h-3.5" />
            Resume Queue
          </button>
        )}

        {isRunning && (
          <button
            type="button"
            onClick={onCancel}
            className="inline-flex items-center gap-1.5 px-3 py-1.5 rounded-lg text-xs font-medium border border-rose-500/30 text-rose-600 dark:text-rose-400 hover:bg-rose-500/10 transition"
          >
            <Square className="w-3.5 h-3.5" />
            Cancel
          </button>
        )}

        {!isRunning && failedChunks > 0 && (
          <button
            type="button"
            onClick={onRetryFailed}
            className="inline-flex items-center gap-1.5 px-3 py-1.5 rounded-lg text-xs font-medium border border-amber-500/30 text-amber-600 dark:text-amber-300 hover:bg-amber-500/10 transition"
          >
            <RefreshCw className="w-3.5 h-3.5" />
            Retry Failed ({failedChunks})
          </button>
        )}
      </div>
    </div>
  );
}
