/* app-shell.js — the Ourlab phone app's PERSISTENT navigation shell (V3.573).
 *
 * The app is otherwise a multi-page app: each tab is a separate rm/pages/*.html
 * document, so tapping a tab did a full WKWebView navigation — re-parsing the
 * Firebase SDK + every /rm/js script and re-running auth from scratch (a
 * visible "reload", worst on the heavy Chat page). This shell fixes that:
 *
 *   - app-shell.html loads ONCE and stays alive for the whole session.
 *   - Each tab is a same-origin IFRAME (the normal rm page + ?embed=1) that is
 *     lazy-created on first visit and then KEPT MOUNTED (display:none). Tapping
 *     a tab just toggles which iframe is visible — no document teardown, no SDK
 *     re-parse, no auth re-resolve. Each tab keeps its scroll position and any
 *     in-progress edit; switching back is instant.
 *   - The persistent top bar (Ourlab mark · lab group · account) and the bottom
 *     tab bar (rendered by mobile-shell) live in THIS shell and never reload.
 *
 * mobile-shell.js still renders the bottom tab bar + the full-screen auth gate
 * here (app-shell.html is a normal top-level app page to it); this file only
 * (a) hosts the iframes, (b) intercepts tab / More-sheet clicks to swap iframes
 * instead of navigating, and (c) draws the persistent top bar. Inside each
 * iframe, mobile-shell early-returns (embed mode) and nav.js hides the page's
 * own top-nav, so the tab renders chrome-free.
 *
 * Modeled on the proven rm/js/workflow-shell.js iframe host.
 */
(function () {
  'use strict';

  var HOME = '/rm/pages/my-week.html';
  // Warm these in the background after boot so the FIRST switch is instant too.
  var PRELOAD = ['/rm/pages/my-week.html', '/rm/pages/tasks.html', '/rm/pages/chat.html'];

  // Keep in sync with brand/ourlab-mark.svg — turned 90° CCW, well opens
  // downward, inlet reads as an "L". (This shell is orphaned as of V3.574,
  // but the mark is kept current in case it's ever revived.)
  var OURLAB_MARK_SVG =
    '<svg class="ourlab-mark" viewBox="0 0 240 240" aria-hidden="true" xmlns="http://www.w3.org/2000/svg">' +
      '<defs><linearGradient id="ourlab-flow-tb" gradientUnits="userSpaceOnUse" x1="120" y1="194" x2="162" y2="57">' +
        '<stop offset="0" stop-color="#3D7DF6"/><stop offset="1" stop-color="#2CD4F0"/></linearGradient></defs>' +
      '<g fill="none" stroke="url(#ourlab-flow-tb)" stroke-width="30" stroke-linecap="round" stroke-linejoin="round">' +
        '<path d="M152 199 H116 V113"/><path d="M153 143 A58 58 0 1 0 78 143"/></g>' +
      '<circle cx="116" cy="95" r="23" fill="#FFB547"/>' +
    '</svg>';

  var _frames = {};   // pathKey -> { wrap, iframe }
  var _active = null;

  function esc(s) {
    return String(s == null ? '' : s).replace(/[&<>"']/g, function (c) {
      return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c];
    });
  }
  function labGroup() {
    try {
      if (window.OURLAB_SHELL && OURLAB_SHELL.getLabGroup) return OURLAB_SHELL.getLabGroup();
      return localStorage.getItem('ourlab-labgroup') || 'McGheeLab';
    } catch (e) { return 'McGheeLab'; }
  }

  function pathKey(href) { return String(href || '').split('#')[0].split('?')[0]; }

  function host() { return document.getElementById('app-frames'); }

  function ensureFrame(href) {
    var key = pathKey(href);
    if (_frames[key]) return _frames[key];
    var h = host();
    if (!h) return null;
    var wrap = document.createElement('div');
    wrap.className = 'app-frame-wrap';
    wrap.style.display = 'none';
    var f = document.createElement('iframe');
    f.className = 'app-frame';
    // NEUTRAL name (NOT rm-embed/rm-shell) + NO ?embed=1 — the page loads with
    // FULL functionality (mobile-shell hides its top nav via CSS + turns on the
    // app UX). Triggering the pages' split-view embed mode would suppress
    // features (chat messages, scheduler). The iframe is same-origin so it
    // shares the shell's signed-in Firebase instance (firebase-bridge adopts it).
    f.name = 'ourlab-tab-' + key.replace(/[^a-z0-9]+/gi, '-');
    f.setAttribute('title', key);
    f.src = href;
    wrap.appendChild(f);
    h.appendChild(wrap);
    var rec = { wrap: wrap, iframe: f, key: key };
    _frames[key] = rec;
    return rec;
  }

  function setActiveTab(key) {
    var tabs = document.querySelectorAll('.ourlab-tabbar a[href]');
    for (var i = 0; i < tabs.length; i++) {
      var ak = pathKey(tabs[i].getAttribute('href'));
      if (ak === key) tabs[i].classList.add('ot-active');
      else tabs[i].classList.remove('ot-active');
    }
  }

  function showPage(href) {
    var key = pathKey(href);
    ensureFrame(href);
    Object.keys(_frames).forEach(function (k) {
      _frames[k].wrap.style.display = (k === key) ? '' : 'none';
    });
    _active = key;
    setActiveTab(key);
    // haptic tick to match native tab feel
    try {
      var H = window.Capacitor && Capacitor.Plugins && Capacitor.Plugins.Haptics;
      if (H && H.impact) H.impact({ style: 'LIGHT' });
    } catch (e) { /* garnish */ }
  }

  /* Intercept in-app rm-page links (bottom tab bar + More sheet items) so they
   * swap the iframe instead of navigating the whole shell. Capture phase so we
   * run before the <a> default. */
  function attachClickHijack() {
    document.addEventListener('click', function (ev) {
      var a = ev.target.closest && ev.target.closest('a[href]');
      if (!a) return;
      var href = a.getAttribute('href');
      if (!href || href.charAt(0) === '#') return;
      if (!/\/rm\/pages\//.test(href)) return;         // only in-app pages
      ev.preventDefault();
      ev.stopPropagation();
      var sheet = a.closest('.ourlab-sheet-back');       // close the More sheet
      if (sheet && sheet.parentNode) sheet.parentNode.removeChild(sheet);
      showPage(href);
    }, true);
  }

  /* Push-notification deep links + any programmatic navigation route THROUGH
   * the shell (mobile-push dispatches this instead of location.href in-shell). */
  function attachNavEvents() {
    window.addEventListener('rm:app:navigate', function (e) {
      var href = e && e.detail && e.detail.href;
      if (href) showPage(href);
    });
  }

  /* ── persistent top bar (Ourlab · lab group · account) ── */
  function buildTopBar() {
    if (document.getElementById('app-topbar')) return;
    var bar = document.createElement('div');
    bar.id = 'app-topbar';
    bar.innerHTML =
      '<span class="app-tb-brand">' + OURLAB_MARK_SVG +
        '<span class="app-tb-name">' + esc(labGroup()) + '</span></span>' +
      '<button type="button" class="app-tb-avatar" id="app-tb-avatar" aria-label="Account">·</button>';
    document.body.appendChild(bar);
    var av = document.getElementById('app-tb-avatar');
    if (av) av.addEventListener('click', function () {
      if (window.OURLAB_SHELL && OURLAB_SHELL.openMore) OURLAB_SHELL.openMore();
    });
  }

  function updateAvatar() {
    var av = document.getElementById('app-tb-avatar');
    if (!av) return;
    var name = '';
    try {
      if (typeof firebridge !== 'undefined') {
        var p = firebridge.getProfile && firebridge.getProfile();
        var u = firebridge.getUser && firebridge.getUser();
        name = (p && p.name) || (u && (u.displayName || u.email)) || '';
      }
    } catch (e) {}
    var initials = name ? name.split(/\s+/).map(function (w) { return w[0] || ''; }).join('').slice(0, 2).toUpperCase() : '·';
    av.textContent = initials;
  }

  /* Warm the other main tabs in the background after the first is up, so even
   * the first switch to them is instant. Staggered + low-key. */
  function preloadOthers() {
    var i = 0;
    (function next() {
      if (i >= PRELOAD.length) return;
      var href = PRELOAD[i++];
      if (!_frames[pathKey(href)]) ensureFrame(href);   // created hidden
      setTimeout(next, 900);
    })();
  }

  function waitAuthThenBoot() {
    if (typeof firebridge === 'undefined' || !firebridge.onAuth) { setTimeout(waitAuthThenBoot, 80); return; }
    firebridge.onAuth(function (user) {
      updateAvatar();
      if (user) {
        if (!_active) {
          showPage(HOME);
          setTimeout(preloadOthers, 1500);
        }
      } else {
        // Signed out — mobile-shell's full-screen auth gate covers everything;
        // keep the (empty) host hidden.
        Object.keys(_frames).forEach(function (k) { _frames[k].wrap.style.display = 'none'; });
        _active = null;
      }
    });
  }

  function boot() {
    if (!host()) {
      var main = document.createElement('div');
      main.id = 'app-frames';
      document.body.appendChild(main);
    }
    buildTopBar();
    attachClickHijack();
    attachNavEvents();
    waitAuthThenBoot();
  }

  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', boot);
  else boot();
})();
