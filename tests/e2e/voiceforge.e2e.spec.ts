import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { unzipSync } from 'fflate';
import {
  chromium,
  expect,
  test,
  type Browser,
  type BrowserContext,
  type Download,
  type Page,
} from '@playwright/test';

const FIXTURE_DIR = resolve(process.cwd(), 'test-results', 'fixtures');
const FIXTURE_WAV_PATH = join(FIXTURE_DIR, 'default_voice.wav');
const FIXTURE_URL =
  'https://huggingface.co/onnx-community/chatterbox-ONNX/resolve/3cab09af388d3f02bba43443fce88c1f4525ac43/default_voice.wav';
const FIXTURE_SIZE_BYTES = 714_320;
const FIXTURE_SHA256 = '3ebc531cdaba358a327099c1c4f0448026719957bcf4d8e9868767f227e02f4e';

const TELEMETRY_PATH = resolve(process.cwd(), 'test-results', 'e2e-telemetry.json');

const SCRIPT_1 =
  'Hello from VoiceForge Studio. This is our first live browser voice cloning test.';
const SCRIPT_2 =
  'Persistence check complete. Reloading the studio preserves our cloned voice profile locally.';
const SCRIPT_3_OFFLINE =
  'Offline inference check. This speech was generated locally with zero network connectivity.';

const MULTI_PARAGRAPH_PARAGRAPHS = [
  'Paragraph one begins our multi-paragraph narration test inside VoiceForge Studio.',
  'Paragraph two checks that queued chunks persist cleanly to IndexedDB after each step.',
  'Paragraph three verifies that cancelling and resuming keeps every sentence in exact order.',
  'Paragraph four finishes the complete story so the merged audio and zip exports validate.',
];
const MULTI_PARAGRAPH_SCRIPT = MULTI_PARAGRAPH_PARAGRAPHS.join('\n\n');

interface CapturedRequest {
  url: string;
  method: string;
  resourceType: string;
  hasPostData: boolean;
  postDataSnippet: string | null;
}

interface ParsedWav {
  sampleRate: number;
  channels: number;
  bitsPerSample: number;
  samples: number[];
  durationSec: number;
  dataSize: number;
  rms: number;
  peak: number;
  nonFiniteCount: number;
}

function parseWavBuffer(buf: Buffer): ParsedWav {
  if (
    buf.byteLength < 44 ||
    buf.toString('ascii', 0, 4) !== 'RIFF' ||
    buf.toString('ascii', 8, 12) !== 'WAVE'
  ) {
    throw new Error('Invalid WAV RIFF/WAVE header');
  }

  let offset = 12;
  let audioFormat = 1;
  let channels = 1;
  let sampleRate = 24000;
  let bitsPerSample = 16;
  let dataOffset = -1;
  let dataSize = 0;

  while (offset + 8 <= buf.length) {
    const chunkId = buf.toString('ascii', offset, offset + 4);
    const chunkSize = buf.readUInt32LE(offset + 4);
    const bodyOffset = offset + 8;

    if (chunkId === 'fmt ') {
      audioFormat = buf.readUInt16LE(bodyOffset);
      channels = buf.readUInt16LE(bodyOffset + 2);
      sampleRate = buf.readUInt32LE(bodyOffset + 4);
      bitsPerSample = buf.readUInt16LE(bodyOffset + 14);
    } else if (chunkId === 'data') {
      dataOffset = bodyOffset;
      dataSize = chunkSize;
      break;
    }

    offset = bodyOffset + chunkSize + (chunkSize % 2);
  }

  if (dataOffset < 0 || dataSize <= 0) {
    throw new Error(`Missing or empty WAV data chunk (dataOffset=${dataOffset}, dataSize=${dataSize})`);
  }

  const bytesPerSample = bitsPerSample / 8;
  const totalSamples = Math.floor(dataSize / bytesPerSample);
  const samples = new Array<number>(totalSamples);

  let sumSq = 0;
  let peak = 0;
  let nonFiniteCount = 0;

  for (let i = 0; i < totalSamples; i += 1) {
    const pos = dataOffset + i * bytesPerSample;
    let val = 0;
    if (audioFormat === 3 && bitsPerSample === 32) {
      val = buf.readFloatLE(pos);
    } else if (audioFormat === 1 && bitsPerSample === 16) {
      val = buf.readInt16LE(pos) / 32768;
    } else if (audioFormat === 1 && bitsPerSample === 24) {
      const b0 = buf[pos];
      const b1 = buf[pos + 1];
      const b2 = buf[pos + 2];
      let raw = b0 | (b1 << 8) | (b2 << 16);
      if (raw & 0x800000) raw |= ~0xffffff;
      val = raw / 8388608;
    } else {
      throw new Error(`Unsupported WAV format=${audioFormat}, bits=${bitsPerSample}`);
    }
    samples[i] = val;
    if (!Number.isFinite(val)) {
      nonFiniteCount += 1;
    } else {
      const abs = Math.abs(val);
      if (abs > peak) peak = abs;
      sumSq += val * val;
    }
  }

  return {
    sampleRate,
    channels,
    bitsPerSample,
    samples,
    durationSec: totalSamples / channels / sampleRate,
    dataSize,
    rms: Math.sqrt(sumSq / Math.max(1, totalSamples)),
    peak,
    nonFiniteCount,
  };
}

function verifyMp3Bytes(buf: Buffer): {
  hasId3Header: boolean;
  frameSyncOffset: number;
  frameSyncBytes: string;
  byteLength: number;
} {
  if (buf.byteLength < 64) {
    throw new Error(`MP3 buffer too small: ${buf.byteLength} bytes`);
  }

  const hasId3Header = buf.toString('ascii', 0, 3) === 'ID3';
  let searchStart = 0;
  if (hasId3Header && buf.byteLength >= 10) {
    const tagSize =
      ((buf[6] & 0x7f) << 21) |
      ((buf[7] & 0x7f) << 14) |
      ((buf[8] & 0x7f) << 7) |
      (buf[9] & 0x7f);
    searchStart = Math.min(buf.byteLength - 2, 10 + tagSize);
  }

  let frameSyncOffset = -1;
  let frameSyncBytes = '';
  for (let i = searchStart; i < buf.byteLength - 1; i += 1) {
    if (buf[i] === 0xff && (buf[i + 1] & 0xe0) === 0xe0) {
      frameSyncOffset = i;
      frameSyncBytes = `0x${buf[i].toString(16).toUpperCase()} 0x${buf[i + 1]
        .toString(16)
        .toUpperCase()}`;
      break;
    }
  }

  if (!hasId3Header && frameSyncOffset < 0) {
    throw new Error('MP3 buffer has neither an ID3 header nor an MPEG frame sync header.');
  }

  return {
    hasId3Header,
    frameSyncOffset,
    frameSyncBytes,
    byteLength: buf.byteLength,
  };
}

async function readDownloadBuffer(download: Download, savePath: string): Promise<Buffer> {
  await download.saveAs(savePath);
  return readFileSync(savePath);
}

async function ensureReferenceFixture(): Promise<void> {
  mkdirSync(FIXTURE_DIR, { recursive: true });
  if (existsSync(FIXTURE_WAV_PATH)) {
    const existing = readFileSync(FIXTURE_WAV_PATH);
    const sha = createHash('sha256').update(existing).digest('hex');
    if (existing.byteLength === FIXTURE_SIZE_BYTES && sha === FIXTURE_SHA256) {
      return;
    }
  }

  const resp = await fetch(FIXTURE_URL);
  if (!resp.ok) {
    throw new Error(`Failed to download default_voice.wav: HTTP ${resp.status}`);
  }
  const bytes = Buffer.from(await resp.arrayBuffer());
  const sha = createHash('sha256').update(bytes).digest('hex');
  if (bytes.byteLength !== FIXTURE_SIZE_BYTES || sha !== FIXTURE_SHA256) {
    throw new Error(
      `Fixture integrity check failed: size=${bytes.byteLength} (expected ${FIXTURE_SIZE_BYTES}), sha256=${sha}`
    );
  }
  writeFileSync(FIXTURE_WAV_PATH, bytes);
}

function recordTelemetry(channel: string, data: Record<string, unknown>): void {
  mkdirSync(resolve(process.cwd(), 'test-results'), { recursive: true });
  let existing: Record<string, unknown> = {};
  if (existsSync(TELEMETRY_PATH)) {
    try {
      existing = JSON.parse(readFileSync(TELEMETRY_PATH, 'utf-8')) as Record<string, unknown>;
    } catch {
      existing = {};
    }
  }
  existing[channel] = {
    ...(typeof existing[channel] === 'object' && existing[channel] !== null
      ? (existing[channel] as Record<string, unknown>)
      : {}),
    ...data,
    recordedAt: new Date().toISOString(),
  };
  writeFileSync(TELEMETRY_PATH, JSON.stringify(existing, null, 2));
}

function isAllowedNetworkRequest(
  req: CapturedRequest,
  targetOrigin: string
): { allowed: boolean; reason?: string } {
  if (
    req.url.startsWith('blob:') ||
    req.url.startsWith('data:') ||
    req.url.startsWith('edge://') ||
    req.url.startsWith('chrome://') ||
    req.url.startsWith('https://voiceforge-cache.local/')
  ) {
    return { allowed: true };
  }

  let parsed: URL;
  try {
    parsed = new URL(req.url);
  } catch {
    return { allowed: false, reason: `Invalid request URL: ${req.url}` };
  }

  if (parsed.origin === targetOrigin) {
    return { allowed: true };
  }

  const host = parsed.hostname.toLowerCase();
  const isPinnedHfHost =
    host === 'huggingface.co' ||
    host.endsWith('.huggingface.co') ||
    host.endsWith('.hf.co');

  if (!isPinnedHfHost) {
    return { allowed: false, reason: `Unexpected external host: ${req.url}` };
  }

  if (req.method !== 'GET' && req.method !== 'HEAD') {
    return { allowed: false, reason: `Non-GET request to external host: ${req.method} ${req.url}` };
  }

  if (req.hasPostData) {
    return { allowed: false, reason: `Request to external host carried POST body: ${req.url}` };
  }

  return { allowed: true };
}

function parseTimecodeSeconds(text: string): number {
  const match = text.match(/(\d{2}):(\d{2})\.(\d)\s*\/\s*(\d{2}):(\d{2})\.(\d)/);
  if (!match) return 0;
  const mins = Number(match[4]);
  const secs = Number(match[5]);
  const tenths = Number(match[6]);
  return mins * 60 + secs + tenths / 10;
}

async function openProductionApp(
  channel: 'chrome' | 'msedge',
  baseURL: string
): Promise<{
  browser: Browser;
  context: BrowserContext;
  page: Page;
  consoleErrors: Array<{ text: string; url: string }>;
  pageErrors: string[];
  networkRequests: CapturedRequest[];
}> {
  const browser = await chromium.launch({
    channel,
    headless: true,
    args: ['--enable-unsafe-webgpu', '--autoplay-policy=no-user-gesture-required'],
  });
  const context = await browser.newContext({ acceptDownloads: true });
  const page = await context.newPage();

  const consoleErrors: Array<{ text: string; url: string }> = [];
  const pageErrors: string[] = [];
  const networkRequests: CapturedRequest[] = [];

  page.on('console', (msg) => {
    if (msg.type() === 'error') {
      consoleErrors.push({ text: msg.text(), url: msg.location().url });
    }
  });
  page.on('pageerror', (err) => {
    pageErrors.push(err.message);
  });
  context.on('request', (req) => {
    const postData = req.postData();
    networkRequests.push({
      url: req.url(),
      method: req.method(),
      resourceType: req.resourceType(),
      hasPostData: Boolean(postData),
      postDataSnippet: postData ? postData.slice(0, 120) : null,
    });
  });

  await page.addInitScript(() => {
    const w = window as unknown as {
      __SPEECH_SYNTHESIS_CALLS__: number;
      __WEB_AUDIO_STARTS__: number;
    };
    w.__SPEECH_SYNTHESIS_CALLS__ = 0;
    w.__WEB_AUDIO_STARTS__ = 0;

    if ('speechSynthesis' in window && window.speechSynthesis) {
      const origSpeak = window.speechSynthesis.speak.bind(window.speechSynthesis);
      window.speechSynthesis.speak = (utterance: SpeechSynthesisUtterance) => {
        w.__SPEECH_SYNTHESIS_CALLS__ += 1;
        return origSpeak(utterance);
      };
    }

    if (typeof AudioBufferSourceNode !== 'undefined') {
      const origStart = AudioBufferSourceNode.prototype.start;
      AudioBufferSourceNode.prototype.start = function (...args: Parameters<AudioBufferSourceNode['start']>) {
        w.__WEB_AUDIO_STARTS__ += 1;
        return origStart.apply(this, args);
      };
    }
  });

  await page.goto(baseURL, { waitUntil: 'domcontentloaded' });
  return { browser, context, page, consoleErrors, pageErrors, networkRequests };
}

const CHANNELS: Array<'chrome' | 'msedge'> = ['chrome', 'msedge'];

test.describe('VoiceForge Studio 15-Step Real-Browser Production E2E Suite', () => {
  test.describe.configure({ mode: 'serial' });

  test.beforeAll(async () => {
    await ensureReferenceFixture();
  });

  for (const channel of CHANNELS) {
    test(`Complete 15-step real-browser E2E flow in ${channel}`, async ({ baseURL }) => {
      test.setTimeout(600_000);
      const targetBaseUrl = baseURL ?? 'http://127.0.0.1:4173';
      const targetOrigin = new URL(targetBaseUrl).origin;
      const exportDir = resolve(process.cwd(), 'test-results', `e2e-exports-${channel}`);
      mkdirSync(exportDir, { recursive: true });

      const { browser, context, page, consoleErrors, pageErrors, networkRequests } =
        await openProductionApp(channel, targetBaseUrl);

      const stepTimingsMs: Record<string, number> = {};
      const suiteStartMs = Date.now();
      const voiceName = `E2E Cloned Voice (${channel})`;
      const projectName = `E2E Multi-Paragraph (${channel})`;

      try {
        // ------------------------------------------------------------------
        // Step 1: Load app (#/ -> #/dashboard), verify zero console/page errors
        // ------------------------------------------------------------------
        let t0 = Date.now();
        await expect(page).toHaveURL(/#\/dashboard$/);
        await expect(
          page.getByRole('heading', { name: /Local Browser Voice Cloning & Narration Workspace/i })
        ).toBeVisible({ timeout: 20_000 });
        await expect(page.getByText('Hardware & Browser Runtime Probe')).toBeVisible();
        await expect(page.getByText('WebGPU Adapter')).toBeVisible({ timeout: 15_000 });

        const hardwareSnapshot = await page.evaluate(async () => {
          const cards = Array.from(document.querySelectorAll('section')).map((s) => s.textContent ?? '');
          const swReady =
            'serviceWorker' in navigator
              ? await navigator.serviceWorker.ready.then((reg) => Boolean(reg.active)).catch(() => false)
              : false;
          return {
            userAgent: navigator.userAgent,
            crossOriginIsolated: window.crossOriginIsolated,
            hardwareConcurrency: navigator.hardwareConcurrency,
            swReady,
            dashboardSummary: cards[1] ?? '',
            hardwareProbeText: cards[2] ?? '',
          };
        });

        expect(consoleErrors).toEqual([]);
        expect(pageErrors).toEqual([]);
        stepTimingsMs.step1_dashboard = Date.now() - t0;

        // ------------------------------------------------------------------
        // Step 2: Navigate to Model Manager (#/models), download Pocket TTS,
        //         verify live progress & Offline Ready completion
        // ------------------------------------------------------------------
        t0 = Date.now();
        await page.locator('a[href="#/models"]').first().click();
        await expect(page).toHaveURL(/#\/models$/);

        const pocketCard = page
          .locator('article')
          .filter({ hasText: 'Pocket TTS (English 2026-04, INT8)' });
        await expect(pocketCard).toBeVisible({ timeout: 15_000 });

        const downloadBtn = pocketCard.getByRole('button', { name: /Download & Cache/i });
        await expect(downloadBtn).toBeVisible();
        await downloadBtn.click();

        // Confirm live download/progress state renders before or during download
        await expect(
          pocketCard.getByRole('button', { name: /Cancel Download/i }).or(
            pocketCard.getByText(/Offline Ready \(100% Verified\)/i)
          )
        ).toBeVisible({ timeout: 15_000 });

        await expect(pocketCard.getByText('Offline Ready (100% Verified)')).toBeVisible({
          timeout: 240_000,
        });
        stepTimingsMs.step2_modelDownload = Date.now() - t0;

        // ------------------------------------------------------------------
        // Step 3: Navigate to Voice Cloning (#/clone) and upload default_voice.wav
        // ------------------------------------------------------------------
        t0 = Date.now();
        await page.locator('a[href="#/clone"]').first().click();
        await expect(page).toHaveURL(/#\/clone$/);
        await expect(page.getByRole('heading', { name: 'Voice Cloning Lab' })).toBeVisible();

        const fileInput = page.locator('input[type="file"]').first();
        await fileInput.setInputFiles(FIXTURE_WAV_PATH);
        await expect(page.getByText('Session Clips (1)')).toBeVisible({ timeout: 15_000 });
        await expect(page.getByText('default_voice.wav').first()).toBeVisible();
        stepTimingsMs.step3_uploadReference = Date.now() - t0;

        // ------------------------------------------------------------------
        // Step 4: Inspect quality analysis metrics, confirm authorization +
        //         source basis, enter voice name, encode & save voice profile
        // ------------------------------------------------------------------
        t0 = Date.now();
        await expect(page.getByText('Reference Quality Report')).toBeVisible();
        await expect(page.getByText(/\d+\/100\s*·/)).toBeVisible();
        await expect(page.getByText(/dB SNR/)).toBeVisible();
        await expect(page.getByText(/Active speech:/)).toBeVisible();

        await page.locator('#auth-source-basis').selectOption('other');
        const authCheckbox = page
          .locator('label')
          .filter({ hasText: 'I confirm that I own or hold explicit legal authorization' })
          .locator('input[type="checkbox"]');
        await authCheckbox.check();
        await expect(page.getByText('Confirmed (Self-Attested)')).toBeVisible();

        await page.locator('#voice-name-input').fill(voiceName);
        const encodeBtn = page.getByRole('button', { name: /Encode & Save Voice Profile/i });
        await expect(encodeBtn).toBeEnabled();
        await encodeBtn.click();

        await expect(
          page.getByRole('heading', { name: `Voice Profile Saved: ${voiceName}` })
        ).toBeVisible({ timeout: 60_000 });
        stepTimingsMs.step4_encodeAndSaveVoice = Date.now() - t0;

        // ------------------------------------------------------------------
        // Step 5: Navigate to Text to Speech Studio (#/studio), select saved
        //         voice, enter script, generate spoken audio
        // ------------------------------------------------------------------
        t0 = Date.now();
        await page.locator('a[href="#/studio"]').first().click();
        await expect(page).toHaveURL(/#\/studio$/);
        await expect(page.getByText('Model cache: Offline Ready')).toBeVisible({ timeout: 15_000 });

        const voiceSelect = page
          .locator('label')
          .filter({ hasText: /^Voice Profile$/ })
          .locator('..')
          .locator('select');
        const matchingVoiceValue = await voiceSelect.evaluate((el, targetName) => {
          const select = el as HTMLSelectElement;
          const opt = Array.from(select.options).find((o) => o.text.includes(targetName));
          return opt ? opt.value : '';
        }, voiceName);
        expect(matchingVoiceValue).not.toBe('');
        await voiceSelect.selectOption(matchingVoiceValue);

        const scriptTextarea = page.locator('textarea');
        await scriptTextarea.fill(SCRIPT_1);

        const generateBtn = page.getByRole('button', { name: /Generate Narration/i });
        await expect(generateBtn).toBeEnabled();
        await generateBtn.click();

        await expect(page.getByText('All paragraphs synthesized')).toBeVisible({ timeout: 90_000 });
        stepTimingsMs.step5_studioGenerate1 = Date.now() - t0;

        // ------------------------------------------------------------------
        // Step 6: Click Play on waveform player, verify Web Audio triggers
        //         cleanly (0 errors) & generated PCM duration > 0
        // ------------------------------------------------------------------
        t0 = Date.now();
        const studioPlayerCard = page
          .locator('div')
          .filter({ hasText: /^Audio Playback/ })
          .first()
          .locator('..');
        await expect(studioPlayerCard.getByText(/24000 Hz/)).toBeVisible();

        const durationText = await studioPlayerCard.locator('span.font-mono').first().textContent();
        const playButton = studioPlayerCard.getByRole('button', { name: 'Play audio' });
        await expect(playButton).toBeEnabled();

        const timecodeText = await studioPlayerCard
          .locator('text=/\\d{2}:\\d{2}\\.\\d\\s*\\/\\s*\\d{2}:\\d{2}\\.\\d/')
          .textContent();
        const playerDurationSec = parseTimecodeSeconds(timecodeText ?? '');
        expect(playerDurationSec).toBeGreaterThan(1.0);

        const startsBefore = await page.evaluate(
          () => (window as unknown as { __WEB_AUDIO_STARTS__: number }).__WEB_AUDIO_STARTS__
        );
        await playButton.click();
        await expect(
          studioPlayerCard.getByRole('button', { name: 'Pause playback' })
        ).toBeVisible({ timeout: 5_000 });

        await page.waitForTimeout(350);
        const startsAfter = await page.evaluate(
          () => (window as unknown as { __WEB_AUDIO_STARTS__: number }).__WEB_AUDIO_STARTS__
        );
        expect(startsAfter).toBeGreaterThan(startsBefore);

        await studioPlayerCard.getByRole('button', { name: 'Pause playback' }).click();
        expect(consoleErrors).toEqual([]);
        expect(pageErrors).toEqual([]);
        stepTimingsMs.step6_waveformPlayback = Date.now() - t0;

        // ------------------------------------------------------------------
        // Step 7: Open Export modal, export valid WAV (RIFF+WAVE, 24000 Hz)
        // ------------------------------------------------------------------
        t0 = Date.now();
        await page.getByRole('button', { name: 'Export', exact: true }).click();
        await expect(page.getByRole('heading', { name: 'Export Narration & Assets' })).toBeVisible();

        const formatSelect = page
          .locator('label')
          .filter({ hasText: /^Audio Format$/ })
          .locator('..')
          .locator('select');
        await formatSelect.selectOption('wav16');

        const wavDownloadPromise = page.waitForEvent('download');
        await page.getByRole('button', { name: 'Download Full Mastered Narration' }).click();
        const wavDownload = await wavDownloadPromise;
        expect(wavDownload.suggestedFilename().toLowerCase()).toMatch(/\.wav$/);

        const wavBuf = await readDownloadBuffer(wavDownload, join(exportDir, 'step7-export.wav'));
        const wavStats = parseWavBuffer(wavBuf);
        expect(wavStats.sampleRate).toBe(24000);
        expect(wavStats.dataSize).toBeGreaterThan(0);
        expect(wavStats.durationSec).toBeGreaterThan(1.0);
        expect(wavStats.rms).toBeGreaterThan(0.005);
        expect(wavStats.nonFiniteCount).toBe(0);
        stepTimingsMs.step7_exportWav = Date.now() - t0;

        // ------------------------------------------------------------------
        // Step 8: Export valid MP3 (ID3 / MPEG frame sync, non-zero bytes)
        // ------------------------------------------------------------------
        t0 = Date.now();
        await formatSelect.selectOption('mp3_128');

        const mp3DownloadPromise = page.waitForEvent('download');
        await page.getByRole('button', { name: 'Download Full Mastered Narration' }).click();
        const mp3Download = await mp3DownloadPromise;
        expect(mp3Download.suggestedFilename().toLowerCase()).toMatch(/\.mp3$/);

        const mp3Buf = await readDownloadBuffer(mp3Download, join(exportDir, 'step8-export.mp3'));
        const mp3Check = verifyMp3Bytes(mp3Buf);
        expect(mp3Check.hasId3Header).toBe(true);
        expect(mp3Check.frameSyncOffset).toBeGreaterThan(0);
        expect(mp3Check.byteLength).toBeGreaterThan(2000);

        // Close Export modal
        await page.locator('div.fixed.inset-0 button').first().click();
        await expect(page.getByRole('heading', { name: 'Export Narration & Assets' })).toBeHidden();
        stepTimingsMs.step8_exportMp3 = Date.now() - t0;

        // ------------------------------------------------------------------
        // Step 9: Reload the page (page.reload())
        // ------------------------------------------------------------------
        t0 = Date.now();
        await page.reload({ waitUntil: 'domcontentloaded' });
        await expect(page).toHaveURL(/#\/studio$/);
        stepTimingsMs.step9_reload = Date.now() - t0;

        // ------------------------------------------------------------------
        // Step 10: Navigate to My Voices (#/voices) & Studio (#/studio),
        //          verify saved voice profile persisted in IndexedDB
        // ------------------------------------------------------------------
        t0 = Date.now();
        await page.locator('a[href="#/voices"]').first().click();
        await expect(page).toHaveURL(/#\/voices$/);
        await expect(page.getByRole('main').getByRole('heading', { name: 'My Voices' })).toBeVisible();
        await expect(page.getByRole('main').getByRole('heading', { name: voiceName })).toBeVisible({
          timeout: 15_000,
        });

        await page.locator('a[href="#/studio"]').first().click();
        await expect(page).toHaveURL(/#\/studio$/);

        const persistedVoiceSelect = page
          .locator('label')
          .filter({ hasText: /^Voice Profile$/ })
          .locator('..')
          .locator('select');
        const persistedVoiceValue = await persistedVoiceSelect.evaluate((el, targetName) => {
          const select = el as HTMLSelectElement;
          const opt = Array.from(select.options).find((o) => o.text.includes(targetName));
          return opt ? opt.value : '';
        }, voiceName);
        expect(persistedVoiceValue).not.toBe('');
        await persistedVoiceSelect.selectOption(persistedVoiceValue);
        stepTimingsMs.step10_verifyPersistedVoice = Date.now() - t0;

        // ------------------------------------------------------------------
        // Step 11: Generate a second, different script with persisted voice
        // ------------------------------------------------------------------
        t0 = Date.now();
        await page.locator('textarea').fill(SCRIPT_2);
        await page.getByRole('button', { name: /Generate Narration/i }).click();
        await expect(page.getByText('All paragraphs synthesized')).toBeVisible({ timeout: 90_000 });
        await expect(page.getByRole('button', { name: 'Export', exact: true })).toBeEnabled();
        stepTimingsMs.step11_generateSecondScript = Date.now() - t0;

        // ------------------------------------------------------------------
        // Step 12: Ensure SW active + precached, toggle offline mode, reload
        //          offline, and run real inference offline end-to-end
        // ------------------------------------------------------------------
        t0 = Date.now();
        await page.waitForFunction(
          async () => {
            if (!('serviceWorker' in navigator)) return false;
            const reg = await navigator.serviceWorker.ready;
            if (!reg.active || !navigator.serviceWorker.controller) return false;
            const cache = await caches.open('voiceforge-shell-v1');
            const keys = await cache.keys();
            return (
              keys.some((k) => k.url.endsWith('/index.html')) &&
              keys.some((k) => k.url.includes('ort-wasm-simd-threaded.mjs')) &&
              keys.some((k) => k.url.endsWith('/model-manifests/models.json'))
            );
          },
          undefined,
          { timeout: 30_000 }
        );

        await context.setOffline(true);
        try {
          await page.reload({ waitUntil: 'domcontentloaded' });
          await expect(page).toHaveURL(/#\/studio$/);
          await expect(page.getByText('Model cache: Offline Ready')).toBeVisible({
            timeout: 20_000,
          });

          const offlineVoiceSelect = page
            .locator('label')
            .filter({ hasText: /^Voice Profile$/ })
            .locator('..')
            .locator('select');
          await offlineVoiceSelect.selectOption(persistedVoiceValue);

          await page.locator('textarea').fill(SCRIPT_3_OFFLINE);
          await page.getByRole('button', { name: /Generate Narration/i }).click();
          await expect(page.getByText('All paragraphs synthesized')).toBeVisible({
            timeout: 90_000,
          });
          await expect(studioPlayerCard.getByText(/24000 Hz/)).toBeVisible();
        } finally {
          await context.setOffline(false);
        }
        stepTimingsMs.step12_offlineReloadAndSynth = Date.now() - t0;

        // ------------------------------------------------------------------
        // Step 13: Start multi-paragraph job (4 paragraphs), Cancel mid-job
        //          after >= 1 chunk completes, reload page, recover from
        //          #/projects -> #/studio, and resume to finish remaining chunks
        // ------------------------------------------------------------------
        t0 = Date.now();
        await page.getByLabel('Project title').fill(projectName);
        await page.locator('textarea').fill(MULTI_PARAGRAPH_SCRIPT);
        await expect(page.getByText('4 synthesis segments')).toBeVisible();

        await page.getByRole('button', { name: /Generate Narration/i }).click();

        // Wait until at least 1 chunk completes while queue is still running
        await expect(page.getByText(/[123]\s*\/\s*4\s*chunks/)).toBeVisible({
          timeout: 60_000,
        });
        const cancelQueueBtn = page.getByRole('button', { name: 'Cancel', exact: true });
        await expect(cancelQueueBtn).toBeVisible();
        await cancelQueueBtn.click();

        // Wait until queue stops running and Resume Queue button is shown
        await expect(page.getByRole('button', { name: 'Resume Queue' })).toBeVisible({
          timeout: 30_000,
        });

        // Reload page, go to #/projects, verify interrupted state, and open in Studio
        await page.reload({ waitUntil: 'domcontentloaded' });
        await page.locator('a[href="#/projects"]').first().click();
        await expect(page).toHaveURL(/#\/projects$/);
        await expect(page.getByRole('heading', { name: 'Narration Projects' })).toBeVisible();

        const projectCard = page.locator('div').filter({ hasText: projectName }).filter({
          has: page.getByRole('button', { name: 'Resume in Studio' }),
        }).first();
        await expect(projectCard).toBeVisible({ timeout: 15_000 });
        await expect(projectCard.getByText(/Interrupted job/i)).toBeVisible();
        await projectCard.getByRole('button', { name: 'Resume in Studio' }).click();

        await expect(page).toHaveURL(/#\/studio$/);
        const resumeBtn = page.getByRole('button', { name: 'Resume Queue' });
        await expect(resumeBtn).toBeVisible({ timeout: 15_000 });
        await resumeBtn.click();

        await expect(page.getByText('All paragraphs synthesized')).toBeVisible({
          timeout: 120_000,
        });
        await expect(page.getByText('4 / 4 chunks (100%)')).toBeVisible();
        stepTimingsMs.step13_cancelReloadRecoverResume = Date.now() - t0;

        // ------------------------------------------------------------------
        // Step 14: Verify exact paragraph order, zero skipped text, all chunk
        //          durations > 0, and merged WAV + Multi-Segment ZIP validity
        // ------------------------------------------------------------------
        t0 = Date.now();
        const navigatorAside = page.locator('aside').filter({ hasText: 'Paragraph Navigator' });
        const chunkCards = navigatorAside.locator('div.rounded-lg.border.p-3');
        await expect(chunkCards).toHaveCount(4);

        const chunkSummaries: Array<{ index: number; durationSec: number; text: string }> = [];
        for (let i = 0; i < 4; i += 1) {
          const card = chunkCards.nth(i);
          const headerText = (await card.locator('span.font-mono').first().textContent()) ?? '';
          expect(headerText).toContain(`Chunk #${i + 1}`);
          const durMatch = headerText.match(/(\d+(?:\.\d+)?)s/);
          const durSec = durMatch ? Number(durMatch[1]) : 0;
          expect(durSec).toBeGreaterThan(0);

          await expect(card.getByText('completed', { exact: false })).toBeVisible();
          const bodyText = ((await card.locator('p').first().textContent()) ?? '').trim();
          expect(bodyText).toBe(MULTI_PARAGRAPH_PARAGRAPHS[i]);
          chunkSummaries.push({ index: i, durationSec: durSec, text: bodyText });
        }

        // Open Export Modal -> download merged WAV + Multi-Segment ZIP
        await page.getByRole('button', { name: 'Export', exact: true }).click();
        await expect(page.getByRole('heading', { name: 'Export Narration & Assets' })).toBeVisible();

        await formatSelect.selectOption('wav16');
        const mergedWavPromise = page.waitForEvent('download');
        await page.getByRole('button', { name: 'Download Full Mastered Narration' }).click();
        const mergedWavDownload = await mergedWavPromise;
        const mergedWavBuf = await readDownloadBuffer(
          mergedWavDownload,
          join(exportDir, 'step14-merged.wav')
        );
        const mergedWavStats = parseWavBuffer(mergedWavBuf);
        expect(mergedWavStats.sampleRate).toBe(24000);
        expect(mergedWavStats.dataSize).toBeGreaterThan(0);
        expect(mergedWavStats.durationSec).toBeGreaterThan(8.0);
        expect(mergedWavStats.rms).toBeGreaterThan(0.005);
        expect(mergedWavStats.nonFiniteCount).toBe(0);

        const zipPromise = page.waitForEvent('download');
        await page.getByRole('button', { name: 'Multi-Segment ZIP' }).click();
        const zipDownload = await zipPromise;
        expect(zipDownload.suggestedFilename().toLowerCase()).toMatch(/\.zip$/);
        const zipBuf = await readDownloadBuffer(zipDownload, join(exportDir, 'step14-segments.zip'));
        const unzipped = unzipSync(new Uint8Array(zipBuf));
        const zipFilenames = Object.keys(unzipped).sort();

        for (let i = 1; i <= 4; i += 1) {
          const segName = `00${i}_paragraph_${i}.wav`;
          expect(zipFilenames).toContain(segName);
          const segWav = parseWavBuffer(Buffer.from(unzipped[segName]));
          expect(segWav.sampleRate).toBe(24000);
          expect(segWav.durationSec).toBeGreaterThan(0.5);
          expect(segWav.nonFiniteCount).toBe(0);
        }

        expect(zipFilenames).toContain('subtitles.srt');
        expect(zipFilenames).toContain('manifest.json');
        const zipManifest = JSON.parse(Buffer.from(unzipped['manifest.json']).toString('utf-8')) as {
          segments: Array<{ index: number; filename: string; durationSec: number; text?: string }>;
        };
        expect(zipManifest.segments).toHaveLength(4);
        for (let i = 0; i < 4; i += 1) {
          expect(zipManifest.segments[i].index).toBe(i + 1);
          expect(zipManifest.segments[i].durationSec).toBeGreaterThan(0);
          expect(zipManifest.segments[i].text).toBe(MULTI_PARAGRAPH_PARAGRAPHS[i]);
        }

        const srtText = Buffer.from(unzipped['subtitles.srt']).toString('utf-8');
        let lastPos = -1;
        for (const para of MULTI_PARAGRAPH_PARAGRAPHS) {
          const pos = srtText.indexOf(para);
          expect(pos).toBeGreaterThan(lastPos);
          lastPos = pos;
        }
        stepTimingsMs.step14_verifyOrderAndExports = Date.now() - t0;

        // ------------------------------------------------------------------
        // Step 15: Network request audit + zero speechSynthesis + zero errors
        // ------------------------------------------------------------------
        t0 = Date.now();
        const violations: string[] = [];
        const externalUrls = new Set<string>();
        let localRequestCount = 0;

        for (const req of networkRequests) {
          const verdict = isAllowedNetworkRequest(req, targetOrigin);
          if (!verdict.allowed) {
            violations.push(verdict.reason ?? req.url);
            continue;
          }
          if (req.url.startsWith(targetOrigin)) {
            localRequestCount += 1;
          } else if (req.url.startsWith('https://')) {
            externalUrls.add(req.url);
            expect(req.url).not.toContain('VoiceForge');
            expect(req.url).not.toContain(encodeURIComponent(SCRIPT_1));
            expect(req.url).not.toContain(encodeURIComponent(voiceName));
          }
        }

        expect(violations).toEqual([]);
        expect(externalUrls.size).toBeGreaterThan(0);

        const speechSynthesisCalls = await page.evaluate(
          () => (window as unknown as { __SPEECH_SYNTHESIS_CALLS__: number }).__SPEECH_SYNTHESIS_CALLS__
        );
        expect(speechSynthesisCalls).toBe(0);
        expect(consoleErrors).toEqual([]);
        expect(pageErrors).toEqual([]);
        stepTimingsMs.step15_networkAndErrorAudit = Date.now() - t0;

        recordTelemetry(channel, {
          status: 'PASS',
          totalElapsedMs: Date.now() - suiteStartMs,
          stepTimingsMs,
          hardwareSnapshot,
          playerDurationSec,
          step7Wav: {
            sampleRate: wavStats.sampleRate,
            durationSec: wavStats.durationSec,
            dataSize: wavStats.dataSize,
            rms: wavStats.rms,
            peak: wavStats.peak,
          },
          step8Mp3: mp3Check,
          step14MergedWav: {
            sampleRate: mergedWavStats.sampleRate,
            durationSec: mergedWavStats.durationSec,
            dataSize: mergedWavStats.dataSize,
            rms: mergedWavStats.rms,
            peak: mergedWavStats.peak,
          },
          step14Chunks: chunkSummaries,
          step14ZipFiles: zipFilenames,
          networkAudit: {
            totalCaptured: networkRequests.length,
            localRequestCount,
            externalGetCount: externalUrls.size,
            externalUrls: Array.from(externalUrls),
            violations,
          },
          speechSynthesisCalls,
          consoleErrorCount: consoleErrors.length,
          pageErrorCount: pageErrors.length,
          summaryDurationCheck: durationText,
        });
      } finally {
        await browser.close();
      }
    });
  }
});
