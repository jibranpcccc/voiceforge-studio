import {
  Activity,
  AlertTriangle,
  CheckCircle2,
  Info,
  Lightbulb,
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
      badgeClass: 'bg-emerald-500/15 text-emerald-600 dark:text-emerald-300 border-emerald-500/30',
      barClass: 'bg-emerald-500',
    };
  }
  if (score >= 55) {
    return {
      label: 'Fair',
      badgeClass: 'bg-amber-500/15 text-amber-600 dark:text-amber-300 border-amber-500/30',
      barClass: 'bg-amber-500',
    };
  }
  return {
    label: 'Needs Attention',
    badgeClass: 'bg-rose-500/15 text-rose-600 dark:text-rose-300 border-rose-500/30',
    barClass: 'bg-rose-500',
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
      <div className="rounded-xl border border-slate-200 dark:border-slate-800 bg-white dark:bg-[#121622] p-5 text-center text-xs text-slate-500 dark:text-slate-400">
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
    <div className="rounded-xl border border-slate-200 dark:border-slate-800 bg-white dark:bg-[#121622] p-4 space-y-4">
      {/* Header + Composite Score */}
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div className="flex items-center gap-2">
          <Activity className="h-4 w-4 text-[#7C5CFF]" />
          <h3 className="text-sm font-semibold text-slate-900 dark:text-slate-100">
            Reference Quality Report
          </h3>
          {modeLabel && (
            <span className="rounded-md bg-slate-100 dark:bg-slate-800 px-2 py-0.5 text-[11px] font-medium text-slate-600 dark:text-slate-300">
              Inspecting: {modeLabel}
            </span>
          )}
        </div>

        <div className="flex items-center gap-2">
          {delta !== null && delta !== 0 && (
            <span
              className={`text-[11px] font-mono font-semibold px-2 py-0.5 rounded-md ${
                delta > 0
                  ? 'bg-emerald-500/15 text-emerald-500'
                  : 'bg-amber-500/15 text-amber-500'
              }`}
            >
              {delta > 0 ? `+${delta}` : delta} vs Original
            </span>
          )}
          <span
            className={`inline-flex items-center gap-1.5 rounded-full border px-2.5 py-0.5 text-xs font-semibold ${scoreStyle.badgeClass}`}
          >
            {analysis.overallScore}/100 · {scoreStyle.label}
          </span>
        </div>
      </div>

      {/* Score Progress Bar */}
      <div className="space-y-1">
        <div className="h-1.5 w-full rounded-full bg-slate-200 dark:bg-slate-800 overflow-hidden">
          <div
            className={`h-full transition-all duration-300 ${scoreStyle.barClass}`}
            style={{ width: `${analysis.overallScore}%` }}
          />
        </div>
        {engineLabel && (
          <p className="text-[11px] text-slate-500 dark:text-slate-400">
            Recommended reference window for <strong className="text-slate-700 dark:text-slate-200">{engineLabel}</strong>:{' '}
            {minRecommendedSec}–{maxRecommendedSec}s continuous single-speaker speech.
          </p>
        )}
      </div>

      {/* Core Metrics Grid */}
      <div className="grid grid-cols-2 sm:grid-cols-3 lg:grid-cols-4 gap-2.5">
        <div className="rounded-lg border border-slate-200/80 dark:border-slate-800 bg-slate-50/70 dark:bg-[#0B0D12]/60 p-2.5">
          <div className="text-[11px] text-slate-500 dark:text-slate-400">Duration</div>
          <div className="text-sm font-mono font-semibold text-slate-900 dark:text-slate-100">
            {analysis.durationSec.toFixed(2)}s
          </div>
          <div className="text-[10px] text-slate-500">
            Active speech: {analysis.silence.activeSpeechDurationSec.toFixed(2)}s
          </div>
        </div>

        <div className="rounded-lg border border-slate-200/80 dark:border-slate-800 bg-slate-50/70 dark:bg-[#0B0D12]/60 p-2.5">
          <div className="text-[11px] text-slate-500 dark:text-slate-400">Format</div>
          <div className="text-sm font-mono font-semibold text-slate-900 dark:text-slate-100">
            {(analysis.sampleRate / 1000).toFixed(1)} kHz · {analysis.channels}ch
          </div>
          <div className="text-[10px] text-slate-500">
            {analysis.sampleRate} Hz PCM
          </div>
        </div>

        <div className="rounded-lg border border-slate-200/80 dark:border-slate-800 bg-slate-50/70 dark:bg-[#0B0D12]/60 p-2.5">
          <div className="text-[11px] text-slate-500 dark:text-slate-400">RMS / Peak</div>
          <div className="text-sm font-mono font-semibold text-slate-900 dark:text-slate-100">
            {analysis.rmsDb.toFixed(1)} / {analysis.peakDb.toFixed(1)} dB
          </div>
          <div className="text-[10px] text-slate-500">dBFS integrated &amp; peak</div>
        </div>

        <div className="rounded-lg border border-slate-200/80 dark:border-slate-800 bg-slate-50/70 dark:bg-[#0B0D12]/60 p-2.5">
          <div className="text-[11px] text-slate-500 dark:text-slate-400">Noise Floor &amp; SNR</div>
          <div className="text-sm font-mono font-semibold text-slate-900 dark:text-slate-100">
            {analysis.estimatedSnrDb.toFixed(1)} dB SNR
          </div>
          <div className="text-[10px] text-slate-500">
            Floor: {analysis.noiseFloorDb.toFixed(1)} dBFS
          </div>
        </div>

        <div className="rounded-lg border border-slate-200/80 dark:border-slate-800 bg-slate-50/70 dark:bg-[#0B0D12]/60 p-2.5">
          <div className="text-[11px] text-slate-500 dark:text-slate-400">Clipping</div>
          <div
            className={`text-sm font-mono font-semibold ${
              analysis.clipping.hasSevereClipping
                ? 'text-rose-500'
                : analysis.clipping.clippedSampleCount > 0
                  ? 'text-amber-500'
                  : 'text-emerald-500'
            }`}
          >
            {analysis.clipping.clippedSampleCount} ({analysis.clipping.clippedPercentage.toFixed(2)}%)
          </div>
          <div className="text-[10px] text-slate-500">
            {analysis.clipping.hasSevereClipping
              ? 'Severe clipping'
              : analysis.clipping.clippedSampleCount > 0
                ? 'Minor clipping'
                : 'Zero clipped samples'}
          </div>
        </div>

        <div className="rounded-lg border border-slate-200/80 dark:border-slate-800 bg-slate-50/70 dark:bg-[#0B0D12]/60 p-2.5">
          <div className="text-[11px] text-slate-500 dark:text-slate-400">Silence Profile</div>
          <div className="text-sm font-mono font-semibold text-slate-900 dark:text-slate-100">
            {Math.round(analysis.silence.silenceRatio * 100)}% silent
          </div>
          <div className="text-[10px] text-slate-500">
            Lead {analysis.silence.leadingSilenceSec.toFixed(2)}s · Tail{' '}
            {analysis.silence.trailingSilenceSec.toFixed(2)}s
          </div>
        </div>

        <div className="rounded-lg border border-slate-200/80 dark:border-slate-800 bg-slate-50/70 dark:bg-[#0B0D12]/60 p-2.5">
          <div className="text-[11px] text-slate-500 dark:text-slate-400 flex items-center gap-1">
            <Waves className="h-3 w-3 text-[#7C5CFF]" />
            Reverb Heuristic
          </div>
          <div className="text-sm font-semibold capitalize text-slate-900 dark:text-slate-100">
            {analysis.reverbEstimate.level}{' '}
            <span className="font-mono text-xs text-slate-500">
              ({Math.round(analysis.reverbEstimate.score * 100)}%)
            </span>
          </div>
          <div className="text-[10px] text-slate-500">DSP heuristic (not RT60)</div>
        </div>

        <div className="rounded-lg border border-slate-200/80 dark:border-slate-800 bg-slate-50/70 dark:bg-[#0B0D12]/60 p-2.5">
          <div className="text-[11px] text-slate-500 dark:text-slate-400 flex items-center gap-1">
            <Users className="h-3 w-3 text-[#7C5CFF]" />
            Multi-Speaker Heuristic
          </div>
          <div
            className={`text-sm font-semibold ${
              analysis.multiSpeakerEstimate.suspectedMultipleSpeakers
                ? 'text-amber-500'
                : 'text-slate-900 dark:text-slate-100'
            }`}
          >
            {analysis.multiSpeakerEstimate.suspectedMultipleSpeakers
              ? 'Suspected'
              : 'Single Speaker'}{' '}
            <span className="font-mono text-xs text-slate-500">
              ({Math.round(analysis.multiSpeakerEstimate.score * 100)}%)
            </span>
          </div>
          <div className="text-[10px] text-slate-500">DSP F0 heuristic (not diarization)</div>
        </div>
      </div>

      {/* Warnings */}
      {analysis.warnings.length > 0 ? (
        <div className="rounded-lg border border-amber-500/30 bg-amber-500/10 p-3 space-y-1.5">
          <div className="flex items-center gap-1.5 text-xs font-semibold text-amber-700 dark:text-amber-300">
            <AlertTriangle className="h-3.5 w-3.5" />
            Quality Warnings ({analysis.warnings.length})
          </div>
          <ul className="list-disc pl-4 space-y-1 text-xs text-amber-800 dark:text-amber-200">
            {analysis.warnings.map((w, idx) => (
              <li key={idx}>{w}</li>
            ))}
          </ul>
        </div>
      ) : (
        <div className="rounded-lg border border-emerald-500/25 bg-emerald-500/10 p-2.5 flex items-center gap-2 text-xs text-emerald-700 dark:text-emerald-300">
          <CheckCircle2 className="h-4 w-4 shrink-0 text-emerald-500" />
          No acoustic quality warnings detected for this clip.
        </div>
      )}

      {/* Actionable Recommendations */}
      {analysis.recommendations.length > 0 && (
        <div className="rounded-lg border border-slate-200 dark:border-slate-800 bg-slate-50/70 dark:bg-[#0B0D12]/60 p-3 space-y-1.5">
          <div className="flex items-center gap-1.5 text-xs font-semibold text-slate-700 dark:text-slate-200">
            <Lightbulb className="h-3.5 w-3.5 text-[#7C5CFF]" />
            Actionable Tips
          </div>
          <ul className="space-y-1 text-xs text-slate-600 dark:text-slate-300">
            {analysis.recommendations.map((tip, idx) => (
              <li key={idx} className="flex items-start gap-1.5">
                <Info className="h-3.5 w-3.5 shrink-0 mt-0.5 text-slate-400" />
                <span>{tip}</span>
              </li>
            ))}
          </ul>
        </div>
      )}
    </div>
  );
}
