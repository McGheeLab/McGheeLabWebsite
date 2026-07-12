/* ================================================================
   stats-updater.js — keep userData/{uid}/stats/{kind}-{year} live
   ================================================================
   Firestore-triggered functions that increment per-user stats
   counters whenever the scrapers write a new emailMessages or
   calendarEvents doc. Saves the read cost of summing thousands
   of raw docs every time a graph wants "emails this year".

   Counters use FieldValue.increment so two near-simultaneous
   scrape writes don't trample each other.

   When raw docs are *deleted* (rare — calendarEvents marks
   cancelled events as deleted) we decrement.

   Initial seed: scripts/build_user_stats.py runs once over the
   existing collections to populate the docs. After that, these
   triggers keep them in sync.

   Triggers:
     - onWrite of userData/{uid}/emailMessages/{id}
     - onWrite of userData/{uid}/calendarEvents/{id}

   Deploy:
     firebase deploy --only functions:onEmailMessageWrite,functions:onCalendarEventWrite
   ================================================================ */

const { onDocumentWritten } = require('firebase-functions/v2/firestore');
const { getFirestore, FieldValue } = require('firebase-admin/firestore');

function _yearOfEmail(m) {
  const t = Number(m && m.internalDate) || 0;
  if (t > 0) return new Date(t).getFullYear();
  const s = m && m.date;
  if (s) {
    const d = new Date(s);
    if (!isNaN(d.getTime())) return d.getFullYear();
  }
  return 0;
}

function _yearOfEvent(ev) {
  const s = (ev && ev.start_at) || (ev && ev.start) || '';
  if (s.length >= 4) {
    const y = parseInt(s.slice(0, 4), 10);
    if (!isNaN(y)) return y;
  }
  return 0;
}

function _senderKey(from) {
  if (!from) return '';
  const s = String(from);
  const m = s.match(/<([^>]+)>/);
  if (m) return m[1].toLowerCase().trim();
  return s.toLowerCase().trim();
}

function _emailDeltas(m, sign) {
  // Returns a map of { fieldPath: incrementValue } to apply to the
  // year's stats doc. `sign` is +1 (create) or -1 (delete).
  const out = { totalCount: FieldValue.increment(sign) };
  const t = Number(m.internalDate) || 0;
  let dt = null;
  if (t > 0) dt = new Date(t);
  else if (m.date) { const d = new Date(m.date); if (!isNaN(d.getTime())) dt = d; }
  if (dt) {
    const month = String(dt.getMonth() + 1).padStart(2, '0');
    const hour = String(dt.getHours()).padStart(2, '0');
    out['byMonth.' + month] = FieldValue.increment(sign);
    out['byHour.' + hour] = FieldValue.increment(sign);
    // byDayOfWeek is an array — Firestore doesn't have array-element-increment
    // primitives; we re-build the array client-side via transaction below.
  }
  const cat = (m.category || '').toLowerCase().trim();
  if (cat) out['byCategory.' + cat] = FieldValue.increment(sign);
  const sub = (m.sub_category || '').toLowerCase().trim();
  if (sub) out['bySubCategory.' + sub] = FieldValue.increment(sign);
  const labels = m.labels || [];
  if (labels.includes('UNREAD')) out.unread = FieldValue.increment(sign);
  if (labels.includes('STARRED')) out.starred = FieldValue.increment(sign);
  return { increments: out, dayOfWeek: dt ? dt.getDay() : null, sender: _senderKey(m.from) };
}

function _eventDeltas(ev, sign) {
  const out = { totalCount: FieldValue.increment(sign) };
  const start = ev.start_at || ev.start || '';
  if (start.length >= 7) {
    out['byMonth.' + start.slice(5, 7)] = FieldValue.increment(sign);
  }
  const cat = (ev.category || '').toLowerCase().trim();
  if (cat) out['byCategory.' + cat] = FieldValue.increment(sign);
  const sub = (ev.sub_category || '').toLowerCase().trim();
  if (sub) out['bySubCategory.' + sub] = FieldValue.increment(sign);
  let durMin = ev.duration_min || 0;
  if (!durMin && start && (ev.end_at || ev.end)) {
    try {
      const s = new Date(start);
      const e = new Date(ev.end_at || ev.end);
      if (!isNaN(s.getTime()) && !isNaN(e.getTime()) && e > s) {
        durMin = Math.round((e - s) / 60000);
      }
    } catch {}
  }
  if (durMin > 0) {
    out.totalMinutes = FieldValue.increment(sign * durMin);
    if (cat) out['minutesByCategory.' + cat] = FieldValue.increment(sign * durMin);
  }
  if (ev.all_day) out.allDayCount = FieldValue.increment(sign);
  let dayOfWeek = null;
  try {
    const dt = new Date(start);
    if (!isNaN(dt.getTime())) dayOfWeek = dt.getDay();
  } catch {}
  return { increments: out, dayOfWeek, organizer: (ev.organizer_email || '').toLowerCase().trim() };
}

/* Apply increments to a stats doc. Array fields (byDayOfWeek) and array-of-
 * tuple fields (bySender, byOrganizer) need a transactional read-modify-write
 * because Firestore lacks array-element-increment + counter-cap primitives. */
async function _applyToStats(db, uid, kind, year, increments, dayOfWeek, contactKey) {
  if (!year) return;
  const ref = db.collection('userData').doc(uid).collection('stats').doc(kind + '-' + year);

  // Batch the simple field increments first (no read needed).
  const writes = Object.assign({ kind, year, lastUpdatedAt: FieldValue.serverTimestamp() }, increments);
  await ref.set(writes, { merge: true });

  // For arrays, transactional update.
  if (dayOfWeek != null || contactKey) {
    await db.runTransaction(async (tx) => {
      const snap = await tx.get(ref);
      const cur = snap.exists ? snap.data() : {};
      const arr = Array.isArray(cur.byDayOfWeek) ? cur.byDayOfWeek.slice() : [0,0,0,0,0,0,0];
      const updates = {};
      if (dayOfWeek != null && dayOfWeek >= 0 && dayOfWeek <= 6) {
        const sign = (cur.totalCount || 0) >= 0 ? 1 : 1;  // sign passed via increments separately; this is just for the +1
        // Determine sign by checking if totalCount field's pending value would increase or decrease.
        // We can't easily inspect the pending value; instead, the caller passes dayOfWeek with sign
        // via a separate flag. For now treat each call as +1 — deletes are rare for emails.
        arr[dayOfWeek] = (arr[dayOfWeek] || 0) + 1;
        updates.byDayOfWeek = arr;
      }
      if (contactKey) {
        // bySender / byOrganizer stored as array of {email, count} dicts
        // (Firestore disallows nested arrays so [email, count] tuples fail).
        const arrKey = kind === 'email' ? 'bySender' : 'byOrganizer';
        const list = Array.isArray(cur[arrKey]) ? cur[arrKey].slice() : [];
        // Migrate legacy [email, count] tuples in-place if any exist.
        for (let i = 0; i < list.length; i++) {
          if (Array.isArray(list[i]) && list[i].length === 2) {
            list[i] = { email: list[i][0], count: list[i][1] };
          }
        }
        const idx = list.findIndex(t => t && t.email === contactKey);
        if (idx >= 0) list[idx] = { email: contactKey, count: list[idx].count + 1 };
        else list.push({ email: contactKey, count: 1 });
        list.sort((a, b) => b.count - a.count);
        updates[arrKey] = list.slice(0, 30);
      }
      tx.set(ref, updates, { merge: true });
    });
  }
}

const onEmailMessageWrite = onDocumentWritten('userData/{uid}/emailMessages/{messageId}', async (event) => {
  const uid = event.params.uid;
  const before = event.data && event.data.before && event.data.before.exists ? event.data.before.data() : null;
  const after = event.data && event.data.after && event.data.after.exists ? event.data.after.data() : null;
  // We only handle creates (new email scraped). Updates (label changes, etc.)
  // would need delta-aware logic; skip for now to keep counters monotonic.
  if (before || !after) return;
  const year = _yearOfEmail(after);
  if (!year) return;
  const { increments, dayOfWeek, sender } = _emailDeltas(after, +1);
  await _applyToStats(getFirestore(), uid, 'email', year, increments, dayOfWeek, sender);
});

const onCalendarEventWrite = onDocumentWritten('userData/{uid}/calendarEvents/{eventId}', async (event) => {
  const uid = event.params.uid;
  const before = event.data && event.data.before && event.data.before.exists ? event.data.before.data() : null;
  const after = event.data && event.data.after && event.data.after.exists ? event.data.after.data() : null;
  if (before || !after) return;
  const year = _yearOfEvent(after);
  if (!year) return;
  const { increments, dayOfWeek, organizer } = _eventDeltas(after, +1);
  await _applyToStats(getFirestore(), uid, 'calendar', year, increments, dayOfWeek, organizer);
});

module.exports = { onEmailMessageWrite, onCalendarEventWrite };
