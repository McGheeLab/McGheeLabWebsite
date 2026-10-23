/* equipment-availability.js — V3.527 (My Week program R2)
 *
 * Read-side equipment helpers shared by the My Week composer's inline
 * availability strip and day-distribute.js's equipment adapter. Extracted
 * as a COPY of the pure logic in rm/js/equipment.js (availability window
 * V3.336, conflict overlap) so equipment.js itself stays untouched — the
 * booking-modal page keeps its own richer flow (displacement, co-operator,
 * GCal sync); this helper covers the student "is the slot free?" path and
 * NEVER displaces an existing booking.
 *
 * Differences from equipment.js on purpose:
 *   - no admin/manager availability bypass (My Week is the student path);
 *   - duration over maxDurationMin → { needsApproval: true } instead of
 *     the extended-booking confirm dance;
 *   - conflicts block, full stop (the displacement flow lives on the
 *     Equipment page).
 *
 * Globals: window.EQUIP_AVAIL
 * Depends: firebridge, firebase compat SDK.
 */
(function () {
  'use strict';

  function db() { return (typeof firebridge !== 'undefined' && firebridge.db) ? firebridge.db() : null; }

  var DAY_LABELS = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];
  var _catalog = null;

  /* ── Criticality (V3.588) ───────────────────────────────────
     Stored `priority` enum is unchanged (normal|high|urgent|
     maintenance) — only the student-facing label changes, so old
     bookings and firestore.rules keep working. equipment.js keeps
     its own closure copy of this table (equipment.html does not
     load this file); functions/helpers/equipment-adjacency.js keeps
     the server copy. Keep all three in sync. */
  var PRIORITY_LABELS = {
    normal: 'Soft', high: 'Firm', urgent: 'Hard', maintenance: 'Maintenance'
  };
  var PRIORITY_HINTS = {
    normal:      'Flexible — running late has no downstream effect',
    high:        'Must start on time; duration flexible; high importance',
    urgent:      'Zero flexibility — mission critical',
    maintenance: 'Device blocked for maintenance'
  };
  function priorityLabel(p) { return PRIORITY_LABELS[p] || PRIORITY_LABELS.normal; }
  function priorityHint(p)  { return PRIORITY_HINTS[p]  || PRIORITY_HINTS.normal; }

  function timeToMin(t) {
    if (!t || t.indexOf(':') < 0) return null;
    var p = t.split(':');
    return (+p[0]) * 60 + (+p[1]);
  }
  function minToLabel(min) {
    if (min >= 1440) return '11:59 PM';
    var h = Math.floor(min / 60), m = min % 60;
    var ampm = h >= 12 ? 'PM' : 'AM';
    var h12 = h % 12 || 12;
    return h12 + (m ? ':' + String(m).padStart(2, '0') : '') + ' ' + ampm;
  }

  /* Same normalization as equipment.js availabilityRestrictions (V3.336). */
  function availabilityRestrictions(equip) {
    if (!equip) return null;
    var days = Array.isArray(equip.availableDays) ? equip.availableDays : null;
    var hours = equip.availableHours || null;
    var daysRestricted = days && days.length > 0 && days.length < 7;
    var hoursRestricted = hours && (((hours.start != null ? hours.start : 0) > 0) || ((hours.end != null ? hours.end : 24) < 24));
    if (!daysRestricted && !hoursRestricted) return null;
    return {
      days: daysRestricted ? days : null,
      startMin: hoursRestricted ? (hours.start || 0) * 60 : 0,
      endMin: hoursRestricted ? (hours.end != null ? hours.end : 24) * 60 : 24 * 60,
    };
  }

  function availabilityLabel(equip) {
    var r = availabilityRestrictions(equip);
    if (!r) return '';
    var dayPart = r.days ? r.days.slice().sort().map(function (d) { return DAY_LABELS[d]; }).join('/') : 'every day';
    return dayPart + ', ' + minToLabel(r.startMin) + '–' + minToLabel(r.endMin);
  }

  /* Device catalog, one-shot cached (composer dropdown). */
  async function listEquipment(force) {
    if (_catalog && !force) return _catalog;
    try {
      var snap = await db().collection('equipment').orderBy('name').get();
      _catalog = snap.docs
        .map(function (d) { return Object.assign({ id: d.id }, d.data()); })
        .filter(function (e) { return e.status !== 'retired'; });
    } catch (err) {
      console.warn('[equip-avail] listEquipment failed:', err && err.message);
      _catalog = [];
    }
    return _catalog;
  }

  async function getEquipment(equipmentId) {
    var list = await listEquipment();
    var hit = list.find(function (e) { return e.id === equipmentId; });
    if (hit) return hit;
    try {
      var snap = await db().collection('equipment').doc(equipmentId).get();
      return snap.exists ? Object.assign({ id: snap.id }, snap.data()) : null;
    } catch (err) { return null; }
  }

  /* Live bookings for one device on one date (blocking statuses only). */
  async function listForDay(equipmentId, date) {
    try {
      var snap = await db().collection('equipmentBookings')
        .where('equipmentId', '==', equipmentId)
        .where('date', '==', date)
        .get();
      return snap.docs
        .map(function (d) { return Object.assign({ id: d.id }, d.data()); })
        .filter(function (b) { return b.status === 'confirmed' || b.status === 'needs-rebooking' || b.status === 'pending-approval'; })
        .sort(function (a, b) { return (a.startTime || '').localeCompare(b.startTime || ''); });
    } catch (err) {
      console.warn('[equip-avail] listForDay failed:', err && err.message);
      return [];
    }
  }

  /* Full slot check: availability window + conflicts + advance limit +
   * duration-approval. Returns
   *   { ok, reason?, needsApproval?, equipmentName, bookings, restrictions } */
  async function checkSlot(equipmentId, date, startTime, endTime, ignoreBookingId) {
    var equip = await getEquipment(equipmentId);
    if (!equip) return { ok: false, reason: 'Unknown equipment' };
    var name = equip.shortName || equip.name || equipmentId;
    var startMin = timeToMin(startTime), endMin = timeToMin(endTime);
    if (startMin == null || endMin == null || endMin <= startMin) {
      return { ok: false, reason: 'Pick a start and end time', equipmentName: name };
    }

    // Posted availability window (no student bypass).
    var r = availabilityRestrictions(equip);
    if (r) {
      var dow = new Date(date + 'T00:00:00').getDay();
      if (r.days && r.days.indexOf(dow) < 0) {
        return { ok: false, reason: name + ' is bookable ' + availabilityLabel(equip) + ' — ' + DAY_LABELS[dow] + ' is outside its available days.', equipmentName: name, restrictions: r };
      }
      if (startMin < r.startMin || endMin > r.endMin) {
        return { ok: false, reason: name + ' is bookable ' + availabilityLabel(equip) + '.', equipmentName: name, restrictions: r };
      }
    }

    // Advance-days limit.
    if (equip.maxAdvanceDays) {
      var maxDate = new Date();
      maxDate.setDate(maxDate.getDate() + equip.maxAdvanceDays);
      if (new Date(date + 'T00:00:00') > maxDate) {
        return { ok: false, reason: 'Cannot book more than ' + equip.maxAdvanceDays + ' days in advance.', equipmentName: name };
      }
    }

    // Conflicts — block, never displace (that flow lives on the Equipment page).
    var bookings = await listForDay(equipmentId, date);
    var clash = bookings.find(function (b) {
      if (ignoreBookingId && b.id === ignoreBookingId) return false;
      var bs = timeToMin(b.startTime), be = timeToMin(b.endTime);
      if (bs == null || be == null) return false;
      return startMin < be && endMin > bs;
    });
    if (clash) {
      return {
        ok: false,
        reason: 'Taken ' + clash.startTime + '–' + clash.endTime + ' by ' + (clash.userName || 'someone') + ' — pick another slot, or use the Equipment page for the displacement flow.',
        equipmentName: name, bookings: bookings, restrictions: r,
      };
    }

    // Duration over the posted max → manager approval instead of refusal.
    var needsApproval = !!(equip.maxDurationMin && (endMin - startMin) > equip.maxDurationMin);
    return { ok: true, needsApproval: needsApproval, equipmentName: name, bookings: bookings, restrictions: r };
  }

  /* ── Notify-me watches (V3.598) ─────────────────────────────
     Thin wrappers over the same `equipmentWatches` docs the Equipment
     page writes (V3.597). Shape must stay identical — firestore.rules
     whitelists the keys exactly, and there is deliberately no update
     path (lastNotifiedAt / status are Admin-SDK-only). */
  function uid() {
    var u = (typeof firebridge !== 'undefined' && firebridge.getUser) ? firebridge.getUser() : null;
    return u ? u.uid : null;
  }

  async function createWatch(equipmentId, equipmentName, date, startTime, endTime) {
    var d = db();
    if (!d) throw new Error('Firestore not ready');
    var me = uid();
    if (!me) throw new Error('Not signed in');
    var profile = (typeof firebridge !== 'undefined' && firebridge.getProfile) ? firebridge.getProfile() : null;
    var user = (typeof firebridge !== 'undefined' && firebridge.getUser) ? firebridge.getUser() : null;
    var ref = await d.collection('equipmentWatches').add({
      uid: me,
      userName: (profile && profile.name) || (user && (user.displayName || user.email)) || '',
      equipmentId: equipmentId,
      equipmentName: equipmentName || '',
      date: date,
      startTime: startTime,
      endTime: endTime,
      status: 'active',
      createdAt: firebase.firestore.FieldValue.serverTimestamp(),
    });
    return ref.id;
  }

  async function deleteWatch(id) {
    var d = db();
    if (!d) return;
    await d.collection('equipmentWatches').doc(id).delete();
  }

  /** Own active watches, optionally narrowed to one device + date. */
  async function listWatches(equipmentId, date) {
    var d = db();
    var me = uid();
    if (!d || !me) return [];
    try {
      var q = d.collection('equipmentWatches').where('uid', '==', me);
      if (date) q = q.where('date', '==', date);
      var snap = await q.get();
      return snap.docs.map(function (doc) {
        return Object.assign({ id: doc.id }, doc.data());
      }).filter(function (w) {
        return w.status === 'active' && (!equipmentId || w.equipmentId === equipmentId);
      });
    } catch (e) {
      console.warn('[equip-avail] watch list failed:', e && e.message);
      return [];
    }
  }

  window.EQUIP_AVAIL = {
    listEquipment: listEquipment,
    getEquipment: getEquipment,
    listForDay: listForDay,
    checkSlot: checkSlot,
    createWatch: createWatch,
    deleteWatch: deleteWatch,
    listWatches: listWatches,
    availabilityRestrictions: availabilityRestrictions,
    availabilityLabel: availabilityLabel,
    timeToMin: timeToMin,
    PRIORITY_LABELS: PRIORITY_LABELS,
    priorityLabel: priorityLabel,
    priorityHint: priorityHint,
  };
})();
