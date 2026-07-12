/* V3.319 — activity-signals.js (FuturePlan 04, Workstream B: hours are dead)
 *
 * Shared cross-page helper for auto-captured activity EVENTS. The
 * V3.160–V3.226 confirm loop (hours + status:'pending' + banner nag) is
 * gone: producers fire lightweight events and nothing asks the user to
 * confirm anything.
 *
 * Event shape written to trackerEntries/{uid}/entries:
 *   { date: 'YYYY-MM-DD', text, categoryPath: [],
 *     kind: 'work' | 'schedule', source, source_ref: {kind,id,path},
 *     scheduled_for: date|null, createdAt, updatedAt }
 *
 * Deterministic doc ids (same scheme as V3.160) keep producers idempotent:
 *   - recordWork:     "auto-<kind>-<id>-<date>"  (one event per source per day)
 *   - recordSchedule: "auto-<kind>-<id>"          (one doc per source; date moves)
 *
 * Legacy hours-era entries (status/duration/auto_hours_estimate fields)
 * are NEVER rewritten: docs whose status is 'confirmed' or 'dismissed'
 * are left alone by re-fires, and readers treat missing-status docs as
 * valid — which is exactly what new events are. Year-review / PMR /
 * lab-stats keep reading both shapes.
 *
 * Removed in V3.319: confirm(), dismiss(), listPending(),
 * renderPendingBanner(), renderComingUp() — their only caller was the
 * old hours-centric activity-tracker.js, rewritten in the same release
 * train (V3.320).
 *
 * Globals: window.ActivitySignals
 * Depends on: firebridge (firebase-bridge.js), firebase compat SDK.
 */
(function () {
  'use strict';

  function getDb() {
    return (typeof firebridge !== 'undefined' && firebridge.db) ? firebridge.db() : null;
  }
  function getUid() {
    if (typeof firebridge === 'undefined' || !firebridge.getUser) return null;
    var u = firebridge.getUser();
    return u && u.uid ? u.uid : null;
  }
  function todayStr() {
    return new Date().toISOString().slice(0, 10);
  }
  function safeIdPart(s) {
    return String(s == null ? '' : s).replace(/[^a-zA-Z0-9._-]/g, '_').slice(0, 80);
  }
  function entriesRef(uid) {
    return getDb().collection('trackerEntries').doc(uid).collection('entries');
  }
  function docIdFor(sourceRef, scheduled, date) {
    var base = 'auto-' + safeIdPart(sourceRef.kind) + '-' + safeIdPart(sourceRef.id);
    return scheduled ? base : (base + '-' + safeIdPart(date));
  }

  /* Core upsert. Idempotent.
   *
   * Legacy guard: if the target doc carries a decided hours-era status
   * ('confirmed'/'dismissed'), it is left alone — the user's old decision
   * survives the model change. Otherwise the doc is merged with the
   * latest fields from the source. No hours, no status. */
  async function upsert(opts, scheduled) {
    try {
      var uid = getUid();
      var db = getDb();
      if (!uid || !db) return null;
      if (!opts || !opts.source || !opts.sourceRef || !opts.date) return null;
      if (!opts.sourceRef.kind || !opts.sourceRef.id) return null;

      var docId = docIdFor(opts.sourceRef, scheduled, opts.date);
      var ref = entriesRef(uid).doc(docId);

      var snap = await ref.get();
      var existing = snap.exists ? snap.data() : null;
      if (existing && existing.status &&
          existing.status !== 'pending') {
        return Object.assign({ id: docId, _unchanged: true }, existing);
      }

      var entry = {
        date: opts.date,
        text: String(opts.text || '').slice(0, 500),
        categoryPath: Array.isArray(opts.categoryPath) ? opts.categoryPath.slice() : [],
        kind: scheduled ? 'schedule' : 'work',
        source: opts.source,
        source_ref: {
          kind: opts.sourceRef.kind,
          id:   opts.sourceRef.id,
          path: opts.sourceRef.path || '',
        },
        scheduled_for: scheduled ? opts.date : null,
        updatedAt: firebase.firestore.FieldValue.serverTimestamp(),
      };
      if (existing && existing.status === 'pending') {
        // Upgrade a legacy pending doc in place: strip the hours-era
        // fields so it becomes a plain event instead of nagging forever.
        entry.status = firebase.firestore.FieldValue.delete();
        entry.duration = firebase.firestore.FieldValue.delete();
        entry.auto_hours_estimate = firebase.firestore.FieldValue.delete();
      }
      if (!existing) {
        entry.createdAt = firebase.firestore.FieldValue.serverTimestamp();
      }
      await ref.set(entry, { merge: true });
      return Object.assign({ id: docId }, entry);
    } catch (err) {
      console.warn('[activity-signals] upsert failed:', err);
      return null;
    }
  }

  async function recordWork(opts) {
    opts = opts || {};
    if (!opts.date) opts.date = todayStr();
    return await upsert(opts, false);
  }

  async function recordSchedule(opts) {
    opts = opts || {};
    if (!opts.date) return null;
    return await upsert(opts, true);
  }

  /* Remove the schedule event for this source (source deleted / task
   * checked off before its date). Event docs and legacy pending docs are
   * deleted outright; legacy confirmed/dismissed docs are left alone —
   * they remain a record of the old model's decisions. */
  async function removeSchedule(sourceRef) {
    try {
      var uid = getUid();
      if (!uid || !sourceRef || !sourceRef.kind || !sourceRef.id) return;
      var docId = docIdFor(sourceRef, true, null);
      var ref = entriesRef(uid).doc(docId);
      var snap = await ref.get();
      if (!snap.exists) return;
      var data = snap.data();
      if (data.status && data.status !== 'pending') return;
      await ref.delete();
    } catch (err) {
      console.warn('[activity-signals] removeSchedule failed:', err);
    }
  }

  /* Canonical reader — every entry in range that isn't legacy-dismissed.
   * Both shapes come back: new events (no status) and legacy hours-era
   * entries (status 'confirmed' / 'pending', duration in minutes).
   * Works for own-user (uid omitted) and cross-user reads (admin /
   * shareActivity — firestore.rules trackerEntries read clause). */
  async function listEvents(uid, opts) {
    try {
      var targetUid = uid || getUid();
      if (!targetUid) return [];
      opts = opts || {};
      var q = entriesRef(targetUid);
      if (opts.from) q = q.where('date', '>=', opts.from);
      if (opts.to)   q = q.where('date', '<=', opts.to);
      var snap = await q.get();
      return snap.docs.map(function (d) { return Object.assign({ id: d.id }, d.data()); })
                      .filter(function (e) { return e.status !== 'dismissed'; });
    } catch (err) {
      console.warn('[activity-signals] listEvents failed:', err);
      return [];
    }
  }

  /* Compatibility aliases — PMR + older consumers still call these.
   * listConfirmed additionally drops legacy 'pending' docs (they were
   * never user-confirmed); new events pass through (no status). */
  async function listConfirmed(uid, opts) {
    var rows = await listEvents(uid, opts);
    return rows.filter(function (e) { return !e.status || e.status === 'confirmed'; });
  }
  async function listForPeriod(uid, opts) {
    return await listEvents(uid, opts);
  }

  window.ActivitySignals = {
    recordWork:     recordWork,
    recordSchedule: recordSchedule,
    removeSchedule: removeSchedule,
    listEvents:     listEvents,
    listConfirmed:  listConfirmed,
    listForPeriod:  listForPeriod,
    todayStr:       todayStr,
  };
})();
