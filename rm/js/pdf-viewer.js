/* pdf-viewer.js — thin wrapper around pdf.js for the library paper viewer.
 *
 * ES-module wrapper because pdf.js v4 is shipped as ESM. Exposed on
 * window.PDF_VIEWER so non-module callers can use it.
 *
 * Usage:
 *   const v = await PDF_VIEWER.create(containerEl, pdfUrl);
 *   v.next(); v.prev(); v.setZoom(1.4); v.gotoPage(3);
 *   await v.destroy();
 *
 * Renders one page at a time into the container. Every page has:
 *   <div class="pv-page-wrap">
 *     <canvas class="pv-canvas"></canvas>
 *     <div class="pv-text-layer textLayer"></div>   <!-- pdf.js text layer -->
 *     <div class="pv-overlay"></div>                <!-- annotation overlay (Phase 3) -->
 *   </div>
 *
 * The textLayer class is the one pdf.js's vendored CSS targets (pdf_viewer.css).
 * The pv-overlay is empty in Phase 2 — Phase 3's annotation-overlay.js will
 * inject highlights into it.
 */

import {
  getDocument,
  GlobalWorkerOptions,
  OPS,
  TextLayer,
} from '/rm/vendor/pdfjs/pdf.mjs';

GlobalWorkerOptions.workerSrc = '/rm/vendor/pdfjs/pdf.worker.mjs';

/**
 * Build a pixel "ink" probe over a rendered page canvas. Returns a function
 * pxInk(x1,y1,x2,y2) → mean ink density [0..1] of that rectangle, where the
 * rectangle is in page-wrap-local CSS pixels (the same coordinate space as the
 * text items). The canvas is downscaled once into a small grid (cheap GPU
 * drawImage + one getImageData), so per-rectangle queries are fast.
 *
 * "Ink" = alpha × (1 − luminance), so white background reads 0 and dark glyphs
 * / figures read ~1. Used to detect non-text content (figures, equations,
 * images) that spans the column gutter, which the text layer cannot see.
 *
 * Returns null if the canvas is empty or getImageData throws (e.g. a tainted
 * canvas), in which case the caller falls back to text-only detection.
 */
function _makePixelProbe(canvas, cssW, cssH, maxGrid) {
  if (!canvas || !canvas.width || !canvas.height || cssW <= 0 || cssH <= 0) return null;
  if (typeof document === 'undefined') return null;
  try {
    // V3.613 — maxGrid caps the probe resolution (phone: 180, default 360).
    const gw = Math.max(40, Math.min(maxGrid || 360, Math.round(cssW / 2)));
    const gh = Math.max(40, Math.min(2400, Math.round(gw * canvas.height / canvas.width)));
    const off = document.createElement('canvas');
    off.width = gw; off.height = gh;
    const octx = off.getContext('2d', { willReadFrequently: true });
    if (!octx) return null;
    octx.drawImage(canvas, 0, 0, gw, gh);
    const data = octx.getImageData(0, 0, gw, gh).data;
    const ink = new Float32Array(gw * gh);
    for (let i = 0, p = 0; i < ink.length; i++, p += 4) {
      const a = data[p + 3] / 255;
      const lum = (data[p] + data[p + 1] + data[p + 2]) / 765;  // /(3*255)
      ink[i] = a * (1 - lum);
    }
    const sx = gw / cssW, sy = gh / cssH;
    return function pxInk(x1, y1, x2, y2) {
      let gx1 = Math.max(0, Math.floor(x1 * sx));
      let gx2 = Math.min(gw - 1, Math.ceil(x2 * sx) - 1);
      let gy1 = Math.max(0, Math.floor(y1 * sy));
      let gy2 = Math.min(gh - 1, Math.ceil(y2 * sy) - 1);
      if (gx2 < gx1) gx2 = gx1;
      if (gy2 < gy1) gy2 = gy1;
      let sum = 0, n = 0;
      for (let gy = gy1; gy <= gy2; gy++) {
        const row = gy * gw;
        for (let gx = gx1; gx <= gx2; gx++) { sum += ink[row + gx]; n++; }
      }
      return n ? sum / n : 0;
    };
  } catch (e) {
    return null;   // tainted/unsupported canvas → text-only fallback
  }
}

/**
 * V3.640 — figure/table regions come from the SHARED layout engine:
 * PAGE_LAYOUT.figureRegions anchors one region per NUMBERED caption
 * ("Figure 3.", "Table 1.") and grows it to the surrounding text —
 * whole figures only, never sub-panels (which is exactly where the
 * retired V3.616 ink-blob detector fell down). The viewer's ink probe
 * is passed in ONLY to decide whether the content sits above or below
 * its caption. Regions are stored natural-scale on the page node;
 * getFigureRegions() rescales per zoom.
 */
function _detectFigureRegions(canvas, cssW, cssH, items, zoom, graphics, pageNum) {
  if (!zoom || !items || !items.length) return [];
  if (typeof window === 'undefined' || !window.PAGE_LAYOUT ||
      !window.PAGE_LAYOUT.figureRegions) return [];
  try {
    const probe = _makePixelProbe(canvas, cssW, cssH, 360);
    const regions = window.PAGE_LAYOUT.figureRegions(items, {
      pageWidth: cssW,
      pageHeight: cssH,
      inkProbe: probe,
      pageNum,
      /* V3.826 — the page's painted images + vector paths (natural
       * coords, collected once per page) in the items' basis. The
       * detector reads the artwork's extent from these instead of
       * guessing it from where the prose stops. null = unknown. */
      graphics: Array.isArray(graphics)
        ? graphics.map(g => ({ x: g.x * zoom, y: g.y * zoom, w: g.w * zoom, h: g.h * zoom, k: g.k }))
        : undefined,
    });
    return regions.map(r => ({
      xN: r.x / zoom,
      yN: r.y / zoom,
      wN: r.w / zoom,
      hN: r.h / zoom,
      label: r.label || '',
    }));
  } catch (e) {
    return [];   // detection is optional — marquee/Alt-drag still work
  }
}

/**
 * V3.826 — every painted image and vector path on the page, as boxes in
 * natural (scale-1) coords, from the operator list pdf.js already built to
 * render the page. Figures are where the PDF paints, not where the text
 * isn't: the caption-anchored detector lost a 2/3-width figure whose
 * caption glued to the next column's prose, and clipped a page-wide
 * figure to its one-column caption. Resolves null when the list can't be
 * read (the detector then runs text-only, as before); [] is a real answer
 * ("this page paints nothing").
 */
async function _collectPageGraphics(page) {
  if (typeof window === 'undefined' || !window.PAGE_LAYOUT ||
      !window.PAGE_LAYOUT.collectGraphics) return null;
  try {
    const opList = await page.getOperatorList();
    const vp = page.getViewport({ scale: 1 });
    return window.PAGE_LAYOUT.collectGraphics(opList, OPS, vp.transform, vp.width, vp.height);
  } catch (e) {
    return null;
  }
}

/**
 * V3.371 — the layout-segmentation engine moved to rm/js/page-layout.js
 * (window.PAGE_LAYOUT) so the viewer, the headless extractTextItemsFromPdf
 * path, and the layout-audit harness all share ONE implementation. This
 * thin delegator stamps items with index/cluster/column via PAGE_LAYOUT,
 * falling back to naive (y,x) order only if the engine script failed to
 * load (keeps the viewer usable rather than throwing).
 */
function _clusterAndSort(items, pxInk) {
  if (!items.length) return;
  if (typeof window !== 'undefined' && window.PAGE_LAYOUT && window.PAGE_LAYOUT.segmentPage) {
    window.PAGE_LAYOUT.segmentPage(items, { inkProbe: pxInk });
    return;
  }
  console.warn('[pdf-viewer] PAGE_LAYOUT not loaded — falling back to naive (y,x) order.');
  items.sort((a, b) => a.y - b.y || a.x - b.x);
  items.forEach((it, i) => { it.index = i; it.cluster = 0; it.column = 0; });
}

/* V3.613 — phone-reader opts (all opt-in; desktop callers pass none and get
 * byte-identical behavior):
 *   dprCap           — clamp the render devicePixelRatio (e.g. 2 on iPhone 3x)
 *   maxCanvasPixels  — hard cap on canvas device pixels per page; the render
 *                      scale shrinks to fit (CSS size is unchanged, so all
 *                      item/anchor geometry stays correct)
 *   lowResProbe      — halve the pixel-ink probe grid (segmentation only)
 *   virtualize       — free canvas backing stores for pages far outside the
 *                      scroll window (±2 viewport heights); textLayer + items
 *                      are kept so selection/anchors keep working. Canvases
 *                      re-render as pages approach the window.
 *   contentWrapper   — wrap all page nodes in a single .pv-content div (a
 *                      CSS-transform target for pinch-zoom; position:static
 *                      so offsetTop math is unchanged)
 */
async function create(container, pdfUrl, opts = {}) {
  if (!container) throw new Error('PDF_VIEWER.create: container required');
  if (!pdfUrl) throw new Error('PDF_VIEWER.create: pdfUrl required');

  container.classList.add('pv-container');
  container.innerHTML = '';

  const state = {
    doc: null,
    numPages: 0,
    currentPage: 1,
    zoom: opts.initialZoom || 1.25,
    pageNodes: new Map(),    // page number → { wrap, canvas, textLayer }
    renderTasks: new Map(),  // page number → cancellable RenderTask
    naturalHeights: new Map(), // page number → scale-1 viewport height (V3.333)
    destroyed: false,
    paused: false,           // V3.613 — tab-lifecycle pause gate
    contentEl: null,         // V3.613 — .pv-content wrapper (contentWrapper opt)
  };

  const loadingTask = getDocument({
    url: pdfUrl,
    // Cross-origin Firebase Storage downloads need credentials disabled.
    withCredentials: false,
    // On the static deploy we hit Firebase Storage directly (no proxy), and
    // Firebase Storage doesn't preflight Range requests cross-origin. Disable
    // ranged + streaming fetch so pdf.js downloads the full PDF in one GET —
    // slower for huge PDFs but works without a CORS workaround.
    disableRange: !!opts.disableRange,
    disableStream: !!opts.disableStream,
  });
  state.doc = await loadingTask.promise;
  state.numPages = state.doc.numPages;

  // If asked, compute fit-to-width zoom from page 1's natural size before
  // the first render. Saves us a re-render right after mount.
  if (opts.fitToContainer && container.clientWidth > 0) {
    try {
      const page1 = await state.doc.getPage(1);
      const naturalViewport = page1.getViewport({ scale: 1.0 });
      const targetW = container.clientWidth - 24;
      if (targetW > 0 && naturalViewport.width > 0) {
        state.zoom = Math.max(0.4, Math.min(4.0, targetW / naturalViewport.width));
      }
    } catch (e) {
      console.warn('[pdf-viewer] could not compute fit-to-width:', e);
    }
  }

  // V3.613 — optional single wrapper around all page nodes: the pinch-zoom
  // CSS-transform target. position:static (see .pv-content CSS), so
  // wrap.offsetTop still resolves against the positioned container and the
  // scroll-spy / overlay-focus math is unchanged.
  let pageParent = container;
  if (opts.contentWrapper) {
    const content = document.createElement('div');
    content.className = 'pv-content';
    container.appendChild(content);
    state.contentEl = content;
    pageParent = content;
  }

  // Build empty page wrappers up-front so the scrollbar is sized correctly
  // and gotoPage can scroll-into-view before render finishes.
  for (let i = 1; i <= state.numPages; i++) {
    const wrap = document.createElement('div');
    wrap.className = 'pv-page-wrap';
    wrap.dataset.page = String(i);
    const canvas = document.createElement('canvas');
    canvas.className = 'pv-canvas';
    const textLayer = document.createElement('div');
    textLayer.className = 'pv-text-layer textLayer';
    const selLayer = document.createElement('div');
    selLayer.className = 'pv-sel-layer';
    selLayer.dataset.page = String(i);
    const overlay = document.createElement('div');
    overlay.className = 'pv-overlay';
    overlay.dataset.page = String(i);
    wrap.appendChild(canvas);
    wrap.appendChild(textLayer);
    wrap.appendChild(selLayer);
    wrap.appendChild(overlay);
    pageParent.appendChild(wrap);
    state.pageNodes.set(i, { wrap, canvas, textLayer, selLayer, overlay, items: [] });
  }

  /* V3.613 — effective render scale. Desktop (no opts) is exactly
   * devicePixelRatio; the phone reader clamps it (dprCap) and caps the
   * total canvas device pixels (maxCanvasPixels) so a 3x iPhone doesn't
   * hold ~32 MB per page. CSS size is unchanged either way, so text items,
   * anchors, and snip math never see the difference. */
  function _effectiveDpr(viewport) {
    let dpr = window.devicePixelRatio || 1;
    if (opts.dprCap) dpr = Math.min(dpr, opts.dprCap);
    if (opts.maxCanvasPixels) {
      const cssPx = viewport.width * viewport.height;
      if (cssPx > 0 && cssPx * dpr * dpr > opts.maxCanvasPixels) {
        dpr = Math.max(0.75, Math.sqrt(opts.maxCanvasPixels / cssPx));
      }
    }
    return dpr;
  }

  /* V3.613 — canvasOnly=true re-inflates a virtualization-freed canvas
   * without re-running the text layer / item collection / link capture
   * (those survive the free and are only stale after a zoom change, which
   * forces a full render via node.itemsZoom). */
  async function _renderPage(pageNum, canvasOnly) {
    if (state.destroyed || state.paused) return;
    const node = state.pageNodes.get(pageNum);
    if (!node) return;
    const page = await state.doc.getPage(pageNum);
    if (state.destroyed || state.paused) return;

    const viewport = page.getViewport({ scale: state.zoom });
    // Use devicePixelRatio for crisp rendering on hi-DPI displays.
    const dpr = _effectiveDpr(viewport);
    node.canvas.width = Math.floor(viewport.width * dpr);
    node.canvas.height = Math.floor(viewport.height * dpr);
    node.canvas.style.width = `${Math.floor(viewport.width)}px`;
    node.canvas.style.height = `${Math.floor(viewport.height)}px`;
    node.wrap.style.width = `${Math.floor(viewport.width)}px`;
    node.wrap.style.height = `${Math.floor(viewport.height)}px`;
    node.textLayer.style.width = `${Math.floor(viewport.width)}px`;
    node.textLayer.style.height = `${Math.floor(viewport.height)}px`;
    node.overlay.style.width = `${Math.floor(viewport.width)}px`;
    node.overlay.style.height = `${Math.floor(viewport.height)}px`;
    // pdf.js v4 text-layer spans are scaled via CSS calc(... * var(--scale-factor)).
    // Without this set, span widths/positions don't match the canvas at zooms
    // other than 1.0 — that's the "selection box too big / blocky" symptom.
    node.wrap.style.setProperty('--scale-factor', viewport.scale);
    node.textLayer.style.setProperty('--scale-factor', viewport.scale);
    // Total scale factor (viewport scale × devicePixelRatio) is also referenced
    // by some pdf.js styles; keep both in sync.
    node.wrap.style.setProperty('--total-scale-factor', viewport.scale * dpr);

    const ctx = node.canvas.getContext('2d');
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);

    // Cancel any in-flight render for this page (zoom changes can stack).
    const old = state.renderTasks.get(pageNum);
    if (old) {
      try { old.cancel(); } catch (_) { /* ignore */ }
    }

    const task = page.render({ canvasContext: ctx, viewport });
    state.renderTasks.set(pageNum, task);
    try {
      await task.promise;
    } catch (e) {
      if (e && e.name === 'RenderingCancelledException') return;
      console.error(`[pdf-viewer] page ${pageNum} render error:`, e);
      return;
    }
    state.renderTasks.delete(pageNum);
    if (state.destroyed) return;
    node.wrap.classList.remove('pv-canvas-empty');   // V3.613 — re-inflated

    if (canvasOnly) {
      if (opts.onPageReady) {
        try { opts.onPageReady(pageNum, node); } catch (e) { console.error(e); }
      }
      return;
    }

    // Text layer — selectable text overlay. pdf.js v4 ships a TextLayer
    // class that handles spacing and rotation correctly.
    node.textLayer.innerHTML = '';
    try {
      const tl = new TextLayer({
        textContentSource: page.streamTextContent(),
        container: node.textLayer,
        viewport,
      });
      await tl.render();
    } catch (e) {
      // Non-fatal: text selection just won't work on this page.
      console.warn(`[pdf-viewer] text layer error on page ${pageNum}:`, e);
    }
    if (node.selLayer) {
      node.selLayer.style.width = `${Math.floor(viewport.width)}px`;
      node.selLayer.style.height = `${Math.floor(viewport.height)}px`;
      node.selLayer.innerHTML = '';
    }

    // Capture per-glyph items in visual reading order so geom-selection
    // can drag-select without relying on browser native Range walks.
    node.items = _collectTextItems(node);
    node.itemsZoom = state.zoom;   // V3.613 — staleness marker for virtualize
    // V3.826 — the graphics layer is zoom-independent: collect it once per
    // page and keep it on the node (a few hundred small boxes at most).
    if (node.graphics === undefined) {
      node.graphics = await _collectPageGraphics(page);
      if (state.destroyed) return;
    }
    // V3.616 — figure hotspots. V3.826 — caption anchors + the page's own
    // artwork boxes. Stored at natural scale; getFigureRegions() rescales
    // per zoom.
    node.figures = _detectFigureRegions(
      node.canvas, viewport.width, viewport.height, node.items, state.zoom,
      node.graphics, pageNum);
    // V3.333 — capture Link annotations once per page (natural scale-1
    // coords; getLinkAnnotations rescales at access time). Publisher PDFs
    // encode inline citations as internal GoTo links — paper-citations
    // consumes these as authoritative markers.
    if (!node.linksLoaded) {
      node.linksLoaded = true;
      _captureLinkAnnotations(pageNum, page, node).catch(e =>
        console.warn(`[pdf-viewer] link annotations failed on page ${pageNum}:`, e));
    }
    if (opts.onPageReady) {
      try { opts.onPageReady(pageNum, node); } catch (e) { console.error(e); }
    }
  }

  async function _captureLinkAnnotations(pageNum, page, node) {
    const natVp = page.getViewport({ scale: 1.0 });
    state.naturalHeights.set(pageNum, natVp.height);
    let annots = [];
    try { annots = await page.getAnnotations(); } catch (_) { return; }
    const links = [];
    for (const a of annots) {
      if (!a || a.subtype !== 'Link' || !Array.isArray(a.rect)) continue;
      const [x1, y1, x2, y2] = a.rect;
      const rec = {
        page: pageNum,
        xN: Math.min(x1, x2),
        yN: natVp.height - Math.max(y1, y2),
        wN: Math.abs(x2 - x1),
        hN: Math.abs(y2 - y1),
        url: a.url || '',
        targetPage: null,
        rawY: null,          // PDF bottom-up y of the destination
      };
      if (!rec.url && a.dest) {
        const t = await _resolveDest(state.doc, a.dest);
        if (t) { rec.targetPage = t.targetPage; rec.rawY = t.rawY; }
      }
      links.push(rec);
    }
    node.links = links;
  }

  /**
   * Walk the textLayer's child spans and capture each as a "text item" with
   * its bounding rect (page-wrap-local CSS pixels) and text content, then sort
   * into visual reading order via _clusterAndSort (column-major within bands).
   *
   * A pixel probe over the rendered canvas is passed in so the gutter
   * classifier can see non-text ink (figures / equations / images) that spans
   * the gutter — the text layer alone is blind to those.
   */
  function _collectTextItems(node) {
    const wrapRect = node.wrap.getBoundingClientRect();
    const pageWidth = parseFloat(node.wrap.style.width) || wrapRect.width;
    const pageHeight = parseFloat(node.wrap.style.height) || wrapRect.height;
    const items = [];
    // Permissive span query: pdf.js v4 wraps differently per-version, so
    // grab every span anywhere under the text layer and filter by size+text.
    const spans = node.textLayer.querySelectorAll('span');
    spans.forEach((span, idx) => {
      const text = span.textContent || '';
      if (!text.trim()) return;
      // Skip nested "marked content" container spans — only leaf text spans
      // are real glyph items. A leaf span has no element children.
      if (span.firstElementChild) return;
      const r = span.getBoundingClientRect();
      if (r.width < 0.5 || r.height < 0.5) return;
      items.push({
        domSpan: span,
        text,
        x: r.left - wrapRect.left,
        y: r.top - wrapRect.top,
        width: r.width,
        height: r.height,
        domIndex: idx,
      });
    });

    // Order into visual reading order. The pixel probe lets the gutter
    // classifier treat a row as full-width when an image/figure fills the
    // gutter there even though no text item does.
    const pxInk = _makePixelProbe(node.canvas, pageWidth, pageHeight,
      opts.lowResProbe ? 180 : 360);
    _clusterAndSort(items, pxInk);

    if (window.__PDF_VIEWER_DEBUG__) {
      const clusters = new Map();
      items.forEach(it => clusters.set(it.cluster, (clusters.get(it.cluster) || 0) + 1));
      console.log(
        `[pdf-viewer] page ${node.wrap.dataset.page}: ${items.length} items, ${clusters.size} block(s) at width ${pageWidth.toFixed(0)}px`,
        Array.from(clusters.entries()).map(([k, v]) => `#${k}:${v}`).join(' ')
      );
    }
    return items;
  }

  // _clusterAndSort + _detectColumnGutters live at module scope (below
  // create()) so the pure geometry is unit-testable without a DOM.

  /* V3.613 — page order that radiates outward from the current page, so
   * the page under the user sharpens first on zoom changes. At boot
   * (currentPage=1) this degenerates to 1..N — desktop behavior unchanged. */
  function _pageOrder() {
    const cur = Math.max(1, Math.min(state.numPages, state.currentPage));
    const order = [cur];
    for (let d = 1; d < state.numPages; d++) {
      if (cur + d <= state.numPages) order.push(cur + d);
      if (cur - d >= 1) order.push(cur - d);
    }
    return order;
  }

  async function _renderAll() {
    // Render sequentially to avoid hammering the worker. For a 50-page paper
    // this takes a few seconds — acceptable for v1 (Phase 2). Phase 3+ can
    // add virtualized rendering if perf becomes an issue.
    for (const i of _pageOrder()) {
      if (state.destroyed || state.paused) return;
      await _renderPage(i);
      // V3.613 — with virtualize on, free faraway canvases as the initial
      // sweep progresses so the render pass itself never accumulates the
      // whole document's canvas memory.
      if (opts.virtualize) _virtCheck();
    }
  }

  // ---- V3.613 canvas virtualization ---------------------------------------
  // Pages whose wrap sits beyond ±2 viewport heights of the scroll window
  // get their canvas backing store freed (0×0 — layout holds because the
  // style sizes stay). textLayer + items survive, so selection, anchors and
  // overlay rects keep working on freed pages. Approaching pages re-render
  // canvas-only (or fully, after a zoom made their items stale).

  let _virtRaf = 0;
  function _virtCheck() {
    if (!opts.virtualize || state.destroyed) return;
    const ch = container.clientHeight || 0;
    if (!ch) return;
    const top = container.scrollTop - 2 * ch;
    const bottom = container.scrollTop + 3 * ch;
    state.pageNodes.forEach((node, n) => {
      const wTop = node.wrap.offsetTop;
      const wBottom = wTop + node.wrap.offsetHeight;
      const inWindow = wBottom >= top && wTop <= bottom;
      const hasCanvas = node.canvas.width > 0;
      if (!inWindow && hasCanvas) {
        const task = state.renderTasks.get(n);
        if (task) { try { task.cancel(); } catch (_) { /* ignore */ } state.renderTasks.delete(n); }
        node.canvas.width = 0;
        node.canvas.height = 0;
        node.wrap.classList.add('pv-canvas-empty');
      } else if (inWindow && !hasCanvas && !state.renderTasks.has(n) && !state.paused) {
        const canvasOnly = node.items.length > 0 && node.itemsZoom === state.zoom;
        _renderPage(n, canvasOnly).catch(() => { /* logged inside */ });
      }
    });
  }

  function _scheduleVirtCheck() {
    if (!opts.virtualize || _virtRaf) return;
    _virtRaf = requestAnimationFrame(() => { _virtRaf = 0; _virtCheck(); });
  }

  function gotoPage(n) {
    const target = Math.max(1, Math.min(state.numPages, n | 0));
    state.currentPage = target;
    const node = state.pageNodes.get(target);
    if (node) node.wrap.scrollIntoView({ behavior: 'smooth', block: 'start' });
    if (opts.onPageChange) opts.onPageChange(target);
  }

  /* V3.613 — zoom-change shell resize for virtualized out-of-window pages:
   * update wrap/layer sizes + the --scale-factor vars (the text layer
   * rescales via CSS) and free the canvas; the full render happens when the
   * page next approaches the window (items are stale → itemsZoom forces it). */
  async function _resizeShellOnly(pageNum) {
    const node = state.pageNodes.get(pageNum);
    if (!node) return;
    const page = await state.doc.getPage(pageNum);
    if (state.destroyed) return;
    const viewport = page.getViewport({ scale: state.zoom });
    const dpr = _effectiveDpr(viewport);
    const task = state.renderTasks.get(pageNum);
    if (task) { try { task.cancel(); } catch (_) { /* ignore */ } state.renderTasks.delete(pageNum); }
    node.canvas.width = 0;
    node.canvas.height = 0;
    node.canvas.style.width = `${Math.floor(viewport.width)}px`;
    node.canvas.style.height = `${Math.floor(viewport.height)}px`;
    node.wrap.style.width = `${Math.floor(viewport.width)}px`;
    node.wrap.style.height = `${Math.floor(viewport.height)}px`;
    node.textLayer.style.width = `${Math.floor(viewport.width)}px`;
    node.textLayer.style.height = `${Math.floor(viewport.height)}px`;
    node.overlay.style.width = `${Math.floor(viewport.width)}px`;
    node.overlay.style.height = `${Math.floor(viewport.height)}px`;
    if (node.selLayer) {
      node.selLayer.style.width = `${Math.floor(viewport.width)}px`;
      node.selLayer.style.height = `${Math.floor(viewport.height)}px`;
    }
    node.wrap.style.setProperty('--scale-factor', viewport.scale);
    node.textLayer.style.setProperty('--scale-factor', viewport.scale);
    node.wrap.style.setProperty('--total-scale-factor', viewport.scale * dpr);
    node.wrap.classList.add('pv-canvas-empty');
  }

  async function setZoom(z) {
    state.zoom = Math.max(0.4, Math.min(4.0, z));
    if (opts.onZoomChange) opts.onZoomChange(state.zoom);
    // Re-render all pages at the new zoom — outward from the current page so
    // the page under the user sharpens first (V3.613; boot order unchanged).
    if (opts.virtualize) {
      const ch = container.clientHeight || 0;
      const top = container.scrollTop - 2 * ch;
      const bottom = container.scrollTop + 3 * ch;
      for (const i of _pageOrder()) {
        if (state.destroyed || state.paused) return;
        const node = state.pageNodes.get(i);
        const wTop = node ? node.wrap.offsetTop : 0;
        const wBottom = node ? wTop + node.wrap.offsetHeight : 0;
        const inWindow = ch > 0 && wBottom >= top && wTop <= bottom;
        if (inWindow) await _renderPage(i);
        else await _resizeShellOnly(i);
      }
      return;
    }
    for (const i of _pageOrder()) {
      if (state.destroyed) return;
      await _renderPage(i);
    }
  }

  // V3.294 — hold the scroll handler so destroy() can remove it. Multi-tab
  // closes destroy+drop viewers, and an un-removed listener on a detached
  // container would otherwise accumulate.
  let _scrollHandler = null;
  function _wireScrollSpy() {
    // Update currentPage as the user scrolls (whichever page-wrap is closest
    // to the top of the container counts as current).
    let raf = 0;
    _scrollHandler = function () {
      if (raf) return;
      raf = requestAnimationFrame(() => {
        raf = 0;
        const top = container.scrollTop;
        let best = 1, bestDist = Infinity;
        state.pageNodes.forEach((node, n) => {
          const dist = Math.abs(node.wrap.offsetTop - top);
          if (dist < bestDist) { bestDist = dist; best = n; }
        });
        if (best !== state.currentPage) {
          state.currentPage = best;
          if (opts.onPageChange) opts.onPageChange(best);
        }
        _scheduleVirtCheck();   // V3.613 — no-op unless opts.virtualize
      });
    };
    container.addEventListener('scroll', _scrollHandler, { passive: true });
  }

  function destroy() {
    state.destroyed = true;
    state.renderTasks.forEach(t => { try { t.cancel(); } catch (_) { /* ignore */ } });
    state.renderTasks.clear();
    state.pageNodes.clear();
    if (_scrollHandler) {
      try { container.removeEventListener('scroll', _scrollHandler); } catch (_) { /* ignore */ }
      _scrollHandler = null;
    }
    container.innerHTML = '';
    if (state.doc) {
      try { state.doc.destroy(); } catch (_) { /* ignore */ }
    }
  }

  _wireScrollSpy();
  // Kick off render in the background; caller can await the returned promise
  // via api.ready() if it cares.
  const renderAllPromise = _renderAll();

  return {
    get numPages() { return state.numPages; },
    get currentPage() { return state.currentPage; },
    get zoom() { return state.zoom; },
    next() { gotoPage(state.currentPage + 1); },
    prev() { gotoPage(state.currentPage - 1); },
    gotoPage,
    setZoom,
    zoomIn() { return setZoom(state.zoom * 1.2); },
    zoomOut() { return setZoom(state.zoom / 1.2); },
    ready: () => renderAllPromise,
    /** Recompute and apply fit-to-width zoom from the current container size. */
    async fitToWidth() {
      try {
        const page1 = await state.doc.getPage(1);
        const naturalViewport = page1.getViewport({ scale: 1.0 });
        const targetW = container.clientWidth - 24;
        if (targetW <= 0 || naturalViewport.width <= 0) return;
        const z = Math.max(0.4, Math.min(4.0, targetW / naturalViewport.width));
        if (Math.abs(z - state.zoom) < 0.005) return;  // already fitted
        await setZoom(z);
      } catch (e) {
        console.warn('[pdf-viewer] fitToWidth failed:', e);
      }
    },
    destroy,
    /* V3.613 — tab-lifecycle hooks for the phone shell. pause() cancels all
     * in-flight render work; resume() re-inflates whatever the scroll
     * window needs (virtualize) or restarts the full sweep. Desktop never
     * calls these. */
    pause() {
      state.paused = true;
      state.renderTasks.forEach(t => { try { t.cancel(); } catch (_) { /* ignore */ } });
      state.renderTasks.clear();
    },
    resume() {
      if (!state.paused) return;
      state.paused = false;
      if (opts.virtualize) _virtCheck();
      else _renderAll();
    },
    /* V3.613 — the .pv-content wrapper (contentWrapper opt) or null; the
     * pinch-zoom CSS-transform target for viewer-touch.js. */
    getContentEl() { return state.contentEl; },
    // Exposed for Phase 3 annotation-overlay to reach the per-page DOM.
    getPageNode(pageNum) { return state.pageNodes.get(pageNum); },
    // V3.830 — the pdf.js document itself, so a caller can render a page
    // region at its own scale (the notebook whiteboard's figure snips)
    // without downloading the PDF a second time.
    getPdfDocument() { return state.doc; },
    // Exposed for geom-selection — text items in visual reading order.
    getTextItems(pageNum) {
      const n = state.pageNodes.get(pageNum);
      return (n && n.items) || [];
    },
    // V3.333 — per-page Link annotations in the SAME coordinate basis as
    // getTextItems (wrap-local CSS px at the current zoom). targetY is the
    // internal GoTo destination converted to top-down coords on its page;
    // 0 = "top of target page" when the dest carried no explicit y.
    getLinkAnnotations(p) {
      const n = state.pageNodes.get(p);
      if (!n || !n.links) return [];
      const z = state.zoom;
      return n.links.map(l => ({
        page: l.page,
        x: l.xN * z, y: l.yN * z, w: l.wN * z, h: l.hN * z,
        url: l.url,
        targetPage: l.targetPage,
        targetY: (l.targetPage != null && l.rawY != null && state.naturalHeights.has(l.targetPage))
          ? (state.naturalHeights.get(l.targetPage) - l.rawY) * z
          : (l.targetPage != null ? 0 : null),
      }));
    },
    // V3.616 — detected figure regions in the SAME coordinate basis as
    // getTextItems (wrap-local CSS px at the current zoom). Consumed by
    // figure-capture's click-to-snip hotspots. V3.640 — caption-anchored
    // (PAGE_LAYOUT.figureRegions); label = the caption's opening text.
    // V3.826 — the page's painted-image/path boxes, NATURAL coords (or
    // null while unread). Label mode feeds these to PAGE_REGIONS.detect so
    // its first draft matches the hotspots.
    getPageGraphics(p) {
      const n = state.pageNodes.get(p);
      return (n && Array.isArray(n.graphics)) ? n.graphics : null;
    },
    getFigureRegions(p) {
      const n = state.pageNodes.get(p);
      if (!n || !n.figures) return [];
      const z = state.zoom;
      return n.figures.map(f => ({
        page: p,
        x: f.xN * z, y: f.yN * z, width: f.wN * z, height: f.hN * z,
        label: f.label || '',
      }));
    },
    forEachPage(cb) { state.pageNodes.forEach(cb); },
  };
}

/**
 * V3.333 — resolve a Link annotation's destination (explicit array or
 * named) to {targetPage (1-based), rawY (PDF bottom-up y | null)}.
 * Handles the XYZ / FitH / FitBH destination forms that carry a y; other
 * forms resolve with rawY=null (callers treat that as "top of page").
 */
async function _resolveDest(pdfDoc, dest) {
  let d = dest;
  try {
    if (typeof d === 'string') d = await pdfDoc.getDestination(d);
    if (!Array.isArray(d) || !d.length) return null;
    let pageIndex = null;
    if (d[0] && typeof d[0] === 'object') pageIndex = await pdfDoc.getPageIndex(d[0]);
    else if (typeof d[0] === 'number') pageIndex = d[0];
    if (pageIndex == null || pageIndex < 0) return null;
    const name = (d[1] && d[1].name) || '';
    let rawY = null;
    if (name === 'XYZ' && typeof d[3] === 'number') rawY = d[3];
    else if ((name === 'FitH' || name === 'FitBH') && typeof d[2] === 'number') rawY = d[2];
    return { targetPage: pageIndex + 1, rawY };
  } catch (_) {
    return null;
  }
}

/**
 * V3.93 — extract text items from a PDF blob/ArrayBuffer/URL without
 * rendering canvases or DOM. Used by library-upload to parse references
 * at import time. Returns a flat array of items shaped like the ones
 * paper-citations expects: {text, x, y, width, height, page}.
 * V3.333 — `opts.withAnnotations` switches the return to {items, links}:
 * links are the pages' Link annotations, rects + resolved internal
 * targets in the same top-down scale-1 coords as the items.
 *
 * `source` can be a Blob, ArrayBuffer, or { url } object.
 * `opts.maxPages` (V3.308) caps how many pages are parsed — first-page
 * metadata sniffing shouldn't pay for a whole 40-page PDF.
 * y is converted to top-down CSS-like coords so the paper-citations
 * line-grouping (which expects increasing y for items further down the
 * page) works without modification. Within each page we also sort by
 * (y asc, x asc) since pdf.js streams text-content in stream order
 * which isn't always reading order.
 */
async function extractTextItemsFromPdf(source, opts) {
  let pdfArg;
  if (source instanceof Blob) {
    const buf = await source.arrayBuffer();
    pdfArg = { data: new Uint8Array(buf) };
  } else if (source instanceof ArrayBuffer) {
    pdfArg = { data: new Uint8Array(source) };
  } else if (typeof source === 'string') {
    pdfArg = { url: source };
  } else if (source && source.url) {
    pdfArg = source;
  } else {
    throw new Error('extractTextItemsFromPdf: unsupported source');
  }
  const pdf = await getDocument(pdfArg).promise;
  const numPages = Math.min(pdf.numPages, (opts && opts.maxPages) || pdf.numPages);
  const withAnn = !!(opts && opts.withAnnotations);
  const out = [];
  const links = [];
  const pageHeights = new Map();
  for (let p = 1; p <= numPages; p++) {
    const page = await pdf.getPage(p);
    const viewport = page.getViewport({ scale: 1.0 });
    pageHeights.set(p, viewport.height);
    const tc = await page.getTextContent();
    const pageItems = [];
    for (const it of tc.items) {
      const text = it.str;
      if (!text || !text.trim()) continue;
      const t = it.transform || [1, 0, 0, 1, 0, 0];
      const x = t[4];
      // Convert PDF's bottom-left y origin to top-down CSS-like.
      const h = it.height || Math.abs(t[3]) || 12;
      const y = viewport.height - t[5] - h;
      pageItems.push({
        text,
        x, y,
        width: it.width || 0,
        height: h,
        page: p,
      });
    }
    // V3.371 — segment each page with the shared engine so the headless
    // order matches the viewer (was naive (y,x), which bridged columns for
    // paper-citations ref parsing + paper-search snippets). No ink probe
    // available headless → text-only detection.
    if (typeof window !== 'undefined' && window.PAGE_LAYOUT && window.PAGE_LAYOUT.segmentPage) {
      window.PAGE_LAYOUT.segmentPage(pageItems, { inkProbe: null });
    } else {
      pageItems.sort((a, b) => a.y - b.y || a.x - b.x);
    }
    for (const it of pageItems) out.push(it);
    if (withAnn) {
      let annots = [];
      try { annots = await page.getAnnotations(); } catch (_) { annots = []; }
      for (const a of annots) {
        if (!a || a.subtype !== 'Link' || !Array.isArray(a.rect)) continue;
        const [x1, y1, x2, y2] = a.rect;
        links.push({
          page: p,
          x: Math.min(x1, x2),
          y: viewport.height - Math.max(y1, y2),
          w: Math.abs(x2 - x1),
          h: Math.abs(y2 - y1),
          url: a.url || '',
          _dest: a.url ? null : (a.dest || null),
        });
      }
    }
  }
  if (withAnn) {
    // Resolve internal GoTo destinations (must happen before destroy()).
    for (const l of links) {
      const d = l._dest;
      delete l._dest;
      if (!d) continue;
      const t = await _resolveDest(pdf, d);
      if (!t) continue;
      l.targetPage = t.targetPage;
      let hgt = pageHeights.get(t.targetPage);
      if (hgt == null) {
        try { hgt = (await pdf.getPage(t.targetPage)).getViewport({ scale: 1.0 }).height; }
        catch (_) { hgt = null; }
      }
      l.targetY = (t.rawY != null && hgt != null) ? (hgt - t.rawY) : 0;
    }
  }
  try { pdf.destroy(); } catch (_) { /* ignore */ }
  return withAnn ? { items: out, links } : out;
}

window.PDF_VIEWER = { create, extractTextItemsFromPdf };
