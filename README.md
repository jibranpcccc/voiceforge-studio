# VoiceForge Studio

**VoiceForge Studio** is a 100% client-side AI voice cloning and long-form narration studio that runs directly in your browser using WebAssembly (WASM SIMD) and WebGPU via [ONNX Runtime Web](https://onnxruntime.ai/). No backend server, no API keys, and no cloud uploads are required—reference audio, speaker conditioning embeddings, scripts, and exported audio never leave your device.

**Live GitHub Pages App:** <https://jibranpcccc.github.io/voiceforge-studio/>

---

## Architecture & Core Capabilities

- **Zero-Backend Static SPA:** Built with React 19, TypeScript, Zustand, Vite, and Tailwind CSS. All ONNX Runtime Web `.wasm` and `.mjs` runtime files are bundled under `public/runtime/` (zero external runtime CDNs).
- **Dual Client-Side Inference Engines:**
  - **Pocket TTS (`pocket-tts`, Default Engine):** `KevinAHM/pocket-tts-onnx` (`english_2026-04` INT8, pinned commit `58a6d00cf13d239b6748cb0769f35c580a8f606c`, `146,243,590 B` / `146.24 MB` across 8 files). Runs via ONNX Runtime Web WASM SIMD inside a dedicated Web Worker (`src/workers/pocket.worker.ts`)—automatically unlocking **multi-threaded WASM (`numThreads = 4`)** via `public/sw.js` COOP/COEP headers, plus a **parallel Web Worker pool** (`Auto` / `1`–`4` workers) and **live ordered audio streaming** (`OrderedStreamAudioPlayer`) for multi-paragraph scripts. Supports true zero-shot voice cloning via `mimi_encoder_int8.onnx`.
  - **Chatterbox ONNX (`chatterbox`, Optional WebGPU Engine):** `onnx-community/chatterbox-ONNX` (pinned commit `3cab09af388d3f02bba43443fce88c1f4525ac43`, `1,499,431,645 B` / `1.50 GB` in `q4f16` across 13 files; `1,548,314,008 B` / `1.55 GB` in `q4`). Runs in a dedicated Web Worker (`src/workers/chatterbox.worker.ts`) with pre-flight WebGPU `shader-f16` probing, emotion `exaggeration` control, and automatic `q4` fallback when `shader-f16` is unavailable.
- **Studio Workspace Views:**
  - **Dashboard** (`#/dashboard`) — Hardware capabilities summary, quick actions, and offline model readiness.
  - **Voice Cloning** (`#/clone`) — Upload or record 5–10 s (up to 30 s) reference audio, inspect audio quality/RMS/clipping, confirm authorized use, and encode a local speaker conditioning profile scoped by `engineId` and `modelRevision`.
  - **Narration Studio** (`#/studio`) — Long-form script splitting into synthesis chunks, per-chunk regeneration, pause controls, pronunciation dictionary rules, WSOLA time-stretch speed control, mastering presets, and **WAV (16-bit / 24-bit PCM)**, **MP3 (128–320 kbps via `@breezystack/lamejs`)**, **SRT subtitle**, and **ZIP (`fflate`)** batch export.
  - **My Voices** (`#/voices`) & **Projects** (`#/projects`) — Manage saved voice profiles and multi-segment narration projects in IndexedDB (`voiceforge-db`).
  - **Audio Lab** (`#/lab`) — Side-by-side parameter testing and waveform inspection.
  - **Model Manager** (`#/models`) — Download pinned Hugging Face weights or self-hosted mirrors, verify exact `sizeBytes` + SHA-256 checksums, import a local folder bundle offline, or switch Chatterbox precision (`q4f16` / `q4`).
  - **Settings** (`#/settings`) — Execution mode (`quality`, `balanced`, `cpu`), theme (`dark` / `light`), default export format/sample rate, `Self-Hosted Model Base URL` (`./models/` or `./models/{engineId}/`), and full local data wipe.
- **Offline PWA Shell & COOP/COEP Isolation (`public/sw.js`):** Precaches the app shell, hashed Vite bundles, `model-manifests/models.json`, and local `runtime/ort-wasm*` binaries in `voiceforge-shell-v2` with `Cross-Origin-Opener-Policy: same-origin` + `Cross-Origin-Embedder-Policy: credentialless` headers (unlocking `SharedArrayBuffer` / multi-threaded WASM on GitHub Pages without blocking Hugging Face downloads), while storing verified AI model weights separately in `voiceforge-models-v1` (Cache Storage with OPFS fallback).

---

## Local Development

### Prerequisites

- **Node.js 22+** and **npm**
- Modern desktop browser (Google Chrome or Microsoft Edge recommended; WebGPU required for fast Chatterbox synthesis)

### Commands

```bash
# Install dependencies (automatically runs postinstall -> scripts/copy-ort-runtime.mjs)
npm install

# Start Vite development server
npm run dev

# Static checks & unit tests
npm run lint
npm run typecheck
npm test

# End-to-end Playwright tests (requires Chromium/Chrome/Edge)
npm run test:e2e

# Production build for GitHub Pages subpath
VITE_BASE_PATH=/voiceforge-studio/ npm run build

# Build & package static cPanel bundle -> dist-cpanel/ & release/voiceforge-studio-cpanel.zip
node scripts/build-cpanel.mjs
```

---

## Self-Hosting (cPanel / Static Hosting)

VoiceForge Studio builds to pure static files (`VITE_BASE_PATH=./`) with **zero SSH, Node.js, Python, or database requirements** on the host server.

1. Run `node scripts/build-cpanel.mjs` to generate `release/voiceforge-studio-cpanel.zip` (includes `dist-cpanel/.htaccess` from [scripts/cpanel.htaccess](file:///c:/Users/jibra/Desktop/1/cloner/scripts/cpanel.htaccess)).
2. Extract `release/voiceforge-studio-cpanel.zip` into your web root or subfolder (e.g., `public_html/voiceforge/`) over **HTTPS**.
3. Optionally mirror model weights on your own server with `node scripts/download-models.mjs --engine pocket-tts --out models`, upload `models/` beside `index.html`, and set **Self-Hosted Model Base URL** to `./models/` in **Settings**.

See the full guides:
- [docs/CPANEL_DEPLOYMENT.md](file:///c:/Users/jibra/Desktop/1/cloner/docs/CPANEL_DEPLOYMENT.md)
- [docs/SELF_HOSTED_MODELS.md](file:///c:/Users/jibra/Desktop/1/cloner/docs/SELF_HOSTED_MODELS.md)
- [docs/TROUBLESHOOTING.md](file:///c:/Users/jibra/Desktop/1/cloner/docs/TROUBLESHOOTING.md)

---

## Verified Benchmark Summary

Measured in Playwright against `http://127.0.0.1:4173/#/poc` on Windows x64 (`Intel gen-12lp` / Iris Xe, `shader-f16: true`, `webgpuMaxBufferSize: 2.0 GiB`, `crossOriginIsolated: false`, `numThreads: 1`, 16 CPU cores, 32 GB RAM) using prompt `"Hello from VoiceForge Studio. This is a real local browser voice cloning test."` (`seed: 42`, reference `default_voice.wav`). See [MODEL_RESEARCH.md](file:///c:/Users/jibra/Desktop/1/cloner/MODEL_RESEARCH.md) and [docs/benchmarks/benchmark-results.md](file:///c:/Users/jibra/Desktop/1/cloner/docs/benchmarks/benchmark-results.md) for full details.

### Pocket TTS (`pocket-tts`, 146 MB INT8 WASM) — Full E2E Pass

| Metric | Google Chrome (`chrome`) | Microsoft Edge (`msedge`) |
|---|---|---|
| Status | **PASS** | **PASS** |
| Cold Init (146 MB download + SHA-256 + 5 ORT sessions) | `28,826.6 ms` (`28.8 s`) | `16,152.6 ms` (`16.2 s`) |
| Voice Conditioning Encode (`encodeVoice`) | `6,271.7 ms` (`6.3 s`) | `3,955.3 ms` (`4.0 s`) |
| Cached Voice Profile Load (`loadVoiceProfile`) | `21.8 ms` | `21.7 ms` |
| First-Chunk Latency (TTFB) | `586.7 ms` | `643.6 ms` |
| Total Synthesis Time (`4.24 s` @ `24,000 Hz`) | `6,210.6 ms` (`6.21 s`) | `6,652.3 ms` (`6.65 s`) |
| Real-Time Factor (`gen / audio`) | `1.46x` (`1.464`) | `1.57x` (`1.568`) |
| Waveform RMS / Peak | `0.1845` / `0.9707` | `0.1845` / `0.9707` |
| Non-Finite Samples / Browser Errors / `speechSynthesis` Calls | `0` / `0` / `0` | `0` / `0` / `0` |

### Chatterbox ONNX (`chatterbox`, `q4f16`, 1.50 GB) & Turbo Probe

- **Chatterbox ONNX Hardware Check:** Passed in both Chrome and Edge (`compatible: true`, `recommendedBackend: 'webgpu'`, `recommendedExecutionMode: 'quality'`, `shaderF16Supported: true`, `maxBufferSize: 2.0 GiB`).
- **Chatterbox Cold-Cache Download Telemetry:** In ephemeral `360,000 ms` Playwright runs, Chrome downloaded and SHA-256-verified `1,454,179,627 / 1,499,431,645 B` (`96.98%`) before hitting the 360 s abort budget, and Edge downloaded `419,361,429 B` (`27.97%`) before a transient Hugging Face CDN stream drop (`src/storage/modelCache.ts` subsequently added per-artifact skip-if-cached resume + 3-attempt exponential-backoff retry). Full 4-session WebGPU shader compilation and inference latency for `chatterbox` were not reached in that automated 360 s run (`N/A`).
- **Chatterbox Turbo Probe (`ResembleAI/chatterbox-turbo-ONNX`, `embed_tokens_q4f16.onnx`):** Verified `com.microsoft:GatherBlockQuantized` runs on `onnxruntime-web@1.31.1` WebGPU EP in Chrome (`70.8 ms` inference) and Edge (`306.1 ms` inference), but Turbo remains documented-only due to higher measured WER (`7.95%` vs `4.5%`) and zero WASM fallback.

---

## Privacy, Synthetic-Audio Notice & Licenses

- **Privacy:** Zero telemetry, zero analytics, zero server-side processing. See [PRIVACY.md](file:///c:/Users/jibra/Desktop/1/cloner/PRIVACY.md) and [SECURITY.md](file:///c:/Users/jibra/Desktop/1/cloner/SECURITY.md).
- **Synthetic Audio & Authorized Use:** VoiceForge Studio displays a synthetic-audio disclosure badge and stores a local `AuthorizedUseConfirmation` per voice profile. Because there are no user accounts or servers, that confirmation is **client-self-attested only and is not independently verified consent**. You are solely responsible for obtaining explicit permission before cloning any voice and complying with applicable laws.
- **Licenses (see [MODEL_LICENSES.md](file:///c:/Users/jibra/Desktop/1/cloner/MODEL_LICENSES.md)):**
  - Application source code: **MIT** ([LICENSE](file:///c:/Users/jibra/Desktop/1/cloner/LICENSE))
  - Pocket TTS weights (`KevinAHM/pocket-tts-onnx`): **CC-BY-4.0** + **Kyutai Prohibited Use Notice** (export wrappers **Apache-2.0**, upstream `kyutai-labs/pocket-tts` **MIT**)
  - Chatterbox ONNX weights (`onnx-community/chatterbox-ONNX`): **MIT**
  - Client-side MP3 encoder (`@breezystack/lamejs`): **LGPL-3.0**

---

## Known Limitations

- **Multi-threaded WASM via Service Worker:** Static hosts without server-level COOP/COEP headers upgrade to `crossOriginIsolated = true` (`numThreads = 4`) on first Service Worker activation (`voiceforge-shell-v2`), improving single-chunk Pocket TTS speed (`11.12 s` -> `6.43 s` / `528 ms` first-chunk TTFB) alongside the parallel worker pool for long scripts. On browsers blocking Service Workers, Pocket TTS falls back cleanly to single-threaded WASM (`numThreads = 1`).
- **Chatterbox `1.50 GB` download & hardware requirements:** Chatterbox (`q4f16` / `q4`) requires substantial browser storage quota and ~`2.4 GB` estimated memory (`q4f16` requires WebGPU `shader-f16`). Its WASM CPU fallback runs `~5.8x` slower than real-time.
- **Mobile / iOS memory limits:** Mobile browsers—especially iOS Safari—impose strict per-tab RAM limits; Pocket TTS (`~350–600 MB` steady-state RAM) is strongly preferred over Chatterbox on constrained devices.
- **English-focused default models:** Both integrated engines target English (`en`).

---

## Updating & Redeploying

- **GitHub Pages:** Pushing to `main` (or manually triggering **Actions → Deploy VoiceForge Studio to GitHub Pages**) runs `npm run lint`, `npm run typecheck`, `npm test`, `VITE_BASE_PATH=/voiceforge-studio/ npm run build`, and deploys `dist/` via `.github/workflows/deploy.yml`.
- **cPanel / Self-Hosted:**
  1. Pull the latest changes and run `npm ci && node scripts/build-cpanel.mjs`.
  2. Upload and extract the new `release/voiceforge-studio-cpanel.zip` into your target directory (overwrite `index.html`, `sw.js`, `manifest.webmanifest`, `assets/`, `runtime/`, `model-manifests/`, and `.htaccess`; keep your existing `models/` folder intact unless `public/model-manifests/models.json` changed).
  3. Hard-reload the page (`Ctrl+Shift+R` / `Cmd+Shift+R`) so the updated Service Worker activates and refreshes `voiceforge-shell-v1`.
