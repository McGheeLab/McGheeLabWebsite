/* paper-semantic-scholar.js — shared Semantic Scholar API wrapper.
 *
 * One module, three callers:
 *   - library-upload.js : import-time enrichment (references + cited_by
 *                          + abstract + tldr persisted to the item).
 *   - paper-cited-by.js : panel data source (reads cached cited_by from
 *                          the item first; only fetches when missing).
 *   - any future callers (refresh-metadata buttons, admin migration).
 *
 * Transport (V3.583): everything goes through the `semanticScholarLookup`
 * Cloud Function. api.semanticscholar.org sends no
 * Access-Control-Allow-Origin, so direct browser calls from
 * https://mcgheelab.com were ALWAYS blocked by CORS — import-time
 * enrichment never actually ran on the deploy, it just logged
 * "SS fetch failed" and moved on. The function owns the URL and the
 * field list (see functions/semantic-scholar.js), retries 429s, and
 * caches results for 7 days in metadataCache; this module now only picks
 * the lookup id and normalizes the response.
 */

(function () {
  'use strict';

  const S2_FN_URL =
    'https://us-central1-mcgheelab-f56cc.cloudfunctions.net/semanticScholarLookup';

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

  // POST to the proxy with the caller's Firebase ID token. The function
  // returns the raw Semantic Scholar JSON, so the normalizers below are
  // unchanged from the direct-fetch era.
  async function _callProxy(body) {
    const user = (typeof firebase !== 'undefined' && firebase.auth
      && firebase.auth().currentUser) || null;
    if (!user) throw new Error('Sign in to fetch Semantic Scholar data.');
    const idToken = await user.getIdToken();
    const r = await fetch(S2_FN_URL, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${idToken}`,
      },
      body: JSON.stringify(body),
    });
    let data = null;
    try { data = await r.json(); } catch (e) { /* leave null */ }
    if (!r.ok) {
      const err = new Error((data && data.error) || `Semantic Scholar proxy ${r.status}`);
      err.status = r.status;
      throw err;
    }
    return data;
  }

  // Fetch the full paper enrichment payload (paper metadata + references
  // + citations) for the given lookup id. Throws on network or 4xx/5xx.
  async function fetchPaperEnrichment(idSpec) {
    if (!idSpec || !idSpec.url) throw new Error('fetchPaperEnrichment: idSpec required');
    return _callProxy({ id: idSpec.url, kind: 'paper' });
  }

  // Fetch citations only. Used by paper-cited-by.js when the item has
  // no cached cited_by and we need a quick fill (paginated, returns
  // up to 100 by default — matches the V3.111 behavior).
  async function fetchCitations(idSpec, limit) {
    if (!idSpec || !idSpec.url) throw new Error('fetchCitations: idSpec required');
    const lim = Math.max(1, Math.min(1000, limit || 100));
    const j = await _callProxy({ id: idSpec.url, kind: 'citations', limit: lim });
    return Array.isArray(j && j.data) ? j.data : [];
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
