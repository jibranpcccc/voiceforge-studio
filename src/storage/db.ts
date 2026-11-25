/**
 * IndexedDB persistence layer (`voiceforge-db`) built on `idb`.
 *
 * Keeps `NarrationProject` records lightweight by storing synthesized chunk PCM
 * blobs separately in `audioChunks` keyed by `${projectId}::${chunkId}`.
 */

import { openDB, type DBSchema, type IDBPDatabase } from 'idb';
import type {
  NarrationProject,
  PronunciationRule,
  VoiceProfile,
} from '../types';
import { clearAllModelCaches } from './modelCache';

export const VOICEFORGE_DB_NAME = 'voiceforge-db';
export const VOICEFORGE_DB_VERSION = 1;

export interface AudioChunkRecord {
  key: string;
  projectId: string;
  chunkId: string;
  sampleRate: number;
  pcmBytes: ArrayBuffer;
  durationSec: number;
  createdAt: string;
}

export interface GenerationHistoryEntry {
  id: string;
  text: string;
  voiceProfileId: string;
  voiceName: string;
  engineId: string;
  modelRevision: string;
  language: string;
  parameters: Record<string, number | string | boolean>;
  sampleRate: number;
  durationSec: number;
  generationTimeMs: number;
  realTimeFactor: number;
  audioBytes?: ArrayBuffer;
  createdAt: string;
}

export interface AudioLabRunVariant {
  label: string;
  engineId: string;
  modelRevision: string;
  executionMode: string;
  parameters: Record<string, number | string | boolean>;
  sampleRate: number;
  durationSec: number;
  generationTimeMs: number;
  realTimeFactor: number;
  audioBytes?: ArrayBuffer;
}

export interface AudioLabRunRecord {
  id: string;
  title: string;
  text: string;
  voiceProfileId: string;
  variants: AudioLabRunVariant[];
  preferredVariantLabel?: string;
  notes?: string;
  createdAt: string;
}

/**
 * Stored representation of a `VoiceProfile` with numeric/string index helper keys
 * compatible with native browser IndexedDB key rules (no boolean IDB keys).
 */
export interface StoredVoiceRecord extends VoiceProfile {
  /** Numeric flag (1 | 0) backing the `isDefault` IndexedDB index. */
  isDefaultKey: 0 | 1;
  /** Primary engine ID backing the `engineId` IndexedDB index. */
  primaryEngineId: string;
}

export interface VoiceForgeDBSchema extends DBSchema {
  voices: {
    key: string;
    value: StoredVoiceRecord;
    indexes: {
      createdAt: string;
      isDefault: number;
      engineId: string;
    };
  };
  projects: {
    key: string;
    value: NarrationProject;
    indexes: {
      updatedAt: string;
      createdAt: string;
      engineId: string;
    };
  };
  audioChunks: {
    key: string;
    value: AudioChunkRecord;
    indexes: {
      projectId: string;
      createdAt: string;
    };
  };
  pronunciationRules: {
    key: string;
    value: PronunciationRule;
    indexes: {
      pattern: string;
    };
  };
  history: {
    key: string;
    value: GenerationHistoryEntry;
    indexes: {
      createdAt: string;
      engineId: string;
      voiceProfileId: string;
    };
  };
  labRuns: {
    key: string;
    value: AudioLabRunRecord;
    indexes: {
      createdAt: string;
      voiceProfileId: string;
    };
  };
}

let dbPromise: Promise<IDBPDatabase<VoiceForgeDBSchema>> | null = null;

/**
 * Open (or return cached) `voiceforge-db` IndexedDB connection.
 */
export async function getDb(): Promise<IDBPDatabase<VoiceForgeDBSchema>> {
  if (!dbPromise) {
    dbPromise = openDB<VoiceForgeDBSchema>(VOICEFORGE_DB_NAME, VOICEFORGE_DB_VERSION, {
      upgrade(db) {
        if (!db.objectStoreNames.contains('voices')) {
          const voiceStore = db.createObjectStore('voices', { keyPath: 'id' });
          voiceStore.createIndex('createdAt', 'createdAt');
          voiceStore.createIndex('isDefault', 'isDefaultKey');
          voiceStore.createIndex('engineId', 'primaryEngineId');
        }

        if (!db.objectStoreNames.contains('projects')) {
          const projectStore = db.createObjectStore('projects', { keyPath: 'id' });
          projectStore.createIndex('updatedAt', 'updatedAt');
          projectStore.createIndex('createdAt', 'createdAt');
          projectStore.createIndex('engineId', 'engineId');
        }

        if (!db.objectStoreNames.contains('audioChunks')) {
          const chunkStore = db.createObjectStore('audioChunks', { keyPath: 'key' });
          chunkStore.createIndex('projectId', 'projectId');
          chunkStore.createIndex('createdAt', 'createdAt');
        }

        if (!db.objectStoreNames.contains('pronunciationRules')) {
          const ruleStore = db.createObjectStore('pronunciationRules', { keyPath: 'id' });
          ruleStore.createIndex('pattern', 'pattern');
        }

        if (!db.objectStoreNames.contains('history')) {
          const historyStore = db.createObjectStore('history', { keyPath: 'id' });
          historyStore.createIndex('createdAt', 'createdAt');
          historyStore.createIndex('engineId', 'engineId');
          historyStore.createIndex('voiceProfileId', 'voiceProfileId');
        }

        if (!db.objectStoreNames.contains('labRuns')) {
          const labStore = db.createObjectStore('labRuns', { keyPath: 'id' });
          labStore.createIndex('createdAt', 'createdAt');
          labStore.createIndex('voiceProfileId', 'voiceProfileId');
        }
      },
    });
  }
  return dbPromise;
}

/**
 * Close the cached IndexedDB connection (useful in tests or database resets).
 */
export async function closeDb(): Promise<void> {
  if (!dbPromise) return;
  const db = await dbPromise;
  db.close();
  dbPromise = null;
}

export function buildAudioChunkKey(projectId: string, chunkId: string): string {
  return `${projectId}::${chunkId}`;
}

function inferPrimaryEngineId(profile: VoiceProfile, explicitEngineId?: string): string {
  if (explicitEngineId) return explicitEngineId;
  const firstPayload = Object.values(profile.conditioningPayloads)[0];
  if (firstPayload?.engineId) return firstPayload.engineId;
  const firstKey = Object.keys(profile.conditioningPayloads)[0];
  if (firstKey && firstKey.includes('::')) {
    return firstKey.split('::')[0];
  }
  return 'unassigned';
}

function stripVoiceIndexFields(record: StoredVoiceRecord): VoiceProfile {
  const { isDefaultKey: _isDefaultKey, primaryEngineId: _primaryEngineId, ...profile } = record;
  void _isDefaultKey;
  void _primaryEngineId;
  return profile;
}

function sanitizeProjectForStorage(project: NarrationProject): NarrationProject {
  return {
    ...project,
    chunks: project.chunks.map((chunk) => ({
      id: chunk.id,
      index: chunk.index,
      rawText: chunk.rawText,
      normalizedText: chunk.normalizedText,
      pauseAfterMs: chunk.pauseAfterMs,
      ...(chunk.parameterOverrides ? { parameterOverrides: { ...chunk.parameterOverrides } } : {}),
      status: chunk.status,
      ...(chunk.audioDurationSec !== undefined ? { audioDurationSec: chunk.audioDurationSec } : {}),
      ...(chunk.cachedAudioKey !== undefined ? { cachedAudioKey: chunk.cachedAudioKey } : {}),
      ...(chunk.generationTimeMs !== undefined ? { generationTimeMs: chunk.generationTimeMs } : {}),
      ...(chunk.errorMessage !== undefined ? { errorMessage: chunk.errorMessage } : {}),
    })),
  };
}

// ---------------------------------------------------------------------------
// Voices CRUD
// ---------------------------------------------------------------------------

export async function saveVoice(
  profile: VoiceProfile,
  options: { isDefault?: boolean; engineId?: string } = {}
): Promise<VoiceProfile> {
  const db = await getDb();
  const existing = await db.get('voices', profile.id);
  const isDefaultKey: 0 | 1 =
    options.isDefault !== undefined
      ? options.isDefault
        ? 1
        : 0
      : existing?.isDefaultKey ?? 0;

  const record: StoredVoiceRecord = {
    ...profile,
    isDefaultKey,
    primaryEngineId: inferPrimaryEngineId(profile, options.engineId),
  };
  await db.put('voices', record);
  return profile;
}

export async function getVoice(id: string): Promise<VoiceProfile | undefined> {
  const db = await getDb();
  const record = await db.get('voices', id);
  return record ? stripVoiceIndexFields(record) : undefined;
}

export async function listVoices(filter?: {
  engineId?: string;
  isDefault?: boolean;
}): Promise<VoiceProfile[]> {
  const db = await getDb();
  let records: StoredVoiceRecord[];

  if (filter?.isDefault !== undefined) {
    records = await db.getAllFromIndex('voices', 'isDefault', filter.isDefault ? 1 : 0);
  } else if (filter?.engineId) {
    records = await db.getAllFromIndex('voices', 'engineId', filter.engineId);
  } else {
    records = await db.getAllFromIndex('voices', 'createdAt');
  }

  if (filter?.engineId && filter.isDefault !== undefined) {
    records = records.filter(
      (r) =>
        r.primaryEngineId === filter.engineId ||
        Object.values(r.conditioningPayloads).some((p) => p.engineId === filter.engineId)
    );
  }

  return records
    .sort((a, b) => b.createdAt.localeCompare(a.createdAt))
    .map(stripVoiceIndexFields);
}

export async function setDefaultVoice(id: string): Promise<void> {
  const db = await getDb();
  const tx = db.transaction('voices', 'readwrite');
  const all = await tx.store.getAll();
  for (const record of all) {
    const nextKey: 0 | 1 = record.id === id ? 1 : 0;
    if (record.isDefaultKey !== nextKey) {
      await tx.store.put({ ...record, isDefaultKey: nextKey });
    }
  }
  await tx.done;
}

export async function deleteVoice(id: string): Promise<void> {
  const db = await getDb();
  await db.delete('voices', id);
}

// ---------------------------------------------------------------------------
// Projects CRUD
// ---------------------------------------------------------------------------

export async function saveProject(project: NarrationProject): Promise<NarrationProject> {
  const db = await getDb();
  const sanitized = sanitizeProjectForStorage(project);
  await db.put('projects', sanitized);
  return sanitized;
}

export async function getProject(id: string): Promise<NarrationProject | undefined> {
  const db = await getDb();
  return await db.get('projects', id);
}

export async function listProjects(): Promise<NarrationProject[]> {
  const db = await getDb();
  const projects = await db.getAllFromIndex('projects', 'updatedAt');
  return projects.sort((a, b) => b.updatedAt.localeCompare(a.updatedAt));
}

export async function deleteProject(id: string): Promise<void> {
  const db = await getDb();
  const tx = db.transaction(['projects', 'audioChunks'], 'readwrite');
  await tx.objectStore('projects').delete(id);

  const chunkIndex = tx.objectStore('audioChunks').index('projectId');
  let cursor = await chunkIndex.openCursor(id);
  while (cursor) {
    await cursor.delete();
    cursor = await cursor.continue();
  }
  await tx.done;
}

// ---------------------------------------------------------------------------
// Disk-backed Audio Chunks CRUD
// ---------------------------------------------------------------------------

export async function saveAudioChunk(input: {
  projectId: string;
  chunkId: string;
  sampleRate: number;
  pcm: Float32Array | ArrayBuffer;
  durationSec: number;
  createdAt?: string;
}): Promise<AudioChunkRecord> {
  const db = await getDb();
  const pcmBytes =
    input.pcm instanceof Float32Array
      ? input.pcm.buffer.slice(
          input.pcm.byteOffset,
          input.pcm.byteOffset + input.pcm.byteLength
        )
      : input.pcm;

  const record: AudioChunkRecord = {
    key: buildAudioChunkKey(input.projectId, input.chunkId),
    projectId: input.projectId,
    chunkId: input.chunkId,
    sampleRate: input.sampleRate,
    pcmBytes: pcmBytes as ArrayBuffer,
    durationSec: input.durationSec,
    createdAt: input.createdAt ?? new Date().toISOString(),
  };

  await db.put('audioChunks', record);
  return record;
}

export async function getAudioChunk(
  projectId: string,
  chunkId: string
): Promise<AudioChunkRecord | undefined> {
  return await getAudioChunkByKey(buildAudioChunkKey(projectId, chunkId));
}

export async function getAudioChunkByKey(
  key: string
): Promise<AudioChunkRecord | undefined> {
  const db = await getDb();
  return await db.get('audioChunks', key);
}

export async function listProjectAudioChunks(
  projectId: string
): Promise<AudioChunkRecord[]> {
  const db = await getDb();
  return await db.getAllFromIndex('audioChunks', 'projectId', projectId);
}

export async function deleteAudioChunk(
  projectId: string,
  chunkId: string
): Promise<void> {
  const db = await getDb();
  await db.delete('audioChunks', buildAudioChunkKey(projectId, chunkId));
}

export async function deleteProjectAudioChunks(projectId: string): Promise<void> {
  const db = await getDb();
  const tx = db.transaction('audioChunks', 'readwrite');
  const index = tx.store.index('projectId');
  let cursor = await index.openCursor(projectId);
  while (cursor) {
    await cursor.delete();
    cursor = await cursor.continue();
  }
  await tx.done;
}

// ---------------------------------------------------------------------------
// Pronunciation Rules CRUD
// ---------------------------------------------------------------------------

export async function savePronunciationRule(
  rule: PronunciationRule
): Promise<PronunciationRule> {
  const db = await getDb();
  await db.put('pronunciationRules', rule);
  return rule;
}

export async function getPronunciationRule(
  id: string
): Promise<PronunciationRule | undefined> {
  const db = await getDb();
  return await db.get('pronunciationRules', id);
}

export async function listPronunciationRules(): Promise<PronunciationRule[]> {
  const db = await getDb();
  return await db.getAll('pronunciationRules');
}

export async function deletePronunciationRule(id: string): Promise<void> {
  const db = await getDb();
  await db.delete('pronunciationRules', id);
}

// ---------------------------------------------------------------------------
// Generation History CRUD
// ---------------------------------------------------------------------------

export async function saveHistoryEntry(
  entry: GenerationHistoryEntry
): Promise<GenerationHistoryEntry> {
  const db = await getDb();
  await db.put('history', entry);
  return entry;
}

export async function getHistoryEntry(
  id: string
): Promise<GenerationHistoryEntry | undefined> {
  const db = await getDb();
  return await db.get('history', id);
}

export async function listHistoryEntries(limit?: number): Promise<GenerationHistoryEntry[]> {
  const db = await getDb();
  const entries = await db.getAllFromIndex('history', 'createdAt');
  entries.sort((a, b) => b.createdAt.localeCompare(a.createdAt));
  return limit !== undefined ? entries.slice(0, limit) : entries;
}

export async function deleteHistoryEntry(id: string): Promise<void> {
  const db = await getDb();
  await db.delete('history', id);
}

// ---------------------------------------------------------------------------
// Audio Lab Runs CRUD
// ---------------------------------------------------------------------------

export async function saveLabRun(run: AudioLabRunRecord): Promise<AudioLabRunRecord> {
  const db = await getDb();
  await db.put('labRuns', run);
  return run;
}

export async function getLabRun(id: string): Promise<AudioLabRunRecord | undefined> {
  const db = await getDb();
  return await db.get('labRuns', id);
}

export async function listLabRuns(limit?: number): Promise<AudioLabRunRecord[]> {
  const db = await getDb();
  const runs = await db.getAllFromIndex('labRuns', 'createdAt');
  runs.sort((a, b) => b.createdAt.localeCompare(a.createdAt));
  return limit !== undefined ? runs.slice(0, limit) : runs;
}

export async function deleteLabRun(id: string): Promise<void> {
  const db = await getDb();
  await db.delete('labRuns', id);
}

// ---------------------------------------------------------------------------
// Global Reset
// ---------------------------------------------------------------------------

/**
 * Wipe all locally stored user data: all IndexedDB object stores in `voiceforge-db`,
 * all cached model weights/artifacts, and all `localStorage` preferences.
 */
export async function clearAllUserData(): Promise<void> {
  const db = await getDb();
  const storeNames = [
    'voices',
    'projects',
    'audioChunks',
    'pronunciationRules',
    'history',
    'labRuns',
  ] as const;

  const tx = db.transaction([...storeNames], 'readwrite');
  for (const name of storeNames) {
    await tx.objectStore(name).clear();
  }
  await tx.done;

  await clearAllModelCaches();

  if (typeof globalThis.localStorage !== 'undefined') {
    try {
      globalThis.localStorage.clear();
    } catch {
      // Ignore storage access restrictions.
    }
  }
}
