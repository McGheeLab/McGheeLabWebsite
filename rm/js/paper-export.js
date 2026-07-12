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
      'px-template','px-template-desc','px-addons','px-lints',
      'px-fig-placement','px-fig-width','px-tab-booktabs','px-tab-placement','px-eq-display',
      'px-run-lints','px-compile','px-download',
      'px-log','px-log-wrap',
      'px-preview-title','px-zoom-out','px-zoom-in','px-fit','px-zoom-label',
      'px-stage','px-empty','px-viewer',
      /* V3.232 — compile history + staleness */
      'px-compile-list','px-staleness',
    ].forEach(function (id) { els[id] = document.getElementById(id); });

    els['px-back'].href = '/rm/pages/paper-builder.html?paper=' + encodeURIComponent(state.paperId);

    /* firebridge auto-inits (see end of rm/js/firebase-bridge.js); we just
     * wait for the auth listener to fire. */
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
    await PaperExportConfig.populateTemplateSelect(els['px-template'], state.config.templateId);
    _bindTemplateChange();
    PaperExportConfig.renderAddons(els['px-addons'], state.config.addons, _onAddonsChange);
    PaperExportConfig.bindOverrides(document, state.config.overrides, _onOverridesChange);
    _updateTemplateDescription();
    _renderConflictWarnings();

    /* 5. Wire actions. */
    els['px-run-lints'].addEventListener('click', _runLintsAction);
    els['px-compile'].addEventListener('click', _compileAction);
    els['px-download'].addEventListener('click', _downloadAction);
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

  /* ── V3.232 Compile history + staleness ── */

  function _compilesRef() {
    return firebridge.db()
      .collection('paperExports').doc(state.paperId)
      .collection('compiles')
      .orderBy('triggeredAt', 'desc')
      .limit(50);
  }

  function _subscribeCompiles() {
    if (state.compilesUnsub) { try { state.compilesUnsub(); } catch (_) {} state.compilesUnsub = null; }
    state.compilesUnsub = _compilesRef().onSnapshot(function (snap) {
      state.compiles = snap.docs.map(function (d) {
        return Object.assign({ id: d.id }, d.data());
      });
      _renderCompileList();
      _refreshStaleness();
      /* On first load (no PDF mounted yet) auto-mount the newest compile
       * so the user lands on the most recent build without re-compiling. */
      if (!state.activeCompileId && state.compiles[0]) {
        _viewCompile(state.compiles[0]);
      }
    }, function (err) {
      console.warn('[paper-export] compile-list subscription error:', err.message);
    });
  }

  function _renderCompileList() {
    var ul = els['px-compile-list'];
    if (!ul) return;
    if (!state.compiles.length) {
      ul.innerHTML = '<li class="px-compile-empty">No compiles yet.</li>';
      return;
    }
    ul.innerHTML = state.compiles.map(function (c) {
      var when = _formatWhen(c.triggeredAt);
      var active = (c.id === state.activeCompileId) ? ' is-active' : '';
      var deleteBtn = state.canEdit
        ? '<button class="btn btn-sm" data-compile-delete="' + _esc(c.id) + '" title="Delete this PDF">✕</button>'
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
    if (!state.compiles.length) {
      banner.hidden = true;
      return;
    }
    try {
      var bundle = await _buildBundleNow();
      state.localBundleHash = await _hashBundle(bundle);
      var latest = state.compiles[0];
      var latestHash = latest && latest.bundleHash;
      banner.hidden = false;
      if (!latestHash) {
        /* Pre-V3.232 compiles don't have a hash — show neutral note. */
        banner.className = 'px-staleness is-fresh';
        banner.innerHTML = 'Latest PDF compiled ' + _esc(_formatWhen(latest.triggeredAt)) +
                           '. Re-compile to enable change-detection.';
      } else if (state.localBundleHash === latestHash) {
        banner.className = 'px-staleness is-fresh';
        banner.textContent = '✓ Latest PDF matches the current draft.';
      } else {
        banner.className = 'px-staleness is-stale';
        banner.innerHTML = '<strong>⚠ Draft has changed since the latest compile.</strong>' +
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
    var d = await PaperExportConfig.loadTemplateDescription(state.config.templateId);
    els['px-template-desc'].textContent = d || '';
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
      var results = window.PaperExportLints.runAll(bundle, state.config.addons);
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
      var dot = r.level === 'err' ? '✕' : (r.level === 'warn' ? '⚠' : '✓');
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
      yDoc: state.yConn.yDoc,
      fullItemsByKey: state.fullCitationByKey,
      leadAuthor: state.meta.lead_author || '',
      titleOverride: title,
    });
    state.lastBundle = bundle;
    return bundle;
  }

  async function _loadFullCitations() {
    try {
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
      _renderLintResults(window.PaperExportLints.runAll(bundle, state.config.addons));

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
          files: bundle.files,
        }),
      });
      if (!resp.ok) {
        var body = await resp.text();
        throw new Error('Compile service ' + resp.status + ': ' + body.slice(0, 400));
      }
      var result = await resp.json();
      state.lastCompile = result;
      els['px-log'].textContent = (result.log || '(no log returned)');
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
