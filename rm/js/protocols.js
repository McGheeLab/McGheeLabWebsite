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
      forkBadgeHTML = '<div class="pr-card-fork">🍴 Fork of ' +
        escapeHtml(ff.protocol_title || ff.protocol_id) +
        (typeof ff.version === 'number' && ff.version > 0 ? ' v' + ff.version : '') +
        '</div>';
    }

    card.innerHTML =
      '<div class="pb-card-row">' +
        '<div class="pb-card-title">' + escapeHtml(p.title || '(untitled)') + '</div>' +
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
    return card;
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
      (v.warnings.length ? '<div class="pr-import-preview-warnings">⚠ ' +
        v.warnings.map(function (w) { return escapeHtml(w); }).join('<br>⚠ ') + '</div>' : '');
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

  load();
})();
