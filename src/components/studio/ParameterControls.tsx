import { Info, RotateCcw, Sliders } from 'lucide-react';
import type { GenerationParameterSpec } from '../../types';

export interface ParameterControlsProps {
  engineName: string;
  specs: readonly GenerationParameterSpec[];
  values: Record<string, number | string | boolean>;
  onChange: (key: string, value: number | string | boolean) => void;
  onResetDefaults?: () => void;
  disabled?: boolean;
}

export function ParameterControls({
  engineName,
  specs,
  values,
  onChange,
  onResetDefaults,
  disabled = false,
}: ParameterControlsProps) {
  return (
    <div className="rounded-xl border border-slate-200 dark:border-slate-800 bg-white dark:bg-[#121622] p-4 space-y-4">
      <div className="flex items-center justify-between gap-2">
        <div className="flex items-center gap-2">
          <Sliders className="w-4 h-4 text-[#7C5CFF]" />
          <h3 className="text-sm font-semibold text-slate-900 dark:text-slate-100">
            Engine Parameters ({engineName})
          </h3>
        </div>
        {onResetDefaults && (
          <button
            type="button"
            disabled={disabled}
            onClick={onResetDefaults}
            className="inline-flex items-center gap-1 text-xs text-slate-500 dark:text-slate-400 hover:text-[#7C5CFF] disabled:opacity-40 transition"
          >
            <RotateCcw className="w-3 h-3" />
            Reset
          </button>
        )}
      </div>

      <div className="rounded-lg border border-slate-200 dark:border-slate-800 bg-slate-50 dark:bg-[#0B0D12]/60 px-3 py-2 flex items-start gap-2 text-[11px] text-slate-600 dark:text-slate-400">
        <Info className="w-3.5 h-3.5 shrink-0 text-[#7C5CFF] mt-0.5" />
        <span>
          Only parameters supported by <strong>{engineName}</strong> are displayed; unsupported controls
          from other engines are hidden. Note: random seed determinism across different hardware or
          execution backends (WebGPU vs WASM) is not guaranteed.
        </span>
      </div>

      <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
        {specs.map((spec) => {
          const rawValue = values[spec.key] ?? spec.defaultValue;

          if (spec.type === 'boolean') {
            const checked = Boolean(rawValue);
            return (
              <label
                key={spec.key}
                className="flex items-start justify-between gap-3 rounded-lg border border-slate-200 dark:border-slate-800 p-3 cursor-pointer"
              >
                <div>
                  <div className="text-xs font-medium text-slate-800 dark:text-slate-200">
                    {spec.label}
                  </div>
                  <div className="text-[11px] text-slate-500 dark:text-slate-400 mt-0.5">
                    {spec.description}
                  </div>
                </div>
                <input
                  type="checkbox"
                  checked={checked}
                  disabled={disabled}
                  onChange={(e) => onChange(spec.key, e.target.checked)}
                  className="mt-0.5 accent-[#7C5CFF]"
                />
              </label>
            );
          }

          if (spec.type === 'select' && spec.options) {
            return (
              <div key={spec.key} className="space-y-1.5">
                <label className="block text-xs font-medium text-slate-800 dark:text-slate-200">
                  {spec.label}
                </label>
                <select
                  value={String(rawValue)}
                  disabled={disabled}
                  onChange={(e) => onChange(spec.key, e.target.value)}
                  className="w-full rounded-lg border border-slate-200 dark:border-slate-700 bg-slate-50 dark:bg-[#0B0D12] px-2.5 py-1.5 text-xs text-slate-900 dark:text-slate-100 focus:border-[#7C5CFF] focus:outline-none"
                >
                  {spec.options.map((opt) => (
                    <option key={String(opt.value)} value={String(opt.value)}>
                      {opt.label}
                    </option>
                  ))}
                </select>
                <p className="text-[11px] text-slate-500 dark:text-slate-400">{spec.description}</p>
              </div>
            );
          }

          const numVal = typeof rawValue === 'number' && Number.isFinite(rawValue)
            ? rawValue
            : Number(spec.defaultValue) || 0;

          const isLargeIntegerSeed =
            spec.key === 'seed' || (spec.max !== undefined && spec.max > 1000);

          if (isLargeIntegerSeed) {
            return (
              <div key={spec.key} className="space-y-1.5">
                <div className="flex items-center justify-between gap-2">
                  <label className="text-xs font-medium text-slate-800 dark:text-slate-200">
                    {spec.label}
                  </label>
                  <button
                    type="button"
                    disabled={disabled}
                    onClick={() => onChange(spec.key, Math.floor(Math.random() * 1_000_000))}
                    className="text-[11px] text-[#7C5CFF] hover:underline disabled:opacity-40"
                  >
                    Randomize
                  </button>
                </div>
                <input
                  type="number"
                  min={spec.min ?? -1}
                  max={spec.max ?? 2_147_483_647}
                  step={spec.step ?? 1}
                  value={numVal}
                  disabled={disabled}
                  onChange={(e) => {
                    const parsed = Number(e.target.value);
                    onChange(spec.key, Number.isFinite(parsed) ? Math.trunc(parsed) : spec.defaultValue);
                  }}
                  className="w-full rounded-lg border border-slate-200 dark:border-slate-700 bg-slate-50 dark:bg-[#0B0D12] px-2.5 py-1.5 text-xs font-mono text-slate-900 dark:text-slate-100 focus:border-[#7C5CFF] focus:outline-none"
                />
                <p className="text-[11px] text-slate-500 dark:text-slate-400">{spec.description}</p>
              </div>
            );
          }

          return (
            <div key={spec.key} className="space-y-1.5">
              <div className="flex items-center justify-between gap-2">
                <label className="text-xs font-medium text-slate-800 dark:text-slate-200">
                  {spec.label}
                </label>
                <span className="text-xs font-mono font-semibold text-[#7C5CFF]">
                  {Number.isInteger(spec.step ?? 1) ? numVal : numVal.toFixed(2)}
                </span>
              </div>
              <input
                type="range"
                min={spec.min ?? 0}
                max={spec.max ?? 1}
                step={spec.step ?? 0.05}
                value={numVal}
                disabled={disabled}
                onChange={(e) => onChange(spec.key, Number(e.target.value))}
                className="w-full accent-[#7C5CFF] cursor-pointer disabled:opacity-50"
              />
              <p className="text-[11px] text-slate-500 dark:text-slate-400">{spec.description}</p>
            </div>
          );
        })}
      </div>
    </div>
  );
}
