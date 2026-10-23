/* ================================================================
   teacher-invite.js — admin-issued teacher setup links (V3.680)
   ================================================================
   Admin creates teacherInvites/{token} from the Teachers admin page
   and hands the teacher a link: mcgheelab.com/#/teachers?invite=TOKEN.
   The teacher signs in with Google there and this endpoint provisions
   everything the approve modal would — schedules/{tc-…}
   (kind:'teacher-class', owned by the caller), a join code,
   users/{uid}.category:'teacher' — and marks the invite redeemed.

   Server-side because a guest must never be able to create a
   teacher-class doc client-side (the V3.635 create-hole lesson);
   the invite doc itself is admin-only in rules.

   Invite doc: { school, classTitle, teacherName?, email?,
     prefillFolders?[], suggestedClassId?, status:'pending'|'redeemed'
     |'revoked', createdBy, createdAt, expiresAt?, redeemedBy?,
     redeemedAt?, scheduleId? }

   If `email` is set the invite only redeems for that Google account;
   without it, anyone holding the link can redeem — the admin UI says
   so. Redemption runs in a transaction so a double-click (or a shared
   link raced by two people) provisions exactly one class.

   GET is a health probe (same pattern as releaseAnnounce).
   ================================================================ */

const { onRequest } = require('firebase-functions/v2/https');
const { getFirestore, FieldValue } = require('firebase-admin/firestore');
const { getAuth } = require('firebase-admin/auth');

const CODE_ALPHABET = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
function makeJoinCode() {
  let out = '';
  for (let i = 0; i < 6; i++) out += CODE_ALPHABET[Math.floor(Math.random() * CODE_ALPHABET.length)];
  return out;
}
function slugify(s) {
  return String(s || '').toLowerCase().replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '').slice(0, 32) || 'class';
}

const redeemTeacherInvite = onRequest({
  cors: true,
  maxInstances: 2,
  memory: '256MiB',
  timeoutSeconds: 60,
}, async (req, res) => {
  if (req.method === 'GET') { res.status(200).send('redeemTeacherInvite ok'); return; }
  if (req.method !== 'POST') { res.status(405).json({ error: 'Method not allowed' }); return; }

  const authHeader = req.get('Authorization') || '';
  const m = authHeader.match(/^Bearer\s+(.+)$/i);
  if (!m) { res.status(401).json({ error: 'Sign in first.' }); return; }
  let decoded;
  try {
    decoded = await getAuth().verifyIdToken(m[1]);
  } catch (err) {
    res.status(401).json({ error: 'Invalid Firebase token: ' + err.message });
    return;
  }

  const token = String((req.body || {}).token || '').trim();
  if (!/^[A-Za-z0-9_-]{8,64}$/.test(token)) {
    res.status(400).json({ error: 'Invalid invite link.' });
    return;
  }

  const db = getFirestore();
  const inviteRef = db.collection('teacherInvites').doc(token);

  // Read the invite up front for validation + module pre-fill (the
  // authoritative pending→redeemed flip re-checks inside the transaction).
  const inviteSnap = await inviteRef.get();
  if (!inviteSnap.exists) { res.status(404).json({ error: 'This invite link is not valid.' }); return; }
  const invite = inviteSnap.data();
  if (invite.status !== 'pending') {
    res.status(409).json({
      error: invite.status === 'redeemed'
        ? 'This invite was already used' +
          (invite.redeemedBy === decoded.uid ? ' by you — open your teaching dashboard.' : '.')
        : 'This invite is no longer active.'
    });
    return;
  }
  if (invite.expiresAt && invite.expiresAt.toMillis() < Date.now()) {
    res.status(410).json({ error: 'This invite has expired — ask the lab for a new one.' });
    return;
  }
  if (invite.email &&
      String(invite.email).toLowerCase() !== String(decoded.email || '').toLowerCase()) {
    res.status(403).json({
      error: 'This invite is for ' + invite.email + ' — sign in with that Google account.'
    });
    return;
  }

  // V3.773 — a redeemed invite provisions an EMPTY class. It used to expand
  // the invite's `prefillFolders` into a modules[] the teacher never chose,
  // which landed on their students' class page before they had opened the
  // dashboard once. They now pick from the published catalog on
  // #/teach → Modules, and `Available to your students` starts empty.
  const modules = [];

  // Pick a free schedule id + join code (collision checks outside the tx —
  // the creates inside the tx would fail loudly on the astronomically rare
  // race, which is the right failure).
  let scheduleId = String(invite.suggestedClassId || '').trim() ||
    ('tc-' + slugify(invite.school) + '-' + makeJoinCode().slice(0, 4).toLowerCase());
  if ((await db.collection('schedules').doc(scheduleId).get()).exists) {
    scheduleId = 'tc-' + slugify(invite.school) + '-' + makeJoinCode().slice(0, 4).toLowerCase() +
      makeJoinCode().slice(0, 2).toLowerCase();
  }
  let joinCode = makeJoinCode();
  if ((await db.collection('joinCodes').doc(joinCode).get()).exists) joinCode = makeJoinCode();

  const classTitle = String(invite.classTitle || ((invite.school || 'Class') + ' — McGhee Lab Modules')).slice(0, 200);
  const uid = decoded.uid;

  try {
    await db.runTransaction(async (tx) => {
      const fresh = await tx.get(inviteRef);
      if (!fresh.exists || fresh.data().status !== 'pending') {
        throw new Error('already-redeemed');
      }
      tx.create(db.collection('schedules').doc(scheduleId), {
        kind: 'teacher-class',
        title: classTitle,
        subtitle: invite.school || '',
        semester: '',
        description: '',
        ownerUid: uid,
        teacherUid: uid,
        teacherName: invite.teacherName || decoded.name || '',
        school: invite.school || '',
        classAdminEmails: [],
        grantedFolders: [],   // legacy field — module access is the catalog (V3.669)
        modules,
        enrollmentOpen: true,
        testMode: false,
        tabs: [],
        createdAt: FieldValue.serverTimestamp(),
        updatedAt: FieldValue.serverTimestamp()
      });
      tx.create(db.collection('joinCodes').doc(joinCode), {
        scheduleId, teacherUid: uid, active: true,
        createdAt: FieldValue.serverTimestamp(), createdBy: invite.createdBy || 'invite'
      });
      tx.set(db.collection('users').doc(uid), { category: 'teacher' }, { merge: true });
      tx.update(inviteRef, {
        status: 'redeemed', redeemedBy: uid, redeemedAt: FieldValue.serverTimestamp(),
        scheduleId, updatedAt: FieldValue.serverTimestamp()
      });
    });
  } catch (err) {
    if (String(err.message).includes('already-redeemed')) {
      res.status(409).json({ error: 'This invite was just used — if that was you, open your teaching dashboard.' });
      return;
    }
    console.error('[teacher-invite] provision failed:', err);
    res.status(500).json({ error: 'Setup failed — try again, or contact the lab.' });
    return;
  }

  res.status(200).json({ scheduleId, classTitle, joinCode });
});

module.exports = { redeemTeacherInvite };
