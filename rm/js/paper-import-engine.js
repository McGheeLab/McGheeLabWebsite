/* paper-import-engine.js — run the FULL paper-bundle materialization on the
 * LIST page, off a headless PaperYjs connection, with per-phase progress and
 * NO navigation. (V3.491, program plan V3.490.)
 *
 * Before this, import created the paper row and navigated to the editor, which
 * did the heavy work (figures/references/PDFs) on first open. Now the whole
 * pipeline runs at import time so the user sees progress and the finished paper
 * simply appears in the list to open when they choose.
 *
 * Grant PDF attachments no longer become manuscript sections — they are routed
 * to the per-paper Grant Docs store `paperExports/{id}.grantDocs`. The engine
 * accepts BOTH bundle shapes: legacy (grant-doc sections carrying an
 * `uploaded_file`) and new (a top-level `grant_docs[]`); either way the PDFs
 * land in grantDocs and are filtered OUT of the section tree.
 *
 * Public API:
 *   window.PaperImportEngine.run({ manifest, assets, comments, slug, onProgress })
 *     manifest  — parsed paper.json
 *     assets    — { relpath: base64 }  (from the zip)
 *     comments  — papers/{id}/comments docs (optional)
 *     slug      — fresh paper id (row already created by the caller), or the
 *                 EXISTING paper id when mode === 'update'
 *     mode      — 'create' (default) | 'update' (V3.742 — checked-out bundle
 *                 returning to the same paper: replace tree, skip comments)
 *     onProgress(evt) — evt = { phase, done, total, label }
 *   Pure helpers exposed for tests: _partition, _grantDocList.
 */
(function () {
  'use strict';

  var COMMENTS_FN_URL = 'https://us-central1-mcgheelab-f56cc.cloudfunctions.net/restorePaperComments';
  var MIME_BY_EXT = { png: 'image/png', jpg: 'image/jpeg', jpeg: 'image/jpeg', gif: 'image/gif',
    webp: 'image/webp', svg: 'image/svg+xml', pdf: 'application/pdf' };

  function _b64ToBlob(b64, mime) {
    var bin = atob(b64), len = bin.length, bytes = new Uint8Array(len);
    for (var i = 0; i < len; i++) bytes[i] = bin.charCodeAt(i);
    return new Blob([bytes], { type: mime || 'application/octet-stream' });
  }
  function _grantKinds() { return (window.PaperSchemas && window.PaperSchemas.GRANT_ATTACHED_KINDS) || []; }
  function _isGrantKind(k) { return _grantKinds().indexOf(k) >= 0; }
  function _kindLabel(kind) {
    var L = window.PaperSchemas && window.PaperSchemas.SECTION_KIND_LABELS;
    return (L && L[kind]) || kind;
  }
  function _shortId(p) { return (window.PaperSchemas && window.PaperSchemas.shortId) ? window.PaperSchemas.shortId(p) : p + Math.random().toString(36).slice(2, 8); }
  function _today() { return new Date().toISOString().slice(0, 10); }
  function _me() { var u = (typeof firebridge !== 'undefined' && firebridge.getUser && firebridge.getUser()) || null; return u ? (u.email || u.uid) : ''; }

  /* ── Pure: split assets into figures (patched into the doc) vs grant-doc
   * PDFs (routed to grantDocs), and assemble the grant-doc worklist. ── */
  function _grantDocList(manifest) {
    var out = [];
    var assetsByOrig = {};
    (manifest.assets || []).forEach(function (a) { if (a.storage_path_original) assetsByOrig[a.storage_path_original] = a; });
    // (a) legacy: grant-doc sections carrying uploaded_file
    ((manifest.tree && manifest.tree.sections) || []).forEach(function (s) {
      if (_isGrantKind(s.kind) && s.uploaded_file && s.uploaded_file.storage_path) {
        out.push({
          kind: s.kind,
          label: (typeof s.label === 'string' && s.label) || _kindLabel(s.kind),
          filename: s.uploaded_file.filename || (s.kind + '.pdf'),
          size_bytes: s.uploaded_file.size_bytes || 0,
          storagePathOriginal: s.uploaded_file.storage_path,
          asset: assetsByOrig[s.uploaded_file.storage_path] || null,
        });
      }
    });
    // (b) new: explicit grant_docs[]
    (manifest.grant_docs || []).forEach(function (g) {
      var a = g.asset || (g.storage_path_original ? assetsByOrig[g.storage_path_original] : null);
      out.push({
        kind: g.kind,
        label: g.label || _kindLabel(g.kind),
        filename: (g.asset && g.asset.filename) || g.filename || (g.kind + '.pdf'),
        size_bytes: g.size_bytes || 0,
        storagePathOriginal: (g.asset && g.asset.storage_path_original) || g.storage_path_original || null,
        asset: a || null,
      });
    });
    return out;
  }
  function _partition(manifest) {
    var gdl = _grantDocList(manifest);
    var grantOrig = {};
    gdl.forEach(function (g) { if (g.storagePathOriginal) grantOrig[g.storagePathOriginal] = 1; });
    var figureAssets = (manifest.assets || []).filter(function (a) { return !grantOrig[a.storage_path_original]; });
    return { figureAssets: figureAssets, grantDocList: gdl };
  }

  /* ── Yjs pointer patching (mirrors paper-editor _patchStoragePointers). ── */
  function _patchBlockStorage(b, remap) {
    var attrs = b && b.get && b.get('attrs');
    if (!attrs || !attrs.get) return;
    var sp = attrs.get('storage_path');
    if (sp && remap[sp]) { attrs.set('storage_path', remap[sp].storage_path); attrs.set('download_url', remap[sp].download_url); if (remap[sp].hash) attrs.set('hash', remap[sp].hash); }
    var pj = attrs.get('panels_json');
    if (pj) {
      try {
        var panels = JSON.parse(pj), changed = false;
        panels.forEach(function (p) {
          if (p && p.storage_path && remap[p.storage_path]) {
            var r = remap[p.storage_path]; p.storage_path = r.storage_path; p.download_url = r.download_url; if (r.hash) p.hash = r.hash; changed = true;
          }
        });
        if (changed) attrs.set('panels_json', JSON.stringify(panels));
      } catch (e) { /* leave malformed */ }
    }
  }
  function _patchStoragePointers(conn, remap) {
    var paperMap = conn.yDoc.getMap('paper');
    conn.yDoc.transact(function () {
      var secs = paperMap.get('sections');
      if (secs && secs.forEach) secs.forEach(function (secMap) {
        var kids = secMap.get('children');
        if (kids && kids.forEach) kids.forEach(function (b) { _patchBlockStorage(b, remap); });
      });
      ['figure_unplaced', 'table_unplaced'].forEach(function (k) {
        var yarr = paperMap.get(k);
        if (yarr && yarr.forEach) yarr.forEach(function (b) { _patchBlockStorage(b, remap); });
      });
    }, 'import-figures');
  }

  /* ── [N] → [@key] rewrite on the headless doc (mirrors editor). ── */
  function _rewriteMarkers(conn, keyByOrder) {
    if (!keyByOrder || !keyByOrder.length || !window.REFERENCE_IMPORT) return { replaced: 0 };
    var Y = conn.Y, paperMap = conn.yDoc.getMap('paper'), replaced = 0;
    conn.yDoc.transact(function () {
      var secs = paperMap.get('sections');
      if (!secs || !secs.forEach) return;
      secs.forEach(function (secMap) {
        var kids = secMap.get('children');
        if (!kids || !kids.forEach) return;
        kids.forEach(function (blk) {
          try {
            var bodyY = blk.get('body');
            if (!(bodyY instanceof Y.Text)) return;
            var old = bodyY.toString();
            var rw = window.REFERENCE_IMPORT.rewriteNumericMarkers(old, keyByOrder);
            if (rw.text !== old) { bodyY.delete(0, bodyY.length); bodyY.insert(0, rw.text); replaced += rw.replaced; }
          } catch (be) { /* one bad block never aborts */ }
        });
      });
    }, 'import-ref-rewrite');
    return { replaced: replaced };
  }

  async function _restoreComments(slug, comments) {
    try {
      var me = (typeof firebase !== 'undefined' && firebase.auth && firebase.auth().currentUser) || null;
      if (!me) return;
      // Health probe — the CF may not be deployed; skip silently if so.
      var probe = await fetch(COMMENTS_FN_URL, { method: 'GET' }).then(function (r) { return r.ok; }).catch(function () { return false; });
      if (!probe) return;
      var idToken = await me.getIdToken();
      await fetch(COMMENTS_FN_URL, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'Authorization': 'Bearer ' + idToken },
        body: JSON.stringify({ paperId: slug, comments: comments }),
      });
    } catch (e) { console.warn('[import-engine] comment restore skipped', e); }
  }

  /* opts.mode (V3.742): 'create' (default) materializes into a fresh paper;
   * 'update' rebuilds an EXISTING paper in place from a checked-out bundle —
   * PaperTreeBuild.buildInto runs with replace:true (clear, then build, one
   * transact) and the comment restore is skipped (comments never left
   * Firestore; restoring would duplicate them). The caller owns the
   * checkout-lock lifecycle: the paper stays locked through the import and
   * is released only after this resolves. */
  async function run(opts) {
    opts = opts || {};
    var manifest = opts.manifest || {}, assets = opts.assets || {}, comments = opts.comments || [];
    var slug = opts.slug, onProgress = typeof opts.onProgress === 'function' ? opts.onProgress : function () {};
    var isUpdate = opts.mode === 'update';
    function report(phase, done, total, label) { try { onProgress({ phase: phase, done: done, total: total, label: label || '' }); } catch (e) {} }
    if (!slug) throw new Error('paper-import-engine: slug required');
    if (!window.PaperYjs || !window.PaperTreeBuild) throw new Error('paper-import-engine: PaperYjs/PaperTreeBuild not loaded');

    report('connect', 0, 1, 'Connecting…');
    var conn = await window.PaperYjs.connect(slug);
    var refItemIds = [];   // fresh library ids → Semantic Scholar enrichment (post-import)
    try {
      await conn.ready;
      var Y = conn.Y, paperMap = conn.yDoc.getMap('paper');

      // 1. Sections (narrative + references; grant-doc kinds filtered out).
      report('sections', 0, 1, isUpdate ? 'Replacing sections…' : 'Building sections…');
      conn.yDoc.transact(function () {
        window.PaperTreeBuild.buildInto(paperMap, manifest, Y, {
          /* V3.914 — a grant document written as text (a Project Summary,
           * a DMSP) stays a section the Document view and the export set in
           * the grant's look; an uploaded PDF still goes to Grant Docs */
          sectionFilter: function (s) {
            return !_isGrantKind(s.kind) || (s.children || []).some(function (b) { return String(b.body || '').trim(); });
          },
          replace: isUpdate,
        });
      }, 'import-build');
      report('sections', 1, 1, isUpdate ? 'Sections replaced' : 'Sections built');

      var part = _partition(manifest);

      // 2. Figures — upload bytes to Storage under the new id, patch pointers.
      var remap = {};
      var figs = part.figureAssets;
      if (figs.length && window.PAPER_FIGURES && window.PAPER_FIGURES.uploadImage) {
        for (var i = 0; i < figs.length; i++) {
          var a = figs[i];
          report('figures', i, figs.length, a.hash || a.relpath);
          var b64 = assets[a.relpath];
          if (!b64 || !a.storage_path_original) continue;
          try {
            var blob = _b64ToBlob(b64, MIME_BY_EXT[a.ext] || a.mime || 'application/octet-stream');
            var res = await window.PAPER_FIGURES.uploadImage(slug, blob);
            remap[a.storage_path_original] = { storage_path: res.storage_path, download_url: res.download_url, hash: res.hash, mime: res.mime };
          } catch (e) { console.warn('[import-engine] figure upload failed', a.relpath, e); }
        }
        if (Object.keys(remap).length) _patchStoragePointers(conn, remap);
      }
      report('figures', figs.length, figs.length, 'Figures placed');

      // 3. Grant docs — upload PDFs → paperExports.grantDocs (NOT sections).
      var gdl = part.grantDocList, grantEntries = [];
      if (gdl.length && window.PAPER_FIGURES && window.PAPER_FIGURES.uploadImage) {
        for (var j = 0; j < gdl.length; j++) {
          var g = gdl[j];
          report('grantdocs', j, gdl.length, g.label);
          var b64g = g.asset && g.asset.relpath ? assets[g.asset.relpath] : null;
          if (!b64g) { console.warn('[import-engine] grant-doc asset missing', g.label); continue; }
          try {
            var ext = (g.asset && g.asset.ext) || 'pdf';
            var blobg = _b64ToBlob(b64g, MIME_BY_EXT[ext] || 'application/pdf');
            var resg = await window.PAPER_FIGURES.uploadImage(slug, blobg);
            grantEntries.push({
              id: _shortId('gd-'), kind: g.kind, label: g.label, filename: g.filename,
              storage_path: resg.storage_path, download_url: resg.download_url, mime: resg.mime || 'application/pdf',
              size_bytes: g.size_bytes || 0, uploaded_by: _me(), uploaded_at: _today(),
            });
          } catch (e) { console.warn('[import-engine] grant-doc upload failed', g.label, e); }
        }
      }
      if (grantEntries.length && typeof firebridge !== 'undefined' && firebridge.db) {
        try {
          await firebridge.db().collection('paperExports').doc(slug).set({
            grantDocs: grantEntries, updatedAt: firebase.firestore.FieldValue.serverTimestamp(),
          }, { merge: true });
        } catch (e) { console.warn('[import-engine] grantDocs write failed', e); }
      }
      report('grantdocs', gdl.length, gdl.length, 'Documents attached');

      // 4. Config → paperExports.
      report('config', 0, 1, 'Saving settings…');
      if (manifest.config && typeof firebridge !== 'undefined' && firebridge.db) {
        try {
          var cfg = Object.assign({}, manifest.config);
          if (cfg.graphicalAbstract && cfg.graphicalAbstract.storage_path && remap[cfg.graphicalAbstract.storage_path]) {
            cfg.graphicalAbstract = Object.assign({}, cfg.graphicalAbstract, remap[cfg.graphicalAbstract.storage_path]);
          }
          cfg.updatedAt = firebase.firestore.FieldValue.serverTimestamp();
          cfg.updatedBy = _me();
          await firebridge.db().collection('paperExports').doc(slug).set(cfg, { merge: true });
        } catch (e) { console.warn('[import-engine] config write failed', e); }
      }
      report('config', 1, 1, 'Settings saved');

      // 5. References — into the library, linked to this paper, [N]→[@key].
      if (Array.isArray(manifest.references) && manifest.references.length && window.REFERENCE_IMPORT) {
        var n = manifest.references.length;
        report('references', 0, n, 'Placing ' + n + ' references…');
        try {
          var data = await api.load('items.json');
          var existing = (data && data.items) || [];
          var rres = window.REFERENCE_IMPORT.dedupeAndKey(manifest.references, existing);
          var fresh = window.REFERENCE_IMPORT.newItems(rres);
          if (fresh.length) await window.REFERENCE_IMPORT.commitToLibrary(fresh);
          refItemIds = fresh.map(function (x) { return x.id; });   // enrich these after import
          report('references', Math.floor(n / 2), n, 'Linking references…');
          if (window.LIBRARY_LINKS) {
            for (var r = 0; r < rres.entries.length; r++) {
              var e = rres.entries[r];
              var id = e.status === 'existing' ? e.existingId : (e.item && e.item.id);
              if (id) { try { await window.LIBRARY_LINKS.toggleDraftLink(id, slug, true); } catch (le) {} }
            }
          }
          _rewriteMarkers(conn, rres.keyByOrder);
        } catch (e) { console.warn('[import-engine] references failed', e); }
        report('references', n, n, 'References placed');
      }

      // 6. Comments (best-effort; health-gated CF). Never on update — they
      // are still in papers/{id}/comments and would double.
      if (!isUpdate && comments && comments.length) {
        report('comments', 0, 1, 'Restoring comments…');
        await _restoreComments(slug, comments);
        report('comments', 1, 1, 'Comments restored');
      }

      report('done', 1, 1, 'Import complete');
      return { ok: true, figures: Object.keys(remap).length, grantDocs: grantEntries.length, refItemIds: refItemIds };
    } finally {
      // Flush pending Yjs updates to Firestore, then close.
      try { conn.disconnect(); } catch (e) { /* ignore */ }
    }
  }

  function _sleep(ms) { return new Promise(function (r) { setTimeout(r, ms); }); }

  /* Semantic Scholar enrichment for freshly-imported references — adds the
   * abstract + per-paper reference list + cited-by that a bundle can't carry.
   * Best-effort + rate-limited; safe to interrupt (opts.shouldCancel). Run
   * AFTER the paper is in the list so it never blocks import usability. */
  async function enrichLibraryItems(ids, opts) {
    opts = opts || {};
    var onProgress = typeof opts.onProgress === 'function' ? opts.onProgress : function () {};
    var shouldCancel = typeof opts.shouldCancel === 'function' ? opts.shouldCancel : function () { return false; };
    var delay = opts.delayMs || 2500;   // SS is rate-limited; the re-check tool uses 3s
    if (!ids || !ids.length) return { enriched: 0 };
    if (!window.LIBRARY_UPLOAD || !window.LIBRARY_UPLOAD.enrichItemFromSemanticScholar ||
        !window.PAPER_SS || !window.LIBRARY_EXTRAS) {
      return { enriched: 0, skipped: 'deps-unavailable' };
    }
    // enrichItemFromSemanticScholar reads library/papers.json to find the item;
    // that route's SWR cache is separate from items.json and would miss the
    // just-created entries — bust both so enrichment sees them.
    // V3.647 — `typeof api`; `window.api` is always undefined (lexical const).
    try { if (typeof api !== 'undefined' && api.invalidate) { await api.invalidate('library/papers.json'); await api.invalidate('items.json'); } } catch (e) {}
    var enriched = 0;
    for (var i = 0; i < ids.length; i++) {
      if (shouldCancel()) break;
      onProgress(i, ids.length);
      try { await window.LIBRARY_UPLOAD.enrichItemFromSemanticScholar(ids[i]); enriched++; }
      catch (e) { /* best-effort — keep the core metadata */ }
      if (i < ids.length - 1 && !shouldCancel()) await _sleep(delay);
    }
    onProgress(ids.length, ids.length);
    // Refresh the caches so the enriched extras are visible to the next read.
    // V3.647 — `typeof api`; `window.api` is always undefined (lexical const).
    try { if (typeof api !== 'undefined' && api.invalidate) { await api.invalidate('items.json'); await api.invalidate('library/papers.json'); } } catch (e) {}
    return { enriched: enriched };
  }

  window.PaperImportEngine = {
    run: run,
    enrichLibraryItems: enrichLibraryItems,
    _partition: _partition,
    _grantDocList: _grantDocList,
    _rewriteMarkers: _rewriteMarkers,   // exposed for the harness
  };
})();
