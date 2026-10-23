/* ================================================================
   Whiteboard panel for learning modules (V3.684)
   ================================================================
   An opt-in floating whiteboard beside the lesson, so a class can be
   taught from the module and the board at once without navigating away.

   The workflow this exists for is TWO DEVICES: the laptop drives the
   module onto the classroom projector while the instructor writes on an
   iPad. This panel is what puts the live board on the projected screen,
   next to the lesson.

   Opt in from a module with (order matters — all `defer`, so they run in
   document order):

     <link rel="stylesheet" href="../../whiteboard-board.css">
     <link rel="stylesheet" href="../shared/whiteboard-panel.css">
     <meta name="ml-module-viewport" content="1">
     <script defer src="https://www.gstatic.com/firebasejs/10.14.0/firebase-app-compat.js"></script>
     <script defer src="https://www.gstatic.com/firebasejs/10.14.0/firebase-auth-compat.js"></script>
     <script defer src="https://www.gstatic.com/firebasejs/10.14.0/firebase-firestore-compat.js"></script>
     <script defer src="https://www.gstatic.com/firebasejs/10.14.0/firebase-storage-compat.js"></script>
     <script defer src="../../firebase-config.js"></script>
     <script defer src="../../rm/js/icons.js"></script>
     <script defer src="../../whiteboard.js"></script>
     <script defer src="../shared/whiteboard-panel.js"></script>

   Notes on that list:
   - `firebase-config.js` is the SAME file the SPA loads, deliberately —
     inlining a second copy of the config (the ML-CLOUD-SAVE precedent in
     hw-00-pretest.html) would let the two drift, and it also carries the
     experimentalAutoDetectLongPolling workaround the iframe would
     otherwise lack.
   - Auth needs NO handshake with the parent. Firebase persists its
     session per-ORIGIN under the default app, and the module iframe is
     same-origin, so signing in on the site signs you in here too. That
     is also why the snap can upload and write directly instead of
     proxying through the parent, and why it works on a direct link.
   - `whiteboard.js` supplies the board engine via
     Whiteboard.mountBoardView(); this file never re-implements ink.

   Everything fails soft. No class id, no network, no live board, not
   signed in — the panel says so and the lesson is untouched.
   ================================================================ */

(function () {
'use strict';

const LS_KEY   = 'ml-wb-panel';
const PANEL_ID = 'panel-wb';
const TOOL_ID  = 'tool-wb';
const DEFAULT_GEOM = { x: 40, y: 90, w: 520, h: 420, min: false, open: false };

/* ─── Geometry persistence (ported from the hw-00 context-panel engine) ── */
function loadGeom() {
  try { return Object.assign({}, DEFAULT_GEOM, JSON.parse(localStorage.getItem(LS_KEY) || '{}')); }
  catch (e) { return Object.assign({}, DEFAULT_GEOM); }
}
function saveGeom(g) { try { localStorage.setItem(LS_KEY, JSON.stringify(g)); } catch (e) {} }
let GEOM = loadGeom();

function isMobileView() { return window.innerWidth <= 700; }

/* ─── Class id ──────────────────────────────────────────────────
   ?class= is set by the class page's module links and by the viewer's
   iframe src (V3.684). Without it we cannot know which class's board to
   show, so the panel stays out of the way entirely. */
function getClassId() {
  try {
    const p = new URLSearchParams(window.location.search).get('class');
    if (p) return p;
  } catch (e) {}
  return null;
}

function moduleSlug() {
  const parts = window.location.pathname.split('/').filter(Boolean);
  return parts.slice(-2).join('/');
}

function meta(name) {
  return document.querySelector('meta[name="' + name + '"]')?.content || '';
}

/* 'homework' boards can never be shared with classmates and live in a
   collection whose rules contain no sharing clause at all; 'notes'
   boards can be shared. A module declares which it is; notes is the
   safe default, because getting this wrong the other way would let
   homework be shared. */
const MODE = meta('ml-module-board') === 'homework' ? 'homework' : 'notes';
const BOARD_COLL = MODE === 'homework' ? 'hwBoards' : 'notesBoards';
/* Board key must carry no underscore — ownerBoardId() strips them, and
   the rules split the id on '_' to prove ownership. */
const MODULE_KEY = (meta('ml-module-key')
  || (window.location.pathname.split('/').pop() || 'module').replace(/\.html?$/, ''));
const MINE_LABEL = MODE === 'homework' ? 'My work' : 'My notes';

/* ─── Minimal Auth shim ─────────────────────────────────────────
   whiteboard.js's computeIsClassAdmin() reads McgheeLab.Auth. The SPA
   fills that in from user-system.js, which a module must not load (it is
   263 KB of site chrome). Provide only the four members the board
   actually touches. */
function installAuthShim() {
  const ML = window.McgheeLab = window.McgheeLab || {};
  if (ML.Auth && ML.Auth.onChange) return ML.Auth;   // SPA already provided one
  const listeners = [];
  const Auth = {
    currentUser: null,
    currentProfile: null,
    onChange(fn) { listeners.push(fn); },
    offChange(fn) { const i = listeners.indexOf(fn); if (i >= 0) listeners.splice(i, 1); }
  };
  ML.Auth = Auth;
  if (window.firebase?.auth) {
    firebase.auth().onAuthStateChanged(async (user) => {
      Auth.currentUser = user || null;
      Auth.currentProfile = null;
      if (user && ML.db) {
        /* role:'admin' is the only profile field the board gate reads;
           a guest/student simply has no users doc and stays a viewer. */
        try {
          const d = await ML.db.collection('users').doc(user.uid).get();
          Auth.currentProfile = d.exists ? d.data() : null;
        } catch (e) { Auth.currentProfile = null; }
      }
      listeners.slice().forEach(fn => { try { fn(Auth.currentUser, Auth.currentProfile); } catch (e) {} });
    });
  }
  return Auth;
}

/* ─── Panel DOM ─────────────────────────────────────────────────── */
function buildPanel() {
  const p = document.createElement('div');
  p.className = 'cpanel wb-panel';
  p.id = PANEL_ID;
  p.hidden = true;
  p.innerHTML = `
    <div class="cpanel-head">
      <span class="cpanel-title">Whiteboard</span>
      <span class="cpanel-btns">
        <button type="button" class="cpanel-min" title="Collapse">&#9601;</button>
        <button type="button" class="cpanel-x" title="Close">&times;</button>
      </span>
    </div>
    <div class="cpanel-body wb-panel-body">
      <div class="wb-panel-tabs" role="tablist">
        <button type="button" class="wb-panel-tab wb-panel-tab-on" data-wb-src="live">Live class board</button>
        <button type="button" class="wb-panel-tab" data-wb-src="mine">${MINE_LABEL}</button>
      </div>
      <div class="wb-panel-mount" data-wb-mount></div>
      <div class="wb-panel-share" data-wb-share hidden></div>
      <div class="wb-panel-msg" data-wb-msg></div>
    </div>`;
  document.body.appendChild(p);
  return p;
}

function buildToggle() {
  const btn = document.createElement('button');
  btn.type = 'button';
  btn.id = TOOL_ID;
  btn.className = 'tool-btn wb-tool-btn';
  btn.title = 'Whiteboard — the live class board beside the lesson';
  btn.textContent = 'Whiteboard';
  /* Learning modules have no tool dock; their only chrome slot is the
     section rail's head. Homework modules DO have .tool-dock, so this
     same file can be adopted there without change. */
  const dock = document.querySelector('.tool-dock');
  const railHead = document.querySelector('#rail .rail-head');
  if (dock) dock.appendChild(btn);
  else if (railHead) railHead.appendChild(btn);
  else document.body.appendChild(btn), btn.classList.add('wb-tool-floating');
  return btn;
}

/* ─── Panel behaviour: drag / resize / collapse / persist ────────── */
function applyGeom(panel) {
  if (isMobileView()) { panel.style.cssText = ''; return; }  /* CSS owns the bottom sheet */
  const maxX = window.innerWidth - 70, maxY = window.innerHeight - 44;
  panel.style.left   = Math.max(4, Math.min(GEOM.x, maxX)) + 'px';
  panel.style.top    = Math.max(0, Math.min(GEOM.y, maxY)) + 'px';
  panel.style.width  = Math.max(300, GEOM.w) + 'px';
  panel.style.height = GEOM.min ? 'auto' : Math.max(200, GEOM.h) + 'px';
}
function applyMin(panel) {
  panel.classList.toggle('min', !!GEOM.min);
  const b = panel.querySelector('.cpanel-min');
  if (b) b.innerHTML = GEOM.min ? '&#9635;' : '&#9601;';
}

function wirePanel(panel, onOpen, onClose, onResize) {
  const head = panel.querySelector('.cpanel-head');
  head.addEventListener('pointerdown', (e) => {
    if (e.target.closest('button') || isMobileView()) return;
    const r = panel.getBoundingClientRect();
    const ox = e.clientX - r.left, oy = e.clientY - r.top;
    const move = (ev) => {
      GEOM.x = Math.max(4, Math.min(ev.clientX - ox, window.innerWidth - 70));
      GEOM.y = Math.max(0, Math.min(ev.clientY - oy, window.innerHeight - 44));
      panel.style.left = GEOM.x + 'px';
      panel.style.top  = GEOM.y + 'px';
    };
    const up = () => {
      document.removeEventListener('pointermove', move);
      document.removeEventListener('pointerup', up);
      saveGeom(GEOM);
    };
    document.addEventListener('pointermove', move);
    document.addEventListener('pointerup', up);
    e.preventDefault();
  });

  if ('ResizeObserver' in window) {
    let t = null;
    new ResizeObserver(() => {
      if (panel.hidden || isMobileView() || GEOM.min) return;
      GEOM.w = panel.offsetWidth; GEOM.h = panel.offsetHeight;
      clearTimeout(t); t = setTimeout(() => saveGeom(GEOM), 250);
      onResize && onResize();
    }).observe(panel);
  }

  panel.querySelector('.cpanel-min').addEventListener('click', () => {
    GEOM.min = !GEOM.min; applyMin(panel); applyGeom(panel); saveGeom(GEOM);
    if (!GEOM.min) onResize && onResize();
  });
  panel.querySelector('.cpanel-x').addEventListener('click', () => {
    panel.hidden = true; GEOM.open = false; saveGeom(GEOM); onClose && onClose();
  });
  window.addEventListener('resize', () => { if (!panel.hidden) { applyGeom(panel); applyMin(panel); } });
}

/* ─── Image processing (local: never load user-system.js here) ───── */
const SIZES = { medium: { max: 800, q: 0.85 }, full: { max: 1600, q: 0.9 } };
function resizeToWebp(srcCanvas, max, q) {
  return new Promise((resolve) => {
    const sw = srcCanvas.width, sh = srcCanvas.height;
    const k = sw > max ? max / sw : 1;
    const c = document.createElement('canvas');
    c.width = Math.max(1, Math.round(sw * k));
    c.height = Math.max(1, Math.round(sh * k));
    const ctx = c.getContext('2d');
    ctx.fillStyle = '#fff'; ctx.fillRect(0, 0, c.width, c.height);  /* canvases can be transparent */
    ctx.drawImage(srcCanvas, 0, 0, c.width, c.height);
    c.toBlob(b => resolve(b), 'image/webp', q);
  });
}

/* ================================================================ */
const WB = {
  classId: null, panel: null, toggle: null, inst: null,
  liveUnsub: null, live: null, source: 'live', mounted: false
};

function msg(text) {
  const box = WB.panel?.querySelector('[data-wb-msg]');
  if (box) { box.textContent = text || ''; box.hidden = !text; }
}

function unmountBoard() {
  if (WB.inst) { try { WB.inst.destroy(); } catch (e) {} WB.inst = null; }
  const mount = WB.panel?.querySelector('[data-wb-mount]');
  if (mount) mount.innerHTML = '';
  WB.mounted = false;
}

async function mountLive() {
  const mount = WB.panel?.querySelector('[data-wb-mount]');
  if (!mount || !window.Whiteboard?.mountBoardView) return;
  unmountBoard();
  const boardId = WB.live?.boardId;
  if (!boardId) {
    msg('No live board right now. When the instructor goes live it appears here.');
    return;
  }
  msg('');
  mount.innerHTML = window.Whiteboard.boardShellHTML({
    classId: WB.classId, ids: false, back: false, zoomControls: true, maximize: false
  });
  WB.inst = await window.Whiteboard.mountBoardView(mount.querySelector('.wb-page'), {
    classId: WB.classId,
    boardId,
    chrome: 'panel',
    view:  { enabled: true },     /* the lens is per-screen; the projector never follows it */
    items: { enabled: true }
  });
  WB.mounted = !!WB.inst;
  if (!WB.inst) msg('Could not open the board.');
  refreshSnapButtons();
}

/* ─── The student's own board ───────────────────────────────────── */
async function mountMine() {
  const mount = WB.panel?.querySelector('[data-wb-mount]');
  if (!mount || !window.Whiteboard?.mountBoardView) return;
  unmountBoard();
  const uid = window.McgheeLab?.Auth?.currentUser?.uid;
  if (!uid) {
    msg(MODE === 'homework'
      ? 'Sign in with your NetID to use your homework board — your work is saved to your account only.'
      : 'Sign in with your NetID to keep your own notes here.');
    renderShareBar();
    return;
  }
  msg('');
  const boardId = window.Whiteboard.ownerBoardId(MODULE_KEY, uid);
  mount.innerHTML = window.Whiteboard.boardShellHTML({
    classId: WB.classId, ids: false, back: false, zoomControls: true, maximize: false
  });
  WB.inst = await window.Whiteboard.mountBoardView(mount.querySelector('.wb-page'), {
    classId: WB.classId,
    boardId,
    collection: BOARD_COLL,
    boardName: MODE === 'homework' ? 'My work — ' + MODULE_KEY : 'My notes — ' + MODULE_KEY,
    moduleKey: MODULE_KEY,
    chrome: 'panel',
    view:  { enabled: true },
    items: { enabled: true }
  });
  WB.mounted = !!WB.inst;
  if (!WB.inst) { msg('Could not open your board.'); return; }
  renderShareBar();
  refreshSnapButtons();
}

/* ─── Sharing (notes boards only) ───────────────────────────────── */
function shareBox() { return WB.panel?.querySelector('[data-wb-share]'); }

function renderShareBar() {
  const box = shareBox();
  if (!box) return;
  /* Homework is structurally unshareable — its rules contain no sharing
     clause at all — so there is no control to offer and no hint that one
     might exist. */
  if (WB.source !== 'mine' || MODE === 'homework' || !WB.inst) {
    box.hidden = true; box.innerHTML = '';
    return;
  }
  box.hidden = false;
  const shared = WB.inst.getShared();
  box.innerHTML = `
    <button type="button" class="wb-share-toggle" data-wb-share-toggle>
      Shared with ${shared.length || 'no one'}${shared.length ? '' : ' yet'} ▾
    </button>
    <div class="wb-share-list" data-wb-share-list hidden></div>`;
  box.querySelector('[data-wb-share-toggle]').addEventListener('click', () => {
    const list = box.querySelector('[data-wb-share-list]');
    list.hidden = !list.hidden;
    if (!list.hidden) loadDirectory(list, shared);
  });
}

/* The class roster is instructor-only (FERPA), and students cannot query
   `users`. So sharing reads an opt-in directory a staff member publishes:
   only classmates who chose to be findable appear, and nothing about
   anyone else is exposed. */
async function loadDirectory(listEl, shared) {
  const ML = window.McgheeLab;
  listEl.innerHTML = '<span class="wb-share-msg">Loading classmates…</span>';
  let people = [];
  try {
    const d = await ML.db.collection('schedules').doc(WB.classId)
      .collection('directory').doc('optedIn').get();
    people = d.exists ? (d.data().people || []) : [];
  } catch (e) {
    listEl.innerHTML = '<span class="wb-share-msg">Could not load the class list.</span>';
    return;
  }
  const me = ML.Auth?.currentUser?.uid;
  people = people.filter(p => p && p.uid && p.uid !== me);
  if (!people.length) {
    listEl.innerHTML = '<span class="wb-share-msg">No classmates have opted in to be findable yet. '
      + 'You can opt in yourself from the checkbox below so others can share with you.</span>'
      + optInHTML();
    wireOptIn(listEl);
    return;
  }
  const on = new Set(shared);
  listEl.innerHTML = people.map(p => `
    <label class="wb-share-row">
      <input type="checkbox" data-share-uid="${p.uid}" ${on.has(p.uid) ? 'checked' : ''}>
      <span>${(p.name || 'Classmate').replace(/[<>&]/g, '')}</span>
    </label>`).join('')
    + `<button type="button" class="wb-share-save" data-wb-share-save>Save</button>`
    + optInHTML();
  wireOptIn(listEl);
  listEl.querySelector('[data-wb-share-save]').addEventListener('click', async (e) => {
    const btn = e.currentTarget;
    btn.disabled = true; btn.textContent = 'Saving…';
    const uids = [...listEl.querySelectorAll('[data-share-uid]')]
      .filter(i => i.checked).map(i => i.dataset.shareUid);
    const ok = await WB.inst.setShared(uids);
    btn.disabled = false; btn.textContent = ok ? 'Saved' : 'Save';
    if (ok) setTimeout(renderShareBar, 700);
  });
}

function optInHTML() {
  return `<label class="wb-share-row wb-share-optin">
      <input type="checkbox" data-wb-optin>
      <span>Let classmates find me when they share notes</span>
    </label>`;
}

function wireOptIn(listEl) {
  const box = listEl.querySelector('[data-wb-optin]');
  if (!box) return;
  const ML = window.McgheeLab;
  const uid = ML.Auth?.currentUser?.uid;
  if (!uid) { box.disabled = true; return; }
  const ref = ML.db.collection('schedules').doc(WB.classId)
    .collection('directoryOptIn').doc(uid);
  ref.get().then(d => { box.checked = !!(d.exists && d.data().optIn); }).catch(() => {});
  box.addEventListener('change', () => {
    ref.set({
      displayName: ML.Auth?.currentUser?.displayName || (ML.Auth?.currentUser?.email || '').split('@')[0],
      optIn: box.checked,
      updatedAt: new Date().toISOString()
    }).catch(e => console.warn('[wb-panel] opt-in failed', e));
  });
}

/* ─── Export hook for the homework modules ──────────────────────
   A module's exportResults() calls this and folds the result into the
   payload it already downloads, so the student still turns in ONE file.
   Returns null when there is nothing to add, so the module can embed the
   result unconditionally. */
window.ML_WHITEBOARD_EXPORT = async function () {
  try {
    if (!WB.inst || WB.source !== 'mine') {
      /* mount it headlessly so a student who never opened the panel
         still gets whatever they drew earlier */
      if (!WB.classId || !window.McgheeLab?.Auth?.currentUser) return null;
      WB.source = 'mine';
      await mountMine();
      await new Promise(r => setTimeout(r, 900));   // let the strokes arrive
    }
    if (!WB.inst || !WB.inst.strokeCount()) return null;
    const pages = await WB.inst.exportPNGs({ width: 1600 });
    if (!pages.length) return null;
    return { schema: 'ml-whiteboard-v1', moduleKey: MODULE_KEY, mode: MODE,
             pageCount: pages.length, strokeCount: WB.inst.strokeCount(), pages };
  } catch (e) {
    console.warn('[wb-panel] export failed', e);
    return null;
  }
};

function openPanel() {
  WB.panel.hidden = false;
  GEOM.open = true; saveGeom(GEOM);
  applyGeom(WB.panel); applyMin(WB.panel);
  WB.toggle?.classList.add('on');
  if (WB.source === 'live' && !WB.mounted) mountLive();
}

function watchLive() {
  const ML = window.McgheeLab;
  if (!ML?.db || !WB.classId) { msg('Whiteboard unavailable here.'); return; }
  WB.liveUnsub = ML.db.collection('schedules').doc(WB.classId).onSnapshot((doc) => {
    const next = doc.exists ? (doc.data().liveWhiteboard || null) : null;
    const changed = (next?.boardId || null) !== (WB.live?.boardId || null);
    WB.live = next;
    WB.toggle?.classList.toggle('wb-tool-live', !!next?.boardId);
    if (changed && WB.source === 'live' && !WB.panel.hidden) mountLive();
    else if (changed && WB.source === 'live') unmountBoard();
  }, (err) => {
    console.warn('[wb-panel] live listener error', err);
    msg('Could not reach the class board.');
  });
}

/* ─── Snap a simulation canvas onto the live board ───────────────── */
function refreshSnapButtons() {
  /* Snapping targets the live class board, so it belongs to the
     instructor's view only — a student's own board has nothing to snap
     onto and the write would be denied anyway. */
  const canDraw = WB.source === 'live' && !!WB.inst?.isAdmin?.() && !!WB.live?.boardId;
  document.querySelectorAll('.wb-snap').forEach(b => b.remove());
  if (!canDraw) return;
  /* Key off the CANVAS, not the wrap: module 01 has 35 .canvas-wrap for
     32 canvases, so wrap-keyed buttons would strand three of them. */
  document.querySelectorAll('canvas').forEach((cv) => {
    if (cv.closest('.wb-panel')) return;             // never the board's own canvases
    const wrap = cv.closest('.canvas-wrap') || cv.parentElement;
    if (!wrap || wrap.querySelector('.wb-snap')) return;
    if (getComputedStyle(wrap).position === 'static') wrap.style.position = 'relative';
    const b = document.createElement('button');
    b.type = 'button';
    b.className = 'wb-snap';
    b.textContent = '→ Whiteboard';
    b.title = 'Send this figure to the live whiteboard';
    b.addEventListener('click', () => snapCanvas(cv, wrap, b));
    wrap.appendChild(b);
  });
}

async function snapCanvas(canvas, wrap, btn) {
  if (!WB.inst) return;
  const ML = window.McgheeLab;
  btn.disabled = true; btn.textContent = 'Sending…';
  try {
    /* Capture inside rAF: these sims animate, and a bare synchronous
       grab can land between clear and draw and return a blank frame. */
    const blobs = await new Promise((resolve) => {
      requestAnimationFrame(async () => {
        resolve({
          medium: await resizeToWebp(canvas, SIZES.medium.max, SIZES.medium.q),
          full:   await resizeToWebp(canvas, SIZES.full.max, SIZES.full.q)
        });
      });
    });
    if (!blobs.medium || !blobs.full) throw new Error('capture failed');

    const board = WB.inst.getBoard();
    const itemId = 'i' + Date.now().toString(36) + Math.random().toString(36).slice(2, 7);
    const base = `classes/${WB.classId}/whiteboards/${WB.live.boardId}/items/${itemId}`;
    const ref = firebase.storage().ref();
    const put = async (name, blob) => {
      const child = ref.child(`${base}/${name}.webp`);
      await child.put(blob, { contentType: 'image/webp' });
      return child.getDownloadURL();
    };
    const [url, fullUrl] = [await put('medium', blobs.medium), await put('full', blobs.full)];

    await WB.inst.addImageItem({
      itemId, url, fullUrl, storagePath: base,
      ar: canvas.width / Math.max(1, canvas.height),
      srcLabel: (wrap.querySelector('.canvas-title')?.textContent || '').trim(),
      srcModule: moduleSlug()
    });
  } catch (e) {
    console.warn('[wb-panel] snap failed', e);
    msg('Could not send that figure to the board.');
  } finally {
    btn.disabled = false; btn.textContent = '→ Whiteboard';
  }
}

/* ─── Boot ──────────────────────────────────────────────────────── */
function init() {
  WB.classId = getClassId();
  if (!WB.classId) return;                       // no class context → stay out of the way
  if (!window.Whiteboard?.mountBoardView) {
    console.warn('[wb-panel] whiteboard.js not loaded — panel disabled');
    return;
  }
  installAuthShim();
  WB.panel  = buildPanel();
  WB.toggle = buildToggle();

  wirePanel(WB.panel,
    null,
    () => unmountBoard(),
    () => { if (WB.inst) window.dispatchEvent(new Event('resize')); });

  WB.toggle.addEventListener('click', () => {
    if (WB.panel.hidden) openPanel();
    else { WB.panel.hidden = true; GEOM.open = false; saveGeom(GEOM); WB.toggle.classList.remove('on'); }
  });

  WB.panel.querySelectorAll('[data-wb-src]').forEach(tab => {
    tab.addEventListener('click', () => {
      WB.source = tab.dataset.wbSrc;
      WB.panel.querySelectorAll('.wb-panel-tab').forEach(t =>
        t.classList.toggle('wb-panel-tab-on', t === tab));
      if (WB.source === 'live') { mountLive(); renderShareBar(); }
      else mountMine();
    });
  });

  watchLive();
  if (GEOM.open) openPanel();

  /* The rail navigates by hash and widgets build late; re-scan so a
     newly built canvas still gets its snap button. */
  window.addEventListener('hashchange', () => { if (WB.mounted) refreshSnapButtons(); });
}

  /* ================================================================
     V3.736 — EMBED MODE: ?embed=T.S shows ONE section of this module —
     the lesson block whose heading is h2[data-nav="T.S"] — fitted to the
     viewport, with the page chrome (header, tab bar, rail, other blocks)
     hidden. The whiteboard hosts the module in an iframe at page size,
     so a simulation arrives on the board with all of its controls, live,
     exactly as the module renders it. Runs before the class header, and
     works without ?class= (a direct link is enough).
     ================================================================ */
function getEmbedRef() {
    const v = new URLSearchParams(window.location.search).get('embed');
    return v && /^\d+\.\d+$/.test(v) ? v : null;
  }
function setupEmbed(ref) {
    const h2 = document.querySelector('h2[data-nav="' + ref + '"]');
    document.body.classList.add('wb-embed');
    /* V3.737 — &sim=1: the SIMULATION only (scenario bar + control panel +
       canvases), no story or task text. This is what
       modules/<class>/simulations/N.T.S.html opens. */
    const simOnly = /(?:^|[?&])sim=1(?:&|$)/.test(window.location.search);
    if (simOnly) document.body.classList.add('wb-embed-sim');
    const style = document.createElement('style');
    style.textContent = `
      body.wb-embed header, body.wb-embed .tab-bar, body.wb-embed #rail, body.wb-embed footer,
      body.wb-embed #module-header, body.wb-embed .constants-bar, body.wb-embed .wb-tool-btn,
      body.wb-embed .cpanel, body.wb-embed .wb-snap, body.wb-embed .lesson-block:not(.wb-embed-target){ display: none !important; }
      body.wb-embed .sources, body.wb-embed main > :not(.tab-content){ display: none !important; }
      body.wb-embed, body.wb-embed.hasrail{ margin: 0; padding: 0 !important; background: #fff; overflow: hidden auto; }
      body.wb-embed main{ padding: 0 !important; margin: 0 !important; max-width: none !important; }
      body.wb-embed .tab-content.active > :not(.wb-embed-target){ display: none !important; }
      body.wb-embed .lesson-block.wb-embed-target{ margin: 0 auto; min-height: 0; padding: 12px 16px; box-sizing: border-box; max-width: 1200px; }
      body.wb-embed .wb-embed-missing{ padding: 24px; font: 15px system-ui, sans-serif; color: #b91c1c; }
      body.wb-embed-sim .lesson-block.wb-embed-target > .background-section,
      body.wb-embed-sim .lesson-block.wb-embed-target > .student-task,
      body.wb-embed-sim .lesson-block.wb-embed-target > .insight,
      body.wb-embed-sim .lesson-block.wb-embed-target > p{ display: none !important; }
      body.wb-embed-sim .lesson-block.wb-embed-target > h2{ font-size: 1.05rem; margin: 0 0 8px; }
      body.wb-embed-sim .lesson-block.wb-embed-target{ padding: 10px 14px; }`;
    document.head.appendChild(style);
    if (!h2) {
      const msg = document.createElement('div');
      msg.className = 'wb-embed-missing';
      msg.textContent = 'Section ' + ref + ' was not found in this module.';
      document.body.prepend(msg);
      return;
    }
    const block = h2.closest('.lesson-block') || h2.parentElement;
    block.classList.add('wb-embed-target');
    /* activate the block's tab through the module's OWN handler so its
       animation gating (syncVis) and canvas cache see the switch */
    const sec = block.closest('.tab-content');
    const key = sec && sec.id.replace(/^tab-/, '');
    const btn = key && document.querySelector('.tab-btn[data-tab="' + key + '"]');
    if (btn && !btn.classList.contains('active')) btn.click();
    /* NO scaling in here. The module sizes canvases from
       getBoundingClientRect(); a zoom/transform on an ancestor changes what
       that returns and setupCanvas writes it back as the inline width — a
       feedback loop that shrank canvases to 0. The whiteboard lays this
       document out at a fixed desktop width and scales the IFRAME element
       instead, which leaves the module's own measurements untouched. */
    const report = () => {
      try { window.parent.postMessage({ source: 'ml-module', type: 'embed-size', ref, w: block.offsetWidth, h: block.offsetHeight }, window.location.origin); } catch (e) {}
    };
    window.addEventListener('load', () => setTimeout(report, 250));
    setTimeout(report, 600);
    /* tell the host we are ready (it may show a placeholder until then) */
    try { window.parent.postMessage({ source: 'ml-module', type: 'embed-ready', ref }, window.location.origin); } catch (e) {}
  }


/* A module embedded INSIDE the whiteboard (?embed=T.S) shows one section
   and must not mount its own whiteboard panel: no button, no listeners. */
const EMBED_REF = getEmbedRef();
function bootEmbedOrPanel() { if (EMBED_REF) setupEmbed(EMBED_REF); else init(); }
if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', bootEmbedOrPanel);
else bootEmbedOrPanel();

})();
