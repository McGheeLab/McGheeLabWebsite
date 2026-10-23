/* paper-builder.js — list of lab papers + "new paper" creation flow.
 *
 * Reads `data/projects/papers.json` for paper metadata. Phase A: each paper
 * card links into `paper-builder.html?paper=…` (V3.60+; previously paper-editor.html?id=…). The editor stores the document
 * tree in Firestore at `papers/{paperId}/draft`; this list page does NOT touch
 * Firestore — it's safe to view papers when offline or signed out.
 *
 * Creating a new paper writes ONE self-owned `projects/{id}` doc (V3.729 —
 * never a whole-collection save, which non-admins can't commit). The
 * Firestore draft doc is materialized by the editor on first save; the
 * paper-author-sync function materializes papers/{id}.authorUids so the
 * creator can open it. Who may create: lab members, or a guest granted the
 * 'paper-builder:create' capability (see applyCreateGate).
 *
 * V3.740 — grouped by document type, most-recently-touched first (see
 * sortAndGroup). V3.741 — "Export for updates" checks a paper out as a
 * .paperbundle.zip and locks it; V3.742 — importing that bundle updates the
 * same paper in place and unlocks it (see the checkout block below).
 */

(function () {
  var statusEl   = document.getElementById('pb-status');
  var listEl     = document.getElementById('pb-list');
  var newBtn     = document.getElementById('pb-new-paper-btn');
  var importBtn  = document.getElementById('pb-import-btn');   // V3.47x
  var importFile = document.getElementById('pb-import-file');  // V3.47x
  var checkoutBtn = document.getElementById('pb-checkout-btn'); // V3.741
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

  /* ── V3.740 — grouping + recency sort ──
   *
   * The list used to render in whatever order Firestore returned (document-id
   * ascending, i.e. slug-alphabetical), which interleaved grants with papers
   * and buried whatever you actually worked on last. Papers are now grouped by
   * document type, most-recently-touched first inside each group.
   */

  var TYPE_GROUPS = [
    { key: 'journal',      label: 'Papers' },
    { key: 'grant',        label: 'Grants' },
    { key: 'editorial',    label: 'Editorials' },
    { key: 'book-chapter', label: 'Book chapters' },
    { key: 'presentation', label: 'Presentations' },
    { key: 'patent',       label: 'Patents' },
    { key: 'other',        label: 'Other' },
  ];

  function groupKeyOf(p) {
    var t = p.paper_type || 'journal';   // rows predating V3.419 carry no type
    for (var i = 0; i < TYPE_GROUPS.length; i++) {
      if (TYPE_GROUPS[i].key === t) return t;
    }
    return 'other';
  }

  /* `updatedAt` arrives in three different shapes: a real Firestore Timestamp
   * on a cold network read, a plain {seconds, nanoseconds} object after the
   * row has round-tripped through IndexedDB (structured clone drops the
   * prototype, so there is no .toMillis()), or an ISO string on rows written
   * by older code paths. Missing → 0, which sorts to the bottom. */
  function toMillis(v) {
    if (!v) return 0;
    if (typeof v === 'number') return v;
    if (typeof v.toMillis === 'function') { try { return v.toMillis(); } catch (e) { return 0; } }
    if (typeof v.seconds === 'number') return v.seconds * 1000 + Math.round((v.nanoseconds || 0) / 1e6);
    if (typeof v === 'string') { var t = Date.parse(v); return isNaN(t) ? 0 : t; }
    if (v instanceof Date) return v.getTime();
    return 0;
  }

  /* House relative-time formatter (mirrors activity-overview.js relativeTime,
   * taking millis instead of an ISO string). */
  function relativeTime(ms) {
    if (!ms) return '';
    var mins = Math.round((Date.now() - ms) / 60000);
    if (mins < 0) return 'just now';
    if (mins < 1) return 'just now';
    if (mins < 60) return mins + ' min ago';
    var hrs = Math.round(mins / 60);
    if (hrs < 24) return hrs + 'h ago';
    var days = Math.round(hrs / 24);
    if (days < 30) return days + 'd ago';
    return new Date(ms).toISOString().slice(0, 10);
  }

  function sortAndGroup(rows) {
    var byKey = {};
    rows.forEach(function (p) {
      var k = groupKeyOf(p);
      (byKey[k] || (byKey[k] = [])).push(p);
    });
    var out = [];
    TYPE_GROUPS.forEach(function (g) {
      var bucket = byKey[g.key];
      if (!bucket || !bucket.length) return;
      bucket.sort(function (a, b) {
        var d = toMillis(b.updatedAt) - toMillis(a.updatedAt);
        if (d) return d;
        return String(a.title || '').localeCompare(String(b.title || ''));
      });
      out.push({ key: g.key, label: g.label, papers: bucket });
    });
    return out;
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
      listEl.classList.remove('pb-grouped');
      listEl.innerHTML = '<div class="empty-state">No papers yet. Click "New paper" to start.</div>';
      return;
    }
    listEl.classList.add('pb-grouped');
    var groups = sortAndGroup(papers);
    var showHeaders = groups.length > 1;
    groups.forEach(function (g) {
      var section = document.createElement('div');
      section.className = 'pb-group';
      if (showHeaders) {
        var h = document.createElement('h2');
        h.className = 'pb-group-title';
        h.textContent = g.label;
        section.appendChild(h);
      }
      var grid = document.createElement('div');
      grid.className = 'pb-grid';
      g.papers.forEach(function (p) { grid.appendChild(renderCard(p)); });
      section.appendChild(grid);
      listEl.appendChild(section);
    });
  }

  function renderCard(p) {
    var card = document.createElement('a');
    card.className = 'pb-card';
    card.href = '/rm/pages/paper-builder.html?paper=' + encodeURIComponent(p.id);

    var coauthorCount = (p.coauthor_uids || []).length + (p.coauthor_emails || []).length;
    var statusHTML = typeof statusChip === 'function' ? statusChip(p.status) : '<span class="chip">' + (p.status || '') + '</span>';
    var editedAgo = relativeTime(toMillis(p.updatedAt));   // V3.740

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
        (editedAgo ? ' · <span class="pb-card-ago" title="Last edited">edited ' + escapeHtml(editedAgo) + '</span>' : '') +
      '</div>' +
      (p.repo_path ? '<div class="pb-card-repo">' + escapeHtml(p.repo_path) + '</div>' : '');

    /* V3.741 — checkout state. Locked: a lock row with who/when plus
     * "Import update" (authors/admin) and "Unlock" (admin / holder / lead).
     * Unlocked: a hover-revealed ⇩ in the corner next to delete. Every
     * control lives inside the <a>, so each one stops the navigation. */
    if (isCheckedOut(p)) {
      card.classList.add('pb-locked');
      var lockRow = document.createElement('div');
      lockRow.className = 'pb-card-lockrow';
      var when = p.checked_out_at ? relativeTime(toMillis(p.checked_out_at)) : '';
      lockRow.innerHTML =
        '<span class="pb-card-lock">' + ICON.svg('lock-closed') +
          ' Checked out by ' + escapeHtml(p.checked_out_by || 'someone') +
          (when ? ' · ' + escapeHtml(when) : '') +
        '</span>';
      if (canCheckOut(p)) {
        var imp = document.createElement('button');
        imp.type = 'button'; imp.className = 'pb-lock-btn';
        imp.title = 'Import the updated .paperbundle.zip back into this paper';
        imp.textContent = 'Import update';
        imp.addEventListener('click', function (e) {
          e.preventDefault(); e.stopPropagation();
          if (importFile) { importFile.value = ''; importFile.click(); }
        });
        lockRow.appendChild(imp);
      }
      if (canUnlock(p)) {
        var un = document.createElement('button');
        un.type = 'button'; un.className = 'pb-lock-btn pb-lock-btn-warn';
        un.title = 'Cancel this checkout without importing the bundle';
        un.textContent = 'Unlock';
        un.addEventListener('click', function (e) {
          e.preventDefault(); e.stopPropagation();
          confirmUnlock(p);
        });
        lockRow.appendChild(un);
      }
      card.appendChild(lockRow);
    } else if (canCheckOut(p)) {
      var exp = document.createElement('button');
      exp.type = 'button';
      exp.className = 'pb-card-export';
      exp.title = 'Export for updates — downloads the .paperbundle.zip and locks this paper until it comes back';
      exp.setAttribute('aria-label', 'Export for updates');
      ICON.label(exp, 'arrow-down-tray');
      exp.addEventListener('click', function (e) {
        e.preventDefault(); e.stopPropagation();
        confirmCheckOut(p);
      });
      card.appendChild(exp);
    }

    /* V3.482 — delete control (admin or lead author, once the CF is live).
     * The card is an <a>, so suppress navigation on the button click. */
    if (_deleteReady && canDelete(p)) {
      var del = document.createElement('button');
      del.type = 'button';
      del.className = 'pb-card-del';
      del.title = 'Delete this paper';
      del.setAttribute('aria-label', 'Delete paper');
      ICON.label(del, 'trash');
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
      // V3.647 — `typeof api`; `window.api` is always undefined (lexical const).
      try { if (typeof api !== 'undefined' && api.invalidate) await api.invalidate('projects/papers.json'); } catch (e) { /* non-fatal */ }
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
      // V3.729 — write ONE projects/{id} doc (as the bundle-import path does)
      // instead of re-saving the whole papers collection. The collection save
      // re-set every row with a fresh updatedAt, and the /projects update rule
      // denies rows the caller doesn't own — so for anyone but an admin the
      // batch failed and "+ New paper" never worked. The single-doc create is
      // exactly what the rule allows (type=='paper', lead_author_uid == me).
      var row = Object.assign({}, newRow, { type: 'paper' });
      delete row.id;
      row.updatedAt = firebase.firestore.FieldValue.serverTimestamp();
      await firebridge.db().collection('projects').doc(id).set(row);
      try { if (typeof api !== 'undefined' && api.invalidate) await api.invalidate('projects/papers.json'); } catch (e) { /* non-fatal */ }
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
  if (checkoutBtn) {                                   // V3.741 — export for updates
    ICON.label(checkoutBtn, 'arrow-down-tray', ' Export for updates');
    checkoutBtn.addEventListener('click', openCheckoutPicker);
  }
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

    // V3.742 — read paper.json first (cheap) so a checked-out bundle can be
    // routed back into ITS paper before any heavy work starts.
    var zip, manifest;
    try {
      zip = await window.JSZip.loadAsync(file);
      var manifestFile = zip.file('paper.json');
      if (!manifestFile) throw new Error('paper.json missing — not a paper bundle.');
      manifest = JSON.parse(await manifestFile.async('string'));
      if (!manifest.tree || !Array.isArray(manifest.tree.sections)) throw new Error('bundle has no section tree.');
    } catch (err) {
      setStatus('Import failed: ' + (err && err.message || err), 'err');
      return;
    }
    var co = manifest.checkout;
    var target = (co && co.paper_id) ? papers.find(function (p) { return p.id === co.paper_id; }) : null;
    if (target) {
      askUpdateOrCopy(target, co, function (choice) {
        if (choice === 'update') _runImport(zip, manifest, { mode: 'update', target: target });
        else if (choice === 'copy') _runImport(zip, manifest, { mode: 'create' });
      });
      return;
    }
    _runImport(zip, manifest, { mode: 'create' });
  }

  async function _runImport(zip, manifest, opts) {
    var db = firebridge.db();
    var user = firebridge.getUser();
    var isUpdate = opts.mode === 'update';
    var target = opts.target || null;

    var modal = _openImportModal('paper', isUpdate ? 'Updating' : 'Importing');
    try {
      modal.set('unzip', 'Reading bundle…', 0, 1, '');
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
      var slug;
      var profile = (typeof firebridge !== 'undefined') ? firebridge.getProfile() : null;

      if (isUpdate) {
        /* V3.742 — back into the SAME paper. The yjs_updates rule admits the
         * checkout HOLDER while locked, so make sure that is us: no holder →
         * claim it (our writes pass either way); someone else → take over and
         * wait for paper-author-sync to mirror the new holder onto papers/{id}
         * (the doc the rule reads). The lock is released only after the
         * engine succeeds — a failed import leaves the paper safely locked. */
        slug = target.id;
        var holder = target.checked_out_by_uid || null;
        if (holder !== user.uid) {
          modal.set('unzip', holder ? 'Taking over the checkout…' : 'Locking paper for update…', 0, 1, '');
          await db.collection('projects').doc(slug).set({
            checked_out_by_uid: user.uid,
            checked_out_by: (profile && profile.name) || user.displayName || user.email || 'Unknown',
            checked_out_at: (target.checked_out_at || new Date().toISOString()),
            checkout_token: (manifest.checkout && manifest.checkout.token) || target.checkout_token || null,
          }, { merge: true });
          if (holder) {
            var mirrored = await _waitForMirror(slug, function (d) { return d.checkedOutByUid === user.uid; }, 25000);
            if (!mirrored) console.warn('[paper-import] holder mirror not observed in time — proceeding');
          }
        }
      } else {
        slug = _freshSlug(title);
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
          updatedAt: firebase.firestore.FieldValue.serverTimestamp(),   // V3.740 — list sorts on it
        };
        await db.collection('projects').doc(slug).set(row);
        // V3.647 — `typeof api`; `window.api` is always undefined (lexical const).
        try { if (typeof api !== 'undefined' && api.invalidate) await api.invalidate('projects/papers.json'); } catch (e) { /* non-fatal */ }
      }

      // Run the full materialization with live progress. No navigation.
      var runRes = await window.PaperImportEngine.run({
        manifest: manifest, assets: assets, comments: comments, slug: slug,
        mode: isUpdate ? 'update' : 'create',
        onProgress: function (evt) { modal.onEngine(evt); },
      });

      if (isUpdate) {
        // Release the lock; the paper is current again. One merge write on
        // the row (lead author / admin / coauthor carve-out all pass).
        modal.set('done', 'Unlocking…', 0, 1, '');
        var del = firebase.firestore.FieldValue.delete();
        await db.collection('projects').doc(slug).set({
          checked_out_by_uid: del, checked_out_by: del, checked_out_at: del, checkout_token: del,
          updatedAt: firebase.firestore.FieldValue.serverTimestamp(),
        }, { merge: true });
        // Title may have changed in the repo. Lead author / admin only
        // (outside the coauthor carve-out) — best-effort, never fatal.
        if (title && title !== target.title) {
          try { await db.collection('projects').doc(slug).set({ title: title }, { merge: true }); } catch (e) { /* coauthor — skip */ }
        }
        try { if (typeof api !== 'undefined' && api.invalidate) await api.invalidate('projects/papers.json'); } catch (e) { /* non-fatal */ }
      }

      modal.done();
      await load();                         // refresh the list; the new card links to ?paper=slug
      setStatus(isUpdate
        ? 'Updated “' + title + '” from the bundle and unlocked it.'
        : 'Imported “' + title + '” — click it in the list to open.', 'ok');

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
  function _openImportModal(title, verb) {
    var back = document.createElement('div');
    back.className = 'pi-backdrop';
    back.innerHTML =
      '<div class="pi-modal">' +
        '<div class="pi-title">' + escapeHtml(verb || 'Importing') + ' “<span class="pi-name">' + escapeHtml(title) + '</span>”</div>' +
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

  /* ══════════════════════════════════════════════════════════════════════
   * V3.741 — "Export for updates": check a paper out as a .paperbundle.zip
   * and LOCK it until the bundle comes back (V3.742 import-in-place).
   *
   * Lock state lives on the paper's own projects/{id} row
   * (checked_out_by_uid / checked_out_by / checked_out_at / checkout_token);
   * paper-author-sync mirrors the holder onto papers/{id}.checkedOutByUid,
   * which the yjs_updates create rule reads. Read-only for EVERYONE while
   * locked — admins unlock, they don't bypass. Order matters: the zip is
   * built and downloaded FIRST and the lock written only on success, so a
   * failed export never strands a paper. All dialogs are in-page (never
   * window.confirm / prompt — they hang headless runs and break the app).
   * ══════════════════════════════════════════════════════════════════════ */

  function isCheckedOut(p) { return !!(p && p.checked_out_by_uid); }
  function canCheckOut(p) {
    return typeof firebridge !== 'undefined' && !!(firebridge.canCheckOutPaper && firebridge.canCheckOutPaper(p));
  }
  function canUnlock(p) {
    if (typeof firebridge === 'undefined' || !p) return false;
    var u = firebridge.getUser && firebridge.getUser();
    return !!((firebridge.isAdmin && firebridge.isAdmin()) ||
              (u && p.checked_out_by_uid === u.uid) ||
              (firebridge.isLeadAuthor && firebridge.isLeadAuthor(p)));
  }
  function _meName() {
    var prof = firebridge.getProfile && firebridge.getProfile();
    var u = firebridge.getUser && firebridge.getUser();
    return (prof && prof.name) || (u && (u.displayName || u.email)) || 'Unknown';
  }
  function _newToken() { return 'co-' + Math.random().toString(36).slice(2, 10) + Date.now().toString(36); }
  function _sleep(ms) { return new Promise(function (r) { setTimeout(r, ms); }); }

  /* Poll papers/{id} (the doc the rules read) until pred(data) holds. The
   * paper-author-sync trigger usually lands in 1–3 s; cold starts longer. */
  async function _waitForMirror(paperId, pred, timeoutMs) {
    var db = firebridge.db(), t0 = Date.now();
    while (Date.now() - t0 < timeoutMs) {
      try {
        var snap = await db.collection('papers').doc(paperId).get();
        if (pred(snap.exists ? (snap.data() || {}) : {})) return true;
      } catch (e) { /* keep polling */ }
      await _sleep(600);
    }
    return false;
  }

  /* Lazy deps: the exporter (and its optional bib helper) are only needed once
   * someone actually checks a paper out — don't tax every list load. */
  var _exportDepsP = null;
  function _loadScript(src) {
    return new Promise(function (res, rej) {
      var el = document.createElement('script');
      el.src = src;
      el.onload = function () { res(); };
      el.onerror = function () { rej(new Error('failed to load ' + src)); };
      document.head.appendChild(el);
    });
  }
  function _ensureExportDeps() {
    if (_exportDepsP) return _exportDepsP;
    _exportDepsP = (async function () {
      if (!window.PaperExportTex) {
        try { await _loadScript('/rm/js/paper-export-tex.js'); }
        catch (e) { console.warn('[paper-builder]', e.message, '— refs.bib skipped'); }
      }
      if (!window.PaperExportBundle) await _loadScript('/rm/js/paper-export-bundle.js');
    })();
    _exportDepsP.catch(function () { _exportDepsP = null; });
    return _exportDepsP;
  }

  /* ── In-page dialog on the .pi-* modal chrome ── */
  function _openDialog(opts) {
    var back = document.createElement('div');
    back.className = 'pi-backdrop';
    var card = document.createElement('div');
    card.className = 'pi-modal pi-dialog';
    card.innerHTML = '<div class="pi-title"></div><div class="pi-body"></div><div class="pi-actions"></div>';
    card.querySelector('.pi-title').textContent = opts.title || '';
    var body = card.querySelector('.pi-body');
    if (typeof opts.body === 'string') body.innerHTML = opts.body;
    else if (opts.body) body.appendChild(opts.body);
    back.appendChild(card);
    var dlg = { el: card, body: body, buttons: {}, close: close };
    function onKey(e) { if (e.key === 'Escape') close(); }
    function close() {
      document.removeEventListener('keydown', onKey);
      if (back.parentNode) back.parentNode.removeChild(back);
    }
    var acts = card.querySelector('.pi-actions');
    (opts.actions || []).forEach(function (a) {
      var b = document.createElement('button');
      b.type = 'button';
      b.className = 'btn' + (a.primary ? ' btn-primary' : '') + (a.danger ? ' pb-btn-danger' : '');
      b.textContent = a.label;
      if (a.disabled) b.disabled = true;
      b.addEventListener('click', function () { if (a.onClick) a.onClick(dlg, b); else close(); });
      acts.appendChild(b);
      if (a.id) dlg.buttons[a.id] = b;
    });
    document.addEventListener('keydown', onKey);
    back.addEventListener('click', function (e) { if (e.target === back) close(); });
    document.body.appendChild(back);
    return dlg;
  }

  /* Indeterminate progress card for the export (phases are network-bound). */
  function _openBusyModal(title, sub) {
    var back = document.createElement('div');
    back.className = 'pi-backdrop';
    back.innerHTML =
      '<div class="pi-modal">' +
        '<div class="pi-title"></div>' +
        '<div class="pi-phase"></div>' +
        '<div class="pi-bar pi-bar-indet"><i></i></div>' +
        '<div class="pi-note"></div>' +
      '</div>';
    back.querySelector('.pi-title').textContent = title || '';
    var phaseEl = back.querySelector('.pi-phase'), noteEl = back.querySelector('.pi-note');
    phaseEl.textContent = sub || 'Starting…';
    document.body.appendChild(back);
    return {
      say: function (m) { phaseEl.textContent = m || ''; },
      note: function (m) { noteEl.textContent = m || ''; },
      error: function (msg) {
        phaseEl.textContent = 'Export failed'; phaseEl.classList.add('pi-err'); noteEl.textContent = msg || '';
        var m = back.querySelector('.pi-modal'); if (m) m.classList.add('pi-modal-err');
        var bar = back.querySelector('.pi-bar'); if (bar) bar.classList.remove('pi-bar-indet');
        if (!back.querySelector('.pi-close')) {
          var b = document.createElement('button'); b.className = 'pi-close'; b.textContent = 'Close';
          b.addEventListener('click', function () { if (back.parentNode) back.parentNode.removeChild(back); });
          back.querySelector('.pi-modal').appendChild(b);
        }
      },
      close: function () { if (back.parentNode) back.parentNode.removeChild(back); },
    };
  }

  /* ── Check out ── */
  function confirmCheckOut(p) {
    var title = p.title || p.id;
    _openDialog({
      title: 'Export “' + title + '” for updates?',
      body:
        '<p>Downloads the paper as a <code>.paperbundle.zip</code> to edit in its VSCode repo.</p>' +
        '<p class="pi-warn"><b>The paper is then locked</b> — read-only for everyone, you included, ' +
        'until the updated bundle is imported back here (or an admin unlocks it).</p>',
      actions: [
        { label: 'Cancel' },
        { label: 'Export & lock', primary: true, onClick: function (dlg) { dlg.close(); runCheckOut(p); } },
      ],
    });
  }

  async function runCheckOut(p) {
    var title = p.title || p.id;
    if (!canCheckOut(p)) { setStatus('Only the paper’s authors or an admin can check it out.', 'err'); return; }
    if (isCheckedOut(p)) { setStatus('“' + title + '” is already checked out by ' + (p.checked_out_by || 'someone') + '.', 'err'); return; }
    var busy = _openBusyModal('Exporting “' + title + '”', 'Loading export tools…');
    var downloaded = false;
    try {
      await _ensureExportDeps();
      var user = firebridge.getUser();
      var checkout = {
        paper_id: p.id, token: _newToken(),
        checked_out_at: new Date().toISOString(),
        checked_out_by: _meName(), checked_out_by_uid: user.uid,
      };
      var res = await window.PaperExportBundle.buildForPaper(p.id, { meta: p, checkout: checkout }, busy.say);
      downloaded = true;
      // Zip is on disk — NOW lock. Single-doc merge on the paper's own row.
      busy.say('Locking paper…');
      await firebridge.db().collection('projects').doc(p.id).set({
        checked_out_by_uid: checkout.checked_out_by_uid,
        checked_out_by: checkout.checked_out_by,
        checked_out_at: checkout.checked_out_at,
        checkout_token: checkout.token,
        updatedAt: firebase.firestore.FieldValue.serverTimestamp(),
      }, { merge: true });
      try { if (typeof api !== 'undefined' && api.invalidate) await api.invalidate('projects/papers.json'); } catch (e) { /* non-fatal */ }
      busy.close();
      await load();
      setStatus('Exported ' + (res && res.name || 'the bundle') + ' and locked “' + title + '”. Import the bundle back to unlock.', 'ok');
    } catch (err) {
      console.error('[paper-checkout]', err);
      var msg = (err && err.message) || String(err);
      busy.error(downloaded ? 'Bundle downloaded but the paper could NOT be locked: ' + msg : msg);
      setStatus(downloaded
        ? 'Downloaded, but locking failed — “' + title + '” is still editable: ' + msg
        : 'Export failed — “' + title + '” was not locked: ' + msg, 'err');
    }
  }

  /* ── Unlock without importing ── */
  function confirmUnlock(p) {
    var title = p.title || p.id;
    var when = p.checked_out_at ? String(p.checked_out_at).slice(0, 16).replace('T', ' ') : '';
    _openDialog({
      title: 'Unlock “' + title + '”?',
      body:
        '<p>Checked out by <b>' + escapeHtml(p.checked_out_by || 'someone') + '</b>' + (when ? ' on ' + escapeHtml(when) : '') + '.</p>' +
        '<p class="pi-warn">Unlocking lets people edit here again. If that exported bundle is imported later, ' +
        'it will <b>overwrite</b> whatever was edited in the meantime.</p>',
      actions: [
        { label: 'Cancel' },
        { label: 'Unlock', danger: true, onClick: function (dlg) { dlg.close(); unlockPaper(p); } },
      ],
    });
  }

  async function unlockPaper(p) {
    var title = p.title || p.id;
    try {
      var del = firebase.firestore.FieldValue.delete();
      await firebridge.db().collection('projects').doc(p.id).set({
        checked_out_by_uid: del, checked_out_by: del, checked_out_at: del, checkout_token: del,
      }, { merge: true });
      try { if (typeof api !== 'undefined' && api.invalidate) await api.invalidate('projects/papers.json'); } catch (e) { /* non-fatal */ }
      await load();
      setStatus('Unlocked “' + title + '”.', 'ok');
    } catch (err) {
      setStatus('Unlock failed: ' + (err && err.message || err), 'err');
    }
  }

  /* ── Toolbar picker ── */
  function openCheckoutPicker() {
    var eligible = papers.filter(function (p) { return canCheckOut(p) && !isCheckedOut(p); });
    if (!eligible.length) {
      setStatus(papers.some(isCheckedOut)
        ? 'Every paper you can export is already checked out.'
        : 'No papers you can export — you must be an author on the paper.', 'err');
      return;
    }
    var list = document.createElement('div');
    list.className = 'pi-picklist';
    var groups = sortAndGroup(eligible);
    groups.forEach(function (g) {
      if (groups.length > 1) {
        var h = document.createElement('div'); h.className = 'pi-pick-group'; h.textContent = g.label; list.appendChild(h);
      }
      g.papers.forEach(function (p) {
        var lab = document.createElement('label');
        lab.className = 'pi-pick';
        var input = document.createElement('input');
        input.type = 'radio'; input.name = 'pb-pick'; input.value = p.id;
        var txt = document.createElement('span');
        txt.className = 'pi-pick-text';
        var ago = relativeTime(toMillis(p.updatedAt));
        txt.innerHTML = '<span class="pi-pick-title"></span><span class="pi-pick-meta"></span>';
        txt.querySelector('.pi-pick-title').textContent = p.title || p.id;
        txt.querySelector('.pi-pick-meta').textContent =
          [p.status || 'drafting', p.lead_author || '', ago ? 'edited ' + ago : ''].filter(Boolean).join(' · ');
        lab.appendChild(input); lab.appendChild(txt);
        list.appendChild(lab);
      });
    });
    var picked = null;
    var dlg = _openDialog({
      title: 'Export a paper for updates',
      body: list,
      actions: [
        { label: 'Cancel' },
        { id: 'go', label: 'Export & lock', primary: true, disabled: true,
          onClick: function (d) { if (!picked) return; d.close(); runCheckOut(picked); } },
      ],
    });
    var note = document.createElement('p');
    note.className = 'pi-warn';
    note.innerHTML = 'The chosen paper downloads as a <code>.paperbundle.zip</code> and is <b>locked</b> until that bundle is imported back.';
    dlg.body.appendChild(note);
    list.addEventListener('change', function (e) {
      var id = e.target && e.target.value;
      picked = eligible.find(function (p) { return p.id === id; }) || null;
      dlg.buttons.go.disabled = !picked;
    });
  }

  /* ── V3.742 — a bundle that carries a return address ── */
  function askUpdateOrCopy(target, co, cb) {
    var title = target.title || target.id;
    var when = co.checked_out_at ? String(co.checked_out_at).slice(0, 16).replace('T', ' ') : '';
    var mayUpdate = canCheckOut(target);
    var needsAck = false;
    var html =
      '<p>This bundle was checked out from <b>' + escapeHtml(title) + '</b>' +
      (co.checked_out_by ? ' by ' + escapeHtml(co.checked_out_by) : '') + (when ? ' on ' + escapeHtml(when) : '') + '.</p>';
    if (!mayUpdate) {
      html += '<p class="pi-warn">Only that paper’s authors or an admin can update it. You can still import the bundle as a new copy.</p>';
    } else if (isCheckedOut(target)) {
      if (target.checkout_token && co.token && target.checkout_token !== co.token) {
        needsAck = true;
        html += '<p class="pi-warn"><b>Different checkout.</b> The paper is currently checked out by ' +
          escapeHtml(target.checked_out_by || 'someone else') + ' — this bundle is from an older checkout. ' +
          'Updating will overwrite whatever that checkout brings back.</p>';
      } else {
        html += '<p class="pi-ok">The paper is locked, waiting for this bundle.</p>';
      }
    } else {
      needsAck = true;
      html += '<p class="pi-warn"><b>The paper is no longer locked.</b> Anything edited on the web since this ' +
        'export will be <b>overwritten</b> by the bundle.</p>';
    }
    if (needsAck) {
      html += '<label class="pi-ack"><input type="checkbox" id="pb-ack-overwrite"> I understand — update anyway</label>';
    }
    var dlg = _openDialog({
      title: 'Update “' + title + '” or import a copy?',
      body: html,
      actions: [
        { label: 'Cancel' },
        { label: 'Import as new copy', onClick: function (d) { d.close(); cb('copy'); } },
        { id: 'update', label: 'Update “' + title + '”', primary: true, disabled: !mayUpdate || needsAck,
          onClick: function (d) { d.close(); cb('update'); } },
      ],
    });
    var ack = dlg.body.querySelector('#pb-ack-overwrite');
    if (ack) ack.addEventListener('change', function () { dlg.buttons.update.disabled = !ack.checked; });
  }

  /* V3.729 — who may start a paper here: any lab member (role != guest), or a
   * guest holding the per-user 'paper-builder:create' capability granted from
   * the admin permissions page. Mirrors the /projects create rule; the rule
   * is the enforcement, this just hides buttons that would fail. */
  async function applyCreateGate() {
    if (typeof firebridge === 'undefined') return;
    try { if (firebridge.loadAccessGrant) await firebridge.loadAccessGrant(); } catch (e) { /* fall through — hide */ }
    var can = (firebridge.isLabMember && firebridge.isLabMember())
      || (firebridge.hasCapability && firebridge.hasCapability('paper-builder:create'));
    // style.display, not [hidden] — .btn's display:inline-flex outranks the UA hidden rule.
    if (newBtn) newBtn.style.display = can ? '' : 'none';
    if (importBtn) importBtn.style.display = can ? '' : 'none';
    if (checkoutBtn) checkoutBtn.style.display = can ? '' : 'none';   // V3.741
  }

  (typeof firebridge !== 'undefined' && firebridge.requireSignIn
    ? firebridge.requireSignIn('Sign in to manage paper drafts.')
    : Promise.resolve()).then(applyCreateGate).then(load).then(function () {
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
