import {
  Activity,
  AlertTriangle,
  CheckCircle2,
  Info,
  SlidersHorizontal,
  Users,
  Waves,
} from 'lucide-react';
import type { AudioQualityAnalysis } from '../../types';

export interface QualityReportPanelProps {
  analysis: AudioQualityAnalysis | null;
  engineLabel?: string;
  minRecommendedSec?: number;
  maxRecommendedSec?: number;
  modeLabel?: 'Original' | 'Processed';
  baselineScore?: number | null;
}

function getScoreBadge(score: number): {
  label: string;
  badgeClass: string;
  barClass: string;
} {
  if (score >= 80) {
    return {
      label: 'Excellent',
      badgeClass:
        'bg-[var(--vf-success)]/15 text-[var(--vf-success)] border-[var(--vf-success)]/35',
      barClass: 'bg-[var(--vf-success)]',
    };
  }
  if (score >= 55) {
    return {
      label: 'Fair',
      badgeClass:
        'bg-[var(--vf-warning)]/15 text-[var(--vf-warning)] border-[var(--vf-warning)]/35',
      barClass: 'bg-[var(--vf-warning)]',
    };
  }
  return {
    label: 'Needs Attention',
    badgeClass:
      'bg-[var(--vf-danger)]/15 text-[var(--vf-danger)] border-[var(--vf-danger)]/35',
    barClass: 'bg-[var(--vf-danger)]',
  };
}

export function QualityReportPanel({
  analysis,
  engineLabel,
  minRecommendedSec = 5,
  maxRecommendedSec = 10,
  modeLabel,
  baselineScore,
}: QualityReportPanelProps) {
  if (!analysis) {
    return (
      <div className="rounded-lg border border-[var(--vf-border)] bg-[var(--vf-surface)] p-5 text-center text-xs text-[var(--vf-text-muted)]">
        Add or record a reference clip to run acoustic quality &amp; clipping inspection.
      </div>
    );
  }

  const scoreStyle = getScoreBadge(analysis.overallScore);
  const delta =
    typeof baselineScore === 'number' && modeLabel === 'Processed'
      ? analysis.overallScore - baselineScore
      : null;

  return (
    <div className="rounded-lg border border-[var(--vf-border)] bg-[var(--vf-surface)] p-4 space-y-4">
      {/* Header + Composite Score */}
      <div className="flex flex-wrap items-center justify-between gap-3 pb-2.5 border-b border-[var(--vf-border-subtle)]">
        <div className="flex items-center gap-2">
          <Activity className="h-4 w-4 text-[var(--vf-accent)]" />
          <h3 className="text-sm font-semibold text-[var(--vf-text)]">
            Reference Quality Report
          </h3>
          {modeLabel && (
            <span className="rounded-sm border border-[var(--vf-border)] bg-[var(--vf-surface-elevated)] px-2 py-0.5 text-[10px] font-mono uppercase tracking-wider text-[var(--vf-text-muted)]">
              Inspecting: {modeLabel}
            </span>
          )}
        </div>

        <div className="flex items-center gap-2">
          {delta !== null && delta !== 0 && (
            <span
              className={`text-[11px] font-mono tabular-nums font-semibold px-2 py-0.5 rounded-sm border ${
                delta > 0
                  ? 'bg-[var(--vf-success)]/15 text-[var(--vf-success)] border-[var(--vf-success)]/30'
                  : 'bg-[var(--vf-warning)]/15 text-[var(--vf-warning)] border-[var(--vf-warning)]/30'
              }`}
            >
              {delta > 0 ? `+${delta}` : delta} vs Original
            </span>
          )}
          <span
            className={`inline-flex items-center gap-1.5 rounded-sm border px-2.5 py-0.5 text-xs font-mono tabular-nums font-semibold ${scoreStyle.badgeClass}`}
          >
            {analysis.overallScore}/100 · {scoreStyle.label}
          </span>
        </div>
      </div>

      {/* VU / Metering Quality Bar */}
      <div className="space-y-1.5">
        <div className="h-1.5 w-full rounded-sm bg-[var(--vf-bg)] border border-[var(--vf-border-subtle)] overflow-hidden">
          <div
            className={`h-full transition-all duration-300 ${scoreStyle.barClass}`}
            style={{ width: `${analysis.overallScore}%` }}
          />
        </div>
        {engineLabel && (
          <p className="text-[11px] text-[var(--vf-text-muted)]">
            Recommended reference window for{' '}
            <strong className="text-[var(--vf-text)]">{engineLabel}</strong>:{' '}
            <span className="font-mono tabular-nums">
              {minRecommendedSec}–{maxRecommendedSec}s
            </span>{' '}
            continuous single-speaker speech.
          </p>
        )}
      </div>

      {/* Recessed Metering Wells */}
      <div className="grid grid-cols-2 sm:grid-cols-4 gap-2.5">
        <div className="rounded-md border border-[var(--vf-border-subtle)] bg-[var(--vf-bg)] p-2.5">
          <div className="text-[10px] font-mono uppercase tracking-wider text-[var(--vf-text-subtle)]">
            Duration
          </div>
          <div className="mt-0.5 text-sm font-mono tabular-nums font-semibold text-[var(--vf-text)]">
            {analysis.durationSec.toFixed(2)}s
          </div>
          <div className="text-[10px] font-mono tabular-nums text-[var(--vf-text-muted)]">
            Active speech: {analysis.silence.activeSpeechDurationSec.toFixed(2)}s
          </div>
        </div>

        <div className="rounded-md border border-[var(--vf-border-subtle)] bg-[var(--vf-bg)] p-2.5">
          <div className="text-[10px] font-mono uppercase tracking-wider text-[var(--vf-text-subtle)]">
            Format
          </div>
          <div className="mt-0.5 text-sm font-mono tabular-nums font-semibold text-[var(--vf-text)]">
            {(analysis.sampleRate / 1000).toFixed(1)} kHz · {analysis.channels}ch
          </div>
          <div className="text-[10px] font-mono tabular-nums text-[var(--vf-text-muted)]">
            {analysis.sampleRate} Hz PCM
          </div>
        </div>

        <div className="rounded-md border border-[var(--vf-border-subtle)] bg-[var(--vf-bg)] p-2.5">
          <div className="text-[10px] font-mono uppercase tracking-wider text-[var(--vf-text-subtle)]">
            RMS / Peak
          </div>
          <div className="mt-0.5 text-sm font-mono tabular-nums font-semibold text-[var(--vf-text)]">
            {analysis.rmsDb.toFixed(1)} / {analysis.peakDb.toFixed(1)} dB
          </div>
          <div className="text-[10px] text-[var(--vf-text-muted)]">dBFS integrated &amp; peak</div>
        </div>

        <div className="rounded-md border border-[var(--vf-border-subtle)] bg-[var(--vf-bg)] p-2.5">
          <div className="text-[10px] font-mono uppercase tracking-wider text-[var(--vf-text-subtle)]">
            Noise Floor &amp; SNR
          </div>
          <div className="mt-0.5 text-sm font-mono tabular-nums font-semibold text-[var(--vf-text)]">
            {analysis.estimatedSnrDb.toFixed(1)} dB SNR
          </div>
          <div className="text-[10px] font-mono tabular-nums text-[var(--vf-text-muted)]">
            Floor: {analysis.noiseFloorDb.toFixed(1)} dBFS
          </div>
        </div>

        <div className="rounded-md border border-[var(--vf-border-subtle)] bg-[var(--vf-bg)] p-2.5">
          <div className="text-[10px] font-mono uppercase tracking-wider text-[var(--vf-text-subtle)]">
            Clipping
          </div>
          <div
            className={`mt-0.5 text-sm font-mono tabular-nums font-semibold ${
              analysis.clipping.hasSevereClipping
                ? 'text-[var(--vf-danger)]'
                : analysis.clipping.clippedSampleCount > 0
                  ? 'text-[var(--vf-warning)]'
                  : 'text-[var(--vf-success)]'
            }`}
          >
            {analysis.clipping.clippedSampleCount} ({analysis.clipping.clippedPercentage.toFixed(2)}%)
          </div>
          <div className="text-[10px] text-[var(--vf-text-muted)]">
            {analysis.clipping.hasSevereClipping
              ? 'Severe clipping'
              : analysis.clipping.clippedSampleCount > 0
                ? 'Minor clipping'
                : 'Zero clipped samples'}
          </div>
        </div>

        <div className="rounded-md border border-[var(--vf-border-subtle)] bg-[var(--vf-bg)] p-2.5">
          <div className="text-[10px] font-mono uppercase tracking-wider text-[var(--vf-text-subtle)]">
            Silence Profile
          </div>
          <div className="mt-0.5 text-sm font-mono tabular-nums font-semibold text-[var(--vf-text)]">
            {Math.round(analysis.silence.silenceRatio * 100)}% silent
          </div>
          <div className="text-[10px] font-mono tabular-nums text-[var(--vf-text-muted)]">
            Lead {analysis.silence.leadingSilenceSec.toFixed(2)}s · Tail{' '}
            {analysis.silence.trailingSilenceSec.toFixed(2)}s
          </div>
        </div>

        <div className="rounded-md border border-[var(--vf-border-subtle)] bg-[var(--vf-bg)] p-2.5">
          <div className="text-[10px] font-mono uppercase tracking-wider text-[var(--vf-text-subtle)] flex items-center gap-1">
            <Waves className="h-3 w-3 text-[var(--vf-accent)]" />
            Reverb Heuristic
          </div>
          <div className="mt-0.5 text-sm font-semibold capitalize text-[var(--vf-text)]">
            {analysis.reverbEstimate.level}{' '}
            <span className="font-mono tabular-nums text-xs text-[var(--vf-text-muted)]">
              ({Math.round(analysis.reverbEstimate.score * 100)}%)
            </span>
          </div>
          <div className="text-[10px] text-[var(--vf-text-muted)]">DSP heuristic (not RT60)</div>
        </div>

        <div className="rounded-md border border-[var(--vf-border-subtle)] bg-[var(--vf-bg)] p-2.5">
          <div className="text-[10px] font-mono uppercase tracking-wider text-[var(--vf-text-subtle)] flex items-center gap-1">
            <Users className="h-3 w-3 text-[var(--vf-accent)]" />
            Multi-Speaker
          </div>
          <div
            className={`mt-0.5 text-sm font-semibold ${
              analysis.multiSpeakerEstimate.suspectedMultipleSpeakers
                ? 'text-[var(--vf-warning)]'
                : 'text-[var(--vf-text)]'
            }`}
          >
            {analysis.multiSpeakerEstimate.suspectedMultipleSpeakers
              ? 'Suspected'
              : 'Single Speaker'}{' '}
            <span className="font-mono tabular-nums text-xs text-[var(--vf-text-muted)]">
              ({Math.round(analysis.multiSpeakerEstimate.score * 100)}%)
            </span>
          </div>
          <div className="text-[10px] text-[var(--vf-text-muted)]">DSP F0 heuristic (not diarization)</div>
        </div>
      </div>

      {/* Warnings */}
      {analysis.warnings.length > 0 ? (
        <div className="rounded-md border border-[var(--vf-warning)]/35 bg-[var(--vf-warning)]/10 p-3 space-y-1.5">
          <div className="flex items-center gap-1.5 text-xs font-semibold text-[var(--vf-warning)]">
            <AlertTriangle className="h-3.5 w-3.5" />
            Quality Warnings ({analysis.warnings.length})
          </div>
          <ul className="list-disc pl-4 space-y-1 text-xs text-[var(--vf-text)]">
            {analysis.warnings.map((w, idx) => (
              <li key={idx}>{w}</li>
            ))}
          </ul>
        </div>
      ) : (
        <div className="rounded-md border border-[var(--vf-success)]/30 bg-[var(--vf-success)]/10 p-2.5 flex items-center gap-2 text-xs text-[var(--vf-success)]">
          <CheckCircle2 className="h-4 w-4 shrink-0" />
          No acoustic quality warnings detected for this clip.
        </div>
      )}

      {/* Actionable Recommendations */}
      {analysis.recommendations.length > 0 && (
        <div className="rounded-md border border-[var(--vf-border-subtle)] bg-[var(--vf-bg)] p-3 space-y-1.5">
          <div className="flex items-center gap-1.5 text-xs font-semibold text-[var(--vf-text)]">
            <SlidersHorizontal className="h-3.5 w-3.5 text-[var(--vf-accent)]" />
            Signal Conditioning Tips
          </div>
          <ul className="space-y-1 text-xs text-[var(--vf-text-muted)]">
            {analysis.recommendations.map((tip, idx) => (
              <li key={idx} className="flex items-start gap-1.5">
                <Info className="h-3.5 w-3.5 shrink-0 mt-0.5 text-[var(--vf-text-subtle)]" />
                <span>{tip}</span>
              </li>
            ))}
          </ul>
        </div>
      )}
    </div>
  );
}
