/* paper-overlays.js — bucket-scoped highlight overlays for the paper reader.
 *
 * The paper has zero or more linked project buckets (via window.LINKS). Each
 * highlight on the paper has an optional `bucket_ids: []` array — buckets it
 * "belongs to". The user toggles which overlays are active; only highlights
 * matching the active set render. Highlights with empty `bucket_ids` are
 * "general" and always render.
 *
 * Public API (window.PAPER_OVERLAYS):
 *   init({paperItem, mountEl, onChange})
 *   getActiveBucketIds()        → string[]
 *   getFilterFn()               → (ann) => boolean (composable with panel's)
 *   getColorForBucket(bucketId) → '#rrggbb' (deterministic from the id)
 *   getLinkedBuckets()          → [{id, title}, ...]
 *   onChange(cb)                → register a listener
 *   destroy()
 *
 * Active set is persisted in localStorage at `rm_lp_overlays_<paperId>`.
 * Default when no localStorage entry: all linked buckets active.
 */
(function () {
  let _paperItem = null;
  let _mountEl = null;
  let _linkedBuckets = [];   // [{id, title}, ...]
  let _active = new Set();
  let _changeCallbacks = [];

  function _storageKey() {
    return `rm_lp_overlays_${_paperItem ? _paperItem.id : 'unknown'}`;
  }

  function _loadActive() {
    try {
      const raw = localStorage.getItem(_storageKey());
      if (raw) {
        const arr = JSON.parse(raw);
        if (Array.isArray(arr)) return new Set(arr);
      }
    } catch (_) { /* corrupt — fall through */ }
    // Default: all linked buckets active.
    return new Set(_linkedBuckets.map(b => b.id));
  }

  function _saveActive() {
    try {
      localStorage.setItem(_storageKey(), JSON.stringify(Array.from(_active)));
    } catch (_) { /* quota — ignore */ }
  }

  // Deterministic per-bucket color. Hash the bucket id and pick from a
  // palette so the same bucket renders the same accent across reloads /
  // different papers / different users.
  const PALETTE = [
    '#a78bfa', '#34d399', '#fb923c', '#60a5fa',
    '#f472b6', '#facc15', '#22d3ee', '#fb7185',
    '#a3e635', '#c084fc', '#f59e0b', '#2dd4bf',
  ];
  function _hash(s) {
    let h = 2166136261;
    for (let i = 0; i < s.length; i++) {
      h ^= s.charCodeAt(i);
      h = (h * 16777619) >>> 0;
    }
    return h;
  }
  function getColorForBucket(bucketId) {
    if (!bucketId) return PALETTE[0];
    return PALETTE[_hash(String(bucketId)) % PALETTE.length];
  }

  // ----- Filter ----------------------------------------------------------

  function getFilterFn() {
    return (ann) => {
      const ids = Array.isArray(ann.bucket_ids) ? ann.bucket_ids : [];
      // Highlights with no overlay = "general" — always show.
      if (!ids.length) return true;
      // Otherwise, show only if any of the highlight's overlays is active.
      return ids.some(id => _active.has(id));
    };
  }

  function getActiveBucketIds() {
    return Array.from(_active);
  }

  function getLinkedBuckets() {
    return _linkedBuckets.slice();
  }

  function onChange(cb) {
    if (typeof cb === 'function') _changeCallbacks.push(cb);
  }

  function _emitChange() {
    for (const cb of _changeCallbacks) {
      try { cb(); } catch (e) { console.error(e); }
    }
  }

  // ----- UI --------------------------------------------------------------

  function _esc(s) {
    return String(s ?? '').replace(/[&<>"']/g, c =>
      ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c])
    );
  }

  function _render() {
    if (!_mountEl) return;
    const total = _linkedBuckets.length;
    const onCount = _active.size;
    const summary = total === 0
      ? 'No overlays'
      : (onCount === total ? `All overlays (${total})` : `${onCount}/${total} overlays`);
    _mountEl.innerHTML = `
      <button class="btn btn-sm lp-overlays-btn" id="lp-overlays-btn" title="Toggle which review-task overlays render on this paper">
        <span class="lp-overlays-dot" style="background:${total === 0 ? '#9ca3af' : (onCount > 0 ? '#a78bfa' : '#d1d5db')};"></span>
        ${_esc(summary)}
      </button>
      <div class="lp-overlays-pop" id="lp-overlays-pop" style="display:none"></div>
    `;
    const btn = _mountEl.querySelector('#lp-overlays-btn');
    const pop = _mountEl.querySelector('#lp-overlays-pop');
    btn.addEventListener('click', (e) => {
      e.stopPropagation();
      const isOpen = pop.style.display !== 'none';
      pop.style.display = isOpen ? 'none' : 'block';
      if (!isOpen) _renderPop();
    });
    document.addEventListener('click', (ev) => {
      if (pop.style.display === 'none') return;
      if (_mountEl.contains(ev.target)) return;
      pop.style.display = 'none';
    });
  }

  function _renderPop() {
    const pop = _mountEl.querySelector('#lp-overlays-pop');
    if (!pop) return;
    if (!_linkedBuckets.length) {
      pop.innerHTML = `
        <div class="lp-overlays-empty">
          No project buckets linked to this paper yet. Link one to scope AI
          overlays (drag-drop a <code>.paper-overlay.md</code> file or use the
          import button below) to a specific review task.
        </div>
        <div class="lp-overlays-foot">
          <div class="lp-overlays-foot-actions">
            <button class="btn btn-sm lp-overlays-link-btn" id="lp-overlays-link">+ Link to project…</button>
            <button class="btn btn-sm lp-overlays-import-btn" id="lp-overlays-import">+ Import overlay file…</button>
          </div>
        </div>
      `;
      pop.querySelector('#lp-overlays-link').addEventListener('click', _openLinkPicker);
      pop.querySelector('#lp-overlays-import').addEventListener('click', _openOverlayFilePicker);
      return;
    }
    const onAll = _active.size === _linkedBuckets.length;
    const offAll = _active.size === 0;
    const rows = _linkedBuckets.map(b => {
      const active = _active.has(b.id);
      const color = getColorForBucket(b.id);
      return `
        <label class="lp-overlay-row${active ? ' lp-overlay-row-on' : ''}">
          <input type="checkbox" data-overlay-id="${_esc(b.id)}"${active ? ' checked' : ''}>
          <span class="lp-overlay-swatch" style="background:${color};"></span>
          <span class="lp-overlay-title">${_esc(b.title || b.id)}</span>
        </label>
      `;
    }).join('');
    pop.innerHTML = `
      <div class="lp-overlays-head">
        <span>Active overlays</span>
        <span class="lp-overlays-actions">
          <button class="lp-overlays-mini" data-overlay-cmd="all"${onAll ? ' disabled' : ''}>All</button>
          <button class="lp-overlays-mini" data-overlay-cmd="none"${offAll ? ' disabled' : ''}>None</button>
        </span>
      </div>
      <div class="lp-overlays-list">${rows}</div>
      <div class="lp-overlays-foot">
        <div class="lp-overlays-foot-actions">
          <button class="btn btn-sm lp-overlays-link-btn" id="lp-overlays-link">+ Link to project…</button>
          <button class="btn btn-sm lp-overlays-import-btn" id="lp-overlays-import">+ Import overlay file…</button>
        </div>
        <div class="lp-overlays-foot-note">
          Highlights with no overlay (general) always render. New highlights you
          create get the currently-active overlays as their <code>bucket_ids</code>.
        </div>
      </div>
    `;
    pop.querySelector('#lp-overlays-link').addEventListener('click', _openLinkPicker);
    pop.querySelector('#lp-overlays-import').addEventListener('click', _openOverlayFilePicker);
    pop.querySelectorAll('input[data-overlay-id]').forEach(inp => {
      inp.addEventListener('change', (ev) => {
        const id = ev.target.getAttribute('data-overlay-id');
        if (ev.target.checked) _active.add(id);
        else _active.delete(id);
        _saveActive();
        _emitChange();
        _render();
        // Re-open popover after the parent re-render.
        const newPop = _mountEl.querySelector('#lp-overlays-pop');
        if (newPop) { newPop.style.display = 'block'; _renderPop(); }
      });
    });
    pop.querySelectorAll('[data-overlay-cmd]').forEach(b => {
      b.addEventListener('click', (ev) => {
        const cmd = ev.target.getAttribute('data-overlay-cmd');
        if (cmd === 'all') _active = new Set(_linkedBuckets.map(b => b.id));
        else if (cmd === 'none') _active = new Set();
        _saveActive();
        _emitChange();
        _render();
        const newPop = _mountEl.querySelector('#lp-overlays-pop');
        if (newPop) { newPop.style.display = 'block'; _renderPop(); }
      });
    });
  }

  // ----- File picker for AI overlay import (V3.95) ----------------------
  // Same import as drag-drop, but invoked from the overlays popover via a
  // hidden file input. Uses PAPER_OVERLAY_IMPORT.handleDrop so the entire
  // preview/validate/confirm flow is shared — the only difference is the
  // delivery (button click vs. drag-drop onto the viewer).
  function _openOverlayFilePicker() {
    if (!window.PAPER_OVERLAY_IMPORT || !window.PAPER_OVERLAY_IMPORT.handleDrop) {
      alert('Overlay import not loaded.');
      return;
    }
    let inp = document.getElementById('lp-overlays-fileinput');
    if (!inp) {
      inp = document.createElement('input');
      inp.type = 'file';
      inp.accept = '.md,.markdown,text/markdown';
      inp.id = 'lp-overlays-fileinput';
      inp.style.display = 'none';
      document.body.appendChild(inp);
    }
    inp.value = '';     // allow re-selecting the same file
    inp.onchange = async () => {
      const file = inp.files && inp.files[0];
      if (!file) return;
      try {
        await window.PAPER_OVERLAY_IMPORT.handleDrop(file);
      } catch (e) {
        console.error('[paper-overlays] overlay file import failed:', e);
        alert('Import failed: ' + (e.message || e));
      }
    };
    inp.click();
  }

  // ----- Link picker (V3.98) --------------------------------------------
  // V3.94 introduced the picker; V3.95 grouped by item type. V3.98 makes
  // the Papers + Grants sections show *items* (papers, grants from
  // items.json) rather than just buckets. When the user checks a paper /
  // grant row that has no bucket yet, save creates one via
  // LINKS.pinItemToDashboard (same shape as newProjectForItem). Existing
  // free-form buckets continue to live in the Other section.
  //
  // This solves the production problem where every bucket fell into
  // "Other" because most buckets were created on the tasks page without
  // a linked_item_id, AND surfaces papers/grants in the picker that
  // didn't have a bucket yet.

  function _itemHint(item) {
    const lib = (item && item.meta && item.meta.library) || {};
    if (item.type === 'paper') {
      const a = (lib.authors && lib.authors[0]) || {};
      const name = a.family || a.given || '';
      const yr = lib.year || '';
      const j = lib.journal || lib.target_journal || '';
      const left = [name, yr].filter(Boolean).join(' ');
      const right = j;
      if (left && right) return left + ' · ' + right;
      return left || right || '';
    }
    if (item.type === 'grant') {
      const m = (item.meta) || {};
      const agency = m.agency || m.sponsor || m.funder || '';
      const num = m.grant_number || m.award_number || m.proposal_number || '';
      const left = [agency, num].filter(Boolean).join(' · ');
      return left;
    }
    return '';
  }

  async function _openLinkPicker() {
    if (!window.LINKS || !_paperItem) return;
    const existing = document.getElementById('lp-overlays-linkmodal');
    if (existing) existing.remove();
    let bucketsDoc, itemsDoc;
    try {
      [bucketsDoc, itemsDoc] = await Promise.all([
        window.LINKS.loadBuckets(),
        window.LINKS.loadItems(),
      ]);
    } catch (e) {
      console.warn('[paper-overlays] failed to load buckets:', e);
      return;
    }
    const allItems = (itemsDoc && itemsDoc.items) || [];
    const allBuckets = (bucketsDoc && bucketsDoc.projects) || [];
    const linkedIds = new Set(_linkedBuckets.map(b => b.id));

    // item id → first bucket that lists it in linked_item_ids. Used to
    // resolve a paper/grant row to a real bucket when one already
    // exists (so checking it doesn't auto-create a duplicate bucket).
    const bucketByItemId = new Map();
    for (const b of allBuckets) {
      for (const itemId of (b.linked_item_ids || [])) {
        if (!bucketByItemId.has(itemId)) bucketByItemId.set(itemId, b);
      }
    }
    // Bucket ids surfaced in Papers/Grants sections — they should NOT
    // also appear in Other.
    const itemBucketIds = new Set();
    for (const b of bucketByItemId.values()) {
      const item = allItems.find(i => i.id === ((b.linked_item_ids || [])[0]));
      if (item && (item.type === 'paper' || item.type === 'grant')) {
        itemBucketIds.add(b.id);
      }
    }

    const rowsByKey = new Map();
    function makeItemRow(item) {
      const bucket = bucketByItemId.get(item.id);
      const linked = !!(bucket && linkedIds.has(bucket.id));
      const row = {
        kind: 'item',
        rowKey: 'item:' + item.id,
        item, bucket,
        linked,
        title: item.title || item.name || item.id,
        hint:  _itemHint(item),
        willCreate: !bucket,
        // For the swatch — use the bucket's color if it exists, else a
        // deterministic per-item color so virtual rows look consistent
        // across reopens.
        swatchKey: bucket ? bucket.id : ('item:' + item.id),
      };
      rowsByKey.set(row.rowKey, row);
      return row;
    }
    function makeBucketRow(bucket) {
      const linked = linkedIds.has(bucket.id);
      const row = {
        kind: 'bucket',
        rowKey: 'bucket:' + bucket.id,
        bucket,
        linked,
        title: bucket.title || bucket.id,
        hint:  bucket.id,
        willCreate: false,
        swatchKey: bucket.id,
      };
      rowsByKey.set(row.rowKey, row);
      return row;
    }

    const paperRows = allItems
      .filter(i => i.type === 'paper' && i.id !== _paperItem.id)
      .map(makeItemRow);
    const grantRows = allItems
      .filter(i => i.type === 'grant')
      .map(makeItemRow);
    const otherRows = allBuckets
      .filter(b => !itemBucketIds.has(b.id))
      .map(makeBucketRow);

    const linkedFirstThenAlpha = (a, b) => {
      const al = a.linked ? 0 : 1, bl = b.linked ? 0 : 1;
      if (al !== bl) return al - bl;
      return (a.title || '').localeCompare(b.title || '');
    };
    paperRows.sort(linkedFirstThenAlpha);
    grantRows.sort(linkedFirstThenAlpha);
    otherRows.sort(linkedFirstThenAlpha);

    const sections = [
      { name: 'Papers', rows: paperRows },
      { name: 'Grants', rows: grantRows },
      { name: 'Other',  rows: otherRows },
    ];

    const renderRowHTML = (row) => {
      const color = getColorForBucket(row.swatchKey);
      const badge = row.willCreate
        ? `<span class="lp-linkpick-badge" title="Will create a new bucket on save">will create</span>`
        : '';
      const hint = row.hint
        ? `<span class="lp-linkpick-hint">${_esc(row.hint)}</span>`
        : '';
      return `
        <label class="lp-linkpick-row${row.linked ? ' lp-linkpick-row-linked' : ''}"
               data-row-search="${_esc(((row.title || '') + ' ' + (row.hint || '')).toLowerCase())}">
          <input type="checkbox" data-row-key="${_esc(row.rowKey)}"${row.linked ? ' checked' : ''}>
          <span class="lp-overlay-swatch" style="background:${color};"></span>
          <span class="lp-linkpick-titlewrap">
            <span class="lp-linkpick-title">${_esc(row.title)}</span>
            ${hint}
          </span>
          ${badge}
        </label>
      `;
    };
    const renderSectionHTML = (sec) => {
      const rows = sec.rows;
      if (!rows.length) return '';   // hide empty sections
      return `
        <div class="lp-linkpick-group" data-section="${_esc(sec.name)}">
          <div class="lp-linkpick-group-head">
            ${_esc(sec.name)}
            <span class="lp-linkpick-group-count">${rows.length}</span>
          </div>
          ${rows.map(renderRowHTML).join('')}
        </div>
      `;
    };
    const listHTML = sections.map(renderSectionHTML).join('') ||
      `<div class="lp-linkpick-empty">No papers, grants, or buckets in items.json / tasks/buckets.json yet.</div>`;

    const modal = document.createElement('div');
    modal.id = 'lp-overlays-linkmodal';
    modal.className = 'lp-overlay-import-modal';   // reuse existing modal CSS
    modal.innerHTML = `
      <div class="lp-oim-backdrop"></div>
      <div class="lp-oim-card">
        <div class="lp-oim-head">Link this paper to a project bucket</div>
        <div class="lp-oim-summary">
          Pick papers, grants, or existing buckets to scope this paper's
          highlights to. Checking a paper or grant that doesn't have a
          bucket yet will auto-create one with the item's title.
        </div>
        <div class="lp-linkpick-search-wrap">
          <input id="lp-linkpick-search" type="text" placeholder="Search papers, grants, buckets…" autocomplete="off" />
        </div>
        <div class="lp-linkpick-list">${listHTML}</div>
        <div class="lp-linkpick-create">
          <input id="lp-linkpick-newtitle" type="text" placeholder="New free-form bucket (e.g. GELS aim 2 review)" />
          <button class="btn btn-sm" id="lp-linkpick-newbtn">+ Create + link</button>
        </div>
        <div class="lp-oim-foot">
          <button class="btn btn-sm" id="lp-linkpick-cancel">Cancel</button>
          <button class="btn btn-sm lp-oim-primary" id="lp-linkpick-save">Save</button>
        </div>
      </div>
    `;
    document.body.appendChild(modal);

    const close = () => modal.remove();
    modal.querySelector('.lp-oim-backdrop').addEventListener('click', close);
    modal.querySelector('#lp-linkpick-cancel').addEventListener('click', close);

    // Live search filter — hides rows whose data-row-search doesn't
    // contain every space-separated token; updates section count chips
    // to reflect filtered totals + hides empty sections.
    const searchInp = modal.querySelector('#lp-linkpick-search');
    searchInp.addEventListener('input', () => {
      const q = searchInp.value.trim().toLowerCase();
      const tokens = q.split(/\s+/).filter(Boolean);
      modal.querySelectorAll('.lp-linkpick-group').forEach(group => {
        let visibleCount = 0;
        group.querySelectorAll('.lp-linkpick-row').forEach(row => {
          const hay = row.getAttribute('data-row-search') || '';
          const show = !tokens.length || tokens.every(t => hay.includes(t));
          row.style.display = show ? '' : 'none';
          if (show) visibleCount++;
        });
        const chip = group.querySelector('.lp-linkpick-group-count');
        if (chip) chip.textContent = String(visibleCount);
        group.style.display = visibleCount === 0 ? 'none' : '';
      });
    });
    setTimeout(() => searchInp.focus(), 0);

    modal.querySelector('#lp-linkpick-newbtn').addEventListener('click', async (ev) => {
      const inp = modal.querySelector('#lp-linkpick-newtitle');
      const title = (inp.value || '').trim();
      if (!title) { inp.focus(); return; }
      const btn = ev.currentTarget;
      btn.disabled = true; btn.textContent = 'Creating…';
      try {
        // Reuse pinItemToDashboard's bucket-creation shape, but as a
        // free-form bucket linked only to the open paper.
        const fresh = await window.LINKS.loadItems();
        const bucketsDoc2 = await window.LINKS.loadBuckets();
        const item = (fresh.items || []).find(i => i.id === _paperItem.id) || _paperItem;
        const idStem = (item.id || 'paper').replace(/^item-/, '');
        const proj = {
          id: `proj-${idStem}-${Date.now().toString(36)}`,
          title,
          status: 'active',
          category: item.category || 'paper',
          due_date: 'TBD',
          hours_estimate: 0,
          tracker_entry_id: null,
          evidence: { email_ids: [], event_ids: [], item_ids: [item.id] },
          notes: '',
          created_at: new Date().toISOString().slice(0, 10),
          completed_at: null,
          buckets: [],
          linked_item_ids: [item.id],
        };
        bucketsDoc2.projects = bucketsDoc2.projects || [];
        bucketsDoc2.projects.push(proj);
        const itemRef = (fresh.items || []).find(i => i.id === item.id);
        if (itemRef) {
          if (!Array.isArray(itemRef.linked_bucket_ids)) itemRef.linked_bucket_ids = [];
          itemRef.linked_bucket_ids.push(proj.id);
        }
        await Promise.all([
          api.save('items.json', fresh),
          api.save('tasks/buckets.json', bucketsDoc2),
        ]);
        close();
        await _refreshLinkedBuckets();
      } catch (e) {
        console.error('[paper-overlays] create-link failed:', e);
        btn.disabled = false; btn.textContent = '+ Create + link';
        alert('Failed to create bucket: ' + (e.message || e));
      }
    });

    modal.querySelector('#lp-linkpick-save').addEventListener('click', async (ev) => {
      const btn = ev.currentTarget;
      btn.disabled = true; btn.textContent = 'Saving…';
      try {
        // First pass: resolve checked rows to concrete bucket ids.
        // Virtual item rows (no bucket yet) trigger an auto-create
        // via LINKS.pinItemToDashboard, which is idempotent if the
        // item already has a linked bucket.
        const desired = new Set();
        const checks = modal.querySelectorAll('input[data-row-key]');
        for (const c of checks) {
          if (!c.checked) continue;
          const row = rowsByKey.get(c.getAttribute('data-row-key'));
          if (!row) continue;
          if (row.kind === 'bucket') {
            desired.add(row.bucket.id);
          } else if (row.kind === 'item') {
            let bid = row.bucket && row.bucket.id;
            if (!bid) bid = await window.LINKS.pinItemToDashboard(row.item);
            desired.add(bid);
          }
        }
        // Second pass: diff against current linked set.
        const toAdd    = Array.from(desired).filter(id => !linkedIds.has(id));
        const toRemove = Array.from(linkedIds).filter(id => !desired.has(id));
        for (const id of toAdd)    await window.LINKS.addLink(_paperItem.id, id);
        for (const id of toRemove) await window.LINKS.removeLink(_paperItem.id, id);
        close();
        await _refreshLinkedBuckets();
      } catch (e) {
        console.error('[paper-overlays] link save failed:', e);
        btn.disabled = false; btn.textContent = 'Save';
        alert('Failed to save links: ' + (e.message || e));
      }
    });
  }

  async function _refreshLinkedBuckets() {
    if (!window.LINKS || !_paperItem) return;
    try {
      const bucketsDoc = await window.LINKS.loadBuckets();
      const itemsDoc   = await window.LINKS.loadItems();
      const fresh = (itemsDoc.items || []).find(i => i.id === _paperItem.id) || _paperItem;
      const projects = window.LINKS.linkedBucketsForItem(fresh, bucketsDoc) || [];
      _linkedBuckets = projects.map(p => ({ id: p.id, title: p.title }));
      // Keep _active in sync: prune missing, default-on for newly-linked.
      const live = new Set(_linkedBuckets.map(b => b.id));
      for (const id of Array.from(_active)) if (!live.has(id)) _active.delete(id);
      for (const b of _linkedBuckets) if (!_active.has(b.id)) _active.add(b.id);
      _saveActive();
      _emitChange();
      _render();
      const newPop = _mountEl && _mountEl.querySelector('#lp-overlays-pop');
      if (newPop) { newPop.style.display = 'block'; _renderPop(); }
    } catch (e) {
      console.warn('[paper-overlays] refresh after link failed:', e);
    }
  }

  // ----- Init ------------------------------------------------------------

  async function init(opts) {
    _paperItem = opts.paperItem;
    _mountEl = opts.mountEl;
    if (typeof opts.onChange === 'function') onChange(opts.onChange);
    if (!_paperItem) {
      console.warn('[paper-overlays] init: paperItem required');
      return;
    }
    // Load buckets linked to this paper. window.LINKS may not be loaded on
    // older builds — guard.
    if (window.LINKS && typeof window.LINKS.loadBuckets === 'function') {
      try {
        const bucketsDoc = await window.LINKS.loadBuckets();
        const projects = window.LINKS.linkedBucketsForItem(_paperItem, bucketsDoc) || [];
        _linkedBuckets = projects.map(p => ({ id: p.id, title: p.title }));
      } catch (e) {
        console.warn('[paper-overlays] could not load linked buckets:', e);
        _linkedBuckets = [];
      }
    }
    _active = _loadActive();
    // If buckets were added/removed since last visit, prune _active to the
    // set that still exists (so a deleted bucket doesn't leak into the
    // saved state forever).
    const liveIds = new Set(_linkedBuckets.map(b => b.id));
    _active = new Set(Array.from(_active).filter(id => liveIds.has(id)));
    _saveActive();
    _render();
  }

  function destroy() {
    if (_mountEl) _mountEl.innerHTML = '';
    _changeCallbacks = [];
    _active = new Set();
    _linkedBuckets = [];
    _paperItem = null;
  }

  window.PAPER_OVERLAYS = {
    init,
    getActiveBucketIds,
    getFilterFn,
    getColorForBucket,
    getLinkedBuckets,
    onChange,
    destroy,
  };
})();
