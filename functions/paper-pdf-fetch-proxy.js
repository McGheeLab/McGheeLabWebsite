/* ================================================================
   paperPdfFetchProxy — public Function forwarding to the private
   Cloud Run headless-PDF-fetch service (V3.501, Phase 3)
   ================================================================
   The plain server-side fetch (functions/fetch-paper-pdf.js) handles OA
   PDFs whose bytes are directly downloadable. Some OA pages gate the PDF
   behind page JS (a "Download" button, a viewer that assembles the URL,
   an interstitial). This proxy forwards to a Cloud Run service running
   headless Chrome (Puppeteer) that actually loads the DOI page, finds the
   PDF, and uploads it to Storage.

   Same trust chain as paperCompile:
     browser → paperPdfFetchProxy (verifies Firebase token + lab role,
       mints a GCP identity token) → private Cloud Run paper-pdf-fetch.

   DORMANT until the Cloud Run service is deployed. The client
   (LIBRARY_UPLOAD.serverFetchPdf) only calls this as a fallback and
   swallows a 5xx/unreachable response, so shipping it before the service
   exists is harmless.

   Deploy: firebase deploy --only functions:paperPdfFetchProxy
   Cloud Run (Alex, once):
     cd functions/paper-pdf-fetch
     gcloud run deploy paper-pdf-fetch --source . --region us-central1 \
       --allow-unauthenticated=false --memory 2Gi --timeout 120 --max-instances 3
     gcloud run services add-iam-policy-binding paper-pdf-fetch \
       --region=us-central1 \
       --member=serviceAccount:mcgheelab-f56cc@appspot.gserviceaccount.com \
       --role=roles/run.invoker
   Then confirm the URL below matches the deployed service.
   ================================================================ */

const { onRequest } = require('firebase-functions/v2/https');
const admin = require('firebase-admin');

// Same project number as paper-compile (665438582202). Verify after the first
// `gcloud run deploy` and adjust if the assigned URL differs.
const CLOUD_RUN_URL = 'https://paper-pdf-fetch-665438582202.us-central1.run.app';

async function getIdentityToken(audience) {
  const url = 'http://metadata.google.internal/computeMetadata/v1/instance/service-accounts/default/identity?audience=' +
    encodeURIComponent(audience);
  const resp = await fetch(url, { headers: { 'Metadata-Flavor': 'Google' } });
  if (!resp.ok) throw new Error('Metadata token fetch failed (' + resp.status + '): ' + (await resp.text()));
  return (await resp.text()).trim();
}

const paperPdfFetchProxy = onRequest(
  { cors: true, maxInstances: 3, memory: '256MiB', timeoutSeconds: 120 },
  async (req, res) => {
    if (req.method === 'GET') { res.status(200).send('paperPdfFetchProxy ok'); return; }
    if (req.method !== 'POST') { res.status(405).json({ ok: false, error: 'Method not allowed' }); return; }

    const authHeader = req.get('Authorization') || '';
    const m = authHeader.match(/^Bearer\s+(.+)$/i);
    if (!m) { res.status(401).json({ ok: false, error: 'Missing Bearer token.' }); return; }
    let decoded;
    try { decoded = await admin.auth().verifyIdToken(m[1]); }
    catch (err) { res.status(401).json({ ok: false, error: 'Invalid Firebase token: ' + err.message }); return; }

    const userDoc = await admin.firestore().collection('users').doc(decoded.uid).get();
    const role = userDoc.exists ? (userDoc.data() || {}).role : '';
    if (!role || role === 'guest') { res.status(403).json({ ok: false, error: 'Lab membership required.' }); return; }

    let idToken;
    try { idToken = await getIdentityToken(CLOUD_RUN_URL); }
    catch (err) {
      console.error('[paperPdfFetchProxy] identity token failed:', err.message);
      res.status(500).json({ ok: false, error: 'Could not authenticate to the fetch service.' });
      return;
    }

    let cloudResp;
    try {
      cloudResp = await fetch(CLOUD_RUN_URL + '/', {
        method: 'POST',
        headers: {
          Authorization: 'Bearer ' + idToken,
          'X-User-Uid': decoded.uid,
          'X-User-Role': role,
          'Content-Type': 'application/json',
        },
        body: JSON.stringify(req.body || {}),
      });
    } catch (err) {
      console.error('[paperPdfFetchProxy] Cloud Run unreachable:', err.message);
      res.status(502).json({ ok: false, error: 'Headless fetch service unreachable: ' + err.message });
      return;
    }

    const body = await cloudResp.text();
    res.status(cloudResp.status);
    res.set('Content-Type', cloudResp.headers.get('content-type') || 'application/json');
    res.send(body);
  }
);

module.exports = { paperPdfFetchProxy };
