/* grants.js — proposals + awards from unified items.json, with expandable detail panels */

var ITEMS_PATH = 'items.json';

var PROPOSAL_STATUSES = ['drafting', 'submitted', 'under_review', 'revising', 'rejected'];
var AWARD_STATUSES = ['awarded', 'active', 'no_cost_extension', 'completed'];

var TABS = [
  { key: 'proposals', label: 'Proposals', filter: function (it) { return PROPOSAL_STATUSES.indexOf(it.status) >= 0; } },
  { key: 'awards', label: 'Awards', filter: function (it) { return AWARD_STATUSES.indexOf(it.status) >= 0; } },
];

var activeTab = 'proposals';
var _allGrants = [];
var _sortKey = null;
var _sortDir = 'asc';
var PROPOSAL_COLUMNS = [
  { label: 'Title', key: 'title' },
  { label: 'Funder', key: 'meta.funder' },
  { label: 'Mechanism', key: 'meta.mechanism' },
  { label: 'Role', key: 'meta.role' },
  { label: 'Deadline', key: 'meta.submit_deadline', type: 'date' },
  { label: 'Status', key: 'status' },
  { label: 'Actions', key: null },
];
var AWARD_COLUMNS = [
  { label: 'Title', key: 'title' },
  { label: 'Funder', key: 'meta.funder' },
  { label: 'Award #', key: 'meta.award_number' },
  { label: 'Period', key: 'meta.start_date', type: 'date' },
  { label: 'Status', key: 'status' },
  { label: 'Actions', key: null },
];

async function loadAndRender() {
  var data = await api.load(ITEMS_PATH);
  _allGrants = (data.items || []).filter(function (it) { return it.type === 'grant'; });

  setExpandContext(ITEMS_PATH, 'items', loadAndRender);

  var tabBar = document.getElementById('tabs');
  tabBar.innerHTML = '';
  TABS.forEach(function (t) {
    var btn = document.createElement('button');
    btn.className = 'tab-btn' + (activeTab === t.key ? ' active' : '');
    btn.textContent = t.label;
    btn.onclick = function () { activeTab = t.key; _sortKey = null; _sortDir = 'asc'; loadAndRender(); };
    tabBar.appendChild(btn);
  });

  var tab = TABS.find(function (t) { return t.key === activeTab; });
  var items = _allGrants.filter(tab.filter);

  var content = document.getElementById('content');
  if (items.length === 0) {
    content.innerHTML = '<div class="empty-state">No ' + tab.label.toLowerCase() + ' yet. Click "+ Add Grant" to get started.</div>';
    return;
  }

  var html, colCount;
  if (activeTab === 'proposals') {
    colCount = 7;
    var sortedItems = sortItems(items, _sortKey, _sortDir, PROPOSAL_COLUMNS);
    html = '<table class="data-table">' + sortableHeader(PROPOSAL_COLUMNS, _sortKey, _sortDir, 'onGrantsSort') + '<tbody>';
    sortedItems.forEach(function (item) {
      var m = item.meta || {};
      var realIdx = (data.items || []).indexOf(item);
      var cells = '<td><strong>' + item.title + '</strong>' +
        (item.repo_path ? '<br><small style="color:var(--text-muted)">' + item.repo_path + '</small>' : '') + '</td>' +
        '<td>' + (m.funder || '') + '</td>' +
        '<td>' + (m.mechanism || '') + '</td>' +
        '<td>' + (m.role || '') + '</td>' +
        '<td>' + formatDate(m.submit_deadline) + (m.submit_deadline && m.submit_deadline !== 'TBD' ? ' ' + deadlineChip(m.submit_deadline) : '') + '</td>' +
        '<td>' + statusChip(item.status) + '</td>' +
        '<td class="row-actions" onclick="event.stopPropagation()"><button onclick="editGrant(' + realIdx + ')">Edit</button><button onclick="deleteGrant(' + realIdx + ')">Delete</button></td>';
      var meta = [
        { label: 'Funder', value: m.funder },
        { label: 'Mechanism', value: m.mechanism },
        { label: 'Role', value: m.role },
        { label: 'Submit Deadline', value: m.submit_deadline ? formatDate(m.submit_deadline) : '' },
        { label: 'Projected Submission', value: m.projected_submission_date ? formatDate(m.projected_submission_date) : '' },
        { label: 'Submission Target', value: m.submission_target },
        { label: 'Repo', value: item.repo_path },
        { label: 'Status', value: item.status },
      ];
      html += expandableRow(realIdx, colCount, cells, item, meta);
    });
  } else {
    colCount = 6;
    var sortedItems = sortItems(items, _sortKey, _sortDir, AWARD_COLUMNS);
    html = '<table class="data-table">' + sortableHeader(AWARD_COLUMNS, _sortKey, _sortDir, 'onGrantsSort') + '<tbody>';
    sortedItems.forEach(function (item) {
      var m = item.meta || {};
      var realIdx = (data.items || []).indexOf(item);
      var cells = '<td><strong>' + item.title + '</strong></td>' +
        '<td>' + (m.funder || '') + '</td>' +
        '<td>' + (m.award_number || '') + '</td>' +
        '<td>' + formatDate(m.start_date) + ' – ' + formatDate(m.end_date) + '</td>' +
        '<td>' + statusChip(item.status) + '</td>' +
        '<td class="row-actions" onclick="event.stopPropagation()"><button onclick="editGrant(' + realIdx + ')">Edit</button><button onclick="deleteGrant(' + realIdx + ')">Delete</button></td>';
      var meta = [
        { label: 'Funder', value: m.funder },
        { label: 'Mechanism', value: m.mechanism },
        { label: 'Award #', value: m.award_number },
        { label: 'Period', value: (m.start_date ? formatDate(m.start_date) : '') + ' – ' + (m.end_date ? formatDate(m.end_date) : '') },
        { label: 'Budget', value: m.total_budget ? '$' + m.total_budget.toLocaleString() : '' },
        { label: 'Repo', value: item.repo_path },
        { label: 'Status', value: item.status },
      ];
      html += expandableRow(realIdx, colCount, cells, item, meta);
    });
  }

  html += '</tbody></table>';
  content.innerHTML = html;
}

window.onGrantsSort = function (key) {
  if (_sortKey === key) { _sortDir = _sortDir === 'asc' ? 'desc' : 'asc'; }
  else { _sortKey = key; _sortDir = 'asc'; }
  loadAndRender();
};

/* ---- Grant CRUD (operates on items.json) ---- */

var GRANT_FIELDS = ITEM_TYPES.grant.metaFields.map(function (f) {
  return Object.assign({}, f, { key: 'meta_' + f.key });
});
GRANT_FIELDS.unshift(
  { key: 'title', label: 'Title', type: 'text', required: true },
  { key: 'status', label: 'Status', type: 'select', options: ITEM_TYPES.grant.statuses },
  { key: 'repo_path', label: 'Repo Path', type: 'text', placeholder: '../Proposal Name' },
  { key: 'repo_org', label: 'GitHub Org', type: 'text', placeholder: 'McGheeLab' }
);
GRANT_FIELDS.push({ key: 'notes', label: 'Notes', type: 'textarea' });

function grantToForm(item) {
  var vals = { title: item.title, status: item.status, repo_path: item.repo_path || '', repo_org: item.repo_org || '', notes: item.notes || '' };
  var m = item.meta || {};
  ITEM_TYPES.grant.metaFields.forEach(function (f) { vals['meta_' + f.key] = m[f.key]; });
  return vals;
}

function formToGrant(vals, existing) {
  var item = existing ? Object.assign({}, existing) : {};
  item.title = vals.title;
  item.status = vals.status;
  item.repo_path = vals.repo_path || '';
  item.repo_org = vals.repo_org || '';
  item.notes = vals.notes || '';
  item.id = slugify(vals.title);
  item.updated_at = today();
  if (!item.meta) item.meta = {};
  ITEM_TYPES.grant.metaFields.forEach(function (f) {
    var v = vals['meta_' + f.key];
    item.meta[f.key] = (f.type === 'number' && v) ? Number(v) : (v || '');
  });
  return item;
}

window.editGrant = async function (index) {
  var data = await api.load(ITEMS_PATH);
  var item = data.items[index];
  if (!item) return;
  openForm({
    title: 'Edit Grant',
    fields: GRANT_FIELDS,
    values: grantToForm(item),
    onSave: async function (vals) {
      data.items[index] = formToGrant(vals, item);
      await api.save(ITEMS_PATH, data);
      syncGrantsToFirestore();
      loadAndRender();
    },
  });
};

window.deleteGrant = async function (index) {
  if (!confirmAction('Remove this grant?')) return;
  var data = await api.load(ITEMS_PATH);
  data.items.splice(index, 1);
  await api.save(ITEMS_PATH, data);
  syncGrantsToFirestore();
  loadAndRender();
};

document.getElementById('add-item').onclick = function () {
  openForm({
    title: 'Add Grant',
    fields: GRANT_FIELDS,
    onSave: async function (vals) {
      var data = await api.load(ITEMS_PATH);
      var item = formToGrant(vals, {
        type: 'grant',
        category: 'research',
        related_ids: [],
        repo_parsed: null,
        repo_parsed_at: '',
        personnel: [],
        funding_account_ids: [],
        tags: [],
        subtasks: [],
        created_at: today(),
      });
      data.items.push(item);
      await api.save(ITEMS_PATH, data);
      syncGrantsToFirestore();
      loadAndRender();
    },
  });
};

/* ---- Firestore Sync ---- */

async function syncGrantsToFirestore() {
  if (typeof firebridge === 'undefined' || !firebridge.isReady()) return;
  try {
    var data = await api.load(ITEMS_PATH);
    var grants = (data.items || []).filter(function (it) { return it.type === 'grant'; });

    var proposals = grants.filter(function (g) { return PROPOSAL_STATUSES.indexOf(g.status) >= 0; }).map(function (g) {
      return { id: g.id, title: g.title, status: g.status, funder: (g.meta || {}).funder || '', mechanism: (g.meta || {}).mechanism || '', role: (g.meta || {}).role || '', lastUpdated: today() };
    });
    await firebridge.setDoc('labStatus', 'proposals', { proposals: proposals });

    var awards = grants.filter(function (g) { return AWARD_STATUSES.indexOf(g.status) >= 0; }).map(function (g) {
      return { id: g.id, title: g.title, status: g.status, funder: (g.meta || {}).funder || '', mechanism: (g.meta || {}).mechanism || '', lastUpdated: today() };
    });
    await firebridge.setDoc('labStatus', 'awards', { awards: awards });
  } catch (e) {
    console.warn('[grants] Sync failed:', e.message);
  }
}

/* ---- Live tab-to-tab sync (subscribe to items.json) ---- */
var _grantsLive = { suppressUntil: 0, savePending: false, refreshTimer: null, unsubs: [] };

function _grantsWrapSaves() {
  if (_grantsWrapSaves._wrapped) return;
  _grantsWrapSaves._wrapped = true;
  var origSave = api.save.bind(api);
  api.save = async function (path, data) {
    var isItems = (path === ITEMS_PATH);
    if (isItems) { _grantsLive.savePending = true; _grantsLive.suppressUntil = Date.now() + 2500; }
    try { return await origSave(path, data); }
    finally { if (isItems) _grantsLive.savePending = false; }
  };
}
function _grantsScheduleRefresh() {
  if (_grantsLive.refreshTimer) return;
  _grantsLive.refreshTimer = setTimeout(function () {
    _grantsLive.refreshTimer = null;
    var y = window.scrollY;
    loadAndRender().catch(function (err) { console.warn('[grants] refresh failed:', err); })
      .finally(function () { window.scrollTo({ top: y, left: 0, behavior: 'instant' }); });
  }, 200);
}
function _grantsAttachLiveSync() {
  if (typeof api.subscribe !== 'function' || _grantsLive.unsubs.length) return;
  try {
    var firstFireConsumed = false;
    var unsub = api.subscribe(ITEMS_PATH, function () {
      if (Date.now() < _grantsLive.suppressUntil) return;
      if (_grantsLive.savePending) return;
      if (!firstFireConsumed) { firstFireConsumed = true; return; }
      _grantsScheduleRefresh();
    });
    _grantsLive.unsubs.push(unsub);
  } catch (err) {
    console.warn('[grants] live sync attach failed:', err.message);
  }
}

(async function () {
  if (typeof firebridge !== 'undefined' && firebridge.whenAuthResolved) await firebridge.whenAuthResolved();
  _grantsWrapSaves();
  await loadAndRender();
  // No live-sync attach: grants is admin-edit, single-tab in practice.
  // _grantsAttachLiveSync(); // disabled per data-flow plan
})();
