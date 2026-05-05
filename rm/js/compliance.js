/* compliance.js — IRB + IACUC protocol tracking + student training certs.
 *
 * V3.46 added the student-side submission flow that previously lived in
 * /apps/compliance/. The Student Training tab does double duty:
 *   - Admin: renders every complianceSubmissions doc (firebridge.getAll)
 *     with Verify buttons and expiry chips.
 *   - Non-admin: queries their own submissions only
 *     (where('submittedBy','==',uid)) — required because firestore.rules
 *     restricts read to (own OR isAdmin); a bare getAll would 404 the
 *     whole query for any doc the user doesn't own.
 *
 * The page-header `+ Add Protocol` button switches label and behavior on
 * the Training tab, becoming `+ Submit Certificate` and opening
 * openSubmitCertModal() — file upload to compliance/{uid}/{docId}/<name>
 * (Storage rule at storage.rules line 78), then write to
 * complianceSubmissions with status='submitted'. */


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

function _isAdmin() {
  return typeof firebridge !== 'undefined' && firebridge.isAdmin && firebridge.isAdmin();
}

function _updateAddButton() {
  const addBtn = document.getElementById('add-item');
  if (!addBtn) return;
  if (activeTab === 'training') {
    addBtn.textContent = '+ Submit Certificate';
  } else if (_isAdmin()) {
    addBtn.textContent = '+ Add Protocol';
    addBtn.style.display = '';
  } else {
    // Non-admins can't write to the `compliance` collection (admin-only),
    // so hide the button on IRB/IACUC tabs entirely.
    addBtn.style.display = 'none';
    return;
  }
  addBtn.style.display = '';
}

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

  _updateAddButton();

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
    var subs;
    if (_isAdmin()) {
      subs = await firebridge.getAll('complianceSubmissions', 'createdAt', 'desc');
    } else {
      // Non-admins: firestore.rules restricts read to own submissions, so
      // the query MUST include where('submittedBy','==',uid) — a bare
      // getAll would fail per-doc rule evaluation against any doc the
      // current user doesn't own.
      var uid = firebridge.getUser && firebridge.getUser() && firebridge.getUser().uid;
      if (!uid) {
        content.innerHTML = '<div class="empty-state">Sign in to see your submissions.</div>';
        return;
      }
      var snap = await firebridge.db().collection('complianceSubmissions')
        .where('submittedBy', '==', uid)
        .orderBy('createdAt', 'desc')
        .get();
      subs = snap.docs.map(function (d) { return Object.assign({ id: d.id }, d.data()); });
    }

    if (subs.length === 0) {
      var empty = _isAdmin()
        ? 'No student training submissions yet.'
        : 'You haven’t submitted any training certificates yet. Click <strong>+ Submit Certificate</strong> above to upload your first one.';
      content.innerHTML = '<div class="empty-state">' + empty + '</div>';
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
      if (s.status === 'submitted' && _isAdmin()) {
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
  if (activeTab === 'training') {
    openSubmitCertModal();
    return;
  }
  if (!_isAdmin()) return; // button is hidden for non-admins on protocol tabs anyway
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

/* ─── Submit Certificate modal (V3.46) ─────────────────────
 * Replaces /apps/compliance/. Uploads the cert to
 * compliance/{uid}/{docId}/<filename> in Storage (rule at
 * storage.rules:78 — auth + 10MB + PDF/image), then writes a
 * complianceSubmissions doc with status='submitted'. Defaults the
 * active tab to Training afterward so the user immediately sees their
 * submission in the list.
 */
function openSubmitCertModal() {
  if (typeof firebridge === 'undefined' || !firebridge.getUser || !firebridge.getUser()) {
    if (window.toast) window.toast('Sign in to submit a certificate', 'error');
    return;
  }

  const overlay = document.createElement('div');
  overlay.className = 'modal-overlay';
  overlay.innerHTML =
    '<div class="modal" style="max-width: 520px;">' +
      '<div class="modal-title">Submit Training Certificate</div>' +
      '<p style="font-size:13px;color:var(--text-muted);margin:0 0 14px;">Upload your completion certificate. The PI verifies submissions from the Student Training tab.</p>' +
      '<div class="form-group">' +
        '<label>Training Type *</label>' +
        '<select id="cert-type">' +
          '<option value="">— select —</option>' +
          '<option value="citi_training">CITI Training</option>' +
          '<option value="lab_safety">Lab Safety</option>' +
          '<option value="biosafety">Biosafety</option>' +
          '<option value="radiation">Radiation Safety</option>' +
          '<option value="animal_care">Animal Care (IACUC)</option>' +
          '<option value="other">Other</option>' +
        '</select>' +
      '</div>' +
      '<div class="form-group">' +
        '<label>Title / Course Name *</label>' +
        '<input id="cert-title" type="text" placeholder="e.g. CITI Human Subjects Research — Basic" />' +
      '</div>' +
      '<div class="form-group">' +
        '<label>Completion Date *</label>' +
        '<input id="cert-date" type="date" />' +
      '</div>' +
      '<div class="form-group">' +
        '<label>Expiration Date (optional)</label>' +
        '<input id="cert-expiry" type="date" />' +
      '</div>' +
      '<div class="form-group">' +
        '<label>Certificate (PDF or image)</label>' +
        '<input id="cert-file" type="file" accept="application/pdf,image/*" />' +
      '</div>' +
      '<div id="cert-error" style="display:none;background:var(--red-bg);color:var(--red);padding:8px 12px;border-radius:var(--radius);font-size:13px;margin-bottom:10px;"></div>' +
      '<div class="modal-actions">' +
        '<button class="btn" id="cert-cancel">Cancel</button>' +
        '<button class="btn btn-primary" id="cert-submit">Submit</button>' +
      '</div>' +
    '</div>';

  document.body.appendChild(overlay);

  function close() { overlay.remove(); }
  overlay.addEventListener('click', e => { if (e.target === overlay) close(); });
  overlay.querySelector('#cert-cancel').onclick = close;

  overlay.querySelector('#cert-submit').onclick = async () => {
    const type   = overlay.querySelector('#cert-type').value;
    const title  = overlay.querySelector('#cert-title').value.trim();
    const date   = overlay.querySelector('#cert-date').value;
    const expiry = overlay.querySelector('#cert-expiry').value;
    const fileEl = overlay.querySelector('#cert-file');
    const errEl  = overlay.querySelector('#cert-error');
    const submitBtn = overlay.querySelector('#cert-submit');

    if (!type || !title || !date) {
      errEl.textContent = 'Type, title, and completion date are all required.';
      errEl.style.display = 'block';
      return;
    }
    errEl.style.display = 'none';
    submitBtn.disabled = true;
    submitBtn.textContent = 'Submitting…';

    const user = firebridge.getUser();
    const profile = firebridge.getProfile && firebridge.getProfile();

    try {
      let certificateUrl = '';
      let storagePath = '';
      if (fileEl.files && fileEl.files.length) {
        const file = fileEl.files[0];
        const docId = Date.now() + '-' + Math.random().toString(36).slice(2, 8);
        const safe  = file.name.replace(/[^a-zA-Z0-9._-]/g, '_');
        storagePath = 'compliance/' + user.uid + '/' + docId + '/' + safe;
        const ref = firebase.storage().ref().child(storagePath);
        const snap = await ref.put(file);
        certificateUrl = await snap.ref.getDownloadURL();
      }

      const ts = firebase.firestore.FieldValue.serverTimestamp();
      await firebridge.db().collection('complianceSubmissions').add({
        submittedBy: user.uid,
        submitterName: (profile && profile.name) || user.displayName || user.email,
        type: type,
        title: title,
        completionDate: date,
        expirationDate: expiry || '',
        certificateUrl: certificateUrl,
        storagePath: storagePath,
        status: 'submitted',
        createdAt: ts,
        updatedAt: ts,
      });

      if (window.toast) window.toast('Certificate submitted');
      close();
      // Show the Training tab so the user immediately sees their submission.
      activeTab = 'training';
      loadAndRender();
    } catch (err) {
      console.warn('[compliance] submit cert failed:', err);
      errEl.textContent = 'Failed: ' + (err.message || 'unknown error');
      errEl.style.display = 'block';
      submitBtn.disabled = false;
      submitBtn.textContent = 'Submit';
    }
  };
}

(async function () {
  if (typeof firebridge !== 'undefined' && firebridge.whenAuthResolved) await firebridge.whenAuthResolved();
  await loadAndRender();
  // No LIVE_SYNC.attach: protocols change rarely; cached api.load is enough.
})();
