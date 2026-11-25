import {
  AudioLines,
  Boxes,
  FolderKanban,
  LayoutDashboard,
  Mic,
  Settings,
  Users,
  Waves,
  X,
  type LucideIcon,
} from 'lucide-react';
import type { AppRoute } from '../../stores/appStore';

interface NavItemConfig {
  route: AppRoute;
  label: string;
  Icon: LucideIcon;
}

interface NavGroupConfig {
  heading: string;
  items: readonly NavItemConfig[];
}

const NAV_GROUPS: readonly NavGroupConfig[] = [
  {
    heading: 'WORKSPACE',
    items: [
      { route: 'dashboard', label: 'Dashboard', Icon: LayoutDashboard },
      { route: 'clone', label: 'Voice Cloning', Icon: Mic },
      { route: 'studio', label: 'Text to Speech', Icon: AudioLines },
    ],
  },
  {
    heading: 'LIBRARY',
    items: [
      { route: 'voices', label: 'My Voices', Icon: Users },
      { route: 'projects', label: 'Projects', Icon: FolderKanban },
      { route: 'lab', label: 'Audio Lab', Icon: Waves },
    ],
  },
  {
    heading: 'SYSTEM',
    items: [
      { route: 'models', label: 'Model Manager', Icon: Boxes },
      { route: 'settings', label: 'Settings', Icon: Settings },
    ],
  },
];

export interface SidebarProps {
  activeRoute: AppRoute;
  onNavigate: (route: AppRoute) => void;
  offlineReadyCount: number;
  totalModelsCount: number;
  mobileOpen: boolean;
  onCloseMobile: () => void;
}

function VoiceForgeLogoMark() {
  return (
    <svg
      viewBox="0 0 24 24"
      fill="none"
      className="h-5 w-5 shrink-0"
      aria-hidden="true"
    >
      <rect x="2.5" y="9" width="2" height="6" rx="0.75" fill="currentColor" opacity="0.45" />
      <rect x="6.5" y="5" width="2" height="14" rx="0.75" fill="currentColor" opacity="0.75" />
      <rect x="10.5" y="2.5" width="2.5" height="19" rx="0.75" fill="var(--vf-accent)" />
      <rect x="15" y="6" width="2" height="12" rx="0.75" fill="currentColor" opacity="0.75" />
      <rect x="19" y="8.5" width="2" height="7" rx="0.75" fill="currentColor" opacity="0.45" />
    </svg>
  );
}

export function Sidebar({
  activeRoute,
  onNavigate,
  offlineReadyCount,
  totalModelsCount,
  mobileOpen,
  onCloseMobile,
}: SidebarProps) {
  const safeTotal = Math.max(totalModelsCount, 1);
  const cacheRatio = Math.min(100, Math.round((offlineReadyCount / safeTotal) * 100));

  const navContent = (
    <div className="flex flex-col h-full bg-[var(--vf-surface)] border-r border-[var(--vf-border)] text-[var(--vf-text)]">
      {/* Brand header */}
      <div className="flex items-center justify-between gap-2.5 h-12 px-3.5 border-b border-[var(--vf-border)]">
        <a
          href="#/dashboard"
          onClick={(e) => {
            e.preventDefault();
            onNavigate('dashboard');
            onCloseMobile();
          }}
          className="flex items-center gap-2.5 min-w-0 group"
        >
          <div className="h-7 w-7 rounded-md bg-[var(--vf-bg)] border border-[var(--vf-border)] flex items-center justify-center text-[var(--vf-text)] shrink-0">
            <VoiceForgeLogoMark />
          </div>
          <div className="min-w-0 leading-none">
            <div className="text-xs font-semibold tracking-[0.14em] uppercase truncate group-hover:text-[var(--vf-accent)] transition-colors">
              VOICEFORGE
            </div>
            <div className="text-[10px] font-mono uppercase tracking-[0.08em] text-[var(--vf-text-subtle)] mt-0.5 truncate">
              Mastering Console
            </div>
          </div>
        </a>

        <button
          type="button"
          onClick={onCloseMobile}
          className="lg:hidden rounded-md p-1 text-[var(--vf-text-muted)] hover:text-[var(--vf-text)] hover:bg-[var(--vf-surface-muted)] cursor-pointer"
          aria-label="Close navigation menu"
        >
          <X className="h-4 w-4" />
        </button>
      </div>

      {/* Grouped navigation sections */}
      <nav className="flex-1 overflow-y-auto px-2.5 py-3 space-y-4" aria-label="Main navigation">
        {NAV_GROUPS.map((group) => (
          <div key={group.heading} className="space-y-1">
            <div className="px-2.5 pb-1 text-[10px] font-semibold uppercase tracking-[0.12em] text-[var(--vf-text-subtle)]">
              {group.heading}
            </div>
            <div className="space-y-0.5">
              {group.items.map(({ route, label, Icon }) => {
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
                    className={`relative flex items-center gap-2.5 rounded-md px-2.5 py-2 text-[13px] font-medium transition-colors ${
                      isActive
                        ? 'bg-[var(--vf-surface-elevated)] text-[var(--vf-text)] border border-[var(--vf-border-subtle)]'
                        : 'text-[var(--vf-text-muted)] hover:text-[var(--vf-text)] hover:bg-[var(--vf-surface-muted)]/60 border border-transparent'
                    }`}
                  >
                    {isActive && (
                      <span
                        aria-hidden="true"
                        className="absolute left-0 top-1.5 bottom-1.5 w-[2px] rounded-r bg-[var(--vf-accent)]"
                      />
                    )}
                    <Icon
                      className={`h-4 w-4 shrink-0 ${
                        isActive ? 'text-[var(--vf-accent)]' : 'text-[var(--vf-text-subtle)]'
                      }`}
                    />
                    <span className="truncate">{label}</span>
                  </a>
                );
              })}
            </div>
          </div>
        ))}
      </nav>

      {/* Bottom local model cache meter */}
      <div className="p-3 border-t border-[var(--vf-border-subtle)]">
        <div className="rounded-md bg-[var(--vf-bg)] border border-[var(--vf-border-subtle)] px-3 py-2.5">
          <div className="flex items-center justify-between text-[11px]">
            <span className="uppercase tracking-[0.06em] font-medium text-[var(--vf-text-muted)]">
              Cached Models
            </span>
            <span className="font-mono font-semibold text-[var(--vf-text)] tabular-nums">
              {offlineReadyCount}/{totalModelsCount}
            </span>
          </div>
          <div className="mt-2 h-1 w-full rounded-full bg-[var(--vf-surface-muted)] overflow-hidden">
            <div
              className="h-full bg-[var(--vf-accent)] transition-all duration-200"
              style={{ width: `${cacheRatio}%` }}
            />
          </div>
          <p className="text-[10px] font-mono text-[var(--vf-text-subtle)] mt-1.5">
            Local ONNX · Zero uploads
          </p>
        </div>
      </div>
    </div>
  );

  return (
    <>
      {/* Desktop persistent sidebar */}
      <aside className="hidden lg:block w-56 shrink-0 h-screen sticky top-0">
        {navContent}
      </aside>

      {/* Mobile slide-over drawer */}
      {mobileOpen && (
        <div className="fixed inset-0 z-40 lg:hidden flex">
          <div
            className="fixed inset-0 bg-black/70 backdrop-blur-xs"
            onClick={onCloseMobile}
            aria-hidden="true"
          />
          <aside className="relative z-50 w-60 max-w-[85vw] h-full shadow-2xl">
            {navContent}
          </aside>
        </div>
      )}
    </>
  );
}
