/* lab-tasks.js — assign and track tasks for lab members via Firestore labTasks collection */

(function () {
  var content = document.getElementById('content');
  var tabsEl = document.getElementById('tabs');
  var addBtn = document.getElementById('add-task');
  var activeTab = 'active'; // active | completed | all
  var _users = []; // cached Firestore users for assignee dropdown
  var _sortKey = null;
  var _sortDir = 'asc';
  // Phase E pagination state — most-recent N tasks per page; "Load more"
  // appends another page using the cursor. Reset whenever activeTab changes.
  var TASKS_PAGE_SIZE = 50;
  var _tasksPages = [];          // accumulated rows across pages
  var _tasksLastDoc = null;      // Firestore cursor for next page
  var _tasksHasMore = false;
  var TASK_COLUMNS = [
    { label: 'Title', key: 'title' },
    { label: 'Assigned To', key: 'assignedToName' },
    { label: 'Priority', key: 'priority' },
    { label: 'Due', key: 'dueDate', type: 'date' },
    { label: 'Category', key: 'category' },
    { label: 'Status', key: 'status' },
    { label: 'Actions', key: null },
  ];

  var TABS = [
    { key: 'active', label: 'Active' },
    { key: 'completed', label: 'Completed' },
    { key: 'all', label: 'All' },
  ];

  function showNotConnected() {
    content.innerHTML =
      '<div class="empty-state">' +
        '<p>Not connected to the website.</p>' +
        '<p style="margin-top:8px"><a href="/rm/pages/settings.html">Go to Settings</a> to sign in.</p>' +
      '</div>';
    addBtn.style.display = 'none';
  }

  function priorityChip(priority) {
    var map = { urgent: 'chip-red', high: 'chip-amber', normal: 'chip-muted', low: 'chip-muted' };
    var cls = map[priority] || 'chip-muted';
    return '<span class="chip ' + cls + '">' + (priority || 'normal') + '</span>';
  }

  function taskStatusChip(status) {
    var map = {
      assigned: 'chip-amber',
      in_progress: 'chip-amber',
      completed: 'chip-green',
      verified: 'chip-green',
    };
    var cls = map[status] || 'chip-muted';
    return '<span class="chip ' + cls + '">' + (status || '').replace(/_/g, ' ') + '</span>';
  }

  async function loadUsers() {
    if (_users.length) return _users;
    try {
      // Cached lab roster (api-routes.js → lab/users.json, MEDIUM TTL).
      // Replaces direct firebridge.getAll('users') so the 9 pages that need
      // the user list share a single cached fetch per session.
      var d = await api.load('lab/users.json');
      _users = (d && d.users) || [];
      // Filter to non-guest active members
      _users = _users.filter(function (u) {
        return u.role && u.role !== 'guest';
      });
      _users.sort(function (a, b) {
        return (a.name || '').localeCompare(b.name || '');
      });
    } catch (e) {
      console.warn('[lab-tasks] Could not load users:', e.message);
      _users = [];
    }
    return _users;
  }

  async function loadAndRender() {
    if (typeof firebridge === 'undefined' || !firebridge.isReady()) {
      showNotConnected();
      return;
    }
    addBtn.style.display = '';

    content.innerHTML = '<div class="empty-state">Loading tasks&hellip;</div>';

    // Render tabs
    tabsEl.innerHTML = '';
    TABS.forEach(function (t) {
      var btn = document.createElement('button');
      btn.className = 'tab-btn' + (activeTab === t.key ? ' active' : '');
      btn.textContent = t.label;
      btn.onclick = function () {
        activeTab = t.key; _sortKey = null; _sortDir = 'asc';
        // Reset pagination when switching tabs.
        _tasksPages = []; _tasksLastDoc = null; _tasksHasMore = false;
        loadAndRender();
      };
      tabsEl.appendChild(btn);
    });

    try {
      // Phase E: paginated. First call (no cursor) fetches the most-recent
      // TASKS_PAGE_SIZE labTasks; "Load more" appends the next page. Filter
      // by tab is client-side post-fetch — kept simple since the tabs span
      // all-status rows; could move to server-side .where() if perf demands.
      if (!_tasksPages.length) {
        var page = await firebridge.getPage('labTasks', {
          orderField: 'createdAt', orderDir: 'desc', limit: TASKS_PAGE_SIZE,
        });
        _tasksPages = page.rows;
        _tasksLastDoc = page.lastDoc;
        _tasksHasMore = page.hasMore;
      }
      var tasks = _tasksPages;

      // Filter by tab
      var filtered;
      if (activeTab === 'active') {
        filtered = tasks.filter(function (t) { return t.status === 'assigned' || t.status === 'in_progress'; });
      } else if (activeTab === 'completed') {
        filtered = tasks.filter(function (t) { return t.status === 'completed' || t.status === 'verified'; });
      } else {
        filtered = tasks;
      }

      if (filtered.length === 0) {
        content.innerHTML = '<div class="empty-state">No tasks in this view. Click "+ Assign Task" to create one.</div>';
        return;
      }

      // Summary
      var overdue = filtered.filter(function (t) {
        return t.dueDate && t.dueDate !== 'TBD' && daysUntil(t.dueDate) < 0 && t.status !== 'completed' && t.status !== 'verified';
      });

      var html = '';
      if (overdue.length) {
        html += '<div style="background:var(--red-bg);border:1px solid var(--red);border-radius:var(--radius);padding:12px;margin-bottom:16px;font-size:14px;">';
        html += '<strong style="color:var(--red);">' + overdue.length + ' overdue task' + (overdue.length > 1 ? 's' : '') + '</strong>';
        html += '</div>';
      }

      filtered = sortItems(filtered, _sortKey, _sortDir, TASK_COLUMNS);
      html += '<table class="data-table">';
      html += sortableHeader(TASK_COLUMNS, _sortKey, _sortDir, 'onLabTaskSort');
      html += '<tbody>';

      filtered.forEach(function (t) {
        html += '<tr>' +
          '<td><strong>' + (t.title || '') + '</strong>' +
            (t.description ? '<br><span style="font-size:12px;color:var(--text-muted);">' + t.description.slice(0, 80) + (t.description.length > 80 ? '&hellip;' : '') + '</span>' : '') +
          '</td>' +
          '<td>' + (t.assignedToName || 'Unassigned') + '</td>' +
          '<td>' + priorityChip(t.priority) + '</td>' +
          '<td>' + formatDate(t.dueDate) + ' ' + (t.dueDate ? deadlineChip(t.dueDate) : '') + '</td>' +
          '<td>' + (t.category || '') + '</td>' +
          '<td>' + taskStatusChip(t.status) + '</td>' +
          '<td class="row-actions">';

        if (t.status === 'completed') {
          html += '<button onclick="verifyTask(\'' + t.id + '\')">Verify</button>';
        }
        html += '<button onclick="editTask(\'' + t.id + '\')">Edit</button>';
        html += '<button onclick="deleteTask(\'' + t.id + '\')">Delete</button>';
        html += '</td></tr>';

        // Show student notes if present
        if (t.studentNotes) {
          html += '<tr><td colspan="7" style="padding:4px 14px 10px;background:#f9fafb;font-size:13px;color:var(--text-muted);">';
          html += '<strong>Student notes:</strong> ' + t.studentNotes;
          html += '</td></tr>';
        }
      });

      html += '</tbody></table>';
      // Load-more button — appears when the last fetch hit the page-size limit.
      // Tab filter is client-side, so the count visible may be smaller than
      // _tasksPages.length; the loader still exposes the cursor either way.
      if (_tasksHasMore) {
        html += '<div style="text-align:center;margin:16px 0;">' +
          '<button id="lab-tasks-load-more" class="btn">Load more (showing ' +
          _tasksPages.length + ' most recent)</button></div>';
      } else if (_tasksPages.length > TASKS_PAGE_SIZE) {
        html += '<div style="text-align:center;margin:16px 0;color:var(--text-muted);font-size:12px;">' +
          'Loaded all ' + _tasksPages.length + ' tasks.</div>';
      }
      content.innerHTML = html;
      var loadMore = document.getElementById('lab-tasks-load-more');
      if (loadMore) loadMore.onclick = _onLoadMoreTasks;
    } catch (err) {
      content.innerHTML = '<div class="empty-state" style="color:var(--red);">Error: ' + err.message + '</div>';
      console.error('[lab-tasks]', err);
    }
  }

  async function _onLoadMoreTasks() {
    if (!_tasksLastDoc) return;
    var btn = document.getElementById('lab-tasks-load-more');
    if (btn) { btn.disabled = true; btn.textContent = 'Loading…'; }
    try {
      var page = await firebridge.getPage('labTasks', {
        orderField: 'createdAt', orderDir: 'desc',
        limit: TASKS_PAGE_SIZE, startAfterDoc: _tasksLastDoc,
      });
      _tasksPages = _tasksPages.concat(page.rows);
      _tasksLastDoc = page.lastDoc;
      _tasksHasMore = page.hasMore;
      loadAndRender();
    } catch (err) {
      if (btn) { btn.disabled = false; btn.textContent = 'Load more (failed — retry)'; }
      console.error('[lab-tasks] load more failed:', err);
    }
  }

  // ---- Task CRUD ----

  async function openTaskForm(existingTask) {
    var users = await loadUsers();
    var userOptions = users.map(function (u) { return u.name || u.email; });

    var fields = [
      { key: 'title', label: 'Title', type: 'text', required: true },
      { key: 'description', label: 'Description', type: 'textarea' },
      { key: 'assignedToName', label: 'Assign To', type: 'select', options: userOptions, required: true },
      { key: 'priority', label: 'Priority', type: 'select', options: ['low', 'normal', 'high', 'urgent'] },
      { key: 'dueDate', label: 'Due Date', type: 'date' },
      { key: 'category', label: 'Category', type: 'select', options: ['lab', 'research', 'admin', 'training'] },
      { key: 'status', label: 'Status', type: 'select', options: ['assigned', 'in_progress', 'completed', 'verified'] },
      { key: 'piNotes', label: 'PI Notes', type: 'textarea' },
    ];

    var values = existingTask || { priority: 'normal', status: 'assigned', category: 'lab' };

    openForm({
      title: existingTask ? 'Edit Task' : 'Assign Task',
      fields: fields,
      values: values,
      onSave: function (vals) {
        // Resolve assignedTo UID from name
        var matchedUser = users.find(function (u) { return (u.name || u.email) === vals.assignedToName; });
        vals.assignedTo = matchedUser ? matchedUser.id : '';
        vals.assignedBy = firebridge.getUser().uid;
        // Optimistic: live-sync onSnapshot below will repaint when Firestore confirms.
        var p = (existingTask && existingTask.id)
          ? firebridge.updateDoc('labTasks', existingTask.id, vals)
          : firebridge.addDoc('labTasks', vals);
        p.catch(function (err) {
          console.error('[lab-tasks] save failed:', err);
          if (window.TOAST) TOAST.error('Save failed: lab task', { detail: err.message });
        });
      },
    });
  }

  window.onLabTaskSort = function (key) {
    if (_sortKey === key) { _sortDir = _sortDir === 'asc' ? 'desc' : 'asc'; }
    else { _sortKey = key; _sortDir = 'asc'; }
    loadAndRender();
  };

  // Global handlers (called from onclick in table HTML)
  window.editTask = async function (taskId) {
    var task = await firebridge.getDoc('labTasks', taskId);
    if (task) openTaskForm(task);
  };

  window.verifyTask = function (taskId) {
    if (!confirmAction('Mark this task as verified?')) return;
    firebridge.updateDoc('labTasks', taskId, { status: 'verified' })
      .catch(function (err) {
        console.error('[lab-tasks] verify failed:', err);
        if (window.TOAST) TOAST.error('Save failed: verify task', { detail: err.message });
      });
  };

  window.deleteTask = function (taskId) {
    if (!confirmAction('Delete this task?')) return;
    firebridge.deleteDoc('labTasks', taskId)
      .catch(function (err) {
        console.error('[lab-tasks] delete failed:', err);
        if (window.TOAST) TOAST.error('Save failed: delete task', { detail: err.message });
      });
  };

  // Wire add button
  addBtn.onclick = function () {
    if (!firebridge.isReady()) {
      alert('Connect to the website first (Settings → Website tab).');
      return;
    }
    openTaskForm(null);
  };

  // Live-sync via Firestore onSnapshot — lab-tasks is a top-level Firestore
  // collection, not an api.load path, so we subscribe directly via firebridge.
  // Debounce + scroll-preserve mirrors the rest of the live-sync recipe.
  var _ltUnsub = null;
  var _ltRefreshTimer = null;
  function _ltScheduleRefresh() {
    if (_ltRefreshTimer) return;
    _ltRefreshTimer = setTimeout(function () {
      _ltRefreshTimer = null;
      var y = window.scrollY;
      loadAndRender().catch(function (err) { console.warn('[lab-tasks] refresh failed:', err); })
        .finally(function () { window.scrollTo({ top: y, left: 0, behavior: 'instant' }); });
    }, 200);
  }
  function _ltAttachLiveSync() {
    if (_ltUnsub) return;
    if (typeof firebridge === 'undefined' || !firebridge.collection) return;
    try {
      var firstFireConsumed = false;
      _ltUnsub = firebridge.collection('labTasks').onSnapshot(function () {
        if (!firstFireConsumed) { firstFireConsumed = true; return; }
        _ltScheduleRefresh();
      }, function (err) { console.warn('[lab-tasks] snapshot error:', err.message); });
    } catch (err) {
      console.warn('[lab-tasks] live sync attach failed:', err.message);
    }
  }

  // Wait for Firebase auth
  if (typeof firebridge !== 'undefined') {
    firebridge.onAuth(function () {
      loadAndRender();
      _ltAttachLiveSync();
    });
  } else {
    document.addEventListener('DOMContentLoaded', function () {
      showNotConnected();
    });
  }
})();
