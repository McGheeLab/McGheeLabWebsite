/* ================================================================
   equipment-reminders.js — scheduled equipment notifications
   ================================================================
   Two scheduled jobs:

     equipmentBookingReminders  every 15 min  — morning-of + T-30,
                                                plus housekeeping
                                                (feed TTL + watch expiry)
     equipmentWeeklyDigest      Mon 07:30     — per-manager summary

   The 15-minute job carries both sweeps so the notification feed
   (V3.594) and notify-me watches (V3.597) need no scheduled functions
   of their own. Both sweeps are try/caught — housekeeping must never
   take the reminders down with it.

   WHY THESE REINFORCE THE HANDOFF STORY (V3.594)
   Telling someone "be off the scope by noon" three days in advance is
   useless if nothing reminds them on the day. The T-30 reminder is the
   one that actually prevents a late handoff, so it names the next
   booking when there is one.

   TIME HANDLING — read before editing
   Booking `date`/`startTime`/`endTime` are LOCAL WALL-CLOCK STRINGS
   ('YYYY-MM-DD' / 'HH:MM'), not Timestamps. So we never parse them into
   Date objects; we compute "now" in Phoenix as a (dateStr, minutes)
   pair and compare strings/integers. Arizona has no DST, which is why
   this stays simple — do not copy this pattern to a DST timezone
   without revisiting it.

   IDEMPOTENCE
   A 15-minute cadence means each booking is seen many times. Admin-SDK
   `reminded.{morning,tminus}` flags on the booking doc make each
   reminder fire exactly once. Server-only fields: absent from every
   client whitelist in firestore.rules.
   ================================================================ */

const { onSchedule } = require('firebase-functions/v2/scheduler');
const { getFirestore, FieldValue } = require('firebase-admin/firestore');
const { getMessaging } = require('firebase-admin/messaging');
const { notifyUsers, sendToUsers } = require('./helpers/notify');
const ADJ = require('./helpers/equipment-adjacency');

const APP_KEY = 'equipment';
const EQUIP_URL = '/rm/pages/equipment.html';
const TZ = 'America/Phoenix';

/* Morning-of reminders wait until the lab is awake. */
const MORNING_MIN = 7 * 60 + 30;   // 07:30
/* T-minus window. Must be >= the schedule interval or a booking can slip
   between runs; 30 with a 15-min cadence gives every booking two looks. */
const TMINUS_MIN = 30;
/* Feed retention — matches My Week's read window. */
const FEED_TTL_DAYS = 14;

/**
 * "Now" in Phoenix as wall-clock parts. Intl is the only reliable way to
 * do this without a tz library (same approach as ics-scraper.js:163).
 */
function phoenixNow() {
  const parts = new Intl.DateTimeFormat('en-US', {
    timeZone: TZ, hourCycle: 'h23',
    year: 'numeric', month: '2-digit', day: '2-digit',
    hour: '2-digit', minute: '2-digit',
  }).formatToParts(new Date()).reduce((a, p) => (a[p.type] = p.value, a), {});
  return {
    dateStr: `${parts.year}-${parts.month}-${parts.day}`,
    minutes: (+parts.hour) * 60 + (+parts.minute),
  };
}

function shiftDateStr(dateStr, days) {
  const p = String(dateStr).split('-');
  const d = new Date(Date.UTC(+p[0], +p[1] - 1, +p[2]));
  d.setUTCDate(d.getUTCDate() + days);
  return d.toISOString().slice(0, 10);
}

/** Recipients of a booking's own reminders: owner + co-operator. */
function bookingAudience(b) {
  const uids = [b.uid];
  if (b.coOperatorUid && b.coOperatorUid !== b.uid) uids.push(b.coOperatorUid);
  return uids.filter(Boolean);
}

/* ================================================================
   Reminders — every 15 minutes
   ================================================================ */

const equipmentBookingReminders = onSchedule(
  { schedule: 'every 15 minutes', timeZone: TZ, timeoutSeconds: 300 },
  async () => {
    const db = getFirestore();
    const messaging = getMessaging();
    const now = phoenixNow();

    // Today's live bookings. Served by the existing (status, date) index.
    const snap = await db.collection('equipmentBookings')
      .where('status', '==', 'confirmed')
      .where('date', '==', now.dateStr)
      .get();

    const bookings = snap.docs.map((d) => Object.assign({ id: d.id }, d.data()));

    // Neighbor lookup for the T-30 body, grouped per device so we make
    // no extra queries — everything today is already in `bookings`.
    const byDevice = new Map();
    bookings.forEach((b) => {
      if (!byDevice.has(b.equipmentId)) byDevice.set(b.equipmentId, []);
      byDevice.get(b.equipmentId).push(b);
    });

    let morning = 0, tminus = 0;

    for (const b of bookings) {
      const startMin = ADJ.timeToMin(b.startTime);
      if (startMin === null) continue;
      const reminded = b.reminded || {};
      const audience = bookingAudience(b);
      if (!audience.length) continue;

      const window = `${ADJ.fmt12h(b.startTime)}–${ADJ.fmt12h(b.endTime)}`;

      /* -- morning-of -- */
      if (!reminded.morning && now.minutes >= MORNING_MIN && startMin > now.minutes) {
        await notifyUsers(db, messaging, audience, {
          title: `Today: ${b.equipmentName}`,
          body: `${window}${b.notes ? ' — ' + b.notes : ''}`,
          url: EQUIP_URL,
          tag: `equip-remind-${b.id}-am`,
        }, APP_KEY, 'reminder');
        await db.collection('equipmentBookings').doc(b.id)
          .update({ 'reminded.morning': true })
          .catch((e) => console.warn('[EquipRemind] morning flag failed:', e && e.message));
        morning++;
      }

      /* -- T-minus 30 -- */
      const untilStart = startMin - now.minutes;
      if (!reminded.tminus && untilStart > 0 && untilStart <= TMINUS_MIN) {
        // A booking made moments ago for right now needs no reminder.
        const createdMs = b.createdAt && b.createdAt.toMillis ? b.createdAt.toMillis() : 0;
        const freshlyMade = createdMs && (Date.now() - createdMs) < TMINUS_MIN * 60 * 1000;

        if (!freshlyMade) {
          // If somebody is booked right after this one, say so now —
          // this is the reminder that actually prevents a late handoff.
          const day = byDevice.get(b.equipmentId) || [];
          const nb = ADJ.findNeighbors(day, b, ADJ.intervalOf(b), 30, b.id);
          const handoff = (nb.downstream && !ADJ.isSoft(nb.downstream.priority)
            && nb.downstream.uid !== b.uid)
            ? ` ${nb.downstream.userName || 'Someone'} is booked right after you — `
              + `please be off by ${ADJ.fmt12h(b.endTime)}.`
            : '';

          await notifyUsers(db, messaging, audience, {
            title: `${b.equipmentName} in ${untilStart} min`,
            body: `${window}.${handoff}`,
            url: EQUIP_URL,
            tag: `equip-remind-${b.id}-t30`,
          }, APP_KEY, 'reminder');
          tminus++;
        }

        await db.collection('equipmentBookings').doc(b.id)
          .update({ 'reminded.tminus': true })
          .catch((e) => console.warn('[EquipRemind] tminus flag failed:', e && e.message));
      }
    }

    await sweepFeed(db);
    await sweepWatches(db, now.dateStr);

    console.log(`[EquipRemind] ${now.dateStr} ${now.minutes}min — `
      + `${bookings.length} booking(s), ${morning} morning, ${tminus} t-30.`);
  }
);

/**
 * Delete notification-feed items past their TTL. Piggybacks on the
 * 15-minute job so the feed has no separate scheduled function.
 * collectionGroup keeps it one query across all users.
 */
async function sweepFeed(db) {
  try {
    const cutoff = new Date(Date.now() - FEED_TTL_DAYS * 86400000);
    const old = await db.collectionGroup('notifications')
      .where('createdAt', '<', cutoff)
      .limit(400)
      .get();
    if (old.empty) return;
    const batch = db.batch();
    old.docs.forEach((d) => batch.delete(d.ref));
    await batch.commit();
    console.log(`[EquipRemind] swept ${old.size} expired feed item(s).`);
  } catch (e) {
    // A missing collectionGroup index here must not fail the reminders.
    console.warn('[EquipRemind] feed sweep skipped:', e && e.message);
  }
}

/**
 * Delete notify-me watches whose day has passed (V3.597). A watch is a
 * request about a specific date, so once that date is gone it can only
 * generate confusion. Rides the same 15-minute job.
 */
async function sweepWatches(db, todayStr) {
  try {
    const stale = await db.collection('equipmentWatches')
      .where('date', '<', todayStr)
      .limit(400)
      .get();
    if (stale.empty) return;
    const batch = db.batch();
    stale.docs.forEach((d) => batch.delete(d.ref));
    await batch.commit();
    console.log(`[EquipRemind] swept ${stale.size} expired watch(es).`);
  } catch (e) {
    console.warn('[EquipRemind] watch sweep skipped:', e && e.message);
  }
}

/* ================================================================
   Weekly manager digest — Monday 07:30
   ================================================================ */

const equipmentWeeklyDigest = onSchedule(
  { schedule: '30 7 * * 1', timeZone: TZ, timeoutSeconds: 300 },
  async () => {
    const db = getFirestore();
    const messaging = getMessaging();
    const now = phoenixNow();
    const weekEnd = shiftDateStr(now.dateStr, 6);

    // manager uid → the devices they look after
    const equipSnap = await db.collection('equipment').get();
    const managerDevices = new Map();
    const deviceName = new Map();
    equipSnap.docs.forEach((doc) => {
      const eq = doc.data() || {};
      deviceName.set(doc.id, eq.shortName || eq.name || doc.id);
      (eq.managers || []).forEach((uid) => {
        if (!uid) return;
        if (!managerDevices.has(uid)) managerDevices.set(uid, new Set());
        managerDevices.get(uid).add(doc.id);
      });
    });
    if (!managerDevices.size) return;

    // Two range queries on the existing (status, date) index.
    const [pendingSnap, weekSnap] = await Promise.all([
      db.collection('equipmentBookings')
        .where('status', '==', 'pending-approval')
        .where('date', '>=', now.dateStr).get(),
      db.collection('equipmentBookings')
        .where('status', '==', 'confirmed')
        .where('date', '>=', now.dateStr)
        .where('date', '<=', weekEnd).get(),
    ]);

    const pending = pendingSnap.docs.map((d) => d.data());
    const week = weekSnap.docs.map((d) => d.data());

    let sent = 0;
    for (const [uid, devices] of managerDevices) {
      const myPending = pending.filter((b) => devices.has(b.equipmentId));
      const myWeek = week.filter((b) => devices.has(b.equipmentId));

      // Nothing happening on your machines → no digest. A weekly "0
      // pending, 0 booked" push is exactly the kind of noise that makes
      // people mute a category.
      if (!myPending.length && !myWeek.length) continue;

      const bookedMin = myWeek.reduce((sum, b) => {
        const d = Number(b.durationMin);
        if (Number.isFinite(d)) return sum + d;
        const s = ADJ.timeToMin(b.startTime), e = ADJ.timeToMin(b.endTime);
        return sum + (s !== null && e !== null && e > s ? e - s : 0);
      }, 0);
      const hours = Math.round(bookedMin / 60);

      const bits = [];
      if (myPending.length) bits.push(`${myPending.length} pending approval`);
      bits.push(`${myWeek.length} booking${myWeek.length === 1 ? '' : 's'} (${hours}h) this week`);

      // Busiest device is the useful detail for a manager scanning fast.
      const perDevice = new Map();
      myWeek.forEach((b) => perDevice.set(b.equipmentId, (perDevice.get(b.equipmentId) || 0) + 1));
      let busiest = null, busiestN = 0;
      perDevice.forEach((n, id) => { if (n > busiestN) { busiestN = n; busiest = id; } });
      const busiestBit = busiest ? ` Busiest: ${deviceName.get(busiest) || busiest}.` : '';

      // Digest is a manager convenience, not something to catch up on
      // item by item — push only, no feed item.
      await sendToUsers(db, messaging, [uid], {
        title: 'Equipment digest',
        body: `${bits.join(' · ')}.${busiestBit}`,
        url: EQUIP_URL,
        tag: `equip-digest-${now.dateStr}`,
      }, APP_KEY);
      sent++;
    }

    console.log(`[EquipDigest] week of ${now.dateStr} — ${sent} manager digest(s) sent.`);
  }
);

module.exports = {
  equipmentBookingReminders,
  equipmentWeeklyDigest,
  // Exported for functions/test/equipment-reminders.test.js — the time
  // math is where the bugs live, and it needs no emulator to check.
  _internal: { phoenixNow, shiftDateStr, bookingAudience, MORNING_MIN, TMINUS_MIN },
};
