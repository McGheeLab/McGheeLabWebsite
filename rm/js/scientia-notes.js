/* ================================================================
   scientia-notes.js — V3.880 — the Scientia notes filed under a research
   card (research.html) or a project (projects.html)
   ================================================================
   The scientiaHub function keeps one index doc per note filed under RM
   work: scientiaNotes/{uid}__{docId} = { ownerUid, ownerName, docId, title,
   type, projectName, themeName, rmIds[], visibility 'lab'|'private',
   modified, components, preview[{label,text}], url }. The note's owner
   chooses who sees it (in the note, "Seen by"). This module lists them:

     SCIENTIA_NOTES.mount(el, { rmId, empty: 'hint' | 'hide' })   a card's list
     SCIENTIA_NOTES.decorate(root)   a Notebooks N chip on every [data-item-id] with notes

   Two queries, both provable by the rule (firestore.rules scientiaNotes):
   the lab-shared notes on this card, and my own. My own open in the Lab
   Notebook; someone else's shared note opens read-only in place (its text
   preview), never a browser popup.
   ================================================================ */
(function () {
  'use strict';

  function db() { return firebridge.db(); }
  function me() { try { var u = firebridge.getUser && firebridge.getUser(); return u ? u.uid : null; } catch (e) { return null; } }
  function esc(s) { return String(s == null ? '' : s).replace(/[&<>"']/g, function (c) { return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]; }); }
  function icon(name) { return (window.ICON && ICON.svg) ? ICON.svg(name) : ''; }
  function day(s) { var d = new Date(String(s || '')); return isNaN(d) ? '' : d.toLocaleDateString(undefined, { month: 'short', day: 'numeric', year: 'numeric' }); }
  var TYPE = { note: 'Note', experiment: 'Experiment', protocol: 'Protocol', analysis: 'Analysis', planning: 'Planning', reflection: 'Reflection', meeting: 'Meeting', seminar: 'Seminar', literature: 'Literature', resource: 'Material' };

  async function list(rmId) {
    if (!rmId) return [];
    var col = db().collection('scientiaNotes'), uid = me(), qs = [col.where('rmIds', 'array-contains', String(rmId)).where('visibility', '==', 'lab').get()];
    if (uid) qs.push(col.where('rmIds', 'array-contains', String(rmId)).where('ownerUid', '==', uid).get());
    var res = await Promise.allSettled(qs), seen = {}, out = [], errs = [];
    res.forEach(function (r) {
      if (r.status !== 'fulfilled') { errs.push(r.reason); return; }
      r.value.docs.forEach(function (d) { if (seen[d.id]) return; seen[d.id] = 1; out.push(Object.assign({ id: d.id }, d.data() || {})); });
    });
    if (errs.length && !out.length) console.warn('[scientia-notes] list', errs[0] && errs[0].message);
    out.sort(function (a, b) { return String(b.modified || '').localeCompare(String(a.modified || '')); });
    return out;
  }

  function rowHtml(n, uid) {
    var mine = n.ownerUid === uid, lab = n.visibility === 'lab';
    return '<li class="sn-row">' +
      '<button type="button" class="sn-open" data-sn="' + esc(n.id) + '" title="' + (mine ? 'Open in the Lab Notebook' : 'Read this note') + '">' +
        '<span class="sn-t">' + esc(n.title || 'Untitled') + '</span>' +
        '<span class="sn-s">' + esc([n.review ? 'Lit review' : (TYPE[n.type] || n.type), mine ? 'you' : n.ownerName, n.themeName, day(n.modified)].filter(Boolean).join(' · ')) + '</span>' +
      '</button>' +
      '<span class="sn-vis' + (lab ? ' sn-lab' : '') + '" title="' + (lab ? 'Every lab member can read it' : 'Only you can see it — change it in the note') + '">' +
        icon(lab ? 'user-group' : 'lock-closed') + (lab ? 'Lab' : 'Only you') + '</span>' +
    '</li>';
  }

  function reader(n) {
    var ov = document.createElement('div');
    ov.className = 'sn-ovl';
    ov.innerHTML = '<div class="sn-card" role="dialog" aria-modal="true" aria-label="' + esc(n.title) + '">' +
      '<div class="sn-card-h"><div><div class="sn-k">' + esc([n.review ? 'Lit review' : (TYPE[n.type] || n.type), n.projectName, n.themeName].filter(Boolean).join(' · ')) + '</div>' +
        '<h3>' + esc(n.title || 'Untitled') + '</h3><div class="sn-s">' + esc((n.ownerName || 'A lab member') + ' · ' + day(n.modified) + ' · read-only') + '</div></div>' +
        '<button type="button" class="sn-x" data-sn-close title="Close" aria-label="Close">' + icon('x-mark') + '</button></div>' +
      '<div class="sn-body">' + ((n.preview || []).length ? n.preview.map(function (b) {
        return '<section>' + (b.label ? '<h4>' + esc(b.label) + '</h4>' : '') + (b.text ? '<p>' + esc(b.text) + '</p>' : '') + '</section>';
      }).join('') : '<p class="sn-empty">No text in this note yet (drawings, images and tables stay in Scientia).</p>') +
      ((n.components || 0) > (n.preview || []).length ? '<p class="sn-empty">The text of each component, as its owner shared it; drawings, images and tables stay in Scientia.</p>' : '') + '</div></div>';
    function close() { ov.remove(); document.removeEventListener('keydown', onKey); }
    function onKey(e) { if (e.key === 'Escape') close(); }
    ov.addEventListener('click', function (e) { if (e.target === ov || e.target.closest('[data-sn-close]')) close(); });
    document.addEventListener('keydown', onKey);
    document.body.appendChild(ov);
    var x = ov.querySelector('[data-sn-close]'); if (x) x.focus();
    return ov;
  }

  async function mount(el, opts) {
    if (!el) return;
    opts = opts || {};
    css();
    el.classList.add('sn-mount');
    el.innerHTML = opts.empty === 'hide' ? '' : '<div class="sn-head"><h2>' + icon('book-open') + ' Notebooks</h2></div><p class="sn-empty">Loading…</p>';
    var rows = [];
    try { rows = await list(opts.rmId); } catch (e) { console.warn('[scientia-notes]', e && e.message); }
    var uid = me();
    if (!rows.length) {
      el.innerHTML = opts.empty === 'hide' ? '' : '<div class="sn-head"><h2>' + icon('book-open') + ' Notebooks</h2></div>' +
        '<p class="sn-empty">Notes filed under this in the Scientia notebook appear here — yours, and the ones their owners share with the lab.</p>';
      return rows;
    }
    el.innerHTML = '<div class="sn-head"><h2>' + icon('book-open') + ' Notebooks</h2><span class="sn-n">' + rows.length + '</span></div>' +
      '<ul class="sn-list">' + rows.map(function (n) { return rowHtml(n, uid); }).join('') + '</ul>';
    el.onclick = function (e) { pick(e, rows); };
    return rows;
  }
  function openNote(n) {
    if (n.ownerUid === me()) location.href = n.url || ('/rm/pages/notebook.html?notebook=scientia&note=' + encodeURIComponent(n.docId));
    else reader(n);
  }
  function pick(e, rows) {
    var b = e.target.closest('[data-sn]'); if (!b) return false;
    e.preventDefault(); e.stopPropagation();
    var n = rows.filter(function (r) { return r.id === b.dataset.sn; })[0]; if (n) openNote(n);
    return true;
  }

  /* Every note I may see, in two queries (the lab's shared ones, my own), kept a minute — for a page of many items. */
  var ALL = { at: 0, p: null };
  function all() {
    if (ALL.p && Date.now() - ALL.at < 60000) return ALL.p;
    ALL.at = Date.now();
    ALL.p = (async function () {
      var col = db().collection('scientiaNotes'), uid = me(), qs = [col.where('visibility', '==', 'lab').get()];
      if (uid) qs.push(col.where('ownerUid', '==', uid).get());
      var res = await Promise.allSettled(qs), seen = {}, out = [];
      res.forEach(function (r) { if (r.status === 'fulfilled') r.value.docs.forEach(function (d) { if (!seen[d.id]) { seen[d.id] = 1; out.push(Object.assign({ id: d.id }, d.data() || {})); } }); });
      out.sort(function (a, b) { return String(b.modified || '').localeCompare(String(a.modified || '')); });
      return out;
    })();
    return ALL.p;
  }
  function listOverlay(title, rows) {
    var ov = document.createElement('div'), uid = me();
    ov.className = 'sn-ovl';
    ov.innerHTML = '<div class="sn-card" role="dialog" aria-modal="true" aria-label="Notebooks"><div class="sn-card-h"><div><div class="sn-k">Notebooks</div><h3>' + esc(title) + '</h3></div>' +
      '<button type="button" class="sn-x" data-sn-close title="Close" aria-label="Close">' + icon('x-mark') + '</button></div>' +
      '<div class="sn-body"><ul class="sn-list">' + rows.map(function (n) { return rowHtml(n, uid); }).join('') + '</ul></div></div>';
    function close() { ov.remove(); document.removeEventListener('keydown', onKey); }
    function onKey(e) { if (e.key === 'Escape') close(); }
    ov.addEventListener('click', function (e) { if (e.target === ov || e.target.closest('[data-sn-close]')) { close(); return; } if (e.target.closest('[data-sn]')) { close(); pick(e, rows); } });
    document.addEventListener('keydown', onKey);
    document.body.appendChild(ov);
    return ov;
  }
  /** A "Notebooks N" chip on every card under root whose [data-item-id] has notes filed under it (projects.html). */
  async function decorate(root, opts) {
    if (!root) return 0;
    opts = opts || {};
    css();
    var rows = [];
    try { rows = await all(); } catch (e) { console.warn('[scientia-notes] decorate', e && e.message); return 0; }
    var by = {}, n = 0;
    rows.forEach(function (x) { (x.rmIds || []).forEach(function (id) { (by[id] = by[id] || []).push(x); }); });
    Array.prototype.forEach.call(root.querySelectorAll('[data-item-id]'), function (box) {
      var ns = by[box.dataset.itemId]; if (!ns || box.querySelector('.sn-chip')) return;
      var meta = box.querySelector(opts.meta || '.pin-box-meta') || box, b = document.createElement('button');
      b.type = 'button'; b.className = 'pin-box-count sn-chip';
      b.title = ns.length + ' Scientia note' + (ns.length === 1 ? '' : 's') + ' filed under this';
      b.innerHTML = icon('book-open') + '<span>' + ns.length + '</span>';
      b.addEventListener('click', function (e) { e.stopPropagation(); var t = box.querySelector('.pin-box-sub'); listOverlay(t ? t.textContent : 'Notebooks', ns); });
      meta.insertBefore(b, meta.querySelector('.pin-expand'));
      n++;
    });
    return n;
  }

  function css() {
    if (document.getElementById('scientia-notes-css')) return;
    var s = document.createElement('style');
    s.id = 'scientia-notes-css';
    s.textContent =
      '.sn-mount{margin:14px 0}.sn-head{display:flex;align-items:center;gap:8px}.sn-head h2{display:flex;align-items:center;gap:6px;font-size:15px;margin:0}' +
      '.sn-head h2 svg{width:16px;height:16px}.sn-n{font-size:12px;color:var(--text-muted,#6b7280)}' +
      '.sn-list{list-style:none;margin:8px 0 0;padding:0;display:flex;flex-direction:column;gap:6px}' +
      '.sn-row{display:flex;align-items:center;gap:8px;border:1px solid var(--border,#e5e7eb);border-radius:8px;padding:6px 8px;background:var(--surface,#fff)}' +
      '.sn-open{flex:1 1 auto;min-width:0;display:flex;flex-direction:column;align-items:flex-start;gap:2px;background:none;border:0;padding:0;text-align:left;cursor:pointer;color:inherit;font:inherit}' +
      '.sn-open:hover .sn-t{text-decoration:underline}.sn-t{font-weight:600;font-size:13.5px;max-width:100%;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}' +
      '.sn-s{font-size:12px;color:var(--text-muted,#6b7280)}.sn-empty{font-size:12.5px;color:var(--text-muted,#6b7280);margin:6px 0}' +
      '.sn-vis{flex:none;display:inline-flex;align-items:center;gap:4px;font-size:11.5px;color:var(--text-muted,#6b7280);white-space:nowrap}.sn-vis svg{width:13px;height:13px}' +
      '.sn-vis.sn-lab{color:var(--accent,#0f766e)}' +
      '.sn-chip{display:inline-flex;align-items:center;gap:3px;border:0;cursor:pointer;background:#ecfdf5;color:#065f46}.sn-chip svg{width:12px;height:12px}' +
      '.sn-ovl{position:fixed;inset:0;z-index:1000;background:rgba(15,23,42,.45);display:flex;align-items:flex-start;justify-content:center;padding:6vh 16px;overflow:auto}' +
      '.sn-card{background:var(--surface,#fff);color:var(--text,#111827);border-radius:12px;max-width:720px;width:100%;box-shadow:0 20px 50px rgba(0,0,0,.25)}' +
      '.sn-card-h{display:flex;gap:12px;align-items:flex-start;justify-content:space-between;padding:16px 18px;border-bottom:1px solid var(--border,#e5e7eb)}' +
      '.sn-card-h h3{margin:2px 0;font-size:18px}.sn-k{font-size:11px;letter-spacing:.08em;text-transform:uppercase;color:var(--text-muted,#6b7280)}' +
      '.sn-x{background:none;border:0;cursor:pointer;padding:4px;color:inherit}.sn-x svg{width:18px;height:18px}' +
      '.sn-body{padding:8px 18px 18px}.sn-body section{margin:12px 0}.sn-body h4{margin:0 0 4px;font-size:13px}.sn-body p{margin:0;white-space:pre-wrap;line-height:1.5;font-size:14px}';
    document.head.appendChild(s);
  }

  window.SCIENTIA_NOTES = { list: list, all: all, mount: mount, decorate: decorate, reader: reader, listOverlay: listOverlay };
})();
