import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it, vi } from 'vitest';
import {
  EngineConditioningMismatchError,
  EngineRegistry,
  assertCompatibleConditioningPayload,
  buildConditioningPayloadKey,
  createDefaultEngineRegistry,
  getCompatibleConditioningPayload,
  validateVoiceHandleForEngine,
} from '../src/engines/registry';
import { getChatterboxManifestEntry } from '../src/engines/chatterbox';
import {
  ManifestValidationError,
  getModelManifestEntry,
  registerManifestEntry,
  resolveArtifactUrl,
  resolveEntryArtifactUrls,
  safeValidateManifest,
  validateManifest,
} from '../src/models/manifest';
import {
  buildEngineCompatibilityReport,
  detectHardwareCapabilities,
  detectWasmSimdSupport,
  detectWasmSupport,
  recommendExecutionMode,
} from '../src/services/hardware';
import type {
  EngineModelMetadata,
  ModelManifestEntry,
  PinnedModelManifest,
  VoiceCloningEngine,
  VoiceProfile,
} from '../src/types';

function loadDiskManifest(): unknown {
  const manifestPath = resolve(process.cwd(), 'public/model-manifests/models.json');
  return JSON.parse(readFileSync(manifestPath, 'utf-8'));
}

function createMockVoiceProfile(
  conditioningPayloads: VoiceProfile['conditioningPayloads']
): VoiceProfile {
  return {
    id: 'voice-1',
    name: 'Test Speaker',
    language: 'en',
    tags: ['studio'],
    referenceClip: {
      clipId: 'clip-1',
      filename: 'sample.wav',
      mimeType: 'audio/wav',
      source: 'file-upload',
      durationSec: 6.5,
      sampleRate: 24000,
      channels: 1,
      capturedAt: '2026-11-25T00:00:00Z',
    },
    qualityAnalysis: {
      clipping: { clippedSampleCount: 0, clippedPercentage: 0, hasSevereClipping: false },
      silence: {
        leadingSilenceSec: 0.1,
        trailingSilenceSec: 0.1,
        silenceRatio: 0.05,
        activeSpeechDurationSec: 6.1,
      },
      noiseFloorDb: -58,
      estimatedSnrDb: 36,
      rmsDb: -19,
      peakDb: -3,
      reverbEstimate: { score: 0.1, level: 'dry' },
      multiSpeakerEstimate: { score: 0.05, suspectedMultipleSpeakers: false },
      durationSec: 6.5,
      sampleRate: 24000,
      channels: 1,
      overallScore: 92,
      warnings: [],
      recommendations: [],
    },
    authorizedUse: {
      confirmed: true,
      confirmedAt: '2026-11-25T00:00:00Z',
      attestationText: 'I confirm authorization.',
      sourceBasis: 'self',
      verificationScope: 'client-self-attested',
    },
    conditioningPayloads,
    createdAt: '2026-11-25T00:00:00Z',
    updatedAt: '2026-11-25T00:00:00Z',
  };
}

function createMockEngine(
  id: string,
  revision: string,
  compatible = true
): VoiceCloningEngine {
  const metadata: EngineModelMetadata = {
    engineId: id,
    modelName: `${id} model`,
    repoId: `org/${id}`,
    modelRevision: revision,
    license: 'CC-BY-4.0',
    nativeSampleRate: 24000,
    precision: 'int8',
    totalSizeBytes: 1000,
    isInitialized: true,
    activeBackend: 'wasm',
  };

  return {
    id,
    name: id,
    description: `${id} test engine`,
    version: '1.0.0',
    precision: 'int8',
    capabilities: {
      supportsVoiceCloning: true,
      supportsStreaming: true,
      supportsWebGpu: false,
      supportsWasm: true,
      requiresReferenceTranscript: false,
      supportsEmotionTags: false,
      minReferenceDurationSec: 3,
      maxReferenceDurationSec: 30,
      nativeSampleRate: 24000,
    },
    checkHardwareCompatibility: vi.fn(async () => ({
      engineId: id,
      webgpuSupported: false,
      shaderF16Supported: false,
      wasmSimdSupported: true,
      wasmThreadsSupported: false,
      crossOriginIsolated: false,
      estimatedDeviceMemoryMb: null,
      compatible,
      recommendedBackend: 'wasm',
      recommendedExecutionMode: 'cpu',
      blockers: compatible ? [] : ['Unsupported hardware'],
      warnings: [],
    })),
    initialize: vi.fn(async () => undefined),
    encodeVoice: vi.fn(async () => ({
      engineId: id,
      modelRevision: revision,
      payloadVersion: 1,
      precision: 'int8',
      tensors: {},
      createdAt: '2026-11-25T00:00:00Z',
    })),
    loadVoiceProfile: vi.fn(async (profile: VoiceProfile) => ({
      profileId: profile.id,
      engineId: id,
      modelRevision: revision,
      handleId: `${id}-handle`,
    })),
    synthesize: vi.fn(async () => ({
      audio: {
        samples: new Float32Array(128),
        sampleRate: 24000,
        channels: 1,
        durationSec: 128 / 24000,
      },
      generationTimeMs: 10,
      realTimeFactor: 0.5,
      backend: 'wasm' as const,
    })),
    cancel: vi.fn(),
    dispose: vi.fn(async () => undefined),
    getSupportedLanguages: () => [{ code: 'en', name: 'English', nativeName: 'English' }],
    getGenerationParameters: () => [],
    getModelMetadata: () => metadata,
  };
}

describe('pinned model manifest & validation', () => {
  it('validates public/model-manifests/models.json with exact Pocket TTS and Chatterbox metadata', () => {
    const raw = loadDiskManifest();
    const manifest = validateManifest(raw);

    expect(manifest.schemaVersion).toBe(1);
    expect(manifest.defaultEngineId).toBe('pocket-tts');
    expect(manifest.models).toHaveLength(2);

    const pocket = getModelManifestEntry(manifest, 'pocket-tts');
    expect(pocket).toBeDefined();
    expect(pocket?.repoId).toBe('KevinAHM/pocket-tts-onnx');
    expect(pocket?.revision).toBe('58a6d00cf13d239b6748cb0769f35c580a8f606c');
    expect(pocket?.ungated).toBe(true);
    expect(pocket?.license).toBe('CC-BY-4.0');
    expect(pocket?.sampleRate).toBe(24000);
    expect(pocket?.precision).toBe('int8');
    expect(pocket?.artifacts).toHaveLength(8);
    expect(pocket?.totalSizeBytes).toBe(146243590);

    const sumBytes = pocket!.artifacts.reduce((sum, a) => sum + a.sizeBytes, 0);
    expect(sumBytes).toBe(146243590);

    for (const artifact of pocket!.artifacts) {
      expect(artifact.sha256).toMatch(/^[0-9a-f]{64}$/);
      expect(artifact.url).toContain(
        'https://huggingface.co/KevinAHM/pocket-tts-onnx/resolve/58a6d00cf13d239b6748cb0769f35c580a8f606c/'
      );
    }

    const chatterbox = getModelManifestEntry(manifest, 'chatterbox');
    const expectedChatterbox = getChatterboxManifestEntry('q4f16');
    expect(chatterbox).toBeDefined();
    expect(chatterbox?.repoId).toBe('onnx-community/chatterbox-ONNX');
    expect(chatterbox?.revision).toBe('3cab09af388d3f02bba43443fce88c1f4525ac43');
    expect(chatterbox?.license).toBe('MIT');
    expect(chatterbox?.precision).toBe('q4f16');
    expect(chatterbox?.artifacts).toEqual(expectedChatterbox.artifacts);
    expect(chatterbox?.totalSizeBytes).toBe(expectedChatterbox.totalSizeBytes);
  });

  it('rejects manifests with mutable revisions, bad sha256, path traversal, or mismatched sizes', () => {
    const valid = validateManifest(loadDiskManifest());
    const broken: PinnedModelManifest = structuredClone(valid);
    broken.models[0].revision = 'main';
    broken.models[0].totalSizeBytes = 999;
    broken.models[0].artifacts[0].sha256 = 'not-a-sha256';
    broken.models[0].artifacts[1].relativePath = '../escape.onnx';

    const result = safeValidateManifest(broken);
    expect(result.valid).toBe(false);
    if (!result.valid) {
      expect(result.errors.some((e) => e.includes('revision'))).toBe(true);
      expect(result.errors.some((e) => e.includes('sha256'))).toBe(true);
      expect(result.errors.some((e) => e.includes('relativePath'))).toBe(true);
    }

    expect(() => validateManifest(broken)).toThrow(ManifestValidationError);
  });

  it('resolves pinned Hugging Face URLs and custom self-hosted base URLs', () => {
    const manifest = validateManifest(loadDiskManifest());
    const pocket = getModelManifestEntry(manifest, 'pocket-tts')!;
    const bundleArtifact = pocket.artifacts.find((a) => a.role === 'bundle_config')!;

    expect(resolveArtifactUrl(bundleArtifact)).toBe(
      'https://huggingface.co/KevinAHM/pocket-tts-onnx/resolve/58a6d00cf13d239b6748cb0769f35c580a8f606c/onnx/english_2026-04/bundle.json'
    );

    expect(resolveArtifactUrl(bundleArtifact, './models/pocket-tts/')).toBe(
      './models/pocket-tts/onnx/english_2026-04/bundle.json'
    );

    expect(
      resolveArtifactUrl(bundleArtifact, {
        customBaseUrl: 'https://cdn.example.com/models/{engineId}/',
        engineId: 'pocket-tts',
      })
    ).toBe('https://cdn.example.com/models/pocket-tts/onnx/english_2026-04/bundle.json');

    const rewritten = resolveEntryArtifactUrls(pocket, './models/pocket-tts');
    expect(rewritten.artifacts.every((a) => a.url.startsWith('./models/pocket-tts/'))).toBe(true);
  });

  it('allows clean registration of additional verified engine manifest entries', () => {
    const manifest = validateManifest(loadDiskManifest());
    const extraEntry: ModelManifestEntry = {
      engineId: 'custom-experimental',
      displayName: 'Experimental Engine (Test Entry)',
      repoId: 'org/experimental-tts-onnx',
      revision: '0123456789abcdef0123456789abcdef01234567',
      license: 'MIT',
      ungated: true,
      precision: 'q4f16',
      sampleRate: 24000,
      recommendedExecutionMode: 'quality',
      estimatedMemoryMb: 1800,
      totalSizeBytes: 1234,
      artifacts: [
        {
          role: 'speech_encoder',
          relativePath: 'onnx/speech_encoder.onnx',
          url: 'https://huggingface.co/org/experimental-tts-onnx/resolve/0123456789abcdef0123456789abcdef01234567/onnx/speech_encoder.onnx',
          sizeBytes: 1234,
          sha256: 'a'.repeat(64),
          format: 'onnx',
          required: true,
        },
      ],
    };

    const updated = registerManifestEntry(manifest, extraEntry);
    expect(updated.models).toHaveLength(3);
    expect(getModelManifestEntry(updated, 'custom-experimental')?.revision).toBe(
      extraEntry.revision
    );
  });

  it('creates default engine registry with PocketTtsEngine and ChatterboxEngine', () => {
    const registry = createDefaultEngineRegistry({
      chatterbox: { useWorker: false },
    });
    expect(registry.has('pocket-tts')).toBe(true);
    expect(registry.has('chatterbox')).toBe(true);
    expect(registry.list()).toHaveLength(2);
    expect(registry.require('pocket-tts').getModelMetadata().modelRevision).toBe(
      '58a6d00cf13d239b6748cb0769f35c580a8f606c'
    );
    expect(registry.require('chatterbox').getModelMetadata().modelRevision).toBe(
      '3cab09af388d3f02bba43443fce88c1f4525ac43'
    );
  });
});

describe('hardware capability detection', () => {
  it('detects WASM and WASM SIMD support', () => {
    expect(detectWasmSupport()).toBe(true);
    expect(detectWasmSimdSupport()).toBe(true);
  });

  it('recommends execution modes transparently without fabricating VRAM', () => {
    expect(
      recommendExecutionMode({
        webgpuSupported: true,
        webgpuAdapterAvailable: true,
        shaderF16Supported: true,
        webgpuMaxBufferSize: 512 * 1024 * 1024,
        estimatedDeviceMemoryMb: 8192,
      })
    ).toBe('quality');

    expect(
      recommendExecutionMode({
        webgpuSupported: true,
        webgpuAdapterAvailable: true,
        shaderF16Supported: false,
        estimatedDeviceMemoryMb: null,
      })
    ).toBe('balanced');

    expect(
      recommendExecutionMode({
        webgpuSupported: false,
        webgpuAdapterAvailable: false,
        shaderF16Supported: false,
        estimatedDeviceMemoryMb: null,
      })
    ).toBe('cpu');
  });

  it('reports null for unavailable deviceMemory and collects WebGPU adapter info safely', async () => {
    const originalNav = globalThis.navigator;
    const mockNavigator = {
      hardwareConcurrency: 8,
      storage: {
        estimate: vi.fn(async () => ({ quota: 2_000_000_000, usage: 50_000_000 })),
      },
      gpu: {
        requestAdapter: vi.fn(async () => ({
          features: new Set(['shader-f16']),
          limits: { maxBufferSize: 536870912 },
          info: { vendor: 'test-vendor', architecture: 'test-arch' },
        })),
      },
    };

    Object.defineProperty(globalThis, 'navigator', {
      configurable: true,
      value: mockNavigator,
    });

    try {
      const caps = await detectHardwareCapabilities();
      expect(caps.webgpuSupported).toBe(true);
      expect(caps.webgpuAdapterAvailable).toBe(true);
      expect(caps.shaderF16Supported).toBe(true);
      expect(caps.webgpuMaxBufferSize).toBe(536870912);
      expect(caps.webgpuAdapterInfo?.vendor).toBe('test-vendor');
      expect(caps.deviceMemoryGb).toBeNull();
      expect(caps.estimatedDeviceMemoryMb).toBeNull();
      expect(caps.storageQuotaBytes).toBe(2_000_000_000);
      expect(caps.storageUsageBytes).toBe(50_000_000);
      expect(caps.recommendedExecutionMode).toBe('quality');

      const report = buildEngineCompatibilityReport('pocket-tts', caps, {
        supportsWasm: true,
        supportsWebGpu: false,
      });
      expect(report.compatible).toBe(true);
      expect(report.recommendedBackend).toBe('wasm');
      expect(report.recommendedExecutionMode).toBe('cpu');
    } finally {
      Object.defineProperty(globalThis, 'navigator', {
        configurable: true,
        value: originalNav,
      });
    }
  });
});

describe('EngineRegistry and cross-engine embedding isolation', () => {
  it('registers engines, checks compatibility, and selects best compatible engine', async () => {
    const registry = new EngineRegistry();
    const chatterbox = createMockEngine('chatterbox', 'rev-a', false);
    const pocket = createMockEngine('pocket-tts', '58a6d00cf13d239b6748cb0769f35c580a8f606c', true);

    registry.register(chatterbox);
    registry.register(pocket);

    expect(() => registry.register(pocket)).toThrow(/already registered/);

    const reports = await registry.checkCompatibilityAll();
    expect(reports).toHaveLength(2);

    const best = await registry.selectBestEngine('chatterbox');
    expect(best?.engine.id).toBe('pocket-tts');
  });

  it('strictly blocks cross-engine and cross-revision conditioning payloads', async () => {
    const registry = new EngineRegistry();
    const pocketRev1 = createMockEngine('pocket-tts', 'rev-1', true);
    const chatterbox = createMockEngine('chatterbox', 'rev-cb', true);
    registry.register(pocketRev1);
    registry.register(chatterbox);

    const profileWithPocketOnly = createMockVoiceProfile({
      [buildConditioningPayloadKey('pocket-tts', 'rev-1')]: {
        engineId: 'pocket-tts',
        modelRevision: 'rev-1',
        payloadVersion: 1,
        precision: 'int8',
        tensors: {},
        createdAt: '2026-11-25T00:00:00Z',
      },
    });

    expect(registry.isProfileReadyForEngine(profileWithPocketOnly, 'pocket-tts')).toBe(true);
    expect(registry.isProfileReadyForEngine(profileWithPocketOnly, 'chatterbox')).toBe(false);

    const handle = await registry.loadVoiceProfileForEngine('pocket-tts', profileWithPocketOnly);
    expect(handle.engineId).toBe('pocket-tts');

    await expect(
      registry.loadVoiceProfileForEngine('chatterbox', profileWithPocketOnly)
    ).rejects.toThrow(EngineConditioningMismatchError);

    // Cross-revision payload under pocket-tts rev-2 must also be rejected
    const pocketRev2 = createMockEngine('pocket-tts', 'rev-2', true);
    expect(getCompatibleConditioningPayload(profileWithPocketOnly, pocketRev2)).toBeNull();
    expect(() =>
      assertCompatibleConditioningPayload(profileWithPocketOnly, pocketRev2)
    ).toThrow(EngineConditioningMismatchError);

    // Tampered key/payload mismatch must be rejected
    const tamperedProfile = createMockVoiceProfile({
      [buildConditioningPayloadKey('chatterbox', 'rev-cb')]: {
        engineId: 'pocket-tts',
        modelRevision: 'rev-1',
        payloadVersion: 1,
        precision: 'int8',
        tensors: {},
        createdAt: '2026-11-25T00:00:00Z',
      },
    });
    expect(() =>
      assertCompatibleConditioningPayload(tamperedProfile, chatterbox)
    ).toThrow(EngineConditioningMismatchError);

    expect(() => validateVoiceHandleForEngine(handle, chatterbox)).toThrow(
      EngineConditioningMismatchError
    );
  });
});
