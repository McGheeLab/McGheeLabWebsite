/* task-market.js — Task Marketplace board (V3.313–V3.317, FuturePlan 04).
 *
 * One lab-scope board carries every cross-user task flow:
 *   kind 'offer'   — posted task anyone can claim (PI → board)
 *   kind 'request' — "I need something to do" (member → PI/anyone)
 *   kind 'handoff' — take-over/help ask on a specific task (→ named teammate)
 *
 * Storage: taskMarket/{postId} (top-level, lab-member read, per-doc writes;
 * firestore.rules enforces the status transition machine — see the
 * taskMarket block there). This page intentionally bypasses the api
 * adapter for writes: lab-scope api.save does whole-list saves, which
 * would rewrite other users' posts and be denied by the rules. Same
 * precedent as sharing.js / task-assign.js.
 *
 * One onSnapshot listener (created_at desc, limit 300) feeds all four
 * board columns client-side: Open offers · Requests · Directed to me ·
 * My posts.
 *
 * V3.314: claiming an offer / accepting a directed handoff materializes
 * the post's task_payload into the claimant's OWN userData/{me}/tasks
 * queue via TASK_ASSIGN.writeTaskFor, stamped with marketPostId. The
 * marketTaskId is pre-generated and written in the SAME update as the
 * status transition (the rules reject creator/claimant patches after
 * the post leaves 'open'). functions/task-market.js pushes: directed
 * post → target, request → admins, claim/accept/decline → creator.
 *
 * V3.317: the page gains an Assignments view (Board | Assignments tabs,
 * ?view=assignments deep-link) that folds in the legacy sharing.js
 * feeds — Sent by me / Assigned to me / Lab-wide (admin) — as filters.
 * The script is also embeddable: pages without #tm-board (tasks.html)
 * load it purely for TASK_MARKET.openComposer; no board listener is
 * attached there.
 */
(function () {
  const KIND_META = {
    offer:   { chip: 'offer',   label: 'offer',   icon: 'clipboard-document-list' },
    request: { chip: 'request', label: 'request', icon: 'hand-raised' },
    handoff: { chip: 'handoff', label: 'handoff', icon: 'user-group' },
  };
  const TERMINAL = ['completed', 'withdrawn', 'declined'];

  const state = {
    me: null,
    isAdmin: false,
    members: [],
    membersByUid: {},
    posts: [],
    error: null,
    showResolved: false,
    view: 'board',                 // board | assignments
    // Assignments view (V3.317 — folded from sharing.js)
    aFeed: 'sent',                 // sent | assigned | lab
    aStatus: 'open',               // open | all | done
    sentTasks: [],
    assignedTasks: [],
    labTasks: [],
    aErrors: { sent: null, assigned: null, lab: null },
  };
  let _unsub = null;
  const _aUnsubs = { sent: null, assigned: null, lab: null };
  let _booted = false;

  function $(id) { return document.getElementById(id); }
  // V3.571 — running inside the Ourlab phone app? (composer → fold-up sheet)
  function _ourlabAppTM() {
    try {
      if (document.body && document.body.classList.contains('ourlab-app')) return true;
      if (window.Capacitor && Capacitor.isNativePlatform && Capacitor.isNativePlatform()) return true;
      if (/[?&]mobileShell=1/.test(location.search)) return true;
      return sessionStorage.getItem('ourlab-shell-preview') === '1';
    } catch (e) { return false; }
  }
  function esc(s) {
    return String(s == null ? '' : s)
      .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;').replace(/'/g, '&#39;');
  }
  function newPostId() {
    return 'mkt-' + Date.now().toString(36) + '-' + Math.random().toString(36).slice(2, 6);
  }
  function newTaskId() {
    return 'task-' + Date.now().toString(36) + '-' + Math.random().toString(36).slice(2, 6);
  }
  function memberLabel(uid) {
    if (!uid) return '';
    const m = state.membersByUid[uid];
    return (m && (m.name || m.email)) || uid.slice(0, 6);
  }
  function nowIso() { return new Date().toISOString(); }
  function myName() { return state.me ? (state.me.displayName || state.me.email || '') : ''; }

  /* ── Firestore ───────────────────────────────────────────────── */

  function attachListener() {
    if (_unsub || typeof firebridge === 'undefined') return;
    try {
      _unsub = firebridge.db().collection('taskMarket')
        .orderBy('created_at', 'desc')
        .limit(300)
        .onSnapshot(function (snap) {
          const rows = [];
          snap.forEach(function (d) { rows.push(Object.assign({ id: d.id }, d.data())); });
          state.posts = rows;
          state.error = null;
          renderBoard();
        }, function (err) {
          console.warn('[task-market] listener failed:', err && err.message);
          state.error = (err && err.message) || 'permission denied';
          renderBoard();
        });
    } catch (err) {
      console.warn('[task-market] could not attach listener:', err && err.message);
      state.error = err.message;
      renderBoard();
    }
  }

  function postRef(postId) {
    return firebridge.db().collection('taskMarket').doc(postId);
  }

  /* Resolves true on success, false on failure (already toasted). */
  function updatePost(postId, patch, successMsg) {
    patch.updatedAt = firebase.firestore.FieldValue.serverTimestamp();
    return postRef(postId).update(patch)
      .then(function () {
        if (successMsg && window.TOAST) TOAST.success(successMsg, { ttl: 2200 });
        return true;
      })
      .catch(function (err) {
        console.error('[task-market] update failed:', err);
        if (window.TOAST) TOAST.error('Update failed', { detail: err.message });
        else alert('Update failed: ' + err.message);
        return false;
      });
  }

  /* ── Status transitions ──────────────────────────────────────── */

  /* Claim an offer (→'claimed') or accept a directed post (→'accepted').
   * When the post carries work (anything but a 'request'), pre-generate
   * the task id, stamp it as marketTaskId inside the SAME transition
   * update (the rules reject later patches), then write the task copy
   * into my own queue. */
  function claimLike(post, newStatus, successMsg) {
    const canTask = post.kind !== 'request'
      && window.TASK_ASSIGN && typeof TASK_ASSIGN.writeTaskFor === 'function';
    const taskId = canTask ? newTaskId() : null;
    const patch = {
      status: newStatus,
      claimedByUid: state.me.uid,
      claimedByName: myName(),
      claimed_at: nowIso(),
    };
    if (taskId) patch.marketTaskId = taskId;
    updatePost(post.id, patch, successMsg).then(function (ok) {
      if (!ok || !canTask) return;
      const p = Object.assign({}, post.task_payload || {});
      delete p.id; delete p.createdAt; delete p.updatedAt;
      TASK_ASSIGN.writeTaskFor(state.me.uid, Object.assign(p, {
        id: taskId,
        text: p.text || post.title || '(untitled)',
        notes: p.notes || post.description || '',
        assignedToUid: state.me.uid,
        assignedToName: myName(),
        createdByUid: post.createdByUid,
        createdByName: post.createdByName || '',
        marketPostId: post.id,
        source_ref: post.source_ref || p.source_ref || null,
      })).then(function () {
        if (window.TOAST) TOAST.success('Task added to your queue', { ttl: 2500 });
      }).catch(function (err) {
        console.error('[task-market] materialize failed:', err);
        if (window.TOAST) TOAST.error('Could not copy task to your queue', { detail: err.message });
      });
    });
  }

  function claim(post) {
    claimLike(post, 'claimed', post.kind === 'request' ? 'Marked — you’re on it' : 'Claimed');
  }
  function accept(post) { claimLike(post, 'accepted', 'Accepted'); }

  function decline(post) {
    updatePost(post.id, { status: 'declined', resolved_at: nowIso() }, 'Declined');
  }
  function withdraw(post) {
    updatePost(post.id, { status: 'withdrawn', resolved_at: nowIso() }, 'Post withdrawn');
  }
  function complete(post) {
    updatePost(post.id, { status: 'completed', resolved_at: nowIso() }, 'Marked completed');
  }
  function removePost(post) {
    if (!confirm('Delete this post? This cannot be undone.')) return;
    postRef(post.id).delete().catch(function (err) {
      if (window.TOAST) TOAST.error('Delete failed', { detail: err.message });
    });
  }

  /* ── Board rendering ─────────────────────────────────────────── */

  function columns() {
    const me = state.me ? state.me.uid : '';
    const open = state.posts.filter(p => p.status === 'open');
    return {
      offers:   open.filter(p => p.kind === 'offer' && !p.targetUid),
      requests: open.filter(p => p.kind === 'request' && !p.targetUid),
      directed: open.filter(p => p.targetUid === me),
      mine:     state.posts.filter(p => p.createdByUid === me),
    };
  }

  function cardActions(post) {
    const me = state.me ? state.me.uid : '';
    const mine = post.createdByUid === me;
    const btns = [];
    if (post.status === 'open') {
      if (post.targetUid === me) {
        btns.push('<button class="tm-btn primary" data-act="accept" data-id="' + esc(post.id) + '">' + ICON.svg('check') + ' Accept</button>');
        btns.push('<button class="tm-btn" data-act="decline" data-id="' + esc(post.id) + '">' + ICON.svg('x-mark') + ' Decline</button>');
      } else if (!mine && !post.targetUid) {
        btns.push('<button class="tm-btn primary" data-act="claim" data-id="' + esc(post.id) + '">' +
          (post.kind === 'request' ? ICON.svg('hand-raised') + ' I’ll handle this' : ICON.svg('hand') + ' Claim') + '</button>');
      }
      if (mine) {
        btns.push('<button class="tm-btn" data-act="withdraw" data-id="' + esc(post.id) + '">Withdraw</button>');
      }
    } else if ((post.status === 'claimed' || post.status === 'accepted') && mine) {
      btns.push('<button class="tm-btn primary" data-act="complete" data-id="' + esc(post.id) + '">' + ICON.svg('check') + ' Complete</button>');
    }
    if (mine || state.isAdmin) {
      btns.push('<button class="tm-btn danger" data-act="delete" data-id="' + esc(post.id) + '" title="Delete post">' + ICON.svg('trash') + '</button>');
    }
    return btns.join('');
  }

  function renderCard(post) {
    const meta = KIND_META[post.kind] || KIND_META.offer;
    const p = post.task_payload || {};
    const due = p.due_date && p.due_date !== 'TBD' ? p.due_date : '';
    const who = esc(post.createdByName || memberLabel(post.createdByUid));
    const target = post.targetUid ? ' → <strong>' + esc(post.targetName || memberLabel(post.targetUid)) + '</strong>' : '';
    const claimed = post.claimedByUid
      ? '<div class="tm-claimed">' +
          (post.status === 'accepted' ? 'accepted' : 'claimed') + ' by <strong>' +
          esc(post.claimedByName || memberLabel(post.claimedByUid)) + '</strong></div>'
      : '';
    const statusChip = post.status !== 'open'
      ? '<span class="tm-chip st-' + esc(post.status) + '">' + esc(post.status) + '</span>'
      : '';
    return (
      '<div class="tm-card" data-id="' + esc(post.id) + '">' +
        '<div class="tm-card-head">' +
          '<span class="tm-chip ' + meta.chip + '">' + ICON.render(meta.icon) + ' ' + meta.label + '</span>' +
          statusChip +
          (due ? '<span class="tm-due">due ' + esc(due) + '</span>' : '') +
        '</div>' +
        '<div class="tm-title">' + esc(post.title || '(untitled)') + '</div>' +
        (post.description ? '<div class="tm-desc">' + esc(post.description) + '</div>' : '') +
        '<div class="tm-meta"><strong>' + who + '</strong>' + target +
          (post.created_at ? ' · ' + esc(String(post.created_at).slice(0, 10)) : '') + '</div>' +
        claimed +
        '<div class="tm-actions">' + cardActions(post) + '</div>' +
      '</div>'
    );
  }

  function renderColumn(title, hint, posts, opts) {
    opts = opts || {};
    let cards;
    if (opts.mine) {
      const active = posts.filter(p => TERMINAL.indexOf(p.status) === -1);
      const resolved = posts.filter(p => TERMINAL.indexOf(p.status) !== -1);
      cards = active.map(renderCard).join('') ||
        '<div class="tm-empty">' + esc(hint) + '</div>';
      if (resolved.length) {
        cards += '<details class="tm-resolved"' + (state.showResolved ? ' open' : '') + '>' +
          '<summary>Resolved (' + resolved.length + ')</summary>' +
          resolved.map(renderCard).join('') + '</details>';
      }
    } else {
      cards = posts.map(renderCard).join('') ||
        '<div class="tm-empty">' + esc(hint) + '</div>';
    }
    return (
      '<div class="tm-col">' +
        '<div class="tm-col-head">' + esc(title) +
          ' <span class="tm-count">' + posts.length + '</span></div>' +
        '<div class="tm-col-body">' + cards + '</div>' +
      '</div>'
    );
  }

  function renderBoard() {
    const root = $('tm-board');
    if (!root || state.view !== 'board') return;
    if (state.error) {
      root.innerHTML = '<div class="tm-error">Marketplace unavailable: ' + esc(state.error) +
        '<br><span style="font-size:11px">Have the firestore.rules with the taskMarket block been deployed?</span></div>';
      return;
    }
    const cols = columns();
    root.innerHTML =
      renderColumn('Open offers', 'No open offers. Post one with ＋ New post.', cols.offers) +
      renderColumn('Requests', 'Nobody is asking for work right now.', cols.requests) +
      renderColumn('Directed to me', 'No posts directed at you.', cols.directed) +
      renderColumn('My posts', 'You have not posted anything yet.', cols.mine, { mine: true });

    root.querySelectorAll('.tm-btn[data-act]').forEach(function (btn) {
      btn.addEventListener('click', function () {
        const post = state.posts.find(p => p.id === btn.getAttribute('data-id'));
        if (!post) return;
        const act = btn.getAttribute('data-act');
        if (act === 'claim') claim(post);
        else if (act === 'accept') accept(post);
        else if (act === 'decline') decline(post);
        else if (act === 'withdraw') withdraw(post);
        else if (act === 'complete') complete(post);
        else if (act === 'delete') removePost(post);
      });
    });
    root.querySelectorAll('.tm-resolved').forEach(function (det) {
      det.addEventListener('toggle', function () { state.showResolved = det.open; });
    });
  }

  /* ── Assignments view (V3.317 — folded from sharing.js) ─────── */

  function attachAssignmentFeeds() {
    if (!_aUnsubs.sent) {
      try {
        _aUnsubs.sent = firebase.firestore()
          .collectionGroup('tasks')
          .where('createdByUid', '==', state.me.uid)
          .onSnapshot(function (snap) {
            const rows = [];
            snap.forEach(function (d) {
              const t = d.data();
              const parts = (d.ref && d.ref.path) ? d.ref.path.split('/') : [];
              t._userDocId = parts[1] || t.assignedToUid || '';
              rows.push(t);
            });
            state.sentTasks = rows;
            renderAssignments();
          }, function (err) {
            state.aErrors.sent = (err && err.message) || 'permission denied';
            renderAssignments();
          });
      } catch (err) { state.aErrors.sent = err.message; }
    }
    if (!_aUnsubs.assigned && typeof api !== 'undefined' && typeof api.subscribe === 'function') {
      try {
        _aUnsubs.assigned = api.subscribe('tasks/assigned.json', function (data) {
          state.assignedTasks = (data && data.tasks) || [];
          renderAssignments();
        });
      } catch (err) { state.aErrors.assigned = err.message; }
    }
    if (!_aUnsubs.lab && state.isAdmin) {
      try {
        _aUnsubs.lab = firebase.firestore()
          .collectionGroup('tasks')
          .where('bucket', '==', 'assigned')
          .onSnapshot(function (snap) {
            const rows = [];
            snap.forEach(function (d) {
              const t = d.data();
              const parts = (d.ref && d.ref.path) ? d.ref.path.split('/') : [];
              t._userDocId = parts[1] || t.assignedToUid || '';
              rows.push(t);
            });
            state.labTasks = rows;
            renderAssignments();
          }, function (err) {
            state.aErrors.lab = (err && err.message) || 'permission denied';
            renderAssignments();
          });
      } catch (err) { state.aErrors.lab = err.message; }
    }
  }

  function assignmentRows() {
    let raw;
    if (state.aFeed === 'sent') raw = state.sentTasks;
    else if (state.aFeed === 'assigned') raw = state.assignedTasks;
    else raw = state.labTasks;
    return raw.filter(function (t) {
      if (state.aStatus === 'open' && t.done) return false;
      if (state.aStatus === 'done' && !t.done) return false;
      return true;
    }).sort(function (a, b) {
      const at = a.updatedAt && a.updatedAt.toMillis ? a.updatedAt.toMillis() : (a.created_at ? Date.parse(a.created_at) : 0);
      const bt = b.updatedAt && b.updatedAt.toMillis ? b.updatedAt.toMillis() : (b.created_at ? Date.parse(b.created_at) : 0);
      return bt - at;
    });
  }

  function renderAssignmentRow(t) {
    const isPaper = !!(t.paper_ref && t.paper_ref.paperId);
    const kindChip = isPaper
      ? '<span class="tm-chip handoff">' + ICON.svg('document-text') + ' ' + (t.paper_ref.kind === 'suggested' ? 'suggested' : 'paper') + '</span>'
      : '<span class="tm-chip offer">task</span>';
    const fromName = t.createdByName || memberLabel(t.createdByUid);
    const toName = t.assignedToName || memberLabel(t._userDocId || t.assignedToUid);
    const today = new Date().toISOString().slice(0, 10);
    const isOverdue = !t.done && t.due_date && t.due_date !== 'TBD' && t.due_date < today;
    const titleText = isPaper ? (t.paper_ref.paperTitle || t.paper_ref.paperId) : (t.text || '(untitled)');
    const link = isPaper
      ? '/rm/pages/library-paper.html?id=' + encodeURIComponent(t.paper_ref.paperId)
      : '/rm/pages/tasks.html';
    return (
      '<div class="tm-arow">' +
        '<div class="who"><strong>' + esc(fromName) + '</strong> → <strong>' + esc(toName) + '</strong></div>' +
        '<div class="title">' + kindChip + ' <a href="' + esc(link) + '">' + esc(titleText) + '</a>' +
          (t.done ? ' <span class="tm-chip st-completed">done</span>' : '') +
          (isOverdue ? ' <span class="tm-chip st-declined">overdue</span>' : '') +
          (t.marketPostId ? ' <span class="tm-chip request" title="Came through the task market">market</span>' : '') +
        '</div>' +
        '<div class="due">' + esc((t.due_date && t.due_date !== 'TBD') ? t.due_date : '') + '</div>' +
      '</div>'
    );
  }

  function renderAssignments() {
    const root = $('tm-assignments');
    if (!root || state.view !== 'assignments') return;
    const err = state.aErrors[state.aFeed];
    const rows = assignmentRows();
    const counts = {
      sent: state.sentTasks.filter(t => state.aStatus === 'done' ? t.done : (state.aStatus === 'open' ? !t.done : true)).length,
      assigned: state.assignedTasks.filter(t => state.aStatus === 'done' ? t.done : (state.aStatus === 'open' ? !t.done : true)).length,
      lab: state.labTasks.filter(t => state.aStatus === 'done' ? t.done : (state.aStatus === 'open' ? !t.done : true)).length,
    };
    let html =
      '<div class="tm-atoolbar">' +
        '<button class="tm-btn' + (state.aFeed === 'sent' ? ' primary' : '') + '" data-feed="sent">Sent by me (' + counts.sent + ')</button>' +
        '<button class="tm-btn' + (state.aFeed === 'assigned' ? ' primary' : '') + '" data-feed="assigned">Assigned to me (' + counts.assigned + ')</button>' +
        (state.isAdmin ? '<button class="tm-btn' + (state.aFeed === 'lab' ? ' primary' : '') + '" data-feed="lab">Lab-wide (' + counts.lab + ')</button>' : '') +
        '<span style="flex:1"></span>' +
        '<select class="tm-astatus">' +
          '<option value="open"' + (state.aStatus === 'open' ? ' selected' : '') + '>Open</option>' +
          '<option value="all"' + (state.aStatus === 'all' ? ' selected' : '') + '>All (incl. done)</option>' +
          '<option value="done"' + (state.aStatus === 'done' ? ' selected' : '') + '>Done only</option>' +
        '</select>' +
      '</div>';
    if (err) html += '<div class="tm-error">This feed is unavailable: ' + esc(err) + '</div>';
    html += rows.length
      ? '<div class="tm-alist">' + rows.map(renderAssignmentRow).join('') + '</div>'
      : '<div class="tm-empty">Nothing here. Cross-user tasks (sent or received) show up in this list.</div>';
    root.innerHTML = html;

    root.querySelectorAll('[data-feed]').forEach(function (btn) {
      btn.addEventListener('click', function () {
        state.aFeed = btn.getAttribute('data-feed');
        renderAssignments();
      });
    });
    const sel = root.querySelector('.tm-astatus');
    if (sel) sel.addEventListener('change', function () { state.aStatus = sel.value; renderAssignments(); });
  }

  function setView(view) {
    state.view = view;
    const board = $('tm-board');
    const assign = $('tm-assignments');
    if (board) board.hidden = view !== 'board';
    if (assign) assign.hidden = view !== 'assignments';
    document.querySelectorAll('#tm-tabs button[data-view]').forEach(function (b) {
      b.classList.toggle('active', b.getAttribute('data-view') === view);
    });
    if (view === 'assignments') {
      attachAssignmentFeeds();
      renderAssignments();
    } else {
      renderBoard();
    }
  }

  /* ── New-post composer ───────────────────────────────────────── */

  async function openComposer(prefill) {
    prefill = prefill || {};
    if (!(await ensureBoot())) {
      alert('Sign in to post to the task market.');
      return;
    }
    injectStyles();
    const memberOpts = state.members
      .filter(m => m.uid !== state.me.uid)
      .map(m => '<option value="' + esc(m.uid) + '">' + esc(m.name || m.email || m.uid) + '</option>')
      .join('');
    const formHTML =
        '<form class="tm-form">' +
          '<label>Kind' +
            '<select class="tmf-kind">' +
              '<option value="offer">Offer — post a task anyone can claim</option>' +
              '<option value="request">Request — I need something to do</option>' +
              '<option value="handoff">Handoff — ask a teammate for help / take-over</option>' +
            '</select>' +
          '</label>' +
          '<label class="tmf-target-wrap" hidden>Directed to' +
            '<select class="tmf-target"><option value="">— pick a teammate —</option>' + memberOpts + '</select>' +
          '</label>' +
          '<label>Title<input type="text" class="tmf-title" placeholder="What is this about?"></label>' +
          '<label>Details (optional)<textarea class="tmf-desc" rows="3" placeholder="Context, links, what done looks like…"></textarea></label>' +
          '<div class="tmf-row">' +
            '<label>Due date<input type="date" class="tmf-due"></label>' +
            '<label>Hours<input type="number" class="tmf-hours" step="0.25" min="0" placeholder="est."></label>' +
            '<label>Importance<select class="tmf-imp">' +
              '<option value="0">—</option><option value="1">★</option><option value="2">★★</option>' +
              '<option value="3">★★★</option><option value="4">★★★★</option><option value="5">★★★★★</option>' +
            '</select></label>' +
          '</div>' +
          '<div class="tmf-status"></div>' +
          '<div class="tmf-actions">' +
            '<button type="button" class="tm-btn tmf-cancel">Cancel</button>' +
            '<button type="submit" class="tm-btn primary tmf-submit">Post</button>' +
          '</div>' +
        '</form>';

    // V3.571 — in the phone app, render as the standard fold-up bottom
    // sheet (APP_SHEET) instead of the centered modal; same form + submit.
    if (_ourlabAppTM() && window.APP_SHEET) {
      window.APP_SHEET.open({
        title: prefill.heading || 'New marketplace post',
        build: function (body, api) {
          body.innerHTML = formHTML;
          wireComposer(body, function () { api.close(); }, prefill);
        }
      });
      return;
    }

    const overlay = document.createElement('div');
    overlay.className = 'tm-overlay';
    overlay.innerHTML =
      '<div class="tm-modal">' +
        '<h2>' + esc(prefill.heading || 'New marketplace post') + '</h2>' +
        formHTML +
      '</div>';
    document.body.appendChild(overlay);
    overlay.addEventListener('mousedown', function (e) { if (e.target === overlay) overlay.remove(); });
    wireComposer(overlay, function () { overlay.remove(); }, prefill);
  }

  /* Wire the composer form (prefill + kind toggle + submit) onto whichever
   * container hosts it — the desktop overlay or the app fold-up sheet. */
  function wireComposer(scope, dismiss, prefill) {
    prefill = prefill || {};
    const form = scope.querySelector('.tm-form');
    const kindSel = scope.querySelector('.tmf-kind');
    const targetWrap = scope.querySelector('.tmf-target-wrap');
    if (prefill.kind) kindSel.value = prefill.kind;
    if (prefill.title) scope.querySelector('.tmf-title').value = prefill.title;
    if (prefill.description) scope.querySelector('.tmf-desc').value = prefill.description;
    if (prefill.due && prefill.due !== 'TBD') scope.querySelector('.tmf-due').value = prefill.due;

    function syncKind() { targetWrap.hidden = kindSel.value !== 'handoff'; }
    kindSel.addEventListener('change', syncKind);
    syncKind();

    const cancelBtn = scope.querySelector('.tmf-cancel');
    if (cancelBtn) cancelBtn.addEventListener('click', dismiss);

    form.addEventListener('submit', function (e) {
      e.preventDefault();
      const status = scope.querySelector('.tmf-status');
      const kind = kindSel.value;
      const title = scope.querySelector('.tmf-title').value.trim();
      const targetUid = kind === 'handoff' ? scope.querySelector('.tmf-target').value : '';
      if (!title) { status.textContent = 'Add a title.'; return; }
      if (kind === 'handoff' && !targetUid) { status.textContent = 'Pick the teammate this is directed at.'; return; }
      const hours = parseFloat(scope.querySelector('.tmf-hours').value || '');
      const ts = firebase.firestore.FieldValue.serverTimestamp();
      const post = {
        kind: kind,
        status: 'open',
        title: title,
        description: scope.querySelector('.tmf-desc').value.trim(),
        createdByUid: state.me.uid,
        createdByName: myName(),
        targetUid: targetUid || null,
        targetName: targetUid ? memberLabel(targetUid) : '',
        claimedByUid: null,
        claimedByName: '',
        task_payload: {
          text: title,
          due_date: scope.querySelector('.tmf-due').value || 'TBD',
          hours_estimate: isNaN(hours) ? null : hours,
          self_importance: parseInt(scope.querySelector('.tmf-imp').value || '0', 10),
          notes: scope.querySelector('.tmf-desc').value.trim(),
        },
        source_ref: prefill.source_ref || null,
        created_at: nowIso(),
        resolved_at: null,
        createdAt: ts,
        updatedAt: ts,
      };
      const submit = scope.querySelector('.tmf-submit');
      submit.disabled = true; submit.textContent = 'Posting…';
      postRef(newPostId()).set(post)
        .then(function () {
          dismiss();
          if (window.TOAST) TOAST.success('Posted to the marketplace', { ttl: 2200 });
        })
        .catch(function (err) {
          submit.disabled = false; submit.textContent = 'Post';
          status.textContent = 'Failed: ' + err.message;
        });
    });

    setTimeout(function () { const t = scope.querySelector('.tmf-title'); if (t) t.focus(); }, 60);
  }

  /* V3.317 — composer/modal styles are injected on demand so embedded
   * hosts (tasks.html) don't need the board page's <style> block. */
  let _stylesInjected = false;
  function injectStyles() {
    if (_stylesInjected || document.getElementById('tm-embed-css')) { _stylesInjected = true; return; }
    _stylesInjected = true;
    const style = document.createElement('style');
    style.id = 'tm-embed-css';
    style.textContent =
      '.tm-overlay{position:fixed;inset:0;z-index:9000;background:rgba(11,13,18,.55);display:flex;align-items:center;justify-content:center;padding:24px}' +
      '.tm-modal{background:#fff;color:#111;border-radius:12px;max-width:520px;width:100%;padding:22px;box-shadow:0 24px 48px rgba(0,0,0,.4);max-height:90vh;overflow:auto}' +
      '.tm-modal h2{margin:0 0 14px;font-size:17px}' +
      '.tm-form{display:grid;gap:12px}' +
      '.tm-form label{display:grid;gap:4px;font-size:12px;color:#374151}' +
      '.tm-form input,.tm-form select,.tm-form textarea{padding:8px 10px;border:1px solid #d1d5db;border-radius:6px;font-size:16px;font-family:inherit}' +
      '.tmf-row{display:grid;grid-template-columns:1fr 1fr 1fr;gap:8px}' +
      '.tmf-status{font-size:13px;color:#991b1b;min-height:16px}' +
      '.tmf-actions{display:flex;gap:8px;justify-content:flex-end}' +
      '.tmf-actions .tm-btn{font-size:13px;padding:7px 14px}' +
      '.tm-btn{font-size:12px;padding:4px 10px;border:1px solid #d1d5db;border-radius:5px;background:#fff;cursor:pointer;color:#374151}' +
      '.tm-btn.primary{background:#2563eb;border-color:#2563eb;color:#fff;font-weight:600}';
    document.head.appendChild(style);
  }

  /* ── Boot ────────────────────────────────────────────────────── */

  async function loadMembers() {
    try {
      const d = await api.load('lab/users.json');
      state.members = ((d && d.users) || [])
        .filter(u => LAB_USERS.isVisible(u))
        .map(u => Object.assign({ uid: u.uid || u.id }, u))
        .sort((a, b) => (a.name || '').localeCompare(b.name || ''));
      state.membersByUid = {};
      state.members.forEach(m => { state.membersByUid[m.uid] = m; });
    } catch (err) {
      console.warn('[task-market] lab/users.json load failed:', err && err.message);
    }
  }

  /* Auth + roster, shared by the board page and embedded composer use.
   * Resolves false when not signed in. */
  async function ensureBoot() {
    if (_booted && state.me) return true;
    if (typeof firebridge === 'undefined' || !firebridge.requireSignIn) return false;
    const auth = await firebridge.requireSignIn('Sign in to view the task market.');
    if (!auth.user) return false;
    state.me = auth.user;
    state.isAdmin = !!(firebridge.isAdmin && firebridge.isAdmin());
    if (!_booted) await loadMembers();
    _booted = true;
    return true;
  }

  async function init() {
    const root = $('tm-board');
    if (!root) return;   // embedded mode (tasks.html) — composer-only
    if (!(await ensureBoot())) {
      root.innerHTML = '<div class="tm-empty" style="grid-column:1/-1">Sign in via the avatar in the top nav to use the task marketplace.</div>';
      return;
    }
    attachListener();
    renderBoard();

    const newBtn = $('tm-new');
    if (newBtn) newBtn.addEventListener('click', function () { openComposer(); });
    const needBtn = $('tm-need-work');
    if (needBtn) {
      needBtn.addEventListener('click', function () {
        openComposer({
          kind: 'request',
          heading: 'Ask for work',
          title: 'I need something to do',
          description: 'Skills / interests / how much time I have: ',
        });
      });
    }
    document.querySelectorAll('#tm-tabs button[data-view]').forEach(function (btn) {
      btn.addEventListener('click', function () { setView(btn.getAttribute('data-view')); });
    });
    // ?view=assignments deep-link (the retired sharing.html redirects here)
    const qp = new URLSearchParams(location.search);
    if (qp.get('view') === 'assignments') setView('assignments');
  }

  document.addEventListener('DOMContentLoaded', init);
  window.addEventListener('beforeunload', function () {
    if (_unsub) { try { _unsub(); } catch (_) {} _unsub = null; }
    Object.keys(_aUnsubs).forEach(function (k) {
      if (_aUnsubs[k]) { try { _aUnsubs[k](); } catch (_) {} _aUnsubs[k] = null; }
    });
  });

  window.TASK_MARKET = { openComposer: openComposer };
})();
