import type { AudioBufferData } from '../../types';
import {
  POCKET_MAX_REFERENCE_SEC,
  POCKET_RECOMMENDED_MAX_REF_SEC,
  POCKET_RECOMMENDED_MIN_REF_SEC,
  POCKET_SAMPLE_RATE,
} from './constants';

export interface EndOnPauseOptions {
  /** Trailing silence duration appended in seconds (default: 0.08s = 1920 samples @ 24kHz). */
  pauseSec?: number;
  /** Linear fade-out duration at the end of remaining speech in seconds (default: 0.02s). */
  fadeSec?: number;
  /** RMS threshold in dB below the loudest 20ms frame to treat as trailing silence (default: 35 dB). */
  floorDb?: number;
}

export interface PreprocessedReferenceAudio {
  samples: Float32Array;
  sampleRate: number;
  durationSec: number;
  truncated: boolean;
  warnings: string[];
}

/**
 * Downmix interleaved multi-channel PCM to mono Float32.
 */
export function downmixToMono(samples: Float32Array, channels: number): Float32Array {
  if (channels <= 1) {
    return new Float32Array(samples);
  }
  const frameCount = Math.floor(samples.length / channels);
  const mono = new Float32Array(frameCount);
  const invChannels = 1 / channels;
  for (let i = 0; i < frameCount; i++) {
    let sum = 0;
    const base = i * channels;
    for (let ch = 0; ch < channels; ch++) {
      sum += samples[base + ch];
    }
    mono[i] = sum * invChannels;
  }
  return mono;
}

function sinc(x: number): number {
  if (Math.abs(x) < 1e-8) return 1.0;
  const px = Math.PI * x;
  return Math.sin(px) / px;
}

/**
 * Resample mono Float32 PCM using windowed-sinc (Lanczos-3) interpolation.
 */
export function resampleMonoPcm(
  samples: Float32Array,
  fromRate: number,
  toRate: number
): Float32Array {
  if (fromRate <= 0 || toRate <= 0) {
    throw new Error(`Invalid sample rates: ${fromRate} -> ${toRate}`);
  }
  if (fromRate === toRate || samples.length === 0) {
    return new Float32Array(samples);
  }

  const ratio = fromRate / toRate;
  const outLength = Math.max(1, Math.round(samples.length / ratio));
  const out = new Float32Array(outLength);
  const a = 3; // Lanczos radius
  const filterScale = ratio > 1 ? 1 / ratio : 1;
  const support = a / filterScale;

  for (let i = 0; i < outLength; i++) {
    const center = i * ratio;
    const start = Math.max(0, Math.floor(center - support));
    const end = Math.min(samples.length - 1, Math.ceil(center + support));

    let acc = 0;
    let weightSum = 0;
    for (let j = start; j <= end; j++) {
      const dist = (center - j) * filterScale;
      if (Math.abs(dist) < a) {
        const w = sinc(dist) * sinc(dist / a);
        acc += samples[j] * w;
        weightSum += w;
      }
    }
    out[i] = weightSum > 1e-8 ? acc / weightSum : 0;
  }

  return out;
}

/**
 * Port of `kyutai-labs/pocket-tts` `end_on_pause`:
 * 1. Analyze 20ms RMS frames and cut trailing silence > `floorDb` (35 dB) below peak.
 * 2. Apply a `fadeSec` (20 ms) linear fade-out on the remaining audio tail.
 * 3. Append `pauseSec` (80 ms) of zero silence.
 */
export function applyEndOnPause(
  samples: Float32Array,
  sampleRate: number = POCKET_SAMPLE_RATE,
  options: EndOnPauseOptions = {}
): Float32Array {
  const pauseSec = options.pauseSec ?? 0.08;
  const fadeSec = options.fadeSec ?? 0.02;
  const floorDb = options.floorDb ?? 35.0;

  const frameSize = Math.max(1, Math.floor(0.02 * sampleRate));
  const numFrames = Math.floor(samples.length / frameSize);
  if (numFrames === 0) {
    return new Float32Array(samples);
  }

  const frameDb = new Float64Array(numFrames);
  let maxDb = -Infinity;

  for (let f = 0; f < numFrames; f++) {
    let sumSq = 0;
    const base = f * frameSize;
    for (let i = 0; i < frameSize; i++) {
      const s = samples[base + i];
      sumSq += s * s;
    }
    const rms = Math.sqrt(sumSq / frameSize);
    const db = 20 * Math.log10(rms + 1e-12);
    frameDb[f] = db;
    if (db > maxDb) {
      maxDb = db;
    }
  }

  const thresholdDb = maxDb - floorDb;
  let lastLoudFrame = -1;
  for (let f = numFrames - 1; f >= 0; f--) {
    if (frameDb[f] > thresholdDb) {
      lastLoudFrame = f;
      break;
    }
  }

  if (lastLoudFrame < 0) {
    lastLoudFrame = numFrames - 1;
  }

  const endSample = (lastLoudFrame + 1) * frameSize;
  const pauseSamples = Math.max(0, Math.floor(pauseSec * sampleRate));
  const out = new Float32Array(endSample + pauseSamples);
  out.set(samples.subarray(0, endSample), 0);

  const fadeSamples = Math.min(Math.max(0, Math.floor(fadeSec * sampleRate)), endSample);
  if (fadeSamples > 1) {
    const fadeStart = endSample - fadeSamples;
    for (let i = 0; i < fadeSamples; i++) {
      const gain = 1 - i / (fadeSamples - 1);
      out[fadeStart + i] *= gain;
    }
  } else if (fadeSamples === 1 && endSample > 0) {
    out[endSample - 1] = 0;
  }

  return out;
}

/**
 * Prepare reference audio for Pocket TTS `mimi_encoder`:
 * mono, 24 kHz, clamped to [-1, 1], truncated <= maxDurationSec (30s), and `end_on_pause` applied.
 */
export function preprocessReferenceAudio(
  audio: AudioBufferData,
  maxDurationSec: number = POCKET_MAX_REFERENCE_SEC
): PreprocessedReferenceAudio {
  if (!audio.samples || audio.samples.length === 0) {
    throw new Error('Reference audio buffer is empty.');
  }

  const warnings: string[] = [];
  let mono = downmixToMono(audio.samples, audio.channels);

  if (audio.sampleRate !== POCKET_SAMPLE_RATE) {
    mono = resampleMonoPcm(mono, audio.sampleRate, POCKET_SAMPLE_RATE);
  }

  const maxSamples = Math.floor(maxDurationSec * POCKET_SAMPLE_RATE);
  let truncated = false;
  if (mono.length > maxSamples) {
    mono = mono.slice(0, maxSamples);
    truncated = true;
    warnings.push(
      `Reference clip exceeded ${maxDurationSec}s and was truncated to ${maxDurationSec}s.`
    );
  }

  const rawDurationSec = mono.length / POCKET_SAMPLE_RATE;
  if (rawDurationSec < POCKET_RECOMMENDED_MIN_REF_SEC) {
    warnings.push(
      `Reference clip is short (${rawDurationSec.toFixed(1)}s); ${POCKET_RECOMMENDED_MIN_REF_SEC}-${POCKET_RECOMMENDED_MAX_REF_SEC}s is recommended.`
    );
  } else if (!truncated && rawDurationSec > POCKET_RECOMMENDED_MAX_REF_SEC) {
    warnings.push(
      `Reference clip is ${rawDurationSec.toFixed(1)}s; ${POCKET_RECOMMENDED_MIN_REF_SEC}-${POCKET_RECOMMENDED_MAX_REF_SEC}s is optimal for memory and conditioning speed.`
    );
  }

  // Clamp out-of-range samples safely before encoding
  for (let i = 0; i < mono.length; i++) {
    const v = mono[i];
    if (!Number.isFinite(v)) {
      mono[i] = 0;
    } else if (v > 1) {
      mono[i] = 1;
    } else if (v < -1) {
      mono[i] = -1;
    }
  }

  const conditionedSamples = applyEndOnPause(mono, POCKET_SAMPLE_RATE);
  return {
    samples: conditionedSamples,
    sampleRate: POCKET_SAMPLE_RATE,
    durationSec: conditionedSamples.length / POCKET_SAMPLE_RATE,
    truncated,
    warnings,
  };
}
