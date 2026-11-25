import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { Download, Loader2, Pause, Play, RotateCcw, Scissors, SlidersHorizontal } from 'lucide-react';
import { exportAudio } from '../../audio';
import { useAppStore } from '../../stores/appStore';
import type { AudioBufferData } from '../../types';
import { triggerBrowserDownload } from '../studio/studioHelpers';

export interface WaveformPlayerProps {
  samples: Float32Array | null;
  sampleRate: number;
  title?: string;
  height?: number;
  trimStartSec?: number;
  trimEndSec?: number;
  onTrimChange?: (startSec: number, endSec: number) => void;
  compact?: boolean;
  className?: string;
  showDownload?: boolean;
  downloadFilename?: string;
  onOpenExportModal?: () => void;
}

function formatTimecode(seconds: number): string {
  if (!Number.isFinite(seconds) || seconds < 0) return '00:00.0';
  const totalTenths = Math.floor(seconds * 10 + 0.0001);
  const tenths = totalTenths % 10;
  const totalSeconds = Math.floor(totalTenths / 10);
  const mins = Math.floor(totalSeconds / 60);
  const secs = totalSeconds % 60;
  return `${String(mins).padStart(2, '0')}:${String(secs).padStart(2, '0')}.${tenths}`;
}

function clamp(value: number, min: number, max: number): number {
  return Math.min(max, Math.max(min, value));
}

function readCssToken(styles: CSSStyleDeclaration, token: string, fallback: string): string {
  const val = styles.getPropertyValue(token).trim();
  return val || fallback;
}

export function WaveformPlayer({
  samples,
  sampleRate,
  title,
  height,
  trimStartSec,
  trimEndSec,
  onTrimChange,
  compact = false,
  className = '',
  showDownload = true,
  downloadFilename,
  onOpenExportModal,
}: WaveformPlayerProps) {
  const theme = useAppStore((s) => s.theme);
  const containerRef = useRef<HTMLDivElement | null>(null);
  const canvasRef = useRef<HTMLCanvasElement | null>(null);

  const audioCtxRef = useRef<AudioContext | null>(null);
  const sourceRef = useRef<AudioBufferSourceNode | null>(null);
  const rafRef = useRef<number | null>(null);
  const playOriginCtxTimeRef = useRef<number>(0);
  const playOriginOffsetSecRef = useRef<number>(0);
  const playStopAtSecRef = useRef<number>(0);
  const isPlayingRef = useRef<boolean>(false);
  const dragModeRef = useRef<'scrub' | 'trim-start' | 'trim-end' | null>(null);

  const [containerWidth, setContainerWidth] = useState<number>(480);
  const [isPlaying, setIsPlaying] = useState<boolean>(false);
  const [currentTimeSec, setCurrentTimeSec] = useState<number>(0);
  const [trackedSamples, setTrackedSamples] = useState<Float32Array | null>(samples);
  const [trackedSampleRate, setTrackedSampleRate] = useState<number>(sampleRate);
  const [downloadingFormat, setDownloadingFormat] = useState<'wav' | 'mp3' | null>(null);
  const [downloadError, setDownloadError] = useState<string | null>(null);

  if (samples !== trackedSamples || sampleRate !== trackedSampleRate) {
    setTrackedSamples(samples);
    setTrackedSampleRate(sampleRate);
    setIsPlaying(false);
    setCurrentTimeSec(0);
  }

  const canvasHeight = height ?? (compact ? 64 : 96);
  const durationSec = useMemo(() => {
    if (!samples || samples.length === 0 || sampleRate <= 0) return 0;
    return samples.length / sampleRate;
  }, [samples, sampleRate]);

  const clampedTimeSec = clamp(currentTimeSec, 0, durationSec);

  const hasTrim =
    durationSec > 0 &&
    (trimStartSec !== undefined || trimEndSec !== undefined || onTrimChange !== undefined);

  const effectiveTrimStart = useMemo(() => {
    if (!hasTrim) return 0;
    return clamp(trimStartSec ?? 0, 0, durationSec);
  }, [hasTrim, trimStartSec, durationSec]);

  const effectiveTrimEnd = useMemo(() => {
    if (!hasTrim) return durationSec;
    const rawEnd = trimEndSec ?? durationSec;
    return clamp(rawEnd, effectiveTrimStart, durationSec);
  }, [hasTrim, trimEndSec, effectiveTrimStart, durationSec]);

  const stopAudioNodes = useCallback(() => {
    isPlayingRef.current = false;
    if (rafRef.current !== null) {
      cancelAnimationFrame(rafRef.current);
      rafRef.current = null;
    }
    const source = sourceRef.current;
    if (source) {
      source.onended = null;
      try {
        source.stop();
      } catch {
        // Ignore already-stopped source errors.
      }
      try {
        source.disconnect();
      } catch {
        // Ignore disconnect errors.
      }
      sourceRef.current = null;
    }
  }, []);

  const stopPlayback = useCallback(
    (preservePosition = true) => {
      stopAudioNodes();
      setIsPlaying(false);
      if (!preservePosition) {
        setCurrentTimeSec(0);
      }
    },
    [stopAudioNodes]
  );

  // Stop active audio nodes whenever source buffer changes or on unmount
  useEffect(() => {
    return () => {
      stopAudioNodes();
    };
  }, [samples, sampleRate, stopAudioNodes]);

  // Dispose AudioContext on unmount
  useEffect(() => {
    return () => {
      stopAudioNodes();
      if (audioCtxRef.current) {
        audioCtxRef.current.close().catch(() => undefined);
        audioCtxRef.current = null;
      }
    };
  }, [stopAudioNodes]);

  // Measure container width with ResizeObserver for crisp high-DPI canvas
  useEffect(() => {
    const el = containerRef.current;
    if (!el) return;

    const updateWidth = () => {
      const next = Math.max(120, Math.floor(el.getBoundingClientRect().width));
      setContainerWidth(next);
    };
    updateWidth();

    if (typeof ResizeObserver === 'undefined') return;
    const observer = new ResizeObserver(updateWidth);
    observer.observe(el);
    return () => observer.disconnect();
  }, []);

  const startPlaybackAt = useCallback(
    async (offsetSec: number) => {
      if (!samples || samples.length === 0 || sampleRate <= 0 || durationSec <= 0) {
        return;
      }

      stopPlayback(true);

      const AudioContextCtor =
        window.AudioContext ||
        (window as unknown as { webkitAudioContext?: typeof AudioContext }).webkitAudioContext;
      if (!AudioContextCtor) return;

      if (!audioCtxRef.current || audioCtxRef.current.state === 'closed') {
        audioCtxRef.current = new AudioContextCtor();
      }
      const ctx = audioCtxRef.current;
      if (ctx.state === 'suspended') {
        await ctx.resume();
      }

      const buffer = ctx.createBuffer(1, samples.length, sampleRate);
      buffer.getChannelData(0).set(samples);

      const source = ctx.createBufferSource();
      source.buffer = buffer;
      source.connect(ctx.destination);

      const rangeStart = hasTrim ? effectiveTrimStart : 0;
      const rangeEnd = hasTrim ? effectiveTrimEnd : durationSec;
      const clampedStart =
        offsetSec < rangeStart || offsetSec >= rangeEnd - 0.02
          ? rangeStart
          : offsetSec;
      const playDuration = Math.max(0.01, rangeEnd - clampedStart);

      sourceRef.current = source;
      playOriginCtxTimeRef.current = ctx.currentTime;
      playOriginOffsetSecRef.current = clampedStart;
      playStopAtSecRef.current = rangeEnd;
      isPlayingRef.current = true;
      setIsPlaying(true);
      setCurrentTimeSec(clampedStart);

      source.onended = () => {
        if (!isPlayingRef.current) return;
        isPlayingRef.current = false;
        setIsPlaying(false);
        if (rafRef.current !== null) {
          cancelAnimationFrame(rafRef.current);
          rafRef.current = null;
        }
        sourceRef.current = null;
        setCurrentTimeSec(rangeStart);
      };

      const tick = () => {
        if (!isPlayingRef.current || !audioCtxRef.current) return;
        const elapsed = audioCtxRef.current.currentTime - playOriginCtxTimeRef.current;
        const pos = Math.min(
          playStopAtSecRef.current,
          playOriginOffsetSecRef.current + elapsed
        );
        setCurrentTimeSec(pos);
        if (pos < playStopAtSecRef.current) {
          rafRef.current = requestAnimationFrame(tick);
        }
      };
      rafRef.current = requestAnimationFrame(tick);

      source.start(0, clampedStart, playDuration);
    },
    [samples, sampleRate, durationSec, hasTrim, effectiveTrimStart, effectiveTrimEnd, stopPlayback]
  );

  const togglePlay = useCallback(() => {
    if (isPlayingRef.current) {
      if (audioCtxRef.current) {
        const elapsed = audioCtxRef.current.currentTime - playOriginCtxTimeRef.current;
        const pausedPos = clamp(
          playOriginOffsetSecRef.current + elapsed,
          0,
          durationSec
        );
        stopPlayback(true);
        setCurrentTimeSec(pausedPos);
      } else {
        stopPlayback(true);
      }
      return;
    }
    void startPlaybackAt(clampedTimeSec);
  }, [clampedTimeSec, durationSec, startPlaybackAt, stopPlayback]);

  const handleReset = useCallback(() => {
    stopPlayback(true);
    setCurrentTimeSec(hasTrim ? effectiveTrimStart : 0);
  }, [stopPlayback, hasTrim, effectiveTrimStart]);

  // Precompute waveform envelope bars for current width
  const barPeaks = useMemo(() => {
    const pitch = 3; // 2px bar + 1px gap
    const barCount = Math.max(1, Math.floor(containerWidth / pitch));
    const peaks = new Float32Array(barCount * 2); // [min, max] pairs

    if (!samples || samples.length === 0) {
      return { barCount, pitch, peaks };
    }

    const samplesPerBar = samples.length / barCount;
    for (let i = 0; i < barCount; i += 1) {
      const start = Math.floor(i * samplesPerBar);
      const end = Math.min(samples.length, Math.max(start + 1, Math.floor((i + 1) * samplesPerBar)));
      const step = Math.max(1, Math.floor((end - start) / 64));
      let minVal = 1;
      let maxVal = -1;
      for (let j = start; j < end; j += step) {
        const v = samples[j];
        if (v < minVal) minVal = v;
        if (v > maxVal) maxVal = v;
      }
      if (minVal > maxVal) {
        minVal = 0;
        maxVal = 0;
      }
      peaks[i * 2] = clamp(minVal, -1, 1);
      peaks[i * 2 + 1] = clamp(maxVal, -1, 1);
    }

    return { barCount, pitch, peaks };
  }, [samples, containerWidth]);

  // Draw waveform onto high-DPI canvas using active theme CSS tokens
  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas) return;
    const ctx = canvas.getContext('2d');
    if (!ctx) return;

    const dpr = typeof window !== 'undefined' ? window.devicePixelRatio || 1 : 1;
    const width = containerWidth;
    const heightPx = canvasHeight;

    canvas.width = Math.max(1, Math.floor(width * dpr));
    canvas.height = Math.max(1, Math.floor(heightPx * dpr));
    canvas.style.width = `${width}px`;
    canvas.style.height = `${heightPx}px`;

    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    ctx.clearRect(0, 0, width, heightPx);

    const rootStyles = getComputedStyle(document.documentElement);
    const isDark = theme === 'dark';
    const bgColor = readCssToken(rootStyles, '--vf-bg', isDark ? '#111110' : '#F4F2EC');
    const centerLineColor = readCssToken(
      rootStyles,
      '--vf-border-subtle',
      isDark ? '#23221F' : '#E4E0D6'
    );
    const unplayedColor = readCssToken(rootStyles, '--vf-border', isDark ? '#2E2D29' : '#D5D0C4');
    const playedColor = readCssToken(rootStyles, '--vf-accent', isDark ? '#E25822' : '#C94514');
    const subtleTextColor = readCssToken(
      rootStyles,
      '--vf-text-subtle',
      isDark ? '#6E6B63' : '#847F74'
    );
    const trimAccentColor = readCssToken(
      rootStyles,
      '--vf-success',
      isDark ? '#2EA067' : '#1F7A4D'
    );
    const playheadColor = readCssToken(rootStyles, '--vf-text', isDark ? '#F2EFE9' : '#161513');
    const trimShadeColor = isDark ? 'rgba(10, 10, 9, 0.65)' : 'rgba(22, 21, 19, 0.14)';

    ctx.fillStyle = bgColor;
    ctx.fillRect(0, 0, width, heightPx);

    const midY = Math.round(heightPx / 2) + 0.5;
    ctx.strokeStyle = centerLineColor;
    ctx.lineWidth = 1;
    ctx.beginPath();
    ctx.moveTo(0, midY);
    ctx.lineTo(width, midY);
    ctx.stroke();

    if (!samples || samples.length === 0 || durationSec <= 0) {
      ctx.fillStyle = subtleTextColor;
      ctx.font = '11px ui-monospace, SFMono-Regular, Menlo, Monaco, Consolas, monospace';
      ctx.textAlign = 'center';
      ctx.textBaseline = 'middle';
      ctx.fillText('No audio loaded', width / 2, midY);
      return;
    }

    const playheadX = (clampedTimeSec / durationSec) * width;
    const maxAmpHalf = Math.max(4, heightPx / 2 - 8);
    const { barCount, pitch, peaks } = barPeaks;

    for (let i = 0; i < barCount; i += 1) {
      const x = i * pitch;
      const minVal = peaks[i * 2];
      const maxVal = peaks[i * 2 + 1];
      const topY = heightPx / 2 - maxVal * maxAmpHalf;
      const bottomY = heightPx / 2 - minVal * maxAmpHalf;
      const barH = Math.max(2, bottomY - topY);

      ctx.fillStyle = x <= playheadX ? playedColor : unplayedColor;
      ctx.fillRect(x, topY, 2, barH);
    }

    // Trim region overlays & handles
    if (hasTrim) {
      const startX = (effectiveTrimStart / durationSec) * width;
      const endX = (effectiveTrimEnd / durationSec) * width;

      if (startX > 0) {
        ctx.fillStyle = trimShadeColor;
        ctx.fillRect(0, 0, startX, heightPx);
      }
      if (endX < width) {
        ctx.fillStyle = trimShadeColor;
        ctx.fillRect(endX, 0, width - endX, heightPx);
      }

      ctx.strokeStyle = trimAccentColor;
      ctx.lineWidth = 1.5;

      ctx.beginPath();
      ctx.moveTo(startX, 0);
      ctx.lineTo(startX, heightPx);
      ctx.moveTo(endX, 0);
      ctx.lineTo(endX, heightPx);
      ctx.stroke();

      if (onTrimChange) {
        ctx.fillStyle = trimAccentColor;
        ctx.fillRect(Math.max(0, startX - 3), 0, 6, 10);
        ctx.fillRect(Math.min(width - 6, endX - 3), 0, 6, 10);
      }
    }

    // Playhead cursor with vermilion indicator cap
    ctx.strokeStyle = playedColor;
    ctx.lineWidth = 1.5;
    ctx.beginPath();
    ctx.moveTo(playheadX, 0);
    ctx.lineTo(playheadX, heightPx);
    ctx.stroke();

    ctx.fillStyle = playheadColor;
    ctx.fillRect(clamp(playheadX - 2, 0, width - 4), 0, 4, 5);
  }, [
    theme,
    containerWidth,
    canvasHeight,
    samples,
    durationSec,
    clampedTimeSec,
    barPeaks,
    hasTrim,
    effectiveTrimStart,
    effectiveTrimEnd,
    onTrimChange,
  ]);

  const timeFromClientX = useCallback(
    (clientX: number): number => {
      const canvas = canvasRef.current;
      if (!canvas || durationSec <= 0) return 0;
      const rect = canvas.getBoundingClientRect();
      const ratio = clamp((clientX - rect.left) / Math.max(1, rect.width), 0, 1);
      return ratio * durationSec;
    },
    [durationSec]
  );

  const handlePointerDown = (event: React.PointerEvent<HTMLCanvasElement>) => {
    if (!samples || durationSec <= 0) return;
    const canvas = canvasRef.current;
    if (!canvas) return;
    const rect = canvas.getBoundingClientRect();
    const clickX = event.clientX - rect.left;

    if (onTrimChange) {
      const startX = (effectiveTrimStart / durationSec) * rect.width;
      const endX = (effectiveTrimEnd / durationSec) * rect.width;
      const distStart = Math.abs(clickX - startX);
      const distEnd = Math.abs(clickX - endX);
      if (distStart <= 10 && distStart <= distEnd) {
        dragModeRef.current = 'trim-start';
        canvas.setPointerCapture(event.pointerId);
        return;
      }
      if (distEnd <= 10) {
        dragModeRef.current = 'trim-end';
        canvas.setPointerCapture(event.pointerId);
        return;
      }
    }

    dragModeRef.current = 'scrub';
    canvas.setPointerCapture(event.pointerId);
    const nextSec = timeFromClientX(event.clientX);
    setCurrentTimeSec(nextSec);
    if (isPlayingRef.current) {
      void startPlaybackAt(nextSec);
    }
  };

  const handlePointerMove = (event: React.PointerEvent<HTMLCanvasElement>) => {
    const mode = dragModeRef.current;
    if (!mode || durationSec <= 0) return;

    const sec = timeFromClientX(event.clientX);
    const minGap = Math.min(0.1, durationSec * 0.05);

    if (mode === 'trim-start' && onTrimChange) {
      const clampedStart = clamp(sec, 0, Math.max(0, effectiveTrimEnd - minGap));
      onTrimChange(Number(clampedStart.toFixed(2)), Number(effectiveTrimEnd.toFixed(2)));
    } else if (mode === 'trim-end' && onTrimChange) {
      const clampedEnd = clamp(sec, Math.min(durationSec, effectiveTrimStart + minGap), durationSec);
      onTrimChange(Number(effectiveTrimStart.toFixed(2)), Number(clampedEnd.toFixed(2)));
    } else if (mode === 'scrub') {
      setCurrentTimeSec(sec);
    }
  };

  const handlePointerUp = (event: React.PointerEvent<HTMLCanvasElement>) => {
    const mode = dragModeRef.current;
    if (!mode) return;
    dragModeRef.current = null;
    try {
      canvasRef.current?.releasePointerCapture(event.pointerId);
    } catch {
      // Ignore release failures.
    }
    if (mode === 'scrub' && isPlayingRef.current) {
      void startPlaybackAt(timeFromClientX(event.clientX));
    }
  };

  const disabled = !samples || samples.length === 0 || durationSec <= 0;

  const handleQuickDownload = (format: 'wav16' | 'mp3_192') => {
    if (!samples || samples.length === 0 || sampleRate <= 0 || downloadingFormat !== null) {
      return;
    }
    const kind = format === 'wav16' ? 'wav' : 'mp3';
    setDownloadingFormat(kind);
    setDownloadError(null);

    window.setTimeout(() => {
      try {
        const safeBaseName =
          (downloadFilename ?? title ?? 'voiceforge-audio')
            .trim()
            .replace(/[^a-zA-Z0-9._-]+/g, '_') || 'voiceforge-audio';

        const audioData: AudioBufferData = {
          samples,
          sampleRate,
          channels: 1,
          durationSec: samples.length / sampleRate,
        };

        const result = exportAudio(audioData, {
          format,
          sampleRate: 'native',
          channels: 'mono',
          applyMastering: false,
          normalizeOutput: false,
          filename: safeBaseName,
          metadata: {
            title: title || safeBaseName,
            artist: 'VoiceForge Studio',
          },
        });

        triggerBrowserDownload(result.bytes, result.mimeType, result.filename);
      } catch (err) {
        setDownloadError(err instanceof Error ? err.message : String(err));
      } finally {
        setDownloadingFormat(null);
      }
    }, 0);
  };

  return (
    <div
      className={`rounded-lg border border-[var(--vf-border)] bg-[var(--vf-surface)] ${
        compact ? 'p-2.5' : 'p-3.5'
      } ${className}`}
    >
      {(title || hasTrim) && (
        <div className="flex items-center justify-between gap-2 mb-2 text-xs">
          <span className="font-medium text-[var(--vf-text)] truncate">
            {title ?? 'Audio Waveform'}
          </span>
          {hasTrim && (
            <span className="inline-flex items-center gap-1 text-[11px] font-mono tabular-nums text-[var(--vf-success)] shrink-0">
              <Scissors className="h-3 w-3" />
              <span>
                {formatTimecode(effectiveTrimStart)} – {formatTimecode(effectiveTrimEnd)}
              </span>
            </span>
          )}
        </div>
      )}

      <div
        ref={containerRef}
        className="w-full overflow-hidden rounded-md border border-[var(--vf-border-subtle)] bg-[var(--vf-bg)]"
      >
        <canvas
          ref={canvasRef}
          onPointerDown={handlePointerDown}
          onPointerMove={handlePointerMove}
          onPointerUp={handlePointerUp}
          onPointerCancel={handlePointerUp}
          className={`block w-full touch-none ${
            disabled ? 'cursor-default' : onTrimChange ? 'cursor-ew-resize' : 'cursor-pointer'
          }`}
          aria-label={title ? `${title} waveform` : 'Audio waveform'}
        />
      </div>

      <div className={`flex flex-wrap items-center justify-between gap-2.5 ${compact ? 'mt-2' : 'mt-2.5'}`}>
        <div className="flex flex-wrap items-center gap-1.5">
          <button
            type="button"
            disabled={disabled}
            onClick={togglePlay}
            className={`inline-flex items-center justify-center rounded-md font-medium transition-colors cursor-pointer disabled:opacity-40 disabled:cursor-not-allowed ${
              compact ? 'h-7 px-2.5 text-xs' : 'h-8 px-3 text-xs'
            } bg-[var(--vf-accent)] hover:bg-[var(--vf-accent-hover)] text-white`}
            aria-label={isPlaying ? 'Pause playback' : 'Play audio'}
          >
            {isPlaying ? <Pause className="h-3.5 w-3.5" /> : <Play className="h-3.5 w-3.5" />}
            {!compact && <span className="ml-1.5">{isPlaying ? 'Pause' : 'Play'}</span>}
          </button>

          <button
            type="button"
            disabled={disabled}
            onClick={handleReset}
            className={`inline-flex items-center justify-center rounded-md border border-[var(--vf-border)] bg-[var(--vf-surface-elevated)] text-[var(--vf-text-muted)] hover:text-[var(--vf-text)] transition-colors cursor-pointer disabled:opacity-40 disabled:cursor-not-allowed ${
              compact ? 'h-7 w-7' : 'h-8 w-8'
            }`}
            aria-label="Reset playhead"
            title="Reset playhead"
          >
            <RotateCcw className="h-3.5 w-3.5" />
          </button>

          {showDownload && !disabled && (
            <>
              <button
                type="button"
                disabled={downloadingFormat !== null}
                onClick={() => handleQuickDownload('wav16')}
                className={`inline-flex items-center justify-center gap-1.5 rounded-md border border-[var(--vf-success)]/40 bg-[var(--vf-success)]/10 text-[var(--vf-success)] hover:bg-[var(--vf-success)]/20 font-medium transition-colors cursor-pointer disabled:opacity-50 disabled:cursor-not-allowed ${
                  compact ? 'h-7 px-2 text-[11px]' : 'h-8 px-2.5 text-xs'
                }`}
                aria-label="Download WAV"
                title="Download 16-bit WAV audio"
              >
                {downloadingFormat === 'wav' ? (
                  <Loader2 className="h-3.5 w-3.5 animate-spin" />
                ) : (
                  <Download className="h-3.5 w-3.5" />
                )}
                <span>{compact ? 'WAV' : 'Download WAV'}</span>
              </button>

              <button
                type="button"
                disabled={downloadingFormat !== null}
                onClick={() => handleQuickDownload('mp3_192')}
                className={`inline-flex items-center justify-center gap-1.5 rounded-md border border-[var(--vf-border)] bg-[var(--vf-surface-elevated)] text-[var(--vf-text-muted)] hover:text-[var(--vf-text)] font-medium transition-colors cursor-pointer disabled:opacity-50 disabled:cursor-not-allowed ${
                  compact ? 'h-7 px-2 text-[11px]' : 'h-8 px-2.5 text-xs'
                }`}
                aria-label="Download MP3"
                title="Download 192 kbps MP3 audio"
              >
                {downloadingFormat === 'mp3' ? (
                  <Loader2 className="h-3.5 w-3.5 animate-spin" />
                ) : (
                  <Download className="h-3.5 w-3.5" />
                )}
                <span>{compact ? 'MP3' : 'Download MP3'}</span>
              </button>

              {onOpenExportModal && (
                <button
                  type="button"
                  onClick={onOpenExportModal}
                  className={`inline-flex items-center justify-center gap-1.5 rounded-md border border-[var(--vf-border)] bg-[var(--vf-surface-elevated)] text-[var(--vf-text-muted)] hover:text-[var(--vf-text)] font-medium transition-colors cursor-pointer ${
                    compact ? 'h-7 px-2 text-[11px]' : 'h-8 px-2.5 text-xs'
                  }`}
                  aria-label="Export Options"
                  title="More formats, 24-bit WAV, ZIP & SRT captions"
                >
                  <SlidersHorizontal className="h-3.5 w-3.5" />
                  <span>{compact ? 'Options' : 'Export Options'}</span>
                </button>
              )}
            </>
          )}
        </div>

        <div className="flex items-center gap-2 text-xs font-mono tabular-nums text-[var(--vf-text-muted)]">
          <span>
            {formatTimecode(clampedTimeSec)} / {formatTimecode(durationSec)}
          </span>
          {sampleRate > 0 && !compact && (
            <span className="hidden sm:inline text-[11px] text-[var(--vf-text-subtle)]">
              • {(sampleRate / 1000).toFixed(1)} kHz
            </span>
          )}
        </div>
      </div>

      {downloadError && (
        <p className="mt-2 text-xs text-[var(--vf-danger)]" role="alert">
          Download failed: {downloadError}
        </p>
      )}
    </div>
  );
}
