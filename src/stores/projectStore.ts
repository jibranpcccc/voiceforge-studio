/**
 * Saved long-form narration projects store backed by IndexedDB (`projects` + `audioChunks`).
 * Supports project CRUD, interrupted job recovery/resume, single-chunk regeneration,
 * and cascade deletion of disk-backed audio chunks.
 */

import { create } from 'zustand';
import {
  NarrationQueueService,
  narrationQueue,
  recoverInterruptedProject,
  type RunQueueOptions,
} from '../services/narrationQueue';
import {
  DEFAULT_PREPROCESSING_OPTIONS,
  getStudioPreset,
} from '../services/presets';
import {
  getDefaultMaxCharsForEngine,
  segmentScriptToProjectChunks,
} from '../services/segmenter';
import {
  deleteProject,
  getProject,
  listProjects,
  saveProject,
} from '../storage/db';
import type {
  ExecutionMode,
  GenerationQueueState,
  MasteringSettings,
  NarrationProject,
  PreprocessingOptions,
  PronunciationRule,
  StudioPresetId,
} from '../types';

function generateProjectId(): string {
  if (typeof crypto !== 'undefined' && typeof crypto.randomUUID === 'function') {
    return crypto.randomUUID();
  }
  return `proj-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
}

export interface CreateProjectInput {
  id?: string;
  name: string;
  description?: string;
  voiceProfileId: string | null;
  engineId: string;
  executionMode: ExecutionMode;
  presetId: StudioPresetId;
  scriptText: string;
  pronunciationRules?: PronunciationRule[];
  preprocessing?: PreprocessingOptions;
  mastering?: MasteringSettings;
  sentencePauseMs?: number;
  paragraphPauseMs?: number;
  chunkCrossfadeMs?: number;
  maxChunkChars?: number;
  engineParameters?: Record<string, number | string | boolean>;
}

export interface ProjectStoreState {
  projects: NarrationProject[];
  activeProject: NarrationProject | null;
  loading: boolean;
  error: string | null;
  queueState: GenerationQueueState;

  loadProjects: () => Promise<NarrationProject[]>;
  selectProject: (projectId: string | null) => Promise<NarrationProject | null>;
  createProject: (input: CreateProjectInput) => Promise<NarrationProject>;
  saveProjectRecord: (project: NarrationProject) => Promise<NarrationProject>;
  deleteProjectRecord: (projectId: string) => Promise<void>;

  startProjectQueue: (
    projectId: string,
    options?: RunQueueOptions,
    queueInstance?: NarrationQueueService
  ) => Promise<NarrationProject>;
  resumeProjectQueue: (
    projectId: string,
    options?: RunQueueOptions,
    queueInstance?: NarrationQueueService
  ) => Promise<NarrationProject>;
  pauseProjectQueue: (queueInstance?: NarrationQueueService) => void;
  cancelProjectQueue: (queueInstance?: NarrationQueueService) => Promise<void>;
  retryFailedProjectChunks: (
    projectId: string,
    options?: RunQueueOptions,
    queueInstance?: NarrationQueueService
  ) => Promise<NarrationProject>;
  regenerateSingleChunk: (
    projectId: string,
    chunkId: string,
    overrides?: Parameters<NarrationQueueService['regenerateChunk']>[2],
    queueInstance?: NarrationQueueService
  ) => Promise<NarrationProject>;
  clearInMemoryProjects: () => void;
}

export const useProjectStore = create<ProjectStoreState>((set, get) => {
  const syncFromQueue = (queueInstance: NarrationQueueService) => {
    const unsubState = queueInstance.subscribeState((queueState) => {
      set({ queueState });
    });
    const unsubProject = queueInstance.subscribeProject((updatedProject) => {
      set((state) => ({
        activeProject:
          state.activeProject?.id === updatedProject.id
            ? updatedProject
            : state.activeProject,
        projects: state.projects.some((p) => p.id === updatedProject.id)
          ? state.projects.map((p) => (p.id === updatedProject.id ? updatedProject : p))
          : [updatedProject, ...state.projects],
      }));
    });
    return () => {
      unsubState();
      unsubProject();
    };
  };

  return {
    projects: [],
    activeProject: null,
    loading: false,
    error: null,
    queueState: narrationQueue.getState(),

    loadProjects: async () => {
      set({ loading: true, error: null });
      try {
        const raw = await listProjects();
        const projects: NarrationProject[] = [];
        for (const item of raw) {
          const recovered = recoverInterruptedProject(item);
          if (recovered !== item) {
            await saveProject(recovered);
          }
          projects.push(recovered);
        }
        const activeId = get().activeProject?.id;
        const activeProject = activeId
          ? projects.find((p) => p.id === activeId) ?? null
          : get().activeProject;
        set({ projects, activeProject, loading: false });
        return projects;
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        set({ loading: false, error: message });
        throw err;
      }
    },

    selectProject: async (projectId) => {
      if (!projectId) {
        set({ activeProject: null });
        return null;
      }
      const loaded = await getProject(projectId);
      if (!loaded) {
        set({ activeProject: null });
        return null;
      }
      const recovered = recoverInterruptedProject(loaded);
      if (recovered !== loaded) {
        await saveProject(recovered);
      }
      set({ activeProject: recovered });
      return recovered;
    },

    createProject: async (input) => {
      const preset = getStudioPreset(input.presetId);
      const sentencePauseMs = input.sentencePauseMs ?? preset.sentencePauseMs;
      const paragraphPauseMs = input.paragraphPauseMs ?? preset.paragraphPauseMs;
      const chunkCrossfadeMs = input.chunkCrossfadeMs ?? preset.chunkCrossfadeMs;
      const maxCharsPerChunk =
        input.maxChunkChars ?? getDefaultMaxCharsForEngine(input.engineId);
      const pronunciationRules = input.pronunciationRules
        ? [...input.pronunciationRules]
        : [];

      const id = input.id ?? generateProjectId();
      const chunks = segmentScriptToProjectChunks(input.scriptText, {
        maxCharsPerChunk,
        engineId: input.engineId,
        sentencePauseMs,
        paragraphPauseMs,
        pronunciationRules,
        idPrefix: `${id}-chunk`,
      });

      const now = new Date().toISOString();
      const project: NarrationProject = {
        id,
        name: input.name.trim() || 'Untitled Project',
        ...(input.description !== undefined ? { description: input.description } : {}),
        voiceProfileId: input.voiceProfileId,
        engineId: input.engineId,
        executionMode: input.executionMode,
        presetId: input.presetId,
        scriptText: input.scriptText,
        chunks,
        pronunciationRules,
        preprocessing: input.preprocessing
          ? { ...input.preprocessing }
          : { ...DEFAULT_PREPROCESSING_OPTIONS },
        mastering: input.mastering ? { ...input.mastering } : { ...preset.mastering },
        sentencePauseMs,
        paragraphPauseMs,
        chunkCrossfadeMs,
        engineParameters: input.engineParameters
          ? { ...input.engineParameters }
          : { ...preset.engineParameters },
        createdAt: now,
        updatedAt: now,
      };

      const saved = await saveProject(project);
      set((state) => ({
        activeProject: saved,
        projects: [saved, ...state.projects.filter((p) => p.id !== saved.id)],
      }));
      return saved;
    },

    saveProjectRecord: async (project) => {
      const saved = await saveProject(project);
      set((state) => ({
        activeProject:
          state.activeProject?.id === saved.id ? saved : state.activeProject,
        projects: state.projects.some((p) => p.id === saved.id)
          ? state.projects.map((p) => (p.id === saved.id ? saved : p))
          : [saved, ...state.projects],
      }));
      return saved;
    },

    deleteProjectRecord: async (projectId) => {
      await deleteProject(projectId);
      set((state) => ({
        projects: state.projects.filter((p) => p.id !== projectId),
        activeProject:
          state.activeProject?.id === projectId ? null : state.activeProject,
      }));
    },

    startProjectQueue: async (projectId, options, queueInstance = narrationQueue) => {
      const cleanup = syncFromQueue(queueInstance);
      try {
        return await queueInstance.startProject(projectId, options);
      } finally {
        cleanup();
      }
    },

    resumeProjectQueue: async (projectId, options, queueInstance = narrationQueue) => {
      const cleanup = syncFromQueue(queueInstance);
      try {
        return await queueInstance.resume(projectId, options);
      } finally {
        cleanup();
      }
    },

    pauseProjectQueue: (queueInstance = narrationQueue) => {
      queueInstance.pause();
      set({ queueState: queueInstance.getState() });
    },

    cancelProjectQueue: async (queueInstance = narrationQueue) => {
      await queueInstance.cancel();
      set({ queueState: queueInstance.getState() });
    },

    retryFailedProjectChunks: async (
      projectId,
      options,
      queueInstance = narrationQueue
    ) => {
      const cleanup = syncFromQueue(queueInstance);
      try {
        return await queueInstance.retryFailed(projectId, options);
      } finally {
        cleanup();
      }
    },

    regenerateSingleChunk: async (
      projectId,
      chunkId,
      overrides,
      queueInstance = narrationQueue
    ) => {
      const cleanup = syncFromQueue(queueInstance);
      try {
        return await queueInstance.regenerateChunk(projectId, chunkId, overrides);
      } finally {
        cleanup();
      }
    },

    clearInMemoryProjects: () => {
      set({ projects: [], activeProject: null, error: null });
    },
  };
});
