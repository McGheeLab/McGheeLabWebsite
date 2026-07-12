/* paper-overlays.js — draft-scoped highlight overlays for the paper reader.
 *
 * V3.103 — refactored from project-bucket scoping to draft scoping.
 *
 * Each library paper carries `meta.library.linked_drafts: [draft-id]` —
 * the lab's paper-builder drafts and grant proposals it's evidence for.
 * Each annotation has `cite_in_drafts: [draft-id]` for the drafts it
 * cites into (already used by the evidence flow). The overlays popover
 * toggles which drafts' highlights render. Highlights with empty
 * `cite_in_drafts` are "general" and always render.
 *
 * Public API (window.PAPER_OVERLAYS):
 *   init({paperItem, mountEl, onChange})
 *   getActiveDraftIds()        → string[]
 *   getFilterFn()              → (ann) => boolean
 *   getColorForDraft(draftId)  → '#rrggbb' (deterministic from id)
 *   getLinkedDrafts()          → [{id, title, kind:'paper'|'grant'}, ...]
 *   onChange(cb)               → register a listener
 *   destroy()
 *
 * Backward-compat aliases retained for one release cycle so external
 * call sites (annotation-overlay.js stripes, annotation-panel.js
 * "Overlays" chips) keep working while they migrate:
 *   getActiveBucketIds, getLinkedBuckets, getColorForBucket
 *
 * Active set is persisted in localStorage at `rm_lp_drafts_<paperId>`.
 * Default when no entry: all linked drafts active.
 *
 * The "+ Link to draft…" picker writes to the library paper's
 * `meta.library.linked_drafts` array and lists every paper draft and
 * grant proposal in items.json. There's no project-bucket linkage from
 * the paper reader anymore — that lived under V3.94–V3.98 and was
 * unused in practice.
 */
(function () {
  let _paperItem = null;
  let _mountEl = null;
  let _linkedDrafts = [];   // [{id, title, kind:'paper'|'grant'}, ...]
  let _active = new Set();
  let _changeCallbacks = [];
  let _docClickBound = false;   // V3.294 — bind the outside-click closer once

  /* ─── Persistence (per-paper active set) ──────────────── */
  function _storageKey() {
    return `rm_lp_drafts_${_paperItem ? _paperItem.id : 'unknown'}`;
  }
  function _loadActive() {
    // V3.187 — `?draft=<id>` URL param overrides the persisted active set.
    // Used when the grant editor's "Linked Papers" panel hands off into the
    // paper reader: that grant's overlay activates exclusively so the user
    // sees only the grant-relevant highlights. The persisted set is left
    // intact so a later visit without the param restores the user's state.
    try {
      const qp = new URLSearchParams(window.location.search);
      const focusId = qp.get('draft') || qp.get('grant');
      if (focusId) return new Set([focusId]);
    } catch (_) { /* no window — ignore */ }
    try {
      const raw = localStorage.getItem(_storageKey());
      if (raw) {
        const arr = JSON.parse(raw);
        if (Array.isArray(arr)) return new Set(arr);
      }
    } catch (_) { /* corrupt — fall through */ }
    return new Set(_linkedDrafts.map(d => d.id));
  }
  function _saveActive() {
    try {
      localStorage.setItem(_storageKey(), JSON.stringify(Array.from(_active)));
    } catch (_) { /* quota — ignore */ }
  }

  /* ─── Color palette (deterministic per draft id) ──────── */
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
  function getColorForDraft(draftId) {
    if (!draftId) return PALETTE[0];
    return PALETTE[_hash(String(draftId)) % PALETTE.length];
  }

  /* ─── Filter ──────────────────────────────────────────── */
  function getFilterFn() {
    return (ann) => {
      const ids = Array.isArray(ann.cite_in_drafts) ? ann.cite_in_drafts : [];
      if (!ids.length) return true;        // general highlight, always show
      return ids.some(id => _active.has(id));
    };
  }
  function getActiveDraftIds() { return Array.from(_active); }
  function getLinkedDrafts()   { return _linkedDrafts.slice(); }

  function onChange(cb) {
    if (typeof cb === 'function') _changeCallbacks.push(cb);
  }
  function _emitChange() {
    for (const cb of _changeCallbacks) {
      try { cb(); } catch (e) { console.error(e); }
    }
  }

  /* ─── Helpers ─────────────────────────────────────────── */
  function _esc(s) {
    return String(s ?? '').replace(/[&<>"']/g, c =>
      ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c])
    );
  }

  // Status set used to filter "drafts we're writing" from items.json
  // grants. Awarded / active / completed grants aren't drafts; they're
  // post-award work. Proposals = anything we'd still cite to.
  const GRANT_DRAFT_STATUSES = new Set([
    'drafting', 'submitted', 'under_review', 'revising', 'rejected',
  ]);

  // Returns drafts available to associate with this paper:
  //   paper drafts: every entry in projects/papers.json (the paper-
  //                 builder's source of truth — papers we're authoring)
  //   grant drafts: items.json type:'grant' AND status in proposals
  // Each draft: {id, title, kind:'paper'|'grant', hint:'…'}
  async function _loadAllDrafts() {
    // util.js declares `api` with top-level `const`, which creates a
    // script-global identifier but does NOT attach a `window.api`
    // property. Guard on the lexical binding via typeof.
    if (typeof api === 'undefined' || !api.load) return [];
    const out = [];
    // Paper drafts live in projects/papers.json (separate from items.json).
    try {
      const pdata = await api.load('projects/papers.json');
      const papers = (pdata && pdata.papers) || [];
      for (const p of papers) {
        out.push({
          id: p.id,
          title: p.title || p.id,
          kind: 'paper',
          hint: _paperDraftHint(p),
        });
      }
    } catch (e) {
      console.warn('[paper-overlays] could not load projects/papers.json:', e.message || e);
    }
    // Grants live in items.json with type:'grant' (legacy schema).
    try {
      const idata = await api.load('items.json');
      const items = (idata && idata.items) || [];
      for (const it of items) {
        if (it.type === 'grant' && GRANT_DRAFT_STATUSES.has(it.status)) {
          out.push({
            id: it.id,
            title: it.title || it.id,
            kind: 'grant',
            hint: _grantDraftHint(it),
          });
        }
      }
    } catch (e) {
      console.warn('[paper-overlays] could not load items.json:', e.message || e);
    }
    // V3.187 — grant drafts from the new V3.179 `grantDrafts` collection.
    // These are the in-progress proposals the grant writer authors; their
    // ids appear in cite_in_drafts on annotations imported via
    // .paper-overlay.md files dropped on the grant card.
    try {
      if (typeof firebridge !== 'undefined' && firebridge.db && firebridge.isLabMember && firebridge.isLabMember()) {
        const snap = await firebridge.db().collection('grantDrafts').get();
        const seen = new Set(out.map(d => d.id));
        snap.docs.forEach(d => {
          if (seen.has(d.id)) return;  // legacy items.json entry takes precedence
          const data = d.data() || {};
          out.push({
            id: d.id,
            title: data.title || d.id,
            kind: 'grant',
            hint: [data.agency, data.mechanism, data.deadlineISO].filter(Boolean).join(' · '),
          });
        });
      }
    } catch (e) {
      console.warn('[paper-overlays] could not load grantDrafts collection:', e.message || e);
    }
    return out;
  }
  function _paperDraftHint(p) {
    const left = [p.lead_author, p.target_journal].filter(Boolean).join(' · ');
    const status = p.status ? `(${p.status})` : '';
    return [left, status].filter(Boolean).join(' ');
  }
  function _grantDraftHint(item) {
    const m = item.meta || {};
    const funder = m.funder || m.agency || m.sponsor || '';
    const mech   = m.mechanism || m.grant_number || m.proposal_number || '';
    const left = [funder, mech].filter(Boolean).join(' · ');
    const status = item.status ? `(${item.status})` : '';
    return [left, status].filter(Boolean).join(' ');
  }
  // Reload the linked-drafts list from the open paper's
  // meta.library.linked_drafts and refresh the popover. The id is
  // resolved against BOTH projects/papers.json (paper drafts) and
  // items.json (grants); titles and kind chips come from there.
  async function _refreshLinkedDrafts() {
    if (!_paperItem) return;
    let itemsData, papersData;
    try {
      [itemsData, papersData] = await Promise.all([
        api.load('items.json'),
        api.load('projects/papers.json').catch(() => ({ papers: [] })),
      ]);
    } catch (e) {
      console.warn('[paper-overlays] refresh failed:', e.message || e);
      return;
    }
    const items = (itemsData && itemsData.items) || [];
    const papers = (papersData && papersData.papers) || [];
    const fresh = items.find(i => i.id === _paperItem.id) || _paperItem;
    const ids = (fresh.meta && fresh.meta.library && fresh.meta.library.linked_drafts) || [];

    // V3.187 — fetch grant titles for ids that match grantDrafts/{id}.
    // Done in parallel via direct doc reads (cheap; usually 1-3 ids per paper).
    const grantTitles = {};
    if (typeof firebridge !== 'undefined' && firebridge.db && firebridge.isLabMember && firebridge.isLabMember()) {
      await Promise.all(ids.map(async id => {
        try {
          const snap = await firebridge.db().collection('grantDrafts').doc(id).get();
          if (snap.exists) {
            const d = snap.data();
            grantTitles[id] = d.title || id;
          }
        } catch (_) { /* not a grantDraft id — fine */ }
      }));
    }

    const enriched = ids.map(id => {
      const paper = papers.find(p => p.id === id);
      if (paper) return { id, title: paper.title || id, kind: 'paper' };
      const it = items.find(i => i.id === id);
      if (it && it.type === 'grant') return { id, title: it.title || id, kind: 'grant' };
      if (grantTitles[id]) return { id, title: grantTitles[id], kind: 'grant' };
      // Fallback: legacy bucket id or unknown — show as paper-flavored.
      return { id, title: (it && it.title) || id, kind: 'paper' };
    });
    _linkedDrafts = enriched;
    // Prune _active to live ids; auto-activate newly-linked.
    const live = new Set(_linkedDrafts.map(d => d.id));
    for (const id of Array.from(_active)) if (!live.has(id)) _active.delete(id);
    for (const d of _linkedDrafts) if (!_active.has(d.id)) _active.add(d.id);
    _saveActive();
    _emitChange();
    _render();
    const pop = _mountEl && _mountEl.querySelector('#lp-overlays-pop');
    if (pop) { pop.style.display = 'block'; _renderPop(); }
  }

  // Public: link / unlink a draft from this library paper. Writes
  // meta.library.linked_drafts on items.json. Idempotent.
  async function linkDraft(draftId) {
    if (!_paperItem || !draftId) return;
    const data = await api.load('items.json');
    const items = (data && data.items) || [];
    const idx = items.findIndex(i => i.id === _paperItem.id);
    if (idx < 0) throw new Error('Open paper not found in items.json');
    items[idx].meta = items[idx].meta || {};
    items[idx].meta.library = items[idx].meta.library || {};
    const arr = Array.isArray(items[idx].meta.library.linked_drafts)
      ? items[idx].meta.library.linked_drafts.slice() : [];
    if (arr.indexOf(draftId) === -1) arr.push(draftId);
    items[idx].meta.library.linked_drafts = arr;
    await api.save('items.json', { items });
    _paperItem = items[idx];
    await _refreshLinkedDrafts();
  }
  async function unlinkDraft(draftId) {
    if (!_paperItem || !draftId) return;
    const data = await api.load('items.json');
    const items = (data && data.items) || [];
    const idx = items.findIndex(i => i.id === _paperItem.id);
    if (idx < 0) return;
    items[idx].meta = items[idx].meta || {};
    items[idx].meta.library = items[idx].meta.library || {};
    const arr = Array.isArray(items[idx].meta.library.linked_drafts)
      ? items[idx].meta.library.linked_drafts.filter(x => x !== draftId) : [];
    items[idx].meta.library.linked_drafts = arr;
    await api.save('items.json', { items });
    _paperItem = items[idx];
    await _refreshLinkedDrafts();
  }

  /* ─── Overlays popover (toggleable draft list) ────────── */
  function _render() {
    if (!_mountEl) return;
    const total = _linkedDrafts.length;
    const onCount = _active.size;
    const summary = total === 0
      ? 'No drafts linked'
      : (onCount === total ? `All drafts (${total})` : `${onCount}/${total} drafts`);
    _mountEl.innerHTML = `
      <button class="btn btn-sm lp-overlays-btn" id="lp-overlays-btn" title="Toggle which draft's highlights render on this paper">
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
    // V3.294 — bind the outside-click closer ONCE (module-level named
    // handler), not on every _render(). Re-rendering the panel (init,
    // _refreshLinkedDrafts, checkbox change, all/none) used to stack a
    // fresh anonymous document listener each time, which leaked across
    // tab switches. The named handler re-queries the live _mountEl/pop.
    if (!_docClickBound) {
      document.addEventListener('click', _onDocClick);
      _docClickBound = true;
    }
  }

  function _onDocClick(ev) {
    if (!_mountEl) return;
    const pop = _mountEl.querySelector('#lp-overlays-pop');
    if (!pop || pop.style.display === 'none') return;
    if (_mountEl.contains(ev.target)) return;
    pop.style.display = 'none';
  }

  function _renderPop() {
    const pop = _mountEl.querySelector('#lp-overlays-pop');
    if (!pop) return;
    if (!_linkedDrafts.length) {
      pop.innerHTML = `
        <div class="lp-overlays-empty">
          No paper or grant drafts linked yet. Link one to scope this paper's
          highlights — and to make it eligible as evidence for the draft's
          claims.
        </div>
        <div class="lp-overlays-foot">
          <div class="lp-overlays-foot-actions">
            <button class="btn btn-sm lp-overlays-link-btn" id="lp-overlays-link">+ Link to draft…</button>
            <button class="btn btn-sm lp-overlays-import-btn" id="lp-overlays-import">+ Import overlay file…</button>
          </div>
        </div>
      `;
      pop.querySelector('#lp-overlays-link').addEventListener('click', _openLinkPicker);
      pop.querySelector('#lp-overlays-import').addEventListener('click', _openOverlayFilePicker);
      return;
    }
    const onAll = _active.size === _linkedDrafts.length;
    const offAll = _active.size === 0;
    const rows = _linkedDrafts.map(d => {
      const active = _active.has(d.id);
      const color = getColorForDraft(d.id);
      const kindBadge = d.kind === 'grant'
        ? `<span class="lp-overlay-kind lp-overlay-kind-grant">grant</span>`
        : `<span class="lp-overlay-kind lp-overlay-kind-paper">paper</span>`;
      return `
        <label class="lp-overlay-row${active ? ' lp-overlay-row-on' : ''}">
          <input type="checkbox" data-draft-id="${_esc(d.id)}"${active ? ' checked' : ''}>
          <span class="lp-overlay-swatch" style="background:${color};"></span>
          <span class="lp-overlay-title">${_esc(d.title || d.id)}</span>
          ${kindBadge}
        </label>
      `;
    }).join('');
    pop.innerHTML = `
      <div class="lp-overlays-head">
        <span>Active drafts</span>
        <span class="lp-overlays-actions">
          <button class="lp-overlays-mini" data-overlay-cmd="all"${onAll ? ' disabled' : ''}>All</button>
          <button class="lp-overlays-mini" data-overlay-cmd="none"${offAll ? ' disabled' : ''}>None</button>
        </span>
      </div>
      <div class="lp-overlays-list">${rows}</div>
      <div class="lp-overlays-foot">
        <div class="lp-overlays-foot-actions">
          <button class="btn btn-sm lp-overlays-link-btn" id="lp-overlays-link">+ Link to draft…</button>
          <button class="btn btn-sm lp-overlays-import-btn" id="lp-overlays-import">+ Import overlay file…</button>
        </div>
        <div class="lp-overlays-foot-note">
          Highlights with no draft (general) always render. New highlights
          inherit the active drafts as their <code>cite_in_drafts</code>.
        </div>
      </div>
    `;
    pop.querySelector('#lp-overlays-link').addEventListener('click', _openLinkPicker);
    pop.querySelector('#lp-overlays-import').addEventListener('click', _openOverlayFilePicker);
    pop.querySelectorAll('input[data-draft-id]').forEach(inp => {
      inp.addEventListener('change', (ev) => {
        const id = ev.target.getAttribute('data-draft-id');
        if (ev.target.checked) _active.add(id);
        else _active.delete(id);
        _saveActive();
        _emitChange();
        _render();
        const newPop = _mountEl.querySelector('#lp-overlays-pop');
        if (newPop) { newPop.style.display = 'block'; _renderPop(); }
      });
    });
    pop.querySelectorAll('[data-overlay-cmd]').forEach(b => {
      b.addEventListener('click', (ev) => {
        const cmd = ev.target.getAttribute('data-overlay-cmd');
        if (cmd === 'all') _active = new Set(_linkedDrafts.map(d => d.id));
        else if (cmd === 'none') _active = new Set();
        _saveActive();
        _emitChange();
        _render();
        const newPop = _mountEl.querySelector('#lp-overlays-pop');
        if (newPop) { newPop.style.display = 'block'; _renderPop(); }
      });
    });
  }

  /* ─── File picker (delegates to existing PAPER_OVERLAY_IMPORT) ── */
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
    inp.value = '';
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

  /* ─── Draft link picker (V3.103) ───────────────────────── */
  // Lists every paper draft + grant proposal from items.json. Checked
  // = associated with this library paper. Save diffs against the
  // current meta.library.linked_drafts and writes the new array.

  async function _openLinkPicker() {
    if (!_paperItem) return;
    const existing = document.getElementById('lp-overlays-linkmodal');
    if (existing) existing.remove();
    const allDrafts = await _loadAllDrafts();
    const linkedIds = new Set(_linkedDrafts.map(d => d.id));

    const sections = [
      { name: 'Paper drafts', kind: 'paper', hint: 'Papers we\'re writing — from projects/papers' },
      { name: 'Grant drafts', kind: 'grant', hint: 'Grant proposals — from projects/grants'      },
    ];
    sections.forEach(s => { s.rows = allDrafts.filter(d => d.kind === s.kind); });
    sections.forEach(s => {
      s.rows.sort((a, b) => {
        const al = linkedIds.has(a.id) ? 0 : 1, bl = linkedIds.has(b.id) ? 0 : 1;
        if (al !== bl) return al - bl;
        return (a.title || '').localeCompare(b.title || '');
      });
    });

    const renderRow = (d) => {
      const linked = linkedIds.has(d.id);
      const color = getColorForDraft(d.id);
      const hint  = d.hint
        ? `<span class="lp-linkpick-hint">${_esc(d.hint)}</span>`
        : '';
      return `
        <label class="lp-linkpick-row${linked ? ' lp-linkpick-row-linked' : ''}"
               data-row-search="${_esc(((d.title || '') + ' ' + (d.hint || '')).toLowerCase())}">
          <input type="checkbox" data-draft-id="${_esc(d.id)}"${linked ? ' checked' : ''}>
          <span class="lp-overlay-swatch" style="background:${color};"></span>
          <span class="lp-linkpick-titlewrap">
            <span class="lp-linkpick-title">${_esc(d.title || d.id)}</span>
            ${hint}
          </span>
        </label>
      `;
    };
    const renderSection = (s) => {
      if (!s.rows.length) {
        return `
          <div class="lp-linkpick-group" data-section="${_esc(s.name)}">
            <div class="lp-linkpick-group-head">${_esc(s.name)} <span class="lp-linkpick-group-count">0</span></div>
            <div class="lp-linkpick-empty">${_esc(s.hint)}. None yet — create one in the projects page.</div>
          </div>
        `;
      }
      return `
        <div class="lp-linkpick-group" data-section="${_esc(s.name)}">
          <div class="lp-linkpick-group-head">
            ${_esc(s.name)}
            <span class="lp-linkpick-group-count">${s.rows.length}</span>
          </div>
          ${s.rows.map(renderRow).join('')}
        </div>
      `;
    };
    const listHTML = sections.map(renderSection).join('');

    const modal = document.createElement('div');
    modal.id = 'lp-overlays-linkmodal';
    modal.className = 'lp-overlay-import-modal';   // reuse existing modal CSS
    modal.innerHTML = `
      <div class="lp-oim-backdrop"></div>
      <div class="lp-oim-card">
        <div class="lp-oim-head">Link this paper to a draft</div>
        <div class="lp-oim-summary">
          Pick the paper drafts and grant proposals this library paper is
          evidence for. Linking unlocks it in the per-annotation "Tag as
          evidence" picker on the right side of the reader.
        </div>
        <div class="lp-linkpick-search-wrap">
          <input id="lp-linkpick-search" type="text" placeholder="Search drafts…" autocomplete="off" />
        </div>
        <div class="lp-linkpick-list">${listHTML}</div>
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
      });
    });
    setTimeout(() => searchInp.focus(), 0);

    modal.querySelector('#lp-linkpick-save').addEventListener('click', async (ev) => {
      const btn = ev.currentTarget;
      btn.disabled = true; btn.textContent = 'Saving…';
      try {
        const desired = new Set();
        modal.querySelectorAll('input[data-draft-id]').forEach(c => {
          if (c.checked) desired.add(c.getAttribute('data-draft-id'));
        });
        // Single write: rebuild meta.library.linked_drafts from `desired`.
        const data = await api.load('items.json');
        const items = (data && data.items) || [];
        const idx = items.findIndex(i => i.id === _paperItem.id);
        if (idx < 0) throw new Error('Open paper not found in items.json');
        items[idx].meta = items[idx].meta || {};
        items[idx].meta.library = items[idx].meta.library || {};
        items[idx].meta.library.linked_drafts = Array.from(desired);
        await api.save('items.json', { items });
        _paperItem = items[idx];
        close();
        await _refreshLinkedDrafts();
      } catch (e) {
        console.error('[paper-overlays] link save failed:', e);
        btn.disabled = false; btn.textContent = 'Save';
        alert('Failed to save links: ' + (e.message || e));
      }
    });
  }

  /* ─── Init ────────────────────────────────────────────── */
  async function init(opts) {
    _paperItem = opts.paperItem;
    _mountEl = opts.mountEl;
    if (typeof opts.onChange === 'function') onChange(opts.onChange);
    if (!_paperItem) {
      console.warn('[paper-overlays] init: paperItem required');
      return;
    }
    await _refreshLinkedDrafts();
    _active = _loadActive();
    const live = new Set(_linkedDrafts.map(d => d.id));
    _active = new Set(Array.from(_active).filter(id => live.has(id)));
    _saveActive();
    _render();
  }

  function destroy() {
    if (_mountEl) _mountEl.innerHTML = '';
    // V3.294 — remove the once-bound outside-click closer so re-init for
    // the next paper (tab switch) doesn't leave a stale handler referencing
    // a detached _mountEl.
    if (_docClickBound) {
      document.removeEventListener('click', _onDocClick);
      _docClickBound = false;
    }
    _changeCallbacks = [];
    _active = new Set();
    _linkedDrafts = [];
    _paperItem = null;
  }

  window.PAPER_OVERLAYS = {
    init,
    // V3.103 draft API
    getActiveDraftIds, getLinkedDrafts, getColorForDraft, getFilterFn,
    linkDraft, unlinkDraft,
    openLinkPicker: _openLinkPicker,   // exposed so the inline evidence
                                        // form can offer "+ Add draft".
    onChange, destroy,
    // Backward-compat aliases (operate on drafts now). One-cycle bridge
    // for annotation-overlay.js stripes + annotation-panel.js chips.
    getActiveBucketIds: getActiveDraftIds,
    getLinkedBuckets:   getLinkedDrafts,
    getColorForBucket:  getColorForDraft,
  };
})();
