# Troubleshooting Guide

Common runtime, storage, download, and browser hardware issues in VoiceForge Studio and how to resolve them.

---

## 1. WebGPU Unavailable or `shader-f16` Missing

### Symptoms
- **Settings** or **Model Manager** reports WebGPU is unavailable, or Chatterbox automatically selects **`q4`** (`1.55 GB`) instead of **`q4f16`** (`1.50 GB`).
- Chatterbox logs a warning: `Chatterbox WASM CPU fallback is ~5.8x slower than real-time; WebGPU is strongly recommended.`

### Why It Happens
- Your browser does not support WebGPU (`navigator.gpu` missing), hardware acceleration is disabled, or your GPU/driver does not expose the WebGPU `shader-f16` feature needed for Chatterbox's `float16` KV cache.
- VoiceForge Studio probes `adapter.features.has('shader-f16')` upfront and switches to `q4` (`float32` KV cache) when `shader-f16` is absent so sessions do not fail on the first inference step.

### Fixes
1. **Use Pocket TTS (`pocket-tts`) as your primary engine:** Pocket TTS (`146 MB`) runs on ONNX Runtime Web WASM SIMD on CPU and requires no WebGPU (`~1.46x–1.57x` RTF on desktop Chrome/Edge).
2. **Enable hardware acceleration in Chrome / Edge:** Check `chrome://gpu` (or `edge://gpu`) and ensure **WebGPU** and **Hardware-accelerated** graphics are enabled and GPU drivers are up to date.
3. **If using Chatterbox without `shader-f16`:** In **Model Manager** (`#/models`), select the **`q4`** precision variant (`1.55 GB`) or import the `q4` bundle downloaded via `node scripts/download-models.mjs --engine chatterbox --precision q4`.
4. **Ensure HTTPS:** WebGPU is unavailable on insecure `http://` origins (except `localhost` / `127.0.0.1`).

---

## 2. Single-Threaded WASM (`crossOriginIsolated: false`, `numThreads: 1`)

### Symptoms
- Hardware diagnostics show `crossOriginIsolated: false` and `recommendedWasmThreads: 1`.

### Why It Happens
- Static hosts such as GitHub Pages do not emit `Cross-Origin-Opener-Policy` (`COOP`) and `Cross-Origin-Embedder-Policy` (`COEP`) headers, which browsers require for `SharedArrayBuffer` multi-threaded WASM.
- This is **normal and expected** for Pocket TTS (`~1.46x–1.57x` RTF and `< 650 ms` first-chunk latency verified on `numThreads = 1`).

### Optional Fix (Self-Hosted cPanel / Apache Only)
If you self-host on Apache/cPanel and want multi-threaded WASM in Chrome/Edge/Firefox:
1. Open your deployed `.htaccess` (from [scripts/cpanel.htaccess](file:///c:/Users/jibra/Desktop/1/cloner/scripts/cpanel.htaccess)).
2. Uncomment the COOP/COEP block:
   ```apache
   Header always set Cross-Origin-Opener-Policy "same-origin"
   Header always set Cross-Origin-Embedder-Policy "credentialless"
   ```
3. **Important:** Keep `credentialless` (not `require-corp`) if fetching weights from Hugging Face (`huggingface.co`), because Hugging Face does not send `Cross-Origin-Resource-Policy` headers. Note that Safari does not support `credentialless`; for Safari users, keep COOP/COEP commented or self-host `./models/` on the same origin.

---

## 3. Chrome / Edge Storage Quota Exceeded

### Symptoms
- Model download or audio caching fails with `QuotaExceededError` or `Not enough storage space`.

### Why It Happens
- Chatterbox ONNX requires ~`1.50 GB` (`q4f16`) or ~`1.55 GB` (`q4`) in `voiceforge-models-v1`, plus IndexedDB storage (`voiceforge-db`) for saved voice profiles and generated project audio chunks.
- Browsers dynamically cap origin storage (`navigator.storage.estimate().quota`) based on free disk space (for example, `10.0 GiB` on a system with ample free space, much less on a nearly full drive or in Incognito/Guest profiles).

### Fixes
1. Free local disk space on the OS drive and avoid **Incognito / InPrivate** mode (which enforces very tight ephemeral storage quotas).
2. Remove unused cached models in **Model Manager** (`#/models` → **Delete Cached Weights**) or old projects in **Projects** (`#/projects`).
3. Prefer **Pocket TTS** (`146.24 MB`) when storage is constrained.

---

## 4. Interrupted 1.5 GB Chatterbox Downloads

### Symptoms
- Downloading `chatterbox` (`1.50 GB`, including `591 MB` `speech_encoder.onnx_data`, `534 MB` `conditional_decoder.onnx_data`, and `305–354 MB` `language_model_*.onnx_data`) stalls or drops with `TypeError: network error` or timeout on slower connections.

### Built-In Resilience & Fixes
1. **Automatic Retry & Resume:** `src/storage/modelCache.ts` automatically skips already-cached, size-matching artifacts in `voiceforge-models-v1` and retries transient HTTP/stream errors up to 3 attempts with exponential backoff. Simply click **Download** again to resume from the remaining files.
2. **Download via CLI + Local Folder Import (Most Reliable):**
   ```bash
   node scripts/download-models.mjs --engine chatterbox --out models
   ```
   Then open **Model Manager** (`#/models`) and click **Import Local Folder** to select `models/`.
3. **Self-Host on Your Own Server:** Upload `models/` to your cPanel/static host and set **Self-Hosted Model Base URL** to `./models/` in **Settings**.

---

## 5. Corrupted Cache or SHA-256 Integrity Failure

### Symptoms
- Model loading or verification fails with `ArtifactIntegrityError` or size/SHA-256 mismatch, or an interrupted older state prevents inference from initializing.

### Fixes
1. Open **Model Manager** (`#/models`) and click **Verify Integrity** on the affected engine card to see which artifact failed.
2. Click **Delete Cached Weights** on that engine card and re-download (or re-import from local folder).
3. If the issue persists across IndexedDB or the Service Worker shell cache:
   - Go to **Settings** (`#/settings`) → **Delete All Local Data** (erases IndexedDB, Cache Storage, OPFS, and preferences).
   - Or in browser DevTools: **Application → Storage → Clear site data**, then hard-reload (`Ctrl+Shift+R`).

---

## 6. iOS / Mobile Memory Limits

### Symptoms
- Tab reloads unexpectedly (`Aw, Snap!` / WebKit process termination), WebGPU is unavailable, or Chatterbox fails during session creation on phones/tablets.

### Why It Happens
- Chatterbox ONNX (`q4f16` / `q4`) estimates **~2,400–2,600 MB** of runtime memory across its 4 ONNX subgraphs and 30-layer KV cache, which exceeds mobile browser (especially iOS Safari) per-tab memory caps.
- Pocket TTS estimates **~550 MB** (`~350–600 MB` steady-state RAM), making it far lighter, though older/low-RAM mobile devices can still hit tab memory limits on long sessions.

### Fixes
1. Use **Pocket TTS (`pocket-tts`)** on mobile and low-RAM devices.
2. Keep reference audio clips concise (**5–10 seconds**) and avoid splitting scripts into oversized chunks.
3. Close background tabs and use **desktop Chrome or Edge** with hardware WebGPU for **Chatterbox ONNX** workloads.

---

## 7. Model Load Fails on Custom `modelBaseUrl`

### Symptoms
- Setting **Self-Hosted Model Base URL** in **Settings** (`#/settings`) causes `404` or `CORS` errors during download.

### Fixes
- Verify your path matches the directory layout you created:
  - `--layout flat` (default in `download-models.mjs`): set `./models/`.
  - `--layout by-engine`: set `./models/{engineId}/`.
- Verify `.htaccess` (or your server) serves `.onnx`, `.onnx_data`, `.bin`, `.npy`, `.model`, and `.json` files without blocking dotfiles/extensionless segments or returning an HTML `404` fallback page.
- If hosting weights on a separate domain/CDN, ensure that server sends `Access-Control-Allow-Origin: *` (or your app origin).
