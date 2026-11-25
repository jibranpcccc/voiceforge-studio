/**
 * Narration Studio state store:
 * - Script text with bounded undo/redo stack
 * - LocalStorage draft autosave & restore
 * - Selected voice, engine, Studio Quality Preset, parameters, mastering, preprocessing
 * - Pronunciation dictionary rules backed by IndexedDB
 * - Active narration queue state & chunk list
 */

import { create } from 'zustand';
import { narrationQueue } from '../services/narrationQueue';
import {
  DEFAULT_PREPROCESSING_OPTIONS,
  getStudioPreset,
} from '../services/presets';
import {
  createPronunciationRule,
  removePronunciationRule,
  togglePronunciationRule,
  upsertPronunciationRule,
} from '../services/pronunciation';
import {
  deletePronunciationRule as deleteDbPronunciationRule,
  listPronunciationRules as listDbPronunciationRules,
  savePronunciationRule as saveDbPronunciationRule,
} from '../storage/db';
import type {
  GenerationQueueState,
  MasteringSettings,
  PreprocessingOptions,
  PronunciationRule,
  ScriptChunk,
  StudioPresetId,
} from '../types';

const STORAGE_STUDIO_DRAFT_KEY = 'vf_studio_draft';
const MAX_UNDO_HISTORY = 50;

interface StudioDraftPayload {
  projectTitle: string;
  scriptText: string;
  selectedVoiceId: string | null;
  selectedEngineId: string;
  selectedPresetId: StudioPresetId;
  engineParameters: Record<string, number | string | boolean>;
  mastering: MasteringSettings;
  preprocessing: PreprocessingOptions;
  sentencePauseMs: number;
  paragraphPauseMs: number;
  chunkCrossfadeMs: number;
  maxChunkChars: number;
  savedAt: string;
}

function readDraftFromStorage(): Partial<StudioDraftPayload> | null {
  try {
    if (typeof globalThis.localStorage === 'undefined') return null;
    const raw = globalThis.localStorage.getItem(STORAGE_STUDIO_DRAFT_KEY);
    if (!raw) return null;
    const parsed: unknown = JSON.parse(raw);
    if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) {
      return null;
    }
    return parsed as Partial<StudioDraftPayload>;
  } catch {
    return null;
  }
}

function writeDraftToStorage(draft: StudioDraftPayload): void {
  try {
    if (typeof globalThis.localStorage === 'undefined') return;
    globalThis.localStorage.setItem(STORAGE_STUDIO_DRAFT_KEY, JSON.stringify(draft));
  } catch {
    // Ignore storage quota errors.
  }
}

function clearDraftFromStorage(): void {
  try {
    if (typeof globalThis.localStorage === 'undefined') return;
    globalThis.localStorage.removeItem(STORAGE_STUDIO_DRAFT_KEY);
  } catch {
    // Ignore storage errors.
  }
}

const defaultPreset = getStudioPreset('natural-narration');
const initialDraft = readDraftFromStorage();

export interface StudioStoreState {
  projectTitle: string;
  activeProjectId: string | null;
  scriptText: string;
  undoStack: string[];
  redoStack: string[];
  lastDraftSavedAt: string | null;

  selectedVoiceId: string | null;
  selectedEngineId: string;
  selectedPresetId: StudioPresetId;
  engineParameters: Record<string, number | string | boolean>;
  mastering: MasteringSettings;
  preprocessing: PreprocessingOptions;
  sentencePauseMs: number;
  paragraphPauseMs: number;
  chunkCrossfadeMs: number;
  maxChunkChars: number;

  pronunciationRules: PronunciationRule[];
  activeProjectChunks: ScriptChunk[];
  queueState: GenerationQueueState;

  setProjectTitle: (title: string) => void;
  setActiveProjectId: (projectId: string | null) => void;
  setScriptText: (text: string, recordHistory?: boolean) => void;
  undo: () => void;
  redo: () => void;
  saveDraft: () => void;
  loadDraft: () => boolean;
  clearDraft: () => void;

  selectVoice: (voiceId: string | null) => void;
  selectEngine: (engineId: string) => void;
  applyPreset: (presetId: StudioPresetId) => void;
  setEngineParameter: (key: string, value: number | string | boolean) => void;
  setMastering: (partial: Partial<MasteringSettings>) => void;
  setPreprocessing: (partial: Partial<PreprocessingOptions>) => void;
  setTiming: (partial: {
    sentencePauseMs?: number;
    paragraphPauseMs?: number;
    chunkCrossfadeMs?: number;
    maxChunkChars?: number;
  }) => void;

  loadPronunciationRules: () => Promise<PronunciationRule[]>;
  addOrUpdatePronunciationRule: (
    rule: Omit<PronunciationRule, 'id'> & { id?: string }
  ) => Promise<PronunciationRule>;
  togglePronunciationRuleById: (id: string) => Promise<void>;
  deletePronunciationRuleById: (id: string) => Promise<void>;

  setActiveProjectChunks: (chunks: ScriptChunk[]) => void;
  setQueueState: (queueState: GenerationQueueState) => void;
}

export const useStudioStore = create<StudioStoreState>((set, get) => ({
  projectTitle:
    typeof initialDraft?.projectTitle === 'string' && initialDraft.projectTitle.trim()
      ? initialDraft.projectTitle
      : 'Untitled Narration',
  activeProjectId: null,
  scriptText: typeof initialDraft?.scriptText === 'string' ? initialDraft.scriptText : '',
  undoStack: [],
  redoStack: [],
  lastDraftSavedAt:
    typeof initialDraft?.savedAt === 'string' ? initialDraft.savedAt : null,

  selectedVoiceId:
    typeof initialDraft?.selectedVoiceId === 'string'
      ? initialDraft.selectedVoiceId
      : null,
  selectedEngineId:
    typeof initialDraft?.selectedEngineId === 'string'
      ? initialDraft.selectedEngineId
      : 'pocket-tts',
  selectedPresetId:
    typeof initialDraft?.selectedPresetId === 'string'
      ? (initialDraft.selectedPresetId as StudioPresetId)
      : 'natural-narration',
  engineParameters: initialDraft?.engineParameters
    ? { ...initialDraft.engineParameters }
    : { ...defaultPreset.engineParameters },
  mastering: initialDraft?.mastering
    ? { ...defaultPreset.mastering, ...initialDraft.mastering }
    : { ...defaultPreset.mastering },
  preprocessing: initialDraft?.preprocessing
    ? { ...DEFAULT_PREPROCESSING_OPTIONS, ...initialDraft.preprocessing }
    : { ...DEFAULT_PREPROCESSING_OPTIONS },
  sentencePauseMs:
    typeof initialDraft?.sentencePauseMs === 'number'
      ? initialDraft.sentencePauseMs
      : defaultPreset.sentencePauseMs,
  paragraphPauseMs:
    typeof initialDraft?.paragraphPauseMs === 'number'
      ? initialDraft.paragraphPauseMs
      : defaultPreset.paragraphPauseMs,
  chunkCrossfadeMs:
    typeof initialDraft?.chunkCrossfadeMs === 'number'
      ? initialDraft.chunkCrossfadeMs
      : defaultPreset.chunkCrossfadeMs,
  maxChunkChars:
    typeof initialDraft?.maxChunkChars === 'number'
      ? initialDraft.maxChunkChars
      : defaultPreset.maxChunkChars,

  pronunciationRules: [],
  activeProjectChunks: [],
  queueState: narrationQueue.getState(),

  setProjectTitle: (projectTitle) => {
    set({ projectTitle });
    get().saveDraft();
  },

  setActiveProjectId: (activeProjectId) => {
    set({ activeProjectId });
  },

  setScriptText: (text, recordHistory = true) => {
    const prev = get().scriptText;
    if (text === prev) return;

    if (recordHistory) {
      const nextUndo = [...get().undoStack, prev].slice(-MAX_UNDO_HISTORY);
      set({
        scriptText: text,
        undoStack: nextUndo,
        redoStack: [],
      });
    } else {
      set({ scriptText: text });
    }
    get().saveDraft();
  },

  undo: () => {
    const { undoStack, redoStack, scriptText } = get();
    if (undoStack.length === 0) return;
    const previous = undoStack[undoStack.length - 1];
    set({
      scriptText: previous,
      undoStack: undoStack.slice(0, -1),
      redoStack: [...redoStack, scriptText].slice(-MAX_UNDO_HISTORY),
    });
    get().saveDraft();
  },

  redo: () => {
    const { undoStack, redoStack, scriptText } = get();
    if (redoStack.length === 0) return;
    const next = redoStack[redoStack.length - 1];
    set({
      scriptText: next,
      undoStack: [...undoStack, scriptText].slice(-MAX_UNDO_HISTORY),
      redoStack: redoStack.slice(0, -1),
    });
    get().saveDraft();
  },

  saveDraft: () => {
    const state = get();
    const savedAt = new Date().toISOString();
    writeDraftToStorage({
      projectTitle: state.projectTitle,
      scriptText: state.scriptText,
      selectedVoiceId: state.selectedVoiceId,
      selectedEngineId: state.selectedEngineId,
      selectedPresetId: state.selectedPresetId,
      engineParameters: state.engineParameters,
      mastering: state.mastering,
      preprocessing: state.preprocessing,
      sentencePauseMs: state.sentencePauseMs,
      paragraphPauseMs: state.paragraphPauseMs,
      chunkCrossfadeMs: state.chunkCrossfadeMs,
      maxChunkChars: state.maxChunkChars,
      savedAt,
    });
    set({ lastDraftSavedAt: savedAt });
  },

  loadDraft: () => {
    const draft = readDraftFromStorage();
    if (!draft) return false;
    set({
      projectTitle:
        typeof draft.projectTitle === 'string'
          ? draft.projectTitle
          : get().projectTitle,
      scriptText: typeof draft.scriptText === 'string' ? draft.scriptText : '',
      selectedVoiceId:
        typeof draft.selectedVoiceId === 'string' ? draft.selectedVoiceId : null,
      selectedEngineId:
        typeof draft.selectedEngineId === 'string'
          ? draft.selectedEngineId
          : 'pocket-tts',
      selectedPresetId:
        typeof draft.selectedPresetId === 'string'
          ? (draft.selectedPresetId as StudioPresetId)
          : 'natural-narration',
      engineParameters: draft.engineParameters
        ? { ...draft.engineParameters }
        : get().engineParameters,
      mastering: draft.mastering ? { ...get().mastering, ...draft.mastering } : get().mastering,
      preprocessing: draft.preprocessing
        ? { ...get().preprocessing, ...draft.preprocessing }
        : get().preprocessing,
      sentencePauseMs:
        typeof draft.sentencePauseMs === 'number'
          ? draft.sentencePauseMs
          : get().sentencePauseMs,
      paragraphPauseMs:
        typeof draft.paragraphPauseMs === 'number'
          ? draft.paragraphPauseMs
          : get().paragraphPauseMs,
      chunkCrossfadeMs:
        typeof draft.chunkCrossfadeMs === 'number'
          ? draft.chunkCrossfadeMs
          : get().chunkCrossfadeMs,
      maxChunkChars:
        typeof draft.maxChunkChars === 'number'
          ? draft.maxChunkChars
          : get().maxChunkChars,
      lastDraftSavedAt: typeof draft.savedAt === 'string' ? draft.savedAt : null,
    });
    return true;
  },

  clearDraft: () => {
    clearDraftFromStorage();
    const preset = getStudioPreset('natural-narration');
    set({
      projectTitle: 'Untitled Narration',
      activeProjectId: null,
      scriptText: '',
      undoStack: [],
      redoStack: [],
      lastDraftSavedAt: null,
      selectedPresetId: 'natural-narration',
      engineParameters: { ...preset.engineParameters },
      mastering: { ...preset.mastering },
      preprocessing: { ...DEFAULT_PREPROCESSING_OPTIONS },
      sentencePauseMs: preset.sentencePauseMs,
      paragraphPauseMs: preset.paragraphPauseMs,
      chunkCrossfadeMs: preset.chunkCrossfadeMs,
      maxChunkChars: preset.maxChunkChars,
      activeProjectChunks: [],
    });
  },

  selectVoice: (selectedVoiceId) => {
    set({ selectedVoiceId });
    get().saveDraft();
  },

  selectEngine: (selectedEngineId) => {
    set({ selectedEngineId });
    get().saveDraft();
  },

  applyPreset: (presetId) => {
    const preset = getStudioPreset(presetId);
    set({
      selectedPresetId: presetId,
      engineParameters: { ...preset.engineParameters },
      mastering: { ...preset.mastering },
      sentencePauseMs: preset.sentencePauseMs,
      paragraphPauseMs: preset.paragraphPauseMs,
      chunkCrossfadeMs: preset.chunkCrossfadeMs,
      maxChunkChars: preset.maxChunkChars,
    });
    get().saveDraft();
  },

  setEngineParameter: (key, value) => {
    set({
      selectedPresetId: 'custom',
      engineParameters: {
        ...get().engineParameters,
        [key]: value,
      },
    });
    get().saveDraft();
  },

  setMastering: (partial) => {
    set({
      mastering: {
        ...get().mastering,
        ...partial,
      },
    });
    get().saveDraft();
  },

  setPreprocessing: (partial) => {
    set({
      preprocessing: {
        ...get().preprocessing,
        ...partial,
      },
    });
    get().saveDraft();
  },

  setTiming: (partial) => {
    set({
      selectedPresetId: 'custom',
      sentencePauseMs: partial.sentencePauseMs ?? get().sentencePauseMs,
      paragraphPauseMs: partial.paragraphPauseMs ?? get().paragraphPauseMs,
      chunkCrossfadeMs: partial.chunkCrossfadeMs ?? get().chunkCrossfadeMs,
      maxChunkChars: partial.maxChunkChars ?? get().maxChunkChars,
    });
    get().saveDraft();
  },

  loadPronunciationRules: async () => {
    const rules = await listDbPronunciationRules();
    set({ pronunciationRules: rules });
    return rules;
  },

  addOrUpdatePronunciationRule: async (input) => {
    const rule = createPronunciationRule(input);
    await saveDbPronunciationRule(rule);
    set({
      pronunciationRules: upsertPronunciationRule(get().pronunciationRules, rule),
    });
    return rule;
  },

  togglePronunciationRuleById: async (id) => {
    const nextRules = togglePronunciationRule(get().pronunciationRules, id);
    const updated = nextRules.find((r) => r.id === id);
    if (updated) {
      await saveDbPronunciationRule(updated);
    }
    set({ pronunciationRules: nextRules });
  },

  deletePronunciationRuleById: async (id) => {
    await deleteDbPronunciationRule(id);
    set({
      pronunciationRules: removePronunciationRule(get().pronunciationRules, id),
    });
  },

  setActiveProjectChunks: (activeProjectChunks) => {
    set({ activeProjectChunks });
  },

  setQueueState: (queueState) => {
    set({ queueState });
  },
}));
