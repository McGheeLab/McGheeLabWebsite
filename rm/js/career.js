/* career.js — tenure dossier milestones + documents tracker */

const MILESTONE_FIELDS = [
  { key: 'title', label: 'Milestone', type: 'text', required: true },
  { key: 'due_date', label: 'Due Date', type: 'date' },
  { key: 'status', label: 'Status', type: 'select', options: ['upcoming', 'in_progress', 'completed'] },
  { key: 'notes', label: 'Notes', type: 'textarea' },
];

const DOCUMENT_FIELDS = [
  { key: 'title', label: 'Document Title', type: 'text', required: true },
  { key: 'path', label: 'Path / Repo', type: 'text', placeholder: '../CV' },
  { key: 'last_updated', label: 'Last Updated', type: 'date' },
  { key: 'notes', label: 'Notes', type: 'textarea' },
];

const TABS = [
  { key: 'milestones', label: 'Milestones', dataKey: 'milestones', fields: MILESTONE_FIELDS },
  { key: 'documents', label: 'Documents', dataKey: 'documents', fields: DOCUMENT_FIELDS },
];

let activeTab = 'milestones';
const DATA_PATH = 'career/tenure_dossier.json';

async function loadAndRender() {
  const data = await api.load(DATA_PATH);
  const tab = TABS.find(t => t.key === activeTab);
  const items = data[tab.dataKey] || [];

  const tabBar = document.getElementById('tabs');
  tabBar.innerHTML = '';
  TABS.forEach(t => {
    const btn = document.createElement('button');
    btn.className = 'tab-btn' + (activeTab === t.key ? ' active' : '');
    btn.textContent = t.label;
    btn.onclick = () => { activeTab = t.key; loadAndRender(); };
    tabBar.appendChild(btn);
  });

  const content = document.getElementById('content');
  if (items.length === 0) {
    content.innerHTML = `<div class="empty-state">No ${tab.label.toLowerCase()} yet. Click "+ Add" to get started.</div>`;
    return;
  }

  let html = '<table class="data-table"><thead><tr>';
  if (activeTab === 'milestones') {
    html += '<th>Milestone</th><th>Due Date</th><th>Status</th><th>Notes</th><th>Actions</th>';
  } else {
    html += '<th>Document</th><th>Path</th><th>Last Updated</th><th>Notes</th><th>Actions</th>';
  }
  html += '</tr></thead><tbody>';

  items.forEach((item, i) => {
    if (activeTab === 'milestones') {
      html += `<tr>
        <td><strong>${item.title}</strong></td>
        <td>${formatDate(item.due_date)} ${deadlineChip(item.due_date)}</td>
        <td>${statusChip(item.status)}</td>
        <td style="color:var(--text-muted); font-size:13px">${item.notes || ''}</td>
        <td class="row-actions"><button onclick="editItem(${i})">Edit</button><button onclick="deleteItem(${i})">Delete</button></td>
      </tr>`;
    } else {
      html += `<tr>
        <td><strong>${item.title}</strong></td>
        <td style="color:var(--text-muted)">${item.path || ''}</td>
        <td>${formatDate(item.last_updated)}</td>
        <td style="color:var(--text-muted); font-size:13px">${item.notes || ''}</td>
        <td class="row-actions"><button onclick="editItem(${i})">Edit</button><button onclick="deleteItem(${i})">Delete</button></td>
      </tr>`;
    }
  });

  html += '</tbody></table>';
  content.innerHTML = html;
}

window.editItem = async function (index) {
  const tab = TABS.find(t => t.key === activeTab);
  const data = await api.load(DATA_PATH);
  const item = data[tab.dataKey][index];
  openForm({
    title: `Edit ${tab.label.slice(0, -1)}`,
    fields: tab.fields,
    values: item,
    onSave: async (vals) => {
      Object.assign(data[tab.dataKey][index], vals);
      data[tab.dataKey][index].id = slugify(vals.title);
      await api.save(DATA_PATH, data);
      loadAndRender();
    },
  });
};

window.deleteItem = async function (index) {
  const tab = TABS.find(t => t.key === activeTab);
  if (!confirmAction('Remove this entry?')) return;
  const data = await api.load(DATA_PATH);
  data[tab.dataKey].splice(index, 1);
  await api.save(DATA_PATH, data);
  loadAndRender();
};

document.getElementById('add-item').onclick = () => {
  const tab = TABS.find(t => t.key === activeTab);
  openForm({
    title: `Add ${tab.label.slice(0, -1)}`,
    fields: tab.fields,
    onSave: async (vals) => {
      const data = await api.load(DATA_PATH);
      vals.id = slugify(vals.title);
      if (activeTab === 'milestones') vals.materials = [];
      data[tab.dataKey].push(vals);
      await api.save(DATA_PATH, data);
      loadAndRender();
    },
  });
};

(async function () {
  if (typeof firebridge !== 'undefined' && firebridge.whenAuthResolved) await firebridge.whenAuthResolved();
  await loadAndRender();
  // No LIVE_SYNC.attach — tenure dossier is a single-author edit surface;
  // a second tab is unusual, and reload covers it.
})();
