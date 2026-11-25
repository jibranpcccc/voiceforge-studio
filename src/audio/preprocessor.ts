import type { AudioBufferData, PreprocessingOptions } from '../types';
import { downmixToMono, pcmToAudioBufferData, resamplePcm } from './decoder';
import {
  applyBiquadInPlace,
  applyFadeInOutInPlace,
  applySoftDeEsserInPlace,
  clampSample,
  dbToLinear,
  designHighPass,
  linearToDb,
  measureLufs,
  removeDcOffsetInPlace,
} from './dsp';

export interface ReferencePreprocessingOptions extends PreprocessingOptions {
  /** Remove DC offset prior to filtering/normalization (default: true). */
  removeDcOffset?: boolean;
  /** Downmix multi-channel audio to mono (default: true). */
  downmixToMono?: boolean;
  /** Padding in milliseconds preserved when trimming leading/trailing silence (default: 80). */
  trimPaddingMs?: number;
  /**
   * Optional gentle noise reduction (80 Hz high-pass rumble filter + soft downward expander gate).
   * Disabled by default so raw vocal harmonics remain untouched unless requested.
   */
  gentleNoiseReduction?: boolean;
}

export const DEFAULT_PREPROCESSING_OPTIONS: ReferencePreprocessingOptions = {
  removeDcOffset: true,
  downmixToMono: true,
  trimSilence: true,
  silenceThresholdDb: -40,
  minSilenceDurationMs: 100,
  trimPaddingMs: 80,
  normalizeLoudness: false,
  targetLufs: -18,
  highPassFilterHz: 0,
  noiseGateEnabled: false,
  noiseGateThresholdDb: -50,
  gentleNoiseReduction: false,
  deEssingEnabled: false,
  targetSampleRate: 24000,
  maxDurationSec: 30,
};

function trimLeadingTrailingSilence(
  samples: Float32Array,
  sampleRate: number,
  thresholdDb: number,
  minSilenceDurationMs: number,
  paddingMs: number
): Float32Array {
  const frameSize = Math.max(1, Math.round(0.02 * sampleRate));
  const numFrames = Math.floor(samples.length / frameSize);
  if (numFrames <= 1) {
    return new Float32Array(samples);
  }

  let firstActive = -1;
  let lastActive = -1;

  for (let f = 0; f < numFrames; f++) {
    const start = f * frameSize;
    let sumSq = 0;
    for (let i = 0; i < frameSize; i++) {
      const s = samples[start + i];
      sumSq += s * s;
    }
    const db = linearToDb(Math.sqrt(sumSq / frameSize));
    if (db > thresholdDb) {
      if (firstActive === -1) firstActive = f;
      lastActive = f;
    }
  }

  if (firstActive === -1) {
    // Entire clip is below threshold; preserve safely without returning 0 samples.
    return new Float32Array(samples);
  }

  const paddingSamples = Math.max(0, Math.round((paddingMs / 1000) * sampleRate));
  const minSilenceSamples = Math.max(0, Math.round((minSilenceDurationMs / 1000) * sampleRate));

  const rawStart = firstActive * frameSize;
  const rawEnd = Math.min(samples.length, (lastActive + 1) * frameSize);

  const trimStart =
    rawStart > minSilenceSamples ? Math.max(0, rawStart - paddingSamples) : 0;
  const trailingSilenceLen = samples.length - rawEnd;
  const trimEnd =
    trailingSilenceLen > minSilenceSamples
      ? Math.min(samples.length, rawEnd + paddingSamples)
      : samples.length;

  const sliced = new Float32Array(samples.subarray(trimStart, trimEnd));
  // Micro-fade cut edges (5 ms) to prevent boundary clicks
  applyFadeInOutInPlace(
    sliced,
    sampleRate,
    trimStart > 0 ? 5 : 0,
    trimEnd < samples.length ? 5 : 0,
    1
  );
  return sliced;
}

/**
 * Apply a gentle soft downward expander gate so room noise between phrases is reduced
 * without hard-chopping breath tails or vocal harmonics.
 */
function applyGentleExpanderGateInPlace(
  samples: Float32Array,
  sampleRate: number,
  thresholdDb: number
): void {
  if (samples.length === 0) return;

  const threshold = dbToLinear(thresholdDb);
  const attackCoeff = Math.exp(-1 / Math.max(1, 0.012 * sampleRate));
  const releaseCoeff = Math.exp(-1 / Math.max(1, 0.09 * sampleRate));
  const minGain = dbToLinear(-14); // Never attenuate more than 14 dB to keep transitions natural
  const ratio = 2.2;

  let env = 0;
  let smoothedGain = 1;
  const gainRelease = Math.exp(-1 / Math.max(1, 0.06 * sampleRate));

  for (let i = 0; i < samples.length; i++) {
    const abs = Math.abs(samples[i]);
    const coeff = abs > env ? attackCoeff : releaseCoeff;
    env = coeff * env + (1 - coeff) * abs;

    let targetGain = 1;
    if (env < threshold && env > 1e-9) {
      const belowDb = linearToDb(env) - thresholdDb; // negative
      const attenuationDb = Math.max(-14, belowDb * (1 - 1 / ratio) * 0.65);
      targetGain = Math.max(minGain, dbToLinear(attenuationDb));
    } else if (env <= 1e-9) {
      targetGain = minGain;
    }

    smoothedGain =
      targetGain > smoothedGain
        ? attackCoeff * smoothedGain + (1 - attackCoeff) * targetGain
        : gainRelease * smoothedGain + (1 - gainRelease) * targetGain;

    samples[i] *= smoothedGain;
  }
}

/**
 * Non-destructively preprocess a reference audio clip for voice cloning conditioning.
 *
 * Always operates on a fresh copy so the original `AudioBufferData` remains untouched
 * for side-by-side A/B comparison.
 */
export function preprocessReferenceAudio(
  original: AudioBufferData,
  opts: Partial<ReferencePreprocessingOptions> = {}
): AudioBufferData {
  if (!original || !original.samples || original.samples.length === 0) {
    throw new Error('Cannot preprocess an empty audio buffer.');
  }

  const options: ReferencePreprocessingOptions = {
    ...DEFAULT_PREPROCESSING_OPTIONS,
    ...opts,
  };

  let channels = Math.max(1, original.channels || 1);
  let sampleRate = original.sampleRate;
  let work: Float32Array;

  // 1. Clone / downmix to mono
  if (options.downmixToMono !== false && channels > 1) {
    work = downmixToMono(original.samples, channels);
    channels = 1;
  } else {
    work = new Float32Array(original.samples);
  }

  // 2. DC offset removal
  if (options.removeDcOffset !== false) {
    removeDcOffsetInPlace(work, channels);
  }

  // Ensure mono channel view for per-channel DSP stages if multi-channel was explicitly kept
  const processChannel = (monoBuf: Float32Array): Float32Array => {
    let chBuf = monoBuf;

    // 3. Gentle high-pass rumble removal (80 Hz when gentleNoiseReduction is enabled)
    const hpfHz =
      options.highPassFilterHz > 0
        ? options.highPassFilterHz
        : options.gentleNoiseReduction
          ? 80
          : 0;
    if (hpfHz > 0 && sampleRate > hpfHz * 2.5) {
      applyBiquadInPlace(chBuf, designHighPass(sampleRate, hpfHz, Math.SQRT1_2));
    }

    // 4. Trim leading & trailing silence (keeping 80ms padding by default)
    if (options.trimSilence && channels === 1) {
      chBuf = trimLeadingTrailingSilence(
        chBuf,
        sampleRate,
        options.silenceThresholdDb,
        options.minSilenceDurationMs,
        options.trimPaddingMs ?? 80
      );
    }

    // 5. Optional gentle noise gate / expander
    if (options.noiseGateEnabled || options.gentleNoiseReduction) {
      const gateDb = options.noiseGateEnabled ? options.noiseGateThresholdDb : -48;
      applyGentleExpanderGateInPlace(chBuf, sampleRate, gateDb);
    }

    // 6. Optional mild de-essing
    if (options.deEssingEnabled) {
      applySoftDeEsserInPlace(chBuf, sampleRate, 0.35);
    }

    // 7. Maximum duration cap
    if (options.maxDurationSec > 0) {
      const maxSamples = Math.floor(options.maxDurationSec * sampleRate);
      if (chBuf.length > maxSamples && maxSamples > 0) {
        chBuf = new Float32Array(chBuf.subarray(0, maxSamples));
        applyFadeInOutInPlace(chBuf, sampleRate, 0, 20, 1);
      }
    }

    return chBuf;
  };

  if (channels === 1) {
    work = processChannel(work);
  } else {
    const frames = Math.floor(work.length / channels);
    const processedChannels: Float32Array[] = [];
    for (let ch = 0; ch < channels; ch++) {
      const chData = new Float32Array(frames);
      for (let i = 0; i < frames; i++) {
        chData[i] = work[i * channels + ch];
      }
      processedChannels.push(processChannel(chData));
    }
    const outFrames = processedChannels[0].length;
    work = new Float32Array(outFrames * channels);
    for (let i = 0; i < outFrames; i++) {
      for (let ch = 0; ch < channels; ch++) {
        work[i * channels + ch] = processedChannels[ch][i];
      }
    }
  }

  // 8. Optional gentle loudness normalization (peak-safe up to -1.0 dBFS)
  if (options.normalizeLoudness) {
    const currentLufs = measureLufs(work, sampleRate, channels);
    if (currentLufs > -100) {
      const desiredGainDb = Math.max(-24, Math.min(24, options.targetLufs - currentLufs));
      let peak = 0;
      for (let i = 0; i < work.length; i++) {
        const a = Math.abs(work[i]);
        if (a > peak) peak = a;
      }
      const ceiling = dbToLinear(-1.0);
      const maxSafeGain = peak > 1e-9 ? ceiling / peak : 1;
      const gain = Math.min(dbToLinear(desiredGainDb), maxSafeGain);
      for (let i = 0; i < work.length; i++) {
        work[i] *= gain;
      }
    }
  }

  // 9. Resample to target sample rate if requested
  if (options.targetSampleRate > 0 && options.targetSampleRate !== sampleRate) {
    work = resamplePcm(work, sampleRate, options.targetSampleRate, channels);
    sampleRate = options.targetSampleRate;
  }

  // Final safety clamp
  for (let i = 0; i < work.length; i++) {
    work[i] = clampSample(work[i]);
  }

  return pcmToAudioBufferData(work, sampleRate, channels);
}
