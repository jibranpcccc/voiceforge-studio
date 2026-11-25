/**
 * Persistent Long-Form Narration Queue backed by IndexedDB (`projects` + `audioChunks`).
 *
 * Ensures long-form narration audio (30–60+ minutes) is streamed directly to IndexedDB
 * chunk-by-chunk rather than held in RAM, persists chunk statuses after every chunk for
 * crash/refresh recovery, supports pause/resume/cancel/retryFailed, and allows
 * single-chunk regeneration without re-synthesizing the entire project.
 */

import {
  EngineRegistry,
  defaultEngineRegistry,
} from '../engines/registry';
import {
  buildAudioChunkKey,
  getProject,
  getVoice,
  saveAudioChunk,
  saveProject,
} from '../storage/db';
import type {
  GenerationQueueState,
  LoadedVoiceHandle,
  NarrationProject,
  ScriptChunk,
  VoiceCloningEngine,
  VoiceProfile,
} from '../types';
import { extractEngineParametersForEngine } from './presets';
import { applyPronunciationRules } from './pronunciation';

export interface NarrationQueueOptions {
  registry?: EngineRegistry;
  onStateChange?: (state: GenerationQueueState) => void;
  onProjectUpdate?: (project: NarrationProject) => void;
  onChunkComplete?: (projectId: string, chunk: ScriptChunk) => void;
}

export interface RunQueueOptions {
  voiceProfile?: VoiceProfile;
  /** Skip pronunciation re-normalization if project chunks are already normalized. */
  preserveNormalizedText?: boolean;
}

function isAbortError(err: unknown): boolean {
  return (
    err instanceof Error &&
    (err.name === 'AbortError' || err.message.toLowerCase().includes('abort'))
  );
}

/**
 * Recover an interrupted project loaded from IndexedDB after a crash or browser refresh:
 * any chunk left in `'synthesizing'` or `'queued'` is reset to `'pending'` while
 * `'completed'` chunks (and their disk-backed `audioChunks`) are preserved untouched.
 */
export function recoverInterruptedProject(project: NarrationProject): NarrationProject {
  let changed = false;
  const chunks = project.chunks.map((chunk) => {
    if (chunk.status === 'synthesizing' || chunk.status === 'queued') {
      changed = true;
      return {
        ...chunk,
        status: 'pending' as const,
      };
    }
    return chunk;
  });

  if (!changed) return project;
  return {
    ...project,
    chunks,
    updatedAt: new Date().toISOString(),
  };
}

/**
 * Compute queue summary counts and real `estimatedRemainingSec` from measured
 * chunk generation timings (`null` until at least 1 chunk has completed with timing).
 */
export function computeQueueState(
  project: NarrationProject | null,
  runtime: {
    isRunning: boolean;
    isPaused: boolean;
    activeChunkId: string | null;
    measuredMsPerChar?: number | null;
    measuredMsPerChunk?: number | null;
  }
): GenerationQueueState {
  if (!project) {
    return {
      isRunning: runtime.isRunning,
      isPaused: runtime.isPaused,
      activeChunkId: runtime.activeChunkId,
      totalChunks: 0,
      completedChunks: 0,
      failedChunks: 0,
      estimatedRemainingSec: null,
    };
  }

  const totalChunks = project.chunks.length;
  let completedChunks = 0;
  let failedChunks = 0;
  let remainingChars = 0;
  let remainingChunks = 0;
  let completedTimingSumMs = 0;
  let completedTimingChars = 0;
  let completedTimingCount = 0;

  for (const chunk of project.chunks) {
    if (chunk.status === 'completed') {
      completedChunks += 1;
      if (
        typeof chunk.generationTimeMs === 'number' &&
        Number.isFinite(chunk.generationTimeMs) &&
        chunk.generationTimeMs > 0
      ) {
        completedTimingSumMs += chunk.generationTimeMs;
        completedTimingChars += Math.max(1, (chunk.normalizedText || chunk.rawText).length);
        completedTimingCount += 1;
      }
    } else if (chunk.status === 'failed') {
      failedChunks += 1;
    } else if (chunk.status === 'pending' || chunk.status === 'queued' || chunk.status === 'synthesizing') {
      remainingChunks += 1;
      remainingChars += Math.max(1, (chunk.normalizedText || chunk.rawText).length);
    }
  }

  let estimatedRemainingSec: number | null = null;
  if (remainingChunks === 0 && completedTimingCount > 0) {
    estimatedRemainingSec = 0;
  } else if (runtime.measuredMsPerChar && runtime.measuredMsPerChar > 0) {
    estimatedRemainingSec = (remainingChars * runtime.measuredMsPerChar) / 1000;
  } else if (runtime.measuredMsPerChunk && runtime.measuredMsPerChunk > 0) {
    estimatedRemainingSec = (remainingChunks * runtime.measuredMsPerChunk) / 1000;
  } else if (completedTimingCount > 0 && completedTimingChars > 0) {
    const msPerChar = completedTimingSumMs / completedTimingChars;
    estimatedRemainingSec = (remainingChars * msPerChar) / 1000;
  }

  return {
    isRunning: runtime.isRunning,
    isPaused: runtime.isPaused,
    activeChunkId: runtime.activeChunkId,
    totalChunks,
    completedChunks,
    failedChunks,
    estimatedRemainingSec,
  };
}

export class NarrationQueueService {
  private readonly registry: EngineRegistry;
  private readonly stateListeners = new Set<(state: GenerationQueueState) => void>();
  private readonly projectListeners = new Set<(project: NarrationProject) => void>();
  private readonly chunkListeners = new Set<(projectId: string, chunk: ScriptChunk) => void>();

  private isRunning = false;
  private isPaused = false;
  private pauseRequested = false;
  private cancelRequested = false;
  private activeChunkId: string | null = null;
  private activeProjectId: string | null = null;
  private activeAbortController: AbortController | null = null;
  private activeEngine: VoiceCloningEngine | null = null;

  private measuredTimingMsTotal = 0;
  private measuredCharsTotal = 0;
  private measuredChunksCount = 0;

  private state: GenerationQueueState = {
    isRunning: false,
    isPaused: false,
    activeChunkId: null,
    totalChunks: 0,
    completedChunks: 0,
    failedChunks: 0,
    estimatedRemainingSec: null,
  };

  constructor(options: NarrationQueueOptions = {}) {
    this.registry = options.registry ?? defaultEngineRegistry;
    if (options.onStateChange) this.stateListeners.add(options.onStateChange);
    if (options.onProjectUpdate) this.projectListeners.add(options.onProjectUpdate);
    if (options.onChunkComplete) this.chunkListeners.add(options.onChunkComplete);
  }

  subscribeState(listener: (state: GenerationQueueState) => void): () => void {
    this.stateListeners.add(listener);
    return () => {
      this.stateListeners.delete(listener);
    };
  }

  subscribeProject(listener: (project: NarrationProject) => void): () => void {
    this.projectListeners.add(listener);
    return () => {
      this.projectListeners.delete(listener);
    };
  }

  subscribeChunkComplete(
    listener: (projectId: string, chunk: ScriptChunk) => void
  ): () => void {
    this.chunkListeners.add(listener);
    return () => {
      this.chunkListeners.delete(listener);
    };
  }

  getState(): GenerationQueueState {
    return { ...this.state };
  }

  private emitState(project: NarrationProject | null): void {
    const measuredMsPerChar =
      this.measuredChunksCount > 0 && this.measuredCharsTotal > 0
        ? this.measuredTimingMsTotal / this.measuredCharsTotal
        : null;
    const measuredMsPerChunk =
      this.measuredChunksCount > 0
        ? this.measuredTimingMsTotal / this.measuredChunksCount
        : null;

    this.state = computeQueueState(project, {
      isRunning: this.isRunning,
      isPaused: this.isPaused,
      activeChunkId: this.activeChunkId,
      measuredMsPerChar,
      measuredMsPerChunk,
    });

    for (const listener of this.stateListeners) {
      listener(this.getState());
    }
  }

  private emitProject(project: NarrationProject): void {
    for (const listener of this.projectListeners) {
      listener(project);
    }
  }

  private emitChunkComplete(projectId: string, chunk: ScriptChunk): void {
    for (const listener of this.chunkListeners) {
      listener(projectId, chunk);
    }
  }

  private async resolveProject(projectOrId: string | NarrationProject): Promise<NarrationProject> {
    if (typeof projectOrId === 'string') {
      const loaded = await getProject(projectOrId);
      if (!loaded) {
        throw new Error(`Narration project '${projectOrId}' was not found in IndexedDB.`);
      }
      return loaded;
    }
    return projectOrId;
  }

  private async resolveVoiceProfile(
    project: NarrationProject,
    explicitProfile?: VoiceProfile
  ): Promise<VoiceProfile> {
    if (explicitProfile) return explicitProfile;
    if (!project.voiceProfileId) {
      throw new Error(`Project '${project.name}' does not have a selected VoiceProfile.`);
    }
    const stored = await getVoice(project.voiceProfileId);
    if (!stored) {
      throw new Error(
        `VoiceProfile '${project.voiceProfileId}' was not found in IndexedDB.`
      );
    }
    return stored;
  }

  private async persistAndNotify(project: NarrationProject): Promise<NarrationProject> {
    const updated: NarrationProject = {
      ...project,
      updatedAt: new Date().toISOString(),
    };
    const saved = await saveProject(updated);
    this.emitProject(saved);
    this.emitState(saved);
    return saved;
  }

  private resetTimingCounters(): void {
    this.measuredTimingMsTotal = 0;
    this.measuredCharsTotal = 0;
    this.measuredChunksCount = 0;
  }

  private seedTimingCountersFromProject(project: NarrationProject): void {
    this.resetTimingCounters();
    for (const chunk of project.chunks) {
      if (
        chunk.status === 'completed' &&
        typeof chunk.generationTimeMs === 'number' &&
        chunk.generationTimeMs > 0
      ) {
        this.measuredTimingMsTotal += chunk.generationTimeMs;
        this.measuredCharsTotal += Math.max(
          1,
          (chunk.normalizedText || chunk.rawText).length
        );
        this.measuredChunksCount += 1;
      }
    }
  }

  /**
   * Start (or restart pending chunks of) a narration project.
   */
  async startProject(
    projectOrId: string | NarrationProject,
    options: RunQueueOptions = {}
  ): Promise<NarrationProject> {
    const loaded = await this.resolveProject(projectOrId);
    const prepared: NarrationProject = {
      ...recoverInterruptedProject(loaded),
      chunks: loaded.chunks.map((chunk) => ({
        ...chunk,
        normalizedText:
          options.preserveNormalizedText && chunk.normalizedText
            ? chunk.normalizedText
            : applyPronunciationRules(chunk.rawText, loaded.pronunciationRules),
        status:
          chunk.status === 'completed'
            ? ('completed' as const)
            : ('queued' as const),
      })),
    };

    const saved = await this.persistAndNotify(prepared);
    return await this.runQueueLoop(saved, options);
  }

  /**
   * Resume an interrupted or paused project without re-synthesizing completed chunks.
   */
  async resume(
    projectOrId?: string | NarrationProject,
    options: RunQueueOptions = {}
  ): Promise<NarrationProject> {
    const targetId = projectOrId ?? this.activeProjectId;
    if (!targetId) {
      throw new Error('No active or specified project to resume.');
    }

    const loaded = await this.resolveProject(targetId);
    const recovered = recoverInterruptedProject(loaded);
    const orderedChunks = [...recovered.chunks].sort((a, b) => a.index - b.index);
    const prepared: NarrationProject = {
      ...recovered,
      chunks: orderedChunks.map((chunk) =>
        chunk.status === 'pending' ||
        chunk.status === 'cancelled' ||
        chunk.status === 'failed'
          ? {
              ...chunk,
              status: 'queued' as const,
              errorMessage: undefined,
            }
          : chunk
      ),
    };

    const saved = await this.persistAndNotify(prepared);
    return await this.runQueueLoop(saved, options);
  }

  /**
   * Retry only failed chunks in a project while keeping completed chunks intact.
   */
  async retryFailed(
    projectOrId: string | NarrationProject,
    options: RunQueueOptions = {}
  ): Promise<NarrationProject> {
    const loaded = await this.resolveProject(projectOrId);
    const prepared: NarrationProject = {
      ...loaded,
      chunks: loaded.chunks.map((chunk) =>
        chunk.status === 'failed'
          ? { ...chunk, status: 'queued' as const, errorMessage: undefined }
          : chunk
      ),
    };

    const saved = await this.persistAndNotify(prepared);
    return await this.runQueueLoop(saved, options);
  }

  /**
   * Pause queue execution cleanly after the current active chunk finishes.
   */
  pause(): void {
    if (!this.isRunning) return;
    this.pauseRequested = true;
    this.isPaused = true;
    for (const listener of this.stateListeners) {
      listener(this.getState());
    }
  }

  /**
   * Cancel queue execution immediately, aborting the active synthesis call
   * and marking any unfinished chunks as `'cancelled'`.
   */
  async cancel(): Promise<void> {
    this.cancelRequested = true;
    this.pauseRequested = false;
    this.isPaused = false;
    this.activeAbortController?.abort();

    if (this.activeEngine) {
      try {
        await this.activeEngine.cancel();
      } catch {
        // Ignore engine cancel errors during shutdown.
      }
    }

    if (this.activeProjectId && !this.isRunning) {
      const existing = await getProject(this.activeProjectId);
      if (existing) {
        await this.markRemainingCancelled(existing);
      }
    }
  }

  private async markRemainingCancelled(project: NarrationProject): Promise<NarrationProject> {
    const cancelledProject: NarrationProject = {
      ...project,
      chunks: project.chunks.map((chunk) =>
        chunk.status === 'pending' ||
        chunk.status === 'queued' ||
        chunk.status === 'synthesizing'
          ? { ...chunk, status: 'cancelled' as const }
          : chunk
      ),
    };
    return await this.persistAndNotify(cancelledProject);
  }

  /**
   * Re-synthesize ONLY a single chunk by `chunkId` (with optional text or parameter overrides)
   * without altering or re-running any other completed chunks in the project.
   */
  async regenerateChunk(
    projectOrId: string | NarrationProject,
    chunkId: string,
    overrides?: {
      rawText?: string;
      pauseAfterMs?: number;
      parameterOverrides?: Record<string, number | string | boolean>;
      voiceProfile?: VoiceProfile;
    }
  ): Promise<NarrationProject> {
    if (this.isRunning) {
      throw new Error('Cannot regenerate an individual chunk while the project queue is running.');
    }

    let project = await this.resolveProject(projectOrId);
    const targetIndex = project.chunks.findIndex((c) => c.id === chunkId);
    if (targetIndex === -1) {
      throw new Error(`Chunk '${chunkId}' not found in project '${project.id}'.`);
    }

    const engine = this.registry.require(project.engineId);
    const voiceProfile = await this.resolveVoiceProfile(project, overrides?.voiceProfile);
    const voiceHandle = await this.registry.loadVoiceProfileForEngine(
      project.engineId,
      voiceProfile
    );

    const existingChunk = project.chunks[targetIndex];
    const nextRawText = overrides?.rawText ?? existingChunk.rawText;
    const nextNormalizedText = applyPronunciationRules(
      nextRawText,
      project.pronunciationRules
    );
    const nextParamOverrides =
      overrides?.parameterOverrides ?? existingChunk.parameterOverrides;
    const nextPauseAfterMs = overrides?.pauseAfterMs ?? existingChunk.pauseAfterMs;

    this.isRunning = true;
    this.isPaused = false;
    this.pauseRequested = false;
    this.cancelRequested = false;
    this.activeProjectId = project.id;
    this.activeChunkId = chunkId;
    this.activeEngine = engine;
    this.activeAbortController = new AbortController();
    this.seedTimingCountersFromProject(project);

    try {
      project = await this.persistAndNotify({
        ...project,
        chunks: project.chunks.map((c, idx) =>
          idx === targetIndex
            ? {
                ...c,
                rawText: nextRawText,
                normalizedText: nextNormalizedText,
                pauseAfterMs: nextPauseAfterMs,
                ...(nextParamOverrides ? { parameterOverrides: { ...nextParamOverrides } } : {}),
                status: 'synthesizing' as const,
                errorMessage: undefined,
              }
            : c
        ),
      });

      const mergedParams = extractEngineParametersForEngine(
        {
          ...project.engineParameters,
          ...nextParamOverrides,
        },
        project.engineId
      );

      const result = await engine.synthesize({
        text: nextNormalizedText,
        voiceHandle,
        language: voiceProfile.language || 'en',
        parameters: mergedParams,
        signal: this.activeAbortController.signal,
      });

      await saveAudioChunk({
        projectId: project.id,
        chunkId,
        sampleRate: result.audio.sampleRate,
        pcm: result.audio.samples,
        durationSec: result.audio.durationSec,
      });

      const completedChunk: ScriptChunk = {
        ...project.chunks[targetIndex],
        status: 'completed',
        audioDurationSec: result.audio.durationSec,
        cachedAudioKey: buildAudioChunkKey(project.id, chunkId),
        generationTimeMs: result.generationTimeMs,
        errorMessage: undefined,
      };

      project = await this.persistAndNotify({
        ...project,
        chunks: project.chunks.map((c, idx) => (idx === targetIndex ? completedChunk : c)),
      });
      this.emitChunkComplete(project.id, completedChunk);
      return project;
    } catch (err) {
      const status = isAbortError(err) ? ('cancelled' as const) : ('failed' as const);
      project = await this.persistAndNotify({
        ...project,
        chunks: project.chunks.map((c, idx) =>
          idx === targetIndex
            ? {
                ...c,
                status,
                errorMessage: err instanceof Error ? err.message : String(err),
              }
            : c
        ),
      });
      if (status === 'failed') {
        throw err;
      }
      return project;
    } finally {
      this.isRunning = false;
      this.activeChunkId = null;
      this.activeAbortController = null;
      this.activeEngine = null;
      this.emitState(project);
    }
  }

  private async runQueueLoop(
    initialProject: NarrationProject,
    options: RunQueueOptions
  ): Promise<NarrationProject> {
    if (this.isRunning) {
      throw new Error('NarrationQueueService is already running a job.');
    }

    let project = initialProject;
    const engine = this.registry.require(project.engineId);
    const voiceProfile = await this.resolveVoiceProfile(project, options.voiceProfile);
    const voiceHandle: LoadedVoiceHandle = await this.registry.loadVoiceProfileForEngine(
      project.engineId,
      voiceProfile
    );

    this.isRunning = true;
    this.isPaused = false;
    this.pauseRequested = false;
    this.cancelRequested = false;
    this.activeProjectId = project.id;
    this.activeEngine = engine;
    this.activeAbortController = new AbortController();
    this.seedTimingCountersFromProject(project);
    this.emitState(project);

    try {
      for (let i = 0; i < project.chunks.length; i += 1) {
        if (this.cancelRequested) {
          project = await this.markRemainingCancelled(project);
          break;
        }

        if (this.pauseRequested) {
          project = await this.persistAndNotify({
            ...project,
            chunks: project.chunks.map((c) =>
              c.status === 'queued' ? { ...c, status: 'pending' as const } : c
            ),
          });
          break;
        }

        const targetChunk = project.chunks[i];
        if (targetChunk.status === 'completed' || targetChunk.status === 'failed') {
          continue;
        }

        this.activeChunkId = targetChunk.id;
        project = await this.persistAndNotify({
          ...project,
          chunks: project.chunks.map((c, idx) =>
            idx === i
              ? { ...c, status: 'synthesizing' as const, errorMessage: undefined }
              : c
          ),
        });

        const textToSynthesize =
          targetChunk.normalizedText ||
          applyPronunciationRules(targetChunk.rawText, project.pronunciationRules);

        const mergedParameters = extractEngineParametersForEngine(
          {
            ...project.engineParameters,
            ...targetChunk.parameterOverrides,
          },
          project.engineId
        );

        try {
          const result = await engine.synthesize({
            text: textToSynthesize,
            voiceHandle,
            language: voiceProfile.language || 'en',
            parameters: mergedParameters,
            signal: this.activeAbortController.signal,
          });

          // Write PCM audio immediately to IndexedDB (`audioChunks`) instead of keeping in RAM.
          await saveAudioChunk({
            projectId: project.id,
            chunkId: targetChunk.id,
            sampleRate: result.audio.sampleRate,
            pcm: result.audio.samples,
            durationSec: result.audio.durationSec,
          });

          const genTimeMs =
            typeof result.generationTimeMs === 'number' && result.generationTimeMs > 0
              ? result.generationTimeMs
              : 1;
          this.measuredTimingMsTotal += genTimeMs;
          this.measuredCharsTotal += Math.max(1, textToSynthesize.length);
          this.measuredChunksCount += 1;

          const completedChunk: ScriptChunk = {
            ...project.chunks[i],
            status: 'completed',
            audioDurationSec: result.audio.durationSec,
            cachedAudioKey: buildAudioChunkKey(project.id, targetChunk.id),
            generationTimeMs: result.generationTimeMs,
            errorMessage: undefined,
          };

          project = await this.persistAndNotify({
            ...project,
            chunks: project.chunks.map((c, idx) => (idx === i ? completedChunk : c)),
          });
          this.emitChunkComplete(project.id, completedChunk);
        } catch (err) {
          if (this.cancelRequested || isAbortError(err)) {
            project = await this.markRemainingCancelled(project);
            break;
          }

          project = await this.persistAndNotify({
            ...project,
            chunks: project.chunks.map((c, idx) =>
              idx === i
                ? {
                    ...c,
                    status: 'failed' as const,
                    errorMessage: err instanceof Error ? err.message : String(err),
                  }
                : c
            ),
          });
        }
      }

      if (this.pauseRequested && !this.cancelRequested) {
        project = await this.persistAndNotify({
          ...project,
          chunks: project.chunks.map((c) =>
            c.status === 'queued' ? { ...c, status: 'pending' as const } : c
          ),
        });
      }

      return project;
    } finally {
      this.isRunning = false;
      this.activeChunkId = null;
      this.activeAbortController = null;
      this.activeEngine = null;
      if (!this.pauseRequested) {
        this.isPaused = false;
      }
      this.emitState(project);
    }
  }
}

export const narrationQueue = new NarrationQueueService();
