/* ================================================================
   inventory-alerts.js — low-stock signals for inventory managers
   (V3.646, scannable-inventory program)
   ================================================================
   Two functions:

   1. onInventoryQtyWrite  — onDocumentWritten('inventory/{itemId}')
      The URGENCY path. Fires when an item CROSSES into low/out.

   2. inventoryLowDigest   — onSchedule, 07:30 America/Phoenix
      The FLOOR. One collapsing summary a day of everything currently
      low or out.

   BOTH, not one. The crossing trigger is lossy BY DESIGN — the guards
   below suppress far more than they send — so a manager back from a
   week away needs a floor that doesn't depend on having been online at
   the moment something crossed. Weekly is too slow for consumables;
   daily with tag-collapse is a single ever-replaced feed item.

   RECIPIENTS — the 'inventory:manage' capability is both the
   authorization primitive AND the addressing one:

     userPermissions.where('caps','array-contains','inventory:manage')

   is a single-field auto-indexed query, so there is no managers[] array
   to curate anywhere. Admins are always included. If nobody holds the
   cap, this falls back to admins alone rather than silently going
   nowhere — but that means the PI gets every alert, which is exactly
   the state granting the cap to one senior student fixes.

   ANTI-NOISE. Ten aliquots off one low batch must not be ten pushes.
   Guards, in order of how much they suppress:
     - crossing-only: unchanged severity never notifies (the big one);
     - a 72h cooldown on low_alerted_at, covering low→out→low churn
       that the crossing guard misses;
     - the unread gate (same shape as figure-board-notify.js): a
       recipient still holding an unread item for this tag is skipped;
     - recovery to 'full' CLEARS low_alerted_at, so the next genuine dip
       alerts again — without this, an item that recovers is silently
       muted for good.

   low_alerted_at is written by the Admin SDK only and must never appear
   in a client hasOnly() list — same discipline as equipment-reminders'
   reminded.{morning,tminus}.

   Deploy:
     firebase deploy --only functions:onInventoryQtyWrite,functions:inventoryLowDigest
   ================================================================ */

const { onDocumentWritten } = require('firebase-functions/v2/firestore');
const { onSchedule } = require('firebase-functions/v2/scheduler');
const { getFirestore, FieldValue } = require('firebase-admin/firestore');
const { getMessaging } = require('firebase-admin/messaging');
const { notifyUsers, recordFeedItems } = require('./helpers/notify');
const { severity, isLowSeverity } = require('./helpers/inventory-thresholds');

/* 'rm' deliberately: every member's existing
 * userSettings.notifications.apps.rm.push preference already governs this, so
 * there is no settings migration and no new toggle defaulting ambiguously. */
const APP_KEY = 'rm';
const KIND = 'inventory-low';
const MANAGE_CAP = 'inventory:manage';
const TZ = 'America/Phoenix';
const COOLDOWN_MS = 72 * 60 * 60 * 1000;
const INV_URL = '/rm/pages/inventory.html';

/* ── recipients ─────────────────────────────────────────────────────── */

async function _managerUids(db) {
  const uids = new Set();
  try {
    const admins = await db.collection('users').where('role', '==', 'admin').get();
    admins.forEach((d) => uids.add(d.id));
  } catch (e) {
    console.warn('[inv-alerts] admin lookup failed:', e && e.message);
  }
  try {
    const capped = await db.collection('userPermissions')
      .where('caps', 'array-contains', MANAGE_CAP).get();
    capped.forEach((d) => uids.add(d.id));
  } catch (e) {
    console.warn('[inv-alerts] cap lookup failed:', e && e.message);
  }
  return [...uids].filter(Boolean);
}

/* Same shape as figure-board-notify.js's _hasUnreadBoardItem. Equality-only
 * query (tag + readAt), served by merged single-field indexes. */
async function _hasUnread(db, uid, tag) {
  try {
    const snap = await db.collection('userData').doc(uid).collection('notifications')
      .where('tag', '==', tag).where('readAt', '==', null).limit(1).get();
    return !snap.empty;
  } catch (e) {
    console.warn(`[inv-alerts] unread probe failed for ${uid}: ${e && e.message}`);
    return false;   // fail open — worst case is a feed item that collapses anyway
  }
}

async function _userName(db, uid) {
  if (!uid) return '';
  try {
    const s = await db.collection('users').doc(uid).get();
    const d = s.exists ? s.data() : null;
    return (d && (d.name || d.displayName || d.email)) || '';
  } catch (e) { return ''; }
}

function _amount(item) {
  const u = item.qty_unit ? ' ' + item.qty_unit : '';
  return Number(item.qty_remaining) + u;
}

function _millis(v) {
  if (!v) return 0;
  if (typeof v.toMillis === 'function') return v.toMillis();
  if (v._seconds) return v._seconds * 1000;
  const t = Date.parse(v);
  return isFinite(t) ? t : 0;
}

/* ── 1. the crossing trigger ────────────────────────────────────────── */

const onInventoryQtyWrite = onDocumentWritten('inventory/{itemId}', async (event) => {
  const itemId = event.params.itemId;
  const before = event.data && event.data.before && event.data.before.data();
  const after = event.data && event.data.after && event.data.after.data();

  if (!after) return;                      // a delete is never an alert
  if (after.qty_tracked !== true) return;  // untracked ⇒ none of this applies

  // Severity from the NUMBERS, not from the client's stock_status.
  const sev = severity(after);
  const sevBefore = before ? severity(before) : 'na';

  const db = getFirestore();
  const ref = event.data.after.ref;

  // Recovered. Clear the stamp so the next genuine dip alerts again —
  // without this an item that recovers is muted for good.
  if (!isLowSeverity(sev)) {
    if (after.low_alerted_at) {
      try { await ref.update({ low_alerted_at: null }); }
      catch (e) { console.warn('[inv-alerts] re-arm failed:', e && e.message); }
    }
    return;
  }

  // THE big guard. Ten aliquots off one low batch = one crossing, not ten.
  // It also makes this function's own low_alerted_at stamp a no-op re-entry,
  // since that write leaves severity unchanged.
  if (sev === sevBefore) return;

  // Covers the low→out→low churn the crossing guard cannot see.
  const lastMs = _millis(after.low_alerted_at);
  if (lastMs && Date.now() - lastMs < COOLDOWN_MS) return;

  const recipients = await _managerUids(db);
  if (!recipients.length) return;

  const actorUid = after.lastUsedBy || null;
  const actorName = await _userName(db, actorUid);
  const tag = 'inv-low-' + itemId;

  const notif = {
    title: sev === 'out' ? 'Out of stock' : 'Running low',
    body: (after.name || 'An item') + ' — ' + _amount(after) + ' left'
        + (after.qty_min != null ? ' (reorder at ' + after.qty_min + ')' : '')
        + (actorName ? ' · last used by ' + actorName : ''),
    url: INV_URL + '?item=' + itemId,
    tag: tag,
  };

  // The actor is not blanket-excluded: a manager who takes the last of
  // something SHOULD get the record, just not a buzz about their own action.
  const others = [];
  for (const uid of recipients) {
    if (uid === actorUid) continue;
    if (!(await _hasUnread(db, uid, tag))) others.push(uid);
  }
  const selfIsManager = actorUid && recipients.indexOf(actorUid) >= 0;

  if (others.length) await notifyUsers(db, getMessaging(), others, notif, APP_KEY, KIND);
  if (selfIsManager) await recordFeedItems(db, [actorUid], notif, APP_KEY, KIND);

  try {
    await ref.update({ low_alerted_at: FieldValue.serverTimestamp() });
  } catch (e) {
    console.warn('[inv-alerts] stamp failed:', e && e.message);
  }
});

/* ── 2. the daily digest ────────────────────────────────────────────── */

const inventoryLowDigest = onSchedule(
  { schedule: '30 7 * * *', timeZone: TZ, timeoutSeconds: 300 },
  async () => {
    const db = getFirestore();
    const recipients = await _managerUids(db);
    if (!recipients.length) return;

    // Served by the composite index qty_tracked ASC, stock_status ASC, name ASC.
    // `in` runs as a disjunction of equality queries, each needing that prefix.
    let snap;
    try {
      snap = await db.collection('inventory')
        .where('qty_tracked', '==', true)
        .where('stock_status', 'in', ['low', 'out_of_stock'])
        .orderBy('name')
        .get();
    } catch (e) {
      console.error('[inv-alerts] digest query failed (index missing?):', e && e.message);
      return;
    }

    // stock_status is written by the client, so re-derive before reporting.
    const rows = [];
    snap.forEach((d) => {
      const it = d.data();
      if (isLowSeverity(severity(it))) rows.push(Object.assign({ id: d.id }, it));
    });
    if (!rows.length) return;

    const out = rows.filter((r) => severity(r) === 'out');
    const head = rows.slice(0, 5).map((r) => (r.name || '?') + ' (' + _amount(r) + ')').join(', ');
    const notif = {
      title: rows.length + (rows.length === 1 ? ' item is' : ' items are') + ' low',
      body: head + (rows.length > 5 ? ', +' + (rows.length - 5) + ' more' : '')
          + (out.length ? ' · ' + out.length + ' out of stock' : ''),
      url: INV_URL + '?tab=low_stock',
      tag: 'inv-digest',   // collapses to ONE ever-replaced feed item
    };
    await notifyUsers(db, getMessaging(), recipients, notif, APP_KEY, KIND);
  }
);

module.exports = { onInventoryQtyWrite, inventoryLowDigest };
