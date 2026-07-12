/* task-pmr-sync.js — V3.194
 *
 * Bridge between the Tasks page (rm/js/tasks-buckets.js) and the PMR page
 * (rm/js/pmr.js). Handles two flows:
 *
 *   1. "Add to PMR" — from a subtask row on the Tasks page, push a copy
 *      of the subtask as a weekly-entry item into the current PMR period.
 *      Mirrors PMR's existing "⤓ pull" button in the other direction.
 *
 *   2. Completion sync — when a subtask is marked done in either view,
 *      mirror the done state to the other view via Firestore writes so
 *      the live-sync onSnapshot picks it up on the side that didn't fire.
 *      Concretely:
 *        - tasks-buckets done toggle → scan current PMR period's
 *          weekly_entries for items with source_subtask_id == st.id;
 *          set their status to 'done' / 'in_progress'; save the PMR.
 *        - PMR weekly-entry status change to/from 'done' → look up
 *          source subtask in userData/{uid}/buckets/{projectId}, flip
 *          its `done` flag, save the bucket doc.
 *
 * Why a shared module: tasks-buckets and pmr were standalone before; the
 * sync is bidirectional, so a one-sided import would mean one page
 * depends on the other's internals. A small bridge keeps both pages free
 * of cross-feature plumbing.
 *
 * Public API (window.TASK_PMR_SYNC):
 *   addSubtaskToCurrentWeek(subtask, project, bucket) → Promise<{ok, message}>
 *   syncSubtaskDoneToPMR(subtaskId, isDone)           → Promise<void>
 *   syncPMRItemDoneToSubtask(sourceSubtaskId, isDone) → Promise<void>
 */

(function () {
  'use strict';

  function _isoNow() { return new Date().toISOString(); }
  function _todayStr() { return new Date().toISOString().slice(0, 10); }
  function _newId(prefix) {
    return prefix + '-' + Date.now().toString(36) + '-' + Math.random().toString(36).slice(2, 6);
  }

  function _getUid() {
    if (typeof firebridge === 'undefined' || !firebridge.getUser) return null;
    var u = firebridge.getUser();
    return u ? u.uid : null;
  }

  /* Direct Firestore refs — these bypass the route adapter so the helper
   * works without depending on either page's lazy route registrations. */
  function _pmrIndexRef(uid)   { return firebridge.db().collection('userData').doc(uid).collection('pmr').doc('_index'); }
  function _pmrPeriodRef(uid, periodId) { return firebridge.db().collection('userData').doc(uid).collection('pmr').doc(periodId); }
  function _bucketsRef(uid, projectId)  { return firebridge.db().collection('userData').doc(uid).collection('buckets').doc(projectId); }

  /* ─────────────────────────────────────────────────────────────
   * Period + week pickers
   * ───────────────────────────────────────────────────────────── */

  /** Pick the most-recently-updated PMR period from the user's _index doc.
   * Returns null if no periods exist (caller should prompt the user to
   * create a PMR first).
   */
  async function _pickCurrentPeriodId(uid) {
    try {
      var snap = await _pmrIndexRef(uid).get();
      if (!snap.exists) return null;
      var data = snap.data() || {};
      var periods = (data.periods || []).slice();
      if (!periods.length) return null;
      periods.sort(function (a, b) { return (b.updated_at || '').localeCompare(a.updated_at || ''); });
      return periods[0].id;
    } catch (err) {
      console.warn('[task-pmr-sync] pickCurrentPeriodId failed:', err && err.message);
      return null;
    }
  }

  /** Find the weekly_entries[] entry that contains today's date. If none
   * match, pick the most recent (by start date). Returns the index in
   * weeks[] or -1 if weeks is empty.
   */
  function _currentWeekIndex(weeks) {
    if (!weeks || !weeks.length) return -1;
    var today = _todayStr();
    for (var i = 0; i < weeks.length; i++) {
      var wk = weeks[i] || {};
      var start = wk.date_range_start || '';
      var end   = wk.date_range_end   || start;
      if (start && end && start <= today && today <= end) return i;
    }
    // Fallback — newest week (latest start date).
    var newestIdx = 0;
    for (var j = 1; j < weeks.length; j++) {
      if ((weeks[j].date_range_start || '') > (weeks[newestIdx].date_range_start || '')) newestIdx = j;
    }
    return newestIdx;
  }

  /** Build a fresh weekly_entry covering today's date (Monday → Sunday). */
  function _buildCurrentWeek() {
    var today = new Date();
    var dow = today.getDay();                       // 0 (Sun) - 6 (Sat)
    var mondayOffset = dow === 0 ? -6 : (1 - dow); // shift to nearest Monday
    var start = new Date(today.getTime());
    start.setDate(start.getDate() + mondayOffset);
    var end = new Date(start.getTime());
    end.setDate(end.getDate() + 6);
    return {
      id: _newId('wk'),
      date_range_start: start.toISOString().slice(0, 10),
      date_range_end:   end.toISOString().slice(0, 10),
      subsections: [
        { name: 'Experimental update', items: [] },
        { name: 'Reading/Writing',     items: [] },
        { name: 'Sidequests',          items: [] },
      ],
    };
  }

  /* ─────────────────────────────────────────────────────────────
   * Public: Add subtask to current PMR week
   * ───────────────────────────────────────────────────────────── */

  /** Push a subtask into the current week of the user's most-recent PMR
   * period. Auto-creates the week if none exists; auto-creates an
   * "Experimental update" subsection if the week has no subsections.
   * Idempotent — if the same subtask is already linked (matching
   * source_subtask_id) in this week, no-op.
   */
  async function addSubtaskToCurrentWeek(subtask, project, bucket) {
    var uid = _getUid();
    if (!uid) return { ok: false, message: 'Not signed in' };
    if (!subtask || !subtask.id) return { ok: false, message: 'No subtask given' };
    var periodId = await _pickCurrentPeriodId(uid);
    if (!periodId) {
      return { ok: false, message: 'No PMR period yet — open the PMR page and create one first.' };
    }
    try {
      var pref = _pmrPeriodRef(uid, periodId);
      var snap = await pref.get();
      if (!snap.exists) return { ok: false, message: 'PMR doc not found for ' + periodId };
      var doc = snap.data() || {};
      var weeks = Array.isArray(doc.weekly_entries) ? doc.weekly_entries.slice() : [];
      var wkIdx = _currentWeekIndex(weeks);
      if (wkIdx < 0) {
        weeks.push(_buildCurrentWeek());
        wkIdx = weeks.length - 1;
      }
      var wk = weeks[wkIdx];
      wk.subsections = Array.isArray(wk.subsections) && wk.subsections.length
        ? wk.subsections.slice()
        : [{ name: 'Experimental update', items: [] }];
      // Idempotency check across all subsections.
      for (var s = 0; s < wk.subsections.length; s++) {
        var items = wk.subsections[s].items || [];
        if (items.find(function (it) { return it && it.source_subtask_id === subtask.id; })) {
          return { ok: false, message: 'Already in this PMR week (' + (wk.date_range_start || '') + ').' };
        }
      }
      // Pick a destination subsection: prefer the project bucket's
      // category as a hint, otherwise the first subsection.
      var dest = wk.subsections[0];
      if (bucket && bucket.category) {
        var preferred = wk.subsections.find(function (s2) {
          var n = (s2.name || '').toLowerCase();
          if (bucket.category === 'writing') return n.indexOf('reading') !== -1 || n.indexOf('writing') !== -1;
          if (bucket.category === 'experiment' || bucket.category === 'analysis') return n.indexOf('experiment') !== -1;
          return false;
        });
        if (preferred) dest = preferred;
      }
      dest.items = dest.items || [];
      dest.items.push({
        id: _newId('it'),
        status: subtask.done ? 'done' : (subtask.block_status ? 'need' : 'in_progress'),
        text: subtask.text || '',
        links: [],
        source_subtask_id: subtask.id,
      });
      weeks[wkIdx] = wk;
      await pref.update({
        weekly_entries: weeks,
        updated_at: _isoNow(),
      });
      return { ok: true, message: 'Added to PMR week ' + (wk.date_range_start || '') + ' / ' + (dest.name || '(default)') };
    } catch (err) {
      console.error('[task-pmr-sync] addSubtaskToCurrentWeek failed:', err);
      return { ok: false, message: err.message || String(err) };
    }
  }

  /* ─────────────────────────────────────────────────────────────
   * Public: Subtask done → mirror to PMR items
   * ───────────────────────────────────────────────────────────── */

  /** Scan the current PMR period's weekly_entries for items pointing at
   * this subtask via source_subtask_id; flip their `status` to match the
   * subtask's done flag. Persists the PMR doc if any items changed.
   * No-op if no PMR period exists or no matching items found.
   */
  async function syncSubtaskDoneToPMR(subtaskId, isDone) {
    if (!subtaskId) return;
    var uid = _getUid();
    if (!uid) return;
    var periodId = await _pickCurrentPeriodId(uid);
    if (!periodId) return;
    try {
      var pref = _pmrPeriodRef(uid, periodId);
      var snap = await pref.get();
      if (!snap.exists) return;
      var doc = snap.data() || {};
      var weeks = Array.isArray(doc.weekly_entries) ? doc.weekly_entries : [];
      var nextStatus = isDone ? 'done' : 'in_progress';
      var changed = 0;
      weeks.forEach(function (wk) {
        (wk.subsections || []).forEach(function (sub) {
          (sub.items || []).forEach(function (it) {
            if (it && it.source_subtask_id === subtaskId && it.status !== nextStatus) {
              it.status = nextStatus;
              changed++;
            }
          });
        });
      });
      if (!changed) return;
      await pref.update({
        weekly_entries: weeks,
        updated_at: _isoNow(),
      });
    } catch (err) {
      console.warn('[task-pmr-sync] syncSubtaskDoneToPMR failed:', err && err.message);
    }
  }

  /* ─────────────────────────────────────────────────────────────
   * Public: PMR item done → mirror to source subtask
   * ───────────────────────────────────────────────────────────── */

  /** Find the source subtask by id across all of the user's bucket docs
   * and flip its `done` flag. Walks the children tree at every level.
   * Writes the single bucket doc that contained the subtask.
   * No-op if the subtask can't be found (e.g. deleted, or moved between
   * task builders since the PMR item was created).
   */
  async function syncPMRItemDoneToSubtask(sourceSubtaskId, isDone) {
    if (!sourceSubtaskId) return;
    var uid = _getUid();
    if (!uid) return;
    try {
      var snap = await firebridge.db().collection('userData').doc(uid).collection('buckets').get();
      var docRef = null;
      var bucketsArr = null;
      snap.forEach(function (d) {
        if (docRef) return; // first match wins
        var data = d.data() || {};
        var arr = data.buckets || [];
        for (var bi = 0; bi < arr.length; bi++) {
          var b = arr[bi];
          var found = _flipDoneRecursive(b.subtasks || [], sourceSubtaskId, isDone);
          if (found) {
            docRef = d.ref;
            bucketsArr = arr;
            return;
          }
        }
      });
      if (!docRef) return;
      await docRef.update({
        buckets: bucketsArr,
        updatedAt: firebase.firestore.FieldValue.serverTimestamp(),
      });
    } catch (err) {
      console.warn('[task-pmr-sync] syncPMRItemDoneToSubtask failed:', err && err.message);
    }
  }

  /** Recursively walk a subtasks tree, flip done on the matching id.
   * Returns true if any subtask was found + mutated.
   */
  function _flipDoneRecursive(subtasks, targetId, isDone) {
    for (var i = 0; i < subtasks.length; i++) {
      var st = subtasks[i];
      if (!st) continue;
      if (st.id === targetId) {
        if (st.done === !!isDone) return true;     // already in sync
        st.done = !!isDone;
        st.done_at = isDone ? _isoNow() : null;
        return true;
      }
      if (st.children && st.children.length) {
        if (_flipDoneRecursive(st.children, targetId, isDone)) return true;
      }
    }
    return false;
  }

  window.TASK_PMR_SYNC = {
    addSubtaskToCurrentWeek: addSubtaskToCurrentWeek,
    syncSubtaskDoneToPMR:    syncSubtaskDoneToPMR,
    syncPMRItemDoneToSubtask: syncPMRItemDoneToSubtask,
  };
})();
