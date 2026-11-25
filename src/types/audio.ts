/**
 * Audio preprocessing, DSP mastering, and export contracts.
 */

export interface PreprocessingOptions {
  /** Trim leading and trailing silence below threshold. */
  trimSilence: boolean;
  /** Silence detection threshold in dBFS (e.g. -45). */
  silenceThresholdDb: number;
  /** Minimum contiguous silence duration in ms before trimming. */
  minSilenceDurationMs: number;
  /** Apply loudness normalization prior to encoding. */
  normalizeLoudness: boolean;
  /** Target integrated loudness in LUFS (e.g. -18). */
  targetLufs: number;
  /** High-pass filter cutoff frequency in Hz (0 to disable, e.g. 80Hz to remove rumble). */
  highPassFilterHz: number;
  /** Enable gentle noise gate to suppress room floor between phrases. */
  noiseGateEnabled: boolean;
  /** Noise gate threshold in dBFS (e.g. -50). */
  noiseGateThresholdDb: number;
  /** Apply mild de-essing during preprocessing. */
  deEssingEnabled: boolean;
  /** Target sample rate in Hz for the conditioned audio (e.g. 24000). */
  targetSampleRate: number;
  /** Maximum clip duration in seconds (longer clips are trimmed or windowed). */
  maxDurationSec: number;
}

export type MasteringPreset = 'natural' | 'youtube' | 'podcast' | 'raw' | 'custom';

export interface MasteringSettings {
  /** Active mastering preset identifier. */
  preset: MasteringPreset;
  /** Low-shelf EQ gain in dB (-12 to +12). */
  eqLowGainDb: number;
  /** Presence/mid-range EQ gain in dB (-12 to +12). */
  eqMidGainDb: number;
  /** Air/high-shelf EQ gain in dB (-12 to +12). */
  eqHighGainDb: number;
  /** Harmonic warmth / subtle saturation amount (0-1). */
  warmth: number;
  /** Speech clarity / presence boost (0-1). */
  clarity: number;
  /** De-esser intensity (0-1). */
  deEsserAmount: number;
  /** Enable dynamic range compression. */
  compressorEnabled: boolean;
  /** Compressor threshold in dBFS (e.g. -18). */
  compressorThresholdDb: number;
  /** Compressor ratio (e.g. 2.5). */
  compressorRatio: number;
  /** Target integrated loudness in LUFS (e.g. -16 for podcast, -14 for YouTube). */
  targetLufs: number;
  /** True-peak brickwall limiter ceiling in dBTP (e.g. -1.0). */
  truePeakLimitDb: number;
  /** Fade-in duration in milliseconds. */
  fadeInMs: number;
  /** Fade-out duration in milliseconds. */
  fadeOutMs: number;
}

export type ExportFormat =
  | 'wav16'
  | 'wav24'
  | 'mp3_128'
  | 'mp3_192'
  | 'mp3_256'
  | 'mp3_320';

export type ExportSampleRate = 'native' | 44100 | 48000;

export interface ExportId3Metadata {
  title?: string;
  artist?: string;
  album?: string;
  comment?: string;
  year?: string;
}

export interface ExportOptions {
  /** Output container/codec and bitrate/bit-depth. */
  format: ExportFormat;
  /** Output sample rate ('native' keeps engine output rate). */
  sampleRate: ExportSampleRate;
  /** Mono or dual-mono/stereo channel layout. */
  channels: 'mono' | 'stereo';
  /** Whether to apply mastering chain before encoding. */
  applyMastering: boolean;
  /** Whether to normalize output to mastering targetLufs / truePeakLimitDb. */
  normalizeOutput: boolean;
  /** Base output filename without extension. */
  filename: string;
  /** Optional metadata tags for MP3 export. */
  metadata?: ExportId3Metadata;
}
