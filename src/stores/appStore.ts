/**
 * Global application store: theme, execution mode, custom model base URL,
 * detected hardware compatibility reports, active route, and full local wipe.
 */

import { create } from 'zustand';
import {
  EngineRegistry,
  defaultEngineRegistry,
} from '../engines/registry';
import {
  detectHardwareCapabilities,
  type HardwareCapabilities,
} from '../services/hardware';
import { clearAllUserData } from '../storage/db';
import type {
  ExecutionMode,
  ExportFormat,
  ExportSampleRate,
  HardwareCompatibilityReport,
} from '../types';

export type AppTheme = 'dark' | 'light';
export type AppRoute =
  | 'dashboard'
  | 'clone'
  | 'studio'
  | 'voices'
  | 'projects'
  | 'lab'
  | 'models'
  | 'settings'
  | 'poc';

const STORAGE_THEME_KEY = 'vf_theme';
const STORAGE_EXEC_MODE_KEY = 'vf_execution_mode';
const STORAGE_CUSTOM_BASE_URL_KEY = 'vf_custom_model_base_url';
const STORAGE_EXPORT_FORMAT_KEY = 'vf_default_export_format';
const STORAGE_EXPORT_SAMPLE_RATE_KEY = 'vf_default_export_sample_rate';

function readStorage(key: string): string | null {
  try {
    if (typeof globalThis.localStorage === 'undefined') return null;
    return globalThis.localStorage.getItem(key);
  } catch {
    return null;
  }
}

function writeStorage(key: string, value: string): void {
  try {
    if (typeof globalThis.localStorage === 'undefined') return;
    if (value) {
      globalThis.localStorage.setItem(key, value);
    } else {
      globalThis.localStorage.removeItem(key);
    }
  } catch {
    // Ignore storage quota or sandbox restrictions.
  }
}

function applyThemeToDom(theme: AppTheme): void {
  if (typeof document === 'undefined') return;
  const root = document.documentElement;
  root.dataset.theme = theme;
  root.classList.toggle('dark', theme === 'dark');
}

function loadInitialTheme(): AppTheme {
  const saved = readStorage(STORAGE_THEME_KEY);
  const theme: AppTheme = saved === 'light' ? 'light' : 'dark';
  applyThemeToDom(theme);
  return theme;
}

function loadInitialExecutionMode(): ExecutionMode {
  const saved = readStorage(STORAGE_EXEC_MODE_KEY);
  if (saved === 'quality' || saved === 'balanced' || saved === 'cpu') {
    return saved;
  }
  return 'balanced';
}

function loadInitialExportFormat(): ExportFormat {
  const saved = readStorage(STORAGE_EXPORT_FORMAT_KEY);
  if (
    saved === 'wav16' ||
    saved === 'wav24' ||
    saved === 'mp3_128' ||
    saved === 'mp3_192' ||
    saved === 'mp3_256' ||
    saved === 'mp3_320'
  ) {
    return saved;
  }
  return 'wav16';
}

function loadInitialExportSampleRate(): ExportSampleRate {
  const saved = readStorage(STORAGE_EXPORT_SAMPLE_RATE_KEY);
  if (saved === '44100') return 44100;
  if (saved === '48000') return 48000;
  return 'native';
}

export interface AppState {
  theme: AppTheme;
  executionMode: ExecutionMode;
  customModelBaseUrl: string;
  defaultExportFormat: ExportFormat;
  defaultExportSampleRate: ExportSampleRate;
  hardwareCapabilities: HardwareCapabilities | null;
  hardwareReport: Record<string, HardwareCompatibilityReport>;
  hardwareLoading: boolean;
  hardwareError: string | null;
  activeRoute: AppRoute;
  isWipingData: boolean;

  setTheme: (theme: AppTheme) => void;
  toggleTheme: () => void;
  setExecutionMode: (mode: ExecutionMode) => void;
  setCustomModelBaseUrl: (url: string) => void;
  setDefaultExportFormat: (format: ExportFormat) => void;
  setDefaultExportSampleRate: (sampleRate: ExportSampleRate) => void;
  setActiveRoute: (route: AppRoute) => void;
  detectHardware: (registry?: EngineRegistry) => Promise<HardwareCapabilities>;
  wipeAllData: () => Promise<void>;
}

export const useAppStore = create<AppState>((set, get) => ({
  theme: loadInitialTheme(),
  executionMode: loadInitialExecutionMode(),
  customModelBaseUrl: readStorage(STORAGE_CUSTOM_BASE_URL_KEY) ?? '',
  defaultExportFormat: loadInitialExportFormat(),
  defaultExportSampleRate: loadInitialExportSampleRate(),
  hardwareCapabilities: null,
  hardwareReport: {},
  hardwareLoading: false,
  hardwareError: null,
  activeRoute: 'dashboard',
  isWipingData: false,

  setTheme: (theme) => {
    writeStorage(STORAGE_THEME_KEY, theme);
    applyThemeToDom(theme);
    set({ theme });
  },

  toggleTheme: () => {
    const next: AppTheme = get().theme === 'dark' ? 'light' : 'dark';
    get().setTheme(next);
  },

  setExecutionMode: (executionMode) => {
    writeStorage(STORAGE_EXEC_MODE_KEY, executionMode);
    set({ executionMode });
  },

  setCustomModelBaseUrl: (url) => {
    const clean = url.trim();
    writeStorage(STORAGE_CUSTOM_BASE_URL_KEY, clean);
    set({ customModelBaseUrl: clean });
  },

  setDefaultExportFormat: (defaultExportFormat) => {
    writeStorage(STORAGE_EXPORT_FORMAT_KEY, defaultExportFormat);
    set({ defaultExportFormat });
  },

  setDefaultExportSampleRate: (defaultExportSampleRate) => {
    writeStorage(STORAGE_EXPORT_SAMPLE_RATE_KEY, String(defaultExportSampleRate));
    set({ defaultExportSampleRate });
  },

  setActiveRoute: (activeRoute) => {
    set({ activeRoute });
  },

  detectHardware: async (registry = defaultEngineRegistry) => {
    set({ hardwareLoading: true, hardwareError: null });
    try {
      const capabilities = await detectHardwareCapabilities();
      const reports = await registry.checkCompatibilityAll();
      const hardwareReport: Record<string, HardwareCompatibilityReport> = {};
      for (const report of reports) {
        hardwareReport[report.engineId] = report;
      }

      const persistedMode = readStorage(STORAGE_EXEC_MODE_KEY);
      const nextMode =
        persistedMode === 'quality' || persistedMode === 'balanced' || persistedMode === 'cpu'
          ? persistedMode
          : capabilities.recommendedExecutionMode;

      set({
        hardwareCapabilities: capabilities,
        hardwareReport,
        executionMode: nextMode,
        hardwareLoading: false,
      });
      return capabilities;
    } catch (err) {
      set({
        hardwareLoading: false,
        hardwareError: err instanceof Error ? err.message : String(err),
      });
      throw err;
    }
  },

  wipeAllData: async () => {
    set({ isWipingData: true });
    try {
      await clearAllUserData();
      applyThemeToDom('dark');
      set({
        theme: 'dark',
        executionMode: 'balanced',
        customModelBaseUrl: '',
        defaultExportFormat: 'wav16',
        defaultExportSampleRate: 'native',
        hardwareError: null,
        isWipingData: false,
      });
    } catch (err) {
      set({ isWipingData: false });
      throw err;
    }
  },
}));
