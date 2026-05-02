/* year-review.js — unified grid, multi-select, per-item detail */

function loadCatFilter() {
  try {
    const raw = localStorage.getItem('yr.filterCats');
    if (raw) { const a = JSON.parse(raw); if (Array.isArray(a)) return new Set(a); }
  } catch {}
  return new Set(['service', 'research', 'teaching', 'admin', 'personal', 'unknown']);
}
function saveCatFilter(set) {
  try { localStorage.setItem('yr.filterCats', JSON.stringify(Array.from(set))); } catch {}
}

const YR = {
  year: null,
  years: [],
  doc: null,
  yrOverrides: null,
  expandedGroups: new Set(),
  expandedRows: new Set(),        // keyed by sub_category
  expandedItems: new Set(),       // keyed by `event:<id>` | `email:<id>`
  expandedRowEdits: new Set(),    // sub_category keys whose edit box is open
  expandedClusters: new Set(),    // `${subPath}::<normTitle>` keys
  collapsedCategories: new Set(), // categories the user has collapsed
  detailCache: {},                // id -> fetched email detail
  selected: new Map(),            // key -> { kind: 'event'|'email', id, title }
  filterCats: loadCatFilter(),    // categories currently visible
  filterSub: null,                // focus a specific sub_category (null = show all)
  showFuture: loadShowFuture(),   // include items with date > today
  timelineChart: null,
};

function loadShowFuture() {
  try { return localStorage.getItem('yr.showFuture') === '1'; } catch { return false; }
}
function saveShowFuture(v) {
  try { localStorage.setItem('yr.showFuture', v ? '1' : '0'); } catch {}
}

function todayStr() {
  return new Date().toISOString().slice(0, 10);
}
function isFuture(dateStr) {
  return (dateStr || '').slice(0, 10) > todayStr();
}

const CAT_ORDER = ['service', 'research', 'teaching', 'admin', 'personal', 'unknown'];
const CAT_LABEL = {
  service: 'Service', research: 'Research', teaching: 'Teaching',
  admin: 'Administration', personal: 'Personal', unknown: 'Unclassified',
};
const CAT_COLOR = {
  service: '#5b21b6', research: '#1e40af', teaching: '#92400e',
  admin: '#374151', personal: '#991b1b', unknown: '#78350f',
};

/* ---------- boot ---------- */

async function boot() {
  // Phase 9: derive the list of available years from a few sources, in
  // priority order: the legacy index.json (server.py rollup), any synced
  // emailMessages, any synced calendarEvents. Lets the page render for any
  // signed-in lab member with synced data, even if they've never run the
  // local rollup pipeline.
  if (typeof firebridge !== 'undefined' && firebridge.whenAuthResolved) {
    try { await firebridge.whenAuthResolved(); } catch (_) {}
  }
  if (typeof firebridge !== 'undefined' && firebridge.gateSignedIn) {
    const gate = await firebridge.gateSignedIn('Sign in to view your year review.');
    if (!gate.allowed) return;
  }

  let years = [];
  try {
    const idx = await api.load('year_review/index.json');
    years = (idx.years || []).slice();
  } catch {}
  if (!years.length) {
    // Synthesize from emailMessages/calendarEvents.
    try {
      const m = await api.load('email_archive/messages.json');
      for (const row of (m && m.messages) || []) {
        const t = Number(row.internalDate) || 0;
        if (t) years.push(new Date(t).getFullYear().toString());
      }
    } catch {}
    try {
      const e = await api.load('calendar_archive/events.json');
      for (const ev of (e && e.events) || []) {
        const y = (ev.start_at || ev.start || '').slice(0, 4);
        if (/^\d{4}$/.test(y)) years.push(y);
      }
    } catch {}
    years = Array.from(new Set(years));
  }
  if (!years.length) {
    document.getElementById('content').innerHTML = emptyState();
    return;
  }
  YR.years = years.sort().reverse();
  await loadYrOverrides();
  await loadActivityLinks();
  const sel = document.getElementById('yr-year');
  sel.innerHTML = YR.years.map(y => `<option value="${y}">${y}</option>`).join('');
  const currentYear = String(new Date().getFullYear());
  YR.year = YR.years.includes(currentYear) ? currentYear : YR.years[0];
  sel.value = YR.year;
  sel.addEventListener('change', (ev) => { YR.year = ev.target.value; loadAndRender({ preserveState: false }); });
  document.getElementById('yr-refresh').addEventListener('click', () => rebuild());
  const futureCb = document.getElementById('yr-show-future');
  futureCb.checked = YR.showFuture;
  futureCb.addEventListener('change', (ev) => {
    YR.showFuture = ev.target.checked;
    saveShowFuture(YR.showFuture);
    render();
  });
  wireActionBar();
  await loadAndRender();
}

async function loadActivityLinks() {
  try {
    const doc = await api.load('activity_links.json');
    YR.activityLinks = doc.links || { events: {}, emails: {} };
  } catch {
    YR.activityLinks = { events: {}, emails: {} };
  }
  // Load item titles so we can label the links
  try {
    const items = (await api.load('items.json')).items || [];
    YR.itemIndex = {};
    for (const it of items) YR.itemIndex[it.id] = it;
  } catch { YR.itemIndex = {}; }
}

function activityChipsFor(kind, id) {
  const ids = (YR.activityLinks?.[kind === 'event' ? 'events' : 'emails'] || {})[id] || [];
  if (!ids.length) return '';
  return ids.map(iid => {
    const it = YR.itemIndex?.[iid];
    const title = it ? (it.title || iid) : iid;
    const cat = it ? (it.category || '') : '';
    return `<span style="display:inline-block;padding:1px 6px;margin-right:4px;font-size:10px;border-radius:8px;background:#fef3c7;color:#92400e;font-weight:600" title="linked activity: ${escapeHtml(iid)} (${escapeHtml(cat)})">${escapeHtml(title)}</span>`;
  }).join('');
}

async function loadYrOverrides() {
  try {
    YR.yrOverrides = await api.load('year_review/overrides.json');
  } catch {
    YR.yrOverrides = {
      discarded_groups: [], discarded_paths: [], path_moves: {},
      subcat_labels: {}, rating_by_path: {},
    };
  }
  for (const k of ['discarded_groups', 'discarded_paths', 'path_moves', 'subcat_labels', 'rating_by_path']) {
    if (!YR.yrOverrides[k]) YR.yrOverrides[k] = k.startsWith('discarded_') ? [] : {};
  }
}
async function saveYrOverrides() {
  await api.save('year_review/overrides.json', YR.yrOverrides);
}

async function loadAndRender({ preserveState = false } = {}) {
  let doc = null;
  try { doc = await api.load(`year_review/${YR.year}.json`); } catch (_) {}

  // If the precomputed rollup is empty for this year (deploy users without
  // server.py), synthesize a minimal `groups` structure from the synced
  // emailMessages + calendarEvents so the page renders something useful.
  // Rich categorization (cluster grouping, ML refinement) still requires the
  // local rollup pipeline.
  if (!doc || !Array.isArray(doc.groups) || !doc.groups.length) {
    doc = await _synthesizeYearReview(YR.year);
  }
  YR.doc = doc;

  if (!preserveState) {
    YR.expandedGroups = new Set();
    YR.expandedRows = new Set();
    YR.expandedItems = new Set();
    YR.detailCache = {};
    YR.selected = new Map();
    updateActionBar();
  }
  if (!YR.doc || !Array.isArray(YR.doc.groups) || !YR.doc.groups.length) {
    document.getElementById('content').innerHTML = emptyState();
    return;
  }
  render();
}

/* Build a minimal year-review doc from synced emailMessages + calendarEvents
 * for `year`. Groups are bucketed by category (or "uncategorized"); each
 * group's `paths` is a flat list of categories with their event/email rows.
 * Lacks the ML cluster + refinement that the local rollup produces, but is
 * enough to render the page on the deploy. */
async function _synthesizeYearReview(year) {
  let messages = [], events = [];
  try { messages = ((await api.load('email_archive/messages.json')) || {}).messages || []; } catch {}
  try { events = ((await api.load('calendar_archive/events.json')) || {}).events || []; } catch {}

  const yMessages = messages.filter(m => {
    const t = Number(m.internalDate) || 0;
    return t && new Date(t).getFullYear().toString() === year;
  });
  const yEvents = events.filter(ev => (ev.start_at || ev.start || '').slice(0, 4) === year);
  if (!yMessages.length && !yEvents.length) return { groups: [] };

  // Bucket by top-level category. Backfilled rows carry .category; live-scraped
  // rows don't (yet) — they fall into "uncategorized".
  const byCat = new Map();
  function addRow(cat, sub, kind, raw) {
    cat = (cat || 'uncategorized').toLowerCase();
    sub = (sub || '').toLowerCase();
    if (!byCat.has(cat)) byCat.set(cat, new Map());
    const subs = byCat.get(cat);
    if (!subs.has(sub)) subs.set(sub, []);
    subs.get(sub).push({ kind, raw });
  }
  for (const m of yMessages) addRow(m.category, m.sub_category, 'email', m);
  for (const ev of yEvents) addRow(ev.category, ev.sub_category, 'event', ev);

  const groups = [];
  for (const [cat, subs] of byCat.entries()) {
    const paths = [];
    for (const [sub, rows] of subs.entries()) {
      paths.push({
        path: cat + (sub ? '/' + sub : ''),
        category: cat,
        sub_category: sub,
        events: rows.filter(r => r.kind === 'event').map(r => ({
          id: r.raw.id, title: r.raw.summary || r.raw.title || '',
          start: r.raw.start_at || r.raw.start || '',
          end: r.raw.end_at || r.raw.end || '',
          location: r.raw.location || '',
          all_day: !!r.raw.all_day,
        })),
        emails: rows.filter(r => r.kind === 'email').map(r => ({
          id: r.raw.id, subject: r.raw.subject || '',
          from: r.raw.from || '', date: r.raw.date || '',
          snippet: r.raw.snippet || r.raw.body_preview || '',
        })),
      });
    }
    groups.push({
      category: cat,
      key: cat,
      total_events: paths.reduce((s, p) => s + (p.events?.length || 0), 0),
      total_emails: paths.reduce((s, p) => s + (p.emails?.length || 0), 0),
      paths,
    });
  }
  groups.sort((a, b) => (b.total_events + b.total_emails) - (a.total_events + a.total_emails));
  return { groups, _synthesized: true };
}

async function rebuild({ preserveState = true } = {}) {
  const status = document.getElementById('yr-status');
  status.textContent = 'rebuilding…';
  try {
    const res = await fetch('/api/rebuild-year-review', { method: 'POST' });
    const j = await res.json();
    if (!j.ok) { status.textContent = 'rebuild failed: ' + (j.error || (j.stderr || '').slice(0, 200)); return; }
    status.textContent = 'rebuilt.';
    await loadAndRender({ preserveState });
  } catch (e) {
    status.textContent = 'rebuild error: ' + e.message;
  }
  setTimeout(() => { status.textContent = ''; }, 5000);
}

function emptyState() {
  return `<div class="card" style="padding:20px">
    <p><strong>No year-review data yet.</strong></p>
    <p>Run the pipeline from the repo root:</p>
    <pre>python3 scripts/calendar_scrape.py
python3 scripts/calendar_classify_rules.py
python3 scripts/calendar_split_by_year.py
python3 scripts/activity_clusters.py</pre></div>`;
}

/* ---------- render ---------- */

function render() {
  const host = document.getElementById('content');
  host.innerHTML = '';
  let allGroups = (YR.doc.groups || []);
  if (!YR.showFuture) allGroups = filterOutFuture(allGroups);
  if (!allGroups.length) {
    host.innerHTML = '<div style="padding:20px;color:#6b7280">No activity data for this year.</div>';
    return;
  }
  // Apply category filter + sub_category focus to the groups we render.
  const groups = allGroups
    .filter(g => YR.filterCats.has(g.category))
    .map(g => YR.filterSub
      ? { ...g, rows: (g.rows || []).filter(r => r.sub_category === YR.filterSub) }
      : g)
    .filter(g => !YR.filterSub || (g.rows && g.rows.length));
  const byCat = {};
  for (const g of groups) (byCat[g.category] = byCat[g.category] || []).push(g);

  // Always compute summary from ALL (unfiltered) groups so the snapshot
  // doesn't lie about year totals.
  host.appendChild(renderSummaryPanel(allGroups, {}));
  host.appendChild(renderCatToggles(allGroups));
  host.appendChild(renderAnalyticsRow(groups, allGroups));

  for (const cat of CAT_ORDER) {
    if (!byCat[cat]) continue;
    host.appendChild(renderCategorySection(cat, byCat[cat]));
  }

  // CV Summary — always rendered against ALL groups (not filtered), because
  // the user expects to pick from every CV-worthy rollup regardless of which
  // category chips are active. Keep it at the bottom of the page.
  host.appendChild(renderCVSummary(allGroups));
}

/* ---------- CV Summary ---------- */

function renderCVSummary(allGroups) {
  const wrap = document.createElement('div');
  wrap.className = 'yr-cat-section';
  wrap.style.marginTop = '20px';
  wrap.style.borderColor = '#bbf7d0';

  const head = document.createElement('div');
  head.className = 'yr-cat-header';
  head.style.borderLeft = '4px solid #059669';
  head.style.background = '#f0fdf4';
  head.style.cursor = 'default';
  head.innerHTML = `
    <h2 style="color:#065f46">CV Summary</h2>
    <div class="totals">One-line rollups you can add to your CV — edit the title, then click "Add to CV"</div>`;
  wrap.appendChild(head);

  const body = document.createElement('div');
  body.className = 'yr-cat-body';
  body.style.padding = '12px 16px';

  if (typeof CVSend === 'undefined') {
    body.innerHTML = '<div style="color:#6b7280">CV integration not loaded.</div>';
    wrap.appendChild(body);
    return wrap;
  }

  // Collect CV-worthy sub-category rows (explicit rule match only).
  const rows = [];
  for (const g of (allGroups || [])) {
    for (const r of (g.rows || [])) {
      const rule = CVSend.matchRule(r.sub_category);
      if (!rule) continue;
      rows.push({ group: g, row: r, rule });
    }
  }
  if (!rows.length) {
    body.innerHTML = `<div style="padding:10px;color:#6b7280;font-size:13px">
      No CV-candidate sub-categories detected for ${YR.year}. (Rules live in <code>js/cv-send.js</code>.)
    </div>`;
    wrap.appendChild(body);
    return wrap;
  }
  // Order by CV section, then by hours desc within a section.
  const SEC_ORDER = ['awards','presentations','grants','service','courses','students','software','patents','books','conferences','journals'];
  rows.sort((a, b) => {
    const da = SEC_ORDER.indexOf(a.rule.section);
    const db = SEC_ORDER.indexOf(b.rule.section);
    if (da !== db) return da - db;
    return (b.row.hours_total || 0) - (a.row.hours_total || 0);
  });

  // Group by CV section and render a block per section.
  const bySec = {};
  for (const r of rows) (bySec[r.rule.section] = bySec[r.rule.section] || []).push(r);
  for (const secKey of SEC_ORDER) {
    const list = bySec[secKey];
    if (!list) continue;
    body.appendChild(renderCVSummaryBlock(secKey, list));
  }

  wrap.appendChild(body);
  return wrap;
}

function renderCVSummaryBlock(secKey, list) {
  const block = document.createElement('div');
  block.style.cssText = 'margin-bottom:14px';
  const hdr = document.createElement('div');
  hdr.style.cssText = 'font-size:12px;text-transform:uppercase;letter-spacing:.6px;color:#065f46;font-weight:700;padding:6px 0;border-bottom:1px solid #d1fae5;margin-bottom:6px';
  hdr.textContent = (typeof CV_SECTION_LABELS !== 'undefined' && CV_SECTION_LABELS[secKey]) || secKey;
  block.appendChild(hdr);
  for (const item of list) block.appendChild(renderCVSummaryRow(item));
  return block;
}

function renderCVSummaryRow({ group, row, rule }) {
  const line = document.createElement('div');
  line.style.cssText = 'display:grid;grid-template-columns:1fr auto auto;gap:10px;align-items:center;padding:8px 6px;border-bottom:1px solid #f1f5f9;font-size:13px';

  const left = document.createElement('div');
  left.style.cssText = 'min-width:0';
  const titleInput = document.createElement('input');
  titleInput.type = 'text';
  titleInput.value = row.title || '';
  titleInput.style.cssText = 'width:100%;padding:4px 8px;border:1px solid #d1d5db;border-radius:6px;font-size:13px;font-weight:500';
  titleInput.title = row.sub_category || '';
  left.appendChild(titleInput);
  const pathLine = document.createElement('div');
  pathLine.style.cssText = 'font-size:11px;color:#6b7280;margin-top:2px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap';
  pathLine.textContent = (group.category || '') + ' · ' + (row.sub_category || '');
  left.appendChild(pathLine);
  line.appendChild(left);

  const stats = document.createElement('div');
  stats.style.cssText = 'font-variant-numeric:tabular-nums;color:#374151;white-space:nowrap';
  stats.innerHTML = `<strong>${row.event_count}</strong>e · <strong>${row.email_count}</strong>m · <strong>${(row.hours_total || 0).toFixed(1)}</strong>h`;
  line.appendChild(stats);

  const btn = document.createElement('button');
  btn.className = 'btn btn-primary';
  btn.textContent = 'Add to CV';
  btn.style.cssText = 'background:#059669;border-color:#059669';
  btn.addEventListener('click', () => {
    CVSend.open({
      kind: 'summary',
      row: row,
      group: group,
      year: YR.year,
      customTitle: titleInput.value.trim() || row.title,
      subCategory: row.sub_category,
      sourceLabel: `Summary: ${titleInput.value.trim() || row.title} — ${row.event_count} events, ${row.email_count} emails, ${(row.hours_total || 0).toFixed(1)}h (${YR.year})`,
    });
  });
  line.appendChild(btn);

  return line;
}

function renderCatToggles(allGroups) {
  const host = document.createElement('div');
  host.className = 'yr-cat-toggles';
  const counts = {};
  for (const g of allGroups) counts[g.category] = (counts[g.category] || 0) + g.event_count + g.email_count;
  for (const c of CAT_ORDER) {
    if (!counts[c]) continue;
    const chip = document.createElement('span');
    const off = !YR.filterCats.has(c);
    chip.className = 'yr-cat-toggle' + (off ? ' off' : '');
    chip.style.background = CAT_COLOR[c] + '20';
    chip.style.color = CAT_COLOR[c];
    chip.textContent = `${CAT_LABEL[c]} ${counts[c].toLocaleString()}`;
    chip.addEventListener('click', () => {
      if (YR.filterCats.has(c)) YR.filterCats.delete(c);
      else YR.filterCats.add(c);
      saveCatFilter(YR.filterCats);
      YR.filterSub = null;
      render();
    });
    host.appendChild(chip);
  }
  // Quick actions
  for (const [label, fn] of [
    ['all', () => { YR.filterCats = new Set(CAT_ORDER); }],
    ['none', () => { YR.filterCats = new Set(); }],
    ['-unknown', () => { YR.filterCats = new Set(CAT_ORDER.filter(c => c !== 'unknown')); }],
  ]) {
    const b = document.createElement('span');
    b.className = 'yr-cat-toggle';
    b.style.background = '#fff';
    b.style.border = '1px solid #e5e7eb';
    b.style.color = '#374151';
    b.textContent = label;
    b.addEventListener('click', () => {
      fn(); saveCatFilter(YR.filterCats); YR.filterSub = null; render();
    });
    host.appendChild(b);
  }
  if (YR.filterSub) {
    const clear = document.createElement('span');
    clear.className = 'yr-cat-toggle';
    clear.style.background = '#fef3c7';
    clear.style.color = '#92400e';
    clear.textContent = `focus: ${YR.filterSub} ✕`;
    clear.title = 'Click to clear focus';
    clear.addEventListener('click', () => { YR.filterSub = null; render(); });
    host.appendChild(clear);
  }
  return host;
}

function renderAnalyticsRow(groups, allGroups) {
  const row = document.createElement('div');
  row.className = 'yr-analytics';

  // --- timeline panel ---
  const tl = document.createElement('div');
  tl.className = 'yr-panel';
  tl.innerHTML = `<h3>Monthly activity (hours by category)</h3>
    <div class="yr-timeline-wrap"><canvas id="yr-timeline"></canvas></div>`;
  row.appendChild(tl);

  // --- top activities panel ---
  const top = document.createElement('div');
  top.className = 'yr-panel';
  top.innerHTML = `<h3>Top sub-categories by hours</h3>`;
  const list = document.createElement('div');
  const rows = [];
  for (const g of groups) {
    for (const r of (g.rows || [])) {
      rows.push({ cat: g.category, row: r });
    }
  }
  rows.sort((a, b) => b.row.hours_total - a.row.hours_total);
  const topN = rows.slice(0, 15);
  if (!topN.length) {
    list.innerHTML = '<div style="padding:8px;color:#6b7280;font-size:12px">No activities match the current filter.</div>';
  } else {
    for (const { cat, row: r } of topN) {
      const el = document.createElement('div');
      el.className = 'yr-top-row' + (YR.filterSub === r.sub_category ? ' active' : '');
      el.innerHTML = `
        <span class="lbl">
          <span style="display:inline-block;width:8px;height:8px;border-radius:50%;background:${CAT_COLOR[cat]};margin-right:8px"></span>
          ${escapeHtml(r.title)}
          <span style="color:#9ca3af;font-size:11px;margin-left:6px">${escapeHtml(r.sub_category || '')}</span>
        </span>
        <span class="meta">${r.event_count}e · ${r.email_count}m · <strong>${r.hours_total.toFixed(1)}h</strong></span>`;
      el.addEventListener('click', () => {
        YR.filterSub = YR.filterSub === r.sub_category ? null : r.sub_category;
        render();
      });
      list.appendChild(el);
    }
  }
  top.appendChild(list);
  row.appendChild(top);

  // Draw the chart after the canvas is in the DOM. Use a microtask so the
  // layout has finished when Chart.js reads dimensions.
  setTimeout(() => drawTimeline(groups), 0);
  return row;
}

function drawTimeline(groups) {
  const canvas = document.getElementById('yr-timeline');
  if (!canvas || typeof Chart === 'undefined') return;
  // Bucket hours by month and category.
  const MONTH_LABELS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
  const data = {};
  for (const c of CAT_ORDER) data[c] = new Array(12).fill(0);

  const accumulate = (cat, dateStr, hours) => {
    const m = (dateStr || '').slice(5, 7);
    if (!m) return;
    const idx = parseInt(m, 10) - 1;
    if (idx < 0 || idx > 11) return;
    if (!YR.filterCats.has(cat)) return;
    data[cat][idx] += hours;
  };

  for (const g of groups) {
    for (const r of (g.rows || [])) {
      if (YR.filterSub && r.sub_category !== YR.filterSub) continue;
      // Calendar events — precise date → bucket
      for (const a of (r.activities || [])) {
        accumulate(g.category, a.event.start, (a.event.duration_min || 0) / 60);
      }
      // Email-only entries — attribute coordination time to the email's date
      for (const m of (r.emails || [])) {
        accumulate(g.category, m.date, 15 / 60);  // baseline 15 min coord
      }
      // Related emails inside each activity share the event's month
      for (const a of (r.activities || [])) {
        for (const m of (a.related_emails || [])) {
          accumulate(g.category, m.date, 15 / 60);
        }
      }
    }
  }
  const datasets = CAT_ORDER
    .filter(c => data[c].some(v => v > 0) && YR.filterCats.has(c))
    .map(c => ({ label: CAT_LABEL[c], data: data[c].map(v => +v.toFixed(1)), backgroundColor: CAT_COLOR[c], stack: 'cat' }));
  if (YR.timelineChart) YR.timelineChart.destroy();
  YR.timelineChart = new Chart(canvas.getContext('2d'), {
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

function filterOutFuture(groups) {
  // Returns a deep-enough-cloned groups array with future events/emails
  // removed and per-row/group counts + hours recomputed.
  const out = [];
  for (const g of groups) {
    const rows = [];
    let gHours = 0, gEvents = 0, gEmailIds = new Set();
    for (const r of (g.rows || [])) {
      // Filter activities
      const acts = [];
      let rHoursCal = 0;
      let rEventCount = 0;
      const rEmailIds = new Set();
      for (const a of (r.activities || [])) {
        if (isFuture(a.event.start)) continue;
        const related = (a.related_emails || []).filter(m => !isFuture(m.date));
        acts.push({ event: a.event, related_emails: related });
        rHoursCal += ((a.event.duration_min || 0) / 60.0) * weightFromStar(a.event.star || 0);
        rEventCount += 1;
        for (const m of related) rEmailIds.add(m.id);
      }
      const ems = (r.emails || []).filter(m => !isFuture(m.date));
      for (const m of ems) rEmailIds.add(m.id);
      if (!acts.length && !ems.length) continue;
      const coord = Array.from(rEmailIds).reduce((s, id) => {
        // Look up star from the original data (may miss if not found — defaults 0)
        const star = findEmailStar(r, id);
        return s + (15 / 60) * weightFromStar(star);
      }, 0);
      const row = {
        ...r,
        activities: acts,
        emails: ems,
        event_count: rEventCount,
        email_count: rEmailIds.size,
        hours_calendar: +rHoursCal.toFixed(1),
        hours_estimated_coordination: +coord.toFixed(1),
        hours_total: +(rHoursCal + coord).toFixed(1),
      };
      rows.push(row);
      gHours += row.hours_total;
      gEvents += row.event_count;
      for (const id of rEmailIds) gEmailIds.add(id);
    }
    rows.sort((a, b) => b.hours_total - a.hours_total);
    if (rows.length === 0) continue;
    out.push({
      ...g, rows,
      event_count: gEvents,
      email_count: gEmailIds.size,
      hours: +gHours.toFixed(1),
    });
  }
  return out;
}

function weightFromStar(s) {
  const m = { 0: 1.0, 1: 0.5, 2: 1.0, 3: 1.5, 4: 2.0, 5: 3.0 };
  return m[s] ?? 1.0;
}

function findEmailStar(row, emailId) {
  // Search related_emails across activities, then row.emails.
  for (const a of (row.activities || [])) {
    for (const m of (a.related_emails || [])) if (m.id === emailId) return m.star || 0;
  }
  for (const m of (row.emails || [])) if (m.id === emailId) return m.star || 0;
  return 0;
}

function renderSummaryPanel(groups, byCat) {
  const host = document.createElement('div');
  host.style.cssText = 'padding:14px 18px;background:#eff6ff;border:1px solid #dbeafe;border-radius:10px;margin-bottom:16px';

  let totalHours = 0, totalEvents = 0, totalEmails = 0, subCount = 0;
  const byCatStats = {};
  const starDist = { 0: 0, 1: 0, 2: 0, 3: 0, 4: 0, 5: 0 };
  let ratedEvents = 0, ratedEmails = 0;

  for (const g of groups) {
    totalHours += g.hours;
    totalEvents += g.event_count;
    totalEmails += g.email_count;
    subCount += (g.rows || []).length;
    const cs = byCatStats[g.category] = byCatStats[g.category] || { hours: 0, events: 0, emails: 0, subs: 0 };
    cs.hours += g.hours;
    cs.events += g.event_count;
    cs.emails += g.email_count;
    cs.subs += (g.rows || []).length;
    for (const r of (g.rows || [])) {
      for (const a of (r.activities || [])) {
        const s = a.event.star || 0;
        starDist[s] = (starDist[s] || 0) + 1;
        if (s > 0) ratedEvents += 1;
        for (const m of (a.related_emails || [])) {
          const ms = m.star || 0;
          starDist[ms] = (starDist[ms] || 0) + 1;
          if (ms > 0) ratedEmails += 1;
        }
      }
      for (const m of (r.emails || [])) {
        const ms = m.star || 0;
        starDist[ms] = (starDist[ms] || 0) + 1;
        if (ms > 0) ratedEmails += 1;
      }
    }
  }
  const totalItems = totalEvents + totalEmails;
  const rated = ratedEvents + ratedEmails;

  const big = (val, label, color = '#111827') =>
    `<div><strong style="font-size:22px;color:${color}">${val}</strong><br><span style="color:#6b7280">${label}</span></div>`;

  host.innerHTML = `
    <div style="display:flex;justify-content:space-between;align-items:baseline;margin-bottom:8px">
      <h3 style="margin:0;font-size:15px;color:#111827">Year-end snapshot — ${YR.year}</h3>
      <span style="font-size:11px;color:#6b7280">stars weight time: 5★=3×, 1★=0.5×</span>
    </div>
    <div style="display:grid;grid-template-columns:repeat(auto-fit,minmax(130px,1fr));gap:10px;font-size:13px">
      ${big(totalHours.toFixed(1) + 'h', 'total hours', '#2563eb')}
      ${big(totalEvents.toLocaleString(), 'calendar events')}
      ${big(totalEmails.toLocaleString(), 'cross-referenced emails')}
      ${big(groups.length.toString(), 'activity groups')}
      ${big(subCount.toString(), 'sub-categories')}
      ${big(rated + ' / ' + totalItems, 'items rated', rated > 0 ? '#f59e0b' : '#6b7280')}
    </div>

    <div style="margin-top:12px;display:flex;flex-wrap:wrap;gap:8px;font-size:12px">
      ${CAT_ORDER.filter(c => byCatStats[c]).map(c => {
        const s = byCatStats[c];
        return `<span style="display:inline-flex;align-items:center;gap:6px;padding:4px 10px;border-radius:14px;background:${CAT_COLOR[c]}20;color:${CAT_COLOR[c]};font-weight:600">
          <span style="text-transform:uppercase;letter-spacing:.5px">${CAT_LABEL[c] || c}</span>
          <span style="font-weight:500;color:#374151">${s.hours.toFixed(1)}h · ${s.events}e · ${s.emails}m</span>
        </span>`;
      }).join('')}
    </div>

    <div style="margin-top:10px;font-size:11px;color:#6b7280;display:flex;gap:14px;flex-wrap:wrap;align-items:center">
      <span>Star distribution:</span>
      ${[5, 4, 3, 2, 1, 0].map(star => {
        const n = starDist[star] || 0;
        if (!n) return '';
        const color = star === 0 ? '#9ca3af' : '#f59e0b';
        const pct = totalItems ? ((n / totalItems) * 100).toFixed(0) : 0;
        return `<span style="display:inline-flex;align-items:center;gap:4px">
          <span style="color:${color}">${'★'.repeat(star) || 'unrated'}</span>
          <strong style="color:#111827">${n}</strong> <span>(${pct}%)</span>
        </span>`;
      }).filter(Boolean).join('')}
    </div>
  `;
  return host;
}

function renderCategorySection(cat, gs) {
  const catHours = gs.reduce((s, g) => s + g.hours, 0);
  const catEvents = gs.reduce((s, g) => s + g.event_count, 0);
  const catEmails = gs.reduce((s, g) => s + g.email_count, 0);
  const wrap = document.createElement('div');
  wrap.className = 'yr-cat-section';
  const h = document.createElement('div');
  h.className = 'yr-cat-header';
  h.style.borderLeft = `4px solid ${CAT_COLOR[cat] || '#6b7280'}`;
  h.innerHTML = `
    <h2>${CAT_LABEL[cat] || cat}</h2>
    <div class="totals">${catEvents} events · ${catEmails} emails · <strong>${catHours.toFixed(1)} hours</strong></div>`;
  const body = document.createElement('div');
  body.className = 'yr-cat-body';
  if (YR.collapsedCategories.has(cat)) body.classList.add('collapsed');
  h.addEventListener('click', () => {
    if (YR.collapsedCategories.has(cat)) YR.collapsedCategories.delete(cat);
    else YR.collapsedCategories.add(cat);
    body.classList.toggle('collapsed');
  });
  for (const g of gs) body.appendChild(renderGroup(g));
  wrap.appendChild(h);
  wrap.appendChild(body);
  return wrap;
}

function renderGroup(g) {
  const wrap = document.createElement('div');
  wrap.className = 'yr-group';
  const groupKey = `${g.category}:${g.group}`;
  const head = document.createElement('div');
  head.className = 'yr-group-head';
  head.innerHTML = `<span>${escapeHtml(g.label)}</span>`;
  const meta = document.createElement('span');
  meta.className = 'yr-group-totals';
  meta.innerHTML = `${g.event_count} events · ${g.email_count} emails · ${g.hours.toFixed(1)}h
    <span style="color:#dc2626;margin-left:10px;cursor:pointer" data-action="discard-group">✖ discard group</span>`;
  meta.querySelector('[data-action="discard-group"]').addEventListener('click', async (ev) => {
    ev.stopPropagation();
    if (!confirm(`Discard "${g.label}" (${groupKey}) from year-review?`)) return;
    if (!YR.yrOverrides.discarded_groups.includes(groupKey)) YR.yrOverrides.discarded_groups.push(groupKey);
    await saveYrOverrides();
    await rebuild();
  });
  head.appendChild(meta);
  wrap.appendChild(head);
  for (const row of g.rows) wrap.appendChild(renderRow(row, g));
  return wrap;
}

/* ---------- sub-category row (aggregate) ---------- */

function renderRow(row, g) {
  const key = row.sub_category || row.title;
  const expanded = YR.expandedRows.has(key);
  const segs = row.path_segments || (row.sub_category ? row.sub_category.split(':') : []);
  const indentPx = Math.max(segs.length - 1, 0) * 14;

  const wrap = document.createElement('div');

  const line = document.createElement('div');
  line.className = 'yr-line sub-row';
  line.innerHTML = `
    <div class="col-select"></div>
    <div class="col-caret">${expanded ? '▾' : '▸'}</div>
    <div class="col-date"></div>
    <div class="col-main">
      <div class="title"><span class="indent" style="width:${indentPx}px"></span>${escapeHtml(row.title)}</div>
      <div class="sub">${escapeHtml(row.sub_category || '')}</div>
    </div>
    <div class="col-meta"><strong>${row.event_count}</strong> events · <strong>${row.email_count}</strong> emails · <strong>${row.hours_total.toFixed(1)}h</strong>
      <div class="extra" style="font-size:10px">cal ${row.hours_calendar}h + coord ${row.hours_estimated_coordination}h</div></div>
    <div class="col-stars"></div>
    <div class="col-actions"></div>
  `;
  line.addEventListener('click', () => {
    if (YR.expandedRows.has(key)) YR.expandedRows.delete(key); else YR.expandedRows.add(key);
    render();
  });
  wrap.appendChild(line);

  if (expanded) {
    // Single "edit" toggle — expands into a full editor panel for this sub-row
    const actionStrip = document.createElement('div');
    actionStrip.style.cssText = 'padding:6px 14px;font-size:12px;background:#fff;border-bottom:1px solid #f1f5f9;display:flex;gap:14px;align-items:center';
    const editToggle = document.createElement('span');
    editToggle.style.cssText = 'color:#2563eb;cursor:pointer;user-select:none';
    const editOpen = YR.expandedRowEdits.has(key);
    editToggle.textContent = editOpen ? '▾ edit sub-category' : '▸ edit sub-category';
    editToggle.addEventListener('click', (ev) => {
      ev.stopPropagation();
      if (YR.expandedRowEdits.has(key)) YR.expandedRowEdits.delete(key);
      else YR.expandedRowEdits.add(key);
      render();
    });
    actionStrip.appendChild(editToggle);
    wrap.appendChild(actionStrip);

    if (editOpen) wrap.appendChild(renderRowEditor(row, g));

    // Items: group events by normalized title so recurring meetings collapse
    const evs = document.createElement('div');
    evs.className = 'yr-events';
    const clusters = clusterActivitiesByTitle(row.activities || []);
    for (const c of clusters) {
      if (c.activities.length >= 2) evs.appendChild(renderTitleCluster(c, row));
      else if (c.activities.length === 1) {
        const act = c.activities[0];
        evs.appendChild(renderEventLine(act.event, act.related_emails || [], row));
      }
    }
    for (const m of (row.emails || [])) evs.appendChild(renderEmailLine(m, row, false));
    wrap.appendChild(evs);
  }
  return wrap;
}

/* ---------- inline editor for a sub-category row ---------- */

function renderRowEditor(row, g) {
  const wrap = document.createElement('div');
  wrap.className = 'yr-detail';
  wrap.style.cssText += ';padding:12px 14px';
  wrap.addEventListener('click', (ev) => ev.stopPropagation());

  const label = document.createElement('div');
  label.className = 'section';
  label.innerHTML = `
    <div class="label">Display label (what's shown in the rollup)</div>
    <input type="text" data-k="label" value="${escapeHtml(row.title)}" style="min-width:320px;padding:4px 8px;border:1px solid #d1d5db;border-radius:4px">
  `;
  wrap.appendChild(label);

  const pathSection = document.createElement('div');
  pathSection.className = 'section';
  pathSection.innerHTML = `<div class="label">Move this sub-category to a new path</div>`;
  wrap.appendChild(pathSection);

  // Reuse the unified picker (synthetic ctx — we read the result via the
  // picker's _getResult() helper when the user clicks Save Path).
  const pickerCtx = { kind: '_row_', id: '_row_', category: g.category, sub_category: row.sub_category };
  const picker = renderEditRow(pickerCtx);
  pathSection.appendChild(picker);

  const btns = document.createElement('div');
  btns.className = 'section';
  btns.style.cssText = 'display:flex;gap:8px;flex-wrap:wrap';
  btns.innerHTML = `
    <button class="btn btn-primary" data-k="save-label">Save label</button>
    <button class="btn btn-primary" data-k="save-path">Move path</button>
    <button class="btn" data-k="discard" style="color:#dc2626;border-color:#fecaca">Discard this sub-category</button>
    <button class="btn" data-k="reset-label">Reset label override</button>
    <button class="btn" data-k="reset-path">Reset path move</button>
  `;
  wrap.appendChild(btns);

  btns.querySelector('[data-k="save-label"]').addEventListener('click', async (ev) => {
    ev.stopPropagation();
    const val = wrap.querySelector('[data-k="label"]').value.trim();
    if (!val) return;
    YR.yrOverrides.subcat_labels[row.sub_category] = val;
    await saveYrOverrides();
    await rebuild();
  });
  btns.querySelector('[data-k="save-path"]').addEventListener('click', async (ev) => {
    ev.stopPropagation();
    const { sub_category: target } = YR_SHARED.getPickerResult(picker._picker || picker);
    if (!target || target === row.sub_category) return;
    YR.yrOverrides.path_moves[row.sub_category] = target;
    await saveYrOverrides();
    await rebuild();
  });
  btns.querySelector('[data-k="discard"]').addEventListener('click', async (ev) => {
    ev.stopPropagation();
    if (!confirm(`Discard "${row.title}"?`)) return;
    if (!YR.yrOverrides.discarded_paths.includes(row.sub_category)) YR.yrOverrides.discarded_paths.push(row.sub_category);
    await saveYrOverrides(); await rebuild();
  });
  btns.querySelector('[data-k="reset-label"]').addEventListener('click', async (ev) => {
    ev.stopPropagation();
    delete YR.yrOverrides.subcat_labels[row.sub_category];
    await saveYrOverrides(); await rebuild();
  });
  btns.querySelector('[data-k="reset-path"]').addEventListener('click', async (ev) => {
    ev.stopPropagation();
    delete YR.yrOverrides.path_moves[row.sub_category];
    await saveYrOverrides(); await rebuild();
  });
  return wrap;
}

/* ---------- title clustering ---------- */

function normalizeTitle(t) {
  return String(t || '')
    .replace(/\s*\[(?:In-person|Online|Zoom|Teams|Phone)\]\s*/gi, '')
    .replace(/\s+/g, ' ').trim().toLowerCase().replace(/[.,;:]+$/, '');
}

function clusterActivitiesByTitle(activities) {
  const map = new Map();
  for (const act of activities) {
    const key = normalizeTitle(act.event.title);
    const entry = map.get(key) || { title: act.event.title, key, activities: [] };
    entry.activities.push(act);
    map.set(key, entry);
  }
  const out = Array.from(map.values());
  out.sort((a, b) => b.activities.length - a.activities.length);
  return out;
}

function renderTitleCluster(cluster, row) {
  const key = `${row.sub_category}::${cluster.key}`;
  const expanded = YR.expandedClusters.has(key);
  const wrap = document.createElement('div');

  let totalMin = 0, totalStar = 0, starCount = 0;
  const earliest = cluster.activities.reduce((a, b) => (a.event.start < b.event.start ? a : b)).event.start;
  const latest = cluster.activities.reduce((a, b) => (a.event.start > b.event.start ? a : b)).event.start;
  for (const a of cluster.activities) {
    totalMin += a.event.duration_min || 0;
    if (a.event.star) { totalStar += a.event.star; starCount += 1; }
  }
  const avgStar = starCount ? Math.round(totalStar / starCount) : 0;
  const hours = (totalMin / 60).toFixed(1);

  const line = document.createElement('div');
  line.className = 'yr-line event';
  line.style.background = '#fdf4ff';
  line.innerHTML = `
    <div class="col-select"><input type="checkbox" title="Select all ${cluster.activities.length} instances"></div>
    <div class="col-caret">${expanded ? '▾' : '▸'}</div>
    <div class="col-date">${escapeHtml((earliest || '').slice(0, 10))} → ${escapeHtml((latest || '').slice(0, 10))}</div>
    <div class="col-main">
      <div class="title">${escapeHtml(cluster.title)} <span style="color:#7c3aed;font-weight:600">× ${cluster.activities.length}</span></div>
      <div class="sub">${cluster.activities.length} recurring instances</div>
    </div>
    <div class="col-meta">${hours}h total</div>
    <div class="col-stars"></div>
    <div class="col-actions"></div>
  `;
  const cb = line.querySelector('.col-select input');
  cb.addEventListener('click', (e) => e.stopPropagation());
  cb.addEventListener('change', () => {
    for (const a of cluster.activities) {
      const k = `event:${a.event.id}`;
      if (cb.checked) YR.selected.set(k, { kind: 'event', id: a.event.id, title: a.event.title, subPath: row.sub_category });
      else YR.selected.delete(k);
    }
    updateActionBar();
    render();
  });
  // Cluster-level star = avg; clicking sets every instance
  line.querySelector('.col-stars').appendChild(starBarYr(avgStar, async (v) => {
    for (const a of cluster.activities) {
      await rateItem('event', a.event.id, v);
      a.event.star = v;
    }
  }));
  line.querySelector('.col-actions').appendChild(actionIcons([
    { icon: '→', color: '#2563eb', title: 'Move all instances to a sub-category', onClick: async () => {
      const t = prompt(`Sub-category path for ${cluster.activities.length} instances of "${cluster.title}":`, row.sub_category);
      if (!t) return;
      for (const a of cluster.activities) await moveCalEvent(a.event.id, t);
      await rebuild();
    }},
    { icon: '✖', color: '#dc2626', title: 'Discard all instances', onClick: async () => {
      if (!confirm(`Discard all ${cluster.activities.length} instances of "${cluster.title}"?`)) return;
      for (const a of cluster.activities) await discardItem('event', a.event.id, true);
      await rebuild();
    }},
  ]));
  line.addEventListener('click', (ev) => {
    if (ev.target.closest('.col-select') || ev.target.closest('.col-stars') || ev.target.closest('.col-actions')) return;
    if (YR.expandedClusters.has(key)) YR.expandedClusters.delete(key); else YR.expandedClusters.add(key);
    render();
  });
  wrap.appendChild(line);

  if (expanded) {
    const inner = document.createElement('div');
    inner.style.cssText = 'padding-left:20px;border-left:2px solid #e9d5ff';
    for (const a of cluster.activities) {
      inner.appendChild(renderEventLine(a.event, a.related_emails || [], row));
    }
    wrap.appendChild(inner);
  }
  return wrap;
}

/* ---------- event line ---------- */

function renderEventLine(ev, relatedEmails, row) {
  const key = `event:${ev.id}`;
  const expanded = YR.expandedItems.has(key);
  const wrap = document.createElement('div');
  const dur = ev.duration_min ? `${(ev.duration_min / 60).toFixed(1)}h` : (ev.all_day ? 'all-day' : '');

  const line = document.createElement('div');
  line.className = 'yr-line event';
  line.innerHTML = `
    <div class="col-select"><input type="checkbox"></div>
    <div class="col-caret">${expanded ? '▾' : '▸'}</div>
    <div class="col-date">${escapeHtml((ev.start || '').replace('T', ' ').slice(0, 16))}</div>
    <div class="col-main">
      <div class="title">${escapeHtml(ev.title || '(untitled)')}</div>
      <div class="sub">${escapeHtml(ev.location || '')}${relatedEmails.length ? ` · ${relatedEmails.length} related emails` : ''}</div>
    </div>
    <div class="col-meta">${escapeHtml(dur)}</div>
    <div class="col-stars"></div>
    <div class="col-actions"></div>
  `;
  const cb = line.querySelector('.col-select input');
  cb.checked = YR.selected.has(key);
  cb.addEventListener('click', (ev2) => ev2.stopPropagation());
  cb.addEventListener('change', () => {
    if (cb.checked) YR.selected.set(key, { kind: 'event', id: ev.id, title: ev.title, subPath: row.sub_category });
    else YR.selected.delete(key);
    updateActionBar();
  });
  line.querySelector('.col-stars').appendChild(starBarYr(ev.star || 0, async (v) => {
    await rateItem('event', ev.id, v);
    ev.star = v;
    renderInPlace(line.querySelector('.col-stars'), starBarYr(v, arguments.callee), true);
  }));
  line.querySelector('.col-actions').appendChild(actionIcons([
    { icon: '→', color: '#2563eb', title: 'Move to sub-category', onClick: async () => {
      const t = prompt(`Sub-category for "${ev.title}":`, row.sub_category);
      if (!t) return;
      await moveCalEvent(ev.id, t);
      await rebuild();
    }},
    { icon: '✖', color: '#dc2626', title: 'Discard', onClick: async () => {
      if (!confirm(`Discard "${ev.title}"?`)) return;
      await discardItem('event', ev.id, true);
      await rebuild();
    }},
  ]));
  line.addEventListener('click', (ev2) => {
    if (ev2.target.closest('.col-select') || ev2.target.closest('.col-stars') || ev2.target.closest('.col-actions')) return;
    if (YR.expandedItems.has(key)) YR.expandedItems.delete(key); else YR.expandedItems.add(key);
    render();
  });
  wrap.appendChild(line);

  if (expanded) wrap.appendChild(renderEventDetail(ev, relatedEmails, row));
  return wrap;
}

function renderEventDetail(ev, relatedEmails, row) {
  const d = document.createElement('div');
  d.className = 'yr-detail';
  const actHtml = activityChipsFor('event', ev.id);
  d.innerHTML = `
    ${actHtml ? `<div class="section"><div class="label">Linked activities</div>${actHtml}</div>` : ''}
    <div class="section">
      <div class="label">Description</div>
      <div class="body">${escapeHtml(ev.description || '(no description)')}</div>
    </div>
    <div class="section"><div class="label">Where</div>${escapeHtml(ev.location || '—')}</div>
    ${relatedEmails.length ? `<div class="section"><div class="label">Related emails (${relatedEmails.length})</div></div>` : ''}
  `;
  if (relatedEmails.length) {
    const rels = document.createElement('div');
    for (const m of relatedEmails) rels.appendChild(renderEmailLine(m, row, true));
    d.appendChild(rels);
  }
  d.appendChild(renderEditRow({
    kind: 'event', id: ev.id,
    category: null, sub_category: row.sub_category,
  }));
  return d;
}

/* ---------- email line ---------- */

function renderEmailLine(m, row, isRelated) {
  const key = `email:${m.id}`;
  const expanded = YR.expandedItems.has(key);
  const wrap = document.createElement('div');

  const line = document.createElement('div');
  line.className = 'yr-line email' + (isRelated ? ' related' : '');
  line.innerHTML = `
    <div class="col-select"><input type="checkbox"></div>
    <div class="col-caret">${expanded ? '▾' : '▸'}</div>
    <div class="col-date">${escapeHtml((m.date || '').slice(0, 10))}</div>
    <div class="col-main">
      <div class="title">${escapeHtml(m.subject || '(no subject)')}</div>
      <div class="sub">${escapeHtml(m.from || '')}${m.activity_type ? ' · ' + escapeHtml(m.activity_type) : ''}</div>
    </div>
    <div class="col-meta"></div>
    <div class="col-stars"></div>
    <div class="col-actions"></div>
  `;
  const cb = line.querySelector('.col-select input');
  cb.checked = YR.selected.has(key);
  cb.addEventListener('click', (ev2) => ev2.stopPropagation());
  cb.addEventListener('change', () => {
    if (cb.checked) YR.selected.set(key, { kind: 'email', id: m.id, title: m.subject, subPath: row.sub_category });
    else YR.selected.delete(key);
    updateActionBar();
  });
  line.querySelector('.col-stars').appendChild(starBarYr(m.star || 0, async (v) => {
    await rateItem('email', m.id, v);
    m.star = v;
  }));
  line.querySelector('.col-actions').appendChild(actionIcons([
    { icon: '→', color: '#2563eb', title: 'Move to sub-category', onClick: async () => {
      const t = prompt(`Sub-category for "${m.subject}":`, row.sub_category);
      if (!t) return;
      await moveEmail(m.id, t);
      await rebuild();
    }},
    { icon: '✖', color: '#dc2626', title: 'Discard', onClick: async () => {
      if (!confirm(`Discard email?`)) return;
      await discardItem('email', m.id, true);
      await rebuild();
    }},
  ]));
  line.addEventListener('click', (ev2) => {
    if (ev2.target.closest('.col-select') || ev2.target.closest('.col-stars') || ev2.target.closest('.col-actions')) return;
    if (YR.expandedItems.has(key)) YR.expandedItems.delete(key); else YR.expandedItems.add(key);
    render();
  });
  wrap.appendChild(line);

  if (expanded) wrap.appendChild(renderEmailDetail(m, row));
  return wrap;
}

function renderEmailDetail(m, row) {
  const d = document.createElement('div');
  d.className = 'yr-detail';
  const actHtml = activityChipsFor('email', m.id);
  d.innerHTML = `
    ${actHtml ? `<div class="section"><div class="label">Linked activities</div>${actHtml}</div>` : ''}
    <div class="section"><div class="label">Body</div><div class="body" id="det-body-${m.id}">loading…</div></div>
    <div class="section" id="det-atts-${m.id}"></div>
    <div class="section"><div class="label">People</div><div class="people" id="det-people-${m.id}"></div></div>
  `;
  d.appendChild(renderEditRow({
    kind: 'email', id: m.id,
    category: m.category, sub_category: row.sub_category,
  }));
  // Fetch detail
  fetchEmailDetail(m).then((det) => {
    if (!det) { d.querySelector(`#det-body-${m.id}`).textContent = '(no raw path)'; return; }
    const body = det.body_text || stripHtml(det.body_html) || '(no body)';
    d.querySelector(`#det-body-${m.id}`).textContent = body;
    const atts = det.attachments || [];
    if (atts.length) {
      const host = d.querySelector(`#det-atts-${m.id}`);
      host.innerHTML = `<div class="label">Attachments (${atts.length})</div><div class="atts"></div>`;
      const row2 = host.querySelector('.atts');
      for (const a of atts) {
        const link = document.createElement('a');
        link.href = a.url; link.target = '_blank'; link.rel = 'noopener';
        link.textContent = `${a.filename} (${fmtBytes(a.size_bytes)})`;
        row2.appendChild(link);
      }
    }
    // People: from + to + cc
    const people = new Set();
    for (const field of ['from', 'to', 'cc']) {
      const raw = det[field] || '';
      raw.split(',').map(s => s.trim()).filter(Boolean).forEach(p => people.add(p));
    }
    const ph = d.querySelector(`#det-people-${m.id}`);
    ph.innerHTML = '';
    if (!people.size) ph.textContent = '(no people in headers)';
    for (const p of people) {
      const chip = document.createElement('span');
      chip.className = 'chip';
      chip.textContent = p;
      ph.appendChild(chip);
    }
  }).catch(err => {
    d.querySelector(`#det-body-${m.id}`).textContent = 'failed to load: ' + err.message;
  });
  return d;
}

async function fetchEmailDetail(m) {
  if (YR.detailCache[m.id]) return YR.detailCache[m.id];
  // m may not carry path; look it up via the by_year email files
  let path = m.path;
  if (!path) {
    const yr = (m.date || '').slice(0, 4);
    try {
      const yrDoc = await api.load(`email_archive/by_year/${yr}.json`);
      const hit = (yrDoc.emails || []).find(x => x.id === m.id);
      path = hit && hit.path;
    } catch {}
  }
  if (!path) return null;
  const res = await fetch(`/api/email?path=${encodeURIComponent(path)}`);
  if (!res.ok) throw new Error(`status ${res.status}`);
  const j = await res.json();
  YR.detailCache[m.id] = j;
  return j;
}

/* ---------- edit row (category/sub_category) ----------
 *
 * The sub_category is a colon-joined path like "outreach:stem:highschool".
 * Each level is a cascading dropdown pre-populated with every segment that
 * already exists at that level across the current year. Each dropdown also
 * includes a "+ new…" option that reveals a text input so the user can
 * define a brand-new segment on the fly.
 */

function buildPathTree() {
  // Walk all groups/rows in the current year doc and build:
  //   tree[categoryKey] = { seg1: { seg2: { seg3: {} } } }
  const tree = {};
  for (const g of (YR.doc?.groups || [])) {
    const catBucket = tree[g.category] = tree[g.category] || {};
    for (const row of g.rows || []) {
      const path = row.sub_category || '';
      if (!path) continue;
      let node = catBucket;
      for (const seg of path.split(':')) {
        node[seg] = node[seg] || {};
        node = node[seg];
      }
    }
  }
  return tree;
}

function renderEditRow(ctx) {
  // Shell around YR_SHARED.renderPicker that keeps Save / Clear buttons plus
  // the per-row routing (kind = 'event' | 'email' | '_bulk_' | '_row_').
  const wrap = document.createElement('div');
  wrap.className = 'edit-row';
  wrap.style.flexDirection = 'column';
  wrap.style.alignItems = 'stretch';
  wrap.style.gap = '8px';

  const tree = buildPathTree();
  const picker = YR_SHARED.renderPicker({
    ctx: { category: ctx.category || '', sub_category: ctx.sub_category || '' },
    tree,
    mode: 'full',
    mruKey: ctx.kind === 'event' ? 'event' : (ctx.kind === 'email' ? 'email' : 'yr'),
  });
  wrap.appendChild(picker);

  // Bulk and row-scoped callers drive their own buttons; only show Save/Clear
  // on the per-item rows (kind === 'event' | 'email').
  if (ctx.kind === 'event' || ctx.kind === 'email') {
    const btns = document.createElement('div');
    btns.style.cssText = 'display:flex;gap:8px';
    btns.innerHTML = `
      <button class="btn" data-k="save">Save</button>
      <button class="btn" data-k="clear">Clear override</button>
    `;
    wrap.appendChild(btns);
    btns.querySelector('[data-k="save"]').addEventListener('click', async (ev) => {
      ev.stopPropagation();
      const { category, sub_category } = YR_SHARED.getPickerResult(picker);
      if (ctx.kind === 'event') await moveCalEvent(ctx.id, sub_category, category);
      else await moveEmail(ctx.id, sub_category, category);
      await rebuild();
    });
    btns.querySelector('[data-k="clear"]').addEventListener('click', async (ev) => {
      ev.stopPropagation();
      await clearOverride(ctx.kind, ctx.id);
      await rebuild();
    });
  }
  // Expose the picker so callers (bulk, row-edit) can read the result directly.
  wrap._picker = picker;
  return wrap;
}

/* ---------- bulk action bar ---------- */

function wireActionBar() {
  document.getElementById('yr-sel-clear').addEventListener('click', () => {
    YR.selected.clear(); updateActionBar(); render();
  });
  document.getElementById('yr-sel-discard').addEventListener('click', async () => {
    if (!YR.selected.size) return;
    if (!confirm(`Discard ${YR.selected.size} selected items?`)) return;
    for (const [, it] of YR.selected) await discardItem(it.kind, it.id, true);
    YR.selected.clear(); await rebuild();
  });
  document.getElementById('yr-sel-move').addEventListener('click', () => {
    if (!YR.selected.size) return;
    openBulkMoveDialog();
  });
  document.getElementById('yr-sel-rate').addEventListener('click', async () => {
    if (!YR.selected.size) return;
    const raw = prompt(`Stars to apply to ${YR.selected.size} items (0–5):`, '3');
    if (raw === null) return;
    const stars = Math.max(0, Math.min(5, parseInt(raw, 10) || 0));
    for (const [, it] of YR.selected) await rateItem(it.kind, it.id, stars);
    YR.selected.clear();
    await rebuild();
  });
}

function openBulkMoveDialog() {
  const first = YR.selected.values().next().value;
  YR_SHARED.openBulkPicker({
    tree: buildPathTree(),
    initial: { category: null, sub_category: first?.subPath || '' },
    title: `Move ${YR.selected.size} items to a sub-category`,
    mruKey: 'yr',
    onApply: async ({ category, sub_category }) => {
      if (!sub_category) return;
      for (const [, it] of YR.selected) {
        if (it.kind === 'event') await moveCalEvent(it.id, sub_category, category);
        else await moveEmail(it.id, sub_category, category);
      }
      YR.selected.clear();
      await rebuild();
    },
  });
}

function updateActionBar() {
  const bar = document.getElementById('yr-actionbar');
  document.getElementById('yr-sel-count').textContent = `${YR.selected.size} selected`;
  if (YR.selected.size > 0) bar.classList.add('open');
  else bar.classList.remove('open');
}

/* ---------- persistence helpers ---------- */

async function rateItem(kind, id, stars) {
  const path = kind === 'event' ? 'calendar_archive/ratings.json' : 'email_archive/ratings.json';
  let doc;
  try { doc = await api.load(path); } catch { doc = {}; }
  const key = kind === 'event' ? 'by_event' : 'by_email';
  doc[key] = doc[key] || {};
  if (!stars) delete doc[key][id]; else doc[key][id] = stars;
  await api.save(path, doc);
}

async function discardItem(kind, id, discarded) {
  const path = kind === 'event' ? 'calendar_archive/category_overrides.json' : 'email_archive/category_overrides.json';
  let doc;
  try { doc = await api.load(path); } catch { doc = { overrides: {} }; }
  doc.overrides = doc.overrides || {};
  const existing = doc.overrides[id];
  if (typeof existing === 'string') doc.overrides[id] = { category: existing, discarded };
  else doc.overrides[id] = { ...(existing || {}), discarded };
  await api.save(path, doc);
}

async function moveCalEvent(id, newSubPath, newCategory) {
  const doc = await loadOrEmpty('calendar_archive/category_overrides.json', { overrides: {} });
  doc.overrides[id] = { ...(toObj(doc.overrides[id]) || {}) };
  if (newSubPath) doc.overrides[id].sub_category = newSubPath;
  if (newCategory) doc.overrides[id].category = newCategory;
  await api.save('calendar_archive/category_overrides.json', doc);
}

async function moveEmail(id, newSubPath, newCategory) {
  const doc = await loadOrEmpty('email_archive/category_overrides.json', { overrides: {} });
  doc.overrides[id] = { ...(toObj(doc.overrides[id]) || {}) };
  if (newCategory) doc.overrides[id].category = newCategory;
  if (newSubPath) doc.overrides[id].sub_category = newSubPath;  // forward-compat
  await api.save('email_archive/category_overrides.json', doc);
}

async function clearOverride(kind, id) {
  const path = kind === 'event' ? 'calendar_archive/category_overrides.json' : 'email_archive/category_overrides.json';
  const doc = await loadOrEmpty(path, { overrides: {} });
  delete doc.overrides[id];
  await api.save(path, doc);
}

async function loadOrEmpty(path, fallback) {
  try {
    const d = await api.load(path);
    if (!d.overrides) d.overrides = {};
    return d;
  } catch { return fallback; }
}

function toObj(v) {
  if (typeof v === 'string') return { category: v };
  return v || {};
}

/* ---------- UI atoms ---------- */

function starBarYr(current, onSet, sizePx = 13) {
  const el = document.createElement('span');
  el.className = 'stars';
  el.style.cssText = `user-select:none;font-size:${sizePx}px;cursor:pointer;letter-spacing:1px;white-space:nowrap`;
  for (let i = 1; i <= 5; i++) {
    const s = document.createElement('span');
    s.style.color = i <= (current || 0) ? '#f59e0b' : '#d1d5db';
    s.textContent = '★';
    s.addEventListener('click', (ev) => { ev.stopPropagation(); onSet(i === current ? 0 : i); });
    el.appendChild(s);
  }
  return el;
}

function actionIcons(btns) {
  const host = document.createElement('span');
  host.style.cssText = 'display:flex;gap:6px;align-items:center';
  for (const b of btns) {
    const s = document.createElement('span');
    s.style.cssText = `color:${b.color};cursor:pointer;font-size:12px`;
    s.title = b.title;
    s.textContent = b.icon;
    s.addEventListener('click', async (ev) => { ev.stopPropagation(); await b.onClick(); });
    host.appendChild(s);
  }
  return host;
}

function renderInPlace(parent, newEl, replaceAll) {
  if (replaceAll) { parent.innerHTML = ''; parent.appendChild(newEl); }
  else parent.appendChild(newEl);
}

function stripHtml(s) {
  if (!s) return '';
  return s.replace(/<style[^>]*>[\s\S]*?<\/style>/gi, '')
          .replace(/<script[^>]*>[\s\S]*?<\/script>/gi, '')
          .replace(/<[^>]+>/g, ' ').replace(/&nbsp;/g, ' ').replace(/\s+/g, ' ').trim();
}

function fmtBytes(n) {
  if (!n) return '0 B';
  const u = ['B', 'KB', 'MB', 'GB']; let i = 0;
  while (n >= 1024 && i < u.length - 1) { n /= 1024; i++; }
  return `${n.toFixed(n < 10 ? 1 : 0)} ${u[i]}`;
}

function escapeHtml(s) {
  return String(s || '').replace(/[&<>"']/g, c => ({
    '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;',
  }[c]));
}

document.addEventListener('DOMContentLoaded', async () => {
  await boot();
  // No LIVE_SYNC.attach (per user direction 2026-05-01) — year-review is a
  // view-mostly page; tab-to-tab snapshot streams aren't worth their initial
  // 8-listener round trip. Reload the page to see fresh data.
});
