/* ================================================================
   paper-author-sync.js — mirror a paper's author roster onto
   papers/{id}.authorUids
   ================================================================
   The paper-builder stores a paper's editorial metadata (title,
   status, lead_author_uid, co_first_author_uid, coauthor_uids[]) in
   the `projects` collection (type == 'paper'). The paper's live Yjs
   content lives under a SEPARATE top-level doc papers/{paperId}
   (same id) with subcollections yjs_snapshot / yjs_updates /
   presence / blocks / comments / snapshots.

   Historically that parent papers/{paperId} doc was never created —
   only its subcollections existed — so firestore.rules' coauthor
   read gate (which keys on papers/{paperId}.authorUids) always
   failed for non-admins, and PMR's paper-writing query
   (papers.where('authorUids','array-contains', uid)) returned
   nothing for everyone.

   This trigger materializes the parent doc and keeps authorUids in
   sync with the projects roster, in a trusted Admin-SDK context so a
   non-admin can never spoof membership. authorUids is the deduped
   union of lead_author_uid + co_first_author_uid + coauthor_uids
   (equivalent to member_uids, but computed here so legacy rows that
   never got member_uids stamped still work).

   V3.611 (figure-board program R3) — ALSO materializes mentorUids:
   the deduped union of every author's users/{uid}.mentor_uids.
   firestore.rules grants mentors READ on the paper (+ its yjs/blocks/
   comments subcollections) and WRITE on the Figure board, so an
   advisor can review a mentee's paper without being listed as a
   coauthor. Firestore rules can't chain gets over an array, hence the
   server-side fan-out here (exactly the authorUids trust model).
   onMentorRosterSync keeps the mirror fresh when an admin edits a
   user's mentor_uids AFTER their papers were created.

   Deploy:
     firebase deploy --only functions:onPaperAuthorSync,functions:onMentorRosterSync
   ================================================================ */

const { onDocumentWritten } = require('firebase-functions/v2/firestore');
const { getFirestore } = require('firebase-admin/firestore');

function _authorUidsOf(paper) {
  const raw = [paper.lead_author_uid, paper.co_first_author_uid]
    .concat(Array.isArray(paper.coauthor_uids) ? paper.coauthor_uids : []);
  const seen = {};
  const out = [];
  for (let i = 0; i < raw.length; i++) {
    const u = (raw[i] || '').trim();
    if (u && !seen[u]) { seen[u] = true; out.push(u); }
  }
  return out;
}

/* V3.611 — deduped union of every author's users/{uid}.mentor_uids.
 * A missing users doc (external coauthor placeholder) contributes []. */
async function _mentorUidsOf(db, authorUids) {
  const snaps = await Promise.all(authorUids.map(
    (u) => db.collection('users').doc(u).get().catch(() => null)
  ));
  const seen = {};
  const out = [];
  snaps.forEach((s) => {
    const arr = (s && s.exists && Array.isArray(s.data().mentor_uids))
      ? s.data().mentor_uids : [];
    arr.forEach((m) => {
      const t = (m || '').trim();
      if (t && !seen[t]) { seen[t] = true; out.push(t); }
    });
  });
  return out;
}

const onPaperAuthorSync = onDocumentWritten('projects/{projectId}', async (event) => {
  const before = event.data && event.data.before && event.data.before.data();
  const after = event.data && event.data.after && event.data.after.data();
  const db = getFirestore();
  const paperRef = db.collection('papers').doc(event.params.projectId);

  // `projects` is a mixed, discriminated collection (papers, courses, tools,
  // infrastructure, general projects). Only act on papers — never mint a
  // papers/{id} doc for a non-paper project. Clear the mirror ONLY when this
  // doc WAS a paper (type changed away, or deleted), so a removed coauthor
  // loses read access without polluting `papers` for every course/tool save.
  if (!after || after.type !== 'paper') {
    if (before && before.type === 'paper') {
      await paperRef.set({ authorUids: [], mentorUids: [] }, { merge: true }).catch(() => {});
    }
    return;
  }

  const authorUids = _authorUidsOf(after);
  const mentorUids = await _mentorUidsOf(db, authorUids);
  await paperRef.set({
    authorUids: authorUids,
    // V3.611 — advisors of the paper's authors (read + figure-board access;
    // see the papers/** rules). Admin-SDK-only, like authorUids.
    mentorUids: mentorUids,
    // Denormalized so PMR's paper-writing block (which reads these off
    // papers/{id}) works without a second lookup into projects.
    title: after.title || '',
    status: after.status || 'drafting',
    is_library_entry: false,
    updatedAt: new Date(),
  }, { merge: true });
});

/* V3.611 — when a user's mentor roster changes (admin-permissions or
 * team-focus edits users/{uid}.mentor_uids), refresh mentorUids on every
 * paper that user authors. Without this, mentor access would only update
 * the next time someone touched the paper's projects doc. */
const onMentorRosterSync = onDocumentWritten('users/{uid}', async (event) => {
  const before = event.data && event.data.before && event.data.before.data();
  const after = event.data && event.data.after && event.data.after.data();
  const beforeM = (before && Array.isArray(before.mentor_uids)) ? before.mentor_uids : [];
  const afterM = (after && Array.isArray(after.mentor_uids)) ? after.mentor_uids : [];
  if (beforeM.length === afterM.length &&
      beforeM.every((u, i) => u === afterM[i])) {
    return;   // mentor roster unchanged — users docs churn often (presence etc.)
  }
  const uid = event.params.uid;
  const db = getFirestore();
  const papers = await db.collection('papers')
    .where('authorUids', 'array-contains', uid).get();
  if (papers.empty) return;
  await Promise.all(papers.docs.map(async (doc) => {
    const authorUids = Array.isArray(doc.data().authorUids) ? doc.data().authorUids : [];
    const mentorUids = await _mentorUidsOf(db, authorUids);
    await doc.ref.set({ mentorUids: mentorUids }, { merge: true });
  }));
});

module.exports = { onPaperAuthorSync, onMentorRosterSync };
