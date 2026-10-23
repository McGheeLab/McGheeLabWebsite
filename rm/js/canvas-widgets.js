/* ================================================================
   canvas-widgets.js — V3.833 — the widget registry and the "+ Insert"
   picker shared by every canvas host (the canvas notebook now; the paper
   figure board in Phase 2 of the Scientia plan).
   ================================================================
   Gabe's Scientia pattern: a widget is one registry entry, and + Insert is
   a searchable, grouped picker over that registry. The whiteboard engine
   owns the card chrome (kind · title · stamp · ▾ · ⋯), placement, snapping,
   Arrange and the export; a host registers kinds here and hands the engine
   `{ render, meta, summary, onMenu, onChange }` built from this registry.

   register({
     kind, label, icon, group, sub,          // what the picker shows (icon: an ICON name, drawn with ICON.render)
     w,                                      // default width (page-width units)
     when(ctx) → bool,                       // optional: hide from the picker
     make(ctx) → { title, data, text, w },   // the new item (or null to cancel)
     insertOnly: true, run(ctx)              // a picker row that is an ACTION, not a card
     render(item, bodyEl, api),              // the body (api: save/saveData/remove/refresh/collapse/canEdit)
     summary(item) → string,                 // the collapsed line + export
     text(item) → string,                    // plain text for mirrors / search / terms
     menu(item, api, ctx) → [{label, sub, danger, run}]  // extra ⋯ actions
   })

   No browser popups: the picker and menus are anchored popovers, and a
   dangerous action in a menu is two-tap.
   ================================================================ */
(function () {
'use strict';

const KINDS = new Map();
let openPop = null;

function esc(s) { return (s ?? '').toString().replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#039;' }[c])); }

function register(def) {
  if (!def || !def.kind) throw new Error('canvas widget needs a kind');
  const full = Object.assign({ group: 'Widgets', icon: '•', w: 0.42, when: null, sub: '' }, def);
  KINDS.set(def.kind, full);
  return full;
}
function get(kind) { return KINDS.get(kind) || null; }
function list(ctx) { return [...KINDS.values()].filter(k => { try { return !k.when || k.when(ctx); } catch (e) { return false; } }); }
function meta(kind) { const k = KINDS.get(kind); return k ? { label: k.label, glyph: k.icon } : null; }   // glyph = the icon NAME (V3.861): ICON.render it, never as text
function summary(item) {
  const k = item && KINDS.get(item.kind);
  try { if (k && k.summary) return String(k.summary(item) || ''); } catch (e) {}
  return String((item && (item.text || item.title)) || '');
}
function text(item) {
  const k = item && KINDS.get(item.kind);
  try { if (k && k.text) return String(k.text(item) || ''); } catch (e) {}
  return summary(item);
}
/* V3.863 — a field that opens with the caret already in it, only where that raises no on-screen keyboard: on a touch
   screen the keyboard comes up when you tap the field, never over the list or the card you are looking at */
function autoFocus(el, opts) {
  if (!el) return false;
  try { if (window.matchMedia && window.matchMedia('(pointer: coarse)').matches) return false; } catch (e) {}
  try { el.focus(); if (opts && opts.select && el.select) el.select(); } catch (e) { return false; }
  return true;
}

/* ─── popovers ────────────────────────────────────────────────────── */
function closeMenus() {
  if (openPop) { try { openPop.remove(); } catch (e) {} openPop = null; }
  document.removeEventListener('pointerdown', onDocDown, true);
  document.removeEventListener('keydown', onDocKey, true);
}
function onDocDown(e) { if (openPop && !openPop.contains(e.target)) closeMenus(); }
function onDocKey(e) { if (e.key === 'Escape') { e.stopPropagation(); closeMenus(); } }
function place(pop, anchor, point) {
  document.body.appendChild(pop);
  const r = anchor && anchor.getBoundingClientRect ? anchor.getBoundingClientRect() : null;
  let x = r ? r.left : (point ? point.x : 20), y = r ? r.bottom + 6 : (point ? point.y : 20);
  const pr = pop.getBoundingClientRect();
  if (x + pr.width > innerWidth - 8) x = Math.max(8, innerWidth - pr.width - 8);
  if (y + pr.height > innerHeight - 8) y = Math.max(8, (r ? r.top : y) - pr.height - 6);
  if (y < 8) y = 8;
  pop.style.left = Math.round(x) + 'px'; pop.style.top = Math.round(y) + 'px';
  openPop = pop;
  setTimeout(() => { document.addEventListener('pointerdown', onDocDown, true); document.addEventListener('keydown', onDocKey, true); }, 0);
}

/** The + Insert picker. onPick(def) is called with the chosen registry row. */
function insertMenu({ anchor, point, ctx, onPick, title }) {
  closeMenus();
  const rows = list(ctx);
  const pop = document.createElement('div');
  pop.className = 'cw-pop cw-insert';
  pop.innerHTML = `<div class="cw-pop-head">${esc(title || 'Insert')}</div>
    <input type="search" class="cw-pop-q" placeholder="Search what to insert…" autocomplete="off">
    <div class="cw-pop-list"></div>`;
  const listEl = pop.querySelector('.cw-pop-list');
  const q = pop.querySelector('.cw-pop-q');
  const draw = () => {
    const terms = q.value.trim().toLowerCase().split(/\s+/).filter(Boolean);
    const show = rows.filter(k => terms.every(t => `${k.label} ${k.sub || ''} ${k.group}`.toLowerCase().includes(t)));
    const groups = [];
    show.forEach(k => { let g = groups.find(x => x.name === k.group); if (!g) { g = { name: k.group, rows: [] }; groups.push(g); } g.rows.push(k); });
    listEl.innerHTML = groups.length ? groups.map(g => `<div class="cw-group">${esc(g.name)}</div>` + g.rows.map(k =>
      `<button type="button" class="cw-row" data-kind="${esc(k.kind)}"><span class="cw-ic">${ICON.render(k.icon)}</span><span class="cw-txt"><b>${esc(k.label)}</b>${k.sub ? `<small>${esc(k.sub)}</small>` : ''}</span></button>`).join('')).join('')
      : '<div class="cw-empty">Nothing matches.</div>';
  };
  draw();
  q.addEventListener('input', draw);
  q.addEventListener('keydown', (e) => { if (e.key === 'Enter') { const first = listEl.querySelector('.cw-row'); if (first) first.click(); } });
  listEl.addEventListener('click', (e) => {
    const b = e.target.closest('.cw-row'); if (!b) return;
    const def = KINDS.get(b.dataset.kind); closeMenus();
    if (def && onPick) onPick(def);
  });
  place(pop, anchor, point);
  setTimeout(() => autoFocus(q), 30);
  return pop;
}

/** A small anchored action menu for a ⋯ button. items: [{ label, sub, danger, run }] */
function actionMenu({ anchor, point, items, title }) {
  closeMenus();
  const pop = document.createElement('div');
  pop.className = 'cw-pop cw-actions';
  pop.innerHTML = (title ? `<div class="cw-pop-head">${esc(title)}</div>` : '') +
    (items || []).filter(Boolean).map((it, i) => `<button type="button" class="cw-row cw-act${it.danger ? ' cw-danger' : ''}" data-i="${i}"><span class="cw-txt"><b>${esc(it.label)}</b>${it.sub ? `<small>${esc(it.sub)}</small>` : ''}</span></button>`).join('');
  pop.addEventListener('click', (e) => {
    const b = e.target.closest('.cw-act'); if (!b) return;
    const it = (items || []).filter(Boolean)[+b.dataset.i]; if (!it) return;
    if (it.danger && b.dataset.armed !== '1') {
      b.dataset.armed = '1'; const t = b.querySelector('b'); if (t) t.textContent = it.confirm || ('Really ' + it.label.toLowerCase() + '?');
      setTimeout(() => { if (b.isConnected && b.dataset.armed === '1') { b.dataset.armed = ''; if (t) t.textContent = it.label; } }, 3000);
      return;
    }
    closeMenus();
    try { it.run(); } catch (err) { console.warn('[canvas-widgets] action failed', err); }
  });
  place(pop, anchor, point);
  return pop;
}

/* ─── V3.837 basic kinds any host can register: a typed note and a checklist ───
   The same bodies the notebook canvas draws (notebook-canvas.js keeps its
   own copy for now); the figure board registers these with the paper's
   uploader. opts: { uploadImage(file) → {download_url, storage_path, hash},
   onAttachment(up), fileInput (an <input type=file>), toast(kind, msg) } */
const ALLOWED_TAGS = new Set(['P', 'BR', 'DIV', 'B', 'STRONG', 'I', 'EM', 'U', 'S', 'SUB', 'SUP', 'UL', 'OL', 'LI', 'H3', 'H4', 'BLOCKQUOTE', 'PRE', 'CODE', 'A', 'IMG', 'TABLE', 'THEAD', 'TBODY', 'TR', 'TH', 'TD', 'FIGURE', 'FIGCAPTION', 'SPAN', 'HR']);
const ALLOWED_ATTRS = { A: ['href', 'target', 'rel'], IMG: ['src', 'alt', 'data-storage-path', 'data-hash'], TD: ['colspan', 'rowspan'], TH: ['colspan', 'rowspan'] };
function isSafeUrl(href) { return /^(https?:\/\/|mailto:|\/)/i.test(String(href || '')); }
function isSafeImg(src) { return /^https:\/\/(firebasestorage\.googleapis\.com|storage\.googleapis\.com)\//i.test(String(src || '')) || /^\/api\//.test(String(src || '')); }
function sanitizeNode(node) {
  Array.from(node.childNodes).forEach(child => {
    if (child.nodeType === 8) { child.remove(); return; }
    if (child.nodeType !== 1) return;
    if (!ALLOWED_TAGS.has(child.tagName)) { while (child.firstChild) node.insertBefore(child.firstChild, child); child.remove(); return; }
    Array.from(child.attributes).forEach(a => { if (!(ALLOWED_ATTRS[child.tagName] || []).includes(a.name)) child.removeAttribute(a.name); });
    if (child.tagName === 'A') { if (!isSafeUrl(child.getAttribute('href'))) child.removeAttribute('href'); child.setAttribute('target', '_blank'); child.setAttribute('rel', 'noopener'); }
    if (child.tagName === 'IMG' && !isSafeImg(child.getAttribute('src'))) { child.remove(); return; }
    sanitizeNode(child);
  });
}
function sanitizeHtml(html) { const w = document.createElement('div'); w.innerHTML = String(html || ''); sanitizeNode(w); return w.innerHTML; }
function plainText(html) { const w = document.createElement('div'); w.innerHTML = String(html || ''); return (w.textContent || '').replace(/\s+/g, ' ').trim(); }

function registerNote(opts) {
  const o = Object.assign({ kind: 'note', label: 'Typed note', icon: 'pencil', group: 'Writing', sub: 'Rich text; paste a photo to add it', w: 0.46 }, opts || {});
  const say = (k, m) => { if (o.toast) o.toast(k, m); };
  let photoTarget = null;
  if (o.fileInput) o.fileInput.addEventListener('change', async (e) => {
    const f = e.target.files && e.target.files[0]; e.target.value = '';
    const t = photoTarget; photoTarget = null;
    if (f && t && t.ed && t.ed.isConnected) await insertPhoto(t.item, t.ed, f, t.api);
  });
  async function insertPhoto(item, ed, file, api) {
    if (!o.uploadImage) { say('error', 'Uploads are not available here.'); return; }
    say('info', 'Uploading photo…');
    try {
      const up = await o.uploadImage(file);
      const img = `<img src="${esc(up.download_url)}" data-storage-path="${esc(up.storage_path || '')}" data-hash="${esc(up.hash || '')}" alt="">`;
      ed.focus();
      if (!document.execCommand('insertHTML', false, img + '<p></p>')) ed.insertAdjacentHTML('beforeend', img);
      if (o.onAttachment) { try { o.onAttachment(up); } catch (e) {} }
      item.data.html = sanitizeHtml(ed.innerHTML); api.saveData(item.data, plainText(item.data.html));
    } catch (e) { say('error', 'Upload failed: ' + (e.message || e)); }
  }
  return register({
    kind: o.kind, label: o.label, icon: o.icon, group: o.group, sub: o.sub, w: o.w, focusAfter: '.nbk-note',
    make: () => ({ title: '', data: { html: '' } }),
    summary: (it) => plainText(it.data?.html).slice(0, 140), text: (it) => plainText(it.data?.html),
    render(item, body, api) {
      const d = item.data || (item.data = {}); const ro = !api.canEdit();
      body.innerHTML = `${ro ? '' : `<div class="nbk-fmtbar">
          <button type="button" class="nbk-fmt" data-cmd="bold" title="Bold"><b>B</b></button>
          <button type="button" class="nbk-fmt" data-cmd="italic" title="Italic"><i>I</i></button>
          <button type="button" class="nbk-fmt" data-cmd="underline" title="Underline"><u>U</u></button>
          <button type="button" class="nbk-fmt" data-cmd="insertUnorderedList" title="Bulleted list">• list</button>
          <button type="button" class="nbk-fmt" data-cmd="insertOrderedList" title="Numbered list">1. list</button>
          <button type="button" class="nbk-fmt" data-block="h3" title="Heading">H</button>
          <button type="button" class="nbk-fmt" data-block="blockquote" title="Quote">❝</button>
          <button type="button" class="nbk-fmt" data-cmd="removeFormat" title="Clear formatting">⌫</button>
          ${o.uploadImage ? '<button type="button" class="nbk-fmt" data-photo="1" title="Insert a photo">' + ICON.svg('camera') + '</button>' : ''}
        </div>`}
        <div class="nbk-note${ro ? ' nbk-note-ro' : ''}" ${ro ? '' : 'contenteditable="true"'} data-placeholder="${esc(o.placeholder || 'Type here…')}">${d.html || ''}</div>`;
      const ed = body.querySelector('.nbk-note');
      if (ro) return;
      let t = null;
      const commit = () => { d.html = sanitizeHtml(ed.innerHTML); api.saveData(d, plainText(d.html)); };
      ed.addEventListener('input', () => { clearTimeout(t); t = setTimeout(commit, 400); });
      ed.addEventListener('blur', () => { clearTimeout(t); commit(); });
      ed.addEventListener('paste', async (e) => {
        const items = e.clipboardData?.items || [];
        for (const x of items) { if (x.kind === 'file' && /^image\//.test(x.type)) { e.preventDefault(); const f = x.getAsFile(); if (f) await insertPhoto(item, ed, f, api); return; } }
        const text = e.clipboardData?.getData('text/plain'); if (text) { e.preventDefault(); document.execCommand('insertText', false, text); }
      });
      ed.addEventListener('drop', (e) => { const f = e.dataTransfer?.files?.[0]; if (f && /^image\//.test(f.type)) { e.preventDefault(); insertPhoto(item, ed, f, api); } });
      const bar = body.querySelector('.nbk-fmtbar');
      bar.addEventListener('mousedown', (e) => e.preventDefault());
      bar.addEventListener('click', (e) => {
        const btn = e.target.closest('button'); if (!btn) return;
        ed.focus();
        if (btn.dataset.cmd) document.execCommand(btn.dataset.cmd, false, null);
        else if (btn.dataset.block) { const cur = document.queryCommandValue('formatBlock'); document.execCommand('formatBlock', false, cur.toLowerCase() === btn.dataset.block ? 'p' : btn.dataset.block); }
        else if (btn.dataset.photo && o.fileInput) { photoTarget = { item, ed, api }; o.fileInput.click(); }
        clearTimeout(t); t = setTimeout(commit, 50);
      });
    }
  });
}
function registerChecklist(opts) {
  const o = Object.assign({ kind: 'checklist', label: 'Checklist', icon: 'check-circle', group: 'Writing', sub: 'Tick boxes', w: 0.36 }, opts || {});
  return register({
    kind: o.kind, label: o.label, icon: o.icon, group: o.group, sub: o.sub, w: o.w,
    make: () => ({ title: '', data: { items: [{ text: '', done: false }] } }),
    summary: (it) => { const a = it.data?.items || []; return `${a.filter(i => i.done).length}/${a.length} done`; },
    text: (it) => (it.data?.items || []).map(i => (i.done ? '[x] ' : '[ ] ') + i.text).join('\n'),
    render(item, body, api) {
      const d = item.data || (item.data = {}); const items = d.items = Array.isArray(d.items) ? d.items : []; const ro = !api.canEdit();
      const row = (x, k) => `<div class="nbk-ck-row${x.done ? ' nbk-done' : ''}" data-k="${k}"><input type="checkbox" ${x.done ? 'checked' : ''} ${ro ? 'disabled' : ''}><input type="text" value="${esc(x.text || '')}" placeholder="To do…" ${ro ? 'readonly' : ''}>${ro ? '' : '<button type="button" class="nbk-x" title="Remove">×</button>'}</div>`;
      body.innerHTML = `<div class="nbk-ck">${items.map(row).join('')}</div>${ro ? '' : '<button type="button" class="btn btn-small" data-ck-add style="margin-top:6px">＋ item</button>'}`;
      if (ro) return;
      const save = () => api.saveData(d, items.map(i => (i.done ? '[x] ' : '[ ] ') + i.text).join('\n'));
      const list = body.querySelector('.nbk-ck'); let t = null;
      list.addEventListener('change', (e) => { const r = e.target.closest('.nbk-ck-row'); if (!r) return; const x = items[+r.dataset.k]; if (!x) return; if (e.target.type === 'checkbox') { x.done = e.target.checked; r.classList.toggle('nbk-done', x.done); } save(); });
      list.addEventListener('input', (e) => { const r = e.target.closest('.nbk-ck-row'); if (!r || e.target.type !== 'text') return; const x = items[+r.dataset.k]; if (x) { x.text = e.target.value; clearTimeout(t); t = setTimeout(save, 400); } });
      list.addEventListener('keydown', (e) => { if (e.key === 'Enter' && e.target.type === 'text') { e.preventDefault(); const r = e.target.closest('.nbk-ck-row'); items.splice(+r.dataset.k + 1, 0, { text: '', done: false }); save(); this.render(item, body, api); body.querySelectorAll('.nbk-ck-row input[type=text]')[+r.dataset.k + 1]?.focus(); } });
      list.addEventListener('click', (e) => { const x = e.target.closest('.nbk-x'); if (!x) return; const r = x.closest('.nbk-ck-row'); items.splice(+r.dataset.k, 1); save(); this.render(item, body, api); });
      body.querySelector('[data-ck-add]').addEventListener('click', () => { items.push({ text: '', done: false }); save(); this.render(item, body, api); const last = body.querySelectorAll('.nbk-ck-row input[type=text]'); last[last.length - 1]?.focus(); });
    }
  });
}

/* ─── V3.841 files on the canvas: an upload helper and the HTML frame ─────
   An .html file (a simulation, an interactive figure) becomes a card whose
   body is a SANDBOXED iframe at the card's width; the height follows a
   stored aspect (↕ handle). Files go to Storage under canvas-files/{uid}/
   (text/html or image, < 25 MB — the rule enforces the same). */
const CANVAS_FILE_MAX = 25 * 1024 * 1024;
function fmtBytes(n) { n = +n || 0; if (n < 1024) return n + ' B'; if (n < 1048576) return (n / 1024).toFixed(0) + ' KB'; return (n / 1048576).toFixed(1) + ' MB'; }
function isHtmlFile(f) { return !!f && (/^text\/html$/i.test(f.type || '') || /\.html?$/i.test(f.name || '')); }
function isImageFile(f) { return !!f && /^image\//i.test(f.type || ''); }
async function uploadCanvasFile(file, uid, opts) {
  if (!file) throw new Error('No file.');
  if (!uid) throw new Error('Sign in first.');
  if (file.size > CANVAS_FILE_MAX) throw new Error('That file is ' + fmtBytes(file.size) + ' — the limit is 25 MB.');
  if (!window.firebase || !firebase.storage) throw new Error('Storage is not available here.');
  const type = (opts && opts.contentType) || (isHtmlFile(file) ? 'text/html' : (file.type || 'application/octet-stream'));
  if (!(type === 'text/html' || /^image\//.test(type))) throw new Error('Only .html files and images can go on the canvas.');
  const id = 'cf' + Date.now().toString(36) + Math.random().toString(36).slice(2, 7);
  const safe = String(file.name || 'file').replace(/[^\w.\-]+/g, '_').slice(0, 80) || 'file';
  const path = `canvas-files/${uid}/${id}/${safe}`;
  const ref = firebase.storage().ref().child(path);
  await ref.put(file, { contentType: type, cacheControl: 'public, max-age=3600' });
  const url = await ref.getDownloadURL();
  return { download_url: url, storage_path: path, name: file.name || safe, size_bytes: file.size, mime: type };
}
function registerHtmlFrame(opts) {
  const o = Object.assign({ kind: 'html', label: 'HTML frame', icon: '⧉', group: 'Media', sub: 'An .html file — a simulation, an interactive figure — running in its own frame; under 25 MB', w: 0.5 }, opts || {});
  const say = (k, m) => { if (o.toast) o.toast(k, m); };
  async function setFile(item, file, api) {
    if (!isHtmlFile(file)) { say('error', 'Choose an .html file.'); return false; }
    if (file.size > CANVAS_FILE_MAX) { say('error', 'That file is ' + fmtBytes(file.size) + ' — the limit is 25 MB.'); return false; }
    if (!o.upload) { say('error', 'Uploads are not available here.'); return false; }
    say('info', 'Uploading ' + (file.name || 'file') + '…');
    try {
      const up = await o.upload(file);
      const d = Object.assign({}, item.data || {}, { url: up.download_url, storagePath: up.storage_path || '', name: up.name || file.name || 'file.html', size: up.size_bytes || file.size || 0, ar: (item.data && +item.data.ar > 0) ? +item.data.ar : 1.6 });
      item.data = d;
      api.saveData(d, 'HTML frame: ' + d.name);
      if (!item.title) api.save({ title: String(d.name).replace(/\.html?$/i, '') });
      api.refresh();
      say('success', 'Frame added — it runs in its own sandbox.');
      return true;
    } catch (e) { say('error', 'Upload failed: ' + (e.message || e)); return false; }
  }
  function pickFile(item, api) {
    const inp = document.createElement('input'); inp.type = 'file'; inp.accept = '.html,.htm,text/html'; inp.style.display = 'none';
    document.body.appendChild(inp);
    inp.addEventListener('change', () => { const f = inp.files && inp.files[0]; inp.remove(); if (f) setFile(item, f, api); });
    inp.click();
  }
  return register({
    kind: o.kind, label: o.label, icon: o.icon, group: o.group, sub: o.sub, w: o.w, accepts: isHtmlFile, setFile,
    make: () => ({ title: '', data: { url: '', storagePath: '', name: '', size: 0, ar: 1.6 } }),
    summary: (it) => it.data && it.data.name ? `${it.data.name} · ${fmtBytes(it.data.size)}` : 'no file yet',
    text: (it) => it.data && it.data.name ? `HTML frame: ${it.data.name}` : '',
    menu: (it, api) => it.data && it.data.url ? [{ label: 'Replace the file…', run: () => pickFile(it, api) }, { label: 'Open in a new tab', run: () => { try { window.open(it.data.url, '_blank', 'noopener'); } catch (e) {} } }] : [{ label: 'Choose a file…', run: () => pickFile(it, api) }],
    /* V3.852 — on a phone the sheet shows the file, not a second running copy of the frame */
    sheet(item, body, api) {
      const d = item.data || {};
      if (!d.url) { this.render(item, body, api); return; }
      body.innerHTML = `<div class="cw-frame-info"><b>${esc(d.name || 'file.html')}</b> · ${fmtBytes(d.size)}<div class="cw-frame-hint">The frame keeps running on the card. Replace the file or open it in a new tab from the actions below.</div></div>`;
    },
    render(item, body, api) {
      const d = item.data || (item.data = {}); const ro = !api.canEdit();
      if (!d.url) {
        if (ro) { body.innerHTML = '<div class="cw-frame-empty">No file.</div>'; return; }
        body.innerHTML = `<div class="cw-frame-drop" data-drop>Drop an .html file here, or <button type="button" class="btn btn-small" data-pick>${ICON.svg('folder')} Choose a file</button><div class="cw-frame-hint">Runs in its own sandboxed frame · under 25 MB</div></div>`;
        const z = body.querySelector('[data-drop]');
        z.querySelector('[data-pick]').addEventListener('click', () => pickFile(item, api));
        z.addEventListener('dragover', (e) => { e.preventDefault(); e.stopPropagation(); z.classList.add('cw-over'); });
        z.addEventListener('dragleave', () => z.classList.remove('cw-over'));
        z.addEventListener('drop', (e) => { e.preventDefault(); e.stopPropagation(); z.classList.remove('cw-over'); const f = e.dataTransfer && e.dataTransfer.files && e.dataTransfer.files[0]; if (f) setFile(item, f, api); });
        return;
      }
      const ar = +d.ar > 0 ? +d.ar : 1.6;
      body.innerHTML = `<div class="cw-frame-wrap" style="aspect-ratio:${ar}"><iframe class="cw-frame" src="${esc(d.url)}" title="${esc(d.name || 'HTML frame')}" sandbox="allow-scripts allow-same-origin allow-forms allow-pointer-lock allow-downloads allow-modals" loading="lazy" allow="fullscreen"></iframe></div>
        <div class="cw-frame-bar"><span class="cw-frame-name" title="${esc(d.name || '')}">${esc(d.name || '')}</span><span class="cw-frame-size">${fmtBytes(d.size)}</span>
          <button type="button" class="cw-frame-btn" data-reload title="Reload the frame">⟳</button><a class="cw-frame-btn" href="${esc(d.url)}" target="_blank" rel="noopener" title="Open in a new tab">⤢</a>${ro ? '' : '<span class="cw-frame-hgrip" data-hgrip title="Drag to change the height">↕</span>'}</div>`;
      body.querySelector('[data-reload]').addEventListener('click', () => { const f = body.querySelector('iframe'); const src = f.getAttribute('src'); f.setAttribute('src', 'about:blank'); setTimeout(() => f.setAttribute('src', src), 30); });
      const hg = body.querySelector('[data-hgrip]');
      if (hg) {
        let st = null;
        hg.addEventListener('pointerdown', (e) => { e.preventDefault(); e.stopPropagation(); const wrap = body.querySelector('.cw-frame-wrap'); const r = wrap.getBoundingClientRect(); st = { y0: e.clientY, h0: r.height, w: r.width, wrap }; try { hg.setPointerCapture(e.pointerId); } catch (err) {} });
        hg.addEventListener('pointermove', (e) => { if (!st) return; e.stopPropagation(); const h = Math.max(60, st.h0 + (e.clientY - st.y0)); st.wrap.style.aspectRatio = String(st.w / h); });
        const end = (e) => { if (!st) return; e.stopPropagation(); const a = parseFloat(st.wrap.style.aspectRatio) || 1.6; st = null; d.ar = Math.round(a * 1000) / 1000; api.saveData(d, 'HTML frame: ' + (d.name || '')); };
        hg.addEventListener('pointerup', end); hg.addEventListener('pointercancel', end);
      }
    }
  });
}

window.CANVAS_WIDGETS = { register, get, list, meta, summary, text, insertMenu, actionMenu, closeMenus, esc, autoFocus, basic: { sanitizeHtml, plainText, registerNote, registerChecklist, registerHtmlFrame, uploadCanvasFile, isHtmlFile, isImageFile, fmtBytes, CANVAS_FILE_MAX } };
})();
