import { ShieldAlert } from 'lucide-react';

export interface SyntheticBadgeProps {
  compact?: boolean;
  className?: string;
}

export function SyntheticBadge({ compact = false, className = '' }: SyntheticBadgeProps) {
  return (
    <span
      title="Generated audio is synthetic AI speech. VoiceForge Studio processes all audio 100% locally in your browser."
      className={`inline-flex items-center gap-1.5 rounded-full border border-[var(--vf-accent)]/30 bg-[var(--vf-accent-soft)] px-2.5 py-1 text-[11px] font-medium text-[var(--vf-accent)] ${className}`}
    >
      <ShieldAlert className="h-3.5 w-3.5 shrink-0" />
      <span>{compact ? 'Synthetic AI Audio' : 'Synthetic AI Speech • 100% Local'}</span>
    </span>
  );
}
