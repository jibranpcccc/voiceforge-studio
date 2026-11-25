# VoiceForge Studio — Real-Browser AI Voice Cloning PoC & Benchmark Results

**Test Date:** 2026-11-25  
**Harness Route:** `#/poc` (`src/pages/PocHarness.tsx`, mounted in `src/App.tsx`)  
**Playwright Spec:** `tests/e2e/inference-poc.spec.ts`  
**Raw Telemetry:** `test-results/poc-telemetry.json`  
**Reference Audio Fixture:** `default_voice.wav` from `onnx-community/chatterbox-ONNX` (`3cab09af388d3f02bba43443fce88c1f4525ac43`, MIT, `714,320` B, SHA-256 `3ebc531cdaba358a327099c1c4f0448026719957bcf4d8e9868767f227e02f4e`, saved locally to `test-results/fixtures/default_voice.wav` during test setup)  
**Evaluation Prompt:** `"Hello from VoiceForge Studio. This is a real local browser voice cloning test."` (`seed: 42`)

---

## 1. Test Machine & Browser Hardware Profile

Both Google Chrome (`channel: 'chrome'`) and Microsoft Edge (`channel: 'msedge'`) were launched via Playwright against the Vite production preview server (`http://127.0.0.1:4173/#/poc`).

| Property | Measured Value (Chrome & Edge) |
|---|---|
| User Agent | `Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/159.0.8154.6 Safari/537.36` |
| WebGPU (`navigator.gpu`) | Supported (`webgpuAdapterAvailable: true`) |
| WebGPU Adapter | `vendor: "intel"`, `architecture: "gen-12lp"` (Intel Iris Xe), `isFallbackAdapter: false` |
| WebGPU `shader-f16` | `true` |
| WebGPU `maxBufferSize` | `2,147,483,648` B (`2.0 GiB`) |
| WebAssembly + SIMD128 | `wasmSupported: true`, `wasmSimdSupported: true` |
| `crossOriginIsolated` / `SharedArrayBuffer` | `false` / `false` (`recommendedWasmThreads: 1`) |
| `navigator.hardwareConcurrency` | `16` |
| `navigator.deviceMemory` | `32` GB (`32,768` MB) |
| `navigator.storage.estimate().quota` | `10,737,418,240` B (`10.0 GiB`) |
| Recommended Execution Mode | `quality` (for Chatterbox WebGPU) / `cpu` (for Pocket TTS WASM) |

---

## 2. Engine C: Pocket TTS (`pocket-tts`) — Full End-to-End Verification

- **Model:** `KevinAHM/pocket-tts-onnx` @ `58a6d00cf13d239b6748cb0769f35c580a8f606c` (`CC-BY-4.0`, ungated, `146,243,590` B across 8 files)
- **Backend:** ONNX Runtime Web WASM SIMD (`numThreads = 1` without COOP/COEP headers), running inside `src/workers/pocket.worker.ts`
- **Conditioning:** Real zero-shot encoding of `default_voice.wav` via `mimi_encoder_int8.onnx` + `flow_lm_main_int8.onnx` (`tensors`: `state_0`..`state_17` + `voice_latents`)
- **Parameters:** `seed = 42`, `temperature = 0.7`, `lsdSteps = 1`
- **Artifacts Saved:** `test-results/poc-pocket.wav`, `test-results/poc-pocket-chrome.wav`, `test-results/poc-pocket-msedge.wav` (`203,564` B each, 24 kHz mono 16-bit PCM WAV)

| Metric | Google Chrome (`chrome`) | Microsoft Edge (`msedge`) |
|---|---:|---:|
| Status | **PASS** | **PASS** |
| Cold Init Time (146 MB HF download + SHA-256 + 5 ORT sessions) | `28,826.6 ms` (`28.8 s`) | `16,152.6 ms` (`16.2 s`) |
| Voice Encode Time (`encodeVoice`) | `6,271.7 ms` (`6.3 s`) | `3,955.3 ms` (`4.0 s`) |
| Voice Profile Load (`loadVoiceProfile`) | `21.8 ms` | `21.7 ms` |
| First-Chunk Latency (Time-to-First-Audio) | `586.7 ms` | `643.6 ms` |
| Total Synthesis Time | `6,210.6 ms` (`6.21 s`) | `6,652.3 ms` (`6.65 s`) |
| Synthesized Audio Duration | `4.24 s` (`101,760` samples @ `24,000 Hz`) | `4.24 s` (`101,760` samples @ `24,000 Hz`) |
| Real-Time Factor (RTF = gen / audio) | `1.46x` (`1.464`) | `1.57x` (`1.568`) |
| Streamed Chunks | `6` | `6` |
| Waveform RMS (Float32 / WAV16) | `0.1845` (`0.18452` / `0.18452`) | `0.1845` (`0.18452` / `0.18452`) |
| Waveform Peak | `0.9707` | `0.9707` |
| Non-Finite Samples (`NaN` / `Infinity`) | `0` | `0` |
| `window.speechSynthesis.speak` Calls | `0` | `0` |
| Console Errors / Page Errors / HTTP Errors | `0` / `0` / `0` | `0` / `0` / `0` |

**Result:** **VERIFIED GO.** Pocket TTS delivers sub-second first-chunk latency (`587–644 ms`), deterministic seeded synthesis across Chrome and Edge, clean finite 24 kHz PCM (`RMS = 0.1845`, `Peak = 0.9707`), and zero browser errors on single-threaded WASM without COOP/COEP headers.

---

## 3. Engine B Probe: Chatterbox Turbo (`ResembleAI/chatterbox-turbo-ONNX`) on WebGPU

- **Model Probe:** `onnx/embed_tokens_q4f16.onnx` (`2,548` B, SHA-256 `e5c9507c89e770e35d68bdd669e4ae44b34272232e84f010f2c97959feae79b3`) + `onnx/embed_tokens_q4f16.onnx_data` (`33,648,688` B, SHA-256 `37e96447b5f3ef46f46fb35cc599cfcb95b277e5528cc0c89bab78169da620ef`) pinned at commit `d21799bd0354adb85e348b8a0442a8405110a2cf` (MIT)
- **Purpose:** Verify empirically whether `onnxruntime-web@1.31.1` WebGPU EP supports `com.microsoft:GatherBlockQuantized` on real Intel Iris Xe (`gen-12lp`) in Chrome and Edge.
- **Test Input:** `input_ids = int64[1, 4]` (`[1, 2, 3, 4]`)

| Metric | Google Chrome (`chrome`) | Microsoft Edge (`msedge`) |
|---|---:|---:|
| Status | **PASS** | **PASS** |
| Download + SHA-256 Verify (`33.65 MB`) | `1,891.6 ms` | `2,230.4 ms` |
| WebGPU `InferenceSession.create` | `1,003.2 ms` | `1,775.0 ms` |
| Forward Pass (`session.run` + `getData`) | `70.8 ms` | `306.1 ms` |
| Output Shape | `[1, 4, 1024]` | `[1, 4, 1024]` |
| Non-Finite Elements | `0` | `0` |
| Output RMS / Peak | `0.4617` / `2.2891` | `0.4617` / `2.2891` |
| ORT Console Notes | 2x benign `[W:onnxruntime:] VerifyEachNodeIsAssignedToAnEp` (shape ops kept on CPU) | 2x benign `[W:onnxruntime:] VerifyEachNodeIsAssignedToAnEp` (shape ops kept on CPU) |

**Result:** **CONFIRMED.** `com.microsoft:GatherBlockQuantized` executes cleanly on `onnxruntime-web@1.31.1` WebGPU EP in both Chrome and Edge on Intel Iris Xe (`shader-f16`). Note that Engine B still has **zero WASM fallback** for quantized graphs (documented in `docs/research/chatterbox-and-others.md`) and requires WebGPU-only gating if added in a future phase.

---

## 4. Engine A: Chatterbox ONNX (`chatterbox`) — Hardware & Real-Browser Download Check

- **Model:** `onnx-community/chatterbox-ONNX` @ `3cab09af388d3f02bba43443fce88c1f4525ac43` (MIT, `q4f16`, `1,499,431,645` B / `1.50 GB` across 13 files)
- **Compatibility Check (`checkHardwareCompatibility()`):** Passed in both Chrome and Edge (`compatible: true`, `recommendedBackend: 'webgpu'`, `recommendedExecutionMode: 'quality'`, `shaderF16Supported: true`).
- **Live E2E Outcome in Fresh Ephemeral Playwright Contexts:**
  - **Chrome:** Downloaded and SHA-256-verified `1,454,179,627` / `1,499,431,645` B (`96.98%` — completed `speech_encoder`, `embed_tokens`, `conditional_decoder`, and reached `97%` of `language_model_q4f16.onnx_data`) before reaching the `360,000 ms` PoC download abort limit (`AbortError: signal is aborted without reason`).
  - **Edge:** Downloaded `419,361,429` / `1,499,431,645` B (`27.97%` of `speech_encoder.onnx_data`) before the HuggingFace CDN stream dropped with `TypeError: network error`.
  - **Console / Page Errors:** `0` app/worker page errors (only browser default `/favicon.ico` 404).

### Empirical Findings & Recommendations
1. **Keep `pocket-tts` (`146 MB`) as the default primary engine:** It initializes in `16–29 s` from a cold cache, clones reference voices in `4–6 s`, streams first audio in `< 650 ms`, and works reliably without WebGPU or COOP/COEP headers.
2. **Large-bundle resilience for `chatterbox` (`1.50 GB`):** Because `modelCache.ts` currently performs single-shot `fetch()` per `~591 MB` external data file without automatic retries or HTTP `Range` resumption, transient HuggingFace CDN drops (`TypeError: network error`) interrupt multi-hundred-megabyte downloads in fresh caches. Adding per-artifact retry/backoff (or self-hosted mirror URLs / local model import) improves reliability for 1.5 GB downloads.
3. **Chatterbox WebGPU shader compile & inference on Intel Iris Xe (`2.0 GiB` `maxBufferSize`):** Because the 360 s test budget was consumed during the `1.50 GB` cold download in ephemeral Playwright contexts, full 4-session WebGPU shader compilation and inference latency for `chatterbox` were not reached in this automated run and remain marked unmeasured (`N/A`) rather than extrapolated.
