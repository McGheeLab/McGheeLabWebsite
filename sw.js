/* ================================================================
   Service Worker — McGheeLab PWA
   ================================================================
   Caching strategies:
   - Shell + App files: precache on install, stale-while-revalidate
   - Images/icons:      cache-first (runtime)
   - CDN (Firebase SDK): network-first, fall back to cache
   - Firebase API calls: network-only (never cached)
   ================================================================ */

const CACHE_VERSION = 879;
const SHELL_CACHE  = `mcgheelab-shell-v${CACHE_VERSION}`;
const IMAGE_CACHE  = `mcgheelab-images-v${CACHE_VERSION}`;
const CDN_CACHE    = `mcgheelab-cdn-v${CACHE_VERSION}`;

const ALL_CACHES = [SHELL_CACHE, IMAGE_CACHE, CDN_CACHE];

/* ---------- URLs to precache on install ---------- */

const SHELL_URLS = [
  '/',
  '/index.html',
  '/app.js',
  '/styles.css',
  '/whiteboard-board.css',
  '/user-styles.css',
  '/cv-styles.css',
  '/firebase-config.js',
  '/user-system.js',
  '/cv-builder.js',
  '/scheduler.js',
  '/class-builder.js',
  '/whiteboard.js',
  '/whiteboard-replay.js',
  '/modules/shared/whiteboard-panel.js',
  '/modules/shared/whiteboard-panel.css',
  '/teacher-classes.js',
  '/teacher-teach.js',
  '/engage-hub.js',
  '/engage-presenters.js',
  '/engage-guest.js',
  '/push-notifications.js',
  '/content.json',
  '/manifest.json',
  '/icons/icon-192.png',
  '/icons/icon-512.png',
  '/icons/apple-touch-icon.png',
  '/icons/favicon-32.png'
];

/* APPS_CACHE retired in V3.53 alongside the deletion of /apps/. The
 * registry-cache pair was added in V3.40 to make iframe loads of
 * /apps/<name>/ fast; with /apps/ deleted in V3.53 there's nothing
 * left to cache under that key. /lab-apps.js dropped from SHELL_URLS
 * for the same reason (file preserved in repo for the split-view
 * harness reference, but not loaded by index.html anymore). */

/* ---------- Install: precache shell ---------- */

self.addEventListener('install', (event) => {
  event.waitUntil(
    caches.open(SHELL_CACHE).then(cache => cache.addAll(SHELL_URLS))
  );
  self.skipWaiting();
});

/* ---------- Message: allow pages to trigger skipWaiting ---------- */

self.addEventListener('message', (event) => {
  if (event.data?.type === 'SKIP_WAITING') {
    self.skipWaiting();
  }
});

/* ---------- Activate: clean old caches ---------- */

self.addEventListener('activate', (event) => {
  event.waitUntil(
    caches.keys().then(keys =>
      Promise.all(
        keys.filter(k => !ALL_CACHES.includes(k)).map(k => caches.delete(k))
      )
    )
  );
  self.clients.claim();
});

/* ---------- Fetch: route by URL pattern ---------- */

self.addEventListener('fetch', (event) => {
  const url = new URL(event.request.url);

  // Only handle GET requests
  if (event.request.method !== 'GET') return;

  // V3.583 — cross-origin requests: handle ONLY the two CDNs we deliberately
  // cache, and pass everything else straight through to the network. This
  // covers the Firebase APIs (Firestore / Auth / Storage) and Google auth
  // endpoints that used to be listed host-by-host, plus every third-party
  // research API the app talks to. Sitting in front of a cross-origin request
  // we can't cache was actively harmful: a CORS-rejected fetch (e.g.
  // api.semanticscholar.org, which sends no Access-Control-Allow-Origin) fell
  // into staleWhileRevalidate's catch, resolved to `undefined` with nothing
  // cached, and respondWith(undefined) threw "Failed to convert value to
  // 'Response'" — turning a clean CORS failure the caller could handle into a
  // dead FetchEvent.
  if (url.origin !== self.location.origin) {
    if (url.hostname.includes('gstatic.com') ||
        url.hostname.includes('jsdelivr.net')) {
      // SDK versions are pinned in HTML files, so serving the cached copy
      // first is safe and skips a network round-trip on every app switch.
      event.respondWith(staleWhileRevalidate(event.request));
    }
    return;
  }

  // Research Management (mcgheelab.com/rm/) — network-first instead of
  // stale-while-revalidate. RM ships multiple updates per day during active
  // development; SWR served the previous build on every reload, masking
  // shipped fixes until the SECOND reload. Network-first picks up new code
  // immediately when online, falls back to cache when offline. The cached
  // copy is still updated on every successful fetch, so offline support
  // works as before. Firestore data is unaffected — this is just for the
  // ~100 KB of HTML/JS/CSS that loads RM. Per-user data caching lives in
  // IndexedDB (js/local-cache.js) and is independent of this SW.
  if (url.pathname.startsWith('/rm/')) {
    event.respondWith(networkFirst(event.request, SHELL_CACHE));
    return;
  }

  // V3.738 — learning modules and the whiteboard files that host them:
  // network-first for the same reason as RM. Module pages run inside
  // iframes (class viewer, whiteboard simulation pages), where a user
  // cannot hard-reload them — a hard reload of the OUTER page bypasses the
  // SW for its own scripts but not for the iframe's, so after every FTP the
  // board ran the new whiteboard.js against the previous whiteboard-panel.js
  // and showed a whole module where a simulation cut was asked for.
  if (url.pathname.startsWith('/modules/') ||
      /^\/whiteboard[-a-z]*\.(js|css)$/.test(url.pathname)) {
    event.respondWith(networkFirst(event.request, SHELL_CACHE));
    return;
  }

  // Images: cache-first (runtime caching)
  if (url.pathname.startsWith('/Images/') ||
      url.pathname.startsWith('/icons/') ||
      url.pathname.startsWith('/Videos/')) {
    event.respondWith(cacheFirst(event.request, IMAGE_CACHE));
    return;
  }

  // Everything else (shell + app files): stale-while-revalidate
  event.respondWith(staleWhileRevalidate(event.request));
});

/* ---------- Caching strategies ---------- */

function canCache(response) {
  // Only cache full 200 responses — 206 partial (range/video) and opaque cannot be cached
  return response && response.status === 200 && response.type !== 'opaque';
}

/* V3.583 — one retry before giving up. A single dropped connection on one
 * /rm/ script used to leave the app running with that module silently
 * absent (see the synthetic-408 note below), which is a far worse outcome
 * than spending one extra round-trip. GETs carry no body, so re-issuing the
 * same Request is safe. */
async function fetchOnceRetried(request) {
  try {
    return await fetch(request);
  } catch (err) {
    return fetch(request);
  }
}

/* V3.583 — NEVER answer a failed fetch with a fabricated response.
 *
 * These three strategies used to return `new Response('', {status: 408})`
 * when the network failed and nothing was cached. For a <script> under /rm/
 * that reads as "this file is simply not here": the page keeps loading, the
 * module never defines its global, and the first consumer downstream takes a
 * silent wrong branch. That is exactly how a student's PDF failed to render
 * while the metadata showed fine — runtime-mode.js got a 408, RM_RUNTIME was
 * undefined, and library-paper.js concluded it was on the local dev server
 * and pointed pdf.js at /api/library/pdf-proxy (which only exists under
 * server.py). Propagating the real network error instead makes the failure
 * loud and the retry the browser's problem, not a fake success.
 */
async function cacheFirst(request, cacheName) {
  const cached = await caches.match(request);
  if (cached) return cached;

  const response = await fetchOnceRetried(request);
  if (canCache(response)) {
    const cache = await caches.open(cacheName);
    cache.put(request, response.clone());
  }
  return response;
}

async function networkFirst(request, cacheName) {
  try {
    const response = await fetchOnceRetried(request);
    if (canCache(response)) {
      const cache = await caches.open(cacheName);
      cache.put(request, response.clone());
    }
    return response;
  } catch (err) {
    // Offline: the cached copy is a genuine answer. With nothing cached,
    // surface the network error rather than a synthetic one.
    const cached = await caches.match(request);
    if (cached) return cached;
    throw err;
  }
}

async function staleWhileRevalidate(request) {
  const cached = await caches.match(request);

  const revalidate = fetchOnceRetried(request).then(response => {
    if (canCache(response)) {
      // Single shell cache after V3.53 — APPS_CACHE retired with /apps/.
      caches.open(SHELL_CACHE).then(cache => {
        try { cache.put(request, response.clone()); } catch (e) { /* body already used */ }
      });
    }
    return response;
  });

  if (cached) {
    // The cached copy already answered; don't let the background refresh
    // surface as an unhandled rejection when we're offline.
    revalidate.catch(() => { /* stale copy stands */ });
    return cached;
  }
  return revalidate;   // may reject → a real network error, never `undefined`
}
