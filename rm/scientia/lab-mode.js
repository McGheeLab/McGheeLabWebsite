/* ================================================================
   lab-mode.js — V3.869 — the web Scientia is RM-native (Phase 1 of V3.866)
   ================================================================
   Loaded by the WEB build only (scripts/scientia_build.py appends it after
   Gabe's app and sets window.SIS_TARGET = 'web'). Nothing in scientia/src
   changes: this file reshapes the running app from outside —

     Library    the lab's library, mirrored from RM by the hub (`library` rows
                with rm:true, id = the RM item id, so cites and M.lib() keep
                working). Read / open → RM's reader. Adding = RM's import.
     Activity   gone — a pointer to RM's activity tracker (desktop keeps its own).
     Data       gone — desktop only (folder handles need the computer).
     Tasks page RM's Tasks + this notebook's task components and their RM state.
     Materials  from RM's inventory (V3.871, section 5); a task component is an RM task (V3.872, section 6).
     Reminders + chores  dated items in My Week, ticks both ways; the timer and edits go to RM activity (V3.874, section 7 + the hub).

   The app's globals (TABS, VIEWS, App, DB, M, LIB, h, …) are top-level consts
   of the classic script that precedes this one: same realm, same lexical
   scope. Everything is wrapped so a changed build degrades to Gabe's app.
   ================================================================ */
(function () {
  'use strict';
  if (window.SIS_TARGET !== 'web') return;
  var RM = {
    library: '/rm/pages/library.html',
    paper: function (id) { return '/rm/pages/library-paper.html?id=' + encodeURIComponent(id); },
    tasks: '/rm/pages/tasks.html',
    activity: '/rm/pages/activity-overview.html?tab=tracker',
    inventory: '/rm/pages/inventory.html'
  };
  var LAB = { version: 'V3.878', RM: RM, opened: [], openRM: openRM, refresh: refreshLibrary };
  window.SIS_LAB = LAB;

  function openRM(href) {
    LAB.opened.push(href);
    try { if (window.parent && window.parent !== window) window.parent.postMessage({ sis: true, type: 'rm-open', href: href }, location.origin); } catch (e) {}
    try { window.open(href, '_blank', 'noopener'); } catch (e) {}
  }
  function warn() { try { console.warn.apply(console, ['[lab-mode]'].concat([].slice.call(arguments))); } catch (e) {} }
  function btn(cls, label, run, title) { return h('button.btn' + (cls ? '.' + cls.split(' ').join('.') : ''), { title: title || '', on: { click: function (e) { e.preventDefault(); run(); } } }, label); }

  /* ---- 1. the tab row: Activity and Data leave the web app ---- */
  try {
    var drop = { activity: 1, data: 1 };
    for (var i = TABS.length - 1; i >= 0; i--) if (drop[TABS[i][0]]) TABS.splice(i, 1);
  } catch (e) { warn('tabs', e); }

  /* ---- 2. pointer pages: what lives in RM now ---- */
  function pointer(title, eyebrow, text, href, label) {
    return {
      render: function () {
        App.setTitle(title, [h('span', href ? 'on the lab site' : 'desktop only')]);
        return h('div.page', h('div.eyebrow', eyebrow), h('h1.title', title), h('p.stand', text),
          h('div.card.flat', h('div.row', href ? btn('pri', label, function () { openRM(href); }) : h('span.muted', 'Open the desktop app for this.'))));
      }
    };
  }
  try {
    VIEWS.activity = pointer('Activity', 'The lab site', 'Your activity is RM’s: the daily tracker, the year view and the lab’s stats live on the lab site, where your mentor sees them too. Every note you work on here — edits and timer sessions, from this browser or your computer — is recorded there as one entry per note per day. The desktop app keeps its own Activity page.', RM.activity, 'Open Activity in RM');
    VIEWS.tasks = pointer('Tasks', 'The lab site', 'Tasks are RM’s: assigned, due, in My Week and on your phone. The task component in a note stays; the Tasks page is RM’s Tasks.', RM.tasks, 'Open Tasks in RM');
    VIEWS.data = pointer('Data', 'Desktop only', 'Data by reference needs the folder on your computer (the microscope’s export, your disk). Bind, rescan and preview datasets in the desktop app; their records sync here.', null, '');
  } catch (e) { warn('pointers', e); }

  /* ---- 3. the Library: the lab's papers, from RM ---- */
  var Orig = null, OrigRead = null;
  try { Orig = VIEWS.library; OrigRead = VIEWS.read; } catch (e) { warn('views', e); }

  function isRm(r) { return !!(r && r.rm && r.rmId); }
  function hay(r) { return [r.title, r.container, r.year, (r.authors || []).map(function (a) { return a.family + ' ' + a.given; }).join(' '), r.doi].join(' ').toLowerCase(); }
  function matches(q, r) { if (!q) return true; var H = hay(r); return q.toLowerCase().split(/\s+/).filter(Boolean).every(function (w) { return H.indexOf(w) >= 0; }); }

  function card(r) {
    var pdf = !!r.rmPdf;
    return h('div.card.flat.lab-paper', { 'data-rm': r.rmId, style: { display: 'flex', gap: '10px', alignItems: 'flex-start' } },
      LIB.sigil ? LIB.sigil(r, 36) : null,
      h('div', { style: { flex: '1 1 auto', minWidth: 0 } }, h('div', h('b', r.title || r.url || 'Untitled')), h('div.tiny.muted', LIB.apa(r))),
      h('div', { style: { display: 'flex', flexDirection: 'column', gap: '4px', alignItems: 'flex-end' } },
        h('span.pill', pdf ? 'pdf in RM' : 'no pdf'),
        pdf ? btn('xs pri', 'Read in RM', function () { readPaper(r); }, 'Read and highlight in RM’s reader') : null,
        btn('xs', 'Open in RM', function () { openRM(RM.paper(r.rmId)); }, 'The paper’s page on the lab site')));
  }

  var status = null;
  async function refreshLibrary() {
    if (status) status.textContent = 'Asking RM…';
    try {
      var r = await fetch('api/rm/library/refresh', { method: 'POST' });
      var j = r.ok ? await r.json() : null;
      if (status) status.textContent = j && j.ok ? ('RM library mirrored: ' + (j.total || 0) + ' papers, ' + (j.written || 0) + ' changed') : 'Could not reach the hub';
      setTimeout(function () { try { App.refresh(); } catch (e) {} }, 1500);
      return j;
    } catch (e) { if (status) status.textContent = String(e.message || e); return null; }
  }

  var LabLibrary = {
    q: '', title: true,   // title: true — the view sets its own title line; App.refresh() leaves the meta alone
    render: function () {
      var rows = DB.all('library'), rm = rows.filter(isRm), mine = rows.filter(function (r) { return !isRm(r); });
      var q = h('input.inp', { placeholder: 'Filter by author, year, journal, title…', value: LabLibrary.q, style: { width: '100%' },
        on: { input: debounce(function (e) { LabLibrary.q = e.target.value; draw(); }, 120) } });
      var list = h('div.list.lab-papers'), mineList = h('div.list.lab-mine');
      function draw() {
        var rs = rm.filter(function (r) { return matches(LabLibrary.q, r); });
        list.replaceChildren.apply(list, rs.length ? rs.map(card) : [h('div.empty', rm.length ? 'Nothing matches' : 'The lab library has not arrived yet — Refresh from RM')]);
        var ms = mine.filter(function (r) { return matches(LabLibrary.q, r); });
        mineList.replaceChildren.apply(mineList, ms.length ? ms.map(function (r) { return Orig && Orig.card ? Orig.card(r) : card(r); }) : [h('div.empty', 'Nothing matches')]);
      }
      draw();
      App.setTitle('Library', [h('span', plural(rm.length, 'lab paper', 'lab papers') + ' · from RM')]);
      status = h('div.tiny.mono.muted', { style: { minHeight: '18px', marginTop: '6px' } });
      return h('div.page', h('div.eyebrow', 'The lab'), h('h1.title', 'Library'),
        h('p.stand', 'The lab’s library, from RM. Cite any of these papers from any note; read and highlight them in RM’s reader. Papers are added in RM — by DOI, PDF or the capture extension — and arrive here within minutes.'),
        h('div.card.flat', h('h3.lab', { style: { marginTop: 0 } }, 'Add a paper · in RM'),
          h('div.row', btn('pri', 'Open RM’s Library', function () { openRM(RM.library); }), btn('', 'Refresh from RM', refreshLibrary, 'Ask the hub to mirror the lab library now')), status),
        h('div.sec'), h('div.sec-h', h('h2', 'Lab papers'), h('span.k', rm.length)), q, h('div', { style: { height: '10px' } }), list,
        mine.length ? h('div.sec') : null,
        mine.length ? h('div.sec-h', h('h2', 'Only in this notebook'), h('span.k', mine.length), h('span.r.tiny.muted', 'added on the desktop or by DOI here')) : null,
        mine.length ? mineList : null);
    }
  };
  try { VIEWS.library = LabLibrary; } catch (e) { warn('library', e); }

  /* ---- 4. #/read/<rm paper>: RM's reader, not the in-app one ---- */
  try {
    if (OrigRead) {
      VIEWS.read = Object.assign({}, OrigRead, {
        render: function (id) {
          var r = M.lib(id);
          if (isRm(r)) {
            App.setTitle(r.title || 'Paper', [h('span', 'from RM')]);
            return h('div.page.lab-read', h('div.eyebrow', 'The lab'), h('h1.title', r.title || 'Paper'), h('p.stand', LIB.apa(r)),
              h('div.card.flat', h('div.row', r.rmPdf ? btn('pri', 'Read in RM', function () { readPaper(r); }) : h('span.muted', 'No PDF in RM yet — attach one on the paper’s page.'),
                btn('', 'Open in RM', function () { openRM(RM.paper(r.rmId)); }))));
          }
          return OrigRead.render.apply(this, arguments);
        },
        after: function (id) { if (isRm(M.lib(id))) return; return OrigRead.after ? OrigRead.after.apply(this, arguments) : undefined; },
        update: function (id) { if (isRm(M.lib(id))) { App._mounted = false; return App.refresh(); } return OrigRead.update ? OrigRead.update.apply(this, arguments) : undefined; }
      });
    }
  } catch (e) { warn('read', e); }

  /* ---- 5. Materials come from the lab inventory (V3.870) ----
     A resource note stays Gabe's unit (lot, passage, lineage, barriers); picking an item from RM's inventory finds or
     makes the resource note for it (`inventoryId`), on the note's "+ material" picker and on the Materials page.
     Usage is logged in RM (the item's page has the dial and the ledger); the note links there. */
  var INV = { cache: {}, at: {}, ttl: 2 * 60 * 1000 };
  LAB.inventory = inventory; LAB.useInventory = useInventory; LAB.kindFor = kindFor; LAB.resourceFor = resourceFor;
  async function inventory(q) {
    q = String(q || '').trim();
    var now = Date.now();
    if (INV.cache[q] && now - INV.at[q] < INV.ttl) return INV.cache[q];
    try {
      var r = await fetch('api/rm/inventory?q=' + encodeURIComponent(q) + '&limit=40');
      var j = r.ok ? await r.json() : null;
      var out = j && j.ok ? j : { ok: false, items: [], total: 0, error: (j && j.error) || 'could not reach the hub' };
      INV.cache[q] = out; INV.at[q] = now; return out;
    } catch (e) { return { ok: false, items: [], total: 0, error: String(e.message || e) }; }
  }
  function kindFor(item) {
    var s = ((item.category || '') + ' ' + (item.subcategory || '') + ' ' + (item.name || '')).toLowerCase();
    if (item.kind === 'chemical') return 'chemical';
    if (/antibod/.test(s)) return 'antibody';
    if (/cell line|cells\b|cell-line/.test(s)) return 'cell line';
    if (/plasmid|vector/.test(s)) return 'plasmid';
    if (/medium|media\b|dmem|serum|fbs/.test(s)) return 'medium';
    if (/instrument|equipment|microscope|pump|incubator/.test(s)) return 'instrument';
    if (/gel|hydrogel|matrigel|collagen|alginate/.test(s)) return 'gel batch';
    if (/reagent|enzyme|buffer|kit|dye|stain/.test(s)) return 'reagent';
    return 'other';
  }
  function resourceFor(item) {
    return DB.where('documents', function (x) { return x.type === 'resource' && x.inventoryId === item.id && !x.archived; })[0] || null;
  }
  function invLine(item) {
    var bits = [];
    if (item.vendor) bits.push(item.vendor);
    if (item.catalogue_number) bits.push('cat. ' + item.catalogue_number);
    if (item.quantity || item.quantity === 0) bits.push(item.quantity + (item.stock_status ? ' · ' + item.stock_status : ''));
    if (item.locations && item.locations.length) bits.push(item.locations.join(', '));
    return bits.join(' · ');
  }
  /** Find or make the resource note for an inventory item; link it on the note when one is given. */
  function useInventory(item, d) {
    var r = resourceFor(item);
    if (!r) {
      r = M.createDoc({ type: 'resource', projectId: d ? d.projectId : undefined, title: item.name,
        templateId: (M.enabledTemplates && (M.enabledTemplates('resource')[0] || {}).id) || undefined,
        header: { kind: kindFor(item), supplier: item.vendor || '', catalog: item.catalogue_number || '', location: (item.locations || [])[0] || '' } });
      r.inventoryId = item.id; r.rm = true; r.inventoryKind = item.kind; DB.put('documents', r);
    }
    if (d) { d.materials = Array.from(new Set((d.materials || []).concat([r.id]))); M.touchDoc(d); }
    changed();
    return r;
  }
  function invRow(item, onUse, useLabel) {
    var r = resourceFor(item);
    return h('div.opt.lab-inv', { 'data-inv': item.id },
      h('div', h('b', item.name), r ? h('span.pill', 'in your materials') : null, h('div.tiny.muted', invLine(item))),
      h('div.row', { style: { marginTop: '4px', gap: '6px' } },
        btn('xs pri', useLabel || 'Use in this note', function () { onUse(item); }),
        btn('xs', 'Open in RM', function () { openRM(RM.inventory + '?item=' + encodeURIComponent(item.id)); }, 'The item’s page on the lab site: stock, locations, log a use')));
  }
  /** The inventory search block: a search box and the rows it finds (used by the picker and the Materials page). */
  function invSearch(onUse, useLabel, opts) {
    opts = opts || {};
    var q = h('input.inp', { type: 'search', placeholder: 'Search the lab inventory — name, vendor, catalogue number…', style: { width: '100%' } });
    var list = h('div.opts.lab-inv-list'), note = h('div.tiny.muted.lab-inv-note', { style: { margin: '4px 0' } }, opts.hint || '');
    var run = debounce(async function () {
      var text = q.value.trim();
      if (!text && !opts.showEmpty) { list.replaceChildren(); note.textContent = opts.hint || ''; return; }
      note.textContent = 'Searching the lab inventory…';
      var res = await inventory(text);
      if (q.value.trim() !== text) return;
      note.textContent = res.ok ? (res.total ? plural(res.total, 'item') + (res.total > res.items.length ? ', first ' + res.items.length : '') : 'Nothing in the inventory matches') : res.error;
      list.replaceChildren.apply(list, res.items.map(function (it) { return invRow(it, onUse, useLabel); }));
    }, 160);
    q.addEventListener('input', run);
    var el = h('div.lab-inv-search', q, note, list);
    el._run = run; el._q = q;
    return el;
  }
  try {
    var origPick = MATS.pick;
    MATS.pick = function (d, cb) {
      var m = modal({ title: 'Materials used in this note', wide: true, actions: [
        { label: 'Done' },
        { label: '+ New material (note)', run: function () { App.newDoc({ type: 'resource', projectId: d.projectId }); } },
        { label: '+ Add to the lab inventory', run: function () { openRM(RM.inventory); return false; } }],
        body: h('div',
          h('h3.lab', { style: { marginTop: 0 } }, 'From the lab inventory'),
          invSearch(function (item) { useInventory(item, d); m.close(); toast('Linked · ' + item.name); cb && cb(); }, 'Use in this note', { hint: 'Type to search RM’s inventory — picking an item makes (or reuses) its material note here.' }),
          h('h3.lab', 'Your materials'),
          (function () {
            var mine = MATS.all().filter(function (r) { return !(d.materials || []).includes(r.id); });
            return mine.length ? h('div.opts', mine.map(function (r) { return h('div.opt', { on: { mousedown: function (e) { e.preventDefault(); d.materials = Array.from(new Set((d.materials || []).concat([r.id]))); M.touchDoc(d); changed(); m.close(); cb && cb(); } } },
              h('div', h('b', MATS.label(r)), h('div.tiny.muted', MATS.sub(r)))); })) : h('div.empty', 'No material notes yet — pick one from the inventory above.');
          })()) });
      return m;
    };
    MATS.pick._orig = origPick;
  } catch (e) { warn('materials picker', e); }
  try {
    var OrigMat = VIEWS.materials;
    VIEWS.materials = Object.assign({}, OrigMat, {
      render: function () {
        var page = OrigMat.render.apply(this, arguments);
        var card = h('div.card.flat.lab-inv-card', { style: { marginBottom: '12px' } },
          h('div.row', h('h3.lab', { style: { margin: 0 } }, 'The lab inventory'), h('span.tiny.muted', 'RM’s inventory: stock, locations, lots. A material note here is the lab-notebook side of an item there.')),
          invSearch(function (item) { var had = resourceFor(item), r = useInventory(item, null); toast((had ? 'Opened' : 'Made') + ' · ' + r.title); App.go('#/mat/' + r.id); }, 'Make a material note', { hint: 'Search, then make (or open) the material note for an item.' }),
          h('div.row', { style: { marginTop: '8px' } }, btn('', 'Open RM’s inventory', function () { openRM(RM.inventory); })));
        var stand = page.querySelector && page.querySelector('p.stand');
        if (stand && stand.parentNode === page) page.insertBefore(card, stand.nextSibling); else page.appendChild(card);
        return page;
      }
    });
  } catch (e) { warn('materials page', e); }
  try {
    var OrigMatSheet = VIEWS.mat;
    if (OrigMatSheet) VIEWS.mat = Object.assign({}, OrigMatSheet, {
      render: function (id) {
        var out = OrigMatSheet.render.apply(this, arguments), d = M.doc(id);
        if (out && d && d.inventoryId && out.appendChild) {
          var line = h('div.card.flat.lab-inv-link', h('div.row', h('span', h('b', 'In the lab inventory'), h('span.tiny.muted', ' · stock, locations and the use log live in RM')),
            btn('xs pri', 'Open in RM', function () { openRM(RM.inventory + '?item=' + encodeURIComponent(d.inventoryId)); }),
            btn('xs', 'Log a use in RM', function () { openRM(RM.inventory + '?item=' + encodeURIComponent(d.inventoryId)); })));
          var pw = out.querySelector && out.querySelector('.pagewrap, .page'); (pw || out).insertBefore(line, (pw || out).firstChild);
        }
        return out;
      }
    });
  } catch (e) { warn('material sheet', e); }
  /* ---- 6. A task component is an RM task (V3.872) ----
     Gabe's task block (kind 'task': body.text, task {due, allDay, prio, repeat, subs, done, log}) stays the unit in
     the note; on the web it is paired with a task in your RM list (userData/{uid}/tasks, bucket 'assigned', so My
     Week offers it). The hub reconciles DONE both ways on every hello (later change wins); text, due and priority go
     to RM from here as they change. */
  var TK = { shadow: {}, pending: {}, sent: [] };
  LAB.tasks = { send: sendTask, update: updateTask, state: TK, isPaired: isPaired };
  function isPaired(b) { return !!(b && b.rmTaskId); }
  function taskFields(b) {
    var t = TASK.t(b), d = M.doc(b.docId), p = d && d.projectId ? M.project(d.projectId) : null;
    return { text: TASK.text(b), due: t.due || null, allDay: !!t.allDay, prio: t.prio || 'normal', docTitle: (d && d.title) || '', projectName: (p && p.name) || '' };
  }
  function sig(f) { return [f.text, f.due || '', f.allDay ? 1 : 0, f.prio].join('|'); }
  async function sendTask(b) {
    b = M.block(b.id || b); if (!b || b.kind !== 'task' || b.status !== 'live') return null;
    if (b.rmTaskId) return b.rmTaskId;
    if (TK.pending[b.id]) return TK.pending[b.id];
    var f = taskFields(b);
    TK.pending[b.id] = (async function () {
      try {
        var r = await fetch('api/rm/tasks', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(Object.assign({ blockId: b.id, docId: b.docId }, f)) });
        var j = r.ok ? await r.json() : null;
        if (!j || !j.ok || !j.id) { warn('send task', j && j.error); return null; }
        var cur = M.block(b.id); if (!cur) return j.id;
        cur.rmTaskId = j.id; cur.modified = isoLocal(new Date()); DB.put('blocks', cur); TK.shadow[cur.id] = sig(f); TK.sent.push(j.id); changed();
        try { TASK.repaint(cur); } catch (e) {}
        return j.id;
      } catch (e) { warn('send task', e); return null; }
      finally { delete TK.pending[b.id]; }
    })();
    return TK.pending[b.id];
  }
  var updateTimers = {};
  function updateTask(b, extra) {
    b = M.block(b.id || b); if (!b || !b.rmTaskId) return;
    var f = taskFields(b), s = sig(f), body = Object.assign({ id: b.rmTaskId }, extra || {});
    if (TK.shadow[b.id] !== s) { Object.assign(body, f); TK.shadow[b.id] = s; }
    if (Object.keys(body).length === 1) return;  // nothing changed
    clearTimeout(updateTimers[b.id]);
    updateTimers[b.id] = setTimeout(async function () {
      try { var r = await fetch('api/rm/tasks/update', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) }); if (!r.ok) warn('update task', r.status); TK.sent.push('update:' + b.rmTaskId); }
      catch (e) { warn('update task', e); }
    }, extra && extra.done !== undefined ? 0 : 800);
  }
  try {
    var oCreate = TASK.create, oSave = TASK.save, oDone = TASK.done, oUndo = TASK.undo, oBody = TASK.body;
    TASK.create = function () { var b = oCreate.apply(TASK, arguments); if (b) sendTask(b); return b; };
    TASK.save = function (b) { var r = oSave.apply(TASK, arguments); try { if (b && b.rmTaskId) updateTask(b); } catch (e) { warn('task save', e); } return r; };
    TASK.done = function (b) { var r = oDone.apply(TASK, arguments); try { var cur = M.block(b.id || b); if (cur && cur.rmTaskId) updateTask(cur, { done: true, doneAt: TASK.t(cur).done || isoLocal(new Date()) }); } catch (e) { warn('task done', e); } return r; };
    TASK.undo = function (b) { var r = oUndo.apply(TASK, arguments); try { var cur = M.block(b.id || b); if (cur && cur.rmTaskId) updateTask(cur, { done: false }); } catch (e) { warn('task undo', e); } return r; };
    TASK.body = function (b, d, pane, ro) {
      var el = oBody.apply(TASK, arguments);
      try {
        var meta = el && el.querySelector ? el.querySelector('.tk-meta') : null;
        if (meta) {
          var cur = M.block(b.id) || b;
          meta.appendChild(cur.rmTaskId
            ? h('button.tk-chip.lab-rm', { title: 'This task is in your RM list (My Week, the phone)', on: { click: function (e) { e.stopPropagation(); openRM(RM.tasks); } } }, '↗ RM')
            : h('button.tk-chip.lab-rm.none', { title: 'Put this task in your RM list', disabled: !!ro, on: { click: function (e) { e.stopPropagation(); sendTask(cur).then(function () { try { TASK.repaint(M.block(cur.id)); } catch (x) {} }); } } }, '+ RM'));
        }
      } catch (e) { warn('task body', e); }
      return el;
    };
    TASK.create._orig = oCreate;
    // the doc view renders task blocks through WIDGETS.task.body, a reference captured at load — point it at the wrapper
    try { if (typeof WIDGETS !== 'undefined' && WIDGETS.task && WIDGETS.task.body === oBody) WIDGETS.task.body = TASK.body; } catch (e) { warn('widgets.task', e); }
  } catch (e) { warn('tasks', e); }
  /* the #/tasks page: RM's Tasks, plus this notebook's task components and their RM state */
  try {
    var oTasksView = VIEWS.tasks;
    VIEWS.tasks = {
      title: true,
      render: function () {
        var list = TASK.all().slice().sort(function (a, b) { return (TASK.isOpen(a) ? 0 : 1) - (TASK.isOpen(b) ? 0 : 1) || (b.modified || '').localeCompare(a.modified || ''); });
        var open = list.filter(TASK.isOpen).length, unpaired = list.filter(function (b) { return !b.rmTaskId && TASK.isOpen(b); });
        App.setTitle('Tasks', [h('span', plural(open, 'open task') + ' in your notes · all in RM')]);
        return h('div.page.lab-tasks', h('div.eyebrow', 'The lab site'), h('h1.title', 'Tasks'),
          h('p.stand', 'Tasks are RM’s: a task component you write in a note goes to your RM list, shows in My Week and on your phone, and comes back done. Open the list in RM to plan, assign and finish.'),
          h('div.card.flat', h('div.row', btn('pri', 'Open Tasks in RM', function () { openRM(RM.tasks); }), btn('', 'Open My Week', function () { openRM('/rm/pages/my-week.html'); }),
            unpaired.length ? btn('', 'Send ' + plural(unpaired.length, 'open task') + ' to RM', function () { unpaired.forEach(function (b) { sendTask(b); }); setTimeout(function () { App._mounted = false; App.refresh(); }, 1500); }) : null)),
          h('div.sec'), h('div.sec-h', h('h2', 'Task components in your notes'), h('span.k', list.length)),
          list.length ? h('div.list', list.map(function (b) {
            var t = TASK.t(b), d = M.doc(b.docId);
            return h('div.card.flat.lab-task', { 'data-block': b.id, 'data-rm': b.rmTaskId || '' },
              h('div.row', h('b', { style: { textDecoration: t.done ? 'line-through' : 'none' } }, TASK.text(b)), h('span.pill', b.rmTaskId ? 'in RM' : 'not in RM'), t.done ? h('span.pill', 'done') : null),
              h('div.tiny.muted', [d ? d.title : '', t.due ? 'due ' + TASK.fmtDue(t) : '', t.prio !== 'normal' ? t.prio : ''].filter(Boolean).join(' · ')),
              h('div.row', { style: { marginTop: '4px', gap: '6px' } }, btn('xs', 'Open the note', function () { App.openBlock(b.id); }),
                b.rmTaskId ? btn('xs', 'Open in RM', function () { openRM(RM.tasks); }) : btn('xs pri', 'Send to RM', function () { sendTask(b).then(function () { App._mounted = false; App.refresh(); }); })));
          })) : h('div.empty', 'No task components yet — add one in a note with + Insert → Task.'));
      }
    };
    VIEWS.tasks._pointer = oTasksView;
  } catch (e) { warn('tasks page', e); }
  /* ---- 7. Reminders, chores and the timer reach RM (V3.874) ----
     The hub turns each chore / reminder occurrence into a dated item in My Week (and brings My Week's ticks back),
     and turns timer sessions and note edits into RM activity events — on every pull, at most every two minutes.
     After a change here, ask for those two at once, as soon as this device's change has reached the hub. */
  var KICK = { t: null, runs: 0, last: null, stores: { chores: 1, reminders: 1 } };
  LAB.kickRm = kickRm; LAB.kick = KICK;
  function kickRm() {
    clearTimeout(KICK.t);
    KICK.t = setTimeout(async function () {
      var t0 = Date.now();
      while (typeof SYNC !== 'undefined' && SYNC.outbox && SYNC.outbox.size && Date.now() - t0 < 15000) await new Promise(function (r) { setTimeout(r, 250); });
      try { var r = await fetch('api/rm/sync?only=when,activity', { method: 'POST' }); KICK.last = r.ok ? await r.json() : { ok: false, status: r.status }; }
      catch (e) { KICK.last = { ok: false, error: String(e.message || e) }; }
      KICK.runs++;
    }, 1200);
  }
  try {
    var oPut = DB.put;
    DB.put = function (store) { var r = oPut.apply(this, arguments); try { if (KICK.stores[store] && !(typeof SYNC !== 'undefined' && (SYNC.applying || SYNC.loading))) kickRm(); } catch (e) {} return r; };
    var oStop = TIMER.stop; TIMER.stop = function () { var r = oStop.apply(TIMER, arguments); kickRm(); return r; };
    var oPause = TIMER.pause; TIMER.pause = function () { var r = oPause.apply(TIMER, arguments); kickRm(); return r; };
  } catch (e) { warn('kick', e); }
  /* ---- 8. RM cards inside notes (V3.876, Phase 2) ----
     Inside the Lab Notebook the app asks its host to run RM's own UI — the paper reader over the notebook, the My
     Week report picker (MYWEEK_REPORT → saveOutcome) — through the same postMessage bridge as V3.864. Each request
     carries a reqId and the host answers rm-ack; no answer within a moment means "not inside the notebook" and the
     app falls back (a new tab for reading; a hint for reporting). The cards' own data lives in Scientia's blocks, so
     it syncs; a block kind the desktop does not know shows there as its text. */
  var ORIGIN = (location.origin && location.origin !== 'null') ? location.origin : (window.origin || location.origin);
  var HOST = { n: 0, waits: {}, onReported: {}, sent: [] };
  LAB.host = HOST; LAB.readPaper = readPaper; LAB.reportBlock = reportBlock;
  function inHost() { try { return !!(window.parent && window.parent !== window); } catch (e) { return false; } }
  function hostRequest(type, payload, ms) {
    var id = 'q' + (++HOST.n) + '-' + Date.now().toString(36);
    var ack = new Promise(function (res) {
      if (!inHost()) return res(null);
      var t = setTimeout(function () { delete HOST.waits[id]; res(null); }, ms || 900);
      HOST.waits[id] = function (a) { clearTimeout(t); res(a); };
      try { window.parent.postMessage(Object.assign({ sis: true, type: type, reqId: id }, payload), ORIGIN); }
      catch (e) { clearTimeout(t); delete HOST.waits[id]; res(null); }
    });
    HOST.sent = HOST.sent.concat([{ id: id, type: type }]).slice(-30);
    return { id: id, ack: ack };
  }
  window.addEventListener('message', function (e) {
    if (e.origin !== ORIGIN || e.source !== window.parent || !e.data || !e.data.sisCmd) return;
    var m = e.data;
    if (m.sisCmd === 'rm-ack' && HOST.waits[m.reqId]) { var w = HOST.waits[m.reqId]; delete HOST.waits[m.reqId]; w(m); }
    else if (m.sisCmd === 'rm-reported' && HOST.onReported[m.reqId]) { var f = HOST.onReported[m.reqId]; delete HOST.onReported[m.reqId]; try { f(m); } catch (x) { warn('reported', x); } }
    else if (m.sisCmd === 'rm-reader-closed') refreshPaperCards(m.paperId);
  });

  /* reading: RM's reader over the notebook, else the paper's page in a new tab */
  async function readPaper(r, focus) {
    if (!r) return;
    var paper = { paperId: String(r.rmId || r.id), title: r.title || '', cite: LIB.shortRef ? LIB.shortRef(r) : '', journal: r.container || '', pdf: !!(r.rmPdf || r.pdf) };
    var q = hostRequest('rm-read', { paper: paper, focus: focus || null }), ack = await q.ack;
    if (!ack || !ack.ok) openRM(RM.paper(paper.paperId));
  }

  /* the paper card: a library paper (the lab's, from RM, or one only in this notebook) with your RM highlights */
  var HL = { yellow: '#facc15', green: '#4ade80', red: '#f87171', blue: '#60a5fa', purple: '#a78bfa', orange: '#fb923c', pink: '#f472b6' };
  var ANN = { cache: {}, at: {}, ttl: 60 * 1000 };
  async function highlights(paperId, force) {
    var now = Date.now();
    if (!force && ANN.cache[paperId] && now - ANN.at[paperId] < ANN.ttl) return ANN.cache[paperId];
    try {
      var r = await fetch('api/rm/annotations?paperId=' + encodeURIComponent(paperId)), j = r.ok ? await r.json() : null;
      var out = j && j.ok ? j : { ok: false, items: [], error: (j && j.error) || 'Could not load the highlights' };
      ANN.cache[paperId] = out; ANN.at[paperId] = now; return out;
    } catch (e) { return { ok: false, items: [], error: String(e.message || e) }; }
  }
  async function fillHl(list, r, force) {
    if (!r.rm) { list.replaceChildren(h('div.tiny.muted', 'Only in this notebook \u2014 highlights live in RM for the lab\u2019s papers.')); return; }
    var res = await highlights(String(r.rmId || r.id), force);
    if (!res.ok) { list.replaceChildren(h('div.tiny.muted', res.error)); return; }
    var items = res.items || [], mine = items.filter(function (x) { return x.mine; }).length, others = items.length - mine;
    var head = h('div.tiny.muted', items.length ? (plural(mine, 'highlight') + ' of yours' + (others ? ' \u00b7 ' + others + ' from the lab' : '')) : 'No highlights yet \u2014 Read it to highlight in RM\u2019s reader.');
    list.replaceChildren.apply(list, [head].concat(items.slice(0, 8).map(function (x) {
      return h('div.rmp-row', { 'data-ann': x.id, title: (x.by ? x.by + ' \u00b7 ' : '') + (x.page != null ? 'p. ' + x.page : '') + ' \u2014 open it in the reader',
        on: { click: function (e) { e.stopPropagation(); readPaper(r, x.id); } } },
        h('i', { style: { background: HL[x.color] || '#d4d4d8' } }), h('span', snippet(x.exact || x.comment || '(a figure or region)', 140)), x.page != null ? h('span.tiny.muted', 'p. ' + x.page) : null);
    }), items.length > 8 ? [h('div.tiny.muted', (items.length - 8) + ' more in the reader')] : []));
  }
  function refreshPaperCards(paperId) {
    delete ANN.cache[paperId];
    Array.prototype.forEach.call(document.querySelectorAll('.rmp[data-paper]'), function (el) {
      var r = M.lib(el.getAttribute('data-paper')); if (!r || String(r.rmId || r.id) !== String(paperId)) return;
      var list = el.querySelector('.rmp-hl'); if (list) fillHl(list, r, true);
    });
  }
  function paperBody(b, d, pane, ro) {
    var r = M.lib(b.paperId);
    if (!r) return h('div.rmp.gone', h('div.tiny.muted', 'This paper is no longer in the library.'));
    var list = h('div.rmp-hl', h('div.tiny.muted', 'Loading the highlights\u2026'));
    var el = h('div.rmp', { 'data-paper': r.id },
      h('div.rmp-h', LIB.sigil ? LIB.sigil(r, 30) : null, h('div.rmp-t', h('b', r.title || r.url || 'Untitled'), h('div.tiny.muted', LIB.apa(r)))),
      h('div.row.rmp-act', h('span.pill', r.rmPdf ? 'pdf in RM' : r.pdf ? 'pdf here' : 'no pdf'),
        r.rm ? btn('xs pri', 'Read', function () { readPaper(r); }, 'Read and highlight it in RM\u2019s reader') : null,
        r.rm ? btn('xs', 'Open in RM', function () { openRM(RM.paper(r.rmId)); }) : null,
        r.rm ? btn('xs', 'Refresh', function () { fillHl(list, r, true); }, 'Fetch the highlights again') : null),
      list);
    fillHl(list, r, false);
    return el;
  }
  function placePaper(d, p, r) {
    var b = M.addBlock(d.id, null, { kind: 'rmpaper', paperId: r.id, label: r.title || 'Paper', x: Math.round(p.x / 14) * 14, y: Math.round(p.y / 14) * 14, w: 420 });
    b.body = { text: 'Paper: ' + (r.title || r.url || 'Untitled') + '\n' + LIB.apa(r), marks: [] }; DB.put('blocks', b); changed();
    return b;
  }
  function pickPaper(d, p, onPick) {
    var rows = DB.all('library').map(function (r) { return { r: r, label: r.title || r.url || 'Untitled', sub: LIB.shortRef ? LIB.shortRef(r) : '', t: r.added || '' }; });
    var m = modal({ title: 'Place a paper in this note', wide: true, actions: [{ label: 'Cancel' }, { label: 'Add a paper in RM', run: function () { openRM(RM.library); return false; } }],
      body: optionPicker({ placeholder: 'Search the library \u2014 author, year, title, journal\u2026', sort: 'rm-paper', items: function (q) {
          q = String(q || '').toLowerCase();
          return rows.filter(function (x) { return !q || (x.label + ' ' + x.sub + ' ' + (x.r.container || '') + ' ' + (x.r.year || '')).toLowerCase().indexOf(q) >= 0; });
        }, section: function (x) { return x.r.rm ? 'The lab\u2019s library' : 'Only in this notebook'; },
        render: function (x) { return h('div', h('b', x.label), h('span.s', ' ' + x.sub + (x.r.container ? ' \u00b7 ' + x.r.container : ''))); },
        emptyText: 'No papers yet \u2014 add them in RM\u2019s Library',
        onPick: function (x) { m.close(); (onPick || function (r) { placePaper(d, p, r); })(x.r); } }) });
    return m;
  }
  LAB.placePaper = placePaper; LAB.pickPaper = pickPaper;
  try {
    WIDGETS.rmpaper = { label: 'paper', w: 420, icon: '\u25a4', body: paperBody, menu: function (b) {
      var r = M.lib(b.paperId);
      return [r && r.rm ? { label: 'Read', sub: 'RM\u2019s reader, with your highlights', run: function () { readPaper(r); } } : null,
        r && r.rm ? { label: 'Open in RM', run: function () { openRM(RM.paper(r.rmId)); } } : null,
        { label: 'Change the paper\u2026', run: function () { var d = M.doc(b.docId); pickPaper(d, { x: b.x || 0, y: b.y || 0 }, function (nr) { var cur = M.block(b.id); cur.paperId = nr.id; cur.label = nr.title || 'Paper'; cur.body = { text: 'Paper: ' + (nr.title || '') + '\n' + LIB.apa(nr), marks: [] }; cur.modified = isoLocal(new Date()); DB.put('blocks', cur); changed(); }); } }].filter(Boolean);
    } };
    INSERTS.push({ id: 'rmpaper', group: 'Reading', icon: '\u25a4', label: 'Paper from the library\u2026', sub: 'A paper with your highlights from RM \u2014 read it in RM\u2019s reader', run: function (d, p) { pickPaper(d, p); } });
  } catch (e) { warn('paper card', e); }

  /* ✓ Report to My Week on every component: RM's picker and writer run in the notebook; the step comes back */
  async function reportBlock(b, e) {
    b = M.block(b.id || b) || b; if (!b) return;
    var title = (M.blockName ? M.blockName(b) : '') || b.label || String((b.body && b.body.text) || '').split('\n')[0] || 'a component';
    var card = { kind: 'scientia_block', itemId: b.id, boardId: '', entryId: b.docId, paperId: b.kind === 'rmpaper' ? String(b.paperId || '') : '', item_kind: 'scientia-' + b.kind,
      title: String(title).slice(0, 140), url: '/rm/pages/notebook.html?notebook=scientia&note=' + encodeURIComponent(b.docId), thumb: '' };
    var q = hostRequest('rm-report', { card: card, point: e ? { x: e.clientX, y: e.clientY } : null });
    HOST.onReported[q.id] = function (msg) {
      var cur = M.block(b.id); if (!cur || !msg.step || !msg.step.id) return;
      var list = (cur.myweek || []).filter(function (x) { return x.stepId !== msg.step.id; });
      list.push({ stepId: msg.step.id, title: msg.step.title || '', date: msg.step.date || '', at: isoLocal(new Date()) });
      cur.myweek = list.slice(-20); cur.modified = isoLocal(new Date()); DB.put('blocks', cur); changed();
    };
    var ack = await q.ack;
    if (!ack || !ack.ok) { delete HOST.onReported[q.id]; toast('Open Scientia inside the Lab Notebook to report to My Week'); }
  }
  try {
    var oBox = DocView.box;
    DocView.box = function (b) {
      var el = oBox.apply(this, arguments);
      try {
        if (!this.travel && b && b.status === 'live' && b.kind !== 'ref') {
          var bh = el.querySelector(':scope > .bh'), more = bh && bh.querySelector(':scope > .bmore'), n = (b.myweek || []).length;
          if (bh) bh.insertBefore(h('button.ib.lab-mw' + (n ? '.on' : ''), { title: n ? 'Reported to My Week: ' + b.myweek.map(function (x) { return x.title; }).join(', ') + ' \u2014 report it again' : 'Report this as the result of a My Week step',
            on: { click: function (ev) { ev.stopPropagation(); reportBlock(b, ev); } } }, '\u2713'), more || null);
        }
      } catch (x) { warn('report button', x); }
      return el;
    };
  } catch (e) { warn('box', e); }

  /* the material card for an inventory item: Insert → Material… searches RM's inventory first */
  function materialFromInventory(d, p, mine) {
    var m = modal({ title: 'Insert a material', wide: true, actions: [{ label: 'Cancel' }, { label: 'Pick one of your materials\u2026', run: function () { setTimeout(mine, 30); } }],
      body: h('div', h('h3.lab', { style: { marginTop: 0 } }, 'From the lab inventory'),
        invSearch(function (item) { var r = useInventory(item, d); m.close(); MATS2.place(d, p, r); toast('Placed \u00b7 ' + item.name); }, 'Place its card here',
          { hint: 'Type to search RM\u2019s inventory \u2014 its material note is made (or reused) and its card placed here.' })) });
    return m;
  }
  LAB.materialFromInventory = materialFromInventory;
  try {
    var oCard = MATS2.cardBody;
    MATS2.cardBody = function (b) {
      var el = oCard.apply(this, arguments);
      try {
        var r = M.doc(b.matId);
        if (r && r.inventoryId && el && el.appendChild) el.appendChild(h('div.row.lab-inv-line', h('span.tiny.muted', 'In the lab inventory'),
          btn('xs', 'Open in RM', function () { openRM(RM.inventory + '?item=' + encodeURIComponent(r.inventoryId)); }),
          btn('xs', 'Log a use in RM', function () { openRM(RM.inventory + '?item=' + encodeURIComponent(r.inventoryId)); })));
      } catch (x) { warn('material card', x); }
      return el;
    };
    if (WIDGETS.matcard && WIDGETS.matcard.body === oCard) WIDGETS.matcard.body = MATS2.cardBody;   // a captured reference (the V3.872 lesson)
    var insMat = INSERTS.filter(function (x) { return x.id === 'material'; })[0];
    if (insMat) { var oMatRun = insMat.run; insMat.run = function (d, p) { materialFromInventory(d, p, function () { oMatRun(d, p); }); }; }
  } catch (e) { warn('material insert', e); }

  /* the few styles the lab cards need (Gabe's tokens where they exist) */
  try {
    var css = '.rmp-h{display:flex;gap:8px;align-items:flex-start}.rmp-t{min-width:0}.rmp-act{gap:6px;margin-top:6px;flex-wrap:wrap}' +
      '.rmp-hl{margin-top:6px;display:flex;flex-direction:column;gap:3px}.rmp-row{display:flex;gap:6px;align-items:baseline;cursor:pointer;font-size:12px;line-height:1.35}' +
      '.rmp-row i{flex:none;width:8px;height:12px;border-radius:2px;display:inline-block;transform:translateY(2px)}.rmp-row:hover>span:first-of-type{text-decoration:underline}' +
      '.ib.lab-mw{font-size:12px;opacity:.5}.ib.lab-mw:hover{opacity:.9}.ib.lab-mw.on{opacity:1;color:var(--ok,#1b7a43);font-weight:700}' +
      '.lab-inv-line{gap:6px;margin-top:6px;flex-wrap:wrap;align-items:center}';
    document.head.appendChild(h('style', { id: 'lab-mode-css' }, css));
  } catch (e) { warn('css', e); }
  /* ---- 9. Protocols, Something I did, collections (V3.878, Phase 2 part 2) ----
     PROTOCOLS: the lab's protocol (RM) becomes Gabe's own protocol — its steps — so a run here is his run (check,
     time, observe). The def carries `rm {protocolId, updated_at, url, skipped}`; the same RM version is imported once
     and run again; a changed one is imported beside the old (past runs keep theirs). Calculators, tables and figures
     stay in RM (the def says so and links there). SOMETHING I DID: your recorded actions, listed and marked noted by
     RM's own code in the notebook (rm-actions / rm-action-noted). COLLECTIONS: a Lab Notebook collection, read-only. */
  var LISTS = { actions: {} };
  window.addEventListener('message', function (e) {
    if (e.origin !== ORIGIN || e.source !== window.parent || !e.data || e.data.sisCmd !== 'rm-actions-list') return;
    var f = LISTS.actions[e.data.reqId]; if (f) { delete LISTS.actions[e.data.reqId]; f(e.data); }
  });
  async function hubJson(path) {
    try { var r = await fetch(path), j = r.ok ? await r.json() : null; return j || { ok: false, error: 'HTTP ' + r.status }; }
    catch (e) { return { ok: false, error: String(e.message || e) }; }
  }
  function pickerModal(title, rows, opts) {
    var m = modal({ title: title, wide: true, actions: [{ label: 'Cancel' }].concat(opts.actions || []),
      body: optionPicker({ placeholder: opts.placeholder, sort: opts.sort, emptyText: opts.empty,
        items: function (q) { q = String(q || '').toLowerCase(); return rows.filter(function (x) { return !q || (x.label + ' ' + x.sub).toLowerCase().indexOf(q) >= 0; }); },
        section: opts.section, render: function (x) { return h('div', h('b', x.label), x.sub ? h('span.s', ' ' + x.sub) : null); },
        onPick: function (x) { m.close(); opts.onPick(x); } }) });
    return m;
  }
  var day16 = function (s) { return String(s || '').slice(0, 16).replace('T', ' '); };

  /* protocols */
  function rmDefFor(pid, updatedAt) {
    return DB.where('blocks', function (b) { return b.kind === 'protocol' && b.status !== 'removed' && b.rm && b.rm.protocolId === pid && (!updatedAt || b.rm.updated_at === updatedAt); })[0] || null;
  }
  async function runRmProtocol(d, p, row) {
    var res = await hubJson('api/rm/protocols?id=' + encodeURIComponent(row.id));
    if (!res.ok || !res.protocol) { toast(res.error || 'Could not read the protocol from RM'); return null; }
    var P = res.protocol, same = rmDefFor(P.id, P.updated_at);
    if (same) { var run = PROTO.newRun(same, d.id, p.x, p.y); toast('A run of “' + same.label + '”'); return run; }
    var older = rmDefFor(P.id, null), now = isoLocal(new Date());
    var b = PROTO.create(d.id, p.x, p.y);
    b.label = P.title + (older ? ' (RM, ' + String(P.updated_at || '').slice(0, 10) + ')' : '');
    b.steps = (P.list.length ? P.list : [{ id: '', text: 'Open this protocol in RM — it has no steps to follow here' }]).map(function (s) {
      return { id: uid('st'), text: s.text, created: now, status: 'live', supersedes: [], supersededBy: [], rmStepId: s.id || '' }; });
    b.rm = { protocolId: P.id, title: P.title, version: P.version, updated_at: P.updated_at, url: P.url, skipped: P.skipped || {} };
    PROTO.syncBody(b); DB.put('blocks', b); changed();
    if (d.projectId) PROTO.register(b, { name: b.label, projectId: d.projectId, themeId: d.themeId || null });
    else { b.localOnly = true; DB.put('blocks', b); changed(); }
    toast((older ? 'RM changed it since the last import — ' : '') + plural(b.steps.length, 'step') + ' from “' + P.title + '”');
    return b;
  }
  async function pickRmProtocol(d, p) {
    var res = await hubJson('api/rm/protocols');
    if (!res.ok) { toast(res.error || 'Could not reach RM’s protocols'); return null; }
    var rows = (res.items || []).map(function (r) { return { r: r, label: r.title, sub: [r.category, r.status, r.updated_at ? 'changed ' + r.updated_at.slice(0, 10) : ''].filter(Boolean).join(' · '), t: r.updated_at }; });
    return pickerModal('Run a lab protocol from RM', rows, { placeholder: 'Search the lab’s protocols…', sort: 'rm-protocol', empty: 'No protocols in RM yet',
      actions: [{ label: 'Open RM’s Protocols', run: function () { openRM('/rm/pages/protocols.html'); return false; } }],
      section: function (x) { return rmDefFor(x.r.id, null) ? 'Imported before' : 'The lab’s protocols'; },
      onPick: function (x) { runRmProtocol(d, p, x.r); } });
  }
  try {
    var oPBody = PROTO.body;
    PROTO.body = function (b) {
      var el = oPBody.apply(this, arguments);
      try {
        var def = PROTO.defOf(b);
        if (def && def.rm && el && el.insertBefore) {
          var sk = def.rm.skipped || {}, only = Object.keys(sk).map(function (k) { return sk[k] + ' ' + k; }).join(', ');
          el.insertBefore(h('div.row.lab-proto-line', h('span.tiny.muted', 'From RM · ' + def.rm.title + (only ? ' · in RM only: ' + only : '')),
            btn('xs', 'Open in RM', function () { openRM(def.rm.url); })), el.firstChild);
        }
      } catch (x) { warn('protocol line', x); }
      return el;
    };
    INSERTS.push({ id: 'rmprotocol', group: 'Protocols', icon: '▶', label: 'Run a lab protocol from RM…', sub: 'The lab’s protocol as steps to check, time and observe here', run: function (d, p) { pickRmProtocol(d, p); } });
  } catch (e) { warn('protocols', e); }

  /* something I did */
  function listActions() {
    return new Promise(function (res) {
      var q = hostRequest('rm-actions', {}), done = false, fin = function (v) { if (!done) { done = true; res(v); } };
      LISTS.actions[q.id] = fin;
      setTimeout(function () { delete LISTS.actions[q.id]; fin({ ok: false, error: 'Your actions did not arrive — try again' }); }, 8000);
      q.ack.then(function (a) { if (!a || !a.ok) { delete LISTS.actions[q.id]; fin(null); } });
    });
  }
  function actionRec(a) { return { id: a.id, kind: a.kind, text: a.text, at: a.at, note: a.note, itemId: a.itemId, equipmentId: a.equipmentId, labelCode: a.labelCode }; }
  function actionText(a) { return 'Did: ' + a.text + (a.at ? ' (' + day16(a.at) + ')' : '') + (a.note ? '\n' + a.note : ''); }
  function placeAction(d, p, a) {
    var b = M.addBlock(d.id, null, { kind: 'rmaction', action: actionRec(a), label: String(a.text || '').slice(0, 80), x: Math.round(p.x / 14) * 14, y: Math.round(p.y / 14) * 14, w: 392 });
    b.body = { text: actionText(a), marks: [] }; DB.put('blocks', b); changed();
    hostRequest('rm-action-noted', { actionId: a.id, entryId: d.id, cardId: b.id });
    return b;
  }
  async function pickAction(d, p, onPick) {
    var got = await listActions();
    if (!got) { toast('Open Scientia inside the Lab Notebook to add what you did'); return null; }
    if (!got.ok) { toast(got.error || 'Could not load your actions'); return null; }
    var rows = (got.rows || []).map(function (a) { return { a: a, label: a.text, sub: [day16(a.at), a.note].filter(Boolean).join(' · '), t: a.at }; });
    return pickerModal('Something I did', rows, { placeholder: 'Search what you did — items used, equipment booked…', sort: 'rm-action',
      empty: 'Nothing recorded yet — scan a label to use an item, or book equipment, and it appears here.',
      actions: [{ label: 'My actions in RM', run: function () { openRM('/rm/pages/actions.html'); return false; } }],
      section: function (x) { return x.a.kind === 'equipment_booking' ? 'Equipment' : 'Items used'; },
      onPick: function (x) { (onPick || function (a) { placeAction(d, p, a); })(x.a); } });
  }
  function actionBody(b) {
    var a = b.action || {};
    return h('div.rma', h('div', h('b', a.text || 'Something I did')),
      h('div.tiny.muted', [a.kind === 'equipment_booking' ? 'Equipment' : 'Item used', day16(a.at), a.note].filter(Boolean).join(' · ')),
      h('div.row.rmp-act', a.itemId ? btn('xs', 'The item in RM', function () { openRM(RM.inventory + '?item=' + encodeURIComponent(a.itemId)); }) : null,
        a.equipmentId ? btn('xs', 'Equipment in RM', function () { openRM('/rm/pages/equipment.html'); }) : null,
        btn('xs', 'My actions in RM', function () { openRM('/rm/pages/actions.html'); })));
  }
  try {
    WIDGETS.rmaction = { label: 'something I did', w: 392, icon: '•', body: actionBody, menu: function (b) {
      return [{ label: 'Pick a different action…', run: function () { pickAction(M.doc(b.docId), { x: b.x || 0, y: b.y || 0 }, function (a) {
        var cur = M.block(b.id); cur.action = actionRec(a); cur.label = String(a.text || '').slice(0, 80); cur.body = { text: actionText(a), marks: [] }; cur.modified = isoLocal(new Date());
        DB.put('blocks', cur); changed(); hostRequest('rm-action-noted', { actionId: a.id, entryId: cur.docId, cardId: cur.id }); }); } }];
    } };
    INSERTS.push({ id: 'rmaction', group: 'Lab', icon: '•', label: 'Something I did…', sub: 'An item you used or equipment you booked, recorded in RM — placed here', run: function (d, p) { pickAction(d, p); } });
  } catch (e) { warn('actions', e); }

  /* collections */
  var COL = { cache: {}, at: {}, ttl: 60 * 1000 };
  async function collectionFull(id, force) {
    var now = Date.now(); if (!force && COL.cache[id] && now - COL.at[id] < COL.ttl) return COL.cache[id];
    var res = await hubJson('api/rm/collections?id=' + encodeURIComponent(id)); COL.cache[id] = res; COL.at[id] = now; return res;
  }
  function placeCollection(d, p, r) {
    var b = M.addBlock(d.id, null, { kind: 'rmcollection', collectionId: r.id, entryId: r.entryId || '', label: r.title || 'Collection', x: Math.round(p.x / 14) * 14, y: Math.round(p.y / 14) * 14, w: 420 });
    b.body = { text: 'Collection: ' + (r.title || 'Collection'), marks: [] }; DB.put('blocks', b); changed();
    return b;
  }
  async function pickCollection(d, p, onPick) {
    var res = await hubJson('api/rm/collections');
    if (!res.ok) { toast(res.error || 'Could not reach RM'); return null; }
    var rows = (res.items || []).map(function (r) { return { r: r, label: r.title, sub: [plural(r.papers, 'paper'), r.entries ? plural(r.entries, 'entry', 'entries') : '', r.claim ? 'a claim' : '', r.updated_at ? 'changed ' + r.updated_at.slice(0, 10) : ''].filter(Boolean).join(' · '), t: r.updated_at }; });
    return pickerModal('Place a collection from the Lab Notebook', rows, { placeholder: 'Search your collections and claims…', sort: 'rm-collection',
      empty: 'No collections yet — make one on a canvas entry of the Lab Notebook.',
      section: function (x) { return x.r.claim ? 'Claims' : 'Collections'; },
      onPick: function (x) { (onPick || function (r) { placeCollection(d, p, r); })(x.r); } });
  }
  async function fillCollection(el, b, force) {
    var res = await collectionFull(b.collectionId, force);
    if (!res.ok || !res.collection) { el.replaceChildren(h('div.tiny.muted', res.error || 'Could not load the collection')); return; }
    var c = res.collection, rowFor = function (pid) { return M.lib(pid); };
    el.replaceChildren(
      h('div', h('b', c.title), c.claim ? h('span.pill', 'claim') : null, h('span.tiny.muted', ' ' + [plural(c.papers, 'paper'), c.entries ? plural(c.entries, 'entry', 'entries') : ''].filter(Boolean).join(' · '))),
      c.claimText ? h('div.rmc-claim', c.claimText) : null,
      c.keyPoints.length ? h('ul.rmc-kp', c.keyPoints.slice(0, 5).map(function (k) { return h('li', k); })) : null,
      h('div.rmp-hl', c.entryList.filter(function (e) { return e.quote; }).slice(0, 6).map(function (e) {
        return h('div.rmp-row', { title: (e.cite || '') + ' — open the paper', on: { click: function (ev) { ev.stopPropagation(); var r = rowFor(e.paperId); if (r) readPaper(r); else if (e.paperId) openRM(RM.paper(e.paperId)); } } },
          h('i', { style: { background: e.hex || '#d4d4d8' } }), h('span', snippet(e.quote, 140)), e.cite ? h('span.tiny.muted', e.cite) : null); }).concat(
        c.paperList.slice(0, 8).map(function (pp) {
          return h('div.rmp-row', { title: (pp.why || pp.cite || '') + ' — open the paper', on: { click: function (ev) { ev.stopPropagation(); var r = rowFor(pp.paperId); if (r) readPaper(r); else openRM(RM.paper(pp.paperId)); } } },
            h('i', { style: { background: 'transparent', border: '1px solid #a1a1aa' } }), h('span', pp.title || pp.cite || pp.paperId), pp.cite ? h('span.tiny.muted', pp.cite) : null); }))),
      h('div.row.rmp-act', c.entryId ? btn('xs', 'Open its entry', function () { openRM('/rm/pages/notebook.html?entry=' + encodeURIComponent(c.entryId)); }) : null,
        btn('xs', 'Refresh', function () { fillCollection(el, b, true); })));
  }
  function collectionBody(b) { var el = h('div.rmc', { 'data-col': b.collectionId }, h('div.tiny.muted', 'Loading the collection…')); fillCollection(el, b, false); return el; }
  try {
    WIDGETS.rmcollection = { label: 'collection', w: 420, icon: '≡', body: collectionBody, menu: function (b) {
      return [b.entryId ? { label: 'Open its entry in the Lab Notebook', run: function () { openRM('/rm/pages/notebook.html?entry=' + encodeURIComponent(b.entryId)); } } : null,
        { label: 'Change the collection…', run: function () { pickCollection(M.doc(b.docId), { x: b.x || 0, y: b.y || 0 }, function (r) {
          var cur = M.block(b.id); cur.collectionId = r.id; cur.entryId = r.entryId || ''; cur.label = r.title; cur.body = { text: 'Collection: ' + r.title, marks: [] }; cur.modified = isoLocal(new Date()); DB.put('blocks', cur); changed(); }); } }].filter(Boolean);
    } };
    INSERTS.push({ id: 'rmcollection', group: 'Reading', icon: '≡', label: 'Collection from the Lab Notebook…', sub: 'Quotes, key points and papers collected on a canvas entry — read-only here', run: function (d, p) { pickCollection(d, p); } });
  } catch (e) { warn('collections', e); }
  LAB.pickRmProtocol = pickRmProtocol; LAB.runRmProtocol = runRmProtocol; LAB.pickAction = pickAction; LAB.placeAction = placeAction; LAB.pickCollection = pickCollection; LAB.placeCollection = placeCollection;
  try { var st9 = document.getElementById('lab-mode-css'); if (st9) st9.textContent += '.rma{line-height:1.4}.rmc-kp{margin:4px 0 4px 18px;padding:0;font-size:12px}.rmc-claim{font-style:italic;margin:4px 0}.lab-proto-line{gap:6px;margin:0 0 6px;flex-wrap:wrap;align-items:center}'; } catch (e) {}
})();
