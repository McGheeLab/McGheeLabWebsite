/* tab-lifecycle.js — pause/resume fan-out for the Ourlab app's native
 * multi-WebView tab shell (V3.585, FuturePlan: instant tab switching).
 *
 * The native shell keeps one live top-level WebView per bottom tab and swaps
 * them on tab taps. When a tab is swapped out/in, the shell dispatches plain
 * DOM events on `document`:
 *
 *   'ourlab:tab-hidden'   — this WebView was swapped out (or idle-preloaded
 *                           hidden; the shell re-fires this after a hidden
 *                           preload finishes loading)
 *   'ourlab:tab-visible'  — this WebView was swapped in
 *
 * Policy (Alex, 2026-07-30): warm DOM, paused listeners — hidden tabs keep
 * their rendered DOM but detach Firestore listeners; resume re-attaches and
 * the re-fired snapshots are the accepted refresh-on-arrival.
 *
 * Fan-out order:
 *   hidden : page hook → api.pauseAll() → firebridge.pauseProfileSync()
 *            (page first: it may need a last write, e.g. chat typing-clear)
 *   visible: firebridge.resumeProfileSync() → api.resumeAll() → page hook
 *            (infra first so the page hook can rely on a live adapter)
 *
 * Pages opt in with `window.OURLAB_TAB_LIFECYCLE = { pause(), resume() }`
 * (looked up at event time — no load-order dependency). Scripts that are not
 * "the page" (e.g. chat-alert-watch.js) listen to the raw document events.
 *
 * `window.__OURLAB_TAB_VISIBLE` mirrors the current state for guards like
 * mobile-push's routeTo (undefined on web/Android — guards must treat only
 * `=== false` as hidden).
 *
 * On the web and on Android these events never fire, so this file is inert
 * there by construction. Idempotent against double-dispatch via `visible`. */
(function () {
  'use strict';

  // Idle-preloaded WebViews start hidden; everything else starts visible.
  // (document.visibilityState is 'hidden' in a hidden WKWebView when WebKit's
  // ViewState plumbing propagates it — belt-and-suspenders; the shell also
  // re-fires 'ourlab:tab-hidden' post-load for preloads.)
  var visible = true;
  try { visible = document.visibilityState !== 'hidden'; } catch (e) {}
  window.__OURLAB_TAB_VISIBLE = visible;

  function pageHook() { return window.OURLAB_TAB_LIFECYCLE || null; }

  document.addEventListener('ourlab:tab-hidden', function () {
    if (!visible) return;
    visible = false;
    window.__OURLAB_TAB_VISIBLE = false;
    var h = pageHook();
    if (h && h.pause) { try { h.pause(); } catch (e) { console.warn('[tab-lifecycle] page pause failed:', e && e.message); } }
    // NOTE: `api` and `firebridge` are lexical consts — window.api /
    // window.firebridge are ALWAYS undefined (the V3.392/V3.577 dead-check
    // class). Guard with typeof on the bare global, never window.*.
    try { if (typeof api !== 'undefined' && api.pauseAll) api.pauseAll(); } catch (e) {}
    try {
      if (typeof firebridge !== 'undefined' && firebridge.pauseProfileSync) firebridge.pauseProfileSync();
    } catch (e) {}
  });

  /* Idle-preload self-check: the shell creates background tabs HIDDEN, and
   * can't reliably dispatch into a page mid-load. So at DOMContentLoaded
   * (page hooks are registered at parse; defer scripts run before DCL) we
   * ask the shell which tab is active — if it isn't us, run the hidden
   * fan-out locally by dispatching the same event. No-op on web/Android
   * (plugin absent) and in the visible webview. */
  function selfCheck() {
    try {
      var T = window.Capacitor && Capacitor.isNativePlatform
        && Capacitor.isNativePlatform() && Capacitor.Plugins
        && Capacitor.Plugins.OurlabTabs;
      if (!T || !T.getActiveTab) return;
      var p = location.pathname;
      var file = p.substring(p.lastIndexOf('/') + 1);
      var mine = file === 'my-day.html' ? 'myday'
        : file === 'team-focus.html' ? 'focus'
        : file === 'chat.html' ? 'chat'
        : /^tasks[a-z-]*\.html$/.test(file) ? 'tasks'
        : /^library[a-z-]*\.html$/.test(file) ? 'library' : 'misc';
      T.getActiveTab().then(function (r) {
        if (!r || !r.key) return;
        if (r.key !== mine) {
          document.dispatchEvent(new Event('ourlab:tab-hidden'));
        } else if (!visible) {
          /* ★ V3.599 — we ARE the active tab but initialized hidden. The
           * `visible` seed above reads document.visibilityState, and
           * WKWebView reports 'hidden' for a child view that is on screen
           * (TabShellViewController only swaps view.isHidden; it never
           * touches WebKit's ViewState). Nothing else corrected this: the
           * shell fires 'ourlab:tab-visible' on SWITCHES, and activate()
           * early-returns for the already-active tab, so the flag stayed
           * false for the whole session.
           *
           * Consequence found in prod (V3.596 presence): a phone sitting on
           * the chat page published visible:false, so its own chat pushes
           * were never suppressed. Correcting it here also un-sticks
           * anything that paused off the bad seed. All three resume paths
           * (api.resumeAll, _attachProfileLiveSync, resumeChat) are
           * idempotent, so this is safe when nothing actually paused. */
          document.dispatchEvent(new Event('ourlab:tab-visible'));
        }
      }).catch(function () {});
    } catch (e) {}
  }
  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', selfCheck);
  } else {
    selfCheck();
  }

  document.addEventListener('ourlab:tab-visible', function () {
    if (visible) return;
    visible = true;
    window.__OURLAB_TAB_VISIBLE = true;
    try {
      if (typeof firebridge !== 'undefined' && firebridge.resumeProfileSync) firebridge.resumeProfileSync();
    } catch (e) {}
    try { if (typeof api !== 'undefined' && api.resumeAll) api.resumeAll(); } catch (e) {}
    var h = pageHook();
    if (h && h.resume) { try { h.resume(); } catch (e) { console.warn('[tab-lifecycle] page resume failed:', e && e.message); } }
  });
})();
