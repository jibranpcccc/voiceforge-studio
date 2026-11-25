import type {
  AudioBufferData,
  AudioQualityAnalysis,
  ClippingAnalysis,
  MultiSpeakerEstimate,
  ReverbEstimate,
  SilenceAnalysis,
} from '../types';
import { downmixToMono } from './decoder';

export interface AnalyzeQualityOptions {
  /** Engine-specific minimum recommended reference audio duration in seconds (default: 5). */
  minRecommendedSec?: number;
  /** Engine-specific maximum recommended reference audio duration in seconds (default: 15). */
  maxRecommendedSec?: number;
  /** RMS threshold in dBFS for silence detection on 20ms frames (default: -45). */
  silenceThresholdDb?: number;
}

const MIN_DB = -120;
const CLIP_THRESHOLD = 0.999;

function linearToDb(linear: number): number {
  if (!Number.isFinite(linear) || linear <= 0) {
    return MIN_DB;
  }
  return Math.max(MIN_DB, 20 * Math.log10(linear));
}

function percentile(sorted: number[], p: number): number {
  if (sorted.length === 0) return MIN_DB;
  const clamped = Math.max(0, Math.min(1, p));
  const idx = clamped * (sorted.length - 1);
  const lo = Math.floor(idx);
  const hi = Math.ceil(idx);
  if (lo === hi) return sorted[lo];
  return sorted[lo] + (sorted[hi] - sorted[lo]) * (idx - lo);
}

function analyzeClipping(samples: Float32Array): ClippingAnalysis {
  let clippedSampleCount = 0;
  for (let i = 0; i < samples.length; i++) {
    if (Math.abs(samples[i]) >= CLIP_THRESHOLD) {
      clippedSampleCount++;
    }
  }
  const clippedPercentage =
    samples.length > 0 ? (clippedSampleCount / samples.length) * 100 : 0;
  const hasSevereClipping = clippedPercentage >= 0.1 || clippedSampleCount >= 50;

  return {
    clippedSampleCount,
    clippedPercentage,
    hasSevereClipping,
  };
}

interface FrameStats {
  frameDb: Float64Array;
  frameRms: Float64Array;
  frameSize: number;
  frameDurationSec: number;
}

function compute20msFrames(mono: Float32Array, sampleRate: number): FrameStats {
  const frameSize = Math.max(1, Math.min(mono.length, Math.round(0.02 * sampleRate)));
  const numFrames = Math.max(1, Math.floor(mono.length / frameSize));
  const frameDb = new Float64Array(numFrames);
  const frameRms = new Float64Array(numFrames);

  for (let f = 0; f < numFrames; f++) {
    const start = f * frameSize;
    const end = f === numFrames - 1 ? mono.length : start + frameSize;
    let sumSq = 0;
    for (let i = start; i < end; i++) {
      const s = mono[i];
      sumSq += s * s;
    }
    const count = Math.max(1, end - start);
    const rms = Math.sqrt(sumSq / count);
    frameRms[f] = rms;
    frameDb[f] = linearToDb(rms);
  }

  return {
    frameDb,
    frameRms,
    frameSize,
    frameDurationSec: frameSize / sampleRate,
  };
}

function analyzeSilence(
  frameDb: Float64Array,
  frameDurationSec: number,
  durationSec: number,
  silenceThresholdDb: number
): { silence: SilenceAnalysis; activeIndices: number[] } {
  const numFrames = frameDb.length;
  const activeIndices: number[] = [];
  let firstActive = -1;
  let lastActive = -1;

  for (let f = 0; f < numFrames; f++) {
    if (frameDb[f] > silenceThresholdDb) {
      activeIndices.push(f);
      if (firstActive === -1) firstActive = f;
      lastActive = f;
    }
  }

  if (firstActive === -1) {
    return {
      silence: {
        leadingSilenceSec: durationSec,
        trailingSilenceSec: 0,
        silenceRatio: 1,
        activeSpeechDurationSec: 0,
      },
      activeIndices,
    };
  }

  const silentFrames = numFrames - activeIndices.length;
  const silenceRatio = Math.max(0, Math.min(1, silentFrames / numFrames));
  const leadingSilenceSec = Math.min(durationSec, firstActive * frameDurationSec);
  const trailingSilenceSec = Math.min(
    Math.max(0, durationSec - leadingSilenceSec),
    (numFrames - 1 - lastActive) * frameDurationSec
  );
  const activeSpeechDurationSec = Math.max(0, durationSec * (1 - silenceRatio));

  return {
    silence: {
      leadingSilenceSec,
      trailingSilenceSec,
      silenceRatio,
      activeSpeechDurationSec,
    },
    activeIndices,
  };
}

/**
 * DSP heuristic estimating room reverberation from 20ms envelope decay tails.
 *
 * NOTE: This is an approximate digital signal processing heuristic (not an ISO 3382
 * room impulse response / RT60 measurement). It examines how slowly syllable/transient
 * peaks decay across subsequent 20ms frames; sustained vowels can moderately raise the score.
 */
function estimateReverbHeuristic(frameRms: Float64Array, frameDb: Float64Array): ReverbEstimate {
  const n = frameRms.length;
  if (n < 10) {
    return { score: 0, level: 'dry' };
  }

  const maxDb = Math.max(...frameDb);
  if (maxDb <= -55) {
    return { score: 0, level: 'dry' };
  }

  const peakThresholdDb = Math.max(-45, maxDb - 24);
  const decayRatesDbPerSec: number[] = [];
  let tailEnergySum = 0;
  let peakEnergySum = 0;

  // Look for local energy peaks and measure dB drop over the next 80ms-140ms (4-7 frames)
  for (let i = 1; i < n - 6; i++) {
    if (
      frameDb[i] > peakThresholdDb &&
      frameDb[i] >= frameDb[i - 1] &&
      frameDb[i] > frameDb[i + 1]
    ) {
      const peakDb = frameDb[i];
      const tailDb = Math.min(frameDb[i + 3], frameDb[i + 5]);
      const dropDb = Math.max(0, peakDb - tailDb);
      // 5 frames = 100ms
      decayRatesDbPerSec.push(dropDb / 0.1);
      peakEnergySum += frameRms[i] * frameRms[i];
      tailEnergySum +=
        (frameRms[i + 2] * frameRms[i + 2] +
          frameRms[i + 3] * frameRms[i + 3] +
          frameRms[i + 4] * frameRms[i + 4]) /
        3;
    }
  }

  if (decayRatesDbPerSec.length === 0) {
    return { score: 0.15, level: 'dry' };
  }

  const avgDecayDbPerSec =
    decayRatesDbPerSec.reduce((a, b) => a + b, 0) / decayRatesDbPerSec.length;
  const tailToPeakRatio = peakEnergySum > 0 ? tailEnergySum / peakEnergySum : 0;

  // Dry speech drops quickly (~150-300+ dB/s in 100ms post-transient); reverberant speech decays slowly (<90 dB/s)
  const slowDecayComponent = Math.max(0, Math.min(1, (180 - avgDecayDbPerSec) / 140));
  const tailEnergyComponent = Math.max(0, Math.min(1, (tailToPeakRatio - 0.15) / 0.55));
  const score = Math.max(
    0,
    Math.min(1, 0.6 * slowDecayComponent + 0.4 * tailEnergyComponent)
  );

  const level: ReverbEstimate['level'] =
    score >= 0.65 ? 'reverberant' : score >= 0.35 ? 'moderate' : 'dry';

  return { score, level };
}

function estimateFramePitchHz(
  mono: Float32Array,
  start: number,
  length: number,
  sampleRate: number
): number | null {
  const minLag = Math.max(2, Math.floor(sampleRate / 350)); // 350 Hz upper F0
  const maxLag = Math.min(Math.floor(length / 2), Math.floor(sampleRate / 70)); // 70 Hz lower F0
  if (maxLag <= minLag) return null;

  let energy0 = 0;
  for (let i = 0; i < length; i++) {
    const s = mono[start + i];
    energy0 += s * s;
  }
  if (energy0 <= 1e-9) return null;

  const corrs = new Float32Array(maxLag - minLag + 1);
  let bestNormCorr = 0;

  for (let lag = minLag; lag <= maxLag; lag++) {
    let cross = 0;
    let e1 = 0;
    let e2 = 0;
    const limit = length - lag;
    for (let i = 0; i < limit; i++) {
      const a = mono[start + i];
      const b = mono[start + i + lag];
      cross += a * b;
      e1 += a * a;
      e2 += b * b;
    }
    const denom = Math.sqrt(e1 * e2);
    if (denom > 1e-9) {
      const corr = cross / denom;
      corrs[lag - minLag] = corr;
      if (corr > bestNormCorr) {
        bestNormCorr = corr;
      }
    }
  }

  // Require periodic voicing confidence >= 0.55
  if (bestNormCorr < 0.55) {
    return null;
  }

  // Pick the first local peak >= 0.92 * bestNormCorr to avoid 2*T subharmonic octave errors.
  const threshold = Math.max(0.55, bestNormCorr * 0.92);
  let bestLag = -1;
  for (let i = 1; i < corrs.length - 1; i++) {
    if (
      corrs[i] >= threshold &&
      corrs[i] >= corrs[i - 1] &&
      corrs[i] >= corrs[i + 1]
    ) {
      bestLag = minLag + i;
      break;
    }
  }

  if (bestLag <= 0) {
    let maxIdx = 0;
    for (let i = 1; i < corrs.length; i++) {
      if (corrs[i] > corrs[maxIdx]) maxIdx = i;
    }
    bestLag = minLag + maxIdx;
  }

  return sampleRate / bestLag;
}

function estimateZeroCrossingRate(mono: Float32Array, start: number, length: number): number {
  if (length < 2) return 0;
  let crossings = 0;
  for (let i = 1; i < length; i++) {
    const prev = mono[start + i - 1];
    const curr = mono[start + i];
    if ((prev >= 0 && curr < 0) || (prev < 0 && curr >= 0)) {
      crossings++;
    }
  }
  return crossings / (length - 1);
}

/**
 * DSP heuristic estimating whether multiple speakers or overlapping voices are present.
 *
 * NOTE: This is an approximate DSP heuristic based on voiced fundamental-frequency (F0)
 * bimodality and zero-crossing/spectral spread across active frames. Expressive single-speaker
 * prosody can elevate the score; it is not a neural speaker diarization model.
 */
function estimateMultiSpeakerHeuristic(
  mono: Float32Array,
  sampleRate: number,
  frameSize: number,
  activeIndices: number[]
): MultiSpeakerEstimate {
  if (activeIndices.length < 8) {
    return { score: 0, suspectedMultipleSpeakers: false };
  }

  const logF0Values: number[] = [];
  const zcrValues: number[] = [];
  // Step through active frames (cap work for long clips by sampling up to 160 frames)
  const stride = Math.max(1, Math.floor(activeIndices.length / 160));
  const analysisLen = Math.min(mono.length, Math.max(frameSize, Math.round(0.03 * sampleRate)));

  for (let idx = 0; idx < activeIndices.length; idx += stride) {
    const f = activeIndices[idx];
    const start = f * frameSize;
    if (start + analysisLen > mono.length) continue;

    const f0 = estimateFramePitchHz(mono, start, analysisLen, sampleRate);
    if (f0 !== null) {
      logF0Values.push(Math.log2(f0));
      zcrValues.push(estimateZeroCrossingRate(mono, start, analysisLen));
    }
  }

  if (logF0Values.length < 6) {
    return { score: 0.05, suspectedMultipleSpeakers: false };
  }

  const meanLogF0 = logF0Values.reduce((a, b) => a + b, 0) / logF0Values.length;
  const varianceLogF0 =
    logF0Values.reduce((sum, v) => sum + (v - meanLogF0) * (v - meanLogF0), 0) /
    logF0Values.length;
  const stdOctaves = Math.sqrt(varianceLogF0);

  // Measure bimodality by splitting around median/mean F0
  const sortedLogF0 = [...logF0Values].sort((a, b) => a - b);
  const q20 = percentile(sortedLogF0, 0.2);
  const q80 = percentile(sortedLogF0, 0.8);
  const interQuantileOctaves = q80 - q20;

  const meanZcr = zcrValues.reduce((a, b) => a + b, 0) / zcrValues.length;
  const stdZcr = Math.sqrt(
    zcrValues.reduce((sum, v) => sum + (v - meanZcr) * (v - meanZcr), 0) / zcrValues.length
  );

  // Single speaker typically has stdOctaves ~ 0.08-0.20 and q80-q20 < 0.35 octaves.
  // Two distinct voices (e.g. 115Hz vs 210Hz) produce stdOctaves >= 0.35 and q80-q20 >= 0.65.
  const pitchSpreadScore = Math.max(0, Math.min(1, (stdOctaves - 0.18) / 0.28));
  const bimodalGapScore = Math.max(0, Math.min(1, (interQuantileOctaves - 0.35) / 0.55));
  const timbreSpreadScore = Math.max(0, Math.min(1, (stdZcr - 0.025) / 0.06));

  const score = Math.max(
    0,
    Math.min(1, 0.45 * pitchSpreadScore + 0.4 * bimodalGapScore + 0.15 * timbreSpreadScore)
  );

  return {
    score,
    suspectedMultipleSpeakers: score >= 0.58,
  };
}

/**
 * Analyze reference audio quality for local voice cloning readiness.
 *
 * Computes clipping, 20ms-frame silence statistics, 10th-percentile noise floor & SNR,
 * integrated RMS/peak dBFS, heuristic reverberation & multi-speaker indicators, and
 * model-tailored duration/preprocessing recommendations.
 */
export function analyzeReferenceAudio(
  audio: AudioBufferData,
  options: AnalyzeQualityOptions = {}
): AudioQualityAnalysis {
  if (!audio || !audio.samples || audio.samples.length === 0) {
    throw new Error('Cannot analyze quality of an empty audio buffer.');
  }
  if (!Number.isFinite(audio.sampleRate) || audio.sampleRate <= 0) {
    throw new Error(`Invalid sampleRate for quality analysis: ${audio.sampleRate}`);
  }

  const minRecommendedSec = options.minRecommendedSec ?? 5;
  const maxRecommendedSec = options.maxRecommendedSec ?? 15;
  const silenceThresholdDb = options.silenceThresholdDb ?? -45;

  const channels = Math.max(1, audio.channels || 1);
  const mono = downmixToMono(audio.samples, channels);
  const durationSec = mono.length / audio.sampleRate;

  // 1. Clipping (checked on original interleaved samples so channel peaks are never masked by downmixing)
  const clipping = analyzeClipping(audio.samples);

  // 2. Peak & Integrated RMS
  let peakLinear = 0;
  for (let i = 0; i < audio.samples.length; i++) {
    const abs = Math.abs(audio.samples[i]);
    if (abs > peakLinear) peakLinear = abs;
  }
  const peakDb = linearToDb(peakLinear);

  let sumSq = 0;
  for (let i = 0; i < mono.length; i++) {
    sumSq += mono[i] * mono[i];
  }
  const rmsLinear = mono.length > 0 ? Math.sqrt(sumSq / mono.length) : 0;
  const rmsDb = linearToDb(rmsLinear);

  // 3. 20ms frame silence & noise floor / SNR analysis
  const { frameDb, frameRms, frameSize, frameDurationSec } = compute20msFrames(
    mono,
    audio.sampleRate
  );
  const { silence, activeIndices } = analyzeSilence(
    frameDb,
    frameDurationSec,
    durationSec,
    silenceThresholdDb
  );

  // Noise floor: lower 10th-percentile of non-zero frames (or active frames if all are above threshold),
  // avoiding digital-zero padding skewing room noise estimation.
  const nonZeroFrameDbs: number[] = [];
  for (let i = 0; i < frameDb.length; i++) {
    if (frameDb[i] > -100) {
      nonZeroFrameDbs.push(frameDb[i]);
    }
  }
  const noiseCandidateDbs =
    nonZeroFrameDbs.length > 0 ? nonZeroFrameDbs.sort((a, b) => a - b) : Array.from(frameDb).sort((a, b) => a - b);
  const noiseFloorDb = percentile(noiseCandidateDbs, 0.1);

  let activeSpeechDb = rmsDb;
  if (activeIndices.length > 0) {
    let activeEnergySum = 0;
    for (const idx of activeIndices) {
      activeEnergySum += frameRms[idx] * frameRms[idx];
    }
    activeSpeechDb = linearToDb(Math.sqrt(activeEnergySum / activeIndices.length));
  }
  const estimatedSnrDb = Math.max(0, activeSpeechDb - noiseFloorDb);

  // 4. Heuristic reverb & multi-speaker estimates
  const reverbEstimate = estimateReverbHeuristic(frameRms, frameDb);
  const multiSpeakerEstimate = estimateMultiSpeakerHeuristic(
    mono,
    audio.sampleRate,
    frameSize,
    activeIndices
  );

  // 5. Warnings, recommendations, and composite score (0-100)
  const warnings: string[] = [];
  const recommendations: string[] = [];
  let score = 100;

  if (clipping.hasSevereClipping) {
    warnings.push(
      `Severe audio clipping detected (${clipping.clippedSampleCount} samples, ${clipping.clippedPercentage.toFixed(2)}%).`
    );
    recommendations.push(
      'Re-record with lower microphone input gain so peaks stay below -3 dBFS.'
    );
    score -= Math.min(35, 15 + clipping.clippedPercentage * 4);
  } else if (clipping.clippedSampleCount > 0) {
    warnings.push(
      `Minor clipping detected (${clipping.clippedSampleCount} samples at >= 0.999).`
    );
    recommendations.push('Check input levels to avoid digital clipping on loud syllables.');
    score -= 8;
  }

  if (silence.activeSpeechDurationSec < 0.5) {
    warnings.push('Almost no active speech detected in this clip.');
    recommendations.push(
      `Record ${minRecommendedSec}-${maxRecommendedSec}s of clear speech with your microphone close.`
    );
    score -= 45;
  } else if (silence.activeSpeechDurationSec < minRecommendedSec) {
    warnings.push(
      `Active speech is short (${silence.activeSpeechDurationSec.toFixed(1)}s; ${minRecommendedSec}-${maxRecommendedSec}s recommended for this model).`
    );
    recommendations.push(
      `Provide at least ${minRecommendedSec}s (ideally ${minRecommendedSec}-${maxRecommendedSec}s) of continuous speech for stable voice timbre.`
    );
    score -= Math.min(25, (minRecommendedSec - silence.activeSpeechDurationSec) * 5);
  } else if (durationSec > maxRecommendedSec) {
    warnings.push(
      `Clip duration (${durationSec.toFixed(1)}s) exceeds the ${maxRecommendedSec}s model recommendation.`
    );
    recommendations.push(
      `Trim the reference clip to ${minRecommendedSec}-${maxRecommendedSec}s to improve conditioning consistency and speed.`
    );
    score -= 8;
  }

  if (silence.silenceRatio > 0.4 || silence.leadingSilenceSec > 0.5 || silence.trailingSilenceSec > 0.5) {
    warnings.push(
      `Excessive silence detected (${Math.round(silence.silenceRatio * 100)}% silent, ${silence.leadingSilenceSec.toFixed(1)}s lead / ${silence.trailingSilenceSec.toFixed(1)}s tail).`
    );
    recommendations.push('Enable Silence Trimming in preprocessing to remove dead air.');
    score -= Math.min(15, silence.silenceRatio * 20);
  }

  if (rmsDb < -30 || peakDb < -18) {
    warnings.push(
      `Input level is very quiet (RMS ${rmsDb.toFixed(1)} dBFS, peak ${peakDb.toFixed(1)} dBFS).`
    );
    recommendations.push(
      'Enable Loudness Normalization in preprocessing or move closer to the microphone.'
    );
    score -= 14;
  }

  if (activeIndices.length > 0 && estimatedSnrDb < 15) {
    warnings.push(
      `High background noise detected (estimated SNR ${estimatedSnrDb.toFixed(1)} dB, noise floor ${noiseFloorDb.toFixed(1)} dBFS).`
    );
    recommendations.push(
      'Record in a quieter room or enable Gentle Noise Reduction in preprocessing.'
    );
    score -= Math.min(25, (15 - estimatedSnrDb) * 1.8);
  } else if (noiseFloorDb > -35 && activeIndices.length > 0) {
    warnings.push(`Elevated room noise floor (${noiseFloorDb.toFixed(1)} dBFS).`);
    recommendations.push('Consider enabling Gentle Noise Reduction to suppress room hum.');
    score -= 8;
  }

  if (reverbEstimate.level === 'reverberant') {
    warnings.push('Noticeable room reverberation / echo detected (DSP heuristic).');
    recommendations.push('Record closer to the microphone in a soft-furnished, dry room.');
    score -= 12;
  } else if (reverbEstimate.level === 'moderate') {
    recommendations.push('Mild room ambience detected; closer mic placement can improve clarity.');
    score -= 4;
  }

  if (multiSpeakerEstimate.suspectedMultipleSpeakers) {
    warnings.push(
      'Multiple speakers or wide pitch jumps suspected (DSP heuristic).'
    );
    recommendations.push(
      'Ensure the reference clip contains only a single speaker without background voices.'
    );
    score -= 15;
  }

  if (audio.sampleRate < 16000) {
    warnings.push(`Low source sample rate (${audio.sampleRate} Hz).`);
    recommendations.push('Use a 16 kHz or higher (24-48 kHz) recording for better vocal detail.');
    score -= 12;
  }

  const overallScore = Math.max(0, Math.min(100, Math.round(score)));

  return {
    clipping,
    silence,
    noiseFloorDb,
    estimatedSnrDb,
    rmsDb,
    peakDb,
    reverbEstimate,
    multiSpeakerEstimate,
    durationSec,
    sampleRate: audio.sampleRate,
    channels,
    overallScore,
    warnings,
    recommendations,
  };
}
