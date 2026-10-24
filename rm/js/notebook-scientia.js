/* ================================================================
   notebook-scientia.js — V3.864 — Scientia IS a notebook of the Lab Notebook
   ================================================================
   Alex: "this needs to be embedded in the lab notebook, not a separate
   page — it should be unified so that the lab notebook is Gabe's desktop
   app working in tandem."

   Gabe's Scientia In Situ (rm/scientia/scientia.html, his untouched build
   + the V3.857 cloud-sync.js shim) is one notebook in the Lab Notebook's
   own tab row, next to the canvas notebooks:

     - the group "Scientia" lists Today and the person's Scientia notes,
       read LIVE from the cloud hub (userData/{uid}/scientia/hub/rows where
       store == 'documents') — a note made on the desktop shows up as a tab
       within seconds of the desktop bridge's next pass;
     - a tab opens the note inside the notebook's own sheet area (a same-
       origin iframe: his app's globals S / $ / DB / M collide with ours, so
       it cannot share our document), ＋ makes a new Scientia note;
     - the notebook header shows the sync state: records, last change, when
       the person's computer last synced, conflicts to decide — and its
       buttons open the sync panel: connect a computer (keys + the
       scientia-cloud.py steps), upload a desktop export, download the
       record.

   The canvas side stays exactly as it was; notebook-canvas.js calls
   init / tabsHtml / onTab / show / hide / active / renderHeader /
   shouldOpen. Data and the protocol are V3.857's (functions/scientia-hub.js).
   No browser popups: inline forms, two-tap removes, toasts.
   ================================================================ */
(function () {
'use strict';

const FN = 'https://us-central1-mcgheelab-f56cc.cloudfunctions.net/scientiaHub';
const SRC = '/rm/scientia/scientia.html';
const VIEW_KEY = 'nbc_view';
const COL_KEY = 'nbc_sis_col';
const MAX_TABS = 20;
const OPEN_KEY = 'nbc_sis_open';   /* V3.882 — the notes open as tabs, in the order they were opened */
const SEED_TABS = 6;
const LIVE_MS = 3 * 60 * 1000;

const S = {
  uid: null, hooks: {}, active: false, collapsed: false,
  notes: [], sig: '', hub: null, keys: [], unsubs: [],
  frame: null, route: '', ready: false, queue: [], open: null,
  panel: false, upload: null, newKey: null, busy: false, tick: null
};

/* ─── helpers ─── */
function $(id) { return document.getElementById(id); }
function esc(s) { return (s ?? '').toString().replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#039;' }[c])); }
function icon(name) { try { return window.ICON ? ICON.svg(name) : ''; } catch (e) { return ''; } }
function toast(kind, msg) { if (window.TOAST && TOAST[kind]) TOAST[kind](msg); else console.log('[scientia]', kind, msg); }
function ls(k, v) { try { if (v === undefined) return localStorage.getItem(k); localStorage.setItem(k, v); } catch (e) { return null; } }
function db() { return firebridge.db(); }
function hubRef() { return db().collection('userData').doc(S.uid).collection('scientia').doc('hub'); }
function tsMs(t) { if (!t) return 0; if (typeof t.toMillis === 'function') return t.toMillis(); const n = Date.parse(t); return isNaN(n) ? 0 : n; }
function when(ms) {
  if (!ms) return 'never';
  const m = Math.round((Date.now() - ms) / 60000);
  if (m < 1) return 'just now'; if (m < 60) return m + ' min ago'; if (m < 36 * 60) return Math.round(m / 60) + ' h ago';
  try { return new Date(ms).toLocaleDateString(undefined, { month: 'short', day: 'numeric' }); } catch (e) { return ''; }
}
function fmtTabDate(iso) {
  const d = String(iso || '').slice(0, 10); const [y, m, dd] = d.split('-').map(Number); if (!y) return '';
  return `${dd} ${['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'][(m || 1) - 1]}`;
}
async function call(path, init) {
  const user = firebase.auth().currentUser; if (!user) throw new Error('not signed in');
  const headers = Object.assign({}, (init && init.headers) || {}, { Authorization: 'Bearer ' + (await user.getIdToken()) });
  const r = await fetch(FN + '/' + path, Object.assign({}, init || {}, { headers }));
  let j = null; try { j = await r.json(); } catch (e) {}
  if (!r.ok) throw new Error((j && j.error) || ('HTTP ' + r.status));
  return j;
}

/* ─── live data: the hub doc, the notes, the desktop keys ─── */
function init(opts) {
  S.uid = opts.uid; S.hooks = opts || {};
  S.collapsed = ls(COL_KEY) === '1';
  try {
    S.unsubs.push(hubRef().onSnapshot(s => { S.hub = s.exists ? s.data() : null; paintStatus(); }, e => console.warn('[scientia] hub', e && e.message)));
    S.unsubs.push(hubRef().collection('rows').where('store', '==', 'documents').onSnapshot(snap => {
      const notes = [];
      snap.docs.forEach(d => {
        const x = d.data() || {}; if (x.store !== 'documents' || x.deleted || !x.recJson) return;
        let r = null; try { r = JSON.parse(x.recJson); } catch (e) { return; }
        if (!r || !r.id || r.type === 'review') return;
        notes.push({ id: String(r.id), title: r.title || 'Untitled note', type: r.type || 'note', created: r.created || '', modified: r.modified || r.created || '' });
      });
      notes.sort((a, b) => String(b.modified).localeCompare(String(a.modified)));
      const sig = notes.map(n => n.id + '|' + n.title + '|' + n.created).join('\n');
      S.notes = notes;
      if (sig !== S.sig) { S.sig = sig; if (S.hooks.renderTabs) S.hooks.renderTabs(); }
    }, e => console.warn('[scientia] notes', e && e.message)));
    S.unsubs.push(hubRef().collection('keys').onSnapshot(snap => {
      S.keys = snap.docs.map(d => Object.assign({ id: d.id }, d.data() || {})).map(k => ({ id: k.id, name: k.name || 'Computer', created: tsMs(k.created), lastSeen: tsMs(k.lastSeen) }));
      paintStatus(); if (S.panel) paintKeys();
    }, e => console.warn('[scientia] keys', e && e.message)));
  } catch (e) { console.warn('[scientia] init', e); }
  window.addEventListener('message', onFrameMessage);
}

/* Open Scientia on load? The person's last choice; else yes when they already sync a computer. */
async function shouldOpen() {
  const v = ls(VIEW_KEY);
  if (v === 'scientia') return true;
  if (v === 'canvas') return false;
  try {
    const [h, k] = await Promise.all([hubRef().get(), hubRef().collection('keys').limit(1).get()]);
    return !!(h.exists && (h.data().records || 0) > 0 && !k.empty);
  } catch (e) { return false; }
}

/* ─── the tab group ─── */
function noteIdOf(hash) { const m = /^#\/(?:doc|split)\/([^/?#]+)/.exec(hash || ''); return m ? decodeURIComponent(m[1]) : null; }
/* V3.882 — the tabs are the person's OPEN notes: a note joins when it is opened (a tab, the Portfolio, a link) and
   leaves with its ×; the list is this browser's (localStorage), seeded the first time with the most recent notes. */
function openIds() {
  if (!S.open) { let v = null; try { v = JSON.parse(ls(OPEN_KEY) || 'null'); } catch (e) {} S.open = Array.isArray(v) ? v.map(String) : null; }
  if (!S.open && S.notes.length) { S.open = S.notes.slice(0, SEED_TABS).map(n => n.id); saveOpen(); }
  return S.open || [];
}
function saveOpen() { ls(OPEN_KEY, JSON.stringify(S.open || [])); }
function openTab(id) {
  if (!id) return false;
  const o = openIds().slice(); if (o.includes(id)) return false;
  o.push(id); if (o.length > MAX_TABS) o.splice(0, o.length - MAX_TABS);
  S.open = o; saveOpen(); return true;
}
function closeTab(id) {
  const o = openIds(), i = o.indexOf(id); if (i < 0) return;
  S.open = o.filter(x => x !== id); saveOpen();
  if (S.active && noteIdOf(S.route) === id) {
    const live = S.open.filter(x => S.notes.some(n => n.id === x)), next = live[Math.min(i, live.length - 1)];
    show(next ? '#/doc/' + encodeURIComponent(next) : '#/home');
  } else if (S.hooks.renderTabs) S.hooks.renderTabs();
}
function tabsHtml({ q }) {
  const query = String(q || '').trim().toLowerCase(), byId = new Map(S.notes.map(n => [n.id, n]));
  const list = query ? S.notes.filter(n => `${n.title} ${n.type}`.toLowerCase().includes(query)) : openIds().map(id => byId.get(id)).filter(Boolean);
  const shown = query ? list.slice(0, MAX_TABS) : list.slice(-MAX_TABS), on = S.active, cur = noteIdOf(S.route);
  const home = on && (!S.route || /^#\/?(home)?$/.test(S.route));
  const col = S.collapsed && !on;
  return `<div class="nbc-group nbc-sis-group${col ? ' nbc-col' : ''}${on ? ' nbc-group-on' : ''}" data-nb="scientia" style="--nbc:#1D1D1B">
    <button type="button" class="nbc-gname" data-t="sis-group" title="Scientia — Gabe's notebook app, the same notebook as the desktop app on your computer${col ? ' (show its notes)' : ''}"><i></i>Scientia<small>${S.notes.length}</small></button>
    ${col ? '' : `<button type="button" class="nbc-tab${home ? ' nbc-tab-on' : ''}" data-t="sis-go" data-hash="#/home" title="Today in Scientia"><span class="nbc-tab-title">Today</span></button>
    ${shown.map(n => `<span class="nbc-sis-tab${on && cur === n.id ? ' nbc-sis-tab-on' : ''}" data-sis-tab="${esc(n.id)}"><button type="button" class="nbc-tab${on && cur === n.id ? ' nbc-tab-on' : ''}" data-t="sis-go" data-hash="#/doc/${esc(encodeURIComponent(n.id))}" title="${esc(n.title)} · ${esc(n.type)}"><span class="nbc-tab-title">${esc(n.title)}</span><span class="nbc-tab-date">${esc(fmtTabDate(n.created))}</span></button>${query ? '' : `<button type="button" class="nbc-tab-x" data-t="sis-close" data-id="${esc(n.id)}" title="Close this tab (the note stays)" aria-label="Close ${esc(n.title)}">${icon('x-mark') || '×'}</button>`}</span>`).join('')}
    ${S.notes.length > shown.length ? `<button type="button" class="nbc-tab nbc-sis-more" data-t="sis-go" data-hash="#/portfolio" title="Every Scientia note, in the Portfolio"><span class="nbc-tab-title">All ${S.notes.length}</span></button>` : ''}`}
    <button type="button" class="nbc-tab-add nbc-sis-quick" data-t="sis-quick" title="A quick note — a blank page; give it a title, type and project when you save it">${icon('plus') || '＋'}<span>Quick note</span></button>
  </div>`;
}
function onTab(b) {
  const act = b.dataset.t;
  if (act === 'sis-group') {
    if (S.active) { S.collapsed = false; } else { S.collapsed = !S.collapsed; }
    ls(COL_KEY, S.collapsed ? '1' : '0');
    if (!S.collapsed && !S.active) { show(null); return; }
    if (S.hooks.renderTabs) S.hooks.renderTabs();
  } else if (act === 'sis-go') show(b.dataset.hash);
  else if (act === 'sis-close') closeTab(b.dataset.id);
  else if (act === 'sis-quick') { show(null).then(() => send({ sisCmd: 'quick' })); }
  else if (act === 'sis-new') { show(null).then(() => send({ sisCmd: 'new' })); }
}

/* ─── the embedded app ─── */
function host() { return $('nbc-sis'); }
function root() { return $('nbc-content'); }
function ensureFrame(target) {
  const h = host(); if (!h) return;
  if (S.frame && S.frame.isConnected) return false;
  h.innerHTML = `<div class="nbc-sis-main"><iframe class="nbc-sis-frame" id="nbc-sis-frame" title="Scientia In Situ" allow="microphone; fullscreen; clipboard-read; clipboard-write"></iframe></div><aside class="nbc-side nbc-sis-side" id="nbc-sis-side" hidden></aside>`;
  S.frame = $('nbc-sis-frame'); S.ready = false;
  S.frame.src = SRC + (target || '');
  S.frame.addEventListener('load', () => { S.ready = true; flush(); });
  return true;
}
function send(msg) { if (S.ready && S.frame && S.frame.contentWindow) { try { S.frame.contentWindow.postMessage(msg, location.origin); } catch (e) {} } else S.queue.push(msg); }
function flush() { const q = S.queue.splice(0); q.forEach(send); }
function onFrameMessage(e) {
  if (e.origin !== location.origin || !S.frame || e.source !== S.frame.contentWindow || !e.data || !e.data.sis) return;
  if (e.data.type === 'ready') { S.ready = true; flush(); }
  if (e.data.type === 'rm-open' && typeof e.data.href === 'string' && /^\/rm\/pages\/[a-z0-9-]+\.html(\?|$)/.test(e.data.href)) {
    // V3.869: the web app asks for an RM page (a paper's page, the library, tasks); the app opened a tab itself,
    // so this is the hook for an in-notebook reader later (canvas-paper-reader's overlay).
    S.lastRmOpen = e.data.href;
  }
  // V3.875 — Phase 2: Scientia's RM cards ask the notebook to run RM's own UI here (the reader overlay, the My Week
  // report picker). Every request carries a reqId and gets an rm-ack; no ack means "not here" and the app falls back.
  if (e.data.type === 'rm-read') send({ sisCmd: 'rm-ack', reqId: e.data.reqId, ok: openReaderFor(e.data.paper, e.data.focus) });
  if (e.data.type === 'rm-report') send({ sisCmd: 'rm-ack', reqId: e.data.reqId, ok: openReportFor(e.data.card, e.data.point, e.data.reqId) });
  // V3.878 — "Something I did": your recorded actions (USER_ACTIONS, V3.844), listed and marked noted by RM's own code
  if (e.data.type === 'rm-actions') send({ sisCmd: 'rm-ack', reqId: e.data.reqId, ok: listActionsFor(e.data.reqId) });
  if (e.data.type === 'rm-action-noted') send({ sisCmd: 'rm-ack', reqId: e.data.reqId, ok: noteActionFor(e.data.actionId, e.data.entryId, e.data.cardId) });
  if (typeof e.data.hash === 'string' && e.data.hash !== S.route) {
    S.route = e.data.hash;
    openTab(noteIdOf(S.route));   /* V3.882 — a note opened anywhere in Scientia becomes a tab */
    if (S.active) { setUrl(); if (S.hooks.renderTabs) S.hooks.renderTabs(); }
  }
}
/* V3.875 — RM's paper reader over the whole notebook, for a paper card or the Library tab in Scientia. Highlights
   are RM's own (papers/{id}/annotations); when the reader closes the frame is told, so its cards refresh. */
function openReaderFor(paper, focus) {
  const R = window.CANVAS_PAPER_READER;
  if (!R || !R.openReader || !paper || !paper.paperId) return false;
  const item = { id: 'sis-paper-' + paper.paperId, kind: 'paper', type: 'widget',
    data: { paperId: String(paper.paperId), title: String(paper.title || ''), cite: String(paper.cite || ''), journal: String(paper.journal || ''), pdf: paper.pdf ? 'yes' : '' } };
  const api = { canEdit: () => true, save() {}, saveData() {}, refresh() {}, remove() {}, collapse() {} };
  try { Promise.resolve(R.openReader(item, api, { focus: focus || null })).catch(err => console.warn('[scientia] reader', err)); }
  catch (err) { console.warn('[scientia] reader', err); return false; }
  clearInterval(S.readerWatch);
  S.readerWatch = setInterval(() => {
    if (document.querySelector('.cpr-reader')) return;
    clearInterval(S.readerWatch); send({ sisCmd: 'rm-reader-closed', paperId: String(paper.paperId) });
  }, 700);
  return true;
}
/* V3.875 — "✓ Report to My Week" for a Scientia component: RM's picker and writer (MYWEEK_REPORT → DAY_DISTRIBUTE.saveOutcome),
   placed at the click inside the frame; the chosen step goes back so the component's ✓ fills. */
function openReportFor(card, point, reqId) {
  const MR = window.MYWEEK_REPORT;
  if (!MR || !MR.open || !card || !card.itemId) return false;
  const r = S.frame ? S.frame.getBoundingClientRect() : { left: 0, top: 0 };
  const pt = point && isFinite(point.x) && isFinite(point.y) ? { x: r.left + point.x, y: r.top + point.y } : null;
  try {
    Promise.resolve(MR.open({ card, point: pt, onReported: (step) => send({ sisCmd: 'rm-reported', reqId, blockId: card.itemId,
      step: { id: String(step && step.id || ''), title: String(step && step.title || ''), date: String(step && step.date || '') } }) }))
      .catch(err => console.warn('[scientia] report', err));
  } catch (err) { console.warn('[scientia] report', err); return false; }
  return true;
}
/* V3.878 — the actions not yet placed or ignored, described by RM (USER_ACTIONS.describe), sent to the frame */
function listActionsFor(reqId) {
  const UA = window.USER_ACTIONS;
  if (!UA || !UA.list) return false;
  Promise.resolve(UA.list({ limit: 100 })).then(all => {
    const rows = (UA.pending ? UA.pending(all || []) : (all || [])).map(a => ({ id: String(a.id || ''), kind: String(a.kind || ''), text: String(UA.describe ? UA.describe(a) : a.kind),
      at: String(a.at || ''), note: String(a.note || a.notes || ''), itemId: String(a.itemId || ''), equipmentId: String(a.equipmentId || ''), labelCode: String(a.labelCode || '') }));
    send({ sisCmd: 'rm-actions-list', reqId, ok: true, rows });
  }).catch(err => send({ sisCmd: 'rm-actions-list', reqId, ok: false, error: String((err && err.message) || err), rows: [] }));
  return true;
}
function noteActionFor(actionId, entryId, cardId) {
  const UA = window.USER_ACTIONS;
  if (!UA || !UA.markNoted || !actionId) return false;
  Promise.resolve(UA.markNoted(String(actionId), { entryId: 'scientia:' + String(entryId || ''), cardId: String(cardId || '') })).catch(err => console.warn('[scientia] markNoted', err));
  return true;
}
function setUrl() {
  const id = noteIdOf(S.route);
  try { history.replaceState(null, '', '?notebook=scientia' + (id ? '&note=' + encodeURIComponent(id) : '')); } catch (e) {}
}
async function show(target) {
  if (!S.active) {
    if (S.hooks.park) { try { await S.hooks.park(); } catch (e) { console.warn('[scientia] park', e); } }
    S.active = true; ls(VIEW_KEY, 'scientia');
  }
  const fresh = ensureFrame(target);
  if (!fresh && target) send({ sisCmd: 'go', hash: target });
  if (target) { S.route = target; openTab(noteIdOf(target)); }
  const r = root(); if (r) r.classList.add('nbc-sis-on');
  setUrl();
  if (S.hooks.renderHeader) S.hooks.renderHeader();
  if (S.hooks.renderTabs) S.hooks.renderTabs();
  clearInterval(S.tick); S.tick = setInterval(paintStatus, 30000);
  if (S.panel) renderPanel();
}
function hide() {
  if (!S.active) return;
  S.active = false; ls(VIEW_KEY, 'canvas');
  const r = root(); if (r) r.classList.remove('nbc-sis-on');
  clearInterval(S.tick); S.tick = null;
}
function active() { return S.active; }

/* ─── header: sync state + the sync buttons ─── */
function lastDesktop() { return S.keys.reduce((best, k) => (k.lastSeen > (best ? best.lastSeen : 0) ? k : best), null); }
function statusParts() {
  const h = S.hub, recs = h ? (h.records || 0) : 0, conf = h ? (h.conflictsN || 0) : 0;
  const changed = h ? (tsMs(h.updated) || tsMs(h.savedAt)) : 0, desk = lastDesktop();
  const live = desk && desk.lastSeen && Date.now() - desk.lastSeen < LIVE_MS;
  const dot = conf ? 'warn' : live ? 'ok' : S.keys.length ? 'idle' : 'none';
  const deskTxt = !S.keys.length ? 'no computer connected' : desk && desk.lastSeen ? `${desk.name} synced ${when(desk.lastSeen)}` : `${S.keys[0].name} not synced yet`;
  return { recs, conf, changed, dot, deskTxt, live };
}
function statusText() {
  if (!S.hub) return 'Saved to your account · no computer connected';
  const p = statusParts();
  return `${p.recs} record${p.recs === 1 ? '' : 's'} · changed ${when(p.changed)} · ${p.deskTxt}${p.conf ? ` · ${p.conf} to decide` : ''}`;
}
function paintStatus() {
  const t = $('nbc-sis-status'); if (t) t.textContent = statusText();
  const d = $('nbc-sis-dot'); if (d) { const p = statusParts(); d.className = 'nbc-sis-dot nbc-sis-' + p.dot; d.title = p.conf ? `${p.conf} change${p.conf === 1 ? '' : 's'} to decide — the warning triangle in Scientia's header` : p.live ? 'In step with your computer' : S.keys.length ? 'Your computer is not syncing right now' : 'No computer connected'; }
  if (S.panel) { const s = $('nbc-sis-panel-status'); if (s) s.innerHTML = panelStatusHtml(); }
}
function renderHeader(h, { full, searchOpen }) {
  h.innerHTML = `
    <a class="nbc-brand" href="/rm/" title="Lab notebook — back to RM">NB</a>
    <span class="nbc-title nbc-title-empty nbc-sis-title">Scientia</span>
    <div class="nbc-meta nbc-sis-meta"><span class="nbc-sis-dot" id="nbc-sis-dot"></span><span class="nbc-status nbc-sis-status" id="nbc-sis-status"></span></div>
    <span class="spacer"></span>
    <button type="button" class="nbc-ib nbc-sis-btn${S.panel ? ' nbc-on' : ''}" data-h="sis-sync" title="Sync with the desktop app on your computer">${icon('computer-desktop')}</button>
    <button type="button" class="nbc-ib${searchOpen ? ' nbc-on' : ''}" data-h="search" title="Find a note">⌕</button>
    <button type="button" class="nbc-ib" data-h="sis-more" title="Upload, download, open on its own">⋯</button>
    <button type="button" class="nbc-ib${full ? ' nbc-on' : ''}" data-h="full" title="${full ? 'Leave full screen (Esc)' : 'Full screen'}">⛶</button>`;
  paintStatus();
  h.querySelector('[data-h="sis-sync"]').addEventListener('click', () => togglePanel());
  const more = h.querySelector('[data-h="sis-more"]');
  more.addEventListener('click', () => {
    if (!window.CANVAS_WIDGETS || !CANVAS_WIDGETS.actionMenu) { togglePanel(true); return; }
    CANVAS_WIDGETS.actionMenu({ anchor: more, title: 'Scientia', items: [
      { label: 'Connect your computer…', sub: 'The desktop app and this notebook become one', run: () => togglePanel(true) },
      { label: 'Upload from desktop…', sub: 'Replace this notebook with an export from the desktop app', run: () => { togglePanel(true); setTimeout(() => $('nbc-sis-file')?.click(), 60); } },
      { label: 'Download (JSON)', sub: 'Everything, as the desktop app imports it', run: download },
      { label: 'Open on its own', sub: 'Scientia in a tab of its own', run: () => window.open(SRC + (S.route || ''), '_blank', 'noopener') }
    ] });
  });
}

/* ─── the sync panel (inside the Scientia area, like the canvas's side list) ─── */
function togglePanel(force) {
  S.panel = force === undefined ? !S.panel : !!force;
  renderPanel();
  const b = document.querySelector('[data-h="sis-sync"]'); if (b) b.classList.toggle('nbc-on', S.panel);
}
function panelStatusHtml() {
  const p = statusParts();
  return `<div class="nbc-sis-stat"><span class="nbc-sis-dot nbc-sis-${p.dot}"></span><b>${S.hub ? `${p.recs} record${p.recs === 1 ? '' : 's'}` : 'Nothing online yet'}</b> saved to your account${S.hub ? ` · changed ${esc(when(p.changed))}` : ''}</div>
    <div class="nbc-sis-sub">${esc(p.deskTxt[0].toUpperCase() + p.deskTxt.slice(1))}.${p.conf ? ` <b class="nbc-sis-warnt">${p.conf} to decide</b> — click the warning triangle in Scientia's header, on whichever side you open.` : ''}</div>`;
}
function renderPanel() {
  const side = $('nbc-sis-side'); if (!side) return;
  side.hidden = !S.panel; if (!S.panel) return;
  const nk = S.newKey, up = S.upload;
  side.innerHTML = `
    <div class="nbc-side-head"><span>Sync with your desktop</span><button type="button" class="nbc-ib" data-p="close" title="Close">✕</button></div>
    <div class="nbc-sis-sec" id="nbc-sis-panel-status">${panelStatusHtml()}</div>
    <div class="nbc-sis-sec">
      <h4>Connect your computer</h4>
      <p>The Scientia app on your computer and this notebook become one: a change on either side shows on the other within seconds, both keep working offline, and images and recordings travel too.</p>
      <ol>
        <li>Make a key below and copy it — it is shown once.</li>
        <li>Download <a href="/rm/scientia/scientia-cloud.py" download>scientia-cloud.py</a> into the folder where Scientia's <code>launch.bat</code> / <code>serve.py</code> live.</li>
        <li>With Scientia running, open a terminal in that folder and run once <code>python3 scientia-cloud.py --key &lt;your key&gt;</code> (Windows: <code>py scientia-cloud.py --key …</code>). After that, <code>python3 scientia-cloud.py</code> keeps the two in step while its window is open.</li>
      </ol>
      <p class="nbc-sis-sub">If both sides already hold different notes, the script asks you to choose once: <code>--prefer local</code> (your computer wins) or <code>--prefer cloud</code> (this notebook wins). The replaced side keeps a copy first.</p>
      <div class="nbc-sis-row"><input type="text" id="nbc-sis-keyname" placeholder="Name this computer (e.g. Office PC)" maxlength="40"><button type="button" class="nbc-sis-b" data-p="key-make">Make a key</button></div>
      <div class="nbc-sis-msg" id="nbc-sis-keymsg"></div>
      ${nk ? `<div class="nbc-sis-key"><code id="nbc-sis-keyval">${esc(nk)}</code><button type="button" class="nbc-sis-b" data-p="key-copy">Copy</button></div>
        <p class="nbc-sis-sub">Copy it now — it will not be shown again. Anyone with it can read and change this notebook; remove it below if it leaks.</p>` : ''}
      <div class="nbc-sis-keys" id="nbc-sis-keys"></div>
    </div>
    <div class="nbc-sis-sec">
      <h4>Move a whole notebook</h4>
      <p>Bring in an export from the desktop app (Settings → Export everything, or the notebook folder's <code>.scientia/record.json</code>). It replaces what is here; the current notebook is kept as a backup first, and a connected computer follows at its next pass.</p>
      <div class="nbc-sis-row">
        <label class="nbc-sis-b">${icon('arrow-up-tray')} Upload from desktop<input type="file" id="nbc-sis-file" accept=".json,application/json" hidden></label>
        <button type="button" class="nbc-sis-b" data-p="download">${icon('arrow-down-tray')} Download (JSON)</button>
      </div>
      ${up ? `<div class="nbc-sis-confirm"><b>Replace this notebook with “${esc(up.name)}”?</b> It holds ${up.n} record${up.n === 1 ? '' : 's'}${up.savedAt ? `, saved ${esc(when(Date.parse(up.savedAt)))}` : ''}.
        <div class="nbc-sis-row"><button type="button" class="nbc-sis-b nbc-sis-pri" data-p="up-go"${S.busy ? ' disabled' : ''}>Replace</button><button type="button" class="nbc-sis-b" data-p="up-no">Cancel</button></div>
        <div class="nbc-sis-msg" id="nbc-sis-upmsg"></div></div>` : ''}
    </div>`;
  paintKeys();
  if (!side.dataset.wired) {
    side.dataset.wired = '1';
    side.addEventListener('click', onPanelClick);
    side.addEventListener('change', (e) => { if (e.target.id === 'nbc-sis-file') pickUpload(e.target); });
    side.addEventListener('keydown', (e) => { if (e.target.id === 'nbc-sis-keyname' && e.key === 'Enter') { e.preventDefault(); makeKey(); } });
  }
}
function paintKeys() {
  const box = $('nbc-sis-keys'); if (!box) return;
  if (!S.keys.length) { box.innerHTML = '<div class="nbc-sis-sub">No computer connected yet.</div>'; return; }
  box.innerHTML = S.keys.slice().sort((a, b) => b.created - a.created).map(k => `<div class="nbc-sis-krow"><span><b>${esc(k.name)}</b><small>made ${esc(when(k.created))} · last synced ${esc(when(k.lastSeen))}</small></span><button type="button" class="nbc-sis-b" data-p="key-rm" data-id="${esc(k.id)}">Remove</button></div>`).join('');
}
async function onPanelClick(e) {
  const b = e.target.closest('[data-p]'); if (!b) return;
  const p = b.dataset.p;
  if (p === 'close') togglePanel(false);
  else if (p === 'key-make') makeKey();
  else if (p === 'key-copy') {
    const v = $('nbc-sis-keyval')?.textContent || '';
    try { await navigator.clipboard.writeText(v); toast('success', 'Key copied'); }
    catch (err) { const r = document.createRange(); r.selectNodeContents($('nbc-sis-keyval')); const s = getSelection(); s.removeAllRanges(); s.addRange(r); toast('info', 'Copy it with Cmd+C / Ctrl+C'); }
  } else if (p === 'key-rm') {
    if (b.dataset.armed !== '1') { b.dataset.armed = '1'; b.textContent = 'Remove — sure?'; setTimeout(() => { if (b.isConnected) { b.dataset.armed = ''; b.textContent = 'Remove'; } }, 3000); return; }
    b.disabled = true;
    try { await call('api/cloud/key/remove', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ id: b.dataset.id }) }); toast('success', 'Key removed — that computer stops syncing'); }
    catch (err) { toast('error', 'Could not remove the key: ' + (err.message || err)); b.disabled = false; }
  } else if (p === 'download') download();
  else if (p === 'up-no') { S.upload = null; renderPanel(); }
  else if (p === 'up-go') doUpload();
}
async function makeKey() {
  const name = ($('nbc-sis-keyname')?.value || '').trim() || 'My computer', msg = $('nbc-sis-keymsg');
  if (msg) msg.textContent = 'Making a key…';
  try {
    const j = await call('api/cloud/key', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ name }) });
    S.newKey = j.key; renderPanel();
  } catch (err) { if (msg) { msg.textContent = 'Could not make a key: ' + (err.message || err); msg.classList.add('nbc-sis-err'); } }
}
async function pickUpload(input) {
  const f = input.files && input.files[0]; input.value = ''; if (!f) return;
  let data = null;
  try { data = JSON.parse(await f.text()); } catch (e) { toast('error', 'That file is not JSON.'); return; }
  if (!data || typeof data !== 'object' || !data.stores || typeof data.stores !== 'object') { toast('error', 'That is not a Scientia export (it has no "stores").'); return; }
  ['blobs', 'journal', 'datasets'].forEach(s => { delete data.stores[s]; if (data.counts) delete data.counts[s]; });
  let n = 0; Object.keys(data.stores).forEach(s => { if (s !== 'settings' && s !== 'profiles' && Array.isArray(data.stores[s])) n += data.stores[s].length; });
  S.upload = { name: f.name, n, savedAt: data.savedAt || data.exportedAt || null, data };
  if (!S.panel) S.panel = true;
  renderPanel();
}
async function doUpload() {
  const up = S.upload; if (!up || S.busy) return;
  const msg = () => $('nbc-sis-upmsg');
  const body = JSON.stringify(up.data);
  if (body.length > 31 * 1024 * 1024) { if (msg()) msg().textContent = 'This export is over 31 MB — the cloud takes up to 32 MB in one upload. Sync it with scientia-cloud.py instead.'; return; }
  S.busy = true; renderPanel(); if (msg()) msg().textContent = 'Uploading…';
  try {
    const j = await call('api/snapshot', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body });
    S.upload = null; S.busy = false; renderPanel();
    toast('success', `Notebook replaced — ${(j.meta && j.meta.records) || 0} records online.`);
    if (S.frame) { S.ready = false; S.frame.src = SRC; }
  } catch (err) { S.busy = false; renderPanel(); if (msg()) { msg().textContent = 'Could not upload: ' + (err.message || err); msg().classList.add('nbc-sis-err'); } }
}
async function download() {
  try {
    const j = await call('api/sync/state?journal=0');
    const a = document.createElement('a');
    a.href = URL.createObjectURL(new Blob([JSON.stringify(j, null, 1)], { type: 'application/json' }));
    a.download = 'scientia-export-' + new Date().toISOString().slice(0, 10) + '.json';
    document.body.appendChild(a); a.click(); setTimeout(() => { URL.revokeObjectURL(a.href); a.remove(); }, 500);
  } catch (err) { toast('error', 'Could not download: ' + (err.message || err)); }
}

window.NOTEBOOK_SCIENTIA = { init, shouldOpen, tabsHtml, onTab, show, hide, active, renderHeader, togglePanel, _state: S };
})();
