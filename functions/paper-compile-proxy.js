/* ================================================================
   paperCompile — Public Firebase Function that forwards to the
   private Cloud Run Tectonic service.
   ================================================================
   The Cloud Run service at paper-compile-665438582202.us-central1.run.app
   is private (only the Functions runtime service account can invoke
   via `roles/run.invoker`). This function is the public entry point:

     browser
       │  POST  Authorization: Bearer <Firebase ID token>
       ▼
     paperCompile (this function)
       │  verifies Firebase token + lab-member role
       │  mints GCP identity token via metadata server
       │  POST  Authorization: Bearer <GCP ID token>
       │       X-User-Uid: <verified uid>
       │       X-User-Role: <verified role>
       ▼
     Cloud Run paper-compile (private)
       │  Cloud Run IAM verifies GCP token + SA permission
       │  Express handler trusts X-User-Uid header
       │  runs Tectonic, returns PDF URL
       ▼
     back to browser

   Why this exists:
   - Direct public-allUsers access to the Cloud Run service couldn't
     be made to work in this project (V3.231 deployment notes).
   - Firebase Functions deploy path handles the public-ingress wiring
     automatically and matches the rest of /functions/.

   Deploy: firebase deploy --only functions:paperCompile

   One-time IAM setup (after first function deploy):
     gcloud run services add-iam-policy-binding paper-compile \
       --region=us-central1 \
       --member=serviceAccount:mcgheelab-f56cc@appspot.gserviceaccount.com \
       --role=roles/run.invoker
   ================================================================ */

const { onRequest } = require('firebase-functions/v2/https');
const admin = require('firebase-admin');

/* Cloud Run service to forward to. Audience for the minted identity
 * token must match the service's root URL (no path suffix). */
const CLOUD_RUN_URL = 'https://paper-compile-665438582202.us-central1.run.app';

async function getIdentityToken(audience) {
  const url = 'http://metadata.google.internal/computeMetadata/v1/instance/service-accounts/default/identity?audience=' +
              encodeURIComponent(audience);
  const resp = await fetch(url, { headers: { 'Metadata-Flavor': 'Google' } });
  if (!resp.ok) {
    const t = await resp.text();
    throw new Error('Metadata token fetch failed (' + resp.status + '): ' + t);
  }
  return (await resp.text()).trim();
}

const paperCompile = onRequest({
  cors: true,
  maxInstances: 3,
  memory: '512MiB',
  timeoutSeconds: 120,
}, async (req, res) => {
  if (req.method === 'GET') {
    /* Health probe — lets the browser test the proxy without the full
     * Firebase-token + Cloud-Run round trip. */
    res.status(200).send('paperCompile proxy ok');
    return;
  }
  if (req.method !== 'POST') {
    res.status(405).json({ error: 'Method not allowed' });
    return;
  }

  /* Verify Firebase ID token */
  const authHeader = req.get('Authorization') || '';
  const m = authHeader.match(/^Bearer\s+(.+)$/i);
  if (!m) {
    res.status(401).json({ error: 'Missing Bearer token.' });
    return;
  }
  let decoded;
  try {
    decoded = await admin.auth().verifyIdToken(m[1]);
  } catch (err) {
    res.status(401).json({ error: 'Invalid Firebase token: ' + err.message });
    return;
  }

  /* Mirror isLabMember() */
  const userDoc = await admin.firestore().collection('users').doc(decoded.uid).get();
  if (!userDoc.exists) {
    res.status(403).json({ error: 'No user profile.' });
    return;
  }
  const role = (userDoc.data() || {}).role;
  if (!role || role === 'guest') {
    res.status(403).json({ error: 'Lab membership required.' });
    return;
  }

  /* Mint identity token for the Cloud Run service */
  let idToken;
  try {
    idToken = await getIdentityToken(CLOUD_RUN_URL);
  } catch (err) {
    console.error('[paperCompile] identity token fetch failed:', err.message);
    res.status(500).json({ error: 'Could not authenticate to compile service.' });
    return;
  }

  /* Forward to Cloud Run. Body is whatever JSON the browser POSTed,
   * passed through unchanged. */
  let cloudResp;
  try {
    cloudResp = await fetch(CLOUD_RUN_URL + '/', {
      method: 'POST',
      headers: {
        'Authorization': 'Bearer ' + idToken,
        'X-User-Uid': decoded.uid,
        'X-User-Role': role,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify(req.body || {}),
    });
  } catch (err) {
    console.error('[paperCompile] Cloud Run fetch failed:', err.message);
    res.status(502).json({ error: 'Compile service unreachable: ' + err.message });
    return;
  }

  /* Pass status + body back to the browser as-is. */
  const respBody = await cloudResp.text();
  const contentType = cloudResp.headers.get('content-type') || 'application/json';
  res.status(cloudResp.status);
  res.set('Content-Type', contentType);
  res.send(respBody);
});

module.exports = { paperCompile };
