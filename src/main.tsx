import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import * as ort from 'onnxruntime-web';
import './index.css';
import App from './App';

// Serve ONNX Runtime Web WASM/MJS assets strictly from local public/runtime/ (zero external CDNs).
ort.env.wasm.wasmPaths = `${import.meta.env.BASE_URL}runtime/`;

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <App />
  </StrictMode>
);
