/**
 * Intelligent long-form script segmentation for local TTS synthesis.
 *
 * Splits tens of thousands of characters into ordered chunks respecting:
 * - Paragraph boundaries (`\n+` / `\n\n+`)
 * - Sentence boundaries while preserving abbreviations, decimal/currency/version numbers,
 *   ellipses, and quoted dialogue attributions
 * - Engine-specific maximum chunk character budgets without splitting words
 *   (unless a single unspaced token exceeds `maxCharsPerChunk`)
 * - 100% content preservation invariant across sequential chunks
 */

import type { EngineId, PronunciationRule, ScriptChunk } from '../types';
import { applyPronunciationRules } from './pronunciation';

export const DEFAULT_MAX_CHARS_BY_ENGINE: Record<string, number> = {
  'pocket-tts': 260,
  chatterbox: 280,
  'chatterbox-turbo': 280,
};

export const DEFAULT_MAX_CHARS_PER_CHUNK = 260;

export interface SegmenterOptions {
  /** Maximum characters per chunk (defaults to engine-specific limit or 260). */
  maxCharsPerChunk?: number;
  /** Optional engine ID used to pick default `maxCharsPerChunk` when omitted. */
  engineId?: EngineId;
  /** Pause inserted after non-paragraph-final chunks in ms (default: 280). */
  sentencePauseMs?: number;
  /** Pause inserted after the final chunk of a paragraph in ms (default: 560). */
  paragraphPauseMs?: number;
  /** Optional pronunciation rules applied only to `normalizedText`. */
  pronunciationRules?: readonly PronunciationRule[];
  /** Optional deterministic prefix for generated chunk IDs. */
  idPrefix?: string;
}

export interface SegmentedChunk {
  /** Zero-based sequential order index across the full script. */
  orderIndex: number;
  /** Alias matching `ScriptChunk.index`. */
  index: number;
  /** Zero-based paragraph index. */
  paragraphIndex: number;
  /** Whether this chunk ends its paragraph. */
  isParagraphEnd: boolean;
  /** Raw text slice preserving original wording/punctuation. */
  text: string;
  /** Normalized text with pronunciation rules applied (if provided). */
  normalizedText: string;
  /** Recommended trailing pause in milliseconds. */
  pauseAfterMs: number;
  /** Character count of `text`. */
  charCount: number;
  /** Word count of `text`. */
  wordCount: number;
}

export interface WordAndCharCounts {
  words: number;
  chars: number;
  charsNoSpaces: number;
  paragraphs: number;
}

/**
 * Standard abbreviations (lowercase, trailing dot stripped) that should not trigger
 * a sentence boundary split.
 */
const SINGLE_WORD_ABBREVIATIONS = new Set([
  'dr',
  'mr',
  'mrs',
  'ms',
  'prof',
  'sr',
  'jr',
  'st',
  'vs',
  'etc',
  'no',
  'fig',
  'inc',
  'ltd',
  'rev',
  'gen',
  'col',
  'lt',
  'sgt',
  'capt',
  'gov',
  'pres',
  'vol',
  'ch',
  'sec',
  'dept',
  'est',
  'approx',
  'jan',
  'feb',
  'mar',
  'apr',
  'aug',
  'sept',
  'sep',
  'oct',
  'nov',
  'dec',
  'mt',
  'ft',
  'ave',
  'blvd',
  'rd',
  'ln',
  'co',
  'corp',
  'al',
]);

/** Multi-period abbreviations (matched case-insensitively with periods intact). */
const MULTI_PERIOD_ABBREV_RE =
  /(?:^|[\s("“'‘])(?:e\.g|i\.e|u\.s|u\.s\.a|u\.k|e\.u|a\.m|p\.m|ph\.d|m\.d|b\.a|m\.a|b\.s|m\.s)\.\s*$/i;

const CLOSING_PUNCT_CHARS = new Set(['"', "'", '”', '’', ')', ']', '»']);
const OPENING_QUOTE_OR_PAREN_RE = /^["'“‘(\[«]/;

/**
 * Return the recommended `maxCharsPerChunk` for a given engine ID.
 */
export function getDefaultMaxCharsForEngine(engineId?: EngineId): number {
  if (!engineId) return DEFAULT_MAX_CHARS_PER_CHUNK;
  return DEFAULT_MAX_CHARS_BY_ENGINE[engineId] ?? DEFAULT_MAX_CHARS_PER_CHUNK;
}

/**
 * Count words, characters, non-whitespace characters, and paragraphs in a script.
 */
export function countWordsAndChars(text: string): WordAndCharCounts {
  if (!text) {
    return { words: 0, chars: 0, charsNoSpaces: 0, paragraphs: 0 };
  }
  const trimmed = text.trim();
  const words = trimmed ? trimmed.split(/\s+/).length : 0;
  const chars = text.length;
  const charsNoSpaces = text.replace(/\s+/g, '').length;
  const paragraphs = trimmed
    ? text
        .split(/\r?\n+/)
        .map((p) => p.trim())
        .filter((p) => p.length > 0).length
    : 0;

  return { words, chars, charsNoSpaces, paragraphs };
}

/**
 * Estimate spoken narration duration in seconds from word count (default 150 WPM).
 */
export function estimateNarrationDurationSec(
  text: string,
  wordsPerMinute: number = 150
): number {
  const { words } = countWordsAndChars(text);
  if (words === 0) return 0;
  const safeWpm =
    Number.isFinite(wordsPerMinute) && wordsPerMinute > 0 ? wordsPerMinute : 150;
  return (words / safeWpm) * 60;
}

function normalizeInlineWhitespace(text: string): string {
  return text.replace(/[ \t\f\v]+/g, ' ').trim();
}

function isDigit(ch: string | undefined): boolean {
  return ch !== undefined && ch >= '0' && ch <= '9';
}

function isLowerCaseLetter(ch: string | undefined): boolean {
  return ch !== undefined && /\p{Ll}/u.test(ch);
}

function isSentenceStartCandidate(ch: string | undefined): boolean {
  if (!ch) return false;
  if (/\p{Lu}|\p{Nd}/u.test(ch)) return true;
  return OPENING_QUOTE_OR_PAREN_RE.test(ch);
}

/**
 * Inspect whether a period at `periodIndex` in `paragraph` belongs to a known
 * abbreviation, initial, decimal, currency amount, version string, or ellipsis.
 */
function isNonTerminatingPeriod(paragraph: string, periodIndex: number): boolean {
  const prevChar = paragraph[periodIndex - 1];
  const nextChar = paragraph[periodIndex + 1];

  // Decimal, currency, or version number (e.g. 3.14, $12.50, v1.2.3)
  if (isDigit(prevChar) && isDigit(nextChar)) {
    return true;
  }

  // Ellipsis (`...`)
  if (prevChar === '.' || nextChar === '.') {
    return true;
  }

  // Period inside a domain/identifier/version token without following whitespace
  if (nextChar !== undefined && !/\s/.test(nextChar) && !CLOSING_PUNCT_CHARS.has(nextChar)) {
    return true;
  }

  const prefixSlice = paragraph.slice(Math.max(0, periodIndex - 20), periodIndex + 1);
  if (MULTI_PERIOD_ABBREV_RE.test(prefixSlice)) {
    return true;
  }

  // Extract token immediately preceding the period
  let start = periodIndex - 1;
  while (start >= 0 && /[A-Za-z0-9'.-]/.test(paragraph[start])) {
    start -= 1;
  }
  const token = paragraph.slice(start + 1, periodIndex);
  if (!token) return false;

  const lower = token.toLowerCase();
  if (SINGLE_WORD_ABBREVIATIONS.has(lower)) {
    return true;
  }

  // Single uppercase initial (e.g. "J. R. R. Tolkien")
  if (/^[A-Z]$/.test(token)) {
    return true;
  }

  // Multi-dot acronym token like "U.S" or "e.g" before final dot
  if (/^(?:[A-Za-z]\.)+[A-Za-z]$/.test(token)) {
    return true;
  }

  return false;
}

/**
 * Split a single paragraph into sentence-level units while preserving abbreviations,
 * decimals/currencies/versions, ellipses, and dialogue attribution tags.
 */
export function splitParagraphIntoSentences(paragraph: string): string[] {
  const clean = normalizeInlineWhitespace(paragraph);
  if (!clean) return [];

  const sentences: string[] = [];
  let start = 0;
  let i = 0;

  while (i < clean.length) {
    const ch = clean[i];
    const isTerminalPunct = ch === '.' || ch === '!' || ch === '?' || ch === '…';

    if (!isTerminalPunct) {
      i += 1;
      continue;
    }

    if (ch === '.' && isNonTerminatingPeriod(clean, i)) {
      i += 1;
      continue;
    }

    // Consume consecutive terminal punctuation (e.g., `...`, `?!`, `!!`)
    let end = i + 1;
    while (
      end < clean.length &&
      (clean[end] === '.' || clean[end] === '!' || clean[end] === '?' || clean[end] === '…')
    ) {
      end += 1;
    }

    // Consume trailing closing quotes or parentheses attached to the sentence end
    let sawClosingQuote = false;
    while (end < clean.length && CLOSING_PUNCT_CHARS.has(clean[end])) {
      sawClosingQuote = true;
      end += 1;
    }

    // Must be at end of paragraph or followed by whitespace
    if (end < clean.length && !/\s/.test(clean[end])) {
      i = end;
      continue;
    }

    // Look ahead past whitespace to decide if this actually starts a new sentence
    let nextNonWs = end;
    while (nextNonWs < clean.length && /\s/.test(clean[nextNonWs])) {
      nextNonWs += 1;
    }

    if (nextNonWs >= clean.length) {
      const slice = clean.slice(start).trim();
      if (slice) sentences.push(slice);
      start = clean.length;
      break;
    }

    const nextChar = clean[nextNonWs];

    // Dialogue attribution like `"Wait!" she shouted.` or `"Really?" he asked.`
    if (sawClosingQuote && isLowerCaseLetter(nextChar)) {
      i = nextNonWs;
      continue;
    }

    // Ellipsis mid-sentence followed by lowercase (`Wait... what happened?`)
    if ((ch === '…' || clean.slice(i, end).includes('..')) && !isSentenceStartCandidate(nextChar)) {
      i = nextNonWs;
      continue;
    }

    // Standard sentence boundary
    if (isSentenceStartCandidate(nextChar) || ch === '!' || ch === '?') {
      const slice = clean.slice(start, end).trim();
      if (slice) sentences.push(slice);
      start = nextNonWs;
      i = nextNonWs;
      continue;
    }

    i = nextNonWs;
  }

  if (start < clean.length) {
    const tail = clean.slice(start).trim();
    if (tail) sentences.push(tail);
  }

  return sentences;
}

/**
 * Split an oversized single sentence on clause punctuation or whitespace boundaries
 * without ever splitting inside a word unless a single word exceeds `maxChars`.
 */
function splitOversizedText(text: string, maxChars: number): string[] {
  const clean = normalizeInlineWhitespace(text);
  if (!clean) return [];
  if (clean.length <= maxChars) return [clean];

  const pieces: string[] = [];
  let remaining = clean;

  while (remaining.length > maxChars) {
    const window = remaining.slice(0, maxChars + 1);

    // 1. Prefer natural clause delimiter (semicolon, colon, em-dash, comma) near end of window
    let splitIdx = -1;
    const minPreferred = Math.floor(maxChars * 0.4);
    const clauseBreaks = ['; ', ': ', ' — ', ' - ', ', '];
    for (const delim of clauseBreaks) {
      const found = window.lastIndexOf(delim);
      if (found >= minPreferred) {
        const candidateEnd = found + delim.trimEnd().length;
        if (candidateEnd <= maxChars && candidateEnd > splitIdx) {
          splitIdx = candidateEnd;
        }
      }
    }

    // 2. Otherwise split at the last whitespace boundary within `maxChars`
    if (splitIdx <= 0) {
      const lastSpace = window.lastIndexOf(' ');
      if (lastSpace > 0) {
        splitIdx = lastSpace;
      }
    }

    // 3. Only if a single unbroken word exceeds `maxChars`, hard-slice at `maxChars`
    if (splitIdx <= 0) {
      splitIdx = maxChars;
    }

    const head = remaining.slice(0, splitIdx).trim();
    if (head) {
      pieces.push(head);
    }
    remaining = remaining.slice(splitIdx).trimStart();
  }

  if (remaining.trim()) {
    pieces.push(remaining.trim());
  }

  return pieces;
}

/**
 * Segment a full narration script into ordered chunks bounded by `maxCharsPerChunk`.
 */
export function segmentScript(
  scriptText: string,
  options: SegmenterOptions = {}
): SegmentedChunk[] {
  if (!scriptText || !scriptText.trim()) {
    return [];
  }

  const rawMaxChars =
    options.maxCharsPerChunk ?? getDefaultMaxCharsForEngine(options.engineId);
  const maxCharsPerChunk = Math.max(16, Math.floor(rawMaxChars));
  const sentencePauseMs = Math.max(0, options.sentencePauseMs ?? 280);
  const paragraphPauseMs = Math.max(0, options.paragraphPauseMs ?? 560);
  const rules = options.pronunciationRules;

  const paragraphs = scriptText
    .split(/\r?\n+/)
    .map((p) => normalizeInlineWhitespace(p))
    .filter((p) => p.length > 0);

  const chunks: SegmentedChunk[] = [];

  for (let paragraphIndex = 0; paragraphIndex < paragraphs.length; paragraphIndex += 1) {
    const paragraph = paragraphs[paragraphIndex];
    const sentences = splitParagraphIntoSentences(paragraph);
    const paragraphUnits: string[] = [];

    for (const sentence of sentences) {
      if (sentence.length <= maxCharsPerChunk) {
        paragraphUnits.push(sentence);
      } else {
        paragraphUnits.push(...splitOversizedText(sentence, maxCharsPerChunk));
      }
    }

    // Greedily pack consecutive units within the same paragraph up to `maxCharsPerChunk`
    const packedParagraphChunks: string[] = [];
    let current = '';

    for (const unit of paragraphUnits) {
      if (!current) {
        current = unit;
      } else if (current.length + 1 + unit.length <= maxCharsPerChunk) {
        current = `${current} ${unit}`;
      } else {
        packedParagraphChunks.push(current);
        current = unit;
      }
    }
    if (current) {
      packedParagraphChunks.push(current);
    }

    for (let i = 0; i < packedParagraphChunks.length; i += 1) {
      const text = packedParagraphChunks[i];
      const isParagraphEnd = i === packedParagraphChunks.length - 1;
      const orderIndex = chunks.length;
      const normalizedText =
        rules && rules.length > 0 ? applyPronunciationRules(text, rules) : text;
      const counts = countWordsAndChars(text);

      chunks.push({
        orderIndex,
        index: orderIndex,
        paragraphIndex,
        isParagraphEnd,
        text,
        normalizedText,
        pauseAfterMs: isParagraphEnd ? paragraphPauseMs : sentencePauseMs,
        charCount: text.length,
        wordCount: counts.words,
      });
    }
  }

  return chunks;
}

/**
 * Segment a script directly into `ScriptChunk[]` records suitable for `NarrationProject`.
 */
export function segmentScriptToProjectChunks(
  scriptText: string,
  options: SegmenterOptions = {}
): ScriptChunk[] {
  const prefix = options.idPrefix ?? 'chunk';
  return segmentScript(scriptText, options).map((chunk) => ({
    id: `${prefix}-${chunk.orderIndex + 1}`,
    index: chunk.orderIndex,
    rawText: chunk.text,
    normalizedText: chunk.normalizedText,
    pauseAfterMs: chunk.pauseAfterMs,
    status: 'pending',
  }));
}
