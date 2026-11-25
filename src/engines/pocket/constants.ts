import type {
  EngineLoadProgress,
  ModelArtifact,
  ModelManifestEntry,
  SerializedTensorData,
  SynthesizedAudioChunk,
} from '../../types';

export const POCKET_ENGINE_ID = 'pocket-tts';
export const POCKET_ENGINE_NAME = 'Pocket TTS ONNX (6L INT8)';
export const POCKET_ENGINE_VERSION = '2026-04.1';
export const POCKET_REPO_ID = 'KevinAHM/pocket-tts-onnx';
export const POCKET_MODEL_REVISION = '58a6d00cf13d239b6748cb0769f35c580a8f606c';
export const POCKET_BUNDLE_SUBPATH = 'onnx/english_2026-04';
export const POCKET_CACHE_NAME = 'voiceforge-models-v1';
export const POCKET_PAYLOAD_VERSION = 1;
export const POCKET_SAMPLE_RATE = 24_000;
export const POCKET_FRAME_RATE = 12.5;
export const POCKET_SAMPLES_PER_FRAME = 1920;
export const POCKET_LATENT_DIM = 32;
export const POCKET_CONDITIONING_DIM = 1024;
export const POCKET_MAX_REFERENCE_SEC = 30;
export const POCKET_RECOMMENDED_MIN_REF_SEC = 3;
export const POCKET_RECOMMENDED_MAX_REF_SEC = 10;
export const POCKET_DEFAULT_MAX_TOKENS = 50;
export const POCKET_EOS_THRESHOLD = -4.0;
export const POCKET_TOKENS_PER_SECOND_ESTIMATE = 3.0;
export const POCKET_GEN_SECONDS_PADDING = 2.0;

export function buildPocketArtifactUrl(relativePath: string, customBaseUrl?: string): string {
  if (customBaseUrl) {
    const trimmed = customBaseUrl.replace(/\/+$/, '');
    const cleanRel = relativePath.replace(/^\/+/, '');
    return `${trimmed}/${cleanRel}`;
  }
  return `https://huggingface.co/${POCKET_REPO_ID}/resolve/${POCKET_MODEL_REVISION}/${relativePath}`;
}

export const POCKET_MODEL_ARTIFACTS: readonly ModelArtifact[] = [
  {
    role: 'text_conditioner',
    relativePath: `${POCKET_BUNDLE_SUBPATH}/text_conditioner.onnx`,
    url: buildPocketArtifactUrl(`${POCKET_BUNDLE_SUBPATH}/text_conditioner.onnx`),
    sizeBytes: 16_388_344,
    sha256: '4ecee995fb69f85c7a7493d11f7b5ee15d9950facc7ab3f5c9c49ef1e03847bb',
    format: 'onnx',
    required: true,
  },
  {
    role: 'flow_lm_main',
    relativePath: `${POCKET_BUNDLE_SUBPATH}/flow_lm_main_int8.onnx`,
    url: buildPocketArtifactUrl(`${POCKET_BUNDLE_SUBPATH}/flow_lm_main_int8.onnx`),
    sizeBytes: 76_341_079,
    sha256: 'f9bd8106b79a0192c1c43399ab938fb24900a95c1c599870d75a884e99000116',
    format: 'onnx',
    required: true,
  },
  {
    role: 'flow_lm_flow',
    relativePath: `${POCKET_BUNDLE_SUBPATH}/flow_lm_flow_int8.onnx`,
    url: buildPocketArtifactUrl(`${POCKET_BUNDLE_SUBPATH}/flow_lm_flow_int8.onnx`),
    sizeBytes: 9_962_530,
    sha256: '3dd781ee5abee9e195320bf0106bebd6372a852b3b36352524ee78b40554635d',
    format: 'onnx',
    required: true,
  },
  {
    role: 'mimi_decoder',
    relativePath: `${POCKET_BUNDLE_SUBPATH}/mimi_decoder_int8.onnx`,
    url: buildPocketArtifactUrl(`${POCKET_BUNDLE_SUBPATH}/mimi_decoder_int8.onnx`),
    sizeBytes: 22_684_077,
    sha256: '3630450a3297a101792a6ac66619ebc70ab916b265e6220c2afaef8b1673f925',
    format: 'onnx',
    required: true,
  },
  {
    role: 'mimi_encoder',
    relativePath: `${POCKET_BUNDLE_SUBPATH}/mimi_encoder_int8.onnx`,
    url: buildPocketArtifactUrl(`${POCKET_BUNDLE_SUBPATH}/mimi_encoder_int8.onnx`),
    sizeBytes: 20_779_616,
    sha256: 'abb46f1ad0b83c3840fe38c3652ab0eda7d1d97a63f1953bbbff5d04d8f4c855',
    format: 'onnx',
    required: true,
  },
  {
    role: 'bos_before_voice',
    relativePath: `${POCKET_BUNDLE_SUBPATH}/bos_before_voice.npy`,
    url: buildPocketArtifactUrl(`${POCKET_BUNDLE_SUBPATH}/bos_before_voice.npy`),
    sizeBytes: 4_224,
    sha256: 'f46edf4f7007b7ba4ea58831f49d003e59e167b4641c44bb3addfe9231a780b1',
    format: 'bin',
    required: true,
  },
  {
    role: 'bundle_config',
    relativePath: `${POCKET_BUNDLE_SUBPATH}/bundle.json`,
    url: buildPocketArtifactUrl(`${POCKET_BUNDLE_SUBPATH}/bundle.json`),
    sizeBytes: 24_381,
    sha256: 'bab643150f437f37df080a710520ff39ed9ebd9a339f8ebdc739f7eddfc28b3f',
    format: 'json',
    required: true,
  },
  {
    role: 'tokenizer',
    relativePath: `${POCKET_BUNDLE_SUBPATH}/tokenizer.model`,
    url: buildPocketArtifactUrl(`${POCKET_BUNDLE_SUBPATH}/tokenizer.model`),
    sizeBytes: 59_339,
    sha256: 'd461765ae179566678c93091c5fa6f2984c31bbe990bf1aa62d92c64d91bc3f6',
    format: 'spm',
    required: true,
  },
];

export const POCKET_TOTAL_SIZE_BYTES = POCKET_MODEL_ARTIFACTS.reduce(
  (sum, artifact) => sum + artifact.sizeBytes,
  0
);

export const POCKET_MODEL_MANIFEST_ENTRY: ModelManifestEntry = {
  engineId: POCKET_ENGINE_ID,
  displayName: 'Pocket TTS (English 2026-04, INT8)',
  repoId: POCKET_REPO_ID,
  revision: POCKET_MODEL_REVISION,
  license: 'CC-BY-4.0',
  licenseUrl: `https://huggingface.co/${POCKET_REPO_ID}/blob/${POCKET_MODEL_REVISION}/README.md`,
  ungated: true,
  precision: 'int8',
  sampleRate: POCKET_SAMPLE_RATE,
  recommendedExecutionMode: 'cpu',
  estimatedMemoryMb: 550,
  totalSizeBytes: POCKET_TOTAL_SIZE_BYTES,
  artifacts: [...POCKET_MODEL_ARTIFACTS],
};

export type PocketStateDtype = 'float32' | 'float16' | 'int64' | 'bool';
export type PocketStateFill = 'zeros' | 'ones' | 'nan' | 'empty';

export interface PocketStateSpec {
  index: number;
  input_name: string;
  output_name: string;
  dtype: PocketStateDtype;
  fill: PocketStateFill;
  shape: number[];
  key?: string;
  module?: string;
  path?: string;
}

export interface PocketBundleConfig {
  schema_version: number;
  bundle_name: string;
  language: string;
  sample_rate: number;
  frame_rate: number;
  samples_per_frame: number;
  latent_dim: number;
  conditioning_dim: number;
  max_token_per_chunk: number;
  insert_bos_before_voice: boolean;
  remove_semicolons: boolean;
  pad_with_spaces_for_short_inputs: boolean;
  model_recommended_frames_after_eos: number | null;
  default_temperature?: number;
  default_lsd_steps?: number;
  bos_before_voice_file?: string;
  tokenizer_file?: string;
  flow_lm_state_manifest: PocketStateSpec[];
  mimi_state_manifest: PocketStateSpec[];
}

export type PocketWorkerRequest =
  | {
      type: 'init';
      id: number;
      wasmBasePath: string;
      wasmThreads?: number;
      modelRevision: string;
      manifestEntry?: ModelManifestEntry;
      customBaseUrl?: string;
    }
  | {
      type: 'encode-voice';
      id: number;
      samples: Float32Array;
      clipId: string;
      durationSec: number;
      truncated: boolean;
    }
  | {
      type: 'load-voice';
      id: number;
      handleId: string;
      tensors: Record<string, SerializedTensorData>;
    }
  | {
      type: 'unload-voice';
      id: number;
      handleId: string;
    }
  | {
      type: 'synthesize';
      id: number;
      handleId: string;
      text: string;
      temperature: number;
      lsdSteps: number;
      framesAfterEos?: number;
      seed?: number;
    }
  | {
      type: 'cancel';
    }
  | {
      type: 'dispose';
      id: number;
    };

export type PocketWorkerResponse =
  | {
      type: 'progress';
      id: number;
      progress: EngineLoadProgress;
    }
  | {
      type: 'init-done';
      id: number;
      totalSizeBytes: number;
      numThreads: number;
      modelRevision: string;
    }
  | {
      type: 'encode-voice-done';
      id: number;
      tensors: Record<string, SerializedTensorData>;
      metadata: Record<string, string | number | boolean>;
    }
  | {
      type: 'load-voice-done';
      id: number;
      handleId: string;
    }
  | {
      type: 'unload-voice-done';
      id: number;
    }
  | {
      type: 'synth-chunk';
      id: number;
      chunk: SynthesizedAudioChunk;
    }
  | {
      type: 'synth-done';
      id: number;
      generationTimeMs: number;
      totalSamples: number;
    }
  | {
      type: 'dispose-done';
      id: number;
    }
  | {
      type: 'error';
      id: number | null;
      message: string;
      name: string;
    };
