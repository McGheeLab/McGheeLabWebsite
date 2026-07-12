/* rm/js/desktop-only-guard.js — V3.240
 *
 * Phone interstitial for pages that fundamentally need a wide screen
 * (split-view, workflow-shell, admin tools, financial dashboards,
 * grant/cv editors, lab-tasks). The page opts in by adding
 * `class="rm-desktop-only"` to <body> and loading this script.
 *
 * Behavior:
 *   - At ≤640px, on first load, render a full-screen card explaining
 *     the page is desktop-first plus a "Try anyway" escape hatch and a
 *     "← Back to RM home" button.
 *   - "Try anyway" sets sessionStorage rm_desktop_only_dismissed=1 so
 *     the interstitial doesn't reappear during the session. Reload or
 *     a new tab brings it back.
 *   - At >640px the guard is dormant (no DOM injection).
 *
 * CSS counterpart: `.rm-desktop-only-overlay` rules at the bottom of
 * /rm/css/style.css.
 */
(function () {
  'use strict';
  if (window.DESKTOP_ONLY_GUARD) return;

  var PHONE_BP = 640;
  var STORAGE_KEY = 'rm_desktop_only_dismissed';

  var api = { shown: false };
  window.DESKTOP_ONLY_GUARD = api;

  function dismissed() {
    try { return sessionStorage.getItem(STORAGE_KEY) === '1'; }
    catch (e) { return false; }
  }
  function markDismissed() {
    try { sessionStorage.setItem(STORAGE_KEY, '1'); }
    catch (e) { /* private mode — ignore */ }
  }

  function buildOverlay() {
    var overlay = document.createElement('div');
    overlay.className = 'rm-desktop-only-overlay';
    overlay.setAttribute('role', 'dialog');
    overlay.setAttribute('aria-modal', 'true');
    overlay.setAttribute('aria-labelledby', 'rm-desktop-only-title');

    overlay.innerHTML =
      '<div class="rm-desktop-only-card">' +
        '<div class="rm-desktop-only-icon" aria-hidden="true">🖥️</div>' +
        '<h2 class="rm-desktop-only-title" id="rm-desktop-only-title">Designed for desktop</h2>' +
        '<p class="rm-desktop-only-body">' +
          'This page uses a layout that needs a wider screen — a tablet ' +
          'in landscape, or a laptop, works best. You can still open it ' +
          'on this phone, but expect cramped space and small tap targets.' +
        '</p>' +
        '<div class="rm-desktop-only-actions">' +
          '<a class="rm-desktop-only-btn rm-desktop-only-btn-primary" href="/rm/">← Back to RM home</a>' +
          '<button class="rm-desktop-only-btn rm-desktop-only-btn-secondary" type="button">Try anyway</button>' +
        '</div>' +
      '</div>';

    var btn = overlay.querySelector('button');
    btn.addEventListener('click', function () {
      markDismissed();
      hide();
    });

    // Escape closes the interstitial too (same as "Try anyway" — escape
    // hatch into the page).
    overlay.addEventListener('keydown', function (e) {
      if (e.key === 'Escape') { markDismissed(); hide(); }
    });

    return overlay;
  }

  function hide() {
    if (!api.shown) return;
    if (api._el && api._el.parentNode) api._el.parentNode.removeChild(api._el);
    api._el = null;
    api.shown = false;
  }

  function maybeShow() {
    if (!document.body) return;
    if (!document.body.classList.contains('rm-desktop-only')) return;
    if (window.innerWidth > PHONE_BP) return;
    if (dismissed()) return;
    if (api.shown) return;
    var overlay = buildOverlay();
    document.body.appendChild(overlay);
    api._el = overlay;
    api.shown = true;
    // Focus the "Try anyway" button so screen readers announce the
    // dialog + keyboard users can tab into it immediately.
    var btn = overlay.querySelector('button');
    if (btn) try { btn.focus({ preventScroll: true }); } catch (e) { btn.focus(); }
  }

  // Tear down on resize back to desktop; rebuild if resizing back to
  // phone within the same session (unless dismissed).
  window.addEventListener('resize', function () {
    if (window.innerWidth > PHONE_BP && api.shown) hide();
    else if (window.innerWidth <= PHONE_BP && !api.shown) maybeShow();
  });

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', maybeShow);
  } else {
    maybeShow();
  }
})();
