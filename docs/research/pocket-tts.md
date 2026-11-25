# Pocket TTS & Browser-Compatible ONNX Voice Cloning Research

**Date:** 2026-11-25  
**Scope:** Feasibility, exact Hugging Face / GitHub repository metadata, ONNX subgraph signatures, quantization, browser WASM/WebGPU compatibility, memory footprint, and licensing for Kyutai Pocket TTS in a 100% client-side static web application.

---

## Executive Summary & Go / No-Go Verdict

| Criterion | Verified Status |
|---|---|
| **Overall Verdict** | **GO (Primary CPU/WASM Voice-Cloning Engine)** |
| **Ungated Browser Reference-Audio Voice Cloning** | **YES — Fully Supported.** `KevinAHM/pocket-tts-onnx` (`gated: false`) ships `mimi_encoder.onnx` (FP32) and `mimi_encoder_int8.onnx` (INT8) in every per-language bundle, enabling true zero-shot voice cloning from user mic recordings or uploaded audio entirely client-side. |
| **Primary Browser Execution Backend** | **WASM (`onnxruntime-web`, `executionProviders: ["wasm"]`)** with SIMD enabled. Single-threaded WASM works without COOP/COEP headers; multi-threaded WASM requires COOP/COEP (`crossOriginIsolated`). WebGPU is **not recommended** for the INT8 graphs due to `DynamicQuantizeLinear` / `MatMulInteger` ops and per-step stateful tensor transfer overhead. |
| **Recommended Default Bundle (`english_2026-04`, INT8)** | **8 files**, **146,243,630 bytes (~146.24 MB / 139.47 MiB)** using all-INT8 ONNX files (or **146,243,590 bytes** keeping `text_conditioner.onnx` in FP32, which is 40 bytes smaller). Without `mimi_encoder_int8.onnx` (synthesis-only): **7 files**, **125,464,014 bytes (~125.46 MB / 119.65 MiB)**. |
| **Audio Spec** | **24,000 Hz**, mono, Float32 PCM, `frame_rate = 12.5` Hz (`samples_per_frame = 1920`, `80 ms/frame`), `latent_dim = 32`, `conditioning_dim = 1024`. |
| **Licenses** | Model weights: **CC-BY-4.0** (with Kyutai Prohibited Use notice). Upstream `kyutai-labs/pocket-tts` & `hemanth/pocket-voice` code: **MIT**. `KevinAHM/pocket-tts-onnx` & `KevinAHM/pocket-tts-web` wrapper code: **Apache-2.0**. |

---

## 1. Sources & Verified Repository Metadata

### 1.1 GitHub Repositories

| Repository | URL | Default Branch & Commit SHA | License | Role |
|---|---|---|---|---|
| **kyutai-labs/pocket-tts** | https://github.com/kyutai-labs/pocket-tts | `main` @ `bc4d640c925a3782092a841e9bc7ba442a65a838` | **MIT** (`LICENSE`, 1,023 B) | Official PyTorch (`v4.0.1`, `torch>=2.5.0`) + Rust (`xn-ptts`) implementation, configs, audio preprocessing (`end_on_pause`), and training scripts. |
| **hemanth/pocket-voice** | https://github.com/hemanth/pocket-voice | `main` @ `a4496c429f1dcd6ea8faef55a21dc4b7d45636a9` | **MIT** (declared in `README.md`; GitHub API `license: null` because no standalone `LICENSE` file) | Zero-build static browser demo using `onnxruntime-web@1.18.0`, Web Worker, `AudioWorklet` (`PCMPlayerWorklet.js`), IndexedDB voice storage, and `sentencepiece.js` WASM shim. |

### 1.2 Hugging Face Repositories

| Repo / Space | URL | Commit SHA (Branch `main`) | Gated Status | License | Notes |
|---|---|---|---|---|---|
| **KevinAHM/pocket-tts-onnx** | https://huggingface.co/KevinAHM/pocket-tts-onnx | `58a6d00cf13d239b6748cb0769f35c580a8f606c` (2026-04-21T17:34:05Z) | **`false` (Ungated)** | `cc-by-4.0` (weights) / `Apache-2.0` (code in README) | Primary ONNX export with 10 per-language bundles (FP32 + INT8) + legacy root `onnx/`. Includes `mimi_encoder.onnx` & `mimi_encoder_int8.onnx`. |
| **KevinAHM/pocket-tts-web** (HF Space) | https://huggingface.co/spaces/KevinAHM/pocket-tts-web | `d0c0c79b7712256a32d691c67f20b8ae2e020d00` | **`false` (Ungated)** | `cc-by-4.0` (models) / `Apache-2.0` (`CODE-LICENSE`) | Static browser demo hosting 5 INT8 language bundles (`english_2026-04`, `german`, `italian`, `portuguese`, `spanish`) + `voices.bin` (52,401,928 B each, `PTVB1` format, 8 voices) + `scripts/export_voice_bins.py`. Sets COOP/COEP headers in Space YAML & `server.py`. |
| **kyutai/pocket-tts** | https://huggingface.co/kyutai/pocket-tts | `db04f0e653473e5c7333c69686ac92b7460b0c1d` (2026-10-21T12:36:43Z) | **`"auto"` (GATED — HTTP 401 without token/acceptance)** | `cc-by-4.0` + `extra_gated_prompt` | Official Safetensors weights (with voice-cloning enabled) + precomputed `embeddings/*.safetensors`. **Cannot be fetched anonymously from a browser.** |
| **kyutai/pocket-tts-without-voice-cloning** | https://huggingface.co/kyutai/pocket-tts-without-voice-cloning | `a7056f505a4a8ca72d8b5fb1440071d6f1a35739` (2026-10-21T12:37:23Z) | **`false` (Ungated)** | `cc-by-4.0` | Official ungated Safetensors weights (encoder weights stripped) + ungated `tokenizer.json`, `tokenizer.model`, and precomputed `embeddings/*.safetensors`. |
| **csukuangfj2/sherpa-onnx-pocket-tts-int8-2026-01-26** | https://huggingface.co/csukuangfj2/sherpa-onnx-pocket-tts-int8-2026-01-26 | `4145e1e8ec6c81dc73a28641c6ab031ab57ea5b3` | **`false` (Ungated)** | `LICENSE` (18,655 B, CC-BY-4.0) | Sherpa-ONNX export (`encoder.onnx` 72.7 MB, `lm_main.int8.onnx` 76.3 MB, `lm_flow.int8.onnx` 9.96 MB, `decoder.int8.onnx` 22.7 MB, `text_conditioner.onnx` 16.4 MB, `vocab.json`, `token_scores.json`). |
| **prasadvittaldev/pocket-tts-portuguese-onnx-int4** | https://huggingface.co/prasadvittaldev/pocket-tts-portuguese-onnx-int4 | `19b6f571077bd52976fa8d18c7dca2a6d3ae679f` | **`false` (Ungated)** | `cc-by-4.0` | Experimental **Portuguese-only** INT4 (`MatMulNBits`) export (`flow_lm_main_int4.onnx` 40,802,614 B). No equivalent English INT4 repo was found in Hugging Face search. |
| **onnx-community/pocket-tts-onnx** | — | — | **HTTP 401 (Private / Gated / Unavailable)** | — | Not accessible anonymously. |

### 1.3 Reference Application Notes (`https://offlinetts.com/app/pocket/`)
Observed capabilities (for feature inspiration only; no proprietary code or branding copied):
- Client-side browser execution via ONNX Runtime Web defaulting to CPU WebAssembly with an optional WebGPU backend toggle.
- 5 language bundles (`en`, `de`, `it`, `pt`, `es`), ~146 MB per non-English INT8 bundle and ~198 MB for English when bundled with its precomputed `voices.bin` (~52 MB).
- 8 built-in voices plus zero-shot voice cloning via microphone recording or audio file upload, processed locally by the Mimi encoder.
- Streaming chunked playback with **WAV** (lossless PCM) and **MP3** export options.

---

## 2. Exact Hugging Face File Tree & Sizes (`KevinAHM/pocket-tts-onnx`)

Verified via `https://huggingface.co/api/models/KevinAHM/pocket-tts-onnx/tree/main?recursive=true` at commit `58a6d00cf13d239b6748cb0769f35c580a8f606c`.

### 2.1 Primary Recommended Bundle: `onnx/english_2026-04/` (6-Layer Model, 13 Files)

| File Path | Byte Size | MB (Decimal) | LFS SHA-256 OID | Role / Precision |
|---|---:|---:|---|---|
| `onnx/english_2026-04/bos_before_voice.npy` | 4,224 | 0.004 MB | `f46edf4f7007b7ba4ea58831f49d003e59e167b4641c44bb3addfe9231a780b1` | Float32 BOS conditioning prefix (`insert_bos_before_voice: true`) |
| `onnx/english_2026-04/bundle.json` | 24,381 | 0.024 MB | *(git blob `6c44c3f66eccff6f2875ed7e1c780bc522001e2d`)* | Bundle config, 18 FlowLM state specs, 56 Mimi state specs |
| `onnx/english_2026-04/tokenizer.model` | 59,339 | 0.059 MB | `d461765ae179566678c93091c5fa6f2984c31bbe990bf1aa62d92c64d91bc3f6` | SentencePiece Unigram model (4,000 tokens) |
| `onnx/english_2026-04/text_conditioner.onnx` | 16,388,344 | 16.39 MB | `4ecee995fb69f85c7a7493d11f7b5ee15d9950facc7ab3f5c9c49ef1e03847bb` | FP32 token embedding lookup (`Gather`, `[4000, 1024]`) |
| `onnx/english_2026-04/text_conditioner_int8.onnx` | 16,388,384 | 16.39 MB | `24c0642bff11a4e1435c004d0c2aa6c68e093fadfa35f0f0dba849ac67f25ac3` | INT8-tagged copy (40 B *larger* than FP32; prefer FP32) |
| `onnx/english_2026-04/flow_lm_main.onnx` | 302,742,149 | 302.74 MB | `6d18315e2c33ca3e3aa4a4e3dca22f56d007fd823127e24948b37695bf54190f` | FP32 6-layer FlowLM transformer backbone |
| `onnx/english_2026-04/flow_lm_main_int8.onnx` | 76,341,079 | 76.34 MB | `f9bd8106b79a0192c1c43399ab938fb24900a95c1c599870d75a884e99000116` | INT8 6-layer FlowLM transformer backbone |
| `onnx/english_2026-04/flow_lm_flow.onnx` | 39,097,095 | 39.10 MB | `085d239f68897e28fb06e95c743738ad8b8c092ee6dc55f5491313e81ff08062` | FP32 flow-matching velocity MLP head |
| `onnx/english_2026-04/flow_lm_flow_int8.onnx` | 9,962,530 | 9.96 MB | `3dd781ee5abee9e195320bf0106bebd6372a852b3b36352524ee78b40554635d` | INT8 flow-matching velocity MLP head |
| `onnx/english_2026-04/mimi_decoder.onnx` | 41,471,926 | 41.47 MB | `86f038caa02a96a0ff9c25526a0ff43a4906c418197ed72d3e30f720ac7ce802` | FP32 Mimi neural codec decoder (latents -> 24 kHz PCM) |
| `onnx/english_2026-04/mimi_decoder_int8.onnx` | 22,684,077 | 22.68 MB | `3630450a3297a101792a6ac66619ebc70ab916b265e6220c2afaef8b1673f925` | INT8 Mimi neural codec decoder |
| `onnx/english_2026-04/mimi_encoder.onnx` | 39,768,446 | 39.77 MB | `853e2ca623b8782d94c3745ec6133bfdff7ce33d9b11128bd29ea03f28d76e3d` | FP32 Mimi neural codec encoder (ref audio -> 1024-d latents) |
| `onnx/english_2026-04/mimi_encoder_int8.onnx` | 20,779,616 | 20.78 MB | `abb46f1ad0b83c3840fe38c3652ab0eda7d1d97a63f1953bbbff5d04d8f4c855` | INT8 Mimi neural codec encoder (for browser cloning) |

#### Download Totals for `english_2026-04`
- **Browser INT8 + Voice Cloning (all `_int8.onnx` + 3 common assets = 8 files):** `146,243,630` bytes (**146.24 MB / 139.47 MiB**).
- **Browser INT8 Recommended (`text_conditioner.onnx` FP32 + 4 `_int8.onnx` + 3 common assets = 8 files):** `146,243,590` bytes (**146.24 MB / 139.47 MiB**).
- **Browser INT8 Synthesis-Only (no `mimi_encoder`, 7 files):** `125,464,014` bytes (**125.46 MB / 119.65 MiB**).
- **Python Reference INT8 (`mimi_encoder.onnx` FP32 + `text_conditioner.onnx` FP32 + 3 `_int8.onnx` + 3 common = 8 files):** `165,232,420` bytes (**165.23 MB / 157.58 MiB**).
- **Full FP32 + Voice Cloning (8 files):** `439,555,904` bytes (**439.56 MB / 419.19 MiB**).
- **All 13 files in directory:** `585,711,590` bytes (**585.71 MB**).

### 2.2 All Language Bundles in `KevinAHM/pocket-tts-onnx`

All 10 bundles contain the exact same 13-file structure (`bos_before_voice.npy`, `bundle.json`, `tokenizer.model`, and FP32 + INT8 pairs for all 5 subgraphs). Note that **`*_24l` bundles are 24-layer undistilled previews**: their `flow_lm_main.onnx` is **1,210,441,908 B (~1.21 GB)** and `flow_lm_main_int8.onnx` is **305,144,125 B (~305.14 MB)**.

| Bundle Directory | Layers | FlowLM States | Browser INT8 Total (8 files, w/ encoder) | FP32 Total (8 files) | `remove_semicolons` | `frames_after_eos` override |
|---|---:|---:|---:|---:|---|---|
| `onnx/english_2026-04` | 6 | 18 | 146,243,630 B (146.24 MB) | 439,555,904 B (439.56 MB) | `false` | `null` (dynamic) |
| `onnx/german` | 6 | 18 | 146,244,109 B (146.24 MB) | 439,556,383 B (439.56 MB) | `true` | `null` |
| `onnx/italian` | 6 | 18 | 146,244,353 B (146.24 MB) | 439,556,627 B (439.56 MB) | `false` | `null` |
| `onnx/portuguese` | 6 | 18 | 146,245,276 B (146.25 MB) | 439,557,550 B (439.56 MB) | `false` | `null` |
| `onnx/spanish` | 6 | 18 | 146,245,170 B (146.25 MB) | 439,557,444 B (439.56 MB) | `false` | `null` |
| `onnx/french_24l` | 24 | 72 | 375,065,364 B (375.07 MB) | 1,347,274,351 B (1,347.27 MB) | `true` | `8` |
| `onnx/german_24l` | 24 | 72 | 375,065,031 B (375.07 MB) | 1,347,274,018 B (1,347.27 MB) | *(in bundle)* | *(in bundle)* |
| `onnx/italian_24l` | 24 | 72 | 375,065,275 B (375.07 MB) | 1,347,274,262 B (1,347.27 MB) | *(in bundle)* | *(in bundle)* |
| `onnx/portuguese_24l` | 24 | 72 | 375,066,198 B (375.07 MB) | 1,347,275,185 B (1,347.28 MB) | *(in bundle)* | *(in bundle)* |
| `onnx/spanish_24l` | 24 | 72 | 375,066,092 B (375.07 MB) | 1,347,275,079 B (1,347.28 MB) | *(in bundle)* | *(in bundle)* |

**Legacy root `onnx/` files** (9 files, `581,872,405` B total, including `onnx/LICENSE` at 18,655 B and an older 73,165,554 B `onnx/mimi_encoder.onnx` without an INT8 encoder) are deprecated; `KevinAHM/pocket-tts-onnx` README states new integrations should use `onnx/<language>/`.

**Built-in Voices Caveat:** `KevinAHM/pocket-tts-onnx` does **not** ship `.safetensors` or `voices.bin` for the 8 predefined voices (`alba`, `azelma`, `cosette`, `eponine`, `fantine`, `javert`, `jean`, `marius`); its Python script fetches them from gated `kyutai/pocket-tts`. For ungated browser use without custom user recordings, precomputed voice states can be sourced either from `kyutai/pocket-tts-without-voice-cloning` (`languages/english_2026-04/embeddings/*.safetensors`, ungated, 5.06–7.62 MB each) or `KevinAHM/pocket-tts-web` (`onnx/<lang>/voices.bin`, ungated, 52,401,928 B for 8 voices in `PTVB1` binary format), OR shipped as short ungated reference `.wav` clips encoded on demand via `mimi_encoder`.

---

## 3. Architecture, Tokenizer & Verified ONNX Tensor Signatures

All tensor names, shapes, dtypes, opsets, and operator counts below were **directly inspected** via `onnxruntime` (`1.23.2`) and protobuf wire parsing on the downloaded `onnx/english_2026-04/` models from `KevinAHM/pocket-tts-onnx`.

### 3.1 Tokenizer Format
- **Format in ONNX bundles:** SentencePiece Unigram binary protobuf (`tokenizer.model`, 59,339 bytes in `english_2026-04`).
- **Verified vocabulary:** `vocab_size = 4000`, `unk_id = 0`, `bos_id = 1`, `eos_id = 2`, `pad_id = 3`.
- **Upstream JSON counterpart:** `kyutai/pocket-tts-without-voice-cloning` also publishes `tokenizer.json` (245,020 bytes, Hugging Face `tokenizers` `Unigram` model, 4,000 vocab entries).
- **Browser execution:** `hemanth/pocket-voice` and `KevinAHM/pocket-tts-web` load `tokenizer.model` via an Emscripten/WASM `sentencepiece.js` build (~4.02 MB) with browser `fs`/`Buffer` shims (`loadFromArrayBuffer()` -> `encodeIds()` / `decodeIds()`). Alternatively, `tokenizer.json` can be parsed in pure TypeScript (~245 KB vs 4 MB WASM) if exact SentencePiece normalization/pre-tokenization parity is matched and tested.

### 3.2 ONNX Subgraphs & Exact Input/Output Signatures (`english_2026-04`)

#### 1. `mimi_encoder_int8.onnx` (and `mimi_encoder.onnx`) — Voice Conditioning Encoder
- **IR / Opset:** IR v10, `ai.onnx` opset 18; 261 nodes (`DynamicQuantizeLinear`: 9, `MatMulInteger`: 9, `Conv`: 12, `Elu`: 10).
- **Inputs:**
  - `audio`: `tensor(float32)`, shape `[1, 1, audio_len]` (24 kHz mono PCM in `[-1, 1]`).
- **Outputs:**
  - `latents`: `tensor(float32)`, shape `[1, CeilToInt((IntTrueDiv(audio_len - 1920, 1920)) + 1.0), 1024]` (~12.5 frames/sec, 1024-dim conditioning vectors).

#### 2. `text_conditioner.onnx` (and `text_conditioner_int8.onnx`) — Text Embedding Lookup
- **IR / Opset:** IR v7, `ai.onnx` opset 14; 1 node (`Gather`).
- **Inputs:**
  - `token_ids`: `tensor(int64)`, shape `[1, seq_len]`.
- **Outputs:**
  - `embeddings`: `tensor(float32)`, shape `[1, seq_len, 1024]`.

#### 3. `flow_lm_main_int8.onnx` (and `flow_lm_main.onnx`) — 6-Layer Autoregressive FlowLM Transformer
- **IR / Opset:** IR v7, `ai.onnx` opset 14; 2,265 nodes (`DynamicQuantizeLinear`: 26, `MatMulInteger`: 26).
- **Inputs (20 total for 6-layer; 74 total for 24-layer):**
  - `sequence`: `tensor(float32)`, shape `[1, seq_len, 32]` (empty `[1, 0, 32]` during voice/text prefix conditioning; `[1, 1, 32]` filled with `NaN` on AR step 0, then previous sampled latent on steps `>= 1`).
  - `text_embeddings`: `tensor(float32)`, shape `[1, text_len, 1024]` (voice latents prepended with `bos_before_voice.npy` during voice conditioning; text embeddings during text conditioning; empty `[1, 0, 1024]` during AR decoding steps).
  - `state_0 .. state_17` (18 stateful KV-cache tensors across `transformer.layers.0..5.self_attn`, 3 per layer):
    - `state_{3k}` (`cache`): `tensor(float32)`, shape `[2, 1, 1000, 16, 64]`, init fill `NaN`.
    - `state_{3k+1}` (`current_end`): `tensor(float32)`, shape `[0]`, init fill `empty` (`[]`).
    - `state_{3k+2}` (`step`): `tensor(int64)`, shape `[1]`, init fill `zeros` (`[0n]`).
- **Outputs (20 total):**
  - `conditioning`: `tensor(float32)`, shape `[1, 1024]` (conditioning vector `c` for `flow_lm_flow`).
  - `eos_logit`: `tensor(float32)`, shape `[1, 1]` (EOS triggered when `eos_logit[0] > -4.0`, continuing for `frames_after_eos` frames).
  - `out_state_0 .. out_state_17`: updated KV-cache states matching `state_0 .. state_17` shapes/dtypes.

#### 4. `flow_lm_flow_int8.onnx` (and `flow_lm_flow.onnx`) — Flow-Matching Velocity Network
- **IR / Opset:** IR v7, `ai.onnx` opset 14; 461 nodes (`DynamicQuantizeLinear`: 20, `MatMulInteger`: 26).
- **Inputs:**
  - `c`: `tensor(float32)`, shape `[batch, 1024]` (`conditioning` from `flow_lm_main`).
  - `s`: `tensor(float32)`, shape `[batch, 1]` (Euler start time `j / lsd_steps`).
  - `t`: `tensor(float32)`, shape `[batch, 1]` (Euler end time `(j + 1) / lsd_steps`).
  - `x`: `tensor(float32)`, shape `[batch, 32]` (initial Gaussian noise `N(0, sqrt(temperature))`, integrated via `x += flow_dir * (1 / lsd_steps)`).
- **Outputs:**
  - `flow_dir`: `tensor(float32)`, shape `[Gemmflow_dir_dim_0, 32]` (`[1, 32]`).

#### 5. `mimi_decoder_int8.onnx` (and `mimi_decoder.onnx`) — Stateful Streaming Mimi Codec Decoder
- **IR / Opset:** IR v8, `ai.onnx` opset 17; 941 nodes (`DynamicQuantizeLinear`: 8, `MatMulInteger`: 8).
- **Inputs (57 total):**
  - `latent`: `tensor(float32)`, shape `[1, seq_len, 32]` (chunked frames, e.g. 2–3 frames for first chunk, 12–15 frames thereafter).
  - `state_0 .. state_55` (56 causal conv + transformer KV-cache states per `mimi_state_manifest` in `bundle.json`):
    - Causal conv flags (`first`): `tensor(bool)`, shape `[1]`, init `ones`.
    - Conv history/partial buffers (`previous`/`partial`): `tensor(float32)`, shapes `[1, 512, 6]`, `[1, 64, 2]`, `[1, 256, 6]`, `[1, 256, 2]`, `[1, 128, 0]`, `[1, 128, 5]`, `[1, 128, 2]`, `[1, 64, 0]`, `[1, 64, 4]`, `[1, 64, 2]`, `[1, 32, 0]`, `[1, 512, 16]`, `[1, 1, 6]`, `[1, 512, 2]`, `[1, 64, 4]`.
    - 4 attention caches (`decoder_transformer.transformer.layers.0..1.self_attn` and `encoder_transformer.transformer.layers.0..1.self_attn`): `tensor(float32)`, shape `[2, 1, 8, 1000, 64]` + `end_offset` (`int64[1]`) + `offset` (`int64[1]`). *(Note: `state_25..54` are encoder-side state tensors retained in the exported Mimi graph signature and passed through unchanged).*
- **Outputs (57 total):**
  - `audio_frame`: `tensor(float32)`, shape `[1, 1, seq_len * 1920]` (`Convaudio_frame_dim_2`), 24 kHz mono PCM.
  - `out_state_0 .. out_state_55`: updated streaming states.

### 3.3 End-to-End Inference Pipeline
1. **Voice Conditioning (once per voice, cacheable):**
   - Preprocess reference clip: mono, resample to 24,000 Hz, apply `end_on_pause` (strip trailing silence >35 dB below peak, 20 ms fade-out, append 80 ms zero silence).
   - Run `mimi_encoder` -> `latents [1, T_v, 1024]`.
   - Prepend `bos_before_voice.npy` (`[1, 1, 1024]`) if `insert_bos_before_voice` is `true` -> `[1, T_v + 1, 1024]`.
   - Run `flow_lm_main` once with empty `sequence [1, 0, 32]`, `text_embeddings = voice_latents`, and initial `state_0..17` -> yields voice-conditioned `baseFlowState`. **Important:** `step` (`state_{3k+2}`) in the KV cache must match the prefix length; zeroing `step` causes the model to ignore the voice.
2. **Text Chunking & Normalization:**
   - Collapse newlines/whitespace; replace `;` with `,` if `remove_semicolons` is `true`; capitalize first char; append `.` if ending in alphanumeric; optionally left-pad 8 spaces for `< 5` words if `pad_with_spaces_for_short_inputs` is `true`.
   - Split by sentence boundaries and pack chunks up to `max_token_per_chunk` (50 tokens).
3. **Per-Chunk Synthesis:**
   - Clone `baseFlowState`, reset `mimiState`, tokenize chunk -> `text_conditioner` -> `textEmb`.
   - Feed `textEmb` into `flow_lm_main` (`sequence = [1, 0, 32]`) to update `flowLmState`.
   - Autoregressive loop (`step < max_frames`, e.g. `ceil((tokens / 3.0 + 2.0) * 12.5)`):
     - Run `flow_lm_main` (`sequence = curr [1, 1, 32]`, `text_embeddings = [1, 0, 1024]`).
     - Sample initial `x ~ N(0, sqrt(temperature))` (`default_temperature: 0.3` in Kyutai's `english_2026-04.yaml`, `0.7` in `KevinAHM` / `pocket-voice`) and run `lsd_steps` (default `1`) Euler steps through `flow_lm_flow`.
     - Check `eos_logit > -4.0`; continue `frames_after_eos` frames (1–3 frames depending on word count) then stop.
     - Decode accumulated latents in streaming batches (e.g. 2–3 frames first chunk for ~200 ms TTFB, then 12–15 frames per batch) via `mimi_decoder` -> 24 kHz Float32 PCM chunks.

---

## 4. Quantization, Browser Execution & Resource Analysis

### 4.1 Quantization Variants
- **INT8 (Dynamic Quantization — Recommended for Browser):** `flow_lm_main_int8.onnx` (76.34 MB), `flow_lm_flow_int8.onnx` (9.96 MB), `mimi_decoder_int8.onnx` (22.68 MB), `mimi_encoder_int8.onnx` (20.78 MB). Uses ONNX `DynamicQuantizeLinear` + `MatMulInteger` (uint8/int8 dynamic activations × int8 weights). Kyutai's quantization benchmarks (`docs/quantization.md`) show INT8 `attention_ffn` matches FP32 quality (WER delta `-0.022 ± 0.032`, statistically indistinguishable from 0).
- **Text Conditioner Precision:** Keep **`text_conditioner.onnx` (FP32, 16,388,344 B)** rather than `text_conditioner_int8.onnx` (16,388,384 B). It is a single `Gather` op on a 4,000 × 1,024 FP32 table; quantizing saves zero bytes (actually +40 B overhead) and risks embedding degradation.
- **FP32:** 439.56 MB total for 6-layer `english_2026-04`. Noticeably heavier download and memory footprint (~450 MB+ runtime memory) with negligible audible benefit over INT8.
- **INT4 (`MatMulNBits`):** Community-proven feasible (`prasadvittaldev/pocket-tts-portuguese-onnx-int4` shrinks `flow_lm_main` from 302.7 MB to 40.8 MB), but **no ungated English INT4 Pocket TTS export is currently published**, so INT8 is the production choice unless we quantize and host our own English INT4 artifact later.

### 4.2 Browser WASM vs. WebGPU Compatibility
- **WASM (`["wasm"]`) — Recommended:**
  - ONNX Runtime Web's Emscripten WASM EP supports all operators in opsets 14–18 including `DynamicQuantizeLinear` and `MatMulInteger` via MLAS SIMD kernels.
  - All 6-layer `.onnx` files are self-contained single files (no external `.onnx.data` sidecars, avoiding ORT Web's `Module.MountedFiles is not available` error).
  - Runs well on standard CPUs because Pocket TTS is batch=1 sequential autoregressive decoding (`1` frame at a time with small 1024-dim matmuls).
- **WebGPU (`["webgpu"]`) — Not Recommended for Default Pocket TTS INT8:**
  1. **Quantized Op Compatibility:** `flow_lm_main_int8.onnx`, `flow_lm_flow_int8.onnx`, `mimi_decoder_int8.onnx`, and `mimi_encoder_int8.onnx` all rely on `DynamicQuantizeLinear` and `MatMulInteger`, which target CPU MLAS kernels and lack universal/performant WGSL compute shader coverage in `onnxruntime-web` WebGPU (causing session fallback or op errors).
  2. **Batch=1 Autoregressive Dispatch Overhead:** Even with FP32 graphs, each AR frame runs `flow_lm_main` (passing/returning 18 KV tensors) + `flow_lm_flow` + `mimi_decoder` (56 state tensors). Without GPU-resident IO binding (`keepOutputsOnGpu`), CPU↔GPU buffer marshaling per frame negates GPU compute gains—consistent with Kyutai's own finding that GPU acceleration yields little or no speedup over strong CPUs at batch=1.

### 4.3 Single-Threaded vs. Multi-Threaded WASM (Without COOP/COEP)
- **Without COOP/COEP (GitHub Pages, default cPanel static hosting):** `self.crossOriginIsolated` is `false`, so `SharedArrayBuffer` is disabled by browsers. `ort.env.wasm.numThreads` **must be `1`** (with `ort.env.wasm.simd = true` on non-iOS browsers). Single-threaded WASM SIMD still runs Pocket TTS 6-layer INT8 cleanly in a Web Worker without UI freeze, though at lower RTFx than multi-core native/isolated setups.
- **With COOP/COEP (`Cross-Origin-Opener-Policy: same-origin` + `Cross-Origin-Embedder-Policy: require-corp` or `credentialless`):** Enables `SharedArrayBuffer` and `numThreads = min(navigator.hardwareConcurrency || 4, 4)` (note KevinAHM observed ~2x speedup when capping threads at `<= 4` to avoid oversubscription on small sequential matmuls). Note that `require-corp` breaks third-party subresources lacking CORP/CORS headers; if external Hugging Face fetches are used alongside COOP/COEP, `credentialless` or `Cross-Origin-Resource-Policy: cross-origin` is required.

### 4.4 Estimated RAM Usage & Browser Caveats
- **Model Weights on Disk / Fetch:** ~146.24 MB (INT8 w/ encoder) or ~125.46 MB (INT8 w/o encoder). Note that `ort.InferenceSession.create(url)` or passing a `Uint8Array` temporarily holds the serialized `.onnx` bytes during session initialization before releasing the JS buffer.
- **Preallocated Static State Buffers (from `bundle.json`):**
  - `flow_lm_state_manifest`: 6 × `[2, 1, 1000, 16, 64]` float32 = **49,152,000 B (~46.88 MiB)** per state copy. Holding `baseFlowState` + `flowLmState` = **~93.75 MiB**.
  - `mimi_state_manifest`: 4 × `[2, 1, 8, 1000, 64]` float32 = **16,384,000 B (~15.63 MiB)** + <0.5 MiB conv buffers.
- **Total Browser Tab RAM (Estimated):**
  - **Desktop Chrome/Edge/Firefox (INT8 WASM):** **~350–600 MB** steady-state (146 MB weights + ~110 MB KV/conv states + ORT WASM linear memory/arena + `sentencepiece.js` 4 MB). Peak during parallel `InferenceSession.create` can briefly reach **~600–800 MB**.
  - **iOS Safari Caveat (verified in `hemanth/pocket-voice`):** iOS Web Workers enforce a strict **~256 MB** WASM memory cap. `hemanth/pocket-voice` mitigates OOM crashes by: (a) falling back to a main-thread worker shim on iOS (~1 GB+ limit), (b) loading the 4 synthesis sessions **sequentially** with 500 ms delays and lazy-loading `mimi_encoder_int8.onnx` and `sentencepiece.js` only when needed, (c) setting `enableCpuMemArena = false`, `enableMemPattern = false`, `graphOptimizationLevel = "disabled"`, `ort.env.wasm.simd = false`, `numThreads = 1`, and using WASM-only `ort.min.js` instead of `ort.all.min.js`.

### 4.5 Recommended Reference Audio Duration & Preprocessing
- **Recommended duration:** **5 to 10 seconds** of clean, dry, single-speaker speech (no background music/reverb).
  - `hemanth/pocket-voice` recommends **~5 seconds** and hard-caps/clips inputs at **10 seconds** (`SAMPLE_RATE * 10 = 240,000` samples).
  - Upstream `kyutai-labs/pocket-tts` (`tts_model.py` `truncate=True` and `export-voice` docs) caps long audio prompts at **30 seconds** (`max_samples = 30 * sr`) to prevent memory/KV-cache issues (each second is 12.5 frames of the 1,000-frame FlowLM KV cache).
- **Critical Quality Preprocessing (`end_on_pause` from `kyutai-labs/pocket-tts/pocket_tts/data/audio_utils.py`):**
  1. Downmix to mono and resample to **24,000 Hz** Float32.
  2. Trim trailing silence using 20 ms RMS frames (`> 35 dB` below loudest frame).
  3. Apply a **20 ms linear fade-out** on the end of remaining speech.
  4. Append **80 ms (`0.08 s` = 1,920 samples) of zero silence**.  
  *Why:* Training prompts end mid-pause; stopping directly on speech causes the model to continue the cut-off word/syllable as a burst at chunk start, while long trailing silence delays speech onset.
- **Note on Voice Conditioning Artifacts:** Voice quality/noise in the reference clip is faithfully reproduced by Mimi conditioning, so client-side silence trimming, DC/high-pass filtering, and optional noise reduction significantly improve clone fidelity.
