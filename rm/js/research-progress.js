/* research-progress.js — V3.551 (Research Foci: per-thrust progress)
 *
 * The PI's "how is this thrust going" section on a focus detail page.
 * For every student attached to the focus (plus, on concept/specialty
 * cards, students attached to the outputs/concepts that build on it),
 * shows the recent weekly-focus trail: per-week outcome icons
 * (✅ success / ➗ partial / ❌ failure), focus-task completion, report
 * summaries and notebook deep-links — sourced from the student's
 * focusAreas where focus_ref.id == this card.
 *
 * VISIBILITY IS THE EXISTING RULES, NOT A NEW SURFACE: focusAreas are
 * readable by owner ∥ mentor ∥ admin only. Each student's read is
 * attempted independently and permission-denied degrades to a quiet
 * "no visibility" row — a non-mentor lab member sees the roster and
 * nothing private. Notebook links are titles/ids only (the notebook
 * page enforces its own owner-only access).
 *
 * Globals: window.RESEARCH_PROGRESS.
 */
(function () {
  'use strict';

  var RD = window.RESEARCH_DATA;
  var esc = RD.esc;
  var WEEKS_BACK = 12;

  /* Students in scope: the card's own members, plus members of cards that
   * build on it (outputs under a concept; concepts+outputs over a
   * specialty). Dedup, preserve order. */
  function scopedMembers(f, allFoci) {
    var uids = (f.member_uids || []).slice();
    (allFoci || []).forEach(function (x) {
      var l = x.links || {};
      var hit =
        (f.level === 'concept' && (l.concept_ids || []).indexOf(f.id) !== -1) ||
        (f.level === 'specialty' && (l.specialty_ids || []).indexOf(f.id) !== -1);
      if (hit) (x.member_uids || []).forEach(function (u) { if (uids.indexOf(u) === -1) uids.push(u); });
    });
    return uids;
  }

  async function userName(uid) {
    try {
      var doc = await firebridge.db().collection('users').doc(uid).get();
      return (doc.exists && (doc.data().name || doc.data().displayName)) || uid.slice(0, 8) + '…';
    } catch (e) { return uid.slice(0, 8) + '…'; }
  }

  async function studentTrail(uid, fociId) {
    // owner/mentor/admin read; anything else throws → caller degrades.
    var from = FOCUS_AREAS.weekIdForOffset(-WEEKS_BACK);
    var to = FOCUS_AREAS.weekIdForOffset(0);
    var rows = await FOCUS_AREAS.listForRange(uid, from, to);
    return rows.filter(function (fa) { return fa.focus_ref && fa.focus_ref.id === fociId; });
  }

  function outcomeIcon(fa) {
    if (fa.report) {
      var om = FOCUS_AREAS.OUTCOME_META[fa.report.outcome] || {};
      return om.icon || '·';
    }
    if (fa.status === 'confirmed') return '⏳';
    return '◌'; // proposed / edited — not yet confirmed
  }

  function studentRow(name, trail) {
    if (!trail.length) {
      return '<div class="rf-prog-row"><span class="rf-prog-name">' + esc(name) + '</span>' +
        '<span class="rf-empty-sm">No weekly focus aligned with this thrust yet.</span></div>';
    }
    var byWeek = trail.slice().sort(function (a, b) { return (a.weekId || '').localeCompare(b.weekId || ''); });
    var icons = byWeek.map(function (fa) {
      return '<span class="rf-prog-wk" title="' + esc(fa.weekId + ': ' + fa.title + (fa.report && fa.report.summary ? ' — ' + fa.report.summary : '')) + '">' + outcomeIcon(fa) + '</span>';
    }).join('');
    var totalTasks = 0, doneTasks = 0;
    trail.forEach(function (fa) {
      (fa.tasks || []).forEach(function (t) { totalTasks++; if (t.done) doneTasks++; });
    });
    var latest = byWeek[byWeek.length - 1];
    var latestBits = '<span class="rf-prog-latest">' + esc(latest.weekId) + ': ' + esc(latest.title) + '</span>';
    /* V3.602 — which roadmap analyses this student's weeks actually hit.
     * The card-level trail says "they worked on the GELS paper"; this
     * says which measurement, which is the answer the PI wants. */
    var seen = [];
    trail.forEach(function (fa) {
      var r = fa.focus_ref;
      if (r && r.analysis_id && seen.indexOf(r.analysis_id) === -1) seen.push(r.analysis_id);
    });
    var anBits = seen.length
      ? '<span class="rf-prog-ans">' + seen.map(function (aid) {
          var t = '';
          trail.forEach(function (fa) {
            if (fa.focus_ref && fa.focus_ref.analysis_id === aid) t = fa.focus_ref.analysis_title || aid;
          });
          return '<a class="rf-prog-an" href="#rmap-' + esc(aid) + '">' + esc(t) + '</a>';
        }).join('') + '</span>'
      : '';
    var links = [];
    trail.forEach(function (fa) {
      ((fa.report && fa.report.notebook_entry_ids) || []).forEach(function (id) {
        links.push('<a class="rf-prog-nb" href="/rm/pages/lab-notebook.html?entry=' + encodeURIComponent(id) + '">📓</a>');
      });
    });
    return '<div class="rf-prog-row">' +
      '<span class="rf-prog-name">' + esc(name) + '</span>' +
      '<span class="rf-prog-trail">' + icons + '</span>' +
      (totalTasks ? '<span class="rf-prog-tasks">' + doneTasks + '/' + totalTasks + ' tasks</span>' : '') +
      latestBits + anBits +
      (links.length ? '<span class="rf-prog-links">' + links.join('') + '</span>' : '') +
    '</div>';
  }

  async function render(host, f, pageState) {
    if (!window.FOCUS_AREAS) { host.innerHTML = ''; return; }
    var uids = scopedMembers(f, pageState.foci);
    if (!uids.length) { host.innerHTML = ''; return; }

    host.innerHTML = '<section class="rf-sec rf-sec-progress"><h2>Progress on this thrust</h2>' +
      '<p class="rf-empty-sm">Loading weekly focus trails…</p></section>';
    var sec = host.querySelector('.rf-sec-progress');

    var rows = [];
    var hidden = 0;
    for (var i = 0; i < uids.length; i++) {
      var uid = uids[i];
      var name = await userName(uid);
      try {
        // Attempt the read for everyone; firestore.rules decides (owner ∥
        // mentor ∥ admin). listForRange returns [] on permission-denied, so
        // a peer just sees the neutral row below.
        var trail = await studentTrail(uid, f.id);
        if (trail.length) {
          rows.push(studentRow(name, trail));
        } else {
          rows.push('<div class="rf-prog-row"><span class="rf-prog-name">' + esc(name) + '</span>' +
            '<span class="rf-empty-sm">No aligned weekly focus visible to you.</span></div>');
          hidden++;
        }
      } catch (e) {
        rows.push('<div class="rf-prog-row"><span class="rf-prog-name">' + esc(name) + '</span>' +
          '<span class="rf-empty-sm">—</span></div>');
        hidden++;
      }
    }

    var legend = '<div class="rf-prog-legend">✅ success · ➗ partial · ❌ did not work · ⏳ confirmed, in progress · ◌ proposed · last ' + WEEKS_BACK + ' weeks</div>';
    sec.innerHTML = '<h2>Progress on this thrust</h2>' + legend + rows.join('') +
      (hidden === uids.length && uids.length
        ? '<p class="rf-empty-sm">Weekly-focus detail is visible to the student, their mentors, and the PI.</p>' : '');
  }

  window.RESEARCH_PROGRESS = { render: render };
})();
