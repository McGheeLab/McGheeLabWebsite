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
 *   setMarquee(on)       — arm/disarm free-rectangle marquee mode (V3.610)
 *   isMarquee()
 *   setArmed(on)         — arm/disarm touch highlight mode (V3.613)
 *   isArmed()
 *   destroy()
 *
 * onCommit(anchors) is called on mouseup with the final per-page anchors.
 * The caller (annotation-overlay) decides whether to show a toolbar or
 * just clear the selection.
 *
 * V3.610 — MARQUEE mode: text-item selection can't grab a figure (items
 * only cover text), so when armed via setMarquee(true) — or per-gesture
 * with Alt held — a drag draws a free rectangle on one page and commits a
 * single anchor {page, rects:[r], saved_scale, marquee:true} with NO
 * selectors. Downstream consumers that need text (textQuote) skip it;
 * the snip flows (equation/figure capture) only need the rect.
 *
 * V3.613 — TOUCH input (the Ourlab mobile reader). One Pointer Events
 * state machine serves mouse + touch/pen:
 *   • mouse — identical to the historical mousedown/mousemove/mouseup
 *     behavior (button 0, 4px drag threshold, document-level listeners,
 *     no pointer capture, no timers). Zero behavior change on desktop.
 *   • touch, unarmed — LONG-PRESS (380ms within an 8px slop) starts a
 *     selection at the pressed word (pulsing preview), then dragging
 *     extends it; a plain one-finger drag scrolls normally because we
 *     only preventDefault() the non-passive touchmove while a selection
 *     is live. A second finger always cancels (pinch wins upstream).
 *   • touch, armed (setArmed(true) — the 🖍 mobile toggle) — one-finger
 *     drag selects immediately (4px threshold, like mouse); the page
 *     also flips to touch-action:none via CSS so nothing scrolls.
 *   Edge auto-scroll (48px zones) keeps multi-page touch selections
 *   possible — the finger can't leave the screen.
 * Browsers without PointerEvent fall back to the legacy mouse trio.
 */
(function () {
  let _viewer = null;
  let _viewerEl = null;
  let _onCommit = null;
  let _state = null;        // { startPage, startItemIdx, currentPage, currentItemIdx, anchors }
  let _hasCommitted = false;
  let _marqueeArmed = false;
  let _armed = false;       // V3.613 — touch highlight mode (🖍)

  function _pageOfNode(el) {
    // V3.620 — the create popover is a CHILD of the page wrap (it has to
    // scroll with the selection), so pointer events inside it must never
    // read as "on the page": a textarea drag would otherwise start a new
    // selection gesture and destroy the popover mid-typing.
    if (el && el.closest && el.closest('.ann-popover')) return null;
    while (el && (!el.classList || !el.classList.contains('pv-page-wrap'))) {
      el = el.parentElement;
    }
    return el;
  }

  function _pointToWrapLocal(wrap, clientX, clientY) {
    const r = wrap.getBoundingClientRect();
    return { x: clientX - r.left, y: clientY - r.top };
  }

  /** Find the text item under (x,y) on a page, or the nearest by line.
   *  V3.372 — `preferCluster` (the drag anchor's cluster) adds a penalty to
   *  the nearest-fallback for items in a DIFFERENT block, so a cursor that
   *  drifts over the gutter snaps back to the anchor's column instead of
   *  jumping to the neighbouring one. A DIRECT hit still wins outright, so
   *  a deliberate click into another column works. */
  function _itemAtPoint(items, x, y, preferCluster) {
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
      let score = yDist * 4 + xDist;
      if (preferCluster != null && it.cluster != null && it.cluster !== preferCluster) {
        score += 1e5;   // soft: cross-block only when there's no in-block candidate
      }
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

  /* V3.621 — saved_scale's contract is "the zoom these rects are in". The
   * rects come from text items measured at the page's LAST RENDER
   * (node.itemsZoom), but pdf-viewer.setZoom flips viewer.zoom BEFORE its
   * sequential page re-renders — a drag in that window used to stamp the
   * NEW zoom onto OLD-zoom rects, producing a permanently mis-scaled
   * highlight. Stamp the measurement zoom instead; anchorToRects then
   * rescales correctly at any future zoom. */
  function _scaleForPage(p) {
    const node = _viewer.getPageNode && _viewer.getPageNode(p);
    return (node && node.itemsZoom != null) ? node.itemsZoom : _viewer.zoom;
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
      let slice = items.slice(lo, hi + 1);
      // V3.372 — block-aware clamp: this is the hard guarantee against the
      // "highlight bridges into another section" symptom. The engine
      // (page-layout.js) stamps every item with `cluster` (block id) and
      // `column` (−1 = full-width). We restrict the raw index-slice so it
      // cannot leak into an unrelated block:
      //   • same-cluster drag (the overwhelmingly common paragraph/sentence
      //     case) → keep ONLY that cluster — a selection physically cannot
      //     escape its block;
      //   • cross-block drag → keep only the endpoint columns, dropping any
      //     full-width band (abstract/caption/footnote) the raw slice spanned.
      // Degrades to a no-op when items carry no cluster/column (engine
      // absent) so nothing breaks.
      const aItem = (p === startPage) ? items[startItemIdx] : null;
      const fItem = (p === currentPage) ? items[currentItemIdx] : null;
      const endpoint = aItem || fItem;
      if (endpoint && endpoint.cluster != null) {
        if (aItem && fItem) {
          if (aItem.cluster === fItem.cluster) {
            const cc = aItem.cluster;
            slice = slice.filter(it => it.cluster === cc);
          } else {
            const cols = new Set([aItem.column, fItem.column]);
            slice = slice.filter(it => cols.has(it.column));
            // V3.373 — a cross-block body drag drops margin furniture
            // (caption/footnote/header/footer/pagenum/sidenote) it spanned,
            // UNLESS an endpoint is itself inside furniture (then the user
            // is selecting that furniture and we keep its type).
            const FURN = (window.PAGE_LAYOUT && PAGE_LAYOUT.FURNITURE_TYPES) || [];
            const endTypes = new Set([aItem.blockType, fItem.blockType]);
            slice = slice.filter(it =>
              !FURN.includes(it.blockType) || endTypes.has(it.blockType));
          }
        } else {
          // One endpoint on this page (multi-page drag): keep its column so
          // the first/last page doesn't grab the neighbouring column.
          const col = endpoint.column;
          if (col != null) slice = slice.filter(it => it.column === col);
        }
        if (!slice.length) continue;
      }
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
        saved_scale: _scaleForPage(p),
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

  function _renderPreview(anchors, pulse) {
    _clearAllSelLayers();
    for (const a of anchors) {
      const node = _viewer.getPageNode(a.page);
      if (!node || !node.selLayer) continue;
      for (const r of a.rects) {
        const div = document.createElement('div');
        div.className = 'pv-sel-rect' + (pulse ? ' pv-sel-pulse' : '');
        div.style.left = `${r.x}px`;
        div.style.top = `${r.y}px`;
        div.style.width = `${r.width}px`;
        div.style.height = `${r.height}px`;
        node.selLayer.appendChild(div);
      }
    }
  }

  // ---- Gesture core (input-agnostic) --------------------------------------

  // A click without drag should NOT create a selection. Only after the
  // pointer has moved past this threshold do we treat the gesture as a drag-
  // select and start drawing the preview.
  const DRAG_THRESHOLD_PX = 4;
  // V3.613 — touch tuning.
  const TOUCH_SLOP_PX = 8;       // movement allowed before a long-press dies
  const LONG_PRESS_MS = 380;     // hold time to enter selection (unarmed)
  const EDGE_ZONE_PX = 48;       // auto-scroll band at viewer top/bottom
  const EDGE_MAX_STEP = 14;      // max px scrolled per frame at zone edge

  /** Start a gesture at (clientX, clientY) on the given page wrap.
   *  Returns true when a selection state was created. Shared by the mouse
   *  path (verbatim pre-V3.613 behavior) and the touch path. */
  function _beginGesture(wrap, pageNum, clientX, clientY, marquee) {
    // V3.610 — marquee gesture: armed mode or Alt-drag. Free rectangle on
    // one page, independent of text items (that's the point — figures
    // have none).
    if (marquee) {
      const p0 = _pointToWrapLocal(wrap, clientX, clientY);
      _state = {
        marquee: true,
        wrap,
        startPage: pageNum,
        mStartX: p0.x, mStartY: p0.y,
        startClientX: clientX,
        startClientY: clientY,
        dragStarted: false,
        anchors: [],
      };
      _hasCommitted = false;
      return true;
    }
    const items = _viewer.getTextItems(pageNum);
    if (!items.length) return false;
    const { x, y } = _pointToWrapLocal(wrap, clientX, clientY);
    const it = _itemAtPoint(items, x, y);
    if (!it) {
      _state = null;
      _clearAllSelLayers();
      _hasCommitted = false;
      return false;
    }
    _state = {
      startPage: pageNum,
      startItemIdx: it.index,
      startCluster: it.cluster,     // V3.372 — anchor block for the drag clamp
      currentPage: pageNum,
      currentItemIdx: it.index,
      startClientX: clientX,
      startClientY: clientY,
      dragStarted: false,
      anchors: [],
    };
    _hasCommitted = false;
    return true;
  }

  /** Extend the current gesture to (clientX, clientY). Shared body of the
   *  historical _onMouseMove — behavior unchanged. */
  function _moveGesture(clientX, clientY) {
    if (!_state) return;

    // Only treat as a drag once the pointer has moved past the threshold.
    if (!_state.dragStarted) {
      const dx = clientX - _state.startClientX;
      const dy = clientY - _state.startClientY;
      if (dx * dx + dy * dy < DRAG_THRESHOLD_PX * DRAG_THRESHOLD_PX) return;
      _state.dragStarted = true;
      // First-time render: any existing committed selection from a prior
      // drag should be cleared so we don't stack previews.
      _clearAllSelLayers();
    }

    // V3.610 — marquee drag: one free rect, clamped to the start page.
    if (_state.marquee) {
      const p = _pointToWrapLocal(_state.wrap, clientX, clientY);
      const W = _state.wrap.clientWidth, H = _state.wrap.clientHeight;
      const cx = Math.max(0, Math.min(W, p.x));
      const cy = Math.max(0, Math.min(H, p.y));
      const r = {
        x: Math.min(_state.mStartX, cx),
        y: Math.min(_state.mStartY, cy),
        width: Math.abs(cx - _state.mStartX),
        height: Math.abs(cy - _state.mStartY),
      };
      _state.anchors = (r.width < 3 || r.height < 3) ? [] : [{
        page: _state.startPage,
        rects: [r],
        // V3.621 — marquee rects are measured against the wrap's CURRENT
        // rendered size, which is the last-render zoom (itemsZoom), not
        // necessarily viewer.zoom mid-transition.
        saved_scale: _scaleForPage(_state.startPage),
        marquee: true,
      }];
      _renderPreview(_state.anchors);
      return;
    }

    // Find the page wrap under the pointer (could be a different page than start).
    const target = document.elementFromPoint(clientX, clientY);
    const wrap = _pageOfNode(target);
    if (!wrap) return;
    const pageNum = parseInt(wrap.dataset.page, 10);
    if (!pageNum) return;
    const items = _viewer.getTextItems(pageNum);
    if (!items.length) return;
    const { x, y } = _pointToWrapLocal(wrap, clientX, clientY);
    // V3.372 — prefer the anchor's block on the SAME page so a cursor that
    // grazes the gutter doesn't snap the focus into the other column. On a
    // different page there's no shared block, so don't bias.
    const prefer = (pageNum === _state.startPage) ? _state.startCluster : null;
    const it = _itemAtPoint(items, x, y, prefer);
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

  /** End the current gesture. Shared body of the historical _onMouseUp. */
  function _endGesture(ev) {
    if (!_state) return;
    // Pure click/tap without drag → don't commit anything. Also clears any
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

  // ---- Mouse path (pointer events; behavior identical to pre-V3.613) ------

  function _onPointerDownMouse(ev) {
    if (ev.button !== 0) return;
    const wrap = _pageOfNode(ev.target);
    if (!wrap) return;
    const pageNum = parseInt(wrap.dataset.page, 10);
    if (!pageNum) return;
    const marquee = _marqueeArmed || ev.altKey;
    if (!_beginGesture(wrap, pageNum, ev.clientX, ev.clientY, marquee)) return;
    if (marquee) ev.preventDefault();
    document.addEventListener('pointermove', _onDocPointerMoveMouse);
    document.addEventListener('pointerup', _onDocPointerUpMouse, { once: true });
  }

  function _onDocPointerMoveMouse(ev) {
    if (ev.pointerType !== 'mouse') return;
    _moveGesture(ev.clientX, ev.clientY);
  }

  function _onDocPointerUpMouse(ev) {
    document.removeEventListener('pointermove', _onDocPointerMoveMouse);
    _endGesture(ev);
  }

  // ---- Touch / pen path (V3.613) -------------------------------------------

  const _touch = {
    pointerId: null,
    timer: null,
    selecting: false,
    startX: 0, startY: 0,   // press origin (long-press slop check)
    lastX: 0, lastY: 0,
    moveRaf: 0,
    edgeRaf: 0,
    captured: false,
  };

  function _resetTouch() {
    if (_touch.timer) { clearTimeout(_touch.timer); _touch.timer = null; }
    if (_touch.moveRaf) { cancelAnimationFrame(_touch.moveRaf); _touch.moveRaf = 0; }
    if (_touch.edgeRaf) { cancelAnimationFrame(_touch.edgeRaf); _touch.edgeRaf = 0; }
    if (_touch.captured && _touch.pointerId != null && _viewerEl) {
      try { _viewerEl.releasePointerCapture(_touch.pointerId); } catch (_) { /* gone */ }
    }
    _touch.pointerId = null;
    _touch.selecting = false;
    _touch.captured = false;
    document.removeEventListener('pointermove', _onDocPointerMoveTouch);
    document.removeEventListener('pointerup', _onDocPointerUpTouch);
    document.removeEventListener('pointercancel', _onDocPointerCancelTouch);
  }

  /** Cancel an in-flight touch gesture (second finger / pointercancel). */
  function _cancelTouch() {
    const wasSelecting = _touch.selecting;
    _resetTouch();
    if (wasSelecting) {
      _state = null;
      _clearAllSelLayers();
    }
  }

  function _startTouchSelecting(pointerId) {
    _touch.selecting = true;
    try {
      _viewerEl.setPointerCapture(pointerId);
      _touch.captured = true;
    } catch (_) { _touch.captured = false; }
    if (!_touch.edgeRaf) _touch.edgeRaf = requestAnimationFrame(_edgeTick);
  }

  /** Edge auto-scroll loop: while a touch selection is live and the finger
   *  sits in the top/bottom band, scroll the viewer and re-extend the
   *  selection (content moves under a stationary finger). */
  function _edgeTick() {
    _touch.edgeRaf = 0;
    if (!_touch.selecting || !_viewerEl) return;
    const r = _viewerEl.getBoundingClientRect();
    const y = _touch.lastY;
    let dy = 0;
    if (y < r.top + EDGE_ZONE_PX) {
      dy = -Math.ceil(Math.min(1, (r.top + EDGE_ZONE_PX - y) / EDGE_ZONE_PX) * EDGE_MAX_STEP);
    } else if (y > r.bottom - EDGE_ZONE_PX) {
      dy = Math.ceil(Math.min(1, (y - (r.bottom - EDGE_ZONE_PX)) / EDGE_ZONE_PX) * EDGE_MAX_STEP);
    }
    if (dy) {
      _viewerEl.scrollTop += dy;
      _moveGesture(_touch.lastX, _touch.lastY);
    }
    _touch.edgeRaf = requestAnimationFrame(_edgeTick);
  }

  function _onPointerDownTouch(ev) {
    // Second finger while pending/selecting → cancel; pinch (viewer-touch)
    // takes over. Both modules track pointers independently.
    if (_touch.pointerId != null) { _cancelTouch(); return; }
    const wrap = _pageOfNode(ev.target);
    if (!wrap) return;
    const pageNum = parseInt(wrap.dataset.page, 10);
    if (!pageNum) return;

    _touch.pointerId = ev.pointerId;
    _touch.startX = ev.clientX;
    _touch.startY = ev.clientY;
    _touch.lastX = ev.clientX;
    _touch.lastY = ev.clientY;
    document.addEventListener('pointermove', _onDocPointerMoveTouch);
    document.addEventListener('pointerup', _onDocPointerUpTouch);
    document.addEventListener('pointercancel', _onDocPointerCancelTouch);

    if (_armed || _marqueeArmed) {
      // Armed 🖍 / marquee: select immediately (4px threshold before the
      // preview renders, same as mouse). CSS flips the viewer to
      // touch-action:none in armed mode so the browser never scrolls.
      if (_beginGesture(wrap, pageNum, ev.clientX, ev.clientY, _marqueeArmed)) {
        _startTouchSelecting(ev.pointerId);
      } else {
        _resetTouch();
      }
      return;
    }

    // Unarmed: long-press to enter selection. No preventDefault here — a
    // plain drag must scroll like normal reading.
    const pid = ev.pointerId;
    _touch.timer = setTimeout(() => {
      _touch.timer = null;
      if (_touch.pointerId !== pid) return;
      if (!_beginGesture(wrap, pageNum, _touch.lastX, _touch.lastY, false)) {
        _resetTouch();
        return;
      }
      // The long-press itself IS the drag start: render the pressed word
      // as a pulsing single-item preview so the user sees selection mode
      // engage under their finger.
      _state.dragStarted = true;
      _state.anchors = _computeAnchors();
      _renderPreview(_state.anchors, true);
      _startTouchSelecting(pid);
    }, LONG_PRESS_MS);
  }

  function _onDocPointerMoveTouch(ev) {
    if (ev.pointerId !== _touch.pointerId) return;
    _touch.lastX = ev.clientX;
    _touch.lastY = ev.clientY;
    if (!_touch.selecting) {
      // Still waiting on the long-press: movement past the slop means the
      // user is scrolling — kill the timer and get out of the way.
      const dx = ev.clientX - _touch.startX;
      const dy = ev.clientY - _touch.startY;
      if (dx * dx + dy * dy > TOUCH_SLOP_PX * TOUCH_SLOP_PX) _resetTouch();
      return;
    }
    if (_touch.moveRaf) return;
    _touch.moveRaf = requestAnimationFrame(() => {
      _touch.moveRaf = 0;
      if (_touch.selecting) _moveGesture(_touch.lastX, _touch.lastY);
    });
  }

  function _onDocPointerUpTouch(ev) {
    if (ev.pointerId !== _touch.pointerId) return;
    const wasSelecting = _touch.selecting;
    _resetTouch();
    if (wasSelecting) {
      _endGesture(ev);
    } else {
      // Tap without long-press: clear any lingering committed preview —
      // parity with the desktop plain-click behavior.
      if (!_state || !_state.dragStarted) {
        _state = null;
        _clearAllSelLayers();
      }
    }
  }

  function _onDocPointerCancelTouch(ev) {
    if (ev.pointerId !== _touch.pointerId) return;
    _cancelTouch();
  }

  // The one non-passive touch listener: preventDefault() ONLY while a touch
  // selection is live. touch-action can't change mid-gesture, so this is
  // the lever that stops the browser from scrolling once the long-press
  // arms — the finger hasn't moved yet, so no scroll has begun.
  function _onTouchMoveBlock(ev) {
    if (_touch.selecting) ev.preventDefault();
  }

  function _onPointerDown(ev) {
    if (ev.pointerType === 'mouse') { _onPointerDownMouse(ev); return; }
    _onPointerDownTouch(ev);
  }

  // ---- Legacy mouse fallback (no PointerEvent support) ---------------------

  function _onMouseDownLegacy(ev) {
    if (ev.button !== 0) return;
    const wrap = _pageOfNode(ev.target);
    if (!wrap) return;
    const pageNum = parseInt(wrap.dataset.page, 10);
    if (!pageNum) return;
    const marquee = _marqueeArmed || ev.altKey;
    if (!_beginGesture(wrap, pageNum, ev.clientX, ev.clientY, marquee)) return;
    if (marquee) ev.preventDefault();
    document.addEventListener('mousemove', _onMouseMoveLegacy);
    document.addEventListener('mouseup', _onMouseUpLegacy, { once: true });
  }

  function _onMouseMoveLegacy(ev) { _moveGesture(ev.clientX, ev.clientY); }

  function _onMouseUpLegacy(ev) {
    document.removeEventListener('mousemove', _onMouseMoveLegacy);
    _endGesture(ev);
  }

  // ---- Public API ----------------------------------------------------------

  function clear() {
    _state = null;
    _hasCommitted = false;
    _clearAllSelLayers();
  }

  /* V3.620 — clear ONLY a committed selection. Safe to call from document
   * mousedown handlers: pointer events fire first, so a mousedown that
   * begins a new gesture has already reset _hasCommitted to false in
   * _beginGesture — this no-ops and the fresh drag survives. A bare
   * clear() there would null the in-flight _state and kill the drag. */
  function clearCommitted() {
    if (!_hasCommitted) return;
    clear();
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
    if (window.PointerEvent) {
      _viewerEl.addEventListener('pointerdown', _onPointerDown);
      _viewerEl.addEventListener('touchmove', _onTouchMoveBlock, { passive: false });
    } else {
      _viewerEl.addEventListener('mousedown', _onMouseDownLegacy);
    }
  }

  function destroy() {
    if (_viewerEl) {
      _viewerEl.removeEventListener('pointerdown', _onPointerDown);
      _viewerEl.removeEventListener('touchmove', _onTouchMoveBlock);
      _viewerEl.removeEventListener('mousedown', _onMouseDownLegacy);
    }
    document.removeEventListener('pointermove', _onDocPointerMoveMouse);
    document.removeEventListener('mousemove', _onMouseMoveLegacy);
    _resetTouch();
    _state = null;
    _clearAllSelLayers();
  }

  function setMarquee(on) { _marqueeArmed = !!on; }
  function isMarquee() { return _marqueeArmed; }

  /** V3.613 — 🖍 touch highlight mode. While armed, one-finger touch drags
   *  select immediately; CSS (body.lp-hl-armed) flips the viewer to
   *  touch-action:none so the browser never scrolls the drag. */
  function setArmed(on) {
    _armed = !!on;
    try { document.body.classList.toggle('lp-hl-armed', _armed); } catch (_) { /* no body yet */ }
    if (!_armed && _touch.pointerId != null) _cancelTouch();
  }
  function isArmed() { return _armed; }

  window.GEOM_SELECTION = {
    init, clear, clearCommitted, selectedText, selectedAnchors,
    setMarquee, isMarquee, setArmed, isArmed, destroy,
  };
})();
