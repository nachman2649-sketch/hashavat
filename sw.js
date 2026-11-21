// Service worker: app works offline after first open; map tiles you've seen are kept.
const APP = 'hashavat-app-v3';
const TILES = 'hashavat-tiles-v1';
const SHELL = ['./', 'index.html', 'app.js', 'style.css', 'manifest.webmanifest', 'icon-192.png', 'icon-512.png',
  'https://cdnjs.cloudflare.com/ajax/libs/leaflet/1.9.4/leaflet.min.js',
  'https://cdnjs.cloudflare.com/ajax/libs/leaflet/1.9.4/leaflet.min.css'];

self.addEventListener('install', e => {
  e.waitUntil(caches.open(APP).then(c => Promise.all(SHELL.map(u => c.add(u).catch(() => {})))).then(() => self.skipWaiting()));
});
self.addEventListener('activate', e => {
  e.waitUntil(caches.keys().then(ks => Promise.all(ks.filter(k => k !== APP && k !== TILES).map(k => caches.delete(k)))).then(() => self.clients.claim()));
});

let tileCount = 0;
async function trimTiles() {
  const c = await caches.open(TILES); const ks = await c.keys();
  if (ks.length > 3000) for (const k of ks.slice(0, ks.length - 3000)) await c.delete(k);
}

self.addEventListener('fetch', e => {
  const req = e.request;
  if (req.method !== 'GET') return;            // street/POI queries go straight to the network
  const url = new URL(req.url);
  if (url.hostname.endsWith('tile.openstreetmap.org')) {
    // network first, fall back to a saved tile
    e.respondWith(fetch(req).then(r => {
      if (r.ok) { const cp = r.clone(); caches.open(TILES).then(c => c.put(req, cp)); if (++tileCount % 200 === 0) trimTiles(); }
      return r;
    }).catch(() => caches.match(req)));
    return;
  }
  // app files: network first (so updates arrive), cache fallback when offline
  e.respondWith(fetch(req).then(r => {
    if (r.ok && (url.origin === location.origin || url.hostname === 'cdnjs.cloudflare.com')) { const cp = r.clone(); caches.open(APP).then(c => c.put(req, cp)); }
    return r;
  }).catch(() => caches.match(req).then(m => m || caches.match('index.html'))));
});
