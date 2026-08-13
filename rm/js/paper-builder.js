/* paper-builder.js — list of lab papers + "new paper" creation flow.
 *
 * Reads `data/projects/papers.json` for paper metadata. Phase A: each paper
 * card links into `paper-builder.html?paper=…` (V3.60+; previously paper-editor.html?id=…). The editor stores the document
 * tree in Firestore at `papers/{paperId}/draft`; this list page does NOT touch
 * Firestore — it's safe to view papers when offline or signed out.
 *
 * Creating a new paper writes a row to papers.json via the existing
 * /api/data PUT endpoint. The Firestore draft doc is materialized by the
 * editor on first save (we don't pre-create empty docs because that requires
 * Firestore admin auth and the user creating the paper might not be one yet).
 */

(function () {
  var statusEl   = document.getElementById('pb-status');
  var listEl     = document.getElementById('pb-list');
  var newBtn     = document.getElementById('pb-new-paper-btn');
  var importBtn  = document.getElementById('pb-import-btn');   // V3.47x
  var importFile = document.getElementById('pb-import-file');  // V3.47x
  var modalEl    = document.getElementById('pb-modal');
  var modalClose = document.getElementById('pb-modal-close');
  var modalCancel= document.getElementById('pb-modal-cancel');
  var modalCreate= document.getElementById('pb-modal-create');
  var modalError = document.getElementById('pb-modal-error');
  var titleInput = document.getElementById('pb-new-title');
  var idInput    = document.getElementById('pb-new-id');
  var templateSel= document.getElementById('pb-new-template');
  var typeSel    = document.getElementById('pb-new-type');   // V3.419
  var subtypeSel = document.getElementById('pb-new-subtype');       // V3.464 (grant mechanism)
  var subtypeGrp = document.getElementById('pb-new-subtype-group'); // V3.464
  var templateHint = document.getElementById('pb-new-template-hint');
  var journalInput = document.getElementById('pb-new-journal');
  var repoInput  = document.getElementById('pb-new-repo');

  var papers = [];

  /* V3.482 — delete-paper cascade. The button is health-gated: it only
   * appears once the `deleteBuilderPaper` Cloud Function answers its GET
   * probe, so this client is safe to ship before the function deploys. */
  var DELETE_FN_URL = 'https://us-central1-mcgheelab-f56cc.cloudfunctions.net/deleteBuilderPaper';
  var _deleteReady = false;
  var _deleteProbed = false;

  function ensureDeleteAvailable() {
    if (_deleteProbed) return;
    _deleteProbed = true;
    fetch(DELETE_FN_URL, { method: 'GET' })
      .then(function (r) { return r.ok ? r.json() : null; })
      .then(function (j) {
        if (j && j.ok) { _deleteReady = true; render(); }
      })
      .catch(function () { /* function not deployed yet — button stays hidden */ });
  }

  function canDelete(p) {
    if (typeof firebridge === 'undefined') return false;
    return (firebridge.isAdmin && firebridge.isAdmin()) ||
           (firebridge.isLeadAuthor && firebridge.isLeadAuthor(p));
  }

  function setStatus(msg, kind) {
    statusEl.textContent = msg || '';
    statusEl.className = 'pb-status' + (kind ? ' pb-status-' + kind : '');
  }

  /* ── Load & render ── */

  async function load() {
    try {
      var data = await api.load('projects/papers.json');
      papers = (data && data.papers) || [];
      render();
      ensureDeleteAvailable();
    } catch (err) {
      listEl.innerHTML = '<div class="empty-state">Failed to load papers: ' + err.message + '</div>';
    }
  }

  function render() {
    listEl.innerHTML = '';
    if (!papers.length) {
      listEl.innerHTML = '<div class="empty-state">No papers yet. Click "New paper" to start.</div>';
      return;
    }
    papers.forEach(function (p) {
      listEl.appendChild(renderCard(p));
    });
  }

  function renderCard(p) {
    var card = document.createElement('a');
    card.className = 'pb-card';
    card.href = '/rm/pages/paper-builder.html?paper=' + encodeURIComponent(p.id);

    var coauthorCount = (p.coauthor_uids || []).length + (p.coauthor_emails || []).length;
    var statusHTML = typeof statusChip === 'function' ? statusChip(p.status) : '<span class="chip">' + (p.status || '') + '</span>';

    card.innerHTML =
      '<div class="pb-card-row">' +
        '<div class="pb-card-title">' + escapeHtml(p.title || '(untitled)') + '</div>' +
        statusHTML +
      '</div>' +
      '<div class="pb-card-meta">' +
        '<span>' + escapeHtml(p.lead_author || 'Unknown lead') + '</span>' +
        (p.target_journal ? ' · <span>' + escapeHtml(p.target_journal) + '</span>' : '') +
        (coauthorCount ? ' · <span>' + coauthorCount + ' coauthor' + (coauthorCount === 1 ? '' : 's') + '</span>' : '') +
        (p.template_id ? ' · <span class="pb-template-tag">' + escapeHtml(p.template_id) + '</span>' : '') +
      '</div>' +
      (p.repo_path ? '<div class="pb-card-repo">' + escapeHtml(p.repo_path) + '</div>' : '');

    /* V3.482 — delete control (admin or lead author, once the CF is live).
     * The card is an <a>, so suppress navigation on the button click. */
    if (_deleteReady && canDelete(p)) {
      var del = document.createElement('button');
      del.type = 'button';
      del.className = 'pb-card-del';
      del.title = 'Delete this paper';
      del.setAttribute('aria-label', 'Delete paper');
      del.textContent = '🗑';
      del.addEventListener('click', function (e) {
        e.preventDefault();
        e.stopPropagation();
        deletePaperRow(p);
      });
      card.appendChild(del);
    }
    return card;
  }

  /* Full cascade delete via the Admin-SDK Cloud Function. Hard delete, no
   * undo — the confirm spells out everything that goes. */
  async function deletePaperRow(p) {
    var title = p.title || p.id;
    var msg = 'Delete "' + title + '"?\n\n' +
      'This permanently removes the paper, its figures, comments, and reader ' +
      'highlights, and unlinks it from any library evidence. This cannot be undone.';
    if (!window.confirm(msg)) return;

    var me = (typeof firebase !== 'undefined' && firebase.auth && firebase.auth().currentUser) || null;
    if (!me) { setStatus('Sign in to delete papers.', 'error'); return; }

    setStatus('Deleting "' + title + '"…');
    try {
      var idToken = await me.getIdToken();
      var r = await fetch(DELETE_FN_URL, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'Authorization': 'Bearer ' + idToken },
        body: JSON.stringify({ paperId: p.id }),
      });
      var j = await r.json().catch(function () { return {}; });
      if (!r.ok || !j.ok) throw new Error(j.error || ('HTTP ' + r.status));
      // V3.487 — the delete runs in a Cloud Function (Admin SDK), outside
      // api.save, so the adapter's projects cache isn't cleared. Worse, its
      // stale-while-revalidate "cheap freshness" check compares max updatedAt
      // — a DELETE bumps nothing, so the background refresh decides "no change"
      // and serves the stale list forever: the deleted paper reappears on
      // refresh and opens blank (its Yjs doc is gone). Bust the cache so the
      // next load fetches fresh.
      try { if (window.api && api.invalidate) await api.invalidate('projects/papers.json'); } catch (e) { /* non-fatal */ }
      papers = papers.filter(function (x) { return x.id !== p.id; });
      render();
      setStatus('Deleted "' + title + '".', 'ok');
    } catch (e) {
      setStatus('Delete failed: ' + (e.message || e), 'error');
    }
  }

  function escapeHtml(s) {
    return String(s || '').replace(/[&<>"']/g, function (c) {
      return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c];
    });
  }

  /* ── New-paper modal ── */

  /* V3.464 — templates are filtered by the chosen document type (mirrors
   * KNOWN_TEMPLATES's `types[]` filter on the export page). A template
   * with no `types` defaults to journal-only. If a type has no matching
   * template the picker falls back to the full list rather than going
   * empty. */
  function templatesForType(type) {
    var tpls = window.PaperSchemas.PAPER_TEMPLATES;
    var hits = Object.keys(tpls).filter(function (k) {
      return (tpls[k].types || ['journal']).indexOf(type) >= 0;
    });
    return hits.length ? hits : Object.keys(tpls);
  }

  function populateTemplateSelect() {
    var tpls = window.PaperSchemas.PAPER_TEMPLATES;
    var type = (typeSel && typeSel.value) || 'journal';
    var keys = templatesForType(type);
    templateSel.innerHTML = '';
    keys.forEach(function (k) {
      var opt = document.createElement('option');
      opt.value = k;
      opt.textContent = tpls[k].name;
      templateSel.appendChild(opt);
    });
    // Default: the type's canonical starter (journal → mebp-journal;
    // grant → first grant template), else the first available.
    var preferred = (type === 'journal') ? 'mebp-journal' : keys[0];
    templateSel.value = keys.indexOf(preferred) >= 0 ? preferred : keys[0];
    updateTemplateHint();
    syncSubtype();
  }

  function updateTemplateHint() {
    var t = window.PaperSchemas.PAPER_TEMPLATES[templateSel.value];
    templateHint.textContent = t ? t.description : '';
  }

  /* V3.464 — grant mechanism (subtype) select. Shown only for grants;
   * options are the grant starter templates (their id doubles as the
   * mechanism id the checklist keys off), plus a "General / none" escape.
   * It follows the template selection unless the user overrides it. */
  function syncSubtype() {
    if (!subtypeSel || !subtypeGrp) return;
    var type = (typeSel && typeSel.value) || 'journal';
    if (type !== 'grant') { subtypeGrp.hidden = true; return; }
    subtypeGrp.hidden = false;
    var tpls = window.PaperSchemas.PAPER_TEMPLATES;
    var grantKeys = Object.keys(tpls).filter(function (k) {
      return (tpls[k].types || []).indexOf('grant') >= 0 && k !== 'blank';
    });
    subtypeSel.innerHTML = '';
    grantKeys.forEach(function (k) {
      var opt = document.createElement('option');
      opt.value = k;
      opt.textContent = tpls[k].name;
      subtypeSel.appendChild(opt);
    });
    var none = document.createElement('option');
    none.value = '';
    none.textContent = 'General / other (no checklist)';
    subtypeSel.appendChild(none);
    // Follow the template: a grant starter's id IS its mechanism id.
    subtypeSel.value = grantKeys.indexOf(templateSel.value) >= 0 ? templateSel.value : '';
  }

  function openModal() {
    modalEl.hidden = false;
    titleInput.value = '';
    idInput.value = '';
    journalInput.value = '';
    repoInput.value = '';
    modalError.hidden = true;
    modalError.textContent = '';
    populateTemplateSelect();
    setTimeout(function () { titleInput.focus(); }, 50);
  }

  function closeModal() {
    modalEl.hidden = true;
  }

  function suggestSlug() {
    if (!idInput.value.trim() && titleInput.value.trim()) {
      idInput.value = slugify(titleInput.value);
    }
  }

  async function createPaper() {
    var title = titleInput.value.trim();
    var id = (idInput.value.trim() || (title && slugify(title)) || '').toLowerCase();
    var template_id = templateSel.value;
    var target_journal = journalInput.value.trim() || 'TBD';
    var repo_path = repoInput.value.trim() || '';

    modalError.hidden = true;
    modalError.textContent = '';

    if (!title) {
      modalError.textContent = 'Title is required.';
      modalError.hidden = false;
      return;
    }
    if (!/^[a-z0-9][a-z0-9-]*$/.test(id)) {
      modalError.textContent = 'Slug must be kebab-case (lowercase, digits, hyphens).';
      modalError.hidden = false;
      return;
    }
    if (papers.some(function (p) { return p.id === id; })) {
      modalError.textContent = 'A paper with that slug already exists.';
      modalError.hidden = false;
      return;
    }

    var user = (typeof firebridge !== 'undefined') ? firebridge.getUser() : null;
    var profile = (typeof firebridge !== 'undefined') ? firebridge.getProfile() : null;

    var newRow = {
      id: id,
      title: title,
      target_journal: target_journal,
      status: 'drafting',
      lead_author: (profile && profile.name) || (user && user.email) || 'Unknown',
      lead_author_uid: user ? user.uid : '',
      lead_author_email: user ? (user.email || '') : '',
      coauthor_uids: [],
      coauthor_emails: [],
      template_id: template_id,
      /* V3.419 — document type: journal | grant | editorial |
       * book-chapter. Drives templates, the Add Section menu, and the
       * grant Document set; editable any time on the Export page. */
      paper_type: (typeSel && typeSel.value) || 'journal',
      /* V3.464 — grant mechanism (nsf-career | nih-r01 | …). Null for
       * non-grants or a "general" grant. Keys the submission checklist +
       * required-document set. */
      grant_subtype: ((typeSel && typeSel.value) === 'grant' && subtypeSel && subtypeSel.value) || null,
      repo_path: repo_path,
      repo_org: '',
      notes: '',
    };

    modalCreate.disabled = true;
    modalCreate.textContent = 'Creating…';
    try {
      var data = await api.load('projects/papers.json');
      var arr = (data && data.papers) || [];
      arr.push(newRow);
      await api.save('projects/papers.json', { papers: arr });
      // Navigate straight into the editor.
      window.location.href = '/rm/pages/paper-builder.html?paper=' + encodeURIComponent(id);
    } catch (err) {
      modalError.textContent = 'Failed to create: ' + err.message;
      modalError.hidden = false;
      modalCreate.disabled = false;
      modalCreate.textContent = 'Create';
    }
  }

  /* ── Wire ── */

  newBtn.addEventListener('click', openModal);
  if (importBtn && importFile) {                       // V3.47x — import a bundle
    importBtn.addEventListener('click', function () { importFile.value = ''; importFile.click(); });
    importFile.addEventListener('change', function () {
      var f = importFile.files && importFile.files[0];
      if (f) importBundleFile(f);
    });
  }
  modalClose.addEventListener('click', closeModal);
  modalCancel.addEventListener('click', closeModal);
  modalCreate.addEventListener('click', createPaper);
  modalEl.addEventListener('click', function (e) {
    if (e.target === modalEl) closeModal();
  });
  titleInput.addEventListener('blur', suggestSlug);
  templateSel.addEventListener('change', function () { updateTemplateHint(); syncSubtype(); });
  if (typeSel) typeSel.addEventListener('change', populateTemplateSelect);   // V3.464
  document.addEventListener('keydown', function (e) {
    if (e.key === 'Escape' && !modalEl.hidden) closeModal();
  });

  /* V3.472 — one-click import of a prepared grant bundle
   * (rm/data/grant-imports/<id>.json): create the papers.json row carrying
   * `import_seed`, then open the editor, which hydrates the section tree on
   * first open (see paper-editor `hydrateFromImport`). Re-importing the same
   * bundle just reopens the existing paper — never duplicates. */
  async function importPaper(importId) {
    if (!/^[a-z0-9][a-z0-9-]*$/.test(importId)) return;
    var existing = papers.filter(function (p) { return p.id === importId; })[0];
    if (existing) {
      window.location.href = '/rm/pages/paper-builder.html?paper=' + encodeURIComponent(importId);
      return;
    }
    setStatus('Importing “' + importId + '”…');
    var bundle;
    try {
      var resp = await fetch('/rm/data/grant-imports/' + importId + '.json', { cache: 'no-cache' });
      if (!resp.ok) throw new Error('bundle not found (' + resp.status + ')');
      bundle = await resp.json();
    } catch (err) {
      setStatus('Import failed: ' + err.message, 'err');
      return;
    }
    var user = (typeof firebridge !== 'undefined') ? firebridge.getUser() : null;
    var profile = (typeof firebridge !== 'undefined') ? firebridge.getProfile() : null;
    var newRow = {
      id: importId,
      title: bundle.title || importId,
      target_journal: bundle.target_journal || 'TBD',
      status: 'drafting',
      lead_author: (profile && profile.name) || (user && user.email) || 'Unknown',
      lead_author_uid: user ? user.uid : '',
      lead_author_email: user ? (user.email || '') : '',
      coauthor_uids: [],
      coauthor_emails: [],
      template_id: 'nsf-career',
      paper_type: bundle.paper_type || 'grant',
      grant_subtype: bundle.grant_subtype || null,
      import_seed: importId,             // editor hydrates from this on first open
      repo_path: '', repo_org: '', notes: '',
    };
    try {
      var data = await api.load('projects/papers.json');
      var arr = (data && data.papers) || [];
      if (!arr.some(function (p) { return p.id === importId; })) arr.push(newRow);
      await api.save('projects/papers.json', { papers: arr });
      window.location.href = '/rm/pages/paper-builder.html?paper=' + encodeURIComponent(importId);
    } catch (err) {
      setStatus('Import failed: ' + err.message, 'err');
    }
  }

  /* ── V3.47x — import a portable paper bundle (.paperbundle.zip) ──
   * Reads the uploaded zip, allocates a fresh unique slug, stashes the
   * parsed bundle (+ base64 assets) in IndexedDB, creates the paper's
   * `projects/{slug}` row as a DIRECT single-doc write (the whole-array
   * api.save would rewrite other papers' docs and fail the owner-scoped
   * rule), then opens the editor — which hydrates everything on first
   * open (paper-editor `hydrateFromImport`, source='upload'). */
  function _freshSlug(title) {
    var base = (typeof slugify === 'function' ? slugify(title || 'paper') : String(title || 'paper').toLowerCase().replace(/[^a-z0-9]+/g, '-')).replace(/^-+|-+$/g, '') || 'paper';
    if (!papers.some(function (p) { return p.id === base; })) return base;
    for (var i = 2; i < 500; i++) {
      var s = base + '-' + i;
      if (!papers.some(function (p) { return p.id === s; })) return s;
    }
    return base + '-' + Date.now();
  }

  /* V3.491+ — import runs the FULL materialization here on the list page via
   * PaperImportEngine (progress modal, no navigation). The finished paper lands
   * in the list to open manually. Grant PDFs go to the Grant Docs page
   * (paperExports.grantDocs), not sections. No IndexedDB stash / import_seed —
   * the engine builds the Yjs doc directly, so the editor sees a full doc on
   * open (its hydrate guard skips). Row is created BEFORE the engine so the
   * yjs_updates write rule authorizes a non-admin owner. */
  async function importBundleFile(file) {
    if (!file) return;
    if (typeof window.JSZip !== 'function') { setStatus('Zip library not loaded — reload and retry.', 'err'); return; }
    if (!window.PaperImportEngine) { setStatus('Import engine not loaded — reload and retry.', 'err'); return; }
    var db = (typeof firebridge !== 'undefined' && firebridge.db) ? firebridge.db() : null;
    var user = (typeof firebridge !== 'undefined') ? firebridge.getUser() : null;
    if (!db || !user) { setStatus('Sign in to import a paper.', 'err'); return; }

    var modal = _openImportModal('paper');
    try {
      modal.set('unzip', 'Reading bundle…', 0, 1, '');
      var zip = await window.JSZip.loadAsync(file);
      var manifestFile = zip.file('paper.json');
      if (!manifestFile) throw new Error('paper.json missing — not a paper bundle.');
      var manifest = JSON.parse(await manifestFile.async('string'));
      if (!manifest.tree || !Array.isArray(manifest.tree.sections)) throw new Error('bundle has no section tree.');

      var comments = [];
      var cf = zip.file('comments.json');
      if (cf) { try { comments = JSON.parse(await cf.async('string')) || []; } catch (e) { comments = []; } }

      // Read asset bytes as base64, keyed by manifest relpath (unzip progress).
      var assets = {};
      var assetEntries = (manifest.assets || []);
      for (var i = 0; i < assetEntries.length; i++) {
        var rel = assetEntries[i].relpath;
        modal.set('unzip', 'Unzipping files…', i, assetEntries.length, rel || '');
        var ze = rel && zip.file(rel);
        if (ze) assets[rel] = await ze.async('base64');
      }
      modal.set('unzip', 'Unzipped', assetEntries.length, assetEntries.length, '');

      var title = (manifest.paper && manifest.paper.title) || (manifest.tree.meta && manifest.tree.meta.title) || 'Imported paper';
      modal.setTitle(title);
      var slug = _freshSlug(title);
      var profile = (typeof firebridge !== 'undefined') ? firebridge.getProfile() : null;

      // Create the projects row FIRST so the yjs_updates write rule authorizes
      // the engine's writes for a non-admin owner. No import_seed — the engine
      // materializes the doc; the editor's hydrate stays dormant on open.
      var p = (manifest.paper || {});
      var row = {
        id: slug, type: 'paper', title: title,
        target_journal: p.target_journal || 'TBD', status: 'drafting',
        lead_author: (profile && profile.name) || (user.email) || 'Unknown',
        lead_author_uid: user.uid, lead_author_email: user.email || '',
        coauthor_uids: [], coauthor_emails: [],
        template_id: p.template_id || 'blank',
        paper_type: p.paper_type || 'journal',
        grant_subtype: p.grant_subtype || null,
        import_source: 'upload',
        repo_path: p.repo_path || '', repo_org: p.repo_org || '', notes: p.notes || '',
      };
      await db.collection('projects').doc(slug).set(row);
      try { if (window.api && api.invalidate) await api.invalidate('projects/papers.json'); } catch (e) { /* non-fatal */ }

      // Run the full materialization with live progress. No navigation.
      var runRes = await window.PaperImportEngine.run({
        manifest: manifest, assets: assets, comments: comments, slug: slug,
        onProgress: function (evt) { modal.onEngine(evt); },
      });

      modal.done();
      await load();                         // refresh the list; the new card links to ?paper=slug
      setStatus('Imported “' + title + '” — click it in the list to open.', 'ok');

      // Best-effort Semantic Scholar enrichment of the freshly-imported
      // references (abstracts + reference lists). Runs AFTER the paper is in
      // the list, so it never blocks usability; rate-limited + skippable.
      var refIds = (runRes && runRes.refItemIds) || [];
      if (refIds.length && window.LIBRARY_UPLOAD && window.LIBRARY_UPLOAD.enrichItemFromSemanticScholar &&
          window.PaperImportEngine.enrichLibraryItems) {
        modal.enrichStart(refIds.length);
        await window.PaperImportEngine.enrichLibraryItems(refIds, {
          onProgress: function (d, t) { modal.enrichProgress(d, t); },
          shouldCancel: function () { return modal.cancelled(); },
        });
        modal.close();
      } else {
        setTimeout(function () { modal.close(); }, 1400);
      }
    } catch (err) {
      console.error('[paper-import]', err);
      modal.error((err && err.message) || String(err));
      setStatus('Import failed: ' + (err && err.message || err), 'err');
    }
  }

  /* Import progress modal. Steps mirror the engine phases; onEngine(evt) marks
   * prior steps done, highlights the active one, and fills the per-phase bar. */
  var IMPORT_STEPS = [
    ['unzip', 'Unzip bundle'], ['sections', 'Build sections'], ['figures', 'Place figures'],
    ['grantdocs', 'Attach documents'], ['config', 'Apply settings'], ['references', 'Place references'],
    ['comments', 'Restore comments'], ['done', 'Done'],
  ];
  function _phaseLabel(evt) {
    var m = {
      connect: 'Connecting…', unzip: 'Unzipping files…', sections: 'Building sections…',
      figures: 'Placing figures…', grantdocs: 'Attaching grant documents…', config: 'Applying settings…',
      references: 'Placing references…', comments: 'Restoring comments…', done: 'Import complete',
    };
    var base = m[evt.phase] || (evt.phase + '…');
    if (evt.total > 1 && evt.phase !== 'done') base += ' (' + evt.done + '/' + evt.total + ')';
    return base;
  }
  function _openImportModal(title) {
    var back = document.createElement('div');
    back.className = 'pi-backdrop';
    back.innerHTML =
      '<div class="pi-modal">' +
        '<div class="pi-title">Importing “<span class="pi-name">' + escapeHtml(title) + '</span>”</div>' +
        '<div class="pi-phase">Starting…</div>' +
        '<div class="pi-bar"><i></i></div>' +
        '<ul class="pi-steps">' +
          IMPORT_STEPS.map(function (s) { return '<li data-k="' + s[0] + '"><span class="pi-dot"></span>' + s[1] + '</li>'; }).join('') +
        '</ul>' +
        '<div class="pi-note"></div>' +
      '</div>';
    document.body.appendChild(back);
    var phaseEl = back.querySelector('.pi-phase');
    var barEl = back.querySelector('.pi-bar > i');
    var noteEl = back.querySelector('.pi-note');
    var nameEl = back.querySelector('.pi-name');
    var order = IMPORT_STEPS.map(function (s) { return s[0]; });
    var _cancelled = false;
    function paint(evt) {
      var idx = order.indexOf(evt.phase);
      if (idx >= 0) {
        order.forEach(function (k, i) {
          var li = back.querySelector('li[data-k="' + k + '"]');
          if (li) li.className = i < idx ? 'pi-done' : (i === idx ? 'pi-active' : '');
        });
      }
      phaseEl.textContent = _phaseLabel(evt);
      barEl.style.width = (evt.total ? Math.round(evt.done / evt.total * 100) : 0) + '%';
      noteEl.textContent = evt.label || '';
    }
    return {
      set: function (phase, _lbl, done, total, note) { paint({ phase: phase, done: done, total: total, label: note }); },
      onEngine: paint,
      setTitle: function (t) { if (nameEl) nameEl.textContent = t; },
      done: function () {
        order.forEach(function (k) { var li = back.querySelector('li[data-k="' + k + '"]'); if (li) li.className = 'pi-done'; });
        phaseEl.textContent = 'Import complete'; noteEl.textContent = ''; barEl.style.width = '100%';
      },
      /* V3.494 — post-import Semantic Scholar enrichment (abstracts + refs).
       * The paper is already usable; this is optional + skippable. */
      enrichStart: function (total) {
        order.forEach(function (k) { var li = back.querySelector('li[data-k="' + k + '"]'); if (li) li.className = 'pi-done'; });
        phaseEl.textContent = 'Enriching references via Semantic Scholar… (0/' + total + ')';
        noteEl.textContent = 'Adds abstracts + reference lists. The paper is ready now — safe to skip.';
        barEl.style.width = '0%';
        if (!back.querySelector('.pi-skip')) {
          var b = document.createElement('button');
          b.className = 'pi-close pi-skip'; b.textContent = 'Skip enrichment';
          b.addEventListener('click', function () { _cancelled = true; b.disabled = true; b.textContent = 'Finishing…'; });
          back.querySelector('.pi-modal').appendChild(b);
        }
      },
      enrichProgress: function (done, total) {
        phaseEl.textContent = 'Enriching references via Semantic Scholar… (' + done + '/' + total + ')';
        barEl.style.width = (total ? Math.round(done / total * 100) : 0) + '%';
      },
      cancelled: function () { return _cancelled; },
      error: function (msg) {
        phaseEl.textContent = 'Import failed'; phaseEl.classList.add('pi-err'); noteEl.textContent = msg;
        var m = back.querySelector('.pi-modal'); if (m) m.classList.add('pi-modal-err');
        if (!back.querySelector('.pi-close')) {
          var b = document.createElement('button'); b.className = 'pi-close'; b.textContent = 'Close';
          b.addEventListener('click', function () { if (back.parentNode) back.parentNode.removeChild(back); });
          back.querySelector('.pi-modal').appendChild(b);
        }
      },
      close: function () { if (back.parentNode) back.parentNode.removeChild(back); },
    };
  }

  (typeof firebridge !== 'undefined' && firebridge.requireSignIn
    ? firebridge.requireSignIn('Sign in to manage paper drafts.')
    : Promise.resolve()).then(load).then(function () {
    // V3.229 — deep-link from the research view ("+ Add Item" type=paper)
    // opens this page with ?new=1 and expects the create modal to appear
    // immediately rather than forcing a second click.
    try {
      var params = new URLSearchParams(window.location.search);
      var importId = params.get('import');   // V3.472 — one-click bundle import
      if (importId) { importPaper(importId); return; }
      if (params.get('new') === '1') {
        openModal();
        // V3.470 — ?type=grant preselects the document type (used by the
        // grant-builder "+ New grant" hand-off) so the grant templates +
        // mechanism select show immediately.
        var t = params.get('type');
        if (t && typeSel) {
          var has = Array.prototype.some.call(typeSel.options, function (o) { return o.value === t; });
          if (has) { typeSel.value = t; populateTemplateSelect(); }
        }
      }
    } catch {}
  });
})();
