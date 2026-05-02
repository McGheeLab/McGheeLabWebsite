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
      for (const r of rects) {
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
    destroy,
    onSelectionCommit,
  };
})();
