/* inventory.js — lab inventory with inline editing, multi-location, subtabs */

var DATA_PATH = 'inventory/items.json';
var PROJECTS_PATH = 'finance/projects.json';
var DATA_KEY = 'items';
var activeTab = 'all';
var _items = [];
var _data = null; // keep loaded data reference for inline saves
var _projects = []; // funded projects/grants

var CATEGORY_OPTIONS = [
  'equipment', 'infrastructure', 'consumable', 'computer', 'lab_furniture', 'office',
  'remodel', 'research_analysis', 'research_cells', 'research_chem',
  'research_gas', 'research_gels', 'research_reagents', 'software', 'other'
];
var STOCK_OPTIONS = ['full', 'low', 'out_of_stock', 'n/a'];
var CONDITION_OPTIONS = ['active', 'broken', 'retired', 'lost'];

var LOCATION_FIELDS = [
  { key: 'name', label: 'Location', type: 'text', required: true, placeholder: 'e.g. BSRL 312 — Shelf A2' },
  { key: 'quantity', label: 'Quantity Here', type: 'number' },
  { key: 'notes', label: 'Notes', type: 'text', placeholder: 'e.g. opened bottle, backup supply' },
];

var TABS = [
  { key: 'all', label: 'All Items', filter: null },
  { key: 'research', label: 'Research', filter: function (i) { return i.category && i.category.indexOf('research_') === 0; }},
  { key: 'consumables', label: 'Consumables', filter: function (i) { return i.category === 'consumable'; }},
  { key: 'equipment', label: 'Equipment', filter: function (i) { return i.category === 'equipment'; }},
  { key: 'computers', label: 'Computers & Software', filter: function (i) { return i.category === 'computer' || i.category === 'software'; }},
  { key: 'furniture', label: 'Furniture & Office', filter: function (i) { return i.category === 'lab_furniture' || i.category === 'office'; }},
  { key: 'infrastructure', label: 'Infrastructure', filter: function (i) { return i.category === 'infrastructure'; }},
  { key: 'preferred', label: 'Preferred', filter: function (i) { return i.preferred && i.product_group; }},
  { key: 'low_stock', label: 'Low / Out of Stock', filter: function (i) { return i.stock_status === 'low' || i.stock_status === 'out_of_stock'; }},
];

var SUBTAB_LABELS = {
  assay_kits: 'Assay Kits', growth_factors: 'Growth Factors', antibodies: 'Antibodies',
  culture_media: 'Culture Media', pipette_tips: 'Pipette Tips', plates: 'Plates',
  tubes: 'Tubes', buffers: 'Buffers', stains: 'Stains', general: 'General',
  supplements: 'Supplements', dishes: 'Dishes',
  solvents: 'Solvents', polymers: 'Polymers', salts: 'Salts', oils: 'Oils',
  fixatives: 'Fixatives', acids: 'Acids', crosslinkers: 'Crosslinkers',
  hydrogels: 'Hydrogels', matrices: 'Matrices',
  media: 'Media', cell_sieves: 'Cell Sieves', microfluidics: 'Microfluidics',
  imaging: 'Imaging', fittings: 'Fittings', tubing: 'Tubing', regulators: 'Regulators',
  ppe: 'PPE', lab_supplies: 'Lab Supplies', fabrication: 'Fabrication',
  cleaning: 'Cleaning', adhesives: 'Adhesives', safety: 'Safety', supplies: 'Supplies',
  instruments: 'Instruments', electronics: 'Electronics', tools: 'Tools',
  fluidics: 'Fluidics', optics: 'Optics',
  desktops: 'Desktops', peripherals: 'Peripherals', storage: 'Storage',
  networking: 'Networking', cables: 'Cables', subscriptions: 'Subscriptions', licenses: 'Licenses',
  benches: 'Benches', seating: 'Seating', carts: 'Carts', disposal: 'Disposal',
  plumbing: 'Plumbing', furniture: 'Furniture', organization: 'Organization',
  electrical: 'Electrical', mounting: 'Mounting', lighting: 'Lighting',
  cable_management: 'Cable Mgmt', hvac: 'HVAC',
};

var activeSubtab = 'all';
var _sortKey = 'name';
var _sortDir = 'asc';

var TABLE_COLUMNS = [
  { label: 'Name', key: 'name' },
  { label: 'Category', key: 'category' },
  { label: 'Vendor', key: 'vendor' },
  { label: 'Cat #', key: 'catalogue_number' },
  { label: 'Qty', key: 'quantity', type: 'number' },
  { label: 'Price', key: 'unit_price', type: 'number' },
  { label: 'Locations', key: null },
  { label: 'Stock', key: 'stock_status' },
];

/* ---- Tab helpers ---- */

function updateTabActive() {
  var btns = document.querySelectorAll('#tabs .tab-btn');
  btns.forEach(function (btn, i) { btn.className = 'tab-btn' + (TABS[i].key === activeTab ? ' active' : ''); });
}

/* ---- Chips ---- */

function stockChip(status) {
  var map = { full: 'chip-green', low: 'chip-amber', out_of_stock: 'chip-red', 'n/a': 'chip-muted' };
  return '<span class="chip ' + (map[status] || 'chip-muted') + '">' + (status || 'n/a').replace(/_/g, ' ') + '</span>';
}

function locationsChips(locations) {
  if (!locations || !locations.length) return '<span style="color:var(--text-muted);">\u2014</span>';
  return locations.map(function (loc) {
    var qty = loc.quantity ? ' (' + loc.quantity + ')' : '';
    return '<span class="chip chip-muted" style="margin:1px;">' + loc.name + qty + '</span>';
  }).join(' ');
}

/* ---- Star/preferred toggle ---- */

function starHtml(realIdx, preferred) {
  var filled = preferred ? '\u2605' : '\u2606';
  var color = preferred ? '#d97706' : 'var(--text-muted)';
  return '<span class="star-toggle" onclick="event.stopPropagation(); togglePreferred(' + realIdx + ')" style="cursor:pointer;font-size:18px;color:' + color + ';user-select:none;" title="' + (preferred ? 'Remove from preferred' : 'Mark as preferred') + '">' + filled + '</span>';
}

/* ---- Inline edit helpers ---- */

function inlineSelect(realIdx, field, currentVal, options) {
  var html = '<select data-idx="' + realIdx + '" data-field="' + field + '" onchange="inlineSave(this)" style="font-size:13px;padding:3px 6px;border:1px solid var(--border);border-radius:4px;background:var(--surface);cursor:pointer;">';
  options.forEach(function (opt) {
    html += '<option value="' + opt + '"' + (opt === currentVal ? ' selected' : '') + '>' + opt.replace(/_/g, ' ') + '</option>';
  });
  html += '</select>';
  return html;
}

function inlineText(realIdx, field, currentVal, placeholder) {
  var val = currentVal || '';
  return '<input type="text" data-idx="' + realIdx + '" data-field="' + field + '" value="' + val.replace(/"/g, '&quot;') + '" placeholder="' + (placeholder || '') + '" onblur="inlineSave(this)" onkeydown="if(event.key===\'Enter\'){this.blur();}" style="font-size:13px;padding:3px 6px;border:1px solid var(--border);border-radius:4px;width:100%;max-width:300px;background:var(--surface);">';
}

function inlineTextarea(realIdx, field, currentVal, placeholder) {
  var val = currentVal || '';
  return '<textarea data-idx="' + realIdx + '" data-field="' + field + '" placeholder="' + (placeholder || '') + '" onblur="inlineSave(this)" style="font-size:13px;padding:3px 6px;border:1px solid var(--border);border-radius:4px;width:100%;min-height:50px;background:var(--surface);resize:vertical;">' + val + '</textarea>';
}

function inlineCheckbox(realIdx, field, currentVal) {
  return '<input type="checkbox" data-idx="' + realIdx + '" data-field="' + field + '"' + (currentVal ? ' checked' : '') + ' onchange="inlineSave(this)" style="width:16px;height:16px;cursor:pointer;">';
}

/* Optimistic + surgical save helpers — one Firestore doc write per touched
 * item, not a full collection rewrite. Without these, every star toggle or
 * inline-field edit re-writes all 775 inventory docs (~1+ second). The
 * `kind: 'item'` field is preserved so the route's `where` filter still
 * matches. Bumps _invLive.suppressUntil so the local subscriber's snapshot
 * echo doesn't trigger a redundant loadAndRender. Falls back to the full
 * api.save when Firestore isn't available. */
async function _saveInvItemSurgical(item) {
  return _saveInvItemsSurgical([item]);
}
async function _saveInvItemsSurgical(items) {
  if (typeof firebridge === 'undefined' || !firebridge.db) {
    return api.save(DATA_PATH, _data);
  }
  try {
    _invLive.suppressUntil = Date.now() + 2500;
    var db = firebridge.db();
    var ts = firebase.firestore.FieldValue.serverTimestamp();
    var batch = db.batch();
    items.forEach(function (it) {
      var clean = Object.assign({}, it);
      delete clean.id;
      clean.kind = 'item';
      clean.updatedAt = ts;
      batch.set(db.collection('inventory').doc(it.id), clean, { merge: true });
    });
    await batch.commit();
  } catch (err) {
    console.warn('[inventory] surgical save failed, falling back to full save:', err.message);
    await api.save(DATA_PATH, _data);
  }
}

window.inlineSave = async function (el) {
  var idx = parseInt(el.getAttribute('data-idx'));
  var field = el.getAttribute('data-field');
  var val;
  if (el.type === 'checkbox') {
    val = el.checked;
  } else if (el.type === 'number') {
    val = el.value ? Number(el.value) : null;
  } else {
    val = el.value;
  }

  // Normalize category/subcategory to lowercase — keep taxonomy case-consistent
  if ((field === 'category' || field === 'subcategory') && typeof val === 'string') {
    val = val.toLowerCase().replace(/\s+/g, '_');
    if (el.value !== val) el.value = val;
  }

  // Update in-memory
  _data.items[idx][field] = val;
  _data.items[idx].manual_edit = true;

  // Auto-fix related fields
  if (field === 'is_consumable') {
    _data.items[idx].stock_status = val ? 'full' : 'n/a';
  }
  // Sync account ↔ project
  if (field === 'account_number') {
    var proj = _projects.find(function (p) { return p.account_number === val; });
    if (proj) _data.items[idx].project_tag = proj.id;
  }
  if (field === 'project_tag') {
    var proj = _projects.find(function (p) { return p.id === val; });
    if (proj) _data.items[idx].account_number = proj.account_number;
  }

  // Optimistic save: keep _items in sync immediately, fire surgical write
  // in background. The flash-green is shown right away; if the background
  // save fails it logs but the UI doesn't roll back (rare; user can retry).
  _items = _data.items;
  el.style.outline = '2px solid var(--green)';
  setTimeout(function () { el.style.outline = ''; }, 600);
  _saveInvItemSurgical(_data.items[idx]).catch(function (err) {
    console.error('[inventory] inlineSave failed:', err);
  });

  // Update the table row if category/stock changed (affects the visible table)
  var row = el.closest('.detail-row');
  if (row) {
    var mainRow = row.previousElementSibling;
    if (mainRow && (field === 'category' || field === 'stock_status')) {
      // Refresh just the visible cells
      var item = _data.items[idx];
      var cells = mainRow.querySelectorAll('td');
      if (cells[1]) cells[1].textContent = (item.category || '').replace(/_/g, ' ');
      if (cells[7]) cells[7].innerHTML = stockChip(item.stock_status);
    }
  }
};

/* ---- Price history display ---- */

function priceHistoryDetail(history) {
  if (!history || !history.length) return '';
  var html = '<div style="margin-top:12px;"><strong style="font-size:12px;text-transform:uppercase;color:var(--text-muted)">Price History</strong>';
  html += '<table style="width:100%;font-size:13px;margin-top:4px;"><thead><tr><th style="text-align:left">Date</th><th>Price</th><th>Vendor</th></tr></thead><tbody>';
  var sorted = history.slice().sort(function (a, b) { return (a.date || '').localeCompare(b.date || ''); });
  sorted.forEach(function (entry, i) {
    var trend = '';
    if (i > 0 && entry.unit_price && sorted[i - 1].unit_price) {
      if (entry.unit_price > sorted[i - 1].unit_price) trend = ' <span style="color:var(--red);">&#9650;</span>';
      else if (entry.unit_price < sorted[i - 1].unit_price) trend = ' <span style="color:var(--green);">&#9660;</span>';
    }
    html += '<tr><td>' + formatDate(entry.date) + '</td><td>$' + (entry.unit_price || 0).toFixed(2) + trend + '</td><td>' + (entry.vendor || '') + '</td></tr>';
  });
  html += '</tbody></table></div>';
  return html;
}

/* ---- Filtering ---- */

function getFiltered() {
  var items = _items.slice();
  var catFilter = document.getElementById('category-filter').value;
  var stockFilter = document.getElementById('stock-filter').value;
  var search = (document.getElementById('search-input').value || '').trim().toLowerCase();

  var tab = TABS.find(function (t) { return t.key === activeTab; });
  if (tab && tab.filter) items = items.filter(tab.filter);
  if (activeSubtab !== 'all') items = items.filter(function (i) { return (i.subcategory || '') === activeSubtab; });
  if (catFilter !== 'all') items = items.filter(function (i) { return i.category === catFilter; });
  if (stockFilter !== 'all') items = items.filter(function (i) { return i.stock_status === stockFilter; });
  if (search) {
    items = items.filter(function (i) {
      return [i.name, i.description, i.vendor, i.catalogue_number, i.account_number, i.subcategory].join(' ').toLowerCase().indexOf(search) >= 0;
    });
  }
  return items;
}

/* ---- Main render ---- */

async function loadAndRender() {
  var results = await Promise.all([api.load(DATA_PATH), api.load(PROJECTS_PATH)]);
  _data = results[0];
  _items = _data.items || [];
  _projects = (results[1].projects || []);

  var tabsEl = document.getElementById('tabs');
  tabsEl.innerHTML = '';
  TABS.forEach(function (t) {
    var btn = document.createElement('button');
    btn.className = 'tab-btn' + (activeTab === t.key ? ' active' : '');
    var count = t.filter ? _items.filter(t.filter).length : _items.length;
    btn.textContent = t.label + ' (' + count + ')';
    btn.onclick = function () { activeTab = t.key; activeSubtab = 'all'; updateTabActive(); render(); };
    tabsEl.appendChild(btn);
  });

  var catFilter = document.getElementById('category-filter');
  var currentCat = catFilter.value;
  var cats = {};
  _items.forEach(function (i) { if (i.category) cats[i.category] = true; });
  catFilter.innerHTML = '<option value="all">All Categories</option>';
  Object.keys(cats).sort().forEach(function (c) {
    var opt = document.createElement('option');
    opt.value = c;
    opt.textContent = c.replace(/_/g, ' ');
    if (c === currentCat) opt.selected = true;
    catFilter.appendChild(opt);
  });

  render();
}

/* ---- Build detail panel HTML for a single item ---- */

function itemDetailHtml(item, realIdx) {
  var d = '';
  d += '<div style="display:grid;grid-template-columns:repeat(auto-fill,minmax(220px,1fr));gap:10px;margin-bottom:12px;">';
  d += '<div><label class="detail-meta-label">Category</label>' + inlineSelect(realIdx, 'category', item.category, CATEGORY_OPTIONS) + '</div>';
  d += '<div><label class="detail-meta-label">Subcategory</label>' + inlineText(realIdx, 'subcategory', item.subcategory, 'e.g. electronics, ppe') + '</div>';
  d += '<div><label class="detail-meta-label">Stock Status</label>' + inlineSelect(realIdx, 'stock_status', item.stock_status, STOCK_OPTIONS) + '</div>';
  d += '<div><label class="detail-meta-label">Condition</label>' + inlineSelect(realIdx, 'condition', item.condition, CONDITION_OPTIONS) + '</div>';
  var acctOptions = _projects.map(function (p) { return p.account_number; });
  var projOptions = _projects.map(function (p) { return p.id; });
  d += '<div><label class="detail-meta-label">Account #</label>' + inlineSelect(realIdx, 'account_number', item.account_number, acctOptions) + '</div>';
  d += '<div><label class="detail-meta-label">Project</label>' + inlineSelect(realIdx, 'project_tag', item.project_tag, projOptions) + '</div>';
  d += '<div><label class="detail-meta-label">Consumable?</label>' + inlineCheckbox(realIdx, 'is_consumable', item.is_consumable) + '</div>';
  d += '<div><label class="detail-meta-label">Quantity</label>' + inlineText(realIdx, 'quantity', String(item.quantity || ''), '') + '</div>';
  d += '</div>';
  d += '<div style="display:grid;grid-template-columns:1fr 1fr;gap:10px;margin-bottom:12px;">';
  d += '<div><label class="detail-meta-label">Name</label>' + inlineText(realIdx, 'name', item.name, '') + '</div>';
  d += '<div><label class="detail-meta-label">Vendor</label>' + inlineText(realIdx, 'vendor', item.vendor, '') + '</div>';
  d += '</div>';
  d += '<div style="margin-bottom:12px;"><label class="detail-meta-label">Notes</label>' + inlineTextarea(realIdx, 'notes', item.notes, 'Add notes...') + '</div>';
  d += '<div class="detail-meta" style="margin-bottom:12px;">';
  if (item.date_acquired) d += '<div class="detail-meta-item"><span class="detail-meta-label">Date Acquired</span><span class="detail-meta-value">' + formatDate(item.date_acquired) + '</span></div>';
  if (item.catalogue_number) d += '<div class="detail-meta-item"><span class="detail-meta-label">Catalogue #</span><span class="detail-meta-value">' + item.catalogue_number + '</span></div>';
  if (item.funding_source) d += '<div class="detail-meta-item"><span class="detail-meta-label">Funding</span><span class="detail-meta-value">' + item.funding_source + '</span></div>';
  d += '</div>';
  d += '<div style="margin-bottom:12px;border-top:1px solid var(--border);padding-top:10px;">';
  d += '<div style="display:flex;align-items:center;justify-content:space-between;margin-bottom:6px;"><strong style="font-size:12px;text-transform:uppercase;color:var(--text-muted);">Locations</strong>';
  d += '<button class="btn btn-sm btn-primary" onclick="event.stopPropagation(); addLocation(' + realIdx + ')">+ Add</button></div>';
  if (item.locations && item.locations.length) {
    d += '<table style="width:100%;font-size:13px;"><thead><tr><th style="text-align:left">Location</th><th>Qty</th><th>Notes</th><th></th></tr></thead><tbody>';
    item.locations.forEach(function (loc, li) {
      d += '<tr><td>' + loc.name + '</td><td style="text-align:center;">' + (loc.quantity || '') + '</td><td style="color:var(--text-muted);">' + (loc.notes || '') + '</td>';
      d += '<td class="row-actions"><button onclick="event.stopPropagation(); editLocation(' + realIdx + ',' + li + ')">Edit</button><button onclick="event.stopPropagation(); removeLocation(' + realIdx + ',' + li + ')">Del</button></td></tr>';
    });
    d += '</tbody></table>';
  } else { d += '<div style="color:var(--text-muted);font-size:13px;">No locations assigned</div>'; }
  d += '</div>';
  d += priceHistoryDetail(item.price_history);
  if (item.receipt_ref && item.receipt_ref.source_file) {
    var r = item.receipt_ref;
    d += '<div style="margin-top:12px;border-top:1px solid var(--border);padding-top:10px;"><strong style="font-size:12px;text-transform:uppercase;color:var(--text-muted);">Source Receipt</strong>';
    d += '<div style="font-size:13px;margin-top:4px;">' + r.source_file;
    if (r.po_number) d += ' &middot; PO# ' + r.po_number;
    if (r.order_number) d += ' &middot; Order# ' + r.order_number;
    if (r.receipt_total) d += ' &middot; $' + r.receipt_total.toFixed(2);
    d += '</div></div>';
  }
  if (item.reorder && (item.reorder.vendor || item.reorder.catalogue_number)) {
    d += '<div style="margin-top:12px;border-top:1px solid var(--border);padding-top:10px;"><strong style="font-size:12px;text-transform:uppercase;color:var(--text-muted);">Reorder Info</strong><div style="font-size:13px;margin-top:4px;">';
    if (item.reorder.vendor) d += item.reorder.vendor;
    if (item.reorder.catalogue_number) d += ' &middot; Cat# ' + item.reorder.catalogue_number;
    if (item.reorder.last_price) d += ' &middot; $' + item.reorder.last_price.toFixed(2);
    if (item.reorder.url) d += ' &middot; <a href="' + item.reorder.url + '" target="_blank" style="color:var(--primary);">Order Link</a>';
    d += '</div></div>';
  }
  d += '<div style="margin-top:16px;border-top:1px solid var(--border);padding-top:10px;">';
  d += '<button class="btn btn-sm" onclick="event.stopPropagation(); addToGroup(' + realIdx + ')" style="margin-right:8px;">Add to Group</button>';
  if (item.product_group) {
    d += '<button class="btn btn-sm" onclick="event.stopPropagation(); removeFromGroup(' + realIdx + ')" style="margin-right:8px;">Remove from Group</button>';
  }
  d += '<button class="btn" style="color:var(--red);border-color:var(--red);" onclick="event.stopPropagation(); deleteItem(' + realIdx + ')">Delete Item</button>';
  d += '</div>';
  return d;
}

/* ---- Main render ---- */

function render() {
  var items = getFiltered();
  var content = document.getElementById('content');

  // Subtabs
  var tab = TABS.find(function (t) { return t.key === activeTab; });
  var tabItems = tab && tab.filter ? _items.filter(tab.filter) : _items;
  var subcats = {};
  tabItems.forEach(function (i) { var sub = i.subcategory || ''; if (sub) subcats[sub] = (subcats[sub] || 0) + 1; });

  var html = '';
  var sortedSubs = Object.entries(subcats).sort(function (a, b) { return b[1] - a[1]; });
  if (sortedSubs.length > 1 && activeTab !== 'all' && activeTab !== 'low_stock') {
    html += '<div style="display:flex;gap:6px;flex-wrap:wrap;margin-bottom:12px;">';
    html += '<button class="btn btn-sm' + (activeSubtab === 'all' ? ' btn-primary' : '') + '" onclick="setSubtab(\'all\')" style="font-size:12px;">All (' + tabItems.length + ')</button>';
    sortedSubs.forEach(function (kv) {
      var label = SUBTAB_LABELS[kv[0]] || kv[0].replace(/_/g, ' ');
      label = label.charAt(0).toUpperCase() + label.slice(1);
      html += '<button class="btn btn-sm' + (activeSubtab === kv[0] ? ' btn-primary' : '') + '" onclick="setSubtab(\'' + kv[0] + '\')" style="font-size:12px;">' + label + ' (' + kv[1] + ')</button>';
    });
    html += '</div>';
  }

  // Summary cards
  var totalValue = _items.reduce(function (s, i) { return s + (i.extended_price || i.unit_price || 0); }, 0);
  var lowCount = _items.filter(function (i) { return i.stock_status === 'low' || i.stock_status === 'out_of_stock'; }).length;

  html += '<div style="display:flex;gap:12px;margin-bottom:16px;flex-wrap:wrap;">';
  html += '<div class="card" style="flex:1;min-width:130px;padding:10px 14px;"><div class="card-title">Items</div><div class="card-count">' + _items.length + '</div></div>';
  html += '<div class="card" style="flex:1;min-width:130px;padding:10px 14px;"><div class="card-title">Value</div><div class="card-count">$' + totalValue.toLocaleString(undefined, { maximumFractionDigits: 0 }) + '</div></div>';
  if (lowCount > 0) html += '<div class="card" style="flex:1;min-width:130px;padding:10px 14px;border-left:3px solid var(--amber);"><div class="card-title">Low / Out</div><div class="card-count" style="color:var(--amber);">' + lowCount + '</div></div>';
  html += '</div>';

  if (items.length === 0) {
    html += '<div class="empty-state">No items match your filters.</div>';
    content.innerHTML = html;
    return;
  }

  // Group items by product_group
  var grouped = [];     // { group: slug, name: str, items: [...] }
  var groupMap = {};
  items = sortItems(items, _sortKey, _sortDir, TABLE_COLUMNS);

  items.forEach(function (item) {
    var grp = item.product_group || '';
    if (!grp) {
      grouped.push({ group: '', name: '', items: [item] });
    } else {
      if (!groupMap[grp]) {
        groupMap[grp] = { group: grp, name: item.product_group_name || grp, items: [] };
        grouped.push(groupMap[grp]);
      }
      groupMap[grp].items.push(item);
    }
  });

  html += '<div style="font-size:13px;color:var(--text-muted);margin-bottom:8px;">' + items.length + ' items in ' + grouped.length + ' rows</div>';
  html += '<table class="data-table">';
  html += sortableHeader(TABLE_COLUMNS, _sortKey, _sortDir, 'onInventorySort');
  html += '<tbody>';

  var rowIdx = 0;
  grouped.forEach(function (entry) {
    var isFamily = entry.items.length > 1;

    if (!isFamily) {
      // ---- Singleton: one row + detail panel (same as before) ----
      var item = entry.items[0];
      var realIdx = _items.indexOf(item);
      var rid = 'r' + rowIdx;

      var cells = '<td><strong>' + (item.name || '') + '</strong></td>';
      cells += '<td>' + (item.category || '').replace(/_/g, ' ') + '</td>';
      cells += '<td>' + (item.vendor || '') + '</td>';
      cells += '<td style="font-size:12px;">' + (item.catalogue_number || '') + '</td>';
      cells += '<td>' + (item.quantity || '') + '</td>';
      cells += '<td>' + (item.unit_price != null ? '$' + item.unit_price.toFixed(2) : '') + '</td>';
      cells += '<td>' + locationsChips(item.locations) + '</td>';
      cells += '<td>' + stockChip(item.stock_status) + '</td>';

      html += '<tr class="expandable-row" onclick="toggleRow(\'' + rid + '\')" data-rid="' + rid + '">' + cells + '</tr>';
      html += '<tr class="detail-row" id="detail-' + rid + '"><td colspan="8"><div class="detail-panel" onclick="event.stopPropagation();">' + itemDetailHtml(item, realIdx) + '</div></td></tr>';
      rowIdx++;

    } else {
      // ---- Product family: group header row → variant rows → detail panels ----
      var gid = 'g' + rowIdx;
      var totalQty = entry.items.reduce(function (s, i) { return s + (i.quantity || 0); }, 0);
      var totalVal = entry.items.reduce(function (s, i) { return s + (i.extended_price || i.unit_price || 0); }, 0);
      var sharedCat = entry.items[0].category || '';
      var sharedVendor = entry.items[0].vendor || '';

      // Group header row — star uses first item's index
      var firstRealIdx = _items.indexOf(entry.items[0]);
      var anyPreferred = entry.items.some(function (it) { return it.preferred; });
      var gcells = '<td>' + starHtml(firstRealIdx, anyPreferred) + ' <strong style="color:var(--primary);">' + entry.name + '</strong> <span class="chip chip-muted" style="font-size:11px;">' + entry.items.length + ' variants</span></td>';
      gcells += '<td>' + sharedCat.replace(/_/g, ' ') + '</td>';
      gcells += '<td>' + sharedVendor + '</td>';
      gcells += '<td></td>';
      gcells += '<td>' + totalQty + '</td>';
      gcells += '<td>$' + totalVal.toFixed(2) + '</td>';
      gcells += '<td></td>';
      gcells += '<td></td>';

      html += '<tr class="expandable-row group-row" onclick="toggleRow(\'' + gid + '\')" data-rid="' + gid + '" style="border-left:3px solid var(--primary);background:#f8faff;">' + gcells + '</tr>';

      // Group expand: contains group-level edit + variant sub-table
      var gDetail = '';

      // Group-level bulk edit
      var memberIndices = entry.items.map(function (i) { return _items.indexOf(i); });
      var indicesStr = memberIndices.join(',');
      gDetail += '<div style="padding:8px 0 12px;border-bottom:1px solid var(--border);margin-bottom:12px;">';
      gDetail += '<strong style="font-size:12px;text-transform:uppercase;color:var(--text-muted);">Apply to all ' + entry.items.length + ' variants</strong>';
      gDetail += '<div style="display:flex;gap:12px;margin-top:6px;flex-wrap:wrap;align-items:end;">';
      gDetail += '<div><label class="detail-meta-label">Category</label><select onchange="cascadeField(\'' + indicesStr + '\',\'category\',this.value)" style="font-size:13px;padding:3px 6px;border:1px solid var(--border);border-radius:4px;">';
      gDetail += '<option value="">— no change —</option>';
      CATEGORY_OPTIONS.forEach(function (opt) { gDetail += '<option value="' + opt + '">' + opt.replace(/_/g, ' ') + '</option>'; });
      gDetail += '</select></div>';
      gDetail += '<div><label class="detail-meta-label">Project / Account</label><select onchange="cascadeProject(\'' + indicesStr + '\',this.value)" style="font-size:13px;padding:3px 6px;border:1px solid var(--border);border-radius:4px;">';
      gDetail += '<option value="">— no change —</option>';
      _projects.forEach(function (p) { gDetail += '<option value="' + p.id + '">' + p.name + ' (' + p.account_number + ')</option>'; });
      gDetail += '</select></div>';
      gDetail += '<div><label class="detail-meta-label">Stock Status</label><select onchange="cascadeField(\'' + indicesStr + '\',\'stock_status\',this.value)" style="font-size:13px;padding:3px 6px;border:1px solid var(--border);border-radius:4px;">';
      gDetail += '<option value="">— no change —</option>';
      STOCK_OPTIONS.forEach(function (opt) { gDetail += '<option value="' + opt + '">' + opt.replace(/_/g, ' ') + '</option>'; });
      gDetail += '</select></div>';
      gDetail += '</div></div>';

      // Variant sub-rows
      entry.items.forEach(function (item, vi) {
        var realIdx = _items.indexOf(item);
        var vid = gid + 'v' + vi;
        gDetail += '<div class="variant-row" onclick="event.stopPropagation(); toggleVariant(\'' + vid + '\')" style="cursor:pointer;padding:8px 12px;border:1px solid var(--border);border-radius:var(--radius);margin-bottom:6px;background:var(--surface);">';
        gDetail += '<div style="display:flex;justify-content:space-between;align-items:center;">';
        gDetail += '<div><strong>' + (item.name || '') + '</strong>';
        if (item.catalogue_number) gDetail += ' <span style="color:var(--text-muted);font-size:12px;">Cat# ' + item.catalogue_number + '</span>';
        gDetail += '</div>';
        gDetail += '<div style="display:flex;gap:12px;align-items:center;font-size:13px;">';
        if (item.unit_price != null) gDetail += '<span>$' + item.unit_price.toFixed(2) + '</span>';
        gDetail += '<span>Qty: ' + (item.quantity || 0) + '</span>';
        gDetail += stockChip(item.stock_status);
        if (item.price_history && item.price_history.length > 1) gDetail += '<span class="chip chip-muted" style="font-size:11px;">' + item.price_history.length + ' orders</span>';
        gDetail += '</div></div>';
        // Variant detail (hidden by default)
        gDetail += '<div id="vdetail-' + vid + '" style="display:none;margin-top:10px;padding-top:10px;border-top:1px solid var(--border);" onclick="event.stopPropagation();">';
        gDetail += itemDetailHtml(item, realIdx);
        gDetail += '</div>';
        gDetail += '</div>';
      });

      html += '<tr class="detail-row" id="detail-' + gid + '"><td colspan="8"><div class="detail-panel" onclick="event.stopPropagation();">' + gDetail + '</div></td></tr>';
      rowIdx++;
    }
  });

  html += '</tbody></table>';
  content.innerHTML = html;
}

/* ---- Expand/collapse ---- */

var _expandedRow = '';
var _expandedVariant = '';

window.toggleRow = function (rid) {
  var allRows = document.querySelectorAll('.expandable-row');
  var allDetails = document.querySelectorAll('.detail-row');

  if (_expandedRow === rid) {
    allRows.forEach(function (r) { r.classList.remove('expanded'); });
    allDetails.forEach(function (r) { r.classList.remove('open'); });
    _expandedRow = '';
    return;
  }

  allRows.forEach(function (r) { r.classList.remove('expanded'); });
  allDetails.forEach(function (r) { r.classList.remove('open'); });

  var row = document.querySelector('tr.expandable-row[data-rid="' + rid + '"]');
  var detail = document.getElementById('detail-' + rid);
  if (row) row.classList.add('expanded');
  if (detail) detail.classList.add('open');
  _expandedRow = rid;
};

window.toggleVariant = function (vid) {
  var el = document.getElementById('vdetail-' + vid);
  if (!el) return;
  if (_expandedVariant === vid) {
    el.style.display = 'none';
    _expandedVariant = '';
  } else {
    // Close previous variant
    if (_expandedVariant) {
      var prev = document.getElementById('vdetail-' + _expandedVariant);
      if (prev) prev.style.display = 'none';
    }
    el.style.display = 'block';
    _expandedVariant = vid;
  }
};

/* ---- Cascade edit to all variants in a group ---- */

window.cascadeField = function (indicesStr, field, value) {
  var indices = indicesStr.split(',').map(Number);
  if (!confirmAction('Apply ' + field.replace(/_/g, ' ') + ' = "' + value + '" to all ' + indices.length + ' variants?')) return;
  var touched = [];
  indices.forEach(function (idx) {
    _data.items[idx][field] = value;
    _data.items[idx].manual_edit = true;
    touched.push(_data.items[idx]);
  });
  _items = _data.items;
  render();
  _saveInvItemsSurgical(touched).catch(function (err) {
    console.error('[inventory] cascadeField save failed:', err);
  });
};

/* ---- Cascade project + account to group ---- */

window.cascadeProject = function (indicesStr, projectId) {
  if (!projectId) return;
  var proj = _projects.find(function (p) { return p.id === projectId; });
  if (!proj) return;
  var indices = indicesStr.split(',').map(Number);
  if (!confirmAction('Set all ' + indices.length + ' variants to "' + proj.name + '" (account ' + proj.account_number + ')?')) return;
  var touched = [];
  indices.forEach(function (idx) {
    _data.items[idx].account_number = proj.account_number;
    _data.items[idx].project_tag = proj.id;
    _data.items[idx].manual_edit = true;
    touched.push(_data.items[idx]);
  });
  _items = _data.items;
  render();
  _saveInvItemsSurgical(touched).catch(function (err) {
    console.error('[inventory] cascadeProject save failed:', err);
  });
};

/* ---- Star / Preferred ---- */

window.togglePreferred = function (index) {
  // If this item is in a group, toggle all group members.
  var item = _data.items[index];
  var grp = item.product_group;
  var touched = [];
  if (grp) {
    var newVal = !item.preferred;
    _data.items.forEach(function (it) {
      if (it.product_group === grp) {
        it.preferred = newVal;
        it.manual_edit = true;
        touched.push(it);
      }
    });
  } else {
    _data.items[index].preferred = !_data.items[index].preferred;
    _data.items[index].manual_edit = true;
    touched.push(_data.items[index]);
  }
  // Render NOW — star fills/empties under the click without waiting.
  _items = _data.items;
  render();
  // Surgical save in background (one doc per touched item, not 775).
  _saveInvItemsSurgical(touched).catch(function (err) {
    console.error('[inventory] togglePreferred save failed:', err);
  });
};

/* ---- Manual Group Management ---- */

window.createManualGroup = function () {
  openForm({
    title: 'Create Product Group',
    fields: [
      { key: 'name', label: 'Group Name', type: 'text', required: true, placeholder: 'e.g. Dispensing Needles, Lab Coats' },
    ],
    onSave: async function (vals) {
      var groupSlug = slugify(vals.name);
      // Check if group already exists
      var exists = _data.items.some(function (i) { return i.product_group === groupSlug; });
      if (exists) {
        alert('A group named "' + vals.name + '" already exists. Use "Add to Group" on individual items instead.');
        return;
      }
      alert('Group "' + vals.name + '" created. Now use the "Add to Group" option in any item\'s detail panel to add items to it.');
      // Store the group name so it's available for selection
      if (!_data._custom_groups) _data._custom_groups = [];
      _data._custom_groups.push({ slug: groupSlug, name: vals.name });
      await api.save(DATA_PATH, _data);
    },
  });
};

window.addToGroup = function (realIdx) {
  // Collect all existing group names
  var groups = {};
  _data.items.forEach(function (i) {
    if (i.product_group && i.product_group_name) {
      groups[i.product_group] = i.product_group_name;
    }
  });
  // Also include custom groups
  (_data._custom_groups || []).forEach(function (g) {
    groups[g.slug] = g.name;
  });

  var groupList = Object.entries(groups).sort(function (a, b) { return a[1].localeCompare(b[1]); });
  var options = groupList.map(function (kv) { return kv[0]; });
  var optionLabels = groupList.map(function (kv) { return kv[1]; });

  openForm({
    title: 'Add to Product Group',
    fields: [
      { key: 'group', label: 'Select Group', type: 'select', required: true, options: optionLabels },
      { key: 'new_group', label: 'Or Create New Group', type: 'text', placeholder: 'Leave blank to use selection above' },
    ],
    onSave: async function (vals) {
      var groupSlug, groupName;
      if (vals.new_group && vals.new_group.trim()) {
        groupName = vals.new_group.trim();
        groupSlug = slugify(groupName);
      } else {
        var selectedIdx = optionLabels.indexOf(vals.group);
        if (selectedIdx < 0) return;
        groupSlug = options[selectedIdx];
        groupName = optionLabels[selectedIdx];
      }
      _data.items[realIdx].product_group = groupSlug;
      _data.items[realIdx].product_group_name = groupName;
      _data.items[realIdx].manual_edit = true;
      await api.save(DATA_PATH, _data);
      _items = _data.items;
      loadAndRender();
    },
  });
};

window.removeFromGroup = async function (realIdx) {
  _data.items[realIdx].product_group = '';
  _data.items[realIdx].product_group_name = '';
  _data.items[realIdx].manual_edit = true;
  await api.save(DATA_PATH, _data);
  _items = _data.items;
  loadAndRender();
};

/* ---- Delete ---- */

window.deleteItem = async function (index) {
  if (!confirmAction('Remove this item from inventory?')) return;
  _data.items.splice(index, 1);
  await api.save(DATA_PATH, _data);
  loadAndRender();
};

/* ---- Add new item (still uses modal since there's no row to expand) ---- */

document.getElementById('add-item').onclick = function () {
  var ADD_FIELDS = [
    { key: 'name', label: 'Item Name', type: 'text', required: true },
    { key: 'vendor', label: 'Vendor', type: 'text' },
    { key: 'catalogue_number', label: 'Catalogue #', type: 'text' },
    { key: 'quantity', label: 'Quantity', type: 'number' },
    { key: 'unit_price', label: 'Unit Price ($)', type: 'number' },
    { key: 'date_acquired', label: 'Date Acquired', type: 'date' },
    { key: 'category', label: 'Category', type: 'select', options: CATEGORY_OPTIONS },
    { key: 'account_number', label: 'Account Number', type: 'text', placeholder: 'e.g. 1101935' },
    { key: 'notes', label: 'Notes', type: 'textarea' },
  ];
  openForm({
    title: 'Add Inventory Item',
    fields: ADD_FIELDS,
    onSave: async function (vals) {
      vals.id = slugify((vals.vendor || '') + '-' + (vals.date_acquired || '') + '-' + (vals.name || ''));
      vals.vendor_normalized = slugify(vals.vendor || '');
      vals.subcategory = '';
      vals.is_consumable = ['consumable', 'research_reagents', 'research_chem', 'research_cells', 'research_gas', 'research_gels', 'research_analysis'].indexOf(vals.category) >= 0;
      vals.condition = 'active';
      vals.stock_status = vals.is_consumable ? 'full' : 'n/a';
      vals.locations = [];
      vals.price_history = [];
      vals.tags = [];
      if (vals.unit_price && vals.date_acquired) {
        vals.price_history.push({ date: vals.date_acquired, unit_price: Number(vals.unit_price), vendor: vals.vendor || '', receipt_id: vals.id });
      }
      vals.reorder = { url: '', vendor: vals.vendor || '', catalogue_number: vals.catalogue_number || '', last_price: vals.unit_price ? Number(vals.unit_price) : null, lead_time_days: null, notes: '' };
      vals.receipt_ref = null;
      vals.safety = null;
      vals.manual_edit = true;
      vals.parsed_at = '';
      vals.parse_confidence = 0;
      _data.items.push(vals);
      await api.save(DATA_PATH, _data);
      loadAndRender();
    },
  });
};

/* ---- Subtab switcher ---- */

window.setSubtab = function (key) {
  activeSubtab = key;
  render();
};

/* ---- Location CRUD ---- */

window.addLocation = function (itemIdx) {
  openForm({
    title: 'Add Location',
    fields: LOCATION_FIELDS,
    onSave: async function (vals) {
      if (!_data.items[itemIdx].locations) _data.items[itemIdx].locations = [];
      _data.items[itemIdx].locations.push(vals);
      _data.items[itemIdx].manual_edit = true;
      await api.save(DATA_PATH, _data);
      loadAndRender();
    },
  });
};

window.editLocation = function (itemIdx, locIdx) {
  var loc = _data.items[itemIdx].locations[locIdx];
  openForm({
    title: 'Edit Location',
    fields: LOCATION_FIELDS,
    values: loc,
    onSave: async function (vals) {
      Object.assign(_data.items[itemIdx].locations[locIdx], vals);
      _data.items[itemIdx].manual_edit = true;
      await api.save(DATA_PATH, _data);
      loadAndRender();
    },
  });
};

window.removeLocation = async function (itemIdx, locIdx) {
  if (!confirmAction('Remove this location?')) return;
  _data.items[itemIdx].locations.splice(locIdx, 1);
  _data.items[itemIdx].manual_edit = true;
  await api.save(DATA_PATH, _data);
  loadAndRender();
};

/* ---- Sort ---- */

window.onInventorySort = function (key) {
  if (_sortKey === key) {
    _sortDir = _sortDir === 'asc' ? 'desc' : 'asc';
  } else {
    _sortKey = key;
    _sortDir = 'asc';
  }
  render();
};

/* ---- Filters ---- */

document.getElementById('category-filter').onchange = function () { render(); };
document.getElementById('stock-filter').onchange = function () { render(); };
document.getElementById('search-input').oninput = function () { render(); };

/* ---- Live tab-to-tab sync ----
 *
 * Inventory is a lab-shared collection (`inventory/{id}` where kind=='item'),
 * so any team member's edits should propagate to other tabs/users in real
 * time. Wrap api.save for DATA_PATH to set save/suppress gates, subscribe
 * to the same path, and on remote change update _data + re-render.
 */
var _invLive = { suppressUntil: 0, savePending: false, refreshTimer: null, unsubs: [] };

function _invWrapSaves() {
  if (_invWrapSaves._wrapped) return;
  _invWrapSaves._wrapped = true;
  var origSave = api.save.bind(api);
  api.save = async function (path, data) {
    var isInvPath = (path === DATA_PATH);
    if (isInvPath) {
      _invLive.savePending = true;
      _invLive.suppressUntil = Date.now() + 2500;
    }
    try { return await origSave(path, data); }
    finally { if (isInvPath) _invLive.savePending = false; }
  };
}

function _invScheduleRefresh() {
  if (_invLive.refreshTimer) return;
  _invLive.refreshTimer = setTimeout(function () {
    _invLive.refreshTimer = null;
    var scrollY = window.scrollY;
    var active = document.activeElement;
    var activeId = active && active.id;
    try { render(); }
    catch (err) { console.warn('[inventory] live-sync re-render failed:', err); }
    finally {
      window.scrollTo({ top: scrollY, left: 0, behavior: 'instant' });
      if (activeId) {
        var el = document.getElementById(activeId);
        if (el) { try { el.focus(); } catch (e) {} }
      }
    }
  }, 200);
}

function _invAttachLiveSync() {
  if (typeof api.subscribe !== 'function') return;
  if (_invLive.unsubs.length) return;
  try {
    var firstFireConsumed = false;
    var unsub = api.subscribe(DATA_PATH, function (data) {
      if (Date.now() < _invLive.suppressUntil) return;
      if (_invLive.savePending) return;
      if (!data || !Array.isArray(data.items)) return;
      _data = data;
      _items = data.items;
      if (!firstFireConsumed) { firstFireConsumed = true; return; }
      _invScheduleRefresh();
    });
    _invLive.unsubs.push(unsub);
  } catch (err) {
    console.warn('[inventory] live sync attach failed:', err.message);
  }
}

/* ---- Init ---- */

(async function () {
  if (typeof firebridge !== 'undefined' && firebridge.whenAuthResolved) await firebridge.whenAuthResolved();
  _invWrapSaves();
  await loadAndRender();
  _invAttachLiveSync();
})();
