import { AudioLines, RotateCcw, SlidersHorizontal } from 'lucide-react';
import {
  DEFAULT_PREPROCESSING_OPTIONS,
  type ReferencePreprocessingOptions,
} from '../../audio';

export interface PreprocessingPanelProps {
  options: ReferencePreprocessingOptions;
  onChange: (next: ReferencePreprocessingOptions) => void;
  engineMaxDurationSec?: number;
  disabled?: boolean;
}

interface ToggleRowProps {
  label: string;
  description: string;
  checked: boolean;
  disabled?: boolean;
  onToggle: (checked: boolean) => void;
}

function ToggleRow({
  label,
  description,
  checked,
  disabled,
  onToggle,
}: ToggleRowProps) {
  return (
    <label
      className={`flex items-start justify-between gap-3 rounded-md border p-2.5 cursor-pointer transition-colors ${
        checked
          ? 'border-[var(--vf-accent)]/45 bg-[var(--vf-accent-soft)]'
          : 'border-[var(--vf-border-subtle)] bg-[var(--vf-bg)] hover:border-[var(--vf-border)]'
      }`}
    >
      <div className="space-y-0.5">
        <div className="text-xs font-medium text-[var(--vf-text)]">{label}</div>
        <div className="text-[11px] text-[var(--vf-text-muted)]">{description}</div>
      </div>
      <input
        type="checkbox"
        checked={checked}
        disabled={disabled}
        onChange={(e) => onToggle(e.target.checked)}
        className="mt-0.5 h-4 w-4 rounded border-[var(--vf-border)] accent-[var(--vf-accent)]"
      />
    </label>
  );
}

export function PreprocessingPanel({
  options,
  onChange,
  engineMaxDurationSec = 10,
  disabled = false,
}: PreprocessingPanelProps) {
  const update = (partial: Partial<ReferencePreprocessingOptions>) => {
    onChange({ ...options, ...partial });
  };

  const resetDefaults = () => {
    onChange({
      ...DEFAULT_PREPROCESSING_OPTIONS,
      maxDurationSec: engineMaxDurationSec,
    });
  };

  return (
    <div className="rounded-lg border border-[var(--vf-border)] bg-[var(--vf-surface)] p-4 space-y-3.5">
      <div className="flex flex-wrap items-center justify-between gap-2 pb-2.5 border-b border-[var(--vf-border-subtle)]">
        <div className="flex items-center gap-2">
          <SlidersHorizontal className="h-4 w-4 text-[var(--vf-accent)]" />
          <h3 className="text-sm font-semibold text-[var(--vf-text)]">
            Non-Destructive Preprocessing
          </h3>
        </div>
        <div className="flex items-center gap-2">
          <span className="inline-flex items-center gap-1 rounded-sm bg-[var(--vf-accent-soft)] border border-[var(--vf-accent)]/35 px-2 py-0.5 text-[10px] font-mono uppercase tracking-wider font-medium text-[var(--vf-accent)]">
            <AudioLines className="h-3 w-3" />
            Original Preserved
          </span>
          <button
            type="button"
            onClick={resetDefaults}
            disabled={disabled}
            className="inline-flex items-center gap-1 rounded-md border border-[var(--vf-border)] bg-[var(--vf-surface-elevated)] px-2.5 py-1 text-[11px] font-medium text-[var(--vf-text-muted)] hover:text-[var(--vf-text)] disabled:opacity-50 cursor-pointer"
          >
            <RotateCcw className="h-3 w-3" />
            Reset Defaults
          </button>
        </div>
      </div>

      <div className="grid grid-cols-1 md:grid-cols-2 gap-2.5">
        <ToggleRow
          label="Remove DC Offset"
          description="Centers waveform around 0.0 to eliminate sub-audible bias."
          checked={options.removeDcOffset !== false}
          disabled={disabled}
          onToggle={(v) => update({ removeDcOffset: v })}
        />

        <ToggleRow
          label="Gentle Silence Trim"
          description="Trims dead air (< -40 dBFS) while preserving 80 ms natural padding."
          checked={options.trimSilence}
          disabled={disabled}
          onToggle={(v) => update({ trimSilence: v })}
        />

        <ToggleRow
          label="Mono Downmix (24 kHz Target)"
          description="Converts stereo/multi-channel audio to mono at engine native rate."
          checked={options.downmixToMono !== false}
          disabled={disabled}
          onToggle={(v) => update({ downmixToMono: v })}
        />

        <ToggleRow
          label="Gentle Noise Reduction"
          description="80 Hz rumble high-pass filter + soft expander gate (preserves breath)."
          checked={Boolean(options.gentleNoiseReduction)}
          disabled={disabled}
          onToggle={(v) => update({ gentleNoiseReduction: v })}
        />

        <ToggleRow
          label="Loudness Normalization"
          description="Peak-safe LUFS normalization (capped at -1.0 dBFS to prevent clipping)."
          checked={options.normalizeLoudness}
          disabled={disabled}
          onToggle={(v) => update({ normalizeLoudness: v })}
        />

        <ToggleRow
          label="Mild De-Essing"
          description="Softly attenuates harsh 5–9 kHz sibilance spikes."
          checked={options.deEssingEnabled}
          disabled={disabled}
          onToggle={(v) => update({ deEssingEnabled: v })}
        />
      </div>

      {/* Loudness Target & Duration Cap Controls */}
      <div className="grid grid-cols-1 sm:grid-cols-2 gap-3 pt-3 border-t border-[var(--vf-border-subtle)]">
        <div className="rounded-md border border-[var(--vf-border-subtle)] bg-[var(--vf-bg)] p-2.5 space-y-1.5">
          <div className="flex items-center justify-between text-xs">
            <span className="text-[var(--vf-text-muted)]">Target Loudness</span>
            <span className="font-mono tabular-nums font-semibold text-[var(--vf-text)]">
              {options.targetLufs} LUFS
            </span>
          </div>
          <input
            type="range"
            min={-24}
            max={-12}
            step={1}
            value={options.targetLufs}
            disabled={disabled || !options.normalizeLoudness}
            onChange={(e) => update({ targetLufs: Number(e.target.value) })}
            className="w-full accent-[var(--vf-accent)] disabled:opacity-40"
          />
        </div>

        <div className="rounded-md border border-[var(--vf-border-subtle)] bg-[var(--vf-bg)] p-2.5 space-y-1.5">
          <div className="flex items-center justify-between text-xs">
            <span className="text-[var(--vf-text-muted)]">Max Reference Cap</span>
            <span className="font-mono tabular-nums font-semibold text-[var(--vf-text)]">
              {options.maxDurationSec}s
            </span>
          </div>
          <input
            type="range"
            min={5}
            max={Math.max(10, engineMaxDurationSec)}
            step={1}
            value={Math.min(Math.max(10, engineMaxDurationSec), options.maxDurationSec)}
            disabled={disabled}
            onChange={(e) => update({ maxDurationSec: Number(e.target.value) })}
            className="w-full accent-[var(--vf-accent)]"
          />
        </div>
      </div>
    </div>
  );
}
