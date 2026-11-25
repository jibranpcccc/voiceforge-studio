/**
 * Shared pure-TypeScript audio DSP primitives:
 * DC offset removal, RBJ biquad filters, ITU-R BS.1770 K-weighted LUFS measurement,
 * soft de-essing, and raised-cosine fades.
 */

export interface BiquadCoeffs {
  b0: number;
  b1: number;
  b2: number;
  a1: number;
  a2: number;
}

export function dbToLinear(db: number): number {
  return Math.pow(10, db / 20);
}

export function linearToDb(linear: number, floorDb: number = -120): number {
  if (!Number.isFinite(linear) || linear <= 0) {
    return floorDb;
  }
  return Math.max(floorDb, 20 * Math.log10(linear));
}

export function clampSample(x: number): number {
  if (!Number.isFinite(x)) return 0;
  if (x > 1) return 1;
  if (x < -1) return -1;
  return x;
}

/**
 * Subtract per-channel DC mean offset in place.
 */
export function removeDcOffsetInPlace(samples: Float32Array, channels: number = 1): void {
  if (samples.length === 0) return;
  if (channels <= 1) {
    let sum = 0;
    for (let i = 0; i < samples.length; i++) {
      sum += samples[i];
    }
    const mean = sum / samples.length;
    if (Math.abs(mean) > 1e-9) {
      for (let i = 0; i < samples.length; i++) {
        samples[i] -= mean;
      }
    }
    return;
  }

  const frames = Math.floor(samples.length / channels);
  if (frames === 0) return;
  for (let ch = 0; ch < channels; ch++) {
    let sum = 0;
    for (let i = 0; i < frames; i++) {
      sum += samples[i * channels + ch];
    }
    const mean = sum / frames;
    if (Math.abs(mean) > 1e-9) {
      for (let i = 0; i < frames; i++) {
        samples[i * channels + ch] -= mean;
      }
    }
  }
}

/**
 * Apply a Direct Form II Transposed biquad filter in place to a mono sample buffer.
 */
export function applyBiquadInPlace(samples: Float32Array, c: BiquadCoeffs): void {
  let z1 = 0;
  let z2 = 0;
  const { b0, b1, b2, a1, a2 } = c;
  for (let i = 0; i < samples.length; i++) {
    const x = samples[i];
    const y = b0 * x + z1;
    z1 = b1 * x - a1 * y + z2;
    z2 = b2 * x - a2 * y;
    samples[i] = y;
  }
}

/**
 * Apply a biquad filter to a copy of mono samples and return the filtered array.
 */
export function applyBiquadCopy(samples: Float32Array, c: BiquadCoeffs): Float32Array {
  const out = new Float32Array(samples);
  applyBiquadInPlace(out, c);
  return out;
}

function clampFreq(freqHz: number, sampleRate: number): number {
  const maxSafe = sampleRate * 0.45;
  return Math.max(10, Math.min(maxSafe, freqHz));
}

/**
 * Design a 2nd-order RBJ high-pass biquad filter.
 */
export function designHighPass(
  sampleRate: number,
  freqHz: number,
  q: number = Math.SQRT1_2
): BiquadCoeffs {
  const f = clampFreq(freqHz, sampleRate);
  const w0 = (2 * Math.PI * f) / sampleRate;
  const cosW0 = Math.cos(w0);
  const alpha = Math.sin(w0) / (2 * q);
  const a0 = 1 + alpha;

  return {
    b0: ((1 + cosW0) / 2) / a0,
    b1: -(1 + cosW0) / a0,
    b2: ((1 + cosW0) / 2) / a0,
    a1: (-2 * cosW0) / a0,
    a2: (1 - alpha) / a0,
  };
}

/**
 * Design an RBJ band-pass (constant 0 dB peak gain) biquad filter.
 */
export function designBandPass(
  sampleRate: number,
  freqHz: number,
  q: number = 2.0
): BiquadCoeffs {
  const f = clampFreq(freqHz, sampleRate);
  const w0 = (2 * Math.PI * f) / sampleRate;
  const cosW0 = Math.cos(w0);
  const alpha = Math.sin(w0) / (2 * q);
  const a0 = 1 + alpha;

  return {
    b0: alpha / a0,
    b1: 0,
    b2: -alpha / a0,
    a1: (-2 * cosW0) / a0,
    a2: (1 - alpha) / a0,
  };
}

/**
 * Design an RBJ peaking EQ biquad filter.
 */
export function designPeaking(
  sampleRate: number,
  freqHz: number,
  gainDb: number,
  q: number = 1.0
): BiquadCoeffs {
  const f = clampFreq(freqHz, sampleRate);
  const A = Math.pow(10, gainDb / 40);
  const w0 = (2 * Math.PI * f) / sampleRate;
  const cosW0 = Math.cos(w0);
  const alpha = Math.sin(w0) / (2 * q);
  const a0 = 1 + alpha / A;

  return {
    b0: (1 + alpha * A) / a0,
    b1: (-2 * cosW0) / a0,
    b2: (1 - alpha * A) / a0,
    a1: (-2 * cosW0) / a0,
    a2: (1 - alpha / A) / a0,
  };
}

/**
 * Design an RBJ low-shelf biquad filter.
 */
export function designLowShelf(
  sampleRate: number,
  freqHz: number,
  gainDb: number,
  slope: number = 1.0
): BiquadCoeffs {
  const f = clampFreq(freqHz, sampleRate);
  const A = Math.pow(10, gainDb / 40);
  const w0 = (2 * Math.PI * f) / sampleRate;
  const cosW0 = Math.cos(w0);
  const sinW0 = Math.sin(w0);
  const alpha = (sinW0 / 2) * Math.sqrt((A + 1 / A) * (1 / slope - 1) + 2);
  const twoSqrtAAlpha = 2 * Math.sqrt(A) * alpha;
  const a0 = A + 1 + (A - 1) * cosW0 + twoSqrtAAlpha;

  return {
    b0: (A * (A + 1 - (A - 1) * cosW0 + twoSqrtAAlpha)) / a0,
    b1: (2 * A * (A - 1 - (A + 1) * cosW0)) / a0,
    b2: (A * (A + 1 - (A - 1) * cosW0 - twoSqrtAAlpha)) / a0,
    a1: (-2 * (A - 1 + (A + 1) * cosW0)) / a0,
    a2: (A + 1 + (A - 1) * cosW0 - twoSqrtAAlpha) / a0,
  };
}

/**
 * Design an RBJ high-shelf biquad filter.
 */
export function designHighShelf(
  sampleRate: number,
  freqHz: number,
  gainDb: number,
  slope: number = 1.0
): BiquadCoeffs {
  const f = clampFreq(freqHz, sampleRate);
  const A = Math.pow(10, gainDb / 40);
  const w0 = (2 * Math.PI * f) / sampleRate;
  const cosW0 = Math.cos(w0);
  const sinW0 = Math.sin(w0);
  const alpha = (sinW0 / 2) * Math.sqrt((A + 1 / A) * (1 / slope - 1) + 2);
  const twoSqrtAAlpha = 2 * Math.sqrt(A) * alpha;
  const a0 = A + 1 - (A - 1) * cosW0 + twoSqrtAAlpha;

  return {
    b0: (A * (A + 1 + (A - 1) * cosW0 + twoSqrtAAlpha)) / a0,
    b1: (-2 * A * (A - 1 + (A + 1) * cosW0)) / a0,
    b2: (A * (A + 1 + (A - 1) * cosW0 - twoSqrtAAlpha)) / a0,
    a1: (2 * (A - 1 - (A + 1) * cosW0)) / a0,
    a2: (A + 1 - (A - 1) * cosW0 - twoSqrtAAlpha) / a0,
  };
}

/**
 * Measure integrated loudness in LUFS using an ITU-R BS.1770-4 style K-weighting
 * filter cascade (head-model high-shelf + RLB high-pass) and dual-stage gating
 * (-70 LKFS absolute gate + -10 LU relative gate over 400ms blocks).
 */
export function measureLufs(
  samples: Float32Array,
  sampleRate: number,
  channels: number = 1
): number {
  if (samples.length === 0 || sampleRate <= 0) {
    return -120;
  }

  const frames = Math.floor(samples.length / channels);
  if (frames === 0) return -120;

  // Stage 1: ITU-R BS.1770 acoustic pre-filter (+4 dB high-shelf around 1682 Hz)
  const shelf = designHighShelf(sampleRate, 1681.974, 3.9998, 1.0);
  // Stage 2: RLB high-pass weighting (~38.14 Hz)
  const rlb = designHighPass(sampleRate, 38.135, 0.5003);

  const channelMeanSquares: Float64Array[] = [];
  const blockFrames = Math.round(0.4 * sampleRate);
  const hopFrames = Math.max(1, Math.round(0.1 * sampleRate));
  const useGating = frames >= blockFrames && blockFrames > 0;

  if (!useGating) {
    let totalPower = 0;
    for (let ch = 0; ch < channels; ch++) {
      const chData = new Float32Array(frames);
      for (let i = 0; i < frames; i++) {
        chData[i] = samples[i * channels + ch];
      }
      applyBiquadInPlace(chData, shelf);
      applyBiquadInPlace(chData, rlb);
      let sumSq = 0;
      for (let i = 0; i < frames; i++) {
        sumSq += chData[i] * chData[i];
      }
      totalPower += sumSq / frames;
    }
    // Mono audio has equal loudness whether played over 1 or 2 channels; average across channels for stereo.
    const normalizedPower = channels > 1 ? totalPower / channels : totalPower;
    return normalizedPower > 1e-12 ? -0.691 + 10 * Math.log10(normalizedPower) : -120;
  }

  const numBlocks = Math.floor((frames - blockFrames) / hopFrames) + 1;
  for (let ch = 0; ch < channels; ch++) {
    const chData = new Float32Array(frames);
    for (let i = 0; i < frames; i++) {
      chData[i] = samples[i * channels + ch];
    }
    applyBiquadInPlace(chData, shelf);
    applyBiquadInPlace(chData, rlb);

    // Prefix sum of squares for O(1) block energy queries
    const prefixSq = new Float64Array(frames + 1);
    for (let i = 0; i < frames; i++) {
      prefixSq[i + 1] = prefixSq[i] + chData[i] * chData[i];
    }

    const blockPowers = new Float64Array(numBlocks);
    for (let b = 0; b < numBlocks; b++) {
      const start = b * hopFrames;
      const end = start + blockFrames;
      blockPowers[b] = (prefixSq[end] - prefixSq[start]) / blockFrames;
    }
    channelMeanSquares.push(blockPowers);
  }

  const blockLoudness = new Float64Array(numBlocks);
  const blockTotalPower = new Float64Array(numBlocks);
  const absThreshold = Math.pow(10, (-70 + 0.691) / 10);

  let absSum = 0;
  let absCount = 0;
  for (let b = 0; b < numBlocks; b++) {
    let p = 0;
    for (let ch = 0; ch < channels; ch++) {
      p += channelMeanSquares[ch][b];
    }
    const avgP = channels > 1 ? p / channels : p;
    blockTotalPower[b] = avgP;
    blockLoudness[b] = avgP > 1e-12 ? -0.691 + 10 * Math.log10(avgP) : -120;
    if (avgP > absThreshold) {
      absSum += avgP;
      absCount++;
    }
  }

  if (absCount === 0) {
    return -120;
  }

  const absGatedLufs = -0.691 + 10 * Math.log10(absSum / absCount);
  const relThresholdLufs = absGatedLufs - 10;

  let relSum = 0;
  let relCount = 0;
  for (let b = 0; b < numBlocks; b++) {
    if (blockLoudness[b] > relThresholdLufs && blockTotalPower[b] > absThreshold) {
      relSum += blockTotalPower[b];
      relCount++;
    }
  }

  if (relCount === 0) {
    return absGatedLufs;
  }
  return -0.691 + 10 * Math.log10(relSum / relCount);
}

/**
 * Apply a gentle sidechain-detected sibilance reducer (5-9 kHz) to mono PCM in place.
 */
export function applySoftDeEsserInPlace(
  samples: Float32Array,
  sampleRate: number,
  amount: number
): void {
  const clampedAmount = Math.max(0, Math.min(1, amount));
  if (clampedAmount <= 0 || samples.length === 0 || sampleRate < 12000) {
    return;
  }

  const sibilantFreq = Math.min(6800, sampleRate * 0.4);
  const band = applyBiquadCopy(samples, designBandPass(sampleRate, sibilantFreq, 1.8));
  const threshold = dbToLinear(-26 + (1 - clampedAmount) * 10); // -26 dBFS at full amount, -16 dBFS at 0
  const attackCoeff = Math.exp(-1 / Math.max(1, 0.002 * sampleRate));
  const releaseCoeff = Math.exp(-1 / Math.max(1, 0.035 * sampleRate));
  const maxCut = 1 - 0.55 * clampedAmount;

  let env = 0;
  for (let i = 0; i < samples.length; i++) {
    const absBand = Math.abs(band[i]);
    const coeff = absBand > env ? attackCoeff : releaseCoeff;
    env = coeff * env + (1 - coeff) * absBand;

    if (env > threshold) {
      const over = env / threshold;
      const gain = Math.max(maxCut, 1 / (1 + clampedAmount * 0.9 * (over - 1)));
      // Attenuate primarily the sibilant band component while preserving fundamental warmth.
      samples[i] -= band[i] * (1 - gain);
    }
  }
}

/**
 * Apply smooth raised-cosine fade-in and fade-out in place.
 */
export function applyFadeInOutInPlace(
  samples: Float32Array,
  sampleRate: number,
  fadeInMs: number,
  fadeOutMs: number,
  channels: number = 1
): void {
  const totalFrames = Math.floor(samples.length / channels);
  if (totalFrames <= 1) return;

  const fadeInFrames = Math.min(
    totalFrames,
    Math.max(0, Math.round((fadeInMs / 1000) * sampleRate))
  );
  const fadeOutFrames = Math.min(
    totalFrames,
    Math.max(0, Math.round((fadeOutMs / 1000) * sampleRate))
  );

  if (fadeInFrames > 1) {
    for (let f = 0; f < fadeInFrames; f++) {
      const gain = 0.5 * (1 - Math.cos((Math.PI * f) / (fadeInFrames - 1)));
      const base = f * channels;
      for (let ch = 0; ch < channels; ch++) {
        samples[base + ch] *= gain;
      }
    }
  }

  if (fadeOutFrames > 1) {
    const startFrame = totalFrames - fadeOutFrames;
    for (let f = 0; f < fadeOutFrames; f++) {
      const gain = 0.5 * (1 + Math.cos((Math.PI * f) / (fadeOutFrames - 1)));
      const base = (startFrame + f) * channels;
      for (let ch = 0; ch < channels; ch++) {
        samples[base + ch] *= gain;
      }
    }
  }
}
