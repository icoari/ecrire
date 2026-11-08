const CACHE = 'ecrire-v3';
const ASSETS = [
  './',
  './index.html',
  './styles.css',
  './app.js',
  './bob-sync.js',
  './manifest.json',
  './fonts/fonts.css',
  './fonts/Inter-400-latin.woff2',
  './fonts/Inter-400-latin-ext.woff2',
  './icons/icon.svg',
  './icons/icon-180-v3.png',
  './icons/icon-192-v3.png',
  './icons/icon-512-v3.png',
];

self.addEventListener('install', (e) => {
  // cache:'reload' bypasses the HTTP cache (GitHub Pages max-age=600) so a
  // version bump never precaches stale copies.
  e.waitUntil(
    caches.open(CACHE)
      .then(c => c.addAll(ASSETS.map(a => new Request(a, { cache: 'reload' }))))
      .then(() => self.skipWaiting())
  );
});

self.addEventListener('activate', (e) => {
  e.waitUntil(
    caches.keys()
      .then(keys => Promise.all(keys.filter(k => k !== CACHE).map(k => caches.delete(k))))
      .then(() => self.clients.claim())
  );
});

self.addEventListener('fetch', (e) => {
  const req = e.request;
  if (req.method !== 'GET') return;
  const url = new URL(req.url);
  // Ne jamais intercepter le Worker (sync, LLM, transcription) — réseau pur.
  if (url.hostname.includes('bob.jz7w76ry59.workers.dev')) return;

  const matchOpts = req.mode === 'navigate' ? { ignoreSearch: true } : undefined;
  e.respondWith(
    caches.match(req, matchOpts).then(cached => {
      const fetchPromise = fetch(req).then(resp => {
        if (resp && resp.status === 200 && resp.type === 'basic') {
          const clone = resp.clone();
          caches.open(CACHE).then(c => c.put(req, clone));
        }
        return resp;
      }).catch(() => cached);
      return cached || fetchPromise;
    })
  );
});
