import { useCallback, useId, useRef, useState } from 'react';
import {
  AlertCircle,
  Film,
  Loader2,
  Music,
  ShieldCheck,
  Upload,
  X,
} from 'lucide-react';
import {
  AudioDecodeError,
  SUPPORTED_AUDIO_EXTENSIONS,
  SUPPORTED_VIDEO_EXTENSIONS,
  decodeAudioFile,
  extractAudioFromVideoFile,
} from '../../audio';
import { computeSha256Hex } from '../../storage/modelCache';
import type { AudioBufferData, ReferenceClipMetadata } from '../../types';

export interface ReferenceUploaderClipResult {
  audio: AudioBufferData;
  metadata: ReferenceClipMetadata;
  extractedFromVideo: boolean;
}

export interface ReferenceUploaderProps {
  onClipsAdded: (clips: ReferenceUploaderClipResult[]) => void;
  disabled?: boolean;
  compact?: boolean;
}

const ALL_ACCEPT = [
  ...SUPPORTED_AUDIO_EXTENSIONS,
  ...SUPPORTED_VIDEO_EXTENSIONS,
  'audio/*',
  'video/*',
].join(',');

function getFileExtension(name: string): string {
  const idx = name.lastIndexOf('.');
  return idx >= 0 ? name.slice(idx).toLowerCase() : '';
}

function isVideoFile(file: File): boolean {
  const ext = getFileExtension(file.name);
  if ((SUPPORTED_VIDEO_EXTENSIONS as readonly string[]).includes(ext)) {
    return true;
  }
  return file.type.toLowerCase().startsWith('video/');
}

function createClipId(): string {
  if (typeof crypto !== 'undefined' && typeof crypto.randomUUID === 'function') {
    return crypto.randomUUID();
  }
  return `clip-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
}

async function computePcmSha256(samples: Float32Array): Promise<string> {
  const slice = samples.buffer.slice(
    samples.byteOffset,
    samples.byteOffset + samples.byteLength
  ) as ArrayBuffer;
  return await computeSha256Hex(slice);
}

export function ReferenceUploader({
  onClipsAdded,
  disabled = false,
  compact = false,
}: ReferenceUploaderProps) {
  const inputId = useId();
  const inputRef = useRef<HTMLInputElement | null>(null);
  const abortControllerRef = useRef<AbortController | null>(null);

  const [isDragging, setIsDragging] = useState(false);
  const [processingLabel, setProcessingLabel] = useState<string | null>(null);
  const [errorMessage, setErrorMessage] = useState<string | null>(null);

  const handleCancelProcessing = useCallback(() => {
    abortControllerRef.current?.abort();
  }, []);

  const processFiles = useCallback(
    async (fileList: FileList | File[]) => {
      const files = Array.from(fileList);
      if (files.length === 0 || disabled) return;

      setErrorMessage(null);
      const controller = new AbortController();
      abortControllerRef.current = controller;

      const added: ReferenceUploaderClipResult[] = [];
      const errors: string[] = [];

      try {
        for (const file of files) {
          if (controller.signal.aborted) break;
          const isVideo = isVideoFile(file);
          setProcessingLabel(
            isVideo
              ? `Extracting audio locally from video "${file.name}"...`
              : `Decoding "${file.name}" locally...`
          );

          try {
            const audio = isVideo
              ? await extractAudioFromVideoFile(file, { signal: controller.signal })
              : await decodeAudioFile(file);

            const pcmSha256 = await computePcmSha256(audio.samples);
            const metadata: ReferenceClipMetadata = {
              clipId: createClipId(),
              filename: file.name,
              mimeType: file.type || (isVideo ? 'video/mp4' : 'audio/wav'),
              source: 'file-upload',
              durationSec: audio.durationSec,
              sampleRate: audio.sampleRate,
              channels: audio.channels,
              pcmSha256,
              capturedAt: new Date().toISOString(),
            };

            added.push({
              audio,
              metadata,
              extractedFromVideo: isVideo,
            });
          } catch (err) {
            if (
              err instanceof AudioDecodeError &&
              err.message.toLowerCase().includes('cancelled')
            ) {
              errors.push(`Cancelled processing "${file.name}".`);
            } else {
              const msg = err instanceof Error ? err.message : String(err);
              errors.push(`${file.name}: ${msg}`);
            }
          }
        }

        if (added.length > 0) {
          onClipsAdded(added);
        }
        if (errors.length > 0) {
          setErrorMessage(errors.join(' '));
        }
      } finally {
        abortControllerRef.current = null;
        setProcessingLabel(null);
      }
    },
    [disabled, onClipsAdded]
  );

  const handleDrop = useCallback(
    (e: React.DragEvent<HTMLDivElement>) => {
      e.preventDefault();
      e.stopPropagation();
      setIsDragging(false);
      if (disabled || processingLabel) return;
      if (e.dataTransfer.files && e.dataTransfer.files.length > 0) {
        void processFiles(e.dataTransfer.files);
      }
    },
    [disabled, processingLabel, processFiles]
  );

  const handleDragOver = useCallback(
    (e: React.DragEvent<HTMLDivElement>) => {
      e.preventDefault();
      e.stopPropagation();
      if (!disabled && !processingLabel) {
        setIsDragging(true);
      }
    },
    [disabled, processingLabel]
  );

  const handleDragLeave = useCallback((e: React.DragEvent<HTMLDivElement>) => {
    e.preventDefault();
    e.stopPropagation();
    setIsDragging(false);
  }, []);

  const handleFileChange = useCallback(
    (e: React.ChangeEvent<HTMLInputElement>) => {
      const files = e.target.files;
      if (files && files.length > 0) {
        void processFiles(files);
      }
      e.target.value = '';
    },
    [processFiles]
  );

  return (
    <div className="space-y-3">
      <div
        onDrop={handleDrop}
        onDragOver={handleDragOver}
        onDragLeave={handleDragLeave}
        className={`relative rounded-xl border-2 border-dashed transition-colors ${
          compact ? 'p-4' : 'p-6'
        } ${
          isDragging
            ? 'border-[#7C5CFF] bg-[#7C5CFF]/10'
            : 'border-slate-300 dark:border-slate-700/80 bg-slate-50/80 dark:bg-[#0B0D12]/60 hover:border-slate-400 dark:hover:border-slate-600'
        } ${disabled ? 'opacity-60 pointer-events-none' : ''}`}
      >
        <input
          ref={inputRef}
          id={inputId}
          type="file"
          accept={ALL_ACCEPT}
          multiple
          onChange={handleFileChange}
          disabled={disabled || Boolean(processingLabel)}
          className="sr-only"
        />

        {processingLabel ? (
          <div className="flex flex-col items-center justify-center gap-3 py-2 text-center">
            <Loader2 className="h-7 w-7 animate-spin text-[#7C5CFF]" />
            <p className="text-sm font-medium text-slate-800 dark:text-slate-200">
              {processingLabel}
            </p>
            <button
              type="button"
              onClick={handleCancelProcessing}
              className="inline-flex items-center gap-1.5 rounded-lg border border-slate-300 dark:border-slate-700 px-3 py-1.5 text-xs font-medium text-slate-700 dark:text-slate-300 hover:bg-slate-200/70 dark:hover:bg-slate-800"
            >
              <X className="h-3.5 w-3.5" />
              Cancel
            </button>
          </div>
        ) : (
          <div className="flex flex-col items-center text-center gap-3">
            <div className="h-11 w-11 rounded-xl bg-[#7C5CFF]/15 border border-[#7C5CFF]/30 flex items-center justify-center text-[#7C5CFF]">
              <Upload className="h-5 w-5" />
            </div>
            <div className="space-y-1">
              <p className="text-sm font-medium text-slate-900 dark:text-slate-100">
                Drop reference audio or video files here
              </p>
              <p className="text-xs text-slate-500 dark:text-slate-400">
                Or{' '}
                <label
                  htmlFor={inputId}
                  className="cursor-pointer font-semibold text-[#7C5CFF] hover:underline"
                >
                  browse from your device
                </label>{' '}
                (you can add multiple authorized clips)
              </p>
            </div>

            <div className="flex flex-wrap items-center justify-center gap-2 text-[11px] text-slate-600 dark:text-slate-400">
              <span className="inline-flex items-center gap-1 rounded-md bg-slate-200/70 dark:bg-slate-800/80 px-2 py-0.5">
                <Music className="h-3 w-3 text-[#7C5CFF]" />
                WAV, MP3, M4A, FLAC, OGG
              </span>
              <span className="inline-flex items-center gap-1 rounded-md bg-slate-200/70 dark:bg-slate-800/80 px-2 py-0.5">
                <Film className="h-3 w-3 text-emerald-500" />
                MP4, WebM, MOV (local audio extract)
              </span>
            </div>

            <p className="inline-flex items-center gap-1.5 text-[11px] text-emerald-700 dark:text-emerald-400">
              <ShieldCheck className="h-3.5 w-3.5 shrink-0" />
              Decoded 100% locally in your browser — nothing is uploaded.
            </p>
          </div>
        )}
      </div>

      {errorMessage && (
        <div
          role="alert"
          className="flex items-start gap-2.5 rounded-lg border border-rose-500/30 bg-rose-500/10 p-3 text-xs text-rose-700 dark:text-rose-200"
        >
          <AlertCircle className="h-4 w-4 shrink-0 mt-0.5 text-rose-500" />
          <div className="flex-1">{errorMessage}</div>
          <button
            type="button"
            onClick={() => setErrorMessage(null)}
            aria-label="Dismiss upload error"
            className="text-rose-500 hover:text-rose-400"
          >
            <X className="h-3.5 w-3.5" />
          </button>
        </div>
      )}
    </div>
  );
}
