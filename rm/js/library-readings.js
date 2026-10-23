/* library-readings.js — V3.639: "papers people sent me" at the top of the library.
 *
 * Alex: "my mentee has shared papers with me to read, and these readings do
 * not show up … I want the assigned or suggested readings at the top of the
 * library page, and users can mark as done … tagged with the user that
 * assigned it."
 *
 * ── Why they didn't show up ────────────────────────────────────────────
 * Sending a paper has never had its own record — it's a task carrying a
 * `paper_ref` blob (js/task-assign.js). V3.317 routed every cross-user send
 * through the task marketplace, and ONLY admin senders got the task doc
 * materialized in the same flow. A non-admin — i.e. any student or mentee —
 * produced an `open` handoff post in `taskMarket` and no task doc at all,
 * so the reading sat waiting for an accept/decline on the task-market board
 * that the recipient never visits. Both sides saw success.
 *
 * V3.639 fixes the send path (paper sends now write directly, see
 * task-assign.js) but that alone would leave every ALREADY-sent reading
 * invisible forever. So this module reads two sources and presents them
 * identically — the reader shouldn't have to know which pipeline delivered
 * a paper:
 *
 *   A. userData/{me}/tasks where bucket=='assigned' and paper_ref.paperId
 *      — the normal, materialized path (admin sends, and all sends post-639)
 *   B. taskMarket where targetUid=={me} and status=='open' and
 *      task_payload.paper_ref.paperId — sends stranded before V3.639
 *
 * Both are equality-only queries, so neither needs a composite index
 * (Firestore serves multi-equality by zigzag-merging single-field indexes).
 * `taskMarket` read is already allow-listed to isLabMember().
 *
 * Source B is transitional in spirit but permanent in practice: those posts
 * don't expire, and the read costs one cheap query.
 *
 * ── Marking done ───────────────────────────────────────────────────────
 * A-rows flip done/status/done_at on the task doc (owner update).
 * B-rows first claim the post (open→accepted, stamping ourselves — the only
 * transition firestore.rules grants the target) and then materialize the
 * task already-done. Materializing on the done CLICK rather than on load
 * keeps opening the library side-effect free; nobody wants a page visit
 * silently accepting handoffs on their behalf.
 *
 * Public API: window.LIBRARY_READINGS.init() / refresh()
 */

(function () {
  const MOUNT_ID = 'lib-readings';

  const state = {
    rows: [],
    loaded: false,
    error: null,
    busy: {},        // key -> true while a mark-done write is in flight
  };

  /* ── helpers ─────────────────────────────────────────────────────── */

  function _me() {
    return (typeof firebase !== 'undefined' && firebase.auth && firebase.auth().currentUser) || null;
  }
  function _db() {
    return (typeof firebridge !== 'undefined' && firebridge.db) ? firebridge.db() : null;
  }
  function _esc(s) {
    return String(s == null ? '' : s).replace(/[&<>"']/g, c =>
      ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
  }
  function _mount() { return document.getElementById(MOUNT_ID); }

  function _toast(msg, kind) {
    if (window.TOAST) {
      if (kind === 'error') TOAST.error(msg); else TOAST.success(msg, { ttl: 2200 });
    } else if (kind === 'error') {
      console.warn('[library-readings] ' + msg);
    }
  }

  /* "3 days ago" / "today" — readings are a recency-sensitive list and a
   * bare ISO string reads as noise next to the assigner's name. */
  function _relDate(iso) {
    if (!iso) return '';
    const t = Date.parse(iso);
    if (isNaN(t)) return '';
    const days = Math.floor((Date.now() - t) / 86400000);
    if (days <= 0) return 'today';
    if (days === 1) return 'yesterday';
    if (days < 30) return days + ' days ago';
    if (days < 60) return 'last month';
    if (days < 365) return Math.floor(days / 30) + ' months ago';
    return Math.floor(days / 365) + 'y ago';
  }

  function _sortKey(r) { return r.at || ''; }

  /* ── load ────────────────────────────────────────────────────────── */

  function _rowFromTask(id, t) {
    const pr = t.paper_ref || {};
    return {
      key: 'task:' + id,
      source: 'task',
      taskId: id,
      marketPostId: t.marketPostId || null,
      paperId: pr.paperId,
      title: pr.paperTitle || t.text || pr.paperId,
      authors: pr.paperAuthors || '',
      kind: pr.kind === 'suggested' ? 'suggested' : 'assigned',
      fromUid: t.createdByUid || '',
      fromName: t.createdByName || '',
      note: t.notes || '',
      at: pr.assignedAt || t.created_at || '',
      done: !!t.done,
    };
  }

  function _rowFromPost(id, p, pr) {
    return {
      key: 'post:' + id,
      source: 'post',
      postId: id,
      post: p,
      paperId: pr.paperId,
      title: pr.paperTitle || p.title || pr.paperId,
      authors: pr.paperAuthors || '',
      kind: pr.kind === 'suggested' ? 'suggested' : 'assigned',
      fromUid: p.createdByUid || '',
      fromName: p.createdByName || '',
      note: p.description || '',
      at: pr.assignedAt || p.created_at || '',
      done: false,
    };
  }

  async function load() {
    const me = _me();
    const db = _db();
    if (!me || !db) { state.rows = []; state.loaded = true; return state.rows; }

    const rows = [];
    state.error = null;

    // A — materialized readings in my own queue.
    const taskP = db.collection('userData').doc(me.uid).collection('tasks')
      .where('bucket', '==', 'assigned').get()
      .then(function (snap) {
        snap.forEach(function (d) {
          const t = d.data() || {};
          if (t.paper_ref && t.paper_ref.paperId) rows.push(_rowFromTask(d.id, t));
        });
      })
      .catch(function (err) {
        console.warn('[library-readings] assigned-task read failed:', err && err.message);
        state.error = err && err.message;
      });

    // B — handoff posts directed at me that were never accepted (pre-V3.639
    // sends from non-admins). Failure here is non-fatal: source A is the
    // steady state and must still render.
    const postP = db.collection('taskMarket')
      .where('targetUid', '==', me.uid).where('status', '==', 'open').get()
      .then(function (snap) {
        snap.forEach(function (d) {
          const p = d.data() || {};
          const pr = p.task_payload && p.task_payload.paper_ref;
          if (pr && pr.paperId) rows.push(_rowFromPost(d.id, p, pr));
        });
      })
      .catch(function (err) {
        console.warn('[library-readings] stranded-handoff read failed:', err && err.message);
      });

    await Promise.all([taskP, postP]);

    // A post that has already been materialized (accepted on the market
    // board in the old flow) would otherwise appear twice — once as the
    // task, once as the post. Tasks win.
    const claimed = {};
    rows.forEach(function (r) { if (r.source === 'task' && r.marketPostId) claimed[r.marketPostId] = true; });

    state.rows = rows
      .filter(function (r) { return !(r.source === 'post' && claimed[r.postId]); })
      .sort(function (a, b) { return _sortKey(b).localeCompare(_sortKey(a)); });
    state.loaded = true;
    return state.rows;
  }

  /* ── mark done ───────────────────────────────────────────────────── */

  async function _markDone(row, done) {
    const me = _me();
    const db = _db();
    if (!me || !db) { _toast('Sign in to update readings.', 'error'); return; }
    const ts = firebase.firestore.FieldValue.serverTimestamp();
    const nowIso = new Date().toISOString();

    if (row.source === 'task') {
      await db.collection('userData').doc(me.uid).collection('tasks').doc(row.taskId).update({
        done: !!done,
        status: done ? 'completed' : 'pending',
        done_at: done ? nowIso : null,
        updatedAt: ts,
      });
      row.done = !!done;
      return;
    }

    // Stranded handoff post. Claim it, then materialize the task already
    // done so it lives on as a normal reading row from here on.
    //
    // The claim satisfies marketContentUnchanged() in firestore.rules — we
    // touch only status/claim fields + marketTaskId, never title,
    // description, task_payload, targetUid or source_ref. update() (not
    // set()) also preserves createdByUid and kind, which the rule pins.
    const taskId = 'task-' + Date.now().toString(36) + '-' + Math.random().toString(36).slice(2, 6);
    await db.collection('taskMarket').doc(row.postId).update({
      status: 'accepted',
      claimedByUid: me.uid,
      claimedByName: me.displayName || me.email || '',
      claimed_at: nowIso,
      marketTaskId: taskId,
      updatedAt: ts,
    });

    // Writing into MY OWN queue, so the original sender stays createdByUid
    // (the userData owner wildcard in firestore.rules covers this; the
    // stricter cross-user create rule would not).
    const payload = Object.assign({}, row.post.task_payload || {}, {
      id: taskId,
      marketPostId: row.postId,
      done: true,
      status: 'completed',
      done_at: nowIso,
    });
    if (window.TASK_ASSIGN && window.TASK_ASSIGN.writeTaskFor) {
      await window.TASK_ASSIGN.writeTaskFor(me.uid, payload);
    } else {
      await db.collection('userData').doc(me.uid).collection('tasks').doc(taskId)
        .set(Object.assign({ bucket: 'assigned', assignedToUid: me.uid, created_at: nowIso },
          payload, { createdAt: ts, updatedAt: ts }));
    }

    // Becomes an ordinary task row for the rest of this session.
    row.source = 'task';
    row.taskId = taskId;
    row.marketPostId = row.postId;
    row.key = 'task:' + taskId;
    row.done = true;
  }

  /* ── render ──────────────────────────────────────────────────────── */

  function _kindChip(kind) {
    return kind === 'suggested'
      ? '<span class="lr-chip lr-chip-sug">' + ICON.svg('light-bulb') + ' suggested</span>'
      : '<span class="lr-chip lr-chip-asg">' + ICON.svg('pin') + ' assigned</span>';
  }

  function _rowHtml(r) {
    const href = '/rm/pages/library-paper.html?id=' + encodeURIComponent(r.paperId);
    const when = _relDate(r.at);
    const busy = !!state.busy[r.key];
    const from = r.fromName || 'a teammate';

    return '<div class="lr-row' + (r.done ? ' lr-done' : '') + '" data-key="' + _esc(r.key) + '">' +
      '<div class="lr-main">' +
        '<div class="lr-line1">' +
          '<a class="lr-title" href="' + _esc(href) + '">' + _esc(r.title) + '</a>' +
          _kindChip(r.kind) +
          (r.source === 'post' ? '<span class="lr-chip lr-chip-pending" title="Sent before V3.639, when non-admin sends waited on the task market. Marking it done files it into your list properly.">' + ICON.svg('clock') + ' never delivered</span>' : '') +
        '</div>' +
        (r.authors ? '<div class="lr-authors">' + _esc(r.authors) + '</div>' : '') +
        '<div class="lr-meta">' +
          '<span class="lr-from" title="Sent by ' + _esc(from) + '">' + ICON.svg('user-circle') + ' from ' + _esc(from) + '</span>' +
          (when ? '<span class="lr-when">' + _esc(when) + '</span>' : '') +
        '</div>' +
        (r.note ? '<div class="lr-note">“' + _esc(r.note) + '”</div>' : '') +
      '</div>' +
      '<div class="lr-actions">' +
        (r.done
          ? '<button class="btn btn-sm" data-lr-act="undo" data-key="' + _esc(r.key) + '"' +
              (busy ? ' disabled' : '') + '>' + (busy ? '…' : ICON.svg('arrow-uturn-left') + ' Undo') + '</button>'
          : '<button class="btn btn-sm lr-done-btn" data-lr-act="done" data-key="' + _esc(r.key) + '"' +
              (busy ? ' disabled' : '') + '>' + (busy ? 'Saving…' : '✓ Mark as done') + '</button>') +
      '</div>' +
    '</div>';
  }

  function _section(id, icon, label, rows, emptyHtml) {
    if (!rows.length && !emptyHtml) return '';
    const C = window.LIBRARY_COLLAPSE;
    const open = C ? C.sectionOpen(id) : '<section class="lg-section lib-sec" data-sec="' + id + '">';
    const head = C ? C.headHtml(id, icon, label, rows.length)
      : '<div class="lg-sec-head"><span class="lg-sec-title">' + ICON.render(icon) + ' ' + label + '</span></div>';
    return open + head +
      '<div class="lg-sec-body lib-sec-body">' +
        (rows.length ? rows.map(_rowHtml).join('') : emptyHtml) +
      '</div>' +
    '</section>';
  }

  /* V3.827 — the three readings groups as shelves for library-groups.js:
   * Assigned to me (always, once anything was ever sent), Suggested for me and
   * Read (when non-empty), each with the number of papers in it. */
  function _split() {
    const open = state.rows.filter(function (r) { return !r.done; });
    return {
      assigned: open.filter(function (r) { return r.kind !== 'suggested'; }),
      suggested: open.filter(function (r) { return r.kind === 'suggested'; }),
      done: state.rows.filter(function (r) { return r.done; }),
    };
  }
  function shelves() {
    if (!_me() || !state.loaded || !state.rows.length) return { any: false, groups: [] };
    const s = _split();
    const body = function (rows, empty) { return rows.length ? rows.map(_rowHtml).join('') : empty; };
    const groups = [
      { id: 'readings-assigned', icon: 'arrow-down-tray', label: 'Assigned to me', count: s.assigned.length, hint: 'to read', bodyHtml: body(s.assigned, '<div class="lr-empty">Nothing assigned right now.</div>') },
    ];
    if (s.suggested.length) groups.push({ id: 'readings-suggested', icon: 'light-bulb', label: 'Suggested for me', count: s.suggested.length, hint: 'to read', bodyHtml: body(s.suggested, '') });
    if (s.done.length) groups.push({ id: 'readings-done', icon: 'check', label: 'Read', count: s.done.length, hint: 'done', bodyHtml: body(s.done, '') });
    return { any: true, groups: groups, toRead: s.assigned.length + s.suggested.length };
  }
  function _setRowsForTesting(rows) { state.rows = rows || []; state.loaded = true; }

  function render() {
    const el = _mount();
    if (!el) return;

    // V3.827 — shelf mode: the groups block renders the readings as shelves;
    // this mount stays hidden and only asks the block to repaint.
    if (window.LIBRARY_GROUPS && typeof LIBRARY_GROUPS.render === 'function') {
      el.style.display = 'none'; el.innerHTML = '';
      LIBRARY_GROUPS.render();
      return;
    }

    if (!_me() || !state.loaded) { el.style.display = 'none'; el.innerHTML = ''; return; }

    const open = state.rows.filter(function (r) { return !r.done; });
    const done = state.rows.filter(function (r) { return r.done; });
    const assigned  = open.filter(function (r) { return r.kind !== 'suggested'; });
    const suggested = open.filter(function (r) { return r.kind === 'suggested'; });

    // Nothing was ever sent to this user — stay completely out of the way
    // rather than parking an empty block above everyone's library.
    if (!state.rows.length) { el.style.display = 'none'; el.innerHTML = ''; return; }

    el.style.display = '';
    el.innerHTML =
      _section('readings-assigned',  'arrow-down-tray', 'Assigned to me',   assigned,
        '<div class="lr-empty">Nothing assigned right now.</div>') +
      _section('readings-suggested', 'light-bulb', 'Suggested for me', suggested, '') +
      _section('readings-done',      'check', 'Read',             done, '');
  }

  /* ── events ──────────────────────────────────────────────────────── */

  function _wire() {
    const el = _mount();
    if (!el || el.dataset.lrWired === '1') return;
    el.dataset.lrWired = '1';

    // V3.827 — delegated on the document: the rows may live in the shelves block.
    document.addEventListener('click', async function (e) {
      const btn = e.target.closest ? e.target.closest('[data-lr-act]') : null;
      if (!btn) return;
      e.preventDefault();
      const key = btn.getAttribute('data-key');
      const row = state.rows.find(function (r) { return r.key === key; });
      if (!row || state.busy[key]) return;

      const act = btn.getAttribute('data-lr-act');
      state.busy[key] = true;
      render();
      try {
        await _markDone(row, act === 'done');
        _toast(act === 'done' ? 'Marked as read' : 'Moved back to your list');
      } catch (err) {
        console.error('[library-readings] mark-done failed:', err);
        _toast('Could not update: ' + ((err && err.message) || err), 'error');
      } finally {
        delete state.busy[key];
        // The key changes when a stranded post materializes into a task.
        delete state.busy[row.key];
        render();
      }
    });
  }

  /* ── init ────────────────────────────────────────────────────────── */

  async function refresh() {
    try { await load(); } catch (err) {
      console.warn('[library-readings] load failed:', err && err.message);
    }
    render();
  }

  function init() {
    _wire();
    if (typeof firebridge !== 'undefined' && typeof firebridge.onAuth === 'function') {
      firebridge.onAuth(function (user) { if (user) refresh(); else render(); });
    } else if (_me()) {
      refresh();
    }
  }

  window.LIBRARY_READINGS = { init: init, refresh: refresh, load: load, render: render, shelves: shelves, _setRowsForTesting: _setRowsForTesting };
})();
