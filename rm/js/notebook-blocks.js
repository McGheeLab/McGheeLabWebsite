/* ================================================================
   notebook-blocks.js — V3.830 — the block notebook (rm/pages/notebook.html)
   ================================================================
   An entry is a stack of collapsible BLOCKS instead of one rich-text body:
     note       — typed notes (contentEditable, sanitized allowlist, pasted
                  photos upload to notebook-figures/{uid}/ like the classic)
     calc       — a calculator: a protocol `formula` block authored inline or
                  copied from a protocol, rendered by the real ProtocolWidgets
     protocol   — a protocol followed: the V3.506 live run document (document
                  / cheat view, Finalize → immutable record, Reopen, Unload)
     whiteboard — a personal whiteboard (the class engine, hosted by
                  /rm/pages/notebook-board.html in an iframe per block)
     figure     — a photo / image with a caption
     checklist  — tick boxes

   DATA — the same documents as the classic editor:
     userData/{uid}/notebook/{entryId}   entry  (+ blocks[], schema_version 2)
     userData/{uid}/notebook/_index      { entries: [notebookIndexRow] }
   Mirrors are kept on every save so readers that never learned about
   blocks keep working: body_html / body_text (PMR week view, rail excerpt,
   the classic editor) and protocol_run (first protocol block). An entry
   with no blocks[] is migrated IN MEMORY on open and only written back when
   the person edits it. Index rows are written in a transaction (the
   classic page's whole-array rewrite raced My Week's transactional rows).

   No browser popups anywhere: inline forms, two-tap deletes, toasts.
   ================================================================ */
(function () {
'use strict';

const SAVE_MS = 500;
const SUPPRESS_MS = 2500;
const state = {
  user: null, uid: null, isAdmin: false,
  index: { entries: [] }, doc: null, docId: null,
  saveTimer: null, pending: false, suppressUntil: 0, unsub: null,
  q: '', railOpen: false, addOpen: false, newOpen: false,
  runs: {},            // blockId → { ctx, unlisten, tree, cheat }
  protoLive: null,     // the ONE protocol block whose widgets are live
  protocolsList: null, depsPromise: null, calcDepsPromise: null
};

/* ─── small helpers ─────────────────────────────────────────────── */
function $(id) { return document.getElementById(id); }
function esc(s) { return (s ?? '').toString().replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#039;' }[c])); }
function isoNow() { return new Date().toISOString(); }
function todayStr() { const d = new Date(); return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`; }
function newId(prefix) { return prefix + Date.now().toString(36) + Math.random().toString(36).slice(2, 6); }
function slugify(s, n) { return String(s || '').toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').split('-').filter(Boolean).slice(0, n || 4).join('-'); }
function toast(kind, msg) { if (window.TOAST && TOAST[kind]) TOAST[kind](msg); else console.log('[notebook]', kind, msg); }
function plainText(html) { const w = document.createElement('div'); w.innerHTML = String(html || ''); return (w.textContent || '').replace(/\s+/g, ' ').trim(); }
function db() { return firebridge.db(); }
function entriesCol() { return db().collection('userData').doc(state.uid).collection('notebook'); }
function entryRef(id) { return entriesCol().doc(id); }
function indexRef() { return entriesCol().doc('_index'); }
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
function loadCssOnce(id, href) { if ($(id)) return; const l = document.createElement('link'); l.id = id; l.rel = 'stylesheet'; l.href = href; document.head.appendChild(l); }

/* ─── sanitizer (the classic editor's allowlist, minus its chips) ──── */
const ALLOWED_TAGS = { P: 1, BR: 1, DIV: 1, SPAN: 1, STRONG: 1, B: 1, EM: 1, I: 1, U: 1, S: 1, UL: 1, OL: 1, LI: 1, H1: 1, H2: 1, H3: 1, H4: 1, H5: 1, H6: 1, BLOCKQUOTE: 1, CODE: 1, PRE: 1, A: 1, IMG: 1, TABLE: 1, THEAD: 1, TBODY: 1, TR: 1, TD: 1, TH: 1, SUB: 1, SUP: 1 };
const ALLOWED_ATTRS = { A: ['href', 'title', 'target', 'rel'], IMG: ['src', 'alt', 'data-storage-path', 'data-hash'], TD: ['colspan', 'rowspan'], TH: ['colspan', 'rowspan'] };
function isSafeUrl(href) { const s = String(href || '').trim().toLowerCase(); if (!s) return false; if (s.startsWith('javascript:') || s.startsWith('vbscript:') || s.startsWith('data:')) return false; return true; }
function isSafeImg(src) { const s = String(src || '').trim(); return /^https:\/\/firebasestorage\.googleapis\.com\//.test(s) || /^https:\/\/[a-z0-9.-]*\.firebasestorage\.app\//.test(s); }
function sanitizeNode(node) {
  Array.from(node.childNodes).forEach(child => {
    if (child.nodeType === 3) return;
    if (child.nodeType !== 1) { child.remove(); return; }
    const tag = child.tagName;
    if (!ALLOWED_TAGS[tag]) {
      if (tag === 'SCRIPT' || tag === 'STYLE' || tag === 'IFRAME' || tag === 'OBJECT' || tag === 'EMBED') { child.remove(); return; }
      const frag = document.createDocumentFragment();
      while (child.firstChild) frag.appendChild(child.firstChild);
      child.replaceWith(frag); sanitizeNode(node); return;
    }
    Array.from(child.attributes).forEach(a => {
      const ok = (ALLOWED_ATTRS[tag] || []).includes(a.name);
      if (!ok) child.removeAttribute(a.name);
    });
    if (tag === 'A') { if (!isSafeUrl(child.getAttribute('href'))) child.removeAttribute('href'); child.setAttribute('rel', 'noopener'); }
    if (tag === 'IMG' && !isSafeImg(child.getAttribute('src'))) { child.remove(); return; }
    sanitizeNode(child);
  });
}
function sanitizeHtml(html) { const w = document.createElement('div'); w.innerHTML = String(html || ''); sanitizeNode(w); return w.innerHTML; }

/* ─── block types ───────────────────────────────────────────────── */
const BLOCK_TYPES = {
  note:       { label: 'Typed note',        icon: 'pencil',                  make: () => ({ html: '' }) },
  calc:       { label: 'Calculator',        icon: 'calculator',              make: () => ({ spec: newFormulaSpec(), inputs: {}, context: [], result: '' }) },
  protocol:   { label: 'Protocol followed', icon: 'clipboard-document-list', make: () => ({ run: null }) },
  whiteboard: { label: 'Whiteboard',        icon: 'pen-line',                make: () => ({ boardId: 'nb' + Date.now().toString(36) + Math.random().toString(36).slice(2, 6) + '_' + state.uid, size: 'm' }) },
  figure:     { label: 'Figure / photo',    icon: 'photo',                   make: () => ({ url: '', storage_path: '', hash: '', caption: '' }) },
  checklist:  { label: 'Checklist',         icon: 'check-circle',            make: () => ({ items: [] }) }
};
function newBlock(type, title, data) {
  const t = BLOCK_TYPES[type];
  return { id: newId('blk-'), type, title: title || '', collapsed: false, created_at: isoNow(), data: data || (t ? t.make() : {}) };
}
function newFormulaSpec() {
  return { id: newId('blk-'), kind: 'formula', status: 'draft', body: '',
    attrs: { label: 'Calculation', description: '', expression: 'm / v',
      variables: [{ name: 'm', label: 'Mass', default: 1, unit: 'g' }, { name: 'v', label: 'Volume', default: 10, unit: 'mL' }],
      output: { name: 'c', label: 'Concentration', unit: 'g/mL', decimals: 3 } } };
}
function normBlock(b) {
  if (!b || typeof b !== 'object' || !BLOCK_TYPES[b.type]) return null;
  const t = BLOCK_TYPES[b.type];
  return { id: typeof b.id === 'string' && b.id ? b.id : newId('blk-'), type: b.type, title: typeof b.title === 'string' ? b.title : '',
    collapsed: !!b.collapsed, created_at: b.created_at || isoNow(), data: Object.assign(t.make(), (b.data && typeof b.data === 'object') ? b.data : {}) };
}

/* An entry written by the classic editor (no blocks[]) becomes blocks in
   memory: nothing is written until the person edits it here. */
function ensureBlocks(doc) {
  if (Array.isArray(doc.blocks)) { doc.blocks = doc.blocks.map(normBlock).filter(Boolean); return doc; }
  const blocks = [];
  if (doc.plan && typeof notebookPlanHasContent === 'function' && notebookPlanHasContent(doc.plan)) {
    const p = doc.plan; const li = (lab, v) => v ? `<p><strong>${esc(lab)}:</strong> ${esc(Array.isArray(v) ? v.join(', ') : v)}</p>` : '';
    blocks.push(newBlock('note', 'Plan', { html: li('Hypothesis', p.hypothesis) + li('Independent variables', p.independent_vars) + li('Dependent variables', p.dependent_vars) + li('Controls', p.controls) + li('Success criteria', p.success_criteria) }));
  }
  if (String(doc.body_html || '').trim()) blocks.push(newBlock('note', '', { html: sanitizeHtml(doc.body_html) }));
  if (doc.protocol_run && doc.protocol_run.protocol_id) blocks.push(newBlock('protocol', doc.protocol_run.protocol_title || '', { run: doc.protocol_run }));
  if (Array.isArray(doc.observations) && doc.observations.length) {
    const rows = doc.observations.map(o => `<tr><td>${esc(String(o.at || '').slice(0, 16).replace('T', ' '))}</td><td>${esc(o.text || '')}</td><td>${esc([o.metric, o.value, o.unit].filter(x => x !== null && x !== undefined && x !== '').join(' '))}</td></tr>`).join('');
    blocks.push(newBlock('note', 'Observations', { html: `<table><thead><tr><th>When</th><th>Observation</th><th>Measure</th></tr></thead><tbody>${rows}</tbody></table>` }));
  }
  if (String(doc.summary || '').trim()) blocks.push(newBlock('note', 'Summary', { html: `<p>${esc(doc.summary)}</p>` }));
  if (!blocks.length) blocks.push(newBlock('note', '', { html: '' }));
  doc.blocks = blocks;
  doc._migrated = true;
  return doc;
}

/* The mirrors readers without blocks[] depend on (PMR week view shows
   body_html; the rail searches the excerpt; the classic editor shows the
   body and the protocol run). */
function computeMirrors(doc) {
  const parts = [];
  (doc.blocks || []).forEach(b => {
    const t = b.title ? `<h3>${esc(b.title)}</h3>` : '';
    switch (b.type) {
      case 'note': parts.push(t + (b.data.html || '')); break;
      case 'calc': parts.push(t + `<p class="nbk-mirror">${esc(b.data.spec?.attrs?.label || 'Calculator')}${b.data.result ? ': ' + esc(b.data.result) : ''}</p>`); break;
      case 'protocol': if (b.data.run) parts.push(t + `<p class="nbk-mirror">Protocol followed: ${esc(b.data.run.protocol_title || b.data.run.protocol_id)}${b.data.run.frozen ? ' (finalized)' : ''}</p>`); break;
      case 'whiteboard': parts.push(t + `<p class="nbk-mirror">Whiteboard${b.title ? '' : ' (drawings, voice notes, paper figures)'}</p>`); break;
      case 'figure': if (b.data.url) parts.push(t + `<figure><img src="${esc(b.data.url)}" alt="${esc(b.data.caption || '')}" data-storage-path="${esc(b.data.storage_path || '')}"><figcaption>${esc(b.data.caption || '')}</figcaption></figure>`); break;
      case 'checklist': { const it = b.data.items || []; parts.push(t + `<ul>${it.map(i => `<li>${i.done ? '☒' : '☐'} ${esc(i.text || '')}</li>`).join('')}</ul>`); break; }
    }
  });
  doc.body_html = parts.join('\n');
  doc.body_text = plainText(doc.body_html);
  const firstProto = (doc.blocks || []).find(b => b.type === 'protocol' && b.data.run);
  doc.protocol_run = firstProto ? firstProto.data.run : null;
  doc.protocol_refs = (doc.blocks || []).filter(b => b.type === 'protocol' && b.data.run).map(b => ({ id: b.data.run.protocol_id, title: b.data.run.protocol_title || b.data.run.protocol_id }));
  return doc;
}

/* ─── index (transactional) ───────────────────────────────────────── */
async function loadIndex() {
  try { const s = await indexRef().get(); const d = s.exists ? s.data() : null; state.index = { entries: Array.isArray(d?.entries) ? d.entries : [] }; }
  catch (e) { console.warn('[notebook] index load', e); state.index = { entries: [] }; }
}
function rowFor(doc) {
  const row = (typeof notebookIndexRow === 'function') ? notebookIndexRow(doc) : { id: doc.id, title: doc.title, date: doc.date, tags: doc.tags || [], updated_at: doc.updated_at };
  row.block_count = Array.isArray(doc.blocks) ? doc.blocks.length : 0;
  row.block_types = Array.isArray(doc.blocks) ? Array.from(new Set(doc.blocks.map(b => b.type))) : [];
  row.schema_version = 2;
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

/* ─── entry load / save ───────────────────────────────────────────── */
async function loadEntry(id) {
  const s = await entryRef(id).get();
  if (!s.exists) return null;
  const raw = Object.assign({ id }, s.data());
  const doc = (typeof notebookHydrate === 'function') ? notebookHydrate(raw) : raw;
  if (!Array.isArray(doc.tags)) doc.tags = [];
  return ensureBlocks(doc);
}
function scheduleSave() {
  if (!state.doc || state.canvasRO) return;
  state.pending = true;
  setStatus('Editing…');
  clearTimeout(state.saveTimer);
  state.saveTimer = setTimeout(saveEntry, SAVE_MS);
}
async function saveEntry() {
  const doc = state.doc;
  if (!doc) return;
  clearTimeout(state.saveTimer);
  doc.updated_at = isoNow();
  doc.schema_version = 2;
  doc.ownerUid = state.uid;
  computeMirrors(doc);
  const out = JSON.parse(JSON.stringify(doc, (k, v) => (k === '_migrated' || k === '_tmp' || v === undefined) ? undefined : v));
  delete out.id;
  out.updatedAt = firebase.firestore.FieldValue.serverTimestamp();
  state.suppressUntil = Date.now() + SUPPRESS_MS;
  try {
    await entryRef(doc.id).set(out, { merge: true });
    await upsertIndexRow(doc);
    state.pending = false;
    delete doc._migrated;
    setStatus('Saved ' + new Date().toLocaleTimeString(undefined, { hour: 'numeric', minute: '2-digit' }));
    renderRail();
    try { window.ActivitySignals?.recordWork?.({ source: 'rm-notebook', sourceRef: { kind: 'notebook', id: doc.id }, text: 'Notebook: ' + (doc.title || doc.id), categoryPath: ['research', 'notebook'] }); } catch (e) {}
  } catch (e) {
    console.warn('[notebook] save failed', e);
    setStatus('Not saved — ' + (e.message || e));
    toast('error', 'Could not save the entry: ' + (e.message || e));
  }
}
function setStatus(t) { const n = $('nbk-status'); if (n) n.textContent = t || ''; }

function attachLive(id) {
  detachLive();
  state.unsub = entryRef(id).onSnapshot(s => {
    if (!state.doc || state.docId !== id || !s.exists) return;
    if (Date.now() < state.suppressUntil || state.pending) return;
    const d = s.data();
    if (!d || d.updated_at === state.doc.updated_at) return;
    const focused = document.activeElement && $('nbk-editor')?.contains(document.activeElement);
    if (focused) return;   // never yank the cursor; the next change wins anyway
    const doc = (typeof notebookHydrate === 'function') ? notebookHydrate(Object.assign({ id }, d)) : Object.assign({ id }, d);
    state.doc = ensureBlocks(doc);
    renderEntry();
  }, err => console.warn('[notebook] live sync', err));
}
function detachLive() { if (state.unsub) { try { state.unsub(); } catch (e) {} state.unsub = null; } }

/* ─── boot ──────────────────────────────────────────────────────────── */
async function boot() {
  const content = $('nbk-content');
  if (typeof firebridge === 'undefined' || !firebridge.requireSignIn) { content.innerHTML = '<div class="nbk-gate">The sign-in bridge did not load.</div>'; return; }
  const gate = await firebridge.requireSignIn('The lab notebook is for lab members — sign in to open yours.');
  if (!gate.allowed) return;
  if (!firebridge.isLabMember()) { content.innerHTML = '<div class="nbk-gate">Your account is waiting for approval. The notebook opens once an admin promotes you to lab member.</div>'; return; }
  state.user = firebridge.getUser(); state.uid = state.user.uid; state.isAdmin = firebridge.isAdmin();
  content.className = '';
  content.innerHTML = `
    <div class="nbk-toolbar" id="nbk-toolbar"></div>
    <div class="nbk-newform" id="nbk-newform" hidden></div>
    <div class="nbk-layout" id="nbk-layout">
      <aside class="nbk-rail" id="nbk-rail"></aside>
      <main class="nbk-editor" id="nbk-editor"></main>
    </div>`;
  wireUploads();
  window.addEventListener('message', onBoardMessage);
  document.addEventListener('keydown', (e) => { if (e.key === 'Escape') { const f = document.querySelector('.nbk-block-full'); if (f) toggleFull(f.dataset.blockId); } });
  await loadIndex();
  renderToolbar(); renderRail();
  const want = new URLSearchParams(location.search).get('entry');
  const rows = sortedRows();
  const first = (want && rows.some(r => r.id === want)) ? want : (rows[0] ? rows[0].id : null);
  if (first) await openEntry(first); else renderEntry();
}

/* ─── toolbar + new entry ───────────────────────────────────────────── */
function renderToolbar() {
  const bar = $('nbk-toolbar');
  bar.innerHTML = `
    <button type="button" class="btn nbk-rail-toggle" data-act="rail">☰ Entries</button>
    <button type="button" class="btn btn-primary" data-act="new">＋ New entry</button>
    <div class="nbk-search"><input type="search" id="nbk-q" placeholder="Search entries…" value="${esc(state.q)}"></div>
    <span class="nbk-status" id="nbk-status"></span>`;
  bar.querySelector('[data-act="rail"]').addEventListener('click', () => { state.railOpen = !state.railOpen; $('nbk-layout').classList.toggle('nbk-rail-open', state.railOpen); });
  bar.querySelector('[data-act="new"]').addEventListener('click', () => { state.newOpen = !state.newOpen; renderNewForm(); });
  $('nbk-q').addEventListener('input', (e) => { state.q = e.target.value; renderRail(); });
  renderNewForm();
}
function renderNewForm() {
  const f = $('nbk-newform');
  f.hidden = !state.newOpen;
  if (!state.newOpen) { f.innerHTML = ''; return; }
  f.innerHTML = `<input type="text" class="nbk-new-title" placeholder="Entry title (e.g. Collagen gel stiffness series)" maxlength="140">
    <input type="date" class="nbk-new-date" value="${todayStr()}">
    <button type="button" class="btn btn-primary" data-act="create">Create</button>
    <button type="button" class="btn" data-act="cancel">Cancel</button>
    <span class="nbk-err" hidden></span>`;
  const title = f.querySelector('.nbk-new-title'), date = f.querySelector('.nbk-new-date'), err = f.querySelector('.nbk-err');
  const create = async () => {
    const t = title.value.trim(); const d = date.value || todayStr();
    if (!t) { err.textContent = 'Give the entry a title.'; err.hidden = false; title.focus(); return; }
    f.querySelector('[data-act="create"]').disabled = true;
    try { await createEntry(t, d); state.newOpen = false; renderNewForm(); }
    catch (e) { err.textContent = 'Could not create: ' + (e.message || e); err.hidden = false; f.querySelector('[data-act="create"]').disabled = false; }
  };
  f.querySelector('[data-act="create"]').addEventListener('click', create);
  f.querySelector('[data-act="cancel"]').addEventListener('click', () => { state.newOpen = false; renderNewForm(); });
  title.addEventListener('keydown', (e) => { if (e.key === 'Enter') { e.preventDefault(); create(); } });
  setTimeout(() => title.focus(), 30);
}
async function createEntry(title, date) {
  let id = 'nb-' + date + '-' + (slugify(title, 4) || 'entry');
  const ids = new Set(state.index.entries.map(r => r.id));
  if (ids.has(id)) { let n = 2; while (ids.has(id + '-' + n) && n < 99) n++; id = ids.has(id + '-' + n) ? id + '-' + Date.now().toString(36) : id + '-' + n; }
  const base = (typeof notebookEmptyEntry === 'function') ? notebookEmptyEntry() : {};
  const doc = Object.assign(base, { id, title, date, tags: [], status: 'open', phase: 'complete', created_at: isoNow(), updated_at: isoNow(), ownerUid: state.uid, schema_version: 2,
    blocks: [newBlock('note', '', { html: '' })] });
  detachLive();
  state.doc = doc; state.docId = id;
  await saveEntry();
  attachLive(id);
  history.replaceState(null, '', '?entry=' + encodeURIComponent(id));
  renderRail(); renderEntry();
  state.railOpen = false; $('nbk-layout').classList.remove('nbk-rail-open');
  toast('success', 'Entry created — add blocks below.');
}

/* ─── rail ──────────────────────────────────────────────────────────── */
function sortedRows() {
  return state.index.entries.filter(Boolean).slice().sort((a, b) => String(b.date || '').localeCompare(String(a.date || '')) || String(b.updated_at || '').localeCompare(String(a.updated_at || '')));
}
function renderRail() {
  const rail = $('nbk-rail');
  if (!rail) return;
  const q = state.q.trim().toLowerCase();
  const terms = q.split(/\s+/).filter(Boolean);
  const rows = sortedRows().filter(r => !terms.length || terms.every(t => [r.title, r.excerpt, (r.tags || []).join(' '), r.date].join(' ').toLowerCase().includes(t)));
  if (!rows.length) { rail.innerHTML = `<div class="nbk-rail-empty">${state.index.entries.length ? 'No entry matches.' : 'No entries yet — press ＋ New entry.'}</div>`; return; }
  let html = ''; let group = '';
  rows.forEach(r => {
    const d = String(r.date || ''); const g = d.slice(0, 7);
    if (g !== group) { group = g; const dt = new Date(d + 'T12:00:00'); html += `<div class="nbk-rail-group">${isNaN(dt) ? esc(g) : dt.toLocaleDateString(undefined, { month: 'long', year: 'numeric' })}</div>`; }
    const dt = new Date(d + 'T12:00:00');
    const types = (r.block_types || []).map(t => BLOCK_TYPES[t] ? ICON.svg(BLOCK_TYPES[t].icon) : '').join(' ');
    html += `<button type="button" class="nbk-row${r.id === state.docId ? ' nbk-sel' : ''}" data-id="${esc(r.id)}">
      <span class="nbk-row-day">${isNaN(dt) ? '' : dt.getDate()}<small>${isNaN(dt) ? '' : dt.toLocaleDateString(undefined, { weekday: 'short' })}</small></span>
      <span class="nbk-row-main"><div class="nbk-row-title">${esc(r.title || '(untitled)')}</div>
      <div class="nbk-row-meta">${types ? `<span>${types}</span>` : ''}${(r.tags || []).slice(0, 3).map(t => `<span class="nbk-chip">${esc(t)}</span>`).join('')}${r.run_frozen ? '<span class="nbk-chip">' + ICON.svg('lock-closed', { label: 'Finalized' }) + '</span>' : ''}</div></span>
    </button>`;
  });
  rail.innerHTML = html;
  if (!rail.dataset.wired) { rail.dataset.wired = '1'; rail.addEventListener('click', (e) => { const b = e.target.closest('.nbk-row'); if (b) openEntry(b.dataset.id); }); }
}

async function openEntry(id) {
  if (state.doc && state.pending) await saveEntry();
  unmountRuns();
  detachLive();
  state.doc = null; state.docId = id;
  $('nbk-editor').innerHTML = '<div class="nbk-loading">Opening…</div>';
  let doc = null;
  try { doc = await loadEntry(id); } catch (e) { console.warn('[notebook] load', e); }
  if (!doc) { $('nbk-editor').innerHTML = '<div class="nbk-empty">That entry could not be opened.</div>'; return; }
  if (state.docId !== id) return;
  state.doc = doc;
  /* V3.833 — an entry that lives on the canvas notebook is shown here
     read-only: its blocks[] are a mirror the canvas rewrites on every save */
  state.canvasRO = !!(doc.canvas_version >= 3);
  history.replaceState(null, '', '?entry=' + encodeURIComponent(id));
  window.LAB_NOTEBOOK_STATE = { docId: id };
  renderRail(); renderEntry();
  attachLive(id);
  state.railOpen = false; $('nbk-layout').classList.remove('nbk-rail-open');
}

/* ─── entry ─────────────────────────────────────────────────────────── */
function renderEntry() {
  const ed = $('nbk-editor');
  unmountRuns();
  const doc = state.doc;
  if (!doc) { ed.innerHTML = '<div class="nbk-empty">Pick an entry on the left, or press <b>＋ New entry</b>.</div>'; return; }
  ed.innerHTML = `
    <div class="nbk-entry-head" data-entry-id="${esc(doc.id)}">
      <input type="text" class="nbk-entry-title" id="nbk-title" value="${esc(doc.title)}" placeholder="Entry title" maxlength="140">
      <input type="date" class="nbk-entry-date" id="nbk-date" value="${esc(doc.date)}">
      <input type="text" class="nbk-entry-tags" id="nbk-tags" value="${esc((doc.tags || []).join(', '))}" placeholder="tags, comma separated">
      <div class="nbk-entry-acts">
        <button type="button" class="btn" data-act="collapse-all" title="Collapse or expand every block">⇅ Fold all</button>
        <a class="btn" href="/rm/pages/lab-notebook.html?entry=${encodeURIComponent(doc.id)}" title="Open this entry in the classic editor">Classic</a>
        <button type="button" class="btn btn-danger" data-act="delete" title="Delete this entry (two taps)">Delete</button>
      </div>
    </div>
    <div class="nbk-blocks" id="nbk-blocks"></div>
    <div class="nbk-addbar">
      <button type="button" class="btn btn-primary" data-act="add">＋ Add block</button>
      <div class="nbk-addmenu" id="nbk-addmenu" ${state.addOpen ? '' : 'hidden'}>
        ${Object.keys(BLOCK_TYPES).map(t => `<button type="button" class="btn" data-add="${t}">${ICON.svg(BLOCK_TYPES[t].icon)} ${esc(BLOCK_TYPES[t].label)}</button>`).join('')}
      </div>
    </div>`;
  if (state.canvasRO) {
    ed.classList.add('nbk-ro');
    ed.insertAdjacentHTML('afterbegin', `<div class="nbk-canvas-ro">This entry lives on the <a href="/rm/pages/notebook.html?entry=${encodeURIComponent(doc.id)}">canvas notebook</a> now. What you see here is a read-only mirror of its widgets.</div>`);
    ed.querySelectorAll('input, [contenteditable]').forEach(n => { if (n.type === 'checkbox') n.disabled = true; else n.readOnly = true; });
    const ab = ed.querySelector('.nbk-addbar'); if (ab) ab.hidden = true;
    const del = ed.querySelector('[data-act="delete"]'); if (del) del.hidden = true;
  }
  $('nbk-title').addEventListener('input', (e) => { doc.title = e.target.value; scheduleSave(); });
  $('nbk-date').addEventListener('change', (e) => { if (e.target.value) { doc.date = e.target.value; scheduleSave(); } });
  $('nbk-tags').addEventListener('change', (e) => { doc.tags = e.target.value.split(',').map(t => t.trim().toLowerCase().replace(/\s+/g, '-')).filter(Boolean); scheduleSave(); });
  ed.querySelector('[data-act="collapse-all"]').addEventListener('click', () => { const all = doc.blocks.every(b => b.collapsed); doc.blocks.forEach(b => { b.collapsed = !all; }); scheduleSave(); renderBlocks(); });
  ed.querySelector('[data-act="delete"]').addEventListener('click', (e) => { if (!armTwoTap(e.currentTarget, 'Really delete?')) return; deleteEntry(doc.id); });
  ed.querySelector('[data-act="add"]').addEventListener('click', () => { state.addOpen = !state.addOpen; $('nbk-addmenu').hidden = !state.addOpen; });
  $('nbk-addmenu').addEventListener('click', (e) => { const b = e.target.closest('[data-add]'); if (!b) return; addBlock(b.dataset.add); });
  renderBlocks();
}
async function deleteEntry(id) {
  unmountRuns(); detachLive();
  try {
    await entryRef(id).delete();
    await removeIndexRow(id);
    toast('success', 'Entry deleted.');
  } catch (e) { toast('error', 'Could not delete: ' + (e.message || e)); return; }
  state.doc = null; state.docId = null;
  renderRail();
  const rows = sortedRows();
  if (rows[0]) openEntry(rows[0].id); else { history.replaceState(null, '', location.pathname); renderEntry(); }
}
function addBlock(type) {
  const doc = state.doc; if (!doc || !BLOCK_TYPES[type]) return;
  const b = newBlock(type, '');
  doc.blocks.push(b);
  state.addOpen = false;
  scheduleSave();
  renderBlocks();
  const card = document.querySelector(`.nbk-block[data-block-id="${b.id}"]`);
  if (card) { card.scrollIntoView({ block: 'nearest', behavior: 'smooth' }); const f = card.querySelector('.nbk-note, .nbk-bh-title'); if (f && type !== 'whiteboard') setTimeout(() => f.focus(), 50); }
}

/* ─── blocks ────────────────────────────────────────────────────────── */
function blockSummary(b) {
  const d = b.data || {};
  switch (b.type) {
    case 'note': return plainText(d.html).slice(0, 90);
    case 'calc': return (d.spec?.attrs?.label || 'Calculation') + (d.result ? ' = ' + d.result : '');
    case 'protocol': return d.run ? (d.run.protocol_title || d.run.protocol_id) + (d.run.frozen ? ' · finalized' : ' · live') : 'no protocol loaded';
    case 'whiteboard': return 'drawings · voice · paper figures';
    case 'figure': return d.url ? (d.caption || 'image') : 'no image yet';
    case 'checklist': { const it = d.items || []; return it.length ? `${it.filter(i => i.done).length}/${it.length} done` : 'empty'; }
  }
  return '';
}
function renderBlocks() {
  const host = $('nbk-blocks');
  const doc = state.doc;
  if (!host || !doc) return;
  unmountRuns();
  host.innerHTML = '';
  if (!doc.blocks.length) { host.innerHTML = '<div class="nbk-empty">This entry has no blocks yet — press <b>＋ Add block</b>.</div>'; }
  doc.blocks.forEach((b, i) => host.appendChild(renderBlock(b, i)));
}
function renderBlock(b, i) {
  const doc = state.doc;
  const t = BLOCK_TYPES[b.type];
  const card = document.createElement('section');
  card.className = `nbk-block nbk-block-${b.type}${b.collapsed ? ' nbk-collapsed' : ''}`;
  card.dataset.blockId = b.id;
  card.innerHTML = `
    <header class="nbk-bh">
      <button type="button" class="nbk-bh-chev" data-b="toggle" title="${b.collapsed ? 'Expand' : 'Collapse'}">${b.collapsed ? '▸' : '▾'}</button>
      <span class="nbk-bh-glyph" title="${esc(t.label)}">${ICON.svg(t.icon)}</span>
      <input type="text" class="nbk-bh-title" value="${esc(b.title)}" placeholder="${esc(t.label)}" maxlength="120">
      <span class="nbk-rec-dot" data-rec-dot title="Recording"></span>
      <span class="nbk-bh-sum">${esc(blockSummary(b))}</span>
      <span class="nbk-bh-acts">
        ${b.type === 'whiteboard' ? '<button type="button" class="nbk-bh-act" data-b="full" title="Fill the screen (Esc to leave)">⛶</button>' : ''}
        <button type="button" class="nbk-bh-act" data-b="up" title="Move up" ${i === 0 ? 'disabled' : ''}>▲</button>
        <button type="button" class="nbk-bh-act" data-b="down" title="Move down" ${i === doc.blocks.length - 1 ? 'disabled' : ''}>▼</button>
        <button type="button" class="nbk-bh-act" data-b="del" title="Remove this block (two taps)">×</button>
      </span>
    </header>
    <div class="nbk-bb"></div>`;
  card.querySelector('.nbk-bh-title').addEventListener('input', (e) => { b.title = e.target.value; scheduleSave(); });
  card.querySelector('.nbk-bh').addEventListener('click', (e) => {
    const act = e.target.closest('[data-b]')?.dataset.b;
    if (!act) return;
    if (act === 'toggle') { b.collapsed = !b.collapsed; scheduleSave(); rerenderBlock(b); }
    else if (act === 'up' || act === 'down') { const k = doc.blocks.indexOf(b); const j = act === 'up' ? k - 1 : k + 1; if (j < 0 || j >= doc.blocks.length) return; doc.blocks.splice(k, 1); doc.blocks.splice(j, 0, b); scheduleSave(); renderBlocks(); }
    else if (act === 'del') { if (!armTwoTap(e.target.closest('[data-b]'), '✓')) return; removeBlock(b); }
    else if (act === 'full') toggleFull(b.id);
  });
  if (!b.collapsed) renderBlockBody(b, card.querySelector('.nbk-bb'));
  return card;
}
function rerenderBlock(b) {
  const old = document.querySelector(`.nbk-block[data-block-id="${b.id}"]`);
  if (!old) { renderBlocks(); return; }
  if (b.type === 'protocol') unmountRun(b.id);
  if (b.type === 'calc') unmountRun(b.id);
  const i = state.doc.blocks.indexOf(b);
  old.replaceWith(renderBlock(b, i));
}
function refreshSummary(b) { const n = document.querySelector(`.nbk-block[data-block-id="${b.id}"] .nbk-bh-sum`); if (n) n.textContent = blockSummary(b); }
function removeBlock(b) {
  const doc = state.doc;
  const k = doc.blocks.indexOf(b); if (k < 0) return;
  unmountRun(b.id);
  if (state.protoLive === b.id) state.protoLive = null;
  doc.blocks.splice(k, 1);
  scheduleSave(); renderBlocks();
  if (b.type === 'whiteboard') toast('info', 'Whiteboard block removed. Its drawings stay stored under your account.');
}
function toggleFull(blockId) {
  const card = document.querySelector(`.nbk-block[data-block-id="${blockId}"]`);
  if (!card) return;
  const on = !card.classList.contains('nbk-block-full');
  document.querySelectorAll('.nbk-block-full').forEach(n => n.classList.remove('nbk-block-full'));
  card.classList.toggle('nbk-block-full', on);
  document.body.classList.toggle('nbk-has-full', on);
  if (on) { const b = state.doc.blocks.find(x => x.id === blockId); if (b && b.collapsed) { b.collapsed = false; scheduleSave(); rerenderBlock(b); document.querySelector(`.nbk-block[data-block-id="${blockId}"]`)?.classList.add('nbk-block-full'); } }
}

function renderBlockBody(b, body) {
  switch (b.type) {
    case 'note': return renderNote(b, body);
    case 'calc': return renderCalc(b, body);
    case 'protocol': return renderProtocol(b, body);
    case 'whiteboard': return renderWhiteboard(b, body);
    case 'figure': return renderFigure(b, body);
    case 'checklist': return renderChecklist(b, body);
  }
}

/* ── note ── */
function renderNote(b, body) {
  body.innerHTML = `
    <div class="nbk-fmtbar">
      <button type="button" class="nbk-fmt" data-cmd="bold" title="Bold"><b>B</b></button>
      <button type="button" class="nbk-fmt" data-cmd="italic" title="Italic"><i>I</i></button>
      <button type="button" class="nbk-fmt" data-cmd="underline" title="Underline"><u>U</u></button>
      <button type="button" class="nbk-fmt" data-cmd="insertUnorderedList" title="Bulleted list">• list</button>
      <button type="button" class="nbk-fmt" data-cmd="insertOrderedList" title="Numbered list">1. list</button>
      <button type="button" class="nbk-fmt" data-block="h3" title="Heading">H</button>
      <button type="button" class="nbk-fmt" data-block="blockquote" title="Quote">❝</button>
      <button type="button" class="nbk-fmt" data-block="pre" title="Code / data">&lt;/&gt;</button>
      <button type="button" class="nbk-fmt" data-cmd="removeFormat" title="Clear formatting">⌫</button>
      <button type="button" class="nbk-fmt" data-photo="1" title="Insert a photo">${ICON.svg('camera')} Photo</button>
    </div>
    <div class="nbk-note" contenteditable="true" data-placeholder="Type your notes… paste a photo to add it.">${b.data.html || ''}</div>`;
  const ed = body.querySelector('.nbk-note');
  let t = null;
  const commit = () => { b.data.html = sanitizeHtml(ed.innerHTML); refreshSummary(b); scheduleSave(); };
  ed.addEventListener('input', () => { clearTimeout(t); t = setTimeout(commit, 250); });
  ed.addEventListener('blur', () => { clearTimeout(t); commit(); });
  ed.addEventListener('paste', (e) => onNotePaste(e, b, ed));
  ed.addEventListener('drop', (e) => { const f = e.dataTransfer?.files?.[0]; if (f && /^image\//.test(f.type)) { e.preventDefault(); insertPhoto(b, ed, f); } });
  body.querySelector('.nbk-fmtbar').addEventListener('mousedown', (e) => e.preventDefault());   // keep the selection
  body.querySelector('.nbk-fmtbar').addEventListener('click', (e) => {
    const btn = e.target.closest('button'); if (!btn) return;
    ed.focus();
    if (btn.dataset.cmd) document.execCommand(btn.dataset.cmd, false, null);
    else if (btn.dataset.block) { const cur = document.queryCommandValue('formatBlock'); document.execCommand('formatBlock', false, cur.toLowerCase() === btn.dataset.block ? 'p' : btn.dataset.block); }
    else if (btn.dataset.photo) { state._photoTarget = { b, ed }; $('nbk-file-input').click(); }
    clearTimeout(t); t = setTimeout(commit, 50);
  });
}
async function onNotePaste(e, b, ed) {
  const items = e.clipboardData?.items || [];
  for (const it of items) {
    if (it.kind === 'file' && /^image\//.test(it.type)) { e.preventDefault(); const f = it.getAsFile(); if (f) await insertPhoto(b, ed, f); return; }
  }
  /* plain text paste keeps the note clean */
  const text = e.clipboardData?.getData('text/plain');
  if (text) { e.preventDefault(); document.execCommand('insertText', false, text); }
}
async function insertPhoto(b, ed, file) {
  if (!window.NOTEBOOK_FIGURES) { toast('error', 'Uploads are not available on this page.'); return; }
  toast('info', 'Uploading photo…');
  try {
    const up = await window.NOTEBOOK_FIGURES.uploadImage(file);
    const img = `<img src="${esc(up.download_url)}" data-storage-path="${esc(up.storage_path)}" data-hash="${esc(up.hash)}" alt="">`;
    ed.focus();
    if (!document.execCommand('insertHTML', false, img + '<p></p>')) ed.insertAdjacentHTML('beforeend', img);
    if (!Array.isArray(state.doc.attachments)) state.doc.attachments = [];
    state.doc.attachments.push({ kind: 'image', storage_path: up.storage_path, hash: up.hash, mime: up.mime, size_bytes: up.size_bytes, caption: '', uploaded_at: up.uploaded_at, uploaded_by: up.uploaded_by });
    b.data.html = sanitizeHtml(ed.innerHTML); scheduleSave();
  } catch (e) { toast('error', 'Upload failed: ' + (e.message || e)); }
}
function wireUploads() {
  $('nbk-file-input').addEventListener('change', async (e) => {
    const f = e.target.files && e.target.files[0]; e.target.value = '';
    if (!f) return;
    const tgt = state._photoTarget; state._photoTarget = null;
    if (tgt && tgt.ed) await insertPhoto(tgt.b, tgt.ed, f);
    else if (tgt && tgt.figure) await setFigure(tgt.b, f);
  });
  $('nbk-camera-input').addEventListener('change', async (e) => {
    const f = e.target.files && e.target.files[0]; e.target.value = '';
    const tgt = state._photoTarget; state._photoTarget = null;
    if (f && tgt && tgt.figure) await setFigure(tgt.b, f);
  });
}

/* ── figure ── */
function renderFigure(b, body) {
  const d = b.data;
  if (!d.url) {
    body.innerHTML = `<div class="nbk-fig-drop" data-drop>Drop an image here, or
      <button type="button" class="btn" data-pick="file">${ICON.svg('folder')} Choose</button>
      <button type="button" class="btn" data-pick="camera">${ICON.svg('camera')} Camera</button></div>`;
    const drop = body.querySelector('[data-drop]');
    drop.addEventListener('click', (e) => { const p = e.target.closest('[data-pick]'); if (!p) return; state._photoTarget = { b, figure: true }; $(p.dataset.pick === 'camera' ? 'nbk-camera-input' : 'nbk-file-input').click(); });
    drop.addEventListener('dragover', (e) => { e.preventDefault(); drop.classList.add('nbk-over'); });
    drop.addEventListener('dragleave', () => drop.classList.remove('nbk-over'));
    drop.addEventListener('drop', (e) => { e.preventDefault(); drop.classList.remove('nbk-over'); const f = e.dataTransfer?.files?.[0]; if (f) setFigure(b, f); });
    return;
  }
  body.innerHTML = `<div class="nbk-fig"><a href="${esc(d.url)}" target="_blank" rel="noopener"><img src="${esc(d.url)}" alt="${esc(d.caption || '')}"></a>
    <input type="text" class="nbk-fig-cap" value="${esc(d.caption || '')}" placeholder="Caption…"></div>`;
  body.querySelector('.nbk-fig-cap').addEventListener('input', (e) => { d.caption = e.target.value; refreshSummary(b); scheduleSave(); });
}
async function setFigure(b, file) {
  if (!window.NOTEBOOK_FIGURES) { toast('error', 'Uploads are not available on this page.'); return; }
  toast('info', 'Uploading…');
  try {
    const up = await window.NOTEBOOK_FIGURES.uploadImage(file);
    b.data.url = up.download_url; b.data.storage_path = up.storage_path; b.data.hash = up.hash;
    if (!Array.isArray(state.doc.attachments)) state.doc.attachments = [];
    state.doc.attachments.push({ kind: 'image', storage_path: up.storage_path, hash: up.hash, mime: up.mime, size_bytes: up.size_bytes, caption: '', uploaded_at: up.uploaded_at, uploaded_by: up.uploaded_by });
    scheduleSave(); rerenderBlock(b);
  } catch (e) { toast('error', 'Upload failed: ' + (e.message || e)); }
}

/* ── checklist ── */
function renderChecklist(b, body) {
  const items = b.data.items = Array.isArray(b.data.items) ? b.data.items : [];
  const row = (it, k) => `<div class="nbk-ck-row${it.done ? ' nbk-done' : ''}" data-k="${k}">
      <input type="checkbox" ${it.done ? 'checked' : ''}><input type="text" value="${esc(it.text || '')}" placeholder="To do…"><button type="button" class="nbk-x" title="Remove">×</button></div>`;
  body.innerHTML = `<div class="nbk-ck">${items.map(row).join('')}</div><button type="button" class="btn" data-ck-add style="margin-top:6px">＋ item</button>`;
  const list = body.querySelector('.nbk-ck');
  list.addEventListener('change', (e) => { const r = e.target.closest('.nbk-ck-row'); if (!r) return; const it = items[+r.dataset.k]; if (!it) return; if (e.target.type === 'checkbox') { it.done = e.target.checked; r.classList.toggle('nbk-done', it.done); } refreshSummary(b); scheduleSave(); });
  list.addEventListener('input', (e) => { const r = e.target.closest('.nbk-ck-row'); if (!r || e.target.type !== 'text') return; const it = items[+r.dataset.k]; if (it) { it.text = e.target.value; scheduleSave(); } });
  list.addEventListener('keydown', (e) => { if (e.key === 'Enter' && e.target.type === 'text') { e.preventDefault(); const r = e.target.closest('.nbk-ck-row'); items.splice(+r.dataset.k + 1, 0, { text: '', done: false }); scheduleSave(); renderChecklist(b, body); body.querySelectorAll('.nbk-ck-row input[type=text]')[+r.dataset.k + 1]?.focus(); } });
  list.addEventListener('click', (e) => { const x = e.target.closest('.nbk-x'); if (!x) return; const r = x.closest('.nbk-ck-row'); items.splice(+r.dataset.k, 1); refreshSummary(b); scheduleSave(); renderChecklist(b, body); });
  body.querySelector('[data-ck-add]').addEventListener('click', () => { items.push({ text: '', done: false }); scheduleSave(); renderChecklist(b, body); const last = body.querySelectorAll('.nbk-ck-row input[type=text]'); last[last.length - 1]?.focus(); });
}

/* ── whiteboard ── */
function boardSrc(b) {
  const title = b.title || (state.doc?.title ? state.doc.title + ' — whiteboard' : 'Whiteboard');
  return `/rm/pages/notebook-board.html?board=${encodeURIComponent(b.data.boardId)}&owner=${encodeURIComponent(state.uid)}&title=${encodeURIComponent(title)}`;
}
function renderWhiteboard(b, body) {
  if (!b.data.boardId || !b.data.boardId.endsWith('_' + state.uid)) b.data.boardId = BLOCK_TYPES.whiteboard.make().boardId;
  const size = b.data.size || 'm';
  body.innerHTML = `<div class="nbk-wb-tools">
      <span>Pen to draw · two fingers to scroll · ${ICON.svg('microphone')} Record keeps your voice with the ink · ＋ From paper adds figures and passages</span>
      <span style="margin-left:auto;display:inline-flex;gap:4px">
        <button type="button" class="btn nbk-wb-size${size === 's' ? ' nbk-sel' : ''}" data-size="s" title="Short">S</button>
        <button type="button" class="btn nbk-wb-size${size === 'm' ? ' nbk-sel' : ''}" data-size="m" title="Medium">M</button>
        <button type="button" class="btn nbk-wb-size${size === 'l' ? ' nbk-sel' : ''}" data-size="l" title="Tall">L</button>
      </span></div>
    <div class="nbk-wb-frame nbk-wb-${size}"><iframe src="${boardSrc(b)}" allow="microphone; fullscreen" title="Whiteboard"></iframe></div>`;
  body.querySelector('.nbk-wb-tools').addEventListener('click', (e) => { const s = e.target.closest('[data-size]'); if (!s) return; b.data.size = s.dataset.size; scheduleSave(); const f = body.querySelector('.nbk-wb-frame'); f.className = 'nbk-wb-frame nbk-wb-' + b.data.size; body.querySelectorAll('[data-size]').forEach(x => x.classList.toggle('nbk-sel', x === s)); });
}
function onBoardMessage(e) {
  if (e.origin !== location.origin || !e.data || !e.data.type || !e.data.boardId) return;
  const doc = state.doc; if (!doc) return;
  const b = doc.blocks.find(x => x.type === 'whiteboard' && x.data.boardId === e.data.boardId);
  if (!b) return;
  if (e.data.type === 'nbb-state') { const dot = document.querySelector(`.nbk-block[data-block-id="${b.id}"] [data-rec-dot]`); if (dot) dot.classList.toggle('nbk-on', !!e.data.recording); }
}

/* ── calculator ── */
function ensureCalcDeps() {
  if (state.calcDepsPromise) return state.calcDepsPromise;
  loadCssOnce('nbk-protocol-doc-css', '/rm/css/protocol-doc.css');
  state.calcDepsPromise = loadScriptOnce('/rm/js/protocol-formulas.js', 'ProtocolFormulas')
    .then(() => loadScriptOnce('/rm/js/protocol-widgets.js', 'ProtocolWidgets'))
    .then(() => loadScriptOnce('/rm/js/protocol-doc-render.js', 'ProtocolDocRender'));
  return state.calcDepsPromise;
}
function renderCalc(b, body) {
  const d = b.data;
  if (!d.spec || d.spec.kind !== 'formula' && d.spec.kind !== 'calculator') d.spec = newFormulaSpec();
  if (!d.inputs || typeof d.inputs !== 'object') d.inputs = {};
  if (!Array.isArray(d.context)) d.context = [];
  body.innerHTML = `<div class="nbk-calc-host prd-doc"><div class="nbk-section-label">Loading calculator…</div></div>
    <details class="nbk-calc-edit"${d.spec.kind === 'formula' ? '' : ' hidden'}><summary>Edit the formula</summary><div class="nbk-calc-form" data-calc-form></div></details>
    <div class="nbk-calc-acts">
      <button type="button" class="btn" data-calc="from-protocol">${ICON.svg('clipboard-document-list')} Copy a calculator from a protocol…</button>
      <span class="nbk-calc-err" data-calc-err hidden></span>
    </div>
    <div class="nbk-inline-pick" data-calc-pick hidden></div>`;
  if (d.spec.kind === 'formula') renderCalcForm(b, body.querySelector('[data-calc-form]'));
  body.querySelector('[data-calc="from-protocol"]').addEventListener('click', () => openProtocolPick(body.querySelector('[data-calc-pick]'), 'calc', (entry) => pickCalcFromProtocol(b, body, entry)));
  mountCalc(b, body);
}
function renderCalcForm(b, form) {
  const a = b.data.spec.attrs;
  const v = (x) => esc(x === undefined || x === null ? '' : x);
  form.innerHTML = `
    <label>Label <input data-f="label" value="${v(a.label)}"></label>
    <label>Expression <input data-f="expression" value="${v(a.expression)}" placeholder="e.g. m / v   (mathjs: sqrt(x), x^2, pi…)" spellcheck="false"></label>
    <label>Result <span style="display:flex;gap:4px"><input data-f="output.name" value="${v(a.output?.name)}" placeholder="name" style="width:80px"><input data-f="output.label" value="${v(a.output?.label)}" placeholder="label"><input data-f="output.unit" value="${v(a.output?.unit)}" placeholder="unit" style="width:70px"><input data-f="output.decimals" type="number" min="0" max="8" value="${v(a.output?.decimals ?? 3)}" style="width:60px" title="decimals"></span></label>
    <div class="nbk-section-label">Inputs (name · label · default · unit)</div>
    <div class="nbk-calc-vars">${(a.variables || []).map((x, k) => `<div class="nbk-calc-var" data-k="${k}">
      <input data-v="name" value="${v(x.name)}" placeholder="name" spellcheck="false"><input data-v="label" value="${v(x.label)}" placeholder="label"><input data-v="default" type="number" step="any" value="${v(x.default)}" placeholder="default"><input data-v="unit" value="${v(x.unit)}" placeholder="unit"><button type="button" class="nbk-x" title="Remove">×</button></div>`).join('')}</div>
    <div><button type="button" class="btn" data-add-var>＋ input</button></div>`;
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
    refreshSummary(b); scheduleSave();
    mountCalc(b, form.closest('.nbk-bb'));
  };
  let t = null;
  form.addEventListener('input', () => { clearTimeout(t); t = setTimeout(apply, 350); });
  form.addEventListener('click', (e) => {
    if (e.target.closest('[data-add-var]')) { a.variables = a.variables || []; a.variables.push({ name: 'x' + (a.variables.length + 1), label: '', default: 1, unit: '' }); renderCalcForm(b, form); apply(); }
    const x = e.target.closest('.nbk-x'); if (x) { const r = x.closest('.nbk-calc-var'); a.variables.splice(+r.dataset.k, 1); renderCalcForm(b, form); apply(); }
  });
}
async function mountCalc(b, body) {
  const host = body.querySelector('.nbk-calc-host');
  const err = body.querySelector('[data-calc-err]');
  unmountRun(b.id);
  try {
    await ensureCalcDeps();
    const PF = window.ProtocolFormulas, PW = window.ProtocolWidgets;
    const math = await PF.ensureMathjs();
    const d = b.data;
    const blocks = [...(d.context || []), d.spec];
    const formulas = PF.collectFormulasFromPlainTree({ sections: [{ children: blocks }] });
    if (!host.isConnected) return;
    const ctx = PW.createContext({ container: host, math, formulas, overrides: d.inputs,
      onChange: () => { syncCalcResult(b, ctx); scheduleSave(); } });
    ctx.table = PF.buildSymbolTable(formulas, math, d.inputs);
    host.innerHTML = '';
    const node = window.ProtocolDocRender.renderBlock(d.spec, ctx, {});
    if (node) host.appendChild(node); else host.innerHTML = '<div class="nbk-section-label">This calculator kind cannot be rendered here.</div>';
    state.runs[b.id] = { ctx, unlisten: PW.mountRefresherBus(ctx) };
    PW.recompute(ctx);
    syncCalcResult(b, ctx);
    if (err) err.hidden = true;
  } catch (e) {
    console.warn('[notebook] calculator', e);
    if (err) { err.textContent = 'Calculator unavailable: ' + (e.message || e); err.hidden = false; }
  }
}
function syncCalcResult(b, ctx) {
  const d = b.data; const a = d.spec?.attrs || {};
  const name = d.spec.kind === 'formula' ? a.output?.name : (a.outputs && a.outputs[0] && a.outputs[0].name);
  const sym = name && ctx.table && ctx.table[name];
  const PF = window.ProtocolFormulas;
  d.result = sym ? (sym.error ? 'Error: ' + sym.error : (PF.formatSymbolValue ? PF.formatSymbolValue(sym) : String(sym.value))) : '';
  refreshSummary(b);
}
async function pickCalcFromProtocol(b, body, entry) {
  const pick = body.querySelector('[data-calc-pick]');
  pick.innerHTML = '<div class="nbk-pick-empty">Loading the protocol…</div>';
  let tree;
  try { tree = await loadProtocolTree(entry.id); } catch (e) { pick.innerHTML = `<div class="nbk-pick-empty">Could not load: ${esc(e.message || e)}</div>`; return; }
  const calcs = [];
  (tree.sections || []).forEach(sec => (sec.children || []).forEach(x => { if (x && (x.kind === 'formula' || x.kind === 'calculator')) calcs.push(x); }));
  if (!calcs.length) { pick.innerHTML = `<div class="nbk-pick-empty">“${esc(entry.title)}” has no formula or calculator blocks. <button type="button" class="btn" data-back>← Back</button></div>`; pick.querySelector('[data-back]').addEventListener('click', () => openProtocolPick(pick, 'calc', (en) => pickCalcFromProtocol(b, body, en))); return; }
  pick.innerHTML = `<div class="nbk-inline-pick-head"><button type="button" class="btn" data-back>←</button><span style="font-size:.85rem">Calculators in <b>${esc(entry.title)}</b></span></div>
    <div class="nbk-inline-pick-list">${calcs.map((x, k) => `<button type="button" class="nbk-pick-row" data-k="${k}">${ICON.svg(x.kind === 'formula' ? 'calculator' : 'adjustments-vertical')} ${esc(x.attrs?.label || x.kind)}<small>${esc(x.attrs?.expression || (x.attrs?.outputs || []).map(o => o.expr).join(' · ') || '')}</small></button>`).join('')}</div>`;
  pick.querySelector('[data-back]').addEventListener('click', () => openProtocolPick(pick, 'calc', (en) => pickCalcFromProtocol(b, body, en)));
  pick.querySelector('.nbk-inline-pick-list').addEventListener('click', (e) => {
    const r = e.target.closest('.nbk-pick-row'); if (!r) return;
    const chosen = calcs[+r.dataset.k];
    b.data.spec = JSON.parse(JSON.stringify(chosen));
    b.data.context = calcs.filter(x => x !== chosen).map(x => JSON.parse(JSON.stringify(x)));
    b.data.inputs = {};
    if (!b.title) b.title = chosen.attrs?.label || '';
    scheduleSave(); rerenderBlock(b);
    toast('success', 'Calculator copied — its inputs are yours to change.');
  });
}

/* ── protocol list + tree (plain tree on the protocol doc; no Yjs) ── */
async function ensureProtocolList() {
  if (state.protocolsList) return state.protocolsList;
  const d = await api.load('protocols/list.json');
  const list = (d && Array.isArray(d.protocols) ? d.protocols : []).map(p => ({ id: p.id, title: p.title || p.id, summary: p.summary || '', category: p.category || '', status: p.status || '', updated_at: p.updated_at || '',
    search: [p.title, p.summary, p.category, (p.tags || []).join(' ')].filter(Boolean).join(' ').toLowerCase() }))
    .sort((a, b) => String(b.updated_at).localeCompare(String(a.updated_at)));
  state.protocolsList = list;
  return list;
}
async function loadProtocolTree(id) {
  const s = await db().collection('protocols').doc(id).get();
  if (!s.exists) throw new Error('protocol not found');
  const doc = window.ProtocolSchemas?.protocolHydrate ? window.ProtocolSchemas.protocolHydrate(s.data()) : s.data();
  if (!doc.tree || !Array.isArray(doc.tree.sections)) throw new Error('this protocol has no document yet');
  return doc.tree;
}
function openProtocolPick(host, mode, onPick) {
  host.hidden = false;
  host.innerHTML = `<div class="nbk-inline-pick-head"><input type="search" placeholder="Search protocols…" data-pq><button type="button" class="btn" data-close>✕</button></div><div class="nbk-inline-pick-list"><div class="nbk-pick-empty">Loading…</div></div>`;
  const list = host.querySelector('.nbk-inline-pick-list');
  const q = host.querySelector('[data-pq]');
  const draw = (rows) => {
    const terms = q.value.trim().toLowerCase().split(/\s+/).filter(Boolean);
    const show = rows.filter(r => terms.every(t => r.search.includes(t))).slice(0, 60);
    list.innerHTML = show.length ? show.map(r => `<button type="button" class="nbk-pick-row" data-id="${esc(r.id)}">${esc(r.title)}<small>${esc([r.category, r.status, r.summary.slice(0, 90)].filter(Boolean).join(' · '))}</small></button>`).join('') : '<div class="nbk-pick-empty">No protocol matches.</div>';
  };
  ensureProtocolList().then(rows => { draw(rows); q.addEventListener('input', () => draw(rows)); }).catch(e => { list.innerHTML = `<div class="nbk-pick-empty">Could not load protocols: ${esc(e.message || e)}</div>`; });
  host.querySelector('[data-close]').addEventListener('click', () => { host.hidden = true; host.innerHTML = ''; });
  list.addEventListener('click', (e) => { const r = e.target.closest('.nbk-pick-row'); if (!r) return; const entry = (state.protocolsList || []).find(x => x.id === r.dataset.id); if (entry) onPick(entry); });
  setTimeout(() => q.focus(), 30);
}

/* ── protocol followed (the V3.506 run document) ── */
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
function renderProtocol(b, body) {
  const run = b.data.run;
  if (!run || !run.protocol_id) {
    body.innerHTML = `<div class="nbk-run-paused">No protocol loaded. <button type="button" class="btn btn-primary" data-load>${ICON.svg('clipboard-document-list')} Load a protocol…</button></div><div class="nbk-inline-pick" data-proto-pick hidden></div>`;
    body.querySelector('[data-load]').addEventListener('click', () => openProtocolPick(body.querySelector('[data-proto-pick]'), 'run', (entry) => {
      b.data.run = freshRun(entry.id, entry.title); if (!b.title) b.title = entry.title;
      state.protoLive = b.id; scheduleSave(); rerenderBlock(b);
    }));
    return;
  }
  if (run.frozen) { renderFrozenRun(b, body); return; }
  if (state.protoLive && state.protoLive !== b.id && state.runs[state.protoLive]) {
    body.innerHTML = `<div class="nbk-run-paused">${ICON.svg('clipboard-document-list')} <b>${esc(run.protocol_title || run.protocol_id)}</b> — another protocol block is live on this entry (their calculators share one workspace). <button type="button" class="btn" data-resume>${ICON.svg('play')} Make this one live</button></div>`;
    body.querySelector('[data-resume]').addEventListener('click', () => { const other = state.doc.blocks.find(x => x.id === state.protoLive); state.protoLive = b.id; if (other) { other.collapsed = true; rerenderBlock(other); } rerenderBlock(b); });
    return;
  }
  state.protoLive = b.id;
  mountRunLive(b, body);
}
async function mountRunLive(b, body) {
  const run = b.data.run;
  body.innerHTML = '<div class="nbk-section-label">Loading the protocol document…</div>';
  try {
    await ensureRunDeps();
    const tree = await loadProtocolTree(run.protocol_id);
    const PF = window.ProtocolFormulas, PW = window.ProtocolWidgets;
    const formulas = PF.collectFormulasFromPlainTree(tree);
    const needsMath = formulas.length > 0 || (tree.sections || []).some(sec => (sec.children || []).some(x => x && (x.kind === 'builder' || x.kind === 'layoutMap' || x.kind === 'design')));
    const math = needsMath ? await PF.ensureMathjs().catch(() => null) : null;
    if (!body.isConnected) return;
    unmountRun(b.id);
    body.innerHTML = '';
    body.appendChild(buildRunToolbar(b, body, protocolHasSteps(tree)));
    const ctx = PW.createContext({ container: body, math, formulas, overrides: run.inputs, builderState: run.graph_state,
      onChange: () => { syncRunComputed(b); scheduleSave(); } });
    ctx.table = math ? PF.buildSymbolTable(formulas, math, run.inputs) : {};
    const card = document.createElement('div'); card.className = 'prd-doc nbk-run-doc';
    body.appendChild(card);
    const R = state.runs[b.id] = { ctx, tree, unlisten: null, cheat: state.runs[b.id]?.cheat || { protocolId: null, prefs: null, customizing: false } };
    renderProtocolDocInto(b, body, card, tree, ctx, run);
    R.unlisten = PW.mountRefresherBus(ctx);
    PW.recompute(ctx);
    syncRunComputed(b);
  } catch (e) {
    console.warn('[notebook] protocol run', e);
    body.innerHTML = `<div class="nbk-run-paused">Could not load “${esc(run.protocol_title || run.protocol_id)}”: ${esc(e.message || e)} <button type="button" class="btn" data-unload>Unload</button></div>`;
    body.querySelector('[data-unload]').addEventListener('click', () => { b.data.run = null; scheduleSave(); rerenderBlock(b); });
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
function syncRunComputed(b) {
  const run = b.data.run; const R = state.runs[b.id];
  if (!run || !R || !window.ProtocolFormulas) return;
  const ds = runDatasets(R.tree)[0];
  const items = ds ? (window.ProtocolFormulas.getDataset(ds.name) || []) : [];
  run.computed = { items: items.slice(), totals: null };
  refreshSummary(b);
}
function buildRunToolbar(b, body, hasCheat) {
  const run = b.data.run;
  const bar = document.createElement('div'); bar.className = 'nbk-run-toolbar';
  bar.innerHTML = `<div class="nbk-run-toolbar-title">${ICON.svg('clipboard-document-list')} ${esc(run.protocol_title || run.protocol_id)} · ${run.frozen ? 'finalized' : 'live'}</div>
    ${hasCheat ? `<div class="nbk-run-toggle"><button type="button" data-view="doc" class="${(run.view || 'doc') === 'doc' ? 'nbk-sel' : ''}">${ICON.svg('document-text')} Document</button><button type="button" data-view="cheat" class="${run.view === 'cheat' ? 'nbk-sel' : ''}">${ICON.svg('clipboard-document-list')} Cheat sheet</button></div>` : ''}
    ${run.frozen ? '<button type="button" class="btn" data-run="reopen" title="Unlock the values to edit them again (two taps)">✎ Reopen</button>'
                 : '<button type="button" class="btn btn-primary" data-run="finalize" title="Lock the values you used into this entry as an immutable record (two taps)">✓ Finalize</button>'}
    <a class="btn" href="/rm/pages/protocols.html?protocol=${encodeURIComponent(run.protocol_id)}&view=doc" target="_blank" rel="noopener" title="Open the protocol">↗</a>
    <button type="button" class="btn" data-run="unload" title="Remove this protocol and its values from the entry (two taps)">✕ Unload</button>`;
  bar.addEventListener('click', (e) => {
    const v = e.target.closest('[data-view]'); if (v) { if ((run.view || 'doc') !== v.dataset.view) { run.view = v.dataset.view; scheduleSave(); rerenderBlock(b); } return; }
    const r = e.target.closest('[data-run]'); if (!r) return;
    if (r.dataset.run === 'finalize') { if (!armTwoTap(r, 'Lock the values?')) return; freezeRun(b); scheduleSave(); rerenderBlock(b); toast('success', 'Protocol finalized — the values used are now a locked record.'); }
    else if (r.dataset.run === 'reopen') { if (!armTwoTap(r, 'Unlock?')) return; run.frozen = false; run.frozen_at = null; scheduleSave(); rerenderBlock(b); }
    else if (r.dataset.run === 'unload') { if (!armTwoTap(r, 'Remove?')) return; unmountRun(b.id); if (state.protoLive === b.id) state.protoLive = null; b.data.run = null; scheduleSave(); rerenderBlock(b); }
  });
  return bar;
}
function freezeRun(b) {
  const run = b.data.run; if (!run || run.frozen) return;
  syncRunComputed(b);
  try { run.snapshot = JSON.parse(JSON.stringify({ inputs: run.inputs, graph_state: run.graph_state, grids: run.grids, assignment: run.assignment, factor: run.factor, computed: run.computed, protocol_id: run.protocol_id, protocol_title: run.protocol_title })); }
  catch (e) { run.snapshot = null; }
  run.frozen = true; run.frozen_at = isoNow();
  unmountRun(b.id); if (state.protoLive === b.id) state.protoLive = null;
}
function renderMasthead(tree, run) {
  const el = document.createElement('header'); el.className = 'prd-masthead';
  el.innerHTML = `<div class="prd-brand"><span class="prd-brand-name">McGhee Lab</span><span class="prd-brand-tag">${run.view === 'cheat' ? 'PROTOCOL · CHEAT SHEET' : 'PROTOCOL'}</span></div>
    <h1 class="prd-title">${esc((tree.meta && tree.meta.title) || run.protocol_title || run.protocol_id)}</h1>
    <div class="prd-chips"><span class="prd-chip prd-chip-meta">${run.frozen && run.frozen_at ? ICON.svg('lock-closed') + ' finalized ' + esc(String(run.frozen_at).slice(0, 10)) : 'live — values editable'}</span>${run.loaded_at ? `<span class="prd-chip prd-chip-meta">loaded ${esc(String(run.loaded_at).slice(0, 10))}</span>` : ''}</div>`;
  return el;
}
function renderProtocolDocInto(b, body, card, tree, ctx, run) {
  const R = state.runs[b.id];
  if (run.view === 'cheat' && window.ProtocolCheatRender) {
    const PCR = window.ProtocolCheatRender;
    card.classList.add('prc-doc');
    const head = document.createElement('header'); head.className = 'prc-header';
    head.innerHTML = `<h1 class="prc-title">${esc((tree.meta && tree.meta.title) || run.protocol_title || run.protocol_id)}</h1><div class="prc-meta">${run.frozen && run.frozen_at ? ICON.svg('lock-closed') + ' finalized ' + esc(String(run.frozen_at).slice(0, 10)) : 'live · values editable'} · cheat sheet</div>`;
    card.appendChild(head);
    const cs = R.cheat;
    if (cs.protocolId !== run.protocol_id) {
      cs.protocolId = run.protocol_id; cs.prefs = null; cs.customizing = false;
      PCR.loadPrefs(run.protocol_id).then(p => { if (cs.protocolId !== run.protocol_id || !state.runs[b.id]) return; cs.prefs = p; rerenderBlock(b); });
    }
    if (!cs.prefs) { const l = document.createElement('div'); l.className = 'prc-configbar-loading'; l.textContent = 'Loading cheat-sheet options…'; card.appendChild(l); return; }
    const prefs = cs.prefs, pid = run.protocol_id;
    const handlers = {
      customizing: cs.customizing,
      onToggleCategory: (c, next) => { prefs.categories[c] = next; PCR.savePrefs(pid, prefs); rerenderBlock(b); },
      onToggleBlock: (id, v) => { prefs.overrides[id] = v; PCR.savePrefs(pid, prefs); rerenderBlock(b); },
      onToggleCustomize: (next) => { cs.customizing = next; rerenderBlock(b); },
      onReset: () => { const d = PCR.defaultPrefs(); prefs.categories = d.categories; prefs.overrides = d.overrides; PCR.savePrefs(pid, prefs); rerenderBlock(b); }
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
async function renderFrozenRun(b, body) {
  const run = b.data.run; const snap = run.snapshot || {};
  body.innerHTML = '<div class="nbk-section-label">Loading the finalized record…</div>';
  try {
    await ensureRunDeps();
    const PF = window.ProtocolFormulas, PW = window.ProtocolWidgets;
    const tree = await loadProtocolTree(run.protocol_id);
    const formulas = PF.collectFormulasFromPlainTree(tree);
    const needsMath = formulas.length > 0 || (tree.sections || []).some(sec => (sec.children || []).some(x => x && (x.kind === 'builder' || x.kind === 'layoutMap' || x.kind === 'design')));
    const math = needsMath ? await PF.ensureMathjs().catch(() => null) : null;
    if (!body.isConnected) return;
    body.innerHTML = '';
    body.appendChild(buildRunToolbar(b, body, protocolHasSteps(tree)));
    const ctx = PW.createContext({ container: body, math, formulas, overrides: snap.inputs || run.inputs || {}, builderState: snap.graph_state || run.graph_state || {}, readOnly: true });
    ctx.table = math ? PF.buildSymbolTable(formulas, math, ctx.overrides) : {};
    state.runs[b.id] = { ctx, tree, unlisten: null, cheat: state.runs[b.id]?.cheat || { protocolId: null, prefs: null, customizing: false } };
    const card = document.createElement('div'); card.className = 'prd-doc nbk-run-doc nbk-run-doc-frozen';
    body.appendChild(card);
    renderProtocolDocInto(b, body, card, tree, ctx, run);
    PW.recompute(ctx);
  } catch (e) {
    body.innerHTML = '';
    body.appendChild(buildRunToolbar(b, body, false));
    const n = document.createElement('div'); n.className = 'nbk-run-paused'; n.textContent = 'Finalized record (the protocol document could not be re-rendered: ' + (e.message || e) + ').'; body.appendChild(n);
  }
  body.appendChild(renderFrozenRecord(run));
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
function unmountRuns() { Object.keys(state.runs).forEach(unmountRun); }

/* ─── go ─────────────────────────────────────────────────────────────── */
if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', boot); else boot();

window.NOTEBOOK_BLOCKS = { _state: state, sanitizeHtml, ensureBlocks, computeMirrors, newBlock, BLOCK_TYPES, openEntry, addBlock };
})();
