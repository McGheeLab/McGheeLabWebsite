/* settings.js — manage connections and integrations */

const CONNECTION_FIELDS = [
  { key: 'name', label: 'Name', type: 'text', required: true },
  { key: 'type', label: 'Type', type: 'select', options: ['email', 'calendar', 'repository', 'messaging', 'finance', 'other'] },
  { key: 'provider', label: 'Provider', type: 'text', placeholder: 'e.g. Google, Microsoft 365, GitHub' },
  { key: 'account', label: 'Account / Username', type: 'text' },
  { key: 'forward_to', label: 'Forward To', type: 'text', placeholder: 'e.g. forwarding address' },
  { key: 'status', label: 'Status', type: 'select', options: ['active', 'not_connected', 'error', 'disabled'] },
  { key: 'notes', label: 'Notes', type: 'textarea' },
];

const DATA_PATH = 'settings/connections.json';
var _settSortKey = null;
var _settSortDir = 'asc';
var CONN_COLUMNS = [
  { label: 'Name', key: 'name' },
  { label: 'Type', key: 'type' },
  { label: 'Provider', key: 'provider' },
  { label: 'Account', key: 'account' },
  { label: 'Forward To', key: 'forward_to' },
  { label: 'Status', key: 'status' },
  { label: 'Notes', key: 'notes' },
  { label: 'Actions', key: null },
];

const TABS = [
  { key: 'all', label: 'All' },
  { key: 'email', label: 'Email' },
  { key: 'calendar', label: 'Calendars' },
  { key: 'repository', label: 'Repositories' },
  { key: 'messaging', label: 'Messaging' },
  { key: 'finance', label: 'Finance' },
];

let activeTab = 'all';

function connectionStatusChip(s) {
  const map = {
    active: 'chip-green',
    not_connected: 'chip-muted',
    error: 'chip-red',
    disabled: 'chip-muted',
  };
  return '<span class="chip ' + (map[s] || 'chip-muted') + '">' + (s || '').replace(/_/g, ' ') + '</span>';
}

/* ---- Main render ---- */

async function loadAndRender() {
  const data = await api.load(DATA_PATH);
  const connections = data.connections || [];

  // Tabs
  const tabsEl = document.getElementById('tabs');
  tabsEl.innerHTML = '';
  TABS.forEach(t => {
    const count = t.key === 'all'
      ? ' (' + connections.length + ')'
      : ' (' + connections.filter(c => c.type === t.key).length + ')';
    const btn = document.createElement('button');
    btn.className = 'tab-btn' + (activeTab === t.key ? ' active' : '');
    btn.textContent = t.label + count;
    btn.onclick = function () { activeTab = t.key; _settSortKey = null; _settSortDir = 'asc'; loadAndRender(); };
    tabsEl.appendChild(btn);
  });

  // Filter
  const filtered = activeTab === 'all'
    ? connections
    : connections.filter(c => c.type === activeTab);

  const content = document.getElementById('content');
  if (filtered.length === 0) {
    content.innerHTML = '<div class="empty-state">No connections in this category.</div>';
    return;
  }

  var sortedConn = sortItems(filtered, _settSortKey, _settSortDir, CONN_COLUMNS);
  let html = '<table class="data-table">' +
    sortableHeader(CONN_COLUMNS, _settSortKey, _settSortDir, 'onSettingsSort') +
    '<tbody>';

  sortedConn.forEach(function (c) {
    const idx = connections.indexOf(c);
    html += '<tr>' +
      '<td><strong>' + c.name + '</strong></td>' +
      '<td>' + (c.type || '') + '</td>' +
      '<td>' + (c.provider || '') + '</td>' +
      '<td>' + (c.account || '') + '</td>' +
      '<td>' + (c.forward_to || '') + '</td>' +
      '<td>' + connectionStatusChip(c.status) + '</td>' +
      '<td style="font-size:0.85em">' + (c.notes || '') + '</td>' +
      '<td class="row-actions">' +
        '<button onclick="editItem(' + idx + ')">Edit</button>' +
        '<button onclick="deleteItem(' + idx + ')">Delete</button>' +
      '</td>' +
      '</tr>';
  });

  html += '</tbody></table>';
  content.innerHTML = html;
}

window.onSettingsSort = function (key) {
  if (_settSortKey === key) { _settSortDir = _settSortDir === 'asc' ? 'desc' : 'asc'; }
  else { _settSortKey = key; _settSortDir = 'asc'; }
  loadAndRender();
};

window.editItem = async function (index) {
  const data = await api.load(DATA_PATH);
  const item = data.connections[index];
  openForm({
    title: 'Edit Connection',
    fields: CONNECTION_FIELDS,
    values: item,
    onSave: async function (vals) {
      Object.assign(data.connections[index], vals);
      data.connections[index].id = slugify(vals.name);
      await api.save(DATA_PATH, data);
      loadAndRender();
    },
  });
};

window.deleteItem = async function (index) {
  if (!confirmAction('Remove this connection?')) return;
  const data = await api.load(DATA_PATH);
  data.connections.splice(index, 1);
  await api.save(DATA_PATH, data);
  loadAndRender();
};

document.getElementById('add-item').onclick = function () {
  openForm({
    title: 'Add Connection',
    fields: CONNECTION_FIELDS,
    values: { status: 'not_connected' },
    onSave: async function (vals) {
      const data = await api.load(DATA_PATH);
      vals.id = slugify(vals.name);
      data.connections.push(vals);
      await api.save(DATA_PATH, data);
      loadAndRender();
    },
  });
};

(async function () {
  if (typeof firebridge !== 'undefined' && firebridge.whenAuthResolved) await firebridge.whenAuthResolved();
  await loadAndRender();
  // No LIVE_SYNC.attach: settings are per-user, single-tab in practice.
})();
