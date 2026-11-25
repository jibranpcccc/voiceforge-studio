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
      className={`rounded-lg border border-dashed border-[var(--vf-border)] bg-[var(--vf-bg)] p-6 text-center flex flex-col items-center justify-center ${className}`}
    >
      {icon && (
        <div className="h-10 w-10 rounded-md bg-[var(--vf-surface)] border border-[var(--vf-border)] text-[var(--vf-accent)] flex items-center justify-center mb-3">
          {icon}
        </div>
      )}
      <h3 className="text-xs font-semibold uppercase tracking-[0.04em] text-[var(--vf-text)]">
        {title}
      </h3>
      <p className="text-xs text-[var(--vf-text-muted)] max-w-md mt-1.5 leading-relaxed">
        {description}
      </p>
      {action && <div className="mt-4">{action}</div>}
    </div>
  );
}
