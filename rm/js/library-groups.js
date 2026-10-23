/* library-groups.js — V3.363 "groups shelf" above the library table.
 *
 * Three collapsible sections rendered into #lib-groups-shelf on
 * pages/library.html (papers tab):
 *
 *   📖 Open in reader — this browser's paper-reader tabs, read from the
 *      reader's own localStorage state (rm_lp_open_papers, written by
 *      library-paper.js). Per-browser by design; live-updates via the
 *      cross-tab `storage` event + visibilitychange.
 *   📌 Pinned — per-user pinned paper ids (LIBRARY_PREFS.pinned_papers →
 *      userSettings/{uid}.library). Distinct from the lab-shared ★ star.
 *   📁 Groups — reconfigurable named groups (LIBRARY_PREFS.paper_groups),
 *      three kinds:
 *        manual — explicit paper_ids, curated via the 📁 row action;
 *        smart  — a saved search-grammar query (library.js _parseQuery /
 *                 _matches), re-evaluated on every render;
 *        draft  — papers whose meta.library.linked_drafts contains a
 *                 chosen draft id (the V3.352 LIBRARY_LINKS linkage).
 *      Plus lab-shared groups from the librarySharedGroups collection
 *      (route library/shared_groups.json): every member sees them,
 *      admins edit.
 *
 * library.js owns the paper pool + search grammar and passes them in via
 * init(opts) callbacks; this module owns all shelf DOM, the group-picker
 * modal, and persistence. Collapse state is per-device
 * (localStorage rm_lib_shelf_collapsed). The whole shelf hides while a
 * search / tag / missing-PDF filter is active so results stay the focus.
 */

(function () {
  const LP_TABS_KEY = 'rm_lp_open_papers';        // written by library-paper.js
  const COLLAPSE_KEY = 'rm_lib_shelf_collapsed';  // per-device {id: true}

  let _cb = null;              // callbacks from library.js (see init)
  let _shared = [];            // lab-shared groups (librarySharedGroups)
  let _sharedLoaded = false;
  let _collapsed = _loadCollapsed();
  let _lastState = { filterActive: false };

  // ---- small utils --------------------------------------------------------

  function _esc(s) {
    return String(s ?? '').replace(/[&<>"']/g, c => ({
      '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;'
    }[c]));
  }

  function _genId() {
    return 'grp-' + Date.now().toString(36) + '-' + Math.random().toString(36).slice(2, 7);
  }

  function _loadCollapsed() {
    try { return JSON.parse(localStorage.getItem(COLLAPSE_KEY) || '{}') || {}; }
    catch (_) { return {}; }
  }

  function _persistCollapsed() {
    try { localStorage.setItem(COLLAPSE_KEY, JSON.stringify(_collapsed)); }
    catch (_) { /* private mode — collapse state just won't stick */ }
  }
  // V3.826 — every shelf starts FOLDED; a person's own open/close is kept
  // (explicit true/false). Group rows inside Groups keep their old default.
  function _isSecCollapsed(secId) {
    return Object.prototype.hasOwnProperty.call(_collapsed, secId) ? !!_collapsed[secId] : true;
  }

  function _authed() {
    return !!(typeof firebase !== 'undefined' && firebase.auth && firebase.auth().currentUser);
  }

  function _toast(msg, kind) {
    if (_cb && typeof _cb.toast === 'function') _cb.toast(msg, kind);
    else console.log('[library-groups]', msg);
  }

  function _prefs() {
    return window.LIBRARY_PREFS ? LIBRARY_PREFS.get() : null;
  }

  // Clone-mutate-save so we never hand LIBRARY_PREFS a reference into its
  // own cache. save() updates the cache synchronously (debounced write),
  // so an immediate re-render reads fresh values.
  function _savePrefs(mut) {
    if (!window.LIBRARY_PREFS) return;
    const next = JSON.parse(JSON.stringify(LIBRARY_PREFS.get()));
    mut(next);
    LIBRARY_PREFS.save(next);
  }

  // V3.622 — external listeners (the reader's Groups widget) notified on
  // every membership/group mutation, in addition to the shelf's own
  // re-render path.
  let _extraChangeCbs = [];
  function onChanged(cb) { if (typeof cb === 'function') _extraChangeCbs.push(cb); }

  function _changed() {
    if (_cb && typeof _cb.onChanged === 'function') _cb.onChanged();
    else _rerender();
    for (const cb of _extraChangeCbs) {
      try { cb(); } catch (e) { console.error('[library-groups] onChanged cb failed:', e); }
    }
  }

  // ---- reader tabs (localStorage, read-only) ------------------------------

  function _readerTabs() {
    try {
      const raw = localStorage.getItem(LP_TABS_KEY);
      if (!raw) return { tabs: [], activeId: null };
      const parsed = JSON.parse(raw);
      const tabs = Array.isArray(parsed && parsed.tabs)
        ? parsed.tabs.filter(t => t && t.id)
        : [];
      return { tabs, activeId: (parsed && parsed.activeId) || null };
    } catch (_) {
      return { tabs: [], activeId: null };
    }
  }

  // ---- group membership ---------------------------------------------------

  function _papersById(papers) {
    const map = new Map();
    for (const p of papers) map.set(p.id, p);
    return map;
  }

  // Resolve a group to its member papers against the visible pool.
  // manual → stored ids (dangling ids silently skipped — the paper may be
  // deleted or hidden by the visibility filter; we never auto-clean).
  // smart → the saved query through library.js's own parser/matcher.
  // draft → linked_drafts membership (V3.352 linkage).
  function _groupPapers(g, papers, byId) {
    if (g.kind === 'manual') {
      return (g.paper_ids || []).map(id => byId.get(id)).filter(Boolean);
    }
    if (g.kind === 'smart') {
      if (!_cb) return [];
      let parsed;
      try { parsed = _cb.parseQuery(g.query || ''); }
      catch (_) { return []; }
      return papers.filter(p => {
        try { return _cb.matches(p, parsed); } catch (_) { return false; }
      });
    }
    if (g.kind === 'draft') {
      return papers.filter(p => {
        const ld = p.meta && p.meta.library && p.meta.library.linked_drafts;
        return Array.isArray(ld) && ld.includes(g.draft_id);
      });
    }
    return [];
  }

  function _kindBadge(g, isShared) {
    const bits = [];
    if (g.kind === 'smart') bits.push(`<span class="lg-badge lg-badge-smart" title="Smart group — auto-updates from the saved filter: ${_esc(g.query || '')}">${ICON.svg('magnifying-glass')} smart</span>`);
    if (g.kind === 'draft') bits.push(`<span class="lg-badge lg-badge-draft" title="Draft group — papers linked to this draft (via the reader's link-to-draft picker)">${ICON.svg('document-text')} draft</span>`);
    if (isShared) bits.push('<span class="lg-badge lg-badge-lab" title="Lab-shared group — published by an admin, visible to every lab member">lab</span>');
    return bits.join(' ');
  }

  // ---- rendering ----------------------------------------------------------

  function _paperChip(paper, opts) {
    const o = opts || {};
    const lib = (paper.meta && paper.meta.library) || {};
    const title = paper.title || 'Untitled';
    const year = lib.year ? `<span class="lg-chip-year">${_esc(lib.year)}</span>` : '';
    const x = o.removable
      ? `<button class="lg-chip-x" data-act="chip-remove" data-ctx="${_esc(o.ctx)}"${o.gid ? ` data-gid="${_esc(o.gid)}"` : ''} data-pid="${_esc(paper.id)}" title="${_esc(o.removeTitle || 'Remove')}">${ICON.svg('x-mark')}</button>`
      : '';
    return `<span class="lg-chip${o.active ? ' lg-chip-active' : ''}">
      <a class="lg-chip-link" href="/rm/pages/library-paper.html?id=${encodeURIComponent(paper.id)}" title="${_esc(title)}">${_esc(title)}</a>
      ${year}${x}
    </span>`;
  }

  // Reader chips render from the stored tab state, not the paper pool —
  // the reader has the tab open regardless of the library's visibility
  // filter, so a pool miss must not hide it.
  function _readerChip(tab, activeId, byId) {
    const paper = byId.get(tab.id);
    const title = (paper && paper.title) || tab.title || tab.id;
    const lib = paper && paper.meta && paper.meta.library;
    const year = lib && lib.year ? `<span class="lg-chip-year">${_esc(lib.year)}</span>` : '';
    const active = tab.id === activeId;
    return `<span class="lg-chip${active ? ' lg-chip-active' : ''}"${active ? ' title="Active reader tab"' : ''}>
      <a class="lg-chip-link" href="/rm/pages/library-paper.html?id=${encodeURIComponent(tab.id)}" title="${_esc(title)}">${_esc(title)}</a>
      ${year}
    </span>`;
  }

  function _sectionHead(secId, icon, label, count, toolsHtml) {
    const isCollapsed = _isSecCollapsed(secId);
    return `<div class="lg-sec-head" data-act="sec-toggle" data-sec="${_esc(secId)}">
      <span class="lg-caret">${ICON.svg(isCollapsed ? 'chevron-right' : 'chevron-down')}</span>
      <span class="lg-sec-title">${ICON.render(icon)} ${_esc(label)}</span>
      <span class="lg-sec-count">${count}</span>
      <span class="lg-sec-tools">${toolsHtml || ''}</span>
    </div>`;
  }

  function _groupRow(g, papers, isShared, canEdit, idx, total) {
    const gid = g.id;
    const key = 'g:' + gid;
    const isCollapsed = !!_collapsed[key];
    const chipsRemovable = g.kind === 'manual' && canEdit;
    const chips = papers.length
      ? papers.map(p => _paperChip(p, {
          removable: chipsRemovable,
          ctx: isShared ? 'shared-group' : 'group',
          gid,
          removeTitle: 'Remove from this group',
        })).join(' ')
      : `<span class="lg-empty">${g.kind === 'manual'
          ? 'Empty — add papers via the ' + ICON.svg('folder') + ' button on any table row.'
          : (g.kind === 'smart' ? 'No papers match this filter yet.' : 'No papers linked to this draft yet.')}</span>`;
    const tools = canEdit ? `
      ${!isShared ? `<button class="btn btn-sm" data-act="grp-up" data-gid="${_esc(gid)}" title="Move up" ${idx === 0 ? 'disabled' : ''}>↑</button>
      <button class="btn btn-sm" data-act="grp-down" data-gid="${_esc(gid)}" title="Move down" ${idx === total - 1 ? 'disabled' : ''}>↓</button>` : ''}
      <button class="btn btn-sm" data-act="grp-rename" data-gid="${_esc(gid)}" title="Rename group">✎</button>
      <button class="btn btn-sm" data-act="grp-del" data-gid="${_esc(gid)}" title="Delete group (papers themselves are untouched)">${ICON.svg('trash')}</button>` : '';
    return `<div class="lg-group${isCollapsed ? ' lg-collapsed' : ''}" data-gid="${_esc(gid)}">
      <div class="lg-group-head" data-act="grp-toggle" data-gid="${_esc(gid)}">
        <span class="lg-caret">${ICON.svg(isCollapsed ? 'chevron-right' : 'chevron-down')}</span>
        <span class="lg-group-name">${_esc(g.name || '(unnamed)')}</span>
        ${_kindBadge(g, isShared)}
        <span class="lg-sec-count">${papers.length}</span>
        <span class="lg-group-tools">${tools}</span>
      </div>
      <div class="lg-group-body">${chips}</div>
    </div>`;
  }

  function render(state) {
    if (state && typeof state === 'object') _lastState = state;
    const host = document.getElementById('lib-groups-shelf');
    if (!host) return;

    // Search / tag / missing-PDF filter active → results are the focus.
    if (_lastState.filterActive) {
      host.style.display = 'none';
      return;
    }

    const prefs = _prefs();
    const widgets = (prefs && prefs.widgets_enabled) || {};
    const showReader = widgets.shelf_reader !== false;
    const showPinned = widgets.shelf_pinned !== false;
    const showGroups = widgets.shelf_groups !== false;
    const showRecent = widgets.shelf_recent !== false && !!window.LIBRARY_RECENT;   // V3.826
    const showReadings = widgets.shelf_readings !== false && !!(window.LIBRARY_READINGS && LIBRARY_READINGS.shelves);   // V3.827
    if (!showReader && !showPinned && !showGroups && !showRecent && !showReadings) {
      host.style.display = 'none';
      return;
    }

    const papers = (_cb && _cb.getPapers) ? (_cb.getPapers() || []) : [];
    const byId = _papersById(papers);
    const authed = _authed();
    const sections = [];

    // 📥 💡 ✓ Papers people sent me (V3.827) — Assigned to me / Suggested for
    // me / Read as shelves, each counting its papers; rows come from
    // library-readings.js (its mark-as-done buttons are document-delegated).
    let toRead = 0;
    if (showReadings) {
      const rd = LIBRARY_READINGS.shelves();
      if (rd && rd.any) {
        toRead = rd.toRead || 0;
        rd.groups.forEach((g) => {
          sections.push(`<section class="lg-section${_isSecCollapsed(g.id) ? ' lg-collapsed' : ''}" data-sec="${_esc(g.id)}">
            ${_sectionHead(g.id, g.icon, g.label, g.count, g.hint ? '<span class="lg-sec-hint">' + _esc(g.hint) + '</span>' : '')}
            <div class="lg-sec-body lr-shelf-body">${g.bodyHtml}</div>
          </section>`);
        });
      }
    }

    // 🆕 Recently added (V3.826) — the newest papers, newest first; the body
    // is filled by LIBRARY_RECENT.render() once the shelf is in the DOM.
    const withRecent = showRecent && LIBRARY_RECENT.hasAny();
    if (withRecent) {
      sections.push(`<section class="lg-section${_isSecCollapsed('recent') ? ' lg-collapsed' : ''}" data-sec="recent">
        ${_sectionHead('recent', 'sparkles', 'Recently added', LIBRARY_RECENT.countLabel(),
          '<span class="lg-sec-hint" title="When a paper arrived: the extension capture time, else the day its record was made, else the PDF upload day">newest first</span>')}
        <div class="lg-sec-body" id="lib-recent"></div>
      </section>`);
    }

    // 📖 Open in reader — hidden entirely when no tabs.
    if (showReader) {
      const { tabs, activeId } = _readerTabs();
      if (tabs.length) {
        sections.push(`<section class="lg-section${_isSecCollapsed('reader') ? ' lg-collapsed' : ''}" data-sec="reader">
          ${_sectionHead('reader', 'book-open', 'Open in reader', tabs.length,
            '<span class="lg-sec-hint" title="Mirrors this browser\'s reader tabs — close/open tabs in the reader itself">this browser</span>')}
          <div class="lg-sec-body">${tabs.map(t => _readerChip(t, activeId, byId)).join(' ')}</div>
        </section>`);
      }
    }

    // 📌 Pinned — per-user; hidden when empty (or signed out).
    if (showPinned && authed) {
      const pinnedIds = (prefs && prefs.pinned_papers) || [];
      const pinnedPapers = pinnedIds.map(id => byId.get(id)).filter(Boolean);
      if (pinnedPapers.length) {
        sections.push(`<section class="lg-section${_isSecCollapsed('pinned') ? ' lg-collapsed' : ''}" data-sec="pinned">
          ${_sectionHead('pinned', 'pin', 'Pinned', pinnedPapers.length,
            '<span class="lg-sec-hint" title="Only you see your pins — they follow you across devices">just you</span>')}
          <div class="lg-sec-body">${pinnedPapers.map(p => _paperChip(p, {
            removable: true, ctx: 'pin', removeTitle: 'Unpin',
          })).join(' ')}</div>
        </section>`);
      }
    }

    // 📁 Groups — always rendered when enabled + signed in, so the create
    // buttons stay discoverable even before the first group exists.
    if (showGroups && authed) {
      const userGroups = (prefs && prefs.paper_groups) || [];
      const admin = !!(_cb && _cb.isAdmin && _cb.isAdmin());
      const rows = [];
      userGroups.forEach((g, i) => {
        rows.push(_groupRow(g, _groupPapers(g, papers, byId), false, true, i, userGroups.length));
      });
      const sharedSorted = _shared.slice().sort((a, b) => (a.name || '').localeCompare(b.name || ''));
      sharedSorted.forEach((g) => {
        rows.push(_groupRow(g, _groupPapers(g, papers, byId), true, admin, 0, 1));
      });
      const total = userGroups.length + sharedSorted.length;
      const footer = `<div class="lg-footer">
        <button class="btn btn-sm" data-act="new-group" title="Create an empty group, then add papers via the folder button on table rows">＋ New group</button>
        <button class="btn btn-sm" data-act="from-draft" title="Create groups that mirror papers linked to a draft (the reader's link-to-draft picker)">＋ From draft</button>
        ${admin ? '<button class="btn btn-sm" data-act="new-lab-group" title="Create a lab-shared group every member sees (admin)">' + ICON.svg('plus') + ' Lab group</button>' : ''}
        <span class="lg-sec-hint">Tip: filter the table, then ${ICON.svg('save')} Save as group for an auto-updating smart group.</span>
      </div>`;
      sections.push(`<section class="lg-section${_isSecCollapsed('groups') ? ' lg-collapsed' : ''}" data-sec="groups">
        ${_sectionHead('groups', 'folder', 'Groups', total, '')}
        <div class="lg-sec-body lg-groups-body">
          ${rows.join('') || '<span class="lg-empty">No groups yet — create one below, or save a search filter as a smart group.</span>'}
          ${footer}
        </div>
      </section>`);
    }

    if (!sections.length) {
      host.style.display = 'none';
      return;
    }
    host.style.display = '';
    host.innerHTML = `<div class="lg-shelf">${sections.join('')}</div>`;
    if (withRecent) LIBRARY_RECENT.render();   // V3.826 — fill the shelf body
    // V3.828 — the 📚 Shelves block starts folded: its header carries what is
    // inside ("3 to read · 5 new") so nothing asked for is hidden by the fold.
    if (window.LIBRARY_COLLAPSE) {
      const n30 = withRecent ? LIBRARY_RECENT.count30() : 0;
      LIBRARY_COLLAPSE.setCount('lib-shelf', [toRead ? `${toRead} to read` : '', n30 ? `${n30} new in 30 days` : ''].filter(Boolean).join(' · '));
    }
  }

  function _rerender() { render(_lastState); }

  // ---- pins ---------------------------------------------------------------

  function isPinned(id) {
    const prefs = _prefs();
    return !!(prefs && Array.isArray(prefs.pinned_papers) && prefs.pinned_papers.includes(id));
  }

  function togglePin(id) {
    if (!_authed()) {
      _toast('Sign in to pin papers — pins are saved to your account.', 'error');
      return;
    }
    _savePrefs(next => {
      const set = new Set(next.pinned_papers || []);
      if (set.has(id)) set.delete(id); else set.add(id);
      next.pinned_papers = Array.from(set);
    });
    _changed();
  }

  // ---- group CRUD ---------------------------------------------------------

  function _findUserGroup(gid) {
    const prefs = _prefs();
    return ((prefs && prefs.paper_groups) || []).find(g => g.id === gid) || null;
  }

  function _findSharedGroup(gid) {
    return _shared.find(g => g.id === gid) || null;
  }

  async function _promptName(title, initial) {
    if (window.RM_DIALOG && RM_DIALOG.prompt) {
      return RM_DIALOG.prompt({ title, placeholder: 'Group name', value: initial || '', okText: 'Save' });
    }
    return window.prompt(title, initial || '');
  }

  function createSmartGroup(name, query) {
    if (!_authed()) {
      _toast('Sign in to save groups.', 'error');
      return;
    }
    _savePrefs(next => {
      next.paper_groups = next.paper_groups || [];
      next.paper_groups.push({ id: _genId(), name, kind: 'smart', query });
    });
    _collapsed.groups = false;   // reveal the section so the new group is visible (V3.826: folded is the default)
    _persistCollapsed();
    _changed();
  }

  async function _createManualGroup() {
    if (!_authed()) {
      _toast('Sign in to create groups.', 'error');
      return;
    }
    const name = await _promptName('New paper group');
    if (!name || !name.trim()) return;
    _savePrefs(next => {
      next.paper_groups = next.paper_groups || [];
      next.paper_groups.push({ id: _genId(), name: name.trim(), kind: 'manual', paper_ids: [] });
    });
    _changed();
  }

  async function _createLabGroup() {
    if (!(_cb && _cb.isAdmin && _cb.isAdmin())) return;
    const name = await _promptName('New lab-shared group (everyone sees it)');
    if (!name || !name.trim()) return;
    _shared.push({ id: _genId(), name: name.trim(), kind: 'manual', paper_ids: [] });
    await _saveShared();
    _changed();
  }

  async function _renameGroup(gid) {
    const shared = _findSharedGroup(gid);
    const g = _findUserGroup(gid) || shared;
    if (!g) return;
    const name = await _promptName('Rename group', g.name || '');
    if (!name || !name.trim() || name.trim() === g.name) return;
    if (shared) {
      shared.name = name.trim();
      await _saveShared();
    } else {
      _savePrefs(next => {
        const t = (next.paper_groups || []).find(x => x.id === gid);
        if (t) t.name = name.trim();
      });
    }
    _changed();
  }

  async function _deleteGroup(gid) {
    const shared = _findSharedGroup(gid);
    const g = _findUserGroup(gid) || shared;
    if (!g) return;
    if (!window.confirm(`Delete group "${g.name}"? The papers themselves are untouched.`)) return;
    if (shared) {
      _shared = _shared.filter(x => x.id !== gid);
      await _saveShared();
    } else {
      _savePrefs(next => {
        next.paper_groups = (next.paper_groups || []).filter(x => x.id !== gid);
      });
    }
    delete _collapsed['g:' + gid];
    _persistCollapsed();
    _changed();
  }

  function _moveGroup(gid, delta) {
    _savePrefs(next => {
      const arr = next.paper_groups || [];
      const i = arr.findIndex(x => x.id === gid);
      const j = i + delta;
      if (i < 0 || j < 0 || j >= arr.length) return;
      const [g] = arr.splice(i, 1);
      arr.splice(j, 0, g);
    });
    _changed();
  }

  /* V3.622 — which groups hold this paper. MANUAL groups only (smart and
   * draft groups compute membership from the paper pool, which the reader
   * page doesn't carry). Powers the reader sidebar's Groups widget. */
  function groupsForPaper(paperId) {
    const out = [];
    const prefs = _prefs();
    for (const g of ((prefs && prefs.paper_groups) || [])) {
      if (g.kind === 'manual' && (g.paper_ids || []).includes(paperId)) {
        out.push({ id: g.id, name: g.name, shared: false });
      }
    }
    for (const g of _shared) {
      if (g.kind === 'manual' && (g.paper_ids || []).includes(paperId)) {
        out.push({ id: g.id, name: g.name, shared: true });
      }
    }
    return out;
  }

  function _removeFromGroup(gid, pid, isShared) {
    if (isShared) {
      const g = _findSharedGroup(gid);
      if (!g) return;
      g.paper_ids = (g.paper_ids || []).filter(id => id !== pid);
      _saveShared().then(_changed);
    } else {
      _savePrefs(next => {
        const g = (next.paper_groups || []).find(x => x.id === gid);
        if (g) g.paper_ids = (g.paper_ids || []).filter(id => id !== pid);
      });
      _changed();
    }
  }

  // ---- lab-shared groups (librarySharedGroups) ----------------------------

  async function loadShared() {
    try {
      const data = await api.load('library/shared_groups.json');
      _shared = (data && data.groups) || [];
      _sharedLoaded = true;
    } catch (e) {
      // Non-member / offline — shelf still works with user-only groups.
      console.warn('[library-groups] shared groups load failed:', e.message || e);
      _shared = [];
    }
  }

  async function _saveShared() {
    try {
      await api.save('library/shared_groups.json', { groups: _shared });
    } catch (e) {
      _toast(`Lab group save failed: ${e.message || e}`, 'error');
    }
  }

  // ---- modals -------------------------------------------------------------

  function _closeModal() {
    const m = document.getElementById('lg-modal');
    if (m) m.remove();
  }

  function _openModal(title, bodyHtml) {
    _closeModal();
    const overlay = document.createElement('div');
    overlay.id = 'lg-modal';
    overlay.className = 'lg-modal';
    overlay.innerHTML = `<div class="lg-modal-card">
      <div class="lg-modal-head">
        <h2>${_esc(title)}</h2>
        <button class="btn btn-sm" data-act="lg-modal-close">Done</button>
      </div>
      <div class="lg-modal-body">${bodyHtml}</div>
    </div>`;
    overlay.addEventListener('click', (e) => {
      if (e.target === overlay || e.target.closest('[data-act="lg-modal-close"]')) _closeModal();
    });
    document.body.appendChild(overlay);
    return overlay;
  }

  // 📁 row action — toggle this paper's membership in manual groups.
  // Changes apply immediately (checkbox = membership); "Done" just closes.
  function openGroupPicker(paperId) {
    if (!_authed()) {
      _toast('Sign in to use groups.', 'error');
      return;
    }
    // V3.622 — the picker also runs standalone on the reader page, where
    // no library.js callbacks are injected: fall back to firebridge for
    // the admin check (manual groups need only LIBRARY_PREFS + _shared).
    const admin = (_cb && _cb.isAdmin)
      ? !!_cb.isAdmin()
      : !!(window.firebridge && firebridge.isAdmin && firebridge.isAdmin());

    function _rowsHtml() {
      const prefs = _prefs();
      const mine = ((prefs && prefs.paper_groups) || []).filter(g => g.kind === 'manual');
      const shared = admin ? _shared.filter(g => g.kind === 'manual') : [];
      const row = (g, isShared) => `
        <label class="lg-pick-row">
          <input type="checkbox" data-pick-gid="${_esc(g.id)}" data-pick-shared="${isShared ? '1' : ''}"
            ${(g.paper_ids || []).includes(paperId) ? 'checked' : ''}>
          <span>${_esc(g.name)}</span>
          ${isShared ? '<span class="lg-badge lg-badge-lab">lab</span>' : ''}
        </label>`;
      let html = '';
      if (mine.length) html += `<div class="lg-pick-sec">Your groups</div>${mine.map(g => row(g, false)).join('')}`;
      if (shared.length) html += `<div class="lg-pick-sec">Lab groups (admin)</div>${shared.map(g => row(g, true)).join('')}`;
      if (!mine.length && !shared.length) {
        html += '<div class="lg-empty" style="padding:6px 0;">No manual groups yet — create one below. (Smart and draft groups compute their own membership.)</div>';
      }
      return html;
    }

    const overlay = _openModal('Add to groups', `
      <div id="lg-pick-rows">${_rowsHtml()}</div>
      <div class="lg-pick-new">
        <input type="text" id="lg-pick-new-name" placeholder="New group name…">
        <button class="btn btn-sm" data-act="lg-pick-create">＋ Create &amp; add</button>
      </div>
    `);

    overlay.addEventListener('change', (e) => {
      const cb = e.target.closest('[data-pick-gid]');
      if (!cb) return;
      const gid = cb.getAttribute('data-pick-gid');
      const isShared = cb.getAttribute('data-pick-shared') === '1';
      const on = cb.checked;
      if (isShared) {
        const g = _findSharedGroup(gid);
        if (!g) return;
        const set = new Set(g.paper_ids || []);
        if (on) set.add(paperId); else set.delete(paperId);
        g.paper_ids = Array.from(set);
        _saveShared().then(_changed);
      } else {
        _savePrefs(next => {
          const g = (next.paper_groups || []).find(x => x.id === gid);
          if (!g) return;
          const set = new Set(g.paper_ids || []);
          if (on) set.add(paperId); else set.delete(paperId);
          g.paper_ids = Array.from(set);
        });
        _changed();
      }
    });

    overlay.addEventListener('click', (e) => {
      if (!e.target.closest('[data-act="lg-pick-create"]')) return;
      const input = overlay.querySelector('#lg-pick-new-name');
      const name = (input && input.value || '').trim();
      if (!name) return;
      _savePrefs(next => {
        next.paper_groups = next.paper_groups || [];
        next.paper_groups.push({ id: _genId(), name, kind: 'manual', paper_ids: [paperId] });
      });
      if (input) input.value = '';
      const rows = overlay.querySelector('#lg-pick-rows');
      if (rows) rows.innerHTML = _rowsHtml();
      _changed();
    });
  }

  // ＋ From draft — one draft group per checked draft. Paper drafts only:
  // the id→title map (library.js _draftTitleById, from projects/papers.json)
  // doesn't cover grant drafts — same limitation as the V3.352 badge.
  function _openFromDraftPicker() {
    if (!_authed()) {
      _toast('Sign in to create groups.', 'error');
      return;
    }
    const titles = (_cb && _cb.getDraftTitles && _cb.getDraftTitles()) || {};
    const prefs = _prefs();
    const existing = new Set(((prefs && prefs.paper_groups) || [])
      .filter(g => g.kind === 'draft').map(g => g.draft_id));
    const ids = Object.keys(titles).sort((a, b) => (titles[a] || '').localeCompare(titles[b] || ''));
    if (!ids.length) {
      _toast('No paper drafts found — draft groups mirror papers linked to a draft.', 'info');
      return;
    }
    const rows = ids.map(did => `
      <label class="lg-pick-row">
        <input type="checkbox" data-draft-id="${_esc(did)}" ${existing.has(did) ? 'checked disabled' : ''}>
        <span>${_esc(titles[did] || did)}</span>
        ${existing.has(did) ? '<span class="lg-sec-hint">already a group</span>' : ''}
      </label>`).join('');
    const overlay = _openModal('Groups from drafts', `
      <div class="lg-pick-hint">Each checked draft becomes a group holding every paper linked to it (via the reader's "link to draft" picker). The group auto-updates as links change.</div>
      <div id="lg-draft-rows">${rows}</div>
      <div class="lg-pick-new"><button class="btn btn-sm" data-act="lg-draft-create">Create groups</button></div>
    `);
    overlay.addEventListener('click', (e) => {
      if (!e.target.closest('[data-act="lg-draft-create"]')) return;
      const checked = Array.from(overlay.querySelectorAll('[data-draft-id]:checked:not(:disabled)'))
        .map(el => el.getAttribute('data-draft-id'));
      if (!checked.length) { _closeModal(); return; }
      _savePrefs(next => {
        next.paper_groups = next.paper_groups || [];
        for (const did of checked) {
          next.paper_groups.push({ id: _genId(), name: titles[did] || did, kind: 'draft', draft_id: did });
        }
      });
      _closeModal();
      _changed();
    });
  }

  // ---- shelf event delegation ---------------------------------------------

  function _onShelfClick(ev) {
    const el = ev.target.closest('[data-act]');
    if (!el) return;
    const act = el.getAttribute('data-act');

    // Chip links navigate; everything else below mutates state.
    if (act === 'chip-remove') {
      ev.preventDefault();
      const pid = el.getAttribute('data-pid');
      const ctx = el.getAttribute('data-ctx');
      if (ctx === 'pin') togglePin(pid);
      else if (ctx === 'group') _removeFromGroup(el.getAttribute('data-gid'), pid, false);
      else if (ctx === 'shared-group') _removeFromGroup(el.getAttribute('data-gid'), pid, true);
      return;
    }
    if (act === 'sec-toggle') {
      const sec = el.getAttribute('data-sec');
      _collapsed[sec] = !_isSecCollapsed(sec);   // V3.826 — explicit, since the default is folded
      _persistCollapsed();
      _rerender();
      return;
    }
    if (act === 'grp-toggle') {
      const key = 'g:' + el.getAttribute('data-gid');
      if (_collapsed[key]) delete _collapsed[key]; else _collapsed[key] = true;
      _persistCollapsed();
      _rerender();
      return;
    }
    if (act === 'grp-up')       { _moveGroup(el.getAttribute('data-gid'), -1); return; }
    if (act === 'grp-down')     { _moveGroup(el.getAttribute('data-gid'), +1); return; }
    if (act === 'grp-rename')   { _renameGroup(el.getAttribute('data-gid')); return; }
    if (act === 'grp-del')      { _deleteGroup(el.getAttribute('data-gid')); return; }
    if (act === 'new-group')    { _createManualGroup(); return; }
    if (act === 'from-draft')   { _openFromDraftPicker(); return; }
    if (act === 'new-lab-group') { _createLabGroup(); return; }
  }

  // ---- init ---------------------------------------------------------------

  /* init(opts) — called once by library.js. opts:
   *   getPapers()        → visibility-filtered paper array (the table's pool)
   *   parseQuery(q)      → parsed search query   (library.js _parseQuery)
   *   matches(p, parsed) → boolean               (library.js _matches)
   *   isAdmin()          → boolean               (library.js _isAdminAny)
   *   getDraftTitles()   → {draftId: title}      (library.js _draftTitleById)
   *   onChanged()        → re-render the table + shelf after a mutation
   *   toast(msg, kind)   → library.js _toast
   */
  function init(opts) {
    _cb = opts || {};
    const host = document.getElementById('lib-groups-shelf');
    if (host) host.addEventListener('click', _onShelfClick);

    // Reader tabs live in localStorage — `storage` fires when the reader
    // (another tab) writes; visibilitychange catches same-browser return
    // trips where the event was missed.
    window.addEventListener('storage', (e) => {
      if (e.key === LP_TABS_KEY) _rerender();
    });
    document.addEventListener('visibilitychange', () => {
      if (document.visibilityState === 'visible') _rerender();
    });
  }

  window.LIBRARY_GROUPS = {
    init,
    render,
    loadShared,
    isPinned,
    togglePin,
    groupsForPaper,   // V3.622 — reader sidebar widget
    onChanged,        // V3.622 — external mutation listener
    openGroupPicker,
    createSmartGroup,
  };
})();
