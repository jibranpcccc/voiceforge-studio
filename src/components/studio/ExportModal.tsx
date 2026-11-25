import { useState } from 'react';
import {
  Download,
  FileArchive,
  FileCode2,
  FileText,
  Info,
  X,
} from 'lucide-react';
import {
  SRT_BOUNDARY_NOTE,
  exportAudio,
  exportSegmentsZip,
  generateSrtFromSegments,
  getSampleRateResamplingNote,
  masterAudio,
} from '../../audio';
import type {
  AudioBufferData,
  ExportFormat,
  ExportSampleRate,
  MasteringSettings,
  NarrationProject,
  ScriptChunk,
} from '../../types';
import { triggerBrowserDownload } from './studioHelpers';

export interface ExportModalProps {
  open: boolean;
  onClose: () => void;
  projectTitle: string;
  project: NarrationProject | null;
  masteredAudio: AudioBufferData | null;
  rawChunkMap: Map<string, AudioBufferData>;
  chunks: ScriptChunk[];
  mastering: MasteringSettings;
  sentencePauseMs: number;
  paragraphPauseMs: number;
}

const FORMAT_OPTIONS: Array<{ value: ExportFormat; label: string }> = [
  { value: 'wav16', label: 'WAV 16-bit PCM (Lossless)' },
  { value: 'wav24', label: 'WAV 24-bit PCM (Studio Master)' },
  { value: 'mp3_128', label: 'MP3 128 kbps' },
  { value: 'mp3_192', label: 'MP3 192 kbps' },
  { value: 'mp3_256', label: 'MP3 256 kbps' },
  { value: 'mp3_320', label: 'MP3 320 kbps' },
];

export function ExportModal({
  open,
  onClose,
  projectTitle,
  project,
  masteredAudio,
  rawChunkMap,
  chunks,
  mastering,
  sentencePauseMs,
  paragraphPauseMs,
}: ExportModalProps) {
  const [format, setFormat] = useState<ExportFormat>('wav16');
  const [sampleRate, setSampleRate] = useState<ExportSampleRate>('native');
  const [channels, setChannels] = useState<'mono' | 'stereo'>('mono');
  const [applyMasteringOnSegment, setApplyMasteringOnSegment] = useState(true);
  const [includeSrtInZip, setIncludeSrtInZip] = useState(true);
  const [filename, setFilename] = useState(
    projectTitle.trim().replace(/[^a-zA-Z0-9._-]+/g, '_') || 'voiceforge-narration'
  );
  const [selectedChunkId, setSelectedChunkId] = useState<string>('');
  const [busy, setBusy] = useState(false);
  const [statusMessage, setStatusMessage] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  if (!open) return null;

  const completedChunks = chunks.filter(
    (c) => c.status === 'completed' && rawChunkMap.has(c.id)
  );
  const activeSelectedChunkId =
    selectedChunkId && rawChunkMap.has(selectedChunkId)
      ? selectedChunkId
      : completedChunks[0]?.id ?? '';

  const nativeRate = masteredAudio?.sampleRate ?? 24000;
  const resampleNote = getSampleRateResamplingNote(nativeRate, sampleRate);

  const safeBaseName =
    filename.trim().replace(/[^a-zA-Z0-9._-]+/g, '_') || 'voiceforge-narration';

  const handleDownloadFull = () => {
    if (!masteredAudio) return;
    setBusy(true);
    setError(null);
    setStatusMessage(null);
    try {
      const result = exportAudio(
        masteredAudio,
        {
          format,
          sampleRate,
          channels,
          // Full masteredAudio already includes MasteringPanel DSP when passed in
          applyMastering: false,
          normalizeOutput: false,
          filename: safeBaseName,
          metadata: {
            title: projectTitle,
            artist: 'VoiceForge Studio',
          },
        },
        mastering
      );
      triggerBrowserDownload(result.bytes, result.mimeType, result.filename);
      setStatusMessage(
        result.notes.length > 0
          ? `Downloaded ${result.filename}. ${result.notes.join(' ')}`
          : `Downloaded ${result.filename} (${result.sampleRate} Hz, ${result.channels}ch).`
      );
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setBusy(false);
    }
  };

  const handleDownloadSingleChunk = () => {
    const targetChunk = completedChunks.find((c) => c.id === activeSelectedChunkId);
    if (!targetChunk) return;
    const rawAudio = rawChunkMap.get(targetChunk.id);
    if (!rawAudio) return;
    setBusy(true);
    setError(null);
    setStatusMessage(null);
    try {
      const audioToExport = applyMasteringOnSegment
        ? masterAudio(rawAudio, mastering)
        : rawAudio;
      const result = exportAudio(
        audioToExport,
        {
          format,
          sampleRate,
          channels,
          applyMastering: false,
          normalizeOutput: false,
          filename: `${safeBaseName}_paragraph_${targetChunk.index + 1}`,
          metadata: {
            title: `${projectTitle} - Part ${targetChunk.index + 1}`,
            artist: 'VoiceForge Studio',
          },
        },
        mastering
      );
      triggerBrowserDownload(result.bytes, result.mimeType, result.filename);
      setStatusMessage(`Downloaded ${result.filename}.`);
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setBusy(false);
    }
  };

  const handleDownloadZip = () => {
    if (completedChunks.length === 0) return;
    setBusy(true);
    setError(null);
    setStatusMessage(null);
    try {
      const segments = completedChunks.map((chunk) => ({
        filename: `paragraph_${chunk.index + 1}`,
        audio: rawChunkMap.get(chunk.id)!,
        text: chunk.rawText,
        pauseAfterMs: chunk.pauseAfterMs,
      }));
      const zipBytes = exportSegmentsZip(
        segments,
        {
          format,
          sampleRate,
          channels,
          applyMastering: applyMasteringOnSegment,
          normalizeOutput: false,
          metadata: {
            title: projectTitle,
            artist: 'VoiceForge Studio',
          },
        },
        {
          masteringSettings: mastering,
          includeSrt: includeSrtInZip,
          includeManifest: true,
          defaultPauseMs: sentencePauseMs,
        }
      );
      triggerBrowserDownload(zipBytes, 'application/zip', `${safeBaseName}_segments.zip`);
      setStatusMessage(
        `Exported ${segments.length} segments to ${safeBaseName}_segments.zip.`
      );
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setBusy(false);
    }
  };

  const handleDownloadSrt = () => {
    if (completedChunks.length === 0) return;
    setError(null);
    const srtResult = generateSrtFromSegments(
      completedChunks.map((c) => ({
        text: c.rawText,
        durationSec: rawChunkMap.get(c.id)?.durationSec ?? c.audioDurationSec ?? 0,
        pauseAfterMs: c.pauseAfterMs ?? paragraphPauseMs,
      })),
      { defaultPauseMs: sentencePauseMs }
    );
    triggerBrowserDownload(srtResult.srt, 'application/x-subrip;charset=utf-8', `${safeBaseName}.srt`);
    setStatusMessage(
      `Exported ${srtResult.cues.length} subtitle cues to ${safeBaseName}.srt.`
    );
  };

  const handleExportProjectJson = () => {
    if (!project) return;
    const json = JSON.stringify(project, null, 2);
    triggerBrowserDownload(json, 'application/json', `${safeBaseName}.voiceforge.json`);
    setStatusMessage(`Exported project metadata JSON (${safeBaseName}.voiceforge.json).`);
  };

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/70 backdrop-blur-sm p-4">
      <div className="w-full max-w-2xl max-h-[90vh] overflow-y-auto rounded-2xl border border-slate-200 dark:border-slate-800 bg-white dark:bg-[#121622] shadow-2xl">
        <div className="flex items-center justify-between px-5 py-4 border-b border-slate-200 dark:border-slate-800">
          <div>
            <h2 className="text-base font-semibold text-slate-900 dark:text-slate-100">
              Export Narration &amp; Assets
            </h2>
            <p className="text-xs text-slate-500 dark:text-slate-400">
              All audio encoding runs 100% locally in your browser with synthetic provenance metadata.
            </p>
          </div>
          <button
            type="button"
            onClick={onClose}
            className="p-1.5 rounded-lg text-slate-400 hover:text-slate-200 hover:bg-slate-800 transition"
          >
            <X className="w-4 h-4" />
          </button>
        </div>

        <div className="p-5 space-y-5">
          {/* Format, Sample Rate, Channels, Filename */}
          <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
            <div className="space-y-1.5">
              <label className="block text-xs font-medium text-slate-700 dark:text-slate-300">
                Audio Format
              </label>
              <select
                value={format}
                onChange={(e) => setFormat(e.target.value as ExportFormat)}
                className="w-full rounded-lg border border-slate-200 dark:border-slate-700 bg-slate-50 dark:bg-[#0B0D12] px-3 py-2 text-xs text-slate-900 dark:text-slate-100 focus:border-[#7C5CFF] focus:outline-none"
              >
                {FORMAT_OPTIONS.map((opt) => (
                  <option key={opt.value} value={opt.value}>
                    {opt.label}
                  </option>
                ))}
              </select>
            </div>

            <div className="space-y-1.5">
              <label className="block text-xs font-medium text-slate-700 dark:text-slate-300">
                Sample Rate
              </label>
              <select
                value={String(sampleRate)}
                onChange={(e) => {
                  const val = e.target.value;
                  setSampleRate(val === 'native' ? 'native' : (Number(val) as 44100 | 48000));
                }}
                className="w-full rounded-lg border border-slate-200 dark:border-slate-700 bg-slate-50 dark:bg-[#0B0D12] px-3 py-2 text-xs text-slate-900 dark:text-slate-100 focus:border-[#7C5CFF] focus:outline-none"
              >
                <option value="native">Native ({nativeRate} Hz default)</option>
                <option value="44100">44,100 Hz (CD / Podcast)</option>
                <option value="48000">48,000 Hz (Video / Broadcast)</option>
              </select>
            </div>

            <div className="space-y-1.5">
              <label className="block text-xs font-medium text-slate-700 dark:text-slate-300">
                Channels
              </label>
              <select
                value={channels}
                onChange={(e) => setChannels(e.target.value as 'mono' | 'stereo')}
                className="w-full rounded-lg border border-slate-200 dark:border-slate-700 bg-slate-50 dark:bg-[#0B0D12] px-3 py-2 text-xs text-slate-900 dark:text-slate-100 focus:border-[#7C5CFF] focus:outline-none"
              >
                <option value="mono">Mono (Voice Standard)</option>
                <option value="stereo">Dual-Mono Stereo</option>
              </select>
            </div>

            <div className="space-y-1.5">
              <label className="block text-xs font-medium text-slate-700 dark:text-slate-300">
                Base Filename
              </label>
              <input
                type="text"
                value={filename}
                onChange={(e) => setFilename(e.target.value)}
                className="w-full rounded-lg border border-slate-200 dark:border-slate-700 bg-slate-50 dark:bg-[#0B0D12] px-3 py-2 text-xs text-slate-900 dark:text-slate-100 focus:border-[#7C5CFF] focus:outline-none"
              />
            </div>
          </div>

          {/* Honest Upsampling Disclosure */}
          <div className="rounded-xl border border-amber-500/20 bg-amber-500/10 p-3 flex items-start gap-2.5 text-xs text-amber-800 dark:text-amber-200">
            <Info className="w-4 h-4 shrink-0 mt-0.5 text-amber-500" />
            <div className="space-y-1">
              <p className="font-medium">Sample-Rate Disclosure</p>
              <p className="text-[11px] opacity-90">
                {resampleNote ??
                  `Engines synthesize natively at ${nativeRate} Hz. Selecting 44,100 Hz or 48,000 Hz resamples for DAW/video compatibility only — upsampling does NOT add original audio detail above ${Math.floor(nativeRate / 2)} Hz.`}
              </p>
            </div>
          </div>

          {/* Primary Actions */}
          <div className="space-y-3">
            <button
              type="button"
              disabled={!masteredAudio || busy}
              onClick={handleDownloadFull}
              className="w-full flex items-center justify-center gap-2 rounded-xl bg-[#7C5CFF] hover:bg-[#6A48F5] text-white py-2.5 px-4 text-sm font-semibold disabled:opacity-40 disabled:cursor-not-allowed transition"
            >
              <Download className="w-4 h-4" />
              Download Full Mastered Narration
            </button>

            {/* Individual Paragraph Download */}
            <div className="rounded-xl border border-slate-200 dark:border-slate-800 p-3 space-y-2.5">
              <div className="flex flex-wrap items-center justify-between gap-2">
                <span className="text-xs font-semibold text-slate-800 dark:text-slate-200">
                  Individual Paragraph Export
                </span>
                <label className="inline-flex items-center gap-1.5 text-[11px] text-slate-500 dark:text-slate-400 cursor-pointer">
                  <input
                    type="checkbox"
                    checked={applyMasteringOnSegment}
                    onChange={(e) => setApplyMasteringOnSegment(e.target.checked)}
                    className="accent-[#7C5CFF]"
                  />
                  Apply mastering DSP to segments
                </label>
              </div>
              <div className="flex gap-2">
                <select
                  value={activeSelectedChunkId}
                  disabled={completedChunks.length === 0}
                  onChange={(e) => setSelectedChunkId(e.target.value)}
                  className="flex-1 min-w-0 rounded-lg border border-slate-200 dark:border-slate-700 bg-slate-50 dark:bg-[#0B0D12] px-2.5 py-1.5 text-xs text-slate-900 dark:text-slate-100"
                >
                  {completedChunks.length === 0 ? (
                    <option value="">No completed paragraphs yet</option>
                  ) : (
                    completedChunks.map((c) => (
                      <option key={c.id} value={c.id}>
                        #{c.index + 1}: {c.rawText.slice(0, 60)}
                        {c.rawText.length > 60 ? '...' : ''}
                      </option>
                    ))
                  )}
                </select>
                <button
                  type="button"
                  disabled={completedChunks.length === 0 || busy}
                  onClick={handleDownloadSingleChunk}
                  className="inline-flex items-center gap-1.5 px-3 py-1.5 rounded-lg text-xs font-medium border border-slate-200 dark:border-slate-700 hover:bg-slate-100 dark:hover:bg-slate-800 text-slate-800 dark:text-slate-200 disabled:opacity-40 transition"
                >
                  <Download className="w-3.5 h-3.5" />
                  Download Paragraph
                </button>
              </div>
            </div>

            {/* ZIP, SRT, Project JSON */}
            <div className="grid grid-cols-1 sm:grid-cols-3 gap-2.5">
              <div className="rounded-xl border border-slate-200 dark:border-slate-800 p-3 space-y-2">
                <button
                  type="button"
                  disabled={completedChunks.length === 0 || busy}
                  onClick={handleDownloadZip}
                  className="w-full inline-flex items-center justify-center gap-1.5 rounded-lg border border-slate-200 dark:border-slate-700 py-2 px-3 text-xs font-medium text-slate-800 dark:text-slate-200 hover:bg-slate-100 dark:hover:bg-slate-800 disabled:opacity-40 transition"
                >
                  <FileArchive className="w-3.5 h-3.5 text-[#7C5CFF]" />
                  Multi-Segment ZIP
                </button>
                <label className="flex items-center gap-1.5 text-[11px] text-slate-500 dark:text-slate-400 cursor-pointer">
                  <input
                    type="checkbox"
                    checked={includeSrtInZip}
                    onChange={(e) => setIncludeSrtInZip(e.target.checked)}
                    className="accent-[#7C5CFF]"
                  />
                  Include SRT &amp; manifest
                </label>
              </div>

              <div className="rounded-xl border border-slate-200 dark:border-slate-800 p-3 space-y-2">
                <button
                  type="button"
                  disabled={completedChunks.length === 0 || busy}
                  onClick={handleDownloadSrt}
                  className="w-full inline-flex items-center justify-center gap-1.5 rounded-lg border border-slate-200 dark:border-slate-700 py-2 px-3 text-xs font-medium text-slate-800 dark:text-slate-200 hover:bg-slate-100 dark:hover:bg-slate-800 disabled:opacity-40 transition"
                >
                  <FileText className="w-3.5 h-3.5 text-[#7C5CFF]" />
                  Export SRT Subtitles
                </button>
                <p className="text-[10px] leading-tight text-slate-500 dark:text-slate-400">
                  {SRT_BOUNDARY_NOTE}
                </p>
              </div>

              <div className="rounded-xl border border-slate-200 dark:border-slate-800 p-3 space-y-2">
                <button
                  type="button"
                  disabled={!project}
                  onClick={handleExportProjectJson}
                  className="w-full inline-flex items-center justify-center gap-1.5 rounded-lg border border-slate-200 dark:border-slate-700 py-2 px-3 text-xs font-medium text-slate-800 dark:text-slate-200 hover:bg-slate-100 dark:hover:bg-slate-800 disabled:opacity-40 transition"
                >
                  <FileCode2 className="w-3.5 h-3.5 text-[#7C5CFF]" />
                  Export Project JSON
                </button>
                <p className="text-[10px] leading-tight text-slate-500 dark:text-slate-400">
                  Portable project settings, script, and pronunciation rules.
                </p>
              </div>
            </div>
          </div>

          {statusMessage && (
            <div className="rounded-lg border border-emerald-500/20 bg-emerald-500/10 px-3 py-2 text-xs text-emerald-700 dark:text-emerald-300">
              {statusMessage}
            </div>
          )}
          {error && (
            <div className="rounded-lg border border-rose-500/20 bg-rose-500/10 px-3 py-2 text-xs text-rose-700 dark:text-rose-300">
              {error}
            </div>
          )}
        </div>
      </div>
    </div>
  );
}
