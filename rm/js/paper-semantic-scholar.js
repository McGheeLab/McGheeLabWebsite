/* paper-semantic-scholar.js — shared Semantic Scholar API wrapper.
 *
 * One module, three callers:
 *   - library-upload.js : import-time enrichment (references + cited_by
 *                          + abstract + tldr persisted to the item).
 *   - paper-cited-by.js : panel data source (reads cached cited_by from
 *                          the item first; only fetches when missing).
 *   - any future callers (refresh-metadata buttons, admin migration).
 *
 * Endpoint:
 *   GET https://api.semanticscholar.org/graph/v1/paper/{ID}
 *       ?fields=title,authors,year,venue,abstract,externalIds,tldr,
 *               references.title,references.authors,references.year,
 *               references.venue,references.externalIds,
 *               references.paperId,
 *               citations.title,citations.authors,citations.year,
 *               citations.venue,citations.externalIds,
 *               citations.paperId
 *   where {ID} is `DOI:10.x/y`, `ARXIV:1234.5678`, or `PMID:12345`.
 *
 * Free tier: no API key for low traffic; rate limit ~1 req/sec.
 * 429s are retried once with a small backoff before giving up.
 */

(function () {
  'use strict';

  const API_BASE = 'https://api.semanticscholar.org/graph/v1/paper';
  const FIELDS_FULL = [
    'title', 'authors', 'year', 'venue', 'abstract', 'externalIds', 'tldr',
    'references.paperId', 'references.title', 'references.authors',
    'references.year', 'references.venue', 'references.externalIds',
    'citations.paperId', 'citations.title', 'citations.authors',
    'citations.year', 'citations.venue', 'citations.externalIds',
  ].join(',');
  const FIELDS_CITATIONS_ONLY = 'title,authors,year,venue,externalIds';

  // ---- ID picking ---------------------------------------------------------

  // Pick the most reliable Semantic Scholar lookup id from a library
  // item's metadata. Preference: DOI → arXiv → PMID. Returns null if
  // none of those is set.
  function lookupId(lib) {
    if (!lib) return null;
    if (lib.doi)      return { kind: 'DOI',   value: lib.doi,      url: 'DOI:' + encodeURIComponent(lib.doi) };
    if (lib.arxiv_id) return { kind: 'arXiv', value: lib.arxiv_id, url: 'ARXIV:' + encodeURIComponent(lib.arxiv_id) };
    if (lib.pmid)     return { kind: 'PMID',  value: lib.pmid,     url: 'PMID:' + encodeURIComponent(lib.pmid) };
    return null;
  }

  // ---- HTTP ---------------------------------------------------------------

  async function _fetchJson(url) {
    let attempt = 0;
    while (true) {
      attempt++;
      const r = await fetch(url, { headers: { Accept: 'application/json' } });
      if (r.ok) return r.json();
      // One retry on rate-limit; otherwise surface the error.
      if (r.status === 429 && attempt === 1) {
        await new Promise(res => setTimeout(res, 1500));
        continue;
      }
      const body = await r.text().catch(() => '');
      throw new Error(`Semantic Scholar ${r.status}: ${body.slice(0, 200)}`);
    }
  }

  // Fetch the full paper enrichment payload (paper metadata + references
  // + citations) for the given lookup id. Throws on network or 4xx/5xx.
  async function fetchPaperEnrichment(idSpec) {
    if (!idSpec || !idSpec.url) throw new Error('fetchPaperEnrichment: idSpec required');
    const url = `${API_BASE}/${idSpec.url}?fields=${encodeURIComponent(FIELDS_FULL)}`;
    return _fetchJson(url);
  }

  // Fetch citations only. Used by paper-cited-by.js when the item has
  // no cached cited_by and we need a quick fill (paginated, returns
  // up to 100 by default — matches the V3.111 behavior).
  async function fetchCitations(idSpec, limit) {
    if (!idSpec || !idSpec.url) throw new Error('fetchCitations: idSpec required');
    const lim = Math.max(1, Math.min(1000, limit || 100));
    const url = `${API_BASE}/${idSpec.url}/citations?fields=${encodeURIComponent(FIELDS_CITATIONS_ONLY)}&limit=${lim}`;
    const j = await _fetchJson(url);
    return Array.isArray(j.data) ? j.data : [];
  }

  // ---- Normalizers --------------------------------------------------------

  // Convert one Semantic Scholar "reference" object into the shape
  // paper-citations.js's panel already expects (regex-parser shape from
  // V3.93). Returns null when the entry has no usable info.
  function normalizeReference(ssRef, idx) {
    if (!ssRef) return null;
    const ext = ssRef.externalIds || {};
    const firstAuthor = (ssRef.authors && ssRef.authors[0] && ssRef.authors[0].name) || '';
    // Surname extraction: SS gives "First Middle Last" — last token works
    // for ~95% of names. Hyphenated and double-barrel surnames retained.
    const surname = (firstAuthor.split(/\s+/).pop() || '').replace(/[,\.]+$/, '');
    const out = {
      n: idx + 1,
      raw: '',
      title: ssRef.title || '',
      firstAuthor: surname,
      year: ssRef.year ? String(ssRef.year) : '',
      doi: ext.DOI || '',
      arxiv: ext.ArXiv || '',
      journal: ssRef.venue || '',
      authors: ssRef.authors || [],
      source: 'semantic_scholar',
      paperId: ssRef.paperId || '',
    };
    // Drop entries with no title AND no DOI/arxiv — they're useless.
    if (!out.title && !out.doi && !out.arxiv) return null;
    return out;
  }

  function normalizeReferences(ssRefs) {
    if (!Array.isArray(ssRefs)) return [];
    const out = [];
    for (let i = 0; i < ssRefs.length; i++) {
      const norm = normalizeReference(ssRefs[i], i);
      if (norm) out.push(norm);
    }
    return out;
  }

  // citations[] from Semantic Scholar wraps each citing paper in a
  // { citingPaper: {...} } envelope when fetched via /citations. The
  // /paper/{ID}?fields=citations call returns each citation as the
  // bare citing paper object — normalize both shapes here.
  function normalizeCitations(ssCitations) {
    if (!Array.isArray(ssCitations)) return [];
    return ssCitations
      .map(c => c && (c.citingPaper || c))
      .filter(p => p && (p.title || (p.externalIds && Object.keys(p.externalIds).length)))
      .map(p => ({
        paperId: p.paperId || '',
        title: p.title || '',
        authors: p.authors || [],
        year: p.year || null,
        venue: p.venue || '',
        externalIds: p.externalIds || {},
      }));
  }

  // ---- Public API ---------------------------------------------------------

  window.PAPER_SS = {
    lookupId,
    fetchPaperEnrichment,
    fetchCitations,
    normalizeReferences,
    normalizeCitations,
  };
})();
