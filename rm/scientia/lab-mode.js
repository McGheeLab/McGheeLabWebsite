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
     Lit reviews  a tab of review canvases linked to any number of projects (V3.889, section 13).
     PDFs       a PDF card draws only while on screen, as sharp as the zoom needs, and survives a canvas rebuild (V3.894, section 14).

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
  var LAB = { version: 'V3.901', RM: RM, opened: [], openRM: openRM, refresh: refreshLibrary };
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
    return DB.where('documents', function (d) { return !d.projectId && !d.deleted && ['day', 'review'].indexOf(d.type) < 0 && !isReview(d); });
  }
  function regionList() {
    var all = DB.all('projects'), byName = function (a, b) { return String(a.name || '').localeCompare(String(b.name || '')); };
    var ps = all.filter(function (p) { return !sharedFrom(p); });   /* V3.899 — a project someone shared with you has its own group */
    var out = ps.filter(isAssigned).sort(function (a, b) { return rank(a) - rank(b) || byName(a, b); }).map(function (p) { return { id: p.id, p: p, group: 'assigned' }; });
    out.push({ id: 'quick', group: 'quick' });
    ps.filter(function (p) { return !p.rm; }).sort(function (a, b) { return String(a.created || '').localeCompare(String(b.created || '')); }).forEach(function (p) { out.push({ id: p.id, p: p, group: 'mine' }); });
    all.filter(function (p) { return !!sharedFrom(p); }).sort(byName).forEach(function (p) { out.push({ id: p.id, p: p, group: 'shared' }); });
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
    var revs = reviewsOf(p.id); if (revs.length) cols.push({ name: 'Lit reviews', docs: revs, review: true });   /* V3.889 */
    return h('div.lab-reg-b', cols.map(function (c) {
      var H = c.t ? IX.themeHealth(c.t) : null;
      return h('div.lab-col',
        c.t ? h('div.box.tcard.nopan', { on: { click: function () { App.go('#/theme/' + c.t.id); } } }, h('div.tn', c.name),
          c.t.rm && c.t.question ? h('div.lab-q', snippet(c.t.question, 110)) : null,
          h('div.ts', H.stalled ? h('span.pill.warn', 'stalled ' + H.days + 'd') : H.aims.length ? h('span.pill.teal', plural(H.aims.length, 'aim')) : h('span.pill', c.t.rm ? 'aim in RM' : 'exploratory'), ' ', fmtDur(H.ms4) + ' / 4 wk',
            H.openB.length ? h('span', { style: { color: 'var(--bad)' } }, ' · ' + plural(H.openB.length, 'open barrier')) : null),
          heatmapEl({ weeks: 6, themeId: c.t.id, cell: 7 }))
          : h('div.lab-col-h.mono.muted', c.name),
        c.docs.sort(byModified).map(function (d) { return c.review ? docCard(d, reviewLine(d)) : docCard(d); }),
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
      var from = sharedFrom(p), kick = from ? 'Shared by ' + (from.name || 'a lab member') + (from.role === 'edit' ? ' · you work on it together' : ' · read only')
        : p.rm ? [KIND[p.rmKind] || words(p.rmKind) || 'Project', p.rmStatus ? words(p.rmStatus) : null, r.group === 'earlier' ? 'no longer assigned' : 'assigned' + (p.rmRole && p.rmRole !== 'member' ? ' · ' + p.rmRole : '')].filter(Boolean).join(' · ') : 'Project';
      head = [h('div.pk', kick), h('a.pn', { href: '#/project/' + p.id, title: 'Open the project' }, p.name),
        h('div.ps', plural(themes.length, 'theme') + ' · ' + plural(notes, 'note') + (reviewsOf(p.id).length ? ' · ' + plural(reviewsOf(p.id).length, 'lit review') : '') + ' · ' + plural(IX.openBarriers(p.id).length, 'open barrier')),
        p.rm && (p.rmLine || (p.rmParents || []).length) ? h('div.lab-reg-line', p.rmLine ? h('span.serif', snippet(p.rmLine, 140)) : null,
          (p.rmParents || []).length ? h('span.tiny.muted', (p.rmLine ? ' · ' : '') + 'builds on ' + p.rmParents.join(', ')) : null) : null];
      if (!from || from.role === 'edit') acts.push(btn('xs', '+ Note', function () { App.newDoc({ projectId: p.id }); }, 'A new note in this project'));
      if (p.rm && p.rmUrl) acts.push(btn('xs', 'Open in RM', function () { openRM(p.rmUrl); }, 'This ' + (KIND[p.rmKind] || 'project').toLowerCase() + ' on the lab site'));
      acts.push(shareBtn('project', p));   /* V3.899 — top right of the card */
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
        var revs = p ? reviewsOf(p.id) : [];   /* V3.889 — the literature reviews linked to it */
        if (revs.length && page && page.querySelector) {
          var sec = h('div.lab-pv-lr', h('div.sec-h', h('h2', 'Literature reviews'), h('span.k', plural(revs.length, 'review') + ' linked to this project')),
            h('div.lab-lr-grid', revs.map(reviewCard)));
          var anchor = page.querySelector('.lab-rm-proj') || page.querySelector('p.stand');
          if (anchor) anchor.after(sec); else page.append(sec);
        }
      } catch (x) { warn('project view', x); }
      return page;
    };
  } catch (e) { warn('project view', e); }

  /* who reads a note filed under RM work — only its owner (the default) or every lab member. The hub lists it on its
     card / project in RM accordingly (scientiaNotes, V3.880); a change here asks the hub for that list at once. */
  var NOTE_SIG = {};
  LAB.noteSig = NOTE_SIG;
  function rmLinked(d) { var p = d && d.projectId && M.project(d.projectId); return !!(p && p.rm) || reviewProjects(d).some(function (x) { return x.rm; }); }
  function noteSig(d) { return [d.projectId || '', d.themeId || '', d.share || '', d.title || '', d.deleted ? 1 : 0, isReview(d) ? 'R' + (d.review.projectIds || []).join(',') : ''].join('|'); }
  function seedSig(d) { if (d && d.id && NOTE_SIG[d.id] === undefined) NOTE_SIG[d.id] = noteSig(d); }
  try {
    var oPut10 = DB.put;
    DB.put = function (store, rec) {
      var r = oPut10.apply(this, arguments);
      try {
        if (store === 'documents' && rec && rec.id && !(typeof SYNC !== 'undefined' && (SYNC.applying || SYNC.loading))) {
          var sig = noteSig(rec), was = NOTE_SIG[rec.id]; NOTE_SIG[rec.id] = sig;
          var fresh = was === undefined && Date.now() - +new Date(rec.created || 0) < 120000;
          if ((fresh || (was !== undefined && was !== sig)) && (rmLinked(rec) || /(^|[|,R])rm-/.test(String(was || '')))) kickRm(['notes']);
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
    if (sharedFrom(d)) return copyFields(d);   /* V3.899 — someone else's note, shared with you */
    if (isReview(d)) return reviewFields(d);   /* V3.889 — a literature review's own first block */
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
      '.lab-h-share{grid-template-columns:86px 1fr}.lab-h-share .lab-share{margin-left:0}.lab-h-share .lab-share>.tiny{display:none}' +
      '.lab-share{display:inline-flex;align-items:center;gap:6px;margin-left:10px}.lab-share .seg button{height:20px;font-size:11px;padding:0 7px}.lab-file{flex:none}' +
      '.lab-rm-proj{margin:10px 0}@media (max-width:820px){.lab-reg-a{max-width:150px}}';
  } catch (e) { warn('css 10', e); }

  /* ---- 11. The canvas pills in a note (V3.882) ----
     The Lab Notebook's four movable pills (whiteboard.js V3.837–V3.863) on every Scientia note, driving Scientia's own
     tools — nothing copied: ✎ the hand (zoom · move · pen · highlighter · lasso; the second arc is the mode's options),
     ＋ Insert (the most used of INSERTS; More… = Gabe's whole list), ✦ Tools (timer, calculator, equation, Gabe's ink
     bar, focus mode), ⊕ View (in · 100 % · out · fit, the zoom % under it). The hand IS Gabe's ink state — pen /
     highlighter / lasso / eraser = INK.tool with INK.mouse on; move = INK.mouse off (the paper pans, components drag);
     zoom = ours (a tap zooms ×1.5 at the point, Alt: out, Shift: fit the component or region under it, its edge lit
     while Shift is held; a drag up or down zooms smoothly) — read back on every
     paint, so his ink bar and the pill never disagree. A pill drags anywhere (fractions of the note's area, _ls
     lab:pills); the fan opens away from the nearest edges; a tap outside closes it; a double tap on ✎ = the last mode.
     V3.896 (Alex's wishlist, CodeLog/ClaudesPlan/V3.896_scientia_pills_quick_cast_docks.md) — each wheel has its place
     and a docked form: ＋ is the **Quick cast** (the inserts the person chose — a bolt toggle on every row of Gabe's
     + Insert list), centred just above the bottom bar; ⊕ zoom top left; ✦ tools top right; ✎ the hand bottom right.
     A Quick cast / tools / zoom fan LEFT OPEN for 10 s rolls into its docked form — a row above the bottom bar, a row
     at the top right, a column down the left — and stays (per device, _ls lab:docked) until its pill is tapped. Pen
     options left the tools wheel: the hand's fan has a cog that opens Gabe's ink bar (top left; his palettes with ⊕,
     widths, eraser, fill, pressure), which stays open until hidden. Positions moved to _ls lab:pills2.
     V3.897 (Alex): the Quick cast is built INTO the bottom bar — a slot in the middle of Gabe's dock (re-added after
     every renderDock) with the pill drawn over it (the dock scrolls sideways, so the fan cannot live inside it); left
     open it docks as a row above the bar. ✦ replaces Gabe's top-right row (Split, Timer + head start, Calculator,
     Equation — Pen is ✎'s cog), which is hidden; ✦ takes that corner. */
  var PILL_ICONS = {"magnifying-glass": "<path stroke-linecap=\"round\" stroke-linejoin=\"round\" d=\"m21 21-5.197-5.197m0 0A7.5 7.5 0 1 0 5.196 5.196a7.5 7.5 0 0 0 10.607 10.607Z\"/>", "hand": "<path d=\"M18 11V6a2 2 0 0 0-2-2a2 2 0 0 0-2 2\" /><path d=\"M14 10V4a2 2 0 0 0-2-2a2 2 0 0 0-2 2v2\" /><path d=\"M10 10.5V6a2 2 0 0 0-2-2a2 2 0 0 0-2 2v8\" /><path d=\"M18 8a2 2 0 1 1 4 0v6a8 8 0 0 1-8 8h-2c-2.8 0-4.5-.86-5.99-2.34l-3.6-3.6a2 2 0 0 1 2.83-2.82L7 15\" />", "pencil": "<path stroke-linecap=\"round\" stroke-linejoin=\"round\" d=\"m16.862 4.487 1.687-1.688a1.875 1.875 0 1 1 2.652 2.652L6.832 19.82a4.5 4.5 0 0 1-1.897 1.13l-2.685.8.8-2.685a4.5 4.5 0 0 1 1.13-1.897L16.863 4.487Zm0 0L19.5 7.125\"/>", "highlighter": "<path d=\"m9 11-6 6v3h9l3-3\" /><path d=\"m22 12-4.6 4.6a2 2 0 0 1-2.8 0l-5.2-5.2a2 2 0 0 1 0-2.8L14 4\" />", "plus": "<path stroke-linecap=\"round\" stroke-linejoin=\"round\" d=\"M12 4.5v15m7.5-7.5h-15\"/>", "minus": "<path stroke-linecap=\"round\" stroke-linejoin=\"round\" d=\"M5 12h14\"/>", "home": "<path stroke-linecap=\"round\" stroke-linejoin=\"round\" d=\"m2.25 12 8.954-8.955c.44-.439 1.152-.439 1.591 0L21.75 12M4.5 9.75v10.125c0 .621.504 1.125 1.125 1.125H9.75v-4.875c0-.621.504-1.125 1.125-1.125h2.25c.621 0 1.125.504 1.125 1.125V21h4.125c.621 0 1.125-.504 1.125-1.125V9.75M8.25 21h8.25\"/>", "arrow-uturn-left": "<path stroke-linecap=\"round\" stroke-linejoin=\"round\" d=\"M9 15 3 9m0 0 6-6M3 9h12a6 6 0 0 1 0 12h-3\"/>", "arrow-uturn-right": "<path stroke-linecap=\"round\" stroke-linejoin=\"round\" d=\"m15 15 6-6m0 0-6-6m6 6H9a6 6 0 0 0 0 12h3\"/>", "x-mark": "<path stroke-linecap=\"round\" stroke-linejoin=\"round\" d=\"M6 18 18 6M6 6l12 12\"/>", "calculator": "<path stroke-linecap=\"round\" stroke-linejoin=\"round\" d=\"M15.75 15.75V18m-7.5-6.75h.008v.008H8.25v-.008Zm0 2.25h.008v.008H8.25V13.5Zm0 2.25h.008v.008H8.25v-.008Zm0 2.25h.008v.008H8.25V18Zm2.498-6.75h.007v.008h-.007v-.008Zm0 2.25h.007v.008h-.007V13.5Zm0 2.25h.007v.008h-.007v-.008Zm0 2.25h.007v.008h-.007V18Zm2.504-6.75h.008v.008h-.008v-.008Zm0 2.25h.008v.008h-.008V13.5Zm0 2.25h.008v.008h-.008v-.008Zm0 2.25h.008v.008h-.008V18Zm2.498-6.75h.008v.008h-.008v-.008Zm0 2.25h.008v.008h-.008V13.5ZM8.25 6h7.5v2.25h-7.5V6ZM12 2.25c-1.892 0-3.758.11-5.593.322C5.307 2.7 4.5 3.65 4.5 4.757V19.5a2.25 2.25 0 0 0 2.25 2.25h10.5a2.25 2.25 0 0 0 2.25-2.25V4.757c0-1.108-.806-2.057-1.907-2.185A48.507 48.507 0 0 0 12 2.25Z\"/>", "clock": "<path stroke-linecap=\"round\" stroke-linejoin=\"round\" d=\"M12 6v6h4.5m4.5 0a9 9 0 1 1-18 0 9 9 0 0 1 18 0Z\"/>", "arrows-pointing-out": "<path stroke-linecap=\"round\" stroke-linejoin=\"round\" d=\"M3.75 3.75v4.5m0-4.5h4.5m-4.5 0L9 9M3.75 20.25v-4.5m0 4.5h4.5m-4.5 0L9 15M20.25 3.75h-4.5m4.5 0v4.5m0-4.5L15 9m5.25 11.25h-4.5m4.5 0v-4.5m0 4.5L15 15\"/>", "squares-plus": "<path stroke-linecap=\"round\" stroke-linejoin=\"round\" d=\"M13.5 16.875h3.375m0 0h3.375m-3.375 0V13.5m0 3.375v3.375M6 10.5h2.25a2.25 2.25 0 0 0 2.25-2.25V6a2.25 2.25 0 0 0-2.25-2.25H6A2.25 2.25 0 0 0 3.75 6v2.25A2.25 2.25 0 0 0 6 10.5Zm0 9.75h2.25A2.25 2.25 0 0 0 10.5 18v-2.25a2.25 2.25 0 0 0-2.25-2.25H6a2.25 2.25 0 0 0-2.25 2.25V18A2.25 2.25 0 0 0 6 20.25Zm9.75-9.75H18a2.25 2.25 0 0 0 2.25-2.25V6A2.25 2.25 0 0 0 18 3.75h-2.25A2.25 2.25 0 0 0 13.5 6v2.25a2.25 2.25 0 0 0 2.25 2.25Z\"/>", "sparkles": "<path stroke-linecap=\"round\" stroke-linejoin=\"round\" d=\"M9.813 15.904 9 18.75l-.813-2.846a4.5 4.5 0 0 0-3.09-3.09L2.25 12l2.846-.813a4.5 4.5 0 0 0 3.09-3.09L9 5.25l.813 2.846a4.5 4.5 0 0 0 3.09 3.09L15.75 12l-2.846.813a4.5 4.5 0 0 0-3.09 3.09ZM18.259 8.715 18 9.75l-.259-1.035a3.375 3.375 0 0 0-2.455-2.456L14.25 6l1.036-.259a3.375 3.375 0 0 0 2.455-2.456L18 2.25l.259 1.035a3.375 3.375 0 0 0 2.456 2.456L21.75 6l-1.035.259a3.375 3.375 0 0 0-2.456 2.456ZM16.894 20.567 16.5 21.75l-.394-1.183a2.25 2.25 0 0 0-1.423-1.423L13.5 18.75l1.183-.394a2.25 2.25 0 0 0 1.423-1.423l.394-1.183.394 1.183a2.25 2.25 0 0 0 1.423 1.423l1.183.394-1.183.394a2.25 2.25 0 0 0-1.423 1.423Z\"/>", "pause": "<path stroke-linecap=\"round\" stroke-linejoin=\"round\" d=\"M15.75 5.25v13.5m-7.5-13.5v13.5\"/>", "play": "<path stroke-linecap=\"round\" stroke-linejoin=\"round\" d=\"M5.25 5.653c0-.856.917-1.398 1.667-.986l11.54 6.347a1.125 1.125 0 0 1 0 1.972l-11.54 6.347a1.125 1.125 0 0 1-1.667-.986V5.653Z\"/>", "eye": "<path stroke-linecap=\"round\" stroke-linejoin=\"round\" d=\"M2.036 12.322a1.012 1.012 0 0 1 0-.639C3.423 7.51 7.36 4.5 12 4.5c4.638 0 8.573 3.007 9.963 7.178.07.207.07.431 0 .639C20.577 16.49 16.64 19.5 12 19.5c-4.638 0-8.573-3.007-9.963-7.178Z\"/><path stroke-linecap=\"round\" stroke-linejoin=\"round\" d=\"M15 12a3 3 0 1 1-6 0 3 3 0 0 1 6 0Z\"/>", "variable": "<path stroke-linecap=\"round\" stroke-linejoin=\"round\" d=\"M4.745 3A23.933 23.933 0 0 0 3 12c0 3.183.62 6.22 1.745 9M19.5 3c.967 2.78 1.5 5.817 1.5 9s-.533 6.22-1.5 9M8.25 8.885l1.444-.89a.75.75 0 0 1 1.105.402l2.402 7.206a.75.75 0 0 0 1.104.401l1.445-.889m-8.25.75.213.09a1.687 1.687 0 0 0 2.062-.617l4.45-6.676a1.688 1.688 0 0 1 2.062-.618l.213.09\"/>", "bolt": "<path stroke-linecap=\"round\" stroke-linejoin=\"round\" d=\"m3.75 13.5 10.5-11.25L12 10.5h8.25L9.75 21.75 12 13.5H3.75Z\"/>", "cog": "<path stroke-linecap=\"round\" stroke-linejoin=\"round\" d=\"M9.594 3.94c.09-.542.56-.94 1.11-.94h2.593c.55 0 1.02.398 1.11.94l.213 1.281c.063.374.313.686.645.87.074.04.147.083.22.127.325.196.72.257 1.075.124l1.217-.456a1.125 1.125 0 0 1 1.37.49l1.296 2.247a1.125 1.125 0 0 1-.26 1.431l-1.003.827c-.293.241-.438.613-.43.992a7.723 7.723 0 0 1 0 .255c-.008.378.137.75.43.991l1.004.827c.424.35.534.955.26 1.43l-1.298 2.247a1.125 1.125 0 0 1-1.369.491l-1.217-.456c-.355-.133-.75-.072-1.076.124a6.47 6.47 0 0 1-.22.128c-.331.183-.581.495-.644.869l-.213 1.281c-.09.543-.56.94-1.11.94h-2.594c-.55 0-1.019-.398-1.11-.94l-.213-1.281c-.062-.374-.312-.686-.644-.87a6.52 6.52 0 0 1-.22-.127c-.325-.196-.72-.257-1.076-.124l-1.217.456a1.125 1.125 0 0 1-1.369-.49l-1.297-2.247a1.125 1.125 0 0 1 .26-1.431l1.004-.827c.292-.24.437-.613.43-.991a6.932 6.932 0 0 1 0-.255c.007-.38-.138-.751-.43-.992l-1.004-.827a1.125 1.125 0 0 1-.26-1.43l1.297-2.247a1.125 1.125 0 0 1 1.37-.491l1.216.456c.356.133.751.072 1.076-.124.072-.044.146-.086.22-.128.332-.183.582-.495.644-.869l.214-1.28Z\"/><path stroke-linecap=\"round\" stroke-linejoin=\"round\" d=\"M15 12a3 3 0 1 1-6 0 3 3 0 0 1 6 0Z\"/>", "split": "<path stroke-linecap=\"round\" stroke-linejoin=\"round\" d=\"M3.75 5.25h16.5v13.5H3.75zM12 5.25v13.5\"/>", "lasso": "<ellipse cx=\"12\" cy=\"10\" rx=\"8\" ry=\"5.5\" stroke-dasharray=\"2.6 2.4\"/><path stroke-linecap=\"round\" d=\"M9.5 15.2c-.6 1.8-.2 3.6 1.4 4.8\"/>"};
  /* V3.898 — every row of + Insert its own icon: Gabe's glyphs repeat (◍ ◍, ⤓ ⤓ ⤓, ∑ ∑, ▤ ▤ ▤, ▦ ▦, ▶ ▶). Used in his list,
     the Quick cast and the wire-drop menu; a row not named here keeps his glyph */
  Object.assign(PILL_ICONS, {"construction": "<path d=\"M3.75 7.5h16.5v5.25H3.75z\"/><path d=\"M6 12.75v7.5\"/><path d=\"M18 12.75v7.5\"/><path d=\"M8.25 7.5l-3 5.25\"/><path d=\"M13.5 7.5l-3 5.25\"/><path d=\"M18.75 7.5l-3 5.25\"/>", "books": "<path d=\"M3.75 20.25h16.5\"/><path d=\"M6.75 20.25V7.5a1.5 1.5 0 0 1 1.5-1.5h1.5a1.5 1.5 0 0 1 1.5 1.5v12.75\"/><path d=\"M6.75 9.75h4.5\"/><path d=\"M14.03 20.25 16.6 8.4a1.5 1.5 0 0 0-1.15-1.78l-1.1-.24\"/><path d=\"M13.2 10.2l3.6.78\"/>", "flask-conical": "<path d=\"M14 2v6a2 2 0 0 0 .245.96l5.51 10.08A2 2 0 0 1 18 22H6a2 2 0 0 1-1.755-2.96l5.51-10.08A2 2 0 0 0 10 8V2\"/><path d=\"M6.453 15h11.094\"/><path d=\"M8.5 2h7\"/>", "squares-2x2": "<path d=\"M3.75 6A2.25 2.25 0 0 1 6 3.75h2.25A2.25 2.25 0 0 1 10.5 6v2.25a2.25 2.25 0 0 1-2.25 2.25H6a2.25 2.25 0 0 1-2.25-2.25V6ZM3.75 15.75A2.25 2.25 0 0 1 6 13.5h2.25a2.25 2.25 0 0 1 2.25 2.25V18a2.25 2.25 0 0 1-2.25 2.25H6A2.25 2.25 0 0 1 3.75 18v-2.25ZM13.5 6a2.25 2.25 0 0 1 2.25-2.25H18A2.25 2.25 0 0 1 20.25 6v2.25A2.25 2.25 0 0 1 18 10.5h-2.25a2.25 2.25 0 0 1-2.25-2.25V6ZM13.5 15.75a2.25 2.25 0 0 1 2.25-2.25H18a2.25 2.25 0 0 1 2.25 2.25V18A2.25 2.25 0 0 1 18 20.25h-2.25A2.25 2.25 0 0 1 13.5 18v-2.25Z\"/>", "square-2-stack": "<path d=\"M16.5 8.25V6a2.25 2.25 0 0 0-2.25-2.25H6A2.25 2.25 0 0 0 3.75 6v8.25A2.25 2.25 0 0 0 6 16.5h2.25m8.25-8.25H18a2.25 2.25 0 0 1 2.25 2.25V18A2.25 2.25 0 0 1 18 20.25h-7.5A2.25 2.25 0 0 1 8.25 18v-1.5m8.25-8.25h-6a2.25 2.25 0 0 0-2.25 2.25v6\"/>", "clipboard-document-list": "<path d=\"M9 12h3.75M9 15h3.75M9 18h3.75m3 .75H18a2.25 2.25 0 0 0 2.25-2.25V6.108c0-1.135-.845-2.098-1.976-2.192a48.424 48.424 0 0 0-1.123-.08m-5.801 0c-.065.21-.1.433-.1.664 0 .414.336.75.75.75h4.5a.75.75 0 0 0 .75-.75 2.25 2.25 0 0 0-.1-.664m-5.8 0A2.251 2.251 0 0 1 13.5 2.25H15c1.012 0 1.867.668 2.15 1.586m-5.8 0c-.376.023-.75.05-1.124.08C9.095 4.01 8.25 4.973 8.25 6.108V8.25m0 0H4.875c-.621 0-1.125.504-1.125 1.125v11.25c0 .621.504 1.125 1.125 1.125h9.75c.621 0 1.125-.504 1.125-1.125V9.375c0-.621-.504-1.125-1.125-1.125H8.25ZM6.75 12h.008v.008H6.75V12Zm0 3h.008v.008H6.75V15Zm0 3h.008v.008H6.75V18Z\"/>", "play-circle": "<path d=\"M21 12a9 9 0 1 1-18 0 9 9 0 0 1 18 0Z\"/><path d=\"M15.91 11.672a.375.375 0 0 1 0 .656l-5.603 3.113a.375.375 0 0 1-.557-.328V8.887c0-.286.307-.466.557-.327l5.603 3.112Z\"/>", "pencil-square": "<path d=\"m16.862 4.487 1.687-1.688a1.875 1.875 0 1 1 2.652 2.652L10.582 16.07a4.5 4.5 0 0 1-1.897 1.13L6 18l.8-2.685a4.5 4.5 0 0 1 1.13-1.897l8.932-8.931Zm0 0L19.5 7.125M18 14v4.75A2.25 2.25 0 0 1 15.75 21H5.25A2.25 2.25 0 0 1 3 18.75V8.25A2.25 2.25 0 0 1 5.25 6H10\"/>", "puzzle-piece": "<path d=\"M14.25 6.087c0-.355.186-.676.401-.959.221-.29.349-.634.349-1.003 0-1.036-1.007-1.875-2.25-1.875s-2.25.84-2.25 1.875c0 .369.128.713.349 1.003.215.283.401.604.401.959v0a.64.64 0 0 1-.657.643 48.39 48.39 0 0 1-4.163-.3c.186 1.613.293 3.25.315 4.907a.656.656 0 0 1-.658.663v0c-.355 0-.676-.186-.959-.401a1.647 1.647 0 0 0-1.003-.349c-1.036 0-1.875 1.007-1.875 2.25s.84 2.25 1.875 2.25c.369 0 .713-.128 1.003-.349.283-.215.604-.401.959-.401v0c.31 0 .555.26.532.57a48.039 48.039 0 0 1-.642 5.056c1.518.19 3.058.309 4.616.354a.64.64 0 0 0 .657-.643v0c0-.355-.186-.676-.401-.959a1.647 1.647 0 0 1-.349-1.003c0-1.035 1.008-1.875 2.25-1.875 1.243 0 2.25.84 2.25 1.875 0 .369-.128.713-.349 1.003-.215.283-.4.604-.4.959v0c0 .333.277.599.61.58a48.1 48.1 0 0 0 5.427-.63 48.05 48.05 0 0 0 .582-4.717.532.532 0 0 0-.533-.57v0c-.355 0-.676.186-.959.401-.29.221-.634.349-1.003.349-1.035 0-1.875-1.007-1.875-2.25s.84-2.25 1.875-2.25c.37 0 .713.128 1.003.349.283.215.604.401.96.401v0a.656.656 0 0 0 .658-.663 48.422 48.422 0 0 0-.37-5.36c-1.886.342-3.81.574-5.766.689a.578.578 0 0 1-.61-.58v0Z\"/>", "arrow-down-on-square": "<path d=\"M9 8.25H7.5a2.25 2.25 0 0 0-2.25 2.25v9a2.25 2.25 0 0 0 2.25 2.25h9a2.25 2.25 0 0 0 2.25-2.25v-9a2.25 2.25 0 0 0-2.25-2.25H15M9 12l3 3m0 0 3-3m-3 3V2.25\"/>", "book-open": "<path d=\"M12 6.042A8.967 8.967 0 0 0 6 3.75c-1.052 0-2.062.18-3 .512v14.25A8.987 8.987 0 0 1 6 18c2.305 0 4.408.867 6 2.292m0-14.25a8.966 8.966 0 0 1 6-2.292c1.052 0 2.062.18 3 .512v14.25A8.987 8.987 0 0 0 18 18a8.967 8.967 0 0 0-6 2.292m0-14.25v14.25\"/>", "code-bracket-square": "<path d=\"M14.25 9.75 16.5 12l-2.25 2.25m-4.5 0L7.5 12l2.25-2.25M6 20.25h12A2.25 2.25 0 0 0 20.25 18V6A2.25 2.25 0 0 0 18 3.75H6A2.25 2.25 0 0 0 3.75 6v12A2.25 2.25 0 0 0 6 20.25Z\"/>", "table-cells": "<path d=\"M3.375 19.5h17.25m-17.25 0a1.125 1.125 0 0 1-1.125-1.125M3.375 19.5h7.5c.621 0 1.125-.504 1.125-1.125m-9.75 0V5.625m0 12.75v-1.5c0-.621.504-1.125 1.125-1.125m18.375 2.625V5.625m0 12.75c0 .621-.504 1.125-1.125 1.125m1.125-1.125v-1.5c0-.621-.504-1.125-1.125-1.125m0 3.75h-7.5A1.125 1.125 0 0 1 12 18.375m9.75-12.75c0-.621-.504-1.125-1.125-1.125H3.375c-.621 0-1.125.504-1.125 1.125m19.5 0v1.5c0 .621-.504 1.125-1.125 1.125M2.25 5.625v1.5c0 .621.504 1.125 1.125 1.125m0 0h17.25m-17.25 0h7.5c.621 0 1.125.504 1.125 1.125M3.375 8.25c-.621 0-1.125.504-1.125 1.125v1.5c0 .621.504 1.125 1.125 1.125m17.25-3.75h-7.5c-.621 0-1.125.504-1.125 1.125m8.625-1.125c.621 0 1.125.504 1.125 1.125v1.5c0 .621-.504 1.125-1.125 1.125m-17.25 0h7.5m-7.5 0c-.621 0-1.125.504-1.125 1.125v1.5c0 .621.504 1.125 1.125 1.125M12 10.875v-1.5m0 1.5c0 .621-.504 1.125-1.125 1.125M12 10.875c0 .621.504 1.125 1.125 1.125m-2.25 0c.621 0 1.125.504 1.125 1.125M13.125 12h7.5m-7.5 0c-.621 0-1.125.504-1.125 1.125M20.625 12c.621 0 1.125.504 1.125 1.125v1.5c0 .621-.504 1.125-1.125 1.125m-17.25 0h7.5M12 14.625v-1.5m0 1.5c0 .621-.504 1.125-1.125 1.125M12 14.625c0 .621.504 1.125 1.125 1.125m-2.25 0c.621 0 1.125.504 1.125 1.125m0 1.5v-1.5m0 0c0-.621.504-1.125 1.125-1.125m0 0h7.5\"/>", "paper-airplane": "<path d=\"M6 12 3.269 3.125A59.769 59.769 0 0 1 21.485 12 59.768 59.768 0 0 1 3.27 20.875L5.999 12Zm0 0h7.5\"/>", "bell": "<path d=\"M14.857 17.082a23.848 23.848 0 0 0 5.454-1.31A8.967 8.967 0 0 1 18 9.75V9A6 6 0 0 0 6 9v.75a8.967 8.967 0 0 1-2.312 6.022c1.733.64 3.56 1.085 5.455 1.31m5.714 0a24.255 24.255 0 0 1-5.714 0m5.714 0a3 3 0 1 1-5.714 0\"/>", "beaker": "<path d=\"M9.75 3.104v5.714a2.25 2.25 0 0 1-.659 1.591L5 14.5M9.75 3.104c-.251.023-.501.05-.75.082m.75-.082a24.301 24.301 0 0 1 4.5 0m0 0v5.714c0 .597.237 1.17.659 1.591L19.8 15.3M14.25 3.104c.251.023.501.05.75.082M19.8 15.3l-1.57.393A9.065 9.065 0 0 1 12 15a9.065 9.065 0 0 0-6.23-.693L5 14.5m14.8.8 1.402 1.402c1.232 1.232.65 3.318-1.067 3.611A48.309 48.309 0 0 1 12 21c-2.773 0-5.491-.235-8.135-.687-1.718-.293-2.3-2.379-1.067-3.61L5 14.5\"/>", "photo": "<path d=\"m2.25 15.75 5.159-5.159a2.25 2.25 0 0 1 3.182 0l5.159 5.159m-1.5-1.5 1.409-1.409a2.25 2.25 0 0 1 3.182 0l2.909 2.909m-18 3.75h16.5a1.5 1.5 0 0 0 1.5-1.5V6a1.5 1.5 0 0 0-1.5-1.5H3.75A1.5 1.5 0 0 0 2.25 6v12a1.5 1.5 0 0 0 1.5 1.5Zm10.5-11.25h.008v.008h-.008V8.25Zm.375 0a.375.375 0 1 1-.75 0 .375.375 0 0 1 .75 0Z\"/>", "link": "<path d=\"M13.19 8.688a4.5 4.5 0 0 1 1.242 7.244l-4.5 4.5a4.5 4.5 0 0 1-6.364-6.364l1.757-1.757m13.35-.622 1.757-1.757a4.5 4.5 0 0 0-6.364-6.364l-4.5 4.5a4.5 4.5 0 0 0 1.242 7.244\"/>", "presentation-chart-bar": "<path d=\"M3.75 3v11.25A2.25 2.25 0 0 0 6 16.5h2.25M3.75 3h-1.5m1.5 0h16.5m0 0h1.5m-1.5 0v11.25A2.25 2.25 0 0 1 18 16.5h-2.25m-7.5 0h7.5m-7.5 0-1 3m8.5-3 1 3m0 0 .5 1.5m-.5-1.5h-9.5m0 0-.5 1.5M9 11.25v1.5M12 9v3.75m3-6v6\"/>", "document-text": "<path d=\"M19.5 14.25v-2.625a3.375 3.375 0 0 0-3.375-3.375h-1.5A1.125 1.125 0 0 1 13.5 7.125v-1.5a3.375 3.375 0 0 0-3.375-3.375H8.25m0 12.75h7.5m-7.5 3H12M10.5 2.25H5.625c-.621 0-1.125.504-1.125 1.125v17.25c0 .621.504 1.125 1.125 1.125h12.75c.621 0 1.125-.504 1.125-1.125V11.25a9 9 0 0 0-9-9Z\"/>", "microphone": "<path d=\"M12 18.75a6 6 0 0 0 6-6v-1.5m-6 7.5a6 6 0 0 1-6-6v-1.5m6 7.5v3.75m-3.75 0h7.5M12 15.75a3 3 0 0 1-3-3V4.5a3 3 0 1 1 6 0v8.25a3 3 0 0 1-3 3Z\"/>", "check-circle": "<path d=\"M9 12.75 11.25 15 15 9.75M21 12a9 9 0 1 1-18 0 9 9 0 0 1 18 0Z\"/>", "clipboard-document-check": "<path d=\"M11.35 3.836c-.065.21-.1.433-.1.664 0 .414.336.75.75.75h4.5a.75.75 0 0 0 .75-.75 2.25 2.25 0 0 0-.1-.664m-5.8 0A2.251 2.251 0 0 1 13.5 2.25H15c1.012 0 1.867.668 2.15 1.586m-5.8 0c-.376.023-.75.05-1.124.08C9.095 4.01 8.25 4.973 8.25 6.108V8.25m8.9-4.414c.376.023.75.05 1.124.08 1.131.094 1.976 1.057 1.976 2.192V16.5A2.25 2.25 0 0 1 18 18.75h-2.25m-7.5-10.5H4.875c-.621 0-1.125.504-1.125 1.125v11.25c0 .621.504 1.125 1.125 1.125h9.75c.621 0 1.125-.504 1.125-1.125V18.75m-7.5-10.5h6.375c.621 0 1.125.504 1.125 1.125v9.375m-8.25-3 1.5 1.5 3-3.75\"/>", "cube": "<path d=\"m21 7.5-9-5.25L3 7.5m18 0-9 5.25m9-5.25v9l-9 5.25M3 7.5l9 5.25M3 7.5v9l9 5.25m0-9v9\"/>", "rectangle-stack": "<path d=\"M6 6.878V6a2.25 2.25 0 0 1 2.25-2.25h7.5A2.25 2.25 0 0 1 18 6v.878m-12 0c.235-.083.487-.128.75-.128h10.5c.263 0 .515.045.75.128m-12 0A2.25 2.25 0 0 0 4.5 9v.878m13.5-3A2.25 2.25 0 0 1 19.5 9v.878m0 0a2.246 2.246 0 0 0-.75-.128H5.25c-.263 0-.515.045-.75.128m15 0A2.25 2.25 0 0 1 21 12v6a2.25 2.25 0 0 1-2.25 2.25H5.25A2.25 2.25 0 0 1 3 18v-6c0-.98.626-1.813 1.5-2.122\"/>", "ellipsis-horizontal": "<path d=\"M6.75 12a.75.75 0 1 1-1.5 0 .75.75 0 0 1 1.5 0ZM12.75 12a.75.75 0 1 1-1.5 0 .75.75 0 0 1 1.5 0ZM18.75 12a.75.75 0 1 1-1.5 0 .75.75 0 0 1 1.5 0Z\"/>", "arrows-right-left": "<path d=\"M7.5 21 3 16.5m0 0L7.5 12M3 16.5h13.5m0-13.5L21 7.5m0 0L16.5 12M21 7.5H7.5\"/>", "bars-3-bottom-left": "<path d=\"M3.75 6.75h16.5M3.75 12h16.5m-16.5 5.25H12\"/>"});
  var INS_PICS = { plate: 'squares-2x2', 'plate-carry': 'square-2-stack', protocol: 'clipboard-document-list', run: 'play-circle', component: 'pencil-square',
    'pull-barrier': 'construction', 'pull-item': 'puzzle-piece', 'pull-comp': 'arrow-down-on-square', calc: 'calculator', equation: 'variable', 'equation-reg': 'book-open',
    html: 'code-bracket-square', view: 'table-cells', 'canvas-add': 'paper-airplane', reminder: 'bell', material: 'beaker', 'material-new': 'flask-conical', figure: 'photo',
    noteref: 'link', deck: 'presentation-chart-bar', pdf: 'document-text', rec: 'microphone', task: 'check-circle',
    rmpaper: 'books', rmprotocol: 'clipboard-document-check', rmaction: 'cube', rmcollection: 'rectangle-stack', _text: 'bars-3-bottom-left', _other: 'arrows-right-left' };
  LAB.insertIcons = INS_PICS;
  function pic(name) { var p = PILL_ICONS[name]; return p ? '<svg viewBox="0 0 24 24" width="18" height="18" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true" focusable="false">' + p + '</svg>' : ''; }
  function picEl(name) { var s = h('span.lab-pic'); s.innerHTML = pic(name); return s; }
  var QC_DEFAULT = ['component', 'rmpaper', 'material', 'rmprotocol', 'run', 'plate', 'task', 'rmaction', 'rmcollection'];
  var LP = { open: null, zoom: false, last: null, seen: null, pos: _ls.get('lab:pills2', {}) || {}, tap: null, suppress: 0,
    docked: _ls.get('lab:docked', {}) || {}, dockT: null, dockMs: 10000, rolling: null, qc: _ls.get('lab:quickcast', null) || QC_DEFAULT.slice() };
  LAB.pills = LP;
  var PILLS = { hand: { icon: '✎', label: 'Zoom · move · pen · highlighter · lasso · pen settings (double-tap: the last mode)', side: 'right', vert: 'up' },
    insert: { icon: '＋', label: 'Quick cast — what you add most (choose them in + Insert)', side: 'center', vert: 'up', dock: 'a row above the bottom bar' },
    tools: { icon: '✦', label: 'Tools', side: 'right', vert: 'down', dock: 'a row at the top right' },
    view: { icon: '⊕', label: 'Zoom', side: 'left', vert: 'down', dock: 'a column down the left' } };
  var HAND_NAMES = { zoom: 'Zoom', move: 'Move', pen: 'Pen', hl: 'Highlighter', lasso: 'Lasso', eraser: 'Eraser' };
  var FAN_RINGS = [[5, 84], [7, 140], [9, 196]];
  function fanPos(i, n, side, vert) {
    var k = i, start = 0, ring = 0;
    while (ring < FAN_RINGS.length - 1 && k >= Math.min(FAN_RINGS[ring][0], n - start)) { var c = Math.min(FAN_RINGS[ring][0], n - start); k -= c; start += c; ring++; }
    var cnt = Math.max(1, Math.min(FAN_RINGS[ring][0], n - start)), r = FAN_RINGS[ring][1];
    var a0 = side === 'center' ? (vert === 'up' ? 22 : 202) : side === 'left' ? (vert === 'up' ? 4 : 274) : (vert === 'up' ? 94 : 184), a1 = a0 + (side === 'center' ? 136 : 82), a = cnt === 1 ? (a0 + a1) / 2 : a0 + (a1 - a0) * k / (cnt - 1), t = a * Math.PI / 180;
    return { x: Math.round(Math.cos(t) * r), y: Math.round(-Math.sin(t) * r) };
  }
  /* V3.896 — the docked form: the Quick cast splits left and right of its pill (more rows above when the screen is
     narrow), the tools run in a row away from the nearest edge, zoom runs in a column below (or above) its pill */
  var DOCK_GAP = 46;
  function rowPos(name, i, n, side, vert, bw, inBar) {
    if (name === 'insert' && inBar) {   // V3.897 — a row above the bar, centred on the pill
      var per2 = Math.max(3, Math.floor((bw - 40) / DOCK_GAP)), r2 = Math.floor(i / per2), k2 = i % per2, in2 = Math.min(per2, n - r2 * per2);
      return { x: Math.round((k2 - (in2 - 1) / 2) * DOCK_GAP), y: -(52 + r2 * DOCK_GAP) };
    }
    if (name === 'insert') {
      var per = Math.max(2, Math.floor((bw / 2 - 34) / DOCK_GAP)), row = Math.floor(i / (2 * per)), k = i % (2 * per), inRow = Math.min(2 * per, n - row * 2 * per), L = Math.ceil(inRow / 2);
      return { x: k < L ? -(L - k) * DOCK_GAP : (k - L + 1) * DOCK_GAP, y: -row * DOCK_GAP };
    }
    if (name === 'view') return { x: 0, y: vert === 'up' ? -(i + 1) * DOCK_GAP : (i + 1) * DOCK_GAP + 14 };   // below the % under the pill
    return { x: (side === 'left' ? 1 : -1) * (i + 1) * DOCK_GAP, y: 0 };
  }
  function dockable(name) { return !!(PILLS[name] && PILLS[name].dock); }
  function dock(name) { LP.docked[name] = true; _ls.set('lab:docked', LP.docked); LP.open = null; LP.rolling = name; paintAll(); }
  function undock(name, pill) {
    if (pill) pill.classList.add('unrolling');
    setTimeout(function () { LP.docked[name] = false; _ls.set('lab:docked', LP.docked); paintAll(); }, pill ? 280 : 0);
  }
  LAB.dockPill = dock; LAB.undockPill = function (name) { undock(name, null); };
  /* the Quick cast: the inserts the person chose (_ls lab:quickcast, ids of INSERTS), in Gabe's order */
  function qcRows(d) {
    var on = {}; (LP.qc || []).forEach(function (id) { on[id] = 1; });
    return INSERTS.filter(function (x) { return on[x.id] && (!x.when || x.when(d)); });
  }
  function qcToggle(id) {
    var i = LP.qc.indexOf(id); if (i >= 0) LP.qc.splice(i, 1); else LP.qc.push(id);
    _ls.set('lab:quickcast', LP.qc); paintAll(); return i < 0;
  }
  LAB.quickCast = { list: function () { return LP.qc.slice(); }, toggle: qcToggle };
  // V3.896 — colours added with the old pill (lab:inkColors) move once into Gabe's own pen palette (13zv, inkPalette)
  try { var oldC = (_ls.get('lab:inkColors', []) || []).filter(function (c) { return /^#[0-9a-f]{6}$/i.test(c) && INK.COLORS.indexOf(c) < 0; });
    if (oldC.length) { oldC.forEach(function (c) { INK.COLORS.push(c); }); _ls.set('inkPalette', INK.COLORS.slice()); } if (_ls.get('lab:inkColors', null)) _ls.set('lab:inkColors', null); } catch (e) {}
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
  function pillItems(name, pane) {
    var d = M.doc(pane.docId), items = []; if (!d) return items;
    if (name === 'hand') {
      var g = handGroup();
      [['zoom', 'magnifying-glass', 'Zoom — tap to zoom in, Alt-tap out, Shift-tap to fit a component or region, drag up or down'], ['move', 'hand', 'Move — drag the paper to pan, drag a component to move it'], ['pen', 'pencil', 'Pen — draw with the mouse or the pen'],
        ['hl', 'highlighter', 'Highlighter — wide and see-through'], ['lasso', 'lasso', 'Lasso — circle strokes to move, recolour, delete or convert']].forEach(function (f) {
        items.push({ icon: pic(f[1]), label: f[2], sel: g === f[0], mode: true, keep: true, run: function () { setHand(f[0]); } }); });
      /* V3.896 — pen settings live in Gabe's ink bar (top left, stays open), behind one cog */
      items.push({ icon: pic('cog'), label: INK.shown ? 'Pen settings — hide the bar at the top left' : 'Pen settings — colours, widths, eraser, pressure (a bar at the top left; it stays open)', sel: INK.shown, keep: true,
        run: function () { INK.shown = !INK.shown; _ls.set('inkBar', INK.shown); INK.paintBars(); $$('.ctools .ct-ink').forEach(function (x) { x.classList.toggle('on', INK.shown); }); paintAll(); } });
    } else if (name === 'insert') {
      qcRows(d).forEach(function (x) { var lab = typeof x.label === 'function' ? x.label(d) : x.label;
        items.push({ icon: INS_PICS[x.id] && PILL_ICONS[INS_PICS[x.id]] ? pic(INS_PICS[x.id]) : '<span class="lab-insic">' + esc(x.icon || '•') + '</span>', label: lab + (x.sub ? ' — ' + x.sub : ''), run: function () { x.run(d, centerAt(pane), pane); } }); });
      items.push({ icon: pic('ellipsis-horizontal'), label: 'Everything that can go in this note — the bolt on a row puts it in your Quick cast', run: function (el) { INSERT.menu(pane, el); } });
    } else if (name === 'tools') {
      var s = TIMER.activeFor(d.id);
      items.push({ icon: pic(!s ? 'clock' : s.state === 'running' ? 'pause' : 'play'), label: !s ? 'Start this note’s timer' : s.state === 'running' ? 'Pause the timer' : 'Resume the timer', sel: !!s, keep: true,
        run: function () { var cur = TIMER.activeFor(d.id); if (!cur) { if (typeof TCMP !== 'undefined' && TCMP.start) TCMP.start(d.id); else TIMER.start(d.id); } else if (cur.state === 'running') TIMER.pause(cur); else TIMER.resume(cur); paintAll(); } });
      if (typeof HEAD !== 'undefined') items.push({ icon: pic('bolt'), label: s ? 'Add a head start to the timer…' : 'Start the timer with a head start…', run: function () { var cur = TIMER.activeFor(d.id); if (cur) HEAD.add(cur); else HEAD.start(d.id); } });
      items.push({ icon: pic('calculator'), label: 'A calculator in this note', run: function () { CALC.open(pane); } });
      items.push({ icon: pic('variable'), label: 'An equation — new, or a registered one', run: function (el) { var r = el.getBoundingClientRect(); EQ.newMenu(pane, { clientX: r.left, clientY: r.top, currentTarget: el, target: el, preventDefault: function () {}, stopPropagation: function () {} }); } });
      if (typeof SPLITBTN !== 'undefined') items.push({ icon: pic('split'), label: 'Split — side by side, or a quadrant', run: function (el) { var r = el.getBoundingClientRect(); SPLITBTN.menu(pane, { clientX: r.left, clientY: r.bottom, currentTarget: el, target: el, preventDefault: function () {}, stopPropagation: function () {} }); } });
      items.push({ icon: pic('arrows-pointing-out'), label: document.fullscreenElement ? 'Leave focus mode' : 'Focus mode — full screen', run: function () { App.toggleFocus(); } });
      if (Object.keys(LP.pos).length || Object.keys(LP.docked).some(function (k) { return LP.docked[k]; })) items.push({ icon: pic('home'), label: 'Put the pills back in their places (and fold the docked rows)',
        run: function () { LP.pos = {}; _ls.set('lab:pills2', {}); LP.docked = {}; _ls.set('lab:docked', {}); paintAll(); } });
    } else if (name === 'view') {
      items.push({ icon: pic('plus'), label: 'Zoom in', keep: true, run: function () { zoomBy(pane, 1.25); } });
      items.push({ icon: '<b class="lab-100">1:1</b>', label: '100 %', keep: true, run: function () { zoom100(pane); } });
      items.push({ icon: pic('minus'), label: 'Zoom out', keep: true, run: function () { zoomBy(pane, 0.8); } });
      items.push({ icon: pic('arrows-pointing-out'), label: 'Fit everything on the screen', run: function () { fitAll(pane); } });
    }
    return items;
  }
  function insLabels(d) { var m = {}; INSERTS.forEach(function (x) { var l = typeof x.label === 'function' ? (d ? x.label(d) : '') : x.label; if (l) m[l] = x.id; }); return m; }
  function insIcon(el, id) { var n = INS_PICS[id]; if (el && n && PILL_ICONS[n] && !el.querySelector('svg')) el.innerHTML = pic(n); }
  function qcDecorate(pop, d) {
    var byLabel = insLabels(d);
    var stop = function (e) { e.stopPropagation(); };
    var pin = function (id) {
      var on = LP.qc.indexOf(id) >= 0, b = h('button.lab-qc-pin' + (on ? '.on' : ''), { type: 'button', 'data-qc': id, title: on ? 'In your Quick cast — tap to take it out' : 'Put it in your Quick cast',
        on: { pointerdown: stop, mousedown: stop, click: function (e) { e.stopPropagation(); e.preventDefault(); var now = qcToggle(id); b.classList.toggle('on', now); b.title = now ? 'In your Quick cast — tap to take it out' : 'Put it in your Quick cast'; } } });
      b.innerHTML = pic('bolt'); return b;
    };
    var paint = function () { $$('.insrow', pop).forEach(function (row) { var t = $('b', row), id = t && byLabel[t.textContent]; if (!id) return; insIcon($('.insic', row), id); if (!$('.lab-qc-pin', row)) row.append(pin(id)); }); };
    paint(); new MutationObserver(paint).observe(pop, { childList: true, subtree: true });
    var hd = $('h5', pop); if (hd && !$('.lab-qc-note', pop)) { var n = h('div.lab-qc-note'); n.innerHTML = pic('bolt') + '<span>puts a row in your Quick cast (＋)</span>'; hd.after(n); }
  }
  function pillEl(name, pane, host) {
    var def = PILLS[name], docked = dockable(name) && !!LP.docked[name], rolling = docked && LP.rolling === name, open = !docked && !!(LP.open && LP.open.name === name && LP.open.doc === pane.docId);
    var slot = name === 'insert' && !LP.pos.insert ? qcSlotAt(pane) : null, inBar = !!slot, C = inBar ? 19 : 22;   // V3.897 — in the bottom bar
    var items = open || docked ? pillItems(name, pane) : [];
    var bw = host.clientWidth || 800, bh = host.clientHeight || 600, sz = 44, pp = LP.pos[name], side = def.side, vert = def.vert || 'up', style = null;
    if (slot) style = { left: Math.round(slot.x - C) + 'px', top: Math.round(slot.y - C) + 'px', right: 'auto', bottom: 'auto' };
    else if (pp && isFinite(+pp.fx) && isFinite(+pp.fy)) {
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
    var rows = items.map(function (it, i) { return rowPos(name, i, items.length, side, vert, bw, inBar); });
    var fan = h('div.lab-fan', items.map(function (it, i) {
      var p = docked && !rolling ? rows[i] : fanPos(i, items.length, side, vert), st = { '--tx': p.x + 'px', '--ty': p.y + 'px', '--d': (i * (rolling ? 34 : 14)) + 'ms' };
      var el = h('button.lab-fan-item' + (it.sel ? '.sel' : '') + (it.mode ? '.mode' : ''), { type: 'button', title: it.label, 'aria-label': it.label, style: st,
        on: { pointerenter: function () { cap.textContent = it.label; }, pointerleave: function () { cap.textContent = ''; },
          click: function (e) { e.stopPropagation(); try { it.run(el); } catch (x) { warn('pill', x); } if (!it.keep && !docked) { LP.open = null; } paintAll(); } } });
      if (it.dot) el.innerHTML = '<span class="lab-fan-dot' + (it.hl ? ' hl' : '') + '" style="background:' + it.dot + '"></span>';
      else if (it.bar) el.innerHTML = '<span class="lab-fan-bar" style="height:' + it.bar + 'px"></span>';
      else if (it.eraser) el.innerHTML = '<span class="lab-fan-eraser"></span>';
      else el.innerHTML = it.icon;
      return el;
    }), open || docked ? cap : null);
    var rail = null;
    if (docked && items.length) {   // the strip behind a docked row
      var o = inBar ? rows[0] : { x: 0, y: 0 }, x0 = o.x, x1 = o.x, y0 = o.y, y1 = o.y;   // the pill's own spot too — unless it sits in the bar
      rows.forEach(function (q) { x0 = Math.min(x0, q.x); x1 = Math.max(x1, q.x); y0 = Math.min(y0, q.y); y1 = Math.max(y1, q.y); });
      rail = h('div.lab-dock-rail', { style: { left: (C + x0 - 25) + 'px', top: (C + y0 - 25) + 'px', width: (x1 - x0 + 50) + 'px', height: (y1 - y0 + 50) + 'px' } });
    }
    var pill = h('div.lab-pill.lab-pill-' + name + (inBar ? '.in-bar' : '') + (open ? '.open' : '') + (docked ? '.docked.fanned' : '') + (rolling ? '.rolling' : '') + (name === 'hand' && /^(zoom|move|lasso|eraser)$/.test(hm) ? '.on' : ''),
      { 'data-pill': name, 'data-side': side, 'data-vert': vert, style: style || {}, title: docked ? '' : null }, rail, b, fan);
    if (docked) b.setAttribute('title', def.label + ' — docked as ' + def.dock + '; tap to fold it back into the wheel (drag to move)');
    bindPill(pill, b, name, pane, host);
    if (open) requestAnimationFrame(function () { pill.classList.add('fanned'); });
    if (rolling) {   // the fan rolls into its row: the items travel from their fan places to the strip's
      LP.rolling = null;
      requestAnimationFrame(function () { requestAnimationFrame(function () {
        [].forEach.call(fan.querySelectorAll('.lab-fan-item'), function (el, i) { if (rows[i]) { el.style.setProperty('--tx', rows[i].x + 'px'); el.style.setProperty('--ty', rows[i].y + 'px'); } });
        pill.classList.add('rolled'); setTimeout(function () { pill.classList.remove('rolling'); }, 900);
      }); });
    }
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
        LP.pos[name] = { fx: Math.round((L + pr.width / 2) / r.width * 1000) / 1000, fy: Math.round((T + pr.height / 2) / r.height * 1000) / 1000 }; _ls.set('lab:pills2', LP.pos);
        paintAll();
      }
      b.addEventListener('pointermove', mv); b.addEventListener('pointerup', up); b.addEventListener('pointercancel', up);
    });
    b.addEventListener('click', function (e) {
      e.stopPropagation();
      if (Date.now() - LP.suppress < 400) return;
      if (dockable(name) && LP.docked[name]) { LP.open = null; return undock(name, pill); }   // V3.896 — a docked row folds back into its wheel
      var toggle = function () {   // keyed to the note: a re-render makes a new host
        LP.open = LP.open && LP.open.name === name && LP.open.doc === pane.docId ? null : { name: name, doc: pane.docId }; paintAll();
        clearTimeout(LP.dockT);   // V3.896 — a Quick cast / tools / zoom fan left open for 10 s docks
        if (LP.open && dockable(name)) { var mine = LP.open; LP.dockT = setTimeout(function () { if (LP.open === mine) dock(name); }, LP.dockMs); }
      };
      if (name !== 'hand') return toggle();
      if (LP.tap) { clearTimeout(LP.tap); LP.tap = null; LP.open = null; lastHand(); return; }   // a double tap: the last mode
      LP.tap = setTimeout(function () { LP.tap = null; toggle(); }, 230);
    });
  }
  /* V3.897 — the Quick cast's place in Gabe's bottom bar: a slot near the middle of the dock (by width), its centre in
     the host's coordinates; the pill is drawn over it */
  function qcSlot(pane) {
    var dk = pane && pane.dock; if (!dk || !dk.isConnected || pane.travel || LP.pos.insert) { if (dk) $$('.lab-qc-slot', dk).forEach(function (x) { x.remove(); }); return null; }
    var sl = $('.lab-qc-slot', dk);
    if (!sl) {
      sl = h('span.lab-qc-slot', { 'aria-hidden': 'true' });
      var kids = [].slice.call(dk.children), tot = kids.reduce(function (a, k) { return a + k.offsetWidth; }, 0), acc = 0, at = kids.length;
      for (var i = 0; i < kids.length; i++) { if (acc + kids[i].offsetWidth / 2 >= tot / 2) { at = i; break; } acc += kids[i].offsetWidth; }
      if (kids[at]) dk.insertBefore(sl, kids[at]); else dk.append(sl);
    }
    return sl;
  }
  function qcSlotAt(pane) {
    var sl = qcSlot(pane), host = pane && pane.host; if (!sl || !host) return null;
    var r = sl.getBoundingClientRect(), hr = host.getBoundingClientRect(); if (!r.width) return null;
    return { x: r.left + r.width / 2 - hr.left, y: r.top + r.height / 2 - hr.top };
  }
  function placeQuickCast(pane) {
    var host = pane && pane.host, pill = host && $(':scope > .lab-pills > .lab-pill-insert', host); if (!pill) return;
    var at = qcSlotAt(pane);
    if (!at) { if (pill.classList.contains('in-bar')) paintPills(pane); return; }
    if (!pill.classList.contains('in-bar')) return paintPills(pane);
    pill.style.left = Math.round(at.x - 19) + 'px'; pill.style.top = Math.round(at.y - 19) + 'px';
  }
  LAB.placeQuickCast = function () { App.panes().forEach(placeQuickCast); };
  function paintPills(pane) {
    var host = pane && pane.host; if (!host || !host.isConnected || !pane.paper || !M.doc(pane.docId)) return;
    var box = $(':scope > .lab-pills', host);
    if (!box) { box = h('div.lab-pills.nopan'); host.append(box); bindZoomHand(pane, host);
      try { if (pane.dock && typeof ResizeObserver !== 'undefined') { new ResizeObserver(function () { placeQuickCast(pane); }).observe(pane.dock); pane.dock.addEventListener('scroll', function () { placeQuickCast(pane); }, { passive: true }); } } catch (e) {} }
    trackHand();
    host.classList.toggle('lab-hand-zoom', LP.zoom); host.classList.toggle('lab-hand-move', handNow() === 'move'); host.classList.add('lab-pilled');
    if (!LP.zoom && ZF.el) zfitMark(null);
    box.classList.toggle('fan-open', !!(LP.open && LP.open.doc === pane.docId));
    box.replaceChildren.apply(box, (pane.travel ? ['view'] : ['insert', 'tools', 'hand', 'view']).map(function (n) { return pillEl(n, pane, host); }));   // V3.899 — nothing to add to a read-only note
  }
  function paintAll() { try { App.panes().forEach(paintPills); } catch (e) { warn('pills', e); } }
  LAB.paintPills = paintAll; LAB.setHand = setHand; LAB.handNow = handNow;
  /* the zoom hand: a tap zooms in ×1.5 at the point (Alt / right button: out, with the zoom-out cursor while Alt is
     held); a drag up or down zooms smoothly. Shift-tap fits the view to the component or region under the pointer
     (empty paper: the whole note); while Shift is held the edge of what it would fit lights up (.lab-zfit). The click
     that follows a zoom tap is swallowed, so a tap on a component only zooms. */
  var ZOOM_SKIP = '.lab-pills,.dock,.ctools,.insp,.ink-bar,.ink-selbar,.pop,.hint,button,input,textarea,select,a';
  var ZF = { host: null, x: 0, y: 0, shift: false, el: null, swallow: 0 };
  // a region by its tab, else the component under the pointer, else the smallest region around the point
  function zfitTarget(host, x, y) {
    var P = host._dv && host._dv.paper; if (!P) return null;
    var hits = document.elementsFromPoint(x, y);
    if (!hits.length || !host.contains(hits[0]) || hits[0].closest(ZOOM_SKIP)) return null;
    for (var i = 0; i < hits.length; i++) {
      var rg = hits[i].closest('.region'), bx = hits[i].closest('.box');
      if (rg && rg.parentNode === P.world) return rg;
      if (bx && bx.parentNode === P.world) return bx;
    }
    var w = P.toWorld(x, y), best = null, area = Infinity;
    $$(':scope > .region', P.world).forEach(function (r) { var a = r.offsetWidth * r.offsetHeight;
      if (a && a < area && w.x >= r.offsetLeft && w.x <= r.offsetLeft + r.offsetWidth && w.y >= r.offsetTop && w.y <= r.offsetTop + r.offsetHeight) { best = r; area = a; } });
    return best;
  }
  function zfitWidth(el, z) { el.style.setProperty('--lab-zw', (2 / (z || 1)).toFixed(2) + 'px'); }   // 2 px on screen at any zoom
  function zfitMark(el) {
    if (ZF.el && ZF.el !== el) ZF.el.classList.remove('lab-zfit');
    ZF.el = el || null; if (!el) return;
    var P = ZF.host && ZF.host._dv && ZF.host._dv.paper; zfitWidth(el, P && P.view.z); el.classList.add('lab-zfit');
  }
  function zfitHover() { zfitMark(ZF.shift && LP.zoom && ZF.host && ZF.host.isConnected ? zfitTarget(ZF.host, ZF.x, ZF.y) : null); }
  /* Paper.fitTarget keeps a note's top on the screen (y ≥ pad: right for "fit everything", wrong for one thing further
     down), so a component or region is centred here instead, in the room the side pills, the tool row and the dock leave */
  var ZFIT_PAD = { side: 72, top: 64, bottom: 140, split: 100 };   // V3.896: bottom clears the Quick cast above the bar and its hint line
  LAB.zfitPad = ZFIT_PAD;
  function zfit(host, x, y) {
    var P = host._dv.paper, el = zfitTarget(host, x, y);
    if (!el) return fitAll(host._dv);
    var r = P.rect(), s = r.width < 640 ? 12 : ZFIT_PAD.side, t = host.closest('.split') ? ZFIT_PAD.split : ZFIT_PAD.top, b = ZFIT_PAD.bottom;
    var w = Math.max(1, el.offsetWidth), ht = Math.max(1, el.offsetHeight), z = clamp(Math.min((r.width - 2 * s) / w, (r.height - t - b) / ht), P.o.minZ, P.o.maxZ);
    P.animateView({ z: z, x: r.width / 2 - (el.offsetLeft + w / 2) * z, y: t + (r.height - t - b) / 2 - (el.offsetTop + ht / 2) * z });
  }
  function zfitKeys(e) {
    if (e.key !== 'Shift' && e.key !== 'Alt') return;
    ZF.shift = e.shiftKey && !e.altKey;
    $$('.canvas-host').forEach(function (x) { x.classList.toggle('lab-zoom-out', e.altKey); });
    zfitHover();
  }
  addEventListener('keydown', zfitKeys, true); addEventListener('keyup', zfitKeys, true);
  addEventListener('blur', function () { ZF.shift = false; zfitMark(null); $$('.canvas-host.lab-zoom-out').forEach(function (x) { x.classList.remove('lab-zoom-out'); }); });
  function bindZoomHand(pane, host) {
    host.addEventListener('pointerdown', function (e) {
      if (!LP.zoom || e.pointerType === 'pen' || e.target.closest(ZOOM_SKIP)) return;
      var P = host._dv && host._dv.paper; if (!P) return;
      e.preventDefault(); e.stopPropagation();
      var y0 = e.clientY, x0 = e.clientX, z0 = P.view.z, moved = 0, out = e.altKey || e.button === 2, fit = e.shiftKey && !out;
      function mv(ev) { moved = Math.max(moved, Math.abs(ev.clientY - y0)); if (moved > 4) P.zoomAt(z0 * Math.exp(-(ev.clientY - y0) * 0.01), x0, y0); }
      function up() { removeEventListener('pointermove', mv, true); removeEventListener('pointerup', up, true); removeEventListener('pointercancel', up, true); ZF.swallow = Date.now();
        if (moved <= 4) { if (fit) zfit(host, x0, y0); else P.zoomAt(P.view.z * (out ? 1 / 1.5 : 1.5), x0, y0); } }
      addEventListener('pointermove', mv, true); addEventListener('pointerup', up, true); addEventListener('pointercancel', up, true);
    }, true);
    host.addEventListener('pointermove', function (e) {
      if (!LP.zoom || e.pointerType === 'pen') return;
      ZF.host = host; ZF.x = e.clientX; ZF.y = e.clientY; ZF.shift = e.shiftKey && !e.altKey;
      host.classList.toggle('lab-zoom-out', e.altKey); zfitHover();
    }, true);
    host.addEventListener('pointerleave', function () { if (ZF.host === host) { ZF.host = null; zfitMark(null); } });
    host.addEventListener('click', function (e) { if (LP.zoom && Date.now() - ZF.swallow < 400 && !e.target.closest(ZOOM_SKIP)) { e.preventDefault(); e.stopPropagation(); } }, true);
    host.addEventListener('contextmenu', function (e) { if (LP.zoom && !e.target.closest('.lab-pills')) e.preventDefault(); }, true);
  }
  try {
    var oDocRender11 = DocView.render;
    DocView.render = function (docId) { var r = oDocRender11.apply(this, arguments), pane = this; requestAnimationFrame(function () { paintPills(pane); }); return r; };
    var oPaint = INK.paintBars; INK.paintBars = function () { var r = oPaint.apply(INK, arguments); paintAll(); return r; };
    /* V3.897 — Gabe rebuilds his bottom bar on every update: the Quick cast's slot goes back in, the pill follows */
    var oRenderDock = DocView.renderDock;
    DocView.renderDock = function () { var r = oRenderDock.apply(this, arguments), pane = this; try { qcSlot(pane); requestAnimationFrame(function () { placeQuickCast(pane); }); } catch (e) { warn('quick cast slot', e); } return r; };
    /* V3.896 — the + Insert list: a bolt on each row puts it in (or takes it out of) the person's Quick cast */
    var oInsMenu = INSERT.menu;
    INSERT.menu = function (pane) {
      var r = oInsMenu.apply(this, arguments);
      try { var pops = $$('.pop'), pop = pops[pops.length - 1]; if (pop && pane) qcDecorate(pop, M.doc(pane.docId)); } catch (e) { warn('quick cast', e); }
      return r;
    };
    /* V3.898 — the wire-drop menu (drag a wire to empty paper) lists the same rows: the same icons */
    if (typeof CHAINDROP !== 'undefined') {
      var oCdOpen = CHAINDROP.open;
      CHAINDROP.open = function (pane) {
        var r = oCdOpen.apply(this, arguments);
        try {
          var list = $('.chaindrop .cd-items'), byLabel = insLabels(M.doc(pane.docId)); byLabel['Text component'] = '_text'; byLabel['A component in another note…'] = '_other';
          var paint = function () { $$('.cd-it', list).forEach(function (row) { var t = $('b', row), id = t && byLabel[t.textContent]; if (id) insIcon($('.cd-ic', row), id); }); };
          if (list) { paint(); new MutationObserver(paint).observe(list, { childList: true }); }
        } catch (e) { warn('wire-drop icons', e); }
        return r;
      };
    }
    // the zoom % under ⊕ follows every pan and zoom
    var oApply = Paper.prototype.apply;
    Paper.prototype.apply = function () { var r = oApply.apply(this, arguments); try { var host = this.el.parentNode, pct = host && host.querySelector && host.querySelector(':scope > .lab-pills .lab-pill-pct'); if (pct) pct.textContent = Math.round(this.view.z * 100) + '%'; if (ZF.el && ZF.el.parentNode === this.world) zfitWidth(ZF.el, this.view.z); } catch (e) {} return r; };
    document.addEventListener('pointerdown', function (e) { if (LP.open && !(e.target.closest && e.target.closest('.lab-pills'))) { LP.open = null; paintAll(); } }, true);
    var oTimerPaint = TIMERUI.paint; TIMERUI.paint = function () { var r = oTimerPaint.apply(TIMERUI, arguments); if (LP.open && LP.open.name === 'tools') paintAll(); return r; };
  } catch (e) { warn('pills', e); }
  try {
    var st11 = document.getElementById('lab-mode-css');
    if (st11) st11.textContent += '.lab-pills{position:absolute;inset:0;pointer-events:none;z-index:21}.lab-pill{position:absolute;width:44px;height:44px;pointer-events:auto}' +
      '.lab-pill-insert{left:calc(50% - 22px);bottom:84px}.lab-pill-tools{right:14px;top:14px}.canvas-host.lab-pilled > .ctools{display:none}' +
      '.lab-qc-slot{flex:none;display:inline-block;width:46px;height:38px}.lab-pill.in-bar{width:38px;height:38px}.lab-pill.in-bar .lab-pill-btn{width:38px;height:38px;box-shadow:none;background:var(--ink);color:var(--paper);border-color:var(--ink);font-size:18px}' +
      '.lab-pill.in-bar .lab-fan{left:19px;top:19px}.lab-pill.in-bar.open .lab-pill-btn{background:var(--teal,#0d675e);border-color:var(--teal,#0d675e)}.lab-pill-hand{right:14px;bottom:16px}.lab-pill-view{left:14px;top:14px}' +
      'body.mobile .lab-pill-insert{bottom:64px}.canvas-host.lab-pilled > .ink-bar{left:68px}' +
      '.lab-pills.fan-open .lab-pill:not(.open):not(.docked){opacity:.22;pointer-events:none}.lab-pill.open{z-index:3}' +
      '.canvas-host .insp.open ~ .lab-pills .lab-pill-tools:not([style*="left"]),.canvas-host .insp.open ~ .lab-pills .lab-pill-hand:not([style*="left"]){right:344px}' +
      '.lab-pill.docked .lab-fan-item{transform:translate(var(--tx),var(--ty)) scale(1);opacity:1;transition:none}' +
      '.lab-pill.docked.rolling .lab-fan-item{transition:transform .55s cubic-bezier(.3,.85,.25,1) var(--d,0ms),opacity .2s}' +
      '.lab-pill.docked.unrolling .lab-fan-item{transform:translate(0,0) scale(.4);opacity:0;transition:transform .26s ease-in,opacity .22s}' +
      '.lab-dock-rail{position:absolute;border-radius:26px;background:color-mix(in srgb,var(--surface) 88%,transparent);border:1px solid var(--rule-2);box-shadow:0 6px 20px -12px rgba(36,33,28,.45);pointer-events:none;opacity:1;transition:opacity .35s}' +
      '.lab-pill.docked.rolling:not(.rolled) .lab-dock-rail,.lab-pill.docked.unrolling .lab-dock-rail{opacity:0}.lab-pill.docked .lab-pill-btn{box-shadow:0 0 0 3px color-mix(in srgb,var(--teal) 26%,transparent)}' +
      '.lab-qc-pin{flex:none;margin-left:auto;width:26px;height:26px;border-radius:50%;border:1px solid transparent;background:none;color:var(--ink-4,#aaa);display:grid;place-items:center;cursor:pointer;padding:0}' +
      '.lab-qc-pin svg{width:15px;height:15px}.lab-qc-pin:hover{border-color:var(--rule-2);color:var(--ink-2)}.lab-qc-pin.on{color:var(--teal)}.lab-qc-pin.on svg{fill:currentColor}' +
      '.insic svg{width:16px;height:16px}.cd-ic svg{width:15px;height:15px;vertical-align:-3px}.opt > .insrow{flex:1 1 auto;min-width:0}.insrow > div{flex:1 1 auto;min-width:0}.insrow{display:flex;align-items:center}.lab-qc-note{display:flex;align-items:center;gap:5px;font-size:11px;color:var(--ink-3);padding:0 10px 6px}.lab-qc-note svg{width:13px;height:13px;color:var(--teal);fill:currentColor}' +
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
      '.lab-insic{font-size:16px;line-height:1}.lab-100{font:700 10px/1 var(--f-m,monospace)}' +
      '.lab-pr{font:700 12px/1 var(--f-m,monospace)}' +
      '.lab-fan-cap{position:absolute;left:30px;top:-60px;white-space:nowrap;font:500 11px/18px var(--f-d,system-ui);color:var(--ink-2);background:var(--surface);border:1px solid var(--rule-2);border-radius:999px;padding:0 8px;pointer-events:none}' +
      '.lab-fan-cap:empty{display:none}.lab-pill[data-side="right"] .lab-fan-cap{left:auto;right:30px}.lab-pill[data-vert="down"] .lab-fan-cap{top:30px}' +
      '.canvas-host.lab-hand-zoom .paper{cursor:zoom-in}.canvas-host.lab-hand-zoom.lab-zoom-out .paper{cursor:zoom-out}' +
      '.box.lab-zfit,.region.lab-zfit{outline:var(--lab-zw,2px) solid var(--teal);outline-offset:var(--lab-zw,2px)}.region.lab-zfit{border-color:var(--rg)}' +
      '';
  } catch (e) { warn('css 11', e); }

  /* ---- 12. The one recorder in a note (V3.884, R1 of CodeLog/ClaudesPlan/V3.884_one_recorder_program.md) ----
     Gabe's Recording component (13zn) gains what RM's board recorder has, on the web: the audio goes to the lab's
     cloud a part a minute while it records (api/rec/part — a closed tab loses at most a minute, and a recording
     may run past the 30 MB single-file cap), joined at Stop (api/rec/compose); an interrupted one is recovered from
     its parts. Marks gain kinds (important · question · decision · to do, rm/js/recorder-core.js) and sections, in
     Gabe's own `marks` list (his ◆ bookmarks read as important). Ink drawn in the note while it records is stamped
     with its moment (stroke.rt = [recId, t0, t1], audio seconds) for the replay. His desktop keeps its own recorder
     and Whisper. V3.887 — speech to text each person's own way (rm/js/speech-to-text.js, chosen in RM Settings → Speech
     to text: free on the device, or their own OpenAI / Google key, never the lab's): a saved recording shows
     Transcribe with its likely cost, and the lines land in Gabe's transcript (REC.apply), as his desktop's do. */
  var LR = { cur: null, timer: null, penT0: null, sent: [], stamped: 0 };
  LAB.recorder = LR;
  function rcore() { return window.RECORDER_CORE || null; }
  try { if (!window.RECORDER_CORE) { var rcs = document.createElement('script'); rcs.src = '/rm/js/recorder-core.js?v=' + encodeURIComponent(LAB.version); document.head.appendChild(rcs); } } catch (e) { warn('recorder core', e); }
  try { if (!window.STT) { var sts = document.createElement('script'); sts.src = '/rm/js/speech-to-text.js?v=' + encodeURIComponent(LAB.version); sts.onload = function () { try { changed(); } catch (e) {} }; document.head.appendChild(sts); } } catch (e) { warn('speech to text', e); }
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

  /* marks: Gabe's ◆ drops one (Alt+M), plain. V3.886 (Alex: "simple up front, then customize later") — what it is
     (a question, a decision, a to-do; how long it lasts) is changed on the bookmark once it is in: its glyph in the
     list opens the choices */
  function recNow(id) { var a = REC.active; if (a && a.id === id) return REC.elapsed(); if (REC.player && REC.player.id === id) return REC.player.audio.currentTime; return null; }
  function setMark(id, fn) { var C = rcore(); if (!C) return; REC.put(id, function (r) { r.marks = fn(C, r.marks || []); }); changed(); }
  function markMenu(id, mid, ev) {
    var C = rcore(), m = (REC.r(M.block(id)).marks || []).filter(function (x) { return x.id === mid; })[0]; if (!C || !m) return;
    var t = recNow(id), span = typeof m.end === 'number', at = ev && ev.clientX != null ? ev : { clientX: innerWidth / 2, clientY: innerHeight / 3 };
    return ctxMenu(at.clientX, at.clientY + 8, [{ head: 'This bookmark is…' }].concat(
      C.MARK_KINDS.map(function (k) { return { label: k.glyph + ' ' + k.label, sub: C.kindOf(m.kind) === k.id ? ' — now' : null, run: function () { setMark(id, function (C, ms) { return C.updateMark(ms, mid, { kind: k.id }); }); } }; }),
      ['sep', t != null && t > m.t + 1 ? { label: (span ? 'Until now' : 'Lasts until now') + ' (' + C.mmss(t) + ')', run: function () { setMark(id, function (C, ms) { return C.spanTo(ms, mid, t); }); } }
        : { label: 'Lasts until…', sub: ' — play to where it ends, then choose this', disabled: true },
      span ? { label: 'Just the moment', run: function () { setMark(id, function (C, ms) { return C.spanTo(ms, mid, null); }); } } : null]));
  }
  LAB.markMenu = markMenu;

  /* V3.887 — Transcribe, the person's own way, with its likely cost on the button */
  var STTRUN = {}, STTERR = {};
  LAB.stt = { running: STTRUN, errors: STTERR };
  async function recBlob(b) {
    var s = REC.src(b); if (!s) throw new Error('This recording isn’t on this device or in the lab’s cloud yet.');
    if (typeof s !== 'string') return s;
    var res = await fetch(s); if (!res.ok) throw new Error('Couldn’t load the recording (' + res.status + ').');
    var bl = await res.blob(); REC.blobs.set(b.id, bl); return bl;
  }
  function paintStt(id) {
    var b = M.block(id); if (!b) return;
    [].forEach.call(document.querySelectorAll('.box[data-id="' + id + '"] .lab-rc-stt'), function (el) { el.replaceWith(sttEl(b)); });
  }
  async function transcribeRec(id) {
    var b = M.block(id); if (!b || STTRUN[id] || !window.STT) return;
    var ctl = new AbortController(); delete STTERR[id];
    STTRUN[id] = { text: 'Getting the recording…', frac: 0, ctl: ctl }; paintStt(id);
    try {
      var blob = await recBlob(b);
      var out = await STT.transcribe(blob, { ext: REC.r(b).ext, signal: ctl.signal, onProgress: function (t, f) { if (STTRUN[id]) { STTRUN[id].text = t; STTRUN[id].frac = f; paintStt(id); } } });
      delete STTRUN[id];
      if (!out.segs.length) { STTERR[id] = 'No speech was found in this recording.'; paintStt(id); return out; }
      REC.put(id, function (r) { r.stt = { provider: out.provider, model: out.model, at: new Date().toISOString() }; });
      REC.apply(id, { segs: out.segs, lang: out.lang });
      return out;
    } catch (e) {
      delete STTRUN[id]; STTERR[id] = ctl.signal.aborted ? 'Stopped. Nothing was kept.' : (e && e.message) || String(e); paintStt(id); return null;
    }
  }
  LAB.transcribe = transcribeRec;
  function sttEl(b) {
    var r = REC.r(b), id = b.id, run = STTRUN[id], S = window.STT;
    var stop = function (e) { e.stopPropagation(); };
    if (run) return h('div.lab-rc-stt.nopan', h('span', run.text), h('div.rc-pbar', h('i', { style: { width: Math.max(2, Math.round(100 * (run.frac || 0))) + '%' } })),
      h('button.btn.xs', { on: { pointerdown: stop, click: function (e) { e.stopPropagation(); run.ctl.abort(); } } }, 'Stop'));
    if (!S) return h('div.lab-rc-stt');
    var st = S.ready(), err = STTERR[id];
    var setup = h('button.btn.xs', { title: 'Settings → Speech to text, on the lab site', on: { pointerdown: stop, click: function (e) { e.stopPropagation(); openRM('/rm/pages/settings.html?tab=speech'); } } }, 'Set up speech to text ↗');
    if (!st.ok) return h('div.lab-rc-stt.nopan', err ? h('span.lab-rc-err', err + ' ') : null, setup,
      h('span.tiny.muted', st.why === 'key' ? ' Add your ' + S.PROVIDERS[st.provider].name + ' key there.' : ' Free on your device, or your own OpenAI or Google key.'));
    var cost = S.estimate(r.dur || 0, st.provider), P = S.PROVIDERS[st.provider];
    var label = st.provider === 'device' ? 'Transcribe on this device — free' : 'Transcribe — ' + (/^under/.test(cost.text) ? '' : 'about ') + cost.text;
    return h('div.lab-rc-stt.nopan', err ? h('span.lab-rc-err', err + ' ') : null,
      h('button.btn.xs.pri', { title: P.name + (st.provider === 'device' ? '' : ', billed to ' + P.who), on: { pointerdown: stop, click: function (e) { e.stopPropagation(); transcribeRec(id); } } }, err ? 'Try again' : label),
      h('span.tiny.muted', ' ' + (st.provider === 'device' ? 'Whisper in this browser; it can take a while.' : (r.dur ? C_mmss(r.dur) + ' with ' + P.name + ', billed to ' + P.who + '.' : 'with ' + P.name + ', billed to ' + P.who + '.'))));
  }
  function C_mmss(t) { var C = rcore(); return C ? C.mmss(t) : Math.round(t) + ' s'; }
  function decorateRec(el, b, ro) {
    var C = rcore(), cur = M.block(b.id) || b, r = REC.r(cur), live = !!(REC.active && REC.active.id === b.id), dur = r.dur || 0, has = r.state !== 'new' && r.state !== 'recording';
    if (!el || !el.querySelector) return;
    // the marks list says what each one is (its glyph, a word for any but the plain ◆) and its span; the glyph
    // opens the choices
    if (C) {
      var ms = r.marks || [];
      [].forEach.call(el.querySelectorAll('.rc-mk'), function (mk, i) {
        var m = ms[i]; if (!m) return; var k = C.KIND[C.kindOf(m.kind)], tb = mk.querySelector('.rc-mt'), mid = m.id;
        mk.classList.add('lab-k-' + k.id);
        if (tb) tb.textContent = C.mmss(m.t) + (m.end === null ? ' → …' : typeof m.end === 'number' ? ' → ' + C.mmss(m.end) : '');
        var txt = k.glyph + (k.id === 'important' ? '' : ' ' + k.label);
        mk.insertBefore(ro ? h('span.lab-mk-k', { title: k.label }, txt)
          : h('button.lab-mk-k', { 'data-mark': mid, title: k.label + ' — tap to say what this bookmark is', on: { pointerdown: function (e) { e.stopPropagation(); }, click: function (e) { e.stopPropagation(); markMenu(b.id, mid, e); } } }, txt), mk.firstChild);
      });
      var prog = el.querySelector('.rc-prog');
      if (prog && dur && !live) ms.filter(function (m) { return typeof m.end === 'number'; }).forEach(function (m) {
        prog.append(h('b.lab-rc-band', { style: { left: (100 * m.t / dur) + '%', width: Math.max(0.5, 100 * (m.end - m.t) / dur) + '%' }, title: C.markLabel(m) + ' · ' + C.mmss(m.t) + '–' + C.mmss(m.end) })); });
    }
    var st = el.querySelector('.rc-status');
    if (st && r.state === 'saved') {
      st.className = 'rc-status lab-rc-saved'; st.replaceChildren(h('span', 'Saved in the lab’s cloud' + (r.bytes ? ' (' + REC.kb(r.bytes) + ')' : '') + '.'));
      if (!ro && !(r.segs || []).length) st.after(sttEl(cur));
    }
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
    if (st12) st12.textContent += '.lab-mk-k{border:0;background:none;padding:0 3px 0 0;font:inherit;font-weight:600;color:var(--teal);cursor:pointer}' +
      '.rc-mk.lab-k-question .lab-mk-k{color:#B5761B}.rc-mk.lab-k-decision .lab-mk-k{color:#4A5651}.rc-mk.lab-k-todo .lab-mk-k{color:#1E5E8C}' +
      '.rc-prog{position:relative}.lab-rc-band{position:absolute;top:0;bottom:0;background:color-mix(in srgb,var(--teal) 28%,transparent);border-radius:2px;pointer-events:auto}' +
      '.lab-rc-stt{display:flex;flex-wrap:wrap;align-items:center;gap:6px;margin:4px 0}.lab-rc-stt .rc-pbar{flex:1 1 120px;min-width:80px}.lab-rc-err{color:var(--red,#b42318);font-size:12px}.lab-rc-recover{margin:6px 0}.lab-rc-ink{margin-top:4px}';
  } catch (e) { warn('css 12', e); }

  /* ---- 13. Lit reviews (V3.889, CodeLog/ClaudesPlan/V3.889_scientia_lit_reviews_tab.md) ----
     Alex: "a tab specifically for researching various topics. these are a canvas of notes that can be linked to one
     or more projects". A review is one of Gabe's notes (type `literature`, outside any project) carrying
     `review { topic, projectIds }`: a canvas of papers, quotes and notes on one topic. It lives in its own tab, its
     first block holds its title, topic and the projects it serves (any number), and it shows in each linked
     project's region and page — and, through the hub's notes index, on those projects' cards in RM. His desktop
     sees an ordinary literature note. */
  function isReview(d) { return !!(d && !d.deleted && d.review && typeof d.review === 'object'); }
  function reviewProjects(d) { return isReview(d) ? (d.review.projectIds || []).map(function (id) { return M.project(id); }).filter(Boolean) : []; }
  function reviews() { return DB.where('documents', isReview).sort(byModified); }
  function reviewsOf(pid) { return reviews().filter(function (d) { return (d.review.projectIds || []).indexOf(pid) >= 0; }); }
  function reviewStats(d) {
    var o = { papers: 0, quotes: 0, notes: 0 };
    try { M.liveBlocks(d.id).forEach(function (b) { if (b.kind === 'pdf') o.papers++; else if (b.quote) o.quotes++; else o.notes++; }); } catch (e) {}
    return o;
  }
  function reviewLine(d) { var st = reviewStats(d); return [plural(st.papers, 'paper'), plural(st.quotes, 'quote'), plural(st.notes, 'note')].join(' · '); }
  function newReview(pre) {
    pre = pre || {};
    var d = M.createDoc({ type: 'literature', projectId: null, themeId: null, title: pre.title || 'Literature review · ' + fmtDay(new Date()), templateId: null });
    var cur = M.doc(d.id); cur.review = { topic: pre.topic || '', projectIds: (pre.projectIds || []).filter(function (id) { return !!M.project(id); }) };
    DB.put('documents', cur); seedSig(cur);
    var f = cur.blockIds.map(M.block).filter(Boolean)[0]; DocView.pendingFocus = f ? { focus: f.id, pos: 0 } : null;
    App.go('#/doc/' + d.id);
    return cur;
  }
  function setReview(docId, patch) {
    var d = M.doc(docId); if (!isReview(d)) return; seedSig(d);
    d.review = Object.assign({}, d.review, patch); M.touchDoc(d); changed();
  }
  function linkProject(docId, pid) {
    var d = M.doc(docId), p = M.project(pid); if (!isReview(d) || !p || (d.review.projectIds || []).indexOf(pid) >= 0) return;
    setReview(docId, { projectIds: (d.review.projectIds || []).concat([pid]) }); toast('Linked to ' + p.name);
  }
  function unlinkProject(docId, pid) {
    var d = M.doc(docId), p = M.project(pid); if (!isReview(d)) return;
    setReview(docId, { projectIds: (d.review.projectIds || []).filter(function (x) { return x !== pid; }) }); toast(p ? 'No longer linked to ' + p.name : 'Unlinked');
  }
  LAB.reviews = { list: reviews, of: reviewsOf, create: newReview, set: setReview, link: linkProject, unlink: unlinkProject, isReview: isReview };

  /* the review's first block: title, topic, the projects it serves (any number), and who reads it in RM */
  function reviewFields(d) {
    var stop = function (e) { e.stopPropagation(); }, rv = d.review || {}, linked = reviewProjects(d), ids = linked.map(function (p) { return p.id; });
    var byName = function (a, b) { return String(a.name || '').localeCompare(String(b.name || '')); };
    var ps = DB.all('projects').filter(function (p) { return ids.indexOf(p.id) < 0 && !(p.rm && p.rmAssigned === false); });
    var assigned = ps.filter(function (p) { return p.rm; }).sort(function (a, b) { return rank(a) - rank(b) || byName(a, b); }), own = ps.filter(function (p) { return !p.rm; }).sort(byName);
    var opt = function (p) { return h('option', { value: p.id }, p.name); };
    var title = h('input.hin.lab-h-title', { value: d.title || '', placeholder: 'What this review is about', on: { pointerdown: stop, keydown: function (e) { e.stopPropagation(); if (e.key === 'Enter') e.target.blur(); }, change: function (e) { setTitle(d.id, e.target.value); } } });
    var topic = h('textarea.hin.lab-h-topic', { rows: 2, placeholder: 'The question this review asks', on: { pointerdown: stop, keydown: stop, change: function (e) { setReview(d.id, { topic: e.target.value.trim() }); } } });
    topic.value = rv.topic || '';
    var chips = linked.map(function (p) {
      return h('span.pill.lab-lr-chip', { 'data-project': p.id }, h('a', { href: '#/project/' + p.id, title: 'Open the project' }, p.name),
        h('button.lab-lr-x', { title: 'Unlink this project', on: { pointerdown: stop, click: function (e) { e.stopPropagation(); unlinkProject(d.id, p.id); } } }, '×'));
    });
    var add = h('select.hin.lab-h-link', { on: { pointerdown: stop, change: function (e) { var v = e.target.value; e.target.value = ''; if (v) linkProject(d.id, v); } } },
      h('option', { value: '' }, linked.length ? '+ Link another project…' : '+ Link a project…'),
      assigned.length ? h('optgroup', { label: 'Assigned to you' }, assigned.map(opt)) : null, own.length ? h('optgroup', { label: 'Your projects' }, own.map(opt)) : null);
    return h('div.hgrid.lab-hmeta.lab-hrev', { 'data-doc': d.id },
      h('label.hf', h('span', 'Title'), title), h('label.hf', h('span', 'Topic'), topic),
      h('div.hf', h('span', 'Projects'), h('div.lab-lr-links', chips, add)),
      rmLinked(d) ? h('div.hf.lab-h-share', h('span', 'Seen by'), shareEl(d.id)) : null);
  }

  /* the tab */
  function reviewCard(d) {
    var st = reviewStats(d), linked = reviewProjects(d);
    return h('div.box.dcard.lab-lrcard.nopan', { 'data-doc': d.id, on: { click: function () { App.go('#/doc/' + d.id); } } },
      h('div.row', h('span.pill', 'Lit review'), fromChip(d), d.share === 'lab' ? h('span.pill.teal', { title: 'Lab members can read it in RM' }, 'lab') : null, h('span.spacer'), h('span.mono.tiny.muted', fmtDay(d.modified)), shareBtn('review', d)),
      h('div.dn', d.title),
      d.review.topic ? h('div.lab-q', snippet(d.review.topic, 200)) : null,
      h('div.ds', [plural(st.papers, 'paper'), plural(st.quotes, 'quote'), plural(st.notes, 'note')].join(' · ')),
      h('div.lab-lr-ps', linked.length ? linked.map(function (p) { return h('a.pill' + (p.rm ? '.teal' : ''), { href: '#/project/' + p.id, title: 'Open the project', on: { click: function (e) { e.stopPropagation(); } } }, p.name); })
        : h('span.tiny.muted', 'Not linked to a project yet')));
  }
  var LRV = { filter: '' };
  LAB.reviewsView = LRV;
  VIEWS.litreviews = {
    title: true,
    render: function () {
      var all = reviews(), used = {}, f = LRV.filter && M.project(LRV.filter) ? LRV.filter : '';
      all.forEach(function (d) { reviewProjects(d).forEach(function (p) { used[p.id] = p; }); });
      var list = f ? all.filter(function (d) { return (d.review.projectIds || []).indexOf(f) >= 0; }) : all, ups = Object.keys(used).map(function (k) { return used[k]; }).sort(function (a, b) { return String(a.name).localeCompare(String(b.name)); });
      App.setTitle('Lit reviews', [h('span', plural(all.length, 'review'))]);
      var filt = ups.length ? h('select.inp.lab-lr-filter', { on: { change: function (e) { LRV.filter = e.target.value; App.refresh(); } } },
        h('option', { value: '' }, 'Every project'), ups.map(function (p) { return h('option', { value: p.id, selected: p.id === f }, p.name); })) : null;
      return h('div.page.lab-lr',
        h('div.eyebrow', 'Research'), h('h1.title', 'Literature reviews'),
        h('p.stand', 'A review is a canvas for researching one topic: the papers, the quotes that matter, and your notes on them. Link it to every project it serves; it shows there too.'),
        h('div.row.lab-lr-bar', btn('pri', '+ New review', function () { newReview({ projectIds: f ? [f] : [] }); }, 'A blank canvas; its title, topic and projects are in its first block'), filt),
        list.length ? reviewSections(list)
          : h('div.empty', all.length ? 'No review is linked to this project yet.' : 'No literature reviews yet. + New review opens a blank canvas; give it a topic and link it to your projects in its first block.'));
    }
  };
  try {
    var after = 0; TABS.forEach(function (t, i) { if (t[0] === 'portfolio') after = i + 1; });
    if (!TABS.some(function (t) { return t[0] === 'litreviews'; })) TABS.splice(after, 0, ['litreviews', 'Lit reviews']);
    TABOF.litreviews = 'litreviews';
    /* a review open on screen lights its own tab */
    var oTabs = App.renderTabs;
    App.renderTabs = function () {
      var r = App.route || {}, d = r.name === 'doc' ? M.doc((r.args || [])[0]) : null, was = TABOF.doc;
      if (isReview(d)) TABOF.doc = 'litreviews';
      try { return oTabs.apply(this, arguments); } finally { TABOF.doc = was; }
    };
    /* reviews are not quick notes */
    var oGenDocs = GENERAL.docs;
    GENERAL.docs = function () { return oGenDocs.apply(this, arguments).filter(function (d) { return !isReview(d); }); };
    /* the note's meta line: a review says what it is and where it is linked (instead of "General · not tied to a project") */
    var oDocRender13 = DocView.render;
    DocView.render = function (docId) {
      var host = oDocRender13.apply(this, arguments), d = M.doc(docId), pane = this;
      if (isReview(d) && pane === App.pane) setTimeout(function () {
        var meta = $('#meta'); if (!meta) return; $$('.gen-touch', meta).forEach(function (x) { x.remove(); });
        if ($('.lab-lr-meta', meta)) return; var ps = reviewProjects(M.doc(docId));
        meta.append(h('span.lab-lr-meta', h('span.pill', 'Lit review'), ps.length ? [' for ', ps.map(function (p, i) { return [i ? ', ' : '', h('a', { on: { click: function () { App.go('#/project/' + p.id); } } }, p.name)]; })] : ' · not linked to a project yet'));
      }, 40);
      return host;
    };
  } catch (e) { warn('lit reviews', e); }
  try {
    var st13 = document.getElementById('lab-mode-css');
    if (st13) st13.textContent += '.lab-lr-grid{display:grid;grid-template-columns:repeat(auto-fill,minmax(280px,1fr));gap:12px;margin-top:14px}' +
      '.lab-lr .box,.lab-pv-lr .box{position:relative;left:auto;top:auto}.lab-lrcard{height:auto;min-height:120px;display:flex;flex-direction:column;gap:3px;padding:10px 12px}' +
      '.lab-lrcard .dn{white-space:normal;font-size:14px;line-height:1.3}.lab-lr-ps{display:flex;flex-wrap:wrap;gap:4px;margin-top:auto;padding-top:6px}.lab-lr-ps a.pill{text-decoration:none;cursor:pointer}' +
      '.lab-lr-bar{gap:8px;align-items:center}.lab-lr-filter{max-width:280px}.lab-pv-lr{margin:16px 0}' +
      '.lab-lr-links{display:flex;flex-wrap:wrap;gap:5px;align-items:center}.lab-lr-links .lab-h-link{flex:1 1 180px;width:auto}.lab-lr-chip{display:inline-flex;align-items:center;gap:4px}' +
      '.lab-lr-chip a{color:inherit;text-decoration:none}.lab-lr-x{border:0;background:none;padding:0 2px;cursor:pointer;color:var(--ink-3);font:inherit}.lab-lr-x:hover{color:var(--bad)}' +
      '.lab-hmeta textarea.hin{width:100%;box-sizing:border-box;resize:vertical;font:inherit}.lab-lr-meta{margin-left:8px}';
  } catch (e) { warn('css 13', e); }

  /* ---- 14. PDF cards draw on demand (V3.894, CodeLog/ClaudesPlan/V3.894_scientia_pdf_cards_on_demand.md) ----
     (class names pdf-ph / pdf-far are the ones the same change in Gabe's 13zk uses, so tests and CSS hold for either)
     Alex: "when there are too many pdf's on the canvas it seems to slow down and the site glitches". Gabe's PDF card
     (13zk PDFW.body) loads its file and draws the first pages of its own scroll area as soon as the note opens, on
     screen or not, and every changed() rebuilds every box — so each sync from another device redrew every PDF. The ERK
     review (28 PDFs) drew 57 pages (4 on screen, 383 MB at 2×) and redrew them all on a sync. Here a card keeps its
     viewer across a rebuild while it shows the same thing, draws only while on screen and only as sharp as the zoom
     needs, gives its pages back when it leaves, shows its title when zoomed far out, and fetches only the parts of the
     file it draws. The maximised view and the phone layout keep Gabe's drawing (they pass no paper). Stands down if his
     PDFW gains this itself (PDFW.onDemand). */
  try {
    if (typeof PDFW !== 'undefined' && !PDFW.onDemand) (function () {
      var oBody = PDFW.body, oWords = PDFW.words, noop = function () {};
      var PD = { live: new Map(), cards: new Set(), aspect: new Map(), used: new Map(), pin: {}, q: [], busy: 0, n: 0,
        minZ: 0.33, margin: '400px', idleMs: 4000, keepDocs: 6, maxJobs: 2 };
      LAB.pdf = PD;
      function zoomOf(C) { var p = C.pane && C.pane.paper; return (p && p.view && p.view.z) || 1; }
      function resOf(C) { var r = zoomOf(C) * (window.devicePixelRatio || 1); return Math.min(3, Math.max(0.5, Math.round(r * 4) / 4)); }
      function sigOf(b, ro) { return [b.media, b.view || 'scroll', b.view === 'page' ? (b.cur || 0) : '', b.pages || 0, b.w || 616, b.h || 560, ro ? 1 : 0].join('|'); }
      function widthOf(C) { return Math.max(200, (C.stage.clientWidth || ((C.b.w || 616) - 24)) - 16); }
      function blank(W, a) { var cv = h('canvas.pdf-page', { style: { width: W + 'px', height: Math.round(W * a) + 'px' } }); cv.width = 0; cv.height = 0; return cv; }

      /* only the parts of the file that get drawn (range requests); otherwise Gabe's load */
      PDFW.load = function (m) {
        READER.init(); if (!window.pdfjsLib) return Promise.reject(new Error('PDF support is missing'));
        if (!PDFW.docs.has(m.id)) PDFW.docs.set(m.id, pdfjsLib.getDocument({ url: MEDIA.url(m), isEvalSupported: false, disableAutoFetch: true, disableStream: true }).promise);
        PD.used.set(m.id, Date.now());
        return PDFW.docs.get(m.id);
      };
      /* reading a new PDF's words for Search keeps its document loaded until done */
      PDFW.words = function (b) {
        var id = b && b.media; PD.pin[id] = (PD.pin[id] || 0) + 1;
        return Promise.resolve(oWords.apply(this, arguments)).then(function (r) { PD.pin[id]--; return r; }, function (e) { PD.pin[id]--; throw e; });
      };

      PDFW.body = function (b, d, pane, ro) {
        if (!b || !pane || pane.maxView || !pane.paper || !MEDIA.get(b.media)) return oBody.apply(this, arguments);
        var key = (pane._pdk || (pane._pdk = ++PD.n)) + ':' + b.id, hit = PD.live.get(key), sig = sigOf(b, ro);
        if (hit && hit.b === b && hit.sig === sig && !hit.dead) {   // the same viewer, canvases intact
          if (hit.bar.parentNode !== hit.el) hit.el.insertBefore(hit.bar, hit.stage);   // Gabe's SLIM moved the bar into the old box's header; the new box docks it again
          want(hit); return hit.el;
        }
        if (hit) drop(hit);
        var C = card(b, pane, ro, sig); C.key = key; PD.live.set(key, C); return C.el;
      };
      if (typeof WIDGETS !== 'undefined' && WIDGETS.pdf && WIDGETS.pdf.body === oBody) WIDGETS.pdf.body = PDFW.body;   // the box and repaint call it through WIDGETS

      /* the card: Gabe's bar and stage (13zk PDFW.body), page slots sized but not drawn */
      function card(b, pane, ro, sig) {
        var m = MEDIA.get(b.media), n = b.pages || 0, page = b.view === 'page', cur = clamp(b.cur || 0, 0, Math.max(0, n - 1));
        var set = function (k, v) { var B = M.block(b.id); B[k] = v; DOCS.save(B); DOCS.repaint(B); };
        var count = h('span.dk-count.mono', n ? (page ? (cur + 1) + ' / ' + n : plural(n, 'page')) : '…');
        var bar = h('div.dk-bar.pdf-bar', DOCS.seg([['scroll', 'Pages'], ['page', 'One at a time']], b.view || 'scroll', function (v) { set('view', v); }), count,
          DOCS.btn('⤢', 'Maximise', function () { DOCS.max(M.block(b.id)); }),
          h('a.btn.xs', { href: MEDIA.url(m), target: '_blank', rel: 'noopener', title: 'Open in a new tab', on: { click: function (e) { e.stopPropagation(); } } }, '↗'),
          ro ? null : DOCS.btn('Replace', 'Replace the file', function () { PLATE.pickFiles(function (fs) { MEDIA.add(fs[0]).then(function (r) { if (r.kind !== 'pdf') return toast('That is not a PDF'); var B = M.block(b.id); B.media = r.id; B.pages = 0; B.cur = 0; DOCS.save(B); DOCS.repaint(B); PDFW.words(B); }); }, false, '.pdf'); }));
        var stage = h('div.pdf-stage.scrolly.nopan' + (page ? '.one' : ''), { style: { height: (b.h || 560) + 'px' } });
        var ph = h('div.pdf-ph', h('b', b.label || 'PDF'), h('span', n ? plural(n, 'page') : ''));
        var el = h('div.pdfw', bar, stage, ph);
        if (!ro) el.append(DOCS.grip(b, stage, pane));
        el.addEventListener('mouseenter', function () { DOCS.hover = b.id; }); el.addEventListener('mouseleave', function () { if (DOCS.hover === b.id) DOCS.hover = null; });
        var C = { b: b, m: m, pane: pane, el: el, bar: bar, stage: stage, ph: ph, count: count, sig: sig, page: page, cur: cur, n: n, slots: [], one: null, W: 0, vis: false, active: false, pdf: null, idleT: null, gone: 0 };
        el._pd = C; PD.cards.add(C); sweeping();
        if (page) {
          C.one = h('div.dk-stage.pdf-one', blank(200, 1.294),
            h('button.dk-nav.prev', { disabled: cur === 0, on: { click: function (e) { e.stopPropagation(); PDFW.go(M.block(b.id), cur - 1); } } }, '‹'),
            h('button.dk-nav.next', { disabled: !!n && cur >= n - 1, on: { click: function (e) { e.stopPropagation(); PDFW.go(M.block(b.id), cur + 1); } } }, '›'));
          stage.replaceChildren(C.one);
        } else {
          if (n) slotsFor(C, n);
          stage.addEventListener('scroll', debounce(function () {
            var top = stage.scrollTop, k = C.slots.findIndex(function (s) { return s.offsetTop + s.offsetHeight > top + 20; });
            if (k >= 0) { var B = M.block(b.id); if (B && B.cur !== k) { B.cur = k; DOCS.save(B); } }
          }, 300));
          if (cur) requestAnimationFrame(function () { var s = C.slots[cur]; if (s) stage.scrollTop = s.offsetTop - 4; });
        }
        cardIO().observe(el);
        return C;
      }
      function slotsFor(C, n) {
        var W = C.W = C.W || widthOf(C), a = PD.aspect.get(C.m.id) || 1.294;
        C.slots = []; for (var i = 1; i <= n; i++) C.slots.push(h('div.pdf-slot', { 'data-p': i }, blank(W, a), h('span.pdf-pn', i)));
        C.stage.replaceChildren.apply(C.stage, C.slots);
        C.pio = new IntersectionObserver(function (es) {
          es.forEach(function (en) { en.target._in = en.isIntersecting; if (!en.isIntersecting && en.target._res) releaseSlot(en.target); });
          want(C);
        }, { root: C.stage, rootMargin: '200px 0px' });
        C.slots.forEach(function (s) { C.pio.observe(s); });
      }
      function cardIO() {
        return PD.io || (PD.io = new IntersectionObserver(function (es) {
          es.forEach(function (en) { var C = en.target._pd; if (C) { C.vis = en.isIntersecting; want(C); } });
        }, { rootMargin: PD.margin }));
      }

      /* on screen (and zoomed in enough) → draw; away for a while → give the pages back */
      function want(C) { if (C.raf || C.dead) return; C.raf = requestAnimationFrame(function () { C.raf = 0; update(C); }); }
      function onScreen(C) { return C.vis && C.el.isConnected && zoomOf(C) >= PD.minZ; }
      function update(C) {
        if (C.dead) return;
        var far = zoomOf(C) < PD.minZ, st = C.stage;
        if (far) C.ph.style.cssText = 'top:' + st.offsetTop + 'px;left:' + st.offsetLeft + 'px;width:' + st.offsetWidth + 'px;height:' + st.offsetHeight + 'px';
        C.el.classList.toggle('pdf-far', far);
        if (onScreen(C)) { clearTimeout(C.idleT); C.idleT = null; if (C.active) plan(C); else activate(C); }
        else if (C.active && !C.idleT) C.idleT = setTimeout(function () { C.idleT = null; if (!onScreen(C)) release(C); }, zoomOf(C) < PD.minZ ? 600 : PD.idleMs);
      }
      function activate(C) {
        C.active = true;
        PDFW.load(C.m).then(function (pdf) {
          if (!C.active || C.dead) return;
          var B = M.block(C.b.id);
          if (B && (!B.pages || B.pages !== pdf.numPages)) { B.pages = pdf.numPages; DOCS.save(B); C.count.textContent = C.page ? (C.cur + 1) + ' / ' + pdf.numPages : plural(pdf.numPages, 'page'); if (!/Page 1\n/.test((B.body && B.body.text) || '')) PDFW.words(B); }
          var go = function () {
            if (!C.active || C.dead) return; C.pdf = pdf;
            if (!C.page) {
              var W = widthOf(C);
              if (!C.slots.length) { C.W = W; slotsFor(C, pdf.numPages); }
              else if (Math.abs(W - C.W) > 1) { C.W = W; C.slots.forEach(function (s) { releaseSlot(s); s.replaceChild(blank(W, PD.aspect.get(C.m.id) || 1.294), s.querySelector('canvas.pdf-page')); }); }
            } else C.W = widthOf(C);
            plan(C);
          };
          if (PD.aspect.has(C.m.id)) return go();
          pdf.getPage(1).then(function (pg) {
            var v = pg.getViewport({ scale: 1 }), a = v.height / v.width; PD.aspect.set(C.m.id, a);
            C.slots.forEach(function (s) { if (!s._res) { var cv = s.querySelector('canvas.pdf-page'); if (cv) cv.style.height = Math.round(parseFloat(cv.style.width) * a) + 'px'; } });
            go();
          }, go);
        }).catch(function (e) { if (!C.dead) C.stage.replaceChildren(h('div.embed-missing', 'Could not open the PDF: ' + (e.message || e))); });
      }
      function plan(C) {
        if (!C.active || !C.pdf) return;
        var res = resOf(C), off = function (s) { return !s._res || s._res < res * 0.8 || s._res > res * 2; };
        if (C.page) { if (off(C.one)) enqueue(C, C.one, res); }
        else C.slots.forEach(function (s) { if (s._in && off(s)) enqueue(C, s, res); });
        pump();
      }
      function enqueue(C, s, res) { if (s._job) { s._job.res = res; return; } s._job = { C: C, s: s, res: res }; PD.q.push(s._job); }
      function pump() {
        while (PD.busy < PD.maxJobs && PD.q.length) {
          var j = PD.q.shift(); j.s._job = null;
          if (!j.C.active || j.C.dead || !j.C.pdf || (!j.C.page && !j.s._in)) continue;
          PD.busy++;
          draw(j).catch(noop).then(function () { PD.busy--; pump(); });
        }
      }
      /* a page into a NEW canvas, swapped in when done (a redraw at another zoom never flashes white) */
      function draw(j) {
        var C = j.C, s = j.s, n = C.page ? clamp(C.cur, 0, C.pdf.numPages - 1) + 1 : +s.dataset.p;
        return C.pdf.getPage(n).then(function (pg) {
          var v0 = pg.getViewport({ scale: 1 }), W = C.W;
          if (C.page) W = Math.floor(Math.min(C.W, ((C.stage.clientHeight || 500) - 12) * v0.width / v0.height));
          var sc = W / v0.width, vp = pg.getViewport({ scale: sc * j.res }), cv = h('canvas.pdf-page');
          cv.width = Math.round(vp.width); cv.height = Math.round(vp.height); cv.style.width = W + 'px'; cv.style.height = Math.round(v0.height * sc) + 'px';
          return pg.render({ canvasContext: cv.getContext('2d'), viewport: vp }).promise.then(function () {
            try { pg.cleanup(); } catch (e) {}
            if (!C.active || C.dead || !s.isConnected) { cv.width = 0; cv.height = 0; return; }
            var old = s.querySelector('canvas.pdf-page'); if (old) { s.replaceChild(cv, old); old.width = 0; old.height = 0; } else s.prepend(cv);
            var first = !s._res; s._res = j.res;
            // what Gabe's PDFW.page wrapper (13zw) does after a draw: the text layer and the quotes highlighted on it
            if ((first || !s.querySelector('.textLayer')) && typeof QUOTE !== 'undefined' && QUOTE.textLayer) QUOTE.textLayer(C.m, n, cv, W).catch(noop);
          });
        });
      }
      function releaseSlot(s) {
        if (s._res) { var cv = s.querySelector('canvas.pdf-page'); if (cv) { cv.width = 0; cv.height = 0; } }
        s._res = 0; $$(':scope > .textLayer, :scope > .q-marks', s).forEach(function (x) { x.remove(); });
      }
      function release(C) {
        C.active = false; C.pdf = null;
        C.slots.forEach(releaseSlot); if (C.one) releaseSlot(C.one);
        trimDocs();
      }
      function drop(C) {
        if (C.dead) return; release(C); C.dead = true; clearTimeout(C.idleT);
        if (PD.io) PD.io.unobserve(C.el); if (C.pio) C.pio.disconnect();
        PD.cards.delete(C); if (PD.live.get(C.key) === C) PD.live.delete(C.key);
      }
      /* keep at most a few parsed PDFs that no card on screen is using */
      function trimDocs() {
        var inUse = {}; PD.cards.forEach(function (C) { if (C.active) inUse[C.m.id] = 1; });
        if (DOCS._max) { var mb = M.block(DOCS._max.id); if (mb) inUse[mb.media] = 1; }
        var idle = []; PDFW.docs.forEach(function (p, id) { if (!inUse[id] && !PD.pin[id]) idle.push(id); });
        idle.sort(function (a, b) { return (PD.used.get(a) || 0) - (PD.used.get(b) || 0); });
        while (idle.length > PD.keepDocs) { var id = idle.shift(), p = PDFW.docs.get(id); PDFW.docs.delete(id); PD.used.delete(id); p.then(function (doc) { doc.destroy(); }, noop); }
      }
      /* a card whose note was closed (or that was removed) lets go after ~10 s; a rebuild re-attaches it at once */
      function sweeping() {
        if (PD.sweep) return;
        PD.sweep = setInterval(function () {
          PD.cards.forEach(function (C) { if (C.el.isConnected) C.gone = 0; else if (++C.gone >= 2) drop(C); });
          if (!PD.cards.size) { clearInterval(PD.sweep); PD.sweep = null; trimDocs(); }
        }, 5000);
      }
      /* zoom: redraw what is on screen at the new sharpness (and show titles when far out) */
      if (typeof Paper !== 'undefined' && Paper.prototype.apply) {
        var oApply = Paper.prototype.apply;
        Paper.prototype.apply = function () {
          var r = oApply.apply(this, arguments);
          if (PD.cards.size) { clearTimeout(PD.zt); PD.zt = setTimeout(function () { PD.cards.forEach(function (C) { if (C.el.isConnected) want(C); }); }, 220); }
          return r;
        };
      }
      /* a quote's "from …" into a PDF while zoomed far out (titles showing): zoom in to read it — Gabe's reveal only
         zooms when the card is off screen */
      if (typeof QUOTE !== 'undefined' && QUOTE.goto) {
        var oGoto = QUOTE.goto;
        QUOTE.goto = function (q) {
          var r = oGoto.apply(this, arguments);
          try {
            var src = q && q.quote && M.block(q.quote.src), dv = src && src.kind === 'pdf' && DocView.docId === src.docId ? DocView : null, P = dv && dv.paper, rc;
            if (P && P.view.z < PD.minZ && (rc = dv.rectOf(src.id))) P.centerOn(rc.x + rc.w / 2, rc.y + Math.min(rc.h, 300) / 2, 0.8);
          } catch (e) {}
          return r;
        };
      }
      PD.stats = function () {
        var o = { cards: 0, active: 0, drawn: 0, mb: 0, docs: PDFW.docs.size, queued: PD.q.length };
        PD.cards.forEach(function (C) { if (C.el.isConnected) { o.cards++; if (C.active) o.active++; } });
        $$('.pdfw canvas.pdf-page').forEach(function (c) { if (c.width > 0 && c.height > 0) { o.drawn++; o.mb += c.width * c.height * 4; } });
        o.mb = Math.round(o.mb / 1048576); return o;
      };
      PDFW.stats = PD.stats; PDFW.labOnDemand = true;   // stats: the same call as Gabe's version (PDFW.onDemand) will offer
    })();
  } catch (e) { warn('pdf on demand', e); }
  try {
    var st14 = document.getElementById('lab-mode-css');
    if (st14) st14.textContent += '.pdfw .pdf-ph{display:none;position:absolute;box-sizing:border-box;flex-direction:column;align-items:center;justify-content:center;gap:12px;' +
      'text-align:center;padding:24px;border-radius:6px;background:var(--surface-2);color:var(--ink-2);font-size:44px;line-height:1.15;pointer-events:none;overflow:hidden}' +
      '.pdfw.pdf-far .pdf-ph{display:flex}.pdfw .pdf-ph span{font-size:30px;color:var(--ink-3)}';
  } catch (e) { warn('css 14', e); }

  /* ---- 14. The install banner at the top (V3.896) ----
     Alex: "the install scientia should show up at the top of the page" — Gabe's #insbanner (13zo) sits at the bottom
     centre, over the bottom bar and the Quick cast; on the web it goes to the top: under the header and below the
     canvas's top row (his ink bar on the left, his tool buttons on the right) — the header is measured, so a phone or
     focus mode with a shorter header still fits. */
  function placeInstall() {
    var b = document.getElementById('insbanner'); if (!b) return;
    var hd = document.getElementById('hd'), r = hd && hd.offsetParent !== null ? hd.getBoundingClientRect() : null;
    b.classList.add('lab-top'); b.style.top = Math.round((r && r.height ? r.bottom : 0) + 64) + 'px';   // the canvas's top row is 12 + 46 px
    // V3.901: over the note, not the window — a paper read beside the note (13zzb) takes the other half
    var v = document.getElementById('view'), vr = v && v.getBoundingClientRect();
    if (vr && vr.width) { b.style.left = Math.round(vr.left + vr.width / 2) + 'px'; b.style.width = 'min(560px, ' + Math.round(vr.width - 24) + 'px)'; }
  }
  try {
    if (typeof INSTALL !== 'undefined' && INSTALL.banner) { var oBanner = INSTALL.banner; INSTALL.banner = function () { var r = oBanner.apply(this, arguments); try { placeInstall(); } catch (e) {} return r; }; }
    addEventListener('resize', debounce(placeInstall, 150)); placeInstall();
    var st14 = document.getElementById('lab-mode-css');
    if (st14) st14.textContent += '#insbanner.lab-top{bottom:auto;top:calc(136px + env(safe-area-inset-top))}';
  } catch (e) { warn('install banner', e); }

  /* ---- 15. Share or collaborate (V3.899, CodeLog/ClaudesPlan/V3.899_scientia_share_collaborate.md) ----
     Alex: "share is a read only, collaborate means to be able to edit. this action should be accessable on the card at
     the top right. Also do the same for projects". The grant is `shareWith {uid: 'read' | 'edit'}` on the review note
     or the project (only the owner's copy counts); the hub function copies it into each person's own Scientia and
     carries edits both ways (functions/scientia-share-core.js). A copy carries `sharedFrom {uid, name, role, share}`:
     a read-only copy opens in Gabe's read-only view (his time-travel mode, showing now — every widget already
     respects it); a collaborator's copy edits like any note, its filing stays the owner's. */
  Object.assign(PILL_ICONS, {
    users: '<path d="M15 19.128a9.38 9.38 0 0 0 2.625.372 9.337 9.337 0 0 0 4.121-.952 4.125 4.125 0 0 0-7.533-2.493M15 19.128v-.003c0-1.113-.285-2.16-.786-3.07M15 19.128v.106A12.318 12.318 0 0 1 8.624 21c-2.331 0-4.512-.645-6.374-1.766l-.001-.109a6.375 6.375 0 0 1 11.964-3.07M12 6.375a3.375 3.375 0 1 1-6.75 0 3.375 3.375 0 0 1 6.75 0Zm8.25 2.25a2.625 2.625 0 1 1-5.25 0 2.625 2.625 0 0 1 5.25 0Z"/>',
    'lock-closed': '<path d="M16.5 10.5V6.75a4.5 4.5 0 1 0-9 0v3.75m-.75 11.25h10.5a2.25 2.25 0 0 0 2.25-2.25v-6.75a2.25 2.25 0 0 0-2.25-2.25H6.75a2.25 2.25 0 0 0-2.25 2.25v6.75a2.25 2.25 0 0 0 2.25 2.25Z"/>'
  });
  var SHR = { members: null, loading: null, pop: null, q: '' };
  LAB.share = SHR;
  var ROLE_SAY = { read: 'can read it', edit: 'can edit it' }, CAT_SAY = { pi: 'PI', postdoc: 'Postdoc', grad: 'Graduate student', undergrad: 'Undergraduate', highschool: 'High school', teacher: 'Teacher' };
  function sharedFrom(rec) { return rec && rec.sharedFrom && typeof rec.sharedFrom === 'object' ? rec.sharedFrom : null; }
  function grantsOn(rec) { var g = rec && rec.shareWith && typeof rec.shareWith === 'object' ? rec.shareWith : {}, o = {}; Object.keys(g).forEach(function (u) { if (g[u] === 'read' || g[u] === 'edit') o[u] = g[u]; }); return o; }
  function readOnlyCopy(d) { var f = sharedFrom(d); return !!(f && f.role !== 'edit'); }
  function shareRec(kind, id) { return kind === 'project' ? M.project(id) : M.doc(id); }
  function firstName(n) { return String(n || 'a lab member').split(/\s+/)[0]; }
  function loadMembers() {
    if (SHR.members) return Promise.resolve(SHR.members);
    if (!SHR.loading) SHR.loading = fetch('api/rm/members').then(function (r) { return r.ok ? r.json() : null; }).then(function (j) {
      if (!j || !j.ok) { SHR.loading = null; SHR.failed = true; return []; } SHR.failed = false; SHR.members = j.members || []; return SHR.members;
    }, function () { SHR.loading = null; SHR.failed = true; return []; });
    return SHR.loading;
  }
  function memberName(uid) { var m = (SHR.members || []).filter(function (x) { return x.uid === uid; })[0]; return m ? m.name : null; }
  /** Give one person read or edit (null takes it away). Only on your own record — a copy can't be shared on. */
  function setGrant(kind, id, uid, role) {
    var rec = shareRec(kind, id); if (!rec || sharedFrom(rec) || !uid) return;
    var g = grantsOn(rec); if (role === 'read' || role === 'edit') g[uid] = role; else delete g[uid];
    if (Object.keys(g).length) rec.shareWith = g; else delete rec.shareWith;
    if (kind === 'project') DB.put('projects', rec); else M.touchDoc(rec);
    changed(); kickRm(['shares']);
  }
  LAB.setGrant = setGrant; LAB.loadMembers = loadMembers;
  function shareBtn(kind, rec) {
    var from = sharedFrom(rec), n = Object.keys(grantsOn(rec)).length;
    var tip = from ? 'Shared with you by ' + (from.name || 'a lab member') + ' — you ' + ROLE_SAY[from.role === 'edit' ? 'edit' : 'read']
      : n ? 'Shared with ' + (n === 1 ? '1 person' : n + ' people') + ' — change who can read or edit it' : 'Share it (they can read it) or collaborate (they can edit it) with lab members';
    var b = h('button.lab-sharebtn' + (n || from ? '.on' : ''), { type: 'button', title: tip, 'aria-label': tip, 'data-share-kind': kind, 'data-share-id': rec.id,
      on: { pointerdown: function (e) { e.stopPropagation(); }, click: function (e) { e.stopPropagation(); e.preventDefault(); openShare(b, kind, rec.id); } } });
    b.innerHTML = pic(from ? (from.role === 'edit' ? 'users' : 'lock-closed') : 'users') + (n ? '<span class="lab-sharen">' + n + '</span>' : '');
    return b;
  }
  function fromChip(rec) {
    var f = sharedFrom(rec); if (!f) return null;
    return h('span.pill.lab-from' + (f.role === 'edit' ? '.edit' : ''), { title: 'Shared with you by ' + (f.name || 'a lab member') + (f.role === 'edit' ? ' — you edit it together' : ' — read only') },
      (f.role === 'edit' ? 'With ' : 'From ') + firstName(f.name));
  }
  function reviewSections(list) {
    var mine = list.filter(function (d) { return !sharedFrom(d); }), theirs = list.filter(function (d) { return !!sharedFrom(d); });
    return [mine.length ? h('div.lab-lr-grid', mine.map(reviewCard)) : null,
      theirs.length ? h('h2.lab-lr-h', 'Shared with you') : null, theirs.length ? h('div.lab-lr-grid.lab-lr-shared', theirs.map(reviewCard)) : null];
  }
  /* a collaborator's first block: the title (and a review's topic) are theirs to edit; where it is filed stays the owner's */
  function copyFields(d) {
    var f = sharedFrom(d), edit = f.role === 'edit', stop = function (e) { e.stopPropagation(); }, rows = [];
    rows.push(h('label.hf', h('span', 'Title'), edit ? h('input.hin.lab-h-title', { value: d.title || '', on: { pointerdown: stop, keydown: function (e) { e.stopPropagation(); if (e.key === 'Enter') e.target.blur(); }, change: function (e) { setTitle(d.id, e.target.value); } } }) : h('div.lab-h-ro', d.title || '')));
    if (isReview(d)) { var tp = h('textarea.hin.lab-h-topic', { rows: 2, placeholder: 'The question this review asks', on: { pointerdown: stop, keydown: stop, change: function (e) { setReview(d.id, { topic: e.target.value.trim() }); } } }); tp.value = d.review.topic || ''; rows.push(h('label.hf', h('span', 'Topic'), tp)); }
    var others = Object.keys(grantsOn(d)).map(memberName).filter(Boolean);
    rows.push(h('div.hf', h('span', 'Shared'), h('span.lab-h-from', 'by ' + (f.name || 'a lab member') + ' · you edit it together' + (others.length ? ' · also with ' + others.join(', ') : ''))));
    if (!SHR.members) loadMembers();
    return h('div.hgrid.lab-hmeta.lab-hcopy', { 'data-doc': d.id }, rows);
  }

  function closeShare() {
    if (SHR.pop) { SHR.pop.remove(); SHR.pop = null; }
    if (SHR.off) document.removeEventListener('pointerdown', SHR.off, true);
    if (SHR.key) document.removeEventListener('keydown', SHR.key, true);
    SHR.off = SHR.key = null;
  }
  function openShare(anchor, kind, id) {
    closeShare();
    var pop = SHR.pop = h('div.lab-sharepop.nopan', { role: 'dialog', 'aria-label': 'Share', 'data-share-kind': kind, 'data-share-id': id });
    document.body.append(pop); SHR.q = '';
    var place = function () {
      if (!anchor.isConnected) { var a2 = $('.lab-sharebtn[data-share-kind="' + kind + '"][data-share-id="' + id + '"]'); if (a2) anchor = a2; }
      var r = anchor.getBoundingClientRect(), w = pop.offsetWidth || 340, H = pop.offsetHeight || 300, x = Math.max(8, Math.min(innerWidth - w - 8, r.right - w)), y = r.bottom + 6;
      if (y + H > innerHeight - 8) y = Math.max(8, r.top - H - 6);
      pop.style.left = x + 'px'; pop.style.top = y + 'px';
    };
    var draw = function () { paintShare(pop, kind, id, draw); place(); };
    draw(); loadMembers().then(function () { if (SHR.pop === pop) draw(); });
    SHR.off = function (e) { if (!pop.contains(e.target) && !(anchor.contains && anchor.contains(e.target))) closeShare(); };
    SHR.key = function (e) { if (e.key === 'Escape') { e.stopPropagation(); closeShare(); } };
    setTimeout(function () { if (SHR.pop !== pop) return; document.addEventListener('pointerdown', SHR.off, true); document.addEventListener('keydown', SHR.key, true); }, 0);
    return pop;
  }
  LAB.openShare = openShare; LAB.closeShare = closeShare;
  function paintShare(pop, kind, id, redraw) {
    var rec = shareRec(kind, id); if (!rec) return closeShare();
    var from = sharedFrom(rec), g = grantsOn(rec), what = kind === 'project' ? 'project' : 'review', title = kind === 'project' ? rec.name : rec.title;
    var head = h('div.lab-sh-h', h('b', from ? 'Shared with you' : 'Share this ' + what), h('button.lab-sh-x', { type: 'button', title: 'Close', 'aria-label': 'Close', on: { click: closeShare } }, '×'));
    var sub = h('div.lab-sh-t', snippet(title || '', 90));
    if (from) {
      var others = Object.keys(g).map(function (u) { var n = memberName(u); return n ? n + (g[u] === 'edit' ? ' (edits)' : ' (reads)') : null; }).filter(Boolean);
      pop.replaceChildren(head, sub,
        h('p.lab-sh-p', h('b', from.name || 'A lab member'), from.role === 'edit' ? ' shared it with you to collaborate: you can edit it, and every change reaches everyone who has it.' : ' shared it with you to read. Changes they make reach you; it opens read only.'),
        others.length ? h('p.lab-sh-p.muted', 'Also with ' + others.join(', ') + '.') : null,
        h('p.lab-sh-p.tiny.muted', 'Only ' + firstName(from.name) + ' can change who has it.'));
      return;
    }
    var q = h('input.inp.lab-sh-q', { type: 'search', placeholder: 'Find a lab member…', value: SHR.q, 'aria-label': 'Find a lab member',
      on: { input: function (e) { SHR.q = e.target.value; paintRows(); }, keydown: function (e) { e.stopPropagation(); } } });
    var list = h('div.lab-sh-list');
    function paintRows() {
      var ms = (SHR.members || []).slice(), t = SHR.q.trim().toLowerCase();
      ms.sort(function (a, b) { return (g[b.uid] ? 1 : 0) - (g[a.uid] ? 1 : 0) || String(a.name).localeCompare(String(b.name)); });
      if (t) ms = ms.filter(function (m) { return String(m.name).toLowerCase().indexOf(t) >= 0; });
      list.replaceChildren.apply(list, !SHR.members ? [h('div.lab-sh-empty.tiny.muted', SHR.failed ? 'Could not reach the lab list — try again in a moment.' : 'Loading lab members…')]
        : !ms.length ? [h('div.lab-sh-empty.tiny.muted', t ? 'Nobody by that name.' : 'No other lab members yet.')]
        : ms.map(function (m) {
          var role = g[m.uid] || '';
          var seg = h('span.seg.lab-sh-seg', ['read', 'edit'].map(function (r) {
            return h('button' + (role === r ? '.on' : ''), { type: 'button', 'data-role': r, title: role === r ? 'Tap again to take it away' : (r === 'read' ? m.name + ' can read it' : m.name + ' can edit it'),
              on: { click: function (e) { e.stopPropagation(); setGrant(kind, id, m.uid, role === r ? null : r); toast(role === r ? m.name + ' no longer has it' : (r === 'read' ? 'Shared with ' : 'Collaborating with ') + m.name); redraw(); } } }, r === 'read' ? 'Share' : 'Collaborate');
          }));
          return h('div.lab-sh-row' + (role ? '.on' : ''), { 'data-uid': m.uid }, h('span.lab-sh-av', String(m.name || '?').charAt(0).toUpperCase()),
            h('span.lab-sh-who', h('span.lab-sh-n', m.name), CAT_SAY[m.category] ? h('span.tiny.muted', CAT_SAY[m.category]) : null), seg);
        }));
    }
    paintRows();
    var n = Object.keys(g).length;
    pop.replaceChildren(head, sub, h('p.lab-sh-p.tiny.muted', h('b', 'Share'), ' — they can read it. ', h('b', 'Collaborate'), ' — they can edit it too; everyone’s changes reach everyone.'),
      q, list, h('div.lab-sh-f.tiny.muted', n ? 'Has it: ' + Object.keys(g).map(function (u) { return (memberName(u) || 'a lab member') + (g[u] === 'edit' ? ' (edits)' : ' (reads)'); }).join(', ') + '. It reaches them within seconds.' : 'Only you have it.'));
  }

  /* a read-only copy: Gabe's read-only view, showing now, and its dock says whose it is */
  try {
    var oFill15 = DocView.fill;
    DocView.fill = function (d) {
      var was = !!(this.travel && this.travel.shared), pane = this;
      if (readOnlyCopy(d)) this.travel = { doc: d, blocks: M.docBlocks(d.id), at: new Date(), shared: sharedFrom(d) };
      else if (this.travel && this.travel.shared) this.travel = null;
      var r = oFill15.apply(this, arguments);
      if (was !== !!(this.travel && this.travel.shared)) requestAnimationFrame(function () { paintPills(pane); });   // read only ↔ editable: the wheels follow
      try {
        if (this.travel && this.travel.shared && !this.side) { var f = this.travel.shared; $$('#meta .pill.warn').forEach(function (x) { if (/^as it stood/.test(x.textContent)) { x.textContent = 'Shared by ' + (f.name || 'a lab member') + ' · read only'; x.classList.add('lab-ro-pill'); } }); }
      } catch (x) {}
      return r;
    };
    var oDock15 = DocView.renderDock;
    DocView.renderDock = function (d) {
      var t = this.travel;
      if (t && t.shared && this.dock) { var who = t.shared.name || 'a lab member'; this.dock.replaceChildren(h('span.dk-l.lab-ro', picEl('lock-closed'), 'Shared with you by ' + who + ' · read only — ask ' + firstName(who) + ' to collaborate if you want to edit it')); return; }
      return oDock15.apply(this, arguments);
    };
  } catch (e) { warn('share read only', e); }
  try {
    var st15 = document.getElementById('lab-mode-css');
    if (st15) st15.textContent += '.lab-sharebtn{flex:none;position:relative;display:inline-grid;place-items:center;width:28px;height:28px;margin:-4px -4px -4px 4px;border-radius:50%;border:1px solid transparent;background:none;color:var(--ink-3);cursor:pointer;padding:0}' +
      '.lab-sharebtn svg{width:17px;height:17px}.lab-sharebtn:hover{border-color:var(--rule-2);color:var(--ink)}.lab-sharebtn.on{color:var(--teal)}' +
      '.lab-sharen{position:absolute;right:-3px;top:-3px;min-width:15px;height:15px;padding:0 3px;box-sizing:border-box;border-radius:8px;background:var(--teal);color:var(--paper);font:600 9.5px/15px var(--f-m,monospace);text-align:center}' +
      '.lab-reg-a .lab-sharebtn{margin:0 0 0 2px}.lab-from{background:color-mix(in srgb,var(--teal) 10%,transparent);color:var(--teal);border-color:color-mix(in srgb,var(--teal) 35%,transparent)}.lab-from:not(.edit){color:var(--ink-2);background:var(--surface-2);border-color:var(--rule-2)}' +
      '.lab-lr-h{font-size:15px;margin:26px 0 0;color:var(--ink-2)}' +
      '.lab-sharepop{position:fixed;z-index:9000;width:340px;max-width:calc(100vw - 16px);max-height:min(520px,calc(100vh - 16px));display:flex;flex-direction:column;gap:8px;box-sizing:border-box;padding:12px 12px 10px;' +
      'background:var(--surface);color:var(--ink);border:1px solid var(--rule-2);border-radius:10px;box-shadow:0 18px 40px -18px rgba(36,33,28,.45)}' +
      '.lab-sh-h{display:flex;align-items:center;gap:8px}.lab-sh-h b{flex:1;font-size:13.5px}.lab-sh-x{border:0;background:none;font-size:18px;line-height:1;cursor:pointer;color:var(--ink-3);padding:2px 4px}.lab-sh-x:hover{color:var(--ink)}' +
      '.lab-sh-t{font-family:var(--f-s,Georgia,serif);font-size:14px;color:var(--ink-2);margin-top:-4px}.lab-sh-p{margin:0;font-size:12.5px;line-height:1.45}.lab-sh-q{width:100%;box-sizing:border-box}' +
      '.lab-sh-list{overflow:auto;min-height:60px;display:flex;flex-direction:column;gap:2px;margin:0 -4px;padding:0 4px}.lab-sh-row{display:flex;align-items:center;gap:8px;padding:5px 4px;border-radius:7px}.lab-sh-row.on{background:var(--surface-2)}' +
      '.lab-sh-av{flex:none;width:26px;height:26px;border-radius:50%;display:grid;place-items:center;background:var(--surface-2);color:var(--ink-2);font:600 12px/1 var(--f-d,system-ui)}.lab-sh-row.on .lab-sh-av{background:var(--teal);color:var(--paper)}' +
      '.lab-sh-who{flex:1;min-width:0;display:flex;flex-direction:column}.lab-sh-n{font-size:13px;white-space:nowrap;overflow:hidden;text-overflow:ellipsis}' +
      '.lab-sh-seg{flex:none;display:inline-flex;border:1px solid var(--rule-2);border-radius:7px;overflow:hidden}.lab-sh-seg button{border:0;background:none;padding:4px 8px;font:500 11.5px/1.2 var(--f-d,system-ui);color:var(--ink-2);cursor:pointer}' +
      '.lab-sh-seg button+button{border-left:1px solid var(--rule-2)}.lab-sh-seg button:hover{background:var(--surface-2)}.lab-sh-seg button.on{background:var(--ink);color:var(--paper)}.lab-sh-seg button[data-role="edit"].on{background:var(--teal)}' +
      '.lab-sh-empty{padding:10px 4px}.lab-sh-f{border-top:1px solid var(--rule);padding-top:7px}' +
      '.dock .lab-ro{display:inline-flex;align-items:center;gap:6px}.dock .lab-ro .lab-pic svg{width:15px;height:15px}.lab-h-ro{padding:3px 0;font-size:13px}.lab-h-from{font-size:12.5px;color:var(--ink-2)}' +
      'body.mobile .lab-sharepop{left:8px!important;right:8px;width:auto}';
  } catch (e) { warn('css 15', e); }
  /* ---- 16. Equations read from a PDF, the way RM's paper reader reads them (V3.901, CodeLog/ClaudesPlan/V3.901_scientia_clip_figures_read_beside.md) ----
     Gabe's clip tool (13zza) captures a display equation as RM's equation-capture.js does: the snip goes to the lab's equationOcr
     function (a vision model → LaTeX), you check it in the equation editor against the picture, and it becomes an equation
     component. The app asks through CLIP.read; this fills it in (the desktop has no lab sign-in, so there you type it). Probed
     once, on first use, exactly like the reader's ✨ Auto-read. */
  try {
    if (typeof CLIP !== 'undefined') (function () {
      var OCR = 'https://us-central1-mcgheelab-f56cc.cloudfunctions.net/equationOcr', ok = null;
      CLIP.read = function (img) {
        ok = ok || fetch(OCR, { method: 'GET' }).then(function (r) { return r.ok; }, function () { return false; });
        return ok.then(function (up) {
          if (!up) throw new Error('the reader is not available');
          var u = window.firebase && firebase.auth && firebase.auth().currentUser; if (!u) throw new Error('not signed in');
          return u.getIdToken();
        }).then(function (tok) {
          return fetch(OCR, { method: 'POST', headers: { 'Content-Type': 'application/json', Authorization: 'Bearer ' + tok }, body: JSON.stringify({ image: img }) });
        }).then(function (r) {
          return r.json().catch(function () { return {}; }).then(function (j) { if (!r.ok || !j.latex) throw new Error(j.error || ('status ' + r.status)); return String(j.latex).trim(); });
        });
      };
    })();
  } catch (e) { warn('equation read', e); }
})();
