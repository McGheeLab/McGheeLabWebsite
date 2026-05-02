/* calendar.js — Outlook calendar integration + history tab */

// ---- Outlook events ----

function formatEventTime(isoStr, allDay) {
  if (!isoStr) return '';
  if (allDay) return formatDate(isoStr.slice(0, 10));
  const d = new Date(isoStr);
  return d.toLocaleString('en-US', {
    month: 'short', day: 'numeric', year: 'numeric',
    hour: 'numeric', minute: '2-digit',
  });
}

function groupEventsByDate(events) {
  const groups = {};
  for (const ev of events) {
    const dateKey = ev.start.slice(0, 10);
    if (!groups[dateKey]) groups[dateKey] = [];
    groups[dateKey].push(ev);
  }
  return groups;
}

const OUTLOOK_STATE = { events: [], search: '', sort: 'date-asc' };

function outlookEventDurMs(ev) {
  if (ev.all_day) return 0;
  const s = ev.start ? new Date(ev.start).getTime() : 0;
  const e = ev.end ? new Date(ev.end).getTime() : 0;
  return (s && e) ? Math.max(0, e - s) : 0;
}

async function renderOutlookEvents() {
  const content = document.getElementById('content');
  content.innerHTML = '<div class="empty-state">Loading Outlook events…</div>';

  let result;
  try {
    const res = await fetch('/api/calendar/outlook-events?days=90');
    if (!res.ok) {
      content.innerHTML = `<div class="empty-state">Server error ${res.status}. Make sure the server is running the latest code (restart server.py).</div>`;
      return;
    }
    const text = await res.text();
    try { result = JSON.parse(text); } catch {
      content.innerHTML = `<div class="empty-state">Invalid response from server. Restart server.py and reload.</div>`;
      return;
    }
  } catch (err) {
    content.innerHTML = `<div class="empty-state">Failed to fetch calendar: ${err.message}</div>`;
    return;
  }

  if (result.error) {
    content.innerHTML = `<div class="empty-state">Calendar error: ${result.error}</div>`;
    return;
  }

  const events = result.events || [];
  if (events.length === 0) {
    content.innerHTML = '<div class="empty-state">No upcoming Outlook events in the next 90 days.</div>';
    return;
  }

  OUTLOOK_STATE.events = events;

  content.innerHTML = `
    <div class="ch-toolbar">
      <input type="text" id="outlook-search" class="btn" placeholder="search title / location" style="font-size:14px;min-width:240px;flex:1;max-width:360px">
      <select id="outlook-sort" class="btn" style="font-size:13px" title="Sort events">
        <option value="date-asc">Soonest first</option>
        <option value="date-desc">Latest first</option>
        <option value="title">Title (A–Z)</option>
        <option value="duration-desc">Longest first</option>
      </select>
    </div>
    <div id="outlook-rows"></div>
  `;

  const searchEl = document.getElementById('outlook-search');
  searchEl.value = OUTLOOK_STATE.search;
  const debouncedOutlookRows = calDebounce(renderOutlookRows, 120);
  searchEl.addEventListener('input', () => {
    OUTLOOK_STATE.search = searchEl.value;
    debouncedOutlookRows();
  });
  const sortEl = document.getElementById('outlook-sort');
  sortEl.value = OUTLOOK_STATE.sort;
  sortEl.addEventListener('change', () => {
    OUTLOOK_STATE.sort = sortEl.value;
    renderOutlookRows();
  });

  renderOutlookRows();
}

function renderOutlookRows() {
  const host = document.getElementById('outlook-rows');
  if (!host) return;
  const search = OUTLOOK_STATE.search.toLowerCase();
  const filtered = OUTLOOK_STATE.events.filter(e => {
    if (!search) return true;
    return ((e.title || '') + ' ' + (e.location || '')).toLowerCase().includes(search);
  });
  if (!filtered.length) {
    host.innerHTML = '<div class="empty-state">No events match filter.</div>';
    return;
  }

  const mode = OUTLOOK_STATE.sort;
  const dateBased = mode === 'date-asc' || mode === 'date-desc';

  if (dateBased) {
    const groups = groupEventsByDate(filtered);
    const dates = Object.keys(groups).sort();
    if (mode === 'date-desc') dates.reverse();
    host.innerHTML = dates.map(dateKey => {
      const dayEvents = groups[dateKey].slice()
        .sort((a, b) => (a.start || '').localeCompare(b.start || ''));
      const d = new Date(dateKey + 'T00:00:00');
      const dayLabel = d.toLocaleDateString('en-US', { weekday: 'long', month: 'short', day: 'numeric', year: 'numeric' });
      const daysAway = daysUntil(dateKey);
      const urgency = daysAway !== null && daysAway <= 0
        ? '<span class="chip chip-amber">today</span>'
        : daysAway !== null && daysAway === 1
          ? '<span class="chip chip-amber">tomorrow</span>'
          : '';
      return `<div class="outlook-day-group">
        <div class="outlook-day-header">${dayLabel} ${urgency}</div>
        <div class="outlook-day-events">${dayEvents.map(renderOutlookEventHtml).join('')}</div>
      </div>`;
    }).join('');
    return;
  }

  const sorted = filtered.slice();
  if (mode === 'title') {
    sorted.sort((a, b) => (a.title || '').localeCompare(b.title || '', undefined, { sensitivity: 'base' }));
  } else if (mode === 'duration-desc') {
    sorted.sort((a, b) => outlookEventDurMs(b) - outlookEventDurMs(a));
  }
  host.innerHTML = `<div class="outlook-day-group">
    <div class="outlook-day-events">${sorted.map(ev => renderOutlookEventHtml(ev, true)).join('')}</div>
  </div>`;
}

function renderOutlookEventHtml(ev, showDate) {
  const timeStr = ev.all_day
    ? 'All day'
    : new Date(ev.start).toLocaleTimeString('en-US', { hour: 'numeric', minute: '2-digit' })
      + (ev.end ? ' – ' + new Date(ev.end).toLocaleTimeString('en-US', { hour: 'numeric', minute: '2-digit' }) : '');
  const dateStr = showDate && ev.start
    ? new Date(ev.start).toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric' }) + ' · '
    : '';
  return `<div class="outlook-event">
    <div class="outlook-event-time">${dateStr}${timeStr}</div>
    <div class="outlook-event-details">
      <div class="outlook-event-title">${escapeCalHtml(ev.title || '')}${ev.recurring ? ' <span class="chip chip-muted" style="font-size:10px">recurring</span>' : ''}</div>
      ${ev.location ? `<div class="outlook-event-location">${escapeCalHtml(ev.location)}</div>` : ''}
    </div>
  </div>`;
}

// ---- Full Calendar (iframe embed) ----

async function renderFullCalendar() {
  const content = document.getElementById('content');
  content.innerHTML = '<div class="empty-state">Loading calendar…</div>';

  let embedUrl = '';
  try {
    const res = await fetch('/api/calendar/outlook-events?days=1');
    const result = await res.json();
    embedUrl = result.embed_url || '';
  } catch {
    // fall through
  }

  if (!embedUrl) {
    content.innerHTML = '<div class="empty-state">No calendar embed URL configured.</div>';
    return;
  }

  content.innerHTML = `<div class="calendar-embed-wrap">
    <iframe src="${embedUrl}" class="calendar-embed" allowfullscreen></iframe>
  </div>`;
}

// ---- Tab switching ----

let currentTab = 'history';

function switchTab(tab) {
  if (tab === currentTab) return;
  currentTab = tab;

  document.querySelectorAll('#cal-tabs .tab-btn').forEach(btn => {
    btn.classList.toggle('active', btn.dataset.tab === tab);
  });

  if (tab === 'outlook') renderOutlookEvents();
  else if (tab === 'history') renderCalendarHistory();
  else if (tab === 'fullcal') renderFullCalendar();
  else if (tab === 'booked') renderBookedTime();
  else if (tab === 'availability') renderAvailability();
}

const BOOKED_STATE = { blocks: [], search: '', sort: 'date-desc' };

async function renderBookedTime() {
  const content = document.getElementById('content');
  content.innerHTML = '<div class="empty-state">Loading booked time…</div>';
  let inbox;
  try {
    inbox = await api.load('tasks/inbox.json');
  } catch {
    content.innerHTML = '<div class="empty-state">Could not load inbox.</div>';
    return;
  }
  const blocks = [];
  for (const t of (inbox.tasks || [])) {
    for (const b of (t.time_booked || [])) {
      blocks.push({
        date: b.date, hours: Number(b.hours) || 0, note: b.note || '',
        task_id: t.id, title: t.title,
        category: t.category || 'unknown', sub_category: t.sub_category || '',
        status: t.status,
      });
    }
  }
  if (!blocks.length) {
    content.innerHTML = '<div class="empty-state">No booked time blocks yet. Open the <a href="/rm/pages/tasks.html">Task Dashboard</a>, expand a pinned task, and click "Book time".</div>';
    return;
  }

  BOOKED_STATE.blocks = blocks;

  // Summary + heatmap use the full (unfiltered) set.
  const heatmapGroups = {};
  for (const b of blocks) (heatmapGroups[b.date || 'unknown'] ||= []).push(b);
  const today = new Date().toISOString().slice(0, 10);
  const upcoming = blocks.filter(b => b.date >= today).length;
  const upcomingHours = blocks.filter(b => b.date >= today).reduce((s, b) => s + b.hours, 0);

  content.innerHTML = `
    <div class="inbox-summary">
      <div style="display:grid;grid-template-columns:repeat(auto-fit,minmax(130px,1fr));gap:10px;font-size:13px">
        <div><strong style="font-size:22px">${blocks.length}</strong><br><span style="color:#6b7280">blocks total</span></div>
        <div><strong style="font-size:22px">${upcoming}</strong><br><span style="color:#6b7280">upcoming</span></div>
        <div><strong style="font-size:22px">${upcomingHours.toFixed(1)}h</strong><br><span style="color:#6b7280">hours upcoming</span></div>
      </div>
    </div>
    ${renderBookedHeatmap(heatmapGroups)}
    <div class="ch-toolbar">
      <input type="text" id="booked-search" class="btn" placeholder="search title / note / category" style="font-size:14px;min-width:240px;flex:1;max-width:360px">
      <select id="booked-sort" class="btn" style="font-size:13px" title="Sort blocks">
        <option value="date-desc">Newest first</option>
        <option value="date-asc">Oldest first</option>
        <option value="hours-desc">Most hours</option>
        <option value="hours-asc">Fewest hours</option>
        <option value="title">Title (A–Z)</option>
        <option value="category">By category</option>
      </select>
    </div>
    <div id="booked-rows"></div>
  `;

  const searchEl = document.getElementById('booked-search');
  searchEl.value = BOOKED_STATE.search;
  const debouncedBookedRows = calDebounce(renderBookedRows, 120);
  searchEl.addEventListener('input', () => {
    BOOKED_STATE.search = searchEl.value;
    debouncedBookedRows();
  });
  const sortEl = document.getElementById('booked-sort');
  sortEl.value = BOOKED_STATE.sort;
  sortEl.addEventListener('change', () => {
    BOOKED_STATE.sort = sortEl.value;
    renderBookedRows();
  });

  renderBookedRows();
}

function renderBookedRows() {
  const host = document.getElementById('booked-rows');
  if (!host) return;
  const search = BOOKED_STATE.search.toLowerCase();
  const filtered = BOOKED_STATE.blocks.filter(b => {
    if (!search) return true;
    const hay = ((b.title || '') + ' ' + (b.note || '') + ' ' + (b.category || '') + ' ' + (b.sub_category || '')).toLowerCase();
    return hay.includes(search);
  });
  if (!filtered.length) {
    host.innerHTML = '<div class="empty-state">No blocks match filter.</div>';
    return;
  }

  const mode = BOOKED_STATE.sort;
  const dateBased = mode === 'date-desc' || mode === 'date-asc';

  if (dateBased) {
    const groups = {};
    for (const b of filtered) (groups[b.date || 'unknown'] ||= []).push(b);
    const dates = Object.keys(groups).sort();
    if (mode === 'date-desc') dates.reverse();
    host.innerHTML = dates.map(d => {
      const day = groups[d].slice().sort((a, b) => b.hours - a.hours);
      const dayHours = day.reduce((s, b) => s + b.hours, 0);
      const dayLabel = (d !== 'unknown')
        ? new Date(d + 'T00:00:00').toLocaleDateString('en-US', { weekday:'long', month:'short', day:'numeric', year:'numeric' })
        : 'Unknown date';
      return `<div class="outlook-day-group">
        <div class="outlook-day-header">${dayLabel} <span class="chip chip-muted" style="font-size:10px">${dayHours.toFixed(1)}h</span></div>
        <div class="outlook-day-events">${day.map(renderBookedBlockHtml).join('')}</div>
      </div>`;
    }).join('');
    return;
  }

  const sorted = filtered.slice();
  if (mode === 'hours-desc') sorted.sort((a, b) => b.hours - a.hours);
  else if (mode === 'hours-asc') sorted.sort((a, b) => a.hours - b.hours);
  else if (mode === 'title') sorted.sort((a, b) => (a.title || '').localeCompare(b.title || '', undefined, { sensitivity: 'base' }));
  else if (mode === 'category') {
    sorted.sort((a, b) => {
      const c = (a.category || '').localeCompare(b.category || '');
      if (c !== 0) return c;
      const s = (a.sub_category || '').localeCompare(b.sub_category || '');
      if (s !== 0) return s;
      return (b.date || '').localeCompare(a.date || '');
    });
  }

  if (mode === 'category') {
    const groups = {};
    for (const b of sorted) {
      const key = (b.category || 'unknown') + (b.sub_category ? ' / ' + b.sub_category : '');
      (groups[key] ||= []).push(b);
    }
    host.innerHTML = Object.entries(groups).map(([key, items]) => {
      const totalH = items.reduce((s, b) => s + b.hours, 0);
      return `<div class="outlook-day-group">
        <div class="outlook-day-header">${escapeCalHtml(key)} <span class="chip chip-muted" style="font-size:10px">${totalH.toFixed(1)}h · ${items.length}</span></div>
        <div class="outlook-day-events">${items.map(b => renderBookedBlockHtml(b, true)).join('')}</div>
      </div>`;
    }).join('');
    return;
  }

  host.innerHTML = `<div class="outlook-day-group">
    <div class="outlook-day-events">${sorted.map(b => renderBookedBlockHtml(b, true)).join('')}</div>
  </div>`;
}

function renderBookedBlockHtml(b, showDate) {
  const color = CAL_CAT_COLORS[b.category] || '#e5e7eb';
  const tx = CAL_CAT_TEXT[b.category] || '#374151';
  const dateStr = showDate && b.date
    ? new Date(b.date + 'T00:00:00').toLocaleDateString('en-US', { month:'short', day:'numeric', year:'numeric' }) + ' · '
    : '';
  return `<div class="outlook-event">
    <div class="outlook-event-time" style="min-width:60px">${dateStr}${b.hours.toFixed(2)}h</div>
    <div class="outlook-event-details">
      <div class="outlook-event-title">${escapeHtml(b.title || '')}
        <span class="chip" style="background:${color};color:${tx};font-size:10px;margin-left:6px">${escapeHtml(b.category)}${b.sub_category ? ' / ' + escapeHtml(b.sub_category) : ''}</span>
      </div>
      ${b.note ? `<div class="outlook-event-location">${escapeHtml(b.note)}</div>` : ''}
    </div>
  </div>`;
}

function escapeHtml(s) {
  return String(s || '').replace(/[&<>"']/g, c => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
}

function renderBookedHeatmap(groups) {
  // 3-month horizontal strip starting at current month. Each day cell is
  // shaded by total booked hours (0 / <2 / 2-4 / 4+).
  const today = new Date();
  const anchor = new Date(today.getFullYear(), today.getMonth(), 1);
  const months = [0, 1, 2].map(offset => new Date(anchor.getFullYear(), anchor.getMonth() + offset, 1));
  const todayKey = today.toISOString().slice(0, 10);

  function cellClass(h) {
    if (h <= 0) return 'bh-0';
    if (h < 2) return 'bh-1';
    if (h < 4) return 'bh-2';
    return 'bh-3';
  }

  let html = '<div class="booked-heatmap">';
  for (const m of months) {
    const label = m.toLocaleDateString('en-US', { month: 'long', year: 'numeric' });
    const firstDow = m.getDay();
    const daysInMonth = new Date(m.getFullYear(), m.getMonth() + 1, 0).getDate();
    html += `<div class="bh-month"><div class="bh-month-label">${label}</div><div class="bh-grid">`;
    for (const dow of ['S','M','T','W','T','F','S']) html += `<div class="bh-dow">${dow}</div>`;
    for (let i = 0; i < firstDow; i++) html += '<div class="bh-cell bh-blank"></div>';
    for (let d = 1; d <= daysInMonth; d++) {
      const iso = new Date(m.getFullYear(), m.getMonth(), d).toISOString().slice(0, 10);
      const day = groups[iso] || [];
      const hours = day.reduce((s, b) => s + b.hours, 0);
      const isToday = iso === todayKey;
      const title = hours > 0 ? `${iso}: ${hours.toFixed(1)}h across ${day.length} block${day.length === 1 ? '' : 's'}` : iso;
      html += `<div class="bh-cell ${cellClass(hours)}${isToday ? ' bh-today' : ''}" title="${title}"><span class="bh-day">${d}</span>${hours > 0 ? `<span class="bh-hrs">${hours.toFixed(hours < 10 ? 1 : 0)}</span>` : ''}</div>`;
    }
    html += '</div></div>';
  }
  html += '</div>';
  return html;
}

// ---- History tab ----

const CAL_CATS = ['research', 'teaching', 'service', 'admin', 'personal', 'unknown'];
const CAL_CAT_COLORS = {
  research: '#dbeafe', teaching: '#fef3c7', service: '#ede9fe',
  admin: '#e5e7eb', personal: '#fee2e2', unknown: '#fef3c7',
};
const CAL_CAT_TEXT = {
  research: '#1e40af', teaching: '#92400e', service: '#5b21b6',
  admin: '#374151', personal: '#991b1b', unknown: '#78350f',
};

const CAL_HISTORY_STATE = {
  year: null,
  events: [],
  summary: null,
  filterCats: loadCalCatFilter(),
  filterSub: null,
  showFuture: loadCalShowFuture(),
  ratings: { by_event: {}, by_sub_category: {} },
  overrides: {},
  expanded: new Set(),
  expandedGroups: new Set(),   // normalized-title keys whose group is expanded
  timelineChart: null,
  subcatTree: {},
  subcatCounts: {},
  groupRecurring: loadCalGroupRecurring(),  // toggle: collapse recurring events
  search: '',                  // inline search term (title / location / sub)
  sort: 'date-desc',           // sort mode for events list
  trash: [],                   // [{ id, deleted_at, event: {...} }]
  permanentlyDeletedIds: [],   // [id, ...]
  showTrash: false,            // when true, render the trash panel
};

function loadCalCatFilter() {
  try {
    const raw = localStorage.getItem('cal.filterCats');
    if (raw) { const a = JSON.parse(raw); if (Array.isArray(a)) return new Set(a); }
  } catch {}
  return new Set(CAL_CATS);
}
function saveCalCatFilter(set) {
  try { localStorage.setItem('cal.filterCats', JSON.stringify(Array.from(set))); } catch {}
}
function loadCalShowFuture() {
  try { return localStorage.getItem('cal.showFuture') === '1'; } catch { return false; }
}
function saveCalShowFuture(v) {
  try { localStorage.setItem('cal.showFuture', v ? '1' : '0'); } catch {}
}
function loadCalGroupRecurring() {
  try { return localStorage.getItem('cal.groupRecurring') !== '0'; } catch { return true; }
}
function saveCalGroupRecurring(v) {
  try { localStorage.setItem('cal.groupRecurring', v ? '1' : '0'); } catch {}
}

function calDebounce(fn, ms = 120) {
  let t;
  return (...args) => { clearTimeout(t); t = setTimeout(() => fn(...args), ms); };
}

// Normalize a title so "Lab meeting [In-person]" and "lab meeting" collapse
// into one cluster. Mirrors the year-review heuristic.
function normalizeCalTitle(t) {
  return String(t || '')
    .replace(/\s*\[(?:In-person|Online|Zoom|Teams|Phone|Hybrid|Virtual)\]\s*/gi, '')
    .replace(/\s+/g, ' ').trim().toLowerCase().replace(/[.,;:]+$/, '');
}

// Cluster events by normalized title. Returns an array of groups sorted by
// most-recent event date descending. Singletons (count === 1) are returned
// so callers can render them as plain rows.
function clusterCalEvents(events) {
  const map = new Map();
  for (const e of events) {
    const key = normalizeCalTitle(e.title) || e.id;
    const g = map.get(key) || { key, title: e.title || '(untitled)', events: [] };
    g.events.push(e);
    map.set(key, g);
  }
  const out = Array.from(map.values());
  for (const g of out) {
    g.events.sort((a, b) => (b.start || '').localeCompare(a.start || ''));
    g.totalMin = g.events.reduce((s, e) => s + (e.duration_min || 0), 0);
    g.catCounts = {};
    g.subCounts = {};
    for (const e of g.events) {
      g.catCounts[e.category] = (g.catCounts[e.category] || 0) + 1;
      const sk = e.sub_category || '(unspecified)';
      g.subCounts[sk] = (g.subCounts[sk] || 0) + 1;
    }
    // Canonical (category, sub_category) for the group = the mode across members.
    g.dominantCat = Object.entries(g.catCounts).sort((a, b) => b[1] - a[1])[0]?.[0] || 'unknown';
    const sub = Object.entries(g.subCounts).sort((a, b) => b[1] - a[1])[0]?.[0] || '';
    g.dominantSub = sub === '(unspecified)' ? '' : sub;
    g.latest = g.events[0]?.start || '';
    g.earliest = g.events[g.events.length - 1]?.start || '';
  }
  out.sort((a, b) => (b.latest || '').localeCompare(a.latest || ''));
  return out;
}
function calIsFuture(dateStr) {
  return (dateStr || '').slice(0, 10) > new Date().toISOString().slice(0, 10);
}

async function loadCalendarHistoryData() {
  // First try per-user calendarEvents (Phase 7 — Google Calendar OAuth +
  // Outlook ICS + disk-archive backfill). Detect available years via two
  // tiny min/max queries; load only the current year up front. Picker change
  // pulls additional years on demand.
  try {
    const me = (typeof firebridge !== 'undefined' && firebridge.getUser) ? firebridge.getUser() : null;
    let usedFirestore = false;
    if (me && firebridge.db) {
      const detectedYears = await _detectCalendarYears(me);
      if (detectedYears && detectedYears.length) {
        const events = await _loadCalendarEventsAllYears();  // current year only
        CAL_HISTORY_STATE.summary = { years: detectedYears, by_year: {} };
        CAL_HISTORY_STATE._eventsByYear = {};
        const curY = String(new Date().getFullYear());
        if (events && events.length) CAL_HISTORY_STATE._eventsByYear[curY] = events;
        CAL_HISTORY_STATE._sourceMode = 'firestore';
        usedFirestore = true;
      }
    }
    if (!usedFirestore) {
      // Fall through to legacy on-disk archive (Alex's local-dev path).
      const loaded = await api.load('calendar_archive/summary.json');
      CAL_HISTORY_STATE.summary = loaded && loaded.summary;
      if (!CAL_HISTORY_STATE.summary || !Array.isArray(CAL_HISTORY_STATE.summary.years)) {
        return false;
      }
      CAL_HISTORY_STATE._sourceMode = 'legacy';
    }
  } catch (e) {
    return false;
  }
  try {
    CAL_HISTORY_STATE.ratings = await api.load('calendar_archive/ratings.json');
    if (!CAL_HISTORY_STATE.ratings.by_event) CAL_HISTORY_STATE.ratings.by_event = {};
    if (!CAL_HISTORY_STATE.ratings.by_sub_category) CAL_HISTORY_STATE.ratings.by_sub_category = {};
  } catch { CAL_HISTORY_STATE.ratings = { by_event: {}, by_sub_category: {} }; }
  try {
    CAL_HISTORY_STATE.overrides = (await api.load('calendar_archive/category_overrides.json')).overrides || {};
  } catch { CAL_HISTORY_STATE.overrides = {}; }
  try {
    const t = await api.load('calendar_archive/trash.json');
    CAL_HISTORY_STATE.trash = Array.isArray(t.trash) ? t.trash : [];
    CAL_HISTORY_STATE.permanentlyDeletedIds = Array.isArray(t.permanently_deleted_ids) ? t.permanently_deleted_ids : [];
  } catch {
    CAL_HISTORY_STATE.trash = [];
    CAL_HISTORY_STATE.permanentlyDeletedIds = [];
  }
  await loadCalSubcatTree();
  return true;
}

async function saveCalendarTrash() {
  await api.save('calendar_archive/trash.json', {
    trash: CAL_HISTORY_STATE.trash,
    permanently_deleted_ids: CAL_HISTORY_STATE.permanentlyDeletedIds,
  });
}

function calDeletedIdSet() {
  const s = new Set(CAL_HISTORY_STATE.permanentlyDeletedIds);
  for (const t of CAL_HISTORY_STATE.trash) s.add(t.id);
  return s;
}

async function deleteCalEvent(e) {
  // Soft delete: snapshot into trash, recoverable until emptied.
  if (!e || !e.id) return;
  // Avoid duplicate entries
  if (CAL_HISTORY_STATE.trash.some(t => t.id === e.id)) return;
  CAL_HISTORY_STATE.trash.push({
    id: e.id,
    deleted_at: new Date().toISOString(),
    event: { ...e },
  });
  await saveCalendarTrash();
}

async function restoreCalEvent(id) {
  CAL_HISTORY_STATE.trash = CAL_HISTORY_STATE.trash.filter(t => t.id !== id);
  await saveCalendarTrash();
}

async function emptyCalendarTrash() {
  for (const t of CAL_HISTORY_STATE.trash) {
    if (!CAL_HISTORY_STATE.permanentlyDeletedIds.includes(t.id)) {
      CAL_HISTORY_STATE.permanentlyDeletedIds.push(t.id);
    }
  }
  CAL_HISTORY_STATE.trash = [];
  await saveCalendarTrash();
}

async function loadCalSubcatTree() {
  // Shared sub-category tree for the unified picker. Union of:
  //   year-review paths, inbox tasks, activity ledger, and any sub_category
  //   already stored in calendar overrides.
  const records = [];
  try {
    const idx = await api.load('year_review/index.json');
    const year = (idx.years || []).slice().sort().reverse()[0] || String(new Date().getFullYear());
    const doc = await api.load(`year_review/${year}.json`);
    for (const g of (doc.groups || [])) for (const r of (g.rows || [])) {
      records.push({ category: g.category, sub_category: r.sub_category });
    }
  } catch {}
  try {
    const inbox = await api.load('tasks/inbox.json');
    for (const t of (inbox.tasks || [])) {
      if (t.sub_category) records.push({ category: t.category, sub_category: t.sub_category });
    }
  } catch {}
  try {
    const ledger = await api.load('activity_ledger.json');
    for (const a of (ledger.activities || ledger.entries || [])) {
      if (a.sub_category) records.push({ category: a.category, sub_category: a.sub_category });
    }
  } catch {}
  for (const v of Object.values(CAL_HISTORY_STATE.overrides || {})) {
    const o = (typeof v === 'string') ? { category: v } : (v || {});
    if (o.sub_category) records.push({ category: o.category, sub_category: o.sub_category });
  }
  CAL_HISTORY_STATE.subcatTree = YR_SHARED.buildTreeFromRecords(records);
  CAL_HISTORY_STATE.subcatCounts = YR_SHARED.buildCountsFromRecords(records);
  if (YR_SHARED.mergeSeedsIntoTree) {
    await YR_SHARED.mergeSeedsIntoTree(CAL_HISTORY_STATE.subcatTree, CAL_HISTORY_STATE.subcatCounts);
  }
}

async function saveCalendarRatings() {
  await api.save('calendar_archive/ratings.json', CAL_HISTORY_STATE.ratings);
}
async function saveCalendarOverrides() {
  await api.save('calendar_archive/category_overrides.json', { overrides: CAL_HISTORY_STATE.overrides });
}

/* ── Live tab-to-tab sync ──
 * Same pattern as email-review.js — wrap api.save for the 3 calendar user-
 * state paths to set savePending + suppressUntil, then subscribe to each
 * Firestore doc and re-call renderCalendarHistory() when a remote update
 * arrives. Without these gates, an incoming snapshot during a debounce
 * window would clobber CAL_HISTORY_STATE before the save persisted. */
const _calLive = {
  suppressUntil: 0,
  savePending: false,
  unsubs: [],
  refreshTimer: null,
};

/* Debounced + scroll-preserving re-render. Live-sync's apply already mutated
 * CAL_HISTORY_STATE directly, so we call renderCalHistAll() — which targets
 * just the inner sub-sections (summary, cats, analytics, rows) without
 * rewriting the shell. renderCalendarHistory itself sets content.innerHTML
 * to a full template, which is the visible "blink"; renderCalHistAll is the
 * equivalent of email-review's refresh() and updates DOM in place.
 *
 * Falls back to the heavy render only if the shell isn't present yet — e.g.
 * a snapshot arrived before initial boot completes (rare). */
function _calScheduleRefresh() {
  if (_calLive.refreshTimer) return;
  _calLive.refreshTimer = setTimeout(async () => {
    _calLive.refreshTimer = null;
    const scrollY = window.scrollY;
    const active = document.activeElement;
    const activeId = active && active.id;
    try {
      const shellReady = !!document.getElementById('cal-hist-rows');
      if (shellReady && typeof renderCalHistAll === 'function') {
        renderCalHistAll();
      } else {
        await Promise.resolve(renderCalendarHistory({ skipFetch: true }));
      }
    } catch (err) {
      console.warn('[calendar live-sync re-render failed]', err);
    } finally {
      window.scrollTo({ top: scrollY, left: 0, behavior: 'instant' });
      if (activeId) {
        const el = document.getElementById(activeId);
        if (el) { try { el.focus(); } catch (e) {} }
      }
    }
  }, 150);
}
function _calWrapSaves() {
  if (_calWrapSaves._wrapped) return;
  _calWrapSaves._wrapped = true;
  const origSave = api.save.bind(api);
  api.save = async function (path, data) {
    const isCalUserPath = (
      path === 'calendar_archive/ratings.json' ||
      path === 'calendar_archive/category_overrides.json' ||
      path === 'calendar_archive/trash.json'
    );
    if (isCalUserPath) {
      _calLive.savePending = true;
      _calLive.suppressUntil = Date.now() + 2500;
    }
    try {
      return await origSave(path, data);
    } finally {
      if (isCalUserPath) _calLive.savePending = false;
    }
  };
}
function _calAttachLiveSync() {
  if (typeof api.subscribe !== 'function') return;
  if (_calLive.unsubs.length) return;
  const targets = [
    {
      path: 'calendar_archive/ratings.json',
      apply: (data) => {
        const r = data || {};
        if (!r.by_event)        r.by_event        = {};
        if (!r.by_sub_category) r.by_sub_category = {};
        CAL_HISTORY_STATE.ratings = r;
      },
    },
    {
      path: 'calendar_archive/category_overrides.json',
      apply: (data) => {
        CAL_HISTORY_STATE.overrides = (data && data.overrides) || {};
      },
    },
    {
      path: 'calendar_archive/trash.json',
      apply: (data) => {
        CAL_HISTORY_STATE.trash = (data && Array.isArray(data.trash)) ? data.trash : [];
        CAL_HISTORY_STATE.permanentlyDeletedIds =
          (data && Array.isArray(data.permanently_deleted_ids)) ? data.permanently_deleted_ids : [];
      },
    },
  ];
  for (const t of targets) {
    try {
      // Each Firestore subscribe immediately fires once with the current
      // server state — same data the boot-time api.load already gave us.
      // Re-rendering for it is wasted work and the visible "double load" the
      // user sees on hard reload. Skip the first fire per path; subsequent
      // fires (real remote changes from another tab) trigger refresh.
      let firstFireConsumed = false;
      const unsub = api.subscribe(t.path, function (data) {
        if (Date.now() < _calLive.suppressUntil) return;
        if (_calLive.savePending) return;
        if (!data) return;
        try { t.apply(data); }
        catch (err) { console.warn('[calendar live-sync apply failed]', t.path, err); return; }
        if (!firstFireConsumed) {
          firstFireConsumed = true;
          return;
        }
        _calScheduleRefresh();
      });
      _calLive.unsubs.push(unsub);
    } catch (err) {
      console.warn('[calendar] live sync attach failed for', t.path, err.message);
    }
  }
}

async function renderCalendarHistory(opts) {
  opts = opts || {};
  const content = document.getElementById('content');
  // Live-sync calls this with skipFetch:true after mutating CAL_HISTORY_STATE
  // directly — re-fetching there would overwrite the live-applied state with
  // an identical Firestore read AND show the "Loading…" flash. Skip data
  // fetch when state is already populated.
  const stateAlreadyLoaded = !!(CAL_HISTORY_STATE && CAL_HISTORY_STATE.summary);
  if (!(opts.skipFetch && stateAlreadyLoaded)) {
    content.innerHTML = '<div style="padding:16px">Loading…</div>';
    const ok = await loadCalendarHistoryData();
    if (!ok) {
      content.innerHTML = `<div class="card" style="padding:20px">
        <p><strong>No calendar archive yet.</strong></p>
        <p>Run from the repo root:</p>
        <pre>python3 scripts/calendar_scrape.py
python3 scripts/calendar_classify_rules.py
python3 scripts/calendar_split_by_year.py</pre></div>`;
      return;
    }
  }

  const years = CAL_HISTORY_STATE.summary.years.slice().sort().reverse();
  const currentYear = String(new Date().getFullYear());
  const initialYear = CAL_HISTORY_STATE.year || (years.includes(currentYear) ? currentYear : years[0]);
  CAL_HISTORY_STATE.year = initialYear;

  content.innerHTML = `
    <div class="ch-toolbar">
      <select id="cal-hist-year" class="btn" style="font-size:14px">
        ${years.map(y => {
          // by_year is filled lazily as years are loaded — show count when known.
          const entry = CAL_HISTORY_STATE.summary.by_year && CAL_HISTORY_STATE.summary.by_year[y];
          const total = entry ? entry.total : null;
          const sel = y === initialYear ? ' selected' : '';
          return `<option value="${y}"${sel}>${y}${total != null ? ` (${total})` : ''}</option>`;
        }).join('')}
      </select>
      <label style="font-size:12px;color:#374151;display:inline-flex;align-items:center;gap:6px;margin-left:auto;user-select:none">
        <input type="checkbox" id="cal-hist-future"> show future
      </label>
      <button class="btn btn-sm" id="cal-hist-trash-btn" type="button"></button>
    </div>
    <div id="cal-hist-summary" class="ch-summary"></div>
    <div id="cal-hist-cats" style="display:flex;gap:6px;flex-wrap:wrap;margin-bottom:12px"></div>
    <div id="cal-hist-analytics" class="ch-analytics"></div>
    <div class="ch-toolbar" id="cal-hist-events-toolbar">
      <input type="text" id="cal-hist-search" class="btn" placeholder="search title / location / sub-category" style="font-size:14px;min-width:240px;flex:1;max-width:360px">
      <select id="cal-hist-sort" class="btn" style="font-size:13px" title="Sort events">
        <option value="date-desc">Newest first</option>
        <option value="date-asc">Oldest first</option>
        <option value="duration-desc">Longest first</option>
        <option value="duration-asc">Shortest first</option>
        <option value="title">Title (A–Z)</option>
        <option value="rating-desc">Rating (high → low)</option>
      </select>
      <label style="font-size:12px;color:#374151;display:inline-flex;align-items:center;gap:6px;margin-left:auto;user-select:none">
        <input type="checkbox" id="cal-hist-group-recurring"> group recurring events by title
      </label>
    </div>
    <div id="cal-hist-rows"></div>
  `;

  document.getElementById('cal-hist-year').addEventListener('change', async (ev) => {
    CAL_HISTORY_STATE.year = ev.target.value;
    CAL_HISTORY_STATE.expanded = new Set();
    CAL_HISTORY_STATE.filterSub = null;
    await loadCalendarYear();
    renderCalHistAll();
  });
  const searchEl = document.getElementById('cal-hist-search');
  searchEl.value = CAL_HISTORY_STATE.search;
  const debouncedHistUpdate = calDebounce(() => {
    updateCalHistAnalytics();
    renderCalHistRows();
  }, 120);
  searchEl.addEventListener('input', () => {
    CAL_HISTORY_STATE.search = searchEl.value;
    debouncedHistUpdate();
  });
  const sortEl = document.getElementById('cal-hist-sort');
  sortEl.value = CAL_HISTORY_STATE.sort;
  sortEl.addEventListener('change', () => {
    CAL_HISTORY_STATE.sort = sortEl.value;
    renderCalHistRows();
  });
  const groupCb = document.getElementById('cal-hist-group-recurring');
  groupCb.checked = CAL_HISTORY_STATE.groupRecurring;
  groupCb.addEventListener('change', () => {
    CAL_HISTORY_STATE.groupRecurring = groupCb.checked;
    saveCalGroupRecurring(groupCb.checked);
    renderCalHistRows();
  });
  const futureCb = document.getElementById('cal-hist-future');
  futureCb.checked = CAL_HISTORY_STATE.showFuture;
  futureCb.addEventListener('change', (ev) => {
    CAL_HISTORY_STATE.showFuture = ev.target.checked;
    saveCalShowFuture(CAL_HISTORY_STATE.showFuture);
    renderCalHistAll();
  });
  document.getElementById('cal-hist-trash-btn').addEventListener('click', () => {
    CAL_HISTORY_STATE.showTrash = !CAL_HISTORY_STATE.showTrash;
    renderCalHistAll();
  });

  await loadCalendarYear();
  renderCalHistAll();
}

function renderCalHistAll() {
  updateCalTrashButton();
  if (CAL_HISTORY_STATE.showTrash) {
    // Hide the normal analytics/summary panels while viewing trash.
    hideEl('cal-hist-summary');
    hideEl('cal-hist-cats');
    hideEl('cal-hist-analytics');
    hideEl('cal-hist-events-toolbar');
    renderCalTrashRows();
    return;
  }
  showEl('cal-hist-summary');
  showEl('cal-hist-cats');
  showEl('cal-hist-analytics', 'grid');
  showEl('cal-hist-events-toolbar', 'flex');
  renderCalHistCats();
  renderCalHistSummary();
  renderCalHistAnalytics();
  renderCalHistRows();
}

function updateCalTrashButton() {
  const btn = document.getElementById('cal-hist-trash-btn');
  if (!btn) return;
  const n = CAL_HISTORY_STATE.trash.length;
  btn.textContent = CAL_HISTORY_STATE.showTrash
    ? 'Back to events'
    : (n ? `Trash (${n})` : 'Trash');
  btn.classList.toggle('btn-primary', CAL_HISTORY_STATE.showTrash);
}

function hideEl(id) { const el = document.getElementById(id); if (el) el.style.display = 'none'; }
function showEl(id, display) { const el = document.getElementById(id); if (el) el.style.display = display || ''; }

function renderCalTrashRows() {
  const host = document.getElementById('cal-hist-rows');
  const items = CAL_HISTORY_STATE.trash.slice().sort((a, b) => (b.deleted_at || '').localeCompare(a.deleted_at || ''));
  if (!items.length) {
    host.innerHTML = '<div class="card" style="padding:16px;color:#6b7280">Trash is empty.</div>';
    return;
  }
  host.innerHTML = '';
  const header = document.createElement('div');
  header.style.cssText = 'display:flex;justify-content:space-between;align-items:center;margin-bottom:10px;font-size:13px;color:#6b7280';
  header.innerHTML = `<span>${items.length} item${items.length === 1 ? '' : 's'} in trash — recoverable until emptied.</span>`;
  const emptyBtn = document.createElement('button');
  emptyBtn.className = 'btn btn-danger btn-sm';
  emptyBtn.textContent = 'Empty Trash';
  emptyBtn.addEventListener('click', async () => {
    if (!confirm(`Permanently delete ${items.length} item${items.length === 1 ? '' : 's'}? This cannot be undone.`)) return;
    await emptyCalendarTrash();
    renderCalHistAll();
  });
  header.appendChild(emptyBtn);
  host.appendChild(header);

  const wrap = document.createElement('div');
  wrap.className = 'card';
  for (const t of items) {
    const e = t.event || { id: t.id };
    const row = document.createElement('div');
    row.className = 'ch-line';
    const start = e.start ? e.start.replace('T', ' ').slice(0, 16) : '';
    const dur = e.duration_min ? `${(e.duration_min / 60).toFixed(1)}h` : (e.all_day ? 'all day' : '');
    const when = t.deleted_at ? new Date(t.deleted_at).toLocaleString('en-US', { month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit' }) : '';
    row.innerHTML = `
      <div class="col-date">${escapeCalHtml(start)}</div>
      <div>${calCatTag(e.category || 'unknown')}</div>
      <div class="col-main">
        <div class="title">${escapeCalHtml(e.title || '(untitled)')}</div>
        <div class="sub">deleted ${escapeCalHtml(when)}${e.location ? ' · ' + escapeCalHtml(e.location) : ''}</div>
      </div>
      <div class="col-meta">${escapeCalHtml(dur)}</div>
      <div class="col-stars"></div>
      <div class="col-actions"></div>
    `;
    const actions = row.querySelector('.col-actions');
    const restore = document.createElement('button');
    restore.className = 'btn btn-sm';
    restore.type = 'button';
    restore.textContent = 'Restore';
    restore.title = 'Restore this event';
    restore.addEventListener('click', async (ev) => {
      ev.stopPropagation();
      await restoreCalEvent(t.id);
      renderCalHistAll();
    });
    actions.appendChild(restore);
    wrap.appendChild(row);
  }
  host.appendChild(wrap);
}

/* Pull a windowed slice of events from the per-user calendarEvents
 * subcollection. Loading every event ever synced (~1k+ docs, ~1MB on the
 * wire) dominated calendar.html's LCP. The renderer mostly needs current-
 * year events; deeper history loads on demand via the year picker.
 *
 * Strategy: prefer a direct Firestore query with where() + limit when we have
 * a signed-in user (deploys); fall back to the adapter's full fetch only on
 * localhost when api.load can satisfy it from server.py (unmigrated path) or
 * Firestore returns a small subcollection. Returns events in the legacy
 * shape; the caller maps fields. */
async function _loadCalendarEventsAllYears() {
  // Direct Firestore query with a rolling window — only the current year for
  // the initial render. Other years load when the user picks them.
  try {
    const me = (typeof firebridge !== 'undefined' && firebridge.getUser) ? firebridge.getUser() : null;
    if (me && firebridge.db) {
      const y = new Date().getFullYear();
      const yMin = new Date(y + '-01-01T00:00:00Z').toISOString();
      const yMax = new Date((y + 1) + '-01-01T00:00:00Z').toISOString();
      const snap = await firebridge.db()
        .collection('userData').doc(me.uid).collection('calendarEvents')
        .where('start_at', '>=', yMin)
        .where('start_at', '<', yMax)
        .orderBy('start_at', 'asc')
        .limit(800)
        .get();
      if (!snap.empty) {
        return snap.docs.map(d => Object.assign({ id: d.id }, d.data()));
      }
    }
  } catch (err) {
    console.warn('[calendar] windowed query failed, falling back to api.load:', err.message);
  }
  // Fallback: full collection via the adapter (covers legacy/local-dev).
  try {
    const data = await api.load('calendar_archive/events.json');
    return (data && data.events) || [];
  } catch (err) {
    return [];
  }
}

/* Two tiny min/max queries to discover the years span — much faster than
 * loading every event just to count by year. */
async function _detectCalendarYears(me) {
  try {
    const coll = firebridge.db().collection('userData').doc(me.uid).collection('calendarEvents');
    const [oldest, newest] = await Promise.all([
      coll.orderBy('start_at', 'asc').limit(1).get(),
      coll.orderBy('start_at', 'desc').limit(1).get(),
    ]);
    if (newest.empty) return [];
    const newestS = newest.docs[0].data().start_at || '';
    const oldestS = oldest.empty ? newestS : (oldest.docs[0].data().start_at || newestS);
    const newestY = parseInt((newestS || '').slice(0, 4), 10);
    const oldestY = parseInt((oldestS || '').slice(0, 4), 10);
    if (!isFinite(newestY) || !isFinite(oldestY)) return [];
    const years = [];
    for (let y = oldestY; y <= newestY; y++) years.push(String(y));
    return years;
  } catch (err) {
    console.warn('[calendar] year detection failed:', err.message);
    return [];
  }
}

/* Per-year fetch with cache. Hard limit of 800 events/year — covers all but
 * the busiest calendars. */
async function _fetchCalendarEventsForYear(year) {
  const me = firebridge.getUser && firebridge.getUser();
  if (!me) return [];
  const yMin = year + '-01-01T00:00:00Z';
  const yMax = (Number(year) + 1) + '-01-01T00:00:00Z';
  const snap = await firebridge.db()
    .collection('userData').doc(me.uid).collection('calendarEvents')
    .where('start_at', '>=', yMin)
    .where('start_at', '<', yMax)
    .orderBy('start_at', 'asc')
    .limit(800)
    .get();
  return snap.docs.map(d => Object.assign({ id: d.id }, d.data()));
}

function _calYearCache(year) {
  return window.LOCAL_CACHE && window.LOCAL_CACHE.scope('calendarEvents-' + year, 60 * 60_000);
}

// Cheap freshness probe — 1-doc query for the year's most-recent event.
// Returns true when a refresh IS needed. Falls back to refresh on error.
async function _calYearProbe(year, cachedSavedAt) {
  if (!cachedSavedAt) return true;
  try {
    const me = firebridge.getUser && firebridge.getUser();
    if (!me) return false;
    const yMin = year + '-01-01T00:00:00Z';
    const yMax = (Number(year) + 1) + '-01-01T00:00:00Z';
    // synced_at is stamped by both calendar-scraper.js and ics-scraper.js as
    // a server timestamp on every write — that's "when this event was added/
    // updated in our Firestore". Probe for the max sync time and compare to
    // when the cache was written.
    const snap = await firebridge.db()
      .collection('userData').doc(me.uid).collection('calendarEvents')
      .where('start_at', '>=', yMin)
      .where('start_at', '<', yMax)
      .orderBy('start_at', 'desc')
      .limit(1)
      .get();
    if (snap.empty) return false;
    const top = snap.docs[0].data().synced_at;
    if (!top || !top.toMillis) {
      // No synced_at on this doc (legacy backfill row) — probe inconclusive,
      // but if the only doc lacks the field, nothing is being live-scraped,
      // so cache is still valid. Don't force a refresh.
      return false;
    }
    const topMs = top.toMillis();
    return topMs > (cachedSavedAt + 60_000);
  } catch (err) {
    console.warn('[calendar] year probe failed:', err.message);
    return true;
  }
}

/* Build the legacy summary shape ({years: [...], by_year: {year: {total}}})
 * from a flat event list. The renderer's year-picker drop-down + counts
 * depend on this shape; computing it client-side lets us drop the on-disk
 * summary.json dependency. */
function _synthesizeCalendarSummary(events) {
  const byYear = {};
  for (const ev of events) {
    const start = ev.start_at || ev.start || '';
    const y = (start || '').slice(0, 4);
    if (!/^\d{4}$/.test(y)) continue;
    if (!byYear[y]) byYear[y] = { total: 0, events: [] };
    byYear[y].total++;
  }
  const years = Object.keys(byYear).sort();
  return { years, by_year: byYear };
}

async function loadCalendarYear() {
  const y = CAL_HISTORY_STATE.year;
  let archive = [];
  if (CAL_HISTORY_STATE._sourceMode === 'firestore') {
    // Per-year cache (IndexedDB) + Firestore fetch with limit. Already-loaded
    // year served from CAL_HISTORY_STATE._eventsByYear cache.
    let yearEvents = (CAL_HISTORY_STATE._eventsByYear || {})[y];
    if (!yearEvents) {
      const cache = _calYearCache(y);
      let cachedSavedAt = 0;
      if (cache) {
        const cached = await cache.get();
        if (cached && Array.isArray(cached.data) && cached.data.length) {
          yearEvents = cached.data;
          cachedSavedAt = (cached.age != null) ? Date.now() - cached.age : 0;
          // Only probe + refresh when the cache is past its TTL. Within
          // the TTL window we trust the cache and skip both the probe and
          // any followup full re-fetch. (Same reasoning as email-review.)
          if (cached.stale) {
            _calYearProbe(y, cachedSavedAt).then(needsRefresh => {
              if (!needsRefresh) {
                cache.put(yearEvents);  // restart TTL
                return;
              }
              return _fetchCalendarEventsForYear(y).then(fresh => {
                if (fresh && fresh.length) cache.put(fresh);
              });
            }).catch(() => {});
          }
        }
      }
      if (!yearEvents) {
        yearEvents = await _fetchCalendarEventsForYear(y);
        if (cache) await cache.put(yearEvents);
      }
      CAL_HISTORY_STATE._eventsByYear = CAL_HISTORY_STATE._eventsByYear || {};
      CAL_HISTORY_STATE._eventsByYear[y] = yearEvents;
    }
    // Stamp the year's count into the summary so the picker label updates.
    if (CAL_HISTORY_STATE.summary && CAL_HISTORY_STATE.summary.by_year) {
      CAL_HISTORY_STATE.summary.by_year[y] = { total: yearEvents.length };
    }
    archive = yearEvents.map(ev => ({
        id: ev.id,
        title: ev.summary || ev.title || '',
        description: ev.description || '',
        location: ev.location || '',
        organizer: ev.organizer_email || ev.organizer || '',
        start: ev.start_at || ev.start || '',
        end: ev.end_at || ev.end || '',
        all_day: !!ev.all_day,
        attendees: ev.attendees || [],
        recurring: !!ev.recurring_event_id || !!ev.recurring,
        category: ev.category || '',
        sub_category: ev.sub_category || '',
        category_source: ev.category_source || (ev.category ? 'sync' : ''),
        confidence: ev.confidence || 0,
        duration_min: ev.duration_min || 0,
        html_link: ev.html_link || '',
        source: ev.source || 'google',
      }));
  } else {
    const data = await api.load(`calendar_archive/by_year/${y}.json`);
    archive = data.events || [];
  }
  // User-created scheduling blocks (from Tasks → Schedule blocks). We merge
  // them into the same events list so filters, timeline, and the detail row
  // all work uniformly. The archive file itself stays immutable.
  let userEvents = [];
  try {
    const u = await api.load('calendar_user_events.json');
    userEvents = (u.events || []).filter(e => (e.start || '').slice(0, 4) === y);
  } catch {}
  CAL_HISTORY_STATE.events = [...archive, ...userEvents];
  for (const e of CAL_HISTORY_STATE.events) {
    if (CAL_HISTORY_STATE.overrides[e.id]) {
      const raw = CAL_HISTORY_STATE.overrides[e.id];
      const o = (typeof raw === 'string') ? { category: raw } : (raw || {});
      if (o.category) e.category = o.category;
      if (o.sub_category) e.sub_category = o.sub_category;
      if (o.assigned_task_id) e.assigned_task_id = o.assigned_task_id;
      e.category_source = 'manual';
    }
  }
}

function visibleCalEvents() {
  const deleted = calDeletedIdSet();
  return CAL_HISTORY_STATE.events.filter(e =>
    !deleted.has(e.id) &&
    (CAL_HISTORY_STATE.showFuture || !calIsFuture(e.start))
  );
}

function renderCalHistCats() {
  const host = document.getElementById('cal-hist-cats');
  const counts = {};
  for (const c of CAL_CATS) counts[c] = 0;
  for (const e of visibleCalEvents()) counts[e.category] = (counts[e.category] || 0) + 1;
  host.innerHTML = '';
  for (const c of CAL_CATS) {
    if (!counts[c] && c !== 'unknown') continue;
    const chip = document.createElement('span');
    chip.className = 'ch-cat-toggle' + (!CAL_HISTORY_STATE.filterCats.has(c) ? ' off' : '');
    chip.style.background = CAL_CAT_COLORS[c];
    chip.style.color = CAL_CAT_TEXT[c];
    chip.textContent = `${c} ${counts[c].toLocaleString()}`;
    chip.addEventListener('click', () => {
      if (CAL_HISTORY_STATE.filterCats.has(c)) CAL_HISTORY_STATE.filterCats.delete(c);
      else CAL_HISTORY_STATE.filterCats.add(c);
      saveCalCatFilter(CAL_HISTORY_STATE.filterCats);
      CAL_HISTORY_STATE.filterSub = null;
      renderCalHistAll();
    });
    host.appendChild(chip);
  }
  for (const [label, fn] of [
    ['all', () => { CAL_HISTORY_STATE.filterCats = new Set(CAL_CATS); }],
    ['none', () => { CAL_HISTORY_STATE.filterCats = new Set(); }],
    ['-unknown', () => { CAL_HISTORY_STATE.filterCats = new Set(CAL_CATS.filter(c => c !== 'unknown')); }],
  ]) {
    const b = document.createElement('span');
    b.className = 'ch-cat-toggle';
    b.style.background = '#fff';
    b.style.border = '1px solid #e5e7eb';
    b.style.color = '#374151';
    b.textContent = label;
    b.addEventListener('click', () => { fn(); saveCalCatFilter(CAL_HISTORY_STATE.filterCats); CAL_HISTORY_STATE.filterSub = null; renderCalHistAll(); });
    host.appendChild(b);
  }
  if (CAL_HISTORY_STATE.filterSub) {
    const clear = document.createElement('span');
    clear.className = 'ch-cat-toggle';
    clear.style.background = '#fef3c7';
    clear.style.color = '#92400e';
    clear.textContent = `focus: ${CAL_HISTORY_STATE.filterSub} ✕`;
    clear.addEventListener('click', () => { CAL_HISTORY_STATE.filterSub = null; renderCalHistAll(); });
    host.appendChild(clear);
  }
}

function renderCalHistSummary() {
  const host = document.getElementById('cal-hist-summary');
  const all = visibleCalEvents();
  const totalEvents = all.length;
  let totalHours = 0;
  let ratedCount = 0;
  const starDist = { 0: 0, 1: 0, 2: 0, 3: 0, 4: 0, 5: 0 };
  const byCat = {};
  for (const e of all) {
    totalHours += (e.duration_min || 0) / 60;
    const s = CAL_HISTORY_STATE.ratings.by_event[e.id] || 0;
    starDist[s] = (starDist[s] || 0) + 1;
    if (s > 0) ratedCount += 1;
    const cs = byCat[e.category] = byCat[e.category] || { events: 0, hours: 0 };
    cs.events += 1;
    cs.hours += (e.duration_min || 0) / 60;
  }
  const subSet = new Set(all.map(e => e.sub_category).filter(Boolean));
  const big = (val, label, color = '#111827') =>
    `<div><strong style="font-size:22px;color:${color}">${val}</strong><br><span style="color:#6b7280">${label}</span></div>`;
  host.innerHTML = `
    <div style="display:flex;justify-content:space-between;align-items:baseline;margin-bottom:8px">
      <h3 style="margin:0;font-size:15px;color:#111827">Calendar snapshot — ${CAL_HISTORY_STATE.year}</h3>
      <span style="font-size:11px;color:#6b7280">${CAL_HISTORY_STATE.showFuture ? 'including future' : 'past only'}</span>
    </div>
    <div style="display:grid;grid-template-columns:repeat(auto-fit,minmax(130px,1fr));gap:10px;font-size:13px">
      ${big(totalHours.toFixed(1) + 'h', 'total hours', '#2563eb')}
      ${big(totalEvents.toLocaleString(), 'events')}
      ${big(subSet.size.toString(), 'sub-categories')}
      ${big(`${ratedCount} / ${totalEvents}`, 'rated', ratedCount > 0 ? '#f59e0b' : '#6b7280')}
    </div>
    <div style="margin-top:12px;display:flex;flex-wrap:wrap;gap:8px;font-size:12px">
      ${CAL_CATS.filter(c => byCat[c]).map(c => {
        const s = byCat[c];
        return `<span style="display:inline-flex;align-items:center;gap:6px;padding:4px 10px;border-radius:14px;background:${CAL_CAT_COLORS[c]};color:${CAL_CAT_TEXT[c]};font-weight:600">
          <span style="text-transform:uppercase;letter-spacing:.5px">${c}</span>
          <span style="font-weight:500;color:#374151">${s.hours.toFixed(1)}h · ${s.events}e</span>
        </span>`;
      }).join('')}
    </div>
    <div style="margin-top:10px;font-size:11px;color:#6b7280;display:flex;gap:14px;flex-wrap:wrap;align-items:center">
      <span>Star distribution:</span>
      ${[5, 4, 3, 2, 1, 0].map(star => {
        const n = starDist[star] || 0;
        if (!n) return '';
        const color = star === 0 ? '#9ca3af' : '#f59e0b';
        const pct = totalEvents ? ((n / totalEvents) * 100).toFixed(0) : 0;
        return `<span style="display:inline-flex;align-items:center;gap:4px">
          <span style="color:${color}">${'★'.repeat(star) || 'unrated'}</span>
          <strong style="color:#111827">${n}</strong> <span>(${pct}%)</span>
        </span>`;
      }).filter(Boolean).join('')}
    </div>
  `;
}

function renderCalHistAnalytics() {
  // Only rebuild the panel shell when it's missing (first render, or after
  // the trash/events toggle removed it). This keeps the canvas + its Chart
  // instance alive across search keystrokes so we can update data in place
  // without flashing or resizing the panels.
  const host = document.getElementById('cal-hist-analytics');
  const needsShell = !host.querySelector('#cal-hist-timeline');
  if (needsShell) {
    if (CAL_HISTORY_STATE.timelineChart) {
      try { CAL_HISTORY_STATE.timelineChart.destroy(); } catch {}
      CAL_HISTORY_STATE.timelineChart = null;
    }
    host.innerHTML = `
      <div class="ch-panel">
        <h3>Monthly hours by category</h3>
        <div class="ch-timeline-wrap"><canvas id="cal-hist-timeline"></canvas></div>
      </div>
      <div class="ch-panel">
        <h3>Top sub-categories by hours</h3>
        <div id="cal-hist-top"></div>
      </div>
    `;
  }
  updateCalHistAnalytics();
}

function updateCalHistAnalytics() {
  const topHost = document.getElementById('cal-hist-top');
  if (!topHost) return;
  const search = (CAL_HISTORY_STATE.search || '').toLowerCase();
  const visible = visibleCalEvents().filter(e =>
    CAL_HISTORY_STATE.filterCats.has(e.category) &&
    (!search || ((e.title || '') + ' ' + (e.location || '') + ' ' + (e.sub_category || '')).toLowerCase().includes(search)));
  const subAgg = {};
  for (const e of visible) {
    const k = e.sub_category || '(unspecified)';
    const v = subAgg[k] = subAgg[k] || { events: 0, hours: 0, cat: e.category };
    v.events += 1;
    v.hours += (e.duration_min || 0) / 60;
  }
  const topSubs = Object.entries(subAgg).sort((a, b) => b[1].hours - a[1].hours).slice(0, 15);
  topHost.innerHTML = '';
  if (!topSubs.length) {
    topHost.innerHTML = '<div style="padding:8px;color:#6b7280;font-size:12px">No events match the current filter.</div>';
  } else {
    for (const [sub, info] of topSubs) {
      const el = document.createElement('div');
      el.className = 'ch-top-row' + (CAL_HISTORY_STATE.filterSub === sub ? ' active' : '');
      el.innerHTML = `
        <span class="lbl">
          <span style="display:inline-block;width:8px;height:8px;border-radius:50%;background:${CAL_CAT_TEXT[info.cat]};margin-right:8px"></span>
          ${escapeCalHtml(sub)}
        </span>
        <span class="meta">${info.events}e · <strong>${info.hours.toFixed(1)}h</strong></span>`;
      el.addEventListener('click', () => {
        CAL_HISTORY_STATE.filterSub = CAL_HISTORY_STATE.filterSub === sub ? null : sub;
        renderCalHistAll();
      });
      topHost.appendChild(el);
    }
  }
  drawCalTimeline(visible);
}

function drawCalTimeline(events) {
  const canvas = document.getElementById('cal-hist-timeline');
  if (!canvas || typeof Chart === 'undefined') return;
  const MONTH_LABELS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
  const data = {};
  for (const c of CAL_CATS) data[c] = new Array(12).fill(0);
  for (const e of events) {
    const m = (e.start || '').slice(5, 7);
    if (!m) continue;
    const idx = parseInt(m, 10) - 1;
    if (idx < 0 || idx > 11) continue;
    const c = CAL_CATS.includes(e.category) ? e.category : 'unknown';
    data[c][idx] += (e.duration_min || 0) / 60;
  }
  const datasets = CAL_CATS
    .filter(c => data[c].some(v => v > 0))
    .map(c => ({ label: c, data: data[c].map(v => +v.toFixed(1)), backgroundColor: CAL_CAT_TEXT[c], stack: 'cat' }));
  if (CAL_HISTORY_STATE.timelineChart) {
    // In-place update: no destroy, no flash, no canvas recreation.
    CAL_HISTORY_STATE.timelineChart.data.labels = MONTH_LABELS;
    CAL_HISTORY_STATE.timelineChart.data.datasets = datasets;
    CAL_HISTORY_STATE.timelineChart.update('none');
    return;
  }
  CAL_HISTORY_STATE.timelineChart = new Chart(canvas.getContext('2d'), {
    type: 'bar',
    data: { labels: MONTH_LABELS, datasets },
    options: {
      responsive: true, maintainAspectRatio: false,
      plugins: {
        legend: { position: 'bottom', labels: { boxWidth: 10, font: { size: 11 } } },
        tooltip: { callbacks: { label: (ctx) => `${ctx.dataset.label}: ${ctx.parsed.y.toFixed(1)}h` } },
      },
      scales: {
        x: { stacked: true, ticks: { font: { size: 10 } } },
        y: { stacked: true, beginAtZero: true, title: { display: true, text: 'hours' } },
      },
    },
  });
}

function calCatTag(cat) {
  return `<span style="display:inline-block;padding:2px 8px;border-radius:10px;font-size:11px;font-weight:600;text-transform:uppercase;background:${CAL_CAT_COLORS[cat] || CAL_CAT_COLORS.unknown};color:${CAL_CAT_TEXT[cat] || CAL_CAT_TEXT.unknown}">${cat}</span>`;
}

function calRatingFor(e) {
  return CAL_HISTORY_STATE.ratings.by_event[e.id]
    ?? CAL_HISTORY_STATE.ratings.by_sub_category[e.sub_category]
    ?? 0;
}

function sortCalEvents(arr, mode) {
  const out = arr.slice();
  switch (mode) {
    case 'date-asc':
      out.sort((a, b) => (a.start || '').localeCompare(b.start || '')); break;
    case 'duration-desc':
      out.sort((a, b) => (b.duration_min || 0) - (a.duration_min || 0)); break;
    case 'duration-asc':
      out.sort((a, b) => (a.duration_min || 0) - (b.duration_min || 0)); break;
    case 'title':
      out.sort((a, b) => (a.title || '').localeCompare(b.title || '', undefined, { sensitivity: 'base' })); break;
    case 'rating-desc':
      out.sort((a, b) => calRatingFor(b) - calRatingFor(a) || (b.start || '').localeCompare(a.start || '')); break;
    case 'date-desc':
    default:
      out.sort((a, b) => (b.start || '').localeCompare(a.start || '')); break;
  }
  return out;
}

function sortCalGroups(arr, mode) {
  const out = arr.slice();
  const avgRating = (g) => {
    const vals = g.events.map(calRatingFor).filter(v => v > 0);
    return vals.length ? vals.reduce((a, b) => a + b, 0) / vals.length : 0;
  };
  switch (mode) {
    case 'date-asc':
      out.sort((a, b) => (a.latest || '').localeCompare(b.latest || '')); break;
    case 'duration-desc':
      out.sort((a, b) => (b.totalMin || 0) - (a.totalMin || 0)); break;
    case 'duration-asc':
      out.sort((a, b) => (a.totalMin || 0) - (b.totalMin || 0)); break;
    case 'title':
      out.sort((a, b) => (a.title || '').localeCompare(b.title || '', undefined, { sensitivity: 'base' })); break;
    case 'rating-desc':
      out.sort((a, b) => avgRating(b) - avgRating(a) || (b.latest || '').localeCompare(a.latest || '')); break;
    case 'date-desc':
    default:
      out.sort((a, b) => (b.latest || '').localeCompare(a.latest || '')); break;
  }
  return out;
}

function renderCalHistRows() {
  const host = document.getElementById('cal-hist-rows');
  const search = (CAL_HISTORY_STATE.search || '').toLowerCase();
  const rows = visibleCalEvents().filter(e => {
    if (!CAL_HISTORY_STATE.filterCats.has(e.category)) return false;
    if (CAL_HISTORY_STATE.filterSub && (e.sub_category || '(unspecified)') !== CAL_HISTORY_STATE.filterSub) return false;
    if (search) {
      const hay = ((e.title || '') + ' ' + (e.location || '') + ' ' + (e.sub_category || '')).toLowerCase();
      if (!hay.includes(search)) return false;
    }
    return true;
  });
  const sorted = sortCalEvents(rows, CAL_HISTORY_STATE.sort);

  host.innerHTML = '';
  if (!sorted.length) {
    host.appendChild(Object.assign(document.createElement('div'), {
      style: 'padding:12px;color:#6b7280',
      textContent: 'No events match filter.',
    }));
    return;
  }
  const wrap = document.createElement('div');
  wrap.className = 'card';

  if (CAL_HISTORY_STATE.groupRecurring) {
    const groups = sortCalGroups(clusterCalEvents(sorted), CAL_HISTORY_STATE.sort);
    let rendered = 0;
    const MAX = 500;
    for (const g of groups) {
      if (rendered >= MAX) break;
      if (g.events.length === 1) {
        wrap.appendChild(renderCalEventEntry(g.events[0]));
        rendered += 1;
      } else {
        wrap.appendChild(renderCalEventGroup(g));
        rendered += g.events.length;
      }
    }
    if (sorted.length > MAX) {
      wrap.appendChild(Object.assign(document.createElement('div'), {
        style: 'padding:10px;color:#6b7280',
        textContent: `(showing first ${MAX} of ${sorted.length})`,
      }));
    }
  } else {
    for (const e of sorted.slice(0, 500)) wrap.appendChild(renderCalEventEntry(e));
    if (sorted.length > 500) {
      wrap.appendChild(Object.assign(document.createElement('div'), {
        style: 'padding:10px;color:#6b7280',
        textContent: `(showing first 500 of ${sorted.length})`,
      }));
    }
  }
  host.appendChild(wrap);
}

function renderCalEventGroup(g) {
  const wrap = document.createElement('div');
  const expanded = CAL_HISTORY_STATE.expandedGroups.has(g.key);
  const caret = expanded ? '\u25BE' : '\u25B8';
  const hours = (g.totalMin / 60).toFixed(1);
  const dateSpan = g.earliest === g.latest
    ? (g.latest || '').slice(0, 10)
    : `${(g.earliest || '').slice(0, 10)} \u2192 ${(g.latest || '').slice(0, 10)}`;
  const mixedCat = Object.keys(g.catCounts).length > 1;
  const mixedSub = Object.keys(g.subCounts).length > 1;

  const row = document.createElement('div');
  row.className = 'ch-line ch-group-line';
  row.innerHTML = `
    <div class="col-date">${escapeCalHtml(dateSpan)}</div>
    <div>${calCatTag(g.dominantCat)}${mixedCat ? '<span style="margin-left:4px;font-size:10px;padding:1px 4px;background:#fef3c7;color:#92400e;border-radius:4px" title="events in this group use multiple categories">mixed</span>' : ''}</div>
    <div class="col-main">
      <div class="title"><span style="color:#9ca3af;margin-right:4px">${caret}</span>${escapeCalHtml(g.title)} <span style="color:#7c3aed;font-weight:600">\u00d7 ${g.events.length}</span></div>
      <div class="sub">${escapeCalHtml(g.dominantSub || '')}${mixedSub ? ' <span style="color:#92400e">(mixed)</span>' : ''}</div>
    </div>
    <div class="col-meta">${hours}h total</div>
    <div class="col-stars"></div>
    <div class="col-actions"></div>
  `;
  // Average star rating across member events so the group stars reflect the group.
  const starVals = g.events
    .map(e => CAL_HISTORY_STATE.ratings.by_event[e.id] ?? CAL_HISTORY_STATE.ratings.by_sub_category[e.sub_category] ?? 0)
    .filter(v => v > 0);
  const avgStar = starVals.length ? Math.round(starVals.reduce((a, b) => a + b, 0) / starVals.length) : 0;
  row.querySelector('.col-stars').appendChild(starBarCal(avgStar, async (v) => {
    // Apply the chosen rating to every event in the group.
    for (const e of g.events) {
      if (v === 0) delete CAL_HISTORY_STATE.ratings.by_event[e.id];
      else CAL_HISTORY_STATE.ratings.by_event[e.id] = v;
    }
    await saveCalendarRatings();
    renderCalHistAll();
  }));

  const actions = row.querySelector('.col-actions');
  const recat = document.createElement('button');
  recat.className = 'ch-group-recat-btn';
  recat.type = 'button';
  recat.innerHTML = '\u{1F3F7}';   // 🏷 label / tag
  recat.title = `Reassign category + sub-category for all ${g.events.length} events in this group`;
  recat.addEventListener('click', (ev) => {
    ev.stopPropagation();
    openBulkRecategorizeDialog(g);
  });
  actions.appendChild(recat);

  row.addEventListener('click', (ev) => {
    if (ev.target.closest('.stars') || ev.target.closest('.col-actions')) return;
    if (CAL_HISTORY_STATE.expandedGroups.has(g.key)) CAL_HISTORY_STATE.expandedGroups.delete(g.key);
    else CAL_HISTORY_STATE.expandedGroups.add(g.key);
    renderCalHistRows();
  });
  wrap.appendChild(row);

  if (expanded) {
    // Nest individual event rows below the group header so the user can still
    // drill into one specific instance if needed.
    const nest = document.createElement('div');
    nest.style.cssText = 'padding:4px 0 8px 28px;background:#fdfdfd';
    for (const e of g.events) nest.appendChild(renderCalEventEntry(e));
    wrap.appendChild(nest);
  }
  return wrap;
}

function openBulkRecategorizeDialog(group) {
  YR_SHARED.openBulkPicker({
    tree: CAL_HISTORY_STATE.subcatTree || {},
    counts: CAL_HISTORY_STATE.subcatCounts || {},
    initial: { category: group.dominantCat, sub_category: group.dominantSub },
    title: `Reassign ${group.events.length} "${group.title}" events`,
    mruKey: 'event',
    onApply: async ({ category, sub_category }) => {
      if (!category) return;
      // Update every event in the group locally, save overrides once, then
      // fire /api/attach-source per event so they all converge to the same task.
      for (const e of group.events) {
        e.category = category;
        e.sub_category = sub_category;
        e.category_source = 'manual';
        const existing = typeof CAL_HISTORY_STATE.overrides[e.id] === 'object'
          ? CAL_HISTORY_STATE.overrides[e.id] : {};
        CAL_HISTORY_STATE.overrides[e.id] = { ...existing, category, sub_category };
      }
      await saveCalendarOverrides();
      // Keep the shared sub-category tree in sync so the picker sees the new
      // path on its next render without a page refresh.
      if (category && sub_category) {
        YR_SHARED.addPathToTree(CAL_HISTORY_STATE.subcatTree, category, sub_category);
        YR_SHARED.addPathToCounts(CAL_HISTORY_STATE.subcatCounts, category, sub_category);
      }
      if (sub_category) {
        // Auto-attach runs per event but all land on the same task at the path
        // (the server endpoint dedupes). Fire them in parallel.
        await Promise.all(group.events.map(e => attachEventToTask(e)));
      }
      renderCalHistAll();
    },
  });
}

function renderCalEventEntry(e) {
  const wrap = document.createElement('div');
  const caret = CAL_HISTORY_STATE.expanded.has(e.id) ? '\u25BE' : '\u25B8';
  const row = document.createElement('div');
  row.className = 'ch-line';
  const start = e.start ? e.start.replace('T', ' ').slice(0, 16) : '';
  const dur = e.duration_min ? `${(e.duration_min / 60).toFixed(1)}h` : (e.all_day ? 'all day' : '');
  row.innerHTML = `
    <div class="col-date">${escapeCalHtml(start)}</div>
    <div>${calCatTag(e.category)}${e.category_source === 'manual' ? '<span style="margin-left:4px;font-size:10px;padding:1px 4px;background:#fde68a;color:#78350f;border-radius:4px">edit</span>' : ''}</div>
    <div class="col-main">
      <div class="title"><span style="color:#9ca3af;margin-right:4px">${caret}</span>${escapeCalHtml(e.title || '(untitled)')}</div>
      <div class="sub">${escapeCalHtml(e.sub_category || '')}${e.sub_category && e.location ? ' · ' : ''}${escapeCalHtml(e.location || '')}</div>
    </div>
    <div class="col-meta">${escapeCalHtml(dur)}</div>
    <div class="col-stars"></div>
    <div class="col-actions"></div>
  `;
  row.querySelector('.col-stars').appendChild(starBarCal(
    CAL_HISTORY_STATE.ratings.by_event[e.id] ?? CAL_HISTORY_STATE.ratings.by_sub_category[e.sub_category] ?? 0,
    async (v) => {
      if (v === 0) delete CAL_HISTORY_STATE.ratings.by_event[e.id];
      else CAL_HISTORY_STATE.ratings.by_event[e.id] = v;
      await saveCalendarRatings();
      renderCalHistAll();
    },
  ));
  const delBtn = document.createElement('button');
  delBtn.className = 'ch-del-btn';
  delBtn.type = 'button';
  delBtn.title = 'Move to Trash';
  delBtn.innerHTML = '\u{1F5D1}';
  delBtn.addEventListener('click', async (ev) => {
    ev.stopPropagation();
    await deleteCalEvent(e);
    renderCalHistAll();
  });
  row.querySelector('.col-actions').appendChild(delBtn);
  row.addEventListener('click', (ev) => {
    if (ev.target.closest('.stars')) return;
    if (ev.target.closest('.col-actions')) return;
    if (CAL_HISTORY_STATE.expanded.has(e.id)) CAL_HISTORY_STATE.expanded.delete(e.id);
    else CAL_HISTORY_STATE.expanded.add(e.id);
    renderCalHistRows();
  });
  wrap.appendChild(row);
  if (CAL_HISTORY_STATE.expanded.has(e.id)) {
    const exp = document.createElement('div');
    exp.className = 'ch-detail';
    exp.innerHTML = `
      <div style="font-size:12px;color:#6b7280;margin-bottom:6px">
        ${escapeCalHtml(e.start)} → ${escapeCalHtml(e.end || '')}
        · organizer ${escapeCalHtml(e.organizer || '(none)')}
        · attendees ${((e.attendees || []).length).toString()}
      </div>
      <div class="body">${escapeCalHtml(e.description || '(no description)')}</div>
    `;
    const pickerWrap = document.createElement('div');
    pickerWrap.style.cssText = 'margin-top:10px';
    const picker = YR_SHARED.renderPicker({
      ctx: { category: e.category, sub_category: e.sub_category || '' },
      tree: CAL_HISTORY_STATE.subcatTree || {},
      counts: CAL_HISTORY_STATE.subcatCounts || {},
      mode: 'full',
      mruKey: 'event',
      onChange: async (result) => {
        e.category = result.category;
        e.sub_category = result.sub_category;
        e.category_source = 'manual';
        const existing = typeof CAL_HISTORY_STATE.overrides[e.id] === 'object'
          ? CAL_HISTORY_STATE.overrides[e.id] : {};
        CAL_HISTORY_STATE.overrides[e.id] = {
          ...existing,
          category: result.category,
          sub_category: result.sub_category,
        };
        await saveCalendarOverrides();
        await attachEventToTask(e);
        renderCalHistRows();
      },
    });
    pickerWrap.appendChild(picker);
    exp.appendChild(pickerWrap);
    const badgeHost = document.createElement('div');
    badgeHost.style.cssText = 'margin-top:6px;font-size:12px';
    badgeHost.innerHTML = renderEventTaskBadge(e);
    exp.appendChild(badgeHost);

    // "Build a task from this event" — picks a project + fills fields + creates.
    if (window.TASK_QUICK_BUILDER) {
      const startDate = (e.start || '').slice(0, 10);
      const descParts = [];
      if (e.start) descParts.push(`Starts: ${e.start}`);
      if (e.location) descParts.push(`Location: ${e.location}`);
      if (e.description) descParts.push('', e.description);
      exp.appendChild(window.TASK_QUICK_BUILDER.render({
        kind: 'event',
        sourceId: e.id,
        defaultTitle: e.title || '(untitled)',
        defaultDescription: descParts.join('\n'),
        defaultDue: startDate || null,
      }));
    }
    wrap.appendChild(exp);
  }
  return wrap;
}

function starBarCal(current, onSet) {
  const el = document.createElement('span');
  el.className = 'stars';
  el.style.cssText = 'user-select:none;font-size:16px;cursor:pointer;letter-spacing:2px';
  for (let i = 1; i <= 5; i++) {
    const s = document.createElement('span');
    s.style.color = i <= (current || 0) ? '#f59e0b' : '#d1d5db';
    s.textContent = '\u2605';
    s.addEventListener('click', (ev) => {
      ev.stopPropagation();
      onSet(i === current ? 0 : i);
    });
    el.appendChild(s);
  }
  return el;
}

function escapeCalHtml(s) {
  return String(s || '').replace(/[&<>"']/g, c => ({
    '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;',
  }[c]));
}

function extractEventFeatures(e) {
  return {
    sender: '',
    recipients: [],
    organizer: e.organizer || '',
    attendees: (e.attendees || []).map(a => (a && (a.email || a.name)) || '').filter(Boolean),
    subject: e.title || '',
    location: e.location || '',
    body_sample: (e.description || '').slice(0, 200),
  };
}

const CAL_AUTO_ATTACH_BLOCK_CATS = new Set(['noise']);

async function attachEventToTask(e) {
  if (!e.sub_category || !e.category) return;
  if (CAL_AUTO_ATTACH_BLOCK_CATS.has(e.category)) return;
  try {
    const res = await fetch('/api/attach-source', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        source_type: 'event',
        source_id: e.id,
        category: e.category,
        sub_category: e.sub_category,
        features: extractEventFeatures(e),
      }),
    });
    const j = await res.json();
    if (!j.ok) return;
    e.assigned_task_id = j.task_id;
    e.assigned_task_title = j.task_title;
    const existing = typeof CAL_HISTORY_STATE.overrides[e.id] === 'object'
      ? CAL_HISTORY_STATE.overrides[e.id] : {};
    CAL_HISTORY_STATE.overrides[e.id] = { ...existing, assigned_task_id: j.task_id };
  } catch {}
}

function renderEventTaskBadge(e) {
  if (!e.assigned_task_id) return '';
  const title = e.assigned_task_title || e.assigned_task_id;
  return `<span style="display:inline-block;padding:2px 8px;font-size:11px;background:#dcfce7;color:#166534;border-radius:10px" title="Assigned to task ${escapeCalHtml(e.assigned_task_id)}">\u2192 task: ${escapeCalHtml(title)}</span>`;
}

// ---- Init (admin-gated until per-user calendar OAuth ships in Phase 7) ----
(async function () {
  // Phase 9: calendar.js now reads per-user calendarEvents (populated by
  // Google Calendar OAuth + Outlook ICS scrape + the disk-archive backfill),
  // so it works for any signed-in lab member with their own data — no admin
  // gate, no deploy-mode redirect.
  if (typeof firebridge !== 'undefined' && firebridge.whenAuthResolved) {
    try { await firebridge.whenAuthResolved(); } catch (_) {}
  }
  if (typeof firebridge !== 'undefined' && firebridge.gateSignedIn) {
    var gate = await firebridge.gateSignedIn(
      'Sign in to view your calendar. Connect Google Calendar or Outlook ICS in Settings.'
    );
    if (!gate.allowed) return;
  }
  _calWrapSaves();
  document.querySelectorAll('#cal-tabs .tab-btn').forEach(btn => {
    btn.addEventListener('click', () => switchTab(btn.dataset.tab));
  });
  await Promise.resolve(renderCalendarHistory());
  // Live-sync intentionally OFF on calendar (Phase 12). View-mostly page;
  // tab-to-tab updates aren't worth the onSnapshot streams + their network
  // cost on every page boot. Live-sync stays on tasks pages.
  // _calAttachLiveSync();
})();
