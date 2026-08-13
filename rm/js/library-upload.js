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

  // ---- V3.497 identity matching (dedupe against PDF-less entries) ----------
  // `findDuplicate` above only matches on PDF *content* hash, so it is blind to
  // a metadata-only entry (no pdf). These helpers match a paper's *identity*
  // (DOI / PMID / arXiv / title) so an incoming PDF can be attached to the
  // existing row instead of spawning a duplicate.

  function _normDoi(doi) {
    return String(doi || '').trim().toLowerCase()
      .replace(/^https?:\/\/(dx\.)?doi\.org\//, '')
      .replace(/^doi:\s*/, '')
      // Trailing junk from copy/paste: punctuation, brackets, quotes, angle
      // brackets, and a stray slash (DOIs never end in one). Only the tail is
      // stripped, so the internal '/' of the suffix is preserved.
      .replace(/[.,;:)\]>"'<\/\s]+$/, '');
  }
  function _normArxiv(id) {
    return String(id || '').trim().toLowerCase()
      .replace(/^https?:\/\/(www\.)?arxiv\.org\/(abs|pdf)\//, '')
      .replace(/^arxiv:\s*/, '')
      .replace(/\.pdf$/, '')
      .replace(/v\d+$/, '');
  }
  function _normPmid(id) {
    return String(id || '').replace(/^\s*pmid:\s*/i, '').replace(/\D/g, '');
  }
  function _normTitle(t) {
    return String(t || '').toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim();
  }
  function _firstAuthorFamily(authors) {
    const a = Array.isArray(authors) && authors[0];
    return a ? String(a.family || '').trim().toLowerCase() : '';
  }

  /** Find the existing library entry that represents the same paper as `meta`.
   *  Priority: DOI → PMID → arXiv (exact after normalization → matchedBy
   *  'doi'|'pmid'|'arxiv', safe to auto-merge) then normalized title (+ year
   *  when both sides have one → matchedBy 'title', fuzzy — caller should
   *  confirm before merging). Only `is_library_entry` rows are considered.
   *  Returns { item, matchedBy } or null.
   *
   *  `skipId` lets a refresh/edit exclude the item being edited from its own
   *  self-match. */
  function findExistingEntry(meta, items, skipId) {
    if (!meta || !Array.isArray(items)) return null;
    const doi = _normDoi(meta.doi);
    const pmid = _normPmid(meta.pmid);
    const arxiv = _normArxiv(meta.arxiv_id);
    const title = _normTitle(meta.title);
    const year = String(meta.year || '').trim();
    const metaFam = _firstAuthorFamily(meta.authors);

    const entries = items.filter(it => {
      const lib = it && it.meta && it.meta.library;
      return lib && lib.is_library_entry && it.id !== skipId;
    });

    // 1. Identifier matches — exact, safe to auto-merge.
    for (const it of entries) {
      const lib = it.meta.library;
      if (doi && _normDoi(lib.doi) === doi) return { item: it, matchedBy: 'doi' };
      if (pmid && _normPmid(lib.pmid) === pmid) return { item: it, matchedBy: 'pmid' };
      if (arxiv && _normArxiv(lib.arxiv_id) === arxiv) return { item: it, matchedBy: 'arxiv' };
    }
    // 2. Title match — fuzzy, so require corroboration (same year when both
    // have one AND same first-author family when both have one) to keep generic
    // titles ("Editorial", "Corrigendum") from colliding across papers. Still
    // returned as matchedBy:'title' so the caller confirms before merging.
    if (title && title.length >= 8) {
      for (const it of entries) {
        const lib = it.meta.library;
        if (_normTitle(it.title) !== title) continue;
        const iy = String(lib.year || '').trim();
        if (year && iy && year !== iy) continue;                 // different year → not the same paper
        const itFam = _firstAuthorFamily(lib.authors);
        if (metaFam && itFam && metaFam !== itFam) continue;      // different first author → not the same paper
        return { item: it, matchedBy: 'title' };
      }
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

  // V3.498 — server-side OA PDF fetch. The `fetchPaperPdf` Cloud Function has
  // no CORS limits, so it can grab PDFs the browser can't (Unpaywall all
  // locations + arXiv + Europe PMC + Semantic Scholar + the publisher's
  // citation_pdf_url) and upload them straight to papers/{id}/. Returns the
  // same {storage_path, hash, size_bytes, source} shape uploadPdf() returns on
  // success, so the caller can stamp meta.library.pdf and save exactly as for a
  // manual upload; throws on transport/auth error, returns {ok:false, error,
  // tried} when nothing was found.
  const FETCH_PDF_URL =
    'https://us-central1-mcgheelab-f56cc.cloudfunctions.net/fetchPaperPdf';
  // V3.501 — Cloud Run headless fallback (via the proxy function). Dormant
  // until the paper-pdf-fetch Cloud Run service is deployed; an unreachable
  // proxy just leaves the plain-fetch miss in place.
  const HEADLESS_PDF_URL =
    'https://us-central1-mcgheelab-f56cc.cloudfunctions.net/paperPdfFetchProxy';

  async function _postJson(url, token, body) {
    let res;
    try {
      res = await fetch(url, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` },
        body: JSON.stringify(body),
      });
    } catch (e) {
      throw new Error(`service unreachable: ${e.message || e}`);
    }
    let data = null;
    try { data = await res.json(); } catch (_) { /* leave null */ }
    if (!res.ok) throw new Error((data && data.error) || `HTTP ${res.status}`);
    return data || { ok: false, error: 'empty response' };
  }

  async function serverFetchPdf(item) {
    const user = _requireAuth();
    const lib = (item && item.meta && item.meta.library) || {};
    const token = await user.getIdToken();
    const body = {
      paperId: item.id,
      doi: lib.doi || '',
      pmid: lib.pmid || '',
      arxiv_id: lib.arxiv_id || '',
      url: lib.url || '',
      candidateUrl: lib.pdf_candidate_url || '',
    };
    // 1. Plain server-side fetch. A transport error propagates so callers can
    // run their own (client Unpaywall) fallback.
    const data = await _postJson(FETCH_PDF_URL, token, body);
    if (data && data.ok) return data;
    // 2. Cloud Run headless fallback (Phase 3) — only on a clean "no PDF found".
    try {
      const hd = await _postJson(HEADLESS_PDF_URL, token, body);
      if (hd && hd.ok) return hd;
    } catch (e) {
      console.info('[library-upload] headless PDF fallback unavailable:', e.message || e);
    }
    return data || { ok: false, error: 'no PDF found' };
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
    // V3.497 — dedupe against an existing library entry by identifier
    // (DOI/PMID/arXiv). A title-only match is intentionally ignored here: this
    // path is non-interactive (fired from a citation "Add" button) and must not
    // silently merge on a fuzzy title. The `meta` we just looked up carries the
    // DOI, so an existing row with the same DOI matches even if it was stored
    // with different casing / a trailing period than `doi`.
    const hit = findExistingEntry(meta, items);
    const dup = hit && hit.matchedBy !== 'title' ? hit.item : null;
    if (dup) {
      dup.meta = dup.meta || {};
      dup.meta.library = dup.meta.library || {};
      const dlib = dup.meta.library;
      if (dlib.pdf) {
        // Already complete — nothing to fetch or attach.
        return { item: dup, alreadyExisted: true, skipped: true, pdfInfo: null, pdfCandidateUrl: '' };
      }
      // The entry exists but has NO PDF: auto-load one from Unpaywall and
      // attach it to the EXISTING row (this is the reported "auto load a PDF
      // for a paper already in the library" feature — no duplicate created).
      let pdfInfo = null, pdfBlob = null, pdfCandidateUrl = '';
      // Prefer the server-side fetcher (V3.498 — no CORS, many OA sources; it
      // uploads to Storage itself and returns the pdf info). Fall back to the
      // client Unpaywall path only if the function is unreachable.
      try {
        const out = await serverFetchPdf(dup);
        if (out && out.ok && out.storage_path) {
          pdfInfo = { storage_path: out.storage_path, hash: out.hash, size_bytes: out.size_bytes, source: out.source };
        }
      } catch (eServer) {
        console.warn('[library-upload] fromDoi attach: serverFetchPdf failed; trying client Unpaywall:', eServer.message || eServer);
        try {
          const oa = await _unpaywallLookup(doi);
          if (oa && oa.bestPdfUrl) {
            pdfCandidateUrl = oa.bestPdfUrl;
            pdfBlob = await _fetchPdfBlob(oa.bestPdfUrl);
            if (pdfBlob) pdfInfo = await uploadPdf(dup.id, pdfBlob);
          }
        } catch (e) {
          console.warn('[library-upload] fromDoi attach: client OA fetch failed:', e.message || e);
        }
      }
      const today = new Date().toISOString().slice(0, 10);
      const me = (firebase.auth && firebase.auth().currentUser) || null;
      const patch = {
        updated_at: today,
        updatedAt: firebase.firestore.FieldValue.serverTimestamp(),
      };
      if (pdfInfo) {
        const pdfMeta = {
          storage_path: pdfInfo.storage_path,
          hash: pdfInfo.hash,
          filename_safe: `${dup.id}.pdf`,
          size_bytes: pdfInfo.size_bytes,
          uploaded_at: pdfInfo.uploaded_at || today,
          uploaded_by: pdfInfo.uploaded_by || (me && me.email) || '',
          source: pdfInfo.source ? `oa_${pdfInfo.source}` : 'unpaywall_auto',
        };
        dlib.pdf = pdfMeta;
        delete dlib.pdf_status;
        patch.meta = { library: {
          pdf: pdfMeta,
          pdf_status: firebase.firestore.FieldValue.delete(),
        } };
      } else if (pdfCandidateUrl) {
        dlib.pdf_candidate_url = pdfCandidateUrl;
        patch.meta = { library: {
          pdf_candidate_url: pdfCandidateUrl,
          pdf_candidate_note: 'Found via Unpaywall (add-by-DOI); auto-fetch was CORS-blocked — open it and upload manually.',
        } };
      }
      // Targeted merge-set (fullRefresh pattern): only touches this doc, never
      // rewrites the whole items array (grants/courses/other papers untouched).
      try {
        await firebase.firestore().collection('items').doc(dup.id).set(patch, { merge: true });
        // A direct Firestore write bypasses api.save, so the library list's
        // route caches (items.json MEDIUM, library/papers.json LONG) would keep
        // serving the stale PDF-less copy until TTL — invalidate them.
        if (typeof api !== 'undefined' && api.invalidate) {
          api.invalidate('items.json');
          api.invalidate('library/papers.json');
        }
      } catch (e) {
        // The Storage upload may have succeeded but the item was NOT updated;
        // never report success. Re-running is idempotent (uploadPdf reuses the
        // same hash-named object), so surfacing the error is safe.
        console.warn('[library-upload] fromDoi attach: save failed:', e.message || e);
        throw new Error(`Fetched a PDF but couldn't attach it to "${dup.id}": ${e.message || e}`);
      }
      if (pdfInfo && pdfBlob) parseAndCacheRefs(dup.id, pdfBlob).catch(e =>
        console.warn('[library-upload] fromDoi attach: ref parse failed:', e));
      enrichItemFromSemanticScholar(dup.id).catch(e =>
        console.warn('[library-upload] fromDoi attach: SS enrichment failed:', e));
      return { item: dup, alreadyExisted: true, attached: !!pdfInfo, pdfInfo, pdfCandidateUrl };
    }

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

    // V3.498 — try the server-side fetcher first (no CORS, many OA sources; it
    // uploads to Storage itself). Fall back to the client Unpaywall path only
    // when the function is unreachable.
    let serverTriedCleanly = false;
    try {
      const out = await serverFetchPdf(item);
      serverTriedCleanly = true;
      if (out && out.ok && out.storage_path) {
        pdfInfo = { storage_path: out.storage_path, hash: out.hash, size_bytes: out.size_bytes, source: out.source };
        oaNote = `Auto-fetched OA PDF server-side (${out.source || 'OA'}).`;
      }
    } catch (e) {
      console.warn('[library-upload] fromDoi new-item serverFetchPdf failed; trying client Unpaywall:', e.message || e);
    }
    if (!pdfInfo && !serverTriedCleanly) {
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
    }

    // Stamp the PDF (or candidate URL) onto the item before save.
    if (pdfInfo) {
      item.meta.library.pdf = {
        storage_path: pdfInfo.storage_path,
        hash: pdfInfo.hash,
        filename_safe: `${item.id}.pdf`,
        size_bytes: pdfInfo.size_bytes,
        uploaded_at: pdfInfo.uploaded_at || new Date().toISOString().slice(0, 10),
        uploaded_by: pdfInfo.uploaded_by || (user && user.email) || '',
        source: pdfInfo.source ? `oa_${pdfInfo.source}` : 'unpaywall_auto',
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
    // V3.497 — identity matcher + normalizers so every add-paper flow can
    // dedupe against PDF-less entries and attach instead of duplicating.
    findExistingEntry,
    normDoi: _normDoi,
    normArxiv: _normArxiv,
    normPmid: _normPmid,
    normTitle: _normTitle,
    uploadPdf,
    downloadUrl,
    serverFetchPdf,
    fromDoi,
    parseAndCacheRefs,
    enrichItemFromSemanticScholar,
    // V3.310 — exported for library-refresh.js (fullRefresh) and the
    // missing-PDF queue so the Unpaywall pipeline isn't duplicated.
    unpaywallLookup: _unpaywallLookup,
    fetchPdfBlob: _fetchPdfBlob,
  };
})();
