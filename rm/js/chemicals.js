/* chemicals.js — chemical safety tracking with GHS hazards, MSDS, exposure data */

var DATA_PATH = 'inventory/chemicals.json';
var DATA_KEY = 'chemicals';
var activeTab = 'all';
var _chemicals = [];
var _sortKey = null;
var _sortDir = 'asc';
var _chemLive = null; // set by LIVE_SYNC.attach() — surgical saves bump suppressUntil
var CHEM_COLUMNS = [
  { label: 'Name', key: 'name' },
  { label: 'CAS #', key: 'safety.cas_number' },
  { label: 'Vendor', key: 'vendor' },
  { label: 'Cat #', key: 'catalogue_number' },
  { label: 'GHS Hazards', key: null },
  { label: 'Signal', key: 'safety.signal_word' },
  { label: 'MSDS', key: null },
  { label: 'Expires', key: 'safety.expiration_date', type: 'date' },
  { label: 'Actions', key: null },
];

var CHEMICAL_FIELDS = [
  { key: 'name', label: 'Chemical Name', type: 'text', required: true },
  { key: 'description', label: 'Description', type: 'textarea' },
  { key: 'vendor', label: 'Vendor', type: 'text' },
  { key: 'catalogue_number', label: 'Catalogue #', type: 'text' },
  { key: 'quantity', label: 'Quantity on Hand', type: 'text', placeholder: 'e.g. 4 bottles, 500 mL' },
  { key: 'unit_price', label: 'Unit Price ($)', type: 'number' },
  { key: 'date_acquired', label: 'Date Acquired', type: 'date' },
  { key: 'category', label: 'Category', type: 'select', options: [
    'research_chem', 'research_reagents', 'research_cells', 'research_gels',
    'research_gas', 'research_analysis', 'consumable', 'other',
  ]},
  { key: 'account_number', label: 'Account Number', type: 'text', placeholder: 'e.g. 1101935' },
  { key: 'notes', label: 'Notes', type: 'textarea' },
];

var SAFETY_FIELDS = [
  { key: 'cas_number', label: 'CAS Number', type: 'text', placeholder: 'e.g. 67-56-1' },
  { key: 'signal_word', label: 'Signal Word', type: 'select', options: ['', 'Danger', 'Warning'] },
  { key: 'storage_conditions', label: 'Storage Conditions', type: 'text', placeholder: 'e.g. Flammable cabinet, 4C' },
  { key: 'expiration_date', label: 'Expiration Date', type: 'date' },
  { key: 'msds_url', label: 'MSDS URL', type: 'text', placeholder: 'https://...' },
];

var TABS = [
  { key: 'all', label: 'All Chemicals' },
  { key: 'hazardous', label: 'Hazardous' },
  { key: 'expiring', label: 'Expiring' },
  { key: 'missing_msds', label: 'Missing MSDS' },
];

/* ---- GHS Pictogram rendering ---- */

var GHS_PICTOGRAMS = {
  'GHS01': { symbol: '\u2620', label: 'Explosive', color: '#dc2626' },
  'GHS02': { symbol: '\u2622', label: 'Flammable', color: '#dc2626' },
  'GHS03': { symbol: '\u26a0', label: 'Oxidizer', color: '#d97706' },
  'GHS04': { symbol: '\u26c5', label: 'Compressed Gas', color: '#2563eb' },
  'GHS05': { symbol: '\u2620', label: 'Corrosive', color: '#dc2626' },
  'GHS06': { symbol: '\u2620', label: 'Acute Toxicity', color: '#dc2626' },
  'GHS07': { symbol: '!', label: 'Irritant', color: '#d97706' },
  'GHS08': { symbol: '\u2665', label: 'Health Hazard', color: '#dc2626' },
  'GHS09': { symbol: '\u2600', label: 'Environmental', color: '#059669' },
};

function ghsPictograms(pictograms) {
  if (!pictograms || !pictograms.length) return '<span style="color:var(--text-muted);font-size:12px;">No data</span>';
  return pictograms.map(function (code) {
    var p = GHS_PICTOGRAMS[code] || { symbol: '?', label: code, color: '#6b7280' };
    return '<span class="ghs-pictogram" style="background:' + p.color + ';" title="' + p.label + '">' + p.symbol + '</span>';
  }).join(' ');
}

function signalWordChip(word) {
  if (!word) return '';
  if (word.toLowerCase() === 'danger') return '<span class="chip chip-red">Danger</span>';
  if (word.toLowerCase() === 'warning') return '<span class="chip chip-amber">Warning</span>';
  return '<span class="chip chip-muted">' + word + '</span>';
}

function msdsChip(safety) {
  if (!safety) return '<span class="chip chip-red">Missing</span>';
  if (safety.sds_exempt) return '<span class="chip chip-muted">Exempt</span>';
  if (safety.msds && safety.msds.local_path) {
    return '<a href="' + safety.msds.local_path + '" target="_blank" class="chip chip-green" style="text-decoration:none;cursor:pointer;">On File</a>';
  }
  return '<span class="chip chip-red">Missing</span>';
}

window.searchMsds = function (el) {
  // Find the chemical name from the row
  var row = el.closest('tr');
  if (row) {
    var name = row.querySelector('td strong');
    if (name) {
      var q = encodeURIComponent('"' + name.textContent + '" MSDS');
      window.open('https://www.google.com/search?q=' + q + '+site:fishersci.com+OR+site:sigmaaldrich.com', '_blank');
    }
  }
};

/* ---- Filtering ---- */

function getFiltered() {
  var chems = _chemicals.slice();
  var hazardFilter = document.getElementById('hazard-filter').value;
  var search = (document.getElementById('search-input').value || '').trim().toLowerCase();

  // Tab filter
  if (activeTab === 'hazardous') {
    chems = chems.filter(function (c) {
      return c.safety && c.safety.ghs_hazard_classes && c.safety.ghs_hazard_classes.length > 0;
    });
  }
  if (activeTab === 'expiring') {
    chems = chems.filter(function (c) {
      if (!c.safety || !c.safety.expiration_date || c.safety.expiration_date === 'TBD') return false;
      var d = daysUntil(c.safety.expiration_date);
      return d !== null && d >= 0 && d <= 90;
    });
  }
  if (activeTab === 'missing_msds') {
    chems = chems.filter(function (c) {
      if (!c.safety) return true;
      return !c.safety.sds_exempt && (!c.safety.msds || !c.safety.msds.local_path);
    });
  }

  // Hazard filter
  if (hazardFilter === 'danger') {
    chems = chems.filter(function (c) { return c.safety && c.safety.signal_word && c.safety.signal_word.toLowerCase() === 'danger'; });
  } else if (hazardFilter === 'warning') {
    chems = chems.filter(function (c) { return c.safety && c.safety.signal_word && c.safety.signal_word.toLowerCase() === 'warning'; });
  } else if (hazardFilter === 'none') {
    chems = chems.filter(function (c) { return !c.safety || !c.safety.signal_word; });
  }

  // Search
  if (search) {
    chems = chems.filter(function (c) {
      var haystack = [c.name, c.description, c.vendor, c.catalogue_number,
        c.safety ? c.safety.cas_number : ''].join(' ').toLowerCase();
      return haystack.indexOf(search) >= 0;
    });
  }

  return chems;
}

/* ---- Safety detail panel ---- */

function isEstablished(val) {
  return val && val.toLowerCase().indexOf('not established') < 0;
}

function nfpaDiamond(nfpa) {
  if (!nfpa) return '';
  var h = nfpa.health !== null ? nfpa.health : '-';
  var f = nfpa.flammability !== null ? nfpa.flammability : '-';
  var inst = nfpa.instability !== null ? nfpa.instability : '-';
  var sp = nfpa.special || '';
  return '<div class="nfpa-diamond" style="display:inline-grid;grid-template-columns:40px 40px 40px;grid-template-rows:40px 40px 40px;gap:2px;font-weight:700;font-size:16px;text-align:center;line-height:38px;">'
    + '<div></div>'
    + '<div style="background:#dc2626;color:white;border-radius:4px;" title="Flammability: ' + f + '">' + f + '</div>'
    + '<div></div>'
    + '<div style="background:#2563eb;color:white;border-radius:4px;" title="Health: ' + h + '">' + h + '</div>'
    + '<div style="background:#f5f5f5;border:1px solid var(--border);border-radius:4px;font-size:11px;line-height:38px;color:var(--text-muted);">NFPA</div>'
    + '<div style="background:#d97706;color:white;border-radius:4px;" title="Instability: ' + inst + '">' + inst + '</div>'
    + '<div></div>'
    + '<div style="background:#f5f5f5;border:1px solid var(--border);border-radius:4px;font-size:11px;line-height:38px;">' + sp + '</div>'
    + '<div></div>'
    + '</div>';
}

function safetyDetailHtml(safety) {
  if (!safety) return '<div style="color:var(--text-muted);font-size:13px;">No safety data. Edit this chemical to add GHS hazard information.</div>';

  var html = '';

  // Signal word + CAS
  html += '<div class="detail-meta">';
  if (safety.cas_number) html += '<div class="detail-meta-item"><span class="detail-meta-label">CAS #</span><span class="detail-meta-value" style="font-family:monospace;font-size:14px;">' + safety.cas_number + '</span></div>';
  if (safety.formula) html += '<div class="detail-meta-item"><span class="detail-meta-label">Formula</span><span class="detail-meta-value">' + safety.formula + '</span></div>';
  if (safety.signal_word) html += '<div class="detail-meta-item"><span class="detail-meta-label">Signal Word</span><span class="detail-meta-value">' + signalWordChip(safety.signal_word) + '</span></div>';
  if (safety.storage_conditions) html += '<div class="detail-meta-item"><span class="detail-meta-label">Storage</span><span class="detail-meta-value">' + safety.storage_conditions + '</span></div>';
  if (safety.expiration_date && safety.expiration_date !== 'TBD') html += '<div class="detail-meta-item"><span class="detail-meta-label">Expires</span><span class="detail-meta-value">' + formatDate(safety.expiration_date) + ' ' + deadlineChip(safety.expiration_date) + '</span></div>';
  html += '</div>';

  // Two-column layout for pictograms + NFPA
  var hasGHS = safety.ghs_pictograms && safety.ghs_pictograms.length;
  var nfpa = safety.nfpa_ratings;
  var hasNFPA = nfpa && (nfpa.health !== null || nfpa.flammability !== null || nfpa.instability !== null);

  if (hasGHS || hasNFPA) {
    html += '<div style="display:flex;gap:24px;margin-top:12px;flex-wrap:wrap;align-items:flex-start;">';
    if (hasGHS) {
      html += '<div><strong style="font-size:12px;text-transform:uppercase;color:var(--text-muted)">GHS Pictograms</strong><div style="margin-top:4px;">' + ghsPictograms(safety.ghs_pictograms) + '</div></div>';
    }
    if (hasNFPA) {
      html += '<div><strong style="font-size:12px;text-transform:uppercase;color:var(--text-muted)">NFPA Diamond</strong><div style="margin-top:4px;">' + nfpaDiamond(nfpa) + '</div></div>';
    }
    html += '</div>';
  }

  // GHS Hazard Classes (full descriptions)
  if (safety.ghs_hazard_classes && safety.ghs_hazard_classes.length) {
    html += '<div style="margin-top:10px;"><strong style="font-size:12px;text-transform:uppercase;color:var(--text-muted)">GHS Hazard Classifications</strong><ul style="margin:4px 0;padding-left:20px;font-size:13px;">';
    safety.ghs_hazard_classes.forEach(function (c) { html += '<li>' + c + '</li>'; });
    html += '</ul></div>';
  }

  // Hazard statements
  if (safety.hazard_statements && safety.hazard_statements.length) {
    var realH = safety.hazard_statements.filter(function(h) { return h.indexOf('Not classified') < 0; });
    if (realH.length) {
      html += '<div style="margin-top:8px;"><strong style="font-size:12px;text-transform:uppercase;color:var(--text-muted)">Hazard Statements</strong><ul style="margin:4px 0;padding-left:20px;font-size:13px;">';
      realH.forEach(function (h) { html += '<li>' + h + '</li>'; });
      html += '</ul></div>';
    } else {
      html += '<div style="margin-top:8px;font-size:13px;color:var(--green);">Not classified as hazardous under GHS</div>';
    }
  }

  // Precautionary statements
  if (safety.precautionary_statements && safety.precautionary_statements.length) {
    html += '<div style="margin-top:8px;"><strong style="font-size:12px;text-transform:uppercase;color:var(--text-muted)">Precautionary Statements</strong><ul style="margin:4px 0;padding-left:20px;font-size:13px;">';
    safety.precautionary_statements.forEach(function (p) { html += '<li>' + p + '</li>'; });
    html += '</ul></div>';
  }

  // PPE
  if (safety.ppe_required && safety.ppe_required.length) {
    html += '<div style="margin-top:8px;"><strong style="font-size:12px;text-transform:uppercase;color:var(--text-muted)">PPE Required</strong><div style="margin-top:4px;">';
    safety.ppe_required.forEach(function (p) { html += '<span class="chip chip-amber" style="margin:2px;">' + p + '</span>'; });
    html += '</div></div>';
  }

  // Exposure routes
  if (safety.exposure_routes && safety.exposure_routes.length) {
    html += '<div style="margin-top:8px;"><strong style="font-size:12px;text-transform:uppercase;color:var(--text-muted)">Exposure Routes</strong><div style="margin-top:4px;">';
    safety.exposure_routes.forEach(function (r) { html += '<span class="chip chip-muted" style="margin:2px;">' + r + '</span>'; });
    html += '</div></div>';
  }

  // Exposure limits — only show if at least one is actually established
  var el = safety.exposure_limits;
  if (el) {
    var hasLimits = isEstablished(el.osha_pel) || isEstablished(el.acgih_tlv) || isEstablished(el.niosh_rel);
    if (hasLimits) {
      html += '<div style="margin-top:8px;"><strong style="font-size:12px;text-transform:uppercase;color:var(--text-muted)">Exposure Limits</strong><div class="detail-meta" style="margin-top:4px;">';
      if (isEstablished(el.osha_pel)) html += '<div class="detail-meta-item"><span class="detail-meta-label">OSHA PEL</span><span class="detail-meta-value">' + el.osha_pel + '</span></div>';
      if (isEstablished(el.acgih_tlv)) html += '<div class="detail-meta-item"><span class="detail-meta-label">ACGIH TLV</span><span class="detail-meta-value">' + el.acgih_tlv + '</span></div>';
      if (isEstablished(el.niosh_rel)) html += '<div class="detail-meta-item"><span class="detail-meta-label">NIOSH REL</span><span class="detail-meta-value">' + el.niosh_rel + '</span></div>';
      html += '</div></div>';
    }
  }

  // First aid
  var fa = safety.first_aid;
  if (fa && (fa.inhalation || fa.skin_contact || fa.eye_contact || fa.ingestion)) {
    html += '<div style="margin-top:8px;"><strong style="font-size:12px;text-transform:uppercase;color:var(--text-muted)">First Aid</strong><div class="detail-meta" style="margin-top:4px;">';
    if (fa.inhalation) html += '<div class="detail-meta-item"><span class="detail-meta-label">Inhalation</span><span class="detail-meta-value">' + fa.inhalation + '</span></div>';
    if (fa.skin_contact) html += '<div class="detail-meta-item"><span class="detail-meta-label">Skin</span><span class="detail-meta-value">' + fa.skin_contact + '</span></div>';
    if (fa.eye_contact) html += '<div class="detail-meta-item"><span class="detail-meta-label">Eyes</span><span class="detail-meta-value">' + fa.eye_contact + '</span></div>';
    if (fa.ingestion) html += '<div class="detail-meta-item"><span class="detail-meta-label">Ingestion</span><span class="detail-meta-value">' + fa.ingestion + '</span></div>';
    html += '</div></div>';
  }

  // SDS section — on file, exempt, or missing with upload
  html += '<div style="margin-top:12px;padding-top:8px;border-top:1px solid var(--border);">';
  if (safety.msds && safety.msds.local_path) {
    html += '<a href="' + safety.msds.local_path + '" target="_blank" class="btn btn-primary btn-sm">View Full SDS (PDF)</a>';
    if (safety.msds.source) {
      html += '<span style="margin-left:8px;font-size:11px;color:var(--text-muted);">' + safety.msds.source + '</span>';
    }
  } else if (safety.sds_exempt) {
    html += '<div style="background:#f9fafb;border:1px solid var(--border);border-radius:var(--radius, 6px);padding:10px 14px;">';
    html += '<div style="color:var(--text-muted);font-weight:600;font-size:13px;margin-bottom:2px;">SDS Exempt</div>';
    html += '<div style="font-size:12px;color:var(--text-muted);">' + (safety.sds_exempt_reason || 'Not classified as hazardous; no manufacturer SDS available.') + '</div>';
    html += '<button class="btn btn-sm" style="margin-top:6px;font-size:11px;" onclick="event.stopPropagation(); clearSdsExempt(this)">Remove exemption</button>';
    html += '</div>';
  } else {
    html += '<div style="background:var(--red-bg, #fef2f2);border:1px solid var(--red, #dc2626);border-radius:var(--radius, 6px);padding:10px 14px;">';
    html += '<div style="color:var(--red, #dc2626);font-weight:600;font-size:13px;margin-bottom:4px;">SDS Not On File</div>';
    html += '<div style="font-size:12px;color:var(--text-muted);margin-bottom:8px;">OSHA requires an SDS for every hazardous chemical in the workplace (29 CFR 1910.1200). Upload the manufacturer\'s SDS PDF below.</div>';
    html += '<div class="sds-upload-area" style="display:flex;gap:8px;align-items:center;flex-wrap:wrap;">';
    html += '<label class="btn btn-sm" style="cursor:pointer;background:var(--red, #dc2626);color:white;border:none;padding:6px 14px;border-radius:4px;font-size:12px;">';
    html += 'Upload SDS PDF <input type="file" accept=".pdf" style="display:none;" onchange="handleSdsUpload(this)">';
    html += '</label>';
    html += '<button class="btn btn-sm" style="font-size:11px;background:transparent;border:1px solid var(--border);color:var(--text-muted);" onclick="event.stopPropagation(); markSdsExempt(this)">No SDS needed</button>';
    html += '<span class="sds-upload-status" style="font-size:12px;color:var(--text-muted);"></span>';
    html += '</div>';
    html += '</div>';
  }
  html += '</div>';

  return html;
}

/* ---- Main render ---- */

async function loadAndRender() {
  var data = await api.load(DATA_PATH);
  _chemicals = data.chemicals || [];

  // Tabs
  var tabsEl = document.getElementById('tabs');
  tabsEl.innerHTML = '';
  TABS.forEach(function (t) {
    var btn = document.createElement('button');
    btn.className = 'tab-btn' + (activeTab === t.key ? ' active' : '');
    btn.textContent = t.label;
    var tabCounts = {};
    tabCounts.all = _chemicals.length;
    tabCounts.hazardous = _chemicals.filter(function (c) { return c.safety && c.safety.ghs_hazard_classes && c.safety.ghs_hazard_classes.length; }).length;
    tabCounts.expiring = _chemicals.filter(function (c) {
      if (!c.safety || !c.safety.expiration_date || c.safety.expiration_date === 'TBD') return false;
      var d = daysUntil(c.safety.expiration_date); return d !== null && d >= 0 && d <= 90;
    }).length;
    tabCounts.missing_msds = _chemicals.filter(function (c) {
      if (!c.safety) return true;
      return !c.safety.sds_exempt && (!c.safety.msds || !c.safety.msds.local_path);
    }).length;
    var count = tabCounts[t.key];
    if (count !== undefined) btn.textContent = t.label + ' (' + count + ')';
    btn.onclick = function () { activeTab = t.key; loadAndRender(); };
    tabsEl.appendChild(btn);
  });

  render();
}

function render() {
  var chems = getFiltered();
  var content = document.getElementById('content');

  // Summary
  var hasCAS = _chemicals.filter(function (c) { return c.safety && c.safety.cas_number; }).length;
  var hazardous = _chemicals.filter(function (c) { return c.safety && c.safety.signal_word && (c.safety.signal_word === 'Danger' || c.safety.signal_word === 'Warning'); }).length;
  var danger = _chemicals.filter(function (c) { return c.safety && c.safety.signal_word === 'Danger'; }).length;
  var missingMsds = _chemicals.filter(function (c) { return !c.safety || !c.safety.sds_exempt && (!c.safety.msds || !c.safety.msds.local_path); }).length;
  var html = '<div style="display:flex;gap:12px;margin-bottom:16px;flex-wrap:wrap;">';
  html += '<div class="card" style="flex:1;min-width:120px;padding:12px 16px;"><div class="card-title">Total Chemicals</div><div class="card-count">' + _chemicals.length + '</div></div>';
  html += '<div class="card" style="flex:1;min-width:120px;padding:12px 16px;"><div class="card-title">With CAS #</div><div class="card-count">' + hasCAS + '</div></div>';
  if (danger > 0) {
    html += '<div class="card" style="flex:1;min-width:120px;padding:12px 16px;border-left:3px solid var(--red);"><div class="card-title">Danger</div><div class="card-count" style="color:var(--red);">' + danger + '</div></div>';
  }
  if (hazardous - danger > 0) {
    html += '<div class="card" style="flex:1;min-width:120px;padding:12px 16px;border-left:3px solid #d97706;"><div class="card-title">Warning</div><div class="card-count" style="color:#d97706;">' + (hazardous - danger) + '</div></div>';
  }
  if (missingMsds > 0) {
    html += '<div class="card" style="flex:1;min-width:120px;padding:12px 16px;border-left:3px solid var(--text-muted);"><div class="card-title">Missing SDS Link</div><div class="card-count" style="color:var(--text-muted);">' + missingMsds + '</div></div>';
  }
  html += '</div>';

  if (chems.length === 0) {
    html += '<div class="empty-state">No chemicals match your filters.</div>';
    content.innerHTML = html;
    return;
  }

  html += '<div style="font-size:13px;color:var(--text-muted);margin-bottom:8px;">' + chems.length + ' chemical' + (chems.length !== 1 ? 's' : '') + ' shown</div>';
  html += '<table class="data-table">';
  html += sortableHeader(CHEM_COLUMNS, _sortKey, _sortDir, 'onChemSort');
  html += '<tbody>';
  chems = sortItems(chems, _sortKey, _sortDir, CHEM_COLUMNS);

  chems.forEach(function (chem, i) {
    var realIdx = _chemicals.indexOf(chem);
    var safety = chem.safety || {};

    var cells = '<td><strong>' + (chem.name || '') + '</strong></td>';
    cells += '<td style="font-size:12px;">' + (safety.cas_number || '') + '</td>';
    cells += '<td>' + (chem.vendor || '') + '</td>';
    cells += '<td style="font-size:12px;">' + (chem.catalogue_number || '') + '</td>';
    cells += '<td>' + ghsPictograms(safety.ghs_pictograms) + '</td>';
    cells += '<td>' + signalWordChip(safety.signal_word) + '</td>';
    cells += '<td>' + msdsChip(chem.safety) + '</td>';
    cells += '<td>' + (safety.expiration_date && safety.expiration_date !== 'TBD' ? formatDate(safety.expiration_date) + ' ' + deadlineChip(safety.expiration_date) : '') + '</td>';
    cells += '<td class="row-actions">';
    cells += '<button onclick="event.stopPropagation(); editChemical(' + realIdx + ')">Edit</button>';
    cells += '<button onclick="event.stopPropagation(); deleteChemical(' + realIdx + ')">Del</button>';
    cells += '</td>';

    // Detail panel — embed data-chem-index for upload handler
    var detailContent = '<div data-chem-index="' + realIdx + '">' + safetyDetailHtml(chem.safety) + '</div>';

    // Reorder info
    if (chem.reorder && (chem.reorder.vendor || chem.reorder.catalogue_number)) {
      detailContent += '<div style="margin-top:12px;border-top:1px solid var(--border);padding-top:8px;"><strong style="font-size:12px;text-transform:uppercase;color:var(--text-muted)">Reorder Info</strong>';
      detailContent += '<div style="font-size:13px;margin-top:4px;">';
      if (chem.reorder.vendor) detailContent += chem.reorder.vendor;
      if (chem.reorder.catalogue_number) detailContent += ' &middot; Cat# ' + chem.reorder.catalogue_number;
      if (chem.reorder.last_price) detailContent += ' &middot; $' + chem.reorder.last_price.toFixed(2);
      if (chem.reorder.url) detailContent += ' &middot; <a href="' + chem.reorder.url + '" target="_blank" style="color:var(--primary);">Order Link</a>';
      detailContent += '</div></div>';
    }

    if (chem.notes) detailContent += '<div class="detail-notes" style="margin-top:8px;">' + chem.notes + '</div>';

    html += '<tr class="expandable-row" onclick="toggleChemDetail(' + i + ')" data-idx="' + i + '">' + cells + '</tr>';
    html += '<tr class="detail-row" id="chem-detail-' + i + '"><td colspan="9"><div class="detail-panel">' + detailContent + '</div></td></tr>';
  });

  html += '</tbody></table>';
  content.innerHTML = html;
}

/* ---- Expand/collapse ---- */

var _expandedChem = -1;

window.toggleChemDetail = function (idx) {
  var allRows = document.querySelectorAll('.expandable-row');
  var allDetails = document.querySelectorAll('.detail-row');

  if (_expandedChem === idx) {
    allRows.forEach(function (r) { r.classList.remove('expanded'); });
    allDetails.forEach(function (r) { r.classList.remove('open'); });
    _expandedChem = -1;
    return;
  }

  allRows.forEach(function (r) { r.classList.remove('expanded'); });
  allDetails.forEach(function (r) { r.classList.remove('open'); });

  var row = document.querySelector('tr.expandable-row[data-idx="' + idx + '"]');
  var detail = document.getElementById('chem-detail-' + idx);
  if (row) row.classList.add('expanded');
  if (detail) detail.classList.add('open');
  _expandedChem = idx;
};

/* ---- Surgical save helpers ----
 *
 * Chemicals share the `inventory` Firestore collection with items, discriminated
 * by `kind: 'chemical'`. A full collection rewrite touches every chemical doc
 * (~159) on each edit; surgical save writes only the touched doc and bumps
 * the live-sync suppression window to ignore our own snapshot echo. */
async function _saveChemSurgical(chem) {
  return _saveChemsSurgical([chem]);
}
async function _saveChemsSurgical(chems) {
  if (typeof firebridge === 'undefined' || !firebridge.db) {
    return api.save(DATA_PATH, { chemicals: _chemicals });
  }
  try {
    if (_chemLive) _chemLive.suppressUntil = Date.now() + 2500;
    var db = firebridge.db();
    var ts = firebase.firestore.FieldValue.serverTimestamp();
    var batch = db.batch();
    chems.forEach(function (c) {
      var clean = Object.assign({}, c);
      delete clean.id;
      clean.kind = 'chemical';
      clean.updatedAt = ts;
      batch.set(db.collection('inventory').doc(c.id), clean, { merge: true });
    });
    await batch.commit();
  } catch (err) {
    console.warn('[chemicals] surgical save failed, falling back to full save:', err.message);
    await api.save(DATA_PATH, { chemicals: _chemicals });
  }
}
async function _deleteChemSurgical(id) {
  if (typeof firebridge === 'undefined' || !firebridge.db) {
    return api.save(DATA_PATH, { chemicals: _chemicals });
  }
  try {
    if (_chemLive) _chemLive.suppressUntil = Date.now() + 2500;
    var db = firebridge.db();
    await db.collection('inventory').doc(id).delete();
  } catch (err) {
    console.warn('[chemicals] surgical delete failed, falling back to full save:', err.message);
    await api.save(DATA_PATH, { chemicals: _chemicals });
  }
}

function _chemToastError(label) {
  return function (err) {
    console.error('[chemicals] ' + label + ' failed:', err);
    if (window.TOAST) TOAST.error('Save failed: ' + label, { detail: err.message });
  };
}

/* ---- CRUD ---- */

window.editChemical = async function (index) {
  var chem = _chemicals[index];
  if (!chem) return;

  // Flatten safety fields into the values
  var values = Object.assign({}, chem);
  if (chem.safety) {
    values.cas_number = chem.safety.cas_number || '';
    values.signal_word = chem.safety.signal_word || '';
    values.storage_conditions = chem.safety.storage_conditions || '';
    values.expiration_date = chem.safety.expiration_date || '';
    values.msds_url = (chem.safety.msds && chem.safety.msds.url) || '';
  }

  var allFields = CHEMICAL_FIELDS.concat(SAFETY_FIELDS);

  openForm({
    title: 'Edit Chemical',
    fields: allFields,
    values: values,
    onSave: function (vals) {
      var c = _chemicals[index];
      if (!c) return;
      // Update main fields
      Object.assign(c, vals);
      // Update safety sub-object
      if (!c.safety) {
        c.safety = {
          cas_number: '', formula: '', ghs_hazard_classes: [], ghs_pictograms: [],
          signal_word: '', hazard_statements: [], precautionary_statements: [],
          exposure_routes: [], ppe_required: [], storage_conditions: '',
          exposure_limits: { osha_pel: '', acgih_tlv: '', niosh_rel: '' },
          nfpa_ratings: { health: null, flammability: null, instability: null, special: '' },
          first_aid: { inhalation: '', skin_contact: '', eye_contact: '', ingestion: '' },
          msds: { url: '', local_path: '', last_updated: 'TBD', source: '' },
          expiration_date: 'TBD',
        };
      }
      c.safety.cas_number = vals.cas_number || '';
      c.safety.signal_word = vals.signal_word || '';
      c.safety.storage_conditions = vals.storage_conditions || '';
      c.safety.expiration_date = vals.expiration_date || 'TBD';
      if (vals.msds_url) c.safety.msds.url = vals.msds_url;
      c.manual_edit = true;
      // Clean up flattened keys
      delete c.cas_number;
      delete c.signal_word;
      delete c.storage_conditions;
      delete c.expiration_date;
      delete c.msds_url;
      // Optimistic: paint immediately, then save
      render();
      _saveChemSurgical(c).catch(_chemToastError('edit chemical'));
    },
  });
};

window.deleteChemical = function (index) {
  if (!confirmAction('Remove this chemical from the safety registry?')) return;
  var chem = _chemicals[index];
  if (!chem) return;
  var id = chem.id;
  _chemicals.splice(index, 1);
  render();
  _deleteChemSurgical(id).catch(_chemToastError('delete chemical'));
};

document.getElementById('add-chemical').onclick = function () {
  var allFields = CHEMICAL_FIELDS.concat(SAFETY_FIELDS);
  openForm({
    title: 'Add Chemical',
    fields: allFields,
    onSave: function (vals) {
      var chem = {
        id: slugify((vals.vendor || '') + '-' + (vals.name || '')),
        name: vals.name || '',
        description: vals.description || '',
        vendor: vals.vendor || '',
        vendor_normalized: slugify(vals.vendor || ''),
        catalogue_number: vals.catalogue_number || '',
        quantity: vals.quantity || 1,
        unit_price: vals.unit_price ? Number(vals.unit_price) : null,
        extended_price: vals.unit_price ? Number(vals.unit_price) : null,
        date_acquired: vals.date_acquired || '',
        category: (vals.category || 'research_chem').toLowerCase(),
        subcategory: '',
        is_chemical: true,
        is_consumable: true,
        condition: 'active',
        stock_status: 'full',
        funding_source: '',
        account_number: vals.account_number || '',
        account_name: '',
        project_tag: '',
        tags: [],
        locations: [],
        price_history: [],
        receipt_ref: null,
        reorder: { url: '', vendor: vals.vendor || '', catalogue_number: vals.catalogue_number || '', last_price: vals.unit_price ? Number(vals.unit_price) : null, lead_time_days: null, notes: '' },
        safety: {
          cas_number: vals.cas_number || '',
          formula: '',
          ghs_hazard_classes: [],
          ghs_pictograms: [],
          signal_word: vals.signal_word || '',
          hazard_statements: [],
          precautionary_statements: [],
          exposure_routes: [],
          ppe_required: [],
          storage_conditions: vals.storage_conditions || '',
          exposure_limits: { osha_pel: '', acgih_tlv: '', niosh_rel: '' },
          nfpa_ratings: { health: null, flammability: null, instability: null, special: '' },
          first_aid: { inhalation: '', skin_contact: '', eye_contact: '', ingestion: '' },
          msds: { url: vals.msds_url || '', local_path: '', last_updated: 'TBD', source: '' },
          expiration_date: vals.expiration_date || 'TBD',
        },
        parse_confidence: 0,
        parsed_at: '',
        manual_edit: true,
        notes: vals.notes || '',
      };
      _chemicals.push(chem);
      render();
      _saveChemSurgical(chem).catch(_chemToastError('add chemical'));
    },
  });
};

/* ---- SDS Exempt ---- */

window.markSdsExempt = function (btn) {
  var panel = btn.closest('[data-chem-index]');
  if (!panel) return;
  var idx = Number(panel.getAttribute('data-chem-index'));
  var reason = prompt('Reason SDS is not needed (e.g. "Inert buffer, no manufacturer SDS available"):');
  if (reason === null) return; // cancelled
  if (!reason.trim()) reason = 'Not classified as hazardous; no manufacturer SDS available.';

  var c = _chemicals[idx];
  if (!c) return;
  if (!c.safety) c.safety = {};
  c.safety.sds_exempt = true;
  c.safety.sds_exempt_reason = reason.trim();
  render();
  _saveChemSurgical(c).catch(_chemToastError('mark SDS exempt'));
};

window.clearSdsExempt = function (btn) {
  var panel = btn.closest('[data-chem-index]');
  if (!panel) return;
  var idx = Number(panel.getAttribute('data-chem-index'));

  var c = _chemicals[idx];
  if (!c) return;
  if (c.safety) {
    delete c.safety.sds_exempt;
    delete c.safety.sds_exempt_reason;
  }
  render();
  _saveChemSurgical(c).catch(_chemToastError('clear SDS exempt'));
};

/* ---- SDS Upload ---- */

window.handleSdsUpload = async function (input) {
  var file = input.files && input.files[0];
  if (!file) return;

  // Find the chemical index from the enclosing detail panel
  var panel = input.closest('[data-chem-index]');
  if (!panel) { alert('Could not determine chemical. Please try again.'); return; }
  var chemIndex = panel.getAttribute('data-chem-index');

  // Show status
  var statusEl = input.closest('.sds-upload-area').querySelector('.sds-upload-status');
  statusEl.textContent = 'Uploading & parsing...';
  statusEl.style.color = 'var(--primary, #2563eb)';

  var formData = new FormData();
  formData.append('sds_file', file);

  try {
    var res = await fetch('/api/upload-sds/' + chemIndex, {
      method: 'POST',
      body: formData,
    });
    var result = await res.json();

    if (result.ok) {
      var msg = 'SDS saved.';
      if (result.parsed) {
        msg += ' Safety data extracted and updated.';
      } else if (result.parse_error) {
        msg += ' (Parse note: ' + result.parse_error + ')';
      }
      statusEl.textContent = msg;
      statusEl.style.color = 'var(--green, #059669)';
      // Reload after brief delay so user sees the message
      setTimeout(function () { loadAndRender(); }, 1200);
    } else {
      statusEl.textContent = 'Error: ' + (result.error || 'Upload failed');
      statusEl.style.color = 'var(--red, #dc2626)';
    }
  } catch (err) {
    statusEl.textContent = 'Network error: ' + err.message;
    statusEl.style.color = 'var(--red, #dc2626)';
  }

  // Reset the file input so the same file can be re-selected
  input.value = '';
};

/* ---- SDS Import (top-level) ---- */

document.getElementById('import-sds-input').onchange = async function () {
  var files = this.files;
  if (!files || !files.length) return;

  var btn = document.getElementById('import-sds-btn');
  var origText = btn.childNodes[0].textContent;
  btn.childNodes[0].textContent = ' Parsing ' + files.length + ' SDS...';
  btn.style.opacity = '0.7';
  btn.style.pointerEvents = 'none';

  var formData = new FormData();
  for (var i = 0; i < files.length; i++) {
    formData.append('files', files[i]);
  }

  try {
    var res = await fetch('/api/import-sds', { method: 'POST', body: formData });
    var result = await res.json();

    if (result.ok) {
      var msgs = [];
      if (result.imported_count) msgs.push(result.imported_count + ' SDS imported');
      if (result.error_count) msgs.push(result.error_count + ' failed');
      result.results.forEach(function (r) {
        msgs.push(r.product_name + ': ' + r.action);
      });
      if (result.errors.length) {
        result.errors.forEach(function (e) {
          msgs.push('Error (' + e.file + '): ' + e.error);
        });
      }
      alert(msgs.join('\n'));
      loadAndRender();
    } else {
      alert('Import failed: ' + (result.error || 'Unknown error'));
    }
  } catch (err) {
    alert('Network error: ' + err.message);
  }

  btn.childNodes[0].textContent = origText;
  btn.style.opacity = '';
  btn.style.pointerEvents = '';
  this.value = '';
};

/* ---- Filter listeners ---- */

window.onChemSort = function (key) {
  if (_sortKey === key) { _sortDir = _sortDir === 'asc' ? 'desc' : 'asc'; }
  else { _sortKey = key; _sortDir = 'asc'; }
  render();
};

document.getElementById('hazard-filter').onchange = function () { render(); };
document.getElementById('search-input').oninput = function () { render(); };

/* ---- Init ---- */

(async function () {
  if (typeof firebridge !== 'undefined' && firebridge.whenAuthResolved) await firebridge.whenAuthResolved();
  await loadAndRender();
  // No LIVE_SYNC.attach: chemicals is admin-edit, rarely two-tab. Cached
  // api.load + reload picks up edits. _chemLive stays null; surgical-save
  // paths check for it before bumping suppressUntil and skip when absent.
})();
