/* ================================================================
   library-lookup.js — Production metadata lookup proxy (V3.308)
   ================================================================
   The library UI resolves DOIs / PMIDs / arXiv IDs / free-text titles
   into unified metadata. In local dev that goes through server.py's
   /api/library/lookup; on the static prod deploy there is no server,
   so this function is the equivalent proxy. The browser can't call
   CrossRef / NCBI / arXiv directly because of CORS.

   The response shape is a 1:1 port of server.py's
   _csl_to_unified / _lookup_crossref / _lookup_crossref_title /
   _lookup_pubmed / _lookup_arxiv so it stays byte-compatible with
   the client's buildPaperItem(). Not-found is `200 {"error": "..."}`
   (clients check meta.error); upstream failure is `502 {"error"}`.

   Caching: identifier lookups (doi/pmid/arxiv) are cached in
   Firestore at metadataCache/{sha1(kind:key)} for 30 days —
   published-paper metadata is effectively immutable, and CrossRef's
   polite pool appreciates it. Title queries are never cached (fuzzy,
   low hit-rate). Error results are never cached. The collection is
   Admin-SDK-only (firestore.rules denies all client access). Pass
   {refresh:true} in the body to bypass the cache read.

   Authorization: any authenticated user with a users/{uid} doc whose
   role != 'guest' (same trust tier as library writes).
   ================================================================ */

const { onRequest } = require('firebase-functions/v2/https');
const { getFirestore } = require('firebase-admin/firestore');
const { getAuth } = require('firebase-admin/auth');
const crypto = require('crypto');

const ALLOWED_ORIGINS = [
  'https://mcgheelab.com',
  'https://www.mcgheelab.com',
  'http://localhost:8000',
];

// CrossRef polite pool: identify ourselves so we get the faster,
// rate-limit-friendlier tier. https://api.crossref.org/swagger-ui/
const USER_AGENT =
  'McGheeLab-RM/1.0 (https://mcgheelab.com; mailto:mcgheelab@arizona.edu)';

const CACHE_TTL_MS = 30 * 24 * 60 * 60 * 1000; // 30 days
const FETCH_TIMEOUT_MS = 15000;

function setCors(req, res) {
  const origin = req.headers.origin || '';
  if (ALLOWED_ORIGINS.includes(origin)) res.set('Access-Control-Allow-Origin', origin);
  res.set('Access-Control-Allow-Methods', 'POST, OPTIONS');
  res.set('Access-Control-Allow-Headers', 'Authorization, Content-Type');
  res.set('Access-Control-Max-Age', '3600');
}

async function _fetch(url, accept) {
  const res = await fetch(url, {
    headers: { 'User-Agent': USER_AGENT, ...(accept ? { Accept: accept } : {}) },
    signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
  });
  return res;
}

async function _getJson(url) {
  const res = await _fetch(url, 'application/json');
  if (!res.ok) {
    const err = new Error(`HTTP ${res.status} from ${new URL(url).host}`);
    err.status = res.status;
    throw err;
  }
  return res.json();
}

async function _getText(url) {
  const res = await _fetch(url);
  if (!res.ok) {
    const err = new Error(`HTTP ${res.status} from ${new URL(url).host}`);
    err.status = res.status;
    throw err;
  }
  return res.text();
}

/* ---------------- server.py ports (keep shapes identical) ------------- */

// CrossRef abstracts come wrapped in JATS XML — strip tags for plaintext.
function _stripJats(s) {
  return String(s || '').replace(/<[^>]+>/g, '').trim();
}

function _first(v) {
  if (Array.isArray(v)) return v.length ? v[0] : '';
  return v || '';
}

// Convert a CrossRef CSL-JSON message into the library-UI shape.
function _cslToUnified(csl) {
  const authors = [];
  for (const a of csl.author || []) {
    authors.push({ family: a.family || '', given: a.given || '' });
  }
  let year = '';
  const parts = (csl.issued && csl.issued['date-parts']) || [];
  if (parts.length && parts[0] && parts[0].length) year = String(parts[0][0]);
  const doi = (csl.DOI || '').toLowerCase();
  return {
    title: _first(csl.title),
    authors,
    year,
    journal: _first(csl['container-title']),
    journal_iso: _first(csl['short-container-title']),
    issn: _first(csl.ISSN),
    volume: csl.volume || '',
    issue: csl.issue || '',
    pages: csl.page || '',
    doi,
    abstract: _stripJats(csl.abstract || ''),
    url: csl.URL || (doi ? `https://doi.org/${doi}` : ''),
    source: 'crossref',
  };
}

async function _lookupCrossref(doi) {
  const doiClean = String(doi).trim().replace(/^https?:\/\/(dx\.)?doi\.org\//i, '');
  const url = `https://api.crossref.org/works/${encodeURIComponent(doiClean).replace(/%2F/gi, '/')}`;
  const data = await _getJson(url).catch(err => {
    if (err.status === 404) return null;
    throw err;
  });
  const msg = (data && data.message) || null;
  if (!msg) return { error: 'DOI not found in CrossRef' };
  return _cslToUnified(msg);
}

async function _lookupCrossrefTitle(title) {
  const q = encodeURIComponent(title);
  const url = `https://api.crossref.org/works?query.bibliographic=${q}&rows=1`;
  const data = await _getJson(url);
  const items = ((data.message || {}).items) || [];
  if (!items.length) return { error: 'No CrossRef match for title' };
  return _cslToUnified(items[0]);
}

async function _lookupPubmed(pmid) {
  const pmidClean = String(pmid).replace(/\D/g, '');
  if (!pmidClean) return { error: 'Invalid PMID' };
  const url =
    'https://eutils.ncbi.nlm.nih.gov/entrez/eutils/esummary.fcgi' +
    `?db=pubmed&id=${pmidClean}&retmode=json`;
  const data = await _getJson(url);
  const rec = ((data.result || {})[pmidClean]) || {};
  if (!rec || Object.keys(rec).length === 0 || rec.error) return { error: 'PMID not found' };
  const authors = [];
  for (const a of rec.authors || []) {
    // pubmed authors look like {"name":"Smith JA","authtype":"Author",...}
    const name = a.name || '';
    const idx = name.lastIndexOf(' ');
    if (idx > 0) authors.push({ family: name.slice(0, idx), given: name.slice(idx + 1) });
    else authors.push({ family: name, given: '' });
  }
  const m = /\b(19|20)\d{2}\b/.exec(rec.pubdate || '');
  let doi = '';
  for (const aid of rec.articleids || []) {
    if (aid.idtype === 'doi') { doi = aid.value || ''; break; }
  }
  return {
    title: rec.title || '',
    authors,
    year: m ? m[0] : '',
    journal: rec.fulljournalname || rec.source || '',
    journal_iso: rec.source || '',
    issn: rec.issn || rec.essn || '',
    volume: rec.volume || '',
    issue: rec.issue || '',
    pages: rec.pages || '',
    doi: doi.toLowerCase(),
    pmid: pmidClean,
    abstract: '', // esummary does not include abstract; matches server.py
    url: `https://pubmed.ncbi.nlm.nih.gov/${pmidClean}/`,
    source: 'pubmed',
  };
}

async function _lookupArxiv(arxivId) {
  const aid = String(arxivId).trim().replace(/^arxiv:\s*/i, '');
  const url = `http://export.arxiv.org/api/query?id_list=${encodeURIComponent(aid)}`;
  const text = await _getText(url);
  // arXiv returns Atom XML. Extract the bare minimum without an XML
  // parser dependency — simple regex against the first <entry>.
  const entryMatch = /<entry>([\s\S]*?)<\/entry>/.exec(text);
  if (!entryMatch) return { error: 'arXiv id not found' };
  const entry = entryMatch[1];
  const tag = name => {
    const m = new RegExp(`<${name}>([\\s\\S]*?)</${name}>`).exec(entry);
    return m ? m[1].trim() : '';
  };
  const title = tag('title').replace(/\s+/g, ' ');
  const summary = tag('summary').replace(/\s+/g, ' ');
  const published = tag('published');
  let doi = '';
  let m = /<arxiv:doi[^>]*>([\s\S]*?)<\/arxiv:doi>/.exec(entry);
  if (m) doi = m[1].trim().toLowerCase();
  let journalRef = '';
  m = /<arxiv:journal_ref[^>]*>([\s\S]*?)<\/arxiv:journal_ref>/.exec(entry);
  if (m) journalRef = m[1].trim();
  const authors = [];
  const authRe = /<author>\s*<name>([\s\S]*?)<\/name>\s*<\/author>/g;
  let am;
  while ((am = authRe.exec(entry)) !== null) {
    const full = am[1].trim();
    const idx = full.lastIndexOf(' ');
    if (idx > 0) authors.push({ family: full.slice(idx + 1), given: full.slice(0, idx) });
    else authors.push({ family: full, given: '' });
  }
  return {
    title,
    authors,
    year: published ? published.slice(0, 4) : '',
    journal: journalRef,
    journal_iso: '',
    issn: '',
    volume: '',
    issue: '',
    pages: '',
    doi,
    arxiv_id: aid,
    abstract: summary,
    url: `https://arxiv.org/abs/${aid}`,
    source: 'arxiv',
  };
}

/* ---------------- cache ------------------------------------------------ */

function _cacheDocId(kind, key) {
  return crypto.createHash('sha1').update(`${kind}:${key}`).digest('hex');
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
      kind,
      key,
      result,
      fetched_at: new Date().toISOString(),
    });
  } catch (err) {
    // Cache is best-effort — a failed write must never fail the lookup.
    console.warn('[libraryLookup] cache write failed:', err.message);
  }
}

/* ---------------- function --------------------------------------------- */

const libraryLookup = onRequest(
  { cors: false, timeoutSeconds: 30 },
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
    const doi = String(body.doi || '').trim();
    const pmid = String(body.pmid || '').trim();
    const arxivId = String(body.arxiv_id || '').trim();
    const title = String(body.title || '').trim();
    const refresh = body.refresh === true;

    // Same precedence as server.py: doi → pmid → arxiv_id → title.
    let kind = '';
    let key = '';
    if (doi) {
      kind = 'doi';
      key = doi.toLowerCase().replace(/^https?:\/\/(dx\.)?doi\.org\//i, '');
    } else if (pmid) {
      kind = 'pmid';
      key = pmid.replace(/\D/g, '');
    } else if (arxivId) {
      kind = 'arxiv';
      key = arxivId.toLowerCase().replace(/^arxiv:\s*/i, '');
    } else if (title) {
      kind = 'title';
      key = title.slice(0, 300);
    } else {
      res.status(400).json({ error: 'Provide one of: doi, pmid, arxiv_id, title' });
      return;
    }

    // Identifier lookups hit the 30-day cache; title queries never do.
    if (kind !== 'title' && !refresh) {
      try {
        const cached = await _cacheRead(db, kind, key);
        if (cached) { res.json(cached); return; }
      } catch (err) {
        console.warn('[libraryLookup] cache read failed:', err.message);
      }
    }

    let result;
    try {
      if (kind === 'doi') result = await _lookupCrossref(key);
      else if (kind === 'pmid') result = await _lookupPubmed(key);
      else if (kind === 'arxiv') result = await _lookupArxiv(key);
      else result = await _lookupCrossrefTitle(key);
    } catch (err) {
      res.status(502).json({ error: `Lookup failed: ${err.message}` });
      return;
    }

    if (kind !== 'title' && result && !result.error) {
      await _cacheWrite(db, kind, key, result);
    }
    res.json(result);
  }
);

module.exports = { libraryLookup };
