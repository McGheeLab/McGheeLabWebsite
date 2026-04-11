/* ================================================================
   Service Worker — McGheeLab PWA
   ================================================================
   Caching strategies:
   - Shell + App files: precache on install, stale-while-revalidate
   - Images/icons:      cache-first (runtime)
   - CDN (Firebase SDK): network-first, fall back to cache
   - Firebase API calls: network-only (never cached)
   ================================================================ */

const CACHE_VERSION = 1;
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

const APP_URLS = [
  '/apps/shared/app-base.css',
  '/apps/shared/auth-bridge.js',
  '/apps/activity-tracker/index.html',
  '/apps/activity-tracker/app.js',
  '/apps/activity-tracker/styles.css',
  '/apps/chat/index.html',
  '/apps/chat/app.js',
  '/apps/chat/styles.css',
  '/apps/console/index.html',
  '/apps/console/app.js',
  '/apps/console/styles.css',
  '/apps/equipment/index.html',
  '/apps/equipment/app.js',
  '/apps/equipment/styles.css',
  '/apps/huddle/index.html',
  '/apps/huddle/app.js',
  '/apps/huddle/styles.css',
  '/apps/inventory/index.html',
  '/apps/inventory/app.js',
  '/apps/inventory/styles.css',
  '/apps/meetings/index.html',
  '/apps/meetings/app.js',
  '/apps/meetings/styles.css',
  '/apps/scheduler/index.html',
  '/apps/scheduler/app.js',
  '/apps/scheduler/styles.css',
  '/apps/settings/index.html',
  '/apps/settings/app.js',
  '/apps/settings/styles.css'
];

/* ---------- Install: precache shell + apps ---------- */

self.addEventListener('install', (event) => {
  event.waitUntil(
    Promise.all([
      caches.open(SHELL_CACHE).then(cache => cache.addAll(SHELL_URLS)),
      caches.open(APPS_CACHE).then(cache => cache.addAll(APP_URLS))
    ])
  );
  self.skipWaiting();
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

  // CDN resources (Firebase SDK, Chart.js): stale-while-revalidate
  // SDK versions are pinned in HTML files, so cache-first is safe and
  // eliminates the network round-trip on every app switch
  if (url.hostname.includes('gstatic.com') ||
      url.hostname.includes('jsdelivr.net') ||
      url.hostname.includes('accounts.google.com')) {
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
