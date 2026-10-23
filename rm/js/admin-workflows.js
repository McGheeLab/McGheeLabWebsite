/* admin-workflows.js — V3.811 the admin editor for the lab's default workflows.
 *
 * Page: rm/pages/admin-workflows.html (admin-gated via firebridge.gateAdmin).
 * Replaces the V3.63/V3.77 "Default Workflows × Pages" checkbox matrix on
 * admin-permissions.html, which put a workflow's name, icon, blurb, landing
 * select and delete button inside one table-row header next to 57 checkbox
 * columns. Alex: "I want a cleaner way to set the default workflows as the
 * admin, so what are the main workflows, and what pages should show up".
 *
 * Model — labConfig/defaultWorkflows (UNCHANGED shape, one new optional field):
 *   { workflows: [ { id, label, description, icon, landingPageId, pageIds[],
 *                   enabled }, ... ], updatedAt }
 *   - array order  = the order in Workflows ▾, on Home and in the palette
 *   - pageIds order = the order of the chips in the bar
 *   - enabled (V3.811, default true) — false keeps a workflow in the doc
 *     but hides it from everyone; lets the admin draft before launching
 *
 * Working copy vs saved copy: every edit mutates `wfs` in memory; the
 * header shows "N unsaved changes" by diffing against `saved`; one Save
 * writes the whole array (partial state can never reach Firestore);
 * Revert restores the saved copy. No browser prompt/confirm anywhere —
 * the delete confirm is an inline strip, the new-workflow name is an
 * inline field.
 *
 * Pages come from PAGE_REGISTRY (page-registry.js, loaded here), whose
 * entries carry the NAV_ITEMS icon + blurb (V3.809). The preview renders
 * real .nav-chip markup so what the admin sees is what the bar will draw.
 *
 * Exposes window.ADMIN_WORKFLOWS { working(), saved(), select(id), reload() }
 * for the self-test (scripts/tests/v3811-admin-workflows-selftest.html). */
(function () {
  'use strict';

  function esc(s) {
    return String(s == null ? '' : s)
      .replace(/&/g, '&amp;').replace(/</g, '&lt;')
      .replace(/>/g, '&gt;').replace(/"/g, '&quot;');
  }
  function slugify(s) {
    return String(s || '').toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '');
  }
  function docRef() { return firebridge.db().collection('labConfig').doc('defaultWorkflows'); }
  function pageMap() {
    if (window.PAGE_REGISTRY && window.PAGE_REGISTRY.byId) return window.PAGE_REGISTRY.byId;
    if (typeof _wfBuildPageMap === 'function') return _wfBuildPageMap();
    return new Map();
  }
  function pageList() {
    if (window.PAGE_REGISTRY && window.PAGE_REGISTRY.list) return window.PAGE_REGISTRY.list;
    return Array.from(pageMap().values());
  }
  function pageIcon(p) { return (p && p.icon) || 'document-text'; }

  /* ── state ── */
  let saved = [];        // normalized, as last loaded/saved
  let wfs = [];          // working copy (normalized objects)
  let docExists = false;
  let selId = null;
  let pickerQuery = '';
  let confirmDeleteId = null;
  let addingNew = false;
  let lastSavedAt = null;

  function normalize(w) {
    const pm = pageMap();
    const ids = [];
    (Array.isArray(w.pageIds) ? w.pageIds : []).forEach(id => {
      if (typeof id === 'string' && ids.indexOf(id) < 0) ids.push(id);
    });
    const landing = (w.landingPageId && ids.indexOf(w.landingPageId) >= 0) ? w.landingPageId : '';
    // keep ids the registry no longer knows (a renamed page) — the bar skips
    // them silently; the editor shows them as "unknown page" so admin can
    // remove them.
    void pm;
    return {
      id: String(w.id || ''),
      label: String(w.label || ''),
      description: String(w.description || ''),
      icon: String(w.icon || ''),
      landingPageId: landing,
      pageIds: ids,
      enabled: w.enabled !== false,
    };
  }
  function clone(arr) { return JSON.parse(JSON.stringify(arr)); }
  function serialize(arr) { return JSON.stringify(arr.map(normalize)); }
  function isDirty() { return serialize(wfs) !== serialize(saved); }
  function selected() { return wfs.find(w => w.id === selId) || null; }

  /* The built-in set, used when the doc doesn't exist yet: the registry's
   * seeds (Heroicon names) plus any nav.js seed the registry lacks. */
  function builtInSet() {
    const out = [];
    const seen = new Set();
    ((window.PAGE_REGISTRY && window.PAGE_REGISTRY.DEFAULT_WORKFLOWS) || []).forEach(w => {
      out.push(normalize(w)); seen.add(w.id);
    });
    if (typeof _WF_DEFAULT_SEEDS !== 'undefined') {
      _WF_DEFAULT_SEEDS.forEach(w => { if (!seen.has(w.id)) { out.push(normalize(w)); seen.add(w.id); } });
    }
    return out;
  }

  /* ── load / save ── */
  async function load() {
    docExists = false;
    try {
      const snap = await docRef().get();
      if (snap.exists) {
        const data = snap.data() || {};
        const arr = Array.isArray(data.workflows) ? data.workflows : [];
        if (arr.length) {
          saved = arr.map(normalize);
          docExists = true;
        }
      }
    } catch (err) {
      console.warn('[admin-workflows] read failed:', err && err.message);
    }
    if (!docExists) saved = builtInSet();
    wfs = clone(saved);
    if (!selId || !wfs.some(w => w.id === selId)) selId = wfs.length ? wfs[0].id : null;
  }

  function validate() {
    const problems = [];
    const ids = new Set();
    wfs.forEach(w => {
      if (!w.label.trim()) problems.push('A workflow has no name.');
      if (!w.id) problems.push('"' + w.label + '" has no id.');
      if (ids.has(w.id)) problems.push('Two workflows share the id "' + w.id + '".');
      ids.add(w.id);
    });
    return problems;
  }

  async function save() {
    if (!isDirty()) return;
    const problems = validate();
    if (problems.length) { setStatus(problems[0], 'err'); return; }
    const btn = document.getElementById('awf-save');
    btn.disabled = true;
    setStatus('Saving…');
    try {
      const payload = {
        workflows: wfs.map(w => {
          const n = normalize(w);
          return { id: n.id, label: n.label, description: n.description, icon: n.icon,
                   landingPageId: n.landingPageId, pageIds: n.pageIds, enabled: n.enabled };
        }),
        updatedAt: new Date(),
      };
      if (!docExists) payload.seededAt = new Date();
      await docRef().set(payload, { merge: true });
      docExists = true;
      saved = wfs.map(normalize);
      wfs = clone(saved);
      lastSavedAt = Date.now();
      if (window.toast && toast.success) toast.success('Default workflows saved — everyone sees the change on their next page load.');
      render();
    } catch (err) {
      console.error('[admin-workflows] save failed:', err);
      setStatus('Save failed: ' + (err && err.message), 'err');
      btn.disabled = false;
    }
  }

  function revert() {
    wfs = clone(saved);
    confirmDeleteId = null;
    addingNew = false;
    if (!wfs.some(w => w.id === selId)) selId = wfs.length ? wfs[0].id : null;
    render();
  }

  /* ── status ── */
  function setStatus(msg, kind) {
    const el = document.getElementById('awf-status');
    if (!el) return;
    el.textContent = msg || '';
    el.className = 'awf-status' + (kind ? ' awf-status--' + kind : '');
  }
  function refreshStatus() {
    const dirty = isDirty();
    const saveBtn = document.getElementById('awf-save');
    const revBtn = document.getElementById('awf-revert');
    if (saveBtn) saveBtn.disabled = !dirty;
    if (revBtn) revBtn.disabled = !dirty;
    if (dirty) {
      const changed = countChanges();
      setStatus(changed + ' unsaved change' + (changed === 1 ? '' : 's'), 'dirty');
    } else if (!docExists) {
      setStatus('Showing the built-in set — Save once to make it editable for the lab.', 'info');
    } else if (lastSavedAt) {
      setStatus('Saved', 'ok');
    } else {
      setStatus('');
    }
    document.body.classList.toggle('awf-dirty', dirty);
  }
  function countChanges() {
    const a = new Map(saved.map(w => [w.id, JSON.stringify(normalize(w))]));
    const b = new Map(wfs.map(w => [w.id, JSON.stringify(normalize(w))]));
    let n = 0;
    b.forEach((v, id) => { if (!a.has(id) || a.get(id) !== v) n++; });
    a.forEach((v, id) => { if (!b.has(id)) n++; });
    if (!n && saved.map(w => w.id).join() !== wfs.map(w => w.id).join()) n = 1;   // reorder only
    return n;
  }

  /* ── render ── */
  function render() {
    renderRail();
    renderEditor();
    refreshStatus();
  }

  function renderRail() {
    const ol = document.getElementById('awf-rail');
    if (!ol) return;
    ol.innerHTML = '';
    wfs.forEach((w, i) => {
      const li = document.createElement('li');
      li.className = 'awf-item' + (w.id === selId ? ' is-selected' : '') + (w.enabled ? '' : ' is-disabled');
      li.dataset.id = w.id;
      li.draggable = true;
      li.tabIndex = 0;
      li.setAttribute('role', 'button');
      li.innerHTML =
        '<span class="awf-grip" title="Drag to reorder" aria-hidden="true">⋮⋮</span>' +
        '<span class="awf-item-icon">' + ICON.render(w.icon || 'rectangle-stack') + '</span>' +
        '<span class="awf-item-main">' +
        '  <span class="awf-item-label">' + esc(w.label || '(unnamed)') + (w.enabled ? '' : ' <span class="awf-badge">hidden</span>') + '</span>' +
        '  <span class="awf-item-meta">' + w.pageIds.length + ' page' + (w.pageIds.length === 1 ? '' : 's') + '</span>' +
        '</span>' +
        '<span class="awf-item-move">' +
        '  <button type="button" class="awf-mini" data-move="-1" title="Move up" aria-label="Move up"' + (i === 0 ? ' disabled' : '') + '>' + ICON.svg('chevron-up') + '</button>' +
        '  <button type="button" class="awf-mini" data-move="1" title="Move down" aria-label="Move down"' + (i === wfs.length - 1 ? ' disabled' : '') + '>' + ICON.svg('chevron-down') + '</button>' +
        '</span>';
      li.addEventListener('click', (e) => {
        const mv = e.target.closest('[data-move]');
        if (mv) { e.stopPropagation(); moveWorkflow(w.id, Number(mv.dataset.move)); return; }
        selectWorkflow(w.id);
      });
      li.addEventListener('keydown', (e) => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); selectWorkflow(w.id); } });
      wireDrag(li, ol, 'awf-item', (fromId, toId, before) => reorder(wfs, fromId, toId, before, w0 => w0.id) && render());
      ol.appendChild(li);
    });
    if (!wfs.length) {
      ol.innerHTML = '<li class="awf-empty">No workflows yet.</li>';
    }
    renderRailAdd();
  }

  function renderRailAdd() {
    const box = document.getElementById('awf-rail-add');
    if (!box) return;
    if (!addingNew) {
      box.innerHTML = '<button type="button" class="awf-add-btn" id="awf-add">' + ICON.svg('plus') + ' New workflow</button>';
      box.querySelector('#awf-add').addEventListener('click', () => { addingNew = true; renderRailAdd(); });
      return;
    }
    box.innerHTML =
      '<form class="awf-add-form" id="awf-add-form">' +
      '  <input type="text" id="awf-add-name" class="awf-input" placeholder="Workflow name" maxlength="60" autocomplete="off">' +
      '  <div class="awf-add-row"><button type="submit" class="btn btn-primary btn-sm">Create</button>' +
      '  <button type="button" class="btn btn-sm" id="awf-add-cancel">Cancel</button></div>' +
      '  <div class="awf-add-err" id="awf-add-err" hidden></div>' +
      '</form>';
    const form = box.querySelector('#awf-add-form');
    const input = box.querySelector('#awf-add-name');
    const err = box.querySelector('#awf-add-err');
    box.querySelector('#awf-add-cancel').addEventListener('click', () => { addingNew = false; renderRailAdd(); });
    form.addEventListener('submit', (e) => {
      e.preventDefault();
      const name = input.value.trim();
      if (!name) { err.textContent = 'Give it a name.'; err.hidden = false; input.focus(); return; }
      let id = slugify(name);
      if (!id) { err.textContent = 'The name needs letters or numbers.'; err.hidden = false; return; }
      let n = 2;
      while (wfs.some(w => w.id === id)) id = slugify(name) + '-' + (n++);
      wfs.push({ id, label: name, description: '', icon: 'rectangle-stack', landingPageId: '', pageIds: [], enabled: true });
      addingNew = false;
      selId = id;
      render();
      const nameField = document.querySelector('#awf-editor [data-field="label"]');
      if (nameField) nameField.focus();
    });
    input.focus();
  }

  function selectWorkflow(id) {
    if (selId === id) return;
    selId = id;
    confirmDeleteId = null;
    pickerQuery = '';
    render();
  }

  function moveWorkflow(id, delta) {
    const i = wfs.findIndex(w => w.id === id);
    const j = i + delta;
    if (i < 0 || j < 0 || j >= wfs.length) return;
    const [w] = wfs.splice(i, 1);
    wfs.splice(j, 0, w);
    render();
  }

  /* Generic reorder: move `fromId` before/after `toId` in `arr` keyed by keyFn. */
  function reorder(arr, fromId, toId, before, keyFn) {
    const from = arr.findIndex(x => keyFn(x) === fromId);
    let to = arr.findIndex(x => keyFn(x) === toId);
    if (from < 0 || to < 0 || from === to) return false;
    const [item] = arr.splice(from, 1);
    if (to > from) to -= 1;
    if (!before) to += 1;
    arr.splice(to, 0, item);
    return true;
  }

  /* HTML5 drag between siblings with the given class; vertical lists. */
  let _dragId = null;
  function wireDrag(el, container, itemClass, onDrop) {
    el.addEventListener('dragstart', (e) => {
      _dragId = el.dataset.id;
      el.classList.add('is-dragging');
      if (e.dataTransfer) { e.dataTransfer.effectAllowed = 'move'; try { e.dataTransfer.setData('text/plain', _dragId); } catch (err) {} }
    });
    el.addEventListener('dragend', () => {
      _dragId = null;
      el.classList.remove('is-dragging');
      container.querySelectorAll('.drop-before, .drop-after').forEach(x => x.classList.remove('drop-before', 'drop-after'));
    });
    el.addEventListener('dragover', (e) => {
      if (!_dragId || _dragId === el.dataset.id) return;
      e.preventDefault();
      const r = el.getBoundingClientRect();
      const before = (e.clientY - r.top) < r.height / 2;
      el.classList.toggle('drop-before', before);
      el.classList.toggle('drop-after', !before);
    });
    el.addEventListener('dragleave', () => el.classList.remove('drop-before', 'drop-after'));
    el.addEventListener('drop', (e) => {
      if (!_dragId || _dragId === el.dataset.id) return;
      e.preventDefault();
      const r = el.getBoundingClientRect();
      const before = (e.clientY - r.top) < r.height / 2;
      const from = _dragId;
      _dragId = null;
      onDrop(from, el.dataset.id, before);
    });
  }

  /* ── editor ── */
  function renderEditor() {
    const root = document.getElementById('awf-editor');
    if (!root) return;
    const w = selected();
    if (!w) {
      root.innerHTML = '<div class="awf-blank">' + ICON.svg('rectangle-stack', { size: 'xl' }) + '<p>Pick a workflow on the left, or create one.</p></div>';
      return;
    }
    const pm = pageMap();
    root.innerHTML =
      '<div class="awf-ed-head">' +
      '  <button type="button" class="awf-icon-btn" id="awf-icon-btn" title="Change icon" aria-label="Change icon">' + ICON.render(w.icon || 'rectangle-stack') + '</button>' +
      '  <div class="awf-ed-fields">' +
      '    <input type="text" class="awf-input awf-input--title" data-field="label" value="' + esc(w.label) + '" placeholder="Workflow name" maxlength="60" aria-label="Name">' +
      '    <input type="text" class="awf-input" data-field="description" value="' + esc(w.description) + '" placeholder="One line on what this workflow is for (shown on Home and in the palette)" maxlength="200" aria-label="Description">' +
      '  </div>' +
      '  <label class="awf-switch" title="Hidden workflows stay saved but nobody sees them — draft here, enable when ready">' +
      '    <input type="checkbox" data-field="enabled"' + (w.enabled ? ' checked' : '') + '><span class="awf-switch-track"></span><span class="awf-switch-label">' + (w.enabled ? 'Visible to the lab' : 'Hidden') + '</span>' +
      '  </label>' +
      '</div>' +
      '<div class="awf-ed-id">id <code>' + esc(w.id) + '</code> · pages: <strong>' + w.pageIds.length + '</strong> · landing: <strong>' + esc(landingLabel(w, pm)) + '</strong></div>' +
      '<div id="awf-icon-pop" class="awf-icon-pop" hidden></div>' +

      '<h2 class="awf-h2">Preview <span class="awf-h2-sub">what the bar shows while this workflow is open</span></h2>' +
      '<div class="awf-preview" id="awf-preview"></div>' +

      '<div class="awf-cols">' +
      '  <section class="awf-col">' +
      '    <h2 class="awf-h2">Pages in this workflow <span class="awf-h2-sub">drag or ▲▼ to set the chip order · ★ marks the landing page</span></h2>' +
      '    <ol class="awf-pages" id="awf-pages"></ol>' +
      '  </section>' +
      '  <section class="awf-col">' +
      '    <h2 class="awf-h2">Add pages</h2>' +
      '    <input type="search" class="awf-input" id="awf-picker-q" placeholder="Filter pages…" value="' + esc(pickerQuery) + '" aria-label="Filter pages">' +
      '    <div class="awf-picker" id="awf-picker"></div>' +
      '  </section>' +
      '</div>' +

      '<div class="awf-danger" id="awf-danger"></div>';

    root.querySelectorAll('[data-field]').forEach(inp => {
      inp.addEventListener('input', onField);
      inp.addEventListener('change', onField);
    });
    root.querySelector('#awf-icon-btn').addEventListener('click', toggleIconPop);
    const q = root.querySelector('#awf-picker-q');
    q.addEventListener('input', () => { pickerQuery = q.value; renderPicker(); });
    q.addEventListener('keydown', (e) => {
      if (e.key === 'Enter') {
        const first = document.querySelector('#awf-picker .awf-pick:not([hidden])');
        if (first) { e.preventDefault(); first.click(); }
      }
    });
    renderPreview();
    renderPages();
    renderPicker();
    renderDanger();
  }

  function landingLabel(w, pm) {
    if (w.landingPageId && pm.get(w.landingPageId)) return pm.get(w.landingPageId).label;
    const first = w.pageIds.map(id => pm.get(id)).find(Boolean);
    return first ? first.label + ' (first page)' : '—';
  }

  function onField(e) {
    const w = selected(); if (!w) return;
    const f = e.target.dataset.field;
    if (f === 'enabled') {
      w.enabled = !!e.target.checked;
      const lab = e.target.parentElement.querySelector('.awf-switch-label');
      if (lab) lab.textContent = w.enabled ? 'Visible to the lab' : 'Hidden';
    } else {
      w[f] = e.target.value;
    }
    // Light refresh: rail labels, preview + status, without rebuilding the inputs.
    renderRail();
    renderPreview();
    refreshStatus();
  }

  /* Icon chooser: the 100 Heroicons as a grid with a filter, plus a free
   * field for an emoji. */
  function toggleIconPop() {
    const pop = document.getElementById('awf-icon-pop');
    if (!pop) return;
    if (!pop.hidden) { pop.hidden = true; return; }
    const w = selected(); if (!w) return;
    const names = (window.ICON && ICON.names) ? ICON.names() : [];
    pop.innerHTML =
      '<div class="awf-icon-pop-head">' +
      '  <input type="search" class="awf-input" id="awf-icon-q" placeholder="Filter icons…" aria-label="Filter icons">' +
      '  <input type="text" class="awf-input awf-icon-raw" id="awf-icon-raw" value="' + esc(w.icon) + '" placeholder="or type an icon name" aria-label="Icon value">' +
      '  <button type="button" class="btn btn-sm" id="awf-icon-close">Done</button>' +
      '</div>' +
      '<div class="awf-icon-grid" id="awf-icon-grid">' +
      names.map(n => '<button type="button" class="awf-icon-cell' + (n === w.icon ? ' is-on' : '') + '" data-icon="' + esc(n) + '" title="' + esc(n) + '">' + ICON.svg(n) + '</button>').join('') +
      '</div>';
    pop.hidden = false;
    const grid = pop.querySelector('#awf-icon-grid');
    grid.addEventListener('click', (e) => {
      const cell = e.target.closest('.awf-icon-cell');     // not [data-icon]: the svg inside carries it too
      if (!cell) return;
      setIcon(cell.dataset.icon);
      pop.querySelector('#awf-icon-raw').value = cell.dataset.icon;
      grid.querySelectorAll('.is-on').forEach(c => c.classList.remove('is-on'));
      cell.classList.add('is-on');
    });
    pop.querySelector('#awf-icon-q').addEventListener('input', (e) => {
      const q = e.target.value.trim().toLowerCase();
      grid.querySelectorAll('.awf-icon-cell').forEach(c => { c.hidden = !!q && c.dataset.icon.indexOf(q) < 0; });
    });
    pop.querySelector('#awf-icon-raw').addEventListener('input', (e) => setIcon(e.target.value.trim()));
    pop.querySelector('#awf-icon-close').addEventListener('click', () => { pop.hidden = true; });
    pop.querySelector('#awf-icon-q').focus();
  }
  function setIcon(v) {
    const w = selected(); if (!w) return;
    w.icon = v;
    const btn = document.getElementById('awf-icon-btn');
    if (btn) btn.innerHTML = ICON.render(w.icon || 'rectangle-stack');
    renderRail(); renderPreview(); refreshStatus();
  }

  function renderPreview() {
    const el = document.getElementById('awf-preview');
    const w = selected();
    if (!el || !w) return;
    const pm = pageMap();
    const chips = w.pageIds.map(id => {
      const p = pm.get(id);
      if (!p) return '<span class="nav-chip nav-chip--ghost" title="This page id is no longer in the nav">' + esc(id) + '</span>';
      const isLanding = (w.landingPageId ? w.landingPageId === id : w.pageIds.indexOf(id) === 0);
      return '<span class="nav-chip' + (isLanding ? ' active' : '') + '">' + ICON.svg(pageIcon(p)) + '<span class="nav-label">' + esc(p.label) + '</span></span>';
    }).join('');
    el.innerHTML =
      '<div class="top-nav top-nav--workflow awf-preview-bar" aria-hidden="true">' +
      '  <span class="brand">McGhee Lab</span>' +
      '  <span class="nav-goto"><span class="nav-label">Go to…</span></span>' +
      '  <span class="nav-chips">' + (chips || '<span class="nav-chip nav-chip--ghost">No pages yet — add some on the right</span>') + '<span class="nav-chip nav-chip-add">' + ICON.svg('plus') + '</span></span>' +
      '  <span class="nav-dropdown-trigger nav-wf-trigger awf-preview-trigger">' + ICON.render(w.icon || 'rectangle-stack') + ' <span class="nav-label">' + esc(w.label || 'Workflow') + '</span></span>' +
      '</div>' +
      (w.enabled ? '' : '<div class="awf-preview-note">' + ICON.svg('eye') + ' Hidden: nobody sees this workflow until you switch it on.</div>');
  }

  function renderPages() {
    const ol = document.getElementById('awf-pages');
    const w = selected();
    if (!ol || !w) return;
    const pm = pageMap();
    ol.innerHTML = '';
    if (!w.pageIds.length) {
      ol.innerHTML = '<li class="awf-empty">No pages yet. Add them from the list on the right — the first one you add becomes the landing page.</li>';
      return;
    }
    w.pageIds.forEach((id, i) => {
      const p = pm.get(id);
      const li = document.createElement('li');
      li.className = 'awf-page' + (p ? '' : ' is-unknown');
      li.dataset.id = id;
      li.draggable = true;
      const isLanding = (w.landingPageId ? w.landingPageId === id : i === 0);
      li.innerHTML =
        '<span class="awf-grip" aria-hidden="true">⋮⋮</span>' +
        '<span class="awf-page-icon">' + ICON.svg(pageIcon(p)) + '</span>' +
        '<span class="awf-page-main">' +
        '  <span class="awf-page-label">' + esc(p ? p.label : id) + (p ? '' : ' <span class="awf-badge awf-badge--warn">not in the nav any more</span>') + '</span>' +
        '  <span class="awf-page-group">' + esc(p ? p.group : '') + (p && p.gate ? ' · ' + esc(p.gate === 'admin' ? 'admins only' : 'lab members') : '') + '</span>' +
        '</span>' +
        '<label class="awf-landing' + (isLanding ? ' is-on' : '') + '" title="Open this page first when the workflow starts">' +
        '  <input type="radio" name="awf-landing" value="' + esc(id) + '"' + (isLanding ? ' checked' : '') + '>' + ICON.svg('star', { variant: isLanding ? 'solid' : 'outline' }) + '<span>landing</span>' +
        '</label>' +
        '<span class="awf-item-move">' +
        '  <button type="button" class="awf-mini" data-move="-1" title="Move up" aria-label="Move up"' + (i === 0 ? ' disabled' : '') + '>' + ICON.svg('chevron-up') + '</button>' +
        '  <button type="button" class="awf-mini" data-move="1" title="Move down" aria-label="Move down"' + (i === w.pageIds.length - 1 ? ' disabled' : '') + '>' + ICON.svg('chevron-down') + '</button>' +
        '</span>' +
        '<button type="button" class="awf-mini awf-remove" data-remove="1" title="Remove from this workflow" aria-label="Remove ' + esc(p ? p.label : id) + '">' + ICON.svg('x-mark') + '</button>';
      li.addEventListener('click', (e) => {
        const mv = e.target.closest('[data-move]');
        if (mv) { movePage(id, Number(mv.dataset.move)); return; }
        if (e.target.closest('[data-remove]')) { removePage(id); return; }
      });
      li.querySelector('input[type="radio"]').addEventListener('change', () => { w.landingPageId = id; afterPagesChange(); });
      wireDrag(li, ol, 'awf-page', (fromId, toId, before) => reorder(w.pageIds, fromId, toId, before, x => x) && afterPagesChange());
      ol.appendChild(li);
    });
  }
  function movePage(id, delta) {
    const w = selected(); if (!w) return;
    const i = w.pageIds.indexOf(id), j = i + delta;
    if (i < 0 || j < 0 || j >= w.pageIds.length) return;
    w.pageIds.splice(i, 1); w.pageIds.splice(j, 0, id);
    afterPagesChange();
  }
  function removePage(id) {
    const w = selected(); if (!w) return;
    w.pageIds = w.pageIds.filter(x => x !== id);
    if (w.landingPageId === id) w.landingPageId = '';
    afterPagesChange();
  }
  function addPage(id) {
    const w = selected(); if (!w) return;
    if (w.pageIds.indexOf(id) >= 0) return;
    w.pageIds.push(id);
    afterPagesChange();
    const q = document.getElementById('awf-picker-q');
    if (q) q.focus();
  }
  function afterPagesChange() {
    renderPages(); renderPicker(); renderPreview(); renderRail(); refreshStatus();
    const idEl = document.querySelector('.awf-ed-id');
    const w = selected();
    if (idEl && w) idEl.innerHTML = 'id <code>' + esc(w.id) + '</code> · pages: <strong>' + w.pageIds.length + '</strong> · landing: <strong>' + esc(landingLabel(w, pageMap())) + '</strong>';
  }

  function renderPicker() {
    const box = document.getElementById('awf-picker');
    const w = selected();
    if (!box || !w) return;
    const inWf = new Set(w.pageIds);
    const q = pickerQuery.trim().toLowerCase();
    const groups = [];
    const byGroup = new Map();
    // Precise typing wins: when any page NAME (or group) contains the query,
    // show only those; otherwise fall back to pages whose blurb mentions it
    // ("receipts" finds Travel). Enter adds the first row, so this ordering
    // is what makes Enter predictable.
    const candidates = pageList().filter(p => p.id !== 'dashboard' && p.id !== 'split-view' && !inWf.has(p.id));
    let shown = candidates;
    if (q) {
      const byName = candidates.filter(p => (p.label + ' ' + (p.group || '')).toLowerCase().indexOf(q) >= 0);
      shown = byName.length ? byName : candidates.filter(p => (p.desc || '').toLowerCase().indexOf(q) >= 0);
    }
    shown.forEach(p => {
      const g = p.group || 'Other';
      if (!byGroup.has(g)) { byGroup.set(g, []); groups.push(g); }
      byGroup.get(g).push(p);
    });
    if (!groups.length) {
      box.innerHTML = '<div class="awf-empty">' + (q ? 'No page matches “' + esc(q) + '”.' : 'Every page is already in this workflow.') + '</div>';
      return;
    }
    box.innerHTML = groups.map(g =>
      '<div class="awf-pick-group">' + esc(g) + '</div>' +
      byGroup.get(g).map(p =>
        '<button type="button" class="awf-pick" data-id="' + esc(p.id) + '" title="' + esc(p.desc || '') + '">' +
        '<span class="awf-page-icon">' + ICON.svg(pageIcon(p)) + '</span>' +
        '<span class="awf-pick-label">' + esc(p.label) + (p.gate === 'admin' ? ' <span class="awf-badge">admin</span>' : '') + '</span>' +
        '<span class="awf-pick-add">' + ICON.svg('plus') + '</span>' +
        '</button>').join('')
    ).join('');
    box.querySelectorAll('.awf-pick').forEach(b => b.addEventListener('click', () => addPage(b.dataset.id)));
  }

  function renderDanger() {
    const box = document.getElementById('awf-danger');
    const w = selected();
    if (!box || !w) return;
    if (confirmDeleteId === w.id) {
      box.innerHTML =
        '<div class="awf-confirm">' +
        '  <span>' + ICON.svg('exclamation-triangle') + ' Delete <strong>' + esc(w.label || w.id) + '</strong> for everyone? It disappears from the Workflows menu and Home when you save. Members\' own saved workflows are not affected.</span>' +
        '  <button type="button" class="btn btn-danger btn-sm" id="awf-del-yes">Delete</button>' +
        '  <button type="button" class="btn btn-sm" id="awf-del-no">Keep it</button>' +
        '</div>';
      box.querySelector('#awf-del-yes').addEventListener('click', () => {
        wfs = wfs.filter(x => x.id !== w.id);
        confirmDeleteId = null;
        selId = wfs.length ? wfs[0].id : null;
        render();
      });
      box.querySelector('#awf-del-no').addEventListener('click', () => { confirmDeleteId = null; renderDanger(); });
      return;
    }
    box.innerHTML = '<button type="button" class="awf-del-link" id="awf-del">' + ICON.svg('trash') + ' Delete this workflow…</button>';
    box.querySelector('#awf-del').addEventListener('click', () => { confirmDeleteId = w.id; renderDanger(); });
  }

  /* ── boot ── */
  async function boot() {
    if (typeof firebridge === 'undefined') return;
    const gate = await firebridge.gateAdmin('edit the default workflows');
    if (!gate || !gate.allowed) return;
    const gateEl = document.getElementById('awf-gate');
    const root = document.getElementById('awf-root');
    await load();
    if (gateEl) gateEl.hidden = true;
    if (root) root.hidden = false;
    render();
    document.getElementById('awf-save').addEventListener('click', save);
    document.getElementById('awf-revert').addEventListener('click', revert);
    document.addEventListener('keydown', (e) => {
      if ((e.metaKey || e.ctrlKey) && !e.shiftKey && (e.key === 's' || e.key === 'S')) { e.preventDefault(); save(); }
    });
    window.addEventListener('beforeunload', (e) => {
      if (!isDirty()) return;
      e.preventDefault();
      e.returnValue = '';
    });
  }

  window.ADMIN_WORKFLOWS = {
    working: () => wfs,
    saved: () => saved,
    select: (id) => { selectWorkflow(id); },
    reload: async () => { await load(); render(); },
    isDirty: isDirty,
  };

  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', boot);
  else boot();
})();
