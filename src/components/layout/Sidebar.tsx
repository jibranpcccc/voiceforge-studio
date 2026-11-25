import {
  AudioWaveform,
  Boxes,
  FlaskConical,
  FolderKanban,
  LayoutDashboard,
  Mic,
  Settings,
  Sparkles,
  Users,
  X,
  type LucideIcon,
} from 'lucide-react';
import type { AppRoute } from '../../stores/appStore';
import { SyntheticBadge } from './SyntheticBadge';

interface NavItemConfig {
  route: AppRoute;
  label: string;
  Icon: LucideIcon;
}

const MAIN_NAV_ITEMS: readonly NavItemConfig[] = [
  { route: 'dashboard', label: 'Dashboard', Icon: LayoutDashboard },
  { route: 'clone', label: 'Voice Cloning', Icon: Mic },
  { route: 'studio', label: 'Text to Speech', Icon: Sparkles },
  { route: 'voices', label: 'My Voices', Icon: Users },
  { route: 'projects', label: 'Projects', Icon: FolderKanban },
  { route: 'lab', label: 'Audio Lab', Icon: FlaskConical },
  { route: 'models', label: 'Model Manager', Icon: Boxes },
  { route: 'settings', label: 'Settings', Icon: Settings },
];

export interface SidebarProps {
  activeRoute: AppRoute;
  onNavigate: (route: AppRoute) => void;
  offlineReadyCount: number;
  totalModelsCount: number;
  mobileOpen: boolean;
  onCloseMobile: () => void;
}

export function Sidebar({
  activeRoute,
  onNavigate,
  offlineReadyCount,
  totalModelsCount,
  mobileOpen,
  onCloseMobile,
}: SidebarProps) {
  const navContent = (
    <div className="flex flex-col h-full bg-[var(--vf-surface)] border-r border-[var(--vf-border)] text-[var(--vf-text)]">
      {/* Brand header */}
      <div className="flex items-center justify-between gap-3 px-4 py-4 border-b border-[var(--vf-border-subtle)]">
        <a
          href="#/dashboard"
          onClick={(e) => {
            e.preventDefault();
            onNavigate('dashboard');
            onCloseMobile();
          }}
          className="flex items-center gap-2.5 min-w-0 group"
        >
          <div className="h-9 w-9 rounded-xl bg-[var(--vf-accent-soft)] border border-[var(--vf-accent)]/35 flex items-center justify-center text-[var(--vf-accent)] shrink-0">
            <AudioWaveform className="h-5 w-5" />
          </div>
          <div className="min-w-0">
            <div className="text-sm font-semibold tracking-tight truncate group-hover:text-[var(--vf-accent)] transition-colors">
              VoiceForge Studio
            </div>
            <div className="text-[11px] text-[var(--vf-text-muted)] truncate">
              Client-Side Voice AI
            </div>
          </div>
        </a>

        <button
          type="button"
          onClick={onCloseMobile}
          className="lg:hidden rounded-lg p-1.5 text-[var(--vf-text-muted)] hover:text-[var(--vf-text)] hover:bg-[var(--vf-surface-muted)] cursor-pointer"
          aria-label="Close navigation menu"
        >
          <X className="h-4 w-4" />
        </button>
      </div>

      {/* Navigation items */}
      <nav className="flex-1 overflow-y-auto px-3 py-3 space-y-1" aria-label="Main navigation">
        {MAIN_NAV_ITEMS.map(({ route, label, Icon }) => {
          const isActive = activeRoute === route;
          return (
            <a
              key={route}
              href={`#/${route}`}
              onClick={(event) => {
                event.preventDefault();
                onNavigate(route);
                onCloseMobile();
              }}
              aria-current={isActive ? 'page' : undefined}
              className={`flex items-center gap-3 rounded-xl px-3 py-2.5 text-sm font-medium transition-colors ${
                isActive
                  ? 'bg-[var(--vf-accent-soft)] text-[var(--vf-accent)] border border-[var(--vf-accent)]/30'
                  : 'text-[var(--vf-text-muted)] hover:text-[var(--vf-text)] hover:bg-[var(--vf-surface-muted)] border border-transparent'
              }`}
            >
              <Icon className="h-4 w-4 shrink-0" />
              <span className="truncate">{label}</span>
            </a>
          );
        })}
      </nav>

      {/* Bottom local-first & model status summary */}
      <div className="p-3 border-t border-[var(--vf-border-subtle)] space-y-2.5">
        <div className="rounded-xl bg-[var(--vf-surface-elevated)] border border-[var(--vf-border-subtle)] px-3 py-2.5">
          <div className="flex items-center justify-between text-xs">
            <span className="text-[var(--vf-text-muted)]">Cached Models</span>
            <span className="font-mono font-medium text-[var(--vf-text)]">
              {offlineReadyCount} / {totalModelsCount}
            </span>
          </div>
          <p className="text-[11px] text-[var(--vf-text-subtle)] mt-1">
            Zero uploads • Runs in browser
          </p>
        </div>

        <SyntheticBadge className="w-full justify-center" />
      </div>
    </div>
  );

  return (
    <>
      {/* Desktop persistent sidebar */}
      <aside className="hidden lg:block w-64 shrink-0 h-screen sticky top-0">
        {navContent}
      </aside>

      {/* Mobile slide-over drawer */}
      {mobileOpen && (
        <div className="fixed inset-0 z-40 lg:hidden flex">
          <div
            className="fixed inset-0 bg-black/65 backdrop-blur-xs"
            onClick={onCloseMobile}
            aria-hidden="true"
          />
          <aside className="relative z-50 w-72 max-w-[85vw] h-full shadow-2xl">
            {navContent}
          </aside>
        </div>
      )}
    </>
  );
}
