# VoiceForge Studio — Browser AI Voice Cloning Model Research & Benchmarks

**Date:** 2026-11-25  
**Scope:** Synthesis of verified Hugging Face / GitHub repository audits, ONNX subgraph inspections, VoxShot engineering lessons, and real-browser Chrome & Edge PoC benchmarks for 100% client-side zero-shot voice cloning.

Detailed primary research logs and raw benchmark tables live in:
- [docs/research/pocket-tts.md](file:///c:/Users/jibra/Desktop/1/cloner/docs/research/pocket-tts.md)
- [docs/research/chatterbox-and-others.md](file:///c:/Users/jibra/Desktop/1/cloner/docs/research/chatterbox-and-others.md)
- [docs/benchmarks/benchmark-results.md](file:///c:/Users/jibra/Desktop/1/cloner/docs/benchmarks/benchmark-results.md)

---

## 1. Engine Comparison Summary & Verdicts

| Engine Slot | Model / Export | Pinned Revision | License | Ungated | Browser Download Size | Verdict |
|---|---|---|---|---|---|---|
| **Engine C (Default)** | **Pocket TTS** (`KevinAHM/pocket-tts-onnx`, `english_2026-04` INT8) | `58a6d00cf13d239b6748cb0769f35c580a8f606c` | `CC-BY-4.0` + Kyutai Prohibited Use Notice (`Apache-2.0` export wrappers; `MIT` upstream) | Yes | **146,243,590 B** (`146.24 MB` / 8 files) | **GO — Default Primary Engine** |
| **Engine A (Optional)** | **Chatterbox ONNX** (`onnx-community/chatterbox-ONNX`, `q4f16` / `q4`) | `3cab09af388d3f02bba43443fce88c1f4525ac43` | `MIT` | Yes | **1,499,431,645 B** (`1.50 GB`, `q4f16`) / **1,548,314,008 B** (`1.55 GB`, `q4`) | **GO — Optional WebGPU High-Expressiveness Engine** |
| **Engine B (Probed)** | **Chatterbox Turbo ONNX** (`ResembleAI/chatterbox-turbo-ONNX`) | `d21799bd0354adb85e348b8a0442a8405110a2cf` | `MIT` | Yes | **565,370,537 B** (`565.4 MB`, `q4f16`) / **724,921,295 B** (`724.9 MB`, `q4`) | **DOCUMENTED ONLY (Not Enabled by Default)** |
| **Engine D** | **Qwen3-TTS** (`QwenLM/Qwen3-TTS` & community ONNX exports) | `022e286b98fbec7e1e916cb940cdf532cd9f488e` | `Apache-2.0` | Yes | `3.38 GB` (`wavekat` Base INT4) / `690 MB` (`danyalmalik` CustomVoice, no cloning) | **NO-GO (for Browser Voice Cloning)** |
| **Watched Candidate** | **MOSS-TTS-Nano-100M-ONNX** + **MOSS-Audio-Tokenizer-Nano-ONNX** (`OpenMOSS-Team`) | `f52645cb467506d8e18e746ddd59482685b74e58` / `ceff0d0749bfb3fa2d61149794ec6feef0d1e1ae` | `Apache-2.0` | Yes | `763.2 MB` combined (`~222 MB` w/ community Q4 TTS) | **WATCH / EXPERIMENTAL CANDIDATE** |

---

## 2. Detailed Engine Findings

### 2.1 Engine C: Pocket TTS (`KevinAHM/pocket-tts-onnx`) — Default Engine

- **Architecture & Subgraphs (`onnx/english_2026-04`):**
  1. `mimi_encoder_int8.onnx` (`20,779,616` B): Encodes 24 kHz mono reference audio into `latents [1, T_v, 1024]` (~12.5 frames/sec), enabling true zero-shot voice cloning in the browser without gated Hugging Face tokens (`kyutai/pocket-tts` is gated HTTP 401; `KevinAHM/pocket-tts-onnx` is ungated).
  2. `text_conditioner.onnx` (`16,388,344` B, kept in FP32 because it is a pure `Gather` table and is 40 B smaller than its INT8-tagged copy): Token embedding lookup (`[4000, 1024]`).
  3. `flow_lm_main_int8.onnx` (`76,341,079` B): 6-layer autoregressive FlowLM transformer with 18 stateful KV-cache tensors (`state_0..state_17`).
  4. `flow_lm_flow_int8.onnx` (`9,962,530` B): Flow-matching velocity MLP head (`lsd_steps = 1`).
  5. `mimi_decoder_int8.onnx` (`22,684,077` B): Stateful streaming neural codec decoder (56 state tensors, outputting `24,000 Hz` mono Float32 PCM at `1920` samples per `80 ms` frame).
  6. Common bundle files: `bos_before_voice.npy` (`4,224` B), `bundle.json` (`24,381` B), `tokenizer.model` (`59,339` B SentencePiece Unigram, 4,000 tokens).
- **Audio & Preprocessing:** Outputs `24,000 Hz` mono PCM. Upstream `end_on_pause` preprocessing (trailing silence trim `>35 dB` below loudest 20 ms RMS frame, 20 ms fade-out, 80 ms trailing zero silence) prevents cut-off word bursts at generation start. Recommended reference duration is 5–10 s (hard cap 30 s).
- **Runtime & COOP/COEP:** Runs cleanly on ONNX Runtime Web **WASM SIMD** (`numThreads = 1` when `crossOriginIsolated === false`, e.g. static GitHub Pages / cPanel hosting). WebGPU is not used for Pocket TTS INT8 graphs because `DynamicQuantizeLinear` / `MatMulInteger` target CPU MLAS kernels and batch=1 autoregressive decoding transfers 18 + 56 state tensors every step. Estimated steady-state tab RAM is ~350–600 MB.

### 2.2 Engine A: Chatterbox ONNX (`onnx-community/chatterbox-ONNX`) — Optional WebGPU Engine

- **Architecture & Subgraphs:**
  - `speech_encoder.onnx` + `.onnx_data` (`592,459,488` B, `fp32`): Extracts 1024-d `audio_features`, `audio_tokens`, 192-d `speaker_embeddings`, and `speaker_features`.
  - `embed_tokens.onnx` + `.onnx_data` (`61,653,990` B, `fp32`): Supports emotion `exaggeration` control (`[1]` float32) and `position_ids`.
  - `language_model_q4f16.onnx` + `.onnx_data` (`304,966,796` B) or `language_model_q4.onnx` + `.onnx_data` (`353,849,159` B): 30-layer Llama-3 KV-cache decoder (`60` KV tensors) using `com.microsoft:MatMulNBits` and `com.microsoft:GroupQueryAttention` with **zero** `GatherBlockQuantized` ops.
  - `conditional_decoder.onnx` + `.onnx_data` (`540,321,264` B, `fp32`): 10-step flow matching + HiFT-GAN vocoder outputting `24,000 Hz` mono PCM.
- **Quantization & Constraints:**
  - `q4f16` (`1,499,431,645` B / `1.50 GB`, 13 files) requires WebGPU `shader-f16` (used for `float16` KV cache).
  - `q4` (`1,548,314,008` B / `1.55 GB`) is the required fallback when `shader-f16` is unavailable; CPU/WASM fallback works structurally for `q4` but runs ~5.8x slower than real-time.
  - `fp32` (`3.28 GB`, `2.08 GB` `language_model.onnx_data`) is **blocked** in browser WASM by Chrome's ~2.145 GB `ArrayBuffer` limit and WASM32 4 GB ceiling.
  - No `q8` (`_quantized`) language model exists in the repo.

### 2.3 Engine B: Chatterbox Turbo ONNX (`ResembleAI/chatterbox-turbo-ONNX`) — Probed & Documented

- **Architecture & Footprint:** 350M GPT2-medium 24-layer backbone (`GPT2LMHeadModel`), GPT-2 BPE tokenizer (`3.56 MB`), and 1-step MeanFlow decoder (`122` `MultiHeadAttention` ops vs `4,585` `MatMul`s in original Chatterbox). Total download is much smaller (`565.4 MB` in `q4f16`, `724.9 MB` in `q4`, `1.12 GB` in `q8`). Omits `exaggeration` control.
- **Verified Chrome & Edge WebGPU `GatherBlockQuantized` Probe (`onnxruntime-web@1.31.1`):**
  - Every quantized subgraph in `ResembleAI/chatterbox-turbo-ONNX` (`q4f16`, `q4`, and `_quantized`) emits `com.microsoft:GatherBlockQuantized`.
  - We directly probed `onnx/embed_tokens_q4f16.onnx` + `.onnx_data` (`33.65 MB`, `input_ids = int64[1, 4]`) on Intel Iris Xe (`gen-12lp`, `shader-f16: true`) in both Chrome and Edge:
    - **Chrome:** Download + SHA-256 `1,891.6 ms`, WebGPU session create `1,003.2 ms`, inference `70.8 ms`, output `[1, 4, 1024]`, `0` non-finite elements (RMS `0.4617`, peak `2.2891`).
    - **Edge:** Download + SHA-256 `2,230.4 ms`, WebGPU session create `1,775.0 ms`, inference `306.1 ms`, output `[1, 4, 1024]`, `0` non-finite elements (RMS `0.4617`, peak `2.2891`).
- **Why Engine B Remains Documented Rather Than Enabled by Default:**
  1. **Higher Word Error Rate (WER):** Community benchmarks (`danyalmalik`, Whisper `small.en` across 8 sentences) measured **7.95% WER** on Turbo `q4` vs **4.5% WER** on original Chatterbox `q4`, alongside upstream Hugging Face reports of paralinguistic tag (`[laugh]`, `[chuckle]`) failures/artifacts in ONNX (#9) and runtime instability (#6, #7).
  2. **Zero WASM Fallback:** Because even `_quantized` (`q8`) subgraphs emit `com.microsoft:GatherBlockQuantized`, which ONNX Runtime Web's WASM EP does not implement, Turbo cannot run on CPU-only devices or fallback cleanly when WebGPU is unavailable.
  3. **Divergent Input Signatures:** Requires `position_ids` on `language_model`, omits `exaggeration` on `embed_tokens`, uses a 3.56 MB GPT-2 BPE tokenizer, and breaks Transformers.js out-of-the-box config resolution.

### 2.4 VoxShot (`m96-chan/voxshot`) Engineering Learnings

Auditing `m96-chan/voxshot` (`MIT`, `v0.3.0` @ `b6abd46a724b381fb787aac534d3f59936644d7b`) surfaced critical browser WebGPU lessons incorporated into VoiceForge Studio's `ChatterboxEngine`:
1. **Pre-flight `shader-f16` probe:** Adapters lacking `shader-f16` load `q4f16` sessions without throwing and fail on the first inference step. VoiceForge probes `adapter.features.has('shader-f16')` upfront and selects `q4` when absent.
2. **Explicit GPU tensor `.dispose()`:** JavaScript GC is blind to GPU VRAM pressure; VoiceForge immediately copies `Float32Array` results and disposes GPU tensors on every step.
3. **300,000 ms compilation stall tolerance:** ONNX WebGPU shader compilation can block silently for 35 s to >2 min; inference and session compilation run in a dedicated Web Worker with a `300_000 ms` timeout.
4. **Dynamic token budget cap:** Capping generated speech tokens (~2.4 tokens/char + 20, max `1024` tokens) prevents 30-layer KV-cache memory blowup.
5. **WASM `q4` latency reality:** VoxShot measured WASM `q4` at `2.52 s` audio in `14.7 s` (`~5.8x` slower than real-time), validating our WebGPU recommendation for Chatterbox.

### 2.5 Engine D: Qwen3-TTS — Exact NO-GO Blockers

All five audited community ONNX exports of `QwenLM/Qwen3-TTS` (`Apache-2.0`) fail browser zero-shot voice cloning requirements today:
- **`wavekat/Qwen3-TTS-0.6B-Base-ONNX` (`3.38 GB` INT4 deduplicated / `6.09 GB` FP32):** Ships `embeddings/text_embedding.npy` as a `1.245 GB` uncompressed float32 array (no ONNX `Gather` graph), leaves `vocoder.onnx` unquantized at `915.4 MB`, fixes `tokenizer_encoder.onnx` to `[1, 240000]` (`192.9 MB`), and requires Python `librosa` 128-bin mel extraction + reference transcript.
- **`danyalmalik/Qwen3-TTS-12Hz-0.6B-CustomVoice-ONNX-WebGPU` + `Tokenizer-12Hz` (`~690 MB`):** Only exports `CustomVoice` (9 built-in speakers) and **completely omits `speaker_encoder.onnx` and `tokenizer_encoder.onnx`** (no voice cloning); `fp16` also overflows into `NaN` in `code_predictor`.
- **`sivasub987/Qwen3-TTS-0.6B-ONNX-INT8` (`2.08 GB`):** Explicitly fails on `ConvInteger(10)` in `speaker_encoder_q.onnx` / tokenizer graphs and relies on a native Rust DLL.
- **`pltobing/Qwen3-TTS-Streaming-ONNX` (`6.71 GB`) & `xkos/Qwen3-TTS-12Hz-1.7B-ONNX` (`11+ GB`):** Unquantized / multi-hundred-shard Python/CUDA exports far exceeding browser memory caps.

### 2.6 Watched Candidate: MOSS-TTS-Nano

`OpenMOSS-Team/MOSS-TTS-Nano-100M-ONNX` (`672.6 MB`) + `OpenMOSS-Team/MOSS-Audio-Tokenizer-Nano-ONNX` (`90.6 MB`, `Apache-2.0`, ungated) is the only recent permissive ONNX alternative with a complete zero-shot reference-audio encoder (`moss_audio_tokenizer_encode.onnx`, `45.32 MB`), 20 languages, `48 kHz` stereo output, and CPU/WASM viability (`~222 MB` when paired with community Q4 TTS). It remains on the watchlist rather than integrated because of higher English WER (`9.1%` FP32 / `11.4%` Q4 vs `4.5%` Chatterbox) and custom hybrid ORT Web + SentencePiece NFKC orchestration requirements.

---

## 3. Real Measured Chrome & Edge Benchmark Results

Measured in Playwright against `http://127.0.0.1:4173/#/poc` on Windows x64 (`Intel gen-12lp` / Iris Xe, `shader-f16: true`, `webgpuMaxBufferSize: 2.0 GiB`, `crossOriginIsolated: false`, `numThreads: 1`, 16 CPU cores, 32 GB RAM). Evaluation prompt: `"Hello from VoiceForge Studio. This is a real local browser voice cloning test."` (`seed: 42`, reference clip `default_voice.wav` from `onnx-community/chatterbox-ONNX`, `714,320` B).

### 3.1 Pocket TTS (`pocket-tts`, 146 MB INT8 WASM) — Full End-to-End Pass

| Metric | Google Chrome (`chrome`) | Microsoft Edge (`msedge`) |
|---|---|---|
| Status | **PASS** | **PASS** |
| Cold Init (146 MB download + SHA-256 + 5 ORT sessions) | `28,826.6 ms` (`28.8 s`) | `16,152.6 ms` (`16.2 s`) |
| Voice Conditioning Encode (`encodeVoice`) | `6,271.7 ms` (`6.3 s`) | `3,955.3 ms` (`4.0 s`) |
| Cached Voice Profile Load (`loadVoiceProfile`) | `21.8 ms` | `21.7 ms` |
| First-Chunk Latency (TTFB) | `586.7 ms` (`< 1 s`) | `643.6 ms` (`< 1 s`) |
| Total Synthesis Time | `6,210.6 ms` (`6.21 s`) | `6,652.3 ms` (`6.65 s`) |
| Audio Duration & Sample Rate | `4.24 s` (`101,760` samples @ `24,000 Hz`) | `4.24 s` (`101,760` samples @ `24,000 Hz`) |
| Real-Time Factor (`gen / audio`) | `1.46x` (`1.464`) | `1.57x` (`1.568`) |
| Waveform RMS / Peak | `0.1845` / `0.9707` | `0.1845` / `0.9707` |
| Non-Finite Samples / Browser Errors / `speechSynthesis` Calls | `0` / `0` / `0` | `0` / `0` / `0` |

### 3.2 Chatterbox ONNX (`chatterbox`, `q4f16`, 1.50 GB) — Hardware Check & Download Telemetry

- **Hardware Compatibility (`checkHardwareCompatibility()`):** **PASS** in both Chrome and Edge (`compatible: true`, `recommendedBackend: 'webgpu'`, `recommendedExecutionMode: 'quality'`, `shaderF16Supported: true`, `maxBufferSize: 2.0 GiB`).
- **Ephemeral Cold-Cache Download Telemetry:**
  - **Chrome:** Downloaded and SHA-256-verified `1,454,179,627 / 1,499,431,645` B (`96.98%` — completed `speech_encoder`, `embed_tokens`, `conditional_decoder`, and `97%` of `language_model_q4f16.onnx_data`) before hitting the `360,000 ms` PoC `AbortSignal` limit (`AbortError`).
  - **Edge:** Downloaded `419,361,429 / 1,499,431,645` B (`27.97%` of `speech_encoder.onnx_data`) before the Hugging Face CDN stream dropped (`TypeError: network error`).
  - **Resolution:** `src/storage/modelCache.ts` was upgraded to skip already-cached artifacts in `voiceforge-models-v1` (by matching `sizeBytes` and manifest metadata) on resume and automatically retry transient network/stream errors up to 3 attempts with exponential backoff and `AbortSignal` propagation.
  - **Scope Note:** Because the 360 s PoC budget was consumed by the 1.50 GB cold download in fresh Playwright contexts, full 4-session WebGPU shader compilation and inference latency for `chatterbox` on Intel Iris Xe remain unmeasured (`N/A`) in automated CI.

---

## 4. Default Engine Selection Rationale

VoiceForge Studio intentionally selects **`pocket-tts` as the default primary engine** (`defaultEngineId: "pocket-tts"` in `public/model-manifests/models.json`):
1. **10x Smaller Download Footprint:** `146.24 MB` (`8` files) downloads in ~16–29 s cold and survives browser storage/CDN hiccups far more reliably than a `1.50 GB` (`13`-file) bundle.
2. **Verified 100% Chrome & Edge End-to-End Pass:** Proven zero-shot reference cloning (`mimi_encoder`), `< 1 s` time-to-first-audio (`587–644 ms`), `1.46x–1.57x` RTF, and clean `24 kHz` PCM (`0` NaNs, `0` errors) on real hardware.
3. **Universal CPU/WASM Compatibility:** Runs in single-threaded WASM SIMD without WebGPU hardware or COOP/COEP server headers, ensuring it works on GitHub Pages, static hosts, and non-WebGPU browsers out of the box.

**`chatterbox` (`1.50 GB` `q4f16` / `1.55 GB` `q4`)** remains first-class and selectable for users on WebGPU-capable hardware seeking maximum expressiveness, emotion `exaggeration` control, and high-fidelity voice cloning (with local folder import and resumable download support).
