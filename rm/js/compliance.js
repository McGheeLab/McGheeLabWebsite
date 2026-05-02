/* compliance.js — IRB + IACUC protocol tracking */

const PROTOCOL_FIELDS = [
  { key: 'title', label: 'Protocol Title', type: 'text', required: true },
  { key: 'protocol_number', label: 'Protocol Number', type: 'text' },
  { key: 'status', label: 'Status', type: 'select', options: ['active', 'pending', 'expired', 'withdrawn', 'exempt'] },
  { key: 'pi', label: 'PI', type: 'text', placeholder: 'Principal Investigator name' },
  { key: 'approval_date', label: 'Approval Date', type: 'date' },
  { key: 'expiration_date', label: 'Expiration Date', type: 'date' },
  { key: 'renewal_due', label: 'Renewal Due', type: 'date' },
  { key: 'related_proposal', label: 'Related Proposal ID', type: 'text', placeholder: 'e.g. prostate-gels-r01' },
  { key: 'notes', label: 'Notes', type: 'textarea' },
];

const TABS = [
  { key: 'irb', label: 'IRB', path: 'compliance/irb.json', dataKey: 'protocols' },
  { key: 'iacuc', label: 'IACUC', path: 'compliance/iacuc.json', dataKey: 'protocols' },
  { key: 'training', label: 'Student Training' },
];

let activeTab = 'irb';
var _sortKey = null;
var _sortDir = 'asc';
var PROTOCOL_COLUMNS = [
  { label: 'Title', key: 'title' },
  { label: 'Protocol #', key: 'protocol_number' },
  { label: 'PI', key: 'pi' },
  { label: 'Approval', key: 'approval_date', type: 'date' },
  { label: 'Expiration', key: 'expiration_date', type: 'date' },
  { label: 'Status', key: 'status' },
  { label: 'Actions', key: null },
];
var TRAINING_COLUMNS = [
  { label: 'Member', key: 'submitterName' },
  { label: 'Type', key: 'type' },
  { label: 'Title', key: 'title' },
  { label: 'Completed', key: 'completionDate', type: 'date' },
  { label: 'Expires', key: 'expirationDate', type: 'date' },
  { label: 'Status', key: 'status' },
  { label: 'Actions', key: null },
];

async function loadAndRender() {
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

  // Student Training tab — Firestore
  if (activeTab === 'training') {
    return renderTrainingTab(content);
  }

  const tab = TABS.find(t => t.key === activeTab);
  const data = await api.load(tab.path);
  const items = data[tab.dataKey];

  if (items.length === 0) {
    content.innerHTML = `<div class="empty-state">No ${tab.label} protocols yet. Click "+ Add Protocol" to get started.</div>`;
    return;
  }

  let html = '<table class="data-table">' +
    sortableHeader(PROTOCOL_COLUMNS, _sortKey, _sortDir, 'onComplianceSort') +
    '<tbody>';

  var sortedItems = sortItems(items, _sortKey, _sortDir, PROTOCOL_COLUMNS);
  sortedItems.forEach((item) => {
    var i = items.indexOf(item);
    html += `<tr>
      <td><strong>${item.title}</strong>${item.related_proposal ? '<br><small style="color:var(--text-muted)">Linked: ' + item.related_proposal + '</small>' : ''}</td>
      <td>${item.protocol_number || ''}</td>
      <td>${item.pi || ''}</td>
      <td>${formatDate(item.approval_date)}</td>
      <td>${formatDate(item.expiration_date)} ${deadlineChip(item.expiration_date)}</td>
      <td>${statusChip(item.status)}</td>
      <td class="row-actions"><button onclick="editItem(${i})">Edit</button><button onclick="deleteItem(${i})">Delete</button></td>
    </tr>`;
  });

  html += '</tbody></table>';
  content.innerHTML = html;
}

/* ---- Student Training (Firestore) ---- */

async function renderTrainingTab(content) {
  if (typeof firebridge === 'undefined' || !firebridge.isReady()) {
    content.innerHTML = '<div class="empty-state"><p>Not connected to the website.</p><p style="margin-top:8px"><a href="/rm/pages/settings.html">Go to Settings</a> to sign in.</p></div>';
    return;
  }

  content.innerHTML = '<div class="empty-state">Loading student training records&hellip;</div>';

  try {
    var subs = await firebridge.getAll('complianceSubmissions', 'createdAt', 'desc');

    if (subs.length === 0) {
      content.innerHTML = '<div class="empty-state">No student training submissions yet.</div>';
      return;
    }

    // Check for expirations
    var todayStr = today();
    var expiring = subs.filter(function (s) {
      return s.expirationDate && s.expirationDate <= todayStr && s.status !== 'expired';
    });

    var html = '';
    if (expiring.length) {
      html += '<div style="background:var(--red-bg);border:1px solid var(--red);border-radius:var(--radius);padding:12px;margin-bottom:16px;font-size:14px;">';
      html += '<strong style="color:var(--red);">' + expiring.length + ' expired training record' + (expiring.length > 1 ? 's' : '') + '</strong>';
      html += '</div>';
    }

    subs = sortItems(subs, _sortKey, _sortDir, TRAINING_COLUMNS);
    html += '<table class="data-table">' + sortableHeader(TRAINING_COLUMNS, _sortKey, _sortDir, 'onComplianceSort') + '<tbody>';

    subs.forEach(function (s) {
      var isExpired = s.expirationDate && s.expirationDate <= todayStr;
      html += '<tr>' +
        '<td><strong>' + (s.submitterName || '') + '</strong></td>' +
        '<td>' + (s.type || '').replace(/_/g, ' ') + '</td>' +
        '<td>' + (s.title || '') + '</td>' +
        '<td>' + formatDate(s.completionDate) + '</td>' +
        '<td>' + formatDate(s.expirationDate) + (s.expirationDate ? ' ' + deadlineChip(s.expirationDate) : '') + '</td>' +
        '<td>' + statusChip(isExpired ? 'expired' : s.status) + '</td>' +
        '<td class="row-actions">';
      if (s.certificateUrl) {
        html += '<a href="' + s.certificateUrl + '" target="_blank" style="font-size:13px;color:var(--primary);">View</a> ';
      }
      if (s.status === 'submitted') {
        html += '<button onclick="verifyTraining(\'' + s.id + '\')">Verify</button>';
      }
      html += '</td></tr>';
    });

    html += '</tbody></table>';
    content.innerHTML = html;
  } catch (err) {
    content.innerHTML = '<div class="empty-state" style="color:var(--red);">Error: ' + err.message + '</div>';
  }
}

window.verifyTraining = async function (docId) {
  if (!confirmAction('Mark this training as verified?')) return;
  await firebridge.updateDoc('complianceSubmissions', docId, { status: 'verified' });
  loadAndRender();
};

/* Surgical save — `compliance` is a shared collection with protocolType
 * discriminator. Writing one protocol = one doc, not a full collection rewrite. */
async function _saveProtocolSurgical(protocol, protocolType, path) {
  if (typeof firebridge === 'undefined' || !firebridge.db) {
    return api.save(path, { protocols: _activeProtocols(path) });
  }
  try {
    var db = firebridge.db();
    var ts = firebase.firestore.FieldValue.serverTimestamp();
    var clean = Object.assign({}, protocol);
    delete clean.id;
    clean.protocolType = protocolType;
    clean.updatedAt = ts;
    await db.collection('compliance').doc(protocol.id).set(clean, { merge: true });
  } catch (err) {
    console.warn('[compliance] surgical save failed, falling back:', err.message);
    await api.save(path, { protocols: _activeProtocols(path) });
  }
}
async function _deleteProtocolSurgical(id, path) {
  if (typeof firebridge === 'undefined' || !firebridge.db) {
    return api.save(path, { protocols: _activeProtocols(path) });
  }
  try {
    var db = firebridge.db();
    await db.collection('compliance').doc(id).delete();
  } catch (err) {
    console.warn('[compliance] surgical delete failed, falling back:', err.message);
    await api.save(path, { protocols: _activeProtocols(path) });
  }
}
function _activeProtocols(path) {
  // For fallback path — re-read from local cache; safer to just re-fetch.
  return [];
}
function _complianceToastError(label) {
  return function (err) {
    console.error('[compliance] ' + label + ' failed:', err);
    if (window.TOAST) TOAST.error('Save failed: ' + label, { detail: err.message });
  };
}

window.editItem = async function (index) {
  const tab = TABS.find(t => t.key === activeTab);
  const data = await api.load(tab.path);
  const item = data[tab.dataKey][index];
  openForm({
    title: `Edit ${tab.label} Protocol`,
    fields: PROTOCOL_FIELDS,
    values: item,
    onSave: (vals) => {
      Object.assign(data[tab.dataKey][index], vals);
      data[tab.dataKey][index].id = slugify(vals.title);
      // Re-render from in-memory data immediately
      _paintProtocols(tab, data[tab.dataKey]);
      _saveProtocolSurgical(data[tab.dataKey][index], tab.key, tab.path)
        .catch(_complianceToastError('edit protocol'));
    },
  });
};

window.deleteItem = async function (index) {
  const tab = TABS.find(t => t.key === activeTab);
  if (!confirmAction('Remove this protocol?')) return;
  const data = await api.load(tab.path);
  const removed = data[tab.dataKey][index];
  data[tab.dataKey].splice(index, 1);
  _paintProtocols(tab, data[tab.dataKey]);
  if (removed && removed.id) {
    _deleteProtocolSurgical(removed.id, tab.path).catch(_complianceToastError('delete protocol'));
  }
};

/* Local in-memory render — used by optimistic save paths so the page paints
 * immediately without waiting for Firestore round-trip. Mirrors the rendering
 * logic in loadAndRender() but reads from the in-memory items array we pass in. */
function _paintProtocols(tab, items) {
  const content = document.getElementById('content');
  if (!items.length) {
    content.innerHTML = `<div class="empty-state">No ${tab.label} protocols yet. Click "+ Add Protocol" to get started.</div>`;
    return;
  }
  let html = '<table class="data-table">' +
    sortableHeader(PROTOCOL_COLUMNS, _sortKey, _sortDir, 'onComplianceSort') +
    '<tbody>';
  var sortedItems = sortItems(items, _sortKey, _sortDir, PROTOCOL_COLUMNS);
  sortedItems.forEach((item) => {
    var i = items.indexOf(item);
    html += `<tr>
      <td><strong>${item.title}</strong>${item.related_proposal ? '<br><small style="color:var(--text-muted)">Linked: ' + item.related_proposal + '</small>' : ''}</td>
      <td>${item.protocol_number || ''}</td>
      <td>${item.pi || ''}</td>
      <td>${formatDate(item.approval_date)}</td>
      <td>${formatDate(item.expiration_date)} ${deadlineChip(item.expiration_date)}</td>
      <td>${statusChip(item.status)}</td>
      <td class="row-actions"><button onclick="editItem(${i})">Edit</button><button onclick="deleteItem(${i})">Delete</button></td>
    </tr>`;
  });
  html += '</tbody></table>';
  content.innerHTML = html;
}

window.onComplianceSort = function (key) {
  if (_sortKey === key) { _sortDir = _sortDir === 'asc' ? 'desc' : 'asc'; }
  else { _sortKey = key; _sortDir = 'asc'; }
  loadAndRender();
};

document.getElementById('add-item').onclick = () => {
  const tab = TABS.find(t => t.key === activeTab);
  openForm({
    title: `Add ${tab.label} Protocol`,
    fields: PROTOCOL_FIELDS,
    onSave: async (vals) => {
      const data = await api.load(tab.path);
      vals.id = slugify(vals.title);
      data[tab.dataKey].push(vals);
      _paintProtocols(tab, data[tab.dataKey]);
      _saveProtocolSurgical(vals, tab.key, tab.path).catch(_complianceToastError('add protocol'));
    },
  });
};

(async function () {
  if (typeof firebridge !== 'undefined' && firebridge.whenAuthResolved) await firebridge.whenAuthResolved();
  await loadAndRender();
  // No LIVE_SYNC.attach: protocols change rarely; cached api.load is enough.
})();
