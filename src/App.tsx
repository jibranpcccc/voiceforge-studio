import { lazy, Suspense, useCallback, useEffect } from 'react';
import { ToastContainer } from './components/common';
import { StudioShell } from './components/layout';
import { ChatterboxEngine } from './engines/chatterbox';
import { PocketTtsEngine } from './engines/pocket';
import { defaultEngineRegistry } from './engines/registry';
import { AudioLabPage } from './pages/AudioLabPage';
import { DashboardPage } from './pages/DashboardPage';
import { ModelManagerPage } from './pages/ModelManagerPage';
import { MyVoicesPage } from './pages/MyVoicesPage';
import { ProjectsPage } from './pages/ProjectsPage';
import { SettingsPage } from './pages/SettingsPage';
import { StudioPage } from './pages/StudioPage';
import { VoiceCloningPage } from './pages/VoiceCloningPage';
import { useAppStore, type AppRoute } from './stores/appStore';
import { useModelStore } from './stores/modelStore';

const PocHarness = lazy(() => import('./pages/PocHarness'));

const VALID_ROUTES = new Set<AppRoute>([
  'dashboard',
  'clone',
  'studio',
  'voices',
  'projects',
  'lab',
  'models',
  'settings',
  'poc',
]);

function parseRouteFromHash(hash: string): AppRoute {
  const cleaned = hash.replace(/^#\/?/, '').split('?')[0].trim().toLowerCase();
  if (cleaned === 'audio-lab') return 'lab';
  if (VALID_ROUTES.has(cleaned as AppRoute)) {
    return cleaned as AppRoute;
  }
  return 'dashboard';
}

let registeredPocketBaseUrl: string | null = null;

function ensureDefaultEnginesRegistered(customModelBaseUrl: string): void {
  const normalized = customModelBaseUrl.trim();
  if (!defaultEngineRegistry.has('pocket-tts') || registeredPocketBaseUrl !== normalized) {
    defaultEngineRegistry.register(
      new PocketTtsEngine({
        customModelBaseUrl: normalized || undefined,
      }),
      { replace: true }
    );
    registeredPocketBaseUrl = normalized;
  }
  if (!defaultEngineRegistry.has('chatterbox')) {
    defaultEngineRegistry.register(new ChatterboxEngine());
  }
}

export function App() {
  const activeRoute = useAppStore((s) => s.activeRoute);
  const setActiveRoute = useAppStore((s) => s.setActiveRoute);
  const customModelBaseUrl = useAppStore((s) => s.customModelBaseUrl);
  const detectHardware = useAppStore((s) => s.detectHardware);
  const loadManifest = useModelStore((s) => s.loadManifest);

  const navigate = useCallback(
    (route: AppRoute) => {
      setActiveRoute(route);
      if (typeof window !== 'undefined') {
        const currentParsed = parseRouteFromHash(window.location.hash);
        if (currentParsed !== route || !window.location.hash) {
          window.location.hash = `#/${route}`;
        }
      }
    },
    [setActiveRoute]
  );

  // Sync initial hash & hashchange events -> appStore
  useEffect(() => {
    const syncFromHash = () => {
      const nextRoute = parseRouteFromHash(window.location.hash);
      if (useAppStore.getState().activeRoute !== nextRoute) {
        setActiveRoute(nextRoute);
      }
    };

    if (!window.location.hash) {
      window.location.hash = '#/dashboard';
    }
    syncFromHash();

    window.addEventListener('hashchange', syncFromHash);
    return () => window.removeEventListener('hashchange', syncFromHash);
  }, [setActiveRoute]);

  // Sync programmatic setActiveRoute() calls -> window.location.hash
  useEffect(() => {
    if (typeof window === 'undefined') return;
    const currentFromHash = parseRouteFromHash(window.location.hash);
    if (currentFromHash !== activeRoute) {
      window.location.hash = `#/${activeRoute}`;
    }
  }, [activeRoute]);

  // Bootstrap default engine registry, hardware probe, and model manifest
  useEffect(() => {
    ensureDefaultEnginesRegistered(customModelBaseUrl);
    void detectHardware().catch(() => undefined);
    void loadManifest().catch(() => undefined);
  }, [customModelBaseUrl, detectHardware, loadManifest]);

  if (activeRoute === 'poc') {
    return (
      <>
        <Suspense
          fallback={
            <div className="min-h-screen bg-[var(--vf-bg)] text-[var(--vf-text-muted)] flex items-center justify-center font-mono text-sm">
              Loading PoC Harness...
            </div>
          }
        >
          <PocHarness />
        </Suspense>
        <ToastContainer />
      </>
    );
  }

  return (
    <>
      <StudioShell activeRoute={activeRoute} onNavigate={navigate}>
        {activeRoute === 'dashboard' && <DashboardPage />}
        {activeRoute === 'clone' && <VoiceCloningPage />}
        {activeRoute === 'studio' && <StudioPage />}
        {activeRoute === 'voices' && <MyVoicesPage />}
        {activeRoute === 'projects' && <ProjectsPage />}
        {activeRoute === 'lab' && <AudioLabPage />}
        {activeRoute === 'models' && <ModelManagerPage />}
        {activeRoute === 'settings' && <SettingsPage />}
      </StudioShell>
      <ToastContainer />
    </>
  );
}

export default App;
