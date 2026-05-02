/* library-sync.js — phase 6c. Reads `pending_captures` from Firestore,
 * fills in arXiv / PubMed metadata via the /api/library/lookup proxy
 * (the extension can't call it because of CORS), materializes a paper
 * item using the same buildPaperItem helper as the manual-upload path,
 * dedupes against the existing items list, populates a paper_index/{hash}
 * lookup row so the extension's 6d badge can flip to ✓, and finally
 * deletes the queue doc.
 *
 * Caller is responsible for persisting items.json after this returns —
 * we only mutate the in-memory list. That keeps a single network write
 * for the whole batch.
 *
 * Public API (window.LIBRARY_SYNC):
 *   syncPendingCaptures(items) → Promise<{
 *       merged:  [{ paper_id, title, hash }],
 *       skipped: [{ paper_id, reason }],
 *       errors:  [{ paper_id, error }],
 *   }>
 */

(function () {
  function _firestore() {
    if (typeof firebase === 'undefined' || !firebase.firestore) return null;
    if (!firebase.apps || !firebase.apps.length) return null;
    return firebase.firestore();
  }

  function _authedUser() {
    if (typeof firebase === 'undefined' || !firebase.auth) return null;
    return firebase.auth().currentUser || null;
  }

  function _isMetadataSparse(meta) {
    if (!meta) return true;
    if (!meta.title || !String(meta.title).trim()) return true;
    if (!Array.isArray(meta.authors) || !meta.authors.length) return true;
    if (!meta.year) return true;
    return false;
  }

  async function _enrichMetadata(queue) {
    // Only call /api/library/lookup if the queue's stored metadata is too
    // sparse to render a useful library row. The extension's CrossRef
    // path already populates rich metadata for DOI papers; arXiv-only and
    // PubMed-only captures land here with just identifiers.
    let meta = Object.assign({}, queue.metadata || {});
    if (!_isMetadataSparse(meta)) return meta;

    const det = queue.detection || {};
    let params = null;
    if (det.doi) params = { doi: det.doi };
    else if (det.arxiv_id) params = { arxiv_id: det.arxiv_id };
    else if (det.pmid) params = { pmid: det.pmid };
    if (!params) return meta;

    try {
      const fetched = await LIBRARY_METADATA.lookup(params);
      if (fetched && !fetched.error) {
        // Existing fields win — keep whatever the extension already set
        // (e.g. abstract, source) and let the proxy fill the gaps.
        meta = Object.assign({}, fetched, meta);
        // …but force the proxy's title/authors/year/journal in if our copy
        // was sparse, since that was the whole point of looking up.
        if (!queue.metadata || !queue.metadata.title)   meta.title   = fetched.title || meta.title;
        if (!queue.metadata || !queue.metadata.authors || !queue.metadata.authors.length) meta.authors = fetched.authors || meta.authors;
        if (!queue.metadata || !queue.metadata.year)    meta.year    = fetched.year || meta.year;
        if (!queue.metadata || !queue.metadata.journal) meta.journal = fetched.journal || meta.journal;
      }
    } catch (e) {
      console.warn('[library-sync] lookup failed for', queue.paper_id, ':', e.message);
    }
    return meta;
  }

  function _buildPdfInfo(queue) {
    const pdf = queue.pdf;
    // Search-add path writes pdf: null when no PDF is attached. Return
    // null so buildPaperItem produces a paper item with `pdf: null`.
    if (!pdf || !pdf.storage_path) return null;
    return {
      storage_path: pdf.storage_path,
      hash: pdf.hash || '',
      full_hash: pdf.full_hash || '',
      size_bytes: pdf.size_bytes || 0,
      uploaded_at: (queue.captured_at_iso || '').slice(0, 10) || new Date().toISOString().slice(0, 10),
      uploaded_by: queue.captured_by_email || queue.captured_by_uid || '',
    };
  }

  function _materializeItem(queue, enrichedMeta) {
    const pdfInfo = _buildPdfInfo(queue);   // null for metadata-only entries
    const item = LIBRARY_METADATA.buildPaperItem(enrichedMeta, pdfInfo, null);

    // Force the id to match the storage path the extension picked. This
    // means that if the extension and the dashboard ever disagree on the
    // citation-key slug, the storage path stays the source of truth and
    // the PDF link won't break.
    item.id = queue.paper_id;
    if (!item.title || item.title === 'Untitled') {
      item.title = (queue.detection && queue.detection.title) || queue.paper_id;
    }

    // Stash full_hash so future dedupe can match either short or full.
    if (pdfInfo && item.meta.library && item.meta.library.pdf) {
      item.meta.library.pdf.full_hash = pdfInfo.full_hash;
    }

    // Provenance for audit / debug.
    item.meta.library.captured_by = queue.captured_by_email || queue.captured_by_uid || '';
    item.meta.library.captured_at_iso = queue.captured_at_iso || '';
    item.meta.library.source_url = queue.source_url || '';
    item.meta.library.captured_via = (queue.detection && queue.detection.source) || '';
    if (queue.detection) {
      if (queue.detection.arxiv_id) item.meta.library.arxiv_id = queue.detection.arxiv_id;
      if (queue.detection.pmid)     item.meta.library.pmid     = queue.detection.pmid;
      if (queue.detection.doi && !item.meta.library.doi) item.meta.library.doi = queue.detection.doi;
    }

    return item;
  }

  function _findExistingDup(queue, items) {
    const pdf = queue.pdf || {};
    // 1) full_hash / short_hash dedupe (catches re-captures under different ids)
    if (pdf.full_hash || pdf.hash) {
      const dup = LIBRARY_UPLOAD.findDuplicate(pdf.full_hash, items)
               || LIBRARY_UPLOAD.findDuplicate(pdf.hash, items);
      if (dup) return { dup, by: 'hash' };
    }
    // 2) id collision (benign re-capture of the same paper)
    const idHit = items.find(it => it.id === queue.paper_id);
    if (idHit) return { dup: idHit, by: 'id' };
    // 3) identifier dedupe — important for metadata-only (no-PDF) entries
    //    so the search-add path doesn't create dupes of papers already
    //    in the library under a different slug.
    const det = queue.detection || {};
    const meta = queue.metadata || {};
    const wantedDoi   = String(det.doi   || meta.doi   || '').toLowerCase();
    const wantedArxiv = String(det.arxiv_id || meta.arxiv_id || '').toLowerCase();
    const wantedPmid  = String(det.pmid  || meta.pmid  || '').toLowerCase();
    if (wantedDoi || wantedArxiv || wantedPmid) {
      for (const it of items) {
        const lib = it && it.meta && it.meta.library;
        if (!lib) continue;
        if (wantedDoi   && String(lib.doi || '').toLowerCase()   === wantedDoi)   return { dup: it, by: 'doi' };
        if (wantedArxiv && String(lib.arxiv_id || '').toLowerCase() === wantedArxiv) return { dup: it, by: 'arxiv' };
        if (wantedPmid  && String(lib.pmid || '').toLowerCase()  === wantedPmid)  return { dup: it, by: 'pmid' };
      }
    }
    return null;
  }

  // Slug an identifier into a Firestore-doc-id-safe form. Mirrors the
  // _idKey() in extension/background.js — these two MUST stay in sync,
  // otherwise badge lookups will miss synced entries.
  function _indexKey(kind, value) {
    const v = String(value || '').toLowerCase().replace(/[^a-z0-9]+/g, '_').replace(/^_+|_+$/g, '');
    return `${kind}_${v}`;
  }

  async function _writePaperIndices(db, queue, item) {
    const pdf = queue.pdf || {};
    const det = queue.detection || {};
    const lib = (item && item.meta && item.meta.library) || {};
    const writes = [];

    function push(kind, value) {
      if (!value) return;
      const docId = _indexKey(kind, value);
      const payload = {
        paper_id: queue.paper_id,
        kind,
        value: String(value).toLowerCase(),
        full_hash: pdf.full_hash || '',
        storage_path: pdf.storage_path || '',
        indexed_at: firebase.firestore.FieldValue.serverTimestamp(),
      };
      writes.push(
        db.collection('paper_index').doc(docId).set(payload, { merge: true })
      );
    }

    if (pdf.hash) push('hash', pdf.hash);
    push('doi',   det.doi   || lib.doi);
    push('arxiv', det.arxiv_id || lib.arxiv_id);
    push('pmid',  det.pmid  || lib.pmid);

    if (writes.length === 0) return;
    try {
      await Promise.all(writes);
    } catch (e) {
      console.warn('[library-sync] paper_index write failed for', queue.paper_id, ':', e.message);
    }
  }

  // Phase E: cap each sync run at SYNC_BATCH so a giant queue (e.g. on first
  // sign-in for a power user) doesn't block the page. Each successful merge
  // deletes its queue doc, so the next sync trigger (refocus or button click)
  // drains the next batch. The result gets a `more` hint when the cap is hit.
  const SYNC_BATCH = 50;

  async function syncPendingCaptures(items) {
    const out = { merged: [], skipped: [], errors: [], more: false };
    const db = _firestore();
    if (!db) return out;
    if (!_authedUser()) return out;

    let snap;
    try {
      snap = await db.collection('pending_captures').limit(SYNC_BATCH).get();
    } catch (e) {
      console.warn('[library-sync] pending_captures read failed:', e.message);
      return out;
    }
    if (snap.empty) return out;
    out.more = snap.size === SYNC_BATCH;

    for (const doc of snap.docs) {
      const queue = doc.data();
      const paperId = (queue && queue.paper_id) || doc.id;
      try {
        const dup = _findExistingDup(queue, items);
        if (dup) {
          // Already merged on a previous load — clean up the stale queue
          // doc so we don't keep retrying on every page open.
          out.skipped.push({ paper_id: paperId, reason: `duplicate (${dup.by})` });
          // Re-stamp the index so the badge keeps working even if a prior
          // sync only wrote partial entries. Pass the existing matched
          // item so its identifiers (not the queue's) seed the index.
          await _writePaperIndices(db, queue, dup.dup);
          try { await doc.ref.delete(); } catch (_) {}
          continue;
        }

        const meta = await _enrichMetadata(queue);
        const item = _materializeItem(queue, meta);
        items.push(item);
        out.merged.push({
          paper_id: item.id,
          title: item.title,
          hash: (queue.pdf && queue.pdf.hash) || '',
        });

        await _writePaperIndices(db, queue, item);
        try { await doc.ref.delete(); } catch (e) {
          // The merge already landed in items; a leftover queue doc just
          // means we'll skip-by-id on the next sync. Not fatal.
          console.warn('[library-sync] queue cleanup failed for', paperId, ':', e.message);
        }
      } catch (e) {
        console.error('[library-sync] failed to materialize', paperId, ':', e);
        out.errors.push({ paper_id: paperId, error: e.message || String(e) });
      }
    }

    return out;
  }

  window.LIBRARY_SYNC = {
    syncPendingCaptures,
    // Exposed for offline tests.
    _internals: { _isMetadataSparse, _materializeItem, _buildPdfInfo, _findExistingDup },
  };
})();
