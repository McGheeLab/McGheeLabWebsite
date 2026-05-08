/* paper-citations.js — left-sidebar "citations on this page" panel.
 *
 * Public API (window.PAPER_CITATIONS):
 *   init({viewer, paperItem, sideEl, getAllItems, onLibraryChanged})
 *   refreshForPage(pageNum)
 *   refreshLibraryStatus()    — re-check which refs are in the library
 *   destroy()
 *
 * Workflow:
 *   1. Render empty panel into #lp-citations.
 *   2. After viewer.ready() resolves, eagerly walk the back of the paper
 *      to parse a structured references list — DOI, year, first author,
 *      title, journal, arXiv id where extractable.
 *   3. On every page change / page-ready, regex-scan that page's text for
 *      inline citation tokens and surface one row per unique reference.
 *      Each row shows the parsed metadata (authors+year+title) plus an
 *      "in library" chip if the DOI matches an existing library entry.
 *   4. Hovering a sidebar row flashes its rect on the PDF; hovering a
 *      citation token in the PDF text layer highlights the sidebar row.
 *   5. "+ Add to library" stub-creates the cited paper via
 *      `LIBRARY_UPLOAD.fromDoi` (which now tries Unpaywall for an OA PDF).
 */
(function () {
  let _viewer = null;
  let _item = null;
  let _sideEl = null;
  let _getAllItems = () => [];
  let _onLibraryChanged = null;
  let _refs = null;            // [{n, raw, doi, year, firstAuthor, title, journal, arxiv}] | null
  let _refState = 'pending';   // 'pending' | 'parsing' | 'ready' | 'none'
  let _currentPage = 1;
  // pageNum → [{token, refIndex, refKey, kind, x, y, w, h, page, items}]
  const _matchesByPage = new Map();
  let _hoverEl = null;
  let _readyDone = false;

  // Heading patterns at the top of references section. Permissive: matches
  // "References", "REFERENCES", "References:", "1. References", "References 45"
  // (page number tail). Anchored on case-insensitive match — V3.90 uses
  // line-joining (see _groupItemsIntoLines) so a heading split across
  // many spans still triggers it.
  const REF_HEADING = /(?:^|[\s\d.])(References?|Bibliography|Works\s+Cited|Literature\s+Cited|Notes?\s+and\s+References)(?:\s|:|$)/i;

  // Numeric inline-cite tokens like [12], [3, 4], [5–7].
  const RE_NUMERIC = /\[(\d+(?:\s*[–\-,]\s*\d+)*)\]/g;

  // Author-year inline-cite tokens like (Smith, 2020), (Smith et al., 2020),
  // (Smith and Jones, 2020).
  const RE_AUTHOR_YEAR = /\(([A-Z][A-Za-zÀ-ſ'-]+(?:\s+et\s+al\.?|(?:\s+(?:and|&)\s+[A-Z][A-Za-zÀ-ſ'-]+))?),?\s+(\d{4}[a-z]?)\)/g;

  // DOI / arXiv extraction patterns reused per entry.
  const RE_DOI = /\b10\.\d{4,9}\/[-._;()/:A-Z0-9]+/i;
  const RE_ARXIV = /\barXiv\s*:?\s*(\d{4}\.\d{4,5})(?:v\d+)?/i;
  const RE_YEAR = /\b(?:19|20)\d{2}[a-z]?\b/;

  function _esc(s) {
    return String(s ?? '').replace(/[&<>"']/g, c =>
      ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c])
    );
  }

  function _shorten(raw, max) {
    const t = String(raw || '').replace(/\s+/g, ' ').trim();
    return t.length <= max ? t : t.slice(0, max - 1) + '…';
  }

  // -------------------------------------------------------- references parser

  /**
   * Group items into visual lines: items on the same page with similar y
   * coordinates collapse into one line entry. Returns
   * [{ page, y, text, items: [...], firstItemIdx }, ...] sorted by
   * (page asc, y asc). Crucial for heading detection — PDFs often render
   * "References" as several adjacent glyph spans rather than one span.
   */
  function _groupItemsIntoLines(items) {
    const lines = [];
    let cur = null;
    for (let i = 0; i < items.length; i++) {
      const it = items[i];
      const samePage = cur && cur.page === it.page;
      const yClose  = cur && Math.abs(it.y - cur.y) <= Math.max(2, (it.height || 12) * 0.5);
      if (cur && samePage && yClose) {
        cur.items.push(it);
        cur.text += ' ' + it.text;
        cur.lastIdx = i;
      } else {
        if (cur) lines.push(cur);
        cur = { page: it.page, y: it.y, text: it.text, items: [it], firstItemIdx: i, lastIdx: i };
      }
    }
    if (cur) lines.push(cur);
    return lines;
  }

  /**
   * Walk text items from the back of the paper, find a references heading,
   * and segment everything after it into entries by:
   *
   *   1. Numeric prefix "[N]" or "N." at the start of a new line, OR
   *   2. y-gap > ~1.4 line heights from the previous item (paragraph break).
   *
   * Each entry's text is the joined run of items. Metadata (DOI, year,
   * first-author surname, title, journal, arxiv) is extracted by best-
   * effort regex. Returns [] on failure.
   */
  function _parseReferences() {
    if (!_viewer || !_viewer.numPages) return [];
    const numPages = _viewer.numPages;

    // V3.90 — escalating page range. Try last 25 first (fast path for
    // typical papers), then last 60, then everything. References almost
    // always live in the last quarter; the wider sweeps catch papers
    // where the parser would otherwise silently fail.
    const ranges = [
      [Math.max(1, numPages - 24), numPages],
      [Math.max(1, numPages - 59), numPages],
      [1, numPages],
    ];

    for (let r = 0; r < ranges.length; r++) {
      const [startPage, endPage] = ranges[r];
      const allItems = [];
      for (let p = startPage; p <= endPage; p++) {
        const items = _viewer.getTextItems(p) || [];
        for (const it of items) allItems.push({ ...it, page: p });
      }
      if (!allItems.length) continue;

      // V3.90 — find the references heading by joining items on each
      // line (PDFs often render "REFERENCES" as one glyph per span).
      const lines = _groupItemsIntoLines(allItems);
      let headingItemIdx = -1;
      for (let li = 0; li < lines.length; li++) {
        const t = lines[li].text.trim();
        if (!t) continue;
        // Skip lines that are too long — references heading lines are
        // short. 60 chars is a generous cap that excludes prose.
        if (t.length > 60) continue;
        if (REF_HEADING.test(t)) {
          headingItemIdx = lines[li].lastIdx;
          console.info(`[paper-citations] heading "${t}" found on p.${lines[li].page} (range ${startPage}-${endPage})`);
          break;
        }
      }
      if (headingItemIdx < 0) {
        if (r === ranges.length - 1) {
          console.warn('[paper-citations] no references heading found anywhere in PDF');
          return [];
        }
        continue;
      }
      // Found heading — fall through to entry segmentation.
      return _parseEntriesFromHeading(allItems, headingItemIdx);
    }
    return [];
  }

  function _parseEntriesFromHeading(allItems, headingIdx) {

    // Median line height across items after the heading — used for the
    // y-gap paragraph-break threshold.
    const tail = allItems.slice(headingIdx + 1);
    if (!tail.length) return [];
    const heights = tail.map(it => it.height).filter(h => h > 0).sort((a, b) => a - b);
    const medianH = heights[Math.floor(heights.length / 2)] || 12;

    // Track the median left-x of all post-heading items per page; entries
    // start near the left margin in hanging-indent style.
    const xsByPage = new Map();
    for (const it of tail) {
      const arr = xsByPage.get(it.page) || [];
      arr.push(it.x);
      xsByPage.set(it.page, arr);
    }
    const leftMarginByPage = new Map();
    for (const [page, xs] of xsByPage) {
      const sorted = xs.slice().sort((a, b) => a - b);
      // 5th percentile = the leftmost handful of items, treat as "the
      // hanging-indent start column".
      leftMarginByPage.set(page, sorted[Math.floor(sorted.length * 0.05)] || 0);
    }

    // Segment.
    const entries = [];
    let cur = null;
    let prev = null;

    for (let i = headingIdx + 1; i < allItems.length; i++) {
      const it = allItems[i];
      const trimmed = it.text.trim();
      if (!trimmed) continue;

      let isNew = false;
      if (cur === null) {
        isNew = true;
      } else {
        // Cross-page break in continuous text isn't necessarily a new
        // entry, but if it coincides with one of the other signals it
        // amplifies them. Don't force-new on page change alone.
        const samePage = prev && prev.page === it.page;
        const yGap = samePage ? (it.y - (prev.y + prev.height)) : 0;
        const paragraphBreak = samePage && yGap > medianH * 1.4;
        const xMargin = leftMarginByPage.get(it.page) || 0;
        const atLeftMargin = it.x <= xMargin + Math.max(3, medianH * 0.4);
        const numericPrefix = /^(?:\[(\d+)\]|(\d+)\.)\s*/.exec(trimmed);

        // Strong signal: numeric prefix + at left margin + new line.
        const newLine = !samePage || it.y > prev.y + medianH * 0.5;
        if (numericPrefix && atLeftMargin && newLine) isNew = true;
        // Strong signal: paragraph-style y-gap.
        else if (paragraphBreak && atLeftMargin) isNew = true;
      }

      if (isNew) {
        if (cur) entries.push(cur);
        cur = { items: [], page: it.page };
      }
      cur.items.push(it);
      prev = it;
    }
    if (cur) entries.push(cur);

    // Build entry text + extract metadata.
    const out = entries.map((e, idx) => {
      const raw = e.items.map(it => it.text).join(' ').replace(/\s+/g, ' ').trim();
      const markerMatch = /^\[(\d+)\]\s*/.exec(raw) || /^(\d+)\.\s*/.exec(raw);
      const n = markerMatch ? parseInt(markerMatch[1] || markerMatch[2], 10) : (idx + 1);
      const stripped = markerMatch ? raw.slice(markerMatch[0].length).trim() : raw;

      const doi = (raw.match(RE_DOI) || [''])[0].replace(/[.,;)]+$/, '');
      const arxivMatch = raw.match(RE_ARXIV);
      const arxiv = arxivMatch ? arxivMatch[1] : '';
      const year = (raw.match(RE_YEAR) || [''])[0];

      // First author surname: leading "Surname, I." pattern, or "Surname Initial"
      // pattern. Authors usually come first; trim the marker first.
      const fam = stripped.match(/^([A-Z][A-Za-zÀ-ſ'-]{1,30})/);
      const firstAuthor = fam ? fam[1] : '';

      // Title + journal extraction (best-effort).
      let title = '', journal = '';
      // Style A: "Authors. (YYYY). Title. Journal, vol, pp."
      const aMatch = stripped.match(/\(\s*(?:19|20)\d{2}[a-z]?\s*\)\.?\s*([^.]+?)\.\s*([A-Z][^.,]+?)(?:[,\.]|$)/);
      if (aMatch) {
        title = aMatch[1].trim();
        journal = aMatch[2].trim();
      } else {
        // Style B (numeric, no year-paren): "[1] Authors. Title. Journal year; vol: pp."
        // Try splitting on `. ` and picking the first reasonably-long
        // segment after the authors as the title.
        const segs = stripped.split(/\.\s+/);
        if (segs.length >= 3) {
          // Heuristic: authors usually fit in 1-2 segments. Title is the
          // first segment with > 4 words and starts with capital that's
          // not a 2-letter author initial.
          for (let s = 1; s < Math.min(segs.length, 4); s++) {
            const seg = segs[s].trim();
            const wordCount = seg.split(/\s+/).length;
            if (wordCount >= 4 && wordCount <= 30 && /^[A-Z]/.test(seg)) {
              title = seg;
              if (segs[s + 1]) journal = segs[s + 1].split(/[,;]/)[0].trim();
              break;
            }
          }
        }
      }

      return {
        n,
        raw,
        stripped,
        doi,
        arxiv,
        year,
        firstAuthor,
        title: title.replace(/\s+/g, ' ').trim().slice(0, 220),
        journal: journal.replace(/\s+/g, ' ').trim().slice(0, 80),
        firstPage: e.page,
      };
    });

    console.info(`[paper-citations] parsed ${out.length} reference(s) from heading on p.${allItems[headingIdx].page}`);
    return out;
  }

  // -------------------------------------------------------- per-page citation scan

  function _scanPage(pageNum) {
    const items = _viewer.getTextItems(pageNum) || [];
    if (!items.length) {
      _matchesByPage.set(pageNum, []);
      return;
    }
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
    const matches = [];

    function addMatch(re, kind) {
      re.lastIndex = 0;
      let m;
      while ((m = re.exec(fullText)) !== null) {
        const start = m.index;
        const end = start + m[0].length;
        const hitItems = [];
        for (const r of ranges) {
          if (r.start >= end) break;
          if (r.end <= start) continue;
          hitItems.push(r.item);
        }
        if (!hitItems.length) continue;
        const x = Math.min(...hitItems.map(i => i.x));
        const y = Math.min(...hitItems.map(i => i.y));
        const xe = Math.max(...hitItems.map(i => i.x + i.width));
        const ye = Math.max(...hitItems.map(i => i.y + i.height));
        const refKey = kind === 'numeric' ? m[1] : `${m[1]}|${m[2]}`;
        matches.push({
          token: m[0],
          inner: m[1],
          year: kind === 'numeric' ? '' : m[2],
          kind,
          refKey,
          page: pageNum,
          x, y, w: xe - x, h: ye - y,
          items: hitItems,
        });
      }
    }
    addMatch(RE_NUMERIC, 'numeric');
    addMatch(RE_AUTHOR_YEAR, 'authoryear');
    _matchesByPage.set(pageNum, matches);
  }

  /** Return _refs entries that match a token, by `n` field for numeric or
   *  surname+year for author-year. Falls back to position (n=index+1) for
   *  numeric tokens when an entry's parsed `n` is missing/wrong. */
  function _matchedRef(match) {
    if (!_refs || !_refs.length) return null;
    if (match.kind === 'numeric') {
      // Take the first number in the inner group (e.g. "[3, 5–7]" → 3).
      const firstNum = parseInt((match.inner.match(/\d+/) || [''])[0], 10);
      if (isNaN(firstNum)) return null;
      // Prefer entry whose `n` matches; else fall back to position.
      let r = _refs.find(x => x.n === firstNum);
      if (!r && firstNum >= 1 && firstNum <= _refs.length) r = _refs[firstNum - 1];
      return r || null;
    }
    // Author-year.
    const authorWord = match.inner.replace(/\s+et\s+al\.?$/, '').replace(/\s+(?:and|&)\s+.*$/, '').trim();
    const yearN = match.year;
    return _refs.find(r =>
      r.year === yearN &&
      r.firstAuthor &&
      r.firstAuthor.toLowerCase() === authorWord.toLowerCase()
    ) || null;
  }

  // -------------------------------------------------------- per-page flash overlay

  function _ensureCiteOverlay(pageNum) {
    const node = _viewer && _viewer.getPageNode && _viewer.getPageNode(pageNum);
    if (!node || !node.wrap) return null;
    let ov = node.wrap.querySelector('.pv-cite-overlay');
    if (!ov) {
      ov = document.createElement('div');
      ov.className = 'pv-cite-overlay';
      ov.style.position = 'absolute';
      ov.style.left = '0';
      ov.style.top = '0';
      ov.style.right = '0';
      ov.style.bottom = '0';
      ov.style.pointerEvents = 'none';
      ov.style.zIndex = '6';
      node.wrap.appendChild(ov);
    }
    return ov;
  }

  function _flashRect(pageNum, x, y, w, h) {
    _clearFlash();
    const ov = _ensureCiteOverlay(pageNum);
    if (!ov) return;
    const el = document.createElement('div');
    el.className = 'pv-cite-flash';
    el.style.position = 'absolute';
    el.style.left = `${x - 2}px`;
    el.style.top = `${y - 2}px`;
    el.style.width = `${w + 4}px`;
    el.style.height = `${h + 4}px`;
    el.style.background = 'rgba(250, 204, 21, 0.45)';
    el.style.border = '2px solid rgba(250, 204, 21, 0.85)';
    el.style.borderRadius = '3px';
    el.style.boxShadow = '0 0 8px rgba(250, 204, 21, 0.6)';
    el.style.pointerEvents = 'none';
    ov.appendChild(el);
    _hoverEl = el;
  }

  function _clearFlash() {
    if (_hoverEl) { _hoverEl.remove(); _hoverEl = null; }
  }

  // -------------------------------------------------------- library lookup

  function _libraryHitForRef(ref) {
    if (!ref) return null;
    const items = _getAllItems() || [];
    const dois = (ref.doi || '').toLowerCase().replace(/[.,;)]+$/, '');
    const ax = (ref.arxiv || '').trim();
    return items.find(it => {
      const lib = (it.meta && it.meta.library) || {};
      if (!lib.is_library_entry) return false;
      if (dois && (lib.doi || '').toLowerCase() === dois) return true;
      if (ax && (lib.arxiv_id || '').trim() === ax) return true;
      return false;
    }) || null;
  }

  // -------------------------------------------------------- sidebar render

  function _refPreview(ref) {
    if (!ref) return '<em style="color:#9ca3af">unmatched</em>';
    const author = ref.firstAuthor ? `${_esc(ref.firstAuthor)}${ref.year ? ' ' + _esc(ref.year) : ''}` : '';
    const title = ref.title ? _esc(_shorten(ref.title, 72)) : '';
    if (author && title) return `<span class="lp-cite-author">${author}</span> <span class="lp-cite-title">${title}</span>`;
    if (author) return `<span class="lp-cite-author">${author}</span>`;
    if (title) return `<span class="lp-cite-title">${title}</span>`;
    return _esc(_shorten(ref.raw, 72));
  }

  function _renderPanel() {
    if (!_sideEl) return;
    const matches = _matchesByPage.get(_currentPage) || [];
    const byKey = new Map();
    for (const m of matches) {
      if (!byKey.has(m.refKey)) byKey.set(m.refKey, { ...m, hits: [] });
      byKey.get(m.refKey).hits.push(m);
    }
    const rows = Array.from(byKey.values());

    let body;
    if (_refState === 'pending' || _refState === 'parsing') {
      body = `<div class="lp-cite-empty">Parsing references…</div>`;
    } else if (!rows.length) {
      body = `<div class="lp-cite-empty">No citations found on page ${_currentPage}.</div>`;
    } else {
      body = rows.map((row, idx) => {
        const ref = _matchedRef(row);
        const inLib = ref ? _libraryHitForRef(ref) : null;
        const preview = _refPreview(ref);
        const hasDoi = !!(ref && ref.doi);
        const hasArxiv = !!(ref && ref.arxiv);

        let chip = '';
        if (inLib) {
          chip = `<a class="lp-cite-chip lp-cite-chip-lib" href="/rm/pages/library-paper.html?id=${_esc(inLib.id)}" title="Open in library" target="_blank" rel="noopener">✓ in library</a>`;
        } else if (ref && !hasDoi && !hasArxiv) {
          chip = `<span class="lp-cite-chip lp-cite-chip-noid" title="No DOI or arXiv id parsed — can't auto-add">no id</span>`;
        }

        let actions = '';
        if (ref && (hasDoi || hasArxiv)) {
          if (inLib) {
            actions = `<a class="btn btn-sm lp-cite-open" href="/rm/pages/library-paper.html?id=${_esc(inLib.id)}" target="_blank" rel="noopener">Open paper →</a>`;
          } else if (hasDoi) {
            actions = `<button class="btn btn-sm lp-cite-add" data-cite-add-doi="${_esc(ref.doi)}" title="Add to library + try to fetch the OA PDF via Unpaywall">+ Add to library</button>`;
          } else if (hasArxiv) {
            const axDoi = `10.48550/arXiv.${ref.arxiv}`;
            actions = `<button class="btn btn-sm lp-cite-add" data-cite-add-doi="${_esc(axDoi)}" title="Add to library via arXiv DOI">+ Add (arXiv)</button>`;
          }
        }

        const fullText = ref ? _shorten(ref.raw, 600) : '';
        const meta = ref ? [
          ref.firstAuthor ? `<div class="lp-cite-meta-row"><span>Author</span>${_esc(ref.firstAuthor)}${ref.year ? ' (' + _esc(ref.year) + ')' : ''}</div>` : '',
          ref.title ? `<div class="lp-cite-meta-row"><span>Title</span>${_esc(_shorten(ref.title, 220))}</div>` : '',
          ref.journal ? `<div class="lp-cite-meta-row"><span>Journal</span>${_esc(ref.journal)}</div>` : '',
          ref.doi ? `<div class="lp-cite-meta-row"><span>DOI</span><a href="https://doi.org/${_esc(ref.doi)}" target="_blank" rel="noopener">${_esc(ref.doi)}</a></div>` : '',
          ref.arxiv ? `<div class="lp-cite-meta-row"><span>arXiv</span><a href="https://arxiv.org/abs/${_esc(ref.arxiv)}" target="_blank" rel="noopener">${_esc(ref.arxiv)}</a></div>` : '',
        ].filter(Boolean).join('') : '';

        return `
          <div class="lp-cite-row" data-cite-key="${_esc(row.refKey)}" data-cite-page="${row.page}" data-cite-x="${row.x}" data-cite-y="${row.y}" data-cite-w="${row.w}" data-cite-h="${row.h}">
            <div class="lp-cite-row-head" data-cite-toggle="${idx}">
              <span class="lp-cite-token">${_esc(row.token)}</span>
              <span class="lp-cite-preview">${preview}</span>
              ${chip}
              <span class="lp-cite-chev">▸</span>
            </div>
            <div class="lp-cite-row-body" id="lp-cite-body-${idx}" style="display:none">
              ${ref
                ? `${meta || `<div class="lp-cite-full">${_esc(fullText)}</div>`}
                   ${meta && fullText ? `<details class="lp-cite-full-wrap"><summary>raw entry</summary><div class="lp-cite-full">${_esc(fullText)}</div></details>` : ''}
                   ${actions ? `<div class="lp-cite-actions">${actions}</div>` : ''}`
                : `<div class="lp-cite-unmatched">No matching reference parsed. The token may be a footnote, equation label, or a short-form (e.g. <code>[i]</code>) we don't recognize yet. ${_refs && _refs.length ? `(${_refs.length} reference(s) parsed.)` : '(References list not parsed for this paper.)'}</div>`
              }
            </div>
          </div>
        `;
      }).join('');
    }

    _sideEl.innerHTML = `
      <div class="lp-section-title" style="font-size:11px;text-transform:uppercase;letter-spacing:.4px;color:#6b7280;margin-bottom:4px;display:flex;align-items:center;gap:6px;">
        Citations on page ${_currentPage}
        <span style="font-weight:400;color:#9ca3af;font-size:10px;">${rows.length || 0} unique${_refState === 'ready' && _refs ? ` · ${_refs.length} refs` : ''}</span>
      </div>
      <div class="lp-cite-list">${body}</div>
    `;

    _sideEl.querySelectorAll('.lp-cite-row').forEach(row => {
      row.addEventListener('mouseenter', _onRowHover);
      row.addEventListener('mouseleave', _clearFlash);
    });
    _sideEl.querySelectorAll('[data-cite-toggle]').forEach(head => {
      head.addEventListener('click', () => {
        const i = head.getAttribute('data-cite-toggle');
        const body = _sideEl.querySelector(`#lp-cite-body-${i}`);
        const chev = head.querySelector('.lp-cite-chev');
        if (!body) return;
        const isOpen = body.style.display !== 'none';
        body.style.display = isOpen ? 'none' : 'block';
        if (chev) chev.textContent = isOpen ? '▸' : '▾';
      });
    });
    _sideEl.querySelectorAll('[data-cite-add-doi]').forEach(btn => {
      btn.addEventListener('click', _onAddClick);
    });
  }

  function _onRowHover(ev) {
    const row = ev.currentTarget;
    const page = parseInt(row.getAttribute('data-cite-page'), 10);
    const x = parseFloat(row.getAttribute('data-cite-x'));
    const y = parseFloat(row.getAttribute('data-cite-y'));
    const w = parseFloat(row.getAttribute('data-cite-w'));
    const h = parseFloat(row.getAttribute('data-cite-h'));
    _flashRect(page, x, y, w, h);
  }

  async function _onAddClick(ev) {
    const btn = ev.currentTarget;
    const doi = btn.getAttribute('data-cite-add-doi');
    if (!doi) return;
    if (!window.LIBRARY_UPLOAD || !window.LIBRARY_UPLOAD.fromDoi) {
      alert('Add-by-DOI unavailable: LIBRARY_UPLOAD.fromDoi not loaded.');
      return;
    }
    const orig = btn.textContent;
    btn.disabled = true;
    btn.textContent = 'Adding…';
    try {
      const out = await window.LIBRARY_UPLOAD.fromDoi(doi);
      const note = out.pdfInfo
        ? '✓ Added with PDF'
        : (out.pdfCandidateUrl ? '✓ Added (PDF link saved)' : '✓ Added');
      btn.textContent = note;
      btn.classList.add('lp-cite-added');
      if (typeof _onLibraryChanged === 'function') {
        try { _onLibraryChanged(out); } catch (_) { /* ignore */ }
      }
      // Re-render the panel after a short pause so the user sees the
      // success state, then the row flips to "Open paper →".
      setTimeout(() => _renderPanel(), 1400);
    } catch (e) {
      console.error('[paper-citations] add-to-library failed:', e);
      btn.textContent = `Error: ${(e.message || e).toString().slice(0, 60)}`;
      btn.disabled = false;
      setTimeout(() => { btn.textContent = orig; }, 4000);
    }
  }

  // -------------------------------------------------------- pdf token hover

  function _wirePageTokenHover(pageNum) {
    const matches = _matchesByPage.get(pageNum) || [];
    if (!matches.length) return;
    const node = _viewer.getPageNode(pageNum);
    if (!node) return;
    for (const m of matches) {
      for (const it of m.items) {
        if (!it.domSpan) continue;
        if (it.domSpan.__citeHoverBound) continue;
        it.domSpan.__citeHoverBound = true;
        it.domSpan.style.cursor = 'help';
        it.domSpan.addEventListener('mouseenter', () => _highlightSidebarRow(m.refKey, m));
        it.domSpan.addEventListener('mouseleave', _clearSidebarHighlight);
      }
    }
  }

  function _highlightSidebarRow(refKey, match) {
    if (!_sideEl) return;
    const row = _sideEl.querySelector(`.lp-cite-row[data-cite-key="${CSS.escape(refKey)}"]`);
    if (!row) return;
    row.classList.add('lp-cite-row-active');
    row.scrollIntoView({ block: 'nearest', behavior: 'smooth' });
    _flashRect(match.page, match.x, match.y, match.w, match.h);
  }

  function _clearSidebarHighlight() {
    if (!_sideEl) return;
    _sideEl.querySelectorAll('.lp-cite-row-active').forEach(r => r.classList.remove('lp-cite-row-active'));
    _clearFlash();
  }

  // -------------------------------------------------------- public

  function refreshForPage(pageNum) {
    _currentPage = pageNum;
    _scanPage(pageNum);
    _wirePageTokenHover(pageNum);
    _renderPanel();
  }

  /** Re-render the panel without re-scanning text — used after the items
   *  list changes (e.g. a new paper was added via the in-panel button). */
  function refreshLibraryStatus() { _renderPanel(); }

  async function _onAllPagesReady() {
    if (_readyDone) return;
    _readyDone = true;
    _refState = 'parsing';
    _renderPanel();
    try {
      _refs = _parseReferences();
      _refState = (_refs && _refs.length) ? 'ready' : 'none';
    } catch (e) {
      console.warn('[paper-citations] reference parse failed:', e);
      _refs = [];
      _refState = 'none';
    }
    _scanPage(_currentPage);
    if (_viewer && _viewer.numPages) {
      for (let p = 1; p <= _viewer.numPages; p++) _wirePageTokenHover(p);
    }
    _renderPanel();
  }

  function init(opts) {
    _viewer = opts.viewer;
    _item = opts.paperItem;
    _sideEl = opts.sideEl;
    _getAllItems = opts.getAllItems || (() => []);
    _onLibraryChanged = opts.onLibraryChanged || null;
    _readyDone = false;
    _refs = null;
    _refState = 'pending';
    _matchesByPage.clear();
    if (!_sideEl) {
      console.warn('[paper-citations] init: no sideEl, panel will not render');
      return;
    }
    if (_viewer) {
      _currentPage = _viewer.currentPage || 1;
      _scanPage(_currentPage);
      _wirePageTokenHover(_currentPage);
    }
    _renderPanel();
    if (_viewer && typeof _viewer.ready === 'function') {
      _viewer.ready().then(_onAllPagesReady).catch(e => {
        console.warn('[paper-citations] viewer.ready rejected:', e);
      });
    }
  }

  function destroy() {
    _clearFlash();
    _matchesByPage.clear();
    _refs = null;
    if (_sideEl) _sideEl.innerHTML = '';
  }

  window.PAPER_CITATIONS = { init, refreshForPage, refreshLibraryStatus, destroy };
})();
