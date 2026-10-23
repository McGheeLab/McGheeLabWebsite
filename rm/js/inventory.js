/* inventory.js — lab inventory with inline editing, multi-location, subtabs */

var DATA_PATH = 'inventory/items.json';
var PROJECTS_PATH = 'finance/projects.json';
var DATA_KEY = 'items';
var activeTab = 'all';
var _items = [];
var _data = null; // keep loaded data reference for inline saves
var _projects = []; // funded projects/grants

var CATEGORY_OPTIONS = [
  'equipment', 'infrastructure', 'consumable', 'computer', 'lab_furniture', 'lab_made', 'office',
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
  { key: 'lab_made', label: 'Custom Items', filter: function (i) { return !!i.lab_made; }},   // V3.873, V3.875
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
  custom_aliquot: 'Custom aliquots', custom_material: 'Custom materials', custom_media: 'Custom media',   // V3.875
  aliquot: 'Aliquots', made_in_lab: 'Made in lab',   // V3.873's subcategories
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
    return '<span class="chip chip-muted" style="margin:1px;">' + escAttr(loc.name) + qty + '</span>';
  }).join(' ');
}

/* V3.873 — custom items (aliquots, materials, media made in the lab) are
 * ordinary items with lab_made:true, so every surface that reads items sees
 * them unchanged. V3.875 — the kinds and their words live in INV_MADE_CORE. */
function labMadeLabel(item) {
  return typeof INV_MADE_CORE !== 'undefined' ? INV_MADE_CORE.typeLabel(INV_MADE_CORE.typeOf(item)) : 'Custom item';
}

function labMadeChip(item) {
  if (!item || !item.lab_made) return '';
  return ' <span class="chip chip-muted" style="font-size:11px;color:var(--primary);">' + labMadeLabel(item) + '</span>';
}

/* V3.873 — a tracked item's Qty is what is LEFT (qty_remaining moves with
 * every scan); the legacy `quantity` stays at whatever it was entered as. */
function qtyCell(item) {
  if (!_invTracked(item)) return item.quantity || '';
  var rem = INV_QTY.clean(INV_QTY.num(item.qty_remaining));
  var word = typeof INV_MADE_CORE !== 'undefined' ? INV_MADE_CORE.unitWord(item.qty_unit || '', rem) : (item.qty_unit === 'uL' ? 'µL' : (item.qty_unit || ''));
  // V3.875 — a group's container size: "4 tubes · 15 mL each"
  var each = item.each_amount && typeof INV_MADE_CORE !== 'undefined' ? ' · ' + INV_MADE_CORE.amountText(item.each_amount, item.each_unit) + ' each' : '';
  return rem + ((word || each) ? ' <span style="color:var(--text-muted);font-size:12px;">' + escAttr(word + each) + '</span>' : '');
}

/* V3.875 — what a custom item was made from, as recorded when it was made:
 * each line says whether that amount was taken off the inventory or only
 * noted (see INV_MADE_CORE.planIngredient). Names link to the item. */
function madeFromHtml(item) {
  var comp = (item && item.composition) || [];
  if (!comp.length) return '';
  var word = function (n, u) { return typeof INV_MADE_CORE !== 'undefined' ? INV_MADE_CORE.amountText(n, u) : n + ' ' + u; };
  var d = '<div style="margin-bottom:12px;border-top:1px solid var(--border);padding-top:10px;">' +
          '<strong style="font-size:12px;text-transform:uppercase;color:var(--text-muted);">Made from</strong><ul style="margin:6px 0 0;padding-left:18px;font-size:13px;">';
  comp.forEach(function (c) {
    var known = c.itemId && /^[\w.-]+$/.test(c.itemId) && _items.some(function (i) { return i.id === c.itemId; });   // ids are slugs; the test keeps the onclick literal safe
    var name = known ? '<a href="?item=' + encodeURIComponent(c.itemId) + '" onclick="event.preventDefault(); event.stopPropagation(); _invOpenItem(\'' + escAttr(c.itemId) + '\');">' + escAttr(c.name || c.itemId) + '</a>' : escAttr(c.name || c.itemId || '');
    d += '<li>' + name + ' \u2014 ' + escAttr(word(c.qty, c.unit)) +
         ' <span style="color:var(--text-muted);">' + (c.taken ? '(' + escAttr(word(c.taken_qty, c.taken_unit)) + ' taken off)' : '(noted, not taken off)') + '</span></li>';
  });
  return d + '</ul></div>';
}

function vendorCell(item) {
  if (item.lab_made) return '<span style="color:var(--text-muted);">' + (item.made_by_name ? 'made by ' + escAttr(item.made_by_name) : 'made in lab') + '</span>';
  return item.vendor || '';
}

/* ---- V3.646 — tracked quantity ----------------------------------------
 *
 * The block that finally makes `stock_status` mean something. Everything here
 * is additive: an item without qty_tracked renders exactly what it did before,
 * plus one manager-only "Track quantity" affordance.
 *
 * All arithmetic and every write goes through INV_QTY so the ledger's
 * before/after chain is the single source of truth — this file only paints. */

function _invTracked(item) {
  return typeof INV_QTY !== 'undefined' && INV_QTY.isTracked(item);
}

function _invCanManage() {
  if (typeof firebridge === 'undefined') return false;
  if (firebridge.isAdmin && firebridge.isAdmin()) return true;
  return !!(firebridge.hasCapability && firebridge.hasCapability('inventory:manage'));
}

function _invQtyBlockHtml(item, realIdx) {
  if (typeof INV_QTY === 'undefined') return '';
  var mgr = _invCanManage();
  var d = '<div style="margin-bottom:12px;border-top:1px solid var(--border);padding-top:10px;">';
  d += '<div style="display:flex;align-items:center;justify-content:space-between;gap:8px;flex-wrap:wrap;margin-bottom:6px;">';
  d += '<strong style="font-size:12px;text-transform:uppercase;color:var(--text-muted);">Quantity</strong>';

  if (!_invTracked(item)) {
    d += '</div>';
    d += '<div style="font-size:13px;color:var(--text-muted);">Not tracked' +
         (item.quantity ? ' — the Qty column shows ' + escAttr(String(item.quantity)) + ', which nothing checks or decrements.' : '.') +
         '</div>';
    if (mgr) {
      d += '<button class="btn btn-sm btn-primary" style="margin-top:6px;" ' +
           'onclick="event.stopPropagation(); invTrackQty(' + realIdx + ')">Track quantity</button>';
    }
    d += '</div>';
    return d;
  }

  var sev = INV_QTY.severity(item);
  var frac = INV_QTY.fractionLeft(item);
  d += '<span>';
  d += '<button class="btn btn-sm btn-primary" onclick="event.stopPropagation(); invTakeQty(' + realIdx + ')">I took some</button>';
  if (mgr) {
    d += ' <button class="btn btn-sm" onclick="event.stopPropagation(); invRecountQty(' + realIdx + ')">Correct</button>';
  }
  d += '</span></div>';

  d += '<div style="font-size:18px;font-weight:650;">' + escAttr(INV_QTY.summary(item)) + '</div>';
  if (frac != null) {
    var col = sev === 'out' ? 'var(--red)' : sev === 'low' ? 'var(--amber)' : 'var(--green)';
    d += '<div style="height:6px;border-radius:3px;background:var(--border);overflow:hidden;margin-top:5px;max-width:320px;">' +
         '<i style="display:block;height:100%;width:' + Math.round(frac * 100) + '%;background:' + col + ';"></i></div>';
  }
  var bits = [];
  if (item.qty_min != null && item.qty_min !== '') bits.push('reorder at ' + escAttr(String(item.qty_min)) + (item.qty_unit ? ' ' + escAttr(item.qty_unit) : ''));
  else if (INV_QTY.num(item.qty_made) > 0) bits.push('flags low under ' + Math.round(INV_QTY.LOW_PCT * 100) + '% of the batch');
  if (bits.length) d += '<div style="font-size:12px;color:var(--text-muted);margin-top:4px;">' + bits.join(' · ') + '</div>';

  d += '<details style="margin-top:8px;" ontoggle="event.stopPropagation(); invLoadUsage(this, ' + realIdx + ')">' +
       '<summary style="font-size:13px;cursor:pointer;color:var(--primary);">Recent usage</summary>' +
       '<div class="inv-usage" style="font-size:13px;margin-top:6px;color:var(--text-muted);">Loading…</div>' +
       '</details>';
  d += '</div>';
  return d;
}

function escAttr(v) {
  return String(v == null ? '' : v).replace(/[&<>"']/g, function (c) {
    return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c];
  });
}

window.invTakeQty = function (realIdx) {
  var item = _data.items[realIdx];
  STOCK_TAKE.open({ item: item, mode: 'take' });
};

window.invRecountQty = function (realIdx) {
  var item = _data.items[realIdx];
  STOCK_TAKE.open({ item: item, mode: 'set' });
};

/* Turning tracking on is manager-only per firestore.rules (qty_tracked is in
 * qtyControlsUnchanged) and deliberately so — it is a curation decision, not
 * something a student should trip into. Seeds from the legacy `quantity`,
 * coercing the one string row through Number(). */
window.invTrackQty = function (realIdx) {
  var item = _data.items[realIdx];
  openForm({
    title: 'Track quantity — ' + (item.name || 'item'),
    fields: [
      { key: 'unit', label: 'Unit — "ea" for countable things', type: 'select',
        required: true, options: INV_QTY.ALL_UNITS },
      { key: 'made', label: 'How much is there right now', type: 'number', required: true },
      { key: 'min', label: 'Warn a manager below this (blank = ' +
          Math.round(INV_QTY.LOW_PCT * 100) + '% of the amount above)', type: 'number' },
    ],
    values: { unit: item.qty_unit || 'ea', made: INV_QTY.num(item.quantity, 0) || '', min: '' },
    onSave: async function (vals) {
      try {
        await INV_QTY.enableTracking({
          itemId: item.id, unit: vals.unit,
          made: vals.made, min: vals.min,
        });
        if (typeof TOAST !== 'undefined') TOAST.success('Now tracking ' + (item.name || 'this item'));
      } catch (e) {
        if (typeof TOAST !== 'undefined') {
          TOAST.error(/permission-denied/i.test(e.message || '')
            ? 'Only an inventory manager can switch tracking on.'
            : (e.message || 'Could not switch tracking on.'));
        }
      }
    },
  });
};

/* The ledger is deliberately unrouted and uncached — an unbounded append-only
 * collection is the one shape the full-collection api.save model is actively
 * wrong for. So this is a live read on expand: ~20 docs, on demand, always
 * truthful. */
window.invLoadUsage = async function (details, realIdx) {
  if (!details.open) return;
  var host = details.querySelector('.inv-usage');
  if (!host || host.dataset.loaded) return;
  host.dataset.loaded = '1';
  try {
    var rows = await INV_QTY.recent(_data.items[realIdx].id, 20);
    if (!rows.length) { host.textContent = 'Nothing recorded yet.'; return; }
    host.innerHTML = '<table style="width:100%;font-size:12px;"><tbody>' + rows.map(function (r) {
      var when = r.createdAt && r.createdAt.toDate ? r.createdAt.toDate().toISOString().slice(0, 10) : '';
      var sign = r.delta > 0 ? '+' : '';
      var who = r.userInitials || r.userName || '';
      return '<tr><td style="color:var(--text-muted);">' + escAttr(when) + '</td>' +
             '<td>' + escAttr(r.event || '') + '</td>' +
             '<td style="text-align:right;font-variant-numeric:tabular-nums;">' + sign + escAttr(String(r.delta)) + ' ' + escAttr(r.unit || '') + '</td>' +
             '<td style="text-align:right;color:var(--text-muted);">→ ' + escAttr(String(r.after)) + '</td>' +
             '<td>' + escAttr(who) + '</td>' +
             '<td style="color:var(--text-muted);">' + escAttr(r.reason || r.note || '') + '</td></tr>';
    }).join('') + '</tbody></table>';
  } catch (e) {
    host.textContent = /index/i.test(e.message || '')
      ? 'Usage history needs its Firestore index — deploy firestore:indexes.'
      : 'Could not load usage history.';
  }
};

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
  return '<input type="text" data-idx="' + realIdx + '" data-field="' + field + '" value="' + escAttr(val) + '" placeholder="' + (placeholder || '') + '" onblur="inlineSave(this)" onkeydown="if(event.key===\'Enter\'){this.blur();}" style="font-size:13px;padding:3px 6px;border:1px solid var(--border);border-radius:4px;width:100%;max-width:300px;background:var(--surface);">';
}

/* V3.646 — quantity used inlineText, so inlineSave's else-branch stored the
 * raw string. One of the 777 seed rows is already a string, and the
 * group-header sum was silently concatenating instead of adding. `type=number`
 * routes through inlineSave's Number() branch instead. */
function inlineNumber(realIdx, field, currentVal, opts) {
  opts = opts || {};
  var val = (currentVal === 0 || currentVal) ? currentVal : '';
  return '<input type="number" data-idx="' + realIdx + '" data-field="' + field + '"' +
    ' value="' + String(val).replace(/"/g, '&quot;') + '"' +
    (opts.min != null ? ' min="' + opts.min + '"' : '') +
    (opts.step != null ? ' step="' + opts.step + '"' : ' step="any"') +
    ' placeholder="' + (opts.placeholder || '') + '"' +
    ' onblur="inlineSave(this)" onkeydown="if(event.key===\'Enter\'){this.blur();}"' +
    ' style="font-size:13px;padding:3px 6px;border:1px solid var(--border);border-radius:4px;width:100%;max-width:140px;background:var(--surface);">';
}

function inlineTextarea(realIdx, field, currentVal, placeholder) {
  var val = currentVal || '';
  return '<textarea data-idx="' + realIdx + '" data-field="' + field + '" placeholder="' + (placeholder || '') + '" onblur="inlineSave(this)" style="font-size:13px;padding:3px 6px;border:1px solid var(--border);border-radius:4px;width:100%;min-height:50px;background:var(--surface);resize:vertical;">' + escAttr(val) + '</textarea>';
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
    // V3.646 — a surgical write bypasses api.save, which is what normally
    // clears the route cache. Without this the MEDIUM (30 min) IndexedDB cache
    // keeps serving pre-edit data on the next page load: api.load returns
    // cached.data and only kicks a background refresh once STALE. Same fix as
    // library-links.js:99-112 ("api.invalidate (V3.485) exists for exactly
    // this"). Non-fatal — the doc is already written.
    try {
      if (typeof api !== 'undefined' && api.invalidate) await api.invalidate(DATA_PATH);
    } catch (e) { /* cache hygiene must never fail a completed write */ }
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

  // Auto-fix related fields. V3.646 — skip tracked items: their stock_status is
  // DERIVED from qty_remaining inside the usage transaction, and a hand-set
  // value here would be overwritten by the next consumption event anyway.
  if (field === 'is_consumable' && !(typeof INV_QTY !== 'undefined' && INV_QTY.isTracked(_data.items[idx]))) {
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
      // V3.873 — location names and the maker too, so "fridge/box/001" lists what is in that box.
      var locs = (i.locations || []).map(function (l) { return l && l.name; }).join(' ');
      return [i.name, i.description, i.vendor, i.catalogue_number, i.account_number, i.subcategory, locs, i.made_by_name].join(' ').toLowerCase().indexOf(search) >= 0;
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
  _invPaintChrome();
}

/* Tabs (with counts) + the category filter + the table, from what is already
 * in memory. V3.873 — split out of loadAndRender so adding one item repaints
 * the counts without refetching the whole collection. */
function _invPaintChrome() {
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

/* ---- V3.834: QR label + scan-to-use ----------------------------------
 * Alex: "for each item in the inventory, i want to add a qr code … linked to
 * the label printer … the phone app should get the ability to read the qr
 * code to use the item. some items need to be scanned per use like
 * antibodies, matrigel … Other items should be replaced as a package".
 * The label registry (labels/{CODE}), the scanner and the resolver are the
 * V3.646 blocks that never reached a page; inventory-labels.js and
 * inventory-use.js are the two new halves. */
var USE_MODE_LABEL = { '': 'Not set — asks on scan', per_use: 'Scan per use', package: 'Replace as a package' };

function invUseModeHtml(item, realIdx) {
  var mode = item.use_mode === 'per_use' || item.use_mode === 'package' ? item.use_mode : '';
  var eff = (typeof INV_USE !== 'undefined') ? INV_USE.modeOf(item) : mode;
  if (!_invCanManage()) {
    return '<span style="font-size:13px;">' + escAttr(USE_MODE_LABEL[eff] || USE_MODE_LABEL['']) + (eff && !mode ? ' <span class="detail-meta-label">(default for a consumable)</span>' : '') + '</span>';
  }
  return '<select class="btn" style="font-size:13px;" onchange="event.stopPropagation(); invSetUseMode(' + realIdx + ', this.value)" onclick="event.stopPropagation()">' +
    Object.keys(USE_MODE_LABEL).map(function (k) { return '<option value="' + k + '"' + (k === mode ? ' selected' : '') + '>' + escAttr(USE_MODE_LABEL[k]) + '</option>'; }).join('') +
    '</select>';
}

function invLabelHtml(item, realIdx) {
  var code = (item.label_code || '').toUpperCase();
  var mgr = _invCanManage();
  var d = '<div class="inv-label-block" data-item-id="' + escAttr(item.id || '') + '" style="display:flex;gap:14px;align-items:flex-start;flex-wrap:wrap;margin-bottom:12px;padding:10px 12px;border:1px solid var(--border);border-radius:10px;background:var(--card,#fff);">';
  d += '<div class="inv-qr" data-code="' + escAttr(code) + '" style="width:96px;height:96px;flex-shrink:0;display:flex;align-items:center;justify-content:center;border:1px dashed var(--border);border-radius:8px;font-size:11px;color:var(--text-muted);">' + (code ? '…' : 'no label yet') + '</div>';
  d += '<div style="flex:1;min-width:200px;">';
  d += '<strong style="font-size:12px;text-transform:uppercase;color:var(--text-muted);">QR label</strong>';
  if (code) {
    d += '<div style="font-family:ui-monospace,Menlo,monospace;font-size:15px;margin:2px 0;">' + escAttr(code) + '</div>';
    d += '<div style="font-size:12px;color:var(--text-muted);">Scan it to use this item · <a href="/l/' + escAttr(code) + '" onclick="event.stopPropagation(); return invCopyLink(' + realIdx + ', event)" title="Copy the link a phone camera opens">copy link</a></div>';
  } else {
    d += '<div style="font-size:13px;color:var(--text-muted);margin:2px 0;">No code yet — printing a label mints one and links it to this item for good.</div>';
  }
  d += '<div style="display:flex;flex-wrap:wrap;gap:6px;margin-top:8px;">';
  d += '<button class="btn btn-sm btn-primary" onclick="event.stopPropagation(); invUse(' + realIdx + ')" title="What one scan does for this item">' + ((typeof INV_USE !== 'undefined' && INV_USE.modeOf(item) === 'per_use') ? '✓ I used it' : '✓ Use / take') + '</button>';
  d += '<button class="btn btn-sm" onclick="event.stopPropagation(); invQueueLabel(' + realIdx + ')" title="Queue this label at the lab\'s label printer (Queue tab on the printer PC)">' + ICON.svg('tag') + ' Print label</button>';
  d += '<button class="btn btn-sm" onclick="event.stopPropagation(); invPrintSheet([' + realIdx + '])" title="A browser print page for sticker sheets or any other printer">' + ICON.svg('printer') + ' Sheet</button>';
  if (!code && mgr) d += '<button class="btn btn-sm" onclick="event.stopPropagation(); invMakeLabel(' + realIdx + ')" title="Mint the code without printing yet">Make code</button>';
  d += '</div></div></div>';
  if (code) invScheduleQr();
  return d;
}

var _qrScheduled = false;
function invScheduleQr() {
  if (_qrScheduled) return; _qrScheduled = true;
  setTimeout(invRenderQrBlocks, 0);
}
async function invRenderQrBlocks() {
  _qrScheduled = false;
  if (typeof INV_LABELS === 'undefined') return;
  var boxes = document.querySelectorAll('.inv-qr[data-code]:not([data-done])');
  if (!boxes.length) return;
  try { await INV_LABELS.loadQr(); } catch (e) { return; }
  boxes.forEach(function (box) {
    var code = box.getAttribute('data-code'); if (!code) return;
    INV_LABELS.qrSvg(INV_LABELS.core.payloadFor(code), 96).then(function (svg) { box.innerHTML = svg; box.style.border = 'none'; box.setAttribute('data-done', '1'); });
  });
}

window.invSetUseMode = async function (realIdx, mode) {
  var item = _data.items[realIdx];
  try { await INV_USE.setMode(item, mode); if (typeof TOAST !== 'undefined') TOAST.success(mode ? 'Scan to use: ' + USE_MODE_LABEL[mode] : 'Scan to use: asks each time'); render(); }
  catch (e) { if (typeof TOAST !== 'undefined') TOAST.error(/permission-denied/i.test(e.message || '') ? 'Only an inventory manager can set this.' : (e.message || 'Could not save.')); }
};
window.invUse = function (realIdx, labelCode) {
  var item = _data.items[realIdx];
  INV_USE.sheet(item, { labelCode: labelCode || item.label_code || null, context: labelCode ? 'scan' : 'inventory-page', onDone: function (res) { Object.assign(item, res.item); render(); } });
};
window.invMakeLabel = async function (realIdx) {
  var item = _data.items[realIdx];
  try { var code = await INV_LABELS.ensureCode(item); if (typeof TOAST !== 'undefined') TOAST.success('Code ' + code + ' is now this item’s label'); render(); }
  catch (e) { if (typeof TOAST !== 'undefined') TOAST.error(e.message || 'Could not mint a code.'); }
};
window.invQueueLabel = async function (realIdx) {
  var item = _data.items[realIdx];
  try {
    var r = await INV_LABELS.queue([item], { note: 'Inventory label — ' + (item.name || item.id) });
    if (typeof TOAST !== 'undefined') TOAST.success('Queued at the label printer (open its Queue tab to print)');
    render();
    void r;
  } catch (e) { if (typeof TOAST !== 'undefined') TOAST.error(e.message || 'Could not queue the label.'); }
};
window.invPrintSheet = function (realIdxs) {
  var items = realIdxs.map(function (i) { return _data.items[i]; }).filter(Boolean);
  window.open(INV_LABELS.sheetUrl(items), '_blank', 'noopener');
};
window.invCopyLink = function (realIdx, ev) {
  var item = _data.items[realIdx]; var link = INV_LABELS.core.linkFor(item.label_code || '');
  if (navigator.clipboard && navigator.clipboard.writeText) { navigator.clipboard.writeText(link).then(function () { if (typeof TOAST !== 'undefined') TOAST.success('Link copied'); }); if (ev) ev.preventDefault(); return false; }
  return true;   // no clipboard: let the link open
};

/* A scanned string (camera, typed, USB gun, or ?code= from a phone camera's
 * visit to /l/CODE) → the item's row opens and the use sheet asks what one
 * scan means for it. */
async function invHandleScan(raw) {
  if (typeof SCAN_RESOLVE === 'undefined') return;
  var res = await SCAN_RESOLVE.resolve(raw);
  if (!res.ok || !res.item) { if (typeof TOAST !== 'undefined') TOAST.error(SCAN_RESOLVE.explain(res) || 'Unknown code'); return; }
  var id = res.item.id;
  var idx = _data.items.findIndex(function (i) { return i.id === id; });
  if (idx < 0) { if (typeof TOAST !== 'undefined') TOAST.error('That label points at something not in this list (' + (res.label.target_kind || 'unknown') + ').'); return; }
  // V3.840 — in the app the scan IS the action: straight to the dial ("how
  // much are you taking?"), no table row to find first. The desktop still
  // opens the row so the ledger and label block are in view.
  if (!invIsApp()) {
    var si = document.getElementById('search-input'); if (si) si.value = _data.items[idx].name || '';
    activeTab = 'all'; activeSubtab = 'all'; updateTabActive(); render();
    var tr = document.querySelector('tr.expandable-row[data-item-id="' + id + '"]');
    if (tr) { toggleRow(tr.dataset.rid); if (tr.scrollIntoView) tr.scrollIntoView({ block: 'center' }); }
  }
  invUse(idx, res.code);
}
function invIsApp() {
  try {
    if (document.body.classList.contains('ourlab-app')) return true;
    if (window.Capacitor && typeof Capacitor.isNativePlatform === 'function' && Capacitor.isNativePlatform()) return true;
    if (/[?&]mobileShell=1/.test(location.search) || sessionStorage.getItem('ourlab-shell-preview') === '1') return true;
  } catch (e) {}
  return false;
}
function invOpenScanner() {
  if (typeof SCAN === 'undefined') return;
  // V3.847 — in the app the camera opens at once; the desktop toolbar keeps the wedge-first field.
  SCAN.open({ prompt: 'Scan an item label', cameraFirst: invIsApp(), onResult: function (res) { if (res && res.ok) { try { SCAN.close(); } catch (e) {} invHandleScan(res.code); } } });
}
window.invOpenScanner = invOpenScanner;
window.invHandleScan = invHandleScan;

function invWireScanAndLabels() {
  var scanBtn = document.getElementById('inv-scan');
  if (scanBtn && typeof SCAN !== 'undefined') scanBtn.addEventListener('click', invOpenScanner);
  // V3.840 — in the app the tab's purpose is "scan a label, say how much": a
  // hero button at the top and a camera FAB that stays above the tab bar
  // while the list scrolls. Both are app-only (body.ourlab-app); the hero is
  // in the markup so it paints before any script, the FAB is made here.
  var hero = document.getElementById('inv-scan-hero');
  if (hero && typeof SCAN !== 'undefined') hero.addEventListener('click', invOpenScanner);
  // (V3.844: the floating camera button went — the bar's ＋ fans out to Scan a label on every page; the hero stays.)
  var printBtn = document.getElementById('inv-print-labels');
  if (printBtn) {
    printBtn.addEventListener('click', async function () {
      var rows = document.querySelectorAll('tr.expandable-row[data-item-id], .variant-row[data-item-id]');
      var ids = Array.prototype.map.call(rows, function (r) { return r.getAttribute('data-item-id'); }).filter(Boolean);
      var items = ids.map(function (id) { return _data.items.find(function (i) { return i.id === id; }); }).filter(Boolean);
      if (!items.length) { if (typeof TOAST !== 'undefined') TOAST.error('Nothing in the list to print.'); return; }
      if (items.length > 60 && !confirm('Queue ' + items.length + ' labels at the printer?')) return;
      try {
        var r = await INV_LABELS.queue(items, { note: 'Inventory labels — ' + items.length + ' item' + (items.length === 1 ? '' : 's') });
        if (typeof TOAST !== 'undefined') TOAST.success('Queued ' + r.cells + ' label' + (r.cells === 1 ? '' : 's') + ' at the label printer');
        render();
      } catch (e) { if (typeof TOAST !== 'undefined') TOAST.error(e.message || 'Could not queue labels.'); }
    });
  }
}

/* ---- Build detail panel HTML for a single item ---- */

function itemDetailHtml(item, realIdx) {
  var d = '';
  d += '<div style="display:grid;grid-template-columns:repeat(auto-fill,minmax(220px,1fr));gap:10px;margin-bottom:12px;">';
  d += '<div><label class="detail-meta-label">Category</label>' + inlineSelect(realIdx, 'category', item.category, CATEGORY_OPTIONS) + '</div>';
  d += '<div><label class="detail-meta-label">Subcategory</label>' + inlineText(realIdx, 'subcategory', item.subcategory, 'e.g. electronics, ppe') + '</div>';
  // V3.646 — once tracking is on, stock_status is derived, so offering a
  // <select> would let a hand-set value fight the next transaction.
  d += '<div><label class="detail-meta-label">Stock Status</label>' +
       (_invTracked(item)
         ? stockChip(item.stock_status) + '<span class="detail-meta-label" style="display:block;margin-top:2px;">derived from quantity</span>'
         : inlineSelect(realIdx, 'stock_status', item.stock_status, STOCK_OPTIONS)) + '</div>';
  d += '<div><label class="detail-meta-label">Condition</label>' + inlineSelect(realIdx, 'condition', item.condition, CONDITION_OPTIONS) + '</div>';
  var acctOptions = _projects.map(function (p) { return p.account_number; });
  var projOptions = _projects.map(function (p) { return p.id; });
  d += '<div><label class="detail-meta-label">Account #</label>' + inlineSelect(realIdx, 'account_number', item.account_number, acctOptions) + '</div>';
  d += '<div><label class="detail-meta-label">Project</label>' + inlineSelect(realIdx, 'project_tag', item.project_tag, projOptions) + '</div>';
  d += '<div><label class="detail-meta-label">Consumable?</label>' + inlineCheckbox(realIdx, 'is_consumable', item.is_consumable) + '</div>';
  d += '<div><label class="detail-meta-label">Scan to use</label>' + invUseModeHtml(item, realIdx) + '</div>';   // V3.834
  d += '<div><label class="detail-meta-label">Quantity</label>' +
       (_invTracked(item)
         ? '<span style="font-size:13px;color:var(--text-muted);">tracked below</span>'
         : inlineNumber(realIdx, 'quantity', item.quantity, { min: 0 })) + '</div>';
  d += '</div>';
  d += invLabelHtml(item, realIdx);   // V3.834 — QR label + use
  d += '<div style="display:grid;grid-template-columns:1fr 1fr;gap:10px;margin-bottom:12px;">';
  d += '<div><label class="detail-meta-label">Name</label>' + inlineText(realIdx, 'name', item.name, '') + '</div>';
  d += '<div><label class="detail-meta-label">Vendor</label>' + inlineText(realIdx, 'vendor', item.vendor, '') + '</div>';
  d += '</div>';
  // V3.873 — a lab-made item is only known by its description, so it is always
  // shown (and editable) for those; a purchased item shows one when it has it.
  if (item.lab_made || item.description) {
    d += '<div style="margin-bottom:12px;"><label class="detail-meta-label">Description</label>' + inlineTextarea(realIdx, 'description', item.description, 'What it is, how it was made, what it was aliquoted from') + '</div>';
  }
  d += '<div style="margin-bottom:12px;"><label class="detail-meta-label">Notes</label>' + inlineTextarea(realIdx, 'notes', item.notes, 'Add notes...') + '</div>';
  d += '<div class="detail-meta" style="margin-bottom:12px;">';
  if (item.lab_made) {
    d += '<div class="detail-meta-item"><span class="detail-meta-label">' + (item.lab_made_type === 'aliquot' ? 'Aliquoted by' : 'Made by') + '</span><span class="detail-meta-value">' +
         escAttr(item.made_by_name || 'someone in the lab') + (item.date_acquired ? ' on ' + formatDate(item.date_acquired) : '') + '</span></div>';
    if (item.each_amount && typeof INV_MADE_CORE !== 'undefined') {
      d += '<div class="detail-meta-item"><span class="detail-meta-label">Each ' + escAttr(INV_MADE_CORE.unitWord(item.qty_unit || 'ea', 1)) + ' holds</span><span class="detail-meta-value">' +
           escAttr(INV_MADE_CORE.amountText(item.each_amount, item.each_unit)) + '</span></div>';
    }
  } else if (item.date_acquired) d += '<div class="detail-meta-item"><span class="detail-meta-label">Date Acquired</span><span class="detail-meta-value">' + formatDate(item.date_acquired) + '</span></div>';
  if (item.catalogue_number) d += '<div class="detail-meta-item"><span class="detail-meta-label">Catalogue #</span><span class="detail-meta-value">' + item.catalogue_number + '</span></div>';
  if (item.funding_source) d += '<div class="detail-meta-item"><span class="detail-meta-label">Funding</span><span class="detail-meta-value">' + item.funding_source + '</span></div>';
  d += '</div>';
  d += _invQtyBlockHtml(item, realIdx);
  d += madeFromHtml(item);   // V3.875
  d += '<div style="margin-bottom:12px;border-top:1px solid var(--border);padding-top:10px;">';
  d += '<div style="display:flex;align-items:center;justify-content:space-between;margin-bottom:6px;"><strong style="font-size:12px;text-transform:uppercase;color:var(--text-muted);">Locations</strong>';
  d += '<button class="btn btn-sm btn-primary" onclick="event.stopPropagation(); addLocation(' + realIdx + ')">+ Add</button></div>';
  if (item.locations && item.locations.length) {
    d += '<table style="width:100%;font-size:13px;"><thead><tr><th style="text-align:left">Location</th><th>Qty</th><th>Notes</th><th></th></tr></thead><tbody>';
    item.locations.forEach(function (loc, li) {
      d += '<tr><td>' + escAttr(loc.name) + '</td><td style="text-align:center;">' + (loc.quantity || '') + '</td><td style="color:var(--text-muted);">' + escAttr(loc.notes || '') + '</td>';
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
  // V3.813 — a reorder starts from the item itself: the procurement composer
  // opens prefilled (name, vendor, cat#, link, last price) and, when the box
  // arrives, putting it away restocks THIS item instead of creating a twin.
  // V3.873 — nobody sells what we made, so a lab-made item has no reorder.
  if (item.id && !item.lab_made) d += '<a class="btn btn-sm" href="/rm/pages/procurement.html?reorder=' + encodeURIComponent(item.id) + '" onclick="event.stopPropagation();" style="margin-right:8px;">Request reorder \u2192</a>';
  d += '<button class="btn btn-sm" onclick="event.stopPropagation(); addToGroup(' + realIdx + ')" style="margin-right:8px;">Add to Group</button>';
  if (item.product_group) {
    d += '<button class="btn btn-sm" onclick="event.stopPropagation(); removeFromGroup(' + realIdx + ')" style="margin-right:8px;">Remove from Group</button>';
  }
  // V3.646 — Delete was offered to every lab member, but firestore.rules
  // requires isAdmin() for delete on inventory/{itemId}. The failure was worse
  // than a no-op: api.save's delete-diff (api-firestore-adapter.js:260-262)
  // emits batch.delete() for every doc absent from the payload, and batches are
  // ATOMIC — so the whole 777-doc write rejected, api.save threw, and
  // loadAndRender() never ran. The row stayed visibly gone until reload.
  if (typeof firebridge !== 'undefined' && firebridge.isAdmin && firebridge.isAdmin()) {
    d += '<button class="btn" style="color:var(--red);border-color:var(--red);" onclick="event.stopPropagation(); deleteItem(' + realIdx + ')">Delete Item</button>';
  }
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

      var cells = '<td><strong>' + escAttr(item.name || '') + '</strong>' + labMadeChip(item) + '</td>';
      cells += '<td>' + (item.category || '').replace(/_/g, ' ') + '</td>';
      cells += '<td>' + vendorCell(item) + '</td>';
      cells += '<td style="font-size:12px;">' + (item.catalogue_number || '') + '</td>';
      cells += '<td>' + qtyCell(item) + '</td>';
      cells += '<td>' + (item.unit_price != null ? '$' + item.unit_price.toFixed(2) : '') + '</td>';
      cells += '<td>' + locationsChips(item.locations) + '</td>';
      cells += '<td>' + stockChip(item.stock_status) + '</td>';

      html += '<tr class="expandable-row" onclick="toggleRow(\'' + rid + '\')" data-rid="' + rid + '" data-item-id="' + (item.id || '') + '">' + cells + '</tr>';
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
        gDetail += '<div class="variant-row" data-item-id="' + (item.id || '') + '" data-gid="' + gid + '" data-vid="' + vid + '" onclick="event.stopPropagation(); toggleVariant(\'' + vid + '\')" style="cursor:pointer;padding:8px 12px;border:1px solid var(--border);border-radius:var(--radius);margin-bottom:6px;background:var(--surface);">';
        gDetail += '<div style="display:flex;justify-content:space-between;align-items:center;">';
        gDetail += '<div><strong>' + escAttr(item.name || '') + '</strong>' + labMadeChip(item);
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
      var item = await _invCreateItem(vals);
      _invOpenItem(item.id);
    },
  });
};

/* ---- V3.873 — create ONE item doc ----
 *
 * + Add Item used api.save(DATA_PATH, _data): a whole-collection save that
 * re-set every one of ~3,500 inventory docs to add one (the shape that kept
 * "+ New paper" from ever working for non-admins, V3.729). This writes only the
 * new doc, in a transaction that refuses an id already taken — a slug from the
 * name can collide, and a plain set() would silently overwrite that item. */
async function _invCreateItem(vals) {
  var base = String(vals.id || slugify(vals.name || '') || 'item').slice(0, 90).replace(/-+$/, '');
  if (typeof firebridge === 'undefined' || !firebridge.db) {   // local JSON dev server
    vals.id = base;
    _data.items.push(vals);
    await api.save(DATA_PATH, _data);
    _items = _data.items;
    _invPaintChrome();
    return vals;
  }
  var db = firebridge.db();
  var ts = firebase.firestore.FieldValue.serverTimestamp();
  var clean = Object.assign({}, vals);
  delete clean.id;
  clean.kind = 'item';
  var taken = {};
  _data.items.forEach(function (i) { if (i && i.id) taken[i.id] = true; });
  var id = null;
  _invLive.suppressUntil = Date.now() + 2500;
  for (var n = 1; n <= 30 && !id; n++) {
    var cand = n === 1 ? base : base + '-' + n;
    if (taken[cand]) continue;
    var ref = db.collection('inventory').doc(cand);
    try {
      await db.runTransaction(async function (t) {
        var snap = await t.get(ref);
        if (snap.exists) throw new Error('__taken');
        t.set(ref, Object.assign({}, clean, { updatedAt: ts }));
      });
      id = cand;
    } catch (e) {
      if (!e || e.message !== '__taken') throw e;
    }
  }
  if (!id) throw new Error('Could not find a free id for "' + (vals.name || 'this item') + '".');
  try { if (api.invalidate) await api.invalidate(DATA_PATH); } catch (e) { /* the doc is written */ }
  vals.id = id;
  vals.kind = 'item';
  _data.items.push(vals);
  _items = _data.items;
  _invPaintChrome();
  return vals;
}

/* ---- Custom items (V3.873, V3.875) ----
 *
 * A custom aliquot, material or medium is an ordinary kind:'item' doc with
 * lab_made:true, so the list, search, scan-to-use, the pickers and Scientia's
 * inventory search all see it unchanged. The form, the "made from" planner
 * (which never turns 4 tubes into 4 packs) and the labels live in
 * inventory-made.js; this page only writes the doc and shows it. */
window.addLabMadeItem = function () {
  if (typeof INV_MADE === 'undefined') { if (typeof TOAST !== 'undefined') TOAST.error('The custom-item form did not load. Reload the page.'); return; }
  INV_MADE.open({
    items: function () { return (_data && _data.items) || []; },
    chemicals: function () { return api.load('inventory/chemicals.json').then(function (d) { return (d && d.chemicals) || []; }); },
    create: _invCreateItem,
    opened: function (item) { _invOpenItem(item.id); },
  });
};

/* ---- Subtab switcher ---- */

window.setSubtab = function (key) {
  activeSubtab = key;
  render();
};

/* ---- Location CRUD ----
 *
 * V3.646 — all three of these used the full-collection api.save, rewriting all
 * ~777 inventory docs to change one item's locations array. Locations are the
 * single most-touched thing in the box/stock feature, so they now take the same
 * surgical path as every other inline edit: mutate in memory, render, write one
 * doc. _commitLocations() also keeps `locIds` in sync — the flat mirror that
 * makes "what's in box 4" an array-contains query needing no composite index. */

function _commitLocations(itemIdx) {
  var item = _data.items[itemIdx];
  item.locations = item.locations || [];
  item.locIds = item.locations.map(function (l) { return l.locId || null; })
    .filter(Boolean);
  item.manual_edit = true;
  _items = _data.items;
  render();
  _saveInvItemSurgical(item).catch(function (err) {
    console.error('[inventory] location save failed:', err);
    if (typeof TOAST !== 'undefined' && TOAST.error) TOAST.error('Location did not save — reload and retry.');
  });
}

window.addLocation = function (itemIdx) {
  openForm({
    title: 'Add Location',
    fields: LOCATION_FIELDS,
    onSave: async function (vals) {
      if (!_data.items[itemIdx].locations) _data.items[itemIdx].locations = [];
      _data.items[itemIdx].locations.push(vals);
      _commitLocations(itemIdx);
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
      _commitLocations(itemIdx);
    },
  });
};

window.removeLocation = async function (itemIdx, locIdx) {
  if (!confirmAction('Remove this location?')) return;
  _data.items[itemIdx].locations.splice(locIdx, 1);
  _commitLocations(itemIdx);
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

/* V3.646 — a usage transaction writes the item doc directly (it needs `before`
 * for the ledger row, which FieldValue.increment cannot give us), so it bypasses
 * both api.save and this page's save wrapper. Without this listener the page
 * would show the pre-write number until the live subscriber echoed back — and
 * the echo is exactly what suppressUntil is there to swallow.
 *
 * INV_QTY owns the write; the page owns the repaint. */
function _invAttachQtyListener() {
  if (typeof INV_QTY === 'undefined' || !INV_QTY.onLocalWrite) return;
  INV_QTY.onLocalWrite(function (res) {
    _invLive.suppressUntil = Date.now() + 2500;
    if (!_data || !Array.isArray(_data.items) || !res || !res.itemId) return;
    var idx = -1;
    for (var i = 0; i < _data.items.length; i++) {
      if (_data.items[i] && _data.items[i].id === res.itemId) { idx = i; break; }
    }
    if (idx < 0) return;   // a stock batch or chemical — not on this route
    // Merge only the fields the transaction actually settled; serverTimestamp
    // sentinels in res.item would otherwise land in the render as objects.
    var it = _data.items[idx];
    it.qty_remaining = res.after;
    it.qty_tracked = true;
    if (res.status) it.stock_status = res.status;
    if (res.item && res.item.qty_unit != null) it.qty_unit = res.item.qty_unit;
    if (res.item && res.item.qty_made != null) it.qty_made = res.item.qty_made;
    if (res.item && res.item.qty_min !== undefined) it.qty_min = res.item.qty_min;
    _items = _data.items;
    render();
  });
}

/* Narrow the list to one item and open its detail panel (?item=, and V3.873 a
 * just-created item). Filters are cleared so a set category or stock filter
 * cannot hide it. */
function _invOpenItem(wantId) {
  var want = wantId && _items.find(function (i) { return i.id === wantId; });
  if (!want) return false;
  var si = document.getElementById('search-input');
  if (si) si.value = want.name || '';
  ['category-filter', 'stock-filter'].forEach(function (id) { var el = document.getElementById(id); if (el) el.value = 'all'; });
  activeTab = 'all'; activeSubtab = 'all'; updateTabActive(); render();
  _expandedRow = ''; _expandedVariant = '';   // render() rebuilt the rows closed; toggleRow would otherwise CLOSE an id it thinks is open
  var tr = document.querySelector('tr.expandable-row[data-item-id="' + wantId + '"]');
  if (tr) { toggleRow(tr.dataset.rid); if (tr.scrollIntoView) tr.scrollIntoView({ block: 'center' }); }
  else {   // a variant inside a product family: open the family, then the variant
    var vr = document.querySelector('.variant-row[data-item-id="' + wantId + '"]');
    if (vr) { toggleRow(vr.dataset.gid); toggleVariant(vr.dataset.vid); if (vr.scrollIntoView) vr.scrollIntoView({ block: 'center' }); }
  }
  return true;
}

/* ---- Init ---- */

(async function () {
  if (typeof firebridge !== 'undefined' && firebridge.requireSignIn) await firebridge.requireSignIn('Sign in to view the lab inventory.');
  // hasCapability() is SYNC, so the grant must be loaded before the first
  // render or every manager-only affordance silently renders as absent.
  if (typeof firebridge !== 'undefined' && firebridge.loadAccessGrant) {
    try { await firebridge.loadAccessGrant(); } catch (e) { /* non-members have no grant */ }
  }
  _invWrapSaves();
  _invAttachQtyListener();
  await loadAndRender();
  _invAttachLiveSync();
  // V3.813 — ?item=<id> (a procurement ticket's "open in inventory" link)
  // narrows the search to that item and opens its detail panel. The old
  // link used #<id>, which nothing here ever read.
  try { _invOpenItem(new URLSearchParams(location.search).get('item')); }
  catch (e) { console.warn('[inventory] ?item= open failed:', e); }
  // V3.834 — a phone camera's visit to /l/CODE lands here with ?code=; the
  // toolbar's Scan / Print labels buttons.
  try {
    invWireScanAndLabels();
    var code = new URLSearchParams(location.search).get('code');
    if (code) invHandleScan(code);
  } catch (e) { console.warn('[inventory] scan wiring failed:', e); }
})();
