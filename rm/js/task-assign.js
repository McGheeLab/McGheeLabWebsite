/* task-assign.js — Phase 8: cross-user task assignment.
 *
 * Opens a modal to select a teammate from the lab roster + Firestore users,
 * collect a task title / due date / importance / notes, and write it directly
 * into the assignee's `userData/{assigneeUid}/tasks/{taskId}` Firestore
 * subcollection with `bucket: 'assigned'`, `createdByUid`, `assignedToUid`.
 *
 * V3.317 — sends route through the task marketplace: every submit creates
 * a directed 'handoff' post in `taskMarket/{postId}`. Admin senders keep
 * the direct-assign UX (post born 'accepted' + task materialized into the
 * assignee's queue immediately, stamped marketPostId); non-admin senders
 * create an 'open' post the target accepts/declines on
 * rm/pages/task-market.html — no task doc is written until they accept,
 * so opts.onCreated only fires for admin sends.
 *
 * The route `tasks/assigned.json` (registered in js/api-routes.js) maps to
 * `userData/{currentUid}/tasks` where bucket=='assigned' — so the receiving
 * lab member can read their assigned-by-others list via a normal api.load.
 *
 * Firestore rules already permit this write (see firestore.rules
 * userData/{userId}/tasks/{taskId} create rule): any signed-in lab member
 * can drop a task into another lab member's queue as long as they tag
 * themselves as creator and the assignee has a users/{uid} doc.
 *
 * Paper-reading mode: open({ paperRef: { paperId, paperTitle, paperAuthors } })
 * pre-fills the title, renders a paper card, and surfaces an Assigned /
 * Suggested toggle. The resulting task carries paper_ref, which PMR + the
 * sharing page key off to render a paper-aware row + assignee comments.
 *
 * Public API: window.TASK_ASSIGN.open(opts?) — opens the modal.
 *   opts.paperRef           — { paperId, paperTitle, paperAuthors }
 *   opts.titlePrefill       — initial value of the title input
 *   opts.defaultAssigneeUid — auto-select this lab member in the dropdown
 *   opts.source             — V3.157: 'pmr' tags the resulting task as
 *                             originating from a PMR section
 *   opts.pmrPeriodId        — V3.157: back-link to PMR period
 *   opts.pmrSectionId       — V3.157: e.g. 'barriers' / 'paper_writing'
 *   opts.pmrTargetId        — V3.157: e.g. barrier id or paper id
 *   opts.onCreated(task)    — V3.157: invoked after the Firestore write
 *                             succeeds with { id, ...payload } so the
 *                             caller can back-link the task on its own doc.
 */

(function () {
  async function _loadCandidates() {
    // Pull eligible assignees from Firestore users (canonical source of uids).
    // Filter out guests (per project policy: guests don't have RM access).
    if (typeof firebridge === 'undefined' || !firebridge.getAll) {
      return [];
    }
    try {
      const d = await api.load('lab/users.json');
      const users = (d && d.users) || [];
      const me = firebridge.getUser && firebridge.getUser();
      return users
        .filter(u => LAB_USERS.isVisible(u))
        .filter(u => !me || u.id !== me.uid)               // can't assign to self
        .sort((a, b) => (a.name || '').localeCompare(b.name || ''));
    } catch (err) {
      console.warn('[task-assign] failed to load lab members:', err.message);
      return [];
    }
  }

  function _newTaskId() {
    return 'task-' + Date.now().toString(36) + '-' + Math.random().toString(36).slice(2, 6);
  }

  /* V3.314 — the payload-build + write core, extracted from _submit so the
   * task marketplace (rm/js/task-market.js) can materialize a claimed
   * post into the claimant's own queue. `fields` overrides the defaults;
   * writing into someone ELSE's queue still requires
   * fields.createdByUid == the signed-in uid (firestore.rules), but a
   * user writing their own queue (market claim) may carry the post
   * creator as createdByUid — the owner wildcard rule covers that.
   * Resolves the written payload (including id). */
  function writeTaskFor(assigneeUid, fields) {
    fields = fields || {};
    const taskId = fields.id || _newTaskId();
    const ts = firebase.firestore.FieldValue.serverTimestamp();
    const payload = Object.assign({
      id: taskId,
      text: '(untitled)',
      bucket: 'assigned',
      status: 'pending',
      done: false,
      due_date: 'TBD',
      hours_estimate: null,
      self_importance: 0,
      notes: '',
      assignedToUid: assigneeUid,
      assignedToName: '',
      created_at: new Date().toISOString(),
    }, fields, { id: taskId, createdAt: ts, updatedAt: ts });
    // Market posts sourced from PMR carry source_ref backrefs — translate
    // them to the flat source:'pmr' fields PMR renders back-link chips from.
    const sr = payload.source_ref;
    if (sr && sr.pmrPeriodId && !payload.source) {
      payload.source = 'pmr';
      payload.pmrPeriodId = sr.pmrPeriodId;
      if (sr.pmrSectionId) payload.pmrSectionId = sr.pmrSectionId;
      if (sr.pmrTargetId)  payload.pmrTargetId  = sr.pmrTargetId;
    }
    if (payload.source_ref === undefined || payload.source_ref === null) delete payload.source_ref;
    return firebridge.db()
      .collection('userData').doc(assigneeUid)
      .collection('tasks').doc(taskId)
      .set(payload)
      .then(function () { return payload; });
  }

  function _submit(form, candidates, dismiss, opts) {
    opts = opts || {};
    const paperRef = opts.paperRef && opts.paperRef.paperId ? opts.paperRef : null;
    const status = form.querySelector('.ta-status');
    const assigneeUid = form.querySelector('.ta-assignee').value;
    const text = form.querySelector('.ta-title').value.trim();
    const dueDate = form.querySelector('.ta-due').value;
    const hours = parseFloat(form.querySelector('.ta-hours').value || '');
    const importance = parseInt(form.querySelector('.ta-importance').value || '0', 10);
    const notes = form.querySelector('.ta-notes').value.trim();
    const kindEl = form.querySelector('.ta-kind');
    const kind = kindEl ? kindEl.value : '';

    if (!assigneeUid) { status.textContent = 'Pick a teammate.'; return; }
    if (!text)        { status.textContent = 'Add a task title.';  return; }
    const me = firebridge.getUser && firebridge.getUser();
    if (!me) { status.textContent = 'Not signed in.'; return; }

    const taskId = _newTaskId();
    const assignee = candidates.find(c => c.id === assigneeUid);
    // V3.314 — payload defaults + Firestore write live in writeTaskFor
    // (shared with the task marketplace's claim materialization).
    const payload = {
      id: taskId,
      text: text,
      due_date: dueDate || 'TBD',
      hours_estimate: isNaN(hours) ? null : hours,
      self_importance: importance || 0,
      notes: notes,
      createdByUid: me.uid,
      createdByName: me.displayName || me.email || '',
      assignedToUid: assigneeUid,
      assignedToName: (assignee && assignee.name) || '',
    };
    if (paperRef && paperRef.paperId) {
      payload.paper_ref = {
        paperId:      paperRef.paperId,
        paperTitle:   paperRef.paperTitle || '',
        paperAuthors: paperRef.paperAuthors || '',
        kind:         (kind === 'suggested' ? 'suggested' : 'assigned'),
        assignedAt:   new Date().toISOString(),
      };
    }
    // V3.157 — PMR backref. Tags the task as originating from a barrier /
    // paper-writing row / discussion card so PMR can render the back-link
    // chip and so the student can see "this task is tied to barrier X".
    if (opts.source === 'pmr') {
      payload.source = 'pmr';
      if (opts.pmrPeriodId)  payload.pmrPeriodId  = opts.pmrPeriodId;
      if (opts.pmrSectionId) payload.pmrSectionId = opts.pmrSectionId;
      if (opts.pmrTargetId)  payload.pmrTargetId  = opts.pmrTargetId;
    }

    // V3.199 — was optimistic-close + background write. Problem: if the
    // write failed (e.g. assignee has no users/{uid} profile, network
    // dropped, rule denied), the admin would see "Task sent to X" and
    // think it worked. Now we await the write and only show success
    // after it actually lands in Firestore. Modal stays open until then
    // (button text flips to "Sending…") so the admin sees the failure
    // before walking away.
    const submitBtn = form.querySelector('.ta-submit');
    const cancelBtn = form.querySelector('.ta-cancel');
    if (submitBtn) { submitBtn.disabled = true; submitBtn.textContent = 'Sending…'; }
    if (cancelBtn) cancelBtn.disabled = true;
    status.textContent = '';

    // V3.317 — every cross-user send is a directed 'handoff' post on the
    // task marketplace (taskMarket/{postId}). Admin senders keep the
    // direct-assign UX: the post is born 'accepted' + the task is
    // materialized into the assignee's queue in the same flow. Non-admin
    // senders create an 'open' post — the target accepts/declines on the
    // board, and accepting materializes the task there. opts.onCreated
    // only fires when a task doc actually exists (admin path); for
    // non-admin PMR sends the backref rides source_ref and lands on the
    // materialized task at accept time.
    const isAdmin = !!(firebridge.isAdmin && firebridge.isAdmin());
    const postId = 'mkt-' + Date.now().toString(36) + '-' + Math.random().toString(36).slice(2, 6);
    const assigneeName = (assignee && assignee.name) || '';

    function doSend() {
      const ts = firebase.firestore.FieldValue.serverTimestamp();
      const post = {
        kind: 'handoff',
        status: isAdmin ? 'accepted' : 'open',
        title: text,
        description: notes,
        createdByUid: me.uid,
        createdByName: me.displayName || me.email || '',
        targetUid: assigneeUid,
        targetName: assigneeName,
        claimedByUid: isAdmin ? assigneeUid : null,
        claimedByName: isAdmin ? assigneeName : '',
        claimed_at: isAdmin ? new Date().toISOString() : null,
        task_payload: payload,
        source_ref: (opts.source === 'pmr' && opts.pmrPeriodId)
          ? { pmrPeriodId: opts.pmrPeriodId, pmrSectionId: opts.pmrSectionId || null, pmrTargetId: opts.pmrTargetId || null }
          : null,
        marketTaskId: isAdmin ? taskId : null,
        created_at: new Date().toISOString(),
        resolved_at: null,
        createdAt: ts,
        updatedAt: ts,
      };
      return firebridge.db().collection('taskMarket').doc(postId).set(post)
        .then(function () {
          if (!isAdmin) return null;
          return writeTaskFor(assigneeUid, Object.assign({}, payload, { marketPostId: postId }));
        });
    }

    doSend()
      .then(function (written) {
        console.info('[task-assign] handoff post ' + postId +
          (written ? ' + task ' + taskId + ' written to userData/' + assigneeUid + '/tasks' : ' posted (awaiting accept)'));
        // V3.157 — let the caller (e.g. PMR) back-link the task on its own doc.
        if (written && typeof opts.onCreated === 'function') {
          try { opts.onCreated(written); } catch (cbErr) { console.warn('[task-assign] onCreated failed:', cbErr); }
        }
        dismiss();
        if (window.TOAST) {
          const recipient = assigneeName || 'teammate';
          if (written) {
            const verb = paperRef ? 'Reading sent to ' : 'Task sent to ';
            TOAST.success(verb + recipient, { ttl: 2500 });
          } else {
            TOAST.success('Handoff posted — ' + recipient + ' will accept or decline on the Task Market', { ttl: 3500 });
          }
        }
      })
      .catch(function (err) {
        console.error('[task-assign] write failed:', err);
        // V3.199 — keep the modal open with the diagnostic right in the
        // form so the admin can see it without hunting through toasts.
        if (submitBtn) { submitBtn.disabled = false; submitBtn.textContent = 'Send'; }
        if (cancelBtn) cancelBtn.disabled = false;
        let hint = err.message || String(err);
        if (/permission|denied|insufficient/i.test(hint)) {
          hint += ' — likely cause: the assignee has no users/{uid} profile doc yet (they need to sign in to RM once so profile-bootstrap creates it), or your account isn\'t a lab member.';
        }
        status.style.color = '#991b1b';
        status.textContent = 'Failed to send: ' + hint;
        if (window.TOAST) {
          TOAST.error('Failed to send task', {
            detail: hint,
            retry: function () {
              doSend()
                .catch(function (err2) {
                  if (window.TOAST) TOAST.error('Retry failed', { detail: err2.message });
                });
            },
          });
        }
      });
  }

  function _esc(s) {
    return String(s == null ? '' : s).replace(/[&<>"']/g, c =>
      ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c])
    );
  }

  function _paperCardHtml(paperRef) {
    if (!paperRef || !paperRef.paperId) return '';
    const title = _esc(paperRef.paperTitle || paperRef.paperId);
    const authors = paperRef.paperAuthors ? _esc(paperRef.paperAuthors) : '';
    return (
      '<div style="background:#f5f3ff;border:1px solid #c4b5fd;border-radius:8px;padding:10px 12px;">' +
        '<div style="font-size:10px;text-transform:uppercase;letter-spacing:.5px;color:#6d28d9;margin-bottom:4px;">Paper</div>' +
        '<div style="font-size:13px;font-weight:600;color:#312e81;line-height:1.3;">' + title + '</div>' +
        (authors ? '<div style="font-size:11px;color:#6b7280;margin-top:2px;">' + authors + '</div>' : '') +
      '</div>'
    );
  }

  function _kindToggleHtml(paperRef, defaultKind) {
    if (!paperRef || !paperRef.paperId) return '';
    const a = defaultKind === 'assigned' ? ' selected' : '';
    const s = defaultKind === 'suggested' ? ' selected' : '';
    return (
      '<label style="display:grid;gap:4px;font-size:12px;color:#374151;">' +
        'Kind' +
        '<select class="ta-kind" style="padding:8px 10px;border:1px solid #d1d5db;border-radius:6px;font-size:14px;">' +
          '<option value="assigned"' + a + '>Assigned (expected to read)</option>' +
          '<option value="suggested"' + s + '>Suggested (FYI)</option>' +
        '</select>' +
      '</label>'
    );
  }

  async function open(opts) {
    opts = opts || {};
    const paperRef = opts.paperRef && opts.paperRef.paperId ? opts.paperRef : null;
    if (typeof firebridge === 'undefined' || !firebridge.getUser || !firebridge.getUser()) {
      alert('Sign in to send a task to a teammate.');
      return;
    }
    const candidates = await _loadCandidates();
    if (!candidates.length) {
      alert('No teammates available. Ask the PI to promote lab members in the website console.');
      return;
    }
    const isAdmin = firebridge.isAdmin && firebridge.isAdmin();
    const defaultKind = isAdmin ? 'assigned' : 'suggested';
    // V3.157 — heading and prefills can be customized for PMR usage.
    const heading = opts.heading || (paperRef ? 'Send paper to teammate' : 'Send task to teammate');
    const titlePrefill = opts.titlePrefill ||
      (paperRef ? ('Read: ' + (paperRef.paperTitle || paperRef.paperId)) : '');
    const titlePlaceholder = paperRef ? 'Override the auto-generated title…' : 'What needs to get done?';
    const defaultAssigneeUid = opts.defaultAssigneeUid || '';

    const overlay = document.createElement('div');
    overlay.style.cssText =
      'position:fixed;inset:0;z-index:9000;background:rgba(11,13,18,.55);' +
      'display:flex;align-items:center;justify-content:center;padding:24px;';
    const modal = document.createElement('div');
    modal.style.cssText =
      'background:#fff;color:#111;border-radius:12px;max-width:540px;width:100%;' +
      'padding:24px;box-shadow:0 24px 48px rgba(0,0,0,.4);font-family:system-ui,sans-serif;';
    modal.innerHTML =
      '<h2 style="margin:0 0 14px;font-size:18px;">' + _esc(heading) + '</h2>' +
      '<form class="ta-form" style="display:grid;gap:12px;">' +
        _paperCardHtml(paperRef) +
        '<label style="display:grid;gap:4px;font-size:12px;color:#374151;">' +
          'Assign to' +
          '<select class="ta-assignee" style="padding:8px 10px;border:1px solid #d1d5db;border-radius:6px;font-size:14px;">' +
            '<option value="">— pick a lab member —</option>' +
            candidates.map(c => '<option value="' + _esc(c.id) + '"' +
              (c.id === defaultAssigneeUid ? ' selected' : '') + '>' +
              _esc(c.name || c.email || c.id) +
              (c.category ? ' (' + _esc(c.category) + ')' : '') + '</option>').join('') +
          '</select>' +
        '</label>' +
        _kindToggleHtml(paperRef, defaultKind) +
        '<label style="display:grid;gap:4px;font-size:12px;color:#374151;">' +
          (paperRef ? 'Title (auto-generated, editable)' : 'Task title') +
          '<input class="ta-title" type="text" value="' + _esc(titlePrefill) + '" placeholder="' + _esc(titlePlaceholder) + '" ' +
            'style="padding:8px 10px;border:1px solid #d1d5db;border-radius:6px;font-size:14px;">' +
        '</label>' +
        '<div style="display:grid;grid-template-columns:1fr 1fr 1fr;gap:8px;">' +
          '<label style="display:grid;gap:4px;font-size:12px;color:#374151;">' +
            'Due date' +
            '<input class="ta-due" type="date" style="padding:8px 10px;border:1px solid #d1d5db;border-radius:6px;font-size:14px;">' +
          '</label>' +
          '<label style="display:grid;gap:4px;font-size:12px;color:#374151;">' +
            'Hours' +
            '<input class="ta-hours" type="number" step="0.25" min="0" placeholder="hrs" ' +
              'style="padding:8px 10px;border:1px solid #d1d5db;border-radius:6px;font-size:14px;">' +
          '</label>' +
          '<label style="display:grid;gap:4px;font-size:12px;color:#374151;">' +
            'Importance' +
            '<select class="ta-importance" style="padding:8px 10px;border:1px solid #d1d5db;border-radius:6px;font-size:14px;">' +
              '<option value="0">—</option>' +
              '<option value="1">★</option>' +
              '<option value="2">★★</option>' +
              '<option value="3">★★★</option>' +
              '<option value="4">★★★★</option>' +
              '<option value="5">★★★★★</option>' +
            '</select>' +
          '</label>' +
        '</div>' +
        '<label style="display:grid;gap:4px;font-size:12px;color:#374151;">' +
          'Notes (optional)' +
          '<textarea class="ta-notes" rows="3" placeholder="' + (paperRef ? 'Why this paper, what to focus on…' : 'Context, links, deadlines…') + '" ' +
            'style="padding:8px 10px;border:1px solid #d1d5db;border-radius:6px;font-size:14px;font-family:inherit;resize:vertical;"></textarea>' +
        '</label>' +
        '<div class="ta-status" style="font-size:13px;color:#6b7280;min-height:18px;"></div>' +
        '<div style="display:flex;gap:8px;justify-content:flex-end;">' +
          '<button type="button" class="btn ta-cancel">Cancel</button>' +
          '<button type="submit" class="btn btn-primary ta-submit">Send</button>' +
        '</div>' +
      '</form>';

    overlay.appendChild(modal);
    document.body.appendChild(overlay);

    function dismiss() { if (overlay.parentNode) overlay.parentNode.removeChild(overlay); }

    const form = modal.querySelector('.ta-form');
    form.addEventListener('submit', (e) => { e.preventDefault(); _submit(form, candidates, dismiss, opts); });
    modal.querySelector('.ta-cancel').addEventListener('click', dismiss);
    overlay.addEventListener('click', (e) => { if (e.target === overlay) dismiss(); });

    // V3.157 — when the assignee is prefilled (e.g. from PMR), focus the
    // title field so the user can immediately type/edit it.
    setTimeout(function () {
      const focusEl = defaultAssigneeUid
        ? modal.querySelector('.ta-title')
        : modal.querySelector('.ta-assignee');
      if (focusEl) focusEl.focus();
    }, 0);
  }

  // V3.314 — writeTaskFor exported for the task marketplace's claim
  // materialization (and any future flow that needs the canonical
  // assigned-task payload shape without the modal).
  window.TASK_ASSIGN = { open: open, writeTaskFor: writeTaskFor };
})();
