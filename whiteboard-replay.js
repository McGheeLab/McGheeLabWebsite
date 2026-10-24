/* ================================================================
   Whiteboard replay (V3.731) — a recorded lecture, ink in time with voice
   ================================================================
   Mounted by whiteboard.js's wireWhiteboardPage when the route carries
   ?replay={recId}. The engine is mounted in replay mode (no listeners,
   no drawing, no rail) and this module OWNS TIME: it loads the recording
   doc, its events, every stroke of the board (soft-erased ones included)
   and the audio chunks; then on every animation frame while playing it
   computes the board state at the current audio position and pushes it
   through handle.replayApply({ strokes, items, pages, pageId, viewY }).

   Timeline: the recording's clock is wall-clock ms since startedAtMs.
   Strokes carry t0/t1 (pen down/up) and grow linearly between them;
   erases, page snaps, page additions and figure moves are events at t.
   Audio time ↔ wall time differ only by recorded `gap` events (the
   recorder was suspended), which the replay renders as silence.

   Audio: chunks are concatenated into one Blob (fragmented MP4/WebM from
   MediaRecorder.start(timeslice) shares one header). If the browser
   rejects that, the fragments are fed through MediaSource instead.
   ================================================================ */
(function () {
'use strict';

const SPEEDS = [1, 1.5, 2];
let R = null;   // replay state (one per document)

function WB() { return window.Whiteboard; }
function db() { return window.McgheeLab?.db || null; }
function fmt(ms) {
  const s = Math.max(0, Math.floor(ms / 1000));
  const m = Math.floor(s / 60), h = Math.floor(m / 60);
  return h ? `${h}:${String(m % 60).padStart(2, '0')}:${String(s % 60).padStart(2, '0')}` : `${m}:${String(s % 60).padStart(2, '0')}`;
}

/* ─── mount / teardown ─────────────────────────────────────────── */
/* V3.830 — opts beyond the class route: `coll` (board family; a notebook
   board is `notebookBoards` under the owner uid in the classId slot),
   `isAdmin` (the host already knows — no schedule to read), `noHash` (the
   notebook host has no hash route to leave), `onExit` / `onDeleted`
   (where to go when the recording is closed or deleted). */
async function mount({ classId, boardId, recId, handle, coll, isAdmin, noHash, onExit, onDeleted }) {
  teardown();
  const root = handle.getRoot();
  if (!root) return;
  const bar = document.createElement('div');
  bar.className = 'wb-replay-bar';
  bar.innerHTML = '<span class="wb-rp-msg">Loading recording…</span>';
  const stage = root.querySelector('.wb-stage');
  (stage?.nextSibling ? root.insertBefore(bar, stage.nextSibling) : root.appendChild(bar));

  R = { classId, boardId, recId, handle, root, bar, audio: null, audioOk: false, rec: null, events: [], strokes: [],
        playing: false, raf: null, speed: 1, lastSig: '', trimStart: 0, trimEnd: 0, durationMs: 0,
        /* V3.733 — position is a first-class value; while playing it is
           driven by the audio element when that is playable, else by a
           wall clock (ink-only replay). Play can never be a no-op. */
        pos: 0, wall: null, coll: coll || 'whiteboards', onExit: onExit || null, onDeleted: onDeleted || null,
        isAdmin: false, keyHandler: null, hashHandler: null, objectUrl: null, mse: null,
        blob: null, stt: null, sttErr: null, wordsOpen: true, lineOn: -1 };

  if (!noHash) {
    R.hashHandler = () => {
      const h = window.location.hash || '';
      if (!h.includes(`replay=${recId}`)) teardown();
    };
    window.addEventListener('hashchange', R.hashHandler);
  }

  const recRef = WB().boardsCol(classId, R.coll).doc(boardId).collection('recordings').doc(recId);
  let recSnap;
  try { recSnap = await recRef.get(); } catch (e) { return fail('Could not load this recording.'); }
  if (!R || !recSnap.exists) return fail('This recording no longer exists.');
  R.rec = { id: recId, ...recSnap.data() };
  if (R.rec.status !== 'ready') return fail('This recording is still being made — come back when the lecture ends.');

  /* admin? (rename / delete / trim) */
  if (typeof isAdmin === 'boolean') R.isAdmin = isAdmin;
  else {
    try {
      const sched = await db().collection('schedules').doc(classId).get();
      R.isAdmin = WB().computeIsClassAdmin(sched.exists ? sched.data() : null);
    } catch (e) { R.isAdmin = false; }
  }

  /* events + strokes */
  try {
    const [evSnap, stSnap] = await Promise.all([
      recRef.collection('events').orderBy('t').get(),
      WB().boardsCol(classId, R.coll).doc(boardId).collection('strokes').orderBy('seq').get()
    ]);
    if (!R) return;
    R.events = evSnap.docs.map(d => d.data()).sort((a, b) => (a.t || 0) - (b.t || 0));
    R.strokes = stSnap.docs.map(d => prepStroke(d.id, d.data()));
  } catch (e) { return fail('Could not load the lecture data.'); }

  R.durationMs = deriveDuration();
  applyTrim();

  buildBar();
  R.pos = R.trimStart;
  render(audioToWall(R.trimStart), false);
  if (R.isAdmin) ensureStt().then(() => { if (R) renderWords(); });
  await loadAudio();
  if (R) renderWords();
}

/** The doc's durationMs, or — when it is missing/zero (an interrupted or
 *  mis-finalized recording) — the last thing that happened on the board
 *  plus a couple of seconds, so the replay always has a timeline. */
function deriveDuration() {
  let d = Number(R.rec.durationMs) || 0;
  if (d < 1000) {
    let last = 0;
    R.events.forEach(e => { if (e.t > last) last = e.t; });
    R.strokes.forEach(st => { if (isFinite(st.t1) && st.t1 > last && st.t1 < 6 * 3600 * 1000) last = st.t1; });
    d = Math.max(5000, last + 2000);
  }
  return d;
}
function applyTrim() {
  R.trimStart = Math.max(0, Math.min(R.rec.trimStartMs || 0, R.durationMs - 1000));
  R.trimEnd = R.rec.trimEndMs && R.rec.trimEndMs > R.trimStart + 1000 && R.rec.trimEndMs <= R.durationMs
    ? R.rec.trimEndMs : R.durationMs;
}

function fail(msg) {
  if (!R) return;
  R.bar.innerHTML = `<span class="wb-rp-msg">${WB().esc(msg)}</span>`;
}

function teardown() {
  if (!R) return;
  cancelAnimationFrame(R.raf);
  try { R.audio?.pause(); } catch (e) {}
  if (R.audio) { R.audio.src = ''; }
  if (R.objectUrl) { try { URL.revokeObjectURL(R.objectUrl); } catch (e) {} }
  if (R.keyHandler) document.removeEventListener('keydown', R.keyHandler);
  if (R.hashHandler) window.removeEventListener('hashchange', R.hashHandler);
  R.bar?.remove();
  R = null;
}

/* ─── timeline ────────────────────────────────────────────────── */
/* stroke times in recording ms, skew-corrected once */
function prepStroke(id, s) {
  const start = R.rec.startedAtMs || 0, skew = R.rec.clockSkewMs || 0;
  const t0raw = typeof s.t0 === 'number' ? s.t0 : (s.seq || 0);
  const t0 = t0raw - start + skew;
  const t1 = (typeof s.t1 === 'number' ? s.t1 : t0raw) - start + skew;
  const tErase = typeof s.erasedAt === 'number' ? s.erasedAt - start + skew : Infinity;
  /* the engine hides erasedAt strokes; the replay decides visibility itself */
  const clean = { ...s }; delete clean.erasedAt;
  return { id, s: clean, t0, t1: Math.max(t1, t0 + 1), tErase, n: Array.isArray(s.pts) ? s.pts.length / 3 : 0 };
}
function gaps() { return R.events.filter(e => e.type === 'gap' && e.durationMs > 0); }
function audioToWall(a) {
  let w = a;
  for (const g of gaps()) { if (w >= (g.t - g.durationMs)) w += g.durationMs; }
  return w;
}
function wallToAudio(w) {
  let a = w;
  for (const g of gaps()) { if (g.t <= w) a -= g.durationMs; }
  return Math.max(0, a);
}

/* erase events give hard-deleted strokes their erase time too */
function eraseTimeOf(id) {
  let t = Infinity;
  for (const e of R.events) { if (e.type === 'erase' && Array.isArray(e.strokeIds) && e.strokeIds.includes(id)) { t = Math.min(t, e.t); } }
  return t;
}

/** Board state at wall time tw → pushed to the engine. */
function render(tw, animate) {
  if (!R) return;
  const rec = R.rec;
  /* pages */
  const pages = (rec.pages || []).map(p => ({ ...p }));
  let pageId = rec.startPageId || pages[0]?.id;
  /* V3.801 — continuous-mode lectures carry the leader's scroll position:
     on page events (`y`) and as `scroll` events between them. A page
     event without `y` (pages mode) means "centre that page". */
  let viewY = typeof rec.startViewY === 'number' ? rec.startViewY : null;
  let viewX = typeof rec.startViewX === 'number' ? rec.startViewX : null;   /* V3.841 — the plane pans in x too */
  const items = new Map((rec.itemsAtStart || []).map(it => [it.itemId, { ...it, ...(it.kind === 'text' ? { type: 'text' } : {}), ...(it.kind === 'widget' ? { type: 'widget', kind: it.wkind || '', summary: it.summary || '', data: {} } : {}), ...(it.kind === 'region' ? { type: 'region' } : {}), ...(it.kind === 'regionref' ? { type: 'regionref' } : {}) }]));   /* V3.842 — regions + instances */
  for (const e of R.events) {
    if (e.t > tw) break;
    switch (e.type) {
      case 'page': if (e.pageId) pageId = e.pageId; viewY = typeof e.y === 'number' ? e.y : null; break;
      case 'scroll': if (typeof e.y === 'number') viewY = e.y; if (typeof e.x === 'number') viewX = e.x; break;
      case 'add-page': if (e.pageId && !pages.some(p => p.id === e.pageId)) pages.push({ id: e.pageId, background: e.background || 'blank', ...(e.kind === 'sim' ? { kind: 'sim', sim: e.sim } : {}) }); break;
      case 'page-bg': { const p = pages.find(x => x.id === e.pageId); if (p) p.background = e.background || 'blank'; break; }
      case 'remove-page': { const k = pages.findIndex(x => x.id === e.pageId); if (k >= 0) pages.splice(k, 1); break; }
      case 'move-page': {
        if (Array.isArray(e.order)) {
          const rank = new Map(e.order.map((id, k) => [id, k]));
          pages.sort((a, b) => (rank.has(a.id) ? rank.get(a.id) : 1e9) - (rank.has(b.id) ? rank.get(b.id) : 1e9));
        }
        break;
      }
      case 'item-add': case 'item-move': items.set(e.itemId, { pageId: e.pageId, x: e.x, y: e.y, w: e.w, ar: e.ar, url: e.url, fullUrl: e.fullUrl,
        ...(e.kind === 'text' ? { type: 'text', text: e.text || '', cite: e.cite || '' } : {}),
        /* V3.833 — a widget replays as its card (kind, title, summary, folded or not) */
        ...(e.kind === 'widget' ? { type: 'widget', kind: e.wkind || '', title: e.title || '', summary: e.summary || '', collapsed: !!e.collapsed, stampAt: e.stampAt || 0, color: e.color || '', data: {} } : {}),   /* V3.839 — and its colour */
        ...(e.kind === 'region' ? { type: 'region', title: e.title || '', color: e.color || '', h: e.h || 0.3, collapsed: !!e.collapsed } : {}),   /* V3.842 */
        ...(e.kind === 'regionref' ? { type: 'regionref', title: e.title || '', color: e.color || '', src: e.src || null } : {}) }); break;   /* V3.830 — text cards replay too */
      case 'item-remove': items.delete(e.itemId); break;
    }
  }
  if (!pages.some(p => p.id === pageId)) pageId = pages[0]?.id;
  /* strokes */
  const strokes = new Map();
  let sig = pageId + '|' + viewY + '|' + viewX + '|' + items.size + '|';
  for (const st of R.strokes) {
    if (st.t0 > tw) continue;
    const tE = Math.min(st.tErase, st._eraseEvt ?? (st._eraseEvt = eraseTimeOf(st.id)));
    if (tE <= tw) continue;
    if (tw >= st.t1 || st.n <= 1) { strokes.set(st.id, st.s); sig += st.id[st.id.length - 1]; continue; }
    const k = Math.max(1, Math.min(st.n, Math.ceil(st.n * (tw - st.t0) / (st.t1 - st.t0))));
    strokes.set(st.id, { ...st.s, pts: st.s.pts.slice(0, k * 3) });
    sig += st.id + ':' + k + ';';
  }
  if (sig === R.lastSig && !animate) return;
  R.lastSig = sig;
  R.handle.replayApply({ strokes, items, pages, pageId, viewY, viewX, animate });
}

/* ─── audio ───────────────────────────────────────────────────── */
async function loadAudio() {
  if (!R) return;
  const chunks = (R.rec.chunks || []).slice().sort((a, b) => a.n - b.n);
  const audio = new Audio();
  audio.preload = 'auto';
  R.audio = audio;
  if (!chunks.length) { setMsg('No audio was saved with this recording — replaying the ink only.'); return; }
  setMsg('Loading audio…');
  let blobs = [];
  try {
    blobs = await Promise.all(chunks.map(c => fetch(c.url).then(r => { if (!r.ok) throw new Error('HTTP ' + r.status); return r.blob(); })));
  } catch (e) {
    console.warn('[replay] chunk fetch failed', e);
    return setMsg('Could not download the audio — replaying the ink only.');
  }
  if (!R) return;
  const mime = (R.rec.mime || 'audio/mp4').split(';')[0];
  const blob = new Blob(blobs, { type: mime });
  R.blob = blob;   /* V3.887 — what Transcribe sends */
  R.objectUrl = URL.createObjectURL(blob);
  let ok = await probeAudio(audio, R.objectUrl);
  if (!R) return;
  if (!ok) {
    console.warn('[replay] concatenated blob not playable; trying MediaSource', mime, blobs.length);
    ok = await loadViaMSE(audio, blobs, R.rec.mime || 'audio/mp4');
  }
  if (!R) return;
  if (!ok) return setMsg('This browser cannot play this recording’s audio — replaying the ink only.');
  R.audioOk = true;
  /* The timeline is the LONGER of the doc's duration and the audio's: a
     lecture whose audio tail was lost still replays its ink to the end
     (the wall clock takes over where the audio stops — see tick). */
  if (isFinite(audio.duration) && audio.duration > 1) {
    R.audioMs = Math.round(audio.duration * 1000);
    if (R.audioMs > R.durationMs) {
      R.durationMs = R.audioMs;
      applyTrim();
      const range = R.bar.querySelector('[data-rp-range]');
      if (range) range.max = String(Math.max(1, R.trimEnd - R.trimStart));
      renderMarkers();
      updateBar(R.pos);
    }
  }
  wireAudio();
  setMsg(R.audioMs && R.audioMs < R.durationMs - 3000
    ? `Audio ends at ${fmt(R.audioMs)}; the ink continues to ${fmt(R.durationMs)}.` : '');
}

/** Resolve true when the element can play `src` (metadata loaded). */
function probeAudio(audio, src) {
  return new Promise((res) => {
    let settled = false;
    const done = (v) => { if (settled) return; settled = true; audio.onloadedmetadata = null; audio.onerror = null; audio.oncanplay = null; res(v); };
    audio.onloadedmetadata = () => done(true);
    audio.oncanplay = () => done(true);
    audio.onerror = () => done(false);
    audio.src = src;
    try { audio.load(); } catch (e) {}
    setTimeout(() => done(audio.readyState >= 1), 10000);
  });
}

async function loadViaMSE(audio, blobs, mime) {
  const type = /mp4/.test(mime) ? 'audio/mp4; codecs="mp4a.40.2"' : 'audio/webm; codecs="opus"';
  const MS = window.MediaSource || window.ManagedMediaSource;
  if (!MS || !MS.isTypeSupported?.(type)) return false;
  try {
    const ms = new MS();
    R.mse = ms;
    audio.src = URL.createObjectURL(ms);
    await new Promise(res => ms.addEventListener('sourceopen', res, { once: true }));
    const sb = ms.addSourceBuffer(type);
    for (const b of blobs) {
      const buf = await b.arrayBuffer();
      await new Promise((res, rej) => { sb.addEventListener('updateend', res, { once: true }); sb.addEventListener('error', rej, { once: true }); sb.appendBuffer(buf); });
    }
    try { ms.endOfStream(); } catch (e) {}
    return true;
  } catch (e) { console.warn('[replay] MSE failed', e); return false; }
}

function wireAudio() {
  const a = R.audio;
  a.playbackRate = R.speed;
  a.addEventListener('ended', () => {
    if (!R || !R.playing) return;
    /* audio ran out before the timeline did → keep going on the wall clock */
    const at = R.audioMs || a.currentTime * 1000;
    if (at < R.trimEnd - 20) { R.wall = { base: at, t0: performance.now() }; R.audioTail = true; }
    else { R.pos = at; setPlaying(false); }
  });
  seekTo(R.pos || R.trimStart, false);
}
/** Is the audio element the clock right now? (Not past its own end.) */
function audioDrives() { return usingAudio() && !R.audioTail; }

/* ─── controls ────────────────────────────────────────────────── */
function buildBar() {
  const rec = R.rec;
  const when = rec.startedAtMs ? new Date(rec.startedAtMs).toLocaleDateString(undefined, { month: 'short', day: 'numeric', year: 'numeric' }) : '';
  R.bar.innerHTML = `
    <div class="wb-rp-row">
      <button type="button" class="wb-rp-btn wb-rp-play" data-rp="play" title="Play / pause (space)">${ICON.svg('play')}</button>
      <span class="wb-rp-time" data-rp-time>0:00 / ${fmt(R.trimEnd - R.trimStart)}</span>
      <div class="wb-rp-track">
        <div class="wb-rp-markers" data-rp-markers></div>
        <input type="range" class="wb-rp-range" data-rp-range min="0" max="${Math.max(1, R.trimEnd - R.trimStart)}" step="100" value="0" aria-label="Position" />
      </div>
      <button type="button" class="wb-rp-btn" data-rp="speed" title="Playback speed">1×</button>
    </div>
    <div class="wb-rp-row wb-rp-meta">
      ${R.onExit ? '<button type="button" class="btn btn-small" data-rp="exit" title="Close the replay and go back to the board">← Back to board</button>' : ''}
      <span class="wb-rp-name" data-rp-name>${WB().esc(rec.name || 'Recording')}</span>
      <span class="muted-text">${WB().esc(when)}</span>
      <span class="wb-rp-msg muted-text" data-rp-msg></span>
      ${R.isAdmin ? `
      <span class="wb-rp-admin">
        <button type="button" class="btn btn-small btn-ghost" data-rp="rename" title="Rename">✎</button>
        <button type="button" class="btn btn-small btn-ghost" data-rp="trim-start" title="Start the replay here">⟦ start here</button>
        <button type="button" class="btn btn-small btn-ghost" data-rp="trim-end" title="End the replay here">end here ⟧</button>
        <button type="button" class="btn btn-small btn-ghost" data-rp="trim-reset" title="Remove trim" ${(rec.trimStartMs || rec.trimEndMs) ? '' : 'hidden'}>reset trim</button>
        <button type="button" class="btn btn-small btn-danger" data-rp="delete" title="Delete recording">Delete</button>
      </span>` : ''}
    </div>
    <div class="wb-rp-row wb-rp-words" data-rp-words></div>`;
  renderMarkers();
  renderWords();
  R.bar.addEventListener('click', onBarClick);
  const range = R.bar.querySelector('[data-rp-range]');
  range.addEventListener('input', () => seekTo(R.trimStart + Number(range.value), false));
  R.keyHandler = (e) => {
    if (!R || e.defaultPrevented) return;
    const t = e.target;
    if (t && (t.tagName === 'INPUT' || t.tagName === 'TEXTAREA' || t.isContentEditable)) return;
    if (e.key === ' ') { e.preventDefault(); togglePlay(); }
    else if (e.key === 'ArrowRight') { e.preventDefault(); seekTo(current() + 5000, false); }
    else if (e.key === 'ArrowLeft') { e.preventDefault(); seekTo(current() - 5000, false); }
  };
  document.addEventListener('keydown', R.keyHandler);
}

function renderMarkers() {
  const box = R.bar.querySelector('[data-rp-markers]');
  if (!box) return;
  const span = Math.max(1, R.trimEnd - R.trimStart);
  box.innerHTML = R.events.filter(e => e.type === 'page' || e.type === 'add-page').map(e => {
    const a = wallToAudio(e.t);
    if (a < R.trimStart || a > R.trimEnd) return '';
    return `<span class="wb-rp-marker${e.type === 'add-page' ? ' wb-rp-marker-add' : ''}" style="left:${((a - R.trimStart) / span * 100).toFixed(2)}%" title="${e.type === 'add-page' ? 'New page' : 'Page change'} · ${fmt(a - R.trimStart)}"></span>`;
  }).join('');
}

function setMsg(m) { const n = R?.bar.querySelector('[data-rp-msg]'); if (n) n.textContent = m || ''; }
function usingAudio() { return !!(R && R.audioOk && R.audio); }
/** Current position on the audio timeline (ms). */
function current() {
  if (!R) return 0;
  if (R.playing) {
    if (audioDrives()) return R.audio.currentTime * 1000;
    if (R.wall) return R.wall.base + (performance.now() - R.wall.t0) * R.speed;
  }
  return R.pos;
}

function seekTo(aMs, animate) {
  if (!R) return;
  aMs = Math.max(R.trimStart, Math.min(R.trimEnd, aMs));
  R.pos = aMs;
  /* past the end of the audio → wall-clock territory; before it → audio */
  R.audioTail = !!(usingAudio() && R.audioMs && aMs >= R.audioMs - 50);
  if (R.wall || R.audioTail) { R.wall = { base: aMs, t0: performance.now() }; }
  if (usingAudio()) {
    try { R.audio.currentTime = Math.min(aMs, (R.audioMs || aMs)) / 1000; } catch (e) {}
    if (R.audioTail) { try { R.audio.pause(); } catch (e) {} }
    else if (R.playing && R.audio.paused) { R.audio.play().catch(() => {}); }
  }
  updateBar(aMs);
  render(audioToWall(aMs), animate);
}

function updateBar(aMs) {
  const range = R.bar.querySelector('[data-rp-range]');
  const time = R.bar.querySelector('[data-rp-time]');
  if (range && document.activeElement !== range) range.value = String(Math.round(aMs - R.trimStart));
  if (time) time.textContent = `${fmt(aMs - R.trimStart)} / ${fmt(R.trimEnd - R.trimStart)}`;
  paintLine(aMs);
}

/* ================================================================
   V3.887 — the words. The owner transcribes a recording their own way
   (rm/js/speech-to-text.js, chosen in Settings → Speech to text: free on
   the device, or their own OpenAI / Google key — never the lab's), on a
   button that shows the likely cost first. The lines (audio seconds) are
   kept on the recording doc as `transcript`; a tap on one plays from
   there, and the line being spoken lights up.
   ================================================================ */
let _sttP = null;
function ensureStt() {
  if (window.STT && window.RECORDER_CORE) return Promise.resolve(window.STT);
  const load = (src) => new Promise(res => { const sc = document.createElement('script'); sc.src = src; sc.onload = sc.onerror = () => res(); document.head.appendChild(sc); });
  if (!_sttP) _sttP = (window.RECORDER_CORE ? Promise.resolve() : load('/rm/js/recorder-core.js?v=3887'))
    .then(() => window.STT ? null : load('/rm/js/speech-to-text.js?v=3887')).then(() => window.STT || null);
  return _sttP;
}
function renderWords() {
  const box = R && R.bar.querySelector('[data-rp-words]'); if (!box) return;
  const esc = WB().esc, segs = (R.rec.transcript && R.rec.transcript.segs) || [];
  R.lineOn = -1;
  if (segs.length) {
    box.innerHTML = `<button type="button" class="btn btn-small btn-ghost" data-rp="words-toggle">${R.wordsOpen ? 'Hide' : 'Show'} the transcript (${segs.length} line${segs.length === 1 ? '' : 's'})</button>` +
      (R.wordsOpen ? `<div class="wb-rp-lines" data-rp-lines>${segs.map((g, i) => `<button type="button" class="wb-rp-line" data-rp-line="${i}" title="Play from here"><span class="wb-rp-lt">${fmt(g.s * 1000)}</span>${esc(g.text)}</button>`).join('')}</div>` : '');
    paintLine(current());
    return;
  }
  const S = window.STT;
  if (!R.isAdmin || !S) { box.innerHTML = ''; return; }
  if (R.stt) { box.innerHTML = `<span class="wb-rp-sttmsg">${esc(R.stt.text)}</span><span class="wb-rp-pbar"><i style="width:${Math.max(2, Math.round(100 * (R.stt.frac || 0)))}%"></i></span><button type="button" class="btn btn-small" data-rp="stt-stop">Stop</button>`; return; }
  const st = S.ready(), err = R.sttErr ? `<span class="wb-rp-err">${esc(R.sttErr)}</span>` : '';
  if (!st.ok) { box.innerHTML = err + `<a class="btn btn-small" href="/rm/pages/settings.html?tab=speech" target="_blank" rel="noopener">Set up speech to text ↗</a><span class="muted-text">${st.why === 'key' ? 'Add your ' + esc(S.PROVIDERS[st.provider].name) + ' key there.' : 'Free on your device, or your own OpenAI or Google key.'}</span>`; return; }
  if (!R.blob) { box.innerHTML = err; return; }
  const P = S.PROVIDERS[st.provider], ms = R.audioMs || R.durationMs, cost = S.estimate(ms / 1000, st.provider);
  box.innerHTML = err + `<button type="button" class="btn btn-small btn-primary" data-rp="stt-run">${R.sttErr ? 'Try again' : st.provider === 'device' ? 'Transcribe on this device — free' : 'Transcribe — ' + (/^under/.test(cost.text) ? '' : 'about ') + esc(cost.text)}</button>` +
    `<span class="muted-text">${st.provider === 'device' ? 'Whisper in this browser; it can take a while.' : esc(fmt(ms) + ' with ' + P.name + ', billed to ' + P.who + '.')}</span>`;
}
function paintLine(aMs) {
  const lines = R && R.bar.querySelector('[data-rp-lines]'), segs = R && R.rec.transcript && R.rec.transcript.segs;
  if (!lines || !segs) return;
  const C = window.RECORDER_CORE, t = aMs / 1000;
  let i = C ? C.lineAt(segs, t) : -1;
  if (!C) segs.forEach((g, k) => { if (g.s <= t) i = k; });
  if (i === R.lineOn) return;
  R.lineOn = i;
  lines.querySelectorAll('.wb-rp-line.on').forEach(n => n.classList.remove('on'));
  const n = lines.querySelector(`[data-rp-line="${i}"]`); if (!n) return;
  n.classList.add('on');
  if (n.offsetTop < lines.scrollTop || n.offsetTop + n.offsetHeight > lines.scrollTop + lines.clientHeight) lines.scrollTop = Math.max(0, n.offsetTop - 8);
}
async function transcribeRec() {
  if (!R || R.stt || !R.blob || !window.STT) return;
  const r = R, ctl = new AbortController();
  r.sttErr = null; r.stt = { text: 'Starting…', frac: 0, ctl }; renderWords();
  try {
    const out = await STT.transcribe(r.blob, { ext: /mp4/.test(r.rec.mime || '') ? 'm4a' : 'webm', signal: ctl.signal,
      onProgress: (text, frac) => { if (r.stt) { r.stt.text = text; r.stt.frac = frac; if (R === r) renderWords(); } } });
    r.stt = null;
    if (!out.segs.length) { r.sttErr = 'No speech was found in this recording.'; if (R === r) renderWords(); return; }
    const transcript = { segs: out.segs, provider: out.provider, model: out.model || null, lang: out.lang || null, at: new Date().toISOString() };
    await WB().boardsCol(r.classId, r.coll).doc(r.boardId).collection('recordings').doc(r.recId).update({ transcript });
    r.rec.transcript = transcript;
    if (R === r) renderWords();
  } catch (e) {
    r.stt = null; r.sttErr = ctl.signal.aborted ? 'Stopped. Nothing was kept.' : ((e && e.message) || String(e));
    if (R === r) renderWords();
  }
}

function setPlaying(on) {
  if (!R) return;
  if (!on) { R.pos = current(); R.wall = null; R.audioTail = false; }
  R.playing = on;
  const b = R.bar.querySelector('[data-rp="play"]');
  if (b) ICON.label(b, on ? 'pause' : 'play');
  cancelAnimationFrame(R.raf);
  if (on) R.raf = requestAnimationFrame(tick);
}
function tick() {
  if (!R || !R.playing) return;
  const a = current();
  if (a >= R.trimEnd - 20) { try { R.audio?.pause(); } catch (e) {} R.pos = R.trimEnd; setPlaying(false); seekTo(R.trimEnd, true); return; }
  updateBar(a);
  render(audioToWall(a), true);
  R.raf = requestAnimationFrame(tick);
}
async function togglePlay() {
  if (!R) return;
  if (R.playing) { try { R.audio?.pause(); } catch (e) {} setPlaying(false); return; }
  if (R.pos >= R.trimEnd - 20) seekTo(R.trimStart, false);
  if (usingAudio() && !(R.audioMs && R.pos >= R.audioMs - 50)) {
    try {
      R.audioTail = false;
      R.audio.currentTime = R.pos / 1000;
      await R.audio.play();
      setPlaying(true);
      return;
    } catch (e) {
      console.warn('[replay] audio play failed — ink-only replay', e);
      R.audioOk = false;
      setMsg('Audio could not play here — replaying the ink only.');
    }
  }
  /* wall-clock drive: the ink still replays at the chosen speed (no
     audio, or a position past the end of the audio) */
  R.audioTail = !!(usingAudio());
  R.wall = { base: R.pos, t0: performance.now() };
  setPlaying(true);
}

async function onBarClick(e) {
  const ln = e.target.closest('[data-rp-line]');   /* V3.887 — a transcript line: play from there */
  if (ln && R) { const g = ((R.rec.transcript || {}).segs || [])[+ln.dataset.rpLine]; if (g) { seekTo(Math.max(R.trimStart, g.s * 1000), false); if (!R.playing) togglePlay(); } return; }
  const btn = e.target.closest('[data-rp]');
  if (!btn || !R) return;
  const act = btn.dataset.rp;
  const recRef = WB().boardsCol(R.classId, R.coll).doc(R.boardId).collection('recordings').doc(R.recId);
  switch (act) {
    case 'exit': { const fn = R.onExit; teardown(); if (fn) fn(); break; }   /* V3.830 — notebook host */
    case 'play': togglePlay(); break;
    case 'words-toggle': R.wordsOpen = !R.wordsOpen; renderWords(); break;
    case 'stt-run': transcribeRec(); break;
    case 'stt-stop': if (R.stt) R.stt.ctl.abort(); break;
    case 'speed': {
      const pos = current();
      R.speed = SPEEDS[(SPEEDS.indexOf(R.speed) + 1) % SPEEDS.length];
      if (R.audio) R.audio.playbackRate = R.speed;
      if (R.wall) R.wall = { base: pos, t0: performance.now() };   // rebase the wall clock
      btn.textContent = `${R.speed}×`;
      break;
    }
    case 'rename': {
      const nameEl = R.bar.querySelector('[data-rp-name]');
      if (!nameEl || R.bar.querySelector('.wb-rp-rename')) return;
      const input = document.createElement('input');
      input.type = 'text'; input.maxLength = 80; input.className = 'wb-input wb-rp-rename'; input.value = nameEl.textContent;
      nameEl.replaceWith(input); input.focus(); input.select();
      const commit = async () => {
        const v = input.value.trim();
        const span = document.createElement('span'); span.className = 'wb-rp-name'; span.dataset.rpName = '';
        span.textContent = v || R.rec.name || 'Recording';
        input.replaceWith(span);
        if (v && v !== R.rec.name) {
          try { await recRef.update({ name: v }); R.rec.name = v; }
          catch (err) { WB().toast('Rename failed — are you a class admin?'); }
        }
      };
      input.addEventListener('keydown', ev => { if (ev.key === 'Enter') { ev.preventDefault(); input.blur(); } if (ev.key === 'Escape') { input.value = R.rec.name || ''; input.blur(); } });
      input.addEventListener('blur', commit, { once: true });
      break;
    }
    case 'trim-start': case 'trim-end': case 'trim-reset': {
      const a = current();
      const upd = act === 'trim-reset' ? { trimStartMs: 0, trimEndMs: 0 }
        : act === 'trim-start' ? { trimStartMs: Math.round(a) } : { trimEndMs: Math.round(a) };
      const ns = act === 'trim-reset' ? 0 : (upd.trimStartMs ?? R.trimStart);
      const ne = act === 'trim-reset' ? R.durationMs : (upd.trimEndMs ?? R.trimEnd);
      if (ne - ns < 2000) { WB().toast('Trim would leave less than 2 seconds.'); return; }
      try {
        await recRef.update(upd);
        Object.assign(R.rec, upd);
        R.trimStart = ns; R.trimEnd = ne;
        const range = R.bar.querySelector('[data-rp-range]');
        if (range) range.max = String(Math.max(1, R.trimEnd - R.trimStart));
        const reset = R.bar.querySelector('[data-rp="trim-reset"]');
        if (reset) reset.hidden = !(R.rec.trimStartMs || R.rec.trimEndMs);
        renderMarkers();
        seekTo(Math.max(R.trimStart, Math.min(R.trimEnd, a)), false);
        WB().toast(act === 'trim-reset' ? 'Trim removed.' : 'Trim saved — the audio is untouched.');
      } catch (err) { WB().toast('Could not save trim — are you a class admin?'); }
      break;
    }
    case 'delete': {
      if (!WB().armTwoTap(btn, 'Really delete?')) return;
      btn.disabled = true;
      try {
        R.audio?.pause(); setPlaying(false);
        for (;;) {
          const evs = await recRef.collection('events').limit(400).get();
          if (evs.empty) break;
          const batch = db().batch(); evs.docs.forEach(d => batch.delete(d.ref)); await batch.commit();
          if (evs.size < 400) break;
        }
        for (const c of (R.rec.chunks || [])) {
          try { await firebase.storage().ref().child(c.path).delete(); } catch (e) { /* bytes may already be gone */ }
        }
        await recRef.delete();
        WB().toast('Recording deleted.');
        const classId = R.classId, onDeleted = R.onDeleted;
        teardown();
        if (onDeleted) onDeleted(); else window.location.hash = `#/classes/${classId}`;
      } catch (err) { console.warn('[replay] delete failed', err); WB().toast('Delete failed — are you a class admin?'); btn.disabled = false; }
      break;
    }
  }
}

window.WhiteboardReplay = { mount, teardown, _debug: () => R && { strokes: R.strokes.length, events: R.events.length, lastSig: R.lastSig, trim: [R.trimStart, R.trimEnd], first: R.strokes[0] && { t0: R.strokes[0].t0, t1: R.strokes[0].t1, tE: R.strokes[0].tErase, n: R.strokes[0].n } } };
})();
