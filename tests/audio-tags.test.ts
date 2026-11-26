import { describe, expect, it } from 'vitest';
import { masterNarrationChunks, MASTERING_PRESETS } from '../src/audio';
import {
  countAudioTags,
  parseAudioTag,
  splitParagraphByAudioTags,
  stripAudioTagsForCounting,
  stripAudioTagsForEngine,
} from '../src/services/audioTags';
import { BUILTIN_VOICES, DEFAULT_BUILTIN_VOICE_ID } from '../src/services/builtinVoices';
import { segmentScript, segmentScriptToProjectChunks } from '../src/services/segmenter';
import type { AudioBufferData } from '../src/types';

const STRAIT_OF_HORMUZ_SCRIPT =
  '[intrigued] How can two rival navies blockade the exact same 21-mile strip of water—and why are oil tankers now sailing through it completely invisible? [short pause] Look at the Strait of Hormuz, between Iran to the north and Oman and the United Arab Emirates to the south. [serious] Since July, the United States Navy has enforced a blockade on Iranian ports like Kharg Island and Bandar Abbas. U.S. Central Command says it has diverted over 135 ships and blocked 25 billion dollars in Iranian oil, with monitors tracking zero crude tankers escaping the Gulf of Oman. [tense] In response, Iran declared the strait closed to unauthorized ships, and state media reported tankers hitting sea mines this week. [short pause] Yet roughly 38 ships a day are still slipping through the southern corridor—by shutting off their tracking transponders. [low, dramatic] As the U.S. expands enforcement toward Iran’s land borders and the Caspian Sea, the world’s busiest oil lane has turned into a ghost highway.';

describe('inline audio tag & direction engine', () => {
  it('parses pause, delivery, compound, and paralinguistic sound tags accurately', () => {
    expect(parseAudioTag('short pause')).toMatchObject({ kind: 'pause', pauseMs: 450 });
    expect(parseAudioTag('long pause')).toMatchObject({ kind: 'pause', pauseMs: 1400 });
    expect(parseAudioTag('pause:1.5s')).toMatchObject({ kind: 'pause', pauseMs: 1500 });
    expect(parseAudioTag('pause:750ms')).toMatchObject({ kind: 'pause', pauseMs: 750 });

    const compound = parseAudioTag('low, dramatic');
    expect(compound?.kind).toBe('delivery');
    expect(compound?.dspHints?.speedMultiplier).toBeLessThan(1.0);
    expect(compound?.dspHints?.eqLowDeltaDb).toBeGreaterThan(0);
    expect(compound?.chatterboxParameters?.exaggeration).toBeGreaterThan(0.5);

    const laugh = parseAudioTag('laugh');
    expect(laugh).toMatchObject({ kind: 'sound', chatterboxToken: '[laughter]' });
  });

  it('segments the Strait of Hormuz directed script cleanly with zero spoken tag leakage', () => {
    const chunks = segmentScript(STRAIT_OF_HORMUZ_SCRIPT, {
      engineId: 'pocket-tts',
      maxCharsPerChunk: 260,
      sentencePauseMs: 250,
      paragraphPauseMs: 550,
    });

    expect(chunks.length).toBeGreaterThanOrEqual(6);

    for (const chunk of chunks) {
      expect(chunk.text).not.toContain('[');
      expect(chunk.text).not.toContain(']');
      expect(chunk.normalizedText).not.toContain('intrigued');
      expect(chunk.normalizedText).not.toContain('short pause');
      expect(chunk.normalizedText).not.toContain('dramatic');
    }

    // First span is `[intrigued]` ending at `[short pause]` -> 450ms pause
    expect(chunks[0].directionTags).toEqual(['intrigued']);
    expect(chunks[0].explicitPauseAfterMs).toBe(true);
    expect(chunks[0].pauseAfterMs).toBe(450);

    // `[short pause]` preserves `[intrigued]` across the beat
    expect(chunks[1].directionTags).toEqual(['intrigued']);

    // Mood transitions in exact script order
    expect(chunks.some((c) => c.directionTags?.includes('serious'))).toBe(true);
    expect(chunks.some((c) => c.directionTags?.includes('tense'))).toBe(true);
    const finalChunk = chunks[chunks.length - 1];
    expect(finalChunk.directionTags).toEqual(['low, dramatic']);
    expect(finalChunk.dspHints?.speedMultiplier).toBeLessThan(1.0);

    expect(countAudioTags(STRAIT_OF_HORMUZ_SCRIPT)).toBe(6);
    expect(stripAudioTagsForCounting(STRAIT_OF_HORMUZ_SCRIPT)).not.toContain('[');
  });

  it('preserves native Chatterbox paralinguistic tokens on chatterbox while stripping them on pocket-tts', () => {
    const input = 'Wait a minute! [laugh] Look at this. [sigh] [whisper] Keep your voice down.';
    const cbSpans = splitParagraphByAudioTags(input, 'chatterbox');
    const pocketSpans = splitParagraphByAudioTags(input, 'pocket-tts');

    expect(cbSpans[0].text).toContain('[laughter]');
    expect(cbSpans[0].text).toContain('[sigh]');
    expect(cbSpans[1].text).toContain('[whisper]');
    expect(cbSpans[1].parameterOverrides).toHaveProperty('exaggeration');

    expect(pocketSpans[0].text).not.toContain('[');
    expect(pocketSpans[1].text).not.toContain('[');
    expect(pocketSpans[1].dspHints?.gainDeltaDb).toBeLessThan(0);

    expect(stripAudioTagsForEngine('Hello [laugh] [serious] world.', 'chatterbox')).toBe(
      'Hello [laughter] world.'
    );
    expect(stripAudioTagsForEngine('Hello [laugh] [serious] world.', 'pocket-tts')).toBe(
      'Hello world.'
    );
  });

  it('propagates directionTags, parameterOverrides, and dspHints into project chunks and mastering', () => {
    const projectChunks = segmentScriptToProjectChunks(
      '[serious] Fact one. [short pause] [low, dramatic] Dramatic finale.',
      { engineId: 'chatterbox' }
    );
    expect(projectChunks[0].explicitPauseAfterMs).toBe(true);
    expect(projectChunks[0].pauseAfterMs).toBe(450);
    expect(projectChunks[1].directionTags).toEqual(['low, dramatic']);
    expect(projectChunks[1].parameterOverrides?.exaggeration).toBeGreaterThan(0.5);
    expect(projectChunks[1].dspHints?.speedMultiplier).toBeLessThan(1.0);

    const sr = 24_000;
    const toneA = new Float32Array(sr);
    const toneB = new Float32Array(sr);
    for (let i = 0; i < sr; i += 1) {
      toneA[i] = 0.25 * Math.sin((2 * Math.PI * 220 * i) / sr);
      toneB[i] = 0.25 * Math.sin((2 * Math.PI * 180 * i) / sr);
    }
    const bufA: AudioBufferData = { samples: toneA, sampleRate: sr, channels: 1, durationSec: 1 };
    const bufB: AudioBufferData = { samples: toneB, sampleRate: sr, channels: 1, durationSec: 1 };

    const mastered = masterNarrationChunks([bufA, bufB], MASTERING_PRESETS.raw, {
      pauseDurationsMs: [450],
      chunkDspHints: [undefined, { speedMultiplier: 0.9, eqLowDeltaDb: 2.0 }],
    });

    // 1.0s + 0.45s silence + ~1.11s slowed segment = ~2.56s (> 2.45s baseline)
    expect(mastered.durationSec).toBeGreaterThan(2.5);
    for (let i = 0; i < mastered.samples.length; i += 1) {
      expect(Number.isFinite(mastered.samples[i])).toBe(true);
    }
  });

  it('defines a valid commercial-friendly pinned catalog of built-in open-licensed voices', () => {
    expect(BUILTIN_VOICES.length).toBeGreaterThanOrEqual(6);
    expect(BUILTIN_VOICES.some((v) => v.id === DEFAULT_BUILTIN_VOICE_ID)).toBe(true);

    const allowedLicenses = new Set(['CC0', 'CC-BY-4.0', 'MIT']);
    for (const entry of BUILTIN_VOICES) {
      expect(allowedLicenses.has(entry.license)).toBe(true);
      expect(entry.sourceUrl).toMatch(/^https:\/\/huggingface\.co\/.+\/resolve\/[0-9a-f]{40}\//);
      expect(entry.sizeBytes).toBeGreaterThan(100_000);
    }
  });
});
