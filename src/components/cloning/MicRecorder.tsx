import { useCallback, useEffect, useRef, useState } from 'react';
import {
  AlertCircle,
  CheckCircle2,
  Mic,
  Square,
  Volume2,
  Waves,
} from 'lucide-react';
import { pcmToAudioBufferData } from '../../audio';
import { computeSha256Hex } from '../../storage/modelCache';
import type { AudioBufferData, ReferenceClipMetadata } from '../../types';

export interface MicRecorderResult {
  audio: AudioBufferData;
  metadata: ReferenceClipMetadata;
}

export interface MicRecorderProps {
  onClipRecorded: (clip: MicRecorderResult) => void;
  minRecommendedSec?: number;
  maxRecommendedSec?: number;
  disabled?: boolean;
}

const SAMPLE_PROMPTS = [
  'The quick brown fox jumps over the lazy dog while clear autumn light spills across the quiet studio.',
  'In local synthesis, every waveform stays on your device, giving creators full control over privacy and quality.',
  'Numbers like twenty-four, dates like November twenty-fifth, and crisp pauses help capture natural vocal cadence.',
];

function createClipId(): string {
  if (typeof crypto !== 'undefined' && typeof crypto.randomUUID === 'function') {
    return crypto.randomUUID();
  }
  return `mic-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
}

function formatTimer(seconds: number): string {
  const mins = Math.floor(seconds / 60);
  const secs = Math.floor(seconds % 60);
  const tenths = Math.floor((seconds * 10) % 10);
  return `${String(mins).padStart(2, '0')}:${String(secs).padStart(2, '0')}.${tenths}`;
}

function linearToDb(val: number): number {
  if (!Number.isFinite(val) || val <= 0) return -90;
  return Math.max(-90, 20 * Math.log10(val));
}

export function MicRecorder({
  onClipRecorded,
  minRecommendedSec = 5,
  maxRecommendedSec = 10,
  disabled = false,
}: MicRecorderProps) {
  const [isRecording, setIsRecording] = useState(false);
  const [elapsedSec, setElapsedSec] = useState(0);
  const [rmsDb, setRmsDb] = useState(-90);
  const [peakDb, setPeakDb] = useState(-90);
  const [clippedEver, setClippedEver] = useState(false);
  const [echoCancellation, setEchoCancellation] = useState(true);
  const [promptIndex, setPromptIndex] = useState(0);
  const [errorMessage, setErrorMessage] = useState<string | null>(null);
  const [isFinalizing, setIsFinalizing] = useState(false);

  const streamRef = useRef<MediaStream | null>(null);
  const audioCtxRef = useRef<AudioContext | null>(null);
  const sourceRef = useRef<MediaStreamAudioSourceNode | null>(null);
  const analyserRef = useRef<AnalyserNode | null>(null);
  const processorRef = useRef<ScriptProcessorNode | null>(null);
  const gainRef = useRef<GainNode | null>(null);
  const chunksRef = useRef<Float32Array[]>([]);
  const sampleRateRef = useRef<number>(48000);
  const startTimeRef = useRef<number>(0);
  const rafRef = useRef<number | null>(null);

  const cleanupAudioGraph = useCallback(async () => {
    if (rafRef.current !== null) {
      cancelAnimationFrame(rafRef.current);
      rafRef.current = null;
    }
    try {
      processorRef.current?.disconnect();
    } catch {
      // Ignore cleanup errors
    }
    try {
      analyserRef.current?.disconnect();
    } catch {
      // Ignore cleanup errors
    }
    try {
      sourceRef.current?.disconnect();
    } catch {
      // Ignore cleanup errors
    }
    try {
      gainRef.current?.disconnect();
    } catch {
      // Ignore cleanup errors
    }
    processorRef.current = null;
    analyserRef.current = null;
    sourceRef.current = null;
    gainRef.current = null;

    if (streamRef.current) {
      for (const track of streamRef.current.getTracks()) {
        track.stop();
      }
      streamRef.current = null;
    }

    if (audioCtxRef.current) {
      await audioCtxRef.current.close().catch(() => undefined);
      audioCtxRef.current = null;
    }
  }, []);

  useEffect(() => {
    return () => {
      void cleanupAudioGraph();
    };
  }, [cleanupAudioGraph]);

  const stopRecording = useCallback(async () => {
    if (!isRecording) return;
    setIsRecording(false);
    setIsFinalizing(true);

    const capturedChunks = chunksRef.current;
    const sampleRate = sampleRateRef.current;
    chunksRef.current = [];

    await cleanupAudioGraph();

    try {
      const totalSamples = capturedChunks.reduce((sum, arr) => sum + arr.length, 0);
      if (totalSamples < Math.max(1, Math.round(sampleRate * 0.25))) {
        setErrorMessage('Recording was too short (< 0.25s). Please record a longer speech sample.');
        return;
      }

      const merged = new Float32Array(totalSamples);
      let offset = 0;
      for (const chunk of capturedChunks) {
        merged.set(chunk, offset);
        offset += chunk.length;
      }

      const audio = pcmToAudioBufferData(merged, sampleRate, 1);
      const bufferCopy = audio.samples.buffer.slice(
        audio.samples.byteOffset,
        audio.samples.byteOffset + audio.samples.byteLength
      ) as ArrayBuffer;
      const pcmSha256 = await computeSha256Hex(bufferCopy);

      const stamp = new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19);
      const metadata: ReferenceClipMetadata = {
        clipId: createClipId(),
        filename: `mic-recording-${stamp}.wav`,
        mimeType: 'audio/pcm',
        source: 'microphone',
        durationSec: audio.durationSec,
        sampleRate: audio.sampleRate,
        channels: 1,
        pcmSha256,
        capturedAt: new Date().toISOString(),
      };

      onClipRecorded({ audio, metadata });
    } catch (err) {
      setErrorMessage(err instanceof Error ? err.message : String(err));
    } finally {
      setIsFinalizing(false);
      setRmsDb(-90);
      setPeakDb(-90);
    }
  }, [cleanupAudioGraph, isRecording, onClipRecorded]);

  const startRecording = useCallback(async () => {
    if (disabled || isRecording || isFinalizing) return;
    setErrorMessage(null);

    if (
      typeof navigator === 'undefined' ||
      !navigator.mediaDevices ||
      typeof navigator.mediaDevices.getUserMedia !== 'function'
    ) {
      setErrorMessage(
        'Microphone capture (navigator.mediaDevices.getUserMedia) is unavailable in this browser or context.'
      );
      return;
    }

    const AudioCtx =
      window.AudioContext ||
      (window as unknown as { webkitAudioContext?: typeof AudioContext }).webkitAudioContext;
    if (!AudioCtx) {
      setErrorMessage('Web Audio API (AudioContext) is unavailable in this browser.');
      return;
    }

    try {
      const stream = await navigator.mediaDevices.getUserMedia({
        audio: {
          channelCount: 1,
          echoCancellation,
          noiseSuppression: false,
          autoGainControl: false,
        },
      });
      streamRef.current = stream;

      const ctx = new AudioCtx();
      audioCtxRef.current = ctx;
      if (ctx.state === 'suspended') {
        await ctx.resume();
      }
      sampleRateRef.current = ctx.sampleRate;

      const source = ctx.createMediaStreamSource(stream);
      sourceRef.current = source;

      const analyser = ctx.createAnalyser();
      analyser.fftSize = 1024;
      analyser.smoothingTimeConstant = 0.3;
      analyserRef.current = analyser;

      const processor = ctx.createScriptProcessor(4096, 1, 1);
      processorRef.current = processor;

      const silentGain = ctx.createGain();
      silentGain.gain.value = 0;
      gainRef.current = silentGain;

      chunksRef.current = [];
      setElapsedSec(0);
      setClippedEver(false);
      setRmsDb(-90);
      setPeakDb(-90);
      startTimeRef.current = performance.now();

      processor.onaudioprocess = (event) => {
        const input = event.inputBuffer.getChannelData(0);
        chunksRef.current.push(new Float32Array(input));
      };

      source.connect(analyser);
      analyser.connect(processor);
      processor.connect(silentGain);
      silentGain.connect(ctx.destination);

      setIsRecording(true);

      const timeData = new Float32Array(analyser.fftSize);
      const updateMeter = () => {
        if (!analyserRef.current) return;
        analyserRef.current.getFloatTimeDomainData(timeData);

        let sumSq = 0;
        let peak = 0;
        for (let i = 0; i < timeData.length; i += 1) {
          const v = timeData[i];
          const abs = Math.abs(v);
          sumSq += v * v;
          if (abs > peak) peak = abs;
        }
        const rms = Math.sqrt(sumSq / timeData.length);
        setRmsDb(linearToDb(rms));
        setPeakDb(linearToDb(peak));
        if (peak >= 0.99) {
          setClippedEver(true);
        }

        const elapsed = (performance.now() - startTimeRef.current) / 1000;
        setElapsedSec(elapsed);
        rafRef.current = requestAnimationFrame(updateMeter);
      };

      rafRef.current = requestAnimationFrame(updateMeter);
    } catch (err) {
      await cleanupAudioGraph();
      const msg = err instanceof Error ? err.message : String(err);
      setErrorMessage(`Microphone access failed: ${msg}`);
    }
  }, [cleanupAudioGraph, disabled, echoCancellation, isFinalizing, isRecording]);

  // Normalize meter to 0..100% across -60 dBFS .. 0 dBFS
  const meterPercent = Math.max(0, Math.min(100, ((rmsDb + 60) / 60) * 100));
  const peakPercent = Math.max(0, Math.min(100, ((peakDb + 60) / 60) * 100));

  const levelBadge =
    rmsDb >= -4 || clippedEver
      ? {
          label: 'Hot / Clipping Risk',
          cls: 'text-[var(--vf-danger)] bg-[var(--vf-danger)]/15 border-[var(--vf-danger)]/35',
        }
      : rmsDb >= -28
        ? {
            label: 'Healthy Level',
            cls: 'text-[var(--vf-success)] bg-[var(--vf-success)]/15 border-[var(--vf-success)]/35',
          }
        : {
            label: 'Quiet Input',
            cls: 'text-[var(--vf-warning)] bg-[var(--vf-warning)]/15 border-[var(--vf-warning)]/35',
          };

  return (
    <div className="rounded-lg border border-[var(--vf-border)] bg-[var(--vf-bg)] p-4 space-y-4">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div className="flex items-center gap-2.5">
          <div
            className={`h-9 w-9 rounded-md flex items-center justify-center border ${
              isRecording
                ? 'bg-[var(--vf-danger)]/15 border-[var(--vf-danger)]/45 text-[var(--vf-danger)] animate-pulse'
                : 'bg-[var(--vf-accent-soft)] border-[var(--vf-accent)]/35 text-[var(--vf-accent)]'
            }`}
          >
            <Mic className="h-4 w-4" />
          </div>
          <div>
            <h3 className="text-sm font-semibold text-[var(--vf-text)]">
              Live Microphone Capture
            </h3>
            <p className="text-xs text-[var(--vf-text-muted)]">
              Target <span className="font-mono tabular-nums">{minRecommendedSec}–{maxRecommendedSec}s</span> of natural single-speaker speech
            </p>
          </div>
        </div>

        <label className="inline-flex items-center gap-2 text-xs text-[var(--vf-text-muted)] cursor-pointer select-none">
          <input
            type="checkbox"
            checked={echoCancellation}
            disabled={isRecording || disabled}
            onChange={(e) => setEchoCancellation(e.target.checked)}
            className="h-3.5 w-3.5 rounded border-[var(--vf-border)] accent-[var(--vf-accent)]"
          />
          Browser Echo Cancellation
        </label>
      </div>

      {/* Reading prompt helper */}
      <div className="rounded-md border border-[var(--vf-border-subtle)] bg-[var(--vf-surface)] p-3 space-y-1.5">
        <div className="flex items-center justify-between">
          <span className="text-[10px] font-mono font-semibold uppercase tracking-wider text-[var(--vf-text-muted)] flex items-center gap-1.5">
            <Waves className="h-3.5 w-3.5 text-[var(--vf-accent)]" />
            Sample Reading Script
          </span>
          <button
            type="button"
            onClick={() => setPromptIndex((prev) => (prev + 1) % SAMPLE_PROMPTS.length)}
            className="text-[11px] font-medium text-[var(--vf-accent)] hover:underline cursor-pointer"
          >
            Next Prompt
          </button>
        </div>
        <p className="text-xs leading-relaxed text-[var(--vf-text)] italic">
          &ldquo;{SAMPLE_PROMPTS[promptIndex]}&rdquo;
        </p>
      </div>

      {/* Live RMS VU meter & transport timer */}
      <div className="rounded-md border border-[var(--vf-border-subtle)] bg-[var(--vf-surface)] p-3 space-y-2">
        <div className="flex items-center justify-between text-xs">
          <div className="flex items-center gap-2">
            <Volume2 className="h-3.5 w-3.5 text-[var(--vf-text-subtle)]" />
            <span className="font-mono tabular-nums text-[var(--vf-text)]">
              RMS {rmsDb > -89 ? `${rmsDb.toFixed(1)} dBFS` : '-∞ dBFS'}
            </span>
            {isRecording && (
              <span
                className={`px-2 py-0.5 rounded-sm border text-[10px] font-mono uppercase tracking-wider font-semibold ${levelBadge.cls}`}
              >
                {levelBadge.label}
              </span>
            )}
          </div>
          <div className="flex items-center gap-2.5">
            {isRecording && elapsedSec >= minRecommendedSec && (
              <span className="inline-flex items-center gap-1 text-[11px] text-[var(--vf-success)] font-medium">
                <CheckCircle2 className="h-3 w-3" />
                Min length reached
              </span>
            )}
            <span className="font-mono text-sm font-semibold text-[var(--vf-text)] tabular-nums">
              {formatTimer(elapsedSec)}
            </span>
          </div>
        </div>

        <div className="relative h-2 w-full rounded-sm bg-[var(--vf-bg)] border border-[var(--vf-border-subtle)] overflow-hidden">
          <div
            className={`h-full transition-all duration-75 ${
              rmsDb >= -4
                ? 'bg-[var(--vf-danger)]'
                : rmsDb >= -18
                  ? 'bg-[var(--vf-success)]'
                  : 'bg-[var(--vf-accent)]'
            }`}
            style={{ width: `${meterPercent}%` }}
          />
          {isRecording && (
            <div
              className="absolute top-0 bottom-0 w-0.5 bg-[var(--vf-text)]"
              style={{ left: `${peakPercent}%` }}
            />
          )}
        </div>
      </div>

      {/* Tactile Transport Bar */}
      <div className="flex flex-wrap items-center justify-between gap-3 pt-1 border-t border-[var(--vf-border-subtle)]">
        {!isRecording ? (
          <button
            type="button"
            onClick={() => void startRecording()}
            disabled={disabled || isFinalizing}
            className="inline-flex items-center gap-2 rounded-md bg-[var(--vf-accent)] hover:bg-[var(--vf-accent-hover)] disabled:opacity-50 px-4 py-2 text-xs font-semibold text-white transition-colors cursor-pointer"
          >
            <Mic className="h-3.5 w-3.5" />
            {isFinalizing ? 'Saving PCM...' : 'Start Microphone Recording'}
          </button>
        ) : (
          <button
            type="button"
            onClick={() => void stopRecording()}
            className="inline-flex items-center gap-2 rounded-md bg-rose-600 hover:bg-rose-500 px-4 py-2 text-xs font-semibold text-white transition-colors cursor-pointer"
          >
            <Square className="h-3.5 w-3.5 fill-current" />
            Stop &amp; Add Clip
          </button>
        )}

        <span className="text-[11px] font-mono text-[var(--vf-text-subtle)]">
          Direct Web Audio PCM capture (no lossy re-encoding)
        </span>
      </div>

      {errorMessage && (
        <div
          role="alert"
          className="flex items-start gap-2 rounded-md border border-[var(--vf-danger)]/35 bg-[var(--vf-danger)]/10 p-2.5 text-xs text-[var(--vf-danger)]"
        >
          <AlertCircle className="h-4 w-4 shrink-0 mt-0.5" />
          <span>{errorMessage}</span>
        </div>
      )}
    </div>
  );
}
