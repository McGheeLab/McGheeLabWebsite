/* tasks-archive.js — Completed/archived task browse.
 *
 * Reads data/activity_ledger.json (the source of truth for completed work)
 * plus data/tasks/inbox.json (to surface finalized_at on tasks that haven't
 * been rolled into the ledger yet). Groups by month, filters by category
 * and free-text search, shows totals per group.
 */

const S = window.YR_SHARED;
if (!S) console.error('yr-shared.js must load before tasks-archive.js');

const A = {
  ledger: null,
  inbox: null,
  filterCats: new Set(S.CAT_ORDER),
  search: '',
  expanded: new Set(),
  yearFilter: 'all',
};

async function boot() {
  const [ledger, inbox] = await Promise.all([
    api.load('activity_ledger.json').catch(() => ({ activities: [] })),
    api.load('tasks/inbox.json').catch(() => ({ tasks: [] })),
  ]);
  A.ledger = ledger;
  A.inbox = inbox;
  render();
}

function allEntries() {
  const rows = [];
  for (const a of (A.ledger?.activities || [])) {
    rows.push({
      id: a.id,
      source: 'ledger',
      date: (a.completed_at || '').slice(0, 10),
      title: a.title,
      description: a.description,
      category: a.category || 'unknown',
      sub_category: a.sub_category || '',
      hours: a.hours || 0,
      task_id: a.from_task_id,
      notes: a.notes || '',
    });
  }
  // Also include tasks with `finalized_at` that have no ledger entry yet.
  const ledgerTaskIds = new Set((A.ledger?.activities || []).map(a => a.from_task_id).filter(Boolean));
  for (const t of (A.inbox?.tasks || [])) {
    if (t.finalized_at && !ledgerTaskIds.has(t.id)) {
      rows.push({
        id: t.id,
        source: 'task',
        date: t.finalized_at.slice(0, 10),
        title: t.title,
        description: t.description,
        category: t.category || 'unknown',
        sub_category: t.sub_category || '',
        hours: t.hours_estimate || 0,
        task_id: t.id,
        notes: 'Finalized (no ledger entry).',
      });
    }
  }
  rows.sort((a, b) => b.date.localeCompare(a.date));
  return rows;
}

function filteredEntries() {
  const q = A.search.trim().toLowerCase();
  return allEntries().filter(r => {
    if (!A.filterCats.has(r.category)) return false;
    if (A.yearFilter !== 'all' && !r.date.startsWith(A.yearFilter)) return false;
    if (q) {
      const hay = `${r.title} ${r.sub_category} ${r.description}`.toLowerCase();
      if (!hay.includes(q)) return false;
    }
    return true;
  });
}

function render() {
  const host = document.getElementById('content');
  host.innerHTML = '';
  host.appendChild(renderToolbar());
  host.appendChild(renderCatToggles());
  host.appendChild(renderSummary());
  host.appendChild(renderList());
}

function renderToolbar() {
  const wrap = document.createElement('div');
  wrap.className = 'inbox-toolbar';

  const years = new Set(['all']);
  for (const r of allEntries()) if (r.date) years.add(r.date.slice(0, 4));
  const yearSel = document.createElement('select');
  yearSel.style.cssText = 'padding:5px 8px;border:1px solid #d1d5db;border-radius:6px;font-size:13px';
  for (const y of Array.from(years).sort().reverse()) {
    const o = document.createElement('option');
    o.value = y; o.textContent = y === 'all' ? 'All years' : y;
    if (y === A.yearFilter) o.selected = true;
    yearSel.appendChild(o);
  }
  yearSel.addEventListener('change', () => { A.yearFilter = yearSel.value; render(); });
  wrap.appendChild(yearSel);

  const search = document.createElement('input');
  search.type = 'text';
  search.placeholder = 'Search title, sub-category, description…';
  search.value = A.search;
  search.style.cssText = 'flex:1;min-width:200px;padding:6px 10px;border:1px solid #d1d5db;border-radius:6px;font-size:13px';
  search.addEventListener('input', () => { A.search = search.value; render(); });
  wrap.appendChild(search);

  return wrap;
}

function renderCatToggles() {
  const host = document.createElement('div');
  host.style.cssText = 'display:flex;gap:6px;flex-wrap:wrap;margin-bottom:10px';
  const counts = {};
  for (const r of filteredEntries()) counts[r.category] = (counts[r.category] || 0) + 1;
  for (const c of S.CAT_ORDER) {
    const chip = document.createElement('span');
    const off = !A.filterCats.has(c);
    chip.className = 'yr-cat-toggle' + (off ? ' off' : '');
    chip.style.background = S.CAT_COLOR[c] + '20';
    chip.style.color = S.CAT_COLOR[c];
    chip.textContent = `${c} ${counts[c] || 0}`;
    chip.addEventListener('click', () => {
      if (A.filterCats.has(c)) A.filterCats.delete(c); else A.filterCats.add(c);
      render();
    });
    host.appendChild(chip);
  }
  return host;
}

function renderSummary() {
  const rows = filteredEntries();
  const hours = rows.reduce((s, r) => s + (r.hours || 0), 0);
  const wrap = document.createElement('div');
  wrap.className = 'inbox-summary';
  wrap.innerHTML = `
    <div style="display:grid;grid-template-columns:repeat(auto-fit,minmax(130px,1fr));gap:10px;font-size:13px">
      <div><strong style="font-size:22px">${rows.length}</strong><br><span style="color:#6b7280">entries</span></div>
      <div><strong style="font-size:22px">${hours.toFixed(1)}h</strong><br><span style="color:#6b7280">total logged</span></div>
      <div><strong style="font-size:22px">${new Set(rows.map(r => r.sub_category)).size}</strong><br><span style="color:#6b7280">sub-categories</span></div>
    </div>`;
  return wrap;
}

function renderList() {
  const rows = filteredEntries();
  const wrap = document.createElement('div');
  if (!rows.length) {
    wrap.innerHTML = '<div class="empty-state">No archived tasks match the current filters.</div>';
    return wrap;
  }
  // group by month
  const groups = {};
  for (const r of rows) {
    const k = (r.date || '').slice(0, 7) || 'unknown';
    (groups[k] ||= []).push(r);
  }
  const keys = Object.keys(groups).sort().reverse();
  for (const k of keys) {
    const g = groups[k];
    const monthHours = g.reduce((s, r) => s + (r.hours || 0), 0);
    const header = document.createElement('div');
    header.className = 'arc-month-head';
    header.innerHTML = `<span>${k}</span><span class="arc-month-meta">${g.length} entries · ${monthHours.toFixed(1)}h</span>`;
    wrap.appendChild(header);
    for (const r of g) wrap.appendChild(renderEntry(r));
  }
  return wrap;
}

function renderEntry(r) {
  const card = document.createElement('div');
  card.className = 'arc-entry';
  const expanded = A.expanded.has(r.id);
  if (expanded) card.classList.add('expanded');

  const color = S.CAT_COLOR[r.category] || '#6b7280';
  const row = document.createElement('div');
  row.className = 'arc-row';
  row.innerHTML = `
    <span class="cat-dot" style="background:${color}" title="${r.category}"></span>
    <span class="arc-date">${S.escapeHtml(r.date || '')}</span>
    <span class="arc-title">${S.escapeHtml(r.title || '')}</span>
    <span class="arc-sub">${S.escapeHtml(r.sub_category || '')}</span>
    <span class="arc-hours">${(r.hours || 0).toFixed(2)}h</span>
  `;
  row.addEventListener('click', () => {
    if (expanded) A.expanded.delete(r.id); else A.expanded.add(r.id);
    render();
  });
  card.appendChild(row);

  if (expanded) {
    const body = document.createElement('div');
    body.className = 'arc-body';
    body.innerHTML = `
      <div><span class="meta-k">category</span> ${S.escapeHtml(r.category)}${r.sub_category ? ' / ' + S.escapeHtml(r.sub_category) : ''}</div>
      ${r.description ? `<div class="arc-desc">${S.escapeHtml(r.description)}</div>` : ''}
      ${r.notes ? `<div class="arc-notes"><span class="meta-k">notes</span> ${S.escapeHtml(r.notes)}</div>` : ''}
      <div class="arc-src"><span class="meta-k">source</span> ${r.source}${r.task_id ? ' · ' + S.escapeHtml(r.task_id) : ''}</div>
    `;
    card.appendChild(body);
  }
  return card;
}

document.addEventListener('DOMContentLoaded', boot);
