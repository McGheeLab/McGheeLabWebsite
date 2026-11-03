/* ==========================================================================
   13zzi · Component kinds, wires onto a structure, authors as terms
   (V3.951, Gabe's SiS Shaping, Phase F).
   • A component can be a kind of its own — Hypothesis, Verdict, Aim, Method,
     Meeting, Feedback (and yours, Settings → Component kinds): double-click
     the label left of its title to choose; none chosen is "standard". The
     kind colours the box's edge and names it, and says what it links to
     first: a Hypothesis to papers, notes and observations, a Verdict to
     figures and claims… (CKINDS.fits puts those first in every picker), and
     which relation is offered first (seeded into settings().relDefaults).
   • Kinds sit on top of structures: a wire can end on a structure inside a
     component, not only on the component. Drop it on the claim, the
     observation… and the wire records `toItem`; it is drawn to that mark,
     and the structure's hover card lists what ends there. So a Hypothesis
     stems from this observation, not from the whole meeting note.
   • Authors of the library's papers are terms of a kind of their own
     ("person", auto, with their papers), marked in the text like any term.
   ========================================================================== */
const CKINDS = {
  BASE: [
    { id: 'hypothesis', label: 'Hypothesis', color: '#9E2A62', targets: ['paper', 'note', 'observation'], rel: 'supports' },
    { id: 'verdict', label: 'Verdict', color: '#1B7A43', targets: ['figure', 'claim'], rel: 'resolves' },
    { id: 'aim', label: 'Aim', color: '#0E6F66', targets: ['hypothesis', 'question'], rel: 'needs' },
    { id: 'method', label: 'Method', color: '#2F6FB0', targets: ['run', 'protocol', 'material'], rel: 'follows' },
    { id: 'meeting', label: 'Meeting', color: '#6B4FA3', targets: ['person', 'decision', 'task'], rel: 'related' },
    { id: 'feedback', label: 'Feedback', color: '#B5761B', targets: ['claim', 'barrier', 'figure'], rel: 'comments' },
  ],
  all() { const own = (settings().ckinds || []).filter(k => k && k.id && k.label); return [...CKINDS.BASE.filter(k => !own.some(o => o.id === k.id)), ...own.map(k => Object.assign({ targets: [], rel: 'related' }, k))]; },
  get: id => CKINDS.all().find(k => k.id === id) || null,
  of: b => b && b.ckind ? CKINDS.get(b.ckind) : null,
  set(b, id) { const cur = M.block(b.id); if (!cur) return; if (id) cur.ckind = id; else delete cur.ckind; cur.modified = isoLocal(new Date()); DB.put('blocks', cur); changed(); toast(id ? (CKINDS.get(id) || {}).label + ' — it links first to ' + ((CKINDS.get(id) || {}).targets || []).join(', ') : 'A standard component'); },
  pick(b, x, y) { ctxMenu(x, y, [{ head: 'What kind of component is this?' }, { label: 'Standard', sub: 'No kind: a plain component', run: () => CKINDS.set(b, null) },
    ...CKINDS.all().map(k => ({ label: (b.ckind === k.id ? '✓ ' : '') + k.label, sub: 'Links first to ' + (k.targets.join(', ') || 'anything'), run: () => CKINDS.set(b, k.id) })), 'sep', { label: 'Kinds in Settings…', run: () => CMD.run('settings', ['Component kinds']) }]); },
  /** How well a candidate answers a kind's targets: what it is, what kind it has, what structures it carries. */
  fits(k, b) { if (!k || !b || !k.targets.length) return 0; const T = k.targets; let s = 0;
    if (T.includes(b.kind)) s += 2; if (b.ckind && T.includes(b.ckind)) s += 2; if ((b.kind === 'rmpaper' || b.kind === 'pdf') && T.includes('paper')) s += 2; if (b.kind === 'noteref' && T.includes('note')) s += 2;
    if (b.kind === 'figure' && T.includes('figure')) s += 2; if (b.kind === 'run' && T.includes('run')) s += 2; if (b.kind === 'task' && T.includes('task')) s += 2;
    try { if (IX.itemsOf(b.id).some(it => T.includes(it.kind))) s += 1; } catch (e) { } if (T.includes('person') && (b.body && b.body.marks || []).some(m => m.type === 'person')) s += 1; return s; },
  seed() { try { const rd = Object.assign({}, settings().relDefaults || {}); let n = 0; CKINDS.all().forEach(k => { if (k.rel && !rd[k.id]) { rd[k.id] = k.rel; n++; } }); if (n) saveSettings({ relDefaults: rd }); } catch (e) { } },
  settingsUI() {
    const row = k => h('div.li', h('span.pill', { style: { background: k.color, color: '#fff' } }, k.label), h('span.t', h('span.s', 'Links first to ' + (k.targets.join(', ') || 'anything') + ' · relation first: ' + ((REL[k.rel] || {}).label || k.rel || '—'))),
      CKINDS.BASE.some(b => b.id === k.id) ? null : h('button.btn.xs.ghost', { on: { click: () => { saveSettings({ ckinds: (settings().ckinds || []).filter(x => x.id !== k.id) }); App.refresh(); } } }, '×'));
    const add = async () => { const label = await askText('A kind of component', 'Its name', ''); if (!label) return; const targets = await askText(label, 'What it links to first (paper, note, figure, claim, observation, run, person…, comma-separated)', ''); const id = label.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, ''); if (!id || CKINDS.get(id)) return toast('That kind exists');
      saveSettings({ ckinds: [...(settings().ckinds || []), { id, label, color: '#' + Math.floor(Math.random() * 0x7fffff + 0x200000).toString(16).padStart(6, '0'), targets: String(targets || '').split(',').map(x => x.trim().toLowerCase()).filter(Boolean), rel: 'related' }] }); App.refresh(); };
    return h('div.ck-settings', h('div.sec'), h('div.sec-h', h('h2', 'Component kinds'), h('span.k', 'double-click the label left of a title')),
      h('p.serif.muted', { style: { marginTop: 0, fontSize: '14.5px' } }, 'A component can be a Hypothesis, a Verdict, an Aim…: double-click the small label left of its title. The kind colours its edge and says what it links to first and which relation comes first. Kinds sit on top of structures: a wire dropped on a claim or an observation inside a component ends on it.'),
      h('div.list', CKINDS.all().map(row), h('div.li', h('button.btn.sm', { on: { click: add } }, '+ Kind'))));
  },
};
/* ---------- wires that end on a structure ---------- */
const KINDX = {
  pending: null,
  /** The structure mark under a drop (the popover opens 12 px under the pointer). */
  markAt(x, y, toId) { const el = document.elementFromPoint(x, y - 12), st = el && el.closest && el.closest('.st[data-item]'), box = st && st.closest('.box[data-id]'); return st && box && box.dataset.id === toId ? st.dataset.item : null; },
  /** The mark's rect in paper coordinates, for the wire's end. */
  markRect(pane, toId, itemId) { const w = pane.paper && pane.paper.world, box = w && $(`:scope > .box[data-id="${toId}"]`, w), st = box && $(`.st[data-item="${itemId}"]`, box); if (!st) return null; const z = pane.paper.view.z || 1, b = box.getBoundingClientRect(), r = st.getBoundingClientRect(); return { x: box.offsetLeft + (r.left - b.left) / z, y: box.offsetTop + (r.top - b.top) / z, w: Math.max(8, r.width / z), h: Math.max(8, r.height / z) }; },
  endingOn: itemId => DB.where('wires', w => w.toItem === itemId),
};
/* ---------- authors as terms ---------- */
const AUTHORS = {
  key: '', t: null,
  name: a => { if (!a) return ''; if (typeof a === 'string') return a.trim(); return ([a.given, a.family].filter(Boolean).join(' ') || a.literal || a.name || '').trim(); },
  scan() {
    const lib = DB.all('library'), pid = (DB.all('projects')[0] || {}).id || null, by = new Map();
    lib.forEach(r => (r.authors || []).forEach(a => { const n = AUTHORS.name(a); if (n.length < 4 || !/\s/.test(n)) return; (by.get(n) || by.set(n, []).get(n)).push(r.id); }));
    const made = []; by.forEach((papers, name) => { let t = DB.all('terms').find(x => x.kind === 'person' && x.label.toLowerCase() === name.toLowerCase()) || DB.all('terms').find(x => x.label.toLowerCase() === name.toLowerCase());
      if (!t) { t = { id: uid('w'), projectId: pid, label: name, kind: 'person', auto: true, papers: [], importedFrom: null, created: isoLocal(new Date()) }; made.push(t); }
      if (t.kind !== 'person' || JSON.stringify(t.papers || []) !== JSON.stringify(papers)) { t.kind = 'person'; t.papers = papers; DB.put('terms', t); } });
    if (made.length) { try { IX.rebuild(); DB.all('documents').forEach(d => M.liveBlocks(d.id).forEach(b => TERMSCAN.block(b, made))); IX.rebuild(); } catch (e) { } }
    return made.length;
  },
  maybe() { const k = DB.all('library').map(r => r.id + ':' + (r.authors || []).length).join(','); if (k === AUTHORS.key) return; AUTHORS.key = k; clearTimeout(AUTHORS.t); AUTHORS.t = setTimeout(() => { try { const n = AUTHORS.scan(); if (n) { toast(plural(n, 'author') + ' joined the terms'); changed(); } } catch (e) { console.warn('[authors]', e); } }, 1500); },
};
{
  // the label left of the title: the kind, and double-click to choose it
  const bx = DocView.box; DocView.box = function (b, d, p) { const el = bx.apply(this, arguments); if (!el || !b || b.kind !== 'component') return el;
    const num = $(':scope > .bh > .num', el); if (!num) return el; const K = CKINDS.of(b); if (K) { num.textContent = K.label; el.classList.add('ck'); el.style.setProperty('--ck', K.color); }
    num.title = (K ? K.label + ' · ' : '') + 'Double-click: what kind of component this is'; num.style.cursor = 'pointer';
    num.addEventListener('dblclick', e => { e.preventDefault(); e.stopPropagation(); if (this.travel) return; CKINDS.pick(M.block(b.id) || b, e.clientX, e.clientY + 8); });
    return el; };
  // a kind's targets first, in every picker of components
  const cl = CMD.KINDS.component.list; CMD.KINDS.component.list = function (q, ctx, a) { const L = cl.apply(this, arguments), K = ctx && ctx.block && CKINDS.of(ctx.block); if (!K) return L; return L.map(x => Object.assign({}, x, { s: (x.s || 0) + CKINDS.fits(K, x.v) * 50 })).sort((u, v) => v.s - u.s); };
  // a drop on a structure: the wire ends on it
  const rp = DocView.relationPopover; DocView.relationPopover = function (from, to, x, y) { const item = KINDX.markAt(x, y, to); KINDX.pending = item ? { to, item, until: Date.now() + 120000 } : null; return rp.apply(this, arguments); };
  const wire = M.wire; M.wire = function (from, to, rel, directed) { const w = wire.apply(this, arguments); const P = KINDX.pending; if (w && P && Date.now() < P.until && (P.to === to || P.to === from)) { KINDX.pending = null; w.toItem = P.item; DB.put('wires', w); } return w; };
  // drawn to the mark
  const gm = DocView.geom; DocView.geom = function (A, B, R) { try { if (A && B && A.id && B.id) { const w = DB.all('wires').find(x => x.toItem && ((x.from === A.id && x.to === B.id) || (x.from === B.id && x.to === A.id))); if (w) { if (w.to === B.id) { const r = KINDX.markRect(this, B.id, w.toItem); if (r) B = Object.assign({}, B, r); } else { const r = KINDX.markRect(this, A.id, w.toItem); if (r) A = Object.assign({}, A, r); } } } } catch (e) { } return gm.call(this, A, B, R); };
  // the structure's hover card says what ends on it
  const ic = ED.itemCard; ED.itemCard = function (itemId) { const card = ic.apply(this, arguments); try { const W = KINDX.endingOn(itemId); if (card && W.length) { const f = $('.hc-f', card); const line = h('div.hc-s', W.length + ' ' + (W.length === 1 ? 'wire ends' : 'wires end') + ' here: ' + W.map(w => M.blockName(M.block(w.from)) + ' ' + ((REL[w.rel] || {}).label || w.rel)).join(' · ')); f ? f.before(line) : card.append(line); } } catch (e) { } return card; };
  // authors as terms: when the library changes, and once at the start; the kinds' first relation; Settings
  const ch = changed; changed = function () { const r = ch.apply(this, arguments); try { AUTHORS.maybe(); } catch (e) { } return r; };
  setTimeout(() => { try { CKINDS.seed(); AUTHORS.maybe(); } catch (e) { } }, 3000);
  setTimeout(() => { if (typeof SettingsView === 'undefined') return; const sr = SettingsView.render; SettingsView.render = function () { const out = sr.apply(this, arguments);
    try { const h2 = [...out.querySelectorAll('.sec-h h2')].find(x => x.textContent === 'Keys'), sec = h2 && h2.closest('.sec-h'); const ui = CKINDS.settingsUI(); if (sec) sec.before(ui); else out.append(ui); } catch (e) { console.warn('[kinds]', e); }
    return out; }; }, 0);
}
