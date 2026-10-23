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
async function mirrorQuietly(hub, who) {
  if (!hub || !who || typeof hub.mirrorLibrary !== 'function') return;
  try { await hub.mirrorLibrary({}); } catch (e) { /* the library mirror never breaks hello */ }
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
  if (p === '/api/sync/state' || (p === '/api/snapshot' && !post)) {
    await mirrorQuietly(hub, who);
    const st = await hub.loadState();
    if (p === '/api/snapshot' && !st.seq && !st.records) return J(404, { ok: false });
    return J(200, await hub.state('state'));
  }
  if (p === '/api/sync/pull') return J(200, await hub.pull({ conn: g('conn', ''), since: parseInt(g('since', '0'), 10) || 0, sid: g('sid', '') }));
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
MemoryHub.prototype.libraryRows = function () {
  const out = new Map();
  for (const [key, row] of this.rows) if (row && row.store === 'library' && !row.deleted && row.rec) out.set(key, row);
  return out;
};

module.exports = { route, parseBody, MEDIA_MIME, MEDIA_EXTS, REC_EXTS, MAX_MEDIA_BYTES, NOSYNC, KEYS, AUTO_MAX, COUNT_SKIP, MAX_OPS, PULL_MAX, MISSING, isoLocal, eq, merge3, emptyState, planPush, pullResult, planResolve, planReplace, exportState, helloResult, keyOf, rowKey, MemoryHub, sha, token,
  MIRROR_MS, MIRROR_FIELDS, rmItemToLibraryRow, planMirror };
