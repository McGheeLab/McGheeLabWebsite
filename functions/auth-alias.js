/* ================================================================
   auth-alias.js — one person, two Google logins (V3.806)
   ================================================================
   Exposes one HTTPS endpoint:

     aliasSignIn()   (POST, Authorization: Bearer <Firebase ID token>)
     GET → health probe

   Alex signs in with either mcgheealex@gmail.com or mcgheealex@arizona.edu
   and should land in the SAME account: same My Week, papers, classes,
   chats, admin role. Firebase gives every Google login its own uid, and
   all lab data is keyed by uid (userData/{uid}, authorUids, presenters
   maps, schedules.ownerUid…), so mirroring two uids is not workable.
   Instead the alias login is SWAPPED for a session on the primary uid:
   the client signs in with Google as usual, sees an alias email, POSTs
   its ID token here, and signs in with the custom token this returns
   (firebase-bridge.js / user-system.js `_aliasSwap`). From then on the
   session IS the primary account, so nothing needs syncing.

   The map lives in code, not Firestore: a row here hands out a whole
   account (admin included), so adding one takes a reviewed commit and a
   deploy, never a data write.

   Requires the runtime service account to hold
   roles/iam.serviceAccountTokenCreator on itself (createCustomToken signs
   via IAM signBlob). 665438582202-compute@ has it (checked 2026-10-13).
   ================================================================ */

const { onRequest } = require('firebase-functions/v2/https');
const { getAuth } = require('firebase-admin/auth');

// alias login email (lowercase) → uid of the account it signs in as.
const ALIASES = {
  'mcgheealex@arizona.edu': 'uAicelwQ5gNQdH1Qc8wqZcJDRZQ2',   // → mcgheealex@gmail.com
};

/* Decide from a verified ID token whether to swap. Pure — tested in
   functions/test/auth-alias.test.js. Only a Google login with a verified
   email counts: a password account registered with the same address must
   never be handed the primary account. */
function resolveAlias(decoded, aliases) {
  const email = String((decoded && decoded.email) || '').toLowerCase();
  const target = Object.prototype.hasOwnProperty.call(aliases, email) ? aliases[email] : null;
  if (!target) return { status: 404, error: 'Not an alias login.' };
  const provider = decoded.firebase && decoded.firebase.sign_in_provider;
  if (provider !== 'google.com') return { status: 403, error: 'Alias sign-in requires Google.' };
  if (decoded.email_verified !== true) return { status: 403, error: 'Email not verified.' };
  if (decoded.uid === target) return { status: 400, error: 'Already signed in as the primary account.' };
  return { status: 200, email, targetUid: target };
}

const aliasSignIn = onRequest({
  cors: true,
  maxInstances: 2,
  memory: '256MiB',
  timeoutSeconds: 30,
}, async (req, res) => {
  if (req.method === 'GET') { res.status(200).send('aliasSignIn ok'); return; }
  if (req.method !== 'POST') { res.status(405).json({ error: 'Method not allowed' }); return; }

  const authHeader = req.get('Authorization') || '';
  const m = authHeader.match(/^Bearer\s+(.+)$/i);
  if (!m) { res.status(401).json({ error: 'Sign in first.' }); return; }
  let decoded;
  try {
    decoded = await getAuth().verifyIdToken(m[1], true /* checkRevoked */);
  } catch (err) {
    res.status(401).json({ error: 'Invalid Firebase token: ' + err.message });
    return;
  }

  const r = resolveAlias(decoded, ALIASES);
  if (r.status !== 200) {
    if (r.status !== 404) console.warn('[aliasSignIn] refused', decoded.email, decoded.uid, '—', r.error);
    res.status(r.status).json({ error: r.error });
    return;
  }

  try {
    const target = await getAuth().getUser(r.targetUid);
    if (target.disabled) { res.status(403).json({ error: 'Primary account is disabled.' }); return; }
    const token = await getAuth().createCustomToken(r.targetUid);
    console.log(`[aliasSignIn] ${r.email} (${decoded.uid}) → ${r.targetUid} (${target.email})`);
    res.status(200).json({ token });
  } catch (err) {
    console.error('[aliasSignIn] token mint failed for', r.email, err.message);
    res.status(500).json({ error: 'Could not sign in to the primary account.' });
  }
});

module.exports = { aliasSignIn, _internal: { resolveAlias, ALIASES } };
