/* layout-audit.js — layout-segmentation ground-truth harness (R1).
 *
 * Loads the synthetic fixture suite (rm/test-fixtures/layout/, generated
 * by scripts/gen_layout_fixtures.py), extracts text items with pdf.js,
 * runs the page-segmentation engine, and scores it against ground truth:
 *
 *   column accuracy   — items assigned to the correct column
 *   block purity      — computed clusters containing exactly one GT block
 *   order violations  — item pairs whose reading order contradicts GT
 *   bridge rate       — random in-block drags that pull in another block
 *                       (this is the user's "highlight bridges sections"
 *                        symptom, measured directly)
 *
 * The fixture run needs NO auth or Firestore — it works over a plain
 * `python3 -m http.server`. A second section (admin-gated) runs the same
 * segmentation over real library PDFs for strategy/outlier stats.
 *
 * Segmentation source: window.PAGE_LAYOUT.segmentPage when present (R2+);
 * until then it falls back to naive (y,x) order with a single cluster —
 * the honest pre-engine baseline the harness records.
 */

(function () {
  const $ = id => document.getElementById(id);
  const FX_DIR = '/rm/test-fixtures/layout/';
  let _rows = [];
  let _baseline = null;

  function _esc(s) {
    return String(s ?? '').replace(/[&<>"']/g, c => ({
      '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;'
    }[c]));
  }
  function _status(m) { $('la-status').textContent = m; }

  // ---- segmentation adapter ------------------------------------------------

  // Run whatever segmentation engine is available on a page's items.
  // Returns items stamped with {index, cluster, column?} in engine order.
  function _segment(items, pageW, pageH) {
    if (window.PAGE_LAYOUT && PAGE_LAYOUT.segmentPage) {
      const out = PAGE_LAYOUT.segmentPage(items, { pageWidth: pageW, pageHeight: pageH, inkProbe: null });
      return out.items || items;
    }
    // Baseline: naive (y,x) — mirrors today's headless extractTextItemsFromPdf.
    const sorted = items.slice().sort((a, b) => a.y - b.y || a.x - b.x);
    sorted.forEach((it, i) => { it.index = i; it.cluster = 0; });
    return sorted;
  }

  // ---- truth matching ------------------------------------------------------

  // Assign each extracted item to a GT block by center-point containment in
  // a truth run's bbox (small tolerance). Returns {block, column, order} or
  // null (unmatched — figure labels, rotated text, etc.).
  function _matchToTruth(item, truthPage) {
    const cx = item.x + item.width / 2;
    const cy = item.y + item.height / 2;
    let best = null, bestD = Infinity;
    for (const run of truthPage.runs) {
      const pad = 2;
      if (cx >= run.x - pad && cx <= run.x + run.w + pad &&
          cy >= run.y - pad && cy <= run.y + run.h + pad) {
        const d = Math.abs(cy - (run.y + run.h / 2));
        if (d < bestD) { bestD = d; best = run; }
      }
    }
    if (!best) return null;
    const blk = truthPage.blocks.find(b => b.id === best.block);
    return blk ? { block: blk.id, column: blk.column, order: blk.order } : null;
  }

  // Global GT reading order for a matched item: (block.order, y, x).
  function _truthKey(m, item) { return [m.order, item.y, item.x]; }
  function _cmpKey(a, b) { return a[0] - b[0] || a[1] - b[1] || a[2] - b[2]; }

  function _scorePage(items, truthPage, rng) {
    const seg = _segment(items, truthPage._pw, truthPage._ph);
    // Attach GT to each item.
    const matched = [];
    for (const it of seg) {
      const m = _matchToTruth(it, truthPage);
      if (m) matched.push({ it, m });
    }
    const nMatched = matched.length;

    // --- column accuracy: engine column vs GT column (skip full-width -1) ---
    let colOK = 0, colTotal = 0;
    for (const { it, m } of matched) {
      if (m.column < 0) continue;
      colTotal++;
      if (it.column === m.column) colOK++;
    }

    // --- block purity: clusters containing exactly one GT block ---
    const byCluster = new Map();
    for (const { it, m } of matched) {
      const c = it.cluster == null ? 0 : it.cluster;
      if (!byCluster.has(c)) byCluster.set(c, new Set());
      byCluster.get(c).add(m.block);
    }
    let pureClusters = 0;
    for (const s of byCluster.values()) if (s.size === 1) pureClusters++;
    const clusterCount = byCluster.size;

    // --- reading-order violations: engine index order vs GT order ---
    const ordered = matched.slice().sort((a, b) => a.it.index - b.it.index);
    const gtRank = matched.slice()
      .sort((a, b) => _cmpKey(_truthKey(a.m, a.it), _truthKey(b.m, b.it)))
      .reduce((acc, x, i) => { acc.set(x.it, i); return acc; }, new Map());
    let inv = 0, pairs = 0;
    // Sample adjacent-window pairs to keep it O(n·k) not O(n^2).
    for (let i = 0; i < ordered.length; i++) {
      for (let j = i + 1; j < Math.min(i + 12, ordered.length); j++) {
        pairs++;
        if (gtRank.get(ordered[i].it) > gtRank.get(ordered[j].it)) inv++;
      }
    }

    // --- bridge simulation: in-block drags that leak into another block ---
    const blockItems = new Map();
    for (const { it, m } of matched) {
      if (!blockItems.has(m.block)) blockItems.set(m.block, []);
      blockItems.get(m.block).push(it);
    }
    let drags = 0, bridged = 0;
    const idxOf = new Map(seg.map((it, i) => [it, it.index]));
    const bigBlocks = [...blockItems.values()].filter(a => a.length >= 6);
    for (const arr of bigBlocks) {
      for (let k = 0; k < 8; k++) {
        const a = arr[Math.floor(rng() * arr.length)];
        const b = arr[Math.floor(rng() * arr.length)];
        if (a === b) continue;
        drags++;
        const lo = Math.min(a.index, b.index), hi = Math.max(a.index, b.index);
        // Which GT block does each selected item belong to?
        const anchorBlock = matched.find(x => x.it === a).m.block;
        let leaked = false;
        for (const { it, m } of matched) {
          if (it.index >= lo && it.index <= hi && m.block !== anchorBlock) { leaked = true; break; }
        }
        if (leaked) bridged++;
      }
    }

    return { nMatched, colOK, colTotal, pureClusters, clusterCount,
             inv, pairs, drags, bridged };
  }

  // deterministic PRNG so runs are comparable
  function _mulberry(seed) {
    let a = seed >>> 0;
    return function () {
      a |= 0; a = (a + 0x6D2B79F5) | 0;
      let t = Math.imul(a ^ (a >>> 15), 1 | a);
      t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
      return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
    };
  }

  async function _runFixture(row) {
    row.state = 'running'; _render();
    try {
      const [truth, ext] = await Promise.all([
        fetch(FX_DIR + row.truth).then(r => r.json()),
        PDF_VIEWER.extractTextItemsFromPdf(FX_DIR + row.pdf),
      ]);
      // Group extracted items by page (extractTextItemsFromPdf tags .page).
      const byPage = new Map();
      for (const it of ext) {
        const p = (it.page || 1) - 1;
        if (!byPage.has(p)) byPage.set(p, []);
        byPage.get(p).push(it);
      }
      const rng = _mulberry(0x1234 + row.name.length);
      const agg = { nMatched: 0, colOK: 0, colTotal: 0, pureClusters: 0,
                    clusterCount: 0, inv: 0, pairs: 0, drags: 0, bridged: 0 };
      truth.pages.forEach((tp, pi) => {
        tp._pw = truth.page_w; tp._ph = truth.page_h;
        const items = byPage.get(pi) || [];
        const s = _scorePage(items, tp, rng);
        for (const k in agg) agg[k] += s[k];
      });
      row.result = agg;
      row.state = 'done';
    } catch (e) {
      row.state = 'error'; row.note = e.message || String(e);
    }
    _render();
  }

  function _pct(n, d) { return d ? Math.round(100 * n / d) : 0; }
  function _color(p, good) { return p >= good ? '#065f46' : p >= good - 25 ? '#92400e' : '#991b1b'; }

  function _render() {
    const done = _rows.filter(r => r.state === 'done');
    const T = done.reduce((a, r) => {
      for (const k in r.result) a[k] = (a[k] || 0) + r.result[k];
      return a;
    }, {});
    const bridgePct = _pct(T.bridged, T.drags);
    $('la-totals').innerHTML = done.length
      ? `<b>${done.length}</b> fixtures · column acc <b>${_pct(T.colOK, T.colTotal)}%</b> · ` +
        `block purity <b>${_pct(T.pureClusters, T.clusterCount)}%</b> · ` +
        `order violations <b>${_pct(T.inv, T.pairs)}%</b> · ` +
        `<b style="color:${_color(100 - bridgePct, 90)}">bridge rate ${bridgePct}%</b>` +
        `<span style="color:#6b7280;font-size:11px;"> (${T.bridged}/${T.drags} in-block drags leaked)</span>`
      : '';
    $('la-table').innerHTML = `
      <table style="width:100%;border-collapse:collapse;font-size:12px;">
        <thead><tr style="background:#f9fafb;text-align:left;color:#6b7280;">
          <th style="padding:6px 8px;">Fixture</th>
          <th style="padding:6px 8px;">Col acc</th>
          <th style="padding:6px 8px;">Block purity</th>
          <th style="padding:6px 8px;">Order viol</th>
          <th style="padding:6px 8px;">Bridge rate</th>
        </tr></thead>
        <tbody>${_rows.map(r => {
          if (r.state === 'pending') return `<tr><td style="padding:5px 8px;">${_esc(r.name)}</td><td colspan="4" style="padding:5px 8px;color:#9ca3af;">queued…</td></tr>`;
          if (r.state === 'running') return `<tr><td style="padding:5px 8px;">${_esc(r.name)}</td><td colspan="4" style="padding:5px 8px;color:#1e40af;">running…</td></tr>`;
          if (r.state === 'error') return `<tr><td style="padding:5px 8px;color:#9ca3af;">${_esc(r.name)}</td><td colspan="4" style="padding:5px 8px;color:#991b1b;">${_esc(r.note)}</td></tr>`;
          const s = r.result;
          const ca = _pct(s.colOK, s.colTotal), bp = _pct(s.pureClusters, s.clusterCount);
          const ov = _pct(s.inv, s.pairs), br = _pct(s.bridged, s.drags);
          const base = _baseline && _baseline[r.name];
          const d = (cur, key) => base ? ` <span style="font-size:10px;color:${cur - base[key] >= 0 ? '#065f46' : '#991b1b'};">(${cur - base[key] >= 0 ? '+' : ''}${cur - base[key]})</span>` : '';
          return `<tr style="border-top:1px solid #f3f4f6;">
            <td style="padding:5px 8px;">${_esc(r.name)}</td>
            <td style="padding:5px 8px;color:${_color(ca, 90)};font-weight:600;">${ca}%${d(ca, 'colAcc')}</td>
            <td style="padding:5px 8px;color:${_color(bp, 80)};">${bp}%${d(bp, 'blockPurity')}</td>
            <td style="padding:5px 8px;color:${_color(100 - ov, 90)};">${ov}%${d(ov, 'orderViol')}</td>
            <td style="padding:5px 8px;color:${_color(100 - br, 90)};font-weight:600;">${br}%${base ? ` <span style="font-size:10px;color:${br - base.bridge <= 0 ? '#065f46' : '#991b1b'};">(${br - base.bridge >= 0 ? '+' : ''}${br - base.bridge})</span>` : ''}</td>
          </tr>`;
        }).join('')}</tbody>
      </table>`;
  }

  async function _runAll() {
    $('la-run').disabled = true;
    _status('Running fixtures…');
    for (const r of _rows) { r.state = 'pending'; }
    _render();
    for (let i = 0; i < _rows.length; i++) {
      _status(`Fixture ${i + 1}/${_rows.length}…`);
      await _runFixture(_rows[i]);
    }
    _status(window.PAGE_LAYOUT ? 'Done (PAGE_LAYOUT engine).' : 'Done — BASELINE run (naive y,x order; no PAGE_LAYOUT yet).');
    $('la-run').disabled = false;
  }

  function _exportJson() {
    const done = _rows.filter(r => r.state === 'done');
    if (!done.length) { _status('Run first.'); return; }
    const payload = {};
    for (const r of done) {
      const s = r.result;
      payload[r.name] = {
        colAcc: _pct(s.colOK, s.colTotal), blockPurity: _pct(s.pureClusters, s.clusterCount),
        orderViol: _pct(s.inv, s.pairs), bridge: _pct(s.bridged, s.drags),
      };
    }
    const blob = new Blob([JSON.stringify({ exported_at: new Date().toISOString(), engine: !!window.PAGE_LAYOUT, fixtures: payload }, null, 2)], { type: 'application/json' });
    const a = document.createElement('a');
    a.href = URL.createObjectURL(blob);
    a.download = `layout-audit-${new Date().toISOString().slice(0, 10)}.json`;
    a.click();
    URL.revokeObjectURL(a.href);
  }

  async function _boot() {
    let index;
    try {
      index = await fetch(FX_DIR + 'index.json').then(r => r.json());
    } catch (e) {
      _status('Could not load fixtures — run scripts/gen_layout_fixtures.py first. (' + e.message + ')');
      return;
    }
    _rows = index.fixtures.map(f => ({ name: f.name, pdf: f.pdf, truth: f.truth, state: 'idle', result: null, note: '' }));
    _render();
    $('la-run').addEventListener('click', _runAll);
    $('la-export').addEventListener('click', _exportJson);
    $('la-baseline').addEventListener('change', async () => {
      const file = $('la-baseline').files && $('la-baseline').files[0];
      if (!file) return;
      try {
        const data = JSON.parse(await file.text());
        _baseline = data.fixtures || data;
        _status(`Baseline loaded (${Object.keys(_baseline).length} fixtures) — Δ shown per column.`);
        _render();
      } catch (e) { _status('Baseline load failed: ' + (e.message || e)); }
    });
    _status(`${_rows.length} fixtures ready. ${window.PAGE_LAYOUT ? 'PAGE_LAYOUT engine detected.' : 'No PAGE_LAYOUT yet — will record the naive baseline.'}`);
  }

  document.addEventListener('DOMContentLoaded', _boot);
})();
