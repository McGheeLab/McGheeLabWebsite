/* user-actions.js — V3.844: things a person DID, recorded for them, ready for
 * the lab notebook.
 *
 * Alex: "actions like using an item should be saved as an action attributed to
 * the user that the user can add to their lab notebook easily … each one of
 * these items is an action listed … other actions are things like they used
 * equipment … users can choose to ignore the items use instead of placing it
 * in the notebook."
 *
 * One doc per deed at userData/{uid}/actions/{id} (owner read/write under the
 * blanket userData rule):
 *   { kind: 'inventory_use' | 'equipment_booking', at: ISO, status: 'new' |
 *     'ignored' | 'noted', notedIn: [{ entryId, cardId }], createdAt, … }
 *   inventory_use   : itemId, itemName, qty, unit, delta, after, useMode, note, labelCode, usageId, context
 *   equipment_booking: equipmentId, equipmentName, date, endDate, startTime, endTime, durationMin, notes, bookingId
 * Ids are inv_<usageId> / eq_<bookingId>, so a retried write never doubles.
 *
 * WHO WRITES: INV_QTY.onLocalWrite (every ledger 'use', from the dial, the
 * notebook's inventory card, stock-take…), INV_USE.run's log/legacy routes, and
 * equipment.js after a booking is created. Readers: actions.html, scan.html
 * (today), the notebook's "Something I did" card (notebook-canvas.js).
 *
 * The core (USER_ACTIONS_CORE) is DOM-free and node-tested. */
(function (root) {
  'use strict';

  var KINDS = {
    inventory_use: { icon: 'cube', label: 'Used an item' },
    equipment_booking: { icon: 'microscope', label: 'Equipment' },
  };

  function num(v, d) { var n = typeof v === 'number' ? v : parseFloat(v); return isFinite(n) ? n : (d == null ? 0 : d); }
  function clean(n) { return Math.round(n * 1e6) / 1e6; }
  function fmtN(v) { return Number(clean(num(v)).toFixed(3)).toString(); }
  var COUNT_PLURAL = { pack: 'packs', box: 'boxes', vial: 'vials', tube: 'tubes', plate: 'plates', aliquot: 'aliquots', slide: 'slides', bottle: 'bottles', piece: 'pieces', package: 'packages', use: 'uses' };
  function unitWord(unit, n) {
    if (unit === 'uL') return 'µL';
    if (unit === 'ug') return 'µg';
    return (n !== 1 && COUNT_PLURAL[unit]) || unit || '';
  }
  function pad(n) { return (n < 10 ? '0' : '') + n; }
  function isoNow() { return new Date().toISOString(); }

  /** An action from an inventory ledger result (INV_QTY.write's `out`, or INV_USE.run's). */
  function fromInventory(out) {
    out = out || {};
    var item = out.item || {};
    var usageId = out.usageId || '';
    return {
      id: 'inv_' + (usageId || Date.now().toString(36)),
      kind: 'inventory_use', at: out.at || isoNow(), status: 'new',
      itemId: out.itemId || item.id || '', itemName: item.name || out.itemName || '',
      qty: clean(num(out.qty)), unit: out.unit || '', delta: clean(num(out.delta)), after: out.after != null ? clean(num(out.after)) : null,
      useMode: out.useMode || item.use_mode || '', note: out.note || '', labelCode: out.labelCode || null, usageId: usageId, context: out.context || '',
      legacy: !!out.legacy,
    };
  }

  /** An action from a new equipment booking (equipment.js bookingData). */
  function fromBooking(id, b) {
    b = b || {};
    return {
      id: 'eq_' + (id || Date.now().toString(36)),
      kind: 'equipment_booking', at: isoNow(), status: 'new',
      equipmentId: b.equipmentId || '', equipmentName: b.equipmentName || '', date: b.date || '', endDate: b.endDate || b.date || '',
      startTime: b.startTime || '', endTime: b.endTime || '', durationMin: num(b.durationMin) || null, notes: b.notes || '', bookingId: id || '',
      coOperatorName: b.coOperatorName || null,
    };
  }

  function bookingEnd(a) {
    if (!a.date) return null;
    var d = new Date((a.endDate || a.date) + 'T' + (a.endTime || '23:59') + ':00');
    return isNaN(d.getTime()) ? null : d;
  }
  var DAYS = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];
  var MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
  function shortDate(ymd) {
    var m = /^(\d{4})-(\d{2})-(\d{2})/.exec(ymd || '');
    if (!m) return ymd || '';
    var d = new Date(+m[1], +m[2] - 1, +m[3]);
    return DAYS[d.getDay()] + ' ' + d.getDate() + ' ' + MONTHS[d.getMonth()];
  }

  /** The one line a person reads: "Used 2.5 µL of Anti-tubulin" · "Booked the confocal · Thu 23 Oct 10:00–12:00". */
  function describe(a, now) {
    a = a || {};
    now = now || new Date();
    if (a.kind === 'equipment_booking') {
      var end = bookingEnd(a);
      var verb = end && end.getTime() < now.getTime() ? 'Used' : 'Booked';
      var when = [shortDate(a.date), a.startTime && a.endTime ? a.startTime + '–' + a.endTime : (a.startTime || '')].filter(Boolean).join(' ');
      return verb + ' the ' + (a.equipmentName || 'equipment') + (when ? ' · ' + when : '');
    }
    var name = a.itemName ? ' of ' + a.itemName : '';
    var n = clean(num(a.qty));
    if (a.unit === 'use' || (!a.delta && a.unit !== 'package')) {
      return 'Logged ' + (n === 1 ? 'a use' : fmtN(n) + ' uses') + name;
    }
    var u = a.unit === 'ea' && a.legacy ? 'package' : a.unit;
    return (a.useMode === 'per_use' ? 'Used ' : 'Took ') + fmtN(n) + ' ' + unitWord(u, n) + name;
  }

  function dayKey(iso) {
    var d = iso ? new Date(iso) : new Date();
    if (isNaN(d.getTime())) return String(iso || '').slice(0, 10);
    return d.getFullYear() + '-' + pad(d.getMonth() + 1) + '-' + pad(d.getDate());
  }
  function dayLabel(key, today) {
    today = today || dayKey();
    if (key === today) return 'Today';
    var t = new Date(today + 'T12:00:00'); t.setDate(t.getDate() - 1);
    if (key === dayKey(t.toISOString())) return 'Yesterday';
    return shortDate(key);
  }
  function timeOf(iso) {
    var d = new Date(iso || '');
    return isNaN(d.getTime()) ? '' : pad(d.getHours()) + ':' + pad(d.getMinutes());
  }
  /** Newest first, grouped: [{ key, label, rows }]. */
  function groupByDay(list, today) {
    var sorted = (list || []).slice().sort(function (x, y) { return String(y.at || '').localeCompare(String(x.at || '')); });
    var out = [], idx = {};
    sorted.forEach(function (a) {
      var k = dayKey(a.at);
      if (idx[k] == null) { idx[k] = out.length; out.push({ key: k, label: dayLabel(k, today), rows: [] }); }
      out[idx[k]].rows.push(a);
    });
    return out;
  }
  function pending(list) { return (list || []).filter(function (a) { return a.status !== 'ignored' && a.status !== 'noted'; }); }

  var CORE = { KINDS, fromInventory, fromBooking, describe, dayKey, dayLabel, groupByDay, pending, timeOf, shortDate, fmtN, unitWord, bookingEnd };
  if (typeof module !== 'undefined' && module.exports) module.exports = CORE;
  if (!root || typeof root.document === 'undefined') return;
  root.USER_ACTIONS_CORE = CORE;

  /* ── page half ─────────────────────────────────────────────────────── */
  function fb() { return (typeof firebridge !== 'undefined') ? firebridge : null; }
  function me() { var f = fb(); return f && f.getUser ? f.getUser() : null; }
  function db() { var f = fb(); return f && f.db ? f.db() : firebase.firestore(); }
  function ts() { return firebase.firestore.FieldValue.serverTimestamp(); }
  function col(uid) {
    var u = uid || (me() && me().uid);
    if (!u) throw new Error('Sign in first.');
    return db().collection('userData').doc(u).collection('actions');
  }
  var _listeners = [];
  function onChange(fn) { _listeners.push(fn); return function () { _listeners = _listeners.filter(function (f) { return f !== fn; }); }; }
  function fire(kind, a) { _listeners.forEach(function (f) { try { f(kind, a); } catch (e) {} }); }

  /** Save a deed. Resolves the action (id included) or null when nobody is signed in. */
  async function record(a) {
    if (!a || !a.id || !me()) return null;
    var doc = Object.assign({ status: 'new', notedIn: [] }, a, { createdAt: ts() });
    await col().doc(a.id).set(doc, { merge: true });
    fire('record', a);
    return a;
  }
  async function list(opts) {
    opts = opts || {};
    var snap = await col().orderBy('at', 'desc').limit(opts.limit || 200).get();
    var rows = snap.docs.map(function (d) { return Object.assign({ id: d.id }, d.data()); });
    if (!opts.includeIgnored) rows = rows.filter(function (a) { return a.status !== 'ignored'; });
    return rows;
  }
  async function get(id) {
    var s = await col().doc(id).get();
    return s.exists ? Object.assign({ id: s.id }, s.data()) : null;
  }
  async function setStatus(id, status, extra) {
    await col().doc(id).update(Object.assign({ status: status, updatedAt: ts() }, extra || {}));
    fire('status', { id: id, status: status });
  }
  function ignore(id) { return setStatus(id, 'ignored'); }
  function restore(id) { return setStatus(id, 'new'); }
  function markNoted(id, where) {
    var entry = { entryId: (where && where.entryId) || '', cardId: (where && where.cardId) || '', at: isoNow() };
    return setStatus(id, 'noted', { notedIn: firebase.firestore.FieldValue.arrayUnion(entry) });
  }

  // Every ledger 'use' from any surface becomes an action for the person who did it.
  function wireInventory() {
    if (!root.INV_QTY || !INV_QTY.onLocalWrite) return false;
    INV_QTY.onLocalWrite(function (out) {
      if (!out || out.event !== 'use') return;
      record(fromInventory(out)).catch(function (e) { console.warn('[actions] record failed', e && e.message); });
    });
    return true;
  }
  if (!wireInventory()) document.addEventListener('DOMContentLoaded', wireInventory);

  root.USER_ACTIONS = { record, list, get, ignore, restore, markNoted, onChange, describe, core: CORE,
    fromInventory, fromBooking, groupByDay, pending, timeOf, dayKey };
})(typeof window !== 'undefined' ? window : null);
