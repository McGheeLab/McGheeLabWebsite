/* purchase-requests.js — review student purchase requests from Firestore,
   create inventory items + receipts on receive */

(function () {
  var content = document.getElementById('content');
  var tabsEl = document.getElementById('tabs');
  var activeTab = 'pending';
  var _sortKey = null;
  var _sortDir = 'asc';
  // Phase E pagination state — most-recent N requests per page; tab filter
  // (pending vs resolved) applied client-side post-fetch.
  var PR_PAGE_SIZE = 100;
  var _prRows = [];
  var _prLastDoc = null;
  var _prHasMore = false;
  var PR_COLUMNS = [
    { label: 'Requester', key: 'requesterName' },
    { label: 'Item', key: 'itemDescription' },
    { label: 'Est. Cost', key: 'estimatedCost', type: 'number' },
    { label: 'Justification', key: 'justification' },
    { label: 'Urgency', key: 'urgency' },
    { label: 'Category', key: 'category' },
    { label: 'Status', key: 'status' },
    { label: 'Actions', key: null },
  ];

  var CATEGORIES = [
    'equipment', 'infrastructure', 'consumable', 'computer', 'lab_furniture',
    'office', 'research_reagents', 'research_chem', 'research_cells',
    'research_gels', 'research_gas', 'research_analysis', 'software', 'other'
  ];

  function showNotConnected() {
    content.innerHTML =
      '<div class="empty-state">' +
        '<p>Not connected to the website.</p>' +
        '<p style="margin-top:8px"><a href="/rm/pages/settings.html">Go to Settings</a> to sign in.</p>' +
      '</div>';
  }

  function urgencyChip(u) {
    var map = { urgent: 'chip-red', needed_soon: 'chip-amber', routine: 'chip-muted' };
    return '<span class="chip ' + (map[u] || 'chip-muted') + '">' + (u || 'routine').replace(/_/g, ' ') + '</span>';
  }

  async function loadAndRender() {
    if (typeof firebridge === 'undefined' || !firebridge.isReady()) {
      showNotConnected();
      return;
    }

    tabsEl.innerHTML = '';
    [{ key: 'pending', label: 'Pending' }, { key: 'resolved', label: 'Resolved' }].forEach(function (t) {
      var btn = document.createElement('button');
      btn.className = 'tab-btn' + (activeTab === t.key ? ' active' : '');
      btn.textContent = t.label;
      btn.onclick = function () {
        activeTab = t.key; _sortKey = null; _sortDir = 'asc';
        _prRows = []; _prLastDoc = null; _prHasMore = false;
        loadAndRender();
      };
      tabsEl.appendChild(btn);
    });

    content.innerHTML = '<div class="empty-state">Loading requests&hellip;</div>';

    try {
      if (!_prRows.length) {
        var page = await firebridge.getPage('purchaseRequests', {
          orderField: 'createdAt', orderDir: 'desc', limit: PR_PAGE_SIZE,
        });
        _prRows = page.rows;
        _prLastDoc = page.lastDoc;
        _prHasMore = page.hasMore;
      }
      var all = _prRows;

      var filtered;
      if (activeTab === 'pending') {
        filtered = all.filter(function (r) { return r.status === 'requested'; });
      } else {
        filtered = all.filter(function (r) { return r.status !== 'requested'; });
      }

      if (filtered.length === 0) {
        content.innerHTML = '<div class="empty-state">No ' + activeTab + ' requests.</div>';
        return;
      }

      filtered = sortItems(filtered, _sortKey, _sortDir, PR_COLUMNS);
      var html = '<table class="data-table">' +
        sortableHeader(PR_COLUMNS, _sortKey, _sortDir, 'onPRSort') + '<tbody>';

      filtered.forEach(function (r) {
        html += '<tr>' +
          '<td><strong>' + (r.requesterName || '') + '</strong></td>' +
          '<td>' + (r.itemDescription || '') + (r.vendor ? '<br><small style="color:var(--text-muted);">Vendor: ' + r.vendor + '</small>' : '') +
          (r.catalogueNumber ? '<br><small style="color:var(--text-muted);">Cat# ' + r.catalogueNumber + '</small>' : '') + '</td>' +
          '<td>' + (r.estimatedCost ? '$' + r.estimatedCost.toFixed(2) : '') + '</td>' +
          '<td style="font-size:13px;max-width:200px;">' + (r.justification || '') + '</td>' +
          '<td>' + urgencyChip(r.urgency) + '</td>' +
          '<td>' + ((r.category || '').replace(/_/g, ' ') || '') + '</td>' +
          '<td>' + statusChip(r.status) + '</td>' +
          '<td class="row-actions">';

        if (r.status === 'requested') {
          html += '<button onclick="approveRequest(\'' + r.id + '\')">Approve</button>';
          html += '<button onclick="denyRequest(\'' + r.id + '\')">Deny</button>';
        }
        if (r.status === 'approved') {
          html += '<button onclick="markOrdered(\'' + r.id + '\')">Ordered</button>';
        }
        if (r.status === 'ordered') {
          html += '<button onclick="markReceived(\'' + r.id + '\')">Received</button>';
        }
        html += '</td></tr>';

        if (r.piNotes) {
          html += '<tr><td colspan="8" style="padding:4px 14px 10px;background:#f9fafb;font-size:12px;color:var(--text-muted);"><strong>PI notes:</strong> ' + r.piNotes + '</td></tr>';
        }
      });

      html += '</tbody></table>';
      if (_prHasMore) {
        html += '<div style="text-align:center;margin:16px 0;">' +
          '<button id="pr-load-more" class="btn">Load more (showing ' +
          _prRows.length + ' most recent)</button></div>';
      }
      content.innerHTML = html;
      var loadMore = document.getElementById('pr-load-more');
      if (loadMore) loadMore.onclick = _onLoadMorePR;
    } catch (err) {
      content.innerHTML = '<div class="empty-state" style="color:var(--red);">Error: ' + err.message + '</div>';
    }
  }

  async function _onLoadMorePR() {
    if (!_prLastDoc) return;
    var btn = document.getElementById('pr-load-more');
    if (btn) { btn.disabled = true; btn.textContent = 'Loading…'; }
    try {
      var page = await firebridge.getPage('purchaseRequests', {
        orderField: 'createdAt', orderDir: 'desc',
        limit: PR_PAGE_SIZE, startAfterDoc: _prLastDoc,
      });
      _prRows = _prRows.concat(page.rows);
      _prLastDoc = page.lastDoc;
      _prHasMore = page.hasMore;
      loadAndRender();
    } catch (err) {
      if (btn) { btn.disabled = false; btn.textContent = 'Load more (failed — retry)'; }
      console.error('[purchase-requests] load more failed:', err);
    }
  }

  async function updateStatus(docId, status, askNotes) {
    var piNotes = '';
    if (askNotes) {
      piNotes = prompt('Add a note (optional):') || '';
    }
    var update = { status: status };
    if (piNotes) update.piNotes = piNotes;
    await firebridge.updateDoc('purchaseRequests', docId, update);
    loadAndRender();
  }

  window.onPRSort = function (key) {
    if (_sortKey === key) { _sortDir = _sortDir === 'asc' ? 'desc' : 'asc'; }
    else { _sortKey = key; _sortDir = 'asc'; }
    loadAndRender();
  };

  window.approveRequest = function (id) { updateStatus(id, 'approved', true); };
  window.denyRequest = function (id) { updateStatus(id, 'denied', true); };
  window.markOrdered = function (id) { updateStatus(id, 'ordered', false); };

  window.markReceived = async function (id) {
    await updateStatus(id, 'received', false);

    var req = await firebridge.getDoc('purchaseRequests', id);
    if (!req) return;

    if (!confirmAction('Create inventory item + receipt entry for this purchase?')) return;

    var vendor = req.vendor || 'Unknown';
    var desc = req.itemDescription || '';
    var cost = req.estimatedCost || 0;
    var cat = (req.category || 'consumable').toLowerCase();
    if (CATEGORIES.indexOf(cat) === -1) cat = 'consumable';
    var dateStr = today();
    var itemId = slugify(vendor + '-' + dateStr + '-' + desc);

    // 1. Create receipt entry
    var receiptData = await api.load('finance/receipts.json');
    receiptData.receipts.push({
      id: itemId,
      vendor: vendor,
      order_number: '',
      description: desc,
      amount: cost,
      date: dateStr,
      source_type: '',
      account_number: req.fundingAccount || '',
      project_tag: req.project || '',
      funding_source: req.fundingAccount || '',
      category: cat,
      status: 'needs_receipt',
      notes: 'From purchase request by ' + (req.requesterName || 'student') + '. ' + (req.justification || ''),
    });
    await api.save('finance/receipts.json', receiptData);

    // 2. Create inventory item
    var invData = await api.load('inventory/items.json');
    var isConsumable = ['consumable', 'research_reagents', 'research_chem', 'research_cells',
      'research_gas', 'research_gels', 'research_analysis'].indexOf(cat) >= 0;
    invData.items.push({
      id: itemId,
      name: desc,
      description: desc,
      vendor: vendor,
      vendor_normalized: slugify(vendor),
      catalogue_number: req.catalogueNumber || '',
      quantity: req.quantity || 1,
      unit_price: cost,
      extended_price: cost * (req.quantity || 1),
      date_acquired: dateStr,
      category: cat,
      subcategory: '',
      is_chemical: false,
      is_consumable: isConsumable,
      condition: 'active',
      stock_status: isConsumable ? 'full' : 'n/a',
      funding_source: req.fundingAccount || '',
      account_number: req.fundingAccount || '',
      account_name: '',
      project_tag: req.project || '',
      tags: [],
      locations: [],
      price_history: [{ date: dateStr, unit_price: cost, vendor: vendor, receipt_id: itemId }],
      receipt_ref: { source_file: '', source_type: 'purchase_request', source_hash: '', po_number: '', order_number: '', receipt_total: cost, receipt_tax: null, receipt_shipping: null, receipt_date: dateStr, receipt_vendor: vendor },
      reorder: { url: req.url || '', vendor: vendor, catalogue_number: req.catalogueNumber || '', last_price: cost, lead_time_days: null, notes: '' },
      safety: null,
      parse_confidence: 0,
      parsed_at: '',
      manual_edit: true,
      notes: 'Requested by ' + (req.requesterName || 'student'),
    });
    await api.save('inventory/items.json', invData);
  };

  if (typeof firebridge !== 'undefined') {
    firebridge.onAuth(function () { loadAndRender(); });
  } else {
    document.addEventListener('DOMContentLoaded', function () { showNotConnected(); });
  }
})();
