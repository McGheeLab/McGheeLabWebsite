/* library-upload.js — Firebase Cloud Storage upload + SHA256 dedupe.
 *
 * Public API (window.LIBRARY_UPLOAD):
 *   sha256Hex(blob)            → Promise<hex string (full)>
 *   findDuplicate(hash, items) → existing paper item with that hash, or null
 *   uploadPdf(paperId, blob)   → Promise<{storage_path, hash, size_bytes,
 *                                          uploaded_at, uploaded_by, download_url}>
 *   downloadUrl(storage_path)  → Promise<string>
 *
 * The PDF blob never touches server.py — it goes straight to Firebase Cloud
 * Storage from the browser. Server.py only writes the metadata into
 * data/items.json (via PUT /api/data/items.json). See plan §A.
 */

(function () {
  async function sha256Hex(blob) {
    const buf = await blob.arrayBuffer();
    const hash = await crypto.subtle.digest('SHA-256', buf);
    return Array.from(new Uint8Array(hash))
      .map(b => b.toString(16).padStart(2, '0'))
      .join('');
  }

  function findDuplicate(hashHex, items) {
    if (!hashHex || !Array.isArray(items)) return null;
    const short = hashHex.slice(0, 16);
    for (const it of items) {
      const lib = it && it.meta && it.meta.library;
      const pdf = lib && lib.pdf;
      if (!pdf) continue;
      if (pdf.hash === hashHex || pdf.hash === short) return it;
    }
    return null;
  }

  function _requireAuth() {
    if (typeof firebase === 'undefined' || !firebase.auth) {
      throw new Error('Firebase SDK not loaded — cannot upload PDFs.');
    }
    const user = firebase.auth().currentUser;
    if (!user) throw new Error('Sign in to upload PDFs.');
    return user;
  }

  function _requireStorage() {
    if (!firebase.storage) {
      throw new Error('Firebase Storage SDK not loaded — add firebase-storage-compat.js to the page.');
    }
  }

  async function uploadPdf(paperId, blob) {
    _requireStorage();
    const user = _requireAuth();
    const hashHex = await sha256Hex(blob);
    const shortHash = hashHex.slice(0, 16);
    const storagePath = `papers/${paperId}/${shortHash}.pdf`;
    const ref = firebase.storage().ref().child(storagePath);

    // Skip the upload if the blob already exists at this path. Firebase's
    // resumable upload will overwrite by default, which would re-bill bytes
    // for the same content — check getMetadata first.
    let exists = false;
    try {
      await ref.getMetadata();
      exists = true;
    } catch (e) {
      // 404 = not found → proceed with upload. Anything else is a real error.
      if (e && e.code && e.code !== 'storage/object-not-found') throw e;
    }

    if (!exists) {
      await ref.put(blob, {
        contentType: 'application/pdf',
        customMetadata: {
          uploadedBy: user.email || user.uid,
          fullHash: hashHex,
        },
      });
    }

    const downloadUrl = await ref.getDownloadURL();
    return {
      storage_path: storagePath,
      hash: shortHash,
      full_hash: hashHex,
      size_bytes: blob.size,
      uploaded_at: new Date().toISOString().slice(0, 10),
      uploaded_by: user.email || user.uid,
      download_url: downloadUrl,
      already_existed: exists,
    };
  }

  async function downloadUrl(storagePath) {
    _requireStorage();
    return firebase.storage().ref().child(storagePath).getDownloadURL();
  }

  /** Look up a DOI on Unpaywall to find an open-access PDF URL.
   *  Returns {bestPdfUrl, source, license} or null. CORS-friendly. */
  async function _unpaywallLookup(doi) {
    let email = '';
    try {
      const u = firebase.auth().currentUser;
      email = (u && u.email) || '';
    } catch (_) { /* ignore */ }
    if (!email) email = 'mcgheelab@arizona.edu';
    const url = `https://api.unpaywall.org/v2/${encodeURIComponent(doi)}?email=${encodeURIComponent(email)}`;
    let res;
    try {
      res = await fetch(url);
    } catch (e) {
      console.warn('[library-upload] unpaywall fetch failed:', e.message);
      return null;
    }
    if (!res.ok) return null;
    const data = await res.json();
    const best = data.best_oa_location || (data.oa_locations && data.oa_locations[0]);
    if (!best || !best.url_for_pdf) return null;
    return {
      bestPdfUrl: best.url_for_pdf,
      source: best.host_type || '',          // 'repository' | 'publisher' | ''
      license: best.license || '',
      isOa: !!data.is_oa,
    };
  }

  /** Best-effort fetch of an OA PDF URL. Most publisher domains block CORS;
   *  arXiv, bioRxiv, PMC and other repositories typically allow it. Returns
   *  the Blob on success, null on CORS / network failure. */
  async function _fetchPdfBlob(pdfUrl) {
    try {
      const r = await fetch(pdfUrl, { mode: 'cors', credentials: 'omit' });
      if (!r.ok) return null;
      const ct = r.headers.get('content-type') || '';
      if (!/pdf|octet-stream/i.test(ct)) return null;
      const blob = await r.blob();
      // Sanity: PDFs start with "%PDF" magic. Read first 4 bytes.
      const buf = await blob.slice(0, 4).arrayBuffer();
      const sig = new Uint8Array(buf);
      if (sig[0] !== 0x25 || sig[1] !== 0x50 || sig[2] !== 0x44 || sig[3] !== 0x46) {
        return null;
      }
      return blob;
    } catch (e) {
      console.warn('[library-upload] OA PDF fetch blocked or failed:', e.message);
      return null;
    }
  }

  /** Stub-create a library entry from a DOI. Tries Unpaywall for an OA PDF
   *  and uploads it to Storage if a CORS-permitted URL is found; otherwise
   *  saves the URL on the item as `meta.library.pdf_candidate_url` so the
   *  user can fetch it manually later (or feed it into the
   *  "no-pdf-found" queue in the wishlist).
   *
   *  Returns: {item, alreadyExisted, pdfInfo, pdfCandidateUrl, oaSource} */
  async function fromDoi(doi) {
    if (!doi) throw new Error('fromDoi: doi required');
    if (!window.LIBRARY_METADATA) throw new Error('LIBRARY_METADATA not loaded');
    const user = _requireAuth();
    const meta = await window.LIBRARY_METADATA.lookup({ doi });
    const data = await api.load('items.json');
    const items = (data && data.items) || [];
    // Dedupe by DOI.
    const norm = String(doi).toLowerCase().replace(/[.,;)]+$/, '');
    const dup = items.find(it => {
      const lib = (it.meta && it.meta.library) || {};
      return lib.is_library_entry && (lib.doi || '').toLowerCase() === norm;
    });
    if (dup) return { item: dup, alreadyExisted: true, pdfInfo: null, pdfCandidateUrl: '' };

    // Try Unpaywall + auto-fetch BEFORE building the item so a successful
    // upload can stamp pdfInfo into the new item's meta.library.pdf in
    // the same shape as a normal upload.
    let pdfInfo = null;
    let pdfBlob = null;     // V3.93 — hoisted so the post-import ref parser sees it
    let pdfCandidateUrl = '';
    let oaSource = '';
    let oaNote = '';

    // Build the item first (we need item.id for the storage path).
    const item = window.LIBRARY_METADATA.buildPaperItem(meta, null, user);
    if (items.some(it => it.id === item.id)) {
      item.id = `${item.id}-${Date.now().toString(36).slice(-4)}`;
    }

    try {
      const oa = await _unpaywallLookup(doi);
      if (oa && oa.bestPdfUrl) {
        pdfCandidateUrl = oa.bestPdfUrl;
        oaSource = oa.source || '';
        pdfBlob = await _fetchPdfBlob(oa.bestPdfUrl);
        if (pdfBlob) {
          try {
            pdfInfo = await uploadPdf(item.id, pdfBlob);
            oaNote = `Auto-fetched OA PDF from ${oa.source || 'repository'} via Unpaywall.`;
          } catch (e) {
            console.warn('[library-upload] OA PDF upload failed:', e.message);
            oaNote = `Found OA PDF at ${oa.bestPdfUrl} but the upload to Storage failed: ${e.message}`;
          }
        } else {
          oaNote = `OA PDF at ${oa.bestPdfUrl} (host: ${oa.source || 'unknown'}) — CORS blocked auto-fetch. Open manually + upload via the library upload modal.`;
        }
      }
    } catch (e) {
      console.warn('[library-upload] unpaywall lookup error:', e.message);
    }

    // Stamp the PDF (or candidate URL) onto the item before save.
    if (pdfInfo) {
      item.meta.library.pdf = {
        storage_path: pdfInfo.storage_path,
        hash: pdfInfo.hash,
        filename_safe: `${item.id}.pdf`,
        size_bytes: pdfInfo.size_bytes,
        uploaded_at: pdfInfo.uploaded_at,
        uploaded_by: pdfInfo.uploaded_by,
        source: 'unpaywall_auto',
      };
    } else if (pdfCandidateUrl) {
      item.meta.library.pdf_candidate_url = pdfCandidateUrl;
      item.meta.library.pdf_candidate_source = oaSource;
      item.meta.library.pdf_candidate_note = oaNote;
    }

    items.push(item);
    await api.save('items.json', { items });
    // V3.93 — fire-and-forget background ref parse so the new paper's
    // citation panel is pre-populated next time it's opened.
    if (pdfBlob) parseAndCacheRefs(item.id, pdfBlob).catch(e =>
      console.warn('[library-upload] background ref parse failed:', e));
    // V3.112 — fire-and-forget Semantic Scholar enrichment in the
    // background. Adds structured references (with DOIs per ref),
    // cited_by, abstract (when CrossRef missed it), and tldr.
    enrichItemFromSemanticScholar(item.id).catch(e =>
      console.warn('[library-upload] SS enrichment failed:', e));
    return { item, alreadyExisted: false, pdfInfo, pdfCandidateUrl, oaSource };
  }

  /** V3.93 — extract text from a PDF blob, run the references parser,
   *  and stamp the parsed array onto the matching item in items.json
   *  under meta.library.references. Best-effort: silently no-ops when
   *  PDF_VIEWER or PAPER_CITATIONS isn't loaded (e.g., on pages that
   *  don't include those scripts). Used by both fromDoi and the manual
   *  file-upload path in library.js. */
  async function parseAndCacheRefs(paperId, pdfBlob) {
    if (!paperId || !pdfBlob) return;
    if (!window.PDF_VIEWER || !window.PDF_VIEWER.extractTextItemsFromPdf) {
      console.info('[library-upload] PDF_VIEWER unavailable; skipping import-time ref parse');
      return;
    }
    if (!window.PAPER_CITATIONS || !window.PAPER_CITATIONS.parseRefsFromAllItems) {
      console.info('[library-upload] PAPER_CITATIONS unavailable; skipping import-time ref parse');
      return;
    }
    let textItems;
    try {
      textItems = await window.PDF_VIEWER.extractTextItemsFromPdf(pdfBlob);
    } catch (e) {
      console.warn('[library-upload] PDF text extraction failed:', e.message || e);
      return;
    }
    const refs = window.PAPER_CITATIONS.parseRefsFromAllItems(textItems);
    if (!refs || !refs.length) {
      console.info(`[library-upload] no refs parsed for ${paperId}`);
      return;
    }
    // V3.206 — write into items/{paperId}/details/main via LIBRARY_EXTRAS.
    // The parallel SS enrichment writes to the same subdoc; we still
    // need to read first to honor the "SS wins" rule.
    if (!window.LIBRARY_EXTRAS) {
      console.warn('[library-upload] LIBRARY_EXTRAS not loaded; skipping ref cache');
      return;
    }
    try {
      const existing = await window.LIBRARY_EXTRAS.load(paperId);
      if (existing && existing.references_source === 'semantic_scholar') {
        console.info(`[library-upload] skipping regex refs for ${paperId} — SS already populated`);
        return;
      }
      await window.LIBRARY_EXTRAS.savePatch(paperId, {
        references: refs,
        references_parsed_at: new Date().toISOString().slice(0, 10),
        references_parser_version: 'v3.93',
        references_source: 'pdf_regex',
      });
      console.info(`[library-upload] cached ${refs.length} refs for ${paperId} at import time`);
    } catch (e) {
      console.warn('[library-upload] failed to persist parsed refs:', e.message || e);
    }
  }

  /** V3.112 — Background Semantic Scholar enrichment.
   *  Runs after import-time save: fetches the paper's full SS payload
   *  (references + citations + abstract + tldr) and persists into
   *  items.json under meta.library. SS references override the V3.93
   *  regex-parsed list when present (richer, includes per-ref DOIs).
   *  Cited-by data is always SS-only.
   *
   *  Best-effort and idempotent: silently no-ops when PAPER_SS isn't
   *  loaded, when the item has no DOI/arXiv/PMID, or when SS returns
   *  4xx/5xx for this paper. Logs to console so failures are visible
   *  in the import flow.
   */
  async function enrichItemFromSemanticScholar(paperId) {
    if (!paperId) return;
    if (!window.PAPER_SS) {
      console.info('[library-upload] PAPER_SS unavailable; skipping SS enrichment');
      return;
    }
    if (!window.LIBRARY_EXTRAS) {
      console.warn('[library-upload] LIBRARY_EXTRAS not loaded; skipping SS enrichment');
      return;
    }
    // V3.206 — heavy enrichment fields land in items/{id}/details/main.
    // We still need the main item's identifiers (doi/arxiv/pmid) to ask
    // Semantic Scholar which paper to fetch, so do one main-doc read
    // via the route adapter.
    let data;
    try {
      data = await api.load('library/papers.json');
    } catch (e) {
      console.warn('[library-upload] SS enrichment: library/papers.json load failed:', e.message || e);
      return;
    }
    const itemsArr = (data && data.papers) || [];
    const main = itemsArr.find(it => it.id === paperId);
    if (!main) return;
    const lib = (main.meta && main.meta.library) || {};
    const idSpec = window.PAPER_SS.lookupId(lib);
    if (!idSpec) {
      console.info(`[library-upload] SS skip ${paperId}: no DOI / arXiv / PMID`);
      return;
    }
    let payload;
    try {
      payload = await window.PAPER_SS.fetchPaperEnrichment(idSpec);
    } catch (e) {
      console.warn(`[library-upload] SS fetch failed for ${paperId}:`, e.message || e);
      return;
    }
    if (!payload) return;

    // Existing extras (so we honor "abstract: don't overwrite if already
    // set" and don't clobber a richer previous fetch).
    let existing = {};
    try { existing = await window.LIBRARY_EXTRAS.load(paperId, main); } catch (_) { existing = {}; }

    const patch = {
      semantic_scholar_id: payload.paperId || existing.semantic_scholar_id || '',
      semantic_scholar_fetched_at: new Date().toISOString().slice(0, 10),
    };
    if (!existing.abstract && payload.abstract) patch.abstract = payload.abstract;
    if (payload.tldr && payload.tldr.text) patch.tldr = payload.tldr.text;

    const ssRefs = window.PAPER_SS.normalizeReferences(payload.references || []);
    if (ssRefs.length) {
      patch.references = ssRefs;
      patch.references_source = 'semantic_scholar';
      patch.references_parsed_at = new Date().toISOString().slice(0, 10);
    }
    const citedBy = window.PAPER_SS.normalizeCitations(payload.citations || []);
    patch.cited_by = citedBy;
    patch.cited_by_fetched_at = new Date().toISOString().slice(0, 10);

    try {
      await window.LIBRARY_EXTRAS.savePatch(paperId, patch);
      console.info(`[library-upload] SS enriched ${paperId}: ${ssRefs.length} refs, ${citedBy.length} cited-by`);
    } catch (e) {
      console.warn('[library-upload] failed to persist SS enrichment:', e.message || e);
    }
  }

  window.LIBRARY_UPLOAD = {
    sha256Hex,
    findDuplicate,
    uploadPdf,
    downloadUrl,
    fromDoi,
    parseAndCacheRefs,
    enrichItemFromSemanticScholar,
    // V3.310 — exported for library-refresh.js (fullRefresh) and the
    // missing-PDF queue so the Unpaywall pipeline isn't duplicated.
    unpaywallLookup: _unpaywallLookup,
    fetchPdfBlob: _fetchPdfBlob,
  };
})();
