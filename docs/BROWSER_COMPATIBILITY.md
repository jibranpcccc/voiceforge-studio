# VoiceForge Studio — Browser & Hardware Compatibility Matrix

**Verification Date:** 2026-11-25  
**Production E2E Suite:** [`tests/e2e/voiceforge.e2e.spec.ts`](../tests/e2e/voiceforge.e2e.spec.ts) (`2/2` browsers passed in `5.7m` against `npm run preview -- --port 4173 --host 127.0.0.1`)  
**Engine PoC Telemetry:** [`tests/e2e/inference-poc.spec.ts`](../tests/e2e/inference-poc.spec.ts) ([`docs/benchmarks/benchmark-results.md`](benchmarks/benchmark-results.md))

---

## 1. Compatibility Summary

| Browser | Status | Installed Binary / Captured UA | Pocket TTS (`wasm` INT8) | Chatterbox (`webgpu`) | Offline PWA (SW + Cache Storage + IndexedDB) |
|---|---|---|---|---|---|
| **Google Chrome** (Windows x64) | **VERIFIED PASS (15/15 steps)** | `157.0.8103.79` (`Chrome/159.0.8154.6`) | **PASS** (`173.6 s` full 15-step E2E; `1.46x` RTF in PoC) | Hardware check & `shader-f16` **PASS**; full 1.50 GB E2E unmeasured (see §4) | **PASS** (offline reload + local inference verified) |
| **Microsoft Edge** (Windows x64) | **VERIFIED PASS (15/15 steps)** | `158.0.4370.33` (`Chrome/159.0.8154.6`) | **PASS** (`162.8 s` full 15-step E2E; `1.57x` RTF in PoC) | Hardware check & `shader-f16` **PASS**; full 1.50 GB E2E unmeasured (see §4) | **PASS** (offline reload + local inference verified) |
| **Mozilla Firefox** | **Untested in this environment** | Not tested | Unverified | Unverified | Unverified |
| **Apple Safari (macOS / iOS)** | **Untested in this environment** | Not tested | Unverified | Unverified | Unverified |

> **Honesty & Scope Note:** Only **Google Chrome** and **Microsoft Edge** on Windows x64 were executed and verified in this environment. **Firefox** and **Safari** were **not tested** here and must not be represented as verified until tested on target OS/browser builds.

---

## 2. Verified Test Hardware & Runtime Capabilities

Measured directly via `navigator` / `navigator.gpu` / `navigator.storage` in the Dashboard Hardware Probe (`#/dashboard`) and [`tests/e2e/inference-poc.spec.ts`](../tests/e2e/inference-poc.spec.ts):

| Capability | Measured Value (Chrome & Edge) |
|---|---|
| Operating System | Windows x64 (`Windows NT 10.0; Win64; x64`) |
| WebGPU (`navigator.gpu`) | Supported (`webgpuAdapterAvailable: true`) |
| WebGPU Adapter | `vendor: "intel"`, `architecture: "gen-12lp"` (**Intel Iris Xe**, `isFallbackAdapter: false`) |
| WebGPU `shader-f16` | **Supported** (`true`) |
| WebGPU `maxBufferSize` | `2.00 GB` (`2,147,483,648` bytes) |
| WebAssembly + SIMD128 | `wasmSupported: true`, `wasmSimdSupported: true` |
| `crossOriginIsolated` / `SharedArrayBuffer` | `false` / `false` (`numThreads = 1` single-threaded WASM) |
| CPU Cores & Device RAM | `16` logical cores (`hardwareConcurrency: 16`), `32 GB` device memory |
| Origin Storage Quota | `10.00 GB` (`10,737,418,240` bytes) |
| Service Worker (`public/sw.js`) | Active (`voiceforge-shell-v1` + `voiceforge-models-v1`) |

---

## 3. Production UI 15-Step E2E Verification Results

Executed against the production Vite build (`dist/`) served via `npm run preview -- --port 4173 --host 127.0.0.1` in fresh ephemeral browser contexts (retaining IndexedDB, Cache Storage, and Service Worker state across reloads and offline transitions within each browser run):

| E2E Step | Verified Behavior | Chrome (`ms`) | Edge (`ms`) |
|---|---|---:|---:|
| **1. Initial Load** | `#/` -> `#/dashboard`, hardware probe visible, 0 console/page errors | `697` | `2,304` |
| **2. Model Download** | `#/models` -> Pocket TTS (`146.24 MB`, 8 files) live progress + SHA-256 -> `Offline Ready (100% Verified)` | `31,092` | `18,097` |
| **3. Reference Upload** | `#/clone` -> upload MIT `default_voice.wav` (`714,320` B) | `3,360` | `3,612` |
| **4. Quality + Encode** | Inspect quality metrics (`SNR`, clipping, active speech), confirm self-attestation + basis, encode & save voice | `10,853` | `12,691` |
| **5. Studio Synthesis** | `#/studio` -> select saved voice, synthesize script 1 (`4.72 s` @ `24,000 Hz`) | `15,034` | `16,184` |
| **6. Waveform Playback** | Click Play on `WaveformPlayer`, verify `AudioContext` / `AudioBufferSourceNode.start` triggers cleanly (`0` errors) | `690` | `614` |
| **7. WAV Export** | Export `wav16`: valid `RIFF`/`WAVE`, `24,000 Hz`, `226,560` PCM data bytes (`4.72 s`), RMS `0.160`, 0 NaNs | `434` | `591` |
| **8. MP3 Export** | Export `mp3_128`: valid `ID3` header + `0xFF 0xF3` frame sync at offset `150`, `76,566` bytes | `594` | `796` |
| **9. Page Reload** | `page.reload()` on `#/studio` | `337` | `466` |
| **10. Persistence Audit** | Verify saved voice profile persisted in `#/voices` and `#/studio` via IndexedDB | `1,549` | `1,808` |
| **11. Second Script** | Synthesize second distinct script with persisted voice profile | `24,448` | `19,713` |
| **12. True Offline Mode** | `context.setOffline(true)` -> reload `#/studio` from SW cache -> synthesize script 3 offline | `23,626` | `18,267` |
| **13. Cancel & Recovery** | 4-paragraph job -> Cancel after `>= 1` chunk -> reload -> `#/projects` (`Interrupted job`) -> `Resume in Studio` -> `Resume Queue` -> `4/4 chunks (100%)` | `59,740` | `65,935` |
| **14. Order & ZIP/WAV** | Verify 4 chunks in exact paragraph order (`0` skipped text, all durations `> 0`), merged WAV (`21.52 s` Chrome / `20.64 s` Edge, `24 kHz`), Multi-Segment ZIP (`001`–`004` WAVs + `subtitles.srt` + `manifest.json`) | `1,036` | `1,572` |
| **15. Privacy & Errors** | Audit all captured requests (`105` Chrome / `167` Edge): only `127.0.0.1:4173`, `huggingface.co` / `us.aws.cdn.hf.co` model `GET`s (plus internal `edge://` download-hub UI in Edge); `0` uploads, `0` `speechSynthesis` calls, `0` console/page errors | `74` | `129` |
| **Total Elapsed** | **All 15 steps PASS** | **`173,565 ms` (`2.9 m`)** | **`162,780 ms` (`2.8 m`)** |

---

## 4. WASM Single-Threaded vs. WebGPU Observations

### 4.1 Single-Threaded WASM SIMD (`crossOriginIsolated: false`)
- Standard static hosts (GitHub Pages, Vite preview, default Apache/cPanel without COOP/COEP) do **not** enable `crossOriginIsolated` (`SharedArrayBuffer` unavailable).
- `PocketTtsEngine` (`src/workers/pocket.worker.ts`) automatically guards `ort.env.wasm.numThreads = 1` with `ort.env.wasm.simd = true` when `crossOriginIsolated === false`.
- **Observed behavior on Intel Iris Xe laptop (16 CPU cores):**
  - `pocket-tts` executes smoothly in single-threaded WASM SIMD without `SharedArrayBuffer` or COOP/COEP headers: PoC measured `586.7 ms` (Chrome) / `643.6 ms` (Edge) first-chunk latency and `1.46x` (Chrome) / `1.57x` (Edge) real-time factor for a `4.24 s` utterance.
  - Even with single-threaded WASM, all 15 UI steps including voice encoding, streaming playback, offline reloads, and 4-paragraph cancel/resume completed in under 3 minutes per browser.
- **Optional Multi-Threaded WASM:** Enabling `Cross-Origin-Opener-Policy: same-origin` and `Cross-Origin-Embedder-Policy: credentialless` (see [`scripts/cpanel.htaccess`](../scripts/cpanel.htaccess) and [`docs/CPANEL_DEPLOYMENT.md`](CPANEL_DEPLOYMENT.md)) allows `numThreads` up to `min(hardwareConcurrency, 4)` (`4` on this 16-core machine) while keeping cross-origin Hugging Face downloads working via `credentialless`.

### 4.2 WebGPU & `shader-f16` on Intel Iris Xe (`gen-12lp`)
- Both Chrome and Edge exposed a hardware-backed WebGPU adapter (`vendor: "intel"`, `architecture: "gen-12lp"`, `isFallbackAdapter: false`) with `shader-f16` enabled and `2.00 GB` `maxBufferSize`.
- **Verified WebGPU Execution (`onnxruntime-web@1.31.1`):**
  - The Chatterbox Turbo `embed_tokens_q4f16.onnx` (`33.65 MB`) WebGPU probe passed in both browsers on Intel Iris Xe (`70.8 ms` forward pass in Chrome, `306.1 ms` in Edge, `0` non-finite elements, matching `[1, 4, 1024]` output RMS `0.4617`).
  - `ChatterboxEngine` (`onnx-community/chatterbox-ONNX`) passed hardware compatibility checks (`recommendedBackend: 'webgpu'`, `recommendedExecutionMode: 'quality'`).
- **Large-Bundle (`1.50 GB`) Observations:**
  - In earlier PoC cold-cache runs ([`docs/benchmarks/benchmark-results.md`](benchmarks/benchmark-results.md)), downloading the `1.50 GB` `q4f16` Chatterbox bundle from Hugging Face CDN exceeded the `360 s` PoC timeout in Chrome (`96.98%` downloaded) and hit a transient CDN stream drop in Edge (`27.97%`), after which `src/storage/modelCache.ts` was updated with per-artifact resumption and 3-attempt exponential backoff retries.
  - Because `1.50 GB` cold download + 4-session WebGPU shader compilation was not run to completion inside the automated E2E budget, full `chatterbox` synthesis latency on Intel Iris Xe remains **unmeasured** in automated CI (`pocket-tts` is the verified default engine).
- **Fallback Behavior:** If a browser lacks `shader-f16`, `ChatterboxEngine` selects `q4` (`1.55 GB`, `float32` KV cache) instead of `q4f16`; if WebGPU is unavailable entirely, `ChatterboxEngine` falls back to WASM `q4` (expected `~5.8x` slower than real-time per VoxShot benchmarks), whereas `pocket-tts` remains fast on WASM SIMD everywhere.

### 4.3 Edge-Specific Observation (Browser-Internal `edge://` Downloads UI)
- During Playwright file download assertions (Steps 7, 8, and 14), Microsoft Edge automatically opened internal `edge://downloads-hub/`, `edge://resources/`, and `edge://fileicon/` browser UI requests (`62` internal requests total). These are local Chromium/Edge WebUI resources rather than external network traffic; zero non-local `http://` or `https://` requests outside `127.0.0.1:4173` and pinned Hugging Face model download endpoints occurred.

---

## 5. Untested Browsers (Explicitly Unverified)

### 5.1 Mozilla Firefox — *Untested in this environment*
- **Status:** Not executed or verified in this environment.
- **Architectural Notes (Unverified):** VoiceForge Studio uses standard Web APIs (`WebAssembly`, `AudioContext`, `IndexedDB`, `Cache Storage` / `OPFS`, `ServiceWorker`, and optional `navigator.gpu` WebGPU). Firefox desktop WebGPU support and multi-hundred-megabyte `onnxruntime-web` WASM/WebGPU session behavior vary by OS and Firefox release channel and must be tested directly before claiming Firefox compatibility.

### 5.2 Apple Safari (macOS & iOS) — *Untested in this environment*
- **Status:** Not executed or verified in this environment.
- **Architectural Notes (Unverified):** Safari WebGPU availability, `Cache Storage` / IndexedDB eviction policies on iOS/iPadOS, and mobile Safari tab memory limits (particularly for the `1.50 GB` Chatterbox bundle or `~550 MB` Pocket TTS worker runtime) were not tested in this Windows x64 environment and remain unverified.
