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
  var initialState = { user: new Map(), workflow: new Map() };
  // user → Set<pageId>; workflow → Set<pageId>

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
      await Promise.all([loadUsers(), loadDefaultWorkflows(), loadAllUserPermissions()]);
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
      users.push({
        uid: d.id,
        name: data.displayName || data.name || data.email || d.id.slice(0, 8),
        email: data.email || '',
        role: data.role || 'guest',
      });
    });
    users.sort(function (a, b) {
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
    var table = document.getElementById('perm-grid-users');
    renderHeaderRow(table, 'User');
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
      th.innerHTML = '<div>' + escHtml(u.name) + '</div>'
                   + '<div class="row-label-sub">' + escHtml(u.email || u.role) + '</div>';
      tr.appendChild(th);
      var allowed = initialState.user.get(u.uid) || new Set();
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
      var tr = tbody.insertRow();
      tr.dataset.workflowId = wf.id;
      var th = document.createElement('th');
      th.scope = 'row';
      // V3.66 — per-workflow landing page picker. Dropdown shows pages
      // currently checked for this workflow; admin selects one as the
      // entry point that loads when a user clicks the workflow card.
      var landingId = wf.landingPageId || '';
      th.innerHTML = '<div>' + (wf.icon ? escHtml(wf.icon) + ' ' : '') + escHtml(wf.label) + '</div>'
                   + '<div class="row-label-sub">' + escHtml(wf.id) + '</div>'
                   + '<div class="row-label-sub" style="margin-top:4px;">'
                   + '<label style="font-size:10px;color:#9ca3af;text-transform:uppercase;letter-spacing:.3px;display:block;margin-bottom:2px;">Landing</label>'
                   + '<select class="perm-landing-select" data-workflow-id="' + escHtml(wf.id) + '" style="font-size:11px;padding:2px 4px;max-width:160px;">'
                   + '<option value="">First page</option>'
                   + '</select>'
                   + '</div>';
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
      // Populate landing-page select with the workflow's currently-checked
      // pages. Also wired to onWorkflowLandingChange.
      var sel = th.querySelector('.perm-landing-select');
      refreshLandingSelect(sel, wf);
      sel.value = landingId;
      sel.addEventListener('change', onWorkflowLandingChange);
    });
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
      }
    });

    try {
      // 1. User permissions: per-uid set/delete.
      var userOps = [];
      userEdits.forEach(function (set, uid) {
        var ref = db().collection('userPermissions').doc(uid);
        if (set.size) {
          userOps.push(ref.set({ allowedPageIds: Array.from(set), updatedAt: new Date() }, { merge: true }));
        } else {
          userOps.push(ref.delete().catch(function () { /* ignore not-found */ }));
        }
      });
      await Promise.all(userOps);

      // 2. Default workflows: single doc write with updated workflows array.
      // Any workflow-cell edit OR landing edit triggers a write (the doc
      // is rewritten as a whole).
      var anyWorkflowMeta = anyWorkflowEdit;
      pendingEdits.forEach(function (edit) {
        if (edit.type === 'workflow-landing') anyWorkflowMeta = true;
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
        // Refresh _initialLanding so subsequent edits compare against
        // the now-saved values.
        defaultWorkflows.forEach(function (w) { w._initialLanding = w.landingPageId || ''; });
      }

      // Refresh initial state to match what we just saved.
      userEdits.forEach(function (set, uid) {
        if (set.size) initialState.user.set(uid, set);
        else initialState.user.delete(uid);
      });
      defaultWorkflows.forEach(function (wf) {
        initialState.workflow.set(wf.id, new Set(wf.pageIds || []));
      });

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
    renderUserGrid();
    renderWorkflowGrid();
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

  function applySearchFilter(q) {
    q = (q || '').trim().toLowerCase();
    var which = window.__PERM_TAB === 'workflows' ? 'perm-grid-workflows' : 'perm-grid-users';
    var rows = document.querySelectorAll('#' + which + ' tbody tr');
    rows.forEach(function (tr) {
      var text = tr.textContent.toLowerCase();
      tr.style.display = (!q || text.indexOf(q) >= 0) ? '' : 'none';
    });
  }

  function wireActions() {
    document.getElementById('perm-save').addEventListener('click', saveAll);
    document.getElementById('perm-revert').addEventListener('click', revertAll);
    var seedBtn = document.getElementById('perm-seed-defaults');
    if (seedBtn) seedBtn.addEventListener('click', seedDefaults);
    document.getElementById('perm-search').addEventListener('input', function (e) {
      applySearchFilter(e.target.value);
    });
  }

  document.addEventListener('DOMContentLoaded', boot);
})();
