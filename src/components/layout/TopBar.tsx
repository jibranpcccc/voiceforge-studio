import { useEffect, useState } from 'react';
import { Menu, Moon, SlidersHorizontal, Sun } from 'lucide-react';
import { useAppStore, type AppRoute } from '../../stores/appStore';
import { SyntheticBadge } from './SyntheticBadge';

export interface TopBarProps {
  activeRoute: AppRoute;
  onOpenMobileMenu: () => void;
  onNavigate: (route: AppRoute) => void;
}

const ROUTE_META: Record<AppRoute, { title: string; subtitle: string }> = {
  dashboard: { title: 'Dashboard', subtitle: 'Hardware & workspace overview' },
  clone: { title: 'Voice Cloning', subtitle: 'Reference capture & encoding' },
  studio: { title: 'Text to Speech', subtitle: 'Long-form narration studio' },
  voices: { title: 'My Voices', subtitle: 'Saved voice library' },
  projects: { title: 'Projects', subtitle: 'Saved narration projects' },
  lab: { title: 'Audio Lab', subtitle: 'A/B comparison & telemetry' },
  models: { title: 'Model Manager', subtitle: 'Offline weights & SHA-256' },
  settings: { title: 'Settings', subtitle: 'Execution, mirrors & privacy' },
  poc: { title: 'PoC Inference Harness', subtitle: 'Internal engine verification & telemetry' },
};

const MODE_LABELS = {
  quality: 'Quality (WebGPU)',
  balanced: 'Balanced',
  cpu: 'CPU (WASM)',
} as const;

export function TopBar({ activeRoute, onOpenMobileMenu, onNavigate }: TopBarProps) {
  const theme = useAppStore((s) => s.theme);
  const toggleTheme = useAppStore((s) => s.toggleTheme);
  const executionMode = useAppStore((s) => s.executionMode);
  const [isOnline, setIsOnline] = useState<boolean>(
    typeof navigator !== 'undefined' ? navigator.onLine : true
  );

  useEffect(() => {
    const onOnline = () => setIsOnline(true);
    const onOffline = () => setIsOnline(false);
    window.addEventListener('online', onOnline);
    window.addEventListener('offline', onOffline);
    return () => {
      window.removeEventListener('online', onOnline);
      window.removeEventListener('offline', onOffline);
    };
  }, []);

  const meta = ROUTE_META[activeRoute] ?? { title: 'VoiceForge Studio', subtitle: '' };

  return (
    <header className="sticky top-0 z-30 h-12 border-b border-[var(--vf-border)] bg-[var(--vf-surface)]/95 backdrop-blur-sm px-4 sm:px-6 flex items-center justify-between gap-3">
      <div className="flex items-center gap-3 min-w-0">
        <button
          type="button"
          onClick={onOpenMobileMenu}
          className="lg:hidden rounded-md p-1.5 text-[var(--vf-text-muted)] hover:text-[var(--vf-text)] hover:bg-[var(--vf-surface-muted)] cursor-pointer"
          aria-label="Open navigation menu"
        >
          <Menu className="h-4 w-4" />
        </button>

        <div className="flex items-baseline gap-2.5 min-w-0">
          <h1 className="text-sm font-semibold tracking-tight truncate">
            {meta.title}
          </h1>
          {meta.subtitle && (
            <p className="hidden sm:block text-[11px] text-[var(--vf-text-subtle)] truncate border-l border-[var(--vf-border)] pl-2.5">
              {meta.subtitle}
            </p>
          )}
        </div>
      </div>

      <div className="flex items-center gap-2 shrink-0">
        <div className="hidden xl:flex">
          <SyntheticBadge compact />
        </div>

        <span
          className="hidden sm:inline-flex items-center gap-1.5 rounded-md border border-[var(--vf-border)] bg-[var(--vf-bg)] px-2 py-1 text-[11px] font-mono text-[var(--vf-text-muted)]"
          title={
            isOnline
              ? 'Browser reports network connectivity'
              : 'Browser is offline — cached models and local app shell remain active'
          }
        >
          <span
            aria-hidden="true"
            className={`h-1.5 w-1.5 rounded-full ${
              isOnline ? 'bg-[var(--vf-success)]' : 'bg-[var(--vf-warning)]'
            }`}
          />
          <span>{isOnline ? 'Online' : 'Offline Mode'}</span>
        </span>

        <button
          type="button"
          onClick={() => onNavigate('settings')}
          className="inline-flex items-center gap-1.5 rounded-md border border-[var(--vf-border)] bg-[var(--vf-surface-elevated)] px-2.5 py-1 text-[11px] font-mono text-[var(--vf-text-muted)] hover:text-[var(--vf-text)] hover:border-[var(--vf-accent)]/50 transition-colors cursor-pointer"
          title="Execution Mode (click to configure in Settings)"
        >
          <SlidersHorizontal className="h-3 w-3 text-[var(--vf-accent)]" />
          <span className="hidden md:inline">{MODE_LABELS[executionMode]}</span>
          <span className="md:hidden uppercase">{executionMode}</span>
        </button>

        <button
          type="button"
          onClick={toggleTheme}
          className="rounded-md border border-[var(--vf-border)] bg-[var(--vf-surface-elevated)] p-1.5 text-[var(--vf-text-muted)] hover:text-[var(--vf-text)] hover:border-[var(--vf-accent)]/50 transition-colors cursor-pointer"
          aria-label={theme === 'dark' ? 'Switch to light theme' : 'Switch to dark theme'}
          title={theme === 'dark' ? 'Switch to light theme' : 'Switch to dark theme'}
        >
          {theme === 'dark' ? <Sun className="h-3.5 w-3.5" /> : <Moon className="h-3.5 w-3.5" />}
        </button>
      </div>
    </header>
  );
}
