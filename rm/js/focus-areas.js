/* focus-areas.js — V3.536 (Weekly Focus program R1)
 *
 * Shared data layer for the mentor↔mentee weekly-focus loop. A focus
 * area is the week's WHY — an outcome area the mentor and student agree
 * on — and it CONTAINS tasks (the concrete WHAT). The two concepts are
 * deliberately kept in one doc, separate from the buckets task system,
 * so the hierarchy never blurs.
 *
 * Doc: userData/{studentUid}/focusAreas/{focusId}
 *   { id, weekId: 'YYYY-Wnn', title, description,
 *     status: 'proposed' | 'mentee_edited' | 'confirmed' | 'reported',
 *     source: 'mentor' | 'student',
 *     created_by, assigned_by, updated_by,
 *     confirmed_by, confirmed_at,
 *     report: null | { outcome: 'success'|'partial'|'failure', summary,
 *                      notebook_entry_ids: [], reported_at },
 *     tasks: [ { id, text, done, done_at, created_by, planned_item_ids: [] } ],
 *     paper_refs: [ { id, title } ],   // V3.543 — paper drafts this focus advances
 *     focus_ref: null | { id, title, level },  // V3.550 — the research focus
 *                                      // (researchFoci card) this week's work
 *                                      // advances; My Day / PMR inherit it
 *     created_at, updated_at, ownerUid, schema_version: 1 }
 *
 * Workflow: mentor drafts (proposed) → mentee edits description
 * (mentee_edited, back to mentor) → mentor signs off (confirmed — the
 * expectation is set) → mentee reports success/partial/failure with the
 * lab notebook as the narrative surface (reported) → PMR rolls it up.
 * Student-freeform focus (from the My Day composer) is source:'student',
 * status:'proposed' — visible drift the mentor can adopt or discuss.
 *
 * Access: owner || isMentorOf(owner) || admin (firestore.rules V3.536).
 * Direct firebridge.db() refs — cross-user reads/writes bypass the
 * adapter (PMR pattern). Status transitions are client-enforced
 * (admin-trusted lab convention): only mentors/admins confirm.
 *
 * Globals: window.FOCUS_AREAS
 */
(function () {
  'use strict';

  function db()  { return firebridge.db(); }
  function me()  { var u = firebridge.getUser(); return u ? u.uid : null; }
  function isoNow() { return new Date().toISOString(); }
  function newId(prefix) {
    return prefix + '-' + Date.now().toString(36) + '-' + Math.random().toString(36).slice(2, 6);
  }
  function ref(studentUid) {
    return db().collection('userData').doc(studentUid).collection('focusAreas');
  }

  /* ISO week id for a YYYY-MM-DD (or today) — same math as huddle.js /
   * day-distribute.js so focus weeks line up with huddle weeks. */
  function weekIdFor(dateStr) {
    var p = dateStr ? String(dateStr).split('-') : null;
    var d = p ? new Date(Date.UTC(+p[0], +p[1] - 1, +p[2]))
              : (function () { var n = new Date(); return new Date(Date.UTC(n.getFullYear(), n.getMonth(), n.getDate())); })();
    d.setUTCDate(d.getUTCDate() + 3 - ((d.getUTCDay() + 6) % 7));
    var jan4 = new Date(Date.UTC(d.getUTCFullYear(), 0, 4));
    var weekNum = 1 + Math.round(((d - jan4) / 86400000 - 3 + ((jan4.getUTCDay() + 6) % 7)) / 7);
    return d.getUTCFullYear() + '-W' + String(weekNum).padStart(2, '0');
  }

  /* Monday of an offset-from-current week → 'YYYY-Wnn' (week nav). */
  function weekIdForOffset(offset) {
    var d = new Date();
    d.setDate(d.getDate() + (offset || 0) * 7);
    var y = d.getFullYear(), m = String(d.getMonth() + 1).padStart(2, '0'), dd = String(d.getDate()).padStart(2, '0');
    return weekIdFor(y + '-' + m + '-' + dd);
  }

  var STATUS_META = {
    proposed:      { label: 'Proposed',       color: '#b45309', bg: '#fef3c7' },
    mentee_edited: { label: 'Edited — needs sign-off', color: '#1e40af', bg: '#dbeafe' },
    confirmed:     { label: 'Confirmed',      color: '#166534', bg: '#dcfce7' },
    reported:      { label: 'Reported',       color: '#374151', bg: '#e5e7eb' },
  };
  var OUTCOME_META = {
    success: { label: 'Success', icon: '✅' },
    partial: { label: 'Partial', icon: '➗' },
    failure: { label: 'Did not work', icon: '❌' },
  };

  function hydrate(d) {
    d = d || {};
    d.tasks = Array.isArray(d.tasks) ? d.tasks : [];
    d.paper_refs = Array.isArray(d.paper_refs) ? d.paper_refs : [];
    d.focus_ref = (d.focus_ref && d.focus_ref.id) ? d.focus_ref : null;   // V3.550
    d.status = STATUS_META[d.status] ? d.status : 'proposed';
    d.report = d.report || null;
    return d;
  }

  async function listForWeek(studentUid, weekId) {
    try {
      var snap = await ref(studentUid).where('weekId', '==', weekId).get();
      return snap.docs.map(function (d) { return hydrate(Object.assign({ id: d.id }, d.data())); })
        .sort(function (a, b) { return (a.created_at || '').localeCompare(b.created_at || ''); });
    } catch (err) {
      console.warn('[focus-areas] listForWeek failed:', err && err.message);
      return [];
    }
  }

  /* All focus areas for a student whose weekId falls in [fromWeekId,
   * toWeekId] (string compare works on 'YYYY-Wnn'). Used by PMR. */
  async function listForRange(studentUid, fromWeekId, toWeekId) {
    try {
      var snap = await ref(studentUid)
        .where('weekId', '>=', fromWeekId).where('weekId', '<=', toWeekId).get();
      return snap.docs.map(function (d) { return hydrate(Object.assign({ id: d.id }, d.data())); })
        .sort(function (a, b) {
          return (a.weekId || '').localeCompare(b.weekId || '') || (a.created_at || '').localeCompare(b.created_at || '');
        });
    } catch (err) {
      console.warn('[focus-areas] listForRange failed:', err && err.message);
      return [];
    }
  }

  /** Create a focus area for a student (mentor or the student themself). */
  async function create(studentUid, fields) {
    var uid = me();
    var isSelf = uid === studentUid;
    var doc = {
      id: newId('fa'),
      weekId: fields.weekId || weekIdFor(),
      title: String(fields.title || '').slice(0, 200),
      description: String(fields.description || ''),
      status: 'proposed',
      source: isSelf ? 'student' : 'mentor',
      created_by: uid,
      assigned_by: isSelf ? null : uid,
      updated_by: uid,
      confirmed_by: null, confirmed_at: null,
      report: null,
      tasks: [],
      paper_refs: Array.isArray(fields.paper_refs) ? fields.paper_refs : [],
      focus_ref: (fields.focus_ref && fields.focus_ref.id) ? fields.focus_ref : null,   // V3.550
      created_at: isoNow(), updated_at: isoNow(),
      ownerUid: studentUid, schema_version: 1,
    };
    await ref(studentUid).doc(doc.id).set(doc);
    return doc;
  }

  /** Patch title/description. A mentee editing a non-proposed focus
   * flips it to mentee_edited (back to the mentor for sign-off); a
   * mentor editing keeps/returns it to proposed unless already
   * confirmed+reported. */
  async function update(studentUid, focus, patch) {
    var uid = me();
    var next = Object.assign({}, patch, { updated_by: uid, updated_at: isoNow() });
    var isSelf = uid === studentUid;
    if ((patch.title != null || patch.description != null) && focus.status !== 'reported') {
      if (isSelf && focus.status === 'confirmed') next.status = 'mentee_edited';
      else if (isSelf && focus.status === 'proposed' && focus.source === 'mentor') next.status = 'mentee_edited';
      // mentor edits leave the status where it is (their own draft) —
      // confirming is an explicit act, below.
    }
    await ref(studentUid).doc(focus.id).update(next);
    return Object.assign(focus, next);
  }

  /** Mentor/admin sign-off — the expectation is set. */
  async function confirm(studentUid, focus) {
    var uid = me();
    var patch = {
      status: 'confirmed', confirmed_by: uid, confirmed_at: isoNow(),
      updated_by: uid, updated_at: isoNow(),
    };
    await ref(studentUid).doc(focus.id).update(patch);
    return Object.assign(focus, patch);
  }

  /** Mentee outcome report — notebook entries carry the narrative. */
  async function saveReport(studentUid, focus, report) {
    var uid = me();
    var patch = {
      status: 'reported',
      report: {
        outcome: OUTCOME_META[report.outcome] ? report.outcome : 'partial',
        summary: String(report.summary || ''),
        notebook_entry_ids: Array.isArray(report.notebook_entry_ids) ? report.notebook_entry_ids : [],
        reported_at: isoNow(),
      },
      updated_by: uid, updated_at: isoNow(),
    };
    await ref(studentUid).doc(focus.id).update(patch);
    return Object.assign(focus, patch);
  }

  /* V3.602 — `focus` may be the doc (preferred) or a bare id. Passing the
   * doc lets us drop the roadmapClaims mirror too; with only an id the
   * claim is left to age out of the hub band's current-week filter. */
  async function remove(studentUid, focus) {
    var focusId = (focus && focus.id) ? focus.id : focus;
    await ref(studentUid).doc(focusId).delete();
    if (focus && focus.focus_ref && focus.focus_ref.analysis_id &&
        window.ROADMAP_DATA && studentUid === me()) {
      try { await ROADMAP_DATA.clearClaim(studentUid, focus.focus_ref.analysis_id); }
      catch (e) { /* mirror only */ }
    }
  }

  /* ── tasks under a focus (the WHAT beneath the WHY) ──────── */

  async function addTask(studentUid, focus, text) {
    var task = {
      id: newId('ft'), text: String(text || '').slice(0, 300),
      done: false, done_at: null,
      created_by: me(), planned_item_ids: [],
    };
    focus.tasks = (focus.tasks || []).concat([task]);
    await ref(studentUid).doc(focus.id).update({ tasks: focus.tasks, updated_by: me(), updated_at: isoNow() });
    return task;
  }

  async function setTaskDone(studentUid, focus, taskId, done, plannedItemId) {
    var tasks = (focus.tasks || []).map(function (t) {
      if (t.id !== taskId) return t;
      var next = Object.assign({}, t, { done: !!done, done_at: done ? isoNow() : null });
      if (plannedItemId && (next.planned_item_ids || []).indexOf(plannedItemId) < 0) {
        next.planned_item_ids = (next.planned_item_ids || []).concat([plannedItemId]);
      }
      return next;
    });
    focus.tasks = tasks;
    await ref(studentUid).doc(focus.id).update({ tasks: tasks, updated_by: me(), updated_at: isoNow() });
  }

  async function removeTask(studentUid, focus, taskId) {
    focus.tasks = (focus.tasks || []).filter(function (t) { return t.id !== taskId; });
    await ref(studentUid).doc(focus.id).update({ tasks: focus.tasks, updated_by: me(), updated_at: isoNow() });
  }

  /** V3.543 — edit a task's text in place (mentor or mentee). */
  async function updateTaskText(studentUid, focus, taskId, text) {
    focus.tasks = (focus.tasks || []).map(function (t) {
      return t.id === taskId ? Object.assign({}, t, { text: String(text || '').slice(0, 300) }) : t;
    });
    await ref(studentUid).doc(focus.id).update({ tasks: focus.tasks, updated_by: me(), updated_at: isoNow() });
  }

  /* ── paper links (V3.543): the research this focus advances ── */

  async function addPaperRef(studentUid, focus, paperRef) {
    var refs = (focus.paper_refs || []).filter(function (r) { return r.id !== paperRef.id; });
    refs.push({ id: paperRef.id, title: paperRef.title || '(untitled draft)' });
    focus.paper_refs = refs;
    await ref(studentUid).doc(focus.id).update({ paper_refs: refs, updated_by: me(), updated_at: isoNow() });
  }

  async function removePaperRef(studentUid, focus, paperId) {
    focus.paper_refs = (focus.paper_refs || []).filter(function (r) { return r.id !== paperId; });
    await ref(studentUid).doc(focus.id).update({ paper_refs: focus.paper_refs, updated_by: me(), updated_at: isoNow() });
  }

  /* ── research-focus link (V3.550): the thrust this week advances ── */

  /** Set (or clear, with focusRef=null) the researchFoci card a weekly
   * focus aligns with. My Day chips + PMR grouping inherit through this.
   *
   * V3.602 — focusRef may also name a specific ANALYSIS on that card's
   * roadmap (`analysis_id` / `analysis_title` / `experiment_id`), which
   * is the level real work actually happens at: "GELS paper" is a
   * quarter, "void space over time" is a week. Extra keys are additive —
   * every existing consumer reads only `.id` and `.title`.
   *
   * When an analysis is named we also write the lab-readable
   * roadmapClaims mirror, because the focusAreas rule is
   * owner-or-mentor-or-admin and the research hub has to show the WHOLE
   * lab who picked up what. */
  async function setFocusRef(studentUid, focus, focusRef) {
    var prev = focus.focus_ref || null;
    var val = null;
    if (focusRef && focusRef.id) {
      val = { id: focusRef.id, title: focusRef.title || focusRef.id, level: focusRef.level || 'concept' };
      if (focusRef.analysis_id) {
        val.analysis_id = focusRef.analysis_id;
        val.analysis_title = focusRef.analysis_title || '';
        val.experiment_id = focusRef.experiment_id || null;
      }
    }
    focus.focus_ref = val;
    await ref(studentUid).doc(focus.id).update({ focus_ref: val, updated_by: me(), updated_at: isoNow() });
    await syncClaim(studentUid, focus, prev, val);
  }

  /* Keep roadmapClaims in step with focus_ref. Best-effort in both
   * directions: the mirror is a convenience for the hub band, never the
   * source of truth, so a failure here must not fail the alignment the
   * user just made. Only the owner may write their own claim (rules), so
   * a MENTOR aligning a mentee's week cannot mirror it — the hub band
   * falls back to showing nothing for that student rather than lying. */
  async function syncClaim(studentUid, focus, prev, next) {
    if (!window.ROADMAP_DATA || studentUid !== me()) return;
    try {
      if (prev && prev.analysis_id && (!next || next.analysis_id !== prev.analysis_id)) {
        await ROADMAP_DATA.clearClaim(studentUid, prev.analysis_id);
      }
      if (next && next.analysis_id) {
        await ROADMAP_DATA.setClaim({
          uid: studentUid,
          foci_id: next.id,
          experiment_id: next.experiment_id || null,
          analysis_id: next.analysis_id,
          analysis_title: next.analysis_title || '',
          week_id: focus.weekId || weekIdFor(),
        });
      }
    } catch (e) { console.warn('[focus-areas] claim mirror failed:', e && e.message); }
  }

  /** The things a weekly focus can align with, flattened: every
   * non-archived researchFoci card, plus — for output cards with a
   * roadmap — each individual ANALYSIS as its own pickable row.
   *
   * Rows carry a `key` (`<fociId>` or `<fociId>::<analysisId>`) because
   * a card and its analyses share the card's id, so option values have to
   * be composite. Cached for the page's lifetime — the map changes
   * rarely, and the roadmaps ride along in the same read. */
  var _fociCache = null;
  async function listFociForPicker() {
    if (_fociCache) return _fociCache;
    try {
      var snap = await db().collection('researchFoci').get();
      var levelOrder = { specialty: 0, concept: 1, output: 2 };
      var rows = [];
      snap.docs.forEach(function (d) {
        var x = d.data() || {};
        var status = x.status || '';
        if (status === 'archived' || status === 'closed') return;
        var card = {
          key: d.id, id: d.id, title: x.title || d.id,
          level: x.level || 'concept', icon: x.icon || '', status: status,
        };
        rows.push(card);
        if (!window.ROADMAP_DATA) return;
        ROADMAP_DATA.flattenAnalyses(x.roadmap).forEach(function (a) {
          // A finished analysis is not something to plan a week around.
          if (a.analysis.status === 'done') return;
          rows.push({
            key: d.id + '::' + a.analysis_id,
            id: d.id, title: card.title, level: card.level, icon: card.icon, status: status,
            analysis_id: a.analysis_id,
            analysis_title: a.analysis_title,
            experiment_id: a.experiment_id,
            experiment_title: a.experiment_title,
            label: card.title + ' › ' + a.analysis_title,
          });
        });
      });
      _fociCache = rows.sort(function (a, b) {
        return (levelOrder[a.level] || 0) - (levelOrder[b.level] || 0) ||
               a.title.localeCompare(b.title) ||
               (a.analysis_title || '').localeCompare(b.analysis_title || '');
      });
      return _fociCache;
    } catch (err) {
      console.warn('[focus-areas] listFociForPicker failed:', err && err.message);
      return [];
    }
  }

  /** How a picker row reads in a <select> / chip: the card alone, or the
   * card and the analysis it drills into. */
  function focusRefLabel(rf) {
    if (!rf) return '';
    return rf.analysis_title ? (rf.title + ' › ' + rf.analysis_title) : rf.title;
  }

  /** Paper drafts the student is writing (papers where authorUids
   * array-contains the student, excluding library entries — the exact
   * PMR paper_writing query; papers are lab-readable, so mentors can
   * pick from a mentee's drafts with no rules change). */
  async function listDrafts(studentUid) {
    try {
      var snap = await db().collection('papers')
        .where('authorUids', 'array-contains', studentUid).get();
      var rows = [];
      snap.forEach(function (d) {
        var data = d.data() || {};
        if (data.is_library_entry === true) return;
        rows.push({
          id: d.id,
          title: data.title || data.meta_title || '(untitled draft)',
          status: data.status || 'drafting',
          updatedAt: data.updated_at || '',
        });
      });
      rows.sort(function (a, b) { return (b.updatedAt || '').localeCompare(a.updatedAt || ''); });
      return rows;
    } catch (err) {
      console.warn('[focus-areas] listDrafts failed:', err && err.message);
      return [];
    }
  }

  /* ── people helpers (who do I mentor?) ───────────────────── */

  /** Mentees of the signed-in user (V3.243 relationship); admins get the
   * whole lab-member roster. Alumni and guests are excluded (V3.542 —
   * Team Focus is for active members). Returns [{uid, name, category}]. */
  async function listMentees() {
    try {
      var uid = me();
      if (!uid) return [];
      var rows = [];
      if (firebridge.isAdmin && firebridge.isAdmin()) {
        var all = await db().collection('users').get();
        rows = all.docs.map(function (d) { return Object.assign({ uid: d.id }, d.data()); })
          .filter(function (u) { return u.role && u.role !== 'guest' && u.uid !== uid; });
      } else {
        var snap = await db().collection('users')
          .where('mentor_uids', 'array-contains', uid).get();
        rows = snap.docs.map(function (d) { return Object.assign({ uid: d.id }, d.data()); });
      }
      return rows
        .filter(function (u) { return u.category !== 'alumni' && u.category !== 'guest'; })
        .map(function (u) {
          return { uid: u.uid, name: u.name || u.email || u.uid, category: u.category || '' };
        }).sort(function (a, b) { return a.name.localeCompare(b.name); });
    } catch (err) {
      console.warn('[focus-areas] listMentees failed:', err && err.message);
      return [];
    }
  }

  window.FOCUS_AREAS = {
    weekIdFor: weekIdFor,
    weekIdForOffset: weekIdForOffset,
    listForWeek: listForWeek,
    listForRange: listForRange,
    create: create,
    update: update,
    confirm: confirm,
    saveReport: saveReport,
    remove: remove,
    addTask: addTask,
    setTaskDone: setTaskDone,
    removeTask: removeTask,
    updateTaskText: updateTaskText,
    addPaperRef: addPaperRef,
    removePaperRef: removePaperRef,
    setFocusRef: setFocusRef,           // V3.550
    listFociForPicker: listFociForPicker, // V3.550 (+V3.602 analysis rows)
    focusRefLabel: focusRefLabel,       // V3.602
    listDrafts: listDrafts,
    listMentees: listMentees,
    STATUS_META: STATUS_META,
    OUTCOME_META: OUTCOME_META,
  };
})();
