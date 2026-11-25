export interface ProgressBarProps {
  /** Progress fraction between 0 and 1 (or percentage 0-100 if `max` is 100). */
  value: number;
  max?: number;
  label?: string;
  sublabel?: string;
  showPercent?: boolean;
  indeterminate?: boolean;
  tone?: 'accent' | 'success' | 'warning' | 'danger';
  size?: 'sm' | 'md';
  className?: string;
}

const TONE_FILL: Record<NonNullable<ProgressBarProps['tone']>, string> = {
  accent: 'bg-[var(--vf-accent)]',
  success: 'bg-[var(--vf-success)]',
  warning: 'bg-[var(--vf-warning)]',
  danger: 'bg-[var(--vf-danger)]',
};

export function ProgressBar({
  value,
  max = 1,
  label,
  sublabel,
  showPercent = true,
  indeterminate = false,
  tone = 'accent',
  size = 'md',
  className = '',
}: ProgressBarProps) {
  const safeMax = max > 0 ? max : 1;
  const ratio = Math.min(1, Math.max(0, Number.isFinite(value) ? value / safeMax : 0));
  const percent = Math.round(ratio * 100);
  const heightClass = size === 'sm' ? 'h-1.5' : 'h-2';

  return (
    <div className={`w-full ${className}`}>
      {(label || showPercent) && (
        <div className="flex items-center justify-between gap-2 mb-1.5 text-xs">
          <span className="font-medium text-[var(--vf-text)] truncate">{label ?? ''}</span>
          {showPercent && !indeterminate && (
            <span className="font-mono tabular-nums text-[var(--vf-text-muted)] shrink-0">
              {percent}%
            </span>
          )}
        </div>
      )}

      <div
        className={`w-full ${heightClass} rounded-sm bg-[var(--vf-bg)] border border-[var(--vf-border)] overflow-hidden`}
        role="progressbar"
        aria-valuemin={0}
        aria-valuemax={100}
        aria-valuenow={indeterminate ? undefined : percent}
        aria-label={label || 'Progress'}
      >
        {indeterminate ? (
          <div
            className={`h-full w-1/3 rounded-xs ${TONE_FILL[tone]} animate-pulse`}
          />
        ) : (
          <div
            className={`h-full rounded-xs ${TONE_FILL[tone]} transition-all duration-200 ease-out`}
            style={{ width: `${percent}%` }}
          />
        )}
      </div>

      {sublabel && (
        <p className="mt-1 text-[11px] font-mono text-[var(--vf-text-muted)] truncate">{sublabel}</p>
      )}
    </div>
  );
}
