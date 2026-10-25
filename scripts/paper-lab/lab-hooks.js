/* lab-hooks.js — Paper Lab glue loaded right after fake-firebase.js
 * (V3.906). Three jobs:
 *   1. make the local user an admin lab member (users/{uid} profile);
 *   2. route Cloud Function calls the paper pages make: paperCompile →
 *      local Tectonic (/paper-lab/api/compile), everything else → a clean
 *      503 so health probes degrade the way they do before a deploy;
 *   3. window.PaperLab — helpers the headless driver uses (import a corpus
 *      bundle through the REAL import engine, build + compile the export).
 */
(function () {
  'use strict';
  var LAB = window.__PAPER_LAB__;
  if (!LAB) return;
  var db = LAB.db;

  /* 1 — profile. */
  db.doc('users/' + LAB.user.uid).get().then(function (s) {
    if (!s.exists || (s.data() || {}).role !== 'admin') {
      return db.doc('users/' + LAB.user.uid).set({
        name: 'Paper Lab', email: LAB.user.email, role: 'admin', category: 'pi',
        createdAt: firebase.firestore.FieldValue.serverTimestamp(),
      }, { merge: true });
    }
  });

  /* 2 — functions. */
  var realFetch = window.fetch.bind(window);
  window.fetch = function (input, init) {
    var url = typeof input === 'string' ? input : (input && input.url) || '';
    if (/cloudfunctions\.net\/paperCompile/.test(url) && init && init.method === 'POST') {
      var req = JSON.parse(init.body || '{}');
      return realFetch('/paper-lab/api/compile', {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ job: (req.paperId || 'paper') + '-' + Date.now(), files: req.files, figureAssets: req.figureAssets }),
      }).then(function (r) { return r.json(); }).then(function (res) {
        var out = { pdfUrl: res.pdf, log: res.log, compileId: res.job, warnings: (res.missing || []).map(function (m) { return 'missing figure ' + m; }) };
        return new Response(JSON.stringify(out), { status: res.ok ? 200 : 500, headers: { 'Content-Type': 'application/json' } });
      });
    }
    if (/cloudfunctions\.net|run\.app/.test(url)) {
      return Promise.resolve(new Response(JSON.stringify({ error: 'not available in the Paper Lab' }), { status: 503, headers: { 'Content-Type': 'application/json' } }));
    }
    return realFetch(input, init);
  };

  /* 3 — driver helpers. */
  function waitFor(fn, ms) {
    var t0 = Date.now();
    return new Promise(function (res, rej) {
      (function tick() {
        var v; try { v = fn(); } catch (e) { v = null; }
        if (v) return res(v);
        if (Date.now() - t0 > (ms || 30000)) return rej(new Error('timeout'));
        setTimeout(tick, 100);
      })();
    });
  }

  window.PaperLab = {
    waitFor: waitFor,
    flush: function () { LAB.flush(); return new Promise(function (r) { setTimeout(r, 400); }); },
    /* Import a .paperbundle.zip (by URL) through the real list-page path:
     * create the projects row the way paper-builder.js does, then run
     * PaperImportEngine with the same inputs its importer hands over. */
    importBundle: async function (zipUrl, slug) {
      var blob = await (await fetch(zipUrl)).blob();
      var zip = await window.JSZip.loadAsync(blob);
      var manifest = JSON.parse(await zip.file('paper.json').async('string'));
      var assets = {};
      var names = Object.keys(zip.files).filter(function (n) { return /^assets\//.test(n) && !zip.files[n].dir; });
      for (var i = 0; i < names.length; i++) assets[names[i]] = await zip.file(names[i]).async('base64');
      var comments = zip.file('comments.json') ? JSON.parse(await zip.file('comments.json').async('string')) : [];
      var p = manifest.paper || {};
      await db.collection('projects').doc(slug).set({
        id: slug, type: 'paper', title: p.title || slug, status: 'drafting',
        paper_type: p.paper_type || 'journal', template_id: p.template_id || (manifest.config || {}).templateId || 'mebp-journal',
        target_journal: p.target_journal || '', lead_author_uid: LAB.user.uid, coauthor_uids: [],
        created_at: new Date().toISOString().slice(0, 10), updatedAt: new Date().toISOString(),
      });
      var log = [];
      var res = await window.PaperImportEngine.run({
        manifest: manifest, assets: assets, comments: comments, slug: slug, mode: 'create',
        onProgress: function (e) { log.push(e.phase + ' ' + (e.done || 0) + '/' + (e.total || 0)); },
      });
      await window.PaperLab.flush();
      return { ok: true, result: res || null, progress: log.slice(-12) };
    },
  };
})();
