/* cv-editor.js — edit your own cvData/{uid} document.
 *
 * This is the RM-side editor that shares the Firestore cvData contract with
 * the McGheeLabWebsite cv-builder app. Either side can create, edit, or
 * delete entries — the document is the single source of truth. Entries are
 * keyed by `_id` (7-char random string) so updates/deletes work regardless
 * of which UI wrote the row.
 *
 * Cross-page API: other RM pages append entries via CVStore.appendEntry
 * (cv-schemas.js) — that is what cv-send.js / year-review use. This file
 * exports nothing; it is the interactive editor only.
 *
 * V3.353 foundations:
 *  - live doc listener (onSnapshot) + echo guard, so two tabs / two editors
 *    stay in sync without clobbering in-progress edits
 *  - unified savePayload() with status chip + TOAST retry on failure
 *  - soft delete: entries move to an additive `trash` array (pruned to 50
 *    items / 30 days) with an 8s Undo toast + "Recently deleted" dialog
 *  - saves that touch publication sections mirror onto the public
 *    users/{uid} profile via CV_PROFILE_SYNC (parity with the parent app)
 *
 * V3.354 preview + templates:
 *  - live side-by-side preview pane (iframe srcdoc from CVExport.toHTML,
 *    300ms debounce) so the editor and the exported PDF can never disagree
 *  - template picker (CVExport.TEMPLATES) persisted in cv_meta.template
 *    (additive top-level key); Word .doc export joins MD/HTML/PDF
 *
 * V3.356 publications engine: 📚 pull-from-library (cv-library-pull.js,
 * name-matched review checklist), ORCID entries enriched from CrossRef,
 * batched citation refresh (CVImport.runBatched).
 * V3.357 onboarding: "Get started" rail + health chip + guided empty
 * states (cv-onboarding.js); completion derived from the doc itself.
 * V3.358 polish: keyboard shortcuts (n, [, ], p, Esc, ?).
 *
 * V3.355 curation:
 *  - entry list is year-grouped (mirrors the export) with ▲/▼ + drag
 *    reordering INSIDE a year group. Reordering rewrites the section array
 *    to display order — canonical array order is the contract; every
 *    consumer (parent app, biosketch, exports) re-sorts by year with a
 *    stable sort, so within-year manual order propagates everywhere.
 *  - audience variants share the parent cv-builder's cv_versions[] model
 *    ({_id, name, created, hiddenSections[], hiddenEntries{sec:[_id]}}) so
 *    both apps see the same variants; the active variant filters the
 *    preview and every export via CVExport.applyVariant.
 */

(function () {
  var root = document.getElementById('cve-root');
  var statusEl = document.getElementById('cve-status');
  var whoEl = document.getElementById('cve-who');
  var modal = document.getElementById('cve-modal');
  var modalTitle = document.getElementById('cve-modal-title');
  var modalBody = document.getElementById('cve-modal-body');

  var TRASH_MAX_ITEMS = 50;
  var TRASH_MAX_DAYS = 30;
  /* Sections mirrored onto the public users/{uid} profile. */
  var PROFILE_SYNC_KEYS = ['journals', 'conferences', 'presentations', 'patents'];

  var state = {
    uid: null,
    doc: null,              // full cvData document
    section: 'journals',    // currently selected section
    editing: null,          // entry being edited (null when adding)
    unsub: null,            // live listener detach fn
    savePending: false,     // a savePayload() is in flight
    suppressUntil: 0,       // ignore snapshot echoes until this ts
    remoteQueued: false,    // remote change arrived while user was editing
    previewOn: localStorage.getItem('cve-preview') === '1',
    variantId: localStorage.getItem('cve-variant') || '', // '' = full CV
  };

  /* ── auth gate ── */

  function showNotConnected() {
    root.innerHTML =
      '<div class="cve-gated">' +
        '<p><strong>Not connected to the website.</strong></p>' +
        '<p style="margin-top:8px">Sign in from <a href="/rm/pages/settings.html">Settings</a> to edit your CV.</p>' +
      '</div>';
  }

  function setStatus(msg, kind) {
    statusEl.textContent = msg || '';
    statusEl.className = 'cve-status' + (kind ? ' ' + kind : '');
    if (msg) setTimeout(function () {
      if (statusEl.textContent === msg) { statusEl.textContent = ''; statusEl.className = 'cve-status'; }
    }, 3000);
  }

  /* ── load / save ── */

  function makeEmptyDoc() {
    var d = { profile: {} };
    CV_SECTION_KEYS.forEach(function (k) { d[k] = []; });
    return d;
  }

  function normalizeDoc(doc) {
    doc = doc || makeEmptyDoc();
    doc.profile = doc.profile || {};
    CV_SECTION_KEYS.forEach(function (k) { if (!Array.isArray(doc[k])) doc[k] = []; });
    if (!Array.isArray(doc.trash)) doc.trash = [];
    if (!doc.cv_meta || typeof doc.cv_meta !== 'object') doc.cv_meta = {};
    if (!Array.isArray(doc.cv_versions)) doc.cv_versions = [];
    return doc;
  }

  function activeVariant() {
    if (!state.variantId) return null;
    return (state.doc.cv_versions || []).find(function (v) { return v._id === state.variantId; }) || null;
  }

  /* Options every export/preview shares — picked template + active variant. */
  function exportOpts() {
    return {
      template: (state.doc.cv_meta && state.doc.cv_meta.template) || CVExport.DEFAULT_TEMPLATE,
      variant: activeVariant(),
    };
  }

  /* True while the user has an edit in progress that a re-render would
   * wipe — the entry modal is open, or focus is inside a form control
   * (profile editor fields live inline in the section pane). */
  function editingInProgress() {
    if (modal.classList.contains('open')) return true;
    var ae = document.activeElement;
    return !!(ae && root.contains(ae) && /^(INPUT|TEXTAREA|SELECT)$/.test(ae.tagName));
  }

  /* Live doc listener. Replaces the old one-shot getDoc load: the first
   * snapshot paints the page, later snapshots keep other tabs / the
   * public-site builder in sync. Echo guard (savePending + suppressUntil +
   * hasPendingWrites) keeps our own writes from re-rendering us; if the
   * user is mid-edit we update state silently and re-render after they
   * finish (saves upsert by _id into the fresh arrays, so a queued remote
   * change to a different entry survives). */
  function subscribeDoc() {
    if (state.unsub) { try { state.unsub(); } catch (e) {} state.unsub = null; }
    var user = firebridge.getUser();
    if (!user) { showNotConnected(); return; }
    state.uid = user.uid;
    var profile = firebridge.getProfile();
    whoEl.textContent = (profile && profile.name) ? profile.name : user.email;
    var first = true;
    state.unsub = firebridge.db().collection('cvData').doc(state.uid).onSnapshot(
      function (snap) {
        if (!first && snap.metadata && snap.metadata.hasPendingWrites) return; // own optimistic echo
        if (!first && (state.savePending || Date.now() < state.suppressUntil)) return; // own server echo
        state.doc = normalizeDoc(snap.exists ? snap.data() : null);
        if (first) {
          first = false;
          render();
          return;
        }
        if (editingInProgress()) {
          state.remoteQueued = true;
          setStatus('Updated in another tab', 'ok');
        } else {
          render();
        }
      },
      function (err) {
        root.innerHTML = '<div class="cve-gated" style="background:#fee2e2;border-color:#fecaca;color:#991b1b">Failed to load CV: ' + escHtml(err.message) + '</div>';
      }
    );
  }

  function flushRemoteQueued() {
    if (state.remoteQueued) {
      state.remoteQueued = false;
      render();
    }
  }

  /* Unified write path. Every Firestore write to cvData goes through here:
   * arms the echo guard, drives the status chip, offers TOAST retry on
   * failure (and rethrows so call sites can react), and mirrors publication
   * sections onto the public profile. */
  async function savePayload(payload) {
    state.savePending = true;
    state.suppressUntil = Date.now() + 2500;
    setStatus('Saving…');
    try {
      await firebridge.setDoc('cvData', state.uid, payload, true);
      setStatus('Saved.', 'ok');
    } catch (err) {
      setStatus('Save failed: ' + err.message, 'err');
      if (typeof TOAST !== 'undefined') {
        TOAST.error('CV save failed', { detail: err.message, retry: function () { savePayload(payload); } });
      }
      throw err;
    } finally {
      state.savePending = false;
    }
    var touchesProfile = Object.keys(payload).some(function (k) { return PROFILE_SYNC_KEYS.indexOf(k) >= 0; });
    if (touchesProfile && typeof CV_PROFILE_SYNC !== 'undefined') {
      CV_PROFILE_SYNC.schedule(state.uid, state.doc);
    }
    refreshPreview();
  }

  async function saveSection(sectionKey, extra) {
    var payload = {};
    payload[sectionKey] = state.doc[sectionKey];
    if (extra) Object.keys(extra).forEach(function (k) { payload[k] = extra[k]; });
    await savePayload(payload);
  }

  /* ── trash / undo ── */

  function pruneTrash() {
    var cutoff = Date.now() - TRASH_MAX_DAYS * 86400000;
    state.doc.trash = (state.doc.trash || [])
      .filter(function (t) {
        var ts = Date.parse(t.deleted_at || '');
        return isNaN(ts) ? true : ts >= cutoff;
      })
      .slice(-TRASH_MAX_ITEMS);
  }

  async function deleteEntry(sectionKey, entry) {
    var list = state.doc[sectionKey] || [];
    var idx = list.findIndex(function (e) { return e._id === entry._id; });
    if (idx < 0) return;
    list.splice(idx, 1);
    state.doc.trash = state.doc.trash || [];
    state.doc.trash.push({ section: sectionKey, entry: entry, deleted_at: new Date().toISOString() });
    pruneTrash();
    try {
      await saveSection(sectionKey, { trash: state.doc.trash });
    } catch (e) { render(); return; }
    render();
    var undo = async function () {
      await restoreFromTrash(entry._id, idx);
    };
    if (typeof TOAST !== 'undefined') {
      TOAST.success('Entry deleted', { actionLabel: 'Undo', retry: undo, ttl: 8000 });
    }
  }

  /* Restore a trashed entry. `atIndex` (optional) reinserts at the spot it
   * was deleted from; dialog restores append instead (list views re-sort
   * by year anyway). No-ops safely if the entry was already restored. */
  async function restoreFromTrash(entryId, atIndex) {
    var trash = state.doc.trash || [];
    var ti = trash.findIndex(function (t) { return t.entry && t.entry._id === entryId; });
    if (ti < 0) return;
    var item = trash[ti];
    trash.splice(ti, 1);
    var list = state.doc[item.section] = state.doc[item.section] || [];
    var exists = list.some(function (e) { return e._id === entryId; });
    if (!exists) {
      var pos = (typeof atIndex === 'number') ? Math.min(Math.max(atIndex, 0), list.length) : list.length;
      list.splice(pos, 0, item.entry);
    }
    try {
      await saveSection(item.section, { trash: trash });
      setStatus('Entry restored.', 'ok');
    } catch (e) {}
    render();
  }

  function openTrashDialog() {
    var trash = (state.doc.trash || []).slice().reverse(); // newest first
    var body;
    if (!trash.length) {
      body = '<div style="padding:20px;text-align:center;color:#6b7280;font-size:13px">Nothing here — deleted entries are kept for ' + TRASH_MAX_DAYS + ' days.</div>';
    } else {
      body = '<div style="max-height:380px;overflow:auto;border:1px solid #e5e7eb;border-radius:6px">';
      trash.forEach(function (t) {
        var e = t.entry || {};
        var disp = CV_DISPLAY[t.section] || { title: 'title' };
        var title = cvCleanText(e[disp.title] || e.title || e.name || e.role) || '(untitled)';
        var ts = Date.parse(t.deleted_at || '');
        var age = isNaN(ts) ? '' : Math.max(0, Math.floor((Date.now() - ts) / 86400000)) + 'd ago';
        body += '<div style="display:flex;gap:10px;align-items:center;padding:8px 10px;border-bottom:1px solid #f1f5f9">' +
          '<div style="flex:1;min-width:0">' +
            '<div style="font-size:13px;color:#111827;overflow:hidden;text-overflow:ellipsis;white-space:nowrap">' + escHtml(title) + '</div>' +
            '<div style="font-size:11px;color:#6b7280">' + escHtml([CV_SECTION_LABELS[t.section] || t.section, age].filter(Boolean).join(' · ')) + '</div>' +
          '</div>' +
          '<button class="btn" data-restore="' + escAttr(e._id || '') + '" style="font-size:12px;padding:4px 10px">' + ICON.svg('arrow-uturn-left') + ' Restore</button>' +
        '</div>';
      });
      body += '</div>';
    }
    var dlg = openDialog('Recently deleted', body +
      '<div style="display:flex;justify-content:flex-end;margin-top:12px;padding-top:10px;border-top:1px solid #f1f5f9">' +
        '<button class="btn" id="cve-trash-close">Close</button>' +
      '</div>');
    dlg.panel.querySelector('#cve-trash-close').addEventListener('click', dlg.close);
    dlg.panel.querySelectorAll('[data-restore]').forEach(function (btn) {
      btn.addEventListener('click', async function () {
        btn.disabled = true;
        await restoreFromTrash(btn.dataset.restore);
        dlg.close();
      });
    });
  }

  /* ── render ── */

  function render() {
    state.remoteQueued = false;
    root.innerHTML = '';
    root.appendChild(renderToolbar());
    if (typeof CV_ONBOARDING !== 'undefined') {
      var rail = CV_ONBOARDING.render(onboardingCtx());
      if (rail) root.appendChild(rail);
    }
    var wrap = document.createElement('div');
    wrap.className = 'cve-layout' + (state.previewOn ? ' with-preview' : '');
    wrap.appendChild(renderSidebar());
    wrap.appendChild(renderSection());
    if (state.previewOn) wrap.appendChild(renderPreviewPane());
    root.appendChild(wrap);
    refreshPreview();
  }

  /* ── live preview (V3.354) ── */

  var _previewTimer = null;
  function refreshPreview() {
    if (!state.previewOn || !state.doc) return;
    if (_previewTimer) clearTimeout(_previewTimer);
    _previewTimer = setTimeout(function () {
      _previewTimer = null;
      var frame = document.getElementById('cve-preview-frame');
      if (frame) frame.srcdoc = CVExport.toHTML(state.doc, exportOpts());
    }, 300);
  }

  function togglePreview() {
    state.previewOn = !state.previewOn;
    localStorage.setItem('cve-preview', state.previewOn ? '1' : '0');
    render();
  }

  function renderPreviewPane() {
    var pane = document.createElement('div');
    pane.className = 'cve-preview';
    var head = document.createElement('div');
    head.className = 'cve-preview-head';
    var lbl = document.createElement('span');
    lbl.style.cssText = 'font-size:11px;color:#6b7280;text-transform:uppercase;letter-spacing:.6px;flex:1';
    lbl.textContent = 'Live preview';
    head.appendChild(lbl);
    var sel = document.createElement('select');
    sel.style.cssText = 'font-size:12px;padding:3px 6px;border:1px solid #d1d5db;border-radius:6px;color:#374151';
    Object.keys(CVExport.TEMPLATES).forEach(function (key) {
      var o = document.createElement('option');
      o.value = key;
      o.textContent = CVExport.TEMPLATES[key].label;
      if (key === exportOpts().template) o.selected = true;
      sel.appendChild(o);
    });
    sel.addEventListener('change', async function () {
      state.doc.cv_meta = state.doc.cv_meta || {};
      state.doc.cv_meta.template = sel.value;
      refreshPreview();
      try { await savePayload({ cv_meta: state.doc.cv_meta }); } catch (e) {}
    });
    head.appendChild(sel);
    var close = document.createElement('button');
    close.className = 'btn';
    ICON.label(close, 'x-mark');
    close.title = 'Hide preview';
    close.style.cssText = 'padding:2px 8px;font-size:12px';
    close.addEventListener('click', togglePreview);
    head.appendChild(close);
    pane.appendChild(head);
    var frame = document.createElement('iframe');
    frame.id = 'cve-preview-frame';
    frame.setAttribute('sandbox', 'allow-same-origin');
    frame.title = 'CV preview';
    pane.appendChild(frame);
    return pane;
  }

  /* Toolbar — ORCID sync, BibTeX import, Citations refresh, Export/Backup. */
  function renderToolbar() {
    var bar = document.createElement('div');
    bar.className = 'cve-toolbar';
    function mkBtn(label, onClick, color, icon) {
      var b = document.createElement('button');
      b.className = 'btn';
      if (icon) ICON.label(b, icon, ' ' + label);
      else b.textContent = label;
      if (color) { b.style.borderColor = color; b.style.color = color; }
      b.addEventListener('click', onClick);
      return b;
    }
    if (typeof CV_ONBOARDING !== 'undefined') {
      bar.appendChild(CV_ONBOARDING.healthChip(onboardingCtx()));
    }
    bar.appendChild(mkBtn('Pull from library', openLibraryPull, '#b45309', 'books'));
    bar.appendChild(mkBtn('⊕ ORCID sync',     openORCIDDialog,  '#059669'));
    bar.appendChild(mkBtn('⇓ Import BibTeX',   openBibTeXDialog, '#2563eb'));
    bar.appendChild(mkBtn('↻ Refresh citations', runCitationRefresh, '#7c3aed'));
    var sep = document.createElement('span');
    sep.style.cssText = 'flex:1';
    bar.appendChild(sep);
    /* Audience variant — filters preview + every export (V3.355). */
    var variants = state.doc.cv_versions || [];
    var vSel = document.createElement('select');
    vSel.title = 'Audience variant — which entries the preview and exports include';
    vSel.style.cssText = 'font-size:12px;padding:4px 6px;border:1px solid #d1d5db;border-radius:6px;color:#374151;max-width:170px';
    var optFull = document.createElement('option');
    optFull.value = '';
    optFull.textContent = 'Full CV';
    vSel.appendChild(optFull);
    variants.forEach(function (v) {
      var o = document.createElement('option');
      o.value = v._id;
      o.textContent = v.name || '(unnamed)';
      if (v._id === state.variantId) o.selected = true;
      vSel.appendChild(o);
    });
    vSel.addEventListener('change', function () {
      state.variantId = vSel.value;
      localStorage.setItem('cve-variant', state.variantId);
      render();
    });
    bar.appendChild(vSel);
    bar.appendChild(mkBtn('Variants', openVariantsDialog, null, 'cog-6-tooth'));
    var previewBtn = mkBtn(state.previewOn ? 'Hide preview' : 'Preview', togglePreview, null, 'eye');
    if (state.previewOn) { previewBtn.style.borderColor = '#2563eb'; previewBtn.style.color = '#2563eb'; }
    bar.appendChild(previewBtn);
    bar.appendChild(mkBtn('⇩ Markdown',      function () { CVExport.downloadMarkdown(state.doc, exportBaseName(), exportOpts()); markExported(); }));
    bar.appendChild(mkBtn('⇩ HTML',          function () { CVExport.downloadHTML(state.doc, exportBaseName(), exportOpts()); markExported(); }));
    bar.appendChild(mkBtn('⇩ Word (.doc)',   function () { CVExport.downloadDoc(state.doc, exportBaseName(), exportOpts()); markExported(); }));
    bar.appendChild(mkBtn('⇩ Backup (JSON)', downloadBackup));
    bar.appendChild(mkBtn('Print / PDF',     function () { CVExport.openPrintPreview(state.doc, exportOpts()); markExported(); }, null, 'printer'));
    return bar;
  }

  function downloadBackup() {
    var content = JSON.stringify(state.doc, null, 2);
    var blob = new Blob([content], { type: 'application/json;charset=utf-8' });
    var a = document.createElement('a');
    a.href = URL.createObjectURL(blob);
    a.download = exportBaseName() + '-backup.json';
    document.body.appendChild(a);
    a.click();
    setTimeout(function () {
      URL.revokeObjectURL(a.href);
      document.body.removeChild(a);
    }, 100);
  }

  function exportBaseName() {
    var name = (state.doc.profile && state.doc.profile.name) || 'cv';
    return 'cv-' + String(name).toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '');
  }

  function renderSidebar() {
    var side = document.createElement('div');
    side.className = 'cve-side';
    CV_SECTION_GROUPS.forEach(function (grp) {
      var hdr = document.createElement('div');
      hdr.className = 'cve-side-group';
      hdr.textContent = grp.label;
      side.appendChild(hdr);
      grp.keys.forEach(function (k) {
        var btn = document.createElement('button');
        var count = k === 'profile' ? '' : (state.doc[k] || []).length;
        btn.innerHTML = CV_SECTION_LABELS_EXT[k] + (count === '' ? '' : '<span class="cve-side-count">' + count + '</span>');
        if (k === state.section) btn.classList.add('active');
        btn.addEventListener('click', function () { state.section = k; render(); });
        side.appendChild(btn);
      });
    });
    var trashCount = (state.doc.trash || []).length;
    if (trashCount > 0) {
      var trashLink = document.createElement('button');
      trashLink.className = 'cve-trash-link';
      trashLink.innerHTML = ICON.svg('trash') + ' Recently deleted<span class="cve-side-count">' + trashCount + '</span>';
      trashLink.addEventListener('click', openTrashDialog);
      side.appendChild(trashLink);
    }
    return side;
  }

  function renderSection() {
    var main = document.createElement('div');
    main.className = 'cve-main';
    var head = document.createElement('div');
    head.className = 'cve-section-head';
    head.innerHTML = '<h2>' + CV_SECTION_LABELS_EXT[state.section] + '</h2>';
    if (state.section !== 'profile') {
      var addBtn = document.createElement('button');
      addBtn.className = 'btn btn-primary';
      addBtn.textContent = '+ Add entry';
      addBtn.addEventListener('click', function () { openModal(state.section, null); });
      head.appendChild(addBtn);
    }
    main.appendChild(head);

    if (state.section === 'profile') {
      main.appendChild(renderProfileEditor());
      return main;
    }

    var entries = state.doc[state.section] || [];
    if (!entries.length) {
      main.appendChild(renderEmptyState(state.section));
      return main;
    }
    /* Year-grouped, newest year first (mirrors the export); inside a group
     * the CANONICAL ARRAY ORDER is shown — that's what ▲/▼ and drag edit. */
    var groups = groupEntriesByYear(entries, (CV_DISPLAY[state.section] || {}).year);
    groups.forEach(function (grp) {
      var head = document.createElement('div');
      head.className = 'cve-yr-head';
      head.textContent = grp.label;
      main.appendChild(head);
      grp.entries.forEach(function (entry, gi) {
        main.appendChild(renderEntry(entry, grp.entries, gi));
      });
    });
    return main;
  }

  /* Same bucketing the export uses: 4-digit year match on the section's
   * sort field, newest first, "Undated" last, array order inside a group. */
  function groupEntriesByYear(entries, yearKey) {
    if (!yearKey) return [{ label: 'All entries', entries: entries.slice() }];
    var buckets = {};
    entries.forEach(function (e) {
      var m = String(e[yearKey] == null ? '' : e[yearKey]).match(/(\d{4})/);
      var y = m ? m[1] : '';
      (buckets[y] = buckets[y] || []).push(e);
    });
    var years = Object.keys(buckets).filter(function (y) { return y !== ''; });
    years.sort(function (a, b) { return b.localeCompare(a); });
    var out = years.map(function (y) { return { label: y, entries: buckets[y] }; });
    if (buckets['']) out.push({ label: 'Undated', entries: buckets[''] });
    return out;
  }

  /* ── reorder (V3.355) — operate on the canonical array by _id ── */

  async function moveEntryRelative(movedId, refId, after) {
    var list = state.doc[state.section] || [];
    var from = list.findIndex(function (e) { return e._id === movedId; });
    if (from < 0) return;
    var item = list.splice(from, 1)[0];
    var to = list.findIndex(function (e) { return e._id === refId; });
    if (to < 0) { list.splice(from, 0, item); return; }
    list.splice(after ? to + 1 : to, 0, item);
    render();
    try { await saveSection(state.section); } catch (e) { render(); }
  }

  var _drag = null; // { id, section }

  function renderEntry(entry, groupEntries, gi) {
    var disp = CV_DISPLAY[state.section] || { title: 'title', meta: [], year: null };
    var card = document.createElement('div');
    card.className = 'cve-entry';
    card.addEventListener('click', function (ev) {
      if (ev.target.closest('.del') || ev.target.closest('.cve-move')) return;
      openModal(state.section, entry);
    });
    var actions = document.createElement('div');
    actions.className = 'actions';
    var prev = gi > 0 ? groupEntries[gi - 1] : null;
    var next = gi < groupEntries.length - 1 ? groupEntries[gi + 1] : null;
    if (prev || next) {
      var up = document.createElement('button');
      up.className = 'cve-move';
      ICON.label(up, 'chevron-up');
      up.title = 'Move up within ' + (disp.year ? 'this year' : 'the list');
      up.disabled = !prev;
      up.addEventListener('click', function (ev) {
        ev.stopPropagation();
        if (prev) moveEntryRelative(entry._id, prev._id, false);
      });
      actions.appendChild(up);
      var down = document.createElement('button');
      down.className = 'cve-move';
      ICON.label(down, 'chevron-down');
      down.title = 'Move down within ' + (disp.year ? 'this year' : 'the list');
      down.disabled = !next;
      down.addEventListener('click', function (ev) {
        ev.stopPropagation();
        if (next) moveEntryRelative(entry._id, next._id, true);
      });
      actions.appendChild(down);
    }
    var yearVal = disp.year ? String(entry[disp.year] || '').slice(0, 4) : '';
    if (yearVal) {
      var y = document.createElement('span');
      y.className = 'y';
      y.textContent = yearVal;
      actions.appendChild(y);
    }
    var del = document.createElement('span');
    del.className = 'del';
    del.textContent = 'delete';
    var sectionKey = state.section;
    del.addEventListener('click', function (ev) {
      ev.stopPropagation();
      deleteEntry(sectionKey, entry);
    });
    actions.appendChild(del);
    card.appendChild(actions);

    /* Drag to reorder within the same year group (desktop; ▲/▼ covers touch). */
    if (groupEntries.length > 1) {
      card.draggable = true;
      var groupIds = groupEntries.map(function (e) { return e._id; });
      card.addEventListener('dragstart', function (ev) {
        _drag = { id: entry._id, section: state.section, groupIds: groupIds };
        card.classList.add('dragging');
        try { ev.dataTransfer.setData('text/plain', entry._id); ev.dataTransfer.effectAllowed = 'move'; } catch (e) {}
      });
      card.addEventListener('dragend', function () {
        _drag = null;
        card.classList.remove('dragging');
      });
      card.addEventListener('dragover', function (ev) {
        if (!_drag || _drag.section !== state.section) return;
        if (_drag.id === entry._id || _drag.groupIds.indexOf(entry._id) < 0) return;
        ev.preventDefault();
        ev.dataTransfer.dropEffect = 'move';
        card.classList.add('dragover');
      });
      card.addEventListener('dragleave', function () { card.classList.remove('dragover'); });
      card.addEventListener('drop', function (ev) {
        card.classList.remove('dragover');
        if (!_drag || _drag.id === entry._id || _drag.groupIds.indexOf(entry._id) < 0) return;
        ev.preventDefault();
        var rect = card.getBoundingClientRect();
        var after = (ev.clientY - rect.top) > rect.height / 2;
        moveEntryRelative(_drag.id, entry._id, after);
        _drag = null;
      });
    }

    var title = document.createElement('div');
    title.className = 't';
    title.textContent = cvCleanText(entry[disp.title]) || '(untitled)';
    card.appendChild(title);
    var metaParts = disp.meta.map(function (k) { return cvCleanText(entry[k]); }).filter(Boolean);
    if (metaParts.length) {
      var meta = document.createElement('div');
      meta.className = 'm';
      meta.textContent = metaParts.join(' · ');
      card.appendChild(meta);
    }
    return card;
  }

  /* Guided empty state (V3.357) — example line + the right import CTAs. */
  function renderEmptyState(sectionKey) {
    if (typeof CV_ONBOARDING !== 'undefined') {
      return CV_ONBOARDING.emptyStateFor(sectionKey, onboardingCtx());
    }
    var empty = document.createElement('div');
    empty.className = 'cve-empty';
    empty.textContent = 'No entries yet. Click "Add entry" to create one.';
    return empty;
  }

  /* ── onboarding glue (V3.357) ── */

  function onboardingCtx() {
    return {
      doc: state.doc,
      actions: {
        goSection: function (k) { state.section = k; render(); },
        addEntry: function () { openModal(state.section, null); },
        pull: openLibraryPull,
        orcid: openORCIDDialog,
        bibtex: openBibTeXDialog,
        preview: function () { if (!state.previewOn) togglePreview(); },
      },
      setDismissed: function (flag) {
        state.doc.cv_meta = state.doc.cv_meta || {};
        state.doc.cv_meta.onboarding_dismissed = !!flag;
        render();
        savePayload({ cv_meta: state.doc.cv_meta }).catch(function () {});
      },
    };
  }

  /* Completes the "Preview & export" onboarding step — stamped on any
   * download/print, persisted fire-and-forget. */
  function markExported() {
    state.doc.cv_meta = state.doc.cv_meta || {};
    var first = !state.doc.cv_meta.last_export_at;
    state.doc.cv_meta.last_export_at = new Date().toISOString();
    savePayload({ cv_meta: state.doc.cv_meta }).catch(function () {});
    if (first) render(); // first export completes the checklist step
  }

  /* ── modal form ── */

  function openModal(sectionKey, entry) {
    state.section = sectionKey;
    state.editing = entry;
    var schema = CV_SCHEMAS[sectionKey];
    if (!schema) return;
    modalTitle.textContent = (entry ? 'Edit ' : 'Add ') + CV_SECTION_LABELS[sectionKey];
    modalBody.innerHTML = '';
    var form = document.createElement('div');
    form.className = 'cve-form';
    schema.fields.forEach(function (f) {
      var label = document.createElement('label');
      if (f.span === 2) label.className = 'span-2';
      var labelText = f.label + (f.required ? ' <span class="req">*</span>' : '');
      var input = buildInput(f, entry ? entry[f.key] : undefined);
      label.innerHTML = '<span>' + labelText + '</span>';
      label.appendChild(input);
      if (f.hint) {
        var h = document.createElement('div');
        h.className = 'hint';
        h.textContent = f.hint;
        label.appendChild(h);
      }
      form.appendChild(label);
    });
    modalBody.appendChild(form);
    attachDOIFetch(modalBody, sectionKey);
    if (window.__cveModalGuard) window.__cveModalGuard.reset();
    modal.classList.add('open');
  }

  function buildInput(field, value) {
    var el;
    // Clean HTML/LaTeX/Markdown artifacts from text-ish fields on form open,
    // so the user sees a clean value and saving an untouched entry scrubs
    // legacy markup in-place. Numbers/dates/checkboxes are passed through.
    var cleanValue = (field.type === 'number' || field.type === 'date' || field.type === 'checkbox')
      ? value : (value == null ? '' : cvCleanText(value));
    if (field.type === 'textarea') {
      el = document.createElement('textarea');
      el.value = cleanValue || '';
    } else if (field.type === 'select') {
      el = document.createElement('select');
      (field.options || []).forEach(function (opt) {
        var o = document.createElement('option');
        o.value = opt;
        o.textContent = opt || '(none)';
        if ((cleanValue || '') === opt) o.selected = true;
        el.appendChild(o);
      });
    } else if (field.type === 'checkbox') {
      el = document.createElement('input');
      el.type = 'checkbox';
      el.checked = !!cleanValue;
      el.style.width = 'auto';
    } else {
      el = document.createElement('input');
      el.type = field.type === 'number' ? 'number' : (field.type === 'date' ? 'date' : 'text');
      if (cleanValue !== undefined && cleanValue !== null && cleanValue !== '') el.value = cleanValue;
    }
    el.dataset.fieldKey = field.key;
    el.dataset.fieldType = field.type;
    return el;
  }

  function readForm() {
    var out = {};
    modalBody.querySelectorAll('[data-field-key]').forEach(function (el) {
      var key = el.dataset.fieldKey;
      var type = el.dataset.fieldType;
      if (type === 'checkbox') out[key] = !!el.checked;
      else if (type === 'number') out[key] = el.value === '' ? '' : Number(el.value);
      else out[key] = el.value;
    });
    return out;
  }

  function validateForm(sectionKey, values) {
    var schema = CV_SCHEMAS[sectionKey];
    for (var i = 0; i < schema.fields.length; i++) {
      var f = schema.fields[i];
      if (f.required && (values[f.key] === '' || values[f.key] === null || values[f.key] === undefined)) {
        return f.label + ' is required.';
      }
    }
    return null;
  }

  document.getElementById('cve-cancel').addEventListener('click', function () {
    modal.classList.remove('open');
    state.editing = null;
    if (window.__cveModalGuard) window.__cveModalGuard.reset();
    flushRemoteQueued();
  });

  document.getElementById('cve-save').addEventListener('click', async function () {
    var sectionKey = state.section;
    var values = readForm();
    var err = validateForm(sectionKey, values);
    if (err) { alert(err); return; }
    var list = state.doc[sectionKey] = state.doc[sectionKey] || [];
    if (state.editing) {
      values._id = state.editing._id;
      var idx = list.findIndex(function (e) { return e._id === state.editing._id; });
      if (idx >= 0) list[idx] = values;
      else list.push(values);
    } else {
      values._id = cvUid();
      list.push(values);
    }
    try {
      await saveSection(sectionKey);
      modal.classList.remove('open');
      state.editing = null;
      render();
    } catch (e) { /* status + toast set in savePayload */ }
  });

  /* Close modal on backdrop click — guarded so drag-selects and accidental
   * clicks don't wipe the draft. `modalBody` is re-rendered each time the
   * modal opens, so we scope the dirty tracker to the modal panel itself. */
  var modalGuard = safeCloseOnBackdrop(modal, modal.querySelector('.cve-modal'), function () {
    modal.classList.remove('open');
    state.editing = null;
    flushRemoteQueued();
  });
  /* The entry modal is persistent (one element re-opened many times). Reset
   * the dirty tracker whenever we open it or close it via Cancel/Save so
   * stale state doesn't trigger a false "Discard?" on the next open. */
  window.__cveModalGuard = modalGuard;

  /* ── profile editor ── */

  function renderProfileEditor() {
    var wrap = document.createElement('div');
    wrap.className = 'cve-profile-grid';
    state.doc.profile = state.doc.profile || {};
    CV_PROFILE_FIELDS.forEach(function (f) {
      var label = document.createElement('label');
      label.style.cssText = 'display:flex;flex-direction:column;font-size:11px;color:#6b7280;text-transform:uppercase;letter-spacing:.4px;gap:3px';
      if (f.type === 'textarea') label.style.gridColumn = '1/-1';
      label.innerHTML = '<span>' + f.label + '</span>';
      var input;
      if (f.type === 'textarea') {
        input = document.createElement('textarea');
        input.style.cssText = 'min-height:70px;padding:6px 8px;border:1px solid #d1d5db;border-radius:6px;font-family:inherit;font-size:13px;color:#111827;text-transform:none;letter-spacing:normal;resize:vertical';
      } else {
        input = document.createElement('input');
        input.type = 'text';
        input.style.cssText = 'padding:6px 8px;border:1px solid #d1d5db;border-radius:6px;font-size:13px;text-transform:none;letter-spacing:normal';
      }
      input.value = state.doc.profile[f.key] || '';
      input.dataset.profileKey = f.key;
      label.appendChild(input);
      if (f.hint) {
        var h = document.createElement('div');
        h.style.cssText = 'font-size:10px;color:#9ca3af;text-transform:none;letter-spacing:0;margin-top:2px';
        h.textContent = f.hint;
        label.appendChild(h);
      }
      wrap.appendChild(label);
    });
    var btnRow = document.createElement('div');
    btnRow.style.cssText = 'grid-column:1/-1;display:flex;gap:8px;margin-top:8px';
    var saveBtn = document.createElement('button');
    saveBtn.className = 'btn btn-primary';
    saveBtn.textContent = 'Save profile';
    saveBtn.addEventListener('click', async function () {
      var profile = {};
      wrap.querySelectorAll('[data-profile-key]').forEach(function (el) {
        profile[el.dataset.profileKey] = el.value;
      });
      state.doc.profile = profile;
      try {
        await savePayload({ profile: profile });
        setStatus('Profile saved.', 'ok');
        flushRemoteQueued();
      } catch (err) { /* handled in savePayload */ }
    });
    btnRow.appendChild(saveBtn);
    wrap.appendChild(btnRow);
    return wrap;
  }

  /* ── audience variants (V3.355) ──
   * Shares the parent cv-builder's cv_versions[] contract so variants
   * created here appear in the public-site app's Versions tab and
   * vice-versa: { _id, name, created, hiddenSections[], hiddenEntries{} }. */

  async function saveVariants() {
    try { await savePayload({ cv_versions: state.doc.cv_versions }); } catch (e) {}
  }

  function openVariantsDialog() {
    var dlg = openDialog('Audience variants',
      '<p style="margin:0 0 10px 0;font-size:13px;color:#374151">A variant is a tailored cut of your CV — untick sections or single entries to hide them from that variant\'s preview and exports. Your data is never deleted.</p>' +
      '<div style="display:flex;gap:8px;margin-bottom:10px;flex-wrap:wrap">' +
        '<select id="cve-var-sel" style="flex:1;min-width:160px;font-size:13px;padding:6px 8px;border:1px solid #d1d5db;border-radius:6px"></select>' +
        '<input type="text" id="cve-var-name" placeholder="e.g. Fellowship application" style="flex:2;min-width:180px;padding:6px 8px;border:1px solid #d1d5db;border-radius:6px;font-size:13px">' +
        '<button class="btn btn-primary" id="cve-var-create">+ Create</button>' +
        '<button class="btn" id="cve-var-delete" style="border-color:#dc2626;color:#dc2626">Delete</button>' +
      '</div>' +
      '<div id="cve-var-detail"></div>' +
      '<div style="display:flex;justify-content:flex-end;margin-top:12px;padding-top:10px;border-top:1px solid #f1f5f9">' +
        '<button class="btn" id="cve-var-close">Close</button>' +
      '</div>');
    var sel = dlg.panel.querySelector('#cve-var-sel');
    var detail = dlg.panel.querySelector('#cve-var-detail');

    function fillSelect() {
      sel.innerHTML = '';
      var variants = state.doc.cv_versions || [];
      if (!variants.length) {
        var o = document.createElement('option');
        o.value = '';
        o.textContent = 'No variants yet';
        sel.appendChild(o);
      }
      variants.forEach(function (v) {
        var o = document.createElement('option');
        o.value = v._id;
        o.textContent = v.name || '(unnamed)';
        if (v._id === state.variantId) o.selected = true;
        sel.appendChild(o);
      });
    }

    function currentVariant() {
      return (state.doc.cv_versions || []).find(function (v) { return v._id === sel.value; }) || null;
    }

    function renderDetail() {
      var v = currentVariant();
      if (!v) { detail.innerHTML = '<div style="padding:16px;text-align:center;color:#6b7280;font-size:13px">Create a variant to start curating.</div>'; return; }
      var html = '<div style="max-height:360px;overflow:auto;border:1px solid #e5e7eb;border-radius:6px">';
      CV_SECTION_KEYS.forEach(function (k) {
        var entries = state.doc[k] || [];
        var secHidden = (v.hiddenSections || []).indexOf(k) >= 0;
        var hiddenE = (v.hiddenEntries || {})[k] || [];
        html += '<div style="border-bottom:1px solid #f1f5f9">' +
          '<label style="display:flex;gap:8px;align-items:center;padding:8px 10px;cursor:pointer;background:' + (secHidden ? '#f9fafb' : '#fff') + '">' +
            '<input type="checkbox" data-var-sec="' + k + '" ' + (secHidden ? '' : 'checked') + '>' +
            '<span style="flex:1;font-size:13px;color:' + (secHidden ? '#9ca3af' : '#111827') + '">' + CV_SECTION_LABELS[k] + '</span>' +
            '<span style="font-size:11px;color:#9ca3af">' + (entries.length - (secHidden ? entries.length : hiddenE.length)) + '/' + entries.length + '</span>' +
          '</label>';
        if (!secHidden && entries.length) {
          html += '<div style="padding:0 10px 6px 30px">';
          entries.forEach(function (e) {
            var disp = CV_DISPLAY[k] || { title: 'title' };
            var t = cvCleanText(e[disp.title] || e.title || e.name || e.role) || '(untitled)';
            var ih = hiddenE.indexOf(e._id) >= 0;
            html += '<label style="display:flex;gap:7px;align-items:center;padding:3px 0;cursor:pointer">' +
              '<input type="checkbox" data-var-entry="' + k + ':' + escAttr(e._id) + '" ' + (ih ? '' : 'checked') + '>' +
              '<span style="font-size:12px;color:' + (ih ? '#9ca3af' : '#374151') + ';overflow:hidden;text-overflow:ellipsis;white-space:nowrap">' + escHtml(t) + '</span>' +
            '</label>';
          });
          html += '</div>';
        }
        html += '</div>';
      });
      html += '</div>';
      detail.innerHTML = html;

      detail.querySelectorAll('[data-var-sec]').forEach(function (cb) {
        cb.addEventListener('change', function () {
          var k = cb.dataset.varSec;
          var hs = (v.hiddenSections = v.hiddenSections || []);
          var idx = hs.indexOf(k);
          if (cb.checked) { if (idx >= 0) hs.splice(idx, 1); }
          else if (idx < 0) hs.push(k);
          saveVariants();
          renderDetail();
          refreshPreview();
        });
      });
      detail.querySelectorAll('[data-var-entry]').forEach(function (cb) {
        cb.addEventListener('change', function () {
          var parts = cb.dataset.varEntry.split(':');
          var k = parts[0], eid = parts[1];
          v.hiddenEntries = v.hiddenEntries || {};
          var arr = (v.hiddenEntries[k] = v.hiddenEntries[k] || []);
          var idx = arr.indexOf(eid);
          if (cb.checked) { if (idx >= 0) arr.splice(idx, 1); }
          else if (idx < 0) arr.push(eid);
          saveVariants();
          renderDetail();
          refreshPreview();
        });
      });
    }

    dlg.panel.querySelector('#cve-var-create').addEventListener('click', function () {
      var name = dlg.panel.querySelector('#cve-var-name').value.trim();
      if (!name) { dlg.panel.querySelector('#cve-var-name').focus(); return; }
      var v = { _id: cvUid(), name: name, created: new Date().toISOString(), hiddenSections: [], hiddenEntries: {} };
      state.doc.cv_versions = (state.doc.cv_versions || []).concat([v]);
      state.variantId = v._id;
      localStorage.setItem('cve-variant', state.variantId);
      dlg.panel.querySelector('#cve-var-name').value = '';
      saveVariants();
      fillSelect();
      renderDetail();
    });
    dlg.panel.querySelector('#cve-var-delete').addEventListener('click', function () {
      var v = currentVariant();
      if (!v) return;
      if (!confirm('Delete variant "' + (v.name || '') + '"? (No CV entries are deleted.)')) return;
      state.doc.cv_versions = (state.doc.cv_versions || []).filter(function (x) { return x._id !== v._id; });
      if (state.variantId === v._id) { state.variantId = ''; localStorage.setItem('cve-variant', ''); }
      saveVariants();
      fillSelect();
      renderDetail();
    });
    sel.addEventListener('change', function () {
      state.variantId = sel.value;
      localStorage.setItem('cve-variant', state.variantId);
      renderDetail();
      refreshPreview();
    });
    dlg.panel.querySelector('#cve-var-close').addEventListener('click', function () {
      dlg.close();
      render(); // toolbar select + preview reflect dialog changes
    });

    fillSelect();
    renderDetail();
  }

  /* ── bulk dialogs ── */

  /* Reusable modal helper — returns a back element that can be removed. */
  function openDialog(title, bodyHTML) {
    var back = document.createElement('div');
    back.style.cssText = 'position:fixed;inset:0;background:rgba(0,0,0,.45);z-index:200;display:flex;align-items:flex-start;justify-content:center;padding:30px 12px;overflow-y:auto';
    var panel = document.createElement('div');
    panel.className = 'cve-dialog-panel';
    panel.style.cssText = 'background:#fff;border-radius:10px;max-width:820px;width:100%;padding:18px 20px;box-shadow:0 20px 40px rgba(0,0,0,.25)';
    panel.innerHTML = '<h3 style="margin:0 0 12px 0;font-size:15px">' + title + '</h3>' + bodyHTML;
    back.appendChild(panel);
    document.body.appendChild(back);
    var handle = { back: back, panel: panel, close: function () { if (back.parentNode) document.body.removeChild(back); } };
    safeCloseOnBackdrop(back, panel, handle.close);
    return handle;
  }

  function notSignedIn() {
    if (typeof TOAST !== 'undefined') TOAST.warn('Not signed in', { detail: 'Sign in from Settings to use this.' });
    else alert('Not signed in.');
  }

  /* Pull my publications from the lab library (V3.356). */
  function openLibraryPull() {
    if (!firebridge.isReady()) { notSignedIn(); return; }
    var profile = firebridge.getProfile();
    var name = (state.doc.profile && state.doc.profile.name) || (profile && profile.name) || '';
    CV_LIBRARY_PULL.open({
      getDoc: function () { return state.doc; },
      save: savePayload,
      profileName: name,
      onDone: render,
    });
  }

  function openORCIDDialog() {
    if (!firebridge.isReady()) { notSignedIn(); return; }
    var existingOrcid = (state.doc.profile && state.doc.profile.orcid) || '';
    var dlg = openDialog('ORCID Sync',
      '<p style="margin:0 0 10px 0;font-size:13px;color:#374151">Paste your ORCID iD and fetch your works. New items are appended to Journals or Conferences; duplicates are skipped.</p>' +
      '<div style="display:flex;gap:8px;margin-bottom:10px">' +
        '<input type="text" id="cve-orcid-id" placeholder="0000-0000-0000-0000" value="' + escAttr(existingOrcid) + '" style="flex:1;padding:6px 8px;border:1px solid #d1d5db;border-radius:6px;font-size:13px">' +
        '<button class="btn btn-primary" id="cve-orcid-fetch">Fetch works</button>' +
      '</div>' +
      '<div id="cve-orcid-status" style="font-size:12px;color:#6b7280;margin-bottom:8px"></div>' +
      '<div id="cve-orcid-results"></div>' +
      '<div style="display:flex;gap:8px;justify-content:flex-end;margin-top:12px;padding-top:10px;border-top:1px solid #f1f5f9">' +
        '<button class="btn" id="cve-orcid-close">Close</button>' +
      '</div>');
    dlg.panel.querySelector('#cve-orcid-close').addEventListener('click', dlg.close);
    var statusDiv = dlg.panel.querySelector('#cve-orcid-status');
    var resultsDiv = dlg.panel.querySelector('#cve-orcid-results');
    dlg.panel.querySelector('#cve-orcid-fetch').addEventListener('click', async function () {
      var id = dlg.panel.querySelector('#cve-orcid-id').value.trim();
      statusDiv.textContent = 'Fetching…';
      resultsDiv.innerHTML = '';
      try {
        var works = await CVImport.fetchORCID(id);
        // Match each work against existing doc for dedupe
        var rows = works.map(function (w) {
          var section = CVImport.orcidSectionFor(w);
          var probe = { title: w.title, doi: w.doi };
          var dupes = CVImport.findDuplicates(probe, state.doc);
          return { work: w, section: section, isDupe: dupes.length > 0 };
        });
        if (!rows.length) { statusDiv.textContent = 'No works found for this ORCID iD.'; return; }
        var html = '<div style="font-size:12px;color:#374151;margin-bottom:6px">' + rows.length + ' works — unchecked rows look like duplicates and will be skipped.</div>' +
          '<div style="max-height:340px;overflow:auto;border:1px solid #e5e7eb;border-radius:6px">';
        rows.forEach(function (r, i) {
          html += '<div style="display:flex;gap:8px;padding:8px 10px;border-bottom:1px solid #f1f5f9;align-items:flex-start">' +
            '<input type="checkbox" data-orcid-idx="' + i + '" ' + (r.isDupe ? '' : 'checked') + ' style="margin-top:3px">' +
            '<div style="flex:1;min-width:0">' +
              '<div style="font-size:13px;color:#111827">' + escHtml(r.work.title || '(untitled)') + (r.isDupe ? ' <span style="color:#dc2626;font-size:11px">[duplicate]</span>' : '') + '</div>' +
              '<div style="font-size:11px;color:#6b7280">' + escHtml([r.work.journal, r.work.year, r.section].filter(Boolean).join(' · ')) + '</div>' +
            '</div>' +
          '</div>';
        });
        html += '</div>' +
          '<div style="margin-top:10px;display:flex;gap:8px">' +
            '<button class="btn btn-primary" id="cve-orcid-import">Import selected</button>' +
            '<span id="cve-orcid-save-orcid" style="font-size:12px;color:#6b7280;align-self:center"></span>' +
          '</div>';
        resultsDiv.innerHTML = html;
        statusDiv.textContent = '';
        // Persist ORCID in profile if it wasn't set
        if (!existingOrcid) {
          state.doc.profile = state.doc.profile || {};
          state.doc.profile.orcid = id;
          try { await savePayload({ profile: state.doc.profile }); } catch (e) {}
        }
        resultsDiv.querySelector('#cve-orcid-import').addEventListener('click', async function () {
          var toAdd = { journals: [], conferences: [] };
          resultsDiv.querySelectorAll('[data-orcid-idx]').forEach(function (cb) {
            if (!cb.checked) return;
            var r = rows[Number(cb.dataset.orcidIdx)];
            var w = r.work;
            var entry = {
              _id: cvUid(),
              title: w.title || '',
              year: w.year || '',
              doi: w.doi || '',
              authors: '',
              status: 'Published',
            };
            if (r.section === 'conferences') entry.conference = w.journal || '';
            else entry.journal = w.journal || '';
            toAdd[r.section].push(entry);
          });
          var total = toAdd.journals.length + toAdd.conferences.length;
          if (!total) { statusDiv.textContent = 'Nothing selected.'; return; }
          /* ORCID works come back without authors/volume/pages — enrich
           * each selected entry from its DOI (batched CrossRef, V3.356)
           * so students don't hand-fill what CrossRef already knows. */
          var withDoi = toAdd.journals.concat(toAdd.conferences).filter(function (e) { return e.doi; });
          if (withDoi.length) {
            statusDiv.textContent = 'Filling details from CrossRef 0/' + withDoi.length + '…';
            await CVImport.runBatched(withDoi, function (e) {
              return CVImport.enrichEntryFromDOI(e);
            }, function (done, tot) {
              statusDiv.textContent = 'Filling details from CrossRef ' + done + '/' + tot + '…';
            });
          }
          statusDiv.textContent = 'Saving ' + total + ' entries…';
          var payload = {};
          if (toAdd.journals.length) {
            state.doc.journals = (state.doc.journals || []).concat(toAdd.journals);
            payload.journals = state.doc.journals;
          }
          if (toAdd.conferences.length) {
            state.doc.conferences = (state.doc.conferences || []).concat(toAdd.conferences);
            payload.conferences = state.doc.conferences;
          }
          try {
            await savePayload(payload);
            setStatus('Imported ' + total + ' from ORCID.', 'ok');
            dlg.close();
            render();
          } catch (err) {
            statusDiv.textContent = 'Save failed: ' + err.message;
          }
        });
      } catch (err) {
        statusDiv.textContent = 'Fetch failed: ' + err.message;
      }
    });
  }

  function openBibTeXDialog() {
    if (!firebridge.isReady()) { notSignedIn(); return; }
    var dlg = openDialog('Import BibTeX',
      '<p style="margin:0 0 10px 0;font-size:13px;color:#374151">Paste BibTeX entries. Each entry is classified by type; duplicates against the existing CV are flagged.</p>' +
      '<textarea id="cve-bib-text" style="width:100%;min-height:200px;padding:8px;border:1px solid #d1d5db;border-radius:6px;font-family:ui-monospace,SFMono-Regular,Menlo,monospace;font-size:12px" placeholder="@article{...}"></textarea>' +
      '<div style="display:flex;gap:8px;margin-top:10px">' +
        '<button class="btn btn-primary" id="cve-bib-parse">Parse</button>' +
        '<button class="btn" id="cve-bib-close">Close</button>' +
        '<span id="cve-bib-status" style="font-size:12px;color:#6b7280;align-self:center"></span>' +
      '</div>' +
      '<div id="cve-bib-results" style="margin-top:12px"></div>');
    dlg.panel.querySelector('#cve-bib-close').addEventListener('click', dlg.close);
    var statusDiv = dlg.panel.querySelector('#cve-bib-status');
    var resultsDiv = dlg.panel.querySelector('#cve-bib-results');
    dlg.panel.querySelector('#cve-bib-parse').addEventListener('click', function () {
      var raw = dlg.panel.querySelector('#cve-bib-text').value;
      var entries = CVImport.parseBibtex(raw);
      if (!entries.length) { statusDiv.textContent = 'No entries parsed.'; resultsDiv.innerHTML = ''; return; }
      var rows = entries.map(function (e) {
        var dupes = CVImport.findDuplicates(e, state.doc);
        return { entry: e, isDupe: dupes.length > 0 };
      });
      statusDiv.textContent = entries.length + ' parsed';
      var html = '<div style="max-height:280px;overflow:auto;border:1px solid #e5e7eb;border-radius:6px">';
      rows.forEach(function (r, i) {
        html += '<div style="display:flex;gap:8px;padding:8px 10px;border-bottom:1px solid #f1f5f9;align-items:flex-start">' +
          '<input type="checkbox" data-bib-idx="' + i + '" ' + (r.isDupe ? '' : 'checked') + ' style="margin-top:3px">' +
          '<div style="flex:1;min-width:0">' +
            '<div style="font-size:13px;color:#111827">' + escHtml(r.entry.title || r.entry.name || r.entry.role || '(no title)') + (r.isDupe ? ' <span style="color:#dc2626;font-size:11px">[duplicate]</span>' : '') + '</div>' +
            '<div style="font-size:11px;color:#6b7280">' + escHtml([r.entry.section, r.entry.year, r.entry.journal || r.entry.conference || r.entry.publisher].filter(Boolean).join(' · ')) + '</div>' +
          '</div>' +
        '</div>';
      });
      html += '</div><div style="margin-top:10px"><button class="btn btn-primary" id="cve-bib-import">Import selected</button></div>';
      resultsDiv.innerHTML = html;
      resultsDiv.querySelector('#cve-bib-import').addEventListener('click', async function () {
        var bySec = {};
        resultsDiv.querySelectorAll('[data-bib-idx]').forEach(function (cb) {
          if (!cb.checked) return;
          var r = rows[Number(cb.dataset.bibIdx)];
          var sec = r.entry.section;
          var clean = Object.assign({}, r.entry);
          delete clean.section;
          (bySec[sec] = bySec[sec] || []).push(clean);
        });
        var total = Object.keys(bySec).reduce(function (s, k) { return s + bySec[k].length; }, 0);
        if (!total) { statusDiv.textContent = 'Nothing selected.'; return; }
        var payload = {};
        Object.keys(bySec).forEach(function (sec) {
          state.doc[sec] = (state.doc[sec] || []).concat(bySec[sec]);
          payload[sec] = state.doc[sec];
        });
        try {
          await savePayload(payload);
          setStatus('Imported ' + total + ' from BibTeX.', 'ok');
          dlg.close();
          render();
        } catch (err) {
          statusDiv.textContent = 'Save failed: ' + err.message;
        }
      });
    });
  }

  async function runCitationRefresh() {
    if (!firebridge.isReady()) { notSignedIn(); return; }
    var papers = [].concat(state.doc.journals || [], state.doc.conferences || []).filter(function (e) { return e.doi; });
    if (!papers.length) {
      if (typeof TOAST !== 'undefined') TOAST.warn('No entries with DOI — nothing to refresh.');
      else alert('No entries with DOI — nothing to refresh.');
      return;
    }
    if (!confirm('Refresh citation counts for ' + papers.length + ' entries? (CrossRef, a few at a time)')) return;
    setStatus('Refreshing 0/' + papers.length + '…');
    /* Batched worker pool (V3.356) — was a strictly-sequential 350ms/DOI
     * loop; 4 polite lanes make big publication lists tolerable. */
    var counts = await CVImport.fetchCitationCountsBatched(
      papers.map(function (p) { return p.doi; }),
      function (done, total) { setStatus('Refreshing ' + done + '/' + total + '…'); }
    );
    var updated = 0;
    papers.forEach(function (p, i) {
      var count = counts[i];
      if (count != null && count !== (Number(p.citations) || 0)) {
        p.citations = count;
        updated++;
      }
    });
    try {
      await savePayload({
        journals: state.doc.journals,
        conferences: state.doc.conferences,
      });
      setStatus(updated ? ('Updated ' + updated + ' citation counts.') : 'All counts current.', 'ok');
      render();
    } catch (err) { /* handled in savePayload */ }
  }

  /* ── DOI fetch inside entry form ── */

  function attachDOIFetch(formHost, sectionKey) {
    if (!/journals|conferences|books/.test(sectionKey)) return;
    var doiInput = formHost.querySelector('[data-field-key="doi"]');
    if (!doiInput) return;
    var wrap = doiInput.parentElement;
    var btn = document.createElement('button');
    btn.type = 'button';
    btn.className = 'btn';
    btn.textContent = 'Fetch from DOI';
    btn.style.cssText = 'margin-top:4px;padding:4px 10px;font-size:12px;align-self:flex-start';
    btn.addEventListener('click', async function () {
      var doi = doiInput.value.trim();
      if (!doi) { alert('Paste a DOI first.'); return; }
      btn.disabled = true; btn.textContent = 'Fetching…';
      try {
        var r = await CVImport.fetchDOI(doi);
        // Apply to matching fields
        var map = {
          journals:    { title:'title', authors:'authors', journal:'journal', year:'year', volume:'volume', issue:'issue', pages:'pages', abstract:'abstract', citations:'citations', doi:'doi' },
          conferences: { title:'title', authors:'authors', conference:'journal', year:'year', pages:'pages', abstract:'abstract', doi:'doi' },
          books:       { title:'title', authors:'authors', year:'year', doi:'doi' },
        };
        var fieldMap = map[sectionKey] || {};
        Object.keys(fieldMap).forEach(function (targetKey) {
          var src = r[fieldMap[targetKey]];
          if (src == null || src === '') return;
          var el = formHost.querySelector('[data-field-key="' + targetKey + '"]');
          if (el && el.value === '') el.value = src;
        });
        btn.textContent = 'Applied ✓';
        setTimeout(function () { btn.textContent = 'Fetch from DOI'; btn.disabled = false; }, 1200);
      } catch (err) {
        alert('DOI fetch failed: ' + err.message);
        btn.textContent = 'Fetch from DOI'; btn.disabled = false;
      }
    });
    wrap.appendChild(btn);
  }

  /* ── html helpers ── */

  function escHtml(s) {
    return String(s == null ? '' : s).replace(/[&<>"']/g, function (c) {
      return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c];
    });
  }
  function escAttr(s) { return escHtml(s); }

  /* ── keyboard shortcuts (V3.358) ──
   * n = new entry · [ / ] = previous / next section · p = preview ·
   * Esc = close the entry modal · ? = show this list. Suppressed while
   * typing in any form control. */
  var SECTION_CYCLE = CV_SECTION_GROUPS.reduce(function (acc, g) { return acc.concat(g.keys); }, []);
  document.addEventListener('keydown', function (e) {
    if (!state.doc) return;
    if (e.key === 'Escape') {
      if (modal.classList.contains('open')) document.getElementById('cve-cancel').click();
      return;
    }
    if (e.metaKey || e.ctrlKey || e.altKey) return;
    var t = e.target;
    if (t && (/^(INPUT|TEXTAREA|SELECT)$/.test(t.tagName) || t.isContentEditable)) return;
    if (modal.classList.contains('open')) return;
    if (e.key === 'n') {
      if (state.section !== 'profile') { e.preventDefault(); openModal(state.section, null); }
    } else if (e.key === '[' || e.key === ']') {
      e.preventDefault();
      var i = SECTION_CYCLE.indexOf(state.section);
      var d = e.key === ']' ? 1 : -1;
      state.section = SECTION_CYCLE[(i + d + SECTION_CYCLE.length) % SECTION_CYCLE.length];
      render();
    } else if (e.key === 'p') {
      e.preventDefault();
      togglePreview();
    } else if (e.key === '?') {
      if (typeof TOAST !== 'undefined') {
        TOAST.info('Keyboard shortcuts', { detail: 'n — new entry · [ ] — switch section · p — preview · Esc — close form', ttl: 6000 });
      }
    }
  });

  /* ── boot ── */
  if (typeof firebridge !== 'undefined') {
    if (firebridge.requireSignIn) firebridge.requireSignIn('Sign in to edit your CV.');
    firebridge.onAuth(function (user) {
      if (user && firebridge.isReady()) subscribeDoc();
      else {
        if (state.unsub) { try { state.unsub(); } catch (e) {} state.unsub = null; }
        showNotConnected();
      }
    });
  } else {
    document.addEventListener('DOMContentLoaded', showNotConnected);
  }
})();
