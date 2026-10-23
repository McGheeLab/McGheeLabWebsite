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
     Tasks page gone — a pointer to RM tasks (the task component stays; V3.870
                makes it an RM task).
     Materials  untouched in this version (V3.870: the inventory picker).

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
  var LAB = { version: 'V3.871', RM: RM, opened: [], openRM: openRM, refresh: refreshLibrary };
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
    VIEWS.activity = pointer('Activity', 'The lab site', 'Your activity is RM’s: the daily tracker, the year view and the lab’s stats live on the lab site, where your mentor sees them too. The desktop app keeps its own Activity page.', RM.activity, 'Open Activity in RM');
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
        pdf ? btn('xs pri', 'Read in RM', function () { openRM(RM.paper(r.rmId)); }, 'Read and highlight in RM’s reader') : null,
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
              h('div.card.flat', h('div.row', r.rmPdf ? btn('pri', 'Read in RM', function () { openRM(RM.paper(r.rmId)); }) : h('span.muted', 'No PDF in RM yet — attach one on the paper’s page.'),
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
})();
