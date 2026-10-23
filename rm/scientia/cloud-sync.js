/* ================================================================
   cloud-sync.js — Gabe's Scientia build talks to the lab's cloud hub (V3.857)
   ================================================================
   Loaded by rm/scientia/scientia.html BEFORE Gabe's app script (the
   only change to his build; scripts/scientia_patch.py re-applies it to
   a new build). It makes the untouched app behave as a DEVICE of "the
   computer that holds the record" — except the computer is the
   scientiaHub Cloud Function, one record per lab member, under
   userData/{uid}/scientia/hub.

   - The relative `api/…` fetches the build makes go to the function
     with the person's Firebase ID token. `hello` says `local:false`,
     so Gabe's own rules apply: no whole-record replace from here,
     browser-kept blobs stay here, no service worker.
   - `api/sync/pull?wait=25` waits on a Firestore listener of the hub
     doc (seq / conflictsN) instead of holding the function open, then
     calls pull once — idle costs nothing.
   - First sign-in with an EMPTY hub and notes already in this browser
     (the V3.832 sandbox era): what the browser holds becomes the hub's
     first record, so nothing made in the sandbox is lost.
   - `images/…` and `recordings/…` resolve through the media map
     (Storage download URLs): MEDIA.url is patched after load, fetches
     are redirected, and a MutationObserver fixes src/href attributes.
   - Signed out: the pairing screen the build would show is replaced
     with a "sign in on the lab site" card.
   ================================================================ */
(function () {
  'use strict';
  if (window.__sisCloud) return;
  var FN = 'https://us-central1-mcgheelab-f56cc.cloudfunctions.net/scientiaHub';
  var SDK = 'https://www.gstatic.com/firebasejs/10.14.0/';
  var CFG = { apiKey: 'AIzaSyAnkKivjCcjAS8_Lp-R2JSIG4wSDSJBFI0', authDomain: 'mcgheelab-f56cc.firebaseapp.com', projectId: 'mcgheelab-f56cc',
    storageBucket: 'mcgheelab-f56cc.firebasestorage.app', messagingSenderId: '665438582202', appId: '1:665438582202:web:57416863d588bcdeff9983' };
  var S = { user: null, ready: null, seq: -1, conflictsN: -1, waiters: [], media: {}, mediaAt: 0, mediaP: null, firstUpload: null };
  window.__sisCloud = S;

  function load(src) { return new Promise(function (res, rej) { var s = document.createElement('script'); s.src = src; s.onload = res; s.onerror = rej; document.head.appendChild(s); }); }
  S.ready = (async function () {
    try { await load(SDK + 'firebase-app-compat.js'); await load(SDK + 'firebase-auth-compat.js'); await load(SDK + 'firebase-firestore-compat.js'); }
    catch (e) { console.warn('[cloud-sync] Firebase SDK did not load', e); return null; }
    try { if (!firebase.apps.length) firebase.initializeApp(CFG); } catch (e) { console.warn('[cloud-sync] init', e); return null; }
    var user = await new Promise(function (res) { var off = firebase.auth().onAuthStateChanged(function (u) { off(); res(u); }); });
    S.user = user;
    if (user) listen(user.uid);
    return user;
  })();
  function listen(uid) {
    try {
      firebase.firestore().doc('userData/' + uid + '/scientia/hub').onSnapshot(function (snap) {
        var d = snap.data() || {}; S.seq = d.seq || 0; S.conflictsN = d.conflictsN || 0;
        var w = S.waiters.splice(0); w.forEach(function (f) { f(); });
      }, function (err) { console.warn('[cloud-sync] hub listener', err && err.message); });
    } catch (e) { console.warn('[cloud-sync] listen', e); }
  }
  async function token() { var u = S.user || (window.firebase && firebase.auth().currentUser); return u ? u.getIdToken() : null; }
  var realFetch = window.fetch.bind(window);
  function json(obj, status) { return new Response(JSON.stringify(obj), { status: status || 200, headers: { 'Content-Type': 'application/json' } }); }
  function waitChange(since, known, ms) {
    if (S.seq > since || (known >= 0 && S.conflictsN >= 0 && S.conflictsN !== known)) return Promise.resolve();
    return new Promise(function (res) { var t = setTimeout(done, ms); function done() { clearTimeout(t); res(); } S.waiters.push(done); });
  }
  async function hub(path, init) {
    var headers = Object.assign({}, (init && init.headers) || {}, { Authorization: 'Bearer ' + (await token()) });
    return realFetch(FN + '/' + path, Object.assign({}, init || {}, { headers: headers }));
  }

  /* ---- media map: images/… and recordings/… → Storage download URLs ---- */
  function refreshMedia() {
    if (S.mediaP) return S.mediaP;
    S.mediaP = hub('api/media/list').then(function (r) { return r.ok ? r.json() : null; }).then(function (j) {
      if (j && j.files) { S.media = j.files; S.mediaAt = Date.now(); fixAttrs(document); }
    }).catch(function () {}).then(function () { S.mediaP = null; });
    return S.mediaP;
  }
  function mapped(p) { try { p = decodeURIComponent(p); } catch (e) {} return S.media[p] || null; }
  async function mediaUrl(p) {
    var u = mapped(p); if (u) return u;
    if (S.user && Date.now() - S.mediaAt > 5000) { await refreshMedia(); u = mapped(p); }
    return u;
  }
  var ATTRS = ['src', 'href', 'poster', 'data'];
  function fixEl(el) {
    for (var i = 0; i < ATTRS.length; i++) {
      var v = el.getAttribute && el.getAttribute(ATTRS[i]);
      if (v && /^(images|recordings)\//.test(v)) { var u = mapped(v); if (u) el.setAttribute(ATTRS[i], u); else if (S.user && Date.now() - S.mediaAt > 5000) refreshMedia(); }
    }
  }
  function fixAttrs(root) { if (!root || !root.querySelectorAll) return; if (root.nodeType === 1) fixEl(root); root.querySelectorAll('[src^="images/"],[href^="images/"],[poster^="images/"],[data^="images/"],[src^="recordings/"],[href^="recordings/"]').forEach(fixEl); }
  function signInCard(screen) {
    if (S.user) return;
    var card = screen.querySelector('.dv-card'); if (!card) return;
    card.innerHTML = '<div class="dv-logo">SiS</div><h2>Sign in to open your notebook</h2><p>Your Scientia notebook is saved to your lab account and syncs with your computer. Open it from the lab site, signed in.</p>' +
      '<p><a class="btn pri" href="/rm/pages/notebook.html?notebook=scientia" target="_top">Open the Lab Notebook</a></p><p class="tiny muted">Already signed in there? Reload this page.</p>';
  }
  function observe() {
    try {
      new MutationObserver(function (muts) {
        for (var i = 0; i < muts.length; i++) {
          var m = muts[i];
          if (m.type === 'attributes') { fixEl(m.target); continue; }
          for (var j = 0; j < m.addedNodes.length; j++) { var n = m.addedNodes[j]; if (n.nodeType !== 1) continue; fixAttrs(n); if (n.classList && n.classList.contains('dv-screen')) signInCard(n); }
        }
      }).observe(document.documentElement, { childList: true, subtree: true, attributes: true, attributeFilter: ATTRS });
    } catch (e) {}
  }

  /* ---- the first record: what this browser already holds, when the hub is empty ---- */
  function browserHasNotes() { try { return typeof DB !== 'undefined' && (DB.all('projects').length || DB.all('documents').length || DB.all('library').length); } catch (e) { return false; } }
  async function uploadBrowser() {
    var data = await DB.exportAll();
    ['blobs', 'journal', 'datasets'].forEach(function (s) { delete data.stores[s]; delete data.counts[s]; });
    data.reason = 'first-online'; data.savedAt = new Date().toISOString();
    var r = await hub('api/snapshot', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(data) });
    var j = await r.json().catch(function () { return null; });
    if (!r.ok || !j || !j.ok) throw new Error((j && j.error) || ('HTTP ' + r.status));
    return j;
  }

  /* ---- the fetch override ---- */
  window.fetch = async function (input, init) {
    var u = typeof input === 'string' ? input : (input && input.url) || '';
    if (!/^(api|images|recordings)\//.test(u)) return realFetch(input, init);
    var user = await S.ready;
    if (/^(images|recordings)\//.test(u)) { var url = await mediaUrl(u); return url ? realFetch(url) : new Response('', { status: 404 }); }
    var path = u.split('?')[0], qs = u.indexOf('?') >= 0 ? u.slice(u.indexOf('?') + 1) : '';
    if (!user) {
      if (path === 'api/sync/hello') return json({ ok: true, auth: false, local: false, notebook: false, sid: null, seq: 0, records: 0, savedAt: null, conflicts: 0 });
      return json({ ok: false, error: 'not signed in' }, 401);
    }
    if (path === 'api/sync/pull') {
      var p = new URLSearchParams(qs), known = p.has('c') ? Number(p.get('c')) : -1;
      await waitChange(Number(p.get('since') || 0), known, (Number(p.get('wait')) || 25) * 1000);
    }
    var r = await hub(u, init);
    if (path === 'api/sync/hello' && r.ok) {
      var j = await r.clone().json().catch(function () { return null; });
      if (j && j.auth) {
        refreshMedia();
        if (!j.records && !j.seq && browserHasNotes() && !S.firstUpload) {
          S.firstUpload = uploadBrowser();
          try { await S.firstUpload; r = await hub('api/sync/hello'); } catch (e) { console.warn('[cloud-sync] first upload failed', e); }
        }
      }
    }
    if ((path === 'api/media' || path === 'api/rec') && r.ok) {
      r.clone().json().then(function (x) { if (x && x.ok && x.path && x.url) { S.media[x.path] = x.url; fixAttrs(document); } }).catch(function () {});
    }
    return r;
  };

  document.addEventListener('DOMContentLoaded', function () {
    try { if (typeof MEDIA !== 'undefined' && MEDIA && MEDIA.url) { var orig = MEDIA.url; MEDIA.url = function (rec) { var p = orig.call(MEDIA, rec); return (p && mapped(p)) || p; }; } } catch (e) {}
    try { if (typeof SYNC !== 'undefined' && SYNC) SYNC.registerSW = function () {}; } catch (e) {}
    observe();
    post({ type: 'ready', hash: location.hash });
  });

  /* ---- V3.864 — embedded in the Lab Notebook (rm/js/notebook-scientia.js): the notebook's tabs
     open a note here, ＋ makes a new one, and the open note is reported back so its tab lights up ---- */
  function post(msg) { try { if (window.parent && window.parent !== window) window.parent.postMessage(Object.assign({ sis: true }, msg), location.origin); } catch (e) {} }
  window.addEventListener('hashchange', function () { post({ type: 'route', hash: location.hash }); });
  window.addEventListener('message', function (e) {
    if (e.origin !== location.origin || e.source !== window.parent || !e.data || !e.data.sisCmd) return;
    var d = e.data;
    if (d.sisCmd === 'go' && typeof d.hash === 'string' && /^#\//.test(d.hash)) { if (location.hash !== d.hash) location.hash = d.hash; else post({ type: 'route', hash: location.hash }); }
    else if (d.sisCmd === 'new') { try { if (typeof App !== 'undefined' && App.newDoc) App.newDoc(); } catch (err) { console.warn('[cloud-sync] new note', err); } }
  });
})();
