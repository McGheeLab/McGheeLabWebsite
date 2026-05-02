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

async function loadAll() {
  var results = await Promise.all([
    api.load(ITEMS_PATH),
    api.load(ROSTER_PATH),
    api.load(FINANCE_PATH),
    api.load(INVENTORY_PATH),
    api.load('tasks/buckets.json').catch(function () { return { projects: [] }; }),
  ]);
  _allItems = results[0].items || [];
  _items = _allItems.filter(function (it) {
    if (it.category !== _pageCategory) return false;
    // Library-entry papers (uploaded via /pages/library.html) live in
    // items.json so the rest of the system can reference them, but they
    // shouldn't clutter the Research → Projects view. They get their own
    // page (/pages/library.html).
    var lib = (it.meta || {}).library;
    if (lib && lib.is_library_entry) return false;
    return true;
  });

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
  _bucketsDoc = results[4] || { projects: [] };

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
    body.innerHTML = renderItemHero(item) + renderItemDetailAccordions(item);
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
  html += '<div class="item-hero-section-label">Linked task projects</div>';
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
  return '<div class="item-hero-actions">'
    + '<button class="btn btn-sm btn-primary" onclick="event.stopPropagation(); pinItemToDashboardUI(\'' + item.id + '\')">Pin to dashboard</button>'
    + '<button class="btn btn-sm" onclick="event.stopPropagation(); openLinkBucketPicker(\'' + item.id + '\')">+ Link existing project</button>'
    + '<span style="flex:1"></span>'
    + '<button class="btn btn-sm" onclick="event.stopPropagation(); editItemById(\'' + item.id + '\')">Edit</button>'
    + '<button class="btn btn-sm btn-danger" onclick="event.stopPropagation(); deleteItemById(\'' + item.id + '\')">Delete</button>'
    + '</div>';
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
  if (personnel.length === 0) {
    body = '<div style="color:var(--text-muted);">No personnel assigned.</div>';
  } else {
    personnel.forEach(function (pid, pi) {
      var member = _roster.find(function (m) { return m.id === pid; });
      var display = member ? member.name : pid;
      var role = member ? member.role : '';
      body += '<span class="personnel-chip">' + escHtml(display);
      if (role) body += ' <span style="color:var(--text-muted);">(' + escHtml(role) + ')</span>';
      body += ' <span class="remove-link" style="cursor:pointer;color:var(--text-muted);font-size:14px;" onclick="event.stopPropagation(); removePersonnel(\'' + item.id + '\',' + pi + ')">&times;</span>';
      body += '</span>';
    });
  }
  var actions = '<button class="btn btn-sm btn-primary" onclick="event.stopPropagation(); addPersonnel(\'' + item.id + '\')">+ Add</button>';
  return sectionHtml(item.id, 'personnel', label, body, actions);
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
  if (!confirm('Unlink this task project from the item? (The project itself is not deleted.)')) return;
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
  var available = (doc.projects || []).filter(function (p) {
    return p.id !== 'proj-inbox' && !alreadyLinked.has(p.id);
  });
  if (!available.length) { alert('No unlinked task projects to attach. Create one on the Task dashboard first.'); return; }
  var labels = {};
  available.forEach(function (p) { labels[p.id] = p.title + (p.category ? ' (' + p.category + ')' : ''); });
  openForm({
    title: 'Link to existing task project',
    fields: [{ key: 'bucket_id', label: 'Project', type: 'select', required: true,
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
  _items = _allItems.filter(function (it) {
    if (it.category !== _pageCategory) return false;
    var lib = (it.meta || {}).library;
    if (lib && lib.is_library_entry) return false;
    return true;
  });
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
      var data = await api.load(ITEMS_PATH);
      var it = data.items.find(function (i) { return i.id === itemId; });
      var other = data.items.find(function (i) { return i.id === vals.related_id; });
      if (!it) return;
      if (!it.related_ids) it.related_ids = [];
      if (it.related_ids.indexOf(vals.related_id) === -1) it.related_ids.push(vals.related_id);
      if (other) {
        if (!other.related_ids) other.related_ids = [];
        if (other.related_ids.indexOf(itemId) === -1) other.related_ids.push(itemId);
      }
      await api.save(ITEMS_PATH, data);
      _reloadItems(data);
      if (!_openSections[itemId]) _openSections[itemId] = {};
      _openSections[itemId].related = true;
      render();
    },
  });
};

window.unlinkRelated = async function (itemId, relatedId) {
  var data = await api.load(ITEMS_PATH);
  var it = data.items.find(function (i) { return i.id === itemId; });
  if (it && it.related_ids) it.related_ids = it.related_ids.filter(function (r) { return r !== relatedId; });
  var other = data.items.find(function (i) { return i.id === relatedId; });
  if (other && other.related_ids) other.related_ids = other.related_ids.filter(function (r) { return r !== itemId; });
  await api.save(ITEMS_PATH, data);
  _reloadItems(data); render();
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
      var data = await api.load(ITEMS_PATH);
      var proj = data.items.find(function (i) { return i.id === projectId; });
      var tool = data.items.find(function (i) { return i.id === vals.tool_id; });
      if (!proj) return;
      if (!proj.related_ids) proj.related_ids = [];
      if (proj.related_ids.indexOf(vals.tool_id) === -1) proj.related_ids.push(vals.tool_id);
      if (tool) {
        if (!tool.related_ids) tool.related_ids = [];
        if (tool.related_ids.indexOf(projectId) === -1) tool.related_ids.push(projectId);
      }
      await api.save(ITEMS_PATH, data);
      _reloadItems(data);
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
      var data = await api.load(ITEMS_PATH);
      var proj = data.items.find(function (i) { return i.id === projectId; });
      var repoItem = data.items.find(function (i) { return i.id === vals.repo_item_id; });
      if (!proj) return;
      if (!proj.related_ids) proj.related_ids = [];
      if (proj.related_ids.indexOf(vals.repo_item_id) === -1) proj.related_ids.push(vals.repo_item_id);
      if (repoItem) {
        if (!repoItem.related_ids) repoItem.related_ids = [];
        if (repoItem.related_ids.indexOf(projectId) === -1) repoItem.related_ids.push(projectId);
      }
      await api.save(ITEMS_PATH, data);
      _reloadItems(data);
      if (!_openSections[projectId]) _openSections[projectId] = {};
      _openSections[projectId].project_repos = true;
      render();
    },
  });
};

/* ---- Personnel ---- */

window.addPersonnel = function (itemId) {
  openForm({
    title: 'Add Personnel',
    fields: [{ key: 'person', label: 'Person (roster ID or name)', type: 'text', required: true, placeholder: 'roster id or full name' }],
    onSave: async function (vals) {
      var data = await api.load(ITEMS_PATH);
      var it = data.items.find(function (i) { return i.id === itemId; });
      if (!it) return;
      if (!it.personnel) it.personnel = [];
      if (it.personnel.indexOf(vals.person) === -1) it.personnel.push(vals.person);
      await api.save(ITEMS_PATH, data);
      _reloadItems(data); render();
    },
  });
};

window.removePersonnel = async function (itemId, idx) {
  var data = await api.load(ITEMS_PATH);
  var it = data.items.find(function (i) { return i.id === itemId; });
  if (!it || !it.personnel) return;
  it.personnel.splice(idx, 1);
  await api.save(ITEMS_PATH, data);
  _reloadItems(data); render();
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
      var data = await api.load(ITEMS_PATH);
      var it = data.items.find(function (i) { return i.id === itemId; });
      if (!it) return;
      if (!it.funding_account_ids) it.funding_account_ids = [];
      if (it.funding_account_ids.indexOf(vals.account_id) === -1) it.funding_account_ids.push(vals.account_id);
      await api.save(ITEMS_PATH, data);
      _reloadItems(data);
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
    var data = await api.load(ITEMS_PATH);
    var it = data.items.find(function (i) { return i.id === itemId; });
    if (it) {
      it.repo_parsed = result.parsed;
      it.repo_parsed_at = today();
      it.updated_at = today();
      await api.save(ITEMS_PATH, data);
      _reloadItems(data);
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
  (async function () {
    var data = await api.load(ITEMS_PATH);
    var item = data.items.find(function (i) { return i.id === itemId; });
    if (!item) return;
    openForm({
      title: 'Edit ' + typeLabel(item.type),
      fields: getItemFields(item.type),
      values: flattenForForm(item),
      onSave: async function (vals) {
        var updated = unflattenFromForm(vals, item);
        updated.id = slugify(vals.title);
        updated.updated_at = today();
        var idx = data.items.findIndex(function (i) { return i.id === itemId; });
        if (idx >= 0) data.items[idx] = updated;
        await api.save(ITEMS_PATH, data);
        _reloadItems(data);
        _expandedId = updated.id;
        render();
      },
    });
  })();
};

window.deleteItemById = async function (itemId) {
  if (!confirmAction('Delete this item?')) return;
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
  openForm({
    title: 'Add ' + typeLabel(type),
    fields: getItemFields(type),
    onSave: async function (itemVals) {
      var data = await api.load(ITEMS_PATH);
      var newItem = unflattenFromForm(itemVals, {
        id: slugify(itemVals.title),
        type: type,
        category: typeCategory(type),
        related_ids: [],
        repo_parsed: null,
        repo_parsed_at: '',
        personnel: [],
        funding_account_ids: [],
        tags: [],
        subtasks: [],
        created_at: today(),
        updated_at: today(),
      });
      newItem.id = slugify(itemVals.title);
      data.items.push(newItem);
      await api.save(ITEMS_PATH, data);
      _reloadItems(data);
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
      _items = _allItems.filter(function (it) {
        if (it.category !== _pageCategory) return false;
        var lib = (it.meta || {}).library;
        if (lib && lib.is_library_entry) return false;
        return true;
      });
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
  if (typeof firebridge !== 'undefined' && firebridge.whenAuthResolved) await firebridge.whenAuthResolved();
  _projWrapSaves();
  await loadAll();
  _projAttachLiveSync();
})();
