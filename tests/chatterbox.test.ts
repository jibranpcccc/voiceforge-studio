import { describe, expect, it } from 'vitest';
import {
  CHATTERBOX_LM_NUM_LAYERS,
  CHATTERBOX_MODEL_REVISION,
  CHATTERBOX_SAMPLE_RATE,
  CHATTERBOX_WASM_SLOW_WARNING,
  ChatterboxEngine,
  EnTokenizer,
  SILENCE_TOKEN,
  START_SPEECH_TOKEN,
  STOP_SPEECH_TOKEN,
  calculateTokenBudget,
  computeChatterboxPositionIds,
  getChatterboxManifestEntry,
  normalizeChatterboxText,
  prepareReferenceAudio24k,
  sampleNextSpeechToken,
  selectChatterboxRuntimePlan,
  validateChatterboxConditioningPayload,
  type OrtSessionLike,
  type OrtTensorLike,
} from '../src/engines/chatterbox';
import {
  EngineConditioningMismatchError,
  EngineRegistry,
} from '../src/engines/registry';
import { validateManifest } from '../src/models/manifest';
import type { HardwareCapabilities } from '../src/services/hardware';
import type {
  ReferenceClipMetadata,
  VoiceConditioningPayload,
  VoiceProfile,
} from '../src/types';

function makeCapabilities(overrides: Partial<HardwareCapabilities> = {}): HardwareCapabilities {
  return {
    webgpuSupported: true,
    webgpuAdapterAvailable: true,
    shaderF16Supported: true,
    webgpuMaxBufferSize: 1024 * 1024 * 1024,
    webgpuAdapterInfo: null,
    wasmSupported: true,
    wasmSimdSupported: true,
    wasmThreadsSupported: false,
    crossOriginIsolated: false,
    sharedArrayBufferAvailable: false,
    hardwareConcurrency: 8,
    deviceMemoryGb: 8,
    estimatedDeviceMemoryMb: 8192,
    storageQuotaBytes: 10_000_000_000,
    storageUsageBytes: 0,
    recommendedWasmThreads: 1,
    recommendedExecutionMode: 'quality',
    notes: [],
    ...overrides,
  };
}

function makeReferenceMetadata(): ReferenceClipMetadata {
  return {
    clipId: 'clip-ref-1',
    filename: 'reference.wav',
    mimeType: 'audio/wav',
    source: 'file-upload',
    durationSec: 6.0,
    sampleRate: 24000,
    channels: 1,
    capturedAt: '2026-11-25T00:00:00Z',
  };
}

function makeVoiceProfile(
  conditioningPayloads: VoiceProfile['conditioningPayloads']
): VoiceProfile {
  return {
    id: 'voice-cb-1',
    name: 'Chatterbox Speaker',
    language: 'en',
    tags: ['studio'],
    referenceClip: makeReferenceMetadata(),
    qualityAnalysis: {
      clipping: { clippedSampleCount: 0, clippedPercentage: 0, hasSevereClipping: false },
      silence: {
        leadingSilenceSec: 0.05,
        trailingSilenceSec: 0.05,
        silenceRatio: 0.02,
        activeSpeechDurationSec: 5.9,
      },
      noiseFloorDb: -55,
      estimatedSnrDb: 35,
      rmsDb: -18,
      peakDb: -2,
      reverbEstimate: { score: 0.1, level: 'dry' },
      multiSpeakerEstimate: { score: 0.05, suspectedMultipleSpeakers: false },
      durationSec: 6.0,
      sampleRate: 24000,
      channels: 1,
      overallScore: 95,
      warnings: [],
      recommendations: [],
    },
    authorizedUse: {
      confirmed: true,
      confirmedAt: '2026-11-25T00:00:00Z',
      attestationText: 'Authorized test voice',
      sourceBasis: 'self',
      verificationScope: 'client-self-attested',
    },
    conditioningPayloads,
    createdAt: '2026-11-25T00:00:00Z',
    updatedAt: '2026-11-25T00:00:00Z',
  };
}

describe('Chatterbox EnTokenizer parity against HuggingFace tokenizer.json', () => {
  const tokenizer = new EnTokenizer();

  // Ground-truth IDs verified directly via `tokenizers.Tokenizer.from_file("tokenizer.json")`
  // from onnx-community/chatterbox-ONNX@3cab09af388d3f02bba43443fce88c1f4525ac43.
  const parityCases: Array<[string, number[]]> = [
    ['', [6563, 255, 0, 6561, 6561]],
    ['Hello, world!', [6563, 255, 284, 18, 84, 28, 7, 2, 179, 79, 3, 0, 6561, 6561]],
    [
      '  multiple   spaces\t\nand\nnewlines  ',
      [
        6563, 255, 2, 26, 167, 78, 29, 64, 2, 248, 77, 61, 2, 53, 2, 111, 36, 25, 41, 61,
        2, 0, 6561, 6561,
      ],
    ],
    [
      'Testing [laughter] tag and [giggle]!',
      [6563, 255, 296, 218, 52, 2, 607, 2, 33, 143, 2, 53, 2, 606, 3, 0, 6561, 6561],
    ],
    [
      'Numbers 123 and symbols @#$%^&*()!',
      [
        6563, 255, 290, 231, 15, 173, 2, 264, 265, 266, 2, 53, 2, 32, 38, 26, 165, 25, 32,
        2, 276, 257, 258, 259, 306, 260, 261, 5, 6, 3, 0, 6561, 6561,
      ],
    ],
    [
      'The quick brown fox jumps over the lazy dog.',
      [
        6563, 255, 296, 62, 2, 194, 91, 24, 2, 243, 190, 2, 182, 37, 2, 23, 231, 29, 32,
        2, 253, 2, 42, 2, 25, 14, 39, 38, 2, 134, 20, 9, 0, 6561, 6561,
      ],
    ],
    [
      'Wait... what?! Really \u2014 yes; no: maybe.',
      [
        6563, 255, 299, 14, 60, 9, 9, 9, 2, 193, 13, 3, 2, 294, 18, 195, 2, 317, 2, 38,
        61, 12, 2, 95, 11, 2, 26, 88, 67, 9, 0, 6561, 6561,
      ],
    ],
    [
      'Caf\u00e9 na\u00efve r\u00e9sum\u00e9 \u201cquoted\u201d \u2018single\u2019',
      [
        6563, 255, 279, 14, 19, 402, 2, 27, 14, 408, 76, 2, 31, 402, 133, 26, 402, 2, 325,
        194, 28, 188, 326, 2, 321, 32, 52, 64, 322, 0, 6561, 6561,
      ],
    ],
    [
      "Ezreal and Jinx teamed up with Ahri, Yasuo, and Teemo to take down the enemy's Nexus in an epic late-game pentakill.",
      [
        6563, 255, 281, 39, 46, 56, 2, 53, 2, 286, 41, 37, 2, 136, 122, 49, 2, 152, 2,
        103, 2, 277, 21, 101, 7, 2, 301, 55, 34, 28, 7, 2, 53, 2, 296, 18, 18, 115, 2, 51,
        2, 33, 245, 2, 17, 190, 2, 42, 2, 50, 18, 125, 4, 32, 2, 290, 169, 142, 2, 41, 2,
        43, 2, 18, 29, 91, 2, 25, 186, 8, 20, 14, 80, 2, 29, 86, 213, 216, 9, 0, 6561,
        6561,
      ],
    ],
    [
      '[UH] Well, [sigh] let us see.',
      [6563, 255, 604, 2, 299, 18, 84, 7, 2, 611, 2, 64, 33, 2, 142, 2, 66, 18, 9, 0, 6561, 6561],
    ],
    [
      'Unknown emoji \ud83d\ude00 here.',
      [6563, 255, 297, 27, 209, 27, 2, 18, 115, 23, 22, 2, 1, 2, 92, 18, 9, 0, 6561, 6561],
    ],
  ];

  it.each(parityCases)('matches HuggingFace tokenizer.json for %j', (input, expectedIds) => {
    expect(tokenizer.encode(input)).toEqual(expectedIds);
  });

  it('decodes token IDs with Fuse semantics and optional special-token skipping', () => {
    const ids = tokenizer.encode('Hello, world!');
    expect(tokenizer.decode(ids, true)).toBe('Hello, world!');
    expect(tokenizer.decode(ids, false)).toBe(
      '[EXAGGERATION][START]Hello, world![STOP][START_SPEECH][START_SPEECH]'
    );
  });

  it('normalizes punctuation cleanly via normalizeChatterboxText', () => {
    expect(normalizeChatterboxText('')).toBe('You need to add some text for me to talk.');
    expect(normalizeChatterboxText('hello there')).toBe('Hello there.');
    expect(normalizeChatterboxText('wait... \u201cwhy\u201d; yes: ok\u2014done')).toBe(
      'Wait,  "why",  yes, ok-done.'
    );
    expect(normalizeChatterboxText('already punctuated!')).toBe('Already punctuated!');
  });

  it('computes Chatterbox position_ids identically to upstream ONNX export', () => {
    const ids = tokenizer.encode('Hi.');
    const pos = computeChatterboxPositionIds(ids);
    expect(pos[0]).toBe(0); // [EXAGGERATION] >= 6561
    expect(pos[1]).toBe(0); // [START]
    expect(pos[2]).toBe(1); // 'H'
    expect(pos[pos.length - 2]).toBe(0); // [START_SPEECH]
    expect(pos[pos.length - 1]).toBe(0); // [START_SPEECH]
  });
});

describe('Chatterbox precision selection, manifest, and token budget', () => {
  it('selects q4f16 with float16 KV cache when WebGPU adapter supports shader-f16', () => {
    const plan = selectChatterboxRuntimePlan({
      webgpuSupported: true,
      webgpuAdapterAvailable: true,
      shaderF16Supported: true,
    });
    expect(plan).toEqual({
      backend: 'webgpu',
      precision: 'q4f16',
      kvCacheDtype: 'float16',
      warnings: [],
    });
  });

  it('selects q4 with float32 KV cache when WebGPU lacks shader-f16', () => {
    const plan = selectChatterboxRuntimePlan({
      webgpuSupported: true,
      webgpuAdapterAvailable: true,
      shaderF16Supported: false,
    });
    expect(plan.backend).toBe('webgpu');
    expect(plan.precision).toBe('q4');
    expect(plan.kvCacheDtype).toBe('float32');
    expect(plan.warnings.length).toBeGreaterThan(0);
  });

  it('falls back to WASM q4 with explicit ~5.8x slower warning when WebGPU is unavailable or CPU mode requested', () => {
    const noGpuPlan = selectChatterboxRuntimePlan({
      webgpuSupported: false,
      webgpuAdapterAvailable: false,
      shaderF16Supported: false,
    });
    expect(noGpuPlan.backend).toBe('wasm');
    expect(noGpuPlan.precision).toBe('q4');
    expect(noGpuPlan.kvCacheDtype).toBe('float32');
    expect(noGpuPlan.warnings).toContain(CHATTERBOX_WASM_SLOW_WARNING);

    const cpuOverridePlan = selectChatterboxRuntimePlan(
      {
        webgpuSupported: true,
        webgpuAdapterAvailable: true,
        shaderF16Supported: true,
      },
      { executionMode: 'cpu' }
    );
    expect(cpuOverridePlan.backend).toBe('wasm');
    expect(cpuOverridePlan.precision).toBe('q4');
  });

  it('throws when WebGPU is explicitly required without an adapter', () => {
    expect(() =>
      selectChatterboxRuntimePlan(
        {
          webgpuSupported: false,
          webgpuAdapterAvailable: false,
          shaderF16Supported: false,
        },
        { preferredBackend: 'webgpu' }
      )
    ).toThrow(/WebGPU/);
  });

  it('produces valid pinned ModelManifestEntry totals for q4f16 and q4', () => {
    const q4f16 = getChatterboxManifestEntry('q4f16');
    const q4 = getChatterboxManifestEntry('q4');

    expect(q4f16.totalSizeBytes).toBe(1_499_431_645);
    expect(q4.totalSizeBytes).toBe(1_548_314_008);
    expect(q4f16.revision).toBe(CHATTERBOX_MODEL_REVISION);

    const validated = validateManifest({
      schemaVersion: 1,
      generatedAt: '2026-11-25T00:00:00Z',
      defaultEngineId: 'chatterbox',
      models: [q4f16],
    });
    expect(validated.models[0].artifacts).toHaveLength(13);
  });

  it('computes dynamic token budget min(1024, ceil(chars * 2.4 + 20))', () => {
    expect(calculateTokenBudget('Hello.')).toBe(Math.ceil(6 * 2.4 + 20)); // 35
    expect(calculateTokenBudget('a'.repeat(120))).toBe(Math.ceil(120 * 2.4 + 20)); // 308
    expect(calculateTokenBudget('a'.repeat(500))).toBe(1024);
    expect(calculateTokenBudget('a'.repeat(5000))).toBe(1024);
  });
});

describe('VoiceConditioningPayload strict engine/revision guard', () => {
  function validPayload(): VoiceConditioningPayload {
    return {
      engineId: 'chatterbox',
      modelRevision: CHATTERBOX_MODEL_REVISION,
      payloadVersion: 1,
      precision: 'q4f16',
      tensors: {
        audio_features: {
          dtype: 'float32',
          dims: [1, 150, 1024],
          data: new Float32Array(150 * 1024).buffer,
        },
        audio_tokens: {
          dtype: 'int64',
          dims: [1, 150],
          data: new BigInt64Array(150).buffer,
        },
        speaker_embeddings: {
          dtype: 'float32',
          dims: [1, 192],
          data: new Float32Array(192).buffer,
        },
        speaker_features: {
          dtype: 'float32',
          dims: [1, 250, 80],
          data: new Float32Array(250 * 80).buffer,
        },
      },
      createdAt: '2026-11-25T00:00:00Z',
    };
  }

  it('rejects conditioning payloads from another engine or model revision', async () => {
    const engine = new ChatterboxEngine({ useWorker: false });
    const registry = new EngineRegistry();
    registry.register(engine);

    const wrongEngineProfile = makeVoiceProfile({
      [`pocket-tts::58a6d00cf13d239b6748cb0769f35c580a8f606c`]: {
        ...validPayload(),
        engineId: 'pocket-tts',
        modelRevision: '58a6d00cf13d239b6748cb0769f35c580a8f606c',
      },
    });
    await expect(engine.loadVoiceProfile(wrongEngineProfile)).rejects.toBeInstanceOf(
      EngineConditioningMismatchError
    );

    const wrongRevisionProfile = makeVoiceProfile({
      [`chatterbox::deadbeef`]: {
        ...validPayload(),
        modelRevision: 'deadbeef',
      },
    });
    await expect(engine.loadVoiceProfile(wrongRevisionProfile)).rejects.toBeInstanceOf(
      EngineConditioningMismatchError
    );

    const mismatchedInnerTagProfile = makeVoiceProfile({
      [`chatterbox::${CHATTERBOX_MODEL_REVISION}`]: {
        ...validPayload(),
        modelRevision: 'deadbeef',
      },
    });
    await expect(
      registry.loadVoiceProfileForEngine('chatterbox', mismatchedInnerTagProfile)
    ).rejects.toBeInstanceOf(EngineConditioningMismatchError);
  });

  it('rejects corrupted or incomplete Chatterbox conditioning tensors', async () => {
    const payload = validPayload();
    delete payload.tensors.speaker_features;
    expect(() => validateChatterboxConditioningPayload(payload)).toThrow(/speaker_features/);

    const badRank = validPayload();
    badRank.tensors.speaker_embeddings.dims = [1, 1, 192];
    expect(() => validateChatterboxConditioningPayload(badRank)).toThrow(/rank/);

    const engine = new ChatterboxEngine({ useWorker: false });
    const validProfile = makeVoiceProfile({
      [`chatterbox::${CHATTERBOX_MODEL_REVISION}`]: validPayload(),
    });
    const handle = await engine.loadVoiceProfile(validProfile);
    expect(handle.engineId).toBe('chatterbox');
    expect(handle.modelRevision).toBe(CHATTERBOX_MODEL_REVISION);
  });
});

describe('ChatterboxEngine pipeline, externalData, tensor disposal, and cancellation', () => {
  function createMockTensorFactory(disposedTracker: string[]) {
    return (
      type: string,
      data: Float32Array | BigInt64Array | Uint16Array,
      dims: readonly number[],
      tag = type
    ): OrtTensorLike => ({
      dims: [...dims],
      type,
      data,
      async getData() {
        return data;
      },
      dispose() {
        disposedTracker.push(tag);
      },
    });
  }

  it('resamples and caps reference audio to 24 kHz mono <= 10s', () => {
    // 12 seconds stereo at 48 kHz -> should downmix to mono, resample to 24 kHz, and cap at 10s (240,000 samples)
    const stereo48k = new Float32Array(12 * 48000 * 2).fill(0.25);
    const out = prepareReferenceAudio24k({
      samples: stereo48k,
      sampleRate: 48000,
      channels: 2,
      durationSec: 12,
    });
    expect(out.length).toBe(10 * CHATTERBOX_SAMPLE_RATE);
    expect(out[0]).toBeCloseTo(0.25, 5);
  });

  it('initializes with externalData, runs encodeVoice -> synthesize with 30-layer KV cache and 3x4299 silence padding, and disposes all tensors', async () => {
    const disposedInputs: string[] = [];
    const disposedOutputs: string[] = [];
    const sessionCalls: Array<{
      externalData: unknown;
      executionProviders: unknown;
    }> = [];
    const releasedSessions: string[] = [];
    let lmStepCount = 0;
    let decoderSpeechTokens: BigInt64Array | null = null;

    const makeMockTensor = createMockTensorFactory(disposedInputs);
    const makeOutputTensor = (
      type: string,
      data: Float32Array | BigInt64Array | Uint16Array,
      dims: readonly number[],
      tag: string
    ): OrtTensorLike => ({
      dims: [...dims],
      type,
      data,
      async getData() {
        return data;
      },
      dispose() {
        disposedOutputs.push(tag);
      },
    });

    const speechEncoderSession: OrtSessionLike = {
      inputNames: ['audio_values'],
      outputNames: [
        'audio_features',
        'audio_tokens',
        'speaker_embeddings',
        'speaker_features',
      ],
      async run() {
        return {
          audio_features: makeOutputTensor(
            'float32',
            new Float32Array(4 * 1024).fill(0.1),
            [1, 4, 1024],
            'se_audio_features'
          ),
          audio_tokens: makeOutputTensor(
            'int64',
            BigInt64Array.from([10n, 20n]),
            [1, 2],
            'se_audio_tokens'
          ),
          speaker_embeddings: makeOutputTensor(
            'float32',
            new Float32Array(192).fill(0.2),
            [1, 192],
            'se_speaker_embeddings'
          ),
          speaker_features: makeOutputTensor(
            'float32',
            new Float32Array(3 * 80).fill(0.3),
            [1, 3, 80],
            'se_speaker_features'
          ),
        };
      },
      async release() {
        releasedSessions.push('speech_encoder');
      },
    };

    const embedTokensSession: OrtSessionLike = {
      inputNames: ['input_ids', 'position_ids', 'exaggeration'],
      outputNames: ['inputs_embeds'],
      async run(feeds) {
        const idsTensor = feeds.input_ids as OrtTensorLike;
        const seqLen = idsTensor.dims[1];
        return {
          inputs_embeds: makeOutputTensor(
            'float32',
            new Float32Array(seqLen * 1024).fill(0.05),
            [1, seqLen, 1024],
            'emb_inputs_embeds'
          ),
        };
      },
      async release() {
        releasedSessions.push('embed_tokens');
      },
    };

    const languageModelSession: OrtSessionLike = {
      inputNames: ['inputs_embeds', 'attention_mask'],
      outputNames: ['logits'],
      async run(feeds) {
        lmStepCount += 1;
        const embeds = feeds.inputs_embeds as OrtTensorLike;
        const seqLen = embeds.dims[1];
        const logits = new Float32Array(seqLen * 8194).fill(-100);
        // Step 1 -> emit speech token 123; Step 2 -> emit speech token 456; Step 3 -> emit STOP_SPEECH_TOKEN (6562)
        const targetToken = lmStepCount === 1 ? 123 : lmStepCount === 2 ? 456 : STOP_SPEECH_TOKEN;
        logits[(seqLen - 1) * 8194 + targetToken] = 50;

        const out: Record<string, OrtTensorLike> = {
          logits: makeOutputTensor('float32', logits, [1, seqLen, 8194], `lm_logits_${lmStepCount}`),
        };
        for (let l = 0; l < CHATTERBOX_LM_NUM_LAYERS; l += 1) {
          out[`present.${l}.key`] = makeOutputTensor(
            'float16',
            new Uint16Array(16 * lmStepCount * 64),
            [1, 16, lmStepCount, 64],
            `lm_kv_${lmStepCount}_${l}_k`
          );
          out[`present.${l}.value`] = makeOutputTensor(
            'float16',
            new Uint16Array(16 * lmStepCount * 64),
            [1, 16, lmStepCount, 64],
            `lm_kv_${lmStepCount}_${l}_v`
          );
        }
        return out;
      },
      async release() {
        releasedSessions.push('language_model');
      },
    };

    const conditionalDecoderSession: OrtSessionLike = {
      inputNames: ['speech_tokens', 'speaker_embeddings', 'speaker_features'],
      outputNames: ['waveform'],
      async run(feeds) {
        const tokensTensor = feeds.speech_tokens as OrtTensorLike;
        decoderSpeechTokens = new BigInt64Array(tokensTensor.data as BigInt64Array);
        return {
          waveform: makeOutputTensor(
            'float32',
            new Float32Array(2400).fill(0.125),
            [1, 2400],
            'dec_waveform'
          ),
        };
      },
      async release() {
        releasedSessions.push('conditional_decoder');
      },
    };

    const sessionsInOrder = [
      speechEncoderSession,
      embedTokensSession,
      languageModelSession,
      conditionalDecoderSession,
    ];
    let createIndex = 0;

    const engine = new ChatterboxEngine({
      useWorker: false,
      dependencies: {
        detectHardware: async () => makeCapabilities({ shaderF16Supported: true }),
        downloadModel: async () => undefined,
        readArtifact: async (_id, _rev, path) =>
          path === 'tokenizer.json' ? null : new Uint8Array([1, 2, 3, 4]).buffer,
        createSession: async (_bytes, options) => {
          sessionCalls.push({
            externalData: options.externalData,
            executionProviders: options.executionProviders,
          });
          return sessionsInOrder[createIndex++];
        },
        createTensor: (type, data, dims) => makeMockTensor(type, data, dims, type),
      },
    });

    await engine.initialize({ executionMode: 'quality' });
    expect(engine.precision).toBe('q4f16');
    expect(sessionCalls).toHaveLength(4);
    expect(sessionCalls[2].executionProviders).toEqual(['webgpu']);
    expect(
      (sessionCalls[2].externalData as Array<{ path: string }>)[0].path
    ).toBe('language_model_q4f16.onnx_data');

    const payload = await engine.encodeVoice(
      {
        samples: new Float32Array(24000).fill(0.1),
        sampleRate: 24000,
        channels: 1,
        durationSec: 1.0,
      },
      makeReferenceMetadata()
    );
    expect(payload.engineId).toBe('chatterbox');
    expect(payload.modelRevision).toBe(CHATTERBOX_MODEL_REVISION);
    expect(Object.keys(payload.tensors)).toEqual([
      'audio_features',
      'audio_tokens',
      'speaker_embeddings',
      'speaker_features',
    ]);
    // speech_encoder outputs disposed right after .getData()
    expect(disposedOutputs).toContain('se_audio_features');
    expect(disposedOutputs).toContain('se_speaker_features');

    const handle = await engine.loadVoiceProfile(
      makeVoiceProfile({ [`chatterbox::${CHATTERBOX_MODEL_REVISION}`]: payload })
    );

    const chunks: number[] = [];
    const result = await engine.synthesize(
      {
        text: 'Hello world',
        voiceHandle: handle,
        language: 'en',
        parameters: {
          exaggeration: 0.7,
          temperature: 0.8,
          repetitionPenalty: 1.2,
          topP: 0.95,
          seed: 42,
        },
      },
      (chunk) => chunks.push(chunk.samples.length)
    );

    expect(lmStepCount).toBe(3);
    expect(Array.from(decoderSpeechTokens ?? [])).toEqual([
      10n,
      20n,
      123n,
      456n,
      BigInt(SILENCE_TOKEN),
      BigInt(SILENCE_TOKEN),
      BigInt(SILENCE_TOKEN),
    ]);
    expect(result.audio.sampleRate).toBe(CHATTERBOX_SAMPLE_RATE);
    expect(result.audio.samples.length).toBe(2400);
    expect(chunks).toEqual([2400]);

    // Verify all 3 steps of 60 KV tensors (180 total) were disposed
    const disposedKvCount = disposedOutputs.filter((tag) => tag.startsWith('lm_kv_')).length;
    expect(disposedKvCount).toBe(3 * CHATTERBOX_LM_NUM_LAYERS * 2);
    expect(disposedOutputs).toContain('dec_waveform');

    await engine.dispose();
    expect(releasedSessions).toEqual([
      'speech_encoder',
      'embed_tokens',
      'language_model',
      'conditional_decoder',
    ]);
  });

  it('aborts cleanly mid-generation when cancel() or AbortSignal fires and disposes KV tensors', async () => {
    const disposedKv: string[] = [];
    let step = 0;

    const makeMockTensor = (
      type: string,
      data: Float32Array | BigInt64Array | Uint16Array,
      dims: readonly number[]
    ): OrtTensorLike => ({
      dims: [...dims],
      type,
      data,
      async getData() {
        return data;
      },
      dispose() {
        if (type === 'float16') disposedKv.push('past_init');
      },
    });

    const controller = new AbortController();

    const engine = new ChatterboxEngine({
      useWorker: false,
      dependencies: {
        detectHardware: async () => makeCapabilities({ shaderF16Supported: true }),
        downloadModel: async () => undefined,
        readArtifact: async (_id, _rev, path) =>
          path === 'tokenizer.json' ? null : new Uint8Array([1]).buffer,
        createTensor: makeMockTensor,
        createSession: async (_bytes, opts) => {
          const extPath = (opts.externalData as Array<{ path: string }>)[0].path;
          if (extPath.startsWith('embed_tokens')) {
            return {
              inputNames: ['input_ids', 'position_ids', 'exaggeration'],
              outputNames: ['inputs_embeds'],
              async run(feeds) {
                const len = (feeds.input_ids as OrtTensorLike).dims[1];
                return {
                  inputs_embeds: makeMockTensor('float32', new Float32Array(len * 1024), [
                    1,
                    len,
                    1024,
                  ]),
                };
              },
              async release() {},
            };
          }
          if (extPath.startsWith('language_model')) {
            return {
              inputNames: ['inputs_embeds', 'attention_mask'],
              outputNames: ['logits'],
              async run(feeds) {
                step += 1;
                if (step === 2) {
                  controller.abort();
                }
                const seqLen = (feeds.inputs_embeds as OrtTensorLike).dims[1];
                const logits = new Float32Array(seqLen * 8194).fill(-100);
                logits[(seqLen - 1) * 8194 + 500] = 20;
                const out: Record<string, OrtTensorLike> = {
                  logits: makeMockTensor('float32', logits, [1, seqLen, 8194]),
                };
                for (let l = 0; l < CHATTERBOX_LM_NUM_LAYERS; l += 1) {
                  const tag = `step${step}_${l}`;
                  out[`present.${l}.key`] = {
                    dims: [1, 16, step, 64],
                    type: 'float16',
                    async getData() {
                      return new Uint16Array(0);
                    },
                    dispose() {
                      disposedKv.push(`${tag}_k`);
                    },
                  };
                  out[`present.${l}.value`] = {
                    dims: [1, 16, step, 64],
                    type: 'float16',
                    async getData() {
                      return new Uint16Array(0);
                    },
                    dispose() {
                      disposedKv.push(`${tag}_v`);
                    },
                  };
                }
                return out;
              },
              async release() {},
            };
          }
          return {
            inputNames: [],
            outputNames: [],
            async run() {
              return {};
            },
            async release() {},
          };
        },
      },
    });

    await engine.initialize({ executionMode: 'quality' });

    const payload: VoiceConditioningPayload = {
      engineId: 'chatterbox',
      modelRevision: CHATTERBOX_MODEL_REVISION,
      payloadVersion: 1,
      precision: 'q4f16',
      tensors: {
        audio_features: {
          dtype: 'float32',
          dims: [1, 2, 1024],
          data: new Float32Array(2 * 1024).buffer,
        },
        audio_tokens: {
          dtype: 'int64',
          dims: [1, 1],
          data: new BigInt64Array([1n]).buffer,
        },
        speaker_embeddings: {
          dtype: 'float32',
          dims: [1, 192],
          data: new Float32Array(192).buffer,
        },
        speaker_features: {
          dtype: 'float32',
          dims: [1, 2, 80],
          data: new Float32Array(2 * 80).buffer,
        },
      },
      createdAt: '2026-11-25T00:00:00Z',
    };

    const handle = await engine.loadVoiceProfile(
      makeVoiceProfile({ [`chatterbox::${CHATTERBOX_MODEL_REVISION}`]: payload })
    );

    await expect(
      engine.synthesize({
        text: 'This should abort cleanly mid-loop.',
        voiceHandle: handle,
        language: 'en',
        signal: controller.signal,
      })
    ).rejects.toMatchObject({ name: 'AbortError' });

    // Initial 60 KV + step 1 60 KV + step 2 60 KV = 180 tensors disposed
    expect(disposedKv).toHaveLength(3 * CHATTERBOX_LM_NUM_LAYERS * 2);
  });

  it('samples next speech token deterministically with seed and respects repetition penalty', () => {
    const logits = new Float32Array(8194).fill(-50);
    logits[100] = 4.0;
    logits[200] = 3.5;
    logits[START_SPEECH_TOKEN] = 100.0; // Must be suppressed

    const pickedWithoutPenalty = sampleNextSpeechToken(logits, [], {
      temperature: 0.2,
      repetitionPenalty: 1.2,
      topP: 0.95,
      rng: () => 0.1,
    });
    expect(pickedWithoutPenalty).toBe(100);

    // With token 100 in history and strong repetition penalty, token 200 (3.5 vs 4.0/1.6 = 2.5) wins
    const pickedWithPenalty = sampleNextSpeechToken(logits, [100], {
      temperature: 0.2,
      repetitionPenalty: 1.6,
      topP: 0.95,
      rng: () => 0.1,
    });
    expect(pickedWithPenalty).toBe(200);
  });
});
