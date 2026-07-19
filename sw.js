const CACHE_NAME = 'cadcam-v5';
// Percorsi relativi alla posizione di sw.js (es. /ac-ordini/): robusti a un eventuale rename del repo.
const ASSETS = [
  './Configuratore_CAD_CAM_v12.html',
  './portale.html',
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

// ── PUSH: avvisi urgenti agli operatori del carico ─────────────
// La Edge Function `notifica-push` invia un payload JSON { title, body, tag, url, orderId }.
// Notifica PERSISTENTE (requireInteraction) + vibrazione: deve farsi notare anche se
// l'operatore è preso da altro. Stesso `tag` per ordine = una sola notifica che si
// aggiorna a ogni sollecito, ma `renotify` la fa ri-suonare/ri-vibrare.
self.addEventListener('push', event => {
  let d = {};
  try { d = event.data ? event.data.json() : {}; }
  catch (_) { d = { body: (event.data && event.data.text()) || '' }; }

  const title = d.title || '🔴 Ordine urgente';
  const options = {
    body: d.body || 'C\'è un ordine urgente da mandare in produzione.',
    icon: './icon-192.png',
    badge: './favicon-32.png',
    tag: d.tag || 'urgente',
    renotify: true,
    requireInteraction: true,
    vibrate: [300, 120, 300, 120, 300],
    data: { url: d.url || './Admin_Ordini_v2.html', orderId: d.orderId || null },
    actions: [{ action: 'apri', title: 'Apri ordine' }],
  };
  event.waitUntil(self.registration.showNotification(title, options));
});

self.addEventListener('notificationclick', event => {
  event.notification.close();
  const url = (event.notification.data && event.notification.data.url) || './portale.html';
  event.waitUntil(
    self.clients.matchAll({ type: 'window', includeUncontrolled: true }).then(list => {
      // Se l'app (portale operatori o Admin) è già aperta, portala in primo piano
      // invece di aprire un doppione.
      for (const c of list) {
        if ((c.url.includes('portale') || c.url.includes('Admin_Ordini_v2')) && 'focus' in c) return c.focus();
      }
      return self.clients.openWindow(url);
    })
  );
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
