/* ================================================================
   semantic-scholar.js — Semantic Scholar proxy (V3.583)
   ================================================================
   api.semanticscholar.org sends no Access-Control-Allow-Origin, so
   every browser call from https://mcgheelab.com was blocked by CORS:

     Access to fetch at 'https://api.semanticscholar.org/graph/v1/...'
     from origin 'https://mcgheelab.com' has been blocked by CORS
     policy: No 'Access-Control-Allow-Origin' header is present.

   Which means import-time enrichment (structured references, cited-by,
   abstract, tldr) has never worked on the prod deploy — library-upload.js
   just logged "SS fetch failed" and moved on, so every library entry
   silently landed without it. Same fix, same shape, as V3.308's
   libraryLookup (CrossRef / PubMed / arXiv) and V3.498's fetchPaperPdf:
   do the fetch server-side, where CORS doesn't apply.

   Request (POST, JSON):
     { id:      "DOI:10.1038%2Fs41592-025-02879-w"   // or ARXIV:… / PMID:…
                | "<40-hex Semantic Scholar paperId>",
       kind:    "paper" | "citations",                // default "paper"
       limit:   1..1000,                              // citations only
       refresh: true }                                // bypass cache read

   Response: the raw Semantic Scholar JSON — the paper object for
   kind:"paper", `{data:[...]}` for kind:"citations" — so the client's
   existing normalizers (normalizeReference / normalizeCitation) are
   unchanged.

   The URL is built entirely server-side from a validated id and a
   server-owned field list; the client never supplies a URL or a `fields`
   string, so this can't be turned into an open fetch proxy.

   Authorization: bearer Firebase ID token whose users/{uid}.role is not
   'guest' — the same trust tier as libraryLookup.

   Caching: metadataCache/{sha1('s2paper:…')} for 7 days. Shorter than
   libraryLookup's 30 days because reference and citation lists do grow,
   unlike published article metadata. metadataCache is Admin-SDK-only
   (firestore.rules denies all client access).
   ================================================================ */

const { onRequest } = require('firebase-functions/v2/https');
const { getFirestore } = require('firebase-admin/firestore');
const { getAuth } = require('firebase-admin/auth');
const crypto = require('crypto');

const API_BASE = 'https://api.semanticscholar.org/graph/v1/paper';

const ALLOWED_ORIGINS = [
  'https://mcgheelab.com',
  'https://www.mcgheelab.com',
  'http://localhost:8000',
];

// Field lists live here, not on the client: the proxy owns the URL. Keep
// these in sync with what rm/js/paper-semantic-scholar.js's normalizers
// read — they are the contract.
const FIELDS_PAPER = [
  'title', 'authors', 'year', 'venue', 'abstract', 'externalIds', 'tldr',
  'references.paperId', 'references.title', 'references.authors',
  'references.year', 'references.venue', 'references.externalIds',
  'citations.paperId', 'citations.title', 'citations.authors',
  'citations.year', 'citations.venue', 'citations.externalIds',
].join(',');
const FIELDS_CITATIONS = 'title,authors,year,venue,externalIds';

const CACHE_TTL_MS = 7 * 24 * 60 * 60 * 1000;   // 7 days
const FETCH_TIMEOUT_MS = 20000;

// Prefixed ids (DOI:/ARXIV:/PMID:/…) as the client mints them — the value
// part is already percent-encoded, so %2F is expected and legal. A bare
// 40-hex string is Semantic Scholar's own paperId. Anything else is a 400:
// no slashes, no scheme, nothing that could walk out of /paper/.
const ID_PREFIXED = /^(DOI|ARXIV|PMID|PMCID|CorpusId|MAG|ACL):[A-Za-z0-9._%+()\-:]+$/i;
const ID_PAPER_ID = /^[0-9a-f]{40}$/i;

function setCors(req, res) {
  const origin = req.headers.origin || '';
  if (ALLOWED_ORIGINS.includes(origin)) res.set('Access-Control-Allow-Origin', origin);
  res.set('Access-Control-Allow-Methods', 'POST, OPTIONS');
  res.set('Access-Control-Allow-Headers', 'Authorization, Content-Type');
  res.set('Access-Control-Max-Age', '3600');
}

function _cacheDocId(kind, key) {
  return crypto.createHash('sha1').update(`s2${kind}:${key}`).digest('hex');
}

async function _cacheRead(db, kind, key) {
  const snap = await db.collection('metadataCache').doc(_cacheDocId(kind, key)).get();
  if (!snap.exists) return null;
  const data = snap.data() || {};
  const fetchedAt = Date.parse(data.fetched_at || '') || 0;
  if (Date.now() - fetchedAt > CACHE_TTL_MS) return null;
  return data.result || null;
}

async function _cacheWrite(db, kind, key, result) {
  try {
    await db.collection('metadataCache').doc(_cacheDocId(kind, key)).set({
      kind: `s2${kind}`,
      key,
      result,
      fetched_at: new Date().toISOString(),
    });
  } catch (err) {
    // Cache is best-effort — a failed write must never fail the lookup.
    console.warn('[semanticScholarLookup] cache write failed:', err.message);
  }
}

// Semantic Scholar's free tier allows roughly one request per second and
// answers a burst with 429. Retry that once, the way the old client-side
// fetch did, then give up.
async function _fetchS2(url) {
  for (let attempt = 1; ; attempt++) {
    const res = await fetch(url, {
      headers: { Accept: 'application/json' },
      signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
    });
    if (res.ok) return res.json();
    if (res.status === 429 && attempt === 1) {
      await new Promise(r => setTimeout(r, 1500));
      continue;
    }
    const body = await res.text().catch(() => '');
    const err = new Error(`Semantic Scholar ${res.status}: ${body.slice(0, 200)}`);
    err.status = res.status;
    throw err;
  }
}

const semanticScholarLookup = onRequest(
  { cors: false, timeoutSeconds: 60 },
  async (req, res) => {
    setCors(req, res);
    if (req.method === 'OPTIONS') { res.status(204).send(''); return; }
    if (req.method !== 'POST') { res.status(405).json({ error: 'POST only' }); return; }

    const authHeader = req.headers.authorization || '';
    if (!authHeader.startsWith('Bearer ')) {
      res.status(401).json({ error: 'Missing Authorization header' });
      return;
    }
    let uid;
    try {
      const decoded = await getAuth().verifyIdToken(authHeader.slice('Bearer '.length));
      uid = decoded.uid;
    } catch (err) {
      res.status(401).json({ error: 'Invalid ID token: ' + err.message });
      return;
    }

    const db = getFirestore();
    const userDoc = await db.collection('users').doc(uid).get();
    const role = userDoc.exists ? (userDoc.data().role || '') : '';
    if (!userDoc.exists || role === 'guest') {
      res.status(403).json({ error: 'permission-denied: lab members only' });
      return;
    }

    const body = req.body || {};
    const id = String(body.id || '').trim();
    const kind = body.kind === 'citations' ? 'citations' : 'paper';
    const refresh = body.refresh === true;
    if (!ID_PREFIXED.test(id) && !ID_PAPER_ID.test(id)) {
      res.status(400).json({
        error: 'id must be DOI:/ARXIV:/PMID:/PMCID:/CorpusId:/MAG:/ACL:<value> ' +
               'or a 40-character Semantic Scholar paperId',
      });
      return;
    }

    let url;
    let cacheKey;
    if (kind === 'citations') {
      const limit = Math.max(1, Math.min(1000, Number(body.limit) || 100));
      url = `${API_BASE}/${id}/citations` +
            `?fields=${encodeURIComponent(FIELDS_CITATIONS)}&limit=${limit}`;
      cacheKey = `${id}|${limit}`;
    } else {
      url = `${API_BASE}/${id}?fields=${encodeURIComponent(FIELDS_PAPER)}`;
      cacheKey = id;
    }

    if (!refresh) {
      try {
        const cached = await _cacheRead(db, kind, cacheKey);
        if (cached) { res.json(cached); return; }
      } catch (err) {
        console.warn('[semanticScholarLookup] cache read failed:', err.message);
      }
    }

    let result;
    try {
      result = await _fetchS2(url);
    } catch (err) {
      // 404 = Semantic Scholar has no record of this paper. That's a normal
      // outcome for a brand-new DOI, not a server fault, so don't make the
      // caller treat it as one.
      if (err.status === 404) {
        res.status(404).json({ error: 'Not indexed by Semantic Scholar yet' });
        return;
      }
      res.status(502).json({ error: `Semantic Scholar lookup failed: ${err.message}` });
      return;
    }

    await _cacheWrite(db, kind, cacheKey, result);
    res.json(result);
  }
);

module.exports = { semanticScholarLookup };
