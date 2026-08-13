/* ================================================================
   release-announce.js — "What's New" release broadcast (V3.604)
   ================================================================
   Admin-only HTTPS endpoint that announces a batched app release:

     1. Writes a `releases/{id}` doc (the What's New history —
        server-side only; clients can read, never write).
     2. Pushes ONE notification to every lab member (web + native,
        settings + presence respected via helpers/notify) and records
        it to each user's in-app feed as the catch-up surface.

   GET is a health probe — the What's New compose UI gates its send
   button on it, so the client ships safely before/after the
   `firebase deploy --only functions:releaseAnnounce` gate (same
   pattern as equationOcr).
   ================================================================ */

const { onRequest } = require('firebase-functions/v2/https');
const { getFirestore, FieldValue } = require('firebase-admin/firestore');
const { getMessaging } = require('firebase-admin/messaging');
const { getAuth } = require('firebase-admin/auth');
const { notifyUsers } = require('./helpers/notify');

const WHATS_NEW_URL = '/rm/pages/whats-new.html';
const MAX_CHANGES = 40;
const MAX_LINE = 300;

function clean(s, max) {
  return String(s || '').trim().slice(0, max || MAX_LINE);
}

const releaseAnnounce = onRequest({
  cors: true,
  maxInstances: 2,
  memory: '256MiB',
  timeoutSeconds: 120,
}, async (req, res) => {
  if (req.method === 'GET') {
    res.status(200).send('releaseAnnounce ok');
    return;
  }
  if (req.method !== 'POST') {
    res.status(405).json({ error: 'Method not allowed' });
    return;
  }

  /* Verify Firebase ID token (same gate as equationOcr / paperCompile). */
  const authHeader = req.get('Authorization') || '';
  const m = authHeader.match(/^Bearer\s+(.+)$/i);
  if (!m) {
    res.status(401).json({ error: 'Missing Bearer token.' });
    return;
  }
  let decoded;
  try {
    decoded = await getAuth().verifyIdToken(m[1]);
  } catch (err) {
    res.status(401).json({ error: 'Invalid Firebase token: ' + err.message });
    return;
  }

  /* Admin only — this buzzes the entire lab. */
  const db = getFirestore();
  const callerDoc = await db.collection('users').doc(decoded.uid).get();
  const caller = callerDoc.exists ? (callerDoc.data() || {}) : {};
  if (caller.role !== 'admin') {
    res.status(403).json({ error: 'Admin only.' });
    return;
  }

  /* Validate payload. */
  const body = req.body || {};
  const version = clean(body.version, 24);
  const title = clean(body.title, 120);
  const summary = clean(body.summary, 600);
  // V3.607 — the phone app bundles the rm/ tree at build time, so app users
  // only receive these changes once they install the named TestFlight build.
  // Recording it here is what lets the What's New page tell them so.
  const appVersion = clean(body.appVersion, 24);
  const appBuild = clean(body.appBuild, 12);
  const changes = Array.isArray(body.changes)
    ? body.changes.map((c) => clean(c)).filter(Boolean).slice(0, MAX_CHANGES)
    : [];
  if (!version || (!summary && changes.length === 0)) {
    res.status(400).json({
      error: 'Expected { version, title?, summary?, changes[] } with a version and at least a summary or one change.',
    });
    return;
  }

  /* Record the release FIRST — the notification links here, so the doc
     must exist before anyone taps through. */
  const releaseRef = await db.collection('releases').add({
    version,
    title: title || `App update v${version}`,
    summary,
    changes,
    appVersion: appVersion || null,
    appBuild: appBuild || null,
    sentBy: decoded.uid,
    sentByName: caller.displayName || caller.name || '',
    sentAt: FieldValue.serverTimestamp(),
  });

  /* Everyone with lab access (mirrors isLabMember: role set, not guest). */
  const usersSnap = await db.collection('users').get();
  const uids = [];
  usersSnap.forEach((doc) => {
    const role = (doc.data() || {}).role;
    if (role && role !== 'guest') uids.push(doc.id);
  });

  const notifBody = summary
    || (changes.length === 1 ? changes[0] : `${changes.length} improvements — tap to see what changed.`);
  const sent = await notifyUsers(db, getMessaging(), uids, {
    title: title || `🚀 App updated — v${version}`,
    body: notifBody.slice(0, 180),
    url: WHATS_NEW_URL,
    tag: `release-v${version}`,
  }, 'releases', 'release');

  await releaseRef.update({ recipients: uids.length, pushed: sent });
  console.log(`[Release] v${version} announced by ${decoded.uid}: ${sent} push(es) across ${uids.length} member(s).`);

  res.status(200).json({ ok: true, releaseId: releaseRef.id, recipients: uids.length, pushed: sent });
});

module.exports = { releaseAnnounce };
