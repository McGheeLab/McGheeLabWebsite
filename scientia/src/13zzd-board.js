/* ==========================================================================
   13zzd · Whiteboards in image panels — the lab's whiteboard, ported. An
   empty image of a panel can be a whiteboard instead (✎ Whiteboard in the
   empty cell): the Lab Notebook's own board (pen, highlighter, cards,
   regions, record and replay — rm/pages/notebook-board.html and the
   whiteboard.js engine, unchanged), built into this app as board.html
   (scripts/scientia_build.py, V3.937), so it works on the desktop with no
   network and on the website alike. The cell shows the board; click it and
   it fills the window to draw on.
   cell.board = {id: 'wb…_me', title}. The board's documents (what the
   engine keeps in Firestore on the lab site) are kept in the `boards` store:
   row <id> = {docs: {path: document}, parts, title, docId}, a large board
   continuing in rows <id>~1, ~2… so each row syncs whole. board.html reads
   and writes them through window.SIS_BOARDS (board/store.js); its saves are
   not undo steps (the board has its own undo). Files it makes (images, a
   recording's minutes) are the note's media.
   V3.936 boards kept in the lab (cell.board.lab) still open there.
   V3.941 — the notebook's pen on the board: the notes' own ink bar (INK.bar
   on a pane of its own: palettes, widths, eraser, fill, pressure, ↶ ↷) under
   the whiteboard window's title; every change reaches the board, and
   board/pen.js asks the pen here for a width, a tool, a new colour.
   ========================================================================== */
const BOARD = {
  ME: 'me', ROW: 450000,
  url(bd, view) { return 'board.html?board=' + encodeURIComponent(bd.id) + '&owner=' + BOARD.ME + '&title=' + encodeURIComponent(bd.title || 'Whiteboard') + (view ? '&view=1' : '') + '&v=' + encodeURIComponent(window.SIS_BOARD_V || BUILD.slice(0, 10)); },
  /** V3.936: a board kept in the lab (userData/{uid}/notebookBoards) — shown where Scientia is signed in to it. */
  lab: { can: () => !window.SIS_DESKTOP && !!(window.__sisCloud && window.__sisCloud.user),
    url: (bd, site) => (site ? 'https://mcgheelab.com' : '') + '/rm/pages/notebook-board.html?board=' + encodeURIComponent(bd.lab) + '&owner=' + encodeURIComponent(bd.owner) + '&title=' + encodeURIComponent(bd.title || 'Whiteboard') },
  src: (bd, view) => bd.lab ? BOARD.lab.url(bd) : BOARD.url(bd, view),
  /** The board in its cell (seen, not drawn on: a click opens it). */
  preview(bd) {
    if (bd.lab && !BOARD.lab.can()) return h('div.wb-card', h('b', 'Lab whiteboard'), h('span', 'opens on mcgheelab.com ↗'));
    if (!bd.lab && !bd.id) return h('div.wb-card', 'Whiteboard');
    return h('iframe.wb-frame', { src: BOARD.src(bd, true), loading: 'lazy', tabindex: '-1', title: bd.title || 'Whiteboard', 'data-board': bd.id || bd.lab });
  },
  make(b, i) {
    const c = b && FIG.cells(b)[i]; if (!c || c.media) return;
    const id = 'wb' + Date.now().toString(36) + Math.random().toString(36).slice(2, 6) + '_' + BOARD.ME, title = (b.label || 'Image panel') + ' · ' + FIG.letter(i), now = { __ts: Date.now() };
    c.board = { id, title };
    DB.beginGroup('board');
    DB.put('boards', { id, kind: 'board', docId: b.docId, title, parts: 1, modified: isoLocal(new Date()),
      docs: { '': { name: title, pages: [{ id: 'p1', background: 'blank' }], activePageId: 'p1', ownerUid: BOARD.ME, moduleKey: '', sharedWithUids: [], createdAt: now, updatedAt: now } } });
    FIG.save(b); changed(); setTimeout(() => BOARD.open(M.block(b.id), i), 60);
  },
  /** The rows of a board, in order. */
  rows(id) { const main = DB.get('boards', id); if (!main) return []; const out = [main]; for (let k = 1; k < (main.parts || 1); k++) { const p = DB.get('boards', id + '~' + k); if (p) out.push(p); } return out; },
  used: id => DB.where('blocks', x => x.fig && (x.fig.cells || []).some(c => c && c.board && c.board.id === id)).length,
  remove(b, i) {
    const cur = M.block(b.id), c = cur && FIG.cells(cur)[i]; if (!c || !c.board) return; const id = c.board.id;
    DB.beginGroup('board'); delete c.board; FIG.save(cur);
    if (id && !BOARD.used(id)) BOARD.rows(id).forEach(r => DB.del('boards', r.id));   // another panel showing the same board keeps it
    changed(); toast('Whiteboard taken out of the panel · Ctrl+Z puts it back');
  },
  /** board.html's side (board/store.js): read the board, keep it, keep a file it makes. */
  host: {
    load(id) {
      const docs = {}; BOARD.rows(id).forEach(r => Object.assign(docs, r.docs || {}));
      const json = JSON.stringify(docs), media = {};
      for (const m of json.matchAll(/"sis-media:([A-Za-z0-9_-]+)"/g)) { const rec = MEDIA.get(m[1]); if (rec) media[m[1]] = MEDIA.url(rec); }
      const main = DB.get('boards', id);
      return JSON.stringify({ title: main && main.title, docs, media });
    },
    save(id, json) {
      const main = DB.get('boards', id); if (!main) return false;   // taken out while it was open: not brought back
      let docs; try { docs = JSON.parse(json); } catch { return false; }
      // rows of at most BOARD.ROW characters, in a steady order (the board, cards, wires, recordings, then ink by its
      // sequence and recordings' events by time), so a new stroke changes only the last row
      const rank = (k, d) => !k ? [0, 0] : k.startsWith('strokes/') ? [3, +d.seq || 0] : k.includes('/events/') ? [4, +d.t || 0] : [k.startsWith('items/') ? 1 : 2, 0];
      const keys = Object.keys(docs).map(k => [k, rank(k, docs[k] || {})]).sort((a, b) => a[1][0] - b[1][0] || a[1][1] - b[1][1] || (a[0] < b[0] ? -1 : a[0] > b[0] ? 1 : 0)).map(x => x[0]);
      const groups = [{}]; let size = 0;
      for (const k of keys) { const n = k.length + JSON.stringify(docs[k]).length + 6; if (size + n > BOARD.ROW && size) { groups.push({}); size = 0; } groups[groups.length - 1][k] = docs[k]; size += n; }
      const name = docs[''] && docs[''].name;
      DB.quiet = true;
      try {
        groups.forEach((g, n) => {
          const rid = n ? id + '~' + n : id, cur = DB.get('boards', rid), s = JSON.stringify(g);
          if (cur && BOARD._last.get(rid) === s && (n || (cur.parts === groups.length && cur.title === (name || cur.title)))) return;
          BOARD._last.set(rid, s);
          DB.put('boards', n ? { id: rid, kind: 'board-part', board: id, docs: g } : Object.assign({}, main, { title: name || main.title, parts: groups.length, docs: g, modified: isoLocal(new Date()) }));
        });
        for (let n = groups.length; n < (main.parts || 1); n++) { const rid = id + '~' + n, cur = DB.get('boards', rid); if (cur && Object.keys(cur.docs || {}).length) { BOARD._last.delete(rid); DB.put('boards', { id: rid, kind: 'board-part', board: id, docs: {} }); } }
      } finally { DB.quiet = false; }
      return true;
    },
    async media(id, buf, name, type) {
      name = String(name || 'file').replace(/\.(m4a|aac)$/i, '.mp4');   // a recording's minutes: the images folder and the lab cloud take .mp4, not .m4a
      const rec = await MEDIA.add(new File([buf], name, { type: type || 'application/octet-stream' }), { quiet: true, extra: { board: id } });
      return { id: rec.id, url: MEDIA.url(rec) };
    },
    /** V3.941 — what board/pen.js asks of the notebook's pen (its ✎ fan's width, eraser, add-a-colour; ◧'s paint) */
    pen: {
      ink: () => INK,   // the app's top-level consts are not on window
      tool: t => INK.setTool(t),
      width(k) { INK.width = clamp(k, 0, INK.WIDTHS.length - 1); _ls.set('inkWidth', INK.width); if (INK.tool === 'pen' || INK.tool === 'hl') INK.paintBars(); else INK.setTool(INK.lastDraw === 'hl' ? 'hl' : 'pen'); },
      add(k, x, y) { const f = BOARD.pen.frame, r = f ? f.getBoundingClientRect() : { left: 0, top: 0 }; FILL.editor(k, null, r.left + x, r.top + y); },
      paint: () => FILL.paint(),
      toast: m => toast(m),
    },
  },
  _last: new Map(),
  /** V3.941 — the whiteboard window's ink bar: the notes' own, minus what the board does its own way (the lasso — it has
      cards and its own selection —, the ink library, the mouse switch: the mouse draws there, hiding the bar) */
  pen: { pane: null, frame: null },
  paintPen() {
    const P = BOARD.pen; if (!P.pane || !P.pane.host.isConnected) return;
    const was = INK.shown; INK.shown = true; try { INK.bar(P.pane); } finally { INK.shown = was; }
    const el = $(':scope > .ink-bar', P.pane.host);
    if (el) {
      $$('.ib-t', el).forEach(b => { if (/^(Lasso|Draw with the mouse|Hide the ink bar)/.test(b.title)) b.remove(); });
      $$('.ink-libb', el).forEach(b => b.remove());
      $$('.ink-ur', el).forEach((b, k) => b.replaceWith(h('button.ib-t.ink-ur', { title: k ? 'Redo (three-finger tap)' : 'Undo (two-finger tap)', on: { click: () => BOARD.penDo(k ? 'redo' : 'undo') } }, k ? '↷' : '↶')));
    }
    BOARD.penDo('sync');
  },
  penDo(what) { try { const w = BOARD.pen.frame && BOARD.pen.frame.contentWindow; if (w && w.SIS_PEN) w.SIS_PEN[what](); } catch { } },
  /** The board filling the window. */
  open(b, i) {
    const c = b && FIG.cells(b)[i], bd = c && c.board; if (!bd || !(bd.id || bd.lab)) return;
    if (bd.lab && !BOARD.lab.can()) { window.open(BOARD.lab.url(bd, true), '_blank', 'noopener'); return; }
    let sure = false;
    const drop = h('button.btn.sm.ghost', { title: 'An empty image again', on: { click: () => { if (!sure) { sure = true; drop.textContent = 'Remove — sure?'; setTimeout(() => { sure = false; drop.textContent = 'Remove whiteboard'; }, 3000); return; } close(); BOARD.remove(b, i); } } }, 'Remove whiteboard');
    const fr = h('iframe.wb-full', { src: BOARD.src(bd), allow: 'microphone; fullscreen', title: bd.title || 'Whiteboard' });
    const inkRow = bd.lab ? null : h('div.wb-inkrow.nopan');   // V3.941 — the notebook's pen
    const ov = h('div.embed-max.wb-max', h('div.em-bar', h('b', bd.title || 'Whiteboard'), h('span.tiny.muted', bd.lab ? 'The lab’s whiteboard' : 'Whiteboard'), h('span.spacer'),
        bd.lab ? h('a.btn.sm', { href: BOARD.lab.url(bd), target: '_blank', rel: 'noopener' }, 'Open in a new tab ↗') : null, drop, h('button.btn.sm.pri', { on: { click: () => close() } }, 'Done')), inkRow, fr);
    const key = e => { if (e.key === 'Escape' && !$('.ovl')) { e.stopPropagation(); close(); } };
    const close = () => {
      try { fr.contentWindow && fr.contentWindow.SIS_BOARD_FLUSH && fr.contentWindow.SIS_BOARD_FLUSH(); } catch { }
      if (BOARD.pen.frame === fr) { BOARD.pen.pane = null; BOARD.pen.frame = null; }
      ov.remove(); document.removeEventListener('keydown', key, true);
      $$('iframe.wb-frame').forEach(f => { if (f.dataset.board === (bd.id || bd.lab)) f.src = BOARD.src(bd, true); });
    };
    document.body.append(ov); document.addEventListener('keydown', key, true);
    if (inkRow) { if (INK.tool === 'lasso') INK.tool = 'pen'; BOARD.pen.pane = { host: inkRow, sel: null }; BOARD.pen.frame = fr; BOARD.paintPen(); }
    return ov;
  },
};
window.SIS_BOARDS = BOARD.host;
// V3.941 — a change of pen anywhere (a colour, a width, a tool, pressure) reaches the open whiteboard
{ const pb = INK.paintBars; INK.paintBars = function () { const r = pb.apply(this, arguments); if (BOARD.pen.pane) BOARD.paintPen(); return r; }; }
