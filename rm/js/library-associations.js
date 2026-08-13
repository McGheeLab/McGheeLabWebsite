/* library-associations.js — V3.365
 *
 * The shared UI + resolver for "associations": the pills that mark which
 * papers-we're-writing (paper drafts and grant proposals) a library paper
 * feeds. The durable data is meta.library.linked_drafts on items/{id}
 * (written atomically by LIBRARY_LINKS.toggleDraftLink — V3.352); this
 * module adds the presentation layer used by the reader sidebar, the
 * library list popover, and any future surface.
 *
 * ACTIVE vs INACTIVE is DERIVED, never stored: a paper draft is active
 * while its projects/papers.json status !== 'published'; a grant is
 * active while its status is still a proposal status. Publishing a draft
 * (builder header status selector, V3.365) instantly renders all its
 * pills inactive everywhere — no migration, fully reversible.
 *
 * Public API (window.LIBRARY_ASSOC):
 *   loadDraftInfo(force)  → Promise<Map<draftId, info>> — cached 5 min.
 *       info = {id, title, kind:'paper'|'grant'|'unknown', status, active}
 *   getDraftInfoSync()    → the cached Map or null (sort/filter hot paths)
 *   resolve(draftId)      → info (unknown ids → inactive 'unknown' stub)
 *   invalidate()          → drop the cache (call after a status change)
 *   renderPills(el, item, opts) — pill row widget.
 *       opts = {onChanged(freshArray), showAdd=true, showCited=false}
 *   openAddPicker(item, onChanged) — checkbox modal of ACTIVE drafts only
 *       (inactive drafts can't gain new associations; existing inactive
 *       pills stay visible/removable in the row).
 *
 * The add-picker reuses the reader's link-picker modal CSS
 * (.lp-overlay-import-modal / .lp-oim-* / .lp-linkpick-* — global
 * style.css), so the two pickers look identical.
 */
(function () {
  'use strict';

  // Mirror of paper-overlays.js GRANT_DRAFT_STATUSES — proposal statuses
  // we'd still cite toward. Awarded/active/completed grants derive inactive.
  var GRANT_DRAFT_STATUSES = {
    drafting: 1, submitted: 1, under_review: 1, revising: 1, rejected: 1,
  };
  var TTL_MS = 5 * 60 * 1000;

  var _cache = null;      // Map<draftId, info>
  var _loadedAt = 0;
  var _loading = null;    // in-flight promise (dedupe concurrent callers)

  function _esc(s) {
    return String(s == null ? '' : s).replace(/[&<>"']/g, function (c) {
      return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c];
    });
  }

  /* ── Resolver ─────────────────────────────────────────────── */

  function loadDraftInfo(force) {
    if (!force && _cache && (Date.now() - _loadedAt) < TTL_MS) {
      return Promise.resolve(_cache);
    }
    if (_loading) return _loading;
    _loading = _fetch().then(function (map) {
      _loading = null;
      return map;
    }, function (err) {
      _loading = null;
      throw err;
    });
    return _loading;
  }

  async function _fetch() {
    var map = new Map();
    // Paper drafts — projects/papers.json is the paper-builder's source
    // of truth. Active while not published.
    try {
      if (typeof api !== 'undefined' && api.load) {
        var pdata = await api.load('projects/papers.json');
        (((pdata && pdata.papers) || [])).forEach(function (p) {
          if (!p || !p.id) return;
          var status = p.status || 'drafting';
          // V3.561 — kind follows the row's paper_type: a grant written in
          // the paper builder resolves as kind 'grant' (it used to resolve
          // as 'paper', which mis-filed builder grants as outputs on the
          // research map and gave them the 📝 pill instead of 📑).
          var isGrant = p.paper_type === 'grant';
          map.set(p.id, {
            id: p.id, title: p.title || p.id,
            kind: isGrant ? 'grant' : 'paper',
            paper_type: p.paper_type || 'journal',
            status: status,
            active: isGrant ? !!GRANT_DRAFT_STATUSES[status] : status !== 'published',
          });
        });
      }
    } catch (e) {
      console.warn('[library-assoc] projects/papers.json load failed:', e.message || e);
    }
    // Grants — ALL items.json grants (not just proposal-status ones) so
    // an old link to an awarded grant still resolves its title; `active`
    // carries the lifecycle.
    try {
      if (typeof api !== 'undefined' && api.load) {
        var idata = await api.load('items.json');
        (((idata && idata.items) || [])).forEach(function (it) {
          if (!it || it.type !== 'grant' || map.has(it.id)) return;
          map.set(it.id, {
            id: it.id, title: it.title || it.id, kind: 'grant',
            status: it.status || '', active: !!GRANT_DRAFT_STATUSES[it.status],
          });
        });
      }
    } catch (e) {
      console.warn('[library-assoc] items.json load failed:', e.message || e);
    }
    // grantDrafts collection (V3.179 grant writer) — in-progress proposals.
    try {
      if (typeof firebridge !== 'undefined' && firebridge.db &&
          firebridge.isLabMember && firebridge.isLabMember()) {
        var snap = await firebridge.db().collection('grantDrafts').get();
        snap.docs.forEach(function (d) {
          if (map.has(d.id)) return;   // legacy items.json entry wins
          var data = d.data() || {};
          var status = data.status || 'drafting';
          map.set(d.id, {
            id: d.id, title: data.title || d.id, kind: 'grant',
            status: status, active: !!GRANT_DRAFT_STATUSES[status],
          });
        });
      }
    } catch (e) {
      console.warn('[library-assoc] grantDrafts load failed:', e.message || e);
    }
    _cache = map;
    _loadedAt = Date.now();
    return map;
  }

  function getDraftInfoSync() { return _cache; }

  function resolve(draftId) {
    if (_cache && _cache.has(draftId)) return _cache.get(draftId);
    // Deleted draft / not-yet-loaded cache: render as an inactive,
    // removable pill instead of breaking.
    return { id: draftId, title: draftId, kind: 'unknown', status: '', active: false };
  }

  function invalidate() { _cache = null; _loadedAt = 0; }

  /* ── Pills widget ─────────────────────────────────────────── */

  function _linkedIds(item) {
    var lib = (item.meta && item.meta.library) || {};
    return Array.isArray(lib.linked_drafts) ? lib.linked_drafts.slice() : [];
  }
  function _citedIds(item) {
    var lib = (item.meta && item.meta.library) || {};
    return Array.isArray(lib.cited_in_drafts) ? lib.cited_in_drafts : [];
  }

  function renderPills(container, item, opts) {
    if (!container || !item) return;
    opts = opts || {};
    if (!_cache) {
      container.innerHTML = '<span class="la-loading">Loading drafts…</span>';
      loadDraftInfo().then(function () {
        renderPills(container, item, opts);
      }).catch(function () {
        container.innerHTML = '<span class="la-loading">Drafts unavailable.</span>';
      });
      return;
    }

    var ids = _linkedIds(item);
    var cited = _citedIds(item);
    var infos = ids.map(resolve);
    var active = infos.filter(function (i) { return i.active; });
    var inactive = infos.filter(function (i) { return !i.active; });
    var byTitle = function (a, b) { return (a.title || '').localeCompare(b.title || ''); };
    active.sort(byTitle);
    inactive.sort(byTitle);
    var showInactive = container.dataset.laShowInactive === '1';

    function pillHtml(info, isInactive) {
      var uncited = opts.showCited && !isInactive && cited.indexOf(info.id) < 0;
      var titleAttr = info.title +
        (info.kind !== 'unknown' ? ' — ' + info.kind : ' — draft not found') +
        (info.status ? ' (' + info.status + ')' : '') +
        (uncited ? ' · not yet cited in this draft' : '');
      return '<span class="la-pill' +
          (info.kind === 'grant' ? ' la-pill-grant' : '') +
          (isInactive ? ' la-pill-inactive' : '') +
          '" title="' + _esc(titleAttr) + '">' +
        (uncited ? '<span class="la-uncited-dot" title="Linked but not yet cited in this draft"></span>' : '') +
        '<span class="la-pill-title">' + _esc(info.title) + '</span>' +
        (isInactive && info.status ? '<span class="la-pill-status">' + _esc(info.status) + '</span>' : '') +
        '<button class="la-pill-x" data-la-remove="' + _esc(info.id) + '" title="Remove this association">×</button>' +
        '</span>';
    }

    var html = '';
    if (!ids.length) {
      html += '<span class="la-empty">Not used in any draft yet.</span>';
    } else {
      html += active.map(function (i) { return pillHtml(i, false); }).join('');
      if (inactive.length) {
        html += '<button class="la-inactive-toggle" data-la-toggle-inactive="1">' +
          (showInactive ? '− hide' : '+' + inactive.length) + ' inactive</button>';
        if (showInactive) {
          html += inactive.map(function (i) { return pillHtml(i, true); }).join('');
        }
      }
    }
    if (opts.showAdd !== false) {
      html += '<button class="la-add-btn" data-la-add="1" title="Associate this paper with an active draft">＋</button>';
    }
    container.innerHTML = html;
    container.classList.add('la-pill-row');

    // One handler per render (assignment, not addEventListener — re-renders
    // must not stack listeners).
    container.onclick = async function (ev) {
      var toggleBtn = ev.target.closest('[data-la-toggle-inactive]');
      if (toggleBtn) {
        container.dataset.laShowInactive = showInactive ? '' : '1';
        renderPills(container, item, opts);
        return;
      }
      var addBtn = ev.target.closest('[data-la-add]');
      if (addBtn) {
        openAddPicker(item, opts.onChanged);
        return;
      }
      var removeBtn = ev.target.closest('[data-la-remove]');
      if (removeBtn) {
        var draftId = removeBtn.getAttribute('data-la-remove');
        removeBtn.disabled = true;
        try {
          var fresh = await window.LIBRARY_LINKS.toggleDraftLink(item.id, draftId, false);
          item.meta = item.meta || {};
          item.meta.library = item.meta.library || {};
          item.meta.library.linked_drafts = fresh;
          renderPills(container, item, opts);
          if (typeof opts.onChanged === 'function') opts.onChanged(fresh);
        } catch (e) {
          console.error('[library-assoc] unlink failed:', e);
          removeBtn.disabled = false;
          alert('Failed to remove association: ' + (e.message || e));
        }
      }
    };
  }

  /* ── Add picker (active drafts only) ──────────────────────── */

  async function openAddPicker(item, onChanged) {
    if (!item) return;
    var existing = document.getElementById('la-add-picker');
    if (existing) existing.remove();

    var map;
    try {
      map = await loadDraftInfo();
    } catch (e) {
      alert('Could not load drafts: ' + (e.message || e));
      return;
    }
    var linked = new Set(_linkedIds(item));
    var all = Array.from(map.values()).filter(function (i) { return i.active; });
    var sections = [
      { name: 'Paper drafts', kind: 'paper', hint: 'Papers we’re writing — from projects/papers' },
      { name: 'Grant drafts', kind: 'grant', hint: 'Grant proposals still in play' },
    ];
    sections.forEach(function (s) {
      s.rows = all.filter(function (d) { return d.kind === s.kind; });
      s.rows.sort(function (a, b) {
        var al = linked.has(a.id) ? 0 : 1, bl = linked.has(b.id) ? 0 : 1;
        if (al !== bl) return al - bl;
        return (a.title || '').localeCompare(b.title || '');
      });
    });

    function renderRow(d) {
      var isLinked = linked.has(d.id);
      var hint = d.status ? '<span class="lp-linkpick-hint">(' + _esc(d.status) + ')</span>' : '';
      return '<label class="lp-linkpick-row' + (isLinked ? ' lp-linkpick-row-linked' : '') + '"' +
        ' data-row-search="' + _esc(((d.title || '') + ' ' + d.id).toLowerCase()) + '">' +
        '<input type="checkbox" data-draft-id="' + _esc(d.id) + '"' + (isLinked ? ' checked' : '') + '>' +
        '<span class="lp-linkpick-titlewrap">' +
        '<span class="lp-linkpick-title">' + _esc(d.title || d.id) + '</span>' + hint +
        '</span></label>';
    }
    function renderSection(s) {
      if (!s.rows.length) {
        return '<div class="lp-linkpick-group">' +
          '<div class="lp-linkpick-group-head">' + _esc(s.name) + ' <span class="lp-linkpick-group-count">0</span></div>' +
          '<div class="lp-linkpick-empty">' + _esc(s.hint) + '. None active right now.</div></div>';
      }
      return '<div class="lp-linkpick-group">' +
        '<div class="lp-linkpick-group-head">' + _esc(s.name) +
        ' <span class="lp-linkpick-group-count">' + s.rows.length + '</span></div>' +
        s.rows.map(renderRow).join('') + '</div>';
    }

    var modal = document.createElement('div');
    modal.id = 'la-add-picker';
    modal.className = 'lp-overlay-import-modal';
    modal.innerHTML =
      '<div class="lp-oim-backdrop"></div>' +
      '<div class="lp-oim-card">' +
      '<div class="lp-oim-head">Associate with a draft</div>' +
      '<div class="lp-oim-summary">Pick the active paper drafts and grant proposals this journal paper is relevant to. ' +
      'Associated papers surface in the builder’s citation picker and References tab for that draft.</div>' +
      '<div class="lp-linkpick-search-wrap"><input id="la-pick-search" type="text" placeholder="Search drafts…" autocomplete="off"></div>' +
      '<div class="lp-linkpick-list">' + sections.map(renderSection).join('') + '</div>' +
      '<div class="lp-oim-foot">' +
      '<button class="btn btn-sm" id="la-pick-cancel">Cancel</button>' +
      '<button class="btn btn-sm lp-oim-primary" id="la-pick-save">Save</button>' +
      '</div></div>';
    document.body.appendChild(modal);

    var close = function () { modal.remove(); };
    modal.querySelector('.lp-oim-backdrop').addEventListener('click', close);
    modal.querySelector('#la-pick-cancel').addEventListener('click', close);

    var searchInp = modal.querySelector('#la-pick-search');
    searchInp.addEventListener('input', function () {
      var tokens = searchInp.value.trim().toLowerCase().split(/\s+/).filter(Boolean);
      modal.querySelectorAll('.lp-linkpick-group').forEach(function (group) {
        var visible = 0;
        group.querySelectorAll('.lp-linkpick-row').forEach(function (row) {
          var hay = row.getAttribute('data-row-search') || '';
          var show = !tokens.length || tokens.every(function (t) { return hay.indexOf(t) >= 0; });
          row.style.display = show ? '' : 'none';
          if (show) visible++;
        });
        var chip = group.querySelector('.lp-linkpick-group-count');
        if (chip) chip.textContent = String(visible);
      });
    });
    setTimeout(function () { searchInp.focus(); }, 0);

    modal.querySelector('#la-pick-save').addEventListener('click', async function (ev) {
      var btn = ev.currentTarget;
      btn.disabled = true;
      btn.textContent = 'Saving…';
      try {
        var desired = new Set();
        modal.querySelectorAll('input[data-draft-id]').forEach(function (c) {
          if (c.checked) desired.add(c.getAttribute('data-draft-id'));
        });
        // Diff against current — but ONLY over the active drafts listed in
        // this picker; inactive associations are never touched from here.
        var listed = new Set(all.map(function (d) { return d.id; }));
        var current = new Set(_linkedIds(item));
        var fresh = Array.from(current);
        for (const id of desired) {
          if (!current.has(id)) fresh = await window.LIBRARY_LINKS.toggleDraftLink(item.id, id, true);
        }
        for (const id of current) {
          if (listed.has(id) && !desired.has(id)) {
            fresh = await window.LIBRARY_LINKS.toggleDraftLink(item.id, id, false);
          }
        }
        item.meta = item.meta || {};
        item.meta.library = item.meta.library || {};
        item.meta.library.linked_drafts = fresh;
        close();
        if (typeof onChanged === 'function') onChanged(fresh);
      } catch (e) {
        console.error('[library-assoc] picker save failed:', e);
        btn.disabled = false;
        btn.textContent = 'Save';
        alert('Failed to save associations: ' + (e.message || e));
      }
    });
  }

  window.LIBRARY_ASSOC = {
    loadDraftInfo: loadDraftInfo,
    getDraftInfoSync: getDraftInfoSync,
    resolve: resolve,
    invalidate: invalidate,
    renderPills: renderPills,
    openAddPicker: openAddPicker,
  };
})();
