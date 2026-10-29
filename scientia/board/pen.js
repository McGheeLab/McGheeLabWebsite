/* ==========================================================================
   Scientia's whiteboard: the notebook's pen (V3.941). board.html runs the
   lab's whiteboard engine unchanged (the website's whiteboard is untouched);
   this file, after it, makes the pen on Scientia's board the pen of
   Scientia's notes — Gabe: "everything else that the notebook pen has …
   needs to become the way the whiteboard functions":
   • the pen in hand is the notebook's (window.parent.INK): its colour and
     width, the highlighter's colour, the eraser, its pressure feel — chosen
     in the notebook's own ink bar at the top of the whiteboard window
     (13zzd), which calls SIS_PEN.sync(). The board's ✎ fan keeps its modes;
     its width, eraser, add-a-colour and undo act on the notebook's pen;
   • the Slim Pen's eraser end erases; ◧ fills the closed stroke tapped in
     (fill strokes just under it, `fillOf`; they go when it goes);
   • two fingers tapped = undo, three = redo (and ↶ ↷, Ctrl+Z / Ctrl+Y), by
     the board's journal (store.js);
   • the palm (13zf PALM): a touch the size of a palm, made while the pen is
     near, or close to another touch never reaches the engine.
   ========================================================================== */
(function () {
'use strict';
const ST = window.SIS_STORE, HOST = ST && ST.host;
if (!ST || ST.view || !HOST || !HOST.pen) return;   // the cell's preview, or opened on its own: nothing to drive
const W = window.parent;
const INK = () => HOST.pen.ink();
const PALM = () => W.SIS_PALM || { GAP: 70, SIZE: 90, QUIET: 600 };
const board = () => { const nb = window.NOTEBOOK_BOARD; return (nb && nb._state && nb._state.inst) || null; };
const REF = 1000;                                  // a notebook width in px = that many thousandths of the board's width
const PEN = 'sis-pen', HL = 'sis-hl', PROBE = 'sis-probe', PROBE_C = '#fffffe';

/* ─── the pen in hand: the notebook's ─── */
const cx = document.createElement('canvas').getContext('2d');
const hex = c => { if (!c || c === 'auto') return '#1d1d1b'; cx.fillStyle = '#000000'; cx.fillStyle = c; const v = String(cx.fillStyle); return /^#[0-9a-f]{6}$/i.test(v) ? v.toLowerCase() : '#1d1d1b'; };
let lastKey = '', lastInst = null;
function sync() {
  const I = INK(), b = board(); if (!I || !b) return;
  const fill = I.tool === 'fill';
  const pens = [{ id: PEN, kind: 'pen', color: hex(I.COLORS[I.color]), w: (I.WIDTHS[I.width] || 2.4) / REF }, { id: HL, kind: 'hl', color: hex(I.HL[I.hlColor] || I.HL[0]), w: .014 }];
  if (fill) pens.push({ id: PROBE, kind: 'pen', color: PROBE_C, w: .001 });   // ◧: the engine places the tap for us
  const key = JSON.stringify(pens); if (key !== lastKey || b !== lastInst) { lastKey = key; lastInst = b; b.setPens(pens); }
  if (I.tool === 'eraser') b.setTool('eraser'); else b.usePen(fill ? PROBE : I.tool === 'hl' ? HL : PEN);
}
const ready = () => { const b = board(); if (b && b !== lastInst) sync(); return b; };   // replay and back-to-live make a new engine
const boot = setInterval(() => { if (board()) { clearInterval(boot); sync(); } }, 120); setTimeout(() => clearInterval(boot), 30000);

/* ─── its pressure feel (13zf INK.curve): each sample's pressure as the engine's pressF reads it, so a stroke has the
       notebook's thinnest–thickest; pressure off = even lines. Live and saved strokes agree. ─── */
const feel = v => { const I = INK(); let m = 1; if (I && I.pressure && v > 0) { const C = I.curve; m = C.min + (C.max - C.min) * I.mapP(v); } return ((m - .4) / 1.2) || .001; };
const setP = (ev, v) => { try { Object.defineProperty(ev, 'pressure', { value: v, configurable: true }); } catch (e) { } };
function feelPen(e) {
  const list = e.getCoalescedEvents ? e.getCoalescedEvents() : null;
  if (list && list.length) { list.forEach(c => setP(c, feel(c.pressure))); try { Object.defineProperty(e, 'getCoalescedEvents', { value: () => list, configurable: true }); } catch (x) { } }
  setP(e, feel(e.pressure));
}

/* ─── undo and redo: the board's journal ─── */
const undo = () => { if (!ST.undo()) HOST.pen.toast('Nothing to undo on this board'); };
const redo = () => { if (!ST.redo()) HOST.pen.toast('Nothing to redo on this board'); };

/* ─── the palm, and two- and three-finger taps (13zm) ─── */
let penAt = -1e9;
const penNear = () => performance.now() - penAt < PALM().QUIET;
const size = e => Math.max(e.width || 0, e.height || 0, 2 * (e.radiusX || 0), 2 * (e.radiusY || 0));
const big = e => size(e) > PALM().SIZE;
const apart = P => P.every((p, i) => P.every((q, j) => j <= i || Math.hypot(p[0] - q[0], p[1] - q[1]) >= PALM().GAP));
const TOUCH = new Map(), PALMS = new Set(), DOWN = new Set();
/** the engine lets go of a touch it had: it turned out to be the palm */
function cancel(id) {
  const t = TOUCH.get(id); TOUCH.delete(id); PALMS.add(id); if (!t) return;
  const ev = new PointerEvent('pointercancel', { pointerId: id, pointerType: 'touch', bubbles: true, clientX: t.x, clientY: t.y }); ev.__sis = true;
  try { (t.el && t.el.isConnected ? t.el : document.body).dispatchEvent(ev); } catch (x) { }
}
let G = null; const TAP = 650;
const gStart = () => { const now = performance.now(); if (!G || G.done || now - G.t0 > 400) G = { t0: now, ids: new Map(), max: 0, moved: false, done: false, fired: false, live: 0, palm: false, pts: [], tpts: [] }; return G; };
const gReal = g => { const P = g.pts.length >= 2 ? g.pts : g.tpts; return !g.moved && !g.palm && !penNear() && (P.length < 2 || apart(P)); };
const gFire = (g, n) => { if (g.fired) return; g.fired = true; const a = document.activeElement; if (a && a.closest && a.closest('input,textarea,[contenteditable="true"]')) return; if (n === 2) undo(); else redo(); };
const gEnd = () => { const g = G; if (!g || g.done || g.ids.size || g.live) return; g.done = true; if (performance.now() - g.t0 <= TAP && g.max >= 2 && gReal(g)) gFire(g, g.max); };

/* ─── the Slim Pen's eraser end ─── */
const isEraser = e => e.pointerType === 'pen' && (e.button === 5 || (e.buttons & 32) === 32);
let ER = null;

addEventListener('pointerdown', e => {
  if (e.__sis) return;
  if (e.pointerType !== 'touch' || !DOWN.size) ST.step();   // each stroke its own undo step (a resting hand never joins them)
  DOWN.add(e.pointerId); ready();
  if (e.pointerType === 'pen') {
    penAt = performance.now(); [...TOUCH.keys()].forEach(cancel); feelPen(e);
    if (isEraser(e)) { const b = board(); if (b && b.getTool() !== 'eraser') { ER = { id: e.pointerId, prev: b.currentPen() }; b.setTool('eraser'); } }
    return;
  }
  if (e.pointerType !== 'touch') return;
  const g = gStart(); g.ids.set(e.pointerId, [e.clientX, e.clientY]); g.max = Math.max(g.max, g.ids.size); g.pts.push([e.clientX, e.clientY]);
  const close = [...TOUCH.values()].some(t => Math.hypot(t.x - e.clientX, t.y - e.clientY) < PALM().GAP);
  if (PALMS.size || big(e) || penNear() || close) {
    g.palm = true; if (close) [...TOUCH.keys()].forEach(cancel);
    PALMS.add(e.pointerId); e.stopImmediatePropagation(); return;
  }
  TOUCH.set(e.pointerId, { x: e.clientX, y: e.clientY, el: e.target });
}, true);
addEventListener('pointermove', e => {
  if (e.__sis) return;
  if (e.pointerType === 'pen') { penAt = performance.now(); if (TOUCH.size) [...TOUCH.keys()].forEach(cancel); feelPen(e); return; }
  if (e.pointerType !== 'touch') return;
  if (G && G.ids.has(e.pointerId)) { const [x, y] = G.ids.get(e.pointerId); if (Math.hypot(e.clientX - x, e.clientY - y) > 18) G.moved = true; }
  if (PALMS.has(e.pointerId)) { e.stopImmediatePropagation(); return; }
  const t = TOUCH.get(e.pointerId); if (t) { t.x = e.clientX; t.y = e.clientY; }
}, true);
const up = e => {
  if (e.__sis) return;
  DOWN.delete(e.pointerId);
  if (e.pointerType === 'pen') {
    penAt = performance.now(); feelPen(e);
    if (ER && ER.id === e.pointerId) { const p = ER.prev; ER = null; setTimeout(() => { const b = board(); if (!b || !p) return; if (p.tool === 'pen') b.usePen(p.id); else b.setTool(p.tool); }, 0); }
    return;
  }
  if (e.pointerType !== 'touch') return;
  if (G && G.ids.has(e.pointerId)) { G.ids.delete(e.pointerId); gEnd(); }
  TOUCH.delete(e.pointerId);
  if (PALMS.delete(e.pointerId)) e.stopImmediatePropagation();
};
addEventListener('pointerup', up, true); addEventListener('pointercancel', up, true);
// the same taps counted by fingers on the glass (some Windows touch drivers report only these fully)
addEventListener('touchstart', e => { const g = gStart(); g.live = e.touches.length; g.max = Math.max(g.max, e.touches.length);
  [...e.changedTouches].forEach(t => { if (big(t)) g.palm = true; g.tpts.push([t.clientX, t.clientY]); }); if (penNear()) g.palm = true; }, { capture: true, passive: true });
const tEnd = e => { if (!G) return; G.live = e.touches.length; gEnd(); };
addEventListener('touchend', tEnd, { capture: true, passive: true }); addEventListener('touchcancel', tEnd, { capture: true, passive: true });
// Windows makes a right-click of a two-finger tap: that is the tap
addEventListener('contextmenu', e => { const g = G; if (!g || performance.now() - g.t0 > 1500 || g.max < 2) return; if (gReal(g)) gFire(g, g.max); e.preventDefault(); e.stopImmediatePropagation(); }, true);
addEventListener('keydown', e => {
  const t = e.target; if (t && t.closest && t.closest('input,textarea,[contenteditable="true"]')) return;
  const k = (e.key || '').toLowerCase(); if (!(e.ctrlKey || e.metaKey) || (k !== 'z' && k !== 'y')) return;
  e.preventDefault(); e.stopImmediatePropagation(); if (k === 'y' || e.shiftKey) redo(); else undo();
}, true);

/* ─── the board's ✎ fan: its modes are the board's; its pen items act on the notebook's pen ─── */
addEventListener('click', e => {
  const it = e.target.closest && e.target.closest('.wb-fan-item,[data-wb-bar-undo]'); if (!it) return;
  const act = it.hasAttribute('data-wb-bar-undo') ? 'undo' : it.dataset.wbAct, b = board(), I = INK();
  const stop = () => { e.preventDefault(); e.stopImmediatePropagation(); if (b && act !== 'undo') b.openPill(null); };
  if (act === 'undo') { stop(); undo(); }
  else if (act === 'width') { stop(); HOST.pen.width(Math.max(0, [...document.querySelectorAll('.wb-fan-item[data-wb-act="width"]')].indexOf(it))); }
  else if (act === 'pen-add') { stop(); const r = it.getBoundingClientRect(); HOST.pen.add(it.dataset.kind === 'hl' ? 'hl' : 'pen', r.left, r.bottom + 6); }
  else if (act === 'eraser') { stop(); HOST.pen.tool(I && I.tool === 'eraser' ? (I.lastDraw === 'hl' ? 'hl' : 'pen') : 'eraser'); }
  else if (act === 'pen-pick') { stop(); HOST.pen.tool(it.dataset.pen === HL ? 'hl' : 'pen'); }
  else if (act === 'hand-pen' || act === 'hand-hl') setTimeout(() => HOST.pen.tool(act === 'hand-hl' ? 'hl' : 'pen'), 0);
}, true);

/* ─── ◧ fill (13zv): the smallest closed stroke around the tap is filled — solid with the pen (it replaces the fill
       there was), a translucent layer with the highlighter (layers deepen) — by fill strokes just under it ─── */
const box = P => { let x0 = 1e9, y0 = 1e9, x1 = -1e9, y1 = -1e9; for (let i = 0; i < P.length; i += 3) { x0 = Math.min(x0, P[i]); x1 = Math.max(x1, P[i]); y0 = Math.min(y0, P[i + 1]); y1 = Math.max(y1, P[i + 1]); } return { x0, y0, x1, y1 }; };
/** a stroke that closes on itself (13zv INK.closedLoop; a notebook px = 1/REF; the engine stores fewer points) */
const closedLoop = P => { const n = P.length / 3; if (n < 4) return false; let L = 0; for (let i = 3; i < P.length; i += 3) L += Math.hypot(P[i] - P[i - 3], P[i + 1] - P[i - 2]);
  const b = box(P), diag = Math.hypot(b.x1 - b.x0, b.y1 - b.y0); return diag > 14 / REF && Math.hypot(P[P.length - 3] - P[0], P[P.length - 2] - P[1]) < Math.max(.22 * diag, 12 / REF) && L > 1.6 * diag; };
const inside = (x, y, P) => { let c = false; const n = P.length / 3; for (let i = 0, j = n - 1; i < n; j = i++) { const xi = P[3 * i], yi = P[3 * i + 1], xj = P[3 * j], yj = P[3 * j + 1]; if ((yi > y) !== (yj > y) && x < (xj - xi) * (y - yi) / (yj - yi + 1e-12) + xi) c = !c; } return c; };
const STEP = 1.2 / REF;   // scan lines a notebook 1.2 px apart, each 2.2 times that wide, so they close up into one area
/** The inside of a closed stroke as zig-zag strokes: each scan line's spans (inset by a line's half width), chained to
    the span of the next line that overlaps them, back and forth. A point just inside each end of a span keeps the
    engine's curve through the corners from swinging out past the shape. */
function scan(P) {
  const b = box(P), n = P.length / 3, chains = []; let open = [];
  const chain = () => { const c = { pts: [], last: null, dir: 1, add(s, y) { const [a, z] = c.dir > 0 ? s : [s[1], s[0]], e = Math.min(STEP, Math.abs(z - a) / 3) * Math.sign(z - a);
    if (e) c.pts.push(a, y, .5, a + e, y, .5, z - e, y, .5, z, y, .5); else c.pts.push(a, y, .5, z, y, .5); c.last = s; c.dir = -c.dir; } }; chains.push(c); return c; };
  for (let y = b.y0 + STEP / 2; y < b.y1; y += STEP) {
    const xs = [];
    for (let i = 0, j = n - 1; i < n; j = i++) { const yi = P[3 * i + 1], yj = P[3 * j + 1]; if ((yi > y) !== (yj > y)) xs.push(P[3 * i] + (y - yi) * (P[3 * j] - P[3 * i]) / (yj - yi)); }
    xs.sort((p, q) => p - q);
    const used = new Set(), next = [];
    for (let k = 0; k + 1 < xs.length; k += 2) {
      let a = xs[k] + STEP, z = xs[k + 1] - STEP; if (z < a) a = z = (xs[k] + xs[k + 1]) / 2;
      const c = open.find(o => !used.has(o) && a <= o.last[1] + STEP && o.last[0] - STEP <= z && o.pts.length < 2600) || chain();
      used.add(c); c.add([a, z], y); next.push(c);
    }
    open = next;
  }
  return chains.map(c => c.pts.map(v => Math.round(v * 1e5) / 1e5));
}
function fillAt(probe) {
  const P = probe.pts || [], pb = box(P), x = P[0], y = P[1], page = probe.pageId;
  if (pb.x1 - pb.x0 > 12 / REF || pb.y1 - pb.y0 > 12 / REF) return;   // a drag, not a tap
  let best = null, area = Infinity;
  ST.list('strokes').forEach(r => { const s = r.data;
    if (s.pageId !== page || s.erasedAt || s.hiddenBy || s.fillOf || s.hl || s.color === PROBE_C || !Array.isArray(s.pts) || !closedLoop(s.pts) || !inside(x, y, s.pts)) return;
    const q = box(s.pts), a = (q.x1 - q.x0) * (q.y1 - q.y0); if (a < area) { area = a; best = r; } });
  if (!best) return HOST.pen.toast('Tap inside a closed shape to fill it');
  const f = HOST.pen.paint(), ops = [], mine = ST.list('strokes').filter(r => r.data.fillOf === best.id && !r.data.erasedAt);
  if (!f.hl) mine.forEach(r => ops.push({ op: 'del', path: r.path }));
  else { const layers = mine.filter(r => r.data.hl); if (layers.length >= 8) ops.push({ op: 'del', path: layers[0].path }); }
  const now = Date.now(), seq = (+best.data.seq || now) - .5;
  scan(best.data.pts).forEach((pts, k) => ops.push({ op: 'set', path: ST.root + '/strokes/' + ST.newId(),
    data: Object.assign({ pageId: page, seq: seq - k / 1000, color: hex(f.c), w: STEP * 2.2, pts, done: true, t0: now, t1: now, fillOf: best.id }, f.hl ? { hl: true } : {}) }));
  ST.write(ops);
}
ST.skip(c => { const d = c.after || c.before; return !!d && d.color === PROBE_C; });   // the tap's mark is no undo step
ST.onWrite((changes, replay) => {
  if (replay) return;
  const gone = [], pre = ST.root + '/strokes/';
  changes.forEach(c => {
    if (!c.path.startsWith(pre)) return;
    const a = c.after, b = c.before;
    if (a && a.color === PROBE_C) { if (a.done) Promise.resolve().then(() => { ST.write([{ op: 'del', path: c.path }]); fillAt(a); }); return; }
    if (b && !b.fillOf && (!a || (a.erasedAt && !b.erasedAt))) gone.push([c.path.slice(pre.length), a && a.erasedAt]);
  });
  if (gone.length) Promise.resolve().then(() => {   // a stroke's fill goes with it
    const ops = []; gone.forEach(([id, at]) => ST.list('strokes').forEach(r => { if (r.data.fillOf === id && !r.data.erasedAt) ops.push(at ? { op: 'update', path: r.path, data: { erasedAt: at } } : { op: 'del', path: r.path }); }));
    if (ops.length) ST.write(ops);
  });
});

window.SIS_PEN = { sync, undo, redo };
})();
