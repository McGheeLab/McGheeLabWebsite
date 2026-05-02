/* analytics.js — expense analytics with Chart.js visualizations */

var activeTab = 'overview';
var _allRecords = []; // unified spending records from receipts + inventory
var _charts = {};     // track chart instances for cleanup
var _sortKey = null;
var _sortDir = 'asc';
var ANALYTICS_CAT_COLUMNS = [
  { label: 'Category', key: 'category' },
  { label: 'Amount', key: 'amount', type: 'number' },
  { label: '% of Total', key: 'pct', type: 'number' },
];
var ANALYTICS_CAT_DETAIL_COLUMNS = [
  { label: 'Category', key: 'category' },
  { label: 'Total', key: 'total', type: 'number' },
  { label: '%', key: 'pct', type: 'number' },
  { label: 'Orders', key: 'count', type: 'number' },
];
var ANALYTICS_ACCT_COLUMNS = [
  { label: 'Account', key: 'account' },
  { label: 'Total Spent', key: 'total', type: 'number' },
  { label: 'Top Categories', key: null },
];
var ANALYTICS_PROJ_COLUMNS = [
  { label: 'Category', key: 'category' },
  { label: 'Spent to Date', key: 'spent', type: 'number' },
  { label: 'Monthly Rate', key: 'monthly', type: 'number' },
  { label: 'Projected Annual', key: 'annual', type: 'number' },
];

var CATEGORY_COLORS = {
  computer: '#2563eb',
  consumable: '#7c3aed',
  equipment: '#059669',
  lab_furniture: '#d97706',
  office: '#64748b',
  remodel: '#dc2626',
  research_analysis: '#0891b2',
  research_cells: '#e11d48',
  research_chem: '#f59e0b',
  research_gas: '#8b5cf6',
  research_gels: '#10b981',
  research_reagents: '#6366f1',
  student_tuition: '#94a3b8',
  travel: '#f97316',
  software: '#0ea5e9',
  core_facility: '#14b8a6',
  other: '#9ca3af',
};

var TABS = [
  { key: 'overview', label: 'Overview' },
  { key: 'timeline', label: 'Spend Over Time' },
  { key: 'category', label: 'By Category' },
  { key: 'account', label: 'By Account' },
  { key: 'projections', label: 'Projections' },
];

/* ---- Chart.js defaults ---- */

if (typeof Chart !== 'undefined') {
  Chart.defaults.font.family = '-apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif';
  Chart.defaults.font.size = 13;
  Chart.defaults.color = '#6b7280';
}

function destroyChart(key) {
  if (_charts[key]) { _charts[key].destroy(); delete _charts[key]; }
}

function getColor(category) {
  return CATEGORY_COLORS[category] || CATEGORY_COLORS.other;
}

/* ---- Data loading & filtering ---- */

async function loadData() {
  var results = await Promise.all([
    api.load('finance/receipts.json'),
    api.load('inventory/items.json'),
  ]);

  var receipts = results[0].receipts || [];
  var items = results[1].items || [];

  // Build unified records: each has date, amount, category, account_number, vendor
  _allRecords = [];

  // From manual receipts
  receipts.forEach(function (r) {
    if (r.amount) {
      _allRecords.push({
        date: r.date || '',
        amount: r.amount,
        category: r.category || 'Other',
        account_number: r.funding_source || '',
        vendor: r.vendor || '',
        source: 'manual',
      });
    }
  });

  // From parsed inventory items
  items.forEach(function (item) {
    var amt = item.extended_price || item.unit_price || 0;
    if (amt > 0) {
      _allRecords.push({
        date: item.date_acquired || '',
        amount: amt,
        category: item.category || 'Other',
        account_number: item.account_number || '',
        vendor: item.vendor || '',
        source: 'parsed',
      });
    }
  });

  // Populate account filter
  var accountFilter = document.getElementById('account-filter');
  var accounts = {};
  _allRecords.forEach(function (r) { if (r.account_number) accounts[r.account_number] = true; });
  accountFilter.innerHTML = '<option value="all">All Accounts</option>';
  Object.keys(accounts).sort().forEach(function (a) {
    var opt = document.createElement('option');
    opt.value = a;
    opt.textContent = a;
    accountFilter.appendChild(opt);
  });
}

function getFiltered() {
  var records = _allRecords.slice();
  var accountFilter = document.getElementById('account-filter').value;
  var periodFilter = document.getElementById('period-filter').value;

  if (accountFilter !== 'all') {
    records = records.filter(function (r) { return r.account_number === accountFilter; });
  }

  if (periodFilter !== 'all') {
    var cutoff = new Date();
    if (periodFilter === 'ytd') cutoff = new Date(cutoff.getFullYear(), 0, 1);
    else if (periodFilter === '12m') cutoff.setMonth(cutoff.getMonth() - 12);
    else if (periodFilter === '6m') cutoff.setMonth(cutoff.getMonth() - 6);
    var cutoffStr = cutoff.toISOString().slice(0, 10);
    records = records.filter(function (r) { return r.date && r.date >= cutoffStr; });
  }

  return records;
}

/* ---- Tab rendering ---- */

async function loadAndRender() {
  await loadData();

  var tabsEl = document.getElementById('tabs');
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
  // Destroy all existing charts
  Object.keys(_charts).forEach(destroyChart);

  if (activeTab === 'overview') renderOverview();
  else if (activeTab === 'timeline') renderTimeline();
  else if (activeTab === 'category') renderCategory();
  else if (activeTab === 'account') renderAccount();
  else if (activeTab === 'projections') renderProjections();
}

/* ---- Overview ---- */

function renderOverview() {
  var records = getFiltered();
  var content = document.getElementById('content');
  var grandTotal = records.reduce(function (s, r) { return s + r.amount; }, 0);

  var dates = records.map(function (r) { return r.date; }).filter(function (d) { return d && d !== 'TBD'; }).sort();
  var spanMonths = 1;
  if (dates.length >= 2) {
    var first = new Date(dates[0] + 'T00:00:00');
    var last = new Date(dates[dates.length - 1] + 'T00:00:00');
    spanMonths = Math.max(1, (last - first) / 86400000 / 30.44);
  }
  var monthlyRate = grandTotal / spanMonths;
  var annualProjected = monthlyRate * 12;

  var byCategory = {};
  records.forEach(function (r) { byCategory[r.category] = (byCategory[r.category] || 0) + r.amount; });
  var topCat = Object.entries(byCategory).sort(function (a, b) { return b[1] - a[1]; })[0];

  var html = '<div style="display:flex;gap:12px;margin-bottom:20px;flex-wrap:wrap;">';
  html += '<div class="card" style="flex:1;min-width:180px;"><div class="card-title">Total Spent</div><div class="card-count">$' + grandTotal.toLocaleString(undefined, { maximumFractionDigits: 0 }) + '</div><div class="card-body">' + records.length + ' records</div></div>';
  html += '<div class="card" style="flex:1;min-width:180px;"><div class="card-title">Monthly Burn</div><div class="card-count">$' + monthlyRate.toLocaleString(undefined, { maximumFractionDigits: 0 }) + '</div><div class="card-body">/month</div></div>';
  html += '<div class="card" style="flex:1;min-width:180px;"><div class="card-title">Projected Annual</div><div class="card-count">$' + annualProjected.toLocaleString(undefined, { maximumFractionDigits: 0 }) + '</div><div class="card-body">/year</div></div>';
  if (topCat) {
    html += '<div class="card" style="flex:1;min-width:180px;"><div class="card-title">Top Category</div><div class="card-count">' + topCat[0].replace(/_/g, ' ') + '</div><div class="card-body">$' + topCat[1].toLocaleString(undefined, { maximumFractionDigits: 0 }) + '</div></div>';
  }
  html += '</div>';

  // Quick category breakdown table
  var catRows = Object.entries(byCategory).map(function (kv) {
    return { category: kv[0], amount: kv[1], pct: grandTotal > 0 ? (kv[1] / grandTotal) * 100 : 0 };
  });
  catRows = sortItems(catRows, _sortKey, _sortDir, ANALYTICS_CAT_COLUMNS);
  if (!_sortKey) catRows.sort(function (a, b) { return b.amount - a.amount; });
  html += '<h2 style="font-size:16px;margin-bottom:12px;">Spending by Category</h2>';
  html += '<table class="data-table">' + sortableHeader(ANALYTICS_CAT_COLUMNS, _sortKey, _sortDir, 'onAnalyticsSort') + '<tbody>';
  catRows.forEach(function (row) {
    html += '<tr><td><span style="display:inline-block;width:12px;height:12px;border-radius:2px;background:' + getColor(row.category) + ';margin-right:6px;vertical-align:middle;"></span><strong>' + row.category.replace(/_/g, ' ') + '</strong></td>';
    html += '<td>$' + row.amount.toLocaleString(undefined, { minimumFractionDigits: 2 }) + '</td><td>' + row.pct.toFixed(1) + '%</td></tr>';
  });
  html += '</tbody></table>';

  content.innerHTML = html;
}

/* ---- Spend Over Time ---- */

function renderTimeline() {
  var records = getFiltered();
  var content = document.getElementById('content');

  // Group by month
  var byMonth = {};
  records.forEach(function (r) {
    if (!r.date || r.date === 'TBD') return;
    var month = r.date.slice(0, 7);
    byMonth[month] = (byMonth[month] || 0) + r.amount;
  });

  var months = Object.keys(byMonth).sort();
  var amounts = months.map(function (m) { return byMonth[m]; });

  // Cumulative
  var cumulative = [];
  var sum = 0;
  amounts.forEach(function (a) { sum += a; cumulative.push(sum); });

  var labels = months.map(function (m) {
    var parts = m.split('-');
    var d = new Date(parseInt(parts[0]), parseInt(parts[1]) - 1, 1);
    return d.toLocaleDateString('en-US', { month: 'short', year: '2-digit' });
  });

  var html = '<div style="display:flex;gap:16px;flex-wrap:wrap;">';
  html += '<div style="flex:2;min-width:400px;"><canvas id="timeline-cumulative" style="max-height:400px;"></canvas></div>';
  html += '<div style="flex:1;min-width:300px;"><canvas id="timeline-monthly" style="max-height:400px;"></canvas></div>';
  html += '</div>';
  content.innerHTML = html;

  // Cumulative line chart
  _charts.cumulative = new Chart(document.getElementById('timeline-cumulative'), {
    type: 'line',
    data: {
      labels: labels,
      datasets: [{
        label: 'Cumulative Spending',
        data: cumulative,
        borderColor: '#2563eb',
        backgroundColor: 'rgba(37,99,235,0.1)',
        fill: true,
        tension: 0.3,
        pointRadius: 3,
      }],
    },
    options: {
      responsive: true,
      plugins: { legend: { display: false }, title: { display: true, text: 'Cumulative Spending' } },
      scales: { y: { ticks: { callback: function (v) { return '$' + v.toLocaleString(); } } } },
    },
  });

  // Monthly bar chart
  _charts.monthly = new Chart(document.getElementById('timeline-monthly'), {
    type: 'bar',
    data: {
      labels: labels,
      datasets: [{
        label: 'Monthly Spending',
        data: amounts,
        backgroundColor: 'rgba(37,99,235,0.7)',
        borderRadius: 4,
      }],
    },
    options: {
      responsive: true,
      plugins: { legend: { display: false }, title: { display: true, text: 'Monthly Spending' } },
      scales: { y: { ticks: { callback: function (v) { return '$' + v.toLocaleString(); } } } },
    },
  });
}

/* ---- By Category ---- */

function renderCategory() {
  var records = getFiltered();
  var content = document.getElementById('content');

  var byCategory = {};
  records.forEach(function (r) { byCategory[r.category] = (byCategory[r.category] || 0) + r.amount; });
  var sorted = Object.entries(byCategory).sort(function (a, b) { return b[1] - a[1]; });
  var catLabels = sorted.map(function (kv) { return kv[0].replace(/_/g, ' '); });
  var catAmounts = sorted.map(function (kv) { return kv[1]; });
  var catColors = sorted.map(function (kv) { return getColor(kv[0]); });

  var html = '<div style="display:flex;gap:16px;flex-wrap:wrap;margin-bottom:20px;">';
  html += '<div style="flex:2;min-width:400px;"><canvas id="cat-bar" style="max-height:400px;"></canvas></div>';
  html += '<div style="flex:1;min-width:250px;"><canvas id="cat-donut" style="max-height:350px;"></canvas></div>';
  html += '</div>';

  // Data table
  var grandTotal = records.reduce(function (s, r) { return s + r.amount; }, 0);
  var catDetailRows = sorted.map(function (kv) {
    return { category: kv[0], total: kv[1], pct: grandTotal > 0 ? (kv[1] / grandTotal) * 100 : 0, count: records.filter(function (r) { return r.category === kv[0]; }).length };
  });
  catDetailRows = sortItems(catDetailRows, _sortKey, _sortDir, ANALYTICS_CAT_DETAIL_COLUMNS);
  html += '<table class="data-table">' + sortableHeader(ANALYTICS_CAT_DETAIL_COLUMNS, _sortKey, _sortDir, 'onAnalyticsSort') + '<tbody>';
  catDetailRows.forEach(function (row) {
    html += '<tr><td><span style="display:inline-block;width:12px;height:12px;border-radius:2px;background:' + getColor(row.category) + ';margin-right:6px;vertical-align:middle;"></span><strong>' + row.category.replace(/_/g, ' ') + '</strong></td>';
    html += '<td>$' + row.total.toLocaleString(undefined, { minimumFractionDigits: 2 }) + '</td><td>' + row.pct.toFixed(1) + '%</td><td>' + row.count + '</td></tr>';
  });
  html += '</tbody></table>';

  content.innerHTML = html;

  // Horizontal bar
  _charts.catBar = new Chart(document.getElementById('cat-bar'), {
    type: 'bar',
    data: {
      labels: catLabels,
      datasets: [{ data: catAmounts, backgroundColor: catColors, borderRadius: 4 }],
    },
    options: {
      indexAxis: 'y',
      responsive: true,
      plugins: { legend: { display: false }, title: { display: true, text: 'Spending by Category' } },
      scales: { x: { ticks: { callback: function (v) { return '$' + v.toLocaleString(); } } } },
    },
  });

  // Doughnut
  _charts.catDonut = new Chart(document.getElementById('cat-donut'), {
    type: 'doughnut',
    data: {
      labels: catLabels,
      datasets: [{ data: catAmounts, backgroundColor: catColors }],
    },
    options: {
      responsive: true,
      plugins: { legend: { position: 'bottom', labels: { boxWidth: 12 } } },
    },
  });
}

/* ---- By Account ---- */

function renderAccount() {
  var records = getFiltered();
  var content = document.getElementById('content');

  var byAccount = {};
  records.forEach(function (r) {
    var acct = r.account_number || 'Unassigned';
    if (!byAccount[acct]) byAccount[acct] = { total: 0, byCategory: {} };
    byAccount[acct].total += r.amount;
    byAccount[acct].byCategory[r.category] = (byAccount[acct].byCategory[r.category] || 0) + r.amount;
  });

  var accounts = Object.keys(byAccount).sort(function (a, b) { return byAccount[b].total - byAccount[a].total; });

  // Get all categories across accounts
  var allCats = {};
  accounts.forEach(function (a) {
    Object.keys(byAccount[a].byCategory).forEach(function (c) { allCats[c] = true; });
  });
  var catList = Object.keys(allCats).sort();

  // Stacked bar data
  var datasets = catList.map(function (cat) {
    return {
      label: cat.replace(/_/g, ' '),
      data: accounts.map(function (a) { return byAccount[a].byCategory[cat] || 0; }),
      backgroundColor: getColor(cat),
    };
  });

  var html = '<div style="margin-bottom:20px;"><canvas id="account-bar" style="max-height:400px;"></canvas></div>';

  // Table
  var acctRows = accounts.map(function (acct) {
    var info = byAccount[acct];
    var topCats = Object.entries(info.byCategory).sort(function (a, b) { return b[1] - a[1]; }).slice(0, 3)
      .map(function (kv) { return kv[0].replace(/_/g, ' ') + ': $' + kv[1].toFixed(0); }).join(', ');
    return { account: acct, total: info.total, topCats: topCats };
  });
  acctRows = sortItems(acctRows, _sortKey, _sortDir, ANALYTICS_ACCT_COLUMNS);
  html += '<table class="data-table">' + sortableHeader(ANALYTICS_ACCT_COLUMNS, _sortKey, _sortDir, 'onAnalyticsSort') + '<tbody>';
  acctRows.forEach(function (row) {
    html += '<tr><td><strong>' + row.account + '</strong></td><td>$' + row.total.toLocaleString(undefined, { minimumFractionDigits: 2 }) + '</td><td style="font-size:12px;color:var(--text-muted);">' + row.topCats + '</td></tr>';
  });
  html += '</tbody></table>';

  content.innerHTML = html;

  _charts.accountBar = new Chart(document.getElementById('account-bar'), {
    type: 'bar',
    data: { labels: accounts, datasets: datasets },
    options: {
      responsive: true,
      plugins: { legend: { position: 'bottom', labels: { boxWidth: 12 } }, title: { display: true, text: 'Spending by Account' } },
      scales: {
        x: { stacked: true },
        y: { stacked: true, ticks: { callback: function (v) { return '$' + v.toLocaleString(); } } },
      },
    },
  });
}

/* ---- Projections ---- */

function renderProjections() {
  var records = getFiltered();
  var content = document.getElementById('content');

  var dates = records.map(function (r) { return r.date; }).filter(function (d) { return d && d !== 'TBD'; }).sort();

  if (dates.length < 2) {
    content.innerHTML = '<div class="empty-state">Need at least 2 dated records to project spending.</div>';
    return;
  }

  // Group by month
  var byMonth = {};
  records.forEach(function (r) {
    if (!r.date || r.date === 'TBD') return;
    var month = r.date.slice(0, 7);
    byMonth[month] = (byMonth[month] || 0) + r.amount;
  });

  var months = Object.keys(byMonth).sort();
  var amounts = months.map(function (m) { return byMonth[m]; });

  // Cumulative historical
  var cumulative = [];
  var sum = 0;
  amounts.forEach(function (a) { sum += a; cumulative.push(sum); });

  // Calculate burn rate from last 6 months (or all data)
  var recentMonths = months.slice(-6);
  var recentTotal = recentMonths.reduce(function (s, m) { return s + byMonth[m]; }, 0);
  var monthlyRate = recentTotal / recentMonths.length;

  // Project 12 months forward
  var lastMonth = months[months.length - 1];
  var projMonths = [];
  var projCumulative = [];
  var lastCum = cumulative[cumulative.length - 1];
  for (var i = 1; i <= 12; i++) {
    var d = new Date(lastMonth + '-01');
    d.setMonth(d.getMonth() + i);
    var mKey = d.toISOString().slice(0, 7);
    projMonths.push(mKey);
    lastCum += monthlyRate;
    projCumulative.push(lastCum);
  }

  var allMonths = months.concat(projMonths);
  var labels = allMonths.map(function (m) {
    var parts = m.split('-');
    var dt = new Date(parseInt(parts[0]), parseInt(parts[1]) - 1, 1);
    return dt.toLocaleDateString('en-US', { month: 'short', year: '2-digit' });
  });

  // Historical line (with nulls for projection period)
  var histData = cumulative.concat(projMonths.map(function () { return null; }));
  // Projection line (with nulls for historical, bridging with last historical point)
  var projData = months.slice(0, -1).map(function () { return null; });
  projData.push(cumulative[cumulative.length - 1]); // bridge point
  projData = projData.concat(projCumulative);

  var firstDate = new Date(dates[0] + 'T00:00:00');
  var lastDate = new Date(dates[dates.length - 1] + 'T00:00:00');
  var spanMonths = Math.max(1, (lastDate - firstDate) / 86400000 / 30.44);
  var annualProjected = monthlyRate * 12;

  var html = '<div style="display:flex;gap:12px;margin-bottom:20px;flex-wrap:wrap;">';
  html += '<div class="card" style="flex:1;min-width:180px;"><div class="card-title">Monthly Burn Rate</div><div class="card-count">$' + monthlyRate.toLocaleString(undefined, { maximumFractionDigits: 0 }) + '</div><div class="card-body">Based on last ' + recentMonths.length + ' months</div></div>';
  html += '<div class="card" style="flex:1;min-width:180px;"><div class="card-title">Projected Annual</div><div class="card-count">$' + annualProjected.toLocaleString(undefined, { maximumFractionDigits: 0 }) + '</div></div>';
  html += '<div class="card" style="flex:1;min-width:180px;"><div class="card-title">Data Span</div><div class="card-count">' + spanMonths.toFixed(0) + ' mo</div><div class="card-body">' + formatDate(dates[0]) + ' to ' + formatDate(dates[dates.length - 1]) + '</div></div>';
  html += '</div>';

  html += '<div style="margin-bottom:20px;"><canvas id="proj-chart" style="max-height:400px;"></canvas></div>';

  // Burn rate by category
  var byCategory = {};
  records.forEach(function (r) { byCategory[r.category] = (byCategory[r.category] || 0) + r.amount; });
  var projRows = Object.entries(byCategory).map(function (kv) {
    var catMonthly = kv[1] / spanMonths;
    return { category: kv[0], spent: kv[1], monthly: catMonthly, annual: catMonthly * 12 };
  });
  projRows = sortItems(projRows, _sortKey, _sortDir, ANALYTICS_PROJ_COLUMNS);
  if (!_sortKey) projRows.sort(function (a, b) { return b.spent - a.spent; });
  html += '<h2 style="font-size:16px;margin-bottom:12px;">Projected Annual by Category</h2>';
  html += '<table class="data-table">' + sortableHeader(ANALYTICS_PROJ_COLUMNS, _sortKey, _sortDir, 'onAnalyticsSort') + '<tbody>';
  projRows.forEach(function (row) {
    html += '<tr><td><strong>' + row.category.replace(/_/g, ' ') + '</strong></td>';
    html += '<td>$' + row.spent.toLocaleString(undefined, { minimumFractionDigits: 2 }) + '</td>';
    html += '<td>$' + row.monthly.toLocaleString(undefined, { maximumFractionDigits: 0 }) + '/mo</td>';
    html += '<td>$' + row.annual.toLocaleString(undefined, { maximumFractionDigits: 0 }) + '/yr</td></tr>';
  });
  html += '</tbody></table>';

  content.innerHTML = html;

  _charts.projection = new Chart(document.getElementById('proj-chart'), {
    type: 'line',
    data: {
      labels: labels,
      datasets: [
        {
          label: 'Actual Spending',
          data: histData,
          borderColor: '#2563eb',
          backgroundColor: 'rgba(37,99,235,0.1)',
          fill: true,
          tension: 0.3,
          pointRadius: 3,
          spanGaps: false,
        },
        {
          label: 'Projected',
          data: projData,
          borderColor: '#2563eb',
          borderDash: [8, 4],
          backgroundColor: 'rgba(37,99,235,0.05)',
          fill: true,
          tension: 0.3,
          pointRadius: 2,
          spanGaps: false,
        },
      ],
    },
    options: {
      responsive: true,
      plugins: { title: { display: true, text: 'Spending Projection (12-month extrapolation)' } },
      scales: { y: { ticks: { callback: function (v) { return '$' + v.toLocaleString(); } } } },
    },
  });
}

window.onAnalyticsSort = function (key) {
  if (_sortKey === key) { _sortDir = _sortDir === 'asc' ? 'desc' : 'asc'; }
  else { _sortKey = key; _sortDir = 'asc'; }
  renderTab();
};

/* ---- Filter listeners ---- */

document.getElementById('account-filter').onchange = function () { renderTab(); };
document.getElementById('period-filter').onchange = function () { renderTab(); };

/* ---- Init ---- */

(async function () {
  if (typeof firebridge !== 'undefined' && firebridge.whenAuthResolved) await firebridge.whenAuthResolved();
  await loadAndRender();
  // No LIVE_SYNC.attach: analytics is a read-only rollup. Cached api.load
  // (TTLs in api-routes.js) gives the same data without onSnapshot listener
  // overhead; reload picks up cross-tab edits.
})();
