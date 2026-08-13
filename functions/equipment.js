/* ================================================================
   equipment.js — Push notifications for equipment bookings
   ================================================================
   Triggers:
     equipmentBookings/{bookingId}  onCreate  — approval request,
                                                co-operator, adjacency
     equipmentBookings/{bookingId}  onUpdate  — status changes
                                                (confirmed, displaced),
                                                adjacency, co-operator

   V3.594 added the "shift change" adjacency engine: when two bookings
   on one device sit back-to-back, the person finishing needs to know
   somebody is waiting, and the person waiting needs to know when the
   slot ahead of them shifts. The decision matrix lives in
   helpers/equipment-adjacency.js (pure, unit-tested — run
   `node functions/test/equipment-adjacency.test.js` before deploying).

   V3.597 added notify-me watches: helpers/equipment-watches.js decides
   which `equipmentWatches` docs a freed slot should ping
   (`node functions/test/equipment-watches.test.js`). Both engines run
   off ONE day-bookings read via runBookingChange().

   ANTI-SPAM (three layers, because a student who mutes equipment
   notifications is worse off than one who never had them):
     1. Change classification — a notes-only edit reaches no engine.
     2. Deterministic FCM tags keyed to the RECIPIENT + direction, so
        churn replaces one notice instead of stacking.
     3. A suppression stamp on the recipient's booking
        (notifMeta.adj.{up|down}), so five edits in two minutes buzz
        once. Server-only field: it is absent from every client
        whitelist in firestore.rules.
   ================================================================ */

const { onDocumentCreated, onDocumentUpdated } = require('firebase-functions/v2/firestore');
const { getFirestore, FieldValue } = require('firebase-admin/firestore');
const { getMessaging } = require('firebase-admin/messaging');
const { notifyUsers } = require('./helpers/notify');
const ADJ = require('./helpers/equipment-adjacency');
const WATCH = require('./helpers/equipment-watches');

const APP_KEY = 'equipment';
const EQUIP_URL = '/rm/pages/equipment.html';

/* ---------- config ---------- */

/**
 * Lab-tunable thresholds from equipmentSettings/config (admin-write,
 * already covered by firestore.rules). Falls back to the shipped
 * defaults so a missing doc never breaks notifications.
 */
async function loadConfig(db) {
  try {
    const doc = await db.collection('equipmentSettings').doc('config').get();
    const d = doc.exists ? doc.data() : {};
    const gap = Number(d.adjacencyGapMin);
    const sup = Number(d.adjacencySuppressMin);
    return {
      gapMin: Number.isFinite(gap) && gap >= 0 ? gap : ADJ.DEFAULT_GAP_MIN,
      suppressMin: Number.isFinite(sup) && sup >= 0 ? sup : ADJ.DEFAULT_SUPPRESS_MIN,
    };
  } catch (e) {
    console.warn('[Equipment] config read failed, using defaults:', e && e.message);
    return { gapMin: ADJ.DEFAULT_GAP_MIN, suppressMin: ADJ.DEFAULT_SUPPRESS_MIN };
  }
}

/**
 * All bookings for one device on one date, as plain objects with ids.
 * Served by the existing (equipmentId, date) composite index. A single
 * day on a single instrument is a handful of docs, so filtering active/
 * single-day in memory is cheaper than more indexes.
 */
async function loadDay(db, equipmentId, date) {
  if (!equipmentId || !date) return [];
  const snap = await db.collection('equipmentBookings')
    .where('equipmentId', '==', equipmentId)
    .where('date', '==', date)
    .get();
  return snap.docs.map((d) => Object.assign({ id: d.id }, d.data()));
}

/* ---------- adjacency dispatch ---------- */

/**
 * Has this recipient already been buzzed about this direction inside the
 * suppression window? Reading the stamp off the TARGET booking (not the
 * changed one) is what makes rapid edits collapse per-recipient.
 */
function recentlyNotified(targetBooking, direction, suppressMin) {
  const meta = targetBooking && targetBooking.notifMeta && targetBooking.notifMeta.adj;
  const stamp = meta && meta[direction];
  if (!stamp) return false;
  const then = typeof stamp.toMillis === 'function' ? stamp.toMillis() : Number(stamp);
  if (!Number.isFinite(then)) return false;
  return (Date.now() - then) < suppressMin * 60 * 1000;
}

/**
 * Run the adjacency engine for one booking change and deliver whatever
 * it decides to send. Failures are logged, never thrown: an adjacency
 * miss must not roll back or retry the status notifications that
 * already went out.
 */
async function runAdjacency(db, messaging, { event, before, after, bookingId, dayBookings, cfg }) {
  try {
    const decisions = ADJ.decide({
      event, before, after, dayBookings, bookingId, gapMin: cfg.gapMin,
    });
    if (decisions.length === 0) return;

    // Index the day so we can read each recipient's suppression stamp.
    const byId = new Map(dayBookings.map((b) => [b.id, b]));

    const stamps = [];
    for (const d of decisions) {
      const target = d.targetBookingId ? byId.get(d.targetBookingId) : null;
      if (target && recentlyNotified(target, d.direction, cfg.suppressMin)) {
        console.log(`[Equipment] adjacency suppressed for ${d.recipientUid} (${d.direction}).`);
        continue;
      }

      await notifyUsers(db, messaging, [d.recipientUid], {
        title: d.title, body: d.body, url: d.url || EQUIP_URL, tag: d.tag,
      }, APP_KEY, 'adjacency');

      if (d.targetBookingId) {
        stamps.push(db.collection('equipmentBookings').doc(d.targetBookingId).update({
          [`notifMeta.adj.${d.direction}`]: FieldValue.serverTimestamp(),
        }).catch((e) => console.warn('[Equipment] stamp failed:', e && e.message)));
      }
    }
    await Promise.all(stamps);
  } catch (e) {
    console.error('[Equipment] adjacency engine failed:', e && e.stack);
  }
}

/* ---------- notify-me watches (V3.597) ---------- */

/**
 * Tell watchers when a booking change actually frees usable time inside
 * a window they asked to be notified about.
 *
 * Only cancels and moves can release time, so creates skip this
 * entirely. The matcher re-derives real availability from the after-state
 * before firing, which is what stops "it opened!" pings for time that is
 * still blocked by somebody else.
 */
async function runWatches(db, messaging, { event, before, after, dayBookings }) {
  try {
    if (event !== 'cancelled' && event !== 'moved') return;
    if (!before || !before.equipmentId || !before.date) return;

    const snap = await db.collection('equipmentWatches')
      .where('equipmentId', '==', before.equipmentId)
      .where('date', '==', before.date)
      .where('status', '==', 'active')
      .get();
    if (snap.empty) return;

    const watches = snap.docs.map((d) => Object.assign({ id: d.id }, d.data()));
    const hits = WATCH.matchWatches({ event, before, after, watches, dayBookings });

    for (const h of hits) {
      await notifyUsers(db, messaging, [h.watch.uid], {
        title: h.title, body: h.body, url: h.url || EQUIP_URL, tag: h.tag,
      }, APP_KEY, 'watch');

      // The watch stays ACTIVE — a student who misses this opening should
      // still hear about the next one. lastNotifiedAt throttles instead.
      await db.collection('equipmentWatches').doc(h.watch.id).update({
        lastNotifiedAt: FieldValue.serverTimestamp(),
      }).catch((e) => console.warn('[Equipment] watch stamp failed:', e && e.message));
    }

    if (hits.length) console.log(`[Equipment] notified ${hits.length} watcher(s).`);
  } catch (e) {
    console.error('[Equipment] watch matcher failed:', e && e.stack);
  }
}

/**
 * A student who books inside their own watch window has got what they
 * wanted — retire the watch so it stops pinging them.
 */
async function fulfillWatches(db, booking) {
  try {
    if (!booking.uid || !booking.equipmentId || !booking.date) return;
    const snap = await db.collection('equipmentWatches')
      .where('equipmentId', '==', booking.equipmentId)
      .where('date', '==', booking.date)
      .where('status', '==', 'active')
      .get();
    if (snap.empty) return;

    const watches = snap.docs.map((d) => Object.assign({ id: d.id }, d.data()));
    const done = WATCH.fulfilledWatches(booking, watches);
    await Promise.all(done.map((w) => db.collection('equipmentWatches').doc(w.id)
      .update({ status: 'fulfilled', fulfilledAt: FieldValue.serverTimestamp() })
      .catch((e) => console.warn('[Equipment] fulfill failed:', e && e.message))));
    if (done.length) console.log(`[Equipment] fulfilled ${done.length} watch(es).`);
  } catch (e) {
    console.error('[Equipment] watch fulfillment failed:', e && e.stack);
  }
}

/**
 * One place that loads the day's bookings and runs BOTH engines off the
 * same read — adjacency and watches ask different questions about the
 * same set of docs, so querying twice would be wasteful.
 */
async function runBookingChange(db, messaging, { event, before, after, bookingId }) {
  const anchor = after || before;
  if (!anchor || !anchor.equipmentId) return;

  const cfg = await loadConfig(db);

  // A move that crosses dates needs both days: the neighbors being
  // released live on the old date, the new ones on the new date.
  const dates = [anchor.date];
  if (before && after && before.date && before.date !== after.date) dates.push(before.date);
  const days = await Promise.all(
    [...new Set(dates.filter(Boolean))].map((d) => loadDay(db, anchor.equipmentId, d))
  );
  const dayBookings = [].concat.apply([], days);

  await runAdjacency(db, messaging, { event, before, after, bookingId, dayBookings, cfg });
  await runWatches(db, messaging, { event, before, after, dayBookings });
}

/* ---------- co-operator ---------- */

async function notifyCoOperator(db, messaging, booking, bookingId) {
  if (!booking.coOperatorUid || booking.coOperatorUid === booking.uid) return;
  await notifyUsers(db, messaging, [booking.coOperatorUid], {
    title: `You're named as co-operator`,
    body: `${booking.userName || 'A lab member'} listed you on ${booking.equipmentName} `
      + `for ${booking.date}, ${ADJ.fmt12h(booking.startTime)}–${ADJ.fmt12h(booking.endTime)}.`,
    url: EQUIP_URL,
    tag: `equip-coop-${bookingId}`,
  }, APP_KEY, 'coop');
}

/* ---------- Booking Created ---------- */

const onEquipmentBookingCreate = onDocumentCreated('equipmentBookings/{bookingId}', async (event) => {
  const snap = event.data;
  if (!snap) return;

  const booking = snap.data();
  const bookingId = event.params.bookingId;
  const db = getFirestore();
  const messaging = getMessaging();

  // If booking needs approval, notify equipment managers
  if (booking.status === 'pending-approval' && booking.equipmentId) {
    const equipDoc = await db.collection('equipment').doc(booking.equipmentId).get();
    if (equipDoc.exists) {
      const managers = equipDoc.data().managers || [];
      if (managers.length > 0) {
        await notifyUsers(db, messaging, managers, {
          title: 'Booking Request',
          body: `${booking.userName} requests ${booking.equipmentName} on ${booking.date}`,
          url: EQUIP_URL,
          tag: `equip-approve-${bookingId}`,
        }, APP_KEY, 'approval');
      }
    }
  }

  await notifyCoOperator(db, messaging, booking, bookingId);

  const createdBooking = Object.assign({ id: bookingId }, booking);
  await runBookingChange(db, messaging, {
    event: 'created', before: null, after: createdBooking, bookingId,
  });
  // Booking inside your own watch window retires that watch (V3.597).
  await fulfillWatches(db, createdBooking);
});

/* ---------- Booking Updated ---------- */

const onEquipmentBookingUpdate = onDocumentUpdated('equipmentBookings/{bookingId}', async (event) => {
  const beforeData = event.data.before.data();
  const afterData = event.data.after.data();
  if (!beforeData || !afterData) return;

  const db = getFirestore();
  const messaging = getMessaging();
  const bookingId = event.params.bookingId;

  const statusChanged = beforeData.status !== afterData.status;

  /* -- existing status notifications (unchanged behavior) -- */

  // Booking was displaced — needs rebooking
  if (statusChanged && afterData.status === 'needs-rebooking') {
    await notifyUsers(db, messaging, [afterData.uid], {
      title: 'Booking Displaced',
      body: `Your ${afterData.equipmentName} booking on ${afterData.date} needs rebooking`,
      url: EQUIP_URL,
      tag: `equip-displaced-${bookingId}`,
    }, APP_KEY, 'displaced');
  }

  // Booking confirmed (was pending approval)
  if (statusChanged && afterData.status === 'confirmed' && beforeData.status === 'pending-approval') {
    await notifyUsers(db, messaging, [afterData.uid], {
      title: 'Booking Confirmed',
      body: `Your ${afterData.equipmentName} booking on ${afterData.date} is confirmed`,
      url: EQUIP_URL,
      tag: `equip-confirmed-${bookingId}`,
    }, APP_KEY, 'confirmed');
  }

  /* -- co-operator newly named on an existing booking -- */
  if (beforeData.coOperatorUid !== afterData.coOperatorUid && afterData.coOperatorUid) {
    await notifyCoOperator(db, messaging, afterData, bookingId);
  }

  /* -- adjacency ("shift change") -- */
  const change = ADJ.classifyChange(beforeData, afterData);
  if (change !== 'none') {
    await runBookingChange(db, messaging, {
      event: change,
      before: Object.assign({ id: bookingId }, beforeData),
      after: Object.assign({ id: bookingId }, afterData),
      bookingId,
    });
  }
});

module.exports = { onEquipmentBookingCreate, onEquipmentBookingUpdate };
