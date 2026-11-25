import type { AudioBufferData } from '../types';

export const MAX_AUDIO_FILE_BYTES = 250 * 1024 * 1024; // 250 MB
export const MAX_VIDEO_FILE_BYTES = 500 * 1024 * 1024; // 500 MB

export const SUPPORTED_AUDIO_EXTENSIONS = [
  '.wav',
  '.mp3',
  '.m4a',
  '.flac',
  '.ogg',
  '.oga',
] as const;

export const SUPPORTED_AUDIO_MIME_TYPES = new Set([
  'audio/wav',
  'audio/wave',
  'audio/x-wav',
  'audio/vnd.wave',
  'audio/mpeg',
  'audio/mp3',
  'audio/mp4',
  'audio/x-m4a',
  'audio/m4a',
  'audio/aac',
  'audio/flac',
  'audio/x-flac',
  'audio/ogg',
  'application/ogg',
]);

export const SUPPORTED_VIDEO_EXTENSIONS = [
  '.mp4',
  '.webm',
  '.mov',
  '.m4v',
  '.ogv',
  '.mkv',
] as const;

export const SUPPORTED_VIDEO_MIME_TYPES = new Set([
  'video/mp4',
  'video/webm',
  'video/quicktime',
  'video/x-m4v',
  'video/ogg',
  'video/x-matroska',
]);

export type AudioDecodeErrorCode =
  | 'EMPTY_FILE'
  | 'FILE_TOO_LARGE'
  | 'UNSUPPORTED_FORMAT'
  | 'CORRUPT_FILE'
  | 'DECODE_UNSUPPORTED'
  | 'NO_AUDIO_TRACK'
  | 'VIDEO_EXTRACT_FAILED';

export class AudioDecodeError extends Error {
  readonly code: AudioDecodeErrorCode;

  constructor(code: AudioDecodeErrorCode, message: string, cause?: unknown) {
    super(message, cause !== undefined ? { cause } : undefined);
    this.name = 'AudioDecodeError';
    this.code = code;
  }
}

export interface DecodeAudioOptions {
  /** Maximum allowed file size in bytes (defaults to 250 MB). */
  maxBytes?: number;
  /** Optional target sample rate to resample to after decoding. */
  targetSampleRate?: number;
  /** Downmix multi-channel audio to mono after decoding (default: false). */
  mono?: boolean;
}

export interface ExtractVideoAudioOptions extends DecodeAudioOptions {
  /** Timeout in milliseconds for fallback <video> extraction (default: 120_000). */
  timeoutMs?: number;
  /** Optional AbortSignal to cancel local video audio extraction. */
  signal?: AbortSignal;
}

type AudioContextConstructor = typeof AudioContext;

function getAudioContextConstructor(): AudioContextConstructor | null {
  const g = globalThis as typeof globalThis & {
    webkitAudioContext?: AudioContextConstructor;
  };
  return g.AudioContext ?? g.webkitAudioContext ?? null;
}

function getOfflineAudioContextConstructor(): typeof OfflineAudioContext | null {
  const g = globalThis as typeof globalThis & {
    webkitOfflineAudioContext?: typeof OfflineAudioContext;
  };
  return g.OfflineAudioContext ?? g.webkitOfflineAudioContext ?? null;
}

function getFileExtension(filename: string): string {
  const dot = filename.lastIndexOf('.');
  return dot >= 0 ? filename.slice(dot).toLowerCase() : '';
}

function formatBytesMb(bytes: number): string {
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

/**
 * Validate an uploaded audio file's size, extension, and MIME type before decoding.
 */
export function validateAudioFile(
  file: Pick<File, 'name' | 'type' | 'size'>,
  maxBytes: number = MAX_AUDIO_FILE_BYTES
): void {
  if (!file || file.size <= 0) {
    throw new AudioDecodeError(
      'EMPTY_FILE',
      'The selected audio file is empty (0 bytes). Please choose a valid audio recording.'
    );
  }
  if (file.size > maxBytes) {
    throw new AudioDecodeError(
      'FILE_TOO_LARGE',
      `Audio file (${formatBytesMb(file.size)}) exceeds the ${formatBytesMb(maxBytes)} local processing limit.`
    );
  }

  const ext = getFileExtension(file.name ?? '');
  const mime = (file.type ?? '').toLowerCase().split(';')[0].trim();
  const hasSupportedExt = (SUPPORTED_AUDIO_EXTENSIONS as readonly string[]).includes(ext);
  const hasSupportedMime = mime.length > 0 && SUPPORTED_AUDIO_MIME_TYPES.has(mime);

  if (!hasSupportedExt && !hasSupportedMime) {
    throw new AudioDecodeError(
      'UNSUPPORTED_FORMAT',
      `Unsupported audio format "${ext || mime || 'unknown'}". Supported formats: WAV, MP3, M4A, FLAC, and OGG.`
    );
  }
}

/**
 * Validate a local video file prior to client-side audio track extraction.
 */
export function validateVideoFile(
  file: Pick<File, 'name' | 'type' | 'size'>,
  maxBytes: number = MAX_VIDEO_FILE_BYTES
): void {
  if (!file || file.size <= 0) {
    throw new AudioDecodeError(
      'EMPTY_FILE',
      'The selected video file is empty (0 bytes).'
    );
  }
  if (file.size > maxBytes) {
    throw new AudioDecodeError(
      'FILE_TOO_LARGE',
      `Video file (${formatBytesMb(file.size)}) exceeds the ${formatBytesMb(maxBytes)} local extraction limit.`
    );
  }

  const ext = getFileExtension(file.name ?? '');
  const mime = (file.type ?? '').toLowerCase().split(';')[0].trim();
  const hasSupportedExt = (SUPPORTED_VIDEO_EXTENSIONS as readonly string[]).includes(ext);
  const hasSupportedMime =
    mime.length > 0 && (SUPPORTED_VIDEO_MIME_TYPES.has(mime) || mime.startsWith('video/'));

  if (!hasSupportedExt && !hasSupportedMime) {
    throw new AudioDecodeError(
      'UNSUPPORTED_FORMAT',
      `Unsupported video format "${ext || mime || 'unknown'}". Supported containers: MP4, WebM, MOV, M4V, OGV, MKV.`
    );
  }
}

/**
 * Construct a validated, sanitized `AudioBufferData` from a PCM Float32Array.
 * Always clones the sample array so callers keep ownership safely.
 */
export function pcmToAudioBufferData(
  samples: Float32Array,
  sampleRate: number,
  channels: number = 1
): AudioBufferData {
  if (!Number.isFinite(sampleRate) || sampleRate <= 0) {
    throw new Error(`Invalid sampleRate: ${sampleRate}`);
  }
  if (!Number.isInteger(channels) || channels < 1) {
    throw new Error(`Invalid channel count: ${channels}`);
  }
  const frameCount = Math.floor(samples.length / channels);
  const usableLength = frameCount * channels;
  const copy = new Float32Array(usableLength);

  for (let i = 0; i < usableLength; i++) {
    const v = samples[i];
    copy[i] = Number.isFinite(v) ? v : 0;
  }

  return {
    samples: copy,
    sampleRate,
    channels,
    durationSec: frameCount / sampleRate,
  };
}

/**
 * Downmix interleaved multi-channel PCM samples to mono Float32Array.
 */
export function downmixToMono(samples: Float32Array, channels: number): Float32Array {
  if (!Number.isInteger(channels) || channels < 1) {
    throw new Error(`Invalid channel count: ${channels}`);
  }
  if (channels === 1) {
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

/**
 * Non-destructively downmix an `AudioBufferData` to mono.
 */
export function downmixAudioBufferToMono(audio: AudioBufferData): AudioBufferData {
  const mono = downmixToMono(audio.samples, audio.channels);
  return pcmToAudioBufferData(mono, audio.sampleRate, 1);
}

function sinc(x: number): number {
  if (Math.abs(x) < 1e-8) return 1.0;
  const px = Math.PI * x;
  return Math.sin(px) / px;
}

function resampleSingleChannelLanczos3(
  samples: Float32Array,
  fromRate: number,
  toRate: number
): Float32Array {
  if (fromRate === toRate || samples.length === 0) {
    return new Float32Array(samples);
  }
  const ratio = fromRate / toRate;
  const outLength = Math.max(1, Math.round(samples.length / ratio));
  const out = new Float32Array(outLength);
  const a = 3;
  // Scale the sinc kernel when downsampling to act as an anti-aliasing low-pass filter.
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
 * Resample mono or interleaved multi-channel PCM using high-quality Lanczos-3 windowed-sinc interpolation.
 */
export function resamplePcm(
  samples: Float32Array,
  fromRate: number,
  toRate: number,
  channels: number = 1
): Float32Array {
  if (!Number.isFinite(fromRate) || fromRate <= 0 || !Number.isFinite(toRate) || toRate <= 0) {
    throw new Error(`Invalid sample rates for resampling: ${fromRate} -> ${toRate}`);
  }
  if (!Number.isInteger(channels) || channels < 1) {
    throw new Error(`Invalid channel count: ${channels}`);
  }
  if (fromRate === toRate || samples.length === 0) {
    return new Float32Array(samples);
  }
  if (channels === 1) {
    return resampleSingleChannelLanczos3(samples, fromRate, toRate);
  }

  const inFrames = Math.floor(samples.length / channels);
  const resampledChannels: Float32Array[] = [];
  for (let ch = 0; ch < channels; ch++) {
    const channelData = new Float32Array(inFrames);
    for (let i = 0; i < inFrames; i++) {
      channelData[i] = samples[i * channels + ch];
    }
    resampledChannels.push(resampleSingleChannelLanczos3(channelData, fromRate, toRate));
  }

  const outFrames = resampledChannels[0].length;
  const interleaved = new Float32Array(outFrames * channels);
  for (let i = 0; i < outFrames; i++) {
    const base = i * channels;
    for (let ch = 0; ch < channels; ch++) {
      interleaved[base + ch] = resampledChannels[ch][i];
    }
  }
  return interleaved;
}

/**
 * Synchronously resample an `AudioBufferData` using Lanczos-3 interpolation.
 */
export function resampleAudioBufferData(
  audio: AudioBufferData,
  toRate: number
): AudioBufferData {
  const resampled = resamplePcm(audio.samples, audio.sampleRate, toRate, audio.channels);
  return pcmToAudioBufferData(resampled, toRate, audio.channels);
}

/**
 * Resample an `AudioBufferData` using `OfflineAudioContext` when running in a browser,
 * falling back seamlessly to Lanczos-3 synchronous resampling if `OfflineAudioContext` is unavailable.
 */
export async function resampleWithOfflineAudioContext(
  audio: AudioBufferData,
  toRate: number
): Promise<AudioBufferData> {
  if (!Number.isFinite(toRate) || toRate <= 0) {
    throw new Error(`Invalid target sample rate: ${toRate}`);
  }
  if (audio.sampleRate === toRate) {
    return pcmToAudioBufferData(audio.samples, audio.sampleRate, audio.channels);
  }

  const OfflineCtx = getOfflineAudioContextConstructor();
  if (!OfflineCtx) {
    return resampleAudioBufferData(audio, toRate);
  }

  try {
    const inFrames = Math.floor(audio.samples.length / audio.channels);
    const outFrames = Math.max(1, Math.round((inFrames * toRate) / audio.sampleRate));
    const ctx = new OfflineCtx(audio.channels, outFrames, toRate);
    const buffer = ctx.createBuffer(audio.channels, inFrames, audio.sampleRate);

    for (let ch = 0; ch < audio.channels; ch++) {
      const chData = buffer.getChannelData(ch);
      if (audio.channels === 1) {
        chData.set(audio.samples);
      } else {
        for (let i = 0; i < inFrames; i++) {
          chData[i] = audio.samples[i * audio.channels + ch];
        }
      }
    }

    const source = ctx.createBufferSource();
    source.buffer = buffer;
    source.connect(ctx.destination);
    source.start(0);

    const rendered = await ctx.startRendering();
    return audioBufferToAudioBufferData(rendered);
  } catch {
    return resampleAudioBufferData(audio, toRate);
  }
}

/**
 * Convert a Web Audio `AudioBuffer` into an interleaved `AudioBufferData`.
 */
export function audioBufferToAudioBufferData(audioBuffer: AudioBuffer): AudioBufferData {
  const channels = Math.max(1, audioBuffer.numberOfChannels);
  const length = audioBuffer.length;

  if (channels === 1) {
    const mono = new Float32Array(audioBuffer.getChannelData(0));
    return pcmToAudioBufferData(mono, audioBuffer.sampleRate, 1);
  }

  const channelArrays: Float32Array[] = [];
  for (let ch = 0; ch < channels; ch++) {
    channelArrays.push(audioBuffer.getChannelData(ch));
  }

  const interleaved = new Float32Array(length * channels);
  for (let i = 0; i < length; i++) {
    const base = i * channels;
    for (let ch = 0; ch < channels; ch++) {
      interleaved[base + ch] = channelArrays[ch][i];
    }
  }

  return pcmToAudioBufferData(interleaved, audioBuffer.sampleRate, channels);
}

function readFourCc(view: DataView, offset: number): string {
  return String.fromCharCode(
    view.getUint8(offset),
    view.getUint8(offset + 1),
    view.getUint8(offset + 2),
    view.getUint8(offset + 3)
  );
}

function isWavBuffer(buffer: ArrayBuffer): boolean {
  if (buffer.byteLength < 12) return false;
  const view = new DataView(buffer);
  return readFourCc(view, 0) === 'RIFF' && readFourCc(view, 8) === 'WAVE';
}

/**
 * Decode a RIFF/WAVE PCM or IEEE-float WAV buffer directly in pure TypeScript.
 * Supports 8-bit unsigned, 16-bit signed, 24-bit signed, 32-bit signed, and 32-bit float PCM.
 */
export function decodeWavBuffer(buffer: ArrayBuffer): AudioBufferData {
  if (buffer.byteLength < 44) {
    throw new AudioDecodeError(
      'CORRUPT_FILE',
      'WAV file is too short to contain a valid RIFF/WAVE header.'
    );
  }

  const view = new DataView(buffer);
  if (readFourCc(view, 0) !== 'RIFF' || readFourCc(view, 8) !== 'WAVE') {
    throw new AudioDecodeError('CORRUPT_FILE', 'Invalid WAV header: missing RIFF/WAVE signature.');
  }

  let offset = 12;
  let audioFormat = 0;
  let channels = 0;
  let sampleRate = 0;
  let bitsPerSample = 0;
  let dataOffset = -1;
  let dataSize = 0;

  while (offset + 8 <= buffer.byteLength) {
    const chunkId = readFourCc(view, offset);
    const chunkSize = view.getUint32(offset + 4, true);
    const chunkBodyOffset = offset + 8;

    if (chunkBodyOffset + chunkSize > buffer.byteLength) {
      if (chunkId === 'data') {
        dataOffset = chunkBodyOffset;
        dataSize = buffer.byteLength - chunkBodyOffset;
        break;
      }
      throw new AudioDecodeError('CORRUPT_FILE', `Truncated WAV chunk "${chunkId}".`);
    }

    if (chunkId === 'fmt ') {
      if (chunkSize < 16) {
        throw new AudioDecodeError('CORRUPT_FILE', 'Invalid WAV fmt chunk size.');
      }
      audioFormat = view.getUint16(chunkBodyOffset, true);
      channels = view.getUint16(chunkBodyOffset + 2, true);
      sampleRate = view.getUint32(chunkBodyOffset + 4, true);
      bitsPerSample = view.getUint16(chunkBodyOffset + 14, true);

      // Handle WAVE_FORMAT_EXTENSIBLE (0xFFFE)
      if (audioFormat === 0xfffe && chunkSize >= 40) {
        audioFormat = view.getUint16(chunkBodyOffset + 24, true);
      }
    } else if (chunkId === 'data') {
      dataOffset = chunkBodyOffset;
      dataSize = chunkSize;
    }

    // RIFF chunks are word-aligned (padded to even byte boundary)
    offset = chunkBodyOffset + chunkSize + (chunkSize % 2);
  }

  if (channels <= 0 || sampleRate <= 0 || dataOffset < 0) {
    throw new AudioDecodeError(
      'CORRUPT_FILE',
      'WAV file is missing required fmt or data chunks.'
    );
  }

  if (audioFormat !== 1 && audioFormat !== 3) {
    throw new AudioDecodeError(
      'DECODE_UNSUPPORTED',
      `Unsupported WAV codec format code ${audioFormat}. Only uncompressed PCM and IEEE float WAV are supported natively.`
    );
  }

  const bytesPerSample = bitsPerSample / 8;
  if (
    (audioFormat === 1 && ![1, 2, 3, 4].includes(bytesPerSample)) ||
    (audioFormat === 3 && bytesPerSample !== 4)
  ) {
    throw new AudioDecodeError(
      'DECODE_UNSUPPORTED',
      `Unsupported WAV bit depth: ${bitsPerSample}-bit.`
    );
  }

  const totalSamples = Math.floor(dataSize / bytesPerSample);
  const frameCount = Math.floor(totalSamples / channels);
  const usableSamples = frameCount * channels;
  const out = new Float32Array(usableSamples);

  for (let i = 0; i < usableSamples; i++) {
    const pos = dataOffset + i * bytesPerSample;
    if (audioFormat === 3) {
      out[i] = view.getFloat32(pos, true);
    } else if (bytesPerSample === 1) {
      out[i] = (view.getUint8(pos) - 128) / 128;
    } else if (bytesPerSample === 2) {
      out[i] = view.getInt16(pos, true) / 32768;
    } else if (bytesPerSample === 3) {
      const b0 = view.getUint8(pos);
      const b1 = view.getUint8(pos + 1);
      const b2 = view.getUint8(pos + 2);
      let val = b0 | (b1 << 8) | (b2 << 16);
      if (val & 0x800000) {
        val |= ~0xffffff;
      }
      out[i] = val / 8388608;
    } else if (bytesPerSample === 4) {
      out[i] = view.getInt32(pos, true) / 2147483648;
    }
  }

  return pcmToAudioBufferData(out, sampleRate, channels);
}

function finalizeDecodedAudio(
  decoded: AudioBufferData,
  options?: Pick<DecodeAudioOptions, 'mono' | 'targetSampleRate'>
): AudioBufferData {
  let result = decoded;
  if (options?.mono && result.channels > 1) {
    result = downmixAudioBufferToMono(result);
  }
  if (
    options?.targetSampleRate &&
    options.targetSampleRate > 0 &&
    options.targetSampleRate !== result.sampleRate
  ) {
    result = resampleAudioBufferData(result, options.targetSampleRate);
  }
  return result;
}

/**
 * Decode an audio `ArrayBuffer` (WAV, MP3, M4A, FLAC, OGG) via Web Audio `AudioContext.decodeAudioData`.
 * Falls back to the built-in pure-TS WAV parser if `AudioContext` is unavailable in the runtime.
 */
export async function decodeAudioArrayBuffer(
  buffer: ArrayBuffer,
  options: {
    filename?: string;
    mimeType?: string;
    mono?: boolean;
    targetSampleRate?: number;
  } = {}
): Promise<AudioBufferData> {
  if (!buffer || buffer.byteLength === 0) {
    throw new AudioDecodeError('EMPTY_FILE', 'Audio buffer is empty.');
  }

  const AudioCtx = getAudioContextConstructor();
  if (!AudioCtx) {
    if (isWavBuffer(buffer)) {
      return finalizeDecodedAudio(decodeWavBuffer(buffer), options);
    }
    throw new AudioDecodeError(
      'DECODE_UNSUPPORTED',
      'Web Audio API (AudioContext) is unavailable in this environment to decode compressed audio.'
    );
  }

  const ctx = new AudioCtx();
  try {
    // Copy the buffer because decodeAudioData transfers/detaches its input ArrayBuffer in browsers.
    const audioBuffer = await ctx.decodeAudioData(buffer.slice(0));
    if (!audioBuffer || audioBuffer.length === 0) {
      throw new AudioDecodeError(
        'CORRUPT_FILE',
        `Decoded audio${options.filename ? ` "${options.filename}"` : ''} contains no audio frames.`
      );
    }
    const data = audioBufferToAudioBufferData(audioBuffer);
    return finalizeDecodedAudio(data, options);
  } catch (err) {
    if (err instanceof AudioDecodeError) {
      throw err;
    }
    // If browser decodeAudioData failed on a standard WAV in a partial/mocked environment, try pure-TS WAV parser.
    if (isWavBuffer(buffer)) {
      try {
        return finalizeDecodedAudio(decodeWavBuffer(buffer), options);
      } catch {
        // Fall through to clean corrupt-file error below.
      }
    }
    const label = options.filename ? `"${options.filename}"` : 'the uploaded file';
    throw new AudioDecodeError(
      'CORRUPT_FILE',
      `Unable to decode ${label}. The file may be corrupted or use an unsupported codec in this browser.`,
      err
    );
  } finally {
    await ctx.close().catch(() => undefined);
  }
}

/**
 * Decode an uploaded audio `File` (`WAV`, `MP3`, `M4A`, `FLAC`, `OGG`) locally in the browser.
 */
export async function decodeAudioFile(
  file: File,
  options: DecodeAudioOptions = {}
): Promise<AudioBufferData> {
  validateAudioFile(file, options.maxBytes ?? MAX_AUDIO_FILE_BYTES);
  const buffer = await file.arrayBuffer();
  return decodeAudioArrayBuffer(buffer, {
    filename: file.name,
    mimeType: file.type,
    mono: options.mono,
    targetSampleRate: options.targetSampleRate,
  });
}

async function extractViaLocalVideoElement(
  file: File,
  options: ExtractVideoAudioOptions
): Promise<AudioBufferData> {
  if (typeof document === 'undefined' || typeof URL === 'undefined' || !URL.createObjectURL) {
    throw new AudioDecodeError(
      'VIDEO_EXTRACT_FAILED',
      'Local <video> fallback extraction requires a browser DOM environment.'
    );
  }

  const AudioCtx = getAudioContextConstructor();
  if (!AudioCtx) {
    throw new AudioDecodeError(
      'VIDEO_EXTRACT_FAILED',
      'Web Audio API is unavailable to extract audio from this video locally.'
    );
  }

  const timeoutMs = options.timeoutMs ?? 120_000;
  const objectUrl = URL.createObjectURL(file);
  const video = document.createElement('video') as HTMLVideoElement & {
    captureStream?: () => MediaStream;
    mozCaptureStream?: () => MediaStream;
  };
  video.preload = 'auto';
  video.muted = true;
  video.playsInline = true;
  video.src = objectUrl;

  const ctx = new AudioCtx();
  let mediaRecorder: MediaRecorder | null = null;
  let sourceNode: MediaElementAudioSourceNode | null = null;
  let scriptNode: ScriptProcessorNode | null = null;
  let gainNode: GainNode | null = null;

  try {
    await new Promise<void>((resolve, reject) => {
      const onError = () => {
        reject(
          new AudioDecodeError(
            'VIDEO_EXTRACT_FAILED',
            `Browser could not load video "${file.name}". Codec may not be supported locally.`
          )
        );
      };
      const onAbort = () => {
        reject(new AudioDecodeError('VIDEO_EXTRACT_FAILED', 'Video audio extraction cancelled.'));
      };
      if (options.signal?.aborted) {
        onAbort();
        return;
      }
      options.signal?.addEventListener('abort', onAbort, { once: true });
      video.addEventListener('loadedmetadata', () => resolve(), { once: true });
      video.addEventListener('error', onError, { once: true });
    });

    const stream = video.captureStream?.() ?? video.mozCaptureStream?.();
    if (stream && typeof MediaRecorder !== 'undefined') {
      const audioTracks = stream.getAudioTracks();
      if (audioTracks.length === 0) {
        throw new AudioDecodeError(
          'NO_AUDIO_TRACK',
          `Video "${file.name}" does not contain an audio track.`
        );
      }

      const audioStream = new MediaStream(audioTracks);
      const chunks: BlobPart[] = [];
      mediaRecorder = new MediaRecorder(audioStream);
      mediaRecorder.ondataavailable = (ev) => {
        if (ev.data && ev.data.size > 0) {
          chunks.push(ev.data);
        }
      };

      const recordingDone = new Promise<Blob>((resolve, reject) => {
        if (!mediaRecorder) {
          reject(new Error('MediaRecorder unavailable'));
          return;
        }
        const timer = setTimeout(() => {
          mediaRecorder?.stop();
          reject(
            new AudioDecodeError(
              'VIDEO_EXTRACT_FAILED',
              'Timed out while extracting audio from local video.'
            )
          );
        }, timeoutMs);

        mediaRecorder.onstop = () => {
          clearTimeout(timer);
          resolve(new Blob(chunks, { type: mediaRecorder?.mimeType || 'audio/webm' }));
        };
        mediaRecorder.onerror = () => {
          clearTimeout(timer);
          reject(
            new AudioDecodeError(
              'VIDEO_EXTRACT_FAILED',
              'Local MediaRecorder failed while capturing the video audio track.'
            )
          );
        };
        video.onended = () => {
          if (mediaRecorder && mediaRecorder.state === 'recording') {
            mediaRecorder.stop();
          }
        };
      });

      mediaRecorder.start(250);
      await video.play();
      const recordedBlob = await recordingDone;
      const recordedBuffer = await recordedBlob.arrayBuffer();
      return await decodeAudioArrayBuffer(recordedBuffer, {
        filename: file.name,
        mono: options.mono,
        targetSampleRate: options.targetSampleRate,
      });
    }

    // Fallback: capture PCM via MediaElementAudioSourceNode + ScriptProcessorNode
    video.muted = false;
    sourceNode = ctx.createMediaElementSource(video);
    const channelCount = Math.max(1, sourceNode.channelCount || 2);
    scriptNode = ctx.createScriptProcessor(4096, channelCount, channelCount);
    gainNode = ctx.createGain();
    gainNode.gain.value = 0; // Silent output locally while recording PCM

    const capturedLeft: Float32Array[] = [];
    const capturedRight: Float32Array[] = [];
    let actualChannels = 1;

    scriptNode.onaudioprocess = (event) => {
      const input = event.inputBuffer;
      actualChannels = input.numberOfChannels;
      capturedLeft.push(new Float32Array(input.getChannelData(0)));
      if (actualChannels > 1) {
        capturedRight.push(new Float32Array(input.getChannelData(1)));
      }
    };

    sourceNode.connect(scriptNode);
    scriptNode.connect(gainNode);
    gainNode.connect(ctx.destination);

    await new Promise<void>((resolve, reject) => {
      const timer = setTimeout(() => {
        reject(
          new AudioDecodeError(
            'VIDEO_EXTRACT_FAILED',
            'Timed out while capturing local video audio.'
          )
        );
      }, timeoutMs);
      video.onended = () => {
        clearTimeout(timer);
        resolve();
      };
      video.onerror = () => {
        clearTimeout(timer);
        reject(
          new AudioDecodeError(
            'VIDEO_EXTRACT_FAILED',
            `Failed to play video "${file.name}" for local audio extraction.`
          )
        );
      };
      void video.play().catch((err) => {
        clearTimeout(timer);
        reject(err);
      });
    });

    const totalFrames = capturedLeft.reduce((sum, arr) => sum + arr.length, 0);
    if (totalFrames === 0) {
      throw new AudioDecodeError(
        'NO_AUDIO_TRACK',
        `No audio samples could be extracted from "${file.name}".`
      );
    }

    if (actualChannels === 1 || capturedRight.length === 0) {
      const mono = new Float32Array(totalFrames);
      let offset = 0;
      for (const chunk of capturedLeft) {
        mono.set(chunk, offset);
        offset += chunk.length;
      }
      return finalizeDecodedAudio(pcmToAudioBufferData(mono, ctx.sampleRate, 1), options);
    }

    const interleaved = new Float32Array(totalFrames * 2);
    let frameOffset = 0;
    for (let c = 0; c < capturedLeft.length; c++) {
      const l = capturedLeft[c];
      const r = capturedRight[c] ?? l;
      for (let i = 0; i < l.length; i++) {
        const idx = (frameOffset + i) * 2;
        interleaved[idx] = l[i];
        interleaved[idx + 1] = r[i];
      }
      frameOffset += l.length;
    }

    return finalizeDecodedAudio(pcmToAudioBufferData(interleaved, ctx.sampleRate, 2), options);
  } finally {
    try {
      video.pause();
      video.removeAttribute('src');
      video.load();
    } catch {
      // Ignore cleanup errors
    }
    if (mediaRecorder && mediaRecorder.state === 'recording') {
      try {
        mediaRecorder.stop();
      } catch {
        // Ignore cleanup errors
      }
    }
    sourceNode?.disconnect();
    scriptNode?.disconnect();
    gainNode?.disconnect();
    URL.revokeObjectURL(objectUrl);
    await ctx.close().catch(() => undefined);
  }
}

/**
 * Extract an audio track from a local video file (MP4, WebM, MOV, etc.) 100% client-side.
 *
 * Strategy:
 * 1. Attempt direct container decoding via `AudioContext.decodeAudioData` (fast in Chromium for MP4/WebM with AAC/Opus/MP3).
 * 2. Fall back to local `<video>` + `captureStream()` / `MediaElementAudioSourceNode` capture.
 * Never uploads media externally.
 */
export async function extractAudioFromVideoFile(
  file: File,
  options: ExtractVideoAudioOptions = {}
): Promise<AudioBufferData> {
  validateVideoFile(file, options.maxBytes ?? MAX_VIDEO_FILE_BYTES);

  // Path 1: Fast direct container decoding via AudioContext.decodeAudioData
  try {
    const buffer = await file.arrayBuffer();
    return await decodeAudioArrayBuffer(buffer, {
      filename: file.name,
      mimeType: file.type,
      mono: options.mono,
      targetSampleRate: options.targetSampleRate,
    });
  } catch (directErr) {
    // Path 2: Local <video> element fallback when direct container decode is unsupported
    try {
      return await extractViaLocalVideoElement(file, options);
    } catch (fallbackErr) {
      if (fallbackErr instanceof AudioDecodeError && fallbackErr.code === 'NO_AUDIO_TRACK') {
        throw fallbackErr;
      }
      throw new AudioDecodeError(
        'VIDEO_EXTRACT_FAILED',
        `Could not extract audio locally from "${file.name}". Your browser may not support this video/audio codec — try converting the audio to WAV or MP3 locally first.`,
        fallbackErr ?? directErr
      );
    }
  }
}
