/**
 * CartCompass — service-worker.js
 * Caches the app shell so it loads offline.
 * API responses are cached in app.js via localStorage (not here).
 */

const CACHE = 'cartcompass-v1';

const SHELL = [
  './',
  './index.html',
  './manifest.json',
  './css/style.css',
  './js/app.js',
  './icons/icon.svg',
  './icons/icon-192.png',
  './icons/icon-512.png',
];

// ── Install: pre-cache the app shell ────────────────────────────────────────
self.addEventListener('install', evt => {
  evt.waitUntil(
    caches.open(CACHE).then(cache => {
      // addAll fails silently for missing files (icons may not exist yet)
      return Promise.allSettled(SHELL.map(url => cache.add(url)));
    }).then(() => self.skipWaiting())
  );
});

// ── Activate: clear old caches ───────────────────────────────────────────────
self.addEventListener('activate', evt => {
  evt.waitUntil(
    caches.keys()
      .then(keys => Promise.all(keys.filter(k => k !== CACHE).map(k => caches.delete(k))))
      .then(() => self.clients.claim())
  );
});

// ── Fetch: cache-first for shell, network-only for external APIs ─────────────
self.addEventListener('fetch', evt => {
  const url = evt.request.url;

  // Let external API calls go straight to network (we cache their data in localStorage)
  if (url.includes('overpass-api.de') || url.includes('cityofnewyork.us')) {
    return; // default browser handling
  }

  // Cache-first for everything else (app shell)
  evt.respondWith(
    caches.match(evt.request).then(cached => cached ?? fetch(evt.request))
  );
});
