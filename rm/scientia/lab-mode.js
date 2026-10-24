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
     Portfolio  what the PI assigned you in RM first, as region cards you move and fold; Quick notes; your own projects (V3.880, section 10).
     Pills      the Lab Notebook's movable ✎ ＋ ✦ ⊕ pills on every note, driving Scientia's own ink, inserts and view (V3.882, section 11).
     Recorder   the one recorder (V3.884, section 12): audio to the cloud a minute at a time, recovery, marks with kinds and sections, timed ink.

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
  var LAB = { version: 'V3.885', RM: RM, opened: [], openRM: openRM, refresh: refreshLibrary };
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
  var KICK = { t: null, runs: 0, last: null, stores: { chores: 1, reminders: 1 }, kinds: {}, onlys: [] };
  LAB.kickRm = kickRm; LAB.kick = KICK;
  /* kinds: which hub syncs to ask for (default when + activity; V3.880 adds 'notes' — RM's list of filed notes) */
  function kickRm(kinds) {
    (kinds || ['when', 'activity']).forEach(function (k) { KICK.kinds[k] = 1; });
    clearTimeout(KICK.t);
    KICK.t = setTimeout(async function () {
      var t0 = Date.now();
      while (typeof SYNC !== 'undefined' && SYNC.outbox && SYNC.outbox.size && Date.now() - t0 < 15000) await new Promise(function (r) { setTimeout(r, 250); });
      var only = Object.keys(KICK.kinds).join(','); KICK.kinds = {}; KICK.onlys.push(only);
      try { var r = await fetch('api/rm/sync?only=' + only, { method: 'POST' }); KICK.last = r.ok ? await r.json() : { ok: false, status: r.status }; }
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

  /* ---- 10. The Portfolio: assigned work from RM, region cards, quick notes (V3.880) ----
     The hub mirrors what the PI assigned this person in RM (research-map cards and projects, `member_uids`) into
     Scientia projects (`rm: true`, `rmAssigned`); an aim under an assigned grant is one of its themes. The map is
     redrawn as REGIONS — assigned first, then Quick notes (Gabe's General notes, 15b), then the person's own projects
     and earlier assignments. A region's header is its handle: drag to move (edge panning), the arrow folds it to its
     header. Until the first move the regions flow in a column; the first move pins them all where they are (Tidy up
     flows them again). Layout and folding are per device (_ls lab:portfolio), like Gabe's own canvas view. A quick
     note is a General note that starts blank, with a bar offering the templates until something is written. */
  var PF = { key: 'lab:portfolio', paper: null, world: null, svg: null, els: {}, list: [], moves: 0, status: null };
  LAB.portfolio = PF;
  var KIND = { grant: 'Grant', aim: 'Aim', output: 'Output', concept: 'Concept', specialty: 'Specialty', paper: 'Paper', course: 'Course', tool: 'Tool', infrastructure: 'Infrastructure' };
  var KIND_ORDER = ['grant', 'aim', 'output', 'concept', 'specialty', 'paper', 'course', 'tool', 'infrastructure'];
  var SHUT = { archived: 1, closed: 1, completed: 1 };
  function pfState() { var s = _ls.get(PF.key, null); s = s && typeof s === 'object' ? s : {}; s.pos = s.pos || {}; s.open = s.open || {}; return s; }
  function pfSave(s) { _ls.set(PF.key, s); }
  function isAssigned(p) { return !!(p && p.rm && p.rmAssigned !== false); }
  function rank(p) { var i = KIND_ORDER.indexOf(p.rmKind); return i < 0 ? 99 : i; }
  function words(s) { return String(s || '').replace(/_/g, ' '); }
  function byModified(a, b) { return String(b.modified || '').localeCompare(String(a.modified || '')); }
  function generalDocs() {
    try { if (typeof GENERAL !== 'undefined' && GENERAL.docs) return GENERAL.docs(); } catch (e) {}
    return DB.where('documents', function (d) { return !d.projectId && !d.deleted && ['day', 'review'].indexOf(d.type) < 0; });
  }
  function regionList() {
    var ps = DB.all('projects'), byName = function (a, b) { return String(a.name || '').localeCompare(String(b.name || '')); };
    var out = ps.filter(isAssigned).sort(function (a, b) { return rank(a) - rank(b) || byName(a, b); }).map(function (p) { return { id: p.id, p: p, group: 'assigned' }; });
    out.push({ id: 'quick', group: 'quick' });
    ps.filter(function (p) { return !p.rm; }).sort(function (a, b) { return String(a.created || '').localeCompare(String(b.created || '')); }).forEach(function (p) { out.push({ id: p.id, p: p, group: 'mine' }); });
    ps.filter(function (p) { return p.rm && p.rmAssigned === false; }).sort(byName).forEach(function (p) { out.push({ id: p.id, p: p, group: 'earlier' }); });
    return out;
  }
  function isOpen(s, r) {
    if (s.open[r.id] !== undefined) return !!s.open[r.id];
    return !(r.group === 'earlier' || (r.p && r.p.rm && SHUT[r.p.rmStatus]));
  }
  function docsOf(r) { return r.group === 'quick' ? generalDocs() : DB.where('documents', function (d) { return d.projectId === r.id && d.type !== 'review' && !d.deleted; }); }

  function docCard(d, sub, act) {
    var items = [], n = 0;
    try { if (Array.isArray(d.blockIds)) { items = M.docBlocks(d.id).flatMap(function (b) { return IX.itemsOf(b.id); }); n = M.liveBlocks(d.id).length; } } catch (e) { /* a record without its components yet */ }
    var ob = items.filter(function (i) { return i.kind === 'barrier' && IX.status(i) === 'open'; }).length;
    return h('div.box.dcard.nopan', { 'data-doc': d.id, on: { click: function () { App.go('#/doc/' + d.id); } } },
      h('div.row', typechip(d.type), TIMER.activeFor(d.id) ? h('span.live', '●') : null, d.share === 'lab' ? h('span.pill.teal', { title: 'Lab members can read it in RM' }, 'lab') : null,
        h('span.spacer'), act || null, h('span.mono.tiny.muted', fmtDay(d.modified))), h('div.dn', d.title),
      h('div.ds', sub != null ? sub : [plural(n, prof(d.type).noun.toLowerCase()), items.length ? ' · ' + plural(items.length, 'structure') : '',
        ob ? h('span', { style: { color: 'var(--bad)' } }, ' · ' + ob + ' open') : null]));
  }
  function touchesLine(d) {
    try { var T = GENERAL.touches(d); return T.length ? 'touches ' + T.map(function (x) { return x.p.name; }).join(', ') : 'not in a project yet'; } catch (e) { return 'not in a project yet'; }
  }
  function projectBody(p) {
    var themes = DB.where('themes', function (t) { return t.projectId === p.id && t.status === 'active'; }).sort(function (a, b) { return String(a.name).localeCompare(String(b.name)); });
    var wide = DB.where('documents', function (d) { return d.projectId === p.id && !d.themeId && d.type !== 'review' && !d.deleted; }), cols = [];
    if (wide.length || !themes.length) cols.push({ name: themes.length ? 'Project-wide' : 'Notes', docs: wide });
    themes.forEach(function (t) { cols.push({ t: t, name: t.name, docs: DB.where('documents', function (d) { return d.themeId === t.id && !d.deleted; }) }); });
    return h('div.lab-reg-b', cols.map(function (c) {
      var H = c.t ? IX.themeHealth(c.t) : null;
      return h('div.lab-col',
        c.t ? h('div.box.tcard.nopan', { on: { click: function () { App.go('#/theme/' + c.t.id); } } }, h('div.tn', c.name),
          c.t.rm && c.t.question ? h('div.lab-q', snippet(c.t.question, 110)) : null,
          h('div.ts', H.stalled ? h('span.pill.warn', 'stalled ' + H.days + 'd') : H.aims.length ? h('span.pill.teal', plural(H.aims.length, 'aim')) : h('span.pill', c.t.rm ? 'aim in RM' : 'exploratory'), ' ', fmtDur(H.ms4) + ' / 4 wk',
            H.openB.length ? h('span', { style: { color: 'var(--bad)' } }, ' · ' + plural(H.openB.length, 'open barrier')) : null),
          heatmapEl({ weeks: 6, themeId: c.t.id, cell: 7 }))
          : h('div.lab-col-h.mono.muted', c.name),
        c.docs.sort(byModified).map(function (d) { return docCard(d); }),
        c.docs.length ? null : h('div.lab-empty.tiny.muted', c.t ? 'No notes in this theme yet' : 'No notes yet — + Note'));
    }));
  }
  function regionEl(r, s) {
    var open = isOpen(s, r), p = r.p, head, body = null, acts = [];
    if (r.group === 'quick') {
      var G = generalDocs().sort(byModified);
      head = [h('div.pk', 'Outside projects'), h('div.pn', 'Quick notes'), h('div.ps', plural(G.length, 'note') + ' · a blank page; choose its project in its first block when you are ready')];
      acts.push(btn('xs pri', '+ Quick note', quickNote, 'A blank page — write, or start from a template'));
      if (open) body = h('div.lab-reg-b.lab-qbody', G.length ? G.map(function (d) { return docCard(d, touchesLine(d)); }) : h('div.lab-empty.tiny.muted', 'A quick note opens as a blank page; its first block holds its title, template, project and theme.'));
    } else {
      var themes = DB.where('themes', function (t) { return t.projectId === p.id && t.status === 'active'; }), notes = docsOf(r).length;
      var kick = p.rm ? [KIND[p.rmKind] || words(p.rmKind) || 'Project', p.rmStatus ? words(p.rmStatus) : null, r.group === 'earlier' ? 'no longer assigned' : 'assigned' + (p.rmRole && p.rmRole !== 'member' ? ' · ' + p.rmRole : '')].filter(Boolean).join(' · ') : 'Project';
      head = [h('div.pk', kick), h('a.pn', { href: '#/project/' + p.id, title: 'Open the project' }, p.name),
        h('div.ps', plural(themes.length, 'theme') + ' · ' + plural(notes, 'note') + ' · ' + plural(IX.openBarriers(p.id).length, 'open barrier')),
        p.rm && (p.rmLine || (p.rmParents || []).length) ? h('div.lab-reg-line', p.rmLine ? h('span.serif', snippet(p.rmLine, 140)) : null,
          (p.rmParents || []).length ? h('span.tiny.muted', (p.rmLine ? ' · ' : '') + 'builds on ' + p.rmParents.join(', ')) : null) : null];
      acts.push(btn('xs', '+ Note', function () { App.newDoc({ projectId: p.id }); }, 'A new note in this project'));
      if (p.rm && p.rmUrl) acts.push(btn('xs', 'Open in RM', function () { openRM(p.rmUrl); }, 'This ' + (KIND[p.rmKind] || 'project').toLowerCase() + ' on the lab site'));
      if (open) body = projectBody(p);
    }
    var tog = h('button.ib.lab-reg-tog', { title: open ? 'Fold to the header' : 'Unfold', 'aria-expanded': String(open), on: { click: function (e) { e.stopPropagation(); toggleRegion(r.id); } } }, open ? '▾' : '▸');
    var hd = h('div.lab-reg-h', { title: 'Drag to move this region' }, tog, h('div.lab-reg-t', head), h('div.lab-reg-a', acts));
    var el = h('div.box.nopan.lab-reg.lab-' + r.group + (open ? '' : '.shut'), { 'data-region': r.id }, hd, body);
    hd.addEventListener('pointerdown', function (e) { dragRegion(e, el, r.id); });
    return el;
  }
  function layout() {
    var s = pfState(), y = 0, maxB = 0, add = false;
    if (s.pinned) {
      PF.list.forEach(function (r) { var q = s.pos[r.id], el = PF.els[r.id]; if (q && el) maxB = Math.max(maxB, q.y + el.offsetHeight); });
      PF.list.forEach(function (r) { var el = PF.els[r.id], q = s.pos[r.id]; if (!el) return; if (!q) { q = s.pos[r.id] = { x: 0, y: maxB ? maxB + 40 : 0 }; maxB = q.y + el.offsetHeight; add = true; } el.style.left = q.x + 'px'; el.style.top = q.y + 'px'; });
      if (add) pfSave(s);
    } else PF.list.forEach(function (r) { var el = PF.els[r.id]; if (!el) return; el.style.left = '0px'; el.style.top = y + 'px'; y += el.offsetHeight + 28; });
    drawLinks();
  }
  function toggleRegion(id) {
    var s = pfState(), r = PF.list.filter(function (x) { return x.id === id; })[0], old = PF.els[id]; if (!r || !old) return;
    s.open[id] = !isOpen(s, r); pfSave(s);
    var nu = regionEl(r, s); nu.style.left = old.style.left; nu.style.top = old.style.top; old.replaceWith(nu); PF.els[id] = nu;
    requestAnimationFrame(layout);
  }
  function dragRegion(e, el, id) {
    var P = PF.paper; if (!P || e.button !== 0 || e.target.closest('button,a,input,select,textarea')) return;
    e.preventDefault(); e.stopPropagation();
    var tgt = e.currentTarget, sx = e.clientX, sy = e.clientY, x0 = parseFloat(el.style.left) || 0, y0 = parseFloat(el.style.top) || 0, ox = 0, oy = 0, moved = 0, raf = 0, last = e;
    try { tgt.setPointerCapture(e.pointerId); } catch (x) {}
    function place(ev) { var z = P.view.z; el.style.left = Math.round(x0 + (ev.clientX - sx) / z + ox) + 'px'; el.style.top = Math.round(y0 + (ev.clientY - sy) / z + oy) + 'px';
      if (!raf) raf = requestAnimationFrame(function () { raf = 0; drawLinks(); }); }
    function mv(ev) { last = ev; moved = Math.max(moved, Math.abs(ev.clientX - sx) + Math.abs(ev.clientY - sy)); if (moved < 4) return;
      el.classList.add('dragging'); place(ev); P.edgePan(ev, function (dx, dy) { ox -= dx / P.view.z; oy -= dy / P.view.z; place(last); }); }
    function up() {
      tgt.removeEventListener('pointermove', mv); tgt.removeEventListener('pointerup', up); tgt.removeEventListener('pointercancel', up); P.stopEdgePan(); el.classList.remove('dragging');
      if (moved < 4) return;
      var s = pfState();
      if (!s.pinned) { PF.list.forEach(function (r) { var x = PF.els[r.id]; if (x) s.pos[r.id] = { x: parseFloat(x.style.left) || 0, y: parseFloat(x.style.top) || 0 }; }); s.pinned = true; }
      s.pos[id] = { x: parseFloat(el.style.left) || 0, y: parseFloat(el.style.top) || 0 }; pfSave(s); PF.moves++; drawLinks();
    }
    tgt.addEventListener('pointermove', mv); tgt.addEventListener('pointerup', up); tgt.addEventListener('pointercancel', up);
  }
  /* the dashed note-to-note connections of Gabe's map, drawn between cards wherever the regions are; a folded region
     stands for its notes */
  function drawLinks() {
    var P = PF.paper, W = PF.world; if (!P || !W || !W.isConnected || !PF.svg) return;
    var z = P.view.z, pos = {}, box = function (el) { var r = el.getBoundingClientRect(), a = P.toWorld(r.left, r.top); return { x: a.x, y: a.y, w: r.width / z, h: r.height / z }; };
    $$('[data-doc]', W).forEach(function (el) { pos[el.dataset.doc] = box(el); });
    PF.list.forEach(function (r) { var el = PF.els[r.id]; if (!el || !el.classList.contains('shut')) return; var R = box(el); R.region = r.id; docsOf(r).forEach(function (d) { if (!pos[d.id]) pos[d.id] = R; }); });
    var pairs = new Map(), add = function (a, b, why) {
      if (!a || !b || a === b || !pos[a] || !pos[b]) return; var ka = pos[a].region || a, kb = pos[b].region || b; if (ka === kb) return;
      var k = [ka, kb].sort().join('|'); if (!pairs.has(k)) pairs.set(k, { A: pos[a], B: pos[b], why: {} }); pairs.get(k).why[why] = 1; };
    DB.all('wires').forEach(function (w) { var A = M.block(w.from), B = M.block(w.to); if (A && B && A.docId !== B.docId) add(A.docId, B.docId, (REL[w.rel] || {}).label || w.rel); });
    DB.all('blocks').forEach(function (b) {
      if (b.kind === 'ref' && b.status !== 'removed') { var o = M.block(b.refBlockId); if (o) add(o.docId, b.docId, 'pulled in'); }
      if (b.boundTo) add(b.boundTo.protocolId, b.docId, 'runs protocol');
      ((b.body && b.body.marks) || []).forEach(function (m) { if (m.type === 'link' && m.ref) { var t = IX.linkTarget(m); if (t) add(b.docId, t.type === 'doc' ? t.d.id : t.b.docId, 'link'); } });
    });
    var svg = '';
    pairs.forEach(function (pr) {
      var A = pr.A, B = pr.B, x1 = A.x + A.w, y1 = A.y + A.h / 2, x2 = B.x, y2 = B.y + B.h / 2;
      var p1 = x1 <= x2 ? { x: x1, y: y1 } : { x: B.x + B.w, y: y2 }, p2 = x1 <= x2 ? { x: x2, y: y2 } : { x: A.x, y: y1 }, off = Math.max(40, Math.abs(p2.x - p1.x) / 2);
      svg += '<path class="pl" d="M' + p1.x + ',' + p1.y + ' C' + (p1.x + off) + ',' + p1.y + ' ' + (p2.x - off) + ',' + p2.y + ' ' + p2.x + ',' + p2.y + '"><title>' + esc(Object.keys(pr.why).join(', ')) + '</title></path>';
    });
    PF.svg.innerHTML = svg; PF.links = pairs.size;
  }
  function tidy() { var s = pfState(); s.pinned = false; s.pos = {}; pfSave(s); App.refresh(); }
  async function refreshAssigned() {
    if (PF.status) PF.status.textContent = 'Asking RM…';
    try {
      var r = await fetch('api/rm/sync?only=projects', { method: 'POST' }), j = r.ok ? await r.json() : null, P = j && j.projects;
      if (PF.status) PF.status.textContent = P && P.ok ? plural(P.projects || 0, 'assigned project') + (P.written ? ' · ' + P.written + ' updated' : ' · up to date') : 'Could not reach the hub';
      return j;
    } catch (e) { if (PF.status) PF.status.textContent = String(e.message || e); return null; }
  }
  function renderPortfolio() {
    var s = pfState(), list = PF.list = regionList(), nA = list.filter(function (r) { return r.group === 'assigned'; }).length, nM = list.filter(function (r) { return r.group === 'mine'; }).length;
    App.setTitle('Portfolio', [h('span', plural(nA, 'assigned project') + ' · ' + plural(nM, 'project') + ' of your own · ' + plural(generalDocs().length, 'quick note'))]);
    DB.all('documents').forEach(seedSig);
    var host = h('div.canvas-host.lab-pf'), P = PF.paper = makePaper(host, { view: _ls.get('view:portfolio', null) || undefined, onView: debounce(function (v) { _ls.set('view:portfolio', v); }, 400), minZ: .2 });
    var W = PF.world = P.world; PF.els = {};
    PF.svg = SV('svg', { class: 'wires plinks' }); W.append(PF.svg);
    list.forEach(function (r, i) { var el = regionEl(r, s), q = s.pinned && s.pos[r.id]; el.style.left = (q ? q.x : 0) + 'px'; el.style.top = (q ? q.y : i * 120) + 'px'; PF.els[r.id] = el; W.append(el); });
    PF.status = h('span.tiny.mono.muted.lab-pf-st');
    host.append(h('div.lab-pf-bar.nopan',
      btn('sm', '+ Project', async function () { var n = await askText('New project', 'Name'); if (n) M.createProject(n); }, 'A project of your own'),
      btn('sm', '+ Quick note', quickNote, 'A blank page outside any project'),
      btn('sm ghost', 'Tidy up', tidy, 'Put the regions back in one column'),
      btn('sm ghost', 'Refresh from RM', refreshAssigned, 'Ask RM for your assigned projects now'), PF.status),
      h('div.hint', 'Assigned projects come from RM. Drag a region by its header; the arrow folds it. Drag the paper to pan.'));
    requestAnimationFrame(function () {
      layout();
      if (!_ls.get('view:portfolio', null)) { var x1 = 0, y1 = 0; list.forEach(function (r) { var el = PF.els[r.id]; if (el) { x1 = Math.max(x1, el.offsetLeft + el.offsetWidth); y1 = Math.max(y1, el.offsetTop + el.offsetHeight); } }); P.fit({ x0: 0, y0: -40, x1: x1, y1: Math.min(y1, 900) }, false); }
    });
    return host;
  }
  try { VIEWS.portfolio.render = renderPortfolio; } catch (e) { warn('portfolio', e); }
  LAB.tidyPortfolio = tidy; LAB.refreshAssigned = refreshAssigned; LAB.drawLinks = drawLinks;

  /* a project the PI assigned: its RM line, and no Rename (the name is RM's) */
  try {
    var oProject = VIEWS.project.render;
    VIEWS.project.render = function (id) {
      var page = oProject.apply(this, arguments), p = M.project(id);
      try {
        if (p && p.rm && page && page.querySelectorAll) {
          [].forEach.call(page.querySelectorAll('button'), function (b) { if (b.textContent.trim() === 'Rename') b.remove(); });
          var stand = page.querySelector('p.stand');
          var info = h('div.callout.lab-rm-proj', h('b.h', (KIND[p.rmKind] || 'Project') + ' in RM' + (p.rmStatus ? ' · ' + words(p.rmStatus) : '') + (p.rmAssigned === false ? ' · no longer assigned to you' : ' · assigned to you')),
            p.rmLine ? h('div.serif', p.rmLine) : null, (p.rmParents || []).length ? h('div.tiny.muted', 'Builds on ' + p.rmParents.join(', ')) : null,
            h('div.row', { style: { marginTop: '6px', gap: '6px' } }, p.rmUrl ? btn('xs', 'Open in RM', function () { openRM(p.rmUrl); }) : null,
              p.rmDraftId && p.rmKind !== 'paper' ? btn('xs', 'Open the draft', function () { openRM('/rm/pages/paper-builder.html?paper=' + encodeURIComponent(p.rmDraftId)); }) : null));
          if (stand) stand.after(info); else page.prepend(info);
        }
      } catch (x) { warn('project view', x); }
      return page;
    };
  } catch (e) { warn('project view', e); }

  /* who reads a note filed under RM work — only its owner (the default) or every lab member. The hub lists it on its
     card / project in RM accordingly (scientiaNotes, V3.880); a change here asks the hub for that list at once. */
  var NOTE_SIG = {};
  LAB.noteSig = NOTE_SIG;
  function rmLinked(d) { var p = d && d.projectId && M.project(d.projectId); return !!(p && p.rm); }
  function noteSig(d) { return [d.projectId || '', d.themeId || '', d.share || '', d.title || '', d.deleted ? 1 : 0].join('|'); }
  function seedSig(d) { if (d && d.id && NOTE_SIG[d.id] === undefined) NOTE_SIG[d.id] = noteSig(d); }
  try {
    var oPut10 = DB.put;
    DB.put = function (store, rec) {
      var r = oPut10.apply(this, arguments);
      try {
        if (store === 'documents' && rec && rec.id && !(typeof SYNC !== 'undefined' && (SYNC.applying || SYNC.loading))) {
          var sig = noteSig(rec), was = NOTE_SIG[rec.id]; NOTE_SIG[rec.id] = sig;
          var fresh = was === undefined && Date.now() - +new Date(rec.created || 0) < 120000;
          if ((fresh || (was !== undefined && was !== sig)) && (rmLinked(rec) || String(was || '').indexOf('rm-') === 0)) kickRm(['notes']);
        }
      } catch (e) {}
      return r;
    };
  } catch (e) { warn('notes kick', e); }
  function shareEl(docId) {
    var d = M.doc(docId), lab = !!(d && d.share === 'lab');
    return h('span.lab-share', { title: 'Who can read this note on its page in RM' }, h('span.tiny.muted', 'Seen by'),
      h('span.seg.lab-share-seg', h('button' + (lab ? '' : '.on'), { 'data-share': 'me', on: { click: function () { setShare(docId, false); } } }, 'Only me'),
        h('button' + (lab ? '.on' : ''), { 'data-share': 'lab', on: { click: function () { setShare(docId, true); } } }, 'Lab members')));
  }
  function setShare(docId, lab) {
    var d = M.doc(docId); if (!d || (d.share === 'lab') === lab) return;
    seedSig(d); d.share = lab ? 'lab' : 'me'; DB.put('documents', d);
    $$('.lab-share').forEach(function (x) { x.replaceWith(shareEl(docId)); });
    toast(lab ? 'Lab members can now read this note on its page in RM' : 'Only you can see this note now');
  }
  LAB.setShare = setShare;

  /* ---- V3.885 — a note's details live in its first block ----
     Alex: "when a user adds a note page never ask for this information up front, instead it is just in this initial
     block" — + Note, + Experiment, ＋ Quick note and Ctrl+Alt+N make the note at once; its head block (Gabe's, always
     there) holds Title · Type · Template · Project · Theme (and *Seen by* in an RM project), always editable. The items
     a template brings carry `tpl { id, label0, text0 }`: while none is edited, changing the template (or the type)
     swaps them freely; once one is edited the person chooses — keep the edited ones (the new template goes beside
     them) or replace everything. Items the person added themselves are never touched by a template change. */
  var QN = { made: 0 };
  function quickNote() { QN.made++; return App.newDoc({ type: 'note', projectId: null }); }
  function defaultTitle(d) { var labs = userProfiles().map(function (p) { return p.label; }).concat(['Quick note', 'Experiment']); return new RegExp('^(' + labs.map(function (l) { return l.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'); }).join('|') + ') · ').test(d.title || ''); }
  function tplItems(d) { return M.liveBlocks(d.id).filter(function (b) { return !!b.tpl; }); }
  function isEdited(b) {
    var t = b.tpl || {};
    return b.kind !== 'component' || String(b.label || '') !== String(t.label0 || '') || String((b.body && b.body.text) || '') !== String(t.text0 || '') || ((b.body && b.body.marks) || []).length > 0;
  }
  /** The items a new note starts with are its template's: mark them so a template change knows them. */
  function markTemplate(docId) {
    var d = M.doc(docId); if (!d) return;
    M.liveBlocks(d.id).forEach(function (b) { if (b.tpl || b.kind !== 'component') return; DB.put('blocks', Object.assign({}, b, { tpl: { id: d.templateId || null, label0: b.label || '', text0: (b.body && b.body.text) || '' } })); });
  }
  function loadTemplate(docId, t, at) {
    var d = M.doc(docId), rows = t && (t.blocks || []).length ? t.blocks : [{ label: '', body: '' }], after = null, made = [];
    rows.forEach(function (r, i) {
      var b = M._newBlock(d, { label: r.label || '', body: { text: r.body || '', marks: [] }, x: at ? at.x : (r.x != null ? r.x : null), y: at ? at.y + i * 168 : (r.y != null ? r.y : null),
        tpl: { id: t ? t.id : null, label0: r.label || '', text0: r.body || '' } }, after);
      after = b.id; made.push(b.id);
    });
    M.autoLayout(d); DB.put('documents', d); return made;
  }
  /** Swap the template's items: all of them, or (keepEdited) only the untouched ones — the new template goes beside the kept. */
  function swapTemplate(docId, tplId, keepEdited) {
    var d = M.doc(docId); if (!d) return;
    var t = tplId ? DB.get('templates', tplId) : null, items = tplItems(d), keep = keepEdited ? items.filter(isEdited) : [], drop = items.filter(function (b) { return keep.indexOf(b) < 0; }), at = null;
    keep.forEach(function (b) { var n = Object.assign({}, b); delete n.tpl; DB.put('blocks', n); });   // now the person's own items
    if (keep.length) { var x1 = -1e9, y0 = 1e9; keep.forEach(function (b) { x1 = Math.max(x1, (b.x || 0) + (b.w || 392)); y0 = Math.min(y0, b.y || 0); }); at = { x: Math.round((x1 + 56) / 14) * 14, y: Math.round(y0 / 14) * 14 }; }
    if (drop.length) EDIT.deleteBlocks(drop.map(function (b) { return b.id; }), { quiet: true });
    var cur = M.doc(docId);
    if (t) { var p = prof(t.type), def = defaultTitle(cur); cur.type = t.type; cur.scope = p.scope; if (p.scope !== 'theme') cur.themeId = null; if (def) cur.title = p.label + ' · ' + fmtDay(cur.created); }
    cur.templateId = t ? t.id : null; DB.put('documents', cur);
    loadTemplate(docId, t, at);
    var nd = M.doc(docId); M.touchDoc(nd); changed();
    LAB.lastSwap = { docId: docId, tplId: tplId, kept: keep.length, dropped: drop.length };
  }
  function changeTemplate(docId, tplId, sel) {
    var d = M.doc(docId); if (!d || (d.templateId || '') === (tplId || '')) return;
    var edited = tplItems(d).filter(isEdited), t = tplId ? DB.get('templates', tplId) : null, name = t ? (t.isStandard ? prof(t.type).label : t.name) : 'no template';
    if (!edited.length) { swapTemplate(docId, tplId, false); toast(t ? 'Template: ' + name : 'No template — a blank page'); return; }
    var restore = function () { if (sel && sel.isConnected) sel.value = (M.doc(docId) || {}).templateId || ''; };
    modal({ title: 'Change the template?', onClose: restore, body: h('div',
        h('p', 'You have edited ' + plural(edited.length, 'item') + ' that came with the current template. Changing to ', h('b', name), ' deletes the template’s items.'),
        h('p.tiny.muted', 'Keep the items I edited: those stay (and become your own), the untouched ones go, and the new template’s items are placed beside them. Replace everything: all of the template’s items go, your edits too. Items you added yourself always stay.')),
      actions: [{ label: 'Cancel', run: restore },
        { label: 'Keep the items I edited', pri: true, run: function () { swapTemplate(docId, tplId, true); toast('Template: ' + name + ' — your edited items kept'); } },
        { label: 'Replace everything', danger: true, run: function () { swapTemplate(docId, tplId, false); toast('Template: ' + name); } }] });
  }
  function changeType(docId, type) {
    var d = M.doc(docId); if (!d || d.type === type || !PROFILE[type]) return;
    var std = M.enabledTemplates(type)[0];
    if (!tplItems(d).filter(isEdited).length && std) { swapTemplate(docId, std.id, false); toast(prof(type).label + ' — with its template'); return; }   // untouched: the type's template comes with it
    var p = prof(type), def = defaultTitle(d); seedSig(d);
    d.type = type; d.scope = p.scope; if (p.scope !== 'theme') d.themeId = null; if (def) d.title = p.label + ' · ' + fmtDay(d.created);
    M.touchDoc(d); changed(); toast(p.label + ' — pick a template to load its items');
  }
  function setProject(docId, pid) {
    var d = M.doc(docId); if (!d || (d.projectId || '') === (pid || '')) return; seedSig(d);
    d.projectId = pid || null; var th = d.themeId && M.theme(d.themeId); if (!th || th.projectId !== d.projectId) d.themeId = null;
    M.touchDoc(d); changed(); var P = pid && M.project(pid); toast(P ? 'Stored in ' + P.name : 'Outside any project (a quick note)');
  }
  function setTheme(docId, tid) { var d = M.doc(docId); if (!d || (d.themeId || '') === (tid || '')) return; seedSig(d); d.themeId = tid || null; M.touchDoc(d); changed(); }
  function setTitle(docId, v) { var d = M.doc(docId); v = String(v || '').trim(); if (!d || !v || d.title === v) return; seedSig(d); d.title = v; if (d.chain === d.id && / — /.test(v)) d.chainName = v.replace(/\s+—\s+[^—]+$/, ''); M.touchDoc(d); changed(); }
  LAB.changeTemplate = changeTemplate; LAB.swapTemplate = swapTemplate; LAB.changeType = changeType; LAB.setProject = setProject; LAB.setTheme = setTheme; LAB.setTitle = setTitle; LAB.isEdited = isEdited; LAB.tplItems = tplItems;
  function headFields(d) {
    var byName = function (a, b) { return String(a.name || '').localeCompare(String(b.name || '')); };
    var ps = DB.all('projects').filter(function (p) { return !(p.rm && p.rmAssigned === false) || p.id === d.projectId; });
    var assigned = ps.filter(function (p) { return p.rm; }).sort(function (a, b) { return rank(a) - rank(b) || byName(a, b); }), own = ps.filter(function (p) { return !p.rm; }).sort(byName);
    var stop = function (e) { e.stopPropagation(); };
    var opt = function (p) { return h('option', { value: p.id, selected: p.id === d.projectId }, p.name); };
    var title = h('input.hin.lab-h-title', { value: d.title || '', placeholder: 'What this note is about', on: { pointerdown: stop, keydown: function (e) { e.stopPropagation(); if (e.key === 'Enter') e.target.blur(); }, change: function (e) { setTitle(d.id, e.target.value); } } });
    var type = h('select.hin.lab-h-type', { on: { pointerdown: stop, change: function (e) { changeType(d.id, e.target.value); } } }, userProfiles().map(function (p) { return h('option', { value: p.type, selected: p.type === d.type }, p.label); }));
    var tpl = h('select.hin.lab-h-tpl', { title: 'Change it freely until you edit an item it brought', on: { pointerdown: stop, change: function (e) { changeTemplate(d.id, e.target.value || null, e.target); } } },
      h('option', { value: '', selected: !d.templateId }, 'No template — a blank page'),
      userProfiles().map(function (p) { var ts = M.templatesFor(p.type).filter(function (t) { return t.enabled || !t.isStandard || t.id === d.templateId; });
        return ts.length ? h('optgroup', { label: p.label }, ts.map(function (t) { return h('option', { value: t.id, selected: t.id === d.templateId }, t.isStandard ? p.label + ' (standard)' : t.name); })) : null; }));
    var proj = h('select.hin.lab-h-proj', { on: { pointerdown: stop, change: function (e) { setProject(d.id, e.target.value); } } }, h('option', { value: '', selected: !d.projectId }, 'No project — a quick note'),
      assigned.length ? h('optgroup', { label: 'Assigned to you' }, assigned.map(opt)) : null, own.length ? h('optgroup', { label: 'Your projects' }, own.map(opt)) : null);
    var themes = d.projectId ? DB.where('themes', function (t) { return t.projectId === d.projectId && t.status === 'active'; }) : [], inTheme = prof(d.type).scope === 'theme';
    var theme = h('select.hin.lab-h-theme', { disabled: !d.projectId || !inTheme || !themes.length, on: { pointerdown: stop, change: function (e) { setTheme(d.id, e.target.value); } } },
      h('option', { value: '' }, !d.projectId ? 'Choose a project first' : !inTheme ? 'This type is project-wide' : themes.length ? '— none (project-wide) —' : 'No themes in this project'),
      themes.map(function (t) { return h('option', { value: t.id, selected: t.id === d.themeId }, t.name); }));
    return h('div.hgrid.lab-hmeta', { 'data-doc': d.id },
      h('label.hf', h('span', 'Title'), title), h('label.hf', h('span', 'Type'), type), h('label.hf', h('span', 'Template'), tpl),
      h('label.hf', h('span', 'Project'), proj), h('label.hf', h('span', 'Theme'), theme),
      rmLinked(d) ? h('div.hf.lab-h-share', h('span', 'Seen by'), shareEl(d.id)) : null);
  }
  try {
    var oHeadBox = DocView.headBox;
    DocView.headBox = function (d) {
      var el = oHeadBox.apply(this, arguments);
      try { if (!this.travel && el && el.querySelector) { var g = el.querySelector('.hgrid'); var f = headFields(M.doc(d.id) || d); if (g) g.before(f); else el.append(f); } } catch (x) { warn('note head', x); }
      return el;
    };
    var oNewDoc = App.newDoc;
    App.newDoc = function (pre) {
      pre = pre || {};
      if (pre.runDef) return oNewDoc.apply(App, arguments);   // running a registered protocol: his dialog picks the run
      var type = pre.type && PROFILE[pre.type] ? pre.type : 'note', d, first0 = CHAIN.firstType();
      if (type === 'experiment' && first0 !== 'experiment' && CHAIN.precedes(first0, 'experiment')) d = CHAIN.create({ projectId: pre.projectId || null, themeId: pre.themeId || null, name: pre.title || '', date: pre.date });
      else { var tp = M.enabledTemplates(type)[0] || null; d = M.createDoc({ type: type, projectId: pre.projectId || null, themeId: pre.themeId || null, title: pre.title || '', templateId: tp ? tp.id : null, date: pre.date }); }
      markTemplate(d.id); seedSig(M.doc(d.id));
      if (pre.onCreate) try { pre.onCreate(d); } catch (x) { warn('new note', x); }
      var f = M.doc(d.id).blockIds.map(M.block).filter(Boolean)[0]; DocView.pendingFocus = f ? { focus: f.id, pos: 0 } : null;
      App.go('#/doc/' + d.id);
      return d;
    };
    CHAIN.start = function (pre) { return App.newDoc(Object.assign({}, pre || {}, { type: 'experiment' })); };
    var oDocRender = DocView.render;
    DocView.render = function (docId) { var host = oDocRender.apply(this, arguments); try { seedSig(M.doc(docId)); } catch (x) {} return host; };
  } catch (e) { warn('note head', e); }
  LAB.quickNote = quickNote; LAB.markTemplate = markTemplate;
  /* V3.882 — the Lab Notebook's ＋ Quick note (notebook-scientia.js sisCmd 'quick'); a fresh frame may still be loading the record */
  window.addEventListener('message', function (e) {
    if (e.origin !== ORIGIN || e.source !== window.parent || !e.data || e.data.sisCmd !== 'quick') return;
    var t0 = Date.now();
    (function tryNow() {
      var ready = false; try { ready = !!(App._mounted && DB.all('settings').length); } catch (x) {}
      if (ready || Date.now() - t0 > 15000) { try { quickNote(); } catch (x) { warn('quick note', x); } }
      else setTimeout(tryNow, 200);
    })();
  });

  try {
    var st10 = document.getElementById('lab-mode-css');
    if (st10) st10.textContent += '.lab-reg{min-width:300px;width:max-content;padding:0;background:color-mix(in srgb,var(--surface) 55%,var(--paper));border:1px solid var(--rule-2);border-radius:10px}' +
      '.lab-reg.lab-assigned{border-top:3px solid var(--teal)}.lab-reg.lab-quick{border-top:3px solid var(--ink-3)}.lab-reg.lab-earlier{opacity:.8}' +
      '.lab-reg-h{display:flex;gap:8px;align-items:flex-start;padding:10px 12px;cursor:grab;touch-action:none}.lab-reg.dragging .lab-reg-h{cursor:grabbing}' +
      '.lab-reg-tog{flex:none;width:22px;height:22px;font-size:13px;line-height:1}.lab-reg-t{flex:1 1 auto;min-width:0;max-width:640px}' +
      '.lab-reg-t .pk{font-family:var(--f-m);font-size:9.5px;letter-spacing:.14em;text-transform:uppercase;color:var(--ink-3)}' +
      '.lab-reg-t .pn{display:block;font-size:17px;font-weight:700;letter-spacing:-.015em;color:var(--ink);text-decoration:none}.lab-reg-t a.pn:hover{text-decoration:underline}' +
      '.lab-reg-t .ps{font-family:var(--f-m);font-size:10.5px;color:var(--ink-3)}.lab-reg-line{font-size:12.5px;color:var(--ink-2);margin-top:3px}' +
      '.lab-reg-a{display:flex;gap:6px;flex:none;flex-wrap:wrap;justify-content:flex-end;max-width:220px}' +
      '.lab-reg-b{display:flex;gap:16px;align-items:flex-start;padding:4px 12px 12px}.lab-reg-b.lab-qbody{flex-wrap:wrap;max-width:860px;gap:10px}' +
      '.lab-col{width:240px;display:flex;flex-direction:column;gap:8px}.lab-reg .box{position:relative;left:auto;top:auto}.lab-qbody .dcard{width:260px}' +
      '.lab-col-h{padding:2px 2px 0;letter-spacing:.1em;text-transform:uppercase;font-size:9.5px}.lab-empty{padding:6px 4px}.lab-q{font-size:11.5px;color:var(--ink-3);margin:-2px 0 6px;line-height:1.35}' +
      '.lab-pf-bar{position:absolute;top:12px;left:12px;z-index:16;display:flex;gap:6px;flex-wrap:wrap;align-items:center;max-width:calc(100% - 24px)}' +
      '.lab-hmeta{padding-bottom:7px;margin-bottom:4px;border-bottom:1px solid var(--rule)}.lab-hmeta select.hin,.lab-hmeta input.hin{width:100%;box-sizing:border-box}.lab-hmeta select.hin:disabled{color:var(--ink-4)}' +
      '.lab-h-share{grid-template-columns:86px 1fr}.lab-h-share .lab-share{margin-left:0}' +
      '.lab-share{display:inline-flex;align-items:center;gap:6px;margin-left:10px}.lab-share .seg button{height:20px;font-size:11px;padding:0 7px}.lab-file{flex:none}' +
      '.lab-rm-proj{margin:10px 0}@media (max-width:820px){.lab-reg-a{max-width:150px}}';
  } catch (e) { warn('css 10', e); }

  /* ---- 11. The canvas pills in a note (V3.882) ----
     The Lab Notebook's four movable pills (whiteboard.js V3.837–V3.863) on every Scientia note, driving Scientia's own
     tools — nothing copied: ✎ the hand (zoom · move · pen · highlighter · lasso; the second arc is the mode's options),
     ＋ Insert (the most used of INSERTS; More… = Gabe's whole list), ✦ Tools (timer, calculator, equation, Gabe's ink
     bar, focus mode), ⊕ View (in · 100 % · out · fit, the zoom % under it). The hand IS Gabe's ink state — pen /
     highlighter / lasso / eraser = INK.tool with INK.mouse on; move = INK.mouse off (the paper pans, components drag);
     zoom = ours (a tap zooms ×1.5 at the point, Alt / Shift: out; a drag up or down zooms smoothly) — read back on every
     paint, so his ink bar and the pill never disagree. A pill drags anywhere (fractions of the note's area, _ls
     lab:pills); the fan opens away from the nearest edges; a tap outside closes it; a double tap on ✎ = the last mode. */
  var PILL_ICONS = {"magnifying-glass": "<path stroke-linecap=\"round\" stroke-linejoin=\"round\" d=\"m21 21-5.197-5.197m0 0A7.5 7.5 0 1 0 5.196 5.196a7.5 7.5 0 0 0 10.607 10.607Z\"/>", "hand": "<path d=\"M18 11V6a2 2 0 0 0-2-2a2 2 0 0 0-2 2\" /><path d=\"M14 10V4a2 2 0 0 0-2-2a2 2 0 0 0-2 2v2\" /><path d=\"M10 10.5V6a2 2 0 0 0-2-2a2 2 0 0 0-2 2v8\" /><path d=\"M18 8a2 2 0 1 1 4 0v6a8 8 0 0 1-8 8h-2c-2.8 0-4.5-.86-5.99-2.34l-3.6-3.6a2 2 0 0 1 2.83-2.82L7 15\" />", "pencil": "<path stroke-linecap=\"round\" stroke-linejoin=\"round\" d=\"m16.862 4.487 1.687-1.688a1.875 1.875 0 1 1 2.652 2.652L6.832 19.82a4.5 4.5 0 0 1-1.897 1.13l-2.685.8.8-2.685a4.5 4.5 0 0 1 1.13-1.897L16.863 4.487Zm0 0L19.5 7.125\"/>", "highlighter": "<path d=\"m9 11-6 6v3h9l3-3\" /><path d=\"m22 12-4.6 4.6a2 2 0 0 1-2.8 0l-5.2-5.2a2 2 0 0 1 0-2.8L14 4\" />", "plus": "<path stroke-linecap=\"round\" stroke-linejoin=\"round\" d=\"M12 4.5v15m7.5-7.5h-15\"/>", "minus": "<path stroke-linecap=\"round\" stroke-linejoin=\"round\" d=\"M5 12h14\"/>", "home": "<path stroke-linecap=\"round\" stroke-linejoin=\"round\" d=\"m2.25 12 8.954-8.955c.44-.439 1.152-.439 1.591 0L21.75 12M4.5 9.75v10.125c0 .621.504 1.125 1.125 1.125H9.75v-4.875c0-.621.504-1.125 1.125-1.125h2.25c.621 0 1.125.504 1.125 1.125V21h4.125c.621 0 1.125-.504 1.125-1.125V9.75M8.25 21h8.25\"/>", "arrow-uturn-left": "<path stroke-linecap=\"round\" stroke-linejoin=\"round\" d=\"M9 15 3 9m0 0 6-6M3 9h12a6 6 0 0 1 0 12h-3\"/>", "arrow-uturn-right": "<path stroke-linecap=\"round\" stroke-linejoin=\"round\" d=\"m15 15 6-6m0 0-6-6m6 6H9a6 6 0 0 0 0 12h3\"/>", "x-mark": "<path stroke-linecap=\"round\" stroke-linejoin=\"round\" d=\"M6 18 18 6M6 6l12 12\"/>", "calculator": "<path stroke-linecap=\"round\" stroke-linejoin=\"round\" d=\"M15.75 15.75V18m-7.5-6.75h.008v.008H8.25v-.008Zm0 2.25h.008v.008H8.25V13.5Zm0 2.25h.008v.008H8.25v-.008Zm0 2.25h.008v.008H8.25V18Zm2.498-6.75h.007v.008h-.007v-.008Zm0 2.25h.007v.008h-.007V13.5Zm0 2.25h.007v.008h-.007v-.008Zm0 2.25h.007v.008h-.007V18Zm2.504-6.75h.008v.008h-.008v-.008Zm0 2.25h.008v.008h-.008V13.5Zm0 2.25h.008v.008h-.008v-.008Zm0 2.25h.008v.008h-.008V18Zm2.498-6.75h.008v.008h-.008v-.008Zm0 2.25h.008v.008h-.008V13.5ZM8.25 6h7.5v2.25h-7.5V6ZM12 2.25c-1.892 0-3.758.11-5.593.322C5.307 2.7 4.5 3.65 4.5 4.757V19.5a2.25 2.25 0 0 0 2.25 2.25h10.5a2.25 2.25 0 0 0 2.25-2.25V4.757c0-1.108-.806-2.057-1.907-2.185A48.507 48.507 0 0 0 12 2.25Z\"/>", "clock": "<path stroke-linecap=\"round\" stroke-linejoin=\"round\" d=\"M12 6v6h4.5m4.5 0a9 9 0 1 1-18 0 9 9 0 0 1 18 0Z\"/>", "arrows-pointing-out": "<path stroke-linecap=\"round\" stroke-linejoin=\"round\" d=\"M9.879 7.519c1.171-1.025 3.071-1.025 4.242 0 1.172 1.025 1.172 2.687 0 3.712-.203.179-.43.326-.67.442-.745.361-1.45.999-1.45 1.827v.75M21 12a9 9 0 1 1-18 0 9 9 0 0 1 18 0Zm-9 5.25h.008v.008H12v-.008Z\"/>", "squares-plus": "<path stroke-linecap=\"round\" stroke-linejoin=\"round\" d=\"M13.5 16.875h3.375m0 0h3.375m-3.375 0V13.5m0 3.375v3.375M6 10.5h2.25a2.25 2.25 0 0 0 2.25-2.25V6a2.25 2.25 0 0 0-2.25-2.25H6A2.25 2.25 0 0 0 3.75 6v2.25A2.25 2.25 0 0 0 6 10.5Zm0 9.75h2.25A2.25 2.25 0 0 0 10.5 18v-2.25a2.25 2.25 0 0 0-2.25-2.25H6a2.25 2.25 0 0 0-2.25 2.25V18A2.25 2.25 0 0 0 6 20.25Zm9.75-9.75H18a2.25 2.25 0 0 0 2.25-2.25V6A2.25 2.25 0 0 0 18 3.75h-2.25A2.25 2.25 0 0 0 13.5 6v2.25a2.25 2.25 0 0 0 2.25 2.25Z\"/>", "sparkles": "<path stroke-linecap=\"round\" stroke-linejoin=\"round\" d=\"M9.813 15.904 9 18.75l-.813-2.846a4.5 4.5 0 0 0-3.09-3.09L2.25 12l2.846-.813a4.5 4.5 0 0 0 3.09-3.09L9 5.25l.813 2.846a4.5 4.5 0 0 0 3.09 3.09L15.75 12l-2.846.813a4.5 4.5 0 0 0-3.09 3.09ZM18.259 8.715 18 9.75l-.259-1.035a3.375 3.375 0 0 0-2.455-2.456L14.25 6l1.036-.259a3.375 3.375 0 0 0 2.455-2.456L18 2.25l.259 1.035a3.375 3.375 0 0 0 2.456 2.456L21.75 6l-1.035.259a3.375 3.375 0 0 0-2.456 2.456ZM16.894 20.567 16.5 21.75l-.394-1.183a2.25 2.25 0 0 0-1.423-1.423L13.5 18.75l1.183-.394a2.25 2.25 0 0 0 1.423-1.423l.394-1.183.394 1.183a2.25 2.25 0 0 0 1.423 1.423l1.183.394-1.183.394a2.25 2.25 0 0 0-1.423 1.423Z\"/>", "pause": "<path stroke-linecap=\"round\" stroke-linejoin=\"round\" d=\"M15.75 5.25v13.5m-7.5-13.5v13.5\"/>", "play": "<path stroke-linecap=\"round\" stroke-linejoin=\"round\" d=\"M5.25 5.653c0-.856.917-1.398 1.667-.986l11.54 6.347a1.125 1.125 0 0 1 0 1.972l-11.54 6.347a1.125 1.125 0 0 1-1.667-.986V5.653Z\"/>", "eye": "<path stroke-linecap=\"round\" stroke-linejoin=\"round\" d=\"M2.036 12.322a1.012 1.012 0 0 1 0-.639C3.423 7.51 7.36 4.5 12 4.5c4.638 0 8.573 3.007 9.963 7.178.07.207.07.431 0 .639C20.577 16.49 16.64 19.5 12 19.5c-4.638 0-8.573-3.007-9.963-7.178Z\"/><path stroke-linecap=\"round\" stroke-linejoin=\"round\" d=\"M15 12a3 3 0 1 1-6 0 3 3 0 0 1 6 0Z\"/>", "variable": "<path stroke-linecap=\"round\" stroke-linejoin=\"round\" d=\"M4.745 3A23.933 23.933 0 0 0 3 12c0 3.183.62 6.22 1.745 9M19.5 3c.967 2.78 1.5 5.817 1.5 9s-.533 6.22-1.5 9M8.25 8.885l1.444-.89a.75.75 0 0 1 1.105.402l2.402 7.206a.75.75 0 0 0 1.104.401l1.445-.889m-8.25.75.213.09a1.687 1.687 0 0 0 2.062-.617l4.45-6.676a1.688 1.688 0 0 1 2.062-.618l.213.09\"/>", "bolt": "<path stroke-linecap=\"round\" stroke-linejoin=\"round\" d=\"m3.75 13.5 10.5-11.25L12 10.5h8.25L9.75 21.75 12 13.5H3.75Z\"/>", "lasso": "<ellipse cx=\"12\" cy=\"10\" rx=\"8\" ry=\"5.5\" stroke-dasharray=\"2.6 2.4\"/><path stroke-linecap=\"round\" d=\"M9.5 15.2c-.6 1.8-.2 3.6 1.4 4.8\"/>"};
  function pic(name) { var p = PILL_ICONS[name]; return p ? '<svg viewBox="0 0 24 24" width="18" height="18" fill="none" stroke="currentColor" stroke-width="1.6" aria-hidden="true" focusable="false">' + p + '</svg>' : ''; }
  function picEl(name) { var s = h('span.lab-pic'); s.innerHTML = pic(name); return s; }
  var LP = { open: null, zoom: false, last: null, seen: null, pos: _ls.get('lab:pills', {}) || {}, tap: null, suppress: 0 };
  LAB.pills = LP;
  var PILLS = { hand: { icon: '✎', label: 'Zoom · move · pen · highlighter · lasso (double-tap: the last mode)', side: 'left' },
    insert: { icon: '＋', label: 'Insert into this note', side: 'left' }, tools: { icon: '✦', label: 'Tools', side: 'left' }, view: { icon: '⊕', label: 'View', side: 'right' } };
  var HAND_NAMES = { zoom: 'Zoom', move: 'Move', pen: 'Pen', hl: 'Highlighter', lasso: 'Lasso', eraser: 'Eraser' };
  var FAN_RINGS = [[5, 84], [7, 140], [9, 196]];
  function fanPos(i, n, side, vert) {
    var k = i, start = 0, ring = 0;
    while (ring < FAN_RINGS.length - 1 && k >= Math.min(FAN_RINGS[ring][0], n - start)) { var c = Math.min(FAN_RINGS[ring][0], n - start); k -= c; start += c; ring++; }
    var cnt = Math.max(1, Math.min(FAN_RINGS[ring][0], n - start)), r = FAN_RINGS[ring][1];
    var a0 = side === 'left' ? (vert === 'up' ? 4 : 274) : (vert === 'up' ? 94 : 184), a1 = a0 + 82, a = cnt === 1 ? (a0 + a1) / 2 : a0 + (a1 - a0) * k / (cnt - 1), t = a * Math.PI / 180;
    return { x: Math.round(Math.cos(t) * r), y: Math.round(-Math.sin(t) * r) };
  }
  // a colour the person adds is kept per device and joins Gabe's swatches (a stroke stores its colour, so this is safe)
  try { (_ls.get('lab:inkColors', []) || []).forEach(function (c) { if (/^#[0-9a-f]{6}$/i.test(c) && INK.COLORS.indexOf(c) < 0 && INK.COLORS.length < 8) INK.COLORS.push(c); }); } catch (e) {}
  function handNow() {
    if (LP.zoom) return 'zoom';
    if (!INK.mouse) return 'move';
    return INK.tool === 'hl' ? 'hl' : INK.tool === 'lasso' ? 'lasso' : INK.tool === 'eraser' ? 'eraser' : 'pen';
  }
  function handGroup() { var m = handNow(); return m === 'eraser' ? 'pen' : m; }
  function setHand(m) {
    var cur = handNow(); if (cur === m) return;
    LP.zoom = m === 'zoom';
    if (m === 'zoom' || m === 'move') { INK.mouse = false; if (INK.sel) INK.clearSel(); INK.paintBars(); }
    else { INK.mouse = true; INK.setTool(m); }
    paintAll();
  }
  function trackHand() { var m = handNow(); if (LP.seen && LP.seen !== m) LP.last = LP.seen; LP.seen = m; }
  function lastHand() { var cur = handNow(), t = LP.last; if (!t || t === cur) t = /^(move|zoom)$/.test(cur) ? 'pen' : 'move'; setHand(t); toast(HAND_NAMES[handNow()] + ' — double-tap ✎ to switch back', 1400); }
  function centerAt(pane) { var r = pane.paper.rect(), c = pane.paper.toWorld(r.left + r.width / 2, r.top + r.height / 2); return { x: Math.round((c.x - 200) / 14) * 14, y: Math.round((c.y - 140) / 14) * 14 }; }
  function zoomBy(pane, k) { var P = pane.paper; P.zoomAt(P.view.z * k); }
  function zoom100(pane) { var P = pane.paper; P.zoomAt(1); }
  function fitAll(pane) { try { var bb = pane.bbox && pane.bbox(); pane.paper.fit(bb || undefined); } catch (e) { warn('fit', e); } }
  function insertRows(d) {
    var rows = INSERTS.filter(function (x) { return !x.when || x.when(d); }), pick = ['component', 'rmpaper', 'material', 'rmprotocol', 'run', 'plate', 'task', 'rmaction', 'rmcollection'], out = [];
    pick.forEach(function (id) { var x = rows.filter(function (r) { return r.id === id; })[0]; if (x) out.push(x); });
    rows.forEach(function (x) { if (out.length < 9 && out.indexOf(x) < 0) out.push(x); });
    return out.slice(0, 9);
  }
  function pillItems(name, pane) {
    var d = M.doc(pane.docId), items = []; if (!d) return items;
    if (name === 'hand') {
      var g = handGroup();
      [['zoom', 'magnifying-glass', 'Zoom — tap to zoom in, Alt-tap out, drag up or down'], ['move', 'hand', 'Move — drag the paper to pan, drag a component to move it'], ['pen', 'pencil', 'Pen — draw with the mouse or the pen'],
        ['hl', 'highlighter', 'Highlighter — wide and see-through'], ['lasso', 'lasso', 'Lasso — circle strokes to move, recolour, delete or convert']].forEach(function (f) {
        items.push({ icon: pic(f[1]), label: f[2], sel: g === f[0], mode: true, keep: true, run: function () { setHand(f[0]); } }); });
      var undo = function () { items.push({ icon: pic('arrow-uturn-left'), label: 'Undo', keep: true, run: function () { App.undo(); } }); items.push({ icon: pic('arrow-uturn-right'), label: 'Redo', keep: true, run: function () { App.redo(); } }); };
      var colours = function () { INK.COLORS.forEach(function (c, k) { items.push({ dot: INK.swatch(c), hl: g === 'hl', label: c === 'auto' ? 'Ink (black, or white on the dark theme)' : 'Colour ' + c, sel: INK.color === k && INK.tool !== 'eraser', keep: true,
        run: function () { INK.color = k; _ls.set('inkColor', k); if (INK.tool === 'eraser') INK.setTool('pen'); else INK.paintBars(); paintAll(); } }); }); };
      var widths = function () { INK.WIDTHS.forEach(function (w, k) { items.push({ bar: Math.max(2, Math.round(w * 1.6)), label: ['Fine', 'Medium', 'Bold'][k] || 'Width', sel: INK.width === k, keep: true, run: function () { INK.width = k; _ls.set('inkWidth', k); INK.paintBars(); paintAll(); } }); }); };
      if (g === 'pen') {
        colours();
        items.push({ eraser: true, label: INK.tool === 'eraser' ? 'Back to the pen' : 'Eraser — touch strokes to remove them', sel: INK.tool === 'eraser', keep: true, run: function () { INK.setTool(INK.tool === 'eraser' ? 'pen' : 'eraser'); paintAll(); } });
        widths();
        if (INK.COLORS.length < 8) items.push({ addColour: true, label: 'Add a colour (kept on this device)', keep: true });
        items.push({ icon: '<span class="lab-pr' + (INK.pressure ? ' on' : '') + '">P</span>', label: INK.pressure ? 'Pressure on — pressing harder draws thicker (tap: off)' : 'Pressure off — even lines (tap: on)', sel: INK.pressure, keep: true,
          run: function () { INK.pressure = !INK.pressure; _ls.set('inkPressure', INK.pressure); INK.paintBars(); paintAll(); } });
        undo();
      } else if (g === 'hl') { colours(); widths(); undo(); }
      else if (g === 'zoom') {
        items.push({ icon: pic('plus'), label: 'Zoom in', keep: true, run: function () { zoomBy(pane, 1.25); } });
        items.push({ icon: pic('minus'), label: 'Zoom out', keep: true, run: function () { zoomBy(pane, 0.8); } });
        items.push({ icon: '<b class="lab-100">1:1</b>', label: '100 %', keep: true, run: function () { zoom100(pane); } });
        items.push({ icon: pic('arrows-pointing-out'), label: 'Fit everything on the screen', run: function () { fitAll(pane); } });
      } else if (g === 'move') {
        items.push({ icon: '<b class="lab-100">1:1</b>', label: '100 %', keep: true, run: function () { zoom100(pane); } });
        items.push({ icon: pic('arrows-pointing-out'), label: 'Fit everything on the screen', run: function () { fitAll(pane); } });
        undo();
      } else if (g === 'lasso') undo();
    } else if (name === 'insert') {
      insertRows(d).forEach(function (x) { var lab = typeof x.label === 'function' ? x.label(d) : x.label;
        items.push({ icon: '<span class="lab-insic">' + esc(x.icon || '•') + '</span>', label: lab + (x.sub ? ' — ' + x.sub : ''), run: function () { x.run(d, centerAt(pane), pane); } }); });
      items.push({ icon: '<span class="lab-insic">…</span>', label: 'Everything that can go in this note', run: function (el) { INSERT.menu(pane, el); } });
    } else if (name === 'tools') {
      var s = TIMER.activeFor(d.id);
      items.push({ icon: pic(!s ? 'clock' : s.state === 'running' ? 'pause' : 'play'), label: !s ? 'Start this note’s timer' : s.state === 'running' ? 'Pause the timer' : 'Resume the timer', sel: !!s, keep: true,
        run: function () { var cur = TIMER.activeFor(d.id); if (!cur) { if (typeof TCMP !== 'undefined' && TCMP.start) TCMP.start(d.id); else TIMER.start(d.id); } else if (cur.state === 'running') TIMER.pause(cur); else TIMER.resume(cur); paintAll(); } });
      items.push({ icon: pic('calculator'), label: 'A calculator in this note', run: function () { CALC.open(pane); } });
      items.push({ icon: pic('variable'), label: 'An equation — new, or a registered one', run: function (el) { var r = el.getBoundingClientRect(); EQ.newMenu(pane, { clientX: r.left, clientY: r.top, currentTarget: el, target: el, preventDefault: function () {}, stopPropagation: function () {} }); } });
      items.push({ icon: pic('eye'), label: INK.shown ? 'Hide Gabe’s ink bar' : 'Show the ink bar (pressure feel, convert to text)', sel: INK.shown, keep: true,
        run: function () { INK.shown = !INK.shown; _ls.set('inkBar', INK.shown); INK.paintBars(); $$('.ctools .ct-ink').forEach(function (b) { b.classList.toggle('on', INK.shown); }); paintAll(); } });
      items.push({ icon: pic('arrows-pointing-out'), label: document.fullscreenElement ? 'Leave focus mode' : 'Focus mode — full screen', run: function () { App.toggleFocus(); } });
      if (Object.keys(LP.pos).length) items.push({ icon: pic('home'), label: 'Put the pills back in their places', run: function () { LP.pos = {}; _ls.set('lab:pills', {}); paintAll(); } });
    } else if (name === 'view') {
      items.push({ icon: pic('plus'), label: 'Zoom in', keep: true, run: function () { zoomBy(pane, 1.25); } });
      items.push({ icon: '<b class="lab-100">1:1</b>', label: '100 %', keep: true, run: function () { zoom100(pane); } });
      items.push({ icon: pic('minus'), label: 'Zoom out', keep: true, run: function () { zoomBy(pane, 0.8); } });
      items.push({ icon: pic('arrows-pointing-out'), label: 'Fit everything on the screen', run: function () { fitAll(pane); } });
    }
    return items;
  }
  function addColourItem(it, close) {
    var inp = h('input', { type: 'color', value: '#7c3aed', 'aria-label': 'A new ink colour', on: { change: function (e) { var c = String(e.target.value || '').toLowerCase(); if (!/^#[0-9a-f]{6}$/.test(c)) return;
      if (INK.COLORS.indexOf(c) < 0) { INK.COLORS.push(c); var keep = (_ls.get('lab:inkColors', []) || []).concat([c]).slice(-3); _ls.set('lab:inkColors', keep); }
      INK.color = INK.COLORS.indexOf(c); _ls.set('inkColor', INK.color); if (INK.tool === 'eraser' || INK.tool === 'lasso') INK.setTool('pen'); else INK.paintBars(); paintAll(); } } });
    return h('label.lab-fan-item.lab-addc', { title: it.label, style: it.style }, picEl('plus'), inp);
  }
  function pillEl(name, pane, host) {
    var def = PILLS[name], open = !!(LP.open && LP.open.name === name && LP.open.doc === pane.docId), items = open ? pillItems(name, pane) : [];
    var bw = host.clientWidth || 800, bh = host.clientHeight || 600, sz = 44, pp = LP.pos[name], side = def.side, vert = 'up', style = null;
    if (pp && isFinite(+pp.fx) && isFinite(+pp.fy)) {
      var left = Math.round(Math.max(0, Math.min(bw - sz, pp.fx * bw - sz / 2))), top = Math.round(Math.max(0, Math.min(bh - sz, pp.fy * bh - sz / 2)));
      style = { left: left + 'px', top: top + 'px', right: 'auto', bottom: 'auto' }; side = left + sz / 2 > bw / 2 ? 'right' : 'left'; vert = top + sz / 2 < Math.min(bh / 2, 240) ? 'down' : 'up';
    }
    var hm = handNow(), face;
    if (name === 'hand') face = pic(hm === 'zoom' ? 'magnifying-glass' : hm === 'move' ? 'hand' : hm === 'hl' ? 'highlighter' : hm === 'lasso' ? 'lasso' : 'pencil');
    else if (name === 'view') face = '<span class="lab-pill-glyph">' + def.icon + '</span>';
    else face = '<span class="lab-pill-glyph">' + def.icon + '</span>';
    var b = h('button.lab-pill-btn', { type: 'button', title: def.label + ' (drag to move)', 'aria-label': def.label, 'aria-expanded': String(!!open) });
    b.innerHTML = face + (name === 'hand' && /^(pen|hl|eraser)$/.test(hm) ? '<span class="lab-pill-dot' + (hm === 'hl' ? ' hl' : '') + (hm === 'eraser' ? ' er' : '') + '" style="background:' + (hm === 'eraser' ? '#fff' : INK.swatch(INK.COLORS[INK.color])) + '"></span>' : '')
      + (name === 'view' ? '<span class="lab-pill-pct">' + Math.round((pane.paper ? pane.paper.view.z : 1) * 100) + '%</span>' : '')
      + (name === 'tools' && TIMER.activeFor(pane.docId) ? '<span class="lab-pill-live"></span>' : '');
    var cap = h('span.lab-fan-cap');
    var fan = h('div.lab-fan', items.map(function (it, i) {
      var p = fanPos(i, items.length, side, vert), st = { '--tx': p.x + 'px', '--ty': p.y + 'px', '--d': (i * 14) + 'ms' };
      if (it.addColour) return addColourItem({ label: it.label, style: st });
      var el = h('button.lab-fan-item' + (it.sel ? '.sel' : '') + (it.mode ? '.mode' : ''), { type: 'button', title: it.label, 'aria-label': it.label, style: st,
        on: { pointerenter: function () { cap.textContent = it.label; }, pointerleave: function () { cap.textContent = ''; },
          click: function (e) { e.stopPropagation(); try { it.run(el); } catch (x) { warn('pill', x); } if (!it.keep) { LP.open = null; } paintAll(); } } });
      if (it.dot) el.innerHTML = '<span class="lab-fan-dot' + (it.hl ? ' hl' : '') + '" style="background:' + it.dot + '"></span>';
      else if (it.bar) el.innerHTML = '<span class="lab-fan-bar" style="height:' + it.bar + 'px"></span>';
      else if (it.eraser) el.innerHTML = '<span class="lab-fan-eraser"></span>';
      else el.innerHTML = it.icon;
      return el;
    }), open ? cap : null);
    var pill = h('div.lab-pill.lab-pill-' + name + (open ? '.open' : '') + (name === 'hand' && /^(zoom|move|lasso|eraser)$/.test(hm) ? '.on' : ''), { 'data-pill': name, 'data-side': side, 'data-vert': vert, style: style || {} }, b, fan);
    bindPill(pill, b, name, pane, host);
    if (open) requestAnimationFrame(function () { pill.classList.add('fanned'); });
    return pill;
  }
  function bindPill(pill, b, name, pane, host) {
    b.addEventListener('pointerdown', function (e) {
      if (e.button !== 0) return;
      e.stopPropagation();
      var r = host.getBoundingClientRect(), pr = pill.getBoundingClientRect(), ox = e.clientX - pr.left, oy = e.clientY - pr.top, sx = e.clientX, sy = e.clientY, dragging = false;
      try { b.setPointerCapture(e.pointerId); } catch (x) {}
      function mv(ev) {
        if (!dragging && Math.hypot(ev.clientX - sx, ev.clientY - sy) < 6) return;
        dragging = true; pill.classList.add('dragging');
        pill.style.left = Math.max(0, Math.min(r.width - pr.width, ev.clientX - r.left - ox)) + 'px'; pill.style.top = Math.max(0, Math.min(r.height - pr.height, ev.clientY - r.top - oy)) + 'px'; pill.style.right = 'auto'; pill.style.bottom = 'auto';
      }
      function up() {
        b.removeEventListener('pointermove', mv); b.removeEventListener('pointerup', up); b.removeEventListener('pointercancel', up); pill.classList.remove('dragging');
        if (!dragging) return;
        LP.suppress = Date.now();
        var L = parseFloat(pill.style.left) || 0, T = parseFloat(pill.style.top) || 0;
        LP.pos[name] = { fx: Math.round((L + pr.width / 2) / r.width * 1000) / 1000, fy: Math.round((T + pr.height / 2) / r.height * 1000) / 1000 }; _ls.set('lab:pills', LP.pos);
        paintAll();
      }
      b.addEventListener('pointermove', mv); b.addEventListener('pointerup', up); b.addEventListener('pointercancel', up);
    });
    b.addEventListener('click', function (e) {
      e.stopPropagation();
      if (Date.now() - LP.suppress < 400) return;
      var toggle = function () { LP.open = LP.open && LP.open.name === name && LP.open.doc === pane.docId ? null : { name: name, doc: pane.docId }; paintAll(); };   // keyed to the note: a re-render makes a new host
      if (name !== 'hand') return toggle();
      if (LP.tap) { clearTimeout(LP.tap); LP.tap = null; LP.open = null; lastHand(); return; }   // a double tap: the last mode
      LP.tap = setTimeout(function () { LP.tap = null; toggle(); }, 230);
    });
  }
  function paintPills(pane) {
    var host = pane && pane.host; if (!host || !host.isConnected || !pane.paper || !M.doc(pane.docId)) return;
    var box = $(':scope > .lab-pills', host);
    if (!box) { box = h('div.lab-pills.nopan'); host.append(box); bindZoomHand(pane, host); }
    trackHand();
    host.classList.toggle('lab-hand-zoom', LP.zoom); host.classList.toggle('lab-hand-move', handNow() === 'move');
    box.classList.toggle('fan-open', !!(LP.open && LP.open.doc === pane.docId));
    box.replaceChildren.apply(box, ['insert', 'tools', 'hand', 'view'].map(function (n) { return pillEl(n, pane, host); }));
  }
  function paintAll() { try { App.panes().forEach(paintPills); } catch (e) { warn('pills', e); } }
  LAB.paintPills = paintAll; LAB.setHand = setHand; LAB.handNow = handNow;
  /* the zoom hand: a tap zooms in ×1.5 at the point (Alt / Shift / right button: out); a drag up or down zooms smoothly */
  function bindZoomHand(pane, host) {
    host.addEventListener('pointerdown', function (e) {
      if (!LP.zoom || e.pointerType === 'pen' || e.target.closest('.lab-pills,.dock,.ctools,.insp,.ink-bar,.ink-selbar,.pop,.hint,button,input,textarea,select,a')) return;
      var P = host._dv && host._dv.paper; if (!P) return;
      e.preventDefault(); e.stopPropagation();
      var y0 = e.clientY, x0 = e.clientX, z0 = P.view.z, moved = 0, out = e.altKey || e.shiftKey || e.button === 2;
      function mv(ev) { moved = Math.max(moved, Math.abs(ev.clientY - y0)); if (moved > 4) P.zoomAt(z0 * Math.exp(-(ev.clientY - y0) * 0.01), x0, y0); }
      function up() { removeEventListener('pointermove', mv, true); removeEventListener('pointerup', up, true); removeEventListener('pointercancel', up, true); if (moved <= 4) P.zoomAt(P.view.z * (out ? 1 / 1.5 : 1.5), x0, y0); }
      addEventListener('pointermove', mv, true); addEventListener('pointerup', up, true); addEventListener('pointercancel', up, true);
    }, true);
    host.addEventListener('contextmenu', function (e) { if (LP.zoom && !e.target.closest('.lab-pills')) e.preventDefault(); }, true);
  }
  try {
    var oDocRender11 = DocView.render;
    DocView.render = function (docId) { var r = oDocRender11.apply(this, arguments), pane = this; requestAnimationFrame(function () { paintPills(pane); }); return r; };
    var oPaint = INK.paintBars; INK.paintBars = function () { var r = oPaint.apply(INK, arguments); paintAll(); return r; };
    // the zoom % under ⊕ follows every pan and zoom
    var oApply = Paper.prototype.apply;
    Paper.prototype.apply = function () { var r = oApply.apply(this, arguments); try { var host = this.el.parentNode, pct = host && host.querySelector && host.querySelector(':scope > .lab-pills .lab-pill-pct'); if (pct) pct.textContent = Math.round(this.view.z * 100) + '%'; } catch (e) {} return r; };
    document.addEventListener('pointerdown', function (e) { if (LP.open && !(e.target.closest && e.target.closest('.lab-pills'))) { LP.open = null; paintAll(); } }, true);
    var oTimerPaint = TIMERUI.paint; TIMERUI.paint = function () { var r = oTimerPaint.apply(TIMERUI, arguments); if (LP.open && LP.open.name === 'tools') paintAll(); return r; };
  } catch (e) { warn('pills', e); }
  try {
    var st11 = document.getElementById('lab-mode-css');
    if (st11) st11.textContent += '.lab-pills{position:absolute;inset:0;pointer-events:none;z-index:18}.lab-pill{position:absolute;width:44px;height:44px;pointer-events:auto}' +
      '.lab-pill-insert{left:14px;top:calc(50% - 84px)}.lab-pill-tools{left:14px;top:calc(50% - 28px)}.lab-pill-hand{left:14px;top:calc(50% + 28px)}.lab-pill-view{right:14px;top:calc(50% + 28px)}' +
      '.lab-pills.fan-open .lab-pill:not(.open){opacity:.22;pointer-events:none}.lab-pill.open{z-index:3}.canvas-host .insp.open ~ .lab-pills .lab-pill-view:not([style*="left"]){right:344px}' +
      '.lab-pill-btn{position:relative;z-index:2;width:44px;height:44px;border-radius:50%;border:1px solid var(--rule-2);background:var(--surface);color:var(--ink);box-shadow:0 1px 2px rgba(36,33,28,.08),0 6px 18px -10px rgba(36,33,28,.45);cursor:pointer;display:grid;place-items:center;padding:0;touch-action:none;font:600 19px/1 var(--f-d,system-ui)}' +
      '.lab-pill-btn svg{width:20px;height:20px;pointer-events:none}.lab-pill-glyph{pointer-events:none}.lab-pill.open .lab-pill-btn{background:var(--ink);color:var(--paper);border-color:var(--ink)}' +
      '.lab-pill.on:not(.open) .lab-pill-btn{box-shadow:0 0 0 3px color-mix(in srgb,var(--teal) 30%,transparent)}.lab-pill.dragging .lab-pill-btn{transform:scale(1.06);box-shadow:0 10px 26px -8px rgba(36,33,28,.6)}' +
      '.lab-pill-dot{position:absolute;right:-2px;top:-2px;width:14px;height:14px;border-radius:50%;border:2px solid var(--surface);box-sizing:border-box}.lab-pill-dot.hl{opacity:.6}.lab-pill-dot.er{border-color:var(--ink-3)}' +
      '.lab-pill-pct{position:absolute;left:50%;bottom:-17px;transform:translateX(-50%);font:600 10px/16px var(--f-m,monospace);color:var(--ink-3);white-space:nowrap;pointer-events:none}' +
      '.lab-pill-live{position:absolute;right:0;top:0;width:10px;height:10px;border-radius:50%;background:var(--teal);border:2px solid var(--surface)}' +
      '.lab-fan{position:absolute;left:22px;top:22px;width:0;height:0}' +
      '.lab-fan-item{position:absolute;left:-18px;top:-18px;width:36px;height:36px;border-radius:50%;border:1px solid var(--rule-2);background:var(--surface);color:var(--ink);box-shadow:0 2px 8px -4px rgba(36,33,28,.5);display:grid;place-items:center;padding:0;cursor:pointer;font:500 15px/1 var(--f-d,system-ui);transform:translate(0,0) scale(.4);opacity:0;transition:transform .22s cubic-bezier(.2,.9,.3,1.2) var(--d,0ms),opacity .16s var(--d,0ms);touch-action:manipulation}' +
      '.lab-fan-item svg{width:17px;height:17px;pointer-events:none}.lab-pill.fanned .lab-fan-item{transform:translate(var(--tx),var(--ty)) scale(1);opacity:1}.lab-fan-item:hover{border-color:var(--ink-3)}' +
      '.lab-fan-item.sel{background:var(--ink);color:var(--paper);border-color:var(--ink)}.lab-fan-item.mode{width:38px;height:38px;left:-19px;top:-19px}' +
      '.lab-fan-dot{width:18px;height:18px;border-radius:50%;display:block;border:1px solid rgba(0,0,0,.15)}.lab-fan-dot.hl{opacity:.55}.lab-fan-item.sel .lab-fan-dot{box-shadow:0 0 0 2px var(--paper)}' +
      '.lab-fan-bar{display:block;width:20px;border-radius:3px;background:currentColor}.lab-fan-eraser{display:block;width:16px;height:16px;border-radius:50%;border:1.5px solid currentColor}' +
      '.lab-addc{overflow:hidden}.lab-addc input{position:absolute;inset:0;opacity:0;cursor:pointer;width:100%;height:100%}.lab-insic{font-size:16px;line-height:1}.lab-100{font:700 10px/1 var(--f-m,monospace)}' +
      '.lab-pr{font:700 12px/1 var(--f-m,monospace)}' +
      '.lab-fan-cap{position:absolute;left:30px;top:-60px;white-space:nowrap;font:500 11px/18px var(--f-d,system-ui);color:var(--ink-2);background:var(--surface);border:1px solid var(--rule-2);border-radius:999px;padding:0 8px;pointer-events:none}' +
      '.lab-fan-cap:empty{display:none}.lab-pill[data-side="right"] .lab-fan-cap{left:auto;right:30px}.lab-pill[data-vert="down"] .lab-fan-cap{top:30px}' +
      '.canvas-host.lab-hand-zoom .paper{cursor:zoom-in}' +
      '';
  } catch (e) { warn('css 11', e); }

  /* ---- 12. The one recorder in a note (V3.884, R1 of CodeLog/ClaudesPlan/V3.884_one_recorder_program.md) ----
     Gabe's Recording component (13zn) gains what RM's board recorder has, on the web: the audio goes to the lab's
     cloud a part a minute while it records (api/rec/part — a closed tab loses at most a minute, and a recording
     may run past the 30 MB single-file cap), joined at Stop (api/rec/compose); an interrupted one is recovered from
     its parts. Marks gain kinds (important · question · decision · to do, rm/js/recorder-core.js) and sections, in
     Gabe's own `marks` list (his ◆ bookmarks read as important). Ink drawn in the note while it records is stamped
     with its moment (stroke.rt = [recId, t0, t1], audio seconds) for the replay. His desktop keeps its own recorder
     and Whisper. Speech-to-text in the cloud comes on a button that shows its cost first (R3). */
  var LR = { cur: null, timer: null, penT0: null, sent: [], stamped: 0 };
  LAB.recorder = LR;
  function rcore() { return window.RECORDER_CORE || null; }
  try { if (!window.RECORDER_CORE) { var rcs = document.createElement('script'); rcs.src = '/rm/js/recorder-core.js?v=' + encodeURIComponent(LAB.version); document.head.appendChild(rcs); } } catch (e) { warn('recorder core', e); }
  function partsStart(a) {
    if (!a || (LR.cur && LR.cur.id === a.id)) return;
    LR.cur = { id: a.id, n: 0, sent: 0, ext: a.ext || 'webm', mime: a.mime || 'audio/webm', q: Promise.resolve(), a: a, failed: 0 };
    clearInterval(LR.timer); LR.timer = setInterval(function () { sendPart(); }, (rcore() && rcore().PART_MS) || 60000);
  }
  /** The audio recorded since the last part, as the next part (one at a time, in order). */
  function sendPart() {
    var P = LR.cur; if (!P) return Promise.resolve(false);
    P.q = P.q.then(async function () {
      var chunks = P.a.chunks || [], end = chunks.length; if (end <= P.sent) return true;
      var blob = new Blob(chunks.slice(P.sent, end), { type: P.mime });
      try {
        var r = await fetch('api/rec/part?rid=' + encodeURIComponent(P.id) + '&n=' + P.n + '&ext=' + encodeURIComponent(P.ext), { method: 'POST', body: blob, headers: { 'Content-Type': 'application/octet-stream' } });
        var j = r.ok ? await r.json() : null; if (!j || !j.ok) throw new Error((j && j.error) || ('HTTP ' + r.status));
        P.sent = end; P.n++; LR.sent.push({ id: P.id, n: P.n - 1, bytes: blob.size });
        REC.put(P.id, function (rr) { rr.parts = P.n; rr.partsExt = P.ext; });
        return true;
      } catch (e) { P.failed++; warn('recording part', e); return false; }
    });
    return P.q;
  }
  async function composeParts(id, name, ext) {
    try {
      var r = await fetch('api/rec/compose?rid=' + encodeURIComponent(id) + '&ext=' + encodeURIComponent(ext) + '&name=' + encodeURIComponent(name), { method: 'POST' });
      var j = r.ok ? await r.json() : null; return j && j.ok ? j : null;
    } catch (e) { warn('recording compose', e); return null; }
  }
  function savedFromParts(id, j) {
    REC.put(id, function (rr) { rr.state = 'queued'; rr.file = j.file; rr.path = j.path; rr.bytes = j.bytes; rr.local = false; rr.parts = 0; });
    try { DB.del('blobs', 'rec:' + id); } catch (e) {}
    toast('Recording saved · recordings/' + j.file, 3500); REC.watch(id);
  }
  try {
    var oRecStart = REC.start;
    REC.start = async function (b) { var r = await oRecStart.apply(REC, arguments); try { if (REC.active && b && REC.active.id === b.id) partsStart(REC.active); } catch (e) { warn('recording parts', e); } return r; };
    var oRecUpload = REC.upload;
    REC.upload = async function (id, blob) {
      var P = LR.cur;
      if (!P || P.id !== id) return oRecUpload.apply(REC, arguments);
      clearInterval(LR.timer); LR.timer = null;
      if (!P.n) { LR.cur = null; return oRecUpload.apply(REC, arguments); }      // under a minute: one file, as before
      await sendPart(); LR.cur = null;                                              // the last part
      var b = M.block(id), j = P.sent >= (P.a.chunks || []).length ? await composeParts(id, b ? REC.fileBase(b) : 'recording', P.ext) : null;
      if (!j) return oRecUpload.apply(REC, arguments);                              // the whole file, or kept on this device, as before
      savedFromParts(id, j); return true;
    };
  } catch (e) { warn('recording upload', e); }
  /** An interrupted recording (a closed tab, a crash): what reached the cloud becomes the recording. */
  async function recoverParts(id) {
    var b = M.block(id); if (!b) return null; var r = REC.r(b);
    var j = await composeParts(id, REC.fileBase(b), r.partsExt || r.ext || 'webm');
    if (!j) { toast('Nothing could be recovered for this recording'); return null; }
    REC.put(id, function (rr) { rr.paused = false; rr.dur = rr.dur || (rr.parts || 0) * 60; });
    savedFromParts(id, j); changed(); return j;
  }
  LAB.sendPart = sendPart; LAB.recoverParts = recoverParts;

  /* marks with kinds and sections, at the moment recording or playing */
  function recNow(id) { var a = REC.active; if (a && a.id === id) return REC.elapsed(); if (REC.player && REC.player.id === id) return REC.player.audio.currentTime; return null; }
  function markKind(id, kind) {
    var C = rcore(), t = recNow(id); if (!C) { toast('One moment — try again'); return; } if (t == null) { toast('Play it first, then mark'); return; }
    REC.put(id, function (r) { r.marks = C.addMark(r.marks, { t: t, kind: kind }); }); changed();
    toast(C.KIND[C.kindOf(kind)].glyph + ' ' + C.KIND[C.kindOf(kind)].label + ' at ' + C.mmss(t));
  }
  function sectionToggle(id) {
    var C = rcore(), t = recNow(id); if (!C) { toast('One moment — try again'); return; } if (t == null) { toast('Play it first, then mark'); return; }
    var open = C.openOf(REC.r(M.block(id)).marks || []);
    REC.put(id, function (r) { r.marks = C.toggleSection(r.marks, t, 'important'); }); changed();
    toast(open ? 'Section ended — ' + C.mmss(t - open.t) + ' long' : 'Important section started — press again to end it');
  }
  LAB.markKind = markKind; LAB.sectionToggle = sectionToggle;
  function decorateRec(el, b, ro) {
    var C = rcore(), cur = M.block(b.id) || b, r = REC.r(cur), live = !!(REC.active && REC.active.id === b.id), dur = r.dur || 0, has = r.state !== 'new' && r.state !== 'recording';
    if (!el || !el.querySelector) return;
    if (C && !ro && (live || (has && (r.file || r.path || REC.blobs.has(b.id))))) {
      var open = C.openOf(r.marks || []);
      var row = h('div.lab-rc-kinds.nopan', { title: live ? 'Mark this moment' : 'Mark the moment playing now' },
        C.MARK_KINDS.map(function (k) { return h('button.btn.xs', { 'data-kind': k.id, title: 'Mark: ' + k.label + (k.id === 'important' ? ' (Alt+M)' : ''), on: { click: function (e) { e.stopPropagation(); markKind(b.id, k.id); } } }, k.glyph + ' ' + k.label); }),
        h('button.btn.xs' + (open ? '.on' : ''), { 'data-section': open ? 'open' : '', title: open ? 'End the important section' : 'Start an important section (press again to end it)', on: { click: function (e) { e.stopPropagation(); sectionToggle(b.id); } } }, open ? '⟧ End section' : '⟦ Section'));
      var bar = el.querySelector('.rc-bar'); if (bar) bar.after(row);
    }
    // the marks list says what each one is; a section shows its span
    if (C) {
      var ms = r.marks || [];
      [].forEach.call(el.querySelectorAll('.rc-mk'), function (mk, i) {
        var m = ms[i]; if (!m) return; var k = C.KIND[C.kindOf(m.kind)], tb = mk.querySelector('.rc-mt');
        mk.classList.add('lab-k-' + k.id);
        if (tb) tb.textContent = k.glyph + ' ' + C.mmss(m.t) + (m.end === null ? ' → …' : typeof m.end === 'number' ? ' → ' + C.mmss(m.end) : '');
      });
      var prog = el.querySelector('.rc-prog');
      if (prog && dur && !live) ms.filter(function (m) { return typeof m.end === 'number'; }).forEach(function (m) {
        prog.append(h('b.lab-rc-band', { style: { left: (100 * m.t / dur) + '%', width: Math.max(0.5, 100 * (m.end - m.t) / dur) + '%' }, title: C.markLabel(m) + ' · ' + C.mmss(m.t) + '–' + C.mmss(m.end) })); });
    }
    var st = el.querySelector('.rc-status');
    if (st && r.state === 'saved') { st.className = 'rc-status lab-rc-saved'; st.replaceChildren(h('span', 'Saved in the lab’s cloud' + (r.bytes ? ' (' + REC.kb(r.bytes) + ')' : '') + '.'), h('span.tiny.muted', ' Speech-to-text in the cloud comes next — it will show its cost before it runs; the desktop app transcribes it for free.')); }
    if (st && !live && (r.state === 'recording' || r.state === 'saving') && (r.parts || 0) > 0) {
      st.after(h('div.callout.lab-rc-recover', h('b.h', 'This recording was interrupted'), 'About ' + plural(r.parts, 'minute') + ' reached the lab’s cloud before it stopped. ',
        ro ? null : h('button.btn.xs.pri', { on: { click: function (e) { e.stopPropagation(); e.currentTarget.disabled = true; recoverParts(b.id); } } }, 'Recover them')));
    }
    var n = 0;
    try { INK.blocks(cur.docId).forEach(function (ib) { ((ib.ink && ib.ink.strokes) || []).forEach(function (s) { if (Array.isArray(s.rt) && s.rt[0] === b.id) n++; }); }); } catch (e) {}
    if (n) el.append(h('div.lab-rc-ink.tiny.muted', '✎ ' + plural(n, 'stroke') + ' drawn while recording — each one is timed with the voice'));
  }
  try {
    var oRecBody = WIDGETS.rec.body;
    WIDGETS.rec.body = function (b, d, pane, ro) { var el = oRecBody.apply(this, arguments); try { decorateRec(el, b, ro); } catch (e) { warn('recording card', e); } return el; };
  } catch (e) { warn('recording card', e); }

  /* ink drawn in the note while it records carries its moment */
  try {
    var oPenDown = INK.penDown;
    INK.penDown = function () { if (REC.active) LR.penT0 = REC.elapsed(); return oPenDown.apply(INK, arguments); };
    var oAddStroke = INK.addStroke;
    INK.addStroke = function (pane, s) {
      var a = REC.active, C = rcore();
      if (a && C && LR.penT0 != null && s && pane && (M.block(a.id) || {}).docId === pane.docId) { s = C.stamp(s, a.id, LR.penT0, REC.elapsed()); LR.stamped++; }
      LR.penT0 = null;
      return oAddStroke.call(INK, pane, s);
    };
  } catch (e) { warn('ink moments', e); }
  try {
    var st12 = document.getElementById('lab-mode-css');
    if (st12) st12.textContent += '.lab-rc-kinds{display:flex;flex-wrap:wrap;gap:4px;margin:4px 0 2px}.lab-rc-kinds .btn.on{background:var(--teal-soft);color:var(--teal)}' +
      '.rc-prog{position:relative}.lab-rc-band{position:absolute;top:0;bottom:0;background:color-mix(in srgb,var(--teal) 28%,transparent);border-radius:2px;pointer-events:auto}' +
      '.rc-mk.lab-k-question .rc-mt{color:#B5761B}.rc-mk.lab-k-decision .rc-mt{color:#4A5651}.rc-mk.lab-k-todo .rc-mt{color:#1E5E8C}.lab-rc-recover{margin:6px 0}.lab-rc-ink{margin-top:4px}';
  } catch (e) { warn('css 12', e); }
})();
