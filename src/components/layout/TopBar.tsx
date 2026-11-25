import { useEffect, useState } from 'react';
import { Cpu, Menu, Moon, Sun, Wifi, WifiOff } from 'lucide-react';
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
  const title = meta.title;
  const subtitle = meta.subtitle;

  return (
    <header className="sticky top-0 z-30 h-14 border-b border-[var(--vf-border)] bg-[var(--vf-surface)]/90 backdrop-blur-md px-4 sm:px-6 flex items-center justify-between gap-3">
      <div className="flex items-center gap-3 min-w-0">
        <button
          type="button"
          onClick={onOpenMobileMenu}
          className="lg:hidden rounded-lg p-2 text-[var(--vf-text-muted)] hover:text-[var(--vf-text)] hover:bg-[var(--vf-surface-muted)] cursor-pointer"
          aria-label="Open navigation menu"
        >
          <Menu className="h-5 w-5" />
        </button>

        <div className="min-w-0">
          <h1 className="text-sm sm:text-base font-semibold tracking-tight truncate">
            {title}
          </h1>
          {subtitle && (
            <p className="hidden sm:block text-[11px] text-[var(--vf-text-muted)] truncate">
              {subtitle}
            </p>
          )}
        </div>
      </div>

      <div className="flex items-center gap-2 shrink-0">
        <div className="hidden xl:flex">
          <SyntheticBadge compact />
        </div>

        <span
          className={`hidden sm:inline-flex items-center gap-1.5 rounded-full border px-2.5 py-1 text-[11px] font-medium ${
            isOnline
              ? 'border-emerald-500/25 bg-emerald-500/10 text-emerald-400'
              : 'border-amber-500/30 bg-amber-500/10 text-amber-400'
          }`}
          title={
            isOnline
              ? 'Browser reports network connectivity'
              : 'Browser is offline — cached models and local app shell remain active'
          }
        >
          {isOnline ? <Wifi className="h-3 w-3" /> : <WifiOff className="h-3 w-3" />}
          <span>{isOnline ? 'Online' : 'Offline Mode'}</span>
        </span>

        <button
          type="button"
          onClick={() => onNavigate('settings')}
          className="inline-flex items-center gap-1.5 rounded-full border border-[var(--vf-border)] bg-[var(--vf-surface-elevated)] px-2.5 py-1 text-[11px] font-medium text-[var(--vf-text-muted)] hover:text-[var(--vf-text)] hover:border-[var(--vf-accent)]/40 transition-colors cursor-pointer"
          title="Execution Mode (click to configure in Settings)"
        >
          <Cpu className="h-3 w-3 text-[var(--vf-accent)]" />
          <span className="hidden md:inline">{MODE_LABELS[executionMode]}</span>
          <span className="md:hidden uppercase">{executionMode}</span>
        </button>

        <button
          type="button"
          onClick={toggleTheme}
          className="rounded-xl border border-[var(--vf-border)] bg-[var(--vf-surface-elevated)] p-2 text-[var(--vf-text-muted)] hover:text-[var(--vf-text)] hover:border-[var(--vf-accent)]/40 transition-colors cursor-pointer"
          aria-label={theme === 'dark' ? 'Switch to light theme' : 'Switch to dark theme'}
          title={theme === 'dark' ? 'Switch to light theme' : 'Switch to dark theme'}
        >
          {theme === 'dark' ? <Sun className="h-4 w-4" /> : <Moon className="h-4 w-4" />}
        </button>
      </div>
    </header>
  );
}
