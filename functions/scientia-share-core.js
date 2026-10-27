/* ================================================================
   scientia-share-core.js — V3.899 — a lit review or a project shared
   with lab members: Share (they read it) or Collaborate (they edit it)
   ================================================================
   Alex: "share is a read only, collaborate means to be able to edit."
   Plan: CodeLog/ClaudesPlan/V3.899_scientia_share_collaborate.md

   Each person's Scientia is their own hub (scientia-hub.js); Gabe's app
   can only ever see one. So a share is a RELAY between hubs, run by the
   hub function: the owner's hub holds the original, each member's hub a
   copy the relay keeps equal to it, and a collaborator's change goes
   into the owner's hub as one more device — so the hub's own merge rules
   (merge3, conflicts the owner decides) apply — before the result goes
   back out to everyone.

     - the grant lives on the record: `shareWith {uid: 'read'|'edit'}` on
       the review's `documents` row or the project's `projects` row;
     - copies carry `sharedFrom {uid, name, role, share}` (documents,
       projects, themes; the rest go with their note);
     - the index `scientiaShares/{id}` (function-only) is the authority on
       who may do what — never anything in a member's own hub;
     - per member and record, a SHADOW = the copy last given to them and
       the owner's row seq then: the common ancestor of the next merge.

   Everything touches storage through `env` (scientia-share.js gives the
   Firestore one; MemoryShareEnv below runs the fixtures on MemoryHubs):
     env.hub(uid) → { rowsOf(store), rowsGet([{store,id}]) → Map(key → row|null),
                      push({dev, name, ops}) → {result, commits}, mediaFiles(paths) → Map, mediaCopy(docs) }
     env.index    → { get, put, del, owned(uid), memberOf(uid), lease(id), release(id) → dirty,
                      addIds(id, {docIds, blockIds, themeIds, mediaIds}),
                      shadows(id, uid), shadowsGet(id, uid, keys), shadowPut(id, uid, list), shadowDel(id, uid, keys),
                      shadowHas(id, store, recId) }
     env.members() → Map(uid → {name, category}) · env.nameOf(uid) · env.now()
   ================================================================ */
'use strict';

const H = require('./scientia-hub-core');
const { keyOf, eq } = H;

const isObj = v => v !== null && typeof v === 'object' && !Array.isArray(v);
const SHARES_MS = 60 * 60 * 1000;   // the safety pass (hourly per share); live edits go through relayPush
const LEASE_MS = 90 * 1000;
const ROLES = new Set(['read', 'edit']);
const MARKED = new Set(['documents', 'projects', 'themes']);
const PROJECT_PARTS = new Set(['projects', 'themes', 'aims', 'terms']);
const STORES = ['documents', 'blocks', 'wires', 'items', 'media', 'projects', 'themes', 'aims', 'terms'];
const MEDIA_ID = /^m_[a-z0-9]{4,}$/;

const shareIdOf = (ownerUid, kind, recId) => H.safeIdPart(ownerUid) + '__' + (kind === 'project' ? 'p' : 'd') + '__' + H.safeIdPart(recId);
const rootStore = kind => kind === 'project' ? 'projects' : 'documents';

/** The members a record is shared with: valid roles, lab members only, never its owner. */
function grantsOf(rec, ownerUid, members) {
  const out = {};
  if (!isObj(rec) || rec.deleted || rec.sharedFrom || !isObj(rec.shareWith)) return out;   // a copy can't be shared on
  for (const [uid, role] of Object.entries(rec.shareWith)) if (uid && uid !== ownerUid && ROLES.has(role) && (!members || members.has(uid))) out[uid] = role;
  return out;
}

/** Equal but for the hub's AUTO_MAX timestamps (opening a note must not count as an edit). */
function sameish(a, b) {
  if (!isObj(a) || !isObj(b)) return eq(a, b);
  for (const k of new Set([...Object.keys(a), ...Object.keys(b)])) { if (H.AUTO_MAX.has(k)) continue; if (!eq(a[k], b[k])) return false; }
  return true;
}
function withMark(store, rec, mark) { return MARKED.has(store) && isObj(rec) ? Object.assign({}, rec, { sharedFrom: mark }) : rec; }
function stripMark(rec) { if (!isObj(rec) || !('sharedFrom' in rec)) return rec; const o = Object.assign({}, rec); delete o.sharedFrom; return o; }

/** A collaborator edits the content, never the owner's filing or who it is shared with. */
function protect(store, mine, cur, idx) {
  if (!isObj(mine)) return mine;
  const o = Object.assign({}, mine);
  const keep = store === 'documents' ? ['shareWith', 'share', 'projectId', 'themeId'] : store === 'projects' ? ['shareWith'] : store === 'themes' ? ['projectId'] : [];
  if (cur) for (const k of keep) { if (k in cur) o[k] = cur[k]; else delete o[k]; }
  else {   // a record the collaborator made inside the share: filed where the share is
    delete o.shareWith; delete o.share;
    if (store === 'documents') { if (idx.projectId) o.projectId = idx.projectId; if (o.themeId && !idx.themeIds.has(String(o.themeId))) o.themeId = null; }
    if (store === 'themes' && idx.projectId) o.projectId = idx.projectId;
  }
  if (store === 'documents' && isObj(o.review)) o.review = Object.assign({}, o.review, { projectIds: cur && isObj(cur.review) && Array.isArray(cur.review.projectIds) ? cur.review.projectIds : [] });
  return o;
}

function mediaRefs(v, out) {
  if (typeof v === 'string') { if (MEDIA_ID.test(v)) out.add(v); return; }
  if (Array.isArray(v)) { for (const x of v) mediaRefs(x, out); return; }
  if (isObj(v)) for (const k of Object.keys(v)) mediaRefs(v[k], out);
}

/** Step 1: the notes a share holds (and for a project its project, themes, aims, terms). rows: {store: Map id → rec}. */
function closureDocs({ kind, recId, rows }) {
  const recs = new Map(), docIds = new Set(), themeIds = new Set(), add = (store, rec) => { if (isObj(rec)) recs.set(keyOf(store, rec.id), { store, id: String(rec.id), rec }); };
  let projectId = null;
  const get = s => rows[s] || new Map();
  if (kind === 'project') {
    const p = get('projects').get(String(recId)); if (!p || p.sharedFrom) return { recs, docIds, themeIds, projectId };
    projectId = String(recId); add('projects', p);
    for (const t of get('themes').values()) if (String(t.projectId) === projectId && !t.sharedFrom) { add('themes', t); themeIds.add(String(t.id)); }
    for (const a of get('aims').values()) if (themeIds.has(String(a.themeId))) add('aims', a);
    for (const t of get('terms').values()) if (String(t.projectId) === projectId) add('terms', t);
    for (const d of get('documents').values()) if (String(d.projectId) === projectId && !d.sharedFrom) { add('documents', d); docIds.add(String(d.id)); }
  } else {
    const d = get('documents').get(String(recId)); if (!d || d.sharedFrom) return { recs, docIds, themeIds, projectId };
    add('documents', d); docIds.add(String(d.id));
  }
  return { recs, docIds, themeIds, projectId };
}
/** The component ids step 2 needs loaded. */
function wantBlocks(c) { const out = []; for (const x of c.recs.values()) if (x.store === 'documents') for (const b of (x.rec.blockIds || [])) out.push(String(b)); return out; }
/** Step 2: their components, the wires inside them, the structures born in them, the media they use. */
function closure({ kind, recId, rows }) {
  const c = closureDocs({ kind, recId, rows }), blockIds = new Set(), mediaIds = new Set(), get = s => rows[s] || new Map();
  const add = (store, rec) => { if (isObj(rec)) c.recs.set(keyOf(store, rec.id), { store, id: String(rec.id), rec }); };
  for (const id of wantBlocks(c)) { const b = get('blocks').get(id); if (b && c.docIds.has(String(b.docId))) { add('blocks', b); blockIds.add(String(b.id)); mediaRefs(b, mediaIds); } }
  for (const w of get('wires').values()) if (blockIds.has(String(w.from)) && blockIds.has(String(w.to))) add('wires', w);
  for (const it of get('items').values()) if (c.docIds.has(String(it.originDocId))) add('items', it);
  for (const id of mediaIds) { const m = get('media').get(id); if (m) add('media', m); }
  return { recs: c.recs, docIds: c.docIds, blockIds, themeIds: c.themeIds, mediaIds, projectId: c.projectId };
}

/** The index's id lists as Sets (the relay grows them as notes and components are added). */
function idxSets(idx) {
  const S = k => new Set((idx && Array.isArray(idx[k]) ? idx[k] : []).map(String));
  return Object.assign({}, idx, { docIds: S('docIds'), blockIds: S('blockIds'), themeIds: S('themeIds'), mediaIds: S('mediaIds') });
}

/** Does a committed op belong to this share? ctx.role: 'owner' | 'read' | 'edit'; ctx.projectCopy: the member works in the
 *  owner's project row (a member's own project of the same id keeps their own notes their own). Grows the sets. */
function belongs(idx, op, ctx) {
  const r = op.rec, id = String(op.id), owner = ctx.role === 'owner', inProject = !!idx.projectId && (owner || ctx.projectCopy);
  if (op.del || !isObj(r)) return false;   // a removal: the caller asks the shadows
  let yes = false;
  switch (op.store) {
    case 'documents': yes = idx.docIds.has(id) || (inProject && String(r.projectId) === idx.projectId && !r.sharedFrom); if (yes) idx.docIds.add(id); break;
    case 'blocks': yes = idx.docIds.has(String(r.docId)); if (yes) { idx.blockIds.add(id); mediaRefs(r, idx.mediaIds); } break;
    case 'wires': yes = idx.blockIds.has(String(r.from)) && idx.blockIds.has(String(r.to)); break;
    case 'items': yes = idx.docIds.has(String(r.originDocId)); break;
    case 'media': yes = idx.mediaIds.has(id); break;
    case 'projects': yes = inProject && id === idx.projectId; break;
    case 'themes': yes = inProject && String(r.projectId) === idx.projectId; if (yes) idx.themeIds.add(id); break;
    case 'aims': yes = inProject && idx.themeIds.has(String(r.themeId)); break;
    case 'terms': yes = inProject && String(r.projectId) === idx.projectId; break;
  }
  return yes;
}

const markOf = (idx, role) => ({ uid: idx.ownerUid, name: idx.ownerName || '', role, share: idx.id });
const ownerDev = uid => 'share:' + uid;
const isCopyOf = (rec, idx) => isObj(rec) && isObj(rec.sharedFrom) && rec.sharedFrom.share === idx.id;

/* ---- V3.932: a deletion in a share waits for the other person ----
   Alex: "if one user deleted something, the other has to approve it." A note, card, theme, aim or structure one person
   removes from a shared project stays with everyone else — and with the owner — until someone else who edits it
   decides (the owner for a collaborator's deletion; a collaborator for the owner's). The deleter's copy stays gone
   meanwhile. Not held: an empty card (the app tidies those), and anything only the deleter ever wrote (who/: the
   one author of each record since it was shared, '*' once someone else changed it). Wires, media and terms are not
   decided on by themselves; they wait with the note or card they belong to. */
const DECIDED = new Set(['documents', 'blocks', 'themes', 'aims', 'items', 'projects']);
const emptyCard = (store, rec) => store === 'blocks' && isObj(rec) && (!rec.kind || rec.kind === 'component') && !String((rec.body && rec.body.text) || '').replace(/￼/g, '').trim() && !((rec.body && rec.body.marks) || []).length;
function titleOf(store, rec) {
  if (!isObj(rec)) return '';
  const t = store === 'documents' ? rec.title : store === 'blocks' ? (rec.label || String((rec.body && rec.body.text) || '').split('\n')[0]) : store === 'aims' ? rec.text : (rec.name || rec.text || rec.label || rec.kind);
  return String(t || '').replace(/￼/g, '').trim().slice(0, 90);
}
const STORE_SAY = { documents: 'note', blocks: 'card', themes: 'theme', aims: 'aim', items: 'structure', projects: 'project' };
/** key → Set of members whose copy is left as it is ('*' = everyone's) while a deletion waits. */
function holdOf(pending) {
  const m = new Map(), add = (k, u) => { if (!m.has(k)) m.set(k, new Set()); m.get(k).add(u); };
  for (const p of pending || []) for (const r of p.recs || []) add(keyOf(r.store, r.id), p.kind === 'owner' ? '*' : p.by);
  return m;
}
function held(idx, k, uid) { const h = idx && idx.hold && idx.hold.get(k); return !!(h && (h.has('*') || h.has(uid))); }
async function loadHold(env, idx) { idx.pending = await env.index.pendingList(idx.id); idx.hold = holdOf(idx.pending); return idx; }
/** Who wrote each record: list [{store, id, made}] written by uid (made = new to the share). */
async function authored(env, idx, uid, list) {
  const w = list.filter(o => !o.del && isObj(o.rec !== undefined ? o.rec : {}));
  if (!w.length) return;
  const was = await env.index.whoGet(idx.id, w.map(o => ({ store: o.store, id: o.id }))), put = [];
  for (const o of w) { const k = keyOf(o.store, o.id), cur = was.get(k);
    if (cur === undefined) { if (o.made) put.push({ store: o.store, id: o.id, who: uid }); }
    else if (cur !== uid && cur !== '*') put.push({ store: o.store, id: o.id, who: '*' }); }
  if (put.length) await env.index.whoPut(idx.id, put);
}
/**
 * Split deletions into those that go through now and those that wait. dels: [{store, id, rec (as it was), …}].
 * role: 'member' (a collaborator removed them from their copy) | 'owner'. Writes a pending entry per note or card.
 */
async function holdDeletes(env, idx, uid, role, dels) {
  const approvers = role === 'owner' ? Object.keys(idx.members || {}).filter(u => idx.members[u] === 'edit')
    : [idx.ownerUid].concat(Object.keys(idx.members || {}).filter(u => u !== uid && idx.members[u] === 'edit'));
  if (!approvers.length) return { free: dels, held: [] };
  const pend = idx.pending || await env.index.pendingList(idx.id), waiting = holdOf(pend);
  const who = await env.index.whoGet(idx.id, dels.map(d => ({ store: d.store, id: d.id })));
  const free = [], hold = [];
  for (const d of dels) {
    const k = keyOf(d.store, d.id);
    if (waiting.has(k)) continue;                                   // already waiting for a person
    if (!DECIDED.has(d.store) || emptyCard(d.store, d.rec) || who.get(k) === uid) free.push(d); else hold.push(d);
  }
  if (!hold.length) return { free, held: [] };
  // one decision per note (its cards, structures and wires with it), per card otherwise
  const notes = new Set(hold.filter(d => d.store === 'documents').map(d => d.id)), groups = new Map();
  const blockNote = d => d.store === 'blocks' && isObj(d.rec) && notes.has(String(d.rec.docId)) ? String(d.rec.docId) : null;
  for (const d of hold) { const g = d.store === 'documents' ? d.id : blockNote(d) || (d.store === 'items' && isObj(d.rec) && notes.has(String(d.rec.originDocId)) ? String(d.rec.originDocId) : null) || keyOf(d.store, d.id);
    if (!groups.has(g)) groups.set(g, []); groups.get(g).push(d); }
  const heldBlocks = new Set(hold.filter(d => d.store === 'blocks').map(d => d.id)), rest = [];
  for (const d of free) {   // a wire or a file of something held waits with it
    const w = d.store === 'wires' && isObj(d.rec) ? [String(d.rec.from), String(d.rec.to)].find(b => heldBlocks.has(b)) : null;
    const g = w ? [...groups.entries()].find(([, ds]) => ds.some(x => x.store === 'blocks' && x.id === w)) : null;
    if (g) g[1].push(d); else rest.push(d);
  }
  const names = idx.names || {}, byName = role === 'owner' ? (idx.ownerName || '') : (names[uid] || '');
  for (const ds of groups.values()) {
    const root = ds.find(d => d.store === 'documents') || ds.find(d => DECIDED.has(d.store)) || ds[0];
    const p = { pid: 'del_' + H.token(8).toLowerCase().replace(/[^a-z0-9]/g, 'x'), shareId: idx.id, shareTitle: idx.title || '', ownerUid: idx.ownerUid, kind: role, by: uid, byName,
      at: env.now(), approvers, root: { store: root.store, id: root.id, title: titleOf(root.store, root.rec), what: STORE_SAY[root.store] || 'record' },
      recs: ds.map(d => ({ store: d.store, id: d.id })), parts: ds.length };
    await env.index.pendingPut(idx.id, p);
    (idx.pending = idx.pending || pend).push(p);
  }
  idx.hold = holdOf(idx.pending || pend);
  return { free: rest, held: hold };
}

/** The deletions waiting for this person, and theirs waiting for someone else. */
async function pendingFor(env, uid) {
  const [owned, member] = await Promise.all([env.index.owned(uid), env.index.memberOf(uid)]), decide = [], waiting = [];
  for (const ix of owned.concat(member)) for (const p of await env.index.pendingList(ix.id)) {
    const x = Object.assign({}, p, { shareTitle: ix.title || p.shareTitle || '', approverNames: (p.approvers || []).map(u => u === ix.ownerUid ? ix.ownerName : (ix.names || {})[u]).filter(Boolean) });
    if (p.by === uid) waiting.push(x); else if ((p.approvers || []).includes(uid)) decide.push(x);
  }
  const at = (a, b) => (a.at || 0) - (b.at || 0);
  return { ok: true, decide: decide.sort(at), waiting: waiting.sort(at) };
}

/** Decide a waiting deletion: pick 'delete' (it goes from everyone) or 'keep' (it comes back for everyone). */
async function decide(env, uid, shareId, pid, pick) {
  if (pick !== 'delete' && pick !== 'keep') return { ok: false, error: 'pick is delete or keep' };
  const ix = await env.index.get(shareId); if (!ix) return { ok: false, error: 'that share is gone' };
  const p = (await env.index.pendingList(shareId)).find(x => x.pid === pid); if (!p) return { ok: false, error: 'already decided' };
  if (!(p.approvers || []).includes(uid)) return { ok: false, error: 'not yours to decide' };
  const ownerHub = env.hub(ix.ownerUid), keys = p.recs.map(r => ({ store: r.store, id: r.id })), names = ix.names || {};
  const whoName = uid === ix.ownerUid ? (ix.ownerName || 'the owner') : (names[uid] || 'a collaborator');
  if (p.kind === 'member' && pick === 'delete') {
    const cur = await ownerHub.rowsGet(keys), ops = [];
    for (const r of keys) { const row = cur.get(keyOf(r.store, r.id)); if (row && isObj(row.rec)) ops.push({ store: r.store, id: r.id, del: true, prev: row.rec, base: row.seq || 0 }); }
    if (ops.length) await ownerHub.push({ dev: ownerDev(p.by), name: (p.byName || 'A collaborator') + ' (shared) · approved by ' + whoName, ops });
  }
  if (p.kind === 'owner' && pick === 'keep') {   // back to the owner from the copy of the one who kept it
    const [mine, sh, cur] = await Promise.all([env.hub(uid).rowsGet(keys), env.index.shadowsGet(shareId, uid, keys), ownerHub.rowsGet(keys)]), ops = [];
    for (const r of keys) {
      const k = keyOf(r.store, r.id), m = mine.get(k), rec = m && isObj(m.rec) ? m.rec : (sh.get(k) || {}).rec, row = cur.get(k);
      if (isObj(rec) && !(row && isObj(row.rec))) ops.push({ store: r.store, id: r.id, rec: stripMark(rec), prev: null, base: row ? (row.seq || 0) : 0 });
    }
    if (ops.length) await ownerHub.push({ dev: ownerDev(uid), name: whoName + ' (shared) · kept', ops });
  }
  if (p.kind === 'member' && pick === 'keep' && (ix.members || {})[p.by]) {   // the deleter's copy back first, so the pass doesn't read its absence as theirs to decide again
    const cur = await ownerHub.rowsGet(keys), items = [];
    for (const r of keys) { const row = cur.get(keyOf(r.store, r.id)); if (row && isObj(row.rec)) items.push({ store: r.store, id: r.id, rec: row.rec, seq: row.seq || 0 }); }
    await fanOut(env, Object.assign(idxSets(ix), { hold: new Map(), members: { [p.by]: ix.members[p.by] } }), items);
  }
  await env.index.pendingDel(shareId, pid);
  const pass = await sharePass(env, ix);   // everyone's copy follows the decision
  return { ok: true, pick, pass };
}

/**
 * Make each member's copy of these records equal to the owner's. items: [{store, id, rec|null (gone), seq}] — the
 * owner's rows. A member's row changed since it was read merges (prev = what was read, base = its seq), never lost.
 */
async function fanOut(env, idx, items) {
  if (!items.length) return { pushed: 0 };
  let pushed = 0; const ownerHub = env.hub(idx.ownerUid), fileCache = new Map();
  const uids = Object.keys(idx.members || {});
  for (const uid of uids) {
    const role = idx.members[uid], hub = env.hub(uid), keys = items.map(x => ({ store: x.store, id: x.id }));
    const [cur, sh] = await Promise.all([hub.rowsGet(keys), env.index.shadowsGet(idx.id, uid, keys)]);
    const ops = [], puts = [], dels = [], paths = [];
    for (const x of items) {
      const k = keyOf(x.store, x.id), row = cur.get(k), have = row && isObj(row.rec) ? row.rec : undefined, s = sh.get(k);
      if (held(idx, k, uid)) continue;   // V3.932: a deletion waiting for a person — this member's copy stays as it is
      if (!isObj(x.rec)) {   // gone at the owner, or out of the share: remove the copy (never the member's own record)
        if (s) { if (have !== undefined && (!MARKED.has(x.store) || isCopyOf(have, idx))) ops.push({ store: x.store, id: x.id, del: true, prev: have, base: row.seq || 0 }); dels.push({ store: x.store, id: x.id }); }
        continue;
      }
      // the member's own project / theme of the same id (it is assigned to them in RM too) stays theirs
      if (PROJECT_PARTS.has(x.store) && have !== undefined && !s && !isCopyOf(have, idx)) continue;
      const want = withMark(x.store, x.rec, markOf(idx, role));
      if (have === undefined || !sameish(have, want)) ops.push({ store: x.store, id: x.id, rec: want, prev: have === undefined ? null : have, base: row ? (row.seq || 0) : 0 });
      if (!s || !sameish(s.rec, want)) puts.push({ store: x.store, id: x.id, rec: want, ownerSeq: x.seq || 0 });
      if (x.store === 'media' && x.rec.path && (have === undefined || !s)) paths.push(String(x.rec.path));
    }
    if (ops.length) { await hub.push({ dev: 'share', name: 'Shared by ' + (idx.ownerName || 'a lab member'), ops }); pushed += ops.length; }
    if (puts.length) await env.index.shadowPut(idx.id, uid, puts);
    if (dels.length) await env.index.shadowDel(idx.id, uid, dels);
    if (paths.length) {
      const need = paths.filter(p => !fileCache.has(p));
      if (need.length) for (const [p, doc] of await ownerHub.mediaFiles(need)) fileCache.set(p, doc);
      const docs = paths.map(p => fileCache.get(p)).filter(Boolean); if (docs.length) await hub.mediaCopy(docs);
    }
  }
  return { pushed };
}

/** A collaborator's changes into the owner's hub (as device share:<uid>), then the owner's result out to everyone. */
async function inbound(env, idx, uid, ops, { fan = true } = {}) {
  if (!ops.length) return { pushed: 0 };
  const keys = ops.map(o => ({ store: o.store, id: String(o.id) })), ownerHub = env.hub(idx.ownerUid);
  const [sh, cur] = await Promise.all([env.index.shadowsGet(idx.id, uid, keys), ownerHub.rowsGet(keys)]);
  const out = [], restore = [], dels = [];
  for (const o of ops) {
    const k = keyOf(o.store, o.id), s = sh.get(k), orow = cur.get(k), ocur = orow && isObj(orow.rec) ? orow.rec : undefined;
    const prev = s ? stripMark(s.rec) : null, base = s ? (s.ownerSeq || 0) : (orow ? (orow.seq || 0) : 0);
    if (o.del || !isObj(o.rec)) {
      /* V3.923 — never the shared project or review itself: it goes back in their hub. V3.932 — anything else they
       * removed waits for the owner (or another collaborator) to approve, unless only they ever wrote it. */
      if (s && ocur !== undefined) {
        const root = o.store === rootStore(idx.kind) && String(o.id) === String(idx.recId);
        if (root) restore.push({ store: o.store, id: String(o.id), rec: ocur, seq: orow.seq || 0 });
        else dels.push({ store: o.store, id: String(o.id), rec: ocur, del: true, prev, base });
      }
      continue;
    }
    if (s && sameish(o.rec, s.rec)) continue;   // only a timestamp moved
    out.push({ store: o.store, id: String(o.id), rec: protect(o.store, stripMark(o.rec), ocur, idx), prev, base, made: ocur === undefined });
  }
  if (dels.length) { const h = await holdDeletes(env, idx, uid, 'member', dels); for (const d of h.free) out.push({ store: d.store, id: d.id, del: true, prev: d.prev, base: d.base }); }
  if (restore.length && idx.members && idx.members[uid]) await fanOut(env, Object.assign({}, idx, { members: { [uid]: idx.members[uid] } }), restore);
  if (!out.length) return { pushed: 0, restored: restore.length };
  const names = idx.names || {};
  await authored(env, idx, uid, out);
  await ownerHub.push({ dev: ownerDev(uid), name: (names[uid] || 'A collaborator') + ' (shared)', ops: out.map(o => { const x = Object.assign({}, o); delete x.made; return x; }) });
  if (fan) {   // everyone, the collaborator too: a merge may have changed what they sent
    const now = await ownerHub.rowsGet(out.map(o => ({ store: o.store, id: o.id })));
    await fanOut(env, idx, out.map(o => { const r = now.get(keyOf(o.store, o.id)); return { store: o.store, id: o.id, rec: r && isObj(r.rec) ? r.rec : null, seq: r ? r.seq : 0 }; }));
  }
  return { pushed: out.length, restored: restore.length };
}

/** A read-only member changed a copy: it goes back to what was shared (their new records are left alone). */
async function revert(env, idx, uid, ops) {
  const keys = ops.map(o => ({ store: o.store, id: String(o.id) })), sh = await env.index.shadowsGet(idx.id, uid, keys), back = [];
  for (const o of ops) {
    const s = sh.get(keyOf(o.store, o.id)); if (!s) continue;
    if (o.del || !isObj(o.rec)) back.push({ store: o.store, id: String(o.id), rec: s.rec, prev: null, base: o.seq || 0 });
    else if (!sameish(o.rec, s.rec)) back.push({ store: o.store, id: String(o.id), rec: s.rec, prev: o.rec, base: o.seq || 0 });
  }
  if (back.length) await env.hub(uid).push({ dev: 'share', name: 'Shared by ' + (idx.ownerName || 'a lab member') + ' (read only)', ops: back });
  return { reverted: back.length };
}

/** Media rows a share now uses that are not among `ops` yet (a file saved before the card that shows it). */
async function newMedia(hub, idx, had, ops) {
  const seen = new Set(ops.filter(o => o.store === 'media').map(o => String(o.id))), want = [...idx.mediaIds].filter(m => !had.has(m) && !seen.has(m));
  if (!want.length) return [];
  const got = await hub.rowsGet(want.map(m => ({ store: 'media', id: m }))), out = [];
  for (const [, r] of got) if (r && isObj(r.rec)) out.push({ store: 'media', id: String(r.rec.id), rec: r.rec, seq: r.seq || 0, del: false });
  return out;
}
/** Pick the ops of one share (in order, growing its id lists), then the media they made it use. */
async function pick(env, idx, ops, ctx, uid) {
  const mine = [], hadMedia = new Set(idx.mediaIds);
  for (const o of ops) {
    if (o.del || !isObj(o.rec)) {
      const has = ctx.role === 'owner' ? await env.index.shadowHas(idx.id, o.store, String(o.id)) : (await env.index.shadowsGet(idx.id, uid, [{ store: o.store, id: String(o.id) }])).size > 0;
      if (has) mine.push(o); continue;
    }
    if (belongs(idx, o, ctx)) mine.push(o);
  }
  for (const o of ops) if (o.store === 'media' && isObj(o.rec) && !mine.includes(o) && idx.mediaIds.has(String(o.id))) mine.push(o);   // saved before its card
  if (mine.length) for (const m of await newMedia(env.hub(uid), idx, hadMedia, mine)) mine.push(m);
  return mine;
}

/** After any push to `uid`'s hub (commits = the ops it committed): relay what belongs to a share. */
async function relayPush(env, uid, commits) {
  const out = { out: 0, in: 0, reverted: 0, passes: [] };
  const ops = (commits || []).filter(o => o && o.store && STORES.includes(o.store) && !String(o.dev || '').startsWith('share'));   // never the relay's own writes
  if (!ops.length) return out;
  const [owned, member] = await Promise.all([env.index.owned(uid), env.index.memberOf(uid)]);
  const pass = new Map();
  // a grant made or changed on a record: a full pass (it makes the index the first time)
  for (const o of ops) {
    if ((o.store !== 'documents' && o.store !== 'projects') || !isObj(o.rec)) continue;
    const kind = o.store === 'projects' ? 'project' : 'review', id = shareIdOf(uid, kind, o.id), ix = owned.find(x => x.id === id);
    const want = grantsOf(o.rec, uid, null);
    if (ix ? !eq(want, ix.asked || {}) : Object.keys(want).length) pass.set(id, { id, ownerUid: uid, kind, recId: String(o.id) });
  }
  for (const ix0 of owned) {
    if (pass.has(ix0.id)) continue;
    const idx = idxSets(ix0), before = new Set(idx.docIds), known = { documents: before, blocks: new Set(idx.blockIds), themes: new Set(idx.themeIds) };
    let mine = await pick(env, idx, ops, { role: 'owner' }, uid);
    // a note moved out of the shared project, or turned into someone else's copy: the pass works out what leaves
    if (mine.some(o => o.store === 'documents' && isObj(o.rec) && before.has(String(o.id)) && ((idx.projectId && String(o.rec.projectId) !== idx.projectId) || o.rec.sharedFrom))) {
      pass.set(ix0.id, { id: ix0.id, ownerUid: uid, kind: ix0.kind, recId: ix0.recId }); continue;
    }
    if (!mine.length) continue;
    await addIds(env, ix0, idx);
    // V3.932: what the owner removed waits for a collaborator to approve (their copies stay until then)
    const gone = mine.filter(o => o.del || !isObj(o.rec));
    if (gone.length) {
      const some = Object.keys(idx.members || {})[0], was = some ? await env.index.shadowsGet(idx.id, some, gone.map(o => ({ store: o.store, id: String(o.id) }))) : new Map();
      const h = await holdDeletes(env, idx, uid, 'owner', gone.map(o => ({ store: o.store, id: String(o.id), rec: (was.get(keyOf(o.store, o.id)) || {}).rec || null })));
      const keep = new Set(h.free.map(d => keyOf(d.store, d.id)));
      mine = mine.filter(o => !(o.del || !isObj(o.rec)) || keep.has(keyOf(o.store, o.id)));
    }
    await authored(env, idx, uid, mine.filter(o => isObj(o.rec)).map(o => ({ store: o.store, id: String(o.id), made: !!(known[o.store] && !known[o.store].has(String(o.id))) })));
    await loadHold(env, idx);
    const r = await fanOut(env, idx, mine.map(o => ({ store: o.store, id: String(o.id), rec: isObj(o.rec) ? o.rec : null, seq: o.seq || 0 })));
    out.out += r.pushed;
  }
  for (const ix0 of member) {
    const role = (ix0.members || {})[uid]; if (!ROLES.has(role)) continue;   // the index, not the member's hub, says who may
    const idx = idxSets(ix0);
    let projectCopy = false;
    if (idx.projectId && ops.some(o => PROJECT_PARTS.has(o.store) || (o.store === 'documents' && isObj(o.rec) && String(o.rec.projectId) === idx.projectId))) {
      const r = (await env.hub(uid).rowsGet([{ store: 'projects', id: idx.projectId }])).get(keyOf('projects', idx.projectId));
      projectCopy = !!(r && isCopyOf(r.rec, idx));
    }
    const mine = await pick(env, idx, ops, { role, projectCopy }, uid);
    if (!mine.length) continue;
    if (role === 'edit') {
      await addIds(env, ix0, idx); await loadHold(env, idx);
      const files = mine.filter(o => o.store === 'media' && isObj(o.rec) && o.rec.path).map(o => String(o.rec.path));   // their new files go with their records
      if (files.length) { const docs = [...(await env.hub(uid).mediaFiles(files)).values()]; if (docs.length) await env.hub(idx.ownerUid).mediaCopy(docs); }
      const r = await inbound(env, idx, uid, mine); out.in += r.pushed;
    } else { const r = await revert(env, idx, uid, mine); out.reverted += r.reverted; }
  }
  for (const a of pass.values()) out.passes.push(await sharePass(env, a));
  return out;
}
async function addIds(env, ix0, idx) {
  const grow = {}; for (const k of ['docIds', 'blockIds', 'themeIds', 'mediaIds']) { const had = new Set((ix0[k] || []).map(String)), add = [...idx[k]].filter(x => !had.has(x)); if (add.length) grow[k] = add; }
  if (Object.keys(grow).length) await env.index.addIds(idx.id, grow);
}
/** A file uploaded after its record (the app saves the bytes, then the record — or the other way on a slow line): copy it
 *  to whoever has the record. A collaborator's file goes to the owner first, then to the others. */
async function relayMedia(env, uid, path) {
  const m = String(path || '').match(/^images\/(m_[a-z0-9]+)\.[a-z0-9]+$/); if (!m) return { copied: 0 };
  const [owned, member] = await Promise.all([env.index.owned(uid), env.index.memberOf(uid)]);
  let copied = 0;
  for (const ix of owned.concat(member.filter(x => (x.members || {})[uid] === 'edit'))) {
    if (!(ix.mediaIds || []).includes(m[1])) continue;
    const docs = [...(await env.hub(uid).mediaFiles([path])).values()]; if (!docs.length) continue;
    for (const u of [ix.ownerUid].concat(Object.keys(ix.members || {}))) if (u !== uid) { await env.hub(u).mediaCopy(docs); copied++; }
  }
  return { copied };
}

async function loadRows(hub, stores) {
  const rows = {}, seqs = new Map();
  await Promise.all(stores.map(async s => { const m = new Map(); for (const r of await hub.rowsOf(s)) if (r && isObj(r.rec)) { m.set(String(r.id), r.rec); seqs.set(keyOf(s, r.id), r.seq || 0); } rows[s] = m; }));
  return { rows, seqs };
}
const SMALL = ['documents', 'projects', 'themes', 'aims', 'terms', 'wires', 'items', 'media'];

/**
 * The whole share made right: a collaborator's missed changes go in, the closure is worked out again, every member's
 * copy is made equal to it (what left the share is removed), a member who lost access loses every copy, the index is
 * rewritten. a = {id, ownerUid, kind, recId} (or an index doc).
 */
async function sharePass(env, a) {
  const id = a.id || shareIdOf(a.ownerUid, a.kind, a.recId);
  if (!(await env.index.lease(id, LEASE_MS))) return { id, busy: true };
  const res = { id, rounds: 0, out: 0, in: 0, removed: 0 };
  try {
    for (let round = 0; round < 3; round++) {
      res.rounds++;
      const old = (await env.index.get(id)) || null, ownerUid = a.ownerUid || (old && old.ownerUid), kind = a.kind || (old && old.kind), recId = String(a.recId || (old && old.recId));
      const ownerHub = env.hub(ownerUid), members = await env.members();
      if (old && Object.keys(old.members || {}).length) { const h = await heal(env, old); if (h) res.healed = (res.healed || 0) + h; }
      let { rows, seqs } = await loadRows(ownerHub, SMALL);
      const root = rows[rootStore(kind)].get(recId), had = (old && old.members) || {};
      const hold = old ? holdOf(await env.index.pendingList(id)) : new Map();
      if (!root && hold.has(keyOf(rootStore(kind), recId))) { res.waiting = true; await env.index.release(id); break; }   // V3.932: the owner removed it; a collaborator decides
      const grants = grantsOf(root, ownerUid, members);
      const ownerName = (await env.nameOf(ownerUid)) || (old && old.ownerName) || '';
      const names = {}; for (const u of Object.keys(grants)) names[u] = (members.get(u) || {}).name || '';
      const base = { id, ownerUid, ownerName, kind, recId, members: grants, names, asked: grantsOf(root, ownerUid, null) };
      // 1. collaborators' changes that never reached the owner (a missed relay, their desktop offline at the time)
      let wrote = false;
      for (const [uid, role] of Object.entries(grants)) {
        if (role !== 'edit' || had[uid] !== 'edit') continue;
        const sh = await env.index.shadows(id, uid); if (!sh.size) continue;
        const keys = [...sh.values()].map(s => ({ store: s.store, id: s.id })), cur = await env.hub(uid).rowsGet(keys), ops = [];
        const idx0 = Object.assign(idxSets(Object.assign({}, old, base)), { hold });
        for (const s of sh.values()) {
          const row = cur.get(keyOf(s.store, s.id)), have = row && isObj(row.rec) ? row.rec : null;
          if (fromReplace(row)) continue;   // V3.931: not their change — their hub was replaced; step 3 gives the copy back
          if (!have) ops.push({ store: s.store, id: s.id, rec: null, del: true, seq: row ? row.seq : 0 });
          else if (!sameish(have, s.rec)) ops.push({ store: s.store, id: s.id, rec: have, seq: row.seq || 0 });
          // their new components in a shared note
          if (have && s.store === 'documents') { const known = new Set([...sh.keys()]), extra = (have.blockIds || []).map(String).filter(b => !known.has(keyOf('blocks', b)));
            if (extra.length) { const bs = await env.hub(uid).rowsGet(extra.map(b => ({ store: 'blocks', id: b }))); for (const [, r] of bs) if (r && isObj(r.rec) && String(r.rec.docId) === s.id) ops.push({ store: 'blocks', id: String(r.rec.id), rec: r.rec, seq: r.seq || 0 }); } }
        }
        if (ops.length) { const r = await inbound(env, idx0, uid, ops, { fan: false }); res.in += r.pushed; wrote = wrote || r.pushed > 0; }
      }
      if (wrote) ({ rows, seqs } = await loadRows(ownerHub, SMALL));
      // 2. the share as it is now
      const c0 = closureDocs({ kind, recId, rows }), bIds = wantBlocks(c0);
      rows.blocks = new Map();
      if (bIds.length) for (const [k, r] of await ownerHub.rowsGet(bIds.map(b => ({ store: 'blocks', id: b })))) if (r && isObj(r.rec)) { rows.blocks.set(String(r.rec.id), r.rec); seqs.set(k, r.seq || 0); }
      const c = Object.keys(grants).length ? closure({ kind, recId, rows }) : { recs: new Map(), docIds: new Set(), blockIds: new Set(), themeIds: new Set(), mediaIds: new Set(), projectId: null };
      const idx = Object.assign({}, base, { docIds: c.docIds, blockIds: c.blockIds, themeIds: c.themeIds, mediaIds: c.mediaIds, projectId: c.projectId, hold });
      // 3. every member's copy equal to it; what left the share leaves their copy
      for (const uid of Object.keys(grants)) {
        const sh = await env.index.shadows(id, uid), items = [];
        for (const [k, x] of c.recs) items.push({ store: x.store, id: x.id, rec: x.rec, seq: seqs.get(k) || 0 });
        for (const [k, s] of sh) if (!c.recs.has(k)) { items.push({ store: s.store, id: s.id, rec: null, seq: 0 }); res.removed++; }
        res.out += (await fanOut(env, Object.assign({}, idx, { members: { [uid]: grants[uid] } }), items)).pushed;
      }
      // 4. a member who lost access loses every copy
      for (const uid of Object.keys(had)) {
        if (grants[uid]) continue;
        const sh = await env.index.shadows(id, uid); if (!sh.size) continue;
        const items = [...sh.values()].map(s => ({ store: s.store, id: s.id, rec: null, seq: 0 }));
        res.removed += items.length;
        await fanOut(env, Object.assign({}, idx, { hold: new Map(), members: { [uid]: had[uid] } }), items);
      }
      // 5. the index
      if (!Object.keys(grants).length) await env.index.del(id);
      else await env.index.put(id, Object.assign({}, base, { title: String((root && (root.title || root.name)) || ''), memberUids: Object.keys(grants),
        docIds: [...c.docIds], blockIds: [...c.blockIds], themeIds: [...c.themeIds], mediaIds: [...c.mediaIds], projectId: c.projectId, passAt: env.now() }));
      if (!(await env.index.release(id))) break;   // nobody asked for another round meanwhile
      if (!(await env.index.lease(id, LEASE_MS))) break;
    }
  } catch (e) { await env.index.release(id); throw e; }
  return res;
}

/* V3.931 — A whole hub replaced is nobody's edit. A desktop that connects and is told "this computer's notebook wins"
 * (scientia-cloud.py --prefer local; the installed app's choice since V3.928) REPLACES its owner's hub: every row is
 * rewritten from the computer's record (seq 0, no device) and the rest are gone without a tombstone. To the pass that
 * looked like (owner) the shared project deleted or unshared — so every member lost their copies and the index with its
 * shadows was dropped ("Our lab development", 27 Oct 2026) — or (collaborator) every copy they had edited deleted,
 * which V3.923's "only what came from them" let through. A row missing outright, or written by a replace, is neither:
 * the collaborator's copy is simply given back (step 3), and the owner's records come back from the shadows. */
const fromReplace = row => !row || (!row.seq && !row.dev);
/** The owner's records a replace took away, put back from the members' shadows (the copies last given out), and the
 *  grants the index holds put back on a root the replace wrote without them. Returns how many records were written. */
async function heal(env, old) {
  const ownerHub = env.hub(old.ownerUid), rk = { store: rootStore(old.kind), id: String(old.recId) };
  const root = (await ownerHub.rowsGet([rk])).get(keyOf(rk.store, rk.id));
  if (!fromReplace(root)) return 0;   // the owner's own edit (an unshare, a delete) stands
  const uids = Object.keys(old.members).sort((a, b) => (old.members[b] === 'edit') - (old.members[a] === 'edit'));
  const want = new Map();
  for (const uid of uids) for (const [k, s] of await env.index.shadows(old.id, uid)) if (!want.has(k) && isObj(s.rec)) want.set(k, s);
  if (!want.size) return 0;
  const keys = [...want.values()].map(s => ({ store: s.store, id: s.id })), cur = await ownerHub.rowsGet(keys), ops = [];
  for (const [k, s] of want) {
    const row = cur.get(k), isRoot = k === keyOf(rk.store, rk.id);
    if (row && !isRoot) continue;   // the owner has it (theirs wins)
    if (row && isObj(row.rec) && !fromReplace(row)) continue;
    let rec = stripMark(row && isObj(row.rec) ? row.rec : s.rec);
    if (isRoot) rec = Object.assign({}, rec, { shareWith: Object.assign({}, old.asked || old.members, isObj(rec.shareWith) ? rec.shareWith : {}) });
    if (row && isObj(row.rec) && sameish(rec, row.rec)) continue;
    ops.push({ store: s.store, id: s.id, rec, prev: row && isObj(row.rec) ? row.rec : null, base: row ? (row.seq || 0) : 0 });
  }
  if (ops.length) await ownerHub.push({ dev: 'share-restore', name: 'Put back from the share (the hub was replaced)', ops });
  return ops.length;
}

/** The safety pass: every share this person owns or is in whose last pass is older than SHARES_MS (or all, forced). */
async function syncShares(env, uid, { force } = {}) {
  const [owned, member] = await Promise.all([env.index.owned(uid), env.index.memberOf(uid)]), now = env.now(), done = [];
  for (const ix of owned.concat(member)) {
    if (!force && ix.passAt && now - ix.passAt < SHARES_MS) continue;
    try { done.push(await sharePass(env, ix)); } catch (e) { done.push({ id: ix.id, error: String(e.message || e) }); }
  }
  return { ok: true, passes: done.length, results: done };
}

/* ---------------- in memory: the fixtures (MemoryHubs, one per person) ---------------- */
class MemoryShareEnv {
  constructor(members) { this.hubs = new Map(); this.idx = new Map(); this.sh = new Map(); this.pend = new Map(); this.who = new Map(); this.mem = new Map(Object.entries(members || {})); this.t = 1e12; this.files = new Map(); }
  now() { return this.t; }
  async members() { return this.mem; }
  async nameOf(uid) { return (this.mem.get(uid) || {}).name || ''; }
  hub(uid) {
    if (!this.hubs.has(uid)) {
      const h = new H.MemoryHub(), files = new Map();
      this.files.set(uid, files);
      h.share = {
        rowsOf: async s => [...h.rows.values()].filter(r => r.store === s && isObj(r.rec)),
        rowsGet: async keys => { const m = new Map(); for (const k of keys) { const r = h.rows.get(keyOf(k.store, k.id)); m.set(keyOf(k.store, k.id), r ? Object.assign({}, r) : null); } return m; },
        push: async a => { const result = await h.push(a); return { result, commits: h.lastCommits || [] }; },
        mediaFiles: async paths => { const m = new Map(); for (const p of paths) if (files.has(p)) m.set(p, files.get(p)); return m; },
        mediaCopy: async docs => { for (const d of docs) if (!files.has(d.path)) files.set(d.path, Object.assign({}, d)); },
      };
      this.hubs.set(uid, h);
    }
    return this.hubs.get(uid).share;
  }
  memoryHub(uid) { this.hub(uid); return this.hubs.get(uid); }
  get index() {
    const E = this, skey = (id, uid, store, rid) => id + '|' + uid + '|' + keyOf(store, rid);
    return {
      get: async id => E.idx.has(id) ? JSON.parse(JSON.stringify(E.idx.get(id))) : null,
      put: async (id, d) => { const cur = E.idx.get(id) || {}; E.idx.set(id, Object.assign({}, cur, JSON.parse(JSON.stringify(d)))); },
      del: async id => { E.idx.delete(id); for (const m of [E.sh, E.who]) for (const k of [...m.keys()]) if (k.startsWith(id + '|')) m.delete(k); },
      owned: async uid => [...E.idx.values()].filter(x => x.ownerUid === uid).map(x => JSON.parse(JSON.stringify(x))),
      memberOf: async uid => [...E.idx.values()].filter(x => (x.memberUids || []).includes(uid)).map(x => JSON.parse(JSON.stringify(x))),
      lease: async id => { const x = E.idx.get(id) || {}; if (x.lockUntil && x.lockUntil > E.t) { x.dirty = true; E.idx.set(id, x); return false; } E.idx.set(id, Object.assign(x, { lockUntil: E.t + LEASE_MS, dirty: false })); return true; },
      release: async id => { const x = E.idx.get(id); if (!x) return false; const d = !!x.dirty; x.lockUntil = 0; x.dirty = false; if (!x.ownerUid) E.idx.delete(id); return d; },
      addIds: async (id, grow) => { const x = E.idx.get(id); if (!x) return; for (const [k, v] of Object.entries(grow)) x[k] = [...new Set([...(x[k] || []), ...v])]; },
      shadows: async (id, uid) => { const m = new Map(); for (const [k, v] of E.sh) if (k.startsWith(id + '|' + uid + '|')) m.set(keyOf(v.store, v.id), JSON.parse(JSON.stringify(v))); return m; },
      shadowsGet: async (id, uid, keys) => { const m = new Map(); for (const k of keys) { const v = E.sh.get(skey(id, uid, k.store, k.id)); if (v) m.set(keyOf(k.store, k.id), JSON.parse(JSON.stringify(v))); } return m; },
      shadowPut: async (id, uid, list) => { for (const s of list) E.sh.set(skey(id, uid, s.store, s.id), JSON.parse(JSON.stringify({ uid, store: s.store, id: String(s.id), rec: s.rec, ownerSeq: s.ownerSeq || 0 }))); },
      shadowDel: async (id, uid, keys) => { for (const k of keys) E.sh.delete(skey(id, uid, k.store, k.id)); },
      pendingList: async id => [...(E.pend.get(id) || new Map()).values()].map(x => JSON.parse(JSON.stringify(x))),
      pendingPut: async (id, p) => { if (!E.pend.has(id)) E.pend.set(id, new Map()); E.pend.get(id).set(p.pid, JSON.parse(JSON.stringify(p))); },
      pendingDel: async (id, pid) => { if (E.pend.has(id)) E.pend.get(id).delete(pid); },
      whoGet: async (id, keys) => { const m = new Map(); for (const k of keys) { const v = E.who.get(id + '|' + keyOf(k.store, k.id)); if (v !== undefined) m.set(keyOf(k.store, k.id), v); } return m; },
      whoPut: async (id, list) => { for (const x of list) E.who.set(id + '|' + keyOf(x.store, x.id), x.who); },
      shadowHas: async (id, store, rid) => [...E.sh.keys()].some(k => k.startsWith(id + '|') && k.endsWith('|' + keyOf(store, rid))),
    };
  }
}

module.exports = { holdDeletes, pendingFor, decide, holdOf, SHARES_MS, LEASE_MS, ROLES, MARKED, STORES, MEDIA_ID, shareIdOf, rootStore, grantsOf, sameish, withMark, stripMark, protect, mediaRefs,
  closureDocs, wantBlocks, closure, idxSets, belongs, fanOut, inbound, revert, relayPush, relayMedia, sharePass, syncShares, MemoryShareEnv };
