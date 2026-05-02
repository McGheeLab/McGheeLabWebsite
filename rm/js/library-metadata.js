/* library-metadata.js — DOI / PMID / arXiv / title lookup via the server proxy.
 *
 * The browser can't hit CrossRef / NCBI / arXiv directly because of CORS, so
 * the server has /api/library/lookup to forward the request. See server.py
 * _api_library_lookup.
 *
 * Public API (window.LIBRARY_METADATA):
 *   lookup({doi|pmid|arxiv_id|title})   → Promise<unified metadata>
 *   extractFirstPage(blob)              → Promise<{text, doi_guess, arxiv_guess}>
 *   sniffIdsFromText(text)              → {doi, arxiv_id} pulled from a text blob
 *   buildPaperItem(meta, pdfInfo, user) → minimal `paper` item ready for items.json
 *   citationKey(meta)                   → stable Better-BibTeX-style key
 *   slugify(text)                       → kebab-case slug for paper IDs
 */

(function () {
  async function lookup(params) {
    const res = await fetch('/api/library/lookup', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(params || {}),
    });
    if (!res.ok) {
      const detail = await res.text().catch(() => res.statusText);
      throw new Error(`Lookup failed (${res.status}): ${detail}`);
    }
    return res.json();
  }

  async function extractFirstPage(blob) {
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
    return res.json();
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
