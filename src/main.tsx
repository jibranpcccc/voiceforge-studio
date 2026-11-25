import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import * as ort from 'onnxruntime-web';
import './index.css';
import App from './App';

// Serve ONNX Runtime Web WASM/MJS assets strictly from local public/runtime/ (zero external CDNs).
const rawBase = import.meta.env.BASE_URL || './';
const normalizedBase = rawBase.endsWith('/') ? rawBase : `${rawBase}/`;
ort.env.wasm.wasmPaths = `${normalizedBase}runtime/`;

// Register Service Worker relative to BASE_URL for PWA & offline app-shell caching in production builds.
if (import.meta.env.PROD && typeof window !== 'undefined' && 'serviceWorker' in navigator) {
  window.addEventListener('load', () => {
    navigator.serviceWorker
      .register(`${normalizedBase}sw.js`, { scope: normalizedBase })
      .catch(() => {
        // Ignore SW registration failure in restricted environments (e.g. file:// or private mode).
      });
  });
}

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <App />
  </StrictMode>
);
