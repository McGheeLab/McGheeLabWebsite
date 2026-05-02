/* receipts.js — procurement system: manual orders + parsed receipts + Firestore student submissions */

var RECEIPT_FIELDS = [
  { key: 'vendor', label: 'Vendor', type: 'text', required: true },
  { key: 'order_number', label: 'Order / PO Number', type: 'text' },
  { key: 'description', label: 'Description', type: 'text' },
  { key: 'amount', label: 'Total ($)', type: 'number', required: true },
  { key: 'date', label: 'Date', type: 'date' },
  { key: 'source_type', label: 'Source Type', type: 'select', options: ['pcard', 'buyways', 'ilab', 'amazon_business', 'vendor_po', 'internal'] },
  { key: 'account_number', label: 'Account Number', type: 'text', placeholder: 'e.g. 1101935' },
  { key: 'project_tag', label: 'Project', type: 'text', placeholder: 'e.g. mebp, gels' },
  { key: 'funding_source', label: 'Funding Source', type: 'text', placeholder: 'e.g. Startup 1, ONR' },
  { key: 'category', label: 'Category', type: 'select', options: [
    'equipment', 'infrastructure', 'consumable', 'computer', 'lab_furniture',
    'office', 'research_reagents', 'research_chem', 'research_cells',
    'research_gels', 'research_gas', 'research_analysis', 'software', 'other'
  ]},
  { key: 'status', label: 'Status', type: 'select', options: ['needs_receipt', 'needs_submission', 'submitted', 'approved', 'reimbursed'] },
  { key: 'notes', label: 'Notes', type: 'textarea' },
];

var MANUAL_PATH = 'finance/receipts.json';
var PARSED_PATH = 'finance/receipts_meta.json';
var INV_PATH = 'inventory/items.json';
var activeTab = 'orders';
var _manualReceipts = [];
var _parsedReceipts = [];
var _invData = null;
var _invItems = [];
var _sortKey = null;
var _sortDir = 'asc';
var ORDER_COLUMNS = [
  { label: 'Vendor', key: 'vendor' },
  { label: 'Description', key: 'description' },
  { label: 'Amount', key: 'amount', type: 'number' },
  { label: 'Date', key: 'date', type: 'date' },
  { label: 'Account', key: 'account_number' },
  { label: 'Category', key: 'category' },
  { label: 'Status', key: 'status' },
  { label: 'Actions', key: null },
];
var PARSED_COLUMNS = [
  { label: 'Vendor', key: 'vendor' },
  { label: 'Source', key: 'source_type' },
  { label: 'PO / Order #', key: 'po_number' },
  { label: 'Total', key: 'total', type: 'number' },
  { label: 'Date', key: 'date', type: 'date' },
  { label: 'Account', key: 'account_number' },
  { label: 'Items', key: 'item_count', type: 'number' },
  { label: 'Payment', key: 'payment_method' },
];
var BUDGET_ACCT_COLUMNS = [
  { label: 'Account', key: 'account' },
  { label: 'Total', key: 'total', type: 'number' },
  { label: '% of Total', key: 'pct', type: 'number' },
];
var BUDGET_CAT_COLUMNS = [
  { label: 'Category', key: 'category' },
  { label: 'Total', key: 'total', type: 'number' },
  { label: '% of Total', key: 'pct', type: 'number' },
];
var BUDGET_PROJ_COLUMNS = [
  { label: 'Project', key: 'project' },
  { label: 'Total', key: 'total', type: 'number' },
  { label: 'Breakdown', key: null },
];

var CATEGORY_OPTIONS = [
  'equipment', 'infrastructure', 'consumable', 'computer', 'lab_furniture', 'office',
  'remodel', 'research_analysis', 'research_cells', 'research_chem',
  'research_gas', 'research_gels', 'research_reagents', 'software', 'other'
];
var STOCK_OPTIONS = ['full', 'low', 'out_of_stock', 'n/a'];
var CONDITION_OPTIONS = ['active', 'broken', 'retired', 'lost'];

/* Surgical save helpers — write only the touched doc, not the whole collection.
 * Without these, inline edits to a single inventory row trigger a 3,481-doc
 * Firestore batch write (~5s). With these, one row = one doc = ~200ms. */
async function _saveReceiptsInvItem(item) {
  if (typeof firebridge === 'undefined' || !firebridge.db) {
    return api.save(INV_PATH, _invData);
  }
  try {
    _receiptsLive.suppressUntil = Date.now() + 2500;
    var db = firebridge.db();
    var ts = firebase.firestore.FieldValue.serverTimestamp();
    var clean = Object.assign({}, item);
    delete clean.id;
    clean.kind = 'item';
    clean.updatedAt = ts;
    await db.collection('inventory').doc(item.id).set(clean, { merge: true });
  } catch (err) {
    console.warn('[receipts] surgical inv save failed, falling back:', err.message);
    await api.save(INV_PATH, _invData);
  }
}
async function _saveReceiptsManualReceipt(receipt) {
  // financeReceipts is a per-user subcollection — surgical-write the one doc.
  if (typeof firebridge === 'undefined' || !firebridge.db) {
    return api.save(MANUAL_PATH, { receipts: _manualReceipts });
  }
  try {
    var uid = firebridge.currentUid && firebridge.currentUid();
    if (!uid) return api.save(MANUAL_PATH, { receipts: _manualReceipts });
    _receiptsLive.suppressUntil = Date.now() + 2500;
    var db = firebridge.db();
    var ts = firebase.firestore.FieldValue.serverTimestamp();
    var clean = Object.assign({}, receipt);
    delete clean.id;
    clean.updatedAt = ts;
    await db.collection('userData').doc(uid).collection('financeReceipts').doc(receipt.id).set(clean, { merge: true });
  } catch (err) {
    console.warn('[receipts] surgical receipt save failed, falling back:', err.message);
    await api.save(MANUAL_PATH, { receipts: _manualReceipts });
  }
}
async function _deleteReceiptsManualReceipt(id) {
  if (typeof firebridge === 'undefined' || !firebridge.db) {
    return api.save(MANUAL_PATH, { receipts: _manualReceipts });
  }
  try {
    var uid = firebridge.currentUid && firebridge.currentUid();
    if (!uid) return api.save(MANUAL_PATH, { receipts: _manualReceipts });
    _receiptsLive.suppressUntil = Date.now() + 2500;
    var db = firebridge.db();
    await db.collection('userData').doc(uid).collection('financeReceipts').doc(id).delete();
  } catch (err) {
    console.warn('[receipts] surgical receipt delete failed, falling back:', err.message);
    await api.save(MANUAL_PATH, { receipts: _manualReceipts });
  }
}
function _receiptsToastError(label) {
  return function (err) {
    console.error('[receipts] ' + label + ' failed:', err);
    if (window.TOAST) TOAST.error('Save failed: ' + label, { detail: err.message });
  };
}

async function loadData() {
  var results = await Promise.all([
    api.load(MANUAL_PATH),
    api.load(PARSED_PATH),
    api.load(INV_PATH),
  ]);
  _manualReceipts = results[0].receipts || [];
  _parsedReceipts = results[1].receipts_meta || [];
  _invData = results[2];
  _invItems = _invData.items || [];
}

async function loadAndRender() {
  await loadData();

  var tabsEl = document.getElementById('tabs');
  tabsEl.innerHTML = '';
  var tabs = [
    { key: 'orders', label: 'Active Orders (' + _manualReceipts.length + ')' },
    { key: 'parsed', label: 'Parsed Receipts (' + _parsedReceipts.length + ')' },
    { key: 'incoming', label: 'Incoming' },
    { key: 'budget', label: 'Budget Analysis' },
  ];
  tabs.forEach(function (t) {
    var btn = document.createElement('button');
    btn.className = 'tab-btn' + (activeTab === t.key ? ' active' : '');
    btn.textContent = t.label;
    btn.onclick = function () { activeTab = t.key; _sortKey = null; _sortDir = 'asc'; loadAndRender(); };
    tabsEl.appendChild(btn);
  });

  render();
}

function render() {
  if (activeTab === 'incoming') return renderIncoming();
  if (activeTab === 'parsed') return renderParsed();
  if (activeTab === 'budget') return renderBudgetAnalysis();
  return renderAllOrders();
}

/* ---- Active Orders (manual entries) ---- */

function renderAllOrders() {
  var receipts = _manualReceipts;
  var content = document.getElementById('content');

  if (receipts.length === 0) {
    content.innerHTML = '<div class="empty-state">No active orders. Click "+ Add Order" to track a new purchase.</div>';
    return;
  }

  var total = receipts.reduce(function (s, r) { return s + (r.amount || 0); }, 0);
  var pending = receipts.filter(function (r) { return r.status && r.status.startsWith('needs'); });

  var html = '<div style="display:flex;gap:12px;margin-bottom:16px;flex-wrap:wrap;">';
  html += '<div class="card" style="flex:1;min-width:140px;padding:12px 16px;"><div class="card-title">Active Orders</div><div class="card-count">' + receipts.length + '</div></div>';
  html += '<div class="card" style="flex:1;min-width:140px;padding:12px 16px;"><div class="card-title">Total</div><div class="card-count">$' + total.toLocaleString(undefined, { maximumFractionDigits: 0 }) + '</div></div>';
  if (pending.length) {
    html += '<div class="card" style="flex:1;min-width:140px;padding:12px 16px;border-left:3px solid var(--amber);"><div class="card-title">Need Attention</div><div class="card-count" style="color:var(--amber);">' + pending.length + '</div></div>';
  }
  html += '</div>';

  html += '<table class="data-table">' +
    sortableHeader(ORDER_COLUMNS, _sortKey, _sortDir, 'onReceiptsSort') +
    '<tbody>';

  var sortedReceipts = sortItems(receipts, _sortKey, _sortDir, ORDER_COLUMNS);
  sortedReceipts.forEach(function (r) {
    var i = _manualReceipts.indexOf(r);
    html += '<tr>' +
      '<td><strong>' + (r.vendor || '') + '</strong>' + (r.order_number ? '<br><small style="color:var(--text-muted)">#' + r.order_number + '</small>' : '') + '</td>' +
      '<td>' + (r.description || '') + '</td>' +
      '<td>$' + (r.amount || 0).toLocaleString(undefined, { minimumFractionDigits: 2 }) + '</td>' +
      '<td>' + formatDate(r.date) + '</td>' +
      '<td>' + (r.account_number || r.funding_source || '') + '</td>' +
      '<td>' + (r.category || '').replace(/_/g, ' ') + '</td>' +
      '<td>' + statusChip(r.status) + '</td>' +
      '<td class="row-actions"><button onclick="editItem(' + i + ')">Edit</button><button onclick="deleteItem(' + i + ')">Delete</button></td>' +
      '</tr>';
  });

  html += '</tbody></table>';
  content.innerHTML = html;
}

/* ---- Parsed Receipts (expandable with linked inventory items) ---- */

var _expandedParsed = '';
var _expandedParsedItem = '';

function parsedInlineSelect(realIdx, field, currentVal, options) {
  return '<select data-inv-idx="' + realIdx + '" data-field="' + field + '" onchange="parsedInlineSave(this)" style="font-size:13px;padding:3px 6px;border:1px solid var(--border);border-radius:4px;background:var(--surface);cursor:pointer;">' +
    options.map(function (o) { return '<option value="' + o + '"' + (o === currentVal ? ' selected' : '') + '>' + o.replace(/_/g, ' ') + '</option>'; }).join('') +
    '</select>';
}

function parsedInlineText(realIdx, field, currentVal, placeholder) {
  var val = (currentVal || '').toString();
  return '<input type="text" data-inv-idx="' + realIdx + '" data-field="' + field + '" value="' + val.replace(/"/g, '&quot;') + '" placeholder="' + (placeholder || '') + '" onblur="parsedInlineSave(this)" onkeydown="if(event.key===\'Enter\')this.blur();" style="font-size:13px;padding:3px 6px;border:1px solid var(--border);border-radius:4px;width:100%;max-width:250px;background:var(--surface);">';
}

window.parsedInlineSave = async function (el) {
  var idx = parseInt(el.getAttribute('data-inv-idx'));
  var field = el.getAttribute('data-field');
  var val = el.type === 'checkbox' ? el.checked : el.value;
  if ((field === 'category' || field === 'subcategory') && typeof val === 'string') {
    val = val.toLowerCase().replace(/\s+/g, '_');
    if (el.value !== val) el.value = val;
  }
  _invData.items[idx][field] = val;
  _invData.items[idx].manual_edit = true;
  _invItems = _invData.items;
  el.style.outline = '2px solid var(--green)';
  setTimeout(function () { el.style.outline = ''; }, 600);
  _saveReceiptsInvItem(_invData.items[idx]).catch(_receiptsToastError('inline edit'));
};

window.toggleParsedReceipt = function (rid) {
  var allRows = document.querySelectorAll('.expandable-row');
  var allDetails = document.querySelectorAll('.detail-row');
  if (_expandedParsed === rid) {
    allRows.forEach(function (r) { r.classList.remove('expanded'); });
    allDetails.forEach(function (r) { r.classList.remove('open'); });
    _expandedParsed = '';
    return;
  }
  allRows.forEach(function (r) { r.classList.remove('expanded'); });
  allDetails.forEach(function (r) { r.classList.remove('open'); });
  var row = document.querySelector('tr.expandable-row[data-rid="' + rid + '"]');
  var detail = document.getElementById('pdetail-' + rid);
  if (row) row.classList.add('expanded');
  if (detail) detail.classList.add('open');
  _expandedParsed = rid;
};

window.toggleParsedItem = function (vid) {
  var el = document.getElementById('pi-detail-' + vid);
  if (!el) return;
  if (_expandedParsedItem === vid) {
    el.style.display = 'none';
    _expandedParsedItem = '';
  } else {
    if (_expandedParsedItem) {
      var prev = document.getElementById('pi-detail-' + _expandedParsedItem);
      if (prev) prev.style.display = 'none';
    }
    el.style.display = 'block';
    _expandedParsedItem = vid;
  }
};

function renderParsed() {
  var content = document.getElementById('content');

  if (_parsedReceipts.length === 0) {
    content.innerHTML = '<div class="empty-state">No parsed receipts yet. Run <code>scripts/parse_receipts.py</code> or use "Upload Receipt" to import.</div>';
    return;
  }

  // Build lookup: source_hash → inventory items
  var itemsByHash = {};
  var itemsBySourceFile = {};
  _invItems.forEach(function (item, idx) {
    var ref = item.receipt_ref || {};
    if (ref.source_hash) {
      if (!itemsByHash[ref.source_hash]) itemsByHash[ref.source_hash] = [];
      itemsByHash[ref.source_hash].push(idx);
    }
    if (ref.source_file) {
      if (!itemsBySourceFile[ref.source_file]) itemsBySourceFile[ref.source_file] = [];
      itemsBySourceFile[ref.source_file].push(idx);
    }
  });

  var bySource = {};
  _parsedReceipts.forEach(function (r) { bySource[r.source_type || 'unknown'] = (bySource[r.source_type || 'unknown'] || 0) + 1; });
  var totalParsed = _parsedReceipts.reduce(function (s, r) { return s + (r.total || 0); }, 0);

  var html = '<div style="display:flex;gap:12px;margin-bottom:16px;flex-wrap:wrap;">';
  html += '<div class="card" style="flex:1;min-width:140px;padding:12px 16px;"><div class="card-title">Parsed Receipts</div><div class="card-count">' + _parsedReceipts.length + '</div></div>';
  html += '<div class="card" style="flex:1;min-width:140px;padding:12px 16px;"><div class="card-title">Total Value</div><div class="card-count">$' + totalParsed.toLocaleString(undefined, { maximumFractionDigits: 0 }) + '</div></div>';
  Object.entries(bySource).forEach(function (kv) {
    html += '<div class="card" style="flex:1;min-width:140px;padding:12px 16px;"><div class="card-title">' + kv[0] + '</div><div class="card-count">' + kv[1] + '</div></div>';
  });
  html += '</div>';

  html += '<table class="data-table">' + sortableHeader(PARSED_COLUMNS, _sortKey, _sortDir, 'onReceiptsSort') + '<tbody>';

  var sorted = sortItems(_parsedReceipts, _sortKey, _sortDir, PARSED_COLUMNS);

  sorted.forEach(function (r, ri) {
    var rid = 'pr' + ri;

    // Find linked inventory items
    var linkedIdxs = [];
    if (r.source_hash && itemsByHash[r.source_hash]) linkedIdxs = itemsByHash[r.source_hash];
    else if (r.source_file && itemsBySourceFile[r.source_file]) linkedIdxs = itemsBySourceFile[r.source_file];

    var cells = '<td><strong>' + (r.vendor || '') + '</strong></td>' +
      '<td>' + statusChip(r.source_type || '') + '</td>' +
      '<td style="font-size:12px;">' + (r.po_number || r.order_number || '') + '</td>' +
      '<td>$' + (r.total || 0).toLocaleString(undefined, { minimumFractionDigits: 2 }) + '</td>' +
      '<td>' + formatDate(r.date) + '</td>' +
      '<td>' + (r.account_number || '') + '</td>' +
      '<td>' + (linkedIdxs.length || r.item_count || 0) + '</td>' +
      '<td style="font-size:12px;">' + (r.payment_method || '') + '</td>';

    html += '<tr class="expandable-row" onclick="toggleParsedReceipt(\'' + rid + '\')" data-rid="' + rid + '">' + cells + '</tr>';

    // Detail panel with linked items
    var d = '';
    d += '<div class="detail-meta" style="margin-bottom:12px;">';
    d += '<div class="detail-meta-item"><span class="detail-meta-label">Source File</span><span class="detail-meta-value" style="font-size:12px;">' + (r.source_file || '') + '</span></div>';
    if (r.tax) d += '<div class="detail-meta-item"><span class="detail-meta-label">Tax</span><span class="detail-meta-value">$' + r.tax.toFixed(2) + '</span></div>';
    if (r.shipping) d += '<div class="detail-meta-item"><span class="detail-meta-label">Shipping</span><span class="detail-meta-value">$' + r.shipping.toFixed(2) + '</span></div>';
    d += '<div class="detail-meta-item"><span class="detail-meta-label">Parsed</span><span class="detail-meta-value">' + formatDate((r.parsed_at || '').slice(0, 10)) + '</span></div>';
    d += '</div>';

    if (linkedIdxs.length === 0) {
      d += '<div style="color:var(--text-muted);font-size:13px;">No linked inventory items found for this receipt.</div>';
    } else {
      d += '<strong style="font-size:12px;text-transform:uppercase;color:var(--text-muted);">' + linkedIdxs.length + ' Items from this receipt</strong>';

      linkedIdxs.forEach(function (invIdx, vi) {
        var item = _invItems[invIdx];
        var vid = rid + 'i' + vi;

        d += '<div class="variant-row" onclick="event.stopPropagation(); toggleParsedItem(\'' + vid + '\')" style="cursor:pointer;padding:8px 12px;border:1px solid var(--border);border-radius:var(--radius);margin:6px 0;background:var(--surface);">';
        d += '<div style="display:flex;justify-content:space-between;align-items:center;">';
        d += '<div><strong>' + (item.name || '') + '</strong>';
        if (item.catalogue_number) d += ' <span style="color:var(--text-muted);font-size:12px;">Cat# ' + item.catalogue_number + '</span>';
        d += '</div>';
        d += '<div style="display:flex;gap:10px;align-items:center;font-size:13px;">';
        d += '<span>' + (item.category || '').replace(/_/g, ' ') + '</span>';
        if (item.unit_price != null) d += '<span>$' + item.unit_price.toFixed(2) + '</span>';
        d += '<span>Qty: ' + (item.quantity || 1) + '</span>';
        d += '</div></div>';

        // Expandable inline editor for this item
        d += '<div id="pi-detail-' + vid + '" style="display:none;margin-top:10px;padding-top:10px;border-top:1px solid var(--border);" onclick="event.stopPropagation();">';
        d += '<div style="display:grid;grid-template-columns:repeat(auto-fill,minmax(200px,1fr));gap:8px;margin-bottom:10px;">';
        d += '<div><label class="detail-meta-label">Category</label>' + parsedInlineSelect(invIdx, 'category', item.category, CATEGORY_OPTIONS) + '</div>';
        d += '<div><label class="detail-meta-label">Subcategory</label>' + parsedInlineText(invIdx, 'subcategory', item.subcategory, '') + '</div>';
        d += '<div><label class="detail-meta-label">Stock Status</label>' + parsedInlineSelect(invIdx, 'stock_status', item.stock_status, STOCK_OPTIONS) + '</div>';
        d += '<div><label class="detail-meta-label">Condition</label>' + parsedInlineSelect(invIdx, 'condition', item.condition, CONDITION_OPTIONS) + '</div>';
        d += '<div><label class="detail-meta-label">Account #</label>' + parsedInlineText(invIdx, 'account_number', item.account_number, '') + '</div>';
        d += '<div><label class="detail-meta-label">Project</label>' + parsedInlineText(invIdx, 'project_tag', item.project_tag, '') + '</div>';
        d += '</div>';
        d += '<div style="display:grid;grid-template-columns:1fr 1fr;gap:8px;margin-bottom:8px;">';
        d += '<div><label class="detail-meta-label">Name</label>' + parsedInlineText(invIdx, 'name', item.name, '') + '</div>';
        d += '<div><label class="detail-meta-label">Vendor</label>' + parsedInlineText(invIdx, 'vendor', item.vendor, '') + '</div>';
        d += '</div>';
        if (item.description) d += '<div style="font-size:12px;color:var(--text-muted);margin-bottom:6px;">' + item.description + '</div>';
        if (item.notes) d += '<div style="font-size:12px;color:var(--text-muted);">' + item.notes + '</div>';
        d += '</div>';
        d += '</div>';
      });
    }

    html += '<tr class="detail-row" id="pdetail-' + rid + '"><td colspan="8"><div class="detail-panel" onclick="event.stopPropagation();">' + d + '</div></td></tr>';
  });

  html += '</tbody></table>';
  content.innerHTML = html;
}

/* ---- Incoming (Firestore student submissions) ---- */

// Phase E pagination state for student submissions.
var INCOMING_PAGE_SIZE = 100;
var _incomingRows = [];
var _incomingLastDoc = null;
var _incomingHasMore = false;

async function renderIncoming() {
  var content = document.getElementById('content');

  if (typeof firebridge === 'undefined' || !firebridge.isReady()) {
    content.innerHTML = '<div class="empty-state"><p>Not connected to the website.</p><p style="margin-top:8px"><a href="/rm/pages/settings.html">Go to Settings</a> to sign in.</p></div>';
    return;
  }

  content.innerHTML = '<div class="empty-state">Loading student submissions&hellip;</div>';

  try {
    if (!_incomingRows.length) {
      var page = await firebridge.getPage('procurement', {
        orderField: 'createdAt', orderDir: 'desc', limit: INCOMING_PAGE_SIZE,
      });
      _incomingRows = page.rows;
      _incomingLastDoc = page.lastDoc;
      _incomingHasMore = page.hasMore;
    }
    var submissions = _incomingRows;

    if (submissions.length === 0) {
      content.innerHTML = '<div class="empty-state">No student submissions yet.</div>';
      return;
    }

    var INCOMING_COLUMNS = [
      { label: 'Submitted By', key: 'submitterName' },
      { label: 'Vendor', key: 'vendor' },
      { label: 'Project', key: 'project' },
      { label: 'Items', key: null },
      { label: 'Total', key: 'total', type: 'number' },
      { label: 'Date', key: 'date', type: 'date' },
      { label: 'Status', key: 'status' },
      { label: 'Actions', key: null },
    ];
    submissions = sortItems(submissions, _sortKey, _sortDir, INCOMING_COLUMNS);
    var html = '<table class="data-table">' +
      sortableHeader(INCOMING_COLUMNS, _sortKey, _sortDir, 'onReceiptsSort') + '<tbody>';

    submissions.forEach(function (s) {
      var itemCount = (s.items || []).length;
      html += '<tr>' +
        '<td><strong>' + (s.submitterName || '') + '</strong></td>' +
        '<td>' + (s.vendor || '') + (s.orderNumber ? '<br><small style="color:var(--text-muted)">#' + s.orderNumber + '</small>' : '') + '</td>' +
        '<td>' + (s.project || '') + '</td>' +
        '<td>' + itemCount + ' item' + (itemCount !== 1 ? 's' : '') + '</td>' +
        '<td>$' + (s.total || 0).toFixed(2) + '</td>' +
        '<td>' + formatDate(s.date) + '</td>' +
        '<td>' + statusChip(s.status) + '</td>' +
        '<td class="row-actions">';

      if (s.status === 'submitted') {
        html += '<button onclick="acceptSubmission(\'' + s.id + '\')">Accept</button>';
      }
      if (s.attachmentUrl) {
        html += '<a href="' + s.attachmentUrl + '" target="_blank" style="font-size:13px;color:var(--primary);">PDF</a>';
      }
      html += '</td></tr>';

      if (s.items && s.items.length) {
        html += '<tr><td colspan="8" style="padding:4px 14px 10px;background:#f9fafb;font-size:12px;color:var(--text-muted);">';
        s.items.forEach(function (item) {
          html += item.description + (item.catalogueNumber ? ' (Cat# ' + item.catalogueNumber + ')' : '') + ' &times;' + item.quantity + ' @ $' + (item.unitPrice || 0).toFixed(2) + ' &nbsp;&nbsp;';
        });
        html += '</td></tr>';
      }
    });

    html += '</tbody></table>';
    if (_incomingHasMore) {
      html += '<div style="text-align:center;margin:16px 0;">' +
        '<button id="incoming-load-more" class="btn">Load more (showing ' +
        _incomingRows.length + ' most recent)</button></div>';
    }
    content.innerHTML = html;
    var loadMore = document.getElementById('incoming-load-more');
    if (loadMore) loadMore.onclick = _onLoadMoreIncoming;
  } catch (err) {
    content.innerHTML = '<div class="empty-state" style="color:var(--red);">Error: ' + err.message + '</div>';
  }
}

async function _onLoadMoreIncoming() {
  if (!_incomingLastDoc) return;
  var btn = document.getElementById('incoming-load-more');
  if (btn) { btn.disabled = true; btn.textContent = 'Loading…'; }
  try {
    var page = await firebridge.getPage('procurement', {
      orderField: 'createdAt', orderDir: 'desc',
      limit: INCOMING_PAGE_SIZE, startAfterDoc: _incomingLastDoc,
    });
    _incomingRows = _incomingRows.concat(page.rows);
    _incomingLastDoc = page.lastDoc;
    _incomingHasMore = page.hasMore;
    renderIncoming();
  } catch (err) {
    if (btn) { btn.disabled = false; btn.textContent = 'Load more (failed — retry)'; }
    console.error('[receipts] incoming load-more failed:', err);
  }
}

/* ---- Accept a Firestore submission ---- */

window.acceptSubmission = async function (docId) {
  if (!confirmAction('Accept this submission into your local orders?')) return;

  var sub = await firebridge.getDoc('procurement', docId);
  if (!sub) { alert('Submission not found.'); return; }

  var data = await api.load(MANUAL_PATH);
  var newReceipt = {
    id: slugify(sub.vendor + '-' + (sub.date || 'undated')),
    vendor: sub.vendor || '',
    order_number: sub.orderNumber || '',
    description: (sub.items || []).map(function (i) { return i.description; }).join(', '),
    amount: sub.total || 0,
    date: sub.date || '',
    source_type: sub.sourceType || '',
    account_number: sub.fundingAccount || '',
    project_tag: sub.project || '',
    funding_source: sub.fundingAccount || '',
    category: (sub.category || 'consumable').toLowerCase(),
    status: 'approved',
    items: sub.items || [],
    notes: 'Submitted by ' + (sub.submitterName || 'student') + '. ' + (sub.notes || ''),
  };
  data.receipts.push(newReceipt);
  await api.save(MANUAL_PATH, data);

  // Also create inventory items
  var invData = await api.load('inventory/items.json');
  (sub.items || []).forEach(function (item) {
    invData.items.push({
      id: slugify((sub.vendor || '') + '-' + (sub.date || '') + '-' + (item.description || '')),
      name: item.description || '',
      description: item.description || '',
      vendor: sub.vendor || '',
      vendor_normalized: slugify(sub.vendor || ''),
      catalogue_number: item.catalogueNumber || '',
      quantity: item.quantity || 1,
      unit_price: item.unitPrice || 0,
      extended_price: (item.unitPrice || 0) * (item.quantity || 1),
      date_acquired: sub.date || '',
      category: (sub.category || 'consumable').toLowerCase(),
      subcategory: '',
      is_chemical: false,
      is_consumable: true,
      condition: 'active',
      stock_status: 'full',
      funding_source: sub.fundingAccount || '',
      account_number: sub.fundingAccount || '',
      account_name: '',
      project_tag: sub.project || '',
      tags: [],
      locations: [],
      price_history: [{ date: sub.date || '', unit_price: item.unitPrice || 0, vendor: sub.vendor || '', receipt_id: newReceipt.id }],
      receipt_ref: { source_file: '', source_type: 'student_submission', source_hash: '', po_number: '', order_number: sub.orderNumber || '', receipt_total: sub.total || 0, receipt_tax: null, receipt_shipping: null, receipt_date: sub.date || '', receipt_vendor: sub.vendor || '' },
      reorder: { url: '', vendor: sub.vendor || '', catalogue_number: item.catalogueNumber || '', last_price: item.unitPrice || 0, lead_time_days: null, notes: '' },
      safety: null,
      parse_confidence: 0,
      parsed_at: '',
      manual_edit: true,
      notes: '',
    });
  });
  await api.save('inventory/items.json', invData);

  await firebridge.updateDoc('procurement', docId, { status: 'reviewed' });
  loadAndRender();
};

/* ---- Budget Analysis (combined manual + parsed) ---- */

async function renderBudgetAnalysis() {
  var content = document.getElementById('content');

  // Combine manual receipts + parsed inventory items for full picture
  var invData = await api.load('inventory/items.json');
  var allItems = invData.items || [];

  var records = [];
  // Manual receipts
  _manualReceipts.forEach(function (r) {
    if (r.amount) records.push({ amount: r.amount, category: r.category || 'other', account: r.account_number || r.funding_source || 'unassigned', project: r.project_tag || 'untagged', date: r.date || '', source: 'manual' });
  });
  // Parsed inventory items
  allItems.forEach(function (i) {
    var amt = i.extended_price || i.unit_price || 0;
    if (amt > 0) records.push({ amount: amt, category: i.category || 'other', account: i.account_number || 'unassigned', project: i.project_tag || 'untagged', date: i.date_acquired || '', source: 'parsed' });
  });

  if (records.length === 0) {
    content.innerHTML = '<div class="empty-state">No spending data for analysis.</div>';
    return;
  }

  var byProject = {};
  var byCategory = {};
  var byAccount = {};
  var grandTotal = 0;

  records.forEach(function (r) {
    grandTotal += r.amount;
    var proj = r.project;
    var cat = r.category;
    var acct = r.account;

    if (!byProject[proj]) byProject[proj] = { total: 0, byCategory: {} };
    byProject[proj].total += r.amount;
    byProject[proj].byCategory[cat] = (byProject[proj].byCategory[cat] || 0) + r.amount;

    byCategory[cat] = (byCategory[cat] || 0) + r.amount;
    byAccount[acct] = (byAccount[acct] || 0) + r.amount;
  });

  var html = '';
  html += '<div style="display:flex;gap:12px;margin-bottom:16px;flex-wrap:wrap;">';
  html += '<div class="card" style="flex:1;min-width:160px;padding:12px 16px;"><div class="card-title">Total Tracked</div><div class="card-count">$' + grandTotal.toLocaleString(undefined, { maximumFractionDigits: 0 }) + '</div><div class="card-body">' + records.length + ' records</div></div>';
  html += '<div class="card" style="flex:1;min-width:160px;padding:12px 16px;"><div class="card-title">Manual Orders</div><div class="card-count">' + _manualReceipts.length + '</div></div>';
  html += '<div class="card" style="flex:1;min-width:160px;padding:12px 16px;"><div class="card-title">Parsed Items</div><div class="card-count">' + allItems.length + '</div></div>';
  html += '</div>';

  // By Account
  var acctRows = Object.entries(byAccount).map(function (kv) {
    return { account: kv[0], total: kv[1], pct: grandTotal > 0 ? (kv[1] / grandTotal) * 100 : 0 };
  });
  acctRows = sortItems(acctRows, _sortKey, _sortDir, BUDGET_ACCT_COLUMNS);
  if (!_sortKey) acctRows.sort(function (a, b) { return b.total - a.total; });
  html += '<h2 style="font-size:16px;margin-bottom:12px;">Spending by Account</h2>';
  html += '<table class="data-table" style="margin-bottom:24px;">' + sortableHeader(BUDGET_ACCT_COLUMNS, _sortKey, _sortDir, 'onReceiptsSort') + '<tbody>';
  acctRows.forEach(function (row) {
    html += '<tr><td><strong>' + row.account + '</strong></td><td>$' + row.total.toLocaleString(undefined, { minimumFractionDigits: 2 }) + '</td><td>' + row.pct.toFixed(1) + '%</td></tr>';
  });
  html += '</tbody></table>';

  // By Category
  var catRows = Object.entries(byCategory).map(function (kv) {
    return { category: kv[0], total: kv[1], pct: grandTotal > 0 ? (kv[1] / grandTotal) * 100 : 0 };
  });
  catRows = sortItems(catRows, _sortKey, _sortDir, BUDGET_CAT_COLUMNS);
  if (!_sortKey) catRows.sort(function (a, b) { return b.total - a.total; });
  html += '<h2 style="font-size:16px;margin-bottom:12px;">Spending by Category</h2>';
  html += '<table class="data-table" style="margin-bottom:24px;">' + sortableHeader(BUDGET_CAT_COLUMNS, _sortKey, _sortDir, 'onReceiptsSort') + '<tbody>';
  catRows.forEach(function (row) {
    html += '<tr><td><strong>' + row.category.replace(/_/g, ' ') + '</strong></td><td>$' + row.total.toLocaleString(undefined, { minimumFractionDigits: 2 }) + '</td><td>' + row.pct.toFixed(1) + '%</td></tr>';
  });
  html += '</tbody></table>';

  // By Project
  var projRows = Object.entries(byProject).map(function (kv) {
    return { project: kv[0], total: kv[1].total, byCategory: kv[1].byCategory };
  });
  projRows = sortItems(projRows, _sortKey, _sortDir, BUDGET_PROJ_COLUMNS);
  if (!_sortKey) projRows.sort(function (a, b) { return b.total - a.total; });
  html += '<h2 style="font-size:16px;margin-bottom:12px;">Spending by Project</h2>';
  html += '<table class="data-table" style="margin-bottom:24px;">' + sortableHeader(BUDGET_PROJ_COLUMNS, _sortKey, _sortDir, 'onReceiptsSort') + '<tbody>';
  projRows.forEach(function (row) {
    var breakdown = Object.entries(row.byCategory).sort(function (a, b) { return b[1] - a[1]; }).slice(0, 4).map(function (c) { return c[0].replace(/_/g, ' ') + ': $' + c[1].toFixed(0); }).join(', ');
    html += '<tr><td><strong>' + row.project + '</strong></td><td>$' + row.total.toLocaleString(undefined, { minimumFractionDigits: 2 }) + '</td><td style="font-size:12px;color:var(--text-muted);">' + breakdown + '</td></tr>';
  });
  html += '</tbody></table>';

  html += '<div style="display:flex;gap:8px;"><button class="btn" id="export-budget-btn">Copy Budget Table</button>';
  html += '<a href="/rm/pages/analytics.html" class="btn btn-primary">View Charts &rarr;</a></div>';
  content.innerHTML = html;

  document.getElementById('export-budget-btn').onclick = function () {
    var text = 'Budget Analysis — McGhee Lab\n' + '='.repeat(50) + '\n';
    text += 'Total: $' + grandTotal.toFixed(2) + ' (' + records.length + ' records)\n\n';
    text += 'BY ACCOUNT\n';
    Object.entries(byAccount).sort(function (a, b) { return b[1] - a[1]; }).forEach(function (kv) { text += '  ' + kv[0] + ': $' + kv[1].toFixed(2) + '\n'; });
    text += '\nBY CATEGORY\n';
    Object.entries(byCategory).sort(function (a, b) { return b[1] - a[1]; }).forEach(function (kv) { text += '  ' + kv[0] + ': $' + kv[1].toFixed(2) + '\n'; });
    text += '\nBY PROJECT\n';
    Object.entries(byProject).sort(function (a, b) { return b[1].total - a[1].total; }).forEach(function (kv) { text += '  ' + kv[0] + ': $' + kv[1].total.toFixed(2) + '\n'; });
    navigator.clipboard.writeText(text).then(function () {
      document.getElementById('export-budget-btn').textContent = 'Copied!';
      setTimeout(function () { document.getElementById('export-budget-btn').textContent = 'Copy Budget Table'; }, 2000);
    });
  };
}

/* ---- CRUD ---- */

window.editItem = function (index) {
  var item = _manualReceipts[index];
  if (!item) return;
  openForm({
    title: 'Edit Order',
    fields: RECEIPT_FIELDS,
    values: item,
    onSave: function (vals) {
      var oldId = item.id;
      Object.assign(item, vals);
      item.id = slugify(vals.vendor + '-' + (vals.date || 'undated'));
      render();
      // If id changed, delete old + write new; otherwise just write new.
      if (oldId && oldId !== item.id) {
        _deleteReceiptsManualReceipt(oldId).catch(_receiptsToastError('delete old receipt'));
      }
      _saveReceiptsManualReceipt(item).catch(_receiptsToastError('edit order'));
    },
  });
};

window.deleteItem = function (index) {
  if (!confirmAction('Remove this order?')) return;
  var item = _manualReceipts[index];
  if (!item) return;
  var id = item.id;
  _manualReceipts.splice(index, 1);
  render();
  if (id) _deleteReceiptsManualReceipt(id).catch(_receiptsToastError('delete order'));
};

document.getElementById('add-item').onclick = function () {
  openForm({
    title: 'Add Order',
    fields: RECEIPT_FIELDS,
    onSave: function (vals) {
      vals.id = slugify(vals.vendor + '-' + (vals.date || 'undated'));
      _manualReceipts.push(vals);
      render();
      _saveReceiptsManualReceipt(vals).catch(_receiptsToastError('add order'));
    },
  });
};

/* ---- Upload Receipt (parse PDF via Claude API) ---- */

document.getElementById('upload-receipt').onclick = function () {
  api.load('finance/projects.json').then(function (projData) {
    var projects = projData.projects || [];
    var overlay = document.createElement('div');
    overlay.className = 'modal-overlay';
    var modal = document.createElement('div');
    modal.className = 'modal';

    var acctOptions = '<option value="">— select account —</option>';
    projects.forEach(function (p) {
      acctOptions += '<option value="' + p.account_number + '">' + p.name + ' (' + p.account_number + ')</option>';
    });

    modal.innerHTML = '<div class="modal-title">Upload & Parse Receipt</div>' +
      '<div class="form-group"><label>PDF Receipt(s)</label>' +
      '<input type="file" id="rcpt-files" multiple accept=".pdf" style="font-size:14px;">' +
      '<div style="font-size:12px;color:var(--text-muted);margin-top:4px;">Select one or more PDF receipts to parse with Claude AI</div></div>' +
      '<div class="form-group"><label>Account</label><select id="rcpt-account" style="width:100%;padding:6px;border:1px solid var(--border);border-radius:var(--radius);">' + acctOptions + '</select></div>' +
      '<div class="form-group"><label>Source Type</label><select id="rcpt-source" style="width:100%;padding:6px;border:1px solid var(--border);border-radius:var(--radius);">' +
      '<option value="pcard">PCard</option><option value="buyways">Buyways PO</option><option value="amazon_business">Amazon Business</option><option value="ilab">iLab</option><option value="vendor_po">Vendor PO</option></select></div>' +
      '<div id="rcpt-status" style="display:none;margin-bottom:12px;padding:10px;border-radius:var(--radius);font-size:13px;"></div>' +
      '<div class="modal-actions">' +
      '<button class="btn" id="rcpt-cancel">Cancel</button>' +
      '<button class="btn btn-primary" id="rcpt-submit">Parse & Add</button></div>';

    overlay.appendChild(modal);
    document.body.appendChild(overlay);
    safeCloseOnBackdrop(overlay, modal, function () { if (overlay.parentNode) overlay.remove(); });

    document.getElementById('rcpt-cancel').onclick = function () { overlay.remove(); };

    document.getElementById('rcpt-submit').onclick = async function () {
      var fileInput = document.getElementById('rcpt-files');
      var accountNum = document.getElementById('rcpt-account').value;
      var sourceType = document.getElementById('rcpt-source').value;
      var statusEl = document.getElementById('rcpt-status');
      var submitBtn = document.getElementById('rcpt-submit');

      if (!fileInput.files || fileInput.files.length === 0) {
        statusEl.style.display = 'block';
        statusEl.style.background = 'var(--red-bg)';
        statusEl.textContent = 'Please select at least one PDF.';
        return;
      }

      var formData = new FormData();
      formData.append('event_name', 'Receipt Upload');
      formData.append('source_type', sourceType);
      for (var i = 0; i < fileInput.files.length; i++) {
        formData.append('files', fileInput.files[i]);
      }

      submitBtn.disabled = true;
      submitBtn.textContent = 'Parsing ' + fileInput.files.length + ' file(s)...';
      statusEl.style.display = 'block';
      statusEl.style.background = 'var(--amber-bg)';
      statusEl.textContent = 'Extracting text and sending to Claude API...';

      try {
        var resp = await fetch('/api/parse-receipts', { method: 'POST', body: formData });
        var result = await resp.json();

        if (!result.ok) {
          statusEl.style.background = 'var(--red-bg)';
          statusEl.textContent = 'Error: ' + result.error;
          submitBtn.disabled = false;
          submitBtn.textContent = 'Parse & Add';
          return;
        }

        var proj = projects.find(function (p) { return p.account_number === accountNum; });
        var projectTag = proj ? proj.id : '';

        var receiptData = await api.load(MANUAL_PATH);
        var invData = await api.load('inventory/items.json');
        var metaData = await api.load(PARSED_PATH);
        var addedOrders = 0;
        var addedItems = 0;

        result.results.forEach(function (r) {
          var parsed = r.parsed;
          var receipt = parsed.receipt || {};
          var lineItems = parsed.items || [];
          var vendor = receipt.vendor || r.filename.replace('.pdf', '');
          var receiptDate = receipt.date || today();
          var receiptId = slugify(vendor + '-' + receiptDate);

          receiptData.receipts.push({
            id: receiptId, vendor: vendor,
            order_number: receipt.po_number || receipt.order_number || '',
            description: lineItems.map(function (it) { return it.name || it.description; }).join(', '),
            amount: receipt.total || lineItems.reduce(function (s, it) { return s + (it.extended_price || it.unit_price || 0); }, 0),
            date: receiptDate, source_type: sourceType,
            account_number: accountNum || receipt.account_number || '',
            project_tag: projectTag, funding_source: accountNum,
            category: (lineItems.length ? (lineItems[0].category || 'other') : 'other').toLowerCase(),
            status: 'submitted',
            notes: 'Parsed from uploaded PDF: ' + r.filename,
          });
          addedOrders++;

          metaData.receipts_meta.push({
            id: receiptId + '-meta', source_file: 'uploaded/' + r.filename,
            source_type: sourceType, source_hash: r.file_hash,
            vendor: vendor, date: receiptDate,
            po_number: receipt.po_number || '', order_number: receipt.order_number || '',
            account_number: accountNum || '', total: receipt.total || 0,
            tax: receipt.tax || null, shipping: receipt.shipping || null,
            payment_method: receipt.payment_method || sourceType,
            item_count: lineItems.length, parsed_at: new Date().toISOString(),
          });

          lineItems.forEach(function (item) {
            var itemId = slugify(vendor + '-' + receiptDate + '-' + (item.name || ''));
            var itemCat = (item.category || '').toLowerCase();
            var itemSub = (item.subcategory || '').toLowerCase().replace(/\s+/g, '_');
            var isCons = ['consumable','research_reagents','research_chem','research_cells','research_gas','research_gels','research_analysis'].indexOf(itemCat) >= 0;
            invData.items.push({
              id: itemId, name: item.name || '', description: item.description || '',
              vendor: vendor, vendor_normalized: slugify(vendor),
              catalogue_number: item.catalogue_number || '',
              quantity: item.quantity || 1, unit_price: item.unit_price || null,
              extended_price: item.extended_price || null, date_acquired: receiptDate,
              category: itemCat || 'other', subcategory: itemSub,
              is_chemical: false, is_consumable: isCons || (item.is_consumable || false),
              condition: 'active', stock_status: isCons ? 'full' : 'n/a',
              funding_source: accountNum, account_number: accountNum,
              account_name: proj ? proj.name : '', project_tag: projectTag,
              tags: [], locations: [],
              price_history: item.unit_price ? [{ date: receiptDate, unit_price: item.unit_price, vendor: vendor, receipt_id: receiptId }] : [],
              receipt_ref: { source_file: 'uploaded/' + r.filename, source_type: sourceType, source_hash: r.file_hash, po_number: receipt.po_number || '', order_number: receipt.order_number || '', receipt_total: receipt.total, receipt_tax: receipt.tax, receipt_shipping: receipt.shipping, receipt_date: receiptDate, receipt_vendor: vendor },
              reorder: { url: '', vendor: vendor, catalogue_number: item.catalogue_number || '', last_price: item.unit_price, lead_time_days: null, notes: '' },
              safety: null, product_group: '', product_group_name: '',
              parse_confidence: 0.8, parsed_at: new Date().toISOString(),
              manual_edit: false, notes: item.notes || '',
            });
            addedItems++;
          });
        });

        await api.save(MANUAL_PATH, receiptData);
        await api.save('inventory/items.json', invData);
        await api.save(PARSED_PATH, metaData);

        // Check for new subcategories proposed by Claude
        var newSubs = [];
        result.results.forEach(function (r) {
          (r.parsed.items || []).forEach(function (item) {
            if (item.new_subcategory_justification) {
              newSubs.push({ category: item.category, subcategory: item.subcategory, justification: item.new_subcategory_justification });
            }
          });
        });

        // Rebuild taxonomy to include new items
        try { await fetch('/api/rebuild-taxonomy', { method: 'POST' }); } catch (e) {}

        var newSubMsg = '';
        if (newSubs.length) {
          newSubMsg = '<br><strong>New subcategories proposed:</strong><ul style="margin:4px 0;font-size:12px;">';
          newSubs.forEach(function (ns) {
            newSubMsg += '<li><strong>' + ns.category + '/' + ns.subcategory + '</strong>: ' + ns.justification + '</li>';
          });
          newSubMsg += '</ul>';
        }

        statusEl.style.background = 'var(--green-bg)';
        statusEl.innerHTML = '<strong>Done!</strong> Added ' + addedOrders + ' orders + ' + addedItems + ' inventory items' +
          (result.error_count ? ', ' + result.error_count + ' errors' : '') + newSubMsg;

        submitBtn.textContent = 'Close';
        submitBtn.disabled = false;
        submitBtn.onclick = function () { overlay.remove(); loadAndRender(); };
      } catch (err) {
        statusEl.style.background = 'var(--red-bg)';
        statusEl.textContent = 'Error: ' + err.message;
        submitBtn.disabled = false;
        submitBtn.textContent = 'Parse & Add';
      }
    };
  });
};

window.onReceiptsSort = function (key) {
  if (_sortKey === key) { _sortDir = _sortDir === 'asc' ? 'desc' : 'asc'; }
  else { _sortKey = key; _sortDir = 'asc'; }
  render();
};

/* ---- Live tab-to-tab sync ---- */
var _receiptsLive = { suppressUntil: 0, savePending: false, refreshTimer: null, unsubs: [] };
var _RECEIPTS_PATHS = [MANUAL_PATH, INV_PATH];
function _receiptsWrapSaves() {
  if (_receiptsWrapSaves._wrapped) return;
  _receiptsWrapSaves._wrapped = true;
  var origSave = api.save.bind(api);
  api.save = async function (path, data) {
    var isOne = _RECEIPTS_PATHS.indexOf(path) >= 0;
    if (isOne) { _receiptsLive.savePending = true; _receiptsLive.suppressUntil = Date.now() + 2500; }
    try { return await origSave(path, data); }
    finally { if (isOne) _receiptsLive.savePending = false; }
  };
}
function _receiptsScheduleRefresh() {
  if (_receiptsLive.refreshTimer) return;
  _receiptsLive.refreshTimer = setTimeout(function () {
    _receiptsLive.refreshTimer = null;
    var y = window.scrollY;
    loadAndRender().catch(function (err) { console.warn('[receipts] refresh failed:', err); })
      .finally(function () { window.scrollTo({ top: y, left: 0, behavior: 'instant' }); });
  }, 200);
}
function _receiptsAttachLiveSync() {
  if (typeof api.subscribe !== 'function' || _receiptsLive.unsubs.length) return;
  for (var i = 0; i < _RECEIPTS_PATHS.length; i++) {
    var path = _RECEIPTS_PATHS[i];
    try {
      (function (p) {
        var firstFireConsumed = false;
        var unsub = api.subscribe(p, function () {
          if (Date.now() < _receiptsLive.suppressUntil) return;
          if (_receiptsLive.savePending) return;
          if (!firstFireConsumed) { firstFireConsumed = true; return; }
          _receiptsScheduleRefresh();
        });
        _receiptsLive.unsubs.push(unsub);
      })(path);
    } catch (err) { console.warn('[receipts] live sync attach failed:', err.message); }
  }
}

(async function () {
  if (typeof firebridge !== 'undefined' && firebridge.whenAuthResolved) await firebridge.whenAuthResolved();
  _receiptsWrapSaves();
  await loadAndRender();
  // No live-sync attach: receipts is admin-edit, single-tab in practice.
  // _receiptsAttachLiveSync(); // disabled per data-flow plan
})();
