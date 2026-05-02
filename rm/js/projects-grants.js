/* projects-grants.js — manage funded projects/grants and their account numbers */

var DATA_PATH = 'finance/projects.json';
var ITEMS_PATH = 'inventory/items.json';
var _projects = [];
var _items = [];

var PROJECT_FIELDS = [
  { key: 'name', label: 'Project Name', type: 'text', required: true },
  { key: 'account_number', label: 'Account Number', type: 'text', required: true, placeholder: 'e.g. 1101935' },
  { key: 'type', label: 'Type', type: 'select', options: ['startup', 'grant', 'contract', 'gift', 'internal'] },
  { key: 'pi', label: 'PI', type: 'text', placeholder: 'e.g. Alexander McGhee' },
  { key: 'status', label: 'Status', type: 'select', options: ['active', 'pending', 'completed', 'expired'] },
  { key: 'start_date', label: 'Start Date', type: 'date' },
  { key: 'end_date', label: 'End Date', type: 'date' },
  { key: 'total_budget', label: 'Total Budget ($)', type: 'number' },
  { key: 'funder', label: 'Funder / Agency', type: 'text', placeholder: 'e.g. NIH, NSF, DOD, UA' },
  { key: 'grant_number', label: 'Grant / Award Number', type: 'text' },
  { key: 'notes', label: 'Notes', type: 'textarea' },
];

async function loadAndRender() {
  var results = await Promise.all([
    api.load(DATA_PATH),
    api.load(ITEMS_PATH),
  ]);
  _projects = results[0].projects || [];
  _items = results[1].items || [];
  render();
}

function render() {
  var content = document.getElementById('content');

  if (_projects.length === 0) {
    content.innerHTML = '<div class="empty-state">No projects yet. Click "+ Add Project" to add a funded grant or account.</div>';
    return;
  }

  var html = '';

  _projects.forEach(function (proj, i) {
    // Count items charged to this project
    var projItems = _items.filter(function (it) { return it.project_tag === proj.id || it.account_number === proj.account_number; });
    var totalSpent = projItems.reduce(function (s, it) { return s + (it.extended_price || it.unit_price || 0); }, 0);
    var remaining = proj.total_budget ? proj.total_budget - totalSpent : null;

    // Card for each project
    html += '<div class="card" style="margin-bottom:16px;padding:16px 20px;">';

    // Header row
    html += '<div style="display:flex;justify-content:space-between;align-items:start;margin-bottom:12px;">';
    html += '<div>';
    html += '<div style="font-size:18px;font-weight:700;">' + proj.name + '</div>';
    html += '<div style="font-size:14px;color:var(--text-muted);margin-top:2px;">';
    html += '<code style="background:var(--bg);padding:2px 6px;border-radius:4px;">' + proj.account_number + '</code>';
    if (proj.type) html += ' &middot; ' + proj.type;
    if (proj.funder) html += ' &middot; ' + proj.funder;
    if (proj.grant_number) html += ' &middot; #' + proj.grant_number;
    html += ' &middot; ' + statusChip(proj.status);
    html += '</div></div>';
    html += '<div class="row-actions"><button onclick="editProject(' + i + ')">Edit</button><button onclick="deleteProject(' + i + ')">Delete</button></div>';
    html += '</div>';

    // Stats row
    html += '<div style="display:flex;gap:24px;flex-wrap:wrap;margin-bottom:12px;">';
    if (proj.total_budget) {
      html += '<div><span style="font-size:12px;text-transform:uppercase;color:var(--text-muted);display:block;">Budget</span><span style="font-size:20px;font-weight:700;">$' + proj.total_budget.toLocaleString() + '</span></div>';
    }
    html += '<div><span style="font-size:12px;text-transform:uppercase;color:var(--text-muted);display:block;">Spent</span><span style="font-size:20px;font-weight:700;">$' + totalSpent.toLocaleString(undefined, { maximumFractionDigits: 0 }) + '</span></div>';
    if (remaining !== null) {
      var remainColor = remaining > 0 ? 'var(--green)' : 'var(--red)';
      html += '<div><span style="font-size:12px;text-transform:uppercase;color:var(--text-muted);display:block;">Remaining</span><span style="font-size:20px;font-weight:700;color:' + remainColor + ';">$' + remaining.toLocaleString(undefined, { maximumFractionDigits: 0 }) + '</span></div>';
      // Budget bar
      var pct = Math.min(100, (totalSpent / proj.total_budget) * 100);
      var barColor = pct > 90 ? 'var(--red)' : pct > 70 ? 'var(--amber)' : 'var(--green)';
      html += '<div style="flex:1;min-width:150px;align-self:end;"><span style="font-size:12px;text-transform:uppercase;color:var(--text-muted);display:block;">Used ' + pct.toFixed(0) + '%</span>';
      html += '<div style="background:var(--bg);border-radius:4px;height:8px;margin-top:4px;"><div style="background:' + barColor + ';border-radius:4px;height:100%;width:' + pct + '%;"></div></div></div>';
    }
    html += '<div><span style="font-size:12px;text-transform:uppercase;color:var(--text-muted);display:block;">Items</span><span style="font-size:20px;font-weight:700;">' + projItems.length + '</span></div>';
    html += '</div>';

    // Dates
    if (proj.start_date || proj.end_date) {
      html += '<div style="font-size:13px;color:var(--text-muted);">';
      if (proj.start_date) html += formatDate(proj.start_date);
      if (proj.start_date && proj.end_date) html += ' \u2013 ';
      if (proj.end_date) html += formatDate(proj.end_date);
      if (proj.end_date && proj.end_date !== 'TBD') {
        var d = daysUntil(proj.end_date);
        if (d !== null) html += ' ' + deadlineChip(proj.end_date);
      }
      html += '</div>';
    }

    if (proj.pi) html += '<div style="font-size:13px;color:var(--text-muted);margin-top:4px;">PI: ' + proj.pi + '</div>';
    if (proj.notes) html += '<div style="font-size:13px;color:var(--text-muted);margin-top:4px;">' + proj.notes + '</div>';

    // Top spending categories for this project
    if (projItems.length > 0) {
      var byCat = {};
      projItems.forEach(function (it) {
        var cat = it.category || 'Other';
        byCat[cat] = (byCat[cat] || 0) + (it.extended_price || it.unit_price || 0);
      });
      var topCats = Object.entries(byCat).sort(function (a, b) { return b[1] - a[1]; }).slice(0, 5);
      html += '<div style="margin-top:8px;font-size:12px;color:var(--text-muted);">Top categories: ';
      html += topCats.map(function (kv) { return kv[0].replace(/_/g, ' ') + ' $' + kv[1].toFixed(0); }).join(', ');
      html += '</div>';
    }

    // Link to inventory filtered by this project
    html += '<div style="margin-top:10px;"><a href="/rm/pages/inventory.html" class="btn btn-sm" style="font-size:12px;">View Items &rarr;</a></div>';

    html += '</div>';
  });

  content.innerHTML = html;
}

/* ---- CRUD ---- */

window.editProject = async function (index) {
  var data = await api.load(DATA_PATH);
  var proj = data.projects[index];
  openForm({
    title: 'Edit Project',
    fields: PROJECT_FIELDS,
    values: proj,
    onSave: async function (vals) {
      vals.id = slugify(vals.name);
      Object.assign(data.projects[index], vals);
      await api.save(DATA_PATH, data);
      loadAndRender();
    },
  });
};

window.deleteProject = async function (index) {
  if (!confirmAction('Remove this project? (Items assigned to it will keep their account numbers.)')) return;
  var data = await api.load(DATA_PATH);
  data.projects.splice(index, 1);
  await api.save(DATA_PATH, data);
  loadAndRender();
};

document.getElementById('add-project').onclick = function () {
  openForm({
    title: 'Add Project / Grant',
    fields: PROJECT_FIELDS,
    onSave: async function (vals) {
      var data = await api.load(DATA_PATH);
      vals.id = slugify(vals.name);
      data.projects.push(vals);
      await api.save(DATA_PATH, data);
      loadAndRender();
    },
  });
};

(async function () {
  if (typeof firebridge !== 'undefined' && firebridge.whenAuthResolved) await firebridge.whenAuthResolved();
  await loadAndRender();
  // No LIVE_SYNC.attach: projects-grants overview rolls up cached data;
  // edits happen on projects.html / grants.html which own their own sync.
})();
