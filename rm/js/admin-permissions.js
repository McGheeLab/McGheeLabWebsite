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
 *   2. Default Workflows × Pages
 *      - Rows: five default workflows (from labConfig/defaultWorkflows or
 *              the seed in PAGE_REGISTRY.DEFAULT_WORKFLOWS).
 *      - Cols: every PAGE_REGISTRY page.
 *      - Cells: checkbox reflecting whether page is in workflow.pageIds.
 *      - Save: write the whole `{ workflows: [...] }` doc to
 *              labConfig/defaultWorkflows.
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
  var initialState = { user: new Map(), workflow: new Map(), tracking: new Map(), mentor: new Map() };
  // user → Set<pageId>; workflow → Set<pageId>; tracking → Map<slug, mode>;
  // mentor → Map<menteeUid, Set<mentorUid>>
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

  function setStatus(msg, kind) {
    var el = document.getElementById('perm-status');
    el.className = 'perm-status' + (kind ? ' ' + kind : '');
    el.textContent = msg || '';
  }

  /* ── boot ── */
  async function boot() {
    var gateRes = await firebridge.gateAdmin('manage workflow permissions');
    if (!gateRes || !gateRes.allowed) return;
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

    if (!workflowDocExists) {
      document.getElementById('perm-seed-box').style.display = '';
    }
    renderUserGrid();
    renderWorkflowGrid();
    renderTrackingList();
    renderMentorList();
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
      });
      // V3.243 — seed initial mentor state from the users/* read so the
      // Mentors tab doesn't need an extra fetch.
      initialState.mentor.set(d.id, new Set(mentorUids));
      mentorAssignments.set(d.id, new Set(mentorUids));
    });
    sortUsers();
  }

  /* V3.79 — sort the users list per the current sort dropdown. Default
   * is 'role' which clusters by lab-role (admin > member > guest etc.)
   * with name as secondary key, so admins see related users adjacent. */
  function sortUsers() {
    var ROLE_ORDER = ['admin', 'pi', 'postdoc', 'phd', 'masters', 'undergrad', 'staff', 'collaborator', 'member', 'guest'];
    var rank = function (role) {
      var idx = ROLE_ORDER.indexOf((role || '').toLowerCase());
      return idx >= 0 ? idx : ROLE_ORDER.length;
    };
    var mode = (document.getElementById('perm-user-sort') || {}).value || 'role';
    users.sort(function (a, b) {
      if (mode === 'role') {
        var rA = rank(a.role), rB = rank(b.role);
        if (rA !== rB) return rA - rB;
      } else if (mode === 'email') {
        return (a.email || '').localeCompare(b.email || '');
      }
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
    users.forEach(function (u) {
      var tr = tbody.insertRow();
      tr.dataset.uid = u.uid;
      var th = document.createElement('th');
      th.scope = 'row';
      // V3.79 — row-select checkbox + role tag for visual grouping after
      // the "Sort by Role" default.
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
      // Build the user's effective page set: initial state + any pending
      // edits since load. Always copy into a fresh Set so we don't mutate
      // initialState during a re-render (which can happen on sort change
      // OR after a bulk-grant/revoke that flipped many cells).
      var allowed = new Set(initialState.user.get(u.uid) || []);
      pendingEdits.forEach(function (edit) {
        if (edit.type !== 'user' || edit.key !== u.uid) return;
        if (edit.checked) allowed.add(edit.pageId);
        else allowed.delete(edit.pageId);
      });
      var lastGroup = null;
      pageColumns().forEach(function (p) {
        var td = document.createElement('td');
        td.className = 'perm-cell';
        if (p.group !== lastGroup) td.classList.add('group-start');
        lastGroup = p.group;
        var cb = document.createElement('input');
        cb.type = 'checkbox';
        cb.checked = allowed.has(p.id);
        cb.dataset.uid = u.uid;
        cb.dataset.pageId = p.id;
        cb.addEventListener('change', onUserCellChange);
        td.appendChild(cb);
        tr.appendChild(td);
      });
    });
    refreshBulkBar();
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
    users.forEach(function (u) { selectedUsers.add(u.uid); });
    document.querySelectorAll('.perm-user-select').forEach(function (cb) { cb.checked = true; });
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
      '    <input type="text" class="perm-add-icon"  placeholder="📁" maxlength="2" style="width:32px;text-align:center;font-size:14px;padding:3px 4px;border:1px solid #d1d5db;border-radius:4px;">' +
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
      '    <input type="text" class="perm-wf-icon" data-workflow-id="' + escHtml(wf.id) + '" data-field="icon" maxlength="2" value="' + escHtml(wf.icon || '') + '" placeholder="🗂" title="Icon (single emoji/character)">' +
      '    <input type="text" class="perm-wf-name" data-workflow-id="' + escHtml(wf.id) + '" data-field="label" value="' + escHtml(wf.label || '') + '" placeholder="Workflow name" title="Workflow display name">' +
      '    <button type="button" class="perm-wf-del" data-workflow-id="' + escHtml(wf.id) + '" title="Delete this workflow">×</button>' +
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
              'title="Remove mentor">×</button>';
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
      icon: (iconEl.value || '').trim() || '📁',
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
      var userOps = [];
      userEdits.forEach(function (set, uid) {
        var ref = db().collection('userPermissions').doc(uid);
        if (set.size) {
          var pageIds = Array.from(set);
          var allowedCollections = (window.PAGE_COLLECTIONS && window.PAGE_COLLECTIONS.collectionsFor)
            ? window.PAGE_COLLECTIONS.collectionsFor(pageIds)
            : [];
          userOps.push(ref.set({
            allowedPageIds: pageIds,
            allowedCollections: allowedCollections,
            updatedAt: new Date(),
          }, { merge: true }));
        } else {
          userOps.push(ref.delete().catch(function () { /* ignore not-found */ }));
        }
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

      // Refresh initial state to match what we just saved.
      userEdits.forEach(function (set, uid) {
        if (set.size) initialState.user.set(uid, set);
        else initialState.user.delete(uid);
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
      document.querySelectorAll('.perm-cell-changed')
        .forEach(function (el) { el.classList.remove('perm-cell-changed'); });
      setStatus('Saved.', 'ok');
      document.getElementById('perm-seed-box').style.display = workflowDocExists ? 'none' : '';
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
      document.getElementById('perm-seed-box').style.display = 'none';
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

  function applySearchFilter(q) {
    q = (q || '').trim().toLowerCase();
    var tab = window.__PERM_TAB;
    if (tab === 'mentors') {
      var rows = document.querySelectorAll('#perm-mentor-list .perm-mentor-row');
      rows.forEach(function (row) {
        var text = row.textContent.toLowerCase();
        row.style.display = (!q || text.indexOf(q) >= 0) ? '' : 'none';
      });
      return;
    }
    var which = tab === 'workflows' ? 'perm-grid-workflows' : 'perm-grid-users';
    var rowsGrid = document.querySelectorAll('#' + which + ' tbody tr');
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
    document.getElementById('perm-search').addEventListener('input', function (e) {
      applySearchFilter(e.target.value);
    });
    // V3.79 — sort dropdown re-renders the user grid in the new order.
    var sortEl = document.getElementById('perm-user-sort');
    if (sortEl) sortEl.addEventListener('change', renderUserGrid);
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
