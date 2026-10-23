/* admin-permissions.js — V3.63 admin matrix for workflow permissions.
 *
 * Two tabs (selected by ?tab=users|workflows on the page URL):
 *   1. Users × Pages
 *      - Rows: each `users/{uid}` profile (excluding admins).
 *      - Cols: every page in PAGE_REGISTRY, grouped by section.
 *      - Cells: <input type="checkbox"> reflecting whether the page is in
 *               that user's `userPermissions/{uid}.allowedPageIds`.
 *      - Save: batch-update userPermissions docs (set/merge if non-empty,
 *              delete if user clears every box).
 *
 *   2. Default Workflows × Pages — RETIRED V3.811. The tab is a pointer to
 *      rm/pages/admin-workflows.html (rm/js/admin-workflows.js), which edits
 *      the same labConfig/defaultWorkflows doc. The grid code below is kept
 *      inert (renderWorkflowGrid returns when its table is absent).
 *
 * The page is admin-gated via firebridge.gateAdmin(). Non-admin users see
 * the standard pending-access overlay. */

(function () {
  /* ── helpers ── */
  function escHtml(s) {
    return String(s == null ? '' : s)
      .replace(/&/g, '&amp;').replace(/</g, '&lt;')
      .replace(/>/g, '&gt;').replace(/"/g, '&quot;');
  }
  function db()    { return firebridge.db(); }

  /* ── state ── */
  var REG = window.PAGE_REGISTRY || { list: [], DEFAULT_WORKFLOWS: [] };
  var pages = REG.list.slice();         // ordered, used for column headers
  var users = [];                        // from users/* — populated on boot
  var defaultWorkflows = [];             // from labConfig/defaultWorkflows or seed
  var workflowDocExists = false;         // false → show seed prompt
  // pending edits: { type: 'user'|'workflow', key: <uid|workflowId>,
  //                  pageId: <id>, checked: bool }
  var pendingEdits = new Map();          // key = `${type}:${key}:${pageId}`
  var initialState = { user: new Map(), workflow: new Map(), tracking: new Map(), mentor: new Map(), caps: new Map() };
  // user → Set<pageId>; workflow → Set<pageId>; tracking → Map<slug, mode>;
  // mentor → Map<menteeUid, Set<mentorUid>>;
  // caps → Map<uid, Set<capId>> (V3.605 — userPermissions/{uid}.caps,
  // catalog in capability-registry.js)
  // V3.79 — bulk-action state for the Users × Pages tab.
  var selectedUsers = new Set();         // uids ticked via row-select checkboxes
  var bulkPages = new Set();             // pageIds ticked in the bulk-action bar
  // V3.228 — per-page tracking modes. Map<slug, 'tracked'|'never'|'admin'>.
  // Persisted to labConfig/pageTracking.modes; missing slugs default to 'tracked'.
  var trackingModes = new Map();
  // V3.243 — mentor assignments. menteeUid → Set<mentorUid> (the current,
  // pending-included view). Persisted to users/{menteeUid}.mentor_uids.
  var mentorAssignments = new Map();
  // Slugs whose row will be hard-skipped from rendering (page-time-tracker
  // also hard-skips these regardless of stored mode).
  var TRACKING_HARD_SKIP = { 'activity-overview': true };
  // V3.476 — Users × Pages redesign: role-grouped collapsible rows + density.
  // collapsedRoles persists which role sections the admin has collapsed;
  // densityPref toggles row padding. Both survive reloads via localStorage.
  var COLLAPSE_KEY = 'rm.permUsers.collapsedRoles';
  var DENSITY_KEY = 'rm.permUsers.density';
  var collapsedRoles = new Set();
  var densityPref = 'compact';
  function _loadUiPrefs() {
    try {
      var raw = localStorage.getItem(COLLAPSE_KEY);
      if (raw) { var arr = JSON.parse(raw); if (Array.isArray(arr)) collapsedRoles = new Set(arr); }
    } catch (_) { /* ignore */ }
    try {
      var d = localStorage.getItem(DENSITY_KEY);
      if (d === 'compact' || d === 'comfortable') densityPref = d;
    } catch (_) { /* ignore */ }
  }
  function _persistCollapsed() {
    try { localStorage.setItem(COLLAPSE_KEY, JSON.stringify(Array.from(collapsedRoles))); } catch (_) { /* ignore */ }
  }
  function _currentSearch() {
    return (document.getElementById('perm-search') || {}).value || '';
  }
  // V3.729 — category quick-filter pills (Users × Pages + Per-user tabs).
  // Keyed on users/{uid}.category (user-system.js CATEGORIES), NOT role —
  // role is the RM access gate (editor/contributor/guest) and says nothing
  // about whether someone is an undergrad or a high-schooler. 'grad' folds
  // in masters; 'guest' also matches anyone still on the guest ROLE, so a
  // high-school student who hasn't been promoted yet shows under both.
  var CATEGORY_PILLS = [
    { id: '',           label: 'All' },
    { id: 'grad',       label: 'Grad students' },
    { id: 'undergrad',  label: 'Undergrads' },
    { id: 'highschool', label: 'High school' },
    { id: 'guest',      label: 'Guests' },
  ];
  var _categoryFilter = '';
  function _userMatchesCategory(u, cat) {
    if (!cat) return true;
    if (!u) return false;
    var c = (u.category || '').toLowerCase();
    if (cat === 'grad') return c === 'grad' || c === 'masters';
    if (cat === 'guest') return c === 'guest' || (u.role || '') === 'guest';
    return c === cat;
  }
  function renderCategoryPills() {
    var host = document.getElementById('perm-category-pills');
    if (!host) return;
    host.innerHTML = CATEGORY_PILLS.map(function (p) {
      var n = p.id ? users.filter(function (u) { return _userMatchesCategory(u, p.id); }).length : users.length;
      return '<button type="button" class="perm-cat-pill' + (p.id === _categoryFilter ? ' active' : '') + '" data-cat="' + escHtml(p.id) + '">' +
        escHtml(p.label) + '<span class="perm-cat-pill-count">' + n + '</span></button>';
    }).join('');
    host.querySelectorAll('.perm-cat-pill').forEach(function (btn) {
      btn.addEventListener('click', function () {
        // Clicking the active pill clears it (back to All).
        _categoryFilter = (btn.dataset.cat === _categoryFilter) ? '' : btn.dataset.cat;
        host.querySelectorAll('.perm-cat-pill').forEach(function (b) { b.classList.toggle('active', b.dataset.cat === _categoryFilter); });
        applySearchFilter(_currentSearch());
        filterUserRail((document.getElementById('perm-user-rail-search') || {}).value || '');
      });
    });
  }
  // V3.477 — Per-user tab state. selectedPanelUid = the user shown in the
  // right panel; allPapers = lazy-loaded projects(type=paper) cache; palette
  // copied from pmr.js ASSIGNEE_COLORS (which is private to that module).
  var selectedPanelUid = null;
  var allPapers = null;
  var USER_RAIL_COLORS = ['#1e40af', '#16a34a', '#b45309', '#7c3aed', '#0e7490', '#be185d', '#15803d', '#92400e', '#1f2937'];
  var PAPER_ROLE_OPTS = [['none', 'Not on paper'], ['coauthor', 'Coauthor'], ['first', 'First author'], ['cofirst', 'Co-first author']];

  function setStatus(msg, kind) {
    var el = document.getElementById('perm-status');
    el.className = 'perm-status' + (kind ? ' ' + kind : '');
    el.textContent = msg || '';
  }

  /* ── boot ── */
  async function boot() {
    var gateRes = await firebridge.gateAdmin('manage workflow permissions');
    if (!gateRes || !gateRes.allowed) return;
    _loadUiPrefs();   // V3.476 — restore collapsed-role + density prefs
    document.getElementById('perm-gate').style.display = 'none';
    document.getElementById('perm-content').style.display = '';

    setStatus('Loading…');
    try {
      await Promise.all([loadUsers(), loadDefaultWorkflows(), loadAllUserPermissions(), loadTrackingConfig()]);
    } catch (err) {
      console.error('[admin-permissions] load failed:', err);
      setStatus('Load failed: ' + err.message, 'err');
      return;
    }

    // V3.811 — first-run seeding lives on admin-workflows.html now (its Save writes the doc).
    renderCategoryPills();   // V3.729 — before the grid so its first filter pass sees the pill state
    renderUserGrid();
    renderWorkflowGrid();
    renderTrackingList();
    renderMentorList();
    renderUserRail();   // V3.477 — per-user tab rail (panel loads on select)
    wireActions();
    setStatus('');
  }

  /* ── load data ── */

  async function loadUsers() {
    var snap = await db().collection('users').get();
    users = [];
    snap.forEach(function (d) {
      var data = d.data() || {};
      // Exclude admins (they bypass the matrix) and pure-guest profiles
      // that haven't been promoted (they shouldn't appear yet anyway).
      if (data.role === 'admin') return;
      var mentorUids = Array.isArray(data.mentor_uids) ? data.mentor_uids : [];
      users.push({
        uid: d.id,
        name: data.displayName || data.name || data.email || d.id.slice(0, 8),
        email: data.email || '',
        role: data.role || 'guest',
        // V3.476 — the implicit-baseline gate keys on `category === 'collaborator'`
        // (firebase-bridge canAccessPage), NOT role, so the tri-state cell
        // state can only be exact if we carry category through.
        category: data.category || '',
      });
      // V3.243 — seed initial mentor state from the users/* read so the
      // Mentors tab doesn't need an extra fetch.
      initialState.mentor.set(d.id, new Set(mentorUids));
      mentorAssignments.set(d.id, new Set(mentorUids));
    });
    sortUsers();
  }

  /* V3.79 / V3.476 — sort the users list. Role is ALWAYS the primary key now
   * (role grouping is the permanent structure in the redesigned matrix), so
   * the dropdown only picks the WITHIN-role secondary key (name | email). */
  function sortUsers() {
    // V3.729 — 'editor' / 'contributor' are the roles users ACTUALLY carry
    // (user-system.js ROLES); without them here every unranked role tied and
    // the name sort interleaved roles, so the matrix built a fresh group
    // header at every role change (duplicate "editor" sections).
    var ROLE_ORDER = ['admin', 'pi', 'postdoc', 'editor', 'phd', 'masters', 'undergrad', 'contributor', 'staff', 'collaborator', 'member', 'guest'];
    var rank = function (role) {
      var idx = ROLE_ORDER.indexOf((role || '').toLowerCase());
      return idx >= 0 ? idx : ROLE_ORDER.length;
    };
    var mode = (document.getElementById('perm-user-sort') || {}).value || 'name';
    users.sort(function (a, b) {
      var rA = rank(a.role), rB = rank(b.role);
      if (rA !== rB) return rA - rB;
      if (mode === 'email') return (a.email || '').localeCompare(b.email || '');
      return (a.name || '').localeCompare(b.name || '');
    });
  }

  async function loadDefaultWorkflows() {
    try {
      var snap = await db().collection('labConfig').doc('defaultWorkflows').get();
      if (snap.exists) {
        var data = snap.data() || {};
        var arr = Array.isArray(data.workflows) ? data.workflows : [];
        if (arr.length) {
          defaultWorkflows = arr.map(function (w) { return Object.assign({}, w); });
          workflowDocExists = true;
          return;
        }
      }
    } catch (err) {
      console.warn('[admin-permissions] defaults read failed (using seed):', err.message);
    }
    // Fall back to seed.
    defaultWorkflows = (REG.DEFAULT_WORKFLOWS || []).map(function (w) {
      return Object.assign({}, w, { pageIds: (w.pageIds || []).slice() });
    });
    workflowDocExists = false;
  }

  async function loadAllUserPermissions() {
    try {
      var snap = await db().collection('userPermissions').get();
      snap.forEach(function (d) {
        var data = d.data() || {};
        var ids = Array.isArray(data.allowedPageIds) ? data.allowedPageIds : [];
        initialState.user.set(d.id, new Set(ids));
        // V3.605 — per-user elevated capabilities live on the same doc.
        var caps = Array.isArray(data.caps) ? data.caps : [];
        if (caps.length) initialState.caps.set(d.id, new Set(caps));
      });
    } catch (err) {
      console.warn('[admin-permissions] userPermissions read failed:', err.message);
    }
    // Workflow initial state from current defaults
    defaultWorkflows.forEach(function (wf) {
      initialState.workflow.set(wf.id, new Set(wf.pageIds || []));
    });
  }

  /* ── grid renderers ── */

  function pageColumns() {
    // Group columns by section so the header is readable. Keep page order.
    return pages;
  }

  function renderHeaderRow(table, firstColLabel) {
    var thead = table.tHead || table.createTHead();
    thead.innerHTML = '';
    var row = thead.insertRow();
    var firstTh = document.createElement('th');
    firstTh.textContent = firstColLabel;
    row.appendChild(firstTh);
    var lastGroup = null;
    pageColumns().forEach(function (p) {
      var th = document.createElement('th');
      th.title = p.id;
      var groupChange = (p.group !== lastGroup);
      if (groupChange) th.classList.add('group-start');
      lastGroup = p.group;
      th.innerHTML =
        (groupChange ? '<div class="col-group">' + escHtml(p.group) + '</div>' : '') +
        '<div>' + escHtml(p.label) + '</div>';
      row.appendChild(th);
    });
  }

  function renderUserGrid() {
    sortUsers();
    var table = document.getElementById('perm-grid-users');
    renderHeaderRow(table, 'User');
    // V3.79 — header for the new leftmost selection column. We still
    // keep "User" as the row-label column header; insert a select-all
    // checkbox in the User cell itself.
    var tbody = table.tBodies[0] || table.createTBody();
    tbody.innerHTML = '';
    if (!users.length) {
      var tr = tbody.insertRow();
      var td = tr.insertCell();
      td.colSpan = 1 + pages.length;
      td.className = 'perm-empty';
      td.textContent = 'No non-admin users found in users/* collection.';
      return;
    }
    // V3.476 — tally role counts for the collapsible group headers.
    var roleCounts = {};
    users.forEach(function (u) { roleCounts[u.role] = (roleCounts[u.role] || 0) + 1; });
    var lastRole = null;
    users.forEach(function (u) {
      // V3.476 — role-group header before the first user of each role.
      if (u.role !== lastRole) {
        buildGroupHeaderRow(tbody, u.role, roleCounts[u.role] || 0);
        lastRole = u.role;
      }
      var tr = tbody.insertRow();
      tr.dataset.uid = u.uid;
      tr.dataset.role = u.role;   // V3.476 — group membership for collapse/filter
      var th = document.createElement('th');
      th.scope = 'row';
      var roleTag = u.role ? '<span class="perm-role-tag perm-role-' + escHtml(u.role) + '">' + escHtml(u.role) + '</span>' : '';
      th.innerHTML =
        '<label class="perm-user-label">' +
        '  <input type="checkbox" class="perm-user-select" data-uid="' + escHtml(u.uid) + '"' +
            (selectedUsers.has(u.uid) ? ' checked' : '') + '>' +
        '  <span>' +
        '    <div class="perm-user-name">' + escHtml(u.name) + ' ' + roleTag + '</div>' +
        '    <div class="row-label-sub">' + escHtml(u.email || u.role) + '</div>' +
        '  </span>' +
        '</label>';
      th.querySelector('.perm-user-select').addEventListener('change', onUserSelectToggle);
      tr.appendChild(th);
      var lastGroup = null;
      pageColumns().forEach(function (p) {
        var td = document.createElement('td');
        td.className = 'perm-cell';
        if (p.group !== lastGroup) td.classList.add('group-start');
        lastGroup = p.group;
        var cb = document.createElement('input');
        cb.type = 'checkbox';
        cb.dataset.uid = u.uid;
        cb.dataset.pageId = p.id;
        cb.addEventListener('change', onUserCellChange);
        td.appendChild(cb);
        tr.appendChild(td);
      });
      // V3.476 — set grant/baseline/none state (also sets cb.checked).
      refreshRowStates(tr);
    });
    applyDensity();
    refreshBulkBar();
    // V3.476 — apply collapse state + any active filter in one pass.
    applySearchFilter(_currentSearch());
  }

  /* V3.476 — a collapsible role-section header row spanning the whole grid. */
  function buildGroupHeaderRow(tbody, role, count) {
    var tr = tbody.insertRow();
    tr.className = 'perm-group-row';
    tr.dataset.role = role;
    if (collapsedRoles.has(role)) tr.classList.add('is-collapsed');
    var th = document.createElement('th');
    th.className = 'perm-group-head';
    th.colSpan = 1 + pages.length;
    var roleTag = '<span class="perm-role-tag perm-role-' + escHtml(role) + '">' + escHtml(role || 'unranked') + '</span>';
    th.innerHTML =
      '<span class="perm-group-head-inner">' +
      '<span class="perm-group-toggle" aria-hidden="true">' + ICON.svg('chevron-down') + '</span>' +
      roleTag +
      '<span class="perm-group-count">' + count + ' user' + (count === 1 ? '' : 's') + '</span>' +
      '</span>';
    th.addEventListener('click', function () { toggleGroup(role); });
    tr.appendChild(th);
  }

  /* V3.476 — recompute a row's tri-state cells from initialState + pending.
   * Whole-row because one toggle can flip the row between whitelist mode
   * (has an explicit grant → non-granted pages read as "none") and baseline
   * mode (no grant → default-workflow pages read as "baseline"). Mirrors
   * firebridge.canAccessPage: explicit grant wins; else implicit baseline
   * unless the user is a collaborator (category), who gets no baseline. */
  function refreshRowStates(tr) {
    var uid = tr.dataset.uid;
    if (!uid) return;
    var u = null;
    for (var i = 0; i < users.length; i++) { if (users[i].uid === uid) { u = users[i]; break; } }
    var effective = new Set(initialState.user.get(uid) || []);
    pendingEdits.forEach(function (edit) {
      if (edit.type !== 'user' || edit.key !== uid) return;
      if (edit.checked) effective.add(edit.pageId);
      else effective.delete(edit.pageId);
    });
    var hasGrant = effective.size > 0;
    var isCollab = !!(u && u.category === 'collaborator');
    var baseline = (REG && REG.defaultPageIdSet) ? REG.defaultPageIdSet : null;
    tr.querySelectorAll('td.perm-cell input[type="checkbox"]').forEach(function (cb) {
      var pid = cb.dataset.pageId;
      var state;
      if (effective.has(pid)) state = 'grant';
      else if (!hasGrant && !isCollab && baseline && baseline.has(pid)) state = 'baseline';
      else state = 'none';
      cb.parentElement.dataset.state = state;
      cb.checked = (state === 'grant');
      cb.indeterminate = (state === 'baseline');
    });
  }

  /* V3.476 — collapse/expand a role section; persists + re-applies filter. */
  function toggleGroup(role) {
    if (collapsedRoles.has(role)) collapsedRoles.delete(role);
    else collapsedRoles.add(role);
    _persistCollapsed();
    var hdr = document.querySelector('#perm-grid-users .perm-group-row[data-role="' + cssEscape(role) + '"]');
    if (hdr) hdr.classList.toggle('is-collapsed', collapsedRoles.has(role));
    applySearchFilter(_currentSearch());
  }

  /* V3.476 — row-density toggle (persisted). */
  function applyDensity() {
    var grid = document.getElementById('perm-grid-users');
    if (grid) {
      grid.classList.remove('is-compact', 'is-comfortable');
      grid.classList.add(densityPref === 'comfortable' ? 'is-comfortable' : 'is-compact');
    }
    var sel = document.getElementById('perm-user-density');
    if (sel && sel.value !== densityPref) sel.value = densityPref;
  }
  function onDensityToggle(e) {
    densityPref = (e.target.value === 'comfortable') ? 'comfortable' : 'compact';
    try { localStorage.setItem(DENSITY_KEY, densityPref); } catch (_) { /* ignore */ }
    applyDensity();
  }

  /* V3.79 — Users × Pages bulk-action bar. Visible whenever ≥1 user is
   * selected. Lets admin grant or revoke a set of pages for all
   * selected users in one click. */
  function refreshBulkBar() {
    var bar = document.getElementById('perm-bulk-bar');
    if (!bar) return;
    if (window.__PERM_TAB !== 'users') { bar.style.display = 'none'; return; }
    var n = selectedUsers.size;
    if (n === 0) { bar.style.display = 'none'; return; }
    bar.style.display = '';
    bar.querySelector('.perm-bulk-count').textContent = n + ' user' + (n === 1 ? '' : 's') + ' selected';
    // Build / refresh the page chip picker.
    var picker = bar.querySelector('.perm-bulk-pages');
    if (!picker.dataset.built) {
      picker.innerHTML = '';
      pageColumns().forEach(function (p) {
        var chip = document.createElement('label');
        chip.className = 'perm-bulk-chip';
        chip.title = p.group + ' · ' + p.label;
        chip.innerHTML =
          '<input type="checkbox" data-page-id="' + escHtml(p.id) + '">' +
          '<span class="perm-bulk-chip-grp">' + escHtml(p.group) + '</span>' +
          '<span>' + escHtml(p.label) + '</span>';
        chip.querySelector('input').addEventListener('change', onBulkPageToggle);
        picker.appendChild(chip);
      });
      picker.dataset.built = '1';
    }
    // Sync chip checked state from bulkPages.
    picker.querySelectorAll('input[data-page-id]').forEach(function (cb) {
      cb.checked = bulkPages.has(cb.dataset.pageId);
      cb.parentElement.classList.toggle('on', cb.checked);
    });
    bar.querySelector('.perm-bulk-pages-count').textContent =
      bulkPages.size ? bulkPages.size + ' page' + (bulkPages.size === 1 ? '' : 's') : 'no pages';
  }

  function onUserSelectToggle(e) {
    var uid = e.target.dataset.uid;
    if (!uid) return;
    if (e.target.checked) selectedUsers.add(uid);
    else selectedUsers.delete(uid);
    refreshBulkBar();
  }
  function onBulkPageToggle(e) {
    var pid = e.target.dataset.pageId;
    if (!pid) return;
    if (e.target.checked) bulkPages.add(pid);
    else bulkPages.delete(pid);
    e.target.parentElement.classList.toggle('on', e.target.checked);
    refreshBulkBar();
  }
  function onBulkSelectAll() {
    // V3.476 — "Select all" respects collapse + filter: only currently
    // visible rows are added (individual selections persist across collapse).
    document.querySelectorAll('#perm-grid-users tbody tr').forEach(function (tr) {
      if (tr.classList.contains('perm-group-row')) return;
      if (!tr.dataset.uid || tr.style.display === 'none') return;
      selectedUsers.add(tr.dataset.uid);
      var cb = tr.querySelector('.perm-user-select');
      if (cb) cb.checked = true;
    });
    refreshBulkBar();
  }
  function onBulkClearSelection() {
    selectedUsers.clear();
    document.querySelectorAll('.perm-user-select').forEach(function (cb) { cb.checked = false; });
    refreshBulkBar();
  }
  function onBulkClearPages() {
    bulkPages.clear();
    refreshBulkBar();
  }
  /* Apply the chip selection to all selected users. mode='grant' adds
   * the pages to each user; mode='revoke' removes them. We mutate the
   * matrix DOM by checking/unchecking each cell + firing the existing
   * onUserCellChange so the pendingEdits map stays the source of truth. */
  function onBulkApply(mode) {
    if (!selectedUsers.size) { setStatus('Pick one or more users first.', 'err'); return; }
    if (!bulkPages.size)     { setStatus('Pick one or more pages.', 'err'); return; }
    var changed = 0;
    selectedUsers.forEach(function (uid) {
      bulkPages.forEach(function (pid) {
        var cb = document.querySelector('input[type="checkbox"][data-uid="' + cssEscape(uid) + '"][data-page-id="' + cssEscape(pid) + '"]');
        if (!cb) return;
        var want = (mode === 'grant');
        if (cb.checked === want) return;
        cb.checked = want;
        cb.dispatchEvent(new Event('change', { bubbles: true }));
        changed += 1;
      });
    });
    setStatus(
      (mode === 'grant' ? 'Granted ' : 'Revoked ') +
      bulkPages.size + ' page' + (bulkPages.size === 1 ? '' : 's') +
      ' across ' + selectedUsers.size + ' user' + (selectedUsers.size === 1 ? '' : 's') +
      ' (' + changed + ' cell' + (changed === 1 ? '' : 's') + ' changed). Click Save to persist.',
      changed > 0 ? 'ok' : ''
    );
  }
  function cssEscape(s) {
    return (window.CSS && CSS.escape) ? CSS.escape(s) : String(s).replace(/[^a-zA-Z0-9_-]/g, function (c) { return '\\' + c; });
  }

  function renderWorkflowGrid() {
    var table = document.getElementById('perm-grid-workflows');
    if (!table) return;        // V3.811 — the matrix moved to admin-workflows.html; the tab is a pointer now
    renderHeaderRow(table, 'Default workflow');
    var tbody = table.tBodies[0] || table.createTBody();
    tbody.innerHTML = '';
    if (!defaultWorkflows.length) {
      var tr = tbody.insertRow();
      var td = tr.insertCell();
      td.colSpan = 1 + pages.length;
      td.className = 'perm-empty';
      td.textContent = 'No default workflows. Click "Seed defaults" above.';
      return;
    }
    defaultWorkflows.forEach(function (wf) {
      tbody.appendChild(buildWorkflowRow(wf));
    });

    // V3.77 — Add-new-workflow row. Pinned to the bottom; admin types
    // a name/icon, hits Add, the new workflow appears as a regular
    // editable row above. New workflow has no checked pages yet —
    // admin checks pages and saves.
    var addTr = tbody.insertRow();
    addTr.className = 'perm-add-row';
    addTr.dataset.role = 'add-workflow';
    var addTh = document.createElement('th');
    addTh.scope = 'row';
    addTh.innerHTML =
      '<div style="display:flex;flex-direction:column;gap:4px;">' +
      '  <div style="font-size:11px;text-transform:uppercase;letter-spacing:.3px;color:#9ca3af;font-weight:600;">Add a workflow</div>' +
      '  <div style="display:flex;gap:4px;align-items:center;">' +
      '    <input type="text" class="perm-add-icon"  placeholder="folder" maxlength="40" title="Icon — type an icon name (see /rm/pages/icon-audit.html)." style="width:92px;text-align:center;font-size:13px;padding:3px 4px;border:1px solid #d1d5db;border-radius:4px;">' +
      '    <input type="text" class="perm-add-name"  placeholder="Workflow name" style="flex:1;min-width:0;font-size:12px;padding:3px 6px;border:1px solid #d1d5db;border-radius:4px;">' +
      '  </div>' +
      '  <input type="text" class="perm-add-desc" placeholder="Short description (optional)" style="font-size:11px;padding:3px 6px;border:1px solid #d1d5db;border-radius:4px;">' +
      '  <button class="btn btn-primary btn-sm perm-add-btn" type="button" style="font-size:11px;padding:3px 10px;">+ Add workflow</button>' +
      '</div>';
    addTr.appendChild(addTh);
    var addColspan = pageColumns().length;
    var spanCell = document.createElement('td');
    spanCell.colSpan = addColspan;
    spanCell.style.color = '#9ca3af';
    spanCell.style.fontSize = '12px';
    spanCell.style.fontStyle = 'italic';
    spanCell.style.padding = '12px 10px';
    spanCell.textContent = 'New workflows start with no pages — check the boxes above after adding.';
    addTr.appendChild(spanCell);
    addTr.querySelector('.perm-add-btn').addEventListener('click', onAddWorkflow);
  }

  /* V3.77 — Build one editable row for a default workflow. The row's
   * label cell has inline inputs for icon, name, description, plus the
   * landing-page select (V3.66) and a delete button. Cell columns
   * remain checkboxes for page membership. */
  function buildWorkflowRow(wf) {
    var tr = document.createElement('tr');
    tr.dataset.workflowId = wf.id;
    var th = document.createElement('th');
    th.scope = 'row';
    th.innerHTML =
      '<div class="perm-wf-meta">' +
      '  <div class="perm-wf-row1">' +
      '    <input type="text" class="perm-wf-icon" data-workflow-id="' + escHtml(wf.id) + '" data-field="icon" maxlength="40" value="' + escHtml(wf.icon || '') + '" placeholder="folder" title="Icon — type an icon name (see /rm/pages/icon-audit.html). Saved values are never rewritten.">' +
      '    <input type="text" class="perm-wf-name" data-workflow-id="' + escHtml(wf.id) + '" data-field="label" value="' + escHtml(wf.label || '') + '" placeholder="Workflow name" title="Workflow display name">' +
      '    <button type="button" class="perm-wf-del" data-workflow-id="' + escHtml(wf.id) + '" title="Delete this workflow">' + ICON.svg('x-mark') + '</button>' +
      '  </div>' +
      '  <input type="text" class="perm-wf-desc" data-workflow-id="' + escHtml(wf.id) + '" data-field="description" value="' + escHtml(wf.description || '') + '" placeholder="Short description (shown on the chooser card)" title="Description shown on the workflow chooser card">' +
      '  <div class="row-label-sub" style="font-family:ui-monospace,Menlo,monospace;">' + escHtml(wf.id) + '</div>' +
      '  <div class="row-label-sub" style="margin-top:2px;">' +
      '    <label style="font-size:10px;color:#9ca3af;text-transform:uppercase;letter-spacing:.3px;display:block;margin-bottom:2px;">Landing</label>' +
      '    <select class="perm-landing-select" data-workflow-id="' + escHtml(wf.id) + '" style="font-size:11px;padding:2px 4px;max-width:160px;">' +
      '      <option value="">First page</option>' +
      '    </select>' +
      '  </div>' +
      '</div>';
    tr.appendChild(th);

    var pageSet = new Set(wf.pageIds || []);
    var lastGroup = null;
    pageColumns().forEach(function (p) {
      var td = document.createElement('td');
      td.className = 'perm-cell';
      if (p.group !== lastGroup) td.classList.add('group-start');
      lastGroup = p.group;
      var cb = document.createElement('input');
      cb.type = 'checkbox';
      cb.checked = pageSet.has(p.id);
      cb.dataset.workflowId = wf.id;
      cb.dataset.pageId = p.id;
      cb.addEventListener('change', onWorkflowCellChange);
      td.appendChild(cb);
      tr.appendChild(td);
    });

    // Wire meta inputs: icon, name, description.
    th.querySelectorAll('input.perm-wf-icon, input.perm-wf-name, input.perm-wf-desc').forEach(function (inp) {
      inp.addEventListener('input', onWorkflowMetaChange);
    });
    // Delete button.
    th.querySelector('.perm-wf-del').addEventListener('click', function () {
      onDeleteWorkflow(wf.id);
    });
    // Landing-page select.
    var sel = th.querySelector('.perm-landing-select');
    refreshLandingSelect(sel, wf);
    sel.value = wf.landingPageId || '';
    sel.addEventListener('change', onWorkflowLandingChange);

    return tr;
  }

  /* Rebuild the option list of a workflow's landing select to reflect
   * its current pageIds. Called on initial render and after any cell
   * toggle that changes the workflow's page set. */
  function refreshLandingSelect(sel, wf) {
    var current = sel.value;
    sel.innerHTML = '<option value="">First page</option>';
    (wf.pageIds || []).forEach(function (id) {
      var p = (window.PAGE_REGISTRY && window.PAGE_REGISTRY.byId.get(id));
      if (!p) return;
      var opt = document.createElement('option');
      opt.value = id;
      opt.textContent = p.group + ' · ' + p.label;
      sel.appendChild(opt);
    });
    if (current && (wf.pageIds || []).indexOf(current) >= 0) sel.value = current;
    else if (wf.landingPageId && (wf.pageIds || []).indexOf(wf.landingPageId) >= 0) {
      sel.value = wf.landingPageId;
    } else {
      sel.value = '';
    }
  }

  /* ── V3.228 page tracking config ── */

  /* Derive the page-time-tracker's slug from a page-registry href. The
   * tracker keys its docs by location.pathname slug ('/rm/pages/foo.html'
   * → 'foo', '/rm/index.html' → 'dashboard'), and is unaware of ?tab=…
   * variants. So we collapse tab-suffixed registry entries (e.g.
   * `activity-overview__tab__tracker`) into their base slug. */
  function trackerSlugForHref(href) {
    if (!href) return '';
    if (href === '/rm/index.html' || href === '/rm/' || href === '/') return 'dashboard';
    var m = href.match(/^\/rm\/pages\/([a-z0-9-]+)\.html/);
    return m ? m[1].toLowerCase() : '';
  }

  /* Walk PAGE_REGISTRY.list once, collapse to base slug, preserve first-
   * occurrence label + group. Returns ordered array of
   * { slug, label, group } — what the tracking tab renders. */
  function distinctTrackingPages() {
    var out = [];
    var seen = new Set();
    pages.forEach(function (p) {
      var slug = trackerSlugForHref(p.href);
      if (!slug) return;
      if (TRACKING_HARD_SKIP[slug]) return;
      if (seen.has(slug)) return;
      seen.add(slug);
      // For tab-suffixed registry entries, prefer the base label.
      var label = p.id.indexOf('__tab__') >= 0
        ? p.label.replace(/\s*[—–·]\s*.+$/, '').trim() || p.label
        : p.label;
      out.push({ slug: slug, label: label, group: p.group });
    });
    return out;
  }

  async function loadTrackingConfig() {
    try {
      var snap = await db().collection('labConfig').doc('pageTracking').get();
      if (snap.exists) {
        var data = snap.data() || {};
        var modes = data.modes || {};
        Object.keys(modes).forEach(function (slug) {
          var m = modes[slug];
          if (m === 'tracked' || m === 'never' || m === 'admin') {
            trackingModes.set(slug, m);
            initialState.tracking.set(slug, m);
          }
        });
      }
    } catch (err) {
      console.warn('[admin-permissions] pageTracking read failed:', err.message);
    }
  }

  function renderTrackingList() {
    var host = document.getElementById('perm-tracking-list');
    if (!host) return;
    host.innerHTML = '';
    var rows = distinctTrackingPages();
    if (!rows.length) {
      host.innerHTML = '<div class="perm-empty">No pages in the registry yet.</div>';
      return;
    }
    var lastGroup = null;
    rows.forEach(function (row) {
      if (row.group !== lastGroup) {
        var head = document.createElement('div');
        head.className = 'perm-tracking-group-head';
        head.textContent = row.group || '—';
        host.appendChild(head);
        lastGroup = row.group;
      }
      var r = document.createElement('div');
      r.className = 'perm-tracking-row';
      r.dataset.slug = row.slug;
      var current = trackingModes.get(row.slug) || 'tracked';
      r.innerHTML =
        '<div class="perm-tracking-label">' +
        '  <div class="perm-tracking-name">' + escHtml(row.label) + '</div>' +
        '  <div class="perm-tracking-slug">' + escHtml(row.slug) + '</div>' +
        '</div>' +
        '<select class="perm-tracking-select" data-slug="' + escHtml(row.slug) + '">' +
        '  <option value="tracked"' + (current === 'tracked' ? ' selected' : '') + '>Tracked</option>' +
        '  <option value="never"'   + (current === 'never'   ? ' selected' : '') + '>Never</option>' +
        '  <option value="admin"'   + (current === 'admin'   ? ' selected' : '') + '>Admin work</option>' +
        '</select>';
      r.querySelector('select').addEventListener('change', onTrackingChange);
      host.appendChild(r);
    });
  }

  function onTrackingChange(e) {
    var slug = e.target.dataset.slug;
    if (!slug) return;
    var val = e.target.value;
    var initial = initialState.tracking.get(slug) || 'tracked';
    var key = 'tracking:' + slug;
    if (val === initial) {
      pendingEdits.delete(key);
    } else {
      pendingEdits.set(key, { type: 'tracking', slug: slug, mode: val });
    }
    trackingModes.set(slug, val);
    var row = e.target.closest('.perm-tracking-row');
    if (row) row.classList.toggle('is-changed', val !== initial);
    updatePendingStatus();
  }

  /* ── V3.243 mentor assignments ── */

  /* Render one row per non-admin lab member, showing their current mentor
   * chips + an "Add mentor" select. Save persists to
   * users/{menteeUid}.mentor_uids — see saveAll. */
  function renderMentorList() {
    var host = document.getElementById('perm-mentor-list');
    if (!host) return;
    host.innerHTML = '';
    if (!users.length) {
      host.innerHTML = '<div class="perm-empty">No non-admin users found.</div>';
      return;
    }
    // Sort: same default as Users × Pages (role then name).
    var ROLE_ORDER = ['pi', 'postdoc', 'phd', 'masters', 'undergrad', 'staff', 'collaborator', 'member', 'guest'];
    var rank = function (role) {
      var idx = ROLE_ORDER.indexOf((role || '').toLowerCase());
      return idx >= 0 ? idx : ROLE_ORDER.length;
    };
    var ordered = users.slice().sort(function (a, b) {
      var rA = rank(a.role), rB = rank(b.role);
      if (rA !== rB) return rA - rB;
      return (a.name || '').localeCompare(b.name || '');
    });
    ordered.forEach(function (mentee) {
      var row = document.createElement('div');
      row.className = 'perm-mentor-row';
      row.dataset.menteeUid = mentee.uid;
      var current = mentorAssignments.get(mentee.uid) || new Set();
      var initial = initialState.mentor.get(mentee.uid) || new Set();
      if (!setEq(current, initial)) row.classList.add('is-changed');

      var menteeBox = document.createElement('div');
      menteeBox.className = 'perm-mentor-mentee';
      var roleTag = mentee.role
        ? '<span class="perm-role-tag perm-role-' + escHtml(mentee.role) + '">' + escHtml(mentee.role) + '</span>'
        : '';
      menteeBox.innerHTML =
        '<div class="perm-mentor-name">' + escHtml(mentee.name) + ' ' + roleTag + '</div>' +
        '<div class="perm-mentor-email">' + escHtml(mentee.email || mentee.uid) + '</div>';
      row.appendChild(menteeBox);

      var chips = document.createElement('div');
      chips.className = 'perm-mentor-chips';
      if (!current.size) {
        var empty = document.createElement('span');
        empty.className = 'perm-mentor-empty';
        empty.textContent = 'no mentors assigned';
        chips.appendChild(empty);
      } else {
        // Sort chips by name for stability.
        var mentorRows = Array.from(current).map(function (uid) {
          var u = users.find(function (x) { return x.uid === uid; });
          return { uid: uid, name: u ? u.name : uid.slice(0, 8) };
        }).sort(function (a, b) { return a.name.localeCompare(b.name); });
        mentorRows.forEach(function (m) {
          var chip = document.createElement('span');
          chip.className = 'perm-mentor-chip';
          chip.innerHTML =
            escHtml(m.name) +
            ' <button type="button" class="perm-mentor-chip-x" ' +
              'data-mentee-uid="' + escHtml(mentee.uid) + '" ' +
              'data-mentor-uid="' + escHtml(m.uid) + '" ' +
              'title="Remove mentor">' + ICON.svg('x-mark') + '</button>';
          chips.appendChild(chip);
        });
      }
      row.appendChild(chips);

      // Picker: every other non-admin user not already assigned + not the
      // mentee themselves.
      var sel = document.createElement('select');
      sel.className = 'perm-mentor-add';
      sel.dataset.menteeUid = mentee.uid;
      sel.innerHTML = '<option value="">+ Add mentor…</option>';
      users.forEach(function (candidate) {
        if (candidate.uid === mentee.uid) return;
        if (current.has(candidate.uid)) return;
        var opt = document.createElement('option');
        opt.value = candidate.uid;
        opt.textContent = candidate.name + (candidate.role ? ' (' + candidate.role + ')' : '');
        sel.appendChild(opt);
      });
      sel.addEventListener('change', onMentorAdd);
      row.appendChild(sel);

      // Wire chip × buttons.
      Array.prototype.forEach.call(chips.querySelectorAll('.perm-mentor-chip-x'), function (btn) {
        btn.addEventListener('click', onMentorRemove);
      });

      host.appendChild(row);
    });
  }

  function setEq(a, b) {
    if (a.size !== b.size) return false;
    var ok = true;
    a.forEach(function (v) { if (!b.has(v)) ok = false; });
    return ok;
  }

  function onMentorAdd(e) {
    var menteeUid = e.target.dataset.menteeUid;
    var mentorUid = e.target.value;
    if (!menteeUid || !mentorUid) return;
    var current = mentorAssignments.get(menteeUid) || new Set();
    current.add(mentorUid);
    mentorAssignments.set(menteeUid, current);
    syncMentorPendingEdit(menteeUid);
    renderMentorList();
    updatePendingStatus();
  }

  function onMentorRemove(e) {
    var menteeUid = e.target.dataset.menteeUid;
    var mentorUid = e.target.dataset.mentorUid;
    if (!menteeUid || !mentorUid) return;
    var current = mentorAssignments.get(menteeUid) || new Set();
    current.delete(mentorUid);
    mentorAssignments.set(menteeUid, current);
    syncMentorPendingEdit(menteeUid);
    renderMentorList();
    updatePendingStatus();
  }

  /* Recompute the single mentor-pending-edit row for this mentee. Empty if
   * current matches initial (no edit), otherwise stash the final list. */
  function syncMentorPendingEdit(menteeUid) {
    var current = mentorAssignments.get(menteeUid) || new Set();
    var initial = initialState.mentor.get(menteeUid) || new Set();
    var key = 'mentor:' + menteeUid;
    if (setEq(current, initial)) {
      pendingEdits.delete(key);
    } else {
      pendingEdits.set(key, {
        type: 'mentor',
        key: menteeUid,
        mentorUids: Array.from(current),
      });
    }
  }

  /* ── change tracking ── */

  function onUserCellChange(e) {
    var uid = e.target.dataset.uid;
    var pageId = e.target.dataset.pageId;
    var key = 'user:' + uid + ':' + pageId;
    var initial = (initialState.user.get(uid) || new Set()).has(pageId);
    var current = e.target.checked;
    if (current === initial) {
      pendingEdits.delete(key);
      e.target.parentElement.classList.remove('perm-cell-changed');
    } else {
      pendingEdits.set(key, { type: 'user', key: uid, pageId: pageId, checked: current });
      e.target.parentElement.classList.add('perm-cell-changed');
    }
    updatePendingStatus();
    // V3.476 — recompute the whole row: toggling one cell can flip the row
    // between whitelist and baseline mode, changing other cells' state.
    var tr = e.target.closest('tr');
    if (tr && tr.dataset.uid) refreshRowStates(tr);
  }

  function onWorkflowCellChange(e) {
    var wfId = e.target.dataset.workflowId;
    var pageId = e.target.dataset.pageId;
    var key = 'workflow:' + wfId + ':' + pageId;
    var initial = (initialState.workflow.get(wfId) || new Set()).has(pageId);
    var current = e.target.checked;
    if (current === initial) {
      pendingEdits.delete(key);
      e.target.parentElement.classList.remove('perm-cell-changed');
    } else {
      pendingEdits.set(key, { type: 'workflow', key: wfId, pageId: pageId, checked: current });
      e.target.parentElement.classList.add('perm-cell-changed');
    }
    // V3.66 — keep landing select in sync with the workflow's current pageIds.
    var wf = defaultWorkflows.find(function (w) { return w.id === wfId; });
    if (wf) {
      // Mirror cell state into wf.pageIds so refreshLandingSelect sees it.
      var s = new Set(wf.pageIds || []);
      if (current) s.add(pageId); else s.delete(pageId);
      wf.pageIds = Array.from(s);
      var sel = document.querySelector('select.perm-landing-select[data-workflow-id="' + wfId + '"]');
      if (sel) refreshLandingSelect(sel, wf);
    }
    updatePendingStatus();
  }

  /* V3.77 — workflow meta (icon / label / description) edit. Mutates the
   * in-memory wf record so subsequent renders reflect typed-but-unsaved
   * values; tracks one pending edit per (workflowId, field) so save only
   * fires when something actually changed vs the loaded baseline. */
  function onWorkflowMetaChange(e) {
    var wfId = e.target.dataset.workflowId;
    var field = e.target.dataset.field;
    if (!wfId || !field) return;
    var wf = defaultWorkflows.find(function (w) { return w.id === wfId; });
    if (!wf) return;
    if (wf._initialMeta == null) {
      wf._initialMeta = { icon: wf.icon || '', label: wf.label || '', description: wf.description || '' };
    }
    var val = e.target.value;
    var initial = wf._initialMeta[field] || '';
    var key = 'workflow-meta:' + wfId + ':' + field;
    if (val === initial) {
      pendingEdits.delete(key);
    } else {
      pendingEdits.set(key, { type: 'workflow-meta', key: wfId, field: field, value: val });
    }
    wf[field] = val;
    updatePendingStatus();
  }

  /* V3.77 — admin clicks "+ Add workflow" in the bottom row. Validates
   * inputs, slugifies the name to an id, ensures uniqueness, then
   * appends a fresh workflow record (no pages yet) and re-renders the
   * grid. The new workflow is automatically marked dirty via a
   * pending edit so Save will persist it even if admin saves before
   * editing further. */
  function onAddWorkflow() {
    var iconEl = document.querySelector('.perm-add-icon');
    var nameEl = document.querySelector('.perm-add-name');
    var descEl = document.querySelector('.perm-add-desc');
    var name = (nameEl.value || '').trim();
    if (!name) { nameEl.focus(); setStatus('Workflow needs a name.', 'err'); return; }
    var slug = name.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '');
    if (!slug) { nameEl.focus(); setStatus('Name must include letters or numbers.', 'err'); return; }
    if (defaultWorkflows.some(function (w) { return w.id === slug; })) {
      setStatus('A workflow with id "' + slug + '" already exists.', 'err');
      return;
    }
    var newWf = {
      id: slug,
      label: name,
      icon: (iconEl.value || '').trim() || 'folder',
      description: (descEl.value || '').trim(),
      landingPageId: '',
      pageIds: [],
    };
    newWf._initialMeta = { icon: '', label: '', description: '' };  // brand-new
    defaultWorkflows.push(newWf);
    initialState.workflow.set(slug, new Set());
    // Mark all three fields as pending so save flushes the doc.
    pendingEdits.set('workflow-meta:' + slug + ':icon',        { type: 'workflow-meta', key: slug, field: 'icon',        value: newWf.icon });
    pendingEdits.set('workflow-meta:' + slug + ':label',       { type: 'workflow-meta', key: slug, field: 'label',       value: newWf.label });
    pendingEdits.set('workflow-meta:' + slug + ':description', { type: 'workflow-meta', key: slug, field: 'description', value: newWf.description });
    iconEl.value = ''; nameEl.value = ''; descEl.value = '';
    renderWorkflowGrid();
    setStatus('Added "' + name + '" — toggle pages, set Landing, then Save.', 'ok');
    updatePendingStatus();
  }

  /* V3.77 — delete a workflow. Confirm first, then drop it from the
   * in-memory array. Save flushes the absence to Firestore. */
  function onDeleteWorkflow(wfId) {
    var wf = defaultWorkflows.find(function (w) { return w.id === wfId; });
    if (!wf) return;
    if (!confirm('Delete the "' + (wf.label || wfId) + '" default workflow? This removes it for ALL users on the next Save.')) return;
    defaultWorkflows = defaultWorkflows.filter(function (w) { return w.id !== wfId; });
    initialState.workflow.delete(wfId);
    // Drop any pending edits scoped to this workflow.
    Array.from(pendingEdits.keys()).forEach(function (k) {
      if (k.endsWith(':' + wfId)
          || k === 'workflow-landing:' + wfId
          || k.indexOf('workflow:' + wfId + ':') === 0
          || k.indexOf('workflow-meta:' + wfId + ':') === 0) {
        pendingEdits.delete(k);
      }
    });
    // Mark the doc dirty so save fires (uses a sentinel pending edit).
    pendingEdits.set('workflow-deleted:' + wfId, { type: 'workflow-deleted', key: wfId });
    renderWorkflowGrid();
    setStatus('Deleted "' + (wf.label || wfId) + '" — Save to persist.', 'ok');
    updatePendingStatus();
  }

  /* V3.66 — landing-page select change. Stores per-workflow pending edit
   * with type='workflow-landing'. Save flushes to the doc's landingPageId. */
  function onWorkflowLandingChange(e) {
    var wfId = e.target.dataset.workflowId;
    var key = 'workflow-landing:' + wfId;
    var newVal = e.target.value || '';
    var wf = defaultWorkflows.find(function (w) { return w.id === wfId; });
    var initial = wf ? (wf._initialLanding != null ? wf._initialLanding : (wf.landingPageId || '')) : '';
    if (wf && wf._initialLanding == null) wf._initialLanding = wf.landingPageId || '';
    if (newVal === initial) {
      pendingEdits.delete(key);
    } else {
      pendingEdits.set(key, { type: 'workflow-landing', key: wfId, landingPageId: newVal });
    }
    if (wf) wf.landingPageId = newVal;
    updatePendingStatus();
  }

  function updatePendingStatus() {
    var n = pendingEdits.size;
    if (!n) { setStatus(''); return; }
    setStatus(n + ' pending edit' + (n === 1 ? '' : 's'));
  }

  /* ── save ── */

  async function saveAll() {
    if (!pendingEdits.size) { setStatus('Nothing to save', 'ok'); return; }
    var saveBtn = document.getElementById('perm-save');
    saveBtn.disabled = true;
    setStatus('Saving…');

    // Group user edits by uid → final set; workflow edits applied to local
    // defaultWorkflows then a single doc write.
    var userEdits = new Map();          // uid → Set<pageId> (final state)
    var capEdits = new Map();           // uid → Set<capId> (final state, V3.605)
    var anyWorkflowEdit = false;

    var anyTrackingEdit = false;
    var mentorEdits = new Map();        // menteeUid → mentorUids[] (final state)
    pendingEdits.forEach(function (edit) {
      if (edit.type === 'user') {
        var s = userEdits.get(edit.key);
        if (!s) {
          s = new Set(initialState.user.get(edit.key) || []);
          userEdits.set(edit.key, s);
        }
        if (edit.checked) s.add(edit.pageId);
        else s.delete(edit.pageId);
      } else if (edit.type === 'cap') {
        var cs = capEdits.get(edit.key);
        if (!cs) {
          cs = new Set(initialState.caps.get(edit.key) || []);
          capEdits.set(edit.key, cs);
        }
        if (edit.checked) cs.add(edit.capId);
        else cs.delete(edit.capId);
      } else if (edit.type === 'workflow') {
        anyWorkflowEdit = true;
        var wf = defaultWorkflows.find(function (w) { return w.id === edit.key; });
        if (!wf) return;
        var ids = new Set(wf.pageIds || []);
        if (edit.checked) ids.add(edit.pageId);
        else ids.delete(edit.pageId);
        wf.pageIds = Array.from(ids);
      } else if (edit.type === 'tracking') {
        anyTrackingEdit = true;
      } else if (edit.type === 'mentor') {
        mentorEdits.set(edit.key, Array.isArray(edit.mentorUids) ? edit.mentorUids.slice() : []);
      }
    });

    try {
      // 1. User permissions: per-uid set/delete.
      // V3.212 — also writes `allowedCollections`, denormalized from
      // allowedPageIds via window.PAGE_COLLECTIONS.collectionsFor.
      // firestore.rules' collabMay(coll) reads that array to enforce
      // collaborator data access at the wire. Both fields are written
      // atomically in the same .set({...}, {merge:true}) call so they
      // can never drift.
      // V3.605 — caps live on the same doc, so pages + caps save through
      // one write per touched uid, always carrying all three arrays. The
      // doc is deleted ONLY when pages AND caps are both empty (previously
      // clearing the last page checkbox deleted the doc — that would have
      // silently destroyed a caps grant).
      var permUids = new Set();
      userEdits.forEach(function (_v, uid) { permUids.add(uid); });
      capEdits.forEach(function (_v, uid) { permUids.add(uid); });
      var userOps = [];
      permUids.forEach(function (uid) {
        var pageSet = userEdits.has(uid) ? userEdits.get(uid) : new Set(initialState.user.get(uid) || []);
        var capSet = capEdits.has(uid) ? capEdits.get(uid) : new Set(initialState.caps.get(uid) || []);
        var ref = db().collection('userPermissions').doc(uid);
        if (!pageSet.size && !capSet.size) {
          userOps.push(ref.delete().catch(function () { /* ignore not-found */ }));
          return;
        }
        var pageIds = Array.from(pageSet);
        var allowedCollections = (window.PAGE_COLLECTIONS && window.PAGE_COLLECTIONS.collectionsFor)
          ? window.PAGE_COLLECTIONS.collectionsFor(pageIds)
          : [];
        userOps.push(ref.set({
          allowedPageIds: pageIds,
          allowedCollections: allowedCollections,
          caps: Array.from(capSet),
          updatedAt: new Date(),
        }, { merge: true }));
      });
      await Promise.all(userOps);

      // 2. Default workflows: single doc write with updated workflows array.
      // ANY edit type that touches the workflow doc (cell toggle, landing
      // change, meta change, add, delete) triggers the write — we re-
      // serialize the full array so partial state can't end up in
      // Firestore.
      var anyWorkflowMeta = anyWorkflowEdit;
      pendingEdits.forEach(function (edit) {
        if (edit.type === 'workflow-landing') anyWorkflowMeta = true;
        if (edit.type === 'workflow-meta')    anyWorkflowMeta = true;
        if (edit.type === 'workflow-deleted') anyWorkflowMeta = true;
      });
      if (anyWorkflowMeta) {
        await db().collection('labConfig').doc('defaultWorkflows').set({
          workflows: defaultWorkflows.map(function (w) {
            return { id: w.id, label: w.label, description: w.description || '',
                     icon: w.icon || '',
                     landingPageId: w.landingPageId || '',
                     pageIds: (w.pageIds || []).slice() };
          }),
          updatedAt: new Date(),
        }, { merge: true });
        workflowDocExists = true;
        // Refresh _initialLanding + _initialMeta so subsequent edits
        // compare against the now-saved values.
        defaultWorkflows.forEach(function (w) {
          w._initialLanding = w.landingPageId || '';
          w._initialMeta = { icon: w.icon || '', label: w.label || '', description: w.description || '' };
        });
      }

      // 3. V3.243 — mentor assignments. One write per changed mentee.
      // Uses merge so adjacent fields on the users/{uid} profile aren't
      // clobbered. firestore.rules' users/{uid} write rule already permits
      // admin writes (line 132).
      var mentorOps = [];
      mentorEdits.forEach(function (mentorUids, menteeUid) {
        mentorOps.push(db().collection('users').doc(menteeUid).set({
          mentor_uids: mentorUids,
          updatedAt: new Date(),
        }, { merge: true }));
      });
      if (mentorOps.length) await Promise.all(mentorOps);

      // 4. V3.228 — page tracking config. Write the full modes map so
      // removed entries (admin flipped back to default) actually drop.
      if (anyTrackingEdit) {
        var modesOut = {};
        trackingModes.forEach(function (mode, slug) {
          if (mode && mode !== 'tracked') modesOut[slug] = mode;
          // Note: 'tracked' is the default — omitting from the doc keeps
          // it compact and means a missing slug also means tracked.
        });
        await db().collection('labConfig').doc('pageTracking').set({
          modes: modesOut,
          updatedAt: new Date(),
        }, { merge: false });
      }

      // 5. V3.477 — per-user paper coauthor role edits (Per-user tab).
      // Mirrors _onCoauthorRoleChange (paper-editor.js): mutate the projects
      // paper row's author fields, rebuild members[], then save the whole
      // collection via the SAME api path the coauthor dialog uses. The
      // onPaperAuthorSync Cloud Function fires on this write and re-derives
      // papers/{id}.authorUids — do NOT stamp authorUids here (avoids drift).
      var paperRoleEdits = [];
      pendingEdits.forEach(function (edit) { if (edit.type === 'paper-role') paperRoleEdits.push(edit); });
      if (paperRoleEdits.length) {
        var pdata = await api.load('projects/papers.json');
        var prows = (pdata && pdata.papers) || [];
        paperRoleEdits.forEach(function (edit) {
          var row = prows.find(function (p) { return p.id === edit.paperId; });
          if (!row) return;
          applyPaperRole(row, { id: edit.uid, email: edit.email }, edit.role);
        });
        await api.save('projects/papers.json', { papers: prows });
        // Refresh the panel cache so role selects + derived actions repaint
        // from the just-saved state.
        allPapers = prows.map(function (p) { return Object.assign({}, p); });
      }

      // Refresh initial state to match what we just saved.
      userEdits.forEach(function (set, uid) {
        if (set.size) initialState.user.set(uid, set);
        else initialState.user.delete(uid);
      });
      capEdits.forEach(function (set, uid) {
        if (set.size) initialState.caps.set(uid, set);
        else initialState.caps.delete(uid);
      });
      defaultWorkflows.forEach(function (wf) {
        initialState.workflow.set(wf.id, new Set(wf.pageIds || []));
      });
      if (anyTrackingEdit) {
        initialState.tracking.clear();
        trackingModes.forEach(function (mode, slug) {
          if (mode && mode !== 'tracked') initialState.tracking.set(slug, mode);
        });
        document.querySelectorAll('.perm-tracking-row.is-changed')
          .forEach(function (el) { el.classList.remove('is-changed'); });
      }
      if (mentorEdits.size) {
        mentorEdits.forEach(function (mentorUids, menteeUid) {
          initialState.mentor.set(menteeUid, new Set(mentorUids));
        });
        renderMentorList();
      }

      pendingEdits.clear();
      // V3.477 — repaint the per-user panel from the freshly-saved state.
      if (selectedPanelUid) renderUserPanel(selectedPanelUid);
      document.querySelectorAll('.perm-cell-changed')
        .forEach(function (el) { el.classList.remove('perm-cell-changed'); });
      setStatus('Saved.', 'ok');
      var seedBox = document.getElementById('perm-seed-box');
      if (seedBox) seedBox.style.display = workflowDocExists ? 'none' : '';
    } catch (err) {
      console.error('[admin-permissions] save failed:', err);
      setStatus('Save failed: ' + err.message, 'err');
    } finally {
      saveBtn.disabled = false;
    }
  }

  function revertAll() {
    if (!pendingEdits.size) return;
    pendingEdits.clear();
    // V3.228 — also restore the in-memory tracking modes from initial state.
    trackingModes.clear();
    initialState.tracking.forEach(function (mode, slug) { trackingModes.set(slug, mode); });
    // V3.243 — restore the in-memory mentor assignments from initial state.
    mentorAssignments.clear();
    initialState.mentor.forEach(function (set, menteeUid) {
      mentorAssignments.set(menteeUid, new Set(set));
    });
    renderUserGrid();
    renderWorkflowGrid();
    renderTrackingList();
    renderMentorList();
    // V3.477 — snap the per-user panel back to saved state.
    if (selectedPanelUid) renderUserPanel(selectedPanelUid);
    setStatus('Reverted.', 'ok');
  }

  async function seedDefaults() {
    var btn = document.getElementById('perm-seed-defaults');
    btn.disabled = true;
    setStatus('Seeding…');
    try {
      defaultWorkflows = (REG.DEFAULT_WORKFLOWS || []).map(function (w) {
        return Object.assign({}, w, { pageIds: (w.pageIds || []).slice() });
      });
      await db().collection('labConfig').doc('defaultWorkflows').set({
        workflows: defaultWorkflows.map(function (w) {
          return { id: w.id, label: w.label, description: w.description || '',
                   icon: w.icon || '',
                   landingPageId: w.landingPageId || '',
                   pageIds: (w.pageIds || []).slice() };
        }),
        updatedAt: new Date(),
        seededAt: new Date(),
      });
      workflowDocExists = true;
      defaultWorkflows.forEach(function (wf) {
        initialState.workflow.set(wf.id, new Set(wf.pageIds || []));
      });
      pendingEdits.clear();
      var seedBox2 = document.getElementById('perm-seed-box');
      if (seedBox2) seedBox2.style.display = 'none';
      renderWorkflowGrid();
      setStatus('Defaults seeded.', 'ok');
    } catch (err) {
      console.error('[admin-permissions] seed failed:', err);
      setStatus('Seed failed: ' + err.message, 'err');
    } finally {
      btn.disabled = false;
    }
  }

  /* V3.212 — Walks every userPermissions/{uid} doc and re-derives
   * `allowedCollections` from its current `allowedPageIds` via
   * window.PAGE_COLLECTIONS.collectionsFor. Use after editing the
   * pageId → collection map in page-collections.js so existing
   * grants pick up the new mapping without forcing the admin to
   * manually re-save every collaborator. Idempotent: docs whose
   * computed value matches the stored value are skipped (no write). */
  async function recomputeAllCollaboratorGrants() {
    var btn = document.getElementById('perm-recompute-collections');
    if (!btn) return;
    if (!window.PAGE_COLLECTIONS || !window.PAGE_COLLECTIONS.collectionsFor) {
      setStatus('Recompute failed: page-collections.js not loaded.', 'err');
      return;
    }
    if (!confirm(
      'Walk every userPermissions doc and re-derive allowedCollections '
      + 'from allowedPageIds. Use this after editing the pageId → '
      + 'collection map in page-collections.js. Continue?'
    )) return;
    btn.disabled = true;
    setStatus('Recomputing…');
    try {
      var snap = await db().collection('userPermissions').get();
      var ops = [];
      var touched = 0, unchanged = 0, skipped = 0;
      snap.forEach(function (d) {
        var data = d.data() || {};
        var pageIds = Array.isArray(data.allowedPageIds) ? data.allowedPageIds : [];
        if (!pageIds.length) { skipped++; return; }
        var computed = window.PAGE_COLLECTIONS.collectionsFor(pageIds);
        var existing = Array.isArray(data.allowedCollections) ? data.allowedCollections.slice().sort() : [];
        var same = computed.length === existing.length
          && computed.every(function (c, i) { return c === existing[i]; });
        if (same) { unchanged++; return; }
        ops.push(d.ref.set({
          allowedCollections: computed,
          updatedAt: new Date(),
        }, { merge: true }));
        touched++;
      });
      await Promise.all(ops);
      setStatus('Recomputed. touched=' + touched + ' unchanged=' + unchanged + ' skipped=' + skipped, 'ok');
    } catch (err) {
      console.error('[admin-permissions] recompute failed:', err);
      setStatus('Recompute failed: ' + err.message, 'err');
    } finally {
      btn.disabled = false;
    }
  }

  /* V3.473 — one-time backfill of papers/{id}.authorUids from each paper's
   * projects-doc author fields. Existing papers have NO parent papers/{id}
   * doc (only Yjs subcollections), so this both CREATES the doc and stamps
   * authorUids — which is what firestore.rules' isPaperAuthor() gate and PMR's
   * `authorUids array-contains uid` query read. After this runs once, the
   * onPaperAuthorSync Cloud Function keeps authorUids in sync on every paper
   * save. Idempotent: papers whose stored authorUids already match are skipped
   * (no write). Mirror of the authorUids union in functions/paper-author-sync.js
   * and syncPaperMembers() in paper-editor.js. */
  function _authorUidsOfPaper(p) {
    var raw = [p.lead_author_uid, p.co_first_author_uid]
      .concat(Array.isArray(p.coauthor_uids) ? p.coauthor_uids : []);
    var seen = {}, out = [];
    for (var i = 0; i < raw.length; i++) {
      var u = (raw[i] || '').trim();
      if (u && !seen[u]) { seen[u] = true; out.push(u); }
    }
    return out;
  }

  async function recomputePaperAuthorGrants() {
    var btn = document.getElementById('perm-recompute-authors');
    if (!btn) return;
    if (!confirm(
      'Walk every paper (projects where type==paper) and materialize '
      + 'papers/{id}.authorUids from its lead/co-first/coauthor fields. This '
      + 'lets non-admin coauthors open & edit their papers. Run once after the '
      + 'V3.473 rules + paper-author-sync function are deployed. Continue?'
    )) return;
    btn.disabled = true;
    setStatus('Recomputing paper author grants…');
    try {
      var snap = await db().collection('projects').where('type', '==', 'paper').get();
      var ops = [];
      var touched = 0;
      // Merge-write papers/{id}.authorUids for every paper. Idempotent at the
      // data level (same union → same doc); we don't pre-read to skip no-ops
      // since this is a rare one-time backfill over a small collection.
      snap.forEach(function (d) {
        var p = d.data() || {};
        ops.push(
          firebridge.setDoc('papers', d.id, {
            authorUids: _authorUidsOfPaper(p),
            title: p.title || '',
            status: p.status || 'drafting',
            is_library_entry: false,
          }, true)
        );
        touched++;
      });
      await Promise.all(ops);
      setStatus('Paper author grants materialized. papers=' + touched, 'ok');
    } catch (err) {
      console.error('[admin-permissions] paper author recompute failed:', err);
      setStatus('Paper author recompute failed: ' + err.message, 'err');
    } finally {
      btn.disabled = false;
    }
  }

  /* ════════════════════════════════════════════════════════════════════
     V3.477 — Per-user access drill-in (?tab=user)
     Left rail of lab members; right panel shows one user's page grants
     (editable, reusing the shared pendingEdits + saveAll pipeline), their
     paper coauthor roles + status (editable → projects/papers.json; the
     onPaperAuthorSync Cloud Function grants real access), and a read-only
     list of derived action capabilities.
     ════════════════════════════════════════════════════════════════════ */

  function _userById(uid) {
    for (var i = 0; i < users.length; i++) { if (users[i].uid === uid) return users[i]; }
    return null;
  }
  function _paperById(id) {
    var arr = allPapers || [];
    for (var i = 0; i < arr.length; i++) { if (arr[i].id === id) return arr[i]; }
    return null;
  }
  function _roleLabel(role) {
    for (var i = 0; i < PAPER_ROLE_OPTS.length; i++) { if (PAPER_ROLE_OPTS[i][0] === role) return PAPER_ROLE_OPTS[i][1]; }
    return role;
  }
  // Effective page set for a uid: saved grant + pending user edits.
  function _effectivePages(uid) {
    var s = new Set(initialState.user.get(uid) || []);
    pendingEdits.forEach(function (edit) {
      if (edit.type !== 'user' || edit.key !== uid) return;
      if (edit.checked) s.add(edit.pageId); else s.delete(edit.pageId);
    });
    return s;
  }
  // V3.605 — effective capability set for a uid: saved grant + pending
  // 'cap' edits. Mirrors _effectivePages.
  function _effectiveCaps(uid) {
    var s = new Set(initialState.caps.get(uid) || []);
    pendingEdits.forEach(function (edit) {
      if (edit.type !== 'cap' || edit.key !== uid) return;
      if (edit.checked) s.add(edit.capId); else s.delete(edit.capId);
    });
    return s;
  }
  // Stash/clear one cap pending edit using the same delete-when-back-to-
  // initial bookkeeping as onUserCellChange.
  function _setCapEdit(uid, capId, checked) {
    var key = 'cap:' + uid + ':' + capId;
    var initial = (initialState.caps.get(uid) || new Set()).has(capId);
    if (checked === initial) pendingEdits.delete(key);
    else pendingEdits.set(key, { type: 'cap', key: uid, capId: capId, checked: checked });
  }
  // Saved coauthor role of uid on a paper row (no pending applied).
  function _paperRoleOf(p, uid) {
    if (!p) return 'none';
    if (p.lead_author_uid === uid) return 'first';
    if (p.co_first_author_uid === uid) return 'cofirst';
    if (Array.isArray(p.coauthor_uids) && p.coauthor_uids.indexOf(uid) >= 0) return 'coauthor';
    return 'none';
  }
  // Effective role including any pending paper-role edit.
  function _effectivePaperRole(paperId, uid) {
    var key = 'paper:' + paperId + ':' + uid;
    if (pendingEdits.has(key)) return pendingEdits.get(key).role;
    return _paperRoleOf(_paperById(paperId), uid);
  }

  async function loadAllPapers() {
    try {
      var snap = await db().collection('projects').where('type', '==', 'paper').get();
      allPapers = [];
      snap.forEach(function (d) { allPapers.push(Object.assign({ id: d.id }, d.data())); });
    } catch (e) {
      console.warn('[admin-permissions] paper load failed:', e.message);
      allPapers = [];
    }
  }

  function renderUserRail() {
    var list = document.getElementById('perm-user-rail-list');
    if (!list) return;
    if (!users.length) { list.innerHTML = '<div class="perm-empty">No non-admin users.</div>'; return; }
    list.innerHTML = users.map(function (u, i) {
      var color = USER_RAIL_COLORS[i % USER_RAIL_COLORS.length];
      var roleTag = u.role ? '<span class="perm-role-tag perm-role-' + escHtml(u.role) + '">' + escHtml(u.role) + '</span>' : '';
      return '<div class="perm-user-person' + (u.uid === selectedPanelUid ? ' active' : '') + '" data-uid="' + escHtml(u.uid) + '">' +
        '<span class="perm-user-avatar" style="background:' + color + ';">' + escHtml(initials(u.name || u.email)) + '</span>' +
        '<span class="perm-user-person-main">' +
        '<div class="perm-user-person-name">' + escHtml(u.name) + ' ' + roleTag + '</div>' +
        '<div class="perm-user-person-sub">' + escHtml(u.email || '') + '</div>' +
        '</span></div>';
    }).join('');
    list.querySelectorAll('.perm-user-person').forEach(function (el) {
      el.addEventListener('click', function () { selectUser(el.dataset.uid); });
    });
  }

  function filterUserRail(q) {
    q = (q || '').trim().toLowerCase();
    document.querySelectorAll('#perm-user-rail-list .perm-user-person').forEach(function (el) {
      // V3.729 — category pill composes with the text search.
      var catOk = _userMatchesCategory(_userById(el.dataset.uid), _categoryFilter);
      el.style.display = (catOk && (!q || el.textContent.toLowerCase().indexOf(q) >= 0)) ? '' : 'none';
    });
  }

  async function selectUser(uid) {
    selectedPanelUid = uid;
    document.querySelectorAll('#perm-user-rail-list .perm-user-person').forEach(function (el) {
      el.classList.toggle('active', el.dataset.uid === uid);
    });
    if (!allPapers) await loadAllPapers();
    renderUserPanel(uid);
  }

  function renderUserPanel(uid) {
    var host = document.getElementById('perm-user-panel');
    if (!host) return;
    if (!_userById(uid)) { host.innerHTML = '<div class="perm-empty">User not found.</div>'; return; }
    host.innerHTML =
      '<div class="perm-user-section" id="perm-user-sec-pages"></div>' +
      '<div class="perm-user-section" id="perm-user-sec-caps"></div>' +
      '<div class="perm-user-section" id="perm-user-sec-papers"></div>' +
      '<div class="perm-user-section" id="perm-user-sec-actions"></div>';
    renderUserPagesInto(document.getElementById('perm-user-sec-pages'), uid);
    renderUserCapsInto(document.getElementById('perm-user-sec-caps'), uid);
    renderUserPapersInto(document.getElementById('perm-user-sec-papers'), uid);
    renderDerivedInto(document.getElementById('perm-user-sec-actions'), uid);
  }

  /* V3.605 — per-page elevated capabilities (userPermissions/{uid}.caps).
   * Rendered generically from window.CAPABILITY_REGISTRY — one card per
   * page, one checkbox row per capability. Enforced server-side by
   * firestore.rules hasCap(); this UI just writes the grant array. */
  function renderUserCapsInto(el, uid) {
    if (!el) return;
    var CAPS = window.CAPABILITY_REGISTRY;
    if (!CAPS || !CAPS.pages || !CAPS.pages.length) { el.innerHTML = ''; return; }
    var effective = _effectiveCaps(uid);
    var effectivePages = _effectivePages(uid);
    var body = CAPS.pages.filter(function (pg) {
      return pg.section !== 'papers';   // V3.729 — rendered in the Papers section instead
    }).map(function (pg) {
      var rows = pg.capabilities.map(function (c) {
        var checked = effective.has(c.id);
        var changed = pendingEdits.has('cap:' + uid + ':' + c.id) ? ' perm-cell-changed' : '';
        return '<label class="perm-user-cap-row' + changed + '" title="' + escHtml(c.id) + '">' +
          '<input type="checkbox" data-uid="' + escHtml(uid) + '" data-cap-id="' + escHtml(c.id) + '"' + (checked ? ' checked' : '') + '>' +
          '<span class="perm-user-cap-row-main">' +
            '<span class="perm-user-cap-row-label">' + escHtml(c.label) + (c.base ? ' <em>(base)</em>' : '') + '</span>' +
            '<span class="perm-user-cap-row-desc">' + escHtml(c.description) + '</span>' +
          '</span></label>';
      }).join('');
      // Companion-page nudge: caps grant the page itself, but the user may
      // still need a browsing surface (e.g. Library list → open a paper).
      var hint = '';
      var missing = (pg.companionPageIds || []).filter(function (pid) { return !effectivePages.has(pid); });
      if (missing.length && Array.from(effective).some(function (c) { return c.indexOf(pg.page + ':') === 0; })) {
        hint = '<div class="perm-user-cap-hint">Tip: also grant the <strong>' + missing.map(escHtml).join(', ') +
          '</strong> page' + (missing.length === 1 ? '' : 's') + ' so this user can browse to papers. ' +
          missing.map(function (pid) {
            return '<button type="button" class="perm-cap-grant-page" data-uid="' + escHtml(uid) + '" data-page-id="' + escHtml(pid) + '">Grant ' + escHtml(pid) + '</button>';
          }).join(' ') + '</div>';
      }
      return '<div class="perm-user-cap-card">' +
        '<div class="perm-user-cap-card-head">' + escHtml(pg.label) +
          ' <span class="perm-user-section-hint">' + escHtml(pg.href || '') + '</span></div>' +
        rows + hint + '</div>';
    }).join('');
    el.innerHTML = '<h2>Capabilities <span class="perm-user-section-hint">— elevated per-page powers; works for guests and collaborators too</span></h2>' + body;
    el.querySelectorAll('.perm-user-cap-row input[type="checkbox"]').forEach(function (cb) {
      cb.addEventListener('change', onCapToggle);
    });
    el.querySelectorAll('.perm-cap-grant-page').forEach(function (btn) {
      btn.addEventListener('click', onCapCompanionGrant);
    });
  }

  function onCapToggle(e) {
    var uid = e.target.dataset.uid;
    var capId = e.target.dataset.capId;
    var CAPS = window.CAPABILITY_REGISTRY;
    var cap = CAPS && CAPS.byCapId.get(capId);
    var checked = e.target.checked;
    _setCapEdit(uid, capId, checked);
    if (cap) {
      if (checked && Array.isArray(cap.requires)) {
        // Granting a cap implies its base 'view' cap.
        cap.requires.forEach(function (reqId) { _setCapEdit(uid, reqId, true); });
      }
      if (!checked && cap.base) {
        // Revoking the base cap revokes the page's other caps too.
        (CAPS.byPage.get(cap.page) || { capabilities: [] }).capabilities.forEach(function (c) {
          if (c.id !== capId) _setCapEdit(uid, c.id, false);
        });
      }
    }
    updatePendingStatus();
    if (!selectedPanelUid) return;
    renderUserCapsInto(document.getElementById('perm-user-sec-caps'), selectedPanelUid);
    renderDerivedInto(document.getElementById('perm-user-sec-actions'), selectedPanelUid);
  }

  // Companion "Grant <page>" button — routes through the same pendingEdits
  // bookkeeping as a page checkbox so save/revert treat it identically.
  function onCapCompanionGrant(e) {
    var uid = e.target.dataset.uid;
    var pageId = e.target.dataset.pageId;
    var key = 'user:' + uid + ':' + pageId;
    var initial = (initialState.user.get(uid) || new Set()).has(pageId);
    if (initial) pendingEdits.delete(key);
    else pendingEdits.set(key, { type: 'user', key: uid, pageId: pageId, checked: true });
    updatePendingStatus();
    if (!selectedPanelUid) return;
    renderUserPagesInto(document.getElementById('perm-user-sec-pages'), selectedPanelUid);
    renderUserCapsInto(document.getElementById('perm-user-sec-caps'), selectedPanelUid);
    renderDerivedInto(document.getElementById('perm-user-sec-actions'), selectedPanelUid);
  }

  function renderUserPagesInto(el, uid) {
    if (!el) return;
    var u = _userById(uid);
    var effective = _effectivePages(uid);
    var hasGrant = effective.size > 0;
    var isCollab = !!(u && u.category === 'collaborator');
    var baseline = (REG && REG.defaultPageIdSet) ? REG.defaultPageIdSet : null;
    var body = '';
    var lastGroup = null;
    pageColumns().forEach(function (p) {
      if (p.group !== lastGroup) {
        if (lastGroup !== null) body += '</div>';
        body += '<div class="perm-user-pagegroup"><div class="perm-user-pagegroup-head">' + escHtml(p.group) + '</div>';
        lastGroup = p.group;
      }
      var state = effective.has(p.id) ? 'grant'
        : ((!hasGrant && !isCollab && baseline && baseline.has(p.id)) ? 'baseline' : 'none');
      var changed = pendingEdits.has('user:' + uid + ':' + p.id) ? ' perm-cell-changed' : '';
      body += '<label class="perm-user-page' + changed + '" data-state="' + state + '" title="' + escHtml(p.id) + '">' +
        '<input type="checkbox" data-uid="' + escHtml(uid) + '" data-page-id="' + escHtml(p.id) + '"' + (state === 'grant' ? ' checked' : '') + '>' +
        '<span>' + escHtml(p.label) + '</span></label>';
    });
    if (lastGroup !== null) body += '</div>';
    el.innerHTML = '<h2>Pages <span class="perm-user-section-hint">— checked = explicit grant; tinted = default-workflow baseline</span></h2>' + body;
    el.querySelectorAll('.perm-user-page input[type="checkbox"]').forEach(function (cb) {
      if (cb.parentElement.dataset.state === 'baseline') cb.indeterminate = true;
      cb.addEventListener('change', onPanelPageToggle);
    });
  }

  // Reuse the exact pendingEdits bookkeeping of the matrix (onUserCellChange),
  // then repaint the panel's page tri-state + derived actions.
  function onPanelPageToggle(e) {
    onUserCellChange(e);   // sets user:<uid>:<pageId> pending edit; refreshRowStates no-ops (no <tr>)
    if (!selectedPanelUid) return;
    renderUserPagesInto(document.getElementById('perm-user-sec-pages'), selectedPanelUid);
    // V3.605 — the caps section's companion-page hint depends on pages.
    renderUserCapsInto(document.getElementById('perm-user-sec-caps'), selectedPanelUid);
    renderDerivedInto(document.getElementById('perm-user-sec-actions'), selectedPanelUid);
  }

  function _paperRoleSelect(paperId, uid, role) {
    return '<select class="perm-user-paper-role" data-paper-id="' + escHtml(paperId) + '" data-uid="' + escHtml(uid) + '">' +
      PAPER_ROLE_OPTS.map(function (o) {
        return '<option value="' + o[0] + '"' + (o[0] === role ? ' selected' : '') + '>' + escHtml(o[1]) + '</option>';
      }).join('') + '</select>';
  }

  function renderUserPapersInto(el, uid) {
    if (!el) return;
    var papers = (allPapers || []);
    var onPapers = papers.filter(function (p) { return _effectivePaperRole(p.id, uid) !== 'none'; });
    var offPapers = papers.filter(function (p) { return _effectivePaperRole(p.id, uid) === 'none'; });
    var rows = onPapers.map(function (p) {
      var role = _effectivePaperRole(p.id, uid);
      var st = p.status || 'drafting';
      var changed = pendingEdits.has('paper:' + p.id + ':' + uid) ? ' perm-cell-changed' : '';
      return '<div class="perm-user-paper-row' + changed + '">' +
        '<span class="perm-user-paper-title">' + escHtml(p.title || p.id) + '</span>' +
        '<span class="perm-user-status st-' + escHtml(st) + '">' + escHtml(st) + '</span>' +
        _paperRoleSelect(p.id, uid, role) + '</div>';
    }).join('') || '<div class="perm-empty" style="padding:10px;">Not a coauthor on any paper.</div>';
    var addOpts = '<option value="">+ Add to a paper…</option>' +
      offPapers.map(function (p) { return '<option value="' + escHtml(p.id) + '">' + escHtml(p.title || p.id) + '</option>'; }).join('');
    el.innerHTML = '<h2>Papers <span class="perm-user-section-hint">— role writes projects/papers.json; the sync function grants real edit access</span></h2>' +
      _createPaperCapRow(uid) +
      rows +
      '<div style="margin-top:10px;"><select class="perm-user-add-paper" data-uid="' + escHtml(uid) + '">' + addOpts + '</select></div>';
    el.querySelectorAll('.perm-user-paper-role').forEach(function (sel) { sel.addEventListener('change', onPaperRoleChange); });
    var addSel = el.querySelector('.perm-user-add-paper');
    if (addSel) addSel.addEventListener('change', onAddPaper);
    var createCb = el.querySelector('.perm-user-create-paper input[type="checkbox"]');
    if (createCb) createCb.addEventListener('change', onCreatePaperCapToggle);
  }

  /* V3.729 — "Can create papers" row at the top of the Papers section.
   * It is the `paper-builder:create` capability (capability-registry.js,
   * section:'papers') riding the same cap pending-edit + saveAll pipeline as
   * the Capabilities cards — only its home in the panel differs. The rules
   * already let every lab member (role != guest) create, so for them the box
   * is informational; for a guest/collaborator it is the actual grant, and
   * it also opens the Paper Builder page for them (cap ⇒ page access). */
  var CREATE_PAPER_CAP = 'paper-builder:create';
  function _createPaperCapRow(uid) {
    var u = _userById(uid);
    var isMember = !!(u && u.role && u.role !== 'guest');
    var checked = _effectiveCaps(uid).has(CREATE_PAPER_CAP);
    var changed = pendingEdits.has('cap:' + uid + ':' + CREATE_PAPER_CAP) ? ' perm-cell-changed' : '';
    var desc = isMember
      ? 'Already allowed — lab members can start papers and grants in the Paper Builder. Ticking this keeps the power if the role is ever set back to guest.'
      : 'Lets this guest start new papers and grants as lead author, and opens the Paper Builder page for them. Coauthor access to other people’s papers still comes from the roles below.';
    return '<label class="perm-user-cap-row perm-user-create-paper' + changed + '" title="' + CREATE_PAPER_CAP + '">' +
      '<input type="checkbox" data-uid="' + escHtml(uid) + '" data-cap-id="' + CREATE_PAPER_CAP + '"' + (checked ? ' checked' : '') + '>' +
      '<span class="perm-user-cap-row-main">' +
        '<span class="perm-user-cap-row-label">Can create papers' + (isMember && !checked ? ' <em>(lab member — implicit)</em>' : '') + '</span>' +
        '<span class="perm-user-cap-row-desc">' + escHtml(desc) + '</span>' +
      '</span></label>';
  }
  function onCreatePaperCapToggle(e) {
    _setCapEdit(e.target.dataset.uid, CREATE_PAPER_CAP, e.target.checked);
    updatePendingStatus();
    _rerenderPaperSections();
  }

  function _setPaperRoleEdit(paperId, uid, role) {
    var key = 'paper:' + paperId + ':' + uid;
    var saved = _paperRoleOf(_paperById(paperId), uid);
    if (role === saved) {
      pendingEdits.delete(key);
    } else {
      var u = _userById(uid);
      pendingEdits.set(key, { type: 'paper-role', paperId: paperId, uid: uid, role: role, email: (u && u.email) || '' });
    }
    updatePendingStatus();
  }
  function _rerenderPaperSections() {
    if (!selectedPanelUid) return;
    renderUserPapersInto(document.getElementById('perm-user-sec-papers'), selectedPanelUid);
    renderDerivedInto(document.getElementById('perm-user-sec-actions'), selectedPanelUid);
  }
  function onPaperRoleChange(e) {
    _setPaperRoleEdit(e.target.dataset.paperId, e.target.dataset.uid, e.target.value);
    _rerenderPaperSections();
  }
  function onAddPaper(e) {
    var paperId = e.target.value;
    if (!paperId) return;
    _setPaperRoleEdit(paperId, e.target.dataset.uid, 'coauthor');
    _rerenderPaperSections();
  }

  /* Derived capabilities — READ-ONLY, computed from SAVED state (initialState
   * + allPapers), mirroring the real gates in firebase-bridge / firestore.rules.
   * Pending edits are shown above; this reflects "effective now". */
  function computeDerivedActions(uid) {
    var u = _userById(uid);
    var role = (u && u.role) || 'guest';
    var out = [];
    var savedCaps = initialState.caps.get(uid) || new Set();
    if (role === 'guest') {
      if (savedCaps.size || (initialState.user.get(uid) || new Set()).size) {
        out.push({ source: 'role', text: 'Guest — limited to explicitly granted pages & capabilities' });
      } else {
        out.push({ source: 'role', text: 'No RM access — guest, pending promotion' });
      }
    }
    else out.push({ source: 'role', text: 'Can use RM (lab member · role: ' + role + ')' });
    var saved = initialState.user.get(uid) || new Set();
    if (saved.size) out.push({ source: 'grant', text: 'Can open ' + saved.size + ' explicitly-granted page' + (saved.size === 1 ? '' : 's') });
    else if (u && u.category === 'collaborator') out.push({ source: 'collaborator', text: 'No implicit baseline — only explicitly granted pages/collections' });
    else if (role === 'guest') out.push({ source: 'role', text: 'No implicit baseline — guests open only explicitly granted pages or pages a capability covers' });   // V3.729 (mirrors canAccessPage)
    else {
      var baseCount = (REG && REG.defaultPageIdSet) ? REG.defaultPageIdSet.size : 0;
      out.push({ source: 'baseline', text: 'Can open baseline pages (' + baseCount + ' via default workflows)' });
    }
    if (role !== 'guest') out.push({ source: 'role', text: 'Can highlight & annotate library papers and create claims' });
    // V3.729 — members create papers by role; guests only via the cap
    // (which the capability loop below lists as "Paper Builder: Create papers").
    if (role !== 'guest') out.push({ source: 'role', text: 'Can create papers & grants in the Paper Builder (lead author)' });
    // V3.605 — capability grants (registry labels; reflects saved state).
    var CAPS = window.CAPABILITY_REGISTRY;
    if (CAPS && savedCaps.size) {
      savedCaps.forEach(function (capId) {
        var c = CAPS.byCapId.get(capId);
        var pg = c && CAPS.byPage.get(c.page);
        var text = c
          ? (pg ? pg.label + ': ' : '') + c.label + ' (granted capability)'
          : capId + ' (granted capability — not in registry)';
        out.push({ source: 'capability', text: text });
      });
    }
    (allPapers || []).forEach(function (p) {
      var r = _paperRoleOf(p, uid);
      if (r === 'none') return;
      var src = (r === 'first' || r === 'cofirst') ? 'ownership' : 'coauthor';
      out.push({ source: src, text: 'Can edit paper "' + (p.title || p.id) + '" (' + _roleLabel(r) + ')' });
    });
    initialState.mentor.forEach(function (set, menteeUid) {
      if (set && set.has(uid)) {
        var m = _userById(menteeUid);
        out.push({ source: 'mentor', text: "Can view / comment on " + ((m && m.name) || menteeUid) + "'s PMR (read-only)" });
      }
    });
    return out;
  }
  function renderDerivedInto(el, uid) {
    if (!el) return;
    var caps = computeDerivedActions(uid);
    el.innerHTML = '<h2>Derived actions <span class="perm-user-section-hint">— what this user can effectively do (reflects saved state; save pending edits to update)</span></h2>' +
      caps.map(function (c) {
        return '<div class="perm-user-cap"><span class="perm-user-cap-source">' + escHtml(c.source) + '</span><span>' + escHtml(c.text) + '</span></div>';
      }).join('');
  }

  /* Mirror of paper-editor.js _onCoauthorRoleChange field mutation
   * (paper-editor.js:4118-4154) — keep in lockstep if that changes. */
  function applyPaperRole(row, user, role) {
    var uid = user.id;
    row.coauthor_uids = row.coauthor_uids || [];
    row.coauthor_emails = row.coauthor_emails || [];
    if (row.lead_author_uid === uid) row.lead_author_uid = '';
    if (row.co_first_author_uid === uid) row.co_first_author_uid = '';
    row.coauthor_uids = row.coauthor_uids.filter(function (x) { return x !== uid; });
    if (user.email) {
      row.coauthor_emails = row.coauthor_emails.filter(function (e) {
        return e.toLowerCase() !== String(user.email).toLowerCase();
      });
    }
    function demote(existingUid) {
      if (!existingUid || existingUid === uid) return;
      if (row.coauthor_uids.indexOf(existingUid) < 0) row.coauthor_uids.push(existingUid);
    }
    if (role === 'first') {
      demote(row.lead_author_uid);
      row.lead_author_uid = uid;
    } else if (role === 'cofirst') {
      demote(row.co_first_author_uid);
      row.co_first_author_uid = uid;
      if (row.coauthor_uids.indexOf(uid) < 0) row.coauthor_uids.push(uid);
      if (user.email && row.coauthor_emails.indexOf(user.email) < 0) row.coauthor_emails.push(user.email);
    } else if (role === 'coauthor') {
      if (row.coauthor_uids.indexOf(uid) < 0) row.coauthor_uids.push(uid);
      if (user.email && row.coauthor_emails.indexOf(user.email) < 0) row.coauthor_emails.push(user.email);
    }
    // role === 'none' → already removed above.
    syncPaperMembersLocal(row);
  }
  /* Mirror of paper-editor.js syncPaperMembers (paper-editor.js:2398-2422). */
  function syncPaperMembersLocal(row) {
    if (!row || typeof row !== 'object') return;
    var existing = {};
    (row.members || []).forEach(function (m) { if (m && m.uid) existing[m.uid] = m; });
    var today = new Date().toISOString().slice(0, 10);
    var members = [];
    var seen = {};
    var lead = (row.lead_author_uid || '').trim();
    if (lead) { members.push(existing[lead] || { uid: lead, role: 'lead', start_date: today, end_date: null, effort_pct: null }); seen[lead] = true; }
    (row.coauthor_uids || []).forEach(function (u) {
      u = (u || '').trim();
      if (!u || seen[u]) return;
      members.push(existing[u] || { uid: u, role: 'co-author', start_date: today, end_date: null, effort_pct: null });
      seen[u] = true;
    });
    row.members = members;
    row.member_uids = members.map(function (mm) { return mm.uid; });
  }

  function applySearchFilter(q) {
    q = (q || '').trim().toLowerCase();
    var tab = window.__PERM_TAB;
    if (tab === 'user') { filterUserRail(q); return; }
    if (tab === 'mentors') {
      var rows = document.querySelectorAll('#perm-mentor-list .perm-mentor-row');
      rows.forEach(function (row) {
        var text = row.textContent.toLowerCase();
        row.style.display = (!q || text.indexOf(q) >= 0) ? '' : 'none';
      });
      return;
    }
    // V3.476 — Users × Pages: group-aware. Data rows hide when they don't
    // match the query OR their role section is collapsed; a group header
    // hides when its whole section has no matching rows.
    if (tab === 'users') {
      var uRows = document.querySelectorAll('#perm-grid-users tbody tr');
      var roleHasMatch = {};
      uRows.forEach(function (tr) {
        if (tr.classList.contains('perm-group-row') || !tr.dataset.uid) return;
        var role = tr.dataset.role;
        var matches = (!q || tr.textContent.toLowerCase().indexOf(q) >= 0)
          && _userMatchesCategory(_userById(tr.dataset.uid), _categoryFilter);   // V3.729 pills
        if (matches) roleHasMatch[role] = true;
        tr.style.display = (matches && !collapsedRoles.has(role)) ? '' : 'none';
      });
      uRows.forEach(function (tr) {
        if (!tr.classList.contains('perm-group-row')) return;
        tr.style.display = roleHasMatch[tr.dataset.role] ? '' : 'none';
      });
      return;
    }
    var rowsGrid = document.querySelectorAll('#perm-grid-workflows tbody tr');
    rowsGrid.forEach(function (tr) {
      var text = tr.textContent.toLowerCase();
      tr.style.display = (!q || text.indexOf(q) >= 0) ? '' : 'none';
    });
  }

  function wireActions() {
    document.getElementById('perm-save').addEventListener('click', saveAll);
    document.getElementById('perm-revert').addEventListener('click', revertAll);
    var seedBtn = document.getElementById('perm-seed-defaults');
    if (seedBtn) seedBtn.addEventListener('click', seedDefaults);
    var recompBtn = document.getElementById('perm-recompute-collections');
    if (recompBtn) recompBtn.addEventListener('click', recomputeAllCollaboratorGrants);
    var recompAuthBtn = document.getElementById('perm-recompute-authors');
    if (recompAuthBtn) recompAuthBtn.addEventListener('click', recomputePaperAuthorGrants);
    document.getElementById('perm-search').addEventListener('input', function (e) {
      applySearchFilter(e.target.value);
    });
    // V3.79 — sort dropdown re-renders the user grid in the new order.
    var sortEl = document.getElementById('perm-user-sort');
    if (sortEl) sortEl.addEventListener('change', renderUserGrid);
    // V3.476 — density toggle.
    var densEl = document.getElementById('perm-user-density');
    if (densEl) densEl.addEventListener('change', onDensityToggle);
    // V3.477 — per-user tab rail search.
    var railSearch = document.getElementById('perm-user-rail-search');
    if (railSearch) railSearch.addEventListener('input', function (e) { filterUserRail(e.target.value); });
    // V3.79 — bulk-action bar buttons.
    var bar = document.getElementById('perm-bulk-bar');
    if (bar) {
      bar.querySelector('.perm-bulk-grant') .addEventListener('click', function () { onBulkApply('grant');  });
      bar.querySelector('.perm-bulk-revoke').addEventListener('click', function () { onBulkApply('revoke'); });
      bar.querySelector('.perm-bulk-select-all') .addEventListener('click', onBulkSelectAll);
      bar.querySelector('.perm-bulk-clear-users').addEventListener('click', onBulkClearSelection);
      bar.querySelector('.perm-bulk-clear-pages').addEventListener('click', onBulkClearPages);
    }
  }

  document.addEventListener('DOMContentLoaded', boot);
})();
