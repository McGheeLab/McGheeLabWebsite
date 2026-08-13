/* projects.js — pin-grid item hub for Research / Teaching pages.
 *
 * Each page sets PAGE_CATEGORY before loading. Items from data/items.json
 * matching that category render as pin-boxes in a grid that mirrors the
 * task dashboard's chrome (color border, type/title header, summary chips,
 * expandable detail body).
 *
 * The detail body inside a pin-box reuses the existing section helpers
 * (renderDetailsSection, renderRepoSection, renderTasksSection, etc.) —
 * only the outer card chrome was replaced. CRUD, linking, and form flows
 * are unchanged.
 */

var ITEMS_PATH = 'items.json';
var ROSTER_PATH = 'people/roster.json';
var FINANCE_PATH = 'finance/projects.json';
var INVENTORY_PATH = 'inventory/items.json';

var _pageCategory = (typeof PAGE_CATEGORY !== 'undefined') ? PAGE_CATEGORY : 'research';

var _allItems = [];
var _items = [];
var _roster = [];
var _financeProjects = [];
var _inventoryItems = [];
var _expandedId = null;
var _openSections = {};       // item-level: { itemId: { tasks: true, ... } }
var _filterType = 'all';      // type filter: 'all' | 'research_project' | 'grant' | 'paper' | ... | 'repo'
var _searchText = '';

var _CG = window.CARD_GRID || {};
var _YR = window.YR_SHARED || {};
var _CAT_COLOR = (_YR.CAT_COLOR) || {};
var _CAT_LABEL = (_YR.CAT_LABEL) || { research: 'Research', teaching: 'Teaching', service: 'Service' };

/* ---- Load & Render ---- */

var _bucketsDoc = null;  // for rendering linked-tasks section

/* V3.135 — first-author enforcement helpers. The schema field
 * `first_author_uids: string[]` (V3.133) gates "higher admin rights"
 * on paper items. Rules (per user decision):
 *   (a) edit paper metadata        → first author OR admin
 *   (b) add/remove personnel       → first author OR admin
 *   (c) add/remove project Members → admin only (existing rule)
 *   (d) delete the paper           → admin only
 *   (e) set/unset first authors    → admin only (V3.133)
 *
 * Server-side enforcement lives in firestore.rules (V3.135 update).
 * These client-side gates are matched UI affordances + defense-in-depth
 * checks at handler entry.
 */
function _myUid() {
  return (typeof firebridge !== 'undefined' && firebridge.getUser)
    ? ((firebridge.getUser() || {}).uid || null)
    : null;
}
function _isAdminUser() {
  return typeof firebridge !== 'undefined' && firebridge.isAdmin && firebridge.isAdmin();
}
function _canEditPaper(item) {
  if (!item) return false;
  if (_isAdminUser()) return true;
  if (item.type !== 'paper') return true;
  var uid = _myUid();
  return !!uid && Array.isArray(item.first_author_uids) && item.first_author_uids.indexOf(uid) !== -1;
}
function _canDeleteItem(item) {
  if (!item) return false;
  if (_isAdminUser()) return true;
  return item.type !== 'paper';
}

/* V3.130 — Surgical Firestore writes for items and canonical projects.
 *
 * The adapter's collection-save (api-firestore-adapter.js _saveFirestore)
 * does a full collection replace: every row in items.json becomes a
 * batch.set on items/{id}. With ~hundreds of items the rewrite easily
 * takes 5-15 seconds. Every Add Item / Edit Item / Add Member click on
 * /rm/pages/projects.html paid that cost.
 *
 * These helpers write the ONE changed doc directly to Firestore via
 * firebridge.db, then fire-and-forget the JSON shadow save so the local
 * mirror stays in sync without blocking the UI. Falls back to the full
 * api.save if firebridge isn't available (e.g. local dev w/o Firestore).
 */
async function saveItemSurgical(item) {
  if (!item || !item.id) throw new Error('saveItemSurgical: item.id required');
  if (typeof firebridge !== 'undefined' && firebridge.db && firebridge.getUser && firebridge.getUser()) {
    try {
      // Suppress our own live-sync echo so the items.json subscriber
      // doesn't trigger a full loadAll() re-fetch after the write.
      if (typeof _projLive !== 'undefined') _projLive.suppressUntil = Date.now() + 2500;
      var ref = firebridge.db().collection('items').doc(item.id);
      var clean = Object.assign({}, item);
      delete clean.id;
      clean.updatedAt = firebase.firestore.FieldValue.serverTimestamp();
      await ref.set(clean, { merge: true });
      // Fire-and-forget JSON shadow so file-backed dev mirror stays current.
      // This path no-ops in production where shadowJson is server-side.
      api.load(ITEMS_PATH).then(function (doc) {
        var arr = (doc && doc.items) || [];
        var i = arr.findIndex(function (r) { return r && r.id === item.id; });
        if (i >= 0) arr[i] = item; else arr.push(item);
        return api.save(ITEMS_PATH, doc);
      }).catch(function (err) {
        console.warn('[projects] surgical item save: shadow JSON write failed:', err && err.message);
      });
      return;
    } catch (err) {
      console.warn('[projects] surgical item save failed, falling back to full save:', err.message);
    }
  }
  // Fallback: full collection rewrite via the adapter.
  var data = await api.load(ITEMS_PATH);
  var arr = data.items || [];
  var idx = arr.findIndex(function (r) { return r && r.id === item.id; });
  if (idx >= 0) arr[idx] = item; else arr.push(item);
  data.items = arr;
  await api.save(ITEMS_PATH, data);
}

async function saveProjectDocSurgical(canon, row) {
  if (!canon || !canon.sourcePath || !canon.sourceKey) throw new Error('saveProjectDocSurgical: canon required');
  if (!row || !row.id) throw new Error('saveProjectDocSurgical: row.id required');
  if (typeof firebridge !== 'undefined' && firebridge.db && firebridge.getUser && firebridge.getUser()) {
    try {
      // Suppress our own live-sync echo (parallel to saveItemSurgical).
      if (typeof _projLive !== 'undefined') _projLive.suppressUntil = Date.now() + 2500;
      // The 4 typed JSONs (papers/courses/infrastructure/tools) shard the
      // single `projects` Firestore collection by `type`. Stamp the
      // discriminator on direct writes so adapter listing queries still
      // resolve it.
      var typeMap = { papers: 'paper', courses: 'course', infrastructure: 'infrastructure', tools: 'tool' };
      var typeVal = typeMap[canon.sourceKey] || canon.sourceKey;
      var ref = firebridge.db().collection('projects').doc(row.id);
      var clean = Object.assign({}, row);
      delete clean.id;
      clean.type = typeVal;
      clean.updatedAt = firebase.firestore.FieldValue.serverTimestamp();
      await ref.set(clean, { merge: true });
      // Fire-and-forget shadow JSON.
      api.load(canon.sourcePath).then(function (doc) {
        var arr = (doc && doc[canon.sourceKey]) || [];
        var i = arr.findIndex(function (r) { return r && r.id === row.id; });
        if (i >= 0) arr[i] = row; else arr.push(row);
        return api.save(canon.sourcePath, doc);
      }).catch(function (err) {
        console.warn('[projects] surgical canonical save: shadow JSON write failed:', err && err.message);
      });
      return;
    } catch (err) {
      console.warn('[projects] surgical canonical save failed, falling back to full save:', err.message);
    }
  }
  // Fallback: full collection rewrite via the adapter.
  var data = await api.load(canon.sourcePath);
  var arr = (data && data[canon.sourceKey]) || [];
  var idx = arr.findIndex(function (r) { return r && r.id === row.id; });
  if (idx >= 0) arr[idx] = row; else arr.push(row);
  if (!data) data = {};
  data[canon.sourceKey] = arr;
  await api.save(canon.sourcePath, data);
}

/* V3.126 — Members assignment now lives on the canonical `projects`
 * Firestore collection (the field PMR + Lab Notebook + future page-level
 * access gates all read), not on the legacy items.json `personnel[]`
 * field. The four typed JSON paths shard the same `projects` collection
 * by `type`. We load all four at boot and project them into a flat map
 * keyed by item id so the per-item Members section can read + write
 * `member_uids[]` without re-fetching.
 *
 * NOTE: items.json (legacy unified registry) and projects/<type>.json
 * (canonical projects collection) are NOT auto-mirrored Firestore
 * collections. Whether the same item id appears in BOTH is data-
 * dependent. The Members section silently no-ops on items that have no
 * canonical record — admins can create one via the migration page or by
 * editing projects/<type>.json directly. */
var _canonicalProjects = {};   // itemId → { sourcePath, sourceKey, member_uids[] }
var _CANONICAL_SOURCES = [
  { path: 'projects/papers.json',         key: 'papers' },
  { path: 'projects/courses.json',        key: 'courses' },
  { path: 'projects/infrastructure.json', key: 'infrastructure' },
  { path: 'projects/tools.json',          key: 'tools' },
];

/* V3.229 — papers and grant drafts now stream into the research view from
 * their builder-owned sources (projects/papers.json and the `grantDrafts`
 * Firestore collection). We materialize them as "virtual" items so the
 * existing pin-grid renderer treats them like any other items.json row,
 * but clicking through deep-links to the builder rather than expanding
 * inline. Items.json paper rows are filtered out (they're legacy
 * duplicates); items.json grant rows stay visible until a future
 * migration moves them into grantDrafts. */
var _canonicalPapersRaw = [];  // raw rows from projects/papers.json
var _grantDraftsCache = [];    // raw docs from grantDrafts collection
var _virtualItems = [];        // built from the two caches above
var _virtualGrantIds = new Set();

function _buildVirtualPaperItem(row) {
  return {
    id: row.id,
    title: row.title || '(untitled)',
    type: 'paper',
    category: 'research',
    status: row.status || 'drafting',
    description: '',
    notes: row.notes || '',
    personnel: [],
    tags: [],
    subtasks: [],
    related_ids: [],
    repo_path: row.repo_path || '',
    repo_org: row.repo_org || '',
    meta: {
      target_journal: row.target_journal || '',
      lead_author: row.lead_author || '',
    },
    first_author_uids: row.lead_author_uid ? [row.lead_author_uid] : [],
    funding_account_ids: [],
    created_at: '',
    updated_at: '',
    _builderHref: '/rm/pages/paper-builder.html?paper=' + encodeURIComponent(row.id),
  };
}

function _buildVirtualGrantItem(doc) {
  return {
    id: doc.id,
    title: doc.title || '(untitled)',
    type: 'grant',
    category: 'research',
    status: doc.status || 'drafting',
    description: '',
    notes: '',
    personnel: [],
    tags: [],
    subtasks: [],
    related_ids: [],
    repo_path: '',
    repo_org: '',
    meta: {
      funder: doc.agency || '',
      mechanism: doc.mechanism || '',
      submit_deadline: doc.deadlineISO || '',
      role: doc.pi ? 'PI' : '',
    },
    funding_account_ids: [],
    created_at: '',
    updated_at: '',
    _builderHref: '/rm/pages/grant-builder.html?grant=' + encodeURIComponent(doc.id),
  };
}

function _rebuildVirtualItems() {
  _virtualItems = [];
  _virtualGrantIds = new Set();
  if (_pageCategory !== 'research') return;
  _canonicalPapersRaw.forEach(function (p) {
    if (p && p.id) _virtualItems.push(_buildVirtualPaperItem(p));
  });
  _grantDraftsCache.forEach(function (g) {
    if (!g || !g.id) return;
    _virtualGrantIds.add(g.id);
    _virtualItems.push(_buildVirtualGrantItem(g));
  });
}

function _filterItemsForCategory(allItems) {
  var filtered = (allItems || []).filter(function (it) {
    if (it.category !== _pageCategory) return false;
    // Library-entry papers (uploaded via /pages/library.html) live in
    // items.json for cross-system references but shouldn't clutter the
    // Research → Projects view. They get their own page.
    var lib = (it.meta || {}).library;
    if (lib && lib.is_library_entry) return false;
    // V3.229 — papers come from projects/papers.json (paper-builder).
    // Items.json paper rows are legacy duplicates; hide them so the
    // research view doesn't double-list. Grants with an id present in
    // grantDrafts are also hidden — the virtual entry replaces them.
    if (it.type === 'paper') return false;
    if (it.type === 'grant' && _virtualGrantIds.has(it.id)) return false;
    return true;
  });
  return filtered.concat(_virtualItems);
}

async function _loadGrantDrafts() {
  if (_pageCategory !== 'research') return [];
  if (typeof firebridge === 'undefined' || !firebridge.db || !firebridge.isReady || !firebridge.isReady()) return [];
  try {
    var snap = await firebridge.db().collection('grantDrafts').get();
    return snap.docs.map(function (d) { return Object.assign({ id: d.id }, d.data()); });
  } catch (err) {
    console.warn('[projects] grantDrafts load failed:', err && err.message);
    return [];
  }
}

async function loadAll() {
  var results = await Promise.all([
    api.load(ITEMS_PATH),
    api.load(ROSTER_PATH),
    api.load(FINANCE_PATH),
    api.load(INVENTORY_PATH),
    api.load('tasks/buckets.json').catch(function () { return { taskBuilders: [] }; }),
    // V3.126 — canonical projects (4 typed JSONs sharded into the
    // `projects` Firestore collection). Each is .catch'd independently
    // so a missing file or permission glitch on one type doesn't blank
    // the whole Members surface.
    api.load('projects/papers.json').catch(function () { return null; }),
    api.load('projects/courses.json').catch(function () { return null; }),
    api.load('projects/infrastructure.json').catch(function () { return null; }),
    api.load('projects/tools.json').catch(function () { return null; }),
  ]);
  _allItems = results[0].items || [];

  // V3.229 — cache the paper-builder source rows now so the virtual-item
  // builder below can stamp them as paper items on the research view.
  _canonicalPapersRaw = ((results[5] && results[5].papers) || []).slice();

  // V3.229 — pull grant-builder drafts in parallel with the canonical
  // projects load. Firestore-only; no JSON shadow. Skipped on non-research
  // pages (teaching, service) where _pageCategory != 'research'.
  _grantDraftsCache = await _loadGrantDrafts();
  _rebuildVirtualItems();

  _items = _filterItemsForCategory(_allItems);

  // Build the personnel roster from BOTH the website's users/{uid} (the
  // canonical lab people source) AND the legacy people/roster.json. Legacy
  // entries are kept so existing item.personnel arrays that reference
  // kebab-case slugs (e.g. "alex-mcghee") still resolve names. New
  // assignments should pick from the Firestore users by uid going forward.
  var legacyRoster = (results[1].members || []).map(function (m) {
    return { id: m.id, name: m.name || '', role: m.role || '', email: m.email || '', _legacy: true };
  });
  _roster = legacyRoster.slice();
  if (typeof firebridge !== 'undefined' && firebridge.getAll && firebridge.isReady && firebridge.isReady()) {
    try {
      var _ud = await api.load('lab/users.json');
      var users = (_ud && _ud.users) || [];
      var seenIds = new Set(legacyRoster.map(function (m) { return m.id; }));
      var seenEmails = new Set(legacyRoster.map(function (m) { return (m.email || '').toLowerCase(); }).filter(Boolean));
      users.forEach(function (u) {
        if (!u.role || u.role === 'guest') return;
        // De-dupe by email (legacy entry might have a slug id, user has uid id).
        var em = (u.email || '').toLowerCase();
        if (em && seenEmails.has(em)) return;
        if (seenIds.has(u.id)) return;
        _roster.push({
          id: u.id, name: u.name || u.email || u.id,
          role: u.appointment || u.category || '',
          email: u.email || '',
          _firebaseUid: true,
        });
      });
    } catch (err) {
      console.warn('[projects] users merge failed; using legacy roster only:', err.message);
    }
  }

  _financeProjects = results[2].projects || [];
  _inventoryItems = results[3].items || [];
  _bucketsDoc = results[4] || { taskBuilders: [] };

  // V3.126 — build the canonical projects map (item id → source + member_uids[])
  // from the four typed JSONs loaded in slots 5-8. This is the read side; the
  // Members section's add/remove handlers re-load + save the same JSON paths
  // so the Firestore `projects` collection stays the single source of truth
  // for project membership across the whole RM surface.
  _canonicalProjects = {};
  _CANONICAL_SOURCES.forEach(function (src, i) {
    var data = results[5 + i];
    var rows = (data && data[src.key]) || [];
    rows.forEach(function (row) {
      if (!row || !row.id) return;
      _canonicalProjects[row.id] = {
        sourcePath: src.path,
        sourceKey: src.key,
        member_uids: Array.isArray(row.member_uids) ? row.member_uids.slice() : [],
      };
    });
  });

  // Honor ?item=<id> from links coming in from the dashboard so the targeted
  // card opens expanded.
  try {
    var params = new URLSearchParams(window.location.search);
    var hint = params.get('item');
    if (hint && _items.find(function (i) { return i.id === hint; })) {
      _expandedId = hint;
    }
  } catch {}

  render();
  if (_expandedId) {
    requestAnimationFrame(function () {
      var card = document.querySelector('.pin-box[data-item-id="' + _expandedId + '"]');
      if (card) card.scrollIntoView({ behavior: 'smooth', block: 'start' });
    });
  }
}

function render() {
  // Tear down any live Firestore listener held by the previously-rendered
  // claims panel. renderPinBox will mount a fresh one if a paper card is
  // expanded after this render.
  _disposeClaimsMount();
  var content = document.getElementById('content');
  renderFilterBar();

  var filtered = _items.filter(function (it) {
    if (it.type === 'email_task') return false;
    if (_filterType === 'repo') { if (!it.repo_path) return false; }
    else if (_filterType !== 'all' && it.type !== _filterType) return false;
    if (_searchText) {
      var q = _searchText.toLowerCase();
      var h = (it.title + ' ' + (it.description || '') + ' ' + (it.repo_path || '') + ' ' + (it.notes || '') + ' ' + it.type).toLowerCase();
      if (h.indexOf(q) === -1) return false;
    }
    return true;
  });

  if (filtered.length === 0) {
    content.innerHTML = '<div class="empty-state" style="padding:40px;text-align:center;color:#9ca3af">No items match. Click "+ Add Item" to create one.</div>';
    return;
  }

  var grid = document.createElement('div');
  grid.className = 'pin-grid' + (_expandedId ? ' focusing-row' : '');
  filtered.forEach(function (it) { grid.appendChild(renderPinBox(it)); });
  content.innerHTML = '';
  content.appendChild(grid);

  // Click anywhere on the pin-box (except interactive controls / inside the
  // expanded body) toggles focus mode for that card.
  grid.querySelectorAll('.pin-box').forEach(function (b) {
    b.addEventListener('click', function (e) {
      if (e.target.closest('button, input, select, a, textarea, .pin-card-body, .item-section')) return;
      var id = b.dataset.itemId;
      // V3.229 — virtual paper/grant items (sourced from the builders) deep-
      // link into their builder rather than expanding inline. Inline edit
      // doesn't make sense for these because their canonical writes go to
      // projects/papers.json or grantDrafts, not items.json.
      var clicked = _items.find(function (it) { return it.id === id; });
      if (clicked && clicked._builderHref) {
        window.location.href = clicked._builderHref;
        return;
      }
      _expandedId = (_expandedId === id) ? null : id;
      render();
      if (_expandedId) {
        requestAnimationFrame(function () {
          var focused = grid.querySelector('.pin-box.focused');
          if (focused) focused.scrollIntoView({ behavior: 'smooth', block: 'start' });
        });
      }
    });
  });
}

/* ---- Filter Bar (type chips + search) ---- */

function renderFilterBar() {
  var bar = document.getElementById('filter-bar');
  if (!bar) return;
  bar.innerHTML = '';

  var typesInCategory = [];
  Object.keys(ITEM_TYPES).forEach(function (t) {
    if (ITEM_TYPES[t].category === _pageCategory) typesInCategory.push(t);
  });

  function chipBtn(value, label, count) {
    var btn = document.createElement('button');
    btn.className = 'filter-btn' + (_filterType === value ? ' active' : '');
    btn.textContent = label + (count != null ? ' (' + count + ')' : '');
    btn.onclick = function () { _filterType = value; render(); };
    return btn;
  }

  bar.appendChild(chipBtn('all', 'All', _items.filter(function (i) { return i.type !== 'email_task'; }).length));
  typesInCategory.forEach(function (t) {
    var n = _items.filter(function (i) { return i.type === t; }).length;
    bar.appendChild(chipBtn(t, ITEM_TYPES[t].label, n));
  });
  // "Repos" filter — items in this category that have a repo_path
  var repoCount = _items.filter(function (i) { return i.repo_path; }).length;
  if (repoCount > 0) bar.appendChild(chipBtn('repo', 'Repos', repoCount));

  var spacer = document.createElement('div');
  spacer.style.flex = '1';
  bar.appendChild(spacer);

  var search = document.createElement('input');
  search.type = 'text';
  search.placeholder = 'Search...';
  search.value = _searchText;
  search.oninput = function () { _searchText = search.value; render(); };
  bar.appendChild(search);
}

/* ---- Pin-box rendering (one per item) ---- */

function renderPinBox(item) {
  var isExpanded = _expandedId === item.id;
  var color = (_CG.itemColor) ? _CG.itemColor(item) : (_CAT_COLOR[item.category] || '#6b7280');

  var box = document.createElement('div');
  box.className = 'pin-box';
  if (isExpanded) { box.classList.add('expanded'); box.classList.add('focused'); }
  box.style.borderLeft = '5px solid ' + color;
  box.dataset.itemId = item.id;

  // ----- Header -----
  var head = document.createElement('div');
  head.className = 'pin-box-head';

  var titleWrap = document.createElement('div');
  titleWrap.className = 'pin-box-title';
  var typeLine = document.createElement('div');
  typeLine.className = 'pin-box-cat';
  typeLine.style.color = color;
  typeLine.textContent = typeLabel(item.type);
  titleWrap.appendChild(typeLine);
  var titleEl = document.createElement('div');
  titleEl.className = 'pin-box-sub';
  titleEl.textContent = item.title;
  titleEl.title = item.title;
  titleWrap.appendChild(titleEl);
  head.appendChild(titleWrap);

  var meta = document.createElement('div');
  meta.className = 'pin-box-meta';
  meta.innerHTML = statusChip(item.status);
  var subtasks = item.subtasks || [];
  var openCount = subtasks.filter(function (s) { return s.status !== 'completed'; }).length;
  if (openCount > 0) {
    var c = document.createElement('span');
    c.className = 'pin-box-count';
    c.textContent = openCount;
    c.title = openCount + ' open task' + (openCount === 1 ? '' : 's');
    meta.appendChild(c);
  }
  // Linked-buckets indicator: ↗ N
  var linkedBuckets = (window.LINKS && _bucketsDoc) ? LINKS.linkedBucketsForItem(item, _bucketsDoc) : [];
  if (linkedBuckets.length) {
    var lb = document.createElement('span');
    lb.className = 'pin-box-count';
    lb.style.background = '#dbeafe';
    lb.style.color = '#1e3a8a';
    lb.textContent = '↗ ' + linkedBuckets.length;
    lb.title = 'Linked task project' + (linkedBuckets.length === 1 ? '' : 's') + ': ' +
      linkedBuckets.map(function (b) { return b.title; }).join(', ');
    meta.appendChild(lb);
  }
  if (isExpanded) {
    var exitBtn = document.createElement('button');
    exitBtn.className = 'pin-expand';
    exitBtn.title = 'Exit focus view';
    exitBtn.style.fontSize = '14px';
    exitBtn.textContent = '×';
    exitBtn.addEventListener('click', function (ev) {
      ev.stopPropagation();
      _expandedId = null;
      render();
    });
    meta.appendChild(exitBtn);
  }
  head.appendChild(meta);

  head.style.cursor = 'pointer';
  box.appendChild(head);

  // ----- Summary chips row (always visible) -----
  var summaryRow = document.createElement('div');
  summaryRow.className = 'pin-card-chips';
  summaryRow.style.cssText = 'padding:6px 14px 8px 14px;display:flex;flex-wrap:wrap;gap:6px;font-size:11px';
  appendItemChips(summaryRow, item);
  if (summaryRow.children.length) box.appendChild(summaryRow);

  // ----- Focused body: hero block (key info inlined) + details accordions -----
  if (isExpanded) {
    var body = document.createElement('div');
    body.className = 'pin-card-body item-focus-body';
    // V3.234 — external-links placeholder rendered between hero and the
    // detail accordions; mounted via EXTERNAL_LINKS.mount after innerHTML.
    body.innerHTML = renderItemHero(item) +
                     '<div data-ext-links-mount style="padding:0 14px"></div>' +
                     renderItemDetailAccordions(item);
    box.appendChild(body);

    // Mount the live claims panel into any [data-claims-mount] placeholder
    // (paper items get one). Track the unmount fn so the next render can
    // tear down the prior listener cleanly.
    var mountEl = body.querySelector('[data-claims-mount]');
    if (mountEl && window.CLAIMS_PANEL) {
      var draftId = mountEl.dataset.claimsMount;
      _disposeClaimsMount();
      _claimsUnmount = window.CLAIMS_PANEL.mount(mountEl, draftId);
    }

    // V3.234 — external links block on every item type. Gate writes on the
    // same edit gate the rest of the card uses (paper items: first-author
    // or admin; everything else: any lab member).
    var extHost = body.querySelector('[data-ext-links-mount]');
    if (extHost && window.EXTERNAL_LINKS) {
      if (!Array.isArray(item.externalLinks)) item.externalLinks = [];
      window.EXTERNAL_LINKS.mount({
        container: extHost,
        getLinks: function () { return item.externalLinks || []; },
        setLinks: function (next) {
          item.externalLinks = next;
          saveItemSurgical(item).catch(function (err) {
            console.warn('[projects] externalLinks save failed:', err && err.message);
          });
        },
        readOnly: !_canEditPaper(item),
      });
    }
  }

  return box;
}

var _claimsUnmount = null;
function _disposeClaimsMount() {
  if (_claimsUnmount) {
    try { _claimsUnmount(); } catch (e) { /* ignore */ }
    _claimsUnmount = null;
  }
}

/* ---- Hero block: the always-visible top of a focused card ---- */

function renderItemHero(item) {
  var html = '<div class="item-hero">';
  if (item.description) {
    html += '<div class="item-hero-desc">' + escHtml(item.description) + '</div>';
  }
  var heroMeta = renderHeroMeta(item);
  if (heroMeta) html += heroMeta;
  if (item.tags && item.tags.length) {
    html += '<div class="item-hero-tags">';
    item.tags.forEach(function (t) { html += '<span class="repo-tech-chip">' + escHtml(t) + '</span> '; });
    html += '</div>';
  }
  html += renderLinkedTasksHero(item);
  html += renderHeroActions(item);
  html += '</div>';
  return html;
}

function renderHeroMeta(item) {
  var m = item.meta || {};
  var typeCfg = ITEM_TYPES[item.type] || {};
  var fields = typeCfg.metaFields || [];
  var rows = [];
  fields.forEach(function (f) {
    var val = m[f.key];
    if (val === undefined || val === null || val === '') return;
    var display = val;
    if (f.type === 'date' && val !== 'TBD') display = formatDate(val);
    if (f.type === 'number' && f.key === 'total_budget') display = '$' + Number(val).toLocaleString();
    rows.push({ label: f.label, value: String(display) });
  });
  // Repo path inline (conference cards etc.)
  if (item.repo_path && rows.length < 8) {
    rows.push({ label: 'Repo', value: item.repo_path, mono: true });
  }
  if (!rows.length) return '';
  var html = '<div class="item-hero-meta">';
  rows.forEach(function (r) {
    html += '<div class="item-hero-meta-row">';
    html += '<span class="item-hero-meta-k">' + escHtml(r.label) + '</span>';
    if (r.mono) html += '<code class="item-hero-meta-v mono">' + escHtml(r.value) + '</code>';
    else html += '<span class="item-hero-meta-v">' + escHtml(r.value) + '</span>';
    html += '</div>';
  });
  html += '</div>';
  return html;
}

function renderLinkedTasksHero(item) {
  if (!window.LINKS || !_bucketsDoc) return '';
  var linked = LINKS.linkedBucketsForItem(item, _bucketsDoc);
  if (!linked.length) return '';
  var html = '<div class="item-hero-tasks">';
  html += '<div class="item-hero-section-label">Linked task builders</div>';
  linked.forEach(function (proj) {
    var openCount = countOpenInBucketProject(proj);
    var earliest = earliestOpenDueInBucketProject(proj);
    html += '<div class="linked-task-row">';
    html += '<a class="linked-task-title" href="/rm/pages/tasks.html?project=' + encodeURIComponent(proj.id) + '">' + escHtml(proj.title) + '</a>';
    html += '<span class="chip chip-muted">' + openCount + ' open</span>';
    if (earliest) html += '<span class="chip chip-amber">due ' + earliest.slice(5) + '</span>';
    html += '<span style="flex:1"></span>';
    html += '<button class="btn btn-sm" onclick="event.stopPropagation(); LINKS.navigateToBucket(\'' + proj.id + '\')">Open →</button>';
    html += '<button class="btn btn-sm" title="Unlink" onclick="event.stopPropagation(); unlinkBucketFromItem(\'' + item.id + '\', \'' + proj.id + '\')">×</button>';
    html += '</div>';
  });
  html += '</div>';
  return html;
}

function renderHeroActions(item) {
  // V3.135 — gate Edit (paper-FA-or-admin) and Delete (paper-admin-only).
  var canEdit = _canEditPaper(item);
  var canDelete = _canDeleteItem(item);
  var html = '<div class="item-hero-actions">'
    + '<button class="btn btn-sm btn-primary" onclick="event.stopPropagation(); pinItemToDashboardUI(\'' + item.id + '\')">Pin to dashboard</button>'
    + '<button class="btn btn-sm" onclick="event.stopPropagation(); openLinkBucketPicker(\'' + item.id + '\')">+ Link existing project</button>'
    + '<span style="flex:1"></span>';
  if (canEdit) {
    html += '<button class="btn btn-sm" onclick="event.stopPropagation(); editItemById(\'' + item.id + '\')">Edit</button>';
  }
  if (canDelete) {
    html += '<button class="btn btn-sm btn-danger" onclick="event.stopPropagation(); deleteItemById(\'' + item.id + '\')">Delete</button>';
  }
  if (!canEdit && item.type === 'paper') {
    html += '<span class="item-hero-readonly" title="Only first authors and admins can edit this paper.">read-only</span>';
  }
  return html + '</div>';
}

/* ---- Detail accordions: opt-in deeper info below the hero ---- */

function renderItemDetailAccordions(item) {
  var sections = '';
  sections += renderTasksSection(item);
  // Repository section: always show for paper items so the "Write refs.bib"
  // action is reachable (the section explains how to set repo_path if not
  // already set). For other types, only show if a repo_path exists.
  if (item.repo_path || item.type === 'paper') sections += renderRepoSection(item);
  if (item.type === 'research_project') {
    sections += renderProjectToolsSection(item);
    sections += renderProjectReposSection(item);
  }
  sections += renderRelatedSection(item);
  sections += renderPersonnelSection(item);
  sections += renderMembersSection(item);
  if ((item.funding_account_ids && item.funding_account_ids.length > 0) || isGrantLike(item)) {
    sections += renderFundingSection(item);
  }
  if (item.notes) sections += renderNotesSection(item);
  // Paper items get a Literature Review section that mounts the live
  // CLAIMS_PANEL. The placeholder div is replaced by the mounted panel
  // after the card body lands in the DOM (see renderPinBox).
  if (item.type === 'paper') sections += renderLitReviewSection(item);
  if (!sections) return '';
  return '<div class="item-hero-section-label" style="margin-top:14px">More details</div>' + sections;
}

function renderLitReviewSection(item) {
  // Repo writes live in the Repository section. This section just has the
  // download fallback (useful when there's no sibling repo configured).
  var body = '<div class="lit-review-actions">'
           +   '<button class="btn btn-sm" onclick="event.stopPropagation(); exportBibtex(\'' + escHtml(item.id) + '\', false)">Download refs.bib</button>'
           +   '<span class="lit-review-hint">Use <strong>Write refs.bib</strong> in the Repository section to push directly into the sibling repo.</span>'
           + '</div>'
           + '<div class="lit-review-mount" data-claims-mount="' + escHtml(item.id) + '">'
           +   '<div class="lit-review-loading">Loading claims & evidence…</div>'
           + '</div>';
  return sectionHtml(item.id, 'lit_review', 'Literature review · claims & evidence', body, '');
}

window.exportBibtex = async function (draftId, writeToRepo) {
  if (!window.LIBRARY_EXPORT) {
    alert('Library export module not loaded.');
    return;
  }
  try {
    var data = await api.load(ITEMS_PATH);
    var draft = (data.items || []).find(function (it) { return it.id === draftId; });
    if (!draft) { alert('Draft not found.'); return; }
    if (writeToRepo) {
      if (!draft.repo_path) {
        alert('This paper has no repo_path set — open Edit and set one (e.g. ../MEBP-Paper).');
        return;
      }
      var res = await window.LIBRARY_EXPORT.writeToRepo(draftId, data.items, draft.repo_path);
      var msg = 'Wrote ' + res.wrote + ' (' + res.cited_count + ' citation' + (res.cited_count === 1 ? '' : 's') + ').';
      if (res.missing && res.missing.length) {
        msg += '\n\nNote: ' + res.missing.length + ' evidence link(s) reference paper IDs not found in items.json: '
             + res.missing.join(', ');
      }
      alert(msg);
    } else {
      var dl = await window.LIBRARY_EXPORT.downloadBibtex(draftId, data.items);
      console.log('[bibtex] downloaded', dl);
    }
  } catch (e) {
    console.error(e);
    alert('Export failed: ' + (e.message || e));
  }
};

/* ---- Summary chips on the collapsed card ---- */

function appendItemChips(container, item) {
  var m = item.meta || {};

  // Repo path
  if (item.repo_path) {
    var c = document.createElement('span');
    c.style.cssText = 'font-size:11px;padding:1px 7px;border-radius:10px;background:#f3f4f6;color:#374151;font-family:ui-monospace,monospace';
    c.textContent = item.repo_path;
    c.title = 'Repo path';
    container.appendChild(c);
  }

  // Type-specific chips
  var dueDate = null, dueLabel = '';
  if (item.type === 'grant') {
    dueDate = m.submit_deadline || m.projected_submission_date || null;
    dueLabel = m.submit_deadline ? 'Submit' : 'Projected submit';
    if (m.funder) container.appendChild(makeChip(m.funder, '#dbeafe', '#1e3a8a'));
    if (m.role) container.appendChild(makeChip(m.role, '#e0e7ff', '#3730a3'));
  } else if (item.type === 'paper') {
    dueDate = m.projected_submission_date || null;
    dueLabel = 'Submit';
    if (m.target_journal) container.appendChild(makeChip(m.target_journal, '#fef3c7', '#92400e'));
    if (m.lead_author) container.appendChild(makeChip(m.lead_author, '#f3f4f6', '#374151'));
  } else if (item.type === 'course') {
    if (m.number) container.appendChild(makeChip(m.number, '#dbeafe', '#1e3a8a'));
    if (m.semester) container.appendChild(makeChip(m.semester, '#f3f4f6', '#374151'));
    if (m.enrollment) container.appendChild(makeChip(m.enrollment + ' students', '#f3f4f6', '#374151'));
  } else if (item.type === 'conference') {
    dueDate = m.date || null;
    dueLabel = 'Date';
    if (m.role) container.appendChild(makeChip(m.role, '#e0e7ff', '#3730a3'));
    if (m.location) container.appendChild(makeChip(m.location, '#f3f4f6', '#374151'));
  } else if (item.type === 'research_project') {
    if (m.research_area) container.appendChild(makeChip(m.research_area, '#dbeafe', '#1e3a8a'));
  }

  if (dueDate && dueDate !== 'TBD') {
    var dueChip = document.createElement('span');
    dueChip.style.cssText = 'font-size:11px;padding:1px 7px;border-radius:10px;font-variant-numeric:tabular-nums';
    var dur = (_CG.duePrefix) ? _CG.duePrefix(dueDate) : '';
    if (dur === 'due-overdue') { dueChip.style.background = '#fecaca'; dueChip.style.color = '#7f1d1d'; }
    else if (dur === 'due-soon') { dueChip.style.background = '#fef3c7'; dueChip.style.color = '#92400e'; }
    else { dueChip.style.background = '#f3f4f6'; dueChip.style.color = '#374151'; }
    dueChip.textContent = dueLabel + ' ' + dueDate.slice(5);
    dueChip.title = dueLabel + ': ' + dueDate;
    container.appendChild(dueChip);
  }

  // Subtask rollup
  var subtasks = item.subtasks || [];
  if (subtasks.length) {
    var done = subtasks.filter(function (s) { return s.status === 'completed'; }).length;
    var stChip = makeChip(done + '/' + subtasks.length + ' tasks', '#ede9fe', '#5b21b6');
    container.appendChild(stChip);
  }

  // Personnel count
  if (item.personnel && item.personnel.length) {
    container.appendChild(makeChip(item.personnel.length + ' people', '#f3f4f6', '#374151'));
  }
}

function makeChip(text, bg, fg) {
  var c = document.createElement('span');
  c.style.cssText = 'font-size:11px;padding:1px 7px;border-radius:10px;background:' + bg + ';color:' + fg;
  c.textContent = text;
  return c;
}

function isGrantLike(item) {
  return item.type === 'grant' && (item.status === 'awarded' || item.status === 'active' || item.status === 'no_cost_extension');
}

/* ---- Section Helpers ---- */

function sectionState(itemId, section) {
  if (!_openSections[itemId]) return false;
  return !!_openSections[itemId][section];
}

function sectionHtml(itemId, sectionKey, label, bodyHtml, actionHtml) {
  var isOpen = sectionState(itemId, sectionKey);
  var cls = 'item-section' + (isOpen ? ' open' : '');
  var html = '<div class="' + cls + '" data-section="' + sectionKey + '">';
  html += '<div class="item-section-header" onclick="event.stopPropagation(); toggleSection(\'' + itemId + '\', \'' + sectionKey + '\')">';
  html += '<span>' + label + '</span>';
  if (actionHtml) html += '<span onclick="event.stopPropagation();">' + actionHtml + '</span>';
  html += '</div>';
  html += '<div class="item-section-body">' + bodyHtml + '</div>';
  html += '</div>';
  return html;
}

/* ---- Standard Sections ---- */

function renderDetailsSection(item) {
  var m = item.meta || {};
  var typeCfg = ITEM_TYPES[item.type] || {};
  var fields = typeCfg.metaFields || [];
  if (fields.length === 0 && !item.description) return '';

  var body = '';
  if (item.description) {
    body += '<div style="margin-bottom:10px;color:var(--text-muted);">' + escHtml(item.description) + '</div>';
  }
  body += '<div class="detail-meta">';
  fields.forEach(function (f) {
    var val = m[f.key];
    if (val !== undefined && val !== null && val !== '') {
      var display = val;
      if (f.type === 'date' && val !== 'TBD') display = formatDate(val);
      if (f.type === 'number' && f.key === 'total_budget') display = '$' + Number(val).toLocaleString();
      body += '<div class="detail-meta-item"><span class="detail-meta-label">' + f.label + '</span><span class="detail-meta-value">' + escHtml(String(display)) + '</span></div>';
    }
  });
  body += '</div>';
  if (item.tags && item.tags.length) {
    body += '<div style="margin-top:8px;">';
    item.tags.forEach(function (t) { body += '<span class="repo-tech-chip">' + escHtml(t) + '</span> '; });
    body += '</div>';
  }
  return sectionHtml(item.id, 'details', 'Details', body, '');
}

function renderRepoSection(item) {
  var body = '<div class="repo-info">';
  body += '<div class="repo-path-row">';
  if (item.repo_path) {
    body += '<code style="background:var(--bg);padding:2px 6px;border-radius:4px;">' + escHtml(item.repo_path) + '</code>';
    if (item.repo_org) body += ' <span class="chip chip-muted">' + escHtml(item.repo_org) + '</span>';
  } else {
    body += '<span class="lit-review-hint">No repo linked. Click <strong>Edit</strong> on this card and set <code>Repo Path</code> (e.g. <code>../MEBP-Paper</code>) to enable parsing and BibTeX writing.</span>';
  }
  body += '</div>';
  if (item.repo_parsed) {
    var rp = item.repo_parsed;
    body += '<div class="repo-parsed-summary">';
    if (rp.description) body += '<div>' + escHtml(rp.description) + '</div>';
    if (rp.language) body += '<span class="repo-tech-chip">' + escHtml(rp.language) + '</span> ';
    if (rp.key_technologies) {
      rp.key_technologies.forEach(function (t) { body += '<span class="repo-tech-chip">' + escHtml(t) + '</span> '; });
    }
    if (rp.last_activity) body += '<div style="margin-top:4px;font-size:12px;">Last: ' + escHtml(rp.last_activity) + '</div>';
    body += '</div>';
  }
  if (item.repo_parsed_at) {
    body += '<div style="font-size:11px;color:var(--text-muted);margin-top:4px;">Parsed: ' + formatDate(item.repo_parsed_at) + '</div>';
  }
  body += '</div>';
  var actions = '';
  if (item.repo_path) {
    actions += '<button class="btn btn-sm" onclick="parseRepo(\'' + item.id + '\')">' + (item.repo_parsed ? 'Update' : 'Parse Repo') + '</button>';
    // For paper items, the repository section is the natural home for
    // refs.bib generation — the .bib file lives next to the LaTeX in the
    // sibling repo.
    if (item.type === 'paper') {
      actions += ' <button class="btn btn-sm" onclick="event.stopPropagation(); exportBibtex(\'' + escHtml(item.id) + '\', true)" title="Generate refs.bib from claim evidence and write into ' + escHtml(item.repo_path) + '">Write refs.bib</button>';
    }
  }
  return sectionHtml(item.id, 'repo', 'Repository', body, actions);
}

function renderSubtaskStars(itemId, subIdx, current) {
  var html = '<span class="subtask-stars" onclick="event.stopPropagation()" style="display:inline-flex;align-items:center;gap:1px;font-size:13px;letter-spacing:1px;user-select:none;margin-left:6px">';
  for (var i = 1; i <= 5; i++) {
    var color = i <= current ? '#f59e0b' : '#d1d5db';
    html += '<span style="color:' + color + ';cursor:pointer" onclick="event.stopPropagation(); setItemSubtaskImportance(\'' + itemId + '\',' + subIdx + ',' + (i === current ? 0 : i) + ')" title="Importance ' + i + '/5">\u2605</span>';
  }
  html += '</span>';
  return html;
}

window.setItemSubtaskImportance = function (itemId, subIdx, value) {
  // Use the already-loaded in-memory list — no extra api.load round-trip.
  var item = _allItems.find(function (it) { return it.id === itemId; });
  if (!item || !item.subtasks || !item.subtasks[subIdx]) return;
  item.subtasks[subIdx].self_importance = Number(value) || 0;
  // Render NOW — star fills/empties instantly under the click.
  render();
  // Surgical save in the background; one doc, not the whole 3000+ collection.
  _saveItemSurgical(item).catch(function (err) {
    console.error('[projects] setItemSubtaskImportance save failed:', err);
  });
};

function renderTasksSection(item) {
  var subtasks = item.subtasks || [];
  var doneCount = subtasks.filter(function (s) { return s.status === 'completed'; }).length;
  var label = 'Tasks' + (subtasks.length ? ' (' + doneCount + '/' + subtasks.length + ')' : '');
  var body = '';
  if (subtasks.length === 0) {
    body = '<div class="subtask-empty">No tasks yet.</div>';
  } else {
    body = '<ul class="subtask-list">';
    subtasks.forEach(function (st, si) {
      var done = st.status === 'completed';
      var imp = Number(st.self_importance) || 0;
      body += '<li class="subtask-item">';
      body += '<input type="checkbox" ' + (done ? 'checked' : '') + ' onclick="event.stopPropagation(); toggleItemSubtask(\'' + item.id + '\',' + si + ')">';
      body += '<span class="subtask-title' + (done ? ' done' : '') + '">' + escHtml(st.title) + '</span>';
      body += renderSubtaskStars(item.id, si, imp);
      if (st.deadline && st.deadline !== 'TBD') body += '<span class="subtask-dates"><span>Due: ' + formatDate(st.deadline) + ' ' + deadlineChip(st.deadline) + '</span></span>';
      body += '<span class="subtask-actions">';
      body += '<button onclick="event.stopPropagation(); editItemSubtask(\'' + item.id + '\',' + si + ')">Edit</button>';
      body += '<button onclick="event.stopPropagation(); deleteItemSubtask(\'' + item.id + '\',' + si + ')">Del</button>';
      body += '</span></li>';
    });
    body += '</ul>';
  }
  var actions = '<button class="btn btn-sm btn-primary" onclick="event.stopPropagation(); addItemSubtask(\'' + item.id + '\')">+ Add</button>';
  return sectionHtml(item.id, 'tasks', label, body, actions);
}

/* ---- Project-specific: Tools section ---- */

function renderProjectToolsSection(item) {
  var related = item.related_ids || [];
  var tools = related.map(function (rid) { return _allItems.find(function (i) { return i.id === rid; }); })
    .filter(function (r) { return r && (r.type === 'lab_tool' || r.type === 'utility_tool'); });

  var label = 'Tools' + (tools.length ? ' (' + tools.length + ')' : '');
  var body = '';
  if (tools.length === 0) {
    body = '<div style="color:var(--text-muted);">No tools linked to this project.</div>';
  } else {
    tools.forEach(function (t) {
      body += '<div style="display:flex;align-items:center;gap:8px;padding:6px 0;border-bottom:1px solid var(--border);font-size:13px;">';
      body += typeBadge(t.type);
      body += '<strong>' + escHtml(t.title) + '</strong>';
      if (t.repo_path) body += ' <code style="background:var(--bg);padding:1px 5px;border-radius:3px;font-size:11px;">' + escHtml(t.repo_path) + '</code>';
      body += ' ' + statusChip(t.status);
      body += ' <span class="remove-link" onclick="event.stopPropagation(); unlinkRelated(\'' + item.id + '\', \'' + t.id + '\')">&times;</span>';
      body += '</div>';
    });
  }

  var actions = '<button class="btn btn-sm btn-primary" onclick="event.stopPropagation(); linkToolToProject(\'' + item.id + '\')">+ Add Tool</button>';
  return sectionHtml(item.id, 'tools', label, body, actions);
}

/* ---- Project-specific: Repos section ---- */

function renderProjectReposSection(item) {
  var related = item.related_ids || [];
  var repoItems = related.map(function (rid) { return _allItems.find(function (i) { return i.id === rid; }); })
    .filter(function (r) { return r && r.repo_path; });

  // Also include the project's own repo if it has one
  if (item.repo_path) {
    repoItems.unshift(item);
  }

  var label = 'Repos' + (repoItems.length ? ' (' + repoItems.length + ')' : '');
  var body = '';
  if (repoItems.length === 0) {
    body = '<div style="color:var(--text-muted);">No repos linked.</div>';
  } else {
    repoItems.forEach(function (r) {
      body += '<div style="display:flex;align-items:center;gap:8px;padding:6px 0;border-bottom:1px solid var(--border);font-size:13px;">';
      body += '<code style="background:var(--bg);padding:1px 5px;border-radius:3px;font-size:12px;">' + escHtml(r.repo_path) + '</code>';
      body += typeBadge(r.type);
      body += '<span>' + escHtml(r.title) + '</span>';
      if (r.repo_org) body += ' <span style="color:var(--text-muted);font-size:11px;">' + escHtml(r.repo_org) + '</span>';
      body += '</div>';
    });
  }

  var actions = '<button class="btn btn-sm btn-primary" onclick="event.stopPropagation(); linkRepoToProject(\'' + item.id + '\')">+ Link Repo</button>';
  return sectionHtml(item.id, 'project_repos', label, body, actions);
}

function renderRelatedSection(item) {
  var related = item.related_ids || [];
  // For project cards, filter out tools (shown in their own section)
  var isProject = item.type === 'research_project';
  var displayRelated = related.filter(function (rid) {
    if (!isProject) return true;
    var other = _allItems.find(function (i) { return i.id === rid; });
    return other && other.type !== 'lab_tool' && other.type !== 'utility_tool';
  });

  var label = 'Related Items' + (displayRelated.length ? ' (' + displayRelated.length + ')' : '');
  var body = '';
  if (displayRelated.length === 0) {
    body = '<div style="color:var(--text-muted);">No linked items.</div>';
  } else {
    displayRelated.forEach(function (rid) {
      var other = _allItems.find(function (i) { return i.id === rid; });
      var otherTitle = other ? other.title : rid;
      var otherBadge = other ? typeBadge(other.type) : '';
      body += '<span class="related-chip">' + otherBadge + ' ' + escHtml(otherTitle);
      body += ' <span class="remove-link" onclick="event.stopPropagation(); unlinkRelated(\'' + item.id + '\', \'' + rid + '\')">&times;</span>';
      body += '</span>';
    });
  }
  var actions = '<button class="btn btn-sm btn-primary" onclick="event.stopPropagation(); linkRelated(\'' + item.id + '\')">+ Link</button>';
  return sectionHtml(item.id, 'related', label, body, actions);
}

function renderPersonnelSection(item) {
  var personnel = item.personnel || [];
  var label = 'Personnel' + (personnel.length ? ' (' + personnel.length + ')' : '');
  var body = '';
  // V3.133 — first-author marking on papers (star toggle is admin-only).
  // V3.135 — Add Personnel + remove × are gated by _canEditPaper(item).
  var isPaper = item.type === 'paper';
  var firstAuthors = Array.isArray(item.first_author_uids) ? item.first_author_uids : [];
  var isAdminUser = _isAdminUser();
  var canEdit = _canEditPaper(item);
  if (personnel.length === 0) {
    body = '<div style="color:var(--text-muted);">No personnel assigned.</div>';
  } else {
    personnel.forEach(function (pid, pi) {
      var member = _roster.find(function (m) { return m.id === pid; });
      var display = member ? member.name : pid;
      var role = member ? member.role : '';
      var isFA = firstAuthors.indexOf(pid) !== -1;
      var chipClass = 'personnel-chip' + (isFA ? ' first-author' : '');
      body += '<span class="' + chipClass + '">';
      if (isPaper) {
        var starCls = 'first-author-star' + (isFA ? '' : ' off');
        var starTitle = isAdminUser
          ? (isFA ? 'Remove first-author status' : 'Mark as first author (max 2)')
          : 'Only admins can change first authors';
        var clickHandler = isAdminUser
          ? 'event.stopPropagation(); toggleFirstAuthor(\'' + item.id + '\',\'' + pid + '\')'
          : 'event.stopPropagation();';
        body += '<span class="' + starCls + '" title="' + escHtml(starTitle) + '" onclick="' + clickHandler + '">★</span>';
      }
      body += escHtml(display);
      if (role) body += ' <span style="color:var(--text-muted);">(' + escHtml(role) + ')</span>';
      if (canEdit) {
        body += ' <span class="remove-link" style="cursor:pointer;color:var(--text-muted);font-size:14px;" onclick="event.stopPropagation(); removePersonnel(\'' + item.id + '\',' + pi + ')">&times;</span>';
      }
      body += '</span>';
    });
    if (isPaper && firstAuthors.length) {
      body += '<div style="margin-top:6px;font-size:11px;color:var(--text-muted);">⭐ First authors have higher admin rights to this paper.</div>';
    }
  }
  var actions = canEdit
    ? '<button class="btn btn-sm btn-primary" onclick="event.stopPropagation(); addPersonnel(\'' + item.id + '\')">+ Add</button>'
    : '';
  return sectionHtml(item.id, 'personnel', label, body, actions);
}

/* V3.126 — Project Members section. This is the canonical surface for
 * "who can see / edit this project across RM" — the field every page
 * that gates by project membership reads (PMR, Lab Notebook, future
 * page-level access controls). Distinct from the legacy Personnel
 * section above, which lives on items.json's `personnel[]` (mixed
 * roster-id + uid free-text field, primarily for human-readable
 * personnel attribution).
 *
 * The section only renders for items whose id is mirrored in
 * projects/<type>.json. Items without a canonical record (grants,
 * conferences, library-only papers) silently no-op. */
function renderMembersSection(item) {
  var canon = _canonicalProjects[item.id];
  if (!canon) return '';
  var memberUids = canon.member_uids || [];
  var label = 'Members' + (memberUids.length ? ' (' + memberUids.length + ')' : '');
  var body = '';
  if (memberUids.length === 0) {
    body = '<div style="color:var(--text-muted);">No lab members assigned. Click <strong>+ Add member</strong> to grant project access — the assignment propagates to PMR, Lab Notebook, and any page that gates by project membership.</div>';
  } else {
    memberUids.forEach(function (uid) {
      var member = _roster.find(function (m) { return m.id === uid; });
      var display = member ? member.name : uid;
      var role = member ? member.role : '';
      body += '<span class="member-chip personnel-chip">' + escHtml(display);
      if (role) body += ' <span style="color:var(--text-muted);">(' + escHtml(role) + ')</span>';
      body += ' <span class="remove-link" style="cursor:pointer;color:var(--text-muted);font-size:14px;" onclick="event.stopPropagation(); removeProjectMember(\'' + item.id + '\',\'' + uid + '\')">&times;</span>';
      body += '</span>';
    });
  }
  var actions = '<button class="btn btn-sm btn-primary" onclick="event.stopPropagation(); addProjectMember(\'' + item.id + '\')">+ Add member</button>';
  return sectionHtml(item.id, 'members', label, body, actions);
}

function renderFundingSection(item) {
  var fids = item.funding_account_ids || [];
  var label = 'Funding' + (fids.length ? ' (' + fids.length + ')' : '');
  var body = '';
  if (fids.length === 0) {
    body = '<div style="color:var(--text-muted);">No funding accounts linked.</div>';
  } else {
    fids.forEach(function (fid) {
      var fp = _financeProjects.find(function (p) { return p.id === fid; });
      if (!fp) { body += '<div class="funding-account-row">' + escHtml(fid) + ' (not found)</div>'; return; }
      var spent = _inventoryItems.filter(function (inv) {
        return inv.project_tag === fp.id || inv.account_number === fp.account_number;
      }).reduce(function (s, inv) { return s + (inv.extended_price || inv.unit_price || 0); }, 0);
      var remaining = fp.total_budget ? fp.total_budget - spent : null;
      body += '<div class="funding-account-row">';
      body += '<code style="background:var(--bg);padding:2px 6px;border-radius:4px;">' + escHtml(fp.account_number) + '</code>';
      body += '<span>' + escHtml(fp.name) + '</span>';
      if (fp.total_budget) body += '<span>$' + fp.total_budget.toLocaleString() + '</span>';
      body += '<span>Spent: $' + spent.toLocaleString(undefined, { maximumFractionDigits: 0 }) + '</span>';
      if (remaining !== null) {
        var color = remaining >= 0 ? 'var(--green)' : 'var(--red)';
        body += '<span style="color:' + color + '">Rem: $' + remaining.toLocaleString(undefined, { maximumFractionDigits: 0 }) + '</span>';
      }
      body += '</div>';
    });
  }
  var actions = '';
  if (isGrantLike(item)) {
    actions = '<button class="btn btn-sm btn-primary" onclick="event.stopPropagation(); linkFundingAccount(\'' + item.id + '\')">+ Link Account</button>';
  }
  return sectionHtml(item.id, 'funding', label, body, actions);
}

function renderNotesSection(item) {
  var body = '<div style="white-space:pre-wrap;color:var(--text-muted);">' + escHtml(item.notes) + '</div>';
  return sectionHtml(item.id, 'notes', 'Notes', body, '');
}

function renderLinkedTasksSection(item) {
  if (!window.LINKS || !_bucketsDoc) return '';
  var linked = LINKS.linkedBucketsForItem(item, _bucketsDoc);
  var label = 'Linked Tasks' + (linked.length ? ' (' + linked.length + ')' : '');
  var body = '';
  if (!linked.length) {
    body = '<div style="color:var(--text-muted);">No task project linked yet. Click "Pin to dashboard" to create one, or "+ Link" to attach an existing project.</div>';
  } else {
    linked.forEach(function (proj) {
      var openCount = countOpenInBucketProject(proj);
      var earliest = earliestOpenDueInBucketProject(proj);
      body += '<div class="linked-task-row" style="display:flex;align-items:center;gap:10px;padding:6px 0;border-bottom:1px solid var(--border);font-size:13px">';
      body += '<a href="/rm/pages/tasks.html?project=' + encodeURIComponent(proj.id) + '" style="text-decoration:none;color:#1e40af;font-weight:600">' + escHtml(proj.title) + '</a>';
      body += '<span class="chip chip-muted" style="font-size:11px">' + openCount + ' open</span>';
      if (earliest) body += '<span class="chip chip-amber" style="font-size:11px">due ' + earliest.slice(5) + '</span>';
      body += '<span style="flex:1"></span>';
      body += '<button class="btn btn-sm" onclick="event.stopPropagation(); LINKS.navigateToBucket(\'' + proj.id + '\')">Open →</button>';
      body += '<button class="btn btn-sm" onclick="event.stopPropagation(); unlinkBucketFromItem(\'' + item.id + '\', \'' + proj.id + '\')">×</button>';
      body += '</div>';
    });
  }
  var actions = '<button class="btn btn-sm btn-primary" onclick="event.stopPropagation(); openLinkBucketPicker(\'' + item.id + '\')">+ Link existing</button>';
  return sectionHtml(item.id, 'linked_tasks', label, body, actions);
}

function countOpenInBucketProject(proj) {
  var n = 0;
  (proj.buckets || []).forEach(function (b) {
    function walk(arr) {
      (arr || []).forEach(function (st) {
        if (!st.done) n++;
        walk(st.children);
      });
    }
    walk(b.subtasks);
  });
  return n;
}
function earliestOpenDueInBucketProject(proj) {
  var earliest = null;
  (proj.buckets || []).forEach(function (b) {
    function walk(arr) {
      (arr || []).forEach(function (st) {
        if (!st.done && st.due_date && st.due_date !== 'TBD') {
          if (!earliest || st.due_date < earliest) earliest = st.due_date;
        }
        walk(st.children);
      });
    }
    walk(b.subtasks);
  });
  return earliest;
}

window.pinItemToDashboardUI = async function (itemId) {
  var item = _allItems.find(function (i) { return i.id === itemId; });
  if (!item) return;
  try {
    var bucketId = await LINKS.pinItemToDashboard(item);
    // Refresh local buckets doc so the inline display updates without a full reload.
    var fresh = await api.load('tasks/buckets.json');
    _bucketsDoc = fresh;
    var data = await api.load(ITEMS_PATH);
    _reloadItems(data);
    if (!_openSections[itemId]) _openSections[itemId] = {};
    _openSections[itemId].linked_tasks = true;
    render();
    if (confirm('Pinned to dashboard. Open the task dashboard now?')) {
      LINKS.navigateToBucket(bucketId);
    }
  } catch (err) {
    alert('Pin failed: ' + err.message);
  }
};

window.unlinkBucketFromItem = async function (itemId, bucketId) {
  if (!confirm('Unlink this task builder from the item? (The task builder itself is not deleted.)')) return;
  try {
    await LINKS.removeLink(itemId, bucketId);
    var [items, buckets] = await Promise.all([api.load(ITEMS_PATH), api.load('tasks/buckets.json')]);
    _reloadItems(items);
    _bucketsDoc = buckets;
    render();
  } catch (err) {
    alert('Unlink failed: ' + err.message);
  }
};

window.openLinkBucketPicker = async function (itemId) {
  var doc = await api.load('tasks/buckets.json');
  var item = _allItems.find(function (i) { return i.id === itemId; });
  if (!item) return;
  var alreadyLinked = new Set(item.linked_bucket_ids || []);
  var available = (doc.taskBuilders || []).filter(function (p) {
    return p.id !== 'proj-inbox' && !alreadyLinked.has(p.id);
  });
  if (!available.length) { alert('No unlinked task builders to attach. Create one on the Task dashboard first.'); return; }
  var labels = {};
  available.forEach(function (p) { labels[p.id] = p.title + (p.category ? ' (' + p.category + ')' : ''); });
  openForm({
    title: 'Link to existing task builder',
    fields: [{ key: 'bucket_id', label: 'Task builder', type: 'select', required: true,
      options: available.map(function (p) { return p.id; }), optionLabels: labels }],
    onSave: async function (vals) {
      await LINKS.addLink(itemId, vals.bucket_id);
      var [items, buckets] = await Promise.all([api.load(ITEMS_PATH), api.load('tasks/buckets.json')]);
      _reloadItems(items);
      _bucketsDoc = buckets;
      if (!_openSections[itemId]) _openSections[itemId] = {};
      _openSections[itemId].linked_tasks = true;
      render();
    },
  });
};

/* ---- Interactions ---- */

window.toggleSection = function (itemId, section) {
  if (!_openSections[itemId]) _openSections[itemId] = {};
  _openSections[itemId][section] = !_openSections[itemId][section];
  render();
};

/* ---- Subtask CRUD ---- */

var SUBTASK_FIELDS = [
  { key: 'title', label: 'Task', type: 'text', required: true },
  { key: 'self_importance', label: 'Importance', type: 'stars' },
  { key: 'hours_estimate', label: 'Hours estimate', type: 'number' },
  { key: 'deadline', label: 'Deadline', type: 'date' },
  { key: 'scheduled', label: 'Scheduled For', type: 'date' },
  { key: 'status', label: 'Status', type: 'select', options: ['pending', 'in_progress', 'completed'] },
  { key: 'notes', label: 'Notes', type: 'textarea' },
];

function _reloadItems(data) {
  _allItems = data.items;
  _items = _filterItemsForCategory(_allItems);
}

window.toggleItemSubtask = function (itemId, subIdx) {
  var item = _allItems.find(function (it) { return it.id === itemId; });
  if (!item || !item.subtasks[subIdx]) return;
  item.subtasks[subIdx].status = item.subtasks[subIdx].status === 'completed' ? 'pending' : 'completed';
  render();
  _saveItemSurgical(item).catch(function (err) {
    console.error('[projects] toggleItemSubtask save failed:', err);
  });
};

/* Surgical write of a single item's subtasks list to Firestore. Avoids
 * api.save(ITEMS_PATH, data) which rewrites the entire 3000+ doc collection
 * (1 read + 9 chunked batches ≈ 10 round-trips, 1+ second of latency on the
 * editing tab). One doc update is ~100-200ms. Falls back to api.save when
 * Firestore isn't available (e.g. local-only mode or transient SDK glitch). */
async function _saveItemSurgical(item) {
  if (typeof firebridge !== 'undefined' && firebridge.db) {
    try {
      // Suppress the local live-sync snapshot for our own write — without
      // this, the projects.js subscriber would echo back and trigger a full
      // loadAll() re-fetch right after the save, undoing the latency win.
      _projLive.suppressUntil = Date.now() + 2500;
      await firebridge.db().collection('items').doc(item.id).set({
        subtasks: item.subtasks || [],
        updatedAt: firebase.firestore.FieldValue.serverTimestamp(),
      }, { merge: true });
      return;
    } catch (err) {
      console.warn('[projects] surgical save failed, falling back to full save:', err.message);
    }
  }
  // Fallback: full collection rewrite via the adapter.
  var data = await api.load(ITEMS_PATH);
  var i = (data.items || []).findIndex(function (x) { return x.id === item.id; });
  if (i >= 0) data.items[i] = item;
  await api.save(ITEMS_PATH, data);
}

/* Optimistic UI: mutate the in-memory state and re-render IMMEDIATELY, then
 * fire the save in the background. The user sees their change with no wait;
 * Firestore + remote tabs sync ~150-300ms later. If the save fails the
 * change stays locally (we log) — far better UX than the previous "await
 * save (1-10s) then close popup" flow that froze the editing tab. */

// `data` is the loaded items.json snapshot; we reuse it for both
// in-memory mutation (so the page sees the change) and the background save.
// We don't keep this cached at module scope because items.json is large
// (3000+ docs) and forms typically open one at a time — re-loading on each
// open keeps memory low.

window.addItemSubtask = function (itemId) {
  openForm({
    title: 'Add Task',
    fields: SUBTASK_FIELDS,
    onSave: async function (vals) {
      var data = await api.load(ITEMS_PATH);
      var item = data.items.find(function (it) { return it.id === itemId; });
      if (!item) return;
      if (!item.subtasks) item.subtasks = [];
      vals.id = slugify(vals.title);
      item.subtasks.push(vals);
      // Render NOW — local tab updates instantly.
      _reloadItems(data);
      if (!_openSections[itemId]) _openSections[itemId] = {};
      _openSections[itemId].tasks = true;
      render();
      // Save in background — no await. Form closes the moment onSave returns.
      _saveItemSurgical(item).catch(function (err) {
        console.error('[projects] addItemSubtask save failed:', err);
      });
    },
  });
};

window.editItemSubtask = function (itemId, subIdx) {
  (async function () {
    var data = await api.load(ITEMS_PATH);
    var item = data.items.find(function (it) { return it.id === itemId; });
    if (!item || !item.subtasks[subIdx]) return;
    openForm({
      title: 'Edit Task',
      fields: SUBTASK_FIELDS,
      values: item.subtasks[subIdx],
      onSave: async function (vals) {
        Object.assign(item.subtasks[subIdx], vals);
        // Render NOW; save in background.
        _reloadItems(data);
        render();
        _saveItemSurgical(item).catch(function (err) {
          console.error('[projects] editItemSubtask save failed:', err);
        });
      },
    });
  })();
};

window.deleteItemSubtask = async function (itemId, subIdx) {
  if (!confirmAction('Remove this task?')) return;
  var data = await api.load(ITEMS_PATH);
  var item = data.items.find(function (it) { return it.id === itemId; });
  if (!item) return;
  item.subtasks.splice(subIdx, 1);
  // Render NOW; save in background.
  _reloadItems(data);
  render();
  _saveItemSurgical(item).catch(function (err) {
    console.error('[projects] deleteItemSubtask save failed:', err);
  });
};

/* ---- Related Items ---- */

window.linkRelated = function (itemId) {
  var item = _allItems.find(function (it) { return it.id === itemId; });
  if (!item) return;
  var existing = new Set(item.related_ids || []);
  existing.add(itemId);
  var available = _allItems.filter(function (it) { return !existing.has(it.id); });
  var opts = available.map(function (it) {
    return { value: it.id, label: CATEGORY_LABELS[it.category] + ' > ' + typeLabel(it.type) + ': ' + it.title };
  });
  openForm({
    title: 'Link Related Item',
    fields: [{ key: 'related_id', label: 'Item', type: 'select', required: true,
      options: opts.map(function (o) { return o.value; }),
      optionLabels: opts.reduce(function (m, o) { m[o.value] = o.label; return m; }, {}) }],
    onSave: async function (vals) {
      // V3.130 — surgical writes for both endpoints of the link.
      var it = _allItems.find(function (i) { return i.id === itemId; });
      var other = _allItems.find(function (i) { return i.id === vals.related_id; });
      if (!it) return;
      if (!it.related_ids) it.related_ids = [];
      if (it.related_ids.indexOf(vals.related_id) === -1) it.related_ids.push(vals.related_id);
      if (other) {
        if (!other.related_ids) other.related_ids = [];
        if (other.related_ids.indexOf(itemId) === -1) other.related_ids.push(itemId);
      }
      await saveItemSurgical(it);
      if (other) await saveItemSurgical(other);
      if (!_openSections[itemId]) _openSections[itemId] = {};
      _openSections[itemId].related = true;
      render();
    },
  });
};

window.unlinkRelated = async function (itemId, relatedId) {
  // V3.130 — surgical writes for both endpoints.
  var it = _allItems.find(function (i) { return i.id === itemId; });
  if (it && it.related_ids) it.related_ids = it.related_ids.filter(function (r) { return r !== relatedId; });
  var other = _allItems.find(function (i) { return i.id === relatedId; });
  if (other && other.related_ids) other.related_ids = other.related_ids.filter(function (r) { return r !== itemId; });
  if (it) await saveItemSurgical(it);
  if (other) await saveItemSurgical(other);
  render();
};

/* ---- Project-specific linking ---- */

window.linkToolToProject = function (projectId) {
  var project = _allItems.find(function (it) { return it.id === projectId; });
  if (!project) return;
  var existing = new Set(project.related_ids || []);
  existing.add(projectId);
  var available = _allItems.filter(function (it) {
    return !existing.has(it.id) && (it.type === 'lab_tool' || it.type === 'utility_tool');
  });
  var opts = available.map(function (it) {
    return { value: it.id, label: typeLabel(it.type) + ': ' + it.title + (it.repo_path ? ' (' + it.repo_path + ')' : '') };
  });
  openForm({
    title: 'Add Tool to Project',
    fields: [{ key: 'tool_id', label: 'Tool', type: 'select', required: true,
      options: opts.map(function (o) { return o.value; }),
      optionLabels: opts.reduce(function (m, o) { m[o.value] = o.label; return m; }, {}) }],
    onSave: async function (vals) {
      // V3.130 — surgical writes for both endpoints.
      var proj = _allItems.find(function (i) { return i.id === projectId; });
      var tool = _allItems.find(function (i) { return i.id === vals.tool_id; });
      if (!proj) return;
      if (!proj.related_ids) proj.related_ids = [];
      if (proj.related_ids.indexOf(vals.tool_id) === -1) proj.related_ids.push(vals.tool_id);
      if (tool) {
        if (!tool.related_ids) tool.related_ids = [];
        if (tool.related_ids.indexOf(projectId) === -1) tool.related_ids.push(projectId);
      }
      await saveItemSurgical(proj);
      if (tool) await saveItemSurgical(tool);
      if (!_openSections[projectId]) _openSections[projectId] = {};
      _openSections[projectId].tools = true;
      render();
    },
  });
};

window.linkRepoToProject = function (projectId) {
  var project = _allItems.find(function (it) { return it.id === projectId; });
  if (!project) return;
  var existing = new Set(project.related_ids || []);
  existing.add(projectId);
  var available = _allItems.filter(function (it) {
    return !existing.has(it.id) && it.repo_path;
  });
  var opts = available.map(function (it) {
    return { value: it.id, label: it.repo_path + ' (' + typeLabel(it.type) + ': ' + it.title + ')' };
  });
  openForm({
    title: 'Link Repo to Project',
    fields: [{ key: 'repo_item_id', label: 'Repo', type: 'select', required: true,
      options: opts.map(function (o) { return o.value; }),
      optionLabels: opts.reduce(function (m, o) { m[o.value] = o.label; return m; }, {}) }],
    onSave: async function (vals) {
      // V3.130 — surgical writes for both endpoints.
      var proj = _allItems.find(function (i) { return i.id === projectId; });
      var repoItem = _allItems.find(function (i) { return i.id === vals.repo_item_id; });
      if (!proj) return;
      if (!proj.related_ids) proj.related_ids = [];
      if (proj.related_ids.indexOf(vals.repo_item_id) === -1) proj.related_ids.push(vals.repo_item_id);
      if (repoItem) {
        if (!repoItem.related_ids) repoItem.related_ids = [];
        if (repoItem.related_ids.indexOf(projectId) === -1) repoItem.related_ids.push(projectId);
      }
      await saveItemSurgical(proj);
      if (repoItem) await saveItemSurgical(repoItem);
      if (!_openSections[projectId]) _openSections[projectId] = {};
      _openSections[projectId].project_repos = true;
      render();
    },
  });
};

/* ---- Personnel ---- */

window.addPersonnel = function (itemId) {
  // V3.130 — roster dropdown instead of free-text input. The personnel[]
  // field is a string-id array; legacy slug ids and Firebase uids both
  // serialize the same way, so the picker can offer both. A "+ free
  // text…" escape hatch covers one-off external collaborators.
  var item = _allItems.find(function (i) { return i.id === itemId; });
  // V3.135 — paper-personnel edits are restricted to first author + admin.
  if (!_canEditPaper(item)) {
    alert('You don’t have permission to edit personnel on this paper.');
    return;
  }
  var existing = new Set((item && item.personnel) || []);
  var available = (_roster || []).filter(function (m) { return m && m.id && !existing.has(m.id); });
  available.sort(function (a, b) { return String(a.name || a.id).localeCompare(String(b.name || b.id)); });
  var FREE = '__free__';
  var opts = available.map(function (m) { return m.id; });
  opts.push(FREE);
  var labels = {};
  available.forEach(function (m) {
    var bits = [m.name || m.id];
    if (m.role) bits.push(m.role);
    if (m.email) bits.push(m.email);
    if (m._legacy) bits.push('(legacy)');
    labels[m.id] = bits.join(' — ');
  });
  labels[FREE] = '+ Free-text name (external collaborator)…';
  openForm({
    title: 'Add Personnel',
    fields: [{
      key: 'who', label: 'Person', type: 'select', required: true,
      options: opts, optionLabels: labels,
    }],
    onSave: async function (vals) {
      var who = vals.who;
      if (who === FREE) {
        var freeName = prompt('Name or external id to add to personnel:');
        if (!freeName || !freeName.trim()) return;
        who = freeName.trim();
      }
      var it = _allItems.find(function (i) { return i.id === itemId; });
      if (!it) return;
      if (!it.personnel) it.personnel = [];
      if (it.personnel.indexOf(who) === -1) it.personnel.push(who);
      it.updated_at = today();
      // V3.130 — surgical write (see saveItemSurgical for full note).
      await saveItemSurgical(it);
      render();
    },
  });
};

window.removePersonnel = async function (itemId, idx) {
  var it = _allItems.find(function (i) { return i.id === itemId; });
  if (!it || !it.personnel) return;
  // V3.135 — paper-personnel edits are restricted to first author + admin.
  if (!_canEditPaper(it)) {
    alert('You don’t have permission to edit personnel on this paper.');
    return;
  }
  var removed = it.personnel[idx];
  it.personnel.splice(idx, 1);
  // V3.133 — keep first_author_uids in sync if the removed personnel was a first author.
  if (Array.isArray(it.first_author_uids) && it.first_author_uids.indexOf(removed) !== -1) {
    it.first_author_uids = it.first_author_uids.filter(function (u) { return u !== removed; });
  }
  it.updated_at = today();
  // V3.130 — surgical write (see saveItemSurgical for full note).
  await saveItemSurgical(it);
  render();
};

/* V3.133 — Toggle first-author status for a paper personnel entry.
 *
 * Admin-gated client-side: the rendered click handler is a no-op for
 * non-admins. V3.135 wires the matching server-side rule —
 * `request.resource.data.first_author_uids == resource.data.first_author_uids`
 * is required on any non-admin paper update, so first authors can edit
 * the paper but cannot promote co-authors or self-demote.
 *
 * Cap: 2 first authors per paper. Adding a third surfaces an alert
 * and aborts. V3.135 also requires the pid resolves to a roster entry
 * with `_firebaseUid: true` — otherwise the Firestore `isFirstAuthor`
 * check (which compares `request.auth.uid`) wouldn't match.
 */
window.toggleFirstAuthor = async function (itemId, pid) {
  if (!(typeof firebridge !== 'undefined' && firebridge.isAdmin && firebridge.isAdmin())) {
    alert('Only admins can change first-author status.');
    return;
  }
  var it = _allItems.find(function (i) { return i.id === itemId; });
  if (!it) return;
  if (it.type !== 'paper') return;
  if (!Array.isArray(it.first_author_uids)) it.first_author_uids = [];
  var idx = it.first_author_uids.indexOf(pid);
  if (idx !== -1) {
    it.first_author_uids.splice(idx, 1);
  } else {
    if (it.first_author_uids.length >= 2) {
      alert('A paper can have at most 2 first authors. Remove one first.');
      return;
    }
    // Sanity: must be in personnel[].
    var inPersonnel = (it.personnel || []).indexOf(pid) !== -1;
    if (!inPersonnel) {
      alert('First author must be in the Personnel list.');
      return;
    }
    // V3.135 — first authors must have a Firebase UID. The Firestore
    // rule's isFirstAuthor() check matches request.auth.uid against
    // this array, so a legacy slug id wouldn't grant any access — the
    // star would be set with no enforcement. Refuse the toggle.
    var member = (_roster || []).find(function (m) { return m.id === pid; });
    if (!member || !member._firebaseUid) {
      alert('First author must be a lab member with a Firebase account. Promote them via the Members section first.');
      return;
    }
    it.first_author_uids.push(pid);
  }
  it.updated_at = today();
  // V3.130 — surgical write.
  await saveItemSurgical(it);
  render();
};

/* ---- Project Members (V3.126) -------------------------------------
 * Distinct from the legacy `personnel[]` field above. Members live on
 * the canonical `projects` Firestore collection (typed JSON paths
 * `projects/<type>.json`) under `member_uids[]`. PMR queries this field
 * via `where('member_uids','array-contains',uid)`; the Lab Notebook
 * filters its in-entry project picker by the same field. Any future
 * page that gates by project membership reads the same field.
 *
 * The roster picker exposes only Firebase-uid lab users (entries
 * tagged `_firebaseUid: true` by the loadAll merge). Legacy slug-id
 * roster entries can't be resolved to Firebase auth so they don't
 * grant access — they remain in the Personnel section for human
 * attribution. */
window.addProjectMember = function (itemId) {
  var canon = _canonicalProjects[itemId];
  if (!canon) {
    alert('No canonical project record for "' + itemId + '". Members are stored on the projects collection — open the admin migrate page or edit projects/<type>.json directly to create the canonical record first.');
    return;
  }
  var existing = new Set(canon.member_uids || []);
  var available = _roster.filter(function (m) {
    return m._firebaseUid && !existing.has(m.id);
  });
  if (!available.length) {
    alert('All lab members are already assigned to this project.');
    return;
  }
  var opts = available.map(function (m) { return m.id; });
  var labels = {};
  available.forEach(function (m) {
    labels[m.id] = m.name + (m.email ? ' (' + m.email + ')' : '');
  });
  openForm({
    title: 'Add Member',
    fields: [{
      key: 'uid', label: 'Lab member', type: 'select', required: true,
      options: opts, optionLabels: labels,
    }],
    onSave: async function (vals) {
      // V3.130 — surgical write of one projects/{itemId} doc instead of a
      // full rewrite of every paper/course/etc. in the typed collection.
      var data = await api.load(canon.sourcePath);
      var rows = (data && data[canon.sourceKey]) || [];
      var row = rows.find(function (r) { return r && r.id === itemId; });
      if (!row) {
        alert('Project not found in ' + canon.sourcePath + ' (id "' + itemId + '"). The canonical record may have been deleted.');
        return;
      }
      if (!Array.isArray(row.member_uids)) row.member_uids = [];
      if (row.member_uids.indexOf(vals.uid) < 0) row.member_uids.push(vals.uid);
      await saveProjectDocSurgical(canon, row);
      canon.member_uids = row.member_uids.slice();
      if (!_openSections[itemId]) _openSections[itemId] = {};
      _openSections[itemId].members = true;
      render();
    },
  });
};

window.removeProjectMember = async function (itemId, uid) {
  var canon = _canonicalProjects[itemId];
  if (!canon) return;
  var member = _roster.find(function (m) { return m.id === uid; });
  var displayName = member ? member.name : uid;
  if (!confirm('Remove ' + displayName + ' from this project? They will lose project-membership access on every page that gates by member_uids[].')) return;
  // V3.130 — surgical write (see addProjectMember above for the full note).
  var data = await api.load(canon.sourcePath);
  var rows = (data && data[canon.sourceKey]) || [];
  var row = rows.find(function (r) { return r && r.id === itemId; });
  if (!row) return;
  row.member_uids = (row.member_uids || []).filter(function (u) { return u !== uid; });
  await saveProjectDocSurgical(canon, row);
  canon.member_uids = row.member_uids.slice();
  render();
};

/* ---- Funding Account Linking ---- */

window.linkFundingAccount = function (itemId) {
  var item = _allItems.find(function (it) { return it.id === itemId; });
  var existingIds = new Set(item ? item.funding_account_ids || [] : []);
  var available = _financeProjects.filter(function (fp) { return !existingIds.has(fp.id); });
  var opts = available.map(function (fp) { return fp.id; });
  var labels = {};
  available.forEach(function (fp) { labels[fp.id] = fp.name + ' (' + fp.account_number + ')'; });
  openForm({
    title: 'Link Funding Account',
    fields: [{ key: 'account_id', label: 'Account', type: 'select', required: true, options: opts, optionLabels: labels }],
    onSave: async function (vals) {
      // V3.130 — surgical write.
      var it = _allItems.find(function (i) { return i.id === itemId; });
      if (!it) return;
      if (!it.funding_account_ids) it.funding_account_ids = [];
      if (it.funding_account_ids.indexOf(vals.account_id) === -1) it.funding_account_ids.push(vals.account_id);
      await saveItemSurgical(it);
      if (!_openSections[itemId]) _openSections[itemId] = {};
      _openSections[itemId].funding = true;
      render();
    },
  });
};

/* ---- Repo Parse ---- */

window.parseRepo = async function (itemId) {
  var item = _allItems.find(function (it) { return it.id === itemId; });
  if (!item || !item.repo_path) return;
  var card = document.querySelector('[data-item-id="' + itemId + '"]');
  if (card) {
    var btn = card.querySelector('.item-section[data-section="repo"] .btn');
    if (btn) { btn.disabled = true; btn.textContent = 'Parsing...'; }
  }
  try {
    var res = await fetch('/api/parse-repo', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ repo_path: item.repo_path, item_type: item.type }),
    });
    var result = await res.json();
    if (!result.ok) { alert('Parse failed: ' + (result.error || 'Unknown error')); return; }
    // V3.130 — surgical write.
    var it = _allItems.find(function (i) { return i.id === itemId; });
    if (it) {
      it.repo_parsed = result.parsed;
      it.repo_parsed_at = today();
      it.updated_at = today();
      await saveItemSurgical(it);
      if (!_openSections[itemId]) _openSections[itemId] = {};
      _openSections[itemId].repo = true;
      render();
    }
  } catch (e) { alert('Parse error: ' + e.message); }
};

/* ---- Item CRUD ---- */

function getItemFields(type) {
  var typeCfg = ITEM_TYPES[type] || {};
  var common = [
    { key: 'title', label: 'Title', type: 'text', required: true },
    { key: 'status', label: 'Status', type: 'select', options: typeCfg.statuses || ['active'] },
    { key: 'description', label: 'Description', type: 'textarea' },
    { key: 'repo_path', label: 'Repo Path', type: 'text', placeholder: '../RepoName' },
    { key: 'repo_org', label: 'GitHub Org', type: 'text', placeholder: 'McGheeLab' },
  ];
  var meta = (typeCfg.metaFields || []).map(function (f) {
    return Object.assign({}, f, { key: 'meta.' + f.key });
  });
  return common.concat(meta).concat([{ key: 'notes', label: 'Notes', type: 'textarea' }]);
}

function flattenForForm(item) {
  var vals = Object.assign({}, item);
  var m = item.meta || {};
  Object.keys(m).forEach(function (k) { vals['meta.' + k] = m[k]; });
  return vals;
}

function unflattenFromForm(vals, existingItem) {
  var item = existingItem ? Object.assign({}, existingItem) : {};
  var meta = item.meta ? Object.assign({}, item.meta) : {};
  Object.keys(vals).forEach(function (k) {
    if (k.startsWith('meta.')) { meta[k.slice(5)] = vals[k]; }
    else { item[k] = vals[k]; }
  });
  item.meta = meta;
  return item;
}

window.editItemById = function (itemId) {
  var item = _allItems.find(function (i) { return i.id === itemId; });
  if (!item) return;
  // V3.135 — paper edits are restricted to first author + admin.
  if (!_canEditPaper(item)) {
    alert('You don’t have permission to edit this paper. First authors and admins can edit.');
    return;
  }
  openForm({
    title: 'Edit ' + typeLabel(item.type),
    fields: getItemFields(item.type),
    values: flattenForForm(item),
    onSave: async function (vals) {
      var updated = unflattenFromForm(vals, item);
      updated.id = slugify(vals.title);
      updated.updated_at = today();
      // V3.130 — surgical write (one items/{id} doc) instead of full
      // collection rewrite. Patch local state in place after the write.
      await saveItemSurgical(updated);
      var idx = _allItems.findIndex(function (i) { return i.id === itemId; });
      if (idx >= 0) _allItems[idx] = updated;
      else _allItems.push(updated);
      _items = _filterItemsForCategory(_allItems);
      _expandedId = updated.id;
      render();
    },
  });
};

window.deleteItemById = async function (itemId) {
  // V3.135 — paper deletes are admin-only (other types follow the existing lab-member rule).
  var preItem = _allItems.find(function (i) { return i.id === itemId; });
  if (!_canDeleteItem(preItem)) {
    alert('You don’t have permission to delete this paper. Admins only.');
    return;
  }
  if (!confirmAction('Delete this item?')) return;
  // V3.130 — surgical delete: drop the one items/{id} doc and (only) update
  // items whose related_ids referenced it. Skips the full-collection rewrite
  // path of the adapter's collection-save.
  var crossRefs = _allItems.filter(function (it) {
    return it.id !== itemId && Array.isArray(it.related_ids) && it.related_ids.indexOf(itemId) !== -1;
  });
  if (typeof firebridge !== 'undefined' && firebridge.db && firebridge.getUser && firebridge.getUser()) {
    try {
      await firebridge.db().collection('items').doc(itemId).delete();
      // Patch + persist each cross-ref individually (typically 0-3 docs).
      for (var i = 0; i < crossRefs.length; i++) {
        var it = crossRefs[i];
        it.related_ids = it.related_ids.filter(function (r) { return r !== itemId; });
        await saveItemSurgical(it);
      }
      _allItems = _allItems.filter(function (i) { return i.id !== itemId; });
      _items = _filterItemsForCategory(_allItems);
      _expandedId = null;
      render();
      return;
    } catch (err) {
      console.warn('[projects] surgical delete failed, falling back:', err.message);
    }
  }
  // Fallback: full rewrite via the adapter.
  var data = await api.load(ITEMS_PATH);
  data.items = data.items.filter(function (i) { return i.id !== itemId; });
  data.items.forEach(function (it) {
    if (it.related_ids) it.related_ids = it.related_ids.filter(function (r) { return r !== itemId; });
  });
  await api.save(ITEMS_PATH, data);
  _reloadItems(data);
  _expandedId = null;
  render();
};

/* ---- Add Item ---- */

document.getElementById('add-item').onclick = function () {
  var typeOptions = [];
  Object.keys(ITEM_TYPES).forEach(function (t) {
    if (ITEM_TYPES[t].category === _pageCategory) typeOptions.push(t);
  });
  if (typeOptions.length === 1) {
    openAddForm(typeOptions[0]);
    return;
  }
  var labels = {};
  typeOptions.forEach(function (t) { labels[t] = ITEM_TYPES[t].label; });
  openForm({
    title: 'Add Item — Select Type',
    fields: [{ key: 'item_type', label: 'Type', type: 'select', required: true, options: typeOptions, optionLabels: labels }],
    onSave: function (vals) { if (vals.item_type) openAddForm(vals.item_type); },
  });
};

function openAddForm(type) {
  // V3.229 — paper and grant creation runs through the dedicated builder
  // pages (which write to projects/papers.json and grantDrafts respectively).
  // Deep-link with ?new=1 so the builder's create modal opens immediately.
  if (type === 'paper') {
    window.location.href = '/rm/pages/paper-builder.html?new=1';
    return;
  }
  if (type === 'grant') {
    window.location.href = '/rm/pages/grant-builder.html?new=1';
    return;
  }
  openForm({
    title: 'Add ' + typeLabel(type),
    fields: getItemFields(type),
    onSave: async function (itemVals) {
      var newItem = unflattenFromForm(itemVals, {
        id: slugify(itemVals.title),
        type: type,
        category: typeCategory(type),
        related_ids: [],
        repo_parsed: null,
        repo_parsed_at: '',
        personnel: [],
        // V3.133 — paper-only field; harmless on other types.
        first_author_uids: type === 'paper' ? [] : undefined,
        funding_account_ids: [],
        tags: [],
        subtasks: [],
        created_at: today(),
        updated_at: today(),
      });
      // Strip the undefined sentinel so we don't send `first_author_uids: undefined` to Firestore.
      if (newItem.first_author_uids === undefined) delete newItem.first_author_uids;
      newItem.id = slugify(itemVals.title);
      // V3.130 — surgical Firestore write (one items/{id} doc) instead of
      // a full collection rewrite of every item. ~150-300ms vs 5-15s.
      await saveItemSurgical(newItem);
      _allItems.push(newItem);
      _items = _filterItemsForCategory(_allItems);
      _expandedId = newItem.id;
      render();
    },
  });
}

/* ---- Utility ---- */

function escHtml(s) {
  if (!s) return '';
  return String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
}

/* ---- Live tab-to-tab sync ----
 * Subscribe to items.json (lab-shared) so admin edits propagate without
 * reload. Wraps api.save for ITEMS_PATH to set save/suppress gates.
 * tasks/buckets.json (also written here) already has its own live-sync
 * inside the tasks-buckets.js family — those subscribers handle it.
 */
var _projLive = { suppressUntil: 0, savePending: false, refreshTimer: null, unsubs: [] };

function _projWrapSaves() {
  if (_projWrapSaves._wrapped) return;
  _projWrapSaves._wrapped = true;
  var origSave = api.save.bind(api);
  api.save = async function (path, data) {
    var isProjPath = (path === ITEMS_PATH);
    if (isProjPath) {
      _projLive.savePending = true;
      _projLive.suppressUntil = Date.now() + 2500;
    }
    try { return await origSave(path, data); }
    finally { if (isProjPath) _projLive.savePending = false; }
  };
}

function _projScheduleRefresh() {
  if (_projLive.refreshTimer) return;
  _projLive.refreshTimer = setTimeout(function () {
    _projLive.refreshTimer = null;
    var scrollY = window.scrollY;
    var active = document.activeElement;
    var activeId = active && active.id;
    try { render(); }
    catch (err) { console.warn('[projects] live-sync re-render failed:', err); }
    finally {
      window.scrollTo({ top: scrollY, left: 0, behavior: 'instant' });
      if (activeId) {
        var el = document.getElementById(activeId);
        if (el) { try { el.focus(); } catch (e) {} }
      }
    }
  }, 200);
}

function _projAttachLiveSync() {
  if (typeof api.subscribe !== 'function') return;
  if (_projLive.unsubs.length) return;
  try {
    var firstFireConsumed = false;
    var unsub = api.subscribe(ITEMS_PATH, function (data) {
      if (Date.now() < _projLive.suppressUntil) return;
      if (_projLive.savePending) return;
      if (!data || !Array.isArray(data.items)) return;
      _allItems = data.items;
      _items = _filterItemsForCategory(_allItems);
      if (!firstFireConsumed) { firstFireConsumed = true; return; }
      _projScheduleRefresh();
    });
    _projLive.unsubs.push(unsub);
  } catch (err) {
    console.warn('[projects] live sync attach failed:', err.message);
  }
}

/* ---- Init ---- */

(async function () {
  if (typeof firebridge !== 'undefined' && firebridge.requireSignIn) await firebridge.requireSignIn('Sign in to view projects.');
  _projWrapSaves();
  await loadAll();
  _projAttachLiveSync();
})();
