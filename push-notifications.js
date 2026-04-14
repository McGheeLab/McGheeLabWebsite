/* ================================================================
   Push Notifications — McGheeLab
   ================================================================
   Client-side module for requesting push permission, managing
   FCM tokens, and handling foreground messages.

   Usage:
     McgheePush.init();
     McgheePush.requestPermission(userId);  // after user opts in
     McgheePush.onForegroundMessage(payload => { ... });

   SETUP: Replace VAPID_KEY with the key from Firebase Console →
   Project Settings → Cloud Messaging → Web Push certificates.
   ================================================================ */

window.McgheePush = (() => {
  // TODO: Replace with your VAPID key from Firebase Console
  const VAPID_KEY = 'BIb4AdJ0DgkuOZlosMGcVkoaZqIdS81uDSYVoIMSYPyufXdJfJRYbmCVf1IrRKaYHw6EjJ3900TFOdlfgw4hEfs';
  let messaging = null;
  let initialized = false;

  /* ---------- Init ---------- */

  function init() {
    if (initialized) return;
    if (!('Notification' in window)) {
      console.warn('[Push] Notifications not supported in this browser.');
      return;
    }
    if (typeof firebase === 'undefined' || !firebase.messaging) {
      console.warn('[Push] Firebase Messaging SDK not loaded.');
      return;
    }
    messaging = firebase.messaging();
    initialized = true;
    console.log('[Push] Initialized.');
  }

  /* ---------- Check support ---------- */

  function isSupported() {
    return 'Notification' in window && 'serviceWorker' in navigator && initialized;
  }

  function getPermissionState() {
    if (!('Notification' in window)) return 'unsupported';
    return Notification.permission; // 'default', 'granted', 'denied'
  }

  /* ---------- Request permission + get token ---------- */

  async function requestPermission(userId) {
    if (!isSupported()) return null;
    if (!VAPID_KEY) {
      console.warn('[Push] VAPID_KEY not set. Get it from Firebase Console → Project Settings → Cloud Messaging.');
      return null;
    }

    try {
      const permission = await Notification.requestPermission();
      if (permission !== 'granted') {
        console.log('[Push] Permission denied by user.');
        return null;
      }

      const token = await messaging.getToken({ vapidKey: VAPID_KEY });
      if (!token) {
        console.warn('[Push] Failed to get FCM token.');
        return null;
      }

      // Store token in Firestore
      if (McgheeLab.db && userId) {
        await McgheeLab.db
          .collection('users').doc(userId)
          .collection('pushTokens').doc(token)
          .set({
            token,
            createdAt: firebase.firestore.FieldValue.serverTimestamp(),
            platform: detectPlatform(),
            userAgent: navigator.userAgent.substring(0, 200),
            failCount: 0
          });
        console.log('[Push] Token saved to Firestore.');
      }

      return token;
    } catch (err) {
      console.error('[Push] Error requesting permission:', err);
      return null;
    }
  }

  /* ---------- Refresh token (call on every login) ---------- */

  async function refreshToken(userId) {
    if (!isSupported()) return null;
    if (!VAPID_KEY) return null;
    if (Notification.permission !== 'granted') return null;

    try {
      const token = await messaging.getToken({ vapidKey: VAPID_KEY });
      if (!token) return null;

      // Upsert token in Firestore and reset failure counter
      if (McgheeLab.db && userId) {
        await McgheeLab.db
          .collection('users').doc(userId)
          .collection('pushTokens').doc(token)
          .set({
            token,
            createdAt: firebase.firestore.FieldValue.serverTimestamp(),
            platform: detectPlatform(),
            userAgent: navigator.userAgent.substring(0, 200),
            failCount: 0
          });
        console.log('[Push] Token refreshed.');
      }

      return token;
    } catch (err) {
      console.warn('[Push] Token refresh failed:', err);
      return null;
    }
  }

  /* ---------- Remove token (for logout) ---------- */

  async function removeToken(userId) {
    if (!messaging) return;
    try {
      const token = await messaging.getToken({ vapidKey: VAPID_KEY });
      if (token && McgheeLab.db && userId) {
        await McgheeLab.db
          .collection('users').doc(userId)
          .collection('pushTokens').doc(token)
          .delete();
      }
      await messaging.deleteToken();
      console.log('[Push] Token removed.');
    } catch (err) {
      console.warn('[Push] Error removing token:', err);
    }
  }

  /* ---------- Foreground message handler ---------- */

  function onForegroundMessage(callback) {
    if (!messaging) return;
    messaging.onMessage((payload) => {
      console.log('[Push] Foreground message:', payload);
      callback(payload);
    });
  }

  /* ---------- App Icon Badge (Badging API) ---------- */
  // Works on Android Chrome PWA + desktop Chrome/Edge. Not supported on iOS.
  // Uses the same IndexedDB as firebase-messaging-sw.js to stay in sync.

  const BADGE_DB = 'mcgheelab-badge';

  function isBadgingSupported() {
    return 'setAppBadge' in navigator;
  }

  async function setBadge(count) {
    if (!isBadgingSupported()) return;
    try {
      if (count > 0) {
        await navigator.setAppBadge(count);
      } else {
        await navigator.clearAppBadge();
      }
    } catch (err) {
      console.warn('[Push] Badge API error:', err);
    }
  }

  async function clearBadge() {
    if (!isBadgingSupported()) return;
    try {
      await navigator.clearAppBadge();
    } catch (err) {
      console.warn('[Push] Badge clear error:', err);
    }
    // Reset the count in IndexedDB so the SW stays in sync
    try {
      const req = indexedDB.open(BADGE_DB, 1);
      req.onupgradeneeded = (e) => e.target.result.createObjectStore('meta');
      req.onsuccess = (e) => {
        const db = e.target.result;
        const tx = db.transaction('meta', 'readwrite');
        tx.objectStore('meta').put(0, 'count');
      };
    } catch {
      // IndexedDB not available — that's fine
    }
  }

  /* ---------- Helpers ---------- */

  function detectPlatform() {
    const ua = navigator.userAgent;
    if (/iPhone|iPad|iPod/.test(ua)) return 'ios';
    if (/Android/.test(ua)) return 'android';
    return 'desktop';
  }

  /* ---------- Public API ---------- */

  return {
    init,
    isSupported,
    getPermissionState,
    requestPermission,
    refreshToken,
    removeToken,
    onForegroundMessage,
    isBadgingSupported,
    setBadge,
    clearBadge
  };
})();
