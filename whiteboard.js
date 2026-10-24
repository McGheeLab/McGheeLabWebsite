/* ================================================================
   Whiteboard (V3.677) — live lecture drawing streamed via Firestore
   ================================================================
   Generic class-builder capability. A 'whiteboard' section on any class
   page lists named, persistent boards; opening one routes to
   #/classes/{classId}/whiteboard/{boardId} — a full-viewport board view.

   Roles:
   - Class admins (global admin, schedule ownerUid, or classAdminEmails)
     get the drawing tools: pen (4 colors × 3 widths, Apple Pencil
     pressure), stroke eraser, undo, clear page, multi-page + per-page
     background templates, Go live / End live.
   - Everyone else (including logged out) is a live viewer that
     auto-follows the admin's active page.
   - ?projector=1 renders chrome-free for the classroom screen.

   Sync model (Firestore only — no RTDB, no Cloud Functions):
   - schedules/{classId}/whiteboards/{boardId} — board meta
     { name, createdAt, updatedAt, pages:[{id,background}], activePageId }
   - .../whiteboards/{boardId}/strokes/{strokeId}
     { pageId, seq, color, w, pts:[x0,y0,p0,...], done }
     The drawer flushes the in-progress stroke every FLUSH_MS with a full
     doc rewrite (arrays can't append in Firestore; strokes are small);
     viewers hold one onSnapshot orderBy('seq') (single-field — no
     composite index) and repaint incrementally via rAF.
   - Going live merges { liveWhiteboard:{boardId,boardName,since} } onto
     schedules/{classId} (admins can already write the schedule doc);
     class-builder calls attachLiveBanner() so students on any tab see
     the 🔴 banner. Page flips ride activePageId on the BOARD doc so they
     never spam schedule-doc listeners.

   Coordinates are normalized to a fixed 16:10 board space (x∈[0,1],
   y∈[0,0.625], widths as a fraction of board width) so the iPad, student
   laptops, and the projector render identically at any pixel size.

   Input: pointerType 'pen' and 'mouse' draw (pen-only inking on iPad =
   true palm rejection; mouse kept so desktop testing works); touch NEVER
   inks. Pressure maps to line width. getCoalescedEvents() when available.

   Rendering (V3.727): three stacked canvases sized at devicePixelRatio —
   bg (template), ink (committed strokes), live (the stroke being drawn).
   Each stroke is ONE filled variable-width outline of its Catmull-Rom
   spline (see "ONE FILLED OUTLINE PER STROKE" below); nothing is ever
   stroked segment-by-segment or overdrawn, because overlapping
   antialiased edges compound into hard ones and that — not the raster —
   is what read as "pixelated".
   ================================================================ */

(function () {
'use strict';

window.McgheeLab = window.McgheeLab || {};

/* ─── Constants ─────────────────────────────────────────────── */
const BOARD_AR   = 16 / 10;         // board aspect ratio (see plan open-Q 4)
const BOARD_H    = 1 / BOARD_AR;    // 0.625 — normalized board height
const FLUSH_MS   = 300;             // in-progress stroke flush cadence
/* V3.683 — sampling resolution. MIN_SEG was 0.0012 (~1.7 px on a 1400 px
   board), which threw away real pen detail at capture time; 0.0004 keeps
   roughly 3× more samples. SIMPLIFY_EPS pays for that on the wire: at
   flush time a Ramer-Douglas-Peucker pass drops points that sit on an
   already-straight run while keeping every point that carries curvature,
   so dense handwriting stays dense and long sweeping lines cost almost
   nothing. Net transfer is about flat; resolution is not. */
const MIN_SEG      = 0.0004;        // min normalized distance between samples
const SIMPLIFY_EPS = 0.00028;       // RDP tolerance, normalized board units
/* Hard ceiling on STORED points per stroke. Measured worst case: a very
   noisy digitizer defeats a fixed RDP tolerance (tremor reads as real
   curvature, so nothing is dropped) and denser sampling would then cost
   MORE bandwidth than V3.677 did, not less. Exceeding this budget
   re-simplifies at a coarser tolerance until it fits, which bounds the
   payload at roughly the old per-stroke size no matter how noisy the pen,
   while a clean pen keeps the full ~80% saving. */
const WIRE_MAX_PTS = 900;
/* Raised V3.683 (was 1200): this bounds the LOCAL sample array, while what
   reaches Firestore is the RDP-simplified copy, so a denser MIN_SEG no
   longer has to mean chaining a new doc three times as often. Worst-case
   stored payload stays far under the 1 MB doc limit. */
const MAX_PTS    = 3000;            // split strokes longer than this (doc size)
/* V3.678 added `desynchronized:true` to the ink context speculatively (a
   latency hint Alex never asked for — he called the pen "very nice" and
   only reported the selection bug). Some implementations back a
   desynchronized canvas with a lower-fidelity surface, which is a
   candidate for the fuzzy ink reported after that release, so it is off
   by default. Flip to true only to A/B latency on a real device. */
const LOW_LATENCY_CANVAS = false;
const ERASE_TOL  = 0.008;           // eraser hit-test slop (normalized)
/* V3.730 — the sheet. Pages are stacked vertically on one continuous
   surface; the view SNAPS so the centred page fills the middle of the
   stage with about a quarter of each neighbour peeking in above and
   below. All sheet distances are in PAGE-WIDTH units (the same unit
   stroke coordinates already use), so pageTop(i) is the sheet y of page
   i's top edge and a stroke on page i paints at (x, pageTop(i) + y). */
const PAGE_GAP            = 0.02;   // desk visible between pages (pages mode only)
const SHEET_VISIBLE_PAGES = 1.5;    // centred page + ¼ + ¼ fill the stage height
const SNAP_MS             = 260;    // page-snap tween
const RAIL_MIN_ROOT_W     = 560;    // below this the thumbnail rail collapses to dots
/* V3.801 — continuous sheet (the default layout). The leader publishes the
   sheet y at the middle of its stage (`viewY` on the board doc) while it
   scrolls, at most once per SCROLL_SYNC_MS; followers ease to each update
   over FOLLOW_TWEEN_MS, so four updates a second read as one smooth scroll.
   The recorder keeps a scroll event at most every REC_SCROLL_MS. */
const SCROLL_SYNC_MS  = 250;
const FOLLOW_TWEEN_MS = 240;
const REC_SCROLL_MS   = 400;
/* V3.736 — simulation pages. A page may be a live learning-module section
   (`kind:'sim'`) hosted in an iframe. The module lays itself out at this
   fixed desktop size and the whiteboard SCALES THE IFRAME ELEMENT to the
   page rect, so the module's own canvas measurements stay untouched. */
const SIM_W = 1280, SIM_H = 800;    // iframe's internal viewport (16:10, like a page)
const COLORS     = ['#111827', '#dc2626', '#2563eb', '#059669'];
const PEN_WIDTHS = [
  { key: 'fine', w: 0.0022, label: 'Fine'   },
  { key: 'med',  w: 0.0042, label: 'Medium' },
  { key: 'bold', w: 0.0080, label: 'Bold'   }
];
/* V3.839 — the PEN SET: the pens and highlighters a person keeps, on THIS
   device (localStorage, shared by every board). A pen = colour + width; a
   highlighter paints a wide translucent band, multiplied under the ink.
   Class boards keep the fixed toolbar above; host boards (notebook, figure
   board) show the set in the pens pill. */
const PEN_SET_KEY = 'wb_pens_v1';
const PILL_POS_KEY = 'wb_pillpos_v1';
const PEN_SWATCHES = ['#111827', '#dc2626', '#2563eb', '#059669', '#7c3aed', '#db2777', '#ea580c', '#ca8a04', '#0d9488', '#64748b',
                      '#78350f', '#0D675E', '#fde047', '#86efac', '#93c5fd', '#f9a8d4', '#fdba74', '#c4b5fd', '#a3e635', '#f87171'];
const HL_DEFAULT_W = 0.014;
const HL_ALPHA = 0.42;
/* soft tints a card can take (header fill + body wash); '' = none */
const ITEM_TINTS = ['', '#fef3c7', '#dcfce7', '#dbeafe', '#fce7f3', '#ede9fe', '#ffedd5', '#ccfbf1', '#e5e7eb', '#fecaca'];
/* V3.842 — regions: a named, coloured box around the cards inside it */
const REGION_COLORS = ['#0D675E', '#b45309', '#2563eb', '#be185d', '#6d28d9', '#15803d'];
const ERASER_DEFAULT_W = 0.012;
const PEN_KINDS = { pen: { lo: 0.001, hi: 0.016, def: PEN_WIDTHS[1].w }, hl: { lo: 0.006, hi: 0.04, def: HL_DEFAULT_W }, eraser: { lo: 0.004, hi: 0.05, def: ERASER_DEFAULT_W } };
function penKind(k) { return k === true || k === 'hl' ? 'hl' : k === 'eraser' ? 'eraser' : 'pen'; }
function clampPenW(w, kind) {
  const K = PEN_KINDS[penKind(kind)];
  w = +w;
  if (!isFinite(w)) return K.def;
  return Math.min(K.hi, Math.max(K.lo, w));
}
function defaultPenSet() {
  return COLORS.map((c, i) => ({ id: 'pen' + (i + 1), kind: 'pen', color: c, w: PEN_WIDTHS[1].w }))
    .concat([{ id: 'hl1', kind: 'hl', color: '#fde047', w: HL_DEFAULT_W }, { id: 'er1', kind: 'eraser', color: '#ffffff', w: ERASER_DEFAULT_W }]);   // V3.841 — an eraser in the set
}
function loadPenSet() {
  try {
    const raw = localStorage.getItem(PEN_SET_KEY);
    if (raw) {
      const arr = JSON.parse(raw);
      if (Array.isArray(arr)) {
        const out = arr.filter(p => p && p.id && /^#[0-9a-f]{6}$/i.test(String(p.color || '')))
          .map(p => ({ id: String(p.id).slice(0, 40), kind: penKind(p.kind), color: String(p.color).toLowerCase(), w: clampPenW(p.w, p.kind) }));
        if (out.length) return out.slice(0, 12);
      }
    }
  } catch (e) {}
  return defaultPenSet();
}
function savePenSet(list) { try { localStorage.setItem(PEN_SET_KEY, JSON.stringify((list || []).slice(0, 12))); } catch (e) {} }
function loadPillPos() {
  try { const v = JSON.parse(localStorage.getItem(PILL_POS_KEY) || '{}'); return (v && typeof v === 'object') ? v : {}; } catch (e) { return {}; }
}
function savePillPos(pos) { try { localStorage.setItem(PILL_POS_KEY, JSON.stringify(pos || {})); } catch (e) {} }
const BACKGROUNDS = [
  { key: 'blank', label: 'Blank' },
  { key: 'grid',  label: 'Grid'  },
  { key: 'ruled', label: 'Ruled' },
  { key: 'axes',  label: 'Axes'  }
];

/* ─── Helpers ───────────────────────────────────────────────── */
function esc(str) {
  return (str ?? '').toString().replace(/[&<>"']/g, s =>
    ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#039;' }[s]));
}
function escAttr(str) { return esc(str); }
/* V3.852 — a phone (either orientation): a coarse pointer and a short side under 700 px. An iPad is a desktop. */
function detectMobile() {
  try { return window.matchMedia('(pointer: coarse)').matches && Math.min(window.innerWidth, window.innerHeight) < 700; } catch (e) { return false; }
}
function mobile() { return !!(S && S.mobile); }
function db()  { return window.McgheeLab?.db || null; }
function FV()  { return firebase.firestore.FieldValue; }
/* V3.685 — three board families live under a schedule, all sharing this
   engine and this doc shape. WHICH collection is the whole access model:
     whiteboards  — the instructor's live class boards. World-readable,
                    class-admin write.
     notesBoards  — a student's own notes for a learning module. Owner
                    write; owner + anyone on sharedWithUids may read.
     hwBoards     — a student's homework working-out. Owner + staff only,
                    and there is NO sharing clause anywhere in its rules.
   That last point is deliberate and structural: "homework can never be
   shared with classmates" is a property of the rules file, not a flag on
   a document that a client could try to flip. */
const BOARD_COLLECTIONS = ['whiteboards', 'notesBoards', 'hwBoards', 'notebookBoards', 'paperBoards'];
function boardsCol(classId, coll) {
  const c = BOARD_COLLECTIONS.includes(coll) ? coll : 'whiteboards';
  /* V3.830 — a lab-notebook whiteboard block lives under its OWNER, not a
     class: `userData/{uid}/notebookBoards/{bid}`. The classId slot carries
     the owner uid, so every existing call site (strokes, items, recordings,
     events, replay) routes through here unchanged. */
  if (c === 'notebookBoards') return db().collection('userData').doc(classId).collection('notebookBoards');
  /* V3.837 — a paper's figure board: the PAPER id rides in the classId slot */
  if (c === 'paperBoards') return db().collection('papers').doc(classId).collection('boards');
  return db().collection('schedules').doc(classId).collection(c);
}
/* V3.830 — the notebook family: one owner, no class, no leader/follower,
   continuous sheet only, recording without a live flag. */
/* 'notebook' here means a HOST board (no class, no live flag): the lab notebook's
   entry boards (V3.830) and a paper's figure board (V3.837) */
function isNotebook() { return !!S && (S.coll === 'notebookBoards' || S.coll === 'paperBoards'); }
/* V3.841 — host boards are an INFINITE canvas: one plane, no page edges,
   pan in every direction. The board doc keeps its pages[] (class code and
   old data need it); the first page is the plane and every stroke / item
   lives on it with unbounded coordinates. Class boards keep their pages. */
function infinite() { return isNotebook(); }
function planeId() { return (S?.board?.pages || [])[0]?.id || 'p1'; }
/** Fold a legacy page-local doc onto the plane: absolute y, the plane's id.
 *  Idempotent (a folded doc is already on pages[0]). Mutates `d`. */
function foldToPlane(d) {
  if (!infinite() || !d || !d.pageId) return d;
  const pages = S.board?.pages || [];
  if (pages.length < 2) return d;
  const idx = pages.findIndex(p => p.id === d.pageId);
  if (idx <= 0) return d;
  const dy = pageTop(idx);
  d.pageId = pages[0].id;
  if (Array.isArray(d.pts)) { const pts = d.pts; if (Array.isArray(pts[0])) pts.forEach(p => { p[1] += dy; }); else for (let i = 1; i < pts.length; i += 3) pts[i] = round5(pts[i] + dy); }
  else if (typeof d.y === 'number') d.y = round4(d.y + dy);
  return d;
}
function foldAllToPlane() {
  if (!S || !infinite() || (S.board?.pages || []).length < 2) return;
  S.strokes.forEach(s => foldToPlane(s)); S.items.forEach(it => foldToPlane(it));
}
function hostPrefixFor(coll) { return coll === 'paperBoards' ? 'paper-boards' : 'notebook-boards'; }

/* Per-student board ids are `{key}_{uid}`, so the rules can authorise the
   owner with `boardId.split('_')[1] == request.auth.uid` — no document
   read, and it works before the board exists (which matters: a student's
   first visit reads a board that has not been created yet). Keys must
   therefore never contain an underscore. */
function ownerBoardId(key, uid) {
  return String(key || '').replace(/_/g, '-') + '_' + uid;
}
function round4(n) { return Math.round(n * 10000) / 10000; }
/* V3.683 — position gets a decimal (1e-5 of board width ≈ 0.015 px, so
   quantization can no longer flatten a gentle curve into stair-steps);
   pressure loses two, since it only ever scales a line width. Net bytes
   per point are unchanged. */
function round5(n) { return Math.round(n * 100000) / 100000; }
function round2(n) { return Math.round(n * 100) / 100; }
function newId(prefix) {
  return prefix + Date.now().toString(36) + Math.random().toString(36).slice(2, 7);
}

/* V3.685 — may the current user draw on the MOUNTED board? For the
   instructor's live boards that is the class-admin gate; for a student's
   own notes/homework it is simply ownership, checked the same way the
   rules check it (from the board id) so the two cannot disagree. */
function computeCanDraw() {
  if (!S) return false;
  if (S.coll === 'whiteboards') return computeIsClassAdmin(S.schedule);
  /* V3.837 — a shared board (a paper's figure board) is gated by the HOST,
     which knows the paper's authors; the rules enforce the same gate */
  if (S.canEdit !== null && S.canEdit !== undefined) return !!S.canEdit;
  const uid = window.McgheeLab?.Auth?.currentUser?.uid;
  return !!uid && S.boardId.split('_')[1] === uid;
}

function computeIsClassAdmin(schedule) {
  const Auth = window.McgheeLab?.Auth;
  if (!Auth?.currentUser) return false;
  if (Auth.currentProfile?.role === 'admin') return true;
  if (schedule?.ownerUid && schedule.ownerUid === Auth.currentUser.uid) return true;
  const email = (Auth.currentUser.email || '').toLowerCase();
  const admins = Array.isArray(schedule?.classAdminEmails)
    ? schedule.classAdminEmails.map(e => (e || '').toLowerCase()) : [];
  return !!email && admins.includes(email);
}

/* Toast, not alert (feedback_no_browser_input_popups). */
let _toastTimer = null;
function toast(msg) {
  /* local named `node`, not `el` — el() is the mounted-board element
     resolver (V3.684) and shadowing it here would be a trap for the
     next edit in this function. */
  let node = document.getElementById('wb-toast');
  if (!node) {
    node = document.createElement('div');
    node.id = 'wb-toast';
    node.className = 'wb-toast';
    document.body.appendChild(node);
  }
  node.textContent = msg;
  node.classList.add('wb-toast-show');
  clearTimeout(_toastTimer);
  _toastTimer = setTimeout(() => node.classList.remove('wb-toast-show'), 3200);
}

/* Two-tap destructive confirm: first tap arms the button for 3s. */
function armTwoTap(btn, armedLabel) {
  if (btn.dataset.wbArmed === '1') {
    btn.dataset.wbArmed = '';
    return true;
  }
  btn.dataset.wbArmed = '1';
  const orig = btn.textContent;
  btn.textContent = armedLabel;
  btn.classList.add('wb-armed');
  setTimeout(() => {
    if (btn.isConnected && btn.dataset.wbArmed === '1') {
      btn.dataset.wbArmed = '';
      btn.textContent = orig;
      btn.classList.remove('wb-armed');
    }
  }, 3000);
  return false;
}

/* ================================================================
   SECTION BODY — the board list inside a class-page section
   ================================================================ */
/** Called synchronously from class-builder's renderSectionBody switch.
 * Returns placeholder HTML and schedules async hydration (the canvas is
 * rebuilt often; hydration re-queries the container by id each time). */
function renderSectionBody(section, scheduleId, opts) {
  const canEdit = !!opts?.canEdit;
  const liveBoardId = opts?.liveWhiteboard?.boardId || null;
  const liveRecId = opts?.liveWhiteboard?.recId || null;
  const cid = `wb-sec-${section.id}`;
  setTimeout(() => hydrateSection(cid, scheduleId, canEdit, liveBoardId, liveRecId), 0);
  return `<div class="wb-section" id="${escAttr(cid)}" data-schedule-id="${escAttr(scheduleId)}">
    <p class="muted-text">Loading boards…</p>
  </div>`;
}

async function hydrateSection(containerId, scheduleId, canEdit, liveBoardId, liveRecId) {
  const host = document.getElementById(containerId);
  if (!el || !db()) return;
  let boards = [];
  try {
    const snap = await boardsCol(scheduleId).orderBy('updatedAt', 'desc').get();
    boards = snap.docs.map(d => ({ id: d.id, ...d.data() }));
  } catch (e) {
    console.warn('[whiteboard] board list load failed', e);
    host.innerHTML = '<p class="muted-text">Could not load boards.</p>';
    return;
  }
  if (!host.isConnected) return;

  let html = '';
  if (canEdit) {
    html += `<div class="wb-new-row">
      <button type="button" class="btn btn-small" data-wb-act="new-board-toggle">+ New board</button>
      <form class="wb-new-form" data-wb-new-form hidden>
        <input type="text" class="wb-input" data-wb-new-name maxlength="80"
               placeholder="Board name (e.g. Week 3 — Fick's laws)" />
        <button type="submit" class="btn btn-small">Create</button>
        <button type="button" class="btn btn-small btn-secondary" data-wb-act="new-board-cancel">Cancel</button>
        <span class="wb-field-err" data-wb-new-err></span>
      </form>
    </div>`;
  }
  if (!boards.length) {
    html += `<p class="muted-text">${canEdit
      ? 'No boards yet — create one and open it on your tablet.'
      : 'No boards yet.'}</p>`;
  } else {
    html += '<div class="wb-board-list">';
    boards.forEach(b => {
      const live = b.id === liveBoardId;
      const pages = Array.isArray(b.pages) ? b.pages.length : 1;
      const updated = b.updatedAt?.toDate ? b.updatedAt.toDate().toLocaleDateString() : '';
      html += `<div class="wb-board-row${live ? ' wb-board-row-live' : ''}" data-board-id="${escAttr(b.id)}">
        <a class="wb-board-open" href="#/classes/${escAttr(scheduleId)}/whiteboard/${escAttr(b.id)}">
          ${live ? '<span class="wb-live-dot" title="Live now"></span>' : ''}
          <span class="wb-board-name" data-wb-name>${esc(b.name || 'Untitled board')}</span>
          <span class="wb-board-meta muted-text">${pages} page${pages === 1 ? '' : 's'}${updated ? ' · ' + esc(updated) : ''}</span>
        </a>
        ${canEdit ? `
        <div class="wb-board-actions">
          <button type="button" class="btn btn-small btn-ghost" data-wb-act="rename" title="Rename">✎</button>
          <button type="button" class="btn btn-small btn-danger" data-wb-act="delete" title="Delete board">&times;</button>
        </div>` : ''}
        <div class="wb-rec-list" data-wb-rec-list hidden></div>
      </div>`;
    });
    html += '</div>';
  }
  host.innerHTML = html;
  /* V3.731 — each board's recorded lectures, loaded after the list paints */
  boards.forEach(b => hydrateRecordings(host, scheduleId, b.id, canEdit, liveRecId));
}

async function hydrateRecordings(host, scheduleId, boardId, canEdit, liveRecId) {
  const row = host.querySelector(`.wb-board-row[data-board-id="${boardId}"]`);
  const box = row?.querySelector('[data-wb-rec-list]');
  if (!box) return;
  let recs = [];
  try {
    const snap = await boardsCol(scheduleId).doc(boardId).collection('recordings')
      .orderBy('startedAtMs', 'desc').limit(20).get();
    recs = snap.docs.map(d => ({ id: d.id, ...d.data() }));
  } catch (e) { console.warn('[whiteboard] recordings load failed', e); return; }
  if (!box.isConnected) return;
  const rows = recs.map(r => {
    const when = r.startedAtMs ? new Date(r.startedAtMs).toLocaleDateString(undefined, { month: 'short', day: 'numeric', year: 'numeric' }) : '';
    if (r.status === 'ready') {
      const mins = Math.max(1, Math.round((r.durationMs || 0) / 60000));
      return `<a class="wb-rec" href="#/classes/${escAttr(scheduleId)}/whiteboard/${escAttr(boardId)}?replay=${escAttr(r.id)}">
        <span class="wb-rec-play">${ICON.svg('play')}</span>
        <span class="wb-rec-name">${esc(r.name || 'Recording')}</span>
        <span class="wb-rec-meta muted-text">${esc(when)} · ${mins} min</span></a>`;
    }
    if (r.id === liveRecId) {
      return `<span class="wb-rec wb-rec-live"><span class="wb-live-dot"></span> Recording now${when ? ' · ' + esc(when) : ''}</span>`;
    }
    /* left in 'recording' with no live session: interrupted */
    if (!canEdit) return '';
    const saved = Math.round(((r.chunks || []).length * REC_CHUNK_MS) / 60000);
    return `<span class="wb-rec wb-rec-interrupted">${ICON.svg('exclamation-triangle')} Interrupted${when ? ' · ' + esc(when) : ''} · ${saved} min saved
      <button type="button" class="btn btn-small" data-wb-act="rec-finalize" data-rec-id="${escAttr(r.id)}">Finalize</button></span>`;
  }).filter(Boolean);
  if (!rows.length) return;
  box.innerHTML = `<div class="wb-rec-head muted-text">Recorded lectures</div>${rows.join('')}`;
  box.hidden = false;
}

/* Delegated clicks for the section list (survives canvas rebuilds). */
document.addEventListener('click', async (e) => {
  const btn = e.target.closest('[data-wb-act]');
  if (!btn) return;
  const act = btn.dataset.wbAct;
  const sec = btn.closest('.wb-section');

  /* ── section-list actions ── */
  if (sec) {
    const scheduleId = sec.dataset.scheduleId;
    if (act === 'new-board-toggle') {
      const form = sec.querySelector('[data-wb-new-form]');
      if (form) { form.hidden = !form.hidden; form.querySelector('[data-wb-new-name]')?.focus(); }
      return;
    }
    if (act === 'new-board-cancel') {
      const form = sec.querySelector('[data-wb-new-form]');
      if (form) form.hidden = true;
      return;
    }
    if (act === 'rename') {
      const row = btn.closest('.wb-board-row');
      const nameEl = row?.querySelector('[data-wb-name]');
      if (!row || !nameEl || row.querySelector('.wb-rename-input')) return;
      const input = document.createElement('input');
      input.type = 'text'; input.maxLength = 80;
      input.className = 'wb-input wb-rename-input';
      input.value = nameEl.textContent;
      nameEl.replaceWith(input);
      input.focus(); input.select();
      const commit = async () => {
        const v = input.value.trim();
        const span = document.createElement('span');
        span.className = 'wb-board-name'; span.dataset.wbName = '';
        span.textContent = v || 'Untitled board';
        input.replaceWith(span);
        if (v) {
          try {
            await boardsCol(scheduleId).doc(row.dataset.boardId)
              .update({ name: v, updatedAt: FV().serverTimestamp() });
          } catch (err) { console.warn('[whiteboard] rename failed', err); toast('Rename failed — are you a class admin?'); }
        }
      };
      input.addEventListener('keydown', ev => {
        if (ev.key === 'Enter') { ev.preventDefault(); input.blur(); }
        if (ev.key === 'Escape') { input.value = nameEl.textContent; input.blur(); }
      });
      input.addEventListener('blur', commit, { once: true });
      /* the anchor wraps the name — stop navigation while renaming */
      input.addEventListener('click', ev => { ev.preventDefault(); ev.stopPropagation(); });
      return;
    }
    if (act === 'rec-finalize') {
      const row = btn.closest('.wb-board-row');
      const boardId = row?.dataset.boardId, recId = btn.dataset.recId;
      if (!boardId || !recId) return;
      btn.disabled = true;
      try {
        await finalizeInterrupted(scheduleId, boardId, recId);
        toast('Recording finalized.');
        const host = btn.closest('.wb-section');
        if (host) hydrateRecordings(host, scheduleId, boardId, true, null);
      } catch (err) { console.warn('[whiteboard] finalize failed', err); toast('Could not finalize — are you a class admin?'); btn.disabled = false; }
      return;
    }
    if (act === 'delete') {
      if (!armTwoTap(btn, 'Really delete?')) return;
      const row = btn.closest('.wb-board-row');
      const boardId = row?.dataset.boardId;
      if (!boardId) return;
      btn.disabled = true;
      try {
        await deleteBoardDeep(scheduleId, boardId);
        row.remove();
        toast('Board deleted.');
      } catch (err) {
        console.warn('[whiteboard] delete failed', err);
        toast('Delete failed — are you a class admin?');
        btn.disabled = false;
      }
      return;
    }
  }

  /* ── board-page toolbar actions ── */
  /* class, not id — the module panel mounts the same shell without ids */
  if (S && btn.closest('.wb-page')) handleBoardAction(act, btn);
});

/* New-board form submit (delegated). */
document.addEventListener('submit', async (e) => {
  const form = e.target.closest('[data-wb-new-form]');
  if (!form) return;
  e.preventDefault();
  const sec = form.closest('.wb-section');
  const scheduleId = sec?.dataset.scheduleId;
  const nameInput = form.querySelector('[data-wb-new-name]');
  const errEl = form.querySelector('[data-wb-new-err]');
  const name = (nameInput?.value || '').trim();
  if (!name) { if (errEl) errEl.textContent = 'Give the board a name.'; return; }
  if (errEl) errEl.textContent = '';
  try {
    const ref = boardsCol(scheduleId).doc(newId('b'));
    await ref.set({
      name,
      pages: [{ id: 'p1', background: 'blank' }],
      activePageId: 'p1',
      createdAt: FV().serverTimestamp(),
      updatedAt: FV().serverTimestamp()
    });
    window.location.hash = `#/classes/${scheduleId}/whiteboard/${ref.id}`;
  } catch (err) {
    console.warn('[whiteboard] create failed', err);
    if (errEl) errEl.textContent = 'Create failed — are you a class admin?';
  }
});

/** Delete a board and its strokes (chunked batches of 400). */
async function deleteBoardDeep(scheduleId, boardId) {
  const strokesRef = boardsCol(scheduleId).doc(boardId).collection('strokes');
  for (;;) {
    const snap = await strokesRef.limit(400).get();
    if (snap.empty) break;
    const batch = db().batch();
    snap.docs.forEach(d => batch.delete(d.ref));
    await batch.commit();
    if (snap.size < 400) break;
  }
  /* V3.731 — recordings (and their events) go with the board. Audio
     chunks in Storage are left for a later sweep; nothing points at them. */
  try {
    const recs = await boardsCol(scheduleId).doc(boardId).collection('recordings').get();
    for (const r of recs.docs) {
      const evs = await r.ref.collection('events').limit(400).get();
      const batch = db().batch();
      evs.docs.forEach(d => batch.delete(d.ref));
      batch.delete(r.ref);
      await batch.commit();
    }
  } catch (e) { console.warn('[whiteboard] recordings cleanup failed', e); }
  await boardsCol(scheduleId).doc(boardId).delete();
}

/* ================================================================
   LIVE BANNER — "🔴 Whiteboard is live" on the class page
   ================================================================ */
let _bannerUnsub = null;
let _bannerScheduleId = null;

/** Called by class-builder's wireClassPage. Watches the schedule doc's
 * liveWhiteboard field and shows a sticky banner on any tab. */
function attachLiveBanner(scheduleId) {
  detachLiveBanner();
  if (!db()) return;
  _bannerScheduleId = scheduleId;
  try {
    _bannerUnsub = db().collection('schedules').doc(scheduleId)
      .onSnapshot(doc => {
        const lw = doc.exists ? doc.data().liveWhiteboard : null;
        renderLiveBanner(scheduleId, lw);
      }, err => console.warn('[whiteboard] banner listener error', err));
  } catch (e) { console.warn('[whiteboard] attach banner failed', e); }
}

function detachLiveBanner() {
  if (_bannerUnsub) { try { _bannerUnsub(); } catch (e) {} _bannerUnsub = null; }
  _bannerScheduleId = null;
  document.getElementById('wb-live-banner')?.remove();
}

function renderLiveBanner(scheduleId, lw) {
  const existing = document.getElementById('wb-live-banner');
  const onBoard = (window.location.hash || '').includes(`/classes/${scheduleId}/whiteboard/`);
  if (!lw?.boardId || onBoard) { existing?.remove(); return; }
  const href = `#/classes/${scheduleId}/whiteboard/${lw.boardId}`;
  if (existing) {
    existing.querySelector('a').setAttribute('href', href);
    return;
  }
  const bar = document.createElement('div');
  bar.id = 'wb-live-banner';
  bar.className = 'wb-live-banner';
  bar.innerHTML = `
    <a href="${escAttr(href)}">
      <span class="wb-live-dot"></span>
      Whiteboard is live${lw.boardName ? ' — ' + esc(lw.boardName) : ''} · tap to watch
    </a>`;
  document.body.appendChild(bar);
}

/* ================================================================
   BOARD PAGE — #/classes/{classId}/whiteboard/{boardId}
   ================================================================ */
let S = null; // active board-page state (null when no board is open)

/* V3.684 — every render/paint/pointer path resolves its DOM through
   S.els instead of document.getElementById('wb-…'). The board used to be
   a document-level singleton: 20 hardcoded id lookups meant exactly one
   board could exist, in one fixed DOM shape, in one document. Scoping
   the lookups to a root element is what lets the same engine mount in a
   module's whiteboard panel. The shell keeps its ids (styles.css targets
   #wb-canvas-bg / #wb-canvas-ink for stacking order) and gains matching
   classes, which is what we actually query — so two boards could coexist
   in one document without id collisions.

   NOT scoped, deliberately: the toast and the live banner are appended to
   <body> and are genuinely per-document singletons. */
const EL_SELECTORS = {
  root:        '.wb-page',
  title:       '.wb-title',
  topbarRight: '.wb-topbar-right',
  toolbar:     '.wb-toolbar',
  stage:       '.wb-stage',
  rail:        '.wb-rail',
  board:       '.wb-board',
  side:        '.wb-side',
  bg:          '.wb-canvas-bg',
  itemsLayer:  '.wb-items',
  widgetsLayer: '.wb-widgets',     /* V3.833 — widget cards, above the ink */
  ink:         '.wb-canvas-ink',
  live:        '.wb-canvas-live',
  sims:        '.wb-sims',
  viewdock:    '.wb-viewdock',
  pagesbar:    '.wb-pagesbar'
};

function resolveEls(rootEl) {
  const els = { root: rootEl };
  Object.keys(EL_SELECTORS).forEach(k => {
    if (k === 'root') return;
    els[k] = rootEl ? rootEl.querySelector(EL_SELECTORS[k]) : null;
  });
  return els;
}

/** The mounted board's element for `key`, or null when nothing is mounted. */
function el(key) { return S?.els?.[key] || null; }

/** The board markup, shared by the full-page route and the module panel
 *  so the two can never drift. `ids:true` stamps the historical ids as
 *  well as the classes — styles.css targets #wb-canvas-bg/#wb-canvas-ink
 *  for stacking order, and the page route is the only mount that needs
 *  them. The panel mounts class-only (it lives in a different document,
 *  but class-only keeps two boards per document possible).
 *
 *  opts: { classId, ids, back, zoomControls } */
function boardShellHTML(opts) {
  const o = opts || {};
  const id = (n) => (o.ids ? ` id="wb-${n}"` : '');
  const back = o.back === false ? '' :
    `<a href="#/classes/${escAttr(o.classId || '')}" class="wb-back" title="Back to class">&larr; Class</a>`;
  const zoom = o.zoomControls
    ? `<div class="wb-zoom">
         <button type="button" class="wb-zoom-btn" data-wb-act="zoom-out" title="Zoom out">&minus;</button>
         <button type="button" class="wb-zoom-btn" data-wb-act="zoom-home" title="Fit the whole board">&#8962;</button>
         <button type="button" class="wb-zoom-btn" data-wb-act="zoom-in" title="Zoom in">+</button>
         <span class="wb-zoom-pct" data-wb-zoom-pct>100%</span>
       </div>` : '';
  /* V3.762 — ⛶ Maximize: the board fills the whole screen (site header,
     footer and tab bar hidden; browser fullscreen too where the browser
     allows it). For the follower's laptop/projector-by-hand case: the
     default page route leaves the sheet in a 1500 px column under the
     site header, a small board in the middle of a big screen. */
  const max = o.maximize === false ? '' :
    `<button type="button" class="wb-max-btn" data-wb-act="max-toggle" title="Maximize the whiteboard (Esc to exit)" aria-pressed="false">&#x26F6; <span class="wb-max-label">Maximize</span></button>`;
  /* V3.837 — host boards (the notebook, the figure board) have no topbar:
     the sheet is the whole view and the radial pills carry the tools */
  const topbar = o.topbar === false ? '' : `
      <div class="wb-topbar"${id('topbar')}>
        ${back}
        <span class="wb-title"${id('title')}>Whiteboard</span>
        ${zoom}
        ${max}
        <div class="wb-topbar-right"${id('topbar-right')}></div>
      </div>`;
  return `
    <div class="wb-page"${id('page')}>${topbar}
      <div class="wb-toolbar"${id('toolbar')} hidden></div>
      <div class="wb-stage"${id('stage')}>
        <div class="wb-rail"${id('rail')} hidden></div>
        <div class="wb-board"${id('board')}>
          <canvas${id('canvas-bg')} class="wb-canvas-bg"></canvas>
          <div class="wb-items"${id('items')}></div>
          <canvas${id('canvas-ink')} class="wb-canvas-ink"></canvas>
          <canvas${id('canvas-live')} class="wb-canvas-live"></canvas>
          <div class="wb-widgets"${id('widgets')}></div>
          <div class="wb-sims"${id('sims')}></div>
          <div class="wb-viewdock" role="toolbar" aria-label="View" hidden></div>
        </div>
        <div class="wb-side"${id('side')} hidden></div>
      </div>
      <div class="wb-pagesbar"${id('pagesbar')}></div>
    </div>`;
}

/** Sync shell — called from app.js's render switch. */
function renderWhiteboardPage(classId, boardId) {
  return boardShellHTML({ classId, ids: true });
}

/** Async wiring — called from app.js's wire switch. A thin adapter over
 *  mountBoardView: the full-page route owns the two things a mounted
 *  board must never do for itself — restyling document.body, and tearing
 *  down on hashchange. */
async function wireWhiteboardPage(classId, boardId, opts) {
  teardownBoard();
  /* V3.684 — resolve the shell ONCE, up front. Every paint/pointer path
     reads S.els through el(); a null root here means the render switch
     did not run, and bailing now is far easier to diagnose than each
     paint silently no-opping later. */
  const rootEl = document.getElementById('wb-page');
  if (!rootEl) { console.warn('[whiteboard] board shell missing — nothing to mount'); return; }
  const projector = !!opts?.projector;
  if (projector) document.body.classList.add('wb-projector');

  const replay = opts?.replay || null;
  const inst = await mountBoardView(rootEl, {
    classId, boardId, projector, replay,
    chrome: 'full',
    /* V3.730 — the drawer's pinch-zoom works on the page route too (it
       was off here since V3.684, which is why "pinch doesn't work while
       drawing" on the iPad). The PROJECTOR still never zooms: the room
       sees the sheet, the tablet is the magnifier. */
    view:  { enabled: !projector },
    items: { enabled: true }
  });
  if (!inst) return null;

  /* Teardown when the hash leaves this board. Page-route concern only. */
  S.hashHandler = () => {
    const h = window.location.hash || '';
    if (!h.includes(`/classes/${classId}/whiteboard/${boardId}`)) teardownBoard();
  };
  window.addEventListener('hashchange', S.hashHandler);
  if (replay && window.WhiteboardReplay?.mount) {
    window.WhiteboardReplay.mount({ classId, boardId, recId: replay, handle: inst });
  } else if (replay) {
    toast('Replay is not available (whiteboard-replay.js did not load).');
  }
  return inst;
}

/** V3.731 — replay pushes a complete board state; the engine only draws.
 *  st: { strokes: Map, items: Map, pages, pageId, animate } */
function applyReplayState(st) {
  if (!S || !S.replay) return;
  if (st.strokes) S.strokes = st.strokes;
  if (st.items) S.items = st.items;
  if (st.pages) S.board = { ...(S.board || {}), pages: st.pages, activePageId: st.pageId || S.pageId };
  foldAllToPlane();                                        // V3.841
  if (infinite() && S.sheet && typeof st.viewX === 'number') S.sheet.originX = st.viewX - sheetViewW() / 2;
  const pageChanged = !!st.pageId && st.pageId !== S.pageId;
  if (st.pageId) S.pageId = st.pageId;
  /* V3.801 — a continuous-mode lecture replays its scroll (viewY), not
     page snaps. A recording made in pages mode has no viewY. */
  const y = typeof st.viewY === 'number' ? st.viewY : null;
  const yChanged = y !== (S.replayY ?? null);
  S.replayY = y;
  if (continuous() && y != null) {
    if (yChanged || pageChanged) scrollSheetTo(y, st.animate === false ? 0 : FOLLOW_TWEEN_MS);
    else scheduleRedraw();
  } else if (pageChanged || (yChanged && y == null)) centreOn(pageIndexOf(S.pageId), st.animate !== false);
  else scheduleRedraw();
}

/** Mount a live board view into `rootEl`.
 *
 *  opts: { classId, boardId, projector, chrome:'full'|'panel'|'none',
 *          view:{enabled}, items:{enabled} }
 *
 *  Returns a handle, or null if it could not mount.
 *
 *  `view.enabled` is the viewer-local zoom/pan lens. It is OFF for the
 *  page route and the projector on purpose: strokes live in a fixed 16:10
 *  board space precisely so tablet, laptops and projector always agree,
 *  and a synced zoom would break that. The lens is a per-screen lens, and
 *  when disabled the transform code never runs at all (guarded, not
 *  relying on identity math) so the projector cannot drift.
 *
 *  S is still a single module-level global: at most ONE board per
 *  document. That is not a limitation in practice — the panel lives in
 *  the module iframe, a different document from the SPA's page route —
 *  but re-mounting warns loudly rather than silently fighting over the
 *  canvas.
 */
async function mountBoardView(rootEl, opts) {
  if (!db()) return null;
  if (!rootEl) return null;
  if (S) {
    console.warn('[whiteboard] a board is already mounted in this document — replacing it');
    teardownBoard();
  }
  const classId  = opts.classId;
  const boardId  = opts.boardId;
  const projector = !!opts.projector;

  S = {
    classId, boardId, projector,
    coll: BOARD_COLLECTIONS.includes(opts.collection) ? opts.collection : 'whiteboards',
    /* Who may draw. 'classAdmin' is the live lecture board; 'owner' is a
       student's own notes/homework, where the gate is simply "is this
       your board" — which the rules answer from the board id, so the
       client check and the server check agree by construction. */
    ownerUid: opts.ownerUid || null,
    boardName: opts.boardName || '',
    moduleKey: opts.moduleKey || '',
    creating: false,
    els: resolveEls(rootEl),
    chrome: opts.chrome || 'full',
    viewEnabled:  !!opts.view?.enabled,
    itemsEnabled: opts.items?.enabled !== false,
    view: { tx: 0, ty: 0, scale: 1 },   // viewer-local lens, never synced
    items: new Map(),                   // itemId -> image item data
    schedule: null, board: null,
    isAdmin: false,
    canGoLive: false,           // class admin on ANY mount incl. projector (Go live / record)
    replay: opts.replay || null,// V3.731 — recording id when mounted in replay mode
    pageId: null,
    follow: true,               // viewers auto-follow the admin's page
    strokes: new Map(),         // strokeId -> stroke data
    myIds: [],                  // stroke ids this session created (undo stack)
    active: null,               // in-progress stroke
    activeLocalId: null,        // guard: snapshot must not clobber it
    erasing: false,
    erased: new Set(),
    tool: 'pen',
    color: COLORS[0],
    width: PEN_WIDTHS[1].w,
    /* V3.839 — the pen set (pens + highlighters, this device), the pen in
       hand, highlighter mode, the open pen editor, moved pill positions */
    pens: loadPenSet(), penId: null, hl: false, penEdit: null, markEdit: null,
    pillPos: loadPillPos(), pillSuppressClick: null,
    /* V3.841 — the eraser in hand (0 = the default tolerance), a wire being
       dragged from a card's port, the host's drop handler */
    eraserW: 0, portDrag: null,
    /* V3.842 — region instances: live subscriptions to their source boards */
    refSubs: new Map(), refData: new Map(), refPick: null,
    itemH: new Map(),            // V3.843 — last measured card heights (a hidden card measures 0)
    onDrop: typeof opts.onDrop === 'function' ? opts.onDrop : null,
    onPaste: typeof opts.onPaste === 'function' ? opts.onPaste : null,
    live: null,                 // schedule.liveWhiteboard
    touchedThisSession: false,  // first final flush also bumps board.updatedAt
    repaintQueued: false,
    livePaintQueued: false,
    redrawQueued: false,
    sheet: null,                // { pageW, offX, originY } — see PAGE_GAP
    annotate: false,            // sim pages: ink above the simulation (else interact)
    sheetAnim: null,            // in-flight page-snap tween
    thumbDirty: new Set(),      // page ids whose rail thumbnail needs a repaint
    thumbTimer: null,
    snapTimer: null,
    keyHandler: null,
    unsubs: [], timers: [], ro: null, authListener: null, hashHandler: null,
    /* V3.830 — Arrange mode (move / resize / remove items) and the host's
       extra toolbar tools (the notebook's ＋ From paper) */
    arrange: false,
    tools: Array.isArray(opts.tools) ? opts.tools : [],
    onTool: typeof opts.onTool === 'function' ? opts.onTool : null,
    draggingItemId: null,
    /* V3.833 — widget items (the canvas notebook). The HOST renders each
       widget's body (`widgets.render(item, bodyEl, api)`) and names the
       kinds (`widgets.meta(kind)` → { label, glyph }); the engine owns the
       card chrome (kind · title · stamp · ▾ collapse · ⋯), placement,
       snapping, Arrange and the export. `onSheetContext` opens the host's
       insert menu at a right-click / long-press on the sheet. */
    widgets: (opts.widgets && typeof opts.widgets.render === 'function') ? opts.widgets : null,
    /* V3.854 — a ✓ at the top-left of every card and region: the host reports the card as the result of a My Week step */
    report: (opts.report && typeof opts.report.onReport === 'function') ? opts.report : null,
    onSheetContext: typeof opts.onSheetContext === 'function' ? opts.onSheetContext : null,
    itemNodes: new Map(),        // itemId -> DOM node (incremental render: typing survives a redraw)
    /* V3.837 — figure-board additions: host-decided edit gate, the ⬚ Region
       tool (a rectangle of ink → the host makes a panel), hidden strokes,
       wires between cards, and connect mode */
    canEdit: (typeof opts.canEdit === 'boolean') ? opts.canEdit : null,
    regionDrag: null,
    onRegion: typeof opts.onRegion === 'function' ? opts.onRegion : null,
    wiresEnabled: !!opts.wires?.enabled,
    wires: new Map(),
    onWire: typeof opts.onWire === 'function' ? opts.onWire : null,
    connect: null,
    onConnectDone: typeof opts.onConnectDone === 'function' ? opts.onConnectDone : null,
    /* V3.856 — the host hears about LOCAL wire changes (a collection card materialises what lands on it) */
    onWireAdded:   typeof opts.onWireAdded === 'function' ? opts.onWireAdded : null,
    onWireUpdated: typeof opts.onWireUpdated === 'function' ? opts.onWireUpdated : null,
    onWireRemoved: typeof opts.onWireRemoved === 'function' ? opts.onWireRemoved : null,
    /* V3.837 — radial pills (pens · tools · widgets · zoom) replace the
       linear toolbar on host boards; the host lists its insert kinds */
    pills: opts.pills !== false && (opts.collection === 'notebookBoards' || opts.collection === 'paperBoards'),
    /* V3.852 — mobile: cards are inert and tap-to-edit (a bottom sheet hosts the editor); 'auto' is a
       coarse pointer on a small screen; the host may force it (?mobile=1) */
    mobileAuto: opts.mobile !== true && opts.mobile !== false,
    mobile: opts.mobile === true || (opts.mobile !== false && (opts.collection === 'notebookBoards' || opts.collection === 'paperBoards') && detectMobile()),
    sheetId: null,
    /* V3.837 — host boards fit the page to the full width of the stage (the
       class board keeps 1½ pages visible for the room to follow) */
    fitWidth: opts.fitWidth !== false && (opts.collection === 'notebookBoards' || opts.collection === 'paperBoards'),
    inserts: Array.isArray(opts.inserts) ? opts.inserts : [],
    onInsert: typeof opts.onInsert === 'function' ? opts.onInsert : null,
    openPill: null, pillTimer: null, panDrag: null,
    /* V3.837 — the desk / page / grid colours a host may set (Scientia's warm paper) */
    theme: Object.assign({ desk: '#e5e7eb', page: '#ffffff', edge: 'rgba(15,23,42,.10)', grid: '#e5e7eb', ruled: '#dbeafe', divider: '#d1d5db' }, opts.theme || {})
  };

  /* Schedule doc: admin gate + live state (also drives Go live button).
     V3.830 — a notebook board has no class: nothing to read or follow. */
  if (!isNotebook()) {
  try {
    const schedDoc = await db().collection('schedules').doc(classId).get();
    S.schedule = schedDoc.exists ? schedDoc.data() : null;
  } catch (e) { S.schedule = null; }
  if (!S) return; // torn down while awaiting

  S.unsubs.push(db().collection('schedules').doc(classId).onSnapshot(doc => {
    if (!S) return;
    S.schedule = doc.exists ? doc.data() : S.schedule;
    S.live = doc.exists ? (doc.data().liveWhiteboard || null) : null;
    /* Live ended from another device (or the flag vanished): the
       recorder on this device stops and saves. `arming` covers the
       window between the recorder starting and the flag write that
       names it — a snapshot landing in there is not "ended elsewhere". */
    if (REC && !REC.arming && REC.boardId === S.boardId && !(S.live?.recId === REC.recId)) stopRecording('remote-end');
    /* V3.775 — THIS tab was the recorder and lost it in a reload: the
       recording doc names a per-tab client id (sessionStorage survives a
       reload; the in-memory recorder does not). Checked once per recId. */
    if (!REC && S.live?.boardId === S.boardId && S.live?.recId && S.recLostChecked !== S.live.recId) {
      S.recLostChecked = S.live.recId;
      detectLostRecording(S.live.recId);
    }
    renderTopbarRight();
    renderProjectorCtl();
  }, err => console.warn('[whiteboard] schedule listener error', err)));
  }

  /* Auth may resolve after route time (hard refresh on the iPad) —
     re-evaluate the gate whenever auth state changes. */
  const reEval = () => {
    if (!S) return;
    const was = S.isAdmin, wasLive = S.canGoLive;
    S.isAdmin = !S.projector && !S.replay && computeCanDraw();
    S.canGoLive = !S.replay && S.coll === 'whiteboards' && computeIsClassAdmin(S.schedule);
    if (S.isAdmin !== was || S.canGoLive !== wasLive) renderBoardChrome();
  };
  S.authListener = reEval;
  window.McgheeLab?.Auth?.onChange?.(reEval);
  S.isAdmin = !projector && !S.replay && computeCanDraw();
  S.canGoLive = !S.replay && S.coll === 'whiteboards' && computeIsClassAdmin(S.schedule);

  /* Board doc listener: name, pages, activePageId (page-follow). */
  S.unsubs.push(boardsCol(classId, S.coll).doc(boardId).onSnapshot(doc => {
    if (!S) return;
    if (!doc.exists) {
      /* A student's board is created lazily: the first time they open a
         module there is nothing to read yet, and that is normal rather
         than an error. Only the owner can create it, which is exactly
         what the rules allow. */
      if (S.coll !== 'whiteboards' && computeCanDraw() && !S.creating) {
        S.creating = true;
        boardsCol(S.classId, S.coll).doc(S.boardId).set({
          name: S.boardName || 'My board',
          pages: [{ id: 'p1', background: 'blank' }],
          activePageId: 'p1',
          ownerUid: window.McgheeLab?.Auth?.currentUser?.uid || '',
          moduleKey: S.moduleKey || '',
          sharedWithUids: [],
          createdAt: FV().serverTimestamp(),
          updatedAt: FV().serverTimestamp()
        }).catch(e => console.warn('[whiteboard] could not create board', e));
        return;
      }
      const t = el('title');
      if (t) t.textContent = S.coll === 'whiteboards' ? 'Board not found' : 'Sign in to use your board';
      return;
    }
    const prevPages = S.board?.pages;
    const prevBoard = S.board;
    if (S.replay) {
      /* replay drives pages/pageId itself from the recording; only the
         name is taken live */
      if (!S.board) S.board = { ...doc.data(), pages: S.board?.pages || doc.data().pages };
      else {
        /* V3.801 — the layout too: replay state may have arrived first,
           and the geometry must match the board's */
        const modeWas = continuous();
        S.board = { ...S.board, name: doc.data().name, sheetMode: doc.data().sheetMode };
        if (continuous() !== modeWas) {
          if (continuous() && typeof S.replayY === 'number') scrollSheetTo(S.replayY, 0);
          else centreOn(pageIndexOf(S.pageId), false);
        }
      }
      const t0 = el('title'); if (t0) t0.textContent = S.board.name || 'Whiteboard';
      return;
    }
    S.board = doc.data();
    recObserveBoard(prevBoard, S.board);
    foldAllToPlane();                                      // V3.841 — strokes / items that arrived before the pages
    const firstLoad = !S.pageId;
    if (firstLoad) S.pageId = S.board.activePageId || S.board.pages?.[0]?.id || 'p1';
    const t = el('title');
    if (t) t.textContent = S.board.name || 'Whiteboard';
    /* pages added/removed or a background changed → every thumb may differ */
    const pagesChanged = JSON.stringify(prevPages || null) !== JSON.stringify(S.board.pages || null);
    if (pagesChanged) (S.board.pages || []).forEach(p => markThumb(p.id));
    /* the current page may have been deleted remotely */
    let removed = false;
    if (!(S.board.pages || []).some(p => p.id === S.pageId)) {
      const oldIdx = (prevPages || []).findIndex(p => p.id === S.pageId);
      S.pageId = (S.board.pages || [])[Math.max(0, Math.min(oldIdx, (S.board.pages || []).length - 1))]?.id || S.board.pages?.[0]?.id || 'p1';
      removed = true;
    }
    /* reordered remotely: stay with the page we were on, wherever it went */
    const movedTo = pagesChanged && !firstLoad ? pageIndexOf(S.pageId) : -1;
    const wasAt = prevPages ? prevPages.findIndex(p => p.id === S.pageId) : -1;
    const reordered = movedTo >= 0 && wasAt >= 0 && movedTo !== wasAt;
    /* leadership moved to another device → this one falls back to following */
    if (prevBoard && prevBoard.leaderDeviceId !== S.board.leaderDeviceId) {
      if (!isLeader()) S.follow = true;
      S.viewPub = null;            // a new leader starts its own publish state
      renderTopbarRight();
    }
    /* follow the LEADER's page (students, projector, and every admin
       device that is not the leader — the laptop beside the tablet) */
    const follows = followsLeader();
    /* V3.740 — a pause ("I flipped back to look at something") lasts only
       until the leader moves on: the leader's NEXT page change pulls every
       follower back. The projector never pauses at all. */
    const leaderMoved = !!prevBoard && prevBoard.activePageId !== S.board.activePageId;
    if (follows && (leaderMoved || S.projector)) S.follow = true;
    /* V3.801 — the layout changed (Continuous ↔ Pages): the geometry under
       every stroke moved, so re-place the view instantly. */
    const modeChanged = !!prevBoard && (prevBoard.sheetMode || 'continuous') !== (S.board.sheetMode || 'continuous');
    /* V3.801 — continuous mode follows the leader's exact scroll position
       (viewY = sheet y at the middle of the leader's stage). Before the
       leader has scrolled in this mode there is no viewY, and the page
       logic below applies. The leader itself restores its own last
       position on load. */
    const hasY = continuous() && typeof S.board.viewY === 'number';
    const yMoved = !!prevBoard && prevBoard.viewY !== S.board.viewY;
    if (hasY && ((follows && S.follow) || (firstLoad && !follows))) {
      if (firstLoad || yMoved || leaderMoved || modeChanged || pagesChanged) {
        const live = S.board.activePageId;
        if (live && (S.board.pages || []).some(p => p.id === live)) S.pageId = live;
        scrollSheetTo(S.board.viewY, (firstLoad || modeChanged || pagesChanged) ? 0 : FOLLOW_TWEEN_MS);
      } else {
        scheduleRedraw();
      }
    } else if (modeChanged) {
      if (follows && S.follow && S.board.activePageId) S.pageId = S.board.activePageId;
      centreOn(pageIndexOf(S.pageId), false);
    } else if (follows && S.follow && S.board.activePageId && S.board.activePageId !== S.pageId) {
      S.pageId = S.board.activePageId;
      centreOn(pageIndexOf(S.pageId), !firstLoad);
    } else if (firstLoad) {
      centreOn(pageIndexOf(S.pageId), false);
    } else if (removed || reordered) {
      centreOn(pageIndexOf(S.pageId), true);
    } else {
      scheduleRedraw();
    }
    renderRail();
    renderPagesBar();
    if (leaderMoved || modeChanged) renderTopbarRight();   // sync status line
    if (modeChanged) renderToolbar();                      // the Continuous | Pages toggle
  }, err => console.warn('[whiteboard] board listener error', err)));

  /* Strokes listener — the live ink feed. (Replay loads its data once
     through WhiteboardReplay instead.) */
  if (!S.replay) S.unsubs.push(boardsCol(classId, S.coll).doc(boardId).collection('strokes')
    .orderBy('seq')
    .onSnapshot(snap => {
      if (!S) return;
      const erased = [];
      const now = Date.now();
      snap.docChanges().forEach(ch => {
        const id = ch.doc.id;
        if (ch.type === 'removed') { markThumb(S.strokes.get(id)?.pageId); erased.push(id); S.strokes.delete(id); return; }
        if (id === S.activeLocalId) return; // don't clobber the pen-down stroke
        const data = ch.doc.data();
        const prev = S.strokes.get(id);
        if (data.erasedAt && !(prev && prev.erasedAt)) erased.push(id);
        S.strokes.set(id, foldToPlane(data));           // V3.841 — legacy pages fold onto the plane
        markThumb(data.pageId);
        recSampleSkew(data, now);
      });
      if (erased.length) recEvent('erase', { strokeIds: erased });
      if (snap.docChanges().length) recTouch();
      schedulePaint();
    }, err => console.warn('[whiteboard] strokes listener error', err)));

  /* Image items — snapped module figures. Deliberately its OWN listener
     on its OWN subcollection: images mutate on every drag commit, and
     folding that churn into the strokes stream would slow the one feed
     that has to stay low-latency. No orderBy, so no composite index —
     sorted client-side by z, same reasoning as the strokes listener. */
  if (S.itemsEnabled && !S.replay) {
    S.unsubs.push(boardsCol(classId, S.coll).doc(boardId).collection('items')
      .onSnapshot(snap => {
        if (!S) return;
        snap.docChanges().forEach(ch => {
          const id = ch.doc.id;
          if (ch.type === 'removed') { S.items.delete(id); recEvent('item-remove', { itemId: id }); return; }
          if (id === S.draggingItemId) return; // don't clobber a live drag
          const it = foldToPlane(ch.doc.data());          // V3.841
          S.items.set(id, it);
          recEvent(ch.type === 'added' ? 'item-add' : 'item-move', itemEventPayload(id, it));
        });
        if (snap.docChanges().length) recTouch();
        renderItems();
        if (S.widgets?.onChange) { try { S.widgets.onChange(); } catch (e) { console.warn('[whiteboard] widgets.onChange failed', e); } }
      }, err => console.warn('[whiteboard] items listener error', err)));
  }
  /* V3.837 — wires between cards (its own small subcollection) */
  if (S.wiresEnabled && !S.replay) {
    S.unsubs.push(boardsCol(classId, S.coll).doc(boardId).collection('wires')
      .onSnapshot(snap => {
        if (!S) return;
        snap.docChanges().forEach(ch => { if (ch.type === 'removed') S.wires.delete(ch.doc.id); else S.wires.set(ch.doc.id, ch.doc.data()); });
        renderWires();
      }, err => console.warn('[whiteboard] wires listener error', err)));
  }

  /* Canvas sizing. */
  /* Observe the SHEET AREA: the rail collapsing or the side column
     appearing changes its width without changing the stage's. */
  const boardEl = el('board');
  if (boardEl && 'ResizeObserver' in window) {
    S.ro = new ResizeObserver(() => { sizeCanvases(); scheduleRedraw(); });
    S.ro.observe(boardEl);
  }
  sizeCanvases();
  drawBackground();
  renderBoardChrome();
  bindPointerHandlers();
  bindItemHandlers();
  bindDropHandlers();
  bindKeyHandler();
  if (S.chrome === 'full' && !isNotebook()) restoreMaximized();   /* V3.762 — page route only; the module panel and the notebook host have their own popout */
  if (S.viewEnabled) {
    bindLensHandlers();
    /* Restore the saved lens BEFORE the first full paint, then paint
       through redrawAll — the exact path every later repaint takes.
       Two reasons this must not be left to the mount's incidental
       paints: a zoom restored from localStorage would otherwise never
       be drawn until the next unrelated redraw, and the mount would
       rasterize strokes on a different path from every subsequent
       frame (measured: same view state, ~2% different edge pixels). */
    restoreView();
    redrawAll();
  }

  return {
    destroy:  () => teardownBoard(),
    /* V3.731 — replay drives the engine through these */
    replayApply: (st) => applyReplayState(st),
    getRoot:  () => el('root'),
    getBoard: () => S?.board || null,
    getPage:  () => S?.pageId || null,
    isAdmin:  () => !!S?.isAdmin,
    zoomBy:   (f) => zoomAtCenter(f),
    zoomFit:  () => resetView(),
    getView:  () => (S ? { ...S.view } : null),
    addImageItem: (meta) => addImageItem(meta),
    exportPNGs:  (o) => exportBoardPNGs(o),
    strokeCount: () => (S ? S.strokes.size : 0),
    setShared:   (uids) => setSharedWith(uids),
    getShared:   () => (S?.board?.sharedWithUids || []).slice(),
    /* V3.830 — notebook host API: text items, Arrange, recording without
       a live flag, repair of a recording a reload interrupted */
    addTextItem:  (meta) => addTextItem(meta),
    setArrange:   (on) => { if (!S) return; S.arrange = !!on; renderToolbar(); renderBoardChrome(); renderItems(); },
    isArrange:    () => !!S?.arrange,
    startRecording: () => startRecording(),
    stopRecording:  (reason) => stopRecording(reason || 'stop'),
    isRecording:    () => recording(),
    recElapsed:     () => recElapsedLabel(),
    finalizeInterrupted: (recId) => (S ? finalizeInterrupted(S.classId, S.boardId, recId, S.coll) : Promise.resolve()),
    getCollection: () => S?.coll || null,
    refreshChrome: () => renderBoardChrome(),
    /* V3.833 — widget cards for the canvas notebook */
    addWidget:    (meta) => addWidgetItem(meta),
    updateItem:   (id, patch) => updateItem(id, patch),
    removeItem:   (id) => deleteItem(id),
    getItems:     () => (S ? [...S.items.entries()].map(([id, it]) => Object.assign({ id }, it)) : []),
    refreshWidget: (id) => { widgetApi(id).refresh(); if (S && S.sheetId === id) renderSheetBody(); },   /* V3.855 — an open sheet follows the card */
    tidy:         (pageId) => tidyItems(pageId),
    pageIdUnderView: () => { if (!S?.sheet) return S?.pageId || null; const pages = S.board?.pages || []; return pages[pageAtSheetY(viewCentre())]?.id || S.pageId; },
    /* V3.837 — figure board: tools, regions → panels, hidden ink, wires */
    setTool:      (t) => { if (!S) return; S.tool = t || 'pen'; S.erasing = false; S.regionDrag = null; paintLiveNow(); renderToolbar(); },
    getTool:      () => S?.tool || null,
    setTools:     (tools) => { if (!S) return; S.tools = Array.isArray(tools) ? tools : []; renderToolbar(); },
    setCanEdit:   (v) => { if (!S) return; S.canEdit = (typeof v === 'boolean') ? v : null; if (S.authListener) S.authListener(); renderBoardChrome(); renderItems(); },
    strokesInRect: (rect) => strokesInRect(rect),
    /* V3.839 — pen set, fit everything, pill positions */
    fitAll:       () => fitAll(),
    /* V3.841 — the plane */
    api:          (id) => widgetApi(id),
    /* V3.842 — regions, instances, organise */
    addRegion:    (rect, extra) => addRegionItem(rect, extra),
    regionMembers: (id) => { const it = S?.items.get(id); return it ? regionMembers(id, it) : []; },
    toggleRegion: (id) => toggleRegion(id),
    fitRegion:    (id, shrink) => fitRegionToMembers(id, { shrink: shrink !== false }),
    addRegionRef: (src, at) => addRegionRefItem(src, at),
    setRegionMembers: (id, ids) => setRegionMembers(id, ids),
    organise:     () => organiseByConnections(),
    getOrigin:    () => (S?.sheet ? { x: S.sheet.originX || 0, y: S.sheet.originY } : null),
    scrollPlaneBy: (dx, dy) => scrollPlaneBy(dx, dy),
    isInfinite:   () => !!(S && infinite()),
    /* V3.852 — mobile: tap-to-edit sheet */
    openItem:     (id, mode) => openItemSheet(id, mode),
    sheetMode:    () => (S && S.sheetId ? S.sheetMode : null),
    setSheetMode: (m) => setSheetMode(m),
    closeItem:    () => closeItemSheet(),
    /* V3.853 — deep link to one card (My Week results: ?item=<id>) */
    focusItem:    (id) => focusItemById(id),
    isMobile:     () => mobile(),
    /* V3.860 — the hand's modes */
    setHandMode:  (t) => setHandMode(t),
    toggleLastMode: () => toggleLastMode(),
    handMode:     () => handOf(),   /* 'zoom' | 'pan' | 'pen' | 'hl' | 'eraser' | 'card' (or a region tool) */
    /* V3.863 — Cards: the card chosen for editing */
    selectCard:   (id) => cardSelect(id || null),
    selectedCard: () => (S ? S.cardSel || null : null),
    lastHandMode: () => (S ? S.lastTool || null : null),
    setMobile:    (on) => { if (!S) return; S.mobileAuto = false; S.mobile = !!on; closeItemSheet(); renderBoardChrome(); renderItems(); },
    getPens:      () => (S ? S.pens.map(p => Object.assign({}, p)) : []),
    setPens:      (list) => { if (!S || !Array.isArray(list) || !list.length) return; S.pens = list.map(p => ({ id: String(p.id || newId('pn')), kind: p.kind === 'hl' ? 'hl' : 'pen', color: /^#[0-9a-f]{6}$/i.test(p.color || '') ? p.color.toLowerCase() : '#111827', w: clampPenW(p.w, p.kind === 'hl') })).slice(0, 12); savePenSet(S.pens); if (!S.pens.some(p => p.id === S.penId)) usePen(S.pens[0]); renderToolbar(); },
    usePen:       (id) => { const p = S?.pens.find(x => x.id === id); if (p) { usePen(p); renderToolbar(); } },
    currentPen:   () => (S ? { id: S.penId, color: S.color, w: S.width, hl: !!S.hl, tool: S.tool } : null),
    resetPillPositions: () => { if (!S) return; S.pillPos = {}; savePillPos({}); renderPills(); },
    rasterizeRegion: (rect, o) => rasterizeRegion(rect, o),
    hideStrokes:  (ids, by) => hideStrokes(ids, by),
    unhideStrokes: (by) => unhideStrokes(by),
    deleteStrokes: (ids) => { if (S && S.isAdmin) removeStrokes(ids); },
    hiddenStrokeIds: (by) => (S ? [...S.strokes.entries()].filter(([, s]) => s.hiddenBy === by).map(([id]) => id) : []),
    addWire:      (from, to, rel, extra) => addWire(from, to, rel, extra),   /* V3.856 — extra: { fromSide, toSide, fromNode, color } */
    redrawWires:  () => renderWires(),
    updateWire:   (id, patch) => updateWire(id, patch),
    removeWire:   (id) => removeWire(id),
    getWires:     () => (S ? [...S.wires.entries()].map(([id, w]) => Object.assign({ id }, w)) : []),
    setConnectMode: (on) => setConnectMode(on),
    isConnecting: () => !!S?.connect,
    /* V3.837 — pills */
    setInserts:   (list) => { if (!S) return; S.inserts = Array.isArray(list) ? list : []; renderPills(); },
    openPill:     (name) => { if (!S) return; S.openPill = name || null; renderPills(); },
    refreshPills: () => renderPills(),
    zoomToRect:   (rect) => zoomToRect(rect),
    isMaximized:  () => isMaximized(),
    setMaximized: (on) => setMaximized(!!on, true)
  };
}

function teardownBoard() {
  if (!S) return;
  finishStroke(true); // flush any in-flight ink before leaving
  S.unsubs.forEach(u => { try { u(); } catch (e) {} });
  if (S.refSubs) S.refSubs.forEach(u => { try { u(); } catch (e) {} });   // V3.842
  closeRefPicker();
  closeItemSheet();   /* V3.852 */
  S.timers.forEach(t => clearInterval(t));
  if (S.ro) { try { S.ro.disconnect(); } catch (e) {} }
  if (S.hashHandler) window.removeEventListener('hashchange', S.hashHandler);
  if (S.keyHandler) document.removeEventListener('keydown', S.keyHandler);
  if (S.fsHandler) document.removeEventListener('fullscreenchange', S.fsHandler);
  document.body.classList.remove('wb-max');
  if (S.authListener) window.McgheeLab?.Auth?.offChange?.(S.authListener);
  if (S.lensCleanup) { try { S.lensCleanup(); } catch (e) {} }
  if (S.pillTimer) clearInterval(S.pillTimer);
  if (S.pillOutside) document.removeEventListener('pointerdown', S.pillOutside, true);
  clearTimeout(S.thumbTimer); clearTimeout(S.snapTimer);
  S.sheetAnim = null;
  document.body.classList.remove('wb-projector');
  S = null;
}

/* ─── Chrome (topbar/toolbar/pages bar) ─────────────────────── */
function renderBoardChrome() {
  const rootEl = el('root'); if (rootEl) rootEl.classList.toggle('wb-m', mobile());   /* V3.852 */
  renderTopbarRight();
  renderToolbar();
  renderRail();
  renderPagesBar();
  renderViewDock();
  /* V3.678 — draw mode is a CLASS on the page, not just an inline style:
     the CSS under .wb-draw-mode kills iPadOS text selection, the
     copy/look-up callout, and scroll/pinch/pull-to-refresh over the whole
     board area. Without it, Safari treats the gap BETWEEN strokes as a
     chance to start a selection gesture and the next pen-down lands as a
     highlight instead of ink. Viewers keep all browser defaults. */
  const pageEl = el('root');
  if (pageEl) {
    pageEl.classList.toggle('wb-draw-mode', !!S?.isAdmin);
    pageEl.classList.toggle('wb-replay', !!S?.replay);
    pageEl.classList.toggle('wb-arrange', !!(S?.isAdmin && S?.arrange));   /* V3.830 */
  }
  const ink = el('ink');
  if (ink) ink.style.touchAction = S?.isAdmin ? 'none' : '';
  renderProjectorCtl();
}

/* ─── V3.762 Maximize ────────────────────────────────────────────
   `body.wb-max` pins .wb-page to the viewport and hides the site chrome
   (same recipe as projector mode, but the topbar/toolbar/rail stay so the
   viewer can still navigate and get back out). Remembered per device
   (localStorage wb_max) so a follower who reloads mid-class comes back
   maximized; browser fullscreen is requested only from the click itself
   (it needs a user gesture) and released when the user un-maximizes.
   Esc, or the browser leaving fullscreen on its own, exits maximize. */
function isMaximized() { return document.body.classList.contains('wb-max'); }
function setMaximized(on, fromGesture) {
  if (!S || S.projector) return;
  on = !!on;
  document.body.classList.toggle('wb-max', on);
  try { localStorage.setItem('wb_max', on ? '1' : '0'); } catch (e) {}
  const root = el('root');
  const btn = root?.querySelector('.wb-max-btn');
  if (btn) {
    btn.setAttribute('aria-pressed', on ? 'true' : 'false');
    btn.title = on ? 'Back to the normal page layout' : 'Maximize the whiteboard (Esc to exit)';
    const lab = btn.querySelector('.wb-max-label');
    if (lab) lab.textContent = on ? 'Exit' : 'Maximize';
  }
  const de = document.documentElement;
  if (on && fromGesture && de.requestFullscreen && !document.fullscreenElement) {
    try { const pr = de.requestFullscreen(); if (pr && pr.catch) pr.catch(() => {}); } catch (e) {}
  } else if (!on && document.fullscreenElement && document.exitFullscreen) {
    try { const pr = document.exitFullscreen(); if (pr && pr.catch) pr.catch(() => {}); } catch (e) {}
  }
  if (!S.fsHandler) {
    S.fsHandler = () => { if (S && !document.fullscreenElement && isMaximized()) setMaximized(false); };
    document.addEventListener('fullscreenchange', S.fsHandler);
  }
  /* the stage just changed size: the ResizeObserver re-sizes the canvases,
     but re-run the chrome now so rail/side visibility follows the new width */
  sizeCanvases(); renderTopbarRight(); renderRail(); renderPagesBar();
  scheduleRedraw();
}
function restoreMaximized() {
  if (!S || S.projector) return;
  let want = false;
  try { want = localStorage.getItem('wb_max') === '1'; } catch (e) {}
  if (want) setMaximized(true, false);
}

/* V3.731 — the projector is chrome-free, but it is also the laptop that
   Alex presses Go live on (the device that records). A small corner
   control, visible only to class admins, faint until hovered or live. */
function renderProjectorCtl() {
  if (!S) return;
  const root = el('root');
  if (!root) return;
  let box = root.querySelector('.wb-projector-ctl');
  if (!S.projector || !S.canGoLive) { box?.remove(); return; }
  if (!box) { box = document.createElement('div'); box.className = 'wb-projector-ctl'; root.appendChild(box); }
  const isLive = S.live?.boardId === S.boardId;
  box.classList.toggle('wb-projector-ctl-live', isLive);
  box.innerHTML = `<button type="button" class="btn btn-small ${isLive ? 'btn-danger' : ''}" data-wb-act="live-toggle">
      ${isLive ? ICON.svg('stop') + ' End live' : ICON.svg('dot', { variant: 'solid', tint: '#ef4444' }) + ' Go live'}</button>${recBadgeHTML()}
      <button type="button" class="btn btn-small wb-sync-btn" data-wb-act="follow-resync" title="Jump to the leader's page">⟳ Sync</button>`;
}

/** "🎙 12:34" while this device records; "🎙 on another device" when
 *  the live session is being recorded elsewhere. */
function recBadgeHTML() {
  if (!S) return '';
  if (REC && REC.boardId === S.boardId) return `<span class="wb-rec-badge" data-wb-rec-timer><span class="wb-live-dot"></span> ${ICON.svg('microphone')} ${recElapsedLabel()}</span>`;
  /* V3.775 — this tab recorded, reloaded, and lost the recorder */
  if (S.recLost && S.live?.boardId === S.boardId && S.live?.recId === S.recLost && S.canGoLive) {
    return `<button type="button" class="btn btn-small btn-danger wb-rec-badge" data-wb-act="rec-restart" title="This tab was recording and lost it when the page reloaded. Saves what was captured and records again.">${ICON.svg('microphone')} Recording lost — record again</button>`;
  }
  if (S.live?.boardId === S.boardId && S.live?.recId) return '<span class="wb-rec-badge wb-rec-badge-remote">' + ICON.svg('microphone') + ' recording on another device</span>';
  if (S.live?.boardId === S.boardId && S.canGoLive) return '<span class="wb-rec-badge wb-rec-badge-off">not recording</span>';
  return '';
}
function recElapsedLabel() {
  if (!REC) return '';
  const s = Math.floor((Date.now() - REC.startedAtMs) / 1000);
  return `${REC.pausedAt ? '❚❚ ' : ''}${Math.floor(s / 60)}:${String(s % 60).padStart(2, '0')}`;
}

/* V3.732 — live + recording controls live in a RIGHT column beside the
   sheet (mirroring the thumbnail rail, so the board stays centred on the
   screen); on narrow mounts they fall back to the topbar. */
function renderTopbarRight() {
  if (S && isNotebook() && S.pills) renderPills();   /* V3.837 — the recording state lives on the Tools pill */
  const top = el('topbarRight');
  const side = el('side');
  const root = el('root');
  if (!top || !S) return;
  if (S.replay) { top.innerHTML = ''; if (side) side.hidden = true; return; }   /* the replay bar owns its controls */
  /* V3.830 — a notebook board has no live column: the host page owns the
     🎙 Record button and the recordings list */
  if (isNotebook()) { top.innerHTML = ''; if (side) { side.hidden = true; side.innerHTML = ''; } root?.classList.remove('wb-has-side'); return; }
  const isLive = S.live?.boardId === S.boardId;
  let html = '';
  /* V3.740 — every follower gets a Sync button + a plain status line */
  const syncBlock = () => {
    if (!followsLeader() || S.coll !== 'whiteboards') return '';
    const onLeaderPage = !S.board?.activePageId || S.board.activePageId === S.pageId;
    const state = !S.follow ? (continuous() ? 'Paused — you scrolled away.' : 'Paused — you moved to another page.')
      : onLeaderPage ? 'In sync with the leader.' : 'Catching up…';
    return `<button type="button" class="btn btn-small wb-sync-btn${!S.follow || !onLeaderPage ? ' wb-sync-btn-off' : ''}" data-wb-act="follow-resync" title="Jump to the leader's page and follow it">⟳ Sync to leader</button>
      <span class="wb-role-note muted-text" data-wb-sync-state>${state}</span>`;
  };
  if (!S.canGoLive) {
    html = (isLive ? '<span class="wb-live-tag"><span class="wb-live-dot"></span> LIVE</span>' : '') + (isLive ? syncBlock() : '');
  } else {
    const lead = isLeader();
    const someoneElse = !!S.board?.leaderDeviceId && !lead;
    html = `<button type="button" class="btn btn-small ${isLive ? 'btn-danger' : ''}" data-wb-act="live-toggle">
      ${isLive ? ICON.svg('stop') + ' End live' : ICON.svg('dot', { variant: 'solid', tint: '#ef4444' }) + ' Go live'}</button>${recBadgeHTML()}
      <div class="wb-role" role="group" aria-label="Leader or follower">
        <button type="button" class="wb-role-btn${lead ? ' wb-sel' : ''}" data-wb-act="role-leader" title="This device's page changes drive the room">Leader</button>
        <button type="button" class="wb-role-btn${!lead ? ' wb-sel' : ''}" data-wb-act="role-follower" title="Follow the leader's page">Follower</button>
      </div>
      <span class="wb-role-note muted-text">${lead ? 'Others follow this device.' : someoneElse ? 'Following another device.' : 'No leader yet — the device that draws (with a pen) first leads.'}</span>
      ${syncBlock()}`;
  }
  const useSide = !!side && !S.projector && root && root.clientWidth >= RAIL_MIN_ROOT_W && !!html;
  if (side) { side.hidden = !useSide; side.innerHTML = useSide ? `<div class="wb-side-head muted-text">Live</div>${html}` : ''; }
  top.innerHTML = useSide ? '' : html;
  root?.classList.toggle('wb-has-side', useSide);
}

function renderToolbar() {
  const bar = el('toolbar');
  if (!S) return;
  if (isNotebook() && S.pills) { if (bar) bar.hidden = true; renderPills(); return; }   /* V3.837 */
  if (!bar) return;
  if (!S.isAdmin) { bar.hidden = true; return; }
  bar.hidden = false;
  const page = currentPage();
  bar.innerHTML = `
    <div class="wb-tools-group">
      ${COLORS.map(c => `<button type="button" class="wb-color${S.color === c && S.tool === 'pen' ? ' wb-sel' : ''}"
        style="background:${c}" data-wb-act="color" data-color="${c}" title="Pen color"></button>`).join('')}
    </div>
    <div class="wb-tools-group">
      ${PEN_WIDTHS.map(w => `<button type="button" class="wb-width${S.width === w.w ? ' wb-sel' : ''}"
        data-wb-act="width" data-w="${w.w}" title="${w.label}"><span style="height:${Math.max(2, w.w * 900)}px"></span></button>`).join('')}
    </div>
    <div class="wb-tools-group">
      <button type="button" class="btn btn-small${S.tool === 'eraser' ? ' wb-sel' : ''}" data-wb-act="eraser" title="Stroke eraser">⌫ Erase</button>
      <button type="button" class="btn btn-small" data-wb-act="undo" title="Undo my last stroke">${ICON.svg('arrow-uturn-left')} Undo</button>
      <button type="button" class="btn btn-small btn-secondary" data-wb-act="clear-page">Clear page</button>
      <button type="button" class="btn btn-small${S.arrange ? ' wb-sel' : ''}" data-wb-act="arrange" title="Move, resize or remove figures and text on the board (the pen draws while this is off)">⤧ Arrange</button>
    </div>
    ${isNotebook() ? '' : `<div class="wb-tools-group">
      <div class="wb-role wb-sheetmode" role="group" aria-label="Page layout">
        <button type="button" class="wb-role-btn${continuous() ? ' wb-sel' : ''}" data-wb-act="mode-continuous" title="One continuous sheet: scroll freely, pages separated by a dashed line, and the room follows your exact scroll">⇵ Continuous</button>
        <button type="button" class="wb-role-btn${continuous() ? '' : ' wb-sel'}" data-wb-act="mode-pages" title="Separate pages that snap into place; the room follows your page">▤ Pages</button>
      </div>
    </div>`}
    <div class="wb-tools-group">
      <label class="wb-bg-label muted-text">Bg
        <select class="wb-bg-select" data-wb-bg>
          ${BACKGROUNDS.map(b => `<option value="${b.key}" ${page?.background === b.key ? 'selected' : ''}>${b.label}</option>`).join('')}
        </select>
      </label>
    </div>
    ${isNotebook() ? `<div class="wb-tools-group">
      ${S.tools.map(t => `<button type="button" class="btn btn-small${t.active ? ' wb-sel' : ''}" data-wb-act="tool" data-tool="${escAttr(t.act)}" title="${escAttr(t.title || '')}">${esc(t.label)}</button>`).join('')}
    </div>` : `<div class="wb-tools-group">
      <button type="button" class="btn btn-small${S.simFormOpen ? ' wb-sel' : ''}" data-wb-act="sim-form" title="Add a learning-module simulation as a new page">＋ Simulation</button>
      ${page?.kind === 'sim' ? `
      <div class="wb-role wb-simmode" role="group" aria-label="Interact or annotate">
        <button type="button" class="wb-role-btn${S.annotate ? '' : ' wb-sel'}" data-wb-act="sim-interact" title="Use the simulation's controls">${ICON.svg('cursor-arrow-rays')} Interact</button>
        <button type="button" class="wb-role-btn${S.annotate ? ' wb-sel' : ''}" data-wb-act="sim-annotate" title="Draw over the simulation">✎ Annotate</button>
      </div>` : ''}
    </div>
    <form class="wb-sim-form" data-wb-sim-form ${S.simFormOpen ? '' : 'hidden'}>
      <div class="wb-sim-picks" data-wb-sim-picks></div>
      <div class="wb-role wb-simmode" role="group" aria-label="What to add">
        <button type="button" class="wb-role-btn${(S.simMode || 'sim') === 'sim' ? ' wb-sel' : ''}" data-wb-act="sim-mode-sim" title="Controls and canvases only">Simulation only</button>
        <button type="button" class="wb-role-btn${S.simMode === 'section' ? ' wb-sel' : ''}" data-wb-act="sim-mode-section" title="The whole section: story, task and simulation">Whole section</button>
      </div>
      <button type="submit" class="btn btn-small" data-wb-sim-add disabled>Add page</button>
      <span class="wb-sim-status muted-text" data-wb-sim-status>${esc(S.simStatus || 'Pick a module, a tab and a section.')}</span>
    </form>`}`;
  /* V3.776 — module / tab / section dropdowns; the ref is assembled from them */
  wireSimForm(bar);
  bar.querySelector('[data-wb-bg]')?.addEventListener('change', async (e) => {
    if (!S?.isAdmin) return;
    const pages = (S.board?.pages || []).map(p =>
      p.id === S.pageId ? { ...p, background: e.target.value } : p);
    try {
      await boardsCol(S.classId, S.coll).doc(S.boardId)
        .update({ pages, updatedAt: FV().serverTimestamp() });
    } catch (err) { console.warn('[whiteboard] bg change failed', err); toast('Could not change background.'); }
  });
}

function renderPagesBar() {
  const bar = el('pagesbar');
  if (!bar || !S) return;
  if (infinite()) { bar.innerHTML = ''; bar.hidden = true; return; }   // V3.841 — no pages on the plane
  if (S.projector) { bar.innerHTML = ''; return; }
  const pages = S.board?.pages || [];
  const liveId = S.board?.activePageId;
  let html = '<div class="wb-pages">';
  pages.forEach((p, i) => {
    const cur = p.id === S.pageId;
    const isLivePage = p.id === liveId;
    html += `<button type="button" class="wb-page-dot${cur ? ' wb-sel' : ''}" data-wb-act="goto-page"
      data-page-id="${escAttr(p.id)}" title="Page ${i + 1}">${i + 1}${isLivePage && !cur ? '<span class="wb-live-dot wb-live-dot-mini"></span>' : ''}</button>`;
  });
  if (S.isAdmin) html += '<button type="button" class="wb-page-dot wb-page-add" data-wb-act="add-page" title="Add page">＋</button>';
  html += '</div>';
  const follows = followsLeader() && !isNotebook();
  /* continuous mode: a paused follower may still be on the live PAGE but
     scrolled elsewhere on it, so the chip shows for any pause */
  if (follows && !S.follow && liveId && (liveId !== S.pageId || continuous())) {
    html += `<button type="button" class="wb-follow-chip" data-wb-act="follow-live">
      <span class="wb-live-dot"></span> ${continuous() ? 'Back to live' : 'Jump to live page'}</button>`;
  }
  bar.innerHTML = html;
}

function currentPage() {
  return (S?.board?.pages || []).find(p => p.id === S.pageId) || null;
}

/* ─── Thumbnail rail (V3.730) ───────────────────────────────── */
/** Rebuild the rail's buttons when the page list (or the admin flag)
 *  changes; otherwise just refresh selection + live markers. Thumbs are
 *  repainted lazily by renderThumbs(). Hidden on the projector and when
 *  the mount is too narrow (the page dots take over). */
function renderRail() {
  const rail = el('rail');
  const root = el('root');
  if (!rail || !root || !S) return;
  const pages = S.board?.pages || [];
  const show = !S.projector && !S.replay && !infinite() && root.clientWidth >= RAIL_MIN_ROOT_W;
  rail.hidden = !show;
  root.classList.toggle('wb-has-rail', show);
  if (!show) return;
  /* V3.732 — the rail can be hidden to a thin strip (persisted per browser) */
  const collapsed = railCollapsed();
  rail.classList.toggle('wb-rail-collapsed', collapsed);
  if (collapsed) {
    rail.dataset.key = 'collapsed';
    rail.innerHTML = `<button type="button" class="wb-rail-toggle" data-wb-act="rail-toggle" title="Show pages">▸</button>
      <span class="wb-rail-count">${pages.length}</span>`;
    return;
  }
  const key = pages.map(p => p.id).join(',') + (S.isAdmin ? '|admin' : '');
  if (rail.dataset.key !== key) {
    rail.dataset.key = key;
    rail.innerHTML = `<button type="button" class="wb-rail-toggle" data-wb-act="rail-toggle" title="Hide pages">◂ Pages</button>` + pages.map((p, i) => `
      <button type="button" class="wb-thumb-btn" data-wb-act="goto-page" data-page-id="${escAttr(p.id)}" title="Page ${i + 1}">
        <canvas class="wb-thumb"></canvas>
        <span class="wb-thumb-num">${i + 1}</span>
        <span class="wb-live-dot wb-live-dot-mini" hidden></span>
      </button>`).join('')
      + (S.isAdmin ? '<button type="button" class="wb-thumb-add" data-wb-act="add-page" title="Add a page below">＋</button>' : '');
    pages.forEach(p => S.thumbDirty.add(p.id));
  }
  rail.querySelectorAll('.wb-thumb-btn').forEach(b => {
    const pid = b.dataset.pageId;
    b.classList.toggle('wb-sel', pid === S.pageId);
    const dot = b.querySelector('.wb-live-dot');
    if (dot) dot.hidden = !(S.board?.activePageId === pid && pid !== S.pageId);
  });
  /* V3.739 — page actions ride on the SELECTED thumbnail (admins): move
     up / down, delete (two-tap). A sibling of the thumb, not inside it —
     buttons cannot nest. */
  rail.querySelector('.wb-thumb-acts')?.remove();
  const sel0 = rail.querySelector('.wb-thumb-btn.wb-sel');
  if (sel0 && S.isAdmin) {
    const idx = pageIndexOf(S.pageId), n = pages.length;
    const acts = document.createElement('div');
    acts.className = 'wb-thumb-acts';
    acts.innerHTML = `
      <button type="button" class="wb-thumb-act" data-wb-act="page-up" data-page-id="${escAttr(S.pageId)}" title="Move page up" ${idx === 0 ? 'disabled' : ''}>▲</button>
      <button type="button" class="wb-thumb-act" data-wb-act="page-down" data-page-id="${escAttr(S.pageId)}" title="Move page down" ${idx >= n - 1 ? 'disabled' : ''}>▼</button>
      <button type="button" class="wb-thumb-act wb-thumb-act-del" data-wb-act="page-del" data-page-id="${escAttr(S.pageId)}" title="Delete page" ${n <= 1 ? 'disabled' : ''}>×</button>`;
    sel0.insertAdjacentElement('afterend', acts);
  }
  const sel = rail.querySelector('.wb-thumb-btn.wb-sel');
  if (sel && typeof sel.scrollIntoView === 'function') {
    try { sel.scrollIntoView({ block: 'nearest' }); } catch (e) {}
  }
  scheduleThumbs();
}

function railCollapsed() {
  try { const v = localStorage.getItem('wb_rail'); if (v === null && isNotebook()) return true; return v === '0'; } catch (e) { return !!isNotebook(); }
}
function setRailCollapsed(v) {
  try { localStorage.setItem('wb_rail', v ? '0' : '1'); } catch (e) {}
  renderRail();
}

function markThumb(pid) {
  if (!S || !pid) return;
  S.thumbDirty.add(pid);
  scheduleThumbs();
}
function scheduleThumbs() {
  if (!S || S.thumbTimer || !S.thumbDirty.size) return;
  S.thumbTimer = setTimeout(() => { if (S) { S.thumbTimer = null; renderThumbs(); } }, 400);
}
/** Repaint dirty thumbnails with the SAME background + stroke painters as
 *  the board, so a thumb can never disagree with its page. */
function renderThumbs() {
  const rail = el('rail');
  if (!rail || !S || rail.hidden) { S && S.thumbDirty.clear(); return; }
  const dpr = Math.min(window.devicePixelRatio || 1, 2);
  const pages = S.board?.pages || [];
  S.thumbDirty.forEach(pid => {
    const btn = rail.querySelector(`.wb-thumb-btn[data-page-id="${pid}"]`);
    const cv = btn?.querySelector('canvas.wb-thumb');
    const page = pages.find(p => p.id === pid);
    if (!btn || !cv || !page) return;
    const wCss = btn.clientWidth - 4;
    if (wCss <= 0) return;
    const W = Math.round(wCss * dpr), H = Math.round(wCss * BOARD_H * dpr);
    if (cv.width !== W || cv.height !== H) { cv.width = W; cv.height = H; }
    cv.style.height = Math.round(wCss * BOARD_H) + 'px';
    const ctx = cv.getContext('2d');
    ctx.setTransform(1, 0, 0, 1, 0, 0);
    ctx.fillStyle = '#fff'; ctx.fillRect(0, 0, W, H);
    if (page.kind === 'sim') {
      ctx.fillStyle = '#eef2ff'; ctx.fillRect(0, 0, W, H);
      ctx.fillStyle = '#4338ca'; ctx.font = `bold ${Math.round(W / 9)}px system-ui, sans-serif`;
      ctx.textAlign = 'center';
      { /* V3.861 — the play mark is an icon (ICON.draw takes a top-left), centred with the word as one group */
        const fs = Math.round(W / 9), by = H / 2 - W / 30, tw = ctx.measureText('SIM').width, s = fs * 0.9, g = fs * 0.25, x0 = W / 2 - (s + g + tw) / 2;
        if (window.ICON) ICON.draw(ctx, 'play', x0, by - fs * 0.36 - s / 2, s, '#4338ca', { variant: 'solid' });
        ctx.fillText('SIM', x0 + s + g + tw / 2, by); }
      ctx.font = `${Math.round(W / 12)}px system-ui, sans-serif`; ctx.fillStyle = '#374151';
      ctx.fillText((page.sim?.ref || '').slice(0, 12), W / 2, H / 2 + W / 9);
      ctx.textAlign = 'start';
    } else {
      paintBackgroundInto(ctx, W, H, page.background || 'blank');
    }
    [...S.strokes.values()]
      .filter(s => s.pageId === pid && !s.erasedAt && !s.hiddenBy)
      .sort((a, b) => (a.seq || 0) - (b.seq || 0))
      .forEach(s => paintStroke(ctx, s, W));
  });
  S.thumbDirty.clear();
}

/* ─── Toolbar / page actions ────────────────────────────────── */
async function handleBoardAction(act, btn) {
  if (!S) return;
  switch (act) {
    case 'color':
      S.tool = 'pen'; S.color = btn.dataset.color; S.penId = null; S.hl = false; renderToolbar(); break;
    case 'width': {
      /* V3.839 — on a host board the width belongs to the pen in hand (a
         highlighter takes it ×3.4) and is kept in the pen set */
      const w = parseFloat(btn.dataset.w);
      const p = S.penId ? S.pens.find(x => x.id === S.penId) : null;
      if (p) { p.w = clampPenW(p.kind === 'hl' ? w * 3.4 : p.kind === 'eraser' ? w * 3 : w, p.kind); savePenSet(S.pens); if (p.kind === 'eraser') S.eraserW = p.w; else S.width = p.w; }
      else S.width = w;
      if (!(p && p.kind === 'eraser')) S.tool = 'pen';
      renderToolbar(); break;
    }
    /* V3.839 — the pen set: pick a pen (again → customise it), add one */
    case 'pen-pick': {
      const p = S.pens.find(x => x.id === btn.dataset.pen); if (!p) break;
      const inHand = S.penId === p.id && (p.kind === 'eraser' ? S.tool === 'eraser' : S.tool === 'pen');
      if (inHand) { S.penEdit = S.penEdit === p.id ? null : p.id; renderPills(); break; }
      usePen(p); S.penEdit = null; renderToolbar(); break;
    }
    case 'pen-add': {
      if (S.pens.length >= 12) { toast('Twelve pens is the most the fan holds — remove one first.'); break; }
      const kind = penKind(btn.dataset.kind);
      const p = { id: newId('pn'), kind, color: kind === 'hl' ? '#fde047' : kind === 'eraser' ? '#ffffff' : '#111827', w: PEN_KINDS[kind].def };
      S.pens.push(p); savePenSet(S.pens); usePen(p); S.penEdit = p.id; renderToolbar(); break;
    }
    case 'item-color': { const id = btn.dataset.item; if (id) updateItem(id, { color: /^#[0-9a-f]{6}$/i.test(btn.dataset.color || '') ? btn.dataset.color : '' }); break; }
    case 'zoom-fit': fitAll(); break;
    /* V3.842 — regions · organise · instances */
    case 'group': S.tool = S.tool === 'group' ? 'pen' : 'group'; S.regionDrag = null; paintLiveNow(); renderToolbar(); if (S.tool === 'group') toast('Drag a box around the cards you want to group.'); break;
    case 'organise': organiseByConnections().then(n => toast(n ? `Organised ${n} connected card${n === 1 ? '' : 's'} into flows.` : 'Connect some cards first — the arrows decide the layout.')); break;
    case 'regionref': openRefPicker(btn); break;
    case 'region-color': { const id = btn.dataset.item; if (id && /^#[0-9a-f]{6}$/i.test(btn.dataset.color || '')) updateItem(id, { color: btn.dataset.color }); break; }
    case 'eraser':
      S.tool = S.tool === 'eraser' ? 'pen' : 'eraser'; if (S.tool === 'eraser') { S.eraserW = 0; S.penId = null; } renderToolbar(); break;
    case 'undo': {
      /* skip ids that no longer exist (erased or undone remotely) */
      let id = null;
      while (S.myIds.length && !id) {
        const cand = S.myIds.pop();
        if (S.strokes.has(cand) && !S.strokes.get(cand).erasedAt) id = cand;
      }
      if (!id) { toast('Nothing to undo.'); return; }
      removeStrokes([id]);
      break;
    }
    case 'clear-page': {
      if (!armTwoTap(btn, 'Really clear?')) return;
      const ids = [...S.strokes.entries()]
        .filter(([, s]) => (infinite() || s.pageId === S.pageId) && !s.erasedAt).map(([id]) => id);   // V3.841 — the plane clears all its ink
      removeStrokes(ids);
      break;
    }
    case 'goto-page': {
      const pid = btn.dataset.pageId;
      if (!pid) return;
      setActivePage(pid, true);   // re-snaps even when already current
      break;
    }
    case 'add-page': {
      if (!S.isAdmin) return;
      const pid = newId('p');
      const pages = [...(S.board?.pages || []), { id: pid, background: currentPage()?.background || 'blank' }];
      /* V3.801 — continuous mode: the sheet just gets longer. Nobody's view
         moves (that page flip is exactly what students could not keep up
         with); the drawer scrolls down into the new page when ready. */
      if (continuous()) { await appendPageNoMove(); break; }
      /* Optimistic: lay the page out now so the snap starts this frame;
         the board listener confirms it (Firestore fires the local write
         before the promise resolves). */
      const leads = S.coll !== 'whiteboards' ? true : isLeader();
      S.board = { ...(S.board || {}), pages, activePageId: leads ? pid : S.board?.activePageId };
      S.pageId = pid;
      if (!leads) S.follow = false;
      recEvent('add-page', { pageId: pid, background: pages[pages.length - 1].background });
      if (leads) recEvent('page', { pageId: pid });
      renderRail(); renderPagesBar(); renderToolbar();
      centreOn(pages.length - 1, true);
      try {
        const upd = { pages, updatedAt: FV().serverTimestamp() };
        if (leads) upd.activePageId = pid;
        await boardsCol(S.classId, S.coll).doc(S.boardId).update(upd);
      } catch (e) { console.warn('[whiteboard] add page failed', e); toast('Could not add page.'); }
      break;
    }
    case 'mode-continuous': case 'mode-pages': {
      /* V3.801 — the layout is a property of the BOARD, so everyone sees
         the same geometry (a follower can only reproduce a scroll position
         in the layout it was made in). The old viewY goes with the switch,
         so nobody jumps to a stale position; the next scroll republishes. */
      if (!S.isAdmin) return;
      const want = act === 'mode-pages' ? 'pages' : 'continuous';
      if ((S.board?.sheetMode || 'continuous') === want) return;
      const upd = { sheetMode: want, viewY: FV().delete() };
      if (S.coll !== 'whiteboards' || isLeader()) upd.activePageId = S.pageId;   // the room lands on the leader's page
      try {
        await boardsCol(S.classId, S.coll).doc(S.boardId).update(upd);
        if (S) S.viewPub = null;
      } catch (e) { console.warn('[whiteboard] layout change failed', e); toast('Could not change the page layout.'); }
      break;
    }
    case 'rail-toggle': setRailCollapsed(!railCollapsed()); break;
    case 'page-up':   movePage(btn.dataset.pageId, -1); break;
    case 'page-down': movePage(btn.dataset.pageId, +1); break;
    case 'page-del': {
      if (!armTwoTap(btn, '✓')) return;
      deletePage(btn.dataset.pageId);
      break;
    }
    case 'sim-form':     S.simFormOpen = !S.simFormOpen; renderToolbar(); break;
    case 'sim-mode-sim': case 'sim-mode-section': {
      S.simMode = act === 'sim-mode-section' ? 'section' : 'sim';
      S.simStatus = '';
      renderToolbar();   /* wireSimForm → renderSimForm re-filters tabs/sections for the mode */
      break;
    }
    case 'arrange': S.arrange = !S.arrange; renderToolbar(); renderBoardChrome(); renderItems(); break;
    /* V3.837 — pill actions */
    case 'rec': {
      if (!isNotebook() || !S.isAdmin) break;
      if (recording()) stopRecording('stop').then(() => { toast('Recording saved.'); renderPills(); });
      else startRecording().then(r => { if (!r) toast('Recording could not start — the microphone is unavailable or was refused.'); else toast('Recording. Write, draw and talk; press ■ to stop.'); renderPills(); });
      break;
    }
    case 'rec-pause': if (REC?.pausedAt) recResume(); else recPause(); break;
    case 'rec-mark': recMark('important', true); break;
    case 'rec-mark-edit': { const m = recLastMark(); S.markEdit = m && S.markEdit !== m.id ? m.id : null; renderPills(); break; }
    case 'max': {
      if (S.onTool && S.tools.some(t => t.act === 'max')) { try { S.onTool('max', btn); } catch (e) {} }
      else setMaximized(!isMaximized(), true);
      renderPills();
      break;
    }
    case 'tidy': tidyItems().then(n => { if (n) toast(`Tidied ${n} card${n === 1 ? '' : 's'}.`); }); break;
    case 'insert': { const k = btn.dataset.kind; if (k && S.onInsert) { try { S.onInsert(k, btn); } catch (e) { console.warn('[whiteboard] insert failed', e); } } break; }
    case 'pen': S.tool = 'pen'; S.regionDrag = null; renderToolbar(); break;
    case 'fit-region': S.tool = S.tool === 'fitregion' ? 'pen' : 'fitregion'; S.regionDrag = null; paintLiveNow(); renderToolbar(); break;
    case 'pan': setHandMode(S.tool === 'pan' ? 'pen' : 'pan'); break;
    case 'zoom': setHandMode(S.tool === 'zoom' ? 'pen' : 'zoom'); break;
    /* V3.860 — the hand's modes, from the ✎ pill */
    case 'hand-pen': setHandMode('pen'); break;
    case 'pills-reset': S.pillPos = {}; savePillPos({}); S.openPill = null; renderPills(); break;
    case 'hand-pan': setHandMode('pan'); break;
    case 'hand-zoom': setHandMode('zoom'); break;
    case 'hand-hl': setHandMode('hl'); break;
    /* V3.863 — Cards: move and edit cards; the second arc acts on the chosen one */
    case 'hand-card': setHandMode('card'); break;
    case 'card-edit': if (S.cardSel) cardEdit(S.cardSel); break;
    case 'card-color': { const id = S.cardSel; const n = id && S.itemNodes.get(id); if (n) toggleTintPop(n, id); break; }
    case 'card-collapse': { const id = S.cardSel; const it = id && S.items.get(id); if (!it) break; if (it.type === 'region') toggleRegion(id); else updateItem(id, { collapsed: !it.collapsed }); break; }
    case 'card-front': { const id = S.cardSel; if (id && S.items.has(id)) updateItem(id, { z: Date.now() }); break; }
    case 'card-more': {
      const id = S.cardSel; const it = id && S.items.get(id); if (!it) break;
      if (mobile()) { openItemSheet(id, 'settings'); break; }
      const more = S.itemNodes.get(id)?.querySelector('[data-wb-wmenu]');
      if (more && S.widgets?.onMenu) { try { S.widgets.onMenu({ id, ...it }, more, widgetApi(id)); } catch (err) { console.warn('[whiteboard] widget menu failed', err); } }
      break;
    }
    case 'card-remove': { const id = S.cardSel; if (!id || !S.items.has(id)) break; if (!armTwoTap(btn, 'Really remove?')) return; cardRemove(id); renderPills(); break; }
    case 'card-done': cardSelect(null); break;
    case 'card-note': cardAddNote().catch(err => console.warn('[whiteboard] note', err)); break;
    case 'tool': { const t = btn.dataset.tool; if (t && S.onTool) { try { S.onTool(t, btn); } catch (e) { console.warn('[whiteboard] tool failed', e); } } break; }
    case 'sim-interact': S.annotate = false; renderToolbar(); renderSims(); break;
    case 'sim-annotate': S.annotate = true;  renderToolbar(); renderSims(); break;
    case 'role-leader':   if (!isLeader()) setLeader(true); break;
    case 'role-follower': if (isLeader()) setLeader(false); break;
    case 'zoom-in':   zoomAtCenter(1.25); persistView(); break;
    case 'zoom-out':  zoomAtCenter(1 / 1.25); persistView(); break;
    case 'zoom-home': resetView(); break;
    case 'view-quarter': pagePlusQuarter(); break;
    case 'follow-live':
    case 'follow-resync': resyncFollow(true); break;
    case 'max-toggle': setMaximized(!isMaximized(), true); break;
    case 'live-toggle': {
      if (!S.canGoLive) return;
      const isLive = S.live?.boardId === S.boardId;
      if (isLive) {
        /* End live — stop the recording FIRST (it may be ours), then clear the flag */
        if (REC && REC.boardId === S.boardId) await stopRecording('end-live');
        try {
          await db().collection('schedules').doc(S.classId).update({ liveWhiteboard: FV().delete() });
          toast('Live ended.');
        } catch (e) { console.warn('[whiteboard] live toggle failed', e); toast('Could not change live state.'); }
        break;
      }
      /* Go live = record, from THIS device's microphone. This click is the
         permission gesture. Denied/unavailable → live without a recording. */
      btn.disabled = true;
      const rec = await startRecording();
      btn.disabled = false;
      const live = { boardId: S.boardId, boardName: S.board?.name || '', since: FV().serverTimestamp() };
      if (rec) live.recId = rec.recId;
      try {
        await db().collection('schedules').doc(S.classId).update({ liveWhiteboard: live });
        if (REC) REC.arming = false;
        toast(rec ? 'You are live and recording — students see the banner now.'
                  : 'You are live (not recording — microphone unavailable).');
      } catch (e) {
        console.warn('[whiteboard] live toggle failed', e);
        if (rec) await stopRecording('abort');
        toast('Could not change live state.');
      }
      break;
    }
    /* V3.775 — the recorder tab reloaded mid-lecture: save what the lost
       recording captured (ink timeline rebuilt from the board), start a
       fresh recording from this tab's mic, and point the live flag at it. */
    case 'rec-restart': {
      if (!S.canGoLive || !S.recLost) return;
      const lost = S.recLost;
      btn.disabled = true;
      try { await finalizeInterrupted(S.classId, S.boardId, lost); }
      catch (e) { console.warn('[whiteboard] could not finalize the lost recording', e); }
      if (!S) return;
      const rec = await startRecording();
      if (!S) return;
      if (!rec) { btn.disabled = false; toast('Recording could not restart on this device (microphone unavailable).'); return; }
      S.recLost = null;
      try {
        await db().collection('schedules').doc(S.classId).update({ 'liveWhiteboard.recId': rec.recId });
        if (REC) REC.arming = false;
        toast('Recording again. The first part is saved as its own recording.');
      } catch (e) {
        console.warn('[whiteboard] live flag update failed', e);
        if (REC) REC.arming = false;
        toast('Recording restarted, but the live flag could not be updated.');
      }
      renderTopbarRight(); renderProjectorCtl();
      break;
    }
  }
}

/** V3.801 — append a page at the end of the sheet WITHOUT moving anyone's
 *  view (continuous ＋ page, and "Page + ¼" past the last page). Laid out
 *  optimistically so it can be framed this frame; the recorder logs it
 *  directly because its own snapshot will already contain the page.
 *  Resolves the new page id, or null if the write failed. */
async function appendPageNoMove() {
  if (!S?.isAdmin) return null;
  const pid = newId('p');
  const pages = [...(S.board?.pages || []), { id: pid, background: currentPage()?.background || 'blank' }];
  S.board = { ...(S.board || {}), pages };
  recEvent('add-page', { pageId: pid, background: pages[pages.length - 1].background });
  markThumb(pid);
  renderRail(); renderPagesBar();
  scheduleRedraw();
  try {
    await boardsCol(S.classId, S.coll).doc(S.boardId).update({ pages, updatedAt: FV().serverTimestamp() });
    return pid;
  } catch (e) {
    console.warn('[whiteboard] add page failed', e);
    toast('Could not add page.');
    return null;
  }
}

/* ─── Sheet geometry (V3.730) ───────────────────────────────── */
/* V3.801 — two layouts, chosen per BOARD (not per device: a follower can
   only reproduce a scroll position in the geometry the leader scrolled in).
   `sheetMode` absent or 'continuous' → one continuous sheet, pages touching,
   a dashed line between them, no snapping, followers track the exact
   scroll. 'pages' → the V3.730 snap-sheet. Stroke coordinates are page-
   local in both, so switching moves no data. */
function continuous() { return (S?.board?.sheetMode || 'continuous') !== 'pages'; }
function pageGap() { return continuous() ? 0 : PAGE_GAP; }
function pageTop(i) { return i * (BOARD_H + pageGap()); }
function pageCount() { return Math.max(1, (S?.board?.pages || []).length); }
function pageIndexOf(pid) {
  const i = (S?.board?.pages || []).findIndex(p => p.id === pid);
  return i < 0 ? 0 : i;
}
/** Stage height in page-width units. */
function sheetViewH() {
  const ink = el('ink');
  if (!(ink && S?.sheet)) return SHEET_VISIBLE_PAGES * BOARD_H;
  const h = ink.height / S.sheet.pageW;
  /* V3.839 — zoomed OUT the stage shows more sheet; zoomed in, the lens is
     a magnifier over the stage and the scroll keeps the stage's own height */
  const s = lensActive() ? S.view.scale : 1;
  return (s < 1 || infinite()) ? h / s : h;
}
/** V3.841 — visible plane width at the current scale (page-width units). */
function sheetViewW() {
  const ink = el('ink');
  if (!(ink && S?.sheet)) return 1;
  const s = lensActive() ? S.view.scale : 1;
  return ink.width / S.sheet.pageW / (infinite() ? s : 1);
}
/** The originY (sheet y at the top of the stage) that centres page i. */
function originYForPage(i) { return pageTop(i) + BOARD_H / 2 - sheetViewH() / 2; }
function clampOriginY(y) { return clampOriginYAt(y, sheetViewH()); }
function clampOriginYAt(y, vh) {
  if (infinite()) return y;                               // V3.841 — nothing to clamp against
  let lo = pageTop(0) + BOARD_H / 2 - vh / 2, hi = pageTop(pageCount() - 1) + BOARD_H / 2 - vh / 2;
  /* V3.839 — a page TALLER than the view (fit-width on a landscape screen)
     scrolls from its top edge to its bottom edge, not around its centre:
     the top strip of page 1 used to be unreachable */
  if (vh < BOARD_H) { lo = pageTop(0); hi = Math.max(lo, pageTop(pageCount() - 1) + BOARD_H - vh); }
  return Math.min(hi, Math.max(lo, y));
}
/** Index of the page containing sheet y `v`, or the nearest page if `v`
 *  falls in a gap or off the ends. */
function pageAtSheetY(v) {
  if (infinite()) return 0;                               // V3.841 — one plane
  const n = pageCount();
  let best = 0, bestD = Infinity;
  for (let i = 0; i < n; i++) {
    const top = pageTop(i);
    if (v >= top && v <= top + BOARD_H) return i;
    const d = v < top ? top - v : v - (top + BOARD_H);
    if (d < bestD) { bestD = d; best = i; }
  }
  return best;
}
/** The page whose centre is closest to the middle of the current view. */
function nearestPageToView() {
  if (!S?.sheet) return pageIndexOf(S?.pageId);
  const c = S.sheet.originY + sheetViewH() / 2;
  let best = 0, bestD = Infinity;
  for (let i = 0; i < pageCount(); i++) {
    const d = Math.abs(pageTop(i) + BOARD_H / 2 - c);
    if (d < bestD) { bestD = d; best = i; }
  }
  return best;
}
/** Sheet (u, v) → canvas device px BEFORE the lens transform. */
function sheetToPx(u, v) {
  const sh = S.sheet;
  return [sh.offX + (u - (sh.originX || 0)) * sh.pageW, (v - sh.originY) * sh.pageW];
}

/** Scroll the view so page i is centred. Animated by default — the snap
 *  is what tells the room "we moved", and the replay reuses it. Every
 *  tween frame redraws ALL layers synchronously so bg, ink and items
 *  never shear against each other. */
function centreOn(i, animate) {
  if (!S?.sheet || infinite()) return;                     // V3.841 — the plane has no page to centre
  const k = Math.max(0, Math.min(pageCount() - 1, i));
  scrollSheetTo(pageTop(k) + BOARD_H / 2, animate === false ? 0 : SNAP_MS);
}

/** V3.801 — move the view so sheet y `centre` sits in the middle of the
 *  stage (clamped to the sheet), over `ms` (0 = now). The tween remembers
 *  its CENTRE so a resize mid-flight can retarget it in the new geometry.
 *  Every frame redraws all layers synchronously so bg, ink and items never
 *  shear against each other. */
function scrollSheetTo(centre, ms) {
  if (!S?.sheet || !Number.isFinite(centre)) return;
  const to = clampOriginY(centre - sheetViewH() / 2);
  if (!ms || Math.abs(to - S.sheet.originY) < 1e-6) {
    S.sheetAnim = null;
    S.sheet.originY = to;
    redrawNow();
    return;
  }
  const anim = { from: S.sheet.originY, to, centre, dur: ms, t0: performance.now() };
  S.sheetAnim = anim;
  const step = (now) => {
    if (!S || S.sheetAnim !== anim) return;
    const k = Math.min(1, (now - anim.t0) / anim.dur);
    const e = 1 - Math.pow(1 - k, 3);          // ease-out cubic
    S.sheet.originY = anim.from + (anim.to - anim.from) * e;
    redrawNow();
    if (k < 1) requestAnimationFrame(step); else S.sheetAnim = null;
  };
  requestAnimationFrame(step);
}

/** Sheet y at the middle of the stage, where the view comes to rest
 *  (overscroll excluded). */
function viewCentre() {
  return clampOriginY(S.sheet.originY) + sheetViewH() / 2;
}

/** V3.801 — continuous mode: the current page is whichever page sits under
 *  the middle of the view, so the rail selection, "Clear page", the Bg
 *  picker and page actions follow the scroll. */
function trackPageUnderCentre() {
  if (!S?.sheet || !continuous()) return;
  const pid = (S.board?.pages || [])[pageAtSheetY(viewCentre())]?.id;
  if (!pid || pid === S.pageId) return;
  const prevKind = currentPage()?.kind || '';
  S.pageId = pid;
  renderRail(); renderPagesBar(); renderTopbarRight();
  if (!S.isAdmin) return;
  /* the toolbar only changes shape for simulation pages; otherwise just
     move the Bg picker, so an open ＋ Simulation form is not rebuilt */
  if ((currentPage()?.kind || '') !== prevKind) renderToolbar();
  else {
    const sel = el('toolbar')?.querySelector('[data-wb-bg]');
    if (sel) sel.value = currentPage()?.background || 'blank';
  }
}

/** V3.801 — the leader shares where it is scrolled. Whiteboards publish
 *  `viewY` (throttled while moving, always on release) plus the page under
 *  the centre as `activePageId`; a student's own notes board only records
 *  its page on release, so reopening it comes back to the same place. */
function publishView(final) {
  if (!S?.sheet || S.replay || S.projector || !continuous()) return;
  const leads = S.coll !== 'whiteboards' ? S.isAdmin : isLeader();
  if (!leads) return;
  const P = S.viewPub || (S.viewPub = { last: 0, timer: null, y: null, pid: null });
  const now = performance.now();
  if (!final && now - P.last < SCROLL_SYNC_MS) {
    if (!P.timer) {
      P.timer = setTimeout(() => {
        if (!S || S.viewPub !== P) return;
        P.timer = null;
        publishView(false);
      }, SCROLL_SYNC_MS - (now - P.last));
    }
    return;
  }
  clearTimeout(P.timer); P.timer = null;
  const centre = viewCentre();
  const y = round4(centre);
  const pid = (S.board?.pages || [])[pageAtSheetY(centre)]?.id || S.pageId;
  /* V3.830 — a notebook board writes no viewY (nobody follows), so the
     recorder takes the scroll from HERE, the drawer's own device */
  if (isNotebook()) recScroll(y, infinite() ? round4((S.sheet.originX || 0) + sheetViewW() / 2) : undefined);
  const upd = {};
  if (S.coll === 'whiteboards' && y !== P.y) upd.viewY = y;
  if ((final || S.coll === 'whiteboards') && pid !== (P.pid ?? S.board?.activePageId)) upd.activePageId = pid;
  if (!Object.keys(upd).length) return;
  P.last = now;
  if ('viewY' in upd) P.y = y;
  if ('activePageId' in upd) P.pid = pid;
  boardsCol(S.classId, S.coll).doc(S.boardId).update(upd)
    .catch(e => console.warn('[whiteboard] view sync failed', e));
}

/** V3.801 — a scroll gesture ended in continuous mode: ease any overscroll
 *  back onto the sheet, settle the current page, and publish the final
 *  position. No snap. */
function settleScroll() {
  if (!S?.sheet) return;
  if (infinite()) persistView();                           // V3.841 — remember where the plane was left
  const centre = viewCentre();
  if (Math.abs(clampOriginY(S.sheet.originY) - S.sheet.originY) > 1e-6) scrollSheetTo(centre, 180);
  trackPageUnderCentre();
  publishView(true);
}

/** A follower scrolled by hand (continuous mode): stop tracking the leader
 *  until the leader's next page change, ⟳ Sync, or "Jump to live". */
function pauseFollowByHand() {
  if (!S || S.projector || !S.follow || !followsLeader()) return;
  S.follow = false;
  renderTopbarRight(); renderPagesBar();
}

/** Make `pid` the current page: centre on it, and — for the admin —
 *  publish it as the board's activePageId so the projector and every
 *  following student snap with them. A viewer choosing a page pauses
 *  follow unless they chose the live page itself. */
async function setActivePage(pid, animate) {
  if (!S) return;
  const pages = S.board?.pages || [];
  if (!pages.some(p => p.id === pid)) return;
  const changed = pid !== S.pageId;
  const cont = continuous();
  /* Student boards (notes/homework) have one owner, who always leads. */
  const leads = S.coll !== 'whiteboards' ? S.isAdmin : isLeader();
  S.pageId = pid;
  if (!leads && cont && followsLeader() && pid === S.board?.activePageId && typeof S.board?.viewY === 'number') {
    /* a follower choosing the live page goes back to the leader's exact
       scroll position, not the page's centre */
    S.follow = true;
    scrollSheetTo(S.board.viewY, animate === false ? 0 : SNAP_MS);
  } else {
    centreOn(pageIndexOf(pid), animate !== false);
    if (leads) {
      /* continuous: re-centring the page you are on is still a move the
         room should follow, so the target position is published even
         when the page did not change. Published ONCE, at the target —
         the tween frames never publish, so followers are never sent a
         position behind where the leader is going. */
      const upd = {};
      if (changed) upd.activePageId = pid;
      if (cont && S.coll === 'whiteboards') {
        const i = pageIndexOf(pid);
        upd.viewY = round4(clampOriginY(originYForPage(i)) + sheetViewH() / 2);
        S.viewPub = { last: performance.now(), timer: null, y: upd.viewY, pid };
      } else if (cont && isNotebook()) {
        recScroll(round4(clampOriginY(originYForPage(pageIndexOf(pid))) + sheetViewH() / 2));   /* V3.830 */
      }
      if (Object.keys(upd).length) {
        try { await boardsCol(S.classId, S.coll).doc(S.boardId).update(upd); }
        catch (e) { console.warn('[whiteboard] page flip failed', e); }
      }
    } else if (changed || cont) {
      if (pid !== S.board?.activePageId) S.follow = !!S.projector; // manual flip pauses follow (admins as followers too); never the projector
      else S.follow = true;
    }
  }
  if (!S) return;
  renderRail(); renderPagesBar(); renderToolbar(); renderTopbarRight(); renderProjectorCtl();
}

/* ─── Canvas sizing + backgrounds ───────────────────────────── */
function sizeCanvases() {
  if (!S) return;
  const board = el('board');
  const bg  = el('bg');
  const ink = el('ink');
  const live = el('live');
  if (!board || !bg || !ink) return;
  /* V3.730 — the canvases cover the whole sheet area (the stage minus the
     rail), not just one page. The page is scaled so the centred page plus
     a quarter of each neighbour fill the height, with a small side margin. */
  /* Critical layout inline as well as in whiteboard-board.css: a browser
     holding a STALE cached stylesheet (seen after the V3.730 rollout — the
     old rules gave .wb-board no width, so only the rail showed) must still
     get a sized sheet. */
  const stage = el('stage');
  if (stage) { stage.style.display = 'flex'; stage.style.alignItems = 'stretch'; }
  board.style.flex = '1 1 0%'; board.style.minWidth = '0'; board.style.minHeight = '0'; board.style.position = 'relative';
  let sw = board.clientWidth, sh = board.clientHeight;
  if ((!sw || !sh) && stage) { sw = sw || stage.clientWidth; sh = sh || stage.clientHeight; }
  if (!sw || !sh) return;
  /* V3.801 — continuous mode keeps whatever is in the MIDDLE of the view
     through a resize (measured before the canvases change size) */
  const prevCentre = (S.sheet && ink.height) ? S.sheet.originY + (ink.height / S.sheet.pageW) / 2 : null;
  const dpr = Math.min(window.devicePixelRatio || 1, 3);
  const pageWcss = S.fitWidth ? Math.max(120, sw) : Math.max(120, Math.min(sw - 16, sh / (SHEET_VISIBLE_PAGES * BOARD_H)));
  [bg, ink, live].filter(Boolean).forEach(c => {
    c.width = Math.round(sw * dpr);
    c.height = Math.round(sh * dpr);
    c.style.width = sw + 'px';
    c.style.height = sh + 'px';
  });
  const pageW = pageWcss * dpr;
  const offX = infinite() ? 0 : (ink.width - pageW) / 2;    // V3.841 — the plane starts at the stage's left edge
  /* A resize mid-snap (the toolbar just grew or shrank, say) must not
     abort the snap: keep the tween and retarget it. At rest, keep whatever
     page is centred exactly centred through the resize. */
  const anim = S.sheetAnim;
  const centred = anim ? pageIndexOf(S.pageId) : (S.sheet ? nearestPageToView() : pageIndexOf(S.pageId));
  const prevY = S.sheet ? S.sheet.originY : null;
  const prevX = S.sheet ? (S.sheet.originX || 0) : 0, firstSheet = !S.sheet;
  S.sheet = { pageW, offX, originY: 0, originX: prevX };
  if (infinite()) {
    /* V3.841 — the plane keeps its top-left through a resize; the first
       layout restores where this device last was on this board */
    S.sheet.originY = prevY ?? 0;
    if (firstSheet) restoreOrigin();
  } else if (anim) {
    /* retarget by the tween's own centre (a page centre for a snap, the
       leader's viewY for a follow) in the new geometry */
    S.sheet.originY = prevY ?? 0;
    anim.from = S.sheet.originY; anim.to = clampOriginY(anim.centre - sheetViewH() / 2); anim.t0 = performance.now();
  } else if (continuous() && prevCentre != null) {
    S.sheet.originY = clampOriginY(prevCentre - sheetViewH() / 2);
  } else {
    S.sheet.originY = clampOriginY(originYForPage(centred));
  }
  if (lensActive()) clampView();
  /* The FIRST getContext call fixes the context attributes for the life of
     the canvas, so claim it here (before any paint). See
     LOW_LATENCY_CANVAS — off by default as of V3.683. */
  ink.getContext('2d', LOW_LATENCY_CANVAS ? { desynchronized: true } : undefined);
  renderRail();
}

function drawBackground() {
  if (!S || !S.sheet) return;
  const bg = el('bg');
  if (!bg) return;
  const ctx = bg.getContext('2d');
  const W = bg.width, H = bg.height;
  ctx.setTransform(1, 0, 0, 1, 0, 0);
  /* the desk: pages are sheets of paper on it */
  ctx.fillStyle = S.theme.desk;
  ctx.fillRect(0, 0, W, H);
  if (infinite()) {
    /* V3.841 — the plane: paper everywhere, graph lines aligned to it */
    ctx.fillStyle = S.theme.page; ctx.fillRect(0, 0, W, H);
    paintPlaneGrid(ctx, W, H, (S.board?.pages || [])[0]?.background || 'grid');
    return;
  }
  const lens = lensActive();
  if (lens) { ctx.save(); applyViewTransform(ctx, S.sheet.pageW); }
  const pages = S.board?.pages || [{ id: 'p1', background: 'blank' }];
  const pw = S.sheet.pageW, ph = BOARD_H * pw;
  pages.forEach((page, i) => {
    const [x, y] = sheetToPx(0, pageTop(i));
    /* cull pages entirely off the canvas (cheap, exact at scale 1) */
    if (!lens && (y > H + 4 || y + ph < -4)) return;
    ctx.fillStyle = S.theme.edge;
    ctx.fillRect(x, y + 2 * (pw / 1000), pw, ph);        // soft drop edge
    ctx.fillStyle = S.theme.page;
    ctx.fillRect(x, y, pw, ph);
    if (page.kind === 'sim') {
      /* the iframe covers this rect; a faint label shows while it loads */
      ctx.fillStyle = '#9ca3af';
      ctx.font = `${Math.round(pw / 40)}px system-ui, sans-serif`;
      ctx.textAlign = 'center';
      ctx.fillText(page.sim?.title || 'Simulation', x + pw / 2, y + ph / 2);
      ctx.textAlign = 'start';
      return;
    }
    ctx.save();
    ctx.beginPath(); ctx.rect(x, y, pw, ph); ctx.clip();
    ctx.translate(x, y);
    paintBackgroundInto(ctx, pw, ph, page.background || 'blank', S.theme);
    ctx.restore();
  });
  /* V3.801 — continuous mode: the pages touch, and a light grey dashed
     line marks each page boundary. A second pass, so the next page's fill
     cannot paint over it. Sized from the page width, so the projector
     shows the same line the tablet does. */
  if (continuous() && pages.length > 1) {
    ctx.save();
    ctx.strokeStyle = S.theme.divider;
    ctx.lineWidth = Math.max(1, pw / 900);
    ctx.setLineDash([pw / 90, pw / 140]);
    for (let i = 1; i < pages.length; i++) {
      const [x, y] = sheetToPx(0, pageTop(i));
      if (!lens && (y < -4 || y > H + 4)) continue;
      ctx.beginPath(); ctx.moveTo(x, y); ctx.lineTo(x + pw, y); ctx.stroke();
    }
    ctx.restore();
  }
  if (lens) ctx.restore();
}

/** Redraw every layer in THIS frame (bg, items, ink, live). Used by the
 *  snap tween and by scheduleRedraw(); callers reacting to input at
 *  pointer-event rate go through scheduleRedraw() so frames coalesce. */
function redrawNow() {
  if (!S) return;
  S.redrawQueued = false;
  drawBackground();
  renderItems();
  renderSims();
  repaint();
  paintLiveNow();
  updateZoomLabel();
}
function scheduleRedraw() {
  if (!S || S.redrawQueued) return;
  S.redrawQueued = true;
  requestAnimationFrame(() => { if (S && S.redrawQueued) redrawNow(); });
}

/* Pure: paint one background template into any 2D context. Shared by the
   live board and by exportBoardPNGs(), so an exported page can never look
   different from the one the student drew on. */
function paintBackgroundInto(ctx, W, H, kind, theme) {
  if (kind === 'blank') return;
  const th = theme || {};
  ctx.strokeStyle = kind === 'ruled' ? (th.ruled || '#dbeafe') : (th.grid || '#e5e7eb');
  ctx.lineWidth = 1;
  const step = W / 32; // 32 columns across the board
  if (kind === 'grid') {
    for (let x = step; x < W; x += step) { ctx.beginPath(); ctx.moveTo(x, 0); ctx.lineTo(x, H); ctx.stroke(); }
    for (let y = step; y < H; y += step) { ctx.beginPath(); ctx.moveTo(0, y); ctx.lineTo(W, y); ctx.stroke(); }
  } else if (kind === 'ruled') {
    for (let y = step * 1.5; y < H; y += step * 1.5) { ctx.beginPath(); ctx.moveTo(0, y); ctx.lineTo(W, y); ctx.stroke(); }
  } else if (kind === 'axes') {
    /* faint grid + bold axes anchored lower-left */
    for (let x = step; x < W; x += step) { ctx.beginPath(); ctx.moveTo(x, 0); ctx.lineTo(x, H); ctx.stroke(); }
    for (let y = step; y < H; y += step) { ctx.beginPath(); ctx.moveTo(0, y); ctx.lineTo(W, y); ctx.stroke(); }
    ctx.strokeStyle = '#9ca3af'; ctx.lineWidth = 2;
    const ox = step * 3, oy = H - step * 3;
    ctx.beginPath(); ctx.moveTo(ox, step); ctx.lineTo(ox, oy); ctx.lineTo(W - step, oy); ctx.stroke();
    /* arrowheads */
    ctx.beginPath(); ctx.moveTo(ox - 6, step + 10); ctx.lineTo(ox, step); ctx.lineTo(ox + 6, step + 10); ctx.stroke();
    ctx.beginPath(); ctx.moveTo(W - step - 10, oy - 6); ctx.lineTo(W - step, oy); ctx.lineTo(W - step - 10, oy + 6); ctx.stroke();
  }
}

/* ================================================================
   VIEWER-LOCAL LENS (V3.684) — zoom/pan that is NEVER synced
   ================================================================
   Strokes stay in the fixed 16:10 board space; this is a per-screen
   lens applied only at paint time. The projector and the full-page
   route mount with view.enabled false, and lensActive() then short-
   circuits every transform call — the identity transform is never even
   applied, so the classroom screen provably cannot drift.
   ================================================================ */
const MIN_SCALE = 1, MAX_SCALE = 8;
/* V3.839 — host boards (notebook, figure board) zoom OUT to 30 %: the sheet
   is the canvas and you want to see all of it. Class boards stay at ≥ 100 %
   (followers mirror a 100 % stage). */
function minScale() { return isNotebook() ? 0.3 : MIN_SCALE; }

function lensActive() {
  return !!(S && S.viewEnabled);
}

/** Board space → canvas px, as a canvas transform. Coordinates are
 *  normalized by board WIDTH on both axes, so tx/ty are in board-width
 *  units too and the lens is resolution independent. */
function applyViewTransform(ctx, W) {
  const v = S.view;
  ctx.setTransform(v.scale, 0, 0, v.scale, v.tx * W, v.ty * W);
}

/** Zoom about a point given in normalized screen units (0..1 of board width). */
function zoomAt(factor, sx, sy) {
  if (!lensActive()) return;
  const v = S.view;
  const ns = Math.min(MAX_SCALE, Math.max(minScale(), v.scale * factor));
  /* Re-derive the factor from the CLAMPED scale. Without this the anchor
     point drifts every time a pinch pushes past a limit. */
  factor = ns / v.scale;
  if (factor === 1) return;
  v.tx = sx - (sx - v.tx) * factor;
  v.ty = sy - (sy - v.ty) * factor;
  v.scale = ns;
  clampView();
  redrawAll();
}

function zoomAtCenter(factor) {
  const ink = el('ink');
  if (!ink || !S?.sheet) return;
  /* centre of the stage, in page-width units */
  zoomAt(factor, ink.width / S.sheet.pageW / 2, ink.height / S.sheet.pageW / 2);
}

function resetView() {
  if (!lensActive()) return;
  if (infinite() && S.sheet) {
    /* V3.841 — ⌂ home on the plane: the content's top-left at 100 % */
    const ext = contentExtent();
    animateView({ o: ext.top - 0.04, ox: ext.left - 0.04, s: 1, tx: 0, ty: 0 }, SNAP_MS, () => { if (S) { persistView(); renderPills(); } });
    return;
  }
  S.view = { tx: 0, ty: 0, scale: 1 };
  redrawAll();
  persistView();
}

/** Keep the board from being panned entirely off-screen. */
function clampView() {
  const v = S.view;
  if (infinite()) {
    /* V3.841 — the plane has no lens offset: whatever a zoom or pan put in
       tx/ty is folded into the origin (origin −= t / s), so the ink,
       the cards layer and the grid agree by construction */
    if (!S.sheet) { v.tx = 0; v.ty = 0; return; }
    if (v.tx || v.ty) { S.sheet.originX = (S.sheet.originX || 0) - v.tx / v.scale; S.sheet.originY -= v.ty / v.scale; v.tx = 0; v.ty = 0; }
    return;
  }
  if (v.scale < 1 && isNotebook()) {
    /* zoomed out: the sheet centred across the stage, scrolled by the sheet */
    const ink = el('ink');
    const Wc = (ink && S.sheet) ? ink.width / S.sheet.pageW : 1;
    v.tx = Wc * (1 - v.scale) / 2; v.ty = 0; return;
  }
  if (v.scale <= 1) { v.tx = 0; v.ty = 0; return; }
  /* V3.730 — the lens magnifies the whole stage (sheet area), so the
     bounds are the canvas extent in page-width units, not one page. */
  const ink = el('ink');
  const Wc = (ink && S.sheet) ? ink.width / S.sheet.pageW : 1;
  const Hc = (ink && S.sheet) ? ink.height / S.sheet.pageW : BOARD_H;
  v.tx = Math.min(0, Math.max(Wc * (1 - v.scale), v.tx));
  v.ty = Math.min(0, Math.max(Hc * (1 - v.scale), v.ty));
}

/* Kept as the name every lens path calls; frames coalesce. */
function redrawAll() { scheduleRedraw(); }

function updateZoomLabel() {
  const box = el('root');
  if (!box || !S) return;
  box.querySelectorAll('[data-wb-zoom-pct]').forEach(pct => { pct.textContent = Math.round(S.view.scale * 100) + '%'; });
}

/* ================================================================
   V3.804 — VIEW DOCK: zoom + / − / home and "Page + ¼", one tap each
   ================================================================
   A small floating column in the board's top-left corner (the desk
   margin beside the page at 100%, and the corner a writing palm is least
   likely to rest on). Page route only — the module panel has its topbar
   zoom — and never the projector, whose view is never zoomed. Pointer
   events stop here, so a finger on a button is never read by the stage
   as the start of a scroll or pinch. */
function renderViewDock() {
  const dock = el('viewdock');
  if (!dock || !S) return;
  const show = S.viewEnabled && !S.projector && S.chrome === 'full';
  dock.hidden = !show;
  if (!show) { dock.innerHTML = ''; return; }
  if (!dock.dataset.wired) {
    dock.dataset.wired = '1';
    ['pointerdown', 'pointermove', 'pointerup', 'pointercancel', 'wheel'].forEach(t =>
      dock.addEventListener(t, e => e.stopPropagation()));
  }
  dock.innerHTML = `
    <button type="button" class="wb-dock-btn" data-wb-act="zoom-in" title="Zoom in">+</button>
    <span class="wb-dock-pct" data-wb-zoom-pct>${Math.round(S.view.scale * 100)}%</span>
    <button type="button" class="wb-dock-btn" data-wb-act="zoom-out" title="Zoom out">&minus;</button>
    <button type="button" class="wb-dock-btn" data-wb-act="zoom-home" title="Back to 100%">&#8962;</button>
    ${S.isAdmin ? `<button type="button" class="wb-dock-btn wb-dock-quarter" data-wb-act="view-quarter"
      title="Show the whole page with the last quarter of the page above it. Tap again for the next page (adds one at the end).">Page<br>+&frac14;</button>` : ''}`;
}

/** Index of the page under the middle of what is VISIBLE (lens included). */
function visiblePageIndex() {
  const ink = el('ink');
  const pw = S.sheet.pageW;
  const v = lensActive() ? S.view : { tx: 0, ty: 0, scale: 1 };
  const cy = (ink.height / 2 - v.ty * pw) / v.scale;          // canvas px before the lens
  return pageAtSheetY(cy / pw + S.sheet.originY);
}
function frameState() {
  return { o: S.sheet.originY, ox: S.sheet.originX || 0, s: S.view.scale, tx: S.view.tx, ty: S.view.ty };
}
function sameFrame(a, b) {
  return !!a && !!b && ['o', 's', 'tx', 'ty'].every(k => Math.abs(a[k] - b[k]) < 1e-4);
}

/** "Page + ¼": frame the whole page under the middle of the view with the
 *  last quarter of the page above it. Tapped again while the view is still
 *  exactly that frame, it moves on to the next page — adding one at the end
 *  first when it was the last (no hidden mode: any scroll or zoom in
 *  between makes the next tap re-frame instead). */
async function pagePlusQuarter() {
  if (!S?.sheet || !S.isAdmin) return;
  const pages = S.board?.pages || [];
  const last = S.quarterFrame;
  let k;
  if (last && sameFrame(last.frame, frameState()) && pages.some(p => p.id === last.pid)) {
    k = pageIndexOf(last.pid) + 1;
    if (k >= pages.length) {
      if (!await appendPageNoMove()) return;
      k = pageCount() - 1;
    }
  } else {
    k = visiblePageIndex();
  }
  frameQuarter(k);
}

function frameQuarter(k) {
  if (!S?.sheet) return;
  const ink = el('ink');
  const pw = S.sheet.pageW;
  const Wc = ink.width / pw, Hc = ink.height / pw;          // stage, in page-width units
  k = Math.max(0, Math.min(pageCount() - 1, k));
  const top = pageTop(k) - BOARD_H / 4;                     // last quarter of the page above
  const o = clampOriginY(top);
  const t = { o, s: 1, tx: 0, ty: 0 };
  if (lensActive()) {
    /* 1¼ page heights fill the stage (1.2× on a landscape screen, which
       shows 1½ at 100%), never wider than the page itself fits */
    t.s = Math.min(MAX_SCALE, Math.max(minScale(), Math.min(Hc / (BOARD_H * 1.25), Wc)));
    t.tx = (1 - t.s) * Wc / 2;                              // page centred across
    t.ty = Math.max(Hc * (1 - t.s), Math.min(0, -t.s * (top - o)));
  }
  const pid = (S.board?.pages || [])[k]?.id;
  animateView(t, SNAP_MS, () => {
    if (!S || !pid) return;
    S.quarterFrame = { pid, frame: frameState() };
    persistView();
    const changed = pid !== S.pageId;
    S.pageId = pid;
    const leads = S.coll !== 'whiteboards' ? S.isAdmin : isLeader();
    if (continuous()) publishView(true);
    else if (leads && changed) {
      boardsCol(S.classId, S.coll).doc(S.boardId).update({ activePageId: pid })
        .catch(e => console.warn('[whiteboard] page flip failed', e));
    }
    if (!leads) pauseFollowByHand();          // a follower device moved itself
    renderRail(); renderPagesBar(); renderToolbar(); renderTopbarRight();
  });
}

/** Tween the sheet scroll AND the lens together (one frame loop, all
 *  layers redrawn per frame). Registered as S.sheetAnim, so a scroll
 *  gesture cancels it and a resize retargets its scroll part. */
function animateView(t, ms, done) {
  const from = frameState();
  const anim = { from: from.o, to: t.o, centre: t.o + sheetViewH() / 2, dur: ms, t0: performance.now() };
  const lt0 = anim.t0;                                       // a resize resets t0; the lens keeps its own clock
  S.sheetAnim = anim;
  const step = (now) => {
    if (!S || S.sheetAnim !== anim) return;
    const k = Math.min(1, (now - anim.t0) / anim.dur), e = 1 - Math.pow(1 - k, 3);
    S.sheet.originY = anim.from + (anim.to - anim.from) * e;
    if (typeof t.ox === 'number') S.sheet.originX = from.ox + (t.ox - from.ox) * e;   // V3.841 — the plane pans in x too
    if (lensActive()) {
      const kl = Math.min(1, (now - lt0) / ms), el2 = 1 - Math.pow(1 - kl, 3);
      S.view.scale = from.s + (t.s - from.s) * el2;
      S.view.tx = from.tx + (t.tx - from.tx) * el2;
      S.view.ty = from.ty + (t.ty - from.ty) * el2;
    }
    redrawNow();
    if (k < 1) requestAnimationFrame(step);
    else { S.sheetAnim = null; if (done) done(); }
  };
  requestAnimationFrame(step);
}

function viewKey() { return `wb_view_${S?.classId}_${S?.boardId}`; }
function persistView() {
  if (!lensActive()) return;
  try { localStorage.setItem(viewKey(), JSON.stringify(S.view)); } catch (e) {}
  if (infinite() && S.sheet) { try { localStorage.setItem(originKey(), JSON.stringify({ x: round4(S.sheet.originX || 0), y: round4(S.sheet.originY) })); } catch (e) {} }
}
function restoreView() {
  if (!lensActive()) return;
  try {
    const raw = localStorage.getItem(viewKey());
    if (!raw) return;
    const v = JSON.parse(raw);
    if (typeof v?.scale === 'number' && isFinite(v.scale)) {
      S.view = { tx: +v.tx || 0, ty: +v.ty || 0,
                 scale: Math.min(MAX_SCALE, Math.max(minScale(), v.scale)) };
      clampView();
    }
  } catch (e) {}
}

/** Touch gestures + wheel + keys on the stage. No pen/touch arbitration
 *  is needed: inksHere() already excludes pointerType 'touch', so ink and
 *  gestures are disjoint input classes by construction — except on a phone
 *  in the pen / highlighter / eraser modes (V3.863), where one finger draws
 *  and a second finger takes that stroke back (cancelTouchInk) and pinches.
 *
 *  V3.730 gesture rules (decisions 10–11 of the plan):
 *   - two fingers: PINCH zooms the viewer-local lens; a two-finger DRAG at
 *     100 % scrolls the sheet and snaps to the nearest page on release;
 *     a two-finger drag while zoomed pans the lens. Which one a gesture is
 *     gets decided once, from the first clear movement, and then locked.
 *   - one finger: ignored for the drawer (palm rejection); scrolls the
 *     sheet for viewers (they have no pen); pans when zoomed in.
 *   - wheel: scrolls the sheet (snaps after 150 ms quiet); ⌘/ctrl-wheel
 *     zooms; while zoomed, plain wheel pans the lens.
 *  Pages mode shares only the settled page (activePageId), so the room
 *  never sees a half-scrolled sheet. V3.801 continuous mode (the default)
 *  never snaps: the leader's scroll is shared as it happens (viewY), and a
 *  follower who scrolls by hand pauses following. V3.804: zoomed in, a pan
 *  that runs past the lens edge carries on as a sheet scroll (panBy). */
function bindLensHandlers() {
  const stage = el('stage');
  if (!stage) return;
  const pts = new Map();
  let g = null;                      // current gesture

  const pageWcss = () => S.sheet ? S.sheet.pageW / Math.max(1, el('ink').width / el('ink').clientWidth) : 1;
  /* canvas-relative position in page-width units */
  const norm = (x, y) => {
    const r = el('board').getBoundingClientRect();
    const pw = pageWcss();
    return { x: (x - r.left) / pw, y: (y - r.top) / pw };
  };
  const mid = () => {
    const [a, b] = [...pts.values()];
    return { x: (a.x + b.x) / 2, y: (a.y + b.y) / 2, d: Math.hypot(a.x - b.x, a.y - b.y) };
  };
  const scrollBy = (dyCss) => {
    if (!S.sheet) return;
    if (infinite()) { scrollPlaneBy(0, dyCss); return; }
    S.sheetAnim = null;
    /* small overscroll past the end pages, so the gesture feels attached */
    const lo = originYForPage(0) - 0.15, hi = originYForPage(pageCount() - 1) + 0.15;
    S.sheet.originY = Math.min(hi, Math.max(lo, S.sheet.originY - dyCss / pageWcss()));
    /* V3.801 — continuous: a follower scrolling by hand stops tracking;
       the leader shares the scroll as it happens */
    if (continuous()) { pauseFollowByHand(); trackPageUnderCentre(); publishView(false); }
    scheduleRedraw();
  };
  /* V3.804 — pan the zoomed lens. In continuous mode whatever the lens
     cannot absorb at its edge carries on as a sheet scroll, so a zoomed
     lecture keeps moving down the sheet. `spill` is false for the drawer's
     single finger: that is a resting palm, and it must never scroll the
     room. Returns whether anything spilled into the sheet. */
  const panBy = (dxCss, dyCss, spill) => {
    if (infinite()) { scrollPlaneBy(dxCss, dyCss); return false; }   // V3.841 — a lens pan IS a plane scroll
    const pw = pageWcss();
    const v = S.view;
    v.tx += dxCss / pw;
    const want = v.ty + dyCss / pw;
    v.ty = want;
    clampView();
    let spilled = false;
    if (spill && continuous()) {
      const left = (want - v.ty) * pw;        // screen CSS px the lens could not take
      if (Math.abs(left) > 0.01) { scrollBy(left / v.scale); spilled = true; }
    }
    scheduleRedraw();
    return spilled;
  };
  /* gesture over: pages mode snaps to the nearest page; continuous mode
     stays exactly where it was let go */
  const snap = () => {
    if (continuous()) { settleScroll(); return; }
    setActivePage((S.board?.pages || [])[nearestPageToView()]?.id || S.pageId, true);
  };

  const onDown = (e) => {
    if (e.pointerType !== 'touch' || !S) return;
    pts.set(e.pointerId, { x: e.clientX, y: e.clientY });
    if (pts.size === 2) {
      const m = mid();
      g = { fingers: 2, mode: null, d0: m.d, x0: m.x, y0: m.y, lastX: m.x, lastY: m.y,
            scale0: S.view.scale, tx0: S.view.tx, ty0: S.view.ty };
    } else if (pts.size === 1) {
      /* the drawer's single finger is a resting hand, not a gesture */
      /* V3.863 — in Pan (and on the empty board in Cards) one finger moves the board for the drawer too */
      const handPans = S.isAdmin && (S.tool === 'pan' || S.tool === 'card');
      const wantsScroll = (!S.isAdmin || handPans) && (S.view.scale <= 1 || infinite());
      const wantsPan = S.view.scale > 1 && !infinite();
      g = (wantsScroll || wantsPan)
        ? { fingers: 1, mode: wantsPan ? 'pan' : 'scroll', lastX: e.clientX, lastY: e.clientY }
        : null;
    }
  };
  const onMove = (e) => {
    if (e.pointerType !== 'touch' || !pts.has(e.pointerId) || !g || g.ended || !S) return;
    pts.set(e.pointerId, { x: e.clientX, y: e.clientY });
    if (g.fingers === 2 && pts.size === 2) {
      const m = mid();
      if (!g.mode) {
        const ratio = m.d / Math.max(1, g.d0);
        if (Math.abs(ratio - 1) > 0.08) g.mode = 'pinch';
        else if (Math.hypot(m.x - g.x0, m.y - g.y0) > 10) g.mode = S.view.scale > 1 ? 'pan' : 'scroll';
        else return;
      }
      if (g.mode === 'pinch') {
        const c = norm(m.x, m.y);
        zoomAt((g.scale0 * (m.d / Math.max(1, g.d0))) / S.view.scale, c.x, c.y);
      } else if (g.mode === 'pan') {
        if (panBy(m.x - g.lastX, m.y - g.lastY, true)) g.spilled = true;
      } else if (infinite()) {
        scrollPlaneBy(m.x - g.lastX, m.y - g.lastY);
      } else {
        scrollBy(m.y - g.lastY);
      }
      g.lastX = m.x; g.lastY = m.y;
      return;
    }
    if (g.fingers === 1 && pts.size === 1) {
      if (g.mode === 'pan') {
        if (panBy(e.clientX - g.lastX, e.clientY - g.lastY, !S.isAdmin)) g.spilled = true;
      } else if (g.mode === 'scroll') {
        if (infinite()) scrollPlaneBy(e.clientX - g.lastX, e.clientY - g.lastY); else scrollBy(e.clientY - g.lastY);
      }
      g.lastX = e.clientX; g.lastY = e.clientY;
    }
  };
  const onUp = (e) => {
    if (!pts.has(e.pointerId)) return;
    pts.delete(e.pointerId);
    if (pts.size === 0) {
      const mode = g?.mode, spilled = !!g?.spilled;
      g = null;
      persistView();
      if (mode === 'scroll' || spilled) snap();
    } else if (g && g.fingers === 2) {
      /* one finger lifted mid-gesture: the gesture is over (remember its
         mode for the snap on the last lift), and nothing new starts */
      g = { fingers: 2, mode: g.mode, spilled: g.spilled, ended: true };
    }
  };

  const onWheel = (e) => {
    if (!S) return;
    e.preventDefault();
    const c = norm(e.clientX, e.clientY);
    if (e.ctrlKey || e.metaKey) { zoomAt(Math.pow(1.0015, -e.deltaY), c.x, c.y); persistView(); return; }
    if (infinite()) {
      scrollPlaneBy(-e.deltaX, -e.deltaY);
      clearTimeout(S.snapTimer);
      S.snapTimer = setTimeout(() => { if (S) snap(); }, 150);
      return;
    }
    if (S.view.scale > 1) {
      if (panBy(-e.deltaX, -e.deltaY, true)) {
        clearTimeout(S.snapTimer);
        S.snapTimer = setTimeout(() => { if (S) snap(); }, 150);
      }
      return;
    }
    scrollBy(-e.deltaY);
    clearTimeout(S.snapTimer);
    S.snapTimer = setTimeout(() => { if (S) snap(); }, 150);
  };

  stage.addEventListener('pointerdown', onDown);
  stage.addEventListener('pointermove', onMove);
  stage.addEventListener('pointerup', onUp);
  stage.addEventListener('pointercancel', onUp);
  stage.addEventListener('wheel', onWheel, { passive: false });
  S.lensCleanup = () => {
    stage.removeEventListener('pointerdown', onDown);
    stage.removeEventListener('pointermove', onMove);
    stage.removeEventListener('pointerup', onUp);
    stage.removeEventListener('pointercancel', onUp);
    stage.removeEventListener('wheel', onWheel);
  };
  updateZoomLabel();
}

/** ↑/↓ and PageUp/PageDown snap between pages. Document-level, so it
 *  works without focusing the board; ignored while typing. */
function bindKeyHandler() {
  if (!S) return;
  S.keyHandler = (e) => {
    if (!S || e.defaultPrevented) return;
    const t = e.target;
    if (t && (t.tagName === 'INPUT' || t.tagName === 'TEXTAREA' || t.tagName === 'SELECT' || t.isContentEditable)) return;
    if (e.key === 'Escape' && isMaximized()) { e.preventDefault(); setMaximized(false); return; }
    let d = 0;
    if (e.key === 'ArrowDown' || e.key === 'PageDown') d = 1;
    else if (e.key === 'ArrowUp' || e.key === 'PageUp') d = -1;
    if (!d) return;
    if (infinite()) { e.preventDefault(); scrollPlaneBy(0, -d * (el('ink')?.clientHeight || 400) / 2); persistView(); return; }   // V3.841 — half a view
    const pages = S.board?.pages || [];
    const i = Math.max(0, Math.min(pages.length - 1, pageIndexOf(S.pageId) + d));
    if (pages[i] && pages[i].id !== S.pageId) { e.preventDefault(); setActivePage(pages[i].id, true); }
  };
  document.addEventListener('keydown', S.keyHandler);
}

/* ================================================================
   SIMULATION PAGES (V3.736) — a learning-module section, live, as a page
   ================================================================
   pages[i] = { id, kind:'sim', sim:{ ref:'1.2.1', src, title, moduleTitle } }
   `ref` is module.tab.section: the module is the Nth lesson in the class's
   Learning Modules list (a file named `0N-…` wins the tie), tab.section is
   the module's own h2[data-nav="T.S"] numbering. The module opens with
   ?embed=T.S (whiteboard-panel.js) showing just that block at SIM_W×SIM_H;
   the iframe element is scaled to the page rect here. Iframes exist only
   for the centred page and its neighbours, and the DOM is updated in place
   (never rebuilt) so scrolling and zooming cannot reload a running sim.
   ================================================================ */
function simPages() {
  return (S?.board?.pages || []).map((p, i) => ({ p, i })).filter(x => x.p.kind === 'sim' && x.p.sim?.src);
}
function renderSims() {
  if (!S || !S.sheet) return;
  const layer = el('sims');
  const ink = el('ink');
  if (!layer || !ink) return;
  const dpr = ink.width / Math.max(1, ink.clientWidth);
  const pw = S.sheet.pageW / dpr, ph = BOARD_H * pw;
  const v = lensActive() ? S.view : { tx: 0, ty: 0, scale: 1 };
  layer.style.transform = `translate(${v.tx * pw}px, ${v.ty * pw}px) scale(${v.scale})`;
  layer.style.transformOrigin = '0 0';
  el('root')?.classList.toggle('wb-annotate', !!S.annotate);
  const centre = nearestPageToView();
  const wanted = new Map();
  simPages().forEach(({ p, i }) => { if (Math.abs(i - centre) <= 1) wanted.set(p.id, { p, i }); });
  /* remove frames for pages that scrolled away or were deleted */
  [...layer.children].forEach(node => { if (!wanted.has(node.dataset.pageId)) node.remove(); });
  wanted.forEach(({ p, i }, pid) => {
    let node = layer.querySelector(`.wb-sim[data-page-id="${pid}"]`);
    if (!node) {
      node = document.createElement('div');
      node.className = 'wb-sim';
      node.dataset.pageId = pid;
      node.innerHTML = `<iframe src="${escAttr(p.sim.src)}" title="${escAttr(p.sim.title || 'Simulation')}" loading="lazy" allow="fullscreen"></iframe>
        <div class="wb-sim-cap" title="${escAttr(p.sim.ref || '')}">${ICON.svg('play')} ${esc(p.sim.title || 'Simulation')}${p.sim.mode === 'section' ? ' <span class="wb-sim-cap-mode">whole section</span>' : ''}</div>`;
      layer.appendChild(node);
    }
    const [x, y] = sheetToPx(0, pageTop(i));
    node.style.left = (x / dpr) + 'px';
    node.style.top = (y / dpr) + 'px';
    node.style.width = pw + 'px';
    node.style.height = ph + 'px';
    const f = node.firstElementChild;
    f.style.transform = `scale(${pw / SIM_W})`;
  });
}

/** Lessons in the class's Learning Modules sections, in the order the
 *  class page lists them (section order, then each module's order). */
function classLessonsOrdered() {
  const sched = S?.schedule || {};
  const secOrder = [];
  (sched.tabs || []).forEach(t => (t.sections || []).forEach(sec => { if (sec.key === 'modules') secOrder.push(sec.id); }));
  const rank = m => { const i = secOrder.indexOf(m.sectionId); return (i < 0 ? 999 : i) * 1000 + (m.order ?? 0); };
  return (sched.modules || []).filter(m => (m.kind || 'module') === 'module').sort((a, b) => rank(a) - rank(b));
}
/* ─── Simulation picker (V3.776) ───────────────────────────────
   Three dropdowns — module (number + name), tab (number + name), section
   (number + name) — instead of a typed "1.2.1". Each module's catalogue is
   parsed ONCE from its own HTML (same origin, force-cache) and kept for the
   page's lifetime. Tab numbers come from the sections' data-nav (module 01
   starts at tab 1, 04c at tab 0), tab names from the module's .tab-btn
   labels, section names from h2[data-title]. The final add still goes
   through resolveSimRef, so the two paths cannot disagree. */
const SIM_CATALOGS = new Map();   // module file → Promise<catalog>

/** Pure: module HTML → { title, tabs:[{n,label}], sections:[{tab,sec,title,hasCanvas}] } | { error } */
function parseModuleCatalog(html, lesson) {
  if (!/whiteboard-panel\.js/.test(html)) return { error: `Module ${lesson.htmlFile} cannot be embedded yet (it does not load the whiteboard panel script).` };
  const title = decodeEntities(((/<title>([^<]*)<\/title>/i.exec(html) || [])[1] || lesson.title || lesson.htmlFile).replace(/\s*\(.*$/, '').trim());
  const tabLabels = new Map();
  for (const m of html.matchAll(/<button[^>]*class="[^"]*\btab-btn\b[^"]*"[^>]*>([\s\S]*?)<\/button>/gi)) {
    const txt = decodeEntities(m[1].replace(/<[^>]+>/g, '')).replace(/\s+/g, ' ').trim();
    const n = /^(\d+)\s*[.:]/.exec(txt);
    if (n && !tabLabels.has(Number(n[1]))) tabLabels.set(Number(n[1]), txt);
  }
  const heads = [];
  const re = /<h2[^>]*data-nav="(\d+)\.(\d+)"[^>]*>/gi;
  let m;
  while ((m = re.exec(html))) heads.push({ tab: Number(m[1]), sec: Number(m[2]), idx: m.index, end: m.index + m[0].length, tag: m[0] });
  const sections = heads.map((h, i) => {
    const seg = html.slice(h.end, i + 1 < heads.length ? heads[i + 1].idx : undefined);
    const t = (/data-title="([^"]*)"/.exec(h.tag) || [])[1] || `${h.tab}.${h.sec}`;
    return { tab: h.tab, sec: h.sec, title: decodeEntities(t), hasCanvas: /<canvas/i.test(seg) };
  });
  const tabs = [...new Set(sections.map(s => s.tab))].sort((a, b) => a - b).map(n => ({ n, label: tabLabels.get(n) || `Tab ${n}` }));
  return { title, tabs, sections };
}
function moduleCatalog(lesson) {
  const folder = lesson.folder || S?.classId || '';
  const file = `/modules/${encodeURIComponent(folder)}/${encodeURIComponent(lesson.htmlFile)}`;
  if (!SIM_CATALOGS.has(file)) {
    SIM_CATALOGS.set(file, (async () => {
      try {
        const r = await fetch(file, { cache: 'force-cache' });
        if (!r.ok) throw new Error(r.status);
        return parseModuleCatalog(await r.text(), lesson);
      } catch (e) { SIM_CATALOGS.delete(file); return { error: `Could not open ${lesson.htmlFile}.` }; }
    })());
  }
  return SIM_CATALOGS.get(file);
}
/** The class's lessons with the module number the resolver would give them. */
function simLessons() {
  const lessons = classLessonsOrdered();
  const numbered = lessons.some(l => /^\d/.test(l.htmlFile || ''));
  return lessons.map((l, i) => {
    const m = /^0*(\d+)[a-z]?[-_.]/.exec(l.htmlFile || '');
    const n = m ? Number(m[1]) : (numbered ? null : i + 1);
    if (!n) return null;
    const name = (l.title || l.htmlFile || '').replace(/\s*\(.*$/, '').trim();
    return { n, lesson: l, label: `${n} — ${name}` };
  }).filter(Boolean);
}
function wireSimForm(bar) {
  const form = bar.querySelector('[data-wb-sim-form]');
  const picks = bar.querySelector('[data-wb-sim-picks]');
  if (!form || !picks) return;
  picks.addEventListener('change', (e) => {
    const s = e.target.closest('select[data-wb-sim-pick]');
    if (!s || !S) return;
    const sel = S.simSel || (S.simSel = {});
    const k = s.dataset.wbSimPick;
    sel[k] = Number(s.value);
    if (k === 'module') { sel.tab = undefined; sel.sec = undefined; }
    if (k === 'tab') sel.sec = undefined;
    renderSimForm();
  });
  form.addEventListener('submit', async (e) => {
    e.preventDefault();
    if (!S) return;
    const sel = S.simSel || {};
    const status = form.querySelector('[data-wb-sim-status]');
    if (!(sel.module && Number.isFinite(sel.tab) && Number.isFinite(sel.sec))) {
      if (status) { status.textContent = 'Pick a module, a tab and a section first.'; status.classList.add('wb-field-err'); }
      return;
    }
    const r = await resolveSimRef(`${sel.module}.${sel.tab}.${sel.sec}`, S.simMode);
    if (!S) return;
    if (r.error) { S.simStatus = r.error; if (status) { status.textContent = r.error; status.classList.add('wb-field-err'); } return; }
    S.simFormOpen = false; S.simStatus = '';
    await addSimPage(r);
  });
  if (S?.simFormOpen) renderSimForm();
}
/** Fill the three selects from state; fetches the module's catalogue on demand. */
async function renderSimForm() {
  if (!S) return;
  const bar = el('toolbar');
  const picks = bar?.querySelector('[data-wb-sim-picks]');
  const status = bar?.querySelector('[data-wb-sim-status]');
  const addBtn = bar?.querySelector('[data-wb-sim-add]');
  if (!picks) return;
  const say = (msg, err) => { if (status) { status.textContent = msg; status.classList.toggle('wb-field-err', !!err); } if (addBtn) addBtn.disabled = true; };
  const opt = (v, label, selected) => `<option value="${escAttr(String(v))}"${selected ? ' selected' : ''}>${esc(label)}</option>`;
  const pick = (k, label, inner, disabled) =>
    `<label class="wb-bg-label muted-text">${label} <select class="wb-bg-select wb-sim-select" data-wb-sim-pick="${k}"${disabled ? ' disabled' : ''}>${inner}</select></label>`;
  const mods = simLessons();
  if (!mods.length) { picks.innerHTML = ''; say('This class has no learning modules listed yet.', true); return; }
  const sel = S.simSel || (S.simSel = {});
  if (!mods.some(m => m.n === sel.module)) {
    /* default: the module of the page being viewed if it is a simulation, else the newest lesson */
    const cur = currentPage();
    const fromPage = cur?.kind === 'sim' ? Number((cur.sim?.ref || '').split('.')[0]) : NaN;
    sel.module = mods.some(m => m.n === fromPage) ? fromPage : mods[mods.length - 1].n;
    sel.tab = undefined; sel.sec = undefined;
  }
  const mod = mods.find(m => m.n === sel.module);
  const mode = S.simMode || 'sim';
  const moduleSel = pick('module', 'Module', mods.map(m => opt(m.n, m.label, m.n === sel.module)));
  picks.innerHTML = moduleSel + pick('tab', 'Tab', opt('', 'Loading…'), true) + pick('sec', 'Section', opt('', '…'), true);
  say('Reading the module…');
  const cat = await moduleCatalog(mod.lesson);
  if (!S || !picks.isConnected || S.simSel !== sel || sel.module !== mod.n) return;   // torn down or changed meanwhile
  if (cat.error) { picks.innerHTML = moduleSel; say(cat.error, true); return; }
  const eligible = cat.sections.filter(s => mode === 'section' || s.hasCanvas);
  const tabs = cat.tabs.filter(t => eligible.some(s => s.tab === t.n));
  if (!tabs.length) { picks.innerHTML = moduleSel; say(mode === 'sim' ? `Module ${mod.n} has no simulations — try "Whole section".` : `Module ${mod.n} has no sections.`, true); return; }
  if (!tabs.some(t => t.n === sel.tab)) { sel.tab = tabs[0].n; sel.sec = undefined; }
  const secs = eligible.filter(s => s.tab === sel.tab);
  if (!secs.some(s => s.sec === sel.sec)) sel.sec = secs[0].sec;
  const tab = tabs.find(t => t.n === sel.tab), sec = secs.find(s => s.sec === sel.sec);
  picks.innerHTML = moduleSel
    + pick('tab', 'Tab', tabs.map(t => opt(t.n, t.label, t.n === sel.tab)))
    + pick('sec', 'Section', secs.map(s => opt(s.sec, `${s.tab}.${s.sec} · ${s.title}`, s.sec === sel.sec)));
  if (status) {
    status.textContent = `${mode === 'sim' ? 'Simulation' : 'Section'} ${mod.n}.${sel.tab}.${sel.sec} · ${cat.title} · ${tab.label} · ${sec.title}`;
    status.classList.remove('wb-field-err');
  }
  if (addBtn) addBtn.disabled = false;
}

/** "1.2.1" → { module, tab, sec, file, src } or an error string. The
 *  section is verified against the module's own HTML (same origin). */
async function resolveSimRef(ref, mode) {
  mode = mode === 'section' ? 'section' : 'sim';
  const m = /^\s*(\d+)\s*[.\-\/]\s*(\d+)\s*[.\-\/]\s*(\d+)\s*$/.exec(ref || '');
  if (!m) return { error: 'Use module.tab.section — e.g. 1.2.1' };
  const [n, tab, sec] = [Number(m[1]), Number(m[2]), Number(m[3])];
  const lessons = classLessonsOrdered();
  if (!lessons.length) return { error: 'This class has no learning modules listed yet.' };
  /* V3.774 — a letter suffix keeps the module number: 04c-… is module 4 */
  const byPrefix = lessons.find(l => new RegExp('^0*' + n + '[a-z]?[-_.]').test(l.htmlFile || ''));
  /* V3.775 — the ordinal fallback (`lessons[n-1]`) picked the WRONG module in
     class: 4.0.1 came back as module 03's simulation because the pretest
     counted as lesson 1 and 04c was not on the class's list yet. Ordinal only
     when no listed lesson carries a number; otherwise say what is missing. */
  const numbered = lessons.some(l => /^\d/.test(l.htmlFile || ''));
  const lesson = byPrefix || (numbered ? null : lessons[n - 1]);
  if (!lesson) {
    const have = lessons.map(l => (/^0*(\d+)/.exec(l.htmlFile || '') || [])[1]).filter(Boolean);
    return { error: numbered
      ? `Module ${n} is not in this class's Learning Modules list (listed: ${have.join(', ') || 'none'}). Add it on the class page first.`
      : `There is no module ${n} (the class lists ${lessons.length}).` };
  }
  const folder = lesson.folder || S.classId;
  const file = `/modules/${encodeURIComponent(folder)}/${encodeURIComponent(lesson.htmlFile)}`;
  let html = '';
  try { const r = await fetch(file, { cache: 'force-cache' }); if (!r.ok) throw new Error(r.status); html = await r.text(); }
  catch (e) { return { error: `Could not open module ${n} (${lesson.htmlFile}).` }; }
  if (!/whiteboard-panel\.js/.test(html)) return { error: `Module ${n} cannot be embedded yet (it does not load the whiteboard panel script).` };
  const h2 = new RegExp(`<h2[^>]*data-nav="${tab}\\.${sec}"[^>]*>`, 'i').exec(html);
  if (!h2) return { error: `Module ${n} has no section ${tab}.${sec}.` };
  /* V3.737 — simulation only: the section must actually contain one */
  if (mode === 'sim') {
    const rest = html.slice(h2.index + h2[0].length);
    const next = rest.search(/<h2[^>]*data-nav=/i);
    const seg = next < 0 ? rest : rest.slice(0, next);
    if (!/<canvas/i.test(seg)) return { error: `Section ${tab}.${sec} has no simulation — add it as a whole section instead.` };
  }
  const title = (/data-title="([^"]*)"/.exec(h2[0]) || [])[1] || `${tab}.${sec}`;
  const moduleTitle = ((/<title>([^<]*)<\/title>/i.exec(html) || [])[1] || lesson.title || lesson.htmlFile).replace(/\s*\(.*$/, '').trim();
  return {
    module: n, tab, sec, lesson, mode,
    src: `${file}?embed=${tab}.${sec}${mode === 'sim' ? '&sim=1' : ''}&class=${encodeURIComponent(S.classId)}`,
    /* the standalone file this simulation also lives at (generated) */
    standalone: mode === 'sim' ? `/modules/${encodeURIComponent(folder)}/simulations/${n}.${tab}.${sec}.html` : null,
    title: `${tab}.${sec} · ${decodeEntities(title)}`,
    moduleTitle: decodeEntities(moduleTitle)
  };
}
function decodeEntities(str) {
  const t = document.createElement('textarea'); t.innerHTML = str || ''; return t.value;
}

/** Append a simulation page (admin) and snap to it. */
async function addSimPage(resolved) {
  if (!S || !S.isAdmin) return;
  const pid = newId('p');
  const page = { id: pid, background: 'blank', kind: 'sim',
    sim: { ref: `${resolved.module}.${resolved.tab}.${resolved.sec}`, src: resolved.src, title: resolved.title,
           moduleTitle: resolved.moduleTitle, mode: resolved.mode || 'sim', standalone: resolved.standalone || null } };
  const pages = [...(S.board?.pages || []), page];
  const leads = S.coll !== 'whiteboards' ? true : isLeader();
  S.board = { ...(S.board || {}), pages, activePageId: leads ? pid : S.board?.activePageId };
  S.pageId = pid;
  if (!leads) S.follow = false;
  recEvent('add-page', { pageId: pid, background: 'blank', kind: 'sim', sim: page.sim });
  if (leads) recEvent('page', { pageId: pid });
  renderRail(); renderPagesBar(); renderToolbar();
  centreOn(pages.length - 1, true);
  try {
    const upd = { pages, updatedAt: FV().serverTimestamp() };
    if (leads) upd.activePageId = pid;
    await boardsCol(S.classId, S.coll).doc(S.boardId).update(upd);
    toast(`Added ${page.sim.title} as page ${pages.length}.`);
  } catch (e) { console.warn('[whiteboard] add sim page failed', e); toast('Could not add the simulation page.'); }
}

/* ─── Page management (V3.739) ─────────────────────────────── */
/** Swap the page with its neighbour. The view follows the moved page. */
async function movePage(pid, dir) {
  if (!S || !S.isAdmin) return;
  const pages = [...(S.board?.pages || [])];
  const i = pages.findIndex(p => p.id === pid);
  const j = i + dir;
  if (i < 0 || j < 0 || j >= pages.length) return;
  [pages[i], pages[j]] = [pages[j], pages[i]];
  S.board = { ...(S.board || {}), pages };
  recEvent('move-page', { order: pages.map(p => p.id) });
  (S.board.pages || []).forEach(p => markThumb(p.id));
  renderRail(); renderPagesBar();
  centreOn(j, true);
  try {
    await boardsCol(S.classId, S.coll).doc(S.boardId).update({ pages, updatedAt: FV().serverTimestamp() });
  } catch (e) { console.warn('[whiteboard] move page failed', e); toast('Could not move the page.'); }
}

/** Remove a page and everything on it (ink soft-deleted while recording,
 *  so a replay still shows it up to this moment). Never the last page. */
async function deletePage(pid) {
  if (!S || !S.isAdmin) return;
  const pages = [...(S.board?.pages || [])];
  const i = pages.findIndex(p => p.id === pid);
  if (i < 0 || pages.length <= 1) return;
  pages.splice(i, 1);
  const strokeIds = [...S.strokes.entries()].filter(([, st]) => st.pageId === pid && !st.erasedAt).map(([id]) => id);
  const itemIds = [...S.items.entries()].filter(([, it]) => it.pageId === pid).map(([id]) => id);
  const nextIdx = Math.min(i, pages.length - 1);
  const leads = S.coll !== 'whiteboards' ? true : isLeader();
  const wasCurrent = S.pageId === pid;
  const nextPid = wasCurrent ? pages[nextIdx].id : S.pageId;
  S.board = { ...(S.board || {}), pages, activePageId: leads && S.board?.activePageId === pid ? nextPid : S.board?.activePageId };
  S.pageId = nextPid;
  recEvent('remove-page', { pageId: pid });
  if (leads && wasCurrent) recEvent('page', { pageId: nextPid });
  removeStrokes(strokeIds);
  itemIds.forEach(id => S.items.delete(id));
  (S.board.pages || []).forEach(p => markThumb(p.id));
  renderRail(); renderPagesBar(); renderToolbar();
  centreOn(pageIndexOf(S.pageId), true);
  try {
    const upd = { pages, updatedAt: FV().serverTimestamp() };
    if (leads && wasCurrent) upd.activePageId = nextPid;
    await boardsCol(S.classId, S.coll).doc(S.boardId).update(upd);
    if (itemIds.length) {
      const batch = db().batch();
      itemIds.forEach(id => batch.delete(boardsCol(S.classId, S.coll).doc(S.boardId).collection('items').doc(id)));
      await batch.commit();
    }
    toast(`Page ${i + 1} deleted.`);
  } catch (e) { console.warn('[whiteboard] delete page failed', e); toast('Could not delete the page.'); }
}

/* ================================================================
   IMAGE ITEMS (V3.684) — figures snapped from a learning module
   ================================================================ */
/* V3.833 — snap for arranged items: 1/80 of the page width (Gabe's 14 px
   grid on a ~1100 px paper). All item coordinates are page-width units. */
const WIDGET_GRID = 0.0125;
function snapU(v) { return round4(Math.round((v || 0) / WIDGET_GRID) * WIDGET_GRID); }

/* The items layers render INCREMENTALLY (V3.833): nodes are kept per item
   and only re-created when what they show changes, so a widget's editor
   survives the redraw that every scroll / zoom frame triggers. Positions
   are always re-applied. */
function itemSig(it, arrange) {
  if (it.type === 'region') return ['g', S?.isAdmin ? 1 : 0, reportSig(it)].join('\u0001');          // V3.842 · V3.854
  if (it.type === 'regionref') return ['r', S?.isAdmin ? 1 : 0].join('\u0001');
  if (it.type === 'widget') return ['w', it.kind || '', arrange ? 1 : 0, S?.isAdmin ? 1 : 0, reportSig(it)].join('\u0001');
  if (it.type === 'text') return ['t', it.text || '', it.cite || '', arrange ? 1 : 0].join('\u0001');
  return ['i', it.url || '', it.srcLabel || '', arrange ? 1 : 0].join('\u0001');
}
function dataSig(it) { try { return JSON.stringify(it.data === undefined ? null : it.data); } catch (e) { return 'x' + Date.now(); } }
function bodyMode() { return S?.replay ? 'r' : S?.isAdmin ? 'a' : 'v'; }

function renderItems() {
  if (!S || !S.sheet) return;
  const layer = el('itemsLayer');
  const wl = el('widgetsLayer') || layer;
  const ink = el('ink');
  if (!layer || !ink) return;
  const dpr = ink.width / Math.max(1, ink.clientWidth);
  const pw = S.sheet.pageW / dpr;                       // page width, CSS px
  /* The whole layer carries the lens as ONE css transform, so items and
     ink stay locked together at any zoom. Positions are sheet positions:
     every page's items render, offset by that page's top. */
  const v = lensActive() ? S.view : { tx: 0, ty: 0, scale: 1 };
  const tf = `translate(${v.tx * pw}px, ${v.ty * pw}px) scale(${v.scale})`;
  layer.style.transform = tf; layer.style.transformOrigin = '0 0';
  if (wl !== layer) { wl.style.transform = tf; wl.style.transformOrigin = '0 0'; }
  const arrange = !!(S.isAdmin && S.arrange);
  if (S.cardSel && !S.items.has(S.cardSel)) S.cardSel = null;   /* V3.863 — the chosen card was removed */
  const list = [...S.items.entries()].sort((a, b) => (a[1].z || 0) - (b[1].z || 0));
  const seen = new Set();
  /* V3.842 — a collapsed region hides its cards (and their wires) */
  const hiddenIds = new Set(); list.forEach(([rid, it]) => { if (it.type === 'region' && it.collapsed) regionMembers(rid, it).forEach(id => hiddenIds.add(id)); });
  list.forEach(([id, it], order) => {
    seen.add(id);
    const isW = it.type === 'widget', isG = it.type === 'region', isR = it.type === 'regionref';
    const host = (isW || isG || isR) ? wl : layer;
    const sig = itemSig(it, arrange);
    let node = S.itemNodes.get(id);
    if (node && (node.parentNode !== host || node.dataset.sig !== sig)) {
      if (isW && node.parentNode === host && node.dataset.kind === (it.kind || '')) { node.dataset.sig = sig; }
      else { node.remove(); node = null; S.itemNodes.delete(id); }
    }
    if (!node) {
      node = isG ? buildRegionNode(id, it) : isR ? buildRegionRefNode(id, it) : isW ? buildWidgetNode(id, it, arrange) : buildMediaNode(id, it, arrange);
      node.dataset.sig = sig;
      host.appendChild(node);
      S.itemNodes.set(id, node);
    }
    if (isW) { updateWidgetChrome(node, id, it, arrange); syncWidgetBody(node, id, it); }
    else if (isG) updateRegionChrome(node, id, it);
    else if (isR) { ensureRefSub(id, it); updateRegionRefChrome(node, id, it); }
    placeItemNode(node, it, pw, dpr);
    node.style.zIndex = isG ? '1' : String(10 + order);
    node.hidden = !isG && hiddenIds.has(id);
    node.classList.toggle('wb-card-sel', S.cardSel === id);   /* V3.863 */
  });
  S.itemNodes.forEach((node, id) => { if (!seen.has(id)) { node.remove(); S.itemNodes.delete(id); dropRefSub(id); } });
  if (S.sheetId && !S.items.has(S.sheetId)) closeItemSheet();   /* V3.852 */
  /* a text card's aspect is only known once laid out: remember it for the
     export and the drag maths (never written to the doc) */
  layer.querySelectorAll('.wb-item-text').forEach(node => {
    const it = S.items.get(node.dataset.itemId);
    const w = node.offsetWidth, h = node.offsetHeight;
    if (it && w > 0 && h > 0) it._ar = w / h;
  });
  if (S.wiresEnabled && S.wires.size) { renderWires(); if (!S._wireSettle) { S._wireSettle = setTimeout(() => { if (S) { S._wireSettle = null; renderWires(); } }, 350); } }
  scheduleGrow();
  scheduleRegionFit();
}
/* V3.839 — a card scales as a whole: its text follows √(width / default),
   so dragging the corner grip grows or shrinks the card, never below 75 % */
function widgetScale(it) { return Math.min(1.6, Math.max(0.75, Math.sqrt((it.w || 0.42) / 0.42))); }
function placeItemNode(node, it, pw, dpr) {
  const w = (it.w || 0.4) * pw;
  const [x, y] = sheetToPx(it.x || 0, pageTop(pageIndexOf(it.pageId)) + (it.y || 0));
  node.style.left = (x / dpr) + 'px'; node.style.top = (y / dpr) + 'px'; node.style.width = w + 'px';
  if (it.type === 'text') node.style.fontSize = Math.max(8, pw * 0.017) + 'px';
  else if (it.type === 'widget') node.style.fontSize = Math.max(9, pw * 0.0155 * widgetScale(it)) + 'px';
  else if (it.type === 'region') { node.style.fontSize = Math.max(9, pw * 0.0155) + 'px'; node.style.height = it.collapsed ? 'auto' : ((it.h || 0.3) * pw) + 'px'; }   // V3.842
  else if (it.type === 'regionref') node.style.fontSize = Math.max(9, pw * 0.0155 * widgetScale(it)) + 'px';
  else node.style.height = (w / (it.ar || 1.6)) + 'px';
}
/* V3.854 — the ✓ at the top-left of a card / region. Rendered only when the
   host passed opts.report; FILLED once the card is linked to a My Week step
   (item.myweek[] = [{itemId, title, date}], written by the host after the
   report). Its own pointerdown never reaches the item layer, so a tap is a
   tap — no drag, no phone sheet — in every mode. */
function reportRefs(it) { return Array.isArray(it.myweek) ? it.myweek.filter(Boolean) : []; }
function reportTip(it) {
  const refs = reportRefs(it);
  return refs.length ? 'Result of: ' + refs.map(r => r.title || r.itemId).join(' · ') + ' — tap to report it to another step'
                     : 'Report this as the result of a My Week step';
}
function reportBtnHTML(it, cls) {
  if (!S?.report) return '';
  const on = reportRefs(it).length > 0, tip = reportTip(it);
  return `<button type="button" class="${cls} wb-report${on ? ' wb-report-on' : ''}" data-wb-report title="${escAttr(tip)}" aria-label="${escAttr(tip)}" aria-pressed="${on ? 'true' : 'false'}">✓</button>`;
}
/* A kept node (the renderer refreshes a widget's signature instead of
   rebuilding it, so its editor survives) gets its ✓ synced in place. */
function syncReportBtn(node, it) {
  const b = node.querySelector(':scope > .wb-wh > [data-wb-report], :scope > .wb-rh > [data-wb-report]'); if (!b) return;
  const on = reportRefs(it).length > 0, tip = reportTip(it);
  b.classList.toggle('wb-report-on', on);
  b.setAttribute('aria-pressed', on ? 'true' : 'false');
  if (b.title !== tip) { b.title = tip; b.setAttribute('aria-label', tip); }
}
function wireReportBtn(node, id) {
  const b = node.querySelector('[data-wb-report]'); if (!b) return;
  b.addEventListener('pointerdown', (e) => e.stopPropagation());
  b.addEventListener('click', (e) => {
    e.stopPropagation(); e.preventDefault();
    const cur = S?.items.get(id); if (!cur || !S.report) return;
    try { S.report.onReport(Object.assign({ id }, cur), b, widgetApi(id)); } catch (err) { console.warn('[whiteboard] report failed', err); }
  });
}
function reportSig(it) {
  if (!S?.report) return '';
  return Array.isArray(it.myweek) ? it.myweek.map(r => r && r.itemId).join(',') : '';
}
function arrangeToolsHTML(arrange) {
  return arrange
    ? `<button type="button" class="wb-item-del" data-wb-item-del title="Remove from the board">×</button>
       <span class="wb-item-resize" data-wb-item-resize title="Drag to resize"></span>` : '';
}
function buildMediaNode(id, it, arrange) {
  const node = document.createElement('div');
  node.dataset.itemId = id;
  if (it.type === 'text') {
    /* V3.830 — a passage of text from a paper: a note card under the ink,
       sized by the page like everything else (font = 1.7 % of the page
       width), its height from its own content */
    node.className = 'wb-item wb-item-text';
    node.innerHTML = `<div class="wb-item-quote">${esc(it.text || '')}</div>${it.cite ? `<div class="wb-item-cite">${esc(it.cite)}</div>` : ''}${arrangeToolsHTML(arrange)}`;
  } else {
    node.className = 'wb-item';
    node.innerHTML = `<img src="${escAttr(it.url || '')}" alt="${escAttr(it.srcLabel || 'Snapped figure')}" draggable="false" />${arrangeToolsHTML(arrange)}`;
  }
  return node;
}

/* ─── V3.833 widget cards ─────────────────────────────────────────── */
function widgetMeta(it) {
  let m = null;
  if (S?.widgets?.meta) { try { m = S.widgets.meta(it.kind) || null; } catch (e) { m = null; } }
  return { label: (m && m.label) || it.kindLabel || it.kind || 'Widget', glyph: (m && m.glyph) || '' };
}
/* V3.861 — a host's icon value (its tools, its inserts): an ICON name → the icon; a text symbol or markup → as given */
function hostIcon(v) { v = String(v == null ? '' : v); return (/^[a-z][a-z0-9-]{1,40}$/.test(v) && window.ICON) ? ICON.render(v) : v; }
function widgetSummary(it) {
  if (S?.widgets?.summary) { try { const s = S.widgets.summary(it); if (s != null) return String(s); } catch (e) {} }
  return String(it.summary || it.text || '');
}
function stampMs(it) {
  if (typeof it.stampAt === 'number') return it.stampAt;
  const c = it.createdAt;
  if (c && typeof c.toMillis === 'function') return c.toMillis();
  if (typeof c === 'number') return c;
  return 0;
}
function fmtStampShort(it) {
  const ms = stampMs(it);
  if (!ms) return '';
  try { return new Date(ms).toLocaleString(undefined, { day: 'numeric', month: 'short', hour: 'numeric', minute: '2-digit' }); } catch (e) { return ''; }
}
function buildWidgetNode(id, it, arrange) {
  const node = document.createElement('div');
  node.dataset.itemId = id; node.dataset.kind = it.kind || '';
  node.className = 'wb-item wb-item-widget wb-wk-' + (it.kind || 'x').replace(/[^a-z0-9_-]/gi, '');
  const canEdit = !!S?.isAdmin;
  const ports = (canEdit && S.wiresEnabled) ? ['n', 'e', 's', 'w'].map(k => `<span class="wb-wport wb-wport-${k}" data-wb-port="${k}" title="Drag to connect"></span>`).join('') : '';
  node.innerHTML = `
    <div class="wb-wh" data-wb-whead>
      ${reportBtnHTML(it, 'wb-wreport')}
      ${canEdit ? '<span class="wb-wgrab" aria-hidden="true">⋮⋮</span>' : ''}
      <button type="button" class="wb-wchev" data-wb-wcollapse title="Collapse / expand">▾</button>
      <span class="wb-wkind"></span>
      <input type="text" class="wb-wtitle" placeholder="Title" ${canEdit ? '' : 'readonly'}>
      <span class="wb-wsum"></span>
      <span class="wb-wstamp"></span>
      ${canEdit && isNotebook() ? '<button type="button" class="wb-wtint" data-wb-wtint title="Colour this card" aria-label="Colour this card"></button>' : ''}
      ${canEdit && S.widgets?.onMenu ? '<button type="button" class="wb-wmore" data-wb-wmenu title="More">⋯</button>' : ''}
    </div>
    <div class="wb-wb" data-wb-wbody></div>
    ${canEdit && isNotebook() ? '<span class="wb-wgrip" data-wb-wgrip title="Drag to resize the card"></span>' : ''}
    ${ports}
    ${arrangeToolsHTML(arrange)}`;
  /* V3.839 — the colour dot opens a small palette on the card */
  const tint = node.querySelector('[data-wb-wtint]');
  if (tint) tint.addEventListener('click', (e) => { e.stopPropagation(); toggleTintPop(node, id); });
  node.querySelector('[data-wb-wcollapse]').addEventListener('click', (e) => {
    e.stopPropagation();
    if (!S?.isAdmin) return;
    const cur = S.items.get(id); if (cur) updateItem(id, { collapsed: !cur.collapsed });
  });
  const title = node.querySelector('.wb-wtitle');
  title.addEventListener('change', () => { if (S?.isAdmin) updateItem(id, { title: title.value.trim().slice(0, 200) }); });
  title.addEventListener('keydown', (e) => { e.stopPropagation(); if (e.key === 'Enter') { e.preventDefault(); title.blur(); } });
  const more = node.querySelector('[data-wb-wmenu]');
  if (more) more.addEventListener('click', (e) => {
    e.stopPropagation();
    const cur = S?.items.get(id);
    if (!cur) return;
    if (mobile()) { openItemSheet(id, 'settings'); return; }   /* V3.852 — on a phone ⋯ opens the card's SETTINGS */
    if (S.widgets?.onMenu) { try { S.widgets.onMenu({ id, ...cur }, more, widgetApi(id)); } catch (err) { console.warn('[whiteboard] widget menu failed', err); } }
  });
  wireReportBtn(node, id);   /* V3.854 */
  /* keystrokes inside a widget are the widget's — never the board's page keys */
  node.addEventListener('keydown', (e) => e.stopPropagation());
  /* V3.863 — Escape lets a chosen card go, from any of its fields (capture: the name field keeps its own keys) */
  node.addEventListener('keydown', (e) => { if (e.key === 'Escape' && S && S.cardSel === id) cardSelect(null); }, true);
  return node;
}
function toggleTintPop(node, id) {
  const open = node.querySelector(':scope > .wb-tint-pop');
  document.querySelectorAll('.wb-tint-pop').forEach(n => n.remove());
  if (open || !S) return;
  const cur = S.items.get(id); if (!cur) return;
  const pop = document.createElement('div'); pop.className = 'wb-tint-pop';
  pop.innerHTML = ITEM_TINTS.map(c => `<button type="button" class="wb-tint-sw${(cur.color || '') === c ? ' wb-sel' : ''}${c ? '' : ' wb-tint-none'}" data-wb-act="item-color" data-item="${escAttr(id)}" data-color="${c}" style="${c ? 'background:' + c : ''}" title="${c || 'No colour'}" aria-label="${c ? 'Colour ' + c : 'No colour'}"></button>`).join('');
  pop.addEventListener('click', (e) => { const b = e.target.closest('[data-wb-act="item-color"]'); if (!b) return; e.stopPropagation(); handleBoardAction('item-color', b); pop.remove(); });
  pop.addEventListener('pointerdown', (e) => e.stopPropagation());
  node.appendChild(pop);
  const close = (e) => { if (!pop.contains(e.target)) { pop.remove(); document.removeEventListener('pointerdown', close, true); } };
  setTimeout(() => document.addEventListener('pointerdown', close, true), 0);
}
function updateWidgetChrome(node, id, it, arrange) {
  syncReportBtn(node, it);   /* V3.854 */
  const m = widgetMeta(it);
  node.classList.toggle('wb-collapsed', !!it.collapsed);
  /* V3.839 — the card's colour */
  const col = (it.color && /^#[0-9a-f]{6}$/i.test(it.color)) ? it.color : '';
  if (col) node.style.setProperty('--wb-card', col); else node.style.removeProperty('--wb-card');
  node.classList.toggle('wb-tinted', !!col);
  const tint = node.querySelector('[data-wb-wtint]'); if (tint) tint.style.background = col;
  const kind = node.querySelector('.wb-wkind');   /* V3.861 — m.glyph is an icon name (or a host's text symbol): ICON.render, written only when it changes */
  if (kind) { const kk = m.glyph + '|' + m.label; if (kind.dataset.k !== kk) { kind.dataset.k = kk; kind.innerHTML = (m.glyph ? ICON.render(m.glyph) + ' ' : '') + esc(m.label); } }
  const title = node.querySelector('.wb-wtitle');
  if (title && document.activeElement !== title && title.value !== (it.title || '')) title.value = it.title || '';
  const sum = node.querySelector('.wb-wsum'); if (sum) sum.textContent = it.collapsed ? widgetSummary(it) : '';
  const st = node.querySelector('.wb-wstamp'); if (st) st.textContent = fmtStampShort(it);
  const ch = node.querySelector('[data-wb-wcollapse]'); if (ch) ch.textContent = it.collapsed ? '▸' : '▾';
  const has = !!node.querySelector('[data-wb-item-del]');
  if (arrange && !has) node.insertAdjacentHTML('beforeend', arrangeToolsHTML(true));
  if (!arrange && has) node.querySelectorAll('[data-wb-item-del],[data-wb-item-resize]').forEach(n => n.remove());
}
/* The body is (re)rendered by the host only when the item's DATA changed
   and nobody is typing in it; a local save marks the body current (the
   edit came from it), so an echo from the server never rebuilds it. */
function syncWidgetBody(node, id, it) {
  const body = node.querySelector('[data-wb-wbody]');
  if (!body) return;
  if (it.collapsed) { body.hidden = true; return; }
  body.hidden = false;
  const ds = dataSig(it) + '|' + bodyMode();
  if (body.dataset.ds === ds) return;
  if (body.dataset.ds && body.contains(document.activeElement)) return;
  body.dataset.ds = ds;
  if (S.widgets?.render) {
    try { S.widgets.render({ id, ...it }, body, widgetApi(id)); }
    catch (e) { console.warn('[whiteboard] widget render failed', e); body.textContent = widgetSummary(it); }
  } else {
    body.textContent = widgetSummary(it);
  }
}
/* ================================================================
   V3.852 — MOBILE: the card sheet
   On a phone a card's body is inert (CSS under .wb-m) and the whole card is a drag handle; a
   tap opens this bottom sheet, which hosts the card's REAL editor (the host's widgets.render,
   or widgets.renderSheet when a kind wants a lighter form — an HTML frame does), the title,
   the colour, the width, its connections, and the actions the ⋯ menu offers on a desktop
   (widgets.menuItems). Regions and instances get a smaller sheet of their own fields.
   ================================================================ */
const SHEET_SIZES = [['S', 0.3], ['M', 0.46], ['L', 0.62], ['XL', 0.85]];
function closeItemSheet() {
  const back = document.querySelector('.wb-sheet-back');
  const id = S ? S.sheetId : null;
  if (back) { if (back._wbKey) document.removeEventListener('keydown', back._wbKey, true); back.remove(); }   /* V3.855 */
  if (S) S.sheetId = null;
  /* the card's body may have lent its live widgets to the sheet (a protocol's formulas, a
     calculator): rebuild it from the data now */
  if (S && id && S.items.has(id) && S.items.get(id).type === 'widget') widgetApi(id).refresh();
}
function sheetApiFor(id) {
  const base = widgetApi(id);
  return Object.assign({}, base, {
    inSheet: true,
    remove: () => { closeItemSheet(); return deleteItem(id); },
    refresh: () => { renderSheetBody(); base.refresh(); }
  });
}
function sheetEl(sel) { const back = document.querySelector('.wb-sheet-back'); return back ? back.querySelector(sel) : null; }
function renderSheetBody() {
  if (!S || !S.sheetId) return;
  const id = S.sheetId; const it = S.items.get(id); const body = sheetEl('[data-wb-sheet-body]');
  if (!it || !body) return;
  body.dataset.ds = dataSig(it);   /* V3.855 — so a tab switch can tell whether the pane is stale */
  if (it.type === 'widget') {
    const api = sheetApiFor(id); const item = Object.assign({ id }, it);
    try {
      if (S.widgets?.renderSheet) S.widgets.renderSheet(item, body, api);
      else if (S.widgets?.render) S.widgets.render(item, body, api);
      else body.textContent = widgetSummary(it);
    } catch (e) { console.warn('[whiteboard] sheet render failed', e); body.textContent = widgetSummary(it); }
  } else if (it.type === 'region') {
    const n = regionMembers(id, it).length;
    body.innerHTML = `<div class="wb-sheet-note">${n ? `${n} card${n === 1 ? '' : 's'} inside` : 'No cards inside yet — drag cards into the box.'}</div>`;
  } else if (it.type === 'regionref') {
    const src = it.src || {}; const url = (typeof sourceUrl === 'function') ? sourceUrl(src) : '';
    body.innerHTML = `<div class="wb-sheet-note">An instance of a region on <b>${esc(src.boardName || 'another board')}</b>. It follows every change at the source.</div>
      ${url ? `<a class="wb-sheet-link" href="${escAttr(url)}" target="_blank" rel="noopener">Open the source board ↗</a>` : ''}`;
  }
}
function renderSheetLinks() {
  if (!S || !S.sheetId) return;
  const id = S.sheetId; const box = sheetEl('[data-wb-sheet-links]'); if (!box) return;
  const nameOf = (oid) => { const o = S.items.get(oid); if (!o) return 'a card'; return (o.title || widgetSummary(o) || widgetMeta(o).label || 'a card'); };
  const mine = [...S.wires.entries()].filter(([, w]) => w.from === id || w.to === id);
  const linked = new Set(mine.map(([, w]) => (w.from === id ? w.to : w.from)));
  const others = [...S.items.entries()].filter(([oid, o]) => oid !== id && o.type === 'widget' && !linked.has(oid));
  box.innerHTML = `<div class="wb-sheet-label">Connections</div>
    ${mine.length ? mine.map(([wid, w]) => `<div class="wb-sheet-wire"><span>${w.from === id ? '→' : '←'} ${esc(String(nameOf(w.from === id ? w.to : w.from)).slice(0, 60))}${(w.rel || w.label) ? ` <i>${esc(w.rel || w.label)}</i>` : ''}</span><button type="button" class="wb-sheet-x" data-wb-sheet-unwire="${escAttr(wid)}" aria-label="Remove this connection">×</button></div>`).join('') : '<div class="wb-sheet-note">Not connected to anything yet.</div>'}
    ${others.length ? `<div class="wb-sheet-connect"><select class="wb-sheet-select" data-wb-sheet-target aria-label="Card to connect to">${others.map(([oid]) => `<option value="${escAttr(oid)}">${esc(String(nameOf(oid)).slice(0, 60))}</option>`).join('')}</select><button type="button" class="wb-sheet-btn" data-wb-sheet-connect>Connect →</button></div>` : ''}`;
}
function sheetActionList(id, it) {
  const acts = [];
  if (it.type === 'widget') {
    acts.push({ label: it.collapsed ? 'Expand' : 'Collapse', run: () => updateItem(id, { collapsed: !it.collapsed }) });
    acts.push({ label: 'Bring to front', run: () => updateItem(id, { z: Date.now() }) });
    if (S.widgets?.menuItems) {
      try { (S.widgets.menuItems(Object.assign({ id }, it), sheetApiFor(id)) || []).forEach(a => { if (a && a.label && !/^(expand|collapse|bring to front)$/i.test(a.label)) acts.push(a); }); }
      catch (e) { console.warn('[whiteboard] sheet menu items failed', e); }
    } else acts.push({ label: 'Remove', danger: true, confirm: 'Really remove?', run: () => { closeItemSheet(); deleteItem(id); } });
  } else if (it.type === 'region') {
    acts.push({ label: it.collapsed ? 'Open the region' : 'Collapse the region', run: () => toggleRegion(id) });
    acts.push({ label: 'Fit around its cards', run: () => fitRegionToMembers(id, { shrink: true }) });
    acts.push({ label: 'Remove the region', sub: 'The cards stay', danger: true, confirm: 'Really remove?', run: () => { closeItemSheet(); deleteItem(id); } });
  } else if (it.type === 'regionref') {
    acts.push({ label: 'Remove this instance', sub: 'The source stays', danger: true, confirm: 'Really remove?', run: () => { closeItemSheet(); deleteItem(id); } });
  }
  return acts;
}
function renderSheetActions() {
  if (!S || !S.sheetId) return;
  const id = S.sheetId; const it = S.items.get(id); const box = sheetEl('[data-wb-sheet-acts]');
  if (!it || !box) return;
  const acts = sheetActionList(id, it);
  box.innerHTML = acts.map((a, i) => `<button type="button" class="wb-sheet-act${a.danger ? ' wb-sheet-danger' : ''}" data-wb-sheet-act="${i}"><b>${esc(a.label)}</b>${a.sub ? `<small>${esc(a.sub)}</small>` : ''}</button>`).join('');
  box.onclick = (e) => {
    const b = e.target.closest('[data-wb-sheet-act]'); if (!b) return;
    const a = acts[+b.dataset.wbSheetAct]; if (!a) return;
    if (a.danger && !armTwoTap(b.querySelector('b') || b, a.confirm || ('Really ' + a.label.toLowerCase() + '?'))) return;
    try {
      const r = a.run();
      const after = () => { if (S && S.sheetId === id && S.items.has(id)) { renderSheetActions(); const t = sheetEl('[data-wb-sheet-title]'); const cur = S.items.get(id); if (t && document.activeElement !== t && cur) t.value = cur.title || ''; if (a.then === 'content') setSheetMode('content'); } };   /* V3.855 — an action may hand over to ✎ Edit */
      if (r && typeof r.then === 'function') r.then(after, after); else after();
    } catch (err) { console.warn('[whiteboard] sheet action failed', err); }
  };
}
function openItemSheet(id, mode) {
  if (!S) return;
  const it = S.items.get(id); if (!it) return;
  if (!S.isAdmin) return;   // a read-only viewer keeps the inert card
  closeItemSheet();
  document.querySelectorAll('.wb-tint-pop').forEach(n => n.remove());
  S.sheetId = id;
  const isW = it.type === 'widget', isG = it.type === 'region', isR = it.type === 'regionref';
  const m = isW ? widgetMeta(it) : { glyph: isG ? '▭' : '⧉', label: isG ? 'Region' : 'Instance' };
  const tints = isG ? REGION_COLORS : ITEM_TINTS;
  const curW = it.w || 0.42;
  /* V3.852 — two modes: EDIT (what the card does — the host's editor) and SETTINGS (name, colour,
     width, connections, actions). A tap opens Edit, ⋯ opens Settings; regions and instances have
     settings only. */
  const twoMode = isW;
  const startMode = (!twoMode || mode === 'settings') ? 'settings' : 'content';
  const swatches = tints.map(c => `<button type="button" class="wb-sheet-sw${(it.color || '') === c ? ' wb-sel' : ''}${c ? '' : ' wb-sheet-sw-none'}" data-wb-sheet-color="${c}" style="${c ? 'background:' + c : ''}" aria-label="${c ? 'Colour ' + c : 'No colour'}"></button>`).join('');
  const sizes = SHEET_SIZES.map(([k, w]) => `<button type="button" class="wb-sheet-btn${Math.abs(curW - w) < 0.08 ? ' wb-sel' : ''}" data-wb-sheet-w="${w}">${k}</button>`).join('');
  const back = document.createElement('div'); back.className = 'wb-sheet-back' + (mobile() ? ' wb-sheet-m' : '');   /* V3.855 — .wb-sheet-m: 16 px inputs (iOS zooms on anything smaller) */
  back.innerHTML = `<div class="wb-sheet${twoMode ? ' wb-sheet-two' : ''}" role="dialog" aria-modal="true" aria-label="${escAttr(m.label || 'Card')}" data-wb-sheet-mode="${startMode}" tabindex="-1">
    <div class="wb-sheet-grip"></div>
    <div class="wb-sheet-head"><span class="wb-sheet-kind">${m.glyph ? ICON.render(m.glyph) + ' ' : ''}${esc(m.label || '')}</span><button type="button" class="wb-sheet-done" data-wb-sheet-close>Done</button></div>
    ${twoMode ? `<div class="wb-sheet-tabs" role="tablist" aria-label="Edit, or settings">
      <button type="button" role="tab" class="wb-sheet-tab" data-wb-sheet-tab="content" aria-selected="${startMode === 'content'}">✎ Edit</button>
      <button type="button" role="tab" class="wb-sheet-tab" data-wb-sheet-tab="settings" aria-selected="${startMode === 'settings'}">${ICON.svg('cog-6-tooth')} Settings</button>
    </div>
    <div class="wb-sheet-pane wb-sheet-pane-content" data-wb-sheet-pane="content"${startMode === 'content' ? '' : ' hidden'}><div class="wb-sheet-body" data-wb-sheet-body></div></div>` : ''}
    <div class="wb-sheet-pane wb-sheet-pane-settings" data-wb-sheet-pane="settings"${startMode === 'settings' ? '' : ' hidden'}>
      ${isR ? '' : `<label class="wb-sheet-label wb-sheet-label-block" for="wb-sheet-title">Name</label><input type="text" id="wb-sheet-title" class="wb-sheet-title" data-wb-sheet-title placeholder="${isG ? 'Region name' : 'Card name'}" value="${escAttr(it.title || '')}">`}
      ${twoMode ? '' : '<div class="wb-sheet-body" data-wb-sheet-body></div>'}
      ${isR ? '' : `<div class="wb-sheet-label wb-sheet-label-block">Colour</div><div class="wb-sheet-row wb-sheet-colours" data-wb-sheet-colours>${swatches}</div>`}
      ${isW ? `<div class="wb-sheet-row wb-sheet-size"><span class="wb-sheet-label">Width</span>${sizes}</div>` : ''}
      ${isW && S.wiresEnabled ? '<div class="wb-sheet-row wb-sheet-links" data-wb-sheet-links></div>' : ''}
      <div class="wb-sheet-acts" data-wb-sheet-acts></div>
    </div>
  </div>`;
  /* nothing in the sheet reaches the board */
  ['pointerdown', 'pointermove', 'pointerup', 'pointercancel', 'keydown', 'keyup', 'wheel', 'touchstart', 'touchmove'].forEach(t => back.addEventListener(t, (e) => e.stopPropagation()));
  back.addEventListener('click', (e) => { if (e.target === back) closeItemSheet(); });
  /* V3.855 — Escape closes the sheet from anywhere on the page (focus is on the body right after a tap-open) */
  const onKey = (e) => { if (e.key !== 'Escape' || !back.isConnected) return; e.preventDefault(); e.stopPropagation(); closeItemSheet(); };
  back._wbKey = onKey; document.addEventListener('keydown', onKey, true);
  back.querySelector('[data-wb-sheet-close]').addEventListener('click', () => closeItemSheet());
  back.querySelectorAll('[data-wb-sheet-tab]').forEach(t => t.addEventListener('click', () => setSheetMode(t.dataset.wbSheetTab)));
  const title = back.querySelector('[data-wb-sheet-title]');
  if (title) {
    title.addEventListener('change', () => updateItem(id, { title: title.value.trim().slice(0, 200) }));
    title.addEventListener('keydown', (e) => { if (e.key === 'Enter') { e.preventDefault(); title.blur(); } });
  }
  const colours = back.querySelector('[data-wb-sheet-colours]');
  if (colours) colours.addEventListener('click', (e) => {
    const b = e.target.closest('[data-wb-sheet-color]'); if (!b) return;
    updateItem(id, { color: b.dataset.wbSheetColor || '' });
    colours.querySelectorAll('[data-wb-sheet-color]').forEach(x => x.classList.toggle('wb-sel', x === b));
  });
  const size = back.querySelector('.wb-sheet-size');
  if (size) size.addEventListener('click', (e) => {
    const b = e.target.closest('[data-wb-sheet-w]'); if (!b) return;
    updateItem(id, { w: +b.dataset.wbSheetW });
    size.querySelectorAll('[data-wb-sheet-w]').forEach(x => x.classList.toggle('wb-sel', x === b));
  });
  const links = back.querySelector('[data-wb-sheet-links]');
  if (links) links.addEventListener('click', async (e) => {
    const un = e.target.closest('[data-wb-sheet-unwire]');
    if (un) { await removeWire(un.dataset.wbSheetUnwire); renderSheetLinks(); return; }
    if (e.target.closest('[data-wb-sheet-connect]')) { const sel = links.querySelector('[data-wb-sheet-target]'); if (sel && sel.value) { await addWire(id, sel.value, ''); renderSheetLinks(); } }
  });
  document.body.appendChild(back);
  S.sheetMode = startMode;
  renderSheetBody();
  renderSheetLinks();
  renderSheetActions();
  try { back.querySelector('.wb-sheet').focus({ preventScroll: true }); } catch (e) {}
}
/** V3.852 — switch the open sheet between Edit (content) and Settings. */
function setSheetMode(mode) {
  const sh = sheetEl('.wb-sheet'); if (!sh) return;
  if (!sh.classList.contains('wb-sheet-two')) mode = 'settings';
  if (mode !== 'content') mode = 'settings';
  sh.dataset.wbSheetMode = mode; if (S) S.sheetMode = mode;
  sh.querySelectorAll('[data-wb-sheet-pane]').forEach(p => { p.hidden = p.dataset.wbSheetPane !== mode; });
  sh.querySelectorAll('[data-wb-sheet-tab]').forEach(t => t.setAttribute('aria-selected', t.dataset.wbSheetTab === mode ? 'true' : 'false'));
  /* V3.855 — the pane you switch TO is redrawn from the card as it is now: an edit in ✎ Edit (an item picked, a
     protocol loaded, an image uploaded) changes the name and the actions Settings offers, and a Settings action
     (replace the image, unload) changes what Edit shows. Edit is only rebuilt when the data really changed, so an
     open form or a caret is never thrown away for nothing. */
  if (!S || !S.sheetId) return;
  const cur = S.items.get(S.sheetId); if (!cur) return;
  if (mode === 'settings') {
    const t = sheetEl('[data-wb-sheet-title]'); if (t && document.activeElement !== t) t.value = cur.title || '';
    const curW = cur.w || 0.42; sh.querySelectorAll('[data-wb-sheet-w]').forEach(b => b.classList.toggle('wb-sel', Math.abs(curW - (+b.dataset.wbSheetW)) < 0.08));
    renderSheetLinks(); renderSheetActions();
  } else {
    const b = sheetEl('[data-wb-sheet-body]'); if (b && b.dataset.ds !== dataSig(cur)) renderSheetBody();
  }
}

function widgetApi(id) {
  return {
    id,
    item: () => (S ? S.items.get(id) || null : null),
    canEdit: () => !!S?.isAdmin,
    save: (patch) => updateItem(id, patch),
    /** Replace the widget's data (pass the WHOLE data object). */
    saveData: (data, text) => updateItem(id, Object.assign({ data: data || {} }, typeof text === 'string' ? { text: text.slice(0, 4000) } : {})),
    remove: () => deleteItem(id),
    /** Re-render the body now (after a change made from a menu, not from inside the body). */
    refresh: () => { if (!S) return; const n = S.itemNodes.get(id); const b = n?.querySelector('[data-wb-wbody]'); if (b) b.dataset.ds = ''; const cur = S.items.get(id); if (n && cur) syncWidgetBody(n, id, cur); },
    collapse: (on) => updateItem(id, { collapsed: !!on }),
    /* V3.852 — the card's two sheet modes, for the host's menus */
    openSettings: () => openItemSheet(id, 'settings'),
    openEditor: () => openItemSheet(id, 'content')
  };
}

/** Update fields of an item (owner only). Applied locally first so the
 *  card responds at once; the server echo then matches. */
async function updateItem(id, patch) {
  if (!S || !S.isAdmin) return false;
  const cur = S.items.get(id);
  if (!cur || !patch) return false;
  const next = Object.assign({}, cur, patch);
  S.items.set(id, next);
  if (Object.prototype.hasOwnProperty.call(patch, 'data')) {
    const n = S.itemNodes.get(id); const b = n?.querySelector('[data-wb-wbody]');
    if (b) b.dataset.ds = dataSig(next) + '|' + bodyMode();
  }
  renderItems();
  recEvent('item-move', itemEventPayload(id, next));
  try {
    await boardsCol(S.classId, S.coll).doc(S.boardId).collection('items').doc(id)
      .update(Object.assign({}, patch, { updatedAt: FV().serverTimestamp() }));
    return true;
  } catch (e) { console.warn('[whiteboard] item update failed', e); toast('Could not save that change.'); return false; }
}

/** The height of an item on the sheet, in page-width units (measured). */
function itemHeightU(id, it) {
  const ink = el('ink');
  if (!ink || !S?.sheet) return (it.w || 0.4) / (it.ar || 1.6);
  const dpr = ink.width / Math.max(1, ink.clientWidth);
  const pw = S.sheet.pageW / dpr;
  const n = S.itemNodes.get(id);
  if (n && !n.hidden && n.offsetHeight > 0) { const h = n.offsetHeight / pw; S.itemH.set(id, h); return h; }
  if (S.itemH.has(id)) return S.itemH.get(id);              // V3.843 — a hidden card keeps its last height
  return (it.w || 0.4) / (it.ar || 1.6);
}
/** Nudge a placement down until it does not sit on another item of that page. */
function avoidOverlap(at) {
  const onPage = [...S.items.entries()].filter(([, i]) => i.pageId === at.pageId && i.type !== 'region');
  let y = at.y;
  for (let tries = 0; tries < 24; tries++) {
    const hit = onPage.find(([id, i]) => {
      const ix0 = i.x || 0, ix1 = ix0 + (i.w || 0.4), iy0 = i.y || 0, iy1 = iy0 + itemHeightU(id, i);
      return at.x < ix1 && at.x + 0.42 > ix0 && y < iy1 && y + 0.06 > iy0;
    });
    if (!hit) break;
    y = snapU((hit[1].y || 0) + itemHeightU(hit[0], hit[1]) + WIDGET_GRID);
  }
  return Object.assign({}, at, { y: infinite() ? y : Math.min(BOARD_H - 0.06, y) });
}

/** V3.833 — a widget card on the board.
 *  meta: { kind, title, data, text, w, collapsed, pageId?, x?, y?, itemId? } */
async function addWidgetItem(meta) {
  if (!S) return null;
  if (!S.isAdmin) { toast('Only the board\'s owner can add to it.'); return null; }
  meta = meta || {};
  let at;
  if (meta.pageId && typeof meta.x === 'number' && typeof meta.y === 'number') at = { pageId: meta.pageId, x: snapU(meta.x), y: snapU(meta.y), pageNum: pageIndexOf(meta.pageId) + 1 };
  else { const p = newItemPlacement(); at = { pageId: p.pageId, pageNum: p.pageNum, x: snapU(p.x), y: snapU(p.y) }; }
  if (meta.avoidOverlap !== false) at = avoidOverlap(at);
  const itemId = meta.itemId || newId('i');
  const now = Date.now();
  const doc = {
    pageId: at.pageId, type: 'widget', kind: String(meta.kind || 'note').slice(0, 40),
    title: String(meta.title || '').slice(0, 200), collapsed: !!meta.collapsed,
    x: at.x, y: at.y, w: meta.w || 0.42, ar: 1.6, z: now, stampAt: now,
    data: (meta.data && typeof meta.data === 'object') ? meta.data : {},
    text: String(meta.text || '').slice(0, 4000),
    url: '', fullUrl: '', storagePath: '',
    createdBy: window.McgheeLab?.Auth?.currentUser?.uid || '',
    createdAt: FV().serverTimestamp(), updatedAt: FV().serverTimestamp()
  };
  try {
    await boardsCol(S.classId, S.coll).doc(S.boardId).collection('items').doc(itemId).set(doc);
    if (meta.adopt !== false) adoptIntoRegion(itemId, { x: doc.x + doc.w / 2, y: pageTop(pageIndexOf(doc.pageId)) + doc.y + Math.min(0.03, doc.w / 3.2) }).catch(() => {});   // V3.843
    return itemId;
  } catch (e) { console.warn('[whiteboard] add widget failed', e); toast('Could not add to the board.'); return null; }
}

/** V3.833 — Tidy layout: the items of the page under the view (or `pageId`)
 *  stacked in one column, in their current top-to-bottom order. */
async function tidyItems(pageId) {
  if (!S || !S.isAdmin || !S.sheet) return 0;
  const pages = S.board?.pages || [];
  const pid = pageId || (continuous() ? (pages[pageAtSheetY(viewCentre())]?.id || S.pageId) : S.pageId);
  const rows = [...S.items.entries()].filter(([, i]) => i.pageId === pid && i.type !== 'region')
    .sort((a, b) => ((a[1].y || 0) - (b[1].y || 0)) || ((a[1].x || 0) - (b[1].x || 0)));
  if (!rows.length) return 0;
  let y = snapU(infinite() ? S.sheet.originY + 0.04 : 0.04);          // V3.841 — the plane tidies from the view's top-left
  const colX = snapU(infinite() ? (S.sheet.originX || 0) + 0.05 : 0.05);
  const batch = db().batch();
  const col = boardsCol(S.classId, S.coll).doc(S.boardId).collection('items');
  rows.forEach(([id, it]) => {
    const h = itemHeightU(id, it);
    const nx = colX, ny = y;
    if (nx !== it.x || ny !== it.y) {
      const next = Object.assign({}, it, { x: nx, y: ny }); S.items.set(id, next);
      batch.update(col.doc(id), { x: nx, y: ny, updatedAt: FV().serverTimestamp() });
      recEvent('item-move', itemEventPayload(id, next));
    }
    y = snapU(y + h + 2 * WIDGET_GRID);
  });
  renderItems();
  try { await batch.commit(); } catch (e) { console.warn('[whiteboard] tidy failed', e); toast('Could not tidy the page.'); }
  return rows.length;
}

/* V3.830 — one event / itemsAtStart shape for images AND text cards, so a
   replay re-creates both (the replay copies these fields verbatim). */
function itemEventPayload(id, it) {
  return { itemId: id, pageId: it.pageId, x: it.x, y: it.y, w: it.w, ar: it.ar, url: it.url || '', fullUrl: it.fullUrl || it.url || '',
           ...(it.type === 'text' ? { kind: 'text', text: it.text || '', cite: it.cite || '' } : {}),
           /* V3.833 — a widget replays as its card: kind, title and the summary line */
           ...(it.type === 'widget' ? { kind: 'widget', wkind: it.kind || '', title: it.title || '', summary: widgetSummary(it), collapsed: !!it.collapsed, stampAt: stampMs(it) || 0, color: it.color || '' } : {}),
           /* V3.842 — regions and instances replay too */
           ...(it.type === 'region' ? { kind: 'region', title: it.title || '', color: it.color || '', h: it.h || 0.3, collapsed: !!it.collapsed } : {}),
           ...(it.type === 'regionref' ? { kind: 'regionref', title: it.title || '', color: it.color || '', src: it.src || null } : {}) };
}

/* ─── V3.830 Arrange mode: move / resize / remove items ────────────
   Off by default so a pen never fights a figure; the toolbar's ⤧ Arrange
   lifts the items layer above the ink (CSS .wb-arrange) and these handlers
   take the pointer. Deltas are screen px → page-width units through the
   page width AND the lens scale. Stopped at the layer so the stage's
   two-finger scroll / pinch never starts from a drag. */
function bindItemHandlers() {
  const layers = [el('itemsLayer'), el('widgetsLayer')].filter(Boolean);
  if (!layers.length) return;
  let d = null;   // { id, mode:'move'|'resize', x0, y0, ix, iy, iw, k, node }
  const unitsPerPx = () => {
    const ink = el('ink');
    const dpr = ink.width / Math.max(1, ink.clientWidth);
    return 1 / ((S.sheet.pageW / dpr) * (lensActive() ? S.view.scale : 1));
  };
  const onDown = (e) => {
    /* V3.833 — outside Arrange a widget's own controls take the pointer;
       the layer only acts while arranging — except (V3.839) the corner
       grip, which resizes a card at any time */
    if (!S || !S.isAdmin || !S.sheet) return;
    /* V3.852 — on a phone the whole card is the handle (its body is inert): a drag moves it, a tap opens the sheet.
       V3.863 — only in Select (Cards): in pan / pen / highlighter a finger goes through the cards to the board, so
       moving around never opens a card (and never raises the keyboard) */
    const mob = mobile() && !S.arrange;
    if (mob && S.tool !== 'card') return;
    if (!mob && !S.arrange && S.tool === 'pan' && e.pointerType === 'touch') return;   /* a touch in Pan moves the board */
    /* V3.863 — Cards on a wider screen: the whole card is the handle too (a drag moves it, a tap chooses it); inside the
       chosen card's body a press is the card's own — a caret, a selection, its buttons */
    const cardMode = !mob && !S.arrange && S.tool === 'card';
    if (cardMode && S.cardSel && e.target.closest && e.target.closest('.wb-wb') && e.target.closest('.wb-item')?.dataset.itemId === S.cardSel) return;
    if (cardMode && e.target === document.activeElement && e.target.matches && e.target.matches('input, textarea')) return;
    const grip = e.target.closest && e.target.closest('[data-wb-wgrip]');
    /* V3.841 — a card's port starts a wire; its header moves it at any time */
    const port = e.target.closest && e.target.closest('[data-wb-port]');
    if (port && !S.arrange) { startPortDrag(e, port); return; }
    const rgrip = e.target.closest && e.target.closest('[data-wb-rgrip]');
    /* V3.843 — the name field is most of a header: a drag that starts on it
       moves the card / region; a plain tap focuses it for editing */
    const onTitle = !S.arrange && e.target.matches && e.target.matches('.wb-rtitle, .wb-wtitle') && document.activeElement !== e.target;
    if (!S.arrange && !grip && !rgrip) {
      const head = e.target.closest && e.target.closest('.wb-wh, .wb-rh');
      const whole = (mob || cardMode) && e.target.closest && e.target.closest(cardMode ? '.wb-item-widget, .wb-regionref, .wb-items > .wb-item' : '.wb-item-widget, .wb-regionref');
      if (!head && !whole) return;
      if (e.target.closest && e.target.closest('button, .wb-tint-pop, [data-wb-port]')) return;
      if (!whole && !onTitle && e.target.closest && e.target.closest('input, select, textarea, [contenteditable]')) return;
    }
    const node = e.target.closest('.wb-item');
    if (!node) return;
    const id = node.dataset.itemId;
    const it = S.items.get(id);
    if (!it) return;
    e.preventDefault(); e.stopPropagation();
    if (e.target.closest('[data-wb-item-del]')) {
      if (!armTwoTap(e.target.closest('[data-wb-item-del]'), '✓')) return;
      deleteItem(id);
      return;
    }
    const mode = (grip || rgrip || e.target.closest('[data-wb-item-resize]')) ? 'resize' : 'move';
    d = { id, mode, x0: e.clientX, y0: e.clientY, ix: it.x || 0, iy: it.y || 0, iw: it.w || 0.4, ih: it.h || 0.3, k: unitsPerPx(), node };
    d.focusTarget = onTitle ? e.target : null;
    /* V3.852 — a phone: the drag arms after 8 px; a motionless pointer-up opens the sheet */
    d.tap = (mob || cardMode) && mode === 'move' && (cardMode || it.type === 'widget' || it.type === 'region' || it.type === 'regionref');
    d.armed = !(mob || cardMode);
    d.card = cardMode; d.cx = e.clientX; d.cy = e.clientY; d.ptype = e.pointerType;   /* V3.863 */
    /* V3.843 — remember which regions hold the card: they refit when it is dropped */
    if (it.type !== 'region') d.regionsBefore = regionsHolding(id);
    /* V3.842 — a region carries the cards inside it */
    if (it.type === 'region' && mode === 'move') d.members = regionMembers(id, it).map(mid => { const o = S.items.get(mid); return { id: mid, x: o.x || 0, y: o.y || 0, node: S.itemNodes.get(mid) }; });
    S.draggingItemId = id;
    try { e.currentTarget.setPointerCapture(e.pointerId); } catch (err) {}
    node.classList.add('wb-item-dragging');
  };
  const onMove = (e) => {
    if (!d || !S) return;
    e.preventDefault(); e.stopPropagation();
    const it = S.items.get(d.id);
    if (!it) { d = null; return; }
    if (!d.armed) { if (Math.hypot(e.clientX - d.x0, e.clientY - d.y0) < 8) return; d.armed = true; }   /* V3.852 */
    const dx = (e.clientX - d.x0) * d.k, dy = (e.clientY - d.y0) * d.k;
    const ink = el('ink');
    const dpr = ink.width / Math.max(1, ink.clientWidth);
    const pw = S.sheet.pageW / dpr;
    if (d.mode === 'move') {
      it.x = round4(d.ix + dx); it.y = round4(d.iy + dy);
      if (d.members) d.members.forEach(m => { const o = S.items.get(m.id); if (o && m.node) { o.x = round4(m.x + dx); o.y = round4(m.y + dy); placeItemNode(m.node, o, pw, dpr); } });
    } else {
      it.w = round4(Math.max(it.type === 'widget' ? 0.12 : 0.08, Math.min(it.type === 'region' ? 6 : 1, d.iw + dx)));
      if (it.type === 'region') it.h = round4(Math.max(0.06, d.ih + dy));
    }
    /* move the node directly — a full renderItems per pointer frame would
       rebuild every image */
    placeItemNode(d.node, it, pw, dpr);
    if (d.members || it.type === 'region') renderWires();
  };
  const onUp = async (e) => {
    if (!d || !S) return;
    e.stopPropagation();
    const cur = d; d = null;
    cur.node.classList.remove('wb-item-dragging');
    const it = S.items.get(cur.id);
    if (!it) { S.draggingItemId = null; return; }
    /* V3.833 — drop on the grid */
    /* V3.852 — a tap on a phone never snaps (an off-grid card would otherwise count as moved and the sheet would not open) */
    if (cur.mode === 'move' && cur.armed) { it.x = snapU(it.x); it.y = snapU(it.y); }
    const moved = it.x !== cur.ix || it.y !== cur.iy || it.w !== cur.iw || (it.type === 'region' && it.h !== cur.ih);
    if (moved) {
      /* an item dragged past the page below lands on THAT page (sheet
         coordinates are page-local, like ink) */
      const idx = pageIndexOf(it.pageId);
      const sheetY = pageTop(idx) + it.y;
      const toIdx = pageAtSheetY(Math.max(pageTop(idx), sheetY + 0.02));
      if (toIdx !== idx) { it.y = round4(sheetY - pageTop(toIdx)); it.pageId = (S.board?.pages || [])[toIdx]?.id || it.pageId; }
      recEvent('item-move', itemEventPayload(cur.id, it));
      try {
        const col = boardsCol(S.classId, S.coll).doc(S.boardId).collection('items');
        const patch = { x: it.x, y: it.y, w: it.w, pageId: it.pageId, updatedAt: FV().serverTimestamp() };
        if (it.type === 'region') patch.h = it.h || 0.3;
        if (cur.members && cur.members.length) {
          /* V3.842 — the region's cards moved with it: one batch */
          const batch = db().batch(); batch.update(col.doc(cur.id), patch);
          cur.members.forEach(m => { const o = S.items.get(m.id); if (!o) return; o.x = snapU(o.x); o.y = snapU(o.y); batch.update(col.doc(m.id), { x: o.x, y: o.y, updatedAt: FV().serverTimestamp() }); recEvent('item-move', itemEventPayload(m.id, o)); });
          await batch.commit();
        } else await col.doc(cur.id).update(patch);
      } catch (err) { console.warn('[whiteboard] item move failed', err); toast('Could not move that item.'); }
    }
    if (S) { S.draggingItemId = null; renderItems(); }
    /* V3.852 — a motionless tap on a phone opens the card's sheet */
    if (S && !moved && cur.tap && !cur.card) { openItemSheet(cur.id, 'content'); return; }
    /* V3.863 — Cards: a tap chooses the card. A mouse also puts the caret where it clicked; a touch or stylus only
       chooses, unless the card was already chosen (then the tap is on its field: edit) */
    if (S && !moved && cur.tap && cur.card) {
      const wasSel = S.cardSel === cur.id;
      cardSelect(cur.id);
      if (cur.ptype === 'mouse' || wasSel) {
        if (cur.focusTarget && cur.focusTarget.isConnected) { try { cur.focusTarget.focus(); } catch (err) {} }
        else cardFocusAt(cur.id, cur.cx, cur.cy);
      }
      return;
    }
    if (!moved && cur.focusTarget && cur.focusTarget.isConnected) { try { cur.focusTarget.focus(); } catch (err) {} }
    /* V3.843 — dropped inside a region → it belongs there (the box fits around it);
       dropped outside the regions that held it → it leaves (they shrink) */
    if (S && moved && it.type !== 'region') {
      const before = cur.regionsBefore || [];
      const target = regionUnder(itemCentre(cur.id, it), before);
      const touched = new Set(before); if (target) touched.add(target);
      for (const rid of touched) {
        const reg = S.items.get(rid); if (!reg) continue;
        let mem = regionMembers(rid, reg).slice();
        if (rid === target) { if (!mem.includes(cur.id)) mem.push(cur.id); } else mem = mem.filter(x => x !== cur.id);
        await setRegionMembers(rid, mem);
      }
    }
  };
  /* V3.837 — before anything else: a tap on a wire, or a card picked while
     connecting. Capture phase, so a card's own controls never see it. */
  const onDownCapture = (e) => {
    if (!S) return;
    const g = e.target.closest && e.target.closest('.wb-wire');
    if (g) { e.preventDefault(); e.stopPropagation(); const id = g.dataset.wireId; if (S.onWire) { try { S.onWire(id, S.wires.get(id) || null, e); } catch (err) {} } return; }
    if (S.connect && S.isAdmin) {
      const node = e.target.closest('.wb-item'); if (!node) return;
      e.preventDefault(); e.stopPropagation();
      const id = node.dataset.itemId;
      if (!S.connect.from) { S.connect.from = id; node.classList.add('wb-connect-from'); return; }
      if (S.connect.from === id) return;
      const from = S.connect.from;
      setConnectMode(false);
      addWire(from, id, '').then(() => { if (S?.onConnectDone) { try { S.onConnectDone(); } catch (err) {} } });
    }
  };
  /* a resting palm or a scroll must never start from an item while arranging */
  const block = (e) => { if (S?.isAdmin && S?.arrange) e.preventDefault(); };
  layers.forEach(layer => {
    layer.addEventListener('pointerdown', onDownCapture, true);
    layer.addEventListener('pointerdown', onDown);
    layer.addEventListener('pointermove', onMove);
    layer.addEventListener('pointerup', onUp);
    layer.addEventListener('pointercancel', onUp);
    layer.addEventListener('touchstart', block, { passive: false });
    layer.addEventListener('touchmove', block, { passive: false });
  });
  /* V3.852 — 'auto' mobile follows the viewport (a phone rotating, a window shrinking) */
  if (S.mobileAuto) {
    const onR = () => {
      if (!S || !S.mobileAuto) return;
      const m = (S.coll === 'notebookBoards' || S.coll === 'paperBoards') && detectMobile();
      if (m !== S.mobile) { S.mobile = m; closeItemSheet(); renderBoardChrome(); renderItems(); }
    };
    window.addEventListener('resize', onR);
    S.unsubs.push(() => window.removeEventListener('resize', onR));
  }
}

async function deleteItem(id) {
  if (!S || !S.isAdmin) return;
  const it = S.items.get(id);
  try {
    await boardsCol(S.classId, S.coll).doc(S.boardId).collection('items').doc(id).delete();
    /* the notebook's own uploads go with the item (class snaps are shared
       with the live board and stay) */
    if (it && it.storagePath && /^(notebook-boards|paper-boards)\//.test(it.storagePath)) {
      ['medium.webp', 'full.webp'].forEach(n => firebase.storage().ref().child(`${it.storagePath}/${n}`).delete().catch(() => {}));
    }
  } catch (e) { console.warn('[whiteboard] item delete failed', e); toast('Could not remove that item.'); }
}

/** V3.830 — where a new item lands: on a class board the board's live
 *  page (V3.684 "put it where I am teaching"); on a notebook board the
 *  page under the middle of the view, just below the centre, so it appears
 *  where the person is looking. */
function newItemPlacement() {
  const pages = S.board?.pages || [];
  if (infinite() && S.sheet) {
    /* V3.841 — near the top-left of what is on the screen */
    const vw = sheetViewW(), vh = sheetViewH();
    return { pageId: planeId(), pageNum: 1, x: round4((S.sheet.originX || 0) + vw * 0.08), y: round4(S.sheet.originY + vh * 0.12) };
  }
  if (isNotebook() && S.sheet && continuous()) {
    const c = viewCentre();
    const idx = pageAtSheetY(c);
    const pageId = pages[idx]?.id || S.pageId || 'p1';
    const y = Math.max(0.03, Math.min(BOARD_H - 0.12, c - pageTop(idx) - 0.08));
    return { pageId, pageNum: idx + 1, x: 0.1, y: round4(y) };
  }
  const pageId = S.board?.activePageId || S.pageId || pages[0]?.id || 'p1';
  const pageNum = Math.max(1, pages.findIndex(p => p.id === pageId) + 1);
  const onPage = [...S.items.values()].filter(i => i.pageId === pageId).length;
  const off = Math.min(0.18, onPage * 0.03);
  return { pageId, pageNum, x: round4(0.14 + off), y: round4(0.10 + off) };
}

/** V3.830 — a passage of text (from a paper) as a card on the board.
 *  meta: { text, cite, srcLabel, paperId, page, w } */
async function addTextItem(meta) {
  if (!S) return null;
  if (!S.isAdmin) { toast('Only the board\'s owner can add to it.'); return null; }
  const text = String(meta?.text || '').trim();
  if (!text) { toast('Nothing to add.'); return null; }
  const at = newItemPlacement();
  const itemId = meta.itemId || newId('i');
  const doc = {
    pageId: at.pageId, type: 'text',
    x: at.x, y: at.y, w: meta.w || 0.42, ar: 2.4, z: Date.now(),
    text: text.slice(0, 4000), cite: String(meta.cite || '').slice(0, 300),
    url: '', fullUrl: '', storagePath: '',
    src: meta.src || 'paper', srcLabel: meta.srcLabel || '', paperId: meta.paperId || '', page: meta.page || 0,
    createdBy: window.McgheeLab?.Auth?.currentUser?.uid || '',
    createdAt: FV().serverTimestamp(), updatedAt: FV().serverTimestamp()
  };
  try {
    await boardsCol(S.classId, S.coll).doc(S.boardId).collection('items').doc(itemId).set(doc);
    toast(`Added to page ${at.pageNum}.`);
    return itemId;
  } catch (e) { console.warn('[whiteboard] add text item failed', e); toast('Could not add to the board.'); return null; }
}

/* ================================================================
   EXPORT (V3.685) — flatten the board to PNG pages
   ================================================================
   Used by the homework modules so a student's working-out rides the
   existing results file into D2L. Renders off-screen at a fixed width,
   never through the live canvases, so exporting cannot disturb what is
   on screen. Uses the SAME background painter and stroke renderer as the
   live board, so the export is what the student drew.

   Snapped images are drawn best-effort: they come from Storage and a
   cross-origin image would taint the canvas and make toDataURL throw, so
   each one is attempted independently and a failure just omits it rather
   than losing the whole export. In practice a student's homework board
   has ink only. */
function loadImg(url) {
  return new Promise((resolve) => {
    const im = new Image();
    im.crossOrigin = 'anonymous';
    im.onload = () => resolve(im);
    im.onerror = () => resolve(null);
    im.src = url;
  });
}

/** Replace who this board is shared with. Notes boards only — hwBoards
 *  have no sharing clause in the rules at all, so a write here would be
 *  rejected server-side even if a client tried it. */
async function setSharedWith(uids) {
  if (!S) return false;
  if (S.coll !== 'notesBoards') { toast('Homework boards cannot be shared.'); return false; }
  const list = Array.from(new Set((uids || []).filter(Boolean))).slice(0, 50);
  try {
    await boardsCol(S.classId, S.coll).doc(S.boardId)
      .update({ sharedWithUids: list, updatedAt: FV().serverTimestamp() });
    return true;
  } catch (e) {
    console.warn('[whiteboard] share update failed', e);
    toast('Could not update sharing.');
    return false;
  }
}

async function exportBoardPNGs(opts) {
  if (!S) return [];
  if (infinite()) return exportPlanePNG(opts);            // V3.841 — one image of the plane's content
  const W = Math.max(600, Math.min(3000, opts?.width || 1600));
  const H = Math.round(W * BOARD_H);
  const pages = (S.board?.pages || []);
  const out = [];
  for (const page of pages) {
    const strokes = [...S.strokes.values()]
      .filter(s => s.pageId === page.id && !s.erasedAt && !s.hiddenBy)
      .sort((a, b) => (a.seq || 0) - (b.seq || 0));
    const items = [...S.items.values()]
      .filter(i => i.pageId === page.id)
      .sort((a, b) => (a.z || 0) - (b.z || 0));
    if (!strokes.length && !items.length && pages.length > 1) continue;  // skip blank extra pages
    const cv = document.createElement('canvas');
    cv.width = W; cv.height = H;
    const ctx = cv.getContext('2d');
    ctx.fillStyle = '#ffffff';
    ctx.fillRect(0, 0, W, H);
    if (page.kind !== 'sim') paintBackgroundInto(ctx, W, H, page.background || 'blank');
    for (const it of items) {
      const iw = (it.w || 0.4) * W;
      if (it.type === 'region') { drawRegionItem(ctx, it, W); continue; }   /* V3.842 */
      if (it.type === 'regionref') { drawWidgetItem(ctx, Object.assign({}, it, { type: 'widget', kind: 'regionref', kindLabel: 'Instance' }), W); continue; }
      if (it.type === 'text') { drawTextItem(ctx, it, W); continue; }   /* V3.830 */
      if (it.type === 'widget') { drawWidgetItem(ctx, it, W); continue; } /* V3.833 */
      const im = await loadImg(it.fullUrl || it.url);
      if (!im) continue;
      try { ctx.drawImage(im, (it.x || 0) * W, (it.y || 0) * W, iw, iw / (it.ar || 1.6)); }
      catch (e) { /* tainted or broken — omit this one, keep the page */ }
    }
    /* V3.837 — wires between cards on this page */
    if (S.wiresEnabled && S.wires.size) {
      const rectU = (id) => { const i = S.items.get(id); if (!i || i.pageId !== page.id) return null; return { x: (i.x || 0) * W, y: (i.y || 0) * W, w: (i.w || 0.4) * W, h: itemHeightU(id, i) * W }; };
      ctx.save(); ctx.strokeStyle = '#475569'; ctx.fillStyle = '#475569'; ctx.lineWidth = Math.max(1, W * 0.0015);
      S.wires.forEach(w => {
        const a = rectU(w.from), b = rectU(w.to); if (!a || !b) return;
        const p1 = edgePoint(a, { x: b.x + b.w / 2, y: b.y + b.h / 2 }), p2 = edgePoint(b, { x: a.x + a.w / 2, y: a.y + a.h / 2 });
        ctx.beginPath(); ctx.moveTo(p1.x, p1.y); ctx.lineTo(p2.x, p2.y); ctx.stroke();
        const ang = Math.atan2(p2.y - p1.y, p2.x - p1.x), L = Math.max(6, W * 0.008);
        ctx.beginPath(); ctx.moveTo(p2.x, p2.y); ctx.lineTo(p2.x - L * Math.cos(ang - 0.4), p2.y - L * Math.sin(ang - 0.4)); ctx.lineTo(p2.x - L * Math.cos(ang + 0.4), p2.y - L * Math.sin(ang + 0.4)); ctx.closePath(); ctx.fill();
      });
      ctx.restore();
    }
    /* V3.730 — ink may overhang a page edge onto the desk; the export is
       the page, so clip to it. */
    ctx.save(); ctx.beginPath(); ctx.rect(0, 0, W, H); ctx.clip();
    strokes.forEach(s => paintStroke(ctx, s, W));
    ctx.restore();
    let dataUrl = '';
    try { dataUrl = cv.toDataURL('image/webp', 0.85); }
    catch (e) { console.warn('[whiteboard] export tainted, skipping page', e); continue; }
    out.push({ pageId: page.id, width: W, height: H, dataUrl });
  }
  return out;
}

/* V3.830 — the export's text card: the same proportions as the DOM card
   (font 1.7 % of the page width, padding, a citation line). */
function drawTextItem(ctx, it, W) {
  const x = (it.x || 0) * W, y = (it.y || 0) * W, w = (it.w || 0.4) * W;
  const fs = Math.max(6, W * 0.017), pad = fs * 0.7, lh = fs * 1.35;
  const wrap = (text, font, maxW) => {
    ctx.font = font;
    const out = [];
    String(text || '').split(/\n/).forEach(par => {
      let line = '';
      par.split(/\s+/).forEach(word => {
        const t = line ? line + ' ' + word : word;
        if (ctx.measureText(t).width > maxW && line) { out.push(line); line = word; } else line = t;
      });
      out.push(line);
    });
    return out;
  };
  const qf = `${fs}px Georgia, serif`, cf = `${fs * 0.8}px system-ui, sans-serif`;
  const ql = wrap(it.text, qf, w - 2 * pad);
  const cl = it.cite ? wrap(it.cite, cf, w - 2 * pad) : [];
  const h = pad * 2 + ql.length * lh + (cl.length ? fs * 0.4 + cl.length * lh * 0.8 : 0);
  ctx.save();
  ctx.fillStyle = '#fffbe6'; ctx.strokeStyle = '#f0d58a'; ctx.lineWidth = Math.max(1, W * 0.0008);
  ctx.beginPath(); ctx.rect(x, y, w, h); ctx.fill(); ctx.stroke();
  ctx.fillStyle = '#111827'; ctx.font = qf; ctx.textBaseline = 'top';
  let cy = y + pad;
  ql.forEach(l => { ctx.fillText(l, x + pad, cy); cy += lh; });
  if (cl.length) { cy += fs * 0.4; ctx.fillStyle = '#6b7280'; ctx.font = cf; cl.forEach(l => { ctx.fillText(l, x + pad, cy); cy += lh * 0.8; }); }
  ctx.restore();
}

/* V3.833 — the export's widget card: kind label, title and the summary. */
function drawWidgetItem(ctx, it, W) {
  const x = (it.x || 0) * W, y = (it.y || 0) * W, w = (it.w || 0.42) * W;
  const fs = Math.max(6, W * 0.0155 * widgetScale(it)), pad = fs * 0.7, lh = fs * 1.35;
  const wrap = (text, font, maxW) => {
    ctx.font = font;
    const out = [];
    String(text || '').split(/\n/).forEach(par => {
      let line = '';
      par.split(/\s+/).forEach(word => {
        const t = line ? line + ' ' + word : word;
        if (ctx.measureText(t).width > maxW && line) { out.push(line); line = word; } else line = t;
      });
      out.push(line);
    });
    return out;
  };
  const hf = `600 ${fs * 0.95}px system-ui, sans-serif`, kf = `${fs * 0.72}px system-ui, sans-serif`, bf = `${fs * 0.9}px system-ui, sans-serif`;
  const kind = widgetMeta(it).label.toUpperCase();
  const tl = wrap(it.title || '', hf, w - 2 * pad);
  const bl = it.collapsed ? [] : wrap(widgetSummary(it), bf, w - 2 * pad).slice(0, 12);
  const h = pad * 2 + lh * 0.8 + (it.title ? tl.length * lh : 0) + bl.length * lh * 0.95;
  ctx.save();
  ctx.fillStyle = '#ffffff'; ctx.strokeStyle = '#cbd5e1'; ctx.lineWidth = Math.max(1, W * 0.0008);
  ctx.beginPath(); ctx.rect(x, y, w, h); ctx.fill(); ctx.stroke();
  if (it.color && /^#[0-9a-f]{6}$/i.test(it.color)) { ctx.fillStyle = it.color; ctx.fillRect(x, y, w, pad + lh * 0.8); }   // V3.839 — the card's colour
  ctx.textBaseline = 'top';
  let cy = y + pad;
  ctx.fillStyle = '#6b7280'; ctx.font = kf; ctx.fillText(kind, x + pad, cy); cy += lh * 0.8;
  if (it.title) { ctx.fillStyle = '#111827'; ctx.font = hf; tl.forEach(l => { ctx.fillText(l, x + pad, cy); cy += lh; }); }
  ctx.fillStyle = '#374151'; ctx.font = bf; bl.forEach(l => { ctx.fillText(l, x + pad, cy); cy += lh * 0.95; });
  ctx.restore();
}

/** Write a snapped image onto the board's CURRENTLY LIVE page.
 *  meta: { url, fullUrl, storagePath, ar, srcLabel, srcModule } */
async function addImageItem(meta) {
  if (!S) return null;
  if (!S.isAdmin) { toast(isNotebook() ? 'Only the board\'s owner can add to it.' : 'Only class admins can add to the board.'); return null; }
  /* Deliberately the BOARD's active page on a class board, not whatever
     page this screen happens to be showing: "put it where I am teaching".
     They agree unless the viewer scrolled away, and the toast names the
     page so it is never silent. (V3.830: a notebook board places under
     the view instead — newItemPlacement.) */
  const at = newItemPlacement();
  const pageId = at.pageId, pageNum = at.pageNum;
  const itemId = meta.itemId || newId('i');
  const doc = {
    pageId, type: 'image',
    x: at.x, y: at.y,
    w: meta.w || 0.45, ar: meta.ar || 1.6, z: Date.now(),
    url: meta.url || '', fullUrl: meta.fullUrl || meta.url || '',
    storagePath: meta.storagePath || '',
    src: meta.src || 'canvas',
    srcLabel: meta.srcLabel || '',
    srcModule: meta.srcModule || '',
    paperId: meta.paperId || '', page: meta.page || 0,
    createdBy: window.McgheeLab?.Auth?.currentUser?.uid || '',
    createdAt: FV().serverTimestamp(),
    updatedAt: FV().serverTimestamp()
  };
  try {
    await boardsCol(S.classId, S.coll).doc(S.boardId).collection('items').doc(itemId).set(doc);
    toast(isNotebook() ? `Added to page ${pageNum}.` : `Sent to page ${pageNum}.`);
    return itemId;
  } catch (e) {
    console.warn('[whiteboard] add image item failed', e);
    toast('Could not add to the board.');
    return null;
  }
}

/* ─── Ink rendering ─────────────────────────────────────────── */
function pressF(p) {
  const v = 0.4 + 1.2 * (typeof p === 'number' ? p : 0.5);
  return Math.min(1.8, Math.max(0.3, v));
}

function schedulePaint() {
  if (!S || S.repaintQueued) return;
  S.repaintQueued = true;
  requestAnimationFrame(() => {
    if (!S) return;
    S.repaintQueued = false;
    repaint();
  });
}

function repaint() {
  const ink = el('ink');
  if (!ink || !S || !S.sheet) return;
  const ctx = ink.getContext('2d');
  /* clear in DEVICE space, before any transform */
  ctx.setTransform(1, 0, 0, 1, 0, 0);
  ctx.clearRect(0, 0, ink.width, ink.height);
  const lens = lensActive();
  const pw = S.sheet.pageW;
  if (lens) applyViewTransform(ctx, pw);
  /* The pen-down stroke is painted on the live layer, never here: two
     copies of one antialiased edge compound into a hard one. Soft-erased
     strokes (kept for a lecture replay) are hidden. */
  const list = [...S.strokes.values()]
    .filter(s => s !== S.active && !s.erasedAt && !(s.hiddenBy && !S.replay))   /* V3.837 — ink folded into a panel */
    .sort((a, b) => (a.seq || 0) - (b.seq || 0));
  const H = ink.height, ph = BOARD_H * pw;
  list.forEach(s => {
    const [ox, oy] = sheetToPx(0, pageTop(pageIndexOf(s.pageId)));
    /* cull pages well off the canvas (half a page of overhang allowance) */
    if (!lens && (oy > H + ph / 2 || oy + ph < -ph / 2)) return;
    paintStroke(ctx, s, pw, ox, oy);
  });
  if (lens) ctx.setTransform(1, 0, 0, 1, 0, 0);
}

/* V3.683 — Catmull-Rom control points for the segment P1→P2, in canvas
   px. The curve passes THROUGH every sampled point (unlike a plain
   quadratic-midpoint smooth, which shrinks the stroke away from its own
   samples), so smoothing never moves the ink off where the pen went. */
function crControls(x0, y0, x1, y1, x2, y2, x3, y3) {
  return [
    x1 + (x2 - x0) / 6, y1 + (y2 - y0) / 6,
    x2 - (x3 - x1) / 6, y2 - (y3 - y1) / 6
  ];
}

/* ================================================================
   V3.727 — ONE FILLED OUTLINE PER STROKE
   ================================================================
   Why the ink looked "pixelated" even at device resolution (measured,
   see plan V3.727): the V3.683 renderer stroked every Bézier segment as
   its own round-capped stroke() with its own pressure-derived lineWidth.
   Two things follow from that and neither is a raster problem —
     1. Overlapping antialiased strokes COMPOUND their edge coverage
        (1 − (1−α)^k). The live pen path redrew the last four segments on
        every sample, so the edge of the stroke being drawn went
        near-binary: 12 % of edge pixels partially covered → 5 %.
     2. Width changed in STEPS at every segment join. After RDP thins a
        committed stroke to ~8 px between points, the outline is a
        staircase — on the laptop and projector too.
   Fix: flatten the same Catmull-Rom spline into a dense centreline with a
   per-sample half-width from smoothly interpolated pressure, offset it
   both ways into one closed outline (round caps, round joins at sharp
   turns), and fill it ONCE. Single antialiasing pass, continuous width,
   and the in-progress stroke is redrawn whole on its own layer instead of
   overdrawn. exportBoardPNGs() shares paintStroke, so exports match.
   ================================================================ */
const FLATTEN_STEP_PX = 2.5;   // max device px between flattened samples
const WIDTH_SMOOTH_PX = 6;     // ± arc length over which half-widths are averaged
const JOIN_ANGLE      = 0.35;  // rad (~20°) — turns sharper than this get a round join

/* Flatten a stroke's Catmull-Rom spline. Returns { xs, ys, hw, n } in
   canvas px: centreline samples and a half-width per sample. Tangent
   handling at the ends is the V3.683 phantom-point rule (P0 = 3·P1 − 3·P2
   + P3), which measurably beat duplicating the endpoint. */
function flattenStroke(pts, W, base, ox, oy) {
  const n = pts.length / 3;
  const xs = [], ys = [], hw = [];
  ox = ox || 0; oy = oy || 0;
  const push = (x, y, p) => { xs.push(x + ox); ys.push(y + oy); hw.push(Math.max(0.5, base * pressF(p) / 2)); };
  if (n === 1) { push(pts[0] * W, pts[1] * W, pts[2]); return { xs, ys, hw, n: 1 }; }
  push(pts[0] * W, pts[1] * W, pts[2]);
  for (let i = 0; i < n - 1; i++) {
    const x1 = pts[i * 3] * W,       y1 = pts[i * 3 + 1] * W,       p1 = pts[i * 3 + 2];
    const x2 = pts[(i + 1) * 3] * W, y2 = pts[(i + 1) * 3 + 1] * W, p2 = pts[(i + 1) * 3 + 2];
    let x0, y0, x3, y3;
    if (i - 1 >= 0)      { x0 = pts[(i - 1) * 3] * W; y0 = pts[(i - 1) * 3 + 1] * W; }
    else if (n >= 3)     { const ax = pts[(i + 2) * 3] * W, ay = pts[(i + 2) * 3 + 1] * W;
                           x0 = 3 * x1 - 3 * x2 + ax; y0 = 3 * y1 - 3 * y2 + ay; }
    else                 { x0 = x1; y0 = y1; }
    if (i + 2 <= n - 1)  { x3 = pts[(i + 2) * 3] * W; y3 = pts[(i + 2) * 3 + 1] * W; }
    else if (n >= 3)     { x3 = 3 * x2 - 3 * x1 + x0; y3 = 3 * y2 - 3 * y1 + y0; }
    else                 { x3 = x2; y3 = y2; }
    const c = crControls(x0, y0, x1, y1, x2, y2, x3, y3);
    const chord = Math.hypot(x2 - x1, y2 - y1);
    const k = Math.min(16, Math.max(1, Math.ceil(chord / FLATTEN_STEP_PX)));
    for (let j = 1; j <= k; j++) {
      const t = j / k, u = 1 - t;
      const a = u * u * u, b = 3 * u * u * t, cc = 3 * u * t * t, d = t * t * t;
      push(a * x1 + b * c[0] + cc * c[2] + d * x2,
           a * y1 + b * c[1] + cc * c[3] + d * y2,
           p1 + (p2 - p1) * t);
    }
  }
  return { xs, ys, hw, n: xs.length };
}

/* Arc-length box filter on the half-widths. Pencil pressure is noisy from
   one sample to the next; with the outline now continuous that noise would
   ripple the edge at the sampling period, so average over a fixed distance
   in DEVICE px (independent of how densely this stroke happened to be
   sampled). Real pressure changes span far more than ±6 px and survive. */
function smoothHalfWidths(f) {
  const n = f.n;
  if (n < 3) return f.hw;
  const cum = new Float64Array(n);
  for (let i = 1; i < n; i++) cum[i] = cum[i - 1] + Math.hypot(f.xs[i] - f.xs[i - 1], f.ys[i] - f.ys[i - 1]);
  const out = new Array(n);
  let lo = 0, hi = 0, sum = 0;
  for (let i = 0; i < n; i++) {
    while (hi < n && cum[hi] <= cum[i] + WIDTH_SMOOTH_PX) { sum += f.hw[hi]; hi++; }
    while (cum[lo] < cum[i] - WIDTH_SMOOTH_PX) { sum -= f.hw[lo]; lo++; }
    out[i] = sum / (hi - lo);
  }
  return out;
}

/* Trace the outline of a flattened stroke into ctx's current path: down
   the left offsets, round cap, back up the right offsets, round cap.
   Sharp turns get a fan of points around the sample on the OUTER side (a
   round join) so a pen reversal in handwriting cannot leave a notch; the
   inner side folds over itself and the nonzero fill rule absorbs it. */
function traceOutline(ctx, f, hw) {
  const n = f.n, xs = f.xs, ys = f.ys;
  /* unit tangents; a zero-length step reuses the previous direction */
  const tx = new Float64Array(n), ty = new Float64Array(n);
  let px = 1, py = 0;
  for (let i = 0; i < n; i++) {
    const a = Math.max(0, i - 1), b = Math.min(n - 1, i + 1);
    let dx = xs[b] - xs[a], dy = ys[b] - ys[a];
    const L = Math.hypot(dx, dy);
    if (L > 1e-6) { px = dx / L; py = dy / L; }
    tx[i] = px; ty[i] = py;
  }
  const left = [], right = [];
  for (let i = 0; i < n; i++) {
    const nx = -ty[i], ny = tx[i], w = hw[i];
    /* round join: fan on the outer side of a sharp turn */
    if (i > 0 && i < n - 1) {
      const inX = xs[i] - xs[i - 1], inY = ys[i] - ys[i - 1];
      const outX = xs[i + 1] - xs[i], outY = ys[i + 1] - ys[i];
      const cross = inX * outY - inY * outX;
      const dot = inX * outX + inY * outY;
      const ang = Math.atan2(Math.abs(cross), dot);
      if (ang > JOIN_ANGLE) {
        /* cross > 0: the path turns toward the LEFT normal, so the outer
           side is the right one, starting at −n_in and sweeping by +ang;
           mirrored otherwise. */
        const a0 = Math.atan2(-inX, inY) + (cross > 0 ? 0 : Math.PI);
        const steps = Math.max(2, Math.ceil(ang / 0.3));
        const side = cross > 0 ? right : left;                         // outer side
        const dir = cross > 0 ? 1 : -1;
        for (let k = 0; k <= steps; k++) {
          const a = a0 + dir * ang * (k / steps);
          side.push(xs[i] + Math.cos(a) * w, ys[i] + Math.sin(a) * w);
        }
        (cross > 0 ? left : right).push(xs[i] + nx * w * (cross > 0 ? 1 : -1), ys[i] + ny * w * (cross > 0 ? 1 : -1));
        continue;
      }
    }
    left.push(xs[i] + nx * w, ys[i] + ny * w);
    right.push(xs[i] - nx * w, ys[i] - ny * w);
  }
  ctx.moveTo(left[0], left[1]);
  for (let i = 2; i < left.length; i += 2) ctx.lineTo(left[i], left[i + 1]);
  /* end cap: from the left offset around the tip to the right offset */
  const e = n - 1, ea = Math.atan2(tx[e], -ty[e]);
  ctx.arc(xs[e], ys[e], hw[e], ea, ea - Math.PI, true);
  for (let i = right.length - 2; i >= 0; i -= 2) ctx.lineTo(right[i], right[i + 1]);
  const sa = Math.atan2(-tx[0], ty[0]);
  ctx.arc(xs[0], ys[0], hw[0], sa, sa - Math.PI, true);
  ctx.closePath();
}

/* Paint one stroke — a single fill of its outline. `base` is the full
   line width in canvas px at pressure 0.5-ish (pressF scales it). */
function fillStrokeOutline(ctx, pts, color, base, W, ox, oy) {
  const f = flattenStroke(pts, W, base, ox, oy);
  ctx.fillStyle = color;
  ctx.beginPath();
  if (f.n === 1) {
    ctx.arc(f.xs[0], f.ys[0], f.hw[0], 0, Math.PI * 2);
    ctx.fill();
    return;
  }
  traceOutline(ctx, f, smoothHalfWidths(f));
  ctx.fill('nonzero');
}

/** Paint one stroke at page width W (device px), offset by (ox, oy) —
 *  the page's top-left on the sheet canvas. Exports pass no offset. */
function paintStroke(ctx, s, W, ox, oy) {
  const pts = s.pts;
  if (!Array.isArray(pts) || pts.length < 3) return;
  if (s.hl) {
    /* V3.839 — a highlighter: one translucent band, MULTIPLIED so the ink
       under it stays legible; a single fill, so it never darkens itself */
    ctx.save();
    ctx.globalAlpha = HL_ALPHA; ctx.globalCompositeOperation = 'multiply';
    fillStrokeOutline(ctx, pts, s.color || '#fde047', (s.w || HL_DEFAULT_W) * W, W, ox || 0, oy || 0);
    ctx.restore();
    return;
  }
  fillStrokeOutline(ctx, pts, s.color || '#111827', (s.w || 0.004) * W, W, ox || 0, oy || 0);
}

/* The in-progress stroke lives on its OWN canvas and is redrawn WHOLE on
   each animation frame that has new samples. Redrawing the whole stroke
   (not the tail) is the point: any overdraw of an antialiased edge
   compounds its coverage and the edge goes hard — that was the
   "pixelated while drawing". One fill per frame of a ≤3000-point stroke
   is cheap. Pen-up clears this layer and the stroke joins the committed
   repaint on the ink canvas. */
function paintActiveStroke() {
  if (!S || S.livePaintQueued) return;
  S.livePaintQueued = true;
  requestAnimationFrame(() => {
    if (!S) return;
    S.livePaintQueued = false;
    paintLiveNow();
  });
}
function paintLiveNow() {
  const live = el('live');
  const st = S?.active;
  if (!live || !S?.sheet) return;
  const ctx = live.getContext('2d');
  ctx.setTransform(1, 0, 0, 1, 0, 0);
  ctx.clearRect(0, 0, live.width, live.height);
  if (S.regionDrag) drawRegionDrag(ctx);
  if (!st) return;
  const pw = S.sheet.pageW;
  const lens = lensActive();
  if (lens) applyViewTransform(ctx, pw);
  const [ox, oy] = sheetToPx(0, pageTop(pageIndexOf(st.pageId)));
  paintStroke(ctx, st, pw, ox, oy);
  if (lens) ctx.setTransform(1, 0, 0, 1, 0, 0);
}

/* ─── V3.837 ⬚ Region: a rectangle of ink the host turns into a panel ─── */
function drawRegionDrag(ctx) {
  const d = S.regionDrag; const pw = S.sheet.pageW; const lens = lensActive();
  if (lens) applyViewTransform(ctx, pw);
  const [x0, y0] = sheetToPx(Math.min(d.u0, d.u1), Math.min(d.v0, d.v1));
  const [x1, y1] = sheetToPx(Math.max(d.u0, d.u1), Math.max(d.v0, d.v1));
  ctx.save();
  ctx.setLineDash([8, 5]); ctx.lineWidth = Math.max(1.5, pw * 0.0015); ctx.strokeStyle = '#2563eb'; ctx.fillStyle = 'rgba(37,99,235,.07)';
  ctx.fillRect(x0, y0, x1 - x0, y1 - y0); ctx.strokeRect(x0, y0, x1 - x0, y1 - y0);
  ctx.restore();
  if (lens) ctx.setTransform(1, 0, 0, 1, 0, 0);
}
function finishRegion() {
  const d = S.regionDrag; S.regionDrag = null; paintLiveNow();
  if (!d) return;
  const top = pageTop(pageIndexOf(d.pid));
  const rect = { pageId: d.pid, x: round4(Math.min(d.u0, d.u1)), y: round4(Math.min(d.v0, d.v1) - top), w: round4(Math.abs(d.u1 - d.u0)), h: round4(Math.abs(d.v1 - d.v0)) };
  if (rect.w < 0.02 || rect.h < 0.02) return;   // a tap, not a region
  if (d.mode === 'fit') { zoomToRect(rect); return; }
  if (d.mode === 'group') { addRegionItem(rect); return; }          // V3.842 — a region around the cards in the box
  const strokeIds = strokesInRect(rect);
  if (S.onRegion) { try { S.onRegion(rect, strokeIds); } catch (e) { console.warn('[whiteboard] onRegion failed', e); } }
}
/* V3.837 — the pan tool (pen or mouse): scroll the sheet, or pan the lens
   when zoomed, spilling into a scroll at the lens edge. */
function panByPointer(e) {
  const d = S.panDrag; if (!d || !S.sheet) return;
  const dx = e.clientX - d.x, dy = e.clientY - d.y; d.x = e.clientX; d.y = e.clientY;
  if (infinite()) { scrollPlaneBy(dx, dy); return; }         // V3.841 — ✋ pans the plane in both axes
  const ink = el('ink'); const pwCss = S.sheet.pageW / (ink.width / Math.max(1, ink.clientWidth));
  if (lensActive() && S.view.scale > 1) {
    S.view.tx += dx / pwCss;
    const want = S.view.ty + dy / pwCss; S.view.ty = want; clampView();
    const left = (want - S.view.ty) * pwCss;
    if (Math.abs(left) > 0.01 && continuous()) sheetScrollBy(left / S.view.scale);
  } else sheetScrollBy(dy);
  scheduleRedraw();
}
function sheetScrollBy(dyCss) {
  if (infinite()) { scrollPlaneBy(0, dyCss); return; }
  const ink = el('ink'); const pwCss = S.sheet.pageW / (ink.width / Math.max(1, ink.clientWidth));
  S.sheetAnim = null;
  const lo = clampOriginY(-1e9) - 0.15, hi = clampOriginY(1e9) + 0.15;
  S.sheet.originY = Math.min(hi, Math.max(lo, S.sheet.originY - dyCss / pwCss));
  if (continuous()) { pauseFollowByHand(); trackPageUnderCentre(); publishView(false); }
}
/* V3.837 — frame a page-local rectangle: scroll it to the middle of the
   stage and zoom the lens so it fills ~90 % of the view. */
function zoomToRect(rect) {
  if (!S?.sheet) return;
  const ink = el('ink'); const pw = S.sheet.pageW;
  const Wc = ink.width / pw, Hc = ink.height / pw;
  const top = pageTop(pageIndexOf(rect.pageId)) + rect.y;
  const cyS = top + rect.h / 2;
  if (infinite() && lensActive()) {
    /* V3.841 — on the plane the rectangle is framed by origin + scale */
    const s = Math.min(MAX_SCALE, Math.max(minScale(), Math.min(Wc / Math.max(0.02, rect.w), Hc / Math.max(0.02, rect.h)) * 0.9));
    animateView({ o: cyS - (Hc / s) / 2, ox: rect.x + rect.w / 2 - (Wc / s) / 2, s, tx: 0, ty: 0 }, SNAP_MS, () => { if (!S) return; persistView(); if (continuous()) { trackPageUnderCentre(); publishView(true); } renderPills(); });
    return;
  }
  const o = clampOriginY(cyS - Hc / 2);
  const t = { o, s: 1, tx: 0, ty: 0 };
  if (lensActive()) {
    t.s = Math.min(MAX_SCALE, Math.max(minScale(), Math.min(Wc / Math.max(0.02, rect.w), Hc / Math.max(0.02, rect.h)) * 0.9));
    const cx = S.sheet.offX / pw + rect.x + rect.w / 2, cy = cyS - o;
    t.tx = Math.min(0, Math.max(Wc * (1 - t.s), Wc / 2 - cx * t.s));
    t.ty = Math.min(0, Math.max(Hc * (1 - t.s), Hc / 2 - cy * t.s));
  }
  animateView(t, SNAP_MS, () => { if (!S) return; persistView(); if (continuous()) { trackPageUnderCentre(); publishView(true); } renderPagesBar(); renderPills(); });
}

/* ─── V3.839 / V3.841 the canvas scales with its items ─────────────── */
/** Bounds of a stroke in its page's frame: { l, t, r, b } or null. */
function strokeBounds(s) {
  const pts = s.pts; if (!Array.isArray(pts) || !pts.length) return null;
  let l = Infinity, t = Infinity, r = -Infinity, b = -Infinity;
  const add = (x, y) => { if (x < l) l = x; if (x > r) r = x; if (y < t) t = y; if (y > b) b = y; };
  if (Array.isArray(pts[0])) pts.forEach(p => add(p[0], p[1]));
  else for (let i = 0; i + 1 < pts.length; i += 3) add(pts[i], pts[i + 1]);
  return isFinite(l) ? { l, t, r, b } : null;
}
/** Sheet extent of everything on the board (cards + ink), page-width units. */
function contentExtent() {
  let left = Infinity, top = Infinity, right = -Infinity, bottom = -Infinity;
  if (S) {
    S.items.forEach((it, id) => { const t = pageTop(pageIndexOf(it.pageId)) + (it.y || 0), x = it.x || 0; left = Math.min(left, x); right = Math.max(right, x + (it.w || 0.4)); top = Math.min(top, t); bottom = Math.max(bottom, t + (it.type === 'region' ? (it.collapsed ? 0.03 : (it.h || 0.3)) : itemHeightU(id, it))); });
    S.strokes.forEach(s => { if (s.erasedAt || s.hiddenBy) return; const b = strokeBounds(s); if (!b) return; const t = pageTop(pageIndexOf(s.pageId)); left = Math.min(left, b.l); right = Math.max(right, b.r); top = Math.min(top, t + b.t); bottom = Math.max(bottom, t + b.b); });
  }
  if (!isFinite(top) || bottom <= top) { top = 0; bottom = BOARD_H; }
  if (!isFinite(left) || right <= left) { left = 0; right = 1; }
  if (infinite()) return { left: left - 0.02, top: top - 0.02, right: right + 0.02, bottom: bottom + 0.02 };
  return { left: Math.max(0, left - 0.02), right: Math.min(1, right + 0.02), top: Math.max(0, top - 0.02), bottom: Math.min(pageTop(pageCount() - 1) + BOARD_H, bottom + 0.02) };
}
/** ⊡ Fit everything: zoom (≤ 100 %) and scroll so all content is on the screen. */
function fitAll() {
  if (!S?.sheet || !lensActive()) return;
  const ink = el('ink'); const pw = S.sheet.pageW; const Wc = ink.width / pw, Hc = ink.height / pw;
  const ext = contentExtent(); const h = Math.max(0.1, ext.bottom - ext.top), w = Math.max(0.1, ext.right - ext.left);
  const done = () => { if (!S) return; persistView(); if (continuous()) { trackPageUnderCentre(); publishView(true); } renderPagesBar(); renderPills(); };
  if (infinite()) {
    /* V3.841 — the plane: frame the content's bounding box by origin + scale */
    const s = Math.min(1, Math.max(minScale(), Math.min(Wc / w, Hc / h) * 0.94));
    animateView({ o: ext.top + h / 2 - (Hc / s) / 2, ox: ext.left + w / 2 - (Wc / s) / 2, s, tx: 0, ty: 0 }, SNAP_MS, done);
    return;
  }
  const s = Math.min(1, Math.max(minScale(), Math.min(Wc, Hc / h) * 0.96));
  const vh = Hc / s;
  const o = clampOriginYAt(ext.top - (vh - h) / 2, vh);
  animateView({ o, s, tx: isNotebook() ? Wc * (1 - s) / 2 : 0, ty: 0 }, SNAP_MS, done);
}
/** V3.853 — centre the view on ONE card and pulse it. A My Week result links
 *  `figure-board.html?paper=…&item=<id>` / `notebook.html?entry=…&item=<id>`
 *  and the host calls this right after mounting, so it retries while the
 *  items snapshot is still arriving (≈5 s). On the plane it pans x and y at
 *  the current zoom (never below minScale); a paged board scrolls the sheet.
 *  The pulse is a CSS ring on the card node (`.wb-item-flash`). */
function focusItemById(id, tries) {
  tries = tries || 0;
  if (!S || !id) return false;
  const it = S.items.get(id);
  if (!it) {
    if (tries < 25) setTimeout(() => focusItemById(id, tries + 1), 200);
    return false;
  }
  const flash = () => {
    const n = S && S.itemNodes ? S.itemNodes.get(id) : null;
    if (!n) return;
    n.classList.remove('wb-item-flash'); void n.offsetWidth; n.classList.add('wb-item-flash');
    setTimeout(() => { try { n.classList.remove('wb-item-flash'); } catch (e) {} }, 2600);
  };
  try {
    const h = itemHeightU(id, it), w = it.w || 0.3;
    const cx = (it.x || 0) + w / 2, cy = (it.y || 0) + h / 2;
    if (S.sheet && lensActive() && infinite()) {
      const ink = el('ink'); const pw = S.sheet.pageW; const Wc = ink.width / pw, Hc = ink.height / pw;
      const s = Math.max(minScale(), Math.min(1, frameState().s || 1));
      const done = () => { if (!S) return; persistView(); if (continuous()) { trackPageUnderCentre(); publishView(true); } renderPagesBar(); renderPills(); flash(); };
      animateView({ o: cy - (Hc / s) / 2, ox: cx - (Wc / s) / 2, s, tx: 0, ty: 0 }, SNAP_MS, done);
      return true;
    }
    if (S.sheet) { scrollSheetTo(cy, SNAP_MS); setTimeout(flash, SNAP_MS + 20); return true; }
  } catch (e) { console.warn('[whiteboard] focusItem failed', e); }
  flash();
  return true;
}
/** The sheet grows with its content (paged host boards only — the V3.841
 *  plane has no end): when a card's foot or a stroke on the LAST page
 *  reaches its lower 8 %, a page is appended. Owner, never in replay. */
function scheduleGrow() {
  if (!S || S._growT || !S.isAdmin || !isNotebook() || infinite() || S.replay) return;
  S._growT = setTimeout(() => { if (S) { S._growT = null; growSheetIfNeeded(); } }, 400);
}
function growSheetIfNeeded() {
  if (!S || !S.isAdmin || !isNotebook() || infinite() || S.replay || !S.sheet || S._growing) return;
  const pages = S.board?.pages || []; const n = pages.length;
  if (!n || n >= 60) return;
  const last = pages[n - 1].id, limit = BOARD_H - 0.08;
  let need = false;
  S.items.forEach((it, id) => { if (!need && it.pageId === last && (it.y || 0) + itemHeightU(id, it) > limit) need = true; });
  if (!need) S.strokes.forEach(s => { if (need || s.pageId !== last || s.erasedAt) return; const b = strokeBounds(s); if (b && b.b > limit) need = true; });
  if (!need) return;
  S._growing = true;
  appendPageNoMove().then(() => { if (S) S._growing = false; }, () => { if (S) S._growing = false; });
}
/* V3.841 — the plane's one scroll: wheel, two fingers, a viewer's finger,
   the ✋ pan tool and the lens spill all land here. Screen px → plane units
   through the page width AND the scale. Unclamped: the canvas has no end. */
function scrollPlaneBy(dxCss, dyCss) {
  if (!S?.sheet) return;
  const ink = el('ink'); const pwCss = S.sheet.pageW / (ink.width / Math.max(1, ink.clientWidth));
  const s = lensActive() ? S.view.scale : 1;
  S.sheetAnim = null;
  S.sheet.originX = (S.sheet.originX || 0) - dxCss / (pwCss * s);
  S.sheet.originY -= dyCss / (pwCss * s);
  if (continuous()) { trackPageUnderCentre(); publishView(false); }
  scheduleRedraw();
}
function originKey() { return `wb_origin_${S?.classId}_${S?.boardId}`; }
function restoreOrigin() {
  if (!S?.sheet || !infinite()) return;
  try { const o = JSON.parse(localStorage.getItem(originKey()) || 'null'); if (o && isFinite(+o.x) && isFinite(+o.y)) { S.sheet.originX = +o.x; S.sheet.originY = +o.y; } } catch (e) {}
}
/* V3.841 — one image of the plane's content (bounding box + margin). */
async function exportPlanePNG(opts) {
  const ext = contentExtent(); const m = 0.03;
  const l = ext.left - m, t = ext.top - m, w = Math.max(0.2, ext.right - ext.left + 2 * m), h = Math.max(0.2, ext.bottom - ext.top + 2 * m);
  let k = Math.max(600, Math.min(3000, opts?.width || 1600)) / w;      // px per plane unit
  if (h * k > 6000) k = 6000 / h;
  const cv = document.createElement('canvas'); cv.width = Math.max(8, Math.round(w * k)); cv.height = Math.max(8, Math.round(h * k));
  const ctx = cv.getContext('2d');
  ctx.fillStyle = '#ffffff'; ctx.fillRect(0, 0, cv.width, cv.height);
  ctx.translate(-l * k, -t * k);
  const items = [...S.items.entries()].sort((a, b) => (a[1].z || 0) - (b[1].z || 0));
  for (const [, it] of items) {
    const iw = (it.w || 0.4) * k;
    if (it.type === 'region') { drawRegionItem(ctx, it, k); continue; }
    if (it.type === 'regionref') { drawWidgetItem(ctx, Object.assign({}, it, { type: 'widget', kind: 'regionref', kindLabel: 'Instance' }), k); continue; }
    if (it.type === 'text') { drawTextItem(ctx, it, k); continue; }
    if (it.type === 'widget') { drawWidgetItem(ctx, it, k); continue; }
    const im = await loadImg(it.fullUrl || it.url);
    if (!im) continue;
    try { ctx.drawImage(im, (it.x || 0) * k, (it.y || 0) * k, iw, iw / (it.ar || 1.6)); } catch (e) {}
  }
  if (S.wiresEnabled && S.wires.size) {
    const rectU = (id) => { const i = S.items.get(id); if (!i) return null; return { x: (i.x || 0) * k, y: (i.y || 0) * k, w: (i.w || 0.4) * k, h: itemHeightU(id, i) * k }; };
    ctx.save(); ctx.strokeStyle = '#475569'; ctx.fillStyle = '#475569'; ctx.lineWidth = Math.max(1, k * 0.0015);
    S.wires.forEach(wd => {
      const a = rectU(wd.from), b = rectU(wd.to); if (!a || !b) return;
      const p1 = wd.fromSide ? portPoint(a, wd.fromSide) : edgePoint(a, { x: b.x + b.w / 2, y: b.y + b.h / 2 }), p2 = wd.toSide ? portPoint(b, wd.toSide) : edgePoint(b, { x: a.x + a.w / 2, y: a.y + a.h / 2 });
      ctx.beginPath(); ctx.moveTo(p1.x, p1.y); ctx.lineTo(p2.x, p2.y); ctx.stroke();
      const ang = Math.atan2(p2.y - p1.y, p2.x - p1.x), L = Math.max(6, k * 0.008);
      ctx.beginPath(); ctx.moveTo(p2.x, p2.y); ctx.lineTo(p2.x - L * Math.cos(ang - 0.4), p2.y - L * Math.sin(ang - 0.4)); ctx.lineTo(p2.x - L * Math.cos(ang + 0.4), p2.y - L * Math.sin(ang + 0.4)); ctx.closePath(); ctx.fill();
    });
    ctx.restore();
  }
  [...S.strokes.values()].filter(s => !s.erasedAt && !s.hiddenBy).sort((a, b) => (a.seq || 0) - (b.seq || 0)).forEach(s => paintStroke(ctx, s, k));
  let dataUrl = '';
  try { dataUrl = cv.toDataURL('image/webp', 0.85); } catch (e) { console.warn('[whiteboard] export tainted', e); return []; }
  return [{ pageId: planeId(), width: cv.width, height: cv.height, dataUrl }];
}
/* V3.841 — the plane's graph paper: lines on the plane's grid (1/32 of a
   page width), scrolling with the content, thinning out when zoomed far out */
function paintPlaneGrid(ctx, W, H, kind) {
  if (!kind || kind === 'blank' || !S?.sheet) return;
  const pw = S.sheet.pageW, s = lensActive() ? S.view.scale : 1;
  const stepU = 1 / 32, step = stepU * pw * s;
  if (step < 5) return;
  const th = S.theme || {};
  ctx.save();
  ctx.strokeStyle = kind === 'ruled' ? (th.ruled || '#dbeafe') : (th.grid || '#e5e7eb');
  ctx.lineWidth = 1;
  const oX = S.sheet.originX || 0, oY = S.sheet.originY, ox = S.sheet.offX;
  const line = (x0, y0, x1, y1) => { ctx.beginPath(); ctx.moveTo(x0, y0); ctx.lineTo(x1, y1); ctx.stroke(); };
  if (kind !== 'ruled') {
    const x0 = (Math.floor(oX / stepU) * stepU - oX) * pw * s + ox;
    for (let x = x0; x < W; x += step) line(Math.round(x) + 0.5, 0, Math.round(x) + 0.5, H);
  }
  const yStepU = kind === 'ruled' ? stepU * 1.5 : stepU, yStep = yStepU * pw * s;
  const y0 = (Math.floor(oY / yStepU) * yStepU - oY) * pw * s;
  for (let y = y0; y < H; y += yStep) line(0, Math.round(y) + 0.5, W, Math.round(y) + 0.5);
  ctx.restore();
}

/* ─── V3.842 regions: a named, coloured box around the cards inside it ────
   Membership is GEOMETRIC — the cards whose centre lies in the box — so
   drawing a box around cards is grouping, and dragging a card out leaves
   it. Regions are plain items (rules, export, replay need nothing new). */
function regionRect(it) { return { x: it.x || 0, y: pageTop(pageIndexOf(it.pageId)) + (it.y || 0), w: it.w || 0.3, h: it.h || 0.3 }; }
function rectContains(r, p) { return p.x >= r.x && p.x <= r.x + r.w && p.y >= r.y && p.y <= r.y + r.h; }
function itemCentre(id, it) { return { x: (it.x || 0) + (it.w || 0.4) / 2, y: pageTop(pageIndexOf(it.pageId)) + (it.y || 0) + itemHeightU(id, it) / 2 }; }
function itemRectU(id, it) { return { x: it.x || 0, y: pageTop(pageIndexOf(it.pageId)) + (it.y || 0), w: it.w || 0.4, h: it.type === 'region' ? (it.collapsed ? 0.03 : (it.h || 0.3)) : itemHeightU(id, it) }; }
/* V3.843 — membership is EXPLICIT: a card belongs to a region when it was
   drawn around, dropped into, created inside or organised into it
   (`members` on the region doc). The box fits those cards and nothing
   else, so a growing region never swallows its neighbours. Regions made
   before V3.843 have no list and fall back to "whose centre is inside". */
function regionMembers(rid, it) {
  if (Array.isArray(it.members)) return it.members.filter(id => id !== rid && S.items.has(id) && S.items.get(id).type !== 'region');
  return cardsInside(regionRect(it), rid);
}
function cardsInside(r, skipId) {
  const out = [];
  S.items.forEach((o, oid) => { if (oid === skipId || o.type === 'region') return; if (rectContains(r, itemCentre(oid, o))) out.push(oid); });
  return out;
}
function regionsHolding(id) { return [...S.items.entries()].filter(([rid, r]) => r.type === 'region' && regionMembers(rid, r).includes(id)).map(([rid]) => rid); }
async function setRegionMembers(rid, members, opts) {
  const reg = S?.items.get(rid); if (!reg) return false;
  const mem = [...new Set(members)].filter(id => S.items.has(id) && S.items.get(id).type !== 'region');
  await updateItem(rid, { members: mem });
  if (mem.length) await fitRegionToMembers(rid, { shrink: !(opts && opts.growOnly) });
  return true;
}
/** A card created or dropped at `centre` joins the region under it (the one it already belongs to wins). */
function regionUnder(centre, preferIds) {
  const inside = regionsContaining(centre);
  return inside.find(rid => (preferIds || []).includes(rid)) || inside[0] || null;
}
async function adoptIntoRegion(itemId, centre) {
  const rid = regionUnder(centre); if (!rid) return null;
  const reg = S.items.get(rid); const mem = regionMembers(rid, reg);
  if (!mem.includes(itemId)) await setRegionMembers(rid, mem.concat([itemId]), { growOnly: true });
  return rid;
}
/* V3.843 — a region hugs its cards: padding around their bounding box, room
   for the header above. Grow-only while cards change on their own (typing,
   a longer body); grow AND shrink when a card is dropped or ⤢ is pressed. */
const REGION_PAD = { x: 0.02, top: 0.05, bottom: 0.02 };
function membersBBox(ids) {
  let l = Infinity, t = Infinity, r = -Infinity, b = -Infinity;
  ids.forEach(id => { const it = S.items.get(id); if (!it) return; const rc = itemRectU(id, it); l = Math.min(l, rc.x); t = Math.min(t, rc.y); r = Math.max(r, rc.x + rc.w); b = Math.max(b, rc.y + rc.h); });
  return isFinite(l) ? { l, t, r, b } : null;
}
function fittedRect(reg, ids, shrink) {
  const bb = membersBBox(ids); if (!bb) return null;
  const top = pageTop(pageIndexOf(reg.pageId));
  let nx = bb.l - REGION_PAD.x, ny = bb.t - REGION_PAD.top, nr = bb.r + REGION_PAD.x, nb = bb.b + REGION_PAD.bottom;
  if (!shrink) { const cur = regionRect(reg); nx = Math.min(nx, cur.x); ny = Math.min(ny, cur.y); nr = Math.max(nr, cur.x + cur.w); nb = Math.max(nb, cur.y + cur.h); }
  return { x: round4(nx), y: round4(ny - top), w: round4(Math.max(0.08, nr - nx)), h: round4(Math.max(0.06, nb - ny)) };
}
async function fitRegionToMembers(rid, opts) {
  const reg = S?.items.get(rid); if (!reg || reg.type !== 'region' || !S.isAdmin || reg.collapsed) return false;
  const ids = (opts && opts.members) || regionMembers(rid, reg);
  const next = fittedRect(reg, ids, !!(opts && opts.shrink)); if (!next) return false;
  if (['x', 'y', 'w', 'h'].every(k => Math.abs(next[k] - (reg[k] || 0)) < 1e-4)) return false;
  animateMoves();
  return updateItem(rid, next);
}
function regionsContaining(p) { return [...S.items.entries()].filter(([, r]) => r.type === 'region' && !r.collapsed && rectContains(regionRect(r), p)).map(([id]) => id); }
function scheduleRegionFit() {
  if (!S || S._rfitT || !S.isAdmin || S.replay || !isNotebook()) return;
  S._rfitT = setTimeout(() => { if (!S) return; S._rfitT = null; if (S.draggingItemId) return; S.items.forEach((r, rid) => { if (r.type === 'region' && !r.collapsed) fitRegionToMembers(rid, { shrink: false }); }); }, 450);
}
function buildRegionNode(id, it) {
  const node = document.createElement('div');
  node.dataset.itemId = id; node.className = 'wb-item wb-region';
  const canEdit = !!S?.isAdmin;
  node.innerHTML = `<div class="wb-rh" data-wb-rhead>
      ${reportBtnHTML(it, 'wb-rreport')}
      <button type="button" class="wb-rsw" data-wb-rcolor title="Colour of the region"></button>
      <input type="text" class="wb-rtitle" placeholder="Region" ${canEdit ? '' : 'readonly'}>
      <span class="wb-rcount"></span>
      ${canEdit ? '<button type="button" class="wb-rfit" data-wb-rfit title="Fit the region to its cards">⤢</button>' : ''}
      <button type="button" class="wb-rchev" data-wb-rcollapse title="Collapse / open the region">▾</button>
      ${canEdit ? '<button type="button" class="wb-rmore" data-wb-rremove title="Remove the region (two taps; the cards stay)">×</button>' : ''}
    </div>${canEdit ? '<span class="wb-rgrip" data-wb-rgrip title="Drag to resize the region"></span>' : ''}`;
  const title = node.querySelector('.wb-rtitle');
  title.addEventListener('change', () => { if (S?.isAdmin) updateItem(id, { title: title.value.trim().slice(0, 120) }); });
  title.addEventListener('keydown', (e) => { e.stopPropagation(); if (e.key === 'Enter') { e.preventDefault(); title.blur(); } });
  node.querySelector('[data-wb-rcollapse]').addEventListener('click', (e) => { e.stopPropagation(); if (S?.isAdmin) toggleRegion(id); });
  node.querySelector('[data-wb-rcolor]').addEventListener('click', (e) => { e.stopPropagation(); if (S?.isAdmin) toggleRegionPalette(node, id); });
  wireReportBtn(node, id);   /* V3.854 */
  const fitBtn = node.querySelector('[data-wb-rfit]');
  if (fitBtn) fitBtn.addEventListener('click', (e) => { e.stopPropagation(); if (S?.isAdmin) fitRegionToMembers(id, { shrink: true }).then(ch => { if (!ch) toast(regionMembers(id, S.items.get(id)).length ? 'Already snug.' : 'No cards inside this region yet.'); }); });
  const rm = node.querySelector('[data-wb-rremove]');
  if (rm) rm.addEventListener('click', (e) => { e.stopPropagation(); if (!armTwoTap(rm, '✓')) return; deleteItem(id); });
  node.addEventListener('keydown', (e) => e.stopPropagation());
  return node;
}
function updateRegionChrome(node, id, it) {
  syncReportBtn(node, it);   /* V3.854 */
  const col = /^#[0-9a-f]{6}$/i.test(it.color || '') ? it.color : REGION_COLORS[0];
  node.style.setProperty('--wb-rcol', col);
  node.classList.toggle('wb-collapsed', !!it.collapsed);
  const t = node.querySelector('.wb-rtitle'); if (t && document.activeElement !== t && t.value !== (it.title || '')) t.value = it.title || '';
  const sw = node.querySelector('.wb-rsw'); if (sw) sw.style.background = col;
  const ch = node.querySelector('.wb-rchev'); if (ch) ch.textContent = it.collapsed ? '▸' : '▾';
  const n = regionMembers(id, it).length; const c = node.querySelector('.wb-rcount'); if (c) c.textContent = n ? `${n} card${n === 1 ? '' : 's'}` : '';
}
function toggleRegionPalette(node, id) {
  const open = node.querySelector(':scope > .wb-tint-pop');
  document.querySelectorAll('.wb-tint-pop').forEach(n => n.remove());
  if (open || !S) return;
  const cur = S.items.get(id); if (!cur) return;
  const pop = document.createElement('div'); pop.className = 'wb-tint-pop wb-rpal';
  pop.innerHTML = REGION_COLORS.map(c => `<button type="button" class="wb-tint-sw${(cur.color || REGION_COLORS[0]) === c ? ' wb-sel' : ''}" data-wb-act="region-color" data-item="${escAttr(id)}" data-color="${c}" style="background:${c}" title="${c}" aria-label="Colour ${c}"></button>`).join('');
  pop.addEventListener('click', (e) => { const b = e.target.closest('[data-wb-act="region-color"]'); if (!b) return; e.stopPropagation(); handleBoardAction('region-color', b); pop.remove(); });
  pop.addEventListener('pointerdown', (e) => e.stopPropagation());
  node.appendChild(pop);
  const close = (e) => { if (!pop.contains(e.target)) { pop.remove(); document.removeEventListener('pointerdown', close, true); } };
  setTimeout(() => document.addEventListener('pointerdown', close, true), 0);
}
/** Tools → ▭: the box the pen drew becomes a region (name "Region N", the next colour). */
async function addRegionItem(rect, extra) {
  if (!S || !S.isAdmin) return null;
  const n = [...S.items.values()].filter(i => i.type === 'region').length;
  const id = newId('g');
  /* V3.843 — the box snaps to the cards inside it (an empty box stays as drawn) */
  const draft = { pageId: rect.pageId, x: rect.x, y: rect.y, w: Math.max(0.08, rect.w), h: Math.max(0.06, rect.h) };
  const members = (extra && Array.isArray(extra.members)) ? extra.members : cardsInside(regionRect(draft), id);
  const fit = fittedRect(draft, members, true);
  if (fit) Object.assign(rect, fit);
  const doc = { pageId: rect.pageId, type: 'region', members, x: round4(rect.x), y: round4(rect.y), w: round4(Math.max(0.08, rect.w)), h: round4(Math.max(0.06, rect.h)),
    title: (extra && extra.title) || `Region ${n + 1}`, color: (extra && extra.color) || REGION_COLORS[n % REGION_COLORS.length], collapsed: false, z: -1000 + n,
    ar: 1, url: '', fullUrl: '', storagePath: '', text: '', createdBy: window.McgheeLab?.Auth?.currentUser?.uid || '', createdAt: FV().serverTimestamp(), updatedAt: FV().serverTimestamp() };
  try { await boardsCol(S.classId, S.coll).doc(S.boardId).collection('items').doc(id).set(doc); S.tool = 'pen'; renderToolbar(); return id; }
  catch (e) { console.warn('[whiteboard] add region failed', e); toast('Could not add the region.'); return null; }
}
async function toggleRegion(id) {
  const it = S?.items.get(id); if (!it) return;
  const opening = !!it.collapsed;
  await updateItem(id, { collapsed: !opening });
  if (opening) displaceAround(id);
}
/** Opening a region: every OTHER card overlapping its box moves out of the
 *  way the shortest way (down or right), in cascades until nothing
 *  overlaps; one batch write; CSS animates the move. */
async function displaceAround(rid) {
  const reg = S?.items.get(rid); if (!reg || !S.isAdmin) return 0;
  const members = new Set(regionMembers(rid, reg));
  const gap = WIDGET_GRID;
  const rects = new Map();
  S.items.forEach((o, oid) => { if (oid === rid || o.type === 'region') return; rects.set(oid, itemRectU(oid, o)); });
  const overlaps = (a, b) => a.x < b.x + b.w && a.x + a.w > b.x && a.y < b.y + b.h && a.y + a.h > b.y;
  const blocks = [regionRect(reg)];
  members.forEach(id => { if (rects.has(id)) blocks.push(rects.get(id)); });
  const movable = [...rects.keys()].filter(id => !members.has(id)).sort((a, b) => (rects.get(a).y - rects.get(b).y) || (rects.get(a).x - rects.get(b).x));
  const moved = new Map();
  for (const id of movable) {
    const r = Object.assign({}, rects.get(id));
    for (let pass = 0; pass < 40; pass++) {
      const hit = blocks.find(b => overlaps(r, b)); if (!hit) break;
      const down = hit.y + hit.h + gap - r.y, right = hit.x + hit.w + gap - r.x;
      if (down <= right * 1.6) r.y = snapU(hit.y + hit.h + gap); else r.x = snapU(hit.x + hit.w + gap);
    }
    if (r.x !== rects.get(id).x || r.y !== rects.get(id).y) moved.set(id, { x: r.x, y: r.y });
    blocks.push(r);
  }
  if (!moved.size) return 0;
  animateMoves();
  const col = boardsCol(S.classId, S.coll).doc(S.boardId).collection('items');
  const batch = db().batch();
  moved.forEach((p, id) => { const o = S.items.get(id); if (!o) return; const next = Object.assign({}, o, { x: p.x, y: round4(p.y - pageTop(pageIndexOf(o.pageId))) }); S.items.set(id, next); batch.update(col.doc(id), { x: next.x, y: next.y, updatedAt: FV().serverTimestamp() }); recEvent('item-move', itemEventPayload(id, next)); });
  renderItems();
  try { await batch.commit(); } catch (e) { console.warn('[whiteboard] displace failed', e); }
  return moved.size;
}
function animateMoves() { const wl = el('widgetsLayer'); if (!wl) return; wl.classList.add('wb-displacing'); clearTimeout(S._dispT); S._dispT = setTimeout(() => wl.classList.remove('wb-displacing'), 500); }
function drawRegionItem(ctx, it, W) {
  const x = (it.x || 0) * W, y = (it.y || 0) * W, w = (it.w || 0.3) * W, h = (it.collapsed ? 0.03 : (it.h || 0.3)) * W;
  const col = /^#[0-9a-f]{6}$/i.test(it.color || '') ? it.color : REGION_COLORS[0];
  ctx.save();
  ctx.globalAlpha = 0.12; ctx.fillStyle = col; ctx.fillRect(x, y, w, h);
  ctx.globalAlpha = 1; ctx.strokeStyle = col; ctx.lineWidth = Math.max(1, W * 0.0012); ctx.strokeRect(x, y, w, h);
  ctx.fillStyle = col; ctx.font = `600 ${Math.max(6, W * 0.014)}px system-ui, sans-serif`; ctx.textBaseline = 'top';
  ctx.fillText(it.title || 'Region', x + W * 0.008, y + W * 0.006);
  ctx.restore();
}

/* ─── V3.842 instances: a region from ANOTHER board, mirrored live ────────
   The instance subscribes to its source board (the region doc, the items
   and strokes inside the box) and renders them read-only, scaled to its
   own width: compact summary cards (the source host's full renderers
   belong to the other page) and the ink in a canvas. Source → instance;
   edits happen at the source. The source's rules decide who can read it. */
function buildRegionRefNode(id, it) {
  const node = document.createElement('div');
  node.dataset.itemId = id; node.dataset.kind = 'regionref';
  node.className = 'wb-item wb-item-widget wb-regionref';
  const canEdit = !!S?.isAdmin;
  node.innerHTML = `<div class="wb-wh" data-wb-whead>
      ${canEdit ? '<span class="wb-wgrab" aria-hidden="true">⋮⋮</span>' : ''}
      <span class="wb-wkind">⧉ instance</span><span class="wb-rr-title"></span><span class="wb-rr-from"></span>
      <a class="wb-rr-open" target="_blank" rel="noopener" title="Open the source board" hidden>↗</a>
      ${canEdit ? '<button type="button" class="wb-wmore" data-wb-rrremove title="Remove this instance (two taps; the source stays)">×</button>' : ''}
    </div>
    <div class="wb-rr-body"><canvas class="wb-rr-ink"></canvas><div class="wb-rr-cards"></div><div class="wb-rr-status">Loading the source…</div></div>
    ${canEdit ? '<span class="wb-wgrip" data-wb-wgrip title="Drag to resize"></span>' : ''}`;
  const rm = node.querySelector('[data-wb-rrremove]');
  if (rm) rm.addEventListener('click', (e) => { e.stopPropagation(); if (!armTwoTap(rm, '✓')) return; deleteItem(id); });
  node.addEventListener('keydown', (e) => e.stopPropagation());
  return node;
}
function sourceUrl(src) {
  if (!src) return '';
  if (src.coll === 'paperBoards') return `/rm/pages/figure-board.html?paper=${encodeURIComponent(src.classId)}`;
  if (src.coll === 'notebookBoards') return `/rm/pages/notebook.html?board=${encodeURIComponent(src.boardId)}`;
  return '';
}
function ensureRefSub(id, it) {
  if (!S || S.refSubs.has(id) || !it.src || !it.src.boardId || !it.src.coll) return;
  const src = it.src; let col;
  try { col = boardsCol(src.classId, src.coll).doc(src.boardId); } catch (e) { return; }
  const data = { region: null, items: new Map(), strokes: new Map(), name: src.boardName || '', err: '', ready: false };
  S.refData.set(id, data);
  const refresh = () => { if (!S) return; const n = S.itemNodes.get(id); const cur = S.items.get(id); if (n && cur) updateRegionRefChrome(n, id, cur); };
  const onErr = (e) => { data.err = (e && e.code === 'permission-denied') ? 'No access to the source board.' : 'The source could not be read.'; refresh(); };
  const unsubs = [];
  try {
    unsubs.push(col.onSnapshot(s => { if (s.exists) data.name = (s.data() || {}).name || data.name; refresh(); }, onErr));
    unsubs.push(col.collection('items').onSnapshot(s => { s.docChanges().forEach(ch => { if (ch.type === 'removed') data.items.delete(ch.doc.id); else data.items.set(ch.doc.id, ch.doc.data()); }); data.region = data.items.get(src.regionId) || null; data.ready = true; refresh(); }, onErr));
    unsubs.push(col.collection('strokes').onSnapshot(s => { s.docChanges().forEach(ch => { if (ch.type === 'removed') data.strokes.delete(ch.doc.id); else data.strokes.set(ch.doc.id, ch.doc.data()); }); refresh(); }, onErr));
  } catch (e) { onErr(e); }
  S.refSubs.set(id, () => unsubs.forEach(u => { try { u(); } catch (e) {} }));
}
function dropRefSub(id) { if (!S) return; const u = S.refSubs.get(id); if (u) { try { u(); } catch (e) {} S.refSubs.delete(id); } S.refData.delete(id); }
function updateRegionRefChrome(node, id, it) {
  const d = S.refData.get(id); const reg = d && d.region;
  const col = (reg && reg.color) || it.color || REGION_COLORS[0];
  node.style.setProperty('--wb-rcol', col);
  const t = node.querySelector('.wb-rr-title'); if (t) t.textContent = (reg && reg.title) || it.title || 'Region';
  const f = node.querySelector('.wb-rr-from'); if (f) f.textContent = d && d.name ? `from ${d.name}` : '';
  const a = node.querySelector('.wb-rr-open'); if (a) { const u = sourceUrl(it.src); a.hidden = !u; if (u) a.href = u; }
  const status = node.querySelector('.wb-rr-status'), cards = node.querySelector('.wb-rr-cards'), cv = node.querySelector('.wb-rr-ink'), body = node.querySelector('.wb-rr-body');
  if (!d) return;
  if (d.err) { status.textContent = d.err; status.hidden = false; cards.innerHTML = ''; return; }
  if (!reg) { status.textContent = d.ready ? 'The source region no longer exists.' : 'Loading the source…'; status.hidden = false; cards.innerHTML = ''; return; }
  status.hidden = true;
  const R = { x: reg.x || 0, y: reg.y || 0, w: reg.w || 0.3, h: reg.h || 0.3 };
  body.style.aspectRatio = String(Math.max(0.3, Math.min(6, R.w / Math.max(0.01, R.h))));
  const inside = [...d.items.entries()].filter(([k, o]) => k !== it.src.regionId && o.type !== 'region' && o.type !== 'regionref'
    && (Array.isArray(reg.members) ? reg.members.includes(k) : (o.pageId === reg.pageId && rectContains(R, { x: (o.x || 0) + (o.w || 0.4) / 2, y: (o.y || 0) + ((o.w || 0.4) / (o.ar || 1.6)) / 2 }))));
  const sig = JSON.stringify([R, inside.map(([k, o]) => [k, o.type, o.kind, o.title, o.summary, o.text, o.url, o.x, o.y, o.w, o.color])]);
  if (cards.dataset.sig !== sig) {
    cards.dataset.sig = sig;
    cards.innerHTML = inside.map(([, o]) => {
      const lx = ((o.x || 0) - R.x) / R.w * 100, ly = ((o.y || 0) - R.y) / R.h * 100, lw = (o.w || 0.4) / R.w * 100;
      const label = o.type === 'widget' ? (o.kind || 'card') : o.type;
      const text = o.type === 'widget' ? (o.title || o.summary || o.text || '') : (o.text || o.srcLabel || '');
      return `<div class="wb-rr-card${o.color ? ' wb-tinted' : ''}" style="left:${lx.toFixed(2)}%;top:${ly.toFixed(2)}%;width:${lw.toFixed(2)}%;${o.color ? `--wb-card:${escAttr(o.color)}` : ''}"><span class="wb-rr-ckind">${esc(label)}</span>${o.type === 'image' && o.url ? `<img src="${escAttr(o.url)}" alt="" loading="lazy">` : `<span class="wb-rr-ctext">${esc(String(text).slice(0, 160))}</span>`}</div>`;
    }).join('');
  }
  paintRefInk(cv, d, reg, R);
}
function paintRefInk(cv, d, reg, R) {
  const w = cv.clientWidth || (cv.parentNode && cv.parentNode.clientWidth) || 300; const dpr = Math.min(2, window.devicePixelRatio || 1);
  const W = Math.max(8, Math.round(w * dpr)), H = Math.max(8, Math.round(W * (R.h / Math.max(0.01, R.w))));
  if (cv.width !== W || cv.height !== H) { cv.width = W; cv.height = H; }
  const ctx = cv.getContext('2d'); ctx.setTransform(1, 0, 0, 1, 0, 0); ctx.clearRect(0, 0, W, H);
  const ppu = W / R.w;
  [...d.strokes.values()].filter(s => s.pageId === reg.pageId && !s.erasedAt && !s.hiddenBy).sort((a, b) => (a.seq || 0) - (b.seq || 0)).forEach(s => paintStroke(ctx, s, ppu, -R.x * ppu, -R.y * ppu));
}
/** Tools → ⧉: pick one of the user's other boards, then one of its regions. */
async function openRefPicker() {
  const board = el('board'); if (!board || !S?.isAdmin) return;
  closeRefPicker();
  const pop = document.createElement('div'); pop.className = 'wb-refpick';
  pop.innerHTML = '<div class="wb-rp-head"><span>Region from another board</span><button type="button" class="wb-rp-x" data-rp-close title="Close">✕</button></div><div class="wb-rp-body"><div class="wb-rp-empty">Loading your boards…</div></div>';
  board.appendChild(pop); S.refPick = pop;
  pop.addEventListener('pointerdown', (e) => e.stopPropagation());
  pop.addEventListener('click', (e) => {
    if (e.target.closest('[data-rp-close]')) { closeRefPicker(); return; }
    const b = e.target.closest('[data-rp-board]'); if (b) { showRefRegions(pop, JSON.parse(b.dataset.rpBoard)); return; }
    const r = e.target.closest('[data-rp-region]'); if (r) { const src = JSON.parse(r.dataset.rpRegion); closeRefPicker(); addRegionRefItem(src).then(id => { if (id) toast(`Instance of “${src.title}” added — it follows the source.`); }); return; }
    if (e.target.closest('[data-rp-back]')) listRefBoards(pop);
  });
  const close = (ev) => { if (S?.refPick === pop && !pop.contains(ev.target)) closeRefPicker(); };
  pop._close = close;
  setTimeout(() => document.addEventListener('pointerdown', close, true), 0);
  listRefBoards(pop);
}
function closeRefPicker() { const p = S?.refPick; if (!p) return; try { document.removeEventListener('pointerdown', p._close, true); } catch (e) {} p.remove(); S.refPick = null; }
function currentUid() { return window.McgheeLab?.Auth?.currentUser?.uid || (window.firebase && firebase.auth && firebase.auth().currentUser && firebase.auth().currentUser.uid) || ''; }
async function listRefBoards(pop) {
  const body = pop.querySelector('.wb-rp-body'); const uid = currentUid(); const rows = [];
  try { const nb = await db().collection('userData').doc(uid).collection('notebookBoards').get(); nb.forEach(d => { if (S.coll === 'notebookBoards' && d.id === S.boardId) return; rows.push({ coll: 'notebookBoards', classId: uid, boardId: d.id, name: (d.data() || {}).name || 'Notebook board', kind: 'Notebook' }); }); } catch (e) { console.warn('[whiteboard] ref boards (notebooks)', e); }
  try { const ps = await db().collection('papers').where('authorUids', 'array-contains', uid).get(); ps.forEach(d => { const x = d.data() || {}; if (x.is_library_entry) return; if (S.coll === 'paperBoards' && d.id === S.classId) return; rows.push({ coll: 'paperBoards', classId: d.id, boardId: 'main', name: x.title || 'Paper', kind: 'Figure board' }); }); } catch (e) { console.warn('[whiteboard] ref boards (papers)', e); }
  if (!pop.isConnected) return;
  body.innerHTML = rows.length ? `<div class="wb-rp-list">${rows.map(r => `<button type="button" class="wb-rp-row" data-rp-board="${escAttr(JSON.stringify(r))}"><span class="wb-rp-kind">${esc(r.kind)}</span><span class="wb-rp-name">${esc(r.name)}</span></button>`).join('')}</div>` : '<div class="wb-rp-empty">No other boards yet.</div>';
}
async function showRefRegions(pop, b) {
  const body = pop.querySelector('.wb-rp-body'); body.innerHTML = '<div class="wb-rp-empty">Loading regions…</div>';
  let regs = [];
  try { const s = await boardsCol(b.classId, b.coll).doc(b.boardId).collection('items').where('type', '==', 'region').get(); s.forEach(d => { const x = d.data() || {}; if (x.type === 'region') regs.push(Object.assign({ id: d.id }, x)); }); }
  catch (e) { console.warn('[whiteboard] ref regions', e); body.innerHTML = '<div class="wb-rp-empty">Could not read that board.</div>'; return; }
  if (!pop.isConnected) return;
  body.innerHTML = `<button type="button" class="wb-rp-back" data-rp-back>← Boards</button><div class="wb-rp-sub">${esc(b.name)}</div>` +
    (regs.length ? `<div class="wb-rp-list">${regs.map(r => `<button type="button" class="wb-rp-row" data-rp-region="${escAttr(JSON.stringify({ coll: b.coll, classId: b.classId, boardId: b.boardId, regionId: r.id, title: r.title || 'Region', color: r.color || '', boardName: b.name }))}"><span class="wb-rp-dot" style="background:${escAttr(r.color || REGION_COLORS[0])}"></span><span class="wb-rp-name">${esc(r.title || 'Region')}</span></button>`).join('')}</div>` : '<div class="wb-rp-empty">That board has no regions yet — draw one there with ▭.</div>');
}
async function addRegionRefItem(src, where) {
  if (!S || !S.isAdmin || !src || !src.boardId) return null;
  const at = (where && where.pageId && typeof where.x === 'number') ? where : avoidOverlap(newItemPlacement());
  const id = newId('i'); const now = Date.now();
  const doc = { pageId: at.pageId, type: 'regionref', x: snapU(at.x), y: snapU(at.y), w: 0.42, ar: 1.6, z: now, title: src.title || 'Region', color: src.color || '',
    src: { coll: src.coll, classId: src.classId, boardId: src.boardId, regionId: src.regionId, boardName: src.boardName || '' },
    text: `Instance of ${src.title || 'a region'}`, url: '', fullUrl: '', storagePath: '', createdBy: currentUid(), createdAt: FV().serverTimestamp(), updatedAt: FV().serverTimestamp() };
  try { await boardsCol(S.classId, S.coll).doc(S.boardId).collection('items').doc(id).set(doc); adoptIntoRegion(id, { x: doc.x + doc.w / 2, y: pageTop(pageIndexOf(doc.pageId)) + doc.y + 0.03 }).catch(() => {}); return id; }
  catch (e) { console.warn('[whiteboard] add instance failed', e); toast('Could not add the instance.'); return null; }
}

/* ─── V3.842 organise by connections ──────────────────────────────────────
   The wires among cards form a graph. Each connected component (≥ 2) is
   laid out left → right in layers (longest path from its sources), rows
   ordered by their parents, placed one below another from the view's
   top-left and wrapped in a region "Flow k" (an existing region holding
   exactly that flow is reused). Loose cards stack in a column to the
   right. One batch; the moves animate. */
async function organiseByConnections() {
  if (!S || !S.isAdmin || !S.sheet) return 0;
  const cards = [...S.items.entries()].filter(([, it]) => it.type === 'widget' || it.type === 'regionref');
  const ids = new Set(cards.map(([id]) => id));
  const adj = new Map(), out = new Map(), indeg = new Map();
  ids.forEach(id => { adj.set(id, new Set()); out.set(id, new Set()); indeg.set(id, 0); });
  S.wires.forEach(w => { if (!ids.has(w.from) || !ids.has(w.to) || w.from === w.to) return; adj.get(w.from).add(w.to); adj.get(w.to).add(w.from); if (!out.get(w.from).has(w.to)) { out.get(w.from).add(w.to); indeg.set(w.to, indeg.get(w.to) + 1); } });
  const seen = new Set(), comps = [];
  ids.forEach(id => { if (seen.has(id)) return; const stack = [id], comp = []; seen.add(id); while (stack.length) { const c = stack.pop(); comp.push(c); adj.get(c).forEach(nb => { if (!seen.has(nb)) { seen.add(nb); stack.push(nb); } }); } comps.push(comp); });
  const flows = comps.filter(c => c.length >= 2).sort((a, b) => b.length - a.length);
  if (!flows.length) return 0;
  const inFlow = new Set(flows.flat());
  const gap = 0.03, pad = 0.04, head = 0.05;
  /* V3.843 — everything is laid out from the CONTENT's top-left, so nothing lands on anything */
  const ext = contentExtent(); const ox = ext.left + 0.02, oy = ext.top + 0.02;
  const heightOf = (id) => itemHeightU(id, S.items.get(id));
  const moves = new Map(), regionWrites = [], wireSides = new Map();
  const regions = [...S.items.entries()].filter(([, r]) => r.type === 'region');
  const regionMem = new Map(regions.map(([rid, r]) => [rid, regionMembers(rid, r)]));
  const sameSet = (a, b) => a.length === b.length && a.every(x => b.includes(x));
  let cursorY = oy, flowN = 0, rightEdge = ox;
  const reused = new Set();
  for (const comp of flows) {
    flowN++;
    const set = new Set(comp);
    const layer = new Map(), visiting = new Set();
    const visit = (id, depth) => { if (!set.has(id) || visiting.has(id)) return; const cur = layer.get(id); if (cur !== undefined && cur >= depth) return; layer.set(id, depth); visiting.add(id); out.get(id).forEach(nb => visit(nb, depth + 1)); visiting.delete(id); };
    comp.filter(id => indeg.get(id) === 0).forEach(id => visit(id, 0));
    comp.forEach(id => { if (!layer.has(id)) visit(id, 0); });
    const cols = new Map(); layer.forEach((L, id) => { if (!cols.has(L)) cols.set(L, []); cols.get(L).push(id); });
    const Ls = [...cols.keys()].sort((a, b) => a - b);
    const rowOf = new Map();
    Ls.forEach(L => {
      const arr = cols.get(L);
      const bary = (id) => { const ps = [...adj.get(id)].filter(nb => (layer.get(nb) ?? 0) < L).map(nb => rowOf.get(nb) ?? 0); return ps.length ? ps.reduce((s, v) => s + v, 0) / ps.length : 0; };
      arr.sort((a, b) => bary(a) - bary(b) || String(a).localeCompare(String(b)));
      arr.forEach((id, k) => rowOf.set(id, k));
    });
    let x = ox + pad, maxBottom = cursorY + head;
    Ls.forEach(L => { const arr = cols.get(L); const colW = Math.max(...arr.map(id => S.items.get(id).w || 0.4)); let y = cursorY + head; arr.forEach(id => { moves.set(id, { x: snapU(x), y: snapU(y) }); y += heightOf(id) + gap; }); maxBottom = Math.max(maxBottom, y); x += colW + gap * 2; });
    const rect = { x: snapU(ox), y: snapU(cursorY), w: round4(Math.max(0.2, (x - gap * 2 + pad) - ox)), h: round4(Math.max(0.15, maxBottom - cursorY + pad - gap)) };
    const existing = regions.find(([rid]) => !reused.has(rid) && sameSet(regionMem.get(rid), comp));
    if (existing) reused.add(existing[0]);
    regionWrites.push({ id: existing ? existing[0] : null, rect, members: comp, title: existing ? (existing[1].title || `Flow ${flowN}`) : `Flow ${flowN}`, color: existing ? existing[1].color : REGION_COLORS[(flowN - 1) % REGION_COLORS.length] });
    S.wires.forEach((w, wid) => { if (set.has(w.from) && set.has(w.to)) wireSides.set(wid, (layer.get(w.from) ?? 0) <= (layer.get(w.to) ?? 0) ? { fromSide: 'e', toSide: 'w' } : { fromSide: 'w', toSide: 'e' }); });
    rightEdge = Math.max(rightEdge, rect.x + rect.w);
    cursorY = rect.y + rect.h + gap * 2;
  }
  /* the other regions move as blocks, their cards with them, stacked below the flows */
  const inKept = new Set();
  regions.forEach(([rid, r]) => {
    if (reused.has(rid)) return;
    const mem = regionMem.get(rid).filter(id => !inFlow.has(id)); mem.forEach(id => inKept.add(id));
    const rr = itemRectU(rid, r); const dx = snapU(ox) - rr.x, dy = snapU(cursorY) - rr.y;
    if (Math.abs(dx) > 1e-6 || Math.abs(dy) > 1e-6) {
      regionWrites.push({ id: rid, rect: { x: round4(rr.x + dx), y: round4(rr.y + dy), w: r.w || 0.3, h: r.h || 0.3 }, members: regionMem.get(rid), title: r.title, color: r.color, keepCollapsed: true });
      mem.forEach(id => { const o = S.items.get(id); moves.set(id, { x: round4((o.x || 0) + dx), y: round4(pageTop(pageIndexOf(o.pageId)) + (o.y || 0) + dy) }); });
    }
    rightEdge = Math.max(rightEdge, rr.x + dx + (r.w || 0.3));
    cursorY = snapU(cursorY) + rr.h + gap * 2;
  });
  /* loose cards (and images / text under the ink): a column to the right */
  const loose = [...S.items.entries()].filter(([id, it]) => it.type !== 'region' && !inFlow.has(id) && !inKept.has(id)).map(([id]) => id);
  const colX = snapU(rightEdge + gap * 2); let ly = oy;
  loose.sort((a, b) => ((S.items.get(a).y || 0) - (S.items.get(b).y || 0))).forEach(id => { moves.set(id, { x: colX, y: snapU(ly) }); ly += heightOf(id) + gap; });
  animateMoves();
  const col = boardsCol(S.classId, S.coll).doc(S.boardId).collection('items'), wcol = boardsCol(S.classId, S.coll).doc(S.boardId).collection('wires');
  const ops = []; const pid = planeId(); let n = 0;
  moves.forEach((p, id) => { const o = S.items.get(id); if (!o) return; const next = Object.assign({}, o, { x: p.x, y: round4(p.y - pageTop(pageIndexOf(o.pageId))) }); S.items.set(id, next); ops.push(b => b.update(col.doc(id), { x: next.x, y: next.y, updatedAt: FV().serverTimestamp() })); recEvent('item-move', itemEventPayload(id, next)); if (inFlow.has(id)) n++; });
  regionWrites.forEach((r, k) => {
    if (r.id) {
      const o = S.items.get(r.id); const patch = { x: r.rect.x, y: round4(r.rect.y - pageTop(pageIndexOf(o.pageId))), w: r.rect.w, h: r.rect.h, members: r.members, updatedAt: FV().serverTimestamp() };
      if (!r.keepCollapsed) patch.collapsed = false;
      S.items.set(r.id, Object.assign({}, o, patch, { updatedAt: o.updatedAt })); ops.push(b => b.update(col.doc(r.id), patch));
    } else {
      const id = newId('g'); const doc = { pageId: pid, type: 'region', members: r.members, x: r.rect.x, y: round4(r.rect.y), w: r.rect.w, h: r.rect.h, title: r.title, color: r.color, collapsed: false, z: -1000 + k, ar: 1, url: '', fullUrl: '', storagePath: '', text: '', createdBy: currentUid(), createdAt: FV().serverTimestamp(), updatedAt: FV().serverTimestamp() };
      S.items.set(id, Object.assign({}, doc, { createdAt: null, updatedAt: null })); ops.push(b => b.set(col.doc(id), doc));
    }
  });
  wireSides.forEach((sides, wid) => { const w = S.wires.get(wid); if (w && (w.fromSide !== sides.fromSide || w.toSide !== sides.toSide)) { S.wires.set(wid, Object.assign({}, w, sides)); ops.push(b => b.update(wcol.doc(wid), sides)); } });
  renderItems();
  try { for (let i = 0; i < ops.length; i += 400) { const batch = db().batch(); ops.slice(i, i + 400).forEach(f => f(batch)); await batch.commit(); } }
  catch (e) { console.warn('[whiteboard] organise failed', e); toast('Could not reorganise the board.'); }
  return n;
}

/* ─── V3.837 radial pills: pens · tools · widgets · zoom ──────────
   Four round buttons on the sheet (three stacked bottom-left, zoom at the
   bottom-right). A tap fans that pill's items out along a quarter arc —
   up to five on an inner ring, the rest on an outer ring — and a tap on
   an item acts through handleBoardAction like any toolbar button. Items
   that are naturally repeated (zoom + / −, undo, the two-tap clear) keep
   the fan open; everything else folds it. */
const PILL_DEFS = {
  widgets: { icon: '＋', label: 'Insert a card', side: 'left' },
  tools:   { icon: '✦', label: 'Tools', side: 'left' },
  pens:    { icon: '✎', label: 'Zoom · pan · pen · highlighter · cards', side: 'left' },   /* V3.860 — the hand's modes live here (V3.863: cards, not text) */
  zoom:    { icon: '⊕', label: 'View', side: 'right' }
};
function pillItems(name) {
  const items = [];
  if (!S) return items;
  if (name === 'pens') {
    /* V3.860 — the FIRST arc is what the hand is: zoom · pan · pen · highlighter · text (exactly the inner ring's five
       places); the SECOND arc is the options of the one selected. A double tap goes back to the last one. */
    const group = handGroup();
    const first = [
      { act: 'hand-zoom', g: 'zoom', icon: wbIcon('magnifying-glass', 'Z'), label: 'Zoom — tap to zoom in, Alt-tap out, drag up or down' },
      { act: 'hand-pan', g: 'pan', icon: wbIcon('hand', 'P'), label: 'Pan — drag to move around the board' },
      { act: 'hand-pen', g: 'pen', icon: wbIcon('pencil', '/'), label: 'Pen — draw' },
      { act: 'hand-hl', g: 'hl', icon: wbIcon('highlighter', 'H'), label: 'Highlighter — wide, see-through, under the ink' },
      { act: 'hand-card', g: 'card', icon: wbIcon('cursor-arrow-rays', 'C'), label: 'Cards — drag a card to move it, tap one to edit it' }
    ];
    first.forEach(f => items.push({ act: f.act, icon: `<span class="wb-fan-mode">${f.icon}</span>`, label: f.label + (group === f.g ? '' : ' (double-tap the board to come back)'), sel: group === f.g, mode: true, keep: true }));
    const penPick = (p) => {
      const er = p.kind === 'eraser', hl = p.kind === 'hl';
      const sel = S.penId === p.id && (er ? S.tool === 'eraser' : S.tool === 'pen');
      const icon = er ? '<span class="wb-fan-eraser"></span>' : `<span class="wb-fan-dot${hl ? ' wb-fan-dot-hl' : ''}" style="background:${p.color}"></span>`;
      items.push({ act: 'pen-pick', attrs: { 'data-pen': p.id }, icon, label: (er ? 'Eraser' : hl ? 'Highlighter' : 'Pen') + (sel ? ' — tap again to customise' : ''), sel });
    };
    const widths = () => PEN_WIDTHS.forEach(w => { const eff = S.hl ? w.w * 3.4 : w.w; items.push({ act: 'width', attrs: { 'data-w': w.w }, icon: `<span class="wb-fan-bar" style="height:${Math.max(2, Math.round(w.w * 900))}px"></span>`, label: w.label + ' line', sel: S.tool === 'pen' && Math.abs(S.width - eff) < 1e-6 }); });
    const undo = () => items.push({ act: 'undo', icon: wbIcon('arrow-uturn-left', '<'), label: 'Undo my last stroke', keep: true });
    if (group === 'zoom') {
      items.push({ act: 'zoom-in', icon: wbIcon('plus', '+'), label: 'Zoom in', keep: true });
      items.push({ act: 'zoom-out', icon: wbIcon('minus', '-'), label: 'Zoom out', keep: true });
      items.push({ act: 'zoom-home', icon: wbIcon('home', 'H'), label: 'Home: the page at 100 %', keep: true });
      items.push({ act: 'zoom-fit', icon: '⊡', label: 'Fit everything on the screen' });
      items.push({ act: 'fit-region', icon: '⤢', label: 'Fit a region: drag a box around it', sel: S.tool === 'fitregion' });
    } else if (group === 'pan') {
      items.push({ act: 'zoom-home', icon: wbIcon('home', 'H'), label: 'Home: back to the start of the board', keep: true });
      items.push({ act: 'zoom-fit', icon: '⊡', label: 'Fit everything on the screen' });
    } else if (group === 'pen') {
      S.pens.filter(p => p.kind === 'pen' || p.kind === 'eraser').forEach(penPick);
      if (!S.pens.some(p => p.kind === 'eraser')) items.push({ act: 'eraser', icon: '<span class="wb-fan-eraser"></span>', label: S.tool === 'eraser' ? 'Back to the pen' : 'Eraser', sel: S.tool === 'eraser' });
      widths();
      items.push({ act: 'pen-add', attrs: { 'data-kind': 'pen' }, icon: wbIcon('plus', '+'), label: 'Add a pen', keep: true });
      undo();
      items.push({ act: 'clear-page', icon: '⌧', label: infinite() ? 'Clear all the ink (two taps)' : 'Clear this page (two taps)', keep: true });
    } else if (group === 'hl') {
      S.pens.filter(p => p.kind === 'hl').forEach(penPick);
      widths();
      items.push({ act: 'pen-add', attrs: { 'data-kind': 'hl' }, icon: `<span class="wb-fan-hl">${wbIcon('plus', '+')}</span>`, label: 'Add a highlighter', keep: true });
      undo();
    } else if (group === 'card') {
      /* V3.863 — the chosen card's options; with none chosen, a new note and fit everything */
      const id = S.cardSel; const it = id ? S.items.get(id) : null;
      if (it) {
        const isW = it.type === 'widget', isG = it.type === 'region';
        if (isW) items.push({ act: 'card-edit', icon: wbIcon('pencil-square', 'E'), label: 'Edit this card' });
        if (isW && isNotebook()) items.push({ act: 'card-color', icon: `<span class="wb-fan-dot${it.color ? '' : ' wb-fan-dot-none'}" style="background:${/^#[0-9a-f]{6}$/i.test(it.color || '') ? it.color : '#fff'}"></span>`, label: 'Colour this card' });
        if (isW || isG) items.push({ act: 'card-collapse', icon: wbIcon(it.collapsed ? 'chevron-down' : 'chevron-up', 'v'), label: it.collapsed ? 'Expand' : 'Collapse' });
        if (!isG) items.push({ act: 'card-front', icon: wbIcon('arrow-up', '^'), label: 'Bring to front' });
        if (isW && S.widgets?.onMenu) items.push({ act: 'card-more', icon: wbIcon('ellipsis-horizontal', '...'), label: 'More for this card' });
        items.push({ act: 'card-remove', icon: wbIcon('trash', 'X'), label: isG ? 'Remove the region (two taps) — its cards stay' : 'Remove this card (two taps)', keep: true });
        items.push({ act: 'card-done', icon: wbIcon('x-mark', 'x'), label: 'Done — let the card go' });
      } else {
        if (S.widgets && typeof S.widgets.meta === 'function' && S.widgets.meta('note')) items.push({ act: 'card-note', icon: wbIcon('plus', '+'), label: 'Add a note card' });
        items.push({ act: 'zoom-fit', icon: '⊡', label: 'Fit everything on the screen' });
      }
    }
  } else if (name === 'tools') {
    items.push({ act: 'rec', icon: recording() ? '■' : ICON.svg('microphone'), label: recording() ? 'Stop recording' : 'Record voice with the ink', sel: recording() });
    if (recording()) {
      /* V3.884 — the one recorder: pause and marks. V3.886 — simple up front: ONE Mark; what it is (a question, a
         decision, a to-do, its words, how long it lasts) is said on the mark once it is in — the mark editor */
      items.push({ act: 'rec-pause', icon: REC.pausedAt ? wbIcon('play', '>') : wbIcon('pause', '||'), label: REC.pausedAt ? 'Resume recording (Alt+P)' : 'Pause recording — the replay skips the pause (Alt+P)', sel: !!REC.pausedAt, keep: true });
      items.push({ act: 'rec-mark', icon: '<span class="wb-fan-glyph">◆</span>', label: 'Mark this moment (Alt+M) — then say what it is', keep: true });
      const last = recLastMark();
      if (last) items.push({ act: 'rec-mark-edit', icon: wbIcon('pencil-square', 'E'), label: 'Change the last mark (' + recMmss(last.t) + ')', sel: S.markEdit === last.id, keep: true });
    }
    items.push({ act: 'arrange', icon: '⤧', label: S.arrange ? 'Done arranging' : 'Arrange cards', sel: !!S.arrange });
    items.push({ act: 'tidy', icon: '⇣', label: 'Tidy this page into a column' });
    if (isNotebook()) {
      /* V3.842 — regions, organise by connections, an instance of another board's region */
      items.push({ act: 'group', icon: '▭', label: S.tool === 'group' ? 'Back to the pen' : 'Region: drag a box around cards to group them', sel: S.tool === 'group' });
      if (S.wiresEnabled) items.push({ act: 'organise', icon: '⇶', label: 'Organise the board by its connections' });
      items.push({ act: 'regionref', icon: '⧉', label: 'Add a region from another board', keep: true });
    }
    (S.tools || []).forEach(t => items.push({ act: 'tool', attrs: { 'data-tool': t.act }, icon: hostIcon(t.icon || '•'), label: t.label || t.act, sel: !!t.active }));
    if (!(S.tools || []).some(t => t.act === 'max')) items.push({ act: 'max', icon: '⛶', label: isMaximized() ? 'Exit full screen' : 'Full screen', sel: isMaximized() });
    /* V3.860 — the ✎ pill's double tap is the mode switch now, so a moved pill comes home from here */
    if (Object.keys(S.pillPos || {}).length) items.push({ act: 'pills-reset', icon: '⌖', label: 'Put the pills back in their places' });
  } else if (name === 'widgets') {
    const ins = (S.inserts || []).slice(0, 10);
    ins.forEach(k => items.push({ act: 'insert', attrs: { 'data-kind': k.kind }, icon: hostIcon(k.icon || '•'), label: k.label || k.kind }));
    if ((S.inserts || []).length > 10) items.push({ act: 'tool', attrs: { 'data-tool': 'insert-more' }, icon: '…', label: 'More…' });
  } else if (name === 'zoom') {
    items.push({ act: 'zoom-in', icon: wbIcon('plus', '+'), label: 'Zoom in', keep: true });
    items.push({ act: 'zoom-home', icon: wbIcon('home', 'H'), label: 'Home: the page at 100 %', keep: true });
    items.push({ act: 'zoom-out', icon: wbIcon('minus', '-'), label: 'Zoom out', keep: true });
    items.push({ act: 'zoom-fit', icon: '⊡', label: 'Fit everything on the screen' });
    items.push({ act: 'fit-region', icon: '⤢', label: S.tool === 'fitregion' ? 'Back to the pen' : 'Fit a region: drag a box around it', sel: S.tool === 'fitregion' });
    /* V3.860 — pan and zoom are modes of the hand now: the first arc of the ✎ pill */
  }
  return items;
}
/* V3.839 — take a pen from the set into the hand */
function usePen(p) {
  if (!S || !p) return;
  S.penId = p.id; S.regionDrag = null;
  if (p.kind === 'eraser') { S.tool = 'eraser'; S.eraserW = p.w; S.hl = false; return; }   // V3.841 — an eraser from the set
  S.color = p.color; S.width = p.w; S.hl = p.kind === 'hl';
  S.tool = 'pen';
  if (p.kind === 'hl') S.lastHlId = p.id; else S.lastPenId = p.id;   /* V3.860 — what a double tap / the first arc comes back to */
}
/* ================================================================
   V3.860 — the hand's modes: zoom · pan · pen · highlighter · text (the
   ✎ pill's first arc), with the eraser a pen option. trackMode() runs on
   every pill render (every tool change goes through renderToolbar →
   renderPills) and remembers the previous mode, so a double tap — on the
   ✎ pill, or the canvas — goes back to it.
   ================================================================ */
const HAND_MODES = new Set(['zoom', 'pan', 'pen', 'hl', 'eraser', 'card']);
const DOUBLE_MS = 300;   /* the double-tap window; a zoom tap waits exactly this long, so the two never overlap */
const HAND_NAMES = { zoom: 'Zoom', pan: 'Pan', pen: 'Pen', hl: 'Highlighter', eraser: 'Eraser', card: 'Cards' };
/* V3.863 — the phone's mode bar: what a finger does, one tap each */
const MODE_BAR = [['pan', 'hand', 'Pan'], ['card', 'cursor-arrow-rays', 'Select'], ['pen', 'pencil', 'Pen'], ['hl', 'highlighter', 'Highlight']];
/** A monochrome icon from the site set (rm/js/icons.js), or a plain-letter fallback where that set is not loaded. */
function wbIcon(name, fallback) {
  try { if (window.ICON && typeof window.ICON.svg === 'function') return window.ICON.svg(name); } catch (e) {}
  return esc(fallback || '');
}
/** The mode the hand is in: a pen in hand is 'pen' or 'hl' by its kind. */
function handOf() { if (!S) return null; return S.tool === 'pen' ? (S.hl ? 'hl' : 'pen') : S.tool; }
/** The first-arc entry that is lit: the eraser lives under the pen. */
function handGroup() { const h = handOf(); return h === 'eraser' ? 'pen' : h; }
function trackMode() {
  if (!S) return;
  const t = handOf();
  if (HAND_MODES.has(t)) { if (S._modeSeen && S._modeSeen !== t) S.lastTool = S._modeSeen; S._modeSeen = t; }
  const root = el('root');
  if (root && S.pills) ['zoom', 'pan', 'pen', 'hl', 'eraser', 'card'].forEach(m => root.classList.toggle('wb-hand-' + m, t === m));
  if (t !== 'card' && S.cardSel) cardSelect(null, { quiet: true });   /* V3.863 — leaving Cards lets the chosen card go */
}
function setHandMode(t) {
  if (!S || !HAND_MODES.has(t)) return;
  S.erasing = false; S.regionDrag = null; S.panDrag = null; S.zoomDrag = null;
  if (S._zoomTapT) { clearTimeout(S._zoomTapT); S._zoomTapT = null; }
  if (t === 'pen') {
    /* a real pen: the one in hand if it is a pen, else the last pen, else the first of the set */
    const inHand = S.pens.find(x => x.id === S.penId);
    if (!(inHand && inHand.kind === 'pen' && S.tool === 'pen')) { const lp = S.pens.find(x => x.id === S.lastPenId && x.kind === 'pen') || S.pens.find(x => x.kind === 'pen'); if (lp) { usePen(lp); renderToolbar(); return; } }
    S.tool = 'pen'; S.hl = false;
  } else if (t === 'hl') {
    let hp = S.pens.find(x => x.id === S.lastHlId && x.kind === 'hl') || S.pens.find(x => x.kind === 'hl');
    if (!hp) { hp = { id: newId('pn'), kind: 'hl', color: '#fde047', w: PEN_KINDS.hl.def }; S.pens.push(hp); savePenSet(S.pens); }
    usePen(hp);
  } else if (t === 'eraser') {
    const ep = S.pens.find(x => x.kind === 'eraser');
    if (ep) usePen(ep); else S.tool = 'eraser';
  } else S.tool = t;
  renderToolbar();
}
function toggleLastMode() {
  if (!S) return;
  const cur = handOf();
  let t = S.lastTool;
  if (!t || t === cur || !HAND_MODES.has(t)) t = /^(pan|zoom|card)$/.test(cur) ? 'pen' : 'pan';
  setHandMode(t);
  showModeHint(`${HAND_NAMES[handOf()] || 'Pen'} — double-tap to switch back`);
}
/* V3.863 — Cards: the whole card is the handle (a drag moves it); a tap CHOOSES a card for editing — its body comes
   alive (class wb-card-sel) and, with a mouse, the field under the click gets the caret. A touch only chooses: the
   on-screen keyboard comes up when you tap a field of the chosen card, never on the way to it. */
function cardSelect(id, opts) {
  if (!S) return;
  const prev = S.cardSel || null;
  S.cardSel = id && S.items.has(id) ? id : null;
  if (prev && prev !== S.cardSel) {
    const n = S.itemNodes.get(prev);
    if (n) { n.classList.remove('wb-card-sel'); const a = document.activeElement; if (a && n.contains(a)) { try { a.blur(); } catch (e) {} } }
  }
  if (S.cardSel) { const n = S.itemNodes.get(S.cardSel); if (n) n.classList.add('wb-card-sel'); }
  if (!(opts && opts.quiet) && S.openPill === 'pens') renderPills();
}
/** The caret into the chosen card's field under (x, y) — after the card is chosen, so its body takes the pointer. */
function cardFocusAt(id, x, y) {
  const n = S && S.itemNodes.get(id); if (!n) return false;
  const t = document.elementFromPoint(x, y);
  const ed = t && n.contains(t) && t.closest('input:not([type=checkbox]):not([type=radio]):not([type=button]):not([type=file]), textarea, select, [contenteditable="true"]');
  if (!ed || !n.contains(ed)) return false;
  try { ed.focus({ preventScroll: true }); } catch (e) { try { ed.focus(); } catch (err) {} }
  if (ed.isContentEditable && document.caretRangeFromPoint) {
    const r = document.caretRangeFromPoint(x, y);
    if (r && ed.contains(r.startContainer)) { const sel = window.getSelection(); sel.removeAllRanges(); sel.addRange(r); }
  }
  return true;
}
/** ✎ Edit from the Cards arc: the caret into the card's first field (on a phone, its sheet). */
function cardEdit(id) {
  if (!S) return; const it = S.items.get(id); if (!it) return;
  if (mobile()) { openItemSheet(id, 'content'); return; }
  if (it.collapsed) updateItem(id, { collapsed: false });
  cardSelect(id, { quiet: true });
  setTimeout(() => {
    const n = S && S.itemNodes.get(id); if (!n) return;
    const ed = n.querySelector('.wb-wb [contenteditable="true"], .wb-wb textarea, .wb-wb input:not([type=checkbox]):not([type=radio]):not([type=button]):not([type=file])') || n.querySelector('.wb-wtitle:not([readonly])');
    if (ed) { try { ed.focus(); } catch (e) {} }
  }, 60);
}
/** Remove through the host's own Remove (so its clean-up runs — a collection's mirror, a reference's links). */
function cardRemove(id) {
  const it = S && S.items.get(id); if (!it) return;
  cardSelect(null, { quiet: true });
  if (it.type === 'widget' && S.widgets?.menuItems) {
    try {
      const a = (S.widgets.menuItems(Object.assign({ id }, it), widgetApi(id)) || []).find(x => x && /^remove\b/i.test(x.label || '') && typeof x.run === 'function');
      if (a) { a.run(); return; }
    } catch (e) { console.warn('[whiteboard] remove failed', e); }
  }
  deleteItem(id);
}
/** ＋ a typed note in the middle of the view, chosen for editing. */
async function cardAddNote() {
  if (!S || !S.isAdmin) return;
  if (!(S.widgets && typeof S.widgets.meta === 'function' && S.widgets.meta('note'))) { toast('This board has no typed-note cards.'); return; }
  const r = el('board').getBoundingClientRect();
  const pt = normPoint({ clientX: r.left + r.width / 2, clientY: r.top + r.height / 2 }); const pages = S.board?.pages || [];
  const pid = pages[pageAtSheetY(pt.v)]?.id || S.pageId; const loc = toLocal(pt, pid);
  const id = await addWidgetItem({ kind: 'note', title: '', data: { html: '' }, text: '', w: 0.32, pageId: pid, x: round4(Math.max(0, loc.x - 0.16)), y: round4(Math.max(0, loc.y - 0.05)), avoidOverlap: true });
  if (!id || !S) return;
  if (mobile()) { openItemSheet(id, 'content'); return; }
  cardSelect(id);
  cardEdit(id);
}
/* V3.863 — a phone's finger draws in the pen / highlighter / eraser modes; a second finger means pan or pinch, so the
   stroke (or the erasing) the first one started is taken back */
function cancelTouchInk() {
  if (!S) return;
  S.erasing = false;
  const st = S.active; if (!st || !st.touch) return;
  const id = st.id; finishStroke(false); removeStrokes([id]);
  S.myIds = S.myIds.filter(x => x !== id);
}
function modeBarHTML() {
  const g = handGroup();
  const btns = MODE_BAR.map(([m, ic, label]) => `<button type="button" class="wb-mode-btn${g === m ? ' wb-sel' : ''}" data-wb-mode="${m}" aria-pressed="${g === m ? 'true' : 'false'}" title="${escAttr(label + (g === m ? ' — tap again for its options' : ''))}">${wbIcon(ic, label[0])}<span>${esc(label)}</span></button>`).join('');
  const undo = (g === 'pen' || g === 'hl') ? `<button type="button" class="wb-mode-btn wb-mode-undo" data-wb-bar-undo title="Undo my last stroke" aria-label="Undo my last stroke">${wbIcon('arrow-uturn-left', '<')}<span>Undo</span></button>` : '';
  return `<div class="wb-modebar" role="toolbar" aria-label="What a finger does on the board">${btns}${undo}</div>`;
}
function showModeHint(text) {
  const board = el('board'); if (!board) return;
  let h = board.querySelector(':scope > .wb-modehint');
  if (!h) { h = document.createElement('div'); h.className = 'wb-modehint'; h.setAttribute('role', 'status'); h.setAttribute('aria-live', 'polite'); board.appendChild(h); }
  h.textContent = text; h.classList.add('wb-on');
  clearTimeout(S._modeHintT); S._modeHintT = setTimeout(() => { h.classList.remove('wb-on'); }, 1400);
}
/* a double tap on the canvas: a finger in any mode; a mouse in pen / pan / zoom (in pen mode the two dots it drew are taken
   back); a stylus only in pan / zoom (in pen mode two quick taps are a colon or an ellipsis, never a switch); never with a
   mouse or stylus in eraser mode (the taps would have erased) */
function tapDown(e) {
  if (!S || !S.pills || !S.isAdmin) return;
  S._tapDown = { x: e.clientX, y: e.clientY, t: Date.now(), type: e.pointerType, id: e.pointerId, ink0: S.myIds.length, tool: S.tool };
}
/** → 'double' (the mode switched), 'tap' (a single tap so far), or false (not a tap: it moved, or was long) */
function tapUp(e) {
  const d = S && S._tapDown; if (!d || d.id !== e.pointerId) return false;
  S._tapDown = null;
  const now = Date.now();
  if (now - d.t > 300 || Math.hypot(e.clientX - d.x, e.clientY - d.y) > 8) { S._lastTap = null; return false; }
  const tap = { x: e.clientX, y: e.clientY, t: now, type: d.type, tool: d.tool, ink: S.myIds.slice(d.ink0) };
  const prev = S._lastTap;
  if (prev && now - prev.t < DOUBLE_MS && Math.hypot(tap.x - prev.x, tap.y - prev.y) < 24 && prev.type === tap.type && prev.tool === tap.tool) {
    S._lastTap = null;
    const pen = tap.tool === 'pen', eraser = tap.tool === 'eraser';   /* 'pen' covers the highlighter too: both ink */
    if (tap.type === 'pen' && (pen || eraser)) return 'tap';
    if (tap.type === 'mouse' && eraser) return 'tap';
    if (pen) { const dots = prev.ink.concat(tap.ink).filter(id => { const st = S.strokes.get(id); return st && (st.pts || []).length <= 6; }); if (dots.length) removeStrokes(dots); }
    if (S._zoomTapT) { clearTimeout(S._zoomTapT); S._zoomTapT = null; }
    toggleLastMode();
    return 'double';
  }
  S._lastTap = tap;
  return 'tap';
}
/* the zoom hand: a tap zooms in ×1.5 (Alt / Shift / right button: out) after a beat — a second tap makes it a double tap
   instead — and a drag up / down zooms smoothly about where it started */
function zoomFrame(clientX, clientY) {
  const ink = el('ink'); const r = el('board').getBoundingClientRect();
  const pwCss = S.sheet.pageW / (ink.width / Math.max(1, ink.clientWidth));
  return { x: (clientX - r.left) / pwCss, y: (clientY - r.top) / pwCss };
}
/* the fan: up to 5 on the inner ring, 7 on the next, 9 on the outer */
const FAN_RINGS = [[5, 88], [7, 148], [9, 208]];
function fanPos(i, n, side, vert) {
  let k = i, start = 0, ring = 0;
  while (ring < FAN_RINGS.length - 1 && k >= Math.min(FAN_RINGS[ring][0], n - start)) { const c = Math.min(FAN_RINGS[ring][0], n - start); k -= c; start += c; ring++; }
  const cnt = Math.max(1, Math.min(FAN_RINGS[ring][0], n - start)), r = FAN_RINGS[ring][1];
  /* quadrant: the arc opens away from the nearest edges */
  const a0 = side === 'left' ? (vert === 'up' ? 4 : 274) : (vert === 'up' ? 94 : 184), a1 = a0 + 82;
  const a = cnt === 1 ? (a0 + a1) / 2 : a0 + (a1 - a0) * k / (cnt - 1);
  const t = a * Math.PI / 180;
  return { x: Math.round(Math.cos(t) * r), y: Math.round(-Math.sin(t) * r) };
}
function penWToRange(p) { const K = PEN_KINDS[penKind(p.kind)]; return Math.round(Math.max(0, Math.min(100, (p.w - K.lo) / (K.hi - K.lo) * 100))); }
function penRangeToW(v, kind) { const K = PEN_KINDS[penKind(kind)]; return clampPenW(K.lo + (K.hi - K.lo) * (Math.max(0, Math.min(100, +v || 0)) / 100), kind); }
/* V3.839 — the pen editor: kind, swatches + any colour, width, remove. Lives
   in the pill box beside the pens pill; never a browser popup. */
function penEditorHTML() {
  const p = S.pens.find(x => x.id === S.penEdit); if (!p) return '';
  const hl = p.kind === 'hl', er = p.kind === 'eraser';
  const sw = PEN_SWATCHES.map(c => `<button type="button" class="wb-pe-swatch${p.color.toLowerCase() === c.toLowerCase() ? ' wb-sel' : ''}" data-wb-pe="color" data-v="${c}" style="background:${c}" title="${c}" aria-label="Colour ${c}"></button>`).join('');
  return `<div class="wb-pen-edit" data-wb-penedit>
    <div class="wb-pe-row wb-pe-kinds"><button type="button" class="wb-pe-kind${!hl && !er ? ' wb-sel' : ''}" data-wb-pe="kind" data-v="pen">Pen</button><button type="button" class="wb-pe-kind${hl ? ' wb-sel' : ''}" data-wb-pe="kind" data-v="hl">Highlighter</button><button type="button" class="wb-pe-kind${er ? ' wb-sel' : ''}" data-wb-pe="kind" data-v="eraser">Eraser</button></div>
    ${er ? '' : `<div class="wb-pe-swatches">${sw}<label class="wb-pe-custom" title="Any colour"><input type="color" value="${escAttr(p.color)}" data-wb-pe-color aria-label="Custom colour"><span>⋯</span></label></div>`}
    <div class="wb-pe-row wb-pe-width"><span class="wb-pe-lbl">${er ? 'Size' : 'Width'}</span><input type="range" min="0" max="100" value="${penWToRange(p)}" data-wb-pe-w aria-label="Width"><span class="wb-pe-preview">${er ? `<span class="wb-pe-eraser" style="width:${Math.max(6, Math.round(p.w * 900))}px;height:${Math.max(6, Math.round(p.w * 900))}px"></span>` : `<span class="wb-pe-line${hl ? ' wb-pe-line-hl' : ''}" style="height:${Math.max(2, Math.round(p.w * 900))}px;background:${escAttr(p.color)}"></span>`}</span></div>
    <div class="wb-pe-row wb-pe-foot"><button type="button" class="wb-pe-btn wb-pe-remove" data-wb-pe="remove"${S.pens.length <= 1 ? ' disabled' : ''}>Remove</button><span class="wb-pe-hint">${er ? 'rubs out whole strokes it touches' : hl ? 'wide · see-through · under the ink' : 'pen'}</span><button type="button" class="wb-pe-btn wb-pe-done" data-wb-pe="done">Done</button></div>
  </div>`;
}
function placePenEditor(box) {
  const ed = box.querySelector('.wb-pen-edit'); if (!ed) return;
  const pill = box.querySelector('.wb-pill-' + (ed.dataset.pill || 'pens')); if (!pill) return;   /* V3.886 — or the mark editor, beside ✦ */
  const bw = box.clientWidth || 800, bh = box.clientHeight || 600;
  const left = pill.offsetLeft, top = pill.offsetTop, sz = pill.offsetWidth || 46;
  const right = left + sz / 2 > bw / 2;
  const ew = ed.offsetWidth || 252, eh = ed.offsetHeight || 200;
  const x = right ? Math.max(4, left - ew - 10) : Math.min(bw - ew - 4, left + sz + 10);
  const y = Math.max(4, Math.min(bh - eh - 4, top + sz - eh));
  ed.style.left = x + 'px'; ed.style.top = y + 'px';
}
function renderPills() {
  const board = el('board'); if (!board || !S) return;
  let box = board.querySelector(':scope > .wb-pills');
  if (!S.pills || S.chrome !== 'full' || S.projector || S.replay) { if (box) box.remove(); return; }
  if (!box) { box = document.createElement('div'); box.className = 'wb-pills'; board.appendChild(box); bindPills(box); }
  /* V3.839 — the first pen of the set is the pen in hand */
  if (S.isAdmin && !S.penId && !S._penInit) { S._penInit = true; if (S.pens[0]) usePen(S.pens[0]); }
  /* V3.863 — a phone starts by navigating: one finger pans until you pick Select, Pen or Highlight */
  if (S.isAdmin && mobile() && !S._phoneMode) { S._phoneMode = true; if (S.tool === 'pen' || S.tool === 'eraser') S.tool = 'pan'; }
  if (!mobile()) S._phoneMode = false;
  trackMode();   /* V3.860 — remember the last mode; the cursor follows the mode */
  const names = S.isAdmin ? ['widgets', 'tools', 'pens', 'zoom'] : ['zoom'];
  const bw = board.clientWidth || 800, bh = board.clientHeight || 600;
  const sz = box.querySelector('.wb-pill')?.offsetWidth || (bw <= 700 ? 42 : 46);
  const html = names.map(name => {
    const def = PILL_DEFS[name]; const open = S.openPill === name;
    const items = open ? pillItems(name) : [];
    /* V3.839 — a moved pill: its saved position (fractions of the board),
       and the fan opens into the quadrant with room */
    const pp = S.pillPos[name];
    let posStyle = '', side = def.side, vert = 'up', moved = false;
    if (pp && isFinite(+pp.fx) && isFinite(+pp.fy)) {
      const left = Math.round(Math.max(0, Math.min(bw - sz, pp.fx * bw - sz / 2))), top = Math.round(Math.max(0, Math.min(bh - sz, pp.fy * bh - sz / 2)));
      posStyle = ` style="left:${left}px;top:${top}px;right:auto;bottom:auto"`;
      side = (left + sz / 2) > bw / 2 ? 'right' : 'left';
      vert = (top + sz / 2) < Math.min(bh / 2, 240) ? 'down' : 'up';
      moved = true;
    }
    let status = '';
    /* V3.860 — the ✎ pill shows the hand's mode; the ink dot only while something inks */
    const hm = name === 'pens' ? handOf() : null;
    const handIcon = name !== 'pens' ? def.icon : hm === 'pan' ? wbIcon('hand', 'P') : hm === 'zoom' ? wbIcon('magnifying-glass', 'Z') : hm === 'card' ? wbIcon('cursor-arrow-rays', 'C') : hm === 'hl' ? wbIcon('highlighter', 'H') : def.icon;
    if (name === 'pens' && /^(pen|hl|eraser)$/.test(hm)) status =`<span class="wb-pill-dot${S.hl && S.tool !== 'eraser' ? ' wb-pill-dot-hl' : ''}${S.tool === 'eraser' ? ' wb-pill-dot-eraser' : ''}" style="background:${S.tool === 'eraser' ? '#fff' : S.color}"></span>`;
    if (name === 'tools' && recording()) status = `<span class="wb-pill-rec"><span class="wb-live-dot"></span>${esc(recElapsedLabel())}</span>`;
    if (name === 'zoom') status = `<span class="wb-pill-pct" data-wb-zoom-pct>${Math.round((S.view?.scale || 1) * 100)}%</span>`;
    const toolOn = (name === 'zoom' && S.tool === 'fitregion') || (name === 'pens' && /^(eraser|pan|zoom|card)$/.test(S.tool)) || (name === 'tools' && (S.arrange || recording()));
    return `<div class="wb-pill wb-pill-${name}${open ? ' wb-open' : ''}${toolOn ? ' wb-pill-on' : ''}" data-pill="${name}" data-side="${side}" data-vert="${vert}"${moved ? ' data-moved="1"' : ''}${posStyle}>
      <button type="button" class="wb-pill-btn" data-wb-pill="${name}" title="${escAttr(def.label)}${name === 'pens' ? ' (double-tap: the last mode)' : ''} (drag to move)" aria-label="${escAttr(def.label)}" aria-expanded="${open ? 'true' : 'false'}"><span class="wb-pill-ic">${handIcon}</span>${status}</button>
      <div class="wb-fan">${items.map((it, i) => { const p = fanPos(i, items.length, side, vert); const attrs = Object.entries(it.attrs || {}).map(([k, v]) => `${k}="${escAttr(v)}"`).join(' ');
        return `<button type="button" class="wb-fan-item${it.sel ? ' wb-sel' : ''}${it.mode ? ' wb-fan-modeitem' : ''}" data-wb-act="${escAttr(it.act)}" ${attrs} data-keep="${it.keep ? 1 : 0}" title="${escAttr(it.label)}" aria-label="${escAttr(it.label)}" style="--tx:${p.x}px;--ty:${p.y}px;--d:${i * 16}ms">${it.icon}</button>`; }).join('')}${open ? '<span class="wb-fan-caption" data-wb-caption></span>' : ''}</div>
    </div>`;
  }).join('') + (S.isAdmin && S.penEdit && S.openPill === 'pens' ? penEditorHTML() : '') + (S.isAdmin && S.markEdit && S.openPill === 'tools' && recording() ? markEditorHTML() : '') + (S.isAdmin && mobile() ? modeBarHTML() : '');
  if (box.innerHTML !== html) box.innerHTML = html;
  if (S.penEdit && S.openPill !== 'pens') S.penEdit = null;
  if (S.markEdit && (S.openPill !== 'tools' || !recording())) S.markEdit = null;
  placePenEditor(box);
  if (recording() && S.isAdmin) {
    if (!S.pillTimer) S.pillTimer = setInterval(() => { if (!S) return; const n = el('board')?.querySelector('.wb-pill-rec'); if (n) n.lastChild.textContent = recElapsedLabel(); if (!recording()) { clearInterval(S.pillTimer); S.pillTimer = null; renderPills(); } }, 1000);
  } else if (S.pillTimer) { clearInterval(S.pillTimer); S.pillTimer = null; }
  requestAnimationFrame(() => box.querySelectorAll('.wb-pill.wb-open').forEach(p => p.classList.add('wb-fanned')));
  if (!S.pillOutside) {
    S.pillOutside = (e) => { if (S?.openPill && !(e.target.closest && e.target.closest('.wb-pills'))) { S.openPill = null; S.penEdit = null; renderPills(); } };
    document.addEventListener('pointerdown', S.pillOutside, true);
  }
}
function patchPenPreview(box, p) {
  const line = box.querySelector('.wb-pe-line'); if (line) { line.style.background = p.color; line.style.height = Math.max(2, Math.round(p.w * 900)) + 'px'; }
  const er = box.querySelector('.wb-pe-eraser'); if (er) { const d = Math.max(6, Math.round(p.w * 900)) + 'px'; er.style.width = d; er.style.height = d; }
  const dot = box.querySelector(`.wb-fan-item[data-pen="${CSS.escape(p.id)}"] .wb-fan-dot`); if (dot) dot.style.background = p.color;
  if (S.penId === p.id) { const sd = box.querySelector('.wb-pill-pens .wb-pill-dot'); if (sd) sd.style.background = p.color; }
}
function bindPills(box) {
  const caption = (text) => { const c = box.querySelector('[data-wb-caption]'); if (c) c.textContent = text || ''; };
  box.addEventListener('click', (e) => {
    const pb = e.target.closest('[data-wb-pill]');
    if (pb) {
      e.stopPropagation();
      const n = pb.dataset.wbPill;
      /* the click that follows a drag must not open the fan */
      if (S.pillSuppressClick === n) { S.pillSuppressClick = null; return; }
      /* V3.860 — the ✎ pill: a double tap goes back to the last mode; a single tap opens the fan a beat later (so a
         double tap never flashes it), and closing an open fan is immediate */
      if (n === 'pens' && S.openPill !== 'pens') {
        if (S._pensTapT) { clearTimeout(S._pensTapT); S._pensTapT = null; toggleLastMode(); return; }
        S._pensTapT = setTimeout(() => { if (!S) return; S._pensTapT = null; S.openPill = 'pens'; S.penEdit = null; renderPills(); }, 230);
        return;
      }
      S.openPill = S.openPill === n ? null : n; S.penEdit = null; renderPills(); return;
    }
    /* V3.839 — the pen editor's controls */
    const pe = e.target.closest('[data-wb-pe]');
    if (pe && S) { e.stopPropagation(); penEditorAction(pe, box); return; }
    /* V3.886 — the mark editor's controls */
    const me = e.target.closest('[data-wb-me]');
    if (me && S) { e.stopPropagation(); markEditorAction(me); return; }
    /* V3.863 — the phone's mode bar: one tap per mode; a tap on the lit one opens its options (the ✎ fan) */
    const mb = e.target.closest('[data-wb-mode]');
    if (mb && S) {
      e.stopPropagation(); const m = mb.dataset.wbMode;
      if (handGroup() === m) { S.openPill = S.openPill === 'pens' ? null : 'pens'; S.penEdit = null; renderPills(); }
      else { S.openPill = null; setHandMode(m); }
      return;
    }
    if (e.target.closest('[data-wb-bar-undo]') && S) { e.stopPropagation(); handleBoardAction('undo', e.target.closest('[data-wb-bar-undo]')); return; }
    const it = e.target.closest('.wb-fan-item');
    if (!it || !S) return;
    e.stopPropagation();
    const act = it.dataset.wbAct, keep = it.dataset.keep === '1';
    caption(it.getAttribute('aria-label'));
    /* V3.841 — ⌧ arms in place: a red ring and a caption, the glyph stays */
    if (act === 'clear-page' && it.dataset.wbArmed !== '1') {
      it.dataset.wbArmed = '1'; it.classList.add('wb-armed');
      caption(infinite() ? 'Tap ⌧ again to clear all the ink' : 'Tap ⌧ again to clear this page');
      setTimeout(() => { if (it.isConnected && it.dataset.wbArmed === '1') { it.dataset.wbArmed = ''; it.classList.remove('wb-armed'); caption(''); } }, 3000);
      return;
    }
    handleBoardAction(act, it);
    if (act === 'clear-page') { it.classList.remove('wb-armed'); caption('Cleared.'); }
    if (!keep && !S.penEdit) { S.openPill = null; renderPills(); }
  });
  box.addEventListener('dblclick', (e) => {
    /* double-tap a pill → back to its default place */
    const pb = e.target.closest('[data-wb-pill]'); if (!pb || !S) return;
    e.stopPropagation(); const n = pb.dataset.wbPill;
    if (n === 'pens') return;   /* V3.860 — the ✎ pill's double tap is the mode switch (handled on click) */
    if (S.pillPos[n]) { delete S.pillPos[n]; savePillPos(S.pillPos); S.openPill = null; renderPills(); }
  });
  box.addEventListener('pointerover', (e) => { const it = e.target.closest('.wb-fan-item'); if (it) caption(it.getAttribute('aria-label')); });
  /* live edits in the pen editor: patch in place (a re-render would drop the slider mid-drag) */
  box.addEventListener('input', (e) => {
    if (!S) return;
    if (e.target.matches && e.target.matches('[data-wb-me-label]')) {   /* V3.886 — a mark's words, kept as typed */
      if (REC && window.RECORDER_CORE && S.markEdit) { REC.marks = RECORDER_CORE.updateMark(REC.marks, S.markEdit, { label: e.target.value }); recSaveMarks(); }
      return;
    }
    const p = S.pens.find(x => x.id === S.penEdit); if (!p) return;
    if (e.target.matches('[data-wb-pe-color]')) { if (/^#[0-9a-f]{6}$/i.test(e.target.value)) p.color = e.target.value.toLowerCase(); else return; }
    else if (e.target.matches('[data-wb-pe-w]')) p.w = penRangeToW(e.target.value, p.kind);
    else return;
    savePenSet(S.pens);
    if (S.penId === p.id) { if (p.kind === 'eraser') S.eraserW = p.w; else { S.color = p.color; S.width = p.w; } }
    patchPenPreview(box, p);
  });
  box.addEventListener('change', (e) => { if (S && e.target.matches && e.target.matches('[data-wb-pe-color],[data-wb-pe-w]')) renderPills(); });
  box.addEventListener('keydown', (e) => { if (e.key === 'Enter' && e.target.matches && e.target.matches('[data-wb-me-label]')) { e.preventDefault(); e.target.blur(); } });
  /* V3.839 — drag a pill anywhere on the sheet (> 8 px moves it; a tap still opens it) */
  let drag = null;
  box.addEventListener('pointerdown', (e) => {
    const pb = e.target.closest('[data-wb-pill]'); if (!pb || !S) return;
    S.pillSuppressClick = null;
    const pill = pb.closest('.wb-pill'); const br = box.getBoundingClientRect(); const pr = pill.getBoundingClientRect();
    drag = { name: pb.dataset.wbPill, pill, id: e.pointerId, x0: e.clientX, y0: e.clientY, ox: e.clientX - pr.left, oy: e.clientY - pr.top, br, moved: false, x: pr.left - br.left, y: pr.top - br.top };
    try { pb.setPointerCapture(e.pointerId); } catch (err) {}
  });
  box.addEventListener('pointermove', (e) => {
    if (!drag || e.pointerId !== drag.id) return;
    if (!drag.moved) {
      if (Math.hypot(e.clientX - drag.x0, e.clientY - drag.y0) < 8) return;
      drag.moved = true; drag.pill.classList.add('wb-pill-dragging');
      /* fold without re-rendering: the captured button must stay in the DOM */
      if (S.openPill) { S.openPill = null; S.penEdit = null; S.markEdit = null; drag.pill.classList.remove('wb-open', 'wb-fanned'); const ed = box.querySelector('.wb-pen-edit'); if (ed) ed.remove(); }
    }
    e.preventDefault();
    const w = drag.pill.offsetWidth || 46, h = drag.pill.offsetHeight || 46;
    drag.x = Math.max(0, Math.min(drag.br.width - w, e.clientX - drag.br.left - drag.ox));
    drag.y = Math.max(0, Math.min(drag.br.height - h, e.clientY - drag.br.top - drag.oy));
    drag.pill.style.left = drag.x + 'px'; drag.pill.style.top = drag.y + 'px'; drag.pill.style.right = 'auto'; drag.pill.style.bottom = 'auto';
  });
  const endDrag = (e) => {
    if (!drag || e.pointerId !== drag.id) return;
    const d = drag; drag = null;
    if (!d.moved || !S) return;
    d.pill.classList.remove('wb-pill-dragging');
    const w = d.pill.offsetWidth || 46, h = d.pill.offsetHeight || 46;
    S.pillPos[d.name] = { fx: +((d.x + w / 2) / Math.max(1, d.br.width)).toFixed(4), fy: +((d.y + h / 2) / Math.max(1, d.br.height)).toFixed(4) };
    savePillPos(S.pillPos);
    S.pillSuppressClick = d.name;
    setTimeout(() => { if (S && S.pillSuppressClick === d.name) S.pillSuppressClick = null; }, 400);
    renderPills();
  };
  box.addEventListener('pointerup', endDrag);
  box.addEventListener('pointercancel', endDrag);
  /* the pen must never ink through a pill */
  ['pointerdown', 'touchstart'].forEach(t => box.addEventListener(t, (e) => { e.stopPropagation(); }, { passive: true }));
}
function penEditorAction(btn, box) {
  const p = S.pens.find(x => x.id === S.penEdit); if (!p) return;
  const what = btn.dataset.wbPe, v = btn.dataset.v;
  if (what === 'kind') {
    const kind = penKind(v); if (p.kind === kind) return;
    p.kind = kind; p.w = PEN_KINDS[kind].def;                 // V3.841 — each kind starts at its own size
    if (kind === 'eraser') p.color = '#ffffff';
    else if (p.color === '#ffffff') p.color = kind === 'hl' ? '#fde047' : '#111827';
  } else if (what === 'color') {
    if (!/^#[0-9a-f]{6}$/i.test(v || '')) return; p.color = v.toLowerCase();
  } else if (what === 'remove') {
    if (btn.disabled) return;
    if (!armTwoTap(btn, 'Really remove?')) return;
    const k = S.pens.indexOf(p); if (k >= 0) S.pens.splice(k, 1);
    if (!S.pens.length) S.pens = defaultPenSet();
    savePenSet(S.pens);
    if (S.penId === p.id) usePen(S.pens[0]);
    S.penEdit = null; renderToolbar(); return;
  } else if (what === 'done') {
    S.penEdit = null; S.openPill = null; renderPills(); return;
  } else return;
  savePenSet(S.pens);
  if (S.penId === p.id) usePen(p);
  renderToolbar();
}
/** Strokes of `rect.pageId` with at least half their points inside the rectangle. */
function strokesInRect(rect) {
  const out = [];
  if (!S) return out;
  S.strokes.forEach((s, id) => {
    if (s.pageId !== rect.pageId || s.erasedAt || s.hiddenBy || s === S.active) return;
    const pts = Array.isArray(s.pts) ? s.pts : [];
    if (!pts.length) return;
    /* V3.839 — strokes store a FLAT [x, y, p, …] array (older seeds: triplets) */
    let inside = 0, n = 0;
    const test = (x, y) => { n++; if (x >= rect.x && x <= rect.x + rect.w && y >= rect.y && y <= rect.y + rect.h) inside++; };
    if (Array.isArray(pts[0])) pts.forEach(p => test(p[0], p[1]));
    else for (let i = 0; i + 1 < pts.length; i += 3) test(pts[i], pts[i + 1]);
    if (n && inside / n >= 0.5) out.push(id);
  });
  return out;
}
/** Paint the strokes of a region into an off-screen canvas (transparent
 *  unless `opts.background`), with the SAME renderer as the board. Returns
 *  { blob, width, height, ar, strokeIds, canvas }. */
async function rasterizeRegion(rect, opts) {
  if (!S) return null;
  const o = opts || {};
  const ppu = Math.max(600, Math.min(4000, o.pxPerPage || 2400));
  const W = Math.max(8, Math.round(rect.w * ppu)), H = Math.max(8, Math.round(rect.h * ppu));
  const cv = document.createElement('canvas'); cv.width = W; cv.height = H;
  const ctx = cv.getContext('2d');
  if (o.background) { ctx.fillStyle = o.background; ctx.fillRect(0, 0, W, H); }
  const ids = Array.isArray(o.strokeIds) ? o.strokeIds : strokesInRect(rect);
  const list = ids.map(id => S.strokes.get(id)).filter(Boolean).sort((a, b) => (a.seq || 0) - (b.seq || 0));
  list.forEach(s => paintStroke(ctx, s, ppu, -rect.x * ppu, -rect.y * ppu));
  const blob = await new Promise(res => { try { cv.toBlob(res, o.mime || 'image/webp', o.quality || 0.92); } catch (e) { res(null); } });
  return { blob, width: W, height: H, ar: W / H, strokeIds: ids, canvas: cv };
}
/** Fold strokes under a panel: hidden on every board, kept in the record. */
async function hideStrokes(ids, by) {
  if (!S || !S.isAdmin || !ids.length) return;
  ids.forEach(id => { const s = S.strokes.get(id); if (s) { s.hiddenBy = by || 'panel'; markThumb(s.pageId); } });
  schedulePaint();
  const col = boardsCol(S.classId, S.coll).doc(S.boardId).collection('strokes');
  for (let i = 0; i < ids.length; i += 400) {
    const batch = db().batch();
    ids.slice(i, i + 400).forEach(id => batch.update(col.doc(id), { hiddenBy: by || 'panel' }));
    try { await batch.commit(); } catch (e) { console.warn('[whiteboard] hide strokes failed', e); toast('Could not fold the ink.'); return; }
  }
}
async function unhideStrokes(by) {
  if (!S || !S.isAdmin || !by) return [];
  const ids = [...S.strokes.entries()].filter(([, s]) => s.hiddenBy === by).map(([id]) => id);
  ids.forEach(id => { const s = S.strokes.get(id); if (s) { delete s.hiddenBy; markThumb(s.pageId); } });
  schedulePaint();
  const col = boardsCol(S.classId, S.coll).doc(S.boardId).collection('strokes');
  for (let i = 0; i < ids.length; i += 400) {
    const batch = db().batch();
    ids.slice(i, i + 400).forEach(id => batch.update(col.doc(id), { hiddenBy: FV().delete() }));
    try { await batch.commit(); } catch (e) { console.warn('[whiteboard] unhide strokes failed', e); }
  }
  return ids;
}

/* ─── V3.837 wires: arrows between cards, drawn in the widgets layer ─── */
function renderWires() {
  if (!S || !S.wiresEnabled) return;
  const wl = el('widgetsLayer'); if (!wl) return;
  let svg = wl.querySelector(':scope > svg.wb-wires');
  if (!S.wires.size && !S.portDrag) { if (svg) svg.remove(); return; }
  const defs = '<defs><marker id="wb-arrow" viewBox="0 0 10 10" refX="9" refY="5" markerWidth="7" markerHeight="7" orient="auto-start-reverse"><path d="M0,0 L10,5 L0,10 z" fill="#475569"/></marker></defs>';
  if (!svg) { svg = document.createElementNS('http://www.w3.org/2000/svg', 'svg'); svg.setAttribute('class', 'wb-wires'); wl.insertBefore(svg, wl.firstChild); }
  const parts = [defs]; const markers = new Set();
  S.wires.forEach((w, id) => {
    const a = wireRect(w.from), b = wireRect(w.to); if (!a || !b) return;
    /* V3.856 — a wire from a NODE inside the card (a paper card's highlight / figure row) leaves from the node itself,
       in the node's colour */
    const p1 = nodePoint(w, a);
    const g = wirePath(a, b, w.fromSide, w.toSide, p1);
    const col = /^#[0-9a-f]{6}$/i.test(w.color || '') ? w.color.toLowerCase() : '';
    let mk = 'wb-arrow';
    if (col) { mk = 'wb-arrow-' + col.slice(1); if (!markers.has(col)) { markers.add(col); parts.push(`<defs><marker id="${mk}" viewBox="0 0 10 10" refX="9" refY="5" markerWidth="7" markerHeight="7" orient="auto-start-reverse"><path d="M0,0 L10,5 L0,10 z" fill="${col}"/></marker></defs>`); } }
    parts.push(`<g class="wb-wire${w.fromNode ? ' wb-wire-node' : ''}" data-wire-id="${escAttr(id)}"><path class="wb-wire-hit" d="${g.d}"/><path class="wb-wire-line" d="${g.d}"${col ? ` style="stroke:${col}"` : ''} marker-end="url(#${mk})"/>${w.rel ? `<text x="${g.mx.toFixed(1)}" y="${(g.my - 5).toFixed(1)}" text-anchor="middle"${col ? ` style="fill:${col}"` : ''}>${esc(w.rel)}</text>` : ''}</g>`);
  });
  const keep = svg.querySelector('.wb-wire-draft');
  svg.innerHTML = parts.join('');
  if (keep) svg.appendChild(keep);
}
function wireRect(id) { const n = S.itemNodes.get(id); if (!n || !n.isConnected || n.hidden) return null; return { x: n.offsetLeft, y: n.offsetTop, w: n.offsetWidth, h: n.offsetHeight }; }
function edgePoint(r, toward) {
  const cx = r.x + r.w / 2, cy = r.y + r.h / 2, dx = toward.x - cx, dy = toward.y - cy;
  if (!dx && !dy) return { x: cx, y: cy };
  const sx = dx ? (r.w / 2) / Math.abs(dx) : Infinity, sy = dy ? (r.h / 2) / Math.abs(dy) : Infinity;
  const t = Math.min(sx, sy);
  return { x: cx + dx * t, y: cy + dy * t };
}
/* V3.841 — a port is a mid-point of one side; a wire between two ports is
   a cubic that leaves and arrives square to its sides (Scientia's look) */
function portPoint(r, side) {
  if (side === 'n') return { x: r.x + r.w / 2, y: r.y };
  if (side === 's') return { x: r.x + r.w / 2, y: r.y + r.h };
  if (side === 'w') return { x: r.x, y: r.y + r.h / 2 };
  return { x: r.x + r.w, y: r.y + r.h / 2 };
}
function sideNormal(side) { return side === 'n' ? { x: 0, y: -1 } : side === 's' ? { x: 0, y: 1 } : side === 'w' ? { x: -1, y: 0 } : { x: 1, y: 0 }; }
/* V3.856 — where a wire that leaves a NODE starts: the node element's right-middle, in layer units. The node is a
   `[data-wb-node]` inside the card's body (a paper card's highlight or figure row); when it is not in the DOM or the
   card is collapsed (no layout box) the wire falls back to the card's side port. */
function nodePoint(w, a) {
  if (!w || !w.fromNode || !a) return null;
  const n = S.itemNodes.get(w.from); if (!n) return null;
  let el = null;
  try { el = n.querySelector(`[data-wb-node="${(window.CSS && CSS.escape) ? CSS.escape(String(w.fromNode)) : String(w.fromNode).replace(/["\\]/g, '\\$&')}"]`); } catch (e) { el = null; }
  if (!el || el.offsetParent === null) return null;
  const ir = n.getBoundingClientRect(), er = el.getBoundingClientRect(); if (!ir.width || !er.width) return null;
  const s = (lensActive() ? S.view.scale : 1) || 1;
  return { x: a.x + (er.right - ir.left) / s, y: a.y + (er.top + er.height / 2 - ir.top) / s };
}
function wirePath(a, b, fromSide, toSide, fromPt) {
  const ac = { x: a.x + a.w / 2, y: a.y + a.h / 2 }, bc = { x: b.x + b.w / 2, y: b.y + b.h / 2 };
  const p1 = fromPt || (fromSide ? portPoint(a, fromSide) : edgePoint(a, bc)), p2 = toSide ? portPoint(b, toSide) : edgePoint(b, ac);
  if (!fromSide && !toSide && !fromPt) return { d: `M${p1.x.toFixed(1)},${p1.y.toFixed(1)} L${p2.x.toFixed(1)},${p2.y.toFixed(1)}`, mx: (p1.x + p2.x) / 2, my: (p1.y + p2.y) / 2 };
  const k = Math.max(24, Math.hypot(p2.x - p1.x, p2.y - p1.y) / 3);
  const n1 = fromPt ? { x: 1, y: 0 } : fromSide ? sideNormal(fromSide) : { x: Math.sign(p2.x - p1.x), y: 0 }, n2 = toSide ? sideNormal(toSide) : { x: Math.sign(p1.x - p2.x), y: 0 };
  const c1 = { x: p1.x + n1.x * k, y: p1.y + n1.y * k }, c2 = { x: p2.x + n2.x * k, y: p2.y + n2.y * k };
  const mx = (p1.x + 3 * c1.x + 3 * c2.x + p2.x) / 8, my = (p1.y + 3 * c1.y + 3 * c2.y + p2.y) / 8;   // the cubic at t = ½
  return { d: `M${p1.x.toFixed(1)},${p1.y.toFixed(1)} C${c1.x.toFixed(1)},${c1.y.toFixed(1)} ${c2.x.toFixed(1)},${c2.y.toFixed(1)} ${p2.x.toFixed(1)},${p2.y.toFixed(1)}`, mx, my };
}
function nearestSide(id, clientX, clientY) {
  const n = S.itemNodes.get(id); if (!n) return 'w';
  const r = n.getBoundingClientRect();
  const c = { n: { x: r.left + r.width / 2, y: r.top }, s: { x: r.left + r.width / 2, y: r.bottom }, w: { x: r.left, y: r.top + r.height / 2 }, e: { x: r.right, y: r.top + r.height / 2 } };
  let best = 'w', bd = Infinity;
  Object.keys(c).forEach(k => { const d = Math.hypot(c[k].x - clientX, c[k].y - clientY); if (d < bd) { bd = d; best = k; } });
  return best;
}
/** Drag a wire out of a card's port; drop it on another card. */
function startPortDrag(e, port) {
  const node = port.closest('.wb-item'); if (!node || !S) return;
  e.preventDefault(); e.stopPropagation();
  /* V3.856 — a node port (inside a card's body) names the node it leaves from and its colour */
  const d = { from: node.dataset.itemId, side: port.dataset.wbPort, node: port.dataset.wbNode || '', color: port.dataset.wbColor || '', rel: port.dataset.wbRel || '', x: e.clientX, y: e.clientY, over: null, id: e.pointerId };
  S.portDrag = d;
  try { port.setPointerCapture(e.pointerId); } catch (err) {}
  el('root')?.classList.add('wb-wiring');
  const setOver = (tid) => {
    if (tid === d.over) return;
    if (d.over) S.itemNodes.get(d.over)?.classList.remove('wb-port-target');
    d.over = (tid && tid !== d.from) ? tid : null;
    if (d.over) S.itemNodes.get(d.over)?.classList.add('wb-port-target');
  };
  const move = (ev) => {
    if (ev.pointerId !== d.id) return;
    ev.preventDefault(); ev.stopPropagation();
    d.x = ev.clientX; d.y = ev.clientY;
    const under = document.elementFromPoint(ev.clientX, ev.clientY);
    const tgt = under && under.closest ? under.closest('.wb-item-widget') : null;
    setOver(tgt ? tgt.dataset.itemId : null);
    renderWireDraft();
  };
  const up = (ev) => {
    if (ev.pointerId !== d.id) return;
    port.removeEventListener('pointermove', move); port.removeEventListener('pointerup', up); port.removeEventListener('pointercancel', up);
    ev.stopPropagation();
    const to = d.over; setOver(null);
    S.portDrag = null; el('root')?.classList.remove('wb-wiring');
    renderWireDraft(); renderWires();
    if (to && to !== d.from) {
      addWire(d.from, to, d.rel, { fromSide: d.side, toSide: nearestSide(to, ev.clientX, ev.clientY), fromNode: d.node, color: d.color })
        .then(id => { if (id && S?.onConnectDone) { try { S.onConnectDone(id); } catch (e2) {} } });
    }
  };
  port.addEventListener('pointermove', move); port.addEventListener('pointerup', up); port.addEventListener('pointercancel', up);
  renderWireDraft();
}
function renderWireDraft() {
  const wl = el('widgetsLayer'); if (!wl || !S) return;
  let svg = wl.querySelector(':scope > svg.wb-wires');
  const d = S.portDrag;
  if (!d) { const old = svg && svg.querySelector('.wb-wire-draft'); if (old) old.remove(); if (svg && !S.wires.size) svg.remove(); return; }
  if (!svg) { svg = document.createElementNS('http://www.w3.org/2000/svg', 'svg'); svg.setAttribute('class', 'wb-wires'); wl.insertBefore(svg, wl.firstChild); }
  let path = svg.querySelector('.wb-wire-draft');
  if (!path) { path = document.createElementNS('http://www.w3.org/2000/svg', 'path'); path.setAttribute('class', 'wb-wire-draft'); svg.appendChild(path); }
  const a = wireRect(d.from); if (!a) return;
  const np = d.node ? nodePoint({ from: d.from, fromNode: d.node }, a) : null;   /* V3.856 */
  const p1 = np || portPoint(a, d.side);
  path.style.stroke = /^#[0-9a-f]{6}$/i.test(d.color || '') ? d.color : '';
  /* pointer → layer coordinates: the layer's rect already carries its translate; divide out its scale */
  const lr = wl.getBoundingClientRect(); const s = lensActive() ? S.view.scale : 1;
  const p2 = { x: (d.x - lr.left) / s, y: (d.y - lr.top) / s };
  const n1 = np ? { x: 1, y: 0 } : sideNormal(d.side), k = Math.max(24, Math.hypot(p2.x - p1.x, p2.y - p1.y) / 3);
  path.setAttribute('d', `M${p1.x.toFixed(1)},${p1.y.toFixed(1)} C${(p1.x + n1.x * k).toFixed(1)},${(p1.y + n1.y * k).toFixed(1)} ${p2.x.toFixed(1)},${p2.y.toFixed(1)} ${p2.x.toFixed(1)},${p2.y.toFixed(1)}`);
}
async function addWire(from, to, rel, extra) {
  if (!S || !S.isAdmin || !from || !to || from === to) return null;
  /* V3.856 — a wire may leave a NODE inside the card; the same node may connect to several cards, and a card may
     carry several node wires to the same target, so the duplicate check includes the node */
  const node = (extra && extra.fromNode) ? String(extra.fromNode).slice(0, 80) : '';
  const dup = [...S.wires.entries()].find(([, w]) => w.from === from && w.to === to && (w.fromNode || '') === node);
  if (dup) return dup[0];
  const id = newId('w');
  const doc = { from, to, rel: String(rel || '').slice(0, 40), createdBy: window.McgheeLab?.Auth?.currentUser?.uid || '', createdAt: FV().serverTimestamp() };
  /* V3.841 — which sides the wire leaves and arrives at (from the ports) */
  if (extra && /^[nesw]$/.test(extra.fromSide || '')) doc.fromSide = extra.fromSide;
  if (extra && /^[nesw]$/.test(extra.toSide || '')) doc.toSide = extra.toSide;
  if (node) doc.fromNode = node;
  if (extra && /^#[0-9a-f]{6}$/i.test(extra.color || '')) doc.color = extra.color.toLowerCase();
  S.wires.set(id, doc); renderWires();
  try { await boardsCol(S.classId, S.coll).doc(S.boardId).collection('wires').doc(id).set(doc); }
  catch (e) { console.warn('[whiteboard] add wire failed', e); S.wires.delete(id); renderWires(); toast('Could not connect those cards.'); return null; }
  if (S && S.onWireAdded) { try { S.onWireAdded(id, Object.assign({}, doc)); } catch (e) { console.warn('[whiteboard] onWireAdded', e); } }
  return id;
}
async function updateWire(id, patch) {
  if (!S || !S.isAdmin) return false;
  const cur = S.wires.get(id); if (!cur) return false;
  const next = Object.assign({}, cur, patch);
  S.wires.set(id, next); renderWires();
  try { await boardsCol(S.classId, S.coll).doc(S.boardId).collection('wires').doc(id).update(patch); }
  catch (e) { console.warn('[whiteboard] wire update failed', e); return false; }
  if (S && S.onWireUpdated) { try { S.onWireUpdated(id, Object.assign({}, next), Object.assign({}, cur)); } catch (e) { console.warn('[whiteboard] onWireUpdated', e); } }   /* V3.856 */
  return true;
}
async function removeWire(id) {
  if (!S || !S.isAdmin) return false;
  const was = S.wires.get(id) || null;
  S.wires.delete(id); renderWires();
  try { await boardsCol(S.classId, S.coll).doc(S.boardId).collection('wires').doc(id).delete(); }
  catch (e) { console.warn('[whiteboard] wire delete failed', e); return false; }
  if (S && S.onWireRemoved && was) { try { S.onWireRemoved(id, Object.assign({}, was)); } catch (e) { console.warn('[whiteboard] onWireRemoved', e); } }   /* V3.856 */
  return true;
}
function setConnectMode(on) {
  if (!S) return;
  S.connect = on ? { from: null } : null;
  S.itemNodes.forEach(n => n.classList.remove('wb-connect-from'));
  el('root')?.classList.toggle('wb-connecting', !!on);
}

/* ─── V3.841 files dropped on the sheet → the host (images, .html) ─── */
function bindDropHandlers() {
  const board = el('board'); if (!board) return;
  const hasFiles = (e) => { const t = e.dataTransfer && e.dataTransfer.types; return !!t && Array.prototype.indexOf.call(t, 'Files') >= 0; };
  const over = (e) => {
    if (!S?.isAdmin || !S.onDrop || !hasFiles(e)) return;
    if (e.target.closest && e.target.closest('.wb-item')) return;      // a card's own drop zone
    e.preventDefault(); e.dataTransfer.dropEffect = 'copy'; board.classList.add('wb-drop-over');
  };
  const leave = (e) => { if (!e.relatedTarget || !board.contains(e.relatedTarget)) board.classList.remove('wb-drop-over'); };
  const drop = (e) => {
    board.classList.remove('wb-drop-over');
    if (!S?.isAdmin || !S.onDrop || !S.sheet) return;
    if (e.target.closest && e.target.closest('.wb-item')) return;
    const files = Array.prototype.slice.call((e.dataTransfer && e.dataTransfer.files) || []);
    if (!files.length) return;
    e.preventDefault(); e.stopPropagation();
    const pt = normPoint(e);
    const pid = infinite() ? planeId() : ((S.board?.pages || [])[pageAtSheetY(pt.v)]?.id || S.pageId);
    const loc = toLocal(pt, pid);
    try { S.onDrop(files, { pageId: pid, x: round4(loc.x), y: round4(loc.y), clientX: e.clientX, clientY: e.clientY }); }
    catch (err) { console.warn('[whiteboard] onDrop failed', err); }
  };
  board.addEventListener('dragenter', over); board.addEventListener('dragover', over);
  board.addEventListener('dragleave', leave); board.addEventListener('drop', drop);
  /* V3.841 — paste from the computer's clipboard (images, text, rich text)
     lands on the sheet near the top-left of the view — unless the paste is
     INTO a field or a card, which keeps it */
  const paste = (e) => {
    if (!S || !S.isAdmin || !S.onPaste || !S.sheet) return;
    const t = e.target;
    if (t && t !== document.body && t !== document.documentElement) {
      if (t.tagName === 'INPUT' || t.tagName === 'TEXTAREA' || t.tagName === 'SELECT' || t.isContentEditable) return;
      if (t.closest && t.closest('.wb-item, .wb-pen-edit, .cw-pop, [contenteditable]')) return;
    }
    const cd = e.clipboardData; if (!cd) return;
    const files = Array.prototype.slice.call(cd.files || []);
    let html = '', text = '';
    try { html = cd.getData('text/html') || ''; text = cd.getData('text/plain') || ''; } catch (err) {}
    if (!files.length && !text.trim() && !html.trim()) return;
    e.preventDefault();
    const at = newItemPlacement();
    try { S.onPaste({ files, text, html, at: { pageId: at.pageId, x: at.x, y: at.y } }); }
    catch (err) { console.warn('[whiteboard] onPaste failed', err); }
  };
  document.addEventListener('paste', paste);
  S.unsubs.push(() => document.removeEventListener('paste', paste));
}

/* ─── Pointer input (draw + erase) ──────────────────────────── */
function bindPointerHandlers() {
  const ink = el('ink');
  if (!ink) return;
  ink.addEventListener('pointerdown', onPointerDown);
  ink.addEventListener('pointermove', onPointerMove);
  ink.addEventListener('pointerup', onPointerUp);
  ink.addEventListener('pointercancel', onPointerUp);
  /* V3.678 — iPadOS Safari fires the LEGACY touch/selection pipeline
     alongside pointer events, and preventDefault on pointerdown does not
     reach it. Between strokes Safari would start a text-selection
     gesture (pen-drag selects the page, then the copy/look-up callout
     opens) and swallow the next stroke. While the drawing tools are
     active, kill that pipeline at the source; viewers are untouched so
     their scrolling still works. passive:false is required or Safari
     ignores the preventDefault. */
  const blockNative = (e) => { if (S?.isAdmin) e.preventDefault(); };
  ink.addEventListener('touchstart',  blockNative, { passive: false });
  ink.addEventListener('touchmove',   blockNative, { passive: false });
  ink.addEventListener('touchend',    blockNative, { passive: false });
  ink.addEventListener('selectstart', blockNative);
  ink.addEventListener('contextmenu', blockNative); // long-press callout
  /* V3.833 — a right-click (desktop) on the sheet opens the host's insert
     menu at that spot; touch long-presses are blocked above on purpose */
  ink.addEventListener('contextmenu', (e) => {
    if (!S?.onSheetContext || !S.isAdmin || !S.sheet || e.pointerType === 'touch') return;
    e.preventDefault();
    const pt = normPoint(e);
    const pages = S.board?.pages || [];
    const pid = pages[pageAtSheetY(pt.v)]?.id || S.pageId;
    const loc = toLocal(pt, pid);
    try { S.onSheetContext({ pageId: pid, x: round4(loc.x), y: round4(loc.y), clientX: e.clientX, clientY: e.clientY }); }
    catch (err) { console.warn('[whiteboard] sheet context failed', err); }
  });
}

/** Pointer → sheet coordinates { u, v, p } in page-width units (u across
 *  the page, v down the whole sheet). Inverts the lens first, then the
 *  sheet mapping, so the pen writes where it touches at any zoom and any
 *  scroll. Page-local coordinates are derived per stroke from the page
 *  the stroke belongs to (toLocal). */
function normPoint(e) {
  const ink = el('ink');
  const r = ink.getBoundingClientRect();
  const dpr = ink.width / Math.max(1, r.width);
  let px = (e.clientX - r.left) * dpr, py = (e.clientY - r.top) * dpr;
  const sh = S.sheet;
  if (lensActive()) {
    const v = S.view;
    px = (px - v.tx * sh.pageW) / v.scale;
    py = (py - v.ty * sh.pageW) / v.scale;
  }
  return { u: (px - sh.offX) / sh.pageW + (sh.originX || 0), v: py / sh.pageW + sh.originY, p: e.pressure || 0.5 };
}
/** Sheet point → coordinates local to page `pid` (may overhang: y < 0 or
 *  y > BOARD_H is allowed — decision 13 of the V3.730 plan). */
function toLocal(pt, pid) {
  return { x: pt.u, y: pt.v - pageTop(pageIndexOf(pid)), p: pt.p };
}

/** Board-space distance that corresponds to a constant SCREEN size.
 *  Zoomed in, the eraser must stay the same size under the finger and
 *  sampling must get finer — both are screen-relative, not board-relative. */
function viewScale() { return lensActive() ? S.view.scale : 1; }

function inksHere(e) {
  /* pen-only on touch devices = palm rejection; mouse kept for desktop */
  if (!S?.isAdmin) return false;
  if (e.pointerType === 'pen' || e.pointerType === 'mouse') return true;
  /* V3.863 — a phone has no stylus: in the pen / highlighter / eraser modes ONE finger draws (two still pan and pinch) */
  return e.pointerType === 'touch' && mobile() && (S.tool === 'pen' || S.tool === 'eraser');
}

function onPointerDown(e) {
  tapDown(e);   /* V3.860 — fingers too: a double tap switches the hand's mode */
  if (!inksHere(e)) return;
  if (e.pointerType === 'touch' && (S.active || S.erasing)) { cancelTouchInk(); return; }   /* V3.863 — a second finger: pan / pinch */
  e.preventDefault();
  const ink = e.currentTarget;
  try { ink.setPointerCapture(e.pointerId); } catch (err) {}
  const pt = normPoint(e);
  if (S.tool === 'eraser') {
    S.erasing = true;
    eraseAt(pt);
    return;
  }
  /* V3.837 — view tools from the zoom pill */
  if (S.tool === 'pan' || S.tool === 'card') { S.panDrag = { x: e.clientX, y: e.clientY }; return; }   /* V3.863 — Cards: the empty board pans */
  if (S.tool === 'zoom') {
    /* V3.860 — the zoom hand: tap (on release) or drag */
    const f = zoomFrame(e.clientX, e.clientY);
    S.zoomDrag = { x0: e.clientX, y0: e.clientY, fx: f.x, fy: f.y, scale0: S.view?.scale || 1, out: !!(e.altKey || e.shiftKey || e.button === 2), moved: false };
    el('root')?.classList.add('wb-zooming');
    return;
  }
  const pages = S.board?.pages || [];
  const pid = pages[pageAtSheetY(pt.v)]?.id || S.pageId;
  /* V3.837 — ⬚ Region: drag a rectangle; the host decides what it becomes.
     The zoom pill's "fit a region" draws the same box and frames it. */
  if (S.tool === 'region' || S.tool === 'fitregion' || S.tool === 'group') {
    S.regionDrag = { pid, u0: pt.u, v0: pt.v, u1: pt.u, v1: pt.v, mode: S.tool === 'fitregion' ? 'fit' : S.tool === 'group' ? 'group' : 'region' };
    paintLiveNow();
    return;
  }
  /* Nobody leads yet → the device that draws is the natural leader. Never
     steals an existing lead. */
  /* pen only: a mouse click on the laptop's board must not make the laptop
     the leader behind the tablet's back (seen in class) */
  if (S.coll === 'whiteboards' && S.canGoLive && S.board && !S.board.leaderDeviceId && !S._claimedLead && e.pointerType === 'pen') {
    S._claimedLead = true;
    setLeader(true);
  }
  startStroke(toLocal(pt, pid), pid);
  if (S.active) { S.active.ptr = e.pointerId; S.active.touch = e.pointerType === 'touch'; }   /* V3.863 — only this pointer draws */
}

function onPointerMove(e) {
  if (!S || !inksHere(e)) return;
  if (S.panDrag) { e.preventDefault(); panByPointer(e); return; }
  if (S.zoomDrag) {
    e.preventDefault();
    const z = S.zoomDrag, dy = e.clientY - z.y0;
    if (!z.moved && Math.hypot(e.clientX - z.x0, dy) < 6) return;
    z.moved = true;
    const target = z.scale0 * Math.exp(-dy / 180);   /* drag up = in */
    zoomAt(target / (S.view?.scale || 1), z.fx, z.fy);
    return;
  }
  if (S.regionDrag) { e.preventDefault(); const pt = normPoint(e); S.regionDrag.u1 = pt.u; S.regionDrag.v1 = pt.v; paintLiveNow(); return; }
  if (S.erasing) {
    e.preventDefault();
    eraseAt(normPoint(e));
    return;
  }
  if (!S.active) return;
  if (S.active.ptr != null && e.pointerId !== S.active.ptr) return;   /* V3.863 */
  e.preventDefault();
  /* V3.839 — an EMPTY coalesced list (synthetic / some pen drivers) must
     still add the event itself, or a stroke stays a single dot */
  let events = e.getCoalescedEvents ? e.getCoalescedEvents() : null;
  if (!events || !events.length) events = [e];
  events.forEach(ev => addPointToActive(normPoint(ev)));
}

function onPointerUp(e) {
  if (!S) return;
  if (S.zoomDrag) {
    const z = S.zoomDrag; S.zoomDrag = null; el('root')?.classList.remove('wb-zooming');
    const tapped = tapUp(e);
    if (z.moved) { persistView(); return; }
    if (tapped !== 'double') {
      if (S._zoomTapT) clearTimeout(S._zoomTapT);
      /* the zoom happens once the double-tap window has closed — and then the next tap starts afresh, so tap · tap · tap zooms
         three times at a steady pace */
      S._zoomTapT = setTimeout(() => { if (!S) return; S._zoomTapT = null; S._lastTap = null; zoomAt(z.out ? 1 / 1.5 : 1.5, z.fx, z.fy); persistView(); }, DOUBLE_MS);
    }
    return;
  }
  if (S.panDrag) { S.panDrag = null; if (tapUp(e) === 'tap' && S.tool === 'card' && S.cardSel) cardSelect(null); if (continuous()) settleScroll(); else setActivePage((S.board?.pages || [])[nearestPageToView()]?.id || S.pageId, true); persistView(); return; }
  if (S.regionDrag) { finishRegion(); S._tapDown = null; return; }
  if (S.erasing) { S.erasing = false; tapUp(e); return; }
  /* V3.863 — Cards: a finger tap on the empty board lets the chosen card go (a finger never pans through here) */
  if (S.tool === 'card') { if (tapUp(e) === 'tap' && S.cardSel) cardSelect(null); return; }
  if (S.active && (S.active.ptr == null || S.active.ptr === e.pointerId)) finishStroke(false);
  tapUp(e);   /* V3.860 — after the stroke is committed, so a double click's two dots can be taken back */
}

function startStroke(pt, pid) {
  const id = newId('s');
  S.active = {
    id,
    pageId: pid || S.pageId,
    seq: Date.now(),
    color: S.color,
    w: S.width,
    hl: !!S.hl,                           // V3.839 — highlighter band
    pts: [round5(pt.x), round5(pt.y), round2(S.hl ? 0.5 : pt.p)],
    dirty: true,
    timer: setInterval(() => flushActive(false), FLUSH_MS)
  };
  S.activeLocalId = id;
  S.strokes.set(id, S.active);
  S.myIds.push(id);
  paintActiveStroke();
}

function addPointToActive(sheetPt) {
  const st = S.active;
  if (!st) return;
  const pt = toLocal(sheetPt, st.pageId);
  const n = st.pts.length;
  const dx = pt.x - st.pts[n - 3], dy = pt.y - st.pts[n - 2];
  /* Scale-relative: zoomed in, the same finger travel covers less board,
     so a fixed board-space threshold would throw away the extra detail
     the zoom exists to capture. No-op at scale 1. */
  const minSeg = MIN_SEG / viewScale();
  if (dx * dx + dy * dy < minSeg * minSeg) return;
  st.pts.push(round5(pt.x), round5(pt.y), round2(st.hl ? 0.5 : pt.p));
  st.dirty = true;
  paintActiveStroke();
  /* keep stroke docs bounded — chain a fresh doc mid-stroke */
  if (st.pts.length >= MAX_PTS * 3) {
    const lastX = pt.x, lastY = pt.y, lastP = pt.p, pid = st.pageId;
    finishStroke(false);
    startStroke({ x: lastX, y: lastY, p: lastP }, pid);
  }
}

function finishStroke(fromTeardown) {
  const st = S?.active;
  if (!st) return;
  clearInterval(st.timer);
  st.done = true;
  S.active = null;
  /* release the snapshot guard BEFORE the final flush: the wire copy that
     comes back is the stroke's final form and may replace the local one */
  S.activeLocalId = null;
  flushStroke(st, true);
  paintActiveStroke();                 // clears the live layer (S.active is null)
  if (!fromTeardown) { schedulePaint(); scheduleGrow(); }
}

function flushActive(final) {
  const st = S?.active;
  if (!st) return;
  if (!st.dirty && !final) return;
  st.dirty = false;
  flushStroke(st, final);
}

/* V3.683 — Ramer-Douglas-Peucker on the (x,y) polyline, carrying each
   kept point's pressure. Curvature decides what survives, so the dense
   samples that make handwriting legible are exactly the ones retained
   while a straight ruler-line collapses to its endpoints. Applied to a
   COPY at flush time — never to the live st.pts the pen is appending to,
   or the in-progress geometry would shift under the drawing loop. */
function simplifyPts(pts, eps) {
  const n = pts.length / 3;
  if (n < 3) return pts;
  const keep = new Uint8Array(n);
  keep[0] = keep[n - 1] = 1;
  const e2 = eps * eps;
  const stack = [[0, n - 1]];
  while (stack.length) {
    const [a, b] = stack.pop();
    if (b - a < 2) continue;
    const ax = pts[a * 3], ay = pts[a * 3 + 1];
    const bx = pts[b * 3], by = pts[b * 3 + 1];
    let best = -1, bestD = -1;
    for (let i = a + 1; i < b; i++) {
      const d = segDist2(pts[i * 3], pts[i * 3 + 1], ax, ay, bx, by);
      if (d > bestD) { bestD = d; best = i; }
    }
    if (best > 0 && bestD > e2) {
      keep[best] = 1;
      stack.push([a, best], [best, b]);
    }
  }
  const out = [];
  for (let i = 0; i < n; i++) {
    if (keep[i]) out.push(pts[i * 3], pts[i * 3 + 1], pts[i * 3 + 2]);
  }
  return out;
}

/* Simplify to at most WIRE_MAX_PTS points, coarsening the tolerance until
   it fits. Bounded iterations — a pathological input falls through with
   whatever the last pass produced rather than spinning. */
function simplifyToBudget(pts, eps, budget) {
  let out = simplifyPts(pts, eps);
  let e = eps;
  for (let i = 0; i < 8 && out.length / 3 > budget; i++) {
    e *= 1.8;
    out = simplifyPts(pts, e);
  }
  return out;
}

function flushStroke(st, final) {
  if (!S) return;
  /* V3.731 — t0/t1 (pen-down / pen-up wall clock) let a lecture replay
     grow the stroke over the time it took to write. t1 is only known on
     the final flush. */
  const payload = {
    pageId: st.pageId, seq: st.seq, color: st.color, w: st.w,
    pts: simplifyToBudget(st.pts, SIMPLIFY_EPS, WIRE_MAX_PTS), done: !!final,
    t0: st.seq
  };
  if (st.hl) payload.hl = true;            // V3.839 — only when set (never an undefined field)
  if (final) payload.t1 = Date.now();
  boardsCol(S.classId, S.coll).doc(S.boardId).collection('strokes').doc(st.id)
    .set(payload)
    .then(() => {
      if (final && S && !S.touchedThisSession) {
        S.touchedThisSession = true;
        boardsCol(S.classId, S.coll).doc(S.boardId)
          .update({ updatedAt: FV().serverTimestamp() }).catch(() => {});
      }
    })
    .catch(err => {
      console.warn('[whiteboard] stroke write failed', err);
      if (!S._writeErrToasted) {
        S._writeErrToasted = true;
        toast('Ink is not saving — check that you are signed in as a class admin.');
      }
    });
}

/* Stroke eraser: remove any stroke whose polyline passes near the point.
   `pt` is a sheet point; each stroke is tested in its own page's frame. */
function eraseAt(pt) {
  if (!S) return;
  const hits = [];
  S.strokes.forEach((s, id) => {
    if (S.erased.has(id) || s.erasedAt || s.hiddenBy) return;
    const local = toLocal(pt, s.pageId);
    const tol = (s.w || 0.004) / 2 + (S.eraserW || ERASE_TOL) / viewScale();   // V3.841 — the eraser in hand has a size
    if (strokeHit(s.pts, local, tol)) hits.push(id);
  });
  if (!hits.length) return;
  removeStrokes(hits);
}

/** Remove strokes locally and in Firestore. While a lecture is being
 *  recorded on this board the removal is a SOFT delete (`erasedAt`), so
 *  the replay can still show the stroke up to the moment it vanished;
 *  otherwise the doc is deleted outright (scratch boards stay small). */
function removeStrokes(ids) {
  if (!S || !ids.length) return;
  const soft = recordingActive();
  const now = Date.now();
  /* the recorder erasing locally logs the event itself — its own snapshot
     will already carry erasedAt and the listener would not see a change */
  if (soft) recEvent('erase', { strokeIds: ids.slice() });
  ids.forEach(id => {
    const s = S.strokes.get(id);
    if (s) markThumb(s.pageId);
    if (soft) { if (s) s.erasedAt = now; }
    else S.strokes.delete(id);
    S.erased.add(id);
  });
  schedulePaint();
  const col = boardsCol(S.classId, S.coll).doc(S.boardId).collection('strokes');
  const run = async () => {
    for (let i = 0; i < ids.length; i += 400) {
      const batch = db().batch();
      ids.slice(i, i + 400).forEach(id => soft
        ? batch.update(col.doc(id), { erasedAt: now })
        : batch.delete(col.doc(id)));
      await batch.commit();
    }
  };
  run().catch(err => console.warn('[whiteboard] erase failed', err));
}

/** Is a lecture recording running on THIS board right now? (R2 sets
 *  liveWhiteboard.recId; until then this is always false.) */
function recordingActive() {
  if (isNotebook()) return !!(REC && S && REC.boardId === S.boardId);   /* V3.830 — no live flag */
  return !!(S && S.live && S.live.boardId === S.boardId && S.live.recId);
}

function strokeHit(pts, pt, tol) {
  if (!Array.isArray(pts)) return false;
  const t2 = tol * tol;
  if (pts.length === 3) {
    const dx = pts[0] - pt.x, dy = pts[1] - pt.y;
    return dx * dx + dy * dy <= t2;
  }
  for (let i = 3; i < pts.length; i += 3) {
    if (segDist2(pt.x, pt.y, pts[i - 3], pts[i - 2], pts[i], pts[i + 1]) <= t2) return true;
  }
  return false;
}

function segDist2(px, py, ax, ay, bx, by) {
  const abx = bx - ax, aby = by - ay;
  const apx = px - ax, apy = py - ay;
  const len2 = abx * abx + aby * aby;
  let t = len2 ? (apx * abx + apy * aby) / len2 : 0;
  t = Math.max(0, Math.min(1, t));
  const dx = px - (ax + t * abx), dy = py - (ay + t * aby);
  return dx * dx + dy * dy;
}

/* ================================================================
   LECTURE RECORDING (V3.731) — the device that presses Go live records
   ================================================================
   Go live = record (decision 2). The click is the microphone permission
   gesture; the recorder is MODULE-LEVEL (REC), not part of S, so
   navigating between the board and the module page does not kill a
   lecture recording — only End live, 20 idle minutes, or the flag being
   cleared from another device do.

   Audio: MediaRecorder in the first supported container of audio/mp4
   (AAC — Safari and recent Chrome, plays everywhere) then WebM/Opus.
   Chunks every REC_CHUNK_MS go straight to Storage under
   classes/{classId}/whiteboards/{boardId}/recordings/{recId}/ and are
   listed on the recording doc, so a crashed tab loses at most a minute.

   Timeline: everything is wall-clock ms since startedAtMs. Strokes carry
   their own t0/t1; page flips, erases and figure moves are EVENTS the
   recorder writes as it observes them through the same listeners every
   viewer already has — so the iPad needs no idea a recording is running.
   ================================================================ */
const REC_CHUNK_MS       = 60000;
const REC_IDLE_END_MS    = 20 * 60 * 1000;
const REC_EVENT_FLUSH_MS = 2000;
let REC = null;

function recMime() {
  if (typeof MediaRecorder === 'undefined' || !MediaRecorder.isTypeSupported) return null;
  for (const m of ['audio/mp4', 'audio/mp4;codecs=mp4a.40.2', 'audio/webm;codecs=opus', 'audio/webm']) {
    if (MediaRecorder.isTypeSupported(m)) return m;
  }
  return null;
}
function recExt(mime) { return /mp4/.test(mime) ? 'm4a' : 'webm'; }
function recCol() {
  return boardsCol(REC.classId, REC.coll || 'whiteboards').doc(REC.boardId).collection('recordings').doc(REC.recId);
}
function recording() { return !!(REC && S && REC.boardId === S.boardId); }

/* ================================================================
   V3.884 — the one recorder (CodeLog/ClaudesPlan/V3.884_one_recorder_program.md):
   marks and pause, as Scientia's recorder has them. A mark is { id, t, kind,
   label, end? } (rm/js/recorder-core.js) with t in WALL seconds since the
   start, like everything else on this timeline (`marksClock: 'wall'` on the
   doc); kinds important · question · decision · to do; a section has an
   end (null while open). Pause = MediaRecorder.pause(); resume logs the
   pause as a `gap` event, so the replay's audio ↔ wall rule already skips it.
   ================================================================ */
let _recCoreP = null;
function ensureRecCore() {
  if (window.RECORDER_CORE) return Promise.resolve(window.RECORDER_CORE);
  if (!_recCoreP) _recCoreP = new Promise(res => {
    const sc = document.createElement('script'); sc.src = '/rm/js/recorder-core.js?v=3884';
    sc.onload = () => res(window.RECORDER_CORE || null); sc.onerror = () => { _recCoreP = null; res(null); };
    document.head.appendChild(sc);
  });
  return _recCoreP;
}
function recColOf(rec) { return boardsCol(rec.classId, rec.coll || 'whiteboards').doc(rec.boardId).collection('recordings').doc(rec.recId); }
function recNowSec() { return REC ? Math.round((Date.now() - REC.startedAtMs) / 10) / 100 : 0; }
function recSaveMarks() {
  const rec = REC; if (!rec) return;
  clearTimeout(rec.markT);
  rec.markT = setTimeout(() => recColOf(rec).update({ marks: rec.marks, marksClock: 'wall' }).catch(e => console.warn('[whiteboard] marks not saved', e)), 400);
}
function recMmss(t) { return window.RECORDER_CORE ? RECORDER_CORE.mmss(t) : Math.round(t) + ' s'; }
function recLastMark() { const ms = (REC && REC.marks) || []; return ms.find(m => m.id === REC.lastMarkId) || ms[ms.length - 1] || null; }
/** V3.886 — one Mark: a plain mark at this moment; from the ✦ fan its editor opens on it (Alt+M just drops it). */
async function recMark(kind, edit) {
  if (!REC) return;
  const C = await ensureRecCore(); if (!C || !REC) { toast('Marks need a moment to load — try again.'); return; }
  const t = recNowSec(), id = 'mk' + Date.now().toString(36);
  REC.marks = C.addMark(REC.marks, { id, t, kind }); REC.lastMarkId = id;
  recSaveMarks(); recTouch();
  if (S && (edit || S.openPill === 'tools')) S.markEdit = id;
  else toast(`◆ Marked at ${C.mmss(t)} — say what it is under ✦ Tools.`);
  renderPills();
}
/* V3.886 — the mark editor: what a mark is, said once it is in (its kind, its words, how long it lasts). It sits
   beside the ✦ pill like the pen editor beside ✎; never a browser popup. */
function markEditorHTML() {
  const C = window.RECORDER_CORE, m = C && REC && (REC.marks || []).find(x => x.id === S.markEdit); if (!m) return '';
  const span = typeof m.end === 'number', when = C.mmss(m.t) + (span ? ' – ' + C.mmss(m.end) : m.end === null ? ' – …' : '');
  const kinds = C.MARK_KINDS.map(k => `<button type="button" class="wb-pe-kind${C.kindOf(m.kind) === k.id ? ' wb-sel' : ''}" data-wb-me="kind" data-v="${k.id}">${k.glyph} ${k.label}</button>`).join('');
  return `<div class="wb-pen-edit wb-mark-edit" data-wb-markedit data-pill="tools">
    <div class="wb-pe-row wb-me-head"><span class="wb-pe-lbl">Mark at ${esc(when)}</span><span class="wb-pe-hint">what is it?</span></div>
    <div class="wb-pe-row wb-pe-kinds wb-me-kinds">${kinds}</div>
    <div class="wb-pe-row"><input type="text" class="wb-me-label" data-wb-me-label maxlength="200" value="${escAttr(m.label || '')}" placeholder="In a few words (optional)" aria-label="What this mark is about"></div>
    <div class="wb-pe-row wb-pe-foot wb-me-foot"><button type="button" class="wb-pe-btn" data-wb-me="until" title="It lasts from its moment until now">${span ? 'Until now' : 'Lasts until now'}</button>${span ? '<button type="button" class="wb-pe-btn" data-wb-me="moment">Just the moment</button>' : ''}<button type="button" class="wb-pe-btn wb-pe-remove" data-wb-me="remove">Remove</button><button type="button" class="wb-pe-btn wb-pe-done" data-wb-me="done">Done</button></div>
  </div>`;
}
function markEditorAction(btn) {
  const C = window.RECORDER_CORE, rec = REC, id = S.markEdit, m = rec && (rec.marks || []).find(x => x.id === id);
  if (!C || !m) return;
  const what = btn.dataset.wbMe;
  if (what === 'kind') rec.marks = C.updateMark(rec.marks, id, { kind: btn.dataset.v });
  else if (what === 'until') { const t = recNowSec(); if (t - m.t < 1) { toast('Press it when the part that matters is over.'); return; } rec.marks = C.spanTo(rec.marks, id, t); }
  else if (what === 'moment') rec.marks = C.spanTo(rec.marks, id, null);
  else if (what === 'remove') { if (!armTwoTap(btn, 'Really remove?')) return; rec.marks = C.removeMark(rec.marks, id); S.markEdit = null; if (rec.lastMarkId === id) rec.lastMarkId = null; }
  else if (what === 'done') { S.markEdit = null; S.openPill = null; renderPills(); return; }
  else return;
  recSaveMarks(); renderPills();
}
function recPause() {
  const rec = REC; if (!rec?.recorder || rec.pausedAt) return;
  try { rec.recorder.pause(); } catch (e) {}
  rec.pausedAt = Date.now(); clearTimeout(rec.idleTimer);   /* a paused recording does not time out */
  recColOf(rec).update({ paused: true }).catch(() => {});
  renderPills();
}
function recResume() {
  const rec = REC; if (!rec?.pausedAt) return;
  const gap = Date.now() - rec.pausedAt; rec.pausedAt = null;
  try { rec.recorder.resume(); } catch (e) {}
  if (gap > 500) recEvent('gap', { durationMs: gap, reason: 'pause' });
  recColOf(rec).update({ paused: false }).catch(() => {});
  recTouch(); renderPills();
}
function recKeys(e) {
  if (!REC || !recording() || !e.altKey || e.ctrlKey || e.metaKey) return;
  const k = (e.key || '').toLowerCase();
  if (k === 'm') { e.preventDefault(); recMark('important'); }     /* Scientia's Alt+M */
  else if (k === 'p') { e.preventDefault(); if (REC.pausedAt) recResume(); else recPause(); }
}

/** Ask for the mic and start a recording for the mounted board. Returns
 *  { recId } or null (no mic / denied / unsupported). Never throws. */
async function startRecording() {
  if (!S || REC) return REC && REC.boardId === S.boardId ? { recId: REC.recId } : null;
  const mime = recMime();
  if (!mime || !navigator.mediaDevices?.getUserMedia) return null;
  let stream;
  try {
    stream = await navigator.mediaDevices.getUserMedia({
      audio: { echoCancellation: true, noiseSuppression: true, autoGainControl: true }
    });
  } catch (e) { console.warn('[whiteboard] mic unavailable', e); return null; }

  const recId = newId('r');
  const startedAtMs = Date.now();
  const pages = (S.board?.pages || []).map(p => ({ id: p.id, background: p.background || 'blank', ...(p.kind === 'sim' ? { kind: 'sim', sim: p.sim } : {}) }));
  const itemsAtStart = [...S.items.entries()].map(([id, it]) => itemEventPayload(id, it));
  const d = new Date(startedAtMs);
  const doc = {
    name: `${S.board?.name || 'Whiteboard'} — ${d.toLocaleDateString(undefined, { month: 'short', day: 'numeric' })}`,
    status: 'recording',
    startedAt: FV().serverTimestamp(), startedAtMs,
    recorderClientId: recClientId(),
    startPageId: S.board?.activePageId || S.pageId || pages[0]?.id || 'p1',
    /* V3.801 — continuous mode: where the leader was scrolled at the start.
       V3.830 — a notebook board: where THIS device is scrolled. */
    ...(continuous() && typeof S.board?.viewY === 'number' ? { startViewY: S.board.viewY }
        : (isNotebook() && continuous() && S.sheet) ? { startViewY: round4(viewCentre()) } : {}),
    pages, itemsAtStart,
    mime, chunks: [], clockSkewMs: 0,
    createdBy: window.McgheeLab?.Auth?.currentUser?.uid || ''
  };
  REC = { recId, classId: S.classId, boardId: S.boardId, coll: S.coll, startedAtMs, mime, stream,
          /* a notebook recording has no live flag to arm against */
          arming: !isNotebook(), recorder: null, n: 0, uploads: Promise.resolve(), pending: [], evTimer: null,
          idleTimer: null, timerTick: null, wakeLock: null, skew: null, hiddenAt: null,
          marks: [], pausedAt: null, markT: null };   /* V3.884 — the one recorder: marks + pause */
  ensureRecCore();
  try {
    await boardsCol(S.classId, S.coll).doc(S.boardId).collection('recordings').doc(recId).set(doc);
  } catch (e) {
    console.warn('[whiteboard] could not create recording', e);
    stream.getTracks().forEach(t => t.stop());
    REC = null;
    return null;
  }
  try {
    const recorder = new MediaRecorder(stream, { mimeType: mime, audioBitsPerSecond: 64000 });
    /* closure over THIS recording, not the REC global: the final chunk
       arrives after stopRecording() has already cleared REC (V3.735 —
       that dropped the tail of every lecture, up to 60 s) */
    const rec = REC;
    recorder.ondataavailable = (e) => { if (e.data && e.data.size) recUploadChunk(rec, e.data); };
    recorder.onerror = (e) => console.warn('[whiteboard] recorder error', e);
    recorder.start(REC_CHUNK_MS);
    REC.recorder = recorder;
  } catch (e) {
    console.warn('[whiteboard] MediaRecorder failed', e);
    stream.getTracks().forEach(t => t.stop());
    /* no recorder → no recording. A 'ready' doc with no audio would list
       as a replayable lecture that cannot play. */
    recCol().delete().catch(() => {});
    REC = null;
    toast('Recording could not start on this device (' + (e && e.name ? e.name : 'recorder error') + ').');
    return null;
  }
  recTouch();
  REC.timerTick = setInterval(() => {
    document.querySelectorAll('[data-wb-rec-timer]').forEach(n => { n.innerHTML = `<span class="wb-live-dot"></span> ${ICON.svg('microphone')} ${recElapsedLabel()}`; });
  }, 1000);
  recWakeLock();
  document.addEventListener('keydown', recKeys, true);   /* V3.884 — Alt+M mark, Alt+P pause */
  document.addEventListener('visibilitychange', recOnVisibility);
  window.addEventListener('pagehide', recOnPageHide);
  renderTopbarRight(); renderProjectorCtl();
  return { recId };
}

/* V3.733 — a per-DEVICE id (localStorage, survives reloads and tabs) used
   for the leader designation on the board doc. */
function deviceId() {
  try {
    let id = localStorage.getItem('wb_device');
    if (!id) { id = newId('d'); localStorage.setItem('wb_device', id); }
    return id;
  } catch (e) { return 'd-unknown'; }
}
/** Leader = the ONE device whose page changes the room follows. Stored on
 *  the board doc (`leaderDeviceId`), so every other admin device — the
 *  laptop on the projector, a second tablet — is a follower by default
 *  and snaps along exactly like a student's screen. Only class admins can
 *  take the lead. */
function isLeader() {
  return !!(S && S.canGoLive && S.board && S.board.leaderDeviceId === deviceId());
}
async function setLeader(on) {
  if (!S || !S.canGoLive) return;
  try {
    await boardsCol(S.classId, S.coll).doc(S.boardId)
      .update(on ? { leaderDeviceId: deviceId() } : { leaderDeviceId: FV().delete() });
    toast(on ? 'This device now leads — everyone follows its page.' : 'This device is following.');
  } catch (e) { console.warn('[whiteboard] leader change failed', e); toast('Could not change leader.'); }
}

/** V3.740 — put this device back on the leader's page and following.
 *  Re-reads the board doc (a dropped listener would otherwise leave us on
 *  a stale activePageId), so it recovers from every drift path: a manual
 *  flip, a stray trackpad scroll, or a missed snapshot. */
async function resyncFollow(animate) {
  if (!S) return;
  S.follow = true;
  try {
    const doc = await boardsCol(S.classId, S.coll).doc(S.boardId).get();
    if (!S) return;
    if (doc.exists) {
      const d = doc.data();
      const prevPages = S.board?.pages;
      S.board = d;
      if (JSON.stringify(prevPages || null) !== JSON.stringify(d.pages || null)) (d.pages || []).forEach(p => markThumb(p.id));
    }
  } catch (e) { console.warn('[whiteboard] resync read failed', e); }
  const target = S.board?.activePageId || S.board?.pages?.[0]?.id;
  if (target && (S.board?.pages || []).some(p => p.id === target)) S.pageId = target;
  /* V3.801 — continuous: back to the leader's exact scroll, not the page centre */
  if (continuous() && typeof S.board?.viewY === 'number') scrollSheetTo(S.board.viewY, animate === false ? 0 : SNAP_MS);
  else centreOn(pageIndexOf(S.pageId), animate !== false);
  renderRail(); renderPagesBar(); renderToolbar(); renderTopbarRight(); renderProjectorCtl();
}
/** Followers keep in step; the leader (and personal boards' owner) is exempt. */
function followsLeader() {
  if (!S) return false;
  return S.coll === 'whiteboards' ? !isLeader() : !S.isAdmin;
}

/** V3.775 — after a reload, is the live recording one THIS tab started?
 *  The recording doc's recorderClientId is per-tab (sessionStorage), so it
 *  survives the reload that destroyed the in-memory recorder. If so, offer
 *  to save what was captured and record again (the badge button). */
async function detectLostRecording(recId) {
  if (!S) return;
  const classId = S.classId, boardId = S.boardId;
  try {
    const snap = await boardsCol(classId, 'whiteboards').doc(boardId).collection('recordings').doc(recId).get();
    if (!S || S.boardId !== boardId || REC || !snap.exists) return;
    const d = snap.data();
    if (d.status !== 'recording' || d.recorderClientId !== recClientId()) return;
    S.recLost = recId;
    renderTopbarRight(); renderProjectorCtl();
    toast('This tab was recording the lecture and lost it when the page reloaded. Tap "record again" to keep recording.');
  } catch (e) { console.warn('[whiteboard] lost-recording check failed', e); }
}

function recClientId() {
  try {
    let id = sessionStorage.getItem('wb_client');
    if (!id) { id = newId('c'); sessionStorage.setItem('wb_client', id); }
    return id;
  } catch (e) { return 'c-unknown'; }
}

async function recWakeLock() {
  if (!REC || !navigator.wakeLock?.request) return;
  try { REC.wakeLock = await navigator.wakeLock.request('screen'); } catch (e) { /* denied: fine */ }
}
/* Suspended tab (iPad lock / app switch): the recorder pauses. On return
   the missing time is logged as a gap so the replay inserts silence and
   the ink stays aligned. */
function recOnVisibility() {
  if (!REC) return;
  if (document.hidden) { REC.hiddenAt = Date.now(); return; }
  recWakeLock();
  if (REC.pausedAt) { REC.hiddenAt = null; return; }   /* V3.884 — paused by the person: their resume logs the gap */
  const r = REC.recorder;
  if (r && r.state === 'paused') {
    const gap = Date.now() - (REC.hiddenAt || Date.now());
    try { r.resume(); } catch (e) {}
    if (gap > 1500) recEvent('gap', { durationMs: gap });
  }
  REC.hiddenAt = null;
}
function recOnPageHide() {
  if (!REC?.recorder) return;
  try { REC.recorder.requestData(); } catch (e) {}
  recFlushEvents();
}

/** Upload one chunk and list it on the recording doc, strictly in order.
 *  Takes the recording explicitly so the last chunk — delivered by
 *  MediaRecorder AFTER stop() — is uploaded even though REC is gone. */
function recUploadChunk(rec, blob) {
  if (!rec) return;
  const n = rec.n++;
  const tStart = Math.max(0, (rec.lastChunkAt || rec.startedAtMs) - rec.startedAtMs);
  rec.lastChunkAt = Date.now();
  rec.uploads = rec.uploads.then(async () => {
    const path = rec.coll === 'notebookBoards'
      ? `${hostPrefixFor(rec.coll)}/${rec.classId}/${rec.boardId}/recordings/${rec.recId}/chunk-${String(n).padStart(3, '0')}.${recExt(rec.mime)}`
      : `classes/${rec.classId}/whiteboards/${rec.boardId}/recordings/${rec.recId}/chunk-${String(n).padStart(3, '0')}.${recExt(rec.mime)}`;
    try {
      const ref = firebase.storage().ref().child(path);
      await ref.put(blob, { contentType: rec.mime.split(';')[0] });
      const url = await ref.getDownloadURL();
      await boardsCol(rec.classId, rec.coll || 'whiteboards').doc(rec.boardId).collection('recordings').doc(rec.recId)
        .update({ chunks: FV().arrayUnion({ n, path, url, bytes: blob.size, tStart }) });
    } catch (e) {
      console.warn('[whiteboard] chunk upload failed', n, e);
      if (S && REC === rec) toast('A minute of audio failed to upload — check the connection.');
    }
  });
}

/** Queue a timed event; flushed in one batch every 2 s. */
function recEvent(type, payload) {
  if (!REC || !S || REC.boardId !== S.boardId) return;
  REC.pending.push({ t: Date.now() - REC.startedAtMs, type, ...(payload || {}) });
  recTouch();
  if (!REC.evTimer) REC.evTimer = setTimeout(recFlushEvents, REC_EVENT_FLUSH_MS);
}
function recFlushEvents() {
  if (!REC) return;
  clearTimeout(REC.evTimer); REC.evTimer = null;
  const batchItems = REC.pending.splice(0, 400);
  if (!batchItems.length) return;
  const col = recCol().collection('events');
  const batch = db().batch();
  batchItems.forEach(ev => batch.set(col.doc(newId('e')), ev));
  batch.commit().catch(e => console.warn('[whiteboard] event flush failed', e));
  if (REC.pending.length) REC.evTimer = setTimeout(recFlushEvents, 50);
}

/** Any board activity resets the 20-minute idle timer (decision 7). */
function recTouch() {
  if (!REC) return;
  clearTimeout(REC.idleTimer);
  REC.idleTimer = setTimeout(async () => {
    if (!REC) return;
    const classId = REC.classId, nb = REC.coll === 'notebookBoards';
    await stopRecording('idle');
    if (nb) { toast('Recording ended after 20 minutes of no board activity.'); return; }
    try { await db().collection('schedules').doc(classId).update({ liveWhiteboard: FV().delete() }); } catch (e) {}
    toast('Recording ended after 20 minutes of no board activity. Live ended.');
  }, REC_IDLE_END_MS);
}

/* Board-doc diffs the recorder cares about. */
function recObserveBoard(prev, next) {
  if (!REC || !S || REC.boardId !== S.boardId || !prev || !next) return;
  /* V3.801 — continuous mode: a page change carries the leader's scroll
     position, and scrolling within a page is logged as `scroll` events
     (coalesced, see recScroll) so the replay scrolls the way the lecture
     did instead of snapping between page centres. */
  const hasY = typeof next.viewY === 'number' && (next.sheetMode || 'continuous') !== 'pages';
  /* V3.830 — a notebook board never writes viewY; its page event carries
     the drawer's own scroll so the replay does not snap to a page centre */
  const nbY = (isNotebook() && continuous() && S.sheet) ? round4(viewCentre()) : null;
  if (prev.activePageId !== next.activePageId && next.activePageId) {
    recEvent('page', { pageId: next.activePageId, ...(hasY ? { y: next.viewY } : nbY != null ? { y: nbY } : {}) });
    if (hasY) { clearTimeout(REC.scrollTimer); REC.scrollTimer = null; REC.scrollAt = Date.now(); }
  } else if (hasY && prev.viewY !== next.viewY) {
    recScroll(next.viewY);
  }
  const prevIds = new Set((prev.pages || []).map(p => p.id));
  const nextIds = new Set((next.pages || []).map(p => p.id));
  (prev.pages || []).forEach(p => { if (!nextIds.has(p.id)) recEvent('remove-page', { pageId: p.id }); });
  /* same set, different sequence → a reorder */
  const prevSeq = (prev.pages || []).filter(p => nextIds.has(p.id)).map(p => p.id).join(',');
  const nextSeq = (next.pages || []).filter(p => prevIds.has(p.id)).map(p => p.id).join(',');
  if (prevSeq !== nextSeq) recEvent('move-page', { order: (next.pages || []).map(p => p.id) });
  (next.pages || []).forEach(p => { if (!prevIds.has(p.id)) recEvent('add-page', { pageId: p.id, background: p.background || 'blank', ...(p.kind === 'sim' ? { kind: 'sim', sim: p.sim } : {}) }); });
  (next.pages || []).forEach(p => {
    const q = (prev.pages || []).find(x => x.id === p.id);
    if (q && (q.background || 'blank') !== (p.background || 'blank')) recEvent('page-bg', { pageId: p.id, background: p.background || 'blank' });
  });
}

/* V3.801 — at most one `scroll` event per REC_SCROLL_MS; the latest
   position wins. The trailing timer closes over ITS recorder (V3.735: a
   handler that outlives teardown must never read the global). */
function recScroll(y, x) {
  const rec = REC;
  if (!rec) return;
  rec.scrollY = y; if (typeof x === 'number') rec.scrollX = x;
  if (rec.scrollTimer) return;
  const fire = () => {
    rec.scrollTimer = null;
    if (REC !== rec) return;
    rec.scrollAt = Date.now();
    recEvent('scroll', typeof rec.scrollX === 'number' ? { y: rec.scrollY, x: rec.scrollX } : { y: rec.scrollY });
  };
  const wait = Math.max(0, REC_SCROLL_MS - (Date.now() - (rec.scrollAt || 0)));
  if (!wait) fire(); else rec.scrollTimer = setTimeout(fire, wait);
}

/* Clock skew between the pen device and this recorder: min over final
   flushes of (receipt time − t1). ≈ minimum latency − (pen clock ahead). */
function recSampleSkew(stroke, now) {
  if (!REC || !S || REC.boardId !== S.boardId || !stroke.done || typeof stroke.t1 !== 'number') return;
  if (stroke.erasedAt) return;                 // an erase UPDATE is not a fresh flush
  const d = now - stroke.t1;
  if (Math.abs(d) > 5000) return;              // not a live sample (backfill, reconnect)
  if (REC.skew === null || d < REC.skew) REC.skew = d;
}

/** Stop, flush the last chunk, finalize the doc. Idempotent. */
async function stopRecording(reason) {
  const rec = REC;
  if (!rec) return;
  REC = null;
  clearTimeout(rec.idleTimer); clearInterval(rec.timerTick); clearTimeout(rec.evTimer);
  document.removeEventListener('keydown', recKeys, true);
  document.removeEventListener('visibilitychange', recOnVisibility);
  window.removeEventListener('pagehide', recOnPageHide);
  try { rec.wakeLock?.release?.(); } catch (e) {}
  const stopped = new Promise(res => {
    if (!rec.recorder || rec.recorder.state === 'inactive') return res();
    rec.recorder.onstop = () => res();
    try { rec.recorder.stop(); } catch (e) { res(); }
    setTimeout(res, 4000);
  });
  await stopped;
  /* the final dataavailable fires BEFORE onstop, so its upload is already
     on the chain — wait for the whole chain */
  try { await rec.uploads; } catch (e) {}
  if (!rec.n) console.warn('[whiteboard] recording ended with no audio chunks', rec.recId);
  rec.stream.getTracks().forEach(t => t.stop());
  /* pending events */
  const pending = rec.pending.splice(0);
  const endedAtMs = Date.now();
  try {
    const col = boardsCol(rec.classId, rec.coll || 'whiteboards').doc(rec.boardId).collection('recordings').doc(rec.recId);
    if (pending.length) {
      const batch = db().batch();
      pending.forEach(ev => batch.set(col.collection('events').doc(newId('e')), ev));
      await batch.commit();
    }
    clearTimeout(rec.markT);
    const C = window.RECORDER_CORE, marks = C ? C.closeSection(rec.marks || [], Math.round((endedAtMs - rec.startedAtMs) / 10) / 100) : (rec.marks || []);
    await col.update({ status: 'ready', endedAtMs, durationMs: endedAtMs - rec.startedAtMs,
                       clockSkewMs: rec.skew === null ? 0 : rec.skew, endReason: reason || 'end-live',
                       marks, marksClock: 'wall', paused: false });
  } catch (e) { console.warn('[whiteboard] finalize failed', e); }
  if (S) { renderTopbarRight(); renderProjectorCtl(); }
  /* V3.775 — index.html held back a service-worker reload while we recorded */
  if (window.__swReloadDeferred) toast('A site update was held back during the recording — reload this page when convenient.');
}

/** Admin repair for a recording left in 'recording' (tab closed or
 *  reloaded): mark it ready. V3.775 — the ink outlives the recorder:
 *  strokes and pages on the board carry their own wall-clock times, so the
 *  duration comes from the LAST of audio / events / ink, and the page
 *  events the recorder missed (add-page, flips) are rebuilt from where and
 *  when the ink landed. Audio that was never uploaded stays lost. */
async function finalizeInterrupted(classId, boardId, recId, coll) {
  const fam = coll || 'whiteboards';
  const ref = boardsCol(classId, fam).doc(boardId).collection('recordings').doc(recId);
  const snap = await ref.get();
  if (!snap.exists) return;
  const d = snap.data();
  const start = d.startedAtMs || 0;
  const chunks = d.chunks || [];
  let end = chunks.length ? (chunks[chunks.length - 1].tStart || 0) + REC_CHUNK_MS : 0;
  try {
    const board = boardsCol(classId, fam).doc(boardId);
    const [stSnap, evSnap, bSnap] = await Promise.all([
      board.collection('strokes').orderBy('seq').get(), ref.collection('events').get(), board.get()
    ]);
    const strokes = stSnap.docs.map(s => s.data())
      .filter(s => typeof s.t0 === 'number' && s.t0 >= start && s.t0 - start < 6 * 3600 * 1000)
      .sort((a, b) => a.t0 - b.t0);
    const events = evSnap.docs.map(e => e.data());
    let lastEv = 0;
    events.forEach(e => { if (typeof e.t === 'number' && e.t > lastEv) lastEv = e.t; });
    strokes.forEach(s => { const t1 = (typeof s.t1 === 'number' ? s.t1 : s.t0) - start; if (t1 > end) end = t1; });
    if (lastEv > end) end = lastEv;
    if (end) end += 3000;
    /* pages the recorder never saw: add them just before their first ink */
    const known = new Set((d.pages || []).map(p => p.id));
    events.forEach(e => { if (e.type === 'add-page' && e.pageId) known.add(e.pageId); });
    const firstInk = new Map();
    strokes.forEach(s => { if (s.pageId && !firstInk.has(s.pageId)) firstInk.set(s.pageId, s.t0 - start); });
    const synth = [];
    ((bSnap.exists && bSnap.data().pages) || []).forEach(p => {
      if (known.has(p.id)) return;
      const t = firstInk.has(p.id) ? firstInk.get(p.id) - 2000 : lastEv + 1;
      synth.push({ t: Math.max(lastEv + 1, t), type: 'add-page', pageId: p.id, background: p.background || 'blank',
                   ...(p.kind === 'sim' ? { kind: 'sim', sim: p.sim } : {}), synth: 'ink' });
    });
    /* page flips after the last recorded event: wherever the ink moved */
    let cur = null;
    strokes.forEach(s => {
      const t = s.t0 - start;
      if (t <= lastEv) { cur = s.pageId; return; }
      if (s.pageId && s.pageId !== cur) { cur = s.pageId; synth.push({ t: Math.max(lastEv + 1, t - 1500), type: 'page', pageId: cur, synth: 'ink' }); }
    });
    if (synth.length) {
      const batch = db().batch();
      synth.slice(0, 400).forEach(ev => batch.set(ref.collection('events').doc(newId('e')), ev));
      await batch.commit();
    }
  } catch (e) { console.warn('[whiteboard] timeline rebuild skipped', e); }
  await ref.update({ status: 'ready', endedAtMs: start + end, durationMs: end, endReason: 'interrupted' });
}

/* ─── Exports ───────────────────────────────────────────────── */
window.Whiteboard = {
  renderSectionBody,
  attachLiveBanner,
  detachLiveBanner,
  /* V3.684 — mountable board view, so the module whiteboard panel can
     host the same engine instead of forking it. */
  mountBoardView,
  boardShellHTML,
  ownerBoardId,
  /* V3.731 — shared with whiteboard-replay.js */
  computeIsClassAdmin,
  paintStroke,
  paintBackgroundInto,
  boardsCol,
  toast,
  armTwoTap,
  esc,
  REC_CHUNK_MS,
  isRecording: () => !!REC,
  BOARD_AR,
  BOARD_H
};
window.McgheeLab.renderWhiteboardPage = renderWhiteboardPage;
window.McgheeLab.wireWhiteboardPage   = wireWhiteboardPage;

})();
