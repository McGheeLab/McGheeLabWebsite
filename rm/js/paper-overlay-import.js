/* paper-overlay-import.js — drag-drop a `.paper-overlay.md` file onto the
 * paper reader to materialize the highlights/comments inside it as
 * annotations on the open paper.
 *
 * Format (see also .claude/skills/paper-overlay/SKILL.md):
 *
 *   ---
 *   paper_id: smith2024-gels-microfluidic     # OR paper_doi: 10.1234/foo
 *   bucket_id: proj-gels-1234567              # which overlay these belong to
 *   overlay_title: GELS aim 2 — relevance pass  # (informational, not stored)
 *   created_by: claude                        # (informational)
 *   created_at: 2026-05-08                    # (informational)
 *   ---
 *
 *   ## Highlight
 *   page: 3
 *   quote: "the storage modulus exceeded 10 kPa within 30 seconds"
 *   color: yellow
 *   comment: |
 *     Directly supports our claim that the gel sets fast enough.
 *   cite_in_drafts: [prostate-gels-r01]
 *
 *   ## Highlight
 *   ...
 *
 * Public API (window.PAPER_OVERLAY_IMPORT):
 *   init({viewer, paperItem, allItems, paperId, getCurrentPage, onImported})
 *   handleDrop(file)
 */
(function () {
  let _viewer = null;
  let _paperItem = null;
  let _allItems = [];
  let _paperId = null;
  let _onImported = null;
  // V3.294 — track the wired viewer element + its drag/drop handlers so a
  // tab switch re-targets the dropzone to the new active pane instead of
  // stacking a second set of listeners (which would fire handleDrop N times).
  let _dropWired = null;   // { el, enter, over, leave, drop }

  // ---------------------------------------------------------------- minimal YAML

  /** Parse a tiny subset of YAML used in our frontmatter:
   *    - "key: value"            → string
   *    - "key: [a, b, c]"        → array of strings
   *    - "key: |"                → next indented (or same-block) lines until next key
   *    - blank lines preserved in `|` blocks
   */
  function _parseKeyValueBlock(lines) {
    const out = {};
    for (let i = 0; i < lines.length; i++) {
      const line = lines[i];
      const m = /^([a-zA-Z_][a-zA-Z0-9_]*)\s*:\s*(.*)$/.exec(line);
      if (!m) continue;
      const key = m[1];
      const tail = m[2];
      if (tail === '|' || tail === '|-' || tail === '|+') {
        // Multi-line block. Collect subsequent lines until the next
        // top-level key (line matching ^[a-zA-Z_]\w*\s*:).
        const buf = [];
        let j = i + 1;
        while (j < lines.length) {
          const nx = lines[j];
          if (/^[a-zA-Z_][a-zA-Z0-9_]*\s*:/.test(nx)) break;
          // Strip a single leading indent (2 spaces) if present.
          buf.push(nx.replace(/^ {2}/, ''));
          j++;
        }
        out[key] = buf.join('\n').trim();
        i = j - 1;
        continue;
      }
      if (/^\[.*\]$/.test(tail.trim())) {
        const inner = tail.trim().slice(1, -1).trim();
        out[key] = inner ? inner.split(',').map(s => s.trim().replace(/^["']|["']$/g, '')) : [];
        continue;
      }
      // Plain string value, with optional surrounding quotes.
      out[key] = tail.trim().replace(/^["']|["']$/g, '');
    }
    return out;
  }

  /** Top-level parse: split frontmatter from body, then split body on
   *  `## Highlight`. Returns {frontmatter, highlights: [{...}]}. */
  function parseOverlayMarkdown(text) {
    if (typeof text !== 'string') throw new Error('parseOverlayMarkdown: expected string');
    const lines = text.replace(/\r\n/g, '\n').split('\n');
    let i = 0;
    let fm = {};
    if (lines[0] && /^---\s*$/.test(lines[0])) {
      const start = 1;
      let end = -1;
      for (let j = start; j < lines.length; j++) {
        if (/^---\s*$/.test(lines[j])) { end = j; break; }
      }
      if (end < 0) throw new Error('Frontmatter open `---` has no matching close.');
      fm = _parseKeyValueBlock(lines.slice(start, end));
      i = end + 1;
    }

    const highlights = [];
    let cur = null;
    let curBuf = [];
    function flush() {
      if (cur === null) return;
      highlights.push(_parseKeyValueBlock(curBuf));
      cur = null;
      curBuf = [];
    }
    for (; i < lines.length; i++) {
      const line = lines[i];
      if (/^##\s+Highlight\s*$/i.test(line.trim())) {
        flush();
        cur = {};
        curBuf = [];
        continue;
      }
      if (cur !== null) curBuf.push(line);
    }
    flush();
    return { frontmatter: fm, highlights };
  }

  // ---------------------------------------------------------------- quote → anchor

  /** Concatenate a page's text items into a string, with offset bookkeeping. */
  function _pageText(pageNum) {
    const items = _viewer.getTextItems(pageNum) || [];
    if (!items.length) return null;
    const parts = [];
    let off = 0;
    const ranges = [];
    for (const it of items) {
      parts.push(it.text);
      ranges.push({ start: off, end: off + it.text.length, item: it });
      off += it.text.length + 1;
      parts.push(' ');
    }
    return { fullText: parts.join(''), ranges };
  }

  function _normalize(s) {
    return String(s || '').toLowerCase().replace(/\s+/g, ' ').trim();
  }

  /** Find the quote inside the page's text. Returns matched items or null.
   *  Uses normalized whitespace + case-insensitive match. */
  function _matchQuoteOnPage(pageNum, quote) {
    const tx = _pageText(pageNum);
    if (!tx) return null;
    const norm = _normalize(quote);
    if (!norm.length) return null;
    // Scan a normalized variant of the page text and reverse-map indices.
    // Cheaper approach: greedy pattern walk over fullText with a flexible
    // whitespace regex. Build a regex that turns each whitespace run in
    // the quote into \s+ and escapes everything else.
    const quoteEscaped = quote
      .trim()
      .replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
      .replace(/\s+/g, '\\s+');
    let m;
    try {
      const re = new RegExp(quoteEscaped, 'i');
      m = re.exec(tx.fullText);
    } catch (_) {
      return null;
    }
    if (!m) return null;
    const start = m.index;
    const end = start + m[0].length;
    const hits = [];
    for (const r of tx.ranges) {
      if (r.start >= end) break;
      if (r.end <= start) continue;
      hits.push(r.item);
    }
    return hits.length ? hits : null;
  }

  /** Compute one bounding rect per visual line over the matched items. */
  function _itemsToLineRects(items) {
    if (!items.length) return [];
    const sorted = items.slice().sort((a, b) => (a.y - b.y) || (a.x - b.x));
    const lineH = sorted.reduce((s, it) => s + it.height, 0) / sorted.length || 12;
    const lines = [];
    let cur = null;
    for (const it of sorted) {
      if (!cur || Math.abs((it.y + it.height / 2) - (cur.cy)) > lineH * 0.6) {
        if (cur) lines.push(cur);
        cur = { x: it.x, y: it.y, h: it.height, w: it.width, cy: it.y + it.height / 2 };
      } else {
        cur.x = Math.min(cur.x, it.x);
        cur.y = Math.min(cur.y, it.y);
        const right = Math.max(cur.x + cur.w, it.x + it.width);
        const bot = Math.max(cur.y + cur.h, it.y + it.height);
        cur.w = right - cur.x;
        cur.h = bot - cur.y;
        cur.cy = (cur.cy + (it.y + it.height / 2)) / 2;
      }
    }
    if (cur) lines.push(cur);
    return lines.map(l => ({ x: l.x, y: l.y, width: l.w, height: l.h }));
  }

  /** Build a page-anchor for a matched quote on a page. */
  function _buildAnchor(pageNum, quote, items) {
    const rects = _itemsToLineRects(items);
    return {
      page: pageNum,
      rects,
      saved_scale: _viewer.zoom,
      selectors: { textQuote: { exact: quote.trim() } },
    };
  }

  // ---------------------------------------------------------------- validate

  /** Returns {ok, errors:[], paperOk:bool, bucketOk:bool, perHighlight:[...]} */
  async function validate(parsed) {
    const errors = [];
    const fm = parsed.frontmatter || {};
    let paperOk = true;
    if (fm.paper_id) {
      if (fm.paper_id !== _paperId) {
        paperOk = false;
        errors.push(`paper_id "${fm.paper_id}" does not match the open paper "${_paperId}".`);
      }
    } else if (fm.paper_doi) {
      const norm = String(fm.paper_doi).toLowerCase().replace(/[.,;)]+$/, '');
      const lib = (_paperItem && _paperItem.meta && _paperItem.meta.library) || {};
      const ourDoi = (lib.doi || '').toLowerCase();
      if (ourDoi !== norm) {
        paperOk = false;
        errors.push(`paper_doi "${fm.paper_doi}" does not match the open paper's DOI "${ourDoi || '(none)'}".`);
      }
    } else {
      paperOk = false;
      errors.push('Missing `paper_id` (or `paper_doi`) in frontmatter.');
    }

    // V3.103 — frontmatter `draft_id` (preferred) or legacy `bucket_id`
    // (kept for back-compat with .paper-overlay.md files written by the
    // /paper-overlay skill before V3.103). V3.188 — `grant` / `grant_id`
    // alias for when the file came from a sibling grant repo. All four
    // resolve to the same semantic: the highlights' cite_in_drafts target.
    const draftIdRaw = fm.draft_id || fm.grant || fm.grant_id || fm.bucket_id || '';
    let draftOk = true;
    let draftTitle = '';
    if (draftIdRaw && window.PAPER_OVERLAYS) {
      const linked = window.PAPER_OVERLAYS.getLinkedDrafts
        ? window.PAPER_OVERLAYS.getLinkedDrafts()
        : (window.PAPER_OVERLAYS.getLinkedBuckets() || []);
      const found = linked.find(d => d.id === draftIdRaw);
      if (found) {
        draftTitle = found.title;
      } else {
        // Draft exists in the lab but isn't linked to this paper. Offer
        // to link it on confirm. Soft-warn rather than hard-fail.
        draftOk = 'unlinked';
        errors.push(`${fm.draft_id ? 'draft_id' : 'bucket_id'} "${draftIdRaw}" is not currently linked to this paper. We'll offer to link it on import.`);
      }
    }

    // V3.188 — closed annotation_type enum. `type:` per highlight is
    // optional; missing or unknown values fall back to 'note'.
    const VALID_TYPES = new Set(['evidence', 'method', 'result', 'limitation', 'claim', 'note', 'question', 'quote']);

    const perHighlight = [];
    for (let i = 0; i < (parsed.highlights || []).length; i++) {
      const h = parsed.highlights[i];
      const issues = [];
      const page = parseInt(h.page, 10);
      if (isNaN(page) || page < 1) issues.push(`page must be a positive integer (got "${h.page}")`);
      const quote = (h.quote || '').replace(/^["']|["']$/g, '').trim();
      if (!quote) issues.push('quote is empty');
      let matched = null;
      if (!isNaN(page) && quote) {
        matched = _matchQuoteOnPage(page, quote);
      }
      const rawType = (h.type || h.annotation_type || '').toLowerCase().trim();
      const annotation_type = VALID_TYPES.has(rawType) ? rawType : 'note';
      perHighlight.push({
        index: i,
        page,
        quote,
        comment: h.comment || '',
        color: h.color || 'yellow',
        annotation_type,
        cite_in_drafts: Array.isArray(h.cite_in_drafts) ? h.cite_in_drafts : [],
        evidence_stance: h.evidence_stance || null,
        matched: !!matched,
        matchedItems: matched,
        issues,
      });
    }

    return {
      ok: paperOk && (draftOk === true || draftOk === 'unlinked'),
      errors,
      paperOk,
      // V3.103 — fields renamed from bucket* to draft*. bucket* aliases
      // kept for any legacy callers (just preview-modal display logic).
      draftOk,
      draftTitle,
      draftId: draftIdRaw,
      bucketOk: draftOk,
      bucketTitle: draftTitle,
      bucketId: draftIdRaw,
      perHighlight,
      filename: parsed.__filename || '',
      overlayTitle: fm.overlay_title || '',
    };
  }

  // ---------------------------------------------------------------- preview modal

  function _esc(s) {
    return String(s ?? '').replace(/[&<>"']/g, c =>
      ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c])
    );
  }

  function _showPreviewModal(parsed, validation, onConfirm) {
    const existing = document.getElementById('lp-overlay-import-modal');
    if (existing) existing.remove();
    const modal = document.createElement('div');
    modal.id = 'lp-overlay-import-modal';
    modal.className = 'lp-overlay-import-modal';
    const matchedCount = validation.perHighlight.filter(h => h.matched && !h.issues.length).length;
    const unmatchedCount = validation.perHighlight.length - matchedCount;
    modal.innerHTML = `
      <div class="lp-oim-backdrop"></div>
      <div class="lp-oim-card">
        <div class="lp-oim-head">
          Import overlay
          <span class="lp-oim-filename">${_esc(validation.filename || 'overlay.md')}</span>
        </div>
        <div class="lp-oim-summary">
          <strong>${matchedCount}</strong> highlights matched ·
          <strong>${unmatchedCount}</strong> unmatched ·
          target draft: <code>${_esc(validation.draftTitle || validation.draftId || '(none)')}</code>
          ${validation.draftOk === 'unlinked' ? `<span class="lp-oim-warn">  Draft not linked yet — will link on import.</span>` : ''}
        </div>
        ${validation.errors.length ? `
          <div class="lp-oim-errors">
            ${validation.errors.map(e => `<div>• ${_esc(e)}</div>`).join('')}
          </div>` : ''}
        <div class="lp-oim-list">
          ${validation.perHighlight.map((h, i) => `
            <div class="lp-oim-row ${h.matched && !h.issues.length ? 'lp-oim-row-ok' : 'lp-oim-row-bad'}">
              <div class="lp-oim-row-head">
                <span class="lp-oim-page">p.${h.page || '?'}</span>
                <span class="lp-oim-type lp-type-${_esc(h.annotation_type || 'note')}" style="font-size:10px;padding:1px 6px;border-radius:3px;background:#eef2ff;color:#3730a3;">${_esc(h.annotation_type || 'note')}</span>
                <span class="lp-oim-status">${h.matched ? '✓ matched' : '⚠ no match in page text'}</span>
                <label class="lp-oim-include">
                  <input type="checkbox" data-oim-i="${i}" ${h.matched && !h.issues.length ? 'checked' : ''} ${!h.matched ? 'disabled' : ''}>
                  include
                </label>
              </div>
              <div class="lp-oim-quote">${_esc(h.quote.slice(0, 200))}${h.quote.length > 200 ? '…' : ''}</div>
              ${h.comment ? `<div class="lp-oim-comment">${_esc(h.comment.slice(0, 280))}</div>` : ''}
              ${h.issues.length ? `<div class="lp-oim-issues">${h.issues.map(_esc).join(' · ')}</div>` : ''}
            </div>
          `).join('')}
        </div>
        <div class="lp-oim-foot">
          <button class="btn btn-sm" id="lp-oim-cancel">Cancel</button>
          <button class="btn btn-sm lp-oim-primary" id="lp-oim-confirm" ${validation.paperOk ? '' : 'disabled'}>
            Import ${matchedCount} highlights
          </button>
        </div>
      </div>
    `;
    document.body.appendChild(modal);

    const close = () => modal.remove();
    modal.querySelector('.lp-oim-backdrop').addEventListener('click', close);
    modal.querySelector('#lp-oim-cancel').addEventListener('click', close);
    modal.querySelector('#lp-oim-confirm').addEventListener('click', async () => {
      const includes = new Set();
      modal.querySelectorAll('input[data-oim-i]').forEach(cb => {
        if (cb.checked) includes.add(parseInt(cb.getAttribute('data-oim-i'), 10));
      });
      const filtered = validation.perHighlight.filter(h => includes.has(h.index));
      const btn = modal.querySelector('#lp-oim-confirm');
      btn.disabled = true;
      btn.textContent = 'Importing…';
      try {
        await onConfirm(filtered);
        btn.textContent = '✓ Imported';
        setTimeout(close, 600);
      } catch (e) {
        console.error('[paper-overlay-import] confirm failed:', e);
        btn.disabled = false;
        btn.textContent = `Error: ${(e.message || e).toString().slice(0, 60)}`;
      }
    });
  }

  // ---------------------------------------------------------------- import

  async function _importHighlights(highlights, validation) {
    if (!window.ANNOTATION_SYNC || !window.ANNOTATION_SYNC.create) {
      throw new Error('ANNOTATION_SYNC not loaded');
    }
    const draftId = validation.draftId || validation.bucketId;
    // V3.103 — if the draft exists in items.json but isn't linked to
    // this paper yet, link it now via PAPER_OVERLAYS.linkDraft (writes
    // meta.library.linked_drafts). Pre-V3.103 this was LINKS.addLink to
    // a project bucket — that's gone now that the paper reader doesn't
    // own bucket linkage.
    if (draftId && validation.draftOk === 'unlinked' && window.PAPER_OVERLAYS && window.PAPER_OVERLAYS.linkDraft) {
      try {
        await window.PAPER_OVERLAYS.linkDraft(draftId);
      } catch (e) {
        console.warn('[paper-overlay-import] could not link draft:', e);
      }
    }
    let written = 0;
    for (const h of highlights) {
      if (!h.matched || !h.matchedItems || h.issues.length) continue;
      const anchor = _buildAnchor(h.page, h.quote, h.matchedItems);
      // Compose cite_in_drafts: union of any per-highlight cite_in_drafts
      // (from frontmatter `cite_in_drafts: [...]`) and the file-level
      // draft_id. Empty array = "general" highlight that always renders.
      const draftSet = new Set();
      if (Array.isArray(h.cite_in_drafts)) h.cite_in_drafts.forEach(id => draftSet.add(id));
      if (draftId) draftSet.add(draftId);
      const cite_in_drafts = Array.from(draftSet);
      const payload = {
        color_id: h.color || 'yellow',
        comment: h.comment || '',
        target: { pages: [anchor] },
        cite_in_drafts,
        evidence_stance: h.evidence_stance,
        annotation_type: h.annotation_type || 'note',  // V3.188 — closed enum
        source: 'overlay-md',
        source_file: validation.filename || '',
      };
      // Idempotency: skip if an identical (quote, page, draft) already exists.
      const allList = _getCurrentAnnotations ? _getCurrentAnnotations() : [];
      const existing = allList.find(a => {
        const ap = (a.target && a.target.pages && a.target.pages[0]) || {};
        const aq = (ap.selectors && ap.selectors.textQuote && ap.selectors.textQuote.exact) || '';
        const aDrafts = Array.isArray(a.cite_in_drafts) ? a.cite_in_drafts : [];
        const sameDraft = draftId
          ? aDrafts.includes(draftId)
          : aDrafts.length === 0;
        return ap.page === h.page && aq.trim() === h.quote.trim() && sameDraft;
      });
      if (existing) continue;
      await window.ANNOTATION_SYNC.create(_paperId, payload);
      written++;
    }
    if (typeof _onImported === 'function') {
      try { _onImported({ written, skipped: highlights.length - written }); } catch (_) { /* ignore */ }
    }
    return written;
  }

  // ---------------------------------------------------------------- public

  let _getCurrentAnnotations = null;

  async function handleDrop(file) {
    if (!file || !/\.(md|markdown)$/i.test(file.name)) {
      console.warn('[paper-overlay-import] not an .md file, ignoring:', file && file.name);
      return;
    }
    if (!_viewer) {
      alert('Paper viewer not ready yet.');
      return;
    }
    const text = await file.text();
    const parsed = parseOverlayMarkdown(text);
    parsed.__filename = file.name;
    const validation = await validate(parsed);
    validation.filename = file.name;
    _showPreviewModal(parsed, validation, async (filtered) => {
      await _importHighlights(filtered, validation);
    });
  }

  function _unwireDropZone() {
    if (!_dropWired) return;
    const { el, enter, over, leave, drop } = _dropWired;
    el.removeEventListener('dragenter', enter);
    el.removeEventListener('dragover', over);
    el.removeEventListener('dragleave', leave);
    el.removeEventListener('drop', drop);
    _dropWired = null;
  }

  function _wireDropZone(viewerEl) {
    // V3.294 — accept the active pane explicitly (falls back to the active
    // pane via its id). Re-targeting on tab switch: drop the prior set of
    // listeners first so handleDrop never fires more than once per drop.
    viewerEl = viewerEl || document.getElementById('lp-viewer');
    if (!viewerEl) return;
    _unwireDropZone();
    let banner = document.getElementById('lp-md-dropzone');
    if (!banner) {
      banner = document.createElement('div');
      banner.id = 'lp-md-dropzone';
      banner.className = 'lp-md-dropzone';
      banner.style.display = 'none';
      banner.innerHTML = `
        <div class="lp-md-dropzone-inner">
          Drop a <code>.paper-overlay.md</code> file to import highlights as an overlay
        </div>
      `;
    }
    // The banner is a single shared node; re-parent it into the active pane.
    if (banner.parentElement !== viewerEl) viewerEl.appendChild(banner);
    let dragDepth = 0;
    const enter = (ev) => {
      // Only handle external file drags. dataTransfer.types contains "Files"
      // for OS-level file drags.
      if (!ev.dataTransfer || !Array.from(ev.dataTransfer.types).includes('Files')) return;
      ev.preventDefault();
      dragDepth++;
      banner.style.display = 'flex';
    };
    const over = (ev) => {
      if (!ev.dataTransfer || !Array.from(ev.dataTransfer.types).includes('Files')) return;
      ev.preventDefault();
      ev.dataTransfer.dropEffect = 'copy';
    };
    const leave = (ev) => {
      if (!ev.dataTransfer || !Array.from(ev.dataTransfer.types).includes('Files')) return;
      dragDepth = Math.max(0, dragDepth - 1);
      if (dragDepth === 0) banner.style.display = 'none';
    };
    const drop = (ev) => {
      if (!ev.dataTransfer) return;
      ev.preventDefault();
      dragDepth = 0;
      banner.style.display = 'none';
      const files = Array.from(ev.dataTransfer.files || []);
      const md = files.find(f => /\.(md|markdown)$/i.test(f.name));
      if (!md) return;
      handleDrop(md);
    };
    viewerEl.addEventListener('dragenter', enter);
    viewerEl.addEventListener('dragover', over);
    viewerEl.addEventListener('dragleave', leave);
    viewerEl.addEventListener('drop', drop);
    _dropWired = { el: viewerEl, enter, over, leave, drop };
  }

  function init(opts) {
    _viewer = opts.viewer;
    _paperItem = opts.paperItem;
    _allItems = opts.allItems || [];
    _paperId = opts.paperId || (_paperItem && _paperItem.id) || '';
    _onImported = opts.onImported || null;
    _getCurrentAnnotations = opts.getCurrentAnnotations || (() => []);
    _wireDropZone(opts.viewerEl);
  }

  // V3.294 — tear down for tab switches: drop the drag/drop listeners.
  function destroy() {
    _unwireDropZone();
    _viewer = null;
    _paperItem = null;
    _paperId = null;
  }

  window.PAPER_OVERLAY_IMPORT = {
    init,
    handleDrop,
    parseOverlayMarkdown,
    validate,
    destroy,
  };
})();
