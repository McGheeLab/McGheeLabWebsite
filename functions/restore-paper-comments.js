/* ================================================================
   restorePaperComments — faithful comment restore on paper import
   (Bidirectional import/export E3).
   ================================================================
   A paper bundle carries comments.json (papers/{id}/comments docs). The
   client comment-create rule pins `authorUid` to the caller, so a client
   import would re-attribute every comment to the importer. This function
   uses the Admin SDK (bypasses rules) to recreate each comment with its
   TRUE original authorUid + timestamps, so attribution + edit/delete
   rights survive the round-trip.

     browser (after the section tree hydrates with preserved block ids)
       │  POST { paperId, comments:[…] }   Authorization: Bearer <ID token>
       ▼
     restorePaperComments — verify token + lab-member + (admin | paper owner/author)
       │  Admin SDK batch-writes papers/{paperId}/comments/*
       ▼
     { restored: N } back to the browser

   GET is a health probe; the client health-gates the comment step on it,
   so E2 (import) ships safely before this function deploys — comments
   simply skip until it's live.

   Deploy: firebase deploy --only functions:restorePaperComments
   ================================================================ */

const { onRequest } = require('firebase-functions/v2/https');
const admin = require('firebase-admin');

const MAX_COMMENTS = 4000;
const MAX_BODY = 20000;

function tsFromMillis(ms) {
  if (typeof ms === 'number' && isFinite(ms) && ms > 0) {
    return admin.firestore.Timestamp.fromMillis(ms);
  }
  return admin.firestore.FieldValue.serverTimestamp();
}

const restorePaperComments = onRequest({
  cors: true,
  maxInstances: 3,
  memory: '256MiB',
  timeoutSeconds: 120,
}, async (req, res) => {
  if (req.method === 'GET') {
    res.status(200).send('restorePaperComments ok');
    return;
  }
  if (req.method !== 'POST') {
    res.status(405).json({ error: 'Method not allowed' });
    return;
  }

  /* Verify Firebase ID token (the paperCompile / equationOcr gate). */
  const authHeader = req.get('Authorization') || '';
  const m = authHeader.match(/^Bearer\s+(.+)$/i);
  if (!m) { res.status(401).json({ error: 'Missing Bearer token.' }); return; }
  let decoded;
  try {
    decoded = await admin.auth().verifyIdToken(m[1]);
  } catch (err) {
    res.status(401).json({ error: 'Invalid Firebase token: ' + err.message });
    return;
  }
  const uid = decoded.uid;

  const db = admin.firestore();

  /* Lab-member gate. */
  const userDoc = await db.collection('users').doc(uid).get();
  const role = userDoc.exists ? (userDoc.data() || {}).role : null;
  if (!role || role === 'guest') {
    res.status(403).json({ error: 'Lab membership required.' });
    return;
  }
  const isAdmin = role === 'admin';

  const paperId = (req.body || {}).paperId;
  const comments = (req.body || {}).comments;
  if (typeof paperId !== 'string' || !/^[a-z0-9][a-z0-9-]*$/.test(paperId)) {
    res.status(400).json({ error: 'Bad paperId.' });
    return;
  }
  if (!Array.isArray(comments)) {
    res.status(400).json({ error: 'comments must be an array.' });
    return;
  }
  if (comments.length > MAX_COMMENTS) {
    res.status(400).json({ error: 'Too many comments (' + comments.length + ' > ' + MAX_COMMENTS + ').' });
    return;
  }

  /* Authorize: admin, the paper's owner (projects/{id}.lead_author_uid),
   * or a listed author (papers/{id}.authorUids). */
  if (!isAdmin) {
    let owner = false, author = false;
    try {
      const proj = await db.collection('projects').doc(paperId).get();
      if (proj.exists && (proj.data() || {}).lead_author_uid === uid) owner = true;
    } catch (e) { /* ignore */ }
    try {
      const pap = await db.collection('papers').doc(paperId).get();
      const authorUids = (pap.exists && (pap.data() || {}).authorUids) || [];
      if (authorUids.indexOf(uid) >= 0) author = true;
    } catch (e) { /* ignore */ }
    if (!owner && !author) {
      res.status(403).json({ error: 'Not authorized to write comments on this paper.' });
      return;
    }
  }

  /* Batch-write the comments (Admin SDK bypasses the authorUid==caller
   * client rule → true attribution). Firestore batches cap at 500. */
  let restored = 0, skipped = 0;
  const col = db.collection('papers').doc(paperId).collection('comments');
  let batch = db.batch(), inBatch = 0;
  for (let i = 0; i < comments.length; i++) {
    const c = comments[i] || {};
    if (!c.blockId || typeof c.body !== 'string' || !c.body.trim()) { skipped++; continue; }
    const doc = {
      blockId: String(c.blockId),
      body: String(c.body).slice(0, MAX_BODY),
      authorUid: c.authorUid ? String(c.authorUid) : uid,
      authorName: c.authorName ? String(c.authorName) : '',
      resolved: !!c.resolved,
      createdAt: tsFromMillis(c.createdAt),
      modifiedAt: tsFromMillis(c.modifiedAt),
      imported_from_bundle: true,
    };
    if (typeof c.anchorStart === 'number' && typeof c.anchorEnd === 'number') {
      doc.anchorStart = c.anchorStart;
      doc.anchorEnd = c.anchorEnd;
      doc.anchorText = c.anchorText ? String(c.anchorText).slice(0, 500) : '';
    }
    batch.set(col.doc(), doc);   // auto-id (comment ids aren't referenced cross-doc)
    inBatch++; restored++;
    if (inBatch >= 450) { await batch.commit(); batch = db.batch(); inBatch = 0; }
  }
  if (inBatch > 0) await batch.commit();

  console.log('[restorePaperComments]', uid, 'paper=' + paperId, 'restored=' + restored, 'skipped=' + skipped);
  res.status(200).json({ restored: restored, skipped: skipped });
});

module.exports = { restorePaperComments };
