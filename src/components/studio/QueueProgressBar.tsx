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

  if (totalChunks === 0 && !isRunning && !hasPendingWork) {
    return null;
  }

  const pct = totalChunks > 0 ? Math.round((completedChunks / totalChunks) * 100) : 0;
  const allDone = totalChunks > 0 && completedChunks === totalChunks && failedChunks === 0;

  return (
    <div className="rounded-lg border border-[var(--vf-border)] bg-[var(--vf-surface)] p-4 space-y-3">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <div className="flex items-center gap-2">
          {isRunning && !isPaused ? (
            <Loader2 className="w-4 h-4 text-[var(--vf-accent)] animate-spin" />
          ) : allDone ? (
            <CheckCircle2 className="w-4 h-4 text-[var(--vf-success)]" />
          ) : failedChunks > 0 ? (
            <AlertTriangle className="w-4 h-4 text-[var(--vf-warning)]" />
          ) : (
            <Pause className="w-4 h-4 text-[var(--vf-text-subtle)]" />
          )}
          <span className="text-sm font-semibold text-[var(--vf-text)]">
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

        <div className="flex items-center gap-3 text-xs text-[var(--vf-text-muted)] tabular-nums">
          <span className="font-mono">
            <strong className="text-[var(--vf-text)]">{completedChunks}</strong> / {totalChunks}{' '}
            chunks ({pct}%)
          </span>
          {failedChunks > 0 && (
            <span className="text-[var(--vf-danger)] font-medium">{failedChunks} failed</span>
          )}
          {isRunning && (
            <span className="font-mono">
              ETA:{' '}
              <strong className="text-[var(--vf-text)]">
                {estimatedRemainingSec === null
                  ? 'Calculating...'
                  : formatDurationCompact(estimatedRemainingSec)}
              </strong>
            </span>
          )}
        </div>
      </div>

      {/* Progress Track */}
      <div className="w-full h-2 rounded-sm bg-[var(--vf-surface-muted)] overflow-hidden">
        <div
          className={`h-full transition-all duration-300 ${
            failedChunks > 0 && !isRunning
              ? 'bg-[var(--vf-warning)]'
              : allDone
                ? 'bg-[var(--vf-success)]'
                : 'bg-[var(--vf-accent)]'
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
            className="inline-flex items-center gap-1.5 px-3 py-1.5 rounded-md text-xs font-medium border border-[var(--vf-border)] bg-[var(--vf-surface-elevated)] text-[var(--vf-text)] hover:border-[var(--vf-text-subtle)] transition"
          >
            <Pause className="w-3.5 h-3.5" />
            Pause
          </button>
        )}

        {!isRunning && hasPendingWork && (
          <button
            type="button"
            onClick={onResume}
            className="inline-flex items-center gap-1.5 px-3 py-1.5 rounded-md text-xs font-medium bg-[var(--vf-accent)] text-white hover:bg-[var(--vf-accent-hover)] transition"
          >
            <Play className="w-3.5 h-3.5" />
            Resume Queue
          </button>
        )}

        {isRunning && (
          <button
            type="button"
            onClick={onCancel}
            className="inline-flex items-center gap-1.5 px-3 py-1.5 rounded-md text-xs font-medium border border-[var(--vf-danger)]/35 text-[var(--vf-danger)] hover:bg-[var(--vf-danger)]/10 transition"
          >
            <Square className="w-3.5 h-3.5" />
            Cancel
          </button>
        )}

        {!isRunning && failedChunks > 0 && (
          <button
            type="button"
            onClick={onRetryFailed}
            className="inline-flex items-center gap-1.5 px-3 py-1.5 rounded-md text-xs font-medium border border-[var(--vf-warning)]/35 text-[var(--vf-warning)] hover:bg-[var(--vf-warning)]/10 transition"
          >
            <RefreshCw className="w-3.5 h-3.5" />
            Retry Failed ({failedChunks})
          </button>
        )}
      </div>
    </div>
  );
}
