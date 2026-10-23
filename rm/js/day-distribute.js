/* day-distribute.js — My Week program (V3.526 R1 core; V3.527 equipment;
 * V3.528 notebook; V3.529 prefs; V3.530 double-dip chips)
 *
 * The cross-surface distribution engine behind rm/pages/my-week.html.
 * A My Week item (userData/{uid}/dayPlans/{itemId}) is the HUB record; this
 * module fans it out to the surfaces it belongs on and keeps the copies in
 * sync (edit cascade) or removes them (delete cascade). Every destination
 * write uses a DETERMINISTIC doc id derived from the item id, so re-runs
 * and retries are idempotent — the same philosophy as activity-signals.js.
 *
 * Item doc shape:
 *   { id: 'day-<ts36>-<rand4>',
 *     type: 'equipment'|'work'|'task'|'meeting'|'reading'|'order'|'help',
 *     title, notes, date: 'YYYY-MM-DD',
 *     startTime: 'HH:MM'|null, endTime: 'HH:MM'|null,
 *     status: 'planned'|'done'|'skipped'|'cancelled', confirmed_at,
 *     details: { equipmentId, equipmentName, protocolId, protocolTitle,
 *                projectId, projectName, paperId, itemName, vendor, ... },
 *     categoryPath: [], auto_distributed, excluded_surfaces: [],
 *     distributions: { <surface>: { surface, docPath, docId, status,
 *                       lastSyncedAt, error, meta } },
 *     origin: null | { surface, docPath },   // set by double-dip import
 *     outcome: null | { kind: 'result'|'barrier'|'no_result',   // V3.623
 *                       summary, image: null|{storage_path,download_url},
 *                       notebook_entry_ids: [], links: [{kind,title,url,   // V3.853 cards:
 *                         boardId,itemId,paperId|entryId,boardTitle,item_kind,thumb}],
 *                       follow_up_item_id, recorded_at, recorded_by },
 *     follow_up_of: null | { item_id, date },  // V3.623 — chained follow-up
 *     created_at, updated_at, ownerUid, schema_version: 1 }
 *
 * Distribution record status:
 *   'created'  — copy exists and follows the item
 *   'failed'   — create/update failed; `error` holds the reason (retry chip)
 *   'orphaned' — notebook entry had user content when the item was deleted
 *                or edited; the entry is kept and stops following
 *   'removed'  — copy removed by a delete cascade
 *   'skipped'  — surface excluded at compose time
 *
 * Cascade rules:
 *   - The item doc always saves FIRST; fan-out never blocks it.
 *   - Adapters never overwrite destination fields other people own
 *     (huddle watchers/joiners, booking status flips, notebook body).
 *   - equipmentBookings are CANCELLED, never deleted (delete is admin-only
 *     in firestore.rules; owner-cancel clause allows the status flip).
 *   - notebook entries with user content are orphaned with a note, per the
 *     program decision — they became the real record.
 *
 * Double-dip (V3.530): other pages call renderChips() after their native
 * composer succeeds; a tap imports the native doc as a hub item (origin
 * backref, origin surface pre-marked 'created' so cascade governs it) and
 * fans out to the tapped surface.
 *
 * Deliberately NOT via the api route adapter: direct firebridge.db() refs
 * (task-pmr-sync.js pattern) so host pages don't need route registrations.
 *
 * Globals: window.DAY_DISTRIBUTE
 * Depends: firebridge, firebase compat SDK, window.ActivitySignals.
 * Optional (guarded): notebook-schemas.js globals (notebook adapter),
 * window.EQUIP_AVAIL (equipment adapter), window.TOAST.
 */
(function () {
  'use strict';

  /* ── plumbing ─────────────────────────────────────────────── */

  function db()  { return (typeof firebridge !== 'undefined' && firebridge.db) ? firebridge.db() : null; }
  function uid() {
    if (typeof firebridge === 'undefined' || !firebridge.getUser) return null;
    var u = firebridge.getUser();
    return u && u.uid ? u.uid : null;
  }
  function profile() {
    return (typeof firebridge !== 'undefined' && firebridge.getProfile) ? (firebridge.getProfile() || {}) : {};
  }
  function displayName() {
    var p = profile();
    var u = (typeof firebridge !== 'undefined' && firebridge.getUser) ? firebridge.getUser() : null;
    return p.name || (u && (u.displayName || u.email)) || '';
  }
  function isoNow()  { return new Date().toISOString(); }
  function todayStr() {
    var d = new Date();
    return d.getFullYear() + '-' + String(d.getMonth() + 1).padStart(2, '0') + '-' + String(d.getDate()).padStart(2, '0');
  }
  function newItemId() {
    return 'day-' + Date.now().toString(36) + '-' + Math.random().toString(36).slice(2, 6);
  }
  function itemsRef()      { return db().collection('userData').doc(uid()).collection('dayPlans'); }
  function itemRef(id)     { return itemsRef().doc(id); }
  function esc(s) {
    return String(s == null ? '' : s).replace(/[&<>"']/g, function (c) {
      return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c];
    });
  }
  function timeToMin(t) {
    if (!t || typeof t !== 'string' || t.indexOf(':') < 0) return null;
    var p = t.split(':');
    return (+p[0]) * 60 + (+p[1]);
  }

  /* V3.588 — booking criticality. Clamped to the three student-writable
   * values: 'maintenance' is admin-only in firestore.rules and would get
   * the whole write rejected if it ever leaked in from a stale item. */
  function normalizePriority(p) {
    return (p === 'high' || p === 'urgent') ? p : 'normal';
  }

  /* V3.623 — local-date helpers for the follow-up chain (same math as
   * my-week.js shiftDate/mondayOf; duplicated because neither module may
   * depend on the other's page being loaded). */
  function shiftDateStr(dateStr, days) {
    var p = dateStr.split('-');
    var d = new Date(+p[0], +p[1] - 1, +p[2]);
    d.setDate(d.getDate() + days);
    return d.getFullYear() + '-' + String(d.getMonth() + 1).padStart(2, '0') + '-' + String(d.getDate()).padStart(2, '0');
  }
  function mondayOfStr(dateStr) {
    var p = dateStr.split('-');
    var dow = new Date(+p[0], +p[1] - 1, +p[2]).getDay();
    return shiftDateStr(dateStr, dow === 0 ? -6 : 1 - dow);
  }
  /* Next week's Monday relative to TODAY (not the item's date — following
   * up a two-week-old barrier should land next week, not in the past). */
  function nextMondayStr() {
    return shiftDateStr(mondayOfStr(todayStr()), 7);
  }

  /* ISO week id for a YYYY-MM-DD string — same math as huddle.js
   * getWeekId (V3.something), parameterized by date instead of offset so
   * a plan for any calendar date lands in the right huddle week. */
  function weekIdForDate(dateStr) {
    var p = String(dateStr || todayStr()).split('-');
    var d = new Date(Date.UTC(+p[0], +p[1] - 1, +p[2]));
    d.setUTCDate(d.getUTCDate() + 3 - ((d.getUTCDay() + 6) % 7));
    var jan4 = new Date(Date.UTC(d.getUTCFullYear(), 0, 4));
    var weekNum = 1 + Math.round(((d - jan4) / 86400000 - 3 + ((jan4.getUTCDay() + 6) % 7)) / 7);
    return d.getUTCFullYear() + '-W' + String(weekNum).padStart(2, '0');
  }

  function record(surface, fields) {
    return Object.assign({
      surface: surface, docPath: '', docId: '',
      status: 'created', lastSyncedAt: isoNow(), error: null, meta: {},
    }, fields || {});
  }
  function failRecord(surface, err) {
    return record(surface, { status: 'failed', error: (err && err.message) ? err.message : String(err || 'failed') });
  }

  /* ── prefs (V3.529) ──────────────────────────────────────── */

  var _prefsCache = null;
  var DEFAULT_PREFS = { auto_distribute: true, excluded_surfaces: [], schema_version: 1 };

  async function getPrefs(force) {
    if (_prefsCache && !force) return _prefsCache;
    try {
      var snap = await itemsRef().doc('_prefs').get();
      var d = snap.exists ? (snap.data() || {}) : {};
      _prefsCache = {
        auto_distribute: d.auto_distribute !== false,
        excluded_surfaces: Array.isArray(d.excluded_surfaces) ? d.excluded_surfaces.slice() : [],
        schema_version: 1,
      };
    } catch (err) {
      console.warn('[day-distribute] getPrefs failed:', err && err.message);
      _prefsCache = Object.assign({}, DEFAULT_PREFS);
    }
    return _prefsCache;
  }

  async function setPrefs(p) {
    var next = {
      auto_distribute: p.auto_distribute !== false,
      excluded_surfaces: Array.isArray(p.excluded_surfaces) ? p.excluded_surfaces.slice() : [],
      schema_version: 1,
      updated_at: isoNow(),
    };
    await itemsRef().doc('_prefs').set(next, { merge: true });
    _prefsCache = next;
    return next;
  }

  /* ── feature flags (V3.533/534 retirements) ──────────────── */

  var _flagsCache = null;
  /* labConfig/featureFlags — admin-editable kill switches for the My Week
   * retirement releases (myday_retire_huddle_composer,
   * myday_retire_tracker_manual, myday_retire_task_add). Absent doc or
   * absent key ⇒ false: every retirement ships dark. */
  async function getFeatureFlags(force) {
    if (_flagsCache && !force) return _flagsCache;
    try {
      var snap = await db().collection('labConfig').doc('featureFlags').get();
      _flagsCache = (snap.exists && snap.data()) || {};
    } catch (err) {
      _flagsCache = {};
    }
    return _flagsCache;
  }

  /* ── surface registry ────────────────────────────────────── */

  var ADAPTERS = {};
  function registerAdapter(key, adapter) { ADAPTERS[key] = adapter; }

  /* Which surfaces a given item type fans out to by default. Order is
   * display order in the composer chip row. */
  var TYPE_SURFACES = {
    equipment: ['equipment', 'huddle', 'notebook', 'tracker'],
    work:      ['huddle', 'notebook', 'tracker'],
    task:      ['task', 'tracker'],
    meeting:   ['tracker'],
    reading:   ['tracker'],
    order:     ['tracker'],
    help:      ['huddle'],
  };

  var SURFACE_LABELS = {
    huddle:    { icon: 'users', label: 'Huddle' },
    equipment: { icon: 'microscope', label: 'Equipment' },
    notebook:  { icon: 'book-open', label: 'Notebook' },
    tracker:   { icon: 'clock', label: 'Tracker' },
    task:      { icon: 'check-circle', label: 'Task' },
    pmr_week:  { icon: 'clipboard-document-list', label: 'PMR week' },
  };

  /* V3.623 — per-ITEM outcome vocabulary. Deliberately NOT the focus-week
   * verdict (FOCUS_AREAS.OUTCOME_META success/partial/failure): a focus
   * report judges the week's WHY, an item outcome records what came of one
   * planned step — a result, the barrier that blocked it, or a fizzle.
   * The PMR ledger (V3.624) and project health (V3.625) read this. */
  var ITEM_OUTCOME_META = {
    result:    { icon: 'check-circle', label: 'Result' },
    barrier:   { icon: 'construction', label: 'Barrier' },
    no_result: { icon: '◌',  label: 'No result' },
  };

  function defaultSurfacesFor(item, prefs) {
    var base = (TYPE_SURFACES[item.type] || ['tracker']).slice();
    var excluded = []
      .concat((prefs && prefs.excluded_surfaces) || [])
      .concat(item.excluded_surfaces || []);
    return base.filter(function (s) {
      return excluded.indexOf(s) < 0 && ADAPTERS[s] && ADAPTERS[s].appliesTo(item);
    });
  }

  /* Deep-link a distribution record to its page. */
  function linkFor(rec, item) {
    if (!rec) return null;
    switch (rec.surface) {
      case 'huddle':    return '/rm/pages/huddle.html';
      case 'equipment': return '/rm/pages/equipment.html';
      case 'notebook':  return '/rm/pages/notebook.html?entry=' + encodeURIComponent(rec.docId || (item && item.id) || '');
      case 'tracker':   return '/rm/pages/activity-overview.html?tab=tracker';
      case 'task':      return '/rm/pages/tasks.html';
      case 'pmr_week':  return '/rm/pages/pmr.html';
      default:          return null;
    }
  }

  /* ── adapter: huddle ─────────────────────────────────────── */

  registerAdapter('huddle', {
    key: 'huddle',
    appliesTo: function () { return true; },
    describe: function () { return 'post a plan to the Huddle board'; },
    create: async function (item) {
      var det = item.details || {};
      var planDoc = {
        ownerUid: uid(),
        ownerName: displayName(),
        ownerCategory: profile().category || '',
        weekId: weekIdForDate(item.date),
        plannedDay: item.date || null,
        startTime: item.startTime || null,
        endTime: item.endTime || null,
        text: item.title || '',
        notes: item.notes || '',
        protocol: det.protocolId
          ? { title: det.protocolTitle || 'Protocol', url: '/rm/pages/protocols.html?id=' + encodeURIComponent(det.protocolId) }
          : null,
        categoryId: null, categoryLabel: null,
        projectId: det.projectId || null, projectName: det.projectName || null,
        watchers: [], joiners: [], joinRequests: [],
        status: 'planned', statusReason: null, delayedToWeek: null,
        seriesId: null, recurrence: null,
        source_ref: { kind: 'dayplan', id: item.id },
        createdAt: firebase.firestore.FieldValue.serverTimestamp(),
        updatedAt: firebase.firestore.FieldValue.serverTimestamp(),
      };
      await db().collection('huddlePlans').doc(item.id).set(planDoc);
      return record('huddle', { docPath: 'huddlePlans/' + item.id, docId: item.id });
    },
    update: async function (item, rec) {
      var patch = {
        text: item.title || '',
        notes: item.notes || '',
        weekId: weekIdForDate(item.date),
        plannedDay: item.date || null,
        startTime: item.startTime || null,
        endTime: item.endTime || null,
        updatedAt: firebase.firestore.FieldValue.serverTimestamp(),
      };
      if (item.status === 'done')    patch.status = 'completed';
      if (item.status === 'skipped') patch.status = 'skipped';
      await db().collection('huddlePlans').doc(rec.docId).update(patch);
      return record('huddle', { docPath: rec.docPath, docId: rec.docId, meta: rec.meta });
    },
    remove: async function (item, rec) {
      await db().collection('huddlePlans').doc(rec.docId).delete();
      return record('huddle', { docPath: rec.docPath, docId: rec.docId, status: 'removed' });
    },
  });

  /* ── adapter: tracker (via ActivitySignals) ──────────────── */

  function trackerSourceRef(item) {
    return { kind: 'dayplan', id: item.id, path: 'userData/' + uid() + '/dayPlans/' + item.id };
  }

  registerAdapter('tracker', {
    key: 'tracker',
    appliesTo: function (item) { return !!item.date; },
    describe: function () { return 'log a schedule event in the Activity Tracker'; },
    create: async function (item) {
      if (!window.ActivitySignals) throw new Error('ActivitySignals not loaded');
      var res = await ActivitySignals.recordSchedule({
        source: 'my-day',
        sourceRef: trackerSourceRef(item),
        date: item.date,
        text: item.title || '',
        categoryPath: item.categoryPath || [],
      });
      if (!res) throw new Error('tracker event write failed');
      return record('tracker', {
        docPath: 'trackerEntries/' + uid() + '/entries/' + res.id,
        docId: res.id,
      });
    },
    update: async function (item, rec) {
      // A native (imported) manual entry is the user's own record — the
      // deterministic-id upsert below would create a DUPLICATE doc, so
      // native records are left alone.
      if (rec.meta && rec.meta.native) return rec;
      // recordSchedule is an idempotent upsert on a fixed doc id — the
      // date moves with the plan (activity-signals.js design).
      if (!window.ActivitySignals) throw new Error('ActivitySignals not loaded');
      await ActivitySignals.recordSchedule({
        source: 'my-day',
        sourceRef: trackerSourceRef(item),
        date: item.date,
        text: item.title || '',
        categoryPath: item.categoryPath || [],
      });
      return record('tracker', { docPath: rec.docPath, docId: rec.docId, meta: rec.meta });
    },
    remove: async function (item, rec) {
      if (rec.meta && rec.meta.native) {
        return record('tracker', { docPath: rec.docPath, docId: rec.docId, status: 'removed', meta: rec.meta });
      }
      if (window.ActivitySignals) await ActivitySignals.removeSchedule({ kind: 'dayplan', id: item.id });
      return record('tracker', { docPath: rec.docPath, docId: rec.docId, status: 'removed' });
    },
  });

  /* Confirm-done work event (V3.531 pending-confirmations flow). Kept
   * beside the schedule adapter because it shares the sourceRef scheme:
   * the schedule doc is auto-dayplan-<id>, the work doc gains -<date>. */
  async function recordDoneWork(item) {
    if (!window.ActivitySignals) return null;
    return await ActivitySignals.recordWork({
      source: 'my-day',
      sourceRef: trackerSourceRef(item),
      date: item.date,
      text: item.title || '',
      categoryPath: item.categoryPath || [],
    });
  }

  /* ── adapter: equipment (V3.527) ─────────────────────────── */

  registerAdapter('equipment', {
    key: 'equipment',
    appliesTo: function (item) {
      return item.type === 'equipment' && item.details && item.details.equipmentId
        && item.startTime && item.endTime;
    },
    describe: function () { return 'book the instrument on the Equipment calendar'; },
    create: async function (item) {
      if (!window.EQUIP_AVAIL) throw new Error('equipment helper not loaded');
      var det = item.details || {};
      var check = await EQUIP_AVAIL.checkSlot(det.equipmentId, item.date, item.startTime, item.endTime);
      if (!check.ok) throw new Error(check.reason || 'Slot unavailable');
      var bookingData = {
        equipmentId: det.equipmentId,
        equipmentName: check.equipmentName || det.equipmentName || '',
        uid: uid(),
        userName: displayName(),
        userCategory: profile().category || '',
        coOperatorUid: null, coOperatorName: null,
        date: item.date, endDate: item.date,
        startTime: item.startTime, endTime: item.endTime,
        durationMin: timeToMin(item.endTime) - timeToMin(item.startTime),
        // V3.588 — criticality picked in the My Week composer. Was hardcoded
        // 'normal', which silently flattened every My Week booking to Soft.
        priority: normalizePriority(det.priority),
        status: check.needsApproval ? 'pending-approval' : 'confirmed',
        notes: item.title || '',
        gcalEventId: null,
        source_ref: { kind: 'dayplan', id: item.id },
      };
      await db().collection('equipmentBookings').doc(item.id).set(
        Object.assign({}, bookingData, {
          createdAt: firebase.firestore.FieldValue.serverTimestamp(),
          updatedAt: firebase.firestore.FieldValue.serverTimestamp(),
        }));
      return record('equipment', {
        docPath: 'equipmentBookings/' + item.id, docId: item.id,
        meta: { needsApproval: !!check.needsApproval },
      });
    },
    update: async function (item, rec) {
      if (!window.EQUIP_AVAIL) throw new Error('equipment helper not loaded');
      var det = item.details || {};
      var check = await EQUIP_AVAIL.checkSlot(det.equipmentId, item.date, item.startTime, item.endTime, rec.docId);
      if (!check.ok) throw new Error(check.reason || 'Slot unavailable');
      var patch = {
        date: item.date, endDate: item.date,
        startTime: item.startTime, endTime: item.endTime,
        durationMin: timeToMin(item.endTime) - timeToMin(item.startTime),
        // V3.588 — priority was omitted here, so criticality edits made in
        // the My Week composer never reached the booking.
        priority: normalizePriority(det.priority),
        notes: item.title || '',
        updatedAt: firebase.firestore.FieldValue.serverTimestamp(),
      };
      await db().collection('equipmentBookings').doc(rec.docId).update(patch);
      return record('equipment', { docPath: rec.docPath, docId: rec.docId, meta: rec.meta });
    },
    remove: async function (item, rec) {
      // Booking delete is admin-only in firestore.rules — owners cancel.
      await db().collection('equipmentBookings').doc(rec.docId).update({
        status: 'cancelled',
        updatedAt: firebase.firestore.FieldValue.serverTimestamp(),
      });
      return record('equipment', { docPath: rec.docPath, docId: rec.docId, status: 'removed' });
    },
  });

  /* ── adapter: notebook (V3.528) ──────────────────────────── */

  function notebookEntryRef(id) { return db().collection('userData').doc(uid()).collection('notebook').doc(id); }
  function notebookIndexRef()   { return db().collection('userData').doc(uid()).collection('notebook').doc('_index'); }

  function hasUserContent(e) {
    if (!e) return false;
    if (String(e.body_text || '').trim()) return true;
    if (Array.isArray(e.observations) && e.observations.length) return true;
    if (String(e.summary || '').trim()) return true;
    if (Array.isArray(e.attachments) && e.attachments.length) return true;
    if (e.protocol_run && e.protocol_run.inputs && Object.keys(e.protocol_run.inputs).length) return true;
    if (typeof notebookPlanHasContent === 'function' && notebookPlanHasContent(e.plan)) return true;
    return false;
  }

  /* Upsert (or drop) this entry's row in the _index summary doc inside a
   * transaction, so a concurrently-open lab-notebook session can't be
   * clobbered by a read-modify-write race. */
  async function upsertIndexRow(entry, removeOnly) {
    await db().runTransaction(async function (tx) {
      var snap = await tx.get(notebookIndexRef());
      var doc = (snap.exists && snap.data()) || {};
      var entries = Array.isArray(doc.entries) ? doc.entries.slice() : [];
      entries = entries.filter(function (r) { return r && r.id !== entry.id; });
      if (!removeOnly) entries.unshift(notebookIndexRow(entry));
      tx.set(notebookIndexRef(), { entries: entries }, { merge: true });
    });
  }

  function buildProtocolRun(det) {
    return {
      protocol_id: det.protocolId,
      protocol_title: det.protocolTitle || '',
      protocol_version: null,
      loaded_at: isoNow(),
      inputs: {}, graph_state: {}, grids: [], assignment: {},
      factor: 1, computed: null,
      frozen: false, frozen_at: null, snapshot: null,
    };
  }

  registerAdapter('notebook', {
    key: 'notebook',
    appliesTo: function (item) { return item.type === 'equipment' || item.type === 'work'; },
    describe: function () { return 'create a plan-phase Lab Notebook entry'; },
    create: async function (item) {
      if (typeof notebookEmptyEntry !== 'function' || typeof notebookIndexRow !== 'function') {
        throw new Error('notebook-schemas.js not loaded on this page');
      }
      var det = item.details || {};
      var existing = await notebookEntryRef(item.id).get();
      var entry;
      if (existing.exists) {
        entry = existing.data(); // idempotent re-run — refresh index only
      } else {
        entry = notebookEmptyEntry();
        entry.id = item.id;
        entry.ownerUid = uid();
        entry.title = item.title || '(planned)';
        entry.date = item.date || todayStr();
        entry.project_id = det.projectId || null;
        entry.protocol_id = det.protocolId || null;
        entry.phase = 'plan';
        if (det.protocolId) entry.protocol_run = buildProtocolRun(det);
        entry.reference_links = [{ kind: 'other', label: 'Planned in My Week', url: '/rm/pages/my-week.html?date=' + (item.date || '') }];
        await notebookEntryRef(item.id).set(entry);
      }
      await upsertIndexRow(entry);
      return record('notebook', { docPath: 'userData/' + uid() + '/notebook/' + item.id, docId: item.id });
    },
    update: async function (item, rec) {
      var snap = await notebookEntryRef(rec.docId).get();
      if (!snap.exists) return record('notebook', { docPath: rec.docPath, docId: rec.docId, status: 'removed' });
      var entry = snap.data();
      if (hasUserContent(entry)) {
        // The entry became the real record — it stops following the plan.
        return record('notebook', { docPath: rec.docPath, docId: rec.docId, meta: { frozen: true } });
      }
      var det = item.details || {};
      entry.title = item.title || entry.title;
      entry.date = item.date || entry.date;
      entry.project_id = det.projectId || null;
      entry.protocol_id = det.protocolId || null;
      if (det.protocolId && !entry.protocol_run) entry.protocol_run = buildProtocolRun(det);
      entry.updated_at = isoNow();
      await notebookEntryRef(rec.docId).set(entry);
      await upsertIndexRow(entry);
      return record('notebook', { docPath: rec.docPath, docId: rec.docId, meta: rec.meta });
    },
    remove: async function (item, rec) {
      var snap = await notebookEntryRef(rec.docId).get();
      if (!snap.exists) return record('notebook', { docPath: rec.docPath, docId: rec.docId, status: 'removed' });
      var entry = snap.data();
      if (hasUserContent(entry)) {
        entry.body_html = '<p class="nb-orphan-note">' + ICON.svg('exclamation-triangle') + ' The My Week plan that created this entry was deleted on '
          + todayStr() + '; the entry is kept.</p>' + (entry.body_html || '');
        entry.updated_at = isoNow();
        await notebookEntryRef(rec.docId).set(entry);
        await upsertIndexRow(entry);
        return record('notebook', { docPath: rec.docPath, docId: rec.docId, status: 'orphaned' });
      }
      await notebookEntryRef(rec.docId).delete();
      await upsertIndexRow(entry, true);
      return record('notebook', { docPath: rec.docPath, docId: rec.docId, status: 'removed' });
    },
  });

  /* ── adapter: task ───────────────────────────────────────── */

  registerAdapter('task', {
    key: 'task',
    appliesTo: function (item) { return item.type === 'task'; },
    describe: function () { return 'add a task to your queue'; },
    create: async function (item) {
      var taskDoc = {
        id: item.id,
        text: item.title || '',
        notes: item.notes || '',
        due_date: item.date || null,
        priority: 'normal',
        done: false, done_at: null,
        bucket: 'assigned',
        source: 'my-day',
        source_ref: { kind: 'dayplan', id: item.id },
        assignee_uid: uid(),
        assigned_by: uid(),
        created_at: isoNow(),
      };
      await db().collection('userData').doc(uid()).collection('tasks').doc(item.id).set(taskDoc, { merge: true });
      return record('task', { docPath: 'userData/' + uid() + '/tasks/' + item.id, docId: item.id });
    },
    update: async function (item, rec) {
      var patch = { text: item.title || '', notes: item.notes || '', due_date: item.date || null };
      if (item.status === 'done') { patch.done = true; patch.done_at = isoNow(); }
      await db().collection('userData').doc(uid()).collection('tasks').doc(rec.docId).update(patch);
      return record('task', { docPath: rec.docPath, docId: rec.docId, meta: rec.meta });
    },
    remove: async function (item, rec) {
      await db().collection('userData').doc(uid()).collection('tasks').doc(rec.docId).delete();
      return record('task', { docPath: rec.docPath, docId: rec.docId, status: 'removed' });
    },
  });

  /* ── adapter: pmr_week (default-off chip) ────────────────── */

  function pmrIndexRef()        { return db().collection('userData').doc(uid()).collection('pmr').doc('_index'); }
  function pmrPeriodRef(pid)    { return db().collection('userData').doc(uid()).collection('pmr').doc(pid); }

  async function pickCurrentPeriodId() {
    var snap = await pmrIndexRef().get();
    if (!snap.exists) return null;
    var periods = ((snap.data() || {}).periods || []).slice();
    if (!periods.length) return null;
    periods.sort(function (a, b) { return (b.updated_at || '').localeCompare(a.updated_at || ''); });
    return periods[0].id;
  }

  registerAdapter('pmr_week', {
    key: 'pmr_week',
    appliesTo: function () { return true; },
    describe: function () { return 'add an item to your current PMR week'; },
    create: async function (item) {
      if (!window.TASK_PMR_SYNC) throw new Error('task-pmr-sync.js not loaded');
      // Reuse the battle-tested week picker via a subtask-shaped payload;
      // stamp our own backref afterwards (source_subtask_id is scanned by
      // the idempotency check, so give it the item id).
      var res = await TASK_PMR_SYNC.addSubtaskToCurrentWeek(
        { id: item.id, text: item.title || '', done: item.status === 'done' }, null, null);
      if (!res.ok && String(res.message || '').indexOf('Already in') < 0) throw new Error(res.message);
      var periodId = await pickCurrentPeriodId();
      return record('pmr_week', { docPath: 'userData/' + uid() + '/pmr/' + periodId, docId: periodId, meta: { periodId: periodId } });
    },
    update: async function (item, rec) {
      if (window.TASK_PMR_SYNC) await TASK_PMR_SYNC.syncSubtaskDoneToPMR(item.id, item.status === 'done');
      return record('pmr_week', { docPath: rec.docPath, docId: rec.docId, meta: rec.meta });
    },
    remove: async function (item, rec) {
      try {
        var periodId = (rec.meta && rec.meta.periodId) || await pickCurrentPeriodId();
        if (periodId) {
          var pref = pmrPeriodRef(periodId);
          var snap = await pref.get();
          if (snap.exists) {
            var doc = snap.data() || {};
            var weeks = Array.isArray(doc.weekly_entries) ? doc.weekly_entries : [];
            var changed = false;
            weeks.forEach(function (wk) {
              (wk.subsections || []).forEach(function (sub) {
                var before = (sub.items || []).length;
                sub.items = (sub.items || []).filter(function (it) { return !it || it.source_subtask_id !== item.id; });
                if (sub.items.length !== before) changed = true;
              });
            });
            if (changed) await pref.update({ weekly_entries: weeks, updated_at: isoNow() });
          }
        }
      } catch (err) { console.warn('[day-distribute] pmr_week remove failed:', err && err.message); }
      return record('pmr_week', { docPath: rec.docPath, docId: rec.docId, status: 'removed' });
    },
  });

  /* ── core lifecycle ──────────────────────────────────────── */

  async function persistDistributions(item) {
    try {
      await itemRef(item.id).update({ distributions: item.distributions, updated_at: isoNow() });
    } catch (err) {
      console.warn('[day-distribute] persistDistributions failed:', err && err.message);
    }
  }

  /* Fan the item out. `surfaces` optional — defaults to the type's list
   * minus prefs + item exclusions. Already-'created' surfaces are updated
   * rather than recreated (idempotent). Returns the distributions map. */
  async function distribute(item, surfaces) {
    var prefs = await getPrefs();
    var targets = surfaces || defaultSurfacesFor(item, prefs);
    item.distributions = item.distributions || {};
    await Promise.allSettled(targets.map(async function (s) {
      var adapter = ADAPTERS[s];
      if (!adapter || !adapter.appliesTo(item)) return;
      var prior = item.distributions[s];
      try {
        if (prior && prior.status === 'created') {
          item.distributions[s] = await adapter.update(item, prior);
        } else {
          item.distributions[s] = await adapter.create(item);
        }
      } catch (err) {
        console.warn('[day-distribute] ' + s + ' distribute failed:', err && err.message);
        item.distributions[s] = failRecord(s, err);
      }
    }));
    // Mark explicit exclusions so the UI can show ◌ chips.
    defaultSurfacesFor(item, { excluded_surfaces: [] }).forEach(function (s) {
      if (!item.distributions[s] && targets.indexOf(s) < 0) {
        item.distributions[s] = record(s, { status: 'skipped' });
      }
    });
    await persistDistributions(item);
    return item.distributions;
  }

  /* Re-push mapped fields to every live copy. */
  async function cascadeUpdate(item) {
    var dists = item.distributions || {};
    await Promise.allSettled(Object.keys(dists).map(async function (s) {
      var rec = dists[s];
      var adapter = ADAPTERS[s];
      if (!adapter || !rec || rec.status !== 'created') return;
      try {
        item.distributions[s] = await adapter.update(item, rec);
      } catch (err) {
        console.warn('[day-distribute] ' + s + ' cascadeUpdate failed:', err && err.message);
        item.distributions[s] = Object.assign({}, rec, { status: 'failed', error: (err && err.message) || 'update failed' });
      }
    }));
    await persistDistributions(item);
    return item.distributions;
  }

  /* Remove/cancel/orphan every copy, then delete the item doc. If any
   * removal fails the item is kept as status:'cancelled' with the failed
   * records visible — no silently stranded copies. */
  async function cascadeDelete(item) {
    var dists = item.distributions || {};
    var anyFailed = false;
    await Promise.allSettled(Object.keys(dists).map(async function (s) {
      var rec = dists[s];
      var adapter = ADAPTERS[s];
      if (!adapter || !rec) return;
      if (rec.status !== 'created' && rec.status !== 'failed') return;
      try {
        item.distributions[s] = await adapter.remove(item, rec);
      } catch (err) {
        console.warn('[day-distribute] ' + s + ' cascadeDelete failed:', err && err.message);
        anyFailed = true;
        item.distributions[s] = Object.assign({}, rec, { status: 'failed', error: (err && err.message) || 'remove failed' });
      }
    }));
    if (anyFailed) {
      item.status = 'cancelled';
      await itemRef(item.id).update({ status: 'cancelled', distributions: item.distributions, updated_at: isoNow() });
      return { deleted: false, distributions: item.distributions };
    }
    await itemRef(item.id).delete();
    return { deleted: true, distributions: item.distributions };
  }

  async function retry(item, surface) {
    var adapter = ADAPTERS[surface];
    if (!adapter) return null;
    try {
      var prior = (item.distributions || {})[surface];
      item.distributions = item.distributions || {};
      item.distributions[surface] = (prior && prior.status === 'created')
        ? await adapter.update(item, prior)
        : await adapter.create(item);
    } catch (err) {
      item.distributions[surface] = failRecord(surface, err);
    }
    await persistDistributions(item);
    return item.distributions[surface];
  }

  /* Confirm-done flow (V3.531): flips the item + cascades status. */
  async function confirmDone(item) {
    item.status = 'done';
    item.confirmed_at = isoNow();
    await itemRef(item.id).update({ status: 'done', confirmed_at: item.confirmed_at, updated_at: isoNow() });
    await recordDoneWork(item);
    await cascadeUpdate(item);
    return item;
  }

  /* V3.623 — confirm-skipped. The old skip path wrote status:'skipped' on
   * the hub doc only, so the huddle post and booking kept saying
   * "planned" forever. Skips now cascade like done does. */
  async function confirmSkipped(item) {
    item.status = 'skipped';
    await itemRef(item.id).update({ status: 'skipped', updated_at: isoNow() });
    await cascadeUpdate(item);
    return item;
  }

  /* V3.853 — which status an outcome closes an item to (pure; lifted by
   * scripts/tests/myweek-needs-result.test.mjs). A result always means
   * done. On a PLANNED item the caller's intent wins otherwise — closeAs
   * 'done' from the ✓ button keeps "did it, but no result" as done — and
   * with no intent a barrier / no_result means the step didn't happen →
   * skipped. A result on a previously skipped item flips it to done
   * ("actually, it did work"); a done item stays done. */
  function closedStatusFor(status, kind, closeAs) {
    if (status === 'planned') {
      if (kind === 'result') return 'done';
      return closeAs === 'done' ? 'done' : 'skipped';
    }
    if (status === 'skipped' && kind === 'result') return 'done';
    return status;
  }

  /* V3.853 — an outcome link: the CARD on a figure board or in the notebook
   * that holds the result. kind 'figure_board_item' (paperId + boardId +
   * itemId) | 'notebook_item' (entryId + boardId + itemId) | anything else
   * generic; url deep-links with &item=<id> so the host centres the card. */
  function cleanLink(l) {
    var out = {
      kind: String(l.kind || 'link').slice(0, 40),
      id: String(l.id || l.itemId || '').slice(0, 200),
      title: String(l.title || '').slice(0, 200),
      url: String(l.url || '').slice(0, 600),
    };
    ['boardId', 'itemId', 'paperId', 'entryId', 'boardTitle', 'item_kind'].forEach(function (k) {
      if (l[k]) out[k] = String(l[k]).slice(0, 200);
    });
    if (l.thumb) out.thumb = String(l.thumb).slice(0, 1000);
    return out;
  }

  /* V3.623 — record what came of a planned item. The outcome lives on the
   * hub doc only (it never cascades — copies carry status, the verdict
   * belongs to the ledger). Recording an outcome on a still-'planned'
   * item also closes it (closedStatusFor) so the pending list stops asking
   * about it. V3.853: opts.closeAs ('done'|'skipped') is the ✓ / ✗ intent
   * — the dialog is the confirm step now, so the status and the outcome
   * land in ONE write; links[] carries the figure boards. */
  async function saveOutcome(item, outcome, opts) {
    outcome = outcome || {};
    opts = opts || {};
    var kind = ITEM_OUTCOME_META[outcome.kind] ? outcome.kind : 'no_result';
    item.outcome = {
      kind: kind,
      summary: String(outcome.summary || ''),
      image: (outcome.image && outcome.image.storage_path) ? {
        storage_path: outcome.image.storage_path,
        download_url: outcome.image.download_url || '',
      } : null,
      notebook_entry_ids: Array.isArray(outcome.notebook_entry_ids) ? outcome.notebook_entry_ids : [],
      links: (Array.isArray(outcome.links) ? outcome.links : [])
        .filter(function (l) { return l && typeof l === 'object' && (l.url || l.id); }).map(cleanLink),
      follow_up_item_id: (item.outcome && item.outcome.follow_up_item_id) || null,
      recorded_at: isoNow(),
      recorded_by: uid(),
    };
    var patch = { outcome: item.outcome, updated_at: isoNow() };
    var next = closedStatusFor(item.status, kind, opts.closeAs);
    var becameDone = next === 'done' && item.status !== 'done';
    var becameSkipped = next === 'skipped' && item.status !== 'skipped';
    item.status = next;
    if (becameDone) {
      item.confirmed_at = isoNow();
      patch.confirmed_at = item.confirmed_at;
    }
    if (becameDone || becameSkipped) patch.status = item.status;
    await itemRef(item.id).update(patch);
    if (becameDone) await recordDoneWork(item);
    if (becameDone || becameSkipped) await cascadeUpdate(item);
    return item;
  }

  /* V3.623 — spawn next week's chained follow-up. A NEW planned item: the
   * original keeps its week and its outcome (history is never re-dated —
   * that's the → Today move's flaw). details are copied so the focus /
   * project attribution survives the chain; the PMR ledger and the
   * barrier-persistence health signal (V3.625) walk `follow_up_of`.
   * Deliberately not auto-distributed — the student refines and sends it
   * from My Week like any planned item. */
  async function createFollowUp(item, opts) {
    opts = opts || {};
    var fu = {
      id: newItemId(),
      type: item.type || 'work',
      title: String(opts.title || ('Follow up: ' + (item.title || ''))).slice(0, 300),
      notes: '',
      date: /^\d{4}-\d{2}-\d{2}$/.test(opts.date || '') ? opts.date : nextMondayStr(),
      startTime: null, endTime: null,
      status: 'planned', confirmed_at: null,
      details: Object.assign({}, item.details || {}),
      categoryPath: (item.categoryPath || []).slice(),
      auto_distributed: false, excluded_surfaces: [],
      distributions: {},
      origin: null,
      outcome: null,
      follow_up_of: { item_id: item.id, date: item.date || null },
      created_at: isoNow(), updated_at: isoNow(),
      ownerUid: uid(), schema_version: 1,
    };
    await itemRef(fu.id).set(fu);
    if (item.outcome) {
      item.outcome.follow_up_item_id = fu.id;
      await itemRef(item.id).update({ 'outcome.follow_up_item_id': fu.id, updated_at: isoNow() });
    }
    return fu;
  }

  /* ── double-dip chips (V3.530) ───────────────────────────── */

  /* ctx = { source: 'huddle'|'notebook'|'tracker'|'tasks'|'equipment',
   *         nativeDocPath: 'huddlePlans/abc',
   *         type: optional item type hint,
   *         draft: { title, notes, date, startTime, endTime, details } } */
  function suggestFor(ctx) {
    var type = ctx.type || (ctx.source === 'equipment' ? 'equipment' : 'work');
    var base = (TYPE_SURFACES[type] || ['tracker']).slice();
    var sourceSurface = ctx.source === 'tasks' ? 'task' : ctx.source;
    return base.filter(function (s) { return s !== sourceSurface && ADAPTERS[s]; })
      .map(function (s) {
        var meta = SURFACE_LABELS[s] || { icon: '•', label: s };
        return { surface: s, icon: meta.icon, label: meta.label };
      });
  }

  async function importAndDistribute(ctx, surfaces) {
    // draft may be a function — host pages whose native doc keeps changing
    // after creation (notebook title typing) resolve it at tap time.
    var draft = (typeof ctx.draft === 'function') ? (ctx.draft() || {}) : (ctx.draft || {});
    var sourceSurface = ctx.source === 'tasks' ? 'task' : ctx.source;
    var item = {
      id: newItemId(),
      type: ctx.type || (ctx.source === 'equipment' ? 'equipment' : 'work'),
      title: draft.title || '', notes: draft.notes || '',
      date: draft.date || todayStr(),
      startTime: draft.startTime || null, endTime: draft.endTime || null,
      status: 'planned', confirmed_at: null,
      details: draft.details || {},
      categoryPath: draft.categoryPath || [],
      auto_distributed: false, excluded_surfaces: [],
      distributions: {},
      origin: { surface: sourceSurface, docPath: ctx.nativeDocPath || '' },
      created_at: isoNow(), updated_at: isoNow(),
      ownerUid: uid(), schema_version: 1,
    };
    // The origin surface's copy IS the native doc — pre-mark it created so
    // the cascade governs it and distribute() never double-creates there.
    if (ctx.nativeDocPath && ADAPTERS[sourceSurface]) {
      var segs = ctx.nativeDocPath.split('/');
      item.distributions[sourceSurface] = record(sourceSurface, {
        docPath: ctx.nativeDocPath, docId: segs[segs.length - 1],
        meta: { native: true },
      });
    }
    await itemRef(item.id).set(item);
    await distribute(item, (surfaces || []).filter(function (s) { return s !== sourceSurface; }));
    return item;
  }

  var _chipCss = false;
  function ensureChipCss() {
    if (_chipCss || !document || document.getElementById('dd-chip-css')) { _chipCss = true; return; }
    var st = document.createElement('style');
    st.id = 'dd-chip-css';
    st.textContent =
      '.dd-chip-row{display:flex;flex-wrap:wrap;gap:.35rem;align-items:center;margin:.4rem 0;font-size:.82rem}' +
      '.dd-chip-row .dd-lead{opacity:.7}' +
      '.dd-chip{border:1px solid var(--border-color,#3333);border-radius:999px;padding:.15rem .6rem;cursor:pointer;background:transparent;font-size:.82rem;line-height:1.4}' +
      '.dd-chip:hover{background:var(--bg-hover,rgba(125,125,125,.12))}' +
      '.dd-chip.dd-done{opacity:.55;cursor:default;text-decoration:none}';
    document.head.appendChild(st);
    _chipCss = true;
  }

  /* Renders "Also: [🔬 Equipment] [📓 Notebook] …" into anchorEl after a
   * native composer succeeds. First tap imports the native doc as a hub
   * item; later taps fan the SAME item out to more surfaces. */
  function renderChips(anchorEl, ctx, onDone) {
    try {
      if (!anchorEl || !uid()) return;
      ensureChipCss();
      var suggestions = suggestFor(ctx);
      if (!suggestions.length) return;
      var row = document.createElement('div');
      row.className = 'dd-chip-row';
      row.innerHTML = '<span class="dd-lead">Also add to:</span>' + suggestions.map(function (s) {
        return '<button type="button" class="dd-chip" data-surface="' + esc(s.surface) + '">' + ICON.render(s.icon) + ' ' + esc(s.label) + '</button>';
      }).join('');
      var importedItem = null;
      row.addEventListener('click', async function (ev) {
        var btn = ev.target.closest('.dd-chip');
        if (!btn || btn.classList.contains('dd-done')) return;
        var surface = btn.getAttribute('data-surface');
        btn.disabled = true;
        try {
          if (!importedItem) {
            importedItem = await importAndDistribute(ctx, [surface]);
          } else {
            await distribute(importedItem, [surface]);
          }
          var rec = importedItem.distributions[surface];
          if (rec && rec.status === 'failed') {
            if (window.TOAST) TOAST.warn(surface + ': ' + (rec.error || 'failed'));
            btn.disabled = false;
          } else {
            btn.classList.add('dd-done');
            btn.textContent = '✓ ' + btn.textContent.replace(/^✓ /, '');
            if (window.TOAST) TOAST.success('Added to ' + surface + ' (+ My Week)');
            if (typeof onDone === 'function') onDone(importedItem, surface);
          }
        } catch (err) {
          console.warn('[day-distribute] chip failed:', err);
          if (window.TOAST) TOAST.warn('Could not add to ' + surface);
          btn.disabled = false;
        }
      });
      anchorEl.appendChild(row);
    } catch (err) {
      console.warn('[day-distribute] renderChips failed:', err);
    }
  }

  /* Floating variant for host pages whose composers have no obvious chip
   * anchor: a small dismissible card, bottom-center, auto-removes. One at
   * a time — a new native create replaces the previous panel. */
  function renderChipsFloating(ctx, onDone) {
    try {
      if (!uid()) return;
      ensureChipCss();
      var prior = document.getElementById('dd-float');
      if (prior) prior.remove();
      var panel = document.createElement('div');
      panel.id = 'dd-float';
      panel.style.cssText = 'position:fixed;left:50%;transform:translateX(-50%);bottom:18px;z-index:9000;' +
        'background:var(--card,#fff);border:1px solid var(--border,#3333);border-radius:12px;' +
        'box-shadow:0 8px 24px rgba(0,0,0,.18);padding:.5rem .75rem;max-width:min(92vw,480px)';
      var close = document.createElement('button');
      close.type = 'button';
      ICON.label(close, 'x-mark');
      close.style.cssText = 'float:right;border:none;background:transparent;cursor:pointer;opacity:.6;font-size:.9rem';
      close.addEventListener('click', function () { panel.remove(); });
      panel.appendChild(close);
      renderChips(panel, ctx, onDone);
      if (!panel.querySelector('.dd-chip-row')) return; // nothing to suggest
      document.body.appendChild(panel);
      setTimeout(function () { if (panel.parentNode) panel.remove(); }, 25000);
    } catch (err) {
      console.warn('[day-distribute] renderChipsFloating failed:', err);
    }
  }

  /* ── item CRUD helpers used by my-week.js ─────────────────── */

  async function saveItem(item) {
    item.updated_at = isoNow();
    await itemRef(item.id).set(item, { merge: true });
    return item;
  }

  async function listRange(from, to) {
    var q = itemsRef().where('date', '>=', from).where('date', '<=', to);
    var snap = await q.get();
    return snap.docs
      .filter(function (d) { return d.id !== '_prefs'; })
      .map(function (d) { return Object.assign({ id: d.id }, d.data()); });
  }

  window.DAY_DISTRIBUTE = {
    // prefs + flags
    getPrefs: getPrefs, setPrefs: setPrefs,
    getFeatureFlags: getFeatureFlags,
    // lifecycle
    newItemId: newItemId,
    saveItem: saveItem,
    listRange: listRange,
    defaultSurfacesFor: defaultSurfacesFor,
    distribute: distribute,
    cascadeUpdate: cascadeUpdate,
    cascadeDelete: cascadeDelete,
    retry: retry,
    confirmDone: confirmDone,
    confirmSkipped: confirmSkipped,   // V3.623
    saveOutcome: saveOutcome,         // V3.623 · V3.853 (opts.closeAs)
    closedStatusFor: closedStatusFor, // V3.853
    createFollowUp: createFollowUp,   // V3.623
    nextMondayStr: nextMondayStr,     // V3.623
    recordDoneWork: recordDoneWork,
    // double-dip
    suggestFor: suggestFor,
    importAndDistribute: importAndDistribute,
    renderChips: renderChips,
    renderChipsFloating: renderChipsFloating,
    // registry / misc
    registerAdapter: registerAdapter,
    notebookUpsertIndexRow: upsertIndexRow, // V3.540 — focus reports create entry stubs
    SURFACE_LABELS: SURFACE_LABELS,
    ITEM_OUTCOME_META: ITEM_OUTCOME_META,   // V3.623
    TYPE_SURFACES: TYPE_SURFACES,
    linkFor: linkFor,
    weekIdForDate: weekIdForDate,
    todayStr: todayStr,
  };
})();
