import type { ReactNode } from 'react';

export interface EmptyStateProps {
  icon?: ReactNode;
  title: string;
  description: string;
  action?: ReactNode;
  className?: string;
}

export function EmptyState({
  icon,
  title,
  description,
  action,
  className = '',
}: EmptyStateProps) {
  return (
    <div
      className={`rounded-2xl border border-dashed border-[var(--vf-border)] bg-[var(--vf-surface)]/60 p-8 text-center flex flex-col items-center justify-center ${className}`}
    >
      {icon && (
        <div className="h-12 w-12 rounded-2xl bg-[var(--vf-accent-soft)] border border-[var(--vf-accent)]/25 text-[var(--vf-accent)] flex items-center justify-center mb-3.5">
          {icon}
        </div>
      )}
      <h3 className="text-sm font-semibold text-[var(--vf-text)]">{title}</h3>
      <p className="text-xs text-[var(--vf-text-muted)] max-w-md mt-1.5 leading-relaxed">
        {description}
      </p>
      {action && <div className="mt-4">{action}</div>}
    </div>
  );
}
