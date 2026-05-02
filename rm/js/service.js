/* service.js — pin-grid item hub for the Service page.
 *
 * Service items live in 4 separate JSON files (conferences, committees,
 * peer reviews, outreach) rather than items.json. We load all four,
 * adapt each row into a uniform shape, and render through the same
 * pin-box chrome the Research / Teaching / Tasks pages use.
 *
 * Edits write back to the original file each row came from.
 */

const SERVICE_TABS = [
  {
    key: 'conferences', label: 'Conferences', path: 'service/conferences.json', dataKey: 'conferences',
    titleKey: 'name', color: '#5b21b6',
    fields: [
      { key: 'name', label: 'Conference Name', type: 'text', required: true },
      { key: 'role', label: 'Role', type: 'select', options: ['Chair/Organizer', 'Session Chair', 'Reviewer', 'Presenter', 'Attendee', 'Keynote'] },
      { key: 'date', label: 'Date', type: 'date' },
      { key: 'location', label: 'Location', type: 'text' },
      { key: 'status', label: 'Status', type: 'select', options: ['active', 'upcoming', 'completed'] },
      { key: 'repo_path', label: 'Repo Path', type: 'text' },
      { key: 'repo_org', label: 'GitHub Org', type: 'text' },
      { key: 'notes', label: 'Notes', type: 'textarea' },
    ],
    summaryChips(item) {
      const out = [];
      if (item.role) out.push(['#e0e7ff', '#3730a3', item.role]);
      if (item.location) out.push(['#f3f4f6', '#374151', item.location]);
      return out;
    },
    detailRows: (item) => [
      ['Role', item.role],
      ['Date', item.date && item.date !== 'TBD' ? formatDate(item.date) : item.date],
      ['Location', item.location],
      ['Status', item.status],
      ['Repo', item.repo_path],
    ],
    dueField: 'date', dueLabel: 'Date',
  },
  {
    key: 'committees', label: 'Committees', path: 'service/committees.json', dataKey: 'committees',
    titleKey: 'name', color: '#7c3aed',
    fields: [
      { key: 'name', label: 'Committee Name', type: 'text', required: true },
      { key: 'level', label: 'Level', type: 'select', options: ['Department', 'College', 'University', 'Professional Society', 'Other'] },
      { key: 'role', label: 'Role', type: 'select', options: ['Chair', 'Member', 'Ex-Officio'] },
      { key: 'term_start', label: 'Term Start', type: 'date' },
      { key: 'term_end', label: 'Term End', type: 'date' },
      { key: 'status', label: 'Status', type: 'select', options: ['active', 'completed'] },
      { key: 'time_commitment', label: 'Time Commitment', type: 'text', placeholder: 'e.g. 2 hrs/month' },
      { key: 'notes', label: 'Notes', type: 'textarea' },
    ],
    summaryChips(item) {
      const out = [];
      if (item.level) out.push(['#dbeafe', '#1e3a8a', item.level]);
      if (item.role) out.push(['#e0e7ff', '#3730a3', item.role]);
      if (item.time_commitment) out.push(['#f3f4f6', '#374151', item.time_commitment]);
      return out;
    },
    detailRows: (item) => [
      ['Level', item.level],
      ['Role', item.role],
      ['Term', (item.term_start ? formatDate(item.term_start) : '') + ' – ' + (item.term_end ? formatDate(item.term_end) : '')],
      ['Time Commitment', item.time_commitment],
      ['Status', item.status],
    ],
    dueField: 'term_end', dueLabel: 'Ends',
  },
  {
    key: 'reviews', label: 'Peer Reviews', path: 'service/reviews.json', dataKey: 'reviews',
    titleKey: 'journal', color: '#0e7490',
    fields: [
      { key: 'journal', label: 'Journal', type: 'text', required: true },
      { key: 'manuscript_title', label: 'Manuscript Title', type: 'text' },
      { key: 'date_received', label: 'Date Received', type: 'date' },
      { key: 'date_due', label: 'Due Date', type: 'date' },
      { key: 'date_completed', label: 'Date Completed', type: 'date' },
      { key: 'status', label: 'Status', type: 'select', options: ['pending', 'in_progress', 'completed', 'declined'] },
      { key: 'notes', label: 'Notes', type: 'textarea' },
    ],
    summaryChips(item) {
      const out = [];
      if (item.manuscript_title) out.push(['#f3f4f6', '#374151', item.manuscript_title.slice(0, 40)]);
      return out;
    },
    detailRows: (item) => [
      ['Journal', item.journal],
      ['Manuscript', item.manuscript_title],
      ['Received', item.date_received ? formatDate(item.date_received) : ''],
      ['Due', item.date_due ? formatDate(item.date_due) : ''],
      ['Completed', item.date_completed ? formatDate(item.date_completed) : ''],
      ['Status', item.status],
    ],
    dueField: 'date_due', dueLabel: 'Due',
  },
  {
    key: 'outreach', label: 'Outreach', path: 'service/outreach.json', dataKey: 'outreach',
    titleKey: 'name', color: '#be185d',
    fields: [
      { key: 'name', label: 'Activity Name', type: 'text', required: true },
      { key: 'type', label: 'Type', type: 'select', options: ['High School', 'K-12', 'Community', 'Media', 'Mentoring', 'Other'] },
      { key: 'date', label: 'Date', type: 'date' },
      { key: 'audience', label: 'Audience', type: 'text', placeholder: 'e.g. Tucson High School students' },
      { key: 'status', label: 'Status', type: 'select', options: ['active', 'upcoming', 'completed'] },
      { key: 'notes', label: 'Notes', type: 'textarea' },
    ],
    summaryChips(item) {
      const out = [];
      if (item.type) out.push(['#fce7f3', '#9d174d', item.type]);
      if (item.audience) out.push(['#f3f4f6', '#374151', item.audience]);
      return out;
    },
    detailRows: (item) => [
      ['Type', item.type],
      ['Date', item.date ? formatDate(item.date) : ''],
      ['Audience', item.audience],
      ['Status', item.status],
    ],
    dueField: 'date', dueLabel: 'Date',
  },
];

let _svcRows = [];          // adapted rows: { _tab, _index, ...item }
let _svcFilter = 'all';     // 'all' | tab.key
let _svcSearch = '';
let _svcExpandedKey = null; // `${_tab}:${_index}`

const _SCG = window.CARD_GRID || {};

async function svcLoadAndRender() {
  const docs = await Promise.all(SERVICE_TABS.map(t => api.load(t.path).catch(() => ({ [t.dataKey]: [] }))));
  _svcRows = [];
  SERVICE_TABS.forEach((tab, ti) => {
    const arr = (docs[ti] && docs[ti][tab.dataKey]) || [];
    arr.forEach((item, idx) => {
      _svcRows.push({ _tab: tab.key, _index: idx, ...item });
    });
  });
  svcRender();
}

function svcRender() {
  const content = document.getElementById('content');
  svcRenderFilterBar();

  const filtered = _svcRows.filter(row => {
    if (_svcFilter !== 'all' && row._tab !== _svcFilter) return false;
    if (_svcSearch) {
      const q = _svcSearch.toLowerCase();
      const tab = SERVICE_TABS.find(t => t.key === row._tab);
      const title = (tab && row[tab.titleKey]) || '';
      const hay = (title + ' ' + (row.notes || '') + ' ' + (row.location || '') + ' ' + (row.role || '') + ' ' + (row.manuscript_title || '') + ' ' + (row.audience || '')).toLowerCase();
      if (hay.indexOf(q) === -1) return false;
    }
    return true;
  });

  if (filtered.length === 0) {
    content.innerHTML = '<div class="empty-state" style="padding:40px;text-align:center;color:#9ca3af">No items match. Click "+ Add Item" to create one.</div>';
    return;
  }

  const grid = document.createElement('div');
  grid.className = 'pin-grid' + (_svcExpandedKey ? ' focusing-row' : '');
  filtered.forEach(row => grid.appendChild(svcRenderPinBox(row)));
  content.innerHTML = '';
  content.appendChild(grid);

  grid.querySelectorAll('.pin-box').forEach(b => {
    b.addEventListener('click', e => {
      if (e.target.closest('button, input, select, a, textarea, .pin-card-body')) return;
      const k = b.dataset.svcKey;
      _svcExpandedKey = (_svcExpandedKey === k) ? null : k;
      svcRender();
      if (_svcExpandedKey) {
        requestAnimationFrame(() => {
          const focused = grid.querySelector('.pin-box.focused');
          if (focused) focused.scrollIntoView({ behavior: 'smooth', block: 'start' });
        });
      }
    });
  });
}

function svcRenderFilterBar() {
  const bar = document.getElementById('filter-bar');
  if (!bar) return;
  bar.innerHTML = '';

  function chipBtn(value, label, count) {
    const btn = document.createElement('button');
    btn.className = 'filter-btn' + (_svcFilter === value ? ' active' : '');
    btn.textContent = label + (count != null ? ` (${count})` : '');
    btn.onclick = () => { _svcFilter = value; svcRender(); };
    return btn;
  }

  bar.appendChild(chipBtn('all', 'All', _svcRows.length));
  SERVICE_TABS.forEach(tab => {
    const n = _svcRows.filter(r => r._tab === tab.key).length;
    bar.appendChild(chipBtn(tab.key, tab.label, n));
  });

  const spacer = document.createElement('div');
  spacer.style.flex = '1';
  bar.appendChild(spacer);

  const search = document.createElement('input');
  search.type = 'text';
  search.placeholder = 'Search...';
  search.value = _svcSearch;
  search.oninput = () => { _svcSearch = search.value; svcRender(); };
  bar.appendChild(search);
}

function svcRenderPinBox(row) {
  const tab = SERVICE_TABS.find(t => t.key === row._tab);
  const key = `${row._tab}:${row._index}`;
  const isExpanded = _svcExpandedKey === key;
  const title = row[tab.titleKey] || '(untitled)';

  const box = document.createElement('div');
  box.className = 'pin-box' + (isExpanded ? ' expanded focused' : '');
  box.style.borderLeft = `5px solid ${tab.color}`;
  box.dataset.svcKey = key;

  // Header
  const head = document.createElement('div');
  head.className = 'pin-box-head';
  head.style.cursor = 'pointer';
  const titleWrap = document.createElement('div');
  titleWrap.className = 'pin-box-title';
  const typeLine = document.createElement('div');
  typeLine.className = 'pin-box-cat';
  typeLine.style.color = tab.color;
  typeLine.textContent = tab.label.replace(/s$/, '');
  titleWrap.appendChild(typeLine);
  const titleEl = document.createElement('div');
  titleEl.className = 'pin-box-sub';
  titleEl.textContent = title;
  titleEl.title = title;
  titleWrap.appendChild(titleEl);
  head.appendChild(titleWrap);

  const meta = document.createElement('div');
  meta.className = 'pin-box-meta';
  meta.innerHTML = statusChip(row.status || '');
  if (isExpanded) {
    const exitBtn = document.createElement('button');
    exitBtn.className = 'pin-expand';
    exitBtn.title = 'Exit focus view';
    exitBtn.style.fontSize = '14px';
    exitBtn.textContent = '×';
    exitBtn.addEventListener('click', (ev) => {
      ev.stopPropagation();
      _svcExpandedKey = null;
      svcRender();
    });
    meta.appendChild(exitBtn);
  }
  head.appendChild(meta);
  box.appendChild(head);

  // Summary chips
  const summary = document.createElement('div');
  summary.className = 'pin-card-chips';
  summary.style.cssText = 'padding:6px 14px 8px 14px;display:flex;flex-wrap:wrap;gap:6px';
  (tab.summaryChips(row) || []).forEach(([bg, fg, text]) => {
    if (!text) return;
    const c = document.createElement('span');
    c.style.cssText = `font-size:11px;padding:1px 7px;border-radius:10px;background:${bg};color:${fg}`;
    c.textContent = text;
    summary.appendChild(c);
  });
  // Due / date chip
  const dueDate = row[tab.dueField];
  if (dueDate && dueDate !== 'TBD') {
    const c = document.createElement('span');
    c.style.cssText = 'font-size:11px;padding:1px 7px;border-radius:10px;font-variant-numeric:tabular-nums';
    const dur = (_SCG.duePrefix) ? _SCG.duePrefix(dueDate) : '';
    if (dur === 'due-overdue') { c.style.background = '#fecaca'; c.style.color = '#7f1d1d'; }
    else if (dur === 'due-soon') { c.style.background = '#fef3c7'; c.style.color = '#92400e'; }
    else { c.style.background = '#f3f4f6'; c.style.color = '#374151'; }
    c.textContent = `${tab.dueLabel} ${dueDate.slice(5)}`;
    c.title = `${tab.dueLabel}: ${dueDate}`;
    summary.appendChild(c);
  }
  if (summary.children.length) box.appendChild(summary);

  // Focused-card body — hero layout with key info inlined
  if (isExpanded) {
    const body = document.createElement('div');
    body.className = 'pin-card-body item-focus-body';
    let html = '<div class="item-hero">';
    if (row.notes) {
      html += `<div class="item-hero-desc">${escapeHtml(row.notes)}</div>`;
    }
    const detailRows = (tab.detailRows(row) || []).filter(([_, v]) => v && String(v).trim());
    if (detailRows.length) {
      html += '<div class="item-hero-meta">';
      detailRows.forEach(([label, value]) => {
        html += '<div class="item-hero-meta-row">';
        html += `<span class="item-hero-meta-k">${escapeHtml(label)}</span>`;
        html += `<span class="item-hero-meta-v">${escapeHtml(String(value))}</span>`;
        html += '</div>';
      });
      html += '</div>';
    }
    if (row.repo_path) {
      html += '<div class="item-hero-meta">';
      html += '<div class="item-hero-meta-row">';
      html += '<span class="item-hero-meta-k">Repo</span>';
      html += `<code class="item-hero-meta-v mono">${escapeHtml(row.repo_path)}</code>`;
      html += '</div>';
      if (row.repo_org) {
        html += '<div class="item-hero-meta-row">';
        html += '<span class="item-hero-meta-k">GitHub Org</span>';
        html += `<span class="item-hero-meta-v">${escapeHtml(row.repo_org)}</span>`;
        html += '</div>';
      }
      html += '</div>';
    }
    html += '<div class="item-hero-actions">'
      + `<button class="btn btn-sm" onclick="event.stopPropagation(); svcEditItem('${row._tab}', ${row._index})">Edit</button>`
      + '<span style="flex:1"></span>'
      + `<button class="btn btn-sm btn-danger" onclick="event.stopPropagation(); svcDeleteItem('${row._tab}', ${row._index})">Delete</button>`
      + '</div>';
    html += '</div>';
    body.innerHTML = html;
    box.appendChild(body);
  }

  return box;
}

function escapeHtml(s) {
  return String(s == null ? '' : s).replace(/[&<>"]/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));
}

window.svcEditItem = async function (tabKey, index) {
  const tab = SERVICE_TABS.find(t => t.key === tabKey);
  const data = await api.load(tab.path);
  const item = data[tab.dataKey][index];
  if (!item) return;
  openForm({
    title: `Edit ${tab.label.replace(/s$/, '')}`,
    fields: tab.fields,
    values: item,
    onSave: async (vals) => {
      Object.assign(data[tab.dataKey][index], vals);
      data[tab.dataKey][index].id = slugify(vals[tab.titleKey] || vals.name || vals.journal || 'item');
      await api.save(tab.path, data);
      svcLoadAndRender();
    },
  });
};

window.svcDeleteItem = async function (tabKey, index) {
  if (!confirm('Remove this entry?')) return;
  const tab = SERVICE_TABS.find(t => t.key === tabKey);
  const data = await api.load(tab.path);
  data[tab.dataKey].splice(index, 1);
  await api.save(tab.path, data);
  _svcExpandedKey = null;
  svcLoadAndRender();
};

document.getElementById('add-item').onclick = () => {
  // Pick the active tab as the default add target. If "all" is filtered,
  // ask the user which kind to add.
  const defaultTabKey = (_svcFilter !== 'all') ? _svcFilter : null;
  if (defaultTabKey) {
    svcOpenAddForm(defaultTabKey);
    return;
  }
  const labels = {};
  SERVICE_TABS.forEach(t => { labels[t.key] = t.label.replace(/s$/, ''); });
  openForm({
    title: 'Add Service Item — Select Type',
    fields: [{
      key: 'tab', label: 'Type', type: 'select', required: true,
      options: SERVICE_TABS.map(t => t.key),
      optionLabels: labels,
    }],
    onSave: (vals) => { if (vals.tab) svcOpenAddForm(vals.tab); },
  });
};

function svcOpenAddForm(tabKey) {
  const tab = SERVICE_TABS.find(t => t.key === tabKey);
  openForm({
    title: `Add ${tab.label.replace(/s$/, '')}`,
    fields: tab.fields,
    onSave: async (vals) => {
      const data = await api.load(tab.path);
      vals.id = slugify(vals[tab.titleKey] || vals.name || vals.journal || 'item');
      data[tab.dataKey].push(vals);
      await api.save(tab.path, data);
      _svcFilter = tabKey;
      svcLoadAndRender();
    },
  });
}

(async function () {
  if (typeof firebridge !== 'undefined' && firebridge.whenAuthResolved) await firebridge.whenAuthResolved();
  await svcLoadAndRender();
  // No LIVE_SYNC.attach: service activities are admin-curated, infrequent
  // edits, single-tab in practice. Cached api.load + reload covers it.
})();
