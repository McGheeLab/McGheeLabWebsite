/* annotation-overlay.js — render highlights as DOM rects in `.pv-overlay`,
 * detect new selections, and surface a small floating "create" toolbar.
 *
 * Public API (window.ANNOTATION_OVERLAY):
 *   init({viewer, container, onCreate, onSelect, getColors})
 *   setAnnotations(list)              — replace the rendered set
 *   redraw()                          — re-render rects (e.g., after zoom)
 *   redrawPage(pageNumber)            — re-render rects for one page
 *   focus(annotationId)               — scroll-to + highlight
 *   destroy()
 *
 * The overlay is a sibling of pdf-viewer; it does not reach into pdf-viewer
 * state beyond the public getPageNode().
 */
(function () {
  let _viewer = null;
  let _container = null;
  let _onCreate = null;
  let _onSelect = null;
  let _onCaptureEquation = null;   // E3 — equation capture action
  let _onCaptureFigure = null;     // V3.610 — figure capture action
  let _getColors = () => [];
  let _annotations = [];
  let _toolbarEl = null;
  let _selectionDebounce = 0;
  let _filterFn = () => true;
  let _focusedId = null;

  // ---- New-selection toolbar ---------------------------------------------

  function _hideToolbar() {
    if (_toolbarEl) {
      _toolbarEl.remove();
      _toolbarEl = null;
    }
  }

  function _showToolbar(anchors) {
    _hideToolbar();
    if (!anchors || !anchors.length) return;
    const last = anchors[anchors.length - 1];
    if (!last.rects || !last.rects.length) return;

    // Position the toolbar just below the last rect of the selection on its
    // page. Compute viewport-relative coords from page wrap + rect.
    const node = _viewer.getPageNode(last.page);
    if (!node) return;
    const wrapRect = node.wrap.getBoundingClientRect();
    const r = last.rects[last.rects.length - 1];
    const x = wrapRect.left + r.x;
    const y = wrapRect.top + r.y + r.height + 4;

    const tb = document.createElement('div');
    tb.className = 'ann-toolbar';
    tb.style.position = 'fixed';
    tb.style.left = `${x}px`;
    tb.style.top = `${y}px`;
    tb.style.zIndex = '9000';

    const colors = _getColors();
    for (const c of colors) {
      const swatch = document.createElement('button');
      swatch.className = 'ann-swatch';
      swatch.style.background = c.hex;
      swatch.title = `${c.name} — ${c.meaning}`;
      swatch.setAttribute('aria-label', c.name);
      swatch.addEventListener('mousedown', (e) => {
        // Prevent the click from clearing the selection before we read it.
        e.preventDefault();
      });
      swatch.addEventListener('click', async (e) => {
        e.preventDefault();
        e.stopPropagation();
        _hideToolbar();
        if (_onCreate) await _onCreate({ anchors, colorId: c.id });
        // Clear the geometric selection now that the highlight is saved.
        if (window.GEOM_SELECTION) window.GEOM_SELECTION.clear();
      });
      tb.appendChild(swatch);
    }

    // E3 — capture the selected region as an EQUATION (snip + MathLive
    // transcription + note; saved as a kind:'equation' annotation).
    if (_onCaptureEquation) {
      const eqBtn = document.createElement('button');
      eqBtn.className = 'ann-toolbar-eq';
      eqBtn.textContent = 'ƒ';
      eqBtn.title = 'Capture equation — snip this region and transcribe it';
      eqBtn.addEventListener('mousedown', (e) => e.preventDefault());
      eqBtn.addEventListener('click', (e) => {
        e.preventDefault();
        e.stopPropagation();
        _hideToolbar();
        _onCaptureEquation({ anchors });
      });
      tb.appendChild(eqBtn);
    }

    // V3.610 — capture the selected region as a FIGURE (snip → Storage +
    // a kind:'figure' annotation; surfaces in the paper builder's Figure
    // board picker). Pairs with geom-selection's marquee mode.
    if (_onCaptureFigure) {
      const figBtn = document.createElement('button');
      figBtn.className = 'ann-toolbar-eq';
      figBtn.textContent = '🖼';
      figBtn.title = 'Capture figure — snip this region as a reference image';
      figBtn.addEventListener('mousedown', (e) => e.preventDefault());
      figBtn.addEventListener('click', (e) => {
        e.preventDefault();
        e.stopPropagation();
        _hideToolbar();
        _onCaptureFigure({ anchors });
      });
      tb.appendChild(figBtn);
    }

    // Cancel chip
    const cancel = document.createElement('button');
    cancel.className = 'ann-toolbar-cancel';
    cancel.textContent = '×';
    cancel.title = 'Cancel';
    cancel.addEventListener('mousedown', (e) => e.preventDefault());
    cancel.addEventListener('click', (e) => {
      e.preventDefault();
      e.stopPropagation();
      _hideToolbar();
      if (window.GEOM_SELECTION) window.GEOM_SELECTION.clear();
    });
    tb.appendChild(cancel);

    document.body.appendChild(tb);
    _toolbarEl = tb;
  }

  // Geom-selection commits anchors via onCommit; we just need to surface
  // the create-toolbar at the appropriate spot. (Old browser-Selection
  // mouseup path is removed.)
  function _onGeomCommit(anchors) {
    if (!anchors || !anchors.length) {
      _hideToolbar();
      return;
    }
    _showToolbar(anchors);
  }

  function _onDocClick(ev) {
    if (_toolbarEl && _toolbarEl.contains(ev.target)) return;
    if (_container && _container.contains(ev.target)) return;  // click was on viewer — let geom handle it
    // V3.613 — taps inside an APP_SHEET bottom sheet (the mobile reader's
    // post-selection surface) synthesize mousedown on iOS; the sheet is a
    // body child, so without this guard every tap in it would clear the
    // selection preview mid-interaction.
    if (ev.target && ev.target.closest && ev.target.closest('.app-sheet-back')) return;
    _hideToolbar();
    if (window.GEOM_SELECTION) window.GEOM_SELECTION.clear();
  }

  // ---- Render existing highlights ----------------------------------------

  function _colorById(id) {
    return _getColors().find(c => c.id === id) || { hex: '#facc15', name: 'Note' };
  }

  function _ensurePageOverlay(pageNumber) {
    const node = _viewer.getPageNode(pageNumber);
    return node ? node.overlay : null;
  }

  function _clearPageOverlay(pageNumber) {
    const ov = _ensurePageOverlay(pageNumber);
    if (ov) ov.innerHTML = '';
  }

  function _renderRectsForPage(pageNumber, annsOnPage) {
    const ov = _ensurePageOverlay(pageNumber);
    if (!ov) return;
    ov.innerHTML = '';
    for (const ann of annsOnPage) {
      if (!_filterFn(ann)) continue;
      const pages = (ann.target && ann.target.pages) || [];
      const pageAnchor = pages.find(p => p.page === pageNumber);
      if (!pageAnchor) continue;
      const rects = window.ANNOTATION_ANCHOR.anchorToRects(_viewer, pageAnchor);
      const color = _colorById(ann.color_id);
      // V3.103 — when the highlight cites into multiple drafts AND more
      // than one draft overlay is active, draw a thin colored left-
      // stripe per draft so the user can see which draft the
      // highlight is evidence for. Skip for "general" highlights
      // (empty cite_in_drafts).
      // Falls back to legacy ann.bucket_ids when cite_in_drafts is
      // absent, so existing data renders correctly until migrated.
      const annDrafts = Array.isArray(ann.cite_in_drafts) && ann.cite_in_drafts.length
        ? ann.cite_in_drafts
        : (Array.isArray(ann.bucket_ids) ? ann.bucket_ids : []);
      const activeOverlayIds = (window.PAPER_OVERLAYS && window.PAPER_OVERLAYS.getActiveDraftIds)
        ? new Set(window.PAPER_OVERLAYS.getActiveDraftIds())
        : new Set();
      const showStripes = annDrafts.length > 0 && activeOverlayIds.size > 1;
      for (let ri = 0; ri < rects.length; ri++) {
        const r = rects[ri];
        const div = document.createElement('div');
        div.className = 'ann-rect';
        if (ann.id === _focusedId) div.classList.add('ann-rect-focused');
        div.dataset.annId = ann.id;
        div.style.left = `${r.x}px`;
        div.style.top = `${r.y}px`;
        div.style.width = `${r.width}px`;
        div.style.height = `${r.height}px`;
        // Use a translucent background; mix-blend-mode: multiply (in CSS)
        // keeps the underlying canvas text legible.
        div.style.backgroundColor = `${color.hex}99`;
        // No click handler / no pointer-events — see CSS comment in
        // .ann-rect for why. Click-to-focus is via the side panel.
        ov.appendChild(div);
        // Add left-edge stripes ONLY on the first rect of the highlight
        // (otherwise multi-line highlights duplicate the stripe per line,
        // which clutters the page). 3px stripes side-by-side per bucket.
        if (showStripes && ri === 0 && window.PAPER_OVERLAYS) {
          const stripeDrafts = annDrafts.filter(id => activeOverlayIds.has(id));
          const colorFor = window.PAPER_OVERLAYS.getColorForDraft || window.PAPER_OVERLAYS.getColorForBucket;
          stripeDrafts.forEach((did, idx) => {
            const s = document.createElement('div');
            s.className = 'ann-bucket-stripe';
            s.style.left = `${r.x - 4 - idx * 4}px`;
            s.style.top = `${r.y}px`;
            s.style.width = '3px';
            s.style.height = `${r.height}px`;
            s.style.backgroundColor = colorFor(did);
            s.title = did;
            ov.appendChild(s);
          });
        }
      }
    }
  }

  function redrawPage(pageNumber) {
    if (!_viewer) return;   // overlay hasn't been initialized yet
    const annsOnPage = _annotations.filter(a => {
      const pages = (a.target && a.target.pages) || [];
      return pages.some(p => p.page === pageNumber);
    });
    _renderRectsForPage(pageNumber, annsOnPage);
  }

  function redraw() {
    if (!_viewer) return;
    for (let p = 1; p <= _viewer.numPages; p++) {
      redrawPage(p);
    }
  }

  function setAnnotations(list) {
    _annotations = Array.isArray(list) ? list.slice() : [];
    redraw();
  }

  function setFilter(fn) {
    _filterFn = typeof fn === 'function' ? fn : () => true;
    redraw();
  }

  /* V3.613 — coordinate hit-test for touch: .ann-rect is deliberately
   * pointer-events:none, so the mobile reader resolves a tap to an
   * annotation id by geometry. (x, y) are page-wrap-local CSS pixels on
   * pageNumber. Respects the active filter; smallest-area hit wins so a
   * short highlight nested inside a long one is pickable. Returns the
   * annotation id or null. */
  function annotationAt(pageNumber, x, y) {
    if (!_viewer) return null;
    let bestId = null, bestArea = Infinity;
    for (const ann of _annotations) {
      if (!_filterFn(ann)) continue;
      const pages = (ann.target && ann.target.pages) || [];
      const pageAnchor = pages.find(p => p.page === pageNumber);
      if (!pageAnchor) continue;
      let rects = [];
      try { rects = window.ANNOTATION_ANCHOR.anchorToRects(_viewer, pageAnchor) || []; }
      catch (_) { continue; }
      for (const r of rects) {
        if (x >= r.x && x <= r.x + r.width && y >= r.y && y <= r.y + r.height) {
          const area = r.width * r.height;
          if (area < bestArea) { bestArea = area; bestId = ann.id; }
        }
      }
    }
    return bestId;
  }

  function focus(annotationId) {
    _focusedId = annotationId;
    if (!annotationId) { redraw(); return; }
    const ann = _annotations.find(a => a.id === annotationId);
    if (!ann) { redraw(); return; }
    const pages = (ann.target && ann.target.pages) || [];
    if (!pages.length) { redraw(); return; }
    const firstPage = pages[0].page;
    _viewer.gotoPage(firstPage);
    redraw();
    setTimeout(() => {
      const node = _viewer.getPageNode(firstPage);
      if (!node) return;
      // Use anchorToRects so the rect is in current-zoom coordinates,
      // not the saved-zoom coords stored on the anchor.
      const rects = window.ANNOTATION_ANCHOR.anchorToRects(_viewer, pages[0]);
      const r = (rects && rects[0]) || (pages[0].rects && pages[0].rects[0]);
      if (!r) return;
      const container = document.getElementById('lp-viewer');
      if (!container) return;
      // Center the rect vertically in the viewer container.
      const rectCenterY = node.wrap.offsetTop + r.y + r.height / 2;
      const target = rectCenterY - container.clientHeight / 2;
      container.scrollTo({
        top: Math.max(0, target),
        behavior: 'smooth',
      });
    }, 50);
  }

  function init(opts) {
    _viewer = opts.viewer;
    _container = opts.container;
    _onCreate = opts.onCreate || null;
    _onSelect = opts.onSelect || null;
    _onCaptureEquation = opts.onCaptureEquation || null;   // E3
    _onCaptureFigure = opts.onCaptureFigure || null;       // V3.610
    _getColors = opts.getColors || (() => []);
    document.addEventListener('mousedown', _onDocClick);
  }

  // Public so library-paper.js can pass it as the onCommit callback to
  // GEOM_SELECTION.init.
  function onSelectionCommit(anchors) { _onGeomCommit(anchors); }

  function destroy() {
    _hideToolbar();
    document.removeEventListener('mousedown', _onDocClick);
    _annotations = [];
  }

  window.ANNOTATION_OVERLAY = {
    init,
    setAnnotations,
    setFilter,
    redraw,
    redrawPage,
    focus,
    annotationAt,
    destroy,
    onSelectionCommit,
  };
})();
