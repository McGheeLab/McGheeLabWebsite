/* yr-shared.js
 *
 * Shared utility layer for every page that touches categories / sub-categories.
 *
 * The public API (window.YR_SHARED) is:
 *   CAT_ORDER, CAT_LABEL, CAT_COLOR     — the seven canonical categories
 *   renderPicker({ctx, tree, ...})       — the unified 3-row chip+pill+browse picker
 *   getPickerResult(el)                  — read {category, sub_category} back out
 *   openBulkPicker({...})                — modal wrapper around renderPicker
 *   buildTreeFromRecords(records)        — {category, sub_category} rows → nested tree
 *   buildCountsFromRecords(records)      — {category, sub_category} rows → frequency map
 *   todayStr, isFuture, escapeHtml, slugify, fmtBytes, starBar
 */

(function () {
  const CAT_ORDER = ['service', 'research', 'teaching', 'admin', 'personal', 'noise', 'unknown'];
  const CAT_LABEL = {
    service: 'Service', research: 'Research', teaching: 'Teaching',
    admin: 'Administration', personal: 'Personal', noise: 'Noise', unknown: 'Unclassified',
  };
  const CAT_COLOR = {
    service: '#5b21b6', research: '#1e40af', teaching: '#92400e',
    admin: '#374151', personal: '#991b1b', noise: '#64748b', unknown: '#78350f',
  };

  /* ---------- small helpers ---------- */

  function todayStr() {
    return new Date().toISOString().slice(0, 10);
  }
  function isFuture(dateStr) {
    return (dateStr || '').slice(0, 10) > todayStr();
  }
  function escapeHtml(s) {
    return String(s || '').replace(/[&<>"']/g, c => ({
      '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;',
    }[c]));
  }
  function slugify(text) {
    return String(text || '').toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '');
  }
  function fmtBytes(n) {
    if (!n) return '0 B';
    const u = ['B', 'KB', 'MB', 'GB']; let i = 0;
    while (n >= 1024 && i < u.length - 1) { n /= 1024; i++; }
    return `${n.toFixed(n < 10 ? 1 : 0)} ${u[i]}`;
  }

  function starBar(current, onSet, sizePx = 13) {
    const el = document.createElement('span');
    el.className = 'stars';
    el.style.cssText = `user-select:none;font-size:${sizePx}px;cursor:pointer;letter-spacing:1px;white-space:nowrap`;
    for (let i = 1; i <= 5; i++) {
      const s = document.createElement('span');
      s.style.color = i <= (current || 0) ? '#f59e0b' : '#d1d5db';
      s.textContent = '\u2605';
      s.addEventListener('click', (ev) => {
        ev.stopPropagation();
        onSet(i === current ? 0 : i);
      });
      el.appendChild(s);
    }
    return el;
  }

  /* ---------- category/sub-category derivations ---------- */

  function buildTreeFromRecords(records) {
    const tree = {};
    for (const r of records || []) {
      const cat = r.category || 'unknown';
      const sub = r.sub_category || '';
      if (!sub) continue;
      const bucket = tree[cat] = tree[cat] || {};
      let node = bucket;
      for (const seg of sub.split(':')) {
        if (!seg) continue;
        node[seg] = node[seg] || {};
        node = node[seg];
      }
    }
    return tree;
  }

  // Fetch user-added seed paths and merge them into an existing tree+counts.
  // Called by every picker loader (email-review, calendar, etc.) so a path
  // added via activity-overview's "Add sub-category" button shows up in
  // every picker on the next page load. Silent on missing/malformed file.
  async function mergeSeedsIntoTree(tree, counts) {
    let doc = null;
    try {
      // Always go through the adapter — bare /api/data/ fetches don't exist
      // on the static deploy and would 404. If api.load isn't loaded yet
      // (script-order issue), bail rather than fall through to a doomed fetch.
      if (!window.api?.load) return;
      doc = await window.api.load('settings/category_seeds.json');
    } catch { return; }
    for (const r of ((doc && doc.paths) || [])) {
      const cat = r.category || '';
      const sub = r.sub_category || '';
      if (!cat || !sub) continue;
      addPathToTree(tree, cat, sub);
      if (counts) addPathToCounts(counts, cat, sub);
    }
  }

  function buildCountsFromRecords(records) {
    // Returns {category: {full_path: count}} — used to rank pills by frequency.
    const counts = {};
    for (const r of records || []) {
      const cat = r.category || 'unknown';
      const sub = r.sub_category || '';
      if (!sub) continue;
      const bucket = counts[cat] = counts[cat] || {};
      const segs = sub.split(':').filter(Boolean);
      // Count each prefix so shorter and longer paths both show up meaningfully.
      for (let i = 1; i <= segs.length; i++) {
        const p = segs.slice(0, i).join(':');
        bucket[p] = (bucket[p] || 0) + 1;
      }
    }
    return counts;
  }

  // Mutate a pre-built tree in place so new paths added via the picker show up
  // in every subsequent render without a page refresh. Every picker instance
  // on a page shares the same tree reference from the caller (e.g.
  // STATE.subcatTree / INBOX.tree / CAL_HISTORY_STATE.subcatTree).
  function addPathToTree(tree, category, subCategory) {
    if (!tree || !category || !subCategory) return;
    const bucket = tree[category] = tree[category] || {};
    let node = bucket;
    for (const seg of String(subCategory).split(':')) {
      if (!seg) continue;
      node[seg] = node[seg] || {};
      node = node[seg];
    }
  }
  function addPathToCounts(counts, category, subCategory) {
    if (!counts || !category || !subCategory) return;
    const bucket = counts[category] = counts[category] || {};
    const segs = String(subCategory).split(':').filter(Boolean);
    for (let i = 1; i <= segs.length; i++) {
      const p = segs.slice(0, i).join(':');
      bucket[p] = (bucket[p] || 0) + 1;
    }
  }

  // Fire a same-origin broadcast whenever the picker commits a path, so other
  // pickers in the same DOM (regardless of which caller mounted them) can
  // refresh their tree. Pages that cache their tree in page state listen for
  // this event and top it up via addPathToTree.
  function notifyPathCommitted(detail) {
    try { window.dispatchEvent(new CustomEvent('catpicker:commit', { detail })); } catch {}
  }

  function nodeAt(tree, cat, segs) {
    let node = tree[cat] || {};
    for (const s of segs) {
      if (!(s in node)) return null;
      node = node[s];
    }
    return node;
  }

  function collectAllPaths(tree, cat) {
    const node = tree[cat] || {};
    const out = [];
    const walk = (n, prefix) => {
      for (const k of Object.keys(n)) {
        const p = prefix ? `${prefix}:${k}` : k;
        out.push(p);
        if (Object.keys(n[k]).length) walk(n[k], p);
      }
    };
    walk(node, '');
    return out;
  }

  /* ---------- unified picker ----------
   *
   * renderPicker({
   *   ctx: {category, sub_category},
   *   tree, counts, suggestions,
   *   mode: 'full' | 'flat',
   *   mruKey,
   *   onChange(result),
   * }) → HTMLElement with ._getResult()
   *
   * Layout:
   *   Row 1: seven category chips (always visible)
   *   Row 2: path pills + search + "Browse all" (when a category is picked, mode=full)
   *   Row 3: breadcrumb + sibling-at-level grid (toggled by Browse all)
   *   Preview line at the bottom.
   */

  const MRU_CAP = 10;

  function loadMRU(mruKey, cat) {
    try {
      const raw = localStorage.getItem(`catpicker.mru.${mruKey}.${cat}`);
      if (raw) {
        const a = JSON.parse(raw);
        if (Array.isArray(a)) return a.slice(0, MRU_CAP);
      }
    } catch {}
    return [];
  }
  function pushMRU(mruKey, cat, path) {
    if (!path) return;
    try {
      const key = `catpicker.mru.${mruKey}.${cat}`;
      const current = loadMRU(mruKey, cat).filter(p => p !== path);
      current.unshift(path);
      localStorage.setItem(key, JSON.stringify(current.slice(0, MRU_CAP)));
    } catch {}
  }

  function renderPicker(opts) {
    opts = opts || {};
    const {
      ctx = {}, tree = {}, counts = {}, suggestions = [],
      mode = 'full', mruKey = 'default', onChange,
    } = opts;

    const root = document.createElement('div');
    root.className = 'cat-picker';
    root.tabIndex = -1;

    const state = {
      category: ctx.category || '',
      segments: (ctx.sub_category || '').split(':').filter(Boolean),
      search: '',
    };

    // Three stable child containers — each is re-filled on update without
    // being replaced, so the search <input> keeps focus across input events.
    const catsRow = document.createElement('div');
    catsRow.className = 'cat-picker-row cat-picker-cats';
    root.appendChild(catsRow);

    const searchRow = document.createElement('div');
    searchRow.className = 'cat-picker-row cat-picker-search-row';
    root.appendChild(searchRow);

    const body = document.createElement('div');
    body.className = 'cat-picker-row cat-picker-body';
    root.appendChild(body);

    const preview = document.createElement('div');
    preview.className = 'cat-picker-preview';
    root.appendChild(preview);

    /* Row 1 — category chips */
    function renderCats() {
      catsRow.innerHTML = '';
      CAT_ORDER.forEach((c, idx) => {
        const chip = document.createElement('button');
        chip.type = 'button';
        chip.className = `cat-picker-chip cat-toggle-${c}` + (state.category === c ? ' is-sel' : ' is-dim');
        chip.textContent = CAT_LABEL[c] || c;
        chip.title = `${CAT_LABEL[c] || c}  (hotkey: ${idx + 1})`;
        chip.addEventListener('click', () => pickCategory(c));
        catsRow.appendChild(chip);
      });
    }

    function pickCategory(c) {
      if (state.category !== c) {
        state.category = c;
        state.segments = [];
      }
      if (mode === 'flat') { commit('chip'); return; }
      renderCats();
      renderBody();
      updatePreview();
    }

    /* Row 2 — search input (mounted once, persists focus) */
    let searchInput;
    function renderSearchOnce() {
      searchRow.innerHTML = '';
      if (mode === 'flat') return;
      searchInput = document.createElement('input');
      searchInput.type = 'text';
      searchInput.className = 'cat-picker-search';
      searchInput.placeholder = 'Search any path (e.g. "presentation")';
      searchInput.value = state.search;
      searchInput.addEventListener('input', () => {
        state.search = searchInput.value;
        renderBody();
      });
      searchInput.addEventListener('keydown', (ev) => {
        if (ev.key === 'Escape') {
          searchInput.value = '';
          state.search = '';
          renderBody();
        } else if (ev.key === 'Enter') {
          ev.preventDefault();
          const matches = searchAllPaths(state.search);
          if (matches.length) {
            const m = matches[0];
            state.category = m.category;
            state.segments = m.path.split(':');
            searchInput.value = '';
            commit('search');
          } else if (state.search.trim() && state.category) {
            state.segments = state.search.trim().toLowerCase().split(':').map(s => s.trim()).filter(Boolean);
            searchInput.value = '';
            commit('new');
          }
        }
      });
      searchRow.appendChild(searchInput);
    }

    /* Row 3 — either drill-down OR search results, depending on query */
    function searchAllPaths(query) {
      const q = (query || '').trim().toLowerCase();
      if (!q) return [];
      const out = [];
      for (const cat of Object.keys(tree || {})) {
        for (const path of collectAllPaths(tree, cat)) {
          if (path.toLowerCase().includes(q) || cat.toLowerCase().includes(q)) {
            out.push({ category: cat, path });
          }
        }
      }
      // Rank: exact leaf > leaf-prefix > shortest path > alphabetical
      out.sort((a, b) => {
        const la = a.path.split(':').pop().toLowerCase();
        const lb = b.path.split(':').pop().toLowerCase();
        const aEx = la === q ? 0 : 1;
        const bEx = lb === q ? 0 : 1;
        if (aEx !== bEx) return aEx - bEx;
        const aPre = la.startsWith(q) ? 0 : 1;
        const bPre = lb.startsWith(q) ? 0 : 1;
        if (aPre !== bPre) return aPre - bPre;
        if (a.path.length !== b.path.length) return a.path.length - b.path.length;
        return (a.category + a.path).localeCompare(b.category + b.path);
      });
      return out.slice(0, 25);
    }

    function highlightMatch(text, q) {
      if (!q) return escapeHtml(text);
      const i = text.toLowerCase().indexOf(q.toLowerCase());
      if (i < 0) return escapeHtml(text);
      return escapeHtml(text.slice(0, i))
        + '<mark class="cat-picker-hit">' + escapeHtml(text.slice(i, i + q.length)) + '</mark>'
        + escapeHtml(text.slice(i + q.length));
    }

    function renderBody() {
      body.innerHTML = '';
      if (mode === 'flat') { updatePreview(); return; }
      if (state.search.trim()) renderSearchResults();
      else renderDrillDown();
      updatePreview();
    }

    function renderSearchResults() {
      const q = state.search.trim();
      const matches = searchAllPaths(q);
      const label = document.createElement('div');
      label.className = 'cat-picker-level-label';
      label.textContent = matches.length
        ? `${matches.length} match${matches.length === 1 ? '' : 'es'} across all categories`
        : (state.category
            ? `No existing matches. Press Enter to create "${q}" under ${state.category}.`
            : 'No matches — pick a category and press Enter to create.');
      body.appendChild(label);
      if (!matches.length) return;

      const list = document.createElement('div');
      list.className = 'cat-picker-level';
      for (const m of matches) {
        const pill = document.createElement('button');
        pill.type = 'button';
        pill.className = `cat-picker-path cat-toggle-${m.category}`;
        pill.title = `${m.category} \u25B8 ${m.path}`;
        pill.innerHTML = `<span class="cat-picker-path-cat">${escapeHtml(m.category)}</span>`
          + `<span class="cat-picker-path-sep">\u25B8</span>`
          + highlightMatch(m.path, q);
        pill.addEventListener('click', () => {
          state.category = m.category;
          state.segments = m.path.split(':');
          state.search = '';
          if (searchInput) searchInput.value = '';
          commit('search');
        });
        list.appendChild(pill);
      }
      body.appendChild(list);
    }

    function renderDrillDown() {
      if (!state.category) {
        const hint = document.createElement('div');
        hint.className = 'cat-picker-hint';
        hint.textContent = 'Pick a category above to drill into its sub-categories.';
        body.appendChild(hint);
        return;
      }

      // Breadcrumb
      const trail = document.createElement('div');
      trail.className = 'cat-picker-crumb-trail';
      const rootCrumb = document.createElement('button');
      rootCrumb.type = 'button';
      rootCrumb.className = 'cat-picker-crumb';
      rootCrumb.textContent = CAT_LABEL[state.category] || state.category;
      rootCrumb.addEventListener('click', () => { state.segments = []; renderBody(); });
      trail.appendChild(rootCrumb);
      state.segments.forEach((s, i) => {
        const arrow = document.createElement('span');
        arrow.className = 'cat-picker-arrow';
        arrow.textContent = ' \u25B8 ';
        trail.appendChild(arrow);
        const b = document.createElement('button');
        b.type = 'button';
        b.className = 'cat-picker-crumb';
        b.textContent = s;
        b.addEventListener('click', () => {
          state.segments = state.segments.slice(0, i + 1);
          renderBody();
        });
        trail.appendChild(b);
      });
      body.appendChild(trail);

      // At root (no segments picked yet), surface Recently-used paths so the
      // PI can one-click land on common destinations without drilling.
      if (!state.segments.length) {
        const mru = loadMRU(mruKey, state.category);
        if (mru.length) {
          const label = document.createElement('div');
          label.className = 'cat-picker-level-label';
          label.textContent = 'Recently used';
          body.appendChild(label);
          const list = document.createElement('div');
          list.className = 'cat-picker-level';
          for (const p of mru.slice(0, 6)) {
            const pill = document.createElement('button');
            pill.type = 'button';
            pill.className = 'cat-picker-path';
            pill.textContent = p;
            pill.addEventListener('click', () => {
              state.segments = p.split(':');
              commit('mru');
            });
            list.appendChild(pill);
          }
          body.appendChild(list);
        }
      }

      // Children at current level
      const node = nodeAt(tree, state.category, state.segments) || {};
      const children = Object.keys(node).sort();
      const levelLabel = document.createElement('div');
      levelLabel.className = 'cat-picker-level-label';
      levelLabel.textContent = state.segments.length
        ? `Children of "${state.segments[state.segments.length - 1]}"`
        : `Top-level sub-categories in ${CAT_LABEL[state.category] || state.category}`;
      body.appendChild(levelLabel);

      const level = document.createElement('div');
      level.className = 'cat-picker-level';
      if (!children.length) {
        const empty = document.createElement('div');
        empty.className = 'cat-picker-hint';
        empty.textContent = 'No existing children. Add one with "+ new…" or commit this path.';
        level.appendChild(empty);
      }
      for (const c of children) {
        const hasChildren = Object.keys(node[c] || {}).length > 0;
        const b = document.createElement('button');
        b.type = 'button';
        b.className = 'cat-picker-seg';
        b.textContent = hasChildren ? `${c} \u203A` : c;
        b.title = hasChildren ? 'Click to drill into its children' : 'Leaf — click to commit this path';
        b.addEventListener('click', () => {
          state.segments = [...state.segments, c];
          if (hasChildren) renderBody();
          else commit('drill');
        });
        level.appendChild(b);
      }
      const newSeg = document.createElement('button');
      newSeg.type = 'button';
      newSeg.className = 'cat-picker-seg is-new';
      newSeg.textContent = '+ new\u2026';
      newSeg.addEventListener('click', () => {
        const v = prompt('New segment name:');
        if (!v || !v.trim()) return;
        state.segments = [...state.segments, v.trim().toLowerCase()];
        commit('new');
      });
      level.appendChild(newSeg);
      if (state.segments.length > 0) {
        const stop = document.createElement('button');
        stop.type = 'button';
        stop.className = 'cat-picker-seg is-stop';
        stop.textContent = '\u2713 use this path';
        stop.addEventListener('click', () => commit('drill'));
        level.appendChild(stop);
      } else {
        // At the root: allow a broad "just this category, no sub-category"
        // commit. Useful for bulk items like noise/personal where a path
        // would be overkill. Skips MRU because an empty path isn't a path.
        const broad = document.createElement('button');
        broad.type = 'button';
        broad.className = 'cat-picker-seg is-stop';
        broad.textContent = `\u2713 use "${CAT_LABEL[state.category] || state.category}" only`;
        broad.title = 'Save just the top-level category, no sub-category';
        broad.addEventListener('click', () => commit('broad'));
        level.appendChild(broad);
      }
      body.appendChild(level);
    }

    function updatePreview() {
      if (!state.category) { preview.textContent = 'Pick a category \u2192'; return; }
      const path = state.segments.join(':');
      preview.textContent = path
        ? `${state.category} \u203A ${path}`
        : `${state.category} (no sub-category)`;
    }

    function commit(source) {
      // Defensive lowercase: ensures every committed sub_category stays in the
      // canonical casing even if a stale segment slips through via MRU or tree.
      const path = state.segments.join(':').toLowerCase();
      const result = {
        category: state.category,
        sub_category: path,
        source: source || 'commit',
      };
      if (result.category && result.sub_category) {
        // Mutate the shared tree/counts in place so this new path is visible
        // to every subsequent render of this picker AND to any other pickers
        // the caller may mount later against the same tree reference.
        addPathToTree(tree, result.category, result.sub_category);
        addPathToCounts(counts, result.category, result.sub_category);
        pushMRU(mruKey, result.category, result.sub_category);
        notifyPathCommitted({ category: result.category, sub_category: result.sub_category, mruKey });
      }
      state.search = '';
      if (searchInput) searchInput.value = '';
      renderCats();
      renderBody();
      updatePreview();
      if (typeof onChange === 'function') onChange(result);
    }

    // Keyboard: 1-7 select chip, / focus search, Esc clear.
    root.addEventListener('keydown', (ev) => {
      if (ev.target && ev.target.tagName === 'INPUT') return;
      if (ev.key >= '1' && ev.key <= String(CAT_ORDER.length)) {
        const c = CAT_ORDER[parseInt(ev.key, 10) - 1];
        if (c) { ev.preventDefault(); pickCategory(c); }
      } else if (ev.key === '/') {
        if (searchInput) { ev.preventDefault(); searchInput.focus(); }
      } else if (ev.key === 'Escape') {
        if (state.search) {
          state.search = '';
          if (searchInput) searchInput.value = '';
          renderBody();
        }
      }
    });

    renderCats();
    renderSearchOnce();
    renderBody();
    updatePreview();

    root._getResult = () => ({
      category: state.category,
      sub_category: state.segments.join(':').toLowerCase(),
    });
    return root;
  }

  function getPickerResult(el) {
    return el && typeof el._getResult === 'function'
      ? el._getResult()
      : { category: '', sub_category: '' };
  }

  function openBulkPicker({ tree, initial, title, onApply, suggestions, counts, mruKey }) {
    const back = document.createElement('div');
    back.style.cssText = 'position:fixed;inset:0;background:rgba(0,0,0,.4);z-index:90;display:flex;align-items:center;justify-content:center';
    const panel = document.createElement('div');
    panel.style.cssText = 'background:#fff;border-radius:10px;min-width:520px;max-width:760px;padding:18px 20px;box-shadow:0 20px 40px rgba(0,0,0,.25)';
    panel.innerHTML = `<h3 style="margin:0 0 10px 0;font-size:15px">${escapeHtml(title || 'Pick a category / sub-category')}</h3>
      <div class="cat-picker-bulk-host"></div>
      <div style="display:flex;gap:8px;justify-content:flex-end;margin-top:12px">
        <button class="btn" data-k="cancel">Cancel</button>
        <button class="btn btn-primary" data-k="apply">Apply</button>
      </div>`;
    back.appendChild(panel);
    document.body.appendChild(back);
    safeCloseOnBackdrop(back, panel, () => { if (back.parentNode) document.body.removeChild(back); });

    const picker = renderPicker({
      ctx: initial || {},
      tree: tree || {},
      counts: counts || {},
      suggestions: suggestions || [],
      mode: 'full',
      mruKey: mruKey || 'bulk',
    });
    panel.querySelector('.cat-picker-bulk-host').appendChild(picker);
    picker.focus();
    panel.querySelector('[data-k="cancel"]').addEventListener('click', () => document.body.removeChild(back));
    panel.querySelector('[data-k="apply"]').addEventListener('click', async () => {
      const result = getPickerResult(picker);
      if (!result.category) { alert('Pick a category first.'); return; }
      if (!result.sub_category) {
        if (!confirm('No sub-category chosen. Apply with category only?')) return;
      }
      document.body.removeChild(back);
      await onApply(result);
    });
  }

  window.YR_SHARED = {
    CAT_ORDER, CAT_LABEL, CAT_COLOR,
    todayStr, isFuture, escapeHtml, slugify, fmtBytes,
    starBar,
    renderPicker, getPickerResult, openBulkPicker,
    buildTreeFromRecords, buildCountsFromRecords,
    addPathToTree, addPathToCounts,
    mergeSeedsIntoTree,
  };
})();
