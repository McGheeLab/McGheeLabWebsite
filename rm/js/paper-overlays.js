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
          No project buckets linked to this paper yet. Link one and AI overlays
          (drag-drop a <code>.paper-overlay.md</code> file) will scope to it.
        </div>
        <div class="lp-overlays-foot">
          <button class="btn btn-sm lp-overlays-link-btn" id="lp-overlays-link">+ Link to project…</button>
        </div>
      `;
      pop.querySelector('#lp-overlays-link').addEventListener('click', _openLinkPicker);
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
        <button class="btn btn-sm lp-overlays-link-btn" id="lp-overlays-link">+ Link to project…</button>
        <div class="lp-overlays-foot-note">
          Highlights with no overlay (general) always render. New highlights you
          create get the currently-active overlays as their <code>bucket_ids</code>.
        </div>
      </div>
    `;
    pop.querySelector('#lp-overlays-link').addEventListener('click', _openLinkPicker);
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

  // ----- Link picker (V3.94) --------------------------------------------
  // Lets the user link the open paper to existing project buckets without
  // leaving the paper reader. Also creates a fresh bucket for the paper if
  // the user wants one. After save we re-fetch + re-render so the overlays
  // checkbox list reflects the new linkage.

  async function _openLinkPicker() {
    if (!window.LINKS || !_paperItem) return;
    const existing = document.getElementById('lp-overlays-linkmodal');
    if (existing) existing.remove();
    let bucketsDoc;
    try {
      bucketsDoc = await window.LINKS.loadBuckets();
    } catch (e) {
      console.warn('[paper-overlays] failed to load buckets:', e);
      return;
    }
    const projects = (bucketsDoc && bucketsDoc.projects) || [];
    const linkedIds = new Set(_linkedBuckets.map(b => b.id));
    // Sort: linked first, then alpha by title.
    const sorted = projects.slice().sort((a, b) => {
      const al = linkedIds.has(a.id) ? 0 : 1;
      const bl = linkedIds.has(b.id) ? 0 : 1;
      if (al !== bl) return al - bl;
      return (a.title || '').localeCompare(b.title || '');
    });
    const rows = sorted.map(p => {
      const linked = linkedIds.has(p.id);
      const color = getColorForBucket(p.id);
      return `
        <label class="lp-linkpick-row${linked ? ' lp-linkpick-row-linked' : ''}">
          <input type="checkbox" data-bucket-id="${_esc(p.id)}"${linked ? ' checked' : ''}>
          <span class="lp-overlay-swatch" style="background:${color};"></span>
          <span class="lp-linkpick-title">${_esc(p.title || p.id)}</span>
          <span class="lp-linkpick-id">${_esc(p.id)}</span>
        </label>
      `;
    }).join('') || `<div class="lp-linkpick-empty">No project buckets exist yet — create one below.</div>`;

    const modal = document.createElement('div');
    modal.id = 'lp-overlays-linkmodal';
    modal.className = 'lp-overlay-import-modal';   // reuse existing modal CSS
    modal.innerHTML = `
      <div class="lp-oim-backdrop"></div>
      <div class="lp-oim-card">
        <div class="lp-oim-head">Link this paper to a project bucket</div>
        <div class="lp-oim-summary">
          Linking lets AI-generated <code>.paper-overlay.md</code> files (and
          manual highlights) scope to a specific review task. A paper can be
          linked to many buckets.
        </div>
        <div class="lp-linkpick-list">${rows}</div>
        <div class="lp-linkpick-create">
          <input id="lp-linkpick-newtitle" type="text" placeholder="New bucket title (e.g. GELS aim 2 review)" />
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

    modal.querySelector('#lp-linkpick-newbtn').addEventListener('click', async (ev) => {
      const inp = modal.querySelector('#lp-linkpick-newtitle');
      const title = (inp.value || '').trim();
      if (!title) { inp.focus(); return; }
      const btn = ev.currentTarget;
      btn.disabled = true; btn.textContent = 'Creating…';
      try {
        // Reuse pinItemToDashboard's bucket-creation shape.
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
      const checks = modal.querySelectorAll('input[data-bucket-id]');
      const desiredLinked = new Set();
      checks.forEach(c => { if (c.checked) desiredLinked.add(c.getAttribute('data-bucket-id')); });
      const toAdd = Array.from(desiredLinked).filter(id => !linkedIds.has(id));
      const toRemove = Array.from(linkedIds).filter(id => !desiredLinked.has(id));
      const btn = ev.currentTarget;
      btn.disabled = true; btn.textContent = 'Saving…';
      try {
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
