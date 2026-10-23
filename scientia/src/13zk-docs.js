/* ==========================================================================
   13zk · Slides and PDFs in a note.
   Slides (+ Insert → Slides…): a PowerPoint file is turned into one picture
   per slide by PowerPoint on your computer; the component shows one slide at
   a time (‹ › or ← → to page through, its speaker notes below) or all of
   them as a grid. "Image panel…" makes an image panel from chosen slides.
   Each slide's words and notes are kept, so Search and terms find them.
   PDF (+ Insert → PDF…): pages drawn by the app (the same on the iPad), as a
   scrolling column or one page at a time; resize from the corner, maximise,
   open in a new tab, replace. Its words are kept for Search too.
   ========================================================================== */
const DOCS = {
  hover: null,
  btn: (label, title, fn, on) => h('button.btn.xs' + (on ? '.on' : ''), { title: title || '', on: { click: e => { e.stopPropagation(); fn(e); } } }, label),
  seg: (opts, cur, fn) => h('div.seg.sm', opts.map(([k, l]) => h('button' + (k === cur ? '.on' : ''), { on: { click: e => { e.stopPropagation(); fn(k); } } }, l))),
  save(b) { DB.put('blocks', b); },
  /** Redraw just this component's body (no full refresh). */
  repaint(b) { $$(`.box[data-id="${b.id}"]`).forEach(box => { const W = WIDGETS[b.kind], old = box.querySelector(':scope > .dk, :scope > .pdfw'); if (W && old) { const pane = DV(box); old.replaceWith(W.body(M.block(b.id), M.doc(b.docId), pane, !!(pane && pane.travel))); } }); if (DOCS._max && DOCS._max.id === b.id) DOCS._max.draw(); },
  /** A resize grip for width and height (like the HTML component). */
  grip(b, wrap, pane, hk = 'h') {
    const g = h('div.embed-rz', { title: 'Drag to resize' });
    g.addEventListener('pointerdown', e => { e.preventDefault(); e.stopPropagation(); const box = wrap.closest('.box'), z = (pane && pane.paper && pane.paper.view.z) || 1, x0 = e.clientX, y0 = e.clientY, w0 = box.offsetWidth, h0 = wrap.offsetHeight;
      const mv = ev => { b.w = clamp(Math.round(w0 + (ev.clientX - x0) / z), 280, 2400); b[hk] = clamp(Math.round(h0 + (ev.clientY - y0) / z), 160, 3000); box.style.width = b.w + 'px'; wrap.style.height = b[hk] + 'px'; pane && pane.drawWires && pane.drawWires(); };
      const up = () => { removeEventListener('pointermove', mv); removeEventListener('pointerup', up); b.w = Math.round(b.w / 14) * 14; DB.put('blocks', b); DB.beginGroup(); DOCS.repaint(b); };
      addEventListener('pointermove', mv); addEventListener('pointerup', up); });
    return g;
  },
  /** Full screen for a slide deck or a PDF; ← → page through, Esc closes. */
  max(b) {
    const W = WIDGETS[b.kind]; let ov;
    const draw = () => { const cur = M.block(b.id); const body = W.body(cur, M.doc(cur.docId), { maxView: true, paper: null }, false); body.classList.add('maxed'); const c = $('.dk-maxc', ov); c.replaceChildren(body); };
    const close = () => { ov.remove(); document.removeEventListener('keydown', key, true); DOCS._max = null; };
    const key = e => { if ($('.ovl')) return; if (e.key === 'Escape') { e.stopPropagation(); close(); } else if (e.key === 'ArrowRight' || e.key === 'ArrowLeft') { e.preventDefault(); e.stopPropagation(); DOCS.step(M.block(b.id), e.key === 'ArrowRight' ? 1 : -1); } };
    ov = h('div.embed-max.dk-max', h('div.em-bar', h('b', b.label || (b.deck && b.deck.name) || 'Document'), h('span.spacer'), h('button.btn.sm', { on: { click: close } }, 'Close ✕')), h('div.dk-maxc'));
    document.body.append(ov); document.addEventListener('keydown', key, true); DOCS._max = { id: b.id, draw }; draw();
  },
  step(b, d) { if (b.kind === 'deck') DECK.go(b, (b.deck.cur || 0) + d); else if (b.kind === 'pdf') PDFW.go(b, (b.cur || 0) + d); },
};

/* ---------------- slide decks ---------------- */
const DECK = {
  async insert(d, p) {
    PLATE.pickFiles(async files => {
      const f = files[0]; if (!f) return; const ext = (f.name.match(/\.([a-z0-9]+)$/i) || [])[1]; if (!/^(pptx|ppt|pptm|ppsx|odp)$/i.test(ext || '')) return toast('That is not a PowerPoint file');
      const id = uid('m'); toast('Turning the slides into pictures with PowerPoint…', 60000);
      let j; try { j = await (await fetch(`api/slides?id=${id}&ext=${ext.toLowerCase()}`, { method: 'POST', body: f, headers: { 'Content-Type': 'application/octet-stream' } })).json(); } catch { $$('#toasts > *').forEach(t => t.remove()); return toast('The app’s server isn’t running — open the app with launch.bat'); }
      $$('#toasts > *').forEach(t => t.remove());
      if (!j.ok) return modal({ title: 'Couldn’t turn the slides into pictures', body: h('p.serif', j.error || 'Unknown error'), actions: [{ label: 'OK' }] });
      const now = isoLocal(new Date()), slides = j.slides.map((s, i) => { const m = { id: uid('m'), kind: 'image', ext: 'png', name: `${f.name} · slide ${i + 1}`, mime: 'image/png', size: 0, w: s.w, h: s.h, created: now, path: s.path };
        DB.put('media', m); return { media: m.id, title: s.title || '', text: s.text || '', notes: s.notes || '' }; });
      DB.put('media', { id, kind: 'file', ext: ext.toLowerCase(), name: f.name, mime: f.type, size: f.size, created: now, path: j.file });
      const b = M.addBlock(d.id, null, { kind: 'deck', label: f.name.replace(/\.[^.]+$/, ''), x: Math.round(p.x / 14) * 14, y: Math.round(p.y / 14) * 14, w: 616, deck: { file: id, name: f.name, slides, view: 'slide', cur: 0, cols: 3 } });
      DECK.words(b); DB.put('blocks', b); IX.rebuild(); changed(); toast(plural(slides.length, 'slide') + ' added');
    }, false, '.pptx,.ppt,.pptm,.ppsx,.odp');
  },
  /** The deck's words in the component's text: Search, terms and the Markdown see them. */
  words(b) { const D = b.deck; b.body = { text: [b.label || D.name, ...D.slides.map((s, i) => `Slide ${i + 1}${s.title ? ': ' + s.title : ''}\n${s.text}${s.notes ? '\nNotes: ' + s.notes : ''}`)].join('\n\n'), marks: [] }; },
  go(b, i) { const D = b.deck; D.cur = clamp(i, 0, D.slides.length - 1); D.view = 'slide'; DOCS.save(b); DOCS.repaint(b); },
  img(s, cls) { const m = MEDIA.get(s.media); return m ? h('img' + (cls ? '.' + cls : ''), { src: MEDIA.url(m), alt: s.title || '', draggable: false, loading: 'lazy' }) : h('div.dk-miss', 'missing picture'); },
  body(b, d, pane, ro) {
    const D = b.deck || { slides: [] }, n = D.slides.length, cur = clamp(D.cur || 0, 0, Math.max(0, n - 1)), s = D.slides[cur], maxed = pane && pane.maxView;
    if (!n) return h('div.dk', h('div.tiny.muted', 'No slides.'));
    const set = (k, v) => { const B = M.block(b.id); B.deck[k] = v; DOCS.save(B); DOCS.repaint(B); };
    const bar = h('div.dk-bar', DOCS.seg([['slide', 'Slides'], ['grid', 'Grid']], D.view, v => set('view', v)),
      D.view === 'grid' ? h('select.inp.dk-cols', { title: 'Columns', on: { click: e => e.stopPropagation(), change: e => set('cols', +e.target.value) } }, [2, 3, 4, 5, 6].map(c => h('option', { value: c, selected: c === (D.cols || 3) }, c + ' across'))) : h('span.dk-count.mono', `${cur + 1} / ${n}`),
      ro ? null : DOCS.btn('Image panel…', 'Make an image panel from chosen slides', () => DECK.toPanel(M.block(b.id))),
      maxed ? null : DOCS.btn('⤢', 'Maximise', () => DOCS.max(M.block(b.id))),
      D.file && MEDIA.get(D.file) ? h('a.btn.xs', { href: MEDIA.url(MEDIA.get(D.file)), download: D.name, title: 'The original file', on: { click: e => e.stopPropagation() } }, '↓') : null);
    let main;
    if (D.view === 'grid') main = h('div.dk-grid', { style: { gridTemplateColumns: `repeat(${D.cols || 3},1fr)` } }, D.slides.map((x, i) => h('button.dk-th' + (i === cur ? '.on' : ''), { title: x.title || 'Slide ' + (i + 1), on: { click: e => { e.stopPropagation(); DECK.go(M.block(b.id), i); } } }, DECK.img(x), h('span.dk-n', i + 1))));
    else main = h('div.dk-slide', h('div.dk-stage', DECK.img(s, 'dk-img'),
        h('button.dk-nav.prev', { disabled: cur === 0, title: 'Previous (←)', on: { click: e => { e.stopPropagation(); DECK.go(M.block(b.id), cur - 1); } } }, '‹'),
        h('button.dk-nav.next', { disabled: cur === n - 1, title: 'Next (→)', on: { click: e => { e.stopPropagation(); DECK.go(M.block(b.id), cur + 1); } } }, '›')),
      s.notes ? h('details.dk-notes', { open: D.notesOpen !== false, on: { toggle: e => { const B = M.block(b.id); B.deck.notesOpen = e.target.open; DOCS.save(B); } } }, h('summary', 'Speaker notes'), h('div.serif', s.notes)) : null);
    const el = h('div.dk' + (maxed ? '.maxed' : ''), bar, main);
    el.addEventListener('mouseenter', () => { DOCS.hover = b.id; }); el.addEventListener('mouseleave', () => { if (DOCS.hover === b.id) DOCS.hover = null; });
    return el;
  },
  toPanel(b) {
    const D = b.deck, on = new Set([D.cur || 0]);
    const grid = h('div.dk-pick', D.slides.map((s, i) => { const lab = h('label.dk-pk' + (on.has(i) ? '.on' : ''), h('input', { type: 'checkbox', checked: on.has(i), on: { change: e => { e.target.checked ? on.add(i) : on.delete(i); lab.classList.toggle('on', e.target.checked); } } }), DECK.img(s), h('span.dk-n', i + 1)); return lab; }));
    modal({ title: 'An image panel from these slides', wide: true, body: h('div', h('div.row', { style: { gap: '6px', marginBottom: '8px' } }, h('span.tiny.muted', 'Tick the slides to put in the panel.'), h('span.spacer'), DOCS.btn('All', '', () => { D.slides.forEach((_, i) => on.add(i)); $$('.dk-pk', grid).forEach((l, i) => { l.classList.add('on'); $('input', l).checked = true; }); }), DOCS.btn('None', '', () => { on.clear(); $$('.dk-pk', grid).forEach(l => { l.classList.remove('on'); $('input', l).checked = false; }); })), grid),
      actions: [{ label: 'Cancel' }, { label: 'Make the image panel', pri: true, run: () => { const ids = [...on].sort((a, c) => a - c); if (!ids.length) { toast('Tick at least one slide'); return false; }
        const cols = Math.min(ids.length, ids.length <= 4 ? ids.length : 3), rows = Math.ceil(ids.length / cols), d = M.doc(b.docId);
        const F = FIG.create(d, { x: (b.x || 0) + (b.w || 616) + 56, y: b.y || 0 }, rows, cols), cells = FIG.cells(F);
        ids.forEach((si, k) => { cells[k].media = D.slides[si].media; cells[k].caption = D.slides[si].title || 'Slide ' + (si + 1); });
        F.label = (b.label || 'Slides') + ' · slides ' + ids.map(i => i + 1).join(', '); FIG.save(F); M.wire(F.id, b.id, 'c:from the slides', true); changed(); toast('Image panel made beside the deck'); } }] });
  },
};
WIDGETS.deck = { label: 'slides', w: 616, body: DECK.body, menu: b => [{ label: 'Maximise', run: () => DOCS.max(b) }, { label: 'Make an image panel from slides…', run: () => DECK.toPanel(b) }, { label: b.deck.view === 'grid' ? 'Show one slide at a time' : 'Show as a grid', run: () => { b.deck.view = b.deck.view === 'grid' ? 'slide' : 'grid'; DOCS.save(b); DOCS.repaint(b); } }] };
INSERTS.push({ id: 'deck', group: 'Widgets', icon: '▭', label: 'Slides (PowerPoint)…', sub: 'Each slide as a picture, ← → to page through, as a grid or an image panel; words and notes searchable', run: (d, p) => DECK.insert(d, p) });

/* ---------------- PDFs ---------------- */
const PDFW = {
  docs: new Map(),
  load(m) { READER.init(); if (!window.pdfjsLib) return Promise.reject(new Error('PDF support is missing')); if (!PDFW.docs.has(m.id)) PDFW.docs.set(m.id, pdfjsLib.getDocument({ url: MEDIA.url(m), isEvalSupported: false }).promise); return PDFW.docs.get(m.id); },
  async insert(d, p) {
    PLATE.pickFiles(async files => {
      const f = files[0]; if (!f) return; toast('Adding ' + f.name + '…'); const rec = await MEDIA.add(f); if (rec.kind !== 'pdf') return toast('That is not a PDF');
      const b = M.addBlock(d.id, null, { kind: 'pdf', label: f.name.replace(/\.pdf$/i, ''), media: rec.id, x: Math.round(p.x / 14) * 14, y: Math.round(p.y / 14) * 14, w: 616, h: 560, view: 'scroll', cur: 0 });
      b.body = { text: b.label, marks: [] }; DB.put('blocks', b); changed(); PDFW.words(b);
    }, false, '.pdf,application/pdf');
  },
  /** Its words into the component's text, for Search and terms. */
  async words(b) { try { const pdf = await PDFW.load(MEDIA.get(b.media)), parts = []; let len = 0;
      for (let i = 1; i <= pdf.numPages && len < 200000; i++) { const tc = await (await pdf.getPage(i)).getTextContent(); const t = tc.items.map(x => x.str).join(' ').replace(/\s+/g, ' ').trim(); parts.push(`Page ${i}\n${t}`); len += t.length; }
      const cur = M.block(b.id); if (!cur) return; cur.pages = pdf.numPages; cur.body = { text: [cur.label, ...parts].join('\n\n'), marks: [] }; DB.put('blocks', cur); IX.rebuild(); DOCS.repaint(cur); } catch { } },
  go(b, i) { b.cur = clamp(i, 0, Math.max(0, (b.pages || 1) - 1)); DOCS.save(b); DOCS.repaint(b); },
  async page(m, n, canvas, width) { const pdf = await PDFW.load(m), pg = await pdf.getPage(n), v0 = pg.getViewport({ scale: 1 }), dpr = Math.min(2.5, window.devicePixelRatio || 1), sc = width / v0.width, vp = pg.getViewport({ scale: sc * dpr });
    canvas.width = Math.round(vp.width); canvas.height = Math.round(vp.height); canvas.style.width = width + 'px'; canvas.style.height = Math.round(v0.height * sc) + 'px';
    await pg.render({ canvasContext: canvas.getContext('2d'), viewport: vp }).promise; return pdf.numPages; },
  body(b, d, pane, ro) {
    const m = MEDIA.get(b.media); if (!m) return h('div.pdfw', h('div.embed-missing', 'The PDF is missing.'));
    const maxed = pane && pane.maxView, n = b.pages || 0, cur = clamp(b.cur || 0, 0, Math.max(0, n - 1));
    const set = (k, v) => { const B = M.block(b.id); B[k] = v; DOCS.save(B); DOCS.repaint(B); };
    const count = h('span.dk-count.mono', n ? (b.view === 'page' ? `${cur + 1} / ${n}` : plural(n, 'page')) : '…');
    const bar = h('div.dk-bar.pdf-bar', DOCS.seg([['scroll', 'Pages'], ['page', 'One at a time']], b.view || 'scroll', v => set('view', v)), count,
      maxed ? null : DOCS.btn('⤢', 'Maximise', () => DOCS.max(M.block(b.id))),
      h('a.btn.xs', { href: MEDIA.url(m), target: '_blank', rel: 'noopener', title: 'Open in a new tab', on: { click: e => e.stopPropagation() } }, '↗'),
      ro || maxed ? null : DOCS.btn('Replace', 'Replace the file', () => PLATE.pickFiles(async fs => { const r = await MEDIA.add(fs[0]); if (r.kind !== 'pdf') return toast('That is not a PDF'); const B = M.block(b.id); B.media = r.id; B.pages = 0; B.cur = 0; DOCS.save(B); DOCS.repaint(B); PDFW.words(B); }, false, '.pdf')));
    const stage = h('div.pdf-stage.scrolly.nopan' + (b.view === 'page' ? '.one' : ''), { style: maxed ? {} : { height: (b.h || 560) + 'px' } });
    const el = h('div.pdfw' + (maxed ? '.maxed' : ''), bar, stage);
    if (!maxed && !ro) el.append(DOCS.grip(b, stage, pane));
    el.addEventListener('mouseenter', () => { DOCS.hover = b.id; }); el.addEventListener('mouseleave', () => { if (DOCS.hover === b.id) DOCS.hover = null; });
    requestAnimationFrame(async () => {
      const W = Math.max(200, (stage.clientWidth || (b.w || 616) - 24) - 16);
      try {
        const pdf = await PDFW.load(m); if (!b.pages || b.pages !== pdf.numPages) { const B = M.block(b.id); B.pages = pdf.numPages; DOCS.save(B); count.textContent = b.view === 'page' ? `${cur + 1} / ${pdf.numPages}` : plural(pdf.numPages, 'page'); if (!/Page 1\n/.test(B.body.text || '')) PDFW.words(B); }
        if (b.view === 'page') {
          const H = (stage.clientHeight || 500) - 12, pg = await pdf.getPage(cur + 1), v0 = pg.getViewport({ scale: 1 }), w = Math.min(W, H * v0.width / v0.height), cv = h('canvas.pdf-page');
          stage.replaceChildren(h('div.dk-stage.pdf-one', cv, h('button.dk-nav.prev', { disabled: cur === 0, on: { click: e => { e.stopPropagation(); PDFW.go(M.block(b.id), cur - 1); } } }, '‹'), h('button.dk-nav.next', { disabled: cur >= pdf.numPages - 1, on: { click: e => { e.stopPropagation(); PDFW.go(M.block(b.id), cur + 1); } } }, '›')));
          await PDFW.page(m, cur + 1, cv, Math.floor(w));
        } else {
          const slots = []; for (let i = 1; i <= pdf.numPages; i++) { const pg = await pdf.getPage(i), v0 = pg.getViewport({ scale: 1 }), cv = h('canvas.pdf-page', { style: { width: W + 'px', height: Math.round(W * v0.height / v0.width) + 'px' } }); slots.push(h('div.pdf-slot', { 'data-p': i }, cv, h('span.pdf-pn', i))); }
          stage.replaceChildren(...slots);
          const io = new IntersectionObserver(ents => ents.forEach(en => { if (!en.isIntersecting) return; const sl = en.target; io.unobserve(sl); PDFW.page(m, +sl.dataset.p, $('canvas', sl), W).catch(() => { }); }), { root: stage, rootMargin: '400px' });
          slots.forEach(s => io.observe(s));
          stage.addEventListener('scroll', debounce(() => { const top = stage.scrollTop, k = slots.findIndex(s => s.offsetTop + s.offsetHeight > top + 20); if (k >= 0) { const B = M.block(b.id); if (B.cur !== k) { B.cur = k; DOCS.save(B); } } }, 300));
          if (cur) requestAnimationFrame(() => { const s = slots[cur]; if (s) stage.scrollTop = s.offsetTop - 4; });
        }
      } catch (e) { stage.replaceChildren(h('div.embed-missing', 'Could not open the PDF: ' + (e.message || e))); }
    });
    return el;
  },
};
WIDGETS.pdf = { label: 'pdf', w: 616, body: PDFW.body, menu: b => [{ label: 'Maximise', run: () => DOCS.max(b) }, { label: b.view === 'page' ? 'Show all pages' : 'One page at a time', run: () => { b.view = b.view === 'page' ? 'scroll' : 'page'; DOCS.save(b); DOCS.repaint(b); } }] };
INSERTS.push({ id: 'pdf', group: 'Widgets', icon: '▤', label: 'PDF…', sub: 'Its pages drawn here — scroll or one at a time, resize, maximise, open in a new tab; words searchable', run: (d, p) => PDFW.insert(d, p) });

{
  SLIM.BARS.deck = '.dk-bar'; SLIM.BARS.pdf = '.pdf-bar';
  // ← → page through the slide deck or PDF under the mouse (or selected), when not typing
  document.addEventListener('keydown', e => {
    if (DOCS._max || (e.key !== 'ArrowLeft' && e.key !== 'ArrowRight') || e.ctrlKey || e.metaKey || e.altKey || $('.ovl') || (e.target.closest && e.target.closest('input,textarea,select,[contenteditable="true"]'))) return;
    const pane = App.pane && App.panes().includes(App.pane) ? App.pane : DocView, sel = pane && pane.sel && M.block(pane.sel), b = DOCS.hover ? M.block(DOCS.hover) : (sel && (sel.kind === 'deck' || sel.kind === 'pdf') ? sel : null);
    if (!b) return; e.preventDefault(); e.stopPropagation(); DOCS.step(b, e.key === 'ArrowRight' ? 1 : -1);
  }, true);
}
