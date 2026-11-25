import 'fake-indexeddb/auto';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  VOICE_PROFILE_BUNDLE_FORMAT,
  VOICE_PROFILE_SCHEMA_VERSION,
  VoiceProfileImportError,
  exportVoiceProfile,
  exportVoiceProfileJson,
  importVoiceProfile,
  sanitizeProfileText,
} from '../src/services/voiceProfileIO';
import { clearAllUserData, closeDb } from '../src/storage/db';
import { useVoiceStore } from '../src/stores/voiceStore';
import type { VoiceProfile } from '../src/types';

function createSampleProfile(id = 'voice-export-1'): VoiceProfile {
  const f32 = new Float32Array([0.25, -0.5, 0.75, -1.0]);
  const i64 = new BigInt64Array([12n]);
  const empty = new Float32Array(0);

  return {
    id,
    name: 'Narrator Alpha',
    description: 'Warm studio voice',
    language: 'en',
    tags: ['audiobook', 'warm'],
    referenceClip: {
      clipId: 'clip-alpha',
      filename: 'narrator.wav',
      mimeType: 'audio/wav',
      source: 'file-upload',
      durationSec: 6.4,
      sampleRate: 24000,
      channels: 1,
      transcript: 'Hello world.',
      capturedAt: '2026-11-25T00:00:00Z',
    },
    qualityAnalysis: {
      clipping: { clippedSampleCount: 0, clippedPercentage: 0, hasSevereClipping: false },
      silence: {
        leadingSilenceSec: 0.1,
        trailingSilenceSec: 0.08,
        silenceRatio: 0.03,
        activeSpeechDurationSec: 6.22,
      },
      noiseFloorDb: -58,
      estimatedSnrDb: 36,
      rmsDb: -18,
      peakDb: -1.5,
      reverbEstimate: { score: 0.08, level: 'dry' },
      multiSpeakerEstimate: { score: 0.02, suspectedMultipleSpeakers: false },
      durationSec: 6.4,
      sampleRate: 24000,
      channels: 1,
      overallScore: 94,
      warnings: [],
      recommendations: [],
    },
    authorizedUse: {
      confirmed: true,
      confirmedAt: '2026-11-25T00:00:00Z',
      attestationText: 'I confirm authorized use.',
      sourceBasis: 'self',
      verificationScope: 'client-self-attested',
    },
    conditioningPayloads: {
      'pocket-tts::58a6d00cf13d239b6748cb0769f35c580a8f606c': {
        engineId: 'pocket-tts',
        modelRevision: '58a6d00cf13d239b6748cb0769f35c580a8f606c',
        payloadVersion: 1,
        precision: 'int8',
        tensors: {
          state_0: {
            dtype: 'float32',
            dims: [1, 4],
            data: f32.buffer.slice(0),
          },
          state_2: {
            dtype: 'int64',
            dims: [1],
            data: i64.buffer.slice(0),
          },
          empty_state: {
            dtype: 'float32',
            dims: [1, 0, 32],
            data: empty.buffer.slice(0),
          },
        },
        createdAt: '2026-11-25T00:00:00Z',
        metadata: { frames: 12 },
      },
    },
    createdAt: '2026-11-25T00:00:00Z',
    updatedAt: '2026-11-25T00:00:00Z',
  };
}

describe('voiceProfileIO export and adversarial import validation', () => {
  beforeEach(async () => {
    await clearAllUserData();
    useVoiceStore.getState().clearInMemoryVoices();
  });

  afterEach(async () => {
    await clearAllUserData();
    await closeDb();
  });

  it('round-trips VoiceProfile with base64 tensors and integrity verification', async () => {
    const original = createSampleProfile();
    const json = await exportVoiceProfileJson(original);
    const imported = await importVoiceProfile(json, {
      expectedEngineId: 'pocket-tts',
      expectedModelRevision: '58a6d00cf13d239b6748cb0769f35c580a8f606c',
    });

    expect(imported.profile.id).toBe(original.id);
    expect(imported.profile.name).toBe('Narrator Alpha');
    expect(imported.compatibleTargets).toEqual([
      {
        engineId: 'pocket-tts',
        modelRevision: '58a6d00cf13d239b6748cb0769f35c580a8f606c',
      },
    ]);

    const payload =
      imported.profile.conditioningPayloads[
        'pocket-tts::58a6d00cf13d239b6748cb0769f35c580a8f606c'
      ];
    expect(Array.from(new Float32Array(payload.tensors.state_0.data))).toEqual([
      0.25, -0.5, 0.75, -1.0,
    ]);
    expect(Array.from(new BigInt64Array(payload.tensors.state_2.data))).toEqual([12n]);
    expect(payload.tensors.empty_state.data.byteLength).toBe(0);
  });

  it('sanitizes HTML/script tags and bounds string lengths on import', async () => {
    expect(sanitizeProfileText('<script>alert(1)</script><b>Clean</b> Voice\x00')).toBe(
      'Clean Voice'
    );

    const profile = createSampleProfile();
    profile.name = '<script>evil()</script>Narrator <b>One</b>';
    profile.description = `<img src=x onerror=alert(1)>${'A'.repeat(3000)}`;
    profile.tags = ['<svg onload=alert(1)>studio', 'clean-tag'];

    // Export then remove bundleSha256 so we simulate a third-party crafted bundle
    const bundle = await exportVoiceProfile(profile);
    const untrustedBundle = {
      ...bundle,
      integrity: {
        algorithm: 'SHA-256' as const,
        tensorCount: bundle.integrity.tensorCount,
        totalTensorBytes: bundle.integrity.totalTensorBytes,
      },
    };

    const result = await importVoiceProfile(JSON.stringify(untrustedBundle));
    expect(result.profile.name).toBe('Narrator One');
    expect(result.profile.description?.length).toBeLessThanOrEqual(2000);
    expect(result.profile.description).not.toContain('<img');
    expect(result.profile.tags).toEqual(['studio', 'clean-tag']);
  });

  it('rejects malformed JSON, oversized payloads, wrong schema version, and __proto__ pollution', async () => {
    await expect(importVoiceProfile('{not-json')).rejects.toMatchObject({
      code: 'MALFORMED_JSON',
    });

    await expect(
      importVoiceProfile('{"format":"voiceforge-voice-profile"}', {
        maxPayloadBytes: 10,
      })
    ).rejects.toMatchObject({
      code: 'PAYLOAD_TOO_LARGE',
    });

    const bundle = await exportVoiceProfile(createSampleProfile());
    await expect(
      importVoiceProfile({ ...bundle, schemaVersion: 99 })
    ).rejects.toMatchObject({
      code: 'UNSUPPORTED_SCHEMA',
    });

    await expect(
      importVoiceProfile({ ...bundle, format: 'unknown-format' })
    ).rejects.toMatchObject({
      code: 'UNSUPPORTED_SCHEMA',
    });

    // __proto__ pollution check via raw JSON string
    const pollutedJson = `{"__proto__":{"polluted":true},"format":"${VOICE_PROFILE_BUNDLE_FORMAT}","schemaVersion":${VOICE_PROFILE_SCHEMA_VERSION}}`;
    await expect(importVoiceProfile(pollutedJson)).rejects.toThrow(VoiceProfileImportError);
  });

  it('rejects tensor byte-length / dims / dtype mismatches, tampered checksums, and engine mismatches', async () => {
    const bundle = await exportVoiceProfile(createSampleProfile());

    // 1. Tamper bundle contents without updating bundleSha256
    const tamperedBundle = structuredClone(bundle);
    tamperedBundle.profile.name = 'Tampered Name';
    await expect(importVoiceProfile(tamperedBundle)).rejects.toMatchObject({
      code: 'INTEGRITY_MISMATCH',
    });

    // 2. Tensor dims mismatch (claim dims [1, 8] for 16 bytes of float32)
    const badDims = structuredClone(bundle);
    delete (badDims.integrity as { bundleSha256?: string }).bundleSha256;
    badDims.profile.conditioningPayloads[
      'pocket-tts::58a6d00cf13d239b6748cb0769f35c580a8f606c'
    ].tensors.state_0.dims = [1, 8];
    await expect(importVoiceProfile(badDims)).rejects.toMatchObject({
      code: 'TENSOR_MISMATCH',
    });

    // 3. Invalid base64
    const badBase64 = structuredClone(bundle);
    delete (badBase64.integrity as { bundleSha256?: string }).bundleSha256;
    badBase64.profile.conditioningPayloads[
      'pocket-tts::58a6d00cf13d239b6748cb0769f35c580a8f606c'
    ].tensors.state_0.dataBase64 = '!!!not-base64!!!';
    await expect(importVoiceProfile(badBase64)).rejects.toMatchObject({
      code: 'INVALID_FIELD',
    });

    // 4. Key vs payload engineId/modelRevision mismatch
    const badKey = structuredClone(bundle);
    delete (badKey.integrity as { bundleSha256?: string }).bundleSha256;
    const payloadCopy =
      badKey.profile.conditioningPayloads[
        'pocket-tts::58a6d00cf13d239b6748cb0769f35c580a8f606c'
      ];
    delete badKey.profile.conditioningPayloads[
      'pocket-tts::58a6d00cf13d239b6748cb0769f35c580a8f606c'
    ];
    badKey.profile.conditioningPayloads['chatterbox::wrong-rev'] = payloadCopy;
    await expect(importVoiceProfile(badKey)).rejects.toMatchObject({
      code: 'ENGINE_INCOMPATIBLE',
    });

    // 5. Required engine compatibility check
    await expect(
      importVoiceProfile(bundle, {
        expectedEngineId: 'chatterbox',
      })
    ).rejects.toMatchObject({
      code: 'ENGINE_INCOMPATIBLE',
    });
  });

  it('integrates with voiceStore CRUD, default star, rename, duplicate, export, and import', async () => {
    const store = useVoiceStore.getState();
    const profile = createSampleProfile('voice-store-1');
    await store.saveVoiceProfile(profile, { isDefault: true });

    expect(useVoiceStore.getState().voices).toHaveLength(1);
    expect(useVoiceStore.getState().defaultVoiceId).toBe('voice-store-1');

    const renamed = await store.renameVoice('voice-store-1', 'Studio Narrator');
    expect(renamed.name).toBe('Studio Narrator');

    const dup = await store.duplicateVoice('voice-store-1', 'Studio Narrator Alt');
    expect(dup.id).not.toBe('voice-store-1');
    expect(dup.name).toBe('Studio Narrator Alt');
    expect(useVoiceStore.getState().voices).toHaveLength(2);

    await store.setDefaultNarrator(dup.id);
    expect(useVoiceStore.getState().defaultVoiceId).toBe(dup.id);

    const exportedJson = await store.exportVoice(dup.id);
    const reimported = await store.importVoice(exportedJson);
    expect(reimported.id).not.toBe(dup.id); // Collision assigns fresh ID
    expect(useVoiceStore.getState().voices).toHaveLength(3);

    await store.deleteVoiceProfile(reimported.id);
    expect(useVoiceStore.getState().voices).toHaveLength(2);
  });
});
