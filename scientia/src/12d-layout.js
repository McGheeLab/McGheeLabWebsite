/* ==========================================================================
   12d · Tidy, by links (V3.948, Gabe's SiS Shaping, Phase C).
   Tidy lays a note out around its connections: components that are wired
   together form a group; in a group the origin (the earliest among those
   with the most outgoing relations) sits at the top, and each component
   goes one row below the one it follows from (the longest path from the
   origin), rows ordered so the wires cross as little as they can
   (barycenter sweeps); neighbours in a row sit far enough apart to read
   the arrow and its label; components with no connections flow in columns
   on the right. A region is laid out as a group of its own and placed as
   one piece. Groups are packed into the smallest box, so Fit gives the
   highest zoom. The move is one undo step, animated. Ordered notes
   (protocols) keep their order; "Flow in order" is the old tidy.
   ========================================================================== */
const LAYOUT = {
  GAPX: 56, GAPY: 42, LABEL: 7, ROWLAB: 24, PAD: 28,
  /** The connected groups of a note's live components (ink floats; a folded region is one piece), with their wires. */
  graph(pane, d) {
    const live = M.liveBlocks(d.id).filter(b => b.kind !== 'ink' && b.x != null), regions = REGION.list(d);
    const inRegion = {}; regions.forEach(r => REGION.blocksOf(r, d).forEach(id => { if (!inRegion[id]) inRegion[id] = r.id; }));
    const ids = new Set(live.map(b => b.id)), W = DB.where('wires', w => ids.has(w.from) && ids.has(w.to) && w.from !== w.to);
    const node = {}; live.forEach(b => { const r = pane.rectOf(b.id); node[b.id] = { id: b.id, b, w: (r && r.w) || b.w || 392, h: (r && r.h) || pane.boxH(b.id), out: [], in: [], und: [], region: inRegion[b.id] || null }; });
    W.forEach(w => { const rel = REL[w.rel] || {}; const dir = w.directed != null ? !!w.directed : rel.dir !== false; if (dir) { node[w.from].out.push({ to: w.to, rel: w.rel }); node[w.to].in.push({ from: w.from, rel: w.rel }); } else { node[w.from].und.push(w.to); node[w.to].und.push(w.from); } });
    return { node, regions, live };
  },
  /** Layer, order and place one set of nodes; returns {w, h} and sets n.px, n.py relative to the group's top left. */
  pack(nodes, edgesOf) {
    const byId = Object.fromEntries(nodes.map(n => [n.id, n])), E = edgesOf(byId);   // E: [{from, to, rel}] directed within these nodes
    // longest path from the sources (back edges of a cycle are dropped: the later one loses)
    const outs = {}; nodes.forEach(n => { outs[n.id] = []; }); E.forEach(e => outs[e.from].push(e));
    const ind = {}; nodes.forEach(n => { ind[n.id] = 0; }); E.forEach(e => { ind[e.to]++; });
    const order = [], seen = new Set(), stack = []; const visit = id => { if (seen.has(id)) return; seen.add(id); stack.push(id); outs[id].forEach(e => { if (stack.includes(e.to)) { e.back = true; return; } visit(e.to); }); stack.pop(); order.push(id); };
    const origin = nodes.slice().sort((a, b) => outs[b.id].length - outs[a.id].length || String(a.b.created || '').localeCompare(String(b.b.created || '')))[0];
    visit(origin.id); nodes.forEach(n => visit(n.id));
    const layer = {}; nodes.forEach(n => { layer[n.id] = 0; }); order.reverse().forEach(id => outs[id].forEach(e => { if (!e.back) layer[e.to] = Math.max(layer[e.to], layer[id] + 1); }));
    const rows = []; nodes.forEach(n => { (rows[layer[n.id]] = rows[layer[n.id]] || []).push(n); });
    // crossings: barycenter sweeps, down then up, twice
    const pos = {}; rows.forEach(r => r.forEach((n, i) => { pos[n.id] = i; }));
    const bary = (n, up) => { const L = up ? E.filter(e => e.from === n.id && !e.back).map(e => e.to) : E.filter(e => e.to === n.id && !e.back).map(e => e.from); return L.length ? L.reduce((s, id) => s + pos[id], 0) / L.length : pos[n.id]; };
    for (let k = 0; k < 4; k++) { const up = k % 2 === 1; const idx = up ? [...rows.keys()].reverse() : [...rows.keys()]; idx.forEach(i => { rows[i].sort((a, b) => bary(a, up) - bary(b, up) || pos[a.id] - pos[b.id]); rows[i].forEach((n, j) => { pos[n.id] = j; }); }); }
    // places: each row centred on the widest; neighbours apart by the arrow and its label
    const gapBetween = (a, b) => { const labs = E.filter(e => (e.from === a.id && e.to === b.id) || (e.from === b.id && e.to === a.id)).map(e => (REL[e.rel] || { label: e.rel }).label || ''); return LAYOUT.GAPX + Math.max(0, ...labs.map(l => String(l).length * LAYOUT.LABEL)); };
    const rowW = rows.map(r => r.reduce((s, n, i) => s + n.w + (i ? gapBetween(r[i - 1], n) : 0), 0)), W = Math.max(...rowW);
    let y = 0; rows.forEach((r, i) => { const rh = Math.max(...r.map(n => n.h)); let x = Math.round((W - rowW[i]) / 2); r.forEach((n, j) => { if (j) x += gapBetween(r[j - 1], n); n.px = x; n.py = y; x += n.w; }); y += rh + LAYOUT.GAPY + (i < rows.length - 1 ? LAYOUT.ROWLAB : 0); });
    return { w: W, h: y - LAYOUT.GAPY };
  },
  /** Shelves: pieces by height, widest first on each shelf, the loose ones in columns after. */
  shelve(pieces, targetW) {
    pieces.sort((a, b) => b.h - a.h || b.w - a.w); const shelves = []; let cur = null;
    pieces.forEach(p => { if (!cur || cur.w + LAYOUT.GAPX + p.w > targetW) { cur = { items: [], w: 0, h: 0 }; shelves.push(cur); } if (cur.items.length) cur.w += LAYOUT.GAPX; p.sx = cur.w; cur.items.push(p); cur.w += p.w; cur.h = Math.max(cur.h, p.h); });
    let y = 0; shelves.forEach(s => { s.items.forEach(p => { p.gx = p.sx; p.gy = y; }); y += s.h + LAYOUT.GAPY; });
    return { w: Math.max(0, ...shelves.map(s => s.w)), h: Math.max(0, y - LAYOUT.GAPY) };
  },
  tidy(pane) {
    const d = M.doc(pane.docId); if (!d || pane.travel) return; if (prof(d.type).ordered) return LAYOUT.flow(pane);
    const G = LAYOUT.graph(pane, d), N = Object.values(G.node); if (!N.length) return;
    const head = pane.rectOf('_head'), top = head ? head.y + head.h + LAYOUT.GAPY : 0, left = head ? head.x : 0;
    // pieces: each unfolded region's members as one piece, then the connected groups of the rest, then the loose ones
    const used = new Set(), pieces = [];
    G.regions.filter(r => !r.collapsed).forEach(r => { const mem = REGION.blocksOf(r, d).map(id => G.node[id]).filter(n => n && !used.has(n.id)); if (!mem.length) return; mem.forEach(n => used.add(n.id));
      const sz = LAYOUT.pack(mem, by => mem.flatMap(n => n.out.filter(e => by[e.to]).map(e => ({ from: n.id, to: e.to, rel: e.rel })))); pieces.push({ nodes: mem, w: sz.w + 2 * REGION.PAD, h: sz.h + 2 * REGION.PAD + 34, pad: REGION.PAD, padTop: REGION.PAD + 34, region: r }); });
    const rest = N.filter(n => !used.has(n.id)), comp = {}; let k = 0;
    rest.forEach(n => { if (comp[n.id] != null) return; const q = [n]; comp[n.id] = k; while (q.length) { const x = q.pop(); [...x.out.map(e => e.to), ...x.in.map(e => e.from), ...x.und].forEach(id => { if (comp[id] == null && G.node[id] && !used.has(id)) { comp[id] = k; q.push(G.node[id]); } }); } k++; });
    const groups = []; rest.forEach(n => { (groups[comp[n.id]] = groups[comp[n.id]] || []).push(n); });
    const loose = []; groups.forEach(g => { if (g.length === 1) return loose.push(g[0]); const sz = LAYOUT.pack(g, by => g.flatMap(n => n.out.filter(e => by[e.to]).map(e => ({ from: n.id, to: e.to, rel: e.rel })))); pieces.push({ nodes: g, w: sz.w, h: sz.h, pad: 0, padTop: 0 }); });
    const targetW = Math.max(1100, ...pieces.map(p => p.w)), packed = LAYOUT.shelve(pieces, targetW);
    // the loose ones: columns to the right of the packed groups (or below them when there is nothing packed)
    const cols = loose.length ? Math.max(1, Math.min(3, Math.ceil(loose.length / 6))) : 0, colW = Math.max(0, ...loose.map(n => n.w)); let lx = pieces.length ? packed.w + LAYOUT.GAPX * 1.5 : 0, ly = 0;
    loose.sort((a, b) => d.blockIds.indexOf(a.id) - d.blockIds.indexOf(b.id)); const colH = []; loose.forEach((n, i) => { const c = i % cols; colH[c] = colH[c] || 0; n.gx = lx + c * (colW + LAYOUT.GAPX); n.gy = ly + colH[c]; colH[c] += n.h + LAYOUT.GAPY; n.px = 0; n.py = 0; });
    // apply: one undo step, animated
    const snap = v => Math.round(v / 14) * 14; DB.beginGroup('tidy');
    const put = (n, x, y) => { const b = M.block(n.id); if (!b) return; b.x = snap(left + x); b.y = snap(top + y); DB.put('blocks', b); };
    pieces.forEach(p => p.nodes.forEach(n => put(n, p.gx + p.pad + n.px, p.gy + p.padTop + n.py)));
    loose.forEach(n => put(n, n.gx, n.gy));
    G.regions.filter(r => r.collapsed).forEach(r => { r.at = { x: snap(left), y: snap(top + packed.h + LAYOUT.GAPY) }; });
    const host = pane.paper && pane.paper.world; if (host) { host.classList.add('tidying'); setTimeout(() => host.classList.remove('tidying'), 320); }
    REGION.tidy(d); d.layout.head = { x: 0, y: 0 }; d.layout.synth = null; DB.put('documents', d); changed();
    setTimeout(() => pane.paper.fit(pane.bbox()), 90);
    toast('Tidied by links · ' + plural(pieces.length, 'group') + (loose.length ? ' · ' + plural(loose.length, 'loose component') : '') + ' · Ctrl+Z undoes');
  },
};
{
  // Tidy is by links; the old re-flow stays as "Flow in order"
  const flow = DocView.tidy; LAYOUT.flow = pane => flow.call(pane); DocView.tidy = function () { return LAYOUT.tidy(this); }; DocView.tidyFlow = function () { return flow.call(this); };
  const dm = DocView.docMenu; if (dm) DocView.docMenu = function (d, e) { const cm = ctxMenu; let done = false; const self = this; window.ctxMenu = function (x, y, items) { if (!done) { done = true; const i = items.findIndex(it => it && it.label === 'Tidy layout'); if (i >= 0) { items[i] = { label: 'Tidy layout', sub: 'By links: chains from their origin, no crossings where there need be none, packed to fit', run: () => self.tidy() }; items.splice(i + 1, 0, { label: 'Flow in order', sub: 'The old tidy: the boxes in order, two columns', run: () => self.tidyFlow() }); } } return cm.apply(this, arguments); }; try { return dm.apply(this, arguments); } finally { window.ctxMenu = cm; } };
}
