#!/usr/bin/env node
/* build-note.js — a literature review spec → one Scientia note (records + PDFs) → a hub.

   node build-note.js <spec.json> <quotes.json> <libids.json> --out records.json [--heights h.json]
        [--local http://127.0.0.1:PORT] [--cloud <uid> [--commit]]

   Records written (Scientia's own shapes, see scientia/src/04-model.js, 13zk-docs.js, 13zw-quote.js, 13v-region.js):
     documents  the note (type 'literature', citeMode 'author', regions[], layout.head/synth)
     blocks     text cards (findings, verdicts, guide), one `pdf` component per paper, one quote component per quote
     items      claim / question / takeaway structures on cards; evidence structures on quotes
     wires      quote → its PDF ('c:quotes', as QUOTE.make does), quote → finding (supports / contradicts), card → card
     media      one record per PDF (path images/<id>.pdf); the bytes go to the hub's media store
   IDs are deterministic from the spec slug, so a re-run updates the same records instead of adding new ones.
*/
'use strict';
const fs = require('fs'), path = require('path'), crypto = require('crypto');
const ROOT = path.resolve(__dirname, '..', '..');   // the McGheeLabWebsite repo

const argv = process.argv.slice(2);
const opt = k => { const i = argv.indexOf(k); return i < 0 ? null : argv[i + 1]; };
const [specPath, quotesPath, libPath] = argv;
const spec = JSON.parse(fs.readFileSync(specPath, 'utf8'));
const QUO = JSON.parse(fs.readFileSync(quotesPath, 'utf8'));
const LIBID = JSON.parse(fs.readFileSync(libPath, 'utf8'));
const HEIGHTS = opt('--heights') ? JSON.parse(fs.readFileSync(opt('--heights'), 'utf8')) : {};

/* ---------- Scientia conventions ---------- */
const OBJ = '￼';
const pad = n => String(n).padStart(2, '0');
function isoLocal(d) { d = new Date(d); const o = -d.getTimezoneOffset(), s = o >= 0 ? '+' : '-';
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}T${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())}${s}${pad(Math.floor(Math.abs(o) / 60))}:${pad(Math.abs(o) % 60)}`; }
const NOW = spec.createdAt ? new Date(spec.createdAt) : new Date(), CREATED = isoLocal(NOW);   // fixed per spec, so a re-run writes identical records
const STAMP = { at: CREATED, from: isoLocal(new Date(+NOW - 12 * 36e5)), to: isoLocal(new Date(+NOW + 12 * 36e5)) };
const hid = (p, k) => p + '_lr' + crypto.createHash('sha1').update(spec.slug + ':' + k).digest('hex').slice(0, 10);
const snap = v => Math.round(v / 14) * 14;

const DOC_ID = hid('d', 'doc');
const rec = { documents: [], blocks: [], items: [], wires: [], media: [] };
const block = (key, init) => { const b = Object.assign({ id: hid('c', key), docId: DOC_ID, kind: 'component', label: '', body: { text: '', marks: [] }, status: 'live',
  supersedes: [], supersededBy: [], created: CREATED, modified: CREATED, manualSec: null, step: null, x: 0, y: 0, w: 392, fields: [], boundTo: null, stamp: STAMP, auto: false }, init);
  rec.blocks.push(b); return b; };
const item = (key, kind, text, b, extra) => { const it = Object.assign({ id: hid('i', key), kind, text, projectId: null, originDocId: DOC_ID, originBlockId: b.id,
  status: kind === 'question' || kind === 'barrier' ? 'open' : null, stance: kind === 'claim' ? 'supported' : null, resolves: null, sourceRef: null,
  relatedClaims: [], corrects: null, created: CREATED }, extra || {}); rec.items.push(it); return it; };
const wire = (from, to, rel, k) => { const w = { id: hid('w', k || (from + '>' + to + ':' + rel)), from, to, rel, directed: rel !== 'related', created: CREATED }; rec.wires.push(w); return w; };

/* ---------- card text: **bold**, [[cite:key]] chips, "• " bullets ---------- */
function richText(src) {
  let text = '', marks = [], i = 0, mi = 0;
  const re = /\*\*(.+?)\*\*|\*(.+?)\*|\[\[cite:([a-z0-9_-]+)\]\]/gi; let m;
  while ((m = re.exec(src))) {
    text += src.slice(i, m.index); i = re.lastIndex;
    if (m[3]) { const lib = LIBID[m[3]]; if (!lib) throw new Error('cite to unknown paper ' + m[3]); marks.push({ id: 'm_' + (mi++) + DOC_ID.slice(-6), type: 'cite', from: text.length, to: text.length + 1, ref: lib }); text += OBJ; }
    else { const s = m[1] ? 'b' : 'i', t = m[1] || m[2]; marks.push({ id: 'm_' + (mi++) + DOC_ID.slice(-6), type: 'fmt', s, from: text.length, to: text.length + t.length }); text += t; }
  }
  text += src.slice(i);
  return { text, marks };
}

/* ---------- height estimate (replaced by measured heights from a render) ---------- */
function estH(b) {
  const m = HEIGHTS[b.id];   // measured [x, y, w, h] from a render — valid only at the same width
  if (m && Math.abs(m[2] - b.w) < 2) return m[3];
  if (b.kind === 'pdf') return (b.h || 700) + 75;
  // calibrated on a render: cards ≈ 51 px + 18 px a line (≈ (w−40)/7.2 chars a line); quotes ≈ 72 px + 24 px a line (≈ 40 chars)
  if (b.quote) return 72 + 24 * Math.ceil(b.body.text.length / 40);
  const cpl = Math.max(20, (b.w - 40) / 7.2), lines = b.body.text.split('\n').reduce((n, ln) => n + Math.max(1, Math.ceil(ln.length / cpl)), 0);
  return 51 + lines * 18;
}

/* ---------- build ---------- */
const doc = { id: DOC_ID, type: 'literature', scope: 'global', projectId: null, themeId: null, title: spec.title, templateId: null,
  header: { tags: spec.tags || [] }, blockIds: [], synthesis: { text: spec.synthesis || '', marks: [] }, citeMode: 'author',
  layout: { head: { x: 0, y: 0 }, synth: null }, created: CREATED, modified: CREATED, backdate: null, regions: [] };
rec.documents.push(doc);
const region = (key, name, color, members) => doc.regions.push({ id: hid('rg', key), name, color, members: members.slice(), created: CREATED });

const CARD = {};
function makeCard(id) {
  if (CARD[id]) return CARD[id];
  const c = spec.cards[id]; if (!c) throw new Error('no card ' + id);
  const body = richText(c.text);
  const b = block('card:' + id, { label: c.label || '', body, w: c.w || 480 });
  if (c.kind) {
    // the structure is the first line (the claim / question itself), like marking that sentence by hand
    const nl = body.text.indexOf('\n'), to = nl < 0 ? body.text.length : nl, first = body.text.slice(0, to).replace(new RegExp(OBJ, 'g'), '').trim();
    const it = item('card:' + id, c.kind, first, b, c.kind === 'claim' ? { stance: c.stance || 'supported' } : {});
    body.marks.push({ id: hid('m', 'struct:' + id), type: 'struct', from: 0, to, ref: it.id });
  }
  CARD[id] = b; return b;
}

const PDFB = {}, QB = {};
function makePaper(key) {
  const p = spec.papers[key]; if (!p) throw new Error('no paper ' + key);
  const q = QUO[key];
  const out = { key, pdf: null, quotes: [] };
  if (p.pdf && q) {
    const bytes = fs.readFileSync(p.pdf), mid = hid('m', 'pdf:' + key);
    const name = (p.fileName || key) + '.pdf';
    rec.media.push({ id: mid, kind: 'pdf', ext: 'pdf', name, mime: 'application/pdf', size: bytes.length, w: 0, h: 0, dur: null, created: CREATED, fileDate: null, path: `images/${mid}.pdf`, local: false, _file: p.pdf });
    const label = p.pdfLabel || `${p.cite} · ${p.journalShort || p.journal || ''}`.trim();
    const words = p.words ? [label, p.words].join('\n\n') : label;
    out.pdf = block('pdf:' + key, { kind: 'pdf', label, body: { text: words, marks: [] }, w: 616, h: p.pdfH || 700, media: mid, view: 'scroll', cur: Math.max(0, (p.openPage || 1) - 1), pages: q.pages });
    PDFB[key] = out.pdf;
    for (const lq of q.quotes) {
      const sq = p.quotes[lq.i];
      const qb = block('q:' + key + ':' + lq.i, { label: 'Quote · p. ' + lq.page, body: { text: lq.exact, marks: [] }, w: 340,
        quote: { src: out.pdf.id, kind: 'pdf', page: lq.page, exact: lq.exact, prefix: lq.prefix, suffix: lq.suffix, rects: lq.rects, file: name, color: null } });
      const kind = sq.kind || 'evidence';
      const it = item('q:' + key + ':' + lq.i, kind, lq.exact, qb, { sourceRef: { type: 'embed', id: out.pdf.id, page: lq.page, selector: { type: 'TextQuoteSelector', exact: lq.exact, prefix: lq.prefix, suffix: lq.suffix } } });
      qb.body.marks.push({ id: hid('m', 'qs:' + key + ':' + lq.i), type: 'struct', from: 0, to: lq.exact.length, ref: it.id });
      wire(qb.id, out.pdf.id, 'c:quotes');
      out.quotes.push({ b: qb, spec: sq });
      QB[key + ':' + lq.i] = qb;
    }
  } else {
    // no open PDF: a card that says so, with the citation chip and the abstract's key line, so the gap is visible
    out.pdf = block('nopdf:' + key, { label: `${p.cite} · no open PDF`, w: 616,
      body: richText(`[[cite:${key}]]\n**No open-access PDF could be fetched.** Open it in RM's library and use Find PDF or Upload.\n` + (p.note ? '\n' + p.note : '')) });
  }
  return out;
}

/* layout: overview band, then one column per lane; inside a lane: header, then each finding followed by its papers */
const GAP = 56, REG_GAP = 120, PAPER_W = 616 + 40 + 340, LANE_W = PAPER_W, LANE_GAP = 640;   // the gap is the wire corridor: Scientia loops a long vertical wire out to the right by ~0.15 of its span
const headH = HEIGHTS._head ? HEIGHTS._head[3] : 110;
let y = snap(headH + 120);
const ov = spec.overview, COL = LANE_W + LANE_GAP;
const ovMembers = [];
// overview cells sit on the lane grid ({id, col, dx, w}) so each verdict is right above its own column
for (const row of ov.rows) {
  let x = 0, rowH = 0;
  for (const cell of row) {
    const c = typeof cell === 'string' ? { id: cell } : cell, b = makeCard(c.id);
    if (c.w) b.w = c.w;
    b.x = snap(c.col != null ? c.col * COL + (c.dx || 0) : x); b.y = snap(y); x = b.x + b.w + GAP;
    rowH = Math.max(rowH, estH(b)); ovMembers.push(b.id);
  }
  y += rowH + GAP;
}
region('overview', ov.name, ov.color, ovMembers);
doc.layout.synth = { x: snap(COL), y: 0 };
const laneTop = snap(y + REG_GAP + 40);

const placedPapers = new Set();
spec.lanes.forEach((lane, li) => {
  const x0 = li * (LANE_W + LANE_GAP);
  let ly = laneTop;
  const hb = makeCard(lane.header); hb.x = x0; hb.y = snap(ly); hb.w = LANE_W; ly += estH(hb) + REG_GAP;
  region('lane:' + lane.id, lane.name, lane.color, [hb.id]);
  for (const g of lane.groups) {
    const fb = makeCard(g.finding); fb.x = x0; fb.y = snap(ly); fb.w = LANE_W; ly += estH(fb) + REG_GAP;
    // no finding → header wire: in a tall column it would cross every PDF in between; the column says it
    for (const key of g.papers || []) {
      if (placedPapers.has(key)) throw new Error('paper placed twice: ' + key);
      placedPapers.add(key);
      const P = makePaper(key);
      P.pdf.x = x0; P.pdf.y = snap(ly);
      let qy = ly; const members = [P.pdf.id];
      for (const { b } of P.quotes) { b.x = x0 + 616 + 40; b.y = snap(qy); qy += estH(b) + 28; members.push(b.id); }
      region('paper:' + key, spec.papers[key].regionName || spec.papers[key].cite, lane.color, members);
      ly = Math.max(ly + estH(P.pdf), qy) + REG_GAP;
    }
  }
});

/* quote → card wires (supports / contradicts …) and card → card wires */
for (const [key, p] of Object.entries(spec.papers)) {
  (p.quotes || []).forEach((sq, i) => { const qb = QB[key + ':' + i]; if (!qb) return; for (const t of sq.to || []) { const cb = CARD[t.card]; if (!cb) throw new Error('quote wired to unplaced card ' + t.card); wire(qb.id, cb.id, t.rel || 'supports'); } });
}
for (const w of spec.wires || []) { const a = CARD[w.from] || PDFB[w.from], z = CARD[w.to] || PDFB[w.to]; if (!a || !z) throw new Error('wire end missing ' + JSON.stringify(w)); wire(a.id, z.id, w.rel); }

/* corridor check: a wire between two boxes stacked in one column loops out to the right by roughly
   0.75 × (34 + 0.2 × its vertical span) (scientia/src/12b-wires.js curve); past the corridor it crosses the next column */
{
  const byId = Object.fromEntries(rec.blocks.map(b => [b.id, b])), lim = LANE_GAP - 40; let worst = 0;
  for (const w of rec.wires) {
    const A = byId[w.from], B = byId[w.to]; if (!A || !B || A.y < laneTop || B.y < laneTop) continue;
    const ha = estH(A), hb = estH(B), gy = Math.max(B.y - (A.y + ha), A.y - (B.y + hb));
    if (gy < 12) continue;
    const bulge = 0.75 * (34 + 0.2 * Math.abs(gy)) + 30; worst = Math.max(worst, bulge);
    if (bulge > lim) console.warn(`wire ${A.label || A.id} → ${B.label || B.id} spans ${Math.round(gy)} px: its loop (~${Math.round(bulge)} px) leaves the ${LANE_GAP}-px corridor`);
  }
  console.log(`widest wire loop ~${Math.round(worst)} px (corridor ${LANE_GAP} px)`);
}

doc.blockIds = rec.blocks.map(b => b.id);
const unplaced = Object.keys(spec.papers).filter(k => !placedPapers.has(k));
if (unplaced.length) console.warn('papers in the spec but not on the canvas:', unplaced.join(', '));

/* ---------- output + push ---------- */
const ops = [];
for (const store of ['media', 'items', 'blocks', 'wires', 'documents']) for (const r of rec[store]) { const c = Object.assign({}, r); delete c._file; ops.push({ store, id: c.id, rec: c, del: false }); }
fs.writeFileSync(opt('--out') || 'records.json', JSON.stringify({ docId: DOC_ID, ops, media: rec.media.map(m => ({ id: m.id, file: m._file, path: m.path, size: m.size })) }, null, 1));
console.log(`note ${DOC_ID}: ${rec.blocks.length} blocks (${rec.blocks.filter(b => b.kind === 'pdf').length} PDFs, ${rec.blocks.filter(b => b.quote).length} quotes), ${rec.items.length} structures, ${rec.wires.length} wires, ${doc.regions.length} regions`);


/* records of THIS note that the spec no longer has (a removed wire, quote or card) → delete ops, so a re-run converges */
function staleOps(cur) {
  const want = new Set(ops.map(o => o.store + '\u0000' + o.id)), mine = new Set(), out = [];
  for (const [k, r] of cur) if (k.startsWith('blocks\u0000') && r && r.docId === DOC_ID) mine.add(r.id);
  for (const [k, r] of cur) {
    if (want.has(k) || !r) continue;
    const [store] = k.split('\u0000');
    const ours = (store === 'blocks' && r.docId === DOC_ID) || (store === 'items' && r.originDocId === DOC_ID) ||
      (store === 'wires' && (mine.has(r.from) || mine.has(r.to)) && /_lr[0-9a-f]{10}$/.test(r.id)) || (store === 'media' && /^m_lr[0-9a-f]{10}$/.test(r.id) && [...cur.values()].some(b => b && b.docId === DOC_ID && b.media === r.id));
    if (ours) out.push({ store, id: r.id, rec: null, del: true });
  }
  return out;
}
const DEV = 'dv_litreview', NAME = 'Lit review builder';
async function pushLocal(base) {
  // the cloud hub mirrors RM's library itself; a local test notebook gets the same rows from the RM-shaped items
  if (opt('--rm-items')) { const C = require(ROOT + '/functions/scientia-hub-core.js');
    for (const it of JSON.parse(fs.readFileSync(opt('--rm-items'), 'utf8'))) { const row = C.rmItemToLibraryRow(it); if (row.rmPdf) row.pdf = 'rm:' + row.id; ops.unshift({ store: 'library', id: row.id, rec: row, del: false }); } }
  for (const m of rec.media) {
    const r = await fetch(`${base}/api/media?id=${m.id}&ext=pdf`, { method: 'POST', body: fs.readFileSync(m._file), headers: { 'Content-Type': 'application/octet-stream' } });
    if (!r.ok) throw new Error('media upload failed ' + m.id + ' ' + r.status);
  }
  const st = await (await fetch(`${base}/api/sync/state`)).json();
  const cur = new Map(); for (const [store, rows] of Object.entries(st.stores || {})) for (const r of rows || []) cur.set(store + '\u0000' + r.id, r);
  const del = staleOps(cur); if (del.length) console.log('removing ' + del.length + ' records the spec no longer has');
  const body = { anySid: true, dev: DEV, name: NAME, ops: ops.concat(del).map(o => Object.assign({}, o, { prev: cur.get(o.store + '\u0000' + o.id) || null, base: st.syncSeq || 0 })) };
  const r = await (await fetch(`${base}/api/sync/push`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) })).json();
  console.log('local push:', JSON.stringify(r).slice(0, 300));
}
async function pushCloud(uid, commit) {
  // the hub module requires firebase-admin from functions/node_modules — initialise THAT copy, or it has no app
  const admin = require(ROOT + '/functions/node_modules/firebase-admin');
  if (!admin.apps.length) admin.initializeApp({ credential: admin.credential.cert(require(ROOT + '/scripts/service-account.json')), storageBucket: 'mcgheelab-f56cc.appspot.com' });
  const { FirestoreHub } = require(ROOT + '/functions/scientia-hub.js');
  const hub = new FirestoreHub(uid), st = await hub.loadState();
  const rows = new Map(); for (const r of await hub.allRows()) rows.set(r.store + '\u0000' + r.id, r.rec);
  const fresh = ops.filter(o => !rows.has(o.store + '\u0000' + o.id)).length, del = staleOps(rows);
  const libMissing = [...new Set(Object.values(LIBID))].filter(id => !rows.has('library\u0000' + id));
  console.log(`cloud hub ${uid}: seq ${st.seq}, ${st.records} records; ${fresh} new records, ${ops.length - fresh} updates, ${del.length} removals; ` +
    `${libMissing.length} cited papers not yet in this hub's library mirror${libMissing.length ? ' (run rm-library-add.js --commit first)' : ''}`);
  if (!commit) { console.log('dry run — add --commit to write'); return; }
  const have = (await hub.mediaList()).files || {};
  for (const m of rec.media) { if (have[m.path]) continue; const r = await hub.mediaPut(m.path, fs.readFileSync(m._file), 'application/pdf'); if (!r.ok) throw new Error('media ' + m.id); }
  const r = await hub.push({ dev: DEV, conn: null, name: NAME, ops: ops.concat(del).map(o => Object.assign({}, o, { prev: rows.get(o.store + '\u0000' + o.id) || null, base: st.seq })) });
  console.log('cloud push:', JSON.stringify(r).slice(0, 300));
  // the library rows the citation chips point at: the hub's own mirror of RM's library (one writer, device 'rm')
  if (typeof hub.mirrorLibrary === 'function') console.log('library mirror:', JSON.stringify(await hub.mirrorLibrary({ force: true })).slice(0, 200));
}
(async () => {
  if (opt('--local')) await pushLocal(opt('--local'));
  if (opt('--cloud')) await pushCloud(opt('--cloud'), argv.includes('--commit'));
})().catch(e => { console.error(e); process.exit(1); });
