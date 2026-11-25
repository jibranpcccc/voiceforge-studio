import { useCallback, useEffect, useRef, useState } from 'react';
import * as ort from 'onnxruntime-web';
import {
  createDefaultEngineRegistry,
  type EngineRegistry,
} from '../engines/registry';
import { computeSha256Hex } from '../storage/modelCache';
import {
  detectHardwareCapabilities,
  type HardwareCapabilities,
} from '../services/hardware';
import type {
  AudioBufferData,
  EngineBackend,
  EngineInitOptions,
  EngineLoadProgress,
  EngineModelMetadata,
  ExecutionMode,
  HardwareCompatibilityReport,
  LoadedVoiceHandle,
  VoiceConditioningPayload,
  VoiceProfile,
} from '../types';

type PocEngineId = 'pocket-tts' | 'chatterbox';

interface PcmMetrics {
  sampleRate: number;
  sampleCount: number;
  durationSec: number;
  rms: number;
  peak: number;
  nonFiniteCount: number;
}

interface SynthesisBenchmarkResult extends PcmMetrics {
  engineId: PocEngineId;
  firstChunkLatencyMs: number;
  totalTimeMs: number;
  generationTimeMs: number;
  realTimeFactor: number;
  backend: EngineBackend;
  chunkCount: number;
  wavBase64: string;
}

interface TurboProbeResult {
  ok: boolean;
  variant: 'q4f16' | 'q4';
  repoId: string;
  revision: string;
  downloadMs: number;
  sessionCreateMs: number;
  inferMs: number;
  outputDims: number[];
  nonFiniteCount: number;
  rms: number;
  peak: number;
  error?: string;
}

interface PocHarnessApi {
  checkHardware: () => Promise<{
    capabilities: HardwareCapabilities;
    reports: Record<PocEngineId, HardwareCompatibilityReport>;
  }>;
  initEngine: (
    engineId: PocEngineId,
    options?: Partial<EngineInitOptions>
  ) => Promise<{
    engineId: PocEngineId;
    initTimeMs: number;
    metadata: EngineModelMetadata;
    progressCount: number;
  }>;
  encodeVoice: (
    engineId: PocEngineId,
    audio: {
      samples: Float32Array | number[];
      sampleRate: number;
      channels?: number;
    },
    clipId?: string
  ) => Promise<{
    engineId: PocEngineId;
    encodeTimeMs: number;
    loadTimeMs: number;
    handle: LoadedVoiceHandle;
    tensorKeys: string[];
    metadata?: Record<string, string | number | boolean>;
  }>;
  synthesize: (
    engineId: PocEngineId,
    text: string,
    options?: {
      handleId?: string;
      parameters?: Record<string, number | string | boolean>;
    }
  ) => Promise<SynthesisBenchmarkResult>;
  probeTurboWebGpu: (variant?: 'q4f16' | 'q4') => Promise<TurboProbeResult>;
  disposeEngine: (engineId?: PocEngineId) => Promise<void>;
  getLastProgress: () => EngineLoadProgress | null;
}

declare global {
  interface Window {
    __VOICEFORGE_POC__?: PocHarnessApi;
  }
}

const TURBO_REPO_ID = 'ResembleAI/chatterbox-turbo-ONNX';
const TURBO_REVISION = 'd21799bd0354adb85e348b8a0442a8405110a2cf';
const TURBO_PROBE_FILES: Record<
  'q4f16' | 'q4',
  {
    onnxPath: string;
    onnxSize: number;
    onnxSha256: string;
    dataPath: string;
    dataSize: number;
    dataSha256: string;
  }
> = {
  q4f16: {
    onnxPath: 'onnx/embed_tokens_q4f16.onnx',
    onnxSize: 2548,
    onnxSha256: 'e5c9507c89e770e35d68bdd669e4ae44b34272232e84f010f2c97959feae79b3',
    dataPath: 'onnx/embed_tokens_q4f16.onnx_data',
    dataSize: 33648688,
    dataSha256: '37e96447b5f3ef46f46fb35cc599cfcb95b277e5528cc0c89bab78169da620ef',
  },
  q4: {
    onnxPath: 'onnx/embed_tokens_q4.onnx',
    onnxSize: 2844,
    onnxSha256: 'fd6ba1d22902e8f539d3dd6d7c1c44b98ebb4c84ebbb5e47fcb826ddcf667561',
    dataPath: 'onnx/embed_tokens_q4.onnx_data',
    dataSize: 37286384,
    dataSha256: 'f54a51e234b509b64c3a03bb79e1149fba7e2eba6c2d9c222f18883379e1f5d8',
  },
};

function computePcmMetrics(samples: Float32Array, sampleRate: number): PcmMetrics {
  let sumSq = 0;
  let peak = 0;
  let nonFiniteCount = 0;

  for (let i = 0; i < samples.length; i += 1) {
    const s = samples[i];
    if (!Number.isFinite(s)) {
      nonFiniteCount += 1;
      continue;
    }
    const abs = Math.abs(s);
    if (abs > peak) peak = abs;
    sumSq += s * s;
  }

  const validCount = Math.max(1, samples.length - nonFiniteCount);
  return {
    sampleRate,
    sampleCount: samples.length,
    durationSec: sampleRate > 0 ? samples.length / sampleRate : 0,
    rms: Math.sqrt(sumSq / validCount),
    peak,
    nonFiniteCount,
  };
}

function encodeWav16Base64(samples: Float32Array, sampleRate: number): string {
  const dataBytes = samples.length * 2;
  const buffer = new ArrayBuffer(44 + dataBytes);
  const view = new DataView(buffer);

  const writeAscii = (offset: number, str: string) => {
    for (let i = 0; i < str.length; i += 1) {
      view.setUint8(offset + i, str.charCodeAt(i));
    }
  };

  writeAscii(0, 'RIFF');
  view.setUint32(4, 36 + dataBytes, true);
  writeAscii(8, 'WAVE');
  writeAscii(12, 'fmt ');
  view.setUint32(16, 16, true);
  view.setUint16(20, 1, true);
  view.setUint16(22, 1, true);
  view.setUint32(24, sampleRate, true);
  view.setUint32(28, sampleRate * 2, true);
  view.setUint16(32, 2, true);
  view.setUint16(34, 16, true);
  writeAscii(36, 'data');
  view.setUint32(40, dataBytes, true);

  let offset = 44;
  for (let i = 0; i < samples.length; i += 1) {
    const clamped = Math.max(-1, Math.min(1, Number.isFinite(samples[i]) ? samples[i] : 0));
    const int16 = clamped < 0 ? Math.round(clamped * 32768) : Math.round(clamped * 32767);
    view.setInt16(offset, int16, true);
    offset += 2;
  }

  const bytes = new Uint8Array(buffer);
  let binary = '';
  const chunkSize = 0x8000;
  for (let i = 0; i < bytes.length; i += chunkSize) {
    const slice = bytes.subarray(i, Math.min(i + chunkSize, bytes.length));
    binary += String.fromCharCode(...slice);
  }
  return btoa(binary);
}

function buildDummyVoiceProfile(
  clipId: string,
  audio: AudioBufferData,
  payload: VoiceConditioningPayload
): VoiceProfile {
  const now = new Date().toISOString();
  const payloadKey = `${payload.engineId}::${payload.modelRevision}`;
  return {
    id: `poc-voice-${clipId}`,
    name: `PoC Voice (${clipId})`,
    language: 'en',
    tags: ['poc'],
    referenceClip: {
      clipId,
      filename: `${clipId}.wav`,
      mimeType: 'audio/wav',
      source: 'sample',
      durationSec: audio.durationSec,
      sampleRate: audio.sampleRate,
      channels: audio.channels,
      language: 'en',
      capturedAt: now,
    },
    qualityAnalysis: {
      clipping: {
        clippedSampleCount: 0,
        clippedPercentage: 0,
        hasSevereClipping: false,
      },
      silence: {
        leadingSilenceSec: 0,
        trailingSilenceSec: 0,
        silenceRatio: 0,
        activeSpeechDurationSec: audio.durationSec,
      },
      noiseFloorDb: -60,
      estimatedSnrDb: 35,
      rmsDb: -20,
      peakDb: -3,
      reverbEstimate: { score: 0.1, level: 'dry' },
      multiSpeakerEstimate: { score: 0.05, suspectedMultipleSpeakers: false },
      durationSec: audio.durationSec,
      sampleRate: audio.sampleRate,
      channels: audio.channels,
      overallScore: 95,
      warnings: [],
      recommendations: [],
    },
    authorizedUse: {
      confirmed: true,
      confirmedAt: now,
      attestationText: 'PoC authorized MIT test fixture.',
      sourceBasis: 'other',
      verificationScope: 'client-self-attested',
    },
    conditioningPayloads: {
      [payloadKey]: payload,
    },
    createdAt: now,
    updatedAt: now,
  };
}

async function fetchVerifiedBytes(
  url: string,
  expectedSize: number,
  expectedSha256: string
): Promise<Uint8Array> {
  const resp = await fetch(url);
  if (!resp.ok) {
    throw new Error(`HTTP ${resp.status} fetching ${url}`);
  }
  const buf = await resp.arrayBuffer();
  const bytes = new Uint8Array(buf);
  if (bytes.byteLength !== expectedSize) {
    throw new Error(`Size mismatch for ${url}: expected ${expectedSize}, got ${bytes.byteLength}`);
  }
  const actualHash = await computeSha256Hex(bytes);
  if (actualHash !== expectedSha256.toLowerCase()) {
    throw new Error(`SHA-256 mismatch for ${url}: expected ${expectedSha256}, got ${actualHash}`);
  }
  return bytes;
}

export function PocHarness() {
  const registryRef = useRef<EngineRegistry | null>(null);
  const handlesRef = useRef<Map<string, LoadedVoiceHandle>>(new Map());
  const latestHandleByEngineRef = useRef<Partial<Record<PocEngineId, LoadedVoiceHandle>>>({});
  const lastProgressRef = useRef<EngineLoadProgress | null>(null);

  const [logs, setLogs] = useState<string[]>([]);
  const [hwSnapshot, setHwSnapshot] = useState<string>('');
  const [progressText, setProgressText] = useState<string>('Idle');
  const [promptText, setPromptText] = useState<string>(
    'Hello from VoiceForge Studio. This is a real local browser voice cloning test.'
  );
  const [audioUrl, setAudioUrl] = useState<string | null>(null);
  const [busy, setBusy] = useState<boolean>(false);
  const uploadedAudioRef = useRef<AudioBufferData | null>(null);

  const appendLog = useCallback((line: string) => {
    setLogs((prev) => [...prev.slice(-80), `[${new Date().toISOString()}] ${line}`]);
  }, []);

  const getRegistry = useCallback(() => {
    if (!registryRef.current) {
      registryRef.current = createDefaultEngineRegistry();
    }
    return registryRef.current;
  }, []);

  const getEngine = useCallback(
    (engineId: PocEngineId) => getRegistry().require(engineId),
    [getRegistry]
  );

  const checkHardware = useCallback(async () => {
    const capabilities = await detectHardwareCapabilities();
    const registry = getRegistry();
    const pocketReport = await registry.checkCompatibility('pocket-tts');
    const chatterboxReport = await registry.checkCompatibility('chatterbox');
    const result = {
      capabilities,
      reports: {
        'pocket-tts': pocketReport,
        chatterbox: chatterboxReport,
      } as Record<PocEngineId, HardwareCompatibilityReport>,
    };
    setHwSnapshot(JSON.stringify(result, null, 2));
    appendLog(
      `Hardware checked: webgpu=${capabilities.webgpuAdapterAvailable}, shader-f16=${capabilities.shaderF16Supported}, wasmSimd=${capabilities.wasmSimdSupported}, isolated=${capabilities.crossOriginIsolated}`
    );
    return result;
  }, [appendLog, getRegistry]);

  const initEngine = useCallback(
    async (engineId: PocEngineId, options: Partial<EngineInitOptions> = {}) => {
      const engine = getEngine(engineId);
      const t0 = performance.now();
      let progressCount = 0;

      const defaultMode: ExecutionMode = engineId === 'pocket-tts' ? 'cpu' : 'quality';
      const initOpts: EngineInitOptions = {
        executionMode: options.executionMode ?? defaultMode,
        preferredBackend: options.preferredBackend,
        wasmThreads: options.wasmThreads,
        wasmBasePath: options.wasmBasePath,
        modelRevision: options.modelRevision,
        signal: options.signal,
      };

      await engine.initialize(initOpts, (p) => {
        progressCount += 1;
        lastProgressRef.current = p;
        setProgressText(`${engineId}: [${p.phase}] ${p.item} (${Math.round(p.progress * 100)}%) — ${p.message}`);
      });

      const initTimeMs = performance.now() - t0;
      const metadata = engine.getModelMetadata();
      appendLog(
        `Initialized ${engineId} in ${initTimeMs.toFixed(0)} ms (backend=${metadata.activeBackend}, precision=${metadata.precision})`
      );
      return {
        engineId,
        initTimeMs,
        metadata,
        progressCount,
      };
    },
    [appendLog, getEngine]
  );

  const encodeVoice = useCallback(
    async (
      engineId: PocEngineId,
      audioInput: { samples: Float32Array | number[]; sampleRate: number; channels?: number },
      clipId = 'poc-ref'
    ) => {
      const engine = getEngine(engineId);
      const samples =
        audioInput.samples instanceof Float32Array
          ? audioInput.samples
          : new Float32Array(audioInput.samples);
      const channels = audioInput.channels ?? 1;
      const durationSec =
        audioInput.sampleRate > 0 ? samples.length / channels / audioInput.sampleRate : 0;

      const audio: AudioBufferData = {
        samples,
        sampleRate: audioInput.sampleRate,
        channels,
        durationSec,
      };

      const tEncode0 = performance.now();
      const payload = await engine.encodeVoice(audio, {
        clipId,
        filename: `${clipId}.wav`,
        mimeType: 'audio/wav',
        source: 'sample',
        durationSec,
        sampleRate: audio.sampleRate,
        channels,
        language: 'en',
        capturedAt: new Date().toISOString(),
      });
      const encodeTimeMs = performance.now() - tEncode0;

      const profile = buildDummyVoiceProfile(clipId, audio, payload);
      const tLoad0 = performance.now();
      const handle = await getRegistry().loadVoiceProfileForEngine(engineId, profile);
      const loadTimeMs = performance.now() - tLoad0;

      handlesRef.current.set(handle.handleId, handle);
      latestHandleByEngineRef.current[engineId] = handle;

      appendLog(
        `Encoded & loaded voice for ${engineId}: encode=${encodeTimeMs.toFixed(0)} ms, load=${loadTimeMs.toFixed(0)} ms, tensors=[${Object.keys(payload.tensors).join(', ')}]`
      );

      return {
        engineId,
        encodeTimeMs,
        loadTimeMs,
        handle,
        tensorKeys: Object.keys(payload.tensors),
        metadata: payload.metadata,
      };
    },
    [appendLog, getEngine, getRegistry]
  );

  const synthesize = useCallback(
    async (
      engineId: PocEngineId,
      text: string,
      options: {
        handleId?: string;
        parameters?: Record<string, number | string | boolean>;
      } = {}
    ): Promise<SynthesisBenchmarkResult> => {
      const engine = getEngine(engineId);
      const handle =
        (options.handleId ? handlesRef.current.get(options.handleId) : undefined) ??
        latestHandleByEngineRef.current[engineId];

      if (!handle) {
        throw new Error(`No voice handle loaded for engine '${engineId}'.`);
      }

      const t0 = performance.now();
      let firstChunkLatencyMs: number | null = null;
      let chunkCount = 0;

      const result = await engine.synthesize(
        {
          text,
          voiceHandle: handle,
          language: 'en',
          parameters: options.parameters,
        },
        (chunk) => {
          chunkCount += 1;
          if (firstChunkLatencyMs === null && chunk.samples.length > 0) {
            firstChunkLatencyMs = performance.now() - t0;
          }
        }
      );

      const totalTimeMs = performance.now() - t0;
      const metrics = computePcmMetrics(result.audio.samples, result.audio.sampleRate);
      const wavBase64 = encodeWav16Base64(result.audio.samples, result.audio.sampleRate);

      appendLog(
        `Synthesized ${engineId}: dur=${metrics.durationSec.toFixed(2)}s, total=${totalTimeMs.toFixed(0)}ms, firstChunk=${(firstChunkLatencyMs ?? totalTimeMs).toFixed(0)}ms, RTF=${result.realTimeFactor.toFixed(2)}, RMS=${metrics.rms.toFixed(4)}, peak=${metrics.peak.toFixed(4)}, nonFinite=${metrics.nonFiniteCount}`
      );

      return {
        engineId,
        ...metrics,
        firstChunkLatencyMs: firstChunkLatencyMs ?? totalTimeMs,
        totalTimeMs,
        generationTimeMs: result.generationTimeMs,
        realTimeFactor: result.realTimeFactor,
        backend: result.backend,
        chunkCount,
        wavBase64,
      };
    },
    [appendLog, getEngine]
  );

  const probeTurboWebGpu = useCallback(
    async (variant: 'q4f16' | 'q4' = 'q4f16'): Promise<TurboProbeResult> => {
      const spec = TURBO_PROBE_FILES[variant];
      const base = `https://huggingface.co/${TURBO_REPO_ID}/resolve/${TURBO_REVISION}`;
      let downloadMs = 0;
      let sessionCreateMs = 0;
      let inferMs = 0;

      let session: ort.InferenceSession | null = null;
      let inputTensor: ort.Tensor | null = null;
      let outputTensor: ort.Tensor | null = null;

      try {
        const baseUrl = import.meta.env.BASE_URL || './';
        const normalizedBase = baseUrl.endsWith('/') ? baseUrl : `${baseUrl}/`;
        ort.env.wasm.wasmPaths = new URL(`${normalizedBase}runtime/`, window.location.href).href;

        const tDl0 = performance.now();
        const [onnxBytes, dataBytes] = await Promise.all([
          fetchVerifiedBytes(`${base}/${spec.onnxPath}`, spec.onnxSize, spec.onnxSha256),
          fetchVerifiedBytes(`${base}/${spec.dataPath}`, spec.dataSize, spec.dataSha256),
        ]);
        downloadMs = performance.now() - tDl0;

        const dataName = spec.dataPath.split('/').pop() ?? spec.dataPath;
        const tCreate0 = performance.now();
        session = await ort.InferenceSession.create(onnxBytes, {
          executionProviders: ['webgpu'],
          externalData: [{ path: dataName, data: dataBytes }],
        });
        sessionCreateMs = performance.now() - tCreate0;

        const tInfer0 = performance.now();
        inputTensor = new ort.Tensor('int64', new BigInt64Array([1n, 2n, 3n, 4n]), [1, 4]);
        const outputs = await session.run({ input_ids: inputTensor });
        outputTensor = outputs.inputs_embeds ?? Object.values(outputs)[0];
        if (!outputTensor) {
          throw new Error('Turbo embed_tokens produced no output tensor.');
        }
        const rawOut = await outputTensor.getData();
        inferMs = performance.now() - tInfer0;

        const floatOut =
          rawOut instanceof Float32Array
            ? rawOut
            : new Float32Array(
                (rawOut as ArrayBufferView).buffer,
                (rawOut as ArrayBufferView).byteOffset,
                Math.floor((rawOut as ArrayBufferView).byteLength / 4)
              );
        const metrics = computePcmMetrics(floatOut, 1);

        appendLog(
          `Turbo WebGPU probe (${variant}) PASSED: dims=[${outputTensor.dims.join(', ')}], dl=${downloadMs.toFixed(0)}ms, create=${sessionCreateMs.toFixed(0)}ms, infer=${inferMs.toFixed(0)}ms, nonFinite=${metrics.nonFiniteCount}`
        );

        return {
          ok: true,
          variant,
          repoId: TURBO_REPO_ID,
          revision: TURBO_REVISION,
          downloadMs,
          sessionCreateMs,
          inferMs,
          outputDims: [...outputTensor.dims],
          nonFiniteCount: metrics.nonFiniteCount,
          rms: metrics.rms,
          peak: metrics.peak,
        };
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        appendLog(`Turbo WebGPU probe (${variant}) FAILED: ${msg}`);
        return {
          ok: false,
          variant,
          repoId: TURBO_REPO_ID,
          revision: TURBO_REVISION,
          downloadMs,
          sessionCreateMs,
          inferMs,
          outputDims: [],
          nonFiniteCount: 0,
          rms: 0,
          peak: 0,
          error: msg,
        };
      } finally {
        try {
          inputTensor?.dispose();
        } catch {
          // Ignore disposal errors
        }
        try {
          outputTensor?.dispose();
        } catch {
          // Ignore disposal errors
        }
        if (session) {
          await session.release().catch(() => undefined);
        }
      }
    },
    [appendLog]
  );

  const disposeEngine = useCallback(async (engineId?: PocEngineId) => {
    if (!registryRef.current) return;
    if (!engineId) {
      await registryRef.current.disposeAll();
      registryRef.current = null;
      handlesRef.current.clear();
      latestHandleByEngineRef.current = {};
      return;
    }
    await registryRef.current.get(engineId)?.dispose();
    delete latestHandleByEngineRef.current[engineId];
  }, []);

  useEffect(() => {
    window.__VOICEFORGE_POC__ = {
      checkHardware,
      initEngine,
      encodeVoice,
      synthesize,
      probeTurboWebGpu,
      disposeEngine,
      getLastProgress: () => lastProgressRef.current,
    };

    return () => {
      delete window.__VOICEFORGE_POC__;
    };
  }, [checkHardware, disposeEngine, encodeVoice, initEngine, probeTurboWebGpu, synthesize]);

  const handleFileChange = async (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    if (!file) return;
    const ctx = new AudioContext();
    try {
      const buf = await file.arrayBuffer();
      const decoded = await ctx.decodeAudioData(buf);
      const samples = new Float32Array(decoded.getChannelData(0));
      uploadedAudioRef.current = {
        samples,
        sampleRate: decoded.sampleRate,
        channels: 1,
        durationSec: decoded.duration,
      };
      appendLog(
        `Loaded reference audio '${file.name}': ${decoded.duration.toFixed(2)}s @ ${decoded.sampleRate} Hz`
      );
    } finally {
      await ctx.close();
    }
  };

  const runUiFlow = async (engineId: PocEngineId) => {
    setBusy(true);
    try {
      await initEngine(engineId);
      const audio = uploadedAudioRef.current ?? {
        samples: new Float32Array(24000 * 3).map((_, idx) => Math.sin((2 * Math.PI * 220 * idx) / 24000) * 0.2),
        sampleRate: 24000,
        channels: 1,
        durationSec: 3,
      };
      await encodeVoice(engineId, audio, 'ui-ref');
      const res = await synthesize(engineId, promptText);
      const raw = Uint8Array.from(atob(res.wavBase64), (c) => c.charCodeAt(0));
      const blob = new Blob([raw], { type: 'audio/wav' });
      setAudioUrl((prev) => {
        if (prev) URL.revokeObjectURL(prev);
        return URL.createObjectURL(blob);
      });
    } catch (err) {
      appendLog(`UI run error (${engineId}): ${err instanceof Error ? err.message : String(err)}`);
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="min-h-screen bg-slate-950 text-slate-100 p-6 font-mono text-xs">
      <div className="max-w-4xl mx-auto space-y-4">
        <header className="flex items-center justify-between border-b border-slate-800 pb-3">
          <div>
            <h1 className="text-lg font-bold text-indigo-300">
              VoiceForge Studio — Inference PoC Harness (#/poc)
            </h1>
            <p className="text-slate-400">
              Direct browser verification harness for Pocket TTS, Chatterbox ONNX, and Chatterbox Turbo WebGPU probe.
            </p>
          </div>
          <span
            data-testid="poc-ready"
            className="px-2 py-1 rounded bg-emerald-500/20 text-emerald-300 border border-emerald-500/30"
          >
            POC READY
          </span>
        </header>

        <section className="flex flex-wrap gap-2">
          <button
            type="button"
            disabled={busy}
            onClick={() => void checkHardware()}
            className="px-3 py-1.5 rounded bg-slate-800 hover:bg-slate-700 border border-slate-700"
          >
            Check Hardware
          </button>
          <button
            type="button"
            disabled={busy}
            onClick={() => void runUiFlow('pocket-tts')}
            className="px-3 py-1.5 rounded bg-indigo-600 hover:bg-indigo-500 text-white"
          >
            Run Pocket TTS
          </button>
          <button
            type="button"
            disabled={busy}
            onClick={() => void runUiFlow('chatterbox')}
            className="px-3 py-1.5 rounded bg-purple-600 hover:bg-purple-500 text-white"
          >
            Run Chatterbox ONNX
          </button>
          <button
            type="button"
            disabled={busy}
            onClick={() => void probeTurboWebGpu('q4f16')}
            className="px-3 py-1.5 rounded bg-amber-600 hover:bg-amber-500 text-white"
          >
            Probe Turbo WebGPU (q4f16)
          </button>
        </section>

        <section className="grid grid-cols-1 md:grid-cols-2 gap-3">
          <label className="block space-y-1">
            <span className="text-slate-400">Reference WAV</span>
            <input
              type="file"
              accept="audio/*"
              onChange={(e) => void handleFileChange(e)}
              className="block w-full text-slate-300 file:mr-2 file:py-1 file:px-2 file:rounded file:border-0 file:bg-slate-800 file:text-slate-200"
            />
          </label>
          <label className="block space-y-1">
            <span className="text-slate-400">Evaluation Script</span>
            <input
              type="text"
              value={promptText}
              onChange={(e) => setPromptText(e.target.value)}
              className="w-full px-2 py-1.5 rounded bg-slate-900 border border-slate-700 text-slate-100"
            />
          </label>
        </section>

        <div className="p-3 rounded bg-slate-900 border border-slate-800">
          <div className="text-slate-400 mb-1">Status</div>
          <div data-testid="poc-status">{progressText}</div>
          {audioUrl && (
            <audio controls src={audioUrl} className="mt-2 w-full" />
          )}
        </div>

        {hwSnapshot && (
          <pre className="p-3 rounded bg-slate-900 border border-slate-800 overflow-auto max-h-60">
            {hwSnapshot}
          </pre>
        )}

        <pre
          data-testid="poc-logs"
          className="p-3 rounded bg-slate-900 border border-slate-800 overflow-auto max-h-72 text-emerald-300"
        >
          {logs.join('\n') || 'Waiting for commands...'}
        </pre>
      </div>
    </div>
  );
}

export default PocHarness;
