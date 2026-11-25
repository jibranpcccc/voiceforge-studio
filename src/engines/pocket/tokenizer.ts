/**
 * Pure TypeScript SentencePiece Unigram Protobuf parser, Viterbi tokenizer,
 * and Pocket TTS text normalizer/chunker.
 */

export const SentencePieceType = {
  NORMAL: 1,
  UNKNOWN: 2,
  CONTROL: 3,
  USER_DEFINED: 4,
  UNUSED: 5,
  BYTE: 6,
} as const;

export type SentencePieceType = (typeof SentencePieceType)[keyof typeof SentencePieceType];

export interface SentencePieceEntry {
  id: number;
  piece: string;
  score: number;
  type: SentencePieceType;
}

export interface SentencePieceTrainerSpec {
  modelType: number;
  vocabSize: number;
  treatWhitespaceAsSuffix: boolean;
  byteFallback: boolean;
  unkId: number;
  bosId: number;
  eosId: number;
  padId: number;
  unkSurface: string;
}

export interface SentencePieceNormalizerSpec {
  name: string;
  addDummyPrefix: boolean;
  removeExtraWhitespaces: boolean;
  escapeWhitespaces: boolean;
}

interface TrieNode {
  children: Map<number, TrieNode>;
  pieceId: number;
  score: number;
  isUserDefined: boolean;
}

const WHITESPACE_MARKER = '\u2581'; // '▁'
const K_UNK_PENALTY = 10.0;

function createTrieNode(): TrieNode {
  return {
    children: new Map(),
    pieceId: -1,
    score: 0,
    isUserDefined: false,
  };
}

function readVarint(bytes: Uint8Array, offset: number): [number, number] {
  let result = 0;
  let shift = 0;
  let pos = offset;
  while (pos < bytes.length) {
    const b = bytes[pos++];
    // Use arithmetic for >31-bit varints (e.g. negative int32 sign-extended to 64-bit)
    result += (b & 0x7f) * 2 ** shift;
    if ((b & 0x80) === 0) {
      return [result | 0, pos];
    }
    shift += 7;
    if (shift > 63) {
      throw new Error('Malformed protobuf varint.');
    }
  }
  throw new Error('Unexpected EOF reading protobuf varint.');
}

function readVarintUint(bytes: Uint8Array, offset: number): [number, number] {
  let result = 0;
  let shift = 0;
  let pos = offset;
  while (pos < bytes.length) {
    const b = bytes[pos++];
    result += (b & 0x7f) * 2 ** shift;
    if ((b & 0x80) === 0) {
      return [result, pos];
    }
    shift += 7;
    if (shift > 63) {
      throw new Error('Malformed protobuf varint.');
    }
  }
  throw new Error('Unexpected EOF reading protobuf varint.');
}

function skipField(bytes: Uint8Array, pos: number, wireType: number): number {
  switch (wireType) {
    case 0: {
      const [, nextPos] = readVarintUint(bytes, pos);
      return nextPos;
    }
    case 1:
      return pos + 8;
    case 2: {
      const [len, afterLen] = readVarintUint(bytes, pos);
      return afterLen + len;
    }
    case 5:
      return pos + 4;
    default:
      throw new Error(`Unsupported protobuf wire type ${wireType}.`);
  }
}

function parsePieceProto(
  bytes: Uint8Array,
  id: number,
  utf8Decoder: TextDecoder
): SentencePieceEntry {
  let pos = 0;
  let piece = '';
  let score = 0;
  let type: SentencePieceType = SentencePieceType.NORMAL;
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);

  while (pos < bytes.length) {
    const [tag, afterTag] = readVarintUint(bytes, pos);
    pos = afterTag;
    const fieldNumber = tag >>> 3;
    const wireType = tag & 0x07;

    if (fieldNumber === 1 && wireType === 2) {
      const [len, afterLen] = readVarintUint(bytes, pos);
      piece = utf8Decoder.decode(bytes.subarray(afterLen, afterLen + len));
      pos = afterLen + len;
    } else if (fieldNumber === 2 && wireType === 5) {
      score = view.getFloat32(pos, true);
      pos += 4;
    } else if (fieldNumber === 3 && wireType === 0) {
      const [val, nextPos] = readVarint(bytes, pos);
      type = val as SentencePieceType;
      pos = nextPos;
    } else {
      pos = skipField(bytes, pos, wireType);
    }
  }

  return { id, piece, score, type };
}

function parseTrainerSpecProto(
  bytes: Uint8Array,
  utf8Decoder: TextDecoder
): SentencePieceTrainerSpec {
  const spec: SentencePieceTrainerSpec = {
    modelType: 1,
    vocabSize: 0,
    treatWhitespaceAsSuffix: false,
    byteFallback: false,
    unkId: 0,
    bosId: 1,
    eosId: 2,
    padId: -1,
    unkSurface: ' \u2047 ',
  };

  let pos = 0;
  while (pos < bytes.length) {
    const [tag, afterTag] = readVarintUint(bytes, pos);
    pos = afterTag;
    const fieldNumber = tag >>> 3;
    const wireType = tag & 0x07;

    if (wireType === 0) {
      const [val, nextPos] = readVarint(bytes, pos);
      pos = nextPos;
      switch (fieldNumber) {
        case 3:
          spec.modelType = val;
          break;
        case 4:
          spec.vocabSize = val;
          break;
        case 24:
          spec.treatWhitespaceAsSuffix = val !== 0;
          break;
        case 35:
          spec.byteFallback = val !== 0;
          break;
        case 40:
          spec.unkId = val;
          break;
        case 41:
          spec.bosId = val;
          break;
        case 42:
          spec.eosId = val;
          break;
        case 43:
          spec.padId = val;
          break;
      }
    } else if (fieldNumber === 44 && wireType === 2) {
      const [len, afterLen] = readVarintUint(bytes, pos);
      spec.unkSurface = utf8Decoder.decode(bytes.subarray(afterLen, afterLen + len));
      pos = afterLen + len;
    } else {
      pos = skipField(bytes, pos, wireType);
    }
  }

  return spec;
}

function parseNormalizerSpecProto(
  bytes: Uint8Array,
  utf8Decoder: TextDecoder
): SentencePieceNormalizerSpec {
  const spec: SentencePieceNormalizerSpec = {
    name: 'nmt_nfkc',
    addDummyPrefix: true,
    removeExtraWhitespaces: true,
    escapeWhitespaces: true,
  };

  let pos = 0;
  while (pos < bytes.length) {
    const [tag, afterTag] = readVarintUint(bytes, pos);
    pos = afterTag;
    const fieldNumber = tag >>> 3;
    const wireType = tag & 0x07;

    if (fieldNumber === 1 && wireType === 2) {
      const [len, afterLen] = readVarintUint(bytes, pos);
      spec.name = utf8Decoder.decode(bytes.subarray(afterLen, afterLen + len));
      pos = afterLen + len;
    } else if (wireType === 0) {
      const [val, nextPos] = readVarint(bytes, pos);
      pos = nextPos;
      if (fieldNumber === 3) spec.addDummyPrefix = val !== 0;
      if (fieldNumber === 4) spec.removeExtraWhitespaces = val !== 0;
      if (fieldNumber === 5) spec.escapeWhitespaces = val !== 0;
    } else {
      pos = skipField(bytes, pos, wireType);
    }
  }

  return spec;
}

function isWhitespaceChar(ch: string): boolean {
  return ch === ' ' || ch === '\t' || ch === '\n' || ch === '\r' || ch === '\v' || ch === '\f';
}

/**
 * Pure TypeScript SentencePiece Unigram tokenizer decoded directly from `tokenizer.model`.
 */
export class SentencePieceUnigramTokenizer {
  readonly pieces: readonly SentencePieceEntry[];
  readonly trainerSpec: SentencePieceTrainerSpec;
  readonly normalizerSpec: SentencePieceNormalizerSpec;

  private readonly root: TrieNode = createTrieNode();
  private readonly byteToTokenId = new Int32Array(256).fill(-1);
  private readonly minScore: number;
  private readonly utf8Encoder = new TextEncoder();
  private readonly utf8Decoder = new TextDecoder('utf-8', { fatal: false });

  constructor(
    pieces: SentencePieceEntry[],
    trainerSpec: SentencePieceTrainerSpec,
    normalizerSpec: SentencePieceNormalizerSpec
  ) {
    this.pieces = pieces;
    this.trainerSpec = trainerSpec;
    this.normalizerSpec = normalizerSpec;

    let minScore = 0;
    for (const entry of pieces) {
      if (
        entry.type === SentencePieceType.NORMAL ||
        entry.type === SentencePieceType.USER_DEFINED
      ) {
        if (entry.score < minScore) {
          minScore = entry.score;
        }
        this.insertIntoTrie(entry);
      } else if (entry.type === SentencePieceType.BYTE) {
        const match = entry.piece.match(/^<0x([0-9A-Fa-f]{2})>$/);
        if (match) {
          this.byteToTokenId[Number.parseInt(match[1], 16)] = entry.id;
        }
      }
    }
    this.minScore = minScore;
  }

  static fromBuffer(input: ArrayBuffer | ArrayBufferView): SentencePieceUnigramTokenizer {
    const bytes =
      input instanceof ArrayBuffer
        ? new Uint8Array(input)
        : new Uint8Array(input.buffer, input.byteOffset, input.byteLength);

    const utf8Decoder = new TextDecoder('utf-8');
    const pieces: SentencePieceEntry[] = [];
    let trainerSpec: SentencePieceTrainerSpec = {
      modelType: 1,
      vocabSize: 0,
      treatWhitespaceAsSuffix: false,
      byteFallback: true,
      unkId: 0,
      bosId: 1,
      eosId: 2,
      padId: 3,
      unkSurface: ' \u2047 ',
    };
    let normalizerSpec: SentencePieceNormalizerSpec = {
      name: 'identity',
      addDummyPrefix: true,
      removeExtraWhitespaces: false,
      escapeWhitespaces: true,
    };

    let pos = 0;
    while (pos < bytes.length) {
      const [tag, afterTag] = readVarintUint(bytes, pos);
      pos = afterTag;
      const fieldNumber = tag >>> 3;
      const wireType = tag & 0x07;

      if (wireType === 2) {
        const [len, afterLen] = readVarintUint(bytes, pos);
        const slice = bytes.subarray(afterLen, afterLen + len);
        pos = afterLen + len;

        if (fieldNumber === 1) {
          pieces.push(parsePieceProto(slice, pieces.length, utf8Decoder));
        } else if (fieldNumber === 2) {
          trainerSpec = parseTrainerSpecProto(slice, utf8Decoder);
        } else if (fieldNumber === 3) {
          normalizerSpec = parseNormalizerSpecProto(slice, utf8Decoder);
        }
      } else {
        pos = skipField(bytes, pos, wireType);
      }
    }

    if (pieces.length === 0) {
      throw new Error('SentencePiece model contains zero pieces.');
    }
    return new SentencePieceUnigramTokenizer(pieces, trainerSpec, normalizerSpec);
  }

  private insertIntoTrie(entry: SentencePieceEntry): void {
    let node = this.root;
    for (const ch of entry.piece) {
      const cp = ch.codePointAt(0)!;
      let child = node.children.get(cp);
      if (!child) {
        child = createTrieNode();
        node.children.set(cp, child);
      }
      node = child;
    }
    node.pieceId = entry.id;
    node.score = entry.score;
    node.isUserDefined = entry.type === SentencePieceType.USER_DEFINED;
  }

  get vocabSize(): number {
    return this.pieces.length;
  }

  normalize(text: string): string {
    if (text.length === 0) {
      return '';
    }

    let normalized = text;
    if (
      this.normalizerSpec.name === 'nfkc' ||
      this.normalizerSpec.name === 'nmt_nfkc' ||
      this.normalizerSpec.name === 'nfkc_cf'
    ) {
      normalized = normalized.normalize('NFKC');
    }

    if (this.normalizerSpec.removeExtraWhitespaces) {
      let start = 0;
      let end = normalized.length;
      while (start < end && isWhitespaceChar(normalized[start])) start++;
      while (end > start && isWhitespaceChar(normalized[end - 1])) end--;
      let collapsed = '';
      let inSpace = false;
      for (let i = start; i < end; i++) {
        const ch = normalized[i];
        if (isWhitespaceChar(ch)) {
          if (!inSpace) {
            collapsed += ' ';
            inSpace = true;
          }
        } else {
          collapsed += ch;
          inSpace = false;
        }
      }
      normalized = collapsed;
    }

    if (normalized.length === 0) {
      return '';
    }

    if (this.normalizerSpec.addDummyPrefix) {
      if (this.trainerSpec.treatWhitespaceAsSuffix) {
        normalized = normalized + ' ';
      } else {
        normalized = ' ' + normalized;
      }
    }

    if (this.normalizerSpec.escapeWhitespaces) {
      normalized = normalized.replace(/ /g, WHITESPACE_MARKER);
    }

    return normalized;
  }

  /**
   * Encode text into SentencePiece Unigram token IDs using Viterbi decoding.
   */
  encode(text: string): number[] {
    const normalized = this.normalize(text);
    if (normalized.length === 0) {
      return [];
    }

    const codePoints: number[] = [];
    const chars: string[] = [];
    for (const ch of normalized) {
      chars.push(ch);
      codePoints.push(ch.codePointAt(0)!);
    }

    const n = codePoints.length;
    const bestScore = new Float64Array(n + 1).fill(-Infinity);
    const prevIdx = new Int32Array(n + 1).fill(-1);
    const chosenId = new Int32Array(n + 1).fill(-1);
    bestScore[0] = 0;

    const unkScore = this.minScore - K_UNK_PENALTY;

    for (let i = 0; i < n; i++) {
      if (bestScore[i] === -Infinity) {
        continue;
      }
      const baseScore = bestScore[i];
      let node: TrieNode | undefined = this.root;
      let hasSingleCharMatch = false;

      for (let j = i; j < n; j++) {
        node = node.children.get(codePoints[j]);
        if (!node) {
          break;
        }
        if (node.pieceId >= 0) {
          if (j === i) {
            hasSingleCharMatch = true;
          }
          const score = baseScore + (node.isUserDefined ? 0 : node.score);
          const next = j + 1;
          if (score > bestScore[next]) {
            bestScore[next] = score;
            prevIdx[next] = i;
            chosenId[next] = node.pieceId;
          }
        }
      }

      if (!hasSingleCharMatch) {
        const next = i + 1;
        const score = baseScore + unkScore;
        if (score > bestScore[next]) {
          bestScore[next] = score;
          prevIdx[next] = i;
          chosenId[next] = -2; // Sentinel for byte fallback / unk
        }
      }
    }

    const reversedSegments: number[] = [];
    let cursor = n;
    while (cursor > 0) {
      const start = prevIdx[cursor];
      const id = chosenId[cursor];
      if (id === -2) {
        if (this.trainerSpec.byteFallback) {
          const utf8 = this.utf8Encoder.encode(chars[start]);
          for (let k = utf8.length - 1; k >= 0; k--) {
            const byteId = this.byteToTokenId[utf8[k]];
            reversedSegments.push(byteId >= 0 ? byteId : this.trainerSpec.unkId);
          }
        } else {
          reversedSegments.push(this.trainerSpec.unkId);
        }
      } else {
        reversedSegments.push(id);
      }
      cursor = start;
    }

    const result: number[] = new Array(reversedSegments.length);
    for (let i = 0; i < reversedSegments.length; i++) {
      result[i] = reversedSegments[reversedSegments.length - 1 - i];
    }
    return result;
  }

  /**
   * Decode token IDs back to UTF-8 text (preserving partial byte tokens as U+FFFD).
   */
  decode(ids: readonly number[]): string {
    let out = '';
    const byteBuffer: number[] = [];

    const flushBytes = () => {
      if (byteBuffer.length > 0) {
        out += this.utf8Decoder.decode(new Uint8Array(byteBuffer));
        byteBuffer.length = 0;
      }
    };

    for (const id of ids) {
      if (id < 0 || id >= this.pieces.length) {
        continue;
      }
      const entry = this.pieces[id];
      if (
        entry.type === SentencePieceType.CONTROL ||
        entry.type === SentencePieceType.UNUSED
      ) {
        continue;
      }
      if (entry.type === SentencePieceType.UNKNOWN) {
        flushBytes();
        out += this.trainerSpec.unkSurface;
        continue;
      }
      if (entry.type === SentencePieceType.BYTE) {
        const match = entry.piece.match(/^<0x([0-9A-Fa-f]{2})>$/);
        if (match) {
          byteBuffer.push(Number.parseInt(match[1], 16));
          continue;
        }
      }
      flushBytes();
      if (this.normalizerSpec.escapeWhitespaces) {
        out += entry.piece.replace(/\u2581/g, ' ');
      } else {
        out += entry.piece;
      }
    }
    flushBytes();

    if (this.normalizerSpec.addDummyPrefix) {
      if (this.trainerSpec.treatWhitespaceAsSuffix && out.endsWith(' ')) {
        out = out.slice(0, -1);
      } else if (!this.trainerSpec.treatWhitespaceAsSuffix && out.startsWith(' ')) {
        out = out.slice(1);
      }
    }

    return out;
  }
}

export interface PocketTextPromptOptions {
  padWithSpacesForShortInputs: boolean;
  removeSemicolons: boolean;
}

export interface PocketChunkingOptions extends PocketTextPromptOptions {
  maxTokensPerChunk: number;
}

const TERMINAL_PUNCTUATION = new Set(['.', '!', '?', '\u2026']);
const WEAK_PUNCTUATION = new Set([',', ';', ':', '-', '\u2013', '\u2014']);
const CLOSERS = `"'”’)]»`;
const OPENERS = `"'“‘([«`;
const CLOSERS_OR_PARTIAL = new Set([...CLOSERS, '\ufffd']);
const TITLES = new Set([
  'Mr.',
  'Mrs.',
  'Ms.',
  'Dr.',
  'Prof.',
  'Rev.',
  'vs.',
  'e.g.',
  'i.e.',
]);
const ENDS_WITH_DECIMAL_NUMBER = /\d[.,]\d+\W*$/;
const ALPHANUMERIC_RE = /^[\p{L}\p{N}]$/u;

function rstripChars(text: string, chars: string): string {
  let end = text.length;
  while (end > 0 && chars.includes(text[end - 1])) {
    end--;
  }
  return text.slice(0, end);
}

function lstripChars(text: string, chars: string): string {
  let start = 0;
  while (start < text.length && chars.includes(text[start])) {
    start++;
  }
  return text.slice(start);
}

function ensureTerminalPunctuation(text: string): string {
  const core = rstripChars(text, CLOSERS + ' ');
  const closers = text.slice(core.length).trim();
  if (core.length === 0 || TERMINAL_PUNCTUATION.has(core[core.length - 1])) {
    return text;
  }
  if (WEAK_PUNCTUATION.has(core[core.length - 1])) {
    return rstripChars(core, ',;:-\u2013\u2014 ') + '.' + closers;
  }
  return text + '.';
}

/**
 * Normalize a Pocket TTS text prompt and estimate `frames_after_eos_guess`.
 */
export function preparePocketTextPrompt(
  rawText: string,
  options: PocketTextPromptOptions
): { text: string; framesAfterEosGuess: number } {
  let text = rawText.trim();
  if (text.length === 0) {
    throw new Error('Text prompt cannot be empty.');
  }

  text = text.replace(/[\r\n]+/g, ' ').replace(/\s{2,}/g, ' ').trim();
  if (options.removeSemicolons) {
    text = text.replace(/;/g, ',');
  }

  const wordCount = text.split(/\s+/).filter(Boolean).length;
  const framesAfterEosGuess = wordCount <= 4 ? 3 : 1;

  const strippedOpeners = lstripChars(text, OPENERS);
  const startIdx = text.length - strippedOpeners.length;
  if (startIdx < text.length) {
    const ch = text[startIdx];
    const upper = ch.toUpperCase();
    if (ch !== upper) {
      text = text.slice(0, startIdx) + upper + text.slice(startIdx + 1);
    }
  }

  text = ensureTerminalPunctuation(text);

  if (options.padWithSpacesForShortInputs && text.split(/\s+/).filter(Boolean).length < 5) {
    text = '        ' + text;
  }

  return { text, framesAfterEosGuess };
}

function isInnerPunctuation(
  tokens: readonly number[],
  segmentStartIdx: number,
  tokenizer: SentencePieceUnigramTokenizer
): boolean {
  const after = tokenizer.decode(tokens.slice(segmentStartIdx - 1, segmentStartIdx + 1));
  if (after.length >= 2 && ALPHANUMERIC_RE.test(after[1])) {
    return true;
  }
  const windowStart = Math.max(0, segmentStartIdx - 6);
  const words = tokenizer.decode(tokens.slice(windowStart, segmentStartIdx)).trim().split(/\s+/);
  if (words.length === 0) {
    return false;
  }
  const lastWord = words[words.length - 1];
  return TITLES.has(lastWord) && (words.length > 1 || windowStart === 0);
}

function skipClosers(
  tokens: readonly number[],
  segmentStartIdx: number,
  tokenizer: SentencePieceUnigramTokenizer
): number {
  const punctuation = tokenizer.decode(tokens.slice(segmentStartIdx - 1, segmentStartIdx));
  let start = segmentStartIdx;
  const stop = Math.min(tokens.length, segmentStartIdx + 8);
  for (let end = segmentStartIdx + 1; end <= stop; end++) {
    const window = tokenizer.decode(tokens.slice(segmentStartIdx - 1, end));
    const after = window.slice(punctuation.length);
    if (!after || [...after].some((c) => !CLOSERS_OR_PARTIAL.has(c))) {
      break;
    }
    if (!after.includes('\ufffd')) {
      start = end;
    }
  }
  return start;
}

function findBoundaryIndices(
  tokens: readonly number[],
  boundaryTokenSet: ReadonlySet<number>,
  tokenizer?: SentencePieceUnigramTokenizer,
  skipInnerPunctuation = false
): number[] {
  const indices = [0];
  let previousWasBoundary = false;

  for (let idx = 0; idx < tokens.length; idx++) {
    if (boundaryTokenSet.has(tokens[idx])) {
      previousWasBoundary = true;
    } else {
      if (previousWasBoundary) {
        if (
          skipInnerPunctuation &&
          tokenizer &&
          isInnerPunctuation(tokens, idx, tokenizer)
        ) {
          previousWasBoundary = false;
          continue;
        }
        const start = tokenizer ? skipClosers(tokens, idx, tokenizer) : idx;
        if (start < tokens.length) {
          indices.push(start);
        }
      }
      previousWasBoundary = false;
    }
  }
  indices.push(tokens.length);
  return indices;
}

function segmentsFromBoundaries(
  tokens: readonly number[],
  boundaryIndices: readonly number[],
  tokenizer: SentencePieceUnigramTokenizer
): Array<{ count: number; text: string }> {
  const segments: Array<{ count: number; text: string }> = [];
  for (let i = 0; i < boundaryIndices.length - 1; i++) {
    const start = boundaryIndices[i];
    const end = boundaryIndices[i + 1];
    segments.push({
      count: end - start,
      text: tokenizer.decode(tokens.slice(start, end)),
    });
  }
  return segments;
}

function forceSplitLongSegment(
  tokenizer: SentencePieceUnigramTokenizer,
  text: string,
  maxTokens: number
): Array<{ count: number; text: string }> {
  const tokens = tokenizer.encode(text.trim());
  if (tokens.length <= maxTokens) {
    return [{ count: tokens.length, text: text.trim() }];
  }

  const parts: Array<{ count: number; text: string }> = [];
  let cursor = 0;
  while (cursor < tokens.length) {
    let end = Math.min(cursor + maxTokens, tokens.length);
    if (end < tokens.length) {
      // Backtrack to a token starting with whitespace marker if possible
      for (let k = end; k > cursor + Math.floor(maxTokens / 2); k--) {
        const piece = tokenizer.pieces[tokens[k]]?.piece ?? '';
        if (piece.startsWith(WHITESPACE_MARKER)) {
          end = k;
          break;
        }
      }
    }
    const slice = tokens.slice(cursor, end);
    const decoded = tokenizer.decode(slice).trim();
    if (decoded.length > 0) {
      parts.push({ count: slice.length, text: decoded });
    }
    cursor = end;
  }
  return parts;
}

/**
 * Split text on sentence/clause boundaries and pack into chunks <= `maxTokensPerChunk`.
 */
export function splitPocketTextIntoChunks(
  tokenizer: SentencePieceUnigramTokenizer,
  rawText: string,
  options: PocketChunkingOptions
): string[] {
  const prepared = preparePocketTextPrompt(rawText, options).text.trim();
  const tokens = tokenizer.encode(prepared);

  const eosTokens = new Set(tokenizer.encode('.!...?').slice(1));
  const sentenceBoundaries = findBoundaryIndices(tokens, eosTokens, tokenizer, true);
  const sentenceSegments = segmentsFromBoundaries(tokens, sentenceBoundaries, tokenizer);

  const fallbackTokens = new Set(tokenizer.encode(',;:').slice(1));
  const refinedSegments: Array<{ count: number; text: string }> = [];
  for (const seg of sentenceSegments) {
    if (seg.count <= options.maxTokensPerChunk) {
      refinedSegments.push(seg);
      continue;
    }
    const subTokens = tokenizer.encode(seg.text.trim());
    const subBoundaries = findBoundaryIndices(subTokens, fallbackTokens, tokenizer, true);
    const subSegments = segmentsFromBoundaries(subTokens, subBoundaries, tokenizer);
    if (subSegments.length > 1) {
      for (const sub of subSegments) {
        if (sub.count <= options.maxTokensPerChunk) {
          refinedSegments.push(sub);
        } else {
          refinedSegments.push(...forceSplitLongSegment(tokenizer, sub.text, options.maxTokensPerChunk));
        }
      }
    } else {
      refinedSegments.push(...forceSplitLongSegment(tokenizer, seg.text, options.maxTokensPerChunk));
    }
  }

  // Never end a chunk on a decimal number (e.g. "$822.95")
  const gluedSegments: Array<{ count: number; text: string }> = [];
  for (const seg of refinedSegments) {
    if (
      gluedSegments.length > 0 &&
      ENDS_WITH_DECIMAL_NUMBER.test(gluedSegments[gluedSegments.length - 1].text)
    ) {
      const prev = gluedSegments[gluedSegments.length - 1];
      gluedSegments[gluedSegments.length - 1] = {
        count: prev.count + seg.count,
        text: `${prev.text.trimEnd()} ${seg.text.trim()}`,
      };
    } else {
      gluedSegments.push(seg);
    }
  }

  const chunks: string[] = [];
  let currentChunk = '';
  let currentCount = 0;
  for (const seg of gluedSegments) {
    if (currentChunk.length === 0) {
      currentChunk = seg.text;
      currentCount = seg.count;
      continue;
    }
    if (currentCount + seg.count > options.maxTokensPerChunk) {
      chunks.push(currentChunk.trim());
      currentChunk = seg.text;
      currentCount = seg.count;
    } else {
      currentChunk += ' ' + seg.text;
      currentCount += seg.count;
    }
  }

  if (currentChunk.trim().length > 0) {
    chunks.push(currentChunk.trim());
  }

  return chunks;
}
