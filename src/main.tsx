import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import * as ort from 'onnxruntime-web';
import './index.css';
import App from './App';

// Serve ONNX Runtime Web WASM/MJS assets strictly from local public/runtime/ (zero external CDNs).
const rawBase = import.meta.env.BASE_URL || './';
const normalizedBase = rawBase.endsWith('/') ? rawBase : `${rawBase}/`;
ort.env.wasm.wasmPaths = `${normalizedBase}runtime/`;

const COI_RELOAD_FLAG = 'vf_coi_reloaded';

// Register Service Worker relative to BASE_URL for PWA offline caching and COOP/COEP isolation.
if (import.meta.env.PROD && typeof window !== 'undefined' && 'serviceWorker' in navigator) {
  if (window.crossOriginIsolated) {
    try {
      sessionStorage.removeItem(COI_RELOAD_FLAG);
    } catch {
      // Ignore sessionStorage restrictions.
    }
  } else {
    let reloadingForCoi = false;
    navigator.serviceWorker.addEventListener('controllerchange', () => {
      if (reloadingForCoi || window.crossOriginIsolated) return;
      try {
        if (sessionStorage.getItem(COI_RELOAD_FLAG) === '1') return;
        sessionStorage.setItem(COI_RELOAD_FLAG, '1');
      } catch {
        // Proceed with single reload attempt if sessionStorage unavailable.
      }
      reloadingForCoi = true;
      window.location.reload();
    });
  }

  navigator.serviceWorker
    .register(`${normalizedBase}sw.js`, { scope: normalizedBase })
    .then((reg) => {
      void reg.update().catch(() => undefined);
    })
    .catch(() => {
      // Ignore SW registration failure in restricted environments (e.g. file:// or private mode).
    });
}

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <App />
  </StrictMode>
);
