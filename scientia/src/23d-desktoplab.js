/* ==========================================================================
   23d · The lab layer on this computer. The desktop build loads the website's
   lab layer too (rm/scientia/lab-mode.js, unchanged, with window.SIS_DESKTOP
   set), so the app here is the lab's: the pills and Quick cast, Portfolio,
   Lit reviews, RM's library, materials and tasks, the one recorder… Its RM
   calls go through this computer's server to the lab hub; its recordings
   are saved in the notebook folder; RM's own pages open on the site, except
   a lab paper's Read, which opens in this app's reader beside the note
   (RMREAD, below).
   What the lab layer takes away because the website cannot have it, the
   computer keeps: the Activity and Data tabs (folder handles need the
   computer). The ✓ stays this app's own (23b), which works offline — the
   lab's asks the Lab Notebook around it, and there is none here.
   ========================================================================== */
const DESKLAB = {
  on: () => !!window.SIS_DESKTOP,
  KEEP: ['activity', 'data'],
  keep: null
};
if (DESKLAB.on()) {
  document.documentElement.classList.add('sis-desktop');
  DESKLAB.keep = { tabs: TABS.map(t => t.slice()), views: Object.fromEntries(DESKLAB.KEEP.map(id => [id, VIEWS[id]])) };
  /* called by the build right after the lab layer ran, before the first render */
  window.SIS_DESKTOP_AFTER_LAB = () => {
    try {
      for (const id of DESKLAB.KEEP) {
        if (DESKLAB.keep.views[id]) VIEWS[id] = DESKLAB.keep.views[id];
        if (TABS.some(t => t[0] === id)) continue;
        const orig = DESKLAB.keep.tabs, i = orig.findIndex(t => t[0] === id); if (i < 0) continue;
        let at = TABS.length;                                   // after the nearest tab that came before it
        for (let j = i - 1; j >= 0; j--) { const k = TABS.findIndex(t => t[0] === orig[j][0]); if (k >= 0) { at = k + 1; break; } }
        TABS.splice(at, 0, orig[i].slice());
      }
      // V3.943 — a snapped equation (13zza): the lab's reader needs the lab sign-in, which this computer has not got, so the
      // equation editor asks you to type it against the snip at once instead of trying and failing (Gabe chose this over a
      // route in the lab's hub, 2026-10-30)
      if (typeof CLIP !== 'undefined') CLIP.read = null;
      RMREAD.wire();
    } catch (e) { console.warn('[desktop lab]', e); }
  };
}

/* V3.944 — a lab paper's Read (the paper card, its highlights, the ⋯ menu, a collection, the library's page) opens in
   this app's reader beside the note, with the paper's highlights from RM. On the website the lab layer asks the Lab
   Notebook around it for RM's reader; here nothing is around it, so it opens the paper's page on the site instead.
   That ask is how a read is told from "Open in RM", which opens the same address: a read leaves a fresh 'rm-read' in
   SIS_LAB.host.sent first. The PDF comes from RM through this computer's server (api/rm-pdf) into a PDF card beside
   the paper card (or in the note on screen; with no note, the paper's reading note) and stays there: the next Read
   opens that card, and another note reuses the file. RM's highlights (api/rm/annotations, read-only) are drawn on its
   pages in RM's colours, found by their words, and listed in the reader's side panel; a highlight clicked on the card
   is where it opens. What you highlight in it is a quote in this note, as in any PDF; it does not go to RM. */
const RMREAD = {
  PAGE: /\/rm\/pages\/library-paper\.html\?id=([^&#]+)/,
  HL: { yellow: '#facc15', green: '#4ade80', red: '#f87171', blue: '#60a5fa', purple: '#a78bfa', orange: '#fb923c', pink: '#f472b6' },   // RM's (lab-mode's HL)
  TTL: 60 * 1000,
  seen: '', from: null, focus: null, ann: {}, busy: {}, open0: null,
  col: c => RMREAD.HL[c] || '#d4d4d8',
  recent: x => (x && Date.now() - x.t < 2500 ? x : null),
  lib: pid => DB.all('library').find(r => String(r.rmId || r.id) === String(pid)) || null,
  /** The lab layer's last ask of its host was a read, and nobody has taken it yet. */
  asked() {
    const s = (window.SIS_LAB && SIS_LAB.host && SIS_LAB.host.sent) || [], q = s[s.length - 1];
    if (!q || q.type !== 'rm-read' || q.id === RMREAD.seen) return false;
    RMREAD.seen = q.id; return true;
  },
  site(href, why) { if (why) toast(why + ' — opening its page on the lab site', 4000); try { RMREAD.open0.call(window, href, '_blank', 'noopener'); } catch (e) { } },
  /** The note it opens beside: the paper card's, else the one on screen (null: none). */
  pane(card) { const ps = App.panes(); return (card && ps.find(p => p.docId === card.docId)) || (ps.includes(App.pane) ? App.pane : ps[0]) || null; },
  async read(pid, href) {
    if (RMREAD.busy[pid]) return; const from = RMREAD.recent(RMREAD.from), focus = RMREAD.recent(RMREAD.focus); RMREAD.from = RMREAD.focus = null;
    if (RDOCK.phone()) return RMREAD.site(href);
    RMREAD.busy[pid] = true;
    try {
      const r = RMREAD.lib(pid), fb = from && M.block(from.id), pane = RMREAD.pane(fb && fb.status === 'live' ? fb : null), card = pane && fb && fb.docId === pane.docId ? fb : null;
      const d = pane ? M.doc(pane.docId) : r ? READER.litDoc(r) : null; if (!d) return RMREAD.site(href);
      let b = M.liveBlocks(d.id).find(x => x.kind === 'pdf' && x.rmPaper === pid), rec = b && MEDIA.get(b.media);
      if (!rec) {   // no card of it here yet (or its file is not on this computer)
        rec = DB.where('media', m => m.kind === 'pdf' && m.rmPaper === pid)[0];
        if (!rec) {
          if (r && r.rm && !r.rmPdf) return RMREAD.site(href, 'RM has no PDF of this paper yet');
          toast('Fetching the paper from RM…');
          let blob = null, err = '';
          try { const res = await fetch('api/rm-pdf?id=' + encodeURIComponent(pid), { cache: 'no-store' });
            if (res.ok && /pdf/.test(res.headers.get('Content-Type') || '')) blob = await res.blob(); else { const j = await res.json().catch(() => null); err = (j && j.error) || 'HTTP ' + res.status; } }
          catch (e) { err = String(e.message || e); }
          if (!blob) return RMREAD.site(href, 'The PDF did not come from RM (' + err + ')');
          const name = String((r && r.title) || 'Paper').replace(/[\\/:*?"<>|\s]+/g, ' ').trim().slice(0, 80) + '.pdf';
          rec = await MEDIA.add(new File([blob], name, { type: 'application/pdf' }), { extra: { rmPaper: pid } });
        }
        if (b) { b.media = rec.id; DB.put('blocks', b); changed(); }
      }
      if (!b) {
        let x = 28, y = 28;
        if (card) { x = (card.x || 0) + (card.w || 420) + 56; y = card.y || 0; }
        else if (pane && pane.paper) { const R = pane.paper.rect(), w = pane.paper.toWorld(R.left + 60, R.top + 80); x = w.x; y = w.y; }
        b = M.addBlock(d.id, card ? card.id : null, { kind: 'pdf', label: (r && r.title) || 'Paper', media: rec.id, rmPaper: pid, x: Math.round(x / 14) * 14, y: Math.round(y / 14) * 14, w: 616, h: 560, view: 'scroll', cur: 0 });
        b.body = { text: b.label, marks: [] }; DB.put('blocks', b); changed(); PDFW.words(b);
      }
      if (pane) { RDOCK.open(M.block(b.id)); if (!RDOCK.st || RDOCK.st.id !== b.id) return RMREAD.site(href, 'The reader could not open here'); }
      else { _ls.set('rdock:' + d.id, { id: b.id, side: 'left', zoom: 1 }); App.go('#/doc/' + d.id); }   // the reader comes with the note (13zzb)
      const A = await RMREAD.load(pid, true), it = focus && A.items.find(x => x.id === focus.id);
      setTimeout(() => { const st = RDOCK.st; if (st && st.id === b.id && A.items.length) st.ov.classList.add('rd-side-on'); if (it) RMREAD.goto(b.id, it); }, 500);
    } finally { delete RMREAD.busy[pid]; }
  },
  /** RM's highlights of a paper, kept a minute; a card or reader of it is drawn again when they come. */
  load(pid, force) {
    const old = RMREAD.ann[pid];
    if (old && (old.wait || (!force && Date.now() - old.at < RMREAD.TTL))) return old.wait || Promise.resolve(old);
    const wait = fetch('api/rm/annotations?paperId=' + encodeURIComponent(pid), { cache: 'no-store' }).then(r => r.json()).catch(() => null).then(j => {
      const ok = !!(j && j.ok), A = RMREAD.ann[pid] = { at: Date.now(), items: ok ? (j.items || []) : (old && old.items) || [], error: ok ? '' : (j && j.error) || 'Could not load the highlights from RM' };
      RMREAD.redraw(pid); return A; });
    RMREAD.ann[pid] = Object.assign({ at: 0, items: [], error: '' }, old, { wait }); return wait;
  },
  redraw(pid) {
    DB.where('blocks', b => b.kind === 'pdf' && b.rmPaper === pid && b.status === 'live').forEach(b => QUOTE.paintMarks(b.id));
    $$('.embed-max[data-src] .mx-side > .rm-side').forEach(x => { const b = M.block(x.closest('.embed-max').dataset.src); if (b && b.rmPaper === pid) x.remove(); });   // the panel's watcher puts the new list back
    RDOCK.count();
  },
  /** Where a highlight's words are on a drawn page: [i, j] words of RD2.words(P), or null. */
  find(ix, exact) {
    const q = RMREAD.norm(exact); if (q.length < 3) return null; const i = ix.s.indexOf(q); return i < 0 ? null : [ix.at[i], ix.at[i + q.length - 1]];
  },
  norm: s => String(s || '').toLowerCase().replace(/[^\p{L}\p{N}]+/gu, ''),
  index(P) { let s = ''; const at = []; RD2.words(P).forEach((w, i) => { const t = RMREAD.norm(w.t); for (let k = 0; k < t.length; k++) at.push(i); s += t; }); return { s, at }; },
  /** After the quotes (13zw): RM's highlights on the pages of a card or reader of an RM paper. */
  paint(srcId) {
    const src = M.block(srcId); if (!src || src.kind !== 'pdf' || !src.rmPaper) return;
    const A = RMREAD.ann[src.rmPaper]; if (!A) return void RMREAD.load(src.rmPaper);
    const items = A.items.filter(x => x.page != null && x.exact); if (!items.length) return;
    $$(`.box[data-id="${srcId}"] .q-slot, .embed-max[data-src="${srcId}"] .q-slot`).forEach(sl => {
      const mk = $(':scope > .q-marks', sl), tl = $(':scope > .textLayer', sl); if (!mk || !tl) return;
      const pg = +(sl.dataset.p || (src.cur || 0) + 1);
      if (!sl._rm || sl._rm.tl !== tl || sl._rm.items !== A.items || sl._rm.pg !== pg) {   // measured once per drawn page
        const P = { _tl: tl, getBoundingClientRect: () => tl.getBoundingClientRect() }; if (!RD2.words(P).length) return;
        const ix = RMREAD.index(P);
        sl._rm = { tl, pg, items: A.items, marks: items.filter(x => x.page === pg).flatMap(x => { const f = RMREAD.find(ix, x.exact); return f ? RD2.rects(P, f[0], f[1]).map(r => [x, r]) : []; }) };
      }
      mk.append(...sl._rm.marks.map(([x, r]) => h('div.rm-hl', { 'data-rm': x.id, title: 'RM · ' + (x.mine ? 'yours' : x.by || 'the lab') + (x.comment ? ' — ' + snippet(x.comment, 120) : ''),
        style: { '--hc': RMREAD.col(x.color), left: r[0] * 100 + '%', top: r[1] * 100 + '%', width: r[2] * 100 + '%', height: r[3] * 100 + '%' } })));
    });
  },
  /** Scroll the reader to a highlight from RM and flash it. */
  goto(srcId, x, n = 24) {
    const ov = $(`.embed-max[data-src="${srcId}"]`), src = M.block(srcId); if (!src || x.page == null) return;
    if (!ov) return n > 0 && setTimeout(() => RMREAD.goto(srcId, x, n - 1), 250);
    if (src.view === 'page' && (src.cur || 0) + 1 !== x.page) { PDFW.go(src, x.page - 1); return setTimeout(() => RMREAD.goto(srcId, x, n - 1), 700); }
    const stage = $('.pdf-stage', ov) || $('.dk-maxc', ov), top = el => el.getBoundingClientRect().top - stage.getBoundingClientRect().top + stage.scrollTop;
    const sl = $(`.pdf-slot[data-p="${x.page}"]`, ov); if (sl && stage) stage.scrollTo({ top: top(sl) - 40, behavior: 'smooth' });
    let k = 24; const flash = () => { const m = $$(`.rm-hl[data-rm="${x.id}"]`, ov); if (!m.length) return --k > 0 && setTimeout(flash, 250);
      if (stage) stage.scrollTo({ top: top(m[0]) - stage.clientHeight / 3, behavior: 'smooth' });
      m.forEach(z => { z.classList.add('flash'); setTimeout(() => z.classList.remove('flash'), 2000); }); };
    setTimeout(flash, 450);
  },
  /** The side panel's "From RM" list (below the note's own highlights). */
  section(srcId) {
    const b = M.block(srcId), A = b && RMREAD.ann[b.rmPaper], items = (A && A.items) || [], mine = items.filter(x => x.mine).length;
    const sub = !A || (A.wait && !A.at) ? 'Loading the highlights…' : A.error && !items.length ? A.error : !items.length ? 'No highlights in RM yet.'
      : plural(mine, 'highlight') + ' of yours' + (items.length - mine ? ' · ' + (items.length - mine) + ' from the lab' : '') + '. RM keeps them; what you highlight here is a quote in this note.';
    return h('div.rm-side', h('div.rd-sh', h('b', 'From RM' + (items.length ? ' · ' + items.length : '')), h('div.tiny.muted', sub)),
      items.map(x => h('div.rd-ann.rm-ann', { 'data-rm': x.id, style: { '--hc': RMREAD.col(x.color) }, on: { click: () => RMREAD.goto(srcId, x) } },
        h('div.row', { style: { gap: '6px' } }, h('span.pill', x.mine ? 'yours' : x.by || 'the lab'), h('span.spacer'), x.page != null ? h('span.mono.tiny.muted', 'p. ' + x.page) : null),
        x.exact ? h('div.serif', snippet(x.exact, 220)) : null, x.comment ? h('div.rd-note', x.comment) : null)));
  },
  panel(ov, srcId) {
    const b = M.block(srcId), side = $('.mx-side', ov); if (!b || !b.rmPaper || !side) return;
    const put = () => { if (!side.isConnected) return watch.disconnect(); if (!$(':scope > .rm-side', side)) side.append(RMREAD.section(srcId)); };
    const watch = new MutationObserver(put); watch.observe(side, { childList: true }); put();   // the panel draws itself afresh on every change
  },
  wire() {
    if (!window.SIS_LAB || RMREAD.open0) return;
    RMREAD.open0 = window.open;
    window.open = function (url) {
      const m = RMREAD.PAGE.exec(String(url || ''));
      if (m && RMREAD.asked()) { RMREAD.read(decodeURIComponent(m[1]), String(url)).catch(e => { console.warn('[rm read]', e); RMREAD.site(String(url)); }); return null; }
      return RMREAD.open0.apply(this, arguments);
    };
    // which card the Read came from, and which of its highlights (the lab layer's handlers run after these)
    document.addEventListener('click', e => { const t = e.target, box = t && t.closest && t.closest('.box[data-id]'), row = t && t.closest && t.closest('[data-ann]');
      if (box) RMREAD.from = { id: box.dataset.id, t: Date.now() }; RMREAD.focus = row ? { id: row.getAttribute('data-ann'), t: Date.now() } : null; }, true);
    if (WIDGETS.rmpaper && WIDGETS.rmpaper.menu) { const mn = WIDGETS.rmpaper.menu; WIDGETS.rmpaper.menu = function (b) {
      return (mn.apply(this, arguments) || []).map(it => it && it.label === 'Read' ? Object.assign({}, it, { sub: 'Beside the note, with your highlights from RM', run: () => { RMREAD.from = { id: b.id, t: Date.now() }; RMREAD.focus = null; return it.run(); } }) : it); }; }
    const pm = QUOTE.paintMarks; QUOTE.paintMarks = function (srcId) { const r = pm.apply(this, arguments); try { RMREAD.paint(srcId); } catch (e) { console.warn('[rm read]', e); } return r; };
    const mo = MXHL.open; MXHL.open = function (ov, srcId) { const r = mo.apply(this, arguments); try { RMREAD.panel(ov, srcId); } catch (e) { console.warn('[rm read]', e); } return r; };
    const rc = RDOCK.count; RDOCK.count = function () { const r = rc.apply(this, arguments), st = RDOCK.st, b = st && M.block(st.id), A = b && b.rmPaper && RMREAD.ann[b.rmPaper];
      if (A && A.items.length) st.hl.textContent += ' · RM ' + A.items.length; return r; };
  }
};
