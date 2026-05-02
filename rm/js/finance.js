/* finance.js — travel & reimbursement: manual trips + parsed travel receipts */

var TRIP_FIELDS = [
  { key: 'event', label: 'Event / Purpose', type: 'text', required: true },
  { key: 'destination', label: 'Destination', type: 'text' },
  { key: 'start_date', label: 'Start Date', type: 'date' },
  { key: 'end_date', label: 'End Date', type: 'date' },
  { key: 'travelers', label: 'Travelers (comma-separated)', type: 'text', placeholder: 'comma-separated traveler names' },
  { key: 'account_number', label: 'Account Number', type: 'text', placeholder: 'e.g. 3062920' },
  { key: 'funding_source', label: 'Funding Source', type: 'text', placeholder: 'e.g. ONR, Startup' },
  { key: 'estimated_cost', label: 'Estimated Cost ($)', type: 'number' },
  { key: 'actual_cost', label: 'Actual Cost ($)', type: 'number' },
  { key: 'reimbursement_status', label: 'Reimbursement Status', type: 'select', options: ['not_submitted', 'submitted', 'approved', 'reimbursed'] },
  { key: 'receipts_complete', label: 'Receipts Complete', type: 'checkbox' },
  { key: 'notes', label: 'Notes', type: 'textarea' },
];

var TRAVEL_PATH = 'finance/travel.json';
var PARSED_PATH = 'finance/receipts_meta.json';
var _trips = [];
var _parsedTravel = [];
var activeTab = 'trips';
var _sortKey = null;
var _sortDir = 'asc';
var TRIP_COLUMNS = [
  { label: 'Event', key: 'event' },
  { label: 'Destination', key: 'destination' },
  { label: 'Dates', key: 'start_date', type: 'date' },
  { label: 'Travelers', key: 'travelers' },
  { label: 'Actual Cost', key: 'actual_cost', type: 'number' },
  { label: 'Reimbursement', key: 'reimbursement_status' },
  { label: 'Receipts', key: 'receipts_complete' },
  { label: 'Actions', key: null },
];
var PARSED_TRAVEL_COLUMNS = [
  { label: 'Vendor', key: 'vendor' },
  { label: 'Total', key: 'total', type: 'number' },
  { label: 'Date', key: 'date', type: 'date' },
  { label: 'Payment', key: 'payment_method' },
  { label: 'Items', key: 'item_count', type: 'number' },
  { label: 'Source File', key: 'source_file' },
];

async function loadData() {
  var results = await Promise.all([
    api.load(TRAVEL_PATH),
    api.load(PARSED_PATH),
  ]);
  _trips = results[0].trips || [];
  // Filter parsed receipts to only travel source type
  _parsedTravel = (results[1].receipts_meta || []).filter(function (r) {
    return r.source_type === 'travel';
  });
}

async function loadAndRender() {
  await loadData();

  var tabsEl = document.getElementById('tabs');
  if (tabsEl) {
    tabsEl.innerHTML = '';
    var tabs = [
      { key: 'trips', label: 'Trips (' + _trips.length + ')' },
      { key: 'parsed', label: 'Parsed Receipts (' + _parsedTravel.length + ')' },
    ];
    tabs.forEach(function (t) {
      var btn = document.createElement('button');
      btn.className = 'tab-btn' + (activeTab === t.key ? ' active' : '');
      btn.textContent = t.label;
      btn.onclick = function () { activeTab = t.key; _sortKey = null; _sortDir = 'asc'; loadAndRender(); };
      tabsEl.appendChild(btn);
    });
  }

  render();
}

function render() {
  if (activeTab === 'parsed') return renderParsedTravel();
  return renderTrips();
}

/* ---- Trips (manual) ---- */

function renderTrips() {
  var content = document.getElementById('content');

  if (_trips.length === 0 && _parsedTravel.length === 0) {
    content.innerHTML = '<div class="empty-state">No trips yet. Click "+ Add Trip" to get started.</div>';
    return;
  }

  var totalEstimated = _trips.reduce(function (s, t) { return s + (Number(t.estimated_cost) || 0); }, 0);
  var totalActual = _trips.reduce(function (s, t) { return s + (Number(t.actual_cost) || 0); }, 0);
  var pendingReimburse = _trips.filter(function (t) { return t.reimbursement_status === 'not_submitted' || t.reimbursement_status === 'submitted'; });

  var html = '<div style="display:flex;gap:12px;margin-bottom:16px;flex-wrap:wrap;">';
  html += '<div class="card" style="flex:1;min-width:140px;padding:12px 16px;"><div class="card-title">Trips</div><div class="card-count">' + _trips.length + '</div></div>';
  html += '<div class="card" style="flex:1;min-width:140px;padding:12px 16px;"><div class="card-title">Estimated</div><div class="card-count">$' + totalEstimated.toLocaleString(undefined, { maximumFractionDigits: 0 }) + '</div></div>';
  if (totalActual > 0) {
    html += '<div class="card" style="flex:1;min-width:140px;padding:12px 16px;"><div class="card-title">Actual</div><div class="card-count">$' + totalActual.toLocaleString(undefined, { maximumFractionDigits: 0 }) + '</div></div>';
  }
  if (pendingReimburse.length) {
    html += '<div class="card" style="flex:1;min-width:140px;padding:12px 16px;border-left:3px solid var(--amber);"><div class="card-title">Pending Reimburse</div><div class="card-count" style="color:var(--amber);">' + pendingReimburse.length + '</div></div>';
  }
  html += '</div>';

  if (_trips.length === 0) {
    html += '<div class="empty-state">No manual trips yet. Add one or check the Parsed Receipts tab.</div>';
    content.innerHTML = html;
    return;
  }

  html += '<table class="data-table">' +
    sortableHeader(TRIP_COLUMNS, _sortKey, _sortDir, 'onFinanceSort') +
    '<tbody>';

  var sortedTrips = sortItems(_trips, _sortKey, _sortDir, TRIP_COLUMNS);
  sortedTrips.forEach(function (trip) {
    var i = _trips.indexOf(trip);
    var startDate = trip.start_date || (trip.dates && trip.dates.start) || '';
    var endDate = trip.end_date || (trip.dates && trip.dates.end) || '';
    var dates = startDate && startDate !== 'TBD' ? formatDate(startDate) + (endDate && endDate !== 'TBD' ? ' \u2013 ' + formatDate(endDate) : '') : 'TBD';
    var travelers = Array.isArray(trip.travelers) ? trip.travelers.join(', ') : (trip.travelers || '');

    html += '<tr>' +
      '<td><strong>' + (trip.event || '') + '</strong></td>' +
      '<td>' + (trip.destination || '') + '</td>' +
      '<td>' + dates + '</td>' +
      '<td>' + travelers + '</td>' +
      '<td>' + (trip.actual_cost != null ? '$' + Number(trip.actual_cost).toLocaleString() : '') + '</td>' +
      '<td>' + statusChip(trip.reimbursement_status) + '</td>' +
      '<td>' + (trip.receipts_complete ? '<span class="chip chip-green">yes</span>' : '<span class="chip chip-amber">no</span>') + '</td>' +
      '<td class="row-actions"><button onclick="editTrip(' + i + ')">Edit</button><button onclick="deleteTrip(' + i + ')">Delete</button></td>' +
      '</tr>';
    if (trip.notes) {
      html += '<tr><td colspan="8" style="padding:4px 14px 10px;background:#f9fafb;font-size:12px;color:var(--text-muted);">' + trip.notes + '</td></tr>';
    }
  });

  html += '</tbody></table>';
  content.innerHTML = html;
}

/* ---- Parsed Travel Receipts ---- */

function renderParsedTravel() {
  var content = document.getElementById('content');

  if (_parsedTravel.length === 0) {
    content.innerHTML = '<div class="empty-state">No parsed travel receipts. Run <code>scripts/parse_receipts.py</code> to import from the Travel folder.</div>';
    return;
  }

  var totalParsed = _parsedTravel.reduce(function (s, r) { return s + (r.total || 0); }, 0);

  // Group by event (extracted from source file path)
  var byEvent = {};
  _parsedTravel.forEach(function (r) {
    var parts = (r.source_file || '').split('/');
    var event = parts.length > 1 ? parts[1] : 'Other';
    if (!byEvent[event]) byEvent[event] = { receipts: [], total: 0 };
    byEvent[event].receipts.push(r);
    byEvent[event].total += (r.total || 0);
  });

  var html = '<div style="display:flex;gap:12px;margin-bottom:16px;flex-wrap:wrap;">';
  html += '<div class="card" style="flex:1;min-width:140px;padding:12px 16px;"><div class="card-title">Parsed Receipts</div><div class="card-count">' + _parsedTravel.length + '</div></div>';
  html += '<div class="card" style="flex:1;min-width:140px;padding:12px 16px;"><div class="card-title">Total</div><div class="card-count">$' + totalParsed.toLocaleString(undefined, { maximumFractionDigits: 0 }) + '</div></div>';
  html += '<div class="card" style="flex:1;min-width:140px;padding:12px 16px;"><div class="card-title">Events</div><div class="card-count">' + Object.keys(byEvent).length + '</div></div>';
  html += '</div>';

  // Render grouped by event
  Object.entries(byEvent).sort(function (a, b) { return b[1].total - a[1].total; }).forEach(function (kv) {
    var event = kv[0];
    var info = kv[1];

    html += '<h2 style="font-size:15px;margin:16px 0 8px;">' + event + ' <span style="font-size:13px;color:var(--text-muted);font-weight:normal;">$' + info.total.toLocaleString(undefined, { minimumFractionDigits: 2 }) + ' &middot; ' + info.receipts.length + ' receipts</span></h2>';
    html += '<table class="data-table" style="margin-bottom:16px;">' + sortableHeader(PARSED_TRAVEL_COLUMNS, _sortKey, _sortDir, 'onFinanceSort') + '<tbody>';

    var sortedParsed = sortItems(info.receipts, _sortKey, _sortDir, PARSED_TRAVEL_COLUMNS);
    sortedParsed.forEach(function (r) {
      var filename = (r.source_file || '').split('/').pop();
      html += '<tr>' +
        '<td><strong>' + (r.vendor || '') + '</strong></td>' +
        '<td>$' + (r.total || 0).toLocaleString(undefined, { minimumFractionDigits: 2 }) + '</td>' +
        '<td>' + formatDate(r.date) + '</td>' +
        '<td style="font-size:12px;">' + (r.payment_method || '') + '</td>' +
        '<td>' + (r.item_count || 0) + '</td>' +
        '<td style="font-size:11px;color:var(--text-muted);">' + filename + '</td>' +
        '</tr>';
    });
    html += '</tbody></table>';
  });

  html += '<div style="margin-top:8px;font-size:13px;color:var(--text-muted);">Source files are in the Travel folder on the Synology NAS.</div>';
  content.innerHTML = html;
}

/* ---- CRUD ---- */

/* Surgical save — financeTravel is a per-user subcollection. Writing one trip
 * = one doc, not a full collection rewrite. Pattern matches receipts.js. */
async function _saveTripSurgical(trip) {
  if (typeof firebridge === 'undefined' || !firebridge.db) {
    return api.save(TRAVEL_PATH, { trips: _trips });
  }
  try {
    var uid = firebridge.currentUid && firebridge.currentUid();
    if (!uid) return api.save(TRAVEL_PATH, { trips: _trips });
    var db = firebridge.db();
    var ts = firebase.firestore.FieldValue.serverTimestamp();
    var clean = Object.assign({}, trip);
    delete clean.id;
    clean.updatedAt = ts;
    await db.collection('userData').doc(uid).collection('financeTravel').doc(trip.id).set(clean, { merge: true });
  } catch (err) {
    console.warn('[finance] surgical trip save failed, falling back:', err.message);
    await api.save(TRAVEL_PATH, { trips: _trips });
  }
}
async function _deleteTripSurgical(id) {
  if (typeof firebridge === 'undefined' || !firebridge.db) {
    return api.save(TRAVEL_PATH, { trips: _trips });
  }
  try {
    var uid = firebridge.currentUid && firebridge.currentUid();
    if (!uid) return api.save(TRAVEL_PATH, { trips: _trips });
    var db = firebridge.db();
    await db.collection('userData').doc(uid).collection('financeTravel').doc(id).delete();
  } catch (err) {
    console.warn('[finance] surgical trip delete failed, falling back:', err.message);
    await api.save(TRAVEL_PATH, { trips: _trips });
  }
}
function _financeToastError(label) {
  return function (err) {
    console.error('[finance] ' + label + ' failed:', err);
    if (window.TOAST) TOAST.error('Save failed: ' + label, { detail: err.message });
  };
}

window.editTrip = function (index) {
  var trip = _trips[index];
  if (!trip) return;
  var values = Object.assign({}, trip);
  // Convert travelers array to comma-separated string for the form
  if (Array.isArray(values.travelers)) {
    values.travelers = values.travelers.join(', ');
  }
  if (trip.dates) {
    values.start_date = values.start_date || trip.dates.start;
    values.end_date = values.end_date || trip.dates.end;
  }
  openForm({
    title: 'Edit Trip',
    fields: TRIP_FIELDS,
    values: values,
    onSave: function (vals) {
      var oldId = trip.id;
      vals.id = slugify(vals.event);
      // Convert comma-separated travelers back to array
      if (typeof vals.travelers === 'string') {
        vals.travelers = vals.travelers.split(',').map(function (s) { return s.trim(); }).filter(Boolean);
      }
      // Preserve receipt_ids from original trip
      vals.receipt_ids = trip.receipt_ids || [];
      delete vals.dates;
      _trips[index] = vals;
      render();
      if (oldId && oldId !== vals.id) {
        _deleteTripSurgical(oldId).catch(_financeToastError('delete old trip'));
      }
      _saveTripSurgical(vals).catch(_financeToastError('edit trip'));
    },
  });
};

window.deleteTrip = function (index) {
  if (!confirmAction('Remove this trip?')) return;
  var trip = _trips[index];
  if (!trip) return;
  var id = trip.id;
  _trips.splice(index, 1);
  render();
  if (id) _deleteTripSurgical(id).catch(_financeToastError('delete trip'));
};

document.getElementById('add-trip').onclick = function () {
  openForm({
    title: 'Add Trip',
    fields: TRIP_FIELDS,
    onSave: function (vals) {
      vals.id = slugify(vals.event);
      // Convert comma-separated travelers to array
      if (typeof vals.travelers === 'string') {
        vals.travelers = vals.travelers.split(',').map(function (s) { return s.trim(); }).filter(Boolean);
      }
      vals.receipt_ids = [];
      _trips.push(vals);
      render();
      _saveTripSurgical(vals).catch(_financeToastError('add trip'));
    },
  });
};

/* ---- Upload receipts ---- */

document.getElementById('upload-receipts').onclick = function () {
  var overlay = document.createElement('div');
  overlay.className = 'modal-overlay';
  var modal = document.createElement('div');
  modal.className = 'modal';
  modal.innerHTML = '<div class="modal-title">Upload Travel Receipts</div>' +
    '<div class="form-group"><label>Event / Trip Name *</label><input type="text" id="upload-event" placeholder="e.g. BMES 2026, Moffitt Visit" required></div>' +
    '<div class="form-group"><label>Account Number</label><input type="text" id="upload-account" placeholder="e.g. 3062920"></div>' +
    '<div class="form-group"><label>Select PDF Files</label>' +
    '<input type="file" id="upload-files" multiple accept=".pdf" style="font-size:14px;">' +
    '<div style="font-size:12px;color:var(--text-muted);margin-top:4px;">Select one or more PDF receipts (flights, hotels, rideshares, registrations)</div></div>' +
    '<div id="upload-status" style="display:none;margin-bottom:12px;padding:10px;border-radius:var(--radius);font-size:13px;"></div>' +
    '<div class="modal-actions">' +
    '<button class="btn" id="upload-cancel">Cancel</button>' +
    '<button class="btn btn-primary" id="upload-submit">Parse Receipts</button></div>';
  overlay.appendChild(modal);
  document.body.appendChild(overlay);
  safeCloseOnBackdrop(overlay, modal, function () { if (overlay.parentNode) overlay.remove(); });
  document.getElementById('upload-event').focus();

  document.getElementById('upload-cancel').onclick = function () { overlay.remove(); };

  document.getElementById('upload-submit').onclick = async function () {
    var eventName = document.getElementById('upload-event').value.trim();
    var accountNum = document.getElementById('upload-account').value.trim();
    var fileInput = document.getElementById('upload-files');
    var statusEl = document.getElementById('upload-status');
    var submitBtn = document.getElementById('upload-submit');

    if (!eventName) {
      document.getElementById('upload-event').style.borderColor = 'var(--red)';
      return;
    }
    if (!fileInput.files || fileInput.files.length === 0) {
      statusEl.style.display = 'block';
      statusEl.style.background = 'var(--red-bg)';
      statusEl.textContent = 'Please select at least one PDF file.';
      return;
    }

    var formData = new FormData();
    formData.append('event_name', eventName);
    formData.append('source_type', 'travel');
    for (var i = 0; i < fileInput.files.length; i++) {
      formData.append('files', fileInput.files[i]);
    }

    submitBtn.disabled = true;
    submitBtn.textContent = 'Parsing ' + fileInput.files.length + ' files...';
    statusEl.style.display = 'block';
    statusEl.style.background = 'var(--amber-bg)';
    statusEl.textContent = 'Extracting text and sending to Claude API... This may take a minute.';

    try {
      var resp = await fetch('/api/parse-receipts', { method: 'POST', body: formData });
      var result = await resp.json();

      if (!result.ok) {
        statusEl.style.background = 'var(--red-bg)';
        statusEl.textContent = 'Error: ' + result.error;
        submitBtn.disabled = false;
        submitBtn.textContent = 'Parse Receipts';
        return;
      }

      // Save parsed results into travel.json + receipts_meta + inventory
      var travelData = await api.load(TRAVEL_PATH);
      var metaData = await api.load(PARSED_PATH);

      var tripId = slugify(eventName);
      var existingTrip = travelData.trips.find(function (t) { return t.id === tripId; });
      var tripTotal = 0;
      var receiptIds = [];

      result.results.forEach(function (r) {
        var parsed = r.parsed;
        var receipt = parsed.receipt || {};

        var metaId = slugify('travel-' + (receipt.vendor || r.filename) + '-' + (receipt.date || ''));
        metaData.receipts_meta.push({
          id: metaId,
          source_file: 'uploaded/' + r.filename,
          source_type: 'travel',
          source_hash: r.file_hash,
          vendor: receipt.vendor || '',
          date: receipt.date || '',
          po_number: receipt.po_number || '',
          order_number: receipt.order_number || '',
          account_number: accountNum || receipt.account_number || '',
          total: receipt.total || 0,
          tax: receipt.tax || null,
          shipping: receipt.shipping || null,
          payment_method: receipt.payment_method || '',
          item_count: (parsed.items || []).length,
          parsed_at: new Date().toISOString(),
        });
        receiptIds.push(metaId);
        tripTotal += (receipt.total || 0);
      });

      if (existingTrip) {
        existingTrip.actual_cost = (Number(existingTrip.actual_cost) || 0) + tripTotal;
        existingTrip.receipt_ids = (existingTrip.receipt_ids || []).concat(receiptIds);
        existingTrip.notes = (existingTrip.notes || '') + (existingTrip.notes ? '\n' : '') + 'Uploaded ' + result.parsed_count + ' receipts on ' + today() + '.';
      } else {
        travelData.trips.push({
          id: tripId,
          event: eventName,
          destination: '',
          start_date: '',
          end_date: '',
          travelers: '',
          account_number: accountNum,
          funding_source: '',
          estimated_cost: null,
          actual_cost: tripTotal,
          reimbursement_status: 'not_submitted',
          receipts_complete: false,
          receipt_ids: receiptIds,
          notes: 'Auto-created from ' + result.parsed_count + ' uploaded receipts on ' + today() + '.',
        });
      }

      await api.save(TRAVEL_PATH, travelData);
      await api.save(PARSED_PATH, metaData);

      statusEl.style.background = 'var(--green-bg)';
      statusEl.innerHTML = '<strong>Done!</strong> Parsed ' + result.parsed_count + ' receipts' +
        (result.error_count ? ', ' + result.error_count + ' errors' : '') +
        '. Total: $' + tripTotal.toFixed(2);

      submitBtn.textContent = 'Close';
      submitBtn.disabled = false;
      submitBtn.onclick = function () { overlay.remove(); loadAndRender(); };

    } catch (err) {
      statusEl.style.background = 'var(--red-bg)';
      statusEl.textContent = 'Error: ' + err.message;
      submitBtn.disabled = false;
      submitBtn.textContent = 'Parse Receipts';
    }
  };
};

window.onFinanceSort = function (key) {
  if (_sortKey === key) { _sortDir = _sortDir === 'asc' ? 'desc' : 'asc'; }
  else { _sortKey = key; _sortDir = 'asc'; }
  render();
};

/* ---- Live tab-to-tab sync (subscribe to user-scope finance/travel.json) ---- */
var _finLive = { suppressUntil: 0, savePending: false, refreshTimer: null, unsubs: [] };
function _finWrapSaves() {
  if (_finWrapSaves._wrapped) return;
  _finWrapSaves._wrapped = true;
  var origSave = api.save.bind(api);
  api.save = async function (path, data) {
    var isFin = (path === TRAVEL_PATH);
    if (isFin) { _finLive.savePending = true; _finLive.suppressUntil = Date.now() + 2500; }
    try { return await origSave(path, data); }
    finally { if (isFin) _finLive.savePending = false; }
  };
}
function _finScheduleRefresh() {
  if (_finLive.refreshTimer) return;
  _finLive.refreshTimer = setTimeout(function () {
    _finLive.refreshTimer = null;
    var y = window.scrollY;
    loadAndRender().catch(function (err) { console.warn('[finance] refresh failed:', err); })
      .finally(function () { window.scrollTo({ top: y, left: 0, behavior: 'instant' }); });
  }, 200);
}
function _finAttachLiveSync() {
  if (typeof api.subscribe !== 'function' || _finLive.unsubs.length) return;
  try {
    var firstFireConsumed = false;
    var unsub = api.subscribe(TRAVEL_PATH, function () {
      if (Date.now() < _finLive.suppressUntil) return;
      if (_finLive.savePending) return;
      if (!firstFireConsumed) { firstFireConsumed = true; return; }
      _finScheduleRefresh();
    });
    _finLive.unsubs.push(unsub);
  } catch (err) { console.warn('[finance] live sync attach failed:', err.message); }
}

(async function () {
  if (typeof firebridge !== 'undefined' && firebridge.whenAuthResolved) await firebridge.whenAuthResolved();
  _finWrapSaves();
  await loadAndRender();
  // No live-sync attach: finance is per-user travel, single-tab in practice.
  // _finAttachLiveSync(); // disabled per data-flow plan
})();
