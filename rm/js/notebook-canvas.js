/* ================================================================
   notebook-canvas.js — V3.833 — the CANVAS lab notebook (rm/pages/notebook.html)
   ================================================================
   Gabe's Scientia pattern on our whiteboard engine: an entry IS a board.
   The sheet is the notebook (pen ink, continuous scroll, 🎙 recording and
   replay, ＋ From paper), and everything else is a WIDGET card placed on
   it from ＋ Insert — typed note, checklist, calculator, protocol followed,
   inventory item, figure, paper quote. Every card collapses to its header,
   moves and resizes in ⤧ Arrange, snaps to the grid, and tidies into a
   column. The engine (whiteboard.js) owns the cards' chrome, placement and
   export; this host renders the bodies (rm/js/canvas-widgets.js registry)
   and keeps the entry document's mirrors current.

   DATA — the same entry documents as before, plus one board per entry:
     userData/{uid}/notebooks/{notebookId}        the person's notebooks
     userData/{uid}/notebook/{entryId}            entry: title/date/tags/summary,
                                                  notebookId, boardId, canvas_version 3,
                                                  mirrors body_html / body_text /
                                                  protocol_run / protocol_refs / blocks[]
     userData/{uid}/notebook/_index               { entries: [row] } (transactional)
     userData/{uid}/notebookBoards/{boardId}      the board (+ strokes / items /
                                                  recordings / events) — widgets are
                                                  items of type 'widget' with `data`
   An entry made by the classic editor or the V3.830 block page is migrated
   onto its board the first time it opens here (blocks → widgets; a
   whiteboard block's board becomes the entry's board so its ink and
   recordings carry over). The blocks page then shows a read-only mirror.

   V3.837: Scientia's frame — a title line, the entries as TABS grouped by
   notebook, the sheet filling the rest, ⛶ full screen; the tools are the
   engine's radial pills (pens · tools · widgets · zoom). No classic view.
   No browser popups anywhere: inline forms, anchored menus, two-tap
   deletes, toasts.
   ================================================================ */
(function () {
'use strict';

const COLL = 'notebookBoards';
const SAVE_MS = 600;
const SUPPRESS_MS = 2500;
const MIRROR_MS = 900;
const SIZES = { medium: { max: 800, q: 0.85 }, full: { max: 1600, q: 0.9 } };
const PAPERS_CACHE_KEY = 'nbb_papers_v1';
const PAPERS_CACHE_MS = 15 * 60 * 1000;
const DEFAULT_NB = 'default';

const state = {
  user: null, uid: null, isAdmin: false,
  notebooks: [], notebookId: DEFAULT_NB,
  index: { entries: [] }, doc: null, docId: null,
  inst: null, mode: 'live', items: [],
  recUnsub: null, recs: [], recsOpen: false, timer: null, repaired: new Set(),
  pk: null,
  q: '', nbOpen: false, searchOpen: false, full: false, sideOpen: false, collapsed: {},
  saveTimer: null, pending: false, suppressUntil: 0, unsub: null, mirrorTimer: null, lastMirrorSig: '',
  runs: {}, protoLive: null, protocolsList: null, depsPromise: null, calcDepsPromise: null, inventory: null,
  photoTarget: null
};

/* ─── small helpers ─────────────────────────────────────────────── */
function $(id) { return document.getElementById(id); }
function esc(s) { return (s ?? '').toString().replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#039;' }[c])); }
function isoNow() { return new Date().toISOString(); }
function todayStr() { const d = new Date(); return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`; }
function newId(prefix) { return prefix + Date.now().toString(36) + Math.random().toString(36).slice(2, 7); }
function slugify(s, n) { return String(s || '').toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').split('-').filter(Boolean).slice(0, n || 4).join('-'); }
function toast(kind, msg) { if (window.TOAST && TOAST[kind]) TOAST[kind](msg); else console.log('[notebook]', kind, msg); }
function plainText(html) { const w = document.createElement('div'); w.innerHTML = String(html || ''); return (w.textContent || '').replace(/\s+/g, ' ').trim(); }
function db() { return firebridge.db(); }
function entriesCol() { return db().collection('userData').doc(state.uid).collection('notebook'); }
function entryRef(id) { return entriesCol().doc(id); }
function indexRef() { return entriesCol().doc('_index'); }
function notebooksCol() { return db().collection('userData').doc(state.uid).collection('notebooks'); }
function fmtDur(ms) { const s = Math.max(0, Math.round((ms || 0) / 1000)); const m = Math.floor(s / 60); return `${m}:${String(s % 60).padStart(2, '0')}`; }
function fmtDate(ms) { try { return new Date(ms).toLocaleDateString(undefined, { month: 'short', day: 'numeric', year: 'numeric' }); } catch (e) { return ''; } }
function isLocalDev() { return /^(localhost|127\.0\.0\.1)$/.test(location.hostname); }
function armTwoTap(btn, label) {
  if (btn.dataset.armed === '1') { btn.dataset.armed = ''; btn.classList.remove('nbk-armed'); return true; }
  btn.dataset.armed = '1'; const orig = btn.innerHTML; btn.innerHTML = label; btn.classList.add('nbk-armed');
  setTimeout(() => { if (btn.isConnected && btn.dataset.armed === '1') { btn.dataset.armed = ''; btn.innerHTML = orig; btn.classList.remove('nbk-armed'); } }, 3000);
  return false;
}
function loadScriptOnce(src, globalName) {
  if (globalName && window[globalName]) return Promise.resolve(window[globalName]);
  return new Promise((res, rej) => {
    const ex = document.querySelector(`script[src="${src}"]`);
    if (ex) { ex.addEventListener('load', () => res(window[globalName])); ex.addEventListener('error', rej); if (globalName && window[globalName]) res(window[globalName]); return; }
    const s = document.createElement('script'); s.src = src; s.onload = () => res(globalName ? window[globalName] : true); s.onerror = () => rej(new Error('failed to load ' + src)); document.head.appendChild(s);
  });
}
function loadCssOnce(id, href) { if (document.getElementById(id)) return; const l = document.createElement('link'); l.id = id; l.rel = 'stylesheet'; l.href = href; document.head.appendChild(l); }

/* ─── sanitizer (the V3.830 allowlist: structure + emphasis + Storage images) ─── */
const ALLOWED_TAGS = new Set(['P', 'BR', 'DIV', 'B', 'STRONG', 'I', 'EM', 'U', 'S', 'SUB', 'SUP', 'UL', 'OL', 'LI', 'H3', 'H4', 'BLOCKQUOTE', 'PRE', 'CODE', 'A', 'IMG', 'TABLE', 'THEAD', 'TBODY', 'TR', 'TH', 'TD', 'FIGURE', 'FIGCAPTION', 'SPAN', 'HR']);
const ALLOWED_ATTRS = { A: ['href', 'target', 'rel'], IMG: ['src', 'alt', 'data-storage-path', 'data-hash'], TD: ['colspan', 'rowspan'], TH: ['colspan', 'rowspan'] };
function isSafeUrl(href) { return /^(https?:\/\/|mailto:|\/)/i.test(String(href || '')); }
function isSafeImg(src) { return /^https:\/\/(firebasestorage\.googleapis\.com|storage\.googleapis\.com)\//i.test(String(src || '')) || /^\/api\//.test(String(src || '')); }
function sanitizeNode(node) {
  Array.from(node.childNodes).forEach(child => {
    if (child.nodeType === 8) { child.remove(); return; }
    if (child.nodeType !== 1) return;
    if (!ALLOWED_TAGS.has(child.tagName)) { while (child.firstChild) node.insertBefore(child.firstChild, child); child.remove(); return; }
    Array.from(child.attributes).forEach(a => { const ok = (ALLOWED_ATTRS[child.tagName] || []).includes(a.name); if (!ok) child.removeAttribute(a.name); });
    if (child.tagName === 'A') { if (!isSafeUrl(child.getAttribute('href'))) child.removeAttribute('href'); child.setAttribute('target', '_blank'); child.setAttribute('rel', 'noopener'); }
    if (child.tagName === 'IMG' && !isSafeImg(child.getAttribute('src'))) { child.remove(); return; }
    sanitizeNode(child);
  });
}
function sanitizeHtml(html) { const w = document.createElement('div'); w.innerHTML = String(html || ''); sanitizeNode(w); return w.innerHTML; }

/* ─── auth shim for the engine (module-panel precedent): McgheeLab.db + Auth ─── */
function installAuthShim() {
  const ML = window.McgheeLab = window.McgheeLab || {};
  if (!ML.db) ML.db = db();
  if (ML.Auth && ML.Auth.onChange) { if (!ML.Auth.currentUser && firebase.auth().currentUser) ML.Auth.currentUser = firebase.auth().currentUser; return ML.Auth; }
  const listeners = [];
  const Auth = {
    currentUser: firebase.auth().currentUser || null, currentProfile: null,
    onChange(fn) { listeners.push(fn); },
    offChange(fn) { const i = listeners.indexOf(fn); if (i >= 0) listeners.splice(i, 1); }
  };
  ML.Auth = Auth;
  firebase.auth().onAuthStateChanged(async (user) => {
    Auth.currentUser = user || null; Auth.currentProfile = null;
    if (user) { try { const d = await ML.db.collection('users').doc(user.uid).get(); Auth.currentProfile = d.exists ? d.data() : null; } catch (e) {} }
    listeners.slice().forEach(fn => { try { fn(Auth.currentUser, Auth.currentProfile); } catch (e) {} });
  });
  return Auth;
}

/* ================================================================
   boot + layout — Scientia's frame: a title line, the entries as tabs
   grouped by notebook, and the paper filling everything below. One tap
   (⛶) makes the sheet the whole screen.
   ================================================================ */
async function boot() {
  const content = $('nbc-content');
  if (typeof firebridge === 'undefined' || !firebridge.requireSignIn) { content.innerHTML = '<div class="nbk-gate">The sign-in bridge did not load.</div>'; return; }
  const gate = await firebridge.requireSignIn('The lab notebook is for lab members — sign in to open yours.');
  if (!gate.allowed) return;
  if (!firebridge.isLabMember()) { content.innerHTML = '<div class="nbk-gate">Your account is waiting for approval. The notebook opens once an admin promotes you to lab member.</div>'; return; }
  if (!window.Whiteboard?.mountBoardView || !window.CANVAS_WIDGETS) { content.innerHTML = '<div class="nbk-gate">The canvas engine did not load — reload the page.</div>'; return; }
  state.user = firebridge.getUser(); state.uid = state.user.uid; state.isAdmin = firebridge.isAdmin();
  installAuthShim();
  content.className = 'nbc-root';
  content.innerHTML = `
    <div class="nbc-header" id="nbc-header"></div>
    <div class="nbc-tabs" id="nbc-tabs"></div>
    <div class="nbc-stage" id="nbc-stage">
      <div class="nbb-main nbc-board">
        <div class="nbb-mount nbc-mount" id="nbb-mount"><div class="nbk-empty">Pick an entry above, or press ＋ on a notebook.</div></div>
        <aside class="nbb-picker" id="nbb-picker" hidden></aside>
        <aside class="nbc-side" id="nbc-side" hidden></aside>
      </div>
      <div class="nbc-sis" id="nbc-sis"></div>
    </div>`;
  registerKinds();
  wireUploads();
  /* V3.864 — Scientia (Gabe's app, the same notebook as his desktop app) is a notebook of this tab row */
  window.NOTEBOOK_SCIENTIA?.init?.({ uid: state.uid, renderTabs, renderHeader, park: parkCanvas });
  try { state.collapsed = JSON.parse(localStorage.getItem('nbc_groups') || '{}') || {}; } catch (e) { state.collapsed = {}; }
  await Promise.all([loadIndex(), loadNotebooks()]);
  const qs = new URLSearchParams(location.search);
  const wantNb = qs.get('notebook');
  if (wantNb && state.notebooks.some(n => n.id === wantNb)) state.notebookId = wantNb;
  renderHeader(); renderTabs();
  const want = qs.get('entry');
  const rows = sortedRows(true), mine = sortedRows(false);
  /* V3.842 — an instance's "open the source" link names the BOARD */
  const wantBoard = qs.get('board'); const byBoard = wantBoard ? rows.find(r => r.board_id === wantBoard) : null;
  /* V3.864 — ?notebook=scientia[&note=<id>], or the person's last view was Scientia (and no link names a canvas entry) */
  const SIS = window.NOTEBOOK_SCIENTIA;
  const sisFirst = !!SIS && !byBoard && !(want && rows.some(r => r.id === want)) && !qs.get('item') && !qs.get('action') && (wantNb === 'scientia' || await SIS.shouldOpen());
  if (sisFirst) await SIS.show(qs.get('note') ? '#/doc/' + encodeURIComponent(qs.get('note')) : null);
  else if (byBoard) await openEntry(byBoard.id);
  else if (want && rows.some(r => r.id === want)) await openEntry(want);
  else if (mine[0]) await openEntry(mine[0].id);
  else if (rows[0]) await openEntry(rows[0].id);
  /* V3.853 — ?item=<id>: a My Week result points at one card of the entry that opened; centre + pulse it */
  const wantItem = qs.get('item');
  if (wantItem && state.inst && state.inst.focusItem) state.inst.focusItem(wantItem);
  /* V3.844 — ?action=<id>: "Something I did" dropped into the entry that opened */
  const wantAction = qs.get('action');
  if (wantAction) insertActionById(wantAction);
  document.addEventListener('fullscreenchange', () => { if (!document.fullscreenElement && state.full) setFull(false, true); });
  document.addEventListener('keydown', (e) => { if (e.key === 'Escape' && state.full && !document.fullscreenElement && !document.querySelector('.cw-pop')) setFull(false); });
  window.addEventListener('beforeunload', () => { if (state.inst?.isRecording?.()) { try { state.inst.stopRecording('pagehide'); } catch (e) {} } });
}

/* ─── notebooks (the folder became a list; a notebook is a tab group) ─── */
async function loadNotebooks() {
  try {
    const snap = await notebooksCol().get();
    state.notebooks = snap.docs.map(d => Object.assign({ id: d.id }, d.data())).filter(n => !n.archived);
  } catch (e) { console.warn('[notebook] notebooks load', e); state.notebooks = []; }
  if (!state.notebooks.some(n => n.id === DEFAULT_NB)) {
    const nb = { name: 'My notebook', color: '#0D675E', projectId: null, memberUids: [], created: isoNow(), archived: false, ownerUid: state.uid };
    try { await notebooksCol().doc(DEFAULT_NB).set(nb, { merge: true }); } catch (e) { console.warn('[notebook] default notebook', e); }
    state.notebooks.unshift(Object.assign({ id: DEFAULT_NB }, nb));
  }
  state.notebooks.sort((a, b) => (a.id === DEFAULT_NB ? -1 : b.id === DEFAULT_NB ? 1 : String(a.created || '').localeCompare(String(b.created || ''))));
  if (!state.notebooks.some(n => n.id === state.notebookId)) state.notebookId = DEFAULT_NB;
}
const NB_COLORS = ['#0D675E', '#93285C', '#85590A', '#22693D', '#2F6FB0', '#6B4FA3', '#A0331F'];
async function createNotebook(name) {
  const id = slugify(name, 4) || newId('nb');
  const finalId = state.notebooks.some(n => n.id === id) ? id + '-' + Date.now().toString(36).slice(-3) : id;
  const nb = { name: name.trim(), color: NB_COLORS[state.notebooks.length % NB_COLORS.length], projectId: null, memberUids: [], created: isoNow(), archived: false, ownerUid: state.uid };
  await notebooksCol().doc(finalId).set(nb);
  state.notebooks.push(Object.assign({ id: finalId }, nb));
  state.notebookId = finalId;
  renderTabs(); renderHeader();
  return finalId;
}
function currentNotebook() { return state.notebooks.find(n => n.id === state.notebookId) || state.notebooks[0]; }

/* ─── index (transactional, the V3.830 shape + canvas fields) ─── */
async function loadIndex() {
  try { const s = await indexRef().get(); const d = s.exists ? s.data() : null; state.index = { entries: Array.isArray(d?.entries) ? d.entries : [] }; }
  catch (e) { console.warn('[notebook] index load', e); state.index = { entries: [] }; }
}
function rowFor(doc) {
  const row = (typeof notebookIndexRow === 'function') ? notebookIndexRow(doc) : { id: doc.id, title: doc.title, date: doc.date, tags: doc.tags || [], updated_at: doc.updated_at };
  row.block_count = Array.isArray(doc.blocks) ? doc.blocks.length : 0;
  row.block_types = Array.isArray(doc.blocks) ? Array.from(new Set(doc.blocks.map(b => b.type))) : [];
  row.schema_version = 2;
  row.canvas_version = doc.canvas_version || null;
  row.notebook_id = doc.notebookId || DEFAULT_NB;
  row.board_id = doc.boardId || null;
  Object.keys(row).forEach(k => { if (row[k] === undefined) delete row[k]; });
  return row;
}
async function upsertIndexRow(doc) {
  const row = rowFor(doc);
  await db().runTransaction(async (tx) => {
    const s = await tx.get(indexRef());
    const entries = (s.exists && Array.isArray(s.data().entries)) ? s.data().entries.slice() : [];
    const i = entries.findIndex(r => r && r.id === row.id);
    if (i >= 0) entries[i] = row; else entries.unshift(row);
    tx.set(indexRef(), { entries, updatedAt: firebase.firestore.FieldValue.serverTimestamp() }, { merge: true });
  });
  const i = state.index.entries.findIndex(r => r && r.id === row.id);
  if (i >= 0) state.index.entries[i] = row; else state.index.entries.unshift(row);
}
async function removeIndexRow(id) {
  await db().runTransaction(async (tx) => {
    const s = await tx.get(indexRef());
    const entries = (s.exists && Array.isArray(s.data().entries)) ? s.data().entries.filter(r => r && r.id !== id) : [];
    tx.set(indexRef(), { entries, updatedAt: firebase.firestore.FieldValue.serverTimestamp() }, { merge: true });
  });
  state.index.entries = state.index.entries.filter(r => r && r.id !== id);
}
function sortedRows(all) {
  const q = state.q.trim().toLowerCase();
  return (state.index.entries || []).filter(r => r && r.id && r.id !== '_index' && r.id !== '_templates')
    .filter(r => all || ((r.notebook_id || DEFAULT_NB) === state.notebookId))
    .filter(r => !q || `${r.title} ${(r.tags || []).join(' ')} ${r.excerpt || ''}`.toLowerCase().includes(q))
    .sort((a, b) => String(b.date || '').localeCompare(String(a.date || '')) || String(b.updated_at || '').localeCompare(String(a.updated_at || '')));
}

/* ================================================================
   entries
   ================================================================ */
function newBoardId() { return 'nb' + Date.now().toString(36) + Math.random().toString(36).slice(2, 6) + '_' + state.uid; }
async function loadEntry(id) {
  const s = await entryRef(id).get();
  if (!s.exists) return null;
  const raw = Object.assign({ id }, s.data());
  const doc = (typeof notebookHydrate === 'function') ? notebookHydrate(raw) : raw;
  if (!Array.isArray(doc.tags)) doc.tags = [];
  if (!doc.notebookId) doc.notebookId = DEFAULT_NB;
  return doc;
}
async function createEntry(title, date, notebookId) {
  const nbId = notebookId || state.notebookId;
  const base = `nb-${date}-${slugify(title, 4) || 'entry'}`;
  let id = base, k = 2;
  while (state.index.entries.some(r => r && r.id === id)) id = `${base}-${k++}`;
  const doc = { id, title: title || 'Untitled entry', date, tags: [], summary: '', notebookId: nbId, boardId: newBoardId(), canvas_version: 3, schema_version: 2,
    blocks: [], body_html: '', body_text: '', protocol_run: null, protocol_refs: [], attachments: [], status: 'open', created_at: isoNow(), updated_at: isoNow(), ownerUid: state.uid };
  const out = Object.assign({}, doc); delete out.id; out.updatedAt = firebase.firestore.FieldValue.serverTimestamp();
  await entryRef(id).set(out, { merge: true });
  await upsertIndexRow(doc);
  state.notebookId = nbId;
  await openEntry(id);
  return id;
}
/* ＋ on a notebook tab: a dated entry right away; the title is edited in the header */
async function quickNewEntry(notebookId) {
  try {
    await createEntry('Untitled entry', todayStr(), notebookId);
    CANVAS_WIDGETS.autoFocus($('nbc-title'), { select: true });   /* V3.863 — no keyboard on a touch screen until you tap the title */
  } catch (e) { toast('error', 'Could not create the entry: ' + (e.message || e)); }
}
/* V3.864 — Scientia opens in the stage: save and put the canvas entry away (its tab reopens it) */
async function parkCanvas() {
  if (state.doc && state.pending) await saveEntry();
  detachLive(); unmountRuns(); unmountBoard();
  state.doc = null; state.docId = null; state.items = []; state.protoLive = null; state.lastMirrorSig = '';
  const m = $('nbb-mount'); if (m) m.innerHTML = '<div class="nbk-empty">Pick an entry above, or press ＋ on a notebook.</div>';
  window.LAB_NOTEBOOK_STATE = { docId: null };
}
async function openEntry(id) {
  window.NOTEBOOK_SCIENTIA?.hide?.();
  if (state.doc && state.pending) await saveEntry();
  detachLive(); unmountRuns(); unmountBoard();
  state.doc = null; state.docId = id; state.items = []; state.protoLive = null; state.lastMirrorSig = '';
  $('nbb-mount').innerHTML = '<div class="nbk-loading">Opening…</div>';
  let doc = null;
  try { doc = await loadEntry(id); } catch (e) { console.warn('[notebook] load', e); }
  if (!doc) { $('nbb-mount').innerHTML = '<div class="nbk-empty">That entry could not be opened.</div>'; renderHeader(); return; }
  if (state.docId !== id) return;
  /* migration, step 1: the entry's board. A V3.830 whiteboard block's board
     becomes the entry's board so its ink and recordings carry over. */
  let changed = false;
  if (!doc.boardId || !String(doc.boardId).endsWith('_' + state.uid)) {
    const wb = Array.isArray(doc.blocks) ? doc.blocks.find(b => b && b.type === 'whiteboard' && b.data && typeof b.data.boardId === 'string' && b.data.boardId.endsWith('_' + state.uid)) : null;
    doc.boardId = wb ? wb.data.boardId : newBoardId();
    if (wb) wb._adopted = true;
    changed = true;
  }
  state.doc = doc;
  if (state.notebooks.some(n => n.id === doc.notebookId)) state.notebookId = doc.notebookId;
  history.replaceState(null, '', `?entry=${encodeURIComponent(id)}${state.notebookId !== DEFAULT_NB ? '&notebook=' + encodeURIComponent(state.notebookId) : ''}`);
  window.LAB_NOTEBOOK_STATE = { docId: id };
  renderTabs(); renderHeader();
  await mountLive();
  attachLive(id);
  watchRecordings();
  if (changed && doc.canvas_version) scheduleSave();
}
function scheduleSave() {
  if (!state.doc) return;
  state.pending = true; setStatus('editing…');
  clearTimeout(state.saveTimer);
  state.saveTimer = setTimeout(saveEntry, SAVE_MS);
}
async function saveEntry() {
  const doc = state.doc; if (!doc) return;
  clearTimeout(state.saveTimer);
  /* canvas_version is stamped by createEntry / migrateIfNeeded only — a save before the
     migration ran must not make the migration think it already happened */
  doc.updated_at = isoNow(); doc.schema_version = 2; doc.ownerUid = state.uid;
  if (!doc.notebookId) doc.notebookId = DEFAULT_NB;
  /* before the migration has run, blocks[] IS the content — never overwrite it from an empty board */
  if (doc.canvas_version) computeMirrors(doc, state.inst ? state.inst.getItems() : state.items);
  const out = JSON.parse(JSON.stringify(doc, (k, v) => (k.startsWith('_') || v === undefined) ? undefined : v));
  delete out.id;
  out.updatedAt = firebase.firestore.FieldValue.serverTimestamp();
  state.suppressUntil = Date.now() + SUPPRESS_MS;
  try {
    await entryRef(doc.id).set(out, { merge: true });
    await upsertIndexRow(doc);
    state.pending = false;
    setStatus('saved ' + new Date().toLocaleTimeString(undefined, { hour: 'numeric', minute: '2-digit' }));
    renderTabs();
    try { window.ActivitySignals?.recordWork?.({ source: 'rm-notebook', sourceRef: { kind: 'notebook', id: doc.id }, text: 'Notebook: ' + (doc.title || doc.id), categoryPath: ['research', 'notebook'] }); } catch (e) {}
  } catch (e) {
    console.warn('[notebook] save failed', e);
    setStatus('not saved — ' + (e.message || e));
    toast('error', 'Could not save the entry: ' + (e.message || e));
  }
}
function setStatus(t) { const n = $('nbc-status'); if (n) n.textContent = t || ''; }
function attachLive(id) {
  detachLive();
  state.unsub = entryRef(id).onSnapshot(s => {
    if (!state.doc || state.docId !== id || !s.exists) return;
    if (Date.now() < state.suppressUntil || state.pending) return;
    const d = s.data();
    if (!d || d.updated_at === state.doc.updated_at) return;
    const head = $('nbc-header');
    if (head && head.contains(document.activeElement)) return;
    const doc = (typeof notebookHydrate === 'function') ? notebookHydrate(Object.assign({ id }, d)) : Object.assign({ id }, d);
    if (!Array.isArray(doc.tags)) doc.tags = [];
    doc.boardId = state.doc.boardId; doc.notebookId = doc.notebookId || state.doc.notebookId;
    state.doc = doc; renderHeader(); renderTabs();
  }, err => console.warn('[notebook] live sync', err));
}
function detachLive() { if (state.unsub) { try { state.unsub(); } catch (e) {} state.unsub = null; } }
async function deleteEntry(id) {
  detachLive(); unmountRuns(); unmountBoard();
  try { await entryRef(id).delete(); await removeIndexRow(id); toast('success', 'Entry deleted. Its board stays stored under your account.'); }
  catch (e) { toast('error', 'Could not delete: ' + (e.message || e)); return; }
  state.doc = null; state.docId = null;
  renderTabs(); renderHeader();
  const rows = sortedRows(false);
  if (rows[0]) openEntry(rows[0].id); else { history.replaceState(null, '', location.pathname); $('nbb-mount').innerHTML = '<div class="nbk-empty">No entries in this notebook yet — press ＋ on its tab.</div>'; }
}
async function moveEntryToNotebook(nbId) {
  const doc = state.doc; if (!doc || !state.notebooks.some(n => n.id === nbId)) return;
  doc.notebookId = nbId; state.notebookId = nbId;
  await saveEntry();
  renderTabs(); renderHeader();
  toast('success', `Moved to “${(state.notebooks.find(n => n.id === nbId) || {}).name || nbId}”.`);
}

/* ─── mirrors: what PMR, the rail, the blocks page and the classic editor read ─── */
function widgetToBlock(it) {
  const d = it.data || {};
  const base = { id: it.id, title: it.title || '', collapsed: !!it.collapsed, created_at: it.stampAt ? new Date(it.stampAt).toISOString() : isoNow() };
  switch (it.type === 'widget' ? it.kind : it.type) {
    case 'note': return Object.assign(base, { type: 'note', data: { html: d.html || '' } });
    case 'checklist': return Object.assign(base, { type: 'checklist', data: { items: Array.isArray(d.items) ? d.items : [] } });
    case 'calc': return Object.assign(base, { type: 'calc', data: { spec: d.spec || null, inputs: d.inputs || {}, context: d.context || [], result: d.result || '' } });
    case 'protocol': return Object.assign(base, { type: 'protocol', data: { run: d.run || null } });
    case 'figure': { const c = (d.cells || [])[0] || {}; return Object.assign(base, { type: 'figure', data: { url: c.url || d.url || '', storage_path: c.storagePath || d.storage_path || '', hash: c.hash || '', caption: c.caption || d.caption || '' } }); }
    case 'paperquote': return Object.assign(base, { type: 'note', data: { html: `<blockquote>${esc(d.text || '')}</blockquote>${d.cite ? `<p><em>${esc(d.cite)}</em></p>` : ''}` } });
    case 'inventory': return Object.assign(base, { type: 'note', title: base.title || (d.name || 'Inventory item'), data: { html: `<p>${esc(d.name || '')}${d.location ? ' · ' + esc(d.location) : ''}${(d.usage || []).length ? ' · used: ' + esc((d.usage || []).map(u => `${u.qty} ${u.unit || ''}`.trim()).join(', ')) : ''}</p>` } });
    case 'litreview': {
      /* V3.838 — the review reads as a note in PMR / the mirrors: query, papers per section, key points */
      const P = d.papers || {};
      const html = `<p><strong>${esc(it.title || 'Lit review')}</strong>${d.query ? ' — ' + esc(d.query) : ''}</p>` + (d.sections || []).map(sec =>
        `<h4>${esc(sec.title || 'Section')}</h4>` +
        ((sec.paperIds || []).length ? `<ul>${sec.paperIds.map(pid => `<li>${esc((P[pid] || {}).title || pid)}${(P[pid] || {}).cite ? ' — ' + esc(P[pid].cite) : ''}${(P[pid] || {}).why ? ': <em>' + esc(P[pid].why) + '</em>' : ''}</li>`).join('')}</ul>` : '') +
        ((sec.keyPoints || []).filter(Boolean).length ? `<p><strong>Key points</strong></p><ul>${sec.keyPoints.filter(Boolean).map(k => `<li>${esc(k)}</li>`).join('')}</ul>` : '')).join('');
      return Object.assign(base, { type: 'note', data: { html } });
    }
    case 'collection': return Object.assign(base, { type: 'note', data: { html: window.CANVAS_PAPER_READER ? CANVAS_PAPER_READER.toHtml(it) : '' } });   /* V3.859 */
    case 'boardlink': return Object.assign(base, { type: 'whiteboard', data: { boardId: d.boardId || '', size: 'm' } });
    case 'html': return d.url ? Object.assign(base, { type: 'note', title: base.title || d.name || 'HTML frame', data: { html: `<p>⧉ <a href="${esc(d.url)}" target="_blank" rel="noopener">${esc(d.name || 'HTML frame')}</a> (HTML frame)</p>` } }) : null;   /* V3.841 */
    case 'text': return Object.assign(base, { type: 'note', data: { html: `<blockquote>${esc(it.text || '')}</blockquote>${it.cite ? `<p><em>${esc(it.cite)}</em></p>` : ''}` } });
    default:
      if (!it.type && it.url) return Object.assign(base, { type: 'figure', data: { url: it.url, storage_path: it.storagePath || '', hash: '', caption: it.srcLabel || '' } });
      return null;
  }
}
function computeMirrors(doc, items) {
  const ordered = (items || []).slice().sort((a, b) => (pageOrder(a) - pageOrder(b)) || ((a.y || 0) - (b.y || 0)) || ((a.x || 0) - (b.x || 0)));
  const blocks = ordered.map(widgetToBlock).filter(Boolean);
  const parts = [];
  blocks.forEach(b => {
    const t = b.title ? `<h3>${esc(b.title)}</h3>` : '';
    switch (b.type) {
      case 'note': parts.push(t + (b.data.html || '')); break;
      case 'calc': parts.push(t + `<p class="nbk-mirror">${esc(b.data.spec?.attrs?.label || 'Calculator')}${b.data.result ? ': ' + esc(b.data.result) : ''}</p>`); break;
      case 'protocol': if (b.data.run) parts.push(t + `<p class="nbk-mirror">Protocol followed: ${esc(b.data.run.protocol_title || b.data.run.protocol_id)}${b.data.run.frozen ? ' (finalized)' : ''}</p>`); break;
      case 'whiteboard': parts.push(t + `<p class="nbk-mirror">Whiteboard</p>`); break;
      case 'figure': if (b.data.url) parts.push(t + `<figure><img src="${esc(b.data.url)}" alt="${esc(b.data.caption || '')}" data-storage-path="${esc(b.data.storage_path || '')}"><figcaption>${esc(b.data.caption || '')}</figcaption></figure>`); break;
      case 'checklist': { const it = b.data.items || []; parts.push(t + `<ul>${it.map(i => `<li>${i.done ? '☒' : '☐'} ${esc(i.text || '')}</li>`).join('')}</ul>`); break; }
    }
  });
  if (String(doc.summary || '').trim()) parts.unshift(`<p class="nbk-mirror"><strong>Summary:</strong> ${esc(doc.summary)}</p>`);
  doc.blocks = blocks;
  doc.body_html = parts.join('\n');
  doc.body_text = plainText(doc.body_html);
  const firstProto = blocks.find(b => b.type === 'protocol' && b.data.run);
  doc.protocol_run = firstProto ? firstProto.data.run : null;
  doc.protocol_refs = blocks.filter(b => b.type === 'protocol' && b.data.run).map(b => ({ id: b.data.run.protocol_id, title: b.data.run.protocol_title || b.data.run.protocol_id }));
  return doc;
}
function pageOrder(it) { const pages = state.inst?.getBoard?.()?.pages || []; const i = pages.findIndex(p => p.id === it.pageId); return i < 0 ? 999 : i; }
/* the engine tells us the items changed (ours or an echo): recompute the
   mirrors and write them only when they differ */
function onItemsChanged() {
  if (!state.inst || !state.doc || state.mode !== 'live') return;
  state.items = state.inst.getItems();
  try { window.CANVAS_PAPER_READER && CANVAS_PAPER_READER.onItemsChanged(); } catch (e) { console.warn('[notebook] collections', e); }   /* V3.859 — mirrors + draft links */
  if (!state.doc.canvas_version) return;   // the migration will write the first mirrors
  clearTimeout(state.mirrorTimer);
  state.mirrorTimer = setTimeout(() => {
    if (!state.doc || !state.inst) return;
    const probe = JSON.parse(JSON.stringify(state.doc, (k, v) => (k.startsWith('_') || v === undefined) ? undefined : v));
    computeMirrors(probe, state.items);
    const sig = JSON.stringify([probe.body_html, probe.protocol_run, probe.blocks.map(b => [b.id, b.type, b.title, b.collapsed])]);
    if (sig === state.lastMirrorSig) return;
    state.lastMirrorSig = sig;
    if (probe.body_html !== state.doc.body_html || JSON.stringify(probe.protocol_run || null) !== JSON.stringify(state.doc.protocol_run || null) || JSON.stringify(probe.blocks) !== JSON.stringify(state.doc.blocks || [])) scheduleSave();
  }, MIRROR_MS);
}

/* ================================================================
   header · tabs · full screen
   ================================================================ */
function fmtTabDate(d) { if (!d) return ''; const [y, m, dd] = String(d).split('-').map(Number); if (!y) return d; return `${dd} ${['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'][(m || 1) - 1]}`; }
function renderHeader() {
  const h = $('nbc-header'); if (!h) return;
  /* V3.864 — Scientia open: its header (sync with the desktop app) */
  if (window.NOTEBOOK_SCIENTIA?.active?.()) {
    NOTEBOOK_SCIENTIA.renderHeader(h, { full: state.full, searchOpen: state.searchOpen });
    h.querySelector('[data-h="search"]')?.addEventListener('click', () => { state.searchOpen = !state.searchOpen; if (!state.searchOpen) state.q = ''; renderTabs(); renderHeader(); if (state.searchOpen) setTimeout(() => $('nbc-q')?.focus(), 30); });
    h.querySelector('[data-h="full"]')?.addEventListener('click', () => setFull(!state.full));
    return;
  }
  const doc = state.doc;
  h.innerHTML = `
    <a class="nbc-brand" href="/rm/" title="Lab notebook — back to RM">NB</a>
    ${doc ? `<input type="text" class="nbc-title" id="nbc-title" value="${esc(doc.title)}" placeholder="Untitled entry" maxlength="140" spellcheck="false">
      <div class="nbc-meta">
        <input type="date" class="nbc-date" id="nbc-date" value="${esc(doc.date)}" title="Entry date">
        <input type="text" class="nbc-tags" id="nbc-tags" value="${esc((doc.tags || []).join(', '))}" placeholder="tags" title="Tags, comma separated">
        <input type="text" class="nbc-summary" id="nbc-summary" value="${esc(doc.summary || '')}" placeholder="what this entry adds up to…" maxlength="300" title="One line you would tell your advisor">
        <span class="nbc-status" id="nbc-status"></span>
      </div>`
      : `<span class="nbc-title nbc-title-empty">Lab Notebook</span><div class="nbc-meta"><span class="nbc-status" id="nbc-status"></span></div>`}
    <span class="spacer"></span>
    <button type="button" class="nbc-ib${state.searchOpen ? ' nbc-on' : ''}" data-h="search" title="Find an entry">⌕</button>
    ${doc ? '<button type="button" class="nbc-ib" data-h="more" title="Entry actions">⋯</button>' : ''}
    <button type="button" class="nbc-ib${state.full ? ' nbc-on' : ''}" data-h="full" title="${state.full ? 'Leave full screen (Esc)' : 'Full screen — the sheet fills the screen'}">⛶</button>`;
  if (doc) {
    let tt = null;
    $('nbc-title').addEventListener('input', (e) => { doc.title = e.target.value; scheduleSave(); clearTimeout(tt); tt = setTimeout(renderTabs, 300); });
    $('nbc-title').addEventListener('keydown', (e) => { if (e.key === 'Enter') { e.preventDefault(); e.target.blur(); } });
    $('nbc-date').addEventListener('change', (e) => { if (e.target.value) { doc.date = e.target.value; scheduleSave(); renderTabs(); } });
    $('nbc-tags').addEventListener('change', (e) => { doc.tags = e.target.value.split(',').map(t => t.trim().toLowerCase().replace(/\s+/g, '-')).filter(Boolean); scheduleSave(); });
    $('nbc-summary').addEventListener('change', (e) => { doc.summary = e.target.value.trim(); scheduleSave(); });
  }
  h.querySelector('[data-h="search"]').addEventListener('click', () => { state.searchOpen = !state.searchOpen; if (!state.searchOpen) state.q = ''; renderTabs(); renderHeader(); if (state.searchOpen) setTimeout(() => $('nbc-q')?.focus(), 30); });
  h.querySelector('[data-h="full"]').addEventListener('click', () => setFull(!state.full));
  const more = h.querySelector('[data-h="more"]');
  if (more) more.addEventListener('click', () => {
    const others = state.notebooks.filter(n => n.id !== doc.notebookId);
    CANVAS_WIDGETS.actionMenu({ anchor: more, title: doc.title || 'Entry', items: [
      ...others.map(n => ({ label: 'Move to “' + (n.name || n.id) + '”', run: () => moveEntryToNotebook(n.id) })),
      { label: 'Tidy every page', sub: 'Stack the cards of each page into a column', run: async () => { if (!state.inst) return; const pages = state.inst.getBoard()?.pages || []; let n = 0; for (const p of pages) n += await state.inst.tidy(p.id); toast('success', `Tidied ${n} cards.`); } },
      { label: 'Delete this entry', sub: 'The board stays stored under your account', danger: true, confirm: 'Really delete?', run: () => deleteEntry(doc.id) }
    ] });
  });
}
function renderTabs() {
  const t = $('nbc-tabs'); if (!t) return;
  const rows = sortedRows(true);
  const groups = state.notebooks.map(nb => ({ nb, rows: rows.filter(r => (r.notebook_id || DEFAULT_NB) === nb.id) }));
  const activeNb = window.NOTEBOOK_SCIENTIA?.active?.() ? null : (state.doc ? state.doc.notebookId : state.notebookId);
  t.innerHTML = `<div class="nbc-tabrow">` + groups.map(g => {
    const col = !!state.collapsed[g.nb.id] && activeNb !== g.nb.id;
    return `<div class="nbc-group${col ? ' nbc-col' : ''}${activeNb === g.nb.id ? ' nbc-group-on' : ''}" data-nb="${esc(g.nb.id)}" style="--nbc:${esc(g.nb.color || '#0D675E')}">
      <button type="button" class="nbc-gname" data-t="group" title="${col ? 'Show' : 'Fold'} this notebook's entries"><i></i>${esc(g.nb.name || g.nb.id)}<small>${g.rows.length}</small></button>
      ${col ? '' : g.rows.map(r => `<button type="button" class="nbc-tab${r.id === state.docId ? ' nbc-tab-on' : ''}" data-t="entry" data-id="${esc(r.id)}" title="${esc(r.title || 'Untitled')} · ${esc(r.date || '')}"><span class="nbc-tab-title">${esc(r.title || 'Untitled')}</span><span class="nbc-tab-date">${esc(fmtTabDate(r.date))}</span></button>`).join('')}
      <button type="button" class="nbc-tab-add" data-t="add" title="New entry in ${esc(g.nb.name || g.nb.id)}">＋</button>
    </div>`;
  }).join('') + (window.NOTEBOOK_SCIENTIA ? NOTEBOOK_SCIENTIA.tabsHtml({ q: state.q }) : '') +
    `${state.nbOpen ? `<span class="nbc-nb-form"><input type="text" id="nbc-nb-name" placeholder="New notebook…" maxlength="80"><button type="button" class="nbc-ib" data-t="nb-create" title="Create">✓</button><button type="button" class="nbc-ib" data-t="nb-cancel" title="Cancel">✕</button></span>`
      : `<button type="button" class="nbc-nb-add" data-t="nb-add" title="A new notebook (a new group of entries)">＋ Notebook</button>`}
    ${state.searchOpen ? `<span class="nbc-search"><input type="search" id="nbc-q" placeholder="Find an entry…" value="${esc(state.q)}" autocomplete="off"></span>` : ''}
  </div>`;
  if (!t.dataset.wired) {
    t.dataset.wired = '1';
    t.addEventListener('click', async (e) => {
      const b = e.target.closest('[data-t]'); if (!b) return;
      const act = b.dataset.t, nbId = b.closest('.nbc-group')?.dataset.nb;
      if (act.startsWith('sis-')) { window.NOTEBOOK_SCIENTIA?.onTab?.(b); return; }   /* V3.864 — the Scientia group */
      if (act === 'entry') openEntry(b.dataset.id);
      else if (act === 'add') quickNewEntry(nbId);
      else if (act === 'group') { state.collapsed[nbId] = !state.collapsed[nbId]; try { localStorage.setItem('nbc_groups', JSON.stringify(state.collapsed)); } catch (err) {} state.notebookId = nbId; renderTabs(); }
      else if (act === 'nb-add') { state.nbOpen = true; renderTabs(); setTimeout(() => $('nbc-nb-name')?.focus(), 30); }
      else if (act === 'nb-cancel') { state.nbOpen = false; renderTabs(); }
      else if (act === 'nb-create') { const name = $('nbc-nb-name')?.value.trim(); if (!name) { $('nbc-nb-name')?.focus(); return; } state.nbOpen = false; try { await createNotebook(name); toast('success', `Notebook “${name}” created — press ＋ on it for a first entry.`); } catch (err) { toast('error', 'Could not create the notebook: ' + (err.message || err)); renderTabs(); } }
    });
    t.addEventListener('keydown', (e) => { if (e.target.id === 'nbc-nb-name' && e.key === 'Enter') { e.preventDefault(); t.querySelector('[data-t="nb-create"]')?.click(); } if (e.target.id === 'nbc-nb-name' && e.key === 'Escape') { state.nbOpen = false; renderTabs(); } });
    t.addEventListener('input', (e) => { if (e.target.id === 'nbc-q') { state.q = e.target.value; const v = e.target.value; renderTabs(); const q = $('nbc-q'); if (q) { q.focus(); q.setSelectionRange(v.length, v.length); } } });
  }
  const on = t.querySelector('.nbc-tab-on'); if (on && on.scrollIntoView) { try { on.scrollIntoView({ block: 'nearest', inline: 'nearest' }); } catch (e) {} }
}
/* ⛶ — the sheet is the whole screen: the site bar, the title line and the
   tabs go; the pills stay (the Tools pill's ⛶ and Esc bring it back) */
function setFull(on, fromBrowser) {
  state.full = !!on;
  document.body.classList.toggle('nbc-full', state.full);
  if (state.full && !fromBrowser && document.documentElement.requestFullscreen && !document.fullscreenElement) { try { const p = document.documentElement.requestFullscreen(); if (p && p.catch) p.catch(() => {}); } catch (e) {} }
  if (!state.full && document.fullscreenElement && document.exitFullscreen) { try { const p = document.exitFullscreen(); if (p && p.catch) p.catch(() => {}); } catch (e) {} }
  renderHeader();
  if (state.inst) state.inst.setTools(toolsList());
  setTimeout(() => window.dispatchEvent(new Event('resize')), 60);
}

/* ================================================================
   the board (the engine) — mount, record, replay
   ================================================================ */
const THEME = { desk: '#E6E1D7', page: '#F1EDE5', edge: 'rgba(36,33,28,.10)', grid: 'rgba(36,33,28,.07)', ruled: 'rgba(13,103,94,.16)', divider: '#BCB4A4' };
function unmountBoard() {
  closePicker(); closeSide();
  try { window.WhiteboardReplay?.teardown?.(); } catch (e) {}
  if (state.inst) { try { state.inst.destroy(); } catch (e) {} }
  state.inst = null; state.mode = 'live';
  if (state.recUnsub) { try { state.recUnsub(); } catch (e) {} state.recUnsub = null; }
  state.recs = [];
}
function boardTitle() { return state.doc ? (state.doc.title || 'Entry') : 'Entry'; }
function toolsList() {
  const n = state.recs.length;
  return [
    { act: 'paper', icon: 'document-text', label: 'From a paper in the library', active: !!($('nbb-picker') && !$('nbb-picker').hidden) },
    { act: 'recs', icon: 'play', label: n ? `Recordings (${n})` : 'Recordings (none yet)', active: !!state.sideOpen },
    { act: 'max', icon: '⛶', label: state.full ? 'Leave full screen' : 'Full screen', active: !!state.full }
  ];
}
function insertList() { return CANVAS_WIDGETS.list({ doc: state.doc }).filter(k => !k.insertOnly).map(k => ({ kind: k.kind, icon: k.icon, label: k.label })); }
async function insertKind(kind, at) {
  const def = CANVAS_WIDGETS.get(kind);
  if (!def || !state.inst) return null;
  if (def.insertOnly) { try { def.run({ doc: state.doc, at }); } catch (e) { console.warn(e); } return null; }
  let spec = null;
  try { spec = def.make ? def.make({ doc: state.doc }) : { title: '', data: {} }; } catch (e) { console.warn(e); }
  if (!spec) return null;
  const id = await state.inst.addWidget(Object.assign({ kind: def.kind, w: def.w }, spec, at ? { pageId: at.pageId, x: at.x, y: at.y } : {}));
  if (id && def.focusAfter) setTimeout(() => { const n = document.querySelector(`.wb-item-widget[data-item-id="${CSS.escape(id)}"] ${def.focusAfter}`); CANVAS_WIDGETS.autoFocus(n); }, 350);
  return id;
}
/* a new entry's board starts on Scientia's graph paper */
async function ensureBoardDoc(doc) {
  const ref = window.Whiteboard.boardsCol(state.uid, COLL).doc(doc.boardId);
  const s = await ref.get();
  if (s.exists) return;
  await ref.set({ name: boardTitle(), pages: [{ id: 'p1', background: 'grid' }], activePageId: 'p1', ownerUid: state.uid, sheetMode: 'continuous', sharedWithUids: [],
    createdAt: firebase.firestore.FieldValue.serverTimestamp(), updatedAt: firebase.firestore.FieldValue.serverTimestamp() });
}
async function mountLive() {
  const doc = state.doc; if (!doc) return;
  state.mode = 'live';
  const mount = $('nbb-mount');
  mount.innerHTML = window.Whiteboard.boardShellHTML({ classId: state.uid, ids: false, back: false, zoomControls: false, maximize: false, topbar: false });
  try { await ensureBoardDoc(doc); } catch (e) { console.warn('[notebook] board create', e); }
  if (state.doc !== doc) return;
  state.inst = await window.Whiteboard.mountBoardView(mount.querySelector('.wb-page'), {
    classId: state.uid, boardId: doc.boardId, collection: COLL, ownerUid: state.uid, boardName: boardTitle(),
    chrome: 'full', view: { enabled: true }, items: { enabled: true }, pills: true, theme: THEME,
    mobile: mobileOption(),   /* V3.852 — inert cards + the tap-to-edit sheet on a phone (?mobile=1|0 forces it) */
    report: { onReport: (it, btn) => reportToMyWeek(it, btn) },   /* V3.854 — ✓ at a card's top-left */
    tools: toolsList(),
    onTool: (act, btn) => {
      if (act === 'paper') togglePicker();
      else if (act === 'recs') toggleSide();
      else if (act === 'max') setFull(!state.full);
      else if (act === 'insert-more') openInsert({ anchor: btn });
    },
    inserts: insertList(),
    onInsert: (kind) => insertKind(kind),
    onSheetContext: (p) => openInsert({ point: { x: p.clientX, y: p.clientY }, at: p }),
    /* V3.841 — workflow wires between cards (ports on every card), files dropped on the sheet */
    wires: { enabled: true },
    onWire: (id, w, e) => wireMenu(id, w, e),
    onConnectDone: () => toast('success', 'Connected. Tap the line to say what the step is.'),
    /* V3.856 — a wire that lands on a 📑 Collection / Claim materialises its entry (and claim evidence) */
    onWireAdded: (id, w) => window.CANVAS_PAPER_READER && window.CANVAS_PAPER_READER.onWireAdded(id, w),
    onWireUpdated: (id, w, before) => window.CANVAS_PAPER_READER && window.CANVAS_PAPER_READER.onWireUpdated(id, w, before),
    onWireRemoved: (id, w) => window.CANVAS_PAPER_READER && window.CANVAS_PAPER_READER.onWireRemoved(id, w),
    onDrop: (files, at) => dropFiles(files, at),
    onPaste: (p) => pasteContent(p),
    widgets: { render: renderWidget, renderSheet: renderWidgetSheet, menuItems: widgetMenuItems, meta: (k) => CANVAS_WIDGETS.meta(k), summary: (it) => CANVAS_WIDGETS.summary(it), onMenu: openWidgetMenu, onChange: onItemsChanged }
  });
  if (!state.inst) { mount.innerHTML = '<div class="nbk-empty">Could not open this entry\'s board.</div>'; return; }
  renderSide();
  /* migration, step 2: blocks → widgets, once, after the items arrive */
  if (!doc.canvas_version) setTimeout(() => migrateIfNeeded(doc), 900);
}

/* ─── recordings: a slide-over list, opened from the Tools pill ─── */
function recCol() { return window.Whiteboard.boardsCol(state.uid, COLL).doc(state.doc.boardId).collection('recordings'); }
function watchRecordings() {
  if (state.recUnsub) { try { state.recUnsub(); } catch (e) {} }
  if (!state.doc) return;
  state.recUnsub = recCol().orderBy('startedAtMs', 'desc').onSnapshot(snap => {
    state.recs = snap.docs.map(d => ({ id: d.id, ...d.data() }));
    repairInterrupted(); renderSide();
    if (state.inst && state.mode === 'live') state.inst.setTools(toolsList());
  }, err => console.warn('[notebook] recordings listener', err));
}
function repairInterrupted() {
  if (!state.inst) return;
  let mine = null; try { mine = sessionStorage.getItem('wb_client'); } catch (e) {}
  const recordingNow = state.inst.isRecording?.();
  state.recs.forEach(r => {
    if (r.status !== 'recording' || state.repaired.has(r.id)) return;
    const own = recordingNow && r.recorderClientId === mine;
    const stale = (Date.now() - (r.startedAtMs || 0)) > 3 * 60 * 1000;
    if (own || !stale) return;
    state.repaired.add(r.id);
    state.inst.finalizeInterrupted(r.id).catch(e => console.warn('[notebook] repair failed', e));
  });
}
function toggleSide() { state.sideOpen = !state.sideOpen; renderSide(); if (state.inst) state.inst.setTools(toolsList()); }
function closeSide() { if (!state.sideOpen) return; state.sideOpen = false; renderSide(); }
function renderSide() {
  const box = $('nbc-side'); if (!box) return;
  if (!state.sideOpen || state.mode === 'replay') { box.hidden = true; box.innerHTML = ''; return; }
  box.hidden = false;
  box.innerHTML = `<div class="nbc-side-head"><span>Recordings</span><button type="button" class="nbc-ib" data-side="close" title="Close">✕</button></div>
    <div class="nbc-side-hint">${ICON.svg('microphone')} in the Tools pill records your voice with the ink. ${ICON.svg('play')} replays the ink, the cards and the voice together.</div>` +
    (state.recs.length ? state.recs.map(r => {
      const live = r.status === 'recording'; const dur = live ? '' : fmtDur(r.durationMs);
      return `<div class="nbb-rec">${live ? '<span class="nbb-rec-live"><span class="wb-live-dot"></span> recording now</span>' : `<button type="button" class="btn btn-small" data-nbb-play="${esc(r.id)}" title="Replay">${ICON.svg('play')}</button>`}
        <span class="nbb-rec-name">${esc(r.name || 'Recording')}${r.endReason === 'interrupted' ? ' <span class="nbb-rec-int">· interrupted</span>' : ''}</span>
        <span class="nbb-rec-meta">${esc(fmtDate(r.startedAtMs))}${dur ? ' · ' + dur : ''}</span></div>`;
    }).join('') : '<div class="nbk-pick-empty">No recordings on this entry yet.</div>');
  if (!box.dataset.wired) { box.dataset.wired = '1'; box.addEventListener('click', (e) => { const b = e.target.closest('[data-nbb-play]'); if (b) openReplay(b.dataset.nbbPlay); if (e.target.closest('[data-side="close"]')) toggleSide(); }); }
}
async function openReplay(recId) {
  if (!state.inst || !state.doc) return;
  if (state.inst.isRecording?.()) { toast('info', 'Stop the recording first.'); return; }
  if (!window.WhiteboardReplay?.mount) { toast('error', 'Replay is not available (whiteboard-replay.js did not load).'); return; }
  closePicker(); closeSide(); unmountRuns();
  try { state.inst.destroy(); } catch (e) {}
  state.inst = null; state.mode = 'replay';
  const mount = $('nbb-mount');
  mount.innerHTML = window.Whiteboard.boardShellHTML({ classId: state.uid, ids: false, back: false, zoomControls: false, maximize: false, topbar: false });
  const inst = await window.Whiteboard.mountBoardView(mount.querySelector('.wb-page'), {
    classId: state.uid, boardId: state.doc.boardId, collection: COLL, ownerUid: state.uid, boardName: boardTitle(),
    chrome: 'full', replay: recId, view: { enabled: false }, items: { enabled: true }, theme: THEME,
    widgets: { render: renderWidget, meta: (k) => CANVAS_WIDGETS.meta(k), summary: (it) => CANVAS_WIDGETS.summary(it) }
  });
  if (!inst) { toast('error', 'Could not open the replay.'); await mountLive(); return; }
  state.inst = inst;
  window.WhiteboardReplay.mount({ classId: state.uid, boardId: state.doc.boardId, recId, handle: inst, coll: COLL, isAdmin: true, noHash: true, onExit: () => backToLive(), onDeleted: () => backToLive() });
}
async function backToLive() {
  try { window.WhiteboardReplay?.teardown?.(); } catch (e) {}
  try { state.inst?.destroy(); } catch (e) {}
  state.inst = null;
  await mountLive();
}

/* ================================================================
   ＋ Insert — the registry, the picker, the ⋯ menu, the migration
   ================================================================ */
function openInsert({ anchor, point, at }) {
  if (!state.inst || !state.doc) { toast('info', 'Open an entry first.'); return; }
  if (!state.inst.isAdmin()) { toast('info', 'Only the entry\'s owner can add to it.'); return; }
  CANVAS_WIDGETS.insertMenu({ anchor, point, ctx: { doc: state.doc }, title: 'Insert into this entry', onPick: async (def) => {
    if (def.insertOnly) { try { def.run({ doc: state.doc, at }); } catch (e) { console.warn(e); } return; }
    let spec = null;
    try { spec = def.make ? def.make({ doc: state.doc }) : { title: '', data: {} }; } catch (e) { console.warn(e); }
    if (!spec) return;
    const id = await state.inst.addWidget(Object.assign({ kind: def.kind, w: def.w }, spec, at ? { pageId: at.pageId, x: at.x, y: at.y } : {}));
    if (id && def.focusAfter) setTimeout(() => { const n = document.querySelector(`.wb-item-widget[data-item-id="${CSS.escape(id)}"] ${def.focusAfter}`); CANVAS_WIDGETS.autoFocus(n); }, 350);
  } });
}
/* V3.852 — one list for the desktop ⋯ popover AND the phone sheet (engine widgets.menuItems) */
/* ─── V3.854 — ✓ report this card (or region) as the result of a My Week step ───
   The card becomes outcome.links[] on the step (the V3.853 writer, so the step is
   marked done and the ledger shows the link); the card then carries myweek[] so
   its ✓ fills and names the step. */
function reportToMyWeek(it, btn) {
  if (!window.MYWEEK_REPORT) { toast('error', 'My Week reporting is not loaded on this page.'); return; }
  if (!state.doc || !it || !it.id) return;
  const d = MYWEEK_REPORT.describeCard(it);
  const card = {
    kind: 'notebook_item', boardId: state.doc.boardId, itemId: it.id, entryId: state.doc.id, paperId: '',
    boardTitle: state.doc.title || 'Notebook entry', item_kind: d.item_kind, title: d.title, thumb: d.thumb,
    url: '/rm/pages/notebook.html?entry=' + encodeURIComponent(state.doc.id) + '&item=' + encodeURIComponent(it.id),
  };
  MYWEEK_REPORT.open({ anchor: btn || null, point: btn ? null : { x: Math.max(8, innerWidth / 2 - 150), y: Math.max(8, innerHeight / 3) }, card, onReported: (step) => markReported(it.id, step) });
}
function markReported(id, step) {
  const cur = state.inst ? state.inst.getItems().find(x => x.id === id) : null; if (!cur) return null;
  const refs = (Array.isArray(cur.myweek) ? cur.myweek : []).filter(r => r && r.itemId !== step.id)
    .concat([{ itemId: step.id, title: String(step.title || '').slice(0, 200), date: step.date || '' }]);
  return state.inst.updateItem(id, { myweek: refs });
}
function widgetMenuItems(item, api) {
  const def = CANVAS_WIDGETS.get(item.kind);
  return [
    ...(api.inSheet ? [] : [{ label: 'Card settings…', sub: 'Name, colour, width, connections', run: () => api.openSettings && api.openSettings() }]),   /* V3.852 */
    { label: 'Report as a My Week result…', sub: 'Point one of your steps at this card', run: () => reportToMyWeek(item, null) },   /* V3.854 */
    { label: item.collapsed ? 'Expand' : 'Collapse', run: () => api.collapse(!item.collapsed) },
    { label: 'Bring to front', run: () => api.save({ z: Date.now() }) },
    ...((def && def.menu) ? (def.menu(item, api, { doc: state.doc }) || []) : []),
    (def && def.duplicate !== false && def.make) ? { label: 'Duplicate', run: () => state.inst.addWidget({ kind: item.kind, title: item.title, data: JSON.parse(JSON.stringify(item.data || {})), text: item.text || '', w: item.w, pageId: item.pageId, x: (item.x || 0) + 0.03, y: (item.y || 0) + 0.03 }) } : null,
    { label: 'Remove', sub: (window.CANVAS_PAPER_READER && CANVAS_PAPER_READER.COLL_KINDS.has(item.kind)) ? 'Figure boards that show it lose it; its papers stay linked to your drafts' : 'Take this card off the entry', danger: true, confirm: 'Really remove?', run: () => { unmountRun(item.id); if (state.protoLive === item.id) state.protoLive = null; if (window.CANVAS_PAPER_READER) CANVAS_PAPER_READER.onRemoveItem(item); api.remove(); } }
  ];
}
function openWidgetMenu(item, btn, api) {
  const def = CANVAS_WIDGETS.get(item.kind);
  CANVAS_WIDGETS.actionMenu({ anchor: btn, items: widgetMenuItems(item, api), title: (def ? def.label : item.kind) });
}
/* V3.852 — the phone sheet's body: a kind's own `sheet()` when it has one (the HTML frame), else its editor */
function renderWidgetSheet(item, body, api) {
  const def = CANVAS_WIDGETS.get(item.kind);
  if (def && def.sheet) { try { def.sheet(item, body, api); } catch (e) { console.warn('[notebook] widget sheet', item.kind, e); body.textContent = 'This card could not be opened.'; } return; }
  renderWidget(item, body, api);
}
/* V3.852 — read once at load: the page rewrites its own query string later (?entry=…), which would drop ?mobile= */
const MOBILE_OPT = (() => { try { const v = new URLSearchParams(location.search).get('mobile'); return v === '1' ? true : v === '0' ? false : 'auto'; } catch (e) { return 'auto'; } })();
function mobileOption() { return MOBILE_OPT; }
function renderWidget(item, body, api) {
  const def = CANVAS_WIDGETS.get(item.kind);
  if (!def || !def.render) { body.textContent = CANVAS_WIDGETS.summary(item) || '(unknown card)'; return; }
  try { def.render(item, body, api); } catch (e) { console.warn('[notebook] widget render', item.kind, e); body.textContent = 'This card could not be rendered.'; }
}
/* V3.830 blocks (or a classic body) → widgets on the board, once */
async function migrateIfNeeded(doc) {
  if (!state.inst || state.doc !== doc || doc.canvas_version) return;
  const existing = state.inst.getItems();
  if (existing.some(i => i.type === 'widget')) { doc.canvas_version = 3; scheduleSave(); return; }
  let blocks = Array.isArray(doc.blocks) ? doc.blocks.slice() : null;
  if (!blocks) {
    blocks = [];
    const p = doc.plan;
    if (p && typeof notebookPlanHasContent === 'function' && notebookPlanHasContent(p)) {
      const li = (lab, v) => v ? `<p><strong>${esc(lab)}:</strong> ${esc(Array.isArray(v) ? v.join(', ') : v)}</p>` : '';
      blocks.push({ type: 'note', title: 'Plan', data: { html: li('Hypothesis', p.hypothesis) + li('Independent variables', p.independent_vars) + li('Dependent variables', p.dependent_vars) + li('Controls', p.controls) + li('Success criteria', p.success_criteria) } });
    }
    if (String(doc.body_html || '').trim()) blocks.push({ type: 'note', title: '', data: { html: sanitizeHtml(doc.body_html) } });
    if (doc.protocol_run && doc.protocol_run.protocol_id) blocks.push({ type: 'protocol', title: doc.protocol_run.protocol_title || '', data: { run: doc.protocol_run } });
    if (Array.isArray(doc.observations) && doc.observations.length) {
      const rows = doc.observations.map(o => `<tr><td>${esc(String(o.at || '').slice(0, 16).replace('T', ' '))}</td><td>${esc(o.text || '')}</td><td>${esc([o.metric, o.value, o.unit].filter(x => x !== null && x !== undefined && x !== '').join(' '))}</td></tr>`).join('');
      blocks.push({ type: 'note', title: 'Observations', data: { html: `<table><thead><tr><th>When</th><th>Observation</th><th>Measure</th></tr></thead><tbody>${rows}</tbody></table>` } });
    }
  }
  const pageId = state.inst.getPage() || 'p1';
  let y = 0.04; const x = 0.05;
  const est = { note: 0.2, calc: 0.26, protocol: 0.3, figure: 0.3, checklist: 0.14, whiteboard: 0.08 };
  for (const b of blocks) {
    if (!b || !b.type) continue;
    if (b.type === 'whiteboard' && (b._adopted || (b.data && b.data.boardId === doc.boardId))) continue;
    let kind = b.type, data = b.data || {}, w = 0.6;
    if (b.type === 'whiteboard') { kind = 'boardlink'; data = { boardId: data.boardId || '' }; w = 0.42; }
    if (b.type === 'figure') { data = { cells: [{ url: data.url || '', storagePath: data.storage_path || '', hash: data.hash || '', caption: data.caption || '' }] }; }
    const id = await state.inst.addWidget({ kind, title: b.title || '', data, w, pageId, x, y, collapsed: !!b.collapsed, avoidOverlap: false,
      text: kind === 'note' ? plainText(data.html) : '' });
    if (!id) break;
    y += (est[b.type] || 0.2);
    if (y > 0.9) y = 0.04;
  }
  doc.canvas_version = 3;
  scheduleSave();
  toast('success', blocks.length ? 'This entry moved onto the canvas — its blocks are cards now. ⇣ Tidy stacks them.' : 'This entry is a canvas now.');
}

/* ================================================================
   widget kinds
   ================================================================ */
function registerKinds() {
  const R = CANVAS_WIDGETS.register;
  R({ kind: 'note', label: 'Typed note', icon: 'pencil', group: 'Writing', sub: 'Rich text; paste a photo to add it', w: 0.46, focusAfter: '.nbk-note',
    make: () => ({ title: '', data: { html: '' } }), render: renderNote,
    summary: (it) => plainText(it.data?.html).slice(0, 140), text: (it) => plainText(it.data?.html) });
  R({ kind: 'checklist', label: 'Checklist', icon: 'check-circle', group: 'Writing', sub: 'Tick boxes', w: 0.36,
    make: () => ({ title: '', data: { items: [{ text: '', done: false }] } }), render: renderChecklist,
    summary: (it) => { const a = it.data?.items || []; return `${a.filter(i => i.done).length}/${a.length} done`; }, text: (it) => (it.data?.items || []).map(i => (i.done ? '[x] ' : '[ ] ') + i.text).join('\n') });
  R({ kind: 'calc', label: 'Calculator', icon: 'calculator', group: 'Tools', sub: 'A formula with inputs, or one copied from a protocol', w: 0.46,
    make: () => ({ title: 'Calculation', data: { spec: newFormulaSpec(), inputs: {}, context: [], result: '' } }), render: renderCalc,
    summary: (it) => `${it.data?.spec?.attrs?.label || 'Calculator'}${it.data?.result ? ': ' + it.data.result : ''}`, text: (it) => `${it.data?.spec?.attrs?.label || 'Calculator'} ${it.data?.spec?.attrs?.expression || ''} ${it.data?.result || ''}` });
  R({ kind: 'protocol', label: 'Protocol followed', icon: 'clipboard-document-list', group: 'Lab', sub: 'The live protocol document with your values; Finalize locks it', w: 0.62, duplicate: false,
    make: () => ({ title: '', data: { run: null } }), render: renderProtocol,
    menu: (it, api) => it.data?.run ? [{ label: 'Unload the protocol', sub: 'Removes it and its values (two taps)', danger: true, confirm: 'Really unload?', then: 'content', run: () => { unmountRun(it.id); if (state.protoLive === it.id) state.protoLive = null; api.saveData({ run: null }, ''); api.refresh(); } }] : [],
    summary: (it) => { const r = it.data?.run; return r ? `${r.protocol_title || r.protocol_id}${r.frozen ? ' · finalized' : ' · live'}` : 'no protocol loaded'; }, text: (it) => { const r = it.data?.run; return r ? `Protocol followed: ${r.protocol_title || r.protocol_id}` : ''; } });
  R({ kind: 'inventory', label: 'Inventory item', icon: 'cube', group: 'Lab', sub: 'A reagent, chemical or part from the lab inventory; log what you used', w: 0.4, duplicate: false,
    make: () => ({ title: '', data: { itemId: '', kind: '', name: '', location: '', catalog: '', usage: [] } }), render: renderInventory,
    menu: (it, api) => it.data?.itemId ? [{ label: 'Change the item…', then: 'content', run: () => { api.saveData(Object.assign({}, it.data, { itemId: '', name: '', location: '', catalog: '', kind: '' }), ''); api.refresh(); } }] : [],
    summary: (it) => { const d = it.data || {}; return d.name ? `${d.name}${d.location ? ' · ' + d.location : ''}${(d.usage || []).length ? ' · used ' + (d.usage || []).map(u => `${u.qty} ${u.unit || ''}`.trim()).join(', ') : ''}` : 'no item chosen'; }, text: (it) => { const d = it.data || {}; return d.name ? `Inventory: ${d.name} ${d.catalog || ''} ${(d.usage || []).map(u => `used ${u.qty} ${u.unit || ''}`).join(' ')}` : ''; } });
  /* V3.844 — something I did: an action recorded for me (an item I used, equipment I booked), picked from my list */
  R({ kind: 'action', label: 'Something I did', icon: 'bolt', group: 'Lab', sub: 'An action recorded for you — an item you used, equipment you booked — picked from your list', w: 0.42, duplicate: false,
    make: () => ({ title: '', data: { actionId: '', kind: '', text: '', at: '', note: '', itemId: '', equipmentId: '', labelCode: '' } }), render: renderAction,
    menu: (it, api) => it.data?.actionId ? [{ label: 'Pick a different action…', then: 'content', run: () => { api.saveData({ actionId: '', kind: '', text: '', at: '', note: '', itemId: '', equipmentId: '', labelCode: '' }, ''); api.refresh(); } }] : [],
    summary: (it) => it.data?.text || 'no action picked', text: (it) => `${it.data?.text || ''} ${it.data?.note || ''}` });
  R({ kind: 'figure', label: 'Figure / photo', icon: 'photo', group: 'Media', sub: 'Upload, camera, or drop an image; a caption underneath', w: 0.42,
    make: () => ({ title: '', data: { cells: [{ url: '', storagePath: '', hash: '', caption: '' }] } }), render: renderFigure,
    menu: (it, api) => (it.data?.cells || [])[0]?.url ? [{ label: 'Replace the image…', then: 'content', run: () => { state.photoTarget = { itemId: it.id, mode: 'figure' }; $('nbk-file-input').click(); } }] : [],
    summary: (it) => { const c = (it.data?.cells || [])[0] || {}; return c.url ? (c.caption || 'image') : 'no image yet'; }, text: (it) => ((it.data?.cells || [])[0] || {}).caption || '' });
  /* V3.859 — 'paperquote' and 'litreview' are registered by CANVAS_PAPER_READER: one 📑 Collection renders them and adopts them on their first edit */
  R({ kind: 'boardlink', label: 'Linked board', icon: 'pen-line', group: 'Media', sub: 'A whiteboard from the block notebook', when: () => false, duplicate: false,
    make: () => null, render: renderBoardLink, summary: () => 'whiteboard (opens in its own view)', text: () => '' });
  /* V3.856 — 📖 Paper (read, highlight, snip; nodes → connections) and 📑 Collection / claim, shared with the figure board */
  if (window.CANVAS_PAPER_READER) window.CANVAS_PAPER_READER.registerKinds({ hostKind: 'notebook', group: 'Reading', getInst: () => state.inst, toast, draftId: null,
    mirror: () => (state.doc && state.uid) ? { uid: state.uid, boardId: state.doc.boardId, entryId: state.doc.id } : null });   /* V3.859 — every collection is listed for figure boards */
  R({ kind: 'paper', label: 'From a paper in the library…', icon: 'document-text', group: 'Media', sub: 'A figure or a passage from a PDF, its snipped figures, or your highlights', insertOnly: true, run: () => togglePicker(true) });
  /* V3.841 — an .html file (a simulation, an interactive figure) in its own sandboxed frame */
  CANVAS_WIDGETS.basic.registerHtmlFrame({ group: 'Media', upload: (f) => CANVAS_WIDGETS.basic.uploadCanvasFile(f, state.uid), toast });
}
/* ─── V3.841 files dropped on the sheet: images → Figure cards, .html → frames ─── */
async function dropFiles(files, at) {
  if (!state.inst || !files || !files.length) return;
  const B = CANVAS_WIDGETS.basic;
  const list = files.slice(0, 8); let k = 0, skipped = 0;
  for (const f of list) {
    const pos = at ? { pageId: at.pageId, x: at.x, y: at.y + k * 0.05 } : {};
    if (B.isHtmlFile(f)) {
      if (f.size > B.CANVAS_FILE_MAX) { toast('error', `${f.name} is ${B.fmtBytes(f.size)} — the limit is 25 MB.`); continue; }
      const def = CANVAS_WIDGETS.get('html');
      const id = await state.inst.addWidget(Object.assign({ kind: 'html', w: def.w, title: '', data: { url: '', storagePath: '', name: '', size: 0, ar: 1.6 } }, pos));
      if (!id) continue;
      const it = state.inst.getItems().find(x => x.id === id);
      if (it) await def.setFile(it, f, state.inst.api(id));
      k++;
    } else if (B.isImageFile(f)) {
      const id = await state.inst.addWidget(Object.assign({ kind: 'figure', w: 0.42, title: '', data: { cells: [{ url: '', storagePath: '', hash: '', caption: '' }] } }, pos));
      if (!id) continue;
      const it = state.inst.getItems().find(x => x.id === id);
      if (it) await setFigure(it, f);
      k++;
    } else skipped++;
  }
  if (skipped) toast('info', skipped === 1 ? 'Only images and .html files can be dropped on the canvas.' : `${skipped} files skipped — only images and .html files can be dropped on the canvas.`);
}
/* ─── V3.841 paste from the clipboard: images → Figure cards, text → a note card ─── */
function textToHtml(text) {
  return String(text || '').replace(/\r\n?/g, '\n').trim().split(/\n{2,}/).map(par => `<p>${esc(par).replace(/\n/g, '<br>')}</p>`).join('');
}
async function pasteContent(p) {
  if (!state.inst || !p) return;
  if (p.files && p.files.length) { await dropFiles(p.files, p.at); return; }
  const B = CANVAS_WIDGETS.basic;
  let html = p.html ? B.sanitizeHtml(p.html) : '';
  if (!B.plainText(html)) html = textToHtml(p.text);
  if (!B.plainText(html)) return;
  const id = await state.inst.addWidget(Object.assign({ kind: 'note', w: 0.46, title: '', data: { html }, text: B.plainText(html).slice(0, 4000) }, p.at ? { pageId: p.at.pageId, x: p.at.x, y: p.at.y } : {}));
  if (id) toast('success', 'Pasted as a note card — drag it by its header.');
}
/* ─── V3.841 a wire's menu: what the step is ─── */
const WIRE_RELS = ['then', 'feeds', 'uses', 'result', 'compare', 'related'];
function wireMenu(id, w, e) {
  if (!state.inst) return;
  /* V3.856 — a wire from a paper card's node carries a reader TYPE (supports · refutes · informs …) */
  if (w && w.fromNode && window.CANVAS_PAPER_READER) { window.CANVAS_PAPER_READER.wireMenu(id, w, e); return; }
  CANVAS_WIDGETS.actionMenu({ point: { x: e.clientX, y: e.clientY }, title: w && w.rel ? w.rel : 'Connection', items: [
    ...WIRE_RELS.map(r => ({ label: (w && w.rel === r ? '✓ ' : '') + r, run: () => state.inst.updateWire(id, { rel: r }) })),
    { label: 'Reverse', run: () => state.inst.updateWire(id, { from: w.to, to: w.from, fromSide: w.toSide || firebase.firestore.FieldValue.delete(), toSide: w.fromSide || firebase.firestore.FieldValue.delete() }) },
    { label: 'Remove the connection', danger: true, confirm: 'Really remove?', run: () => state.inst.removeWire(id) }
  ] });
}
function newFormulaSpec() {
  return { id: newId('blk-'), kind: 'formula', status: 'draft', body: '',
    attrs: { label: 'Calculation', description: '', expression: 'm / v',
      variables: [{ name: 'm', label: 'Mass', default: 1, unit: 'g' }, { name: 'v', label: 'Volume', default: 10, unit: 'mL' }],
      output: { name: 'c', label: 'Concentration', unit: 'g/mL', decimals: 3 } } };
}

/* ── note ── */
function renderNote(it, body, api) {
  const d = it.data || (it.data = {});
  const ro = !api.canEdit();
  body.innerHTML = `${ro ? '' : `<div class="nbk-fmtbar">
      <button type="button" class="nbk-fmt" data-cmd="bold" title="Bold"><b>B</b></button>
      <button type="button" class="nbk-fmt" data-cmd="italic" title="Italic"><i>I</i></button>
      <button type="button" class="nbk-fmt" data-cmd="underline" title="Underline"><u>U</u></button>
      <button type="button" class="nbk-fmt" data-cmd="insertUnorderedList" title="Bulleted list">• list</button>
      <button type="button" class="nbk-fmt" data-cmd="insertOrderedList" title="Numbered list">1. list</button>
      <button type="button" class="nbk-fmt" data-block="h3" title="Heading">H</button>
      <button type="button" class="nbk-fmt" data-block="blockquote" title="Quote">❝</button>
      <button type="button" class="nbk-fmt" data-block="pre" title="Code / data">&lt;/&gt;</button>
      <button type="button" class="nbk-fmt" data-cmd="removeFormat" title="Clear formatting">⌫</button>
      <button type="button" class="nbk-fmt" data-photo="1" title="Insert a photo">${ICON.svg('camera')}</button>
      <button type="button" class="nbk-fmt" data-lit="1" title="Start a lit review for the selected words">${ICON.svg('books')}</button>
    </div>`}
    <div class="nbk-note${ro ? ' nbk-note-ro' : ''}" ${ro ? '' : 'contenteditable="true"'} data-placeholder="Type your notes… paste a photo to add it.">${d.html || ''}</div>`;
  const ed = body.querySelector('.nbk-note');
  if (ro) return;
  let t = null;
  const commit = () => { d.html = sanitizeHtml(ed.innerHTML); api.saveData(d, plainText(d.html)); };
  ed.addEventListener('input', () => { clearTimeout(t); t = setTimeout(commit, 400); });
  ed.addEventListener('blur', () => { clearTimeout(t); commit(); });
  ed.addEventListener('paste', (e) => onNotePaste(e, it, ed, api));
  ed.addEventListener('drop', (e) => { const f = e.dataTransfer?.files?.[0]; if (f && /^image\//.test(f.type)) { e.preventDefault(); insertPhoto(it, ed, f, api); } });
  const bar = body.querySelector('.nbk-fmtbar');
  bar.addEventListener('mousedown', (e) => e.preventDefault());
  bar.addEventListener('click', (e) => {
    const btn = e.target.closest('button'); if (!btn) return;
    ed.focus();
    if (btn.dataset.cmd) document.execCommand(btn.dataset.cmd, false, null);
    else if (btn.dataset.block) { const cur = document.queryCommandValue('formatBlock'); document.execCommand('formatBlock', false, cur.toLowerCase() === btn.dataset.block ? 'p' : btn.dataset.block); }
    else if (btn.dataset.photo) { state.photoTarget = { itemId: it.id, mode: 'note', ed, api, it }; $('nbk-file-input').click(); }
    else if (btn.dataset.lit) { const sel = String(window.getSelection && window.getSelection().toString() || '').trim().slice(0, 80); if (!sel) { toast('info', 'Select the word or phrase first, then press the lit review button.'); return; }
      if (window.CANVAS_PAPER_READER) CANVAS_PAPER_READER.addLitReview({ title: 'Lit review: ' + sel, query: sel }, { pageId: it.pageId, x: Math.min(0.5, (it.x || 0) + 0.02), y: (it.y || 0) + 0.12 }); toast('success', `A lit review for “${sel}” — pick papers from the library in it.`); }   /* V3.859 — a collection */
    clearTimeout(t); t = setTimeout(commit, 50);
  });
}
async function onNotePaste(e, it, ed, api) {
  const items = e.clipboardData?.items || [];
  for (const x of items) { if (x.kind === 'file' && /^image\//.test(x.type)) { e.preventDefault(); const f = x.getAsFile(); if (f) await insertPhoto(it, ed, f, api); return; } }
  const text = e.clipboardData?.getData('text/plain');
  if (text) { e.preventDefault(); document.execCommand('insertText', false, text); }
}
async function insertPhoto(it, ed, file, api) {
  if (!window.NOTEBOOK_FIGURES) { toast('error', 'Uploads are not available on this page.'); return; }
  toast('info', 'Uploading photo…');
  try {
    const up = await window.NOTEBOOK_FIGURES.uploadImage(file);
    const img = `<img src="${esc(up.download_url)}" data-storage-path="${esc(up.storage_path)}" data-hash="${esc(up.hash)}" alt="">`;
    ed.focus();
    if (!document.execCommand('insertHTML', false, img + '<p></p>')) ed.insertAdjacentHTML('beforeend', img);
    recordAttachment(up);
    it.data.html = sanitizeHtml(ed.innerHTML); api.saveData(it.data, plainText(it.data.html));
  } catch (e) { toast('error', 'Upload failed: ' + (e.message || e)); }
}
function recordAttachment(up) {
  if (!state.doc) return;
  if (!Array.isArray(state.doc.attachments)) state.doc.attachments = [];
  state.doc.attachments.push({ kind: 'image', storage_path: up.storage_path, hash: up.hash, mime: up.mime, size_bytes: up.size_bytes, caption: '', uploaded_at: up.uploaded_at, uploaded_by: up.uploaded_by });
  scheduleSave();
}
function wireUploads() {
  const onFile = async (f) => {
    const tgt = state.photoTarget; state.photoTarget = null;
    if (!f || !tgt || !state.inst) return;
    const cur = state.inst.getItems().find(x => x.id === tgt.itemId);
    if (!cur) return;
    if (tgt.mode === 'note' && tgt.ed && tgt.ed.isConnected) { await insertPhoto(tgt.it, tgt.ed, f, tgt.api); return; }
    if (tgt.mode === 'figure') await setFigure(cur, f);
  };
  $('nbk-file-input').addEventListener('change', async (e) => { const f = e.target.files && e.target.files[0]; e.target.value = ''; await onFile(f); });
  $('nbk-camera-input').addEventListener('change', async (e) => { const f = e.target.files && e.target.files[0]; e.target.value = ''; await onFile(f); });
}

/* ── figure ── */
function renderFigure(it, body, api) {
  const d = it.data || (it.data = {}); if (!Array.isArray(d.cells) || !d.cells.length) d.cells = [{ url: '', storagePath: '', hash: '', caption: '' }];
  const c = d.cells[0]; const ro = !api.canEdit();
  if (!c.url) {
    if (ro) { body.innerHTML = '<div class="nbk-pick-empty">No image.</div>'; return; }
    body.innerHTML = `<div class="nbk-fig-drop" data-drop>Drop an image here, or
      <button type="button" class="btn btn-small" data-pick="file">${ICON.svg('folder')} Choose</button>
      <button type="button" class="btn btn-small" data-pick="camera">${ICON.svg('camera')} Camera</button></div>`;
    const drop = body.querySelector('[data-drop]');
    drop.addEventListener('click', (e) => { const p = e.target.closest('[data-pick]'); if (!p) return; state.photoTarget = { itemId: it.id, mode: 'figure' }; $(p.dataset.pick === 'camera' ? 'nbk-camera-input' : 'nbk-file-input').click(); });
    drop.addEventListener('dragover', (e) => { e.preventDefault(); drop.classList.add('nbk-over'); });
    drop.addEventListener('dragleave', () => drop.classList.remove('nbk-over'));
    drop.addEventListener('drop', (e) => { e.preventDefault(); drop.classList.remove('nbk-over'); const f = e.dataTransfer?.files?.[0]; if (f) setFigure(it, f); });
    return;
  }
  body.innerHTML = `<div class="nbk-fig"><a href="${esc(c.url)}" target="_blank" rel="noopener"><img src="${esc(c.url)}" alt="${esc(c.caption || '')}" draggable="false"></a>
    ${ro ? (c.caption ? `<div class="nbk-fig-cap-ro">${esc(c.caption)}</div>` : '') : `<input type="text" class="nbk-fig-cap" value="${esc(c.caption || '')}" placeholder="Caption…">`}${readerLink(d)}</div>`;
  const cap = body.querySelector('.nbk-fig-cap');
  if (cap) { let t = null; cap.addEventListener('input', () => { c.caption = cap.value; clearTimeout(t); t = setTimeout(() => api.saveData(d, c.caption), 400); }); cap.addEventListener('blur', () => { clearTimeout(t); api.saveData(d, c.caption); }); }
}
async function setFigure(it, file) {
  if (!window.NOTEBOOK_FIGURES || !state.inst) { toast('error', 'Uploads are not available on this page.'); return; }
  toast('info', 'Uploading…');
  try {
    const up = await window.NOTEBOOK_FIGURES.uploadImage(file);
    const cur = state.inst.getItems().find(x => x.id === it.id) || it;
    const d = Object.assign({}, cur.data || {}); d.cells = [{ url: up.download_url, storagePath: up.storage_path, hash: up.hash, caption: ((d.cells || [])[0] || {}).caption || '' }];
    recordAttachment(up);
    await state.inst.updateItem(it.id, { data: d, text: d.cells[0].caption || '' });
    state.inst.refreshWidget(it.id);
  } catch (e) { toast('error', 'Upload failed: ' + (e.message || e)); }
}

/* ── checklist ── */
function renderChecklist(it, body, api) {
  const d = it.data || (it.data = {}); const items = d.items = Array.isArray(d.items) ? d.items : [];
  const ro = !api.canEdit();
  const row = (x, k) => `<div class="nbk-ck-row${x.done ? ' nbk-done' : ''}" data-k="${k}">
      <input type="checkbox" ${x.done ? 'checked' : ''} ${ro ? 'disabled' : ''}><input type="text" value="${esc(x.text || '')}" placeholder="To do…" ${ro ? 'readonly' : ''}>${ro ? '' : '<button type="button" class="nbk-x" title="Remove">×</button>'}</div>`;
  body.innerHTML = `<div class="nbk-ck">${items.map(row).join('')}</div>${ro ? '' : '<button type="button" class="btn btn-small" data-ck-add style="margin-top:6px">＋ item</button>'}`;
  if (ro) return;
  const save = () => api.saveData(d, items.map(i => (i.done ? '[x] ' : '[ ] ') + i.text).join('\n'));
  const list = body.querySelector('.nbk-ck');
  list.addEventListener('change', (e) => { const r = e.target.closest('.nbk-ck-row'); if (!r) return; const x = items[+r.dataset.k]; if (!x) return; if (e.target.type === 'checkbox') { x.done = e.target.checked; r.classList.toggle('nbk-done', x.done); } save(); });
  let t = null;
  list.addEventListener('input', (e) => { const r = e.target.closest('.nbk-ck-row'); if (!r || e.target.type !== 'text') return; const x = items[+r.dataset.k]; if (x) { x.text = e.target.value; clearTimeout(t); t = setTimeout(save, 400); } });
  list.addEventListener('keydown', (e) => { if (e.key === 'Enter' && e.target.type === 'text') { e.preventDefault(); const r = e.target.closest('.nbk-ck-row'); items.splice(+r.dataset.k + 1, 0, { text: '', done: false }); save(); renderChecklist(it, body, api); body.querySelectorAll('.nbk-ck-row input[type=text]')[+r.dataset.k + 1]?.focus(); } });
  list.addEventListener('click', (e) => { const x = e.target.closest('.nbk-x'); if (!x) return; const r = x.closest('.nbk-ck-row'); items.splice(+r.dataset.k, 1); save(); renderChecklist(it, body, api); });
  body.querySelector('[data-ck-add]').addEventListener('click', () => { items.push({ text: '', done: false }); save(); renderChecklist(it, body, api); const last = body.querySelectorAll('.nbk-ck-row input[type=text]'); last[last.length - 1]?.focus(); });
}

/* ── paper quote (typed) ── */

/* V3.841 — every card that came from a paper links back to it in the reader (the annotation, when known) */
function readerUrl(d) { return d && d.paperId ? `/rm/pages/library-paper.html?id=${encodeURIComponent(d.paperId)}${d.annId ? '#ann-' + encodeURIComponent(d.annId) : ''}` : ''; }
function readerLink(d) { const u = readerUrl(d); return u ? `<a class="nbc-open-paper" href="${esc(u)}" target="_blank" rel="noopener" title="Open this paper in the reader">${ICON.svg('document-text')} Open in the reader</a>` : ''; }
/* ── linked board (a V3.830 whiteboard block that was not adopted) ── */
function renderBoardLink(it, body) {
  const bid = it.data?.boardId || '';
  body.innerHTML = bid ? `<div class="nbk-run-paused">${ICON.svg('pen-line')} A whiteboard from the block notebook. <a class="btn btn-small" href="/rm/pages/notebook-board.html?board=${encodeURIComponent(bid)}&owner=${encodeURIComponent(state.uid)}&title=${encodeURIComponent(it.title || 'Whiteboard')}" target="_blank" rel="noopener">Open it ↗</a></div>` : '<div class="nbk-pick-empty">This board link is empty.</div>';
}

/* ── inventory item ── */
async function ensureInventory() {
  if (state.inventory) return state.inventory;
  const [a, b] = await Promise.all([api.load('inventory/items.json').catch(() => null), api.load('inventory/chemicals.json').catch(() => null)]);
  const rows = [];
  const push = (arr, kind) => (Array.isArray(arr) ? arr : []).forEach(x => { if (!x || !x.id) return; rows.push({ id: x.id, kind, name: x.name || x.title || x.id, location: x.location || x.storage_location || '', catalog: x.catalog_number || x.catalog || x.cas || '', vendor: x.vendor || x.supplier || '', qty: x.quantity ?? x.qty ?? '', unit: x.unit || '',
    search: [x.name, x.title, x.vendor, x.supplier, x.catalog_number, x.cas, x.location, x.category, (x.tags || []).join(' ')].filter(Boolean).join(' ').toLowerCase() }); });
  push(a && (a.items || a), 'item'); push(b && (b.chemicals || b), 'chemical');
  rows.sort((x, y) => String(x.name).localeCompare(String(y.name)));
  state.inventory = rows; return rows;
}
function renderInventory(it, body, api) {
  const d = it.data || (it.data = {}); const ro = !api.canEdit();
  if (!d.itemId) {
    if (ro) { body.innerHTML = '<div class="nbk-pick-empty">No item chosen.</div>'; return; }
    body.innerHTML = `<div class="nbk-inline-pick-head"><input type="search" placeholder="Search the inventory…" data-iq></div><div class="nbk-inline-pick-list"><div class="nbk-pick-empty">Loading…</div></div>`;
    const list = body.querySelector('.nbk-inline-pick-list'), q = body.querySelector('[data-iq]');
    const draw = (rows) => { const terms = q.value.trim().toLowerCase().split(/\s+/).filter(Boolean); const show = rows.filter(r => terms.every(t => r.search.includes(t))).slice(0, 60);
      list.innerHTML = show.length ? show.map(r => `<button type="button" class="nbk-pick-row" data-id="${esc(r.id)}">${ICON.svg(r.kind === 'chemical' ? 'test-tube' : 'cube')} ${esc(r.name)}<small>${esc([r.vendor, r.catalog, r.location, r.qty !== '' ? `${r.qty} ${r.unit}` : ''].filter(Boolean).join(' · '))}</small></button>`).join('') : `<div class="nbk-pick-empty">${rows.length ? 'No item matches.' : 'The inventory is empty.'}</div>`; };
    ensureInventory().then(rows => { draw(rows); q.addEventListener('input', () => draw(rows)); }).catch(e => { list.innerHTML = `<div class="nbk-pick-empty">Could not load the inventory: ${esc(e.message || e)}</div>`; });
    list.addEventListener('click', (e) => { const r = e.target.closest('.nbk-pick-row'); if (!r) return; const row = (state.inventory || []).find(x => x.id === r.dataset.id); if (!row) return;
      const nd = Object.assign({}, d, { itemId: row.id, kind: row.kind, name: row.name, location: row.location, catalog: row.catalog, vendor: row.vendor, usage: d.usage || [] });
      api.save({ data: nd, text: `Inventory: ${row.name}`, title: it.title || row.name }); api.refresh(); });
    setTimeout(() => CANVAS_WIDGETS.autoFocus(q), 30);
    return;
  }
  const usage = Array.isArray(d.usage) ? d.usage : (d.usage = []);
  body.innerHTML = `<div class="nbc-inv">
      <div class="nbc-inv-name">${ICON.svg(d.kind === 'chemical' ? 'test-tube' : 'cube')} <b>${esc(d.name)}</b></div>
      <div class="nbc-inv-meta">${esc([d.vendor, d.catalog, d.location].filter(Boolean).join(' · ') || '—')} · <a href="/rm/pages/inventory.html?item=${encodeURIComponent(d.itemId)}" target="_blank" rel="noopener">open ↗</a></div>
      ${usage.length ? `<ul class="nbc-inv-usage">${usage.map((u, k) => `<li data-k="${k}">used <b>${esc(u.qty)}</b> ${esc(u.unit || '')} <span class="muted-text">${esc(String(u.at || '').slice(0, 16).replace('T', ' '))}</span>${ro ? '' : ' <button type="button" class="nbk-x" title="Remove">×</button>'}</li>`).join('')}</ul>` : ''}
      ${ro ? '' : `<div class="nbc-inv-use"><input type="number" step="any" placeholder="qty" data-uq style="width:70px"><input type="text" placeholder="unit (mL, g, pcs)" data-uu style="width:110px"><button type="button" class="btn btn-small" data-ulog>Log use</button></div>`}
    </div>`;
  if (ro) return;
  const save = () => api.saveData(d, `Inventory: ${d.name} ${usage.map(u => `used ${u.qty} ${u.unit || ''}`).join(' ')}`);
  body.querySelector('[data-ulog]').addEventListener('click', () => { const qv = body.querySelector('[data-uq]').value, uv = body.querySelector('[data-uu]').value.trim(); if (!qv) { body.querySelector('[data-uq]').focus(); return; } usage.push({ qty: qv, unit: uv, at: isoNow() }); save(); renderInventory(it, body, api); });
  body.querySelector('[data-uq]').addEventListener('keydown', (e) => { if (e.key === 'Enter') body.querySelector('[data-ulog]').click(); });
  body.querySelectorAll('.nbc-inv-usage .nbk-x').forEach(x => x.addEventListener('click', () => { const k = +x.closest('li').dataset.k; usage.splice(k, 1); save(); renderInventory(it, body, api); }));
}

/* ── V3.844 something I did (user-actions.js) ── */
function actionData(a) {
  return { actionId: a.id, kind: a.kind || '', text: USER_ACTIONS.describe(a), at: a.at || '', note: a.note || a.notes || '', itemId: a.itemId || '', equipmentId: a.equipmentId || '', labelCode: a.labelCode || '' };
}
function actionWhen(d) {
  const A = window.USER_ACTIONS;
  if (!A) return String(d.at || '').slice(0, 16).replace('T', ' ');
  return [A.core.dayLabel(A.dayKey(d.at)), A.timeOf(d.at)].filter(Boolean).join(' ');
}
function renderAction(it, body, api) {
  const d = it.data || (it.data = {}); const ro = !api.canEdit();
  if (!d.actionId) {
    if (ro) { body.innerHTML = '<div class="nbk-pick-empty">No action picked.</div>'; return; }
    if (!window.USER_ACTIONS) { body.innerHTML = '<div class="nbk-pick-empty">Your actions are not available on this page.</div>'; return; }
    body.innerHTML = `<div class="nbk-inline-pick-head"><input type="search" placeholder="Search what you did…" data-aq></div><div class="nbk-inline-pick-list"><div class="nbk-pick-empty">Loading…</div></div>`;
    const list = body.querySelector('.nbk-inline-pick-list'), q = body.querySelector('[data-aq]');
    let rows = [];
    const draw = () => { const terms = q.value.trim().toLowerCase().split(/\s+/).filter(Boolean);
      const show = rows.filter(a => terms.every(t => `${a.text} ${a.note}`.toLowerCase().includes(t))).slice(0, 60);
      list.innerHTML = show.length ? show.map(a => `<button type="button" class="nbk-pick-row" data-id="${esc(a.id)}">${ICON.render(a.icon)} ${esc(a.text)}<small>${esc([actionWhen(a), a.note].filter(Boolean).join(' · '))}</small></button>`).join('')
        : `<div class="nbk-pick-empty">${rows.length ? 'No action matches.' : 'Nothing recorded yet — scan a label to use an item, or book equipment, and it appears here.'}</div>`; };
    USER_ACTIONS.list({ limit: 100 }).then(all => {
      rows = USER_ACTIONS.pending(all).map(a => Object.assign({}, a, { icon: (USER_ACTIONS.core.KINDS[a.kind] || {}).icon || '•', text: USER_ACTIONS.describe(a), note: a.note || a.notes || '' }));
      draw(); q.addEventListener('input', draw);
    }).catch(e => { list.innerHTML = `<div class="nbk-pick-empty">Could not load your actions: ${esc(e.message || e)}</div>`; });
    list.addEventListener('click', (e) => { const r = e.target.closest('.nbk-pick-row'); if (!r) return; const a = rows.find(x => x.id === r.dataset.id); if (!a) return;
      const nd = actionData(a);
      api.save({ data: nd, text: 'Did: ' + nd.text, title: it.title || '' }); api.refresh();
      USER_ACTIONS.markNoted(a.id, { entryId: state.doc?.id || '', cardId: it.id }).catch(() => {}); });
    setTimeout(() => CANVAS_WIDGETS.autoFocus(q), 30);
    return;
  }
  const link = d.kind === 'equipment_booking' ? '/rm/pages/equipment.html' : (d.itemId ? `/rm/pages/inventory.html?item=${encodeURIComponent(d.itemId)}` : '');
  body.innerHTML = `<div class="nbc-act"><div class="nbc-act-text">${ICON.svg('bolt')} <b>${esc(d.text)}</b></div>
    <div class="nbc-inv-meta">${esc(actionWhen(d))}${d.note ? ' · ' + esc(d.note) : ''}${link ? ` · <a href="${esc(link)}" target="_blank" rel="noopener">open ↗</a>` : ''}</div></div>`;
}
/* ?action=<id> (actions.html / scan.html "＋ Notebook"): the card lands in the entry that opened */
async function insertActionById(id) {
  if (!window.USER_ACTIONS) return;
  let a = null; try { a = await USER_ACTIONS.get(id); } catch (e) {}
  if (!a) { toast('error', 'That action was not found.'); return; }
  for (let i = 0; i < 40 && !state.inst; i++) await new Promise(r => setTimeout(r, 100));
  if (!state.inst) return;
  const d = actionData(a);
  const cardId = await state.inst.addWidget({ kind: 'action', w: 0.42, title: '', data: d, text: 'Did: ' + d.text });
  try { await USER_ACTIONS.markNoted(a.id, { entryId: state.doc?.id || '', cardId: cardId || '' }); } catch (e) {}
  toast('success', 'Added to this entry: ' + d.text);
  try { history.replaceState(null, '', location.pathname + (state.doc ? '?entry=' + encodeURIComponent(state.doc.id) : '')); } catch (e) {}
}

/* ── calculator (the V3.830 formula calculator on a card) ── */
function ensureCalcDeps() {
  if (state.calcDepsPromise) return state.calcDepsPromise;
  loadCssOnce('nbk-protocol-doc-css', '/rm/css/protocol-doc.css');
  state.calcDepsPromise = loadScriptOnce('/rm/js/protocol-formulas.js', 'ProtocolFormulas')
    .then(() => loadScriptOnce('/rm/js/protocol-widgets.js', 'ProtocolWidgets'))
    .then(() => loadScriptOnce('/rm/js/protocol-doc-render.js', 'ProtocolDocRender'));
  return state.calcDepsPromise;
}
function renderCalc(it, body, api) {
  const d = it.data || (it.data = {});
  if (!d.spec || (d.spec.kind !== 'formula' && d.spec.kind !== 'calculator')) d.spec = newFormulaSpec();
  if (!d.inputs || typeof d.inputs !== 'object') d.inputs = {};
  if (!Array.isArray(d.context)) d.context = [];
  const ro = !api.canEdit();
  body.innerHTML = `<div class="nbk-calc-host prd-doc"><div class="nbk-section-label">Loading calculator…</div></div>
    ${ro ? '' : `<details class="nbk-calc-edit"${d.spec.kind === 'formula' ? '' : ' hidden'}><summary>Edit the formula</summary><div class="nbk-calc-form" data-calc-form></div></details>
    <div class="nbk-calc-acts"><button type="button" class="btn btn-small" data-calc="from-protocol">${ICON.svg('clipboard-document-list')} Copy from a protocol…</button><span class="nbk-calc-err" data-calc-err hidden></span></div>
    <div class="nbk-inline-pick" data-calc-pick hidden></div>`}`;
  if (!ro) {
    if (d.spec.kind === 'formula') renderCalcForm(it, body.querySelector('[data-calc-form]'), api, body);
    body.querySelector('[data-calc="from-protocol"]').addEventListener('click', () => openProtocolPick(body.querySelector('[data-calc-pick]'), (entry) => pickCalcFromProtocol(it, body, entry, api)));
  }
  mountCalc(it, body, api);
}
function renderCalcForm(it, form, api, host) {   /* V3.855 — host = the body the calculator lives in (a card body, or the phone sheet) */
  const d = it.data; const a = d.spec.attrs;
  const v = (x) => esc(x === undefined || x === null ? '' : x);
  form.innerHTML = `
    <label>Label <input data-f="label" value="${v(a.label)}"></label>
    <label>Expression <input data-f="expression" value="${v(a.expression)}" placeholder="e.g. m / v   (mathjs: sqrt(x), x^2, pi…)" spellcheck="false"></label>
    <label>Result <span style="display:flex;gap:4px"><input data-f="output.name" value="${v(a.output?.name)}" placeholder="name" style="width:80px"><input data-f="output.label" value="${v(a.output?.label)}" placeholder="label"><input data-f="output.unit" value="${v(a.output?.unit)}" placeholder="unit" style="width:70px"><input data-f="output.decimals" type="number" min="0" max="8" value="${v(a.output?.decimals ?? 3)}" style="width:60px" title="decimals"></span></label>
    <div class="nbk-section-label">Inputs (name · label · default · unit)</div>
    <div class="nbk-calc-vars">${(a.variables || []).map((x, k) => `<div class="nbk-calc-var" data-k="${k}">
      <input data-v="name" value="${v(x.name)}" placeholder="name" spellcheck="false"><input data-v="label" value="${v(x.label)}" placeholder="label"><input data-v="default" type="number" step="any" value="${v(x.default)}" placeholder="default"><input data-v="unit" value="${v(x.unit)}" placeholder="unit"><button type="button" class="nbk-x" title="Remove">×</button></div>`).join('')}</div>
    <div><button type="button" class="btn btn-small" data-add-var>＋ input</button></div>`;
  const apply = () => {
    a.label = form.querySelector('[data-f="label"]').value;
    a.expression = form.querySelector('[data-f="expression"]').value;
    a.output = a.output || {};
    a.output.name = (form.querySelector('[data-f="output.name"]').value.trim() || 'result').replace(/[^a-zA-Z0-9_]/g, '_');
    a.output.label = form.querySelector('[data-f="output.label"]').value;
    a.output.unit = form.querySelector('[data-f="output.unit"]').value;
    a.output.decimals = Math.max(0, Math.min(8, parseInt(form.querySelector('[data-f="output.decimals"]').value, 10) || 0));
    a.variables = Array.from(form.querySelectorAll('.nbk-calc-var')).map(r => ({
      name: (r.querySelector('[data-v="name"]').value.trim() || 'x').replace(/[^a-zA-Z0-9_]/g, '_'),
      label: r.querySelector('[data-v="label"]').value, default: parseFloat(r.querySelector('[data-v="default"]').value) || 0, unit: r.querySelector('[data-v="unit"]').value }));
    api.saveData(d, `${a.label} ${a.expression}`);
    mountCalc(it, host || form.closest('[data-wb-sheet-body], [data-wb-wbody], .wb-wb'), api);
  };
  let t = null;
  form.addEventListener('input', () => { clearTimeout(t); t = setTimeout(apply, 350); });
  form.addEventListener('click', (e) => {
    if (e.target.closest('[data-add-var]')) { a.variables = a.variables || []; a.variables.push({ name: 'x' + (a.variables.length + 1), label: '', default: 1, unit: '' }); renderCalcForm(it, form, api, host); apply(); }
    const x = e.target.closest('.nbk-x'); if (x) { const r = x.closest('.nbk-calc-var'); a.variables.splice(+r.dataset.k, 1); renderCalcForm(it, form, api, host); apply(); }
  });
}
async function mountCalc(it, body, api) {
  const host = body.querySelector('.nbk-calc-host'); const err = body.querySelector('[data-calc-err]');
  if (!host) return;
  unmountRun(it.id);
  try {
    await ensureCalcDeps();
    const PF = window.ProtocolFormulas, PW = window.ProtocolWidgets;
    const math = await PF.ensureMathjs();
    const d = it.data;
    const blocks = [...(d.context || []), d.spec];
    const formulas = PF.collectFormulasFromPlainTree({ sections: [{ children: blocks }] });
    if (!host.isConnected) return;
    const ctx = PW.createContext({ container: host, math, formulas, overrides: d.inputs, readOnly: !api.canEdit(),
      onChange: () => { syncCalcResult(it, ctx); api.saveData(d, `${d.spec?.attrs?.label || ''} ${d.result || ''}`); } });
    ctx.table = PF.buildSymbolTable(formulas, math, d.inputs);
    host.innerHTML = '';
    const node = window.ProtocolDocRender.renderBlock(d.spec, ctx, {});
    if (node) host.appendChild(node); else host.innerHTML = '<div class="nbk-section-label">This calculator kind cannot be rendered here.</div>';
    state.runs[it.id] = { ctx, unlisten: PW.mountRefresherBus(ctx) };
    PW.recompute(ctx);
    syncCalcResult(it, ctx);
    if (err) err.hidden = true;
  } catch (e) {
    console.warn('[notebook] calculator', e);
    if (err) { err.textContent = 'Calculator unavailable: ' + (e.message || e); err.hidden = false; }
    else host.innerHTML = `<div class="nbk-section-label">Calculator unavailable: ${esc(e.message || e)}</div>`;
  }
}
function syncCalcResult(it, ctx) {
  const d = it.data; const a = d.spec?.attrs || {};
  const name = d.spec.kind === 'formula' ? a.output?.name : (a.outputs && a.outputs[0] && a.outputs[0].name);
  const sym = name && ctx.table && ctx.table[name];
  const PF = window.ProtocolFormulas;
  d.result = sym ? (sym.error ? 'Error: ' + sym.error : (PF.formatSymbolValue ? PF.formatSymbolValue(sym) : String(sym.value))) : '';
}
async function pickCalcFromProtocol(it, body, entry, api) {
  const pick = body.querySelector('[data-calc-pick]');
  pick.innerHTML = '<div class="nbk-pick-empty">Loading the protocol…</div>';
  let tree;
  try { tree = await loadProtocolTree(entry.id); } catch (e) { pick.innerHTML = `<div class="nbk-pick-empty">Could not load: ${esc(e.message || e)}</div>`; return; }
  const calcs = [];
  (tree.sections || []).forEach(sec => (sec.children || []).forEach(x => { if (x && (x.kind === 'formula' || x.kind === 'calculator')) calcs.push(x); }));
  if (!calcs.length) { pick.innerHTML = `<div class="nbk-pick-empty">“${esc(entry.title)}” has no formula or calculator blocks. <button type="button" class="btn btn-small" data-back>← Back</button></div>`; pick.querySelector('[data-back]').addEventListener('click', () => openProtocolPick(pick, (en) => pickCalcFromProtocol(it, body, en, api))); return; }
  pick.innerHTML = `<div class="nbk-inline-pick-head"><button type="button" class="btn btn-small" data-back>←</button><span style="font-size:.85rem">Calculators in <b>${esc(entry.title)}</b></span></div>
    <div class="nbk-inline-pick-list">${calcs.map((x, k) => `<button type="button" class="nbk-pick-row" data-k="${k}">${ICON.svg(x.kind === 'formula' ? 'calculator' : 'adjustments-vertical')} ${esc(x.attrs?.label || x.kind)}<small>${esc(x.attrs?.expression || (x.attrs?.outputs || []).map(o => o.expr).join(' · ') || '')}</small></button>`).join('')}</div>`;
  pick.querySelector('[data-back]').addEventListener('click', () => openProtocolPick(pick, (en) => pickCalcFromProtocol(it, body, en, api)));
  pick.querySelector('.nbk-inline-pick-list').addEventListener('click', (e) => {
    const r = e.target.closest('.nbk-pick-row'); if (!r) return;
    const chosen = calcs[+r.dataset.k];
    const nd = { spec: JSON.parse(JSON.stringify(chosen)), context: calcs.filter(x => x !== chosen).map(x => JSON.parse(JSON.stringify(x))), inputs: {}, result: '' };
    api.save({ data: nd, text: nd.spec.attrs?.label || '', title: it.title || chosen.attrs?.label || '' }); api.refresh();
    toast('success', 'Calculator copied — its inputs are yours to change.');
  });
}

/* ── protocol list + tree ── */
async function ensureProtocolList() {
  if (state.protocolsList) return state.protocolsList;
  const d = await api.load('protocols/list.json');
  const list = (d && Array.isArray(d.protocols) ? d.protocols : []).map(p => ({ id: p.id, title: p.title || p.id, summary: p.summary || '', category: p.category || '', status: p.status || '', updated_at: p.updated_at || '',
    search: [p.title, p.summary, p.category, (p.tags || []).join(' ')].filter(Boolean).join(' ').toLowerCase() }))
    .sort((a, b) => String(b.updated_at).localeCompare(String(a.updated_at)));
  state.protocolsList = list; return list;
}
async function loadProtocolTree(id) {
  const s = await db().collection('protocols').doc(id).get();
  if (!s.exists) throw new Error('protocol not found');
  const doc = window.ProtocolSchemas?.protocolHydrate ? window.ProtocolSchemas.protocolHydrate(s.data()) : s.data();
  if (!doc.tree || !Array.isArray(doc.tree.sections)) throw new Error('this protocol has no document yet');
  return doc.tree;
}
function openProtocolPick(host, onPick) {
  host.hidden = false;
  host.innerHTML = `<div class="nbk-inline-pick-head"><input type="search" placeholder="Search protocols…" data-pq><button type="button" class="btn btn-small" data-close>✕</button></div><div class="nbk-inline-pick-list"><div class="nbk-pick-empty">Loading…</div></div>`;
  const list = host.querySelector('.nbk-inline-pick-list'), q = host.querySelector('[data-pq]');
  const draw = (rows) => { const terms = q.value.trim().toLowerCase().split(/\s+/).filter(Boolean); const show = rows.filter(r => terms.every(t => r.search.includes(t))).slice(0, 60);
    list.innerHTML = show.length ? show.map(r => `<button type="button" class="nbk-pick-row" data-id="${esc(r.id)}">${esc(r.title)}<small>${esc([r.category, r.status, r.summary.slice(0, 90)].filter(Boolean).join(' · '))}</small></button>`).join('') : '<div class="nbk-pick-empty">No protocol matches.</div>'; };
  ensureProtocolList().then(rows => { draw(rows); q.addEventListener('input', () => draw(rows)); }).catch(e => { list.innerHTML = `<div class="nbk-pick-empty">Could not load protocols: ${esc(e.message || e)}</div>`; });
  host.querySelector('[data-close]').addEventListener('click', () => { host.hidden = true; host.innerHTML = ''; });
  list.addEventListener('click', (e) => { const r = e.target.closest('.nbk-pick-row'); if (!r) return; const entry = (state.protocolsList || []).find(x => x.id === r.dataset.id); if (entry) onPick(entry); });
  setTimeout(() => CANVAS_WIDGETS.autoFocus(q), 30);
}

/* ── protocol followed (the V3.506 run document on a card) ── */
function ensureRunDeps() {
  if (state.depsPromise) return state.depsPromise;
  loadCssOnce('nbk-protocol-doc-css', '/rm/css/protocol-doc.css');
  loadCssOnce('nbk-protocol-cheat-css', '/rm/css/protocol-cheat.css');
  state.depsPromise = loadScriptOnce('/rm/js/protocol-formulas.js', 'ProtocolFormulas')
    .then(() => loadScriptOnce('/rm/js/protocol-graph.js', 'ProtocolGraph'))
    .then(() => loadScriptOnce('/rm/js/protocol-widgets.js', 'ProtocolWidgets'))
    .then(() => loadScriptOnce('/rm/js/protocol-doc-render.js', 'ProtocolDocRender'))
    .then(() => loadScriptOnce('/rm/js/protocol-cheat-render.js', 'ProtocolCheatRender'))
    .then(() => loadScriptOnce('/rm/js/protocol-inventory.js', 'PROTOCOL_INVENTORY').then(inv => { try { inv && inv.ensureList && inv.ensureList().catch(() => {}); } catch (e) {} }).catch(() => {}));
  return state.depsPromise;
}
function freshRun(id, title) {
  return { protocol_id: id, protocol_title: title || id, protocol_version: null, loaded_at: isoNow(), view: 'doc', inputs: {}, graph_state: {}, grids: [], assignment: {}, factor: 1, computed: null, frozen: false, frozen_at: null, snapshot: null };
}
function renderProtocol(it, body, api) {
  const d = it.data || (it.data = {}); const run = d.run; const ro = !api.canEdit();
  if (!run || !run.protocol_id) {
    if (ro) { body.innerHTML = '<div class="nbk-pick-empty">No protocol loaded.</div>'; return; }
    body.innerHTML = `<div class="nbk-run-paused">No protocol loaded. <button type="button" class="btn btn-primary btn-small" data-load>${ICON.svg('clipboard-document-list')} Load a protocol…</button></div><div class="nbk-inline-pick" data-proto-pick hidden></div>`;
    body.querySelector('[data-load]').addEventListener('click', () => openProtocolPick(body.querySelector('[data-proto-pick]'), (entry) => {
      const nd = { run: freshRun(entry.id, entry.title) }; state.protoLive = it.id;
      api.save({ data: nd, text: `Protocol followed: ${entry.title}`, title: it.title || entry.title }); api.refresh();
    }));
    return;
  }
  if (run.frozen || ro) { renderFrozenRun(it, body, api, ro); return; }
  if (state.protoLive && state.protoLive !== it.id && state.runs[state.protoLive]) {
    body.innerHTML = `<div class="nbk-run-paused">${ICON.svg('clipboard-document-list')} <b>${esc(run.protocol_title || run.protocol_id)}</b> — another protocol card is live on this entry (their calculators share one workspace). <button type="button" class="btn btn-small" data-resume>${ICON.svg('play')} Make this one live</button></div>`;
    body.querySelector('[data-resume]').addEventListener('click', () => { const other = state.protoLive; state.protoLive = it.id; if (other) { unmountRun(other); state.inst?.refreshWidget(other); } api.refresh(); });
    return;
  }
  state.protoLive = it.id;
  mountRunLive(it, body, api);
}
async function mountRunLive(it, body, api) {
  const run = it.data.run;
  body.innerHTML = '<div class="nbk-section-label">Loading the protocol document…</div>';
  try {
    await ensureRunDeps();
    const tree = await loadProtocolTree(run.protocol_id);
    const PF = window.ProtocolFormulas, PW = window.ProtocolWidgets;
    const formulas = PF.collectFormulasFromPlainTree(tree);
    const needsMath = formulas.length > 0 || (tree.sections || []).some(sec => (sec.children || []).some(x => x && (x.kind === 'builder' || x.kind === 'layoutMap' || x.kind === 'design')));
    const math = needsMath ? await PF.ensureMathjs().catch(() => null) : null;
    if (!body.isConnected) return;
    unmountRun(it.id);
    body.innerHTML = '';
    body.appendChild(buildRunToolbar(it, body, protocolHasSteps(tree), api));
    let t = null;
    const ctx = PW.createContext({ container: body, math, formulas, overrides: run.inputs, builderState: run.graph_state,
      onChange: () => { syncRunComputed(it); clearTimeout(t); t = setTimeout(() => api.saveData(it.data, `Protocol followed: ${run.protocol_title || run.protocol_id}`), 500); } });
    ctx.table = math ? PF.buildSymbolTable(formulas, math, run.inputs) : {};
    const card = document.createElement('div'); card.className = 'prd-doc nbk-run-doc';
    body.appendChild(card);
    const R = state.runs[it.id] = { ctx, tree, unlisten: null, cheat: state.runs[it.id]?.cheat || { protocolId: null, prefs: null, customizing: false } };
    renderProtocolDocInto(it, body, card, tree, ctx, run, api);
    R.unlisten = PW.mountRefresherBus(ctx);
    PW.recompute(ctx);
    syncRunComputed(it);
  } catch (e) {
    console.warn('[notebook] protocol run', e);
    body.innerHTML = `<div class="nbk-run-paused">Could not load “${esc(run.protocol_title || run.protocol_id)}”: ${esc(e.message || e)} <button type="button" class="btn btn-small" data-unload>Unload</button></div>`;
    body.querySelector('[data-unload]').addEventListener('click', () => { api.saveData({ run: null }, ''); api.refresh(); });
  }
}
function protocolHasSteps(tree) { return (tree?.sections || []).some(sec => (sec.children || []).some(x => x && x.kind === 'step')); }
function runDatasets(tree) {
  const out = [];
  (tree.sections || []).forEach(sec => (sec.children || []).forEach(x => {
    if (!x) return;
    if (x.kind === 'builder') out.push({ name: x.attrs?.dataset || 'items', keyFields: (x.attrs?.dims || []).map(d => d.field) });
    else if (x.kind === 'design' && window.ProtocolGraph) { try { (window.ProtocolGraph.compile(x.attrs || {}).datasets || []).forEach(d => out.push({ name: d.name, keyFields: (d.spec.dims || []).map(y => y.field) })); } catch (e) {} }
  }));
  return out;
}
function syncRunComputed(it) {
  const run = it.data.run; const R = state.runs[it.id];
  if (!run || !R || !window.ProtocolFormulas) return;
  const ds = runDatasets(R.tree)[0];
  const items = ds ? (window.ProtocolFormulas.getDataset(ds.name) || []) : [];
  run.computed = { items: items.slice(), totals: null };
}
function buildRunToolbar(it, body, hasCheat, api, ro) {
  const run = it.data.run;
  const bar = document.createElement('div'); bar.className = 'nbk-run-toolbar';
  bar.innerHTML = `<div class="nbk-run-toolbar-title">${ICON.svg('clipboard-document-list')} ${esc(run.protocol_title || run.protocol_id)} · ${run.frozen ? 'finalized' : 'live'}</div>
    ${hasCheat ? `<div class="nbk-run-toggle"><button type="button" data-view="doc" class="${(run.view || 'doc') === 'doc' ? 'nbk-sel' : ''}">${ICON.svg('document-text')} Document</button><button type="button" data-view="cheat" class="${run.view === 'cheat' ? 'nbk-sel' : ''}">${ICON.svg('clipboard-document-list')} Cheat sheet</button></div>` : ''}
    ${ro ? '' : run.frozen ? '<button type="button" class="btn btn-small" data-run="reopen" title="Unlock the values to edit them again (two taps)">✎ Reopen</button>'
                 : '<button type="button" class="btn btn-primary btn-small" data-run="finalize" title="Lock the values you used into this entry as an immutable record (two taps)">✓ Finalize</button>'}
    <a class="btn btn-small" href="/rm/pages/protocols.html?protocol=${encodeURIComponent(run.protocol_id)}&view=doc" target="_blank" rel="noopener" title="Open the protocol">↗</a>`;
  bar.addEventListener('click', (e) => {
    const v = e.target.closest('[data-view]'); if (v) { if ((run.view || 'doc') !== v.dataset.view) { run.view = v.dataset.view; api.saveData(it.data); api.refresh(); } return; }
    const r = e.target.closest('[data-run]'); if (!r || ro) return;
    if (r.dataset.run === 'finalize') { if (!armTwoTap(r, 'Lock the values?')) return; freezeRun(it); api.saveData(it.data, `Protocol followed: ${run.protocol_title || run.protocol_id} (finalized)`); api.refresh(); toast('success', 'Protocol finalized — the values used are now a locked record.'); }
    else if (r.dataset.run === 'reopen') { if (!armTwoTap(r, 'Unlock?')) return; run.frozen = false; run.frozen_at = null; api.saveData(it.data); api.refresh(); }
  });
  return bar;
}
function freezeRun(it) {
  const run = it.data.run; if (!run || run.frozen) return;
  syncRunComputed(it);
  try { run.snapshot = JSON.parse(JSON.stringify({ inputs: run.inputs, graph_state: run.graph_state, grids: run.grids, assignment: run.assignment, factor: run.factor, computed: run.computed, protocol_id: run.protocol_id, protocol_title: run.protocol_title })); }
  catch (e) { run.snapshot = null; }
  run.frozen = true; run.frozen_at = isoNow();
  unmountRun(it.id); if (state.protoLive === it.id) state.protoLive = null;
}
function renderMasthead(tree, run) {
  const el = document.createElement('header'); el.className = 'prd-masthead';
  el.innerHTML = `<div class="prd-brand"><span class="prd-brand-name">McGhee Lab</span><span class="prd-brand-tag">${run.view === 'cheat' ? 'PROTOCOL · CHEAT SHEET' : 'PROTOCOL'}</span></div>
    <h1 class="prd-title">${esc((tree.meta && tree.meta.title) || run.protocol_title || run.protocol_id)}</h1>
    <div class="prd-chips"><span class="prd-chip prd-chip-meta">${run.frozen && run.frozen_at ? ICON.svg('lock-closed') + ' finalized ' + esc(String(run.frozen_at).slice(0, 10)) : 'live — values editable'}</span>${run.loaded_at ? `<span class="prd-chip prd-chip-meta">loaded ${esc(String(run.loaded_at).slice(0, 10))}</span>` : ''}</div>`;
  return el;
}
function renderProtocolDocInto(it, body, card, tree, ctx, run, api) {
  const R = state.runs[it.id];
  if (run.view === 'cheat' && window.ProtocolCheatRender && R) {
    const PCR = window.ProtocolCheatRender;
    card.classList.add('prc-doc');
    const head = document.createElement('header'); head.className = 'prc-header';
    head.innerHTML = `<h1 class="prc-title">${esc((tree.meta && tree.meta.title) || run.protocol_title || run.protocol_id)}</h1><div class="prc-meta">${run.frozen && run.frozen_at ? ICON.svg('lock-closed') + ' finalized ' + esc(String(run.frozen_at).slice(0, 10)) : 'live · values editable'} · cheat sheet</div>`;
    card.appendChild(head);
    const cs = R.cheat;
    if (cs.protocolId !== run.protocol_id) {
      cs.protocolId = run.protocol_id; cs.prefs = null; cs.customizing = false;
      PCR.loadPrefs(run.protocol_id).then(p => { if (cs.protocolId !== run.protocol_id || !state.runs[it.id]) return; cs.prefs = p; api.refresh(); });
    }
    if (!cs.prefs) { const l = document.createElement('div'); l.className = 'prc-configbar-loading'; l.textContent = 'Loading cheat-sheet options…'; card.appendChild(l); return; }
    const prefs = cs.prefs, pid = run.protocol_id;
    const handlers = {
      customizing: cs.customizing,
      onToggleCategory: (c, next) => { prefs.categories[c] = next; PCR.savePrefs(pid, prefs); api.refresh(); },
      onToggleBlock: (id, v) => { prefs.overrides[id] = v; PCR.savePrefs(pid, prefs); api.refresh(); },
      onToggleCustomize: (next) => { cs.customizing = next; api.refresh(); },
      onReset: () => { const d = PCR.defaultPrefs(); prefs.categories = d.categories; prefs.overrides = d.overrides; PCR.savePrefs(pid, prefs); api.refresh(); }
    };
    card.appendChild(PCR.buildConfigBar(prefs, handlers));
    if (cs.customizing) PCR.renderChecklistInto(card, tree, prefs, handlers); else PCR.renderSectionsInto(card, tree, ctx, { prefs });
    return;
  }
  card.classList.remove('prc-doc');
  card.appendChild(renderMasthead(tree, run));
  let step = 0;
  (tree.sections || []).forEach((sec, i) => {
    const secEl = document.createElement('section'); secEl.className = 'prd-section';
    const code = String(i + 1).padStart(2, '0');
    secEl.innerHTML = `<div class="prd-stage"><h2 class="prd-stage-title"><span class="prd-stage-code">${code}</span>${esc(sec.label || 'Untitled section')}</h2></div>`;
    (sec.children || []).forEach(x => {
      if (!x || x.kind === 'docHeader') return;
      if (x.kind === 'step') step++;
      let el = null;
      try { el = window.ProtocolDocRender.renderBlock(x, ctx, { stepNumber: step }); } catch (e) { console.warn('[notebook] block render', e); }
      if (el) secEl.appendChild(el);
    });
    card.appendChild(secEl);
  });
}
async function renderFrozenRun(it, body, api, ro) {
  const run = it.data.run; const snap = run.snapshot || {};
  body.innerHTML = '<div class="nbk-section-label">Loading the record…</div>';
  try {
    await ensureRunDeps();
    const PF = window.ProtocolFormulas, PW = window.ProtocolWidgets;
    const tree = await loadProtocolTree(run.protocol_id);
    const formulas = PF.collectFormulasFromPlainTree(tree);
    const needsMath = formulas.length > 0 || (tree.sections || []).some(sec => (sec.children || []).some(x => x && (x.kind === 'builder' || x.kind === 'layoutMap' || x.kind === 'design')));
    const math = needsMath ? await PF.ensureMathjs().catch(() => null) : null;
    if (!body.isConnected) return;
    body.innerHTML = '';
    body.appendChild(buildRunToolbar(it, body, protocolHasSteps(tree), api, ro));
    const ctx = PW.createContext({ container: body, math, formulas, overrides: snap.inputs || run.inputs || {}, builderState: snap.graph_state || run.graph_state || {}, readOnly: true });
    ctx.table = math ? PF.buildSymbolTable(formulas, math, ctx.overrides) : {};
    state.runs[it.id] = { ctx, tree, unlisten: null, cheat: state.runs[it.id]?.cheat || { protocolId: null, prefs: null, customizing: false } };
    const card = document.createElement('div'); card.className = 'prd-doc nbk-run-doc nbk-run-doc-frozen';
    body.appendChild(card);
    renderProtocolDocInto(it, body, card, tree, ctx, run, api);
    PW.recompute(ctx);
  } catch (e) {
    body.innerHTML = '';
    body.appendChild(buildRunToolbar(it, body, false, api, ro));
    const n = document.createElement('div'); n.className = 'nbk-run-paused'; n.textContent = 'Record (the protocol document could not be re-rendered: ' + (e.message || e) + ').'; body.appendChild(n);
  }
  if (run.frozen) body.appendChild(renderFrozenRecord(run));
}
function renderFrozenRecord(run) {
  const snap = run.snapshot || {};
  const wrap = document.createElement('details'); wrap.className = 'nbk-run-record';
  let html = `<summary>${ICON.svg('lock-closed')} Recorded values (finalized ${esc(String(run.frozen_at || '').slice(0, 10))})</summary>`;
  const inputs = snap.inputs || {}; const keys = Object.keys(inputs);
  if (keys.length) html += '<div class="nbk-section-label">Inputs used</div><table><tbody>' + keys.map(k => `<tr><td>${esc(k)}</td><td>${esc(String(inputs[k]))}</td></tr>`).join('') + '</tbody></table>';
  const items = (snap.computed && snap.computed.items) || [];
  if (items.length) {
    const cols = Object.keys(items[0]).filter(k => !k.endsWith('_value'));
    html += '<div class="nbk-section-label">Item list</div><table><thead><tr><th>#</th>' + cols.map(c => `<th>${esc(c.replace(/_label$/, ''))}</th>`).join('') + '</tr></thead><tbody>' +
      items.map((row, i) => `<tr><td>${i + 1}</td>${cols.map(c => `<td>${esc(row[c] === null || row[c] === undefined ? '' : String(row[c]))}</td>`).join('')}</tr>`).join('') + '</tbody></table>';
  }
  if (!keys.length && !items.length) html += '<div class="nbk-pick-empty">No numeric inputs were recorded.</div>';
  wrap.innerHTML = html;
  return wrap;
}
function unmountRun(id) {
  const R = state.runs[id]; if (!R) return;
  if (R.unlisten) { try { R.unlisten(); } catch (e) {} }
  delete state.runs[id];
}
function unmountRuns() { Object.keys(state.runs).forEach(unmountRun); state.protoLive = null; }

/* V3.859 — the lit review card (V3.838) is a 📑 Collection now: rm/js/canvas-paper-reader.js renders, mirrors and adopts it */

/* ================================================================
   ＋ From paper — the picker column (V3.830, now on the canvas page)
   ================================================================ */
function togglePicker(forceOpen) {
  const pk = $('nbb-picker');
  if (!pk.hidden && !forceOpen) { closePicker(); return; }
  if (!state.inst?.isAdmin()) { toast('info', 'Only the entry\'s owner can add to it.'); return; }
  pk.hidden = false;
  if (!state.pk) state.pk = { papers: null, q: '', paper: null, tab: 'pages', viewer: null, figs: null, hls: null, mq: null };
  renderPicker(); markTool(true);
}
function closePicker() {
  const pk = $('nbb-picker'); if (!pk || pk.hidden) return;
  destroyViewer(); pk.hidden = true;
  if (state.pk) state.pk.paper = null;
  markTool(false);
}
function markTool(on) { const b = document.querySelector('[data-wb-act="tool"][data-tool="paper"]'); if (b) b.classList.toggle('wb-sel', !!on); }
function renderPicker() {
  const pk = $('nbb-picker'); const P = state.pk;
  if (!P.paper) {
    pk.innerHTML = `
      <div class="nbb-pk-head"><span class="nbb-pk-title">From a paper in the library</span>
        <button type="button" class="btn btn-small btn-ghost" data-pk="close" title="Close">✕</button></div>
      <div class="nbb-pk-search"><input type="search" class="wb-input" data-pk-q placeholder="Search title, author, year, journal…" value="${esc(P.q)}" autocomplete="off"></div>
      <div class="nbb-pk-sel-row"><select class="nbb-pk-sel" data-pk-draft title="Every highlight and figure you selected for one of your papers, across the library"><option value="">Selected for a paper…</option></select></div>
      <div class="nbb-pk-list" data-pk-list><div class="nbb-pk-status">Loading the library…</div></div>`;
    wirePicker();
    loadMyDrafts().then(rows => { const sel = pk.querySelector('[data-pk-draft]'); if (!sel) return; sel.innerHTML = '<option value="">Selected for a paper…</option>' + rows.map(r => `<option value="${esc(r.id)}">${esc(r.title)}${r.type === 'grant' ? ' (grant)' : ''}</option>`).join('') + (rows.length ? '' : '<option value="" disabled>— you have no paper drafts yet —</option>'); }).catch(e => console.warn('[notebook] drafts', e));
    loadPapers().then(() => renderPaperList()).catch(e => { const l = pk.querySelector('[data-pk-list]'); if (l) l.innerHTML = `<div class="nbb-pk-status nbb-err">Could not load the library: ${esc(e.message || e)}</div>`; });
    const q = pk.querySelector('[data-pk-q]'); if (q) setTimeout(() => CANVAS_WIDGETS.autoFocus(q), 50);
    return;
  }
  const p = P.paper;
  pk.innerHTML = `
    <div class="nbb-pk-head">
      <button type="button" class="btn btn-small btn-ghost" data-pk="back" title="Back to the list">←</button>
      <span class="nbb-pk-title" title="${esc(p.title)}">${esc(p.title)}</span>
      <button type="button" class="btn btn-small btn-ghost" data-pk="close" title="Close">✕</button>
    </div>
    <div class="nbb-pk-tabs">
      ${p.selected ? '' : `<button type="button" class="nbb-pk-tab${P.tab === 'pages' ? ' nbb-sel' : ''}" data-pk-tab="pages">${ICON.svg('document-text')} Pages</button>`}
      <button type="button" class="nbb-pk-tab${P.tab === 'figs' ? ' nbb-sel' : ''}" data-pk-tab="figs">${ICON.svg('photo')} Figures${P.figs ? ` (${P.figs.length})` : ''}</button>
      <button type="button" class="nbb-pk-tab${P.tab === 'hls' ? ' nbb-sel' : ''}" data-pk-tab="hls">${ICON.svg('highlighter')} Highlights${P.hls ? ` (${P.hls.length})` : ''}</button>
    </div>
    ${P.tab === 'pages' ? `<div class="nbb-pk-hint">Click a dashed figure box to add it to the sheet. Drag over any region for <b>Add as figure</b> / <b>Add as text</b>.
      <span style="float:right;white-space:nowrap"><button type="button" class="btn btn-small btn-ghost" data-pk="zoom-out" title="Smaller">−</button> <button type="button" class="btn btn-small btn-ghost" data-pk="zoom-in" title="Larger">+</button></span></div>` : ''}
    <div class="nbb-pk-body" data-pk-body></div>`;
  wirePicker();
  if (P.tab === 'pages') mountPdfPane(); else if (P.tab === 'figs') renderFigs(); else renderHls();
}
function wirePicker() {
  const pk = $('nbb-picker');
  if (pk.dataset.wired) return;
  pk.dataset.wired = '1';
  pk.addEventListener('click', (e) => {
    const b = e.target.closest('[data-pk],[data-pk-tab],[data-pk-open],[data-pk-fig],[data-pk-hl]'); if (!b) return;
    const P = state.pk;
    if (b.dataset.pk === 'close') { closePicker(); return; }
    if (b.dataset.pk === 'back') { destroyViewer(); P.paper = null; P.figs = null; P.hls = null; renderPicker(); return; }
    if (b.dataset.pk === 'zoom-in') { P.viewer?.zoomIn(); return; }
    if (b.dataset.pk === 'zoom-out') { P.viewer?.zoomOut(); return; }
    if (b.dataset.pkTab) { if (P.tab !== b.dataset.pkTab) { destroyViewer(); P.tab = b.dataset.pkTab; renderPicker(); } return; }
    if (b.dataset.pkOpen) { const row = (P.papers || []).find(r => r.id === b.dataset.pkOpen); if (row) openPaper(row); return; }
    if (b.dataset.pkFig) { addExistingFigure(b.dataset.pkFig); return; }
    if (b.dataset.pkHl) { addHighlight(b.dataset.pkHl); return; }
  });
  pk.addEventListener('input', (e) => { const q = e.target.closest('[data-pk-q]'); if (!q) return; state.pk.q = q.value; renderPaperList(); });
  pk.addEventListener('change', (e) => { const sel = e.target.closest('[data-pk-draft]'); if (!sel || !sel.value) return; const d = (state.pk.drafts || []).find(r => r.id === sel.value); if (d) openSelected(d); });
}
async function loadPapers() {
  const P = state.pk;
  if (P.papers) return P.papers;
  try { const raw = sessionStorage.getItem(PAPERS_CACHE_KEY); if (raw) { const c = JSON.parse(raw); if (c && Date.now() - c.at < PAPERS_CACHE_MS && Array.isArray(c.rows)) { P.papers = c.rows; return P.papers; } } } catch (e) {}
  const snap = await db().collection('items').where('type', '==', 'paper').get();
  const rows = [];
  snap.forEach(d => {
    const x = d.data(); const lib = (x.meta && x.meta.library) || {};
    if (!lib.is_library_entry) return;
    const authors = Array.isArray(lib.authors) ? lib.authors : [];
    const fam = (a) => (a && (a.family || a.last || a.name)) || '';
    rows.push({ id: d.id, title: x.title || '(untitled)', year: lib.year || '', journal: lib.journal_iso || lib.journal || '', first: fam(authors[0]), second: fam(authors[1]), nAuthors: authors.length,
      pdf: lib.pdf && lib.pdf.storage_path ? lib.pdf.storage_path : '', hay: [x.title, ...authors.map(fam), lib.year, lib.journal, lib.doi].filter(Boolean).join(' ').toLowerCase(), added: lib.date_added || x.updated_at || '' });
  });
  rows.sort((a, b) => String(b.added).localeCompare(String(a.added)));
  P.papers = rows;
  try { sessionStorage.setItem(PAPERS_CACHE_KEY, JSON.stringify({ at: Date.now(), rows })); } catch (e) {}
  return rows;
}
function renderPaperList() {
  const pk = $('nbb-picker'); const list = pk.querySelector('[data-pk-list]'); if (!list || !state.pk) return;
  const q = (state.pk.q || '').trim().toLowerCase(); const terms = q.split(/\s+/).filter(Boolean);
  const rows = (state.pk.papers || []).filter(r => terms.every(t => r.hay.includes(t))).slice(0, 80);
  if (!rows.length) { list.innerHTML = `<div class="nbb-pk-status">${state.pk.papers?.length ? 'No paper matches.' : 'The library is empty.'}</div>`; return; }
  list.innerHTML = rows.map(r => `<button type="button" class="nbb-pk-row${r.pdf ? '' : ' nbb-pk-row-nopdf'}" data-pk-open="${esc(r.id)}">
      <div class="nbb-pk-row-title">${esc(r.title)}</div>
      <div class="nbb-pk-row-meta">${esc(citeFor(r))}${r.journal ? ' · ' + esc(r.journal) : ''}${r.pdf ? '' : ' · no PDF (figures & highlights only)'}</div></button>`).join('');
}
function citeFor(r, page) {
  let who = r.first || 'Unknown';
  if (r.nAuthors === 2 && r.second) who = `${r.first} & ${r.second}`; else if (r.nAuthors > 2) who = `${r.first} et al.`;
  return `${who}${r.year ? ', ' + r.year : ''}${page ? ', p. ' + page : ''}`;
}
async function openPaper(row) {
  const P = state.pk;
  P.paper = row; P.tab = row.pdf ? 'pages' : 'figs'; P.figs = null; P.hls = null;
  renderPicker();
  loadAnnotations(row.id).then(() => { if (state.pk && state.pk.paper === row) renderPicker(); }).catch(e => console.warn('[notebook] annotations', e));
}
async function loadAnnotations(paperId) {
  const P = state.pk;
  const col = db().collection('papers').doc(paperId).collection('annotations');
  const [lab, mine] = await Promise.all([col.where('visibility', '==', 'lab').get(), col.where('creator.uid', '==', state.uid).where('visibility', '==', 'private').get()]);
  const seen = new Set(); const all = [];
  [lab, mine].forEach(s => s.forEach(d => { if (seen.has(d.id)) return; seen.add(d.id); all.push({ id: d.id, ...d.data() }); }));
  const quoteOf = (a) => { const pg = a.target && Array.isArray(a.target.pages) ? a.target.pages : []; for (const p of pg) { const q = p && p.selectors && p.selectors.textQuote && p.selectors.textQuote.exact; if (q) return String(q); } return ''; };
  const pageOf = (a) => { const pg = a.target && Array.isArray(a.target.pages) ? a.target.pages : []; return pg[0] && pg[0].page || 0; };
  P.figs = all.filter(a => a.kind === 'figure' && a.image && a.image.download_url).map(a => ({ id: a.id, name: a.name || 'Figure', url: a.image.download_url, thumb: a.snip_data_uri || '', page: pageOf(a), by: (a.creator && a.creator.displayName) || '' }));
  P.hls = all.filter(a => a.kind !== 'figure' && a.kind !== 'equation' && quoteOf(a)).map(a => ({ id: a.id, quote: quoteOf(a), page: pageOf(a), color: a.color_id || 'yellow', comment: a.comment || '', mine: a.creator && a.creator.uid === state.uid }));
  P.figs.sort((a, b) => (a.page || 0) - (b.page || 0)); P.hls.sort((a, b) => (a.page || 0) - (b.page || 0));
}
const HL_HEX = { yellow: '#fde047', green: '#86efac', red: '#fca5a5', blue: '#93c5fd', purple: '#d8b4fe', orange: '#fdba74' };
function renderFigs() {
  const body = $('nbb-picker').querySelector('[data-pk-body]'); const P = state.pk;
  if (!P.figs) { body.innerHTML = '<div class="nbb-pk-status">Loading…</div>'; return; }
  if (!P.figs.length) { body.innerHTML = '<div class="nbb-pk-status">No figures have been snipped from this paper yet. Use ' + ICON.svg('document-text') + ' Pages to snip one.</div>'; return; }
  body.innerHTML = P.figs.map(f => `<button type="button" class="nbb-fig" data-pk-fig="${esc(f.id)}"><img src="${esc(f.thumb || f.url)}" alt=""><span><div class="nbb-fig-name">${esc(f.name)}</div><div class="nbb-fig-meta">${f.paper ? esc(citeFor(f.paper)) + ' · ' : ''}${f.page ? 'p. ' + f.page : ''}${f.by ? ' · snipped by ' + esc(f.by) : ''}</div></span></button>`).join('');
}
function renderHls() {
  const body = $('nbb-picker').querySelector('[data-pk-body]'); const P = state.pk;
  if (!P.hls) { body.innerHTML = '<div class="nbb-pk-status">Loading…</div>'; return; }
  if (!P.hls.length) { body.innerHTML = '<div class="nbb-pk-status">No highlights on this paper yet. Highlight passages in the paper reader, or drag over text on ' + ICON.svg('document-text') + ' Pages.</div>'; return; }
  body.innerHTML = P.hls.map(h => `<button type="button" class="nbb-hl" data-pk-hl="${esc(h.id)}" style="border-left-color:${HL_HEX[h.color] || HL_HEX.yellow}"><div class="nbb-hl-quote">${esc(h.quote)}</div><div class="nbb-hl-meta">${h.paper ? esc(citeFor(h.paper)) + ' · ' : ''}${h.page ? 'p. ' + h.page : ''}${h.comment ? ' · ' + esc(h.comment.slice(0, 80)) : ''}${h.mine ? '' : ' · lab'}</div></button>`).join('');
}
async function addExistingFigure(id) {
  const P = state.pk; const f = (P.figs || []).find(x => x.id === id); if (!f || !state.inst) return;
  busy(true);
  try {
    const ar = await new Promise(res => { const im = new Image(); im.onload = () => res(im.naturalWidth / Math.max(1, im.naturalHeight)); im.onerror = () => res(1.6); im.src = f.url; });
    /* V3.841 — a Figure card (above the ink: movable, resizable, connectable) with the citation and a reader link */
    const src = f.paper || P.paper; const cite = citeFor(src, f.page);
    await state.inst.addWidget({ kind: 'figure', title: f.name || '', w: Math.max(0.24, Math.min(0.6, 0.42 * Math.sqrt(ar / 1.6))), data: { cells: [{ url: f.url, storagePath: f.storagePath || '', hash: '', caption: cite }], paperId: src.id, page: f.page || 0, annId: f.id }, text: `${f.name || 'Figure'} — ${cite}` });
  } finally { busy(false); }
}
async function addHighlight(id) {
  const P = state.pk; const h = (P.hls || []).find(x => x.id === id); if (!h || !state.inst) return;
  const src = h.paper || P.paper;
  if (window.CANVAS_PAPER_READER) await CANVAS_PAPER_READER.addQuoteCard({ paperId: src.id, annId: h.id, quote: h.quote, cite: citeFor(src, h.page), page: h.page || 0, colorId: h.color });   /* V3.859 */
}
/* ─── V3.841 "Selected for a paper": every highlight / figure cited in one of MY drafts, across the library ─── */
function paperRow(id, x) {
  const lib = (x.meta && x.meta.library) || {}; const authors = Array.isArray(lib.authors) ? lib.authors : []; const fam = (a) => (a && (a.family || a.last || a.name)) || '';
  return { id, title: x.title || '(untitled)', year: lib.year || '', journal: lib.journal_iso || lib.journal || '', first: fam(authors[0]), second: fam(authors[1]), nAuthors: authors.length, pdf: lib.pdf && lib.pdf.storage_path ? lib.pdf.storage_path : '' };
}
async function loadMyDrafts() {
  const P = state.pk; if (P.drafts) return P.drafts;
  const snap = await db().collection('papers').where('authorUids', 'array-contains', state.uid).get();
  const rows = []; snap.forEach(d => { const x = d.data() || {}; if (x.is_library_entry) return; rows.push({ id: d.id, title: x.title || '(untitled)', type: x.paper_type || 'paper', updated: x.updated_at || x.updatedAt || '' }); });
  rows.sort((a, b) => String(b.updated).localeCompare(String(a.updated)));
  P.drafts = rows; return rows;
}
async function loadSelectedFor(draftId) {
  const col = db().collection('items');
  const [a, b] = await Promise.all([col.where('meta.library.cited_in_drafts', 'array-contains', draftId).get(), col.where('meta.library.linked_drafts', 'array-contains', draftId).get()]);
  const rows = new Map(); [a, b].forEach(sn => sn.forEach(d => { if (!rows.has(d.id)) rows.set(d.id, paperRow(d.id, d.data() || {})); }));
  const figs = [], hls = [];
  const quoteOf = (an) => { const pg = an.target && Array.isArray(an.target.pages) ? an.target.pages : []; for (const pp of pg) { const q = pp && pp.selectors && pp.selectors.textQuote && pp.selectors.textQuote.exact; if (q) return String(q); } return ''; };
  const pageOf = (an) => { const pg = an.target && Array.isArray(an.target.pages) ? an.target.pages : []; return pg[0] && pg[0].page || 0; };
  await Promise.all([...rows.values()].slice(0, 60).map(async row => {
    const ann = db().collection('papers').doc(row.id).collection('annotations');
    let lab, mine;
    try { [lab, mine] = await Promise.all([ann.where('visibility', '==', 'lab').where('cite_in_drafts', 'array-contains', draftId).get(), ann.where('creator.uid', '==', state.uid).where('visibility', '==', 'private').where('cite_in_drafts', 'array-contains', draftId).get()]); }
    catch (e) { console.warn('[notebook] selected annotations', row.id, e); return; }
    const seen = new Set();
    [lab, mine].forEach(sn => sn.forEach(d => {
      if (seen.has(d.id)) return; seen.add(d.id); const an = Object.assign({ id: d.id }, d.data());
      if (an.kind === 'figure' && an.image && an.image.download_url) figs.push({ id: an.id, name: an.name || 'Figure', url: an.image.download_url, storagePath: an.image.storage_path || '', thumb: an.snip_data_uri || '', page: pageOf(an), by: (an.creator && an.creator.displayName) || '', paper: row });
      else if (an.kind !== 'figure' && an.kind !== 'equation' && quoteOf(an)) hls.push({ id: an.id, quote: quoteOf(an), page: pageOf(an), color: an.color_id || 'yellow', comment: an.comment || '', mine: an.creator && an.creator.uid === state.uid, paper: row });
    }));
  }));
  const byPaper = (u, v) => (u.paper.title || '').localeCompare(v.paper.title || '') || (u.page || 0) - (v.page || 0);
  figs.sort(byPaper); hls.sort(byPaper);
  return { figs, hls, papers: rows.size };
}
async function openSelected(draft) {
  const P = state.pk; if (!draft) return;
  destroyViewer();
  P.paper = { id: '__selected__', title: `Selected for: ${draft.title}`, selected: true, draftId: draft.id, first: '', nAuthors: 0, year: '', pdf: '' };
  P.tab = 'figs'; P.figs = null; P.hls = null; renderPicker();
  const me = P.paper;
  loadSelectedFor(draft.id).then(r => { if (state.pk && state.pk.paper === me) { P.figs = r.figs; P.hls = r.hls; P.selPapers = r.papers; renderPicker(); } })
    .catch(e => { console.warn('[notebook] selected for', e); if (state.pk && state.pk.paper === me) { P.figs = []; P.hls = []; renderPicker(); } });
}
function busy(on) {
  const body = $('nbb-picker').querySelector('[data-pk-body]'); if (!body) return;
  let b = body.querySelector('.nbb-pk-busy');
  if (on) { if (!b) { b = document.createElement('div'); b.className = 'nbb-pk-busy'; b.textContent = 'Adding to the sheet…'; body.appendChild(b); } b.hidden = false; }
  else if (b) b.hidden = true;
}
function pdfUrlFor(path) { return firebase.storage().ref().child(path).getDownloadURL().then(u => isLocalDev() ? '/api/library/pdf-proxy?url=' + encodeURIComponent(u) : u); }
async function mountPdfPane() {
  const P = state.pk; const body = $('nbb-picker').querySelector('[data-pk-body]');
  if (!P.paper.pdf) { body.innerHTML = '<div class="nbb-pk-status">This paper has no PDF in the library.</div>'; return; }
  if (!window.PDF_VIEWER?.create) { body.innerHTML = '<div class="nbb-pk-status nbb-err">The PDF viewer did not load.</div>'; return; }
  const pane = document.createElement('div'); pane.className = 'nbb-pdf'; body.appendChild(pane);
  const status = document.createElement('div'); status.className = 'nbb-pk-status'; status.textContent = 'Opening the PDF…'; pane.appendChild(status);
  let url;
  try { url = await pdfUrlFor(P.paper.pdf); } catch (e) { status.textContent = 'Could not fetch the PDF: ' + (e.message || e); status.classList.add('nbb-err'); return; }
  if (!state.pk || state.pk.paper !== P.paper || state.pk.tab !== 'pages') return;
  try {
    status.remove();
    P.viewer = await window.PDF_VIEWER.create(pane, url, { fitToContainer: true, disableRange: true, disableStream: true, onPageReady: (p, node) => { if (state.pk && state.pk.viewer === P.viewer) addHotspots(p, node); } });
    wireMarquee(pane);
  } catch (e) { pane.innerHTML = `<div class="nbb-pk-status nbb-err">The PDF could not be opened: ${esc(e.message || e)}</div>`; }
}
function destroyViewer() { const P = state.pk; if (!P) return; if (P.viewer) { try { P.viewer.destroy(); } catch (e) {} P.viewer = null; } P.mq = null; }
function addHotspots(pageNum, node) {
  const v = state.pk?.viewer; if (!v || !node?.wrap) return;
  let regions = []; try { regions = v.getFigureRegions(pageNum) || []; } catch (e) { regions = []; }
  let layer = node.wrap.querySelector('.nbb-hs-layer');
  if (!regions.length) { if (layer) layer.remove(); return; }
  if (!layer) { layer = document.createElement('div'); layer.className = 'nbb-hs-layer'; node.wrap.appendChild(layer); }
  layer.innerHTML = '';
  regions.forEach(r => {
    const hs = document.createElement('div'); hs.className = 'nbb-hs';
    hs.style.left = r.x + 'px'; hs.style.top = r.y + 'px'; hs.style.width = r.width + 'px'; hs.style.height = r.height + 'px';
    const m = (r.label || '').match(/^\s*((?:extended\s+data\s+|supp(?:lementary)?\.?\s*)?(?:fig(?:ure)?|table|scheme)\.?\s*S?\d+)/i);
    const short = m ? m[1].replace(/\s+/g, ' ').trim() : 'Figure';
    hs.title = (r.label ? r.label + '\n' : '') + 'Click to add this to the sheet';
    const badge = document.createElement('span'); badge.className = 'nbb-hs-badge'; badge.textContent = '＋ ' + short; hs.appendChild(badge);
    let down = null;
    hs.addEventListener('pointerdown', (e) => { down = { x: e.clientX, y: e.clientY }; e.stopPropagation(); });
    hs.addEventListener('click', (e) => { const d = down; down = null; if (!d || Math.hypot(e.clientX - d.x, e.clientY - d.y) > 6) return; e.preventDefault(); e.stopPropagation(); snipAndAdd(pageNum, { x: r.x, y: r.y, width: r.width, height: r.height }, short); });
    layer.appendChild(hs);
  });
}
function wireMarquee(pane) {
  let d = null;
  const clearMq = () => { pane.querySelectorAll('.nbb-mq, .nbb-mq-acts').forEach(n => n.remove()); if (state.pk) state.pk.mq = null; };
  pane.addEventListener('pointerdown', (e) => {
    if (e.target.closest('.nbb-mq-acts') || e.target.closest('.nbb-hs')) return;
    const wrap = e.target.closest('.pv-page-wrap'); clearMq(); if (!wrap) return;
    const pageNum = Number(wrap.dataset.page || wrap.dataset.pageNum || 0) || pageNumOf(wrap);
    const r = wrap.getBoundingClientRect();
    d = { wrap, pageNum, x0: e.clientX - r.left, y0: e.clientY - r.top, box: null, id: e.pointerId };
    e.preventDefault(); try { pane.setPointerCapture(e.pointerId); } catch (err) {}
  });
  pane.addEventListener('pointermove', (e) => {
    if (!d) return;
    const r = d.wrap.getBoundingClientRect();
    const x1 = Math.max(0, Math.min(r.width, e.clientX - r.left)), y1 = Math.max(0, Math.min(r.height, e.clientY - r.top));
    const x = Math.min(d.x0, x1), y = Math.min(d.y0, y1), w = Math.abs(x1 - d.x0), h = Math.abs(y1 - d.y0);
    if (!d.box) { if (w < 6 && h < 6) return; d.box = document.createElement('div'); d.box.className = 'nbb-mq'; d.wrap.appendChild(d.box); }
    Object.assign(d.box.style, { left: x + 'px', top: y + 'px', width: w + 'px', height: h + 'px' });
    d.rect = { x, y, width: w, height: h };
  });
  const up = (e) => {
    if (!d) return;
    const cur = d; d = null;
    try { pane.releasePointerCapture(cur.id); } catch (err) {}
    if (!cur.box || !cur.rect || cur.rect.width < 12 || cur.rect.height < 12) { clearMq(); return; }
    state.pk.mq = { pageNum: cur.pageNum, rect: cur.rect, wrap: cur.wrap };
    const acts = document.createElement('div'); acts.className = 'nbb-mq-acts';
    const below = cur.rect.y + cur.rect.height + 6; const wrapH = cur.wrap.clientHeight;
    acts.style.left = Math.max(0, cur.rect.x) + 'px'; acts.style.top = (below + 40 < wrapH ? below : Math.max(0, cur.rect.y - 40)) + 'px';
    acts.innerHTML = `<button type="button" class="btn btn-small" data-mq="fig">${ICON.svg('photo')} Add as figure</button><button type="button" class="btn btn-small" data-mq="text">𝑇 Add as text</button><button type="button" class="btn btn-small btn-ghost" data-mq="x" title="Cancel">✕</button>`;
    acts.addEventListener('click', async (ev) => {
      const b = ev.target.closest('[data-mq]'); if (!b) return; ev.stopPropagation();
      const mq = state.pk?.mq; if (!mq) { clearMq(); return; }
      if (b.dataset.mq === 'fig') await snipAndAdd(mq.pageNum, mq.rect, ''); else if (b.dataset.mq === 'text') await textAndAdd(mq.pageNum, mq.rect);
      clearMq();
    });
    cur.wrap.appendChild(acts);
  };
  pane.addEventListener('pointerup', up); pane.addEventListener('pointercancel', up);
}
function pageNumOf(wrap) { const v = state.pk?.viewer; if (!v) return 1; for (let p = 1; p <= v.numPages; p++) { const n = v.getPageNode(p); if (n && n.wrap === wrap) return p; } return 1; }
async function snipAndAdd(pageNum, rect, label) {
  const P = state.pk; const v = P?.viewer; if (!v || !state.inst || !state.doc) return;
  busy(true);
  try {
    const doc = v.getPdfDocument?.(); if (!doc) throw new Error('PDF document not ready');
    const z = v.zoom || 1;
    const nat = { x: rect.x / z, y: rect.y / z, w: rect.width / z, h: rect.height / z };
    const pad = 4;
    const page = await doc.getPage(pageNum);
    let s = Math.max(1.5, Math.min(4, 1600 / Math.max(60, nat.w)));
    const vp1 = page.getViewport({ scale: 1 });
    s = Math.min(s, 4096 / Math.max(vp1.width, vp1.height));
    const vp = page.getViewport({ scale: s });
    const full = document.createElement('canvas'); full.width = Math.ceil(vp.width); full.height = Math.ceil(vp.height);
    const fctx = full.getContext('2d'); fctx.fillStyle = '#fff'; fctx.fillRect(0, 0, full.width, full.height);
    await page.render({ canvasContext: fctx, viewport: vp }).promise;
    const sx = Math.max(0, (nat.x - pad) * s), sy = Math.max(0, (nat.y - pad) * s);
    const sw = Math.min(full.width - sx, (nat.w + 2 * pad) * s), sh = Math.min(full.height - sy, (nat.h + 2 * pad) * s);
    if (sw < 4 || sh < 4) throw new Error('region too small');
    const crop = document.createElement('canvas'); crop.width = Math.round(sw); crop.height = Math.round(sh);
    const cctx = crop.getContext('2d'); cctx.fillStyle = '#fff'; cctx.fillRect(0, 0, crop.width, crop.height); cctx.drawImage(full, sx, sy, sw, sh, 0, 0, crop.width, crop.height);
    const [medium, fullBlob] = await Promise.all([resizeToWebp(crop, SIZES.medium.max, SIZES.medium.q), resizeToWebp(crop, SIZES.full.max, SIZES.full.q)]);
    if (!medium || !fullBlob) throw new Error('image encode failed');
    const itemId = newId('i');
    const base = `notebook-boards/${state.uid}/${state.doc.boardId}/items/${itemId}`;
    const ref = firebase.storage().ref();
    const put = async (name, blob) => { const c = ref.child(`${base}/${name}.webp`); await c.put(blob, { contentType: 'image/webp' }); return c.getDownloadURL(); };
    const url = await put('medium', medium); const fullUrl = await put('full', fullBlob);
    await state.inst.addImageItem({ itemId, url, fullUrl, storagePath: base, ar: crop.width / Math.max(1, crop.height), src: 'paper', srcLabel: `${label || 'Snip'} — ${citeFor(P.paper, pageNum)}`, paperId: P.paper.id, page: pageNum });
  } catch (e) { console.warn('[notebook] snip failed', e); toast('error', 'Could not add that region: ' + (e && e.message ? e.message : e)); }
  finally { busy(false); }
}
async function textAndAdd(pageNum, rect) {
  const P = state.pk; const v = P?.viewer; if (!v || !state.inst) return;
  const node = v.getPageNode(pageNum); const items = v.getTextItems(pageNum) || [];
  const k = (v.zoom || 1) / ((node && node.itemsZoom) || v.zoom || 1);
  const inside = items.filter(x => { const cx = (x.x + x.width / 2) * k, cy = (x.y + x.height / 2) * k; return cx >= rect.x && cx <= rect.x + rect.width && cy >= rect.y && cy <= rect.y + rect.height; });
  const text = inside.map(x => x.text).join(' ').replace(/-\s+(?=[a-z])/g, '').replace(/\s+/g, ' ').trim();
  if (!text) { toast('info', 'No text in that region — try "Add as figure".'); return; }
  if (window.CANVAS_PAPER_READER) await CANVAS_PAPER_READER.addQuoteCard({ paperId: P.paper.id, quote: text, cite: citeFor(P.paper, pageNum), page: pageNum });   /* V3.859 */
}
function resizeToWebp(srcCanvas, max, q) {
  return new Promise((resolve) => {
    const sw = srcCanvas.width, sh = srcCanvas.height; const k = sw > max ? max / sw : 1;
    const c = document.createElement('canvas'); c.width = Math.max(1, Math.round(sw * k)); c.height = Math.max(1, Math.round(sh * k));
    const ctx = c.getContext('2d'); ctx.fillStyle = '#fff'; ctx.fillRect(0, 0, c.width, c.height); ctx.drawImage(srcCanvas, 0, 0, c.width, c.height);
    c.toBlob(b => resolve(b), 'image/webp', q);
  });
}

/* ─── go ─────────────────────────────────────────────────────────── */
if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', boot); else boot();

window.NOTEBOOK_CANVAS = { _state: state, openEntry, openInsert, togglePicker, computeMirrors, widgetToBlock, sanitizeHtml, registerKinds };
})();
