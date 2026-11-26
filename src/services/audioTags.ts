/**
 * Inline audio tag & vocal direction parser (`[short pause]`, `[serious]`, `[low, dramatic]`,
 * `[whisper]`, `[sigh]`, `[laugh]`, etc.) for local narration synthesis.
 *
 * Responsibilities:
 * - Never let bracketed vocal cues or stage directions be spoken verbatim as text.
 * - Map pause tags (`[short pause]`, `[long pause]`, `[pause:1.5s]`) to exact boundary silence.
 * - Map vocal delivery tags (`[intrigued]`, `[serious]`, `[tense]`, `[low, dramatic]`, etc.) to
 *   per-chunk engine parameter overrides (`exaggeration`, `temperature`) and subtle DSP shaping.
 * - Pass Chatterbox ONNX's native paralinguistic tokens (`[laughter]`, `[sigh]`, `[whisper]`, etc.)
 *   through when synthesizing with Chatterbox, while stripping them cleanly for Pocket TTS.
 */

import type { ChunkDspHints, EngineId } from '../types';

export interface QuickInsertAudioTag {
  tag: string;
  label: string;
  category: 'pause' | 'delivery' | 'sound';
  hint: string;
}

export const QUICK_INSERT_AUDIO_TAGS: readonly QuickInsertAudioTag[] = [
  { tag: '[short pause]', label: 'Short Pause', category: 'pause', hint: '450ms silence beat' },
  { tag: '[long pause]', label: 'Long Pause', category: 'pause', hint: '1.4s dramatic beat' },
  { tag: '[intrigued]', label: 'Intrigued', category: 'delivery', hint: 'Curious, bright inflection' },
  { tag: '[serious]', label: 'Serious', category: 'delivery', hint: 'Steady, authoritative pace' },
  { tag: '[tense]', label: 'Tense', category: 'delivery', hint: 'Tighter cadence, crisp edge' },
  { tag: '[low, dramatic]', label: 'Low, Dramatic', category: 'delivery', hint: 'Slower pace, deeper warmth' },
  { tag: '[calm]', label: 'Calm', category: 'delivery', hint: 'Relaxed, gentle delivery' },
  { tag: '[whisper]', label: 'Whisper', category: 'delivery', hint: 'Hushed tone (+Chatterbox token)' },
  { tag: '[sigh]', label: 'Sigh', category: 'sound', hint: 'Chatterbox breath cue (stripped on Pocket)' },
  { tag: '[laugh]', label: 'Laugh', category: 'sound', hint: 'Chatterbox laughter (stripped on Pocket)' },
];

export interface ParsedAudioTagResult {
  kind: 'pause' | 'delivery' | 'sound' | 'stage-note';
  displayLabel: string;
  pauseMs?: number;
  chatterboxToken?: string;
  pocketParameters?: Record<string, number>;
  chatterboxParameters?: Record<string, number>;
  dspHints?: ChunkDspHints;
}

export interface DirectedTextSpan {
  text: string;
  directionTags: string[];
  parameterOverrides: Record<string, number>;
  dspHints?: ChunkDspHints;
  pauseAfterMs?: number;
  explicitPauseAfterMs: boolean;
}

interface DeliveryPresetProfile {
  pocket?: { temperature?: number };
  chatterbox?: { exaggeration?: number; temperature?: number };
  dsp?: ChunkDspHints;
}

const DELIVERY_PROFILES: Record<string, DeliveryPresetProfile> = {
  intrigued: {
    pocket: { temperature: 0.82 },
    chatterbox: { exaggeration: 0.72, temperature: 0.85 },
    dsp: { speedMultiplier: 1.02, eqHighDeltaDb: 1.2 },
  },
  curious: {
    pocket: { temperature: 0.82 },
    chatterbox: { exaggeration: 0.70, temperature: 0.85 },
    dsp: { speedMultiplier: 1.02, eqHighDeltaDb: 1.0 },
  },
  serious: {
    pocket: { temperature: 0.58 },
    chatterbox: { exaggeration: 0.35, temperature: 0.65 },
    dsp: { speedMultiplier: 0.96, eqLowDeltaDb: 1.0, eqHighDeltaDb: -0.5 },
  },
  solemn: {
    pocket: { temperature: 0.56 },
    chatterbox: { exaggeration: 0.35, temperature: 0.62 },
    dsp: { speedMultiplier: 0.93, eqLowDeltaDb: 1.4, eqHighDeltaDb: -0.8 },
  },
  grave: {
    pocket: { temperature: 0.56 },
    chatterbox: { exaggeration: 0.40, temperature: 0.62 },
    dsp: { speedMultiplier: 0.92, eqLowDeltaDb: 1.8, eqHighDeltaDb: -1.0 },
  },
  tense: {
    pocket: { temperature: 0.76 },
    chatterbox: { exaggeration: 0.68, temperature: 0.78 },
    dsp: { speedMultiplier: 1.05, eqHighDeltaDb: 1.5, gainDeltaDb: 0.6 },
  },
  urgent: {
    pocket: { temperature: 0.80 },
    chatterbox: { exaggeration: 0.75, temperature: 0.82 },
    dsp: { speedMultiplier: 1.08, eqMidDeltaDb: 1.2, eqHighDeltaDb: 1.5, gainDeltaDb: 0.8 },
  },
  dramatic: {
    pocket: { temperature: 0.74 },
    chatterbox: { exaggeration: 0.82, temperature: 0.76 },
    dsp: { speedMultiplier: 0.93, eqLowDeltaDb: 1.8, eqHighDeltaDb: -0.6 },
  },
  low: {
    pocket: { temperature: 0.64 },
    chatterbox: { exaggeration: 0.48, temperature: 0.68 },
    dsp: { speedMultiplier: 0.94, eqLowDeltaDb: 2.5, eqHighDeltaDb: -1.4, gainDeltaDb: -0.8 },
  },
  deep: {
    pocket: { temperature: 0.62 },
    chatterbox: { exaggeration: 0.45, temperature: 0.66 },
    dsp: { speedMultiplier: 0.94, eqLowDeltaDb: 2.8, eqHighDeltaDb: -1.5, gainDeltaDb: -0.5 },
  },
  excited: {
    pocket: { temperature: 0.88 },
    chatterbox: { exaggeration: 0.90, temperature: 0.90 },
    dsp: { speedMultiplier: 1.07, eqHighDeltaDb: 1.8, gainDeltaDb: 0.8 },
  },
  energetic: {
    pocket: { temperature: 0.86 },
    chatterbox: { exaggeration: 0.85, temperature: 0.88 },
    dsp: { speedMultiplier: 1.06, eqMidDeltaDb: 1.0, eqHighDeltaDb: 1.5, gainDeltaDb: 0.6 },
  },
  calm: {
    pocket: { temperature: 0.55 },
    chatterbox: { exaggeration: 0.30, temperature: 0.62 },
    dsp: { speedMultiplier: 0.94, eqLowDeltaDb: 0.8, eqHighDeltaDb: -0.8 },
  },
  gentle: {
    pocket: { temperature: 0.54 },
    chatterbox: { exaggeration: 0.28, temperature: 0.60 },
    dsp: { speedMultiplier: 0.94, eqLowDeltaDb: 0.6, eqHighDeltaDb: -1.0, gainDeltaDb: -0.6 },
  },
  soft: {
    pocket: { temperature: 0.54 },
    chatterbox: { exaggeration: 0.28, temperature: 0.60 },
    dsp: { speedMultiplier: 0.95, eqLowDeltaDb: 0.5, eqHighDeltaDb: -1.2, gainDeltaDb: -1.5 },
  },
  sad: {
    pocket: { temperature: 0.60 },
    chatterbox: { exaggeration: 0.55, temperature: 0.70 },
    dsp: { speedMultiplier: 0.91, eqLowDeltaDb: 1.0, eqHighDeltaDb: -1.5, gainDeltaDb: -1.0 },
  },
  melancholic: {
    pocket: { temperature: 0.58 },
    chatterbox: { exaggeration: 0.52, temperature: 0.68 },
    dsp: { speedMultiplier: 0.90, eqLowDeltaDb: 1.0, eqHighDeltaDb: -1.6, gainDeltaDb: -1.0 },
  },
  angry: {
    pocket: { temperature: 0.85 },
    chatterbox: { exaggeration: 0.95, temperature: 0.85 },
    dsp: { speedMultiplier: 1.06, eqMidDeltaDb: 1.8, eqHighDeltaDb: 1.2, gainDeltaDb: 1.2 },
  },
  intense: {
    pocket: { temperature: 0.82 },
    chatterbox: { exaggeration: 0.88, temperature: 0.82 },
    dsp: { speedMultiplier: 1.04, eqMidDeltaDb: 1.4, eqHighDeltaDb: 1.0, gainDeltaDb: 1.0 },
  },
  whisper: {
    pocket: { temperature: 0.62 },
    chatterbox: { exaggeration: 0.40, temperature: 0.72 },
    dsp: { speedMultiplier: 0.93, eqLowDeltaDb: -3.5, eqHighDeltaDb: 2.5, gainDeltaDb: -3.0 },
  },
  whispering: {
    pocket: { temperature: 0.62 },
    chatterbox: { exaggeration: 0.40, temperature: 0.72 },
    dsp: { speedMultiplier: 0.93, eqLowDeltaDb: -3.5, eqHighDeltaDb: 2.5, gainDeltaDb: -3.0 },
  },
  hushed: {
    pocket: { temperature: 0.60 },
    chatterbox: { exaggeration: 0.36, temperature: 0.68 },
    dsp: { speedMultiplier: 0.94, eqLowDeltaDb: -2.2, eqHighDeltaDb: 1.4, gainDeltaDb: -2.2 },
  },
  slow: {
    dsp: { speedMultiplier: 0.90 },
  },
  fast: {
    dsp: { speedMultiplier: 1.10 },
  },
  warm: {
    dsp: { eqLowDeltaDb: 2.0, eqHighDeltaDb: -0.8 },
  },
  neutral: {
    pocket: { temperature: 0.70 },
    chatterbox: { exaggeration: 0.50, temperature: 0.80 },
  },
  normal: {
    pocket: { temperature: 0.70 },
    chatterbox: { exaggeration: 0.50, temperature: 0.80 },
  },
};

const CHATTERBOX_SOUND_ALIASES: Record<string, string> = {
  laugh: '[laughter]',
  laughs: '[laughter]',
  laughing: '[laughter]',
  laughter: '[laughter]',
  chuckle: '[giggle]',
  chuckles: '[giggle]',
  giggle: '[giggle]',
  guffaw: '[guffaw]',
  sigh: '[sigh]',
  sighs: '[sigh]',
  inhale: '[inhale]',
  exhale: '[exhale]',
  gasp: '[gasp]',
  groan: '[groan]',
  sniff: '[sniff]',
  cough: '[cough]',
  'clear throat': '[clear_throat]',
  clear_throat: '[clear_throat]',
  shhh: '[shhh]',
  shush: '[shhh]',
  uh: '[UH]',
  um: '[UM]',
};

const TAG_TOKEN_RE = /\[([a-zA-Z][a-zA-Z0-9 ,._:-]{0,44})\]/g;

function clamp(value: number, min: number, max: number): number {
  return Math.min(max, Math.max(min, value));
}

function mergeNumberField(
  values: number[],
  min: number,
  max: number
): number | undefined {
  if (values.length === 0) return undefined;
  const avg = values.reduce((sum, v) => sum + v, 0) / values.length;
  return Number(clamp(avg, min, max).toFixed(2));
}

function combineDspHints(hintsList: readonly ChunkDspHints[]): ChunkDspHints | undefined {
  if (hintsList.length === 0) return undefined;

  let speedMult = 1.0;
  let hasSpeed = false;
  let lowSum = 0;
  let hasLow = false;
  let midSum = 0;
  let hasMid = false;
  let highSum = 0;
  let hasHigh = false;
  let gainSum = 0;
  let hasGain = false;

  for (const h of hintsList) {
    if (typeof h.speedMultiplier === 'number') {
      speedMult *= h.speedMultiplier;
      hasSpeed = true;
    }
    if (typeof h.eqLowDeltaDb === 'number') {
      lowSum += h.eqLowDeltaDb;
      hasLow = true;
    }
    if (typeof h.eqMidDeltaDb === 'number') {
      midSum += h.eqMidDeltaDb;
      hasMid = true;
    }
    if (typeof h.eqHighDeltaDb === 'number') {
      highSum += h.eqHighDeltaDb;
      hasHigh = true;
    }
    if (typeof h.gainDeltaDb === 'number') {
      gainSum += h.gainDeltaDb;
      hasGain = true;
    }
  }

  const out: ChunkDspHints = {};
  if (hasSpeed) out.speedMultiplier = Number(clamp(speedMult, 0.85, 1.18).toFixed(3));
  if (hasLow) out.eqLowDeltaDb = Number(clamp(lowSum, -6, 6).toFixed(2));
  if (hasMid) out.eqMidDeltaDb = Number(clamp(midSum, -4, 4).toFixed(2));
  if (hasHigh) out.eqHighDeltaDb = Number(clamp(highSum, -6, 6).toFixed(2));
  if (hasGain) out.gainDeltaDb = Number(clamp(gainSum, -6, 4).toFixed(2));

  return Object.keys(out).length > 0 ? out : undefined;
}

/**
 * Parse the inner text of a bracketed cue `[...]` (without the surrounding brackets).
 */
export function parseAudioTag(rawInner: string): ParsedAudioTagResult | null {
  const cleaned = rawInner.trim().replace(/\s+/g, ' ');
  if (!cleaned) return null;
  const lower = cleaned.toLowerCase();

  // 1. Pause cues
  if (lower === 'short pause' || lower === 'brief pause') {
    return { kind: 'pause', displayLabel: cleaned, pauseMs: 450 };
  }
  if (lower === 'beat') {
    return { kind: 'pause', displayLabel: cleaned, pauseMs: 350 };
  }
  if (lower === 'pause' || lower === 'medium pause') {
    return { kind: 'pause', displayLabel: cleaned, pauseMs: 800 };
  }
  if (lower === 'long pause') {
    return { kind: 'pause', displayLabel: cleaned, pauseMs: 1400 };
  }
  const timedPauseMatch = lower.match(/^pause\s*[: ]?\s*(\d+(?:\.\d+)?)\s*(ms|s)?$/);
  if (timedPauseMatch) {
    const rawNum = Number(timedPauseMatch[1]);
    const unit = timedPauseMatch[2] ?? 's';
    const ms = unit === 'ms' ? rawNum : rawNum * 1000;
    if (Number.isFinite(ms)) {
      return {
        kind: 'pause',
        displayLabel: cleaned,
        pauseMs: Math.round(clamp(ms, 100, 5000)),
      };
    }
  }

  // 2. Standalone Chatterbox paralinguistic sound tokens
  const normalizedSoundKey = lower.replace(/[-_]+/g, ' ').trim();
  const chatterboxToken =
    CHATTERBOX_SOUND_ALIASES[lower] ?? CHATTERBOX_SOUND_ALIASES[normalizedSoundKey];
  if (chatterboxToken) {
    return {
      kind: 'sound',
      displayLabel: cleaned,
      chatterboxToken,
    };
  }

  // 3. Single or compound comma-separated delivery cues (e.g., `[low, dramatic]`)
  const parts = lower
    .split(',')
    .map((p) => p.trim())
    .filter((p) => p.length > 0);

  const matchedProfiles: DeliveryPresetProfile[] = [];
  let whisperActive = false;

  for (const part of parts) {
    if (part === 'whisper' || part === 'whispering') {
      whisperActive = true;
    }
    const direct = DELIVERY_PROFILES[part];
    if (direct) {
      matchedProfiles.push(direct);
      continue;
    }
    // Check individual space-separated words inside a descriptor like `very tense`
    for (const word of part.split(/\s+/)) {
      if (word === 'whisper' || word === 'whispering') {
        whisperActive = true;
      }
      if (DELIVERY_PROFILES[word]) {
        matchedProfiles.push(DELIVERY_PROFILES[word]);
      }
    }
  }

  if (matchedProfiles.length > 0) {
    const pocketTemps = matchedProfiles
      .map((p) => p.pocket?.temperature)
      .filter((v): v is number => typeof v === 'number');
    const cbExag = matchedProfiles
      .map((p) => p.chatterbox?.exaggeration)
      .filter((v): v is number => typeof v === 'number');
    const cbTemps = matchedProfiles
      .map((p) => p.chatterbox?.temperature)
      .filter((v): v is number => typeof v === 'number');
    const dspList = matchedProfiles
      .map((p) => p.dsp)
      .filter((d): d is ChunkDspHints => d !== undefined);

    const pocketParameters: Record<string, number> = {};
    const mergedPocketTemp = mergeNumberField(pocketTemps, 0.3, 1.1);
    if (mergedPocketTemp !== undefined) pocketParameters.temperature = mergedPocketTemp;

    const chatterboxParameters: Record<string, number> = {};
    const mergedExag = mergeNumberField(cbExag, 0.0, 1.5);
    const mergedCbTemp = mergeNumberField(cbTemps, 0.2, 1.2);
    if (mergedExag !== undefined) chatterboxParameters.exaggeration = mergedExag;
    if (mergedCbTemp !== undefined) chatterboxParameters.temperature = mergedCbTemp;

    return {
      kind: 'delivery',
      displayLabel: cleaned,
      ...(whisperActive ? { chatterboxToken: '[whisper]' } : {}),
      pocketParameters,
      chatterboxParameters,
      dspHints: combineDspHints(dspList),
    };
  }

  // 4. Unrecognized stage direction cue (strip from spoken words, retain cue badge)
  return {
    kind: 'stage-note',
    displayLabel: cleaned,
  };
}

function selectEngineParamsForDirective(
  parsed: ParsedAudioTagResult,
  engineId?: EngineId
): Record<string, number> {
  if (engineId === 'chatterbox') {
    return parsed.chatterboxParameters ? { ...parsed.chatterboxParameters } : {};
  }
  return parsed.pocketParameters ? { ...parsed.pocketParameters } : {};
}

/**
 * Split a single paragraph at inline `[tag]` pauses and delivery direction switches.
 * - Pause tags terminate the current span and attach `pauseAfterMs` (`explicitPauseAfterMs: true`).
 * - Delivery tags start a new span with the new direction parameters/DSP hints, inheriting
 *   active delivery state across mid-sentence `[short pause]` tags.
 * - Sound tokens (`[sigh]`, `[laugh]`) stay inline for `chatterbox` (`[sigh]`, `[laughter]`)
 *   and are stripped cleanly for `pocket-tts`.
 */
export function splitParagraphByAudioTags(
  paragraph: string,
  engineId?: EngineId
): DirectedTextSpan[] {
  if (!paragraph || !paragraph.trim()) return [];
  if (!paragraph.includes('[')) {
    return [
      {
        text: paragraph.replace(/[ \t\f\v]+/g, ' ').trim(),
        directionTags: [],
        parameterOverrides: {},
        explicitPauseAfterMs: false,
      },
    ];
  }

  const spans: DirectedTextSpan[] = [];
  let activeDirections: string[] = [];
  let activeParams: Record<string, number> = {};
  let activeDsp: ChunkDspHints | undefined;
  let buffer = '';
  let lastIndex = 0;

  const flushSpan = (explicitPauseMs?: number) => {
    const cleanText = buffer.replace(/[ \t\f\v]+/g, ' ').trim();
    buffer = '';
    if (cleanText.length > 0) {
      spans.push({
        text: cleanText,
        directionTags: [...activeDirections],
        parameterOverrides: { ...activeParams },
        ...(activeDsp ? { dspHints: { ...activeDsp } } : {}),
        ...(explicitPauseMs !== undefined
          ? { pauseAfterMs: explicitPauseMs, explicitPauseAfterMs: true }
          : { explicitPauseAfterMs: false }),
      });
    } else if (explicitPauseMs !== undefined && spans.length > 0) {
      // Attach consecutive pause tag to previous emitted span
      const prev = spans[spans.length - 1];
      prev.pauseAfterMs = Math.min(5000, (prev.pauseAfterMs ?? 0) + explicitPauseMs);
      prev.explicitPauseAfterMs = true;
    }
  };

  TAG_TOKEN_RE.lastIndex = 0;
  let match: RegExpExecArray | null;
  while ((match = TAG_TOKEN_RE.exec(paragraph)) !== null) {
    buffer += paragraph.slice(lastIndex, match.index);
    lastIndex = match.index + match[0].length;

    const parsed = parseAudioTag(match[1]);
    if (!parsed) {
      continue;
    }

    if (parsed.kind === 'pause') {
      flushSpan(parsed.pauseMs ?? 600);
      continue;
    }

    if (parsed.kind === 'sound') {
      if (engineId === 'chatterbox' && parsed.chatterboxToken) {
        buffer += ` ${parsed.chatterboxToken} `;
      }
      // On Pocket TTS (or unsupported sounds), strip cleanly so it is never spoken aloud.
      continue;
    }

    // Delivery / stage-note switches the active vocal direction for subsequent speech
    flushSpan(undefined);
    const labelLower = parsed.displayLabel.toLowerCase();
    if (labelLower === 'neutral' || labelLower === 'normal' || labelLower === 'reset') {
      activeDirections = [];
      activeParams = {};
      activeDsp = undefined;
    } else {
      activeDirections = [parsed.displayLabel];
      activeParams = selectEngineParamsForDirective(parsed, engineId);
      activeDsp = parsed.dspHints ? { ...parsed.dspHints } : undefined;
      if (engineId === 'chatterbox' && parsed.chatterboxToken) {
        buffer += `${parsed.chatterboxToken} `;
      }
    }
  }

  buffer += paragraph.slice(lastIndex);
  flushSpan(undefined);

  return spans;
}

/**
 * Strip all `[tag]` stage/delivery directives from a chunk string for a given engine
 * (keeping Chatterbox native tokens only when `engineId === 'chatterbox'`).
 */
export function stripAudioTagsForEngine(text: string, engineId?: EngineId): string {
  if (!text || !text.includes('[')) return text;
  const cleaned = text.replace(TAG_TOKEN_RE, (_full, inner: string) => {
    const parsed = parseAudioTag(inner);
    if (!parsed) return '';
    if (engineId === 'chatterbox' && parsed.chatterboxToken) {
      return parsed.chatterboxToken;
    }
    return '';
  });
  return cleaned.replace(/[ \t\f\v]+/g, ' ').trim();
}

/**
 * Count recognized bracketed `[tag]` directives present in a full script.
 */
export function countAudioTags(scriptText: string): number {
  if (!scriptText || !scriptText.includes('[')) return 0;
  let count = 0;
  TAG_TOKEN_RE.lastIndex = 0;
  while (TAG_TOKEN_RE.exec(scriptText) !== null) {
    count += 1;
  }
  return count;
}

/**
 * Strip bracketed `[tag]` directives so word-count and WPM duration estimates measure spoken words only.
 */
export function stripAudioTagsForCounting(scriptText: string): string {
  if (!scriptText || !scriptText.includes('[')) return scriptText;
  return scriptText.replace(TAG_TOKEN_RE, ' ');
}
