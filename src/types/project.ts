/**
 * Narration studio project, chunk queue, pronunciation rules, and preset contracts.
 */

import type { MasteringSettings, PreprocessingOptions } from './audio';
import type { ExecutionMode } from './models';

export type ChunkStatus =
  | 'pending'
  | 'queued'
  | 'synthesizing'
  | 'completed'
  | 'failed'
  | 'cancelled';

export interface ChunkDspHints {
  /** Subtle per-chunk WSOLA speed multiplier derived from inline direction tags (0.85–1.18). */
  speedMultiplier?: number;
  /** Low-shelf EQ delta in dB (-6 to +6). */
  eqLowDeltaDb?: number;
  /** Mid-band presence EQ delta in dB (-4 to +4). */
  eqMidDeltaDb?: number;
  /** High-shelf air/brightness EQ delta in dB (-6 to +6). */
  eqHighDeltaDb?: number;
  /** Gentle output trim delta in dB (-6 to +4). */
  gainDeltaDb?: number;
}

export interface ScriptChunk {
  /** Unique chunk ID. */
  id: string;
  /** Zero-based position in the narration script. */
  index: number;
  /** Original raw text segment before pronunciation expansion. */
  rawText: string;
  /** Normalized text after pronunciation & abbreviation rules. */
  normalizedText: string;
  /** Optional pause duration appended after this chunk in milliseconds. */
  pauseAfterMs: number;
  /** Whether `pauseAfterMs` was set explicitly by an inline pause tag like `[short pause]`. */
  explicitPauseAfterMs?: boolean;
  /** Optional inline voice direction / delivery cues active for this chunk. */
  directionTags?: string[];
  /** Optional per-chunk DSP hints applied during non-destructive mastering. */
  dspHints?: ChunkDspHints;
  /** Optional per-chunk engine parameter overrides. */
  parameterOverrides?: Record<string, number | string | boolean>;
  /** Current synthesis status. */
  status: ChunkStatus;
  /** Duration of generated audio in seconds once completed. */
  audioDurationSec?: number;
  /** Reference key to locally cached audio buffer in IndexedDB/OPFS. */
  cachedAudioKey?: string;
  /** Generation time in milliseconds for diagnostics. */
  generationTimeMs?: number;
  /** Error message if status is 'failed'. */
  errorMessage?: string;
}

export interface GenerationQueueState {
  /** Whether queue processing is actively running. */
  isRunning: boolean;
  /** Whether queue is paused after current chunk. */
  isPaused: boolean;
  /** ID of the chunk currently being synthesized, if any. */
  activeChunkId: string | null;
  /** Total chunks in the active job. */
  totalChunks: number;
  /** Count of completed chunks. */
  completedChunks: number;
  /** Count of failed chunks. */
  failedChunks: number;
  /** Estimated remaining generation time in seconds, if known. */
  estimatedRemainingSec: number | null;
}

export interface PronunciationRule {
  /** Unique rule ID. */
  id: string;
  /** Exact word, acronym, or regex pattern to match. */
  pattern: string;
  /** Replacement spoken text or phonetic respelling. */
  replacement: string;
  /** Whether pattern is evaluated as a regular expression. */
  isRegex: boolean;
  /** Whether matching is case-sensitive. */
  caseSensitive: boolean;
  /** Whether this rule is enabled. */
  enabled: boolean;
  /** Optional user note describing the rule. */
  note?: string;
}

export type StudioPresetId =
  | 'studio-quality'
  | 'natural-narration'
  | 'documentary'
  | 'educational'
  | 'storytelling'
  | 'fast-preview'
  | 'custom';

export interface StudioPresetConfig {
  id: StudioPresetId;
  name: string;
  description: string;
  /** Preferred execution mode for this preset. */
  executionMode: ExecutionMode;
  /** Preferred engine parameter defaults (e.g. temperature, lsdSteps, speed). */
  engineParameters: Record<string, number | string | boolean>;
  /** Default pause between sentences in milliseconds. */
  sentencePauseMs: number;
  /** Default pause between paragraphs in milliseconds. */
  paragraphPauseMs: number;
  /** Default crossfade between stitched chunks in milliseconds. */
  chunkCrossfadeMs: number;
  /** Target chunk character length range for optimal prosody. */
  maxChunkChars: number;
  /** Default mastering settings associated with this preset. */
  mastering: MasteringSettings;
}

export interface NarrationProject {
  /** Unique project ID (UUID). */
  id: string;
  /** Project title. */
  name: string;
  /** Optional project description. */
  description?: string;
  /** ID of the selected VoiceProfile. */
  voiceProfileId: string | null;
  /** ID of the selected VoiceCloningEngine. */
  engineId: string;
  /** Execution mode chosen for this project. */
  executionMode: ExecutionMode;
  /** Active studio preset ID. */
  presetId: StudioPresetId;
  /** Full raw script text entered by the user. */
  scriptText: string;
  /** Ordered list of script chunks. */
  chunks: ScriptChunk[];
  /** Custom pronunciation dictionary rules for this project. */
  pronunciationRules: PronunciationRule[];
  /** Active preprocessing settings for reference audio. */
  preprocessing: PreprocessingOptions;
  /** Active mastering settings for final output. */
  mastering: MasteringSettings;
  /** Inter-sentence pause in milliseconds. */
  sentencePauseMs: number;
  /** Inter-paragraph pause in milliseconds. */
  paragraphPauseMs: number;
  /** Crossfade overlap between stitched chunks in milliseconds. */
  chunkCrossfadeMs: number;
  /** Current engine parameter values. */
  engineParameters: Record<string, number | string | boolean>;
  /** ISO-8601 creation timestamp. */
  createdAt: string;
  /** ISO-8601 last modified timestamp. */
  updatedAt: string;
}
