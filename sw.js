const CACHE_NAME = 'cadcam-v3';
// Percorsi relativi alla posizione di sw.js (es. /ac-ordini/): robusti a un eventuale rename del repo.
const ASSETS = [
  './Configuratore_CAD_CAM_v12.html',
  './manifest.json',
  './icon-192.png',
  './icon-512.png',
  './favicon-16.png',
  './favicon-32.png',
  './apple-touch-icon.png',
];

self.addEventListener('install', event => {
  event.waitUntil(
    caches.open(CACHE_NAME).then(cache => cache.addAll(ASSETS))
  );
  self.skipWaiting();
});

self.addEventListener('activate', event => {
  event.waitUntil(
    caches.keys().then(keys =>
      Promise.all(keys.filter(k => k !== CACHE_NAME).map(k => caches.delete(k)))
    )
  );
  self.clients.claim();
});

self.addEventListener('fetch', event => {
  if (event.request.method !== 'GET') return;
  const url = new URL(event.request.url);
  // Intercetta solo le risorse della PWA stessa: copre github.io oggi, un dominio custom domani
  // e localhost in sviluppo, senza toccare richieste ad altre origini.
  if (url.origin !== self.location.origin) return;

  event.respondWith(
    fetch(event.request)
      .then(response => {
        // Cachea solo risposte valide: un 404/5xx transitorio non deve sovrascrivere la copia buona.
        if (response.ok) {
          const clone = response.clone();
          caches.open(CACHE_NAME).then(cache => cache.put(event.request, clone));
        }
        return response;
      })
      .catch(() => caches.match(event.request))
  );
});
