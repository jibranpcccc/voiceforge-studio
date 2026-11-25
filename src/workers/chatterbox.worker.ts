/**
 * Dedicated Web Worker hosting Engine A: Chatterbox ONNX (`onnxruntime-web`).
 *
 * All model artifact loading, WebGPU shader compilation (300s timeout),
 * voice conditioning (`speech_encoder.onnx`), autoregressive KV-cache decoding
 * (`language_model`), and waveform generation (`conditional_decoder.onnx`)
 * run inside this worker to keep the main UI thread responsive.
 */

/// <reference lib="webworker" />

import {
  ChatterboxCoreEngine,
  type ChatterboxWorkerRequest,
  type ChatterboxWorkerResponse,
} from '../engines/chatterbox/ChatterboxEngine';

const engine = new ChatterboxCoreEngine();

function post(response: ChatterboxWorkerResponse, transfer?: Transferable[]): void {
  if (transfer && transfer.length > 0) {
    self.postMessage(response, transfer);
  } else {
    self.postMessage(response);
  }
}

self.onmessage = async (event: MessageEvent<ChatterboxWorkerRequest>) => {
  const msg = event.data;

  if (msg.type === 'cancel') {
    engine.cancel();
    return;
  }

  try {
    switch (msg.type) {
      case 'initialize': {
        await engine.initialize(msg.options, (progress) => {
          post({ id: msg.id, type: 'progress', progress });
        });
        post({ id: msg.id, type: 'result', result: engine.getModelMetadata() });
        break;
      }

      case 'encodeVoice': {
        const payload = await engine.encodeVoice(msg.audio, msg.metadata);
        const transfers = Object.values(payload.tensors).map((t) => t.data);
        post({ id: msg.id, type: 'result', result: payload }, transfers);
        break;
      }

      case 'loadVoiceProfile': {
        const handle = await engine.loadVoiceProfile(msg.profile);
        post({ id: msg.id, type: 'result', result: handle });
        break;
      }

      case 'synthesize': {
        const result = await engine.synthesize(msg.request, (chunk) => {
          post({ id: msg.id, type: 'chunk', chunk });
        });
        post({ id: msg.id, type: 'result', result }, [result.audio.samples.buffer]);
        break;
      }

      case 'dispose': {
        await engine.dispose();
        post({ id: msg.id, type: 'result', result: undefined });
        break;
      }
    }
  } catch (err) {
    const error =
      err instanceof Error
        ? { name: err.name, message: err.message }
        : { name: 'Error', message: String(err) };
    post({ id: msg.id, type: 'error', error });
  }
};
