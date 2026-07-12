/* ================================================================
   oauth.js — Phase 7: OAuth code exchange for Gmail / Calendar
   ================================================================
   HTTP function called by /rm/js/oauth-connections.js after the user
   grants consent in the GIS popup. Exchanges the authorization code
   for a refresh token using the OAuth client_secret stored in
   Cloud Functions config (NOT in client code).

   Stores the refresh token at:
     userData/{uid}/private/{provider}Credential

   The browser never sees the refresh token. Future scrape runs use
   the refresh token to mint short-lived access tokens.

   Setup (one-time):
     firebase functions:secrets:set OAUTH_CLIENT_SECRET
     # paste the Client Secret from GCP console → Credentials → your Web client

   Called from: /rm/js/oauth-connections.js connect() flow
   ================================================================ */

const { onRequest } = require('firebase-functions/v2/https');
const { defineSecret } = require('firebase-functions/params');
const { getFirestore, FieldValue } = require('firebase-admin/firestore');
const { getAuth } = require('firebase-admin/auth');

// Secrets — populated via `firebase functions:secrets:set`
const OAUTH_CLIENT_ID = defineSecret('OAUTH_CLIENT_ID');
const OAUTH_CLIENT_SECRET = defineSecret('OAUTH_CLIENT_SECRET');

const ALLOWED_ORIGINS = [
  'https://mcgheelab.com',
  'https://www.mcgheelab.com',
  'http://localhost:8000',
];

const PROVIDER_CONFIG = {
  gmail: {
    docName: 'gmailCredential',
    requiredScope: 'https://www.googleapis.com/auth/gmail.readonly',
  },
  calendar: {
    docName: 'calendarCredential',
    requiredScope: 'https://www.googleapis.com/auth/calendar.readonly',
  },
  // Combined Google flow: a single consent grants both Gmail + Calendar
  // scopes from the same Google account. The exchange writes BOTH credential
  // docs (gmailCredential AND calendarCredential) in one shot so the user
  // can't end up with Gmail on one account and Calendar on another.
  'google-combined': {
    combined: true,
    subProviders: ['gmail', 'calendar'],
  },
};

function setCors(req, res) {
  const origin = req.headers.origin || '';
  if (ALLOWED_ORIGINS.includes(origin)) {
    res.set('Access-Control-Allow-Origin', origin);
  }
  res.set('Access-Control-Allow-Methods', 'POST, OPTIONS');
  res.set('Access-Control-Allow-Headers', 'Authorization, Content-Type');
  res.set('Access-Control-Max-Age', '3600');
}

const exchangeOAuthCode = onRequest(
  { secrets: [OAUTH_CLIENT_ID, OAUTH_CLIENT_SECRET], cors: false },
  async (req, res) => {
    setCors(req, res);
    if (req.method === 'OPTIONS') { res.status(204).send(''); return; }
    if (req.method !== 'POST') { res.status(405).json({ error: 'POST only' }); return; }

    // 1. Verify the Firebase ID token in Authorization header.
    const authHeader = req.headers.authorization || '';
    if (!authHeader.startsWith('Bearer ')) {
      res.status(401).json({ error: 'Missing Authorization header' });
      return;
    }
    const idToken = authHeader.slice('Bearer '.length);
    let uid;
    try {
      const decoded = await getAuth().verifyIdToken(idToken);
      uid = decoded.uid;
    } catch (err) {
      res.status(401).json({ error: 'Invalid ID token: ' + err.message });
      return;
    }

    // 2. Validate request body.
    const { code, provider, scope, redirect_uri } = req.body || {};
    if (!code || !provider || !scope) {
      res.status(400).json({ error: 'Missing code, provider, or scope' });
      return;
    }
    const cfg = PROVIDER_CONFIG[provider];
    if (!cfg) { res.status(400).json({ error: 'Unknown provider: ' + provider }); return; }
    if (!cfg.combined && scope !== cfg.requiredScope) {
      res.status(400).json({ error: 'Scope mismatch for provider ' + provider });
      return;
    }

    // 3. Exchange code for tokens at Google's token endpoint.
    const redirectUri = redirect_uri || req.headers.origin || 'postmessage';
    const params = new URLSearchParams({
      code,
      client_id: OAUTH_CLIENT_ID.value(),
      client_secret: OAUTH_CLIENT_SECRET.value(),
      redirect_uri: redirectUri,
      grant_type: 'authorization_code',
    });
    let tokenResp;
    try {
      const r = await fetch('https://oauth2.googleapis.com/token', {
        method: 'POST',
        headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
        body: params.toString(),
      });
      const text = await r.text();
      if (!r.ok) {
        console.error('[oauth] token exchange failed', r.status, text);
        res.status(502).json({ error: 'Token exchange failed: ' + text });
        return;
      }
      tokenResp = JSON.parse(text);
    } catch (err) {
      console.error('[oauth] token exchange threw', err);
      res.status(502).json({ error: 'Token exchange threw: ' + err.message });
      return;
    }

    // refresh_token is only returned the FIRST time consent is granted (or
    // when access_type=offline+prompt=consent). If missing, the user already
    // consented in a prior session — we keep whatever existing credential is
    // in Firestore and just bump the lastConsentAt timestamp.
    const { refresh_token, access_token, expires_in, scope: returnedScope } = tokenResp;
    const db = getFirestore();

    // For the combined flow, the same refresh token works for ALL granted
    // scopes — so we write it to BOTH credential docs (gmailCredential AND
    // calendarCredential). The schedulers each look up their respective doc
    // and use the same token underneath.
    const targets = cfg.combined
      ? cfg.subProviders.map(sub => ({ provider: sub, docName: PROVIDER_CONFIG[sub].docName }))
      : [{ provider, docName: cfg.docName }];

    let savedAny = false;
    for (const target of targets) {
      const credRef = db.collection('userData').doc(uid)
        .collection('private').doc(target.docName);
      const existing = await credRef.get();
      const update = {
        provider: target.provider,
        scopes: (returnedScope || scope).split(' '),
        grantedAt: FieldValue.serverTimestamp(),
        lastConsentAt: FieldValue.serverTimestamp(),
        lastSyncError: null,
        refreshTokenStored: !!refresh_token || existing.exists,
      };
      if (refresh_token) update.refreshToken = refresh_token;
      if (access_token) {
        update.accessToken = access_token;
        update.accessTokenExpiresAt = Date.now() + (expires_in || 0) * 1000;
      }
      await credRef.set(update, { merge: true });
      savedAny = true;
    }

    res.json({ ok: true, provider, saved: targets.map(t => t.provider), refreshTokenStored: savedAny });
  }
);

module.exports = { exchangeOAuthCode };
