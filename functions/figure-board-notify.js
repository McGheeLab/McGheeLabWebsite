/* ================================================================
   figure-board-notify.js — ONE live "Figure board updated" signal
   per board (V3.612, figure-board program R4)
   ================================================================
   Triggers: papers/{paperId}/boardItems/{itemId}    onWritten
             papers/{paperId}/boardComments/{cid}    onCreated

   Recipients: the paper's authorUids ∪ mentorUids (materialized on
   papers/{paperId} by paper-author-sync.js) minus the actor.

   Alex's spec: "only one notification that something has changed —
   it doesn't matter how many changes." Two mechanisms deliver that:

   1. recordFeedItems collapses on tag, so the feed never stacks
      figboard items for one board.
   2. THE UNREAD GATE here: a recipient who already has an UNREAD
      feed item with this board's tag is skipped entirely (no push,
      no feed rewrite). They get exactly one live signal; the next
      one arrives only after they've read/visited. Reading the item
      (or the board page marking it read) re-arms the notification.

   Noise guards:
   - pure drag writes (only x/y/z/w/updatedAt/updated_by changed)
     never notify — students arrange cards constantly;
   - deletes never notify (the deleter is unattributable from the
     doc, and a delete usually accompanies other edits anyway);
   - the actor never notifies themself.

   Deploy:
     firebase deploy --only functions:onBoardItemWrite,functions:onBoardCommentCreate
   ================================================================ */

const { onDocumentWritten, onDocumentCreated } = require('firebase-functions/v2/firestore');
const { getFirestore } = require('firebase-admin/firestore');
const { getMessaging } = require('firebase-admin/messaging');
const { notifyUsers } = require('./helpers/notify');

const APP_KEY = 'rm';

/* Field set a drag/resize gesture touches — a write inside this set is
 * arrangement, not content. */
const POSITION_KEYS = { x: 1, y: 1, z: 1, w: 1, updatedAt: 1, updated_by: 1 };

function _isPositionOnlyChange(before, after) {
  const keys = new Set(Object.keys(before || {}).concat(Object.keys(after || {})));
  for (const k of keys) {
    const b = JSON.stringify(before ? before[k] : undefined);
    const a = JSON.stringify(after ? after[k] : undefined);
    if (b !== a && !POSITION_KEYS[k]) return false;
  }
  return true;
}

async function _actorName(db, uid) {
  if (!uid) return 'Someone';
  try {
    const snap = await db.collection('users').doc(uid).get();
    const d = snap.exists ? snap.data() : null;
    return (d && (d.name || d.displayName || d.email)) || 'Someone';
  } catch (e) {
    return 'Someone';
  }
}

/* True when the user already holds an unread feed item for this board —
 * they have their one live signal; don't send another. Equality-only
 * query (tag + readAt), served by merged single-field indexes. */
async function _hasUnreadBoardItem(db, uid, tag) {
  try {
    const snap = await db.collection('userData').doc(uid).collection('notifications')
      .where('tag', '==', tag)
      .where('readAt', '==', null)
      .limit(1)
      .get();
    return !snap.empty;
  } catch (e) {
    console.warn(`[fig-board] unread probe failed for ${uid}: ${e && e.message}`);
    return false;   // fail open — worst case is a duplicate feed item that collapses
  }
}

async function _notifyBoardChange(paperId, actorUid, what) {
  const db = getFirestore();
  const paperSnap = await db.collection('papers').doc(paperId).get();
  if (!paperSnap.exists) return;
  const paper = paperSnap.data();
  const authorUids = Array.isArray(paper.authorUids) ? paper.authorUids : [];
  const mentorUids = Array.isArray(paper.mentorUids) ? paper.mentorUids : [];
  const recipients = [...new Set(authorUids.concat(mentorUids))]
    .filter((u) => u && u !== actorUid);
  if (!recipients.length) return;

  const tag = 'figboard-' + paperId;
  const gated = [];
  for (const uid of recipients) {
    if (!(await _hasUnreadBoardItem(db, uid, tag))) gated.push(uid);
  }
  if (!gated.length) return;

  const name = await _actorName(db, actorUid);
  const title = (paper.title || 'a paper').slice(0, 80);
  const notif = {
    title: '🧭 Figure board updated',
    body: name + ' ' + what + ' on the board for "' + title + '"',
    url: '/rm/pages/paper-builder.html?paper=' + paperId + '&page=figure-board',
    tag: tag,
  };
  await notifyUsers(db, getMessaging(), gated, notif, APP_KEY, 'figure-board');
}

const onBoardItemWrite = onDocumentWritten('papers/{paperId}/boardItems/{itemId}', async (event) => {
  const before = event.data && event.data.before && event.data.before.data();
  const after = event.data && event.data.after && event.data.after.data();
  if (!after) return;                                   // delete — see header
  if (before && _isPositionOnlyChange(before, after)) return;
  const actorUid = after.updated_by || after.created_by || null;
  const what = before ? 'edited a card' : 'added a card';
  await _notifyBoardChange(event.params.paperId, actorUid, what);
});

const onBoardCommentCreate = onDocumentCreated('papers/{paperId}/boardComments/{commentId}', async (event) => {
  const snap = event.data;
  if (!snap) return;
  const c = snap.data();
  await _notifyBoardChange(event.params.paperId, c.authorUid || null, 'commented');
});

module.exports = { onBoardItemWrite, onBoardCommentCreate };
