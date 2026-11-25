/**
 * Studio Quality Presets mapping directly to real engine inference parameters,
 * chunking cadence, and DSP mastering configurations.
 */

import type {
  EngineId,
  MasteringPreset,
  MasteringSettings,
  PreprocessingOptions,
  StudioPresetConfig,
  StudioPresetId,
} from '../types';

export const DEFAULT_PREPROCESSING_OPTIONS: PreprocessingOptions = {
  trimSilence: true,
  silenceThresholdDb: -40,
  minSilenceDurationMs: 150,
  normalizeLoudness: true,
  targetLufs: -18,
  highPassFilterHz: 80,
  noiseGateEnabled: false,
  noiseGateThresholdDb: -50,
  deEssingEnabled: false,
  targetSampleRate: 24_000,
  maxDurationSec: 30,
};

export const MASTERING_PRESET_SETTINGS: Record<MasteringPreset, MasteringSettings> = {
  natural: {
    preset: 'natural',
    eqLowGainDb: 0.5,
    eqMidGainDb: 0.5,
    eqHighGainDb: 0.5,
    warmth: 0.15,
    clarity: 0.2,
    deEsserAmount: 0.15,
    compressorEnabled: true,
    compressorThresholdDb: -20,
    compressorRatio: 2.0,
    targetLufs: -16,
    truePeakLimitDb: -1.0,
    fadeInMs: 10,
    fadeOutMs: 25,
  },
  youtube: {
    preset: 'youtube',
    eqLowGainDb: 1.0,
    eqMidGainDb: 1.5,
    eqHighGainDb: 1.5,
    warmth: 0.2,
    clarity: 0.45,
    deEsserAmount: 0.25,
    compressorEnabled: true,
    compressorThresholdDb: -18,
    compressorRatio: 2.8,
    targetLufs: -14,
    truePeakLimitDb: -1.0,
    fadeInMs: 8,
    fadeOutMs: 20,
  },
  podcast: {
    preset: 'podcast',
    eqLowGainDb: 1.5,
    eqMidGainDb: 1.2,
    eqHighGainDb: 1.0,
    warmth: 0.3,
    clarity: 0.35,
    deEsserAmount: 0.25,
    compressorEnabled: true,
    compressorThresholdDb: -18,
    compressorRatio: 2.5,
    targetLufs: -16,
    truePeakLimitDb: -1.0,
    fadeInMs: 12,
    fadeOutMs: 30,
  },
  raw: {
    preset: 'raw',
    eqLowGainDb: 0,
    eqMidGainDb: 0,
    eqHighGainDb: 0,
    warmth: 0,
    clarity: 0,
    deEsserAmount: 0,
    compressorEnabled: false,
    compressorThresholdDb: -18,
    compressorRatio: 1.0,
    targetLufs: -16,
    truePeakLimitDb: -0.5,
    fadeInMs: 0,
    fadeOutMs: 0,
  },
  custom: {
    preset: 'custom',
    eqLowGainDb: 0,
    eqMidGainDb: 0,
    eqHighGainDb: 0,
    warmth: 0.1,
    clarity: 0.15,
    deEsserAmount: 0.1,
    compressorEnabled: true,
    compressorThresholdDb: -19,
    compressorRatio: 2.2,
    targetLufs: -16,
    truePeakLimitDb: -1.0,
    fadeInMs: 10,
    fadeOutMs: 20,
  },
};

function cloneMastering(preset: MasteringPreset, overrides: Partial<MasteringSettings> = {}): MasteringSettings {
  return {
    ...MASTERING_PRESET_SETTINGS[preset],
    ...overrides,
  };
}

/**
 * All 7 Studio Quality Presets with real engine parameters and mastering settings.
 */
export const STUDIO_PRESETS: Record<StudioPresetId, StudioPresetConfig> = {
  'studio-quality': {
    id: 'studio-quality',
    name: 'Studio Quality',
    description:
      'Maximum acoustic fidelity: higher flow integration steps (lsdSteps=4), steady variance, and podcast broadcast mastering (-16 LUFS).',
    executionMode: 'quality',
    engineParameters: {
      temperature: 0.65,
      lsdSteps: 4,
      framesAfterEos: 3,
      exaggeration: 0.45,
      repetitionPenalty: 1.2,
      topP: 0.92,
    },
    sentencePauseMs: 320,
    paragraphPauseMs: 650,
    chunkCrossfadeMs: 12,
    maxChunkChars: 240,
    mastering: cloneMastering('podcast', {
      warmth: 0.25,
      clarity: 0.35,
      deEsserAmount: 0.25,
    }),
  },
  'natural-narration': {
    id: 'natural-narration',
    name: 'Natural Narration',
    description:
      'Balanced conversational cadence using Pocket TTS native 1-step distilled flow matching with gentle compression and clean room tone.',
    executionMode: 'balanced',
    engineParameters: {
      temperature: 0.7,
      lsdSteps: 1,
      framesAfterEos: 2,
      exaggeration: 0.5,
      repetitionPenalty: 1.2,
      topP: 0.95,
    },
    sentencePauseMs: 280,
    paragraphPauseMs: 560,
    chunkCrossfadeMs: 10,
    maxChunkChars: 260,
    mastering: cloneMastering('natural'),
  },
  documentary: {
    id: 'documentary',
    name: 'Documentary',
    description:
      'Authoritative, measured pacing with lower temperature, crisp vocal presence, and YouTube -14 LUFS loudness.',
    executionMode: 'quality',
    engineParameters: {
      temperature: 0.55,
      lsdSteps: 3,
      framesAfterEos: 3,
      exaggeration: 0.35,
      repetitionPenalty: 1.25,
      topP: 0.9,
    },
    sentencePauseMs: 360,
    paragraphPauseMs: 750,
    chunkCrossfadeMs: 10,
    maxChunkChars: 250,
    mastering: cloneMastering('youtube', {
      warmth: 0.25,
      clarity: 0.4,
    }),
  },
  educational: {
    id: 'educational',
    name: 'Educational & Explainer',
    description:
      'Articulate, consistent pronunciation with slightly longer sentence pauses for complex technical material.',
    executionMode: 'balanced',
    engineParameters: {
      temperature: 0.5,
      lsdSteps: 2,
      framesAfterEos: 2,
      exaggeration: 0.3,
      repetitionPenalty: 1.25,
      topP: 0.88,
    },
    sentencePauseMs: 340,
    paragraphPauseMs: 700,
    chunkCrossfadeMs: 10,
    maxChunkChars: 250,
    mastering: cloneMastering('podcast', {
      clarity: 0.45,
      warmth: 0.15,
    }),
  },
  storytelling: {
    id: 'storytelling',
    name: 'Storytelling',
    description:
      'Expressive dynamic range with higher temperature and exaggeration for fiction, audiobooks, and dialogue.',
    executionMode: 'quality',
    engineParameters: {
      temperature: 0.85,
      lsdSteps: 3,
      framesAfterEos: 3,
      exaggeration: 0.75,
      repetitionPenalty: 1.15,
      topP: 0.96,
    },
    sentencePauseMs: 300,
    paragraphPauseMs: 680,
    chunkCrossfadeMs: 14,
    maxChunkChars: 260,
    mastering: cloneMastering('natural', {
      warmth: 0.35,
      clarity: 0.25,
    }),
  },
  'fast-preview': {
    id: 'fast-preview',
    name: 'Fast Preview',
    description:
      'Low-latency draft mode (lsdSteps=1, minimal tail frames, raw bypass mastering) for quick script checks.',
    executionMode: 'cpu',
    engineParameters: {
      temperature: 0.7,
      lsdSteps: 1,
      framesAfterEos: 1,
      exaggeration: 0.5,
      repetitionPenalty: 1.2,
      topP: 0.95,
    },
    sentencePauseMs: 220,
    paragraphPauseMs: 440,
    chunkCrossfadeMs: 8,
    maxChunkChars: 260,
    mastering: cloneMastering('raw'),
  },
  custom: {
    id: 'custom',
    name: 'Custom',
    description:
      'User-tuned engine inference parameters, pause cadence, and mastering chain.',
    executionMode: 'balanced',
    engineParameters: {
      temperature: 0.7,
      lsdSteps: 1,
      framesAfterEos: 2,
      exaggeration: 0.5,
      repetitionPenalty: 1.2,
      topP: 0.95,
    },
    sentencePauseMs: 280,
    paragraphPauseMs: 560,
    chunkCrossfadeMs: 10,
    maxChunkChars: 260,
    mastering: cloneMastering('custom'),
  },
};

export const STUDIO_PRESET_IDS: readonly StudioPresetId[] = [
  'studio-quality',
  'natural-narration',
  'documentary',
  'educational',
  'storytelling',
  'fast-preview',
  'custom',
];

export const STUDIO_PRESET_LIST: readonly StudioPresetConfig[] = STUDIO_PRESET_IDS.map(
  (id) => STUDIO_PRESETS[id]
);

/**
 * Return a deep copy of a `StudioPresetConfig` by ID.
 */
export function getStudioPreset(presetId: StudioPresetId): StudioPresetConfig {
  const preset = STUDIO_PRESETS[presetId] ?? STUDIO_PRESETS['natural-narration'];
  return {
    ...preset,
    engineParameters: { ...preset.engineParameters },
    mastering: { ...preset.mastering },
  };
}

/**
 * Extract only the engine-supported generation parameters for `engineId`,
 * clamping numeric values to valid engine ranges.
 */
export function extractEngineParametersForEngine(
  params: Record<string, number | string | boolean>,
  engineId: EngineId
): Record<string, number | string | boolean> {
  const out: Record<string, number | string | boolean> = {};

  const num = (key: string, min: number, max: number, fallback: number): number => {
    const val = params[key];
    if (typeof val === 'number' && Number.isFinite(val)) {
      return Math.min(max, Math.max(min, val));
    }
    return fallback;
  };

  if (engineId === 'pocket-tts') {
    out.temperature = num('temperature', 0.1, 1.2, 0.7);
    out.lsdSteps = Math.round(num('lsdSteps', 1, 8, 1));
    out.framesAfterEos = Math.round(num('framesAfterEos', 1, 5, 2));
    if (typeof params.seed === 'number' && Number.isFinite(params.seed) && params.seed >= 0) {
      out.seed = Math.floor(params.seed);
    }
    return out;
  }

  if (engineId === 'chatterbox' || engineId === 'chatterbox-turbo') {
    out.exaggeration = num('exaggeration', 0.0, 1.5, 0.5);
    out.temperature = num('temperature', 0.2, 1.2, 0.8);
    out.repetitionPenalty = num('repetitionPenalty', 1.0, 1.6, 1.2);
    out.topP = num('topP', 0.5, 1.0, 0.95);
    if (typeof params.seed === 'number' && Number.isFinite(params.seed) && params.seed >= 0) {
      out.seed = Math.floor(params.seed);
    }
    return out;
  }

  return { ...params };
}
