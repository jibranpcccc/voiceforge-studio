import { describe, expect, it } from 'vitest';
import { Mp3Encoder } from '@breezystack/lamejs';
import { zipSync, unzipSync } from 'fflate';
import type {
  AudioQualityAnalysis,
  ExportOptions,
  NarrationProject,
  PinnedModelManifest,
  VoiceCloningEngine,
  VoiceProfile,
} from '../src/types';

describe('scaffold smoke tests', () => {
  it('imports @breezystack/lamejs and encodes mono PCM to MP3 frames', () => {
    const encoder = new Mp3Encoder(1, 44100, 128);
    const samples = new Int16Array(1152);
    const chunk = encoder.encodeBuffer(samples);
    const tail = encoder.flush();

    expect(chunk.length + tail.length).toBeGreaterThan(0);
  });

  it('imports fflate cleanly for project zip export/import', () => {
    const payload = new TextEncoder().encode('voiceforge-studio');
    const zipped = zipSync({ 'manifest.txt': payload });
    const unzipped = unzipSync(zipped);

    expect(new TextDecoder().decode(unzipped['manifest.txt'])).toBe('voiceforge-studio');
  });

  it('exports strict core TypeScript contract types', () => {
    const sampleExport: ExportOptions = {
      format: 'mp3_192',
      sampleRate: 44100,
      channels: 'mono',
      applyMastering: true,
      normalizeOutput: true,
      filename: 'test-narration',
    };

    const typeSmoke: {
      exportOpts: ExportOptions;
      quality?: AudioQualityAnalysis;
      profile?: VoiceProfile;
      project?: NarrationProject;
      manifest?: PinnedModelManifest;
      engine?: VoiceCloningEngine;
    } = { exportOpts: sampleExport };

    expect(typeSmoke.exportOpts.format).toBe('mp3_192');
  });
});
