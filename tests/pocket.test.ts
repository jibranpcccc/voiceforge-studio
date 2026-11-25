import { describe, expect, it, vi } from 'vitest';
import {
  POCKET_ENGINE_ID,
  POCKET_MODEL_REVISION,
  POCKET_PAYLOAD_VERSION,
  POCKET_SAMPLE_RATE,
  PocketTtsEngine,
  SentencePieceType,
  SentencePieceUnigramTokenizer,
  applyEndOnPause,
  downmixToMono,
  parseNpy,
  parseNpyFloat32,
  preparePocketTextPrompt,
  preprocessReferenceAudio,
  resampleMonoPcm,
  splitPocketTextIntoChunks,
} from '../src/engines/pocket';
import type {
  AudioBufferData,
  ReferenceClipMetadata,
  SerializedTensorData,
  VoiceProfile,
} from '../src/types';

function makeNpyV1Float32(shape: number[], values: number[], bigEndian = false): ArrayBuffer {
  const descr = bigEndian ? '>f4' : '<f4';
  const shapeStr = shape.length === 1 ? `(${shape[0]},)` : `(${shape.join(', ')})`;
  let dict = `{'descr': '${descr}', 'fortran_order': False, 'shape': ${shapeStr}, }`;
  // Pad header so (10 + headerLen) is a multiple of 64 bytes, ending with '\n'
  const totalUnpadded = 10 + dict.length + 1;
  const pad = (64 - (totalUnpadded % 64)) % 64;
  dict = dict + ' '.repeat(pad) + '\n';

  const headerBytes = new TextEncoder().encode(dict);
  const payloadBytes = values.length * 4;
  const out = new Uint8Array(10 + headerBytes.length + payloadBytes);
  out.set([0x93, 0x4e, 0x55, 0x4d, 0x50, 0x59, 0x01, 0x00], 0);
  const view = new DataView(out.buffer);
  view.setUint16(8, headerBytes.length, true);
  out.set(headerBytes, 10);

  const dataOffset = 10 + headerBytes.length;
  for (let i = 0; i < values.length; i++) {
    view.setFloat32(dataOffset + i * 4, values[i], !bigEndian);
  }
  return out.buffer;
}

function makeNpyV2Float32(shape: number[], values: number[]): ArrayBuffer {
  const shapeStr = shape.length === 1 ? `(${shape[0]},)` : `(${shape.join(', ')})`;
  const dict = `{'descr': '<f4', 'fortran_order': False, 'shape': ${shapeStr}, }\n`;
  const headerBytes = new TextEncoder().encode(dict);
  const out = new Uint8Array(12 + headerBytes.length + values.length * 4);
  out.set([0x93, 0x4e, 0x55, 0x4d, 0x50, 0x59, 0x02, 0x00], 0);
  const view = new DataView(out.buffer);
  view.setUint32(8, headerBytes.length, true);
  out.set(headerBytes, 12);
  const dataOffset = 12 + headerBytes.length;
  for (let i = 0; i < values.length; i++) {
    view.setFloat32(dataOffset + i * 4, values[i], true);
  }
  return out.buffer;
}

function encodeVarint(val: number): number[] {
  let v = val >>> 0;
  const bytes: number[] = [];
  while (v >= 0x80) {
    bytes.push((v & 0x7f) | 0x80);
    v >>>= 7;
  }
  bytes.push(v);
  return bytes;
}

function pbFieldBytes(fieldNum: number, payload: Uint8Array): Uint8Array {
  const tag = encodeVarint((fieldNum << 3) | 2);
  const len = encodeVarint(payload.length);
  const out = new Uint8Array(tag.length + len.length + payload.length);
  out.set(tag, 0);
  out.set(len, tag.length);
  out.set(payload, tag.length + len.length);
  return out;
}

function pbFieldVarint(fieldNum: number, val: number): Uint8Array {
  const tag = encodeVarint((fieldNum << 3) | 0);
  const v = encodeVarint(val);
  return new Uint8Array([...tag, ...v]);
}

function pbFieldFloat(fieldNum: number, val: number): Uint8Array {
  const tag = encodeVarint((fieldNum << 3) | 5);
  const buf = new ArrayBuffer(4);
  new DataView(buf).setFloat32(0, val, true);
  return new Uint8Array([...tag, ...new Uint8Array(buf)]);
}

function concatBytes(parts: Uint8Array[]): Uint8Array {
  const total = parts.reduce((acc, p) => acc + p.length, 0);
  const out = new Uint8Array(total);
  let offset = 0;
  for (const p of parts) {
    out.set(p, offset);
    offset += p.length;
  }
  return out;
}

function buildTestSentencePieceModel(): Uint8Array {
  const enc = new TextEncoder();
  const makePiece = (piece: string, score: number, type: number) =>
    pbFieldBytes(
      1,
      concatBytes([
        pbFieldBytes(1, enc.encode(piece)),
        pbFieldFloat(2, score),
        pbFieldVarint(3, type),
      ])
    );

  const pieces: Uint8Array[] = [
    makePiece('<unk>', 0, SentencePieceType.UNKNOWN),
    makePiece('<s>', 0, SentencePieceType.CONTROL),
    makePiece('</s>', 0, SentencePieceType.CONTROL),
    makePiece('<pad>', 0, SentencePieceType.CONTROL),
  ];

  // Add all 256 byte fallback tokens (IDs 4..259)
  for (let b = 0; b < 256; b++) {
    const label = `<0x${b.toString(16).toUpperCase().padStart(2, '0')}>`;
    pieces.push(makePiece(label, 0, SentencePieceType.BYTE));
  }

  // Normal vocab pieces
  const vocab: Array<[string, number]> = [
    ['\u2581', -3.0],
    ['\u2581Hello', -1.2],
    ['\u2581world', -1.5],
    ['\u2581Dr', -2.0],
    ['\u2581Smith', -2.0],
    ['\u2581went', -2.0],
    ['\u2581to', -1.8],
    ['\u2581town', -2.2],
    ['\u2581the', -1.1],
    ['\u2581price', -2.1],
    ['\u2581is', -1.5],
    ['\u2581$', -3.5],
    [',', -2.0],
    ['.', -1.8],
    ['!', -2.2],
    ['?', -2.3],
    [';', -2.5],
    [':', -2.5],
    ['H', -5.0],
    ['e', -4.5],
    ['l', -4.5],
    ['o', -4.5],
    ['w', -4.5],
    ['r', -4.5],
    ['d', -4.5],
    ['a', -4.5],
    ['b', -4.5],
    ['c', -4.5],
    ['1', -3.5],
    ['2', -3.5],
    ['3', -3.5],
    ['4', -3.5],
    ['5', -3.5],
    ['8', -3.5],
    ['9', -3.5],
    ['0', -3.5],
    ['\u2581a', -2.8],
    ['\u2581word', -1.9],
  ];
  for (const [piece, score] of vocab) {
    pieces.push(makePiece(piece, score, SentencePieceType.NORMAL));
  }

  const trainerSpec = pbFieldBytes(
    2,
    concatBytes([
      pbFieldVarint(3, 1), // UNIGRAM
      pbFieldVarint(4, pieces.length),
      pbFieldVarint(35, 1), // byte_fallback = true
      pbFieldVarint(40, 0),
      pbFieldVarint(41, 1),
      pbFieldVarint(42, 2),
      pbFieldVarint(43, 3),
    ])
  );

  const normalizerSpec = pbFieldBytes(
    3,
    concatBytes([
      pbFieldBytes(1, enc.encode('identity')),
      pbFieldVarint(3, 1), // add_dummy_prefix = true
      pbFieldVarint(4, 0), // remove_extra_whitespaces = false
      pbFieldVarint(5, 1), // escape_whitespaces = true
    ])
  );

  return concatBytes([...pieces, trainerSpec, normalizerSpec]);
}

function makeDummyStateTensors(): Record<string, SerializedTensorData> {
  const tensors: Record<string, SerializedTensorData> = {};
  for (let layer = 0; layer < 6; layer++) {
    const idx = layer * 3;
    tensors[`state_${idx}`] = {
      dtype: 'float32',
      dims: [2, 1, 1000, 16, 64],
      data: new Float32Array(4).buffer,
    };
    tensors[`state_${idx + 1}`] = {
      dtype: 'float32',
      dims: [0],
      data: new Float32Array(0).buffer,
    };
    tensors[`state_${idx + 2}`] = {
      dtype: 'int64',
      dims: [1],
      data: new BigInt64Array([12n]).buffer,
    };
  }
  return tensors;
}

function makeVoiceProfile(overrides: Partial<VoiceProfile> = {}): VoiceProfile {
  const key = `${POCKET_ENGINE_ID}::${POCKET_MODEL_REVISION}`;
  return {
    id: 'voice-1',
    name: 'Test Speaker',
    language: 'en',
    tags: [],
    referenceClip: {
      clipId: 'clip-1',
      filename: 'ref.wav',
      mimeType: 'audio/wav',
      source: 'file-upload',
      durationSec: 5,
      sampleRate: 24000,
      channels: 1,
      capturedAt: '2026-11-25T00:00:00.000Z',
    },
    qualityAnalysis: {
      clipping: { clippedSampleCount: 0, clippedPercentage: 0, hasSevereClipping: false },
      silence: {
        leadingSilenceSec: 0.05,
        trailingSilenceSec: 0.08,
        silenceRatio: 0.1,
        activeSpeechDurationSec: 4.8,
      },
      noiseFloorDb: -55,
      estimatedSnrDb: 35,
      rmsDb: -18,
      peakDb: -2,
      reverbEstimate: { score: 0.1, level: 'dry' },
      multiSpeakerEstimate: { score: 0.05, suspectedMultipleSpeakers: false },
      durationSec: 5,
      sampleRate: 24000,
      channels: 1,
      overallScore: 92,
      warnings: [],
      recommendations: [],
    },
    authorizedUse: {
      confirmed: true,
      confirmedAt: '2026-11-25T00:00:00.000Z',
      attestationText: 'Authorized test voice',
      sourceBasis: 'self',
      verificationScope: 'client-self-attested',
    },
    conditioningPayloads: {
      [key]: {
        engineId: POCKET_ENGINE_ID,
        modelRevision: POCKET_MODEL_REVISION,
        payloadVersion: POCKET_PAYLOAD_VERSION,
        precision: 'int8',
        tensors: makeDummyStateTensors(),
        createdAt: '2026-11-25T00:00:00.000Z',
      },
    },
    createdAt: '2026-11-25T00:00:00.000Z',
    updatedAt: '2026-11-25T00:00:00.000Z',
    ...overrides,
  };
}

class MockWorker {
  private listeners = new Map<string, Set<(ev: MessageEvent) => void>>();
  public postedMessages: unknown[] = [];
  public terminated = false;

  addEventListener(type: string, cb: (ev: MessageEvent) => void): void {
    let set = this.listeners.get(type);
    if (!set) {
      set = new Set();
      this.listeners.set(type, set);
    }
    set.add(cb);
  }

  removeEventListener(type: string, cb: (ev: MessageEvent) => void): void {
    this.listeners.get(type)?.delete(cb);
  }

  private emit(data: unknown): void {
    const event = { data } as MessageEvent;
    for (const cb of this.listeners.get('message') ?? []) {
      cb(event);
    }
  }

  postMessage(msg: Record<string, unknown>): void {
    this.postedMessages.push(msg);
    const id = msg.id as number;
    switch (msg.type) {
      case 'init':
        this.emit({
          type: 'progress',
          id,
          progress: { phase: 'ready', item: 'pocket-tts', progress: 1, message: 'Ready' },
        });
        this.emit({
          type: 'init-done',
          id,
          totalSizeBytes: 146_243_590,
          numThreads: 1,
          modelRevision: msg.modelRevision,
        });
        break;
      case 'encode-voice':
        this.emit({
          type: 'encode-voice-done',
          id,
          tensors: makeDummyStateTensors(),
          metadata: {
            sampleRate: 24000,
            voiceFrameCount: 25,
            conditionedDurationSec: msg.durationSec,
            truncated: msg.truncated,
          },
        });
        break;
      case 'load-voice':
        this.emit({
          type: 'load-voice-done',
          id,
          handleId: msg.handleId,
        });
        break;
      case 'synthesize': {
        const chunk1 = new Float32Array([0.1, 0.2, -0.1, -0.2]);
        const chunk2 = new Float32Array([0.05, -0.05]);
        this.emit({
          type: 'synth-chunk',
          id,
          chunk: {
            chunkIndex: 0,
            samples: chunk1,
            sampleRate: 24000,
            durationSec: chunk1.length / 24000,
            isFinal: false,
          },
        });
        this.emit({
          type: 'synth-chunk',
          id,
          chunk: {
            chunkIndex: 1,
            samples: chunk2,
            sampleRate: 24000,
            durationSec: chunk2.length / 24000,
            isFinal: true,
          },
        });
        this.emit({
          type: 'synth-done',
          id,
          generationTimeMs: 42,
          totalSamples: chunk1.length + chunk2.length,
        });
        break;
      }
      case 'dispose':
        this.emit({ type: 'dispose-done', id });
        break;
    }
  }

  terminate(): void {
    this.terminated = true;
  }
}

describe('Pocket TTS NPY parser', () => {
  it('parses NPY v1.0 Float32 little-endian and big-endian arrays', () => {
    const le = makeNpyV1Float32([1, 2, 2], [0.25, -0.5, 1.5, 3.25], false);
    const parsedLe = parseNpyFloat32(le);
    expect(parsedLe.shape).toEqual([1, 2, 2]);
    expect(Array.from(parsedLe.data)).toEqual([0.25, -0.5, 1.5, 3.25]);

    const be = makeNpyV1Float32([1, 1, 2], [1.25, -2.5], true);
    const parsedBe = parseNpyFloat32(be);
    expect(parsedBe.shape).toEqual([1, 1, 2]);
    expect(Array.from(parsedBe.data)).toEqual([1.25, -2.5]);
  });

  it('parses NPY v2.0 Float32 arrays and rejects malformed buffers', () => {
    const v2 = makeNpyV2Float32([3], [1, 2, 3]);
    const parsed = parseNpy(v2);
    expect(parsed.shape).toEqual([3]);
    expect(Array.from(parsed.data as Float32Array)).toEqual([1, 2, 3]);

    expect(() => parseNpy(new Uint8Array([1, 2, 3, 4]))).toThrow(/too short/i);
    expect(() => parseNpy(new Uint8Array(20))).toThrow(/magic/i);
  });
});

describe('Pocket TTS pure-TS SentencePiece tokenizer and chunking', () => {
  it('parses SentencePiece protobuf and performs Viterbi Unigram + byte fallback', () => {
    const modelBytes = buildTestSentencePieceModel();
    const tokenizer = SentencePieceUnigramTokenizer.fromBuffer(modelBytes);

    expect(tokenizer.trainerSpec.unkId).toBe(0);
    expect(tokenizer.trainerSpec.bosId).toBe(1);
    expect(tokenizer.trainerSpec.eosId).toBe(2);
    expect(tokenizer.trainerSpec.padId).toBe(3);
    expect(tokenizer.trainerSpec.byteFallback).toBe(true);

    const ids = tokenizer.encode('Hello, world!');
    // Should prefer whole-word pieces ("▁Hello", ",", "▁world", "!") over single characters
    expect(ids.length).toBe(4);
    expect(tokenizer.decode(ids)).toBe('Hello, world!');

    // Byte fallback round-trip for non-vocab UTF-8 emoji
    const emojiIds = tokenizer.encode('Hello 😊!');
    expect(tokenizer.decode(emojiIds)).toBe('Hello 😊!');
  });

  it('normalizes prompts per bundle.json flags and chunks <= maxTokensPerChunk', () => {
    const tokenizer = SentencePieceUnigramTokenizer.fromBuffer(buildTestSentencePieceModel());

    const shortPrompt = preparePocketTextPrompt('hello; world', {
      padWithSpacesForShortInputs: true,
      removeSemicolons: true,
    });
    expect(shortPrompt.framesAfterEosGuess).toBe(3);
    expect(shortPrompt.text).toBe('        Hello, world.');

    const longText = Array.from({ length: 12 }, () => 'Hello world a word.').join(' ');
    const chunks = splitPocketTextIntoChunks(tokenizer, longText, {
      maxTokensPerChunk: 20,
      padWithSpacesForShortInputs: false,
      removeSemicolons: false,
    });

    expect(chunks.length).toBeGreaterThan(1);
    for (const chunk of chunks) {
      expect(tokenizer.encode(chunk).length).toBeLessThanOrEqual(20);
    }

    // Preserves title & decimal numbers without splitting into invalid fragments
    const decimalChunks = splitPocketTextIntoChunks(
      tokenizer,
      'Dr. Smith went to town. The price is $822.95.',
      {
        maxTokensPerChunk: 50,
        padWithSpacesForShortInputs: false,
        removeSemicolons: false,
      }
    );
    expect(decimalChunks.join(' ')).toContain('$822.95.');
  });
});

describe('Pocket TTS reference audio preprocessing (end_on_pause)', () => {
  it('trims trailing silence >35 dB below peak, applies 20ms fade-out, and appends 80ms silence', () => {
    const sr = POCKET_SAMPLE_RATE;
    const speechSamples = Math.floor(0.5 * sr); // 500ms speech
    const trailingSilenceSamples = Math.floor(0.5 * sr); // 500ms digital silence
    const input = new Float32Array(speechSamples + trailingSilenceSamples);
    for (let i = 0; i < speechSamples; i++) {
      input[i] = 0.5 * Math.sin((2 * Math.PI * 220 * i) / sr);
    }

    const processed = applyEndOnPause(input, sr);
    const expectedFadeSamples = Math.floor(0.02 * sr); // 480
    const expectedPauseSamples = Math.floor(0.08 * sr); // 1920

    expect(processed.length).toBe(speechSamples + expectedPauseSamples);
    // Final 80ms must be exact zeros
    for (let i = speechSamples; i < processed.length; i++) {
      expect(processed[i]).toBe(0);
    }
    // Last sample before 80ms silence should be faded to 0
    expect(Math.abs(processed[speechSamples - 1])).toBeLessThan(1e-6);
    // Beginning of fade-out should remain near full amplitude
    expect(Math.abs(processed[speechSamples - expectedFadeSamples - 1])).toBeGreaterThan(0);
  });

  it('downmixes stereo, resamples to 24kHz, and caps reference audio at 30s', () => {
    const stereo = new Float32Array(48000 * 2);
    for (let i = 0; i < 48000; i++) {
      stereo[i * 2] = 0.6;
      stereo[i * 2 + 1] = 0.2;
    }
    const mono = downmixToMono(stereo, 2);
    expect(mono.length).toBe(48000);
    expect(mono[100]).toBeCloseTo(0.4, 5);

    const resampled = resampleMonoPcm(mono, 48000, 24000);
    expect(resampled.length).toBe(24000);

    const longAudio: AudioBufferData = {
      samples: new Float32Array(24000 * 35).fill(0.25),
      sampleRate: 24000,
      channels: 1,
      durationSec: 35,
    };
    const prep = preprocessReferenceAudio(longAudio, 30);
    expect(prep.truncated).toBe(true);
    expect(prep.sampleRate).toBe(24000);
    expect(prep.durationSec).toBeLessThanOrEqual(30.1);
    expect(prep.warnings.length).toBeGreaterThan(0);
  });
});

describe('PocketTtsEngine contract, scoping, and worker orchestration', () => {
  it('strictly rejects mismatched engineId, modelRevision, or missing tensors in loadVoiceProfile', async () => {
    const mockWorker = new MockWorker();
    const engine = new PocketTtsEngine({
      workerFactory: () => mockWorker as unknown as Worker,
    });
    await engine.initialize({ executionMode: 'cpu' });

    const validProfile = makeVoiceProfile();

    // Wrong engineId under expected key
    const wrongEngineProfile = makeVoiceProfile({
      conditioningPayloads: {
        [`${POCKET_ENGINE_ID}::${POCKET_MODEL_REVISION}`]: {
          ...validProfile.conditioningPayloads[`${POCKET_ENGINE_ID}::${POCKET_MODEL_REVISION}`],
          engineId: 'chatterbox',
        },
      },
    });
    await expect(engine.loadVoiceProfile(wrongEngineProfile)).rejects.toThrow(/engine mismatch/i);

    // Wrong modelRevision under expected key
    const wrongRevProfile = makeVoiceProfile({
      conditioningPayloads: {
        [`${POCKET_ENGINE_ID}::${POCKET_MODEL_REVISION}`]: {
          ...validProfile.conditioningPayloads[`${POCKET_ENGINE_ID}::${POCKET_MODEL_REVISION}`],
          modelRevision: 'deadbeef0000000',
        },
      },
    });
    await expect(engine.loadVoiceProfile(wrongRevProfile)).rejects.toThrow(/revision mismatch/i);

    // Profile conditioned only for another engine
    const otherEngineProfile = makeVoiceProfile({
      conditioningPayloads: {
        'chatterbox::abc123': {
          engineId: 'chatterbox',
          modelRevision: 'abc123',
          payloadVersion: 1,
          precision: 'q4f16',
          tensors: {},
          createdAt: '2026-11-25T00:00:00.000Z',
        },
      },
    });
    await expect(engine.loadVoiceProfile(otherEngineProfile)).rejects.toThrow(
      /lacks conditioning payload/i
    );

    await engine.dispose();
  });

  it('runs encodeVoice, loadVoiceProfile (non-destructive buffers), synthesize streaming, and dispose via worker', async () => {
    const mockWorker = new MockWorker();
    const engine = new PocketTtsEngine({
      workerFactory: () => mockWorker as unknown as Worker,
    });

    const progressPhases: string[] = [];
    await engine.initialize({ executionMode: 'cpu' }, (p) => progressPhases.push(p.phase));
    expect(progressPhases).toContain('ready');
    expect(engine.getModelMetadata().isInitialized).toBe(true);
    expect(engine.getModelMetadata().activeBackend).toBe('wasm');

    const refAudio: AudioBufferData = {
      samples: new Float32Array(24000 * 4).fill(0.1),
      sampleRate: 24000,
      channels: 1,
      durationSec: 4,
    };
    const clipMeta: ReferenceClipMetadata = {
      clipId: 'clip-abc',
      filename: 'voice.wav',
      mimeType: 'audio/wav',
      source: 'microphone',
      durationSec: 4,
      sampleRate: 24000,
      channels: 1,
      capturedAt: '2026-11-25T00:00:00.000Z',
    };

    const payload = await engine.encodeVoice(refAudio, clipMeta);
    expect(payload.engineId).toBe(POCKET_ENGINE_ID);
    expect(payload.modelRevision).toBe(POCKET_MODEL_REVISION);
    expect(payload.payloadVersion).toBe(POCKET_PAYLOAD_VERSION);

    const profile = makeVoiceProfile({
      conditioningPayloads: {
        [`${POCKET_ENGINE_ID}::${POCKET_MODEL_REVISION}`]: payload,
      },
    });

    const handle = await engine.loadVoiceProfile(profile);
    expect(handle.engineId).toBe(POCKET_ENGINE_ID);
    // Ensure caller ArrayBuffers were cloned, not detached
    expect(payload.tensors.state_0.data.byteLength).toBeGreaterThan(0);

    const onChunk = vi.fn();
    const result = await engine.synthesize(
      {
        text: 'Hello from Pocket TTS.',
        voiceHandle: handle,
        language: 'en',
        parameters: { temperature: 0.6, lsdSteps: 2, framesAfterEos: 3, seed: 42 },
      },
      onChunk
    );

    expect(onChunk).toHaveBeenCalledTimes(2);
    expect(result.backend).toBe('wasm');
    expect(result.audio.sampleRate).toBe(24000);
    expect(result.audio.samples.length).toBe(6);

    const synthMsg = mockWorker.postedMessages.find(
      (m) => (m as { type?: string }).type === 'synthesize'
    ) as { temperature: number; lsdSteps: number; framesAfterEos: number; seed: number };
    expect(synthMsg).toMatchObject({
      temperature: 0.6,
      lsdSteps: 2,
      framesAfterEos: 3,
      seed: 42,
    });

    await engine.dispose();
    expect(mockWorker.terminated).toBe(true);
    expect(engine.getModelMetadata().isInitialized).toBe(false);
  });

  it('exposes supported languages, generation parameters, and hardware compatibility', async () => {
    const engine = new PocketTtsEngine();
    expect(engine.getSupportedLanguages()).toEqual([
      { code: 'en', name: 'English', nativeName: 'English' },
    ]);
    const paramKeys = engine.getGenerationParameters().map((p) => p.key);
    expect(paramKeys).toEqual(['temperature', 'lsdSteps', 'framesAfterEos', 'seed']);

    const compat = await engine.checkHardwareCompatibility();
    expect(compat.engineId).toBe(POCKET_ENGINE_ID);
    expect(compat.recommendedBackend).toBe('wasm');
  });
});
