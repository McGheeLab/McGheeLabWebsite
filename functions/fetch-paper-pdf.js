/* ================================================================
   fetch-paper-pdf.js — server-side open-access PDF fetcher (V3.498)
   ================================================================
   The browser can't download most publisher / repository PDFs (CORS),
   and it can't read a cross-origin DOI tab (same-origin policy). This
   function fetches server-side (no CORS), tries many open-access
   sources in priority order, validates the bytes are a real PDF, and
   uploads to Cloud Storage at papers/{paperId}/{sha256Short}.pdf via
   the Admin SDK (which bypasses Storage rules). The browser then stamps
   meta.library.pdf onto the item and saves — same shape the client's
   uploadPdf() returns, so the existing attach code consumes it.

   It deliberately fetches ONLY open-access URLs and the publisher's own
   advertised citation_pdf_url; it never tries to defeat a paywall (the
   server has no institutional access anyway — that's the Phase-2
   bookmarklet's job, which runs in the user's logged-in browser).

   Authorization: any authenticated user with users/{uid}.role != 'guest'
   (same trust tier as library writes / libraryLookup).

   Deploy:  firebase deploy --only functions:fetchPaperPdf
   ================================================================ */

const { onRequest } = require('firebase-functions/v2/https');
const { getFirestore } = require('firebase-admin/firestore');
const { getAuth } = require('firebase-admin/auth');
const { getStorage } = require('firebase-admin/storage');
const crypto = require('crypto');
const net = require('net');

const ALLOWED_ORIGINS = [
  'https://mcgheelab.com',
  'https://www.mcgheelab.com',
  'http://localhost:8000',
];

// A browsery UA for the actual PDF/HTML fetch (some hosts 403 a bot UA)…
const BROWSER_UA =
  'Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) ' +
  'Chrome/124.0.0.0 Safari/537.36';
// …and a polite, identifying UA for the metadata APIs.
const POLITE_UA = 'McGheeLab-RM/1.0 (https://mcgheelab.com; mailto:mcgheelab@arizona.edu)';
const UNPAYWALL_EMAIL = 'mcgheelab@arizona.edu';

const FETCH_TIMEOUT_MS = 20000;
const MAX_PDF_BYTES = 50 * 1024 * 1024;   // matches storage.rules papers/ guard
const MIN_PDF_BYTES = 1000;

function setCors(req, res) {
  const origin = req.headers.origin || '';
  if (ALLOWED_ORIGINS.includes(origin)) res.set('Access-Control-Allow-Origin', origin);
  res.set('Access-Control-Allow-Methods', 'POST, OPTIONS');
  res.set('Access-Control-Allow-Headers', 'Authorization, Content-Type');
  res.set('Access-Control-Max-Age', '3600');
}

// SSRF guard — classify a host and block loopback / private / link-local /
// cloud-metadata / CGNAT across BOTH IPv4 and IPv6 (incl. IPv4-mapped). A bare
// hostname (not an IP literal) is allowed; DNS-rebinding is a separate,
// documented gap (we don't resolve here).
function _isBlockedHost(bare) {
  if (!bare) return true;
  if (bare === 'localhost' || bare.endsWith('.internal') || bare.endsWith('.local')) return true;
  const fam = net.isIP(bare);
  if (fam === 4) {
    return /^0\./.test(bare)                                   // 0.0.0.0/8
      || /^127\./.test(bare)                                   // loopback
      || /^10\./.test(bare)                                    // private
      || /^192\.168\./.test(bare)                              // private
      || /^169\.254\./.test(bare)                              // link-local incl. 169.254.169.254 metadata
      || /^172\.(1[6-9]|2\d|3[01])\./.test(bare)               // private
      || /^100\.(6[4-9]|[7-9]\d|1[01]\d|12[0-7])\./.test(bare); // CGNAT 100.64/10
  }
  if (fam === 6) {
    if (bare === '::1' || bare === '::') return true;          // loopback / unspecified
    if (/^f[cd]/.test(bare)) return true;                      // fc00::/7 ULA
    if (/^fe[89ab]/.test(bare)) return true;                   // fe80::/10 link-local
    const mapped = bare.match(/^::ffff:(.+)$/i);               // IPv4-mapped
    if (mapped) {
      let d = mapped[1];
      const hx = d.match(/^([0-9a-f]{1,4}):([0-9a-f]{1,4})$/i);
      if (hx) {
        const a = parseInt(hx[1], 16), b = parseInt(hx[2], 16);
        d = [(a >> 8) & 255, a & 255, (b >> 8) & 255, b & 255].join('.');
      }
      return _isBlockedHost(d);
    }
    return false;
  }
  return false;   // hostname literal
}

function _safeUrl(u) {
  let url;
  try { url = new URL(String(u)); } catch { return null; }
  if (url.protocol !== 'http:' && url.protocol !== 'https:') return null;
  let h = url.hostname.toLowerCase();
  if (h.startsWith('[') && h.endsWith(']')) h = h.slice(1, -1);   // strip IPv6 brackets
  if (_isBlockedHost(h)) return null;
  return url.toString();
}

function _absolutize(u, base) {
  try { return new URL(u, base).toString(); } catch { return u; }
}

// Fetch with MANUAL redirect handling so the SSRF guard re-validates EVERY hop
// (redirect:'follow' would let an allowed URL bounce into a blocked host).
// Returns {ok, res, finalUrl} or {ok:false, url, reason}.
async function _safeFetch(rawUrl, opts) {
  const o = opts || {};
  const ua = o.ua || BROWSER_UA;
  let current = _safeUrl(rawUrl);
  if (!current) return { ok: false, url: rawUrl, reason: 'blocked or invalid url' };
  for (let hop = 0; hop < 6; hop++) {
    let res;
    try {
      res = await fetch(current, {
        headers: { 'User-Agent': ua, ...(o.accept ? { Accept: o.accept } : {}) },
        redirect: 'manual',
        signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
      });
    } catch (e) {
      return { ok: false, url: current, reason: 'fetch: ' + (e.message || e) };
    }
    if (res.status >= 300 && res.status < 400) {
      const loc = res.headers.get('location');
      if (!loc) return { ok: false, url: current, reason: 'redirect with no Location' };
      const next = _safeUrl(_absolutize(loc, current));
      if (!next) return { ok: false, url: current, reason: 'redirect to blocked host' };
      current = next;
      continue;
    }
    return { ok: true, res, finalUrl: current };
  }
  return { ok: false, url: current, reason: 'too many redirects' };
}

// Fetch a URL and return {ok, buf, url} when it's a valid PDF, else
// {ok:false, url, reason}.
async function _fetchPdf(rawUrl) {
  const r = await _safeFetch(rawUrl, { accept: 'application/pdf,application/octet-stream,*/*' });
  if (!r.ok) return { ok: false, url: r.url, reason: r.reason };
  const res = r.res;
  if (!res.ok) return { ok: false, url: r.finalUrl, reason: 'HTTP ' + res.status };
  const ct = (res.headers.get('content-type') || '').toLowerCase();
  // Reject before buffering when the server advertises an over-size body.
  const cl = Number(res.headers.get('content-length') || 0);
  if (cl && cl > MAX_PDF_BYTES) return { ok: false, url: r.finalUrl, reason: `too large (content-length ${cl})` };
  let buf;
  try { buf = Buffer.from(await res.arrayBuffer()); }
  catch (e) { return { ok: false, url: r.finalUrl, reason: 'read: ' + (e.message || e) }; }
  if (buf.length < MIN_PDF_BYTES) return { ok: false, url: r.finalUrl, reason: `too small (${buf.length}B, ct=${ct})` };
  if (buf.length > MAX_PDF_BYTES) return { ok: false, url: r.finalUrl, reason: `too large (${buf.length}B)` };
  // Real PDFs carry the "%PDF-" magic in the first bytes (some hosts serve an
  // HTML error page with a 200 + pdf content-type). Scan a small leading window
  // so a stray BOM / whitespace before the header doesn't reject a valid file.
  if (buf.subarray(0, 1024).indexOf(Buffer.from('%PDF-')) === -1) {
    return { ok: false, url: r.finalUrl, reason: `not a PDF (ct=${ct})` };
  }
  return { ok: true, url: r.finalUrl, buf };
}

async function _getJson(url) {
  const r = await _safeFetch(url, { accept: 'application/json', ua: POLITE_UA });
  if (!r.ok || !r.res.ok) return null;
  try { return await r.res.json(); } catch { return null; }
}

// ---- candidate-URL sources (each returns a flat array of URL strings) ----

function _arxivUrls(arxivId) {
  const id = String(arxivId || '').trim().toLowerCase()
    .replace(/^https?:\/\/(www\.)?arxiv\.org\/(abs|pdf)\//, '')
    .replace(/^arxiv:\s*/, '')
    .replace(/\.pdf$/, '');
  if (!id) return [];
  return [`https://arxiv.org/pdf/${id}.pdf`, `https://arxiv.org/pdf/${id}`];
}

async function _unpaywallUrls(doi) {
  if (!doi) return [];
  const d = await _getJson(
    `https://api.unpaywall.org/v2/${encodeURIComponent(doi)}?email=${encodeURIComponent(UNPAYWALL_EMAIL)}`);
  if (!d) return [];
  const out = [];
  if (d.best_oa_location && d.best_oa_location.url_for_pdf) out.push(d.best_oa_location.url_for_pdf);
  for (const l of (d.oa_locations || [])) if (l && l.url_for_pdf) out.push(l.url_for_pdf);
  return out;
}

async function _europePmcUrls(doi, pmid) {
  const q = doi ? `DOI:${doi}` : (pmid ? `EXT_ID:${pmid} AND SRC:MED` : '');
  if (!q) return [];
  const d = await _getJson(
    `https://www.ebi.ac.uk/europepmc/webservices/rest/search?query=${encodeURIComponent(q)}&format=json&resultType=core`);
  const results = (d && d.resultList && d.resultList.result) || [];
  const out = [];
  for (const item of results) {
    if (item.pmcid) {
      out.push(`https://www.ebi.ac.uk/europepmc/webservices/rest/${item.source || 'PMC'}/${item.pmcid}/fullTextPDF`);
      out.push(`https://europepmc.org/articles/${item.pmcid}?pdf=render`);
    }
    const ftl = (item.fullTextUrlList && item.fullTextUrlList.fullTextUrl) || [];
    for (const f of ftl) if (f && f.documentStyle === 'pdf' && f.url) out.push(f.url);
  }
  return out;
}

async function _semanticScholarUrls(doi, arxivId, pmid) {
  const idSpec = doi ? `DOI:${doi}`
    : arxivId ? `arXiv:${String(arxivId).replace(/^arxiv:\s*/i, '')}`
      : pmid ? `PMID:${pmid}` : '';
  if (!idSpec) return [];
  const d = await _getJson(
    `https://api.semanticscholar.org/graph/v1/paper/${encodeURIComponent(idSpec)}?fields=openAccessPdf`);
  return (d && d.openAccessPdf && d.openAccessPdf.url) ? [d.openAccessPdf.url] : [];
}

// Fetch the landing (DOI) HTML and pull the publisher's advertised PDF link.
async function _citationPdfMetaUrls(landingUrl) {
  const r = await _safeFetch(landingUrl, { accept: 'text/html,application/xhtml+xml,*/*' });
  if (!r.ok || !r.res.ok) return [];
  const finalUrl = r.finalUrl;
  let html;
  try { html = await r.res.text(); } catch { return []; }
  const out = [];
  let m;
  // <meta name="citation_pdf_url" content="…"> (both attribute orders).
  const re1 = /<meta[^>]+name=["']citation_pdf_url["'][^>]+content=["']([^"']+)["']/gi;
  while ((m = re1.exec(html))) out.push(_absolutize(m[1], finalUrl));
  const re2 = /<meta[^>]+content=["']([^"']+)["'][^>]+name=["']citation_pdf_url["']/gi;
  while ((m = re2.exec(html))) out.push(_absolutize(m[1], finalUrl));
  // <link rel="alternate" type="application/pdf" href="…">
  const re3 = /<link[^>]+type=["']application\/pdf["'][^>]+href=["']([^"']+)["']/gi;
  while ((m = re3.exec(html))) out.push(_absolutize(m[1], finalUrl));
  const re4 = /<link[^>]+href=["']([^"']+)["'][^>]+type=["']application\/pdf["']/gi;
  while ((m = re4.exec(html))) out.push(_absolutize(m[1], finalUrl));
  return out;
}

const fetchPaperPdf = onRequest(
  { memory: '512MiB', timeoutSeconds: 120 },
  async (req, res) => {
    setCors(req, res);
    if (req.method === 'OPTIONS') { res.status(204).send(''); return; }
    if (req.method !== 'POST') { res.status(405).json({ error: 'POST only' }); return; }

    // ---- auth: Bearer ID token → users/{uid}.role != 'guest' ----
    const authz = req.headers.authorization || '';
    const bearer = authz.match(/^Bearer (.+)$/);
    if (!bearer) { res.status(401).json({ error: 'Missing Authorization bearer token' }); return; }
    let uid;
    try { uid = (await getAuth().verifyIdToken(bearer[1])).uid; }
    catch { res.status(401).json({ error: 'Invalid auth token' }); return; }
    const db = getFirestore();
    let role = '';
    try {
      const snap = await db.collection('users').doc(uid).get();
      role = snap.exists ? (snap.data().role || '') : '';
      if (!snap.exists || role === 'guest') {
        res.status(403).json({ error: 'permission-denied: lab members only' });
        return;
      }
    } catch (e) {
      res.status(500).json({ error: 'auth check failed: ' + (e.message || e) });
      return;
    }

    // ---- inputs ----
    const b = req.body || {};
    const paperId = String(b.paperId || '').trim();
    if (!paperId || !/^[A-Za-z0-9._-]{1,200}$/.test(paperId)) {
      res.status(400).json({ error: 'A valid paperId is required' });
      return;
    }
    const doi = String(b.doi || '').trim().toLowerCase()
      .replace(/^https?:\/\/(dx\.)?doi\.org\//, '').replace(/^doi:\s*/, '');
    const pmid = String(b.pmid || '').replace(/\D/g, '');
    const arxivId = String(b.arxiv_id || '').trim();
    const candidateUrl = String(b.candidateUrl || '').trim();
    const landingUrl = doi ? `https://doi.org/${doi}` : String(b.url || '').trim();

    if (!doi && !pmid && !arxivId && !candidateUrl && !landingUrl) {
      res.status(400).json({ error: 'Provide a doi, pmid, arxiv_id, url, or candidateUrl' });
      return;
    }

    // ---- try candidates in priority order (deduped) ----
    const tried = [];
    const seen = new Set();
    async function tryList(urls, source) {
      for (const u of (urls || [])) {
        if (!u || seen.has(u)) continue;
        seen.add(u);
        const r = await _fetchPdf(u);
        if (r.ok) return { buf: r.buf, url: r.url, source };
        tried.push({ url: u, source, reason: r.reason });
      }
      return null;
    }

    let hit = null;
    if (!hit && candidateUrl) hit = await tryList([candidateUrl], 'candidate');
    if (!hit) hit = await tryList(_arxivUrls(arxivId), 'arxiv');
    if (!hit) hit = await tryList(await _unpaywallUrls(doi), 'unpaywall');
    if (!hit) hit = await tryList(await _europePmcUrls(doi, pmid), 'europepmc');
    if (!hit) hit = await tryList(await _semanticScholarUrls(doi, arxivId, pmid), 'semantic_scholar');
    if (!hit && landingUrl) hit = await tryList(await _citationPdfMetaUrls(landingUrl), 'citation_pdf_url');

    if (!hit) {
      res.json({ ok: false, error: 'No accessible open-access PDF found from any source.', tried });
      return;
    }

    // ---- hash + upload to Storage (content-addressed → idempotent) ----
    const fullHash = crypto.createHash('sha256').update(hit.buf).digest('hex');
    const shortHash = fullHash.slice(0, 16);
    const storagePath = `papers/${paperId}/${shortHash}.pdf`;
    // Admin-SDK uploads (unlike the browser SDK's put()) don't get a download
    // token, and every client read path uses getDownloadURL() — which throws
    // storage/no-download-url on a tokenless object. Stamp one so the fetched
    // PDF is actually openable.
    const downloadToken = crypto.randomUUID();
    try {
      await getStorage().bucket().file(storagePath).save(hit.buf, {
        resumable: false,
        contentType: 'application/pdf',
        metadata: {
          contentType: 'application/pdf',
          metadata: {
            fetchedBy: uid,
            source: hit.source,
            sourceUrl: hit.url,
            fullHash,
            firebaseStorageDownloadTokens: downloadToken,
          },
        },
      });
    } catch (e) {
      res.status(502).json({ error: 'Storage upload failed: ' + (e.message || e), source: hit.source, source_url: hit.url });
      return;
    }

    res.json({
      ok: true,
      storage_path: storagePath,
      hash: shortHash,
      full_hash: fullHash,
      size_bytes: hit.buf.length,
      source: hit.source,
      source_url: hit.url,
    });
  }
);

module.exports = { fetchPaperPdf };
