// ═══════════════════════════════════════════════════════
// Service Worker — CAD CAM Configuratore
// AbutmentCompatibili.com · Biaggini Medical Devices S.r.l.
// ═══════════════════════════════════════════════════════

const CACHE_NAME = 'cadcam-v1';
const ASSETS = [
  '/ac-ordini/Configuratore_CAD_CAM_v12.html',
  '/ac-ordini/manifest.json',
  '/ac-ordini/icon-192.png',
  '/ac-ordini/icon-512.png',
];

// Installazione — metti in cache le risorse principali
self.addEventListener('install', event => {
  event.waitUntil(
    caches.open(CACHE_NAME).then(cache => cache.addAll(ASSETS))
  );
  self.skipWaiting();
});

// Attivazione — pulisci vecchie cache
self.addEventListener('activate', event => {
  event.waitUntil(
    caches.keys().then(keys =>
      Promise.all(keys.filter(k => k !== CACHE_NAME).map(k => caches.delete(k)))
    )
  );
  self.clients.claim();
});

// Fetch — Network first, fallback su cache
self.addEventListener('fetch', event => {
  // Ignora richieste non-GET e richieste esterne (Supabase, EmailJS, ecc.)
  if (event.request.method !== 'GET') return;
  const url = new URL(event.request.url);
  if (!url.hostname.includes('github.io') && !url.hostname.includes('abutmentcompatibili')) return;

  event.respondWith(
    fetch(event.request)
      .then(response => {
        // Aggiorna la cache con la versione fresca
        const clone = response.clone();
        caches.open(CACHE_NAME).then(cache => cache.put(event.request, clone));
        return response;
      })
      .catch(() => caches.match(event.request))
  );
});
