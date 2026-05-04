/* ================================================================
   Service Worker — McGheeLab PWA
   ================================================================
   Caching strategies:
   - Shell + App files: precache on install, stale-while-revalidate
   - Images/icons:      cache-first (runtime)
   - CDN (Firebase SDK): network-first, fall back to cache
   - Firebase API calls: network-only (never cached)
   ================================================================ */

const CACHE_VERSION = 15;
const SHELL_CACHE  = `mcgheelab-shell-v${CACHE_VERSION}`;
const APPS_CACHE   = `mcgheelab-apps-v${CACHE_VERSION}`;
const IMAGE_CACHE  = `mcgheelab-images-v${CACHE_VERSION}`;
const CDN_CACHE    = `mcgheelab-cdn-v${CACHE_VERSION}`;

const ALL_CACHES = [SHELL_CACHE, APPS_CACHE, IMAGE_CACHE, CDN_CACHE];

/* ---------- URLs to precache on install ---------- */

const SHELL_URLS = [
  '/',
  '/index.html',
  '/app.js',
  '/styles.css',
  '/user-styles.css',
  '/cv-styles.css',
  '/firebase-config.js',
  '/user-system.js',
  '/cv-builder.js',
  '/scheduler.js',
  '/class-builder.js',
  '/lab-apps.js',
  '/push-notifications.js',
  '/content.json',
  '/manifest.json',
  '/icons/icon-192.png',
  '/icons/icon-512.png',
  '/icons/apple-touch-icon.png',
  '/icons/favicon-32.png'
];

/* APPS_CACHE precache list dropped in V3.40: lab apps are now reached via
 * RM iframe wrappers (rm/pages/app-<name>.html) rather than the public-site
 * Apps menu. The APPS_CACHE constant + runtime stale-while-revalidate
 * routing for /apps/* below stay so iframe loads remain fast; we just
 * don't precache all 33 app files at install time anymore. Phase C deletes
 * /apps/ entirely and removes APPS_CACHE. */

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

  // Never cache Firebase API calls (Firestore, Auth, Storage)
  if (url.hostname.includes('firestore.googleapis.com') ||
      url.hostname.includes('identitytoolkit.googleapis.com') ||
      url.hostname.includes('securetoken.googleapis.com') ||
      url.hostname.includes('firebasestorage.googleapis.com')) {
    return;
  }

  // Google Auth endpoints — never cache (auth tokens, popups, GIS client)
  if (url.hostname.includes('accounts.google.com') ||
      url.hostname.includes('apis.google.com')) {
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

  // CDN resources (Firebase SDK, Chart.js): stale-while-revalidate
  // SDK versions are pinned in HTML files, so cache-first is safe and
  // eliminates the network round-trip on every app switch
  if (url.hostname.includes('gstatic.com') ||
      url.hostname.includes('jsdelivr.net')) {
    event.respondWith(staleWhileRevalidate(event.request));
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

async function cacheFirst(request, cacheName) {
  const cached = await caches.match(request);
  if (cached) return cached;

  try {
    const response = await fetch(request);
    if (canCache(response)) {
      const cache = await caches.open(cacheName);
      cache.put(request, response.clone());
    }
    return response;
  } catch {
    return new Response('', { status: 408, statusText: 'Offline' });
  }
}

async function networkFirst(request, cacheName) {
  try {
    const response = await fetch(request);
    if (canCache(response)) {
      const cache = await caches.open(cacheName);
      cache.put(request, response.clone());
    }
    return response;
  } catch {
    const cached = await caches.match(request);
    return cached || new Response('', { status: 408, statusText: 'Offline' });
  }
}

async function staleWhileRevalidate(request) {
  const cached = await caches.match(request);

  const fetchPromise = fetch(request).then(response => {
    if (canCache(response)) {
      const url = new URL(request.url);
      const cacheName = url.pathname.startsWith('/apps/') ? APPS_CACHE : SHELL_CACHE;
      caches.open(cacheName).then(cache => {
        try { cache.put(request, response.clone()); } catch (e) { /* body already used */ }
      });
    }
    return response;
  }).catch(() => cached);

  return cached || fetchPromise;
}
