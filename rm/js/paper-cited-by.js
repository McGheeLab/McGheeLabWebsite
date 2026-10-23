/* paper-cited-by.js — left-sidebar "Cited by" panel.
 *
 * Companion to paper-citations.js. Where paper-citations lists papers
 * the *current* paper cites (its references), this lists papers that
 * cite the *current* paper — the inverse direction.
 *
 * Data source: Semantic Scholar via the shared paper-semantic-scholar.js
 * wrapper. Google Scholar has no public API and aggressively blocks
 * scraping; Semantic Scholar gives the same cited-by relationship
 * structured + free.
 *
 * Lifecycle:
 *   PAPER_CITED_BY.init({ paperItem, mountEl, getAllItems, onLibraryChanged })
 *     1. Render skeleton.
 *     2. Try cached cited_by from `meta.library.cited_by` (V3.112 — set
 *        at import time by enrichItemFromSemanticScholar). If present,
 *        render directly — no API call.
 *     3. Otherwise (item imported pre-V3.112, or SS had no data at
 *        import), fall through to a live API fetch.
 *     4. Render rows with optional "+ Add" / "Open paper" / "Look up" actions.
 */

(function () {
  'use strict';

  const LIMIT = 100;
  const _cache = new Map();   // idKind:idValue → { fetchedAt, citations: [] }

  let _state = {
    mountEl: null,
    paperItem: null,
    getAllItems: () => [],
    onLibraryChanged: () => {},
    citations: null,        // null = not yet fetched, [] = empty, [...] = loaded
    error: null,
    fetchKey: null,
  };

  function _esc(s) {
    return String(s ?? '').replace(/[&<>"']/g, c =>
      ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
  }
  function _shorten(t, max) {
    if (!t) return '';
    return t.length <= max ? t : t.slice(0, max - 1) + '…';
  }

  function _lookupId(lib) {
    if (window.PAPER_SS && window.PAPER_SS.lookupId) return window.PAPER_SS.lookupId(lib);
    // Fallback if the SS module hasn't loaded for some reason.
    if (lib && lib.doi)      return { kind: 'DOI',   value: lib.doi,      url: 'DOI:' + encodeURIComponent(lib.doi) };
    if (lib && lib.arxiv_id) return { kind: 'arXiv', value: lib.arxiv_id, url: 'ARXIV:' + encodeURIComponent(lib.arxiv_id) };
    if (lib && lib.pmid)     return { kind: 'PMID',  value: lib.pmid,     url: 'PMID:' + encodeURIComponent(lib.pmid) };
    return null;
  }

  async function _fetchCitations(idSpec) {
    if (!window.PAPER_SS || !window.PAPER_SS.fetchCitations) {
      throw new Error('Semantic Scholar module not loaded');
    }
    const data = await window.PAPER_SS.fetchCitations(idSpec, LIMIT);
    return data;
  }

  // Find this citing paper in our local items list — by DOI or arXiv id.
  // Used to flip "+ Add" buttons to "Open paper →" when the cited-by
  // paper is already in the library.
  function _libraryHitForCitingPaper(citingPaper) {
    const items = _state.getAllItems() || [];
    const exDoi = (citingPaper.externalIds && citingPaper.externalIds.DOI) || '';
    const exArx = (citingPaper.externalIds && citingPaper.externalIds.ArXiv) || '';
    const dLower = exDoi.toLowerCase();
    return items.find(it => {
      const lib = (it.meta && it.meta.library) || {};
      if (!lib.is_library_entry) return false;
      if (dLower && (lib.doi || '').toLowerCase() === dLower) return true;
      if (exArx && (lib.arxiv_id || '').trim() === exArx) return true;
      return false;
    }) || null;
  }

  function _scholarFallbackUrl(citingPaper) {
    const q = citingPaper.title || '';
    if (!q) return null;
    return 'https://scholar.google.com/scholar?q=' + encodeURIComponent(q.slice(0, 250));
  }

  function _authorLine(authors) {
    if (!authors || !authors.length) return '';
    const names = authors.slice(0, 3).map(a => a && a.name).filter(Boolean);
    if (authors.length > 3) names.push('et al.');
    return names.join('; ');
  }

  function _renderRow(p) {
    if (!p) return '';
    const inLib = _libraryHitForCitingPaper(p);
    const doi = (p.externalIds && p.externalIds.DOI) || '';
    const arxiv = (p.externalIds && p.externalIds.ArXiv) || '';
    const author = _authorLine(p.authors);
    const yr = p.year ? `(${p.year})` : '';
    const venue = p.venue ? `<div class="lp-cb-venue">${_esc(p.venue)}</div>` : '';
    const heading = [author, yr].filter(Boolean).join(' ');

    let action;
    if (inLib) {
      action = `<a class="btn btn-sm lp-cb-action" href="/rm/pages/library-paper.html?id=${_esc(inLib.id)}" target="_blank" rel="noopener">Open paper →</a>`;
    } else if (doi) {
      action = `<button class="btn btn-sm lp-cb-action lp-cb-add" data-cb-add-doi="${_esc(doi)}" title="Add to library + try to fetch the OA PDF via Unpaywall">+ Add</button>`;
    } else if (arxiv) {
      const axDoi = `10.48550/arXiv.${arxiv}`;
      action = `<button class="btn btn-sm lp-cb-action lp-cb-add" data-cb-add-doi="${_esc(axDoi)}" title="Add to library via arXiv DOI">+ Add (arXiv)</button>`;
    } else {
      const sUrl = _scholarFallbackUrl(p);
      action = sUrl
        ? `<a class="btn btn-sm lp-cb-action" href="${_esc(sUrl)}" target="_blank" rel="noopener" title="Search Google Scholar by title">Look up</a>`
        : '';
    }

    const externalLink = doi
      ? `<a class="lp-cb-doi" href="https://doi.org/${_esc(doi)}" target="_blank" rel="noopener" title="Open at doi.org">${ICON.svg('arrow-top-right-on-square')}</a>`
      : (arxiv
          ? `<a class="lp-cb-doi" href="https://arxiv.org/abs/${_esc(arxiv)}" target="_blank" rel="noopener" title="Open on arXiv">${ICON.svg('arrow-top-right-on-square')}</a>`
          : '');

    return `
      <div class="lp-cb-row">
        <div class="lp-cb-row-head">
          <span class="lp-cb-author">${_esc(heading || 'Unknown')}</span>
          ${externalLink}
        </div>
        <div class="lp-cb-title">${_esc(_shorten(p.title || 'Untitled', 140))}</div>
        ${venue}
        <div class="lp-cb-actions">${action}</div>
      </div>
    `;
  }

  /* V3.647 — every repaint is a full innerHTML swap of a panel that lives
   * in the rail's shared scroll container, so it goes through the
   * scroll-anchored wrapper. Without it, pressing "+ Add" on a row (which
   * routes back here via onLibraryChanged) collapsed the list to zero height
   * for an instant and dumped the reader back at the top of the rail. */
  function _render() {
    if (!_state.mountEl) return;
    if (typeof rerenderPreservingScroll === 'function') {
      rerenderPreservingScroll(_state.mountEl, _paint);
    } else {
      _paint();
    }
  }

  function _paint() {
    if (!_state.mountEl) return;

    const lib = (_state.paperItem && _state.paperItem.meta && _state.paperItem.meta.library) || {};
    const idSpec = _lookupId(lib);

    let body;
    if (!idSpec) {
      body = `<div class="lp-cb-empty">No DOI / arXiv / PMID on this paper — Semantic Scholar can't resolve cited-by.</div>`;
    } else if (_state.error) {
      body = `<div class="lp-cb-empty lp-cb-error">Couldn't load cited-by: ${_esc(_state.error)}</div>`;
    } else if (_state.citations === null) {
      body = `<div class="lp-cb-empty">Loading cited-by…</div>`;
    } else if (!_state.citations.length) {
      body = `<div class="lp-cb-empty">No citations found via Semantic Scholar.</div>`;
    } else {
      body = _state.citations.map(_renderRow).join('');
    }

    const count = (_state.citations && _state.citations.length) || 0;
    _state.mountEl.innerHTML = `
      <div class="lp-section-title" style="font-size:11px;text-transform:uppercase;letter-spacing:.4px;color:#6b7280;margin-bottom:4px;display:flex;align-items:center;gap:6px;">
        Cited by
        ${count ? `<span style="font-weight:400;color:#9ca3af;font-size:10px;">${count}${count >= LIMIT ? '+' : ''} via Semantic Scholar</span>` : ''}
      </div>
      <div class="lp-cb-list">${body}</div>
    `;

    _state.mountEl.querySelectorAll('[data-cb-add-doi]').forEach(btn => {
      btn.addEventListener('click', _onAddClick);
    });
  }

  async function _onAddClick(ev) {
    const btn = ev.currentTarget;
    const doi = btn.getAttribute('data-cb-add-doi');
    if (!doi) return;
    if (!window.LIBRARY_UPLOAD || !window.LIBRARY_UPLOAD.fromDoi) {
      btn.textContent = 'Add unavailable';
      return;
    }
    const orig = btn.textContent;
    btn.disabled = true;
    btn.textContent = 'Adding…';
    try {
      const res = await window.LIBRARY_UPLOAD.fromDoi(doi);
      btn.textContent = res && res.skipped ? 'Already added' : 'Added';
      btn.classList.add('lp-cb-added');
      try { _state.onLibraryChanged && _state.onLibraryChanged(); } catch (_) { /* ignore */ }
    } catch (err) {
      btn.disabled = false;
      btn.textContent = orig;
      console.warn('[paper-cited-by] add failed:', err);
      alert('Could not add: ' + (err.message || err));
    }
  }

  async function init(opts) {
    _state.mountEl = typeof opts.mountEl === 'string'
      ? document.querySelector(opts.mountEl)
      : opts.mountEl;
    _state.paperItem = opts.paperItem || null;
    _state.getAllItems = opts.getAllItems || (() => []);
    _state.onLibraryChanged = opts.onLibraryChanged || (() => {});
    _state.citations = null;
    _state.error = null;
    if (!_state.mountEl) return;

    _render();   // skeleton

    const lib = (_state.paperItem && _state.paperItem.meta && _state.paperItem.meta.library) || {};

    // V3.112 — prefer the persisted cited_by if it's there.
    // enrichItemFromSemanticScholar populates this at import time, so most
    // papers won't need a live API call on every reader open. V3.206 —
    // cited_by moved to items/{id}/details/main; fall back to inline for
    // unmigrated rows.
    if (Array.isArray(lib.cited_by)) {
      _state.citations = lib.cited_by;
      _render();
      return;
    }
    if (window.LIBRARY_EXTRAS && _state.paperItem && _state.paperItem.id) {
      try {
        const extras = await window.LIBRARY_EXTRAS.load(_state.paperItem.id, _state.paperItem);
        if (extras && Array.isArray(extras.cited_by)) {
          _state.citations = extras.cited_by;
          _render();
          return;
        }
      } catch (e) {
        console.warn('[paper-cited-by] LIBRARY_EXTRAS.load failed:', e.message || e);
      }
    }

    const idSpec = _lookupId(lib);
    if (!idSpec) return;   // already rendered the "no id" empty state

    const cacheKey = idSpec.kind + ':' + idSpec.value;
    _state.fetchKey = cacheKey;

    if (_cache.has(cacheKey)) {
      _state.citations = _cache.get(cacheKey).citations;
      _render();
      return;
    }

    try {
      const data = await _fetchCitations(idSpec);
      // Normalize the /citations envelope ({ citingPaper: {...} } per row)
      // into the same flat shape the persisted cache uses, so _renderRow
      // doesn't need to branch.
      const normalized = (window.PAPER_SS && window.PAPER_SS.normalizeCitations)
        ? window.PAPER_SS.normalizeCitations(data)
        : data.map(e => e && e.citingPaper).filter(Boolean);
      _cache.set(cacheKey, { fetchedAt: Date.now(), citations: normalized });
      // Avoid stomping if init() was called again with a different paper
      // mid-flight.
      if (_state.fetchKey !== cacheKey) return;
      _state.citations = normalized;
    } catch (err) {
      console.warn('[paper-cited-by] fetch failed:', err);
      _state.error = err.message || String(err);
    }
    _render();
  }

  // Public: re-render after the items list changed (e.g. user clicked "+ Add"
  // and we want to flip that row's button to "Open paper →").
  function refreshLibraryStatus() { _render(); }

  window.PAPER_CITED_BY = { init, refreshLibraryStatus };
})();
