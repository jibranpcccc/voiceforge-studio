# Browser-Compatible ONNX Voice Cloning Research: Chatterbox, Chatterbox Turbo, VoxShot, Qwen3-TTS, and Recent Alternatives

> **Scope & Verification Method:** Every commit SHA, file path, byte size, LFS SHA-256 OID, gated status, license, ONNX opset/operator count, and tensor signature in this report was directly verified against the Hugging Face Hub API, raw repository manifests/configs, GitHub repository trees/sources, and ONNX ModelProto graph headers inspected during this session. Nothing is extrapolated or assumed.

---

## Executive Summary & Go / No-Go Recommendations

| Engine Slot | Candidate | License | Ungated | Browser Download Size (Recommended Profile) | Go / No-Go | Primary Rationale |
|---|---|---|---|---|---|---|
| **Engine A** | **Chatterbox ONNX** (`onnx-community/chatterbox-ONNX`) — **WebGPU (`q4f16` LM + `fp32` enc/emb/dec)** with `q4` fallback | **MIT** | Yes (`gated: false`) | **1,499,431,645 B** (`1.50 GB` / `1.40 GiB`) for `q4f16`; **1,548,314,008 B** (`1.55 GB` / `1.44 GiB`) for `q4` | **GO (Primary WebGPU Engine)** | Proven end-to-end in-browser (Transformers.js v4 + ONNX Runtime Web, verified by `m96-chan/voxshot`). Highest intelligibility (~4.5% WER in `q4` + quantized decoder tests), emotion `exaggeration` control, true zero-shot reference cloning (`speech_encoder.onnx`), and no `GatherBlockQuantized` blockers. Requires WebGPU (`~5.8x` slower than real-time on WASM CPU) and explicit `architectures: ["ChatterboxModel"]` config patch in Transformers.js. |
| **Engine B** | **Chatterbox Turbo ONNX** (`ResembleAI/chatterbox-turbo-ONNX`) | **MIT** | Yes (`gated: false`) | **565,370,537 B** (`565.4 MB` / `526.5 MiB`) for `q4f16`; **724,921,295 B** (`724.9 MB` / `675.1 MiB`) for `q4`; **1,123,739,879 B** (`1.12 GB` / `1.05 GiB`) for `q8` (`_quantized`) | **CONDITIONAL GO (Experimental / Raw ORT Web `webgpu` only; NO-GO for Transformers.js & WASM fallback)** | Attractive footprint (2.6x smaller than Engine A in `q4f16` because all 4 subgraphs are quantized) and 1-step MeanFlow decoder (`122` MHA ops vs `4,585` MatMuls). However: (1) all quantized subgraphs emit `com.microsoft:GatherBlockQuantized`, which ORT Web's WASM EP lacks; (2) `language_model` takes `position_ids` and `GPT2LMHeadModel` `text_config`, while `embed_tokens` omits `exaggeration`/`position_ids`; (3) higher WER (`7.95%` vs `4.5%` on 8-sentence check) and community reports of paralinguistic tag failures in fp32/fp16 ONNX and `onnxruntime-node` malloc crashes. Must run via raw `onnxruntime-web/webgpu` (not Transformers.js out-of-the-box) and must not silently fall back to WASM for quantized graphs. |
| **Engine D** | **Qwen3-TTS** (`QwenLM/Qwen3-TTS` & community ONNX exports: `wavekat/Qwen3-TTS-0.6B-Base-ONNX`, `danyalmalik/Qwen3-TTS-12Hz-0.6B-CustomVoice-ONNX-WebGPU`, `sivasub987/Qwen3-TTS-0.6B-ONNX-INT8`, `pltobing/Qwen3-TTS-Streaming-ONNX`, `xkos/Qwen3-TTS-12Hz-1.7B-ONNX`) | **Apache-2.0** | Yes (`gated: false`) | **3.38 GB** (`wavekat` INT4 deduplicated, excl. validation WAVs) / **6.09 GB** (`wavekat` FP32); **690 MB** (`danyalmalik` CustomVoice, *no cloning*) | **NO-GO (for Browser Voice Cloning today)** | **No complete, browser-ready, quantized ONNX export exists for Qwen3-TTS Base voice cloning.** `danyalmalik`'s WebGPU export (`690 MB`) only covers `CustomVoice` (9 built-in speakers, no `speaker_encoder` or `tokenizer_encoder`). `wavekat/Qwen3-TTS-0.6B-Base-ONNX` includes the full 6-model cloning pipeline, but leaves `text_embedding.npy` as a `1.245 GB` raw float32 array, `vocoder.onnx` unquantized at `915.4 MB`, `tokenizer_encoder.onnx` fixed to `[1, 240000]` (10 s) at `192.9 MB`, and requires Python/NumPy mel extraction + 28-layer Talker + 5-layer Code Predictor per 80 ms frame. |
| **Engine D (Alt)** | **MOSS-TTS-Nano-100M-ONNX** + **MOSS-Audio-Tokenizer-Nano-ONNX** (`OpenMOSS-Team/*`, Apr 2026) | **Apache-2.0** | Yes (`gated: false`) | **763.2 MB** combined (`672.6 MB` TTS + `90.6 MB` Codec); `~222 MB` if using quantized `danyalmalik` Q4 TTS + upstream `encode` | **WATCH / EXPERIMENTAL CANDIDATE (Best Non-Chatterbox Cloning Option)** | Only recent permissive (`Apache-2.0`), ungated ONNX model with **full zero-shot reference-audio encoder** (`moss_audio_tokenizer_encode.onnx`, `45.3 MB`), streaming codec decoder, 20 languages, 48 kHz stereo output, and CPU/WASM viability (`100M` params). Tradeoffs: higher WER (`~9.1%–11.4%` in `danyalmalik` Q4 tests vs `4.5%` on Chatterbox), SentencePiece text frontend, and requires custom raw ORT Web multi-session orchestration. |

---

## 1. Chatterbox (`resemble-ai/chatterbox` & `onnx-community/chatterbox-ONNX`)

### 1.1 Upstream Source & License (`resemble-ai/chatterbox`)
- **GitHub Repository:** `https://github.com/resemble-ai/chatterbox`
- **Verified Head Commit SHA:** `ab55923c27757c90cfcc407baa57dc25a7d25217` (default branch `master`, pushed `2026-11-04T18:48:12Z`)
- **License:** **MIT** (`LICENSE`, Copyright (c) 2025 Resemble AI)
- **PyTorch Architecture (`src/chatterbox/tts.py`):**
  - `VoiceEncoder` (`ve.safetensors`, 16 kHz input) → 256-d speaker embedding (`T3Cond`)
  - `S3Tokenizer` (`S3_SR = 16000`, `ENC_COND_LEN = 6 * 16000 = 96,000` samples = **6 s** conditioning prompt for T3)
  - `T3` (`t3_cfg.safetensors`, 0.5B Llama-3 backbone with `Perceiver` resampler & `emotion_adv` exaggeration control)
  - `S3Gen` (`s3gen.safetensors`, `S3GEN_SR = 24000`, `DEC_COND_LEN = 10 * 24000 = 240,000` samples = **10 s** reference for flow matching + HiFT-GAN vocoder)
  - `EnTokenizer` (`tokenizer.json`)
  - `PerthImplicitWatermarker` (`resemble-perth`, optional in ONNX)

### 1.2 Hugging Face Repository Metadata (`onnx-community/chatterbox-ONNX`)
- **URL:** `https://huggingface.co/onnx-community/chatterbox-ONNX`
- **Exact Commit SHA:** `3cab09af388d3f02bba43443fce88c1f4525ac43` (`lastModified: 2025-10-20T09:36:35.000Z`)
- **Gated / Private / Disabled:** `gated: false`, `private: false`, `disabled: false`
- **License:** `mit` (`base_model: ResembleAI/chatterbox`)
- **Sample Rate:** `24,000 Hz` (`preprocessor_config.json`: `"sampling_rate": 24000`, `"feature_extractor_type": "ChatterboxFeatureExtractor"`, `"processor_class": "ChatterboxProcessor"`)
- **Total Repository Size:** `4,975,301,250` bytes (`4.98 GB`, 22 files)

#### Complete Verified File Tree (`onnx-community/chatterbox-ONNX`)

| Path | Size (Bytes) | LFS SHA-256 OID / Git OID |
|---|---:|---|
| `.gitattributes` | 2,153 | `git:e74b746180efecfa135c8397646b94b93e9e36dc` |
| `README.md` | 10,681 | `git:5f7f70e47c45378b4af9336babb986913cf39571` |
| `config.json` | 1,097 | `git:d0da305f19e59045bd015d6fd71be6c6e1f35471` |
| `default_voice.wav` | 714,320 | `lfs:3ebc531cdaba358a327099c1c4f0448026719957bcf4d8e9868767f227e02f4e` |
| `generation_config.json` | 93 | `git:1a4f0ac01b4f7bb6a0f1ec615fb78c55edd2993e` |
| `preprocessor_config.json` | 130 | `git:cdfcb83f968fab8ce81b5aeb3f432e4806f5c98c` |
| `tokenizer.json` | 28,543 | `git:a7fd9f442e24759d6688b2cc1a054173eae63cc6` |
| `tokenizer_config.json` | 244 | `git:072b863c27a3028fc899b0110f67f8dbcd4d2ec9` |
| `onnx/conditional_decoder.onnx` | 6,350,448 | `lfs:1656d0d31332bae1854839959a3139300ebb67c178651dfa3f8c5fbfa5351351` |
| `onnx/conditional_decoder.onnx_data` | 533,970,816 | `lfs:51d58345a272747665ec9d5bb61e01835258a940e321a288582ac4c18cf01b5a` |
| `onnx/embed_tokens.onnx` | 13,286 | `lfs:160722ec14789f616abdb1e31916cbbf9223c03fde0ab546d64ca74fb72e430b` |
| `onnx/embed_tokens.onnx_data` | 61,640,704 | `lfs:898c563c3a5ca1b9ea10ce89b0cdcf252b0bb5ab460dfc4eadea003b56e5d2ee` |
| `onnx/language_model.onnx` | 171,387 | `lfs:861a34585605e8ad671051788afc495dcbeaee833a41523a1b33aded9c3babc7` |
| `onnx/language_model.onnx_data` | 2,080,632,832 | `lfs:efe9a1173c40d50bc651cb96ebff9f23d6f20d5b3a11b0685510e3a3facdbcf1` |
| `onnx/language_model_fp16.onnx` | 172,657 | `lfs:0c36a5bbbc2a4ed8c345033896612cd320fd0971a0f5e6447ab4cdd2d7f22e36` |
| `onnx/language_model_fp16.onnx_data` | 1,040,316,416 | `lfs:6d1b751ce1af740bbfa6cde9dc7d359afedba4b6de5a875b6fd199131216f16d` |
| `onnx/language_model_q4.onnx` | 227,911 | `lfs:7f8cdca83b2493536cbf3acf421199808a3d68736f55f4eabd20ef8a99da4313` |
| `onnx/language_model_q4.onnx_data` | 353,621,248 | `lfs:5203d1e83c159316f9923c5c83759f6a34f87be1322ce4ad0facd9fc4aef4790` |
| `onnx/language_model_q4f16.onnx` | 229,388 | `lfs:3b78e9235be5e2e2a811e482399155cb30415f6d87c98c21d12bf48843fc928f` |
| `onnx/language_model_q4f16.onnx_data` | 304,737,408 | `lfs:2480da95471e4cd41a6b1876686e65e8a594c82459f2e5d6fd7592a5bad4e6da` |
| `onnx/speech_encoder.onnx` | 1,184,608 | `lfs:8f1c8a0f89b77bf9cd5dd8f2e034eb2c79dc00fe70d41196b28c257643b00ccb` |
| `onnx/speech_encoder.onnx_data` | 591,274,880 | `lfs:04431dcef6325c54b02de2219845888b464bcd1f1ac2f8839c2fecd1ed2ef294` |

*(Note: `onnx-community/chatterbox-multilingual-ONNX` at commit `452d3f434aa592098f1eedac9099f33642ab2da5`, `4,984,021,571` B, ships `Cangjie5_TC.json` and lacks `config.json` and `preprocessor_config.json`, so Transformers.js cannot load it directly from Hub, and its multilingual T3 requires classifier-free guidance `guidance_scale: 1.5` which unpatched `@huggingface/transformers@4.2.0` lacks — see Section 3.)*

### 1.3 Config, Subgraph Signatures, Opsets & Operators (`onnx-community/chatterbox-ONNX`)
- **Model Config (`config.json`):**
  - `model_type`: `"chatterbox"` (no top-level `architectures` array — important Transformers.js quirk!).
  - `text_config`: `LlamaForCausalLM`, `hidden_size: 1024`, `intermediate_size: 4096`, `num_hidden_layers: 30`, `num_attention_heads: 16`, `num_key_value_heads: 16`, `head_dim: 64`, `vocab_size: 8194`, `max_position_embeddings: 131072`, `rope_theta: 500000.0` (Llama-3 RoPE scaling).
  - `transformers.js_config`: `"use_external_data_format": true`, `"kv_cache_dtype": { "fp16": "float16", "q4f16": "float16" }`.
- **Generation Config (`generation_config.json`):** `bos_token_id: 1`, `eos_token_id: [2, 6562]`, `repetition_penalty: 1.2`. Special speech tokens: `START_SPEECH_TOKEN = 6561`, `STOP_SPEECH_TOKEN = 6562`, `SILENCE_TOKEN = 4299`.

#### Verified ONNX Subgraphs (Parsed Directly from `.onnx` Protobuf Headers)

1. **`onnx/speech_encoder.onnx`** (only `fp32`; `592,459,488` B total)
   - **IR / Opset:** `ir=9`, `opsets=['ai.onnx=20']`
   - **Inputs:** `audio_values: float32 ['batch_size', 'num_samples']` (24 kHz mono PCM)
   - **Outputs:**
     - `audio_features: float32 ['batch_size', 'sequence_length', 1024]`
     - `audio_tokens: int64 ['batch_size', 'audio_sequence_length']`
     - `speaker_embeddings: float32 ['batch_size', 192]`
     - `speaker_features: float32 ['batch_size', 'feature_dim', 80]`
   - **Notable Ops:** `Conv: 243`, `MatMul: 112`, `Cast: 57`, `STFT: 4` (no `com.microsoft` contrib ops)
2. **`onnx/embed_tokens.onnx`** (only `fp32`; `61,653,990` B total)
   - **IR / Opset:** `ir=9`, `opsets=['ai.onnx=20']`
   - **Inputs:** `input_ids: int64 ['batch_size', 'sequence_length']`, `position_ids: int64 ['batch_size', 'sequence_length']`, `exaggeration: float32 ['batch_size']`
   - **Outputs:** `inputs_embeds: float32 ['batch_size', 'sequence_length', 1024]`
   - **Notable Ops:** `Cast: 9`, `MatMul: 1`
3. **`onnx/language_model*.onnx`** (30-layer Llama KV-cache decoder)
   - **IR / Opset:** `ir=10`, `opsets=['ai.onnx=21', 'com.microsoft=1']`
   - **Inputs:**
     - `inputs_embeds: float32 ['batch_size', 'sequence_length', 1024]`
     - `attention_mask: int64 ['batch_size', 'total_sequence_length']`
     - `60` KV cache tensors: `past_key_values.{0..29}.{key,value}` (`['batch_size', 16, 'past_sequence_length', 64]`; `float32` in `fp32`/`q4`, `float16` in `fp16`/`q4f16`)
     - *(Note: No `position_ids` input — removed in HF PR #5.)*
   - **Outputs:**
     - `logits: float32 ['batch_size', 'sequence_length', 8194]`
     - `60` KV cache tensors: `present.{0..29}.{key,value}` (`['batch_size', 16, 'total_sequence_length', 64]`)
   - **Notable Ops:**
     - `language_model.onnx` (`fp32`): `MatMul: 151`, `com.microsoft:GroupQueryAttention: 30`, `Cast: 2`
     - `language_model_q4.onnx` (`q4`): `com.microsoft:MatMulNBits: 151`, `com.microsoft:GroupQueryAttention: 30`, `Cast: 2`
     - `language_model_q4f16.onnx` (`q4f16`): `com.microsoft:MatMulNBits: 151`, `com.microsoft:GroupQueryAttention: 30`, `Cast: 4`
     - *(Crucially, **zero** `GatherBlockQuantized` ops!)*
4. **`onnx/conditional_decoder.onnx`** (only `fp32`; `540,321,264` B total)
   - **IR / Opset:** `ir=8`, `opsets=['ai.onnx=17']`
   - **Inputs:**
     - `speech_tokens: int64 ['batch_size', 'num_speech_tokens']` (concat of `audio_tokens`, generated tokens, and `3 x 4299` silence tokens)
     - `speaker_embeddings: float32 ['batch_size', 192]`
     - `speaker_features: float32 ['batch_size', 'feature_dim', 80]`
   - **Outputs:** `waveform: float32 ['batch_size', 'num_samples']` (24 kHz mono)
   - **Notable Ops:** `MatMul: 4585`, `Conv: 545`, `Cast: 34`, `ConvTranspose: 5`, `STFT: 1` (10-step flow matching + HiFT vocoder; no `com.microsoft` ops)

### 1.4 Quantization Profiles & Exact Download Totals (`onnx-community/chatterbox-ONNX`)
Shared `fp32` components (`speech_encoder` + `embed_tokens` + `conditional_decoder`) = `1,194,434,742` bytes (`1,139.10 MiB`), plus `30,008` bytes of JSON configs/tokenizer. **There is no `q8` (`_quantized`) language model in this repo** (requesting `q8` in Transformers.js 404s on `onnx/language_model_quantized.onnx`!).

| Profile (LM dtype) | `language_model` Size | Total Download (with configs) | WASM Feasibility | WebGPU Feasibility |
|---|---:|---:|---|---|
| **`q4f16`** | `304,966,796` B (`290.84 MiB`) | **1,499,431,645 B (`1.50 GB` / `1.40 GiB`)** | No (`float16` KV cache / WebGPU target) | **Recommended** when adapter has `shader-f16` |
| **`q4`** | `353,849,159` B (`337.46 MiB`) | **1,548,314,008 B (`1.55 GB` / `1.44 GiB`)** | Runs, **~5.8x slower than RT** (2.52 s in 14.7 s); fits `< 2 GB` single file, high total RAM | **Required fallback** when WebGPU adapter lacks `shader-f16` |
| **`fp16`** | `1,040,489,073` B (`992.29 MiB`) | **2,234,953,922 B (`2.23 GB` / `2.08 GiB`)** | No | Heavy VRAM pressure on integrated GPUs (`> 2.2 GB` weights + KV + activations) |
| **`fp32`** | `2,080,804,219` B (`1,984.41 MiB`) | **3,275,269,068 B (`3.28 GB` / `3.05 GiB`)** | **BLOCKED**: `language_model.onnx_data` is `2.08 GB` (`1.94 GiB`), near Chrome's `0x7fe00000` (`2.145 GB`) `ArrayBuffer` cap, and total weights + KV exceed WASM32 `4 GB` linear memory | Unusable on 4–8 GB iGPUs / browser GPU memory caps |

*(Note: Community repo `danyalmalik/Chatterbox-ONNX-WebGPU` also provides a `q4/int8` quantized `conditional_decoder.onnx` at `145,358,459` B replacing the `533.97 MB` fp32 decoder with `4.5%` WER unchanged, though it uses custom `voices/default.bin` rather than `speech_encoder.onnx`.)*

---

## 2. Chatterbox Turbo (`ResembleAI/chatterbox-turbo-ONNX`)

### 2.1 Repository Metadata & Architecture
- **URL:** `https://huggingface.co/ResembleAI/chatterbox-turbo-ONNX`
- **Exact Commit SHA:** `d21799bd0354adb85e348b8a0442a8405110a2cf` (`lastModified: 2025-12-15T15:48:47.000Z`)
- **Gated / Private / Disabled:** `gated: false`, `private: false`, `disabled: false`
- **License:** `mit` (`base_model: ResembleAI/chatterbox-turbo`)
- **Sample Rate:** `24,000 Hz` (`preprocessor_config.json`: `"sampling_rate": 24000`)
- **Total Repository Size:** `7,387,133,000` bytes (`7.39 GB`, 46 files across all 5 precisions)
- **Upstream Architectural Changes (`tts_turbo.py` & `config.json`):**
  - 350M streamlined architecture: **GPT2-medium** 24-layer backbone (`GPT2LMHeadModel`, `n_layer: 24`, `n_head: 16`, `n_embd: 1024`, `vocab_size: 6563`, `n_ctx: 8196`) replacing Llama 30-layer.
  - **GPT-2 BPE tokenizer** (`tokenizer.json` = `3,562,272` B, `tokenizer_class: "GPT2Tokenizer"`) instead of Chatterbox's 28.5 KB EnTokenizer.
  - **1-step MeanFlow decoder** (`s3gen_meanflow.safetensors` → `conditional_decoder`) replacing 10-step flow matching (`122` `MultiHeadAttention` + `757` `MatMul` + `177` `Conv` vs original's `4,585` `MatMul` + `545` `Conv`).
  - `ENC_COND_LEN = 15 * 16000` (15 s T3 prompt vs 6 s in original), `DEC_COND_LEN = 10 * 24000` (10 s).
  - **No `exaggeration` input** (`hp.emotion_adv = False`, `hp.use_perceiver_resampler = False`).
  - Native paralinguistic tag tokens (`[cough]`, `[laugh]`, `[chuckle]`, etc.) in upstream PyTorch.

### 2.2 Complete Verified File Sizes & Per-Profile Totals (`ResembleAI/chatterbox-turbo-ONNX`)
All 4 ONNX subgraphs (`speech_encoder`, `embed_tokens`, `language_model`, `conditional_decoder`) are exported in **all 5 quantization variants**: `fp32` (no suffix), `fp16` (`_fp16`), `q8` (`_quantized`), `q4` (`_q4`), and `q4f16` (`_q4f16`). Shared JSON/tokenizer files = `3,564,072` bytes (`3.40 MiB`).

| Profile | `speech_encoder` | `embed_tokens` | `language_model` | `conditional_decoder` | Total Download (with configs/tokenizer) |
|---|---:|---:|---:|---:|---:|
| **`fp32`** | 1,045,884,904 B (997.4 MiB) | 232,814,602 B (222.0 MiB) | 1,269,932,078 B (1,211.1 MiB) | 770,483,260 B (734.8 MiB) | **3,322,678,903 B (`3.32 GB` / `3.09 GiB`)** |
| **`fp16`** | 523,497,024 B (499.2 MiB) | 116,408,026 B (111.0 MiB) | 635,071,862 B (605.7 MiB) | 386,123,344 B (368.2 MiB) | **1,664,664,315 B (`1.66 GB` / `1.55 GiB`)** |
| **`q8` (`_quantized`)** | 355,882,304 B (339.4 MiB) | 67,300,263 B (64.2 MiB) | 368,242,530 B (351.2 MiB) | 328,750,723 B (313.5 MiB) | **1,123,739,879 B (`1.12 GB` / `1.05 GiB`)** |
| **`q4`** | 230,760,458 B (220.1 MiB) | 37,289,228 B (35.6 MiB) | 204,731,144 B (195.2 MiB) | 248,576,406 B (237.1 MiB) | **724,921,295 B (`724.9 MB` / `675.1 MiB`)** |
| **`q4f16`** | 178,506,663 B (170.2 MiB) | 33,651,236 B (32.1 MiB) | 184,258,233 B (175.7 MiB) | 165,390,346 B (157.7 MiB) | **565,370,537 B (`565.4 MB` / `526.5 MiB`)** |

*(LFS SHA-256 OIDs for every file are stored in HF API metadata at commit `d21799bd0354adb85e348b8a0442a8405110a2cf`; notable `q4f16` OIDs: `speech_encoder_q4f16.onnx_data` `c017ab57887418e0609afdef52b0cbc17f43cb304e78af44300c0292cd2b2fa9`, `embed_tokens_q4f16.onnx_data` `37e96447b5f3ef46f46fb35cc599cfcb95b277e5528cc0c89bab78169da620ef`, `language_model_q4f16.onnx_data` `f084f21f977e365e76e622d2958c309ff894537f7b7133ac7fc5ce8fc055d6f9`, `conditional_decoder_q4f16.onnx_data` `3e53cc7cc05e72957797c620e1bf0c6d6b909df937de4756c6e534d50854ca3e`.)*

### 2.3 Verified ONNX Subgraph Signatures & Critical Ops Differences
1. **`speech_encoder*.onnx`** (`ir=9`, `opsets=['ai.onnx=20', 'com.microsoft=1']`)
   - Input: `audio_values: float32 ['batch_size', 'num_samples']`
   - Outputs: `audio_features: float32 ['batch_size', 'sequence_length', 1024]`, `audio_tokens: int64 ['batch_size', 'audio_sequence_length']`, `speaker_embeddings: float32 ['batch_size', 192]`, `speaker_features: float32 ['batch_size', 'feature_dim', 80]`
   - Ops (`fp32`): `Conv: 243`, `STFT: 4`, `MatMul: 76`, `com.microsoft:MultiHeadAttention: 12`.
   - Ops (`q4f16`): `Conv: 243`, `STFT: 4`, `com.microsoft:MultiHeadAttention: 12`, `com.microsoft:MatMulNBits: 72`, **`com.microsoft:GatherBlockQuantized: 1`**.
2. **`embed_tokens*.onnx`** (`ir=9`, `opsets=['ai.onnx=20']`)
   - Input: `input_ids: int64 ['batch_size', 'sequence_length']` *(NO `position_ids`, NO `exaggeration`)*
   - Output: `inputs_embeds: float32 ['batch_size', 'sequence_length', 1024]` *(in `q4f16`: `['batch_size', 'sequence_length - 2 + 2', 1024]`)*
   - Ops (`q4f16`): **`com.microsoft:GatherBlockQuantized: 2`**, `Cast: 1`.
3. **`language_model*.onnx`** (`ir=10`, `opsets=['ai.onnx=21', 'com.microsoft=1']`)
   - Inputs: `inputs_embeds: float32 ['batch_size', 'sequence_length', 1024]`, `attention_mask: int64 ['batch_size', 'total_sequence_length']`, **`position_ids: int64 ['batch_size', 'sequence_length']`**, + `48` KV cache tensors (`past_key_values.{0..23}.{key,value}`, `['batch_size', 16, 'past_sequence_length', 64]`, `float16` for `q4f16`/`fp16`, `float32` for `fp32`/`q4`/`_quantized`).
   - Outputs: `logits: float32 ['batch_size', 'sequence_length', 6563]`, + `48` `present` KV tensors.
   - Ops (`q4`, `q4f16`, AND `_quantized`!): `com.microsoft:GroupQueryAttention: 24`, `com.microsoft:MatMulNBits: 145`, **`com.microsoft:GatherBlockQuantized: 1`**.
4. **`conditional_decoder*.onnx`** (`ir=8`, `opsets=['ai.onnx=17', 'com.microsoft=1']`)
   - Inputs: `speech_tokens: int64 ['batch_size', 'num_speech_tokens']`, `speaker_embeddings: float32 ['batch_size', 192]`, `speaker_features: float32 ['batch_size', 'feature_dim', 80]`
   - Output: `waveform: float32 ['batch_size', 'num_samples']`
   - Ops (`q4f16`): `Conv: 177`, `ConvTranspose: 5`, `STFT: 1`, `com.microsoft:MultiHeadAttention: 122`, `com.microsoft:MatMulNBits: 746`, **`com.microsoft:GatherBlockQuantized: 1`**.

### 2.4 Real Blockers & Browser Compatibility Assessment for Turbo
1. **`com.microsoft:GatherBlockQuantized` Breaks WASM Fallback:** Every quantized variant (`q4`, `q4f16`, `_quantized`) of all 4 subgraphs uses `com.microsoft:GatherBlockQuantized` (even `_quantized` LM uses `MatMulNBits` + `GatherBlockQuantized`). ONNX Runtime Web's **WebGPU EP** implements `GatherBlockQuantized`, whereas ONNX Runtime Web's **WASM/CPU EP** lacks 4-bit block-quantized gather lookups (documented both in ORT Web issues and `danyalmalik/MOSS-TTS-Nano-100M-ONNX-WebGPU`). Thus quantized Turbo **cannot fall back to WASM**.
2. **Transformers.js Friction:** `ResembleAI/chatterbox-turbo-ONNX/config.json` omits top-level `architectures: ["ChatterboxModel"]` (so Transformers.js falls back to single-file probing unless patched like VoxShot does). While Transformers.js `configs.js` normalizes `gpt2` keys and `decoder_forward` checks `session.inputNames.includes('position_ids')`, `ResembleAI/chatterbox-turbo-ONNX` was exported for raw `onnxruntime`, and no major browser library (including `voxshot`) ships Turbo via Transformers.js. By contrast, `danyalmalik/Chatterbox-Turbo-ONNX-WebGPU` verified that `embed_tokens_q4`, `language_model_q4`, and `conditional_decoder_q4` **do run** on raw `onnxruntime-web/webgpu` in Chrome (with a precomputed default voice `voices/default.bin`).
3. **Quality & Runtime Caveats Observed Upstream:**
   - `danyalmalik` measured **7.95% WER** (Whisper `small.en` across 8 sentences) on Turbo `q4` vs **4.5% WER** on Chatterbox `q4` + quantized decoder.
   - `ResembleAI/chatterbox-turbo-ONNX` HF discussions report: **#9** paralinguistic tags (`[laugh]`, `[chuckle]`) are ignored or produce artifacts in fp32/fp16 ONNX; **#7** fp16 GPU inference latency complaints; **#6** `onnxruntime-node` malloc crashes during autoregressive decoding.
   - Turbo's `speech_encoder.onnx` (`fp32`: `997.4 MiB`) is 405 MiB larger than original Chatterbox's (`564.9 MiB`), though its `q4f16` (`170.2 MiB`) and `q4` (`220.1 MiB`) are much smaller.

---

## 3. VoxShot Browser Inference (`m96-chan/voxshot`)

- **GitHub Repository:** `https://github.com/m96-chan/voxshot` (MIT License, version `0.3.0`, head SHA `b6abd46a724b381fb787aac534d3f59936644d7b`, pushed `2026-11-04T05:40:52Z`)
- **Primary Engine (`src/engine/chatterbox/chatterbox-engine.ts` + `dtype-plan.ts`):**
  - Uses **`@huggingface/transformers@^4.2.0`** (`ChatterboxModel`, `AutoProcessor`, `AutoConfig`) loading `onnx-community/chatterbox-ONNX` inside a Web Worker (`examples/browser/src/tts.worker.ts`) with `AudioWorklet` gapless streaming playback and IndexedDB voice persistence.
  - **Key Engineering Lessons Verified in Source:**
    1. **Config Architecture Patch:** `onnx-community/chatterbox-ONNX/config.json` lacks `architectures`. VoxShot fetches `AutoConfig` and injects `architectures: ["ChatterboxModel"]` so `resolve_model_type` matches `MODEL_TYPES.Chatterbox` instead of probing `onnx/model_quantized.onnx` (two 404s) and corrupting `progress_total`.
    2. **Dual `dtype` Key Bug in Transformers.js:** `MODEL_SESSION_CONFIG[MODEL_TYPES.Chatterbox]` maps session key `model` → file `language_model`, while `session.js` reads `language_model`. VoxShot sets **both** `language_model` and `model` to the chosen quantization (`q4f16` or `q4`) while keeping `embed_tokens`, `speech_encoder`, and `conditional_decoder` at `fp32`.
    3. **WebGPU `shader-f16` Pre-flight Guard:** VoxShot checks `adapter.features.has("shader-f16")` *before* building load plans. A `q4f16` model on a WebGPU adapter without `shader-f16` loads without error and only crashes on the first inference step. Fallback chain: `webgpu/q4f16` → `webgpu/q4` → (optional) `wasm/q4`.
    4. **Dynamic Token Budget & KV-Cache Scaling:** VoxShot measured `onnx-community/chatterbox-ONNX` at `~2.4 tokens/char + 20` (`30 chars -> 92`, `120 chars -> 331`, `160 chars -> 403`), capping auto-derived budget at `1024` tokens (`~40 s`) to prevent runaway KV-cache growth across 30 layers.
    5. **Manual GPU Tensor Disposal & Compilation Silence:** Every `encode_speech()` and `generate()` returns GPU-backed tensors; VoxShot explicitly calls `.dispose()` after copying out `Float32Array` samples because JS GC feels no pressure from VRAM. It also uses a `300_000 ms` stall timeout because ONNX WebGPU session compilation is silent (`~35 s` idle, `>2 min` on loaded machines).
    6. **Measured Performance:** WebGPU RTX 5090 rendered `5.3 s` of speech in `2.7 s` (`~2x` real-time); WASM `q4` measured `2.52 s` in `14.7 s` (**`~5.8x` slower than real-time**), prompting `requiresGpu: true` option.
    7. **Multilingual Blocker:** Requires CFG (`guidance_scale: 1.5`), which `@huggingface/transformers@4.2.0` lacks (pending PR `huggingface/transformers.js#1705`). Without it, Japanese output rambles to `16.08 s` instead of `2.52 s`.
- **Secondary Experimental Engine (`voxshot/miotts`, unreleased in `src/engine/miotts/`):**
  - Uses **custom WGSL shaders via `web-xpu-ops`** + raw Safetensors (NOT ONNX!) for `Aratako/MioTTS-0.6B` (Apache-2.0, `m96-chan/MioTTS-0.6B-q8-webgpu`, `611.2 MB`) + `Aratako/MioCodec-25Hz-24kHz` (MIT, `523.1 MB`) + `m96-chan/MioCodec-encoder-webgpu` (`117.3 MB`). Requires WebGPU (`requiresGpu = true`), WavLM attention is $O(T^2)$ (capped at `20 s` reference because 3 min = `~3.9 GB` scratch), and VoxShot's text normalizer (`src/engine/miotts/text.ts`) is Japanese-only.

---

## 4. Qwen3-TTS (`QwenLM/Qwen3-TTS` & Community ONNX Exports)

### 4.1 Upstream Repository (`QwenLM/Qwen3-TTS`)
- **GitHub Repository:** `https://github.com/QwenLM/Qwen3-TTS` (head SHA `022e286b98fbec7e1e916cb940cdf532cd9f488e`, pushed `2026-03-17T06:38:41Z`)
- **License:** **Apache-2.0** (`LICENSE`)
- **Architecture:** 10-language (`zh, en, ja, ko, de, fr, es, it, pt, ru`) 12 Hz multi-codebook LM (`0.6B` and `1.7B` in `Base` [voice clone], `CustomVoice` [9 preset speakers], and `VoiceDesign`).
  - Voice cloning (`Base`) requires **both** a 128-bin mel ECAPA-TDNN `speaker_encoder` (`1024-d` x-vector) **and** a Mimi-style 12 Hz `tokenizer_encoder` (16 codebooks, for ICL reference-code prompt + transcript), plus a 28-layer `Talker` LM (codebook 0), a 5-layer `Code Predictor` (codebooks 1–15 per 80 ms frame), projection/embedding tables (`151,936`-token Qwen text vocab), and the 12 Hz causal `Vocoder` (`24 kHz` output).

### 4.2 Audit of Available Hugging Face ONNX Exports

| HF Repo & Commit SHA | License / Gated | Base Model | Total Bytes | Browser-Ready Voice Cloning? | Verified Blockers / Missing Pieces |
|---|---|---|---:|---|---|
| **`wavekat/Qwen3-TTS-0.6B-Base-ONNX`** (`177cd39e2ddab0d4d7ce5152a7abc2d382621158`) | Apache-2.0 / Ungated | `Qwen3-TTS-12Hz-0.6B-Base` | `8,768,260,635` B (`8.77 GB` full repo; **`3.38 GB`** deduplicated INT4; `6.09 GB` FP32) | **NO** (Python ORT only) | Complete 6-model voice cloning (`speaker_encoder.onnx` `35.6 MB`, `tokenizer_encoder.onnx` `192.9 MB` fixed input `[1, 240000]`, `int4/talker_{prefill,decode}` `475.5 MB` shared data, `int4/code_predictor` `335.7 MB`, `int4/vocoder` `915.4 MB`), **BUT**: (1) `embeddings/text_embedding.npy` is `1,244,659,840` B (`1.245 GB` uncompressed float32 `.npy`, plus `163.6 MB` other `.npy` tables — no ONNX gather graph!); (2) `vocoder.onnx` in `int4/` is identical to `fp32/vocoder.onnx` (`915.4 MB`, unquantized!); (3) requires Python `librosa` 128-bin mel extraction and reference transcript. |
| **`danyalmalik/Qwen3-TTS-12Hz-0.6B-CustomVoice-ONNX-WebGPU`** (`ccdd14012062ee383dda616d7799cc955924af8a`) + **`Qwen3-TTS-Tokenizer-12Hz-ONNX-WebGPU`** (`b2aa169358f3ba36110a9c9ce7d5a75209e39b7f`) | Apache-2.0 / Ungated | `Qwen3-TTS-12Hz-0.6B-CustomVoice` + `Tokenizer-12Hz` | `589,334,715` B + `100,611,208` B (`tok_decoder_q4`) = **~690 MB** | **NO** (`CustomVoice` only — **no cloning**) | Verified on Chrome WebGPU (`9.1%` WER in Chrome, `3.4%` ORT CPU). However, **omits `speaker_encoder.onnx` and `tokenizer_encoder.onnx` completely** (built for the 9 preset speakers, not `Base`). Also notes `fp16` overflows in `talker` and produces `NaN` in `code_predictor` (forced `fp32` KV cache + `int8` CPU `code_predictor`). |
| **`sivasub987/Qwen3-TTS-0.6B-ONNX-INT8`** (`83525915a2f7545bc516e3ac208d9d1ab5174d58`) | Apache-2.0 / Ungated | `Qwen3-TTS` (via `zukky/Qwen3-TTS-ONNX-DLL`) | `2,080,591,155` B (`2.08 GB`) | **NO** | Single-file INT8 exports, **explicitly fails** on `speaker_encoder_q.onnx`, `tokenizer12hz_encode_q.onnx`, and `tokenizer12hz_decode_q.onnx` due to `ConvInteger(10)` ops, and relies on a native **Rust DLL** for preprocessing. |
| **`pltobing/Qwen3-TTS-Streaming-ONNX`** (`4e24bde29755c202827b109cd9e80e34ce5f097d`) | Apache-2.0 / Ungated | `Qwen3-TTS-12Hz-0.6B-Base` | `6,709,610,493` B (`6.71 GB`) | **NO** | Unquantized FP32 Python/CUDA streaming pipeline (`talker_model_prefill.onnx` `1.78 GB` + `talker_model_step.onnx` `1.78 GB` + `text_embed_proj_model.onnx` `1.27 GB` + `codec_decoder_model.onnx` `456.7 MB`). Far exceeds browser/WASM limits. |
| **`xkos/Qwen3-TTS-12Hz-1.7B-ONNX`** (`6023a58eba391c4e2dbe7ff2dd73fbc9f039c76e`) | Apache-2.0 / Ungated | `Qwen3-TTS-12Hz-1.7B-Base` / `VoiceDesign` | ~11+ GB (hundreds of external `.weight` shards, FP16/FP32) | **NO** | Designed for desktop Python `onnxruntime` / `onnxruntime-gpu`; ships 16 separate `code_predictor_embed_g*.onnx` files and unbundled `onnx__MatMul_*` weight shards. |

**Bottom Line on Qwen3-TTS (Engine D):** No complete, permissively licensed, browser-ready ONNX export exists for Qwen3-TTS voice cloning (`Base`). Creating one would require exporting and quantizing the `Base` model's `text_embed_q4`, `codec_embed_q4`, `talker` (`use_webgpu_fp32`), `code_predictor` (CPU int8), `speaker_encoder` (plus JS 128-bin mel frontend), `tokenizer_encoder` (`193 MB`), and `tok_decoder_q4` (`100.6 MB`), plus implementing a 28-layer Talker + 15-step Code Predictor loop per 80 ms frame in TypeScript — **NO-GO** for immediate integration.

---

## 5. Survey of Other Recent Permissively Licensed Browser-Ready ONNX Voice Cloning Models

We checked recent (2025–2026) lightweight/permissive TTS & voice cloning candidates on Hugging Face and GitHub without assuming larger/newer is better:

1. **`OpenMOSS-Team/MOSS-TTS-Nano-100M-ONNX` + `OpenMOSS-Team/MOSS-Audio-Tokenizer-Nano-ONNX`** *(Apr 2026)*
   - **Commits:** `f52645cb467506d8e18e746ddd59482685b74e58` (`672,627,229` B) + `ceff0d0749bfb3fa2d61149794ec6feef0d1e1ae` (`90,578,835` B)
   - **License / Status:** **Apache-2.0**, ungated. 100M parameters, 20 languages, **48 kHz stereo**, 12.5 Hz 16-codebook RVQ.
   - **Voice Cloning Completeness:** **Complete** (`moss_audio_tokenizer_encode.onnx` + `.data` = `45.32 MB`, `moss_audio_tokenizer_decode_step.onnx` + `.data` = `44.55 MB`, plus 5 TTS graphs). Officially targets `onnxruntime-web` and ships `browser_poc_manifest.json` / `tts_browser_onnx_meta.json`.
   - **Browser Tradeoffs:** Smallest complete ONNX voice cloner (`763.2 MB` unquantized, or `176.5 MB` in `danyalmalik/MOSS-TTS-Nano-100M-ONNX-WebGPU` q4 + `45.3 MB` upstream encoder = `~222 MB`), CPU-viable. However, `danyalmalik` measured **11.4% WER** (English, Q4) vs `9.1%` (FP32) and `4.5%` on Chatterbox-ONNX; requires SentencePiece NFKC normalization + custom ORT Web hybrid CPU/WebGPU session code (not Transformers.js).

2. **`owensong/chatterbox-nano-ONNX` (`4a66d7da...`) & `ronbakker/chatterbox-nano-int4-int8-onnx` (`04456986...`)**
   - **Base Model:** `ResembleAI/chatterbox-nano` (`71ccd1d0...`, **MIT**, 2026-04, GPT2-small 12-layer T3 + MeanFlow S3Gen).
   - **Sizes:** `573,393,649` B (`owensong` mixed `fp16`/`q4f16`/`q4`) and `553,194,531` B (`ronbakker` 32-file split).
   - **Verified Graph Ops (`owensong`):** `speech_encoder_q4f16` (`hidden=768`, `STFT: 4`, `MultiHeadAttention: 12`, `MatMulNBits: 75`, `GatherBlockQuantized: 1`), `language_model_q4f16` (12 layers, `24` KV tensors, `MatMulNBits: 49`, `GatherBlockQuantized: 1`), `conditional_decoder_q4` (`MatMulNBits: 746`, `MultiHeadAttention: 122`, `STFT: 1`, `GatherBlockQuantized: 1`).
   - **Tradeoffs:** Very compact (`~573 MB`), MIT, tested once on Chrome RTX 3060 WebGPU, **but** explicitly disclaims any WER/speaker-similarity/robustness evaluation ("development smoke tests only") and shares Turbo's `GatherBlockQuantized` WASM blocker.

3. **`Aratako/MioTTS-0.6B` + `Aratako/MioCodec-25Hz-24kHz` (`voxshot/miotts`)**
   - **License:** **Apache-2.0** (`MioTTS-0.6B`, based on `Qwen/Qwen3-0.6B-Base`) + **MIT** (`MioCodec-25Hz-24kHz` & `m96-chan/MioCodec-encoder-webgpu`).
   - **Sizes:** `611.2 MB` (Q8 LM) + `523.1 MB` (codec decoder) + `117.3 MB` (WavLM encoder) + `13.8 MB` tokenizer = `1.27 GB`.
   - **Blocker:** **Not ONNX** (custom WGSL shaders via `web-xpu-ops` + Safetensors), WebGPU-only (no WASM), and VoxShot's implementation normalizes Japanese only (though `Aratako/MioTTS-0.6B` supports EN+JA).

4. **Incomplete / Non-Cloning / Non-Permissive Candidates (Ruled Out)**
   - **`danyalmalik/NeuTTS-Air-ONNX-WebGPU`** (`1d854fee...`, Apache-2.0, `525.5 MB`): Only ships decoder + `voice_dave.json` (no NeuCodec audio encoder), requires eSpeak/G2P phonemizer, `10.2%–11.4%` WER. (`neuphonic/neutts-air-onnx` is `3.04 GB` LM-only without codec).
   - **`danyalmalik/Fun-CosyVoice3-0.5B-ONNX-WebGPU`** (`dcdb9df4...`, Apache-2.0, `916.9 MB`): Omits speech tokenizer & CAM++ encoder (`voice_default.json` only); full `tonythethompson/CosyVoice-300M-ONNX` (`8.79 GB`) is Python-oriented.
   - **`danyalmalik/VoxCPM2-ONNX-WebGPU`** (`4b9c4acd...`, Apache-2.0, `1.56 GB`): Explicitly omits voice cloning ("only generation without a reference voice is exported"), `11.9%` WER in Chrome.
   - **`onnx-community/Supertonic-TTS-2-ONNX`** (`68d4d942...`, `263.4 MB`, 44.1 kHz, native Transformers.js) & **`onnx-community/Kokoro-82M-v1.0-ONNX`** (`1939ad2a...`, Apache-2.0, `86–325 MB`): Both use **fixed precomputed `voices/*.bin` embeddings only** — neither has a reference-audio voice encoder for zero-shot cloning, and Supertonic carries an **OpenRAIL** license rather than MIT/Apache-2.0.
   - **`Spark-TTS-0.5B-ONNX`**: Base model `SparkAudio/Spark-TTS-0.5B` is **CC-BY-NC-SA-4.0** (non-commercial, excluded).

---

## 6. Cross-Cutting Browser Runtime Constraints

1. **WASM 2 GB `ArrayBuffer` & 4 GB Linear Memory Ceilings:** Chrome caps single `ArrayBuffer` allocations around `0x7fe00000` bytes (`~2.145 GB`), and WASM32 linear memory has a hard `4 GB` ceiling. Unquantized `fp32` Chatterbox (`3.28 GB` weights, `2.08 GB` `language_model.onnx_data` alone) and `fp32` Chatterbox Turbo (`3.32 GB` weights) will hit or exceed WASM32 memory limits once KV cache and runtime allocations are added.
2. **WebGPU `shader-f16` Requirement:** `q4f16` and `fp16` ONNX models store `float16` KV-cache tensors and execute `fp16` WGSL shaders. Adapters lacking `adapter.features.has("shader-f16")` load the session without throwing and fail at the first inference pass. Apps must probe `shader-f16` upfront and select `q4` (with `fp32` KV cache) on adapters without it.
3. **Integrated GPU Memory & Tab Stability:** Loading `1.50 GB` (`Chatterbox q4f16`) plus WebGPU compute buffers, KV caches (`30 layers * 2 * 16 * seq_len * 64 * 2 B`), and compilation scratch easily reaches `2.0–2.8 GB` unified memory on integrated GPUs. Explicit `tensor.dispose()` after copying waveform/speaker `Float32Array`s is mandatory to prevent VRAM leaks across chunks, and WebGPU session compilation (`35 s – 120+ s` silent stall) must run in a dedicated Web Worker.
4. **Raw ORT Web vs. Transformers.js:**
   - **Engine A (`onnx-community/chatterbox-ONNX`)** works cleanly with **Transformers.js v4** (`ChatterboxModel` + `AutoProcessor`) once `architectures: ["ChatterboxModel"]` and dual `dtype` keys (`language_model` + `model`) are supplied.
   - **Engine B (`ResembleAI/chatterbox-turbo-ONNX`)** and **Qwen3-TTS / MOSS-TTS-Nano** should target **raw `onnxruntime-web/webgpu`** (or custom worker orchestration) if adopted, avoiding Transformers.js's rigid model-type resolution and ensuring full control over `position_ids`, `speech_encoder` caching, and `GatherBlockQuantized` WebGPU-only gating.
