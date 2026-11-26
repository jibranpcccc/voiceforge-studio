/**
 * Built-in open-licensed stock narrator voice catalog (CC0 / CC-BY-4.0 / MIT).
 *
 * Allows users to generate high-quality narration immediately in Text-to-Speech Studio
 * without recording or uploading a reference sample first. Reference WAV clips come from
 * pinned open-licensed Hugging Face repositories, are cached locally in Cache Storage
 * (`voiceforge-models-v1`) on first use, and encoded 100% locally in the user's browser
 * for the selected engine (`pocket-tts` or `chatterbox`).
 */

import { analyzeReferenceAudio, decodeAudioArrayBuffer } from '../audio';
import { getCompatibleConditioningPayload } from '../engines/registry';
import {
  buildAudioChunkKey,
  getVoice,
  saveAudioChunk,
  saveVoice,
} from '../storage/db';
import { MODEL_CACHE_NAME } from '../storage/modelCache';
import type {
  AudioBufferData,
  ReferenceClipMetadata,
  VoiceCloningEngine,
  VoiceProfile,
} from '../types';

const KYUTAI_VOICES_REPO = 'kyutai/tts-voices';
const KYUTAI_VOICES_REV = '323332d33f997de8394f24a193e1a76df720e01a';
const CHATTERBOX_REPO = 'onnx-community/chatterbox-ONNX';
const CHATTERBOX_REV = '3cab09af388d3f02bba43443fce88c1f4525ac43';

export interface BuiltinVoiceCatalogEntry {
  id: string;
  name: string;
  role: string;
  description: string;
  language: string;
  license: 'CC0' | 'CC-BY-4.0' | 'MIT';
  attribution: string;
  sourceUrl: string;
  sizeBytes: number;
  tags: string[];
}

export const DEFAULT_BUILTIN_VOICE_ID = 'builtin-bill-boerst';

export const BUILTIN_VOICES: readonly BuiltinVoiceCatalogEntry[] = [
  {
    id: 'builtin-bill-boerst',
    name: 'Bill — Documentary Baritone',
    role: 'Documentary / Journalism',
    description:
      'Measured, grounded male narrator suited for documentaries, investigative explainers, and long-form essays.',
    language: 'en',
    license: 'CC0',
    attribution: 'Voice-Zero / LibriVox public-domain collection via kyutai/tts-voices (CC0)',
    sourceUrl: `https://huggingface.co/${KYUTAI_VOICES_REPO}/resolve/${KYUTAI_VOICES_REV}/voice-zero/bill_boerst.wav`,
    sizeBytes: 955_496,
    tags: ['built-in', 'documentary', 'baritone', 'cc0'],
  },
  {
    id: 'builtin-alba-casual',
    name: 'Alba — Warm Narrator',
    role: 'Storytelling / Conversational',
    description:
      'Natural, expressive female voice by Alba MacKenna for storytelling, essays, and YouTube narration.',
    language: 'en',
    license: 'CC-BY-4.0',
    attribution: 'Alba MacKenna via kyutai/tts-voices (CC-BY-4.0)',
    sourceUrl: `https://huggingface.co/${KYUTAI_VOICES_REPO}/resolve/${KYUTAI_VOICES_REV}/alba-mackenna/casual.wav`,
    sizeBytes: 958_542,
    tags: ['built-in', 'storytelling', 'warm', 'cc-by-4.0'],
  },
  {
    id: 'builtin-alba-announcer',
    name: 'Alba — Broadcast Announcer',
    role: 'News / High-Impact',
    description:
      'Crisp, high-projection female broadcast voice suited for news briefs, trailers, and urgent narration.',
    language: 'en',
    license: 'CC-BY-4.0',
    attribution: 'Alba MacKenna via kyutai/tts-voices (CC-BY-4.0)',
    sourceUrl: `https://huggingface.co/${KYUTAI_VOICES_REPO}/resolve/${KYUTAI_VOICES_REV}/alba-mackenna/announcer.wav`,
    sizeBytes: 958_542,
    tags: ['built-in', 'broadcast', 'crisp', 'cc-by-4.0'],
  },
  {
    id: 'builtin-caro-davy',
    name: 'Caro — Calm Storytelling',
    role: 'Audiobooks / Tutorials',
    description:
      'Clear, steady female voice suited for educational courses, guided narration, and audiobooks.',
    language: 'en',
    license: 'CC0',
    attribution: 'Voice-Zero / LibriVox public-domain collection via kyutai/tts-voices (CC0)',
    sourceUrl: `https://huggingface.co/${KYUTAI_VOICES_REPO}/resolve/${KYUTAI_VOICES_REV}/voice-zero/caro_davy.wav`,
    sizeBytes: 743_528,
    tags: ['built-in', 'educational', 'calm', 'cc0'],
  },
  {
    id: 'builtin-peter-yearsley',
    name: 'Peter — Classic Audiobook',
    role: 'Fiction / History',
    description:
      'Articulate classic male audiobook reader suited for history, biographies, and narrative fiction.',
    language: 'en',
    license: 'CC0',
    attribution: 'Voice-Zero / LibriVox public-domain collection via kyutai/tts-voices (CC0)',
    sourceUrl: `https://huggingface.co/${KYUTAI_VOICES_REPO}/resolve/${KYUTAI_VOICES_REV}/voice-zero/peter_yearsley.wav`,
    sizeBytes: 524_448,
    tags: ['built-in', 'audiobook', 'classic', 'cc0'],
  },
  {
    id: 'builtin-stuart-bell',
    name: 'Stuart — Editorial Narrator',
    role: 'Analysis / Non-Fiction',
    description:
      'Calm, authoritative male voice suited for analysis, technical tutorials, and podcasts.',
    language: 'en',
    license: 'CC0',
    attribution: 'Voice-Zero / LibriVox public-domain collection via kyutai/tts-voices (CC0)',
    sourceUrl: `https://huggingface.co/${KYUTAI_VOICES_REPO}/resolve/${KYUTAI_VOICES_REV}/voice-zero/stuart_bell.wav`,
    sizeBytes: 745_776,
    tags: ['built-in', 'editorial', 'authoritative', 'cc0'],
  },
  {
    id: 'builtin-chatterbox-default',
    name: 'Studio Neutral — Reference',
    role: 'General Purpose',
    description:
      'Balanced neutral reference speaker from onnx-community/chatterbox-ONNX (MIT license).',
    language: 'en',
    license: 'MIT',
    attribution: 'onnx-community/chatterbox-ONNX default_voice.wav (MIT)',
    sourceUrl: `https://huggingface.co/${CHATTERBOX_REPO}/resolve/${CHATTERBOX_REV}/default_voice.wav`,
    sizeBytes: 714_320,
    tags: ['built-in', 'neutral', 'mit'],
  },
];

export function isBuiltinVoiceId(voiceId: string | null | undefined): boolean {
  if (!voiceId) return false;
  return BUILTIN_VOICES.some((entry) => entry.id === voiceId);
}

export function getBuiltinVoiceById(
  voiceId: string | null | undefined
): BuiltinVoiceCatalogEntry | undefined {
  if (!voiceId) return undefined;
  return BUILTIN_VOICES.find((entry) => entry.id === voiceId);
}

function builtinCacheKeyUrl(entry: BuiltinVoiceCatalogEntry): string {
  return `https://voiceforge-cache.local/builtin-voices/${entry.id}.wav`;
}

/**
 * Fetch and decode a built-in open-licensed reference WAV locally, caching its bytes
 * inside Cache Storage (`voiceforge-models-v1`) so subsequent runs work 100% offline.
 */
export async function fetchBuiltinVoiceAudioBuffer(
  entry: BuiltinVoiceCatalogEntry,
  options: { signal?: AbortSignal; fetchImpl?: typeof fetch } = {}
): Promise<AudioBufferData> {
  const cacheUrl = builtinCacheKeyUrl(entry);
  let wavBytes: ArrayBuffer | null = null;

  if (typeof caches !== 'undefined') {
    try {
      const cache = await caches.open(MODEL_CACHE_NAME);
      const cachedResp = await cache.match(cacheUrl);
      if (cachedResp && cachedResp.ok) {
        wavBytes = await cachedResp.arrayBuffer();
      }
    } catch {
      // Ignore Cache Storage read failures and fetch from network.
    }
  }

  if (!wavBytes) {
    const fetchFn = options.fetchImpl ?? globalThis.fetch.bind(globalThis);
    const response = await fetchFn(entry.sourceUrl, { signal: options.signal });
    if (!response.ok) {
      throw new Error(
        `Failed to fetch built-in voice '${entry.name}' (${response.status} ${response.statusText}).`
      );
    }
    wavBytes = await response.arrayBuffer();

    if (typeof caches !== 'undefined' && wavBytes.byteLength > 0) {
      try {
        const cache = await caches.open(MODEL_CACHE_NAME);
        await cache.put(
          cacheUrl,
          new Response(wavBytes.slice(0), {
            status: 200,
            headers: {
              'Content-Type': 'audio/wav',
              'X-VoiceForge-License': entry.license,
            },
          })
        );
      } catch {
        // Non-fatal if cache quota prevents saving sample WAV.
      }
    }
  }

  return await decodeAudioArrayBuffer(wavBytes, {
    filename: `${entry.id}.wav`,
    mono: true,
  });
}

/**
 * Ensure a built-in stock voice has an encoded conditioning payload for `engine`
 * stored in IndexedDB (`voices`), downloading/caching/encoding its reference clip lazily
 * on first use and preserving payloads already encoded for other engines.
 */
export async function ensureBuiltinVoiceEncoded(
  entry: BuiltinVoiceCatalogEntry,
  engine: VoiceCloningEngine,
  options: { signal?: AbortSignal; fetchImpl?: typeof fetch } = {}
): Promise<VoiceProfile> {
  const existing = await getVoice(entry.id);
  if (existing && getCompatibleConditioningPayload(existing, engine)) {
    return existing;
  }

  const audioBuffer = await fetchBuiltinVoiceAudioBuffer(entry, options);
  const analysis = analyzeReferenceAudio(audioBuffer, {
    minRecommendedSec: engine.capabilities.minReferenceDurationSec,
    maxRecommendedSec: engine.capabilities.maxReferenceDurationSec,
  });

  const now = new Date().toISOString();
  const clipMeta: ReferenceClipMetadata = {
    clipId: `${entry.id}-ref`,
    filename: `${entry.id}.wav`,
    mimeType: 'audio/wav',
    source: 'sample',
    durationSec: audioBuffer.durationSec,
    sampleRate: audioBuffer.sampleRate,
    channels: audioBuffer.channels,
    language: entry.language,
    capturedAt: now,
  };

  const payload = await engine.encodeVoice(audioBuffer, clipMeta);
  const payloadKey = `${payload.engineId}::${payload.modelRevision}`;
  const previewClipKey = buildAudioChunkKey('voice-preview', entry.id);

  await saveAudioChunk({
    projectId: 'voice-preview',
    chunkId: entry.id,
    sampleRate: audioBuffer.sampleRate,
    pcm: audioBuffer.samples,
    durationSec: audioBuffer.durationSec,
  });

  const profile: VoiceProfile = {
    id: entry.id,
    name: existing?.name ?? entry.name,
    description: existing?.description ?? `${entry.description} (${entry.attribution})`,
    language: entry.language,
    tags: existing?.tags ?? [...entry.tags],
    referenceClip: existing?.referenceClip ?? clipMeta,
    qualityAnalysis: existing?.qualityAnalysis ?? analysis,
    authorizedUse: existing?.authorizedUse ?? {
      confirmed: true,
      confirmedAt: now,
      attestationText: `Open-licensed stock voice (${entry.license}): ${entry.attribution}`,
      sourceBasis: 'licensed-talent',
      verificationScope: 'client-self-attested',
    },
    conditioningPayloads: {
      ...(existing?.conditioningPayloads ?? {}),
      [payloadKey]: payload,
    },
    previewClipId: previewClipKey,
    createdAt: existing?.createdAt ?? now,
    updatedAt: now,
  };

  await saveVoice(profile, { engineId: engine.id });
  return profile;
}
