/* paper-search.js — keyword search across the open paper, with hits inside
 * existing highlights ranked first.
 *
 * Public API (window.PAPER_SEARCH):
 *   init({viewer, getAnnotations, mountEl, onJump})
 *   search(query) → results array (also rendered into the dropdown)
 *
 * The "highlight-aware" ranking is the whole point: when the user is reading
 * a paper for a specific review pass, the things they've already highlighted
 * are the things they've decided are interesting. Surfacing other-page hits
 * that overlap an existing highlight first means quickly finding "where
 * else does this idea show up in the paper."
 */
(function () {
  let _viewer = null;
  let _getAnnotations = () => [];
  let _mountEl = null;
  let _onJump = null;
  let _lastQuery = '';
  let _debounceT = 0;
  let _docClickBound = false;   // V3.294 — bind the outside-click closer once

  function _esc(s) {
    return String(s ?? '').replace(/[&<>"']/g, c =>
      ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c])
    );
  }

  /** For each page, concatenate text items and find all case-insensitive
   *  matches of the needle. Returns a flat list of {page, snippet, x, y, w,
   *  h, items, inHighlight}. */
  function _scan(query) {
    const q = String(query || '').trim();
    if (q.length < 2) return [];
    const annotations = _getAnnotations() || [];
    const annByPage = new Map();
    for (const a of annotations) {
      const pages = (a.target && a.target.pages) || [];
      for (const p of pages) {
        const arr = annByPage.get(p.page) || [];
        const exact = (p.selectors && p.selectors.textQuote && p.selectors.textQuote.exact) || '';
        arr.push({ ann: a, exact: exact.toLowerCase() });
        annByPage.set(p.page, arr);
      }
    }

    const results = [];
    const re = new RegExp(q.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), 'gi');
    for (let p = 1; p <= _viewer.numPages; p++) {
      const items = _viewer.getTextItems(p) || [];
      if (!items.length) continue;
      const parts = [];
      let off = 0;
      const ranges = [];
      for (const it of items) {
        parts.push(it.text);
        ranges.push({ start: off, end: off + it.text.length, item: it });
        off += it.text.length + 1;
        parts.push(' ');
      }
      const fullText = parts.join('');
      re.lastIndex = 0;
      let m;
      while ((m = re.exec(fullText)) !== null) {
        const start = m.index;
        const end = start + m[0].length;
        const hits = [];
        for (const r of ranges) {
          if (r.start >= end) break;
          if (r.end <= start) continue;
          hits.push(r.item);
        }
        if (!hits.length) continue;
        // Snippet: ±40 chars around the match.
        const snipStart = Math.max(0, start - 40);
        const snipEnd = Math.min(fullText.length, end + 40);
        const before = fullText.slice(snipStart, start);
        const matched = fullText.slice(start, end);
        const after = fullText.slice(end, snipEnd);
        const snippetHTML = `${snipStart > 0 ? '…' : ''}${_esc(before)}<mark>${_esc(matched)}</mark>${_esc(after)}${snipEnd < fullText.length ? '…' : ''}`;

        // inHighlight: does the matched text overlap any existing highlight
        // text-quote on this page?
        const annsHere = annByPage.get(p) || [];
        const matchedLower = matched.toLowerCase();
        const inHighlight = annsHere.some(ah => ah.exact && ah.exact.includes(matchedLower));

        const x = Math.min(...hits.map(i => i.x));
        const y = Math.min(...hits.map(i => i.y));
        const xe = Math.max(...hits.map(i => i.x + i.width));
        const ye = Math.max(...hits.map(i => i.y + i.height));

        results.push({
          page: p,
          snippet: snippetHTML,
          x, y, w: xe - x, h: ye - y,
          inHighlight,
        });
        // Cap per-page hits so a generic word (e.g. "the") doesn't return
        // 4000 results — first 6 per page is enough for finding context.
        if (results.filter(r => r.page === p).length > 6) break;
      }
    }
    // Sort: inHighlight desc, then page asc, then y asc.
    results.sort((a, b) => {
      if (a.inHighlight !== b.inHighlight) return a.inHighlight ? -1 : 1;
      if (a.page !== b.page) return a.page - b.page;
      return a.y - b.y;
    });
    return results;
  }

  function _renderInput() {
    if (!_mountEl) return;
    _mountEl.innerHTML = `
      <div class="lp-search-wrap">
        <input type="search" class="lp-search-input" id="lp-search-input"
               placeholder="Find in paper… (highlighted hits ranked first)">
        <div class="lp-search-results" id="lp-search-results" style="display:none"></div>
      </div>
    `;
    const inp = _mountEl.querySelector('#lp-search-input');
    const drop = _mountEl.querySelector('#lp-search-results');
    inp.addEventListener('input', () => {
      clearTimeout(_debounceT);
      _debounceT = setTimeout(() => _runSearch(inp.value, drop), 180);
    });
    inp.addEventListener('focus', () => {
      if (drop.children.length) drop.style.display = 'block';
    });
    // V3.294 — bind the outside-click closer ONCE (module-level named
    // handler), not on every init()/_renderInput(). Re-running init on a
    // tab switch used to stack a fresh anonymous document listener each
    // time. The named handler re-queries the live _mountEl + dropdown.
    if (!_docClickBound) {
      document.addEventListener('click', _onDocClick);
      _docClickBound = true;
    }
  }

  function _onDocClick(ev) {
    if (!_mountEl) return;
    const drop = _mountEl.querySelector('#lp-search-results');
    if (!drop) return;
    if (!_mountEl.contains(ev.target)) drop.style.display = 'none';
  }

  function _runSearch(query, drop) {
    _lastQuery = query;
    if (!query || query.trim().length < 2) {
      drop.innerHTML = '';
      drop.style.display = 'none';
      return;
    }
    let results;
    try {
      results = _scan(query);
    } catch (e) {
      console.warn('[paper-search] scan error:', e);
      drop.innerHTML = `<div class="lp-search-empty">Search error: ${_esc(e.message || e)}</div>`;
      drop.style.display = 'block';
      return;
    }
    if (!results.length) {
      drop.innerHTML = `<div class="lp-search-empty">No matches for "${_esc(query)}".</div>`;
      drop.style.display = 'block';
      return;
    }
    const inHi = results.filter(r => r.inHighlight).length;
    drop.innerHTML = `
      <div class="lp-search-summary">${results.length} hit${results.length === 1 ? '' : 's'}${inHi ? ` · ${inHi} inside existing highlights` : ''}</div>
      ${results.slice(0, 60).map((r, i) => `
        <div class="lp-search-row${r.inHighlight ? ' lp-search-row-hl' : ''}" data-search-i="${i}">
          <span class="lp-search-page">p.${r.page}</span>
          ${r.inHighlight ? '<span class="lp-search-chip">in highlight</span>' : ''}
          <span class="lp-search-snippet">${r.snippet}</span>
        </div>
      `).join('')}
      ${results.length > 60 ? `<div class="lp-search-more">+${results.length - 60} more (refine query to see them)</div>` : ''}
    `;
    drop.style.display = 'block';
    drop.querySelectorAll('.lp-search-row').forEach(row => {
      row.addEventListener('click', () => {
        const i = parseInt(row.getAttribute('data-search-i'), 10);
        const r = results[i];
        if (!r) return;
        if (typeof _onJump === 'function') _onJump(r);
        drop.style.display = 'none';
      });
    });
  }

  function init(opts) {
    _viewer = opts.viewer;
    _getAnnotations = opts.getAnnotations || (() => []);
    _mountEl = opts.mountEl;
    _onJump = opts.onJump || null;
    _renderInput();
  }

  function search(query) {
    return _scan(query);
  }

  // V3.294 — tear down for tab switches: clear the pending debounce so a
  // late _runSearch can't fire against the next paper's _mountEl/_viewer,
  // remove the once-bound outside-click listener, and blank the mount.
  function destroy() {
    clearTimeout(_debounceT);
    _debounceT = 0;
    if (_docClickBound) {
      document.removeEventListener('click', _onDocClick);
      _docClickBound = false;
    }
    if (_mountEl) _mountEl.innerHTML = '';
    _viewer = null;
    _getAnnotations = () => [];
    _onJump = null;
  }

  window.PAPER_SEARCH = { init, search, destroy };
})();
