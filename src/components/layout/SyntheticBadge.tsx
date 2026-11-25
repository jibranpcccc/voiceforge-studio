import { Radio } from 'lucide-react';

export interface SyntheticBadgeProps {
  compact?: boolean;
  className?: string;
}

export function SyntheticBadge({ compact = false, className = '' }: SyntheticBadgeProps) {
  return (
    <span
      title="Generated audio is synthetic AI speech. VoiceForge Studio processes all audio 100% locally in your browser."
      className={`inline-flex items-center gap-1.5 rounded-md border border-[var(--vf-border)] bg-[var(--vf-bg)] px-2 py-0.5 text-[10px] font-mono uppercase tracking-[0.06em] text-[var(--vf-text-muted)] ${className}`}
    >
      <Radio className="h-3 w-3 text-[var(--vf-accent)] shrink-0" />
      <span>{compact ? 'Synthetic AI Audio' : 'Synthetic AI Speech · 100% Local'}</span>
    </span>
  );
}
