/**
 * Voice profiles store backed by IndexedDB (`voices` object store):
 * CRUD, default narrator star, rename, deep duplicate, and JSON bundle import/export.
 */

import { create } from 'zustand';
import {
  exportVoiceProfileJson,
  importVoiceProfile,
  type ImportVoiceProfileOptions,
} from '../services/voiceProfileIO';
import {
  deleteVoice,
  getVoice,
  listVoices,
  saveVoice,
  setDefaultVoice,
} from '../storage/db';
import type { VoiceConditioningPayload, VoiceProfile } from '../types';

function generateId(prefix: string): string {
  if (typeof crypto !== 'undefined' && typeof crypto.randomUUID === 'function') {
    return crypto.randomUUID();
  }
  return `${prefix}-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
}

function cloneConditioningPayloads(
  payloads: Record<string, VoiceConditioningPayload>
): Record<string, VoiceConditioningPayload> {
  const cloned: Record<string, VoiceConditioningPayload> = {};
  for (const [key, payload] of Object.entries(payloads)) {
    const clonedTensors: VoiceConditioningPayload['tensors'] = {};
    for (const [tensorName, tensor] of Object.entries(payload.tensors)) {
      clonedTensors[tensorName] = {
        dtype: tensor.dtype,
        dims: [...tensor.dims],
        data: tensor.data.slice(0),
      };
    }
    cloned[key] = {
      ...payload,
      tensors: clonedTensors,
      ...(payload.metadata ? { metadata: { ...payload.metadata } } : {}),
    };
  }
  return cloned;
}

export interface VoiceStoreState {
  voices: VoiceProfile[];
  defaultVoiceId: string | null;
  loading: boolean;
  error: string | null;

  loadVoices: (filter?: { engineId?: string }) => Promise<VoiceProfile[]>;
  saveVoiceProfile: (
    profile: VoiceProfile,
    options?: { isDefault?: boolean; engineId?: string }
  ) => Promise<VoiceProfile>;
  setDefaultNarrator: (id: string) => Promise<void>;
  renameVoice: (id: string, newName: string) => Promise<VoiceProfile>;
  duplicateVoice: (id: string, newName?: string) => Promise<VoiceProfile>;
  deleteVoiceProfile: (id: string) => Promise<void>;
  exportVoice: (id: string) => Promise<string>;
  importVoice: (
    input: string | unknown,
    options?: ImportVoiceProfileOptions
  ) => Promise<VoiceProfile>;
  clearInMemoryVoices: () => void;
}

export const useVoiceStore = create<VoiceStoreState>((set, get) => ({
  voices: [],
  defaultVoiceId: null,
  loading: false,
  error: null,

  loadVoices: async (filter) => {
    set({ loading: true, error: null });
    try {
      const [voices, defaults] = await Promise.all([
        listVoices(filter),
        listVoices({ isDefault: true }),
      ]);
      const defaultVoiceId = defaults[0]?.id ?? null;
      set({ voices, defaultVoiceId, loading: false });
      return voices;
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      set({ loading: false, error: message });
      throw err;
    }
  },

  saveVoiceProfile: async (profile, options) => {
    await saveVoice(profile, options);
    await get().loadVoices();
    return profile;
  },

  setDefaultNarrator: async (id) => {
    await setDefaultVoice(id);
    set({ defaultVoiceId: id });
    await get().loadVoices();
  },

  renameVoice: async (id, newName) => {
    const trimmed = newName.trim();
    if (!trimmed) {
      throw new Error('Voice profile name cannot be empty.');
    }
    const existing = await getVoice(id);
    if (!existing) {
      throw new Error(`Voice profile '${id}' not found.`);
    }
    const updated: VoiceProfile = {
      ...existing,
      name: trimmed,
      updatedAt: new Date().toISOString(),
    };
    await saveVoice(updated);
    await get().loadVoices();
    return updated;
  },

  duplicateVoice: async (id, newName) => {
    const existing = await getVoice(id);
    if (!existing) {
      throw new Error(`Voice profile '${id}' not found.`);
    }
    const now = new Date().toISOString();
    const copy: VoiceProfile = {
      ...existing,
      id: generateId('voice'),
      name: newName?.trim() || `${existing.name} (Copy)`,
      tags: [...existing.tags],
      referenceClip: { ...existing.referenceClip },
      qualityAnalysis: {
        ...existing.qualityAnalysis,
        clipping: { ...existing.qualityAnalysis.clipping },
        silence: { ...existing.qualityAnalysis.silence },
        reverbEstimate: { ...existing.qualityAnalysis.reverbEstimate },
        multiSpeakerEstimate: { ...existing.qualityAnalysis.multiSpeakerEstimate },
        warnings: [...existing.qualityAnalysis.warnings],
        recommendations: [...existing.qualityAnalysis.recommendations],
      },
      authorizedUse: { ...existing.authorizedUse },
      conditioningPayloads: cloneConditioningPayloads(existing.conditioningPayloads),
      createdAt: now,
      updatedAt: now,
    };
    await saveVoice(copy, { isDefault: false });
    await get().loadVoices();
    return copy;
  },

  deleteVoiceProfile: async (id) => {
    await deleteVoice(id);
    await get().loadVoices();
  },

  exportVoice: async (id) => {
    const existing = await getVoice(id);
    if (!existing) {
      throw new Error(`Voice profile '${id}' not found.`);
    }
    return await exportVoiceProfileJson(existing);
  },

  importVoice: async (input, options = {}) => {
    const result = await importVoiceProfile(input, {
      assignNewId: false,
      ...options,
    });
    const existing = await getVoice(result.profile.id);
    const profileToSave: VoiceProfile = existing
      ? {
          ...result.profile,
          id: generateId('voice'),
          updatedAt: new Date().toISOString(),
        }
      : result.profile;

    await saveVoice(profileToSave, { isDefault: false });
    await get().loadVoices();
    return profileToSave;
  },

  clearInMemoryVoices: () => {
    set({ voices: [], defaultVoiceId: null, error: null });
  },
}));
