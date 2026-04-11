/* ================================================================
   Firebase Cloud Messaging Service Worker — McGheeLab
   ================================================================
   Handles background push notifications (when the app is not in
   the foreground). Must live at the root of the site.
   ================================================================ */

importScripts('https://www.gstatic.com/firebasejs/10.14.0/firebase-app-compat.js');
importScripts('https://www.gstatic.com/firebasejs/10.14.0/firebase-messaging-compat.js');

firebase.initializeApp({
  apiKey:            'AIzaSyAnkKivjCcjAS8_Lp-R2JSIG4wSDSJBFI0',
  authDomain:        'mcgheelab-f56cc.firebaseapp.com',
  projectId:         'mcgheelab-f56cc',
  storageBucket:     'mcgheelab-f56cc.firebasestorage.app',
  messagingSenderId: '665438582202',
  appId:             '1:665438582202:web:57416863d588bcdeff9983'
});

const messaging = firebase.messaging();

/* ---------- IndexedDB badge counter ---------- */
// Service workers can't use localStorage, so badge count is stored in IndexedDB.
// The main thread (push-notifications.js) uses the same DB name to stay in sync.

const BADGE_DB = 'mcgheelab-badge';

function openBadgeDB() {
  return new Promise((resolve, reject) => {
    const req = indexedDB.open(BADGE_DB, 1);
    req.onupgradeneeded = (e) => e.target.result.createObjectStore('meta');
    req.onsuccess = (e) => resolve(e.target.result);
    req.onerror = () => reject(req.error);
  });
}

async function getBadgeCount() {
  try {
    const db = await openBadgeDB();
    return new Promise((resolve) => {
      const tx = db.transaction('meta', 'readonly');
      const get = tx.objectStore('meta').get('count');
      get.onsuccess = () => resolve(get.result || 0);
      get.onerror = () => resolve(0);
    });
  } catch { return 0; }
}

async function setBadgeCount(count) {
  try {
    const db = await openBadgeDB();
    const tx = db.transaction('meta', 'readwrite');
    tx.objectStore('meta').put(count, 'count');
  } catch { /* best-effort */ }
}

/* ---------- Quiet hours (read from IndexedDB, written by settings app) ---------- */

async function getQuietHours() {
  try {
    return new Promise((resolve) => {
      const req = indexedDB.open('mcgheelab-prefs', 1);
      req.onupgradeneeded = (e) => e.target.result.createObjectStore('settings');
      req.onsuccess = (e) => {
        const db = e.target.result;
        const tx = db.transaction('settings', 'readonly');
        const get = tx.objectStore('settings').get('quietHours');
        get.onsuccess = () => resolve(get.result || null);
        get.onerror = () => resolve(null);
      };
      req.onerror = () => resolve(null);
    });
  } catch { return null; }
}

function isWithinQuietHours(start, end) {
  const now = new Date();
  const mins = now.getHours() * 60 + now.getMinutes();
  const [sh, sm] = start.split(':').map(Number);
  const [eh, em] = end.split(':').map(Number);
  const startMins = sh * 60 + sm;
  const endMins = eh * 60 + em;

  if (startMins <= endMins) {
    // Same-day range (e.g., 09:00–17:00)
    return mins >= startMins && mins < endMins;
  } else {
    // Overnight range (e.g., 22:00–07:00)
    return mins >= startMins || mins < endMins;
  }
}

/* ---------- Background messages ---------- */

messaging.onBackgroundMessage(async (payload) => {
  const data = payload.notification || payload.data || {};
  const title = data.title || 'McGheeLab';
  const options = {
    body:    data.body || '',
    icon:    data.icon || '/icons/icon-192.png',
    badge:   '/icons/icon-96.png',
    data:    { url: data.click_action || data.url || '/#/apps' },
    vibrate: [200, 100, 200],
    tag:     data.tag || 'mcgheelab-' + Date.now(),
    requireInteraction: true
  };

  // Check quiet hours — suppress notification but still increment badge
  const qh = await getQuietHours();
  const silenced = qh && qh.enabled && isWithinQuietHours(qh.start, qh.end);

  if (!silenced) {
    self.registration.showNotification(title, options);
  }

  // Increment app icon badge count (Android Chrome PWA + desktop Chrome/Edge)
  if ('setAppBadge' in navigator) {
    const count = await getBadgeCount();
    const newCount = count + 1;
    await setBadgeCount(newCount);
    navigator.setAppBadge(newCount).catch(() => {});
  }
});

/* ---------- Notification click ---------- */

self.addEventListener('notificationclick', (event) => {
  event.notification.close();

  // Clear badge when user interacts with a notification
  if ('clearAppBadge' in navigator) {
    navigator.clearAppBadge().catch(() => {});
  }
  setBadgeCount(0);

  const targetUrl = event.notification.data?.url || '/#/apps';

  event.waitUntil(
    clients.matchAll({ type: 'window', includeUncontrolled: true }).then(windowClients => {
      // Focus an existing tab if one is open
      for (const client of windowClients) {
        if (client.url.includes('mcgheelab.github.io') && 'focus' in client) {
          client.navigate(targetUrl);
          return client.focus();
        }
      }
      // Otherwise open a new window
      return clients.openWindow(targetUrl);
    })
  );
});
