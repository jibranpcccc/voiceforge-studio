# cPanel & Static Hosting Deployment Guide

VoiceForge Studio is a 100% static web application. Deploying on cPanel (or any Apache shared host) requires **zero SSH access, zero Node.js, zero Python, and zero backend databases** on the server.

---

## 1. Build the cPanel Package Locally

On your development machine (Node.js 22+):

```bash
npm ci
node scripts/build-cpanel.mjs
```

This script:
1. Copies ONNX Runtime Web WASM/MJS binaries into `public/runtime/`.
2. Runs `tsc --noEmit` and builds the production bundle with `VITE_BASE_PATH=./` into `dist-cpanel/`.
3. Copies [scripts/cpanel.htaccess](file:///c:/Users/jibra/Desktop/1/cloner/scripts/cpanel.htaccess) to `dist-cpanel/.htaccess`.
4. Packages `dist-cpanel/` into `release/voiceforge-studio-cpanel.zip` and verifies that `index.html`, `.htaccess`, `sw.js`, `manifest.webmanifest`, `model-manifests/models.json`, `runtime/ort-wasm*`, and `assets/` are present.

---

## 2. Enable HTTPS (Required)

Before opening the app, ensure your domain or subdomain uses **HTTPS** (in cPanel: **SSL/TLS Status → Run AutoSSL** or **Domains → Force HTTPS Redirect**).

Browser APIs required by VoiceForge Studio—**Service Workers**, **WebGPU**, **Cache Storage**, **OPFS**, and **Web Crypto (`crypto.subtle.digest` for SHA-256 verification)**—are disabled or restricted on plain `http://` origins (other than `localhost`).

If your host does not force HTTPS globally, you can also uncomment the `# 2. Optional HTTPS Redirect` section inside `.htaccess`.

---

## 3. Upload & Extract to `public_html/voiceforge/`

1. Log in to **cPanel → File Manager**.
2. Navigate to `public_html/` and create a folder such as `voiceforge` (`public_html/voiceforge/`), or use the document root of a subdomain.
3. Click **Upload** and upload `release/voiceforge-studio-cpanel.zip`.
4. Select `voiceforge-studio-cpanel.zip` and click **Extract** into `public_html/voiceforge/`.
5. Verify that **Show Hidden Files (dotfiles)** is enabled in File Manager **Settings** (top-right) so you can confirm `.htaccess` was extracted alongside `index.html`:

```text
public_html/voiceforge/
├── .htaccess
├── index.html
├── manifest.webmanifest
├── sw.js
├── assets/
├── icons/
├── model-manifests/
│   └── models.json
└── runtime/
    ├── ort-wasm-simd-threaded.wasm
    ├── ort-wasm-simd-threaded.mjs
    ├── ort-wasm-simd-threaded.jsep.wasm
    ├── ort-wasm-simd-threaded.jsep.mjs
    ├── ort-wasm-simd-threaded.asyncify.wasm
    ├── ort-wasm-simd-threaded.asyncify.mjs
    ├── ort-wasm-simd-threaded.jspi.wasm
    └── ort-wasm-simd-threaded.jspi.mjs
```

6. Delete `voiceforge-studio-cpanel.zip` from the server once extraction is complete.

---

## 4. What `.htaccess` Configures

The bundled `.htaccess` (from [scripts/cpanel.htaccess](file:///c:/Users/jibra/Desktop/1/cloner/scripts/cpanel.htaccess)) sets:

### MIME Types
- `.wasm` → `application/wasm` (required for `WebAssembly.instantiateStreaming` in ONNX Runtime Web)
- `.mjs`, `.js` → `application/javascript` (required for ES module Web Workers and ORT runtime modules)
- `.onnx`, `.onnx_data`, `.bin`, `.npy`, `.model` → `application/octet-stream` (for self-hosted model artifacts)
- `.webmanifest` → `application/manifest+json`

### Asset Caching (`Cache-Control`)
- `index.html`, `sw.js`, `models.json`, `manifest.webmanifest`: `no-cache, must-revalidate` so app updates and manifest changes are picked up promptly.
- `.wasm`, `.mjs`, `.js`, `.css`, `.onnx`, `.onnx_data`, `.bin`, `.npy`, `.model`, `.png`, `.svg`, `.ico`, `.woff2`: `public, max-age=31536000, immutable`.

### Optional COOP / COEP Headers (Commented Out by Default)
In `.htaccess`, Section 4 includes commented lines for Cross-Origin Isolation:

```apache
# Header always set Cross-Origin-Opener-Policy "same-origin"
# Header always set Cross-Origin-Embedder-Policy "credentialless"
```

- **When to leave them commented (Default):** Pocket TTS runs in single-threaded WASM SIMD (`numThreads = 1`) without these headers, and Chatterbox WebGPU does not require them. Leaving them commented gives maximum compatibility across all browsers, including Safari fetching weights from Hugging Face.
- **When to uncomment them:** Only if you want multi-threaded WASM (`SharedArrayBuffer`, `crossOriginIsolated = true`) on desktop Chrome/Edge/Firefox.
- **Why `credentialless` instead of `require-corp`:** Hugging Face CDN responses (`huggingface.co`) do not send `Cross-Origin-Resource-Policy: cross-origin`. Using `require-corp` would block default Hugging Face model downloads; `credentialless` permits no-credential cross-origin `fetch()` calls in Chrome/Edge while enabling `SharedArrayBuffer`.

---

## 5. Self-Hosted Models vs. Pinned Hugging Face Downloads

- **Default (No extra upload):** Leave **Self-Hosted Model Base URL** empty in **Settings** (`#/settings`). Users' browsers download model weights directly from the commit-pinned Hugging Face URLs in `model-manifests/models.json`.
- **Self-Hosted Mirror (`./models/`):** Download and verify weights locally with `scripts/download-models.mjs`, upload `models/` to `public_html/voiceforge/models/`, and set **Self-Hosted Model Base URL** to `./models/` (or `./models/{engineId}/` if using `--layout by-engine`). See [SELF_HOSTED_MODELS.md](file:///c:/Users/jibra/Desktop/1/cloner/docs/SELF_HOSTED_MODELS.md).

---

## 6. Post-Deploy Verification

1. Open `https://your-domain.com/voiceforge/` in Chrome or Edge.
2. Open **DevTools → Network** and confirm `200 OK` (no `404`s or MIME errors) for `runtime/ort-wasm-simd-threaded.mjs` and `model-manifests/models.json`.
3. Open **Model Manager** (`#/models`), download **Pocket TTS** (`146.24 MB`), and run a quick test in **Voice Cloning** (`#/clone`) + **Narration Studio** (`#/studio`).
