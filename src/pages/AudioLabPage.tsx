import { useEffect, useMemo, useState } from 'react';
import {
  Activity,
  AlertTriangle,
  Award,
  Check,
  Download,
  FlaskConical,
  Loader2,
  Play,
  Plus,
  Trash2,
} from 'lucide-react';
import { WaveformPlayer } from '../components/audio/WaveformPlayer';
import {
  ensureDefaultEnginesRegistered,
  ensureEngineInitialized,
  formatBytes,
  isVoiceCompatibleWithEngine,
  triggerBrowserDownload,
} from '../components/studio';
import { extractEngineParametersForEngine } from '../services/presets';
import { saveLabRun } from '../storage/db';
import { useAppStore, useVoiceStore } from '../stores';
import type { AudioBufferData, EngineBackend } from '../types';

const EVAL_SCRIPTS: Array<{ id: string; title: string; text: string }> = [
  {
    id: 'technical',
    title: 'Technical & Numbers',
    text: 'In Q3 2026, Dr. Chen benchmarked version 2.4 of the client-side ONNX pipeline at 24,000 Hz, achieving an average throughput of 1.35x across 128 MB of cached weights.',
  },
  {
    id: 'dialogue',
    title: 'Expressive Dialogue',
    text: '"Wait—did you actually hear that?" Maya whispered, leaning toward the studio console. "Every inflection sounded completely natural, without a single metallic artifact."',
  },
  {
    id: 'narrative',
    title: 'Documentary Narrative',
    text: 'Across the northern ridge, winter arrives quietly. Ice settles over the granite basins long before the first storm crosses the horizon, leaving only wind in the pines.',
  },
];

const RUBRIC_CRITERIA: Array<{ key: keyof RubricRatings; label: string }> = [
  { key: 'voiceSimilarity', label: 'Voice Similarity' },
  { key: 'naturalness', label: 'Naturalness' },
  { key: 'pronunciation', label: 'Pronunciation' },
  { key: 'accentConsistency', label: 'Accent Consistency' },
  { key: 'expression', label: 'Expression' },
  { key: 'longFormStability', label: 'Long-Form Stability' },
];

interface RubricRatings {
  voiceSimilarity: number | null;
  naturalness: number | null;
  pronunciation: number | null;
  accentConsistency: number | null;
  expression: number | null;
  longFormStability: number | null;
}

interface RubricDefects {
  wordOmissions: boolean;
  repeatedWords: boolean;
  artifacts: boolean;
}

interface LabConfig {
  id: string;
  label: string;
  engineId: string;
  parameters: Record<string, number | string | boolean>;
}

interface LabResult {
  configId: string;
  label: string;
  engineId: string;
  modelRevision: string;
  backend: EngineBackend;
  parameters: Record<string, number | string | boolean>;
  audio: AudioBufferData;
  totalLatencyMs: number;
  firstChunkLatencyMs: number;
  realTimeFactor: number;
  jsHeapUsedBytes: number | null;
  ratings: RubricRatings;
  defects: RubricDefects;
}

function readChromiumJsHeapBytes(): number | null {
  if (typeof performance === 'undefined') return null;
  const mem = (performance as Performance & { memory?: { usedJSHeapSize?: number } }).memory;
  if (mem && typeof mem.usedJSHeapSize === 'number' && Number.isFinite(mem.usedJSHeapSize)) {
    return mem.usedJSHeapSize;
  }
  return null;
}

function emptyRatings(): RubricRatings {
  return {
    voiceSimilarity: null,
    naturalness: null,
    pronunciation: null,
    accentConsistency: null,
    expression: null,
    longFormStability: null,
  };
}

function emptyDefects(): RubricDefects {
  return {
    wordOmissions: false,
    repeatedWords: false,
    artifacts: false,
  };
}

export function AudioLabPage() {
  const customModelBaseUrl = useAppStore((s) => s.customModelBaseUrl);
  const executionMode = useAppStore((s) => s.executionMode);
  const voices = useVoiceStore((s) => s.voices);
  const defaultVoiceId = useVoiceStore((s) => s.defaultVoiceId);
  const loadVoices = useVoiceStore((s) => s.loadVoices);

  const registry = useMemo(
    () => ensureDefaultEnginesRegistered(customModelBaseUrl),
    [customModelBaseUrl]
  );
  const availableEngines = useMemo(() => registry.list(), [registry]);

  const [selectedVoiceId, setSelectedVoiceId] = useState<string>('');
  const [scriptText, setScriptText] = useState<string>(EVAL_SCRIPTS[0].text);
  const [configs, setConfigs] = useState<LabConfig[]>([
    {
      id: 'cfg-a',
      label: 'Config A: Pocket TTS (Default Steps=1)',
      engineId: 'pocket-tts',
      parameters: { temperature: 0.7, lsdSteps: 1, framesAfterEos: 2, seed: 42 },
    },
    {
      id: 'cfg-b',
      label: 'Config B: Pocket TTS (High Steps=4)',
      engineId: 'pocket-tts',
      parameters: { temperature: 0.65, lsdSteps: 4, framesAfterEos: 3, seed: 42 },
    },
  ]);

  const [isRunning, setIsRunning] = useState(false);
  const [activeStatus, setActiveStatus] = useState<string | null>(null);
  const [runError, setRunError] = useState<string | null>(null);
  const [results, setResults] = useState<LabResult[]>([]);
  const [preferredId, setPreferredId] = useState<string | null>(null);
  const [reviewerNotes, setReviewerNotes] = useState('');

  useEffect(() => {
    void loadVoices();
  }, [loadVoices]);

  const effectiveVoiceId = selectedVoiceId || defaultVoiceId || voices[0]?.id || '';
  const selectedVoice = voices.find((v) => v.id === effectiveVoiceId) ?? null;

  const updateConfig = (id: string, patch: Partial<LabConfig>) => {
    setConfigs((prev) => prev.map((c) => (c.id === id ? { ...c, ...patch } : c)));
  };

  const updateConfigParam = (id: string, key: string, value: number | string | boolean) => {
    setConfigs((prev) =>
      prev.map((c) =>
        c.id === id ? { ...c, parameters: { ...c.parameters, [key]: value } } : c
      )
    );
  };

  const addConfig = () => {
    const idx = configs.length + 1;
    const chatterboxAvailable = availableEngines.some((e) => e.id === 'chatterbox');
    const engineId =
      idx === 3 && chatterboxAvailable && selectedVoice && isVoiceCompatibleWithEngine(selectedVoice, registry.get('chatterbox'))
        ? 'chatterbox'
        : 'pocket-tts';
    setConfigs((prev) => [
      ...prev,
      {
        id: `cfg-${Date.now()}`,
        label: `Config ${String.fromCharCode(64 + idx)}`,
        engineId,
        parameters: extractEngineParametersForEngine({}, engineId),
      },
    ]);
  };

  const removeConfig = (id: string) => {
    if (configs.length <= 2) return;
    setConfigs((prev) => prev.filter((c) => c.id !== id));
  };

  const runSequentialComparison = async () => {
    setRunError(null);
    if (!scriptText.trim()) {
      setRunError('Please provide an evaluation script.');
      return;
    }
    if (!selectedVoice) {
      setRunError('Select a Voice Profile first.');
      return;
    }

    // Validate all configs against selected voice before starting
    for (const cfg of configs) {
      const eng = registry.get(cfg.engineId);
      if (!eng) {
        setRunError(`Engine '${cfg.engineId}' is not registered.`);
        return;
      }
      if (!isVoiceCompatibleWithEngine(selectedVoice, eng)) {
        setRunError(
          `Voice '${selectedVoice.name}' does not have conditioning for '${eng.name}' (${cfg.label}).`
        );
        return;
      }
    }

    setIsRunning(true);
    setResults([]);
    setPreferredId(null);
    const collected: LabResult[] = [];

    try {
      for (let i = 0; i < configs.length; i++) {
        const cfg = configs[i];
        const engine = registry.require(cfg.engineId);
        setActiveStatus(`(${i + 1}/${configs.length}) Initializing ${cfg.label}...`);
        await ensureEngineInitialized(engine, executionMode, (p) => {
          setActiveStatus(`(${i + 1}/${configs.length}) ${cfg.label}: ${p.message}`);
        });

        const handle = await registry.loadVoiceProfileForEngine(cfg.engineId, selectedVoice);
        setActiveStatus(`(${i + 1}/${configs.length}) Synthesizing ${cfg.label}...`);

        const tStart = performance.now();
        let firstChunkMs: number | null = null;
        const cleanParams = extractEngineParametersForEngine(cfg.parameters, cfg.engineId);

        const synthResult = await engine.synthesize(
          {
            text: scriptText.trim(),
            voiceHandle: handle,
            language: selectedVoice.language || 'en',
            parameters: cleanParams,
          },
          () => {
            if (firstChunkMs === null) {
              firstChunkMs = performance.now() - tStart;
            }
          }
        );

        const totalLatencyMs = performance.now() - tStart;
        const jsHeapUsedBytes = readChromiumJsHeapBytes();
        const meta = engine.getModelMetadata();

        collected.push({
          configId: cfg.id,
          label: cfg.label,
          engineId: cfg.engineId,
          modelRevision: meta.modelRevision,
          backend: synthResult.backend,
          parameters: cleanParams,
          audio: synthResult.audio,
          totalLatencyMs,
          firstChunkLatencyMs: firstChunkMs ?? totalLatencyMs,
          realTimeFactor: synthResult.realTimeFactor,
          jsHeapUsedBytes,
          ratings: emptyRatings(),
          defects: emptyDefects(),
        });
        setResults([...collected]);
      }

      // Persist run record to IndexedDB
      await saveLabRun({
        id: `lab-${Date.now()}`,
        title: `A/B Comparison (${collected.length} configs)`,
        text: scriptText.trim(),
        voiceProfileId: selectedVoice.id,
        variants: collected.map((r) => ({
          label: r.label,
          engineId: r.engineId,
          modelRevision: r.modelRevision,
          executionMode,
          parameters: r.parameters,
          sampleRate: r.audio.sampleRate,
          durationSec: r.audio.durationSec,
          generationTimeMs: r.totalLatencyMs,
          realTimeFactor: r.realTimeFactor,
        })),
        createdAt: new Date().toISOString(),
      });
      setActiveStatus(null);
    } catch (err) {
      setRunError(err instanceof Error ? err.message : String(err));
      setActiveStatus(null);
    } finally {
      setIsRunning(false);
    }
  };

  const setRating = (configId: string, key: keyof RubricRatings, score: number) => {
    setResults((prev) =>
      prev.map((r) =>
        r.configId === configId
          ? { ...r, ratings: { ...r.ratings, [key]: r.ratings[key] === score ? null : score } }
          : r
      )
    );
  };

  const toggleDefect = (configId: string, key: keyof RubricDefects) => {
    setResults((prev) =>
      prev.map((r) =>
        r.configId === configId
          ? { ...r, defects: { ...r.defects, [key]: !r.defects[key] } }
          : r
      )
    );
  };

  const exportReportJson = () => {
    const payload = {
      generatedAt: new Date().toISOString(),
      voiceProfileId: selectedVoice?.id ?? null,
      voiceName: selectedVoice?.name ?? null,
      evaluationScript: scriptText,
      preferredConfigId: preferredId,
      reviewerNotes,
      variants: results.map((r) => ({
        label: r.label,
        engineId: r.engineId,
        modelRevision: r.modelRevision,
        backend: r.backend,
        parameters: r.parameters,
        telemetry: {
          totalLatencyMs: Number(r.totalLatencyMs.toFixed(1)),
          firstChunkLatencyMs: Number(r.firstChunkLatencyMs.toFixed(1)),
          realTimeFactor: Number(r.realTimeFactor.toFixed(3)),
          durationSec: Number(r.audio.durationSec.toFixed(3)),
          sampleRate: r.audio.sampleRate,
          jsHeapUsedBytes: r.jsHeapUsedBytes,
        },
        humanRubric: r.ratings,
        defects: r.defects,
      })),
    };
    triggerBrowserDownload(
      JSON.stringify(payload, null, 2),
      'application/json',
      `voiceforge-lab-report-${Date.now()}.json`
    );
  };

  const exportReportMarkdown = () => {
    const lines: string[] = [
      '# VoiceForge Audio Lab A/B Comparison Report',
      '',
      `- **Date:** ${new Date().toISOString()}`,
      `- **Voice Profile:** ${selectedVoice?.name ?? 'None'}`,
      `- **Preferred Variant:** ${results.find((r) => r.configId === preferredId)?.label ?? 'Unselected'}`,
      '',
      '## Evaluation Script',
      '',
      `> ${scriptText.trim()}`,
      '',
      '## Measured Telemetry & Listening Rubric',
      '',
    ];

    for (const r of results) {
      lines.push(`### ${r.label} (\`${r.engineId}\` · \`${r.backend}\`)`);
      lines.push('');
      lines.push(`- **Parameters:** \`${JSON.stringify(r.parameters)}\``);
      lines.push(`- **Total Latency:** ${r.totalLatencyMs.toFixed(1)} ms`);
      lines.push(`- **First-Chunk Latency:** ${r.firstChunkLatencyMs.toFixed(1)} ms`);
      lines.push(`- **Real-Time Factor (RTF):** ${r.realTimeFactor.toFixed(3)}x`);
      lines.push(`- **Output Duration:** ${r.audio.durationSec.toFixed(2)} s (${r.audio.sampleRate} Hz)`);
      lines.push(
        `- **JS Heap (usedJSHeapSize):** ${
          r.jsHeapUsedBytes !== null ? formatBytes(r.jsHeapUsedBytes) : 'Not exposed by browser'
        }`
      );
      lines.push('- **Human Rubric Ratings (1–5):**');
      for (const crit of RUBRIC_CRITERIA) {
        const val = r.ratings[crit.key];
        lines.push(`  - ${crit.label}: ${val !== null ? `${val}/5` : 'Unrated'}`);
      }
      lines.push(
        `- **Observed Defects:** Word Omissions=${r.defects.wordOmissions}, Repeated Words=${r.defects.repeatedWords}, Artifacts=${r.defects.artifacts}`
      );
      lines.push('');
    }

    if (reviewerNotes.trim()) {
      lines.push('## Reviewer Notes', '', reviewerNotes.trim(), '');
    }

    triggerBrowserDownload(
      lines.join('\n'),
      'text/markdown;charset=utf-8',
      `voiceforge-lab-report-${Date.now()}.md`
    );
  };

  return (
    <div className="space-y-5">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div>
          <h1 className="text-xl font-semibold text-slate-900 dark:text-slate-100 flex items-center gap-2">
            <FlaskConical className="w-5 h-5 text-[#7C5CFF]" />
            Audio Lab: A/B Engine &amp; Parameter Comparison
          </h1>
          <p className="text-xs text-slate-500 dark:text-slate-400">
            Sequential on-device synthesis with real measured telemetry and an interactive listening rubric.
          </p>
        </div>

        {results.length > 0 && (
          <div className="flex items-center gap-2">
            <button
              type="button"
              onClick={exportReportJson}
              className="inline-flex items-center gap-1.5 px-3 py-1.5 rounded-lg text-xs font-medium border border-slate-200 dark:border-slate-700 text-slate-700 dark:text-slate-200 hover:bg-slate-100 dark:hover:bg-slate-800 transition"
            >
              <Download className="w-3.5 h-3.5" />
              Export JSON
            </button>
            <button
              type="button"
              onClick={exportReportMarkdown}
              className="inline-flex items-center gap-1.5 px-3 py-1.5 rounded-lg text-xs font-medium border border-slate-200 dark:border-slate-700 text-slate-700 dark:text-slate-200 hover:bg-slate-100 dark:hover:bg-slate-800 transition"
            >
              <Download className="w-3.5 h-3.5" />
              Export Markdown
            </button>
          </div>
        )}
      </div>

      {/* Script & Voice Selection */}
      <div className="rounded-xl border border-slate-200 dark:border-slate-800 bg-white dark:bg-[#121622] p-4 space-y-4">
        <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
          <div className="space-y-1.5">
            <label className="block text-xs font-medium text-slate-700 dark:text-slate-300">
              Voice Profile
            </label>
            <select
              value={effectiveVoiceId}
              disabled={isRunning}
              onChange={(e) => setSelectedVoiceId(e.target.value)}
              className="w-full rounded-lg border border-slate-200 dark:border-slate-700 bg-slate-50 dark:bg-[#0B0D12] px-3 py-2 text-xs text-slate-900 dark:text-slate-100"
            >
              {voices.length === 0 ? (
                <option value="">No voice profiles available</option>
              ) : (
                voices.map((v) => (
                  <option key={v.id} value={v.id}>
                    {v.name}
                  </option>
                ))
              )}
            </select>
          </div>

          <div className="space-y-1.5">
            <label className="block text-xs font-medium text-slate-700 dark:text-slate-300">
              Evaluation Prompt Preset
            </label>
            <div className="flex flex-wrap gap-1.5">
              {EVAL_SCRIPTS.map((preset) => (
                <button
                  key={preset.id}
                  type="button"
                  disabled={isRunning}
                  onClick={() => setScriptText(preset.text)}
                  className="px-2.5 py-1.5 rounded-lg text-xs border border-slate-200 dark:border-slate-700 text-slate-700 dark:text-slate-300 hover:border-[#7C5CFF] transition"
                >
                  {preset.title}
                </button>
              ))}
            </div>
          </div>
        </div>

        <textarea
          rows={3}
          disabled={isRunning}
          value={scriptText}
          onChange={(e) => setScriptText(e.target.value)}
          placeholder="Enter evaluation script..."
          className="w-full rounded-lg border border-slate-200 dark:border-slate-700 bg-slate-50 dark:bg-[#0B0D12] p-3 text-xs text-slate-900 dark:text-slate-100 focus:border-[#7C5CFF] focus:outline-none"
        />
      </div>

      {/* Configurations */}
      <div className="space-y-3">
        <div className="flex items-center justify-between">
          <h2 className="text-sm font-semibold text-slate-900 dark:text-slate-100">
            Comparison Configurations ({configs.length})
          </h2>
          <button
            type="button"
            disabled={isRunning}
            onClick={addConfig}
            className="inline-flex items-center gap-1 px-2.5 py-1.5 rounded-lg text-xs font-medium border border-slate-200 dark:border-slate-700 text-slate-700 dark:text-slate-200 hover:bg-slate-100 dark:hover:bg-slate-800 disabled:opacity-40"
          >
            <Plus className="w-3.5 h-3.5" />
            Add Configuration
          </button>
        </div>

        <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
          {configs.map((cfg) => {
            const engine = registry.get(cfg.engineId);
            const specs = engine?.getGenerationParameters() ?? [];
            const compatible =
              selectedVoice && engine ? isVoiceCompatibleWithEngine(selectedVoice, engine) : true;

            return (
              <div
                key={cfg.id}
                className="rounded-xl border border-slate-200 dark:border-slate-800 bg-white dark:bg-[#121622] p-4 space-y-3"
              >
                <div className="flex items-center justify-between gap-2">
                  <input
                    type="text"
                    disabled={isRunning}
                    value={cfg.label}
                    onChange={(e) => updateConfig(cfg.id, { label: e.target.value })}
                    className="flex-1 rounded-lg border border-slate-200 dark:border-slate-700 bg-slate-50 dark:bg-[#0B0D12] px-2.5 py-1.5 text-xs font-semibold text-slate-900 dark:text-slate-100"
                  />
                  {configs.length > 2 && (
                    <button
                      type="button"
                      disabled={isRunning}
                      onClick={() => removeConfig(cfg.id)}
                      className="p-1.5 rounded text-slate-400 hover:text-rose-400"
                    >
                      <Trash2 className="w-3.5 h-3.5" />
                    </button>
                  )}
                </div>

                <div>
                  <select
                    value={cfg.engineId}
                    disabled={isRunning}
                    onChange={(e) =>
                      updateConfig(cfg.id, {
                        engineId: e.target.value,
                        parameters: extractEngineParametersForEngine({}, e.target.value),
                      })
                    }
                    className="w-full rounded-lg border border-slate-200 dark:border-slate-700 bg-slate-50 dark:bg-[#0B0D12] px-2.5 py-1.5 text-xs text-slate-900 dark:text-slate-100"
                  >
                    {availableEngines.map((eng) => (
                      <option key={eng.id} value={eng.id}>
                        {eng.name}
                      </option>
                    ))}
                  </select>
                </div>

                {!compatible && (
                  <div className="flex items-center gap-1.5 text-[11px] text-amber-500">
                    <AlertTriangle className="w-3.5 h-3.5 shrink-0" />
                    Selected voice lacks conditioning for {engine?.name}.
                  </div>
                )}

                <div className="grid grid-cols-2 gap-2.5">
                  {specs.map((spec) => {
                    const val = Number(cfg.parameters[spec.key] ?? spec.defaultValue);
                    return (
                      <div key={spec.key} className="space-y-1">
                        <div className="flex justify-between text-[11px]">
                          <span className="text-slate-600 dark:text-slate-400">{spec.label}</span>
                          <span className="font-mono text-[#7C5CFF]">{val}</span>
                        </div>
                        <input
                          type="number"
                          min={spec.min}
                          max={spec.max}
                          step={spec.step ?? 0.05}
                          disabled={isRunning}
                          value={val}
                          onChange={(e) =>
                            updateConfigParam(cfg.id, spec.key, Number(e.target.value))
                          }
                          className="w-full rounded border border-slate-200 dark:border-slate-700 bg-slate-50 dark:bg-[#0B0D12] px-2 py-1 text-xs font-mono text-slate-900 dark:text-slate-100"
                        />
                      </div>
                    );
                  })}
                </div>
              </div>
            );
          })}
        </div>

        <div className="flex flex-wrap items-center gap-3">
          <button
            type="button"
            disabled={isRunning || !selectedVoice || !scriptText.trim()}
            onClick={() => void runSequentialComparison()}
            className="inline-flex items-center gap-2 px-5 py-2.5 rounded-xl text-sm font-semibold bg-[#7C5CFF] text-white hover:bg-[#6A48F5] disabled:opacity-40 transition"
          >
            {isRunning ? <Loader2 className="w-4 h-4 animate-spin" /> : <Play className="w-4 h-4" />}
            {isRunning ? 'Running Sequential Benchmark...' : 'Run A/B Comparison'}
          </button>

          {activeStatus && (
            <span className="text-xs text-slate-500 dark:text-slate-400">{activeStatus}</span>
          )}
        </div>

        {runError && (
          <div className="rounded-xl border border-rose-500/30 bg-rose-500/10 px-4 py-2.5 text-xs text-rose-700 dark:text-rose-300">
            {runError}
          </div>
        )}
      </div>

      {/* Side-by-Side Results, Telemetry & Interactive Rubric */}
      {results.length > 0 && (
        <div className="space-y-4">
          <div className="grid grid-cols-1 lg:grid-cols-2 gap-4">
            {results.map((res) => {
              const isPreferred = preferredId === res.configId;
              return (
                <div
                  key={res.configId}
                  className={`rounded-xl border p-4 space-y-4 ${
                    isPreferred
                      ? 'border-[#7C5CFF] bg-[#7C5CFF]/5'
                      : 'border-slate-200 dark:border-slate-800 bg-white dark:bg-[#121622]'
                  }`}
                >
                  <div className="flex items-start justify-between gap-2">
                    <div>
                      <h3 className="text-sm font-semibold text-slate-900 dark:text-slate-100">
                        {res.label}
                      </h3>
                      <div className="text-[11px] font-mono text-slate-500 dark:text-slate-400">
                        {res.engineId} · {res.backend} · {res.audio.sampleRate} Hz
                      </div>
                    </div>
                    <button
                      type="button"
                      onClick={() =>
                        setPreferredId((prev) => (prev === res.configId ? null : res.configId))
                      }
                      className={`inline-flex items-center gap-1 px-2.5 py-1 rounded-lg text-xs font-semibold border transition ${
                        isPreferred
                          ? 'bg-[#7C5CFF] border-[#7C5CFF] text-white'
                          : 'border-slate-200 dark:border-slate-700 text-slate-600 dark:text-slate-300 hover:border-[#7C5CFF]'
                      }`}
                    >
                      {isPreferred ? <Check className="w-3.5 h-3.5" /> : <Award className="w-3.5 h-3.5" />}
                      {isPreferred ? 'Preferred' : 'Mark Winner'}
                    </button>
                  </div>

                  <WaveformPlayer
                    samples={res.audio.samples}
                    sampleRate={res.audio.sampleRate}
                    compact
                    height={64}
                  />

                  {/* Real Measured Telemetry */}
                  <div className="rounded-lg border border-slate-200 dark:border-slate-800 bg-slate-50 dark:bg-[#0B0D12]/60 p-3">
                    <div className="flex items-center gap-1.5 text-[11px] font-semibold uppercase tracking-wider text-slate-500 dark:text-slate-400 mb-2">
                      <Activity className="w-3.5 h-3.5 text-[#7C5CFF]" />
                      Measured On-Device Telemetry
                    </div>
                    <div className="grid grid-cols-2 sm:grid-cols-3 gap-2 text-xs">
                      <div>
                        <span className="text-[10px] text-slate-400 block">Total Latency</span>
                        <strong className="font-mono">{res.totalLatencyMs.toFixed(0)} ms</strong>
                      </div>
                      <div>
                        <span className="text-[10px] text-slate-400 block">First-Chunk Latency</span>
                        <strong className="font-mono">{res.firstChunkLatencyMs.toFixed(0)} ms</strong>
                      </div>
                      <div>
                        <span className="text-[10px] text-slate-400 block">Real-Time Factor</span>
                        <strong className="font-mono">{res.realTimeFactor.toFixed(2)}x</strong>
                      </div>
                      <div>
                        <span className="text-[10px] text-slate-400 block">Output Duration</span>
                        <strong className="font-mono">{res.audio.durationSec.toFixed(2)} s</strong>
                      </div>
                      <div className="col-span-2">
                        <span className="text-[10px] text-slate-400 block">
                          JS Heap (performance.memory)
                        </span>
                        <strong className="font-mono">
                          {res.jsHeapUsedBytes !== null
                            ? formatBytes(res.jsHeapUsedBytes)
                            : 'Not exposed by browser'}
                        </strong>
                      </div>
                    </div>
                  </div>

                  {/* Human Listening Rubric (Zero fabricated scores) */}
                  <div className="space-y-2.5">
                    <div className="text-xs font-semibold text-slate-800 dark:text-slate-200">
                      Human Listening Rubric (1–5)
                    </div>
                    <div className="space-y-1.5">
                      {RUBRIC_CRITERIA.map((crit) => {
                        const current = res.ratings[crit.key];
                        return (
                          <div
                            key={crit.key}
                            className="flex items-center justify-between gap-2 text-xs"
                          >
                            <span className="text-slate-600 dark:text-slate-300">{crit.label}</span>
                            <div className="flex items-center gap-1">
                              {[1, 2, 3, 4, 5].map((score) => (
                                <button
                                  key={score}
                                  type="button"
                                  onClick={() => setRating(res.configId, crit.key, score)}
                                  className={`w-6 h-6 rounded text-[11px] font-mono font-semibold border transition ${
                                    current === score
                                      ? 'bg-[#7C5CFF] border-[#7C5CFF] text-white'
                                      : 'border-slate-200 dark:border-slate-700 text-slate-500 hover:border-[#7C5CFF]'
                                  }`}
                                >
                                  {score}
                                </button>
                              ))}
                            </div>
                          </div>
                        );
                      })}
                    </div>

                    <div className="flex flex-wrap gap-4 pt-2 border-t border-slate-200 dark:border-slate-800 text-xs text-slate-600 dark:text-slate-300">
                      <label className="inline-flex items-center gap-1.5 cursor-pointer">
                        <input
                          type="checkbox"
                          checked={res.defects.wordOmissions}
                          onChange={() => toggleDefect(res.configId, 'wordOmissions')}
                          className="accent-[#7C5CFF]"
                        />
                        Word Omissions
                      </label>
                      <label className="inline-flex items-center gap-1.5 cursor-pointer">
                        <input
                          type="checkbox"
                          checked={res.defects.repeatedWords}
                          onChange={() => toggleDefect(res.configId, 'repeatedWords')}
                          className="accent-[#7C5CFF]"
                        />
                        Repeated Words
                      </label>
                      <label className="inline-flex items-center gap-1.5 cursor-pointer">
                        <input
                          type="checkbox"
                          checked={res.defects.artifacts}
                          onChange={() => toggleDefect(res.configId, 'artifacts')}
                          className="accent-[#7C5CFF]"
                        />
                        Artifacts
                      </label>
                    </div>
                  </div>
                </div>
              );
            })}
          </div>

          <div className="rounded-xl border border-slate-200 dark:border-slate-800 bg-white dark:bg-[#121622] p-4 space-y-2">
            <label className="block text-xs font-semibold text-slate-800 dark:text-slate-200">
              Reviewer Listening Notes
            </label>
            <textarea
              rows={2}
              value={reviewerNotes}
              onChange={(e) => setReviewerNotes(e.target.value)}
              placeholder="Optional qualitative observations for your exported report..."
              className="w-full rounded-lg border border-slate-200 dark:border-slate-700 bg-slate-50 dark:bg-[#0B0D12] p-2.5 text-xs text-slate-900 dark:text-slate-100"
            />
          </div>
        </div>
      )}
    </div>
  );
}
