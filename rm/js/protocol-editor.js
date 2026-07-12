/* protocol-editor.js — editor controller for the Protocols Builder (V3.113).
 *
 * Lifecycle:
 *   1. Load protocol metadata from protocols/{id} (one Firestore doc read).
 *   2. Connect Yjs via ProtocolYjs.connect(id) — applies snapshot + catchup.
 *   3. If Yjs tree is empty (first edit ever), seed it from doc.tree using
 *      ProtocolBlocks.hydrateTreeToYjs(...).
 *   4. Render outline + content from the Y.Map tree; observe for changes.
 *   5. On any user edit, debounce a flush:
 *        - Y.Doc updates flow through the yjs_updates subcollection (handled
 *          by protocol-yjs).
 *        - The parent doc's `tree`, `title`, `updated_at`, etc. get a
 *          debounced rewrite so the list view sees fresh metadata.
 *
 * No outline drag-reorder, no nested sections, no comments, no view filters.
 * Phase 1 keeps surface small.
 */

(function () {
  var protocolId = window.__PROTOCOL_ID;
  if (!protocolId) {
    document.body.innerHTML = '<div class="page"><h1>Missing ?protocol= parameter</h1></div>';
    return;
  }

  // V3.119 — historical version view. `?protocol=X&version=N` renders
  // the v<N> snapshot in read-only mode (Y.Doc local-only, no Firestore
  // subscription, no edit affordances).
  var versionParam = parseInt(new URLSearchParams(location.search).get('version'), 10);
  var viewingVersion = (isFinite(versionParam) && versionParam > 0) ? versionParam : null;

  var titleEl     = document.getElementById('pre-title');
  var saveStateEl = document.getElementById('pre-savestate');
  var outlineEl   = document.getElementById('pre-outline');
  var addSectionBtn = document.getElementById('pre-add-section-btn');
  var contentEl   = document.getElementById('pre-content');
  var statusSel   = document.getElementById('pre-status-select');
  var tagsInput   = document.getElementById('pre-tags-input');
  var summaryInput= document.getElementById('pre-summary-input');
  var readonlyBanner = document.getElementById('pre-readonly-banner');
  var versionBanner  = document.getElementById('pre-version-banner');

  // V3.119 topbar additions
  var bylineEl       = document.getElementById('pre-byline');
  var forkLineageEl  = document.getElementById('pre-fork-lineage');
  var saveVersionBtn = document.getElementById('pre-save-version-btn');
  var versionsBtn    = document.getElementById('pre-versions-btn');
  var versionsCount  = document.getElementById('pre-versions-count');
  var versionsDropdown = document.getElementById('pre-versions-dropdown');
  var forkBtn        = document.getElementById('pre-fork-btn');
  var migrateBtn     = document.getElementById('pre-migrate-btn');
  var matchInvBtn    = document.getElementById('pre-match-inv-btn');  // V3.139
  var docViewBtn     = document.getElementById('pre-docview-btn');    // V3.315

  // Save Version modal handles
  var saveverModal       = document.getElementById('pre-savever-modal');
  var saveverClose       = document.getElementById('pre-savever-close');
  var saveverCancel      = document.getElementById('pre-savever-cancel');
  var saveverCreate      = document.getElementById('pre-savever-create');
  var saveverLabelInput  = document.getElementById('pre-savever-label');
  var saveverMessageInput= document.getElementById('pre-savever-message');
  var saveverError       = document.getElementById('pre-savever-error');

  // Fork modal handles
  var forkModal       = document.getElementById('pre-fork-modal');
  var forkClose       = document.getElementById('pre-fork-close');
  var forkCancel      = document.getElementById('pre-fork-cancel');
  var forkCreate      = document.getElementById('pre-fork-create');
  var forkTitleInput  = document.getElementById('pre-fork-title');
  var forkIdInput     = document.getElementById('pre-fork-id');
  var forkVersionSel  = document.getElementById('pre-fork-version');
  var forkError       = document.getElementById('pre-fork-error');

  var state = {
    doc: null,           // protocol metadata from Firestore
    Y: null,
    yDoc: null,
    yTree: null,         // yDoc.getMap('tree')
    yProvider: null,     // ProtocolYjs.connect handle (null in historical view)
    cleanups: [],        // unbinder fns from block renderers
    dirty: false,
    saveTimer: null,
    treeFlushTimer: null,
    canEdit: false,
    viewingVersion: viewingVersion,    // V3.119 — null in live mode
    isHistoricalView: !!viewingVersion,
    versionList: [],                   // V3.119 — cached versions list
  };

  function setSaveState(text, kind) {
    saveStateEl.textContent = text || '';
    saveStateEl.className = 'pe-savestate' + (kind ? ' pe-savestate-' + kind : '');
  }

  // V3.319 — first-edit-of-day activity event (FuturePlan 04 B1). One
  // lightweight event per protocol per day, idempotent via the
  // deterministic doc id; no hours, no confirm.
  var _actStampedDate = '';
  function stampActivityEvent() {
    if (!window.ActivitySignals) return;
    var today = new Date().toISOString().slice(0, 10);
    if (_actStampedDate === today) return;
    _actStampedDate = today;
    ActivitySignals.recordWork({
      source: 'rm-protocols',
      sourceRef: { kind: 'protocol', id: protocolId },
      text: 'Protocol: ' + ((state.doc && state.doc.title) || protocolId),
      categoryPath: ['research', 'protocols'],
    });
  }

  function markDirty() {
    state.dirty = true;
    setSaveState('editing…');
    scheduleTreeFlush();
    stampActivityEvent();
  }

  /* ── Metadata save (status, tags, summary, title projection) ──── */

  function scheduleMetaSave() {
    if (state.saveTimer) clearTimeout(state.saveTimer);
    state.saveTimer = setTimeout(saveMetaNow, 600);
  }

  async function saveMetaNow() {
    state.saveTimer = null;
    if (!state.canEdit) return;
    var db = firebridge.db();
    var titleStr = '';
    var yMeta = state.yTree && state.yTree.get('meta');
    if (yMeta) {
      var yTitle = yMeta.get('title');
      titleStr = yTitle && yTitle.toString ? yTitle.toString() : (yTitle || '');
    }
    var update = {
      title: titleStr || state.doc.title || '',
      status: statusSel.value,
      tags: tagsInput.value.split(',').map(function (s) { return s.trim(); }).filter(Boolean),
      summary: summaryInput.value || '',
      updated_at: new Date().toISOString(),
    };
    try {
      setSaveState('saving…');
      await db.collection('protocols').doc(protocolId).update(update);
      Object.assign(state.doc, update);
      setSaveState('saved');
      setTimeout(function () { if (saveStateEl.textContent === 'saved') setSaveState(''); }, 1500);
    } catch (err) {
      console.warn('[protocol-editor] meta save failed:', err);
      setSaveState('save failed', 'error');
    }
  }

  /* ── Tree flush — periodic projection of Y.Doc tree → parent doc field. */

  function scheduleTreeFlush() {
    if (state.treeFlushTimer) clearTimeout(state.treeFlushTimer);
    state.treeFlushTimer = setTimeout(flushTreeNow, 1500);
  }

  async function flushTreeNow() {
    state.treeFlushTimer = null;
    if (!state.canEdit) return;
    if (!state.yDoc) return;
    var plain = window.ProtocolBlocks.dehydrateTree(state.yDoc);
    var titleStr = (plain.meta && plain.meta.title) || state.doc.title || '';
    var update = {
      tree: plain,
      title: titleStr,
      updated_at: new Date().toISOString(),
    };
    try {
      setSaveState('saving…');
      await firebridge.db().collection('protocols').doc(protocolId).update(update);
      state.doc.tree = plain;
      state.doc.title = titleStr;
      state.doc.updated_at = update.updated_at;
      state.dirty = false;
      setSaveState('saved');
      setTimeout(function () { if (saveStateEl.textContent === 'saved') setSaveState(''); }, 1500);
    } catch (err) {
      console.warn('[protocol-editor] tree flush failed:', err);
      setSaveState('save failed', 'error');
    }
  }

  /* ── Render ──────────────────────────────────────────────────── */

  function clearCleanups() {
    state.cleanups.forEach(function (fn) { try { fn(); } catch (e) {} });
    state.cleanups = [];
  }

  function buildCtx(extra) {
    return Object.assign({
      Y: state.Y,
      protocolId: protocolId,
      canEdit: state.canEdit,
      markDirty: markDirty,
      setSaveState: setSaveState,
      registerCleanup: function (fn) { state.cleanups.push(fn); },
      moveUp: function (yBlock) { moveBlock(yBlock, -1); },
      moveDown: function (yBlock) { moveBlock(yBlock, +1); },
      removeBlock: function (yBlock) { removeBlock(yBlock); },
    }, extra || {});
  }

  /* Find a block's location: { ySection, index }. */
  function locateBlock(yBlock) {
    var ySections = state.yTree.get('sections');
    if (!ySections) return null;
    var arr = ySections.toArray();
    for (var i = 0; i < arr.length; i++) {
      var ySec = arr[i];
      var yChildren = ySec.get('children');
      if (!yChildren) continue;
      var children = yChildren.toArray();
      for (var j = 0; j < children.length; j++) {
        if (children[j] === yBlock || (children[j].get && children[j].get('id') === yBlock.get('id'))) {
          return { ySec: ySec, yChildren: yChildren, index: j };
        }
      }
    }
    return null;
  }

  function moveBlock(yBlock, delta) {
    var loc = locateBlock(yBlock);
    if (!loc) return;
    var newIdx = loc.index + delta;
    if (newIdx < 0 || newIdx >= loc.yChildren.length) return;
    state.yDoc.transact(function () {
      var snapshot = window.ProtocolBlocks.dehydrateBlock(yBlock);
      loc.yChildren.delete(loc.index, 1);
      var rebuilt = window.ProtocolBlocks.hydrateBlockToYjs(snapshot, state.Y);
      loc.yChildren.insert(newIdx, [rebuilt]);
    });
    markDirty();
  }

  function removeBlock(yBlock) {
    var loc = locateBlock(yBlock);
    if (!loc) return;
    loc.yChildren.delete(loc.index, 1);
    markDirty();
  }

  function addBlockToSection(ySection, kind) {
    var plain = window.ProtocolSchemas.newBlock(kind);
    var yBlock = window.ProtocolBlocks.hydrateBlockToYjs(plain, state.Y);
    var yChildren = ySection.get('children');
    yChildren.push([yBlock]);
    markDirty();
  }

  function addSection() {
    var label = prompt('Section label:', 'Section ' + ((state.yTree.get('sections') || []).length + 1));
    if (!label) return;
    var ySec = window.ProtocolBlocks.hydrateSectionToYjs(
      window.ProtocolSchemas.newSection(label, state.yTree.get('sections').length),
      state.Y
    );
    state.yTree.get('sections').push([ySec]);
    markDirty();
  }

  function removeSection(ySec) {
    var ySections = state.yTree.get('sections');
    var arr = ySections.toArray();
    for (var i = 0; i < arr.length; i++) {
      if (arr[i] === ySec) {
        if (!confirm('Delete this entire section and its blocks?')) return;
        ySections.delete(i, 1);
        markDirty();
        return;
      }
    }
  }

  function escapeHtml(s) {
    return String(s || '').replace(/[&<>"']/g, function (c) {
      return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c];
    });
  }

  function _slugify(s) {
    if (typeof slugify === 'function') return slugify(s);
    return String(s || '')
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, '-')
      .replace(/^-+|-+$/g, '');
  }

  function _formatTimestamp(iso) {
    if (!iso) return '';
    try { return new Date(iso).toLocaleString(); }
    catch (e) { return iso; }
  }

  /* ── V3.119 — Author byline + fork lineage rendering ─────────── */

  function renderByline() {
    if (!state.doc) { bylineEl.textContent = ''; return; }
    var name = state.doc.author_name || '(unknown author)';
    var html = 'Created by <strong>' + escapeHtml(name) + '</strong>';
    if (state.doc.created_at) {
      html += ' · ' + escapeHtml((state.doc.created_at || '').slice(0, 10));
    }
    if (typeof state.doc.current_version === 'number' && state.doc.current_version > 0) {
      html += ' · v' + state.doc.current_version;
    }
    // V3.141 — admin-only edit affordance for author + creation date.
    var isAdmin = typeof firebridge.isAdmin === 'function' && firebridge.isAdmin();
    if (isAdmin) {
      html += ' <button class="pre-byline-edit" id="pre-byline-edit-btn" title="Admin: edit author / creation date">✏️</button>';
    }
    bylineEl.innerHTML = html;
    var btn = document.getElementById('pre-byline-edit-btn');
    if (btn) btn.addEventListener('click', openAuthDateModal);
  }

  /* ── V3.141 — Admin: edit author + creation date ─────────────── */

  var authDateModal     = document.getElementById('pre-authdate-modal');
  var authDateClose     = document.getElementById('pre-authdate-close');
  var authDateCancel    = document.getElementById('pre-authdate-cancel');
  var authDateSave      = document.getElementById('pre-authdate-save');
  var authDateAuthorSel = document.getElementById('pre-authdate-author');
  var authDateNameInp   = document.getElementById('pre-authdate-name');
  var authDateCreatedInp= document.getElementById('pre-authdate-created');
  var authDateError     = document.getElementById('pre-authdate-error');
  var _rosterCache      = null;

  async function _loadRoster() {
    if (_rosterCache) return _rosterCache;
    try {
      var data = await api.load('lab/users.json');
      var users = (data && data.users) || [];
      // Filter out guests (mirror firebridge.isLabMember()), sort by name.
      _rosterCache = users
        .filter(function (u) { return u && u.uid && LAB_USERS.isVisible(u); })
        .sort(function (a, b) {
          return ((a.name || a.email || a.uid) + '').toLowerCase().localeCompare(
                 ((b.name || b.email || b.uid) + '').toLowerCase());
        });
      return _rosterCache;
    } catch (err) {
      console.warn('[protocol-editor] roster load failed:', err && err.message);
      return [];
    }
  }

  function _populateRosterSelect(roster, currentAuthorUid) {
    authDateAuthorSel.innerHTML = '';
    var optBlank = document.createElement('option');
    optBlank.value = '';
    optBlank.textContent = '— select an author —';
    authDateAuthorSel.appendChild(optBlank);
    roster.forEach(function (u) {
      var opt = document.createElement('option');
      opt.value = u.uid;
      opt.textContent = (u.name || u.email || u.uid) +
        (u.email ? ' · ' + u.email : '');
      if (u.uid === currentAuthorUid) opt.selected = true;
      opt.dataset.name = u.name || u.email || u.uid;
      authDateAuthorSel.appendChild(opt);
    });
  }

  async function openAuthDateModal() {
    if (!firebridge.isAdmin || !firebridge.isAdmin()) {
      alert('Admin only.');
      return;
    }
    if (!state.doc) return;
    authDateError.hidden = true;
    authDateError.textContent = '';
    authDateNameInp.value = state.doc.author_name || '';
    var createdIso = state.doc.created_at || '';
    authDateCreatedInp.value = (createdIso || '').slice(0, 10);
    authDateAuthorSel.innerHTML = '<option value="">— loading roster —</option>';
    authDateModal.hidden = false;

    var roster = await _loadRoster();
    _populateRosterSelect(roster, state.doc.author_uid);
  }

  function closeAuthDateModal() { authDateModal.hidden = true; }

  authDateAuthorSel && authDateAuthorSel.addEventListener('change', function () {
    var opt = authDateAuthorSel.options[authDateAuthorSel.selectedIndex];
    if (opt && opt.dataset && opt.dataset.name) {
      authDateNameInp.value = opt.dataset.name;
    }
  });

  async function saveAuthDate() {
    if (!firebridge.isAdmin || !firebridge.isAdmin()) {
      authDateError.textContent = 'Admin only.';
      authDateError.hidden = false;
      return;
    }
    var newAuthorUid = authDateAuthorSel.value || '';
    var newAuthorName = (authDateNameInp.value || '').trim();
    var dateStr = (authDateCreatedInp.value || '').trim();

    authDateError.hidden = true;
    if (!newAuthorUid) {
      authDateError.textContent = 'Pick an author from the roster.';
      authDateError.hidden = false;
      return;
    }
    if (!newAuthorName) {
      authDateError.textContent = 'Author display name is required.';
      authDateError.hidden = false;
      return;
    }
    if (!dateStr || !/^\d{4}-\d{2}-\d{2}$/.test(dateStr)) {
      authDateError.textContent = 'Creation date must be YYYY-MM-DD.';
      authDateError.hidden = false;
      return;
    }
    var createdIso = dateStr + 'T00:00:00.000Z';

    authDateSave.disabled = true;
    authDateSave.textContent = 'Saving…';
    try {
      var update = {
        author_uid: newAuthorUid,
        author_name: newAuthorName,
        created_at: createdIso,
        // updated_at moves so the list cache picks up the change.
        updated_at: new Date().toISOString(),
      };
      await firebridge.db().collection('protocols').doc(protocolId).update(update);
      Object.assign(state.doc, update);
      renderByline();
      if (typeof toast === 'function') toast('Author + creation date updated');
      closeAuthDateModal();
    } catch (err) {
      console.error('[protocol-editor] author/date update failed:', err);
      authDateError.textContent = 'Update failed: ' + (err.message || err);
      authDateError.hidden = false;
    } finally {
      authDateSave.disabled = false;
      authDateSave.textContent = 'Save changes';
    }
  }

  authDateClose  && authDateClose.addEventListener('click', closeAuthDateModal);
  authDateCancel && authDateCancel.addEventListener('click', closeAuthDateModal);
  authDateSave   && authDateSave.addEventListener('click', saveAuthDate);
  authDateModal  && authDateModal.addEventListener('click', function (e) {
    if (e.target === authDateModal) closeAuthDateModal();
  });

  function renderForkLineage() {
    if (!state.doc) { forkLineageEl.hidden = true; return; }
    var ff = state.doc.forked_from;
    if (!ff || !ff.protocol_id || ff.migrated_to_standalone_at) {
      forkLineageEl.hidden = true;
      return;
    }
    forkLineageEl.hidden = false;
    forkLineageEl.innerHTML =
      '<span class="pre-fork-icon">🍴</span> Fork of ' +
      '<a href="/rm/pages/protocols.html?protocol=' + encodeURIComponent(ff.protocol_id) + '">' +
      escapeHtml(ff.protocol_title || ff.protocol_id) + '</a>' +
      (typeof ff.version === 'number' && ff.version > 0 ? ' v' + ff.version : '');
  }

  /* ── V3.119 — Versions dropdown ──────────────────────────────── */

  async function refreshVersionsList() {
    if (!window.PROTOCOL_VERSIONS) return;
    try {
      var versions = await window.PROTOCOL_VERSIONS.listVersions(protocolId);
      state.versionList = versions || [];
      versionsCount.textContent = state.versionList.length ? '(' + state.versionList.length + ')' : '';
      renderVersionsDropdown();
      populateForkVersionSelect();
    } catch (err) {
      console.warn('[protocol-editor] listVersions failed:', err.message);
      state.versionList = [];
      versionsCount.textContent = '';
    }
  }

  function renderVersionsDropdown() {
    versionsDropdown.innerHTML = '';
    if (!state.versionList.length) {
      versionsDropdown.innerHTML = '<div class="pre-version-row pre-version-empty">No saved versions yet. Click "Save version" to create the first one.</div>';
      return;
    }
    if (!state.isHistoricalView) {
      var liveRow = document.createElement('a');
      liveRow.className = 'pre-version-row pre-version-current';
      liveRow.href = '/rm/pages/protocols.html?protocol=' + encodeURIComponent(protocolId);
      liveRow.innerHTML = '<strong>Live (latest edits)</strong><span class="pre-version-meta">currently viewing</span>';
      versionsDropdown.appendChild(liveRow);
    }
    state.versionList.forEach(function (v) {
      var row = document.createElement('a');
      row.className = 'pre-version-row';
      if (state.viewingVersion === v.version) row.classList.add('pre-version-current');
      row.href = '/rm/pages/protocols.html?protocol=' + encodeURIComponent(protocolId) + '&version=' + v.version;
      var labelHtml = v.label
        ? '<strong>v' + v.version + ' · ' + escapeHtml(v.label) + '</strong>'
        : '<strong>v' + v.version + '</strong>';
      row.innerHTML = labelHtml +
        '<span class="pre-version-meta">' + escapeHtml(_formatTimestamp(v.snapshot_at)) +
        ' · ' + escapeHtml(v.snapshot_by_name || '(unknown)') + '</span>' +
        (v.message ? '<span class="pre-version-msg">' + escapeHtml(v.message) + '</span>' : '');
      versionsDropdown.appendChild(row);
    });
  }

  function toggleVersionsDropdown() {
    versionsDropdown.hidden = !versionsDropdown.hidden;
  }

  /* ── V3.119 — Save Version modal ─────────────────────────────── */

  function openSaveVersionModal() {
    saveverModal.hidden = false;
    saveverLabelInput.value = '';
    saveverMessageInput.value = '';
    saveverError.hidden = true;
    setTimeout(function () { saveverLabelInput.focus(); }, 50);
  }
  function closeSaveVersionModal() { saveverModal.hidden = true; }

  async function doSaveVersion() {
    if (!state.canEdit) return;
    if (!window.PROTOCOL_VERSIONS) {
      saveverError.textContent = 'Versioning module not loaded.';
      saveverError.hidden = false;
      return;
    }
    saveverError.hidden = true;
    saveverCreate.disabled = true;
    saveverCreate.textContent = 'Saving…';
    try {
      // Flush any pending tree edits to ensure the snapshot reflects the
      // user's latest keystrokes.
      if (state.dirty) await flushTreeNow();
      var plain = window.ProtocolBlocks.dehydrateTree(state.yDoc);
      var res = await window.PROTOCOL_VERSIONS.saveVersion(protocolId, plain, {
        label: saveverLabelInput.value.trim(),
        message: saveverMessageInput.value.trim(),
      });
      // Update local state
      state.doc.current_version = res.version;
      state.doc.latest_snapshot_at = new Date().toISOString();
      renderByline();
      await refreshVersionsList();
      if (typeof toast === 'function') toast('Saved as version ' + res.version);
      closeSaveVersionModal();
    } catch (err) {
      console.error('[protocol-editor] saveVersion failed:', err);
      saveverError.textContent = 'Failed: ' + (err.message || err);
      saveverError.hidden = false;
    } finally {
      saveverCreate.disabled = false;
      saveverCreate.textContent = 'Save version';
    }
  }

  /* ── V3.119 — Fork modal ─────────────────────────────────────── */

  function populateForkVersionSelect() {
    if (!forkVersionSel) return;
    // Preserve "Latest (live tree)" option, then add each version.
    forkVersionSel.innerHTML = '<option value="">Latest (live tree)</option>';
    state.versionList.forEach(function (v) {
      var opt = document.createElement('option');
      opt.value = String(v.version);
      opt.textContent = 'v' + v.version + (v.label ? ' — ' + v.label : '');
      forkVersionSel.appendChild(opt);
    });
  }

  function openForkModal() {
    forkModal.hidden = false;
    var srcTitle = (state.doc && state.doc.title) || protocolId;
    forkTitleInput.value = srcTitle + ' (fork)';
    forkIdInput.value = _slugify(srcTitle) + '-fork';
    forkVersionSel.value = '';
    forkError.hidden = true;
    populateForkVersionSelect();
    setTimeout(function () { forkTitleInput.focus(); forkTitleInput.select(); }, 50);
  }
  function closeForkModal() { forkModal.hidden = true; }

  async function doFork() {
    if (!window.PROTOCOL_VERSIONS) {
      forkError.textContent = 'Versioning module not loaded.';
      forkError.hidden = false;
      return;
    }
    var title = forkTitleInput.value.trim();
    var slug = (forkIdInput.value.trim() || _slugify(title)).toLowerCase();
    var versionStr = forkVersionSel.value;
    var versionNum = versionStr ? parseInt(versionStr, 10) : null;

    forkError.hidden = true;

    if (!title) {
      forkError.textContent = 'Title is required.';
      forkError.hidden = false;
      return;
    }
    if (!/^[a-z0-9][a-z0-9-]*$/.test(slug)) {
      forkError.textContent = 'Slug must be kebab-case (lowercase, digits, hyphens).';
      forkError.hidden = false;
      return;
    }

    forkCreate.disabled = true;
    forkCreate.textContent = 'Forking…';
    try {
      // If forking from "Latest (live tree)" and there are pending edits,
      // flush so the fork sees the user's latest keystrokes.
      if (!versionNum && state.dirty) await flushTreeNow();

      var newId = await window.PROTOCOL_VERSIONS.forkProtocol(protocolId, {
        forkId: slug,
        title: title,
        version: versionNum || undefined,
      });
      window.location.href = '/rm/pages/protocols.html?protocol=' + encodeURIComponent(newId);
    } catch (err) {
      console.error('[protocol-editor] fork failed:', err);
      forkError.textContent = 'Failed: ' + (err.message || err);
      forkError.hidden = false;
      forkCreate.disabled = false;
      forkCreate.textContent = 'Create fork';
    }
  }

  /* ── V3.119 — Migrate fork to standalone ─────────────────────── */

  async function doMigrate() {
    if (!state.doc || !window.PROTOCOL_VERSIONS) return;
    if (!window.PROTOCOL_VERSIONS.isLinkedFork(state.doc)) return;
    var ok = confirm("Sever this fork's link to its parent? Past version snapshots remain intact, but this protocol will no longer display the fork-of badge. (Cannot be undone.)");
    if (!ok) return;
    try {
      await window.PROTOCOL_VERSIONS.migrateForkToStandalone(protocolId);
      // Reflect locally and re-render
      if (state.doc.forked_from) {
        state.doc.forked_from.migrated_to_standalone_at = new Date().toISOString();
      }
      renderForkLineage();
      migrateBtn.hidden = true;
      if (typeof toast === 'function') toast('Migrated to standalone');
    } catch (err) {
      console.error('[protocol-editor] migrate failed:', err);
      alert('Migrate failed: ' + (err.message || err));
    }
  }

  function render() {
    clearCleanups();
    contentEl.innerHTML = '';
    outlineEl.innerHTML = '';

    var ySections = state.yTree.get('sections');
    if (!ySections || !ySections.length) {
      contentEl.innerHTML = '<div class="empty-state">No sections yet. Click "+ Add section" to start.</div>';
      return;
    }
    var sections = ySections.toArray();
    var stepCounter = 0;

    sections.forEach(function (ySec, secIdx) {
      var secId = ySec.get('id');
      var secLabel = ySec.get('label') || 'Untitled';

      // Outline item
      var oli = document.createElement('li');
      var oa = document.createElement('a');
      oa.href = '#section-' + secId;
      oa.textContent = secLabel;
      oli.appendChild(oa);
      outlineEl.appendChild(oli);

      // Section header
      var secEl = document.createElement('section');
      secEl.className = 'pre-section';
      secEl.id = 'section-' + secId;

      var headerRow = document.createElement('div');
      headerRow.className = 'pre-section-header';

      var labelInput = document.createElement('input');
      labelInput.type = 'text';
      labelInput.className = 'pre-section-label';
      labelInput.value = secLabel;
      labelInput.disabled = !state.canEdit;
      labelInput.addEventListener('input', function () {
        ySec.set('label', labelInput.value);
        markDirty();
      });
      ySec.observe(function (event) {
        if (event.keysChanged && event.keysChanged.has('label')) {
          if (document.activeElement !== labelInput) {
            labelInput.value = ySec.get('label') || '';
          }
        }
      });
      headerRow.appendChild(labelInput);

      if (state.canEdit) {
        var delSec = document.createElement('button');
        delSec.type = 'button';
        delSec.className = 'pre-block-btn';
        delSec.textContent = '× section';
        delSec.title = 'Delete section';
        delSec.addEventListener('click', function () { removeSection(ySec); });
        headerRow.appendChild(delSec);
      }
      secEl.appendChild(headerRow);

      // Blocks
      var yChildren = ySec.get('children');
      if (yChildren) {
        yChildren.toArray().forEach(function (yBlock) {
          var ctx = buildCtx({});
          if (yBlock.get('kind') === 'step') {
            stepCounter++;
            ctx.stepNumber = stepCounter;
          }
          secEl.appendChild(window.ProtocolBlocks.renderBlock(yBlock, ctx));
        });
      }

      // + Add block menu
      if (state.canEdit) {
        var addRow = document.createElement('div');
        addRow.className = 'pre-add-block-row';
        // V3.315 — `callout` replaces note/safety; heading + docHeader added.
        // V3.316 — table, kv, timeline.
        // V3.318 — calculator. V3.324 — builder + layoutMap.
        ['step', 'materials', 'callout', 'heading', 'figure', 'formula',
         'calculator', 'builder', 'layoutMap', 'table', 'kv', 'timeline',
         'docHeader'].forEach(function (kind) {
          var b = document.createElement('button');
          b.type = 'button';
          b.className = 'btn pre-add-block-btn';
          b.textContent = '+ ' + kind;
          b.addEventListener('click', function () { addBlockToSection(ySec, kind); });
          addRow.appendChild(b);
        });
        secEl.appendChild(addRow);
      }

      contentEl.appendChild(secEl);
    });
  }

  /* ── Title binding ──────────────────────────────────────────── */

  function bindTitle() {
    var yMeta = state.yTree.get('meta');
    if (!yMeta) return;
    var yTitle = yMeta.get('title');
    if (!yTitle || typeof yTitle.toString !== 'function') {
      // legacy fallback — coerce string title into a Y.Text
      var s = yTitle || state.doc.title || '';
      var nt = new state.Y.Text();
      if (s) nt.insert(0, String(s));
      yMeta.set('title', nt);
      yTitle = nt;
    }
    titleEl.disabled = !state.canEdit;
    // <input> uses .value, not textContent — bind directly rather than
    // through ProtocolBlocks.bindYText (which assumes contenteditable).
    titleEl.value = yTitle.toString();
    var titleObs = function () {
      if (document.activeElement !== titleEl) {
        titleEl.value = yTitle.toString();
      }
    };
    yTitle.observe(titleObs);
    state.cleanups.push(function () { yTitle.unobserve(titleObs); });
    titleEl.addEventListener('input', function () {
      var s = titleEl.value;
      yTitle.doc.transact(function () {
        if (yTitle.length) yTitle.delete(0, yTitle.length);
        if (s) yTitle.insert(0, s);
      });
      markDirty();
      scheduleMetaSave();
    });
  }

  /* ── Boot ─────────────────────────────────────────────────────── */

  async function boot() {
    setSaveState('loading…');

    // 1. Wait for auth + lab-member gate
    var gate = await firebridge.gateSignedIn('Sign in to view this protocol.');
    if (!gate.allowed) { setSaveState(''); return; }
    if (!firebridge.isLabMember()) {
      // firebridge already shows a pending-access overlay; nothing to do.
      setSaveState('');
      return;
    }

    var user = firebridge.getUser();
    var db = firebridge.db();

    // 2. Load protocol metadata
    try {
      var snap = await db.collection('protocols').doc(protocolId).get();
      if (!snap.exists) {
        contentEl.innerHTML = '<div class="empty-state">Protocol not found: ' + escapeHtml(protocolId) + '</div>';
        setSaveState('');
        return;
      }
      state.doc = window.ProtocolSchemas.protocolHydrate(snap.data());
    } catch (err) {
      console.error('[protocol-editor] load failed:', err);
      contentEl.innerHTML = '<div class="empty-state">Failed to load protocol: ' + escapeHtml(err.message) + '</div>';
      setSaveState('load failed', 'error');
      return;
    }

    // 3. Permission check
    var isAdmin = typeof firebridge.isAdmin === 'function' ? firebridge.isAdmin() : false;
    state.canEdit = ((state.doc.ownerUid === user.uid) || isAdmin) && !state.isHistoricalView;
    if (state.isHistoricalView) {
      versionBanner.hidden = false;
      versionBanner.innerHTML = 'Viewing version ' + state.viewingVersion +
        ' — read only. <a href="/rm/pages/protocols.html?protocol=' +
        encodeURIComponent(protocolId) + '">Switch to latest</a> to edit.';
    } else if (!state.canEdit) {
      readonlyBanner.hidden = false;
      readonlyBanner.textContent = 'Read-only — only the owner or an admin can edit this protocol.';
    }

    // 4. Get a Y reference (needed by both branches).
    var Y;
    try { Y = await window.ProtocolYjs.ensureYjs(); }
    catch (err) {
      console.error('[protocol-editor] yjs lib load failed:', err);
      setSaveState('sync error', 'error');
      return;
    }
    state.Y = Y;

    if (state.isHistoricalView) {
      // V3.119 — read the version snapshot, hydrate into a LOCAL Y.Doc
      // (not connected to Firestore). Same render code paths work; no
      // writes go anywhere; no live sync.
      try {
        var versionDoc = await window.PROTOCOL_VERSIONS.loadVersion(protocolId, state.viewingVersion);
        state.yDoc = new Y.Doc();
        state.yTree = state.yDoc.getMap('tree');
        state.yDoc.transact(function () {
          window.ProtocolBlocks.hydrateTreeToYjs(state.yDoc, versionDoc.tree, Y);
        });
      } catch (err) {
        console.error('[protocol-editor] loadVersion failed:', err);
        contentEl.innerHTML = '<div class="empty-state">Failed to load version: ' + escapeHtml(err.message) + '</div>';
        setSaveState('load failed', 'error');
        return;
      }
    } else {
      // Live editing — connect Yjs to Firestore subcollections.
      try {
        state.yProvider = await window.ProtocolYjs.connect(protocolId);
        state.yDoc = state.yProvider.yDoc;
        state.yTree = state.yDoc.getMap('tree');
      } catch (err) {
        console.error('[protocol-editor] yjs connect failed:', err);
        setSaveState('sync error', 'error');
        return;
      }

      // 5. If Yjs tree is empty (first edit), seed from the JSON tree.
      //    Only the owner seeds — otherwise two simultaneous opens of a brand-
      //    new protocol would each seed and merge into a duplicated tree.
      if (!state.yTree.has('sections') || !state.yTree.has('meta')) {
        if (state.doc.ownerUid === user.uid) {
          state.yDoc.transact(function () {
            window.ProtocolBlocks.hydrateTreeToYjs(state.yDoc, state.doc.tree, state.Y);
          });
        } else {
          contentEl.innerHTML = '<div class="empty-state">Waiting for the protocol author to populate this protocol…</div>';
          var seedWaitObs = function () {
            if (state.yTree.has('sections') && state.yTree.has('meta')) {
              state.yTree.unobserveDeep(seedWaitObs);
              render();
            }
          };
          state.yTree.observeDeep(seedWaitObs);
        }
      }
    }

    // 6. Populate metadata controls
    statusSel.value = state.doc.status || 'draft';
    tagsInput.value = (state.doc.tags || []).join(', ');
    summaryInput.value = state.doc.summary || '';
    statusSel.disabled = tagsInput.disabled = summaryInput.disabled = !state.canEdit;
    addSectionBtn.disabled = !state.canEdit;

    statusSel.addEventListener('change', scheduleMetaSave);
    tagsInput.addEventListener('input', scheduleMetaSave);
    summaryInput.addEventListener('input', scheduleMetaSave);
    addSectionBtn.addEventListener('click', addSection);

    // V3.119 — author byline + fork lineage + topbar buttons.
    renderByline();
    renderForkLineage();
    saveVersionBtn.disabled = !state.canEdit;
    versionsBtn.disabled = false;  // any reader can browse versions
    forkBtn.disabled = false;      // any lab member can fork
    saveVersionBtn.addEventListener('click', openSaveVersionModal);
    versionsBtn.addEventListener('click', toggleVersionsDropdown);
    forkBtn.addEventListener('click', openForkModal);
    saveverClose.addEventListener('click', closeSaveVersionModal);
    saveverCancel.addEventListener('click', closeSaveVersionModal);
    saveverCreate.addEventListener('click', doSaveVersion);
    saveverModal.addEventListener('click', function (e) {
      if (e.target === saveverModal) closeSaveVersionModal();
    });
    forkClose.addEventListener('click', closeForkModal);
    forkCancel.addEventListener('click', closeForkModal);
    forkCreate.addEventListener('click', doFork);
    forkModal.addEventListener('click', function (e) {
      if (e.target === forkModal) closeForkModal();
    });
    forkTitleInput.addEventListener('blur', function () {
      if (!forkIdInput.value.trim() && forkTitleInput.value.trim()) {
        forkIdInput.value = _slugify(forkTitleInput.value);
      }
    });
    document.addEventListener('keydown', function (e) {
      if (e.key === 'Escape') {
        if (!saveverModal.hidden) closeSaveVersionModal();
        if (!forkModal.hidden) closeForkModal();
        if (authDateModal && !authDateModal.hidden) closeAuthDateModal();
      }
    });
    // Click outside the dropdown closes it.
    document.addEventListener('click', function (e) {
      if (versionsDropdown.hidden) return;
      if (versionsDropdown.contains(e.target) || versionsBtn.contains(e.target)) return;
      versionsDropdown.hidden = true;
    });

    // Fork-only: show "Migrate to standalone" if applicable.
    if (window.PROTOCOL_VERSIONS && window.PROTOCOL_VERSIONS.isLinkedFork(state.doc)
        && state.canEdit) {
      migrateBtn.hidden = false;
      migrateBtn.addEventListener('click', doMigrate);
    }

    // V3.315 — Doc view link (read-only print/export rendering).
    if (docViewBtn) {
      docViewBtn.href = '/rm/pages/protocols.html?protocol=' +
        encodeURIComponent(protocolId) + '&view=doc';
    }

    // V3.139 — Match-inventory button. Visible to readers (so they can
    // see the modal at all), but the modal itself bails out for read-
    // only viewers via PROTOCOL_IMPORT.openMatcher's canEdit guard.
    if (matchInvBtn && window.PROTOCOL_IMPORT) {
      matchInvBtn.disabled = !state.canEdit;
      matchInvBtn.addEventListener('click', function () {
        window.PROTOCOL_IMPORT.openMatcher(protocolId);
      });
    }
    // V3.139 — Expose editor state so PROTOCOL_IMPORT.openMatcher can
    // read the live yTree, apply Y.Map writes inside a transaction,
    // and call markDirty on apply. The exposed state intentionally
    // lacks methods that would let an outside caller mutate UI; only
    // the bits the matcher needs.
    window.__PROTOCOL_EDITOR_STATE = {
      protocolId: protocolId,
      yDoc: state.yDoc,
      yTree: state.yTree,
      Y: state.Y,
      canEdit: state.canEdit,
      markDirty: markDirty,
    };

    // 7. Bind title + render content
    bindTitle();
    render();

    // V3.119 — fetch version list (independent of canEdit; readers see
    // versions too). Best-effort — failure just means an empty dropdown.
    refreshVersionsList();

    // 8. Re-render on tree shape changes (sections add/remove, blocks add/remove).
    //    Body / attrs edits update in place via individual block observers.
    state.yTree.observeDeep(function (events) {
      // We re-render only on structural changes — block add/remove or
      // section add/remove. Pure body-text edits stream through the
      // bindYText observer and don't need a full re-render.
      var structural = events.some(function (ev) {
        var path = ev.path || [];
        // sections array change OR children array change
        var lastSeg = path[path.length - 1];
        if (lastSeg === undefined) {
          // root tree map change
          return ev.changes && ev.changes.keys && (ev.changes.keys.has('sections') || false);
        }
        // detect Y.Array changes by presence of `delta`
        return ev.changes && ev.changes.delta && ev.changes.delta.length;
      });
      if (structural) render();

      // V3.117 — any deep change might affect formula inputs / outputs.
      // Recompute the symbol table; renderers refresh their var chips on
      // the dispatched `protocol-vars-changed` event.
      if (window.ProtocolFormulas) {
        window.ProtocolFormulas.rebuild(state.yTree);
      }
    });

    // V3.117 — initial symbol-table build. mathjs lazy-loads on the
    // first call; subsequent calls are synchronous through the cached
    // module reference.
    if (window.ProtocolFormulas) {
      window.ProtocolFormulas.setRoot(document);
      window.ProtocolFormulas.rebuild(state.yTree);
    }

    // V3.121 — kick off inventory load now so chips + materials cells
    // resolve quickly. Fires `protocol-inventory-loaded` on success;
    // bindings + materials rows listen and re-render.
    if (window.PROTOCOL_INVENTORY) {
      window.PROTOCOL_INVENTORY.ensureList().catch(function (err) {
        console.warn('[protocol-editor] inventory preload failed:', err && err.message);
      });
    }

    // V3.139 — auto-open the matcher modal once on first load if the
    // URL carries `?match=1` (set by the post-import navigation in
    // protocols.js). Strip the param via history.replaceState so a
    // hard reload doesn't keep re-opening the modal.
    var qp = new URLSearchParams(location.search);
    if (qp.get('match') === '1' && window.PROTOCOL_IMPORT && state.canEdit) {
      qp.delete('match');
      var clean = location.pathname + (qp.toString() ? '?' + qp.toString() : '');
      try { history.replaceState({}, '', clean); } catch (e) {}
      // Wait a tick for inventory to load, then open the matcher.
      setTimeout(function () {
        window.PROTOCOL_IMPORT.openMatcher(protocolId);
      }, 300);
    }

    setSaveState('');
  }

  boot().catch(function (err) {
    console.error('[protocol-editor] boot failed:', err);
    setSaveState('error', 'error');
  });
})();
