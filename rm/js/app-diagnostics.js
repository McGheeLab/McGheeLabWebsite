/* app-diagnostics.js — V3.865: the Ourlab phone app's crash reports, web side.
 *
 * The app (OurlabMobile, OurlabDiagnostics.swift) writes a report when it closes while in use (`app-exit`), when
 * Apple's MetricKit delivers a crash / hang (`native-crash`, `hang`, `cpu`), or when a page's web process dies while the
 * app is in use (`webcontent`). This file, injected FIRST into every app page by sync-rm, does the rest:
 *
 *   - keeps BREADCRUMBS (localStorage, shared by the app's webviews, last 80): page loads, tab shown / hidden, JS errors,
 *     unhandled rejections, console.error, and taps on controls — their action name or label only, never typed text;
 *   - on the visible tab, CLAIMS the pending reports (each goes to one webview), adds the breadcrumbs from before the
 *     event, UPLOADS them to Firestore crashReports/{id} once someone is signed in (done) or hands them back (release);
 *   - shows a small banner after a crash with [Share report]: the iOS share sheet with the whole report as a file, so a
 *     tester can send it on with no typing.
 *
 * Inert outside the app (no Capacitor) and in app builds without the OurlabDiagnostics plugin (breadcrumbs only).
 * Never a browser popup; every step is optional and silent on failure. */
(function () {
  'use strict';
  if (window.__OURLAB_DIAG) return;
  var cap = window.Capacitor;
  var inApp = !!(cap && typeof cap.isNativePlatform === 'function' && cap.isNativePlatform());
  if (!inApp && !window.__OURLAB_DIAG_TEST) return;

  var KEY = 'ourlab.crumbs.v1';
  var MAX = 80;
  var BANNER_KINDS = { 'native-crash': 1, 'app-exit': 1, 'webcontent': 1 };
  var AUTH_WAIT_MS = window.__OURLAB_DIAG_TEST ? 1500 : 30000;   /* how long a page waits for sign-in before handing reports back */
  var plugin = null;
  try {
    var has = cap && (typeof cap.isPluginAvailable === 'function' ? cap.isPluginAvailable('OurlabDiagnostics') : !!(cap.Plugins && cap.Plugins.OurlabDiagnostics));
    if (has) plugin = cap.Plugins.OurlabDiagnostics;
  } catch (e) {}

  function page() { try { return (location.pathname || '').replace(/^\/rm\/pages\//, '') + (location.search || ''); } catch (e) { return ''; } }
  function clip(s, n) { s = String(s == null ? '' : s); return s.length > n ? s.slice(0, n) + '…' : s; }

  /* ── breadcrumbs ───────────────────────────────────────────────── */
  var lastSig = '', lastAt = 0;
  function readCrumbs() { try { var a = JSON.parse(localStorage.getItem(KEY) || '[]'); return Array.isArray(a) ? a : []; } catch (e) { return []; } }
  function crumb(kind, msg) {
    var now = Date.now(), sig = kind + '|' + msg;
    try {
      var list = readCrumbs();
      /* a repeating error (a render loop) is one crumb with a count, not 80 copies */
      if (sig === lastSig && now - lastAt < 5000 && list.length && list[list.length - 1].k === kind && list[list.length - 1].m === msg) {
        list[list.length - 1].n = (list[list.length - 1].n || 1) + 1; list[list.length - 1].t = now;
      } else list.push({ t: now, k: kind, p: clip(page(), 120), m: clip(msg, 300) });
      lastSig = sig; lastAt = now;
      localStorage.setItem(KEY, JSON.stringify(list.slice(-MAX)));
    } catch (e) {}
  }
  function describeTarget(el) {
    for (var n = el, i = 0; n && n.nodeType === 1 && i < 6; n = n.parentElement, i++) {
      var d = n.dataset || {};
      var act = d.act || d.wbAct || d.wbMode || d.h || d.tab || d.kind;
      var tag = n.tagName.toLowerCase();
      if (act) return tag + '[' + clip(act, 40) + ']';
      if (n.id) return tag + '#' + clip(n.id, 40);
      var label = n.getAttribute('aria-label') || n.getAttribute('title');
      if (label && /^(button|a|summary|label)$/.test(tag)) return tag + '"' + clip(label, 40) + '"';
      if (/^(button|a|input|select|textarea)$/.test(tag)) return tag + (n.className ? '.' + clip(String(n.className).split(/\s+/)[0], 30) : '');
    }
    return '';
  }

  crumb('load', (document.visibilityState === 'hidden' ? 'hidden ' : '') + 'page load');
  window.addEventListener('error', function (e) {
    if (!e) return;
    if (e.message) crumb('error', e.message + (e.filename ? ' @ ' + String(e.filename).split('/').pop() + ':' + (e.lineno || 0) + ':' + (e.colno || 0) : '') + (e.error && e.error.stack ? ' | ' + String(e.error.stack).split('\n').slice(0, 3).join(' | ') : ''));
  }, true);
  window.addEventListener('unhandledrejection', function (e) {
    var r = e && e.reason;
    crumb('rejection', (r && (r.message || r.code)) ? (r.code ? r.code + ': ' : '') + (r.message || '') + (r.stack ? ' | ' + String(r.stack).split('\n').slice(0, 2).join(' | ') : '') : String(r));
  });
  try {
    var origError = console.error;
    console.error = function () {
      try { crumb('console', Array.prototype.map.call(arguments, function (a) { return a && a.message ? a.message : (typeof a === 'string' ? a : (function () { try { return JSON.stringify(a); } catch (err) { return String(a); } })()); }).join(' ')); } catch (e) {}
      return origError.apply(console, arguments);
    };
  } catch (e) {}
  document.addEventListener('visibilitychange', function () { crumb('visibility', document.visibilityState); });
  document.addEventListener('ourlab:tab-visible', function () { crumb('tab', 'shown'); note(true); });
  document.addEventListener('ourlab:tab-hidden', function () { crumb('tab', 'hidden'); });
  window.addEventListener('pagehide', function () { crumb('leave', 'page closed'); });
  document.addEventListener('click', function (e) { var d = describeTarget(e.target); if (d) crumb('tap', d); }, true);

  /* ── the native side ───────────────────────────────────────────── */
  function visibleTab() { return window.__OURLAB_TAB_VISIBLE !== false && document.visibilityState !== 'hidden'; }
  function note(active) { if (plugin && plugin.note) { try { plugin.note({ page: page(), active: !!active }).catch(function () {}); } catch (e) {} } }
  function bridge() { return (typeof firebridge !== 'undefined' && firebridge) ? firebridge : null; }   /* a lexical const, never window.firebridge */
  function sleep(ms) { return new Promise(function (r) { setTimeout(r, ms); }); }
  async function signedInUser(maxMs) {
    var t0 = Date.now();
    while (Date.now() - t0 < maxMs) {
      var b = bridge();
      var u = b && b.getUser && b.getUser();
      if (u && u.uid && b.db) return u;
      if (b && b.getUser && u === null) return null;   /* getUser() is undefined until sign-in resolves, null when nobody is signed in */
      await sleep(1000);
    }
    return null;
  }
  function crumbsBefore(r) {
    var until = Date.parse(r.createdAt || '') || Date.now();
    return readCrumbs().filter(function (c) { return c.t <= until + 1500; }).slice(-60);
  }
  function asDoc(r, u) {
    var fv = window.firebase && firebase.firestore && firebase.firestore.FieldValue;
    var mk = r.metrickit ? JSON.stringify(r.metrickit) : '';
    return {
      id: String(r.id), uid: u.uid, email: String(u.email || ''), name: String(u.displayName || ''),
      kind: String(r.kind || ''), summary: clip(r.summary || '', 500), createdAt: String(r.createdAt || ''),
      uploadedAt: fv ? fv.serverTimestamp() : new Date().toISOString(),
      app: r.app || {}, device: r.device || {}, page: clip(page(), 200),
      eventJson: clip(JSON.stringify(r.event || {}), 100000),
      metrickitJson: mk.length > 700000 ? mk.slice(0, 700000) : mk,
      breadcrumbs: r.breadcrumbs || []
    };
  }
  async function upload(reports) {
    var u = await signedInUser(AUTH_WAIT_MS);
    var ids = reports.map(function (r) { return r.id; });
    if (!u) { try { await plugin.release({ ids: ids }); } catch (e) {} return false; }
    var sent = [], failed = [];
    for (var i = 0; i < reports.length; i++) {
      try { await bridge().db().collection('crashReports').doc(String(reports[i].id)).set(asDoc(reports[i], u)); sent.push(reports[i].id); }
      catch (e) { failed.push(reports[i].id); crumb('console', 'crash report upload failed: ' + (e && e.message)); }
    }
    try { if (sent.length) await plugin.done({ ids: sent }); } catch (e) {}
    try { if (failed.length) await plugin.release({ ids: failed }); } catch (e) {}
    return failed.length === 0;
  }

  /* ── the banner ────────────────────────────────────────────────── */
  function injectStyle() {
    if (document.getElementById('odg-style')) return;
    var st = document.createElement('style'); st.id = 'odg-style';
    st.textContent = '.odg-banner{position:fixed;left:12px;right:12px;top:calc(env(safe-area-inset-top,0px) + 10px);z-index:2147483000;' +
      'display:flex;align-items:flex-start;gap:10px;padding:12px 12px 12px 14px;border-radius:14px;background:#111827;color:#f9fafb;' +
      'box-shadow:0 8px 28px rgba(15,23,42,.35);font:14px/1.35 -apple-system,system-ui,"Segoe UI",sans-serif;max-width:560px;margin:0 auto}' +
      '.odg-txt{flex:1;min-width:0}.odg-txt b{display:block;font-weight:600;margin-bottom:2px}.odg-sub{color:#cbd5e1;font-size:13px}' +
      '.odg-acts{display:flex;gap:6px;flex:none;align-items:center}' +
      '.odg-btn{border:0;border-radius:10px;padding:9px 12px;font:600 13px/1 -apple-system,system-ui,sans-serif;background:#0D675E;color:#fff;cursor:pointer;min-height:36px}' +
      '.odg-x{border:0;background:transparent;color:#cbd5e1;font:500 20px/1 system-ui,sans-serif;width:36px;height:36px;border-radius:10px;cursor:pointer}' +
      '.odg-x:focus-visible,.odg-btn:focus-visible{outline:2px solid #5eead4;outline-offset:2px}';
    (document.head || document.documentElement).appendChild(st);
  }
  function showBanner(reports, state) {
    if (!document.body) return null;
    injectStyle();
    var old = document.querySelector('.odg-banner'); if (old) old.remove();
    var web = reports.every(function (r) { return r.kind === 'webcontent'; });
    var b = document.createElement('div');
    b.className = 'odg-banner'; b.setAttribute('role', 'status'); b.setAttribute('aria-live', 'polite');
    b.innerHTML = '<div class="odg-txt"><b></b><span class="odg-sub"></span></div><div class="odg-acts">' +
      '<button type="button" class="odg-btn" data-odg="share">Share report</button>' +
      '<button type="button" class="odg-x" data-odg="close" aria-label="Dismiss">×</button></div>';
    b.querySelector('b').textContent = web ? 'A page stopped and reloaded.' : 'Ourlab closed unexpectedly last time.';
    setBannerState(b, state);
    b.addEventListener('click', function (e) {
      var a = e.target.closest('[data-odg]'); if (!a) return;
      if (a.dataset.odg === 'close') { b.remove(); return; }
      shareReports(reports);
    });
    document.body.appendChild(b);
    setTimeout(function () { if (b.isConnected) b.remove(); }, 45000);
    return b;
  }
  function setBannerState(b, state) {
    var s = b && b.querySelector('.odg-sub'); if (!s) return;
    s.textContent = state === 'sent' ? 'A report was sent to the lab. You can also share it yourself.'
      : state === 'sending' ? 'Sending a report to the lab…'
      : 'A report is ready — share it with the lab (no typing needed).';
  }
  function shareReports(reports) {
    var full = reports.length === 1 ? reports[0] : reports;
    var stamp = String((reports[0] && reports[0].createdAt) || new Date().toISOString()).slice(0, 19).replace(/[^0-9]/g, '');
    var text = JSON.stringify(full, null, 2);
    if (plugin && plugin.share) { plugin.share({ filename: 'ourlab-crash-' + stamp + '.json', text: text }).catch(function () {}); return; }
    try { if (navigator.share) navigator.share({ title: 'Ourlab crash report', text: text }); } catch (e) {}
  }

  /* ── on load: the visible tab claims, shows, uploads ───────────── */
  var running = false;
  async function collect() {
    if (!plugin || running) return;
    if (!visibleTab()) return;   /* a hidden preload would show the banner to nobody; 'ourlab:tab-visible' retries */
    running = true;
    try {
      var res = await plugin.claim();
      var reports = (res && res.reports) || [];
      if (!reports.length) return;
      reports.forEach(function (r) { r.breadcrumbs = crumbsBefore(r); r.claimedOn = page(); });
      var loud = reports.filter(function (r) { return BANNER_KINDS[r.kind]; });
      var banner = loud.length ? showBanner(loud, 'sending') : null;
      var ok = await upload(reports);
      if (banner) setBannerState(banner, ok ? 'sent' : 'ready');
    } catch (e) {
      crumb('console', 'crash report step failed: ' + (e && e.message));
    } finally { running = false; }
  }
  function boot() {
    note(visibleTab());
    setTimeout(collect, 1500);
  }
  document.addEventListener('ourlab:tab-visible', function () { setTimeout(collect, 600); });
  /* V3.867 — as soon as the HTML is parsed (not window 'load', which waits for remote images and fonts): the native side
     reads a claim as "this page is alive", and a slow network must not look like a page that never started */
  if (document.readyState !== 'loading') boot(); else document.addEventListener('DOMContentLoaded', boot);

  window.__OURLAB_DIAG = { crumb: crumb, crumbs: readCrumbs, collect: collect, hasPlugin: !!plugin };
})();
