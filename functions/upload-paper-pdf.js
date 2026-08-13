/* ================================================================
   upload-paper-pdf.js — bookmarklet PDF receiver (V3.500, Phase 2)
   ================================================================
   For papers with NO open-access copy (paywalled). A "Grab PDF for RM"
   bookmarklet runs ON the publisher's page — its own origin — so it can
   fetch the PDF bytes with the user's UArizona subscription (no CORS,
   no server involvement in the download) and POST them here.

   Auth bridge: the RM library mints a random per-device token (the doc
   ID of uploadTokens/{token} IS the secret; the doc maps token → uid).
   The bookmarklet can't share RM's Firebase session (different origin),
   so it carries the token in the request; this function resolves it via
   the Admin SDK (which bypasses Firestore rules) and re-checks the
   user's lab-member role.

   Request:
     POST /?token=<t>&doi=<>&title=<>&pmid=<>&arxiv_id=<>&url=<>
     Content-Type: application/pdf
     body: the raw PDF bytes
   Response JSON:
     {ok, paperId, attached|created|skipped, title}  or  {ok:false, error}

   CORS: Access-Control-Allow-Origin '*' — the bookmarklet posts from
   arbitrary publisher domains, and auth is the body token (not cookies),
   so '*' is safe here.

   Deploy:  firebase deploy --only functions:uploadPaperPdf
   ================================================================ */

const { onRequest } = require('firebase-functions/v2/https');
const { getFirestore, FieldValue } = require('firebase-admin/firestore');
const { getStorage } = require('firebase-admin/storage');
const crypto = require('crypto');

// Cloud Functions v2 / Cloud Run caps the inbound request body near 32 MiB, so
// a bigger PDF is rejected at the platform edge before we run — keep our limit
// under that so the friendly size error is actually reachable.
const MAX_PDF_BYTES = 30 * 1024 * 1024;
const MIN_PDF_BYTES = 1000;

function setCors(res) {
  res.set('Access-Control-Allow-Origin', '*');
  res.set('Access-Control-Allow-Methods', 'POST, OPTIONS');
  res.set('Access-Control-Allow-Headers', 'Content-Type, X-Upload-Token');
  res.set('Access-Control-Max-Age', '3600');
}

// ---- identity matching (ported from rm/js/library-upload.js, kept in sync) --
function _normDoi(d) {
  return String(d || '').trim().toLowerCase()
    .replace(/^https?:\/\/(dx\.)?doi\.org\//, '').replace(/^doi:\s*/, '')
    .replace(/[.,;:)\]>"'<\/\s]+$/, '');
}
function _normArxiv(id) {
  return String(id || '').trim().toLowerCase()
    .replace(/^https?:\/\/(www\.)?arxiv\.org\/(abs|pdf)\//, '')
    .replace(/^arxiv:\s*/, '').replace(/\.pdf$/, '').replace(/v\d+$/, '');
}
function _normPmid(id) { return String(id || '').replace(/^\s*pmid:\s*/i, '').replace(/\D/g, ''); }
function _normTitle(t) { return String(t || '').toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim(); }
function _fam(authors) {
  const a = Array.isArray(authors) && authors[0];
  return a ? String(a.family || '').trim().toLowerCase() : '';
}

function findExistingEntry(meta, items) {
  const doi = _normDoi(meta.doi);
  const pmid = _normPmid(meta.pmid);
  const arxiv = _normArxiv(meta.arxiv_id);
  const title = _normTitle(meta.title);
  const metaFam = _fam(meta.authors);
  const entries = items.filter(it => {
    const lib = it && it.meta && it.meta.library;
    return lib && lib.is_library_entry;
  });
  for (const it of entries) {
    const lib = it.meta.library;
    if (doi && _normDoi(lib.doi) === doi) return { item: it, matchedBy: 'doi' };
    if (pmid && _normPmid(lib.pmid) === pmid) return { item: it, matchedBy: 'pmid' };
    if (arxiv && _normArxiv(lib.arxiv_id) === arxiv) return { item: it, matchedBy: 'arxiv' };
  }
  if (title && title.length >= 8) {
    for (const it of entries) {
      const lib = it.meta.library;
      if (_normTitle(it.title) !== title) continue;
      const itFam = _fam(lib.authors);
      if (metaFam && itFam && metaFam !== itFam) continue;
      return { item: it, matchedBy: 'title' };
    }
  }
  return null;
}

function _slug(s) {
  return String(s || '').toLowerCase().replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '').slice(0, 60);
}

// A minimal library stub when the paper isn't in the library yet. The user can
// ⟳ Re-check metadata later to enrich it; the important thing is the PDF lands.
function _buildStub(meta, id, today) {
  return {
    id,
    type: 'paper',
    category: 'research',
    title: meta.title || 'Untitled',
    status: 'published',
    created_at: today,
    updated_at: today,
    meta: {
      library: {
        is_library_entry: true,
        doi: _normDoi(meta.doi),
        pmid: _normPmid(meta.pmid),
        arxiv_id: meta.arxiv_id || '',
        title: meta.title || '',
        authors: [],
        source: 'bookmarklet',
        date_added: today,
        public: false,
      },
    },
  };
}

const uploadPaperPdf = onRequest(
  { memory: '512MiB', timeoutSeconds: 120 },
  async (req, res) => {
    setCors(res);
    if (req.method === 'OPTIONS') { res.status(204).send(''); return; }
    if (req.method !== 'POST') { res.status(405).json({ ok: false, error: 'POST only' }); return; }

    const q = req.query || {};
    // Token travels in a HEADER, not the query string: query strings are
    // recorded verbatim in Cloud Run request logs / proxies, and this token is
    // a long-lived bearer secret.
    const token = String(req.get('X-Upload-Token') || '').trim();
    if (!token || !/^[A-Za-z0-9_-]{16,128}$/.test(token)) {
      res.status(401).json({ ok: false, error: 'Missing or malformed X-Upload-Token.' });
      return;
    }

    const db = getFirestore();
    // Resolve token → uid, then re-check the user's lab-member role.
    let uid, email;
    try {
      const tokDoc = await db.collection('uploadTokens').doc(token).get();
      // `revoked` is set only via the Admin SDK; client rules forbid updating a
      // token doc, so rotation deletes it (→ !exists). Both cases reject here.
      if (!tokDoc.exists || tokDoc.data().revoked) {
        res.status(403).json({ ok: false, error: 'Token not recognized or revoked. Regenerate it in the RM library.' });
        return;
      }
      uid = tokDoc.data().uid;
      email = tokDoc.data().email || '';
      const userDoc = await db.collection('users').doc(uid).get();
      const role = userDoc.exists ? (userDoc.data().role || '') : '';
      if (!userDoc.exists || role === 'guest') {
        res.status(403).json({ ok: false, error: 'Lab membership required.' });
        return;
      }
    } catch (e) {
      res.status(500).json({ ok: false, error: 'Auth check failed: ' + (e.message || e) });
      return;
    }

    // Raw PDF bytes.
    const buf = req.rawBody;
    if (!buf || !buf.length) { res.status(400).json({ ok: false, error: 'Empty body — send the PDF bytes as application/pdf.' }); return; }
    if (buf.length < MIN_PDF_BYTES) { res.status(400).json({ ok: false, error: `Too small (${buf.length}B) — not a PDF.` }); return; }
    if (buf.length > MAX_PDF_BYTES) { res.status(413).json({ ok: false, error: `Too large (${buf.length}B > ${MAX_PDF_BYTES}).` }); return; }
    if (buf.subarray(0, 8).indexOf(Buffer.from('%PDF-')) === -1) {
      res.status(400).json({ ok: false, error: 'Body is not a PDF (no %PDF header) — you probably grabbed an HTML page, not the PDF.' });
      return;
    }

    const meta = {
      doi: String(q.doi || ''),
      pmid: String(q.pmid || ''),
      arxiv_id: String(q.arxiv_id || ''),
      title: String(q.title || ''),
    };
    const today = new Date().toISOString().slice(0, 10);

    // Match against the existing library (one query; lab libraries are small).
    let items = [];
    try {
      const snap = await db.collection('items').where('type', '==', 'paper').get();
      items = snap.docs.map(d => Object.assign({ id: d.id }, d.data()));
    } catch (e) {
      res.status(500).json({ ok: false, error: 'Library read failed: ' + (e.message || e) });
      return;
    }
    const hit = findExistingEntry(meta, items);

    let target = hit && hit.item;
    let mode;
    if (target) {
      const lib = (target.meta && target.meta.library) || {};
      if (lib.pdf && lib.pdf.storage_path) {
        res.json({ ok: true, skipped: true, paperId: target.id, title: target.title || '', message: 'Already has a PDF.' });
        return;
      }
      mode = 'attached';
    } else {
      // Not in the library → create a minimal stub. Resolve a free id against
      // the REAL (mixed-type) items collection, not the paper-only snapshot, so
      // a title slug can't collide with a grant/course/tool doc and clobber it.
      const base = _slug([meta.title, meta.doi].filter(Boolean).join('-')) || ('paper-' + token.slice(0, 6));
      let id = base;
      for (let n = 0; n < 5; n++) {
        const ex = await db.collection('items').doc(id).get();
        if (!ex.exists) break;
        id = `${base}-${crypto.randomBytes(3).toString('hex')}`;
      }
      target = _buildStub(meta, id, today);
      mode = 'created';
    }

    // Upload to Storage with a download token (Admin SDK uploads have none, and
    // the client reads via getDownloadURL which needs one).
    const fullHash = crypto.createHash('sha256').update(buf).digest('hex');
    const shortHash = fullHash.slice(0, 16);
    const storagePath = `papers/${target.id}/${shortHash}.pdf`;
    const downloadToken = crypto.randomUUID();
    try {
      await getStorage().bucket().file(storagePath).save(buf, {
        resumable: false,
        contentType: 'application/pdf',
        metadata: {
          contentType: 'application/pdf',
          metadata: { uploadedBy: email || uid, source: 'bookmarklet', fullHash, firebaseStorageDownloadTokens: downloadToken },
        },
      });
    } catch (e) {
      res.status(502).json({ ok: false, error: 'Storage upload failed: ' + (e.message || e) });
      return;
    }

    const pdfMeta = {
      storage_path: storagePath,
      hash: shortHash,
      filename_safe: `${target.id}.pdf`,
      size_bytes: buf.length,
      uploaded_at: today,
      uploaded_by: email || uid,
      source: 'bookmarklet',
    };

    try {
      if (mode === 'attached') {
        await db.collection('items').doc(target.id).set({
          meta: { library: { pdf: pdfMeta, pdf_status: FieldValue.delete() } },
          updated_at: today,
          updatedAt: FieldValue.serverTimestamp(),
        }, { merge: true });
      } else {
        target.meta.library.pdf = pdfMeta;
        target.updatedAt = FieldValue.serverTimestamp();
        // .create() refuses to overwrite an existing doc of ANY type, closing
        // the clobber path structurally even under a race with the id probe.
        await db.collection('items').doc(target.id).create(target);
      }
    } catch (e) {
      res.status(502).json({ ok: false, error: 'Saved the PDF but failed to update the library entry: ' + (e.message || e) });
      return;
    }

    res.json({ ok: true, paperId: target.id, [mode]: true, title: target.title || meta.title || '' });
  }
);

module.exports = { uploadPaperPdf };
