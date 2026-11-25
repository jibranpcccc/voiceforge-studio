import { Mp3Encoder } from '@breezystack/lamejs';
import { zipSync } from 'fflate';
import type {
  AudioBufferData,
  ExportFormat,
  ExportId3Metadata,
  ExportOptions,
  ExportSampleRate,
  MasteringSettings,
} from '../types';
import { downmixToMono, pcmToAudioBufferData, resampleAudioBufferData } from './decoder';
import { clampSample } from './dsp';
import { MASTERING_PRESETS, masterAudio } from './mastering';

export const PROVENANCE_SOFTWARE_TAG = 'VoiceForge Studio (Local AI)';
export const PROVENANCE_COMMENT_TAG = 'Synthetic AI-generated speech';
export const SRT_BOUNDARY_NOTE =
  'Timestamps represent segment-level measured audio boundaries (chunk start/end durations), not word-level forced alignment.';

export interface ExportResult {
  bytes: Uint8Array;
  mimeType: string;
  extension: 'wav' | 'mp3';
  filename: string;
  sampleRate: number;
  channels: number;
  notes: string[];
}

export interface ExportSegmentItem {
  filename: string;
  audio: AudioBufferData;
  text?: string;
  pauseAfterMs?: number;
}

export interface SrtSegmentInput {
  text: string;
  durationSec?: number;
  audio?: AudioBufferData;
  pauseAfterMs?: number;
}

export interface SrtCue {
  index: number;
  startSec: number;
  endSec: number;
  text: string;
}

export interface SrtGenerationResult {
  srt: string;
  metadataNote: string;
  totalDurationSec: number;
  cues: SrtCue[];
}

const VALID_MPEG_SAMPLE_RATES = new Set([8000, 11025, 12000, 16000, 22050, 24000, 32000, 44100, 48000]);
const VALID_MPEG1_SAMPLE_RATES = new Set([32000, 44100, 48000]);

/**
 * Explain sample-rate conversion behavior transparently for export UIs and manifests.
 * Upsampling improves DAW/broadcast compatibility but adds no original acoustic detail.
 */
export function getSampleRateResamplingNote(
  fromRate: number,
  toRate: ExportSampleRate
): string | null {
  if (toRate === 'native' || toRate === fromRate) {
    return null;
  }
  if (toRate > fromRate) {
    return `Resampled from ${fromRate} Hz to ${toRate} Hz for playback/DAW compatibility; upsampling adds no new original acoustic detail above ${Math.floor(fromRate / 2)} Hz.`;
  }
  return `Downsampled from ${fromRate} Hz to ${toRate} Hz using Lanczos-3 anti-aliasing.`;
}

function convertChannelLayout(
  audio: AudioBufferData,
  channels: 'mono' | 'stereo'
): AudioBufferData {
  if (channels === 'mono') {
    if (audio.channels === 1) return audio;
    return pcmToAudioBufferData(
      downmixToMono(audio.samples, audio.channels),
      audio.sampleRate,
      1
    );
  }

  // Dual-mono stereo conversion when source is mono
  if (audio.channels === 2) return audio;
  const mono = audio.channels === 1 ? audio.samples : downmixToMono(audio.samples, audio.channels);
  const stereo = new Float32Array(mono.length * 2);
  for (let i = 0; i < mono.length; i++) {
    stereo[i * 2] = mono[i];
    stereo[i * 2 + 1] = mono[i];
  }
  return pcmToAudioBufferData(stereo, audio.sampleRate, 2);
}

/**
 * Prepare audio for export with optional sample-rate conversion (`'native' | 44100 | 48000`)
 * and channel layout (`'mono' | 'stereo'`).
 */
export function prepareAudioForExport(
  audio: AudioBufferData,
  options: {
    sampleRate?: ExportSampleRate;
    channels?: 'mono' | 'stereo';
  } = {}
): { audio: AudioBufferData; note: string | null } {
  const targetRate = options.sampleRate ?? 'native';
  const targetChannels = options.channels ?? (audio.channels > 1 ? 'stereo' : 'mono');

  let work = convertChannelLayout(audio, targetChannels);
  const note = getSampleRateResamplingNote(work.sampleRate, targetRate);

  if (targetRate !== 'native' && targetRate !== work.sampleRate) {
    work = resampleAudioBufferData(work, targetRate);
  }

  return { audio: work, note };
}

function encodeAsciiBytes(text: string): Uint8Array {
  const bytes = new Uint8Array(text.length);
  for (let i = 0; i < text.length; i++) {
    const code = text.charCodeAt(i);
    bytes[i] = code <= 0x7f ? code : 0x3f; // '?' fallback for non-ASCII in RIFF INFO
  }
  return bytes;
}

function buildInfoSubchunk(id: string, value: string): Uint8Array {
  const strBytes = encodeAsciiBytes(value);
  const payloadLen = strBytes.length + 1; // null-terminated
  const paddedLen = payloadLen + (payloadLen % 2); // RIFF word alignment
  const buf = new Uint8Array(8 + paddedLen);
  const view = new DataView(buf.buffer);
  for (let i = 0; i < 4; i++) {
    buf[i] = id.charCodeAt(i);
  }
  view.setUint32(4, payloadLen, true);
  buf.set(strBytes, 8);
  // trailing null & pad byte are already 0
  return buf;
}

function buildRiffListInfoChunk(metadata?: ExportId3Metadata): Uint8Array {
  const commentValue = metadata?.comment
    ? `${PROVENANCE_COMMENT_TAG} | ${metadata.comment}`
    : PROVENANCE_COMMENT_TAG;

  const subchunks: Uint8Array[] = [
    buildInfoSubchunk('ISFT', PROVENANCE_SOFTWARE_TAG),
    buildInfoSubchunk('ICMT', commentValue),
  ];

  if (metadata?.title) subchunks.push(buildInfoSubchunk('INAM', metadata.title));
  if (metadata?.artist) subchunks.push(buildInfoSubchunk('IART', metadata.artist));
  if (metadata?.album) subchunks.push(buildInfoSubchunk('IPRD', metadata.album));
  if (metadata?.year) subchunks.push(buildInfoSubchunk('ICRD', metadata.year));

  const subchunksLen = subchunks.reduce((sum, c) => sum + c.length, 0);
  const listBodySize = 4 + subchunksLen; // 'INFO' + subchunks
  const out = new Uint8Array(8 + listBodySize);
  const view = new DataView(out.buffer);

  out[0] = 0x4c; // L
  out[1] = 0x49; // I
  out[2] = 0x53; // S
  out[3] = 0x54; // T
  view.setUint32(4, listBodySize, true);
  out[8] = 0x49; // I
  out[9] = 0x4e; // N
  out[10] = 0x46; // F
  out[11] = 0x4f; // O

  let offset = 12;
  for (const sc of subchunks) {
    out.set(sc, offset);
    offset += sc.length;
  }

  return out;
}

function encodeWavPcm(
  audio: AudioBufferData,
  bitsPerSample: 16 | 24,
  metadata?: ExportId3Metadata
): Uint8Array {
  if (!audio || !audio.samples || audio.samples.length === 0) {
    throw new Error('Cannot encode empty audio buffer to WAV.');
  }

  const channels = Math.max(1, audio.channels || 1);
  const sampleRate = Math.round(audio.sampleRate);
  const bytesPerSample = bitsPerSample / 8;
  const sampleCount = audio.samples.length;
  const dataSize = sampleCount * bytesPerSample;
  const infoChunk = buildRiffListInfoChunk(metadata);
  const riffSize = 4 + 24 + 8 + dataSize + infoChunk.length; // 'WAVE' + fmt(24) + dataHdr(8) + data + LIST/INFO

  const out = new Uint8Array(8 + riffSize);
  const view = new DataView(out.buffer);

  // RIFF header
  out[0] = 0x52; // R
  out[1] = 0x49; // I
  out[2] = 0x46; // F
  out[3] = 0x46; // F
  view.setUint32(4, riffSize, true);
  out[8] = 0x57; // W
  out[9] = 0x41; // A
  out[10] = 0x56; // V
  out[11] = 0x45; // E

  // fmt subchunk
  out[12] = 0x66; // f
  out[13] = 0x6d; // m
  out[14] = 0x74; // t
  out[15] = 0x20; // ' '
  view.setUint32(16, 16, true); // PCM fmt chunk size
  view.setUint16(20, 1, true); // AudioFormat = 1 (PCM)
  view.setUint16(22, channels, true);
  view.setUint32(24, sampleRate, true);
  view.setUint32(28, sampleRate * channels * bytesPerSample, true);
  view.setUint16(32, channels * bytesPerSample, true);
  view.setUint16(34, bitsPerSample, true);

  // data subchunk
  out[36] = 0x64; // d
  out[37] = 0x61; // a
  out[38] = 0x74; // t
  out[39] = 0x61; // a
  view.setUint32(40, dataSize, true);

  let pos = 44;
  if (bitsPerSample === 16) {
    for (let i = 0; i < sampleCount; i++) {
      const s = clampSample(audio.samples[i]);
      const int16 = s < 0 ? Math.round(s * 32768) : Math.round(s * 32767);
      view.setInt16(pos, Math.max(-32768, Math.min(32767, int16)), true);
      pos += 2;
    }
  } else {
    for (let i = 0; i < sampleCount; i++) {
      const s = clampSample(audio.samples[i]);
      const int24 = s < 0 ? Math.round(s * 8388608) : Math.round(s * 8388607);
      const clamped = Math.max(-8388608, Math.min(8388607, int24));
      out[pos] = clamped & 0xff;
      out[pos + 1] = (clamped >> 8) & 0xff;
      out[pos + 2] = (clamped >> 16) & 0xff;
      pos += 3;
    }
  }

  out.set(infoChunk, pos);
  return out;
}

/**
 * Encode `AudioBufferData` as a 16-bit signed PCM WAV with RIFF `LIST/INFO` provenance metadata.
 */
export function encodeWav16(
  audio: AudioBufferData,
  metadata?: ExportId3Metadata
): Uint8Array {
  return encodeWavPcm(audio, 16, metadata);
}

/**
 * Encode `AudioBufferData` as a 24-bit signed PCM WAV with RIFF `LIST/INFO` provenance metadata.
 */
export function encodeWav24(
  audio: AudioBufferData,
  metadata?: ExportId3Metadata
): Uint8Array {
  return encodeWavPcm(audio, 24, metadata);
}

function encodeUtf8Bytes(text: string): Uint8Array {
  return new TextEncoder().encode(text);
}

function buildId3v2TextFrame(frameId: string, value: string): Uint8Array {
  const textBytes = encodeUtf8Bytes(value);
  const payloadSize = 1 + textBytes.length; // encoding byte (0x03 = UTF-8) + string
  const frame = new Uint8Array(10 + payloadSize);
  for (let i = 0; i < 4; i++) {
    frame[i] = frameId.charCodeAt(i);
  }
  // ID3v2.3 uses standard big-endian 32-bit frame size
  const view = new DataView(frame.buffer);
  view.setUint32(4, payloadSize, false);
  frame[10] = 0x03; // UTF-8
  frame.set(textBytes, 11);
  return frame;
}

function buildId3v2CommentFrame(comment: string): Uint8Array {
  const textBytes = encodeUtf8Bytes(comment);
  // encoding(1) + language('eng'=3) + short description empty(1='\0') + text
  const payloadSize = 1 + 3 + 1 + textBytes.length;
  const frame = new Uint8Array(10 + payloadSize);
  frame[0] = 0x43; // C
  frame[1] = 0x4f; // O
  frame[2] = 0x4d; // M
  frame[3] = 0x4d; // M
  new DataView(frame.buffer).setUint32(4, payloadSize, false);
  frame[10] = 0x03; // UTF-8
  frame[11] = 0x65; // e
  frame[12] = 0x6e; // n
  frame[13] = 0x67; // g
  frame[14] = 0x00; // empty content descriptor
  frame.set(textBytes, 15);
  return frame;
}

function buildId3v2Header(metadata?: ExportId3Metadata): Uint8Array {
  const commentText = metadata?.comment
    ? `${PROVENANCE_COMMENT_TAG} | ${metadata.comment}`
    : PROVENANCE_COMMENT_TAG;

  const frames: Uint8Array[] = [
    buildId3v2TextFrame('TSSE', PROVENANCE_SOFTWARE_TAG),
    buildId3v2CommentFrame(commentText),
  ];

  if (metadata?.title) frames.push(buildId3v2TextFrame('TIT2', metadata.title));
  if (metadata?.artist) frames.push(buildId3v2TextFrame('TPE1', metadata.artist));
  if (metadata?.album) frames.push(buildId3v2TextFrame('TALB', metadata.album));
  if (metadata?.year) frames.push(buildId3v2TextFrame('TYER', metadata.year));

  const bodySize = frames.reduce((sum, f) => sum + f.length, 0);
  const tag = new Uint8Array(10 + bodySize);

  // 'ID3' v2.3.0
  tag[0] = 0x49;
  tag[1] = 0x44;
  tag[2] = 0x33;
  tag[3] = 0x03;
  tag[4] = 0x00;
  tag[5] = 0x00;

  // Synchsafe 28-bit size
  tag[6] = (bodySize >> 21) & 0x7f;
  tag[7] = (bodySize >> 14) & 0x7f;
  tag[8] = (bodySize >> 7) & 0x7f;
  tag[9] = bodySize & 0x7f;

  let offset = 10;
  for (const frame of frames) {
    tag.set(frame, offset);
    offset += frame.length;
  }

  return tag;
}

function floatToInt16Array(samples: Float32Array): Int16Array {
  const out = new Int16Array(samples.length);
  for (let i = 0; i < samples.length; i++) {
    const s = clampSample(samples[i]);
    const v = s < 0 ? Math.round(s * 32768) : Math.round(s * 32767);
    out[i] = Math.max(-32768, Math.min(32767, v));
  }
  return out;
}

function toUnsignedBytes(chunk: Uint8Array): Uint8Array {
  // @breezystack/lamejs returns Int8Array at runtime despite its Uint8Array d.ts declaration
  return new Uint8Array(chunk.buffer, chunk.byteOffset, chunk.byteLength);
}

/**
 * Encode `AudioBufferData` to MP3 (`128 | 192 | 256 | 320` kbps) with an ID3v2.3 synthetic-speech header.
 *
 * Automatically resamples to 44100 Hz when encoding >160 kbps from sub-32 kHz sources (e.g. 24 kHz),
 * because MPEG-2 Layer III caps bitrates at 160 kbps while MPEG-1 (32/44.1/48 kHz) supports 192-320 kbps.
 */
export function encodeMp3(
  audio: AudioBufferData,
  bitrateKbps: 128 | 192 | 256 | 320,
  metadata?: ExportId3Metadata
): Uint8Array {
  if (!audio || !audio.samples || audio.samples.length === 0) {
    throw new Error('Cannot encode empty audio buffer to MP3.');
  }

  let source = audio;
  const roundedRate = Math.round(source.sampleRate);
  const needsMpeg1Rate = bitrateKbps > 160 && !VALID_MPEG1_SAMPLE_RATES.has(roundedRate);
  const needsAnyValidRate = !VALID_MPEG_SAMPLE_RATES.has(roundedRate);

  if (needsMpeg1Rate || needsAnyValidRate) {
    source = resampleAudioBufferData(source, 44100);
  }

  const channels = Math.min(2, Math.max(1, source.channels || 1));
  const encoder = new Mp3Encoder(channels, Math.round(source.sampleRate), bitrateKbps);
  const blockSize = 1152;
  const mp3Parts: Uint8Array[] = [buildId3v2Header(metadata)];

  if (channels === 1) {
    const pcm = floatToInt16Array(source.samples);
    for (let i = 0; i < pcm.length; i += blockSize) {
      const encoded = encoder.encodeBuffer(pcm.subarray(i, i + blockSize));
      if (encoded.length > 0) {
        mp3Parts.push(new Uint8Array(toUnsignedBytes(encoded)));
      }
    }
  } else {
    const frames = Math.floor(source.samples.length / source.channels);
    const left = new Float32Array(frames);
    const right = new Float32Array(frames);
    for (let i = 0; i < frames; i++) {
      left[i] = source.samples[i * source.channels];
      right[i] = source.samples[i * source.channels + 1];
    }
    const left16 = floatToInt16Array(left);
    const right16 = floatToInt16Array(right);

    for (let i = 0; i < frames; i += blockSize) {
      const encoded = encoder.encodeBuffer(
        left16.subarray(i, i + blockSize),
        right16.subarray(i, i + blockSize)
      );
      if (encoded.length > 0) {
        mp3Parts.push(new Uint8Array(toUnsignedBytes(encoded)));
      }
    }
  }

  const flushed = encoder.flush();
  if (flushed.length > 0) {
    mp3Parts.push(new Uint8Array(toUnsignedBytes(flushed)));
  }

  const totalBytes = mp3Parts.reduce((sum, p) => sum + p.length, 0);
  const out = new Uint8Array(totalBytes);
  let offset = 0;
  for (const part of mp3Parts) {
    out.set(part, offset);
    offset += part.length;
  }
  return out;
}

function getMp3BitrateFromFormat(format: ExportFormat): 128 | 192 | 256 | 320 {
  switch (format) {
    case 'mp3_128':
      return 128;
    case 'mp3_192':
      return 192;
    case 'mp3_256':
      return 256;
    case 'mp3_320':
      return 320;
    default:
      throw new Error(`Not an MP3 export format: ${format}`);
  }
}

/**
 * Format seconds into `HH:MM:SS,mmm` SRT timestamp syntax.
 */
export function formatSrtTimestamp(seconds: number): string {
  const safeMs = Math.max(0, Math.round(seconds * 1000));
  const hours = Math.floor(safeMs / 3_600_000);
  const mins = Math.floor((safeMs % 3_600_000) / 60_000);
  const secs = Math.floor((safeMs % 60_000) / 1000);
  const ms = safeMs % 1000;

  return `${String(hours).padStart(2, '0')}:${String(mins).padStart(2, '0')}:${String(secs).padStart(2, '0')},${String(ms).padStart(3, '0')}`;
}

/**
 * Generate SRT subtitles from synthesized segments using their measured audio durations.
 *
 * Includes an explicit `metadataNote` clarifying that cue boundaries come from measured
 * per-segment durations (not word-level forced alignment).
 */
export function generateSrtFromSegments(
  segments: SrtSegmentInput[],
  options: { defaultPauseMs?: number } = {}
): SrtGenerationResult {
  const defaultPauseMs = Math.max(0, options.defaultPauseMs ?? 0);
  const cues: SrtCue[] = [];
  const blocks: string[] = [];

  let cursorSec = 0;
  let cueIndex = 1;

  for (const seg of segments) {
    const durationSec = Math.max(
      0,
      seg.durationSec ?? seg.audio?.durationSec ?? 0
    );
    const trimmedText = (seg.text ?? '').trim();
    const startSec = cursorSec;
    const endSec = startSec + durationSec;

    if (trimmedText.length > 0 && durationSec > 0) {
      cues.push({
        index: cueIndex,
        startSec,
        endSec,
        text: trimmedText,
      });
      blocks.push(
        `${cueIndex}\n${formatSrtTimestamp(startSec)} --> ${formatSrtTimestamp(endSec)}\n${trimmedText}`
      );
      cueIndex++;
    }

    const pauseSec = Math.max(0, seg.pauseAfterMs ?? defaultPauseMs) / 1000;
    cursorSec = endSec + pauseSec;
  }

  return {
    srt: blocks.join('\n\n') + (blocks.length > 0 ? '\n' : ''),
    metadataNote: SRT_BOUNDARY_NOTE,
    totalDurationSec: cursorSec,
    cues,
  };
}

/**
 * Run the full export pipeline (optional mastering, optional normalization, resampling,
 * channel layout, and WAV/MP3 encoding with provenance metadata).
 */
export function exportAudio(
  audio: AudioBufferData,
  options: ExportOptions,
  masteringSettings?: MasteringSettings
): ExportResult {
  const notes: string[] = [];
  let work = audio;

  if (options.applyMastering) {
    const settings = masteringSettings ?? MASTERING_PRESETS.natural;
    work = masterAudio(work, settings);
  } else if (options.normalizeOutput) {
    const normSettings: MasteringSettings = {
      ...MASTERING_PRESETS.raw,
      preset: 'custom',
      targetLufs: masteringSettings?.targetLufs ?? -16,
      truePeakLimitDb: masteringSettings?.truePeakLimitDb ?? -1.0,
    };
    work = masterAudio(work, normSettings);
  }

  const prepared = prepareAudioForExport(work, {
    sampleRate: options.sampleRate,
    channels: options.channels,
  });
  work = prepared.audio;
  if (prepared.note) {
    notes.push(prepared.note);
  }

  const baseName = (options.filename || 'voiceforge-output').replace(/\.(wav|mp3)$/i, '');

  if (options.format === 'wav16' || options.format === 'wav24') {
    const bytes =
      options.format === 'wav16'
        ? encodeWav16(work, options.metadata)
        : encodeWav24(work, options.metadata);
    return {
      bytes,
      mimeType: 'audio/wav',
      extension: 'wav',
      filename: `${baseName}.wav`,
      sampleRate: work.sampleRate,
      channels: work.channels,
      notes,
    };
  }

  const bitrate = getMp3BitrateFromFormat(options.format);
  if (bitrate > 160 && !VALID_MPEG1_SAMPLE_RATES.has(Math.round(work.sampleRate))) {
    notes.push(
      `MP3 ${bitrate} kbps uses MPEG-1 sample rates; audio was resampled from ${work.sampleRate} Hz to 44100 Hz for encoding.`
    );
  }
  const bytes = encodeMp3(work, bitrate, options.metadata);

  return {
    bytes,
    mimeType: 'audio/mpeg',
    extension: 'mp3',
    filename: `${baseName}.mp3`,
    sampleRate: bitrate > 160 && !VALID_MPEG1_SAMPLE_RATES.has(Math.round(work.sampleRate)) ? 44100 : work.sampleRate,
    channels: work.channels,
    notes,
  };
}

/**
 * Package multiple narration segments into a single local ZIP archive using `fflate`,
 * optionally bundling measured-boundary SRT subtitles and a metadata provenance manifest.
 */
export function exportSegmentsZip(
  segments: ExportSegmentItem[],
  options: Omit<ExportOptions, 'filename'>,
  zipOptions: {
    masteringSettings?: MasteringSettings;
    includeSrt?: boolean;
    includeManifest?: boolean;
    defaultPauseMs?: number;
  } = {}
): Uint8Array {
  if (!segments || segments.length === 0) {
    throw new Error('Cannot create ZIP archive from empty segments list.');
  }

  const files: Record<string, Uint8Array> = {};
  const manifestSegments: Array<{
    index: number;
    filename: string;
    durationSec: number;
    sampleRate: number;
    channels: number;
    text?: string;
  }> = [];

  for (let i = 0; i < segments.length; i++) {
    const seg = segments[i];
    const prefix = String(i + 1).padStart(3, '0');
    const cleanName = (seg.filename || `segment_${prefix}`).replace(/[^a-zA-Z0-9._-]/g, '_');
    const exported = exportAudio(
      seg.audio,
      {
        ...options,
        filename: cleanName.startsWith(prefix) ? cleanName : `${prefix}_${cleanName}`,
      },
      zipOptions.masteringSettings
    );
    files[exported.filename] = exported.bytes;
    manifestSegments.push({
      index: i + 1,
      filename: exported.filename,
      durationSec: seg.audio.durationSec,
      sampleRate: exported.sampleRate,
      channels: exported.channels,
      text: seg.text,
    });
  }

  if (zipOptions.includeSrt) {
    const srtResult = generateSrtFromSegments(
      segments.map((s) => ({
        text: s.text ?? '',
        durationSec: s.audio.durationSec,
        pauseAfterMs: s.pauseAfterMs,
      })),
      { defaultPauseMs: zipOptions.defaultPauseMs }
    );
    if (srtResult.cues.length > 0) {
      files['subtitles.srt'] = encodeUtf8Bytes(srtResult.srt);
      files['subtitles_note.txt'] = encodeUtf8Bytes(`${srtResult.metadataNote}\n`);
    }
  }

  if (zipOptions.includeManifest !== false) {
    const manifest = {
      generator: PROVENANCE_SOFTWARE_TAG,
      provenance: PROVENANCE_COMMENT_TAG,
      srtAlignmentNote: SRT_BOUNDARY_NOTE,
      format: options.format,
      sampleRate: options.sampleRate,
      channels: options.channels,
      segments: manifestSegments,
    };
    files['manifest.json'] = encodeUtf8Bytes(JSON.stringify(manifest, null, 2));
  }

  return zipSync(files, { level: 6 });
}
