/* presence.js — "what am I looking at right now?" heartbeat (V3.596).
 *
 * Publishes this surface to `userPresence/{uid}` so the notification
 * pipeline (functions/helpers/presence.js) can skip pushing something the
 * user is already staring at. Being on the chat page must not produce a
 * chat banner; being on the chat page must STILL produce an equipment one.
 *
 * Shape — one doc per user, a map of surfaces keyed by device id so a
 * desktop and a phone never clobber each other:
 *
 *   userPresence/{uid} = { surfaces: { "<deviceId>": {
 *     paths:        ["/rm/pages/chat.html"],   // ordered; [0] is the page itself
 *     contextIds:   ["chan-abc"] | ["*"],      // "*" = any context on this path
 *     visible:      true,
 *     lastActiveAt: <serverTimestamp>,
 *     client:       "web" | "app"
 *   } } }
 *
 * `lastActiveAt` is a SERVER timestamp on purpose: a client whose clock
 * runs fast would otherwise look permanently fresh and permanently
 * silence its own notifications.
 *
 * Heartbeats are written only while the surface is visible AND the user
 * is not idle, so a tab left open on chat over lunch goes stale on its
 * own and notifications resume — no server-side idle tracking needed.
 *
 * Self-installing IIFE, auto-injected by nav.js on every RM page (the
 * same pattern as page-time-tracker.js), so no page needs a <script> tag.
 * Pages that want finer grain than "this pathname" call
 * `RM_PRESENCE.setContext([...])` — chat does, to publish its active
 * channel. Everything else defaults to ["*"] and needs no change.
 */
(function () {
  'use strict';

  if (window.__rmPresenceInstalled) return;
  window.__rmPresenceInstalled = true;

  var HEARTBEAT_MS = 60 * 1000;   // must stay under presence.js FRESH_MS (150s)
  var IDLE_MS      = 5 * 60 * 1000;
  var INPUT_THROTTLE_MS = 1000;   // in-memory only; never a write per event
  var PRUNE_AFTER_MS = 60 * 60 * 1000;  // drop other surfaces idle > 1h

  var _uid = null;
  var _timer = null;
  var _started = false;
  var _paths = [location.pathname];
  var _contextIds = ['*'];
  var _lastInputAt = Date.now();
  var _lastWroteVisible = null;   // last `visible` value actually written
  var _fallbackSess = Math.random().toString(36).slice(2, 8);

  function log() {
    try { console.log.apply(console, ['[presence]'].concat([].slice.call(arguments))); } catch (e) {}
  }

  /* Stable per-install id. Same key + generator as mobile-push.js. */
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

  /* ★ V3.599 — the surface key MUST be per-WEBVIEW/TAB, not per device.
   *
   * V3.596 keyed `surfaces` by deviceId alone. In the Ourlab app all five
   * webviews (My Week / Focus / Chat / Tasks / misc) share one
   * WKWebsiteDataStore — one localStorage, therefore one deviceId — so
   * every tab wrote to the SAME map entry and clobbered the others. An
   * idle-preloaded background tab writing `visible:false` erased the
   * foreground tab's `visible:true`, which is why a phone sitting on chat
   * still got its own chat push. Two browser tabs on the web hit the same
   * collision.
   *
   * sessionStorage is per-tab on the web and per-webview in the app, which
   * is exactly the granularity a "surface" means. deviceId stays in the key
   * so entries remain readable/attributable per install. */
  function surfaceId() {
    var sess;
    try {
      var k = 'ourlab-surface-id';
      sess = sessionStorage.getItem(k);
      if (!sess) {
        sess = Math.random().toString(36).slice(2, 8);
        sessionStorage.setItem(k, sess);
      }
    } catch (e) {
      // No sessionStorage: fall back to a per-load id. Slightly leakier
      // (a reload makes a new entry) but never collides.
      sess = _fallbackSess;
    }
    return deviceId() + ':' + sess;
  }

  function isApp() {
    try {
      return !!(window.Capacitor && typeof Capacitor.isNativePlatform === 'function'
        && Capacitor.isNativePlatform());
    } catch (e) { return false; }
  }

  /* ★ V3.599 — inside the Ourlab app's multi-WebView tab shell,
   * `__OURLAB_TAB_VISIBLE` is the AUTHORITATIVE signal and
   * `document.visibilityState` MUST NOT be consulted.
   *
   * TabShellViewController swaps `child.view.isHidden` and fires
   * `ourlab:tab-visible`; WKWebView does NOT reliably flip
   * document.visibilityState back to 'visible' for a child view that has
   * been un-hidden — it stays 'hidden'. V3.596 AND-ed it in, which pinned
   * every app surface to visible:false forever, so a phone sitting on the
   * chat page never suppressed its own chat push. (tab-lifecycle.js has
   * always avoided visibilityState for exactly this reason; that was the
   * hint we should have taken.)
   *
   * `typeof === 'boolean'` cleanly discriminates the app (tab-lifecycle.js
   * is injected only there, and assigns the flag at parse time) from web,
   * where it is `undefined` and visibilityState is trustworthy.
   *
   * App-BACKGROUNDED (phone locked / home screen) is handled by staleness,
   * not by this predicate: iOS suspends the webview's timers, the 60s
   * heartbeat stops, and the surface ages out of FRESH_MS within ~2 min,
   * after which pushes resume on their own. */
  function isVisible() {
    if (typeof window.__OURLAB_TAB_VISIBLE === 'boolean') {
      return window.__OURLAB_TAB_VISIBLE;
    }
    try {
      return document.visibilityState === 'visible';
    } catch (e) { return true; }
  }

  function isIdle() {
    return (Date.now() - _lastInputAt) >= IDLE_MS;
  }

  function write(visible) {
    if (!_uid) return;
    // `firebridge` is a lexical const — window.firebridge is ALWAYS
    // undefined. Guard the bare name via typeof, like every rm/ script.
    if (typeof firebridge === 'undefined' || !firebridge.db) return;
    if (typeof firebase === 'undefined' || !firebase.firestore) return;
    var payload = {
      paths: _paths.slice(),
      contextIds: _contextIds.slice(),
      visible: !!visible,
      client: isApp() ? 'app' : 'web',
      lastActiveAt: firebase.firestore.FieldValue.serverTimestamp(),
      // V3.599 diagnostics — the raw inputs to isVisible(). The V3.596 bug
      // took a chain of deduction to find because the doc recorded only the
      // VERDICT; these two fields make "why is this surface not suppressing"
      // answerable straight from a Firestore read. Never read by the server.
      dbg: {
        vs: (function () { try { return document.visibilityState; } catch (e) { return 'err'; } })(),
        tv: (typeof window.__OURLAB_TAB_VISIBLE === 'boolean') ? window.__OURLAB_TAB_VISIBLE : null,
      },
    };
    var patch = { surfaces: {} };
    patch.surfaces[surfaceId()] = payload;
    _lastWroteVisible = !!visible;
    firebridge.db().collection('userPresence').doc(_uid)
      .set(patch, { merge: true })
      .catch(function (e) { log('write failed:', e && e.message); });
  }

  /* One heartbeat tick. Writes only while genuinely here; when the surface
   * goes hidden or idle we write `visible:false` ONCE and then stay quiet,
   * letting lastActiveAt go stale (which is what re-enables pushes). */
  function beat() {
    var here = isVisible() && !isIdle();
    if (here) { write(true); return; }
    if (_lastWroteVisible !== false) write(false);
  }

  /* Immediate re-publish — used on visibility flips and context changes so
   * suppression starts/stops within a second rather than a heartbeat. */
  function refresh() {
    if (!_uid) return;
    beat();
  }

  function noteInput() {
    var now = Date.now();
    if (now - _lastInputAt < INPUT_THROTTLE_MS) return;
    var wasIdle = isIdle();
    _lastInputAt = now;
    // Coming back from idle should restore suppression immediately.
    if (wasIdle) refresh();
  }

  function onVisibilityChange() {
    // Returning to the surface also counts as activity.
    if (isVisible()) _lastInputAt = Date.now();
    refresh();
  }

  /* V3.599 — per-tab surface keys are unbounded over time (every browser
   * tab and every app relaunch mints one), so sweep the dead ones once per
   * page load. Stale entries are already IGNORED by the server's freshness
   * check, so this is purely about keeping the doc small — best-effort, and
   * never allowed to block or fail the heartbeat. One read + at most one
   * write per load. */
  function pruneStaleSurfaces() {
    if (!_uid) return;
    var ref = firebridge.db().collection('userPresence').doc(_uid);
    ref.get().then(function (snap) {
      if (!snap.exists) return;
      var surfaces = (snap.data() || {}).surfaces || {};
      var mine = surfaceId();
      var cutoff = Date.now() - PRUNE_AFTER_MS;
      var patch = {};
      Object.keys(surfaces).forEach(function (sid) {
        if (sid === mine) return;
        var t = surfaces[sid] && surfaces[sid].lastActiveAt;
        var ms = t && t.toMillis ? t.toMillis() : Date.parse(t);
        if (!ms || ms < cutoff) {
          patch['surfaces.' + sid] = firebase.firestore.FieldValue.delete();
        }
      });
      var n = Object.keys(patch).length;
      if (!n) return;
      ref.update(patch)
        .then(function () { log('pruned', n, 'stale surface(s)'); })
        .catch(function (e) { log('prune failed:', e && e.message); });
    }).catch(function (e) { log('prune read failed:', e && e.message); });
  }

  /* Install timers + listeners exactly once, however many times onAuth
   * fires (it re-fires on token refresh and on an account switch). */
  function start() {
    if (_started) return;
    _started = true;
    _lastInputAt = Date.now();
    _timer = setInterval(beat, HEARTBEAT_MS);
    try { pruneStaleSurfaces(); } catch (e) {}

    ['pointerdown', 'keydown', 'wheel', 'touchstart'].forEach(function (evt) {
      document.addEventListener(evt, noteInput, { passive: true, capture: true });
    });
    document.addEventListener('visibilitychange', onVisibilityChange);
    // App multi-WebView shell swaps tabs without a visibilitychange.
    document.addEventListener('ourlab:tab-hidden', onVisibilityChange);
    document.addEventListener('ourlab:tab-visible', onVisibilityChange);
    // Best-effort "I'm gone" on navigate/close. Not guaranteed to land —
    // staleness is the real backstop, this just makes it instant when it does.
    window.addEventListener('pagehide', function () { write(false); });
  }

  /* ── public API ──────────────────────────────────────────────
   * setContext([...])  — sub-surface ids this page is showing.
   *                      [] means "on the page but not watching anything"
   *                      (chat scrolled into history) → notify normally.
   *                      ['*'] (default) means "any context on this path".
   * setPaths([...])    — for shells hosting other pages in panes
   *                      (split-view, workflow-shell).
   * refresh()          — force an immediate re-publish.
   */
  window.RM_PRESENCE = {
    setContext: function (ids) {
      var next = Array.isArray(ids) ? ids.filter(Boolean).map(String) : ['*'];
      if (next.join(' ') === _contextIds.join(' ')) return;
      _contextIds = next;
      refresh();
    },
    setPaths: function (paths) {
      var next = Array.isArray(paths) && paths.length
        ? paths.filter(Boolean).map(String)
        : [location.pathname];
      if (next.join(' ') === _paths.join(' ')) return;
      _paths = next;
      refresh();
    },
    refresh: refresh,
    deviceId: deviceId,
  };

  function boot() {
    if (typeof firebridge === 'undefined' || !firebridge.onAuth) {
      return setTimeout(boot, 300); // firebase-bridge not up yet
    }
    firebridge.onAuth(function (user) {
      if (user && user.uid) {
        if (_uid === user.uid) return;
        _uid = user.uid;
        _lastWroteVisible = null;   // new identity: re-publish from scratch
        start();
        beat();
      } else if (_uid) {
        // Signed out — stop claiming this surface (write before clearing uid).
        write(false);
        _uid = null;
        _lastWroteVisible = null;
      }
    });
  }

  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', boot);
  else boot();
})();
