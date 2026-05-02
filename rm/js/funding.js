/* funding.js — proposals + awards management with expandable detail panels */

const PROPOSAL_FIELDS = [
  { key: 'title', label: 'Title', type: 'text', required: true },
  { key: 'funder', label: 'Funder', type: 'select', options: ['NIH', 'NSF', 'DoD', 'DoE', 'NASA', 'Industry', 'Foundation', 'Internal', 'Other'] },
  { key: 'mechanism', label: 'Mechanism', type: 'text', placeholder: 'e.g. R01, R21, CAREER, U01' },
  { key: 'role', label: 'Role', type: 'select', options: ['PI', 'Co-PI', 'Co-I', 'Consultant', 'Subcontract PI'] },
  { key: 'status', label: 'Status', type: 'select', options: ['drafting', 'submitted', 'under_review', 'awarded', 'rejected', 'revising'] },
  { key: 'submit_deadline', label: 'Submit Deadline', type: 'date' },
  { key: 'projected_submission_date', label: 'Projected Submission', type: 'date' },
  { key: 'submission_target', label: 'Where to Submit', type: 'text', placeholder: 'e.g. FOA PA-25-123, specific institute' },
  { key: 'repo_path', label: 'Repo Path', type: 'text', placeholder: '../Proposal Name' },
  { key: 'repo_org', label: 'GitHub Org', type: 'text', placeholder: 'McGheeLab' },
  { key: 'notes', label: 'Notes', type: 'textarea' },
];

const AWARD_FIELDS = [
  { key: 'title', label: 'Title', type: 'text', required: true },
  { key: 'funder', label: 'Funder', type: 'select', options: ['NIH', 'NSF', 'DoD', 'DoE', 'NASA', 'Industry', 'Foundation', 'Internal', 'Other'] },
  { key: 'mechanism', label: 'Mechanism', type: 'text' },
  { key: 'award_number', label: 'Award Number', type: 'text', placeholder: 'e.g. 1R01CA123456-01' },
  { key: 'role', label: 'Role', type: 'select', options: ['PI', 'Co-PI', 'Co-I', 'Consultant', 'Subcontract PI'] },
  { key: 'status', label: 'Status', type: 'select', options: ['active', 'no-cost-extension', 'completed', 'pending_start'] },
  { key: 'start_date', label: 'Start Date', type: 'date' },
  { key: 'end_date', label: 'End Date', type: 'date' },
  { key: 'repo_path', label: 'Repo Path', type: 'text' },
  { key: 'notes', label: 'Notes', type: 'textarea' },
];

const TABS = [
  { key: 'proposals', label: 'Proposals', path: 'funding/proposals.json', dataKey: 'proposals', fields: PROPOSAL_FIELDS },
  { key: 'awards', label: 'Awards', path: 'funding/awards.json', dataKey: 'awards', fields: AWARD_FIELDS },
];

let activeTab = 'proposals';
var _sortKey = null;
var _sortDir = 'asc';
var PROPOSAL_COLUMNS = [
  { label: 'Title', key: 'title' },
  { label: 'Funder', key: 'funder' },
  { label: 'Mechanism', key: 'mechanism' },
  { label: 'Role', key: 'role' },
  { label: 'Deadline', key: 'submit_deadline', type: 'date' },
  { label: 'Status', key: 'status' },
  { label: 'Actions', key: null },
];
var AWARD_COLUMNS = [
  { label: 'Title', key: 'title' },
  { label: 'Funder', key: 'funder' },
  { label: 'Award #', key: 'award_number' },
  { label: 'Period', key: 'start_date', type: 'date' },
  { label: 'Status', key: 'status' },
  { label: 'Actions', key: null },
];

async function loadAndRender() {
  const tab = TABS.find(t => t.key === activeTab);
  const data = await api.load(tab.path);
  const items = data[tab.dataKey];

  setExpandContext(tab.path, tab.dataKey, loadAndRender);

  const tabBar = document.getElementById('tabs');
  tabBar.innerHTML = '';
  TABS.forEach(t => {
    const btn = document.createElement('button');
    btn.className = 'tab-btn' + (activeTab === t.key ? ' active' : '');
    btn.textContent = t.label;
    btn.onclick = () => { activeTab = t.key; _sortKey = null; _sortDir = 'asc'; loadAndRender(); };
    tabBar.appendChild(btn);
  });

  const content = document.getElementById('content');
  if (items.length === 0) {
    content.innerHTML = `<div class="empty-state">No ${tab.label.toLowerCase()} yet. Click "+ Add" to get started.</div>`;
    return;
  }

  let colCount, html;
  if (activeTab === 'proposals') {
    colCount = 7;
    var sortedItems = sortItems(items, _sortKey, _sortDir, PROPOSAL_COLUMNS);
    html = '<table class="data-table">' + sortableHeader(PROPOSAL_COLUMNS, _sortKey, _sortDir, 'onFundingSort') + '<tbody>';
    sortedItems.forEach((item) => {
      var i = items.indexOf(item);
      const cells = `
        <td><strong>${item.title}</strong>${item.repo_path ? '<br><small style="color:var(--text-muted)">' + item.repo_path + '</small>' : ''}</td>
        <td>${item.funder || ''}</td>
        <td>${item.mechanism || ''}</td>
        <td>${item.role || ''}</td>
        <td>${formatDate(item.submit_deadline)}${item.submit_deadline && item.submit_deadline !== 'TBD' ? ' ' + deadlineChip(item.submit_deadline) : ''}</td>
        <td>${statusChip(item.status)}</td>
        <td class="row-actions" onclick="event.stopPropagation()"><a href="/rm/pages/budget.html?project=${encodeURIComponent(item.id)}" style="font-size:13px;color:var(--primary);margin-right:8px;">Budget</a><button onclick="editItem(${i})">Edit</button><button onclick="deleteItem(${i})">Delete</button></td>`;
      const meta = [
        { label: 'Funder', value: item.funder },
        { label: 'Mechanism', value: item.mechanism },
        { label: 'Role', value: item.role },
        { label: 'Submit Deadline', value: item.submit_deadline ? formatDate(item.submit_deadline) : '' },
        { label: 'Projected Submission', value: item.projected_submission_date ? formatDate(item.projected_submission_date) : '' },
        { label: 'Where to Submit', value: item.submission_target },
        { label: 'Repo', value: item.repo_path },
        { label: 'Status', value: item.status },
      ];
      html += expandableRow(i, colCount, cells, item, meta);
    });
  } else {
    colCount = 6;
    var sortedItems = sortItems(items, _sortKey, _sortDir, AWARD_COLUMNS);
    html = '<table class="data-table">' + sortableHeader(AWARD_COLUMNS, _sortKey, _sortDir, 'onFundingSort') + '<tbody>';
    sortedItems.forEach((item) => {
      var i = items.indexOf(item);
      const cells = `
        <td><strong>${item.title}</strong></td>
        <td>${item.funder || ''}</td>
        <td>${item.award_number || ''}</td>
        <td>${formatDate(item.start_date)} – ${formatDate(item.end_date)}</td>
        <td>${statusChip(item.status)}</td>
        <td class="row-actions" onclick="event.stopPropagation()"><button onclick="editItem(${i})">Edit</button><button onclick="deleteItem(${i})">Delete</button></td>`;
      const meta = [
        { label: 'Funder', value: item.funder },
        { label: 'Mechanism', value: item.mechanism },
        { label: 'Award #', value: item.award_number },
        { label: 'Period', value: (item.start_date ? formatDate(item.start_date) : '') + ' – ' + (item.end_date ? formatDate(item.end_date) : '') },
        { label: 'Repo', value: item.repo_path },
        { label: 'Status', value: item.status },
      ];
      html += expandableRow(i, colCount, cells, item, meta);
    });
  }

  html += '</tbody></table>';
  content.innerHTML = html;
}

window.onFundingSort = function (key) {
  if (_sortKey === key) { _sortDir = _sortDir === 'asc' ? 'desc' : 'asc'; }
  else { _sortKey = key; _sortDir = 'asc'; }
  loadAndRender();
};

window.editItem = async function (index) {
  const tab = TABS.find(t => t.key === activeTab);
  const data = await api.load(tab.path);
  const item = data[tab.dataKey][index];
  openForm({
    title: `Edit ${tab.label.slice(0, -1)}`,
    fields: tab.fields,
    values: item,
    onSave: async (vals) => {
      Object.assign(data[tab.dataKey][index], vals);
      data[tab.dataKey][index].id = slugify(vals.title);
      await api.save(tab.path, data);
      syncFundingToFirestore();
      loadAndRender();
    },
  });
};

window.deleteItem = async function (index) {
  const tab = TABS.find(t => t.key === activeTab);
  if (!confirmAction(`Remove this ${tab.label.slice(0, -1).toLowerCase()}?`)) return;
  const data = await api.load(tab.path);
  data[tab.dataKey].splice(index, 1);
  await api.save(tab.path, data);
  syncFundingToFirestore();
  loadAndRender();
};

document.getElementById('add-item').onclick = () => {
  const tab = TABS.find(t => t.key === activeTab);
  openForm({
    title: `Add ${tab.label.slice(0, -1)}`,
    fields: tab.fields,
    onSave: async (vals) => {
      const data = await api.load(tab.path);
      vals.id = slugify(vals.title);
      vals.subtasks = [];
      data[tab.dataKey].push(vals);
      await api.save(tab.path, data);
      syncFundingToFirestore();
      loadAndRender();
    },
  });
};

/* ---- Sync to Website (Firestore) ---- */

async function syncFundingToFirestore() {
  if (typeof firebridge === 'undefined' || !firebridge.isReady()) return;
  try {
    var propData = await api.load('funding/proposals.json');
    var proposals = (propData.proposals || []).map(function (p) {
      return { id: p.id, title: p.title, status: p.status, funder: p.funder || '', mechanism: p.mechanism || '', role: p.role || '', lastUpdated: today() };
    });
    await firebridge.setDoc('labStatus', 'proposals', { proposals: proposals });

    var awardData = await api.load('funding/awards.json');
    var awards = (awardData.awards || []).map(function (a) {
      return { id: a.id, title: a.title, status: a.status, funder: a.funder || '', mechanism: a.mechanism || '', lastUpdated: today() };
    });
    await firebridge.setDoc('labStatus', 'awards', { awards: awards });
  } catch (e) {
    console.warn('[funding] Sync failed:', e.message);
  }
}

/* ---- Live tab-to-tab sync ---- */
const _fundLive = { suppressUntil: 0, savePending: false, refreshTimer: null, unsubs: [] };
const _FUND_PATHS = TABS.map(t => t.path);

function _fundWrapSaves() {
  if (_fundWrapSaves._wrapped) return;
  _fundWrapSaves._wrapped = true;
  const origSave = api.save.bind(api);
  api.save = async function (path, data) {
    const isFundPath = _FUND_PATHS.indexOf(path) >= 0;
    if (isFundPath) {
      _fundLive.savePending = true;
      _fundLive.suppressUntil = Date.now() + 2500;
    }
    try { return await origSave(path, data); }
    finally { if (isFundPath) _fundLive.savePending = false; }
  };
}

function _fundScheduleRefresh() {
  if (_fundLive.refreshTimer) return;
  _fundLive.refreshTimer = setTimeout(function () {
    _fundLive.refreshTimer = null;
    const scrollY = window.scrollY;
    const active = document.activeElement;
    const activeId = active && active.id;
    loadAndRender().catch(err => console.warn('[funding] live-sync refresh failed:', err))
      .finally(() => {
        window.scrollTo({ top: scrollY, left: 0, behavior: 'instant' });
        if (activeId) {
          const el = document.getElementById(activeId);
          if (el) { try { el.focus(); } catch (e) {} }
        }
      });
  }, 200);
}

function _fundAttachLiveSync() {
  if (typeof api.subscribe !== 'function') return;
  if (_fundLive.unsubs.length) return;
  for (const path of _FUND_PATHS) {
    try {
      let firstFireConsumed = false;
      const unsub = api.subscribe(path, function () {
        if (Date.now() < _fundLive.suppressUntil) return;
        if (_fundLive.savePending) return;
        if (!firstFireConsumed) { firstFireConsumed = true; return; }
        _fundScheduleRefresh();
      });
      _fundLive.unsubs.push(unsub);
    } catch (err) {
      console.warn('[funding] live sync attach failed for', path, err.message);
    }
  }
}

(async function () {
  if (typeof firebridge !== 'undefined' && firebridge.whenAuthResolved) await firebridge.whenAuthResolved();
  _fundWrapSaves();
  await loadAndRender();
  // No live-sync attach: funding is admin-edit, single-tab in practice.
  // _fundAttachLiveSync(); // disabled per data-flow plan
})();
