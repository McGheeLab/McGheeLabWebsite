/* mobile-push.js — Ourlab app push registration (V3.566, m-v0.2).
 *
 * Runs ONLY inside the Capacitor shell (the OurlabMobile sync step
 * injects it into every page alongside mobile-shell.js). It:
 *   1. asks for notification permission (once),
 *   2. gets the native FCM token and writes it to
 *      users/{uid}/pushTokens/{token} with `native: true` — the flag
 *      functions/helpers/notify.js branches on to send a display-capable
 *      payload (a data-only push does NOT display on backgrounded iOS),
 *   3. deep-links notification taps into the target rm/ page.
 *
 * The web push path (push-notifications.js / McgheePush) is a NO-OP here
 * because it is only loaded by the marketing SPA, never by rm/ pages —
 * so there is no double registration to suppress. If that ever changes,
 * guard McgheePush on `!window.Capacitor?.isNativePlatform()`.
 *
 * Every rm/ page is a fresh WebView document, so registration is
 * throttled via sessionStorage to run at most once per app session
 * (and again if the token rotates).
 */
(function () {
  'use strict';

  function isApp() {
    return !!(window.Capacitor && typeof Capacitor.isNativePlatform === 'function'
      && Capacitor.isNativePlatform());
  }
  function plugin() {
    return window.Capacitor && Capacitor.Plugins && Capacitor.Plugins.FirebaseMessaging;
  }
  if (!isApp() || !plugin()) return;

  var FM = plugin();
  var SESSION_KEY = 'ourlab-push-token';        // last token written this session
  var THROTTLE_MS = 12 * 60 * 60 * 1000;        // re-write at most twice a day

  function log() {
    try { console.log.apply(console, ['[ourlab-push]'].concat([].slice.call(arguments))); } catch (e) {}
  }

  /* Stable per-install id (for future per-device prefs) without pulling
   * in @capacitor/device — a persisted random token in localStorage. */
  function deviceId() {
    try {
      var k = 'ourlab-device-id';
      var v = localStorage.getItem(k);
      if (!v) {
        v = 'dev-' + Date.now().toString(36) + '-' + Math.random().toString(36).slice(2, 8);
        localStorage.setItem(k, v);
      }
      return v;
    } catch (e) { return 'dev-unknown'; }
  }

  async function ensurePermission() {
    try {
      var res = await FM.checkPermissions();
      if (res && res.receive === 'granted') return true;
      var req = await FM.requestPermissions();
      return !!(req && req.receive === 'granted');
    } catch (e) {
      log('permission check failed:', e && e.message);
      return false;
    }
  }

  async function writeToken(uid, token) {
    var platform = (Capacitor.getPlatform && Capacitor.getPlatform()) || 'unknown';
    try {
      await firebridge.db()
        .collection('users').doc(uid)
        .collection('pushTokens').doc(token)
        .set({
          token: token,
          native: true,                 // ← notify.js sends a display payload
          client: 'capacitor',
          platform: platform,           // 'ios' | 'android'
          deviceId: deviceId(),
          appVersion: 'm-v0.2',
          userAgent: (navigator.userAgent || '').slice(0, 200),
          failCount: 0,
          lastSeen: new Date().toISOString(),
          createdAt: new Date().toISOString(),
        }, { merge: true });
      log('token registered for', uid, '(' + platform + ')');
    } catch (e) {
      log('token write failed:', e && e.message);
    }
  }

  // V3.586 — throttle moved sessionStorage → localStorage: under the m-v0.3
  // multi-WebView shell each warm tab is its OWN session, so a per-session
  // throttle re-wrote the token once per webview per launch (~5 idempotent
  // but wasteful writes). localStorage is shared across the shell's webviews
  // (one shared WKWebsiteDataStore). Token rotation still forces a write
  // (prev.token !== token). Same key + payload as before.
  function throttled(token) {
    try {
      var raw = localStorage.getItem(SESSION_KEY);
      if (!raw) return false;
      var prev = JSON.parse(raw);
      return prev.token === token && (Date.now() - prev.at) < THROTTLE_MS;
    } catch (e) { return false; }
  }
  function markWritten(token) {
    try { localStorage.setItem(SESSION_KEY, JSON.stringify({ token: token, at: Date.now() })); } catch (e) {}
  }

  async function register() {
    var user = firebridge.getUser && firebridge.getUser();
    if (!user) return;
    var granted = await ensurePermission();
    if (!granted) { log('permission not granted'); return; }
    try {
      var res = await FM.getToken();
      var token = res && res.token;
      if (!token) { log('no token returned'); return; }
      if (throttled(token)) { log('token fresh — skip write'); return; }
      await writeToken(user.uid, token);
      markWritten(token);
    } catch (e) {
      // On iOS this throws until an APNs key is configured in Firebase.
      log('getToken failed:', e && e.message);
    }
  }

  /* ── notification tap → deep-link into the target rm/ page ── */
  function routeTo(url) {
    if (!url) return;
    var target = url;
    // Accept absolute rm paths, bare page names, or full URLs.
    if (/^https?:\/\//.test(url)) {
      try { target = new URL(url).pathname + new URL(url).search; } catch (e) { target = url; }
    } else if (url.charAt(0) !== '/') {
      target = '/rm/pages/' + url;               // bare "chat.html?channel=x"
    }
    // V3.586 — m-v0.3 multi-WebView shell: route deep links through the
    // native OurlabTabs plugin so they land in the RIGHT tab webview (with
    // query navigation when needed) instead of navigating THIS webview away
    // from its page. Guard: if this webview is a hidden background tab
    // (tab-lifecycle.js maintains the flag; undefined on web/Android), let
    // the visible one do the routing — belt-and-suspenders should the push
    // event ever fan out to more than one webview.
    if (window.__OURLAB_TAB_VISIBLE === false) return;
    try {
      var OT = window.Capacitor && Capacitor.Plugins && Capacitor.Plugins.OurlabTabs;
      if (OT && OT.open) {
        OT.open({ href: target }).catch(function () { location.href = target; });
        return;
      }
    } catch (e) { /* fall through to the legacy paths */ }
    // Inside the persistent app shell, route the deep-link INTO the shell
    // (swap the tab's iframe) instead of location.href, which would replace
    // the whole shell and drop the persistent tab bar. app-shell.js listens.
    var inShell = false;
    try { inShell = document.body && document.body.dataset && document.body.dataset.appShell === '1'; } catch (e) {}
    if (inShell) {
      window.dispatchEvent(new CustomEvent('rm:app:navigate', { detail: { href: target } }));
      return;
    }
    if (location.pathname + location.search !== target) location.href = target;
  }

  FM.addListener('notificationActionPerformed', function (event) {
    var data = (event && event.notification && event.notification.data) || {};
    log('tap →', data.url);
    routeTo(data.url);
  });

  // Foreground arrival: iOS won't show a banner over the app; surface a toast.
  FM.addListener('notificationReceived', function (event) {
    var n = (event && event.notification) || {};
    if (window.TOAST && TOAST.info && (n.title || n.body)) {
      TOAST.info((n.title ? n.title + ' — ' : '') + (n.body || ''));
    }
  });

  // Token rotation → re-write.
  FM.addListener('tokenReceived', function (event) {
    var user = firebridge.getUser && firebridge.getUser();
    var token = event && event.token;
    if (user && token && !throttled(token)) { writeToken(user.uid, token); markWritten(token); }
  });

  function boot() {
    // NOTE: `firebridge` is a lexical const (bare global) — `window.firebridge`
    // is ALWAYS undefined, so guarding on it looped boot() forever and push
    // registration never ran on-device (see the window.firebridge dead-check
    // trap). Guard the bare name via typeof, like every other rm/ script.
    if (typeof firebridge === 'undefined' || !firebridge.whenAuthResolved) {
      return setTimeout(boot, 300); // firebase-bridge not up yet
    }
    firebridge.whenAuthResolved().then(register).catch(function (e) { log('boot failed:', e && e.message); });
  }
  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', boot);
  else boot();
})();
