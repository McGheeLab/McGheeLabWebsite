/* ================================================================
   paper-pdf-fetch — Cloud Run headless PDF grabber (V3.501, Phase 3)
   ================================================================
   Loads a DOI / landing page in headless Chrome, finds the article PDF
   (the publisher's citation_pdf_url meta, else a PDF response captured
   during navigation), validates it, and uploads it to Storage at
   papers/{paperId}/{sha256Short}.pdf via the Admin SDK (with a download
   token so the browser's getDownloadURL() works).

   Invoked ONLY by the paperPdfFetchProxy Function (Cloud Run IAM +
   run.invoker); it trusts the X-User-Uid / X-User-Role headers the proxy
   sets after verifying the Firebase token, exactly like paper-compile.

   Request  (POST /):  { paperId, doi?, url?, pmid?, arxiv_id? }
   Response (JSON):    { ok, storage_path, hash, size_bytes, source } |
                       { ok:false, error, tried[] }
   ================================================================ */

const express = require('express');
const admin = require('firebase-admin');
const crypto = require('crypto');
const puppeteer = require('puppeteer');

// Explicit bucket — on Cloud Run FIREBASE_CONFIG isn't set, so a bare
// initializeApp() leaves admin.storage().bucket() with no default and it
// throws on upload. Env var wins if provided at deploy time.
admin.initializeApp({
  storageBucket: process.env.FIREBASE_STORAGE_BUCKET || 'mcgheelab-f56cc.firebasestorage.app',
});

const app = express();
app.use(express.json({ limit: '1mb' }));

const MAX_PDF_BYTES = 50 * 1024 * 1024;
const MIN_PDF_BYTES = 1000;
const NAV_TIMEOUT_MS = 45000;

function isPdfBuffer(buf) {
  return buf && buf.length >= MIN_PDF_BYTES && buf.length <= MAX_PDF_BYTES
    && buf.subarray(0, 1024).indexOf(Buffer.from('%PDF-')) !== -1;
}

app.get('/healthz', (_, res) => res.send('ok'));

app.post('/', async (req, res) => {
  // Trust the proxy's verified identity headers (Cloud Run IAM gates access).
  const uid = req.get('X-User-Uid') || '';
  if (!uid) { res.status(401).json({ ok: false, error: 'Missing X-User-Uid (call via the proxy).' }); return; }

  const body = req.body || {};
  const paperId = String(body.paperId || '').trim();
  if (!paperId || !/^[A-Za-z0-9._-]{1,200}$/.test(paperId)) {
    res.status(400).json({ ok: false, error: 'A valid paperId is required.' });
    return;
  }
  const doi = String(body.doi || '').trim().toLowerCase().replace(/^https?:\/\/(dx\.)?doi\.org\//, '');
  const landing = doi ? `https://doi.org/${doi}` : String(body.url || '').trim();
  if (!landing) { res.status(400).json({ ok: false, error: 'Provide a doi or url.' }); return; }

  const tried = [];
  let browser = null;
  let pdfBuf = null;
  let sourceUrl = '';

  try {
    browser = await puppeteer.launch({
      headless: 'new',
      args: ['--no-sandbox', '--disable-setuid-sandbox', '--disable-dev-shm-usage'],
    });
    const page = await browser.newPage();
    await page.setUserAgent(
      'Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36');
    page.setDefaultNavigationTimeout(NAV_TIMEOUT_MS);

    // Buffer PDF response bodies EAGERLY as they arrive — a later page.goto()
    // evicts earlier response bodies, so a lazy resp.buffer() after navigation
    // throws. Chrome's built-in PDF viewer also swallows the rendered response,
    // but the network response still fires this listener first.
    let captured = null;   // { buf, url }
    page.on('response', async (resp) => {
      if (captured) return;
      try {
        const ct = (resp.headers()['content-type'] || '').toLowerCase();
        if (!ct.includes('application/pdf')) return;
        const buf = await resp.buffer();
        if (isPdfBuffer(buf)) captured = { buf, url: resp.url() };
      } catch (_) { /* body unavailable for this response — skip */ }
    });

    await page.goto(landing, { waitUntil: 'networkidle2' }).catch(e => {
      tried.push({ step: 'goto-landing', reason: e.message });
    });

    // The publisher's advertised PDF link.
    let pdfUrl = '';
    try { pdfUrl = await page.$eval('meta[name="citation_pdf_url"]', el => el.content); } catch (_) { /* none */ }
    if (!pdfUrl) {
      try { pdfUrl = await page.$eval('link[type="application/pdf"]', el => el.href); } catch (_) { /* none */ }
    }

    // Navigating to it makes the listener capture the PDF response body.
    if (!captured && pdfUrl) {
      sourceUrl = pdfUrl;
      await page.goto(pdfUrl, { waitUntil: 'networkidle2' }).catch(e => {
        tried.push({ url: pdfUrl, step: 'goto-pdf', reason: e.message });
      });
    }

    if (captured) { pdfBuf = captured.buf; sourceUrl = captured.url || sourceUrl; }
    else tried.push({ step: 'capture', reason: 'no application/pdf response captured' });
  } catch (e) {
    tried.push({ step: 'launch/navigate', reason: e.message });
  } finally {
    if (browser) { try { await browser.close(); } catch (_) { /* ignore */ } }
  }

  if (!pdfBuf) {
    res.json({ ok: false, error: 'Headless fetch found no accessible PDF.', tried });
    return;
  }

  const fullHash = crypto.createHash('sha256').update(pdfBuf).digest('hex');
  const shortHash = fullHash.slice(0, 16);
  const storagePath = `papers/${paperId}/${shortHash}.pdf`;
  const downloadToken = crypto.randomUUID();
  try {
    await admin.storage().bucket().file(storagePath).save(pdfBuf, {
      resumable: false,
      contentType: 'application/pdf',
      metadata: {
        contentType: 'application/pdf',
        metadata: { fetchedBy: uid, source: 'headless', sourceUrl, fullHash, firebaseStorageDownloadTokens: downloadToken },
      },
    });
  } catch (e) {
    res.status(502).json({ ok: false, error: 'Storage upload failed: ' + (e.message || e) });
    return;
  }

  res.json({
    ok: true,
    storage_path: storagePath,
    hash: shortHash,
    full_hash: fullHash,
    size_bytes: pdfBuf.length,
    source: 'headless',
    source_url: sourceUrl,
  });
});

const port = process.env.PORT || 8080;
app.listen(port, () => console.log(`paper-pdf-fetch listening on ${port}`));
