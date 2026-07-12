/* library-metadata.js — DOI / PMID / arXiv / title lookup.
 *
 * The browser can't hit CrossRef / NCBI / arXiv directly because of CORS,
 * so lookups go through a proxy. V3.308: which proxy depends on runtime —
 * local dev keeps server.py's /api/library/lookup (with a graceful fall-
 * through to the Cloud Function when the endpoint is missing, e.g. Live
 * Server); the static prod deploy calls the `libraryLookup` Cloud Function
 * with a Firebase Bearer token. First-page extraction is client-side
 * pdf.js on both runtimes (the server endpoint is only a dev fallback).
 *
 * Public API (window.LIBRARY_METADATA):
 *   lookup({doi|pmid|arxiv_id|title|refresh}) → Promise<unified metadata>
 *   extractFirstPage(blob)              → Promise<{text, doi_guess,
 *                                          arxiv_guess, title_guess}>
 *   sniffIdsFromText(text)              → {doi, arxiv_id} pulled from a text blob
 *   buildPaperItem(meta, pdfInfo, user) → minimal `paper` item ready for items.json
 *   citationKey(meta)                   → stable Better-BibTeX-style key
 *   slugify(text)                       → kebab-case slug for paper IDs
 */

(function () {
  const LOOKUP_FN_URL =
    'https://us-central1-mcgheelab-f56cc.cloudfunctions.net/libraryLookup';

  async function _lookupViaServer(params) {
    const res = await fetch('/api/library/lookup', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(params || {}),
    });
    if (!res.ok) {
      const detail = await res.text().catch(() => res.statusText);
      const err = new Error(`Lookup failed (${res.status}): ${detail}`);
      err.status = res.status;
      throw err;
    }
    return res.json();
  }

  async function _lookupViaFunction(params) {
    const user = (typeof firebase !== 'undefined' && firebase.auth
      && firebase.auth().currentUser) || null;
    if (!user) throw new Error('Sign in to look up paper metadata.');
    const idToken = await user.getIdToken();
    const res = await fetch(LOOKUP_FN_URL, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': 'Bearer ' + idToken,
      },
      body: JSON.stringify(params || {}),
    });
    if (!res.ok) {
      let detail = '';
      try { detail = (await res.json()).error || ''; } catch (_) { /* ignore */ }
      throw new Error(`Lookup failed (${res.status}): ${detail || res.statusText}`);
    }
    return res.json();
  }

  async function lookup(params) {
    const isLocal = !!(window.RM_RUNTIME && window.RM_RUNTIME.isLocal);
    if (isLocal) {
      try {
        return await _lookupViaServer(params);
      } catch (e) {
        // 400/413/502 mean server.py answered — surface its error. A fetch
        // failure or 404 means the endpoint doesn't exist here (Live Server
        // etc.) → fall through to the Cloud Function.
        if (e.status && e.status !== 404) throw e;
        return _lookupViaFunction(params);
      }
    }
    return _lookupViaFunction(params);
  }

  /* ---- first-page extraction (client-side since V3.308) ---------------- */

  // Group flat text items (sorted y asc, x asc) into visual lines.
  function _groupLines(items) {
    const lines = [];
    let cur = null;
    for (const it of items) {
      const h = it.height || 12;
      if (cur && Math.abs(it.y - cur.y) <= Math.max(2, cur.h * 0.4)) {
        cur.parts.push(it);
        cur.h = Math.max(cur.h, h);
      } else {
        cur = { y: it.y, h, parts: [it] };
        lines.push(cur);
      }
    }
    return lines;
  }

  // The title is usually the tallest text run on page 1, comfortably above
  // body size. Join consecutive lines of ~that height (multi-line titles);
  // reject runs outside a 15–300 char sanity window (journal banners,
  // decorative glyphs). Fuzzy by nature — callers must confirm before
  // applying a title-search hit.
  function _titleGuessFromLines(lines) {
    if (!lines || !lines.length) return '';
    const heights = lines.map(l => l.h).filter(h => h > 0);
    if (!heights.length) return '';
    const sorted = heights.slice().sort((a, b) => a - b);
    const median = sorted[Math.floor(sorted.length / 2)];
    const bestH = Math.max.apply(null, heights);
    if (bestH < median * 1.15) return '';
    const parts = [];
    let started = false;
    for (const l of lines) {
      const isTitle = Math.abs(l.h - bestH) <= bestH * 0.08;
      if (isTitle) {
        started = true;
        parts.push(l.parts.map(p => p.text).join(' '));
      } else if (started) {
        break; // contiguous title block ended
      }
    }
    const guess = parts.join(' ').replace(/\s+/g, ' ').trim();
    if (guess.length < 15 || guess.length > 300) return '';
    return guess;
  }

  async function _extractFirstPageClient(blob) {
    const items = await window.PDF_VIEWER.extractTextItemsFromPdf(blob, { maxPages: 1 });
    const lines = _groupLines(items);
    const text = lines
      .map(l => l.parts.map(p => p.text).join(' ').replace(/\s+/g, ' ').trim())
      .filter(Boolean)
      .join('\n');
    const ids = sniffIdsFromText(text);
    return {
      text,
      doi_guess: ids.doi,
      arxiv_guess: ids.arxiv_id,
      title_guess: _titleGuessFromLines(lines),
    };
  }

  async function _extractFirstPageServer(blob) {
    const fd = new FormData();
    fd.append('pdf', blob, 'paper.pdf');
    const res = await fetch('/api/library/extract-first-page', {
      method: 'POST',
      body: fd,
    });
    if (!res.ok) {
      const detail = await res.text().catch(() => res.statusText);
      throw new Error(`First-page extract failed (${res.status}): ${detail}`);
    }
    const out = await res.json();
    if (out && out.title_guess === undefined) out.title_guess = '';
    return out;
  }

  async function extractFirstPage(blob) {
    // Client-side pdf.js is primary on BOTH runtimes — it's what makes
    // ingest-time DOI sniffing work on the static prod deploy.
    if (window.PDF_VIEWER && window.PDF_VIEWER.extractTextItemsFromPdf) {
      try {
        return await _extractFirstPageClient(blob);
      } catch (e) {
        console.warn('[library-metadata] client first-page extract failed:',
          e.message || e);
      }
    }
    if (window.RM_RUNTIME && window.RM_RUNTIME.isLocal) {
      return _extractFirstPageServer(blob);
    }
    return { text: '', doi_guess: '', arxiv_guess: '', title_guess: '' };
  }

  function sniffIdsFromText(text) {
    const out = { doi: '', arxiv_id: '' };
    if (!text) return out;
    const doiMatch = text.match(/\b10\.\d{4,9}\/[-._;()/:A-Z0-9]+/i);
    if (doiMatch) out.doi = doiMatch[0].replace(/[.,;)]+$/, '');
    const axMatch = text.match(/\barXiv:\s*(\d{4}\.\d{4,5}(?:v\d+)?)\b/i);
    if (axMatch) out.arxiv_id = axMatch[1];
    return out;
  }

  function _safeSlug(s) {
    return String(s || '')
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, '-')
      .replace(/^-|-$/g, '')
      .slice(0, 80);
  }

  function slugify(text) {
    return _safeSlug(text);
  }

  function _shortTitleWords(title, n) {
    // Skip stop-words for citation-key short title (Better-BibTeX style).
    const STOP = new Set([
      'a', 'an', 'the', 'of', 'and', 'or', 'in', 'on', 'for', 'to', 'with',
      'from', 'by', 'as', 'at', 'is', 'are', 'be', 'this', 'that', 'using',
      'via', 'over', 'under', 'between', 'into',
    ]);
    return (title || '')
      .toLowerCase()
      .replace(/[^a-z0-9\s-]/g, ' ')
      .split(/\s+/)
      .filter(w => w && !STOP.has(w))
      .slice(0, n)
      .join('');
  }

  function citationKey(meta) {
    const firstAuthor = (meta.authors && meta.authors[0] && meta.authors[0].family) || 'anon';
    const lastNameSlug = _safeSlug(firstAuthor).replace(/-/g, '');
    const year = (meta.year || '').toString().slice(0, 4) || 'nd';
    const title = _shortTitleWords(meta.title || '', 1) || 'untitled';
    return `${lastNameSlug}${year}${title}`;
  }

  function buildPaperItem(meta, pdfInfo, user) {
    const firstAuthor = (meta.authors && meta.authors[0]) || {};
    const firstAuthorFamily = firstAuthor.family || '';
    const seedSlug = _safeSlug(
      [firstAuthorFamily, meta.year, _shortTitleWords(meta.title || '', 2)]
        .filter(Boolean)
        .join('-')
    ) || _safeSlug(meta.title || 'untitled-paper') || `paper-${Date.now()}`;
    const today = new Date().toISOString().slice(0, 10);

    return {
      id: seedSlug,
      type: 'paper',
      category: 'research',
      title: meta.title || 'Untitled',
      status: 'published',
      description: '',
      related_ids: [],
      repo_path: '',
      repo_org: '',
      repo_parsed: null,
      repo_parsed_at: '',
      personnel: [],
      funding_account_ids: [],
      tags: [],
      subtasks: [],
      notes: '',
      created_at: today,
      updated_at: today,
      meta: {
        target_journal: meta.journal || '',
        lead_author: firstAuthorFamily
          ? [firstAuthor.given, firstAuthor.family].filter(Boolean).join(' ')
          : '',
        submission_target: '',
        projected_submission_date: '',
        library: {
          is_library_entry: true,
          is_lab_draft: false,
          citation_key: citationKey(meta),
          doi: (meta.doi || '').toLowerCase(),
          pmid: meta.pmid || '',
          arxiv_id: meta.arxiv_id || '',
          authors: meta.authors || [],
          year: meta.year || '',
          journal: meta.journal || '',
          journal_iso: meta.journal_iso || '',
          issn: meta.issn || '',
          volume: meta.volume || '',
          issue: meta.issue || '',
          pages: meta.pages || '',
          abstract: meta.abstract || '',
          url: meta.url || (meta.doi ? `https://doi.org/${meta.doi}` : ''),
          source: meta.source || 'manual',
          pdf: pdfInfo
            ? {
                storage_path: pdfInfo.storage_path,
                hash: pdfInfo.hash,
                filename_safe: `${seedSlug}.pdf`,
                size_bytes: pdfInfo.size_bytes,
                uploaded_at: pdfInfo.uploaded_at,
                uploaded_by: pdfInfo.uploaded_by,
              }
            : null,
          folders: [],
          labels: [],
          tags: [],            // free-form colon-delimited multi-tags, e.g. 'research:papers:2026:GELS'
          starred: false,
          date_added: today,
          annotation_count: 0,
          evidence_count: 0,
          cited_in_drafts: [],
          public: false,            // public-share toggle
          public_url: '',           // long-lived signed Storage URL when public is true
          shared_at_iso: '',
          shared_by: '',            // email of the lab member who flipped public
        },
      },
    };
  }

  window.LIBRARY_METADATA = {
    lookup,
    extractFirstPage,
    sniffIdsFromText,
    buildPaperItem,
    citationKey,
    slugify,
  };
})();
