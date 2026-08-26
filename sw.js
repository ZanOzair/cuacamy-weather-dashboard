/* =============================================================================
 * CuacaMY — service worker
 * -----------------------------------------------------------------------------
 * The first version of this file was cache-first for the whole app shell. That
 * is the textbook recipe, and it has a trap that bit this project in
 * production: if a deploy ships new HTML/CSS/JS but sw.js itself is unchanged,
 * the browser sees byte-identical worker source, never fires `updatefound`, and
 * keeps serving the cached shell. Visitors sit on a months-old build while the
 * server has the fix, and nothing in the UI tells them.
 *
 * So the strategy here is deliberately different:
 *
 *   App shell (HTML, CSS, JS)   → network-first with a short timeout, falling
 *   back to cache. Online visitors ALWAYS run the deployed build; offline
 *   visitors still get the last one that worked. The shell is small enough
 *   (~300 KB, and mostly 304s) that this costs little.
 *
 *   Icons and the manifest      → cache-first. They effectively never change,
 *   and they are not what goes stale in a way anyone notices.
 *
 *   Weather and hazard APIs     → network-first with a cache fallback, so a
 *   plane-mode user still sees their last readings instead of an error page.
 *
 * BUILD_ID is rewritten by the deploy workflow with the commit SHA, which also
 * guarantees the worker source differs on every deploy — belt as well as
 * braces.
 * =========================================================================== */

const BUILD_ID = 'dev';                 // replaced at deploy time
const VERSION  = 'v1.2.0';
const SHELL_CACHE = `cuacamy-shell-${VERSION}-${BUILD_ID}`;
const DATA_CACHE  = `cuacamy-data-${VERSION}`;

/** Fetched fresh whenever the network answers within SHELL_TIMEOUT_MS. */
const SHELL_ASSETS = ['./', './index.html', './style.css', './app.js'];

/** Immutable enough to serve from cache without a second thought. */
const STATIC_ASSETS = [
  './manifest.webmanifest',
  './assets/favicon.svg',
  './assets/icon-192.png',
  './assets/icon-512.png'
];

const SHELL_TIMEOUT_MS = 4000;

/** Weather and hazard APIs: live data preferred, last good response as backup. */
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

self.addEventListener('install', (event) => {
  event.waitUntil((async () => {
    const cache = await caches.open(SHELL_CACHE);
    // addAll is atomic — one 404 fails the whole install — so each asset is
    // added individually and an optional file cannot block activation.
    await Promise.all([...SHELL_ASSETS, ...STATIC_ASSETS].map((url) =>
      cache.add(new Request(url, { cache: 'reload' })).catch(() => null)
    ));
    // Take over immediately. Combined with clients.claim() below, a visitor
    // never has to close every tab before a fix reaches them.
    await self.skipWaiting();
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
    // Tell every open tab which build is now in charge, so the page can offer
    // a reload rather than silently running half-old code.
    const clients = await self.clients.matchAll({ type: 'window' });
    for (const client of clients) {
      client.postMessage({ type: 'sw-activated', build: BUILD_ID, version: VERSION });
    }
  })());
});

/** The page can ask the worker to step aside or identify itself. */
self.addEventListener('message', (event) => {
  const data = event.data || {};
  if (data.type === 'skip-waiting') self.skipWaiting();
  if (data.type === 'who') {
    event.source?.postMessage({ type: 'sw-identity', build: BUILD_ID, version: VERSION });
  }
  if (data.type === 'purge') {
    event.waitUntil((async () => {
      const keys = await caches.keys();
      await Promise.all(keys.filter((k) => k.startsWith('cuacamy-')).map((k) => caches.delete(k)));
      event.source?.postMessage({ type: 'sw-purged' });
    })());
  }
});

self.addEventListener('fetch', (event) => {
  const { request } = event;

  // Only GET is cacheable, and cross-origin scripts (Firebase, Google Identity)
  // are left entirely to the browser's own HTTP cache.
  if (request.method !== 'GET') return;

  let url;
  try { url = new URL(request.url); } catch { return; }

  if (DATA_HOSTS.includes(url.hostname)) {
    event.respondWith(networkFirst(request, DATA_CACHE, offlineJson));
    return;
  }

  if (url.origin !== self.location.origin) return;

  // A navigation, or one of the three files that make up the running app.
  const path = url.pathname.replace(/\/+$/, '/');
  const isShell = request.mode === 'navigate' ||
                  /\/(index\.html|app\.js|style\.css|config\.js)$/.test(path) ||
                  path.endsWith('/');

  event.respondWith(isShell ? shellNetworkFirst(request) : cacheFirst(request));
});

/**
 * Network first, but never leave the user staring at a blank page: if the
 * network has not answered within SHELL_TIMEOUT_MS, serve the cached copy and
 * let the network response land in the cache for next time.
 */
async function shellNetworkFirst(request) {
  const cache = await caches.open(SHELL_CACHE);

  const network = fetch(request)
    .then((response) => {
      if (response && response.ok) cache.put(request, response.clone()).catch(() => {});
      return response;
    })
    .catch(() => null);

  const timeout = new Promise((resolve) => setTimeout(() => resolve('timeout'), SHELL_TIMEOUT_MS));
  const winner = await Promise.race([network, timeout]);

  if (winner && winner !== 'timeout') return winner;

  const cached = await cache.match(request, { ignoreSearch: false }) ||
                 (request.mode === 'navigate' ? await cache.match('./index.html') : null);
  if (cached) return cached;

  // Nothing cached and the race was only a timeout — the network may still be
  // coming, so wait for it rather than failing early.
  const fresh = await network;
  if (fresh) return fresh;

  return request.mode === 'navigate'
    ? new Response(OFFLINE_PAGE, { status: 503, headers: { 'Content-Type': 'text/html; charset=utf-8' } })
    : new Response('Offline', { status: 503, statusText: 'Offline' });
}

async function cacheFirst(request) {
  const cache = await caches.open(SHELL_CACHE);
  const cached = await cache.match(request);
  if (cached) {
    fetch(request).then((r) => { if (r && r.ok) cache.put(request, r.clone()).catch(() => {}); }).catch(() => {});
    return cached;
  }
  try {
    const response = await fetch(request);
    if (response && response.ok) cache.put(request, response.clone()).catch(() => {});
    return response;
  } catch {
    return new Response('Offline', { status: 503, statusText: 'Offline' });
  }
}

async function networkFirst(request, cacheName, fallback) {
  const cache = await caches.open(cacheName);
  try {
    const response = await fetch(request);
    if (response && response.ok) cache.put(request, response.clone()).catch(() => {});
    return response;
  } catch {
    const cached = await cache.match(request);
    if (cached) return cached;
    return fallback();
  }
}

const offlineJson = () => new Response(
  JSON.stringify({ cod: 503, message: 'Offline and no cached data for this location.' }),
  { status: 503, headers: { 'Content-Type': 'application/json' } }
);

/** Last resort: a first-ever visit that happens to be offline. */
const OFFLINE_PAGE = `<!doctype html><meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>CuacaMY — offline</title>
<style>body{margin:0;min-height:100vh;display:grid;place-items:center;background:#0d1218;color:#e6edf5;
font:16px/1.6 system-ui,-apple-system,"Segoe UI",Roboto,sans-serif;padding:24px;text-align:center}
h1{font-size:1.3rem;margin:0 0 8px}p{margin:0;color:#93a4b8;max-width:34ch}</style>
<h1>CuacaMY is offline</h1>
<p>There is no connection and nothing cached on this device yet. Reconnect and reload to get started.</p>`;
