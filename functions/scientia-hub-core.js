/* ================================================================
   scientia-hub-core.js — Gabe's Scientia sync hub, DOM-free (V3.857)
   ================================================================
   A faithful port of the merge/ops logic in Scientia In Situ's
   `sisync.py` (the Python hub that runs on Gabe's desktop), so the
   cloud hub (scientia-hub.js, Firestore) and the desktop hub converge
   on exactly the same rules:

     - every device pushes changed records `{store, id, rec, del, prev, base}`
       and pulls everyone else's ops (seq-numbered, tagged by `conn`);
     - a push whose `base` predates another device's change goes through
       merge3(prev, mine, cur): fields only one side touched merge, AUTO_MAX
       timestamps take the max, scalar lists union, the rest is a conflict
       the person decides (resolve);
     - journal / blobs / datasets never sync (NOSYNC);
     - a reset (sid changed, or since < minSeq) makes the device reload
       the whole record (state).

   Everything here is a pure function of (state, rows, request) and
   returns what to write. The adapters (Firestore in scientia-hub.js,
   MemoryHub below for the node fixtures and the local dev hub) do the
   I/O. Shared by: functions/scientia-hub.js, functions/test/
   scientia-hub.test.js, scripts/scientia_hub_dev.js.
   ================================================================ */
'use strict';

const crypto = require('crypto');

const NOSYNC = new Set(['journal', 'blobs', 'datasets']);
const KEYS = { profiles: 'type', journal: 'seq' };
const AUTO_MAX = new Set(['modified', 'heartbeat', 'touched', 'updated', 'lastSeen', 'lastOpened', 'savedAt']);
const COUNT_SKIP = new Set(['journal', 'settings', 'profiles']);
const MAX_OPS = 50000;
const PULL_MAX = 3000;
const MISSING = Symbol('missing');

const pad2 = n => String(n).padStart(2, '0');
/** Gabe's iso_local(): local wall-clock, no zone — 'YYYY-MM-DDTHH:MM:SS'. */
function isoLocal(d) {
  d = d || new Date();
  return d.getFullYear() + '-' + pad2(d.getMonth() + 1) + '-' + pad2(d.getDate()) + 'T' + pad2(d.getHours()) + ':' + pad2(d.getMinutes()) + ':' + pad2(d.getSeconds());
}
const isObj = v => v !== null && typeof v === 'object' && !Array.isArray(v);
const keyOf = (store, id) => store + '\u0001' + id;
const rowKey = (store, id) => KEYS[store] || 'id';
const token = n => crypto.randomBytes(n).toString('hex');

/** Python `==` on JSON values: order-insensitive for objects, exact for arrays. */
function eq(a, b) {
  if (a === b) return true;
  if (a === MISSING || b === MISSING) return false;
  if (typeof a !== typeof b) return false;
  if (a === null || b === null) return false;
  if (Array.isArray(a)) {
    if (!Array.isArray(b) || a.length !== b.length) return false;
    for (let i = 0; i < a.length; i++) if (!eq(a[i], b[i])) return false;
    return true;
  }
  if (typeof a === 'object') {
    if (Array.isArray(b)) return false;
    const ka = Object.keys(a), kb = Object.keys(b);
    if (ka.length !== kb.length) return false;
    for (const k of ka) { if (!(k in b)) return false; if (!eq(a[k], b[k])) return false; }
    return true;
  }
  return false;
}
const scalar = x => typeof x === 'string' || typeof x === 'number' || typeof x === 'boolean';
const scalarList = v => Array.isArray(v) && v.every(scalar);
const clone = v => v === undefined ? undefined : JSON.parse(JSON.stringify(v));

/** Three-way merge of one record. Returns { merged, bad: [keys both sides changed differently] }. */
function merge3(prev, mine, cur) {
  if (!isObj(prev)) prev = {};
  const out = Object.assign({}, cur), bad = [];
  const keys = new Set([...Object.keys(mine), ...Object.keys(cur), ...Object.keys(prev)]);
  for (const k of keys) {
    const m = k in mine ? mine[k] : MISSING, c = k in cur ? cur[k] : MISSING, p = k in prev ? prev[k] : MISSING;
    if (eq(m, c) || eq(m, p)) continue;          // same, or only the other side changed it
    if (eq(c, p)) {                               // only this side changed it
      if (m === MISSING) delete out[k]; else out[k] = m;
      continue;
    }
    if (AUTO_MAX.has(k) && typeof m === 'string' && typeof c === 'string') { out[k] = m > c ? m : c; continue; }
    if (scalarList(m) && scalarList(c) && (p === MISSING || scalarList(p))) {
      const pl = p === MISSING ? [] : p;
      out[k] = [...c.filter(x => !(pl.includes(x) && !m.includes(x))), ...m.filter(x => !c.includes(x) && !pl.includes(x))];
      continue;
    }
    bad.push(k);
  }
  return { merged: out, bad };
}

/** A fresh hub state (no record yet). */
function emptyState() {
  return { sid: token(6), seq: 0, minSeq: 0, records: 0, savedAt: null, conflicts: [], meta: {} };
}

/**
 * Plan a push. `rows` is a Map(key → {rec|null, seq, dev, name}) holding ONLY the rows the
 * ops touch (null rec = tombstone, keeps the version). Returns the new state, the row
 * writes, the op docs to append, the merged echo and n (ops committed).
 */
function planPush({ state, rows, dev, conn, name, ops, now }) {
  const st = Object.assign({}, state, { conflicts: (state.conflicts || []).slice() });
  const ts = isoLocal(now);
  const writes = new Map(), commits = [], echo = [];
  let n = 0;
  const cur_ = key => { const r = rows.get(key); return r && isObj(r.rec) ? r.rec : undefined; };
  const commit = (store, id, rec, del) => {
    const key = keyOf(store, id), cur = cur_(key);
    st.seq += 1;
    const op = { seq: st.seq, sid: st.sid, store, id, rec: del ? null : rec, del: !!del, dev, conn: conn || null, name, ts };
    commits.push(op);
    rows.set(key, { rec: del ? null : rec, seq: st.seq, dev, name });
    writes.set(key, { store, id, rec: del ? null : rec, deleted: !!del, seq: st.seq, dev, name });
    if (!COUNT_SKIP.has(store)) { if (del) { if (cur !== undefined) st.records = Math.max(0, st.records - 1); } else if (cur === undefined) st.records += 1; }
  };
  const conflict = (type, store, id, fields, theirs, mine) => {
    const key = keyOf(store, id), last = rows.get(key);
    st.conflicts = st.conflicts.filter(c => !(c.store === store && c.id === id));
    st.conflicts.push({ cid: token(5), type, store, id, fields, theirs: theirs === undefined ? null : theirs, mine: mine === undefined ? null : mine,
      theirsName: (last && last.name) || 'another device', mineName: name, ts });
  };
  for (const o of ops || []) {
    const store = o && o.store, id = o && o.id;
    if (!store || id === undefined || id === null || NOSYNC.has(store)) continue;
    const key = keyOf(store, id), v = rows.get(key), cur = cur_(key), base = Number(o.base || 0);
    const prev = o.prev === undefined ? null : o.prev;
    const others = !!(v && v.seq > base && v.dev !== dev) || (base < st.minSeq && prev !== null && !eq(cur === undefined ? MISSING : cur, prev));
    if (o.del) {
      if (cur === undefined) continue;
      if (others && !eq(cur, prev)) { conflict('delete', store, id, [], cur, null); continue; }
      commit(store, id, null, true); n++; continue;
    }
    const rec = o.rec;
    if (!isObj(rec) || (cur !== undefined && eq(rec, cur))) continue;
    if (!others) { commit(store, id, rec, false); n++; continue; }
    if (cur === undefined) { conflict('deleted', store, id, [], null, rec); continue; }
    const { merged, bad } = merge3(prev, rec, cur);
    if (bad.length) conflict('fields', store, id, bad.sort(), cur, rec);
    if (!eq(merged, cur)) { commit(store, id, merged, false); n++; }
    if (!eq(merged, rec)) echo.push({ store, id, rec: merged, del: false });
  }
  if (st.seq - st.minSeq > MAX_OPS) st.minSeq = st.seq - MAX_OPS;
  return { state: st, writes: [...writes.values()], commits, echo, n, result: { ok: true, sid: st.sid, seq: st.seq, echo, conflicts: st.conflicts.length } };
}

/** The pull reply. `ops` = ops with seq > since in ascending order, at most PULL_MAX of them. */
function pullResult({ state, ops, since, sid, conn }) {
  if (sid !== state.sid || since < state.minSeq) return { ok: true, reset: true, sid: state.sid, seq: state.seq };
  const raw = (ops || []).slice(0, PULL_MAX);
  const news = raw.filter(o => (o.conn || null) !== (conn || null));
  const head = raw.length === PULL_MAX ? raw[raw.length - 1].seq : state.seq;
  return { ok: true, sid: state.sid, seq: head, more: raw.length === PULL_MAX, conflicts: (state.conflicts || []).length,
    ops: news.map(o => ({ store: o.store, id: o.id, rec: o.rec === undefined ? null : o.rec, del: !!o.del, name: o.name || null })) };
}

/** Decide a conflict. `row` = the current row entry for it (or undefined). */
function planResolve({ state, row, cid, pick, dev, name, now }) {
  const st = Object.assign({}, state, { conflicts: (state.conflicts || []).slice() });
  const c = st.conflicts.find(x => x.cid === cid);
  if (!c) return { state: st, writes: [], commits: [], result: { ok: false, error: 'already decided' } };
  st.conflicts = st.conflicts.filter(x => x.cid !== cid);
  const ops = [];
  if (pick === 'mine') {
    const cur = row && isObj(row.rec) ? row.rec : undefined;
    if (c.type === 'delete') { if (cur !== undefined) ops.push({ store: c.store, id: c.id, del: true }); }
    else if (c.type === 'deleted') ops.push({ store: c.store, id: c.id, rec: c.mine });
    else if (cur !== undefined) {
      const rec = Object.assign({}, cur);
      for (const k of c.fields || []) { if (c.mine && k in c.mine) rec[k] = c.mine[k]; else delete rec[k]; }
      ops.push({ store: c.store, id: c.id, rec });
    }
  }
  // the decision is applied as this device's own commit, never merged again
  const rows = new Map(); if (row) rows.set(keyOf(c.store, c.id), row);
  const plan = planPush({ state: Object.assign({}, st, { minSeq: 0 }), rows, dev, conn: null, name, ops: ops.map(o => Object.assign({ base: Number.MAX_SAFE_INTEGER, prev: null }, o)), now });
  plan.state.minSeq = st.minSeq;
  return { state: plan.state, writes: plan.writes, commits: plan.commits, result: { ok: true, conflicts: plan.state.conflicts.length } };
}

/** A whole record from a device replaces everything (new sid; every device reloads). */
function planReplace({ state, obj, now }) {
  if (!obj || !isObj(obj.stores)) throw new Error('not a Scientia export');
  const rows = [], counts = {};
  let records = 0;
  for (const [store, list] of Object.entries(obj.stores)) {
    if (NOSYNC.has(store) || !Array.isArray(list)) continue;
    const k = rowKey(store);
    let c = 0;
    for (const rec of list) {
      if (!isObj(rec) || rec[k] === undefined || rec[k] === null) continue;
      rows.push({ store, id: String(rec[k]), rec, deleted: false, seq: 0, dev: null, name: null }); c++;
    }
    counts[store] = c;
    if (!COUNT_SKIP.has(store)) records += c;
  }
  const meta = {};
  for (const k of ['app', 'format', 'dbName', 'dbVersion', 'epoch', 'build']) if (obj[k] !== undefined) meta[k] = obj[k];
  const st = { sid: token(6), seq: (state ? state.seq : 0) + 1, minSeq: (state ? state.seq : 0) + 1, records, savedAt: new Date(now || Date.now()).toISOString(),
    conflicts: [], meta, counts };
  return { state: st, rows, result: { ok: true, meta: { savedAt: st.savedAt, epoch: meta.epoch, records, counts, build: meta.build, sid: st.sid, syncSeq: st.seq } } };
}

/** The export every device loads on reset. `rows` = every live row [{store, id, rec}]. */
function exportState({ state, rows, reason }) {
  const stores = {}, counts = {};
  for (const r of rows) { if (!r || r.deleted || !isObj(r.rec)) continue; (stores[r.store] = stores[r.store] || []).push(r.rec); }
  for (const [s, l] of Object.entries(stores)) counts[s] = l.length;
  return Object.assign({ app: 'Scientia In Situ', format: 2 }, state.meta || {}, { stores, counts, reason: reason || 'sync',
    savedAt: state.savedAt || new Date().toISOString(), syncSeq: state.seq, sid: state.sid, exportedAt: isoLocal() });
}

function helloResult({ state, who, notebook }) {
  return { ok: true, auth: !!who, local: false, device: who ? who.name : undefined, deviceId: who ? who.id : undefined,
    notebook: notebook !== false, sid: state.sid, seq: state.seq, records: state.records || 0, savedAt: state.savedAt || null, conflicts: (state.conflicts || []).length };
}

/* ---------------- an in-memory hub (fixtures + the local dev hub) ---------------- */
class MemoryHub {
  constructor() { this.st = emptyState(); this.rows = new Map(); this.ops = []; this.media = new Map(); this.keys = new Map(); this.kept = []; }
  async loadState() { return this.st; }
  async hello(who) { return helloResult({ state: this.st, who }); }
  async state(reason) { return exportState({ state: this.st, rows: [...this.rows.values()].map(r => ({ store: r.store, id: r.id, rec: r.rec, deleted: r.rec === null })), reason }); }
  async push({ dev, conn, name, ops }) {
    const touched = new Map();
    for (const o of ops || []) { if (o && o.store && o.id != null) { const k = keyOf(o.store, o.id); if (this.rows.has(k)) touched.set(k, Object.assign({}, this.rows.get(k))); } }
    const plan = planPush({ state: this.st, rows: touched, dev, conn, name, ops });
    this._apply(plan);
    return plan.result;
  }
  _apply(plan) {
    this.st = plan.state;
    for (const w of plan.writes) this.rows.set(keyOf(w.store, w.id), w);
    for (const op of plan.commits) this.ops.push(op);
    if (this.ops.length > MAX_OPS) this.ops = this.ops.slice(-MAX_OPS);
  }
  async pull({ conn, since, sid }) { return pullResult({ state: this.st, ops: this.ops.filter(o => o.seq > since), since, sid, conn }); }
  async conflicts() { return { ok: true, conflicts: this.st.conflicts }; }
  async resolve({ cid, pick, dev, name }) {
    const c = (this.st.conflicts || []).find(x => x.cid === cid);
    const row = c ? this.rows.get(keyOf(c.store, c.id)) : undefined;
    const plan = planResolve({ state: this.st, row: row && Object.assign({}, row), cid, pick, dev, name });
    if (plan.result.ok) this._apply(plan);
    return plan.result;
  }
  async replace(obj) {
    const plan = planReplace({ state: this.st, obj });
    this.st = plan.state; this.rows = new Map(); this.ops = [];
    for (const r of plan.rows) this.rows.set(keyOf(r.store, r.id), r);
    return plan.result;
  }
  async keep(name, raw) { this.kept.push({ name, bytes: raw.length }); return { ok: true, kept: 'memory' }; }
  async mediaPut(path, bytes, mime) { this.media.set(path, { bytes, mime }); const url = (this.fileBase || '') + '/files/' + path; return { ok: true, path, url, bytes: bytes.length }; }
  async mediaList() { const files = {}; for (const [p] of this.media) files[p] = (this.fileBase || '') + '/files/' + p; return { ok: true, files }; }
  async keyMake(name) { const secret = token(16), id = token(5); this.keys.set(id, { id, name, hash: sha(secret), created: isoLocal(), lastSeen: null }); return { ok: true, id, name, secret }; }
  async keyList() { return { ok: true, keys: [...this.keys.values()].map(k => ({ id: k.id, name: k.name, created: k.created, lastSeen: k.lastSeen })) }; }
  async keyRemove(id) { return { ok: this.keys.delete(id) }; }
  async keyFind(secret) { const h = sha(secret); for (const k of this.keys.values()) if (k.hash === h) return k; return null; }
}
const sha = s => crypto.createHash('sha256').update(String(s)).digest('hex');


/* ---------------- the HTTP routes, adapter-agnostic ----------------
   req = { method, path, query, body (parsed JSON or undefined), rawBody (Buffer|null), headers (lowercase map) }
   ctx = { hub, who ({uid, id, name, kind:'browser'|'key'} | null) }
   → { status, body }   (always JSON) */
const MEDIA_MIME = { png: 'image/png', jpg: 'image/jpeg', jpeg: 'image/jpeg', gif: 'image/gif', webp: 'image/webp', bmp: 'image/bmp', tif: 'image/tiff', tiff: 'image/tiff', svg: 'image/svg+xml',
  mp4: 'video/mp4', webm: 'video/webm', mov: 'video/quicktime', m4v: 'video/x-m4v', avif: 'image/avif', html: 'text/html', htm: 'text/html', pdf: 'application/pdf',
  m4a: 'audio/mp4', ogg: 'audio/ogg', wav: 'audio/wav', mp3: 'audio/mpeg', aac: 'audio/aac' };
const MEDIA_EXTS = new Set(['png', 'jpg', 'jpeg', 'gif', 'webp', 'bmp', 'tif', 'tiff', 'svg', 'mp4', 'webm', 'mov', 'm4v', 'avif', 'html', 'htm', 'pdf']);
const REC_EXTS = new Set(['webm', 'm4a', 'mp4', 'ogg', 'wav', 'mp3', 'aac']);
const MAX_MEDIA_BYTES = 30 * 1024 * 1024;
const ONLY_LOCAL = { ok: false, error: 'only on the computer that runs the app' };

function parseBody(req) {
  if (req.body && typeof req.body === 'object' && !Buffer.isBuffer(req.body) && (Object.keys(req.body).length || !(req.rawBody && req.rawBody.length))) return req.body;
  if (req.rawBody && req.rawBody.length) { try { return JSON.parse(req.rawBody.toString('utf8')); } catch (e) { return null; } }
  if (typeof req.body === 'string' && req.body) { try { return JSON.parse(req.body); } catch (e) { return null; } }
  return {};
}

/* ───────── the RM library mirror (V3.869, Phase 1 of V3.866) ─────────
   RM's library (`items` where type=paper and meta.library.is_library_entry) is mirrored into the hub's `library`
   rows in Scientia's own record shape, id = the RM item id, so cites, M.lib(id), the canvas and the vault keep
   working and every device (the web app, the desktop bridge) receives the lab's papers through ordinary sync.
   The mirror runs on hello/state (throttled) and on demand (api/rm/library/refresh); the device is 'rm'. Fields the
   mirror does not own (a desktop-attached pdf when RM has none, flags) survive a re-mirror. */
const MIRROR_MS = 5 * 60 * 1000;
const MIRROR_FIELDS = ['rm', 'rmId', 'kind', 'doi', 'cslType', 'title', 'authors', 'container', 'publisher', 'year', 'volume', 'issue', 'page', 'issn', 'url', 'isPreprint', 'csl', 'rmPdf', 'added', 'rmUpdated'];
function rmItemToLibraryRow(item) {
  const L = (item && isObj(item.meta) && isObj(item.meta.library)) ? item.meta.library : {};
  const id = String(item.id), year = parseInt(L.year, 10) || null;
  const authors = Array.isArray(L.authors) ? L.authors.map(a => typeof a === 'string' ? { family: a, given: '' } : { family: (a && (a.family || a.literal)) || '', given: (a && a.given) || '' }).filter(a => a.family || a.given) : [];
  const container = String(L.journal || ''), doi = String(L.doi || '').toLowerCase(), url = String(L.url || (doi ? 'https://doi.org/' + doi : ''));
  const hasPdf = !!(isObj(L.pdf) && L.pdf.storage_path);
  const type = container ? 'article-journal' : 'posted-content';
  const csl = { id, type, DOI: doi || undefined, title: String(item.title || ''), author: authors.map(a => ({ family: a.family, given: a.given })),
    'container-title': container || undefined, issued: year ? { 'date-parts': [[year]] } : undefined, volume: L.volume ? String(L.volume) : undefined,
    issue: L.issue ? String(L.issue) : undefined, page: L.pages ? String(L.pages) : undefined, ISSN: L.issn ? String(L.issn) : undefined,
    URL: url || undefined, abstract: L.abstract ? String(L.abstract) : undefined, _source: 'rm' };
  for (const k of Object.keys(csl)) if (csl[k] === undefined) delete csl[k];
  return { id, rm: true, rmId: id, kind: 'paper', doi, cslType: type, title: String(item.title || ''), authors, container, publisher: '', year,
    volume: L.volume ? String(L.volume) : '', issue: L.issue ? String(L.issue) : '', page: L.pages ? String(L.pages) : '', issn: L.issn ? String(L.issn) : '',
    url, isPreprint: !container, csl, rmPdf: hasPdf, added: String(L.date_added || item.created_at || ''), rmUpdated: String(item.updated_at || '') };
}
function mirrorSame(cur, row) { return MIRROR_FIELDS.every(k => eq(cur[k] === undefined ? null : cur[k], row[k] === undefined ? null : row[k])); }
/** rows: Map keyOf('library', id) → {rec} of the hub's current library rows. items: RM item docs (with id). */
function planMirror({ state, rows, items }) {
  const seen = new Set(), ops = [];
  for (const it of items || []) {
    if (!it || it.id === undefined || it.id === null) continue;
    const row = rmItemToLibraryRow(it), key = keyOf('library', row.id); seen.add(key);
    const ex = rows.get(key), cur = ex && isObj(ex.rec) ? ex.rec : null;
    if (cur && mirrorSame(cur, row)) continue;
    const rec = Object.assign({}, cur || {}, row);
    if (row.rmPdf) rec.pdf = 'rm:' + row.id; else if (typeof rec.pdf === 'string' && rec.pdf.startsWith('rm:')) rec.pdf = '';
    ops.push({ store: 'library', id: row.id, rec, del: false, prev: cur, base: state.seq });
  }
  for (const [key, ex] of rows) {
    const cur = ex && isObj(ex.rec) ? ex.rec : null;
    if (cur && cur.rm && !seen.has(key)) ops.push({ store: 'library', id: cur.id, rec: null, del: true, prev: cur, base: state.seq });
  }
  return { ops, total: (items || []).length, changed: ops.filter(o => !o.del).length, removed: ops.filter(o => o.del).length };
}
/* ───────── RM inventory for Scientia's materials (V3.870, Phase 1) ─────────
   The web app's Materials picker and page read the lab's inventory through the hub: a compact row per item
   (3,500 docs ≈ 1 MB in Firestore; the function keeps the compact list per instance for ten minutes and searches
   server-side, so a keystroke costs one small response). Nothing is written: usage is logged in RM itself. */
const INVENTORY_MS = 10 * 60 * 1000, INVENTORY_LIMIT = 40;
function rmInventoryRow(doc) {
  const d = doc || {}, id = String(d.id || '');
  const locs = Array.isArray(d.locations) ? d.locations.map(l => typeof l === 'string' ? l : (l && (l.name || l.location || l.label)) || '').filter(Boolean)
    : (d.locations && typeof d.locations === 'object') ? Object.keys(d.locations) : [];
  return { id, kind: d.kind === 'chemical' || d.is_chemical ? 'chemical' : 'item', name: String(d.name || d.description || id), description: String(d.description || '').slice(0, 160),
    category: String(d.category || ''), subcategory: String(d.subcategory || ''), vendor: String(d.vendor || ''), catalogue_number: String(d.catalogue_number || ''),
    quantity: typeof d.quantity === 'number' ? d.quantity : (parseFloat(d.quantity) || 0), stock_status: String(d.stock_status || ''), condition: String(d.condition || ''),
    use_mode: d.use_mode === 'per_use' || d.use_mode === 'package' ? d.use_mode : '', is_consumable: !!d.is_consumable, locations: locs.slice(0, 4), updatedAt: String(d.updatedAt || '') };
}
function searchInventory(items, q, limit) {
  const words = String(q || '').toLowerCase().split(/\s+/).filter(Boolean), n = Math.max(1, Math.min(200, parseInt(limit, 10) || INVENTORY_LIMIT));
  const hay = r => (r.name + ' ' + r.description + ' ' + r.vendor + ' ' + r.catalogue_number + ' ' + r.category + ' ' + r.subcategory).toLowerCase();
  let rows = items || [];
  if (words.length) rows = rows.filter(r => { const H = hay(r); return words.every(w => H.includes(w)); });
  rows = rows.slice().sort((a, b) => {
    if (words.length) { const an = a.name.toLowerCase().startsWith(words[0]) ? 0 : 1, bn = b.name.toLowerCase().startsWith(words[0]) ? 0 : 1; if (an !== bn) return an - bn; }
    return (b.updatedAt || '').localeCompare(a.updatedAt || '') || a.name.localeCompare(b.name);
  });
  return { ok: true, total: rows.length, items: rows.slice(0, n) };
}
/* ───────── RM tasks for Scientia's task components (V3.872, Phase 1) ─────────
   A task component in a note (block kind 'task': body.text, task {due, allDay, prio, repeat, subs, done, log}) becomes
   a task in the person's RM list (userData/{uid}/tasks/{id}, the shape TASK_ASSIGN.writeTaskFor writes, bucket
   'assigned' so My Week offers it). The hub keeps the pairing in its doc (`rmTasks: {taskId: blockId}`) and, on
   hello/state (throttled) or on demand, reconciles DONE both ways — the side that changed later wins. Text, due and
   priority flow Scientia → RM through `api/rm/tasks/update` (the web app posts them as they change). */
const TASKSYNC_MS = 2 * 60 * 1000;
const isoAt = now => isoLocal(now instanceof Date ? now : new Date(now || Date.now()));
const PRIO_IMPORTANCE = { high: 2, normal: 0, low: -1 };
function dueDateOf(due) { const s = String(due || ''); return /^\d{4}-\d{2}-\d{2}/.test(s) ? s.slice(0, 10) : 'TBD'; }
function taskIdNew(now) { return 'task-' + (now || Date.now()).toString(36) + '-' + token(4).toLowerCase().replace(/[^a-z0-9]/g, 'x').slice(0, 4); }
/** The RM task document for a Scientia task block. `b` is what the web app sends: {blockId, docId, text, due, allDay, prio, notes, docTitle, projectName}. */
function rmTaskFromBlock({ uid, name, b, now, id }) {
  const t = String((b && b.text) || '').split('\n')[0].trim() || 'Untitled task';
  const prio = b && PRIO_IMPORTANCE[b.prio] !== undefined ? b.prio : 'normal';
  return { id: id || taskIdNew(now), text: t, bucket: 'assigned', status: 'pending', done: false, done_at: null, due_date: dueDateOf(b && b.due),
    hours_estimate: null, self_importance: PRIO_IMPORTANCE[prio], priority: prio, notes: String((b && b.notes) || ''),
    assignedToUid: uid, assignedToName: String(name || ''), assigned_by_uid: uid, assigned_by_name: String(name || ''),
    created_at: isoAt(now), source: 'scientia', source_ref: { scientia: { docId: String((b && b.docId) || ''), blockId: String((b && b.blockId) || '') },
      docTitle: String((b && b.docTitle) || ''), projectName: String((b && b.projectName) || '') } };
}
/** What `api/rm/tasks/update` may change, from {text, due, allDay, prio, notes, done, doneAt}. */
function rmTaskPatch(u, now) {
  const p = {};
  if (u.text !== undefined) p.text = String(u.text).split('\n')[0].trim() || 'Untitled task';
  if (u.due !== undefined) p.due_date = dueDateOf(u.due);
  if (u.prio !== undefined && PRIO_IMPORTANCE[u.prio] !== undefined) { p.priority = u.prio; p.self_importance = PRIO_IMPORTANCE[u.prio]; }
  if (u.notes !== undefined) p.notes = String(u.notes);
  if (u.done !== undefined) { p.done = !!u.done; p.done_at = u.done ? String(u.doneAt || isoAt(now)) : null; }
  p.updated_at = isoAt(now);
  return p;
}
const timeOf = v => { if (!v) return 0; if (typeof v === 'object' && typeof v.toMillis === 'function') return v.toMillis(); const n = Date.parse(String(v)); return isNaN(n) ? 0 : n; };
/** Reconcile DONE between paired blocks and RM task docs. pairs: [{taskId, blockId, row (hub block row or undefined), task (RM doc or null)}].
    Returns block ops (for hub.push), RM patches, and pairings to drop. */
function planTaskSync({ state, pairs, now }) {
  const ops = [], patches = [], prune = [];
  for (const p of pairs || []) {
    const rec = p.row && isObj(p.row.rec) ? p.row.rec : null, task = p.task || null;
    if (!rec || rec.kind !== 'task' || rec.status !== 'live') {
      prune.push(p.taskId);
      if (task && !task.done && !task.dismissed_at) patches.push({ id: p.taskId, patch: { dismissed_at: isoAt(now), dismissed_reason: 'removed in the notebook', updated_at: isoAt(now) } });
      continue;
    }
    if (!task) { prune.push(p.taskId); continue; }
    const T = isObj(rec.task) ? rec.task : {}, bd = !!T.done, td = !!task.done;
    if (bd === td) continue;
    const bTime = timeOf(bd ? T.done : rec.modified), tTime = timeOf(td ? (task.done_at || task.updated_at || task.updatedAt) : (task.updated_at || task.updatedAt));
    if (bTime >= tTime) {
      patches.push({ id: p.taskId, patch: { done: bd, done_at: bd ? String(T.done) : null, updated_at: isoAt(now) } });
    } else {
      const nt = Object.assign({}, T, { done: td ? String(task.done_at || isoAt(now)) : null, rmDoneAt: td ? String(task.done_at || '') : null });
      if (td) nt.log = (Array.isArray(T.log) ? T.log : []).concat([{ at: nt.done, entryId: null, due: T.due || null, via: 'rm' }]).slice(-200);
      const next = Object.assign({}, rec, { task: nt, modified: isoAt(now) });
      ops.push({ store: 'blocks', id: rec.id, rec: next, del: false, prev: rec, base: state.seq });
    }
  }
  return { ops, patches, prune };
}
/* ───────── Reminders + chores → My Week; timer sessions + edits → RM's activity (V3.874, Phase 1 complete) ─────────
   WHEN: each upcoming occurrence of a Scientia chore (every N days after last done, or on weekdays) or reminder
   (deadline / meeting / reminder; one-off or daily / weekly / monthly) becomes a dated item in the person's RM list
   (userData/{uid}/tasks/sis-<ch|rm>-<id>-<date>, bucket 'assigned', source_ref.kind 'scientia-when' — My Week holds
   it back until its week, like a lab chore). DONE is reconciled three-way on a boolean: the RM doc keeps `sis_done`,
   the value both sides last agreed on; whichever side moved away from it wins (a tick in My Week adds the date to the
   chore's `done` / the reminder's `skip`, or closes a one-off; a tick in Scientia marks the RM item done).
   ACTIVITY: closed timer segments and note edits become one RM tracker event per note per day
   (trackerEntries/{uid}/entries/auto-scientia-note-<docId>-<date>, the ActivitySignals.recordWork shape; no hours —
   minutes ride along as `scientia_minutes` for whoever wants them). Dates are the lab's local days. */
const LAB_TZ = 'America/Phoenix';
const WHEN_MS = 2 * 60 * 1000, ACT_MS = 2 * 60 * 1000, WHEN_AHEAD = 13, WHEN_BEHIND = 7, ACT_DAYS = 3;
const isDay = s => /^\d{4}-\d{2}-\d{2}$/.test(String(s || ''));
const dayN = s => Date.UTC(+s.slice(0, 4), +s.slice(5, 7) - 1, +s.slice(8, 10)) / 864e5;
const dayS = n => new Date(Math.round(n) * 864e5).toISOString().slice(0, 10);
const addDays_ = (s, k) => dayS(dayN(s) + k);
const wdayOf = s => new Date(dayN(s) * 864e5).getUTCDay();
function todayIn(tz, now) { const t = new Date(now == null ? Date.now() : now); try { return t.toLocaleDateString('en-CA', { timeZone: tz || LAB_TZ }); } catch (e) { return t.toISOString().slice(0, 10); } }
function nowIn(tz, now) { const t = new Date(now == null ? Date.now() : now); try { return t.toLocaleString('sv-SE', { timeZone: tz || LAB_TZ }).replace(' ', 'T'); } catch (e) { return t.toISOString().slice(0, 19); } }
/** An RM time (ISO with Z, a naive local string, or a day) → the lab's local day. */
function localDayOf(v, tz) {
  if (!v) return null; const s = String(v);
  if (isDay(s) || /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}(:\d{2}(\.\d+)?)?$/.test(s)) return s.slice(0, 10);
  const n = Date.parse(s); return isNaN(n) ? null : todayIn(tz, n);
}
const safeIdPart = s => String(s == null ? '' : s).replace(/[^a-zA-Z0-9._-]/g, '_').slice(0, 80);

function choreDone(c) { return (Array.isArray(c && c.done) ? c.done : []).filter(isDay).sort(); }
/** An interval chore's open occurrence: last done (or its start) + every N days. */
function choreNext(c) { const d = choreDone(c), base = d.length ? d[d.length - 1] : (isDay(c && c.start) ? c.start : null); return base ? addDays_(base, Math.max(1, Math.round(+c.every || 1))) : null; }
const isRepeat = r => !!(r && r.repeat && r.repeat !== 'none');
const remDay = r => (r && typeof r.at === 'string' && isDay(r.at.slice(0, 10))) ? r.at.slice(0, 10) : null;
function remOccursOn(r, day) {
  const s = remDay(r); if (!s || day < s) return false;
  if (!isRepeat(r)) return day === s;
  if (r.repeat === 'daily') return true;
  if (r.repeat === 'weekly') return (dayN(day) - dayN(s)) % 7 === 0;
  if (r.repeat === 'monthly') return day.slice(8, 10) === s.slice(8, 10);
  return false;
}
const isWhenReminder = r => !!(r && r.id && r.kind !== 'task' && !String(r.id).startsWith('rt_'));
/** Is this occurrence still one, and is it done in Scientia? */
function whenOcc(store, rec, day) {
  if (!rec) return { valid: false, done: false };
  if (store === 'chores') {
    if (rec.active === false) return { valid: false, done: false };
    const done = choreDone(rec);
    if (rec.mode === 'weekdays') return { valid: day >= (rec.start || '0000') && (rec.days || []).includes(wdayOf(day)), done: done.includes(day) };
    const d = done.some(x => x >= day); return { valid: d || day === choreNext(rec), done: d };
  }
  if (!isWhenReminder(rec)) return { valid: false, done: false };
  if (!remOccursOn(rec, day)) return { valid: false, done: false };
  return { valid: true, done: !!rec.done || (isRepeat(rec) && (rec.skip || []).includes(day)) };
}
const whenTaskId = (store, id, day) => 'sis-' + (store === 'chores' ? 'ch' : 'rm') + '-' + safeIdPart(id) + '-' + day;
function whenLabel(store, rec) { return store === 'chores' ? 'Chore' : ({ deadline: 'Deadline', meeting: 'Meeting' }[rec && rec.kind] || 'Reminder'); }
function whenText(store, rec) {
  if (store === 'chores') return String((rec && rec.title) || 'Chore').trim() || 'Chore';
  const m = !rec.allDay && typeof rec.at === 'string' ? rec.at.match(/T(\d{2}:\d{2})/) : null, t = String(rec.title || 'Reminder').trim() || 'Reminder';
  return (rec.kind === 'deadline' ? 'Deadline: ' : rec.kind === 'meeting' ? 'Meeting: ' : '') + t + (m ? ' · ' + m[1] : '');
}
/** The occurrences that should exist in RM now (before reconciling). */
function whenCandidates({ chores, reminders, today }) {
  const out = [], to = addDays_(today, WHEN_AHEAD), back = addDays_(today, -WHEN_BEHIND);
  for (const c of chores || []) {
    if (!c || !c.id || c.active === false) continue;
    if (c.mode === 'weekdays') { for (let d = today; d <= to; d = addDays_(d, 1)) { const o = whenOcc('chores', c, d); if (o.valid && !o.done) out.push({ store: 'chores', id: String(c.id), date: d }); } }
    else { const d = choreNext(c); if (d && d <= to) out.push({ store: 'chores', id: String(c.id), date: d }); }
  }
  for (const r of reminders || []) {
    if (!isWhenReminder(r) || r.done) continue;
    if (!isRepeat(r)) { const d = remDay(r); if (d && d >= back && d <= to) out.push({ store: 'reminders', id: String(r.id), date: d }); continue; }
    for (let d = today; d <= to; d = addDays_(d, 1)) { const o = whenOcc('reminders', r, d); if (o.valid && !o.done) out.push({ store: 'reminders', id: String(r.id), date: d }); }
  }
  return out.map(o => Object.assign(o, { taskId: whenTaskId(o.store, o.id, o.date) }));
}
function rmWhenTask({ uid, name, store, rec, date, done, now }) {
  return { id: whenTaskId(store, rec.id, date), text: whenText(store, rec), bucket: 'assigned', status: 'pending', done: !!done, done_at: done ? nowIn(LAB_TZ, now) : null,
    due_date: date, hours_estimate: null, self_importance: 0, priority: 'normal', notes: store === 'reminders' ? String(rec.notes || '') : '',
    assignedToUid: uid, assignedToName: String(name || ''), assigned_by_uid: uid, assigned_by_name: String(name || ''), created_at: nowIn(LAB_TZ, now), source: 'scientia',
    source_ref: { kind: 'scientia-when', label: whenLabel(store, rec), scientia: { store, id: String(rec.id), date } }, sis_done: !!done };
}
/** tracked: {taskId: {store, id, date}}; tasks: Map taskId → RM doc | null (tracked ∪ candidate ids). */
function planWhen({ state, chores, reminders, tracked, tasks, today, uid, name, now }) {
  const recs = { chores: new Map((chores || []).filter(Boolean).map(c => [String(c.id), c])), reminders: new Map((reminders || []).filter(Boolean).map(r => [String(r.id), r])) };
  const work = new Map(), creates = [], patches = [], track = {}, untrack = [], stale = addDays_(today, -WHEN_BEHIND), at = nowIn(LAB_TZ, now);
  const cur = (store, id) => { const k = store + '/' + id; return work.has(k) ? work.get(k).rec : (recs[store].get(String(id)) || null); };
  const edit = (store, id) => { const k = store + '/' + id; if (!work.has(k)) { const orig = recs[store].get(String(id)); work.set(k, { store, id: String(id), prev: orig, rec: JSON.parse(JSON.stringify(orig)) }); } return work.get(k).rec; };
  const applyDone = (ref, done, task) => {
    const r = edit(ref.store, ref.id);
    if (ref.store === 'chores') {
      const list = choreDone(r);
      if (r.mode === 'weekdays') r.done = done ? [...new Set(list.concat([ref.date]))].sort() : list.filter(x => x !== ref.date);
      else if (done) { const day = localDayOf(task.done_at, LAB_TZ) || today; r.done = [...new Set(list.concat([day > ref.date ? day : ref.date]))].sort(); }
      else { const hit = list.find(x => x >= ref.date); r.done = list.filter(x => x !== hit); }
    } else if (!isRepeat(r)) { if (done) r.done = String(task.done_at || at); else delete r.done; r.modified = at; }
    else { const sk = Array.isArray(r.skip) ? r.skip.slice() : []; r.skip = done ? [...new Set(sk.concat([ref.date]))].slice(-60) : sk.filter(x => x !== ref.date); r.modified = at; }
  };
  for (const [taskId, ref] of Object.entries(tracked || {})) {
    const task = tasks.get(taskId) || null;
    if (!task) { untrack.push(taskId); continue; }
    const occ = whenOcc(ref.store, cur(ref.store, ref.id), ref.date);
    if (!occ.valid) { if (!task.done && !task.dismissed_at) patches.push({ id: taskId, patch: { dismissed_at: at, dismissed_reason: 'gone from Scientia', updated_at: at } }); untrack.push(taskId); continue; }
    if (task.dismissed_at) { if (ref.date < stale) untrack.push(taskId); continue; }
    const s = !!occ.done, r = !!task.done, a = !!task.sis_done;
    if (s === r) { if (a !== s) patches.push({ id: taskId, patch: { sis_done: s } }); }
    else if (s !== a) patches.push({ id: taskId, patch: { done: s, done_at: s ? at : null, sis_done: s, updated_at: at } });
    else { applyDone(ref, r, task); patches.push({ id: taskId, patch: { sis_done: r } }); }
    if ((s || r) && ref.date < stale) untrack.push(taskId);
  }
  // occurrences to create — computed AFTER the edits above (a chore ticked in My Week moves its next occurrence)
  const after = { chores: [...recs.chores.keys()].map(id => cur('chores', id)), reminders: [...recs.reminders.keys()].map(id => cur('reminders', id)) };
  for (const c of whenCandidates({ chores: after.chores, reminders: after.reminders, today })) {
    if ((tracked || {})[c.taskId] || track[c.taskId]) continue;
    const ex = tasks.get(c.taskId);
    track[c.taskId] = { store: c.store, id: c.id, date: c.date };
    if (ex) continue;   // made earlier and lost from the map: tracked again, not rewritten
    creates.push(rmWhenTask({ uid, name, store: c.store, rec: cur(c.store, c.id), date: c.date, done: false, now }));
  }
  const ops = [...work.values()].map(w => ({ store: w.store, id: w.id, rec: w.rec, del: false, prev: w.prev, base: state.seq }));
  return { creates, patches, ops, track, untrack };
}

/** {day: seconds} from a session's CLOSED segments (a running one counts when it is paused or stopped). */
function sessionDaySeconds(s) {
  const out = {};
  for (const g of (s && Array.isArray(s.segments) ? s.segments : [])) {
    if (!g || !g.s || !g.e) continue; const a = Date.parse(g.s), b = Date.parse(g.e);
    if (isNaN(a) || isNaN(b) || b <= a) continue; const d = String(g.s).slice(0, 10); if (isDay(d)) out[d] = (out[d] || 0) + Math.round((b - a) / 1000);
  }
  return out;
}
const actEventId = (docId, day) => 'auto-scientia-note-' + safeIdPart(docId) + '-' + safeIdPart(day);
/** changes: [{store: 'sessions'|'documents', rec}] → Map eventId → {id, docId, date, sessions: {sid: secs}, edited}. */
function activityGroups({ changes, today, from }) {
  const out = new Map(), grp = (docId, date) => { const id = actEventId(docId, date); if (!out.has(id)) out.set(id, { id, docId: String(docId), date, sessions: {}, edited: false }); return out.get(id); };
  for (const ch of changes || []) {
    const rec = ch && ch.rec; if (!rec) continue;
    if (ch.store === 'sessions') { if (!rec.docId || !rec.id) continue; for (const [d, secs] of Object.entries(sessionDaySeconds(rec))) if (d >= from && d <= today) grp(rec.docId, d).sessions[rec.id] = secs; }
    else if (ch.store === 'documents') { const d = String(rec.modified || '').slice(0, 10); if (!rec.id || rec.archived || !isDay(d) || d < from || d > today) continue; grp(rec.id, d).edited = true; }
  }
  return out;
}
function fmtMinutes(secs) { const m = Math.round(secs / 60); return m < 60 ? m + ' min' : Math.floor(m / 60) + ' h' + (m % 60 ? ' ' + (m % 60) + ' min' : ''); }
/** groups (activityGroups), docs: Map docId → note record (titles), existing: Map eventId → event doc | null → [{id, data, isNew}]. */
function planActivity({ groups, docs, existing }) {
  const writes = [];
  for (const g of groups.values()) {
    const ex = existing.get(g.id) || null;
    if (ex && ex.status && ex.status !== 'pending') continue;           // an hours-era decision stays
    const sessions = Object.assign({}, (ex && ex.scientia_sessions) || {}, g.sessions), secs = Object.values(sessions).reduce((a, b) => a + (+b || 0), 0);
    const edited = !!(ex && ex.scientia_edited) || g.edited, doc = docs.get(g.docId) || {};
    const text = 'Scientia: ' + (doc.title || 'a note') + (secs >= 60 ? ' · ' + fmtMinutes(secs) + ' timed' : '');
    const data = { date: g.date, text: text.slice(0, 500), categoryPath: ['research', 'notebook'], kind: 'work', source: 'scientia',
      source_ref: { kind: 'scientia-note', id: g.docId, path: '/rm/pages/notebook.html?notebook=scientia&note=' + encodeURIComponent(g.docId) },
      scheduled_for: null, scientia_sessions: sessions, scientia_minutes: Math.round(secs / 60), scientia_edited: edited, scientia_type: String(doc.type || '') };
    if (ex && ex.text === data.text && ex.scientia_minutes === data.scientia_minutes && !!ex.scientia_edited === edited && eq(ex.scientia_sessions || {}, sessions)) continue;
    writes.push({ id: g.id, data, isNew: !ex });
  }
  return writes;
}

/* ───────── RM highlights for Scientia's paper card (V3.875, Phase 2) ─────────
   papers/{paperId}/annotations/{id}: what the Firestore rule lets the person read (visibility 'lab', or their own),
   as compact rows for the card — colour, page, the quoted text, the comment, mine or the lab's. Read-only. */
const tsText = v => (v && typeof v === 'object' && typeof v.toDate === 'function') ? v.toDate().toISOString() : (v ? String(v) : '');
function rmAnnotationRow(doc, uid) {
  const d = doc || {}, pages = d.target && Array.isArray(d.target.pages) ? d.target.pages : [], pg = pages[0] || {}, q = (pg.selectors && pg.selectors.textQuote) || {};
  const by = d.creator || {};
  return { id: String(d.id || ''), color: String(d.color_id || 'yellow'), type: String(d.annotation_type || 'note'), page: pg.page != null && !isNaN(+pg.page) ? +pg.page : null,
    exact: String(q.exact || '').slice(0, 400), comment: String(d.comment || '').slice(0, 400), mine: !!(by.uid && by.uid === uid),
    by: String(by.displayName || by.email || ''), at: tsText(d.created || d.created_at) };
}
function visibleAnnotations(docs, uid) {
  return (docs || []).filter(d => d && !d.deleted && (d.visibility === 'lab' || (d.creator && d.creator.uid === uid)))
    .map(d => rmAnnotationRow(d, uid)).sort((a, b) => (a.page == null ? 1e9 : a.page) - (b.page == null ? 1e9 : b.page) || a.at.localeCompare(b.at));
}

/* ───────── RM protocols and collections for Scientia (V3.877, Phase 2 part 2) — read-only ─────────
   PROTOCOLS: protocols/{id} {title, status, tree {sections [{label, children [{kind, body, attrs}]}]}, current_version,
   updated_at} — the editor flushes the Yjs tree back to `tree` 1.5 s after an edit, so it is current. Scientia runs a
   protocol as its own (a list of step texts): steps become steps, notes / safety / callouts become "Note: …" steps, the
   first step of each section carries the section's name, `[!var:x]` (a calculator value) becomes ‹x›, and what has no
   step form (formulas, calculators, tables, figures…) is counted so the run can say "open it in RM for those".
   COLLECTIONS: userData/{uid}/litReviews/{itemId} — the Lab Notebook's mirror of each 📑 collection (V3.859). */
const stripTags = s => String(s == null ? '' : s).replace(/<br\s*\/?>/gi, '\n').replace(/<[^>]+>/g, '').replace(/&nbsp;/g, ' ').replace(/&amp;/g, '&').replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&quot;/g, '"').replace(/&#0?39;/g, "'");
const varsToText = s => String(s || '').replace(/\[!var:([A-Za-z0-9_.-]+)\]/g, (m, n) => '‹' + n + '›');
const STEP_NOTE_KINDS = new Set(['note', 'safety', 'callout']);
function rmProtocolRow(doc) {
  const d = doc || {}, secs = d.tree && Array.isArray(d.tree.sections) ? d.tree.sections : [];
  const steps = secs.reduce((n, s) => n + (Array.isArray(s && s.children) ? s.children.filter(c => c && c.kind === 'step' && c.status !== 'removed' && stripTags(c.body).trim()).length : 0), 0);
  return { id: String(d.id || ''), title: String(d.title || (d.tree && d.tree.meta && d.tree.meta.title) || d.id || 'Protocol'), status: String(d.status || 'draft'),
    category: String(d.category || ''), version: d.current_version != null ? d.current_version : null, updated_at: String(d.updated_at || ''), steps, sections: secs.length };
}
function rmProtocolSteps(doc) {
  const d = doc || {}, row = rmProtocolRow(d), secs = d.tree && Array.isArray(d.tree.sections) ? d.tree.sections.slice().sort((a, b) => (+a.order || 0) - (+b.order || 0)) : [];
  const steps = [], skipped = {};
  for (const s of secs) {
    let first = true;
    for (const c of (Array.isArray(s && s.children) ? s.children : [])) {
      if (!c || c.status === 'removed') continue;
      const text = varsToText(stripTags(c.body)).replace(/[ \t]+\n/g, '\n').trim();
      if (c.kind === 'step' || (STEP_NOTE_KINDS.has(c.kind) && text)) {
        if (!text) continue;
        const label = String((s && s.label) || '').trim();
        steps.push({ id: String(c.id || ''), kind: c.kind, section: label, text: (first && label ? label + ': ' : '') + (c.kind === 'step' ? '' : 'Note: ') + text });
        first = false;
      } else if (c.kind && c.kind !== 'docHeader' && c.kind !== 'heading' && c.kind !== 'step' && !STEP_NOTE_KINDS.has(c.kind)) skipped[c.kind] = (skipped[c.kind] || 0) + 1;
    }
  }
  return Object.assign(row, { steps: steps.length, list: steps, skipped, url: '/rm/pages/protocols.html?protocol=' + encodeURIComponent(row.id) });
}
function searchProtocols(rows, q) {
  const words = String(q || '').toLowerCase().split(/\s+/).filter(Boolean);
  return rows.filter(r => r.status !== 'archived' && words.every(w => (r.title + ' ' + r.category + ' ' + r.id).toLowerCase().includes(w)))
    .sort((a, b) => (b.updated_at || '').localeCompare(a.updated_at || '') || a.title.localeCompare(b.title));
}
function rmCollectionRow(doc) {
  const d = doc || {}, c = d.counts || {};
  return { id: String(d.itemId || d.id || ''), title: String(d.title || (d.claim ? 'Claim' : 'Collection')), entryId: String(d.entryId || ''), boardId: String(d.boardId || ''),
    papers: d.papers && typeof d.papers === 'object' ? Object.keys(d.papers).length : 0, entries: Array.isArray(d.entries) ? d.entries.length : 0,
    claim: !!d.claim, updated_at: String(d.updated_at || ''), counts: c };
}
function rmCollectionFull(doc) {
  const d = doc || {}, row = rmCollectionRow(d), P = d.papers && typeof d.papers === 'object' ? d.papers : {};
  return Object.assign(row, {
    query: String(d.query || ''), keyPoints: (Array.isArray(d.keyPoints) ? d.keyPoints : []).map(String).filter(Boolean).slice(0, 20),
    paperList: Object.keys(P).map(id => ({ paperId: id, title: String((P[id] && P[id].title) || ''), cite: String((P[id] && P[id].cite) || ''), why: String((P[id] && P[id].why) || '') })),
    entryList: (Array.isArray(d.entries) ? d.entries : []).slice(0, 60).map(e => ({ type: String(e.type || ''), rel: String(e.rel || ''), quote: String(e.quote || '').slice(0, 500), name: String(e.name || ''), cite: String(e.cite || ''), hex: String(e.hex || ''), paperId: String(e.paperId || '') })),
    claimText: d.claim ? String(d.claim.statement || '') : '', drafts: (Array.isArray(d.drafts) ? d.drafts : []).map(x => ({ id: String(x.id || ''), title: String(x.title || '') })) });
}

async function mirrorQuietly(hub, who, force, only) {
  if (!hub || !who) return null;
  if (typeof hub.quietSyncs === 'function') { try { return await hub.quietSyncs(who, { force: !!force, only: only || null }); } catch (e) { return { ok: false, error: String(e.message || e) }; } }
  if (typeof hub.mirrorLibrary === 'function') { try { await hub.mirrorLibrary({}); } catch (e) { /* the library mirror never breaks hello */ } }
  if (typeof hub.syncTasks === 'function') { try { await hub.syncTasks({}); } catch (e) { /* nor does the task sync */ } }
  return null;
}

async function route(req, ctx) {
  const { hub, who } = ctx, q = req.query || {}, p = String(req.path || '/').replace(/\/+$/, '') || '/', post = req.method === 'POST';
  const J = (status, body) => ({ status, body });
  const g = (k, d) => (q[k] === undefined ? d : String(q[k]));
  if (p === '/api/sync/hello') { await mirrorQuietly(hub, who); return J(200, helloResult({ state: who && hub ? await hub.loadState() : emptyState(), who })); }
  if (!who) return J(401, { ok: false, error: 'not signed in' });
  if (p === '/api/rm/library/refresh' && post) {
    if (typeof hub.mirrorLibrary !== 'function') return J(200, { ok: false, error: 'no RM library on this hub' });
    return J(200, await hub.mirrorLibrary({ force: true }));
  }
  if (p === '/api/rm/library/pdf') {
    if (typeof hub.rmPdfUrl !== 'function') return J(404, { ok: false, error: 'no RM library on this hub' });
    const r = await hub.rmPdfUrl(g('id', '')); return J(r.ok ? 200 : 404, r);
  }
  if (p.startsWith('/api/rm/tasks')) {
    if (typeof hub.createTask !== 'function') return J(200, { ok: false, error: 'no RM tasks on this hub' });
    if (p === '/api/rm/tasks' && post) { const b = parseBody(req) || {}; if (!b.blockId) return J(400, { ok: false, error: 'blockId required' }); return J(200, await hub.createTask({ who, b })); }
    if (p === '/api/rm/tasks/update' && post) { const b = parseBody(req) || {}; if (!b.id) return J(400, { ok: false, error: 'id required' }); return J(200, await hub.updateTask({ who, u: b })); }
    if (p === '/api/rm/tasks/sync' && post) return J(200, await hub.syncTasks({ force: true }));
    if (p === '/api/rm/tasks' && !post) return J(200, await hub.getTasks({ ids: g('ids', '') ? g('ids', '').split(',').map(s => s.trim()).filter(Boolean) : null }));
    return J(404, { ok: false });
  }
  if (p === '/api/rm/protocols') {
    if (typeof hub.protocols !== 'function') return J(200, { ok: false, error: 'no RM protocols on this hub', items: [] });
    return J(200, await hub.protocols({ q: g('q', ''), id: g('id', '') }));
  }
  if (p === '/api/rm/collections') {
    if (typeof hub.collections !== 'function') return J(200, { ok: false, error: 'no RM collections on this hub', items: [] });
    return J(200, await hub.collections({ id: g('id', '') }));
  }
  if (p === '/api/rm/annotations') {
    if (typeof hub.annotations !== 'function') return J(200, { ok: false, error: 'no RM highlights on this hub', items: [] });
    const paperId = g('paperId', '').trim(); if (!paperId) return J(400, { ok: false, error: 'paperId required' });
    return J(200, await hub.annotations({ paperId }));
  }
  if (p === '/api/rm/inventory') {
    if (typeof hub.inventory !== 'function') return J(200, { ok: false, error: 'no RM inventory on this hub', items: [], total: 0 });
    return J(200, await hub.inventory({ q: g('q', ''), limit: g('limit', ''), ids: g('ids', '') ? g('ids', '').split(',').map(s => s.trim()).filter(Boolean) : null }));
  }
  if (p === '/api/sync/state' || (p === '/api/snapshot' && !post)) {
    await mirrorQuietly(hub, who);
    const st = await hub.loadState();
    if (p === '/api/snapshot' && !st.seq && !st.records) return J(404, { ok: false });
    return J(200, await hub.state('state'));
  }
  if (p === '/api/sync/pull') {
    // V3.874: every connected device's long-poll keeps RM and the notebook reconciled (each sync is throttled)
    await mirrorQuietly(hub, who);
    return J(200, await hub.pull({ conn: g('conn', ''), since: parseInt(g('since', '0'), 10) || 0, sid: g('sid', '') }));
  }
  if (p === '/api/rm/sync' && post) {
    if (typeof hub.quietSyncs !== 'function') return J(200, { ok: false, error: 'no RM sync on this hub' });
    const only = g('only', '') ? g('only', '').split(',').map(s => s.trim()).filter(Boolean) : null;
    return J(200, Object.assign({ ok: true }, await mirrorQuietly(hub, who, true, only)));
  }
  if (p === '/api/sync/push' && post) {
    const obj = parseBody(req) || {}, st = await hub.loadState();
    if (obj.sid && obj.sid !== st.sid && !obj.anySid) return J(200, { ok: false, reset: true, sid: st.sid });
    return J(200, await hub.push({ dev: String(obj.dev || who.id), conn: obj.conn || null, name: String(obj.name || who.name || 'a device'), ops: Array.isArray(obj.ops) ? obj.ops : [] }));
  }
  if (p === '/api/sync/conflicts') return J(200, await hub.conflicts());
  if (p === '/api/sync/resolve' && post) { const obj = parseBody(req) || {}; return J(200, await hub.resolve({ cid: obj.cid, pick: obj.pick, dev: String(obj.dev || who.id), name: String(obj.name || who.name || 'a device') })); }
  if (p === '/api/snapshot' && post) {
    const keep = g('keep', ''), raw = req.rawBody || Buffer.from(typeof req.body === 'string' ? req.body : JSON.stringify(req.body || {}));
    const obj = parseBody(req);
    if (!obj || !isObj(obj) || !isObj(obj.stores)) return J(400, { ok: false, error: 'not a Scientia export' });
    if (keep) return J(200, await hub.keep(keep.replace(/[^A-Za-z0-9_-]+/g, '-').slice(0, 40) || 'kept', raw));
    return J(200, await hub.replace(obj));
  }
  if (p === '/api/ping') return J(200, { ok: true, images: 'images', data: false, notebook: 'cloud' });
  if (p === '/api/notebook' && !post) { const st = await hub.loadState(); return J(200, { ok: true, path: 'cloud', record: st.records || st.seq ? { savedAt: st.savedAt, records: st.records, syncSeq: st.seq, sid: st.sid } : null, config: null, recent: [] }); }
  if (p === '/api/media' && post) {
    const id = g('id', ''), ext = g('ext', '').toLowerCase();
    if (!/^[A-Za-z0-9_-]{1,64}$/.test(id) || !MEDIA_EXTS.has(ext)) return J(400, { ok: false, error: 'bad name' });
    const bytes = req.rawBody; if (!bytes || !bytes.length) return J(400, { ok: false, error: 'bad size' });
    if (bytes.length > MAX_MEDIA_BYTES) return J(413, { ok: false, error: 'over 30 MB — keep this file on your computer' });
    return J(200, await hub.mediaPut('images/' + id + '.' + ext, bytes, MEDIA_MIME[ext] || 'application/octet-stream'));
  }
  if (p === '/api/media/list') return J(200, await hub.mediaList());
  if (p === '/api/rec' && post) {
    const ext = g('ext', '').toLowerCase(); if (!REC_EXTS.has(ext)) return J(400, { ok: false, error: 'not an audio file' });
    const bytes = req.rawBody; if (!bytes || !bytes.length) return J(400, { ok: false, error: 'empty recording' });
    if (bytes.length > MAX_MEDIA_BYTES) return J(413, { ok: false, error: 'over 30 MB — keep this recording on your computer' });
    const base = g('name', '').replace(/[^A-Za-z0-9 _.()-]+/g, '').replace(/^[ .]+|[ .]+$/g, '').slice(0, 90) || isoLocal().replace(/[:T]/g, '-');
    const have = (await hub.mediaList()).files || {}; let name = base + '.' + ext, k = 2;
    while (have['recordings/' + name]) { name = base + ' (' + k + ').' + ext; k++; }
    const r = await hub.mediaPut('recordings/' + name, bytes, MEDIA_MIME[ext] || 'application/octet-stream');
    return J(200, { ok: true, file: name, path: 'recordings/' + name, bytes: bytes.length, job: {}, folder: 'cloud', url: r.url });
  }
  if (p === '/api/rec/status') return J(200, { ok: false, state: 'none', error: 'transcription runs on your computer' });
  if (p === '/api/rec/transcribe') return J(200, { ok: false, error: 'transcription runs on your computer (the desktop app transcribes recordings in its folder)' });
  // desktop sync keys — from the signed-in browser only (never from a key)
  if (p.startsWith('/api/cloud/')) {
    if (who.kind !== 'browser') return J(403, { ok: false, error: 'manage keys from the lab site' });
    if (p === '/api/cloud/keys') return J(200, await hub.keyList());
    if (p === '/api/cloud/key' && post) { const obj = parseBody(req) || {}; const r = await hub.keyMake(String(obj.name || 'My computer').slice(0, 40)); return J(200, { ok: true, id: r.id, name: r.name, key: 'sck_' + who.uid + '_' + r.secret }); }
    if (p === '/api/cloud/key/remove' && post) { const obj = parseBody(req) || {}; return J(200, await hub.keyRemove(String(obj.id || ''))); }
    return J(404, { ok: false });
  }
  // the desktop-only endpoints answer like a computer that has none of it
  if (p === '/api/net') return J(200, { ok: true, port: 0, lan: [], tailscale: { installed: false } });
  if (p === '/api/pair/pending') return J(200, { ok: true, pending: [] });
  if (p === '/api/devices') return J(200, { ok: true, devices: [] });
  if (p === '/api/pair/status') return J(200, { ok: true, state: 'unknown' });
  if (p === '/api/hw/status') return J(200, { ok: false, installed: false, state: 'none' });
  if (p === '/api/stt/status') return J(200, { ok: false, installed: false, state: 'none' });
  if (p === '/api/slides/status') return J(200, { ok: false, available: false });
  if (p === '/api/vault' && !post) return J(200, { ok: true, files: [] });
  if (p === '/api/vault' && post) return J(200, { ok: true, wrote: 0, removed: 0 });
  if (post && ['/api/pair/new', '/api/pair/claim', '/api/pair/decide', '/api/devices/remove', '/api/devices/rename', '/api/tailscale/serve', '/api/hw/install', '/api/stt/install',
    '/api/ink/read', '/api/ink/lang', '/api/hw/read', '/api/slides', '/api/notebook', '/api/notebook/browse'].includes(p)) return J(200, ONLY_LOCAL);
  return J(404, { ok: false, error: 'no such route' });
}

/* the in-memory hub mirrors whatever `hub.rmItems` holds (tests, the dev hub) */
MemoryHub.prototype.mirrorLibrary = async function ({ force } = {}) {
  const now = Date.now();
  if (!force && this.mirrorAt && now - this.mirrorAt < MIRROR_MS) return { ok: true, skipped: true, total: this.mirrorN || 0 };
  const rows = new Map();
  for (const [key, row] of this.libraryRows()) rows.set(key, row);
  const plan = planMirror({ state: this.st, rows, items: this.rmItems || [] });
  if (plan.ops.length) await this.push({ dev: 'rm', conn: null, name: 'RM library', ops: plan.ops });
  this.mirrorAt = now; this.mirrorN = plan.total; this.mirrorRuns = (this.mirrorRuns || 0) + 1;
  return { ok: true, total: plan.total, written: plan.ops.length, changed: plan.changed, removed: plan.removed };
};
/* the in-memory hub keeps RM task docs in `rmTaskDocs` (Map id → doc) and the pairing in `rmTasks` (Map taskId → blockId) */
MemoryHub.prototype._taskStore = function () { if (!this.rmTaskDocs) this.rmTaskDocs = new Map(); if (!this.rmTasks) this.rmTasks = new Map(); };
MemoryHub.prototype.createTask = async function ({ who, b }) {
  this._taskStore();
  const existing = [...this.rmTasks].find(([, blockId]) => blockId === String(b.blockId));
  if (existing && this.rmTaskDocs.has(existing[0])) return { ok: true, id: existing[0], task: this.rmTaskDocs.get(existing[0]), existed: true };
  const task = rmTaskFromBlock({ uid: who.id, name: who.name, b, now: Date.now() });
  this.rmTaskDocs.set(task.id, task); this.rmTasks.set(task.id, String(b.blockId));
  return { ok: true, id: task.id, task };
};
MemoryHub.prototype.updateTask = async function ({ u }) {
  this._taskStore();
  const id = String(u.id || ''); if (!this.rmTasks.has(id)) return { ok: false, error: 'not a task the notebook made' };
  const cur = this.rmTaskDocs.get(id); if (!cur) return { ok: false, error: 'the task is gone from RM' };
  const next = Object.assign({}, cur, rmTaskPatch(u, Date.now())); this.rmTaskDocs.set(id, next);
  return { ok: true, id, task: next };
};
MemoryHub.prototype.getTasks = async function ({ ids } = {}) {
  this._taskStore();
  const pick = ids && ids.length ? ids : [...this.rmTasks.keys()];
  return { ok: true, tasks: pick.map(id => this.rmTaskDocs.get(id)).filter(Boolean).map(t => ({ id: t.id, text: t.text, done: !!t.done, done_at: t.done_at || null, due_date: t.due_date, priority: t.priority, planned_item_id: t.planned_item_id || null, dismissed_at: t.dismissed_at || null })) };
};
MemoryHub.prototype.syncTasks = async function ({ force } = {}) {
  this._taskStore();
  const now = Date.now();
  if (!force && this.taskSyncAt && now - this.taskSyncAt < TASKSYNC_MS) return { ok: true, skipped: true };
  const pairs = [...this.rmTasks].map(([taskId, blockId]) => ({ taskId, blockId, row: this.rows.get(keyOf('blocks', blockId)), task: this.rmTaskDocs.get(taskId) || null }));
  const plan = planTaskSync({ state: this.st, pairs, now });
  if (plan.ops.length) await this.push({ dev: 'rm', conn: null, name: 'RM tasks', ops: plan.ops });
  for (const { id, patch } of plan.patches) if (this.rmTaskDocs.has(id)) this.rmTaskDocs.set(id, Object.assign({}, this.rmTaskDocs.get(id), patch));
  for (const id of plan.prune) this.rmTasks.delete(id);
  this.taskSyncAt = now; this.taskSyncRuns = (this.taskSyncRuns || 0) + 1;
  return { ok: true, paired: this.rmTasks.size, blocksUpdated: plan.ops.length, tasksUpdated: plan.patches.length, dropped: plan.prune.length };
};
/* V3.874 — reminders + chores → RM list (rmTaskDocs, tracked in rmWhen), sessions + edits → `tracker` (Map id → event) */
MemoryHub.prototype.storeRecs = function (store) { const out = []; for (const row of this.rows.values()) if (row && row.store === store && !row.deleted && row.rec) out.push(row.rec); return out; };
MemoryHub.prototype.syncWhen = async function ({ force, who, now } = {}) {
  this._taskStore(); if (!this.rmWhen) this.rmWhen = {};
  const t = now == null ? Date.now() : now;
  if (!force && this.whenSyncAt && t - this.whenSyncAt < WHEN_MS) return { ok: true, skipped: true };
  const chores = this.storeRecs('chores'), reminders = this.storeRecs('reminders'), today = this.today || todayIn(LAB_TZ, t);
  const ids = [...new Set(Object.keys(this.rmWhen).concat(whenCandidates({ chores, reminders, today }).map(c => c.taskId)))];
  const tasks = new Map(ids.map(id => [id, this.rmTaskDocs.get(id) || null]));
  const plan = planWhen({ state: this.st, chores, reminders, tracked: this.rmWhen, tasks, today, uid: (who && who.id) || 'u', name: (who && who.name) || '', now: t });
  if (plan.ops.length) await this.push({ dev: 'rm', conn: null, name: 'RM My Week', ops: plan.ops });
  for (const doc of plan.creates) if (!this.rmTaskDocs.has(doc.id)) this.rmTaskDocs.set(doc.id, doc);
  for (const { id, patch } of plan.patches) if (this.rmTaskDocs.has(id)) this.rmTaskDocs.set(id, Object.assign({}, this.rmTaskDocs.get(id), patch));
  Object.assign(this.rmWhen, plan.track); for (const id of plan.untrack) delete this.rmWhen[id];
  this.whenSyncAt = t; this.whenRuns = (this.whenRuns || 0) + 1;
  return { ok: true, created: plan.creates.length, tasksUpdated: plan.patches.length, notebookUpdated: plan.ops.length, tracked: Object.keys(this.rmWhen).length };
};
MemoryHub.prototype.syncActivity = async function ({ force, now } = {}) {
  if (!this.tracker) this.tracker = new Map();
  const t = now == null ? Date.now() : now;
  if (!force && this.actSyncAt && t - this.actSyncAt < ACT_MS) return { ok: true, skipped: true };
  const today = this.today || todayIn(LAB_TZ, t), from = addDays_(today, -ACT_DAYS), cursor = this.actCursor || 0;
  const latest = new Map();
  if (cursor && cursor >= (this.st.minSeq || 0)) { for (const o of this.ops) if (o.seq > cursor && (o.store === 'sessions' || o.store === 'documents')) latest.set(o.store + '/' + o.id, { store: o.store, rec: o.del ? null : o.rec }); }
  else for (const store of ['sessions', 'documents']) for (const rec of this.storeRecs(store)) latest.set(store + '/' + rec.id, { store, rec });
  const groups = activityGroups({ changes: [...latest.values()], today, from });
  const docs = new Map(this.storeRecs('documents').map(d => [String(d.id), d]));
  const existing = new Map([...groups.keys()].map(id => [id, this.tracker.get(id) || null]));
  const writes = planActivity({ groups, docs, existing });
  for (const w of writes) this.tracker.set(w.id, Object.assign({}, this.tracker.get(w.id) || {}, w.data));
  this.actCursor = this.st.seq; this.actSyncAt = t; this.actRuns = (this.actRuns || 0) + 1;
  return { ok: true, events: writes.length };
};
MemoryHub.prototype.quietSyncs = async function (who, { force, only } = {}) {
  const out = {}, want = n => !only || only.includes(n);
  if (want('library') && typeof this.mirrorLibrary === 'function') out.library = await this.mirrorLibrary({ force });
  if (want('tasks') && typeof this.syncTasks === 'function') out.tasks = await this.syncTasks({ force });
  if (want('when') && typeof this.syncWhen === 'function') out.when = await this.syncWhen({ force, who });
  if (want('activity') && typeof this.syncActivity === 'function') out.activity = await this.syncActivity({ force });
  return out;
};
/* V3.875 — `rmAnnotations`: Map paperId → raw annotation docs (with id); `uid` is the person the hub belongs to */
MemoryHub.prototype.annotations = async function ({ paperId }) {
  const raw = (this.rmAnnotations && this.rmAnnotations.get(String(paperId))) || [];
  const items = visibleAnnotations(raw, this.uid || 'u1');
  return { ok: true, paperId: String(paperId), total: items.length, items: items.slice(0, 300) };
};
/* V3.877 — `rmProtocols` (array of protocol docs with id), `rmCollections` (array of litReviews docs) */
MemoryHub.prototype.protocols = async function ({ q, id } = {}) {
  const all = this.rmProtocols || [];
  if (id) { const d = all.find(x => String(x.id) === String(id)); return d ? { ok: true, protocol: rmProtocolSteps(d) } : { ok: false, error: 'no such protocol' }; }
  const items = searchProtocols(all.map(rmProtocolRow), q); return { ok: true, total: items.length, items: items.slice(0, 100) };
};
MemoryHub.prototype.collections = async function ({ id } = {}) {
  const all = this.rmCollections || [];
  if (id) { const d = all.find(x => String(x.itemId || x.id) === String(id)); return d ? { ok: true, collection: rmCollectionFull(d) } : { ok: false, error: 'no such collection' }; }
  const items = all.map(rmCollectionRow).sort((a, b) => (b.updated_at || '').localeCompare(a.updated_at || '')); return { ok: true, total: items.length, items };
};
MemoryHub.prototype.inventory = async function ({ q, limit, ids } = {}) {
  let rows = (this.rmInventory || []).map(rmInventoryRow);
  if (ids && ids.length) rows = rows.filter(r => ids.includes(r.id));
  return searchInventory(rows, q, limit);
};
MemoryHub.prototype.libraryRows = function () {
  const out = new Map();
  for (const [key, row] of this.rows) if (row && row.store === 'library' && !row.deleted && row.rec) out.set(key, row);
  return out;
};

module.exports = { route, parseBody, MEDIA_MIME, MEDIA_EXTS, REC_EXTS, MAX_MEDIA_BYTES, NOSYNC, KEYS, AUTO_MAX, COUNT_SKIP, MAX_OPS, PULL_MAX, MISSING, isoLocal, eq, merge3, emptyState, planPush, pullResult, planResolve, planReplace, exportState, helloResult, keyOf, rowKey, MemoryHub, sha, token,
  MIRROR_MS, MIRROR_FIELDS, rmItemToLibraryRow, planMirror, INVENTORY_MS, INVENTORY_LIMIT, rmInventoryRow, searchInventory,
  TASKSYNC_MS, PRIO_IMPORTANCE, dueDateOf, taskIdNew, rmTaskFromBlock, rmTaskPatch, planTaskSync,
  LAB_TZ, WHEN_MS, ACT_MS, WHEN_AHEAD, WHEN_BEHIND, ACT_DAYS, todayIn, nowIn, localDayOf, addDays_, wdayOf, safeIdPart, choreNext, remOccursOn, whenOcc,
  whenTaskId, whenText, whenCandidates, rmWhenTask, planWhen, sessionDaySeconds, actEventId, activityGroups, planActivity, fmtMinutes,
  rmAnnotationRow, visibleAnnotations, stripTags, varsToText, rmProtocolRow, rmProtocolSteps, searchProtocols, rmCollectionRow, rmCollectionFull };
