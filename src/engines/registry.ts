/**
 * EngineRegistry: manages registered VoiceCloningEngine implementations,
 * queries hardware compatibility, and enforces strict engine/revision scoping
 * for VoiceConditioningPayload and LoadedVoiceHandle objects.
 */

import type {
  EngineId,
  HardwareCompatibilityReport,
  LoadedVoiceHandle,
  VoiceCloningEngine,
  VoiceConditioningPayload,
  VoiceProfile,
} from '../types';
import { ChatterboxEngine, type ChatterboxEngineOptions } from './chatterbox';
import { PocketTtsEngine, type PocketTtsEngineOptions } from './pocket';

export class EngineConditioningMismatchError extends Error {
  readonly expectedEngineId: string;
  readonly expectedRevision: string;
  readonly availableKeys: string[];

  constructor(
    message: string,
    expectedEngineId: string,
    expectedRevision: string,
    availableKeys: string[] = []
  ) {
    super(message);
    this.name = 'EngineConditioningMismatchError';
    this.expectedEngineId = expectedEngineId;
    this.expectedRevision = expectedRevision;
    this.availableKeys = availableKeys;
  }
}

/**
 * Build the canonical conditioning payload map key `${engineId}::${modelRevision}`.
 */
export function buildConditioningPayloadKey(
  engineId: string,
  modelRevision: string
): string {
  return `${engineId}::${modelRevision}`;
}

/**
 * Retrieve the conditioning payload matching an engine's exact `id` and `modelRevision`.
 * Returns `null` if missing or if any cross-engine / cross-revision mismatch exists.
 */
export function getCompatibleConditioningPayload(
  profile: VoiceProfile,
  engine: Pick<VoiceCloningEngine, 'id' | 'getModelMetadata'>
): VoiceConditioningPayload | null {
  const { modelRevision } = engine.getModelMetadata();
  const key = buildConditioningPayloadKey(engine.id, modelRevision);
  const payload = profile.conditioningPayloads[key];

  if (!payload) {
    return null;
  }

  if (payload.engineId !== engine.id || payload.modelRevision !== modelRevision) {
    return null;
  }

  return payload;
}

/**
 * Assert that `profile` contains a valid conditioning payload scoped strictly to
 * `engine.id` and `engine.getModelMetadata().modelRevision`.
 */
export function assertCompatibleConditioningPayload(
  profile: VoiceProfile,
  engine: Pick<VoiceCloningEngine, 'id' | 'getModelMetadata'>
): VoiceConditioningPayload {
  const { modelRevision } = engine.getModelMetadata();
  const key = buildConditioningPayloadKey(engine.id, modelRevision);
  const candidate = profile.conditioningPayloads[key];

  if (!candidate) {
    const availableKeys = Object.keys(profile.conditioningPayloads);
    throw new EngineConditioningMismatchError(
      `Voice profile '${profile.name}' (${profile.id}) has no conditioning payload for ${key}` +
        (availableKeys.length > 0
          ? ` (available: ${availableKeys.join(', ')})`
          : ''),
      engine.id,
      modelRevision,
      availableKeys
    );
  }

  if (candidate.engineId !== engine.id || candidate.modelRevision !== modelRevision) {
    throw new EngineConditioningMismatchError(
      `Conditioning payload under key '${key}' is tagged with '${candidate.engineId}::${candidate.modelRevision}', which does not match target engine '${key}'`,
      engine.id,
      modelRevision,
      Object.keys(profile.conditioningPayloads)
    );
  }

  return candidate;
}

/**
 * Verify that a `LoadedVoiceHandle` belongs to the exact target engine and pinned revision.
 */
export function validateVoiceHandleForEngine(
  handle: LoadedVoiceHandle,
  engine: Pick<VoiceCloningEngine, 'id' | 'getModelMetadata'>
): void {
  const { modelRevision } = engine.getModelMetadata();
  if (handle.engineId !== engine.id || handle.modelRevision !== modelRevision) {
    throw new EngineConditioningMismatchError(
      `LoadedVoiceHandle '${handle.handleId}' is scoped to '${handle.engineId}::${handle.modelRevision}' and cannot be used with '${engine.id}::${modelRevision}'`,
      engine.id,
      modelRevision
    );
  }
}

export class EngineRegistry {
  private readonly engines = new Map<EngineId, VoiceCloningEngine>();

  /**
   * Register a `VoiceCloningEngine` instance.
   */
  register(engine: VoiceCloningEngine, options: { replace?: boolean } = {}): void {
    if (!options.replace && this.engines.has(engine.id)) {
      throw new Error(`Engine '${engine.id}' is already registered.`);
    }
    this.engines.set(engine.id, engine);
  }

  /**
   * Unregister an engine by ID without automatically disposing it.
   */
  unregister(engineId: EngineId): boolean {
    return this.engines.delete(engineId);
  }

  /**
   * Look up a registered engine by ID.
   */
  get(engineId: EngineId): VoiceCloningEngine | undefined {
    return this.engines.get(engineId);
  }

  /**
   * Retrieve a registered engine or throw if missing.
   */
  require(engineId: EngineId): VoiceCloningEngine {
    const engine = this.engines.get(engineId);
    if (!engine) {
      throw new Error(`Voice cloning engine '${engineId}' is not registered.`);
    }
    return engine;
  }

  has(engineId: EngineId): boolean {
    return this.engines.has(engineId);
  }

  list(): VoiceCloningEngine[] {
    return Array.from(this.engines.values());
  }

  /**
   * Query hardware compatibility for a specific registered engine.
   */
  async checkCompatibility(engineId: EngineId): Promise<HardwareCompatibilityReport> {
    const engine = this.require(engineId);
    return await engine.checkHardwareCompatibility();
  }

  /**
   * Query hardware compatibility across all registered engines.
   */
  async checkCompatibilityAll(): Promise<HardwareCompatibilityReport[]> {
    const entries = this.list();
    return await Promise.all(
      entries.map((engine) => engine.checkHardwareCompatibility())
    );
  }

  /**
   * Select the best compatible engine, prioritizing `preferredEngineId` when compatible.
   */
  async selectBestEngine(
    preferredEngineId?: EngineId
  ): Promise<{ engine: VoiceCloningEngine; report: HardwareCompatibilityReport } | null> {
    const engines = this.list();
    if (engines.length === 0) return null;

    if (preferredEngineId && this.engines.has(preferredEngineId)) {
      const preferred = this.require(preferredEngineId);
      const report = await preferred.checkHardwareCompatibility();
      if (report.compatible) {
        return { engine: preferred, report };
      }
    }

    for (const engine of engines) {
      if (engine.id === preferredEngineId) continue;
      const report = await engine.checkHardwareCompatibility();
      if (report.compatible) {
        return { engine, report };
      }
    }

    return null;
  }

  /**
   * Check whether `profile` already has a valid conditioning payload for `engineId`.
   */
  isProfileReadyForEngine(profile: VoiceProfile, engineId: EngineId): boolean {
    const engine = this.engines.get(engineId);
    if (!engine) return false;
    return getCompatibleConditioningPayload(profile, engine) !== null;
  }

  /**
   * Enforce strict engine/revision scoping before delegating to `engine.loadVoiceProfile()`,
   * and verify the returned `LoadedVoiceHandle` matches.
   */
  async loadVoiceProfileForEngine(
    engineId: EngineId,
    profile: VoiceProfile
  ): Promise<LoadedVoiceHandle> {
    const engine = this.require(engineId);
    assertCompatibleConditioningPayload(profile, engine);
    const handle = await engine.loadVoiceProfile(profile);
    validateVoiceHandleForEngine(handle, engine);
    return handle;
  }

  /**
   * Dispose all registered engines and clear the registry.
   */
  async disposeAll(): Promise<void> {
    const engines = this.list();
    await Promise.all(engines.map((engine) => engine.dispose()));
    this.engines.clear();
  }

  clear(): void {
    this.engines.clear();
  }
}

export interface DefaultEngineRegistryOptions {
  pocket?: PocketTtsEngineOptions;
  chatterbox?: ChatterboxEngineOptions;
}

/**
 * Create a new `EngineRegistry` populated with the built-in VoiceForge engines
 * (`pocket-tts` and `chatterbox`).
 */
export function createDefaultEngineRegistry(
  options: DefaultEngineRegistryOptions = {}
): EngineRegistry {
  const registry = new EngineRegistry();
  registry.register(new PocketTtsEngine(options.pocket));
  registry.register(new ChatterboxEngine(options.chatterbox));
  return registry;
}

export const defaultEngineRegistry = new EngineRegistry();
