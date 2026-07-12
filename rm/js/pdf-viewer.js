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
function _makePixelProbe(canvas, cssW, cssH) {
  if (!canvas || !canvas.width || !canvas.height || cssW <= 0 || cssH <= 0) return null;
  if (typeof document === 'undefined') return null;
  try {
    const gw = Math.max(40, Math.min(360, Math.round(cssW / 2)));
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

/** Reading-order comparator: same visual line → left-to-right, else top-down. */
function _lineSort(a, b) {
  const aMid = a.y + a.height / 2;
  const bMid = b.y + b.height / 2;
  const lineHere = (a.height + b.height) / 2;
  if (Math.abs(aMid - bMid) < lineHere * 0.6) return a.x - b.x;
  return a.y - b.y;
}

/**
 * Compute each text item's `index` (visual reading order) and `cluster`
 * (block id), mutating `items` in place. geom-selection drag-selects the
 * contiguous index range between two items, so the ONLY hard requirement
 * is: items in one column never interleave (in index space) with items in
 * another column — otherwise an in-column highlight leaks across the
 * gutter. (That was the reported "highlight spans two columns" bug.)
 *
 * Strategy:
 *   - Detect vertical column gutters (`_detectColumnGutters`).
 *   - If a page has gutters, order column-major within horizontal bands
 *     (`_orderByColumns`) — robust to ANY bridge (narrow gutter, spanning
 *     title/figure/heading), because order is derived from geometry, not
 *     from flood-fill connectivity that a single full-width element can
 *     collapse.
 *   - If a page has no gutter (single column, figure pages), keep the
 *     original DBSCAN flood-fill (`_orderByFloodFill`) which nicely splits
 *     captions / insets / sidebars into their own blocks.
 *
 * Pure geometry (no DOM) so it can be unit-tested with synthetic items.
 */
function _clusterAndSort(items, pxInk) {
  if (items.length === 0) return;
  const heights = items.map(i => i.height).slice().sort((a, b) => a - b);
  const lineH = heights[Math.floor(heights.length / 2)] || 12;

  const gutters = _detectColumnGutters(items, lineH, pxInk);
  if (typeof window !== 'undefined' && window.__PDF_VIEWER_DEBUG__ && gutters.length) {
    console.log(`[pdf-viewer] ${gutters.length} gutter(s):`,
      gutters.map(g => `${g.x1.toFixed(0)}–${g.x2.toFixed(0)}px`).join(' '));
  }

  if (gutters.length) _orderByColumns(items, gutters);
  else _orderByFloodFill(items, lineH);
}

/**
 * Column-major reading order for multi-column pages. Splits the page into
 * horizontal bands of consecutive same-kind rows — "full-width" rows
 * (where every gutter is filled, e.g. a title/heading/spanning figure) vs.
 * "multi-column" rows (where a gutter is a genuine whitespace channel).
 * Full-width bands read line-by-line; multi-column bands read one column
 * slot fully before the next. Concatenating bands top-to-bottom yields
 * natural reading order AND guarantees no column ever interleaves with
 * another in index space.
 */
function _orderByColumns(items, gutters) {
  const rowOf = gutters[0].rowOf;
  const centers = gutters.map(g => (g.x1 + g.x2) / 2).sort((a, b) => a - b);
  const slotOf = (it) => {
    const cx = it.x + it.width / 2;
    let s = 0;
    for (const c of centers) { if (cx > c) s++; else break; }
    return s;
  };
  const isMulti = (r) => gutters.some(g => g.cleanRow.has(r));

  for (const it of items) it._row = rowOf(it.y + it.height / 2);
  const rowsPresent = Array.from(new Set(items.map(it => it._row))).sort((a, b) => a - b);

  // Group consecutive present-rows of the same kind into bands.
  const bands = [];
  let cur = null;
  for (const r of rowsPresent) {
    const kind = isMulti(r) ? 'multi' : 'full';
    if (!cur || cur.kind !== kind) { cur = { kind, rows: new Set(), items: [] }; bands.push(cur); }
    cur.rows.add(r);
  }
  const rowToBand = new Map();
  bands.forEach((b, bi) => b.rows.forEach(r => rowToBand.set(r, bi)));
  for (const it of items) bands[rowToBand.get(it._row)].items.push(it);

  let idx = 0, clusterId = 0;
  const emit = (arr) => {
    arr.sort(_lineSort);
    const cid = clusterId++;
    for (const it of arr) { it.cluster = cid; it.index = idx; items[idx++] = it; delete it._row; }
  };
  for (const band of bands) {
    if (band.kind === 'full') { emit(band.items); continue; }
    const bySlot = new Map();
    for (const it of band.items) {
      const s = slotOf(it);
      let arr = bySlot.get(s); if (!arr) { arr = []; bySlot.set(s, arr); }
      arr.push(it);
    }
    for (const s of Array.from(bySlot.keys()).sort((a, b) => a - b)) emit(bySlot.get(s));
  }
}

/**
 * DBSCAN flood-fill clustering + reading-order sort — used for pages with
 * no detected column gutter (single column, figure-dominated). Two items
 * are neighbors if their bounding-rect x-gap ≤ 1.5×lineH and y-gap ≤
 * 1.0×lineH. Connected items form a block (column, inset, caption, figure
 * label); blocks sort into 2D reading order (top-to-bottom rows, left-to-
 * right within a row), items within a block by line then x.
 */
function _orderByFloodFill(items, lineH) {
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
  for (const c of clusters) c.items.sort(_lineSort);

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

/**
 * Detect vertical column gutters — the whitespace channels between text
 * columns — and return descriptors used to drive column-major reading
 * order:
 *
 *   { x1, x2, cleanRow: Set<rowIndex>, rowOf(yCenter) }
 *
 * [x1,x2] is the gutter's x-band; cleanRow holds the y-rows at which the
 * gutter is a *genuine* inter-column channel (vs. a full-width row that
 * fills it).
 *
 * Method:
 *   1. Project text onto the x-axis: coverage[bin] = how many rows have text
 *      over that x. The gutter is a deep valley flanked by the two columns.
 *      The valley ceiling is anchored to the valley FLOOR (not zero), so
 *      full-width content crossing the gutter (title, abstract, spanning
 *      headings/figures) raises the floor uniformly without hiding the
 *      valley — that was the bug that made heading-heavy papers read as one
 *      column. The band is centred on the valley's emptiest plateau so a
 *      ragged column edge doesn't drag it sideways.
 *   2. Per-row clean test: a row is full-width (not clean) when text fills
 *      ≥ 70% of the band — OR (when a pixel probe is supplied) when non-text
 *      ink spans the band there, so an image/figure crossing the gutter is
 *      seen even though no text item does. Two median-smoothing passes drop
 *      isolated misclassifications.
 *   3. Consistency guard: keep a gutter only if it is clean across a long
 *      contiguous run AND a large fraction of rows AND splits content into
 *      two substantial slabs — so a typographic "river" inside a single
 *      column is not mistaken for a gutter.
 *
 * Pure geometry apart from the optional `pxInk(x1,y1,x2,y2)` probe (which is
 * itself a pure function over a pre-sampled grid). Returns [] for
 * single-column / figure-dominated pages.
 */
function _detectColumnGutters(items, lineH, pxInk) {
  if (items.length < 12) return [];          // too little text to be multi-column
  let contentLeft = Infinity, contentRight = -Infinity, yMin = Infinity;
  for (const it of items) {
    if (it.x < contentLeft) contentLeft = it.x;
    if (it.x + it.width > contentRight) contentRight = it.x + it.width;
    if (it.y < yMin) yMin = it.y;
  }
  const contentW = contentRight - contentLeft;
  if (contentW <= 0) return [];

  const minGutterPx = Math.max(lineH * 0.35, contentW * 0.008);

  // Group items into rows (by y-center).
  const rowH = Math.max(4, lineH * 0.9);
  const rowOf = (yc) => Math.floor((yc - yMin) / rowH);
  const rows = new Map();
  for (const it of items) {
    const r = rowOf(it.y + it.height / 2);
    let arr = rows.get(r);
    if (!arr) { arr = []; rows.set(r, arr); }
    arr.push(it);
  }
  const sortedRows = Array.from(rows.keys()).sort((a, b) => a - b);
  if (sortedRows.length < 5) return [];
  for (const arr of rows.values()) arr.sort((a, b) => a.x - b.x);

  // --- x-occupancy projection ------------------------------------------
  // coverage[b] = number of rows with text overlapping x-bin b. Very fine
  // bins so a narrow gutter isn't eroded away by column word-edges rounding
  // into its boundary bins.
  const binStep = Math.max(0.6, lineH * 0.07);
  const nBins = Math.max(20, Math.min(2000, Math.round(contentW / binStep)));
  const bw = contentW / nBins;
  const cov = new Array(nBins).fill(0);
  for (const arr of rows.values()) {
    for (const it of arr) {
      const b0 = Math.max(0, Math.floor((it.x - contentLeft) / bw));
      const b1 = Math.min(nBins - 1, Math.floor((it.x + it.width - contentLeft) / bw));
      for (let b = b0; b <= b1; b++) cov[b]++;
    }
  }
  let maxCov = 0;
  for (const c of cov) if (c > maxCov) maxCov = c;
  if (maxCov < 4) return [];

  // Trim sparse outer margins to the real text extent.
  const contentFloor = maxCov * 0.15;
  let lo = 0; while (lo < nBins && cov[lo] < contentFloor) lo++;
  let hi = nBins - 1; while (hi > lo && cov[hi] < contentFloor) hi--;
  if (hi - lo < 6) return [];

  // The gutter is the deepest interior valley. Anchor the ceiling to the
  // valley FLOOR (the emptiest interior bin), not to zero — full-width
  // content that crosses the gutter (title, multi-line abstract, spanning
  // headings, wide figures) raises the floor uniformly but the valley stays
  // just as deep relative to the flanking columns. (An absolute near-zero
  // ceiling was the bug that made heading-heavy papers read as one column.)
  let interiorMin = Infinity;
  for (let b = lo; b <= hi; b++) if (cov[b] < interiorMin) interiorMin = cov[b];
  const depth = maxCov - interiorMin;
  if (depth < maxCov * 0.4) return [];             // no strong interior valley → single col

  const valleyCeil = interiorMin + depth * 0.3;
  const floorCeil = interiorMin + Math.max(1, depth * 0.05);  // the truly-empty channel
  const flankNeed = maxCov * 0.5;                  // a real column on each side

  const leftMax = new Array(nBins).fill(0);
  const rightMax = new Array(nBins).fill(0);
  let run = 0;
  for (let b = lo; b <= hi; b++) { run = Math.max(run, cov[b]); leftMax[b] = run; }
  run = 0;
  for (let b = hi; b >= lo; b--) { run = Math.max(run, cov[b]); rightMax[b] = run; }

  const bands = [];
  let s = -1;
  for (let b = lo + 1; b <= hi - 1; b++) {
    const low = cov[b] <= valleyCeil;
    if (low && s < 0) s = b;
    const runEnds = s >= 0 && (!low || b === hi - 1);
    if (runEnds) {
      const e = low ? b : b - 1;                    // inclusive end of low run
      // +2·bw: the column word-edges fully occupy the gutter's boundary bins,
      // so the empty-bin run undercounts the true channel by up to one bin
      // each side. Restore that before the width gate.
      const valleyW = (e - s + 1) * bw + 2 * bw;
      const flankedLeft = leftMax[s - 1] >= flankNeed;
      const flankedRight = rightMax[e + 1] >= flankNeed;
      if (valleyW >= minGutterPx && flankedLeft && flankedRight) {
        // Centre the band on the valley's emptiest floor plateau — the
        // always-empty channel. For a ragged column this sits at the true
        // gutter (between max line-extent and the next column), not at the
        // valley midpoint which a ragged edge would drag sideways. Give the
        // band a minimum width so the per-row occupancy test below is stable
        // even for a thin gutter.
        let cs = s, ce = e;
        while (cs <= e && cov[cs] > floorCeil) cs++;
        while (ce >= s && cov[ce] > floorCeil) ce--;
        if (cs > ce) { cs = s; ce = e; }
        const center = contentLeft + ((cs + ce + 1) / 2) * bw;
        const halfW = Math.max((ce - cs + 1) * bw, minGutterPx) / 2;
        bands.push({ x1: center - halfW, x2: center + halfW });
      }
      s = -1;
    }
  }
  if (!bands.length) return [];

  // --- per-row clean test -----------------------------------------------
  // A gutter is "clean" (a genuine inter-column channel) at a row when text
  // does NOT occupy its band there. occupancy = total width of items
  // intersecting [x1,x2]; a row is full-width (not clean) only when text
  // fills ≥ 70% of the band — genuine full-width text (title / abstract /
  // spanning heading) crosses the whole band, while a long ragged body line
  // only pokes part-way in. The high bar stops such a line from being read
  // as full-width and fragmenting its column block (which would interleave
  // the two columns in reading order).
  for (const g of bands) {
    const bandW = g.x2 - g.x1;
    const third = bandW / 3;
    const full = new Map();
    for (const r of sortedRows) {
      let occ = 0;
      for (const it of rows.get(r)) {
        const ov = Math.min(it.x + it.width, g.x2) - Math.max(it.x, g.x1);
        if (ov > 0) occ += ov;
      }
      let isFull = occ >= bandW * 0.7;
      // Pixel fallback: an image/figure spanning the gutter leaves no text
      // item, so text occupancy reads 0. Require ink at BOTH band edges (a
      // wide element actually crosses the channel) — this ignores a thin
      // vertical column rule, which only inks the band's centre.
      if (!isFull && pxInk) {
        const yt = yMin + r * rowH, yb = yt + rowH;
        const inkL = pxInk(g.x1, yt, g.x1 + third, yb);
        const inkR = pxInk(g.x2 - third, yt, g.x2, yb);
        if (inkL >= 0.05 && inkR >= 0.05) isFull = true;
      }
      full.set(r, isFull);
    }
    // Median-smooth over present rows: flip any single row whose both
    // neighbours disagree. Kills isolated noise — a stray page number or a
    // lone ragged line that pokes into the band (false "full") would
    // otherwise fragment the body and break reading order, and a lone
    // abstract line whose word-gap aligned with the band (false "clean")
    // would otherwise be bisected. Genuine multi-line full-width elements
    // (title, abstract, spanning figures) span ≥ 2 rows and survive.
    let cls = sortedRows.map(r => full.get(r));
    // Two smoothing passes remove isolated 1- and 2-row classification noise
    // (a stray page number, a single ragged line poking into the band, or a
    // lone abstract line whose word-gap aligned with the band). Genuine
    // multi-row full-width elements survive.
    for (let pass = 0; pass < 2; pass++) {
      const next = cls.slice();
      for (let i = 1; i < cls.length - 1; i++) {
        if (cls[i] !== cls[i - 1] && cls[i] !== cls[i + 1]) next[i] = !cls[i];
      }
      cls = next;
    }
    const smoothed = cls;
    const clean = new Set();
    let longestRun = 0, curRun = 0;
    sortedRows.forEach((r, i) => {
      if (!smoothed[i]) { clean.add(r); curRun++; if (curRun > longestRun) longestRun = curRun; }
      else curRun = 0;
    });
    g.cleanRow = clean;
    g.rowOf = rowOf;
    g._longestClean = longestRun;
  }
  // Consistency guard. A real gutter is a clean inter-column channel that the
  // columns essentially never cross, so it is clean (a) across a long
  // CONTIGUOUS block of rows — a body column — and (b) in a large FRACTION of
  // all rows. A typographic "river" (a chance vertical alignment of word
  // spaces within ONE column) fails both: text crosses it in most rows, so it
  // is clean only over scattered, short runs. The run floor is absolute (not
  // a page fraction) so a short multi-column section still qualifies when
  // full-width headings split the page into many bands.
  const minRun = 8;
  const minFrac = sortedRows.length * 0.55;
  const minSide = contentW * 0.2;     // each column must be a substantial slab
  return bands.filter(g =>
    g._longestClean >= minRun &&
    g.cleanRow.size >= minFrac &&
    (g.x1 - contentLeft) >= minSide &&
    (contentRight - g.x2) >= minSide);
}

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
    const pxInk = _makePixelProbe(node.canvas, pageWidth, pageHeight);
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

/**
 * V3.93 — extract text items from a PDF blob/ArrayBuffer/URL without
 * rendering canvases or DOM. Used by library-upload to parse references
 * at import time. Returns a flat array of items shaped like the ones
 * paper-citations expects: {text, x, y, width, height, page}.
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
  const out = [];
  for (let p = 1; p <= numPages; p++) {
    const page = await pdf.getPage(p);
    const viewport = page.getViewport({ scale: 1.0 });
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
    pageItems.sort((a, b) => a.y - b.y || a.x - b.x);
    for (const it of pageItems) out.push(it);
  }
  try { pdf.destroy(); } catch (_) { /* ignore */ }
  return out;
}

window.PDF_VIEWER = { create, extractTextItemsFromPdf };
