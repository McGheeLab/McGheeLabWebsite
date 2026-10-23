/* ================================================================
   research-foci-notify.js — research-map proposal pushes (V3.851)
   ================================================================
   researchFoci/{fociId}  onWritten —

     • the transition INTO approval.status 'proposed' (a lab member
       proposed a card, or re-proposed one after a decline) notifies the
       people who can decide it: the proposer's direct advisors
       (users/{proposer}.mentor_uids) and every admin — never the
       proposer themself.
     • the transition INTO 'approved' or 'declined' notifies the
       proposer, with the decline note when there is one.

   Cross-user feed writes are impossible from the browser: the
   userData/{uid}/** wildcard is owner-write, so a student cannot put an
   item in their advisor's feed. Hence a function (the class-notify /
   bme466-notify precedent).

   The decision of WHAT happened is a pure function (proposalTransition)
   so functions/test/research-foci-notify.test.js can pin it down without
   an emulator. A card with no `approval` key is a legacy PI-authored
   card and reads as approved — an admin creating or editing one is a
   null transition. `approval.notified_status` is stamped after a send so
   a retried trigger never re-sends (triggers are at-least-once); the
   stamp itself is an approval-to-same-approval write, i.e. null.
   ================================================================ */

const { onDocumentWritten } = require('firebase-functions/v2/firestore');
const { getFirestore } = require('firebase-admin/firestore');
const { getMessaging } = require('firebase-admin/messaging');
const { notifyUsers } = require('./helpers/notify');

const APP_KEY = 'research';
const PAGE = '/rm/pages/research.html';

function approvalStatus(d) {
  const a = d && d.approval;
  return a && a.status ? String(a.status) : 'approved';
}
function proposerOf(d) {
  return (d && ((d.approval && d.approval.proposed_by) || d.created_by)) || null;
}

/** What happened, or null when nothing worth a notification happened.
 *  @returns {null | { kind: 'proposed'|'approved'|'declined', reproposed?: boolean }} */
function proposalTransition(before, after) {
  if (!after) return null;                                   // deletions are silent
  const b = before ? approvalStatus(before) : null;
  const a = approvalStatus(after);
  if (a === b) return null;                                  // edits, stamps, no-ops
  if (a === 'proposed') return { kind: 'proposed', reproposed: b === 'declined' };
  if (!b) return null;                                       // created already decided: an admin's card
  if (a === 'approved') return { kind: 'approved' };
  if (a === 'declined') return { kind: 'declined' };
  return null;
}

async function nameOf(db, uid) {
  if (!uid) return 'Someone';
  try {
    const s = await db.collection('users').doc(uid).get();
    const u = s.exists ? s.data() : {};
    return u.name || u.displayName || u.email || uid;
  } catch (e) { return uid; }
}

/* The proposer's mentors ∪ every admin, minus the proposer. An unknown
   proposer (no users doc) still reaches the admins — a proposal nobody
   hears about is the failure that matters. */
async function deciderUids(db, proposerUid) {
  let mentors = [];
  try {
    const s = await db.collection('users').doc(proposerUid).get();
    mentors = (s.exists && Array.isArray(s.data().mentor_uids)) ? s.data().mentor_uids : [];
  } catch (e) { console.warn(`[research] mentor lookup failed for ${proposerUid}: ${e.message}`); }
  let admins = [];
  try {
    const snap = await db.collection('users').where('role', '==', 'admin').get();
    admins = snap.docs.map((d) => d.id);
  } catch (e) { console.warn(`[research] admin lookup failed: ${e.message}`); }
  return [...new Set([...mentors, ...admins])].filter((u) => u && u !== proposerUid);
}

const onResearchFocusWritten = onDocumentWritten('researchFoci/{fociId}', async (event) => {
  const before = event.data.before.exists ? event.data.before.data() : null;
  const after = event.data.after.exists ? event.data.after.data() : null;
  const t = proposalTransition(before, after);
  if (!t) return;
  const status = approvalStatus(after);
  if (after.approval && after.approval.notified_status === status) return;   // retry

  const { fociId } = event.params;
  const db = getFirestore();
  const messaging = getMessaging();
  const proposer = proposerOf(after);
  const title = after.title || fociId;
  const level = after.level || 'card';
  const url = `${PAGE}?id=${encodeURIComponent(fociId)}`;

  if (t.kind === 'proposed') {
    const targets = await deciderUids(db, proposer);
    if (targets.length) {
      const who = await nameOf(db, proposer);
      await notifyUsers(db, messaging, targets, {
        title: t.reproposed ? 'Research focus re-proposed' : 'Research focus proposed',
        body: `${who} proposed a ${level}: "${title}" — open it to approve or decline.`,
        url, tag: `rf-proposal-${fociId}`
      }, APP_KEY, 'research-proposal');
    } else {
      console.log(`[research] ${fociId} proposed by ${proposer} but nobody to notify`);
    }
  } else if (proposer) {
    const decider = await nameOf(db, after.approval && after.approval.decided_by);
    const note = after.approval && after.approval.note ? ` — "${String(after.approval.note).slice(0, 200)}"` : '';
    await notifyUsers(db, messaging, [proposer], t.kind === 'approved' ? {
      title: 'Research focus approved',
      body: `${decider} approved "${title}". It is now part of the research map.`,
      url, tag: `rf-decision-${fociId}`
    } : {
      title: 'Research focus declined',
      body: `${decider} declined "${title}"${note}. Edit it and re-propose, or withdraw it.`,
      url, tag: `rf-decision-${fociId}`
    }, APP_KEY, 'research-decision');
  }

  await event.data.after.ref.update({ 'approval.notified_status': status });
});

module.exports = {
  onResearchFocusWritten,
  _internal: { proposalTransition, approvalStatus, proposerOf }
};
