/* =============================================================================
 * CuacaMY — service worker
 * -----------------------------------------------------------------------------
 * Two caching strategies, chosen by what is being requested:
 *
 *   App shell (HTML, CSS, JS, icons)  → cache-first, refreshed in the
 *   background. The UI therefore paints instantly on repeat visits and works
 *   with no connection at all.
 *
 *   OpenWeatherMap responses          → network-first with a cache fallback.
 *   Live data is always preferred, but a plane-mode user still sees the last
 *   readings instead of an error page.
 * =========================================================================== */

const VERSION = 'v1.1.0';
const SHELL_CACHE = `cuacamy-shell-${VERSION}`;
const DATA_CACHE  = `cuacamy-data-${VERSION}`;

const SHELL_ASSETS = [
  './',
  './index.html',
  './style.css',
  './app.js',
  './manifest.webmanifest',
  './assets/favicon.svg',
  './assets/icon-192.png',
  './assets/icon-512.png'
];

self.addEventListener('install', (event) => {
  event.waitUntil((async () => {
    const cache = await caches.open(SHELL_CACHE);
    // addAll is atomic — one 404 fails the whole install — so each asset is
    // added individually and optional files cannot block activation.
    await Promise.all(SHELL_ASSETS.map((url) =>
      cache.add(new Request(url, { cache: 'reload' })).catch(() => null)
    ));
    self.skipWaiting();
  })());
});

self.addEventListener('activate', (event) => {
  event.waitUntil((async () => {
    const keys = await caches.keys();
    await Promise.all(
      keys.filter((k) => k.startsWith('cuacamy-') && k !== SHELL_CACHE && k !== DATA_CACHE)
          .map((k) => caches.delete(k))
    );
    await self.clients.claim();
  })());
});

self.addEventListener('fetch', (event) => {
  const { request } = event;

  // Only GET requests are cacheable, and cross-origin scripts (Firebase) are
  // left entirely to the browser's own HTTP cache.
  if (request.method !== 'GET') return;

  const url = new URL(request.url);

  // Weather and hazard APIs: prefer the network, fall back to the last good
  // response so an offline user still sees their most recent readings.
  const DATA_HOSTS = [
    'api.openweathermap.org',
    'api.open-meteo.com',
    'air-quality-api.open-meteo.com',
    'geocoding-api.open-meteo.com',
    'flood-api.open-meteo.com',
    'archive-api.open-meteo.com',
    'earthquake.usgs.gov',
    'api.bigdatacloud.net'
  ];
  if (DATA_HOSTS.includes(url.hostname)) {
    event.respondWith(networkFirst(request));
    return;
  }

  if (url.origin === self.location.origin) {
    event.respondWith(cacheFirst(request));
  }
});

async function cacheFirst(request) {
  const cache = await caches.open(SHELL_CACHE);
  const cached = await cache.match(request, { ignoreSearch: false });

  const network = fetch(request)
    .then((response) => {
      if (response && response.ok) cache.put(request, response.clone());
      return response;
    })
    .catch(() => null);

  if (cached) return cached;                 // instant paint, refresh behind it

  const fresh = await network;
  if (fresh) return fresh;

  // Offline and uncached: for a navigation, fall back to the app shell so the
  // user gets the dashboard rather than the browser's dinosaur.
  if (request.mode === 'navigate') {
    const shell = await cache.match('./index.html');
    if (shell) return shell;
  }
  return new Response('Offline', { status: 503, statusText: 'Offline' });
}

async function networkFirst(request) {
  const cache = await caches.open(DATA_CACHE);
  try {
    const response = await fetch(request);
    if (response && response.ok) cache.put(request, response.clone());
    return response;
  } catch {
    const cached = await cache.match(request);
    if (cached) return cached;
    return new Response(
      JSON.stringify({ cod: 503, message: 'Offline and no cached data for this location.' }),
      { status: 503, headers: { 'Content-Type': 'application/json' } }
    );
  }
}
