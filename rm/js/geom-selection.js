/* geom-selection.js — geometric drag-selection over pdf.js text items.
 *
 * Replaces browser-native text selection. The user mousedowns on a page,
 * drags, and releases — we determine which text items are between the
 * start and end points in *visual reading order* (top-to-bottom, then
 * left-to-right within a line). This is independent of pdf.js's stream
 * order, so multi-column layouts no longer paint highlights across
 * unrelated regions.
 *
 * Public API (window.GEOM_SELECTION):
 *   init({viewer, viewerEl, onCommit})
 *   clear()              — wipe the in-progress selection visual
 *   selectedText()       — text of current selection (used by Cmd+C)
 *   selectedAnchors()    — per-page anchors for the current selection
 *   destroy()
 *
 * onCommit(anchors) is called on mouseup with the final per-page anchors.
 * The caller (annotation-overlay) decides whether to show a toolbar or
 * just clear the selection.
 */
(function () {
  let _viewer = null;
  let _viewerEl = null;
  let _onCommit = null;
  let _state = null;        // { startPage, startItemIdx, currentPage, currentItemIdx, anchors }
  let _hasCommitted = false;

  function _pageOfNode(el) {
    while (el && (!el.classList || !el.classList.contains('pv-page-wrap'))) {
      el = el.parentElement;
    }
    return el;
  }

  function _pointToWrapLocal(wrap, clientX, clientY) {
    const r = wrap.getBoundingClientRect();
    return { x: clientX - r.left, y: clientY - r.top };
  }

  /** Find the text item under (x,y) on a page, or the nearest by line. */
  function _itemAtPoint(items, x, y) {
    // Direct hit
    for (const it of items) {
      if (x >= it.x && x <= it.x + it.width && y >= it.y && y <= it.y + it.height) {
        return it;
      }
    }
    // Nearest on the same line (smallest y-distance from line center, then x)
    let best = null, bestScore = Infinity;
    for (const it of items) {
      const yMid = it.y + it.height / 2;
      const yDist = Math.abs(y - yMid);
      // Strongly prefer same-line; tie-break on x-distance
      const xDist = (x < it.x) ? it.x - x : (x > it.x + it.width ? x - (it.x + it.width) : 0);
      const score = yDist * 4 + xDist;
      if (score < bestScore) { bestScore = score; best = it; }
    }
    return best;
  }

  /** Items between two reading-order indices (inclusive), on the same page. */
  function _itemsBetweenOnPage(items, aIdx, bIdx) {
    const lo = Math.min(aIdx, bIdx);
    const hi = Math.max(aIdx, bIdx);
    return items.slice(lo, hi + 1);
  }

  /** Build per-page anchors for the current drag state. */
  function _computeAnchors() {
    if (!_state) return [];
    const { startPage, startItemIdx, currentPage, currentItemIdx } = _state;
    if (currentPage == null || currentItemIdx == null) return [];

    // Determine page span. Reading order across pages is page-by-page.
    const minPage = Math.min(startPage, currentPage);
    const maxPage = Math.max(startPage, currentPage);
    const forward = (currentPage > startPage)
      || (currentPage === startPage && currentItemIdx >= startItemIdx);

    const anchors = [];
    for (let p = minPage; p <= maxPage; p++) {
      const items = _viewer.getTextItems(p);
      if (!items.length) continue;
      let lo, hi;
      if (p === startPage && p === currentPage) {
        lo = Math.min(startItemIdx, currentItemIdx);
        hi = Math.max(startItemIdx, currentItemIdx);
      } else if (p === minPage) {
        // Earliest page: from start (or 0) to end of page
        lo = forward ? (p === startPage ? startItemIdx : 0) : (p === currentPage ? currentItemIdx : 0);
        hi = items.length - 1;
      } else if (p === maxPage) {
        lo = 0;
        hi = forward ? (p === currentPage ? currentItemIdx : items.length - 1) : (p === startPage ? startItemIdx : items.length - 1);
      } else {
        lo = 0;
        hi = items.length - 1;
      }
      lo = Math.max(0, lo); hi = Math.min(items.length - 1, hi);
      if (hi < lo) continue;
      const slice = items.slice(lo, hi + 1);
      const exact = slice.map(it => it.text).join(' ').replace(/\s+/g, ' ').trim();
      const rects = _mergeLineRects(slice.map(it => ({
        x: it.x, y: it.y, width: it.width, height: it.height,
      })));
      anchors.push({
        page: p,
        selectors: {
          textQuote: { exact, prefix: '', suffix: '' },
          // Index range is enough for re-anchoring at the same zoom session;
          // saved_scale lets us re-render at a different zoom.
          textPosition: { start: lo, end: hi },
        },
        rects,
        saved_scale: _viewer.zoom,
      });
    }
    return anchors;
  }

  /** Merge contiguous rects on the same line. */
  function _mergeLineRects(rects) {
    if (rects.length < 2) return rects;
    const sorted = rects.slice().sort((a, b) => a.y - b.y || a.x - b.x);
    const merged = [];
    let cur = Object.assign({}, sorted[0]);
    for (let i = 1; i < sorted.length; i++) {
      const r = sorted[i];
      const sameLine = Math.abs(r.y - cur.y) < 2 && Math.abs(r.height - cur.height) < 2;
      const adjacent = r.x <= cur.x + cur.width + 6;
      if (sameLine && adjacent) {
        const right = Math.max(cur.x + cur.width, r.x + r.width);
        cur.x = Math.min(cur.x, r.x);
        cur.width = right - cur.x;
        cur.height = Math.max(cur.height, r.height);
      } else {
        merged.push(cur);
        cur = Object.assign({}, r);
      }
    }
    merged.push(cur);
    return merged;
  }

  // ---- Render preview rects in each page's selection layer --------------

  function _clearAllSelLayers() {
    if (!_viewer) return;
    _viewer.forEachPage((node) => {
      if (node.selLayer) node.selLayer.innerHTML = '';
    });
  }

  function _renderPreview(anchors) {
    _clearAllSelLayers();
    for (const a of anchors) {
      const node = _viewer.getPageNode(a.page);
      if (!node || !node.selLayer) continue;
      for (const r of a.rects) {
        const div = document.createElement('div');
        div.className = 'pv-sel-rect';
        div.style.left = `${r.x}px`;
        div.style.top = `${r.y}px`;
        div.style.width = `${r.width}px`;
        div.style.height = `${r.height}px`;
        node.selLayer.appendChild(div);
      }
    }
  }

  // ---- Mouse handlers ----------------------------------------------------

  // A click without drag should NOT create a selection. Only after the
  // mouse has moved past this threshold do we treat the gesture as a drag-
  // select and start drawing the preview.
  const DRAG_THRESHOLD_PX = 4;

  function _onMouseDown(ev) {
    if (ev.button !== 0) return;
    const wrap = _pageOfNode(ev.target);
    if (!wrap) return;
    const pageNum = parseInt(wrap.dataset.page, 10);
    if (!pageNum) return;
    const items = _viewer.getTextItems(pageNum);
    if (!items.length) return;
    const { x, y } = _pointToWrapLocal(wrap, ev.clientX, ev.clientY);
    const it = _itemAtPoint(items, x, y);
    if (!it) {
      _state = null;
      _clearAllSelLayers();
      _hasCommitted = false;
      return;
    }
    _state = {
      startPage: pageNum,
      startItemIdx: it.index,
      currentPage: pageNum,
      currentItemIdx: it.index,
      startClientX: ev.clientX,
      startClientY: ev.clientY,
      dragStarted: false,
      anchors: [],
    };
    _hasCommitted = false;
    // Do NOT render a preview yet — wait until the user actually drags.
    document.addEventListener('mousemove', _onMouseMove);
    document.addEventListener('mouseup', _onMouseUp, { once: true });
  }

  function _onMouseMove(ev) {
    if (!_state) return;

    // Only treat as a drag once the mouse has moved past the threshold.
    if (!_state.dragStarted) {
      const dx = ev.clientX - _state.startClientX;
      const dy = ev.clientY - _state.startClientY;
      if (dx * dx + dy * dy < DRAG_THRESHOLD_PX * DRAG_THRESHOLD_PX) return;
      _state.dragStarted = true;
      // First-time render: any existing committed selection from a prior
      // drag should be cleared so we don't stack previews.
      _clearAllSelLayers();
    }

    // Find the page wrap under the mouse (could be a different page than start).
    const target = document.elementFromPoint(ev.clientX, ev.clientY);
    const wrap = _pageOfNode(target);
    if (!wrap) return;
    const pageNum = parseInt(wrap.dataset.page, 10);
    if (!pageNum) return;
    const items = _viewer.getTextItems(pageNum);
    if (!items.length) return;
    const { x, y } = _pointToWrapLocal(wrap, ev.clientX, ev.clientY);
    const it = _itemAtPoint(items, x, y);
    if (!it) return;
    if (pageNum === _state.currentPage && it.index === _state.currentItemIdx) {
      // Same item — but if anchors haven't been computed yet (just crossed
      // the threshold), do it now.
      if (_state.anchors.length === 0) {
        _state.anchors = _computeAnchors();
        _renderPreview(_state.anchors);
      }
      return;
    }
    _state.currentPage = pageNum;
    _state.currentItemIdx = it.index;
    _state.anchors = _computeAnchors();
    _renderPreview(_state.anchors);
  }

  function _onMouseUp(ev) {
    document.removeEventListener('mousemove', _onMouseMove);
    if (!_state) return;
    // Pure click without drag → don't commit anything. Also clears any
    // stale preview that might be lingering from a previous drag.
    if (!_state.dragStarted) {
      _state = null;
      _clearAllSelLayers();
      return;
    }
    const anchors = _state.anchors;
    _hasCommitted = true;
    if (_onCommit) _onCommit(anchors, ev);
  }

  function clear() {
    _state = null;
    _hasCommitted = false;
    _clearAllSelLayers();
  }

  function selectedAnchors() { return (_state && _state.anchors) || []; }

  function selectedText() {
    return (_state && _state.anchors || [])
      .map(a => (a.selectors && a.selectors.textQuote && a.selectors.textQuote.exact) || '')
      .filter(Boolean)
      .join('\n');
  }

  function init(opts) {
    _viewer = opts.viewer;
    _viewerEl = opts.viewerEl;
    _onCommit = opts.onCommit || null;
    _viewerEl.addEventListener('mousedown', _onMouseDown);
  }

  function destroy() {
    if (_viewerEl) _viewerEl.removeEventListener('mousedown', _onMouseDown);
    document.removeEventListener('mousemove', _onMouseMove);
    _state = null;
    _clearAllSelLayers();
  }

  window.GEOM_SELECTION = { init, clear, selectedText, selectedAnchors, destroy };
})();
