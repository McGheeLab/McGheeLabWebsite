/* ================================================================
   canvas-paper-reader.js — V3.856 — 📖 Paper cards with a full reader, coloured
   nodes and typed connections, and 📑 Collection / Claim cards. One module for
   every canvas host (the lab notebook and a paper's figure board).
   ================================================================
   A paper from the library is a CARD: its highlights and snipped figures are
   rows, each ending in a coloured NODE the engine treats as a port. 📖 Read
   opens the paper full screen over the canvas — the paper reader's own stack
   (PDF_VIEWER · GEOM_SELECTION · ANNOTATION_OVERLAY) with a collapsible side
   window holding the highlight / snip tools and the live list. A wire from a
   node carries a TYPE from the reader's vocabulary (supports · refutes ·
   informs · method · question · quote); one node may have several wires of
   different types to different cards. A wire that lands on a Collection adds
   that highlight / figure / card to its list; a Collection can be a CLAIM of a
   paper draft, and then every supports / refutes wire is evidence in the paper
   writer's claims system (claims.js).

   Public API (window.CANVAS_PAPER_READER):
     registerKinds({ hostKind, group, getInst, toast, draftId, draftTitle, mirror })
     V3.859: asCollection(it) · adopt(it) · addQuoteCard(spec, at) · addLitReview(spec, at) · onItemsChanged() ·
             onRemoveItem(item) · toHtml(it) · mirrorSubline(mirrorDoc) · linkSourceToDraft(mirrorDoc, draftId, title)
     openReader(item, api, { focus })   closeReader()
     wireMenu(id, wire, event)          — the ⋯ for a wire that leaves a node
     onWireAdded(id, w) / onWireUpdated(id, w, before) / onWireRemoved(id, w)
     NODE_RELS, defaultRel(row)
   No browser popups: every error is a toast or an inline line.
   ================================================================ */
(function () {
'use strict';

const esc = (s) => String(s ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#039;' }[c]));
let H = null;                      // host context: { hostKind, group, getInst, toast, draftId }
const SUBS = new Map();            // paperId → { fns:Set, lab:[], mine:[], raw:[], rows:[], unsub }
const CARD_SUBS = new Map();       // card id → unsubscribe (the card's node list)
let LIB = null;                    // library rows (session cache)
let DRAFTS = null;                 // my drafts (session cache)
let R = null;                      // the open reader
const FIG_HEX = '#0d675e';
const LIB_KEY = 'cpr.library.v1', LIB_MS = 10 * 60e3;

/* ─── the connection types: the reader's vocabulary ─────────────────── */
const NODE_RELS = [
  { id: 'supports', label: 'supports', sub: 'Evidence FOR a claim', stance: 'for', hex: '#16a34a' },
  { id: 'refutes',  label: 'refutes',  sub: 'Evidence AGAINST a claim', stance: 'against', hex: '#dc2626' },
  { id: 'informs',  label: 'informs',  sub: 'Information only', stance: null, hex: '#64748b' },
  { id: 'method',   label: 'method',   sub: 'A method to reuse', stance: null, hex: '#2563eb' },
  { id: 'question', label: 'question', sub: 'Raises a question', stance: null, hex: '#7c3aed' },
  { id: 'quote',    label: 'quote',    sub: 'Quote it', stance: null, hex: '#ea580c' }
];
const TYPE_REL = { evidence: 'supports', limitation: 'refutes', method: 'method', question: 'question', quote: 'quote', note: 'informs', figure: 'informs' };
function relOf(id) { return NODE_RELS.find(r => r.id === id) || null; }
function defaultRel(row) { return (row && TYPE_REL[row.annType]) || 'informs'; }
function stanceOf(rel) { const r = relOf(rel); return r ? r.stance : null; }

/* ─── small helpers ────────────────────────────────────────────────── */
// firebridge is a lexical const in firebase-bridge.js, never a window property (V3.862): window.firebridge is undefined in
// production, so look the bare global up first and keep window.* only for test stubs.
function fb() { return (typeof firebridge !== 'undefined' && firebridge) || window.firebridge || null; }
function db() { const b = fb(); if (!b || !b.db) throw new Error('the sign-in bridge did not load'); return b.db(); }
function me() { const b = fb(); return (b && b.getUser && b.getUser()) || {}; }
function uid() { return me().uid || ''; }
function toast(kind, msg) { try { if (H && H.toast) H.toast(kind, msg); else if (window.TOAST && window.TOAST[kind]) window.TOAST[kind](msg); } catch (e) {} }
function inst() { return (H && H.getInst && H.getInst()) || null; }
function colors() { return (window.ANNOTATION_COLORS && window.ANNOTATION_COLORS.DEFAULT) || [{ id: 'yellow', name: 'Note', hex: '#facc15', meaning: '' }]; }
function hexFor(colorId) { return window.ANNOTATION_COLORS ? window.ANNOTATION_COLORS.hexFor(colorId) : '#facc15'; }
function typeFor(colorId) { return window.ANNOTATION_COLORS ? window.ANNOTATION_COLORS.typeFor(colorId) : 'note'; }
function newId(p) { return (p || 'x') + Date.now().toString(36) + Math.random().toString(36).slice(2, 7); }
function citeFor(r, page) {
  if (!r) return '';
  let who = r.first || 'Unknown';
  if (r.nAuthors === 2 && r.second) who = `${r.first} & ${r.second}`; else if (r.nAuthors > 2) who = `${r.first} et al.`;
  return `${who}${r.year ? ', ' + r.year : ''}${page ? ', p. ' + page : ''}`;
}
/* the reader's highlight colours are pastel (they multiply onto the page); a wire in the same hue needs a darker shade to read on the grid */
function shade(hex, k) {
  const m = /^#([0-9a-f]{2})([0-9a-f]{2})([0-9a-f]{2})$/i.exec(hex || ''); if (!m) return hex || '#64748b';
  const f = (h) => Math.max(0, Math.min(255, Math.round(parseInt(h, 16) * (1 - k) + 24 * k)));
  return '#' + [m[1], m[2], m[3]].map(h => f(h).toString(16).padStart(2, '0')).join('');
}
function wireHex(hex) { return shade(hex, 0.32); }
function readerUrl(paperId, annId) { return `/rm/pages/library-paper.html?id=${encodeURIComponent(paperId)}${annId ? '&ann=' + encodeURIComponent(annId) : ''}`; }
function armTwoTap(btn, label) {
  if (btn.dataset.armed === '1') { btn.dataset.armed = ''; btn.textContent = btn.dataset.was || btn.textContent; return true; }
  btn.dataset.armed = '1'; btn.dataset.was = btn.textContent; btn.textContent = label || 'Sure?'; btn.classList.add('cpr-armed');
  setTimeout(() => { if (btn.isConnected && btn.dataset.armed === '1') { btn.dataset.armed = ''; btn.textContent = btn.dataset.was; btn.classList.remove('cpr-armed'); } }, 3000);
  return false;
}

/* ─── the library ──────────────────────────────────────────────────── */
function paperRow(id, x) {
  const lib = (x.meta && x.meta.library) || {};
  if (!lib.is_library_entry) return null;
  const authors = Array.isArray(lib.authors) ? lib.authors : [];
  const fam = (a) => (a && (a.family || a.last || a.name)) || '';
  return { id, title: x.title || '(untitled)', year: lib.year || '', journal: lib.journal_iso || lib.journal || '', first: fam(authors[0]), second: fam(authors[1]), nAuthors: authors.length,
    pdf: lib.pdf && lib.pdf.storage_path ? lib.pdf.storage_path : '', hay: [x.title, ...authors.map(fam), lib.year, lib.journal, lib.doi].filter(Boolean).join(' ').toLowerCase(), added: lib.date_added || x.updated_at || '' };
}
async function loadLibrary() {
  if (LIB) return LIB;
  try { const raw = sessionStorage.getItem(LIB_KEY); if (raw) { const c = JSON.parse(raw); if (c && Date.now() - c.at < LIB_MS && Array.isArray(c.rows)) return (LIB = c.rows); } } catch (e) {}
  const snap = await db().collection('items').where('type', '==', 'paper').get();
  const rows = []; snap.forEach(d => { const r = paperRow(d.id, d.data() || {}); if (r) rows.push(r); });
  rows.sort((a, b) => String(b.added).localeCompare(String(a.added)));
  LIB = rows; try { sessionStorage.setItem(LIB_KEY, JSON.stringify({ at: Date.now(), rows })); } catch (e) {}
  return rows;
}
async function loadMyDrafts() {
  if (DRAFTS) return DRAFTS;
  const snap = await db().collection('papers').where('authorUids', 'array-contains', uid()).get();
  const rows = []; snap.forEach(d => { const x = d.data() || {}; if (x.is_library_entry) return; rows.push({ id: d.id, title: x.title || '(untitled)', updated: x.updated_at || x.updatedAt || '' }); });
  rows.sort((a, b) => String(b.updated).localeCompare(String(a.updated)));
  DRAFTS = rows; return rows;
}

/* ─── annotations: one live merged list per paper ──────────────────── */
function rowOf(a, myUid) {
  if (!a || a.kind === 'equation') return null;
  const pages = (a.target && Array.isArray(a.target.pages)) ? a.target.pages : [];
  let quote = '';
  for (const p of pages) { const q = p && p.selectors && p.selectors.textQuote && p.selectors.textQuote.exact; if (q) { quote = String(q); break; } }
  const page = (pages[0] && pages[0].page) || 0;
  const isFig = a.kind === 'figure';
  if (isFig && !(a.image && a.image.download_url) && !a.snip_data_uri) return null;
  if (!isFig && !quote) return null;
  const colorId = a.color_id || 'yellow';
  const ms = (a.created && typeof a.created.toMillis === 'function') ? a.created.toMillis() : 0;
  return { id: a.id, type: isFig ? 'figure' : 'highlight', quote, page, colorId, hex: isFig ? FIG_HEX : hexFor(colorId),
    annType: a.annotation_type || (isFig ? 'figure' : typeFor(colorId)), name: a.name || '', url: (a.image && a.image.download_url) || '',
    storagePath: (a.image && a.image.storage_path) || '', thumb: a.snip_data_uri || '', comment: a.comment || '',
    mine: !!(a.creator && a.creator.uid === myUid), by: (a.creator && a.creator.displayName) || '', createdMs: ms, raw: a };
}
function watch(paperId, fn) {
  let s = SUBS.get(paperId);
  if (!s) {
    s = { fns: new Set(), lab: [], mine: [], raw: [], rows: [], unsub: null, ready: false };
    const col = db().collection('papers').doc(paperId).collection('annotations');
    const emit = () => {
      const seen = new Set(); s.raw = [];
      s.lab.concat(s.mine).forEach(a => { if (!seen.has(a.id)) { seen.add(a.id); s.raw.push(a); } });
      const u = uid();
      s.rows = s.raw.map(a => rowOf(a, u)).filter(Boolean).sort((a, b) => (a.page - b.page) || (a.createdMs - b.createdMs));
      s.ready = true;
      s.fns.forEach(f => { try { f(s.rows, s.raw); } catch (e) { console.warn('[canvas-paper-reader] listener', e); } });
    };
    const read = (snap) => snap.docs.map(d => Object.assign({ id: d.id }, d.data({ serverTimestamps: 'estimate' })));
    const err = (e) => { console.warn('[canvas-paper-reader] annotations', e); s.ready = true; s.fns.forEach(f => { try { f(s.rows, s.raw); } catch (x) {} }); };
    const u1 = col.where('visibility', '==', 'lab').onSnapshot(snap => { s.lab = read(snap); emit(); }, err);
    const u2 = col.where('creator.uid', '==', uid()).where('visibility', '==', 'private').onSnapshot(snap => { s.mine = read(snap); emit(); }, err);
    s.unsub = () => { try { u1(); } catch (e) {} try { u2(); } catch (e) {} };
    SUBS.set(paperId, s);
  }
  s.fns.add(fn);
  if (s.ready) { try { fn(s.rows, s.raw); } catch (e) {} }
  /* the listener stays for the session: it is cheap, and the cache serves wires that land later */
  return () => { s.fns.delete(fn); };
}
async function annRow(paperId, annId) {
  const s = SUBS.get(paperId);
  const hit = s && s.rows.find(r => r.id === annId);
  if (hit) return hit;
  try { const d = await db().collection('papers').doc(paperId).collection('annotations').doc(annId).get(); if (d.exists) return rowOf(Object.assign({ id: d.id }, d.data()), uid()); } catch (e) {}
  return null;
}
async function createAnn(paperId, payload, title) {
  const u = me(); const prof = (fb() && fb().getProfile && fb().getProfile()) || null;
  const FV = window.firebase && window.firebase.firestore && window.firebase.firestore.FieldValue;
  const stamp = FV ? FV.serverTimestamp() : new Date().toISOString();
  const doc = Object.assign({
    paperId, type: 'Annotation', motivation: 'highlighting', visibility: 'lab', color_id: 'yellow', annotation_type: 'note', comment: '',
    target: { pages: [] }, marked_for_investigation: false, evidence_for_claim_ids: [], evidence_stance: null, cite_in_drafts: []
  }, payload, {
    creator: { uid: u.uid || '', email: u.email || '', displayName: (prof && prof.name) || u.displayName || u.email || '' },
    created: stamp, modified: stamp
  });
  const ref = db().collection('papers').doc(paperId).collection('annotations').doc();
  await ref.set(doc);
  try { window.ActivitySignals && window.ActivitySignals.recordWork && window.ActivitySignals.recordWork({ source: 'rm-library', sourceRef: { kind: 'annotation', id: paperId, path: 'papers/' + paperId }, text: 'Annotated: ' + (title || 'a paper'), categoryPath: ['research', 'reading'] }).catch(() => {}); } catch (e) {}
  return ref.id;
}
async function deleteAnn(paperId, row) {
  try { if (row && row.raw && window.CLAIMS && window.CLAIMS.removeEvidenceForAnnotation) await window.CLAIMS.removeEvidenceForAnnotation(row.raw); } catch (e) {}
  await db().collection('papers').doc(paperId).collection('annotations').doc(row.id).delete();
}

/* ─── wires from a node: chips, menus, linking ─────────────────────── */
function nodeWires(cardId, annId) {
  const I = inst(); if (!I || !I.getWires) return [];
  const items = I.getItems(); const byId = new Map(items.map(x => [x.id, x]));
  const nameOf = (t) => { if (!t) return 'a card'; if (t.title) return t.title; if (t.kind === 'collection') return (t.data && t.data.claim) ? 'Claim' : 'Collection'; return (window.CANVAS_WIDGETS && window.CANVAS_WIDGETS.summary(t)) || t.kind || 'a card'; };
  return I.getWires().filter(w => w.from === cardId && w.fromNode === annId).map(w => { const t = byId.get(w.to); return Object.assign({ target: t, targetName: nameOf(t) }, w); });
}
function relChip(w) {
  const r = relOf(w.rel) || { label: w.rel || 'linked', hex: '#64748b' };
  return `<button type="button" class="cpr-chip" data-cpr-chip="${esc(w.id)}" style="--chip:${r.hex}" title="Change the connection type">${esc(r.label)} → ${esc(String(w.targetName || '').slice(0, 40))}</button>`;
}
function relMenu(anchor, wireId, current, extra) {
  const I = inst(); if (!I) return;
  const items = NODE_RELS.map(r => ({ label: (current === r.id ? '✓ ' : '') + r.label, sub: r.sub, run: () => I.updateWire(wireId, { rel: r.id }) }));
  if (extra && extra.remove !== false) items.push({ label: 'Remove the connection', danger: true, confirm: 'Really remove?', run: () => I.removeWire(wireId) });
  window.CANVAS_WIDGETS.actionMenu(Object.assign({ title: 'Connection type', items }, anchor && anchor.getBoundingClientRect ? { anchor } : { point: anchor }));
}
/** The ⋯ for a wire that leaves a node (hosts hand these over). */
function wireMenu(id, w, e) { relMenu({ x: e.clientX, y: e.clientY }, id, w && w.rel, { remove: true }); }
async function linkNode(card, row, targetId, rel) {
  const I = inst(); if (!I || !card || !row) return null;
  const id = await I.addWire(card.id, targetId, rel || defaultRel(row), { fromSide: 'e', toSide: 'w', fromNode: row.id, color: wireHex(row.hex) });
  if (id) toast('success', `Connected as “${rel || defaultRel(row)}” — tap the line to change the type.`);
  return id;
}
/** "Connect to…": the board's collections and claims, or a new one, for a node (the ⤳ button, phones included). */
function pickTarget(anchor, card, row) {
  const I = inst(); if (!I || !card || !row) return;
  const cols = I.getItems().filter(x => x.type === 'widget' && x.kind === 'collection' && x.id !== card.id);
  const linked = new Set(nodeWires(card.id, row.id).map(w => w.to));
  const items = cols.map(c => ({ label: (c.data && c.data.claim ? '◆ ' : '') + (c.title || (c.data && c.data.claim ? 'Claim' : 'Collection')) + (linked.has(c.id) ? ' ✓' : ''), sub: `${((c.data && c.data.items) || []).length} item${((c.data && c.data.items) || []).length === 1 ? '' : 's'}${linked.has(c.id) ? ' · already connected' : ''}`, run: () => { if (!linked.has(c.id)) linkNode(card, row, c.id); } }));
  const place = () => ({ pageId: card.pageId, x: Math.min(0.64, (card.x || 0) + (card.w || 0.42) + 0.03), y: card.y || 0 });
  items.push({ label: '＋ New collection', sub: 'A list card beside this paper', run: async () => { const id = await I.addWidget(Object.assign({ kind: 'collection', title: 'Collection', w: 0.36, data: { items: [], claim: null }, text: '' }, place())); if (id) linkNode(card, row, id); } });
  items.push({ label: '＋ New claim', sub: 'A claim for a paper draft; this becomes its evidence', run: async () => { const id = await I.addWidget(Object.assign({ kind: 'collection', title: 'Claim', w: 0.36, data: { items: [], claim: null, claimSetup: true }, text: '' }, place())); if (id) linkNode(card, row, id); } });
  window.CANVAS_WIDGETS.actionMenu({ anchor, title: `Connect “${(row.type === 'figure' ? (row.name || 'Figure') : row.quote).slice(0, 40)}” to…`, items });
}

/* ─── 📑 a collection's data (V3.856 · V3.859) ────────────────────────
   One card for everything that comes from a paper. A QUOTE is a collection holding one passage
   (`shape: 'quote'`), a LIT REVIEW is a collection of papers with key points and notes, a CLAIM is
   a collection bound to a draft's claim. Any collection may be linked to papers you are writing
   (`drafts`). The old kinds (paperquote · quote · litreview) render through here via asCollection()
   and are ADOPTED — rewritten as collections, a lit review's extra sections split into their own
   cards — on their first edit, never on render.
   data: { items:[entry], keyPoints:[], notes_html, query, drafts:[{id,title}], linkedPairs:['pid|did'],
           claim, claimSetup, shape }
   entry types: highlight | figure (a node of a 📖 Paper card) · card (any card wired in) ·
                paper (a library paper) · quote (a passage typed or taken as text) */
const COLL_KINDS = new Set(['collection', 'paperquote', 'quote', 'litreview']);
const QUOTE_HEX = '#ea580c', PAPER_HEX = '#475569';
const plural = (n, w) => `${n} ${w}${n === 1 ? '' : 's'}`;
function hostDrafts() {
  try { const id = (H && typeof H.draftId === 'function') ? H.draftId() : ''; return id ? [{ id, title: (H.draftTitle && H.draftTitle()) || 'This paper' }] : []; }
  catch (e) { return []; }
}
function currentItem(id) { const I = inst(); return I ? (I.getItems().find(x => x.id === id) || null) : null; }
function paperEntry(pid, p, extra) {
  return Object.assign({ id: newId('e'), type: 'paper', paperId: pid, title: p.title || '', cite: p.cite || '', year: p.year || '', journal: p.journal || '', why: p.why || '', rel: 'informs', hex: PAPER_HEX, addedAt: p.addedAt || new Date().toISOString() }, extra || {});
}
function paperIdsOf(d) { return Array.from(new Set(((d && d.items) || []).map(e => e && e.paperId).filter(Boolean))); }
function countsOf(list) {
  const c = { papers: 0, highlights: 0, figures: 0, quotes: 0, cards: 0 };
  (list || []).forEach(e => { if (!e) return; if (e.type === 'paper') c.papers++; else if (e.type === 'highlight') c.highlights++; else if (e.type === 'figure') c.figures++; else if (e.type === 'quote') c.quotes++; else c.cards++; });
  return c;
}
function countsLine(c, keyPoints) {
  const parts = [];
  if (c.papers) parts.push(plural(c.papers, 'paper'));
  if (c.highlights) parts.push(plural(c.highlights, 'highlight'));
  if (c.figures) parts.push(plural(c.figures, 'figure'));
  if (c.quotes) parts.push(plural(c.quotes, 'quote'));
  if (c.cards) parts.push(plural(c.cards, 'card'));
  const k = (keyPoints || []).filter(x => String(x || '').trim()).length;
  if (k) parts.push(plural(k, 'key point'));
  return parts.join(' · ');
}
/** The figure board's picker line for a mirror doc (new mirrors carry counts; V3.838 ones only paperIds). */
function mirrorSubline(r) {
  const c = (r && r.counts) || { papers: ((r && r.paperIds) || []).length, highlights: 0, figures: 0, quotes: 0, cards: 0 };
  return countsLine(c, (r && r.keyPoints) || []) || 'empty';
}
/** Any collection-family item as collection data, in memory. Nothing is written here. */
function asCollection(it) {
  const d = (it && it.data) || {}; const kind = it && it.kind;
  if (kind === 'paperquote' || kind === 'quote') {
    const hl = !!(d.annId && d.paperId);
    const e = hl ? { id: 'e_' + it.id, type: 'highlight', paperId: d.paperId, annId: d.annId, quote: d.text || '', cite: d.cite || '', page: d.page || 0, rel: 'quote', hex: '#fb923c' }
      : { id: 'e_' + it.id, type: 'quote', quote: d.text || '', cite: d.cite || '', paperId: d.paperId || '', page: d.page || 0, rel: 'quote', hex: QUOTE_HEX };
    return { legacy: true, rest: [], firstTitle: '', data: { items: [e], shape: 'quote', keyPoints: [], notes_html: '', query: '', drafts: hostDrafts(), claim: null } };
  }
  if (kind === 'litreview') {
    const P = (d.papers && typeof d.papers === 'object') ? d.papers : {};
    const secs = (Array.isArray(d.sections) && d.sections.length) ? d.sections : [{ title: 'Papers', paperIds: Object.keys(P), keyPoints: [], notes_html: '' }];
    const conv = (sec) => ({ items: (sec.paperIds || []).filter(pid => P[pid]).map(pid => paperEntry(pid, P[pid], { id: 'e_' + pid })), keyPoints: (sec.keyPoints || []).map(k => String(k == null ? '' : k)), notes_html: sec.notes_html || '', query: d.query || '', drafts: hostDrafts(), claim: null });
    return { legacy: true, firstTitle: secs[0].title || '', rest: secs.slice(1).map((s, k) => ({ title: s.title || ('Section ' + (k + 2)), data: conv(s) })), data: conv(secs[0]) };
  }
  const data = Object.assign({ items: [], keyPoints: [], notes_html: '', query: '', drafts: [], claim: null }, d);
  if (!Array.isArray(data.items)) data.items = [];
  if (!Array.isArray(data.keyPoints)) data.keyPoints = [];
  if (!Array.isArray(data.drafts)) data.drafts = [];
  return { legacy: false, rest: [], firstTitle: '', data };
}
function collectionText(it, list) {
  const d = (it && it.data) || {}; const title = (it && it.title) || (d.claim ? 'Claim' : 'Collection');
  const parts = (list || []).map(e => e.type === 'paper' ? `${e.title || ''}${e.cite ? ` (${e.cite})` : ''}${e.why ? ': ' + e.why : ''}`
    : (e.quote ? `“${e.quote}”` : e.name || '') + (e.cite ? ` (${e.cite})` : '') + (e.type === 'quote' ? '' : ` [${e.rel}]`));
  const kp = (d.keyPoints || []).map(k => String(k || '').trim()).filter(Boolean);
  return [title + (d.query ? ` — ${d.query}` : ''), ...parts, ...kp].filter(Boolean).join(' · ');
}

/* adoption: the old kinds become collections on their first edit (deterministic ids for split sections, so two tabs
   adopting the same review write the same docs instead of duplicating them) */
const ADOPTING = new Map();
function adopt(it) {
  if (!it || it.kind === 'collection') return Promise.resolve(true);
  if (ADOPTING.has(it.id)) return ADOPTING.get(it.id);
  const p = (async () => {
    const I = inst(); if (!I) return false;
    const cur = currentItem(it.id); if (!cur) return false;
    if (cur.kind === 'collection') return true;
    const c = asCollection(cur);
    const base = String(cur.title || '').trim() || (cur.kind === 'litreview' ? 'Lit review' : '');
    const title = (c.rest.length && c.firstTitle && c.firstTitle !== 'Papers') ? `${base} — ${c.firstTitle}` : base;
    /* the new sections go straight BELOW the card (its rendered height, in board units), one under the other; the
       engine's avoidOverlap nudges them past anything already there */
    let below = (cur.y || 0) + 0.3;
    const node = cardNode(cur.id);
    if (node) { const rc = node.getBoundingClientRect(); const ppu = rc.width / (cur.w || 0.42); if (ppu > 0 && rc.height > 0) below = (cur.y || 0) + (rc.height + 20) / ppu; }
    let k = 0;
    for (const r of c.rest) {
      k += 1;
      const nid = `${cur.id}_s${k + 1}`;
      if (currentItem(nid)) continue;
      const t = `${base || 'Lit review'} — ${r.title}`.slice(0, 200);
      await I.addWidget({ itemId: nid, kind: 'collection', title: t, data: r.data, text: collectionText({ title: t, data: r.data }, r.data.items).slice(0, 4000), w: cur.w || 0.42, pageId: cur.pageId, x: cur.x || 0, y: below + 0.3 * (k - 1) });
      mirrorSoon(nid);
    }
    await I.updateItem(cur.id, { kind: 'collection', title: title.slice(0, 200), data: c.data, text: collectionText({ title, data: c.data }, c.data.items).slice(0, 4000) });
    mirrorSoon(cur.id);
    if (c.rest.length) toast('success', `The lit review is now ${c.rest.length + 1} collections — one per section.`);
    return true;
  })().finally(() => ADOPTING.delete(it.id));
  ADOPTING.set(it.id, p);
  return p;
}
/** Write a patch onto the card's CURRENT data (a function patch reads it first, so a wire landing while you type is
    never overwritten). `{ refresh }` repaints the card and its sheet: the engine treats a data save as the body's own. */
async function patchData(id, patch, o) {
  const I = inst(); if (!I) return false;
  const cur = currentItem(id); if (!cur) return false;
  const p = (typeof patch === 'function') ? (patch(asCollection(cur).data) || {}) : (patch || {});
  const hasTitle = !!(o && typeof o.title === 'string');
  if (!Object.keys(p).length && !hasTitle) return false;
  const data = Object.assign({}, cur.data || {}, p);
  const title = hasTitle ? o.title.slice(0, 200) : (cur.title || '');
  const up = { data, text: collectionText({ title, data }, data.items || []).slice(0, 4000) };
  if (hasTitle) up.title = title;
  await I.updateItem(id, up);
  if (o && o.refresh) { try { I.refreshWidget(id); } catch (e) {} }
  mirrorSoon(id);
  if (p.items || p.drafts) syncDraftLinks(id);
  return true;
}
function cardNode(id) { try { return document.querySelector(`.wb-item[data-item-id="${CSS.escape(id)}"]`); } catch (e) { return null; } }
function sheetBodyFor() { return document.querySelector('.wb-sheet-back [data-wb-sheet-body]'); }
/* where focus was, so an adoption (which rebuilds the card) can put the caret back */
function focusKey(el) {
  if (!el || !el.dataset) return null;
  for (const a of ['kp', 'why', 'qtext', 'qcite']) if (el.dataset[a] !== undefined) return `[data-${a}="${el.dataset[a]}"]`;
  for (const c of ['cpr-search-in', 'cpr-qcard-in', 'cpr-qcard-cite', 'cpr-notes']) if (el.classList.contains(c)) return '.' + c;
  return null;
}
function focusIn(id, sel, caret) {
  setTimeout(() => {
    const sb = sheetBodyFor(); const n = (sb && sb.querySelector(sel)) || (cardNode(id) && cardNode(id).querySelector(sel));
    if (!n) return;
    try { n.focus({ preventScroll: true }); } catch (e) { n.focus(); }
    if (typeof caret === 'number' && n.setSelectionRange) { try { n.setSelectionRange(caret, caret); } catch (e) {} }
  }, 60);
}
function committer(it) {
  return async (patch, o) => {
    let adopted = false; let key = null, caret = null;
    if (it.kind !== 'collection' && currentItem(it.id) && currentItem(it.id).kind !== 'collection') {
      const ae = document.activeElement; const host = cardNode(it.id); const sb = sheetBodyFor();
      if (ae && ((host && host.contains(ae)) || (sb && sb.contains(ae)))) { key = focusKey(ae); caret = (typeof ae.selectionStart === 'number') ? ae.selectionStart : null; }
      if (!(await adopt(it))) return false;
      adopted = true;
    }
    const r = await patchData(it.id, patch, adopted ? Object.assign({}, o, { refresh: true }) : o);
    if (adopted && key) focusIn(it.id, key, caret);
    return r;
  };
}

/* papers you are writing: every library paper the collection touches is linked to each linked draft, once */
let SYNC_BUSY = false; const SYNC_Q = new Set();
async function syncDraftLinks(id) {
  if (id) SYNC_Q.add(id);
  if (SYNC_BUSY) return;
  SYNC_BUSY = true;
  try {
    while (SYNC_Q.size) {
      const cid = SYNC_Q.values().next().value; SYNC_Q.delete(cid);
      const I = inst(); if (!I || !window.LIBRARY_LINKS || !window.LIBRARY_LINKS.toggleDraftLink) continue;
      const c = currentItem(cid); if (!c || c.kind !== 'collection') continue;
      try { if (I.api && !I.api(cid).canEdit()) continue; } catch (e) {}
      const d = c.data || {}; const drafts = (d.drafts || []).map(x => x && x.id).filter(Boolean);
      const have = new Set(d.linkedPairs || []); const add = [];
      paperIdsOf(d).forEach(p => drafts.forEach(dr => { const k = p + '|' + dr; if (!have.has(k)) add.push(k); }));
      if (!add.length) continue;
      for (const k of add) {
        const [p, dr] = k.split('|');
        try { await window.LIBRARY_LINKS.toggleDraftLink(p, dr, true); have.add(k); } catch (e) { console.warn('[canvas-paper-reader] link', p, dr, e); }
      }
      const cur = currentItem(cid); if (!cur) continue;
      await I.updateItem(cid, { data: Object.assign({}, cur.data || {}, { linkedPairs: [...have] }) });
    }
  } finally { SYNC_BUSY = false; }
}
function pairsHeldElsewhere(id) {
  const I = inst(); const s = new Set(); if (!I) return s;
  const did = (H && typeof H.draftId === 'function') ? H.draftId() : '';
  I.getItems().forEach(x => {
    if (x.id === id || x.type !== 'widget') return;
    if (x.kind === 'collection') ((x.data && x.data.linkedPairs) || []).forEach(k => s.add(k));
    if (x.kind === 'litref' && did) ((x.data && x.data.linked) || []).forEach(p => s.add(p + '|' + did));
  });
  return s;
}
async function linkDraft(it, r) {
  const commit = committer(it);
  await commit(cd => ({ drafts: (cd.drafts || []).filter(x => x.id !== r.id).concat([{ id: r.id, title: r.title || 'Untitled draft' }]) }), { refresh: true });
  const cur = currentItem(it.id); const n = cur ? paperIdsOf(cur.data).length : 0;
  toast('success', `Linked to “${r.title || 'the draft'}”${n ? ` — ${plural(n, 'paper')} in it ${n === 1 ? 'is' : 'are'} now linked to that draft` : ''}.`);
}
async function unlinkDraft(it, draftId) {
  const cur = currentItem(it.id); if (!cur) return;
  const pairs = ((cur.data && cur.data.linkedPairs) || []).filter(k => k.endsWith('|' + draftId));
  const others = pairsHeldElsewhere(it.id); let n = 0;
  for (const k of pairs) {
    if (others.has(k) || !window.LIBRARY_LINKS) continue;
    try { await window.LIBRARY_LINKS.toggleDraftLink(k.split('|')[0], draftId, false); n++; } catch (e) { console.warn('[canvas-paper-reader] unlink', k, e); }
  }
  await patchData(it.id, cd => ({ drafts: (cd.drafts || []).filter(x => x.id !== draftId), linkedPairs: (cd.linkedPairs || []).filter(k => !k.endsWith('|' + draftId)) }), { refresh: true });
  toast('info', n ? `Unlinked — ${plural(n, 'paper')} no longer linked to that draft.` : 'Unlinked.');
}
async function openDraftPicker(anchor, it) {
  let rows = [];
  try { rows = (await loadMyDrafts()).slice(); } catch (e) { rows = []; }
  hostDrafts().forEach(p => { if (!rows.some(r => r.id === p.id)) rows.unshift({ id: p.id, title: p.title }); });
  const cur = currentItem(it.id); const have = new Set(((cur ? asCollection(cur).data : {}).drafts || []).map(x => x.id));
  const items = rows.filter(r => !have.has(r.id)).slice(0, 20).map(r => ({ label: '✎ ' + r.title, sub: 'Every paper in this collection gets linked to it', run: () => linkDraft(it, r) }));
  if (!items.length) { toast('info', rows.length ? 'Already linked to every paper you are writing.' : 'You have no paper drafts yet — start one in the Paper builder.'); return; }
  window.CANVAS_WIDGETS.actionMenu({ anchor, title: 'Link to a paper you\'re writing', items });
}

/* the notebook mirror (userData/{uid}/litReviews/{itemId} — the V3.838 path, so placed lit-review cards keep working):
   written when a collection's title or data changes; the figure board lists it and renders it live */
const MIRROR_T = {};
function mirrorSoon(id) {
  if (!H || typeof H.mirror !== 'function' || !id) return;
  clearTimeout(MIRROR_T[id]);
  MIRROR_T[id] = setTimeout(() => { delete MIRROR_T[id]; mirrorNow(id).catch(e => console.warn('[canvas-paper-reader] mirror', e)); }, 500);
}
async function mirrorNow(id) {
  const ctx = H.mirror(); if (!ctx || !ctx.uid) return;
  const it = currentItem(id); if (!it || it.kind !== 'collection') return;
  const d = it.data || {}; const list = Array.isArray(d.items) ? d.items : [];
  const papers = list.filter(e => e.type === 'paper' && e.paperId);
  const FV = window.firebase && window.firebase.firestore && window.firebase.firestore.FieldValue;
  await db().collection('userData').doc(ctx.uid).collection('litReviews').doc(id).set({
    kind: 'collection', itemId: id, title: it.title || (d.claim ? 'Claim' : 'Collection'), boardId: ctx.boardId || '', entryId: ctx.entryId || '',
    query: d.query || '', paperIds: paperIdsOf(d), keyPoints: (d.keyPoints || []).map(k => String(k || '').trim()).filter(Boolean),
    papers: Object.fromEntries(papers.map(p => [p.paperId, { title: p.title || '', cite: p.cite || '', why: p.why || '' }])),
    entries: list.filter(e => e.type !== 'paper').slice(0, 60).map(e => ({ type: e.type || '', rel: e.rel || '', quote: String(e.quote || '').slice(0, 500), name: e.name || '', cite: e.cite || '', hex: e.hex || '', paperId: e.paperId || '', annId: e.annId || '', url: e.url || '' })),
    counts: countsOf(list), claim: d.claim ? { draftId: d.claim.draftId || '', claimId: d.claim.claimId || '', statement: d.claim.statement || '', draftTitle: d.claim.draftTitle || '' } : null,
    drafts: (d.drafts || []).map(x => ({ id: x.id, title: x.title || '' })), draftIds: (d.drafts || []).map(x => x.id).filter(Boolean),
    ownerUid: ctx.uid, updated_at: new Date().toISOString(), updatedAt: FV ? FV.serverTimestamp() : new Date().toISOString()
  });
}
function mirrorDelete(id) {
  const ctx = (H && typeof H.mirror === 'function') ? H.mirror() : null; if (!ctx || !ctx.uid || !id) return;
  try { db().collection('userData').doc(ctx.uid).collection('litReviews').doc(id).delete().catch(() => {}); } catch (e) {}
}
/** The host's Remove: the card's mirror goes with it. Papers stay linked to your drafts (you may still cite them). */
function onRemoveItem(item) { if (item && COLL_KINDS.has(item.kind)) mirrorDelete(item.id); }
/** The figure board placed a notebook collection: record the link on both sides (the mirror and the notebook card). */
async function linkSourceToDraft(r, draftId, draftTitle) {
  if (!r || !draftId || !r.ownerUid || r.ownerUid !== uid()) return;
  const FV = window.firebase && window.firebase.firestore && window.firebase.firestore.FieldValue;
  try { if (FV) await db().collection('userData').doc(r.ownerUid).collection('litReviews').doc(r.id).update({ draftIds: FV.arrayUnion(draftId) }); } catch (e) {}
  if (!r.boardId) return;
  try {
    const ref = db().collection('userData').doc(r.ownerUid).collection('notebookBoards').doc(r.boardId).collection('items').doc(r.itemId || r.id);
    const s = await ref.get(); if (!s.exists) return;
    const it = s.data() || {}; if (it.kind !== 'collection') return;
    const drafts = Array.isArray(it.data && it.data.drafts) ? it.data.drafts : [];
    if (drafts.some(x => x && x.id === draftId)) return;
    await ref.update({ data: Object.assign({}, it.data || {}, { drafts: drafts.concat([{ id: draftId, title: draftTitle || 'This paper' }]) }) });
  } catch (e) { console.warn('[canvas-paper-reader] link back to the notebook', e); }
}
/** The hosts call this on every item change: a mirror on change, and draft links for whatever is missing. */
const SIGS = new Map();
function onItemsChanged() {
  const I = inst(); if (!I) return;
  I.getItems().forEach(c => {
    if (c.type !== 'widget' || c.kind !== 'collection') return;
    const d = Object.assign({}, c.data || {}); delete d.linkedPairs; delete d.claimSetup;
    const sig = JSON.stringify([c.title || '', d]);
    const had = SIGS.get(c.id); SIGS.set(c.id, sig);
    if (had !== undefined && had !== sig) mirrorSoon(c.id);
    const drafts = (c.data && c.data.drafts) || [];
    if (drafts.length) { const have = new Set((c.data && c.data.linkedPairs) || []); if (paperIdsOf(c.data).some(p => drafts.some(x => x && x.id && !have.has(p + '|' + x.id)))) syncDraftLinks(c.id); }
  });
}

/* entries arrive by wires (V3.856): a node of a 📖 Paper card, a Paper card's own side port, or any card */
async function entryFor(from, w, wireId) {
  const base = { id: newId('e'), wireId, fromId: from.id, rel: w.rel || 'informs', addedAt: new Date().toISOString() };
  if (from.kind === 'paperreader') {
    const fd = from.data || {}; const pid = fd.paperId; if (!pid) return null;
    if (!w.fromNode) return paperEntry(pid, { title: fd.title, cite: fd.cite, year: fd.year, journal: fd.journal }, { wireId, fromId: from.id });
    const r = await annRow(pid, w.fromNode); if (!r) return null;
    return Object.assign(base, { type: r.type, paperId: pid, annId: r.id, quote: r.quote, name: r.name, url: r.url, thumb: (r.thumb && r.thumb.length <= 6000) ? r.thumb : '', page: r.page, cite: citeFor(fd, r.page), hex: r.hex, colorId: r.colorId, paperTitle: fd.title || '' });
  }
  const m = (window.CANVAS_WIDGETS && window.CANVAS_WIDGETS.meta(from.kind)) || {}; const fd = from.data || {};
  const img = (fd.cells && fd.cells[0] && fd.cells[0].url) || fd.url || '';
  const quote = (from.kind === 'paperquote' || from.kind === 'quote') ? (fd.text || '') : '';
  return Object.assign(base, { type: 'card', cardId: from.id, kind: from.kind, glyph: m.glyph || '•', name: from.title || (window.CANVAS_WIDGETS ? window.CANVAS_WIDGETS.summary(from) : '') || m.label || 'Card', url: img, thumb: '', quote, cite: fd.cite || (fd.cells && fd.cells[0] && fd.cells[0].caption) || '', paperId: fd.paperId || '', annId: fd.annId || '', hex: from.color || '#64748b' });
}
async function syncClaim(col, entry, op, before) {
  const c = col && col.data && col.data.claim; if (!c || !c.claimId || !c.draftId || !entry || !entry.paperId || !entry.annId || !window.CLAIMS) return;
  const now = op === 'remove' ? null : stanceOf(entry.rel);
  const was = before ? stanceOf(before.rel) : (op === 'remove' ? stanceOf(entry.rel) : null);
  try {
    if (now) await window.CLAIMS.addEvidence(c.draftId, c.claimId, entry.paperId, entry.annId, now);
    else if (was) await window.CLAIMS.removeEvidence(c.draftId, c.claimId, entry.paperId, entry.annId);
  } catch (e) { console.warn('[canvas-paper-reader] claim evidence', e); toast('error', 'The claim could not be updated: ' + (e.message || e)); }
}
async function onWireAdded(id, w) {
  const I = inst(); if (!I || !w) return;
  let to = currentItem(w.to); const from = currentItem(w.from);
  if (!to || !from || !COLL_KINDS.has(to.kind)) return;
  if (to.kind !== 'collection') { if (!(await adopt(to))) return; to = currentItem(w.to); if (!to) return; }
  const entry = await entryFor(from, w, id); if (!entry) return;
  let added = false;
  await patchData(to.id, cd => {
    const items = cd.items || [];
    if (items.some(e => e.wireId === id)) return {};
    if (entry.type === 'paper' && items.some(e => e.type === 'paper' && e.paperId === entry.paperId)) return {};
    added = true; return { items: items.concat([entry]), shape: cd.shape === 'quote' ? 'list' : cd.shape };
  }, { refresh: true });
  if (added) await syncClaim(currentItem(to.id), entry, 'add');
}
async function onWireUpdated(id, w) {
  if (!w) return;
  const to = currentItem(w.to); if (!to || to.kind !== 'collection') return;
  let prev = null, next = null;
  await patchData(to.id, cd => {
    const items = (cd.items || []).slice(); const k = items.findIndex(e => e.wireId === id); if (k < 0) return {};
    prev = items[k]; if (prev.rel === (w.rel || 'informs')) return {};
    next = Object.assign({}, prev, { rel: w.rel || 'informs' }); items[k] = next; return { items };
  }, { refresh: true });
  if (next) await syncClaim(currentItem(to.id), next, 'update', prev);
}
async function onWireRemoved(id, w) {
  if (!w) return;
  const to = currentItem(w.to); if (!to || to.kind !== 'collection') return;
  let gone = [];
  await patchData(to.id, cd => { const items = cd.items || []; gone = items.filter(e => e.wireId === id); return gone.length ? { items: items.filter(e => e.wireId !== id) } : {}; }, { refresh: true });
  for (const e of gone) await syncClaim(currentItem(to.id), e, 'remove');
}

/* ─── 📖 the paper card ────────────────────────────────────────────── */
function renderLibraryPick(it, body, api) {
  body.innerHTML = `<div class="cpr-pick"><div class="nbk-inline-pick-head"><input type="search" placeholder="Search the library — title, author, year…" data-cpr-q aria-label="Search the library"></div><div class="nbk-inline-pick-list" data-cpr-list><div class="nbk-pick-empty">Loading the library…</div></div></div>`;
  const q = body.querySelector('[data-cpr-q]'), list = body.querySelector('[data-cpr-list]');
  const draw = (rows) => {
    const terms = q.value.trim().toLowerCase().split(/\s+/).filter(Boolean);
    const show = rows.filter(r => terms.every(t => r.hay.includes(t))).slice(0, 60);
    list.innerHTML = show.length ? show.map(r => `<button type="button" class="nbk-pick-row${r.pdf ? '' : ' cpr-nopdf-row'}" data-cpr-paper="${esc(r.id)}">${ICON.svg('document-text')} ${esc(r.title)}<small>${esc(citeFor(r))}${r.journal ? ' · ' + esc(r.journal) : ''}${r.pdf ? '' : ' · no PDF yet — you can add one on the card'}</small></button>`).join('') : `<div class="nbk-pick-empty">${rows.length ? `No paper in the library matches “${esc(q.value.trim())}”.` : 'The library is empty.'}</div>`;
  };
  const load = () => loadLibrary().then(rows => { draw(rows); q.oninput = () => draw(rows); }).catch(e => {
    list.innerHTML = `<div class="nbk-pick-empty">Could not reach the library (${esc(e.message || e)}). <button type="button" class="cpr-mini cpr-mini-ghost" data-cpr-libretry>Try again</button></div>`;
  });
  load();   /* V3.859 — a failed load can be retried in place */
  list.addEventListener('click', (e) => {
    if (e.target.closest('[data-cpr-libretry]')) { LIB = null; list.innerHTML = '<div class="nbk-pick-empty">Loading the library…</div>'; load(); return; }
    const b = e.target.closest('[data-cpr-paper]'); if (!b) return;
    const r = (LIB || []).find(x => x.id === b.dataset.cprPaper); if (!r) return;
    const data = { paperId: r.id, title: r.title, cite: citeFor(r), journal: r.journal, pdf: r.pdf, year: r.year, first: r.first, second: r.second, nAuthors: r.nAuthors };
    api.save({ data, title: it.title || r.title.slice(0, 120), text: `Paper: ${r.title} ${citeFor(r)}` }); api.refresh();
  });
  setTimeout(() => CANVAS_WIDGETS.autoFocus(q), 30);   /* V3.863 — no keyboard over the list on a touch screen */
}
function countsText(rows) {
  const h = rows.filter(r => r.type === 'highlight').length, f = rows.length - h;
  return `${h} highlight${h === 1 ? '' : 's'} · ${f} figure${f === 1 ? '' : 's'}`;
}
function nodeRowHTML(r, opts) {
  const canEdit = opts.canEdit, inSheet = opts.inSheet, wires = opts.wires || [];
  return `<div class="cpr-node cpr-node-${r.type}" data-cpr-ann="${esc(r.id)}" title="${esc(r.type === 'figure' ? (r.name || 'Figure') : r.quote)}${r.page ? ' · p. ' + r.page : ''}">
      <span class="cpr-bar" style="background:${r.hex}"></span>
      ${r.type === 'figure' && (r.thumb || r.url) ? `<img class="cpr-thumb" src="${esc(r.thumb || r.url)}" alt="" draggable="false">` : ''}
      <span class="cpr-ntext">${r.type === 'figure' ? ICON.svg('photo') + ' ' + esc(r.name || 'Figure') : esc(r.quote.length > 150 ? r.quote.slice(0, 148) + '…' : r.quote)}${wires.length ? `<span class="cpr-nchips">${wires.map(relChip).join('')}</span>` : ''}</span>
      ${r.page ? `<span class="cpr-npage">p.${r.page}</span>` : ''}
      ${canEdit ? `<button type="button" class="cpr-link" data-cpr-link="${esc(r.id)}" title="Connect this to a collection or claim…" aria-label="Connect to a collection">⤳</button>` : ''}
      ${canEdit && !inSheet ? `<span class="cpr-port" data-wb-port="e" data-wb-node="${esc(r.id)}" data-wb-color="${wireHex(r.hex)}" data-wb-rel="${esc(defaultRel(r))}" style="background:${r.hex}" title="Drag onto a collection, a claim or any card"></span>` : ''}
    </div>`;
}
function drawNodes(it, el, rows, api) {
  const canEdit = api.canEdit(); const inSheet = !!api.inSheet;
  if (!rows.length) { el.innerHTML = `<div class="cpr-empty">No highlights or snipped figures yet${canEdit && it.data.pdf ? ' — press ' + ICON.svg('book-open') + ' Read, select text to highlight it, click a figure to snip it' : ''}.</div>`; return; }
  el.innerHTML = rows.map(r => nodeRowHTML(r, { canEdit, inSheet, wires: inSheet ? nodeWires(it.id, r.id) : [] })).join('');
}
/* V3.859 — a library paper without a stored PDF (98 of the 242 in the lab's library on 2026-10-23). The card used to
   stop at "No PDF in the library"; now it re-checks the library (the reader may have fetched one since the card was
   made), and offers the reader's own two ways to get one: the server's open-access fetch, or an upload. */
const PDF_SEEN = new Map();   // paperId → { path, at }
async function livePdf(paperId, fresh) {
  const c = PDF_SEEN.get(paperId); if (!fresh && c && Date.now() - c.at < 30e3) return c.path;
  let path = '';
  try { const snap = await db().collection('items').doc(paperId).get(); const x = (snap && snap.exists && snap.data()) || {}; const lib = (x.meta && x.meta.library) || {}; path = (lib.pdf && lib.pdf.storage_path) || ''; } catch (e) {}
  PDF_SEEN.set(paperId, { path, at: Date.now() });
  return path;
}
async function setLibraryPdf(paperId, info) {
  const FV = window.firebase.firestore.FieldValue;
  await db().collection('items').doc(paperId).update({ 'meta.library.pdf': info, updated_at: new Date().toISOString().slice(0, 10), updatedAt: FV.serverTimestamp() });
  try { if (window.api && window.api.invalidate) { window.api.invalidate('items.json'); window.api.invalidate('library/papers.json'); } } catch (e) {}
  PDF_SEEN.set(paperId, { path: info.storage_path, at: Date.now() });
  LIB = null; try { sessionStorage.removeItem(LIB_KEY); } catch (e) {}
}
function noPdfBoxHTML(canEdit) {
  const up = !!window.LIBRARY_UPLOAD;
  return `<div class="cpr-nopdf-box" data-cpr-nopdf>
      <div class="cpr-nopdf-t">No PDF for this paper yet</div>
      <div class="cpr-nopdf-s">It is in the library, and its highlights and figures still connect. ${canEdit && up ? 'Get the PDF to read it here:' : 'Open it in the reader to add the PDF.'}</div>
      ${canEdit && up ? `<div class="cpr-nopdf-acts"><button type="button" class="cpr-btn cpr-btn-primary" data-cpr-findpdf>⤓ Find an open-access PDF</button><button type="button" class="cpr-btn" data-cpr-uppdf>${ICON.svg('arrow-up')} Upload the PDF</button></div>` : ''}
      <div class="cpr-nopdf-msg" data-cpr-nopdf-msg hidden></div>
    </div>`;
}
function wireNoPdf(it, body, api) {
  const d = it.data || {}; const box = body.querySelector('[data-cpr-nopdf]'); if (!box) return;
  const msg = box.querySelector('[data-cpr-nopdf-msg]');
  const say = (t, bad) => { msg.textContent = t; msg.hidden = !t; msg.classList.toggle('cpr-err', !!bad); };
  const adoptPath = async (path) => { await api.save({ data: Object.assign({}, it.data || {}, { pdf: path }) }); api.refresh(); toast('success', 'The PDF is in — press Read.'); };
  /* the library may already have it */
  livePdf(d.paperId).then(path => { if (path && body.isConnected && api.canEdit()) adoptPath(path); });
  const find = box.querySelector('[data-cpr-findpdf]'), upl = box.querySelector('[data-cpr-uppdf]');
  if (find) find.addEventListener('click', async () => {
    find.disabled = true; find.textContent = 'Looking…'; say('');
    try {
      const fresh = await livePdf(d.paperId, true); if (fresh) { await adoptPath(fresh); return; }
      const snap = await db().collection('items').doc(d.paperId).get();
      const item = Object.assign({ id: d.paperId }, (snap && snap.exists && snap.data()) || {});
      const out = await window.LIBRARY_UPLOAD.serverFetchPdf(item);
      if (out && out.ok && out.storage_path) {
        const u = me();
        await setLibraryPdf(d.paperId, { storage_path: out.storage_path, hash: out.hash || '', filename_safe: `${d.paperId}.pdf`, size_bytes: out.size_bytes || 0, uploaded_at: new Date().toISOString().slice(0, 10), uploaded_by: u.email || '', source: out.source ? `oa_${out.source}` : 'oa_auto' });
        await adoptPath(out.storage_path); return;
      }
      say(((out && out.error) || 'No open-access copy was found.') + ' Upload the PDF instead.', true);
    } catch (e) { say('The search for a PDF failed: ' + (e.message || e) + ' — upload it instead.', true); }
    find.disabled = false; find.textContent = '⤓ Find an open-access PDF';
  });
  if (upl) upl.addEventListener('click', () => {
    const inp = document.createElement('input'); inp.type = 'file'; inp.accept = 'application/pdf,.pdf'; inp.style.display = 'none';
    inp.addEventListener('change', async () => {
      const f = inp.files && inp.files[0]; inp.remove(); if (!f) return;
      if (!/pdf$/i.test(f.type || '') && !/\.pdf$/i.test(f.name || '')) { say('That is not a PDF.', true); return; }
      upl.disabled = true; upl.textContent = 'Uploading…'; say('');
      try {
        const info = await window.LIBRARY_UPLOAD.uploadPdf(d.paperId, f);
        await setLibraryPdf(d.paperId, { storage_path: info.storage_path, hash: info.hash || '', filename_safe: `${d.paperId}.pdf`, size_bytes: info.size_bytes || f.size || 0, uploaded_at: info.uploaded_at || new Date().toISOString().slice(0, 10), uploaded_by: info.uploaded_by || me().email || '' });
        await adoptPath(info.storage_path);
      } catch (e) { upl.disabled = false; ICON.label(upl, 'arrow-up', ' Upload the PDF'); say('The upload failed: ' + (e.message || e), true); }
    });
    document.body.appendChild(inp); inp.click();
  });
}
function renderPaper(it, body, api) {
  const d = it.data || (it.data = {}); const ro = !api.canEdit();
  if (!d.paperId) { if (ro) { body.innerHTML = '<div class="nbk-pick-empty">No paper chosen.</div>'; return; } renderLibraryPick(it, body, api); return; }
  const inSheet = !!api.inSheet;
  const showTitle = (it.title || '').trim() !== (d.title || '').trim();   /* the card's name usually IS the paper's title */
  body.innerHTML = `<div class="cpr-card${inSheet ? ' cpr-insheet' : ''}">
    <div class="cpr-top">${showTitle ? `<div class="cpr-ptitle">${esc(d.title || '(untitled)')}</div>` : ''}<div class="cpr-pcite"><span>${esc(d.cite || '')}${d.journal ? ' · ' + esc(d.journal) : ''}</span><a class="cpr-plink" href="${readerUrl(d.paperId)}" target="_blank" rel="noopener" title="Open in the full paper reader">reader ↗</a></div></div>
    <div class="cpr-cardacts">${d.pdf ? '<button type="button" class="cpr-btn cpr-btn-primary cpr-read" data-cpr-read><span class="cpr-read-ic" aria-hidden="true">' + ICON.svg('book-open') + '</span>Read</button>' : ''}<span class="cpr-counts" data-cpr-counts>…</span></div>
    ${d.pdf ? '' : noPdfBoxHTML(api.canEdit())}
    <div class="cpr-nodes" data-cpr-nodes><div class="cpr-empty">Loading highlights…</div></div>
  </div>`;
  const read = body.querySelector('[data-cpr-read]'); if (read) read.addEventListener('click', () => openReader(it, api));
  if (!d.pdf) wireNoPdf(it, body, api);   /* V3.859 — the paper is in the library but has no PDF yet: re-check, find one, or upload one */
  const nodesEl = body.querySelector('[data-cpr-nodes]'), counts = body.querySelector('[data-cpr-counts]');
  const old = CARD_SUBS.get(it.id + (inSheet ? ':sheet' : '')); if (old) old();
  const un = watch(d.paperId, (rows) => {
    if (!nodesEl.isConnected) { un(); return; }
    drawNodes(it, nodesEl, rows, api); counts.textContent = countsText(rows);
    const I = inst(); if (I && I.redrawWires) { try { I.redrawWires(); } catch (e) {} }
  });
  CARD_SUBS.set(it.id + (inSheet ? ':sheet' : ''), un);
  nodesEl.addEventListener('click', (e) => {
    const chip = e.target.closest('[data-cpr-chip]'); if (chip) { e.stopPropagation(); const w = (inst() && inst().getWires().find(x => x.id === chip.dataset.cprChip)) || null; relMenu(chip, chip.dataset.cprChip, w && w.rel, { remove: true }); return; }
    const link = e.target.closest('[data-cpr-link]');
    if (link) { e.stopPropagation(); const s = SUBS.get(d.paperId); const row = s && s.rows.find(r => r.id === link.dataset.cprLink); if (row) pickTarget(link, it, row); return; }
    if (e.target.closest('[data-wb-port]')) return;
    const row = e.target.closest('.cpr-node'); if (row && d.pdf) openReader(it, api, { focus: row.dataset.cprAnn });
  });
}
function paperSummary(it) { const d = (it && it.data) || {}; return d.paperId ? `${d.title || 'Paper'} — ${d.cite || ''}` : 'Paper (none chosen)'; }

/* ─── the reader overlay ───────────────────────────────────────────── */
function pdfUrlFor(path) {
  if (/^(https?:)?\/\//.test(path) || path.startsWith('/') || path.startsWith('blob:') || path.startsWith('data:')) return Promise.resolve(path);
  const isLocal = /^(localhost|127\.0\.0\.1)$/.test(location.hostname);
  return firebase.storage().ref().child(path).getDownloadURL().then(u => isLocal ? '/api/library/pdf-proxy?url=' + encodeURIComponent(u) : u);
}
function sideEl(sel) { return R && R.el ? R.el.querySelector(sel) : null; }
function openSide(on) {
  if (!R) return;
  R.el.classList.toggle('cpr-side-closed', !on);
  const b = sideEl('[data-cpr="side"]'); if (b) b.setAttribute('aria-pressed', on ? 'true' : 'false');
  clearTimeout(R.refit); R.refit = setTimeout(() => { if (R && R.viewer && R.viewer.fitToWidth && !R.el.classList.contains('cpr-narrow')) R.viewer.fitToWidth().then(() => redraw()).catch(() => {}); }, 240);
}
function redraw() { try { window.ANNOTATION_OVERLAY && window.ANNOTATION_OVERLAY.redraw(); } catch (e) {} }
async function openReader(it, api, opts) {
  const d = (it && it.data) || {}; if (!d.paperId) return;
  closeReader();
  const I = inst(); try { I && I.closeItem && I.closeItem(); } catch (e) {}
  const narrow = window.matchMedia && window.matchMedia('(max-width: 699px)').matches;
  const el = document.createElement('div'); el.className = 'cpr-reader' + (narrow ? ' cpr-narrow cpr-side-closed' : '');
  el.setAttribute('role', 'dialog'); el.setAttribute('aria-modal', 'true'); el.setAttribute('aria-label', 'Paper reader');
  const canEdit = !!(api && api.canEdit && api.canEdit());
  el.innerHTML = `
    <div class="cpr-topbar">
      <div class="cpr-bar-title"><b>${esc(d.title || 'Paper')}</b><span>${esc(d.cite || '')}${d.journal ? ' · ' + esc(d.journal) : ''}</span></div>
      <div class="cpr-bar-tools">
        <span class="cpr-page" data-cpr-page aria-live="polite">–</span>
        <span class="cpr-tbgroup" role="group" aria-label="Zoom">
          <button type="button" class="cpr-tb" data-cpr="zoom-out" title="Zoom out" aria-label="Zoom out">−</button>
          <button type="button" class="cpr-tb" data-cpr="zoom-in" title="Zoom in" aria-label="Zoom in">+</button>
          <button type="button" class="cpr-tb cpr-tb-fit" data-cpr="fit" title="Fit the page to the width">Fit</button>
        </span>
        ${canEdit ? '<button type="button" class="cpr-tb cpr-tb-snip" data-cpr="snip" aria-pressed="false" title="Snip mode: drag a box over a figure to snip it"><span aria-hidden="true">⬚</span><span class="cpr-tb-label">Snip</span></button>' : ''}
        <button type="button" class="cpr-tb" data-cpr="side" aria-pressed="${narrow ? 'false' : 'true'}" title="Show or hide the highlights & figures window"><span aria-hidden="true">☰</span><span class="cpr-tb-label">Highlights &amp; figures</span></button>
        <a class="cpr-tb cpr-tb-link" href="${readerUrl(d.paperId)}" target="_blank" rel="noopener" title="Open this paper in the full paper reader">Open in the reader ↗</a>
        <button type="button" class="cpr-tb cpr-close" data-cpr="close" title="Close (Esc)"><span aria-hidden="true">✕</span><span class="cpr-tb-label">Close</span></button>
      </div>
    </div>
    <div class="cpr-main">
      <div class="cpr-pages" data-cpr-pages><div class="cpr-status">Opening the PDF…</div></div>
      <button type="button" class="cpr-side-tab" data-cpr="side-open" title="Show the highlights & figures window" aria-label="Show the highlights and figures">‹ Highlights &amp; figures</button>
      <aside class="cpr-side" data-cpr-side aria-label="Highlights and figures">
        <div class="cpr-side-head"><b>Highlights &amp; figures</b><button type="button" class="cpr-tb" data-cpr="side-close" title="Collapse this window" aria-label="Collapse">›</button></div>
        <div class="cpr-tools">
          ${canEdit ? `<div class="cpr-legend" aria-label="Highlight colours">${colors().map(c => `<span class="cpr-lg" title="${esc(c.meaning || c.name)}"><i style="background:${c.hex}"></i>${esc(c.name)}</span>`).join('')}</div>
          <p class="cpr-hint">Select text, then pick a colour to highlight it. Click a figure — or <b>⬚ Snip</b> and drag a box — to snip it. <b>⤳</b> on a row connects it to a collection or a claim.</p>` : '<p class="cpr-hint">Read along with the lab\'s highlights; making highlights needs lab-member access.</p>'}
        </div>
        <div class="cpr-snipform" data-cpr-snipform hidden></div>
        <div class="cpr-side-list" data-cpr-list><div class="cpr-empty">Loading…</div></div>
      </aside>
    </div>`;
  document.body.appendChild(el);
  R = { el, item: it, api, paperId: d.paperId, viewer: null, unsub: null, rows: [], raw: [], snip: false, snipPending: null, focusId: (opts && opts.focus) || null, key: null, refit: null, canEdit };
  R.key = (e) => { if (e.key === 'Escape' && R && R.el === el) { if (document.querySelector('.ann-popover, .cw-pop')) return; e.preventDefault(); e.stopPropagation(); closeReader(); } };
  document.addEventListener('keydown', R.key, true);
  ['pointerdown', 'pointerup', 'pointermove', 'wheel', 'keydown', 'keyup', 'touchstart', 'touchmove'].forEach(t => el.addEventListener(t, (e) => e.stopPropagation()));
  el.addEventListener('click', (e) => {
    const b = e.target.closest('[data-cpr]'); if (b) { onReaderAction(b.dataset.cpr, b); return; }
    const chip = e.target.closest('[data-cpr-chip]'); if (chip) { const w = (inst() && inst().getWires().find(x => x.id === chip.dataset.cprChip)) || null; relMenu(chip, chip.dataset.cprChip, w && w.rel, { remove: true }); return; }
    const link = e.target.closest('[data-cpr-link]'); if (link) { const row = R.rows.find(r => r.id === link.dataset.cprLink); if (row) pickTarget(link, R.item, row); return; }
    const del = e.target.closest('[data-cpr-del]'); if (del) { const row = R.rows.find(r => r.id === del.dataset.cprDel); if (!row) return; if (!armTwoTap(del, 'Delete?')) return; deleteAnn(R.paperId, row).then(() => toast('success', 'Deleted.')).catch(err => toast('error', 'Could not delete: ' + (err.message || err))); return; }
    const sf = e.target.closest('[data-sf]'); if (sf) { onSnipFormAction(sf.dataset.sf); return; }
    const row = e.target.closest('.cpr-srow'); if (row) { focusAnn(row.dataset.cprAnn); }
  });
  R.unsub = watch(d.paperId, (rows, raw) => {
    if (!R || R.el !== el) return;
    R.rows = rows; R.raw = raw; drawSideList();
    if (R.viewer && window.ANNOTATION_OVERLAY) { try { window.ANNOTATION_OVERLAY.setAnnotations(raw); } catch (e) {} }
  });
  if (!d.pdf) { sideEl('[data-cpr-pages]').innerHTML = '<div class="cpr-status">This paper has no PDF in the library — its highlights and figures are listed on the right.</div>'; return; }
  await mountViewer(d);
}
async function mountViewer(d) {
  const pages = sideEl('[data-cpr-pages]'); if (!pages || !R) return;
  if (!window.PDF_VIEWER || !window.PDF_VIEWER.create) { pages.innerHTML = '<div class="cpr-status cpr-err">The PDF viewer did not load.</div>'; return; }
  let url;
  try { url = await pdfUrlFor(d.pdf); } catch (e) { pages.innerHTML = `<div class="cpr-status cpr-err">Could not fetch the PDF: ${esc(e.message || e)}</div>`; return; }
  if (!R || R.paperId !== d.paperId) return;
  const el = R.el;
  try {
    pages.innerHTML = '';
    const v = await window.PDF_VIEWER.create(pages, url, {
      fitToContainer: true, disableRange: true, disableStream: true,
      onPageChange: (p) => { const l = sideEl('[data-cpr-page]'); if (l && R && R.viewer) l.textContent = `${p} / ${R.viewer.numPages}`; },
      onPageReady: (p) => { if (!R || R.el !== el) return; try { window.ANNOTATION_OVERLAY && window.ANNOTATION_OVERLAY.redrawPage(p); } catch (e) {} if (R.canEdit) refreshHotspots(p); }
    });
    if (!R || R.el !== el) { try { v.destroy(); } catch (e) {} return; }
    R.viewer = v;
    const l = sideEl('[data-cpr-page]'); if (l) l.textContent = `1 / ${v.numPages}`;
    if (window.ANNOTATION_OVERLAY) {
      window.ANNOTATION_OVERLAY.init({
        viewer: v, container: pages, getColors: () => colors(),
        onCreate: async ({ anchors, colorId, comment }) => {
          const c = colors().find(x => x.id === colorId); const flags = (c && c.auto_flags) || [];
          const id = await createAnn(R.paperId, { color_id: colorId, annotation_type: typeFor(colorId), visibility: 'lab', comment: (typeof comment === 'string') ? comment.trim() : '', target: { pages: anchors }, marked_for_investigation: flags.includes('marked_for_investigation') }, d.title);
          R.focusId = id; openSide(true);
          return id;
        },
        onAnnotationClick: (id) => focusAnn(id, { scroll: false }),
        onCaptureFigure: ({ anchors }) => startSnip(anchors, '')
      });
      try { window.ANNOTATION_OVERLAY.setAnnotations(R.raw); } catch (e) {}
    }
    if (window.GEOM_SELECTION) {
      window.GEOM_SELECTION.init({ viewer: v, viewerEl: pages, onCommit: (anchors) => {
        if (!R) return;
        if (!anchors || !anchors.length) { return; }
        if (!R.canEdit) return;
        if (anchors[0].marquee) { startSnip(anchors, ''); return; }
        window.ANNOTATION_OVERLAY && window.ANNOTATION_OVERLAY.onSelectionCommit(anchors);
      } });
    }
    if (R.focusId) setTimeout(() => { if (R && R.viewer === v) focusAnn(R.focusId); }, 400);
  } catch (e) { console.warn('[canvas-paper-reader] viewer', e); pages.innerHTML = `<div class="cpr-status cpr-err">The PDF could not be opened: ${esc(e.message || e)}</div>`; }
}
function onReaderAction(act, btn) {
  if (!R) return;
  const v = R.viewer;
  if (act === 'close') { closeReader(); return; }
  if (act === 'zoom-in' && v) { Promise.resolve(v.zoomIn()).then(redraw); return; }
  if (act === 'zoom-out' && v) { Promise.resolve(v.zoomOut()).then(redraw); return; }
  if (act === 'fit' && v && v.fitToWidth) { v.fitToWidth().then(redraw).catch(() => {}); return; }
  if (act === 'side') { openSide(R.el.classList.contains('cpr-side-closed')); return; }
  if (act === 'side-open') { openSide(true); return; }
  if (act === 'side-close') { openSide(false); return; }
  if (act === 'snip') { R.snip = !R.snip; btn.setAttribute('aria-pressed', R.snip ? 'true' : 'false'); R.el.classList.toggle('cpr-snipping', R.snip); try { window.GEOM_SELECTION && window.GEOM_SELECTION.setMarquee(R.snip); } catch (e) {} if (R.snip) toast('info', 'Drag a box around a figure to snip it.'); return; }
}
function focusAnn(id, o) {
  if (!R) return;
  R.focusId = id; drawSideList();
  try { if (R.viewer && window.ANNOTATION_OVERLAY) window.ANNOTATION_OVERLAY.focus(id); } catch (e) {}
  const row = sideEl(`.cpr-srow[data-cpr-ann="${id}"]`); if (row && !(o && o.scroll === false)) { try { row.scrollIntoView({ block: 'nearest' }); } catch (e) {} }
}
function drawSideList() {
  const list = sideEl('[data-cpr-list]'); if (!list || !R) return;
  const hls = R.rows.filter(r => r.type === 'highlight'), figs = R.rows.filter(r => r.type === 'figure');
  const row = (r) => { const wires = nodeWires(R.item.id, r.id); return `<div class="cpr-srow${R.focusId === r.id ? ' cpr-srow-on' : ''}" data-cpr-ann="${esc(r.id)}">
      <span class="cpr-bar" style="background:${r.hex}"></span>
      ${r.type === 'figure' && (r.thumb || r.url) ? `<img class="cpr-thumb" src="${esc(r.thumb || r.url)}" alt="" draggable="false">` : ''}
      <div class="cpr-stext">${r.type === 'figure' ? ICON.svg('photo') + ' ' + esc(r.name || 'Figure') : esc(r.quote)}<small>${r.page ? 'p. ' + r.page : ''}${r.comment ? ' · ' + esc(r.comment) : ''}${r.mine ? '' : (r.by ? ' · ' + esc(r.by) : '')}</small>
        <div class="cpr-slinks">${wires.length ? wires.map(relChip).join('') : (R.canEdit ? '<span class="cpr-nolink">not connected yet</span>' : '')}</div></div>
      <div class="cpr-sacts">${R.canEdit ? `<button type="button" class="cpr-link" data-cpr-link="${esc(r.id)}" title="Connect to a collection or claim…" aria-label="Connect">⤳</button>` : ''}${r.mine ? `<button type="button" class="cpr-del" data-cpr-del="${esc(r.id)}" title="Delete this ${r.type} (two taps)" aria-label="Delete">×</button>` : ''}</div>
    </div>`; };
  list.innerHTML = `<div class="cpr-sgroup">Highlights (${hls.length})</div>${hls.map(row).join('') || `<div class="cpr-empty">${R.canEdit ? 'Select text on the page, then pick a colour.' : 'No highlights yet.'}</div>`}
    <div class="cpr-sgroup">Figures (${figs.length})</div>${figs.map(row).join('') || `<div class="cpr-empty">${R.canEdit ? 'Click a figure on the page, or ⬚ Snip and drag a box.' : 'No snipped figures yet.'}</div>`}`;
}
/* snipping: the region from the rendered page canvas (FIGURE_CAPTURE's routine, without its alert()s) */
function snipFromAnchors(viewer, anchors) {
  return new Promise((resolve) => {
    try {
      const a = anchors && anchors[0];
      if (!a || !a.rects || !a.rects.length || !viewer || !viewer.getPageNode) return resolve(null);
      const node = viewer.getPageNode(a.page);
      if (!node || !node.canvas || !node.wrap) return resolve(null);
      let x0 = Infinity, y0 = Infinity, x1 = -Infinity, y1 = -Infinity;
      const k0 = (typeof a.saved_scale === 'number' && a.saved_scale > 0) ? (viewer.zoom / a.saved_scale) : 1;
      a.rects.forEach(r => { x0 = Math.min(x0, r.x * k0); y0 = Math.min(y0, r.y * k0); x1 = Math.max(x1, (r.x + r.width) * k0); y1 = Math.max(y1, (r.y + r.height) * k0); });
      const pad = 6; x0 = Math.max(0, x0 - pad); y0 = Math.max(0, y0 - pad); x1 += pad; y1 += pad;
      const cssW = node.wrap.clientWidth || 1; const k = node.canvas.width / cssW;
      const sx = x0 * k, sy = y0 * k; let sw = (x1 - x0) * k, sh = (y1 - y0) * k;
      sw = Math.min(sw, node.canvas.width - sx); sh = Math.min(sh, node.canvas.height - sy);
      if (sw <= 2 || sh <= 2) return resolve(null);
      const outW = Math.min(1200, Math.round(sw)), outH = Math.max(1, Math.round(sh * (outW / sw)));
      const off = document.createElement('canvas'); off.width = outW; off.height = outH;
      const ctx = off.getContext('2d'); ctx.fillStyle = '#fff'; ctx.fillRect(0, 0, outW, outH); ctx.drawImage(node.canvas, sx, sy, sw, sh, 0, 0, outW, outH);
      const tW = Math.min(240, outW), tH = Math.max(1, Math.round(outH * (tW / outW)));
      const toff = document.createElement('canvas'); toff.width = tW; toff.height = tH; toff.getContext('2d').drawImage(off, 0, 0, tW, tH);
      const thumb = toff.toDataURL('image/jpeg', 0.8), preview = off.toDataURL('image/jpeg', 0.85);
      off.toBlob(blob => resolve(blob ? { blob, thumb, preview, w: outW, h: outH } : null), 'image/jpeg', 0.9);
    } catch (e) { console.warn('[canvas-paper-reader] snip', e); resolve(null); }
  });
}
async function startSnip(anchors, name) {
  if (!R || !R.viewer) return;
  const snip = await snipFromAnchors(R.viewer, anchors);
  if (!snip) { toast('error', 'Could not snip that region — try dragging a box around the figure.'); return; }
  R.snipPending = { anchors, snip };
  openSide(true);
  const f = sideEl('[data-cpr-snipform]'); if (!f) return;
  f.hidden = false;
  f.innerHTML = `<div class="cpr-sf-head">Snip a figure</div><img class="cpr-sf-prev" src="${snip.preview}" alt="The snipped region">
    <input type="text" class="cpr-sf-in" data-sf-name placeholder="Name (e.g. Figure 3)" value="${esc(name || '')}" aria-label="Figure name">
    <input type="text" class="cpr-sf-in" data-sf-note placeholder="Why it matters (optional)" aria-label="Note">
    <div class="cpr-sf-acts"><button type="button" class="cpr-btn cpr-btn-primary" data-sf="save">Save the snip</button><button type="button" class="cpr-btn" data-sf="cancel">Cancel</button></div><div class="cpr-sf-err" data-sf-err hidden></div>`;
  setTimeout(() => CANVAS_WIDGETS.autoFocus(f.querySelector('[data-sf-name]')), 30);
}
async function onSnipFormAction(act) {
  const f = sideEl('[data-cpr-snipform]'); if (!f || !R) return;
  const clear = () => { f.hidden = true; f.innerHTML = ''; R.snipPending = null; try { window.GEOM_SELECTION && window.GEOM_SELECTION.clear(); } catch (e) {} };
  if (act === 'cancel') { clear(); return; }
  if (act !== 'save' || !R.snipPending) return;
  const err = f.querySelector('[data-sf-err]'); const save = f.querySelector('[data-sf="save"]');
  const name = (f.querySelector('[data-sf-name]').value || '').trim(), note = (f.querySelector('[data-sf-note]').value || '').trim();
  if (!window.PAPER_FIGURES || !window.PAPER_FIGURES.uploadImage) { err.textContent = 'Uploads are not available on this page.'; err.hidden = false; return; }
  save.disabled = true; save.textContent = 'Uploading…'; err.hidden = true;
  try {
    const { anchors, snip } = R.snipPending;
    const up = await window.PAPER_FIGURES.uploadImage(R.paperId, snip.blob);
    const id = await createAnn(R.paperId, { kind: 'figure', annotation_type: 'figure', color_id: 'yellow', visibility: 'lab', name: name || 'Figure', image: { storage_path: up.storage_path, download_url: up.download_url }, snip_data_uri: snip.thumb, comment: note, target: { pages: anchors } }, R.item && R.item.data && R.item.data.title);
    R.focusId = id; clear(); toast('success', `Snipped “${name || 'Figure'}” — it is on the paper card with a node.`);
  } catch (e) { save.disabled = false; save.textContent = 'Save the snip'; err.textContent = 'Could not save: ' + (e.message || e); err.hidden = false; }
}
/* click-to-snip hotspots over the viewer's detected figure regions */
function refreshHotspots(pageNum) {
  const v = R && R.viewer; if (!v || !v.getPageNode || !v.getFigureRegions) return;
  const node = v.getPageNode(pageNum); if (!node || !node.wrap) return;
  let regions = []; try { regions = v.getFigureRegions(pageNum) || []; } catch (e) { regions = []; }
  let layer = node.wrap.querySelector('.cpr-hs-layer');
  if (!regions.length) { if (layer) layer.remove(); return; }
  if (!layer) { layer = document.createElement('div'); layer.className = 'cpr-hs-layer'; node.wrap.appendChild(layer); }
  layer.innerHTML = '';
  regions.forEach(r => {
    const hs = document.createElement('div'); hs.className = 'cpr-hs';
    hs.style.left = r.x + 'px'; hs.style.top = r.y + 'px'; hs.style.width = r.width + 'px'; hs.style.height = r.height + 'px';
    const m = (r.label || '').match(/^\s*((?:extended\s+data\s+|supp(?:lementary)?\.?\s*)?(?:fig(?:ure)?|table|scheme)\.?\s*S?\d+)/i);
    const short = m ? m[1].replace(/\s+/g, ' ').trim() : '';
    hs.title = (r.label ? r.label + '\n' : '') + 'Click to snip this figure';
    const badge = document.createElement('span'); badge.className = 'cpr-hs-badge'; ICON.label(badge, 'scissors', ' ' + (short || 'Snip')); hs.appendChild(badge);
    let down = null;
    hs.addEventListener('pointerdown', (e) => { down = { x: e.clientX, y: e.clientY }; e.stopPropagation(); });
    hs.addEventListener('click', (e) => { const dd = down; down = null; if (!dd || Math.hypot(e.clientX - dd.x, e.clientY - dd.y) > 6) return; e.preventDefault(); e.stopPropagation(); startSnip([{ page: pageNum, rects: [{ x: r.x, y: r.y, width: r.width, height: r.height }], saved_scale: v.zoom, marquee: true }], short); });
    layer.appendChild(hs);
  });
}
function closeReader() {
  if (!R) return;
  const r = R; R = null;
  try { document.removeEventListener('keydown', r.key, true); } catch (e) {}
  try { window.GEOM_SELECTION && window.GEOM_SELECTION.destroy(); } catch (e) {}
  try { window.ANNOTATION_OVERLAY && window.ANNOTATION_OVERLAY.destroy(); } catch (e) {}
  try { r.viewer && r.viewer.destroy(); } catch (e) {}
  try { r.unsub && r.unsub(); } catch (e) {}
  clearTimeout(r.refit);
  try { r.el.remove(); } catch (e) {}
}

/* ─── 📑 the collection card: a quote, a list, a claim ─────────────── */
function groupEntries(list) {
  const order = NODE_RELS.map(r => r.id); const groups = [];
  const by = new Map();
  (list || []).forEach(e => { const k = relOf(e.rel) ? e.rel : 'informs'; if (!by.has(k)) by.set(k, []); by.get(k).push(e); });
  order.forEach(k => { if (by.has(k)) groups.push({ rel: relOf(k), rows: by.get(k) }); });
  return groups;
}
function entryRowHTML(e, canEdit) {
  const r = relOf(e.rel) || relOf('informs');
  const clip = (s, n) => (s.length > n ? s.slice(0, n - 2) + '…' : s);
  let text;
  if (e.type === 'quote' && canEdit) text = `<textarea class="cpr-qin" data-qtext="${esc(e.id)}" rows="2" placeholder="The passage, in the authors' words…" aria-label="The passage">${esc(e.quote || '')}</textarea><input type="text" class="cpr-qcite" data-qcite="${esc(e.id)}" value="${esc(e.cite || '')}" placeholder="Citation — Smith et al., 2020, p. 4" aria-label="Citation">`;
  else if (e.type === 'card') text = `${ICON.render(e.glyph || '•')} ${esc(e.name || 'Card')}${e.quote ? ` — “${esc(clip(e.quote, 160))}”` : ''}`;
  else if (e.type === 'figure') text = `${ICON.svg('photo')} ${esc(e.name || 'Figure')}`;
  else text = `“${esc(clip(String(e.quote || ''), 240))}”`;
  const meta = (e.type === 'quote' && canEdit) ? '' : esc(e.cite || e.paperTitle || '');
  const link = e.paperId ? `<a href="${readerUrl(e.paperId, e.annId)}" target="_blank" rel="noopener">reader ↗</a>` : '';
  const img = (e.type === 'figure' || (e.type === 'card' && e.url)) ? (e.thumb || e.url) : '';
  return `<div class="cpr-crow cpr-crow-${esc(e.type)}" data-cpr-entry="${esc(e.id)}">
      <span class="cpr-bar" style="background:${esc(e.hex || '#64748b')}"></span>
      ${img ? `<img class="cpr-thumb" src="${esc(img)}" alt="" draggable="false">` : ''}
      <div class="cpr-ctext">${text}${meta || link ? `<small>${meta}${meta && link ? ' · ' : ''}${link}</small>` : ''}</div>
      ${canEdit ? `<button type="button" class="cpr-chip cpr-chip-rel" data-cpr-erel="${esc(e.id)}" style="--chip:${r.hex}" title="Change the connection type">${esc(r.label)}</button><button type="button" class="cpr-x" data-cpr-unlink="${esc(e.id)}" title="Take it out of this collection (and its connection)" aria-label="Remove">×</button>` : ''}
    </div>`;
}
function paperRowHTML(e, canEdit) {
  return `<div class="cpr-prow" data-pid="${esc(e.paperId)}" data-cpr-entry="${esc(e.id)}">
      <span class="cpr-bar" style="background:${PAPER_HEX}"></span>
      <div class="cpr-ptext"><a class="cpr-ptitle-a" href="${readerUrl(e.paperId)}" target="_blank" rel="noopener" title="Open in the paper reader">${esc(e.title || 'Untitled paper')}</a><small>${esc([e.cite, e.journal].filter(Boolean).join(' · '))}</small>
        ${canEdit ? `<input type="text" class="cpr-why" data-why="${esc(e.id)}" value="${esc(e.why || '')}" placeholder="Why it matters here…" aria-label="Why this paper matters">` : (e.why ? `<div class="cpr-why-ro">${esc(e.why)}</div>` : '')}
      </div>
      ${canEdit ? `<button type="button" class="cpr-x" data-cpr-unlink="${esc(e.id)}" title="Take it out of this collection" aria-label="Remove">×</button>` : ''}
    </div>`;
}
function isQuoteShape(d) {
  const list = d.items || [];
  return d.shape === 'quote' && list.length === 1 && (list[0].type === 'quote' || list[0].type === 'highlight') && !(d.keyPoints || []).length && !String(d.notes_html || '').trim() && !d.claim && !d.claimSetup;
}
/* a one-passage collection reads as the quote card it replaced */
function renderQuoteShape(it, body, api, e, commit) {
  const canEdit = api.canEdit();
  const link = e.paperId ? `<a class="cpr-plink" href="${readerUrl(e.paperId, e.annId)}" target="_blank" rel="noopener" title="Open the paper at this passage">reader ↗</a>` : '';
  if (e.type === 'quote' && canEdit) {
    body.innerHTML = `<div class="cpr-qcard"><textarea class="nbc-quote-in cpr-qcard-in" rows="3" placeholder="The passage, in the authors' words…" aria-label="The passage">${esc(e.quote || '')}</textarea><div class="cpr-qcard-foot"><input type="text" class="nbc-cite-in cpr-qcard-cite" value="${esc(e.cite || '')}" placeholder="Citation — Smith et al., 2020, p. 4" aria-label="Citation">${link}</div></div>`;
    const ta = body.querySelector('.cpr-qcard-in'), ci = body.querySelector('.cpr-qcard-cite'); let t = null;
    let last = [e.quote || '', e.cite || ''];
    const save = () => { const v = [ta.value, ci.value]; if (v[0] === last[0] && v[1] === last[1]) return; last = v; commit(cd => ({ items: (cd.items || []).map(x => x.id === e.id ? Object.assign({}, x, { quote: v[0], cite: v[1] }) : x) })); };
    [ta, ci].forEach(el => { el.addEventListener('input', () => { clearTimeout(t); t = setTimeout(save, 400); }); el.addEventListener('blur', () => { clearTimeout(t); save(); }); });
    return;
  }
  body.innerHTML = `<figure class="cpr-qcard"><blockquote class="cpr-qcard-text" style="--q:${esc(e.hex || QUOTE_HEX)}">${esc(e.quote || '')}</blockquote>${e.cite || link ? `<figcaption class="cpr-qcard-foot"><span>${esc(e.cite || '')}</span>${link}</figcaption>` : ''}</figure>`;
}
function renderCollection(it, body, api) {
  const conv = asCollection(it); const d = conv.data; const list = d.items;
  const canEdit = api.canEdit(); const claim = d.claim || null;
  const commit = committer(it);
  if (isQuoteShape(d)) { renderQuoteShape(it, body, api, list[0], commit); return; }
  const kp = d.keyPoints || [];
  const papers = list.filter(e => e.type === 'paper'), rest = list.filter(e => e.type !== 'paper');
  const groups = groupEntries(rest);
  const drafts = d.drafts || [];
  const showNotes = !!String(d.notes_html || '').replace(/<[^>]*>/g, '').trim() || body.dataset.cprNotes === '1';
  const empty = !list.length && !kp.length && !showNotes;
  const forN = list.filter(e => stanceOf(e.rel) === 'for').length, againstN = list.filter(e => stanceOf(e.rel) === 'against').length;
  body.innerHTML = `<div class="cpr-coll${claim ? ' cpr-isclaim' : ''}">
    ${conv.rest.length && canEdit ? `<div class="cpr-split"><span>${ICON.svg('books')} This lit review has ${conv.rest.length + 1} sections — ${esc([conv.firstTitle || 'Papers'].concat(conv.rest.map(r => r.title)).join(', '))}.</span><button type="button" class="cpr-mini" data-cpr-split>Split into ${conv.rest.length + 1} collections</button></div>` : ''}
    ${claim ? `<div class="cpr-claimhead"><span class="cpr-claimbadge">◆ Claim</span><span class="cpr-claimdraft" title="${esc(claim.draftTitle || '')}">${esc(claim.draftTitle || 'a paper draft')}</span><span class="cpr-claimcounts"><i class="cpr-dot cpr-dot-for"></i>${forN} for <i class="cpr-dot cpr-dot-against"></i>${againstN} against</span></div>` : ''}
    ${drafts.length ? `<div class="cpr-drafts"><span class="cpr-drafts-lbl">Linked to</span>${drafts.map(x => `<span class="cpr-dchip" title="${esc(x.title || '')}"><span class="cpr-dchip-t">✎ ${esc(x.title || 'a draft')}</span>${canEdit ? `<button type="button" class="cpr-dx" data-cpr-undraft="${esc(x.id)}" aria-label="Unlink ${esc(x.title || 'this draft')}" title="Unlink">×</button>` : ''}</span>`).join('')}${canEdit ? '<button type="button" class="cpr-dadd" data-cpr-linkdraft title="Link to another paper you\'re writing" aria-label="Link to another paper you\'re writing">＋</button>' : ''}</div>` : ''}
    ${papers.length ? `<div class="cpr-cgroup" style="--chip:${PAPER_HEX}"><span class="cpr-cgroup-name">papers</span><span class="cpr-cgroup-n">${papers.length}</span></div>${papers.map(e => paperRowHTML(e, canEdit)).join('')}` : ''}
    ${groups.map(g => `<div class="cpr-cgroup" style="--chip:${g.rel.hex}"><span class="cpr-cgroup-name">${esc(g.rel.label)}</span><span class="cpr-cgroup-n">${g.rows.length}</span></div>${g.rows.map(e => entryRowHTML(e, canEdit)).join('')}`).join('')}
    ${kp.length ? `<div class="cpr-cgroup" style="--chip:#0d675e"><span class="cpr-cgroup-name">key points</span><span class="cpr-cgroup-n">${kp.filter(k => String(k || '').trim()).length}</span></div><div class="cpr-kps">${kp.map((k, i) => `<div class="cpr-kprow"><span class="cpr-kpdot" aria-hidden="true"></span>${canEdit ? `<input type="text" class="cpr-kpin" data-kp="${i}" value="${esc(k)}" placeholder="A distilled point…" aria-label="Key point ${i + 1}"><button type="button" class="cpr-x" data-kpdel="${i}" title="Remove this key point" aria-label="Remove this key point">×</button>` : `<span class="cpr-kptext">${esc(k)}</span>`}</div>`).join('')}</div>` : ''}
    ${showNotes ? `<div class="cpr-cgroup" style="--chip:#64748b"><span class="cpr-cgroup-name">notes</span></div><div class="cpr-notes nbk-note${canEdit ? '' : ' nbk-note-ro'}"${canEdit ? ' contenteditable="true"' : ''} data-placeholder="Notes on this collection…">${d.notes_html || ''}</div>` : ''}
    ${empty ? `<div class="cpr-empty">${canEdit ? 'Empty — search the library below to add papers, drag a coloured node from a ' + ICON.svg('book-open') + ' Paper card onto this card, or use ⤳ on a highlight.' : 'Nothing collected yet.'}</div>` : ''}
    ${canEdit ? `<div class="cpr-search"><input type="search" class="nbc-lit-q cpr-search-in" value="${esc(d.query || '')}" placeholder="＋ Add papers — search the library…" autocomplete="off" aria-label="Search the library to add papers"><div class="cpr-results" hidden></div></div>
    <div class="cpr-foot-acts">
      <button type="button" class="cpr-mini cpr-mini-ghost" data-kpadd>＋ Key point</button>
      ${showNotes ? '' : '<button type="button" class="cpr-mini cpr-mini-ghost" data-cpr-addnote>＋ Note</button>'}
      <button type="button" class="cpr-mini cpr-mini-ghost" data-cpr-addquote>❝ Quote</button>
      ${drafts.length ? '' : '<button type="button" class="cpr-mini cpr-mini-ghost" data-cpr-linkdraft>✎ Link to a paper you\'re writing…</button>'}
      ${!claim && !d.claimSetup ? '<button type="button" class="cpr-mini" data-cpr-makeclaim>◆ Make this a claim…</button>' : ''}
    </div>` : ''}
  </div>`;
  const root = body.querySelector('.cpr-coll');
  if (!canEdit) return;
  if (d.claimSetup && !claim) renderClaimSetup(it, root, commit);
  const items = () => { const c = currentItem(it.id); return c ? asCollection(c).data.items : list; };
  /* clicks */
  root.addEventListener('click', async (e) => {
    const t = e.target;
    if (t.closest('[data-cpr-split]')) { await adopt(it); return; }
    if (t.closest('[data-cpr-makeclaim]')) { await commit({ claimSetup: true }, { refresh: true }); return; }
    const ld = t.closest('[data-cpr-linkdraft]'); if (ld) { openDraftPicker(ld, it); return; }
    const ud = t.closest('[data-cpr-undraft]'); if (ud) { if (it.kind !== 'collection') await adopt(it); await unlinkDraft(it, ud.dataset.cprUndraft); return; }
    if (t.closest('[data-kpadd]')) { const n = kp.length; await commit(cd => ({ keyPoints: (cd.keyPoints || []).concat(['']) }), { refresh: true }); focusIn(it.id, `[data-kp="${n}"]`); return; }
    const kd = t.closest('[data-kpdel]'); if (kd) { const k = +kd.dataset.kpdel; await commit(cd => ({ keyPoints: (cd.keyPoints || []).filter((_, i) => i !== k) }), { refresh: true }); return; }
    if (t.closest('[data-cpr-addnote]')) { body.dataset.cprNotes = '1'; renderCollection(it, body, api); focusIn(it.id, '.cpr-notes'); return; }
    if (t.closest('[data-cpr-addquote]')) {
      const q = { id: newId('e'), type: 'quote', quote: '', cite: '', paperId: '', page: 0, rel: 'quote', hex: QUOTE_HEX, addedAt: new Date().toISOString() };
      const alone = !list.length && !kp.length && !showNotes && !claim;
      await commit(cd => Object.assign({ items: (cd.items || []).concat([q]) }, alone ? { shape: 'quote' } : {}), { refresh: true });
      focusIn(it.id, alone ? '.cpr-qcard-in' : `[data-qtext="${q.id}"]`); return;
    }
    const add = t.closest('[data-add]');
    if (add && !add.disabled) {
      const r = (LIB || []).find(x => x.id === add.dataset.add); if (!r) return;
      const pe = paperEntry(r.id, { title: r.title, cite: citeFor(r), year: r.year, journal: r.journal });
      await commit(cd => (cd.items || []).some(x => x.type === 'paper' && x.paperId === r.id) ? {} : { items: (cd.items || []).concat([pe]), shape: cd.shape === 'quote' ? 'list' : cd.shape }, { refresh: true });
      focusIn(it.id, '.cpr-search-in'); return;
    }
    const rel = t.closest('[data-cpr-erel]');
    if (rel) { const en = items().find(x => x.id === rel.dataset.cprErel); if (!en) return; const I = inst(); if (en.wireId && I && I.getWires().some(w => w.id === en.wireId)) relMenu(rel, en.wireId, en.rel, { remove: false }); else relMenuLocal(rel, it, en); return; }
    const un = t.closest('[data-cpr-unlink]');
    if (un) {
      const en = items().find(x => x.id === un.dataset.cprUnlink); if (!en) return;
      const I = inst(); const hasWire = I && en.wireId && I.getWires().some(w => w.id === en.wireId);
      if (hasWire) { await I.removeWire(en.wireId); return; }   /* onWireRemoved drops the entry and any claim evidence */
      await commit(cd => ({ items: (cd.items || []).filter(x => x.id !== en.id) }), { refresh: true });
      await syncClaim(currentItem(it.id), en, 'remove');
    }
  });
  /* typing: debounced, and always onto the card's current data */
  const timers = {};
  const later = (key, fn, ms) => { clearTimeout(timers[key]); timers[key] = setTimeout(fn, ms == null ? 400 : ms); };
  const setEntry = (id, fields) => commit(cd => ({ items: (cd.items || []).map(x => x.id === id ? Object.assign({}, x, fields) : x) }));
  root.addEventListener('input', (e) => {
    const t = e.target;
    if (t.dataset.why !== undefined) { const v = t.value; later('why' + t.dataset.why, () => setEntry(t.dataset.why, { why: v })); return; }
    if (t.dataset.qtext !== undefined || t.dataset.qcite !== undefined) {
      const id = t.dataset.qtext || t.dataset.qcite; const row = root.querySelector(`[data-cpr-entry="${CSS.escape(id)}"]`);
      const qv = row.querySelector('[data-qtext]').value, cv = row.querySelector('[data-qcite]').value;
      later('q' + id, () => setEntry(id, { quote: qv, cite: cv })); return;
    }
    if (t.dataset.kp !== undefined) { const i = +t.dataset.kp, v = t.value; later('kp' + i, () => commit(cd => { const a = (cd.keyPoints || []).slice(); a[i] = v; return { keyPoints: a }; })); return; }
    if (t.classList.contains('cpr-notes')) { later('notes', () => commit({ notes_html: sanitize(t.innerHTML) })); return; }
    if (t.classList.contains('cpr-search-in')) later('search', runSearch, 250);
  });
  root.addEventListener('focusout', (e) => {
    const t = e.target;
    if (t.classList && t.classList.contains('cpr-notes')) { clearTimeout(timers.notes); const v = sanitize(t.innerHTML); if (v !== (d.notes_html || '')) commit({ notes_html: v }); }
  });
  root.addEventListener('keydown', (e) => {
    const t = e.target;
    if (t.dataset && t.dataset.kp !== undefined && e.key === 'Enter') {
      e.preventDefault(); const i = +t.dataset.kp, v = t.value; clearTimeout(timers['kp' + i]);
      commit(cd => { const a = (cd.keyPoints || []).slice(); a[i] = v; a.splice(i + 1, 0, ''); return { keyPoints: a }; }, { refresh: true }).then(() => focusIn(it.id, `[data-kp="${i + 1}"]`));
      return;
    }
    if (t.classList && t.classList.contains('cpr-search-in')) {
      if (e.key === 'Enter') { e.preventDefault(); clearTimeout(timers.search); runSearch(); }
      if (e.key === 'Escape') { const r = root.querySelector('.cpr-results'); if (r) r.hidden = true; }
    }
  });
  /* the library search: results inline under the box */
  const sIn = root.querySelector('.cpr-search-in'), sRes = root.querySelector('.cpr-results');
  async function runSearch() {
    const term = sIn.value.trim();
    if (!conv.legacy && term !== (d.query || '')) commit({ query: term });   /* an old card is adopted by adding, not by typing */
    if (!term) { sRes.hidden = true; sRes.innerHTML = ''; return; }
    let rows;
    try { rows = await loadLibrary(); } catch (err) { sRes.hidden = false; sRes.innerHTML = `<div class="nbk-pick-empty">Could not search the library: ${esc(err.message || err)}</div>`; return; }
    if (!sRes.isConnected) return;
    const terms = term.toLowerCase().split(/\s+/).filter(Boolean);
    const hits = rows.filter(r => terms.every(x => r.hay.includes(x))).slice(0, 8);
    const inIt = new Set(items().filter(x => x.type === 'paper').map(x => x.paperId));
    sRes.hidden = false;
    sRes.innerHTML = hits.length ? hits.map(r => `<button type="button" class="nbk-pick-row" data-add="${esc(r.id)}"${inIt.has(r.id) ? ' disabled' : ''}>${esc(r.title)}<small>${esc(citeFor(r))}${r.journal ? ' · ' + esc(r.journal) : ''}${inIt.has(r.id) ? ' · in this collection' : ''}</small></button>`).join('') : '<div class="nbk-pick-empty">No paper in the library matches. Add it to the library first.</div>';
  }
  /* a lit review started from a note's words searches at once */
  if (d.query && !list.length) runSearch();
}
function sanitize(html) { try { return (window.CANVAS_WIDGETS && window.CANVAS_WIDGETS.basic && window.CANVAS_WIDGETS.basic.sanitizeHtml) ? window.CANVAS_WIDGETS.basic.sanitizeHtml(html) : String(html || '').replace(/<script[\s\S]*?<\/script>/gi, ''); } catch (e) { return ''; } }
function renderClaimSetup(it, root, commit) {
  const cur = currentItem(it.id) || it; const d = asCollection(cur).data;
  const box = document.createElement('div'); box.className = 'cpr-claimform';
  const preset = (H && typeof H.draftId === 'function') ? (H.draftId() || '') : '';
  const linked = (d.drafts || [])[0] ? d.drafts[0].id : '';
  box.innerHTML = `<div class="cpr-sf-head">◆ Make this a claim</div>
    <label class="cpr-lbl">For which paper draft?<select class="cpr-sel" data-cl-draft><option value="">Loading your drafts…</option></select></label>
    <div class="cpr-claims" data-cl-existing hidden></div>
    <label class="cpr-lbl">The claim<textarea class="cpr-ta" data-cl-stmt rows="2" placeholder="One sentence you intend to defend…">${esc(cur.title && !/^(Collection|Claim|Lit review)$/.test(cur.title) ? cur.title : '')}</textarea></label>
    <div class="cpr-sf-acts"><button type="button" class="cpr-btn cpr-btn-primary" data-cl="create">Create the claim</button><button type="button" class="cpr-btn" data-cl="cancel">Cancel</button></div><div class="cpr-sf-err" data-cl-err hidden></div>`;
  root.appendChild(box);
  const sel = box.querySelector('[data-cl-draft]'), ex = box.querySelector('[data-cl-existing]'), err = box.querySelector('[data-cl-err]');
  const showErr = (m) => { err.textContent = m; err.hidden = false; };
  const want = preset || linked;
  const loadExisting = async (draftId) => {
    ex.hidden = true; ex.innerHTML = '';
    if (!draftId) return;
    try {
      const snap = await db().collection('drafts').doc(draftId).collection('claims').get();
      const claims = []; snap.forEach(c => claims.push(Object.assign({ id: c.id }, c.data() || {})));
      if (!claims.length) return;
      ex.hidden = false;
      ex.innerHTML = `<div class="cpr-lbl">…or use one of its claims</div>` + claims.map(c => `<button type="button" class="nbk-pick-row" data-cl-use="${esc(c.id)}" data-cl-stmt-txt="${esc(c.statement || '')}">◆ ${esc(c.statement || '(no statement)')}<small>${esc(c.status || 'developing')} · ${(c.supporting_evidence_ids || []).length} for · ${(c.counter_evidence_ids || []).length} against</small></button>`).join('');
    } catch (e) { /* no claims visible */ }
  };
  (async () => {
    let rows = [];
    try { rows = (await loadMyDrafts()).slice(); } catch (e) { rows = []; }
    (d.drafts || []).concat(hostDrafts()).forEach(p => { if (p && p.id && !rows.some(r => r.id === p.id)) rows.unshift({ id: p.id, title: p.title }); });
    sel.innerHTML = rows.length ? `<option value="">Choose a draft…</option>` + rows.map(r => `<option value="${esc(r.id)}"${r.id === want ? ' selected' : ''}>${esc(r.title)}</option>`).join('') : '<option value="">You have no paper drafts yet</option>';
    if (want) loadExisting(want);
  })();
  sel.addEventListener('change', () => loadExisting(sel.value));
  const bind = async (draftId, claimId, statement) => {
    const draftTitle = (sel.options[sel.selectedIndex] || {}).textContent || '';
    const claim = { draftId, claimId, statement, draftTitle };
    await commit(cd => ({ claim, claimSetup: false, drafts: (cd.drafts || []).some(x => x.id === draftId) ? cd.drafts : (cd.drafts || []).concat([{ id: draftId, title: draftTitle }]) }), { title: statement, refresh: true });
    const col = currentItem(it.id);
    for (const e of ((col && col.data && col.data.items) || [])) await syncClaim(col, e, 'add');
    toast('success', 'This card is now a claim — supports / refutes connections are its evidence.');
  };
  box.addEventListener('click', async (e) => {
    const use = e.target.closest('[data-cl-use]');
    if (use) { if (!sel.value) { showErr('Choose the draft first.'); return; } await bind(sel.value, use.dataset.clUse, use.dataset.clStmtTxt || cur.title || 'Claim'); return; }
    const b = e.target.closest('[data-cl]'); if (!b) return;
    if (b.dataset.cl === 'cancel') { await commit({ claimSetup: false }, { refresh: true }); return; }
    const draftId = sel.value, stmt = (box.querySelector('[data-cl-stmt]').value || '').trim();
    if (!draftId) { showErr('Choose the paper draft this claim belongs to.'); return; }
    if (!stmt) { showErr('Type the claim first.'); return; }
    if (!window.CLAIMS || !window.CLAIMS.create) { showErr('The claims module is not loaded on this page.'); return; }
    b.disabled = true; b.textContent = 'Creating…'; err.hidden = true;
    try { const id = await window.CLAIMS.create(draftId, { statement: stmt }); await bind(draftId, id, stmt); }
    catch (ex2) { b.disabled = false; b.textContent = 'Create the claim'; showErr('Could not create the claim: ' + (ex2.message || ex2)); }
  });
}
/* an entry whose wire is gone (its source card was removed): the type still matters for a claim */
function relMenuLocal(anchor, it, en) {
  const commit = committer(it);
  const items = NODE_RELS.map(r => ({ label: (en.rel === r.id ? '✓ ' : '') + r.label, sub: r.sub, run: async () => {
    await commit(cd => ({ items: (cd.items || []).map(x => x.id === en.id ? Object.assign({}, x, { rel: r.id }) : x) }), { refresh: true });
    await syncClaim(currentItem(it.id), Object.assign({}, en, { rel: r.id }), 'update', en);
  } }));
  window.CANVAS_WIDGETS.actionMenu({ anchor, title: 'Connection type', items });
}
function collectionSummary(it) {
  const d = asCollection(it).data;
  if (isQuoteShape(d)) { const q = d.items[0]; return `❝ ${String(q.quote || '').slice(0, 120)}`; }
  return (d.claim ? '◆ ' : '') + (countsLine(countsOf(d.items), d.keyPoints) || 'empty');
}
function collectionMenu(it, api) {
  const c = asCollection(it); const d = c.data; const list = d.items || []; const commit = committer(it); const acts = [];
  const anchorOf = () => { const n = cardNode(it.id); return (n && n.querySelector('.wb-wh')) || n || document.body; };
  if (d.claim) {
    acts.push({ label: 'Open the claim\'s draft ↗', sub: d.claim.draftTitle || '', run: () => { try { window.open(`/rm/pages/paper-builder.html?paper=${encodeURIComponent(d.claim.draftId)}`, '_blank', 'noopener'); } catch (e) {} } });
    acts.push({ label: 'Detach from the claim', sub: 'The list stays; the claim keeps its evidence', run: () => commit({ claim: null }, { refresh: true }) });
  } else acts.push({ label: 'Make this a claim…', sub: 'For one of your paper drafts', then: 'content', run: () => commit({ claimSetup: true }, { refresh: true }) });
  acts.push({ label: 'Link to a paper you\'re writing…', sub: (d.drafts || []).length ? 'Linked to ' + d.drafts.map(x => x.title).join(', ') : 'Every paper in it gets linked to that draft', run: () => openDraftPicker(anchorOf(), it) });
  const one = list.length === 1 && (list[0].type === 'quote' || list[0].type === 'highlight') && !(d.keyPoints || []).length && !String(d.notes_html || '').trim() && !d.claim;
  if (one) acts.push(d.shape === 'quote' ? { label: 'Show as a list', sub: 'Room for papers, key points and notes', then: 'content', run: () => commit({ shape: 'list' }, { refresh: true }) } : { label: 'Show as a quote', then: 'content', run: () => commit({ shape: 'quote' }, { refresh: true }) });
  if (c.rest.length) acts.push({ label: `Split into ${c.rest.length + 1} collections`, sub: 'One per section of this lit review', run: () => adopt(it) });
  if (list.length || (d.keyPoints || []).length) acts.push({ label: 'Copy as text', run: async () => { try { await navigator.clipboard.writeText([...list.map(e => e.type === 'paper' ? `${e.title}${e.cite ? ' — ' + e.cite : ''}${e.why ? ': ' + e.why : ''}` : (e.quote ? `“${e.quote}”` : e.name || '') + (e.cite ? ` — ${e.cite}` : '') + (e.type === 'quote' ? '' : ` [${e.rel}]`)), ...(d.keyPoints || []).filter(Boolean).map(k => '• ' + k)].join('\n')); toast('success', 'Copied.'); } catch (e) { toast('error', 'Could not copy.'); } } });
  if (list.length) acts.push({ label: 'Clear the list', sub: 'Removes its connections too; key points stay', danger: true, confirm: 'Really clear?', run: async () => {
    const I = inst();
    for (const e of list) { if (e.wireId && I && I.getWires().some(w => w.id === e.wireId)) await I.removeWire(e.wireId); else await syncClaim(currentItem(it.id), e, 'remove'); }
    await commit({ items: [] }, { refresh: true });
  } });
  return acts;
}
/** HTML for the block mirrors (PMR, the blocks page): the quote as a blockquote, a list as its parts. */
function toHtml(it) {
  const d = asCollection(it).data; const list = d.items || [];
  if (isQuoteShape(d)) { const q = list[0]; return `<blockquote>${esc(q.quote || '')}</blockquote>${q.cite ? `<p><em>${esc(q.cite)}</em></p>` : ''}`; }
  const papers = list.filter(e => e.type === 'paper'), rest = list.filter(e => e.type !== 'paper');
  const kp = (d.keyPoints || []).filter(k => String(k || '').trim());
  return `<p>${d.claim ? '◆ ' : ''}<strong>${esc(it.title || (d.claim ? 'Claim' : 'Collection'))}</strong>${d.query ? ' — ' + esc(d.query) : ''}${(d.drafts || []).length ? ` <em>(linked to ${esc(d.drafts.map(x => x.title).join(', '))})</em>` : ''}</p>`
    + (papers.length ? `<ul>${papers.map(p => `<li>${esc(p.title || '')}${p.cite ? ' — ' + esc(p.cite) : ''}${p.why ? ': <em>' + esc(p.why) + '</em>' : ''}</li>`).join('')}</ul>` : '')
    + (rest.length ? `<ul>${rest.map(e => `<li>${e.quote ? '“' + esc(e.quote) + '”' : esc(e.name || '')}${e.cite ? ' — ' + esc(e.cite) : ''}${e.type === 'quote' ? '' : ' [' + esc(e.rel || '') + ']'}</li>`).join('')}</ul>` : '')
    + (kp.length ? `<p><strong>Key points</strong></p><ul>${kp.map(k => `<li>${esc(k)}</li>`).join('')}</ul>` : '')
    + (String(d.notes_html || '').trim() ? sanitize(d.notes_html) : '');
}
/** Hosts: a quote from a paper (a highlight, or text taken from a region) is a one-passage collection. */
async function addQuoteCard(s, at) {
  const I = inst(); if (!I || !s) return null;
  const e = (s.annId && s.paperId)
    ? { id: newId('e'), type: 'highlight', paperId: s.paperId, annId: s.annId, quote: s.quote || '', cite: s.cite || '', page: s.page || 0, rel: TYPE_REL[typeFor(s.colorId || 'orange')] || 'quote', hex: hexFor(s.colorId || 'orange'), colorId: s.colorId || '' }
    : { id: newId('e'), type: 'quote', quote: s.quote || '', cite: s.cite || '', paperId: s.paperId || '', page: s.page || 0, rel: 'quote', hex: QUOTE_HEX };
  const data = { items: [e], shape: 'quote', keyPoints: [], notes_html: '', query: '', drafts: hostDrafts(), claim: null };
  const id = await I.addWidget(Object.assign({ kind: 'collection', title: '', w: s.w || 0.42, data, text: collectionText({ title: '', data }, [e]).slice(0, 4000) }, at || {}));
  if (id) mirrorSoon(id);
  return id;
}
/** Hosts: a lit review started from some words (📚 on a note's selection). */
async function addLitReview(s, at) {
  const I = inst(); if (!I) return null;
  const title = String((s && s.title) || 'Lit review').slice(0, 200);
  const data = { items: [], keyPoints: [], notes_html: '', query: (s && s.query) || '', drafts: hostDrafts(), claim: null };
  const id = await I.addWidget(Object.assign({ kind: 'collection', title, w: 0.46, data, text: collectionText({ title, data }, []).slice(0, 4000) }, at || {}));
  if (id) mirrorSoon(id);
  return id;
}

/* ─── registration ─────────────────────────────────────────────────── */
function registerKinds(ctx) {
  H = Object.assign({ hostKind: 'notebook', group: 'Reading', getInst: () => null, toast: null, draftId: null, draftTitle: null, mirror: null }, ctx || {});
  const R2 = window.CANVAS_WIDGETS.register;
  R2({ kind: 'paperreader', label: 'Paper', icon: 'book-open', group: H.group, sub: 'A paper from the library: read it here, highlight, snip figures — each one gets a node you connect to a collection or a claim', w: 0.42, duplicate: false,
    make: () => ({ title: '', data: { paperId: '', title: '', cite: '', journal: '', pdf: '', year: '', first: '', second: '', nAuthors: 0 } }),
    render: renderPaper, summary: paperSummary, text: (it) => { const d = it.data || {}; return d.paperId ? `Paper: ${d.title || ''} ${d.cite || ''}` : ''; },
    menu: (it, api) => (it.data && it.data.paperId) ? [
      ...(it.data.pdf ? [{ label: 'Read the paper', sub: 'Highlight and snip here', run: () => openReader(it, api) }] : []),
      { label: 'Open in the paper reader ↗', run: () => { try { window.open(readerUrl(it.data.paperId), '_blank', 'noopener'); } catch (e) {} } },
      { label: 'Change the paper…', then: 'content', run: () => { api.save({ data: { paperId: '', title: '', cite: '', journal: '', pdf: '', year: '', first: '', second: '', nAuthors: 0 }, text: '' }); api.refresh(); } }
    ] : [] });
  /* V3.859 — one card for everything that comes from a paper */
  const COLL = { render: renderCollection, summary: collectionSummary, menu: collectionMenu, duplicate: false,
    text: (it) => { const d = asCollection(it).data; return collectionText(Object.assign({}, it, { data: d }), d.items); } };
  R2(Object.assign({ kind: 'collection', label: 'Collection', icon: 'bookmark-square', group: H.group, sub: 'Quotes, a lit review of papers with key points, or a claim — fill it from papers, highlights and figures', w: 0.4,
    make: () => ({ title: 'Collection', data: { items: [], keyPoints: [], notes_html: '', query: '', drafts: hostDrafts(), claim: null } }) }, COLL));
  /* the kinds it replaced: still rendered (through the collection), adopted on their first edit, never offered */
  R2(Object.assign({ kind: 'paperquote', label: 'Quote', icon: '❝', group: H.group, when: () => false, w: 0.42 }, COLL));
  R2(Object.assign({ kind: 'quote', label: 'Quote', icon: '❝', group: H.group, when: () => false, w: 0.36 }, COLL));
  R2(Object.assign({ kind: 'litreview', label: 'Lit review', icon: 'books', group: H.group, when: () => false, w: 0.5 }, COLL));
}

window.CANVAS_PAPER_READER = { registerKinds, openReader, closeReader, wireMenu, onWireAdded, onWireUpdated, onWireRemoved, NODE_RELS, defaultRel, pickTarget,
  /* V3.859 */ asCollection, adopt, addQuoteCard, addLitReview, onItemsChanged, onRemoveItem, toHtml, mirrorSubline, linkSourceToDraft, COLL_KINDS, _subs: SUBS };
})();
