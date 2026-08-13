/* page-layout.js — shared page-segmentation engine (V3.371, layout R2).
 *
 * Extracted VERBATIM from pdf-viewer.js's module-scope layout functions so
 * a single engine serves (a) the interactive viewer's drag-selection, (b)
 * the headless extractTextItemsFromPdf path that paper-citations and
 * paper-search consume, and (c) the layout-audit harness. Previously the
 * viewer segmented but the headless path only sorted (y,x) — bridging
 * columns for every downstream reuse.
 *
 * Public surface (window.PAGE_LAYOUT):
 *   segmentPage(items, {pageWidth, pageHeight, inkProbe}) →
 *       { items, blocks: [{id, bbox:{x,y,w,h}, itemIdxs, column, bandKind}] }
 *     Mutates each item with `index` (reading order), `cluster` (block id),
 *     and `column` (0-based slot, or -1 for full-width). Column ordering
 *     guarantees no column interleaves another in index space, so a
 *     block-clamped selection can never bridge a gutter.
 *   Internals also exposed for unit tests: _lineSort, _clusterAndSort,
 *   _detectColumnGutters, _orderByColumns, _orderByFloodFill.
 *
 * Pure geometry — no DOM. inkProbe is the optional pxInk(x1,y1,x2,y2) from
 * pdf-viewer._makePixelProbe (canvas ink), or null (headless / text-only).
 */

(function () {
  'use strict';

  /** Reading-order comparator: same visual line → left-to-right, else top-down. */
  function _lineSort(a, b) {
    const aMid = a.y + a.height / 2;
    const bMid = b.y + b.height / 2;
    const lineHere = (a.height + b.height) / 2;
    if (Math.abs(aMid - bMid) < lineHere * 0.6) return a.x - b.x;
    return a.y - b.y;
  }

  function _clusterAndSort(items, pxInk) {
    if (items.length === 0) return [];
    const heights = items.map(i => i.height).slice().sort((a, b) => a - b);
    const lineH = heights[Math.floor(heights.length / 2)] || 12;

    const gutters = _detectColumnGutters(items, lineH, pxInk);
    if (typeof window !== 'undefined' && window.__PDF_VIEWER_DEBUG__ && gutters.length) {
      console.log(`[page-layout] ${gutters.length} gutter(s):`,
        gutters.map(g => `${g.x1.toFixed(0)}–${g.x2.toFixed(0)}px`).join(' '));
    }

    if (gutters.length) _orderByColumns(items, gutters);
    else _orderByFloodFill(items, lineH);
    return gutters;
  }

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
    const emit = (arr, bandKind) => {
      arr.sort(_lineSort);
      const cid = clusterId++;
      for (const it of arr) { it.cluster = cid; it.index = idx; it._bandKind = bandKind; items[idx++] = it; delete it._row; }
    };
    for (const band of bands) {
      if (band.kind === 'full') { emit(band.items, 'full'); continue; }
      const bySlot = new Map();
      for (const it of band.items) {
        const s = slotOf(it);
        let arr = bySlot.get(s); if (!arr) { arr = []; bySlot.set(s, arr); }
        arr.push(it);
      }
      for (const s of Array.from(bySlot.keys()).sort((a, b) => a - b)) emit(bySlot.get(s), 'column');
    }
  }

  function _orderByFloodFill(items, lineH) {
    // V3.371 — x-eps was a flat 1.5×lineH, which bridged narrow gutters when
    // the page fell through to flood-fill. Cap it by the median inter-word
    // gap estimate so two columns with a real channel don't merge, while
    // intra-line word spacing still connects (single-column, caption blocks).
    const epsX = lineH * 1.2;
    const epsY = lineH * 1.0;

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
      const aH = a.maxY - a.minY;
      const bH = b.maxY - b.minY;
      const overlap = Math.max(0, Math.min(a.maxY, b.maxY) - Math.max(a.minY, b.minY));
      const sameRow = overlap / Math.max(1, Math.min(aH, bH)) > 0.3;
      if (sameRow) return a.minX - b.minX;
      return a.minY - b.minY;
    });

    for (const c of clusters) c.items.sort(_lineSort);

    let idx = 0;
    for (const c of clusters) {
      for (const it of c.items) {
        it.cluster = c.id;
        it.index = idx;
        it._bandKind = 'flow';
        items[idx++] = it;
      }
    }
  }

  function _detectColumnGutters(items, lineH, pxInk) {
    if (items.length < 12) return [];
    let contentLeft = Infinity, contentRight = -Infinity, yMin = Infinity;
    for (const it of items) {
      if (it.x < contentLeft) contentLeft = it.x;
      if (it.x + it.width > contentRight) contentRight = it.x + it.width;
      if (it.y < yMin) yMin = it.y;
    }
    const contentW = contentRight - contentLeft;
    if (contentW <= 0) return [];

    const minGutterPx = Math.max(lineH * 0.35, contentW * 0.008);

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

    const contentFloor = maxCov * 0.15;
    let lo = 0; while (lo < nBins && cov[lo] < contentFloor) lo++;
    let hi = nBins - 1; while (hi > lo && cov[hi] < contentFloor) hi--;
    if (hi - lo < 6) return [];

    let interiorMin = Infinity;
    for (let b = lo; b <= hi; b++) if (cov[b] < interiorMin) interiorMin = cov[b];
    const depth = maxCov - interiorMin;
    if (depth < maxCov * 0.4) return [];

    const valleyCeil = interiorMin + depth * 0.3;
    const floorCeil = interiorMin + Math.max(1, depth * 0.05);
    const flankNeed = maxCov * 0.5;

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
        const e = low ? b : b - 1;
        const valleyW = (e - s + 1) * bw + 2 * bw;
        const flankedLeft = leftMax[s - 1] >= flankNeed;
        const flankedRight = rightMax[e + 1] >= flankNeed;
        if (valleyW >= minGutterPx && flankedLeft && flankedRight) {
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
        if (!isFull && pxInk) {
          const yt = yMin + r * rowH, yb = yt + rowH;
          const inkL = pxInk(g.x1, yt, g.x1 + third, yb);
          const inkR = pxInk(g.x2 - third, yt, g.x2, yb);
          if (inkL >= 0.05 && inkR >= 0.05) isFull = true;
        }
        full.set(r, isFull);
      }
      let cls = sortedRows.map(r => full.get(r));
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
    const minRun = 8;
    const minFrac = sortedRows.length * 0.55;
    const minSide = contentW * 0.2;
    return bands.filter(g =>
      g._longestClean >= minRun &&
      g.cleanRow.size >= minFrac &&
      (g.x1 - contentLeft) >= minSide &&
      (contentRight - g.x2) >= minSide);
  }

  /**
   * Public entry: segment a page's text items into ordered blocks.
   * Mutates items with index/cluster/column; returns {items, blocks}.
   */
  function segmentPage(items, opts) {
    opts = opts || {};
    if (!items || !items.length) return { items: items || [], blocks: [] };
    const gutters = _clusterAndSort(items, opts.inkProbe || null);
    const centers = gutters.map(g => (g.x1 + g.x2) / 2).sort((a, b) => a - b);

    // Derive blocks from cluster assignment (contiguous in index space).
    const byCluster = new Map();
    items.forEach((it, i) => {
      const c = it.cluster == null ? 0 : it.cluster;
      if (!byCluster.has(c)) byCluster.set(c, { id: c, itemIdxs: [], bandKind: it._bandKind || 'flow',
        x1: Infinity, y1: Infinity, x2: -Infinity, y2: -Infinity });
      const blk = byCluster.get(c);
      blk.itemIdxs.push(it.index);
      if (it.x < blk.x1) blk.x1 = it.x;
      if (it.y < blk.y1) blk.y1 = it.y;
      if (it.x + it.width > blk.x2) blk.x2 = it.x + it.width;
      if (it.y + it.height > blk.y2) blk.y2 = it.y + it.height;
    });

    // Per-block column: -1 (full-width) if the block bbox straddles a
    // gutter, else the slot = #gutter-centers left of the block center.
    function columnOf(blk) {
      if (!centers.length) return 0;
      for (const c of centers) {
        if (blk.x1 < c - 1 && blk.x2 > c + 1) return -1;   // straddles → full width
      }
      const bc = (blk.x1 + blk.x2) / 2;
      let s = 0;
      for (const c of centers) { if (bc > c) s++; else break; }
      return s;
    }

    const blocks = [];
    for (const blk of byCluster.values()) {
      blk.column = columnOf(blk);
      blk.bbox = { x: blk.x1, y: blk.y1, w: blk.x2 - blk.x1, h: blk.y2 - blk.y1 };
      delete blk.x1; delete blk.y1; delete blk.x2; delete blk.y2;
      blocks.push(blk);
    }
    blocks.sort((a, b) => (a.itemIdxs[0] || 0) - (b.itemIdxs[0] || 0));

    // V3.373 — type each block (header/footer/pagenum/caption/footnote/
    // heading/abstract/keywords/body). Types let the selection clamp treat
    // margin furniture as islands and let citation scanning skip it.
    classifyBlocks(blocks, items, {
      pageHeight: opts.pageHeight || _maxBottom(items),
      pageWidth: opts.pageWidth || _maxRight(items),
    });

    // Stamp column + type onto each item + tidy the scratch field.
    const colByCluster = new Map(blocks.map(b => [b.id, b.column]));
    const typeByCluster = new Map(blocks.map(b => [b.id, b.type]));
    for (const it of items) {
      it.column = colByCluster.has(it.cluster) ? colByCluster.get(it.cluster) : 0;
      it.blockType = typeByCluster.has(it.cluster) ? typeByCluster.get(it.cluster) : 'body';
      delete it._bandKind;
    }
    return { items, blocks };
  }

  function _maxBottom(items) { let m = 0; for (const it of items) m = Math.max(m, it.y + it.height); return m || 792; }
  function _maxRight(items) { let m = 0; for (const it of items) m = Math.max(m, it.x + it.width); return m || 612; }

  const RE_CAPTION = /^\s*(?:fig(?:ure)?|table|scheme|supp(?:lementary)?|extended\s+data)\b/i;
  const RE_ABSTRACT = /^\s*abstract\b/i;
  const RE_KEYWORDS = /^\s*key\s?words?\b/i;
  const RE_HEADINGWORD = /^\s*(?:references|bibliography|introduction|methods?|materials|results|discussion|conclusions?|acknowledge?ments?)\b/i;

  /**
   * V3.373 — deterministic feature-based block typing. A decision list over
   * geometry + a few keyword anchors; no ML. `block.type` ∈ {body, heading,
   * abstract, keywords, caption, footnote, sidenote, header, footer,
   * pagenum}. Mutates each block; returns the blocks array.
   */
  function classifyBlocks(blocks, items, ctx) {
    const pageH = ctx.pageHeight, pageW = ctx.pageWidth;
    const textOf = (blk) => {
      const first = blk.itemIdxs[0];
      const it = items.find(x => x.index === first);
      return (it && it.text) || '';
    };
    // Body median height across all items (typography baseline).
    const hs = items.map(i => i.height).filter(h => h > 0).sort((a, b) => a - b);
    const bodyH = hs[Math.floor(hs.length / 2)] || 12;
    const topMargin = pageH * 0.08, botMargin = pageH * 0.92;

    for (const blk of blocks) {
      const bb = blk.bbox;
      const nItems = blk.itemIdxs.length;
      const medH = (function () {
        const bh = blk.itemIdxs.map(ix => { const it = items.find(x => x.index === ix); return it ? it.height : bodyH; })
          .filter(h => h > 0).sort((a, b) => a - b);
        return bh[Math.floor(bh.length / 2)] || bodyH;
      })();
      const cy = bb.y + bb.h / 2;
      const first = textOf(blk);
      const small = medH < bodyH * 0.82;
      const tiny = nItems <= 3;

      let type = 'body';
      // Margin furniture: short/small runs in the top or bottom page bands.
      if (cy < topMargin && bb.h < bodyH * 3) type = 'header';
      else if (cy > botMargin && bb.h < bodyH * 3) {
        type = (nItems <= 2 && /^\s*\d{1,4}\s*$/.test(first.replace(/\s/g, ''))) ? 'pagenum' : 'footer';
      } else if (RE_ABSTRACT.test(first) && bb.w > pageW * 0.6) type = 'abstract';
      else if (RE_KEYWORDS.test(first)) type = 'keywords';
      else if (RE_CAPTION.test(first) && (small || nItems < 12)) type = 'caption';
      else if (small && cy > pageH * 0.6 && bb.w < pageW * 0.55) type = 'footnote';
      else if (blk.column >= 0 && bb.w < pageW * 0.28 && bb.x > pageW * 0.62) type = 'sidenote';
      else if (medH > bodyH * 1.25 && nItems <= 6) type = 'heading';
      else if (tiny && /^\s*\d{1,4}\s*$/.test(first.replace(/\s/g, ''))) type = 'pagenum';

      blk.type = type;
    }
    return blocks;
  }

  window.PAGE_LAYOUT = {
    segmentPage,
    classifyBlocks,
    // Non-body block types the selection clamp treats as islands (a body
    // drag skips them; selecting one still works when an endpoint is in it).
    FURNITURE_TYPES: ['header', 'footer', 'pagenum', 'caption', 'footnote', 'sidenote'],
    // internals for tests / advanced callers
    _lineSort, _clusterAndSort, _detectColumnGutters, _orderByColumns, _orderByFloodFill,
  };
})();
