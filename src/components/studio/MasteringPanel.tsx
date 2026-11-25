import { useState } from 'react';
import { AudioLines, ChevronDown, ChevronUp, SlidersHorizontal } from 'lucide-react';
import { MASTERING_PRESETS, type MasteringExtraOptions } from '../../audio';
import type { MasteringPreset, MasteringSettings } from '../../types';

export interface MasteringPanelProps {
  settings: MasteringSettings;
  extra: Required<
    Pick<MasteringExtraOptions, 'speed' | 'reduceExcessiveSilence' | 'maxInternalSilenceMs'>
  >;
  sentencePauseMs: number;
  paragraphPauseMs: number;
  chunkCrossfadeMs: number;
  hasAudio: boolean;
  isMastering: boolean;
  onChangeSettings: (partial: Partial<MasteringSettings>) => void;
  onChangeExtra: (partial: Partial<MasteringExtraOptions>) => void;
  onChangeTiming: (partial: {
    sentencePauseMs?: number;
    paragraphPauseMs?: number;
    chunkCrossfadeMs?: number;
  }) => void;
  onRemaster: () => void;
}

const PRESET_LABELS: Array<{ id: MasteringPreset; label: string; desc: string }> = [
  { id: 'natural', label: 'Natural', desc: 'Balanced warmth & -18 LUFS' },
  { id: 'youtube', label: 'YouTube Narration', desc: 'Crisp presence & -14 LUFS' },
  { id: 'podcast', label: 'Podcast', desc: 'Broadcast clarity & -16 LUFS' },
  { id: 'raw', label: 'Raw AI Output', desc: 'Bypass all DSP' },
  { id: 'custom', label: 'Custom', desc: 'Manual DSP sliders' },
];

export function MasteringPanel({
  settings,
  extra,
  sentencePauseMs,
  paragraphPauseMs,
  chunkCrossfadeMs,
  hasAudio,
  isMastering,
  onChangeSettings,
  onChangeExtra,
  onChangeTiming,
  onRemaster,
}: MasteringPanelProps) {
  const [showAdvancedEq, setShowAdvancedEq] = useState(false);

  const selectPreset = (presetId: MasteringPreset) => {
    const base = MASTERING_PRESETS[presetId];
    onChangeSettings({ ...base, preset: presetId });
  };

  const updateCustomField = (partial: Partial<MasteringSettings>) => {
    onChangeSettings({ ...partial, preset: 'custom' });
  };

  const isRaw = settings.preset === 'raw';

  return (
    <div className="rounded-lg border border-[var(--vf-border)] bg-[var(--vf-surface)] p-4 space-y-4">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <div>
          <div className="flex items-center gap-2">
            <SlidersHorizontal className="w-4 h-4 text-[var(--vf-accent)]" />
            <h3 className="text-sm font-semibold text-[var(--vf-text)]">
              Non-Destructive Audio Mastering
            </h3>
          </div>
          <p className="text-[11px] text-[var(--vf-text-muted)] mt-0.5">
            Re-masters stored raw chunks via client-side DSP without re-synthesizing speech.
          </p>
        </div>

        <button
          type="button"
          disabled={!hasAudio || isMastering}
          onClick={onRemaster}
          className="inline-flex items-center gap-1.5 px-3 py-1.5 rounded-md text-xs font-semibold bg-[var(--vf-accent)] text-white hover:bg-[var(--vf-accent-hover)] disabled:opacity-40 disabled:cursor-not-allowed transition"
        >
          <AudioLines className="w-3.5 h-3.5" />
          {isMastering ? 'Mastering...' : 'Apply Mastering'}
        </button>
      </div>

      {/* Preset Switches */}
      <div className="grid grid-cols-2 sm:grid-cols-5 gap-2">
        {PRESET_LABELS.map((item) => {
          const active = settings.preset === item.id;
          return (
            <button
              key={item.id}
              type="button"
              onClick={() => selectPreset(item.id)}
              className={`rounded-md border px-2.5 py-2 text-left transition ${
                active
                  ? 'border-[var(--vf-accent)] bg-[var(--vf-accent)]/12 text-[var(--vf-text)]'
                  : 'border-[var(--vf-border)] bg-[var(--vf-bg)] text-[var(--vf-text-muted)] hover:border-[var(--vf-text-subtle)] hover:text-[var(--vf-text)]'
              }`}
            >
              <div className="text-xs font-semibold">{item.label}</div>
              <div className="text-[10px] opacity-80 mt-0.5">{item.desc}</div>
            </button>
          );
        })}
      </div>

      {/* Core Mastering & Timing Faders */}
      <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 gap-4 pt-1">
        <div className="space-y-1">
          <div className="flex justify-between text-xs">
            <span className="text-[var(--vf-text-muted)]">Sentence Pause</span>
            <span className="font-mono tabular-nums text-[var(--vf-accent)]">
              {sentencePauseMs} ms
            </span>
          </div>
          <input
            type="range"
            min={0}
            max={1500}
            step={20}
            value={sentencePauseMs}
            onChange={(e) => onChangeTiming({ sentencePauseMs: Number(e.target.value) })}
            className="w-full accent-[var(--vf-accent)]"
          />
        </div>

        <div className="space-y-1">
          <div className="flex justify-between text-xs">
            <span className="text-[var(--vf-text-muted)]">Paragraph Pause</span>
            <span className="font-mono tabular-nums text-[var(--vf-accent)]">
              {paragraphPauseMs} ms
            </span>
          </div>
          <input
            type="range"
            min={0}
            max={3000}
            step={25}
            value={paragraphPauseMs}
            onChange={(e) => onChangeTiming({ paragraphPauseMs: Number(e.target.value) })}
            className="w-full accent-[var(--vf-accent)]"
          />
        </div>

        <div className="space-y-1">
          <div className="flex justify-between text-xs">
            <span className="text-[var(--vf-text-muted)]">Speed (Pitch-Preserving)</span>
            <span className="font-mono tabular-nums text-[var(--vf-accent)]">
              {(extra.speed ?? 1).toFixed(2)}x
            </span>
          </div>
          <input
            type="range"
            min={0.7}
            max={1.5}
            step={0.05}
            disabled={isRaw}
            value={extra.speed ?? 1}
            onChange={(e) => onChangeExtra({ speed: Number(e.target.value) })}
            className="w-full accent-[var(--vf-accent)] disabled:opacity-40"
          />
        </div>

        <div className="space-y-1">
          <div className="flex justify-between text-xs">
            <span className="text-[var(--vf-text-muted)]">Target Loudness</span>
            <span className="font-mono tabular-nums text-[var(--vf-accent)]">
              {settings.targetLufs} LUFS
            </span>
          </div>
          <input
            type="range"
            min={-24}
            max={-10}
            step={0.5}
            disabled={isRaw}
            value={settings.targetLufs}
            onChange={(e) => updateCustomField({ targetLufs: Number(e.target.value) })}
            className="w-full accent-[var(--vf-accent)] disabled:opacity-40"
          />
        </div>

        <div className="space-y-1">
          <div className="flex justify-between text-xs">
            <span className="text-[var(--vf-text-muted)]">Fade-In / Fade-Out</span>
            <span className="font-mono tabular-nums text-[var(--vf-accent)]">
              {settings.fadeInMs} / {settings.fadeOutMs} ms
            </span>
          </div>
          <div className="grid grid-cols-2 gap-2">
            <input
              type="range"
              min={0}
              max={500}
              step={5}
              disabled={isRaw}
              value={settings.fadeInMs}
              onChange={(e) => updateCustomField({ fadeInMs: Number(e.target.value) })}
              className="w-full accent-[var(--vf-accent)] disabled:opacity-40"
              title="Fade-in ms"
            />
            <input
              type="range"
              min={0}
              max={1000}
              step={5}
              disabled={isRaw}
              value={settings.fadeOutMs}
              onChange={(e) => updateCustomField({ fadeOutMs: Number(e.target.value) })}
              className="w-full accent-[var(--vf-accent)] disabled:opacity-40"
              title="Fade-out ms"
            />
          </div>
        </div>

        <div className="space-y-1.5">
          <label className="flex items-center justify-between text-xs text-[var(--vf-text-muted)] cursor-pointer">
            <span>Trim Long Internal Silence</span>
            <input
              type="checkbox"
              disabled={isRaw}
              checked={Boolean(extra.reduceExcessiveSilence)}
              onChange={(e) => onChangeExtra({ reduceExcessiveSilence: e.target.checked })}
              className="accent-[var(--vf-accent)] disabled:opacity-40"
            />
          </label>
          <div className="flex items-center gap-2">
            <input
              type="range"
              min={250}
              max={1500}
              step={50}
              disabled={isRaw || !extra.reduceExcessiveSilence}
              value={extra.maxInternalSilenceMs ?? 600}
              onChange={(e) => onChangeExtra({ maxInternalSilenceMs: Number(e.target.value) })}
              className="w-full accent-[var(--vf-accent)] disabled:opacity-40"
            />
            <span className="text-[11px] font-mono tabular-nums text-[var(--vf-text-muted)] w-14 text-right">
              {extra.maxInternalSilenceMs ?? 600}ms
            </span>
          </div>
        </div>
      </div>

      {/* Expandable Tone & Dynamics */}
      <div>
        <button
          type="button"
          onClick={() => setShowAdvancedEq((v) => !v)}
          className="inline-flex items-center gap-1 text-xs font-medium text-[var(--vf-text-muted)] hover:text-[var(--vf-accent)] transition"
        >
          {showAdvancedEq ? (
            <ChevronUp className="w-3.5 h-3.5" />
          ) : (
            <ChevronDown className="w-3.5 h-3.5" />
          )}
          EQ, Warmth, De-Esser &amp; Limiter Details
        </button>

        {showAdvancedEq && (
          <div className="mt-3 grid grid-cols-1 sm:grid-cols-3 gap-3 pt-3 border-t border-[var(--vf-border-subtle)]">
            <div className="space-y-1">
              <div className="flex justify-between text-xs">
                <span className="text-[var(--vf-text-muted)]">Low / Mid / High EQ (dB)</span>
                <span className="font-mono tabular-nums text-[var(--vf-accent)]">
                  {settings.eqLowGainDb.toFixed(1)} / {settings.eqMidGainDb.toFixed(1)} /{' '}
                  {settings.eqHighGainDb.toFixed(1)}
                </span>
              </div>
              <div className="grid grid-cols-3 gap-1.5">
                <input
                  type="range"
                  min={-6}
                  max={6}
                  step={0.5}
                  disabled={isRaw}
                  value={settings.eqLowGainDb}
                  onChange={(e) => updateCustomField({ eqLowGainDb: Number(e.target.value) })}
                  className="accent-[var(--vf-accent)]"
                />
                <input
                  type="range"
                  min={-6}
                  max={6}
                  step={0.5}
                  disabled={isRaw}
                  value={settings.eqMidGainDb}
                  onChange={(e) => updateCustomField({ eqMidGainDb: Number(e.target.value) })}
                  className="accent-[var(--vf-accent)]"
                />
                <input
                  type="range"
                  min={-6}
                  max={6}
                  step={0.5}
                  disabled={isRaw}
                  value={settings.eqHighGainDb}
                  onChange={(e) => updateCustomField({ eqHighGainDb: Number(e.target.value) })}
                  className="accent-[var(--vf-accent)]"
                />
              </div>
            </div>

            <div className="space-y-1">
              <div className="flex justify-between text-xs">
                <span className="text-[var(--vf-text-muted)]">Warmth / Clarity / De-Ess</span>
                <span className="font-mono tabular-nums text-[var(--vf-accent)]">
                  {Math.round(settings.warmth * 100)}% / {Math.round(settings.clarity * 100)}% /{' '}
                  {Math.round(settings.deEsserAmount * 100)}%
                </span>
              </div>
              <div className="grid grid-cols-3 gap-1.5">
                <input
                  type="range"
                  min={0}
                  max={1}
                  step={0.05}
                  disabled={isRaw}
                  value={settings.warmth}
                  onChange={(e) => updateCustomField({ warmth: Number(e.target.value) })}
                  className="accent-[var(--vf-accent)]"
                />
                <input
                  type="range"
                  min={0}
                  max={1}
                  step={0.05}
                  disabled={isRaw}
                  value={settings.clarity}
                  onChange={(e) => updateCustomField({ clarity: Number(e.target.value) })}
                  className="accent-[var(--vf-accent)]"
                />
                <input
                  type="range"
                  min={0}
                  max={1}
                  step={0.05}
                  disabled={isRaw}
                  value={settings.deEsserAmount}
                  onChange={(e) => updateCustomField({ deEsserAmount: Number(e.target.value) })}
                  className="accent-[var(--vf-accent)]"
                />
              </div>
            </div>

            <div className="space-y-1">
              <div className="flex justify-between text-xs">
                <span className="text-[var(--vf-text-muted)]">
                  Crossfade (0-pause) &amp; Peak Limit
                </span>
                <span className="font-mono tabular-nums text-[var(--vf-accent)]">
                  {chunkCrossfadeMs}ms / {settings.truePeakLimitDb.toFixed(1)} dBTP
                </span>
              </div>
              <div className="grid grid-cols-2 gap-2">
                <input
                  type="range"
                  min={0}
                  max={12}
                  step={1}
                  value={chunkCrossfadeMs}
                  onChange={(e) => onChangeTiming({ chunkCrossfadeMs: Number(e.target.value) })}
                  className="accent-[var(--vf-accent)]"
                />
                <input
                  type="range"
                  min={-3}
                  max={-0.1}
                  step={0.1}
                  disabled={isRaw}
                  value={settings.truePeakLimitDb}
                  onChange={(e) =>
                    updateCustomField({ truePeakLimitDb: Number(e.target.value) })
                  }
                  className="accent-[var(--vf-accent)]"
                />
              </div>
            </div>
          </div>
        )}
      </div>
    </div>
  );
}
