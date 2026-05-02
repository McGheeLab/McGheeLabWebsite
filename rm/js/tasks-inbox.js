/* tasks-inbox.js — unified tasks inbox.
 *
 * Tabs: Needs Review | Active | Upcoming | Completed | Daily | Weekly |
 *       Monthly | Annual | Legacy Email Tasks
 *
 * Reads: data/tasks/inbox.json, data/activity_ledger.json,
 *        data/year_review/<year>.json (for the live sub-category tree),
 *        data/calendar_archive/events_v2.jsonl (paths via /api/data),
 *        data/email_archive/by_year/<year>.json (email paths for detail pane).
 *
 * Writes: data/tasks/inbox.json via api.save; /api/task-decision;
 *         /api/complete-task; /api/suggest-tasks.
 */

const S = window.YR_SHARED;
if (!S) console.error('yr-shared.js must load before tasks-inbox.js');

const INBOX = {
  inbox: null,
  ledger: null,
  tree: {},
  // Events/emails loaded lazily once for evidence rendering
  eventsById: null,
  emailPathById: {},
  activityLinks: null,
  itemIndex: null,
  // UI state
  activeTab: 'review',
  expanded: new Set(),
  selected: new Map(),
  detailCache: {},
  filterCats: loadTaskFilterCats(),
  needsHoursOnly: loadNeedsHoursFilter(),
  firebridgeReady: false,
  // Email-id → disposition map, populated once at load so every task row can
  // pick the most-severe glyph from its evidence.email_ids.
  dispositionMap: {},
};

// Active tab covers both `accepted` (just triaged) and `active` (planned).
// "Assignments pending" is no longer a separate tab — use the top-of-tab
// "Needs hours estimate" filter to narrow down tasks without sizing.
const TABS = [
  { key: 'review',    label: 'Needs Review',       statuses: ['suggested'] },
  { key: 'today',     label: 'Today',              statuses: ['active'] },
  { key: 'active',    label: 'Active',             statuses: ['active', 'accepted'] },
  { key: 'calendar',  label: 'Calendar',           statuses: ['suggested', 'active'], source: 'calendar' },
  { key: 'upcoming',  label: 'Upcoming Deadlines', statuses: ['active', 'suggested'] },
  { key: 'completed', label: 'Completed',          statuses: [] },
];

function loadNeedsHoursFilter() {
  try { return localStorage.getItem('tasks.needsHoursOnly') === '1'; } catch { return false; }
}
function saveNeedsHoursFilter(v) {
  try { localStorage.setItem('tasks.needsHoursOnly', v ? '1' : '0'); } catch {}
}

/* ---------- derived priority ----------
 *
 * The canonical priority is computed from due_date + hours_estimate +
 * hours already logged (activity_ledger.json). Static `task.priority` is
 * only used as a fallback when there's no due_date to compute against.
 */
// Derived priority + the Description/Planning/Pacing/Action-items editor
// live in js/task-editor.js — shared with the email-review page so both
// views read identically. hoursLoggedForTask is local here because pacing
// needs to look at this page's ledger.

function hoursLoggedForTask(taskId) {
  if (!taskId) return 0;
  let total = 0;
  for (const a of (INBOX.ledger?.activities || [])) {
    if (a.from_task_id === taskId || a.task_id === taskId) total += (a.hours || 0);
  }
  for (const e of (INBOX.ledger?.entries || [])) {
    if (e.task_id === taskId) total += (e.hours || 0);
  }
  return total;
}

function loadTaskFilterCats() {
  try {
    const raw = localStorage.getItem('tasks.filterCats');
    if (raw) { const a = JSON.parse(raw); if (Array.isArray(a)) return new Set(a); }
  } catch {}
  return new Set(['service', 'research', 'teaching', 'admin', 'personal', 'unknown']);
}
function saveTaskFilterCats(set) {
  try { localStorage.setItem('tasks.filterCats', JSON.stringify(Array.from(set))); } catch {}
}

/* ---------- boot ---------- */

async function boot() {
  await Promise.all([loadInbox(), loadLedger(), loadTree(), loadActivityLinks(), loadItems(), loadPinnedBuckets(), loadDispositionMap()]);
  checkFirebridge();
  // Honor #hash
  const h = (location.hash || '').replace('#', '');
  if (TABS.some(t => t.key === h)) INBOX.activeTab = h;
  render();
  document.getElementById('add-task').addEventListener('click', onAddClick);
  document.addEventListener('keydown', onKeyDown);
  mountActivityTracker();
}

async function loadInbox() {
  try {
    INBOX.inbox = await api.load('tasks/inbox.json');
  } catch {
    INBOX.inbox = { tasks: [] };
  }
  INBOX.inbox.tasks = INBOX.inbox.tasks || [];
}
async function loadLedger() {
  try {
    INBOX.ledger = await api.load('activity_ledger.json');
  } catch {
    INBOX.ledger = { activities: [] };
  }
}
async function loadTree() {
  // Build the sub-category tree from the union of (year-review paths + all
  // inbox + ledger sub-categories). Including inbox/ledger means any path a
  // user just typed shows up immediately in the picker/tree browser — no
  // year-review rebuild required.
  const records = [];
  try {
    const idx = await api.load('year_review/index.json');
    const year = (idx.years || []).slice().sort().reverse()[0] || String(new Date().getFullYear());
    const doc = await api.load(`year_review/${year}.json`);
    for (const g of (doc.groups || [])) for (const r of (g.rows || [])) {
      records.push({ category: g.category, sub_category: r.sub_category });
    }
  } catch {}
  for (const t of (INBOX.inbox?.tasks || [])) {
    if (t.sub_category) records.push({ category: t.category, sub_category: t.sub_category });
  }
  for (const a of (INBOX.ledger?.activities || [])) {
    if (a.sub_category) records.push({ category: a.category, sub_category: a.sub_category });
  }
  INBOX.tree = S.buildTreeFromRecords(records);
  if (S.mergeSeedsIntoTree) {
    await S.mergeSeedsIntoTree(INBOX.tree, null);
  }
}

function refreshTreeFromMemory() {
  // Fast, in-memory refresh (no fetch) — call after inbox edits so the
  // picker/tree reflect the user's latest pick without waiting for a
  // year-review rebuild.
  const records = [];
  for (const t of (INBOX.inbox?.tasks || [])) {
    if (t.sub_category) records.push({ category: t.category, sub_category: t.sub_category });
  }
  for (const a of (INBOX.ledger?.activities || [])) {
    if (a.sub_category) records.push({ category: a.category, sub_category: a.sub_category });
  }
  // Merge into the existing tree rather than replacing so we don't lose
  // year-review paths that didn't appear in inbox/ledger.
  const addition = S.buildTreeFromRecords(records);
  for (const cat of Object.keys(addition)) {
    INBOX.tree[cat] = INBOX.tree[cat] || {};
    mergeInto(INBOX.tree[cat], addition[cat]);
  }
}

function mergeInto(dst, src) {
  for (const k of Object.keys(src || {})) {
    dst[k] = dst[k] || {};
    mergeInto(dst[k], src[k]);
  }
}
async function loadActivityLinks() {
  try {
    INBOX.activityLinks = (await api.load('activity_links.json')).links || { events: {}, emails: {} };
  } catch {
    INBOX.activityLinks = { events: {}, emails: {} };
  }
}
async function loadDispositionMap() {
  if (window.DISPOSITION && window.DISPOSITION.loadMap) {
    try { INBOX.dispositionMap = await window.DISPOSITION.loadMap(); }
    catch { INBOX.dispositionMap = {}; }
  }
}
async function loadItems() {
  try {
    const doc = await api.load('items.json');
    INBOX.itemIndex = {};
    for (const it of (doc.items || [])) INBOX.itemIndex[it.id] = it;
  } catch {
    INBOX.itemIndex = {};
  }
}

async function loadPinnedBuckets() {
  try {
    const doc = await api.load('tasks/pinned_buckets.json');
    INBOX._pinnedBucketKeys = new Set(
      (doc.buckets || []).map(b => `${b.category || ''}\u00A7${b.sub_category || ''}`)
    );
  } catch {
    INBOX._pinnedBucketKeys = new Set();
  }
}

function checkFirebridge() {
  INBOX.firebridgeReady = !!(window.firebridge && typeof window.firebridge.isAdmin === 'function');
}

/* ---------- save helpers ---------- */

async function saveInbox() {
  INBOX.inbox.generated_at = new Date().toISOString();
  await api.save('tasks/inbox.json', INBOX.inbox);
  // New sub-categories the user just typed should be immediately pickable
  // for other tasks — refresh the in-memory tree.
  refreshTreeFromMemory();
}

async function logDecision(task, action, before, after, reason = '') {
  try {
    await fetch('/api/task-decision', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        task_id: task.id,
        action,
        title: task.title,
        source: task.source,
        before, after, reason,
      }),
    });
  } catch (e) {
    console.warn('task-decision log failed:', e);
  }
}

/* ---------- top-level render ---------- */

function render() {
  const host = document.getElementById('content');
  host.innerHTML = '';
  host.appendChild(renderToolbar());
  host.appendChild(renderTabs());

  host.appendChild(renderCatToggles());
  host.appendChild(renderSummary());
  host.appendChild(renderList());
  host.appendChild(renderActionBar());
  updateActionBar();
}

function renderToolbar() {
  // Import + Run suggester moved to the Activity Overview page (start of the
  // workflow, not the end). Keep a small inline link so users landing here
  // can jump back without using the top nav.
  const bar = document.createElement('div');
  bar.className = 'inbox-toolbar';
  bar.innerHTML = `
    <a href="/rm/pages/activity-overview.html" class="btn" style="text-decoration:none" title="Import emails + calendar and run the ML classifier. Lives on the Activity Overview page.">\u2190 Activity Overview</a>
    <div style="margin-left:auto;font-size:12px;color:#6b7280" id="task-counts"></div>
  `;
  setTimeout(updateCountsBadge, 0);
  return bar;
}

function updateCountsBadge() {
  const t = document.getElementById('task-counts');
  if (!t) return;
  const c = { suggested: 0, active: 0, snoozed: 0, completed: 0 };
  for (const x of (INBOX.inbox?.tasks || [])) c[x.status] = (c[x.status] || 0) + 1;
  t.textContent = `${c.suggested} suggested · ${c.active} active · ${c.snoozed || 0} snoozed · ${(INBOX.ledger?.activities || []).length} ledger`;
}

function renderTabs() {
  const bar = document.createElement('div');
  bar.className = 'tab-bar';
  for (const t of TABS) {
    const btn = document.createElement('button');
    btn.className = 'tab-btn' + (INBOX.activeTab === t.key ? ' active' : '');
    const statuses = t.statuses || [];
    let badge = '';
    if (t.key === 'review') {
      const n = (INBOX.inbox?.tasks || []).filter(x => x.status === 'suggested').length;
      if (n) badge = ` (${n})`;
    } else if (t.key === 'today') {
      const today = S.todayStr();
      const n = (INBOX.inbox?.tasks || []).filter(x =>
        x.status === 'active' && x.planned_for === today).length;
      if (n) badge = ` (${n})`;
    } else if (t.key === 'active') {
      const n = (INBOX.inbox?.tasks || []).filter(x =>
        ['active', 'accepted'].includes(x.status)).length;
      if (n) badge = ` (${n})`;
    } else if (t.key === 'completed') {
      badge = ` (${(INBOX.ledger?.activities || []).length})`;
    } else if (t.key === 'upcoming') {
      badge = ` (${upcomingTasks().length})`;
    } else if (t.key === 'calendar') {
      const n = (INBOX.inbox?.tasks || []).filter(x =>
        x.source === 'calendar' && ['suggested', 'active'].includes(x.status)).length;
      if (n) badge = ` (${n})`;
    }
    btn.textContent = t.label + badge;
    btn.addEventListener('click', () => {
      INBOX.activeTab = t.key;
      history.replaceState(null, '', '#' + t.key);
      INBOX.selected = new Map();
      render();
    });
    bar.appendChild(btn);
  }
  return bar;
}

function renderCatToggles() {
  const host = document.createElement('div');
  host.style.cssText = 'display:flex;gap:6px;flex-wrap:wrap;margin-bottom:10px';
  const counts = {};
  for (const t of tasksForActiveTab()) counts[t.category] = (counts[t.category] || 0) + 1;
  // Always render all seven canonical category chips so the user can re-enable
  // a filter even when the current tab has no matching tasks. Empty counts
  // render at reduced opacity to cue that nothing is in that bucket right now.
  for (const c of S.CAT_ORDER) {
    const chip = document.createElement('span');
    const off = !INBOX.filterCats.has(c);
    const empty = !counts[c];
    chip.className = 'yr-cat-toggle' + (off ? ' off' : '');
    chip.style.background = S.CAT_COLOR[c] + '20';
    chip.style.color = S.CAT_COLOR[c];
    if (empty && !off) chip.style.opacity = '0.6';
    chip.textContent = `${c} ${counts[c] || 0}`;
    chip.addEventListener('click', () => {
      if (INBOX.filterCats.has(c)) INBOX.filterCats.delete(c);
      else INBOX.filterCats.add(c);
      saveTaskFilterCats(INBOX.filterCats);
      render();
    });
    host.appendChild(chip);
  }
  for (const [label, fn] of [
    ['all',  () => { INBOX.filterCats = new Set(S.CAT_ORDER); }],
    ['none', () => { INBOX.filterCats = new Set(); }],
  ]) {
    const b = document.createElement('span');
    b.className = 'yr-cat-toggle';
    b.style.background = '#fff';
    b.style.border = '1px solid #e5e7eb';
    b.style.color = '#374151';
    b.textContent = label;
    b.addEventListener('click', () => { fn(); saveTaskFilterCats(INBOX.filterCats); render(); });
    host.appendChild(b);
  }

  // Spacer + needs-hours toggle. Persists in localStorage so the filter sticks
  // across sessions. Only meaningful for post-review tabs; harmless elsewhere.
  const spacer = document.createElement('span');
  spacer.style.cssText = 'flex:1';
  host.appendChild(spacer);
  const needsHours = document.createElement('label');
  needsHours.style.cssText = 'display:inline-flex;align-items:center;gap:6px;font-size:12px;color:#374151;user-select:none;cursor:pointer';
  needsHours.innerHTML = `<input type="checkbox"${INBOX.needsHoursOnly ? ' checked' : ''}> needs hours estimate`;
  needsHours.querySelector('input').addEventListener('change', (ev) => {
    INBOX.needsHoursOnly = ev.target.checked;
    saveNeedsHoursFilter(INBOX.needsHoursOnly);
    render();
  });
  host.appendChild(needsHours);

  return host;
}

function renderSummary() {
  const rows = tasksForActiveTab();
  const total = rows.length;
  const withDue = rows.filter(r => r.due_date && r.due_date !== 'TBD').length;
  const overdue = rows.filter(r => r.due_date && r.due_date !== 'TBD' && r.due_date < S.todayStr()).length;
  const wrap = document.createElement('div');
  wrap.className = 'inbox-summary';
  wrap.innerHTML = `
    <div style="display:grid;grid-template-columns:repeat(auto-fit,minmax(130px,1fr));gap:10px;font-size:13px">
      <div><strong style="font-size:22px">${total}</strong><br><span style="color:#6b7280">in this view</span></div>
      <div><strong style="font-size:22px">${withDue}</strong><br><span style="color:#6b7280">with due date</span></div>
      <div><strong style="font-size:22px;color:${overdue ? '#dc2626' : '#111827'}">${overdue}</strong><br><span style="color:#6b7280">overdue</span></div>
    </div>`;
  return wrap;
}

/* ---------- list rendering ---------- */

function tasksForActiveTab() {
  const tab = INBOX.activeTab;
  let rows = [];
  if (tab === 'completed') {
    // From ledger, not inbox
    rows = (INBOX.ledger?.activities || []).map(a => ({
      id: a.id,
      from_task_id: a.from_task_id,
      title: a.title,
      description: a.description,
      category: a.category,
      sub_category: a.sub_category,
      due_date: (a.completed_at || '').slice(0, 10),
      priority: 'normal',
      status: 'completed',
      source: 'ledger',
      hours_estimate: a.hours,
      evidence: a.evidence,
      notes: a.notes,
      _is_ledger: true,
    }));
  } else if (tab === 'upcoming') {
    rows = upcomingTasks();
  } else if (tab === 'today') {
    const today = S.todayStr();
    rows = (INBOX.inbox?.tasks || []).filter(t =>
      t.status === 'active' && (t.planned_for === today));
  } else {
    const tabDef = TABS.find(t => t.key === tab);
    const statuses = tabDef?.statuses || [];
    rows = (INBOX.inbox?.tasks || []).filter(t => statuses.includes(t.status));
    if (tabDef?.source) rows = rows.filter(t => t.source === tabDef.source);
  }
  rows = rows.filter(r => INBOX.filterCats.has(r.category || 'unknown'));
  if (INBOX.needsHoursOnly) {
    rows = rows.filter(r => !r.hours_estimate || r.hours_estimate <= 0);
  }
  rows.sort(sortByPriorityThenDate);
  return rows;
}

function upcomingTasks() {
  const today = S.todayStr();
  const cutoff = new Date();
  cutoff.setDate(cutoff.getDate() + 30);
  const cutoffStr = cutoff.toISOString().slice(0, 10);
  return (INBOX.inbox?.tasks || []).filter(t =>
    !['completed', 'rejected'].includes(t.status) &&
    t.due_date && t.due_date !== 'TBD' &&
    t.due_date >= today && t.due_date <= cutoffStr
  );
}

const PRIORITY_RANK = { urgent: 0, high: 1, normal: 2, low: 3 };

function sortByPriorityThenDate(a, b) {
  const pa = PRIORITY_RANK[a.priority] ?? 2;
  const pb = PRIORITY_RANK[b.priority] ?? 2;
  if (pa !== pb) return pa - pb;
  const da = a.due_date === 'TBD' ? '9999-12-31' : (a.due_date || '9999-12-31');
  const db = b.due_date === 'TBD' ? '9999-12-31' : (b.due_date || '9999-12-31');
  return da.localeCompare(db);
}

function renderList() {
  const host = document.createElement('div');
  host.id = 'inbox-list';
  const rows = tasksForActiveTab();
  if (!rows.length) {
    host.innerHTML = '<div style="padding:20px;color:#6b7280">No tasks in this view.</div>';
    return host;
  }
  const card = document.createElement('div');
  card.className = 'card';
  for (const t of rows) card.appendChild(renderRow(t));
  host.appendChild(card);
  return host;
}

function renderRow(task) {
  const wrap = document.createElement('div');
  wrap.style.borderLeft = `4px solid ${S.CAT_COLOR[task.category] || '#9ca3af'}`;
  const expanded = INBOX.expanded.has(task.id);
  const caret = expanded ? '\u25BE' : '\u25B8';

  const line = document.createElement('div');
  line.className = 'yr-line';
  // Suggested rows fit [hrs][Accept][Complete][Reject] in col-actions; other
  // row types only need one or two buttons. Width tuned for the widest case.
  line.style.gridTemplateColumns = '28px 16px 110px 1fr 130px 80px 340px';
  // Disposition glyph pulled from the linked email(s). Most-severe wins so a
  // single actionable email doesn't get masked by FYIs in the same bundle.
  const dispVal = (window.DISPOSITION && INBOX.dispositionMap)
    ? window.DISPOSITION.bestForEmails(task.evidence?.email_ids || [], INBOX.dispositionMap)
    : null;
  const dispGlyph = dispVal ? window.DISPOSITION.glyph(dispVal, { size: 12 }) : '';
  line.innerHTML = `
    <div class="col-select"><input type="checkbox"></div>
    <div class="col-caret">${caret}</div>
    <div class="col-date">${renderDateCol(task)}</div>
    <div class="col-main">
      <div class="title">${dispGlyph}${S.escapeHtml(task.title || '(untitled)')}</div>
      <div class="sub">${S.escapeHtml(task.sub_category || '')} ${statusChip(task.status)}</div>
    </div>
    <div class="col-meta">${evidenceMeta(task)}</div>
    <div class="col-stars"></div>
    <div class="col-actions"></div>
  `;
  // Derived priority (from due_date + hours + hours logged) + confidence.
  const stars = line.querySelector('.col-stars');
  stars.innerHTML = TASK_EDITOR.priorityChipHtml(task, hoursLoggedForTask);
  if (task.self_importance) {
    const imp = document.createElement('span');
    imp.style.cssText = 'font-size:10px;color:#f59e0b;margin-left:4px';
    imp.textContent = '\u2605'.repeat(task.self_importance);
    imp.title = `self-importance ${task.self_importance}/5`;
    stars.appendChild(imp);
  }
  if (typeof task.confidence === 'number' && task.confidence > 0 && task.status === 'suggested') {
    const conf = document.createElement('span');
    conf.style.cssText = 'font-size:10px;color:#9ca3af;margin-left:4px';
    conf.textContent = task.confidence.toFixed(2);
    stars.appendChild(conf);
  }

  const cb = line.querySelector('.col-select input');
  cb.checked = INBOX.selected.has(task.id);
  cb.addEventListener('click', (ev) => ev.stopPropagation());
  cb.addEventListener('change', () => {
    if (cb.checked) INBOX.selected.set(task.id, task);
    else INBOX.selected.delete(task.id);
    updateActionBar();
  });

  const actions = line.querySelector('.col-actions');
  actions.appendChild(rowActions(task));
  line.addEventListener('click', (ev) => {
    if (ev.target.closest('.col-select') || ev.target.closest('.col-actions') ||
        ev.target.closest('.col-stars')) return;
    if (INBOX.expanded.has(task.id)) INBOX.expanded.delete(task.id);
    else INBOX.expanded.add(task.id);
    render();
  });
  wrap.appendChild(line);

  if (expanded) wrap.appendChild(renderDetail(task));
  return wrap;
}

function renderDateCol(task) {
  const d = task.due_date;
  if (!d || d === 'TBD') return '<span style="color:#9ca3af">TBD</span>';
  return `${S.escapeHtml(d)} ${deadlineChip(d)}`;
}

function statusChip(s) {
  return `<span class="status-chip status-${s || 'suggested'}">${s || 'suggested'}</span>`;
}

function evidenceMeta(task) {
  const ev = task.evidence || {};
  const m = (ev.email_ids || []).length;
  const e = (ev.event_ids || []).length;
  const i = (ev.item_ids || []).length;
  const parts = [];
  if (m) parts.push(`${m}m`);
  if (e) parts.push(`${e}e`);
  if (i) parts.push(`${i}i`);
  if (task.hours_estimate) parts.push(`${task.hours_estimate}h`);
  return parts.join(' \u00b7 ') || '\u2014';
}

function rowActions(task) {
  const host = document.createElement('span');
  host.style.cssText = 'display:flex;gap:6px;align-items:center;white-space:nowrap';

  const iconBtn = (icon, title, color, fn) => {
    const s = document.createElement('span');
    s.textContent = icon;
    s.title = title;
    s.style.cssText = `color:${color};cursor:pointer;font-size:14px;padding:2px 4px`;
    s.addEventListener('click', async (ev) => { ev.stopPropagation(); await fn(); });
    return s;
  };

  if (task.status === 'suggested') {
    // Inline hours input → remembered and used by Accept (or next Complete)
    const hrs = document.createElement('input');
    hrs.type = 'number';
    hrs.step = '0.25';
    hrs.min = '0';
    hrs.placeholder = 'hrs';
    hrs.value = task.hours_estimate ?? '';
    hrs.style.cssText = 'width:56px;font-size:12px;padding:3px 5px;border:1px solid #d1d5db;border-radius:4px';
    hrs.addEventListener('click', (e) => e.stopPropagation());
    hrs.title = 'Hours; leave blank = <15 min';
    hrs.addEventListener('change', async (e) => {
      e.stopPropagation();
      const raw = hrs.value.trim();
      // Blank means "<15 min" = 0.25 hr; explicit 0 stays 0 if you insist.
      const v = raw === '' ? null : parseFloat(raw);
      task.hours_estimate = (v === null || isNaN(v)) ? null : v;
      task.user_edited = true;
      await saveInbox();
    });
    host.appendChild(hrs);

    const softBtn = (text, bg, fg, border, fn) => {
      const b = document.createElement('button');
      b.textContent = text;
      b.className = 'btn';
      b.style.cssText = `padding:5px 14px;font-size:13px;font-weight:600;background:${bg};color:${fg};border:1px solid ${border};border-radius:6px;cursor:pointer`;
      b.addEventListener('click', async (e) => { e.stopPropagation(); await fn(); });
      return b;
    };
    host.appendChild(softBtn('\u2713 Accept', '#dcfce7', '#166534', '#bbf7d0', () => acceptTask(task)));
    // Complete short-circuit: skip the planning step entirely. Useful for items
    // already done by the time the user triages them. Uses the inline hrs
    // input (or prompts via completeTask) and logs the usual ledger entry.
    host.appendChild(softBtn('\u2705 Complete', '#dbeafe', '#1e40af', '#bfdbfe', () => completeTask(task)));
    host.appendChild(softBtn('\u2716 Reject', '#fee2e2', '#991b1b', '#fecaca', () => rejectTask(task)));
  } else if (['active', 'accepted', 'snoozed'].includes(task.status)) {
    const complete = document.createElement('button');
    complete.textContent = '\u2705 Complete';
    complete.className = 'btn';
    complete.style.cssText = 'padding:5px 14px;font-size:13px;font-weight:600;background:#dcfce7;color:#166534;border:1px solid #bbf7d0;border-radius:6px;cursor:pointer';
    complete.addEventListener('click', async (e) => { e.stopPropagation(); await completeTask(task); });
    host.appendChild(complete);
    host.appendChild(iconBtn('\ud83d\udca4', 'Snooze', '#64748b', () => snoozeTask(task)));
  } else if (task.status === 'completed' || task._is_ledger) {
    const undo = document.createElement('button');
    undo.textContent = '\u21ba Uncomplete';
    undo.className = 'btn';
    undo.style.cssText = 'padding:5px 14px;font-size:12px;background:#fef3c7;color:#92400e;border:1px solid #fde68a;border-radius:6px;cursor:pointer';
    undo.title = 'Move back to Active and remove the ledger record';
    undo.addEventListener('click', async (e) => { e.stopPropagation(); await uncompleteTask(task); });
    host.appendChild(undo);
  }
  if (INBOX.firebridgeReady && task.status !== 'completed' && !task.tracker_entry_id) {
    host.appendChild(iconBtn('\u2795', 'Log to daily tracker', '#2563eb', () => openDailyTrackerDialog(task)));
  }
  if (!task._is_ledger && task.status !== 'completed' && task.status !== 'rejected') {
    const cat = task.category || '';
    const sub = task.sub_category || '';
    const isPinned = INBOX._pinnedBucketKeys && INBOX._pinnedBucketKeys.has(`${cat}\u00A7${sub}`);
    host.appendChild(iconBtn(
      isPinned ? '\ud83d\udccc' : '\ud83d\udccd',
      isPinned
        ? `Unpin bucket: ${cat}${sub ? ' / ' + sub : ''}`
        : `Pin bucket to dashboard: ${cat}${sub ? ' / ' + sub : ''}`,
      isPinned ? '#dc2626' : '#6b7280',
      async () => {
        try {
          const doc = await api.load('tasks/pinned_buckets.json').catch(() => ({ buckets: [] }));
          doc.buckets = doc.buckets || [];
          const existing = doc.buckets.findIndex(b =>
            (b.category || '') === cat && (b.sub_category || '') === sub);
          if (existing >= 0) doc.buckets.splice(existing, 1);
          else doc.buckets.push({ category: cat, sub_category: sub });
          doc.updated_at = new Date().toISOString();
          await api.save('tasks/pinned_buckets.json', doc);
          INBOX._pinnedBucketKeys = new Set(doc.buckets.map(b =>
            `${b.category || ''}\u00A7${b.sub_category || ''}`));
        } catch (e) { alert('pin failed: ' + e.message); return; }
        render();
      },
    ));
  }
  return host;
}

async function uncompleteTask(task) {
  // Resolve the target inbox task id. For ledger-only rows (Completed tab),
  // task.id IS the ledger activity id; the real inbox task lives under
  // task.from_task_id (attached from the ledger record).
  const targetId = task._is_ledger ? (task.from_task_id || null) : task.id;
  if (!confirm(`Move "${task.title}" back to Active? Its ledger record will be removed.`)) return;
  try {
    const res = await fetch('/api/uncomplete-task', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        task_id: targetId,
        activity_id: task._is_ledger ? task.id : null,
      }),
    });
    const j = await res.json();
    if (!j.ok) return alert('uncomplete failed: ' + (j.error || ''));
  } catch (e) { return alert('uncomplete failed: ' + e.message); }
  await loadInbox();
  await loadLedger();
  render();
}

/* ---------- detail pane ---------- */

function renderDetail(task) {
  const d = document.createElement('div');
  d.className = 'yr-detail';

  // Description + Planning + Pacing + Action items come from the shared
  // task-editor module so this page and email-review stay in sync.
  d.appendChild(TASK_EDITOR.render(task, {
    save: saveInbox,
    hoursLogged: hoursLoggedForTask,
    onTaskChange: () => render(),
    onReschedule: async () => {
      await saveInbox();
      render();
    },
  }));

  // Evidence
  const evWrap = document.createElement('div');
  evWrap.className = 'section';
  evWrap.innerHTML = `<div class="label">Evidence</div>`;
  const evList = document.createElement('div');
  evList.style.cssText = 'display:flex;flex-wrap:wrap;gap:4px';
  (task.evidence?.email_ids || []).forEach(id => {
    const chip = evidenceChip(`\u2709 ${id.slice(0, 8)}`, '#fef3c7', '#92400e');
    chip.addEventListener('click', () => openEmailModal(id));
    evList.appendChild(chip);
  });
  (task.evidence?.event_ids || []).forEach(id => {
    const chip = evidenceChip(`\ud83d\uddd3 ${id.slice(0, 8)}`, '#dbeafe', '#1e40af');
    chip.addEventListener('click', () => openEventModal(id));
    evList.appendChild(chip);
  });
  (task.evidence?.item_ids || []).forEach(id => {
    const it = INBOX.itemIndex?.[id];
    const label = it ? (it.title || id) : id;
    const chip = evidenceChip(`\ud83d\udd17 ${label}`, '#dcfce7', '#166534');
    evList.appendChild(chip);
  });
  (task.evidence?.file_paths || []).forEach(p => {
    const chip = evidenceChip(`\ud83d\udcc4 ${p.split('/').pop()}`, '#e5e7eb', '#374151');
    chip.title = p;
    chip.addEventListener('click', () => window.open(`/${p.replace(/^\.\.\//, '')}`, '_blank'));
    evList.appendChild(chip);
  });
  if (!evList.children.length) {
    evList.innerHTML = '<span style="color:#9ca3af;font-size:11px">no linked evidence</span>';
  }
  evWrap.appendChild(evList);
  if (!task._is_ledger) evWrap.appendChild(renderFileAttachControls(task));
  d.appendChild(evWrap);

  // Cascading sub-category picker (autosave on each change + tree browser)
  if (!task._is_ledger) {
    const picker = document.createElement('div');
    picker.className = 'section';
    picker.innerHTML = `<div class="label">Category / sub-category <span style="color:#9ca3af;text-transform:none;font-weight:400">\u2014 saves as you pick</span></div>`;
    // Forward-declare redrawTree / onChange so the picker can capture them.
    // Then reassign redrawTree to its real impl once `editor` is mounted.
    let redrawTree = () => {};
    let lastSaved = JSON.stringify({ cat: task.category, sub: task.sub_category });
    const pickerOnChange = async ({ category, sub_category }) => {
      redrawTree();
      const sig = JSON.stringify({ cat: category, sub: sub_category });
      if (sig === lastSaved) return;
      const before = { category: task.category, sub_category: task.sub_category };
      task.category = category;
      task.sub_category = sub_category;
      task.user_edited = true;
      await saveInbox();
      await logDecision(task, 'recategorized', before, { category, sub_category });
      lastSaved = sig;
      const rowEl = d.parentElement?.querySelector('.yr-line .col-main .sub');
      if (rowEl) rowEl.textContent = `${sub_category || ''} `;
    };
    const editor = S.renderPicker({
      ctx: { category: task.category, sub_category: task.sub_category },
      tree: INBOX.tree,
      mode: 'full',
      mruKey: 'task',
      onChange: pickerOnChange,
    });
    picker.appendChild(editor);

    // Tree browser host — refreshed in place whenever the picker changes
    // so it narrows to paths matching what's been picked so far.
    const tree = document.createElement('div');
    tree.style.cssText = 'margin-top:8px;padding:8px;background:#fff;border:1px solid #e5e7eb;border-radius:6px;max-height:240px;overflow:auto;font-size:11px';
    picker.appendChild(tree);

    redrawTree = () => {
      const { category: pickerCat, sub_category: pickerSub } = S.getPickerResult(editor);
      const segs = (pickerSub || '').split(':').filter(Boolean);
      const prefix = segs.join(':');
      tree.innerHTML = `<div class="label" style="margin-bottom:4px">All existing sub-categories (click to use)
        ${pickerCat || prefix ? `<span style="color:#9ca3af;text-transform:none;font-weight:400;margin-left:6px">filtered by ${[pickerCat, prefix].filter(Boolean).join(' / ')}</span>` : ''}
      </div>`;
      const grouped = flatTreePaths(INBOX.tree);
      const listByCat = {};
      for (const [cat, p] of grouped) {
        if (pickerCat && cat !== pickerCat) continue;
        if (prefix) {
          if (p !== prefix && !p.startsWith(prefix + ':')) continue;
        }
        (listByCat[cat] = listByCat[cat] || []).push(p);
      }
      if (!Object.keys(listByCat).length) {
        const n = document.createElement('div');
        n.style.color = '#9ca3af';
        n.textContent = '(no matching sub-categories — type a new path in the picker above)';
        tree.appendChild(n);
        return;
      }
      for (const cat of Object.keys(listByCat).sort()) {
        const head = document.createElement('div');
        head.style.cssText = `margin-top:6px;font-weight:600;color:${S.CAT_COLOR[cat] || '#374151'};text-transform:uppercase;letter-spacing:.5px;font-size:10px`;
        head.textContent = cat;
        tree.appendChild(head);
        for (const p of listByCat[cat].sort()) {
          const chip = document.createElement('span');
          const active = task.category === cat && task.sub_category === p;
          chip.textContent = p;
          chip.style.cssText = `display:inline-block;margin:2px 4px 2px 0;padding:2px 8px;border-radius:10px;cursor:pointer;background:${active ? S.CAT_COLOR[cat] : '#f3f4f6'};color:${active ? '#fff' : '#374151'};border:1px solid ${active ? S.CAT_COLOR[cat] : '#e5e7eb'}`;
          chip.addEventListener('click', async (ev) => {
            ev.stopPropagation();
            const before = { category: task.category, sub_category: task.sub_category };
            task.category = cat;
            task.sub_category = p;
            task.user_edited = true;
            await saveInbox();
            await logDecision(task, 'recategorized', before, { category: cat, sub_category: p });
            render();
          });
          tree.appendChild(chip);
        }
      }
    };
    redrawTree();

    // Keep the tree-browser in sync with cross-picker commits on this page
    // (e.g. picker on a different open row adds a new path) without a refresh.
    const onPathCommit = () => redrawTree();
    window.addEventListener('catpicker:commit', onPathCommit);
    const observer = new MutationObserver(() => {
      if (!picker.isConnected) {
        window.removeEventListener('catpicker:commit', onPathCommit);
        observer.disconnect();
      }
    });
    observer.observe(d.parentNode || document.body, { childList: true, subtree: true });

    d.appendChild(picker);
  }

  // Notes
  if (!task._is_ledger) {
    const notesWrap = document.createElement('div');
    notesWrap.className = 'section';
    notesWrap.innerHTML = `<div class="label">Notes</div>`;
    const ta = document.createElement('textarea');
    ta.value = task.notes || '';
    ta.style.cssText = 'width:100%;min-height:60px;font-size:12px;border:1px solid #d1d5db;border-radius:4px;padding:6px 8px';
    let dbc;
    ta.addEventListener('input', () => {
      clearTimeout(dbc);
      dbc = setTimeout(async () => {
        task.notes = ta.value;
        task.user_edited = true;
        await saveInbox();
      }, 400);
    });
    notesWrap.appendChild(ta);
    d.appendChild(notesWrap);
  }

  return d;
}

function renderFileAttachControls(task) {
  const wrap = document.createElement('div');
  wrap.style.cssText = 'display:flex;gap:8px;margin-top:6px;align-items:center;flex-wrap:wrap';
  const link = document.createElement('button');
  link.className = 'btn';
  link.textContent = '\ud83d\udcce Link repo file';
  link.style.cssText = 'font-size:11px;padding:3px 8px';
  link.addEventListener('click', async () => {
    const p = prompt('Repo-relative path (e.g. ../McGheeLabWebsite/courses/bme295c/syllabus.pdf):');
    if (!p || !p.trim()) return;
    const ev = task.evidence = task.evidence || {};
    ev.file_paths = ev.file_paths || [];
    if (!ev.file_paths.includes(p.trim())) ev.file_paths.push(p.trim());
    await saveInbox();
    render();
  });
  wrap.appendChild(link);
  // Upload button is Phase 3 — server needs a multipart endpoint first.
  return wrap;
}

function flatTreePaths(tree) {
  const out = [];
  for (const cat of Object.keys(tree || {})) {
    const walk = (node, prefix) => {
      const keys = Object.keys(node || {});
      if (!keys.length) {
        if (prefix) out.push([cat, prefix]);
        return;
      }
      for (const k of keys) {
        const p = prefix ? `${prefix}:${k}` : k;
        const child = node[k];
        if (child && Object.keys(child).length) walk(child, p);
        else out.push([cat, p]);
      }
    };
    walk(tree[cat], '');
  }
  return out;
}

function evidenceChip(text, bg, fg) {
  const c = document.createElement('span');
  c.textContent = text;
  c.style.cssText = `display:inline-block;padding:2px 8px;border-radius:10px;font-size:11px;background:${bg};color:${fg};cursor:pointer`;
  return c;
}

function deadlineChip(d) {
  if (!d || d === 'TBD') return '';
  const today = S.todayStr();
  if (d < today) return '<span class="priority-chip priority-urgent" style="margin-left:4px">overdue</span>';
  const ms = new Date(d) - new Date(today);
  const days = Math.floor(ms / 86400000);
  if (days <= 7) return `<span class="priority-chip priority-high" style="margin-left:4px">${days}d</span>`;
  if (days <= 30) return `<span class="priority-chip priority-normal" style="margin-left:4px">${days}d</span>`;
  return '';
}

/* ---------- evidence detail modals ---------- */

async function openEmailModal(emailId) {
  if (INBOX.detailCache[emailId]) return showEmailModal(INBOX.detailCache[emailId]);
  // Find the email's path by scanning by_year files
  try {
    const idx = await api.load('email_archive/summary.json');
    for (const y of (idx.summary?.years || [])) {
      const doc = await api.load(`email_archive/by_year/${y}.json`);
      const hit = (doc.emails || []).find(e => e.id === emailId);
      if (hit) { INBOX.emailPathById[emailId] = hit.path; break; }
    }
  } catch {}
  const path = INBOX.emailPathById[emailId];
  if (!path) return alert('email path not found');
  try {
    const res = await fetch(`/api/email?path=${encodeURIComponent(path)}`);
    const j = await res.json();
    INBOX.detailCache[emailId] = j;
    showEmailModal(j);
  } catch (e) { alert('failed to load email: ' + e.message); }
}

function showEmailModal(detail) {
  const back = document.createElement('div');
  back.style.cssText = 'position:fixed;inset:0;background:rgba(0,0,0,.4);z-index:90;display:flex;align-items:center;justify-content:center';
  const panel = document.createElement('div');
  panel.style.cssText = 'background:#fff;border-radius:10px;min-width:600px;max-width:840px;max-height:82vh;overflow:auto;padding:18px 22px';
  const body = detail.body_text || '';
  panel.innerHTML = `
    <div style="font-size:15px;font-weight:600;margin-bottom:6px">${S.escapeHtml(detail.subject || '(no subject)')}</div>
    <div style="font-size:12px;color:#6b7280;margin-bottom:10px">${S.escapeHtml(detail.from || '')} \u00b7 ${S.escapeHtml(detail.date || '')}</div>
    <pre style="white-space:pre-wrap;background:#fafafa;border:1px solid #e5e7eb;border-radius:6px;padding:10px;font-family:ui-monospace,SFMono-Regular,Menlo,Monaco,monospace;font-size:12px;max-height:60vh;overflow:auto">${S.escapeHtml(body)}</pre>
    <div style="margin-top:10px">${(detail.attachments || []).map(a => `<a href="${a.url}" target="_blank" style="display:inline-block;margin-right:10px;font-size:12px">${S.escapeHtml(a.filename)} (${S.fmtBytes(a.size_bytes)})</a>`).join('')}</div>
    <div style="text-align:right;margin-top:10px"><button class="btn" id="ed-close">Close</button></div>
  `;
  back.appendChild(panel);
  document.body.appendChild(back);
  panel.querySelector('#ed-close').addEventListener('click', () => document.body.removeChild(back));
  safeCloseOnBackdrop(back, panel, () => { if (back.parentNode) document.body.removeChild(back); });
}

async function openEventModal(eventId) {
  if (!INBOX.eventsById) await loadEventsById();
  const ev = INBOX.eventsById[eventId];
  if (!ev) return alert('event not found');
  const back = document.createElement('div');
  back.style.cssText = 'position:fixed;inset:0;background:rgba(0,0,0,.4);z-index:90;display:flex;align-items:center;justify-content:center';
  const panel = document.createElement('div');
  panel.style.cssText = 'background:#fff;border-radius:10px;min-width:520px;max-width:720px;padding:18px 22px';
  panel.innerHTML = `
    <div style="font-size:15px;font-weight:600">${S.escapeHtml(ev.title || '(untitled)')}</div>
    <div style="font-size:12px;color:#6b7280;margin-bottom:8px">${S.escapeHtml(ev.start || '')} \u2192 ${S.escapeHtml(ev.end || '')} \u00b7 ${S.escapeHtml(ev.location || '')}</div>
    <pre style="white-space:pre-wrap;background:#fafafa;border:1px solid #e5e7eb;border-radius:6px;padding:10px;font-family:ui-monospace,SFMono-Regular,Menlo,Monaco,monospace;font-size:12px;max-height:40vh;overflow:auto">${S.escapeHtml(ev.description || '')}</pre>
    <div style="margin-top:10px;font-size:12px;color:#6b7280">Attendees: ${(ev.attendees || []).length}</div>
    <div style="text-align:right;margin-top:10px"><button class="btn" id="ev-close">Close</button></div>
  `;
  back.appendChild(panel);
  document.body.appendChild(back);
  panel.querySelector('#ev-close').addEventListener('click', () => document.body.removeChild(back));
  safeCloseOnBackdrop(back, panel, () => { if (back.parentNode) document.body.removeChild(back); });
}

async function loadEventsById() {
  INBOX.eventsById = {};
  // calendar_archive is still lab-global single-tenant data. Skip the load
  // for non-admin users so other lab members don't see Alex's events.
  // Phase 7 moves the calendar archive per-user.
  if (typeof firebridge !== 'undefined' && !firebridge.isAdmin()) return;
  try {
    const res = await fetch('/data/calendar_archive/events_v2.jsonl');
    if (!res.ok) return;
    const txt = await res.text();
    for (const line of txt.split('\n')) {
      if (!line.trim()) continue;
      try {
        const e = JSON.parse(line);
        INBOX.eventsById[e.id] = e;
      } catch {}
    }
  } catch {}
}

/* ---------- per-row actions ---------- */

async function acceptTask(task) {
  const before = { status: task.status };
  task.status = 'active';
  task.decided_at = new Date().toISOString();
  await saveInbox();
  await logDecision(task, 'accepted', before, { status: 'active' });
  render();
}

async function rejectTask(task) {
  if (!confirm(`Reject "${task.title}"? It'll stay in the inbox under rejected status.`)) return;
  const before = { status: task.status };
  task.status = 'rejected';
  task.decided_at = new Date().toISOString();
  await saveInbox();
  await logDecision(task, 'rejected', before, { status: 'rejected' });
  render();
}

async function snoozeTask(task) {
  const d = prompt('Snooze until (YYYY-MM-DD):', '');
  if (!d) return;
  task.status = 'snoozed';
  task.snoozed_until = d;
  await saveInbox();
  await logDecision(task, 'snoozed', {}, { snoozed_until: d });
  render();
}

async function completeTask(task) {
  let hours = task.hours_estimate;
  if (hours == null) {
    const raw = prompt(`Hours spent on "${task.title}" (blank = <15 min):`, '');
    if (raw === null) return;
    const v = parseFloat(raw);
    // Blank or unparseable → treat as <15 min (0.25 hr nominal)
    hours = isNaN(v) ? 0.25 : v;
  }
  try {
    const res = await fetch('/api/complete-task', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ task_id: task.id, hours_estimate: hours }),
    });
    const j = await res.json();
    if (!j.ok) return alert('complete failed: ' + (j.error || ''));
  } catch (e) { return alert('complete failed: ' + e.message); }
  await loadInbox();
  await loadLedger();
  render();
}

/* ---------- bulk action bar ---------- */

function renderActionBar() {
  let bar = document.getElementById('inbox-actionbar');
  if (!bar) {
    bar = document.createElement('div');
    bar.id = 'inbox-actionbar';
    bar.className = 'yr-actionbar';
    bar.innerHTML = `
      <span id="inbox-sel-count">0 selected</span>
      <button class="primary" id="inbox-sel-accept">Accept</button>
      <button class="primary" id="inbox-sel-recat">Recategorize\u2026</button>
      <button id="inbox-sel-snooze">Snooze\u2026</button>
      <button class="primary" id="inbox-sel-complete">Complete\u2026</button>
      <button class="danger" id="inbox-sel-reject">Reject</button>
      <button id="inbox-sel-clear">Clear</button>
    `;
    document.body.appendChild(bar);
    bar.querySelector('#inbox-sel-clear').addEventListener('click', () => { INBOX.selected.clear(); updateActionBar(); render(); });
    bar.querySelector('#inbox-sel-accept').addEventListener('click', bulkAccept);
    bar.querySelector('#inbox-sel-reject').addEventListener('click', bulkReject);
    bar.querySelector('#inbox-sel-snooze').addEventListener('click', bulkSnooze);
    bar.querySelector('#inbox-sel-complete').addEventListener('click', bulkComplete);
    bar.querySelector('#inbox-sel-recat').addEventListener('click', bulkRecategorize);
  }
  return bar;
}

function updateActionBar() {
  const bar = document.getElementById('inbox-actionbar');
  if (!bar) return;
  document.getElementById('inbox-sel-count').textContent = `${INBOX.selected.size} selected`;
  if (INBOX.selected.size > 0) bar.classList.add('open');
  else bar.classList.remove('open');
}

async function bulkAccept() {
  const tasks = Array.from(INBOX.selected.values()).filter(t => t.status === 'suggested');
  for (const t of tasks) { t.status = 'active'; t.decided_at = new Date().toISOString(); }
  await saveInbox();
  for (const t of tasks) await logDecision(t, 'accepted', { status: 'suggested' }, { status: 'active' });
  INBOX.selected.clear();
  render();
}
async function bulkReject() {
  if (!INBOX.selected.size || !confirm(`Reject ${INBOX.selected.size} tasks?`)) return;
  for (const t of INBOX.selected.values()) {
    t.status = 'rejected'; t.decided_at = new Date().toISOString();
    await logDecision(t, 'rejected', {}, { status: 'rejected' });
  }
  await saveInbox();
  INBOX.selected.clear();
  render();
}
async function bulkSnooze() {
  if (!INBOX.selected.size) return;
  const d = prompt('Snooze selected until (YYYY-MM-DD):', '');
  if (!d) return;
  for (const t of INBOX.selected.values()) {
    t.status = 'snoozed'; t.snoozed_until = d;
    await logDecision(t, 'snoozed', {}, { snoozed_until: d });
  }
  await saveInbox();
  INBOX.selected.clear();
  render();
}
async function bulkComplete() {
  if (!INBOX.selected.size) return;
  const hrs = prompt(`Hours per task (applied to all ${INBOX.selected.size}, blank = <15 min):`, '');
  if (hrs === null) return;
  const parsed = parseFloat(hrs);
  const hours = isNaN(parsed) ? 0.25 : parsed;  // blank → <15 min
  for (const t of INBOX.selected.values()) {
    try {
      await fetch('/api/complete-task', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ task_id: t.id, hours_estimate: hours }),
      });
    } catch {}
  }
  await loadInbox(); await loadLedger();
  INBOX.selected.clear();
  render();
}
async function bulkRecategorize() {
  if (!INBOX.selected.size) return;
  const first = INBOX.selected.values().next().value;
  S.openBulkPicker({
    tree: INBOX.tree,
    initial: { category: first.category, sub_category: first.sub_category },
    title: `Recategorize ${INBOX.selected.size} task${INBOX.selected.size === 1 ? '' : 's'}`,
    mruKey: 'task',
    onApply: async ({ category, sub_category }) => {
      for (const t of INBOX.selected.values()) {
        const before = { category: t.category, sub_category: t.sub_category };
        t.category = category;
        t.sub_category = sub_category;
        t.user_edited = true;
        await logDecision(t, 'recategorized', before, { category, sub_category });
      }
      await saveInbox();
      INBOX.selected.clear();
      render();
    },
  });
}

/* ---------- daily tracker bridge ---------- */

async function openDailyTrackerDialog(task) {
  if (!window.firebridge || !window.firebridge.isAdmin()) {
    return alert('Sign in as admin (Settings) to log to the daily tracker.');
  }
  const back = document.createElement('div');
  back.style.cssText = 'position:fixed;inset:0;background:rgba(0,0,0,.4);z-index:95;display:flex;align-items:center;justify-content:center';
  const panel = document.createElement('div');
  panel.style.cssText = 'background:#fff;border-radius:10px;min-width:440px;padding:18px 22px';
  const pathSegs = (task.sub_category || '').split(':').filter(Boolean);
  panel.innerHTML = `
    <h3 style="margin:0 0 10px 0;font-size:15px">Log to daily tracker</h3>
    <label style="display:block;margin-bottom:8px;font-size:12px;color:#374151">Date
      <input type="date" id="dt-date" value="${S.todayStr()}" style="display:block;font-size:13px;padding:3px 6px;border:1px solid #d1d5db;border-radius:4px;margin-top:2px;width:100%">
    </label>
    <label style="display:block;margin-bottom:8px;font-size:12px;color:#374151">Entry text
      <input type="text" id="dt-text" value="${S.escapeHtml(task.title || '')}" style="display:block;font-size:13px;padding:3px 6px;border:1px solid #d1d5db;border-radius:4px;margin-top:2px;width:100%">
    </label>
    <label style="display:block;margin-bottom:8px;font-size:12px;color:#374151">Category path (colon-separated)
      <input type="text" id="dt-path" value="${S.escapeHtml(pathSegs.join(':'))}" style="display:block;font-size:13px;padding:3px 6px;border:1px solid #d1d5db;border-radius:4px;margin-top:2px;width:100%">
    </label>
    <label style="display:block;margin-bottom:8px;font-size:12px;color:#374151">Hours (optional)
      <input type="number" step="0.25" id="dt-hours" value="${task.hours_estimate || ''}" style="display:block;font-size:13px;padding:3px 6px;border:1px solid #d1d5db;border-radius:4px;margin-top:2px;width:100%">
    </label>
    <label style="display:block;margin-bottom:12px;font-size:12px;color:#374151">
      <input type="checkbox" id="dt-milestone"> Milestone
    </label>
    <div style="text-align:right">
      <button class="btn" id="dt-cancel">Cancel</button>
      <button class="btn btn-primary" id="dt-save">Log entry</button>
    </div>
  `;
  back.appendChild(panel);
  document.body.appendChild(back);
  panel.querySelector('#dt-cancel').addEventListener('click', () => document.body.removeChild(back));
  panel.querySelector('#dt-save').addEventListener('click', async () => {
    const entry = {
      date: panel.querySelector('#dt-date').value,
      text: panel.querySelector('#dt-text').value,
      categoryPath: panel.querySelector('#dt-path').value.split(':').filter(Boolean),
      duration: parseFloat(panel.querySelector('#dt-hours').value) || null,
      milestone: panel.querySelector('#dt-milestone').checked ? 1 : 0,
      source: task.source === 'calendar' ? 'calendar' : 'manual',
      createdAt: firebase.firestore.FieldValue.serverTimestamp(),
      updatedAt: firebase.firestore.FieldValue.serverTimestamp(),
    };
    try {
      const uid = firebridge.getUser().uid;
      const ref = await firebase.firestore()
        .collection('trackerEntries').doc(uid)
        .collection('entries').add(entry);
      task.tracker_entry_id = ref.id;
      task.hours_estimate = entry.duration;
      task.user_edited = true;
      await saveInbox();
      document.body.removeChild(back);
      render();
      alert('Logged to daily tracker.');
    } catch (e) {
      alert('Failed to log: ' + e.message);
    }
  });
}

/* ---------- add / refresh / keyboard ---------- */

async function onAddClick() {
  const title = prompt('Quick task title:');
  if (!title) return;
  const now = new Date().toISOString();
  const id = `tsk-${now.slice(0, 10)}-${Math.random().toString(36).slice(2, 8)}`;
  const t = {
    id, source: 'manual', status: 'active',
    title, description: '', due_date: 'TBD',
    priority: 'normal',
    category: 'admin', sub_category: '',
    evidence: { email_ids: [], event_ids: [], item_ids: [] },
    confidence: 1.0, user_edited: true,
    notes: '', hours_estimate: null, tracker_entry_id: null,
    evidence_hash: `manual-${Math.random().toString(36).slice(2, 8)}`,
    created_at: now, decided_at: now,
    snoozed_until: null, completed_at: null,
  };
  INBOX.inbox.tasks.push(t);
  await saveInbox();
  render();
}

function onKeyDown(ev) {
  if (ev.target instanceof HTMLInputElement || ev.target instanceof HTMLTextAreaElement) return;
  const rows = tasksForActiveTab();
  if (!rows.length) return;
  if (ev.key === 'a' || ev.key === 'A') {
    const t = currentTask(); if (t && t.status === 'suggested') acceptTask(t);
  } else if (ev.key === 'r' || ev.key === 'R') {
    const t = currentTask(); if (t && t.status === 'suggested') rejectTask(t);
  } else if (ev.key === 'c' || ev.key === 'C') {
    const t = currentTask(); if (t && ['active', 'snoozed'].includes(t.status)) completeTask(t);
  } else if (ev.key === 's' || ev.key === 'S') {
    const t = currentTask(); if (t) snoozeTask(t);
  }
}

function currentTask() {
  const rows = tasksForActiveTab();
  if (INBOX.expanded.size) {
    const id = Array.from(INBOX.expanded)[0];
    const t = rows.find(r => r.id === id);
    if (t) return t;
  }
  return rows[0];
}

/* ---------- activity tracker (floating timer) ----------
 *
 * Writes to data/activity_ledger.json under `entries[]`:
 *   { id, task_id, started_at, ended_at, hours, note, synced_to_firebase:false }
 *
 * In-progress state (running timer) is persisted to localStorage so a refresh
 * doesn't lose the clock.
 */

const TRACKER_LS_KEY = 'inbox.tracker.running';

let _trackerTickTimer = null;

function _ensureTrackerTick() {
  // Run the 1Hz tick only while a tracker is active. The earlier version
  // started a forever-interval at mount time even when nothing was running.
  if (_trackerTickTimer) return;
  _trackerTickTimer = setInterval(() => {
    const running = loadRunningTracker();
    if (!running) {
      clearInterval(_trackerTickTimer);
      _trackerTickTimer = null;
      return;
    }
    const el = document.getElementById('inbox-tracker-elapsed');
    if (el) el.textContent = formatElapsed(Date.now() - new Date(running.started_at).getTime());
  }, 1000);
}

function mountActivityTracker() {
  if (document.getElementById('inbox-tracker')) return;
  const host = document.createElement('div');
  host.id = 'inbox-tracker';
  host.style.cssText = 'position:fixed;right:20px;bottom:20px;z-index:90;background:#fff;border:1px solid #e5e7eb;border-radius:10px;box-shadow:0 10px 25px rgba(0,0,0,.12);padding:10px 12px;font-size:12px;min-width:260px;max-width:320px;font-family:inherit';
  document.body.appendChild(host);
  renderActivityTracker();
  if (loadRunningTracker()) _ensureTrackerTick();
}

function renderActivityTracker() {
  const host = document.getElementById('inbox-tracker');
  if (!host) return;
  host.innerHTML = '';
  const running = loadRunningTracker();
  const title = document.createElement('div');
  title.style.cssText = 'font-weight:600;font-size:11px;text-transform:uppercase;letter-spacing:.5px;color:#6b7280;margin-bottom:6px';
  title.textContent = running ? 'Tracking time' : 'Log time on a task';
  host.appendChild(title);

  if (running) {
    _ensureTrackerTick();
    const task = (INBOX.inbox?.tasks || []).find(t => t.id === running.task_id);
    const label = document.createElement('div');
    label.style.cssText = 'font-size:13px;color:#111827;margin-bottom:4px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap';
    label.textContent = task ? task.title : running.task_id;
    host.appendChild(label);
    const elapsed = document.createElement('div');
    elapsed.id = 'inbox-tracker-elapsed';
    elapsed.style.cssText = 'font-size:20px;font-variant-numeric:tabular-nums;color:#2563eb;margin-bottom:6px';
    elapsed.textContent = formatElapsed(Date.now() - new Date(running.started_at).getTime());
    host.appendChild(elapsed);
    const note = document.createElement('input');
    note.type = 'text'; note.placeholder = 'note (optional)';
    note.value = running.note || '';
    note.style.cssText = 'width:100%;font-size:12px;padding:4px 6px;border:1px solid #d1d5db;border-radius:4px;margin-bottom:6px';
    note.addEventListener('input', () => {
      running.note = note.value;
      localStorage.setItem(TRACKER_LS_KEY, JSON.stringify(running));
    });
    host.appendChild(note);
    const row = document.createElement('div');
    row.style.cssText = 'display:flex;gap:6px';
    const stopBtn = document.createElement('button');
    stopBtn.className = 'btn btn-primary';
    stopBtn.style.cssText = 'flex:1;font-size:12px;padding:5px';
    stopBtn.textContent = '\u25A0 Stop & log';
    stopBtn.addEventListener('click', () => stopTrackerAndLog());
    const cancelBtn = document.createElement('button');
    cancelBtn.className = 'btn';
    cancelBtn.style.cssText = 'font-size:12px;padding:5px';
    cancelBtn.textContent = 'Discard';
    cancelBtn.addEventListener('click', () => {
      if (!confirm('Discard this timer without logging?')) return;
      localStorage.removeItem(TRACKER_LS_KEY);
      renderActivityTracker();
    });
    row.appendChild(stopBtn);
    row.appendChild(cancelBtn);
    host.appendChild(row);
    return;
  }

  // Idle state — pick a task and start.
  const active = (INBOX.inbox?.tasks || []).filter(t => ['active', 'accepted', 'suggested'].includes(t.status));
  if (!active.length) {
    const empty = document.createElement('div');
    empty.style.cssText = 'color:#9ca3af';
    empty.textContent = 'No active tasks to track.';
    host.appendChild(empty);
    return;
  }
  const sel = document.createElement('select');
  sel.style.cssText = 'width:100%;font-size:12px;padding:4px 6px;border:1px solid #d1d5db;border-radius:4px;margin-bottom:6px';
  // Preselect the first expanded task if possible.
  const expandedId = Array.from(INBOX.expanded)[0];
  for (const t of active) {
    const opt = document.createElement('option');
    opt.value = t.id;
    opt.textContent = (t.category ? `[${t.category[0]}] ` : '') + (t.title || '(untitled)');
    if (expandedId === t.id) opt.selected = true;
    sel.appendChild(opt);
  }
  host.appendChild(sel);
  const startBtn = document.createElement('button');
  startBtn.className = 'btn btn-primary';
  startBtn.style.cssText = 'width:100%;font-size:12px;padding:5px';
  startBtn.textContent = '\u25B6 Start timer';
  startBtn.addEventListener('click', () => {
    const tid = sel.value;
    const row = { task_id: tid, started_at: new Date().toISOString(), note: '' };
    localStorage.setItem(TRACKER_LS_KEY, JSON.stringify(row));
    renderActivityTracker();
  });
  host.appendChild(startBtn);
}

function loadRunningTracker() {
  try {
    const raw = localStorage.getItem(TRACKER_LS_KEY);
    return raw ? JSON.parse(raw) : null;
  } catch { return null; }
}

function formatElapsed(ms) {
  const s = Math.max(0, Math.floor(ms / 1000));
  const h = Math.floor(s / 3600);
  const m = Math.floor((s % 3600) / 60);
  const sec = s % 60;
  return `${h}:${String(m).padStart(2, '0')}:${String(sec).padStart(2, '0')}`;
}

async function stopTrackerAndLog() {
  const running = loadRunningTracker();
  if (!running) return;
  const now = new Date();
  const hours = Math.max(0.01, (now - new Date(running.started_at)) / 3600000);
  const entry = {
    id: `ent-${now.getTime().toString(36)}-${Math.random().toString(36).slice(2, 6)}`,
    task_id: running.task_id,
    started_at: running.started_at,
    ended_at: now.toISOString(),
    hours: Math.round(hours * 100) / 100,
    note: running.note || '',
    synced_to_firebase: false,
  };
  try {
    let doc;
    try { doc = await api.load('activity_ledger.json'); }
    catch { doc = { activities: [], entries: [] }; }
    doc.entries = doc.entries || [];
    doc.entries.push(entry);
    doc.activities = doc.activities || [];
    await api.save('activity_ledger.json', doc);
    INBOX.ledger = doc;
  } catch (e) {
    alert('Failed to log time: ' + e.message);
    return;
  }
  localStorage.removeItem(TRACKER_LS_KEY);
  renderActivityTracker();
  render();
}

document.addEventListener('DOMContentLoaded', boot);
