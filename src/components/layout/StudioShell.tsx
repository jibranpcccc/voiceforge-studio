import { useState, type ReactNode } from 'react';
import { ShieldCheck } from 'lucide-react';
import type { AppRoute } from '../../stores/appStore';
import { useModelStore } from '../../stores/modelStore';
import { Sidebar } from './Sidebar';
import { TopBar } from './TopBar';

export interface StudioShellProps {
  activeRoute: AppRoute;
  onNavigate: (route: AppRoute) => void;
  children: ReactNode;
}

export function StudioShell({ activeRoute, onNavigate, children }: StudioShellProps) {
  const [mobileOpen, setMobileOpen] = useState(false);
  const models = useModelStore((s) => s.models);
  const modelList = Object.values(models);
  const offlineReadyCount = modelList.filter((m) => m.offlineReady).length;

  return (
    <div className="min-h-screen flex bg-[var(--vf-bg)] text-[var(--vf-text)]">
      <Sidebar
        activeRoute={activeRoute}
        onNavigate={onNavigate}
        offlineReadyCount={offlineReadyCount}
        totalModelsCount={modelList.length}
        mobileOpen={mobileOpen}
        onCloseMobile={() => setMobileOpen(false)}
      />

      <div className="flex-1 min-w-0 flex flex-col min-h-screen">
        <TopBar
          activeRoute={activeRoute}
          onOpenMobileMenu={() => setMobileOpen(true)}
          onNavigate={onNavigate}
        />

        <main className="flex-1 w-full max-w-[1440px] mx-auto px-4 sm:px-6 py-5">
          {children}
        </main>

        <footer className="border-t border-[var(--vf-border-subtle)] bg-[var(--vf-surface)]/80 px-4 sm:px-6 py-2.5">
          <div className="max-w-[1440px] mx-auto flex flex-col sm:flex-row items-start sm:items-center justify-between gap-2 text-[11px] text-[var(--vf-text-muted)]">
            <div className="flex items-center gap-2">
              <ShieldCheck className="h-3.5 w-3.5 text-[var(--vf-success)] shrink-0" />
              <span>
                100% client-side in your browser — reference audio, voice embeddings, and scripts never leave your device.
              </span>
            </div>
            <span className="font-mono uppercase tracking-[0.06em] text-[10px] text-[var(--vf-text-subtle)] shrink-0">
              ONNX Runtime Web · Local Storage Only
            </span>
          </div>
        </footer>
      </div>
    </div>
  );
}
