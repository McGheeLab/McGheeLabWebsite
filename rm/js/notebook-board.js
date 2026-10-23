/* ================================================================
   notebook-board.js — V3.830 — the whiteboard block of a lab-notebook entry
   ================================================================
   Runs inside /rm/pages/notebook-board.html, which /rm/pages/notebook.html
   hosts in an iframe per whiteboard block (whiteboard.js is a one-board-
   per-document engine). Query: ?board=<boardId>&owner=<uid>&title=<name>.

   What this host adds around the shared engine (mounted with
   collection:'notebookBoards' → userData/{owner}/notebookBoards/{boardId}):
   - 🎙 Record / ■ Stop — the engine's lecture recorder, started from here
     instead of "Go live" (no class, no live flag); the recordings list
     below the board, ▶ Play = the engine remounted in replay mode with
     WhiteboardReplay driving it; "← Back to board" restores the live mount.
   - ＋ From paper — a picker column: search the library, open the PDF
     with the reader's own viewer, click a detected figure hotspot or drag
     any region → "Add as figure" (re-rendered from the PDF at high
     resolution, uploaded as webp medium/full) or "Add as text" (the text
     layer inside the rectangle); plus the paper's already-snipped figures
     and the person's highlights, one click each.
   Auth: same origin as the notebook page ⇒ the Firebase session is shared;
   /firebase-config.js gives McgheeLab.db and installAuthShim() the
   McgheeLab.Auth the engine reads (as modules/shared/whiteboard-panel.js).
   No browser popups: toasts, inline forms, two-tap deletes.
   ================================================================ */
(function () {
'use strict';

const qs = new URLSearchParams(location.search);
const BOARD_ID = qs.get('board') || '';
const OWNER = qs.get('owner') || '';
const TITLE = qs.get('title') || 'Whiteboard';
const COLL = 'notebookBoards';
const SIZES = { medium: { max: 800, q: 0.85 }, full: { max: 1600, q: 0.9 } };
const PAPERS_CACHE_KEY = 'nbb_papers_v1';
const PAPERS_CACHE_MS = 15 * 60 * 1000;

const H = {
  inst: null, mode: 'live', uid: null, isOwner: false,
  recUnsub: null, recs: [], recsOpen: false, timer: null, repaired: new Set(),
  pk: null   // picker state
};

function $(id) { return document.getElementById(id); }
function esc(s) { return (s ?? '').toString().replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#039;' }[c])); }
function toast(msg) { if (window.Whiteboard?.toast) window.Whiteboard.toast(msg); else console.log('[nbb]', msg); }
function db() { return window.McgheeLab?.db || null; }
function fmtDur(ms) { const s = Math.max(0, Math.round((ms || 0) / 1000)); const m = Math.floor(s / 60); return `${m}:${String(s % 60).padStart(2, '0')}`; }
function fmtDate(ms) { try { return new Date(ms).toLocaleDateString(undefined, { month: 'short', day: 'numeric', year: 'numeric' }); } catch (e) { return ''; } }
function newId(prefix) { return prefix + Date.now().toString(36) + Math.random().toString(36).slice(2, 7); }
function post(type, extra) { try { window.parent?.postMessage({ type, boardId: BOARD_ID, ...(extra || {}) }, location.origin); } catch (e) {} }
function isLocalDev() { return /^(localhost|127\.0\.0\.1)$/.test(location.hostname); }

/* ─── Auth shim (whiteboard-panel.js precedent) ─────────────────── */
function installAuthShim() {
  const ML = window.McgheeLab = window.McgheeLab || {};
  if (ML.Auth && ML.Auth.onChange) return ML.Auth;
  const listeners = [];
  const Auth = {
    currentUser: null, currentProfile: null,
    onChange(fn) { listeners.push(fn); },
    offChange(fn) { const i = listeners.indexOf(fn); if (i >= 0) listeners.splice(i, 1); }
  };
  ML.Auth = Auth;
  if (window.firebase?.auth) {
    firebase.auth().onAuthStateChanged(async (user) => {
      Auth.currentUser = user || null;
      Auth.currentProfile = null;
      if (user && ML.db) {
        try { const d = await ML.db.collection('users').doc(user.uid).get(); Auth.currentProfile = d.exists ? d.data() : null; }
        catch (e) { Auth.currentProfile = null; }
      }
      listeners.slice().forEach(fn => { try { fn(Auth.currentUser, Auth.currentProfile); } catch (e) {} });
    });
  }
  return Auth;
}

/* ─── boot ──────────────────────────────────────────────────────── */
function showMsg(html) { $('nbb-mount').innerHTML = `<div class="nbb-msg">${html}</div>`; }

async function boot() {
  if (!BOARD_ID || !OWNER) { showMsg('This board link is incomplete (missing board or owner).'); return; }
  if (!window.firebase || !db()) { showMsg('Firebase did not load — reload the page.'); return; }
  if (!window.Whiteboard?.mountBoardView) { showMsg('The whiteboard engine did not load. Open the notebook on <a href="https://mcgheelab.com/rm/pages/notebook.html" target="_top">mcgheelab.com</a>.'); return; }
  const Auth = installAuthShim();
  /* wait for the first auth resolution */
  await new Promise(res => { const off = (u) => { Auth.offChange(off); res(u); }; Auth.onChange(off); if (Auth.currentUser) res(Auth.currentUser); });
  const user = Auth.currentUser;
  if (!user) { showMsg('Sign in on the notebook page, then open this block again.'); return; }
  H.uid = user.uid;
  H.isOwner = user.uid === OWNER && BOARD_ID.split('_')[1] === user.uid;
  await mountLive();
  watchRecordings();
  window.addEventListener('beforeunload', () => { if (H.inst?.isRecording?.()) { try { H.inst.stopRecording('pagehide'); } catch (e) {} } });
  window.addEventListener('message', (e) => {
    if (e.origin !== location.origin || !e.data || e.data.boardId !== BOARD_ID) return;
    if (e.data.type === 'nbb-stop-recording' && H.inst?.isRecording?.()) H.inst.stopRecording('parent');
  });
}

async function mountLive() {
  H.mode = 'live';
  const mount = $('nbb-mount');
  mount.innerHTML = window.Whiteboard.boardShellHTML({ classId: OWNER, ids: false, back: false, zoomControls: true, maximize: false });
  const tools = H.isOwner ? [{ act: 'paper', label: '＋ From paper', title: 'Add a figure or a passage from a paper in the library' }] : [];
  H.inst = await window.Whiteboard.mountBoardView(mount.querySelector('.wb-page'), {
    classId: OWNER, boardId: BOARD_ID, collection: COLL, ownerUid: OWNER, boardName: TITLE,
    chrome: 'full', view: { enabled: true }, items: { enabled: true },
    tools, onTool: (act) => { if (act === 'paper') togglePicker(); }
  });
  if (!H.inst) { showMsg('Could not open this board.'); return; }
  renderBar();
  post('nbb-ready');
}

/* ─── the bar: record + recordings ─────────────────────────────── */
function renderBar() {
  const bar = $('nbb-bar');
  if (H.mode === 'replay') { bar.hidden = true; return; }
  bar.hidden = false;
  const rec = !!H.inst?.isRecording?.();
  const n = H.recs.length;
  bar.innerHTML = `
    <span class="nbb-title" title="${esc(TITLE)}">${esc(TITLE)}</span>
    ${H.isOwner ? `<button type="button" class="btn btn-small nbb-rec-btn${rec ? ' nbb-rec-on' : ''}" data-nbb="rec" title="${rec ? 'Stop recording' : 'Record your voice while you draw — replay it later with the ink'}">
      ${rec ? `<span class="wb-live-dot"></span> ■ Stop <span class="nbb-rec-timer" data-nbb-timer>${esc(H.inst.recElapsed())}</span>` : `${ICON.svg('microphone')} Record`}</button>` : ''}
    ${n ? `<button type="button" class="btn btn-small btn-secondary" data-nbb="recs" aria-pressed="${H.recsOpen ? 'true' : 'false'}">${ICON.svg('play')} Recordings (${n})</button>` : ''}
    <span class="muted-text" data-nbb-status></span>`;
  if (!bar.dataset.wired) {
    bar.dataset.wired = '1';
    bar.addEventListener('click', onBarClick);
  }
  clearInterval(H.timer); H.timer = null;
  if (rec) H.timer = setInterval(() => { const t = bar.querySelector('[data-nbb-timer]'); if (t && H.inst) t.textContent = H.inst.recElapsed(); if (!H.inst?.isRecording?.()) renderBar(); }, 1000);
  post('nbb-state', { recording: rec });
}

async function onBarClick(e) {
  const btn = e.target.closest('[data-nbb]');
  if (!btn || !H.inst) return;
  const act = btn.dataset.nbb;
  if (act === 'rec') {
    btn.disabled = true;
    if (H.inst.isRecording()) {
      await H.inst.stopRecording('stop');
      toast('Recording saved. Find it under Recordings.');
    } else {
      const r = await H.inst.startRecording();
      if (!r) toast('Recording could not start — the microphone is unavailable or was refused.');
      else toast('Recording. Draw and talk; press ■ Stop when you are done.');
    }
    btn.disabled = false;
    renderBar();
  } else if (act === 'recs') {
    H.recsOpen = !H.recsOpen;
    renderRecs();
    renderBar();
  }
}

function recCol() { return window.Whiteboard.boardsCol(OWNER, COLL).doc(BOARD_ID).collection('recordings'); }

function watchRecordings() {
  if (H.recUnsub) { try { H.recUnsub(); } catch (e) {} }
  H.recUnsub = recCol().orderBy('startedAtMs', 'desc').onSnapshot(snap => {
    H.recs = snap.docs.map(d => ({ id: d.id, ...d.data() }));
    repairInterrupted();
    renderRecs();
    renderBar();
  }, err => console.warn('[nbb] recordings listener', err));
}

/* A recording still 'recording' that nobody is recording (the tab was
   closed or reloaded mid-way) is finalized from the ink timeline, once. */
function repairInterrupted() {
  if (!H.isOwner || !H.inst) return;
  let mine = null;
  try { mine = sessionStorage.getItem('wb_client'); } catch (e) {}
  const recordingNow = H.inst.isRecording?.();
  H.recs.forEach(r => {
    if (r.status !== 'recording' || H.repaired.has(r.id)) return;
    const own = recordingNow && r.recorderClientId === mine;
    const stale = (Date.now() - (r.startedAtMs || 0)) > 3 * 60 * 1000;
    if (own || !stale) return;
    H.repaired.add(r.id);
    H.inst.finalizeInterrupted(r.id).catch(e => console.warn('[nbb] repair failed', e));
  });
}

function renderRecs() {
  const box = $('nbb-recs');
  if (!box) return;
  if (!H.recsOpen || H.mode === 'replay' || !H.recs.length) { box.hidden = true; box.innerHTML = ''; return; }
  box.hidden = false;
  box.innerHTML = `<div class="nbb-recs-head">Recordings — press ${ICON.svg('play')} to replay the ink with the voice</div>` +
    H.recs.map(r => {
      const live = r.status === 'recording';
      const dur = live ? '' : fmtDur(r.durationMs);
      return `<div class="nbb-rec">
        ${live ? '<span class="nbb-rec-live"><span class="wb-live-dot"></span> recording now</span>'
               : `<button type="button" class="btn btn-small" data-nbb-play="${esc(r.id)}" title="Replay">${ICON.svg('play')}</button>`}
        <span class="nbb-rec-name">${esc(r.name || 'Recording')}${r.endReason === 'interrupted' ? ' <span class="nbb-rec-int" title="The recorder was interrupted; the ink timeline was rebuilt from the board">· interrupted</span>' : ''}</span>
        <span class="nbb-rec-meta">${esc(fmtDate(r.startedAtMs))}${dur ? ' · ' + dur : ''}</span>
      </div>`;
    }).join('');
  if (!box.dataset.wired) {
    box.dataset.wired = '1';
    box.addEventListener('click', (e) => {
      const b = e.target.closest('[data-nbb-play]');
      if (b) openReplay(b.dataset.nbbPlay);
    });
  }
}

/* ─── replay (same document: tear the live board down, remount) ──── */
async function openReplay(recId) {
  if (!H.inst) return;
  if (H.inst.isRecording?.()) { toast('Stop the recording first.'); return; }
  if (!window.WhiteboardReplay?.mount) { toast('Replay is not available (whiteboard-replay.js did not load).'); return; }
  closePicker();
  try { H.inst.destroy(); } catch (e) {}
  H.inst = null;
  H.mode = 'replay';
  const mount = $('nbb-mount');
  mount.innerHTML = window.Whiteboard.boardShellHTML({ classId: OWNER, ids: false, back: false, zoomControls: false, maximize: false });
  const inst = await window.Whiteboard.mountBoardView(mount.querySelector('.wb-page'), {
    classId: OWNER, boardId: BOARD_ID, collection: COLL, ownerUid: OWNER, boardName: TITLE,
    chrome: 'full', replay: recId, view: { enabled: false }, items: { enabled: true }
  });
  if (!inst) { toast('Could not open the replay.'); await mountLive(); return; }
  H.inst = inst;
  renderBar(); renderRecs();
  window.WhiteboardReplay.mount({
    classId: OWNER, boardId: BOARD_ID, recId, handle: inst, coll: COLL, isAdmin: H.isOwner, noHash: true,
    onExit: () => backToLive(), onDeleted: () => backToLive()
  });
}
async function backToLive() {
  try { window.WhiteboardReplay?.teardown?.(); } catch (e) {}
  try { H.inst?.destroy(); } catch (e) {}
  H.inst = null;
  await mountLive();
  renderRecs();
}

/* ================================================================
   ＋ From paper — the picker column
   ================================================================ */
function togglePicker() {
  const pk = $('nbb-picker');
  if (!pk.hidden) { closePicker(); return; }
  if (!H.isOwner) { toast('Only the board\'s owner can add to it.'); return; }
  pk.hidden = false;
  if (!H.pk) { H.pk = { papers: null, q: '', paper: null, tab: 'pages', viewer: null, figs: null, hls: null, mq: null }; }
  renderPicker();
  markTool(true);
}
function closePicker() {
  const pk = $('nbb-picker');
  if (pk.hidden) return;
  destroyViewer();
  pk.hidden = true;
  if (H.pk) { H.pk.paper = null; }
  markTool(false);
}
function markTool(on) {
  const b = document.querySelector('[data-wb-act="tool"][data-tool="paper"]');
  if (b) b.classList.toggle('wb-sel', !!on);
}

function renderPicker() {
  const pk = $('nbb-picker');
  const P = H.pk;
  if (!P.paper) {
    pk.innerHTML = `
      <div class="nbb-pk-head"><span class="nbb-pk-title">From a paper in the library</span>
        <button type="button" class="btn btn-small btn-ghost" data-pk="close" title="Close">✕</button></div>
      <div class="nbb-pk-search"><input type="search" class="wb-input" data-pk-q placeholder="Search title, author, year, journal…" value="${esc(P.q)}" autocomplete="off"></div>
      <div class="nbb-pk-list" data-pk-list><div class="nbb-pk-status">Loading the library…</div></div>`;
    wirePicker();
    loadPapers().then(() => renderPaperList()).catch(e => {
      const l = pk.querySelector('[data-pk-list]'); if (l) l.innerHTML = `<div class="nbb-pk-status nbb-err">Could not load the library: ${esc(e.message || e)}</div>`;
    });
    const q = pk.querySelector('[data-pk-q]'); if (q) setTimeout(() => q.focus(), 50);
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
      <button type="button" class="nbb-pk-tab${P.tab === 'pages' ? ' nbb-sel' : ''}" data-pk-tab="pages">${ICON.svg('document-text')} Pages</button>
      <button type="button" class="nbb-pk-tab${P.tab === 'figs' ? ' nbb-sel' : ''}" data-pk-tab="figs">${ICON.svg('photo')} Figures${P.figs ? ` (${P.figs.length})` : ''}</button>
      <button type="button" class="nbb-pk-tab${P.tab === 'hls' ? ' nbb-sel' : ''}" data-pk-tab="hls">${ICON.svg('highlighter')} Highlights${P.hls ? ` (${P.hls.length})` : ''}</button>
    </div>
    ${P.tab === 'pages' ? `<div class="nbb-pk-hint">Click a dashed figure box to add it to the board. Drag over any region for <b>Add as figure</b> / <b>Add as text</b>.
      <span style="float:right;white-space:nowrap"><button type="button" class="btn btn-small btn-ghost" data-pk="zoom-out" title="Smaller">−</button> <button type="button" class="btn btn-small btn-ghost" data-pk="zoom-in" title="Larger">+</button></span></div>` : ''}
    <div class="nbb-pk-body" data-pk-body></div>`;
  wirePicker();
  if (P.tab === 'pages') mountPdfPane();
  else if (P.tab === 'figs') renderFigs();
  else renderHls();
}

function wirePicker() {
  const pk = $('nbb-picker');
  if (pk.dataset.wired) return;
  pk.dataset.wired = '1';
  pk.addEventListener('click', (e) => {
    const b = e.target.closest('[data-pk],[data-pk-tab],[data-pk-open],[data-pk-fig],[data-pk-hl]');
    if (!b) return;
    const P = H.pk;
    if (b.dataset.pk === 'close') { closePicker(); return; }
    if (b.dataset.pk === 'back') { destroyViewer(); P.paper = null; P.figs = null; P.hls = null; renderPicker(); return; }
    if (b.dataset.pk === 'zoom-in') { P.viewer?.zoomIn(); return; }
    if (b.dataset.pk === 'zoom-out') { P.viewer?.zoomOut(); return; }
    if (b.dataset.pkTab) { if (P.tab !== b.dataset.pkTab) { destroyViewer(); P.tab = b.dataset.pkTab; renderPicker(); } return; }
    if (b.dataset.pkOpen) { const row = (P.papers || []).find(r => r.id === b.dataset.pkOpen); if (row) openPaper(row); return; }
    if (b.dataset.pkFig) { addExistingFigure(b.dataset.pkFig); return; }
    if (b.dataset.pkHl) { addHighlight(b.dataset.pkHl); return; }
  });
  pk.addEventListener('input', (e) => {
    const q = e.target.closest('[data-pk-q]');
    if (!q) return;
    H.pk.q = q.value;
    renderPaperList();
  });
}

/* ─── the library list ─── */
async function loadPapers() {
  const P = H.pk;
  if (P.papers) return P.papers;
  try {
    const raw = sessionStorage.getItem(PAPERS_CACHE_KEY);
    if (raw) { const c = JSON.parse(raw); if (c && Date.now() - c.at < PAPERS_CACHE_MS && Array.isArray(c.rows)) { P.papers = c.rows; return P.papers; } }
  } catch (e) {}
  const snap = await db().collection('items').where('type', '==', 'paper').get();
  const rows = [];
  snap.forEach(d => {
    const x = d.data(); const lib = (x.meta && x.meta.library) || {};
    if (!lib.is_library_entry) return;
    const authors = Array.isArray(lib.authors) ? lib.authors : [];
    const fam = (a) => (a && (a.family || a.last || a.name)) || '';
    rows.push({
      id: d.id, title: x.title || '(untitled)', year: lib.year || '', journal: lib.journal_iso || lib.journal || '',
      first: fam(authors[0]), second: fam(authors[1]), nAuthors: authors.length,
      pdf: lib.pdf && lib.pdf.storage_path ? lib.pdf.storage_path : '',
      hay: [x.title, ...authors.map(fam), lib.year, lib.journal, lib.doi].filter(Boolean).join(' ').toLowerCase(),
      added: lib.date_added || x.updated_at || ''
    });
  });
  rows.sort((a, b) => String(b.added).localeCompare(String(a.added)));
  P.papers = rows;
  try { sessionStorage.setItem(PAPERS_CACHE_KEY, JSON.stringify({ at: Date.now(), rows })); } catch (e) {}
  return rows;
}

function renderPaperList() {
  const pk = $('nbb-picker');
  const list = pk.querySelector('[data-pk-list]');
  if (!list || !H.pk) return;
  const q = (H.pk.q || '').trim().toLowerCase();
  const terms = q.split(/\s+/).filter(Boolean);
  const rows = (H.pk.papers || []).filter(r => terms.every(t => r.hay.includes(t))).slice(0, 80);
  if (!rows.length) { list.innerHTML = `<div class="nbb-pk-status">${H.pk.papers?.length ? 'No paper matches.' : 'The library is empty.'}</div>`; return; }
  list.innerHTML = rows.map(r => `<button type="button" class="nbb-pk-row${r.pdf ? '' : ' nbb-pk-row-nopdf'}" data-pk-open="${esc(r.id)}">
      <div class="nbb-pk-row-title">${esc(r.title)}</div>
      <div class="nbb-pk-row-meta">${esc(citeFor(r))}${r.journal ? ' · ' + esc(r.journal) : ''}${r.pdf ? '' : ' · no PDF (figures & highlights only)'}</div>
    </button>`).join('');
}

function citeFor(r, page) {
  let who = r.first || 'Unknown';
  if (r.nAuthors === 2 && r.second) who = `${r.first} & ${r.second}`;
  else if (r.nAuthors > 2) who = `${r.first} et al.`;
  return `${who}${r.year ? ', ' + r.year : ''}${page ? ', p. ' + page : ''}`;
}

async function openPaper(row) {
  const P = H.pk;
  P.paper = row; P.tab = row.pdf ? 'pages' : 'figs'; P.figs = null; P.hls = null;
  renderPicker();
  loadAnnotations(row.id).then(() => { if (H.pk && H.pk.paper === row) { const t = $('nbb-picker').querySelector('.nbb-pk-tabs'); if (t) renderPicker(); } }).catch(e => console.warn('[nbb] annotations', e));
}

async function loadAnnotations(paperId) {
  const P = H.pk;
  const col = db().collection('papers').doc(paperId).collection('annotations');
  const [lab, mine] = await Promise.all([
    col.where('visibility', '==', 'lab').get(),
    col.where('creator.uid', '==', H.uid).where('visibility', '==', 'private').get()
  ]);
  const seen = new Set(); const all = [];
  [lab, mine].forEach(s => s.forEach(d => { if (seen.has(d.id)) return; seen.add(d.id); all.push({ id: d.id, ...d.data() }); }));
  const quoteOf = (a) => { const pg = a.target && Array.isArray(a.target.pages) ? a.target.pages : []; for (const p of pg) { const q = p && p.selectors && p.selectors.textQuote && p.selectors.textQuote.exact; if (q) return String(q); } return ''; };
  const pageOf = (a) => { const pg = a.target && Array.isArray(a.target.pages) ? a.target.pages : []; return pg[0] && pg[0].page || 0; };
  P.figs = all.filter(a => a.kind === 'figure' && a.image && a.image.download_url).map(a => ({ id: a.id, name: a.name || 'Figure', url: a.image.download_url, thumb: a.snip_data_uri || '', page: pageOf(a), by: (a.creator && a.creator.displayName) || '' }));
  P.hls = all.filter(a => a.kind !== 'figure' && a.kind !== 'equation' && quoteOf(a)).map(a => ({ id: a.id, quote: quoteOf(a), page: pageOf(a), color: a.color_id || 'yellow', comment: a.comment || '', mine: a.creator && a.creator.uid === H.uid }));
  P.figs.sort((a, b) => (a.page || 0) - (b.page || 0));
  P.hls.sort((a, b) => (a.page || 0) - (b.page || 0));
}

const HL_HEX = { yellow: '#fde047', green: '#86efac', red: '#fca5a5', blue: '#93c5fd', purple: '#d8b4fe', orange: '#fdba74' };
function renderFigs() {
  const body = $('nbb-picker').querySelector('[data-pk-body]');
  const P = H.pk;
  if (!P.figs) { body.innerHTML = '<div class="nbb-pk-status">Loading…</div>'; return; }
  if (!P.figs.length) { body.innerHTML = '<div class="nbb-pk-status">No figures have been snipped from this paper yet. Use ' + ICON.svg('document-text') + ' Pages to snip one.</div>'; return; }
  body.innerHTML = P.figs.map(f => `<button type="button" class="nbb-fig" data-pk-fig="${esc(f.id)}">
      <img src="${esc(f.thumb || f.url)}" alt="">
      <span><div class="nbb-fig-name">${esc(f.name)}</div><div class="nbb-fig-meta">${f.page ? 'p. ' + f.page : ''}${f.by ? ' · snipped by ' + esc(f.by) : ''}</div></span>
    </button>`).join('');
}
function renderHls() {
  const body = $('nbb-picker').querySelector('[data-pk-body]');
  const P = H.pk;
  if (!P.hls) { body.innerHTML = '<div class="nbb-pk-status">Loading…</div>'; return; }
  if (!P.hls.length) { body.innerHTML = '<div class="nbb-pk-status">No highlights on this paper yet. Highlight passages in the paper reader, or drag over text on ' + ICON.svg('document-text') + ' Pages.</div>'; return; }
  body.innerHTML = P.hls.map(h => `<button type="button" class="nbb-hl" data-pk-hl="${esc(h.id)}" style="border-left-color:${HL_HEX[h.color] || HL_HEX.yellow}">
      <div class="nbb-hl-quote">${esc(h.quote)}</div>
      <div class="nbb-hl-meta">${h.page ? 'p. ' + h.page : ''}${h.comment ? ' · ' + esc(h.comment.slice(0, 80)) : ''}${h.mine ? '' : ' · lab'}</div>
    </button>`).join('');
}

async function addExistingFigure(id) {
  const P = H.pk; const f = (P.figs || []).find(x => x.id === id);
  if (!f || !H.inst) return;
  busy(true);
  try {
    const ar = await new Promise(res => { const im = new Image(); im.onload = () => res(im.naturalWidth / Math.max(1, im.naturalHeight)); im.onerror = () => res(1.6); im.src = f.url; });
    await H.inst.addImageItem({ url: f.url, fullUrl: f.url, storagePath: '', ar, src: 'paper', srcLabel: `${f.name} — ${citeFor(P.paper)}`, paperId: P.paper.id, page: f.page || 0 });
  } finally { busy(false); }
}
async function addHighlight(id) {
  const P = H.pk; const h = (P.hls || []).find(x => x.id === id);
  if (!h || !H.inst) return;
  await H.inst.addTextItem({ text: h.quote, cite: citeFor(P.paper, h.page), src: 'paper', srcLabel: P.paper.title, paperId: P.paper.id, page: h.page || 0 });
}

function busy(on) {
  const body = $('nbb-picker').querySelector('[data-pk-body]');
  if (!body) return;
  let b = body.querySelector('.nbb-pk-busy');
  if (on) { if (!b) { b = document.createElement('div'); b.className = 'nbb-pk-busy'; b.textContent = 'Adding to the board…'; body.appendChild(b); } b.hidden = false; }
  else if (b) b.hidden = true;
}

/* ─── the PDF pane: the reader's viewer + hotspots + marquee ─── */
function pdfUrlFor(path) {
  return firebase.storage().ref().child(path).getDownloadURL().then(u => isLocalDev() ? '/api/library/pdf-proxy?url=' + encodeURIComponent(u) : u);
}
async function mountPdfPane() {
  const P = H.pk;
  const body = $('nbb-picker').querySelector('[data-pk-body]');
  if (!P.paper.pdf) { body.innerHTML = '<div class="nbb-pk-status">This paper has no PDF in the library.</div>'; return; }
  if (!window.PDF_VIEWER?.create) { body.innerHTML = '<div class="nbb-pk-status nbb-err">The PDF viewer did not load.</div>'; return; }
  const pane = document.createElement('div'); pane.className = 'nbb-pdf'; body.appendChild(pane);
  const status = document.createElement('div'); status.className = 'nbb-pk-status'; status.textContent = 'Opening the PDF…'; pane.appendChild(status);
  let url;
  try { url = await pdfUrlFor(P.paper.pdf); } catch (e) { status.textContent = 'Could not fetch the PDF: ' + (e.message || e); status.classList.add('nbb-err'); return; }
  if (!H.pk || H.pk.paper !== P.paper || H.pk.tab !== 'pages') return;
  try {
    status.remove();
    P.viewer = await window.PDF_VIEWER.create(pane, url, {
      fitToContainer: true, disableRange: true, disableStream: true,
      onPageReady: (p, node) => { if (H.pk && H.pk.viewer === P.viewer) addHotspots(p, node); }
    });
    wireMarquee(pane);
  } catch (e) { pane.innerHTML = `<div class="nbb-pk-status nbb-err">The PDF could not be opened: ${esc(e.message || e)}</div>`; }
}
function destroyViewer() {
  const P = H.pk;
  if (!P) return;
  if (P.viewer) { try { P.viewer.destroy(); } catch (e) {} P.viewer = null; }
  P.mq = null;
}

function addHotspots(pageNum, node) {
  const v = H.pk?.viewer;
  if (!v || !node?.wrap) return;
  let regions = [];
  try { regions = v.getFigureRegions(pageNum) || []; } catch (e) { regions = []; }
  let layer = node.wrap.querySelector('.nbb-hs-layer');
  if (!regions.length) { if (layer) layer.remove(); return; }
  if (!layer) { layer = document.createElement('div'); layer.className = 'nbb-hs-layer'; node.wrap.appendChild(layer); }
  layer.innerHTML = '';
  regions.forEach(r => {
    const hs = document.createElement('div');
    hs.className = 'nbb-hs';
    hs.style.left = r.x + 'px'; hs.style.top = r.y + 'px'; hs.style.width = r.width + 'px'; hs.style.height = r.height + 'px';
    const m = (r.label || '').match(/^\s*((?:extended\s+data\s+|supp(?:lementary)?\.?\s*)?(?:fig(?:ure)?|table|scheme)\.?\s*S?\d+)/i);
    const short = m ? m[1].replace(/\s+/g, ' ').trim() : 'Figure';
    hs.title = (r.label ? r.label + '\n' : '') + 'Click to add this to the board';
    const badge = document.createElement('span'); badge.className = 'nbb-hs-badge'; badge.textContent = '＋ ' + short; hs.appendChild(badge);
    let down = null;
    hs.addEventListener('pointerdown', (e) => { down = { x: e.clientX, y: e.clientY }; e.stopPropagation(); });
    hs.addEventListener('click', (e) => {
      const d = down; down = null;
      if (!d || Math.hypot(e.clientX - d.x, e.clientY - d.y) > 6) return;
      e.preventDefault(); e.stopPropagation();
      snipAndAdd(pageNum, { x: r.x, y: r.y, width: r.width, height: r.height }, short);
    });
    layer.appendChild(hs);
  });
}

/* a drag over the page: a red rectangle, then a tiny action bar */
function wireMarquee(pane) {
  let d = null;
  const clearMq = () => { pane.querySelectorAll('.nbb-mq, .nbb-mq-acts').forEach(n => n.remove()); if (H.pk) H.pk.mq = null; };
  pane.addEventListener('pointerdown', (e) => {
    if (e.target.closest('.nbb-mq-acts')) return;
    if (e.target.closest('.nbb-hs')) return;
    const wrap = e.target.closest('.pv-page-wrap');
    clearMq();
    if (!wrap) return;
    const pageNum = Number(wrap.dataset.page || wrap.dataset.pageNum || 0) || pageNumOf(wrap);
    const r = wrap.getBoundingClientRect();
    d = { wrap, pageNum, x0: e.clientX - r.left, y0: e.clientY - r.top, box: null, id: e.pointerId };
    e.preventDefault();
    try { pane.setPointerCapture(e.pointerId); } catch (err) {}
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
    H.pk.mq = { pageNum: cur.pageNum, rect: cur.rect, wrap: cur.wrap };
    const acts = document.createElement('div');
    acts.className = 'nbb-mq-acts';
    const below = cur.rect.y + cur.rect.height + 6;
    const wrapH = cur.wrap.clientHeight;
    acts.style.left = Math.max(0, cur.rect.x) + 'px';
    acts.style.top = (below + 40 < wrapH ? below : Math.max(0, cur.rect.y - 40)) + 'px';
    acts.innerHTML = `<button type="button" class="btn btn-small" data-mq="fig">${ICON.svg('photo')} Add as figure</button>
      <button type="button" class="btn btn-small" data-mq="text">𝑇 Add as text</button>
      <button type="button" class="btn btn-small btn-ghost" data-mq="x" title="Cancel">✕</button>`;
    acts.addEventListener('click', async (ev) => {
      const b = ev.target.closest('[data-mq]'); if (!b) return;
      ev.stopPropagation();
      const mq = H.pk?.mq; if (!mq) { clearMq(); return; }
      if (b.dataset.mq === 'fig') { await snipAndAdd(mq.pageNum, mq.rect, ''); }
      else if (b.dataset.mq === 'text') { await textAndAdd(mq.pageNum, mq.rect); }
      clearMq();
    });
    cur.wrap.appendChild(acts);
  };
  pane.addEventListener('pointerup', up);
  pane.addEventListener('pointercancel', up);
}
function pageNumOf(wrap) {
  const v = H.pk?.viewer; if (!v) return 1;
  for (let p = 1; p <= v.numPages; p++) { const n = v.getPageNode(p); if (n && n.wrap === wrap) return p; }
  return 1;
}

/* Re-render the region from the PDF at a snip-worthy scale (the picker's
   pages are small), crop, webp medium/full, upload, add. Rects are CSS px
   at the viewer's current zoom. */
async function snipAndAdd(pageNum, rect, label) {
  const P = H.pk; const v = P?.viewer;
  if (!v || !H.inst) return;
  busy(true);
  try {
    const doc = v.getPdfDocument?.();
    if (!doc) throw new Error('PDF document not ready');
    const z = v.zoom || 1;
    const nat = { x: rect.x / z, y: rect.y / z, w: rect.width / z, h: rect.height / z };
    const pad = 4;
    const page = await doc.getPage(pageNum);
    let s = Math.max(1.5, Math.min(4, 1600 / Math.max(60, nat.w)));
    const vp1 = page.getViewport({ scale: 1 });
    const maxSide = 4096;
    s = Math.min(s, maxSide / Math.max(vp1.width, vp1.height));
    const vp = page.getViewport({ scale: s });
    const full = document.createElement('canvas');
    full.width = Math.ceil(vp.width); full.height = Math.ceil(vp.height);
    const fctx = full.getContext('2d');
    fctx.fillStyle = '#fff'; fctx.fillRect(0, 0, full.width, full.height);
    await page.render({ canvasContext: fctx, viewport: vp }).promise;
    const sx = Math.max(0, (nat.x - pad) * s), sy = Math.max(0, (nat.y - pad) * s);
    const sw = Math.min(full.width - sx, (nat.w + 2 * pad) * s), sh = Math.min(full.height - sy, (nat.h + 2 * pad) * s);
    if (sw < 4 || sh < 4) throw new Error('region too small');
    const crop = document.createElement('canvas');
    crop.width = Math.round(sw); crop.height = Math.round(sh);
    const cctx = crop.getContext('2d');
    cctx.fillStyle = '#fff'; cctx.fillRect(0, 0, crop.width, crop.height);
    cctx.drawImage(full, sx, sy, sw, sh, 0, 0, crop.width, crop.height);
    const [medium, fullBlob] = await Promise.all([resizeToWebp(crop, SIZES.medium.max, SIZES.medium.q), resizeToWebp(crop, SIZES.full.max, SIZES.full.q)]);
    if (!medium || !fullBlob) throw new Error('image encode failed');
    const itemId = newId('i');
    const base = `notebook-boards/${OWNER}/${BOARD_ID}/items/${itemId}`;
    const ref = firebase.storage().ref();
    const put = async (name, blob) => { const c = ref.child(`${base}/${name}.webp`); await c.put(blob, { contentType: 'image/webp' }); return c.getDownloadURL(); };
    const url = await put('medium', medium);
    const fullUrl = await put('full', fullBlob);
    await H.inst.addImageItem({ itemId, url, fullUrl, storagePath: base, ar: crop.width / Math.max(1, crop.height),
      src: 'paper', srcLabel: `${label || 'Snip'} — ${citeFor(P.paper, pageNum)}`, paperId: P.paper.id, page: pageNum });
  } catch (e) {
    console.warn('[nbb] snip failed', e);
    toast('Could not add that region: ' + (e && e.message ? e.message : e));
  } finally { busy(false); }
}

/* The text layer's items inside the rectangle, in reading order. */
async function textAndAdd(pageNum, rect) {
  const P = H.pk; const v = P?.viewer;
  if (!v || !H.inst) return;
  const node = v.getPageNode(pageNum);
  const items = v.getTextItems(pageNum) || [];
  const k = (v.zoom || 1) / ((node && node.itemsZoom) || v.zoom || 1);
  const inside = items.filter(it => {
    const cx = (it.x + it.width / 2) * k, cy = (it.y + it.height / 2) * k;
    return cx >= rect.x && cx <= rect.x + rect.width && cy >= rect.y && cy <= rect.y + rect.height;
  });
  let text = inside.map(it => it.text).join(' ').replace(/-\s+(?=[a-z])/g, '').replace(/\s+/g, ' ').trim();
  if (!text) { toast('No text in that region — try "Add as figure".'); return; }
  await H.inst.addTextItem({ text, cite: citeFor(P.paper, pageNum), src: 'paper', srcLabel: P.paper.title, paperId: P.paper.id, page: pageNum });
}

function resizeToWebp(srcCanvas, max, q) {
  return new Promise((resolve) => {
    const sw = srcCanvas.width, sh = srcCanvas.height;
    const k = sw > max ? max / sw : 1;
    const c = document.createElement('canvas');
    c.width = Math.max(1, Math.round(sw * k)); c.height = Math.max(1, Math.round(sh * k));
    const ctx = c.getContext('2d');
    ctx.fillStyle = '#fff'; ctx.fillRect(0, 0, c.width, c.height);
    ctx.drawImage(srcCanvas, 0, 0, c.width, c.height);
    c.toBlob(b => resolve(b), 'image/webp', q);
  });
}

if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', boot);
else boot();

window.NOTEBOOK_BOARD = { _state: H, togglePicker, openReplay };
})();
