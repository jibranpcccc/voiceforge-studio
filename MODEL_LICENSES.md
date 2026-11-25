# Model & Third-Party Software Licenses — VoiceForge Studio

VoiceForge Studio application source code is licensed under the **MIT License** (see [LICENSE](file:///c:/Users/jibra/Desktop/1/cloner/LICENSE)). Downloaded AI model weights, upstream reference implementations, and bundled third-party packages remain subject to their respective licenses below.

---

## 1. Integrated AI Models & Upstream Sources

### 1.1 Pocket TTS (`pocket-tts` — Default Engine C)
- **Model Repository:** `KevinAHM/pocket-tts-onnx` (pinned revision `58a6d00cf13d239b6748cb0769f35c580a8f606c`, ungated)
- **Model Weights License:** **Creative Commons Attribution 4.0 International (`CC-BY-4.0`)** + **Kyutai Prohibited Use Notice**
  - Requires attribution to Kyutai Labs (`kyutai/pocket-tts`) and compliance with Kyutai's prohibited-use restrictions (including prohibitions on unauthorized voice impersonation, fraud/deception, and unlawful/harmful synthetic media).
  - Reference: `https://huggingface.co/KevinAHM/pocket-tts-onnx/blob/58a6d00cf13d239b6748cb0769f35c580a8f606c/README.md` and `https://huggingface.co/kyutai/pocket-tts`.
- **ONNX Export & Wrapper Scripts (`KevinAHM/pocket-tts-onnx`, `KevinAHM/pocket-tts-web`):** **Apache-2.0**
- **Upstream PyTorch/Rust Reference (`kyutai-labs/pocket-tts` @ `bc4d640c925a3782092a841e9bc7ba442a65a838`):** **MIT**
- **Browser Reference Demo (`hemanth/pocket-voice` @ `a4496c429f1dcd6ea8faef55a21dc4b7d45636a9`):** **MIT**

### 1.2 Chatterbox ONNX (`chatterbox` — Optional WebGPU Engine A)
- **Model Repository:** `onnx-community/chatterbox-ONNX` (pinned revision `3cab09af388d3f02bba43443fce88c1f4525ac43`, ungated)
- **Model Weights & Config License:** **MIT**
  - Reference: `https://huggingface.co/onnx-community/chatterbox-ONNX/blob/3cab09af388d3f02bba43443fce88c1f4525ac43/README.md`
- **Upstream Model & Code (`resemble-ai/chatterbox` @ `ab55923c27757c90cfcc407baa57dc25a7d25217`):** **MIT** (Copyright (c) 2025 Resemble AI)

---

## 2. Evaluated / Documented Models (Not Bundled)

| Candidate | Repository | License | Status in VoiceForge Studio |
|---|---|---|---|
| Chatterbox Turbo ONNX | `ResembleAI/chatterbox-turbo-ONNX` (`d21799bd0354adb85e348b8a0442a8405110a2cf`) | **MIT** | WebGPU `GatherBlockQuantized` probe verified; documented only |
| VoxShot (architecture reference) | `m96-chan/voxshot` (`b6abd46a724b381fb787aac534d3f59936644d7b`) | **MIT** | Engineering patterns adopted; no code copied verbatim |
| Qwen3-TTS | `QwenLM/Qwen3-TTS` (`022e286b98fbec7e1e916cb940cdf532cd9f488e`) | **Apache-2.0** | Excluded (NO-GO for browser zero-shot cloning) |
| MOSS-TTS-Nano & Audio Tokenizer | `OpenMOSS-Team/MOSS-TTS-Nano-100M-ONNX` / `MOSS-Audio-Tokenizer-Nano-ONNX` | **Apache-2.0** | Watched experimental candidate |

---

## 3. Application & Third-Party Runtime Packages

All versions and licenses below are verified against `package.json` and `package-lock.json`.

### 3.1 Production Runtime Dependencies

| Package | Version | License | Role |
|---|---|---|---|
| `onnxruntime-web` | `1.31.1` | **MIT** | Client-side WASM & WebGPU ONNX inference runtime (WASM/MJS bundled under `public/runtime/`) |
| `@breezystack/lamejs` | `1.2.7` | **LGPL-3.0** | Client-side MP3 audio encoding in `src/audio/exporter.ts` |
| `fflate` | `0.8.3` | **MIT** | Client-side ZIP archive creation for multi-segment narration export |
| `idb` | `8.0.4` | **ISC** | Typed IndexedDB persistence (`voiceforge-db`) |
| `lucide-react` | `1.80.0` | **ISC** | UI iconography |
| `react` / `react-dom` | `19.3.1` | **MIT** | UI rendering runtime |
| `zustand` | `5.1.0` | **MIT** | Client-side application state management |

> **LGPL-3.0 Notice (`@breezystack/lamejs`):** `@breezystack/lamejs` is licensed under the GNU Lesser General Public License v3.0 (`LGPL-3.0`). When redistributing compiled builds of VoiceForge Studio, retain the `@breezystack/lamejs` license notice and ensure recipients can replace or relink the MP3 encoder dependency in accordance with LGPL-3.0 (or keep source available alongside the MIT repository).

### 3.2 Development, Build & Test Dependencies

| Package | Version | License | Role |
|---|---|---|---|
| `typescript` | `5.9.3` | **Apache-2.0** | Type checking (`tsc --noEmit`) |
| `@playwright/test` | `1.65.1` | **Apache-2.0** | Real-browser Chrome & Edge E2E & PoC verification |
| `fake-indexeddb` | `6.2.8` | **Apache-2.0** | In-memory IndexedDB test shim for Vitest |
| `vite` / `@vitejs/plugin-react` | `6.3.0` (`@vitejs/plugin-react`) | **MIT** | Static production bundler |
| `vitest` | `5.1.1` | **MIT** | Unit test runner |
| `tailwindcss` / `@tailwindcss/vite` | `4.3.5` | **MIT** | Utility CSS framework |
| `eslint` / `typescript-eslint` | `10.15.0` / `8.74.0` | **MIT** | Static linting |
| `jsdom` | `31.0.1` | **MIT** | DOM test environment |
| `globals` | `17.14.0` | **MIT** | ESLint global definitions |
| `@types/node`, `@types/react`, `@types/react-dom` | `26.6.10`, `19.3.2`, `19.3.0` | **MIT** | TypeScript declarations |

---

## 4. User-Supplied Reference Audio & Voice Cloning Notice

VoiceForge Studio performs 100% local voice conditioning and synthesis in the browser and stores a self-attested `AuthorizedUseConfirmation` record per voice profile. Users are solely responsible for obtaining explicit authorization before cloning any voice and for complying with applicable laws and model-specific terms (including Kyutai's Prohibited Use notice for Pocket TTS).
