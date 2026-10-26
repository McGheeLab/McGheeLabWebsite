#!/usr/bin/env node
/* build-project.js — a project spec → one Scientia project (project, themes, aims, notes, components, structures,
   wires, media) → a hub. The sibling of scripts/litreview/build-note.js, for a whole project rather than one note.

   node scripts/scientia-project/build-project.js <spec.js> --out records.json [--heights h.json]
        [--local http://127.0.0.1:PORT] [--cloud <uid> [--commit]]

   The spec (a CommonJS module, see Research/bead_confocal_scientia/project-spec.js) names the project, its themes and
   aims, the media files, and each note as sections of items placed in columns. Item kinds: text (rich text: **bold**,
   *italic*, $math$, $$display math$$, [[cite:key]], [[note:key|words]], "• " and "1. " lines), figure (images in a
   grid), html (a self-contained page, shown in Scientia's sandboxed frame), eq (LaTeX + term legend, parsed by
   Scientia's own TEX so the legend keys match), calc, protocol (a registered protocol: its own protocol note), plate,
   noteref (V3.923: a protocol can be `keep: true`, kept in its note; a wire end '#<blockId>' is a component of another
   note; `project.existing` builds into a project the hub already has). A text item can carry a structure on its first line (claim, question, decision, barrier, result,
   takeaway…), recorded under the project so it shows on the project page.

   Records follow Scientia's own shapes (scientia/src/04-model.js, 13x-figure.js, 13g-embed.js, 13n-eq.js,
   13b-protocol.js, 13e-plate.js, 13zi-noteref.js, 13v-region.js). IDs and timestamps are fixed by the spec, so a re-run
   updates the same records; records of this project that the spec no longer has are removed.
   --local pushes to a desktop serve.py notebook (for a render check); --cloud to a person's hub (dry run unless
   --commit). Media go first, then the records in one push.
*/
'use strict';
require('net').setDefaultAutoSelectFamilyAttemptTimeout(3000);   // Google endpoints answer slowly on some networks (V3.889)
const fs = require('fs'), path = require('path'), crypto = require('crypto');
const ROOT = path.resolve(__dirname, '..', '..');

const argv = process.argv.slice(2);
const opt = k => { const i = argv.indexOf(k); return i < 0 ? null : argv[i + 1]; };
const SPEC_PATH = path.resolve(argv[0]);
const spec = require(SPEC_PATH);
const SPEC_DIR = path.dirname(SPEC_PATH);
const HEIGHTS = opt('--heights') ? JSON.parse(fs.readFileSync(opt('--heights'), 'utf8')) : {};

/* ---------- Scientia conventions ---------- */
const OBJ = '￼';
const pad = n => String(n).padStart(2, '0');
function isoLocal(d) { d = new Date(d); const o = -d.getTimezoneOffset(), s = o >= 0 ? '+' : '-';
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}T${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())}${s}${pad(Math.floor(Math.abs(o) / 60))}:${pad(Math.abs(o) % 60)}`; }
const NOW = new Date(spec.createdAt), CREATED = isoLocal(NOW);
const STAMP = { at: CREATED, from: isoLocal(new Date(+NOW - 12 * 36e5)), to: isoLocal(new Date(+NOW + 12 * 36e5)) };
const TAG = spec.idTag || 'pj';
const hid = (p, k) => p + '_' + TAG + crypto.createHash('sha1').update(spec.slug + ':' + k).digest('hex').slice(0, 10);
const snap = v => Math.round(v / 14) * 14;
const SCOPE = { protocol: 'project', experiment: 'theme', analysis: 'theme', planning: 'theme', reflection: 'theme', resource: 'project', meeting: 'theme', seminar: 'global', literature: 'global', note: 'theme' };
const STRUCT_OPEN = new Set(['question', 'barrier']);

/* Scientia's own LaTeX reader, so an equation's legend is keyed exactly as the app reads the terms */
const TEX = (() => { const src = fs.readFileSync(path.join(ROOT, 'scientia/src/13n-eq.js'), 'utf8'), i = src.indexOf('const TEX ='), j = src.indexOf('\nconst ', i + 10);
  return new Function(src.slice(i, j) + '\nreturn TEX;')(); })();

/* ---------- records ---------- */
const rec = { projects: [], themes: [], aims: [], documents: [], blocks: [], items: [], wires: [], media: [] };
const P = spec.project;
/* V3.923 — `project.existing`: the notes go into a project the hub already has (an RM project the hub mirrors,
   rm-p-…), whose record belongs to the mirror; never written or removed here */
if (!P.existing) rec.projects.push({ id: P.id, name: P.name, status: 'active', created: CREATED });
for (const t of spec.themes) rec.themes.push({ id: t.id, projectId: P.id, name: t.name, question: t.question || '', status: 'active', supersedes: [], supersededBy: [], created: CREATED, reshapedAt: null });
for (const a of spec.aims || []) {
  const sum = a.milestones.reduce((s, m) => s + m.weight, 0);
  if (Math.abs(sum - 1) > 1e-6) throw new Error('aim weights must sum to 1: ' + a.statement + ' (' + sum + ')');
  rec.aims.push({ id: a.id, themeId: a.themeId, statement: a.statement, status: 'active', supersedes: [], supersededBy: [], created: CREATED,
    milestones: a.milestones.map((m, i) => ({ id: hid('ms', a.id + ':' + i), label: m.label, weight: m.weight, metAt: null, evidenceRef: null })) });
}

/* media: id per key; PNG size read from the header */
const MEDIA = {};
function pngSize(buf) { return buf.slice(1, 4).toString() === 'PNG' ? { w: buf.readUInt32BE(16), h: buf.readUInt32BE(20) } : { w: 0, h: 0 }; }
const MIME = { png: 'image/png', jpg: 'image/jpeg', jpeg: 'image/jpeg', webp: 'image/webp', svg: 'image/svg+xml', html: 'text/html', pdf: 'application/pdf' };
for (const [key, m] of Object.entries(spec.media || {})) {
  const file = path.resolve(SPEC_DIR, m.file), bytes = fs.readFileSync(file), ext = path.extname(file).slice(1).toLowerCase(), id = hid('m', 'media:' + key);
  const kind = ext === 'html' ? 'html' : ext === 'pdf' ? 'pdf' : 'image', dims = kind === 'image' ? pngSize(bytes) : { w: 0, h: 0 };
  const r = { id, kind, ext, name: m.name || path.basename(file), mime: MIME[ext] || 'application/octet-stream', size: bytes.length, w: dims.w, h: dims.h, dur: null,
    created: CREATED, fileDate: null, path: `images/${id}.${ext}`, local: false, _file: file, _sha: crypto.createHash('sha1').update(bytes).digest('hex') };
  rec.media.push(r); MEDIA[key] = r;
}

/* notes first (ids), so links between notes resolve while the text is built */
const NOTE = {};
spec.notes.forEach((n, i) => { NOTE[n.key] = { spec: n, id: n.id || hid('d', 'note:' + n.key), order: i }; });
const LIB = spec.library || {};

/* ---------- rich text ---------- */
function richText(src, ctxKey) {
  let text = '', marks = [], i = 0, mi = 0;
  const mid = () => 'm_' + crypto.createHash('sha1').update(ctxKey + ':' + (mi++)).digest('hex').slice(0, 10);
  src = String(src).replace(/`([^`\n]+)`/g, '$1');   // Scientia has no code mark: file names stay plain
  const re = /\$\$([\s\S]+?)\$\$|\$([^$\n]+?)\$|\*\*(.+?)\*\*|\*([^*\n]+?)\*|\[\[cite:([\w-]+)\]\]|\[\[note:([\w-]+)(?:\|([^\]]+))?\]\]/g; let m;
  while ((m = re.exec(src))) {
    text += src.slice(i, m.index); i = re.lastIndex;
    if (m[1] != null || m[2] != null) { marks.push({ id: mid(), type: 'math', from: text.length, to: text.length + 1, tex: (m[1] ?? m[2]).trim(), display: m[1] != null }); text += OBJ; }
    else if (m[3] != null || m[4] != null) { const s = m[3] != null ? 'b' : 'i', t = m[3] ?? m[4]; marks.push({ id: mid(), type: 'fmt', s, from: text.length, to: text.length + t.length }); text += t; }
    else if (m[5]) { const lib = LIB[m[5]]; if (!lib) throw new Error('cite to an unknown paper: ' + m[5]); marks.push({ id: mid(), type: 'cite', from: text.length, to: text.length + 1, ref: lib }); text += OBJ; }
    else if (m[6]) { const n = NOTE[m[6]]; if (!n) throw new Error('link to an unknown note: ' + m[6]); const t = m[7] || n.spec.title; marks.push({ id: mid(), type: 'link', from: text.length, to: text.length + t.length, ref: n.id, title: n.spec.title }); text += t; }
  }
  text += src.slice(i);
  return { text, marks };
}

/* ---------- height estimates (replaced by measured heights from a render: --heights) ---------- */
function estH(b) {
  const m = HEIGHTS[b.id];
  if (m && Math.abs(m[2] - b.w) < 2) return m[3];
  const lines = (t, w, cw) => { const cpl = Math.max(16, (w - 40) / cw); return t.split('\n').reduce((n, ln) => n + Math.max(1, Math.ceil(ln.length / cpl)), 0); };
  if (b.kind === 'component') {
    const disp = (b.body.marks || []).filter(x => x.type === 'math' && x.display).length;
    return 51 + lines(b.body.text, b.w, 7.2) * 18 + disp * 34;
  }
  if (b.kind === 'figure') {
    const F = b.fig, W = b.w - 28; let hsum = 0;
    for (let r = 0; r < F.rows; r++) { const row = F.cells.slice(r * F.cols, (r + 1) * F.cols); const as = row.map(c => { const md = rec.media.find(x => x.id === c.media); return md && md.w ? md.w / md.h : 4 / 3; }); hsum += W / as.reduce((s, a) => s + a, 0) + (row.some(c => c.caption) ? 28 : 6); }
    return 60 + hsum + (b.body.text ? lines(b.body.text, b.w, 7.2) * 18 + 12 : 0);
  }
  if (b.kind === 'html') return (b.h || 400) + 56;
  if (b.kind === 'eq') return 150 + 30 * Object.keys(b.eq.vars).length;
  if (b.kind === 'calc') return 330;
  if (b.kind === 'protocol') return 80 + b.steps.reduce((s, st) => s + 14 + 19 * lines(st.text, b.w - 40, 7.4), 0);
  if (b.kind === 'plate') return 120 + (b.w - 60) / 12 * 8 * 1.04;
  if (b.kind === 'noteref') return 150;
  return 200;
}

/* ---------- build each note ---------- */
const BLOCK = {};   // 'noteKey:itemKey' → block
const GAP = 42, REG_GAP = 130, TOP = 330;
function base(doc, key, init) {
  const b = Object.assign({ id: hid('c', doc.id + ':' + key), docId: doc.id, kind: 'component', label: '', body: { text: '', marks: [] }, status: 'live', supersedes: [], supersededBy: [],
    created: CREATED, modified: CREATED, manualSec: null, step: null, x: 0, y: 0, w: 392, fields: [], boundTo: null, stamp: STAMP, auto: false }, init);
  rec.blocks.push(b); doc.blockIds.push(b.id); return b;
}
function structure(doc, b, kind, extra) {
  const nl = b.body.text.indexOf('\n'), to = nl < 0 ? b.body.text.length : nl, first = b.body.text.slice(0, to).replace(new RegExp(OBJ, 'g'), '').trim();
  const it = Object.assign({ id: hid('i', b.id), kind, text: first, projectId: P.id, originDocId: doc.id, originBlockId: b.id,
    status: STRUCT_OPEN.has(kind) ? 'open' : null, stance: kind === 'claim' ? 'supported' : null, resolves: null, sourceRef: kind === 'evidence' ? { type: 'doc', id: doc.id } : null,
    relatedClaims: [], corrects: null, created: CREATED }, extra || {});
  rec.items.push(it);
  b.body.marks.push({ id: hid('m', 'struct:' + b.id), type: 'struct', from: 0, to, ref: it.id });
  return it;
}
function makeItem(doc, nk, it, w) {
  const key = it.key || ('i' + doc.blockIds.length);
  if (BLOCK[nk + ':' + key]) throw new Error(`note ${nk}: the item key "${key}" is used twice (keys give the ids, so each must be unique in its note)`);
  let b;
  if (it.kind === 'text' || !it.kind) {
    b = base(doc, key, { label: it.label || '', body: richText(it.text, doc.id + ':' + key), w });
    if (it.struct) structure(doc, b, it.struct, it.stance ? { stance: it.stance } : null);
  } else if (it.kind === 'figure') {
    const cells = it.media.map((k, i) => { const md = MEDIA[k]; if (!md) throw new Error('no media ' + k); return { id: hid('fc', doc.id + ':' + key + ':' + i), media: md.id, caption: (it.captions || [])[i] || '', crop: null }; });
    const rows = it.rows || 1, cols = it.cols || cells.length;
    b = base(doc, key, { kind: 'figure', label: it.label || 'Figure', w, fig: { rows, cols, letters: it.letters !== undefined ? it.letters : cells.length > 1, cells } });
    b.body = it.caption ? richText(it.caption, doc.id + ':' + key) : { text: '', marks: [] };
    b.fig.index = cells.map((c, i) => { const md = rec.media.find(x => x.id === c.media); return `${String.fromCharCode(65 + i)}: ${c.caption || ''} ${md.name}`.trim(); }).join(' · ');
  } else if (it.kind === 'html') {
    const md = MEDIA[it.media]; if (!md) throw new Error('no media ' + it.media);
    b = base(doc, key, { kind: 'html', label: it.label || md.name.replace(/\.html?$/i, ''), media: md.id, w, h: it.h || 760 });
    b.body = { text: (b.label || 'HTML') + ' · ' + md.name, marks: [] };
  } else if (it.kind === 'eq') {
    const p = TEX.parse(it.tex), terms = TEX.vars(p.L, p.R), vars = {};
    for (const t of terms) { const v = (it.vars || {})[t.k] || (it.vars || {})[t.tex]; if (!v) throw new Error(`equation "${it.label}": no legend for the term ${t.k}`); vars[t.k] = { name: v[0], unit: v[1] || '' }; }
    b = base(doc, key, { kind: 'eq', label: it.label || 'Equation', eqId: null, eq: { tex: it.tex, vars }, w: w || 420 });
    b.body = { text: [b.label, it.tex, terms.map(t => t.k + ' ' + vars[t.k].name).join(' · ')].join('\n'), marks: [] };
  } else if (it.kind === 'calc') {
    b = base(doc, key, { kind: 'calc', label: it.label || 'Calculator', hist: [], expr: '', angle: 'deg', tab: 'sci', w: Math.max(420, w || 420) });
    b.body = { text: b.label, marks: [] };
  } else if (it.kind === 'protocol') {
    const steps = it.steps.map((t, i) => ({ id: hid('st', doc.id + ':' + key + ':' + i), text: t, created: CREATED, status: 'live', supersedes: [], supersededBy: [] }));
    /* V3.923 — `keep: true`: kept in its note (Scientia's localOnly), runnable where it sits, so several procedures
       can live in one planning note; a registered protocol gets a protocol note of its own */
    b = base(doc, key, { kind: 'protocol', label: it.label, w, registered: it.keep ? null : { docId: doc.id, projectId: P.id, themeId: doc.themeId || null, at: CREATED },
      localOnly: !!it.keep, log: [], steps });
    b.body = { text: [b.label, ...steps.map((s, i) => `${i + 1}. ${s.text}`)].join('\n'), marks: [] };
  } else if (it.kind === 'plate') {
    b = base(doc, key, { kind: 'plate', label: it.label || 'Plate', fmt: it.fmt || 96, mode: 'color', infoShow: !!it.infoShow, wells: it.wells, legend: it.legend || {}, stage: 'plan', w: w || 616 });
    const lines = Object.entries(b.wells).filter(([, x]) => x.info).map(([id, x]) => `${id}: ${x.info}`), leg = Object.values(b.legend).filter(Boolean);
    b.body = { text: [`${b.label} · ${b.fmt}-well`, ...leg, ...lines].join('\n'), marks: [] };
  } else if (it.kind === 'noteref') {
    const n = NOTE[it.note]; if (!n && !it.docId) throw new Error('noteref to an unknown note ' + it.note);
    b = base(doc, key, { kind: 'noteref', label: '', refDocId: n ? n.id : it.docId, focusId: it.focusId || null, w: w || 392 });
    b.body = { text: n ? n.spec.title : (it.title || ''), marks: [] };
  } else throw new Error('unknown item kind ' + it.kind);
  BLOCK[nk + ':' + key] = b;
  return b;
}

const RG = ['#2a78d6', '#1baf7a', '#eda100', '#eb6834', '#6250d6', '#e87ba4', '#008300', '#e34948'];
for (const n of spec.notes) {
  const id = NOTE[n.key].id, scope = SCOPE[n.type] || 'theme';
  const doc = { id, type: n.type, scope, projectId: P.id, themeId: scope === 'theme' ? (n.themeId || null) : null, title: n.title, templateId: null,
    header: Object.assign({ tags: n.tags || [] }, n.header || {}), blockIds: [], synthesis: n.synthesis ? richText(n.synthesis, id + ':synth') : { text: '', marks: [] },
    citeMode: 'author', layout: { head: { x: 0, y: 0 }, synth: n.synthesis ? { x: 700, y: 0 } : null }, created: CREATED,
    modified: isoLocal(new Date(+NOW - NOTE[n.key].order * 60e3)), backdate: null, regions: [] };   // spec order = newest first, so lists sorted by modified follow the spec
  if (n.review) doc.review = n.review;
  rec.documents.push(doc);
  const cols = n.columns || [{ x: 0, w: 560 }, { x: 600, w: 860 }], fullW = cols[cols.length - 1].x + cols[cols.length - 1].w;
  let y = HEIGHTS['_head:' + id] ? HEIGHTS['_head:' + id] + 140 : TOP;
  (n.sections || []).forEach((sec, si) => {
    const top = y + (sec.name ? 44 : 0), colY = cols.map(() => top), members = [];
    for (const it of sec.items) {
      let a, z;
      if (it.col === 'full' || it.span) { [a, z] = it.col === 'full' ? [0, cols.length - 1] : it.span; }
      else a = z = it.col || 0;
      const x = cols[a].x, w = it.w || (cols[z].x + cols[z].w - cols[a].x), yy = Math.max(...colY.slice(a, z + 1));
      const b = makeItem(doc, n.key, it, w);
      b.x = snap(x + (it.dx || 0)); b.y = snap(yy);
      const hgt = estH(b);
      for (let c = a; c <= z; c++) colY[c] = yy + hgt + GAP;
      members.push(b.id);
    }
    const bottom = Math.max(...colY);
    if (sec.name) doc.regions.push({ id: hid('rg', id + ':' + si), name: sec.name, color: sec.color || RG[si % RG.length], members, created: CREATED });
    y = bottom + REG_GAP;
  });
  n._height = y;
}

/* wires: 'noteKey:itemKey' ends */
const wireEnd = k => String(k).startsWith('#') ? { id: String(k).slice(1) } : BLOCK[k];   // '#<blockId>': a component of another note (V3.923)
for (const w of spec.wires || []) {
  const A = wireEnd(w.from), Z = wireEnd(w.to);
  if (!A || !Z) throw new Error('wire end missing ' + JSON.stringify(w));
  rec.wires.push({ id: hid('w', w.from + '>' + w.to + ':' + w.rel), from: A.id, to: Z.id, rel: w.rel, directed: w.rel !== 'related' && w.directed !== false, created: CREATED });
}

/* ---------- output ---------- */
const STORES = ['projects', 'themes', 'aims', 'media', 'items', 'blocks', 'wires', 'documents'];
const ops = [];
for (const store of STORES) for (const r of rec[store]) { const c = Object.assign({}, r); delete c._file; delete c._sha; ops.push({ store, id: c.id, rec: c, del: false }); }
const summary = `project ${P.id} "${P.name}": ${rec.themes.length} themes, ${rec.aims.length} aims, ${rec.documents.length} notes, ${rec.blocks.length} blocks ` +
  `(${['figure', 'html', 'eq', 'calc', 'protocol', 'plate', 'noteref'].map(k => rec.blocks.filter(b => b.kind === k).length + ' ' + k).join(', ')}), ${rec.items.length} structures, ${rec.wires.length} wires, ${rec.media.length} media (${(rec.media.reduce((s, m) => s + m.size, 0) / 1e6).toFixed(1)} MB)`;
fs.writeFileSync(opt('--out') || 'records.json', JSON.stringify({ project: P.id, notes: Object.fromEntries(Object.entries(NOTE).map(([k, v]) => [k, v.id])), blocks: Object.fromEntries(Object.entries(BLOCK).map(([k, b]) => [k, b.id])), ops, media: rec.media.map(m => ({ id: m.id, file: m._file, path: m.path, size: m.size, mime: m.mime })) }, null, 1));
console.log(summary);

/* records of THIS project that the spec no longer has → delete ops, so a re-run converges */
function staleOps(cur) {
  const want = new Set(ops.map(o => o.store + '\u0000' + o.id)), docs = new Set(rec.documents.map(d => d.id)), out = [];
  const mine = (store, r) => {
    if (!r || !r.id || !r.id.includes('_' + TAG)) return false;
    if (store === 'documents') return r.projectId === P.id;
    if (store === 'blocks') return docs.has(r.docId) || (cur.get('documents\u0000' + r.docId) || {}).projectId === P.id;
    if (store === 'items') return r.projectId === P.id;
    if (store === 'themes') return r.projectId === P.id;
    if (store === 'aims') return rec.themes.some(t => t.id === r.themeId);
    if (store === 'wires' || store === 'media') return true;
    return false;
  };
  for (const [k, r] of cur) { if (want.has(k)) continue; const [store] = k.split('\u0000'); if (STORES.includes(store) && mine(store, r)) out.push({ store, id: r.id, rec: null, del: true }); }
  return out;
}
const DEV = spec.device || { id: 'dv_project_builder', name: 'Project builder' };
/* V3.923 — `reviews: [{ docId, addProjectIds, removeProjectIds }]`: re-link a literature review to this project by changing
   ONLY its review.projectIds on the record the hub holds now (anything else the person changed in the review stays) */
function reviewOps(cur) {
  const out = [];
  for (const r of spec.reviews || []) {
    const doc = cur.get('documents\u0000' + r.docId);
    if (!doc || !doc.review) { console.log('review ' + r.docId + ': not in this hub — skipped'); continue; }
    const ids = (doc.review.projectIds || []).filter(x => !(r.removeProjectIds || []).includes(x));
    for (const x of r.addProjectIds || []) if (!ids.includes(x)) ids.push(x);
    if (JSON.stringify(ids) === JSON.stringify(doc.review.projectIds || [])) continue;
    out.push({ store: 'documents', id: doc.id, rec: Object.assign({}, doc, { review: Object.assign({}, doc.review, { projectIds: ids }) }), del: false });
    console.log('review ' + r.docId + ': projects ' + JSON.stringify(doc.review.projectIds || []) + ' → ' + JSON.stringify(ids));
  }
  return out;
}
async function pushLocal(base) {
  for (const m of rec.media) {
    const r = await fetch(`${base}/api/media?id=${m.id}&ext=${m.ext}`, { method: 'POST', body: fs.readFileSync(m._file), headers: { 'Content-Type': 'application/octet-stream' } });
    if (!r.ok) throw new Error('media upload failed ' + m.id + ' ' + r.status);
  }
  const st = await (await fetch(`${base}/api/sync/state`)).json();
  const cur = new Map(); for (const [store, rows] of Object.entries(st.stores || {})) for (const r of rows || []) cur.set(store + '\u0000' + r.id, r);
  const del = staleOps(cur).concat(reviewOps(cur)); if (del.length) console.log('removing / re-linking ' + del.length + ' records');
  const body = { anySid: true, dev: DEV.id, name: DEV.name, ops: ops.concat(del).map(o => Object.assign({}, o, { prev: cur.get(o.store + '\u0000' + o.id) || null, base: st.syncSeq || 0 })) };
  const r = await (await fetch(`${base}/api/sync/push`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) })).json();
  console.log('local push:', JSON.stringify(r).slice(0, 300));
}
async function pushCloud(uid, commit) {
  const admin = require(ROOT + '/functions/node_modules/firebase-admin');
  if (!admin.apps.length) admin.initializeApp({ credential: admin.credential.cert(require(ROOT + '/scripts/service-account.json')), storageBucket: 'mcgheelab-f56cc.firebasestorage.app' });
  const { FirestoreHub } = require(ROOT + '/functions/scientia-hub.js');
  const hub = new FirestoreHub(uid), st = await hub.loadState();
  const rows = new Map(); for (const r of await hub.allRows()) rows.set(r.store + '\u0000' + r.id, r.rec);
  const same = o => JSON.stringify(rows.get(o.store + '\u0000' + o.id)) === JSON.stringify(o.rec);
  const fresh = ops.filter(o => !rows.has(o.store + '\u0000' + o.id)).length, changed = ops.filter(o => rows.has(o.store + '\u0000' + o.id) && !same(o)).length, del = staleOps(rows), relink = reviewOps(rows);
  const cites = [...new Set(Object.values(LIB))], libMissing = cites.filter(id => !rows.has('library\u0000' + id));
  const have = (await hub.mediaList()).files || {};
  const upload = rec.media.filter(m => !have[m.path]);
  console.log(`cloud hub ${uid}: seq ${st.seq}, ${st.records} records; ${fresh} new, ${changed} changed, ${ops.length - fresh - changed} unchanged, ${del.length} removals; ` +
    `${upload.length} of ${rec.media.length} media to upload; ${libMissing.length} of ${cites.length} cited papers not yet in this hub's library mirror`);
  if (!commit) { console.log('dry run — add --commit to write'); return; }
  let up = 0;
  for (const m of upload) {
    const bytes = fs.readFileSync(m._file);
    for (let i = 1; ; i++) { try { await hub.mediaPut(m.path, bytes, m.mime); break; } catch (e) { if (i >= 4) throw e; console.log(`  upload ${m.path}: ${e.code || e.message} — try ${i + 1} of 4`); await new Promise(r => setTimeout(r, 3000 * i)); } }
    console.log(`  media ${++up}/${upload.length}: ${m.path} (${m.name})`);
  }
  const push = ops.filter(o => !same(o)).concat(del, relink);
  const r = await hub.push({ dev: DEV.id, conn: null, name: DEV.name, ops: push.map(o => Object.assign({}, o, { prev: rows.get(o.store + '\u0000' + o.id) || null, base: st.seq })) });
  console.log('cloud push:', JSON.stringify(r).slice(0, 300));
  if (libMissing.length && typeof hub.mirrorLibrary === 'function') console.log('library mirror:', JSON.stringify(await hub.mirrorLibrary({ force: true })).slice(0, 200));
}
(async () => {
  if (opt('--local')) await pushLocal(opt('--local'));
  if (opt('--cloud')) await pushCloud(opt('--cloud'), argv.includes('--commit'));
  if (opt('--cloud') || opt('--local')) process.exit(0);
})().catch(e => { console.error(e); process.exit(1); });
