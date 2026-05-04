/* task-assign.js — Phase 8: cross-user task assignment.
 *
 * Opens a modal to select a teammate from the lab roster + Firestore users,
 * collect a task title / due date / importance / notes, and write it directly
 * into the assignee's `userData/{assigneeUid}/tasks/{taskId}` Firestore
 * subcollection with `bucket: 'assigned'`, `createdByUid`, `assignedToUid`.
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
        .filter(u => u.role && u.role !== 'guest')
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

  function _submit(form, candidates, dismiss, paperRef) {
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
    const ts = firebase.firestore.FieldValue.serverTimestamp();
    const payload = {
      id: taskId,
      text: text,
      bucket: 'assigned',
      status: 'pending',
      done: false,
      due_date: dueDate || 'TBD',
      hours_estimate: isNaN(hours) ? null : hours,
      self_importance: importance || 0,
      notes: notes,
      createdByUid: me.uid,
      createdByName: me.displayName || me.email || '',
      assignedToUid: assigneeUid,
      assignedToName: (assignee && assignee.name) || '',
      created_at: new Date().toISOString(),
      createdAt: ts,
      updatedAt: ts,
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

    // Optimistic close — dismiss immediately, fire write in the background.
    // Failures surface via TOAST.error with a "Retry" button. The assigner
    // dashboard's tasks-i-sent live-sync (collectionGroup onSnapshot) will
    // pick up the new doc and render it within a beat.
    dismiss();
    if (window.TOAST) {
      const recipient = (assignee && assignee.name) || 'teammate';
      const verb = paperRef ? 'Reading sent to ' : 'Task sent to ';
      TOAST.success(verb + recipient, { ttl: 2500 });
    }
    firebridge.db()
      .collection('userData').doc(assigneeUid)
      .collection('tasks').doc(taskId)
      .set(payload)
      .catch(function (err) {
        console.error('[task-assign] write failed:', err);
        if (window.TOAST) {
          TOAST.error('Failed to send task', {
            detail: err.message || String(err),
            retry: function () {
              firebridge.db()
                .collection('userData').doc(assigneeUid)
                .collection('tasks').doc(taskId)
                .set(payload)
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
    const heading = paperRef ? 'Send paper to teammate' : 'Send task to teammate';
    const titlePrefill = paperRef ? ('Read: ' + (paperRef.paperTitle || paperRef.paperId)) : '';
    const titlePlaceholder = paperRef ? 'Override the auto-generated title…' : 'What needs to get done?';

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
            candidates.map(c => '<option value="' + _esc(c.id) + '">' +
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
    form.addEventListener('submit', (e) => { e.preventDefault(); _submit(form, candidates, dismiss, paperRef); });
    modal.querySelector('.ta-cancel').addEventListener('click', dismiss);
    overlay.addEventListener('click', (e) => { if (e.target === overlay) dismiss(); });

    // Focus the assignee picker first; once they pick, user will Tab to title.
    setTimeout(() => modal.querySelector('.ta-assignee').focus(), 0);
  }

  window.TASK_ASSIGN = { open };
})();
