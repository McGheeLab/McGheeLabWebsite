/* paper-export.js — orchestrator for pages/paper-export.html (V3.231)
 *
 * Reads ?paper=<id>, loads the paper meta + Yjs doc, loads / creates the
 * shared `paperExports/{paperId}` Firestore config doc, renders the
 * config form (delegated to PaperExportConfig), and wires the Compile /
 * Download / Run-checks buttons.
 *
 * Compile flow:
 *   1. buildBundle({yDoc, template, overrides, addons}) — pure, no I/O.
 *   2. Run client-side lints; surface results inline.
 *   3. POST {bundle, paperId} to the Cloud Run compile service (URL is
 *      currently a placeholder constant — `PAPER_COMPILE_URL`. Once the
 *      service is deployed, edit it here; or set
 *      window.PAPER_COMPILE_URL on the page for per-env overrides).
 *   4. Service returns { pdfUrl, log, warnings, compileId }.
 *   5. Mount the PDF in the right pane via window.PDF_VIEWER.create().
 *
 * The .zip download path uses JSZip in-browser and never hits the
 * service — useful when the compile endpoint is down or the user wants
 * to compile locally with latexmk.
 */

(function () {
  /* Paper compile endpoint URL. Points at the public Firebase Function
   * `paperCompile`, which verifies the Firebase ID token + lab role and
   * forwards the request to the private Cloud Run Tectonic service.
   * V3.231 history: we initially pointed this at the Cloud Run service
   * directly, but couldn't get public-allUsers ingress to work reliably
   * in this project. The Firebase Function inherits Firebase's
   * working public-ingress wiring. */
  var PAPER_COMPILE_URL = window.PAPER_COMPILE_URL ||
    'https://us-central1-mcgheelab-f56cc.cloudfunctions.net/paperCompile';

  var state = {
    paperId: null,
    meta: null,
    yConn: null,            // PaperYjs handle
    config: null,           // {templateId, addons, overrides}
    template: null,         // resolved template JSON
    lastBundle: null,
    lastCompile: null,
    viewer: null,           // pdf.js viewer instance
    canEdit: false,
    fullCitationByKey: null,
    /* V3.232 — compile history + staleness */
    compiles: [],           // most-recent-first list of compile records
    compilesUnsub: null,    // Firestore onSnapshot unsubscribe
    activeCompileId: null,  // which compile's PDF is currently mounted
    localBundleHash: null,  // sha256 hex of the current draft's bundle
    yjsObserveCleanup: null,
  };

  var els = {};

  document.addEventListener('DOMContentLoaded', function () {
    state.paperId = new URLSearchParams(window.location.search).get('paper');
    if (!state.paperId) {
      _fatal('No ?paper=<id> in URL. Open this page from the Export LaTeX button in the paper editor.');
      return;
    }

    /* Cache element refs once — these are read on nearly every callback. */
    [
      'px-back','px-title','px-status','px-warnings',
      'px-template','px-template-desc','px-build-target','px-float-spacing','px-column-fill','px-section-numbering','px-paper-type','px-addons','px-lints',
      'px-fig-placement','px-fig-width','px-tab-booktabs','px-tab-placement','px-eq-display',
      'px-run-lints','px-compile','px-download','px-export-portable','px-export-status',
      'px-log','px-log-wrap',
      'px-preview-title','px-zoom-out','px-zoom-in','px-fit','px-zoom-label',
      'px-stage','px-empty','px-viewer',
      /* V3.232 — compile history + staleness */
      'px-compile-list','px-staleness',
    ].forEach(function (id) { els[id] = document.getElementById(id); });

    els['px-back'].href = '/rm/pages/paper-builder.html?paper=' + encodeURIComponent(state.paperId);

    /* firebridge auto-inits (see end of rm/js/firebase-bridge.js); we just
     * wait for the auth listener to fire. */
    if (firebridge.requireSignIn) firebridge.requireSignIn('Sign in to export papers.');
    firebridge.onAuth(function (user) {
      if (!user) {
        _setStatus('Sign in required.', 'err');
        return;
      }
      _bootstrap().catch(function (err) {
        console.error('[paper-export] bootstrap failed:', err);
        _fatal('Failed to load: ' + (err && err.message ? err.message : String(err)));
      });
    });
  });

  /* ── Bootstrap ── */

  async function _bootstrap() {
    _setStatus('Loading…', 'saving');

    /* 1. Paper meta from projects/papers.json */
    var papers = await api.load('projects/papers.json');
    var rows = (papers && papers.papers) || [];
    state.meta = rows.find(function (p) { return p.id === state.paperId; });
    if (!state.meta) {
      _fatal('Paper "' + state.paperId + '" not in projects/papers.json.');
      return;
    }
    state.canEdit = firebridge.canEditPaper(state.meta);
    els['px-title'].textContent = state.meta.title || state.paperId;
    document.title = 'Export: ' + (state.meta.title || state.paperId);

    /* 2. Existing config doc from paperExports/{paperId}, or default. */
    state.config = await _loadConfig();

    /* 3. Yjs connection (read-only is fine — buildBundle reads the doc) */
    state.yConn = await window.PaperYjs.connect(state.paperId);

    /* 4. Render the form. */
    await PaperExportConfig.populateTemplateSelect(els['px-template'], state.config.templateId, state.config.paperType);
    _bindTemplateChange();
    _bindBuildTarget();   // V3.395
    _bindFloatSpacing();  // V3.408
    _bindColumnFill();    // V3.427
    _bindSectionNumbering();
    _bindGraphicalAbstract();
    _bindSubdocs();       // S-β
    _bindPaperType();     // V3.419
    PaperExportConfig.renderAddons(els['px-addons'], state.config.addons, _onAddonsChange);
    /* V3.346 — authors & affiliations editor → {{AUTHOR_BLOCK}}. */
    var authorsEl = document.getElementById('px-authors');
    if (authorsEl && PaperExportConfig.bindAuthors) {
      PaperExportConfig.bindAuthors(authorsEl, {
        authors: state.config.authors,
        affiliations: state.config.affiliations,
      }, function (cfg) {
        state.config.authors = cfg.authors;
        state.config.affiliations = cfg.affiliations;
        _scheduleSave();
      }, !state.canEdit);
      /* CRediT — compose the statement from the per-author roles and
       * write it into the paper's Author-contributions section (created
       * if absent). Explicit user action; the section stays the
       * editable source of truth. */
      if (state.canEdit && PaperExportConfig.creditStatement) {
        var crWrap = document.createElement('div');
        crWrap.className = 'px-credit-generate';
        var crGen = document.createElement('button');
        crGen.type = 'button'; crGen.className = 'btn btn-sm';
        ICON.label(crGen, 'pencil', ' Generate CRediT statement');
        crGen.title = 'Writes "A.B.: Conceptualization, …" into the Author contributions section from the roles set above';
        crGen.addEventListener('click', function () {
          var text = PaperExportConfig.creditStatement(state.config.authors || []);
          if (!text) { alert('Set CRediT roles on at least one author first (the CRediT button in each author row).'); return; }
          try {
            _writeAuthorContribSection(text);
            _setStatus('CRediT statement written to the Author contributions section.', 'saved');
            setTimeout(function () { _setStatus('', ''); }, 2500);
          } catch (e) {
            alert('Could not write the section: ' + (e.message || e));
          }
        });
        crWrap.appendChild(crGen);
        authorsEl.appendChild(crWrap);
      }
    }
    PaperExportConfig.bindOverrides(document, state.config.overrides, _onOverridesChange);
    _updateTemplateDescription();
    _renderConflictWarnings();

    /* 5. Wire actions. */
    els['px-run-lints'].addEventListener('click', _runLintsAction);
    els['px-compile'].addEventListener('click', _compileAction);
    els['px-download'].addEventListener('click', _downloadAction);
    /* V3.47x — portable paper bundle (import/export program). */
    if (els['px-export-portable']) els['px-export-portable'].addEventListener('click', _exportPortable);
    els['px-zoom-in'].addEventListener('click', function () { state.viewer && state.viewer.zoomIn && state.viewer.zoomIn(); });
    els['px-zoom-out'].addEventListener('click', function () { state.viewer && state.viewer.zoomOut && state.viewer.zoomOut(); });
    els['px-fit'].addEventListener('click', function () { state.viewer && state.viewer.fitToWidth && state.viewer.fitToWidth(); });

    if (!state.canEdit) {
      /* Read-only members can run checks / download bundle but not change
       * the shared config or trigger compiles billed against the lab. */
      els['px-compile'].disabled = true;
      els['px-compile'].title = 'Compile is restricted to lab contributors.';
    }

    /* 6. V3.232 — subscribe to compile history, auto-mount the newest
     * PDF, refresh staleness whenever either the local Yjs doc or the
     * compile list changes. */
    _subscribeCompiles();
    _watchYjsForStaleness();

    _setStatus('Loaded', 'saved');
    setTimeout(function () { _setStatus('', ''); }, 1500);
  }

  /* ── Submission documents (S-β) ─────────────────────────────────
   * Cover letter / rebuttal live as sections in the paper (excluded
   * from the manuscript); each compiles through its own mini-template
   * via PaperSubdocs.buildSubdocBundle. This card offers .zip download
   * now; the service Compile button unlocks with the docKind server
   * update (S-γ). Journal papers only. */
  function _bindSubdocs() {
    var section = document.getElementById('px-subdocs-section');
    var host = document.getElementById('px-subdocs');
    if (!section || !host || !window.PaperSubdocs) return;
    if ((state.config.paperType || 'journal') !== 'journal') { section.hidden = true; return; }
    section.hidden = false;
    host.innerHTML = '';
    window.PaperSubdocs.DOCS.forEach(function (doc) {
      var row = document.createElement('div');
      row.className = 'px-subdoc-row';
      var info = document.createElement('div');
      info.className = 'px-subdoc-info';
      var title = document.createElement('div');
      title.className = 'px-subdoc-title';
      title.textContent = doc.label;
      var status = window.PaperSubdocs.sectionsPresent(state.yConn.yDoc, doc.docKind);
      var hint = document.createElement('div');
      hint.className = 'px-subdoc-hint';
      hint.textContent = status.present
        ? (status.hasContent ? doc.hint : 'Section exists but is empty — write it in the editor.')
        : 'No section yet — add "' + doc.label + '" via + Add section in the editor.';
      info.appendChild(title);
      info.appendChild(hint);
      row.appendChild(info);
      var zipBtn = document.createElement('button');
      zipBtn.type = 'button'; zipBtn.className = 'btn btn-sm';
      ICON.label(zipBtn, 'arrow-down-tray', ' .zip');
      zipBtn.title = 'Download the LaTeX bundle (compile locally with latexmk)';
      zipBtn.disabled = !status.hasContent;
      zipBtn.addEventListener('click', function () { _downloadSubdocZip(doc); });
      row.appendChild(zipBtn);
      var compBtn = document.createElement('button');
      compBtn.type = 'button'; compBtn.className = 'btn btn-sm';
      compBtn.textContent = 'Compile';
      var serviceReady = _serviceHasDocKind();
      compBtn.disabled = !(state.canEdit && status.hasContent && serviceReady);
      compBtn.title = !serviceReady
        ? 'Unlocks after the compile-service update — run one normal compile once the new service is deployed.'
        : (status.hasContent ? 'Compile this document to PDF on the service' : 'Write the section first');
      compBtn.addEventListener('click', function () { _compileSubdoc(doc); });
      row.appendChild(compBtn);
      /* Last compile of THIS kind (S-γ) — quick open link. */
      var last = (state.compiles || []).filter(function (c) { return c.docKind === doc.docKind; })[0];
      if (last && last.pdfStoragePath) {
        var lastLink = document.createElement('button');
        lastLink.type = 'button'; lastLink.className = 'btn btn-sm';
        ICON.label(lastLink, 'arrow-top-right-on-square', ' last PDF');
        lastLink.title = 'Open the most recent ' + doc.label + ' compile';
        lastLink.addEventListener('click', function () { _openCompilePdf(last); });
        row.appendChild(lastLink);
      }
      host.appendChild(row);
    });
  }

  /* Gate detection (S-γ/D2): the updated compile service stamps docKind
   * on every compile doc — its presence on ANY compile means the new
   * image is live. */
  function _serviceHasDocKind() {
    return (state.compiles || []).some(function (c) { return typeof c.docKind === 'string'; });
  }

  function _openCompilePdf(c) {
    firebase.storage().ref(c.pdfStoragePath).getDownloadURL()
      .then(function (u) { window.open(u, '_blank'); })
      .catch(function (e) { _setStatus('Could not open the PDF: ' + (e.message || e), 'err'); });
  }

  async function _compileSubdoc(doc) {
    try {
      _setStatus('Building ' + doc.label + '…', 'saving');
      var bundle = await window.PaperSubdocs.buildSubdocBundle({
        docKind: doc.docKind,
        paperId: state.paperId,
        yDoc: state.yConn.yDoc,
        authorsCfg: { authors: state.config.authors || [], affiliations: state.config.affiliations || [] },
        fullItemsByKey: state.fullCitationByKey ||
          (state.fullCitationByKey = await _loadFullCitations()),
        leadAuthor: state.meta.lead_author || '',
      });
      _setStatus('Compiling ' + doc.label + '…', 'compiling');
      var user = firebridge.getUser();
      var idToken = user ? await user.getIdToken() : null;
      var resp = await fetch(PAPER_COMPILE_URL, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'Authorization': 'Bearer ' + (idToken || ''),
        },
        body: JSON.stringify({
          paperId: state.paperId,
          templateId: doc.templateId,
          addons: [],
          files: bundle.files,
          figureAssets: bundle.figureAssets || [],
          docKind: doc.docKind,
        }),
      });
      if (!resp.ok) {
        var body = await resp.text();
        throw new Error('Compile service ' + resp.status + ': ' + body.slice(0, 300));
      }
      var result = await resp.json();
      if (result.pdfUrl) window.open(result.pdfUrl, '_blank');
      _setStatus(doc.label + ' compiled.', 'saved');
      setTimeout(function () { _setStatus('', ''); }, 2000);
    } catch (err) {
      console.error('[paper-export] subdoc compile failed:', err);
      _setStatus(doc.label + ' compile failed: ' + (err.message || err), 'err');
    }
  }

  /* ── Marked-up revision diffs (D2) ─────────────────────────────
   * Pick any past MAIN compile that stored its flat source; the service
   * latexdiffs it against the CURRENT draft and compiles the marked-up
   * PDF (underline = added, strikeout = removed). */
  function _bindDiffUI() {
    var row = document.getElementById('px-diff-row');
    var sel = document.getElementById('px-diff-base');
    var go = document.getElementById('px-diff-go');
    var list = document.getElementById('px-diff-list');
    if (!row || !sel || !go || !list) return;
    if (!_serviceHasDocKind()) { row.hidden = true; list.hidden = true; return; }
    var bases = mainCompiles().filter(function (c) { return c.flatStoragePath; });
    row.hidden = false;
    sel.innerHTML = '';
    if (!bases.length) {
      var opt0 = document.createElement('option');
      opt0.textContent = 'no stored sources yet — compile once';
      sel.appendChild(opt0);
      go.disabled = true;
    } else {
      bases.slice(0, 20).forEach(function (c) {
        var opt = document.createElement('option');
        opt.value = c.compileId || c.id;
        opt.textContent = _formatWhen(c.triggeredAt) + ' · ' + (c.templateId || '');
        opt.dataset.templateId = c.templateId || '';
        sel.appendChild(opt);
      });
      go.disabled = !state.canEdit;
    }
    if (!go.dataset.wired) {
      go.dataset.wired = '1';
      go.addEventListener('click', _compileDiff);
    }
    /* Existing diffs list. */
    var diffs = (state.compiles || []).filter(function (c) { return c.docKind === 'diff'; });
    list.hidden = !diffs.length;
    list.innerHTML = diffs.slice(0, 10).map(function (c) {
      return '<li class="px-compile-item"><span>Δ ' + _formatWhen(c.triggeredAt) +
        ' · vs ' + String(c.baseCompileId || '').slice(0, 6) + '</span>' +
        '<button class="btn btn-sm px-diff-open" data-id="' + (c.compileId || c.id) + '">open</button></li>';
    }).join('');
    list.querySelectorAll('.px-diff-open').forEach(function (btn) {
      btn.addEventListener('click', function () {
        var c = diffs.find(function (d) { return (d.compileId || d.id) === btn.dataset.id; });
        if (c) _openCompilePdf(c);
      });
    });
  }

  async function _compileDiff() {
    var sel = document.getElementById('px-diff-base');
    var baseId = sel && sel.value;
    if (!baseId) return;
    var baseTpl = sel.selectedOptions[0] && sel.selectedOptions[0].dataset.templateId;
    if (baseTpl && baseTpl !== state.config.templateId &&
        !window.confirm('The base compile used a different template (' + baseTpl +
          ' vs ' + state.config.templateId + ') — the diff may be unreliable. Continue?')) {
      return;
    }
    try {
      _setStatus('Building bundle…', 'saving');
      var bundle = await _buildBundleNow();
      _setStatus('Compiling marked-up diff…', 'compiling');
      var user = firebridge.getUser();
      var idToken = user ? await user.getIdToken() : null;
      var resp = await fetch(PAPER_COMPILE_URL, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'Authorization': 'Bearer ' + (idToken || ''),
        },
        body: JSON.stringify({
          paperId: state.paperId,
          templateId: state.config.templateId,
          addons: state.config.addons,
          files: bundle.files,
          figureAssets: bundle.figureAssets || [],
          mode: 'diff',
          baseCompileId: baseId,
          flatSource: _flattenBundle(bundle),
          docKind: 'diff',
        }),
      });
      if (!resp.ok) {
        var body = await resp.text();
        throw new Error('Diff service ' + resp.status + ': ' + body.slice(0, 300));
      }
      var result = await resp.json();
      if (result.pdfUrl) window.open(result.pdfUrl, '_blank');
      _setStatus('Marked-up diff compiled. Note: bibliography changes are not marked (latexdiff limitation).', 'saved');
      setTimeout(function () { _setStatus('', ''); }, 4000);
    } catch (err) {
      console.error('[paper-export] diff failed:', err);
      _setStatus('Diff failed: ' + (err.message || err), 'err');
    }
  }

  async function _downloadSubdocZip(doc) {
    try {
      _setStatus('Building ' + doc.label + '…', 'saving');
      var bundle = await window.PaperSubdocs.buildSubdocBundle({
        docKind: doc.docKind,
        paperId: state.paperId,
        yDoc: state.yConn.yDoc,
        authorsCfg: { authors: state.config.authors || [], affiliations: state.config.affiliations || [] },
        fullItemsByKey: state.fullCitationByKey ||
          (state.fullCitationByKey = await _loadFullCitations()),
        leadAuthor: state.meta.lead_author || '',
      });
      var zip = new window.JSZip();
      bundle.files.forEach(function (f) { zip.file(f.relpath, f.content); });
      var blob = await zip.generateAsync({ type: 'blob' });
      var url = URL.createObjectURL(blob);
      var a = document.createElement('a');
      a.href = url;
      a.download = state.paperId + '-' + doc.docKind + '.zip';
      document.body.appendChild(a);
      a.click();
      a.remove();
      setTimeout(function () { URL.revokeObjectURL(url); }, 2000);
      _setStatus('Downloaded', 'saved');
      setTimeout(function () { _setStatus('', ''); }, 1500);
    } catch (err) {
      console.error('[paper-export] subdoc zip failed:', err);
      _setStatus('Download failed: ' + (err.message || err), 'err');
    }
  }

  /* ── Graphical abstract (M2) ────────────────────────────────────
   * One image on paperExports.graphicalAbstract, uploaded through the
   * figure Storage pipeline (PAPER_FIGURES.uploadImage — dedup by
   * content hash, same paper-figures/{paperId}/ folder). */
  function _bindGraphicalAbstract() {
    var host = document.getElementById('px-graphical-abstract');
    if (!host) return;
    function render() {
      host.innerHTML = '';
      var ga = state.config.graphicalAbstract;
      if (ga && ga.download_url) {
        var img = document.createElement('img');
        img.className = 'px-ga-thumb';
        img.src = ga.download_url;
        img.alt = 'Graphical abstract';
        host.appendChild(img);
      }
      if (!state.canEdit) {
        if (!ga) host.textContent = 'None uploaded.';
        return;
      }
      var pick = document.createElement('input');
      pick.type = 'file';
      pick.accept = 'image/png,image/jpeg,image/webp';
      pick.className = 'px-ga-pick';
      pick.addEventListener('change', function () {
        var file = pick.files && pick.files[0];
        if (!file || !window.PAPER_FIGURES) return;
        _setStatus('Uploading graphical abstract…', 'saving');
        window.PAPER_FIGURES.uploadImage(state.paperId, file).then(function (res) {
          state.config.graphicalAbstract = {
            storage_path: res.storage_path,
            download_url: res.download_url,
            hash: res.hash,
            mime: res.mime,
          };
          _scheduleSave();
          _setStatus('Graphical abstract uploaded.', 'saved');
          setTimeout(function () { _setStatus('', ''); }, 1500);
          render();
        }).catch(function (e) {
          _setStatus('Upload failed: ' + (e.message || e), 'err');
        });
      });
      host.appendChild(pick);
      if (ga) {
        var rm = document.createElement('button');
        rm.type = 'button'; rm.className = 'btn btn-sm';
        ICON.label(rm, 'x-mark', ' Remove');
        rm.addEventListener('click', function () {
          state.config.graphicalAbstract = null;
          _scheduleSave();
          render();
        });
        host.appendChild(rm);
      }
    }
    render();
  }

  /* ── CRediT → Author-contributions section ─────────────────────
   * Writes the generated statement into the paper's Author-contributions
   * section (found by `special` key or label; created when absent —
   * mirroring paper-editor's appendSectionFromTree shapes: label Y.Text,
   * children Y.Array, paragraph {skeleton/body Y.Text, attrs Y.Map}). */
  function _writeAuthorContribSection(text) {
    var conn = state.yConn;
    if (!conn || !conn.yDoc || !conn.Y) throw new Error('Paper document not connected.');
    var Y = conn.Y;
    var paperMap = conn.yDoc.getMap('paper');
    var sections = paperMap.get('sections');
    if (!sections) throw new Error('Paper has no sections array.');
    var target = null;
    sections.forEach(function (sec) {
      if (target || !sec || typeof sec.get !== 'function') return;
      var special = sec.get('special');
      var label = sec.get('label');
      var labelStr = (label && label.toString) ? label.toString() : String(label || '');
      if (special === 'author_contributions' || special === 'credit_authorship' ||
          /author contribution|credit authorship/i.test(labelStr)) {
        target = sec;
      }
    });
    conn.yDoc.transact(function () {
      if (!target) {
        target = new Y.Map();
        sections.push([target]);
        target.set('id', window.PaperSchemas.shortId('sec-'));
        target.set('kind', 'custom');
        target.set('label', new Y.Text(''));
        target.get('label').insert(0, 'Author contributions');
        target.set('order', sections.length - 1);
        target.set('status', 'draft');
        /* Use the current template's catalog key when it has one so the
         * journal's authentic command renders (PNAS fact box etc.). */
        var catalog = (state.template && state.template.special_sections) || [];
        var hit = null;
        catalog.forEach(function (e) {
          if (!hit && e && (e.key === 'author_contributions' || e.key === 'credit_authorship')) hit = e;
        });
        target.set('special', hit ? hit.key : 'author_contributions');
        target.set('special_render', 'heading');
        target.set('children', new Y.Array());
      }
      var children = target.get('children');
      var para = null;
      if (children && typeof children.forEach === 'function') {
        children.forEach(function (blk) {
          if (!para && blk && typeof blk.get === 'function' && blk.get('kind') === 'paragraph') para = blk;
        });
      }
      if (!para) {
        para = new Y.Map();
        children.push([para]);
        para.set('id', window.PaperSchemas.shortId('p-'));
        para.set('kind', 'paragraph');
        para.set('status', 'draft');
        para.set('skeleton', new Y.Text(''));
        para.set('body', new Y.Text(''));
        para.set('attrs', new Y.Map());
      }
      var body = para.get('body');
      body.delete(0, body.length);
      body.insert(0, text);
    }, 'credit-statement');
  }

  /* ── V3.232 Compile history + staleness ── */

  function _compilesRef() {
    return firebridge.db()
      .collection('paperExports').doc(state.paperId)
      .collection('compiles')
      .orderBy('triggeredAt', 'desc')
      .limit(50);
  }

  /* D1 — the MAIN-manuscript compiles only. Future diff/subdoc compiles
   * carry a docKind; a missing field means a pre-feature main compile.
   * Every "latest compile" consumer (staleness banner, auto-mount, the
   * main history list) routes through this so a diff or cover-letter
   * compile can never hijack them. */
  function mainCompiles() {
    return (state.compiles || []).filter(function (c) {
      return (c.docKind || 'main') === 'main';
    });
  }

  function _subscribeCompiles() {
    if (state.compilesUnsub) { try { state.compilesUnsub(); } catch (_) {} state.compilesUnsub = null; }
    state.compilesUnsub = _compilesRef().onSnapshot(function (snap) {
      state.compiles = snap.docs.map(function (d) {
        return Object.assign({ id: d.id }, d.data());
      });
      _renderCompileList();
      _refreshStaleness();
      _bindDiffUI();      // D2 — diff picker + list track the snapshot
      _bindSubdocs();     // S-γ — Compile buttons unlock on gate detection
      /* On first load (no PDF mounted yet) auto-mount the newest MAIN
       * compile so the user lands on the most recent build. */
      var mains = mainCompiles();
      if (!state.activeCompileId && mains[0]) {
        _viewCompile(mains[0]);
      }
    }, function (err) {
      console.warn('[paper-export] compile-list subscription error:', err.message);
    });
  }

  /* D1 — flatten the bundle into ONE .tex: each \input{sections/X} line
   * in main.tex is replaced by that file's content (latexdiff needs a
   * single flat source; the client flattens so the service never needs
   * latexpand). */
  function _flattenBundle(bundle) {
    try {
      var mainFile = null;
      var byPath = {};
      (bundle.files || []).forEach(function (f) {
        byPath[f.relpath] = f.content;
        if (f.relpath === 'main.tex' || (!mainFile && /\.tex$/.test(f.relpath))) {
          if (f.relpath === 'main.tex' || !mainFile) mainFile = f.relpath;
        }
      });
      var main = byPath[mainFile] || '';
      return main.replace(/^\\input\{(sections\/[^}]+)\}\s*$/gm, function (m, rel) {
        var content = byPath[rel + '.tex'];
        if (content == null) content = byPath[rel];
        return content != null ? content : m;
      });
    } catch (e) {
      return '';
    }
  }

  function _renderCompileList() {
    var ul = els['px-compile-list'];
    if (!ul) return;
    var mains = mainCompiles();   // D1 — diffs/subdocs get their own lists
    if (!mains.length) {
      ul.innerHTML = '<li class="px-compile-empty">No compiles yet.</li>';
      return;
    }
    ul.innerHTML = mains.map(function (c) {
      var when = _formatWhen(c.triggeredAt);
      var active = (c.id === state.activeCompileId) ? ' is-active' : '';
      var deleteBtn = state.canEdit
        ? '<button class="btn btn-sm" data-compile-delete="' + _esc(c.id) + '" title="Delete this PDF">' + ICON.svg('x-mark') + '</button>'
        : '';
      return (
        '<li class="' + active.trim() + '">' +
        '<span class="px-compile-when">' + _esc(when) +
        '<small>' + _esc((c.addons || []).join(', ') || 'no add-ons') + '</small>' +
        '</span>' +
        '<button class="btn btn-sm" data-compile-view="' + _esc(c.id) + '">View</button>' +
        deleteBtn +
        '</li>'
      );
    }).join('');
    ul.querySelectorAll('[data-compile-view]').forEach(function (btn) {
      btn.addEventListener('click', function () {
        var id = btn.getAttribute('data-compile-view');
        var rec = state.compiles.find(function (c) { return c.id === id; });
        if (rec) _viewCompile(rec);
      });
    });
    ul.querySelectorAll('[data-compile-delete]').forEach(function (btn) {
      btn.addEventListener('click', function () {
        var id = btn.getAttribute('data-compile-delete');
        _deleteCompile(id);
      });
    });
  }

  function _formatWhen(ts) {
    if (!ts) return 'just now';
    /* Firestore Timestamp → JS Date */
    var d = (typeof ts.toDate === 'function') ? ts.toDate() : new Date(ts);
    var now = new Date();
    var diffMs = now - d;
    if (diffMs < 60000)      return Math.max(1, Math.round(diffMs / 1000)) + 's ago';
    if (diffMs < 3600000)    return Math.round(diffMs / 60000) + 'm ago';
    if (diffMs < 86400000)   return Math.round(diffMs / 3600000) + 'h ago';
    return d.toLocaleDateString() + ' ' + d.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
  }

  async function _viewCompile(compile) {
    if (!compile || !compile.pdfStoragePath) return;
    try {
      _setStatus('Loading PDF…', 'saving');
      /* Mint a fresh download URL via Storage SDK — the signed URL on the
       * compile doc may have expired (1h TTL). */
      var url = await firebase.storage().ref(compile.pdfStoragePath).getDownloadURL();
      state.activeCompileId = compile.id;
      _renderCompileList();   // repaint active row
      await _mountPdf(url);
      els['px-preview-title'].textContent = 'Compile ' + compile.id.slice(0, 6) + ' · ' + _formatWhen(compile.triggeredAt);
      _setStatus('', '');
    } catch (err) {
      console.warn('[paper-export] viewCompile failed:', err.message);
      _setStatus('PDF unavailable', 'err');
    }
  }

  async function _deleteCompile(compileId) {
    var compile = state.compiles.find(function (c) { return c.id === compileId; });
    if (!compile) return;
    if (!window.confirm('Delete this compile?\n\n' + _formatWhen(compile.triggeredAt))) return;
    try {
      _setStatus('Deleting…', 'saving');
      /* Delete the Storage object first so we don't orphan a PDF when the
       * Firestore delete succeeds but Storage fails. If Storage delete
       * fails (e.g. already gone), continue — the Firestore record is
       * the authoritative "this compile exists" marker. */
      try {
        if (compile.pdfStoragePath) {
          await firebase.storage().ref(compile.pdfStoragePath).delete();
        }
      } catch (e) {
        console.warn('[paper-export] Storage delete soft-fail:', e.message);
      }
      await firebridge.db()
        .collection('paperExports').doc(state.paperId)
        .collection('compiles').doc(compileId)
        .delete();
      if (state.activeCompileId === compileId) {
        state.activeCompileId = null;
        /* Clear the viewer; the snapshot listener will auto-mount the
         * next newest compile on the next snapshot tick. */
        els['px-empty'].style.display = '';
        els['px-viewer'].style.display = 'none';
        els['px-viewer'].innerHTML = '';
        els['px-preview-title'].textContent = 'No compile selected';
      }
      _setStatus('Deleted', 'saved');
      setTimeout(function () { _setStatus('', ''); }, 1200);
    } catch (err) {
      console.error('[paper-export] delete failed:', err);
      _setStatus('Delete failed', 'err');
    }
  }

  /* Hash the current bundle deterministically so we can compare against
   * the bundleHash the Cloud Run service stored on each compile record.
   * Includes EVERY file (.tex + .bib) so any rendered-content change
   * flips the hash. Sorted by relpath for a stable order. */
  async function _hashBundle(bundle) {
    var parts = (bundle.files || [])
      .map(function (f) { return f.relpath + '\n' + (f.content || ''); })
      .sort()
      .join('\n---FILE---\n');
    var data = new TextEncoder().encode(parts);
    var buf = await crypto.subtle.digest('SHA-256', data);
    return Array.from(new Uint8Array(buf))
      .map(function (b) { return b.toString(16).padStart(2, '0'); })
      .join('');
  }

  /* Re-build the current bundle, hash it, compare against the newest
   * compile's bundleHash. Updates the staleness banner. Cheap enough to
   * run on every Yjs change + every compile-list update. */
  async function _refreshStaleness() {
    var banner = els['px-staleness'];
    if (!banner) return;
    if (!mainCompiles().length) {
      banner.hidden = true;
      return;
    }
    try {
      var bundle = await _buildBundleNow();
      state.localBundleHash = await _hashBundle(bundle);
      var latest = mainCompiles()[0];
      var latestHash = latest && latest.bundleHash;
      banner.hidden = false;
      if (!latestHash) {
        /* Pre-V3.232 compiles don't have a hash — show neutral note. */
        banner.className = 'px-staleness is-fresh';
        banner.innerHTML = 'Latest PDF compiled ' + _esc(_formatWhen(latest.triggeredAt)) +
                           '. Re-compile to enable change-detection.';
      } else if (state.localBundleHash === latestHash) {
        banner.className = 'px-staleness is-fresh';
        ICON.label(banner, 'check', ' Latest PDF matches the current draft.');
      } else {
        banner.className = 'px-staleness is-stale';
        banner.innerHTML = '<strong>' + ICON.svg('exclamation-triangle') + ' Draft has changed since the latest compile.</strong>' +
                           'Click to re-compile.';
        banner.onclick = function () { _compileAction(); };
      }
    } catch (err) {
      console.warn('[paper-export] staleness calc failed:', err.message);
      banner.hidden = true;
    }
  }

  /* Watch the Yjs doc for changes — when the user edits the paper in
   * another tab (or this page is left open and someone else is typing),
   * re-check staleness. Debounce so we don't recompute on every
   * keystroke. */
  function _watchYjsForStaleness() {
    if (!state.yConn || !state.yConn.yDoc) return;
    var t = null;
    function tick() {
      clearTimeout(t);
      t = setTimeout(_refreshStaleness, 800);
    }
    state.yConn.yDoc.on('update', tick);
    state.yjsObserveCleanup = function () { state.yConn.yDoc.off('update', tick); };
  }

  /* ── Config persistence ── */

  function _defaultConfig() {
    return {
      templateId: state.meta.template_id || 'mebp-journal',
      addons: [],
      overrides: {},
      authors: [],          // V3.346 — [{name, affiliationIdx, corresponding, email}]
      affiliations: [],     // V3.346 — ["Dept, Univ, City, …"]
      buildTarget: 'submission',   // V3.395 — 'submission' | 'preprint'
      floatSpacing: 'normal',      // V3.408 — 'tight' | 'normal' | 'loose'
      columnFill: 'tight',         // V3.427 — preview column-fill tightness
      sectionNumbering: 'auto',    // 'auto' | 'on' | 'off'
      /* V3.486 — body-text line density (grant lines-per-inch). bodyLpi is
       * the canonical, geometry-independent metric (null = off); mode/value
       * are UI round-trip (lpp converts to lpi at entry via preview geom). */
      bodyLpi: null,
      bodyDensityMode: 'off',      // 'off' | 'lpi' | 'lpp'
      bodyDensityValue: 6,
      graphicalAbstract: null,     // {storage_path, download_url, hash, mime}
      /* V3.419 — document type; the creation-time papers-row value seeds
       * it, and this contributor-writable copy is the editable truth. */
      paperType: (state.meta && state.meta.paper_type) || 'journal',
      updatedAt: null,
      updatedBy: null,
    };
  }

  function _configDocRef() {
    /* paperExports/{paperId} is a per-paper doc; we read/write it
     * directly via firebridge.db() (same precedent as papers/{paperId}/yjs_*
     * and PMR's cross-user reads). The adapter routes table only handles
     * fixed paths, not /{paperId} wildcards. */
    return firebridge.db().collection('paperExports').doc(state.paperId);
  }

  async function _loadConfig() {
    try {
      var snap = await _configDocRef().get();
      if (!snap.exists) return _defaultConfig();
      var data = snap.data() || {};
      return {
        templateId: data.templateId || (state.meta.template_id || 'mebp-journal'),
        addons: Array.isArray(data.addons) ? data.addons : [],
        overrides: data.overrides || {},
        authors: Array.isArray(data.authors) ? data.authors : [],           // V3.346
        affiliations: Array.isArray(data.affiliations) ? data.affiliations : [],  // V3.346
        buildTarget: data.buildTarget === 'preprint' ? 'preprint' : 'submission', // V3.395
        floatSpacing: ['tight', 'loose'].indexOf(data.floatSpacing) >= 0 ? data.floatSpacing : 'normal', // V3.408
        columnFill: ['normal', 'loose'].indexOf(data.columnFill) >= 0 ? data.columnFill : 'tight', // V3.427
        sectionNumbering: ['on', 'off'].indexOf(data.sectionNumbering) >= 0 ? data.sectionNumbering : 'auto',
        bodyLpi: (typeof data.bodyLpi === 'number' && data.bodyLpi > 0) ? data.bodyLpi : null,  // V3.486
        bodyDensityMode: ['lpi', 'lpp'].indexOf(data.bodyDensityMode) >= 0 ? data.bodyDensityMode : 'off',
        bodyDensityValue: (typeof data.bodyDensityValue === 'number' && data.bodyDensityValue > 0) ? data.bodyDensityValue : 6,
        graphicalAbstract: (data.graphicalAbstract && data.graphicalAbstract.storage_path)
          ? data.graphicalAbstract : null,
        // V3.470 — normalized via PaperSchemas.PAPER_TYPES (was a
        // duplicated inline array). Prefer the saved config's type; fall
        // back to the paper's meta type; else 'journal'.
        paperType: (function () {
          var pt = window.PaperSchemas.normalizePaperType(data.paperType);
          if (pt === 'journal' && state.meta) pt = window.PaperSchemas.normalizePaperType(state.meta.paper_type);
          return pt;
        })(),
        updatedAt: data.updatedAt || null,
        updatedBy: data.updatedBy || null,
      };
    } catch (e) {
      console.warn('[paper-export] no existing config (' + e.message + '), using defaults.');
      return _defaultConfig();
    }
  }

  /* Debounced save so toggling several checkboxes in a row doesn't
   * thrash Firestore. */
  var _saveTimer = null;
  function _scheduleSave() {
    if (!state.canEdit) return;
    if (_saveTimer) clearTimeout(_saveTimer);
    _saveTimer = setTimeout(_saveConfigNow, 600);
  }

  async function _saveConfigNow() {
    _saveTimer = null;
    _setStatus('Saving…', 'saving');
    try {
      var user = firebridge.getUser();
      var payload = {
        templateId: state.config.templateId,
        addons: state.config.addons,
        overrides: state.config.overrides,
        authors: state.config.authors || [],             // V3.346
        affiliations: state.config.affiliations || [],   // V3.346
        buildTarget: state.config.buildTarget || 'submission',  // V3.395
        floatSpacing: state.config.floatSpacing || 'normal',     // V3.408
        columnFill: state.config.columnFill || 'tight',          // V3.427
        sectionNumbering: state.config.sectionNumbering || 'auto',
        graphicalAbstract: state.config.graphicalAbstract || null,
        paperType: state.config.paperType || 'journal',          // V3.419
        updatedAt: new Date().toISOString(),
        updatedBy: user ? user.uid : null,
      };
      await _configDocRef().set(payload, { merge: true });
      state.config.updatedAt = payload.updatedAt;
      state.config.updatedBy = payload.updatedBy;
      _setStatus('Saved', 'saved');
      setTimeout(function () { _setStatus('', ''); }, 1200);
    } catch (err) {
      console.error('[paper-export] save failed:', err);
      _setStatus('Save failed', 'err');
    }
  }

  /* ── Form change handlers ── */

  function _bindTemplateChange() {
    els['px-template'].addEventListener('change', function () {
      state.config.templateId = els['px-template'].value;
      state.template = null;     // force re-fetch on next build
      _updateTemplateDescription();
      _renderConflictWarnings();
      _scheduleSave();
    });
  }

  /* V3.395 — build target ('submission' journal float specs vs
   * 'preprint' exact layout). Shares the paperExports doc with the
   * Document view's toolbar toggle. */
  function _bindBuildTarget() {
    var sel = els['px-build-target'];
    if (!sel) return;
    sel.value = state.config.buildTarget || 'submission';
    sel.addEventListener('change', function () {
      state.config.buildTarget = sel.value === 'preprint' ? 'preprint' : 'submission';
      _scheduleSave();
    });
  }

  /* V3.408 — document float spacing (tight/normal/loose \setlength
   * preamble block). Shares the paperExports doc with the Document
   * view's toolbar select. */
  function _bindFloatSpacing() {
    var sel = els['px-float-spacing'];
    if (!sel) return;
    sel.value = state.config.floatSpacing || 'normal';
    sel.addEventListener('change', function () {
      sel.value = ['tight', 'loose'].indexOf(sel.value) >= 0 ? sel.value : 'normal';
      state.config.floatSpacing = sel.value;
      _scheduleSave();
    });
  }

  /* V3.427 — column-fill tightness. Preview-only (the Document view uses
   * it when breaking paragraphs across pages); shares the paperExports
   * doc with the ⬒ Layout toolbar's Fill select. No LaTeX effect. */
  function _bindColumnFill() {
    var sel = els['px-column-fill'];
    if (!sel) return;
    sel.value = state.config.columnFill || 'tight';
    sel.addEventListener('change', function () {
      sel.value = ['normal', 'loose'].indexOf(sel.value) >= 0 ? sel.value : 'tight';
      state.config.columnFill = sel.value;
      _scheduleSave();
    });
  }

  /* Section numbering (auto | on | off) — affects the preview AND the
   * compiled PDF (secnumdepth + star flip). Shares the paperExports doc
   * with the ⬒ Layout toolbar's Numbering select. */
  function _bindSectionNumbering() {
    var sel = els['px-section-numbering'];
    if (!sel) return;
    sel.value = state.config.sectionNumbering || 'auto';
    sel.addEventListener('change', function () {
      sel.value = ['on', 'off'].indexOf(sel.value) >= 0 ? sel.value : 'auto';
      state.config.sectionNumbering = sel.value;
      _scheduleSave();
    });
  }

  /* V3.419 — document type (journal | grant | editorial | book-chapter).
   * Editable any time; re-filters the template picker (grant formats are
   * a follow-up — the filter falls back to the full list until then). */
  function _bindPaperType() {
    var sel = els['px-paper-type'];
    if (!sel) return;
    sel.value = state.config.paperType || 'journal';
    sel.addEventListener('change', function () {
      var v = window.PaperSchemas.normalizePaperType(sel.value);   // V3.470
      sel.value = v;
      state.config.paperType = v;
      PaperExportConfig.populateTemplateSelect(els['px-template'], state.config.templateId, v);
      _scheduleSave();
    });
  }

  function _onAddonsChange(ids) {
    state.config.addons = ids;
    _renderConflictWarnings();
    _scheduleSave();
  }

  function _onOverridesChange(overrides) {
    state.config.overrides = overrides;
    _scheduleSave();
  }

  async function _updateTemplateDescription() {
    /* V3.341 — the description block also shows the template's
     * submission limits and a one-click "apply suggested add-ons" hint
     * (never auto-applied — the user's saved add-ons win). */
    var el = els['px-template-desc'];
    el.textContent = '';
    var tpl = null;
    try {
      tpl = await window.PaperExportTex.fetchTemplate(state.config.templateId);
    } catch (e) { /* unregistered id — leave the block empty */ }
    if (!tpl) return;

    if (tpl.description) {
      var desc = document.createElement('div');
      desc.textContent = tpl.description;
      el.appendChild(desc);
    }

    var limits = tpl.limits || {};
    var facts = [];
    if (limits.abstract_words) facts.push('abstract ≤ ' + limits.abstract_words + ' w');
    if (limits.body_words)     facts.push('body ≤ ' + limits.body_words + ' w');
    if (limits.references)     facts.push('refs ≤ ' + limits.references);
    if (limits.figures)        facts.push('figures ≤ ' + limits.figures);
    if (limits.title_chars)    facts.push('title ≤ ' + limits.title_chars + ' ch');
    if (facts.length) {
      var factsRow = document.createElement('div');
      factsRow.className = 'px-template-limits';
      factsRow.textContent = 'Limits: ' + facts.join(' · ');
      el.appendChild(factsRow);
    }

    var suggested = (tpl.addon_defaults || []).filter(function (id) {
      return (state.config.addons || []).indexOf(id) < 0;
    });
    if (suggested.length && state.canEdit) {
      var row = document.createElement('div');
      row.className = 'px-template-suggest';
      var txt = document.createElement('span');
      txt.textContent = 'Suggested add-ons: ' + suggested.join(', ') + ' ';
      row.appendChild(txt);
      var btn = document.createElement('button');
      btn.type = 'button';
      btn.className = 'btn btn-sm';
      btn.textContent = 'Apply';
      btn.addEventListener('click', function () {
        state.config.addons = Array.from(new Set((state.config.addons || []).concat(suggested)));
        PaperExportConfig.renderAddons(els['px-addons'], state.config.addons, _onAddonsChange);
        _renderConflictWarnings();
        _scheduleSave();
        _updateTemplateDescription();   // re-render (hint disappears)
      });
      row.appendChild(btn);
      el.appendChild(row);
    }
  }

  function _renderConflictWarnings() {
    var warns = PaperExportConfig.checkConflicts(state.config.templateId, state.config.addons);
    els['px-warnings'].innerHTML = warns.map(function (w) {
      return '<div class="px-warning">' + _esc(w) + '</div>';
    }).join('');
  }

  /* ── Lints ── */

  async function _runLintsAction() {
    try {
      _setStatus('Building bundle…', 'saving');
      var bundle = await _buildBundleNow();
      var results = window.PaperExportLints.runAll(bundle, state.config.addons, state.template);
      _renderLintResults(results);
      _setStatus('Checks done', 'saved');
      setTimeout(function () { _setStatus('', ''); }, 1500);
    } catch (err) {
      console.error('[paper-export] lints failed:', err);
      _setStatus('Lint failed', 'err');
      els['px-lints'].innerHTML = '<li class="err">Lint failed: ' + _esc(err.message) + '</li>';
    }
  }

  function _renderLintResults(results) {
    if (!results.length) {
      els['px-lints'].innerHTML = '<li>No checks ran.</li>';
      return;
    }
    els['px-lints'].innerHTML = results.map(function (r) {
      var dot = r.level === 'err' ? '✕' : (r.level === 'warn' ? ICON.svg('exclamation-triangle') : '✓');
      return '<li class="' + r.level + '">' + dot + ' ' + _esc(r.message) + '</li>';
    }).join('');
  }

  /* ── Bundle build + compile ── */

  async function _buildBundleNow() {
    /* Fetch template lazily so changing the dropdown doesn't refetch
     * every keystroke. */
    if (!state.template || state.template.id !== state.config.templateId) {
      state.template = await window.PaperExportTex.fetchTemplate(state.config.templateId);
    }
    if (!state.fullCitationByKey) {
      state.fullCitationByKey = await _loadFullCitations();
    }
    var titleY = state.yConn.yDoc.getMap('paper').get('meta');
    var title  = (titleY && titleY.get('title')) ? titleY.get('title').toString() : '';
    var bundle = await window.PaperExportTex.buildBundle({
      paperId: state.paperId,
      template: state.template,
      overrides: state.config.overrides,
      addons: state.config.addons,
      buildTarget: state.config.buildTarget || 'submission',   // V3.395
      floatSpacing: state.config.floatSpacing || 'normal',      // V3.408
      sectionNumbering: state.config.sectionNumbering || 'auto',
      bodyLpi: state.config.bodyLpi || null,                    // V3.486
      bodyFontMin: state.config.bodyFontMin || null,
      bodyFontMax: state.config.bodyFontMax || null,
      graphicalAbstract: state.config.graphicalAbstract || null,

      yDoc: state.yConn.yDoc,
      fullItemsByKey: state.fullCitationByKey,
      leadAuthor: state.meta.lead_author || '',
      authorsCfg: {                                     // V3.346
        authors: state.config.authors || [],
        affiliations: state.config.affiliations || [],
      },
      titleOverride: title,
    });
    state.lastBundle = bundle;
    return bundle;
  }

  async function _loadFullCitations() {
    try {
      // V3.493 — the pre-flight bib check MUST reflect the true library. Bust
      // the stale-while-revalidate cache first so references written out of
      // band (imported via direct single-doc writes, or added by another
      // device) aren't falsely reported "missing from items.json". Memoized in
      // state.fullCitationByKey, so this fresh read happens once per session.
      // V3.647 — `typeof api`; `window.api` is always undefined (lexical const).
      try { if (typeof api !== 'undefined' && api.invalidate) await api.invalidate('items.json'); } catch (e) { /* non-fatal */ }
      var data = await api.load('items.json');
      var byKey = {};
      ((data && data.items) || []).forEach(function (it) {
        if (it.type !== 'paper') return;
        var lib = it.meta && it.meta.library;
        if (!lib || !lib.is_library_entry || !lib.citation_key) return;
        byKey[lib.citation_key] = it;
      });
      return byKey;
    } catch (e) {
      console.warn('[paper-export] full citations lookup failed:', e.message);
      return {};
    }
  }

  async function _compileAction() {
    if (!PAPER_COMPILE_URL) {
      _setStatus('Service not configured', 'err');
      els['px-log-wrap'].hidden = false;
      els['px-log'].textContent =
        'Paper compile service URL not set.\n\n' +
        'Once the Cloud Run service is deployed, set its URL by adding\n' +
        '  <script>window.PAPER_COMPILE_URL = "https://...";</script>\n' +
        'before /rm/js/paper-export.js in this page, or hardcode it in\n' +
        'PAPER_COMPILE_URL at the top of paper-export.js.\n\n' +
        'For now, use "Download bundle (.zip)" and compile locally with\n' +
        '  latexmk -pdf main.tex\n' +
        '(or `tectonic main.tex`).';
      return;
    }
    try {
      _setStatus('Building bundle…', 'saving');
      var bundle = await _buildBundleNow();
      _renderLintResults(window.PaperExportLints.runAll(bundle, state.config.addons, state.template));

      _setStatus('Compiling…', 'compiling');
      els['px-log-wrap'].hidden = false;
      els['px-log'].textContent = 'Sending bundle to ' + PAPER_COMPILE_URL + '…\n';

      var user = firebridge.getUser();
      var idToken = user ? await user.getIdToken() : null;
      var resp = await fetch(PAPER_COMPILE_URL, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'Authorization': 'Bearer ' + (idToken || ''),
        },
        body: JSON.stringify({
          paperId: state.paperId,
          templateId: state.config.templateId,
          addons: state.config.addons,
          buildTarget: state.config.buildTarget || 'submission',  // V3.395 — history/debug only
          files: bundle.files,
          figureAssets: bundle.figureAssets || [],   // V3.347
          /* D1 — extra fields for the coming latexdiff/subdoc service
           * update: the FLATTENED single .tex (the service stores it per
           * compile so future marked-up diffs have a base) + this
           * compile's document kind. The current service ignores unknown
           * fields, so shipping these ahead of the server deploy is
           * safe — and history starts accumulating the moment the new
           * image goes live. */
          flatSource: _flattenBundle(bundle),
          docKind: 'main',
        }),
      });
      if (!resp.ok) {
        var body = await resp.text();
        throw new Error('Compile service ' + resp.status + ': ' + body.slice(0, 400));
      }
      var result = await resp.json();
      state.lastCompile = result;
      /* V3.347 — surface figure-fetch warnings above the log. */
      var warnHead = (result.warnings && result.warnings.length)
        ? 'Warning: ' + result.warnings.join('\nWarning: ') + '\n\n'
        : '';
      els['px-log'].textContent = warnHead + (result.log || '(no log returned)');
      if (result.pdfUrl) {
        await _mountPdf(result.pdfUrl);
        _setStatus('Compiled', 'saved');
      } else {
        _setStatus('Compile returned no PDF', 'err');
      }
    } catch (err) {
      console.error('[paper-export] compile failed:', err);
      _setStatus('Compile failed', 'err');
      els['px-log-wrap'].hidden = false;
      els['px-log'].textContent = (els['px-log'].textContent || '') + '\n\nERROR: ' + err.message;
    }
  }

  async function _mountPdf(pdfUrl) {
    if (!window.PDF_VIEWER || !window.PDF_VIEWER.create) {
      throw new Error('PDF_VIEWER not loaded.');
    }
    els['px-empty'].style.display = 'none';
    els['px-viewer'].style.display = 'block';
    /* Tear down a prior viewer (if any) so canvases don't accumulate. */
    els['px-viewer'].innerHTML = '';
    state.viewer = await window.PDF_VIEWER.create(els['px-viewer'], pdfUrl, {
      fitToContainer: true,
      onZoomChange: function (z) {
        els['px-zoom-label'].textContent = Math.round((z || 1) * 100) + '%';
      },
    });
    els['px-preview-title'].textContent = 'Compiled ' + new Date().toLocaleTimeString();
  }

  /* ── .zip bundle download ── */

  /* V3.47x — portable paper bundle: the whole draft (tree, config,
   * equations, figures+bytes, bibliography, comments) as a re-importable
   * .zip. Delegates to PaperExportBundle (paper-export-bundle.js). */
  async function _exportPortable() {
    var statusEl = els['px-export-status'];
    function say(m) { if (statusEl) { statusEl.hidden = false; statusEl.textContent = m; } }
    if (!window.PaperExportBundle) { say('Export module not loaded.'); return; }
    if (!state.yConn || !state.yConn.yDoc) { say('Paper document not connected.'); return; }
    var btn = els['px-export-portable'];
    if (btn) { btn.disabled = true; }
    try {
      // Ensure the lab-library citation metadata is loaded (lazy on the
      // compile path) so the bundle's bibliography resolves every [@key].
      if (!state.fullCitationByKey) {
        say('Loading bibliography…');
        state.fullCitationByKey = await _loadFullCitations();
      }
      await window.PaperExportBundle.buildAndDownload({
        yConn: state.yConn,
        paperId: state.paperId,
        meta: state.meta,
        config: state.config,
        fullCitationByKey: state.fullCitationByKey || {},
      }, say);
    } catch (e) {
      say('Export failed: ' + ((e && e.message) || e));
    } finally {
      if (btn) btn.disabled = false;
    }
  }

  async function _downloadAction() {
    try {
      _setStatus('Building bundle…', 'saving');
      var bundle = await _buildBundleNow();
      if (typeof window.JSZip !== 'function') {
        throw new Error('JSZip not loaded.');
      }
      var zip = new window.JSZip();
      bundle.files.forEach(function (f) { zip.file(f.relpath, f.content); });
      var blob = await zip.generateAsync({ type: 'blob' });
      var url = URL.createObjectURL(blob);
      var a = document.createElement('a');
      a.href = url;
      a.download = state.paperId + '-' + state.config.templateId + '.zip';
      document.body.appendChild(a);
      a.click();
      a.remove();
      setTimeout(function () { URL.revokeObjectURL(url); }, 2000);
      _setStatus('Downloaded', 'saved');
      setTimeout(function () { _setStatus('', ''); }, 1500);
    } catch (err) {
      console.error('[paper-export] download failed:', err);
      _setStatus('Download failed', 'err');
    }
  }

  /* ── Tiny helpers ── */

  function _setStatus(msg, kind) {
    var el = els['px-status'];
    if (!el) return;
    el.textContent = msg || '';
    el.className = 'px-status ' + (kind || '');
  }

  function _fatal(msg) {
    document.getElementById('px-config').innerHTML =
      '<div class="px-error">' + _esc(msg) + '</div>';
    _setStatus('Failed', 'err');
  }

  function _esc(s) {
    return String(s == null ? '' : s).replace(/[&<>"']/g, function (c) {
      return ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c];
    });
  }
})();
