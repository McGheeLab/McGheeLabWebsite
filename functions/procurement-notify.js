/* ================================================================
   procurement-notify.js — Procurement v2 pushes (V3.813)
   ================================================================
   Two functions:

   1. onProcurementTicketWritten — onDocumentWritten('procurementTickets/{id}')
      The ticket walks requested ⇄ needs_info → approved → ordered →
      received → placed (denied / cancelled terminal). Every transition
      has an audience; `plan(before, after)` decides WHO hears WHAT and
      is pure (node-tested in test/procurement-notify.test.js):

        created             → approvers       "New purchase request"
        → needs_info        → requester       "Question about your request"
        needs_info → requested → approvers    "Answered"
        → approved          → requester + purchasers
        → denied            → requester
        → ordered           → requester (+ watchers)
        ordered → approved  → requester       (order undone)
        → received          → requester + watchers "Arrived — put it away"
        → placed            → requester       "Put away at <location>"
        → cancelled         → approvers
        reopened            → approvers
        edited (requested)  → approvers
        note added          → watchers (everyone who touched the ticket)
        issue flagged       → purchasers
        funding reassigned  → requester (+ purchasers when approved/ordered)   V3.814
        edit by a non-requester before approval → requester too              V3.814

      The actor (after.lastActorUid, stamped by the client on every
      write) never hears about their own action.

   2. procurementDailySweep — onSchedule 08:00 America/Phoenix
      The floor: requests waiting > 5 days → approvers; orders past
      their ETA + 2 days → purchasers; arrivals unplaced > 3 days →
      receiver + requester. One collapsing feed item per audience per
      day (tag-collapsed), so a stale queue nags once a morning, not
      once per ticket.

   RECIPIENTS — the caps are both the authorization and the addressing
   primitive (same pattern as inventory-alerts.js):
     approvers  = users.role=='admin' ∪ userPermissions.caps ∋ 'procurement:approve'
     purchasers = users.role=='admin' ∪ userPermissions.caps ∋ 'procurement:order'

   appKey 'procurement' → Settings → Notifications → "Purchasing"
   (default ON via the `!(x && x.push === false)` idiom).

   Deploy:
     firebase deploy --only functions:onProcurementTicketWritten,functions:procurementDailySweep
   ================================================================ */

const { onDocumentWritten } = require('firebase-functions/v2/firestore');
const { onSchedule } = require('firebase-functions/v2/scheduler');
const { getFirestore } = require('firebase-admin/firestore');
const { getMessaging } = require('firebase-admin/messaging');
const { notifyUsers } = require('./helpers/notify');

const APP_KEY = 'procurement';
const PAGE = '/rm/pages/procurement.html';
const TZ = 'America/Phoenix';
const APPROVE_CAP = 'procurement:approve';
const ORDER_CAP = 'procurement:order';

const STATUS_LABEL = {
  requested: 'awaiting approval', needs_info: 'waiting on a question', approved: 'approved', ordered: 'on order',
  received: 'arrived', placed: 'in inventory', denied: 'denied', cancelled: 'withdrawn',
};

/* ─── pure helpers ──────────────────────────────────────────────────── */

function short(s, n) {
  s = (s == null ? '' : String(s)).trim();
  n = n || 70;
  return s.length > n ? s.slice(0, n - 1) + '…' : s;
}
function money(n) {
  if (n == null || n === '' || !isFinite(+n)) return '';
  return '$' + (+n).toFixed(2).replace(/\B(?=(\d{3})+(?!\d))/g, ',');
}
function toMs(v) {
  if (!v) return 0;
  if (typeof v === 'number') return v;
  if (typeof v.toMillis === 'function') return v.toMillis();
  if (typeof v.seconds === 'number') return v.seconds * 1000;
  if (typeof v._seconds === 'number') return v._seconds * 1000;
  if (v instanceof Date) return v.getTime();
  if (typeof v === 'string') { const t = Date.parse(/^\d{4}-\d{2}-\d{2}$/.test(v) ? v + 'T12:00:00' : v); return isFinite(t) ? t : 0; }
  return 0;
}
function ticketUrl(id) { return PAGE + '?ticket=' + encodeURIComponent(id); }
function tagFor(id) { return 'proc:' + id; }
function lastNote(t) { const n = (t && Array.isArray(t.notes)) ? t.notes : []; return n.length ? n[n.length - 1] : null; }
function lastHistory(t) { const h = (t && Array.isArray(t.history)) ? t.history : []; return h.length ? h[h.length - 1] : null; }

/**
 * Decide the notifications for one write. Returns
 *   [{ audience: 'approvers'|'purchasers'|'requester'|'watchers', title, body, kind, urgent? }]
 * Audiences are resolved by the trigger; the actor is removed there.
 */
function plan(before, after) {
  if (!after) return [];                              // a delete tells nobody
  const out = [];
  const item = short(after.itemDescription);
  const who = after.requesterName || 'Someone';
  const est = after.estimatedCost ? ' · ~' + money(after.estimatedCost) : '';
  const sb = before ? (before.status || 'requested') : null;
  const sa = after.status || 'requested';
  const push = (audience, title, body, kind, urgent) => out.push({ audience, title, body: short(body, 140), kind, urgent: !!urgent });

  if (!before) {
    const rec = after.purchaseType === 'recurring' ? ' · recurring' : '';
    if (sa === 'requested') push('approvers', 'New purchase request' + (after.urgency === 'urgent' ? ' (urgent)' : ''), who + ': ' + item + est + rec, 'request', after.urgency === 'urgent');
    return out;
  }

  if (sb !== sa) {
    switch (sa) {
      case 'needs_info':
        push('requester', 'Question about your request', (after.questionByName ? after.questionByName + ': ' : '') + (after.question || item), 'question');
        break;
      case 'requested':
        if (sb === 'needs_info') {
          // Answered with a note, or answered by EDITING the request (the core
          // sends a requester's edit during a question back to requested).
          const n = lastNote(after), nb = lastNote(before), h = lastHistory(after);
          const fresh = n && n.kind === 'answer' && (!nb || nb.id !== n.id);
          push('approvers', who + ' answered', item + ' — ' + (fresh ? n.text : ((h && h.note) || 'request edited')), 'answer');
        }
        else if (sb === 'approved') {
          push('approvers', 'Back for approval', item + (lastHistory(after) && lastHistory(after).note ? ' — ' + lastHistory(after).note : ''), 'reapproval');
          push('requester', 'Approval withdrawn: ' + item, (lastHistory(after) && lastHistory(after).note) || 'It needs approving again.', 'status');
        }
        else if (sb === 'cancelled' || sb === 'denied') {
          push('approvers', 'Request reopened', who + ': ' + item + est, 'request');
          push('requester', 'Reopened: ' + item, 'Your request is back in the approval queue.', 'status');
        }
        break;
      case 'approved':
        if (sb === 'ordered') push('requester', 'Order undone', item + ' is back to "approved — to order".', 'status');
        else {
          push('requester', 'Approved: ' + item, (after.approvedByName ? 'By ' + after.approvedByName + '. ' : '') + (after.piNotes ? after.piNotes : 'It will be ordered next.'), 'status');
          push('purchasers', 'Ready to order', who + ': ' + item + est + (after.vendor ? ' · ' + after.vendor : '') + (after.fundingLabel || after.fundingAccount ? ' · charge to ' + (after.fundingLabel || after.fundingAccount) : ''), 'order');
        }
        break;
      case 'denied':
        push('requester', 'Denied: ' + item, after.piNotes ? after.piNotes : 'No reason given.', 'status');
        if (sb === 'approved') push('purchasers', 'Do not order: ' + item, 'It was denied after approval' + (after.piNotes ? ' — ' + after.piNotes : '.'), 'status');
        break;
      case 'ordered':
        if (sb === 'received') push('requester', 'Received undone', item + ' is back to "on order".', 'status');
        else push('watchers', 'Ordered: ' + item, (after.poNumber ? 'PO ' + after.poNumber + '. ' : '') + (after.expectedDelivery ? 'Expected ' + after.expectedDelivery + '.' : 'No delivery date yet.'), 'status');
        break;
      case 'received':
        push('watchers', 'Arrived: ' + item, (after.receivedByName ? after.receivedByName + ' marked it received. ' : '') + (after.requestedBy ? 'Put it away and record where it went.' : ''), 'status');
        break;
      case 'placed':
        push('requester', 'Put away: ' + item, (after.location ? 'At ' + after.location : 'Recorded in inventory') + (after.placedByName ? ' by ' + after.placedByName : '') + '.', 'status');
        break;
      case 'cancelled':
        push('approvers', 'Request withdrawn', who + ': ' + item, 'status');
        if (sb === 'approved') push('purchasers', 'Do not order: ' + item, who + ' withdrew it after approval.', 'status');
        break;
    }
    return out;
  }

  // Same status — a note, a flag, a funding change, or an edit.
  if (after.issue && !before.issue) {
    push('purchasers', 'Problem with an order', item + ': ' + after.issue, 'issue', true);
    return out;
  }
  const h = lastHistory(after), hb = lastHistory(before);
  const freshH = h && (!hb || hb.id !== h.id);
  // V3.814 — "Change funding": the requester is told as a follow-up, always.
  // Checked BEFORE the notes branch (the action also appends a 'funding' note,
  // which the "non-note kinds tell nobody" rule below would otherwise swallow).
  if (freshH && h.action === 'reassign') {
    const now = after.fundingLabel || after.fundingAccount || after.project || '—';
    const was = after.fundingChangedFrom || before.fundingLabel || before.fundingAccount || before.project || '—';
    const by = h.byName || after.fundingChangedByName || 'The approver';
    const body = by + ' moved it to ' + now + ' (was ' + was + ')' + (h.note && h.note.indexOf(' — ') > 0 ? ' —' + h.note.slice(h.note.indexOf(' — ') + 2) : '') + '.';
    push('requester', 'Funding changed: ' + item, body, 'funding');
    // Past approval the purchaser charges it (or has, and may need a cost transfer).
    if (sa === 'approved' || sa === 'ordered') push('purchasers', 'Charge to a different string: ' + item, 'Now ' + now + ' (was ' + was + ')' + (sa === 'ordered' ? ' — already ordered; move the charge if needed.' : '.'), 'funding');
    return out;
  }
  const nb = (before.notes || []).length, na = (after.notes || []).length;
  if (na > nb) {
    const n = after.notes[na - 1];
    if (n && (n.kind === 'note' || !n.kind)) push('watchers', (n.byName || 'Someone') + ' on ' + item, n.text || '', 'note');
    return out;
  }
  if (freshH && h.action === 'edit' && (sa === 'requested' || sa === 'needs_info')) {
    push('approvers', 'Request edited', who + ': ' + item + (h.note ? ' — ' + h.note : ''), 'edit');
    // V3.814 — an approver (or anyone who is not the requester) changed the
    // request before approval: the requester hears about it, not only the
    // other approvers.
    if (h.by && after.requestedBy && h.by !== after.requestedBy) push('requester', 'Your request was changed', item + (h.note ? ' — ' + h.note : ''), 'edit');
  } else if (freshH && h.action === 'edit' && sa === 'approved') {
    // An approver changed an approved request (qty, account…) — the requester should know.
    push('requester', 'Your request was changed', item + (h.note ? ' — ' + h.note : ''), 'edit');
  } else if (freshH && h.action === 'edit_order' && sa === 'ordered') {
    const eta = after.expectedDelivery !== before.expectedDelivery;
    const po = after.poNumber !== before.poNumber;
    if (eta || po) push('watchers', 'Order updated: ' + item, (eta ? 'Now expected ' + (after.expectedDelivery || 'date unknown') + '. ' : '') + (po ? 'PO ' + (after.poNumber || '—') + '.' : ''), 'status');
  }
  return out;
}

/** Daily floor. Returns [{ uids, title, body, tag, kind }] grouped per audience/user. */
function sweepPlan(tickets, now, audiences) {
  const n = toMs(now) || Date.now();
  const DAY = 86400000;
  const out = [];
  // Stale = no ACTIVITY for 5 days: an answer or a reopen restarts the clock.
  const lastAct = (t) => toMs(t.lastActivityAt) || toMs(t.updatedAt) || toMs(t.createdAt);
  const stale = tickets.filter((t) => (t.status || 'requested') === 'requested' && lastAct(t) && n - lastAct(t) > 5 * DAY);
  if (stale.length && audiences.approvers.length) {
    out.push({ uids: audiences.approvers, tag: 'proc-sweep-requests', kind: 'reminder',
      title: stale.length === 1 ? 'A purchase request has waited 5+ days' : stale.length + ' purchase requests have waited 5+ days',
      body: stale.slice(0, 3).map((t) => short(t.itemDescription, 40)).join(' · ') + (stale.length > 3 ? ' …' : ''), url: PAGE + '?view=inbox' });
  }
  const overdue = tickets.filter((t) => t.status === 'ordered' && toMs(t.expectedDelivery) && n - toMs(t.expectedDelivery) > 2 * DAY);
  if (overdue.length && audiences.purchasers.length) {
    out.push({ uids: audiences.purchasers, tag: 'proc-sweep-overdue', kind: 'reminder',
      title: overdue.length === 1 ? 'An order is past its expected delivery' : overdue.length + ' orders are past their expected delivery',
      body: overdue.slice(0, 3).map((t) => short(t.itemDescription, 40) + (t.poNumber ? ' (PO ' + t.poNumber + ')' : '')).join(' · ') + (overdue.length > 3 ? ' …' : ''), url: PAGE + '?view=active&status=ordered' });
  }
  const unplaced = tickets.filter((t) => t.status === 'received' && toMs(t.receivedAt) && n - toMs(t.receivedAt) > 3 * DAY);
  const perUser = {};
  unplaced.forEach((t) => {
    // One entry per PERSON per ticket — the receiver is often the requester.
    [...new Set([t.receivedBy, t.requestedBy].filter((u) => u && !String(u).startsWith('guest_')))].forEach((u) => { (perUser[u] = perUser[u] || []).push(t); });
  });
  Object.keys(perUser).forEach((uid) => {
    const list = perUser[uid];
    out.push({ uids: [uid], tag: 'proc-sweep-unplaced', kind: 'reminder',
      title: list.length === 1 ? 'A package is still waiting to be put away' : list.length + ' packages are still waiting to be put away',
      body: list.slice(0, 3).map((t) => short(t.itemDescription, 40)).join(' · ') + (list.length > 3 ? ' …' : ''), url: PAGE + '?view=inbox' });
  });
  return out;
}

/* ─── recipients ────────────────────────────────────────────────────── */

async function uidsWithCap(db, cap) {
  const uids = new Set();
  try {
    const admins = await db.collection('users').where('role', '==', 'admin').get();
    admins.forEach((d) => uids.add(d.id));
  } catch (e) { console.warn('[proc-notify] admin lookup failed:', e && e.message); }
  try {
    const capped = await db.collection('userPermissions').where('caps', 'array-contains', cap).get();
    capped.forEach((d) => uids.add(d.id));
  } catch (e) { console.warn('[proc-notify] cap lookup failed:', e && e.message); }
  return [...uids].filter(Boolean);
}

async function resolveAudiences(db) {
  const [approvers, purchasers] = await Promise.all([uidsWithCap(db, APPROVE_CAP), uidsWithCap(db, ORDER_CAP)]);
  return { approvers, purchasers };
}

function audienceUids(audience, after, aud) {
  const requester = after.requestedBy ? [after.requestedBy] : [];
  switch (audience) {
    case 'approvers':  return aud.approvers;
    case 'purchasers': return aud.purchasers;
    case 'requester':  return requester;
    case 'watchers':   return [...new Set([...(after.watcherUids || []), ...requester])];
  }
  return [];
}

/* ─── 1. the trigger ────────────────────────────────────────────────── */

const onProcurementTicketWritten = onDocumentWritten('procurementTickets/{ticketId}', async (event) => {
  const id = event.params.ticketId;
  const before = event.data && event.data.before && event.data.before.exists ? event.data.before.data() : null;
  const after = event.data && event.data.after && event.data.after.exists ? event.data.after.data() : null;
  const items = plan(before, after);
  if (!items.length) return;

  const db = getFirestore();
  const messaging = getMessaging();
  const aud = await resolveAudiences(db);
  const actor = after.lastActorUid || null;

  for (const it of items) {
    const uids = audienceUids(it.audience, after, aud).filter((u) => u && u !== actor && !String(u).startsWith('guest_'));
    if (!uids.length) continue;
    try {
      const sent = await notifyUsers(db, messaging, uids, {
        title: it.title, body: it.body, url: ticketUrl(id), tag: tagFor(id), urgent: it.urgent,
      }, APP_KEY, it.kind);
      console.log(`[proc-notify] ${id} ${before ? before.status : '∅'}→${after.status} ${it.audience}(${uids.length}) "${it.title}" sent=${sent}`);
    } catch (e) {
      console.error('[proc-notify] send failed:', e && e.message);
    }
  }
});

/* ─── 2. the daily sweep ────────────────────────────────────────────── */

const procurementDailySweep = onSchedule({ schedule: '0 8 * * *', timeZone: TZ }, async () => {
  const db = getFirestore();
  const messaging = getMessaging();
  const snap = await db.collection('procurementTickets').where('status', 'in', ['requested', 'ordered', 'received']).get();
  const tickets = snap.docs.map((d) => Object.assign({ id: d.id }, d.data()));
  if (!tickets.length) return;
  const aud = await resolveAudiences(db);
  const items = sweepPlan(tickets, Date.now(), aud);
  for (const it of items) {
    try {
      const sent = await notifyUsers(db, messaging, it.uids, { title: it.title, body: it.body, url: it.url, tag: it.tag }, APP_KEY, it.kind);
      console.log(`[proc-sweep] ${it.tag} → ${it.uids.length} user(s) sent=${sent}`);
    } catch (e) {
      console.error('[proc-sweep] send failed:', e && e.message);
    }
  }
});

module.exports = {
  onProcurementTicketWritten,
  procurementDailySweep,
  _internal: { plan, sweepPlan, audienceUids, short, money, toMs, STATUS_LABEL },
};
