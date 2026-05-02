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
  TextLayer,
} from '/rm/vendor/pdfjs/pdf.mjs';

GlobalWorkerOptions.workerSrc = '/rm/vendor/pdfjs/pdf.worker.mjs';

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
    destroyed: false,
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
    container.appendChild(wrap);
    state.pageNodes.set(i, { wrap, canvas, textLayer, selLayer, overlay, items: [] });
  }

  async function _renderPage(pageNum) {
    if (state.destroyed) return;
    const node = state.pageNodes.get(pageNum);
    if (!node) return;
    const page = await state.doc.getPage(pageNum);
    if (state.destroyed) return;

    const viewport = page.getViewport({ scale: state.zoom });
    // Use devicePixelRatio for crisp rendering on hi-DPI displays.
    const dpr = window.devicePixelRatio || 1;
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
    if (opts.onPageReady) {
      try { opts.onPageReady(pageNum, node); } catch (e) { console.error(e); }
    }
  }

  /**
   * Walk the textLayer's child spans and capture each as a "text item" with
   * its bounding rect (page-wrap-local CSS pixels) and text content. Items
   * are sorted in visual reading order:
   *
   *   1. Detect columns (1 or 2) by finding the deepest vertical gap in
   *      the item-density histogram across the middle of the page.
   *   2. Assign each item to a column by its center-x.
   *   3. Sort: column index → line (y-center) → x within line.
   *
   * This is what makes selection within a single column not "leak" into
   * the other column.
   */
  function _collectTextItems(node) {
    const wrapRect = node.wrap.getBoundingClientRect();
    const pageWidth = parseFloat(node.wrap.style.width) || wrapRect.width;
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

    // Cluster items into text blocks via DBSCAN. Each block becomes its own
    // "column" for selection purposes — items in different blocks never
    // appear in the slice between two selected items, regardless of layout.
    _clusterAndSort(items);

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

  /**
   * DBSCAN spatial clustering of text items + reading-order sort.
   *
   * Two items are neighbors if both:
   *   - their bounding-rect x-gap   ≤ 1.5 × median line height
   *   - their bounding-rect y-gap   ≤ 1.0 × median line height
   *
   * Connected items form a cluster (a "text block": column, inset, sidebar,
   * caption, figure label). After clustering we sort:
   *   1. Clusters into 2D reading order — top-to-bottom rows of clusters,
   *      left-to-right within a row (rows defined by significant y-overlap).
   *   2. Items within a cluster by line (y-center) then x.
   *
   * Selection across cluster boundaries is unusual and intentional — the
   * user has dragged from one block into another. Selection within a
   * cluster never leaks into another cluster.
   */
  function _clusterAndSort(items) {
    if (items.length === 0) return;
    const heights = items.map(i => i.height).slice().sort((a, b) => a - b);
    const lineH = heights[Math.floor(heights.length / 2)] || 12;
    const epsX = lineH * 1.5;
    const epsY = lineH * 1.0;

    // Spatial bucketing for a faster neighbor search than O(n²).
    const cellSize = Math.max(epsX, epsY) * 2;
    const buckets = new Map();
    function bucketKey(cx, cy) { return `${cx},${cy}`; }
    items.forEach((it, i) => {
      const cxs = Math.floor(it.x / cellSize);
      const cys = Math.floor(it.y / cellSize);
      const cxe = Math.floor((it.x + it.width) / cellSize);
      const cye = Math.floor((it.y + it.height) / cellSize);
      for (let cx = cxs; cx <= cxe; cx++) {
        for (let cy = cys; cy <= cye; cy++) {
          const key = bucketKey(cx, cy);
          if (!buckets.has(key)) buckets.set(key, []);
          buckets.get(key).push(i);
        }
      }
    });

    function neighbors(idx) {
      const a = items[idx];
      const cxs = Math.floor((a.x - epsX) / cellSize);
      const cys = Math.floor((a.y - epsY) / cellSize);
      const cxe = Math.floor((a.x + a.width + epsX) / cellSize);
      const cye = Math.floor((a.y + a.height + epsY) / cellSize);
      const out = new Set();
      for (let cx = cxs; cx <= cxe; cx++) {
        for (let cy = cys; cy <= cye; cy++) {
          const list = buckets.get(bucketKey(cx, cy));
          if (!list) continue;
          for (const j of list) {
            if (j === idx) continue;
            const b = items[j];
            const dx = Math.max(0, Math.max(a.x - (b.x + b.width), b.x - (a.x + a.width)));
            const dy = Math.max(0, Math.max(a.y - (b.y + b.height), b.y - (a.y + a.height)));
            if (dx <= epsX && dy <= epsY) out.add(j);
          }
        }
      }
      return out;
    }

    // BFS flood-fill from each unvisited item to build clusters.
    const visited = new Array(items.length).fill(false);
    const clusterIds = new Array(items.length).fill(-1);
    let clusterCount = 0;
    for (let i = 0; i < items.length; i++) {
      if (visited[i]) continue;
      visited[i] = true;
      const id = clusterCount++;
      clusterIds[i] = id;
      const queue = [i];
      while (queue.length) {
        const k = queue.shift();
        const ns = neighbors(k);
        for (const n of ns) {
          if (visited[n]) continue;
          visited[n] = true;
          clusterIds[n] = id;
          queue.push(n);
        }
      }
    }

    // Build cluster-bbox + sort clusters into reading order.
    const clusters = [];
    for (let i = 0; i < clusterCount; i++) clusters.push({ id: i, items: [], minX: Infinity, minY: Infinity, maxX: -Infinity, maxY: -Infinity });
    items.forEach((it, idx) => {
      const c = clusters[clusterIds[idx]];
      c.items.push(it);
      c.minX = Math.min(c.minX, it.x);
      c.minY = Math.min(c.minY, it.y);
      c.maxX = Math.max(c.maxX, it.x + it.width);
      c.maxY = Math.max(c.maxY, it.y + it.height);
    });

    clusters.sort((a, b) => {
      // "Same row" if vertical overlap > 30% of shorter cluster height.
      const aH = a.maxY - a.minY;
      const bH = b.maxY - b.minY;
      const overlap = Math.max(0, Math.min(a.maxY, b.maxY) - Math.max(a.minY, b.minY));
      const sameRow = overlap / Math.max(1, Math.min(aH, bH)) > 0.3;
      if (sameRow) return a.minX - b.minX;
      return a.minY - b.minY;
    });

    // Sort items within each cluster by line, then x.
    for (const c of clusters) {
      c.items.sort((a, b) => {
        const aMid = a.y + a.height / 2;
        const bMid = b.y + b.height / 2;
        const lineHere = (a.height + b.height) / 2;
        if (Math.abs(aMid - bMid) < lineHere * 0.6) return a.x - b.x;
        return a.y - b.y;
      });
    }

    // Reassemble items in final reading order. Mutate the caller's array
    // in place so callers using the same reference see the new order.
    let idx = 0;
    for (const c of clusters) {
      for (const it of c.items) {
        it.cluster = c.id;
        it.index = idx;
        items[idx++] = it;
      }
    }
  }

  async function _renderAll() {
    // Render sequentially to avoid hammering the worker. For a 50-page paper
    // this takes a few seconds — acceptable for v1 (Phase 2). Phase 3+ can
    // add virtualized rendering if perf becomes an issue.
    for (let i = 1; i <= state.numPages; i++) {
      if (state.destroyed) return;
      await _renderPage(i);
    }
  }

  function gotoPage(n) {
    const target = Math.max(1, Math.min(state.numPages, n | 0));
    state.currentPage = target;
    const node = state.pageNodes.get(target);
    if (node) node.wrap.scrollIntoView({ behavior: 'smooth', block: 'start' });
    if (opts.onPageChange) opts.onPageChange(target);
  }

  async function setZoom(z) {
    state.zoom = Math.max(0.4, Math.min(4.0, z));
    if (opts.onZoomChange) opts.onZoomChange(state.zoom);
    // Re-render all pages at the new zoom.
    for (let i = 1; i <= state.numPages; i++) {
      if (state.destroyed) return;
      await _renderPage(i);
    }
  }

  function _wireScrollSpy() {
    // Update currentPage as the user scrolls (whichever page-wrap is closest
    // to the top of the container counts as current).
    let raf = 0;
    container.addEventListener('scroll', () => {
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
      });
    }, { passive: true });
  }

  function destroy() {
    state.destroyed = true;
    state.renderTasks.forEach(t => { try { t.cancel(); } catch (_) { /* ignore */ } });
    state.renderTasks.clear();
    state.pageNodes.clear();
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
    // Exposed for Phase 3 annotation-overlay to reach the per-page DOM.
    getPageNode(pageNum) { return state.pageNodes.get(pageNum); },
    // Exposed for geom-selection — text items in visual reading order.
    getTextItems(pageNum) {
      const n = state.pageNodes.get(pageNum);
      return (n && n.items) || [];
    },
    forEachPage(cb) { state.pageNodes.forEach(cb); },
  };
}

window.PDF_VIEWER = { create };
