/* paper-grant-docs.js — the "📎 Grant Docs" page of the paper editor
 * (V3.467, grant-writing unification R5).
 *
 * Reusable-document LIBRARY: pull a saved biosketch variant / facilities
 * doc / boilerplate template into a grant attached-document section and
 * edit it, or save a section's current prose back as a new reusable
 * default. Mirrors the equation-library insert/save pattern, but sources
 * from three stores:
 *
 *   - biosketches/{uid}/variants  (per-user; read for `biosketch` sections)
 *   - facilitiesDocs/{id}         (lab-shared; read for `facilities`)
 *   - grantDocTemplates/{id}      (NEW, lab-shared; the uniform save/reuse
 *                                  store for EVERY attached kind)
 *
 * The first two already exist (authored on grant-biosketch.html /
 * grant-facilities.html — untouched); this page just READS them for
 * insertion. grantDocTemplates is the new generic store both read and
 * written here (rules mirror facilitiesDocs). Insert appends blocks via
 * PaperEditor.insertBlockAt (never destroys existing content).
 *
 * R6 adds the submission-checklist panel above the library on this same
 * page; this module renders both (checklist stub until R6).
 *
 * Contract: window.PaperGrantDocs.buildTabContent(rootEl) — idempotent,
 * called by paper-equations._refreshPanel when the grant-docs page is
 * active (same contract as PaperWritingGuide / PaperSymbols).
 */
(function () {
  'use strict';

  var GD_COLL = 'grantDocTemplates';
  var _root = null;

  function _pe() { return window.PaperEditor; }
  function _schemas() { return window.PaperSchemas || {}; }
  function _db() {
    try { return (typeof firebridge !== 'undefined' && firebridge.db) ? firebridge.db() : null; }
    catch (e) { return null; }
  }
  function _uid() {
    try { return firebase.auth().currentUser.uid; } catch (e) { return null; }
  }
  function _esc(s) {
    return String(s == null ? '' : s).replace(/[&<>"']/g, function (c) {
      return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c];
    });
  }
  function _attachedKinds() {
    return (_schemas().GRANT_ATTACHED_KINDS) || [];
  }
  function _isGrantPaper() {
    try {
      var m = _pe() && _pe().getPaperMeta && _pe().getPaperMeta();
      return !!(m && m.paper_type === 'grant');
    } catch (e) { return false; }
  }

  /* ── Yjs section access (read block bodies for "save as template") ── */

  function _sectionChildren(sectionId) {
    var map = _pe() && _pe().getPaperMap && _pe().getPaperMap();
    if (!map) return null;
    var sections = map.get('sections');
    if (!sections || !sections.toArray) return null;
    var arr = sections.toArray();
    for (var i = 0; i < arr.length; i++) {
      if (arr[i].get('id') === sectionId) return arr[i].get('children');
    }
    return null;
  }

  /* A section's blocks → normalized [{kind, body, level, list_type}]. */
  function _sectionToBlocks(sectionId) {
    var children = _sectionChildren(sectionId);
    if (!children || !children.toArray) return [];
    return children.toArray().map(function (b) {
      var body = b.get('body');
      var attrs = b.get('attrs');
      return {
        kind: b.get('kind') || 'paragraph',
        body: (body && body.toString) ? body.toString() : String(body || ''),
        level: (attrs && attrs.get) ? attrs.get('level') : undefined,
        list_type: (attrs && attrs.get) ? attrs.get('list_type') : undefined,
      };
    }).filter(function (blk) {
      // Only prose-bearing kinds serialize to a template.
      return ['paragraph', 'subheading', 'list'].indexOf(blk.kind) >= 0;
    });
  }

  function _blocksToHtml(blocks) {
    return blocks.map(function (blk) {
      var text = _esc(blk.body).trim();
      if (blk.kind === 'subheading') {
        return (blk.level === 3 ? '<h4>' : '<h3>') + text + (blk.level === 3 ? '</h4>' : '</h3>');
      }
      if (blk.kind === 'list') {
        var tag = blk.list_type === 'number' ? 'ol' : 'ul';
        var items = String(blk.body || '').split('\n').map(function (l) { return l.trim(); })
          .filter(Boolean).map(function (l) { return '<li>' + _esc(l) + '</li>'; }).join('');
        return '<' + tag + '>' + items + '</' + tag + '>';
      }
      return '<p>' + text + '</p>';
    }).join('\n');
  }

  /* ── HTML → blocks (insertion) ── */
  /* Walk top-level nodes of an HTML fragment into the editor's block
   * vocabulary: <h2-4> → subheading (level 2/3), <ul>/<ol> → list block
   * (items newline-joined), everything else → paragraph. Reuses the
   * already-shipped block kinds — no new importer needed. */
  function _htmlToBlocks(html) {
    var out = [];
    var doc;
    try { doc = new DOMParser().parseFromString('<div>' + String(html || '') + '</div>', 'text/html'); }
    catch (e) { doc = null; }
    var container = doc && doc.body && doc.body.firstChild;
    if (!container) {
      var t = String(html || '').replace(/<[^>]+>/g, '').trim();
      if (t) out.push({ kind: 'paragraph', body: t });
      return out;
    }
    function pushText(kind, node, extra) {
      var txt = (node.textContent || '').replace(/\s+/g, ' ').trim();
      if (txt) out.push(Object.assign({ kind: kind, body: txt }, extra || {}));
    }
    Array.prototype.forEach.call(container.childNodes, function (node) {
      if (node.nodeType === 3) {   // bare text
        var txt = (node.nodeValue || '').replace(/\s+/g, ' ').trim();
        if (txt) out.push({ kind: 'paragraph', body: txt });
        return;
      }
      if (node.nodeType !== 1) return;
      var tag = node.tagName.toLowerCase();
      if (tag === 'ul' || tag === 'ol') {
        var items = Array.prototype.map.call(node.querySelectorAll('li'), function (li) {
          return (li.textContent || '').replace(/\s+/g, ' ').trim();
        }).filter(Boolean);
        if (items.length) out.push({ kind: 'list', body: items.join('\n'), list_type: tag === 'ol' ? 'number' : 'bullet' });
      } else if (tag === 'h1' || tag === 'h2' || tag === 'h3') {
        pushText('subheading', node, { level: 2 });
      } else if (tag === 'h4' || tag === 'h5' || tag === 'h6') {
        pushText('subheading', node, { level: 3 });
      } else if (tag === 'p' || tag === 'div' || tag === 'section') {
        // A container may itself hold headings/lists — recurse one level.
        var hasBlockChild = node.querySelector && node.querySelector('p,ul,ol,h1,h2,h3,h4,div');
        if (hasBlockChild) { _htmlToBlocks(node.innerHTML).forEach(function (b) { out.push(b); }); }
        else pushText('paragraph', node);
      } else {
        pushText('paragraph', node);
      }
    });
    return out;
  }

  /* Split a plain-text string (e.g. a biosketch personal statement) into
   * paragraph blocks on blank lines. */
  function _textToBlocks(text) {
    return String(text || '').split(/\n\s*\n/).map(function (p) { return p.replace(/\s+/g, ' ').trim(); })
      .filter(Boolean).map(function (p) { return { kind: 'paragraph', body: p }; });
  }

  function _insertBlocks(sectionId, blocks) {
    if (!blocks || !blocks.length || !_pe() || !_pe().insertBlockAt) return 0;
    var children = _sectionChildren(sectionId);
    var idx = (children && typeof children.length === 'number') ? children.length : 9999;
    var n = 0;
    blocks.forEach(function (blk) {
      var opts = { body: blk.body };
      if (blk.kind === 'subheading') opts.level = blk.level === 3 ? 3 : 2;
      if (blk.kind === 'list') opts.list_type = blk.list_type === 'number' ? 'number' : 'bullet';
      var id = _pe().insertBlockAt(sectionId, idx++, blk.kind, opts);
      if (id) n++;
    });
    return n;
  }

  /* ── Lightweight picker modal ── */
  function _openPicker(opts) {
    var old = document.getElementById('pgd-picker');
    if (old) old.remove();
    var overlay = document.createElement('div');
    overlay.className = 'pgd-overlay';
    overlay.id = 'pgd-picker';
    var card = document.createElement('div');
    card.className = 'pgd-card';
    overlay.appendChild(card);
    var head = document.createElement('div');
    head.className = 'pgd-card-head';
    head.textContent = opts.title || 'Choose';
    card.appendChild(head);
    var body = document.createElement('div');
    body.className = 'pgd-card-body';
    card.appendChild(body);

    function close() { document.removeEventListener('keydown', onKey, true); overlay.remove(); }
    function onKey(e) { if (e.key === 'Escape') { e.stopPropagation(); close(); } }
    document.addEventListener('keydown', onKey, true);
    overlay.addEventListener('mousedown', function (e) { if (e.target === overlay) close(); });

    if (opts.loading) {
      body.innerHTML = '<div class="pgd-empty">Loading…</div>';
    }
    var actions = document.createElement('div');
    actions.className = 'pgd-card-actions';
    var cancel = document.createElement('button');
    cancel.type = 'button'; cancel.className = 'btn btn-sm'; cancel.textContent = 'Cancel';
    cancel.addEventListener('click', close);
    actions.appendChild(cancel);
    card.appendChild(actions);

    document.body.appendChild(overlay);
    return {
      body: body,
      close: close,
      renderList: function (rows) {
        body.innerHTML = '';
        if (!rows.length) { body.innerHTML = '<div class="pgd-empty">' + _esc(opts.emptyText || 'Nothing saved yet.') + '</div>'; return; }
        rows.forEach(function (r) {
          var item = document.createElement('button');
          item.type = 'button';
          item.className = 'pgd-pick-item';
          item.innerHTML = '<span class="pgd-pick-name">' + _esc(r.name) + '</span>' +
            (r.meta ? '<span class="pgd-pick-meta">' + _esc(r.meta) + '</span>' : '') +
            (r.preview ? '<span class="pgd-pick-preview">' + _esc(r.preview) + '</span>' : '');
          item.addEventListener('click', function () { close(); r.onPick(); });
          body.appendChild(item);
        });
      },
    };
  }

  function _toast(msg) {
    var t = document.createElement('div');
    t.className = 'pgd-toast';
    t.textContent = msg;
    document.body.appendChild(t);
    setTimeout(function () { t.classList.add('pgd-toast-show'); }, 10);
    setTimeout(function () { t.classList.remove('pgd-toast-show'); }, 2400);
    setTimeout(function () { t.remove(); }, 2800);
  }

  /* ── Insert sources ── */

  function _insertBiosketch(sectionId) {
    var db = _db(), uid = _uid();
    if (!db || !uid) { alert('Sign in to load your biosketch variants.'); return; }
    var picker = _openPicker({ title: 'Insert from a biosketch variant', loading: true,
      emptyText: 'No biosketch variants yet — create one on the Biosketch page.' });
    db.collection('biosketches').doc(uid).collection('variants').get().then(function (snap) {
      var rows = snap.docs.map(function (d) {
        var v = d.data() || {};
        return {
          name: v.label || 'Untitled biosketch',
          meta: v.mechanism || '',
          preview: (v.personalStatement || '').slice(0, 120),
          onPick: function () {
            var blocks = _textToBlocks(v.personalStatement);
            if (!blocks.length) { alert('That variant has no Personal Statement text yet.'); return; }
            var n = _insertBlocks(sectionId, blocks);
            _toast('Inserted ' + n + ' paragraph' + (n === 1 ? '' : 's') + ' from "' + (v.label || 'biosketch') + '".');
            render();
          },
        };
      });
      picker.renderList(rows);
    }).catch(function (e) { picker.renderList([]); console.warn('[grant-docs] biosketch load failed', e); });
  }

  function _insertFacilities(sectionId) {
    var db = _db();
    if (!db) { alert('Sign in to load facilities documents.'); return; }
    var picker = _openPicker({ title: 'Insert from a saved facilities document', loading: true,
      emptyText: 'No facilities documents yet — create one on the Facilities page.' });
    var LABELS = { facilities: 'Facilities', equipment: 'Equipment', computing: 'Computing',
      office: 'Office & Meeting Space', otherResources: 'Other Resources' };
    db.collection('facilitiesDocs').get().then(function (snap) {
      var rows = snap.docs.map(function (d) {
        var f = d.data() || {};
        return {
          name: f.label || 'Untitled facilities doc',
          meta: (f.attachedTo || []).length ? ('used by ' + f.attachedTo.length + ' grant' + (f.attachedTo.length === 1 ? '' : 's')) : '',
          onPick: function () {
            var secs = f.sections || {};
            var blocks = [];
            ['facilities', 'equipment', 'computing', 'office', 'otherResources'].forEach(function (k) {
              var html = secs[k];
              if (html && String(html).replace(/<[^>]+>/g, '').trim()) {
                blocks.push({ kind: 'subheading', body: LABELS[k] || k, level: 2 });
                _htmlToBlocks(html).forEach(function (b) { blocks.push(b); });
              }
            });
            if (!blocks.length) { alert('That facilities document is empty.'); return; }
            var n = _insertBlocks(sectionId, blocks);
            _toast('Inserted ' + n + ' block' + (n === 1 ? '' : 's') + ' from "' + (f.label || 'facilities') + '".');
            render();
          },
        };
      });
      picker.renderList(rows);
    }).catch(function (e) { picker.renderList([]); console.warn('[grant-docs] facilities load failed', e); });
  }

  function _insertTemplate(sectionId, kind) {
    var db = _db();
    if (!db) { alert('Sign in to load saved templates.'); return; }
    var picker = _openPicker({ title: 'Insert from a saved template', loading: true,
      emptyText: 'No saved templates for this document type yet — use "Save as template" to create one.' });
    db.collection(GD_COLL).where('kind', '==', kind).get().then(function (snap) {
      var rows = snap.docs.map(function (d) {
        var t = Object.assign({ id: d.id }, d.data() || {});
        return {
          name: t.label || '(untitled template)',
          meta: t.owner_uid ? 'personal' : 'lab-shared',
          preview: String(t.body_html || '').replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ').trim().slice(0, 120),
          onPick: function () {
            var n = _insertBlocks(sectionId, _htmlToBlocks(t.body_html));
            _toast('Inserted ' + n + ' block' + (n === 1 ? '' : 's') + ' from "' + (t.label || 'template') + '".');
            render();
          },
        };
      }).sort(function (a, b) { return a.name.localeCompare(b.name); });
      picker.renderList(rows);
    }).catch(function (e) { picker.renderList([]); console.warn('[grant-docs] template load failed', e); });
  }

  /* ── Save a section's prose as a reusable grantDocTemplates entry ── */
  function _saveAsTemplate(sectionId, kind, sectionLabel) {
    var db = _db(), uid = _uid();
    if (!db || !uid) { alert('Sign in to save a template.'); return; }
    var blocks = _sectionToBlocks(sectionId);
    if (!blocks.length) { alert('This section has no text to save yet.'); return; }
    var name = window.prompt('Save this section as a reusable template named:', sectionLabel || '');
    if (name === null) return;
    name = String(name).trim();
    if (!name) return;
    var shared = window.confirm('Share with the whole lab?\n\nOK = lab-shared · Cancel = personal (only you).');
    var stamp = firebase.firestore.FieldValue.serverTimestamp();
    db.collection(GD_COLL).add({
      kind: kind,
      label: name,
      owner_uid: shared ? null : uid,
      body_html: _blocksToHtml(blocks),
      created_by: uid,
      created_at: stamp,
      updated_at: stamp,
    }).then(function () {
      _toast('Saved "' + name + '" as a ' + (shared ? 'lab-shared' : 'personal') + ' template.');
    }).catch(function (e) {
      alert('Could not save the template: ' + (e.message || e));
    });
  }

  /* ── Render ── */
  function buildTabContent(root) {
    if (!root) return;
    _root = root;
    render();
  }

  function render() {
    if (!_root) return;
    _root.innerHTML = '';
    var wrap = document.createElement('div');
    wrap.className = 'pgd-page';

    var h = document.createElement('h2');
    h.className = 'pgd-title';
    h.textContent = 'Grant Documents';
    wrap.appendChild(h);

    if (!_isGrantPaper()) {
      var note = document.createElement('p');
      note.className = 'pgd-lead';
      note.textContent = 'This page applies to grant papers. Set the document type to “Grant” on the Export page.';
      wrap.appendChild(note);
      _root.appendChild(wrap);
      return;
    }

    /* R6 mounts the submission checklist here. */
    var checklistHost = document.createElement('div');
    checklistHost.id = 'pgd-checklist-host';
    if (window.PaperGrantChecklist && window.PaperGrantChecklist.mount) {
      try { window.PaperGrantChecklist.mount(checklistHost); } catch (e) { /* R6 not loaded */ }
    }
    wrap.appendChild(checklistHost);

    /* V3.493 — per-paper PDF attachments (the final documents for this grant),
     * stored on paperExports.grantDocs — NOT as manuscript sections. */
    wrap.appendChild(_renderPdfPanel());

    var libHead = document.createElement('h3');
    libHead.className = 'pgd-section-head';
    libHead.textContent = 'Reusable documents';
    wrap.appendChild(libHead);
    var lead = document.createElement('p');
    lead.className = 'pgd-lead';
    lead.textContent = 'Pull a saved biosketch, facilities description, or boilerplate into a section and edit it — ' +
      'or save a section back as a reusable default. (These are text templates; final PDFs live in “Attached documents” above.)';
    wrap.appendChild(lead);

    var sections = (_pe() && _pe().getSectionsSummary && _pe().getSectionsSummary()) || [];
    var attached = _attachedKinds();
    var docSections = sections.filter(function (s) { return attached.indexOf(s.kind) >= 0; });

    if (!docSections.length) {
      var empty = document.createElement('div');
      empty.className = 'pgd-empty-card';
      empty.innerHTML = 'No attached-document sections yet. Add one (Biosketch, Facilities, Budget Justification, …) ' +
        'from the <strong>+ Add section</strong> menu on the Write page.';
      wrap.appendChild(empty);
      _root.appendChild(wrap);
      return;
    }

    var list = document.createElement('div');
    list.className = 'pgd-doc-list';
    docSections.forEach(function (s) {
      list.appendChild(_renderDocCard(s));
    });
    wrap.appendChild(list);
    _root.appendChild(wrap);
  }

  function _renderDocCard(s) {
    var card = document.createElement('div');
    card.className = 'pgd-doc-card';

    var title = document.createElement('div');
    title.className = 'pgd-doc-title';
    title.textContent = s.label || s.kind;
    card.appendChild(title);

    var editable = !!(_pe() && _pe().isEditable && _pe().isEditable());
    var actions = document.createElement('div');
    actions.className = 'pgd-doc-actions';

    function btn(text, title, fn) {
      var b = document.createElement('button');
      b.type = 'button';
      b.className = 'pgd-doc-btn';
      b.textContent = text;
      if (title) b.title = title;
      b.disabled = !editable;
      b.addEventListener('click', fn);
      actions.appendChild(b);
    }
    /* V3.469 — bridge link to the existing full-featured tool page
     * (opens in a new tab; not gated on editable — reading/managing the
     * source library is always allowed). */
    function linkBtn(text, title, href) {
      var a = document.createElement('a');
      a.className = 'pgd-doc-btn pgd-doc-link';
      a.textContent = text;
      a.title = title;
      a.href = href;
      a.target = '_blank';
      a.rel = 'noopener';
      actions.appendChild(a);
    }

    if (s.kind === 'biosketch') {
      btn('📥 Insert biosketch prose', 'Insert a saved biosketch variant’s Personal Statement', function () { _insertBiosketch(s.id); });
      linkBtn('🧬 Manage variants ↗', 'Open the Biosketch tool (mechanism-aware editor, live CV pull) in a new tab',
        '/rm/pages/grant-biosketch.html');
    }
    if (s.kind === 'facilities') {
      btn('📥 Insert facilities boilerplate', 'Insert a saved facilities document', function () { _insertFacilities(s.id); });
      linkBtn('🏢 Manage / regenerate ↗', 'Open the Facilities tool (auto-generate from inventory / equipment / people) in a new tab',
        '/rm/pages/grant-facilities.html');
    }
    btn('📥 Insert saved template', 'Insert a saved template for this document type', function () { _insertTemplate(s.id, s.kind); });
    btn('💾 Save as template', 'Save this section’s current text as a reusable template', function () { _saveAsTemplate(s.id, s.kind, s.label); });

    card.appendChild(actions);
    return card;
  }

  /* ── V3.493 — per-paper PDF attachments (paperExports.grantDocs) ──
   * The final submitted PDFs for this grant live here, NOT as manuscript
   * sections. Import routes them here; the author can also upload/replace/
   * remove manually. The submission checklist reads the same store for
   * per-document status. */
  function _paperId() {
    try { return new URLSearchParams(location.search).get('paper'); } catch (e) { return null; }
  }
  function _pdfEditable() { return !!(_pe() && _pe().isEditable && _pe().isEditable()); }
  function _kindOptions() {
    var L = _schemas().SECTION_KIND_LABELS || {};
    return _attachedKinds().map(function (k) { return { kind: k, label: L[k] || k }; });
  }

  function _renderPdfPanel() {
    var panel = document.createElement('div');
    panel.className = 'pgd-pdf-panel';
    var head = document.createElement('h3');
    head.className = 'pgd-section-head';
    head.textContent = 'Attached documents (PDF)';
    panel.appendChild(head);
    var lead = document.createElement('p');
    lead.className = 'pgd-lead';
    lead.textContent = 'The final PDFs for this grant (biosketch, budget, facilities, letters, …). Uploaded here, kept out of the manuscript. The checklist above tracks which are required.';
    panel.appendChild(lead);
    var host = document.createElement('div');
    host.className = 'pgd-pdf-host';
    host.textContent = 'Loading…';
    panel.appendChild(host);
    _loadGrantDocs().then(function (docs) { _renderPdfRows(host, docs); })
      .catch(function () { host.textContent = 'Could not load attachments.'; });
    return panel;
  }

  function _loadGrantDocs() {
    var db = _db(), pid = _paperId();
    if (!db || !pid) return Promise.resolve([]);
    return db.collection('paperExports').doc(pid).get()
      .then(function (s) { var d = s.exists ? s.data() : null; return (d && Array.isArray(d.grantDocs)) ? d.grantDocs : []; })
      .catch(function () { return []; });
  }
  function _saveGrantDocs(docs) {
    var db = _db(), pid = _paperId();
    if (!db || !pid) return Promise.reject(new Error('no paper'));
    return db.collection('paperExports').doc(pid).set({
      grantDocs: docs,
      updatedAt: firebase.firestore.FieldValue.serverTimestamp(),
    }, { merge: true });
  }

  function _renderPdfRows(host, docs) {
    host.innerHTML = '';
    var editable = _pdfEditable();
    if (docs.length) {
      var list = document.createElement('div');
      list.className = 'pgd-pdf-list';
      docs.forEach(function (d) { list.appendChild(_pdfRow(d, docs, host, editable)); });
      host.appendChild(list);
    } else {
      var empty = document.createElement('div');
      empty.className = 'pgd-empty-card';
      empty.textContent = 'No PDFs attached yet. Attach one below, or import a grant bundle.';
      host.appendChild(empty);
    }
    if (editable) host.appendChild(_pdfAddRow(docs, host));
  }

  function _pdfRow(d, docs, host, editable) {
    var row = document.createElement('div');
    row.className = 'pgd-pdf-row';
    var mb = d.size_bytes ? ' · ' + (d.size_bytes / 1048576).toFixed(2) + ' MB' : '';
    var meta = '<div class="pgd-pdf-info"><span class="pgd-pdf-label">' + _esc(d.label || d.kind) + '</span>' +
      '<span class="pgd-pdf-file">' + (d.download_url
        ? '<a href="' + _esc(d.download_url) + '" target="_blank" rel="noopener">' + _esc(d.filename || 'document.pdf') + '</a>'
        : _esc(d.filename || 'document.pdf')) + mb + '</span></div>';
    row.innerHTML = '<span class="pgd-pdf-icon">📎</span>' + meta;
    var actions = document.createElement('span');
    actions.className = 'pgd-pdf-actions';
    if (editable) {
      var rep = document.createElement('button');
      rep.type = 'button'; rep.className = 'pgd-doc-btn'; rep.textContent = 'Replace';
      rep.addEventListener('click', function () { _pdfPick(function (file) { _pdfUpload(file, d.kind, d.label, docs, host, d.id); }); });
      actions.appendChild(rep);
      var rem = document.createElement('button');
      rem.type = 'button'; rem.className = 'pgd-doc-btn pgd-doc-btn-danger'; rem.textContent = 'Remove';
      rem.addEventListener('click', function () {
        if (!window.confirm('Remove “' + (d.filename || d.label) + '” from this grant?')) return;
        var next = docs.filter(function (x) { return x.id !== d.id; });
        _saveGrantDocs(next).then(function () { _renderPdfRows(host, next); });
      });
      actions.appendChild(rem);
    }
    row.appendChild(actions);
    return row;
  }

  function _pdfAddRow(docs, host) {
    var add = document.createElement('div');
    add.className = 'pgd-pdf-add';
    var sel = document.createElement('select');
    sel.className = 'pgd-pdf-kind';
    _kindOptions().forEach(function (o) {
      var opt = document.createElement('option'); opt.value = o.kind; opt.textContent = o.label; sel.appendChild(opt);
    });
    var btn = document.createElement('button');
    btn.type = 'button'; btn.className = 'pgd-doc-btn'; btn.textContent = '＋ Attach PDF';
    btn.addEventListener('click', function () {
      var kind = sel.value;
      var label = (_kindOptions().filter(function (o) { return o.kind === kind; })[0] || {}).label || kind;
      _pdfPick(function (file) { _pdfUpload(file, kind, label, docs, host, null); });
    });
    add.appendChild(sel); add.appendChild(btn);
    return add;
  }

  function _pdfPick(cb) {
    var inp = document.createElement('input');
    inp.type = 'file'; inp.accept = 'application/pdf,.pdf'; inp.style.display = 'none';
    document.body.appendChild(inp);
    inp.addEventListener('change', function () {
      var f = inp.files && inp.files[0];
      if (inp.parentNode) inp.parentNode.removeChild(inp);
      if (f) cb(f);
    });
    inp.click();
  }

  function _pdfUpload(file, kind, label, docs, host, replaceId) {
    if (!file) return;
    if (!/pdf$/i.test(file.type) && !/\.pdf$/i.test(file.name)) { window.alert('Please choose a PDF.'); return; }
    if (!window.PAPER_FIGURES || !window.PAPER_FIGURES.uploadImage) { window.alert('Upload unavailable.'); return; }
    host.classList.add('pgd-busy');
    window.PAPER_FIGURES.uploadImage(_paperId(), file).then(function (res) {
      var entry = {
        id: replaceId || ((_schemas().shortId ? _schemas().shortId('gd-') : 'gd-' + Date.now())),
        kind: kind, label: label, filename: file.name,
        storage_path: res.storage_path, download_url: res.download_url, mime: res.mime || 'application/pdf',
        size_bytes: file.size || 0,
        uploaded_by: (function () { var u = firebridge.getUser && firebridge.getUser(); return u ? (u.email || u.uid) : ''; })(),
        uploaded_at: new Date().toISOString().slice(0, 10),
      };
      var next = replaceId
        ? docs.map(function (x) { return x.id === replaceId ? entry : x; })
        : docs.concat([entry]);
      return _saveGrantDocs(next).then(function () { host.classList.remove('pgd-busy'); _renderPdfRows(host, next); });
    }).catch(function (e) {
      host.classList.remove('pgd-busy');
      window.alert('Upload failed: ' + (e && e.message || e));
    });
  }

  window.PaperGrantDocs = { buildTabContent: buildTabContent };
})();
