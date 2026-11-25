import { describe, expect, it } from 'vitest';
import {
  countWordsAndChars,
  estimateNarrationDurationSec,
  getDefaultMaxCharsForEngine,
  segmentScript,
  segmentScriptToProjectChunks,
  splitParagraphIntoSentences,
} from '../src/services/segmenter';
import {
  applyPronunciationRules,
  createPronunciationRule,
  validatePronunciationRule,
} from '../src/services/pronunciation';
import {
  STUDIO_PRESETS,
  STUDIO_PRESET_IDS,
  extractEngineParametersForEngine,
  getStudioPreset,
} from '../src/services/presets';

function stripAllWhitespace(text: string): string {
  return text.replace(/\s+/g, '');
}

describe('segmenter service', () => {
  it('handles empty and whitespace-only scripts cleanly', () => {
    expect(segmentScript('')).toEqual([]);
    expect(segmentScript('   \n\t\n  ')).toEqual([]);
    expect(estimateNarrationDurationSec('')).toBe(0);
    expect(countWordsAndChars('')).toEqual({
      words: 0,
      chars: 0,
      charsNoSpaces: 0,
      paragraphs: 0,
    });
  });

  it('preserves paragraph boundaries (\\n\\n+ and \\n+) and pause metadata', () => {
    const script =
      'First paragraph sentence one. Sentence two.\n\nSecond paragraph here.\nThird line paragraph.';
    const chunks = segmentScript(script, {
      maxCharsPerChunk: 260,
      sentencePauseMs: 250,
      paragraphPauseMs: 600,
    });

    expect(chunks).toHaveLength(3);
    expect(chunks.map((c) => c.paragraphIndex)).toEqual([0, 1, 2]);
    expect(chunks.map((c) => c.isParagraphEnd)).toEqual([true, true, true]);
    expect(chunks.map((c) => c.pauseAfterMs)).toEqual([600, 600, 600]);
    expect(chunks.map((c) => c.orderIndex)).toEqual([0, 1, 2]);
  });

  it('does not split on common abbreviations, decimals, currencies, versions, or ellipses', () => {
    const abbreviations =
      'Dr. Elena Vance met Mr. Smith, Mrs. Jones, Ms. Lee, and Prof. Brown Jr. and Sr. at St. Jude Ave. vs. the old route, etc., e.g. buses, i.e. transit. Check Fig. 4 and No. 12 from Acme Inc. and Zenith Ltd. in the U.S. and U.K. at 9:30 a.m. or 4:15 p.m. today.';

    const sentences = splitParagraphIntoSentences(abbreviations);
    expect(sentences).toHaveLength(2);
    expect(sentences[0]).toContain('Dr. Elena Vance');
    expect(sentences[0]).toContain('Prof. Brown Jr. and Sr.');
    expect(sentences[0]).toContain('e.g. buses, i.e. transit.');
    expect(sentences[1]).toContain('Fig. 4 and No. 12');
    expect(sentences[1]).toContain('U.S. and U.K. at 9:30 a.m. or 4:15 p.m. today.');

    const numbersAndEllipsis =
      'Pi is approximately 3.14 and the ticket costs $12.50 on app v1.2.3 today. Wait... what happened next?';
    const numSentences = splitParagraphIntoSentences(numbersAndEllipsis);
    expect(numSentences).toEqual([
      'Pi is approximately 3.14 and the ticket costs $12.50 on app v1.2.3 today.',
      'Wait... what happened next?',
    ]);
  });

  it('handles quoted dialogue boundaries and attributions accurately', () => {
    const dialogue =
      '"Wait," she said. "Don\'t go!" "Why not?" he asked. She replied, "Because it\'s raining." Then she closed the door.';
    const sentences = splitParagraphIntoSentences(dialogue);

    expect(sentences).toEqual([
      '"Wait," she said.',
      '"Don\'t go!"',
      '"Why not?" he asked.',
      'She replied, "Because it\'s raining."',
      'Then she closed the door.',
    ]);
  });

  it('respects engine-specific maxCharsPerChunk without splitting inside words', () => {
    expect(getDefaultMaxCharsForEngine('pocket-tts')).toBe(260);
    expect(getDefaultMaxCharsForEngine('chatterbox')).toBe(280);

    const longParagraph = Array.from(
      { length: 18 },
      (_, idx) => `Sentence number ${idx + 1} explores clear local speech synthesis.`
    ).join(' ');

    const pocketChunks = segmentScript(longParagraph, { engineId: 'pocket-tts' });
    expect(pocketChunks.length).toBeGreaterThan(3);
    for (const chunk of pocketChunks) {
      expect(chunk.text.length).toBeLessThanOrEqual(260);
      // No partial leading/trailing word fragments from splitting inside words
      expect(chunk.text.startsWith(' ')).toBe(false);
      expect(chunk.text.endsWith(' ')).toBe(false);
    }

    // Single oversized unbroken token > maxCharsPerChunk must still preserve 100% characters
    const hugeToken = 'supercalifragilisticexpialidocious'.repeat(3);
    const tokenChunks = segmentScript(`Prefix ${hugeToken} suffix.`, {
      maxCharsPerChunk: 40,
    });
    expect(tokenChunks.every((c) => c.text.length <= 40)).toBe(true);
    expect(stripAllWhitespace(tokenChunks.map((c) => c.text).join(''))).toBe(
      stripAllWhitespace(`Prefix ${hugeToken} suffix.`)
    );
  });

  it('preserves 100% of text content and strict orderIndex across 35,000+ character long-form scripts', () => {
    const paragraph =
      'Dr. Mercer checked the telemetry at $12.50 per unit on build v2.4.1. "Wait," she said. "Don\'t go!" Values hovered near 3.14 across the U.S. grid... and then stabilized.';
    const longScript = Array.from({ length: 220 }, (_, i) => `Chapter ${i + 1}: ${paragraph}`).join(
      '\n\n'
    );

    expect(longScript.length).toBeGreaterThan(35_000);

    const chunks = segmentScript(longScript, { engineId: 'pocket-tts' });
    expect(chunks.length).toBeGreaterThan(130);

    // Order invariant
    chunks.forEach((chunk, idx) => {
      expect(chunk.orderIndex).toBe(idx);
      expect(chunk.index).toBe(idx);
      expect(chunk.text.length).toBeLessThanOrEqual(260);
    });

    // Content preservation invariant (zero dropped words or characters)
    const reconstructed = chunks.map((c) => c.text).join(' ');
    expect(stripAllWhitespace(reconstructed)).toBe(stripAllWhitespace(longScript));

    const counts = countWordsAndChars(longScript);
    expect(counts.paragraphs).toBe(220);
    expect(counts.words).toBeGreaterThan(5_000);
    expect(estimateNarrationDurationSec(longScript, 150)).toBeCloseTo(
      (counts.words / 150) * 60,
      5
    );
  });

  it('applies pronunciation rules only to normalizedText while preserving rawText', () => {
    const rules = [
      createPronunciationRule({
        pattern: 'API',
        replacement: 'A P I',
        isRegex: false,
        caseSensitive: true,
        enabled: true,
      }),
      createPronunciationRule({
        pattern: 'C++',
        replacement: 'C plus plus',
        isRegex: false,
        caseSensitive: false,
        enabled: true,
      }),
    ];

    const projectChunks = segmentScriptToProjectChunks(
      'The API in C++ supports rapid APIs without touching api.',
      { pronunciationRules: rules }
    );

    expect(projectChunks).toHaveLength(1);
    expect(projectChunks[0].rawText).toBe(
      'The API in C++ supports rapid APIs without touching api.'
    );
    expect(projectChunks[0].normalizedText).toBe(
      'The A P I in C plus plus supports rapid APIs without touching api.'
    );
    expect(projectChunks[0].status).toBe('pending');
  });
});

describe('pronunciation service', () => {
  it('supports case-sensitive, case-insensitive, literal-safe, and regex rules cleanly', () => {
    const rules = [
      createPronunciationRule({
        pattern: '$100',
        replacement: 'one hundred dollars',
        isRegex: false,
        caseSensitive: true,
        enabled: true,
      }),
      createPronunciationRule({
        pattern: 'onnx',
        replacement: 'on ex',
        isRegex: false,
        caseSensitive: false,
        enabled: true,
      }),
      createPronunciationRule({
        pattern: '\\bv(\\d+)\\.(\\d+)\\b',
        replacement: 'version $1 point $2',
        isRegex: true,
        caseSensitive: false,
        enabled: true,
      }),
      createPronunciationRule({
        pattern: 'disabled',
        replacement: 'NEVER_APPLIED',
        isRegex: false,
        caseSensitive: false,
        enabled: false,
      }),
    ];

    const raw = 'ONNX Runtime v1.31 costs $100 and remains disabled.';
    const applied = applyPronunciationRules(raw, rules);
    expect(applied).toBe(
      'on ex Runtime version 1 point 31 costs one hundred dollars and remains disabled.'
    );
    // Original string untouched
    expect(raw).toBe('ONNX Runtime v1.31 costs $100 and remains disabled.');
  });

  it('rejects empty patterns, invalid regexes, and empty-matching regexes', () => {
    expect(
      validatePronunciationRule({
        pattern: '   ',
        replacement: 'x',
        isRegex: false,
        caseSensitive: false,
      }).valid
    ).toBe(false);

    expect(
      validatePronunciationRule({
        pattern: '[unclosed',
        replacement: 'x',
        isRegex: true,
        caseSensitive: false,
      }).valid
    ).toBe(false);

    expect(
      validatePronunciationRule({
        pattern: 'a*',
        replacement: 'x',
        isRegex: true,
        caseSensitive: false,
      }).valid
    ).toBe(false);
  });
});

describe('studio presets service', () => {
  it('defines all 7 required presets with real engine parameters and mastering settings', () => {
    expect(STUDIO_PRESET_IDS).toEqual([
      'studio-quality',
      'natural-narration',
      'documentary',
      'educational',
      'storytelling',
      'fast-preview',
      'custom',
    ]);

    for (const id of STUDIO_PRESET_IDS) {
      const preset = getStudioPreset(id);
      expect(preset.id).toBe(id);
      expect(typeof preset.engineParameters.temperature).toBe('number');
      expect(typeof preset.engineParameters.lsdSteps).toBe('number');
      expect(typeof preset.engineParameters.framesAfterEos).toBe('number');
      expect(typeof preset.engineParameters.exaggeration).toBe('number');
      expect(typeof preset.engineParameters.repetitionPenalty).toBe('number');
      expect(typeof preset.engineParameters.topP).toBe('number');
      expect(preset.sentencePauseMs).toBeGreaterThan(0);
      expect(preset.paragraphPauseMs).toBeGreaterThan(preset.sentencePauseMs);
      expect(preset.mastering.preset).toBeTruthy();
    }

    // Verify studio-quality vs fast-preview differ meaningfully in real inference steps & mastering
    expect(STUDIO_PRESETS['studio-quality'].engineParameters.lsdSteps).toBeGreaterThan(
      Number(STUDIO_PRESETS['fast-preview'].engineParameters.lsdSteps)
    );
    expect(STUDIO_PRESETS['fast-preview'].mastering.preset).toBe('raw');
    expect(STUDIO_PRESETS['studio-quality'].mastering.compressorEnabled).toBe(true);

    const pocketParams = extractEngineParametersForEngine(
      STUDIO_PRESETS['studio-quality'].engineParameters,
      'pocket-tts'
    );
    expect(pocketParams).toEqual({
      temperature: 0.65,
      lsdSteps: 4,
      framesAfterEos: 3,
    });

    const chatterboxParams = extractEngineParametersForEngine(
      STUDIO_PRESETS['storytelling'].engineParameters,
      'chatterbox'
    );
    expect(chatterboxParams).toEqual({
      exaggeration: 0.75,
      temperature: 0.85,
      repetitionPenalty: 1.15,
      topP: 0.96,
    });
  });
});
