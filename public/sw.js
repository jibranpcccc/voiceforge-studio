const SHELL_CACHE_NAME = 'voiceforge-shell-v1';
const MODEL_CACHE_NAME = 'voiceforge-models-v1';

const PRECACHE_RELATIVE_URLS = [
  './',
  './index.html',
  './manifest.webmanifest',
  './icons/icon.svg',
  './icons/icon-maskable.svg',
  './icons/icon-192.png',
  './icons/icon-512.png',
  './model-manifests/models.json',
  './runtime/ort-wasm-simd-threaded.mjs',
  './runtime/ort-wasm-simd-threaded.wasm',
  './runtime/ort-wasm-simd-threaded.jsep.mjs',
  './runtime/ort-wasm-simd-threaded.jsep.wasm',
  './runtime/ort-wasm-simd-threaded.asyncify.mjs',
  './runtime/ort-wasm-simd-threaded.asyncify.wasm',
  './runtime/ort-wasm-simd-threaded.jspi.mjs',
  './runtime/ort-wasm-simd-threaded.jspi.wasm',
];

function resolveScopedUrl(relPath) {
  return new URL(relPath, self.registration.scope).href;
}

function extractBuiltAssetUrls(htmlText) {
  const urls = new Set();
  const regex = /(?:href|src)=["'](\.?\/?assets\/[^"']+\.(?:js|css))["']/g;
  let match;
  while ((match = regex.exec(htmlText)) !== null) {
    const raw = match[1];
    const normalized = raw.startsWith('./')
      ? raw
      : raw.startsWith('/')
        ? `.${raw}`
        : `./${raw}`;
    urls.add(normalized);
  }
  return Array.from(urls);
}

self.addEventListener('install', (event) => {
  event.waitUntil(
    (async () => {
      const cache = await caches.open(SHELL_CACHE_NAME);
      const discoveredAssets = new Set();

      // Fetch index.html first so we can discover and precache hashed Vite JS/CSS bundles immediately.
      try {
        const indexUrl = resolveScopedUrl('./index.html');
        const indexResp = await fetch(indexUrl, { cache: 'no-cache' });
        if (indexResp.ok) {
          const htmlText = await indexResp.clone().text();
          await cache.put(indexUrl, indexResp);
          for (const assetRel of extractBuiltAssetUrls(htmlText)) {
            discoveredAssets.add(assetRel);
          }
        }
      } catch {
        // Ignore if index fetch fails during install; remaining assets still attempted.
      }

      const targets = Array.from(new Set([...PRECACHE_RELATIVE_URLS, ...discoveredAssets]));
      await Promise.allSettled(
        targets.map(async (rel) => {
          if (rel === './index.html') return;
          const url = resolveScopedUrl(rel);
          const response = await fetch(url, { cache: 'no-cache' });
          if (response.ok) {
            await cache.put(url, response);
          }
        })
      );
      await self.skipWaiting();
    })()
  );
});

self.addEventListener('activate', (event) => {
  event.waitUntil(
    (async () => {
      const keys = await caches.keys();
      await Promise.all(
        keys
          .filter((key) => key.startsWith('voiceforge-shell-') && key !== SHELL_CACHE_NAME && key !== MODEL_CACHE_NAME)
          .map((key) => caches.delete(key))
      );
      await self.clients.claim();
    })()
  );
});

function isStaticShellAsset(pathname, scopePath) {
  const rel = pathname.startsWith(scopePath) ? pathname.slice(scopePath.length) : pathname;
  return (
    rel.startsWith('assets/') ||
    rel.startsWith('runtime/ort-wasm') ||
    rel.startsWith('icons/') ||
    rel === 'manifest.webmanifest'
  );
}

function isManifestRequest(pathname, scopePath) {
  const rel = pathname.startsWith(scopePath) ? pathname.slice(scopePath.length) : pathname;
  return rel === 'model-manifests/models.json';
}

self.addEventListener('fetch', (event) => {
  const { request } = event;

  // Never interfere with non-GET requests or Range/streaming downloads.
  if (request.method !== 'GET') return;
  if (request.headers.has('range')) return;

  const url = new URL(request.url);
  const scopeUrl = new URL(self.registration.scope);

  // Never intercept cross-origin requests (e.g. Hugging Face model downloads).
  if (url.origin !== scopeUrl.origin) return;

  // Never intercept self-hosted large model weight downloads (if hosted under ./models/).
  const relPath = url.pathname.startsWith(scopeUrl.pathname)
    ? url.pathname.slice(scopeUrl.pathname.length)
    : url.pathname;
  if (relPath.startsWith('models/')) return;

  if (request.mode === 'navigate') {
    event.respondWith(
      (async () => {
        const cache = await caches.open(SHELL_CACHE_NAME);
        try {
          const networkResponse = await fetch(request);
          if (networkResponse && networkResponse.ok) {
            await cache.put(resolveScopedUrl('./index.html'), networkResponse.clone());
          }
          return networkResponse;
        } catch {
          const cachedIndex =
            (await cache.match(resolveScopedUrl('./index.html'))) ||
            (await cache.match(resolveScopedUrl('./')));
          if (cachedIndex) return cachedIndex;
          throw new Error('Offline and app shell index is not cached.');
        }
      })()
    );
    return;
  }

  if (isManifestRequest(url.pathname, scopeUrl.pathname)) {
    // Stale-while-revalidate for pinned model manifest
    event.respondWith(
      (async () => {
        const cache = await caches.open(SHELL_CACHE_NAME);
        const cached = (await cache.match(request.url)) || (await cache.match(request));
        const fetchPromise = fetch(request)
          .then((response) => {
            if (response && response.ok) {
              cache.put(request.url, response.clone());
            }
            return response;
          })
          .catch(() => null);

        if (cached) {
          event.waitUntil(fetchPromise);
          return cached;
        }
        const networkResponse = await fetchPromise;
        if (networkResponse) return networkResponse;
        return new Response('Offline', { status: 503, statusText: 'Offline' });
      })()
    );
    return;
  }

  if (isStaticShellAsset(url.pathname, scopeUrl.pathname)) {
    // Cache-first for hashed JS/CSS assets, local ONNX WASM runtime files, and icons
    event.respondWith(
      (async () => {
        const cache = await caches.open(SHELL_CACHE_NAME);
        const cached = (await cache.match(request.url)) || (await cache.match(request));
        if (cached) return cached;
        const response = await fetch(request);
        if (response && response.ok) {
          await cache.put(request.url, response.clone());
        }
        return response;
      })()
    );
  }
});
