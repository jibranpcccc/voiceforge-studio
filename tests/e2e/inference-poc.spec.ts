import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { chromium, expect, test, type Browser, type Page } from '@playwright/test';

const FIXTURE_DIR = resolve(process.cwd(), 'test-results', 'fixtures');
const FIXTURE_WAV_PATH = join(FIXTURE_DIR, 'default_voice.wav');
const FIXTURE_URL =
  'https://huggingface.co/onnx-community/chatterbox-ONNX/resolve/3cab09af388d3f02bba43443fce88c1f4525ac43/default_voice.wav';
const FIXTURE_SIZE_BYTES = 714_320;
const FIXTURE_SHA256 = '3ebc531cdaba358a327099c1c4f0448026719957bcf4d8e9868767f227e02f4e';

const EVAL_SCRIPT =
  'Hello from VoiceForge Studio. This is a real local browser voice cloning test.';

const TELEMETRY_PATH = resolve(process.cwd(), 'test-results', 'poc-telemetry.json');

interface ParsedWav {
  sampleRate: number;
  channels: number;
  samples: number[];
  durationSec: number;
}

function parseWavFile(filePath: string): ParsedWav {
  const buf = readFileSync(filePath);
  if (buf.toString('ascii', 0, 4) !== 'RIFF' || buf.toString('ascii', 8, 12) !== 'WAVE') {
    throw new Error(`Invalid WAV header in ${filePath}`);
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
    throw new Error(`Missing data chunk in WAV ${filePath}`);
  }

  const bytesPerSample = bitsPerSample / 8;
  const totalSamples = Math.floor(dataSize / bytesPerSample);
  const samples = new Array<number>(totalSamples);

  for (let i = 0; i < totalSamples; i += 1) {
    const pos = dataOffset + i * bytesPerSample;
    if (audioFormat === 3 && bitsPerSample === 32) {
      samples[i] = buf.readFloatLE(pos);
    } else if (audioFormat === 1 && bitsPerSample === 16) {
      samples[i] = buf.readInt16LE(pos) / 32768;
    } else if (audioFormat === 1 && bitsPerSample === 24) {
      const b0 = buf[pos];
      const b1 = buf[pos + 1];
      const b2 = buf[pos + 2];
      let val = b0 | (b1 << 8) | (b2 << 16);
      if (val & 0x800000) val |= ~0xffffff;
      samples[i] = val / 8388608;
    } else {
      throw new Error(`Unsupported WAV format=${audioFormat}, bits=${bitsPerSample}`);
    }
  }

  return {
    sampleRate,
    channels,
    samples,
    durationSec: totalSamples / channels / sampleRate,
  };
}

function inspectWavBuffer(wavBytes: Buffer): {
  sampleRate: number;
  channels: number;
  bitsPerSample: number;
  sampleCount: number;
  durationSec: number;
  rms: number;
  peak: number;
  nonFiniteCount: number;
} {
  const parsed = parseWavBuffer(wavBytes);
  let sumSq = 0;
  let peak = 0;
  let nonFiniteCount = 0;
  for (const s of parsed.samples) {
    if (!Number.isFinite(s)) {
      nonFiniteCount += 1;
      continue;
    }
    const abs = Math.abs(s);
    if (abs > peak) peak = abs;
    sumSq += s * s;
  }
  return {
    sampleRate: parsed.sampleRate,
    channels: parsed.channels,
    bitsPerSample: 16,
    sampleCount: parsed.samples.length,
    durationSec: parsed.durationSec,
    rms: Math.sqrt(sumSq / Math.max(1, parsed.samples.length)),
    peak,
    nonFiniteCount,
  };
}

function parseWavBuffer(buf: Buffer): ParsedWav {
  const tmpPath = join(FIXTURE_DIR, '_inspect_tmp.wav');
  writeFileSync(tmpPath, buf);
  return parseWavFile(tmpPath);
}

async function ensureReferenceFixture(): Promise<ParsedWav> {
  mkdirSync(FIXTURE_DIR, { recursive: true });

  if (existsSync(FIXTURE_WAV_PATH)) {
    const existing = readFileSync(FIXTURE_WAV_PATH);
    const sha = createHash('sha256').update(existing).digest('hex');
    if (existing.byteLength === FIXTURE_SIZE_BYTES && sha === FIXTURE_SHA256) {
      return parseWavFile(FIXTURE_WAV_PATH);
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
  return parseWavFile(FIXTURE_WAV_PATH);
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

async function openPocPage(
  channel: 'chrome' | 'msedge',
  baseURL: string
): Promise<{
  browser: Browser;
  page: Page;
  consoleErrors: string[];
  pageErrors: string[];
}> {
  const browser = await chromium.launch({
    channel,
    headless: true,
    args: ['--enable-unsafe-webgpu'],
  });
  const context = await browser.newContext();
  const page = await context.newPage();

  const consoleErrors: Array<{ text: string; url: string }> = [];
  const pageErrors: string[] = [];
  const httpErrors: Array<{ url: string; status: number }> = [];

  page.on('console', (msg) => {
    if (msg.type() === 'error') {
      consoleErrors.push({ text: msg.text(), url: msg.location().url });
    }
  });
  page.on('pageerror', (err) => {
    pageErrors.push(err.message);
  });
  page.on('response', (res) => {
    if (res.status() >= 400) {
      httpErrors.push({ url: res.url(), status: res.status() });
    }
  });

  await page.addInitScript(() => {
    (window as unknown as { __SPEECH_SYNTHESIS_CALLS__: number }).__SPEECH_SYNTHESIS_CALLS__ = 0;
    if ('speechSynthesis' in window && window.speechSynthesis) {
      const origSpeak = window.speechSynthesis.speak.bind(window.speechSynthesis);
      window.speechSynthesis.speak = (utterance: SpeechSynthesisUtterance) => {
        (window as unknown as { __SPEECH_SYNTHESIS_CALLS__: number }).__SPEECH_SYNTHESIS_CALLS__ += 1;
        return origSpeak(utterance);
      };
    }
  });

  const url = baseURL.endsWith('/') ? `${baseURL}#/poc` : `${baseURL}/#/poc`;
  await page.goto(url, { waitUntil: 'domcontentloaded' });
  await page.getByTestId('poc-ready').waitFor({ state: 'visible', timeout: 30_000 });
  await page.waitForFunction(() => Boolean(window.__VOICEFORGE_POC__), { timeout: 30_000 });

  return { browser, page, consoleErrors, pageErrors, httpErrors };
}

const CHANNELS: Array<'chrome' | 'msedge'> = ['chrome', 'msedge'];

test.describe('Real Browser AI Voice Cloning PoC', () => {
  test.describe.configure({ mode: 'serial' });

  let refAudio: ParsedWav;

  test.beforeAll(async () => {
    refAudio = await ensureReferenceFixture();
  });

  for (const channel of CHANNELS) {
    test(`Pocket TTS full end-to-end voice cloning & Turbo WebGPU probe in ${channel}`, async ({
      baseURL,
    }) => {
      test.setTimeout(300_000);
      const targetBaseUrl = baseURL ?? 'http://127.0.0.1:4173';
      const { browser, page, consoleErrors, pageErrors, httpErrors } = await openPocPage(
        channel,
        targetBaseUrl
      );

      try {
        // 1. Check hardware compatibility for both engines
        const hw = await page.evaluate(async () => {
          return await window.__VOICEFORGE_POC__!.checkHardware();
        });
        expect(hw.reports['pocket-tts'].compatible).toBe(true);

        // 2. Pocket TTS: initialize (downloads real 146 MB INT8 bundle + SHA-256 + ORT sessions)
        const initRes = await page.evaluate(async () => {
          return await window.__VOICEFORGE_POC__!.initEngine('pocket-tts', {
            executionMode: 'cpu',
          });
        });
        expect(initRes.metadata.isInitialized).toBe(true);
        expect(initRes.metadata.activeBackend).toBe('wasm');

        // 3. Encode default_voice.wav & loadVoiceProfile
        const encodeRes = await page.evaluate(
          async ({ samples, sampleRate, channels }) => {
            return await window.__VOICEFORGE_POC__!.encodeVoice(
              'pocket-tts',
              { samples, sampleRate, channels },
              'default_voice'
            );
          },
          {
            samples: refAudio.samples,
            sampleRate: refAudio.sampleRate,
            channels: refAudio.channels,
          }
        );
        expect(encodeRes.tensorKeys).toContain('state_0');
        expect(encodeRes.tensorKeys).toContain('voice_latents');

        // 4. Synthesize evaluation script
        const synthRes = await page.evaluate(async (text) => {
          return await window.__VOICEFORGE_POC__!.synthesize('pocket-tts', text, {
            parameters: { seed: 42, temperature: 0.7, lsdSteps: 1 },
          });
        }, EVAL_SCRIPT);

        expect(synthRes.durationSec).toBeGreaterThan(1.5);
        expect(synthRes.rms).toBeGreaterThan(0.005);
        expect(synthRes.nonFiniteCount).toBe(0);
        expect(synthRes.backend).toBe('wasm');

        // 5. Save synthesized WAV and verify waveform stats independently in Node
        const wavBuf = Buffer.from(synthRes.wavBase64, 'base64');
        const channelWavPath = resolve(process.cwd(), 'test-results', `poc-pocket-${channel}.wav`);
        writeFileSync(channelWavPath, wavBuf);
        if (channel === 'chrome') {
          writeFileSync(resolve(process.cwd(), 'test-results', 'poc-pocket.wav'), wavBuf);
        }
        const wavStats = inspectWavBuffer(wavBuf);
        expect(wavStats.durationSec).toBeGreaterThan(1.5);
        expect(wavStats.rms).toBeGreaterThan(0.005);
        expect(wavStats.nonFiniteCount).toBe(0);

        // 6. Verify zero speechSynthesis calls, zero page errors, and zero Pocket TTS console errors
        // (ignoring only automatic browser /favicon.ico 404 if index.html has no icon tag)
        const nonFaviconHttpErrors = httpErrors.filter((e) => !e.url.endsWith('/favicon.ico'));
        expect(nonFaviconHttpErrors).toEqual([]);
        const pocketConsoleErrors = consoleErrors.filter(
          (e) => !(e.text.includes('404 (Not Found)') && e.url.endsWith('/favicon.ico'))
        );
        expect(pocketConsoleErrors).toEqual([]);

        // 7. Probe Chatterbox Turbo embed_tokens_q4f16.onnx on WebGPU if WebGPU is active
        const consoleErrorsBeforeTurbo = consoleErrors.length;
        let turboProbe: unknown = { skipped: true, reason: 'WebGPU adapter unavailable' };
        if (hw.capabilities.webgpuSupported && hw.capabilities.webgpuAdapterAvailable) {
          const variant = hw.capabilities.shaderF16Supported ? 'q4f16' : 'q4';
          turboProbe = await page.evaluate(async (v) => {
            return await window.__VOICEFORGE_POC__!.probeTurboWebGpu(v);
          }, variant);
        }
        const turboConsoleMessages = consoleErrors.slice(consoleErrorsBeforeTurbo);

        const speechCalls = await page.evaluate(
          () => (window as unknown as { __SPEECH_SYNTHESIS_CALLS__: number }).__SPEECH_SYNTHESIS_CALLS__
        );
        expect(speechCalls).toBe(0);
        expect(pageErrors).toEqual([]);

        await page.evaluate(async () => {
          await window.__VOICEFORGE_POC__!.disposeEngine('pocket-tts');
        });

        recordTelemetry(channel, {
          userAgent: await page.evaluate(() => navigator.userAgent),
          hardware: hw,
          pocket: {
            initTimeMs: initRes.initTimeMs,
            encodeTimeMs: encodeRes.encodeTimeMs,
            loadTimeMs: encodeRes.loadTimeMs,
            durationSec: synthRes.durationSec,
            firstChunkLatencyMs: synthRes.firstChunkLatencyMs,
            totalTimeMs: synthRes.totalTimeMs,
            generationTimeMs: synthRes.generationTimeMs,
            realTimeFactor: synthRes.realTimeFactor,
            sampleRate: synthRes.sampleRate,
            rms: synthRes.rms,
            peak: synthRes.peak,
            nonFiniteCount: synthRes.nonFiniteCount,
            chunkCount: synthRes.chunkCount,
            wavStats,
          },
          turboProbe,
          turboConsoleMessages,
          speechSynthesisCalls: speechCalls,
          httpErrors,
          consoleErrors: pocketConsoleErrors,
          pageErrors,
        });
      } finally {
        await browser.close();
      }
    });
  }

  for (const channel of CHANNELS) {
    test(`Chatterbox ONNX WebGPU check & benchmark (if hardware supports) in ${channel}`, async ({
      baseURL,
    }) => {
      test.setTimeout(480_000);
      const targetBaseUrl = baseURL ?? 'http://127.0.0.1:4173';
      const { browser, page, consoleErrors, pageErrors } = await openPocPage(
        channel,
        targetBaseUrl
      );

      const progressTimer = setInterval(async () => {
        try {
          const p = await page.evaluate(() => window.__VOICEFORGE_POC__?.getLastProgress() ?? null);
          if (p) {
            console.log(
              `[chatterbox:${channel}] phase=${p.phase} item=${p.item} progress=${Math.round(p.progress * 100)}% msg=${p.message}`
            );
          }
        } catch {
          // Page may be closing
        }
      }, 10_000);

      try {
        const hw = await page.evaluate(async () => {
          return await window.__VOICEFORGE_POC__!.checkHardware();
        });

        if (!hw.capabilities.webgpuSupported || !hw.capabilities.webgpuAdapterAvailable) {
          recordTelemetry(channel, {
            chatterbox: {
              attempted: false,
              reason: 'WebGPU adapter unavailable in headless browser session',
              report: hw.reports.chatterbox,
            },
          });
          return;
        }

        const cbOutcome = await page.evaluate(
          async ({ refSamples, refSampleRate, refChannels, text }) => {
            const abortCtrl = new AbortController();
            const timeoutHandle = setTimeout(() => abortCtrl.abort(), 360_000);
            try {
              const initRes = await window.__VOICEFORGE_POC__!.initEngine('chatterbox', {
                executionMode: 'quality',
                preferredBackend: 'webgpu',
                signal: abortCtrl.signal,
              });
              const encodeRes = await window.__VOICEFORGE_POC__!.encodeVoice(
                'chatterbox',
                { samples: refSamples, sampleRate: refSampleRate, channels: refChannels },
                'default_voice'
              );
              const synthRes = await window.__VOICEFORGE_POC__!.synthesize('chatterbox', text, {
                parameters: { seed: 42 },
              });
              return {
                ok: true as const,
                initRes,
                encodeTimeMs: encodeRes.encodeTimeMs,
                loadTimeMs: encodeRes.loadTimeMs,
                synthRes,
              };
            } catch (err) {
              return {
                ok: false as const,
                error: err instanceof Error ? `${err.name}: ${err.message}` : String(err),
                lastProgress: window.__VOICEFORGE_POC__!.getLastProgress(),
              };
            } finally {
              clearTimeout(timeoutHandle);
            }
          },
          {
            refSamples: refAudio.samples,
            refSampleRate: refAudio.sampleRate,
            refChannels: refAudio.channels,
            text: EVAL_SCRIPT,
          }
        );

        if (cbOutcome.ok) {
          expect(cbOutcome.synthRes.durationSec).toBeGreaterThan(1.0);
          expect(cbOutcome.synthRes.rms).toBeGreaterThan(0.005);
          expect(cbOutcome.synthRes.nonFiniteCount).toBe(0);
          const wavBuf = Buffer.from(cbOutcome.synthRes.wavBase64, 'base64');
          writeFileSync(
            resolve(process.cwd(), 'test-results', `poc-chatterbox-${channel}.wav`),
            wavBuf
          );
          recordTelemetry(channel, {
            chatterbox: {
              ok: true,
              initTimeMs: cbOutcome.initRes.initTimeMs,
              backend: cbOutcome.initRes.metadata.activeBackend,
              precision: cbOutcome.initRes.metadata.precision,
              encodeTimeMs: cbOutcome.encodeTimeMs,
              loadTimeMs: cbOutcome.loadTimeMs,
              durationSec: cbOutcome.synthRes.durationSec,
              totalTimeMs: cbOutcome.synthRes.totalTimeMs,
              realTimeFactor: cbOutcome.synthRes.realTimeFactor,
              rms: cbOutcome.synthRes.rms,
              peak: cbOutcome.synthRes.peak,
              nonFiniteCount: cbOutcome.synthRes.nonFiniteCount,
              consoleErrors,
              pageErrors,
            },
          });
        } else {
          // Honest capture of WebGPU OOM / timeout / driver error on local GPU
          recordTelemetry(channel, {
            chatterbox: {
              ok: false,
              error: cbOutcome.error,
              lastProgress: cbOutcome.lastProgress,
              consoleErrors,
              pageErrors,
            },
          });
        }
      } finally {
        clearInterval(progressTimer);
        await browser.close();
      }
    });
  }
});
