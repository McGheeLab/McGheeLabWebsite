/* ================================================================
   figure-board-canvas.js — V3.837 — a paper's FIGURE BOARD on the canvas
   engine (rm/pages/figure-board.html?paper=<id>; the paper builder's
   Figures tab shows it in an iframe, ⤢ opens it full-page).
   ================================================================
   The same system as the lab notebook canvas — the sheet is the board,
   radial pills carry pens · tools · widgets · zoom — with the figure
   board's own inputs:
     figcard     a planned figure (status planned → expected → collected)
     experiment  an experiment that feeds a figure (planned → running → done)
     snip        a reference figure from a paper in the library (＋ From paper)
     quote       a passage from a paper
     note · checklist (shared basic kinds)
     panel       a DRAWN REGION of ink turned into a panel: ⬚ Region, drag
                 a box, then "Make panel" — kept ink · hidden ink · deleted
                 ink. The panel is an image card with a letter and a caption;
                 collapsed it is one line; "Reopen the ink" brings the
                 strokes back.
     litref      a lit review from someone's notebook, showing only its key
                 points; placing it links every paper of the review to this
                 paper (LIBRARY_LINKS.toggleDraftLink), removing it unlinks.
   Wires (⟶ Connect) draw the narrative between cards, as the V3.609 arrows
   did. Per-card Discussion threads are the V3.611 boardComments, keyed by
   item id — the migration keeps the ids, so old threads stay attached.

   Data: papers/{paperId}/boards/main (+ strokes / items / wires /
   recordings / events). The V3.609 boardItems board migrates onto it on
   first open (cards → widgets with the same ids, arrows → wires).
   Storage: paper-boards/{paperId}/main/… (panels, snips, recordings).
   No browser popups anywhere.
   ================================================================ */
(function () {
'use strict';

const COLL = 'paperBoards';
const BOARD_ID = 'main';
const SIZES = { medium: { max: 800, q: 0.85 }, full: { max: 1600, q: 0.9 } };
const PAPERS_CACHE_KEY = 'nbb_papers_v1';
const PAPERS_CACHE_MS = 15 * 60 * 1000;
const THEME = { desk: '#E6E1D7', page: '#F1EDE5', edge: 'rgba(36,33,28,.10)', grid: 'rgba(36,33,28,.07)', ruled: 'rgba(13,103,94,.16)', divider: '#BCB4A4' };
const BOARD_H = 0.625;
const PX_PER_PAGE = 1400;   // the V3.609 world px that span one page width in the migration

const qs = new URLSearchParams(location.search);
const state = {
  paperId: qs.get('paper') || '', embed: qs.get('embed') === '1',
  uid: null, isAdmin: false, canEdit: false, paper: null,
  inst: null, mode: 'live', recs: [], recUnsub: null, repaired: new Set(),
  sideOpen: false, side: null, pk: null, full: false, region: null, commentsUnsub: null, commentCounts: {}, litUnsubs: {}
};

/* ─── helpers ─────────────────────────────────────────────────── */
function $(id) { return document.getElementById(id); }
const esc = (s) => CANVAS_WIDGETS.esc(s);
function isoNow() { return new Date().toISOString(); }
function newId(prefix) { return prefix + Date.now().toString(36) + Math.random().toString(36).slice(2, 7); }
function toast(kind, msg) { if (window.TOAST && TOAST[kind]) TOAST[kind](msg); else console.log('[figure-board]', kind, msg); }
function db() { return firebridge.db(); }
function FV() { return firebase.firestore.FieldValue; }
function boardRef() { return window.Whiteboard.boardsCol(state.paperId, COLL).doc(BOARD_ID); }
function fmtDur(ms) { const s = Math.max(0, Math.round((ms || 0) / 1000)); const m = Math.floor(s / 60); return `${m}:${String(s % 60).padStart(2, '0')}`; }
function fmtDate(ms) { try { return new Date(ms).toLocaleDateString(undefined, { month: 'short', day: 'numeric', year: 'numeric' }); } catch (e) { return ''; } }
function isLocalDev() { return /^(localhost|127\.0\.0\.1)$/.test(location.hostname); }
function installAuthShim() {
  const ML = window.McgheeLab = window.McgheeLab || {};
  if (!ML.db) ML.db = db();
  if (ML.Auth && ML.Auth.onChange) { if (!ML.Auth.currentUser && firebase.auth().currentUser) ML.Auth.currentUser = firebase.auth().currentUser; return ML.Auth; }
  const listeners = [];
  const Auth = { currentUser: firebase.auth().currentUser || null, currentProfile: null, onChange(fn) { listeners.push(fn); }, offChange(fn) { const i = listeners.indexOf(fn); if (i >= 0) listeners.splice(i, 1); } };
  ML.Auth = Auth;
  firebase.auth().onAuthStateChanged(async (user) => { Auth.currentUser = user || null; Auth.currentProfile = null; if (user) { try { const d = await ML.db.collection('users').doc(user.uid).get(); Auth.currentProfile = d.exists ? d.data() : null; } catch (e) {} } listeners.slice().forEach(fn => { try { fn(Auth.currentUser, Auth.currentProfile); } catch (e) {} }); });
  return Auth;
}

/* ================================================================
   boot
   ================================================================ */
async function boot() {
  const content = $('fbc-content');
  if (!state.paperId) { content.innerHTML = '<div class="nbk-gate">No paper given (expected ?paper=&lt;id&gt;).</div>'; return; }
  if (typeof firebridge === 'undefined' || !firebridge.requireSignIn) { content.innerHTML = '<div class="nbk-gate">The sign-in bridge did not load.</div>'; return; }
  const gate = await firebridge.requireSignIn('Sign in to open the figure board.');
  if (!gate.allowed) return;
  if (!firebridge.isLabMember()) { content.innerHTML = '<div class="nbk-gate">Your account is waiting for approval.</div>'; return; }
  if (!window.Whiteboard?.mountBoardView || !window.CANVAS_WIDGETS) { content.innerHTML = '<div class="nbk-gate">The canvas engine did not load — reload the page.</div>'; return; }
  state.uid = firebridge.getUser().uid; state.isAdmin = firebridge.isAdmin();
  installAuthShim();
  try { const s = await db().collection('papers').doc(state.paperId).get(); state.paper = s.exists ? s.data() : null; } catch (e) { state.paper = null; }
  if (!state.paper) { content.innerHTML = '<div class="nbk-gate">This paper could not be opened (missing, or not yours).</div>'; return; }
  const au = Array.isArray(state.paper.authorUids) ? state.paper.authorUids : [], mu = Array.isArray(state.paper.mentorUids) ? state.paper.mentorUids : [];
  state.canEdit = state.isAdmin || au.includes(state.uid) || mu.includes(state.uid);
  content.className = 'nbc-root fbc-root';
  content.innerHTML = `
    <div class="nbc-header fbc-header" id="fbc-header"></div>
    <div class="nbc-stage">
      <div class="nbb-main nbc-board">
        <div class="nbb-mount nbc-mount" id="nbb-mount"><div class="nbk-loading">Opening the board…</div></div>
        <aside class="nbb-picker" id="nbb-picker" hidden></aside>
        <aside class="nbc-side" id="nbc-side" hidden></aside>
      </div>
    </div>`;
  registerKinds();
  renderHeader();
  await ensureBoard();
  await mountLive();
  /* V3.853 — ?item=<id>: a My Week result points at one card; centre + pulse it */
  const wantItem = qs.get('item');
  if (wantItem && state.inst && state.inst.focusItem) state.inst.focusItem(wantItem);
  watchRecordings();
  watchComments();
  document.addEventListener('fullscreenchange', () => { if (!document.fullscreenElement && state.full) setFull(false, true); });
  document.addEventListener('keydown', (e) => { if (e.key === 'Escape' && state.full && !document.fullscreenElement && !document.querySelector('.cw-pop')) setFull(false); });
  window.addEventListener('beforeunload', () => { if (state.inst?.isRecording?.()) { try { state.inst.stopRecording('pagehide'); } catch (e) {} } });
}
function renderHeader() {
  const h = $('fbc-header'); if (!h) return;
  const title = state.paper?.title || state.paper?.short_title || 'Paper';
  h.innerHTML = `
    <a class="nbc-brand" href="/rm/pages/paper-builder.html?paper=${encodeURIComponent(state.paperId)}" target="_top" title="Back to the paper">FB</a>
    <span class="nbc-title nbc-title-empty" title="${esc(title)}">${esc(title)}</span>
    <div class="nbc-meta"><span>figure board</span>${state.canEdit ? '' : '<span>· read only</span>'}<span class="nbc-status" id="nbc-status"></span></div>
    <span class="spacer"></span>
    ${state.embed ? `<a class="nbc-ib" href="/rm/pages/figure-board.html?paper=${encodeURIComponent(state.paperId)}" target="_blank" rel="noopener" title="Open the board on its own page">⤢</a>` : ''}
    <button type="button" class="nbc-ib${state.full ? ' nbc-on' : ''}" data-h="full" title="${state.full ? 'Leave full screen (Esc)' : 'Full screen'}">⛶</button>`;
  h.querySelector('[data-h="full"]').addEventListener('click', () => setFull(!state.full));
}
function setFull(on, fromBrowser) {
  state.full = !!on;
  document.body.classList.toggle('nbc-full', state.full);
  if (state.full && !fromBrowser && document.documentElement.requestFullscreen && !document.fullscreenElement) { try { const p = document.documentElement.requestFullscreen(); if (p && p.catch) p.catch(() => {}); } catch (e) {} }
  if (!state.full && document.fullscreenElement && document.exitFullscreen) { try { const p = document.exitFullscreen(); if (p && p.catch) p.catch(() => {}); } catch (e) {} }
  renderHeader();
  if (state.inst) state.inst.setTools(toolsList());
  setTimeout(() => window.dispatchEvent(new Event('resize')), 60);
}

/* ─── the board doc + the V3.609 migration ─────────────────────── */
async function ensureBoard() {
  const ref = boardRef();
  const s = await ref.get();
  if (s.exists) return;
  if (!state.canEdit) return;
  /* read the old board (cards + arrows) to size the new one */
  let old = [];
  try { const snap = await db().collection('papers').doc(state.paperId).collection('boardItems').get(); old = snap.docs.map(d => Object.assign({ id: d.id }, d.data())); } catch (e) { old = []; }
  const cards = old.filter(x => x && x.type !== 'arrow' && typeof x.x === 'number' && typeof x.y === 'number');
  const arrows = old.filter(x => x && x.type === 'arrow' && x.from_id && x.to_id);
  let pagesN = 1;
  const minX = cards.length ? Math.min(...cards.map(c => c.x)) : 0, minY = cards.length ? Math.min(...cards.map(c => c.y)) : 0;
  const place = (c) => { const yU = 0.05 + (c.y - minY) / PX_PER_PAGE; const idx = Math.floor(yU / BOARD_H); return { idx, x: Math.min(0.85, 0.04 + (c.x - minX) / PX_PER_PAGE), y: yU - idx * BOARD_H, w: Math.max(0.14, Math.min(0.6, (c.w || 280) / PX_PER_PAGE)) }; };
  cards.forEach(c => { pagesN = Math.max(pagesN, place(c).idx + 1); });
  const pages = []; for (let i = 0; i < Math.min(pagesN, 12); i++) pages.push({ id: 'p' + (i + 1), background: 'grid' });
  await ref.set({ name: (state.paper?.title || 'Figure board'), pages, activePageId: 'p1', ownerUid: state.uid, sheetMode: 'continuous', sharedWithUids: [], migratedFrom: cards.length ? 'boardItems' : null, createdAt: FV().serverTimestamp(), updatedAt: FV().serverTimestamp() });
  if (!cards.length) return;
  const batch = db().batch(); let n = 0;
  const ms = (t) => (t && t.toMillis) ? t.toMillis() : (typeof t === 'number' ? t : Date.now());
  cards.forEach(c => {
    const p = place(c); const pageId = 'p' + Math.min(p.idx + 1, pages.length);
    let kind = 'note', data = {};
    const html = c.body_html != null ? c.body_html : String(c.body || '').replace(/[&<>"']/g, ch => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[ch])).replace(/\n/g, '<br>');
    if (c.type === 'figure') { kind = 'figcard'; data = { html, status: c.status || 'planned', url: c.image?.download_url || '', storagePath: c.image?.storage_path || '' }; }
    else if (c.type === 'experiment') { kind = 'experiment'; data = { html, status: c.status || 'planned' }; }
    else if (c.type === 'snip') { kind = 'snip'; data = { url: c.image?.download_url || '', fullUrl: c.image?.download_url || '', storagePath: c.image?.storage_path || '', ar: 1.5, paperId: c.source?.item_id || '', page: c.source?.page || 0, cite: '', html }; }
    else data = { html };
    batch.set(ref.collection('items').doc(c.id), { pageId, type: 'widget', kind, title: c.title || '', collapsed: false, x: +p.x.toFixed(4), y: +p.y.toFixed(4), w: +p.w.toFixed(4), ar: 1.6, z: ms(c.createdAt), stampAt: ms(c.createdAt), data,
      text: String(c.body || '').slice(0, 4000), url: '', fullUrl: '', storagePath: '', createdBy: c.created_by || state.uid, createdAt: FV().serverTimestamp(), updatedAt: FV().serverTimestamp(), migratedFrom: 'boardItems' });
    n++;
  });
  arrows.forEach(a => { batch.set(ref.collection('wires').doc(a.id), { from: a.from_id, to: a.to_id, rel: '', createdBy: a.created_by || state.uid, createdAt: FV().serverTimestamp() }); n++; });
  try { await batch.commit(); toast('success', `The figure board moved onto the canvas: ${cards.length} card${cards.length === 1 ? '' : 's'}${arrows.length ? ', ' + arrows.length + ' arrow' + (arrows.length === 1 ? '' : 's') : ''}.`); }
  catch (e) { console.warn('[figure-board] migration failed', e); toast('error', 'The old board could not be copied onto the canvas: ' + (e.message || e)); }
}

/* ================================================================
   the board
   ================================================================ */
function toolsList() {
  const n = state.recs.length; const tool = state.inst?.getTool?.();
  return [
    { act: 'region', icon: '⬚', label: tool === 'region' ? 'Back to the pen' : 'Region: draw a box around ink to make a panel', active: tool === 'region' },
    { act: 'connect', icon: '⟶', label: state.inst?.isConnecting?.() ? 'Stop connecting' : 'Connect two cards', active: !!state.inst?.isConnecting?.() },
    { act: 'paper', icon: 'document-text', label: 'From a paper in the library', active: !!($('nbb-picker') && !$('nbb-picker').hidden) },
    { act: 'litref', icon: 'books', label: 'Add a collection from your notebook' },
    { act: 'recs', icon: 'play', label: n ? `Recordings (${n})` : 'Recordings (none yet)', active: state.sideOpen && state.side === 'recs' },
    { act: 'max', icon: '⛶', label: state.full ? 'Leave full screen' : 'Full screen', active: !!state.full }
  ];
}
function insertList() { return CANVAS_WIDGETS.list({}).filter(k => !k.insertOnly && k.kind !== 'panel' && k.kind !== 'litref').map(k => ({ kind: k.kind, icon: k.icon, label: k.label })); }
async function insertKind(kind, at) {
  const def = CANVAS_WIDGETS.get(kind); if (!def || !state.inst) return null;
  if (def.insertOnly) { try { def.run({ at }); } catch (e) {} return null; }
  const spec = def.make ? def.make({}) : { title: '', data: {} }; if (!spec) return null;
  const id = await state.inst.addWidget(Object.assign({ kind: def.kind, w: def.w }, spec, at ? { pageId: at.pageId, x: at.x, y: at.y } : {}));
  if (id && def.focusAfter) setTimeout(() => { const n = document.querySelector(`.wb-item-widget[data-item-id="${CSS.escape(id)}"] ${def.focusAfter}`); CANVAS_WIDGETS.autoFocus(n); }, 350);
  return id;
}
function unmountBoard() {
  closePicker(); closeSide(); clearRegion();
  try { window.WhiteboardReplay?.teardown?.(); } catch (e) {}
  if (state.inst) { try { state.inst.destroy(); } catch (e) {} }
  state.inst = null; state.mode = 'live';
}
async function mountLive() {
  state.mode = 'live';
  const mount = $('nbb-mount');
  mount.innerHTML = window.Whiteboard.boardShellHTML({ classId: state.paperId, ids: false, back: false, zoomControls: false, maximize: false, topbar: false });
  state.inst = await window.Whiteboard.mountBoardView(mount.querySelector('.wb-page'), {
    classId: state.paperId, boardId: BOARD_ID, collection: COLL, ownerUid: state.uid, boardName: state.paper?.title || 'Figure board',
    chrome: 'full', view: { enabled: true }, items: { enabled: true }, pills: true, theme: THEME, canEdit: state.canEdit,
    mobile: mobileOption(),   /* V3.852 */
    report: { onReport: (it, btn) => reportToMyWeek(it, btn) },   /* V3.854 — ✓ at a card's top-left */
    wires: { enabled: true },
    tools: toolsList(),
    onTool: (act, btn) => {
      if (act === 'paper') togglePicker();
      else if (act === 'recs') toggleSide('recs');
      else if (act === 'max') setFull(!state.full);
      else if (act === 'region') { const on = state.inst.getTool() === 'region'; state.inst.setTool(on ? 'pen' : 'region'); clearRegion(); state.inst.setTools(toolsList()); if (!on) toast('info', 'Draw a box around the ink you want as a panel.'); }
      else if (act === 'connect') { const on = state.inst.isConnecting(); state.inst.setConnectMode(!on); state.inst.setTools(toolsList()); if (!on) toast('info', 'Tap the card the arrow starts from, then the card it points to.'); }
      else if (act === 'litref') openLitPicker(btn);
      else if (act === 'insert-more') CANVAS_WIDGETS.insertMenu({ anchor: btn, ctx: {}, title: 'Insert', onPick: (def) => insertKind(def.kind) });
    },
    inserts: insertList(),
    onInsert: (kind) => insertKind(kind),
    onSheetContext: (p) => CANVAS_WIDGETS.insertMenu({ point: { x: p.clientX, y: p.clientY }, ctx: {}, title: 'Insert here', onPick: (def) => insertKind(def.kind, p) }),
    onRegion: (rect, strokeIds) => showRegionActions(rect, strokeIds),
    onWire: (id, w, e) => wireMenu(id, w, e),
    onConnectDone: () => { state.inst?.setTools(toolsList()); toast('success', 'Connected. Tap the arrow to name the relation.'); },
    /* V3.856 — a wire that lands on a 📑 Collection / Claim materialises its entry (and claim evidence) */
    onWireAdded: (id, w) => window.CANVAS_PAPER_READER && window.CANVAS_PAPER_READER.onWireAdded(id, w),
    onWireUpdated: (id, w, before) => window.CANVAS_PAPER_READER && window.CANVAS_PAPER_READER.onWireUpdated(id, w, before),
    onWireRemoved: (id, w) => window.CANVAS_PAPER_READER && window.CANVAS_PAPER_READER.onWireRemoved(id, w),
    onDrop: (files, at) => dropFiles(files, at),   /* V3.841 — images → planned-figure cards, .html → frames */
    onPaste: (p) => pasteContent(p),               /* V3.841 — clipboard images → cards, text → a note */
    widgets: { render: renderWidget, renderSheet: renderWidgetSheet, menuItems: widgetMenuItems, meta: (k) => CANVAS_WIDGETS.meta(k), summary: (it) => CANVAS_WIDGETS.summary(it), onMenu: openWidgetMenu, onChange: () => { syncLitLinks(); try { window.CANVAS_PAPER_READER && CANVAS_PAPER_READER.onItemsChanged(); } catch (e) {} } }
  });
  if (!state.inst) { mount.innerHTML = '<div class="nbk-empty">Could not open the board.</div>'; return; }
  renderSide();
}
function renderWidget(item, body, api) {
  const def = CANVAS_WIDGETS.get(item.kind);
  if (!def || !def.render) { body.textContent = CANVAS_WIDGETS.summary(item) || '(unknown card)'; return; }
  try { def.render(item, body, api); } catch (e) { console.warn('[figure-board] widget render', item.kind, e); body.textContent = 'This card could not be rendered.'; }
}
/* V3.852 — one list for the desktop ⋯ popover AND the phone sheet (engine widgets.menuItems) */
/* ─── V3.854 — ✓ report this card (or region) as the result of one of MY My Week steps ───
   (a co-author reports to their own week). Same writer as My Week (V3.853). */
function reportToMyWeek(it, btn) {
  if (!window.MYWEEK_REPORT) { toast('error', 'My Week reporting is not loaded on this page.'); return; }
  if (!state.paperId || !it || !it.id) return;
  const d = MYWEEK_REPORT.describeCard(it);
  const card = {
    kind: 'figure_board_item', boardId: BOARD_ID, itemId: it.id, paperId: state.paperId, entryId: '',
    boardTitle: (state.paper && state.paper.title) || 'Figure board', item_kind: d.item_kind, title: d.title, thumb: d.thumb,
    url: '/rm/pages/figure-board.html?paper=' + encodeURIComponent(state.paperId) + '&item=' + encodeURIComponent(it.id),
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
  const n = state.commentCounts[item.id] || 0;
  return [
    ...(api.inSheet ? [] : [{ label: 'Card settings…', sub: 'Name, colour, width, connections', run: () => api.openSettings && api.openSettings() }]),   /* V3.852 */
    { label: 'Report as a My Week result…', sub: 'Point one of your steps at this card', run: () => reportToMyWeek(item, null) },   /* V3.854 */
    { label: item.collapsed ? 'Expand' : 'Collapse', run: () => api.collapse(!item.collapsed) },
    { label: n ? `Discussion (${n})` : 'Discussion…', sub: 'A thread for this card (mentors see it too)', run: () => openDiscussion(item) },
    { label: 'Bring to front', run: () => api.save({ z: Date.now() }) },
    ...((def && def.menu) ? (def.menu(item, api) || []) : []),
    (def && def.duplicate !== false && def.make) ? { label: 'Duplicate', run: () => state.inst.addWidget({ kind: item.kind, title: item.title, data: JSON.parse(JSON.stringify(item.data || {})), text: item.text || '', w: item.w, pageId: item.pageId, x: (item.x || 0) + 0.03, y: (item.y || 0) + 0.03 }) } : null,
    { label: 'Remove', sub: item.kind === 'litref' ? 'Also unlinks its papers from this paper' : 'Take this card off the board', danger: true, confirm: 'Really remove?', run: async () => { if (item.kind === 'litref') await unlinkLitRef(item); if (item.kind === 'panel' && item.data?.cleanup === 'hide') await state.inst.unhideStrokes(item.id); api.remove(); } }
  ];
}
function openWidgetMenu(item, btn, api) {
  const def = CANVAS_WIDGETS.get(item.kind);
  CANVAS_WIDGETS.actionMenu({ anchor: btn, items: widgetMenuItems(item, api), title: def ? def.label : item.kind });
}
function renderWidgetSheet(item, body, api) {
  const def = CANVAS_WIDGETS.get(item.kind);
  if (def && def.sheet) { try { def.sheet(item, body, api); } catch (e) { console.warn('[figure-board] widget sheet', item.kind, e); body.textContent = 'This card could not be opened.'; } return; }
  renderWidget(item, body, api);
}
/* V3.852 — read once at load: the page rewrites its own query string later (?entry=…), which would drop ?mobile= */
const MOBILE_OPT = (() => { try { const v = new URLSearchParams(location.search).get('mobile'); return v === '1' ? true : v === '0' ? false : 'auto'; } catch (e) { return 'auto'; } })();
function mobileOption() { return MOBILE_OPT; }

/* ─── ⬚ Region → panel ─────────────────────────────────────────── */
function clearRegion() { const b = document.querySelector('.fbc-region-acts'); if (b) b.remove(); state.region = null; }
function showRegionActions(rect, strokeIds) {
  clearRegion();
  if (!state.inst || !state.canEdit) return;
  state.region = { rect, strokeIds };
  const bar = document.createElement('div'); bar.className = 'fbc-region-acts';
  const n = strokeIds.length;
  bar.innerHTML = `<span class="fbc-region-n">${n ? `${n} stroke${n === 1 ? '' : 's'} in the box` : 'No ink in the box'}</span>
    ${n ? `<button type="button" class="btn btn-small btn-primary" data-r="keep">Make panel · keep the ink</button>
    <button type="button" class="btn btn-small" data-r="hide">Make panel · hide the ink</button>
    <button type="button" class="btn btn-small" data-r="delete">Make panel · delete the ink</button>` : ''}
    <button type="button" class="btn btn-small" data-r="fit">Zoom to it</button>
    <button type="button" class="btn btn-small btn-ghost" data-r="x" title="Cancel">✕</button>`;
  bar.addEventListener('click', async (e) => {
    const b = e.target.closest('[data-r]'); if (!b) return;
    const r = state.region; if (!r) { clearRegion(); return; }
    if (b.dataset.r === 'x') { clearRegion(); return; }
    if (b.dataset.r === 'fit') { state.inst.zoomToRect(r.rect); clearRegion(); return; }
    bar.querySelectorAll('button').forEach(x => { x.disabled = true; });
    await makePanel(r.rect, r.strokeIds, b.dataset.r);
    clearRegion();
    state.inst.setTool('pen'); state.inst.setTools(toolsList());
  });
  $('nbb-mount').appendChild(bar);
}
function nextLetter() {
  const n = (state.inst?.getItems() || []).filter(i => i.type === 'widget' && i.kind === 'panel').length;
  return String.fromCharCode(65 + (n % 26)) + (n >= 26 ? Math.floor(n / 26) : '');
}
async function makePanel(rect, strokeIds, cleanup) {
  if (!state.inst) return;
  toast('info', 'Making the panel…');
  try {
    const r = await state.inst.rasterizeRegion(rect, { strokeIds, pxPerPage: 2400 });
    if (!r || !r.blob) throw new Error('nothing to draw');
    const itemId = newId('i');
    const base = `paper-boards/${state.paperId}/${BOARD_ID}/panels/${itemId}`;
    const ref = firebase.storage().ref();
    const [medium, full] = await Promise.all([resizeToWebp(r.canvas, SIZES.medium.max, SIZES.medium.q), resizeToWebp(r.canvas, SIZES.full.max, SIZES.full.q)]);
    const put = async (name, blob) => { const c = ref.child(`${base}/${name}.webp`); await c.put(blob, { contentType: 'image/webp' }); return c.getDownloadURL(); };
    const url = await put('medium', medium || r.blob); const fullUrl = await put('full', full || r.blob);
    const letter = nextLetter();
    const id = await state.inst.addWidget({ itemId, kind: 'panel', title: letter, w: Math.max(0.12, rect.w), pageId: rect.pageId, x: rect.x, y: rect.y, avoidOverlap: false,
      data: { url, fullUrl, storagePath: base, ar: r.ar, letter, caption: '', sourceStrokeIds: strokeIds, cleanup: cleanup === 'keep' ? null : cleanup, from: 'ink' }, text: `Panel ${letter}` });
    if (!id) throw new Error('the card could not be written');
    if (cleanup === 'hide') await state.inst.hideStrokes(strokeIds, id);
    else if (cleanup === 'delete') state.inst.deleteStrokes(strokeIds);
    toast('success', `Panel ${letter} made${cleanup === 'hide' ? ' — the ink is folded under it' : cleanup === 'delete' ? ' — the ink is gone' : ''}.`);
  } catch (e) { console.warn('[figure-board] make panel', e); toast('error', 'Could not make the panel: ' + (e.message || e)); }
}
function resizeToWebp(srcCanvas, max, q) {
  return new Promise((resolve) => {
    const sw = srcCanvas.width, sh = srcCanvas.height; const k = sw > max ? max / sw : 1;
    const c = document.createElement('canvas'); c.width = Math.max(1, Math.round(sw * k)); c.height = Math.max(1, Math.round(sh * k));
    c.getContext('2d').drawImage(srcCanvas, 0, 0, c.width, c.height);
    try { c.toBlob(b => resolve(b), 'image/webp', q); } catch (e) { resolve(null); }
  });
}

/* ─── wires ─── */
const RELS = ['leads to', 'supports', 'contradicts', 'feeds', 'compares with', 'related'];
function wireMenu(id, w, e) {
  if (!state.inst || !state.canEdit) return;
  /* V3.856 — a wire from a paper card's node carries a reader TYPE (supports · refutes · informs …) */
  if (w && w.fromNode && window.CANVAS_PAPER_READER) { window.CANVAS_PAPER_READER.wireMenu(id, w, e); return; }
  CANVAS_WIDGETS.actionMenu({ point: { x: e.clientX, y: e.clientY }, title: w && w.rel ? w.rel : 'Arrow', items: [
    ...RELS.map(r => ({ label: (w && w.rel === r ? '✓ ' : '') + r, run: () => state.inst.updateWire(id, { rel: r }) })),
    { label: 'Reverse', run: () => state.inst.updateWire(id, { from: w.to, to: w.from }) },
    { label: 'Remove the arrow', danger: true, confirm: 'Really remove?', run: () => state.inst.removeWire(id) }
  ] });
}

/* ─── discussion threads (V3.611 boardComments, keyed by item id) ─── */
function watchComments() {
  if (state.commentsUnsub) { try { state.commentsUnsub(); } catch (e) {} }
  state.commentsUnsub = db().collection('papers').doc(state.paperId).collection('boardComments').onSnapshot(snap => {
    const c = {}; snap.docs.forEach(d => { const x = d.data(); if (x.item_id && !x.resolved) c[x.item_id] = (c[x.item_id] || 0) + 1; });
    state.commentCounts = c;
  }, err => console.warn('[figure-board] comments', err));
}
function openDiscussion(item) {
  if (!window.SECTION_COMMENTS) { toast('error', 'The discussion helper did not load.'); return; }
  openSide('thread', item);
}

/* ─── slide-over: recordings / a card's thread ─── */
function toggleSide(kind) { if (state.sideOpen && state.side === kind) closeSide(); else openSide(kind); }
function openSide(kind, item) {
  if (state.sideHandle) { try { state.sideHandle.unmount(); } catch (e) {} state.sideHandle = null; }
  state.sideOpen = true; state.side = kind; state.sideItem = item || null;
  renderSide(); if (state.inst) state.inst.setTools(toolsList());
}
function closeSide() { if (state.sideHandle) { try { state.sideHandle.unmount(); } catch (e) {} state.sideHandle = null; } state.sideOpen = false; state.side = null; renderSide(); if (state.inst) state.inst.setTools(toolsList()); }
function renderSide() {
  const box = $('nbc-side'); if (!box) return;
  if (!state.sideOpen || state.mode === 'replay') { box.hidden = true; box.innerHTML = ''; return; }
  box.hidden = false;
  if (state.side === 'thread' && state.sideItem) {
    box.innerHTML = `<div class="nbc-side-head"><span>${esc(state.sideItem.title || CANVAS_WIDGETS.meta(state.sideItem.kind)?.label || 'Card')}</span><button type="button" class="nbc-ib" data-side="close" title="Close">✕</button></div><div class="fbc-thread"></div>`;
    try { state.sideHandle = window.SECTION_COMMENTS.mount({ container: box.querySelector('.fbc-thread'), collectionPath: 'papers/' + state.paperId + '/boardComments', scope: { item_id: state.sideItem.id }, label: 'Discussion — how should this flow?' }); }
    catch (e) { box.querySelector('.fbc-thread').textContent = 'The thread could not be opened: ' + (e.message || e); }
  } else {
    box.innerHTML = `<div class="nbc-side-head"><span>Recordings</span><button type="button" class="nbc-ib" data-side="close" title="Close">✕</button></div>
      <div class="nbc-side-hint">${ICON.svg('microphone')} in the Tools pill records your voice with the ink and the cards; ${ICON.svg('play')} replays them together.</div>` +
      (state.recs.length ? state.recs.map(r => { const live = r.status === 'recording'; const dur = live ? '' : fmtDur(r.durationMs);
        return `<div class="nbb-rec">${live ? '<span class="nbb-rec-live"><span class="wb-live-dot"></span> recording now</span>' : `<button type="button" class="btn btn-small" data-nbb-play="${esc(r.id)}" title="Replay">${ICON.svg('play')}</button>`}<span class="nbb-rec-name">${esc(r.name || 'Recording')}</span><span class="nbb-rec-meta">${esc(fmtDate(r.startedAtMs))}${dur ? ' · ' + dur : ''}</span></div>`; }).join('')
        : '<div class="nbk-pick-empty">No recordings on this board yet.</div>');
  }
  if (!box.dataset.wired) { box.dataset.wired = '1'; box.addEventListener('click', (e) => { const b = e.target.closest('[data-nbb-play]'); if (b) openReplay(b.dataset.nbbPlay); if (e.target.closest('[data-side="close"]')) closeSide(); }); }
}
function recCol() { return boardRef().collection('recordings'); }
function watchRecordings() {
  if (state.recUnsub) { try { state.recUnsub(); } catch (e) {} }
  state.recUnsub = recCol().orderBy('startedAtMs', 'desc').onSnapshot(snap => {
    state.recs = snap.docs.map(d => ({ id: d.id, ...d.data() }));
    repairInterrupted(); if (state.side === 'recs') renderSide();
    if (state.inst && state.mode === 'live') state.inst.setTools(toolsList());
  }, err => console.warn('[figure-board] recordings', err));
}
function repairInterrupted() {
  if (!state.inst || !state.canEdit) return;
  let mine = null; try { mine = sessionStorage.getItem('wb_client'); } catch (e) {}
  const recordingNow = state.inst.isRecording?.();
  state.recs.forEach(r => {
    if (r.status !== 'recording' || state.repaired.has(r.id)) return;
    const own = recordingNow && r.recorderClientId === mine; const stale = (Date.now() - (r.startedAtMs || 0)) > 3 * 60 * 1000;
    if (own || !stale) return;
    state.repaired.add(r.id); state.inst.finalizeInterrupted(r.id).catch(e => console.warn('[figure-board] repair failed', e));
  });
}
async function openReplay(recId) {
  if (!state.inst) return;
  if (state.inst.isRecording?.()) { toast('info', 'Stop the recording first.'); return; }
  if (!window.WhiteboardReplay?.mount) { toast('error', 'Replay is not available.'); return; }
  closePicker(); closeSide(); clearRegion();
  try { state.inst.destroy(); } catch (e) {}
  state.inst = null; state.mode = 'replay';
  const mount = $('nbb-mount');
  mount.innerHTML = window.Whiteboard.boardShellHTML({ classId: state.paperId, ids: false, back: false, zoomControls: false, maximize: false, topbar: false });
  const inst = await window.Whiteboard.mountBoardView(mount.querySelector('.wb-page'), { classId: state.paperId, boardId: BOARD_ID, collection: COLL, ownerUid: state.uid, boardName: state.paper?.title || 'Figure board', chrome: 'full', replay: recId, view: { enabled: false }, items: { enabled: true }, theme: THEME, canEdit: state.canEdit,
    widgets: { render: renderWidget, meta: (k) => CANVAS_WIDGETS.meta(k), summary: (it) => CANVAS_WIDGETS.summary(it) } });
  if (!inst) { toast('error', 'Could not open the replay.'); await mountLive(); return; }
  state.inst = inst;
  window.WhiteboardReplay.mount({ classId: state.paperId, boardId: BOARD_ID, recId, handle: inst, coll: COLL, isAdmin: state.canEdit, noHash: true, onExit: () => backToLive(), onDeleted: () => backToLive() });
}
async function backToLive() { try { window.WhiteboardReplay?.teardown?.(); } catch (e) {} try { state.inst?.destroy(); } catch (e) {} state.inst = null; await mountLive(); }

/* ================================================================
   widget kinds
   ================================================================ */
const STATUS = { figcard: ['planned', 'expected', 'collected'], experiment: ['planned', 'running', 'done'] };
function registerKinds() {
  const R = CANVAS_WIDGETS.register, B = CANVAS_WIDGETS.basic;
  B.registerNote({ group: 'Writing', placeholder: 'Thinking out loud…', uploadImage: (f) => window.PAPER_FIGURES.uploadImage(state.paperId, f), fileInput: $('nbk-file-input'), toast });
  B.registerChecklist({ group: 'Writing' });
  /* V3.856 — 📖 Paper + 📑 Collection / claim (the board's own paper is the claim's draft) */
  if (window.CANVAS_PAPER_READER) window.CANVAS_PAPER_READER.registerKinds({ hostKind: 'figureboard', group: 'Figures', getInst: () => state.inst, toast, draftId: () => state.paperId, draftTitle: () => (state.paper && (state.paper.title || state.paper.short_title)) || 'This paper' });
  R({ kind: 'figcard', label: 'Planned figure', icon: 'test-tube', group: 'Figures', sub: 'What should this figure show? planned → expected → collected', w: 0.3,
    make: () => ({ title: 'Figure', data: { html: '', status: 'planned', url: '', storagePath: '' } }), render: (it, body, api) => renderCard(it, body, api, 'figcard'),
    menu: (it, api) => [{ label: it.data?.url ? 'Replace the image…' : 'Add an image…', run: () => pickImage(it, api) }],
    summary: (it) => `${it.data?.status || 'planned'}${it.data?.html ? ' · ' + B.plainText(it.data.html).slice(0, 80) : ''}`, text: (it) => `Figure (${it.data?.status || 'planned'}): ${B.plainText(it.data?.html)}` });
  R({ kind: 'experiment', label: 'Experiment', icon: 'microscope', group: 'Figures', sub: 'Method, conditions, n… planned → running → done', w: 0.28,
    make: () => ({ title: 'Experiment', data: { html: '', status: 'planned' } }), render: (it, body, api) => renderCard(it, body, api, 'experiment'),
    summary: (it) => `${it.data?.status || 'planned'}${it.data?.html ? ' · ' + B.plainText(it.data.html).slice(0, 80) : ''}`, text: (it) => `Experiment (${it.data?.status || 'planned'}): ${B.plainText(it.data?.html)}` });
  R({ kind: 'snip', label: 'Reference figure', icon: 'paper-clip', group: 'Figures', sub: 'A figure from a paper you read — why is it a good model?', w: 0.3, when: () => false,
    make: () => ({ title: '', data: { url: '', html: '' } }), render: renderSnip, duplicate: false,
    summary: (it) => (it.data?.cite || 'reference') + (it.data?.html ? ' · ' + B.plainText(it.data.html).slice(0, 60) : ''), text: (it) => `Reference: ${it.data?.cite || ''} ${B.plainText(it.data?.html)}` });
  /* V3.859 — 'quote' is registered by CANVAS_PAPER_READER: a one-passage 📑 Collection */
  R({ kind: 'panel', label: 'Panel', icon: 'table-cells', group: 'Figures', sub: 'A drawn region made into a panel', w: 0.3, when: () => false, duplicate: false,
    make: () => null, render: renderPanel,
    menu: (it, api) => {
      const d = it.data || {}; const out = [];
      if (d.cleanup === 'hide') out.push({ label: 'Reopen the ink', sub: 'Brings the strokes back and keeps the panel', run: async () => { await state.inst.unhideStrokes(it.id); api.saveData(Object.assign({}, d, { cleanup: null })); } });
      if (!d.cleanup && (d.sourceStrokeIds || []).length) {
        out.push({ label: 'Clean up: hide the ink under it', run: async () => { await state.inst.hideStrokes(d.sourceStrokeIds, it.id); api.saveData(Object.assign({}, d, { cleanup: 'hide' })); } });
        out.push({ label: 'Clean up: delete the ink under it', danger: true, confirm: 'Really delete the ink?', run: () => { state.inst.deleteStrokes(d.sourceStrokeIds); api.saveData(Object.assign({}, d, { cleanup: 'delete' })); } });
      }
      out.push({ label: 'Replace the image…', run: () => pickImage(it, api) });
      out.push({ label: 'Zoom to it', run: () => state.inst.zoomToRect({ pageId: it.pageId, x: it.x, y: it.y, w: it.w, h: it.w / (d.ar || 1.5) }) });
      return out;
    },
    summary: (it) => `${it.title || it.data?.letter || '?'}${it.data?.caption ? ' · ' + it.data.caption : ' · panel'}`, text: (it) => `Panel ${it.title || ''}: ${it.data?.caption || ''}` });
  R({ kind: 'litref', label: 'Lit review', icon: 'books', group: 'Figures', sub: 'Key points from a lit review in a notebook; its papers link to this paper', w: 0.34, when: () => false, duplicate: false,
    make: () => null, render: renderLitRef, summary: (it) => `${it.data?.title || 'lit review'} · ${(it.data?.paperIds || []).length} papers`, text: (it) => `Lit review: ${it.data?.title || ''} — ${(it.data?.keyPoints || []).join(' · ')}` });
  /* V3.841 — an .html file (a simulation, an interactive figure) in its own sandboxed frame */
  B.registerHtmlFrame({ group: 'Figures', upload: (f) => B.uploadCanvasFile(f, state.uid), toast });
}
/* ─── V3.841 paste from the clipboard ─── */
function textToHtml(text) { return String(text || '').replace(/\r\n?/g, '\n').trim().split(/\n{2,}/).map(par => `<p>${esc(par).replace(/\n/g, '<br>')}</p>`).join(''); }
async function pasteContent(p) {
  if (!state.inst || !state.canEdit || !p) return;
  if (p.files && p.files.length) { await dropFiles(p.files, p.at); return; }
  const B = CANVAS_WIDGETS.basic;
  let html = p.html ? B.sanitizeHtml(p.html) : '';
  if (!B.plainText(html)) html = textToHtml(p.text);
  if (!B.plainText(html)) return;
  const id = await state.inst.addWidget(Object.assign({ kind: 'note', w: 0.4, title: '', data: { html }, text: B.plainText(html).slice(0, 4000) }, p.at ? { pageId: p.at.pageId, x: p.at.x, y: p.at.y } : {}));
  if (id) toast('success', 'Pasted as a note card — drag it by its header.');
}
/* V3.841 — a card from a paper links back to the reader (the annotation, when known) */
function readerUrl(d) { return d && d.paperId ? `/rm/pages/library-paper.html?id=${encodeURIComponent(d.paperId)}${d.annId ? '#ann-' + encodeURIComponent(d.annId) : ''}` : ''; }
function readerLink(d) { const u = readerUrl(d); return u ? `<a class="nbc-open-paper" href="${esc(u)}" target="_blank" rel="noopener" title="Open this paper in the reader">${ICON.svg('document-text')} Open in the reader</a>` : ''; }
/* ─── V3.841 files dropped on the board ─── */
async function dropFiles(files, at) {
  if (!state.inst || !state.canEdit || !files || !files.length) return;
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
      try {
        toast('info', 'Uploading ' + f.name + '…');
        const up = await window.PAPER_FIGURES.uploadImage(state.paperId, f);
        await state.inst.addWidget(Object.assign({ kind: 'figcard', w: 0.3, title: String(f.name || 'Figure').replace(/\.[a-z0-9]+$/i, ''), data: { html: '', status: 'planned', url: up.download_url, fullUrl: up.download_url, storagePath: up.storage_path }, text: 'Figure (planned)' }, pos));
        k++;
      } catch (err) { toast('error', 'Upload failed: ' + (err.message || err)); }
    } else skipped++;
  }
  if (skipped) toast('info', 'Only images and .html files can be dropped on the board.');
}
function pickImage(it, api) {
  const inp = $('nbk-file-input');
  const once = async (e) => { inp.removeEventListener('change', once); const f = e.target.files && e.target.files[0]; e.target.value = ''; if (!f) return;
    try { toast('info', 'Uploading…'); const up = await window.PAPER_FIGURES.uploadImage(state.paperId, f); const d = Object.assign({}, it.data || {}, { url: up.download_url, fullUrl: up.download_url, storagePath: up.storage_path }); api.saveData(d, it.text || ''); api.refresh(); }
    catch (err) { toast('error', 'Upload failed: ' + (err.message || err)); } };
  inp.addEventListener('change', once); inp.click();
}
function statusChip(kind, d, api) {
  const cyc = STATUS[kind]; const cur = cyc.includes(d.status) ? d.status : cyc[0];
  const b = document.createElement('button'); b.type = 'button'; b.className = 'fbc-status fbc-status-' + cur; b.textContent = cur; b.title = api.canEdit() ? 'Click to advance the status' : cur;
  if (api.canEdit()) b.addEventListener('click', () => { d.status = cyc[(cyc.indexOf(cur) + 1) % cyc.length]; api.saveData(d, (kind === 'figcard' ? 'Figure' : 'Experiment') + ` (${d.status})`); api.refresh(); });
  return b;
}
function renderCard(it, body, api, kind) {
  const d = it.data || (it.data = {}); const ro = !api.canEdit();
  body.innerHTML = '';
  const top = document.createElement('div'); top.className = 'fbc-card-top'; top.appendChild(statusChip(kind, d, api)); body.appendChild(top);
  if (d.url) { const im = document.createElement('img'); im.className = 'fbc-card-img'; im.src = d.url; im.alt = ''; im.draggable = false; body.appendChild(im); }
  const ed = document.createElement('div'); ed.className = 'nbk-note' + (ro ? ' nbk-note-ro' : ''); ed.dataset.placeholder = kind === 'figcard' ? 'What should this figure show?' : 'Method · conditions · n…'; ed.innerHTML = d.html || '';
  if (!ro) { ed.contentEditable = 'true'; let t = null; const commit = () => { d.html = CANVAS_WIDGETS.basic.sanitizeHtml(ed.innerHTML); api.saveData(d, (kind === 'figcard' ? 'Figure' : 'Experiment') + ': ' + CANVAS_WIDGETS.basic.plainText(d.html)); };
    ed.addEventListener('input', () => { clearTimeout(t); t = setTimeout(commit, 400); }); ed.addEventListener('blur', () => { clearTimeout(t); commit(); });
    ed.addEventListener('paste', (e) => { const text = e.clipboardData?.getData('text/plain'); if (text) { e.preventDefault(); document.execCommand('insertText', false, text); } }); }
  body.appendChild(ed);
}
function renderSnip(it, body, api) {
  const d = it.data || (it.data = {}); const ro = !api.canEdit();
  body.innerHTML = `${d.url ? `<a href="${esc(d.fullUrl || d.url)}" target="_blank" rel="noopener"><img class="fbc-card-img" src="${esc(d.url)}" alt="" draggable="false"></a>` : '<div class="nbk-pick-empty">No image.</div>'}
    ${d.cite ? `<div class="nbc-cite">${esc(d.cite)}</div>` : ''}${readerLink(d)}
    <div class="nbk-note${ro ? ' nbk-note-ro' : ''}" ${ro ? '' : 'contenteditable="true"'} data-placeholder="Why is this figure a good model?">${d.html || ''}</div>`;
  if (ro) return;
  const ed = body.querySelector('.nbk-note'); let t = null;
  const commit = () => { d.html = CANVAS_WIDGETS.basic.sanitizeHtml(ed.innerHTML); api.saveData(d, `Reference: ${d.cite || ''} ${CANVAS_WIDGETS.basic.plainText(d.html)}`); };
  ed.addEventListener('input', () => { clearTimeout(t); t = setTimeout(commit, 400); }); ed.addEventListener('blur', () => { clearTimeout(t); commit(); });
}
function renderPanel(it, body, api) {
  const d = it.data || (it.data = {}); const ro = !api.canEdit();
  body.innerHTML = `<div class="fbc-panel${d.cleanup ? ' fbc-panel-clean' : ''}"><span class="fbc-letter">${esc(it.title || d.letter || '')}</span>${d.url ? `<img src="${esc(d.url)}" alt="" draggable="false">` : '<div class="nbk-pick-empty">No image.</div>'}</div>
    ${ro ? (d.caption ? `<div class="nbk-fig-cap-ro">${esc(d.caption)}</div>` : '') : `<input type="text" class="nbk-fig-cap" value="${esc(d.caption || '')}" placeholder="Caption…">`}
    ${d.cleanup === 'hide' ? '<div class="fbc-panel-note">ink folded under this panel · ⋯ Reopen the ink</div>' : ''}`;
  const cap = body.querySelector('.nbk-fig-cap');
  if (cap) { let t = null; cap.addEventListener('input', () => { d.caption = cap.value; clearTimeout(t); t = setTimeout(() => api.saveData(d, `Panel ${it.title || ''}: ${d.caption}`), 400); }); cap.addEventListener('blur', () => { clearTimeout(t); api.saveData(d, `Panel ${it.title || ''}: ${d.caption}`); }); }
}

/* ─── lit reviews: pick one, render its key points live, link its papers ─── */
async function openLitPicker(anchor) {
  if (!state.inst || !state.canEdit) return;
  let rows = [];
  try { const snap = await db().collection('userData').doc(state.uid).collection('litReviews').get(); rows = snap.docs.map(d => Object.assign({ id: d.id }, d.data())); } catch (e) { toast('error', 'Could not read your lit reviews: ' + (e.message || e)); return; }
  /* V3.859 — the ones linked to this paper first, then the newest */
  const linkedHere = (r) => Array.isArray(r.draftIds) && r.draftIds.includes(state.paperId);
  rows.sort((a, b) => (linkedHere(b) - linkedHere(a)) || String(b.updated_at || '').localeCompare(String(a.updated_at || '')));
  if (!rows.length) { toast('info', 'No collections yet — in the Lab Notebook, add a Collection from the ＋ pill and collect papers there.'); return; }
  const sub = (r) => (window.CANVAS_PAPER_READER ? CANVAS_PAPER_READER.mirrorSubline(r) : `${(r.paperIds || []).length} papers · ${(r.keyPoints || []).length} key points`) + (linkedHere(r) ? ' · linked to this paper' : '');
  CANVAS_WIDGETS.actionMenu({ anchor, title: 'Collections in your notebook', items: rows.slice(0, 16).map(r => ({ label: (linkedHere(r) ? '✎ ' : '') + (r.claim ? '◆ ' : '') + (r.title || 'Collection'), sub: sub(r), run: () => addLitRef(r) })) });
}
async function addLitRef(r) {
  const id = await state.inst.addWidget({ kind: 'litref', title: r.title || 'Lit review', w: 0.34, data: { ownerUid: state.uid, reviewId: r.id, boardId: r.boardId || '', entryId: r.entryId || '', title: r.title || '', paperIds: r.paperIds || [], keyPoints: r.keyPoints || [], linked: [] }, text: `Lit review: ${r.title || ''}` });
  if (id) {
    toast('success', `Collection added — linking ${(r.paperIds || []).length} paper${(r.paperIds || []).length === 1 ? '' : 's'} to this paper…`); syncLitLinks();
    if (window.CANVAS_PAPER_READER) CANVAS_PAPER_READER.linkSourceToDraft(r, state.paperId, (state.paper && (state.paper.title || state.paper.short_title)) || 'This paper');   /* V3.859 — the notebook card shows the link too */
  }
}
function renderLitRef(it, body, api) {
  const d = it.data || (it.data = {});
  const draw = (rev) => {
    const kp = (rev && rev.keyPoints) || d.keyPoints || [];
    const line = (rev && window.CANVAS_PAPER_READER) ? CANVAS_PAPER_READER.mirrorSubline(rev) : `${((rev && rev.paperIds) || d.paperIds || []).length} papers`;   /* V3.859 */
    body.innerHTML = `${rev && rev.claim ? `<div class="fbc-lit-claim">◆ Claim · ${esc(rev.claim.draftTitle || 'a paper draft')}</div>` : ''}<div class="fbc-lit-meta">${esc(rev?.title || d.title || 'Lit review')} · ${esc(line)}${d.entryId ? ` · <a href="/rm/pages/notebook.html?entry=${encodeURIComponent(d.entryId)}" target="_blank" rel="noopener">open in the notebook ↗</a>` : ''}</div>
      ${kp.length ? `<ul class="fbc-lit-points">${kp.map(k => `<li>${esc(typeof k === 'string' ? k : k.text || '')}</li>`).join('')}</ul>` : '<div class="nbk-pick-empty">No key points distilled yet.</div>'}`;
  };
  draw(null);
  if (d.ownerUid && d.reviewId) {
    const key = it.id;
    if (state.litUnsubs[key]) { try { state.litUnsubs[key](); } catch (e) {} }
    state.litUnsubs[key] = db().collection('userData').doc(d.ownerUid).collection('litReviews').doc(d.reviewId).onSnapshot(s => {
      if (!body.isConnected) { try { state.litUnsubs[key](); } catch (e) {} delete state.litUnsubs[key]; return; }
      const rev = s.exists ? s.data() : null; draw(rev);
      if (rev && api.canEdit()) {
        const ids = rev.paperIds || [];
        const changed = JSON.stringify(ids) !== JSON.stringify(d.paperIds || []) || JSON.stringify(rev.keyPoints || []) !== JSON.stringify(d.keyPoints || []) || (rev.title || '') !== (d.title || '');
        if (changed) { d.paperIds = ids; d.keyPoints = rev.keyPoints || []; d.title = rev.title || d.title; api.saveData(d, `Lit review: ${d.title}`); syncLitLinks(); }
      }
    }, err => console.warn('[figure-board] lit review', err));
  }
}
/* every paper of every lit review on this board is linked to the paper being written */
let _linkBusy = false;
async function syncLitLinks() {
  if (_linkBusy || !state.inst || !state.canEdit || !window.LIBRARY_LINKS) return;
  const refs = state.inst.getItems().filter(i => i.type === 'widget' && i.kind === 'litref');
  const todo = [];
  refs.forEach(r => { const linked = new Set(r.data?.linked || []); (r.data?.paperIds || []).forEach(pid => { if (!linked.has(pid)) todo.push({ r, pid }); }); });
  if (!todo.length) return;
  _linkBusy = true;
  try {
    for (const { r, pid } of todo) {
      try { await window.LIBRARY_LINKS.toggleDraftLink(pid, state.paperId, true); } catch (e) { console.warn('[figure-board] link failed', pid, e); continue; }
      const cur = state.inst.getItems().find(x => x.id === r.id); if (!cur) continue;
      const linked = Array.from(new Set([...(cur.data?.linked || []), pid]));
      await state.inst.updateItem(r.id, { data: Object.assign({}, cur.data, { linked }) });
    }
  } finally { _linkBusy = false; }
}
async function unlinkLitRef(item) {
  if (!window.LIBRARY_LINKS) return;
  const mine = new Set(item.data?.linked || []);
  /* a paper another review on this board also brought stays linked */
  state.inst.getItems().filter(i => i.type === 'widget' && i.kind === 'litref' && i.id !== item.id).forEach(o => (o.data?.linked || []).forEach(p => mine.delete(p)));
  for (const pid of mine) { try { await window.LIBRARY_LINKS.toggleDraftLink(pid, state.paperId, false); } catch (e) { console.warn('[figure-board] unlink failed', pid, e); } }
  if (mine.size) toast('info', `Unlinked ${mine.size} paper${mine.size === 1 ? '' : 's'} from this paper.`);
}

/* ================================================================
   ＋ From paper — the picker (the notebook's, adding snips here)
   ================================================================ */
function togglePicker() {
  const pk = $('nbb-picker');
  if (!pk.hidden) { closePicker(); return; }
  if (!state.canEdit) { toast('info', 'Only the paper\'s authors can add to the board.'); return; }
  pk.hidden = false;
  if (!state.pk) state.pk = { papers: null, q: '', paper: null, tab: 'pages', viewer: null, figs: null, hls: null, mq: null };
  renderPicker(); state.inst?.setTools(toolsList());
}
function closePicker() { const pk = $('nbb-picker'); if (!pk || pk.hidden) return; destroyViewer(); pk.hidden = true; if (state.pk) state.pk.paper = null; state.inst?.setTools(toolsList()); }
function renderPicker() {
  const pk = $('nbb-picker'); const P = state.pk;
  if (!P.paper) {
    pk.innerHTML = `<div class="nbb-pk-head"><span class="nbb-pk-title">From a paper in the library</span><button type="button" class="btn btn-small btn-ghost" data-pk="close" title="Close">✕</button></div>
      <div class="nbb-pk-search"><input type="search" data-pk-q placeholder="Search title, author, year, journal…" value="${esc(P.q)}" autocomplete="off"></div>
      <div class="nbb-pk-sel-row"><button type="button" class="nbb-pk-sel" data-pk="selected" title="Every highlight and figure selected for this paper in the reader, across the library">${ICON.svg('pin')} Highlights &amp; figures selected for this paper</button></div>
      <div class="nbb-pk-list" data-pk-list><div class="nbb-pk-status">Loading the library…</div></div>`;
    wirePicker();
    loadPapers().then(() => renderPaperList()).catch(e => { const l = pk.querySelector('[data-pk-list]'); if (l) l.innerHTML = `<div class="nbb-pk-status nbb-err">Could not load the library: ${esc(e.message || e)}</div>`; });
    const q = pk.querySelector('[data-pk-q]'); if (q) setTimeout(() => CANVAS_WIDGETS.autoFocus(q), 50);
    return;
  }
  const p = P.paper;
  pk.innerHTML = `<div class="nbb-pk-head"><button type="button" class="btn btn-small btn-ghost" data-pk="back" title="Back">←</button><span class="nbb-pk-title" title="${esc(p.title)}">${esc(p.title)}</span><button type="button" class="btn btn-small btn-ghost" data-pk="close" title="Close">✕</button></div>
    <div class="nbb-pk-tabs">${p.selected ? '' : `<button type="button" class="nbb-pk-tab${P.tab === 'pages' ? ' nbb-sel' : ''}" data-pk-tab="pages">${ICON.svg('document-text')} Pages</button>`}<button type="button" class="nbb-pk-tab${P.tab === 'figs' ? ' nbb-sel' : ''}" data-pk-tab="figs">${ICON.svg('photo')} Figures${P.figs ? ` (${P.figs.length})` : ''}</button><button type="button" class="nbb-pk-tab${P.tab === 'hls' ? ' nbb-sel' : ''}" data-pk-tab="hls">${ICON.svg('highlighter')} Highlights${P.hls ? ` (${P.hls.length})` : ''}</button></div>
    ${P.tab === 'pages' ? `<div class="nbb-pk-hint">Click a dashed figure box to add it as a reference figure. Drag over any region for <b>Add as figure</b> / <b>Add as text</b>.<span style="float:right;white-space:nowrap"><button type="button" class="btn btn-small btn-ghost" data-pk="zoom-out">−</button> <button type="button" class="btn btn-small btn-ghost" data-pk="zoom-in">+</button></span></div>` : ''}
    <div class="nbb-pk-body" data-pk-body></div>`;
  wirePicker();
  if (P.tab === 'pages') mountPdfPane(); else if (P.tab === 'figs') renderFigs(); else renderHls();
}
function wirePicker() {
  const pk = $('nbb-picker'); if (pk.dataset.wired) return; pk.dataset.wired = '1';
  pk.addEventListener('click', (e) => {
    const b = e.target.closest('[data-pk],[data-pk-tab],[data-pk-open],[data-pk-fig],[data-pk-hl]'); if (!b) return; const P = state.pk;
    if (b.dataset.pk === 'close') { closePicker(); return; }
    if (b.dataset.pk === 'back') { destroyViewer(); P.paper = null; P.figs = null; P.hls = null; renderPicker(); return; }
    if (b.dataset.pk === 'selected') { openSelected(); return; }
    if (b.dataset.pk === 'zoom-in') { P.viewer?.zoomIn(); return; } if (b.dataset.pk === 'zoom-out') { P.viewer?.zoomOut(); return; }
    if (b.dataset.pkTab) { if (P.tab !== b.dataset.pkTab) { destroyViewer(); P.tab = b.dataset.pkTab; renderPicker(); } return; }
    if (b.dataset.pkOpen) { const row = (P.papers || []).find(r => r.id === b.dataset.pkOpen); if (row) openPaper(row); return; }
    if (b.dataset.pkFig) { addExistingFigure(b.dataset.pkFig); return; }
    if (b.dataset.pkHl) { addHighlight(b.dataset.pkHl); return; }
  });
  pk.addEventListener('input', (e) => { const q = e.target.closest('[data-pk-q]'); if (!q) return; state.pk.q = q.value; renderPaperList(); });
}
async function loadPapers() {
  const P = state.pk; if (P.papers) return P.papers;
  try { const raw = sessionStorage.getItem(PAPERS_CACHE_KEY); if (raw) { const c = JSON.parse(raw); if (c && Date.now() - c.at < PAPERS_CACHE_MS && Array.isArray(c.rows)) { P.papers = c.rows; return P.papers; } } } catch (e) {}
  const snap = await db().collection('items').where('type', '==', 'paper').get(); const rows = [];
  snap.forEach(d => { const x = d.data(); const lib = (x.meta && x.meta.library) || {}; if (!lib.is_library_entry) return; const authors = Array.isArray(lib.authors) ? lib.authors : []; const fam = (a) => (a && (a.family || a.last || a.name)) || '';
    rows.push({ id: d.id, title: x.title || '(untitled)', year: lib.year || '', journal: lib.journal_iso || lib.journal || '', first: fam(authors[0]), second: fam(authors[1]), nAuthors: authors.length, pdf: lib.pdf && lib.pdf.storage_path ? lib.pdf.storage_path : '', hay: [x.title, ...authors.map(fam), lib.year, lib.journal, lib.doi].filter(Boolean).join(' ').toLowerCase(), added: lib.date_added || x.updated_at || '', linked: Array.isArray(lib.linked_drafts) && lib.linked_drafts.includes(state.paperId) }); });
  rows.sort((a, b) => (b.linked - a.linked) || String(b.added).localeCompare(String(a.added)));
  P.papers = rows; try { sessionStorage.setItem(PAPERS_CACHE_KEY, JSON.stringify({ at: Date.now(), rows })); } catch (e) {}
  return rows;
}
/* ─── V3.841 "Selected for this paper": every highlight / figure cited in THIS paper, across the library ─── */
function paperRow(id, x) {
  const lib = (x.meta && x.meta.library) || {}; const authors = Array.isArray(lib.authors) ? lib.authors : []; const fam = (a) => (a && (a.family || a.last || a.name)) || '';
  return { id, title: x.title || '(untitled)', year: lib.year || '', journal: lib.journal_iso || lib.journal || '', first: fam(authors[0]), second: fam(authors[1]), nAuthors: authors.length, pdf: lib.pdf && lib.pdf.storage_path ? lib.pdf.storage_path : '' };
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
    catch (e) { console.warn('[figure-board] selected annotations', row.id, e); return; }
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
function openSelected() {
  const P = state.pk; destroyViewer();
  P.paper = { id: '__selected__', title: 'Selected for this paper', selected: true, draftId: state.paperId, first: '', nAuthors: 0, year: '', pdf: '' };
  P.tab = 'figs'; P.figs = null; P.hls = null; renderPicker();
  const me = P.paper;
  loadSelectedFor(state.paperId).then(r => { if (state.pk && state.pk.paper === me) { P.figs = r.figs; P.hls = r.hls; P.selPapers = r.papers; renderPicker(); } })
    .catch(e => { console.warn('[figure-board] selected for', e); if (state.pk && state.pk.paper === me) { P.figs = []; P.hls = []; renderPicker(); } });
}
function renderPaperList() {
  const list = $('nbb-picker').querySelector('[data-pk-list]'); if (!list || !state.pk) return;
  const terms = (state.pk.q || '').trim().toLowerCase().split(/\s+/).filter(Boolean);
  const rows = (state.pk.papers || []).filter(r => terms.every(t => r.hay.includes(t))).slice(0, 80);
  if (!rows.length) { list.innerHTML = `<div class="nbb-pk-status">${state.pk.papers?.length ? 'No paper matches.' : 'The library is empty.'}</div>`; return; }
  list.innerHTML = rows.map(r => `<button type="button" class="nbb-pk-row${r.pdf ? '' : ' nbb-pk-row-nopdf'}" data-pk-open="${esc(r.id)}"><div class="nbb-pk-row-title">${esc(r.title)}</div><div class="nbb-pk-row-meta">${esc(citeFor(r))}${r.journal ? ' · ' + esc(r.journal) : ''}${r.linked ? ' · linked to this paper' : ''}${r.pdf ? '' : ' · no PDF'}</div></button>`).join('');
}
function citeFor(r, page) { let who = r.first || 'Unknown'; if (r.nAuthors === 2 && r.second) who = `${r.first} & ${r.second}`; else if (r.nAuthors > 2) who = `${r.first} et al.`; return `${who}${r.year ? ', ' + r.year : ''}${page ? ', p. ' + page : ''}`; }
async function openPaper(row) { const P = state.pk; P.paper = row; P.tab = row.pdf ? 'pages' : 'figs'; P.figs = null; P.hls = null; renderPicker(); loadAnnotations(row.id).then(() => { if (state.pk && state.pk.paper === row) renderPicker(); }).catch(e => console.warn('[figure-board] annotations', e)); }
async function loadAnnotations(paperId) {
  const P = state.pk; const col = db().collection('papers').doc(paperId).collection('annotations');
  const [lab, mine] = await Promise.all([col.where('visibility', '==', 'lab').get(), col.where('creator.uid', '==', state.uid).where('visibility', '==', 'private').get()]);
  const seen = new Set(); const all = []; [lab, mine].forEach(s => s.forEach(d => { if (seen.has(d.id)) return; seen.add(d.id); all.push({ id: d.id, ...d.data() }); }));
  const quoteOf = (a) => { const pg = a.target && Array.isArray(a.target.pages) ? a.target.pages : []; for (const p of pg) { const q = p && p.selectors && p.selectors.textQuote && p.selectors.textQuote.exact; if (q) return String(q); } return ''; };
  const pageOf = (a) => { const pg = a.target && Array.isArray(a.target.pages) ? a.target.pages : []; return pg[0] && pg[0].page || 0; };
  P.figs = all.filter(a => a.kind === 'figure' && a.image && a.image.download_url).map(a => ({ id: a.id, name: a.name || 'Figure', url: a.image.download_url, storagePath: a.image.storage_path || '', thumb: a.snip_data_uri || '', page: pageOf(a), by: (a.creator && a.creator.displayName) || '' }));
  P.hls = all.filter(a => a.kind !== 'figure' && a.kind !== 'equation' && quoteOf(a)).map(a => ({ id: a.id, quote: quoteOf(a), page: pageOf(a), color: a.color_id || 'yellow', comment: a.comment || '', mine: a.creator && a.creator.uid === state.uid }));
  P.figs.sort((a, b) => (a.page || 0) - (b.page || 0)); P.hls.sort((a, b) => (a.page || 0) - (b.page || 0));
}
const HL_HEX = { yellow: '#fde047', green: '#86efac', red: '#fca5a5', blue: '#93c5fd', purple: '#d8b4fe', orange: '#fdba74' };
function renderFigs() { const body = $('nbb-picker').querySelector('[data-pk-body]'); const P = state.pk; if (!P.figs) { body.innerHTML = '<div class="nbb-pk-status">Loading…</div>'; return; } if (!P.figs.length) { body.innerHTML = '<div class="nbb-pk-status">No figures snipped from this paper yet. Use ' + ICON.svg('document-text') + ' Pages to snip one.</div>'; return; }
  body.innerHTML = P.figs.map(f => `<button type="button" class="nbb-fig" data-pk-fig="${esc(f.id)}"><img src="${esc(f.thumb || f.url)}" alt=""><span><div class="nbb-fig-name">${esc(f.name)}</div><div class="nbb-fig-meta">${f.paper ? esc(citeFor(f.paper)) + ' · ' : ''}${f.page ? 'p. ' + f.page : ''}${f.by ? ' · snipped by ' + esc(f.by) : ''}</div></span></button>`).join(''); }
function renderHls() { const body = $('nbb-picker').querySelector('[data-pk-body]'); const P = state.pk; if (!P.hls) { body.innerHTML = '<div class="nbb-pk-status">Loading…</div>'; return; } if (!P.hls.length) { body.innerHTML = '<div class="nbb-pk-status">No highlights on this paper yet.</div>'; return; }
  body.innerHTML = P.hls.map(h => `<button type="button" class="nbb-hl" data-pk-hl="${esc(h.id)}" style="border-left-color:${HL_HEX[h.color] || HL_HEX.yellow}"><div class="nbb-hl-quote">${esc(h.quote)}</div><div class="nbb-hl-meta">${h.paper ? esc(citeFor(h.paper)) + ' · ' : ''}${h.page ? 'p. ' + h.page : ''}${h.comment ? ' · ' + esc(h.comment.slice(0, 80)) : ''}${h.mine ? '' : ' · lab'}</div></button>`).join(''); }
async function addSnipWidget(meta) {
  return state.inst.addWidget({ kind: 'snip', title: meta.label || '', w: 0.3, data: { url: meta.url, fullUrl: meta.fullUrl || meta.url, storagePath: meta.storagePath || '', ar: meta.ar || 1.5, paperId: meta.paperId || '', page: meta.page || 0, annId: meta.annId || '', cite: meta.cite || '', html: '' }, text: `Reference: ${meta.cite || ''}` });
}
async function addExistingFigure(id) {
  const P = state.pk; const f = (P.figs || []).find(x => x.id === id); if (!f || !state.inst) return;
  busy(true);
  try { const ar = await new Promise(res => { const im = new Image(); im.onload = () => res(im.naturalWidth / Math.max(1, im.naturalHeight)); im.onerror = () => res(1.6); im.src = f.url; });
    const src = f.paper || P.paper;
    await addSnipWidget({ url: f.url, storagePath: f.storagePath, ar, label: f.name, paperId: src.id, page: f.page || 0, annId: f.id, cite: citeFor(src, f.page) }); }
  finally { busy(false); }
}
async function addHighlight(id) { const P = state.pk; const h = (P.hls || []).find(x => x.id === id); if (!h || !state.inst) return; const src = h.paper || P.paper; if (window.CANVAS_PAPER_READER) await CANVAS_PAPER_READER.addQuoteCard({ paperId: src.id, annId: h.id, quote: h.quote, cite: citeFor(src, h.page), page: h.page || 0, colorId: h.color, w: 0.36 }); }   /* V3.859 */
function busy(on) { const body = $('nbb-picker').querySelector('[data-pk-body]'); if (!body) return; let b = body.querySelector('.nbb-pk-busy'); if (on) { if (!b) { b = document.createElement('div'); b.className = 'nbb-pk-busy'; b.textContent = 'Adding to the board…'; body.appendChild(b); } b.hidden = false; } else if (b) b.hidden = true; }
function pdfUrlFor(path) { return firebase.storage().ref().child(path).getDownloadURL().then(u => isLocalDev() ? '/api/library/pdf-proxy?url=' + encodeURIComponent(u) : u); }
async function mountPdfPane() {
  const P = state.pk; const body = $('nbb-picker').querySelector('[data-pk-body]');
  if (!P.paper.pdf) { body.innerHTML = '<div class="nbb-pk-status">This paper has no PDF in the library.</div>'; return; }
  if (!window.PDF_VIEWER?.create) { body.innerHTML = '<div class="nbb-pk-status nbb-err">The PDF viewer did not load.</div>'; return; }
  const pane = document.createElement('div'); pane.className = 'nbb-pdf'; body.appendChild(pane);
  const status = document.createElement('div'); status.className = 'nbb-pk-status'; status.textContent = 'Opening the PDF…'; pane.appendChild(status);
  let url; try { url = await pdfUrlFor(P.paper.pdf); } catch (e) { status.textContent = 'Could not fetch the PDF: ' + (e.message || e); status.classList.add('nbb-err'); return; }
  if (!state.pk || state.pk.paper !== P.paper || state.pk.tab !== 'pages') return;
  try { status.remove(); P.viewer = await window.PDF_VIEWER.create(pane, url, { fitToContainer: true, disableRange: true, disableStream: true, onPageReady: (p, node) => { if (state.pk && state.pk.viewer === P.viewer) addHotspots(p, node); } }); wireMarquee(pane); }
  catch (e) { pane.innerHTML = `<div class="nbb-pk-status nbb-err">The PDF could not be opened: ${esc(e.message || e)}</div>`; }
}
function destroyViewer() { const P = state.pk; if (!P) return; if (P.viewer) { try { P.viewer.destroy(); } catch (e) {} P.viewer = null; } P.mq = null; }
function addHotspots(pageNum, node) {
  const v = state.pk?.viewer; if (!v || !node?.wrap) return; let regions = []; try { regions = v.getFigureRegions(pageNum) || []; } catch (e) {}
  let layer = node.wrap.querySelector('.nbb-hs-layer'); if (!regions.length) { if (layer) layer.remove(); return; }
  if (!layer) { layer = document.createElement('div'); layer.className = 'nbb-hs-layer'; node.wrap.appendChild(layer); } layer.innerHTML = '';
  regions.forEach(r => { const hs = document.createElement('div'); hs.className = 'nbb-hs'; hs.style.left = r.x + 'px'; hs.style.top = r.y + 'px'; hs.style.width = r.width + 'px'; hs.style.height = r.height + 'px';
    const m = (r.label || '').match(/^\s*((?:extended\s+data\s+|supp(?:lementary)?\.?\s*)?(?:fig(?:ure)?|table|scheme)\.?\s*S?\d+)/i); const short = m ? m[1].replace(/\s+/g, ' ').trim() : 'Figure';
    hs.title = (r.label ? r.label + '\n' : '') + 'Click to add this as a reference figure'; const badge = document.createElement('span'); badge.className = 'nbb-hs-badge'; badge.textContent = '＋ ' + short; hs.appendChild(badge);
    let down = null; hs.addEventListener('pointerdown', (e) => { down = { x: e.clientX, y: e.clientY }; e.stopPropagation(); });
    hs.addEventListener('click', (e) => { const d = down; down = null; if (!d || Math.hypot(e.clientX - d.x, e.clientY - d.y) > 6) return; e.preventDefault(); e.stopPropagation(); snipAndAdd(pageNum, { x: r.x, y: r.y, width: r.width, height: r.height }, short); });
    layer.appendChild(hs); });
}
function wireMarquee(pane) {
  let d = null; const clearMq = () => { pane.querySelectorAll('.nbb-mq, .nbb-mq-acts').forEach(n => n.remove()); if (state.pk) state.pk.mq = null; };
  pane.addEventListener('pointerdown', (e) => { if (e.target.closest('.nbb-mq-acts') || e.target.closest('.nbb-hs')) return; const wrap = e.target.closest('.pv-page-wrap'); clearMq(); if (!wrap) return;
    const pageNum = Number(wrap.dataset.page || wrap.dataset.pageNum || 0) || pageNumOf(wrap); const r = wrap.getBoundingClientRect(); d = { wrap, pageNum, x0: e.clientX - r.left, y0: e.clientY - r.top, box: null, id: e.pointerId }; e.preventDefault(); try { pane.setPointerCapture(e.pointerId); } catch (err) {} });
  pane.addEventListener('pointermove', (e) => { if (!d) return; const r = d.wrap.getBoundingClientRect(); const x1 = Math.max(0, Math.min(r.width, e.clientX - r.left)), y1 = Math.max(0, Math.min(r.height, e.clientY - r.top)); const x = Math.min(d.x0, x1), y = Math.min(d.y0, y1), w = Math.abs(x1 - d.x0), h = Math.abs(y1 - d.y0);
    if (!d.box) { if (w < 6 && h < 6) return; d.box = document.createElement('div'); d.box.className = 'nbb-mq'; d.wrap.appendChild(d.box); } Object.assign(d.box.style, { left: x + 'px', top: y + 'px', width: w + 'px', height: h + 'px' }); d.rect = { x, y, width: w, height: h }; });
  const up = (e) => { if (!d) return; const cur = d; d = null; try { pane.releasePointerCapture(cur.id); } catch (err) {} if (!cur.box || !cur.rect || cur.rect.width < 12 || cur.rect.height < 12) { clearMq(); return; }
    state.pk.mq = { pageNum: cur.pageNum, rect: cur.rect, wrap: cur.wrap }; const acts = document.createElement('div'); acts.className = 'nbb-mq-acts'; const below = cur.rect.y + cur.rect.height + 6; acts.style.left = Math.max(0, cur.rect.x) + 'px'; acts.style.top = (below + 40 < cur.wrap.clientHeight ? below : Math.max(0, cur.rect.y - 40)) + 'px';
    acts.innerHTML = `<button type="button" class="btn btn-small" data-mq="fig">${ICON.svg('photo')} Add as figure</button><button type="button" class="btn btn-small" data-mq="text">𝑇 Add as text</button><button type="button" class="btn btn-small btn-ghost" data-mq="x">✕</button>`;
    acts.addEventListener('click', async (ev) => { const b = ev.target.closest('[data-mq]'); if (!b) return; ev.stopPropagation(); const mq = state.pk?.mq; if (!mq) { clearMq(); return; } if (b.dataset.mq === 'fig') await snipAndAdd(mq.pageNum, mq.rect, ''); else if (b.dataset.mq === 'text') await textAndAdd(mq.pageNum, mq.rect); clearMq(); });
    cur.wrap.appendChild(acts); };
  pane.addEventListener('pointerup', up); pane.addEventListener('pointercancel', up);
}
function pageNumOf(wrap) { const v = state.pk?.viewer; if (!v) return 1; for (let p = 1; p <= v.numPages; p++) { const n = v.getPageNode(p); if (n && n.wrap === wrap) return p; } return 1; }
async function snipAndAdd(pageNum, rect, label) {
  const P = state.pk; const v = P?.viewer; if (!v || !state.inst) return; busy(true);
  try { const doc = v.getPdfDocument?.(); if (!doc) throw new Error('PDF document not ready'); const z = v.zoom || 1; const nat = { x: rect.x / z, y: rect.y / z, w: rect.width / z, h: rect.height / z }; const pad = 4; const page = await doc.getPage(pageNum);
    let s = Math.max(1.5, Math.min(4, 1600 / Math.max(60, nat.w))); const vp1 = page.getViewport({ scale: 1 }); s = Math.min(s, 4096 / Math.max(vp1.width, vp1.height)); const vp = page.getViewport({ scale: s });
    const full = document.createElement('canvas'); full.width = Math.ceil(vp.width); full.height = Math.ceil(vp.height); const fctx = full.getContext('2d'); fctx.fillStyle = '#fff'; fctx.fillRect(0, 0, full.width, full.height); await page.render({ canvasContext: fctx, viewport: vp }).promise;
    const sx = Math.max(0, (nat.x - pad) * s), sy = Math.max(0, (nat.y - pad) * s), sw = Math.min(full.width - sx, (nat.w + 2 * pad) * s), sh = Math.min(full.height - sy, (nat.h + 2 * pad) * s); if (sw < 4 || sh < 4) throw new Error('region too small');
    const crop = document.createElement('canvas'); crop.width = Math.round(sw); crop.height = Math.round(sh); const cctx = crop.getContext('2d'); cctx.fillStyle = '#fff'; cctx.fillRect(0, 0, crop.width, crop.height); cctx.drawImage(full, sx, sy, sw, sh, 0, 0, crop.width, crop.height);
    const [medium, fullBlob] = await Promise.all([resizeToWebp(crop, SIZES.medium.max, SIZES.medium.q), resizeToWebp(crop, SIZES.full.max, SIZES.full.q)]); if (!medium || !fullBlob) throw new Error('image encode failed');
    const itemId = newId('i'); const base = `paper-boards/${state.paperId}/${BOARD_ID}/items/${itemId}`; const ref = firebase.storage().ref();
    const put = async (name, blob) => { const c = ref.child(`${base}/${name}.webp`); await c.put(blob, { contentType: 'image/webp' }); return c.getDownloadURL(); };
    const url = await put('medium', medium); const fullUrl = await put('full', fullBlob);
    await state.inst.addWidget({ itemId, kind: 'snip', title: label || '', w: 0.3, data: { url, fullUrl, storagePath: base, ar: crop.width / Math.max(1, crop.height), paperId: P.paper.id, page: pageNum, cite: citeFor(P.paper, pageNum), html: '' }, text: `Reference: ${citeFor(P.paper, pageNum)}` });
  } catch (e) { console.warn('[figure-board] snip failed', e); toast('error', 'Could not add that region: ' + (e && e.message ? e.message : e)); } finally { busy(false); }
}
async function textAndAdd(pageNum, rect) {
  const P = state.pk; const v = P?.viewer; if (!v || !state.inst) return; const node = v.getPageNode(pageNum); const items = v.getTextItems(pageNum) || []; const k = (v.zoom || 1) / ((node && node.itemsZoom) || v.zoom || 1);
  const inside = items.filter(x => { const cx = (x.x + x.width / 2) * k, cy = (x.y + x.height / 2) * k; return cx >= rect.x && cx <= rect.x + rect.width && cy >= rect.y && cy <= rect.y + rect.height; });
  const text = inside.map(x => x.text).join(' ').replace(/-\s+(?=[a-z])/g, '').replace(/\s+/g, ' ').trim(); if (!text) { toast('info', 'No text in that region — try "Add as figure".'); return; }
  if (window.CANVAS_PAPER_READER) await CANVAS_PAPER_READER.addQuoteCard({ paperId: P.paper.id, quote: text, cite: citeFor(P.paper, pageNum), page: pageNum, w: 0.36 });   /* V3.859 */
}

if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', boot); else boot();
window.FIGURE_BOARD_CANVAS = { _state: state, makePanel, syncLitLinks, insertKind };
})();
