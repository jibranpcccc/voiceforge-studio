/// <reference lib="webworker" />
import * as ort from 'onnxruntime-web/wasm';
import type {
  ModelManifestEntry,
  SerializedTensorData,
  SynthesizedAudioChunk,
} from '../types';
import {
  downloadAndCacheModel,
  getCachedArtifact,
} from '../storage/modelCache';
import {
  POCKET_CONDITIONING_DIM,
  POCKET_DEFAULT_MAX_TOKENS,
  POCKET_EOS_THRESHOLD,
  POCKET_FRAME_RATE,
  POCKET_GEN_SECONDS_PADDING,
  POCKET_LATENT_DIM,
  POCKET_MODEL_MANIFEST_ENTRY,
  POCKET_SAMPLE_RATE,
  POCKET_TOKENS_PER_SECOND_ESTIMATE,
  type PocketBundleConfig,
  type PocketStateDtype,
  type PocketStateSpec,
  type PocketWorkerRequest,
  type PocketWorkerResponse,
} from '../engines/pocket/constants';
import { parseNpyFloat32 } from '../engines/pocket/npy';
import {
  preparePocketTextPrompt,
  SentencePieceUnigramTokenizer,
  splitPocketTextIntoChunks,
} from '../engines/pocket/tokenizer';

type TensorMap = Record<string, ort.Tensor>;

interface WorkerRuntimeState {
  initialized: boolean;
  manifestEntry: ModelManifestEntry;
  bundle: PocketBundleConfig | null;
  tokenizer: SentencePieceUnigramTokenizer | null;
  bosBeforeVoice: { shape: number[]; data: Float32Array } | null;
  sessions: {
    textConditioner: ort.InferenceSession | null;
    flowLmMain: ort.InferenceSession | null;
    flowLmFlow: ort.InferenceSession | null;
    mimiDecoder: ort.InferenceSession | null;
    mimiEncoder: ort.InferenceSession | null;
  };
  voiceStates: Map<string, TensorMap>;
  activeAbortController: AbortController | null;
  cancelled: boolean;
}

const state: WorkerRuntimeState = {
  initialized: false,
  manifestEntry: POCKET_MODEL_MANIFEST_ENTRY,
  bundle: null,
  tokenizer: null,
  bosBeforeVoice: null,
  sessions: {
    textConditioner: null,
    flowLmMain: null,
    flowLmFlow: null,
    mimiDecoder: null,
    mimiEncoder: null,
  },
  voiceStates: new Map(),
  activeAbortController: null,
  cancelled: false,
};

function postResponse(msg: PocketWorkerResponse, transfer: Transferable[] = []): void {
  self.postMessage(msg, transfer);
}

function createAbortError(message = 'Operation aborted'): Error {
  const err = new Error(message);
  err.name = 'AbortError';
  return err;
}

function throwIfCancelled(): void {
  if (state.cancelled || state.activeAbortController?.signal.aborted) {
    throw createAbortError('Pocket TTS operation cancelled.');
  }
}

function normalizeWasmBasePath(wasmBasePath: string): string {
  const resolved =
    typeof self.location?.href === 'string' && !self.location.href.startsWith('blob:')
      ? new URL(wasmBasePath, self.location.href).href
      : wasmBasePath;
  return resolved.endsWith('/') ? resolved : `${resolved}/`;
}

function computeProduct(shape: readonly number[]): number {
  let total = 1;
  for (const dim of shape) {
    total *= dim;
  }
  return total;
}

function createFilledStateTensor(spec: PocketStateSpec): ort.Tensor {
  const elementCount = computeProduct(spec.shape);
  switch (spec.dtype) {
    case 'float32': {
      const arr = new Float32Array(elementCount);
      if (spec.fill === 'nan') {
        arr.fill(Number.NaN);
      } else if (spec.fill === 'ones') {
        arr.fill(1);
      }
      return new ort.Tensor('float32', arr, spec.shape);
    }
    case 'float16': {
      const arr = new Uint16Array(elementCount);
      if (spec.fill === 'ones') {
        arr.fill(0x3c00);
      } else if (spec.fill === 'nan') {
        arr.fill(0x7e00);
      }
      return new ort.Tensor('float16', arr, spec.shape);
    }
    case 'int64': {
      const arr = new BigInt64Array(elementCount);
      if (spec.fill === 'ones') {
        arr.fill(1n);
      }
      return new ort.Tensor('int64', arr, spec.shape);
    }
    case 'bool': {
      const arr = new Uint8Array(elementCount);
      if (spec.fill === 'ones') {
        arr.fill(1);
      }
      return new ort.Tensor('bool', arr, spec.shape);
    }
  }
}

function initStateMap(manifest: readonly PocketStateSpec[]): TensorMap {
  const map: TensorMap = {};
  for (const spec of manifest) {
    map[spec.input_name] = createFilledStateTensor(spec);
  }
  return map;
}

function cloneTensor(tensor: ort.Tensor): ort.Tensor {
  const dims = [...tensor.dims];
  const data = tensor.data;
  switch (tensor.type) {
    case 'float32':
      return new ort.Tensor('float32', new Float32Array(data as Float32Array), dims);
    case 'float16':
      return new ort.Tensor('float16', new Uint16Array(data as Uint16Array), dims);
    case 'int64':
      return new ort.Tensor('int64', new BigInt64Array(data as BigInt64Array), dims);
    case 'bool':
      return new ort.Tensor('bool', new Uint8Array(data as Uint8Array), dims);
    case 'int32':
      return new ort.Tensor('int32', new Int32Array(data as Int32Array), dims);
    case 'uint8':
      return new ort.Tensor('uint8', new Uint8Array(data as Uint8Array), dims);
    default:
      throw new Error(`Unsupported tensor type '${tensor.type}' during state clone.`);
  }
}

function cloneTensorMap(source: TensorMap): TensorMap {
  const copy: TensorMap = {};
  for (const [key, tensor] of Object.entries(source)) {
    copy[key] = cloneTensor(tensor);
  }
  return copy;
}

function updateStateFromOutputs(
  target: TensorMap,
  outputs: ort.InferenceSession.ReturnType,
  manifest: readonly PocketStateSpec[]
): void {
  for (const spec of manifest) {
    const updated = outputs[spec.output_name];
    if (!updated) {
      throw new Error(`Missing expected model output '${spec.output_name}'.`);
    }
    target[spec.input_name] = updated as ort.Tensor;
  }
}

function toOwnedArrayBuffer(view: ArrayBufferView): ArrayBuffer {
  const out = new ArrayBuffer(view.byteLength);
  new Uint8Array(out).set(
    new Uint8Array(view.buffer, view.byteOffset, view.byteLength)
  );
  return out;
}

function serializeTensor(tensor: ort.Tensor): {
  serialized: SerializedTensorData;
  transfer: ArrayBuffer;
} {
  const dims = [...tensor.dims];
  const data = tensor.data;
  let dtype: SerializedTensorData['dtype'];
  let buffer: ArrayBuffer;

  switch (tensor.type) {
    case 'float32':
      dtype = 'float32';
      buffer = toOwnedArrayBuffer(data as Float32Array);
      break;
    case 'float16':
      dtype = 'float16';
      buffer = toOwnedArrayBuffer(data as Uint16Array);
      break;
    case 'int64':
      dtype = 'int64';
      buffer = toOwnedArrayBuffer(data as BigInt64Array);
      break;
    case 'bool':
      dtype = 'bool';
      buffer = toOwnedArrayBuffer(data as Uint8Array);
      break;
    case 'int32':
      dtype = 'int32';
      buffer = toOwnedArrayBuffer(data as Int32Array);
      break;
    case 'uint8':
      dtype = 'uint8';
      buffer = toOwnedArrayBuffer(data as Uint8Array);
      break;
    default:
      throw new Error(`Cannot serialize unsupported tensor dtype '${tensor.type}'.`);
  }

  return {
    serialized: {
      dtype,
      dims,
      data: buffer,
    },
    transfer: buffer,
  };
}

function deserializeTensor(entry: SerializedTensorData): ort.Tensor {
  switch (entry.dtype) {
    case 'float32':
      return new ort.Tensor('float32', new Float32Array(entry.data), entry.dims);
    case 'float16':
      return new ort.Tensor('float16', new Uint16Array(entry.data), entry.dims);
    case 'int64':
      return new ort.Tensor('int64', new BigInt64Array(entry.data), entry.dims);
    case 'bool':
      return new ort.Tensor('bool', new Uint8Array(entry.data), entry.dims);
    case 'int32':
      return new ort.Tensor('int32', new Int32Array(entry.data), entry.dims);
    case 'uint8':
      return new ort.Tensor('uint8', new Uint8Array(entry.data), entry.dims);
  }
}

function createGaussianSampler(seed?: number): (std: number) => number {
  const useSeed = typeof seed === 'number' && Number.isFinite(seed) && seed >= 0;
  let s = useSeed ? (seed as number) >>> 0 : 0;
  let spare: number | null = null;

  const nextUniform = (): number => {
    if (useSeed) {
      s = (s + 0x6d2b79f5) | 0;
      let t = Math.imul(s ^ (s >>> 15), 1 | s);
      t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
      return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
    }
    return Math.random();
  };

  return (std: number): number => {
    if (std <= 0) return 0;
    if (spare !== null) {
      const val = spare;
      spare = null;
      return val * std;
    }
    let u1 = nextUniform();
    while (u1 <= 1e-12) {
      u1 = nextUniform();
    }
    const u2 = nextUniform();
    const mag = Math.sqrt(-2.0 * Math.log(u1));
    const z0 = mag * Math.cos(2.0 * Math.PI * u2);
    const z1 = mag * Math.sin(2.0 * Math.PI * u2);
    spare = z1;
    return z0 * std;
  };
}

function concatLatentFrames(frames: readonly Float32Array[], latentDim: number): Float32Array {
  const totalFloats = frames.length * latentDim;
  const out = new Float32Array(totalFloats);
  for (let i = 0; i < frames.length; i++) {
    out.set(frames[i], i * latentDim);
  }
  return out;
}

async function readRequiredArtifact(
  entry: ModelManifestEntry,
  role: string
): Promise<ArrayBuffer> {
  const artifact = entry.artifacts.find((a) => a.role === role);
  if (!artifact) {
    throw new Error(`Missing artifact role '${role}' in manifest for '${entry.engineId}'.`);
  }
  const buffer = await getCachedArtifact(entry.engineId, entry.revision, artifact.relativePath);
  if (!buffer) {
    throw new Error(`Cached artifact '${artifact.relativePath}' not found.`);
  }
  return buffer;
}

async function releaseSessions(): Promise<void> {
  const allSessions = [
    state.sessions.textConditioner,
    state.sessions.flowLmMain,
    state.sessions.flowLmFlow,
    state.sessions.mimiDecoder,
    state.sessions.mimiEncoder,
  ];
  state.sessions.textConditioner = null;
  state.sessions.flowLmMain = null;
  state.sessions.flowLmFlow = null;
  state.sessions.mimiDecoder = null;
  state.sessions.mimiEncoder = null;

  for (const session of allSessions) {
    if (session) {
      try {
        await session.release();
      } catch {
        // Ignore release errors during cleanup.
      }
    }
  }
}

async function handleInit(req: Extract<PocketWorkerRequest, { type: 'init' }>): Promise<void> {
  state.cancelled = false;
  state.activeAbortController = new AbortController();
  const signal = state.activeAbortController.signal;

  await releaseSessions();
  state.voiceStates.clear();
  state.initialized = false;

  const entry: ModelManifestEntry = req.manifestEntry ?? {
    ...POCKET_MODEL_MANIFEST_ENTRY,
    revision: req.modelRevision,
  };
  state.manifestEntry = entry;

  const isolated =
    typeof self.crossOriginIsolated === 'boolean' ? self.crossOriginIsolated : false;
  const hwCores =
    typeof navigator !== 'undefined' && typeof navigator.hardwareConcurrency === 'number'
      ? Math.max(1, Math.floor(navigator.hardwareConcurrency))
      : 1;
  const allowedThreads = isolated ? Math.min(hwCores, 4) : 1;
  const numThreads = isolated
    ? Math.max(1, Math.min(req.wasmThreads ?? allowedThreads, 4))
    : 1;

  ort.env.wasm.wasmPaths = normalizeWasmBasePath(req.wasmBasePath);
  ort.env.wasm.numThreads = numThreads;
  ort.env.wasm.simd = true;

  await downloadAndCacheModel(entry, {
    customBaseUrl: req.customBaseUrl,
    signal,
    onProgress: (p) => {
      postResponse({
        type: 'progress',
        id: req.id,
        progress: {
          phase: p.phase === 'ready' ? 'creating-session' : p.phase,
          item: p.artifact.role,
          progress: p.fraction * 0.7,
          loadedBytes: p.loadedBytes,
          totalBytes: p.totalBytes,
          message:
            p.phase === 'downloading'
              ? `Downloading ${p.artifact.role} (${Math.round(p.fraction * 100)}%)`
              : p.phase === 'verifying'
                ? `Verifying SHA-256 for ${p.artifact.role}`
                : `Checking ${p.artifact.role}`,
        },
      });
    },
  });

  throwIfCancelled();

  // Parse bundle.json, tokenizer.model, and bos_before_voice.npy
  const bundleBuffer = await readRequiredArtifact(entry, 'bundle_config');
  const bundleJson = JSON.parse(new TextDecoder().decode(bundleBuffer)) as PocketBundleConfig;
  state.bundle = bundleJson;

  const tokenizerBuffer = await readRequiredArtifact(entry, 'tokenizer');
  state.tokenizer = SentencePieceUnigramTokenizer.fromBuffer(tokenizerBuffer);

  const bosBuffer = await readRequiredArtifact(entry, 'bos_before_voice');
  state.bosBeforeVoice = parseNpyFloat32(bosBuffer);

  const sessionOptions: ort.InferenceSession.SessionOptions = {
    executionProviders: ['wasm'],
    graphOptimizationLevel: 'all',
  };

  const sessionSpecs: Array<{
    key: keyof WorkerRuntimeState['sessions'];
    role: string;
    label: string;
  }> = [
    { key: 'textConditioner', role: 'text_conditioner', label: 'Text Conditioner' },
    { key: 'flowLmMain', role: 'flow_lm_main', label: 'FlowLM Backbone (INT8)' },
    { key: 'flowLmFlow', role: 'flow_lm_flow', label: 'Flow Matching Head (INT8)' },
    { key: 'mimiDecoder', role: 'mimi_decoder', label: 'Mimi Audio Decoder (INT8)' },
    { key: 'mimiEncoder', role: 'mimi_encoder', label: 'Mimi Voice Encoder (INT8)' },
  ];

  // Load ONNX Runtime sessions sequentially to avoid peak RAM spikes.
  for (let i = 0; i < sessionSpecs.length; i++) {
    throwIfCancelled();
    const spec = sessionSpecs[i];
    postResponse({
      type: 'progress',
      id: req.id,
      progress: {
        phase: 'creating-session',
        item: spec.role,
        progress: 0.7 + (i / sessionSpecs.length) * 0.28,
        message: `Initializing ONNX session: ${spec.label}`,
      },
    });

    const bytes = new Uint8Array(await readRequiredArtifact(entry, spec.role));
    throwIfCancelled();
    state.sessions[spec.key] = await ort.InferenceSession.create(bytes, sessionOptions);
  }

  state.initialized = true;
  state.activeAbortController = null;

  postResponse({
    type: 'progress',
    id: req.id,
    progress: {
      phase: 'ready',
      item: 'pocket-tts',
      progress: 1,
      message: `Pocket TTS ready (WASM, ${numThreads} thread${numThreads > 1 ? 's' : ''})`,
    },
  });

  postResponse({
    type: 'init-done',
    id: req.id,
    totalSizeBytes: entry.totalSizeBytes,
    numThreads,
    modelRevision: entry.revision,
  });
}

async function handleEncodeVoice(
  req: Extract<PocketWorkerRequest, { type: 'encode-voice' }>
): Promise<void> {
  if (
    !state.initialized ||
    !state.bundle ||
    !state.sessions.mimiEncoder ||
    !state.sessions.flowLmMain
  ) {
    throw new Error('Pocket TTS engine is not initialized.');
  }
  state.cancelled = false;

  const audioTensor = new ort.Tensor('float32', req.samples, [1, 1, req.samples.length]);
  const encOut = await state.sessions.mimiEncoder.run({ audio: audioTensor });
  throwIfCancelled();

  const rawLatents = encOut.latents as ort.Tensor | undefined;
  if (!rawLatents) {
    throw new Error('mimi_encoder did not return expected "latents" output.');
  }

  const latentDims = rawLatents.dims;
  const latentFrames = latentDims[latentDims.length - 2] ?? 0;
  const latentDim = latentDims[latentDims.length - 1] ?? POCKET_CONDITIONING_DIM;
  const rawLatentsData = rawLatents.data as Float32Array;

  let voiceLatentsData: Float32Array;
  let totalVoiceFrames = latentFrames;
  if (state.bundle.insert_bos_before_voice && state.bosBeforeVoice) {
    const bosData = state.bosBeforeVoice.data;
    totalVoiceFrames = latentFrames + 1;
    voiceLatentsData = new Float32Array(bosData.length + rawLatentsData.length);
    voiceLatentsData.set(bosData, 0);
    voiceLatentsData.set(rawLatentsData, bosData.length);
  } else {
    voiceLatentsData = new Float32Array(rawLatentsData);
  }

  const flowState = initStateMap(state.bundle.flow_lm_state_manifest);
  const emptySeq = new ort.Tensor(
    'float32',
    new Float32Array(0),
    [1, 0, state.bundle.latent_dim || POCKET_LATENT_DIM]
  );
  const voiceEmbTensor = new ort.Tensor(
    'float32',
    voiceLatentsData,
    [1, totalVoiceFrames, latentDim]
  );

  const flowOut = await state.sessions.flowLmMain.run({
    sequence: emptySeq,
    text_embeddings: voiceEmbTensor,
    ...flowState,
  });
  throwIfCancelled();

  updateStateFromOutputs(flowState, flowOut, state.bundle.flow_lm_state_manifest);

  const serializedTensors: Record<string, SerializedTensorData> = {};
  const transferList: Transferable[] = [];

  for (const spec of state.bundle.flow_lm_state_manifest) {
    const tensor = flowState[spec.input_name];
    const { serialized, transfer } = serializeTensor(tensor);
    serializedTensors[spec.input_name] = serialized;
    transferList.push(transfer);
  }

  const voiceLatentsTensor = new ort.Tensor(
    'float32',
    voiceLatentsData,
    [1, totalVoiceFrames, latentDim]
  );
  const { serialized: latentsSerialized, transfer: latentsTransfer } =
    serializeTensor(voiceLatentsTensor);
  serializedTensors.voice_latents = latentsSerialized;
  transferList.push(latentsTransfer);

  postResponse(
    {
      type: 'encode-voice-done',
      id: req.id,
      tensors: serializedTensors,
      metadata: {
        sampleRate: state.bundle.sample_rate || POCKET_SAMPLE_RATE,
        voiceFrameCount: totalVoiceFrames,
        conditioningDim: latentDim,
        conditionedDurationSec: req.durationSec,
        truncated: req.truncated,
        sourceClipId: req.clipId,
        insertBosBeforeVoice: state.bundle.insert_bos_before_voice,
      },
    },
    transferList
  );
}

function handleLoadVoice(req: Extract<PocketWorkerRequest, { type: 'load-voice' }>): void {
  if (!state.bundle) {
    throw new Error('Pocket TTS engine is not initialized.');
  }

  const restoredState: TensorMap = {};
  for (const spec of state.bundle.flow_lm_state_manifest) {
    const raw = req.tensors[spec.input_name];
    if (!raw) {
      throw new Error(
        `Voice conditioning payload is missing required state tensor '${spec.input_name}'.`
      );
    }
    if (raw.dtype !== (spec.dtype as PocketStateDtype)) {
      throw new Error(
        `Voice conditioning tensor '${spec.input_name}' dtype mismatch: expected '${spec.dtype}', got '${raw.dtype}'.`
      );
    }
    restoredState[spec.input_name] = deserializeTensor(raw);
  }

  state.voiceStates.set(req.handleId, restoredState);
  postResponse({ type: 'load-voice-done', id: req.id, handleId: req.handleId });
}

function handleUnloadVoice(req: Extract<PocketWorkerRequest, { type: 'unload-voice' }>): void {
  state.voiceStates.delete(req.handleId);
  postResponse({ type: 'unload-voice-done', id: req.id });
}

async function handleSynthesize(
  req: Extract<PocketWorkerRequest, { type: 'synthesize' }>
): Promise<void> {
  if (
    !state.initialized ||
    !state.bundle ||
    !state.tokenizer ||
    !state.sessions.textConditioner ||
    !state.sessions.flowLmMain ||
    !state.sessions.flowLmFlow ||
    !state.sessions.mimiDecoder
  ) {
    throw new Error('Pocket TTS engine is not initialized.');
  }

  const baseFlowState = state.voiceStates.get(req.handleId);
  if (!baseFlowState) {
    throw new Error(`Voice handle '${req.handleId}' is not loaded in Pocket TTS worker.`);
  }

  const textConditioner = state.sessions.textConditioner;
  const flowLmMain = state.sessions.flowLmMain;
  const flowLmFlow = state.sessions.flowLmFlow;
  const mimiDecoder = state.sessions.mimiDecoder;

  state.cancelled = false;
  const t0 = performance.now();
  const bundle = state.bundle;
  const tokenizer = state.tokenizer;
  const latentDim = bundle.latent_dim || POCKET_LATENT_DIM;
  const condDim = bundle.conditioning_dim || POCKET_CONDITIONING_DIM;
  const sampleRate = bundle.sample_rate || POCKET_SAMPLE_RATE;
  const frameRate = bundle.frame_rate || POCKET_FRAME_RATE;
  const maxTokensPerChunk = bundle.max_token_per_chunk || POCKET_DEFAULT_MAX_TOKENS;

  const temperature = Math.max(0, Math.min(1.5, req.temperature));
  const lsdSteps = Math.max(1, Math.min(10, Math.round(req.lsdSteps)));
  const gaussianSample = createGaussianSampler(req.seed);

  const stBuffers: Array<{ s: ort.Tensor; t: ort.Tensor }> = [];
  const dt = 1.0 / lsdSteps;
  for (let j = 0; j < lsdSteps; j++) {
    const sVal = j / lsdSteps;
    const tVal = sVal + dt;
    stBuffers.push({
      s: new ort.Tensor('float32', new Float32Array([sVal]), [1, 1]),
      t: new ort.Tensor('float32', new Float32Array([tVal]), [1, 1]),
    });
  }

  const subChunks = splitPocketTextIntoChunks(tokenizer, req.text, {
    maxTokensPerChunk,
    padWithSpacesForShortInputs: bundle.pad_with_spaces_for_short_inputs,
    removeSemicolons: bundle.remove_semicolons,
  });

  if (subChunks.length === 0) {
    throw new Error('Normalized text produced zero tokens.');
  }

  const emptySeq = new ort.Tensor('float32', new Float32Array(0), [1, 0, latentDim]);
  const emptyText = new ort.Tensor('float32', new Float32Array(0), [1, 0, condDim]);

  let chunkIndex = 0;
  let totalSamples = 0;

  const emitChunk = (samples: Float32Array, isFinal: boolean): void => {
    totalSamples += samples.length;
    const msgChunk: SynthesizedAudioChunk = {
      chunkIndex: chunkIndex++,
      samples,
      sampleRate,
      durationSec: samples.length / sampleRate,
      isFinal,
    };
    postResponse(
      {
        type: 'synth-chunk',
        id: req.id,
        chunk: msgChunk,
      },
      [samples.buffer]
    );
  };

  for (let subIdx = 0; subIdx < subChunks.length; subIdx++) {
    throwIfCancelled();
    const isLastSubChunk = subIdx === subChunks.length - 1;
    const subText = subChunks[subIdx];
    const { text: preparedText, framesAfterEosGuess } = preparePocketTextPrompt(subText, {
      padWithSpacesForShortInputs: bundle.pad_with_spaces_for_short_inputs,
      removeSemicolons: bundle.remove_semicolons,
    });

    const effectiveFramesAfterEos =
      typeof req.framesAfterEos === 'number' && Number.isFinite(req.framesAfterEos)
        ? Math.max(1, Math.min(5, Math.round(req.framesAfterEos)))
        : (bundle.model_recommended_frames_after_eos ?? framesAfterEosGuess + 2);

    const tokenIds = tokenizer.encode(preparedText);
    const tokenIdsBigInt = new BigInt64Array(tokenIds.length);
    for (let i = 0; i < tokenIds.length; i++) {
      tokenIdsBigInt[i] = BigInt(tokenIds[i]);
    }
    const tokenTensor = new ort.Tensor('int64', tokenIdsBigInt, [1, tokenIds.length]);

    const condOut = await textConditioner.run({ token_ids: tokenTensor });
    throwIfCancelled();
    const rawTextEmb = condOut.embeddings as ort.Tensor | undefined;
    if (!rawTextEmb) {
      throw new Error('text_conditioner did not return "embeddings" output.');
    }
    const textEmbTensor =
      rawTextEmb.dims.length === 2
        ? new ort.Tensor('float32', rawTextEmb.data as Float32Array, [
            1,
            rawTextEmb.dims[0],
            rawTextEmb.dims[1],
          ])
        : rawTextEmb;

    // Clone baseFlowState cleanly per sub-chunk (preserving int64 step counters!)
    const flowState = cloneTensorMap(baseFlowState);
    const mimiState = initStateMap(bundle.mimi_state_manifest);

    // Condition FlowLM with text embeddings
    const textCondOut = await flowLmMain.run({
      sequence: emptySeq,
      text_embeddings: textEmbTensor,
      ...flowState,
    });
    throwIfCancelled();
    updateStateFromOutputs(flowState, textCondOut, bundle.flow_lm_state_manifest);

    const genLenSec =
      tokenIds.length / POCKET_TOKENS_PER_SECOND_ESTIMATE + POCKET_GEN_SECONDS_PADDING;
    const maxFrames = Math.max(8, Math.ceil(genLenSec * frameRate));

    let currData = new Float32Array(latentDim).fill(Number.NaN);
    let eosStep: number | null = null;
    const pendingLatents: Float32Array[] = [];
    let hasDecodedFirstBatch = false;

    const decodeAndEmit = async (frames: Float32Array[], isFinal: boolean): Promise<void> => {
      const packed = concatLatentFrames(frames, latentDim);
      const latentTensor = new ort.Tensor('float32', packed, [1, frames.length, latentDim]);
      const decOut = await mimiDecoder.run({
        latent: latentTensor,
        ...mimiState,
      });
      throwIfCancelled();
      updateStateFromOutputs(mimiState, decOut, bundle.mimi_state_manifest);
      const audioFrame = decOut.audio_frame as ort.Tensor | undefined;
      if (!audioFrame) {
        throw new Error('mimi_decoder did not return "audio_frame" output.');
      }
      const pcmCopy = new Float32Array(audioFrame.data as Float32Array);
      emitChunk(pcmCopy, isFinal);
    };

    for (let step = 0; step < maxFrames; step++) {
      throwIfCancelled();

      const seqTensor = new ort.Tensor('float32', currData, [1, 1, latentDim]);
      const arOut = await flowLmMain.run({
        sequence: seqTensor,
        text_embeddings: emptyText,
        ...flowState,
      });
      throwIfCancelled();

      const conditioning = arOut.conditioning as ort.Tensor;
      const eosLogit = (arOut.eos_logit as ort.Tensor).data as Float32Array;
      updateStateFromOutputs(flowState, arOut, bundle.flow_lm_state_manifest);

      if (eosLogit[0] > POCKET_EOS_THRESHOLD && eosStep === null) {
        eosStep = step;
      }
      if (eosStep !== null && step >= eosStep + effectiveFramesAfterEos) {
        break;
      }

      const xData = new Float32Array(latentDim);
      if (temperature > 0) {
        const std = Math.sqrt(temperature);
        for (let k = 0; k < latentDim; k++) {
          xData[k] = gaussianSample(std);
        }
      }

      for (const { s, t } of stBuffers) {
        throwIfCancelled();
        const xTensor = new ort.Tensor('float32', xData, [1, latentDim]);
        const flowRes = await flowLmFlow.run({
          c: conditioning,
          s,
          t,
          x: xTensor,
        });
        const flowDir = (flowRes.flow_dir as ort.Tensor).data as Float32Array;
        for (let k = 0; k < latentDim; k++) {
          xData[k] += flowDir[k] * dt;
        }
      }

      currData = xData;
      pendingLatents.push(xData);

      const batchTarget = hasDecodedFirstBatch ? 12 : 3;
      if (pendingLatents.length >= batchTarget) {
        const batch = pendingLatents.splice(0, batchTarget);
        hasDecodedFirstBatch = true;
        await decodeAndEmit(batch, false);
      }
    }

    if (pendingLatents.length > 0) {
      await decodeAndEmit(pendingLatents.splice(0, pendingLatents.length), isLastSubChunk);
    } else if (isLastSubChunk) {
      emitChunk(new Float32Array(0), true);
    }
  }

  const generationTimeMs = Math.max(0, performance.now() - t0);
  postResponse({
    type: 'synth-done',
    id: req.id,
    generationTimeMs,
    totalSamples,
  });
}

async function handleDispose(req: Extract<PocketWorkerRequest, { type: 'dispose' }>): Promise<void> {
  state.cancelled = true;
  state.activeAbortController?.abort();
  state.activeAbortController = null;
  state.voiceStates.clear();
  state.bundle = null;
  state.tokenizer = null;
  state.bosBeforeVoice = null;
  state.initialized = false;
  await releaseSessions();
  postResponse({ type: 'dispose-done', id: req.id });
}

self.addEventListener('message', (event: MessageEvent<PocketWorkerRequest>) => {
  const req = event.data;
  if (req.type === 'cancel') {
    state.cancelled = true;
    state.activeAbortController?.abort();
    return;
  }

  const run = async (): Promise<void> => {
    switch (req.type) {
      case 'init':
        await handleInit(req);
        break;
      case 'encode-voice':
        await handleEncodeVoice(req);
        break;
      case 'load-voice':
        handleLoadVoice(req);
        break;
      case 'unload-voice':
        handleUnloadVoice(req);
        break;
      case 'synthesize':
        await handleSynthesize(req);
        break;
      case 'dispose':
        await handleDispose(req);
        break;
    }
  };

  void run().catch((err: unknown) => {
    const error = err instanceof Error ? err : new Error(String(err));
    postResponse({
      type: 'error',
      id: 'id' in req ? req.id : null,
      message: error.message,
      name: error.name || 'Error',
    });
  });
});
