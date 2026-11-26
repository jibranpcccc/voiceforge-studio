/**
 * Comprehensive inline audio tag & vocal direction parser supporting free-form stage cues
 * (`[short pause]`, `[0.8s pause]`, `[deep breath]`, `[serious]`, `[low, ominous, slow]`,
 * `[very tense]`, `[sarcastically]`, `[gasps in shock]`, `[whispered]`, `[sigh]`, `[laugh]`, etc.)
 * for local narration synthesis.
 *
 * Responsibilities:
 * - Guarantee that bracketed vocal cues and stage directions are NEVER read aloud verbatim,
 *   while leaving bare numeric citations like `[1]` or `[2026]` untouched.
 * - Map flexible pause & breath cues (`[0.8s pause]`, `[pauses dramatically]`, `[deep breath]`,
 *   `[exhales slowly]`) to accurate boundary silence gaps (and Chatterbox breath tokens).
 * - Map 100+ emotion, tone, style, and adverb cues (with `very`/`slightly` intensity modifiers
 *   and comma/slash compounds) to per-chunk engine parameter overrides and subtle DSP shaping.
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
  kind: 'pause' | 'breath' | 'delivery' | 'sound' | 'stage-note';
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

const ARCHETYPE_PROFILES = {
  intrigued: {
    pocket: { temperature: 0.82 },
    chatterbox: { exaggeration: 0.72, temperature: 0.85 },
    dsp: { speedMultiplier: 1.02, eqHighDeltaDb: 1.2 },
  },
  serious: {
    pocket: { temperature: 0.58 },
    chatterbox: { exaggeration: 0.35, temperature: 0.65 },
    dsp: { speedMultiplier: 0.96, eqLowDeltaDb: 1.0, eqHighDeltaDb: -0.5 },
  },
  authoritative: {
    pocket: { temperature: 0.56 },
    chatterbox: { exaggeration: 0.42, temperature: 0.64 },
    dsp: { speedMultiplier: 0.96, eqLowDeltaDb: 1.6, eqMidDeltaDb: 0.8, gainDeltaDb: 0.5 },
  },
  tense: {
    pocket: { temperature: 0.76 },
    chatterbox: { exaggeration: 0.68, temperature: 0.78 },
    dsp: { speedMultiplier: 1.05, eqHighDeltaDb: 1.5, gainDeltaDb: 0.6 },
  },
  urgent: {
    pocket: { temperature: 0.80 },
    chatterbox: { exaggeration: 0.76, temperature: 0.82 },
    dsp: { speedMultiplier: 1.08, eqMidDeltaDb: 1.2, eqHighDeltaDb: 1.5, gainDeltaDb: 0.8 },
  },
  ominous: {
    pocket: { temperature: 0.62 },
    chatterbox: { exaggeration: 0.58, temperature: 0.66 },
    dsp: { speedMultiplier: 0.91, eqLowDeltaDb: 2.6, eqHighDeltaDb: -1.6, gainDeltaDb: -0.6 },
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
  excited: {
    pocket: { temperature: 0.88 },
    chatterbox: { exaggeration: 0.90, temperature: 0.90 },
    dsp: { speedMultiplier: 1.07, eqHighDeltaDb: 1.8, gainDeltaDb: 0.8 },
  },
  cheerful: {
    pocket: { temperature: 0.80 },
    chatterbox: { exaggeration: 0.70, temperature: 0.82 },
    dsp: { speedMultiplier: 1.04, eqHighDeltaDb: 1.4, gainDeltaDb: 0.4 },
  },
  shocked: {
    pocket: { temperature: 0.86 },
    chatterbox: { exaggeration: 0.92, temperature: 0.88 },
    dsp: { speedMultiplier: 1.05, eqHighDeltaDb: 2.0, gainDeltaDb: 0.9 },
  },
  calm: {
    pocket: { temperature: 0.55 },
    chatterbox: { exaggeration: 0.30, temperature: 0.62 },
    dsp: { speedMultiplier: 0.94, eqLowDeltaDb: 0.8, eqHighDeltaDb: -0.8 },
  },
  soft: {
    pocket: { temperature: 0.54 },
    chatterbox: { exaggeration: 0.28, temperature: 0.60 },
    dsp: { speedMultiplier: 0.95, eqLowDeltaDb: 0.5, eqHighDeltaDb: -1.0, gainDeltaDb: -1.2 },
  },
  warm: {
    pocket: { temperature: 0.66 },
    chatterbox: { exaggeration: 0.44, temperature: 0.70 },
    dsp: { speedMultiplier: 0.97, eqLowDeltaDb: 2.0, eqHighDeltaDb: -0.8 },
  },
  reflective: {
    pocket: { temperature: 0.58 },
    chatterbox: { exaggeration: 0.38, temperature: 0.64 },
    dsp: { speedMultiplier: 0.93, eqLowDeltaDb: 1.0, eqHighDeltaDb: -1.0, gainDeltaDb: -0.5 },
  },
  sad: {
    pocket: { temperature: 0.60 },
    chatterbox: { exaggeration: 0.55, temperature: 0.70 },
    dsp: { speedMultiplier: 0.91, eqLowDeltaDb: 1.0, eqHighDeltaDb: -1.5, gainDeltaDb: -1.0 },
  },
  weary: {
    pocket: { temperature: 0.54 },
    chatterbox: { exaggeration: 0.42, temperature: 0.62 },
    dsp: { speedMultiplier: 0.89, eqLowDeltaDb: 0.8, eqHighDeltaDb: -1.8, gainDeltaDb: -1.2 },
  },
  angry: {
    pocket: { temperature: 0.85 },
    chatterbox: { exaggeration: 0.95, temperature: 0.85 },
    dsp: { speedMultiplier: 1.06, eqMidDeltaDb: 1.8, eqHighDeltaDb: 1.2, gainDeltaDb: 1.2 },
  },
  shouting: {
    pocket: { temperature: 0.90 },
    chatterbox: { exaggeration: 1.10, temperature: 0.90 },
    dsp: { speedMultiplier: 1.07, eqMidDeltaDb: 2.4, eqHighDeltaDb: 1.8, gainDeltaDb: 2.2 },
  },
  sarcastic: {
    pocket: { temperature: 0.72 },
    chatterbox: { exaggeration: 0.58, temperature: 0.76 },
    dsp: { speedMultiplier: 0.96, eqMidDeltaDb: 1.0, eqHighDeltaDb: 0.8 },
  },
  deadpan: {
    pocket: { temperature: 0.48 },
    chatterbox: { exaggeration: 0.18, temperature: 0.55 },
    dsp: { speedMultiplier: 0.97, eqLowDeltaDb: 0.6, eqHighDeltaDb: -0.8 },
  },
  whisper: {
    pocket: { temperature: 0.62 },
    chatterbox: { exaggeration: 0.40, temperature: 0.72 },
    dsp: { speedMultiplier: 0.93, eqLowDeltaDb: -3.5, eqHighDeltaDb: 2.5, gainDeltaDb: -3.0 },
  },
  nervous: {
    pocket: { temperature: 0.78 },
    chatterbox: { exaggeration: 0.66, temperature: 0.82 },
    dsp: { speedMultiplier: 1.05, eqLowDeltaDb: -0.8, eqHighDeltaDb: 1.2, gainDeltaDb: -0.4 },
  },
  slow: {
    dsp: { speedMultiplier: 0.90 },
  },
  fast: {
    dsp: { speedMultiplier: 1.10 },
  },
  neutral: {
    pocket: { temperature: 0.70 },
    chatterbox: { exaggeration: 0.50, temperature: 0.80 },
  },
} satisfies Record<string, DeliveryPresetProfile>;

const KEYWORD_GROUPS: ReadonlyArray<readonly [keyof typeof ARCHETYPE_PROFILES, readonly string[]]> = [
  ['intrigued', ['intrigued', 'intriguing', 'curious', 'curiously', 'inquisitive', 'fascinated', 'wonder', 'wondering', 'quizzical', 'quizzically']],
  ['serious', ['serious', 'seriously', 'solemn', 'solemnly', 'grave', 'gravely', 'stern', 'sternly', 'sober', 'formal', 'documentary', 'matter-of-fact']],
  ['authoritative', ['authoritative', 'authoritatively', 'commanding', 'confident', 'confidently', 'assertive', 'bold', 'boldly', 'announcer', 'newscaster', 'breaking news']],
  ['tense', ['tense', 'tensely', 'tension', 'suspense', 'suspenseful', 'suspensefully', 'tight', 'tightly', 'strained', 'edge', 'edgy']],
  ['urgent', ['urgent', 'urgently', 'breathless', 'breathlessly', 'frantic', 'frantically', 'panicked', 'panic', 'hurried', 'rushed', 'alarmed']],
  ['ominous', ['ominous', 'ominously', 'menacing', 'menacingly', 'sinister', 'eerie', 'eerily', 'chilling', 'foreboding', 'threatening', 'creepily', 'creepy', 'dark', 'darkly']],
  ['dramatic', ['dramatic', 'dramatically', 'theatrical', 'cinematic', 'epic', 'climactic', 'emphatic', 'emphatically', 'powerful', 'powerfully', 'intense', 'intensely']],
  ['low', ['low', 'deep', 'deeply', 'bass', 'gruff', 'gravelly', 'resonant', 'raspy']],
  ['excited', ['excited', 'excitedly', 'energetic', 'energetically', 'enthusiastic', 'enthusiastically', 'hyped', 'thrilled', 'ecstatic', 'euphoric', 'triumphant', 'triumphantly']],
  ['cheerful', ['cheerful', 'cheerfully', 'happy', 'happily', 'upbeat', 'playful', 'playfully', 'amused', 'amusedly', 'bright', 'brightly', 'hopeful', 'hopefully', 'joyful', 'joyfully']],
  ['shocked', ['shocked', 'shock', 'amazed', 'astonished', 'surprised', 'stunned', 'awed', 'awe', 'disbelief', 'gasping']],
  ['calm', ['calm', 'calmly', 'gentle', 'gently', 'peaceful', 'peacefully', 'relaxed', 'soothing', 'serene', 'mildly']],
  ['soft', ['soft', 'softly', 'quiet', 'quietly', 'faint', 'subdued']],
  ['warm', ['warm', 'warmly', 'friendly', 'conversational', 'intimate', 'affectionate', 'tender', 'tenderly', 'empathetic', 'compassionate']],
  ['reflective', ['reflective', 'reflectively', 'thoughtful', 'thoughtfully', 'pensive', 'nostalgic', 'wistful', 'wistfully', 'meditative', 'philosophical', 'reverent']],
  ['sad', ['sad', 'sadly', 'melancholic', 'melancholy', 'sorrowful', 'heartbroken', 'mournful', 'somber', 'somberly', 'grief', 'regretful', 'regretfully', 'vulnerable', 'tearful', 'crying']],
  ['weary', ['weary', 'wearily', 'tired', 'tiredly', 'exhausted', 'fatigued', 'drained', 'heavy-hearted', 'resigned']],
  ['angry', ['angry', 'angrily', 'furious', 'furiously', 'fierce', 'fiercely', 'frustrated', 'irritated', 'annoyed', 'aggressive', 'aggressively', 'hostile', 'defiant', 'defiantly', 'heated']],
  ['shouting', ['shouting', 'shout', 'shouts', 'yelling', 'yell', 'yells', 'screaming', 'scream', 'booming', 'loud', 'loudly', 'roaring']],
  ['sarcastic', ['sarcastic', 'sarcastically', 'skeptical', 'skeptically', 'cynical', 'cynically', 'ironic', 'ironically', 'mocking', 'mockingly', 'dismissive', 'dismissively', 'smug', 'smugly', 'wry', 'wryly', 'dubious']],
  ['deadpan', ['deadpan', 'dry', 'dryly', 'flat', 'flatly', 'monotone', 'stoic', 'unemotional', 'robotic', 'detached']],
  ['whisper', ['whisper', 'whispers', 'whispering', 'whispered', 'hushed', 'secretive', 'secretively', 'conspiratorial', 'mumbling', 'mumbled', 'mumble', 'murmur', 'murmuring', 'under breath']],
  ['nervous', ['nervous', 'nervously', 'anxious', 'anxiously', 'hesitant', 'hesitantly', 'uneasy', 'timid', 'timidly', 'shy', 'shyly', 'uncertain', 'shaky', 'trembling']],
  ['slow', ['slow', 'slowly', 'deliberate', 'deliberately', 'measured', 'unhurried', 'lingering', 'drawn-out']],
  ['fast', ['fast', 'quickly', 'quick', 'rapid', 'rapidly', 'brisk', 'briskly', 'snappy']],
  ['neutral', ['neutral', 'normal', 'default', 'reset', 'natural']],
];

const DELIVERY_LOOKUP: Record<string, DeliveryPresetProfile> = (() => {
  const map: Record<string, DeliveryPresetProfile> = {};
  for (const [archetype, words] of KEYWORD_GROUPS) {
    const profile = ARCHETYPE_PROFILES[archetype];
    for (const w of words) {
      map[w] = profile;
    }
  }
  return map;
})();

const AMPLIFIER_WORDS = new Set([
  'very',
  'extremely',
  'super',
  'highly',
  'deeply',
  'heavily',
  'sharply',
  'strongly',
  'really',
  'utterly',
  'incredibly',
  'extra',
]);

const SOFTENER_WORDS = new Set([
  'slightly',
  'mildly',
  'lightly',
  'barely',
  'faintly',
  'subtly',
  'somewhat',
  'hint',
  'touch',
  'bit',
]);

const CHATTERBOX_SOUND_ALIASES: Record<string, string> = {
  laugh: '[laughter]',
  laughs: '[laughter]',
  laughing: '[laughter]',
  laughter: '[laughter]',
  chuckle: '[giggle]',
  chuckles: '[giggle]',
  chuckling: '[giggle]',
  giggle: '[giggle]',
  giggles: '[giggle]',
  giggling: '[giggle]',
  guffaw: '[guffaw]',
  sigh: '[sigh]',
  sighs: '[sigh]',
  sighing: '[sigh]',
  inhale: '[inhale]',
  inhales: '[inhale]',
  inhaling: '[inhale]',
  exhale: '[exhale]',
  exhales: '[exhale]',
  exhaling: '[exhale]',
  gasp: '[gasp]',
  gasps: '[gasp]',
  gasping: '[gasp]',
  groan: '[groan]',
  groans: '[groan]',
  groaning: '[groan]',
  sniff: '[sniff]',
  sniffs: '[sniff]',
  snort: '[sniff]',
  cough: '[cough]',
  coughs: '[cough]',
  coughing: '[cough]',
  'clear throat': '[clear_throat]',
  'clears throat': '[clear_throat]',
  'clearing throat': '[clear_throat]',
  clear_throat: '[clear_throat]',
  shhh: '[shhh]',
  shh: '[shhh]',
  shush: '[shhh]',
  shushes: '[shhh]',
  uh: '[UH]',
  um: '[UM]',
};

// Match `[...]` only when at least one ASCII letter is present inside, so bare citations like `[1]` stay untouched.
const TAG_TOKEN_RE = /\[(?=[a-zA-Z0-9.,:'/\s-]*[a-zA-Z])([a-zA-Z0-9][a-zA-Z0-9 ,._:'/-]{0,100})\]/g;

function clamp(value: number, min: number, max: number): number {
  return Math.min(max, Math.max(min, value));
}

function mergeScaledNumber(
  values: number[],
  baseline: number,
  scale: number,
  min: number,
  max: number
): number | undefined {
  if (values.length === 0) return undefined;
  const avg = values.reduce((sum, v) => sum + v, 0) / values.length;
  const scaled = baseline + (avg - baseline) * scale;
  return Number(clamp(scaled, min, max).toFixed(2));
}

function combineDspHints(
  hintsList: readonly ChunkDspHints[],
  intensityScale: number
): ChunkDspHints | undefined {
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
  if (hasSpeed) {
    const scaledSpeed = 1.0 + (speedMult - 1.0) * intensityScale;
    out.speedMultiplier = Number(clamp(scaledSpeed, 0.85, 1.18).toFixed(3));
  }
  if (hasLow) out.eqLowDeltaDb = Number(clamp(lowSum * intensityScale, -6, 6).toFixed(2));
  if (hasMid) out.eqMidDeltaDb = Number(clamp(midSum * intensityScale, -4, 4).toFixed(2));
  if (hasHigh) out.eqHighDeltaDb = Number(clamp(highSum * intensityScale, -6, 6).toFixed(2));
  if (hasGain) out.gainDeltaDb = Number(clamp(gainSum * intensityScale, -6, 4).toFixed(2));

  return Object.keys(out).length > 0 ? out : undefined;
}

function parsePauseDuration(lower: string): number | null {
  // Timed pauses: `[pause:1.5s]`, `[0.8s pause]`, `[2 sec pause]`, `[750ms pause]`, `[silence 1.2s]`, `[1.5s]`
  const timedPatterns = [
    /^(?:pause|pauses|silence|wait|break)\s*[: ]?\s*(\d+(?:\.\d+)?)\s*(ms|msec|millis|s|sec|secs|second|seconds)?$/,
    /^(\d+(?:\.\d+)?)\s*(ms|msec|millis|s|sec|secs|second|seconds)\s*(?:pause|silence|wait|break)?$/,
  ];
  for (const re of timedPatterns) {
    const m = lower.match(re);
    if (m) {
      const rawNum = Number(m[1]);
      const unit = m[2] ?? 's';
      const ms = unit.startsWith('m') ? rawNum : rawNum * 1000;
      if (Number.isFinite(ms)) {
        return Math.round(clamp(ms, 100, 5000));
      }
    }
  }

  // Named pauses & hesitations
  if (
    /^(?:short|brief|tiny|quick|slight|small)\s+(?:pause|silence|break)$/.test(lower) ||
    lower === 'short pause' ||
    lower === 'brief pause'
  ) {
    return 450;
  }
  if (/^(?:(?:short|quick)\s+)?beat$/.test(lower)) {
    return 350;
  }
  if (/^(?:long|dramatic|extended|heavy|awkward|big|long dramatic)\s+(?:pause|silence|beat|break)$/.test(lower)) {
    return 1400;
  }
  if (
    lower === 'pauses dramatically' ||
    lower === 'dramatic silence' ||
    lower === 'dramatic beat'
  ) {
    return 1400;
  }
  if (
    lower === 'pause' ||
    lower === 'pauses' ||
    lower === 'medium pause' ||
    lower === 'silence' ||
    lower === 'moment of silence' ||
    lower === 'hesitates' ||
    lower === 'hesitation' ||
    lower === 'trails off'
  ) {
    return 800;
  }

  return null;
}

function parseBreathCue(lower: string): { pauseMs: number; token: string } | null {
  if (
    /^(?:takes?\s+(?:a\s+)?)?(?:deep|sharp|big|heavy|quick|short)?\s*breath$/.test(lower) ||
    /^(?:inhale|inhales|inhaling|breathes?\s+in)(?:\s+\w+)?$/.test(lower)
  ) {
    return { pauseMs: 420, token: '[inhale]' };
  }
  if (/^(?:exhale|exhales|exhaling|breathes?\s+out|lets?\s+out\s+(?:a\s+)?breath)(?:\s+\w+)?$/.test(lower)) {
    return { pauseMs: 480, token: '[exhale]' };
  }
  return null;
}

/**
 * Parse the inner text of any bracketed cue `[...]` (without surrounding brackets).
 */
export function parseAudioTag(rawInner: string): ParsedAudioTagResult | null {
  const cleaned = rawInner.trim().replace(/\s+/g, ' ');
  if (!cleaned) return null;
  const lower = cleaned.toLowerCase();

  // 1. Timed or named pauses
  const pauseMs = parsePauseDuration(lower);
  if (pauseMs !== null) {
    return { kind: 'pause', displayLabel: cleaned, pauseMs };
  }

  // 2. Breath cues (timed breath pause + Chatterbox inhale/exhale token)
  const breath = parseBreathCue(lower);
  if (breath) {
    return {
      kind: 'breath',
      displayLabel: cleaned,
      pauseMs: breath.pauseMs,
      chatterboxToken: breath.token,
    };
  }

  // 3. Exact single sound token (`[laugh]`, `[sigh]`, `[clear throat]`)
  const normalizedSoundKey = lower.replace(/[-_]+/g, ' ').trim();
  const exactSoundToken =
    CHATTERBOX_SOUND_ALIASES[lower] ?? CHATTERBOX_SOUND_ALIASES[normalizedSoundKey];
  if (exactSoundToken) {
    return {
      kind: 'sound',
      displayLabel: cleaned,
      chatterboxToken: exactSoundToken,
    };
  }

  // 4. Multi-word / compound parsing: split on commas, slashes, or ' and '
  const segments = lower
    .split(/,|\/|\band\b|\bwith\b|\bin\b/)
    .map((s) => s.trim())
    .filter(Boolean);

  let intensityScale = 1.0;
  let embeddedSoundToken: string | undefined;
  let whisperActive = false;
  const matchedProfiles: DeliveryPresetProfile[] = [];

  // Check multi-word phrase matches first (e.g. "breaking news", "under breath", "clear throat")
  for (const seg of segments) {
    const cleanSeg = seg.replace(/[-_]+/g, ' ').trim();
    if (CHATTERBOX_SOUND_ALIASES[cleanSeg]) {
      embeddedSoundToken = embeddedSoundToken ?? CHATTERBOX_SOUND_ALIASES[cleanSeg];
    }
    if (DELIVERY_LOOKUP[cleanSeg]) {
      if (cleanSeg.includes('whisper')) whisperActive = true;
      matchedProfiles.push(DELIVERY_LOOKUP[cleanSeg]);
      continue;
    }

    const words = cleanSeg.split(/\s+/).filter(Boolean);
    for (const word of words) {
      if (AMPLIFIER_WORDS.has(word)) {
        intensityScale = Math.max(intensityScale, 1.35);
        continue;
      }
      if (SOFTENER_WORDS.has(word)) {
        intensityScale = Math.min(intensityScale, 0.6);
        continue;
      }
      if (word.startsWith('whisper')) {
        whisperActive = true;
      }
      if (CHATTERBOX_SOUND_ALIASES[word]) {
        embeddedSoundToken = embeddedSoundToken ?? CHATTERBOX_SOUND_ALIASES[word];
        // Pure sound action without separate emotion word: keep going so "softly" / "nervously" also match
        continue;
      }
      if (DELIVERY_LOOKUP[word]) {
        matchedProfiles.push(DELIVERY_LOOKUP[word]);
      }
    }
  }

  if (matchedProfiles.length > 0 || embeddedSoundToken) {
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
    const mergedPocketTemp = mergeScaledNumber(pocketTemps, 0.7, intensityScale, 0.3, 1.1);
    if (mergedPocketTemp !== undefined) pocketParameters.temperature = mergedPocketTemp;

    const chatterboxParameters: Record<string, number> = {};
    const mergedExag = mergeScaledNumber(cbExag, 0.5, intensityScale, 0.0, 1.5);
    const mergedCbTemp = mergeScaledNumber(cbTemps, 0.75, intensityScale, 0.2, 1.2);
    if (mergedExag !== undefined) chatterboxParameters.exaggeration = mergedExag;
    if (mergedCbTemp !== undefined) chatterboxParameters.temperature = mergedCbTemp;

    const chatterboxToken = embeddedSoundToken ?? (whisperActive ? '[whisper]' : undefined);
    const dspHints = combineDspHints(dspList, intensityScale);

    // If ONLY a sound action matched (e.g. `[laughs]` / `[clears throat]` with no delivery modifiers), emit `sound`.
    if (matchedProfiles.length === 0 && embeddedSoundToken) {
      return {
        kind: 'sound',
        displayLabel: cleaned,
        chatterboxToken: embeddedSoundToken,
      };
    }

    return {
      kind: 'delivery',
      displayLabel: cleaned,
      ...(chatterboxToken ? { chatterboxToken } : {}),
      pocketParameters,
      chatterboxParameters,
      dspHints,
    };
  }

  // 5. Unrecognized stage direction cue (strip from spoken words, retain cue badge)
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
 * Split a single paragraph at inline `[tag]` pauses, breaths, and delivery direction switches.
 * - Pause tags terminate the current span and attach `pauseAfterMs` (`explicitPauseAfterMs: true`).
 * - Breath cues flush the preceding phrase with a breath pause and inject `[inhale]`/`[exhale]`
 *   for Chatterbox (stripped cleanly on Pocket TTS).
 * - Delivery tags start a new span with the new direction parameters/DSP hints, inheriting
 *   active delivery state across mid-sentence `[short pause]` tags.
 * - Pure sound tokens (`[sigh]`, `[laugh]`, `[clears throat]`) stay inline for `chatterbox`
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

    if (parsed.kind === 'breath') {
      flushSpan(parsed.pauseMs ?? 420);
      if (engineId === 'chatterbox' && parsed.chatterboxToken) {
        buffer += `${parsed.chatterboxToken} `;
      }
      continue;
    }

    if (parsed.kind === 'sound') {
      if (engineId === 'chatterbox' && parsed.chatterboxToken) {
        buffer += ` ${parsed.chatterboxToken} `;
      }
      continue;
    }

    // Delivery / action+emotion / stage-note switches the active vocal direction for subsequent speech
    flushSpan(undefined);
    const labelLower = parsed.displayLabel.toLowerCase();
    if (
      labelLower === 'neutral' ||
      labelLower === 'normal' ||
      labelLower === 'reset' ||
      labelLower === 'default'
    ) {
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
