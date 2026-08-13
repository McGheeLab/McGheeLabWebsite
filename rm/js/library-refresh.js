/* library-refresh.js — V3.310 one-action "refresh everything from the DOI".
 *
 * fullRefresh(item, {doi, interactive}) chains the whole repair pipeline:
 *   1. identifier lookup — explicit DOI param → stored DOI → PMID → arXiv;
 *      when the item has NO identifier at all, fall back to a TITLE search
 *      (confirmed by the user when interactive) which can even DISCOVER
 *      the DOI for an identifier-less item;
 *   2. merge biblio fields (fetched wins; tags / folders / labels / star /
 *      pdf / id / citation_key preserved) → ONE targeted items/{id}.set
 *      with serverTimestamp updatedAt (V3.309 write pattern);
 *   3. no PDF yet? → Unpaywall OA attempt via LIBRARY_UPLOAD's exported
 *      unpaywallLookup/fetchPdfBlob; a CORS-blocked hit stamps
 *      pdf_candidate_url instead;
 *   4. Semantic Scholar re-enrichment (references / cited_by / abstract);
 *   5. import-time ref parse when a PDF blob is in hand and SS came back
 *      empty (LIBRARY_UPLOAD.parseAndCacheRefs honors "SS wins");
 *   6. summary of what changed.
 *
 * Public API (window.LIBRARY_REFRESH):
 *   fullRefresh(item, {doi, interactive, onUpdated})
 *     → Promise<{item, changedFields, pdfFetched, pdfCandidate, summary}>
 */

(function () {
  const BIBLIO_FIELDS = ['year', 'journal', 'journal_iso', 'issn', 'volume',
    'issue', 'pages', 'doi', 'pmid', 'arxiv_id', 'url'];

  /* V3.496 — fill-only author-identity enrichment (ORCID / affiliation),
   * matched by family + first initial; never overwrites a present value or a
   * name. Used both to carry forward ids the stored authors already had and
   * to absorb ids from the fresh lookup. */
  function _matchFreshAuthor(fresh, a) {
    const fam = String(a.family || '').trim().toLowerCase();
    if (!fam) return null;
    const gi = String(a.given || '').trim().charAt(0).toLowerCase();
    return (fresh || []).find(f => {
      if (String(f.family || '').trim().toLowerCase() !== fam) return false;
      const fgi = String(f.given || '').trim().charAt(0).toLowerCase();
      return !gi || !fgi || gi === fgi;
    }) || null;
  }
  function _enrichAuthorIds(existing, fresh) {
    let filled = false;
    (existing || []).forEach(a => {
      const m = _matchFreshAuthor(fresh, a);
      if (!m) return;
      if (m.orcid && !a.orcid) { a.orcid = m.orcid; filled = true; }
      if (m.affiliation && !a.affiliation) { a.affiliation = m.affiliation; filled = true; }
    });
    return filled;
  }

  function _toast(kind, msg) {
    if (window.TOAST && window.TOAST[kind]) window.TOAST[kind](msg);
    else console.log('[library-refresh]', msg);
  }

  function _confirmTitleHit(item, meta) {
    const authors = (meta.authors || []).slice(0, 3).map(a => a.family).filter(Boolean).join(', ')
      + ((meta.authors || []).length > 3 ? ' et al.' : '');
    return window.confirm(
      `"${item.title}" has no DOI/PMID/arXiv id — searched CrossRef by title instead.\n\n` +
      `Best match:\n${meta.title || '(untitled)'}\n` +
      `${[authors, meta.year, meta.journal].filter(Boolean).join(' · ')}\n\n` +
      `Refresh this paper from that record?`
    );
  }

  async function _lookupForItem(item, optDoi, interactive) {
    const lib = (item.meta && item.meta.library) || {};
    if (optDoi) return { meta: await LIBRARY_METADATA.lookup({ doi: optDoi }), via: 'doi' };
    if (lib.doi) return { meta: await LIBRARY_METADATA.lookup({ doi: lib.doi }), via: 'doi' };
    if (lib.pmid) return { meta: await LIBRARY_METADATA.lookup({ pmid: lib.pmid }), via: 'pmid' };
    if (lib.arxiv_id) return { meta: await LIBRARY_METADATA.lookup({ arxiv_id: lib.arxiv_id }), via: 'arxiv' };
    // Title-search backstop — a titled-but-identifier-less item can still
    // self-heal (and discover its DOI). Fuzzy, so confirm when interactive.
    const title = (item.title || '').trim();
    if (!title || title.length < 8) return { meta: null, via: 'none' };
    const hit = await LIBRARY_METADATA.lookup({ title: title.slice(0, 200) });
    if (!hit || hit.error) return { meta: null, via: 'title' };
    if (interactive && !_confirmTitleHit(item, hit)) return { meta: null, via: 'title-declined' };
    return { meta: hit, via: 'title' };
  }

  async function fullRefresh(item, opts) {
    const o = opts || {};
    if (!item || !item.id) throw new Error('fullRefresh: item required');
    if (!window.LIBRARY_METADATA) throw new Error('library-metadata.js not loaded');
    if (typeof firebase === 'undefined' || !firebase.auth || !firebase.auth().currentUser) {
      throw new Error('Sign in to refresh paper metadata.');
    }

    const out = { item, changedFields: [], pdfFetched: false, pdfCandidate: '', summary: '' };

    // ---- 1+2. metadata --------------------------------------------------
    const { meta, via } = await _lookupForItem(item, o.doi, o.interactive !== false);
    if (meta && !meta.error) {
      const updated = JSON.parse(JSON.stringify(item));
      delete updated.updatedAt;
      updated.meta = updated.meta || {};
      updated.meta.library = updated.meta.library || {};
      const lib = updated.meta.library;

      if (meta.title && meta.title !== updated.title) {
        updated.title = meta.title;
        out.changedFields.push('title');
      }
      if (Array.isArray(meta.authors) && meta.authors.length) {
        // V3.496 — carry forward any ORCID/affiliation the stored authors
        // already had so a refresh from a sparse source never drops captured
        // ids; the fresh CrossRef record supplies new ones.
        _enrichAuthorIds(meta.authors, lib.authors);
        const before = JSON.stringify(lib.authors || []);
        if (before !== JSON.stringify(meta.authors)) {
          lib.authors = meta.authors;
          out.changedFields.push('authors');
        }
      }
      for (const f of BIBLIO_FIELDS) {
        const v = meta[f];
        if (v == null || v === '') continue;
        if (lib[f] !== v) {
          lib[f] = v;
          out.changedFields.push(f);
        }
      }
      if (lib.source === 'manual') lib.source = meta.source || 'manual-edited';
      const first = (lib.authors && lib.authors[0]) || {};
      updated.meta.lead_author = first.family
        ? [first.given, first.family].filter(Boolean).join(' ') : updated.meta.lead_author || '';
      updated.meta.target_journal = lib.journal || updated.meta.target_journal || '';
      updated.updated_at = new Date().toISOString().slice(0, 10);

      if (out.changedFields.length) {
        const payload = Object.assign({}, updated, {
          updatedAt: firebase.firestore.FieldValue.serverTimestamp(),
        });
        await firebase.firestore().collection('items').doc(updated.id).set(payload);
      }
      out.item = updated;
      item = updated;
      // Abstract is heavy → extras subdoc, only when we have one and the
      // subdoc doesn't (SS enrichment below usually wins anyway).
      if (meta.abstract && window.LIBRARY_EXTRAS) {
        try {
          const extras = await LIBRARY_EXTRAS.load(item.id, item);
          if (!extras.abstract) await LIBRARY_EXTRAS.savePatch(item.id, { abstract: meta.abstract });
        } catch (_) { /* best-effort */ }
      }
    } else if (via === 'title-declined') {
      out.summary = 'Refresh cancelled (title match declined).';
      return out;
    }

    const lib = (item.meta && item.meta.library) || {};

    // ---- 3. OA PDF attempt (V3.498 server-side first) ------------------
    let pdfBlob = null;
    const _hasIdForPdf = !!(lib.doi || lib.pmid || lib.arxiv_id || lib.url);
    // Server-side fetcher (no CORS; Unpaywall all-locations + arXiv + Europe
    // PMC + Semantic Scholar + the publisher's citation_pdf_url). It uploads to
    // Storage itself, so on success we only stamp meta.library.pdf.
    let _serverTriedCleanly = false;   // server returned a definitive answer
    if (!lib.pdf && _hasIdForPdf && window.LIBRARY_UPLOAD && LIBRARY_UPLOAD.serverFetchPdf) {
      try {
        const sfp = await LIBRARY_UPLOAD.serverFetchPdf(item);
        _serverTriedCleanly = true;
        if (sfp && sfp.ok && sfp.storage_path) {
          const me = (firebase.auth && firebase.auth().currentUser) || null;
          const updated = JSON.parse(JSON.stringify(item));
          delete updated.updatedAt;
          updated.meta.library.pdf = {
            storage_path: sfp.storage_path,
            hash: sfp.hash,
            filename_safe: `${item.id}.pdf`,
            size_bytes: sfp.size_bytes,
            uploaded_at: new Date().toISOString().slice(0, 10),
            uploaded_by: (me && me.email) || '',
            source: sfp.source ? `oa_${sfp.source}` : 'oa_auto',
          };
          delete updated.meta.library.pdf_status;
          delete updated.meta.library.pdf_candidate_url;
          updated.updated_at = new Date().toISOString().slice(0, 10);
          await firebase.firestore().collection('items').doc(item.id).set(
            Object.assign({}, updated, { updatedAt: firebase.firestore.FieldValue.serverTimestamp() }));
          if (typeof api !== 'undefined' && api.invalidate) {
            api.invalidate('items.json');
            api.invalidate('library/papers.json');
          }
          out.item = updated;
          item = updated;
          out.pdfFetched = true;
        }
      } catch (e) {
        console.warn('[library-refresh] serverFetchPdf failed; trying client Unpaywall:', e.message || e);
      }
    }
    // Client Unpaywall fallback — ONLY when the server didn't give a clean
    // answer (function unreachable / not loaded). A clean {ok:false} already
    // tried every OA location server-side, so re-querying is redundant and
    // would mis-attribute the failure reason.
    if (!out.pdfFetched && !_serverTriedCleanly && !lib.pdf && lib.doi && window.LIBRARY_UPLOAD && LIBRARY_UPLOAD.unpaywallLookup) {
      try {
        const oa = await LIBRARY_UPLOAD.unpaywallLookup(lib.doi);
        if (oa && oa.bestPdfUrl) {
          pdfBlob = await LIBRARY_UPLOAD.fetchPdfBlob(oa.bestPdfUrl);
          if (pdfBlob) {
            const pdfInfo = await LIBRARY_UPLOAD.uploadPdf(item.id, pdfBlob);
            const updated = JSON.parse(JSON.stringify(item));
            delete updated.updatedAt;
            updated.meta.library.pdf = {
              storage_path: pdfInfo.storage_path,
              hash: pdfInfo.hash,
              filename_safe: `${item.id}.pdf`,
              size_bytes: pdfInfo.size_bytes,
              uploaded_at: pdfInfo.uploaded_at,
              uploaded_by: pdfInfo.uploaded_by,
              source: 'unpaywall_auto',
            };
            updated.updated_at = new Date().toISOString().slice(0, 10);
            await firebase.firestore().collection('items').doc(item.id).set(
              Object.assign({}, updated, { updatedAt: firebase.firestore.FieldValue.serverTimestamp() }));
            out.item = updated;
            item = updated;
            out.pdfFetched = true;
          } else {
            // CORS-blocked — stamp the candidate URL for the manual path
            // (and the missing-PDF queue).
            out.pdfCandidate = oa.bestPdfUrl;
            await firebase.firestore().collection('items').doc(item.id).set({
              meta: { library: {
                pdf_candidate_url: oa.bestPdfUrl,
                pdf_candidate_source: oa.source || '',
                pdf_candidate_note: 'Found via Unpaywall during fullRefresh; auto-fetch was CORS-blocked.',
              } },
              updatedAt: firebase.firestore.FieldValue.serverTimestamp(),
            }, { merge: true });
          }
        }
      } catch (e) {
        console.warn('[library-refresh] OA PDF attempt failed:', e.message || e);
      }
    }

    // ---- 4. Semantic Scholar enrichment ---------------------------------
    if (window.LIBRARY_UPLOAD && LIBRARY_UPLOAD.enrichItemFromSemanticScholar) {
      try { await LIBRARY_UPLOAD.enrichItemFromSemanticScholar(item.id); }
      catch (e) { console.warn('[library-refresh] SS enrichment failed:', e.message || e); }
    }

    // ---- 5. regex ref-parse fallback ------------------------------------
    // parseAndCacheRefs already skips itself when SS populated references.
    if (pdfBlob && window.LIBRARY_UPLOAD && LIBRARY_UPLOAD.parseAndCacheRefs) {
      try { await LIBRARY_UPLOAD.parseAndCacheRefs(item.id, pdfBlob); }
      catch (e) { console.warn('[library-refresh] ref parse failed:', e.message || e); }
    }

    // ---- 6. summary ------------------------------------------------------
    const bits = [];
    bits.push(out.changedFields.length
      ? `metadata: ${out.changedFields.length} field(s) updated (via ${via})`
      : 'metadata: already current');
    if (out.pdfFetched) bits.push('OA PDF fetched via Unpaywall');
    else if (out.pdfCandidate) bits.push('OA PDF found but CORS-blocked — candidate URL saved');
    bits.push('references re-enriched');
    out.summary = bits.join(' · ');
    _toast('success', `Refreshed "${(out.item && out.item.title) || item.id}" — ${out.summary}`);
    if (o.onUpdated) { try { o.onUpdated(out.item); } catch (_) { /* caller's problem */ } }
    return out;
  }

  window.LIBRARY_REFRESH = { fullRefresh };
})();
