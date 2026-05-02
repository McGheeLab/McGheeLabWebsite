/* budget-model.js — spending analysis for proposal budget justifications
   Pulls from both manual receipts AND parsed inventory for complete picture.

   Tabs:
   1. Spending Summary — by category with account filter
   2. Item Lookup — search across all inventory items
   3. Burn Rate — monthly/annual projections
*/

(function () {
  var content = document.getElementById('content');
  var tabsEl = document.getElementById('tabs');
  var projectFilter = document.getElementById('project-filter');
  var exportBtn = document.getElementById('export-btn');
  var activeTab = 'summary';
  var _allItems = [];
  var _receipts = [];
  var _sortKey = null;
  var _sortDir = 'asc';
  var BM_ACCT_COLUMNS = [
    { label: 'Account', key: 'account' },
    { label: 'Amount', key: 'amount', type: 'number' },
    { label: '%', key: 'pct', type: 'number' },
  ];
  var BM_CAT_COLUMNS = [
    { label: 'Category', key: 'category' },
    { label: 'Amount', key: 'amount', type: 'number' },
    { label: '%', key: 'pct', type: 'number' },
    { label: 'Items', key: 'count', type: 'number' },
  ];
  var BM_ITEM_COLUMNS = [
    { label: 'Description', key: 'description' },
    { label: 'Cat #', key: 'catalogueNumber' },
    { label: 'Vendor', key: 'vendor' },
    { label: 'Qty', key: 'quantity', type: 'number' },
    { label: 'Unit Price', key: 'unitPrice', type: 'number' },
    { label: 'Date', key: 'date', type: 'date' },
    { label: 'Category', key: 'category' },
    { label: 'Account', key: 'account' },
  ];
  var BM_BURN_COLUMNS = [
    { label: 'Category', key: 'category' },
    { label: 'Spent to Date', key: 'spent', type: 'number' },
    { label: 'Monthly Rate', key: 'monthly', type: 'number' },
    { label: 'Projected Annual', key: 'annual', type: 'number' },
  ];

  window.onBudgetSort = function (key) {
    if (_sortKey === key) { _sortDir = _sortDir === 'asc' ? 'desc' : 'asc'; }
    else { _sortKey = key; _sortDir = 'asc'; }
    renderTab();
  };

  var TABS = [
    { key: 'summary', label: 'Spending Summary' },
    { key: 'items', label: 'Item Lookup' },
    { key: 'burnrate', label: 'Burn Rate' },
  ];

  async function init() {
    var results = await Promise.all([
      api.load('inventory/items.json'),
      api.load('finance/receipts.json'),
    ]);

    var items = results[0].items || [];
    _receipts = results[1].receipts || [];

    // Build unified item list from inventory (primary source of truth)
    _allItems = [];
    items.forEach(function (item) {
      _allItems.push({
        description: item.name || item.description || '',
        catalogueNumber: item.catalogue_number || '',
        quantity: item.quantity || 1,
        unitPrice: item.unit_price || 0,
        extendedPrice: item.extended_price || item.unit_price || 0,
        vendor: item.vendor || '',
        date: item.date_acquired || '',
        project: item.project_tag || '',
        account: item.account_number || '',
        funding: item.funding_source || '',
        category: item.category || 'Other',
        subcategory: item.subcategory || '',
        source: 'inventory',
      });
    });

    // Add manual receipts that aren't already covered by inventory
    _receipts.forEach(function (r) {
      if (r.amount) {
        _allItems.push({
          description: r.description || '',
          catalogueNumber: '',
          quantity: 1,
          unitPrice: r.amount || 0,
          extendedPrice: r.amount || 0,
          vendor: r.vendor || '',
          date: r.date || '',
          project: r.project_tag || '',
          account: r.account_number || r.funding_source || '',
          funding: r.funding_source || '',
          category: r.category || 'Other',
          subcategory: '',
          source: 'manual_receipt',
        });
      }
    });

    // Populate project filter
    var projects = {};
    _allItems.forEach(function (i) { if (i.project) projects[i.project] = true; });
    Object.keys(projects).sort().forEach(function (p) {
      var opt = document.createElement('option');
      opt.value = p;
      opt.textContent = p;
      projectFilter.appendChild(opt);
    });

    var params = new URLSearchParams(window.location.search);
    if (params.get('project')) {
      projectFilter.value = params.get('project');
    }

    projectFilter.onchange = function () { renderTab(); };
    loadAndRender();
  }

  function getFiltered() {
    var proj = projectFilter.value;
    if (proj === 'all') return _allItems;
    return _allItems.filter(function (i) { return i.project === proj; });
  }

  function loadAndRender() {
    tabsEl.innerHTML = '';
    TABS.forEach(function (t) {
      var btn = document.createElement('button');
      btn.className = 'tab-btn' + (activeTab === t.key ? ' active' : '');
      btn.textContent = t.label;
      btn.onclick = function () { activeTab = t.key; _sortKey = null; _sortDir = 'asc'; loadAndRender(); };
      tabsEl.appendChild(btn);
    });
    renderTab();
  }

  function renderTab() {
    if (activeTab === 'summary') renderSummary();
    else if (activeTab === 'items') renderItemLookup();
    else if (activeTab === 'burnrate') renderBurnRate();
  }

  /* ---- 1. Spending Summary ---- */

  function renderSummary() {
    var items = getFiltered();
    if (!items.length) {
      content.innerHTML = '<div class="empty-state">No spending data' + (projectFilter.value !== 'all' ? ' for project "' + projectFilter.value + '"' : '') + '.</div>';
      return;
    }

    var byCategory = {};
    var byAccount = {};
    var grandTotal = 0;
    items.forEach(function (i) {
      var amt = i.extendedPrice || i.unitPrice || 0;
      grandTotal += amt;
      var cat = i.category || 'Other';
      var acct = i.account || 'Unassigned';
      byCategory[cat] = (byCategory[cat] || 0) + amt;
      byAccount[acct] = (byAccount[acct] || 0) + amt;
    });

    var html = '<div style="display:flex;gap:12px;margin-bottom:20px;flex-wrap:wrap;">';
    html += '<div class="card" style="flex:1;min-width:180px;"><div class="card-title">Total Spending</div><div class="card-count">$' + grandTotal.toLocaleString(undefined, { maximumFractionDigits: 0 }) + '</div><div class="card-body">' + items.length + ' items</div></div>';
    var sorted = Object.entries(byCategory).sort(function (a, b) { return b[1] - a[1]; });
    sorted.slice(0, 3).forEach(function (kv) {
      html += '<div class="card" style="flex:1;min-width:180px;"><div class="card-title">' + kv[0].replace(/_/g, ' ') + '</div><div class="card-count">$' + kv[1].toLocaleString(undefined, { maximumFractionDigits: 0 }) + '</div><div class="card-body">' + (grandTotal > 0 ? ((kv[1] / grandTotal) * 100).toFixed(0) + '% of total' : '') + '</div></div>';
    });
    html += '</div>';

    // By Account
    var acctRows = Object.entries(byAccount).map(function (kv) {
      return { account: kv[0], amount: kv[1], pct: grandTotal > 0 ? (kv[1] / grandTotal) * 100 : 0 };
    });
    acctRows = sortItems(acctRows, _sortKey, _sortDir, BM_ACCT_COLUMNS);
    if (!_sortKey) acctRows.sort(function (a, b) { return b.amount - a.amount; });
    html += '<h2 style="font-size:16px;margin-bottom:12px;">By Account</h2>';
    html += '<table class="data-table" style="margin-bottom:24px;">' + sortableHeader(BM_ACCT_COLUMNS, _sortKey, _sortDir, 'onBudgetSort') + '<tbody>';
    acctRows.forEach(function (row) {
      html += '<tr><td><strong>' + row.account + '</strong></td><td>$' + row.amount.toLocaleString(undefined, { minimumFractionDigits: 2 }) + '</td><td>' + row.pct.toFixed(1) + '%</td></tr>';
    });
    html += '</tbody></table>';

    // By Category
    var catRows = sorted.map(function (kv) {
      return { category: kv[0], amount: kv[1], pct: grandTotal > 0 ? (kv[1] / grandTotal) * 100 : 0, count: items.filter(function (i) { return (i.category || 'Other') === kv[0]; }).length };
    });
    catRows = sortItems(catRows, _sortKey, _sortDir, BM_CAT_COLUMNS);
    html += '<h2 style="font-size:16px;margin-bottom:12px;">By Category</h2>';
    html += '<table class="data-table">' + sortableHeader(BM_CAT_COLUMNS, _sortKey, _sortDir, 'onBudgetSort') + '<tbody>';
    catRows.forEach(function (row) {
      html += '<tr><td><strong>' + row.category.replace(/_/g, ' ') + '</strong></td><td>$' + row.amount.toLocaleString(undefined, { minimumFractionDigits: 2 }) + '</td><td>' + row.pct.toFixed(1) + '%</td><td>' + row.count + '</td></tr>';
    });
    html += '<tr style="font-weight:700;background:var(--bg);"><td>Total</td><td>$' + grandTotal.toLocaleString(undefined, { minimumFractionDigits: 2 }) + '</td><td>100%</td><td>' + items.length + '</td></tr>';
    html += '</tbody></table>';

    content.innerHTML = html;
  }

  /* ---- 2. Item Lookup ---- */

  function renderItemLookup() {
    var html = '<div style="margin-bottom:16px;">';
    html += '<input class="form-group" id="item-search" type="text" placeholder="Search by description, catalogue #, or vendor..." style="width:100%;max-width:500px;padding:8px 12px;border:1px solid var(--border);border-radius:var(--radius);font-size:14px;">';
    html += '</div>';
    html += '<div id="item-results"></div>';
    content.innerHTML = html;

    var searchInput = document.getElementById('item-search');
    searchInput.oninput = function () {
      renderItemResults(searchInput.value.trim().toLowerCase());
    };
    renderItemResults('');
  }

  function renderItemResults(query) {
    var items = getFiltered();
    if (query) {
      items = items.filter(function (i) {
        return i.description.toLowerCase().indexOf(query) >= 0
            || i.catalogueNumber.toLowerCase().indexOf(query) >= 0
            || i.vendor.toLowerCase().indexOf(query) >= 0;
      });
    }

    var resultsEl = document.getElementById('item-results');
    if (!items.length) {
      resultsEl.innerHTML = '<div class="empty-state">No items match' + (query ? ' "' + query + '"' : '') + '.</div>';
      return;
    }

    items = sortItems(items, _sortKey, _sortDir, BM_ITEM_COLUMNS);
    if (!_sortKey) items.sort(function (a, b) { return (b.date || '').localeCompare(a.date || ''); });

    var html = '<div style="font-size:13px;color:var(--text-muted);margin-bottom:8px;">' + items.length + ' item' + (items.length !== 1 ? 's' : '') + ' found</div>';
    html += '<table class="data-table">' + sortableHeader(BM_ITEM_COLUMNS, _sortKey, _sortDir, 'onBudgetSort') + '<tbody>';

    items.slice(0, 100).forEach(function (i) {
      html += '<tr>' +
        '<td>' + (i.description || '') + '</td>' +
        '<td style="font-size:12px;">' + (i.catalogueNumber || '') + '</td>' +
        '<td>' + (i.vendor || '') + '</td>' +
        '<td>' + i.quantity + '</td>' +
        '<td>$' + (i.unitPrice || 0).toFixed(2) + '</td>' +
        '<td>' + formatDate(i.date) + '</td>' +
        '<td style="font-size:12px;">' + (i.category || '').replace(/_/g, ' ') + '</td>' +
        '<td style="font-size:12px;">' + (i.account || '') + '</td>' +
        '</tr>';
    });
    if (items.length > 100) html += '<tr><td colspan="8" style="color:var(--text-muted);">Showing first 100 of ' + items.length + ' results</td></tr>';
    html += '</tbody></table>';
    resultsEl.innerHTML = html;
  }

  /* ---- 3. Burn Rate ---- */

  function renderBurnRate() {
    var items = getFiltered();
    if (!items.length) {
      content.innerHTML = '<div class="empty-state">No spending data for burn rate calculation.</div>';
      return;
    }

    var dates = items.map(function (i) { return i.date; }).filter(function (d) { return d && d !== 'TBD'; }).sort();
    if (dates.length < 2) {
      content.innerHTML = '<div class="empty-state">Need at least 2 dated items to calculate burn rate.</div>';
      return;
    }

    var firstDate = new Date(dates[0] + 'T00:00:00');
    var lastDate = new Date(dates[dates.length - 1] + 'T00:00:00');
    var spanDays = Math.max(1, (lastDate - firstDate) / 86400000);
    var spanMonths = Math.max(1, spanDays / 30.44);

    var byCategory = {};
    var grandTotal = 0;
    items.forEach(function (i) {
      var amt = i.extendedPrice || i.unitPrice || 0;
      grandTotal += amt;
      var cat = i.category || 'Other';
      byCategory[cat] = (byCategory[cat] || 0) + amt;
    });

    var annualTotal = (grandTotal / spanMonths) * 12;

    var html = '<div style="margin-bottom:16px;font-size:14px;color:var(--text-muted);">';
    html += 'Based on <strong>' + spanMonths.toFixed(1) + ' months</strong> of data (' + formatDate(dates[0]) + ' to ' + formatDate(dates[dates.length - 1]) + ')';
    html += '</div>';

    html += '<div style="display:flex;gap:12px;margin-bottom:20px;flex-wrap:wrap;">';
    html += '<div class="card" style="flex:1;min-width:200px;"><div class="card-title">Monthly Burn Rate</div><div class="card-count">$' + (grandTotal / spanMonths).toLocaleString(undefined, { maximumFractionDigits: 0 }) + '</div></div>';
    html += '<div class="card" style="flex:1;min-width:200px;"><div class="card-title">Projected Annual</div><div class="card-count">$' + annualTotal.toLocaleString(undefined, { maximumFractionDigits: 0 }) + '</div></div>';
    html += '</div>';

    var burnRows = Object.entries(byCategory).map(function (kv) {
      var monthly = kv[1] / spanMonths;
      return { category: kv[0], spent: kv[1], monthly: monthly, annual: monthly * 12 };
    });
    burnRows = sortItems(burnRows, _sortKey, _sortDir, BM_BURN_COLUMNS);
    if (!_sortKey) burnRows.sort(function (a, b) { return b.spent - a.spent; });
    html += '<h2 style="font-size:16px;margin-bottom:12px;">Projected Annual by Category</h2>';
    html += '<table class="data-table">' + sortableHeader(BM_BURN_COLUMNS, _sortKey, _sortDir, 'onBudgetSort') + '<tbody>';

    burnRows.forEach(function (row) {
      html += '<tr><td><strong>' + row.category.replace(/_/g, ' ') + '</strong></td><td>$' + row.spent.toLocaleString(undefined, { minimumFractionDigits: 2 }) + '</td><td>$' + row.monthly.toLocaleString(undefined, { maximumFractionDigits: 0 }) + '/mo</td><td>$' + row.annual.toLocaleString(undefined, { maximumFractionDigits: 0 }) + '/yr</td></tr>';
    });

    html += '<tr style="font-weight:700;background:var(--bg);"><td>Total</td><td>$' + grandTotal.toLocaleString(undefined, { minimumFractionDigits: 2 }) + '</td><td>$' + (grandTotal / spanMonths).toLocaleString(undefined, { maximumFractionDigits: 0 }) + '/mo</td><td>$' + annualTotal.toLocaleString(undefined, { maximumFractionDigits: 0 }) + '/yr</td></tr>';
    html += '</tbody></table>';

    html += '<div style="margin-top:16px;"><a href="/rm/pages/analytics.html" class="btn btn-primary">View Charts &rarr;</a></div>';
    content.innerHTML = html;
  }

  /* ---- Export ---- */

  exportBtn.onclick = function () {
    var items = getFiltered();
    if (!items.length) { alert('No data to export.'); return; }

    var proj = projectFilter.value;
    var dates = items.map(function (i) { return i.date; }).filter(function (d) { return d && d !== 'TBD'; }).sort();
    var spanMonths = 1;
    if (dates.length >= 2) {
      var firstDate = new Date(dates[0] + 'T00:00:00');
      var lastDate = new Date(dates[dates.length - 1] + 'T00:00:00');
      spanMonths = Math.max(1, (lastDate - firstDate) / 86400000 / 30.44);
    }

    var byCategory = {};
    var byAccount = {};
    var grandTotal = 0;
    items.forEach(function (i) {
      var amt = i.extendedPrice || i.unitPrice || 0;
      grandTotal += amt;
      byCategory[i.category || 'Other'] = (byCategory[i.category || 'Other'] || 0) + amt;
      byAccount[i.account || 'Unassigned'] = (byAccount[i.account || 'Unassigned'] || 0) + amt;
    });

    var text = 'BUDGET JUSTIFICATION \u2014 ' + (proj === 'all' ? 'All Projects' : proj) + '\n';
    text += 'Generated ' + today() + ' from McGhee Lab procurement data\n';
    text += '='.repeat(60) + '\n\n';
    text += 'Data period: ' + (dates.length ? formatDate(dates[0]) + ' to ' + formatDate(dates[dates.length - 1]) : 'N/A') + ' (' + spanMonths.toFixed(1) + ' months)\n';
    text += 'Total: $' + grandTotal.toFixed(2) + ' (' + items.length + ' items)\n\n';

    text += 'BY ACCOUNT\n' + '-'.repeat(50) + '\n';
    Object.entries(byAccount).sort(function (a, b) { return b[1] - a[1]; }).forEach(function (kv) {
      text += '  ' + kv[0] + ': $' + kv[1].toFixed(2) + '\n';
    });

    text += '\nBY CATEGORY (with projected annual)\n' + '-'.repeat(50) + '\n';
    Object.entries(byCategory).sort(function (a, b) { return b[1] - a[1]; }).forEach(function (kv) {
      var monthly = kv[1] / spanMonths;
      var annual = monthly * 12;
      text += '  ' + kv[0] + ': $' + kv[1].toFixed(2) + ' ($' + annual.toFixed(0) + '/yr)\n';
    });

    text += '\nBasis: Historical spending from ' + items.length + ' items over ' + spanMonths.toFixed(1) + ' months.\n';

    navigator.clipboard.writeText(text).then(function () {
      exportBtn.textContent = 'Copied!';
      setTimeout(function () { exportBtn.textContent = 'Export for Proposal'; }, 2000);
    }).catch(function () { alert('Copy failed.'); });
  };

  (async function () {
    if (typeof firebridge !== 'undefined' && firebridge.whenAuthResolved) await firebridge.whenAuthResolved();
    await init();
    // No LIVE_SYNC.attach: budget-model reads cached items + receipts
    // collections; reload covers cross-tab edits.
  })();
})();
