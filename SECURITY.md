# Security Policy — VoiceForge Studio

## Architecture & Threat Model

VoiceForge Studio runs neural speech synthesis and audio processing completely inside the user's browser using WebGPU / WebAssembly (ONNX Runtime Web) and Web Audio APIs.

### Security Principles

1. **Zero External Runtime CDNs**
   - All ONNX Runtime Web WASM and `.mjs` worker artifacts are bundled locally under `public/runtime/` and served from the same origin (`${BASE_URL}runtime/`). No executable scripts or WASM binaries are loaded from external CDNs at runtime.

2. **Pinned Model Integrity**
   - Model manifests pin repository commits/revisions and artifact SHA-256 hashes (where published by upstream LFS metadata) and expected byte sizes so corrupted or unexpected artifacts can be detected before execution.

3. **Local Data Isolation**
   - Voice profiles, conditioning embeddings, scripts, and generated audio remain in local browser storage (IndexedDB / OPFS) and never cross the network.
   - Voice conditioning embeddings are strictly scoped by `engineId` and `modelRevision` so incompatible or mismatched payloads are rejected rather than loaded across model architectures.

4. **Authorized Use & Misuse Prevention**
   - The application records a local `AuthorizedUseConfirmation` timestamp and declaration per voice profile. Note that client-side confirmation is self-attested and not cryptographically or independently verified consent.

5. **Static Hosting Compatibility**
   - Built assets support relative base paths (`./`) and strict static hosting without requiring server-side secrets, API keys, or backend endpoints.

## Reporting a Vulnerability

If you discover a security vulnerability (such as XSS, unsafe storage handling, model manifest verification bypass, or unsafe external network requests), please open a private security advisory or report it directly to the repository maintainers with reproduction steps and impact details before public disclosure.
