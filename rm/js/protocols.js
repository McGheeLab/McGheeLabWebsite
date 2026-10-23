/* protocols.js — list mode for the Protocols Builder.
 *
 * V3.113 — reads list rows from `protocols/list.json` (which is registered
 * in api-routes.js as Firestore collection `protocols`). Each card links
 * to /rm/pages/protocols.html?protocol=<id> which activates the editor.
 *
 * The "+ New protocol" modal creates the Firestore doc directly (so the
 * editor lands on a populated tree instead of materializing-on-first-save).
 * This is different from paper-builder, which writes to projects/papers.json
 * and lazily materializes the Firestore draft. We do it eagerly here because
 * protocols are born in Firestore — there's no JSON shadow.
 */

(function () {
  var statusEl   = document.getElementById('pr-status');
  var listEl     = document.getElementById('pr-list');
  var newBtn     = document.getElementById('pr-new-btn');
  var modalEl    = document.getElementById('pr-modal');
  var modalClose = document.getElementById('pr-modal-close');
  var modalCancel= document.getElementById('pr-modal-cancel');
  var modalCreate= document.getElementById('pr-modal-create');
  var modalError = document.getElementById('pr-modal-error');
  var titleInput = document.getElementById('pr-new-title');
  var idInput    = document.getElementById('pr-new-id');
  var templateSel= document.getElementById('pr-new-template');
  var templateHint = document.getElementById('pr-new-template-hint');
  var summaryInput = document.getElementById('pr-new-summary');

  var filterStatus = document.getElementById('pr-filter-status');
  var filterOwner  = document.getElementById('pr-filter-owner');
  var filterSearch = document.getElementById('pr-filter-search');
  var filterDemosWrap  = document.getElementById('pr-filter-demos-wrap');
  var filterDemos      = document.getElementById('pr-filter-demos');
  var filterDemosLabel = document.getElementById('pr-filter-demos-label');

  var protocols = [];

  function setStatus(msg, kind) {
    statusEl.textContent = msg || '';
    statusEl.className = 'pb-status' + (kind ? ' pb-status-' + kind : '');
  }

  function escapeHtml(s) {
    return String(s || '').replace(/[&<>"']/g, function (c) {
      return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c];
    });
  }

  /* Fall back to a plain slugify if util.js's slugify isn't loaded. */
  function _slugify(s) {
    if (typeof slugify === 'function') return slugify(s);
    return String(s || '')
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, '-')
      .replace(/^-+|-+$/g, '');
  }

  /* ── Load & render ── */

  async function load() {
    setStatus('Loading…');
    try {
      var data = await api.load('protocols/list.json');
      protocols = (data && data.protocols) || [];
      setStatus('');
      render();
    } catch (err) {
      setStatus('Failed to load protocols: ' + err.message, 'error');
    }
  }

  function currentUid() {
    return (typeof firebridge !== 'undefined' && firebridge.getUser())
      ? firebridge.getUser().uid : '';
  }

  function applyFilters(rows) {
    var s = filterStatus.value;
    var o = filterOwner.value;
    var q = (filterSearch.value || '').trim().toLowerCase();
    var uid = currentUid();
    return rows.filter(function (r) {
      // V3.386 — demo copies stay off the main list unless revealed
      if (isDemoRow(r) && !(filterDemos && filterDemos.checked)) return false;
      if (s !== 'all' && r.status !== s) return false;
      if (o === 'me' && r.ownerUid !== uid) return false;
      if (q) {
        var hay = (r.title + ' ' + (r.tags || []).join(' ') + ' ' + (r.summary || '')).toLowerCase();
        if (hay.indexOf(q) < 0) return false;
      }
      return true;
    });
  }

  function render() {
    listEl.innerHTML = '';
    // demo-filter toggle appears only when demo copies exist
    if (filterDemosWrap) {
      var nDemos = protocols.filter(isDemoRow).length;
      filterDemosWrap.hidden = !nDemos;
      if (filterDemosLabel) filterDemosLabel.textContent = 'show demos (' + nDemos + ')';
    }
    var rows = applyFilters(protocols.slice().sort(function (a, b) {
      return (b.updated_at || '').localeCompare(a.updated_at || '');
    }));
    if (!rows.length) {
      listEl.innerHTML = '<div class="empty-state">' +
        (protocols.length
          ? 'No protocols match your filters.'
          : 'No protocols yet. Click "New protocol" to start.') +
        '</div>';
      return;
    }
    rows.forEach(function (p) { listEl.appendChild(renderCard(p)); });
  }

  function renderCard(p) {
    var card = document.createElement('a');
    card.className = 'pb-card pr-card';
    card.href = '/rm/pages/protocols.html?protocol=' + encodeURIComponent(p.id);

    var statusHTML = typeof statusChip === 'function'
      ? statusChip(p.status)
      : '<span class="chip">' + escapeHtml(p.status) + '</span>';

    var tagsHTML = (p.tags || [])
      .map(function (t) { return '<span class="pr-tag">' + escapeHtml(t) + '</span>'; })
      .join('');

    // V3.119 — author byline + fork lineage badge.
    var bylineHTML = '';
    if (p.author_name) {
      bylineHTML = '<div class="pr-card-byline">by <strong>' + escapeHtml(p.author_name) + '</strong>';
      if (typeof p.current_version === 'number' && p.current_version > 0) {
        bylineHTML += ' · v' + p.current_version;
      }
      if (typeof p.fork_count === 'number' && p.fork_count > 0) {
        bylineHTML += ' · ' + p.fork_count + ' fork' + (p.fork_count === 1 ? '' : 's');
      }
      bylineHTML += '</div>';
    }
    var forkBadgeHTML = '';
    var ff = p.forked_from;
    if (ff && ff.protocol_id && !ff.migrated_to_standalone_at) {
      forkBadgeHTML = '<div class="pr-card-fork">' + ICON.svg('git-fork') + ' Fork of ' +
        escapeHtml(ff.protocol_title || ff.protocol_id) +
        (typeof ff.version === 'number' && ff.version > 0 ? ' v' + ff.version : '') +
        '</div>';
    }

    var demoChipHTML = isDemoRow(p) ? '<span class="chip pr-demo-chip">demo</span>' : '';

    card.innerHTML =
      '<div class="pb-card-row">' +
        '<div class="pb-card-title">' + escapeHtml(p.title || '(untitled)') + '</div>' +
        demoChipHTML +
        statusHTML +
      '</div>' +
      bylineHTML +
      forkBadgeHTML +
      (p.summary ? '<div class="pr-card-summary">' + escapeHtml(p.summary) + '</div>' : '') +
      '<div class="pb-card-meta">' +
        (p.category ? '<span>' + escapeHtml(p.category) + '</span>' : '') +
        (p.updated_at ? '<span> · updated ' + escapeHtml(p.updated_at.slice(0, 10)) + '</span>' : '') +
      '</div>' +
      (tagsHTML ? '<div class="pr-card-tags">' + tagsHTML + '</div>' : '');

    // V3.386 — owner-or-admin delete (rules updated to match)
    var isAdminUI = false;
    try { isAdminUI = typeof firebridge !== 'undefined' && firebridge.isAdmin && firebridge.isAdmin(); } catch (e) {}
    if (isAdminUI || (p.ownerUid && p.ownerUid === currentUid())) {
      var del = document.createElement('button');
      del.type = 'button';
      del.className = 'pr-card-del';
      del.title = 'Delete this protocol (and its version history)';
      ICON.label(del, 'trash');
      del.addEventListener('click', function (e) {
        e.preventDefault();
        e.stopPropagation();
        confirmDeleteProtocol(p);
      });
      card.appendChild(del);
    }
    return card;
  }

  /* ── V3.386 — delete a protocol ──────────────────────────────
   * Firestore doesn't cascade: delete the subcollection docs (version
   * snapshots, yjs snapshot/updates, stale presence) first, then the
   * doc. Subcollection cleanup is best-effort — a failure there never
   * blocks removing the protocol itself (orphans are unreachable once
   * the parent doc is gone; admin can sweep later). */
  async function deleteProtocolDeep(id) {
    var db = firebridge.db();
    var ref = db.collection('protocols').doc(id);
    var subs = ['versions', 'yjs_updates', 'yjs_snapshot', 'presence'];
    for (var i = 0; i < subs.length; i++) {
      try {
        var snap = await ref.collection(subs[i]).get();
        var docs = snap.docs || [];
        for (var j = 0; j < docs.length; j += 400) {
          var batch = db.batch();
          docs.slice(j, j + 400).forEach(function (d) { batch.delete(d.ref); });
          await batch.commit();
        }
      } catch (e) {
        console.warn('[protocols] cleanup of ' + subs[i] + ' failed (continuing):', e && e.message);
      }
    }
    await ref.delete();
  }

  async function confirmDeleteProtocol(p) {
    var msg = 'Delete “' + (p.title || p.id) + '”?\n\n' +
      'This permanently removes the protocol and its version history for the whole lab. This cannot be undone.';
    if (!window.confirm(msg)) return;
    setStatus('Deleting “' + (p.title || p.id) + '”…');
    try {
      await deleteProtocolDeep(p.id);
      protocols = protocols.filter(function (x) { return x.id !== p.id; });
      setStatus('Deleted “' + (p.title || p.id) + '”.');
      render();
    } catch (err) {
      console.error('[protocols] delete failed:', err);
      setStatus('Delete failed: ' + (err.message || err), 'error');
    }
  }

  /* ── New-protocol modal ── */

  function populateTemplateSelect() {
    var tpls = window.ProtocolSchemas.PROTOCOL_TEMPLATES;
    templateSel.innerHTML = '';
    Object.keys(tpls).forEach(function (k) {
      var opt = document.createElement('option');
      opt.value = k;
      opt.textContent = tpls[k].name;
      templateSel.appendChild(opt);
    });
    templateSel.value = 'wet-lab';
    updateTemplateHint();
  }

  function updateTemplateHint() {
    var t = window.ProtocolSchemas.PROTOCOL_TEMPLATES[templateSel.value];
    templateHint.textContent = t ? t.description : '';
  }

  function openModal() {
    modalEl.hidden = false;
    titleInput.value = '';
    idInput.value = '';
    summaryInput.value = '';
    modalError.hidden = true;
    modalError.textContent = '';
    populateTemplateSelect();
    setTimeout(function () { titleInput.focus(); }, 50);
  }

  function closeModal() { modalEl.hidden = true; }

  function suggestSlug() {
    if (!idInput.value.trim() && titleInput.value.trim()) {
      idInput.value = _slugify(titleInput.value);
    }
  }

  async function createProtocol() {
    var title = titleInput.value.trim();
    var id = (idInput.value.trim() || (title && _slugify(title)) || '').toLowerCase();
    var template_id = templateSel.value;
    var summary = summaryInput.value.trim();

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
    if (protocols.some(function (p) { return p.id === id; })) {
      modalError.textContent = 'A protocol with that slug already exists.';
      modalError.hidden = false;
      return;
    }

    var user = (typeof firebridge !== 'undefined') ? firebridge.getUser() : null;
    if (!user) {
      modalError.textContent = 'Sign in to create a protocol.';
      modalError.hidden = false;
      return;
    }

    // V3.119 — author byline. Cache the display name so list cards can
    // render without an extra users/{uid} lookup per row.
    var profile = (typeof firebridge !== 'undefined') ? firebridge.getProfile() : null;
    var displayName = (profile && profile.name) || user.displayName || user.email || user.uid;

    var doc = window.ProtocolSchemas.protocolEmptyDoc({
      id: id,
      title: title,
      ownerUid: user.uid,
      author_uid: user.uid,
      author_name: displayName,
      summary: summary,
      template_id: template_id,
    });

    modalCreate.disabled = true;
    modalCreate.textContent = 'Creating…';
    try {
      // Write the protocol doc straight to Firestore. We deliberately bypass
      // api.save here because that route is configured to splay each row
      // back into a single wrapped {protocols:[…]} JSON. The list view will
      // pick this doc up on its next reload via api.load('protocols/list.json').
      var db = firebridge.db();
      await db.collection('protocols').doc(id).set(doc);
      window.location.href = '/rm/pages/protocols.html?protocol=' + encodeURIComponent(id);
    } catch (err) {
      modalError.textContent = 'Failed to create: ' + (err.message || err);
      modalError.hidden = false;
      modalCreate.disabled = false;
      modalCreate.textContent = 'Create';
    }
  }

  /* ── Wire ── */

  /* ── V3.139 — Import flow ──────────────────────────────────── */

  var importBtn       = document.getElementById('pr-import-btn');
  var importModal     = document.getElementById('pr-import-modal');
  var importClose     = document.getElementById('pr-import-close');
  var importCancel    = document.getElementById('pr-import-cancel');
  var importCreate    = document.getElementById('pr-import-create');
  var importFileInp   = document.getElementById('pr-import-file');
  var importPasteArea = document.getElementById('pr-import-paste-area');
  var importPreview   = document.getElementById('pr-import-preview');
  var importSlugInp   = document.getElementById('pr-import-slug');
  var importProgress  = document.getElementById('pr-import-progress');
  var importError     = document.getElementById('pr-import-error');

  var _importParsed = null;       // last successfully-parsed object
  var _importSourceLabel = '';    // for messages

  function _resetImportModal() {
    importFileInp.value = '';
    importPasteArea.value = '';
    importSlugInp.value = '';
    importPreview.hidden = true;
    importPreview.innerHTML = '';
    importProgress.hidden = true;
    importProgress.textContent = '';
    importError.hidden = true;
    importError.textContent = '';
    importCreate.disabled = true;
    importCreate.textContent = 'Import';
    _importParsed = null;
    _importSourceLabel = '';
  }
  function openImportModal() {
    _resetImportModal();
    importModal.hidden = false;
    setTimeout(function () { importFileInp.focus(); }, 50);
  }
  function closeImportModal() { importModal.hidden = true; }

  function _showImportError(msg) {
    importError.textContent = msg;
    importError.hidden = false;
  }

  function _onParsed(parsed, sourceLabel) {
    importError.hidden = true;
    if (!window.PROTOCOL_IMPORT) {
      _showImportError('Importer module not loaded.');
      return;
    }
    var v = window.PROTOCOL_IMPORT.validate(parsed);
    if (!v.ok) {
      importPreview.hidden = true;
      _showImportError(v.errors.join('\n'));
      importCreate.disabled = true;
      return;
    }
    _importParsed = parsed;
    _importSourceLabel = sourceLabel;
    var s = window.PROTOCOL_IMPORT.summarize(parsed);
    var p = parsed.protocol || {};
    importPreview.innerHTML =
      '<div class="pr-import-preview-title">' + escapeHtml(p.title || '(untitled)') + '</div>' +
      (p.summary ? '<div class="pr-import-preview-summary">' + escapeHtml(p.summary) + '</div>' : '') +
      '<div class="pr-import-preview-counts">' +
        '<span>' + s.sections + ' section' + (s.sections === 1 ? '' : 's') + '</span>' +
        '<span>' + s.steps + ' step' + (s.steps === 1 ? '' : 's') + '</span>' +
        '<span>' + s.materials + ' materials block' + (s.materials === 1 ? '' : 's') + '</span>' +
        '<span>' + s.formulas + ' formula' + (s.formulas === 1 ? '' : 's') + '</span>' +
        '<span>' + s.figures + ' figure' + (s.figures === 1 ? '' : 's') + ' (' + s.images + ' embedded)</span>' +
        '<span>' + s.notes + ' note' + (s.notes === 1 ? '' : 's') + '</span>' +
        '<span>' + s.safeties + ' safety' + (s.safeties === 1 ? '' : 's') + '</span>' +
        // V3.325 — widget kinds; only surfaced when present to keep the
        // preview compact for simple protocols.
        (s.callouts ? '<span>' + s.callouts + ' callout' + (s.callouts === 1 ? '' : 's') + '</span>' : '') +
        (s.tables ? '<span>' + s.tables + ' table' + (s.tables === 1 ? '' : 's') + '</span>' : '') +
        (s.calculators ? '<span>' + s.calculators + ' calculator' + (s.calculators === 1 ? '' : 's') + '</span>' : '') +
        (s.builders ? '<span>' + s.builders + ' builder' + (s.builders === 1 ? '' : 's') + '</span>' : '') +
        (s.layoutMaps ? '<span>' + s.layoutMaps + ' layout map' + (s.layoutMaps === 1 ? '' : 's') + '</span>' : '') +
        (s.timelines ? '<span>' + s.timelines + ' timeline' + (s.timelines === 1 ? '' : 's') + '</span>' : '') +
        (s.kvs ? '<span>' + s.kvs + ' definition list' + (s.kvs === 1 ? '' : 's') + '</span>' : '') +
        (s.headings ? '<span>' + s.headings + ' heading' + (s.headings === 1 ? '' : 's') + '</span>' : '') +
        (s.docHeaders ? '<span>' + s.docHeaders + ' doc header' + (s.docHeaders === 1 ? '' : 's') + '</span>' : '') +
      '</div>' +
      (v.warnings.length ? '<div class="pr-import-preview-warnings">' + ICON.svg('exclamation-triangle') + ' ' +
        v.warnings.map(function (w) { return escapeHtml(w); }).join('<br>' + ICON.svg('exclamation-triangle') + ' ') + '</div>' : '');
    importPreview.hidden = false;
    if (!importSlugInp.value.trim()) {
      var seedSlug = p.id || _slugify(p.title || '');
      importSlugInp.value = seedSlug;
    }
    importCreate.disabled = false;
  }

  function _readFileAsText(file) {
    return new Promise(function (resolve, reject) {
      var fr = new FileReader();
      fr.onload = function () { resolve(fr.result); };
      fr.onerror = function () { reject(fr.error || new Error('Read failed')); };
      fr.readAsText(file);
    });
  }

  importFileInp.addEventListener('change', async function () {
    var f = importFileInp.files && importFileInp.files[0];
    if (!f) return;
    try {
      var text = await _readFileAsText(f);
      importPasteArea.value = ''; // file wins over paste
      var pr = window.PROTOCOL_IMPORT.parseJson(text);
      if (!pr.ok) {
        _showImportError(pr.errors.join('\n'));
        importCreate.disabled = true;
        return;
      }
      _onParsed(pr.parsed, f.name);
    } catch (err) {
      _showImportError('Failed to read file: ' + (err.message || err));
    }
  });

  importPasteArea.addEventListener('input', function () {
    var text = importPasteArea.value.trim();
    if (!text) {
      importPreview.hidden = true;
      importCreate.disabled = true;
      return;
    }
    var pr = window.PROTOCOL_IMPORT.parseJson(text);
    if (!pr.ok) {
      // Don't surface error while user is mid-paste; just disable.
      importPreview.hidden = true;
      importCreate.disabled = true;
      return;
    }
    _onParsed(pr.parsed, '(pasted)');
  });

  async function doImport() {
    if (!_importParsed) {
      _showImportError('Pick a file or paste JSON first.');
      return;
    }
    var slug = (importSlugInp.value || '').trim().toLowerCase();
    if (!slug) {
      _showImportError('Slug is required.');
      return;
    }
    importError.hidden = true;
    importCreate.disabled = true;
    importCreate.textContent = 'Importing…';
    importProgress.hidden = false;
    importProgress.textContent = 'Starting import…';
    try {
      var res = await window.PROTOCOL_IMPORT.createFromJson(_importParsed, {
        slug: slug,
        onProgress: function (p) {
          if (p.stage === 'check-uniqueness')      importProgress.textContent = 'Checking slug uniqueness…';
          else if (p.stage === 'upload-images')    importProgress.textContent = 'Uploading images (' + (p.done || 0) + '/' + (p.total || 0) + ')…';
          else if (p.stage === 'create-doc')       importProgress.textContent = 'Creating protocol doc…';
          else if (p.stage === 'snapshot-v1')      importProgress.textContent = 'Saving v1 snapshot…';
          else if (p.stage === 'done')             importProgress.textContent = 'Done.';
        },
      });
      var url = '/rm/pages/protocols.html?protocol=' + encodeURIComponent(res.id);
      if (res.autoMatch) url += '&match=1';
      window.location.href = url;
    } catch (err) {
      console.error('[protocols] import failed:', err);
      _showImportError('Import failed: ' + (err.message || err));
      importCreate.disabled = false;
      importCreate.textContent = 'Import';
      importProgress.hidden = true;
    }
  }

  /* ── V3.382 — Demo lessons ──────────────────────────────────
   * Bundled static protocol-import JSON under /rm/data/protocol-demos/.
   * Picking one fetches the file and creates the user's own copy via the
   * same createFromJson pipeline the Import button uses. Slugs are
   * suffixed on collision so a demo never overwrites an existing doc. */
  /* A LADDER, not a menu: each lesson assumes the previous and digs
   * deeper; by the end of Lesson 4 every feature has been touched
   * hands-on (nodes, wiring, bindings, sets/plates, code, viewer
   * skills, 🔗 references, and the protocol lifecycle). (V3.404) */
  var DEMOS = [
    { slug: 'lesson-1-variables-and-wires', title: 'Lesson 1 — Variables & wires',
      desc: 'START HERE · inputs → equation → a live reference in the write-up, plus the canvas basics (zoom, fit, collapse, tidy).',
      file: '/rm/data/protocol-demos/lesson-1-variables-and-wires.json',
      tour: 'build-lesson-1' },
    { slug: 'lesson-2-bindings-and-modifiers', title: 'Lesson 2 — Bindings & modifiers',
      desc: 'LEVEL 2 · drive a slider’s max from a constant, mirror a value, pick widgets & decimals — and cut + rebuild a wire from memory.',
      file: '/rm/data/protocol-demos/lesson-2-bindings-and-modifiers.json',
      tour: 'build-lesson-2' },
    { slug: 'lesson-3-sets-lists-plates', title: 'Lesson 3 — Sets, lists & plates',
      desc: 'LEVEL 3 · two axes crossed into an experiment list feeding the plate planner; locked sets, merge rules, scope colors, the unit legend.',
      file: '/rm/data/protocol-demos/lesson-3-sets-lists-plates.json',
      tour: 'build-lesson-3' },
    { slug: 'lesson-4-code-node', title: 'Lesson 4 — Code node & the full workflow',
      desc: 'CAPSTONE · script with named outputs, break-and-fix the error contract, recipes, wire surgery — then mark complete and meet versions/fork.',
      file: '/rm/data/protocol-demos/lesson-4-code-node.json',
      tour: 'build-lesson-4' },
  ];
  function _demoEditorUrl(id, d, opts) {
    return '/rm/pages/protocols.html?protocol=' + encodeURIComponent(id) +
      (d && d.tour ? '&tour=' + encodeURIComponent(d.tour) : '') +
      (opts && opts.reset ? '&reset=1' : '');
  }
  var demosBtn    = document.getElementById('pr-demos-btn');
  var demoModal   = document.getElementById('pr-demo-modal');
  var demoClose   = document.getElementById('pr-demo-close');
  var demoCancel  = document.getElementById('pr-demo-cancel');
  var demoListEl  = document.getElementById('pr-demo-list');
  var demoProg    = document.getElementById('pr-demo-progress');
  var demoError   = document.getElementById('pr-demo-error');

  function _uniqueSlug(base) {
    var taken = {};
    (protocols || []).forEach(function (p) { if (p && p.id) taken[p.id] = true; });
    if (!taken[base]) return base;
    var i = 2;
    while (taken[base + '-' + i]) i++;
    return base + '-' + i;
  }

  /* V3.386 — demo copies are flagged {is_demo, demo_of} at creation;
   * pre-flag copies (loaded before V3.386) are recognized by their id
   * matching a registry slug (exact or "-N" suffixed). */
  function isDemoRow(p) {
    if (!p) return false;
    if (p.is_demo) return true;
    return (typeof DEMOS !== 'undefined' ? DEMOS : []).some(function (d) {
      return p.id === d.slug || (p.id || '').indexOf(d.slug + '-') === 0;
    });
  }
  function myDemoRows() {
    var uid = currentUid();
    return (protocols || []).filter(function (p) { return isDemoRow(p) && p.ownerUid === uid; });
  }
  function myDemoCopyOf(d) {
    var uid = currentUid();
    return (protocols || []).filter(function (p) {
      if (p.ownerUid !== uid) return null;
      if (p.demo_of === d.slug) return true;
      return p.id === d.slug || (p.id || '').indexOf(d.slug + '-') === 0;
    })[0] || null;
  }
  function openDemoModal() {
    if (!demoModal) return;
    if (typeof firebridge !== 'undefined' && !currentUid()) {
      alert('Sign in first to load a demo lesson.');
      return;
    }
    demoError.hidden = true; demoProg.hidden = true;
    demoListEl.innerHTML = '';
    DEMOS.forEach(function (d) {
      var mine = myDemoCopyOf(d);
      var row = document.createElement('div');
      row.className = 'pr-demo-item';
      var main = document.createElement('div');
      main.className = 'pr-demo-item-main';
      main.innerHTML = '<span class="pr-demo-title">' + escapeHtml(d.title) +
        (mine ? ' <span class="pr-demo-have">you have a copy</span>' : '') + '</span>' +
        '<span class="pr-demo-desc">' + escapeHtml(d.desc) + '</span>';
      row.appendChild(main);
      var actions = document.createElement('div');
      actions.className = 'pr-demo-item-actions';
      if (mine) {
        // resume your in-progress copy…
        var openBtn = document.createElement('button');
        openBtn.type = 'button';
        openBtn.className = 'btn pr-demo-open';
        openBtn.textContent = 'Open my copy';
        openBtn.title = 'Continue your copy (the guided build resumes where you left off)';
        openBtn.addEventListener('click', function () { loadDemo(d, {}); });
        actions.appendChild(openBtn);
        // …or wipe it and walk the build from an empty canvas
        var freshBtn = document.createElement('button');
        freshBtn.type = 'button';
        freshBtn.className = 'btn pr-demo-fresh';
        ICON.label(freshBtn, 'arrow-uturn-left', ' Start from scratch');
        freshBtn.title = 'Clear your copy and walk through building it step by step';
        freshBtn.addEventListener('click', function () { loadDemo(d, { reset: true }); });
        actions.appendChild(freshBtn);
      } else {
        var startBtn = document.createElement('button');
        startBtn.type = 'button';
        startBtn.className = 'btn btn-primary pr-demo-start';
        ICON.label(startBtn, 'play', ' Start guided build');
        startBtn.title = 'Build this workflow yourself on an empty canvas, step by step';
        startBtn.addEventListener('click', function () { loadDemo(d, {}); });
        actions.appendChild(startBtn);
      }
      row.appendChild(actions);
      demoListEl.appendChild(row);
    });
    // bulk cleanup for the demo copies you own
    var demoClean = document.getElementById('pr-demo-clean');
    if (demoClean) {
      var mineAll = myDemoRows();
      demoClean.hidden = !mineAll.length;
      ICON.label(demoClean, 'trash', ' Remove my demo copies (' + mineAll.length + ')');
    }
    demoModal.hidden = false;
  }

  /* V3.386 — delete every demo copy the signed-in user owns. */
  async function cleanMyDemos() {
    var mine = myDemoRows();
    if (!mine.length) return;
    if (!window.confirm('Delete your ' + mine.length + ' demo cop' + (mine.length === 1 ? 'y' : 'ies') +
      '? Lessons can always be reloaded from this menu.')) return;
    demoError.hidden = true;
    demoProg.hidden = false;
    var failMsg = '';
    for (var i = 0; i < mine.length; i++) {
      demoProg.textContent = 'Removing ' + (i + 1) + ' / ' + mine.length + '…';
      try {
        await deleteProtocolDeep(mine[i].id);
        var goneId = mine[i].id;
        protocols = protocols.filter(function (x) { return x.id !== goneId; });
      } catch (err) {
        console.error('[protocols] demo cleanup failed for', mine[i].id, err);
        failMsg = 'Could not remove “' + (mine[i].title || mine[i].id) + '”: ' + (err.message || err);
      }
    }
    demoProg.hidden = true;
    render();
    openDemoModal(); // refresh counts + row states (resets the error line…)
    if (failMsg) { demoError.hidden = false; demoError.textContent = failMsg; } // …so restore it
  }
  function closeDemoModal() { if (demoModal) demoModal.hidden = true; }
  async function loadDemo(d, opts) {
    opts = opts || {};
    if (!window.PROTOCOL_IMPORT || !window.PROTOCOL_IMPORT.createFromJson) {
      demoError.hidden = false; demoError.textContent = 'Importer module not loaded.';
      return;
    }
    // V3.386 — you already have this lesson: open your copy instead of
    // minting another (demos shouldn't accumulate). V3.389 — reopening
    // launches the guided build (done steps auto-skip ✓). V3.391 — when
    // opts.reset, the editor empties the copy on load so the build walks
    // from an empty canvas ("Start from scratch"); otherwise it resumes.
    var existing = myDemoCopyOf(d);
    if (existing) {
      window.location.href = _demoEditorUrl(existing.id, d, opts);
      return;
    }
    demoError.hidden = true;
    demoProg.hidden = false; demoProg.textContent = 'Loading “' + d.title + '”…';
    Array.prototype.forEach.call(demoListEl.querySelectorAll('button'), function (b) { b.disabled = true; });
    try {
      var resp = await fetch(d.file);
      if (!resp.ok) throw new Error('could not fetch demo (' + resp.status + ')');
      var obj = await resp.json();
      // Demo base slugs are lab-global, so a collision is the COMMON case
      // (someone already loaded this lesson). createFromJson does an
      // authoritative server-side existence check and throws on collision;
      // _uniqueSlug only knows the client-side list, which may be stale or
      // still loading. So retry with an incrementing suffix until a free
      // slug is found — each user always gets their own copy.
      var base = _uniqueSlug(d.slug);
      var attempt = base, n = 1, res = null;
      while (n <= 50) {
        try {
          res = await window.PROTOCOL_IMPORT.createFromJson(obj, {
            slug: attempt,
            // V3.386 — flag the copy so it stays off the main list and
            // can be reused / bulk-removed
            extraFields: { is_demo: true, demo_of: d.slug },
            onProgress: function (p) {
              if (p.stage === 'create-doc')       demoProg.textContent = 'Creating your copy…';
              else if (p.stage === 'snapshot-v1') demoProg.textContent = 'Saving v1 snapshot…';
            },
          });
          break;
        } catch (e) {
          if (/already exists/i.test(e && e.message) && n < 50) {
            n++;
            attempt = d.slug + '-' + n;
            continue;
          }
          throw e;
        }
      }
      if (!res) throw new Error('Could not find a free slug for this demo.');
      window.location.href = _demoEditorUrl(res.id, d);
    } catch (err) {
      console.error('[protocols] demo load failed:', err);
      demoError.hidden = false; demoError.textContent = 'Could not load demo: ' + (err.message || err);
      demoProg.hidden = true;
      Array.prototype.forEach.call(demoListEl.querySelectorAll('button'), function (b) { b.disabled = false; });
    }
  }
  if (demosBtn) demosBtn.addEventListener('click', openDemoModal);
  if (demoClose) demoClose.addEventListener('click', closeDemoModal);
  if (demoCancel) demoCancel.addEventListener('click', closeDemoModal);
  var demoCleanBtn = document.getElementById('pr-demo-clean');
  if (demoCleanBtn) demoCleanBtn.addEventListener('click', cleanMyDemos);
  if (filterDemos) filterDemos.addEventListener('change', render);
  if (demoModal) demoModal.addEventListener('click', function (e) { if (e.target === demoModal) closeDemoModal(); });
  document.addEventListener('keydown', function (e) { if (e.key === 'Escape' && demoModal && !demoModal.hidden) closeDemoModal(); });

  importBtn.addEventListener('click', openImportModal);
  importClose.addEventListener('click', closeImportModal);
  importCancel.addEventListener('click', closeImportModal);
  importCreate.addEventListener('click', doImport);
  importModal.addEventListener('click', function (e) {
    if (e.target === importModal) closeImportModal();
  });
  document.addEventListener('keydown', function (e) {
    if (e.key === 'Escape' && !importModal.hidden) closeImportModal();
  });

  newBtn.addEventListener('click', openModal);
  modalClose.addEventListener('click', closeModal);
  modalCancel.addEventListener('click', closeModal);
  modalCreate.addEventListener('click', createProtocol);
  modalEl.addEventListener('click', function (e) {
    if (e.target === modalEl) closeModal();
  });
  titleInput.addEventListener('blur', suggestSlug);
  templateSel.addEventListener('change', updateTemplateHint);
  document.addEventListener('keydown', function (e) {
    if (e.key === 'Escape' && !modalEl.hidden) closeModal();
  });
  filterStatus.addEventListener('change', render);
  filterOwner.addEventListener('change', render);
  filterSearch.addEventListener('input', render);

  if (typeof firebridge !== 'undefined' && firebridge.requireSignIn) {
    firebridge.requireSignIn('Sign in to view lab protocols.').then(load);
  } else {
    load();
  }
})();
