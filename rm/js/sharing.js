/* sharing.js — Sharing & Assignments hub page.
 *
 * Three tabs:
 *   1. Sent by me      — collectionGroup('tasks').where('createdByUid','==',me)
 *   2. Assigned to me  — api.subscribe('tasks/assigned.json')
 *   3. Lab-wide        — admin-only collectionGroup('tasks') (rule must allow
 *                        isAdmin() read across userData/{uid}/tasks/{taskId}).
 *
 * Each row shows from→to, kind chip (paper-assigned / paper-suggested / task),
 * title (paper title is a link to library-paper.html), due date, and a
 * status chip. Paper rows expand to show the assignee's lab-visibility
 * comments on the paper, lazy-loaded on first expand.
 *
 * Live-sync: onSnapshot for the firebase queries; api.subscribe for the
 * route-driven Assigned-to-me tab.
 */
(function () {
  const state = {
    tab: 'sent',                     // sent | assigned | lab
    kindFilter: 'all',               // all | paper | task
    statusFilter: 'open',            // open | all | done
    counterparty: '',                // empty = all
    me: null,
    isAdmin: false,
    members: [],                     // [{uid,name,email,role,category}]
    membersByUid: {},
    sentTasks: [],                   // {id, ...payload, _userDocId}
    assignedTasks: [],
    labTasks: [],
    paperAnnotations: {},            // paperId|uid → annotations
    paperAnnotationsUnsubs: {},
    expanded: {},                    // rowKey → boolean
    error: null,
  };

  const _unsubs = { sent: null, assigned: null, lab: null };

  function $(id) { return document.getElementById(id); }
  function esc(s) {
    return String(s == null ? '' : s)
      .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;').replace(/'/g, '&#39;');
  }

  function memberLabel(uid) {
    if (!uid) return '(unknown)';
    const m = state.membersByUid[uid];
    if (!m) return uid.slice(0, 6);
    return m.name || m.email || uid.slice(0, 6);
  }

  function rowKey(t) {
    return (t._userDocId || t.assignedToUid || '?') + '|' + (t.id || '');
  }

  /* ── Firestore listeners ─────────────────────────────────────── */

  function attachSentListener() {
    if (_unsubs.sent || typeof firebase === 'undefined') return;
    const me = state.me;
    if (!me) return;
    try {
      _unsubs.sent = firebase.firestore()
        .collectionGroup('tasks')
        .where('createdByUid', '==', me.uid)
        .onSnapshot(function (snap) {
          const rows = [];
          snap.forEach(function (d) {
            const t = d.data();
            // The collectionGroup query returns docs across all userData/*/tasks
            // — capture the parent uid so we can render it.
            const pathParts = (d.ref && d.ref.path) ? d.ref.path.split('/') : [];
            // path is userData/{uid}/tasks/{taskId}
            t._userDocId = pathParts[1] || t.assignedToUid || '';
            rows.push(t);
          });
          state.sentTasks = rows;
          renderBody();
        }, function (err) {
          console.warn('[sharing] sent listener failed:', err && err.message);
          state.error = 'Sent feed: ' + (err && err.message || 'permission denied');
          renderBody();
        });
    } catch (err) {
      console.warn('[sharing] could not attach sent listener:', err && err.message);
    }
  }

  function attachAssignedListener() {
    if (_unsubs.assigned || typeof api.subscribe !== 'function') return;
    try {
      _unsubs.assigned = api.subscribe('tasks/assigned.json', function (data) {
        state.assignedTasks = (data && data.tasks) || [];
        renderBody();
      });
    } catch (err) {
      console.warn('[sharing] assigned subscribe failed:', err && err.message);
    }
  }

  function attachLabListener() {
    if (_unsubs.lab || typeof firebase === 'undefined' || !state.isAdmin) return;
    try {
      _unsubs.lab = firebase.firestore()
        .collectionGroup('tasks')
        .where('bucket', '==', 'assigned')
        .onSnapshot(function (snap) {
          const rows = [];
          snap.forEach(function (d) {
            const t = d.data();
            const pathParts = (d.ref && d.ref.path) ? d.ref.path.split('/') : [];
            t._userDocId = pathParts[1] || t.assignedToUid || '';
            rows.push(t);
          });
          state.labTasks = rows;
          renderBody();
        }, function (err) {
          console.warn('[sharing] lab listener failed:', err && err.message);
          state.error = 'Lab-wide feed: ' + (err && err.message || 'permission denied') +
                        ' — does the firestore rule allow isAdmin() read on userData tasks?';
          renderBody();
        });
    } catch (err) {
      console.warn('[sharing] could not attach lab listener:', err && err.message);
    }
  }

  function detachAll() {
    Object.keys(_unsubs).forEach(k => {
      if (_unsubs[k]) { try { _unsubs[k](); } catch (_) {} _unsubs[k] = null; }
    });
    Object.keys(state.paperAnnotationsUnsubs).forEach(k => {
      try { state.paperAnnotationsUnsubs[k](); } catch (_) {}
    });
    state.paperAnnotationsUnsubs = {};
  }

  function ensurePaperAnnotationSub(paperId, uid) {
    if (!paperId || !uid) return;
    const key = paperId + '|' + uid;
    if (state.paperAnnotationsUnsubs[key]) return;
    try {
      state.paperAnnotationsUnsubs[key] = firebase.firestore()
        .collection('papers').doc(paperId)
        .collection('annotations').where('creator.uid', '==', uid)
        .onSnapshot(function (snap) {
          const list = [];
          snap.forEach(d => list.push(d.data()));
          state.paperAnnotations[key] = list.filter(a => a && a.comment);
          renderBody();
        }, function (err) {
          console.warn('[sharing] annotation listener failed for', key, err && err.message);
        });
    } catch (err) {
      console.warn('[sharing] annotation listener attach failed:', err && err.message);
    }
  }

  /* ── Rendering ───────────────────────────────────────────────── */

  function activeRows() {
    let raw;
    if (state.tab === 'sent') raw = state.sentTasks;
    else if (state.tab === 'assigned') raw = state.assignedTasks;
    else if (state.tab === 'lab') raw = state.labTasks;
    else raw = [];

    return raw.filter(function (t) {
      // Kind filter
      const isPaper = !!(t.paper_ref && t.paper_ref.paperId);
      if (state.kindFilter === 'paper' && !isPaper) return false;
      if (state.kindFilter === 'task' && isPaper) return false;
      // Status filter
      if (state.statusFilter === 'open' && t.done) return false;
      if (state.statusFilter === 'done' && !t.done) return false;
      // Counterparty filter — for "sent" we filter on assignedToUid; for the
      // other two we filter on createdByUid.
      if (state.counterparty) {
        if (state.tab === 'sent') {
          if (t.assignedToUid !== state.counterparty) return false;
        } else {
          if (t.createdByUid !== state.counterparty) return false;
        }
      }
      return true;
    }).sort(function (a, b) {
      // Most-recent first
      const at = a.updatedAt && a.updatedAt.toMillis ? a.updatedAt.toMillis() :
                 (a.created_at ? Date.parse(a.created_at) : 0);
      const bt = b.updatedAt && b.updatedAt.toMillis ? b.updatedAt.toMillis() :
                 (b.created_at ? Date.parse(b.created_at) : 0);
      return bt - at;
    });
  }

  function renderRow(t) {
    const isPaper = !!(t.paper_ref && t.paper_ref.paperId);
    const kind = isPaper
      ? (t.paper_ref.kind === 'suggested' ? 'paper-suggested' : 'paper-assigned')
      : 'task';
    const kindLabel = isPaper
      ? (t.paper_ref.kind === 'suggested' ? 'suggested' : 'assigned')
      : 'task';

    const fromName = memberLabel(t.createdByUid) || t.createdByName || '(?)';
    const toName   = memberLabel(t._userDocId || t.assignedToUid) || t.assignedToName || '(?)';

    const today = new Date().toISOString().slice(0, 10);
    const isOverdue = !t.done && t.due_date && t.due_date !== 'TBD' && t.due_date < today
                   && !(isPaper && t.paper_ref.kind === 'suggested');

    const titleText = isPaper
      ? (t.paper_ref.paperTitle || t.paper_ref.paperId)
      : (t.text || '(untitled)');
    const titleHtml = isPaper
      ? '<a href="/rm/pages/library-paper.html?id=' + encodeURIComponent(t.paper_ref.paperId) + '">' + esc(titleText) + '</a>'
      : esc(titleText);

    const key = rowKey(t);
    const isExpanded = !!state.expanded[key];

    let html = '<div class="sh-row" data-row-key="' + esc(key) + '">' +
      '<div class="who"><strong>' + esc(fromName) + '</strong> → <strong>' + esc(toName) + '</strong></div>' +
      '<div class="title">' +
        '<span class="sh-chip ' + kind + '">' + kindLabel + '</span>' +
        titleHtml +
        (t.done ? ' <span class="sh-chip done">done</span>' : '') +
        (isOverdue ? ' <span class="sh-chip overdue">overdue</span>' : '') +
      '</div>' +
      '<div class="due">' + esc((t.due_date && t.due_date !== 'TBD') ? t.due_date : '') + '</div>' +
      '<div class="actions">' +
        (isPaper
          ? '<a href="/rm/pages/library-paper.html?id=' + encodeURIComponent(t.paper_ref.paperId) + '">→ paper</a>'
          : '<a class="task" href="/rm/pages/tasks.html">→ tasks</a>') +
        ' <button class="sh-toggle" data-row-key="' + esc(key) + '" style="font-size:11px;padding:3px 8px;border:1px solid #d1d5db;border-radius:4px;background:#fff;cursor:pointer">' +
        (isExpanded ? '− details' : '+ details') + '</button>' +
      '</div>' +
    '</div>';

    if (isExpanded) {
      html += '<div class="sh-detail" data-detail-for="' + esc(key) + '">';
      if (t.notes) html += '<div><em>Notes:</em> ' + esc(t.notes) + '</div>';
      html += '<div style="font-size:10px;color:#9ca3af;margin-top:4px">' +
        'created ' + esc(t.created_at || '') +
        (t.assignedToUid ? '  ·  uid ' + esc(t.assignedToUid).slice(0, 8) : '') +
      '</div>';
      if (isPaper) {
        const annKey = t.paper_ref.paperId + '|' + (t._userDocId || t.assignedToUid);
        const annotations = state.paperAnnotations[annKey];
        const annLoaded = !!state.paperAnnotationsUnsubs[annKey];
        html += '<div style="margin-top:8px;font-weight:600;font-size:11px;color:#5b21b6">' +
          'Comments by ' + esc(toName) +
          (annLoaded ? ' (' + (annotations || []).length + ')' : ' …') +
        '</div>';
        if (annotations && annotations.length) {
          annotations.forEach(function (a) {
            const pages = (a.target && a.target.pages) || [];
            const pageStr = pages.length ? 'p.' + pages.map(p => (p && p.page) || p).filter(Boolean).slice(0, 3).join(',') : '';
            const when = (a.modified && a.modified.toDate) ? a.modified.toDate().toISOString().slice(0, 10) :
                         (a.created  && a.created.toDate)  ? a.created.toDate().toISOString().slice(0, 10) : '';
            html += '<div class="ann-card">' +
              '<div style="white-space:pre-wrap">' + esc(a.comment) + '</div>' +
              '<div class="meta">' + esc([pageStr, when].filter(Boolean).join('  ·  ')) + '</div>' +
            '</div>';
          });
        } else if (annLoaded) {
          html += '<div style="font-size:11px;color:#9ca3af;font-style:italic;margin-top:4px">No comments yet on this paper.</div>';
        } else {
          html += '<div style="font-size:11px;color:#9ca3af;margin-top:4px">Loading comments…</div>';
        }
      }
      html += '</div>';
    }

    return html;
  }

  function renderBody() {
    const root = $('sh-content');
    if (!root) return;
    if (state.error) {
      root.innerHTML = '<div class="sh-error">' + esc(state.error) + '</div>';
      // fall through — error doesn't preclude rendering whatever data we have
    } else {
      root.innerHTML = '';
    }
    // Update tab counts
    const counts = {
      sent:     state.sentTasks.filter(t => state.statusFilter === 'all' ? true : (state.statusFilter === 'done' ? !!t.done : !t.done)).length,
      assigned: state.assignedTasks.filter(t => state.statusFilter === 'all' ? true : (state.statusFilter === 'done' ? !!t.done : !t.done)).length,
      lab:      state.labTasks.filter(t => state.statusFilter === 'all' ? true : (state.statusFilter === 'done' ? !!t.done : !t.done)).length,
    };
    Object.keys(counts).forEach(k => {
      const el = document.querySelector('[data-count="' + k + '"]');
      if (el) el.textContent = counts[k];
    });

    const rows = activeRows();
    if (!rows.length) {
      const wrap = document.createElement('div');
      wrap.className = 'sh-empty';
      const msg = state.tab === 'sent'
        ? 'You have not sent any tasks or papers to teammates yet. Use the Send button on a paper or the Tasks page.'
        : state.tab === 'assigned'
        ? 'Nothing assigned to you. When a teammate sends you a task or paper, it shows up here and on your PMR.'
        : 'No assignments across the lab match the current filter.';
      wrap.textContent = msg;
      root.appendChild(wrap);
      return;
    }
    const list = document.createElement('div');
    list.className = 'sh-list';
    list.innerHTML = rows.map(renderRow).join('');
    root.appendChild(list);

    // Wire row toggles + lazy-load annotations on expand.
    list.querySelectorAll('.sh-toggle').forEach(btn => {
      btn.addEventListener('click', function (e) {
        e.preventDefault();
        const k = btn.getAttribute('data-row-key');
        state.expanded[k] = !state.expanded[k];
        // If the row is a paper-bearing task, attach the annotation sub now.
        if (state.expanded[k]) {
          const t = rows.find(r => rowKey(r) === k);
          if (t && t.paper_ref && t.paper_ref.paperId) {
            ensurePaperAnnotationSub(t.paper_ref.paperId, t._userDocId || t.assignedToUid);
          }
        }
        renderBody();
      });
    });
  }

  function populateCounterparty() {
    const sel = $('sh-counterparty');
    if (!sel || !state.members.length) return;
    const opts = ['<option value="">Anyone</option>'].concat(
      state.members.map(m => '<option value="' + esc(m.uid) + '">' + esc(m.name || m.email || m.uid) + '</option>')
    );
    sel.innerHTML = opts.join('');
    sel.value = state.counterparty;
  }

  function wireToolbar() {
    $('sh-kind').addEventListener('change', function (e) {
      state.kindFilter = e.target.value;
      renderBody();
    });
    $('sh-status').addEventListener('change', function (e) {
      state.statusFilter = e.target.value;
      renderBody();
    });
    $('sh-counterparty').addEventListener('change', function (e) {
      state.counterparty = e.target.value;
      renderBody();
    });
    $('sh-refresh').addEventListener('click', function () {
      detachAll();
      attachSentListener();
      attachAssignedListener();
      if (state.isAdmin) attachLabListener();
    });
    document.querySelectorAll('#sh-tabs button[data-tab]').forEach(btn => {
      btn.addEventListener('click', function () {
        state.tab = btn.getAttribute('data-tab');
        document.querySelectorAll('#sh-tabs button[data-tab]').forEach(b => {
          b.classList.toggle('active', b === btn);
        });
        renderBody();
      });
    });
  }

  async function loadMembers() {
    try {
      const d = await api.load('lab/users.json');
      state.members = ((d && d.users) || [])
        .filter(u => u.role && u.role !== 'guest')
        .sort((a, b) => (a.name || '').localeCompare(b.name || ''));
      state.membersByUid = {};
      state.members.forEach(m => { state.membersByUid[m.uid || m.id] = Object.assign({ uid: m.uid || m.id }, m); });
    } catch (err) {
      console.warn('[sharing] lab/users.json load failed:', err && err.message);
    }
  }

  async function init() {
    wireToolbar();
    if (typeof firebridge === 'undefined' || !firebridge.whenAuthResolved) {
      $('sh-content').textContent = 'Sign-in unavailable.';
      return;
    }
    const auth = await firebridge.whenAuthResolved();
    if (!auth.allowed && !auth.user) {
      $('sh-content').textContent = 'Please sign in via the avatar in the top nav to see your shared assignments.';
      return;
    }
    state.me = auth.user;
    state.isAdmin = !!(firebridge.isAdmin && firebridge.isAdmin());
    if (state.isAdmin) {
      const labBtn = document.querySelector('#sh-tabs button[data-tab="lab"]');
      if (labBtn) labBtn.hidden = false;
    }
    await loadMembers();
    populateCounterparty();
    attachSentListener();
    attachAssignedListener();
    if (state.isAdmin) attachLabListener();
    renderBody();
  }

  document.addEventListener('DOMContentLoaded', init);
  window.addEventListener('beforeunload', detachAll);
})();
