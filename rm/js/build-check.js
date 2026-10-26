/* build-check.js — V3.916: an open RM page never keeps running old code.
 *
 * The server and the service worker already hand a reload the newest files
 * (V3.902: no-cache headers, network-first worker). What they cannot reach is
 * a tab that was opened BEFORE a deploy: its scripts are in memory, and it
 * runs them until someone reloads — which is how "I still see it wrong"
 * happens a few hours after a fix went live.
 *
 * scripts/deploy.py writes rm/build.json at every upload (sent last, so it
 * changes only once every new file is on the server). This script reads it
 * when the page starts, again whenever the tab comes back into view or gets
 * focus, and every few minutes. When the stamp changes:
 *   - the tab is hidden, or was just brought back, and nothing is being
 *     edited or recorded → reload now (the person sees the new version);
 *   - otherwise → a small bar at the bottom: "RM was updated" + Reload.
 *     Coming back to the tab later, idle, reloads then.
 * Never while a microphone/camera stream or a MediaRecorder is live (lecture
 * recordings, voice calls), never while a field has focus, never when the
 * page sets window.RM_HOLD_RELOAD (true or a function returning true).
 *
 * Off on localhost / *.local (the dev server serves files as you edit them)
 * and inside the mobile app (its rm/ is bundled at build time). Only the
 * top window checks: reloading it reloads its frames.
 *
 * Loaded by runtime-mode.js (in every RM page's <head>), or directly. */
(function () {
  'use strict';
  if (typeof window === 'undefined' || window.__rmBuildCheck) return;
  window.__rmBuildCheck = true;
  var host = (location && location.hostname) || '';
  if (!/^https?:$/.test(location.protocol) || !window.fetch) return;
  if (host === 'localhost' || host === '127.0.0.1' || host === '0.0.0.0' || /\.local$/.test(host)) return;
  try { if (window.top !== window) return; } catch (e) { return; }

  var STAMP_URL = '/rm/build.json';
  var CHECK_MS = 5 * 60 * 1000;
  var mine = null;          // the stamp this page started with
  var newer = null;         // a newer stamp, once seen
  var lastCheck = 0;
  var bar = null;

  /* ── what counts as busy ── */
  var recorders = [], streams = [];
  try {
    if (window.MediaRecorder && MediaRecorder.prototype.start) {
      var start = MediaRecorder.prototype.start;
      MediaRecorder.prototype.start = function () {
        if (recorders.indexOf(this) < 0) recorders.push(this);
        return start.apply(this, arguments);
      };
    }
    var md = navigator.mediaDevices;
    if (md && md.getUserMedia) {
      var gum = md.getUserMedia.bind(md);
      md.getUserMedia = function () {
        return gum.apply(null, arguments).then(function (s) { streams.push(s); return s; });
      };
    }
  } catch (e) { /* a browser that will not let us watch: the focus rule still holds */ }

  function recording() {
    recorders = recorders.filter(function (r) { return r.state === 'recording' || r.state === 'paused'; });
    streams = streams.filter(function (s) {
      return s.getTracks().some(function (t) { return t.readyState === 'live'; });
    });
    return recorders.length > 0 || streams.length > 0;
  }
  function editing() {
    var a = document.activeElement;
    if (!a || a === document.body || a === document.documentElement) return false;
    var tag = a.tagName;
    return tag === 'INPUT' || tag === 'TEXTAREA' || tag === 'SELECT' || a.isContentEditable;
  }
  function held() {
    var h = window.RM_HOLD_RELOAD;
    try { if (typeof h === 'function' ? h() : h) return true; } catch (e) { return true; }
    return recording() || editing();
  }

  /* ── the stamp ── */
  function fetchStamp() {
    return fetch(STAMP_URL, { cache: 'no-store', credentials: 'same-origin' })
      .then(function (r) { return r.ok ? r.json() : null; })
      .then(function (j) { return j && j.build ? String(j.build) : null; })
      .catch(function () { return null; });
  }

  function reload() {
    try { sessionStorage.setItem('rm-build-reloaded', newer || ''); } catch (e) { /* private mode */ }
    location.reload();
  }

  function showBar() {
    if (bar || !document.body) return;
    bar = document.createElement('div');
    bar.className = 'rm-build-bar';
    bar.setAttribute('role', 'status');
    bar.style.cssText = 'position:fixed;left:50%;bottom:16px;transform:translateX(-50%);z-index:2147483000;' +
      'display:flex;align-items:center;gap:10px;max-width:calc(100vw - 32px);padding:8px 10px 8px 14px;' +
      'border-radius:10px;background:#1e293b;color:#f8fafc;font:500 13px/1.3 system-ui,-apple-system,sans-serif;' +
      'box-shadow:0 6px 24px rgba(15,23,42,.28)';
    var icon = (window.ICON && ICON.svg) ? ICON.svg('arrow-path') : '';
    bar.innerHTML = (icon ? '<span style="display:inline-flex;width:16px;height:16px;flex:none">' + icon + '</span>' : '') +
      '<span>RM was updated. Reload to use the new version.</span>' +
      '<button type="button" data-act="reload" style="font:inherit;font-weight:600;padding:5px 12px;border-radius:7px;' +
      'border:0;background:#f8fafc;color:#1e293b;cursor:pointer">Reload</button>' +
      '<button type="button" data-act="later" aria-label="Later" title="Later — it reloads by itself when you come back to this tab" ' +
      'style="display:inline-flex;width:24px;height:24px;align-items:center;justify-content:center;padding:0;border:0;' +
      'border-radius:6px;background:transparent;color:#cbd5e1;cursor:pointer">' +
      ((window.ICON && ICON.svg) ? ICON.svg('x-mark') : 'Later') + '</button>';
    bar.addEventListener('click', function (e) {
      var b = e.target.closest && e.target.closest('button');
      if (!b) return;
      if (b.dataset.act === 'reload') reload();
      else { bar.remove(); bar = null; }
    });
    document.body.appendChild(bar);
  }

  /* `returning`: the tab just came back into view or got focus */
  function act(returning) {
    if (!newer) return;
    if (!held() && (document.visibilityState === 'hidden' || returning)) { reload(); return; }
    if (document.visibilityState !== 'hidden') showBar();
  }

  function check(returning) {
    var now = Date.now();
    if (!returning && now - lastCheck < 30 * 1000) return;
    lastCheck = now;
    fetchStamp().then(function (s) {
      if (!s) return;
      if (mine === null) { mine = s; return; }
      if (s !== mine) newer = s;
      act(returning);
    });
  }

  fetchStamp().then(function (s) { if (mine === null) mine = s; lastCheck = Date.now(); });
  document.addEventListener('visibilitychange', function () {
    if (document.visibilityState === 'visible') check(true);
  });
  window.addEventListener('focus', function () { check(true); });
  window.addEventListener('online', function () { check(true); });
  setInterval(function () { check(false); }, CHECK_MS);

  window.RM_BUILD = {
    stamp: function () { return mine; },
    newer: function () { return newer; },
    check: function () { check(true); },
  };
})();
