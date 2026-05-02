/* tasks-dashboard.js — Engaged Task Dashboard.
 *
 * Two stacked sections:
 *   1. Recurring checklist (daily/weekly/monthly), unified, color-coded by category
 *   2. Pinned-task boxes — grouped by category + sub_category; one colored box
 *      per group containing expandable task cards with importance stars, hours,
 *      complete / finalize / done-for-week / book-time controls.
 *
 * Reads:
 *   data/tasks/inbox.json
 *   data/activity_ledger.json
 *   data/tasks/daily.json, weekly.json, monthly.json
 *
 * Writes:
 *   data/tasks/inbox.json via api.save (pin/importance/time_booked/finalized_at)
 *   data/tasks/{daily,weekly,monthly}.json via api.save
 *   /api/complete-task (when a subtask is marked done)
 */

const S = window.YR_SHARED;
if (!S) console.error('yr-shared.js must load before tasks-dashboard.js');

const DASH = {
  inbox: null,
  ledger: null,
  recurring: { daily: null, weekly: null, monthly: null },
  activeCadence: (localStorage.getItem('dash.activeCadence') || 'daily'),
  expanded: new Set(),
  relatedIndex: null,
  items: null,
  // Pinned buckets: project-level pins keyed by (category, sub_category).
  // One dashboard box per bucket surfaces every open task plus direct and
  // tangent context so a project can be picked up with one click.
  pinnedBuckets: null, // { buckets: [{category, sub_category, importance?, notes?}] }
  // Per-bucket UI state (open sections, search, selection) lives in a Map
  // keyed by bucketKey (category + "\u00A7" + sub_category).
  bucketUI: new Map(),
  // Focus mode (legacy task-zoom) stays as-is for deep-diving a single task.
  focusedTaskId: null,
  focusSelected: new Set(),
  focusExpanded: new Set(),
  focusSearch: '',
  focusShowTangent: false,
  focusOpenSections: new Set(),
  // Email-id → disposition map for at-a-glance glyphs on task cards.
  dispositionMap: {},
};

// Completing a task with 0 (or empty) hours logs 5 min — the "quick-hit"
// default. Lets a one-click Complete still produce a real ledger entry.
const QUICK_HIT_HOURS = 5 / 60;

function bucketKey(b) { return `${b.category || ''}\u00A7${b.sub_category || ''}`; }

// Prefix match for pinned buckets: pinning `research/grant/r01` captures
// `research/grant/r01` AND any descendant like `research/grant/r01/pond`.
// Pinning `research/grant/r01/pond` still only captures that exact leaf.
// Empty pin sub matches only records whose sub is also empty — prevents a
// bare category pin from swallowing the entire category.
function subCoveredByPin(pinSub, recordSub) {
  const p = pinSub || '';
  const r = recordSub || '';
  if (!p) return !r;
  if (r === p) return true;
  return r.startsWith(p + ':');
}
// Buckets default to collapsed so the dashboard is scannable at a glance.
// The open set is persisted to localStorage so a bucket the user opened
// yesterday is still open after a reload today.
const BUCKET_OPEN_LS_KEY = 'dash.bucketOpenKeys';

function loadBucketOpenKeys() {
  try {
    const raw = localStorage.getItem(BUCKET_OPEN_LS_KEY);
    if (raw) return new Set(JSON.parse(raw));
  } catch {}
  return new Set();
}

function saveBucketOpenKeys() {
  const openKeys = [];
  for (const [key, ui] of DASH.bucketUI) {
    if (ui.open) openKeys.push(key);
  }
  try { localStorage.setItem(BUCKET_OPEN_LS_KEY, JSON.stringify(openKeys)); } catch {}
}

function bucketUIState(key) {
  if (!DASH.bucketUI.has(key)) {
    if (!DASH._bucketOpenSeed) DASH._bucketOpenSeed = loadBucketOpenKeys();
    DASH.bucketUI.set(key, {
      open: DASH._bucketOpenSeed.has(key),  // collapsed by default, restored if previously open
      tasksOpen: true,           // tasks sub-section open once bucket is expanded
      directOpen: false,         // direct items section collapsed by default
      tangentOpen: false,        // tangent collapsed
      search: '',
      selected: new Set(),       // attachment selection
      attachTargetTaskId: null,  // which task we attach to
      openSections: new Set(),   // inner <details> open states
      expandedRows: new Set(),   // item rows expanded for preview
    });
  }
  return DASH.bucketUI.get(key);
}

const CAT_COLOR = S.CAT_COLOR;
const CAT_ORDER = S.CAT_ORDER;

/* ---------- priority helpers (mirrored from tasks-inbox for self-containment) */

const DAILY_WORK_HOURS = 6;
const BUFFER_FACTOR = 7;

function businessDaysUntil(dateStr) {
  if (!dateStr || dateStr === 'TBD') return null;
  const from = new Date(S.todayStr() + 'T00:00:00');
  const to = new Date(dateStr + 'T00:00:00');
  if (to < from) return 0;
  let days = 0;
  const cur = new Date(from);
  while (cur < to) {
    const dow = cur.getDay();
    if (dow !== 0 && dow !== 6) days += 1;
    cur.setDate(cur.getDate() + 1);
  }
  return days;
}
function hoursLoggedForTask(taskId) {
  if (!taskId) return 0;
  let total = 0;
  for (const a of (DASH.ledger?.activities || [])) {
    if (a.from_task_id === taskId || a.task_id === taskId) total += (a.hours || 0);
  }
  for (const e of (DASH.ledger?.entries || [])) {
    if (e.task_id === taskId) total += (e.hours || 0);
  }
  return total;
}
function derivePriority(task) {
  if (!task.due_date || task.due_date === 'TBD') return { flag: 'unscheduled', label: 'no due date' };
  const hoursEst = task.hours_estimate || 0;
  if (hoursEst <= 0) return { flag: 'unscheduled', label: 'no estimate' };
  const logged = hoursLoggedForTask(task.id);
  const hoursRem = Math.max(0, hoursEst - logged);
  const days = businessDaysUntil(task.due_date);
  const workLeft = days * DAILY_WORK_HOURS;
  if (days <= 0 && hoursRem > 0) return { flag: 'overdue', label: 'overdue' };
  if (workLeft === 0) return { flag: 'on-track', label: 'on track' };
  if (hoursRem > workLeft) return { flag: 'overdue-risk', label: `${hoursRem.toFixed(1)}h / ${workLeft}h` };
  if (hoursRem > workLeft / BUFFER_FACTOR) return { flag: 'schedule-now', label: `pace: ${hoursRem.toFixed(1)}h in ${workLeft}h` };
  return { flag: 'on-track', label: 'on track' };
}
const PRIORITY_FLAG_STYLE = {
  'overdue':       { bg: '#fecaca', fg: '#7f1d1d', icon: '\u26A0' },
  'overdue-risk':  { bg: '#fee2e2', fg: '#991b1b', icon: '\u26A0' },
  'schedule-now':  { bg: '#fef3c7', fg: '#92400e', icon: '\u23F3' },
  'on-track':      { bg: '#dcfce7', fg: '#166534', icon: '\u2713' },
  'unscheduled':   { bg: '#e5e7eb', fg: '#374151', icon: '\u2014' },
};

/* ---------- iso week ---------- */

function isoWeek(d) {
  d = new Date(Date.UTC(d.getFullYear(), d.getMonth(), d.getDate()));
  const day = d.getUTCDay() || 7;
  d.setUTCDate(d.getUTCDate() + 4 - day);
  const yearStart = new Date(Date.UTC(d.getUTCFullYear(), 0, 1));
  const week = Math.ceil((((d - yearStart) / 86400000) + 1) / 7);
  return `${d.getUTCFullYear()}-W${String(week).padStart(2, '0')}`;
}
function currentIsoWeek() { return isoWeek(new Date()); }

/* ---------- boot ---------- */

async function boot() {
  await loadAll();
  await autoResetRecurring();
  const m = (location.hash || '').match(/#task=(.+)$/);
  if (m) {
    const t = (DASH.inbox?.tasks || []).find(x => x.id === decodeURIComponent(m[1]));
    if (t) DASH.focusedTaskId = t.id;
  }
  render();
  document.getElementById('btn-pin-from-inbox').addEventListener('click', openPinPicker);
  window.addEventListener('keydown', (e) => {
    if (e.key === 'Escape' && DASH.focusedTaskId) { exitFocus(); }
  });
}

/* Auto-reset recurring checklists when the period rolls over.
 * Daily resets each calendar day, weekly on ISO-week change, monthly on
 * YYYY-MM change. Also prunes stale weekly_done stamps on pinned tasks. */
async function autoResetRecurring() {
  const today = S.todayStr();
  const week = currentIsoWeek();
  const month = today.slice(0, 7);

  const last = {
    daily:   localStorage.getItem('dash.lastReset.daily'),
    weekly:  localStorage.getItem('dash.lastReset.weekly'),
    monthly: localStorage.getItem('dash.lastReset.monthly'),
  };

  const resets = [
    { cad: 'daily',   current: today, key: 'dash.lastReset.daily' },
    { cad: 'weekly',  current: week,  key: 'dash.lastReset.weekly' },
    { cad: 'monthly', current: month, key: 'dash.lastReset.monthly' },
  ];

  for (const r of resets) {
    const prev = last[r.cad];
    // First run: stamp without resetting so we don't wipe state on first open.
    if (!prev) { localStorage.setItem(r.key, r.current); continue; }
    if (prev === r.current) continue;
    const list = DASH.recurring[r.cad];
    const changed = (list?.tasks || []).some(t => t.completed);
    if (changed) {
      list.tasks.forEach(t => t.completed = false);
      await api.save(`tasks/${r.cad}.json`, list);
    }
    localStorage.setItem(r.key, r.current);
  }

  // Prune stale weekly_done stamps so old pins don't look permanently "done
  // for week" after the week changes.
  let mutated = false;
  for (const t of (DASH.inbox?.tasks || [])) {
    if (t.weekly_done && t.weekly_done !== week) {
      t.weekly_done = null;
      mutated = true;
    }
  }
  if (mutated) await saveInbox();
}

async function loadAll() {
  const [inbox, ledger, daily, weekly, monthly, items, pinnedB, dispMap] = await Promise.all([
    api.load('tasks/inbox.json').catch(() => ({ tasks: [] })),
    api.load('activity_ledger.json').catch(() => ({ activities: [] })),
    api.load('tasks/daily.json').catch(() => ({ tasks: [] })),
    api.load('tasks/weekly.json').catch(() => ({ tasks: [] })),
    api.load('tasks/monthly.json').catch(() => ({ tasks: [] })),
    api.load('items.json').catch(() => ({ items: [] })),
    api.load('tasks/pinned_buckets.json').catch(() => ({ buckets: [] })),
    (window.DISPOSITION?.loadMap ? window.DISPOSITION.loadMap() : Promise.resolve({})),
  ]);
  DASH.dispositionMap = dispMap || {};
  DASH.inbox = inbox;
  DASH.inbox.tasks = DASH.inbox.tasks || [];
  DASH.ledger = ledger;
  DASH.recurring = { daily, weekly, monthly };
  DASH.items = items;
  DASH.pinnedBuckets = pinnedB;
  DASH.pinnedBuckets.buckets = DASH.pinnedBuckets.buckets || [];
  // Backfill: if no buckets exist but legacy task.pinned=true records do,
  // seed the bucket list from them. One-time migration; next save writes
  // the canonical file.
  if (!DASH.pinnedBuckets.buckets.length) {
    const seen = new Set();
    for (const t of DASH.inbox.tasks) {
      if (!t.pinned) continue;
      const k = `${t.category || ''}\u00A7${t.sub_category || ''}`;
      if (seen.has(k)) continue;
      seen.add(k);
      DASH.pinnedBuckets.buckets.push({
        category: t.category || '',
        sub_category: t.sub_category || '',
      });
    }
    if (DASH.pinnedBuckets.buckets.length) await savePinnedBuckets();
  }
  await buildRelatedIndex();
  await loadRawArchives();
}

async function savePinnedBuckets() {
  DASH.pinnedBuckets.updated_at = new Date().toISOString();
  await api.save('tasks/pinned_buckets.json', DASH.pinnedBuckets);
}

function isBucketPinned(category, sub_category) {
  return (DASH.pinnedBuckets?.buckets || []).some(b =>
    (b.category || '') === (category || '') &&
    (b.sub_category || '') === (sub_category || ''));
}

async function pinBucket(category, sub_category) {
  if (isBucketPinned(category, sub_category)) return;
  DASH.pinnedBuckets.buckets.push({
    category: category || '',
    sub_category: sub_category || '',
  });
  await savePinnedBuckets();
}

async function unpinBucket(category, sub_category) {
  DASH.pinnedBuckets.buckets = (DASH.pinnedBuckets.buckets || []).filter(b =>
    !((b.category || '') === (category || '') &&
      (b.sub_category || '') === (sub_category || '')));
  DASH.bucketUI.delete(`${category || ''}\u00A7${sub_category || ''}`);
  await savePinnedBuckets();
}

/* Load the raw email/event archives so the focus view can surface every
 * item in the task's category — not just the ones already clustered into
 * year_review. Emails lack native sub_category, so we back-fill from
 * year_review + category_overrides. */
async function loadRawArchives() {
  DASH.rawEmails = [];
  DASH.rawEvents = [];
  DASH.emailSubLookup = {};
  DASH.eventSubLookup = {};

  // Most-recent 3 years of emails keeps this well under 10k records in practice.
  const thisYear = new Date().getFullYear();
  const years = [thisYear, thisYear - 1, thisYear - 2].map(String);
  for (const y of years) {
    try {
      const doc = await api.load(`email_archive/by_year/${y}.json`);
      for (const e of (doc.emails || [])) DASH.rawEmails.push({ ...e, _year: y });
    } catch {}
  }

  // Emails that were placed under a sub_category by year_review — fastest
  // source of truth for (email_id → sub_category). Overrides win if both exist.
  for (const key of Object.keys(DASH.relatedIndex?.bySub || {})) {
    const b = DASH.relatedIndex.bySub[key];
    for (const e of b.emails) {
      if (e.id && !DASH.emailSubLookup[e.id]) {
        DASH.emailSubLookup[e.id] = { category: b.category, sub_category: key };
      }
    }
  }
  try {
    const ov = await api.load('email_archive/category_overrides.json');
    for (const [id, rec] of Object.entries(ov.overrides || {})) {
      if (rec && typeof rec === 'object' && rec.sub_category) {
        DASH.emailSubLookup[id] = { category: rec.category, sub_category: rec.sub_category };
      }
    }
  } catch {}

  // Calendar events live in a JSONL file, outside /api/data (which restricts
  // to .json). The archive is still lab-global single-tenant data — skip
  // the load for non-admin users so other lab members don't see Alex's events.
  if (typeof firebridge === 'undefined' || firebridge.isAdmin()) {
    try {
      const res = await fetch('/data/calendar_archive/events_v2.jsonl');
      if (res.ok) {
        const txt = await res.text();
        for (const line of txt.split('\n')) {
          if (!line.trim()) continue;
          try { DASH.rawEvents.push(JSON.parse(line)); } catch {}
        }
      }
    } catch {}
  }

  // Back-fill event → sub_category. Priority: year_review index → overrides.
  // Without this, calendar events never appear under a pinned bucket because
  // raw events_v2.jsonl lacks a reliable sub_category field.
  for (const key of Object.keys(DASH.relatedIndex?.bySub || {})) {
    const b = DASH.relatedIndex.bySub[key];
    for (const e of b.events) {
      if (e.id && !DASH.eventSubLookup[e.id]) {
        DASH.eventSubLookup[e.id] = { category: b.category, sub_category: key };
      }
    }
  }
  try {
    const ov = await api.load('calendar_archive/category_overrides.json');
    for (const [id, rec] of Object.entries(ov.overrides || {})) {
      if (rec && typeof rec === 'object' && rec.sub_category) {
        DASH.eventSubLookup[id] = { category: rec.category, sub_category: rec.sub_category };
      }
    }
  } catch {}
}

/* Build an index of sub_category → {events, emails, activities} by flattening
 * the 1–2 most recent year_review files. Each row in year_review is already
 * keyed by (category, sub_category) and carries its own events/emails/activities.
 * Prefix matching happens at query time. */
async function buildRelatedIndex() {
  DASH.relatedIndex = { bySub: {}, byCat: {} };
  let years = [];
  try {
    const idx = await api.load('year_review/index.json');
    years = (idx.years || []).slice().sort().reverse().slice(0, 2);
  } catch {
    const y = new Date().getFullYear();
    years = [String(y), String(y - 1)];
  }
  for (const y of years) {
    let doc;
    try { doc = await api.load(`year_review/${y}.json`); } catch { continue; }
    for (const g of (doc.groups || [])) {
      const cat = g.category;
      for (const r of (g.rows || [])) {
        const key = r.sub_category || '';
        const bucket = DASH.relatedIndex.bySub[key] ||= { category: cat, events: [], emails: [], activities: [] };
        for (const e of (r.events || [])) bucket.events.push({ ...e, _year: y });
        for (const e of (r.emails || [])) bucket.emails.push({ ...e, _year: y });
        for (const a of (r.activities || [])) bucket.activities.push({ ...a, _year: y });
        for (const a of (r.completed_activities || [])) bucket.activities.push({ ...a, _year: y, _completed: true });
        (DASH.relatedIndex.byCat[cat] ||= new Set()).add(key);
      }
    }
  }
}

/* Resolve a pinned task's related items into two scopes:
 *   - `direct`: exact (category, sub_category) match — these are "the same
 *     full category" as the task (e.g. task at grant:R01:Pond → only items
 *     tagged grant:R01:Pond).
 *   - `tangent`: same top-level category AND sub_category shares a prefix
 *     with the task's path in either direction (ancestor or descendant),
 *     minus the direct set. Useful for catching mis-classified items (typos
 *     in sub_category paths) the user may want to pull back into `direct`. */
function _subRelation(taskSub, rowSub) {
  if (taskSub === rowSub) return 'direct';
  if (!rowSub && !taskSub) return 'direct';
  if (!taskSub || !rowSub) return 'tangent';
  if (rowSub.startsWith(taskSub + ':') || taskSub.startsWith(rowSub + ':')) return 'tangent';
  return null;
}

function _emptyBucket() {
  return { events: [], emails: [], activities: [], items: [], tasks: [] };
}

function relatedForTask(task, opts = {}) {
  const cat = task.category || '';
  const sub = task.sub_category || '';
  const direct = _emptyBucket();
  const tangent = _emptyBucket();
  // `prefixMatch`=true means any descendant of `sub` counts as direct, which
  // is what pinned buckets want (pinning a parent should surface children as
  // first-class, not second-class). Focus mode and other callers stick with
  // exact match.
  const prefixMatch = !!opts.prefixMatch;
  const isDirect = (itemSub) => prefixMatch
    ? subCoveredByPin(sub, itemSub)
    : (sub === (itemSub || ''));

  const place = (bucketKey, item, itemSub) => {
    const rel = isDirect(itemSub) ? 'direct' : 'tangent';
    (rel === 'direct' ? direct : tangent)[bucketKey].push({ ...item, _sub: itemSub });
  };

  for (const e of (DASH.rawEvents || [])) {
    const lookup = DASH.eventSubLookup[e.id];
    const eventCat = (lookup?.category) || (e.category || '');
    if (eventCat !== cat) continue;
    const esub = lookup?.sub_category || e.sub_category || '';
    place('events', e, esub);
  }
  for (const e of (DASH.rawEmails || [])) {
    if ((e.category || '') !== cat) continue;
    const esub = DASH.emailSubLookup[e.id]?.sub_category || '';
    place('emails', e, esub);
  }
  for (const a of (DASH.ledger?.activities || [])) {
    if ((a.category || '') !== cat) continue;
    place('activities', a, a.sub_category || '');
  }

  // Items have no sub_category field on items.json — all go to tangent unless
  // the task has no sub_category either.
  for (const it of (DASH.items?.items || [])) {
    if (it.category !== cat) continue;
    if (!sub) direct.items.push(it);
    else tangent.items.push(it);
  }

  // Sibling tasks
  for (const t of (DASH.inbox?.tasks || [])) {
    if (t.id === task.id) continue;
    if ((t.category || '') !== cat) continue;
    if (!['active', 'accepted', 'suggested'].includes(t.status)) continue;
    const ts = t.sub_category || '';
    const rel = isDirect(ts) ? 'direct' : 'tangent';
    (rel === 'direct' ? direct : tangent).tasks.push(t);
  }

  const sortBuckets = (b) => {
    b.events.sort((a, b2) => (b2.start || '').localeCompare(a.start || ''));
    b.emails.sort((a, b2) => (b2.date || '').localeCompare(a.date || ''));
    b.activities.sort((a, b2) => (b2.completed_at || '').localeCompare(a.completed_at || ''));
  };
  sortBuckets(direct);
  sortBuckets(tangent);
  return { direct, tangent };
}

/* Apply a search filter to both direct+tangent buckets. Search looks at
 * title, subject, description, notes, sub_category, from, location. */
function filterRelated(r, query) {
  const q = (query || '').trim().toLowerCase();
  if (!q) return r;
  const match = (row) => {
    const hay = [
      row.title, row.subject, row.description, row.notes, row._sub,
      row.location, row.sub_category, row.status, row.id, row.type,
      row.activity_type,
      Array.isArray(row.from) ? (row.from[0]?.name || row.from[0]?.email || '') : row.from,
    ].filter(Boolean).join(' ').toLowerCase();
    return hay.includes(q);
  };
  const apply = (b) => ({
    events: b.events.filter(match),
    emails: b.emails.filter(match),
    activities: b.activities.filter(match),
    items: b.items.filter(match),
    tasks: b.tasks.filter(match),
  });
  return { direct: apply(r.direct), tangent: apply(r.tangent) };
}

async function saveInbox() {
  DASH.inbox.generated_at = new Date().toISOString();
  await api.save('tasks/inbox.json', DASH.inbox);
}

/* ---------- render ---------- */

function render() {
  const host = document.getElementById('dash-content');
  // Preserve caret state on any search input across re-renders. We identify
  // the focused field by its data-search-key so multiple buckets + the focus
  // view can each have their own persistent search.
  const prev = document.activeElement;
  const prevKey = prev && prev.dataset ? prev.dataset.searchKey : null;
  const caret = prevKey ? prev.selectionStart : null;

  host.innerHTML = '';
  if (DASH.focusedTaskId) {
    const t = (DASH.inbox?.tasks || []).find(x => x.id === DASH.focusedTaskId);
    if (t) { host.appendChild(renderFocus(t)); }
    else DASH.focusedTaskId = null;
  }
  if (!DASH.focusedTaskId) {
    host.appendChild(renderRecurringSection());
    host.appendChild(renderPinnedSection());
    const hints = renderSuggestionStrip();
    if (hints) host.appendChild(hints);
  }

  if (prevKey) {
    const s = host.querySelector(`[data-search-key="${prevKey}"]`);
    if (s) { s.focus(); try { s.setSelectionRange(caret, caret); } catch {} }
  }
}

function enterFocus(taskId) {
  DASH.focusedTaskId = taskId;
  DASH.focusSelected = new Set();
  DASH.focusExpanded = new Set();
  DASH.focusOpenSections = new Set();
  DASH.focusSearch = '';
  DASH.focusShowTangent = false;
  history.replaceState(null, '', '#task=' + taskId);
  render();
  window.scrollTo({ top: 0, behavior: 'instant' });
}
function exitFocus() {
  DASH.focusedTaskId = null;
  DASH.focusSelected = new Set();
  DASH.focusExpanded = new Set();
  DASH.focusOpenSections = new Set();
  DASH.focusSearch = '';
  history.replaceState(null, '', location.pathname);
  render();
}

/* ---------- pin suggestions ----------
 *
 * Scores unpinned active/accepted tasks and offers the top handful as
 * quick-pin candidates. Signals combined:
 *   + overdue or overdue-risk → strong signal (user should engage now)
 *   + recent ledger activity on same category+sub_category → user is already
 *     working in this area, pinning sibling tasks surfaces them together
 *   + large hours_estimate → work that needs explicit tracking
 */
function suggestionScore(task, activityByKey) {
  let score = 0;
  const pri = derivePriority(task);
  if (pri.flag === 'overdue') score += 6;
  else if (pri.flag === 'overdue-risk') score += 4;
  else if (pri.flag === 'schedule-now') score += 2;
  const k = `${task.category || 'unknown'}\u00A7${task.sub_category || ''}`;
  score += Math.min(3, (activityByKey[k] || 0));
  if ((task.hours_estimate || 0) >= 4) score += 2;
  else if ((task.hours_estimate || 0) >= 1) score += 1;
  if (task.importance) score += Math.min(2, task.importance - 2);
  return score;
}

function computeSuggestions(limit = 5) {
  const cutoff = new Date();
  cutoff.setDate(cutoff.getDate() - 14);
  const cutoffStr = cutoff.toISOString().slice(0, 10);
  const activityByKey = {};
  for (const a of (DASH.ledger?.activities || [])) {
    const d = (a.completed_at || '').slice(0, 10);
    if (d < cutoffStr) continue;
    const k = `${a.category || 'unknown'}\u00A7${a.sub_category || ''}`;
    activityByKey[k] = (activityByKey[k] || 0) + 1;
  }
  const candidates = (DASH.inbox?.tasks || []).filter(t =>
    !isBucketPinned(t.category, t.sub_category) &&
    ['active', 'accepted'].includes(t.status)
  );
  return candidates
    .map(t => ({ task: t, score: suggestionScore(t, activityByKey) }))
    .filter(x => x.score > 0)
    .sort((a, b) => b.score - a.score)
    .slice(0, limit);
}

function renderSuggestionStrip() {
  const sug = computeSuggestions(5);
  if (!sug.length) return null;
  const wrap = document.createElement('section');
  wrap.className = 'dash-section suggestion-strip';
  const header = document.createElement('div');
  header.className = 'dash-section-header';
  header.innerHTML = '<h2 class="dash-section-title">Suggested to pin</h2><span style="color:#6b7280;font-size:12px">active tasks flagged by recent activity, due dates, or size</span>';
  wrap.appendChild(header);
  const row = document.createElement('div');
  row.className = 'sug-row';
  for (const { task, score } of sug) {
    const card = document.createElement('div');
    card.className = 'sug-card';
    const color = CAT_COLOR[task.category || 'unknown'] || '#6b7280';
    card.style.borderLeft = `3px solid ${color}`;
    const pri = derivePriority(task);
    const sty = PRIORITY_FLAG_STYLE[pri.flag] || PRIORITY_FLAG_STYLE['unscheduled'];
    card.innerHTML = `
      <div class="sug-title">${S.escapeHtml(task.title || '')}</div>
      <div class="sug-meta">
        <span>${S.escapeHtml(task.category || '?')}${task.sub_category ? ' / ' + S.escapeHtml(task.sub_category) : ''}</span>
        <span class="priority-chip" style="background:${sty.bg};color:${sty.fg}">${sty.icon} ${pri.flag.replace('-',' ')}</span>
      </div>
    `;
    const btn = document.createElement('button');
    btn.className = 'btn btn-sm';
    btn.textContent = 'Pin';
    btn.addEventListener('click', () => setPinned(task, true));
    card.appendChild(btn);
    row.appendChild(card);
  }
  wrap.appendChild(row);
  return wrap;
}

/* ---------- recurring section ---------- */

function renderRecurringSection() {
  const wrap = document.createElement('section');
  wrap.className = 'dash-section';

  const header = document.createElement('div');
  header.className = 'dash-section-header';
  header.innerHTML = '<h2 class="dash-section-title">Recurring Checklist</h2>';
  const cadenceBar = document.createElement('div');
  cadenceBar.className = 'cadence-pills';
  for (const cad of ['daily', 'weekly', 'monthly']) {
    const b = document.createElement('button');
    b.className = 'cadence-pill' + (DASH.activeCadence === cad ? ' active' : '');
    const tasks = (DASH.recurring[cad]?.tasks || []);
    const done = tasks.filter(t => t.completed).length;
    b.textContent = `${cad} (${done}/${tasks.length})`;
    b.addEventListener('click', () => {
      DASH.activeCadence = cad;
      localStorage.setItem('dash.activeCadence', cad);
      render();
    });
    cadenceBar.appendChild(b);
  }
  const addBtn = document.createElement('button');
  addBtn.className = 'btn btn-sm';
  addBtn.textContent = '+ Add';
  addBtn.style.marginLeft = 'auto';
  addBtn.addEventListener('click', () => openRecurringForm(DASH.activeCadence));
  cadenceBar.appendChild(addBtn);

  header.appendChild(cadenceBar);
  wrap.appendChild(header);

  const list = document.createElement('ul');
  list.className = 'recurring-list';
  const tasks = DASH.recurring[DASH.activeCadence]?.tasks || [];
  if (!tasks.length) {
    const empty = document.createElement('li');
    empty.className = 'empty-state';
    empty.textContent = 'No tasks yet. Click + Add.';
    list.appendChild(empty);
  }
  tasks.forEach((t, idx) => list.appendChild(renderRecurringRow(DASH.activeCadence, t, idx)));
  wrap.appendChild(list);

  if (tasks.length) {
    const footer = document.createElement('div');
    footer.className = 'recurring-footer';
    const reset = document.createElement('button');
    reset.className = 'btn btn-sm';
    reset.textContent = 'Reset checkboxes';
    reset.addEventListener('click', () => resetRecurring(DASH.activeCadence));
    footer.appendChild(reset);
    wrap.appendChild(footer);
  }
  return wrap;
}

function renderRecurringRow(cadence, task, idx) {
  const li = document.createElement('li');
  li.className = 'recurring-row';
  const cat = task.category || 'admin';
  const color = CAT_COLOR[cat] || '#6b7280';

  const cb = document.createElement('input');
  cb.type = 'checkbox';
  cb.checked = !!task.completed;
  cb.addEventListener('change', async () => {
    const list = DASH.recurring[cadence];
    list.tasks[idx].completed = cb.checked;
    await api.save(`tasks/${cadence}.json`, list);
    render();
  });

  const dot = document.createElement('span');
  dot.className = 'cat-dot';
  dot.style.background = color;
  dot.title = cat;

  const label = document.createElement('span');
  label.className = 'recurring-label';
  let text = task.title || '';
  if (task.day && task.day !== 'TBD') text += ` (${task.day})`;
  if (task.due_month) {
    const months = ['','Jan','Feb','Mar','Apr','May','Jun','Jul','Aug','Sep','Oct','Nov','Dec'];
    text += ` (${months[task.due_month]})`;
  }
  label.textContent = text;
  if (task.completed) label.classList.add('done');

  const stars = S.starBar(task.importance || 0, async (v) => {
    const list = DASH.recurring[cadence];
    list.tasks[idx].importance = v;
    await api.save(`tasks/${cadence}.json`, list);
    render();
  }, 12);

  const actions = document.createElement('span');
  actions.className = 'row-actions';
  const edit = document.createElement('button');
  edit.textContent = 'Edit';
  edit.addEventListener('click', () => openRecurringForm(cadence, idx));
  const del = document.createElement('button');
  del.textContent = 'Delete';
  del.addEventListener('click', () => deleteRecurring(cadence, idx));
  actions.appendChild(edit);
  actions.appendChild(del);

  li.appendChild(cb);
  li.appendChild(dot);
  li.appendChild(label);
  li.appendChild(stars);
  li.appendChild(actions);
  return li;
}

function recurringFields(cadence) {
  const base = [
    { key: 'title', label: 'Task', type: 'text', required: true },
    { key: 'category', label: 'Category', type: 'select', options: CAT_ORDER },
    { key: 'notes', label: 'Notes', type: 'textarea' },
  ];
  if (cadence === 'weekly') {
    base.splice(1, 0, { key: 'day', label: 'Day', type: 'select',
      options: ['Monday','Tuesday','Wednesday','Thursday','Friday','TBD'] });
  }
  if (cadence === 'monthly') {
    base.splice(1, 0, { key: 'due_month', label: 'Due Month (1-12)', type: 'number' });
  }
  return base;
}

function openRecurringForm(cadence, idx) {
  const list = DASH.recurring[cadence];
  const existing = (idx != null) ? list.tasks[idx] : null;
  openForm({
    title: existing ? 'Edit task' : `Add ${cadence} task`,
    fields: recurringFields(cadence),
    values: existing || {},
    onSave: async (vals) => {
      if (existing) {
        Object.assign(list.tasks[idx], vals);
        list.tasks[idx].id = slugify(vals.title);
      } else {
        vals.id = slugify(vals.title);
        vals.completed = false;
        list.tasks = list.tasks || [];
        list.tasks.push(vals);
      }
      await api.save(`tasks/${cadence}.json`, list);
      render();
    },
  });
}

async function deleteRecurring(cadence, idx) {
  if (!confirmAction('Remove this task?')) return;
  const list = DASH.recurring[cadence];
  list.tasks.splice(idx, 1);
  await api.save(`tasks/${cadence}.json`, list);
  render();
}

async function resetRecurring(cadence) {
  const list = DASH.recurring[cadence];
  (list.tasks || []).forEach(t => t.completed = false);
  await api.save(`tasks/${cadence}.json`, list);
  render();
}

/* ---------- pinned section ---------- */

function openTasksInBucket(category, sub_category) {
  const cat = category || '';
  return (DASH.inbox?.tasks || []).filter(t =>
    (t.category || '') === cat &&
    subCoveredByPin(sub_category, t.sub_category) &&
    !['completed', 'rejected'].includes(t.status)
  );
}

function completedTasksInBucket(category, sub_category) {
  const cat = category || '';
  return (DASH.inbox?.tasks || [])
    .filter(t => (t.category || '') === cat &&
      subCoveredByPin(sub_category, t.sub_category) &&
      t.status === 'completed')
    .sort((a, b) => (b.completed_at || '').localeCompare(a.completed_at || ''));
}

function renderPinnedSection() {
  const wrap = document.createElement('section');
  wrap.className = 'dash-section';
  const header = document.createElement('div');
  header.className = 'dash-section-header';
  const buckets = DASH.pinnedBuckets?.buckets || [];
  header.innerHTML = `<h2 class="dash-section-title">Engaged Projects (${buckets.length} pinned)</h2>`;
  wrap.appendChild(header);

  if (!buckets.length) {
    const empty = document.createElement('div');
    empty.className = 'empty-state';
    empty.innerHTML = 'No projects pinned yet. Click <strong>+ Pin project</strong> to search any category, or pin a task from the inbox or an email to add its bucket.';
    wrap.appendChild(empty);
    return wrap;
  }

  const sorted = buckets.slice().sort((a, b) => {
    const ia = CAT_ORDER.indexOf(a.category); const ib = CAT_ORDER.indexOf(b.category);
    if (ia !== ib) return ia - ib;
    return (a.sub_category || '').localeCompare(b.sub_category || '');
  });

  const list = document.createElement('div');
  list.className = 'bucket-stack';
  for (const b of sorted) list.appendChild(renderBucketBox(b));
  wrap.appendChild(list);
  return wrap;
}

// Effective sub_category for a bucket — view override when set, else home.
// Every downstream consumer (task filters, reclassify target, new-task
// creation) goes through this so "where am I looking" stays consistent.
function bucketEffectiveSub(bucket) {
  const v = bucket.view_sub_category;
  if (v === undefined || v === null) return bucket.sub_category || '';
  return v;
}

async function setBucketView(bucket, newView) {
  // newView = '' means show the category-level view (matches only exactly-
  // empty sub records, per subCoveredByPin). newView === home deletes the
  // override so reloads show home. Any other string persists.
  const home = bucket.sub_category || '';
  if (newView === home) {
    delete bucket.view_sub_category;
  } else {
    bucket.view_sub_category = newView;
  }
  await savePinnedBuckets();
  render();
}

// Return child paths that extend `basePath` by exactly one colon segment
// and actually have at least one task or ledger entry living under them.
// Empty-or-equal basePath treats the empty string as "top of category".
function childrenOf(cat, basePath) {
  const bucket = {};
  const prefix = basePath ? basePath + ':' : '';
  const seed = [
    ...(DASH.inbox?.tasks || []),
    ...(DASH.ledger?.activities || []),
  ];
  for (const row of seed) {
    if ((row.category || '') !== cat) continue;
    const s = row.sub_category || '';
    if (!s.startsWith(prefix)) continue;
    const rest = s.slice(prefix.length);
    if (!rest) continue;  // exact match of basePath; not a child
    const firstSeg = rest.split(':')[0];
    if (!firstSeg) continue;
    const childPath = prefix + firstSeg;
    bucket[childPath] = (bucket[childPath] || 0) + 1;
  }
  return Object.entries(bucket)
    .sort((a, b) => b[1] - a[1])
    .map(([path, count]) => ({ path, count }));
}

function renderBucketCrumbs(bucket, home, view, color) {
  const cat = bucket.category || '';
  const wrap = document.createElement('span');
  wrap.className = 'bucket-crumbs-wrap';
  const parts = view ? view.split(':') : [];

  // Category segment — click jumps the view to empty (category-level).
  const catSeg = document.createElement('button');
  catSeg.className = 'crumb-seg crumb-cat';
  catSeg.type = 'button';
  catSeg.textContent = cat || '—';
  catSeg.style.color = color;
  catSeg.title = `Show ${cat} at category level (empty sub_category only)`;
  catSeg.addEventListener('click', () => setBucketView(bucket, ''));
  wrap.appendChild(catSeg);

  // Each sub-segment becomes its own clickable button that sets the view
  // to the cumulative path through that segment.
  let acc = [];
  for (let i = 0; i < parts.length; i++) {
    wrap.appendChild(document.createTextNode(' / '));
    acc.push(parts[i]);
    const path = acc.join(':');
    const seg = document.createElement('button');
    seg.className = 'crumb-seg';
    seg.type = 'button';
    seg.textContent = parts[i];
    if (path === view) seg.classList.add('crumb-current');
    if (path === home) seg.classList.add('crumb-home');
    seg.title = path === home
      ? `Home pin (${path}). Click to reset view to home.`
      : `Jump to ${path}`;
    seg.addEventListener('click', () => setBucketView(bucket, path));
    wrap.appendChild(seg);
  }

  // Down button — only shown if this path has descendant children with data.
  const children = childrenOf(cat, view);
  if (children.length) {
    const down = document.createElement('button');
    down.className = 'crumb-nav crumb-down';
    down.type = 'button';
    down.textContent = '\u25BE';
    down.title = `Narrow view to a child path (${children.length} options)`;
    down.addEventListener('click', (ev) => {
      ev.stopPropagation();
      openChildPicker(bucket, view, children, down);
    });
    wrap.appendChild(down);
  }

  // Home button — only shown when view has drifted from home.
  if (view !== home) {
    const homeBtn = document.createElement('button');
    homeBtn.className = 'crumb-nav crumb-home-btn';
    homeBtn.type = 'button';
    homeBtn.textContent = '\u2302';
    homeBtn.title = `Reset view to pin home: ${home || '(category)'}`;
    homeBtn.addEventListener('click', () => setBucketView(bucket, home));
    wrap.appendChild(homeBtn);
  }

  return wrap;
}

function openChildPicker(bucket, basePath, children, anchor) {
  // Lightweight dropdown — a positioned <ul> under the down button.
  // Clicking an entry narrows the view; outside click dismisses.
  const existing = document.querySelector('.crumb-dropdown');
  if (existing) existing.remove();

  const menu = document.createElement('div');
  menu.className = 'crumb-dropdown';
  menu.style.cssText = 'position:absolute;z-index:1000;background:#fff;border:1px solid #d1d5db;border-radius:6px;box-shadow:0 4px 10px rgba(0,0,0,.12);padding:4px 0;min-width:220px;max-height:60vh;overflow:auto;font-size:13px';

  const header = document.createElement('div');
  header.textContent = `Narrow from ${basePath || '(top)'}`;
  header.style.cssText = 'padding:6px 12px;font-size:11px;color:#6b7280;text-transform:uppercase;letter-spacing:.4px;border-bottom:1px solid #f3f4f6';
  menu.appendChild(header);

  for (const c of children) {
    const item = document.createElement('button');
    item.type = 'button';
    item.className = 'crumb-dropdown-item';
    item.style.cssText = 'display:flex;justify-content:space-between;width:100%;padding:6px 12px;border:none;background:#fff;cursor:pointer;text-align:left';
    const label = c.path.slice(basePath ? basePath.length + 1 : 0);
    item.innerHTML = `<span>${S.escapeHtml(label)}</span><span style="color:#9ca3af;margin-left:8px">${c.count}</span>`;
    item.addEventListener('mouseenter', () => { item.style.background = '#f3f4f6'; });
    item.addEventListener('mouseleave', () => { item.style.background = '#fff'; });
    item.addEventListener('click', () => {
      menu.remove();
      setBucketView(bucket, c.path);
    });
    menu.appendChild(item);
  }

  document.body.appendChild(menu);
  const rect = anchor.getBoundingClientRect();
  menu.style.left = `${Math.round(rect.left + window.scrollX)}px`;
  menu.style.top  = `${Math.round(rect.bottom + window.scrollY + 4)}px`;

  // Dismiss on outside click or Escape.
  const dismiss = (ev) => {
    if (menu.contains(ev.target)) return;
    menu.remove();
    document.removeEventListener('click', dismiss, true);
    document.removeEventListener('keydown', onKey, true);
  };
  const onKey = (ev) => {
    if (ev.key === 'Escape') {
      menu.remove();
      document.removeEventListener('click', dismiss, true);
      document.removeEventListener('keydown', onKey, true);
    }
  };
  setTimeout(() => {
    document.addEventListener('click', dismiss, true);
    document.addEventListener('keydown', onKey, true);
  }, 0);
}

function renderBucketBox(bucket) {
  const cat = bucket.category || '';
  const home = bucket.sub_category || '';
  // view_sub_category lets the user navigate up/down the hierarchy without
  // losing the "home" anchor. When null/undefined, the view === home.
  const view = (bucket.view_sub_category === undefined || bucket.view_sub_category === null)
    ? home
    : bucket.view_sub_category;
  const sub = view;
  const key = bucketKey(bucket);
  const ui = bucketUIState(key);
  const color = CAT_COLOR[cat] || '#6b7280';
  const tasks = openTasksInBucket(cat, sub);
  const completedTasks = completedTasksInBucket(cat, sub);

  // Sort open tasks by importance then priority severity
  const FLAG_WEIGHT = { 'overdue': 0, 'overdue-risk': 1, 'schedule-now': 2, 'on-track': 3, 'unscheduled': 4 };
  tasks.sort((a, b) => {
    const ia = (b.importance || 0) - (a.importance || 0);
    if (ia !== 0) return ia;
    return FLAG_WEIGHT[derivePriority(a).flag] - FLAG_WEIGHT[derivePriority(b).flag];
  });

  const rel = relatedForTask({ category: cat, sub_category: sub }, { prefixMatch: true });
  const directN  = rel.direct.events.length + rel.direct.emails.length + rel.direct.activities.length + rel.direct.items.length;
  const tangentN = rel.tangent.events.length + rel.tangent.emails.length + rel.tangent.activities.length + rel.tangent.items.length;

  const box = document.createElement('section');
  box.className = 'bucket-box' + (ui.open ? '' : ' collapsed');
  box.style.borderLeft = `6px solid ${color}`;

  // --- Header
  const head = document.createElement('header');
  head.className = 'bucket-head';
  head.style.background = color + '14';
  const thisWeek = currentIsoWeek();
  const allDoneForWeek = tasks.length > 0 && tasks.every(t => t.weekly_done === thisWeek);
  if (allDoneForWeek) box.classList.add('done-for-week');
  const totalEst = tasks.reduce((s, t) => s + (t.hours_estimate || 0), 0);
  // Time spent rolls across BOTH open and completed tasks — that's the whole
  // point of a project bucket: show cumulative effort on the project.
  const totalLogged =
    tasks.reduce((s, t) => s + hoursLoggedForTask(t.id), 0) +
    completedTasks.reduce((s, t) => s + hoursLoggedForTask(t.id), 0);
  head.innerHTML = `
    <button class="bucket-toggle" title="${ui.open ? 'Collapse' : 'Expand'}">${ui.open ? '\u25BE' : '\u25B8'}</button>
    <div class="bucket-title">
      <span class="bucket-cat" style="color:${color}">${S.escapeHtml(cat || '\u2014')}</span>
      <span class="bucket-crumbs"></span>
    </div>
    <div class="bucket-stats">
      <span title="open tasks">${tasks.length} open</span>
      <span title="completed tasks">${completedTasks.length} done</span>
      <span title="direct associations">${directN} direct</span>
      <span title="tangent associations">${tangentN} tangent</span>
      <span title="total time spent on this project (all completed tasks) / remaining estimate on open tasks"><strong>${totalLogged.toFixed(1)}h</strong> spent${totalEst > 0 ? ` · ${totalEst.toFixed(1)}h est` : ''}</span>
    </div>
  `;
  head.querySelector('.bucket-toggle').addEventListener('click', () => {
    ui.open = !ui.open;
    saveBucketOpenKeys();
    render();
  });
  head.querySelector('.bucket-crumbs').appendChild(renderBucketCrumbs(bucket, home, view, color));

  const weekBtn = document.createElement('button');
  weekBtn.className = 'btn btn-sm';
  weekBtn.textContent = allDoneForWeek ? 'Reopen for week' : 'Done for week';
  weekBtn.addEventListener('click', () => toggleDoneForWeek(tasks, !allDoneForWeek));
  weekBtn.disabled = tasks.length === 0;
  head.appendChild(weekBtn);

  const unpin = document.createElement('button');
  unpin.className = 'btn-icon bucket-unpin';
  unpin.textContent = '\u2716';
  unpin.title = 'Unpin this project';
  unpin.addEventListener('click', async () => {
    if (!confirmAction(`Unpin "${cat}${sub ? ' / ' + sub : ''}" from dashboard?`)) return;
    await unpinBucket(cat, sub);
    render();
  });
  head.appendChild(unpin);
  box.appendChild(head);

  if (!ui.open) return box;

  // --- Open tasks section
  box.appendChild(renderBucketTasks(bucket, tasks, ui));

  // --- Completed tasks section (collapsed by default)
  if (completedTasks.length) {
    box.appendChild(renderBucketCompletedTasks(bucket, completedTasks, ui));
  }

  // --- Direct + Tangent sections (inline)
  box.appendChild(renderBucketRelated(bucket, rel, ui));

  return box;
}

function renderBucketTasks(bucket, tasks, ui) {
  const sec = document.createElement('details');
  sec.className = 'bucket-section bucket-tasks';
  sec.open = ui.tasksOpen;
  sec.addEventListener('toggle', () => { ui.tasksOpen = sec.open; });
  const summary = document.createElement('summary');
  summary.className = 'bucket-section-head';
  summary.innerHTML = `<h3>Open tasks</h3><span class="rel-count">${tasks.length}</span>`;
  sec.appendChild(summary);

  if (!tasks.length) {
    const empty = document.createElement('div');
    empty.className = 'empty-state bucket-empty';
    empty.innerHTML = `No open tasks in this project. <button class="btn btn-sm" id="add-task-in-bucket">+ Add task</button>`;
    empty.querySelector('button').addEventListener('click', () => addTaskToBucket(bucket));
    sec.appendChild(empty);
    return sec;
  }

  const list = document.createElement('div');
  list.className = 'bucket-task-list';
  for (const t of tasks) list.appendChild(renderTaskCard(t));
  sec.appendChild(list);

  const foot = document.createElement('div');
  foot.className = 'bucket-task-foot';
  const addBtn = document.createElement('button');
  addBtn.className = 'btn btn-sm';
  addBtn.textContent = '+ Add task in this project';
  addBtn.addEventListener('click', () => addTaskToBucket(bucket));
  foot.appendChild(addBtn);
  sec.appendChild(foot);
  return sec;
}

function renderBucketCompletedTasks(bucket, tasks, ui) {
  if (!ui.completedOpen) ui.completedOpen = false;
  const sec = document.createElement('details');
  sec.className = 'bucket-section bucket-completed';
  sec.open = ui.completedOpen;
  sec.addEventListener('toggle', () => { ui.completedOpen = sec.open; });
  const summary = document.createElement('summary');
  summary.className = 'bucket-section-head';
  const totalDone = tasks.reduce((s, t) => s + hoursLoggedForTask(t.id), 0);
  summary.innerHTML = `<h3>Completed</h3><span class="rel-count">${tasks.length}</span><span class="bucket-completed-hours">${totalDone.toFixed(1)}h logged</span>`;
  sec.appendChild(summary);

  const list = document.createElement('div');
  list.className = 'bucket-task-list bucket-task-list-completed';
  for (const t of tasks) list.appendChild(renderTaskCard(t));
  sec.appendChild(list);
  return sec;
}

/* Inline "Direct" + "Tangent" sections inside a bucket box. Heavy reuse of
 * the focus-view row renderers, but driven by bucket-local UI state so each
 * bucket's open/search/select state is independent. */
function renderBucketRelated(bucket, rel, ui) {
  const host = document.createElement('div');
  host.className = 'bucket-related';

  // Filter by the bucket's local search string. Re-use filterRelated from
  // the focus view (expects a {direct, tangent} shape).
  const filtered = filterRelated(rel, ui.search);

  // Drop tasks from the Direct side — those live in the Open tasks section
  // above, no need to repeat. Tangent tasks stay (they belong to other
  // projects in the same top-level category).
  filtered.direct = { ...filtered.direct, tasks: [] };

  const directN  = filtered.direct.events.length + filtered.direct.emails.length + filtered.direct.activities.length + filtered.direct.items.length;
  const tangentN = filtered.tangent.events.length + filtered.tangent.emails.length + filtered.tangent.activities.length + filtered.tangent.items.length + filtered.tangent.tasks.length;

  // Toolbar: search + bulk actions + attach target
  const tb = document.createElement('div');
  tb.className = 'bucket-rel-toolbar';
  const openTasks = openTasksInBucket(bucket.category, bucket.sub_category);
  if (!ui.attachTargetTaskId && openTasks.length) ui.attachTargetTaskId = openTasks[0].id;
  const targetSel = document.createElement('select');
  targetSel.className = 'bucket-attach-target';
  if (openTasks.length) {
    for (const t of openTasks) {
      const o = document.createElement('option');
      o.value = t.id;
      o.textContent = t.title.length > 50 ? t.title.slice(0, 50) + '…' : t.title;
      if (t.id === ui.attachTargetTaskId) o.selected = true;
      targetSel.appendChild(o);
    }
  } else {
    const o = document.createElement('option');
    o.textContent = '(no tasks in this project)';
    o.disabled = true;
    targetSel.appendChild(o);
    targetSel.disabled = true;
  }
  targetSel.addEventListener('change', () => { ui.attachTargetTaskId = targetSel.value; });
  const tLbl = document.createElement('label');
  tLbl.className = 'bucket-attach-label';
  tLbl.innerHTML = '<span class="meta-k">attach to</span>';
  tLbl.appendChild(targetSel);
  tb.appendChild(tLbl);

  const searchInput = document.createElement('input');
  searchInput.type = 'text';
  searchInput.placeholder = 'Search emails, events, activities, items\u2026';
  searchInput.value = ui.search;
  searchInput.className = 'focus-rel-search bucket-rel-search';
  searchInput.dataset.searchKey = 'bucket:' + bucketKey(bucket);
  let debounce = null;
  searchInput.addEventListener('input', () => {
    clearTimeout(debounce);
    debounce = setTimeout(() => { ui.search = searchInput.value; render(); }, 120);
  });
  tb.appendChild(searchInput);

  const selCount = ui.selected.size;
  const attachBtn = document.createElement('button');
  attachBtn.className = 'btn btn-primary btn-sm';
  attachBtn.textContent = `Attach ${selCount}`;
  attachBtn.disabled = selCount === 0 || !ui.attachTargetTaskId;
  attachBtn.addEventListener('click', () => attachSelectedInBucket(bucket, ui));
  tb.appendChild(attachBtn);

  const clearBtn = document.createElement('button');
  clearBtn.className = 'btn btn-sm';
  clearBtn.textContent = 'Clear';
  clearBtn.disabled = selCount === 0;
  clearBtn.addEventListener('click', () => { ui.selected.clear(); render(); });
  tb.appendChild(clearBtn);

  host.appendChild(tb);

  // --- Direct
  const dir = document.createElement('details');
  dir.className = 'focus-bucket focus-bucket-direct';
  dir.open = ui.directOpen;
  dir.addEventListener('toggle', () => { ui.directOpen = dir.open; });
  const dirSum = document.createElement('summary');
  dirSum.className = 'focus-bucket-head';
  dirSum.innerHTML = `<span class="focus-bucket-label">Direct <span class="meta-k">exact path</span></span><span class="rel-count">${directN}</span>`;
  dir.appendChild(dirSum);
  if (directN) appendBucketRelatedSections(dir, filtered.direct, bucket, ui, false);
  else {
    const e = document.createElement('div');
    e.className = 'empty-state'; e.style.margin = '8px 12px';
    e.textContent = ui.search ? 'No direct matches.' : 'No items tagged to this exact path yet.';
    dir.appendChild(e);
  }
  host.appendChild(dir);

  // --- Tangent
  const tan = document.createElement('details');
  tan.className = 'focus-bucket focus-bucket-tangent';
  tan.open = ui.tangentOpen;
  tan.addEventListener('toggle', () => { ui.tangentOpen = tan.open; });
  const tanSum = document.createElement('summary');
  tanSum.className = 'focus-bucket-head';
  tanSum.innerHTML = `<span class="focus-bucket-label">Tangent <span class="meta-k">same category, other paths</span></span><span class="rel-count">${tangentN}</span>`;
  tan.appendChild(tanSum);
  if (tangentN) {
    const reclassAll = document.createElement('div');
    reclassAll.className = 'bucket-reclass-all';
    const bulk = document.createElement('button');
    bulk.className = 'btn btn-sm';
    bulk.textContent = 'Reclassify all tangent \u2192 this path';
    bulk.addEventListener('click', () => reclassifyAllBucket(bucket, filtered.tangent));
    reclassAll.appendChild(bulk);
    tan.appendChild(reclassAll);
    appendBucketRelatedSections(tan, filtered.tangent, bucket, ui, /* allowReclassify */ true);
  } else {
    const e = document.createElement('div');
    e.className = 'empty-state'; e.style.margin = '8px 12px';
    e.textContent = ui.search ? 'No tangent matches.' : 'No other paths in this category.';
    tan.appendChild(e);
  }
  host.appendChild(tan);

  return host;
}

function appendBucketRelatedSections(parent, bucket, b, ui, allowReclassify) {
  const bkey = allowReclassify ? 'tangent' : 'direct';
  if (bucket.emails.length)     parent.appendChild(renderBucketSection('Emails',         bucket.emails,     'email',    b, ui, bucketEmailRow,    allowReclassify, `${bkey}:emails`));
  if (bucket.events.length)     parent.appendChild(renderBucketSection('Calendar events',bucket.events,     'event',    b, ui, bucketEventRow,    allowReclassify, `${bkey}:events`));
  if (bucket.activities.length) parent.appendChild(renderBucketSection('Past activity',  bucket.activities, 'activity', b, ui, bucketActivityRow, allowReclassify, `${bkey}:activities`));
  if (bucket.tasks.length)      parent.appendChild(renderBucketSection('Sibling tasks',  bucket.tasks,      'task',     b, ui, bucketTaskRow,     allowReclassify, `${bkey}:tasks`));
  if (bucket.items.length)      parent.appendChild(renderBucketSection('Items',          bucket.items,      'item',     b, ui, bucketItemRow,     allowReclassify, `${bkey}:items`));
}

function renderBucketSection(title, rows, type, bucket, ui, rowFn, allowReclassify, sectionKey) {
  const sec = document.createElement('details');
  sec.className = 'focus-section';
  if (ui.openSections.has(sectionKey)) sec.open = true;
  sec.addEventListener('toggle', () => {
    if (sec.open) ui.openSections.add(sectionKey);
    else ui.openSections.delete(sectionKey);
  });
  const summary = document.createElement('summary');
  summary.className = 'focus-section-head';
  summary.innerHTML = `<h4>${title}</h4><span class="rel-count">${rows.length}</span>`;
  sec.appendChild(summary);

  const list = document.createElement('ul');
  list.className = 'focus-list';
  const showAllKey = 'showAll:' + sectionKey;
  const cap = ui.openSections.has(showAllKey) ? rows.length : FOCUS_SECTION_LIMIT;
  const slice = rows.slice(0, cap);
  for (const x of slice) list.appendChild(rowFn(x, type, bucket, ui, allowReclassify));
  if (rows.length > cap) {
    const more = document.createElement('li');
    more.className = 'focus-more';
    more.innerHTML = `<button class="btn btn-sm">Show ${rows.length - cap} more</button>`;
    more.querySelector('button').addEventListener('click', (ev) => {
      ev.stopPropagation();
      ui.openSections.add(showAllKey);
      render();
    });
    list.appendChild(more);
  }
  sec.appendChild(list);
  return sec;
}

function bucketRowShell(type, id, bucket, ui, headerHtml, bodyFn, extraFooterFn, record, allowReclassify) {
  const li = document.createElement('li');
  li.className = 'focus-row';
  const attachable = !!id && !['activity','task'].includes(type);
  // "Attached" means the item is already in the target task's evidence.
  const targetTask = (DASH.inbox?.tasks || []).find(t => t.id === ui.attachTargetTaskId);
  const attached = attachable && targetTask && isAlreadyAttached(targetTask, type, id);
  const rowId = selKey(type, id || '-');
  const selected = ui.selected.has(rowId);
  const expanded = ui.expandedRows.has(rowId);
  if (selected) li.classList.add('selected');
  if (expanded) li.classList.add('expanded');

  const cb = document.createElement('input');
  cb.type = 'checkbox';
  cb.disabled = !attachable || attached;
  cb.checked = attached || selected;
  cb.title = attached ? 'Already attached' : (attachable ? 'Select to attach' : 'Not attachable');
  cb.addEventListener('click', (ev) => ev.stopPropagation());
  cb.addEventListener('change', () => {
    if (cb.checked) ui.selected.add(rowId);
    else ui.selected.delete(rowId);
    render();
  });
  li.appendChild(cb);

  const hd = document.createElement('div');
  hd.className = 'focus-row-head';
  hd.innerHTML = headerHtml;
  hd.addEventListener('click', () => {
    if (expanded) ui.expandedRows.delete(rowId); else ui.expandedRows.add(rowId);
    render();
  });
  li.appendChild(hd);

  const badges = document.createElement('span');
  badges.className = 'focus-row-badges';
  if (attached) {
    const chip = document.createElement('span');
    chip.className = 'focus-attached-chip';
    chip.textContent = 'attached';
    badges.appendChild(chip);
  }
  if (allowReclassify && id && record) {
    const btn = document.createElement('button');
    btn.className = 'btn-icon focus-reclass-btn';
    btn.textContent = '\u21aa';
    const tgtPath = [bucket.category || '', bucket.sub_category || ''].filter(Boolean).join(':');
    btn.title = `Reclassify this ${type} to ${tgtPath}`;
    btn.addEventListener('click', (ev) => {
      ev.stopPropagation();
      reclassifyOneBucket(bucket, type, record);
    });
    badges.appendChild(btn);
  }
  li.appendChild(badges);

  if (expanded) {
    const body = document.createElement('div');
    body.className = 'focus-row-body';
    if (bodyFn) body.innerHTML = bodyFn();
    if (extraFooterFn) {
      const footer = extraFooterFn();
      if (footer) body.appendChild(footer);
    }
    li.appendChild(body);
  }
  return li;
}

/* ---------- inline email detail expander ----------
 * Replaces the old "Open full email \u2197" link that kicked the user over to
 * the email-review page. Loads body + attachments on demand via /api/email
 * and renders them in place so the activity bucket stays in context. */

async function fetchEmailDetail(e) {
  DASH.emailDetailCache = DASH.emailDetailCache || {};
  if (e.id && DASH.emailDetailCache[e.id]) return DASH.emailDetailCache[e.id];
  let path = e.path;
  if (!path) {
    // year_review rows strip the path field — back-fill by scanning by_year.
    try {
      const idx = await api.load('email_archive/summary.json');
      for (const y of (idx.summary?.years || [])) {
        const doc = await api.load(`email_archive/by_year/${y}.json`);
        const hit = (doc.emails || []).find(x => x.id === e.id);
        if (hit && hit.path) { path = hit.path; break; }
      }
    } catch {}
  }
  if (!path) throw new Error('email path not found');
  const res = await fetch(`/api/email?path=${encodeURIComponent(path)}`);
  if (!res.ok) throw new Error(`fetch failed (${res.status})`);
  const detail = await res.json();
  if (e.id) DASH.emailDetailCache[e.id] = detail;
  return detail;
}

function renderEmailDetailInto(container, detail) {
  container.innerHTML = '';
  const meta = document.createElement('div');
  meta.style.cssText = 'font-size:12px;color:var(--text-muted,#6b7280);margin:8px 0 4px';
  meta.textContent = [detail.from || '', detail.to || '', detail.date || ''].filter(Boolean).join(' \u00b7 ');
  container.appendChild(meta);
  const body = document.createElement('pre');
  body.style.cssText = 'white-space:pre-wrap;background:var(--surface-2,#fafafa);border:1px solid var(--border,#e5e7eb);border-radius:6px;padding:10px;font-family:ui-monospace,SFMono-Regular,Menlo,Monaco,monospace;font-size:12px;max-height:50vh;overflow:auto;margin:0';
  body.textContent = detail.body_text || '(empty)';
  container.appendChild(body);
  const atts = detail.attachments || [];
  if (atts.length) {
    const list = document.createElement('div');
    list.style.cssText = 'margin-top:8px;font-size:12px;display:flex;flex-wrap:wrap;gap:8px 14px;align-items:center';
    const label = document.createElement('span');
    label.style.cssText = 'color:var(--text-muted,#6b7280)';
    label.textContent = `Attachments (${atts.length}):`;
    list.appendChild(label);
    atts.forEach(a => {
      const link = document.createElement('a');
      link.href = a.url;
      link.target = '_blank';
      link.rel = 'noopener';
      if (a.filename) link.setAttribute('download', a.filename);
      const size = a.size_bytes ? ` (${S.fmtBytes(a.size_bytes)})` : '';
      link.textContent = `\u2B73 ${a.filename || 'file'}${size}`;
      list.appendChild(link);
    });
    container.appendChild(list);
  }
}

function makeEmailDetailFooter(e) {
  const wrap = document.createElement('div');
  wrap.className = 'focus-email-detail';
  wrap.style.cssText = 'margin-top:6px';
  // If we've already cached this email's detail (user expanded it before),
  // render straight away rather than re-showing the button.
  const cached = DASH.emailDetailCache && e.id && DASH.emailDetailCache[e.id];
  if (cached) {
    renderEmailDetailInto(wrap, cached);
    return wrap;
  }
  const btn = document.createElement('button');
  btn.className = 'btn btn-sm';
  btn.type = 'button';
  btn.textContent = 'Load full email \u2193';
  btn.addEventListener('click', async (ev) => {
    ev.stopPropagation();
    btn.disabled = true;
    btn.textContent = 'Loading\u2026';
    try {
      const detail = await fetchEmailDetail(e);
      renderEmailDetailInto(wrap, detail);
    } catch (err) {
      btn.disabled = false;
      btn.textContent = 'Load full email \u2193';
      const msg = document.createElement('div');
      msg.style.cssText = 'color:#b91c1c;font-size:12px;margin-top:6px';
      msg.textContent = 'Failed: ' + (err.message || err);
      wrap.appendChild(msg);
    }
  });
  wrap.appendChild(btn);
  return wrap;
}

function bucketEmailRow(e, type, bucket, ui, allowReclassify) {
  const when = (e.date || '').slice(0, 16).replace('T', ' ');
  const from = Array.isArray(e.from) ? (e.from[0]?.name || e.from[0]?.email || '') : (e.from || '');
  const header = `
    <span class="rel-date">${S.escapeHtml(when)}</span>
    <span class="rel-title"><strong>${S.escapeHtml(e.subject || '(no subject)')}</strong></span>
    <span class="rel-meta">${S.escapeHtml(from)}${e._sub ? ' · ' + S.escapeHtml(e._sub) : ''}</span>
  `;
  const body = () => `
    <div class="focus-body-grid">
      <div><span class="meta-k">id</span> <code>${S.escapeHtml(e.id || '')}</code></div>
      <div><span class="meta-k">from</span> ${S.escapeHtml(from)}</div>
      ${e.activity_type ? `<div><span class="meta-k">type</span> ${S.escapeHtml(e.activity_type)}</div>` : ''}
    </div>
  `;
  const footer = () => makeEmailDetailFooter(e);
  return bucketRowShell('email', e.id, bucket, ui, header, body, footer, e, allowReclassify);
}

function bucketEventRow(e, type, bucket, ui, allowReclassify) {
  const when = (e.start || '').slice(0, 16).replace('T', ' ');
  const dur = e.duration_min ? `${Math.round(e.duration_min)}min` : '';
  const header = `
    <span class="rel-date">${S.escapeHtml(when)}</span>
    <span class="rel-title"><strong>${S.escapeHtml(e.title || '')}</strong></span>
    <span class="rel-meta">${dur}${e._sub ? ' · ' + S.escapeHtml(e._sub) : ''}</span>
  `;
  const body = () => `
    <div class="focus-body-grid">
      <div><span class="meta-k">start</span> ${S.escapeHtml(e.start || '')}</div>
      <div><span class="meta-k">end</span> ${S.escapeHtml(e.end || '')}</div>
      ${e.location ? `<div><span class="meta-k">location</span> ${S.escapeHtml(e.location)}</div>` : ''}
    </div>
    ${e.description ? `<div class="focus-desc-block">${S.escapeHtml(e.description)}</div>` : ''}
  `;
  return bucketRowShell('event', e.id, bucket, ui, header, body, null, e, allowReclassify);
}

function bucketActivityRow(a, type, bucket, ui, allowReclassify) {
  const when = (a.completed_at || '').slice(0, 10);
  const hrs = a.hours ? `${a.hours.toFixed(2)}h` : '';
  const header = `
    <span class="rel-date">${S.escapeHtml(when)}</span>
    <span class="rel-title"><strong>${S.escapeHtml(a.title || '')}</strong></span>
    <span class="rel-meta">${hrs}${a._sub ? ' · ' + S.escapeHtml(a._sub) : ''}</span>
  `;
  const body = () => `
    <div class="focus-body-grid">
      <div><span class="meta-k">id</span> <code>${S.escapeHtml(a.id || '')}</code></div>
      <div><span class="meta-k">from_task</span> <code>${S.escapeHtml(a.from_task_id || '')}</code></div>
    </div>
    ${a.description ? `<div class="focus-desc-block">${S.escapeHtml(a.description)}</div>` : ''}
    ${a.notes ? `<div class="focus-desc-block">${S.escapeHtml(a.notes)}</div>` : ''}
  `;
  return bucketRowShell('activity', a.id, bucket, ui, header, body, null, a, allowReclassify);
}

function bucketTaskRow(t, type, bucket, ui, allowReclassify) {
  const pin = t.pinned ? '\ud83d\udccc ' : '';
  const header = `
    <span class="rel-date">${S.escapeHtml(t.status || '')}</span>
    <span class="rel-title">${pin}${S.escapeHtml(t.title || '')}</span>
    <span class="rel-meta">${S.escapeHtml(t.sub_category || '')}</span>
  `;
  const body = () => `
    <div class="focus-body-grid">
      <div><span class="meta-k">status</span> ${S.escapeHtml(t.status || '')}</div>
      <div><span class="meta-k">hours_est</span> ${t.hours_estimate || '\u2014'}</div>
      <div><span class="meta-k">due</span> ${S.escapeHtml(t.due_date || 'TBD')}</div>
    </div>
    ${t.description ? `<div class="focus-desc-block">${S.escapeHtml(t.description)}</div>` : ''}
  `;
  const footer = () => {
    const w = document.createElement('div');
    w.className = 'focus-body-link';
    const open = document.createElement('a');
    open.href = 'javascript:void(0)';
    open.textContent = 'Focus this task \u2197';
    open.addEventListener('click', (ev) => { ev.stopPropagation(); enterFocus(t.id); });
    w.appendChild(open);
    return w;
  };
  return bucketRowShell('task', t.id, bucket, ui, header, body, footer, t, allowReclassify);
}

function bucketItemRow(it, type, bucket, ui, allowReclassify) {
  const header = `
    <span class="rel-date">${S.escapeHtml(it.type || '')}</span>
    <span class="rel-title">${S.escapeHtml(it.title || it.id || '')}</span>
    <span class="rel-meta">${S.escapeHtml(it.status || '')}</span>
  `;
  const body = () => `
    <div class="focus-body-grid">
      <div><span class="meta-k">id</span> <code>${S.escapeHtml(it.id || '')}</code></div>
      <div><span class="meta-k">type</span> ${S.escapeHtml(it.type || '')}</div>
      <div><span class="meta-k">status</span> ${S.escapeHtml(it.status || '')}</div>
    </div>
  `;
  return bucketRowShell('item', it.id, bucket, ui, header, body, null, it, allowReclassify);
}

async function attachSelectedInBucket(bucket, ui) {
  if (!ui.selected.size || !ui.attachTargetTaskId) return;
  const t = DASH.inbox.tasks.find(x => x.id === ui.attachTargetTaskId);
  if (!t) return;
  t.evidence = t.evidence || { email_ids: [], event_ids: [], item_ids: [] };
  t.evidence.email_ids = t.evidence.email_ids || [];
  t.evidence.event_ids = t.evidence.event_ids || [];
  t.evidence.item_ids  = t.evidence.item_ids  || [];
  for (const key of ui.selected) {
    const [type, id] = key.split(':');
    if (!id) continue;
    if (type === 'email' && !t.evidence.email_ids.includes(id)) t.evidence.email_ids.push(id);
    if (type === 'event' && !t.evidence.event_ids.includes(id)) t.evidence.event_ids.push(id);
    if (type === 'item'  && !t.evidence.item_ids .includes(id)) t.evidence.item_ids.push(id);
  }
  t.user_edited = true;
  await saveInbox();
  ui.selected.clear();
  render();
}

async function reclassifyOneBucket(bucket, type, record) {
  if (!record?.id) return;
  const effSub = bucketEffectiveSub(bucket);
  const tgt = [bucket.category || '', effSub].filter(Boolean).join(':');
  if (!confirmAction(`Reclassify this ${type} to "${tgt}"?`)) return;
  try {
    await _reclassifyCore({ category: bucket.category, sub_category: effSub }, type, record);
    await loadAll();
    render();
  } catch (e) {
    alert('Reclassify failed: ' + (e?.message || e));
  }
}

async function reclassifyAllBucket(bucket, tangent) {
  const all = [
    ...tangent.emails.map(e => ({ type: 'email', record: e })),
    ...tangent.events.map(e => ({ type: 'event', record: e })),
    ...tangent.activities.map(a => ({ type: 'activity', record: a })),
    ...tangent.items.map(i => ({ type: 'item', record: i })),
    ...tangent.tasks.map(t => ({ type: 'task', record: t })),
  ].filter(x => x.record?.id);
  if (!all.length) return;
  const effSub = bucketEffectiveSub(bucket);
  const tgt = [bucket.category || '', effSub].filter(Boolean).join(':');
  if (!confirmAction(`Reclassify ${all.length} tangent items into "${tgt}"? This rewrites their category/sub_category.`)) return;
  let ok = 0, fail = 0;
  const taskRef = { category: bucket.category, sub_category: effSub };
  for (const { type, record } of all) {
    try { await _reclassifyCore(taskRef, type, record); ok++; } catch { fail++; }
  }
  await loadAll();
  render();
  if (fail) alert(`Reclassified ${ok}, failed ${fail}.`);
}

async function addTaskToBucket(bucket) {
  const effSub = bucketEffectiveSub(bucket);
  const scope = `${bucket.category || 'unknown'}${effSub ? ' / ' + effSub : ''}`;
  const { title, dueDate } = await promptNewTask(scope);
  if (!title) return;
  const now = new Date().toISOString();
  const id = `tsk-${now.slice(0,10)}-${Math.random().toString(36).slice(2,8)}`;
  const t = {
    id, source: 'manual', status: 'active',
    title, description: '', due_date: dueDate || 'TBD',
    priority: 'normal',
    category: bucket.category || 'unknown',
    sub_category: effSub,
    evidence: { email_ids: [], event_ids: [], item_ids: [] },
    confidence: 1.0, user_edited: true,
    notes: '', hours_estimate: null, tracker_entry_id: null,
    evidence_hash: `manual-${Math.random().toString(36).slice(2,8)}`,
    created_at: now, decided_at: now,
    snoozed_until: null, completed_at: null,
  };
  DASH.inbox.tasks.push(t);
  await saveInbox();
  render();
}

function promptNewTask(scope) {
  return new Promise((resolve) => {
    const back = document.createElement('div');
    back.style.cssText = 'position:fixed;inset:0;background:rgba(0,0,0,.4);z-index:95;display:flex;align-items:center;justify-content:center';
    const panel = document.createElement('div');
    panel.style.cssText = 'background:#fff;border-radius:10px;min-width:420px;max-width:520px;padding:18px 22px;box-shadow:0 20px 40px rgba(0,0,0,.25)';
    panel.innerHTML = `
      <h3 style="margin:0 0 4px 0;font-size:15px">New task</h3>
      <div style="font-size:12px;color:#6b7280;margin-bottom:12px">in "${S.escapeHtml(scope)}"</div>
      <div style="display:flex;flex-direction:column;gap:10px;margin-bottom:14px">
        <label style="display:flex;flex-direction:column;gap:4px;font-size:11px;color:#374151;text-transform:uppercase;letter-spacing:.4px">
          Title
          <input type="text" data-k="title" style="font-size:13px;padding:6px 8px;border:1px solid #d1d5db;border-radius:4px;text-transform:none;letter-spacing:0;color:#111">
        </label>
        <label style="display:flex;flex-direction:column;gap:4px;font-size:11px;color:#374151;text-transform:uppercase;letter-spacing:.4px">
          Due date (optional)
          <input type="date" data-k="due" style="font-size:13px;padding:6px 8px;border:1px solid #d1d5db;border-radius:4px;text-transform:none;letter-spacing:0;color:#111">
        </label>
      </div>
      <div style="display:flex;gap:8px;justify-content:flex-end">
        <button class="btn" data-k="cancel">Cancel</button>
        <button class="btn btn-primary" data-k="confirm">Create</button>
      </div>
    `;
    back.appendChild(panel);
    document.body.appendChild(back);

    const titleInput = panel.querySelector('[data-k="title"]');
    const dueInput = panel.querySelector('[data-k="due"]');
    const close = (result) => {
      if (back.parentNode) document.body.removeChild(back);
      resolve(result);
    };
    const submit = () => {
      const title = titleInput.value.trim();
      if (!title) { titleInput.focus(); return; }
      close({ title, dueDate: dueInput.value || '' });
    };
    panel.querySelector('[data-k="cancel"]').addEventListener('click', () => close({ title: '', dueDate: '' }));
    panel.querySelector('[data-k="confirm"]').addEventListener('click', submit);
    titleInput.addEventListener('keydown', (ev) => { if (ev.key === 'Enter') { ev.preventDefault(); submit(); } });
    dueInput.addEventListener('keydown', (ev) => { if (ev.key === 'Enter') { ev.preventDefault(); submit(); } });
    safeCloseOnBackdrop(back, panel, () => close({ title: '', dueDate: '' }));
    setTimeout(() => titleInput.focus(), 0);
  });
}

function renderTaskCard(task) {
  const card = document.createElement('div');
  card.className = 'pin-card';
  const isCompleted = task.status === 'completed';
  if (isCompleted) card.classList.add('completed');
  const expanded = DASH.expanded.has(task.id);
  if (expanded) card.classList.add('expanded');

  const pri = derivePriority(task);
  const sty = PRIORITY_FLAG_STYLE[pri.flag] || PRIORITY_FLAG_STYLE['unscheduled'];

  // header row
  const row = document.createElement('div');
  row.className = 'pin-card-row';

  const expander = document.createElement('button');
  expander.className = 'pin-expand';
  expander.textContent = expanded ? '\u25BE' : '\u25B8';
  expander.title = 'Toggle inline preview';
  expander.addEventListener('click', (ev) => {
    ev.stopPropagation();
    if (expanded) DASH.expanded.delete(task.id); else DASH.expanded.add(task.id);
    render();
  });

  const title = document.createElement('span');
  title.className = 'pin-title';
  if (isCompleted) title.style.textDecoration = 'line-through';
  // Disposition glyph: most-severe among the task's linked emails.
  const dispVal = (window.DISPOSITION && DASH.dispositionMap)
    ? window.DISPOSITION.bestForEmails(task.evidence?.email_ids || [], DASH.dispositionMap)
    : null;
  if (dispVal) {
    const span = document.createElement('span');
    span.innerHTML = window.DISPOSITION.glyph(dispVal, { size: 11 });
    title.appendChild(span);
  }
  title.appendChild(document.createTextNode(task.title || ''));
  title.title = 'Open focused view';
  title.addEventListener('click', () => enterFocus(task.id));

  row.appendChild(expander);
  row.appendChild(title);

  if (isCompleted) {
    // Completed task: show logged hours, completion date, and an Undo button.
    const loggedH = hoursLoggedForTask(task.id);
    const when = (task.completed_at || '').slice(0, 10);
    const meta = document.createElement('span');
    meta.className = 'pin-meta-inline';
    meta.textContent = `${loggedH.toFixed(1)}h \u00b7 ${when}`;
    row.appendChild(meta);

    const undo = document.createElement('button');
    undo.className = 'btn btn-sm';
    undo.textContent = 'Undo';
    undo.title = 'Move back to open tasks';
    undo.addEventListener('click', (ev) => { ev.stopPropagation(); uncompleteTask(task); });
    row.appendChild(undo);
  } else {
    // Open task: inline hours input + Complete button (no popup prompt).
    const flag = document.createElement('span');
    flag.className = 'priority-chip';
    flag.style.background = sty.bg;
    flag.style.color = sty.fg;
    flag.title = pri.label;
    flag.textContent = `${sty.icon} ${pri.flag.replace('-', ' ')}`;

    const stars = S.starBar(task.importance || 0, (v) => setImportance(task, v), 12);

    const hoursWrap = document.createElement('span');
    hoursWrap.className = 'pin-hours-wrap';
    hoursWrap.title = 'Hours spent on this task (0 logs 5 min of quick-hit work)';
    const hoursInput = document.createElement('input');
    hoursInput.type = 'number';
    hoursInput.min = '0';
    hoursInput.step = '0.25';
    hoursInput.className = 'pin-hours-input';
    hoursInput.value = '0';
    hoursInput.placeholder = '0';
    // Keep the click from toggling the expander or opening focus view.
    hoursInput.addEventListener('click', (ev) => ev.stopPropagation());
    // Enter submits completion.
    hoursInput.addEventListener('keydown', (ev) => {
      if (ev.key === 'Enter') { ev.preventDefault(); completeBtn.click(); }
    });
    hoursWrap.appendChild(hoursInput);
    const hoursUnit = document.createElement('span');
    hoursUnit.className = 'pin-hours-unit';
    hoursUnit.textContent = 'h';
    hoursWrap.appendChild(hoursUnit);

    const completeBtn = document.createElement('button');
    completeBtn.className = 'btn btn-sm btn-primary';
    completeBtn.textContent = 'Complete';
    completeBtn.title = 'Mark complete with the hours shown (0 = 5 min quick-hit)';
    completeBtn.addEventListener('click', (ev) => {
      ev.stopPropagation();
      // Default/0 = a quick 5-minute hit so one-click completions still log
      // something. The server rejects <= 0 hours, so we map it here.
      const raw = Number(hoursInput.value);
      const h = (!raw || raw <= 0) ? QUICK_HIT_HOURS : raw;
      completeTask(task, h);
    });

    const unpin = document.createElement('button');
    unpin.className = 'btn-icon';
    unpin.title = 'Unpin';
    unpin.textContent = '\u2716';
    unpin.addEventListener('click', () => setPinned(task, false));

    row.appendChild(flag);
    row.appendChild(stars);
    row.appendChild(hoursWrap);
    row.appendChild(completeBtn);
    row.appendChild(unpin);
  }
  card.appendChild(row);

  if (expanded) {
    const body = document.createElement('div');
    body.className = 'pin-card-body';

    if (task.description) {
      const p = document.createElement('p');
      p.className = 'pin-desc';
      p.textContent = task.description;
      body.appendChild(p);
    }

    const meta = document.createElement('div');
    meta.className = 'pin-meta-grid';
    const est = task.hours_estimate ? `${task.hours_estimate}h` : '\u2014';
    const logged = hoursLoggedForTask(task.id).toFixed(1) + 'h';
    const booked = (task.time_booked || []).reduce((s, b) => s + (b.hours || 0), 0);

    const dueCell = document.createElement('div');
    const dueKey = document.createElement('span');
    dueKey.className = 'meta-k';
    dueKey.textContent = 'due';
    dueCell.appendChild(dueKey);
    dueCell.appendChild(document.createTextNode(' '));
    if (isCompleted) {
      dueCell.appendChild(document.createTextNode(
        (task.due_date && task.due_date !== 'TBD') ? task.due_date : 'TBD'
      ));
    } else {
      const dueInput = document.createElement('input');
      dueInput.type = 'date';
      dueInput.value = (task.due_date && task.due_date !== 'TBD') ? task.due_date : '';
      dueInput.style.cssText = 'font-size:12px;padding:1px 4px;border:1px solid #d1d5db;border-radius:3px';
      dueInput.title = 'Due date (blank = TBD)';
      dueInput.addEventListener('click', (ev) => ev.stopPropagation());
      dueInput.addEventListener('change', async () => {
        task.due_date = dueInput.value || 'TBD';
        task.user_edited = true;
        await saveInbox();
        render();
      });
      dueCell.appendChild(dueInput);
    }
    meta.appendChild(dueCell);

    meta.insertAdjacentHTML('beforeend', `
      <div><span class="meta-k">estimate</span> ${est}</div>
      <div><span class="meta-k">logged</span> ${logged}</div>
      <div><span class="meta-k">booked</span> ${booked.toFixed(1)}h</div>
    `);
    body.appendChild(meta);

    if ((task.time_booked || []).length) {
      const bk = document.createElement('ul');
      bk.className = 'booked-list';
      for (const b of task.time_booked) {
        const li = document.createElement('li');
        li.textContent = `${b.date} — ${b.hours}h${b.note ? ' · ' + b.note : ''}`;
        bk.appendChild(li);
      }
      body.appendChild(bk);
    }

    const btns = document.createElement('div');
    btns.className = 'pin-card-btns';
    if (!isCompleted) {
      const bookBtn = document.createElement('button');
      bookBtn.className = 'btn btn-sm';
      bookBtn.textContent = 'Book time';
      bookBtn.addEventListener('click', () => openBookTime(task));
      const estBtn = document.createElement('button');
      estBtn.className = 'btn btn-sm';
      estBtn.textContent = task.hours_estimate ? `Estimate: ${task.hours_estimate}h` : 'Set estimate';
      estBtn.addEventListener('click', () => openSetEstimate(task));
      const finalBtn = document.createElement('button');
      finalBtn.className = 'btn btn-sm';
      finalBtn.textContent = 'Finalize';
      finalBtn.title = 'Mark task fully complete and archive';
      finalBtn.addEventListener('click', () => finalizeTask(task));
      btns.appendChild(bookBtn);
      btns.appendChild(estBtn);
      btns.appendChild(finalBtn);
    } else {
      const undoBtn = document.createElement('button');
      undoBtn.className = 'btn btn-sm';
      undoBtn.textContent = 'Mark not complete';
      undoBtn.title = 'Move back to open tasks and drop its ledger record';
      undoBtn.addEventListener('click', () => uncompleteTask(task));
      btns.appendChild(undoBtn);
    }
    body.appendChild(btns);

    const related = renderRelatedPanel(task);
    if (related) body.appendChild(related);

    card.appendChild(body);
  }
  return card;
}

/* ---------- related-items panel ---------- */

function renderRelatedPanel(task) {
  const r = relatedForTask(task).direct;
  const totalRelated = r.events.length + r.emails.length + r.activities.length + r.items.length + r.tasks.length;
  if (!totalRelated) return null;
  const wrap = document.createElement('div');
  wrap.className = 'rel-panel';
  const subLabel = task.sub_category ? `${task.category || '?'} / ${task.sub_category}` : (task.category || '?');
  const heading = document.createElement('div');
  heading.className = 'rel-heading';
  heading.innerHTML = `<span class="meta-k">Related in</span> <strong>${S.escapeHtml(subLabel)}</strong> <span class="rel-count">${totalRelated}</span>`;
  wrap.appendChild(heading);

  const LIMIT = 6;
  if (r.events.length)     wrap.appendChild(renderRelSection('Calendar events', r.events, LIMIT, relEventRow));
  if (r.emails.length)     wrap.appendChild(renderRelSection('Emails',          r.emails, LIMIT, relEmailRow));
  if (r.activities.length) wrap.appendChild(renderRelSection('Past activity',   r.activities, LIMIT, relActivityRow));
  if (r.tasks.length)      wrap.appendChild(renderRelSection('Sibling tasks',   r.tasks, LIMIT, relTaskRow));
  if (r.items.length)      wrap.appendChild(renderRelSection('Items',           r.items, LIMIT, relItemRow));
  return wrap;
}

function renderRelSection(title, rows, limit, rowFn) {
  const sec = document.createElement('details');
  sec.className = 'rel-section';
  const summary = document.createElement('summary');
  summary.innerHTML = `<span>${title}</span> <span class="rel-count">${rows.length}</span>`;
  sec.appendChild(summary);
  const list = document.createElement('ul');
  list.className = 'rel-list';
  for (const x of rows.slice(0, limit)) list.appendChild(rowFn(x));
  if (rows.length > limit) {
    const more = document.createElement('li');
    more.className = 'rel-more';
    more.textContent = `+${rows.length - limit} more`;
    list.appendChild(more);
  }
  sec.appendChild(list);
  return sec;
}

function relEventRow(e) {
  const li = document.createElement('li');
  li.className = 'rel-row';
  const when = (e.start || '').slice(0, 10);
  const dur = e.duration_min ? ` · ${Math.round(e.duration_min)}min` : '';
  li.innerHTML = `<span class="rel-date">${S.escapeHtml(when)}</span><span class="rel-title">${S.escapeHtml(e.title || '')}</span><span class="rel-meta">${dur}${e._sub ? ' · ' + S.escapeHtml(e._sub) : ''}</span>`;
  return li;
}
function relEmailRow(e) {
  const li = document.createElement('li');
  li.className = 'rel-row';
  const when = (e.date || '').slice(0, 10);
  const from = Array.isArray(e.from) ? (e.from[0]?.name || e.from[0]?.email || '') : (e.from || '');
  li.innerHTML = `<span class="rel-date">${S.escapeHtml(when)}</span><span class="rel-title">${S.escapeHtml(e.subject || '(no subject)')}</span><span class="rel-meta">${S.escapeHtml(from)}</span>`;
  return li;
}
function relActivityRow(a) {
  const li = document.createElement('li');
  li.className = 'rel-row';
  const when = (a.completed_at || '').slice(0, 10);
  const hrs = a.hours ? `${a.hours.toFixed(2)}h` : '';
  li.innerHTML = `<span class="rel-date">${S.escapeHtml(when)}</span><span class="rel-title">${S.escapeHtml(a.title || '')}</span><span class="rel-meta">${hrs}${a._sub ? ' · ' + S.escapeHtml(a._sub) : ''}</span>`;
  return li;
}
function relTaskRow(t) {
  const li = document.createElement('li');
  li.className = 'rel-row';
  const pin = t.pinned ? '\ud83d\udccc ' : '';
  li.innerHTML = `<span class="rel-date">${S.escapeHtml(t.status || '')}</span><span class="rel-title">${pin}${S.escapeHtml(t.title || '')}</span><span class="rel-meta">${S.escapeHtml(t.sub_category || '')}</span>`;
  return li;
}
function relItemRow(it) {
  const li = document.createElement('li');
  li.className = 'rel-row';
  li.innerHTML = `<span class="rel-date">${S.escapeHtml(it.type || '')}</span><span class="rel-title">${S.escapeHtml(it.title || it.id || '')}</span><span class="rel-meta">${S.escapeHtml(it.status || '')}</span>`;
  return li;
}

/* ---------- task mutations ---------- */

/* Pin is now bucket-level. This helper flips the bucket membership for the
 * task's (category, sub_category) path. The legacy `task.pinned` flag stays
 * for back-compat with older code paths but isn't used for visibility. */
async function setPinned(task, value) {
  const cat = task.category || '';
  const sub = task.sub_category || '';
  if (value) await pinBucket(cat, sub);
  else       await unpinBucket(cat, sub);
  render();
}

async function setImportance(task, value) {
  const t = DASH.inbox.tasks.find(x => x.id === task.id);
  if (!t) return;
  t.importance = value;
  t.user_edited = true;
  await saveInbox();
  render();
}

async function toggleDoneForWeek(tasks, done) {
  const week = done ? currentIsoWeek() : null;
  for (const x of tasks) {
    const t = DASH.inbox.tasks.find(y => y.id === x.id);
    if (t) t.weekly_done = week;
  }
  await saveInbox();
  render();
}

function openBookTime(task) {
  openForm({
    title: 'Book time for: ' + (task.title || ''),
    fields: [
      { key: 'date', label: 'Date (YYYY-MM-DD)', type: 'text', required: true, value: S.todayStr() },
      { key: 'hours', label: 'Hours', type: 'number', required: true },
      { key: 'note', label: 'Note', type: 'text' },
    ],
    onSave: async (vals) => {
      const t = DASH.inbox.tasks.find(x => x.id === task.id);
      if (!t) return;
      t.time_booked = t.time_booked || [];
      t.time_booked.push({ date: vals.date, hours: Number(vals.hours) || 0, note: vals.note || '' });
      t.user_edited = true;
      await saveInbox();
      render();
    },
  });
}

function openSetEstimate(task) {
  openForm({
    title: 'Hours estimate',
    fields: [{ key: 'hours_estimate', label: 'Hours', type: 'number', required: true, value: task.hours_estimate || '' }],
    onSave: async (vals) => {
      const t = DASH.inbox.tasks.find(x => x.id === task.id);
      if (!t) return;
      t.hours_estimate = Number(vals.hours_estimate) || 0;
      t.user_edited = true;
      await saveInbox();
      render();
    },
  });
}

async function completeTask(task, hours) {
  // Callers pass hours explicitly (from the inline input). If omitted (legacy
  // call sites), fall back to the task's estimate. Empty/zero maps to a
  // 5-minute quick-hit so the ledger always gets a non-zero entry.
  const raw = Number(hours ?? task.hours_estimate ?? 0);
  const h = (!raw || raw <= 0) ? QUICK_HIT_HOURS : raw;
  try {
    const res = await fetch('/api/complete-task', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ task_id: task.id, hours_estimate: h }),
    });
    const j = await res.json();
    if (!j.ok) { alert('complete failed: ' + (j.error || '')); return; }
  } catch (e) { alert('complete failed: ' + e.message); return; }
  await loadAll();
  render();
}

async function uncompleteTask(task) {
  try {
    const res = await fetch('/api/uncomplete-task', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ task_id: task.id }),
    });
    const j = await res.json();
    if (!j.ok) { alert('undo failed: ' + (j.error || '')); return; }
  } catch (e) { alert('undo failed: ' + e.message); return; }
  await loadAll();
  render();
}

async function finalizeTask(task) {
  if (!confirmAction(`Finalize "${task.title}"? This marks the task done and archives it.`)) return;
  const hours = Number(prompt('Total hours spent?', task.hours_estimate || 1));
  if (!hours || hours <= 0) return;
  try {
    const res = await fetch('/api/complete-task', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ task_id: task.id, hours_estimate: hours }),
    });
    const j = await res.json();
    if (!j.ok) { alert('finalize failed: ' + (j.error || '')); return; }
  } catch (e) { alert('finalize failed: ' + e.message); return; }
  const t = DASH.inbox.tasks.find(x => x.id === task.id);
  if (t) {
    t.finalized_at = new Date().toISOString();
    t.pinned = false;
    await saveInbox();
  }
  await loadAll();
  render();
}

/* ---------- focus view ----------
 *
 * Full-width view for a single pinned task. Surfaces every related item from
 * the (category, sub_category) hierarchy with selection checkboxes so the
 * user can attach any of them to this task's evidence in one shot. Items
 * already attached render as "attached" and can't be re-selected.
 */

function selKey(type, id) { return `${type}:${id}`; }

function isAlreadyAttached(task, type, id) {
  const ev = task.evidence || {};
  if (type === 'email') return (ev.email_ids || []).includes(id);
  if (type === 'event') return (ev.event_ids || []).includes(id);
  if (type === 'item')  return (ev.item_ids  || []).includes(id);
  return false;
}

function renderFocus(task) {
  const wrap = document.createElement('div');
  wrap.className = 'focus-view';

  wrap.appendChild(renderFocusHeader(task));
  wrap.appendChild(renderFocusTaskPanel(task));
  wrap.appendChild(renderFocusRelated(task));
  wrap.appendChild(renderFocusActionBar(task));
  return wrap;
}

function renderFocusHeader(task) {
  const header = document.createElement('div');
  header.className = 'focus-header';
  const color = CAT_COLOR[task.category || 'unknown'] || '#6b7280';
  header.style.borderLeft = `6px solid ${color}`;
  const pri = derivePriority(task);
  const sty = PRIORITY_FLAG_STYLE[pri.flag] || PRIORITY_FLAG_STYLE['unscheduled'];

  const back = document.createElement('button');
  back.className = 'btn btn-sm focus-back';
  back.textContent = '\u2190 Back to dashboard';
  back.addEventListener('click', exitFocus);
  header.appendChild(back);

  const titleWrap = document.createElement('div');
  titleWrap.className = 'focus-title-wrap';
  const path = [task.category || '?', task.sub_category || ''].filter(Boolean).join(' / ');
  titleWrap.innerHTML = `
    <div class="focus-breadcrumb">${S.escapeHtml(path)}</div>
    <h2 class="focus-title">${S.escapeHtml(task.title || '')}</h2>
  `;
  const priChip = document.createElement('span');
  priChip.className = 'priority-chip';
  priChip.style.cssText = `background:${sty.bg};color:${sty.fg};margin-left:10px;vertical-align:middle`;
  priChip.textContent = `${sty.icon} ${pri.flag.replace('-', ' ')}`;
  titleWrap.querySelector('h2').appendChild(priChip);
  header.appendChild(titleWrap);

  const stars = S.starBar(task.importance || 0, (v) => setImportance(task, v), 16);
  stars.classList.add('focus-stars');
  header.appendChild(stars);

  const unpin = document.createElement('button');
  unpin.className = 'btn btn-sm';
  unpin.textContent = 'Unpin';
  unpin.addEventListener('click', () => {
    setPinned(task, false).then(exitFocus);
  });
  header.appendChild(unpin);

  return header;
}

function renderFocusTaskPanel(task) {
  const panel = document.createElement('div');
  panel.className = 'focus-panel';

  if (task.description) {
    const p = document.createElement('p');
    p.className = 'focus-desc';
    p.textContent = task.description;
    panel.appendChild(p);
  }

  const due = (task.due_date && task.due_date !== 'TBD') ? task.due_date : 'TBD';
  const est = task.hours_estimate ? `${task.hours_estimate}h` : '\u2014';
  const logged = hoursLoggedForTask(task.id).toFixed(1) + 'h';
  const booked = (task.time_booked || []).reduce((s, b) => s + (b.hours || 0), 0);
  const meta = document.createElement('div');
  meta.className = 'focus-meta-grid';
  meta.innerHTML = `
    <div><span class="meta-k">due</span> ${S.escapeHtml(due)}</div>
    <div><span class="meta-k">estimate</span> ${est}</div>
    <div><span class="meta-k">logged</span> ${logged}</div>
    <div><span class="meta-k">booked</span> ${booked.toFixed(1)}h</div>
    <div><span class="meta-k">status</span> ${S.escapeHtml(task.status || '')}</div>
    <div><span class="meta-k">source</span> ${S.escapeHtml(task.source || '')}</div>
  `;
  panel.appendChild(meta);

  if ((task.time_booked || []).length) {
    const bk = document.createElement('ul');
    bk.className = 'booked-list';
    for (const b of task.time_booked) {
      const li = document.createElement('li');
      li.textContent = `${b.date} — ${b.hours}h${b.note ? ' · ' + b.note : ''}`;
      bk.appendChild(li);
    }
    panel.appendChild(bk);
  }

  const btns = document.createElement('div');
  btns.className = 'focus-btns';
  btns.appendChild(_btn('Book time', () => openBookTime(task)));
  btns.appendChild(_btn(task.hours_estimate ? `Estimate: ${task.hours_estimate}h` : 'Set estimate', () => openSetEstimate(task)));
  btns.appendChild(_btn('Complete', () => completeTask(task), 'btn-primary'));
  btns.appendChild(_btn('Finalize', () => finalizeTask(task)));
  panel.appendChild(btns);

  // Existing evidence summary
  const ev = task.evidence || {};
  const attached = (ev.email_ids?.length || 0) + (ev.event_ids?.length || 0) + (ev.item_ids?.length || 0);
  if (attached) {
    const att = document.createElement('div');
    att.className = 'focus-attached';
    att.innerHTML = `<span class="meta-k">attached</span> ${ev.email_ids?.length || 0} emails · ${ev.event_ids?.length || 0} events · ${ev.item_ids?.length || 0} items`;
    panel.appendChild(att);
  }
  return panel;
}

function _btn(label, onClick, extraClass) {
  const b = document.createElement('button');
  b.className = 'btn btn-sm' + (extraClass ? ' ' + extraClass : '');
  b.textContent = label;
  b.addEventListener('click', onClick);
  return b;
}

function renderFocusRelated(task) {
  const wrap = document.createElement('div');
  wrap.className = 'focus-related';
  const rawR = relatedForTask(task);
  const r = filterRelated(rawR, DASH.focusSearch);
  const countBucket = (b) => b.events.length + b.emails.length + b.activities.length + b.items.length + b.tasks.length;
  const directN  = countBucket(r.direct);
  const tangentN = countBucket(r.tangent);

  // --- Header
  const head = document.createElement('div');
  head.className = 'focus-related-head';
  const path = [task.category || '?', task.sub_category || ''].filter(Boolean).join(':');
  head.innerHTML = `<h3>Related items</h3><span class="focus-related-count">${directN} direct · ${tangentN} tangent · <code>${S.escapeHtml(path)}</code></span>`;
  wrap.appendChild(head);

  // --- Search + bulk actions toolbar
  const toolbar = document.createElement('div');
  toolbar.className = 'focus-rel-toolbar';
  const search = document.createElement('input');
  search.type = 'text';
  search.placeholder = 'Search title, subject, notes, from, sub-category\u2026';
  search.value = DASH.focusSearch;
  search.className = 'focus-rel-search';
  search.dataset.searchKey = 'focus:' + DASH.focusedTaskId;
  let debounce = null;
  search.addEventListener('input', () => {
    clearTimeout(debounce);
    debounce = setTimeout(() => { DASH.focusSearch = search.value; render(); }, 120);
  });
  // Preserve focus + caret position after re-render
  toolbar.appendChild(search);

  const selAll = document.createElement('button');
  selAll.className = 'btn btn-sm';
  selAll.textContent = 'Select all attachable';
  selAll.addEventListener('click', () => {
    DASH.focusSelected = new Set();
    for (const bucket of [r.direct, r.tangent]) {
      for (const e of bucket.emails)  if (e.id && !isAlreadyAttached(task, 'email', e.id)) DASH.focusSelected.add(selKey('email', e.id));
      for (const e of bucket.events)  if (e.id && !isAlreadyAttached(task, 'event', e.id)) DASH.focusSelected.add(selKey('event', e.id));
      for (const it of bucket.items)  if (it.id && !isAlreadyAttached(task, 'item',  it.id)) DASH.focusSelected.add(selKey('item',  it.id));
    }
    render();
  });
  const clearSel = document.createElement('button');
  clearSel.className = 'btn btn-sm';
  clearSel.textContent = 'Clear';
  clearSel.addEventListener('click', () => { DASH.focusSelected.clear(); render(); });

  const reclassAll = document.createElement('button');
  reclassAll.className = 'btn btn-sm';
  reclassAll.textContent = 'Reclassify all tangent \u2192 this path';
  reclassAll.title = 'Moves every item visible in the Tangent list into this task\u2019s exact category:sub_category.';
  reclassAll.disabled = tangentN === 0;
  reclassAll.addEventListener('click', () => reclassifyAll(task, r.tangent));
  toolbar.appendChild(selAll);
  toolbar.appendChild(clearSel);
  toolbar.appendChild(reclassAll);
  wrap.appendChild(toolbar);

  // --- Direct section
  const directWrap = document.createElement('details');
  directWrap.className = 'focus-bucket focus-bucket-direct';
  directWrap.open = true;
  const dirSummary = document.createElement('summary');
  dirSummary.className = 'focus-bucket-head';
  dirSummary.innerHTML = `<span class="focus-bucket-label">Direct <span class="meta-k">same full path</span></span><span class="rel-count">${directN}</span>`;
  directWrap.appendChild(dirSummary);
  if (!directN) {
    const empty = document.createElement('div');
    empty.className = 'empty-state';
    empty.style.margin = '8px 12px';
    empty.textContent = DASH.focusSearch ? 'No direct matches for your search.' : 'No items yet at this exact path.';
    directWrap.appendChild(empty);
  } else {
    appendBucketSections(directWrap, r.direct, task);
  }
  wrap.appendChild(directWrap);

  // --- Tangent section
  const tanWrap = document.createElement('details');
  tanWrap.className = 'focus-bucket focus-bucket-tangent';
  tanWrap.open = DASH.focusShowTangent;
  tanWrap.addEventListener('toggle', () => { DASH.focusShowTangent = tanWrap.open; });
  const tanSummary = document.createElement('summary');
  tanSummary.className = 'focus-bucket-head';
  tanSummary.innerHTML = `<span class="focus-bucket-label">Tangent <span class="meta-k">ancestor, sibling, or descendant paths</span></span><span class="rel-count">${tangentN}</span>`;
  tanWrap.appendChild(tanSummary);
  if (!tangentN) {
    const empty = document.createElement('div');
    empty.className = 'empty-state';
    empty.style.margin = '8px 12px';
    empty.textContent = DASH.focusSearch ? 'No tangent matches for your search.' : 'No tangent items to review.';
    tanWrap.appendChild(empty);
  } else {
    appendBucketSections(tanWrap, r.tangent, task, /* allowReclassify */ true);
  }
  wrap.appendChild(tanWrap);

  return wrap;
}

function appendBucketSections(parent, bucket, task, allowReclassify) {
  const bkey = allowReclassify ? 'tangent' : 'direct';
  if (bucket.emails.length)     parent.appendChild(renderFocusSection('Emails',         bucket.emails,     'email',    task, focusEmailRow,    allowReclassify, `${bkey}:emails`));
  if (bucket.events.length)     parent.appendChild(renderFocusSection('Calendar events',bucket.events,     'event',    task, focusEventRow,    allowReclassify, `${bkey}:events`));
  if (bucket.activities.length) parent.appendChild(renderFocusSection('Past activity',  bucket.activities, 'activity', task, focusActivityRow, allowReclassify, `${bkey}:activities`));
  if (bucket.tasks.length)      parent.appendChild(renderFocusSection('Sibling tasks',  bucket.tasks,      'task',     task, focusTaskRow,     allowReclassify, `${bkey}:tasks`));
  if (bucket.items.length)      parent.appendChild(renderFocusSection('Items',          bucket.items,      'item',     task, focusItemRow,     allowReclassify, `${bkey}:items`));
}

const FOCUS_SECTION_LIMIT = 100;

function renderFocusSection(title, rows, type, task, rowFn, allowReclassify, sectionKey) {
  const sec = document.createElement('details');
  sec.className = 'focus-section';
  if (sectionKey && DASH.focusOpenSections.has(sectionKey)) sec.open = true;
  if (sectionKey) {
    sec.addEventListener('toggle', () => {
      if (sec.open) DASH.focusOpenSections.add(sectionKey);
      else DASH.focusOpenSections.delete(sectionKey);
    });
  }
  const summary = document.createElement('summary');
  summary.className = 'focus-section-head';
  summary.innerHTML = `<h4>${title}</h4><span class="rel-count">${rows.length}</span>`;
  sec.appendChild(summary);

  const list = document.createElement('ul');
  list.className = 'focus-list';
  const showAllKey = sectionKey ? 'showAll:' + sectionKey : null;
  const showAll = showAllKey && DASH.focusOpenSections.has(showAllKey);
  const cap = showAll ? rows.length : FOCUS_SECTION_LIMIT;
  const slice = rows.slice(0, cap);
  for (const x of slice) list.appendChild(rowFn(x, type, task, allowReclassify));
  if (rows.length > cap) {
    const more = document.createElement('li');
    more.className = 'focus-more';
    const remaining = rows.length - cap;
    more.innerHTML = `<button class="btn btn-sm">Show ${remaining} more</button>`;
    more.querySelector('button').addEventListener('click', (ev) => {
      ev.stopPropagation();
      if (showAllKey) DASH.focusOpenSections.add(showAllKey);
      render();
    });
    list.appendChild(more);
  }
  sec.appendChild(list);
  return sec;
}

function focusRowShell(type, id, task, headerHtml, bodyFn, extraFooterFn, record, allowReclassify) {
  const li = document.createElement('li');
  li.className = 'focus-row';
  const attachable = !!id && !['activity','task'].includes(type);
  const attached = attachable && isAlreadyAttached(task, type, id);
  const rowId = selKey(type, id || '-');
  const selected = DASH.focusSelected.has(rowId);
  const expanded = DASH.focusExpanded.has(rowId);
  if (selected) li.classList.add('selected');
  if (expanded) li.classList.add('expanded');

  const cb = document.createElement('input');
  cb.type = 'checkbox';
  cb.disabled = !attachable || attached;
  cb.checked = attached || selected;
  cb.title = attached ? 'Already attached' : (attachable ? 'Select to attach' : 'Not attachable');
  cb.addEventListener('click', (ev) => ev.stopPropagation());
  cb.addEventListener('change', () => {
    if (cb.checked) DASH.focusSelected.add(rowId);
    else DASH.focusSelected.delete(rowId);
    render();
  });
  li.appendChild(cb);

  const hd = document.createElement('div');
  hd.className = 'focus-row-head';
  hd.innerHTML = headerHtml;
  hd.addEventListener('click', () => {
    if (expanded) DASH.focusExpanded.delete(rowId); else DASH.focusExpanded.add(rowId);
    render();
  });
  li.appendChild(hd);

  const badges = document.createElement('span');
  badges.className = 'focus-row-badges';
  if (attached) {
    const chip = document.createElement('span');
    chip.className = 'focus-attached-chip';
    chip.textContent = 'attached';
    badges.appendChild(chip);
  }
  if (allowReclassify && id && record) {
    const btn = document.createElement('button');
    btn.className = 'btn-icon focus-reclass-btn';
    btn.textContent = '\u21aa';
    const tgtPath = [task.category || '', task.sub_category || ''].filter(Boolean).join(':');
    btn.title = `Reclassify this ${type} to ${tgtPath}`;
    btn.addEventListener('click', (ev) => {
      ev.stopPropagation();
      reclassifyOne(task, type, record);
    });
    badges.appendChild(btn);
  }
  li.appendChild(badges);

  if (expanded) {
    const body = document.createElement('div');
    body.className = 'focus-row-body';
    if (bodyFn) body.innerHTML = bodyFn();
    if (extraFooterFn) {
      const footer = extraFooterFn();
      if (footer) body.appendChild(footer);
    }
    li.appendChild(body);
  }
  return li;
}

function focusEmailRow(e, type, task, allowReclassify) {
  const when = (e.date || '').slice(0, 16).replace('T', ' ');
  const from = Array.isArray(e.from) ? (e.from[0]?.name || e.from[0]?.email || '') : (e.from || '');
  const header = `
    <span class="rel-date">${S.escapeHtml(when)}</span>
    <span class="rel-title"><strong>${S.escapeHtml(e.subject || '(no subject)')}</strong></span>
    <span class="rel-meta">${S.escapeHtml(from)}${e._sub ? ' · ' + S.escapeHtml(e._sub) : ''}</span>
  `;
  const body = () => {
    const star = e.star ? `<div><span class="meta-k">star</span> ${S.escapeHtml(String(e.star))}</div>` : '';
    const typ = e.activity_type ? `<div><span class="meta-k">type</span> ${S.escapeHtml(e.activity_type)}</div>` : '';
    return `
      <div class="focus-body-grid">
        <div><span class="meta-k">id</span> <code>${S.escapeHtml(e.id || '')}</code></div>
        <div><span class="meta-k">from</span> ${S.escapeHtml(from)}</div>
        ${star}${typ}
      </div>
    `;
  };
  const footer = () => makeEmailDetailFooter(e);
  return focusRowShell('email', e.id, task, header, body, footer, e, allowReclassify);
}

function focusEventRow(e, type, task, allowReclassify) {
  const when = (e.start || '').slice(0, 16).replace('T', ' ');
  const dur = e.duration_min ? `${Math.round(e.duration_min)}min` : '';
  const header = `
    <span class="rel-date">${S.escapeHtml(when)}</span>
    <span class="rel-title"><strong>${S.escapeHtml(e.title || '')}</strong></span>
    <span class="rel-meta">${dur}${e._sub ? ' · ' + S.escapeHtml(e._sub) : ''}</span>
  `;
  const body = () => {
    const loc = e.location ? `<div><span class="meta-k">location</span> ${S.escapeHtml(e.location)}</div>` : '';
    const desc = e.description ? `<div class="focus-desc-block">${S.escapeHtml(e.description)}</div>` : '';
    return `
      <div class="focus-body-grid">
        <div><span class="meta-k">start</span> ${S.escapeHtml(e.start || '')}</div>
        <div><span class="meta-k">end</span> ${S.escapeHtml(e.end || '')}</div>
        ${loc}
      </div>
      ${desc}
    `;
  };
  return focusRowShell('event', e.id, task, header, body, null, e, allowReclassify);
}

function focusActivityRow(a, type, task, allowReclassify) {
  const when = (a.completed_at || '').slice(0, 10);
  const hrs = a.hours ? `${a.hours.toFixed(2)}h` : '';
  const header = `
    <span class="rel-date">${S.escapeHtml(when)}</span>
    <span class="rel-title"><strong>${S.escapeHtml(a.title || '')}</strong></span>
    <span class="rel-meta">${hrs}${a._sub ? ' · ' + S.escapeHtml(a._sub) : ''}</span>
  `;
  const body = () => {
    return `
      <div class="focus-body-grid">
        <div><span class="meta-k">id</span> <code>${S.escapeHtml(a.id || '')}</code></div>
        <div><span class="meta-k">from_task</span> <code>${S.escapeHtml(a.from_task_id || '')}</code></div>
      </div>
      ${a.description ? `<div class="focus-desc-block">${S.escapeHtml(a.description)}</div>` : ''}
      ${a.notes ? `<div class="focus-desc-block">${S.escapeHtml(a.notes)}</div>` : ''}
    `;
  };
  return focusRowShell('activity', a.id, task, header, body, null, a, allowReclassify);
}

function focusTaskRow(t, type, parentTask, allowReclassify) {
  const pin = t.pinned ? '\ud83d\udccc ' : '';
  const header = `
    <span class="rel-date">${S.escapeHtml(t.status || '')}</span>
    <span class="rel-title">${pin}${S.escapeHtml(t.title || '')}</span>
    <span class="rel-meta">${S.escapeHtml(t.sub_category || '')}</span>
  `;
  const body = () => `
    <div class="focus-body-grid">
      <div><span class="meta-k">id</span> <code>${S.escapeHtml(t.id || '')}</code></div>
      <div><span class="meta-k">status</span> ${S.escapeHtml(t.status || '')}</div>
      <div><span class="meta-k">hours_est</span> ${t.hours_estimate || '\u2014'}</div>
      <div><span class="meta-k">due</span> ${S.escapeHtml(t.due_date || 'TBD')}</div>
    </div>
    ${t.description ? `<div class="focus-desc-block">${S.escapeHtml(t.description)}</div>` : ''}
  `;
  const footer = () => {
    const wrap = document.createElement('div');
    wrap.className = 'focus-body-link';
    const open = document.createElement('a');
    open.href = 'javascript:void(0)';
    open.textContent = 'Open this task \u2197';
    open.addEventListener('click', (ev) => { ev.stopPropagation(); enterFocus(t.id); });
    wrap.appendChild(open);
    if (!t.pinned) {
      const sep = document.createTextNode(' · ');
      const pinBtn = document.createElement('button');
      pinBtn.className = 'btn btn-sm';
      pinBtn.textContent = 'Pin';
      pinBtn.addEventListener('click', async (ev) => {
        ev.stopPropagation();
        const tt = DASH.inbox.tasks.find(x => x.id === t.id);
        if (tt) { tt.pinned = true; tt.user_edited = true; await saveInbox(); render(); }
      });
      wrap.appendChild(sep);
      wrap.appendChild(pinBtn);
    }
    return wrap;
  };
  return focusRowShell('task', t.id, parentTask, header, body, footer, t, allowReclassify);
}

function focusItemRow(it, type, task, allowReclassify) {
  const header = `
    <span class="rel-date">${S.escapeHtml(it.type || '')}</span>
    <span class="rel-title">${S.escapeHtml(it.title || it.id || '')}</span>
    <span class="rel-meta">${S.escapeHtml(it.status || '')}</span>
  `;
  const body = () => `
    <div class="focus-body-grid">
      <div><span class="meta-k">id</span> <code>${S.escapeHtml(it.id || '')}</code></div>
      <div><span class="meta-k">type</span> ${S.escapeHtml(it.type || '')}</div>
      <div><span class="meta-k">status</span> ${S.escapeHtml(it.status || '')}</div>
    </div>
  `;
  return focusRowShell('item', it.id, task, header, body, null, it, allowReclassify);
}

function renderFocusActionBar(task) {
  const bar = document.createElement('div');
  bar.className = 'focus-actionbar';
  const n = DASH.focusSelected.size;
  bar.innerHTML = `<span class="focus-actionbar-count">${n} selected</span>`;
  const addBtn = document.createElement('button');
  addBtn.className = 'btn btn-primary';
  addBtn.textContent = 'Add to task';
  addBtn.disabled = n === 0;
  addBtn.addEventListener('click', () => attachSelectedToTask(task));
  bar.appendChild(addBtn);
  return bar;
}

/* ---------- reclassify ----------
 *
 * Writes the task's (category, sub_category) to a related item's source
 * record so future runs see it in the Direct bucket. Each source type
 * persists differently:
 *   - email / event: POST /api/attach-source (handles override files and
 *     also attaches to this task's evidence in one shot).
 *   - activity (ledger): direct edit of activity_ledger.json.
 *   - item: direct edit of items.json (category only — items have no
 *     sub_category field).
 *   - task (sibling): direct edit of tasks/inbox.json. */

async function reclassifyOne(task, type, record) {
  const cat = task.category || '';
  const sub = task.sub_category || '';
  if (!cat) { alert('Cannot reclassify: task has no category.'); return; }
  const id = record?.id;
  if (!id) { alert('Cannot reclassify: record has no id.'); return; }
  const tgt = [cat, sub].filter(Boolean).join(':');
  if (!confirmAction(`Reclassify this ${type} to "${tgt}"?`)) return;
  try {
    await _reclassifyCore(task, type, record);
    await loadAll();
    render();
  } catch (e) {
    alert('Reclassify failed: ' + (e?.message || e));
  }
}

async function reclassifyAll(task, bucket) {
  const cat = task.category || '';
  const sub = task.sub_category || '';
  if (!cat) { alert('Cannot reclassify: task has no category.'); return; }
  const all = [
    ...bucket.emails.map(e => ({ type: 'email', record: e })),
    ...bucket.events.map(e => ({ type: 'event', record: e })),
    ...bucket.activities.map(a => ({ type: 'activity', record: a })),
    ...bucket.items.map(i => ({ type: 'item', record: i })),
    ...bucket.tasks.map(t => ({ type: 'task', record: t })),
  ].filter(x => x.record?.id);
  if (!all.length) return;
  const tgt = [cat, sub].filter(Boolean).join(':');
  if (!confirmAction(`Reclassify ${all.length} tangent items into "${tgt}"? This rewrites their category/sub_category.`)) return;
  let ok = 0, fail = 0;
  for (const { type, record } of all) {
    try { await _reclassifyCore(task, type, record); ok++; } catch { fail++; }
  }
  await loadAll();
  render();
  if (fail) alert(`Reclassified ${ok}, failed ${fail}. See console for details.`);
}

async function _reclassifyCore(task, type, record) {
  const cat = task.category || '';
  const sub = task.sub_category || '';
  const id = record.id;
  if (type === 'email' || type === 'event') {
    const res = await fetch('/api/attach-source', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        source_type: type,
        source_id: id,
        category: cat,
        sub_category: sub,
        features: {
          subject: record.subject || record.title || '',
          title: record.title || record.subject || '',
        },
      }),
    });
    const j = await res.json();
    if (!j.ok) throw new Error(j.error || 'attach-source failed');
    return;
  }
  if (type === 'activity') {
    const ledger = await api.load('activity_ledger.json');
    const row = (ledger.activities || []).find(a => a.id === id);
    if (!row) throw new Error('ledger row not found');
    row.category = cat;
    row.sub_category = sub;
    await api.save('activity_ledger.json', ledger);
    return;
  }
  if (type === 'item') {
    const items = await api.load('items.json');
    const row = (items.items || []).find(x => x.id === id);
    if (!row) throw new Error('item not found');
    row.category = cat;
    await api.save('items.json', items);
    return;
  }
  if (type === 'task') {
    const inbox = await api.load('tasks/inbox.json');
    const row = (inbox.tasks || []).find(x => x.id === id);
    if (!row) throw new Error('task not found');
    row.category = cat;
    row.sub_category = sub;
    row.user_edited = true;
    await api.save('tasks/inbox.json', inbox);
    return;
  }
  throw new Error('unsupported type: ' + type);
}

async function attachSelectedToTask(task) {
  if (!DASH.focusSelected.size) return;
  const t = DASH.inbox.tasks.find(x => x.id === task.id);
  if (!t) return;
  t.evidence = t.evidence || { email_ids: [], event_ids: [], item_ids: [] };
  t.evidence.email_ids = t.evidence.email_ids || [];
  t.evidence.event_ids = t.evidence.event_ids || [];
  t.evidence.item_ids  = t.evidence.item_ids  || [];
  for (const key of DASH.focusSelected) {
    const [type, id] = key.split(':');
    if (!id) continue;
    if (type === 'email' && !t.evidence.email_ids.includes(id)) t.evidence.email_ids.push(id);
    if (type === 'event' && !t.evidence.event_ids.includes(id)) t.evidence.event_ids.push(id);
    if (type === 'item'  && !t.evidence.item_ids .includes(id)) t.evidence.item_ids.push(id);
  }
  t.user_edited = true;
  await saveInbox();
  DASH.focusSelected = new Set();
  render();
}

/* ---------- bucket pin picker ---------- */

// Candidate buckets = union of (category, sub_category) from every source
// the user might want to pin: all inbox tasks (any status), ledger activities,
// year-review paths, and anything already pinned. Year-review is fetched on
// demand so opening the picker doesn't slow dashboard boot.
async function collectPinCandidates() {
  const seen = new Set();
  const buckets = [];
  const push = (category, sub_category) => {
    const cat = category || '';
    const sub = sub_category || '';
    const k = `${cat}\u00A7${sub}`;
    if (seen.has(k)) return;
    seen.add(k);
    buckets.push({ category: cat, sub_category: sub });
  };
  for (const t of (DASH.inbox?.tasks || [])) push(t.category, t.sub_category);
  for (const a of (DASH.ledger?.activities || [])) push(a.category, a.sub_category);
  for (const e of (DASH.ledger?.entries || [])) push(e.category, e.sub_category);
  try {
    const idx = await api.load('year_review/index.json');
    const years = (idx.years || []).slice().sort().reverse();
    // Walk the two most recent year files — enough to cover any path the
    // user has touched in the past 18 months without pulling everything.
    for (const y of years.slice(0, 2)) {
      try {
        const doc = await api.load(`year_review/${y}.json`);
        for (const g of (doc.groups || [])) {
          for (const r of (g.rows || [])) push(g.category, r.sub_category);
        }
      } catch {}
    }
  } catch {}
  for (const b of (DASH.pinnedBuckets?.buckets || [])) push(b.category, b.sub_category);
  return buckets;
}

function openPinPicker() {
  const backdrop = document.createElement('div');
  backdrop.className = 'pin-modal-backdrop';
  const modal = document.createElement('div');
  modal.className = 'pin-modal';
  // Category options for the "create new" form — the user-meaningful L1
  // values from yr-shared. Skip noise/unknown which aren't buckets anyone
  // would pin on purpose.
  const CREATE_CATS = ['research', 'teaching', 'service', 'admin', 'personal'];
  const catOptions = CREATE_CATS.map(c =>
    `<option value="${c}">${c}</option>`).join('');
  modal.innerHTML = `
    <div class="pin-modal-head">
      <h3>Pin projects to dashboard</h3>
      <button class="btn-icon" id="pp-close">\u2716</button>
    </div>
    <input type="text" id="pp-search" placeholder="Search by category or path\u2026" class="pp-search">
    <div class="pp-create" style="display:flex;gap:6px;align-items:center;font-size:12px;padding:6px 8px;background:#f9fafb;border:1px dashed #d1d5db;border-radius:6px">
      <span style="color:#6b7280;white-space:nowrap">\u271A Create new bucket:</span>
      <select id="pp-new-cat" style="font-size:12px;padding:3px 6px;border:1px solid #d1d5db;border-radius:4px">${catOptions}</select>
      <input type="text" id="pp-new-sub" placeholder="sub-category path (e.g. grant:new-proposal)" style="flex:1;font-size:12px;padding:3px 8px;border:1px solid #d1d5db;border-radius:4px">
      <button class="btn btn-primary" id="pp-new-create" style="font-size:12px;padding:3px 10px">Create &amp; pin</button>
    </div>
    <div id="pp-list" class="pp-list"><div style="color:#9ca3af;font-size:12px;padding:12px">loading categories\u2026</div></div>
    <div class="pin-modal-foot">
      <span id="pp-count" style="color:#6b7280;font-size:12px"></span>
      <button class="btn btn-primary" id="pp-done">Done</button>
    </div>
  `;
  backdrop.appendChild(modal);
  document.body.appendChild(backdrop);

  const list = modal.querySelector('#pp-list');
  const count = modal.querySelector('#pp-count');
  const search = modal.querySelector('#pp-search');
  let buckets = [];

  function updateCount() {
    count.textContent = `${(DASH.pinnedBuckets?.buckets || []).length} pinned`;
  }

  function sortBuckets(arr) {
    // Pinned first, then by category order, then sub-category alpha.
    arr.sort((a, b) => {
      const pa = isBucketPinned(a.category, a.sub_category) ? 0 : 1;
      const pb = isBucketPinned(b.category, b.sub_category) ? 0 : 1;
      if (pa !== pb) return pa - pb;
      const ia = CAT_ORDER.indexOf(a.category); const ib = CAT_ORDER.indexOf(b.category);
      if (ia !== ib) return ia - ib;
      return (a.sub_category || '').localeCompare(b.sub_category || '');
    });
  }

  function paint() {
    list.innerHTML = '';
    const q = (search.value || '').toLowerCase();
    let shown = 0;
    for (const b of buckets) {
      const hay = `${b.category || ''} ${b.sub_category || ''}`.toLowerCase();
      if (q && !hay.includes(q)) continue;
      shown++;
      const row = document.createElement('label');
      row.className = 'pp-row';
      const cb = document.createElement('input');
      cb.type = 'checkbox';
      cb.checked = isBucketPinned(b.category, b.sub_category);
      cb.addEventListener('change', async () => {
        if (cb.checked) await pinBucket(b.category, b.sub_category);
        else await unpinBucket(b.category, b.sub_category);
        updateCount();
      });
      const dot = document.createElement('span');
      dot.className = 'cat-dot';
      dot.style.background = CAT_COLOR[b.category || 'unknown'] || '#6b7280';
      const txt = document.createElement('span');
      txt.className = 'pp-title';
      txt.textContent = b.sub_category || '(no sub-category)';
      const meta = document.createElement('span');
      meta.className = 'pp-meta';
      const taskCount = openTasksInBucket(b.category, b.sub_category).length;
      meta.textContent = `${b.category || '?'} · ${taskCount} task${taskCount === 1 ? '' : 's'}`;
      row.appendChild(cb);
      row.appendChild(dot);
      row.appendChild(txt);
      row.appendChild(meta);
      list.appendChild(row);
    }
    if (!shown) {
      const none = document.createElement('div');
      none.style.cssText = 'color:#9ca3af;font-size:12px;padding:12px';
      none.textContent = q
        ? `No categories match "${q}".`
        : 'No categories found.';
      list.appendChild(none);
    }
  }

  search.addEventListener('input', paint);
  modal.querySelector('#pp-close').addEventListener('click', close);
  modal.querySelector('#pp-done').addEventListener('click', close);
  backdrop.addEventListener('click', (e) => { if (e.target === backdrop) close(); });

  // Normalize a user-typed sub_category path: lowercase, collapse whitespace
  // around colons, convert spaces to hyphens within segments. Matches the
  // slug shape used everywhere else (e.g. `grant:r01:pond`).
  function normalizeSubPath(raw) {
    return String(raw || '').trim().toLowerCase()
      .split(':')
      .map(seg => seg.trim().replace(/\s+/g, '-').replace(/[^a-z0-9\-_]/g, ''))
      .filter(Boolean)
      .join(':');
  }

  const newCat = modal.querySelector('#pp-new-cat');
  const newSub = modal.querySelector('#pp-new-sub');
  const createBtn = modal.querySelector('#pp-new-create');

  const doCreate = async () => {
    const cat = newCat.value;
    const sub = normalizeSubPath(newSub.value);
    if (!sub) {
      newSub.focus();
      newSub.style.borderColor = '#dc2626';
      return;
    }
    newSub.style.borderColor = '';
    if (isBucketPinned(cat, sub)) {
      alert(`Already pinned: ${cat} / ${sub}`);
      return;
    }
    createBtn.disabled = true;
    try {
      await pinBucket(cat, sub);
      // Make the new bucket appear in the searchable list and scroll it
      // into view — confirms the action succeeded without closing the modal.
      const key = `${cat}\u00A7${sub}`;
      if (!buckets.some(b => `${b.category}\u00A7${b.sub_category}` === key)) {
        buckets.push({ category: cat, sub_category: sub });
        sortBuckets(buckets);
      }
      newSub.value = '';
      search.value = sub;
      paint();
      updateCount();
    } catch (err) {
      alert('Create failed: ' + err.message);
    } finally {
      createBtn.disabled = false;
    }
  };

  createBtn.addEventListener('click', doCreate);
  newSub.addEventListener('keydown', (ev) => {
    if (ev.key === 'Enter') { ev.preventDefault(); doCreate(); }
  });

  function close() {
    document.body.removeChild(backdrop);
    render();
  }

  updateCount();
  search.focus();
  collectPinCandidates().then(list => {
    buckets = list;
    sortBuckets(buckets);
    paint();
  }).catch(err => {
    list.innerHTML = `<div style="color:#b91c1c;font-size:12px;padding:12px">Failed to load categories: ${err.message}</div>`;
  });
}

/* ---------- kickoff ---------- */

document.addEventListener('DOMContentLoaded', boot);
