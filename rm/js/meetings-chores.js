/* meetings-chores.js — weekly lab-chore board (V3.743).
 *
 * One labChores/{weekId} doc per ISO week (Monday-anchored, same weekId
 * math as My Week). Two maps with two owners:
 *   assignments: { <choreId>: { uid, name, taskId, assignedBy } } — coordinator
 *   completions: { <uid>: { <choreId>: { doneAt } } }             — each member,
 *                                                                   own key only
 * The "Present at lab meeting" row is DERIVED from the meeting's presenters
 * and is never assigned by hand or by the rotation.
 *
 * "⟳ Fill the rest" (MEETINGS.fillRest) only touches chores with no name on
 * them: pool = members − this week's presenters − reviewers − anyone already
 * hand-assigned, ordered by fewest chores over the last 8 weeks, then least
 * recently. Every assignment also writes a task to the assignee's My Week
 * (MEETINGS.assignChore → TASK_ASSIGN.writeTaskFor).
 *
 * Reads only the window.MEETINGS surface.
 */
(function () {
  'use strict';

  const M = () => window.MEETINGS;
  const esc = s => M().esc(s);
  const icon = (n, o) => M().icon(n, o);

  function weekLabel(weekId) {
    const A = M();
    const mon = A.mondayOfWeekId(weekId);
    return 'Week of ' + A.fmtDate(mon);
  }
  function shiftWeek(weekId, n) {
    const A = M();
    return A.weekIdFor(A.addDays(A.mondayOfWeekId(weekId), 7 * n));
  }

  function render(weekId) {
    const A = M();
    const c = A.cfg();
    const coord = A.isCoordinator();
    const doc = A.choreDoc(weekId);
    const m = A.meetingForWeek(weekId);
    const assignments = (doc && doc.assignments) || {};
    const completions = (doc && doc.completions) || {};
    const presenters = m ? A.presentersOf(m) : [];
    const thisWeek = A.weekIdFor(A.todayStr());
    const isPast = weekId < thisWeek;
    const me = A.me();

    const rows = c.chores.map(ch => {
      if (ch.derived || ch.id === 'present') {
        const who = m && A.kindOf(m) === 'flash' ? '<span class="mtg-muted">everyone — flash talks</span>'
          : presenters.length ? presenters.map(p => A.avatar(p.uid, p.name) + ' ' + esc(A.firstName(p.uid, p.name))).join(' &amp; ')
          : '<span class="mtg-muted">' + (m ? 'no presenter yet' : 'no meeting this week') + '</span>';
        return '<div class="mtg-chore mtg-chore-derived"><span class="mtg-chore-label">' + esc(ch.label) + ' <small class="mtg-muted">from the rotation</small></span><span class="mtg-chore-who">' + who + '</span><span class="mtg-chore-done"></span></div>';
      }
      const a = assignments[ch.id];
      const done = !!(a && completions[a.uid] && completions[a.uid][ch.id]);
      const mine = !!(a && a.uid === me);
      const canTick = a && (mine || coord);
      return '<div class="mtg-chore' + (done ? ' mtg-chore-ok' : '') + (mine ? ' mtg-chore-me' : '') + '">' +
        '<span class="mtg-chore-label">' + esc(ch.label) + '</span>' +
        '<span class="mtg-chore-who">' +
          (a ? A.avatar(a.uid, a.name) + ' <span>' + esc(A.memberName(a.uid, a.name)) + (mine ? ' <span class="mtg-you">you</span>' : '') + '</span>' : '<span class="mtg-muted">—</span>') +
          (coord && !isPast ? ' <button type="button" class="mtg-btn mtg-btn-xs mtg-btn-ghost" data-act="chore-assign" data-week="' + esc(weekId) + '" data-chore="' + esc(ch.id) + '">' + (a ? 'Change' : icon('plus', { size: 'xs' }) + ' Assign') + '</button>' : '') +
        '</span>' +
        '<span class="mtg-chore-done">' + (a ? '<label class="mtg-check" title="' + (canTick ? 'Mark done' : 'Only ' + esc(A.firstName(a.uid, a.name)) + ' can tick this') + '"><input type="checkbox" data-act="chore-tick" data-week="' + esc(weekId) + '" data-chore="' + esc(ch.id) + '" data-uid="' + esc(a.uid) + '"' + (done ? ' checked' : '') + (canTick ? '' : ' disabled') + '><span></span></label>' : '') + '</span>' +
      '</div>';
    }).join('');

    const openCount = c.chores.filter(ch => !ch.derived && ch.id !== 'present' && !assignments[ch.id]).length;
    const nav = '<div class="mtg-toolbar">' +
      '<div class="mtg-seg"><button type="button" data-act="chore-week" data-dir="-1" title="Previous week">‹</button><button type="button" class="on">' + esc(weekLabel(weekId)) + (weekId === thisWeek ? ' · this week' : '') + '</button><button type="button" data-act="chore-week" data-dir="1" title="Next week">›</button></div>' +
      '<div class="mtg-toolbar-right">' +
        (m ? '<span class="mtg-muted mtg-tiny">Meeting ' + esc(A.fmtDate(m.date)) + '</span>' : '<span class="mtg-muted mtg-tiny">No meeting this week</span>') +
        (coord && !isPast ? '<button type="button" class="mtg-btn mtg-btn-sm' + (openCount ? ' mtg-btn-primary' : '') + '" data-act="chore-fill" data-week="' + esc(weekId) + '"' + (openCount ? '' : ' disabled') + '>' + icon('arrow-path', { size: 'sm' }) + ' Fill the rest' + (openCount ? ' (' + openCount + ')' : '') + '</button>' : '') +
        (coord && Object.keys(assignments).length ? '<button type="button" class="mtg-btn mtg-btn-sm mtg-btn-ghost" data-act="chore-clear" data-week="' + esc(weekId) + '">Clear</button>' : '') +
      '</div></div>';

    // fairness: last 8 weeks before this one
    const counts = {};
    A.state.chores.filter(x => x.weekId && x.weekId < weekId).sort((a, b) => b.weekId.localeCompare(a.weekId)).slice(0, 8)
      .forEach(w => Object.values(w.assignments || {}).forEach(a => { counts[a.uid] = (counts[a.uid] || 0) + 1; }));
    const fair = A.rosterMembers().map(u => ({ u, n: counts[u.uid] || 0 })).sort((x, y) => y.n - x.n || x.u.name.localeCompare(y.u.name));
    const fairness = fair.some(f => f.n) ? '<details class="mtg-card mtg-details"><summary>Who’s done what — last 8 weeks</summary><div class="mtg-fair">' +
      fair.map(f => '<span class="mtg-fair-row">' + A.avatar(f.u.uid) + ' ' + esc(A.firstName(f.u.uid)) + ' <b>' + f.n + '</b></span>').join('') + '</div></details>' : '';

    return nav +
      '<section class="mtg-card"><div class="mtg-chores">' + rows + '</div>' +
        (!coord ? '<p class="mtg-muted mtg-tiny">' + esc(A.memberName(c.primaryCoordinatorUid) || 'The coordinator') + ' assigns chores each week. Yours also appear at the top of your My Week — tick them here or there.</p>'
                : '<p class="mtg-muted mtg-tiny">Assign the ones you care about by hand, then “Fill the rest” rotates the remainder fairly, skipping this week’s presenter. Each assignment lands on that person’s My Week.</p>') +
      '</section>' + fairness;
  }

  async function onAct(act, btn) {
    const A = M();
    const weekId = btn.dataset.week || A.choreWeekId();
    if (act === 'chore-week') {
      A.state.ui.choreWeek = shiftWeek(A.choreWeekId(), +btn.dataset.dir);
      A.render();
    } else if (act === 'chore-assign') {
      const chore = A.cfg().chores.find(x => x.id === btn.dataset.chore);
      const doc = A.choreDoc(weekId);
      const cur = doc && doc.assignments && doc.assignments[btn.dataset.chore];
      const m = A.meetingForWeek(weekId);
      const pres = new Set(m ? A.presentersOf(m).map(p => p.uid) : []);
      const taken = {};
      Object.keys((doc && doc.assignments) || {}).forEach(cid => { const a = doc.assignments[cid]; if (a) taken[a.uid] = (taken[a.uid] || []).concat([cid]); });
      A.openMemberPicker((chore ? chore.label : 'Chore') + ' — ' + weekLabel(weekId), {
        allowNone: !!cur, noneLabel: 'Unassign', only: A.rosterMembers().map(u => u.uid),
        emptyText: 'Nobody on the meeting roster — set it in Settings → Roster.',
        hint: u => [pres.has(u.uid) ? 'presenting' : '', taken[u.uid] ? taken[u.uid].length + ' this week' : ''].filter(Boolean).join(' · '),
      }, uid => A.assignChore(weekId, btn.dataset.chore, uid || null));
    } else if (act === 'chore-fill') {
      btn.disabled = true;
      try { await A.fillRest(weekId); } finally { A.render(); }
    } else if (act === 'chore-clear') {
      A.openConfirm('Clear every assignment for ' + weekLabel(weekId) + '? Their My Week cards are removed too.', 'Clear week', async () => {
        const doc = A.choreDoc(weekId);
        const ids = Object.keys((doc && doc.assignments) || {});
        for (const cid of ids) await A.assignChore(weekId, cid, null);
        A.toast('success', 'Cleared ' + ids.length + ' assignment' + (ids.length === 1 ? '' : 's'));
      }, true);
    }
  }

  window.MEETINGS_CHORES = { render, onAct, onChange: async () => {}, onSubmit: async () => {} };
})();
