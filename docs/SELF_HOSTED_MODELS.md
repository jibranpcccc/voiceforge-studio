# Self-Hosted Models Guide

By default, VoiceForge Studio downloads commit-pinned ONNX model weights directly from Hugging Face (`KevinAHM/pocket-tts-onnx` and `onnx-community/chatterbox-ONNX`). If you want faster local/LAN downloads, air-gapped or corporate-firewall access, or zero dependency on Hugging Face uptime, you can host the verified weights alongside your static VoiceForge Studio files.

---

## 1. Download & Verify Models Locally

Use [scripts/download-models.mjs](file:///c:/Users/jibra/Desktop/1/cloner/scripts/download-models.mjs) to fetch the exact revisions from [public/model-manifests/models.json](file:///c:/Users/jibra/Desktop/1/cloner/public/model-manifests/models.json) and verify every file's exact `sizeBytes` and `sha256` checksum:

```bash
# Default: download Pocket TTS (146.24 MB, 8 files) into ./models/
node scripts/download-models.mjs --engine pocket-tts --out models

# Download Chatterbox ONNX (1.50 GB q4f16)
node scripts/download-models.mjs --engine chatterbox --out models

# Download Chatterbox q4 + q4f16 (adds 353.8 MB language_model_q4 for GPUs without shader-f16)
node scripts/download-models.mjs --engine chatterbox --precision both --out models

# Download both Pocket TTS and Chatterbox into ./models/
node scripts/download-models.mjs --engine all --out models

# Preview files and sizes without downloading
node scripts/download-models.mjs --engine all --dry-run
```

### CLI Options

| Flag | Default | Description |
|---|---|---|
| `--engine <id>` | `pocket-tts` | `pocket-tts`, `chatterbox`, or `all` |
| `--out <dir>` | `models` | Target output directory |
| `--precision <mode>` | `q4f16` | Chatterbox LM precision: `q4f16`, `q4`, or `both` |
| `--layout <mode>` | `flat` | `flat` (`<out>/<relativePath>`) or `by-engine` (`<out>/<engineId>/<relativePath>`) |
| `--manifest <path>` | `public/model-manifests/models.json` | Custom manifest file path |
| `--force` | `false` | Re-download files even if already present and SHA-256 verified |
| `--dry-run` | `false` | Print planned files, byte sizes, and SHA-256 prefixes only |

Re-running the script without `--force` skips files whose size and SHA-256 already match, making interrupted downloads safe to resume.

---

## 2. Directory Structure (`flat` vs. `by-engine`)

With the default `--layout flat`, `pocket-tts` and `chatterbox` do not collide and produce:

```text
models/
├── config.json                                  # Chatterbox
├── generation_config.json                       # Chatterbox
├── preprocessor_config.json                     # Chatterbox
├── tokenizer.json                               # Chatterbox
├── tokenizer_config.json                        # Chatterbox
└── onnx/
    ├── english_2026-04/                         # Pocket TTS (8 files)
    │   ├── text_conditioner.onnx
    │   ├── flow_lm_main_int8.onnx
    │   ├── flow_lm_flow_int8.onnx
    │   ├── mimi_decoder_int8.onnx
    │   ├── mimi_encoder_int8.onnx
    │   ├── bos_before_voice.npy
    │   ├── bundle.json
    │   └── tokenizer.model
    ├── speech_encoder.onnx                      # Chatterbox
    ├── speech_encoder.onnx_data
    ├── embed_tokens.onnx
    ├── embed_tokens.onnx_data
    ├── conditional_decoder.onnx
    ├── conditional_decoder.onnx_data
    ├── language_model_q4f16.onnx
    └── language_model_q4f16.onnx_data
```

If you prefer separate engine subdirectories (`models/pocket-tts/...` and `models/chatterbox/...`), pass `--layout by-engine` and configure `./models/{engineId}/` in Settings.

---

## 3. Upload `models/` to cPanel or Static Host

Upload your `models/` folder next to `index.html` inside your deployment directory—for example:

```text
public_html/voiceforge/
├── .htaccess
├── index.html
├── assets/
├── runtime/
├── model-manifests/
└── models/
    └── onnx/...
```

Ensure `.htaccess` (from [scripts/cpanel.htaccess](file:///c:/Users/jibra/Desktop/1/cloner/scripts/cpanel.htaccess)) is present so `.onnx`, `.onnx_data`, `.bin`, `.npy`, and `.model` files are served as `application/octet-stream` with long-lived `Cache-Control` headers.

> **Service Worker behavior:** [public/sw.js](file:///c:/Users/jibra/Desktop/1/cloner/public/sw.js) explicitly ignores requests under `models/` (`if (relPath.startsWith('models/')) return;`). This prevents the app-shell cache from duplicating multi-hundred-megabyte weights; instead, VoiceForge Studio streams and caches verified artifacts inside `voiceforge-models-v1` (Cache Storage / OPFS).

---

## 4. Configure `Self-Hosted Model Base URL` in Settings

1. Open VoiceForge Studio and go to **Settings** (`#/settings`).
2. Scroll to **Self-Hosted Model Base URL**.
3. Enter `./models/` (or click the **Use ./models/** quick button).
   - If you used `--layout by-engine`, click **Use Self-Hosted ./models/{engineId}/**.
   - You can also enter an absolute HTTPS mirror URL (e.g., `https://cdn.example.com/voiceforge-models/`) provided that origin sends permissive CORS headers (`Access-Control-Allow-Origin`).
4. Click **Save URL**.

---

## 5. Verify Offline Readiness

1. Navigate to **Model Manager** (`#/models`).
2. Confirm the top banner displays `Self-hosted mirror: ./models/`.
3. Click **Download** on **Pocket TTS** (or **Chatterbox ONNX**). VoiceForge Studio will fetch from `./models/...`, verify every file's exact `sizeBytes` and SHA-256 digest via Web Crypto, and commit it to `voiceforge-models-v1`.
4. Click **Verify Integrity** on the model card and confirm the badge transitions to **Offline Ready**.
5. To verify offline operation, open **DevTools → Network → Offline** (or disable Wi-Fi), reload the page, and run a test synthesis in **Voice Cloning** (`#/clone`) or **Narration Studio** (`#/studio`).

### Alternative: Offline Local Folder Import (No Web Server Mirror Needed)

If you downloaded `models/` onto a workstation and want to load weights into a browser without uploading `1.50 GB` to your web server, open **Model Manager** (`#/models`) and use **Import Local Folder** to select the local `models/` directory directly. Every file is SHA-256 verified before caching.
