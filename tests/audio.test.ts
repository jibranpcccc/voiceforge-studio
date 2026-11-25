import { unzipSync } from 'fflate';
import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  AudioDecodeError,
  MASTERING_PRESETS,
  PROVENANCE_COMMENT_TAG,
  PROVENANCE_SOFTWARE_TAG,
  SRT_BOUNDARY_NOTE,
  analyzeReferenceAudio,
  applyTruePeakLimiterInPlace,
  decodeAudioFile,
  decodeWavBuffer,
  downmixToMono,
  encodeMp3,
  encodeWav16,
  encodeWav24,
  exportAudio,
  exportSegmentsZip,
  extractAudioFromVideoFile,
  formatSrtTimestamp,
  generateSrtFromSegments,
  masterAudio,
  masterNarrationChunks,
  measureLufs,
  measureTruePeakDb,
  pcmToAudioBufferData,
  prepareAudioForExport,
  preprocessReferenceAudio,
  resamplePcm,
  validateAudioFile,
  wsolaTimeStretch,
} from '../src/audio';
import type { AudioBufferData } from '../src/types';

function makeSine(
  freqHz: number,
  durationSec: number,
  sampleRate: number = 24000,
  amplitude: number = 0.25
): Float32Array {
  const len = Math.round(durationSec * sampleRate);
  const out = new Float32Array(len);
  for (let i = 0; i < len; i++) {
    out[i] = amplitude * Math.sin((2 * Math.PI * freqHz * i) / sampleRate);
  }
  return out;
}

function makeHarmonicVoice(
  f0Hz: number,
  durationSec: number,
  sampleRate: number = 24000,
  amplitude: number = 0.25
): Float32Array {
  const len = Math.round(durationSec * sampleRate);
  const out = new Float32Array(len);
  for (let i = 0; i < len; i++) {
    const t = i / sampleRate;
    // Fundamental + 2nd & 3rd harmonics with gentle syllable amplitude modulation (3.5 Hz)
    const env = 0.6 + 0.4 * Math.sin(2 * Math.PI * 3.5 * t);
    out[i] =
      amplitude *
      env *
      (0.6 * Math.sin(2 * Math.PI * f0Hz * t) +
        0.28 * Math.sin(2 * Math.PI * f0Hz * 2 * t) +
        0.12 * Math.sin(2 * Math.PI * f0Hz * 3 * t));
  }
  return out;
}

function estimateDominantFreqZeroCrossings(samples: Float32Array, sampleRate: number): number {
  let crossings = 0;
  for (let i = 1; i < samples.length; i++) {
    if (samples[i - 1] < 0 && samples[i] >= 0) {
      crossings++;
    }
  }
  const durationSec = samples.length / sampleRate;
  return durationSec > 0 ? crossings / durationSec : 0;
}

function makeDeterministicNoise(length: number, amplitude: number, seed = 1337): Float32Array {
  const out = new Float32Array(length);
  let state = seed >>> 0;
  for (let i = 0; i < length; i++) {
    state = (1664525 * state + 1013904223) >>> 0;
    const u = state / 0xffffffff;
    out[i] = (u * 2 - 1) * amplitude;
  }
  return out;
}

function findAscii(bytes: Uint8Array, needle: string): number {
  const target = Array.from(needle).map((c) => c.charCodeAt(0));
  outer: for (let i = 0; i <= bytes.length - target.length; i++) {
    for (let j = 0; j < target.length; j++) {
      if (bytes[i + j] !== target[j]) continue outer;
    }
    return i;
  }
  return -1;
}

function findMpegSyncOffset(bytes: Uint8Array, startAt: number = 0): number {
  for (let i = startAt; i < bytes.length - 1; i++) {
    if (bytes[i] === 0xff && (bytes[i + 1] & 0xe0) === 0xe0) {
      return i;
    }
  }
  return -1;
}

describe('audio decoder & resampling', () => {
  const originalAudioContext = (globalThis as Record<string, unknown>).AudioContext;

  afterEach(() => {
    (globalThis as Record<string, unknown>).AudioContext = originalAudioContext;
    vi.restoreAllMocks();
  });

  it('downmixes interleaved stereo to mono accurately', () => {
    const stereo = new Float32Array([0.5, -0.5, 0.4, 0.8, -0.2, 0.2]);
    const mono = downmixToMono(stereo, 2);
    expect(mono.length).toBe(3);
    expect(mono[0]).toBeCloseTo(0, 5);
    expect(mono[1]).toBeCloseTo(0.6, 5);
    expect(mono[2]).toBeCloseTo(0, 5);
  });

  it('resamples PCM with Lanczos-3 preserving duration and frequency content', () => {
    const sr1 = 16000;
    const sr2 = 24000;
    const sine = makeSine(440, 0.5, sr1, 0.4);
    const up = resamplePcm(sine, sr1, sr2, 1);
    expect(up.length).toBe(12000);
    expect(estimateDominantFreqZeroCrossings(up, sr2)).toBeCloseTo(440, -1);

    const down = resamplePcm(up, sr2, sr1, 1);
    expect(down.length).toBe(8000);
    expect(estimateDominantFreqZeroCrossings(down, sr1)).toBeCloseTo(440, -1);
  });

  it('validates file type, empty files, and oversized files with clean errors', () => {
    expect(() =>
      validateAudioFile({ name: 'empty.wav', type: 'audio/wav', size: 0 })
    ).toThrowError(AudioDecodeError);

    expect(() =>
      validateAudioFile({ name: 'huge.wav', type: 'audio/wav', size: 300 * 1024 * 1024 })
    ).toThrowError(/exceeds/i);

    expect(() =>
      validateAudioFile({ name: 'notes.txt', type: 'text/plain', size: 1024 })
    ).toThrowError(/Unsupported audio format/i);

    expect(() =>
      validateAudioFile({ name: 'voice.flac', type: 'audio/flac', size: 2048 })
    ).not.toThrow();
  });

  it('round-trips WAV 16-bit and 24-bit through decodeWavBuffer and decodeAudioFile', async () => {
    const origSamples = makeSine(220, 0.25, 24000, 0.5);
    const orig = pcmToAudioBufferData(origSamples, 24000, 1);

    const wav16 = encodeWav16(orig);
    const decoded16 = decodeWavBuffer(wav16.buffer as ArrayBuffer);
    expect(decoded16.sampleRate).toBe(24000);
    expect(decoded16.channels).toBe(1);
    expect(decoded16.samples.length).toBe(origSamples.length);
    for (let i = 0; i < 100; i++) {
      expect(decoded16.samples[i]).toBeCloseTo(origSamples[i], 3);
    }

    const wav24 = encodeWav24(orig);
    const decoded24 = decodeWavBuffer(wav24.buffer as ArrayBuffer);
    expect(decoded24.sampleRate).toBe(24000);
    expect(decoded24.samples.length).toBe(origSamples.length);
    for (let i = 0; i < 100; i++) {
      expect(decoded24.samples[i]).toBeCloseTo(origSamples[i], 5);
    }

    // decodeAudioFile with AudioContext unavailable falls back cleanly for WAV
    (globalThis as Record<string, unknown>).AudioContext = undefined;
    const wavBytes = new Uint8Array(wav16);
    const file = new File([wavBytes], 'sample.wav', { type: 'audio/wav' });
    const decodedFile = await decodeAudioFile(file, { targetSampleRate: 16000 });
    expect(decodedFile.sampleRate).toBe(16000);
    expect(decodedFile.durationSec).toBeCloseTo(0.25, 2);
  });

  it('uses AudioContext.decodeAudioData for MP3/M4A/FLAC/OGG and surfaces clean corrupt-file errors', async () => {
    const decodedMockSamples = makeSine(300, 0.2, 44100, 0.3);
    const closeSpy = vi.fn().mockResolvedValue(undefined);
    const decodeSpy = vi.fn().mockResolvedValue({
      numberOfChannels: 1,
      length: decodedMockSamples.length,
      sampleRate: 44100,
      getChannelData: () => decodedMockSamples,
    });

    (globalThis as Record<string, unknown>).AudioContext = vi.fn(function MockAudioContext() {
      return { decodeAudioData: decodeSpy, close: closeSpy };
    });

    const mp3File = new File([new Uint8Array([0xff, 0xfb, 0x90, 0x00])], 'voice.mp3', {
      type: 'audio/mpeg',
    });
    const res = await decodeAudioFile(mp3File, { mono: true });
    expect(decodeSpy).toHaveBeenCalledTimes(1);
    expect(closeSpy).toHaveBeenCalledTimes(1);
    expect(res.sampleRate).toBe(44100);
    expect(res.channels).toBe(1);

    // Corrupt file rejection
    decodeSpy.mockRejectedValueOnce(new Error('DOMException: Unable to decode audio data'));
    const corruptOgg = new File([new Uint8Array([1, 2, 3, 4])], 'broken.ogg', {
      type: 'audio/ogg',
    });
    await expect(decodeAudioFile(corruptOgg)).rejects.toThrowError(/corrupted|unsupported codec/i);
  });

  it('extracts audio locally from video files via decodeAudioData container path', async () => {
    const audioSamples = makeSine(260, 0.3, 48000, 0.4);
    (globalThis as Record<string, unknown>).AudioContext = vi.fn(function MockAudioContext() {
      return {
        decodeAudioData: vi.fn().mockResolvedValue({
          numberOfChannels: 2,
          length: audioSamples.length,
          sampleRate: 48000,
          getChannelData: () => audioSamples,
        }),
        close: vi.fn().mockResolvedValue(undefined),
      };
    });

    const mp4File = new File([new Uint8Array(64)], 'interview.mp4', { type: 'video/mp4' });
    const extracted = await extractAudioFromVideoFile(mp4File, { mono: true });
    expect(extracted.channels).toBe(1);
    expect(extracted.sampleRate).toBe(48000);
    expect(extracted.durationSec).toBeCloseTo(0.3, 2);
  });
});

describe('quality analyzer', () => {
  it('detects clipping, leading/trailing silence, low volume, SNR, and model duration guidance', () => {
    const sr = 24000;
    // 1.0s leading silence + 1.5s clipped active speech + 0.8s trailing silence
    const lead = new Float32Array(sr * 1.0);
    const speech = makeSine(200, 1.5, sr, 1.25); // deliberately clipped above 1.0
    for (let i = 0; i < speech.length; i++) {
      speech[i] = Math.max(-1, Math.min(1, speech[i]));
    }
    const trail = new Float32Array(sr * 0.8);
    const combined = new Float32Array(lead.length + speech.length + trail.length);
    combined.set(lead, 0);
    combined.set(speech, lead.length);
    combined.set(trail, lead.length + speech.length);

    const report = analyzeReferenceAudio(pcmToAudioBufferData(combined, sr, 1), {
      minRecommendedSec: 5,
      maxRecommendedSec: 15,
    });

    expect(report.clipping.clippedSampleCount).toBeGreaterThan(50);
    expect(report.clipping.hasSevereClipping).toBe(true);
    expect(report.silence.leadingSilenceSec).toBeCloseTo(1.0, 1);
    expect(report.silence.trailingSilenceSec).toBeCloseTo(0.8, 1);
    expect(report.silence.activeSpeechDurationSec).toBeCloseTo(1.5, 1);
    expect(report.silence.silenceRatio).toBeGreaterThan(0.5);
    expect(report.warnings.some((w) => /clipping/i.test(w))).toBe(true);
    expect(report.warnings.some((w) => /short/i.test(w))).toBe(true);
    expect(report.recommendations.some((r) => /5-15s/i.test(r))).toBe(true);
    expect(report.overallScore).toBeLessThan(65);
  });

  it('detects low volume and noisy background (low SNR)', () => {
    const sr = 24000;
    // Quiet speech (-38 dBFS) + noticeable background noise (-42 dBFS)
    const noise = makeDeterministicNoise(sr * 6, 0.008);
    const speech = makeHarmonicVoice(140, 4, sr, 0.015);
    const buf = new Float32Array(noise);
    for (let i = 0; i < speech.length; i++) {
      buf[sr + i] += speech[i];
    }

    const report = analyzeReferenceAudio(pcmToAudioBufferData(buf, sr, 1));
    expect(report.rmsDb).toBeLessThan(-30);
    expect(report.estimatedSnrDb).toBeLessThan(15);
    expect(report.warnings.some((w) => /quiet/i.test(w))).toBe(true);
    expect(report.warnings.some((w) => /noise/i.test(w))).toBe(true);
  });

  it('distinguishes dry vs reverberant and single-speaker vs multi-speaker heuristics', () => {
    const sr = 24000;
    // Dry crisp bursts (40ms bursts separated by 120ms dry silence)
    const dryBuf = new Float32Array(sr * 4);
    for (let b = 0; b < 20; b++) {
      const start = Math.round(b * 0.2 * sr);
      const pulse = makeHarmonicVoice(130, 0.04, sr, 0.4);
      dryBuf.set(pulse, start);
    }
    const dryReport = analyzeReferenceAudio(pcmToAudioBufferData(dryBuf, sr, 1));
    expect(dryReport.reverbEstimate.level).toBe('dry');
    expect(dryReport.multiSpeakerEstimate.suspectedMultipleSpeakers).toBe(false);

    // Simulated room reverb tail added to pulses
    const reverbBuf = new Float32Array(dryBuf);
    const delay1 = Math.round(0.035 * sr);
    const delay2 = Math.round(0.075 * sr);
    const delay3 = Math.round(0.115 * sr);
    for (let i = delay3; i < reverbBuf.length; i++) {
      reverbBuf[i] +=
        0.55 * reverbBuf[i - delay1] +
        0.35 * reverbBuf[i - delay2] +
        0.22 * reverbBuf[i - delay3];
    }
    const reverbReport = analyzeReferenceAudio(pcmToAudioBufferData(reverbBuf, sr, 1));
    expect(reverbReport.reverbEstimate.score).toBeGreaterThan(dryReport.reverbEstimate.score);

    // Multi-speaker alternating F0 (105 Hz male vs 230 Hz female)
    const speakerA = makeHarmonicVoice(105, 3, sr, 0.35);
    const speakerB = makeHarmonicVoice(230, 3, sr, 0.35);
    const twoSpeakers = new Float32Array(speakerA.length + speakerB.length);
    twoSpeakers.set(speakerA, 0);
    twoSpeakers.set(speakerB, speakerA.length);
    const multiReport = analyzeReferenceAudio(pcmToAudioBufferData(twoSpeakers, sr, 1));
    expect(multiReport.multiSpeakerEstimate.suspectedMultipleSpeakers).toBe(true);
    expect(multiReport.multiSpeakerEstimate.score).toBeGreaterThan(0.58);
  });
});

describe('non-destructive preprocessor', () => {
  it('never mutates original samples, removes DC offset, trims silence with 80ms padding, and resamples', () => {
    const sr = 44100;
    const lead = new Float32Array(Math.round(sr * 0.6));
    const body = makeHarmonicVoice(150, 2.0, sr, 0.15);
    const trail = new Float32Array(Math.round(sr * 0.6));
    const raw = new Float32Array((lead.length + body.length + trail.length) * 2);
    // Stereo with +0.12 DC offset
    for (let i = 0; i < lead.length + body.length + trail.length; i++) {
      let s = 0;
      if (i >= lead.length && i < lead.length + body.length) {
        s = body[i - lead.length];
      }
      raw[i * 2] = s + 0.12;
      raw[i * 2 + 1] = s + 0.12;
    }

    const original: AudioBufferData = {
      samples: raw,
      sampleRate: sr,
      channels: 2,
      durationSec: raw.length / 2 / sr,
    };
    const originalSnapshot = new Float32Array(original.samples);

    const processed = preprocessReferenceAudio(original, {
      trimSilence: true,
      silenceThresholdDb: -40,
      minSilenceDurationMs: 100,
      trimPaddingMs: 80,
      normalizeLoudness: true,
      targetLufs: -18,
      gentleNoiseReduction: true,
      targetSampleRate: 24000,
    });

    // Original remains byte-identical
    expect(original.samples).toEqual(originalSnapshot);
    expect(processed.channels).toBe(1);
    expect(processed.sampleRate).toBe(24000);
    // 2.0s body + ~160ms padding (~2.16s), significantly shorter than 3.2s input
    expect(processed.durationSec).toBeGreaterThan(2.0);
    expect(processed.durationSec).toBeLessThan(2.35);

    // DC offset removed
    const mean =
      processed.samples.reduce((sum, v) => sum + v, 0) / processed.samples.length;
    expect(Math.abs(mean)).toBeLessThan(0.01);
  });
});

describe('mastering pipeline & WSOLA', () => {
  it('bypasses all DSP on raw preset', () => {
    const audio = pcmToAudioBufferData(makeHarmonicVoice(140, 1.0, 24000, 0.2), 24000, 1);
    const out = masterAudio(audio, MASTERING_PRESETS.raw);
    expect(out.samples).not.toBe(audio.samples);
    expect(out.samples).toEqual(audio.samples);
  });

  it('normalizes loudness toward preset targetLufs and enforces 4x true-peak ceiling', () => {
    const sr = 24000;
    // Deliberately quiet + spiky transient audio
    const quiet = makeHarmonicVoice(140, 2.5, sr, 0.06);
    quiet[12000] = 0.99;
    quiet[12001] = -0.99;
    const input = pcmToAudioBufferData(quiet, sr, 1);

    const mastered = masterAudio(input, MASTERING_PRESETS.podcast);
    const lufs = measureLufs(mastered.samples, mastered.sampleRate, mastered.channels);
    const truePeakDb = measureTruePeakDb(mastered.samples);

    expect(lufs).toBeGreaterThan(-18.5);
    expect(lufs).toBeLessThan(-13.5);
    expect(truePeakDb).toBeLessThanOrEqual(MASTERING_PRESETS.podcast.truePeakLimitDb + 0.05);

    // Direct limiter stress test with inter-sample overshoot potential
    const hot = makeSine(4000, 0.1, 44100, 1.3);
    applyTruePeakLimiterInPlace(hot, 44100, -1.0);
    expect(measureTruePeakDb(hot)).toBeLessThanOrEqual(-0.95);
  });

  it('stretches duration via WSOLA without shifting pitch', () => {
    const sr = 24000;
    const f0 = 180;
    const input = makeSine(f0, 2.0, sr, 0.35);

    const faster = wsolaTimeStretch(input, sr, 1.25);
    expect(faster.length / sr).toBeCloseTo(2.0 / 1.25, 1);
    expect(estimateDominantFreqZeroCrossings(faster, sr)).toBeCloseTo(f0, -1);

    const slower = wsolaTimeStretch(input, sr, 0.8);
    expect(slower.length / sr).toBeCloseTo(2.0 / 0.8, 1);
    expect(estimateDominantFreqZeroCrossings(slower, sr)).toBeCloseTo(f0, -1);
  });

  it('joins narration chunks with silence pause without overlapping speech or short crossfade when pause=0', () => {
    const sr = 24000;
    const c1 = pcmToAudioBufferData(makeHarmonicVoice(140, 0.5, sr, 0.3), sr, 1);
    const c2 = pcmToAudioBufferData(makeHarmonicVoice(160, 0.5, sr, 0.3), sr, 1);

    // With 300ms pause
    const withPause = masterNarrationChunks([c1, c2], MASTERING_PRESETS.raw, {
      pauseDurationMs: 300,
    });
    expect(withPause.durationSec).toBeCloseTo(1.3, 2);
    // Middle of the pause gap (at ~0.65s) must be silent
    const midPauseSample = withPause.samples[Math.round(0.65 * sr)];
    expect(Math.abs(midPauseSample)).toBeLessThan(1e-5);

    // Direct join with pause=0 uses short cosine crossfade (8ms)
    const directJoin = masterNarrationChunks([c1, c2], MASTERING_PRESETS.raw, {
      pauseDurationMs: 0,
      crossfadeMs: 8,
    });
    expect(directJoin.durationSec).toBeCloseTo(1.0 - 0.008, 3);
  });
});

describe('audio exporter (WAV, MP3, ZIP, SRT)', () => {
  it('encodes WAV 16-bit and 24-bit with valid RIFF/WAVE headers and LIST/INFO provenance metadata', () => {
    const audio = pcmToAudioBufferData(makeHarmonicVoice(160, 0.4, 24000, 0.4), 24000, 1);

    const wav16 = encodeWav16(audio, { title: 'Chapter 1', artist: 'Alex' });
    const view16 = new DataView(wav16.buffer);
    expect(String.fromCharCode(...wav16.slice(0, 4))).toBe('RIFF');
    expect(String.fromCharCode(...wav16.slice(8, 12))).toBe('WAVE');
    expect(view16.getUint16(34, true)).toBe(16);
    expect(findAscii(wav16, 'LIST')).toBeGreaterThan(44);
    expect(findAscii(wav16, 'INFO')).toBeGreaterThan(44);
    expect(findAscii(wav16, PROVENANCE_SOFTWARE_TAG)).toBeGreaterThan(44);
    expect(findAscii(wav16, PROVENANCE_COMMENT_TAG)).toBeGreaterThan(44);
    expect(findAscii(wav16, 'Chapter 1')).toBeGreaterThan(44);

    const wav24 = encodeWav24(audio);
    const view24 = new DataView(wav24.buffer);
    expect(view24.getUint16(34, true)).toBe(24);
    expect(findAscii(wav24, PROVENANCE_COMMENT_TAG)).toBeGreaterThan(44);
  });

  it('encodes MP3 at 128, 192, 256, and 320 kbps with ID3v2 header and valid MPEG frames', () => {
    const audio = pcmToAudioBufferData(makeHarmonicVoice(150, 0.6, 24000, 0.4), 24000, 1);
    const sizes: number[] = [];

    for (const bitrate of [128, 192, 256, 320] as const) {
      const mp3 = encodeMp3(audio, bitrate, { title: 'Test Narration' });
      expect(String.fromCharCode(...mp3.slice(0, 3))).toBe('ID3');
      expect(findAscii(mp3, PROVENANCE_SOFTWARE_TAG)).toBeGreaterThan(0);
      expect(findAscii(mp3, PROVENANCE_COMMENT_TAG)).toBeGreaterThan(0);

      // Parse ID3v2 synchsafe size and verify MPEG frame sync follows immediately
      const id3BodySize =
        ((mp3[6] & 0x7f) << 21) |
        ((mp3[7] & 0x7f) << 14) |
        ((mp3[8] & 0x7f) << 7) |
        (mp3[9] & 0x7f);
      const audioStart = 10 + id3BodySize;
      const syncOffset = findMpegSyncOffset(mp3, audioStart);
      expect(syncOffset).toBe(audioStart);
      sizes.push(mp3.length);
    }

    // 320 kbps output should be larger than 192 kbps output
    expect(sizes[3]).toBeGreaterThan(sizes[1]);
  });

  it('provides transparent upsampling notes and exports full pipeline', () => {
    const audio = pcmToAudioBufferData(makeSine(200, 0.3, 24000, 0.3), 24000, 1);
    const prep = prepareAudioForExport(audio, { sampleRate: 48000, channels: 'stereo' });
    expect(prep.audio.sampleRate).toBe(48000);
    expect(prep.audio.channels).toBe(2);
    expect(prep.note).toMatch(/adds no new original acoustic detail/i);

    const res = exportAudio(audio, {
      format: 'mp3_192',
      sampleRate: 'native',
      channels: 'mono',
      applyMastering: true,
      normalizeOutput: true,
      filename: 'demo-track',
    });
    expect(res.filename).toBe('demo-track.mp3');
    expect(res.mimeType).toBe('audio/mpeg');
    expect(res.bytes.length).toBeGreaterThan(1000);
  });

  it('generates SRT subtitles with measured segment boundaries and explicit non-word-level note', () => {
    expect(formatSrtTimestamp(3661.25)).toBe('01:01:01,250');

    const srtRes = generateSrtFromSegments([
      { text: 'First sentence.', durationSec: 1.5, pauseAfterMs: 300 },
      { text: 'Second sentence.', durationSec: 2.25 },
    ]);

    expect(srtRes.cues).toHaveLength(2);
    expect(srtRes.srt).toContain('1\n00:00:00,000 --> 00:00:01,500\nFirst sentence.');
    expect(srtRes.srt).toContain('2\n00:00:01,800 --> 00:00:04,050\nSecond sentence.');
    expect(srtRes.metadataNote).toBe(SRT_BOUNDARY_NOTE);
    expect(srtRes.metadataNote).toMatch(/segment-level measured/i);
    expect(srtRes.metadataNote).toMatch(/not word-level/i);
  });

  it('bundles multi-segment WAV/MP3 + SRT + manifest into a valid ZIP archive via fflate', () => {
    const seg1 = pcmToAudioBufferData(makeHarmonicVoice(140, 0.5, 24000, 0.3), 24000, 1);
    const seg2 = pcmToAudioBufferData(makeHarmonicVoice(160, 0.6, 24000, 0.3), 24000, 1);

    const zipBytes = exportSegmentsZip(
      [
        { filename: 'intro', audio: seg1, text: 'Welcome to VoiceForge.', pauseAfterMs: 250 },
        { filename: 'body', audio: seg2, text: 'Everything runs locally.' },
      ],
      {
        format: 'wav16',
        sampleRate: 'native',
        channels: 'mono',
        applyMastering: false,
        normalizeOutput: false,
      },
      { includeSrt: true, includeManifest: true }
    );

    const unpacked = unzipSync(zipBytes);
    expect(Object.keys(unpacked)).toContain('001_intro.wav');
    expect(Object.keys(unpacked)).toContain('002_body.wav');
    expect(Object.keys(unpacked)).toContain('subtitles.srt');
    expect(Object.keys(unpacked)).toContain('subtitles_note.txt');
    expect(Object.keys(unpacked)).toContain('manifest.json');

    const srtText = new TextDecoder().decode(unpacked['subtitles.srt']);
    expect(srtText).toContain('Welcome to VoiceForge.');
    expect(srtText).toContain('00:00:00,750 --> 00:00:01,350');
  });
});
