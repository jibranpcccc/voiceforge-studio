import type { AudioBufferData, ChunkDspHints, MasteringPreset, MasteringSettings } from '../types';
import { downmixToMono, pcmToAudioBufferData, resamplePcm } from './decoder';
import {
  applyBiquadInPlace,
  applyFadeInOutInPlace,
  applySoftDeEsserInPlace,
  clampSample,
  dbToLinear,
  designHighShelf,
  designLowShelf,
  designPeaking,
  linearToDb,
  measureLufs,
  removeDcOffsetInPlace,
} from './dsp';

export interface MasteringExtraOptions {
  /** Pitch-preserving WSOLA speed multiplier (0.5 to 2.0, default: 1.0). */
  speed?: number;
  /** Optional peak normalization ceiling in dBFS (applied before true-peak limiter if set). */
  peakNormalizeDb?: number;
  /** Compress long internal pauses (> 600ms) down to ~350ms (default: false). */
  reduceExcessiveSilence?: boolean;
  /** Maximum internal pause duration in ms when `reduceExcessiveSilence` is enabled (default: 600). */
  maxInternalSilenceMs?: number;
}

export interface ChunkJoinOptions extends MasteringExtraOptions {
  /**
   * Fixed silence gap inserted between adjacent chunks in milliseconds (default: 0).
   * When > 0, silence is inserted without overlapping spoken phonemes.
   */
  pauseDurationMs?: number;
  /**
   * Optional per-chunk trailing pause overrides in milliseconds (length matches `chunks`).
   * Overrides `pauseDurationMs` for the corresponding boundary.
   */
  pauseDurationsMs?: number[];
  /**
   * Optional per-chunk subtle speed/EQ/trim hints driven by inline audio tags.
   */
  chunkDspHints?: Array<ChunkDspHints | undefined>;
  /**
   * Short cosine crossfade in milliseconds applied ONLY when joining adjacent chunks
   * directly without a silence gap (`pauseMs === 0`). Default: 8 ms (clamped to 0-12 ms).
   */
  crossfadeMs?: number;
}

export const MASTERING_PRESETS: Record<MasteringPreset, MasteringSettings> = {
  natural: {
    preset: 'natural',
    eqLowGainDb: 0.5,
    eqMidGainDb: 0.5,
    eqHighGainDb: 0.5,
    warmth: 0.15,
    clarity: 0.2,
    deEsserAmount: 0.2,
    compressorEnabled: true,
    compressorThresholdDb: -20,
    compressorRatio: 2.0,
    targetLufs: -18,
    truePeakLimitDb: -1.0,
    fadeInMs: 10,
    fadeOutMs: 40,
  },
  youtube: {
    preset: 'youtube',
    eqLowGainDb: 1.0,
    eqMidGainDb: 1.5,
    eqHighGainDb: 1.5,
    warmth: 0.2,
    clarity: 0.35,
    deEsserAmount: 0.3,
    compressorEnabled: true,
    compressorThresholdDb: -18,
    compressorRatio: 2.5,
    targetLufs: -14,
    truePeakLimitDb: -1.0,
    fadeInMs: 10,
    fadeOutMs: 50,
  },
  podcast: {
    preset: 'podcast',
    eqLowGainDb: 1.5,
    eqMidGainDb: 2.0,
    eqHighGainDb: 1.0,
    warmth: 0.25,
    clarity: 0.4,
    deEsserAmount: 0.35,
    compressorEnabled: true,
    compressorThresholdDb: -18,
    compressorRatio: 3.0,
    targetLufs: -16,
    truePeakLimitDb: -1.0,
    fadeInMs: 10,
    fadeOutMs: 50,
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
    compressorThresholdDb: 0,
    compressorRatio: 1.0,
    targetLufs: -18,
    truePeakLimitDb: -0.1,
    fadeInMs: 0,
    fadeOutMs: 0,
  },
  custom: {
    preset: 'custom',
    eqLowGainDb: 0,
    eqMidGainDb: 1.0,
    eqHighGainDb: 0.5,
    warmth: 0.15,
    clarity: 0.25,
    deEsserAmount: 0.25,
    compressorEnabled: true,
    compressorThresholdDb: -18,
    compressorRatio: 2.2,
    targetLufs: -16,
    truePeakLimitDb: -1.0,
    fadeInMs: 10,
    fadeOutMs: 40,
  },
};

/**
 * Pitch-preserving WSOLA (Waveform Similarity Overlap-Add) time-stretching for mono PCM.
 * Adjusts playback speed (`0.5` to `2.0`) while preserving vocal pitch and formants.
 */
export function wsolaTimeStretch(
  samples: Float32Array,
  sampleRate: number,
  speed: number
): Float32Array {
  if (!Number.isFinite(speed) || speed <= 0) {
    throw new Error(`Invalid playback speed: ${speed}`);
  }
  const clampedSpeed = Math.max(0.5, Math.min(2.0, speed));
  if (Math.abs(clampedSpeed - 1.0) < 1e-4 || samples.length === 0) {
    return new Float32Array(samples);
  }

  // ~28ms even window so Hs = N/2 gives exact Hann COLA sum = 1.0
  const halfWin = Math.max(32, Math.round(0.014 * sampleRate));
  const winLen = halfWin * 2;
  if (samples.length < winLen * 2) {
    // Too short for WSOLA overlap frames; fall back cleanly to linear resampled duration
    const outLen = Math.max(1, Math.round(samples.length / clampedSpeed));
    const out = new Float32Array(outLen);
    for (let i = 0; i < outLen; i++) {
      const pos = Math.min(samples.length - 1, i * clampedSpeed);
      const idx = Math.floor(pos);
      const frac = pos - idx;
      const s0 = samples[idx];
      const s1 = samples[Math.min(samples.length - 1, idx + 1)];
      out[i] = s0 + (s1 - s0) * frac;
    }
    return out;
  }

  const hann = new Float32Array(winLen);
  for (let i = 0; i < winLen; i++) {
    hann[i] = 0.5 * (1 - Math.cos((2 * Math.PI * i) / winLen));
  }

  const hs = halfWin; // Synthesis hop (50% overlap)
  const searchRadius = halfWin;
  const targetOutLen = Math.max(winLen, Math.round(samples.length / clampedSpeed));
  const out = new Float32Array(targetOutLen + winLen);
  const weightNorm = new Float32Array(targetOutLen + winLen);

  // Copy initial frame
  for (let i = 0; i < winLen; i++) {
    out[i] += samples[i] * hann[i];
    weightNorm[i] += hann[i];
  }

  let outPos = hs;
  let step = 1;

  while (outPos + winLen <= out.length) {
    const nominalInPos = Math.round(outPos * clampedSpeed);
    if (nominalInPos + winLen >= samples.length) {
      break;
    }

    // Find best similarity match in [nominalInPos - searchRadius, nominalInPos + searchRadius]
    // comparing the first `hs` samples of candidate frame against already-synthesized tail `out[outPos..outPos+hs]`.
    const minCand = Math.max(0, nominalInPos - searchRadius);
    const maxCand = Math.min(samples.length - winLen, nominalInPos + searchRadius);

    let bestOffset = nominalInPos;
    let bestScore = -Infinity;

    // Precompute tail energy in the overlap region
    let tailEnergy = 0;
    for (let k = 0; k < hs; k++) {
      const t = out[outPos + k];
      tailEnergy += t * t;
    }

    if (tailEnergy > 1e-10) {
      for (let cand = minCand; cand <= maxCand; cand += 2) {
        let cross = 0;
        let candEnergy = 0;
        for (let k = 0; k < hs; k += 2) {
          const t = out[outPos + k];
          const s = samples[cand + k] * hann[k];
          cross += t * s;
          candEnergy += s * s;
        }
        const denom = Math.sqrt(tailEnergy * candEnergy);
        const corr = denom > 1e-10 ? cross / denom : 0;
        if (corr > bestScore) {
          bestScore = corr;
          bestOffset = cand;
        }
      }
    }

    for (let i = 0; i < winLen; i++) {
      out[outPos + i] += samples[bestOffset + i] * hann[i];
      weightNorm[outPos + i] += hann[i];
    }

    outPos += hs;
    step++;
    if (step > 1_000_000) break;
  }

  const finalLen = Math.min(targetOutLen, outPos + hs);
  const result = new Float32Array(finalLen);
  for (let i = 0; i < finalLen; i++) {
    const w = weightNorm[i];
    result[i] = w > 1e-6 ? out[i] / w : out[i];
  }

  return result;
}

/**
 * Compress excessively long internal silent pauses (> `maxSilenceMs`) down to `targetSilenceMs`.
 */
export function reduceExcessiveSilenceInPcm(
  samples: Float32Array,
  sampleRate: number,
  maxSilenceMs: number = 600,
  targetSilenceMs: number = 350,
  thresholdDb: number = -48
): Float32Array {
  const frameSize = Math.max(1, Math.round(0.02 * sampleRate));
  const numFrames = Math.floor(samples.length / frameSize);
  const minRunFrames = Math.ceil(maxSilenceMs / 20);
  const keepFrames = Math.max(1, Math.floor(targetSilenceMs / 20));
  if (numFrames <= minRunFrames) {
    return new Float32Array(samples);
  }

  const isSilent = new Uint8Array(numFrames);
  for (let f = 0; f < numFrames; f++) {
    const start = f * frameSize;
    let sumSq = 0;
    for (let i = 0; i < frameSize; i++) {
      const s = samples[start + i];
      sumSq += s * s;
    }
    if (linearToDb(Math.sqrt(sumSq / frameSize)) < thresholdDb) {
      isSilent[f] = 1;
    }
  }

  const segments: Float32Array[] = [];
  let f = 0;
  while (f < numFrames) {
    if (isSilent[f] === 0) {
      const start = f;
      while (f < numFrames && isSilent[f] === 0) f++;
      segments.push(samples.subarray(start * frameSize, f * frameSize));
    } else {
      const start = f;
      while (f < numFrames && isSilent[f] === 1) f++;
      const runLen = f - start;
      // Preserve leading/trailing audio cleanly; compress long internal pauses
      const isInternal = start > 0 && f < numFrames;
      if (isInternal && runLen > minRunFrames) {
        const halfKeep = Math.floor(keepFrames / 2);
        segments.push(samples.subarray(start * frameSize, (start + halfKeep) * frameSize));
        segments.push(
          samples.subarray((f - (keepFrames - halfKeep)) * frameSize, f * frameSize)
        );
      } else {
        segments.push(samples.subarray(start * frameSize, f * frameSize));
      }
    }
  }

  const remainderStart = numFrames * frameSize;
  if (remainderStart < samples.length) {
    segments.push(samples.subarray(remainderStart));
  }

  const totalLen = segments.reduce((sum, s) => sum + s.length, 0);
  const out = new Float32Array(totalLen);
  let offset = 0;
  for (const seg of segments) {
    out.set(seg, offset);
    offset += seg.length;
  }
  return out;
}

function applyWarmthSaturationInPlace(samples: Float32Array, warmth: number): void {
  const amount = Math.max(0, Math.min(1, warmth));
  if (amount <= 0) return;

  const drive = 1 + amount * 2.2;
  const invTanhDrive = 1 / Math.tanh(drive);
  const blend = amount * 0.35;

  for (let i = 0; i < samples.length; i++) {
    const x = samples[i];
    const saturated = Math.tanh(x * drive) * invTanhDrive;
    samples[i] = x * (1 - blend) + saturated * blend;
  }
}

function applyFeedForwardCompressorInPlace(
  samples: Float32Array,
  sampleRate: number,
  thresholdDb: number,
  ratio: number
): void {
  if (samples.length === 0 || ratio <= 1) return;

  const attackCoeff = Math.exp(-1 / Math.max(1, 0.01 * sampleRate));
  const releaseCoeff = Math.exp(-1 / Math.max(1, 0.1 * sampleRate));
  const kneeWidthDb = 6;
  const halfKnee = kneeWidthDb / 2;
  const slope = 1 - 1 / ratio;

  let envDb = -96;
  for (let i = 0; i < samples.length; i++) {
    const levelDb = linearToDb(Math.abs(samples[i]), -96);
    const coeff = levelDb > envDb ? attackCoeff : releaseCoeff;
    envDb = coeff * envDb + (1 - coeff) * levelDb;

    let gainReductionDb = 0;
    const overDb = envDb - thresholdDb;
    if (overDb >= halfKnee) {
      gainReductionDb = -overDb * slope;
    } else if (overDb > -halfKnee) {
      const kneeDelta = overDb + halfKnee;
      gainReductionDb = -(slope * kneeDelta * kneeDelta) / (2 * kneeWidthDb);
    }

    if (gainReductionDb < 0) {
      samples[i] *= dbToLinear(gainReductionDb);
    }
  }
}

/**
 * Evaluate 4x Catmull-Rom oversampled inter-sample peak around sample `i`.
 */
function cubicInterpolate(y0: number, y1: number, y2: number, y3: number, t: number): number {
  const t2 = t * t;
  const t3 = t2 * t;
  return (
    0.5 *
    (2 * y1 +
      (-y0 + y2) * t +
      (2 * y0 - 5 * y1 + 4 * y2 - y3) * t2 +
      (-y0 + 3 * y1 - 3 * y2 + y3) * t3)
  );
}

/**
 * Measure the 4x oversampled true-peak amplitude in dBTP.
 */
export function measureTruePeakDb(samples: Float32Array): number {
  if (samples.length === 0) return -120;
  let maxAbs = 0;
  for (let i = 0; i < samples.length; i++) {
    const a = Math.abs(samples[i]);
    if (a > maxAbs) maxAbs = a;

    if (i > 0 && i + 2 < samples.length) {
      const y0 = samples[i - 1];
      const y1 = samples[i];
      const y2 = samples[i + 1];
      const y3 = samples[i + 2];
      for (const t of [0.25, 0.5, 0.75]) {
        const interp = Math.abs(cubicInterpolate(y0, y1, y2, y3, t));
        if (interp > maxAbs) maxAbs = interp;
      }
    }
  }
  return linearToDb(maxAbs);
}

/**
 * Apply a 4x oversampled lookahead true-peak brickwall limiter in place so that
 * inter-sample peaks never exceed `truePeakLimitDb`.
 */
export function applyTruePeakLimiterInPlace(
  samples: Float32Array,
  sampleRate: number,
  truePeakLimitDb: number
): void {
  if (samples.length === 0) return;

  const ceiling = dbToLinear(Math.min(0, truePeakLimitDb));
  const lookaheadSamples = Math.max(1, Math.round(0.004 * sampleRate));
  const releaseCoeff = Math.exp(-1 / Math.max(1, 0.05 * sampleRate));

  // Compute 4x oversampled peak envelope per sample
  const peakEnv = new Float32Array(samples.length);
  for (let i = 0; i < samples.length; i++) {
    let localMax = Math.abs(samples[i]);
    if (i > 0 && i + 2 < samples.length) {
      const y0 = samples[i - 1];
      const y1 = samples[i];
      const y2 = samples[i + 1];
      const y3 = samples[i + 2];
      for (const t of [0.25, 0.5, 0.75]) {
        const interp = Math.abs(cubicInterpolate(y0, y1, y2, y3, t));
        if (interp > localMax) localMax = interp;
      }
    }
    peakEnv[i] = localMax;
  }

  // Forward-looking minimum required gain with smooth attack & release
  const requiredGain = new Float32Array(samples.length);
  requiredGain.fill(1.0);

  for (let i = 0; i < samples.length; i++) {
    if (peakEnv[i] > ceiling) {
      const needed = ceiling / peakEnv[i];
      const winStart = Math.max(0, i - lookaheadSamples);
      for (let j = winStart; j <= i; j++) {
        const alpha = (j - winStart + 1) / (i - winStart + 1);
        const target = 1 - alpha * (1 - needed);
        if (target < requiredGain[j]) {
          requiredGain[j] = target;
        }
      }
      requiredGain[i] = Math.min(requiredGain[i], needed);
    }
  }

  let gain = 1.0;
  for (let i = 0; i < samples.length; i++) {
    const target = requiredGain[i];
    if (target < gain) {
      gain = target;
    } else {
      gain = releaseCoeff * gain + (1 - releaseCoeff) * target;
    }
    samples[i] *= gain;
  }

  // Safety guarantee against any remaining inter-sample overshoot on steep transients
  for (let pass = 0; pass < 2; pass++) {
    let overshoot = false;
    for (let i = 0; i < samples.length; i++) {
      if (Math.abs(samples[i]) > ceiling) {
        samples[i] = Math.sign(samples[i]) * ceiling;
      }
      if (i > 0 && i + 2 < samples.length) {
        const y0 = samples[i - 1];
        const y1 = samples[i];
        const y2 = samples[i + 1];
        const y3 = samples[i + 2];
        const p25 = Math.abs(cubicInterpolate(y0, y1, y2, y3, 0.25));
        const p50 = Math.abs(cubicInterpolate(y0, y1, y2, y3, 0.5));
        const p75 = Math.abs(cubicInterpolate(y0, y1, y2, y3, 0.75));
        const maxInter = Math.max(p25, p50, p75);
        if (maxInter > ceiling) {
          overshoot = true;
          const scale = (ceiling * 0.998) / maxInter;
          samples[i] *= scale;
          samples[i + 1] *= scale;
        }
      }
    }
    if (!overshoot) break;
  }
}

function processMonoMaster(
  monoInput: Float32Array,
  sampleRate: number,
  settings: MasteringSettings & MasteringExtraOptions
): Float32Array {
  let work: Float32Array = new Float32Array(monoInput);

  // 'raw' preset bypasses all mastering DSP
  if (settings.preset === 'raw') {
    return work;
  }

  // 1. DC offset removal
  removeDcOffsetInPlace(work, 1);

  // 2. Pitch-preserving speed adjustment (WSOLA)
  if (settings.speed !== undefined && Math.abs(settings.speed - 1.0) > 1e-4) {
    work = wsolaTimeStretch(work, sampleRate, settings.speed);
  }

  // 3. Optional excessive silence compression
  if (settings.reduceExcessiveSilence) {
    work = reduceExcessiveSilenceInPcm(
      work,
      sampleRate,
      settings.maxInternalSilenceMs ?? 600
    );
  }

  // 4. 3-band EQ + clarity boost
  if (Math.abs(settings.eqLowGainDb) > 0.05) {
    applyBiquadInPlace(work, designLowShelf(sampleRate, 120, settings.eqLowGainDb, 0.9));
  }
  if (Math.abs(settings.eqMidGainDb) > 0.05) {
    applyBiquadInPlace(work, designPeaking(sampleRate, 2400, settings.eqMidGainDb, 1.0));
  }
  if (Math.abs(settings.eqHighGainDb) > 0.05) {
    applyBiquadInPlace(work, designHighShelf(sampleRate, 7000, settings.eqHighGainDb, 0.9));
  }
  if (settings.clarity > 0.01) {
    applyBiquadInPlace(
      work,
      designPeaking(sampleRate, 3400, Math.min(4.5, settings.clarity * 3.5), 1.2)
    );
  }

  // 5. Subtle harmonic warmth saturation
  if (settings.warmth > 0.01) {
    applyWarmthSaturationInPlace(work, settings.warmth);
  }

  // 6. De-esser
  if (settings.deEsserAmount > 0.01) {
    applySoftDeEsserInPlace(work, sampleRate, settings.deEsserAmount);
  }

  // 7. Gentle feed-forward dynamics compression
  if (settings.compressorEnabled && settings.compressorRatio > 1.01) {
    applyFeedForwardCompressorInPlace(
      work,
      sampleRate,
      settings.compressorThresholdDb,
      settings.compressorRatio
    );
  }

  // 8. ITU-R BS.1770 K-weighted LUFS loudness normalization
  const currentLufs = measureLufs(work, sampleRate, 1);
  if (currentLufs > -100) {
    const gainDb = Math.max(-24, Math.min(24, settings.targetLufs - currentLufs));
    const gain = dbToLinear(gainDb);
    for (let i = 0; i < work.length; i++) {
      work[i] *= gain;
    }
  }

  // Optional peak normalization cap
  if (settings.peakNormalizeDb !== undefined) {
    let peak = 0;
    for (let i = 0; i < work.length; i++) {
      const a = Math.abs(work[i]);
      if (a > peak) peak = a;
    }
    if (peak > 1e-9) {
      const targetPeak = dbToLinear(settings.peakNormalizeDb);
      const scale = targetPeak / peak;
      for (let i = 0; i < work.length; i++) {
        work[i] *= scale;
      }
    }
  }

  // 9. Fade-in & fade-out (before limiter)
  if (settings.fadeInMs > 0 || settings.fadeOutMs > 0) {
    applyFadeInOutInPlace(work, sampleRate, settings.fadeInMs, settings.fadeOutMs, 1);
  }

  // 10. 4x oversampled true-peak brickwall limiter
  applyTruePeakLimiterInPlace(work, sampleRate, settings.truePeakLimitDb);

  for (let i = 0; i < work.length; i++) {
    work[i] = clampSample(work[i]);
  }

  return work;
}

/**
 * Non-destructively master a single `AudioBufferData` according to `MasteringSettings`.
 * When `settings.preset === 'raw'`, returns a clean copy with zero DSP alteration.
 */
export function masterAudio(
  audio: AudioBufferData,
  settings: MasteringSettings & MasteringExtraOptions
): AudioBufferData {
  if (!audio || !audio.samples || audio.samples.length === 0) {
    throw new Error('Cannot master an empty audio buffer.');
  }

  if (settings.preset === 'raw') {
    return pcmToAudioBufferData(audio.samples, audio.sampleRate, audio.channels);
  }

  const channels = Math.max(1, audio.channels || 1);
  if (channels === 1) {
    const processed = processMonoMaster(audio.samples, audio.sampleRate, settings);
    return pcmToAudioBufferData(processed, audio.sampleRate, 1);
  }

  const frames = Math.floor(audio.samples.length / channels);
  const processedChannels: Float32Array[] = [];
  for (let ch = 0; ch < channels; ch++) {
    const chData = new Float32Array(frames);
    for (let i = 0; i < frames; i++) {
      chData[i] = audio.samples[i * channels + ch];
    }
    processedChannels.push(processMonoMaster(chData, audio.sampleRate, settings));
  }

  const outFrames = processedChannels[0].length;
  const interleaved = new Float32Array(outFrames * channels);
  for (let i = 0; i < outFrames; i++) {
    for (let ch = 0; ch < channels; ch++) {
      interleaved[i * channels + ch] = processedChannels[ch][i];
    }
  }
  return pcmToAudioBufferData(interleaved, audio.sampleRate, channels);
}

/**
 * Stitch and master multiple synthesized narration chunks non-destructively.
 *
 * - Inserts configurable silence gaps (`pauseDurationMs` or `pauseDurationsMs[i]`) cleanly
 *   without overlapping spoken phonemes.
 * - Uses short (5-10ms default 8ms) raised-cosine crossfades ONLY when joining two chunks
 *   directly with zero silence gap (`pauseMs === 0`).
 * - Applies mastering DSP across the stitched timeline (bypassed when `preset === 'raw'`).
 */
function applyChunkDspHints(
  mono: Float32Array,
  sampleRate: number,
  hints?: ChunkDspHints
): Float32Array {
  if (!hints || mono.length === 0) return mono;

  let working = mono;
  if (
    typeof hints.speedMultiplier === 'number' &&
    Number.isFinite(hints.speedMultiplier) &&
    Math.abs(hints.speedMultiplier - 1.0) >= 0.005
  ) {
    const safeSpeed = Math.max(0.85, Math.min(1.18, hints.speedMultiplier));
    working = wsolaTimeStretch(working, sampleRate, safeSpeed);
  } else {
    working = new Float32Array(working);
  }

  if (typeof hints.eqLowDeltaDb === 'number' && Math.abs(hints.eqLowDeltaDb) >= 0.05) {
    applyBiquadInPlace(
      working,
      designLowShelf(sampleRate, 180, Math.max(-6, Math.min(6, hints.eqLowDeltaDb)))
    );
  }
  if (typeof hints.eqMidDeltaDb === 'number' && Math.abs(hints.eqMidDeltaDb) >= 0.05) {
    applyBiquadInPlace(
      working,
      designPeaking(sampleRate, 1800, 1.0, Math.max(-4, Math.min(4, hints.eqMidDeltaDb)))
    );
  }
  if (typeof hints.eqHighDeltaDb === 'number' && Math.abs(hints.eqHighDeltaDb) >= 0.05) {
    applyBiquadInPlace(
      working,
      designHighShelf(sampleRate, 4500, Math.max(-6, Math.min(6, hints.eqHighDeltaDb)))
    );
  }
  if (typeof hints.gainDeltaDb === 'number' && Math.abs(hints.gainDeltaDb) >= 0.05) {
    const gain = dbToLinear(Math.max(-6, Math.min(4, hints.gainDeltaDb)));
    for (let i = 0; i < working.length; i += 1) {
      working[i] = clampSample(working[i] * gain);
    }
  }

  return working;
}

export function masterNarrationChunks(
  chunks: AudioBufferData[],
  settings: MasteringSettings & MasteringExtraOptions,
  joinOptions: ChunkJoinOptions = {}
): AudioBufferData {
  if (!chunks || chunks.length === 0) {
    throw new Error('Cannot master an empty narration chunk list.');
  }

  const targetSampleRate = chunks[0].sampleRate;
  const normalizedChunks: Float32Array[] = chunks.map((chunk, idx) => {
    let mono = downmixToMono(chunk.samples, Math.max(1, chunk.channels || 1));
    if (chunk.sampleRate !== targetSampleRate) {
      mono = resamplePcm(mono, chunk.sampleRate, targetSampleRate, 1);
    }
    return applyChunkDspHints(mono, targetSampleRate, joinOptions.chunkDspHints?.[idx]);
  });

  const defaultPauseMs = Math.max(0, joinOptions.pauseDurationMs ?? 0);
  const crossfadeMs = Math.max(0, Math.min(12, joinOptions.crossfadeMs ?? 8));
  const crossfadeSamples = Math.round((crossfadeMs / 1000) * targetSampleRate);
  const edgeMicroFadeSamples = Math.min(
    Math.round(0.004 * targetSampleRate),
    64
  );

  // Build stitched timeline
  let totalLength = normalizedChunks[0].length;
  const boundaryPauses: number[] = [];

  for (let i = 0; i < normalizedChunks.length - 1; i++) {
    const pauseMs = Math.max(
      0,
      joinOptions.pauseDurationsMs?.[i] ?? defaultPauseMs
    );
    const pauseSamples = Math.round((pauseMs / 1000) * targetSampleRate);
    boundaryPauses.push(pauseSamples);

    if (pauseSamples > 0) {
      totalLength += pauseSamples + normalizedChunks[i + 1].length;
    } else {
      const overlap = Math.min(
        crossfadeSamples,
        Math.floor(normalizedChunks[i].length / 4),
        Math.floor(normalizedChunks[i + 1].length / 4)
      );
      totalLength += normalizedChunks[i + 1].length - overlap;
    }
  }

  const stitched = new Float32Array(Math.max(1, totalLength));
  stitched.set(normalizedChunks[0], 0);
  let cursor = normalizedChunks[0].length;

  for (let i = 0; i < normalizedChunks.length - 1; i++) {
    const nextChunk = normalizedChunks[i + 1];
    const pauseSamples = boundaryPauses[i];

    if (pauseSamples > 0) {
      // Smooth tiny micro-fade at boundary to avoid click into silence without overlapping speech
      if (edgeMicroFadeSamples > 1 && cursor >= edgeMicroFadeSamples) {
        for (let k = 0; k < edgeMicroFadeSamples; k++) {
          const g = 0.5 * (1 + Math.cos((Math.PI * k) / (edgeMicroFadeSamples - 1)));
          stitched[cursor - edgeMicroFadeSamples + k] *= g;
        }
      }
      cursor += pauseSamples; // Zero-initialized gap
      stitched.set(nextChunk, cursor);
      if (edgeMicroFadeSamples > 1 && nextChunk.length >= edgeMicroFadeSamples) {
        for (let k = 0; k < edgeMicroFadeSamples; k++) {
          const g = 0.5 * (1 - Math.cos((Math.PI * k) / (edgeMicroFadeSamples - 1)));
          stitched[cursor + k] *= g;
        }
      }
      cursor += nextChunk.length;
    } else {
      const overlap = Math.min(
        crossfadeSamples,
        Math.floor(normalizedChunks[i].length / 4),
        Math.floor(nextChunk.length / 4)
      );
      if (overlap > 1) {
        const crossStart = cursor - overlap;
        for (let k = 0; k < overlap; k++) {
          const fadeOut = 0.5 * (1 + Math.cos((Math.PI * k) / (overlap - 1)));
          const fadeIn = 0.5 * (1 - Math.cos((Math.PI * k) / (overlap - 1)));
          stitched[crossStart + k] =
            stitched[crossStart + k] * fadeOut + nextChunk[k] * fadeIn;
        }
        stitched.set(nextChunk.subarray(overlap), cursor);
        cursor += nextChunk.length - overlap;
      } else {
        stitched.set(nextChunk, cursor);
        cursor += nextChunk.length;
      }
    }
  }

  const merged = pcmToAudioBufferData(
    stitched.subarray(0, cursor),
    targetSampleRate,
    1
  );

  // Merge extra options from joinOptions with settings
  const mergedSettings: MasteringSettings & MasteringExtraOptions = {
    ...settings,
    speed: joinOptions.speed ?? settings.speed,
    peakNormalizeDb: joinOptions.peakNormalizeDb ?? settings.peakNormalizeDb,
    reduceExcessiveSilence:
      joinOptions.reduceExcessiveSilence ?? settings.reduceExcessiveSilence,
    maxInternalSilenceMs:
      joinOptions.maxInternalSilenceMs ?? settings.maxInternalSilenceMs,
  };

  return masterAudio(merged, mergedSettings);
}
