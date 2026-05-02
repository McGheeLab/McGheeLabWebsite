/* activity-overview.js — landing page for the activity workflow:
 *   import emails + calendar, see at-a-glance counts, jump into the
 *   email / calendar / task pages, and scan recent activity.
 *
 * Reads:
 *   GET /api/data/email_archive/summary.json         (year list + counts)
 *   GET /api/data/email_archive/by_year/<y>.json     (current-year rows)
 *   GET /api/data/calendar_archive/summary.json      (calendar years)
 *   GET /api/data/calendar_archive/by_year/<y>.json  (events for counts + recent)
 *   GET /api/data/tasks/inbox.json                   (task counts)
 *   GET /api/data/activity_ledger.json               (for "last import" hint)
 *
 * Writes: nothing. The action buttons POST to /api/import-fetch (fast pull),
 *   /api/process-data (slow ML + clustering), and /api/suggest-tasks.
 */

const OVERVIEW = {
  email: null,
  calendar: null,
  inbox: null,
  currentYear: null,
};

const CX = {
  buckets: [],              // full list from /api/category-explorer
  expanded: new Set(),      // keys of expanded rows
  search: '',
  // Active category-filter pills. Empty set = show all. Any selected = show
  // only buckets whose category is in this set.
  pillFilter: new Set(),
  // Progressive sub-category filter segments under the single active L1.
  // Only used when pillFilter.size === 1. Empty = L1 only. [grant] = filter
  // to `<cat>:grant*`. [grant,r01] = `<cat>:grant:r01*`. Cleared whenever
  // the L1 selection changes.
  subPath: [],
  // Bulk-merge workflow state. Checkboxes are always visible on every tree
  // node and every expanded item — there's no longer a select-mode toggle.
  // `selected` is the bucket keys picked for the next merge action;
  // `selectedItems` is a Map of item-keys → item payloads (with their source
  // bucket) for per-item moves via drag-and-drop.
  selected: new Set(),
  selectedItems: new Map(),
  // Expanded-item set (by itemKey) — shows the item's details row beneath it.
  expandedItems: new Set(),
  // Expanded tree paths (e.g. "teaching:course"). Separate from `expanded`
  // (which is bucket keys) so the tree's unfold state is independent of the
  // legacy flat-row view.
  expandedPaths: new Set(),
  // Split-view state: when on, the Category Explorer renders left pane = all
  // items searchable across buckets, right pane = one pinned bucket that
  // accepts dropped items. query filters the target-picker listbox by
  // substring across "cat:sub". The scope (filterCat + sub-prefix) is NOT
  // stored here — it comes from CX.pillFilter + CX.subPath, which the top
  // pill row controls directly while split view is on.
  split: { on: false, pinnedBucketKey: null, query: '' },
  // Tree + counts reused by the category picker when the user clicks Merge.
  tree: {},
  counts: {},
};

function itemKey(it) {
  return `${it.kind}\u00A7${it.id}`;
}

document.addEventListener('DOMContentLoaded', async () => {
  // Wait for auth before any user-scope reads — without this, live-sync
  // attaches with no signed-in user and throws "User-scoped route requires
  // sign-in" for emailArchive/calendarArchive subscriptions.
  if (typeof firebridge !== 'undefined' && firebridge.whenAuthResolved) {
    try { await firebridge.whenAuthResolved(); } catch (_) {}
  }
  // Phase 9: activity-overview now reads per-user emailMessages + calendarEvents
  // (Phase 7 sync + items.json backfill), so the full renderer works for any
  // signed-in lab member with their own data. The local Import / Process
  // buttons stay hidden on the deploy via .local-only CSS (server.py-only).
  if (typeof firebridge !== 'undefined' && firebridge.gateSignedIn) {
    const gate = await firebridge.gateSignedIn(
      'Sign in to view your activity. Connect Gmail + Calendar in Settings to populate this page.'
    );
    if (!gate.allowed) return;
  }
  const isLocal = !window.RM_RUNTIME || window.RM_RUNTIME.isLocal;
  // Sections are independently mounted. The Explorer page reuses this script
  // for the Category Explorer alone, so skip any block whose host element is
  // missing rather than throwing. The Import / Process buttons depend on
  // server.py and are hidden by .local-only on the deploy — skip wireActions
  // entirely there too so the deploy doesn't poll a non-existent /api/job-status.
  if (isLocal && document.getElementById('btn-import')) wireActions();
  if (document.getElementById('act-stats')) {
    await loadAll();
    renderStats();
    renderTiles();
    renderRecent();
  }
  if (document.getElementById('cx-search')) {
    if (isLocal) await loadCategoryExplorer();  // /api/category-explorer is server.py-only
    // Live-sync OFF on activity-overview (Phase 12) — view-mostly page;
    // category overrides change rarely and tab-to-tab sync isn't worth the
    // onSnapshot streams + their initial-state network cost.
    // _activityAttachLiveSync();
  }
});

function wireActions() {
  document.getElementById('btn-import').addEventListener('click', onImport);
  document.getElementById('btn-process').addEventListener('click', onProcess);
  document.getElementById('btn-suggest').addEventListener('click', () => {
    window.location.href = '/rm/pages/api-usage.html';
  });
  // Restore live progress on load so a page refresh doesn't lose the
  // current Import / Process state. Polling keeps going until both jobs
  // are no longer "running"; we still render finished states once so the
  // user can see the last result.
  refreshJobsAndPoll();
}

async function loadAll() {
  const y = String(new Date().getFullYear());
  OVERVIEW.currentYear = y;
  // Phase 9: try the new per-user collections first. Fall back to the legacy
  // summary.json + by_year{y}.json on-disk archive when the synced collections
  // are empty (covers Alex's local-dev workflow).
  let allMessages = null, allEvents = null;
  try {
    const m = await api.load('email_archive/messages.json');
    if (m && Array.isArray(m.messages) && m.messages.length) allMessages = m.messages;
  } catch {}
  try {
    const e = await api.load('calendar_archive/events.json');
    if (e && Array.isArray(e.events) && e.events.length) allEvents = e.events;
  } catch {}

  const [summary, calSummary, emails, events, inbox] = await Promise.all([
    allMessages ? null : api.load('email_archive/summary.json').catch(() => null),
    allEvents   ? null : api.load('calendar_archive/summary.json').catch(() => null),
    allMessages ? null : api.load(`email_archive/by_year/${y}.json`).catch(() => ({ emails: [] })),
    allEvents   ? null : api.load(`calendar_archive/by_year/${y}.json`).catch(() => ({ events: [] })),
    api.load('tasks/inbox.json').catch(() => ({ tasks: [] })),
  ]);

  if (allMessages) {
    // Synthesize the legacy email shape from the flat scraped list.
    const yearMessages = allMessages.filter(m => {
      const t = Number(m.internalDate) || 0;
      return t && new Date(t).getFullYear().toString() === y;
    }).map(m => ({
      id: m.id,
      from: typeof m.from === 'string' ? [_parseAddr(m.from)] : (m.from || []),
      to:   typeof m.to === 'string'   ? [_parseAddr(m.to)]   : (m.to   || []),
      subject: m.subject || '',
      date: m.date || (m.internalDate ? new Date(Number(m.internalDate)).toISOString() : ''),
      body_preview: m.body_preview || m.snippet || '',
      category: m.category || 'unknown',
      sub_category: m.sub_category || '',
      activity_type: m.activity_type || '',
      category_source: m.category_source || '',
      llm_confidence: m.llm_confidence || 0,
    }));
    OVERVIEW.email = { summary: { years: _yearsOf(allMessages, m => Number(m.internalDate) || 0) }, rows: yearMessages };
  } else {
    OVERVIEW.email = { summary: summary?.summary || null, rows: (emails && emails.emails) || [] };
  }

  if (allEvents) {
    const yearEvents = allEvents.filter(ev => (ev.start_at || ev.start || '').slice(0, 4) === y).map(ev => ({
      id: ev.id,
      title: ev.summary || ev.title || '',
      description: ev.description || '',
      location: ev.location || '',
      organizer: ev.organizer_email || ev.organizer || '',
      start: ev.start_at || ev.start || '',
      end: ev.end_at || ev.end || '',
      all_day: !!ev.all_day,
      attendees: ev.attendees || [],
      category: ev.category || 'unknown',
      sub_category: ev.sub_category || '',
      duration_min: ev.duration_min || 0,
    }));
    OVERVIEW.calendar = { summary: { years: _yearsOf(allEvents, ev => Date.parse(ev.start_at || ev.start || '') || 0) }, events: yearEvents };
  } else {
    OVERVIEW.calendar = { summary: calSummary?.summary || null, events: (events && events.events) || [] };
  }

  OVERVIEW.inbox = (inbox && inbox.tasks) || [];
}

function _parseAddr(s) {
  s = String(s || '');
  const m = s.match(/^"?([^"<]+?)"?\s*<([^>]+)>$/);
  if (m) return { name: m[1].trim(), email: m[2].trim() };
  return { name: '', email: s.trim() };
}
function _yearsOf(rows, getMs) {
  const seen = new Set();
  for (const r of rows) {
    const t = getMs(r);
    if (t) seen.add(new Date(t).getFullYear().toString());
  }
  return Array.from(seen).sort();
}

/* ---------- stats ---------- */

function renderStats() {
  const host = document.getElementById('act-stats');
  host.innerHTML = '';

  const todayStr = new Date().toISOString().slice(0, 10);
  const cardsFrag = document.createDocumentFragment();

  // Email stats
  const rows = OVERVIEW.email.rows;
  const unknowns = rows.filter(e => (e.category || 'unknown') === 'unknown').length;
  const mlPreds = rows.filter(e => e.category_source === 'ml').length;
  const manual = rows.filter(e => e.category_source === 'manual').length;
  const newestEmail = rows.reduce((max, e) => (e.date && e.date > max ? e.date : max), '');
  cardsFrag.appendChild(statCard(
    'Emails this year',
    rows.length.toLocaleString(),
    mlPreds ? `${mlPreds} ML-classified · ${manual} manual override${manual === 1 ? '' : 's'}` : 'no classifications yet',
  ));
  cardsFrag.appendChild(statCard(
    'Needs refinement',
    String(unknowns),
    unknowns ? 'Run suggester to classify these with Haiku' : 'ML is confident about every row',
    unknowns ? 'warn' : 'ok',
  ));
  if (newestEmail) {
    cardsFrag.appendChild(statCard(
      'Newest email',
      newestEmail.slice(0, 10),
      relativeTime(newestEmail),
    ));
  }

  // Calendar stats
  const events = OVERVIEW.calendar.events;
  const upcoming = events.filter(e => (e.start || '').slice(0, 10) >= todayStr);
  const today = events.filter(e => (e.start || '').slice(0, 10) === todayStr);
  const catUnknown = events.filter(e => (e.category || 'unknown') === 'unknown').length;
  cardsFrag.appendChild(statCard(
    'Events this year',
    events.length.toLocaleString(),
    `${upcoming.length} upcoming · ${today.length} today`,
  ));
  if (catUnknown) {
    cardsFrag.appendChild(statCard(
      'Events to categorize',
      String(catUnknown),
      'Open Calendar to assign categories',
      'warn',
    ));
  }

  // Task stats
  const tasks = OVERVIEW.inbox;
  const suggested = tasks.filter(t => t.status === 'suggested').length;
  const active = tasks.filter(t => t.status === 'active' || t.status === 'accepted').length;
  const todayTasks = tasks.filter(t => t.status === 'active' && t.planned_for === todayStr).length;
  cardsFrag.appendChild(statCard(
    'Tasks',
    `${active}`,
    `${suggested} suggested · ${todayTasks} planned today`,
  ));

  host.appendChild(cardsFrag);
}

function statCard(label, big, sub, tone) {
  const el = document.createElement('div');
  el.className = 'act-stat';
  el.innerHTML = `
    <div class="lbl">${escapeHtml(label)}</div>
    <div class="big${tone ? ' ' + tone : ''}">${escapeHtml(big)}</div>
    <div class="sub">${escapeHtml(sub)}</div>
  `;
  return el;
}

/* ---------- tiles ---------- */

function renderTiles() {
  const host = document.getElementById('act-tiles');
  host.innerHTML = '';
  const todayStr = new Date().toISOString().slice(0, 10);

  const suggested = OVERVIEW.inbox.filter(t => t.status === 'suggested').length;
  const active = OVERVIEW.inbox.filter(t => ['active','accepted'].includes(t.status)).length;
  const needsLlm = OVERVIEW.email.rows.filter(e => (e.category || 'unknown') === 'unknown').length;
  const upcoming = OVERVIEW.calendar.events.filter(e => (e.start || '').slice(0, 10) >= todayStr).length;

  host.appendChild(tile('/rm/pages/email-review.html', 'Email Review',
    'Triage inbox. Star what matters, override categories — every override trains the ML model.',
    needsLlm, needsLlm ? '' : 'muted'));
  host.appendChild(tile('/rm/pages/calendar.html', 'Calendar',
    'Review events by group, assign categories, roll up into tasks.',
    upcoming, 'muted'));
  host.appendChild(tile('/rm/pages/tasks-inbox.html', 'Task Inbox',
    'Accept / complete / reject suggestions. Plan your day.',
    suggested || active, suggested ? '' : 'muted'));
  host.appendChild(tile('/rm/pages/year-review.html', 'Year Review',
    'Group activities by category. Retrospective + edits.',
    null, 'muted'));
}

function tile(href, title, desc, badge, badgeMod) {
  const a = document.createElement('a');
  a.className = 'act-tile';
  a.href = href;
  const badgeHtml = badge == null
    ? ''
    : `<span class="badge${badgeMod ? ' ' + badgeMod : ''}">${escapeHtml(String(badge))}</span>`;
  a.innerHTML = `
    <h3>${escapeHtml(title)}${badgeHtml}</h3>
    <p>${escapeHtml(desc)}</p>
  `;
  return a;
}

/* ---------- recent activity feed ---------- */

function renderRecent() {
  const host = document.getElementById('act-recent');
  host.innerHTML = '<h2>Most recent</h2>';

  // Combine emails + events, sort by time desc, take top 15.
  const items = [];
  for (const e of OVERVIEW.email.rows.slice(0, 80)) {
    items.push({
      kind: 'email',
      when: e.date || '',
      title: e.subject || '(no subject)',
      sub: (e.from || [])[0]?.email || '',
      category: e.category || 'unknown',
    });
  }
  for (const ev of OVERVIEW.calendar.events.slice(0, 80)) {
    items.push({
      kind: 'event',
      when: ev.start || '',
      title: ev.title || '(untitled)',
      sub: ev.location || ev.organizer || '',
      category: ev.category || 'unknown',
    });
  }
  items.sort((a, b) => (b.when || '').localeCompare(a.when || ''));
  const top = items.slice(0, 15);
  if (!top.length) {
    host.appendChild(Object.assign(document.createElement('div'), {
      style: 'padding:14px 16px;color:var(--text-muted)',
      textContent: 'Nothing yet — click Import to pull your latest emails + calendar.',
    }));
    return;
  }
  for (const it of top) {
    const row = document.createElement('div');
    row.className = 'act-recent-row';
    row.innerHTML = `
      <div class="when">${escapeHtml((it.when || '').slice(0, 10))}</div>
      <div class="kind ${it.kind}">${it.kind}</div>
      <div class="title">${escapeHtml(it.title)}</div>
      <div class="sub">${escapeHtml(it.category)}${it.sub ? ' · ' + escapeHtml(it.sub) : ''}</div>
    `;
    host.appendChild(row);
  }
}

/* ---------- Import + suggester actions ---------- */

// Job UI metadata. Each entry maps a server job name to the button it
// drives plus the verbs/labels we want to show. `displayName` is what the
// progress panel calls the job; `verb` is the present-progressive used on
// the button label while running.
const JOB_UI = {
  'import-fetch': {
    btnId: 'btn-import',
    labelId: 'btn-import-label',
    displayName: 'Import',
    verb: 'Importing',
    statusRunning: 'pulling new mail + calendar from external services…',
    statusDone: 'import done',
  },
  'process-data': {
    btnId: 'btn-process',
    labelId: 'btn-process-label',
    displayName: 'Process',
    verb: 'Processing',
    statusRunning: 'indexing + classifying mail, rebuilding clusters (can take 10-20 min)…',
    statusDone: 'processing done',
  },
};

let JOB_POLL_TIMER = null;
let JOB_TICK_TIMER = null;
// Last known snapshot from /api/job-status, keyed by job name. Used so the
// elapsed-time tick can re-render the panel between polls without hitting
// the server every second.
let JOB_LAST_SNAPSHOT = {};
// Tracks which jobs the *current* tab kicked off, so we can refresh the
// stats / status text when they finish (a returning tab that just polls a
// background run shouldn't fire those side-effects).
const JOB_OWNED = new Set();

function onImport() { return startJob('import-fetch'); }
function onProcess() { return startJob('process-data'); }

async function startJob(name) {
  const ui = JOB_UI[name];
  if (!ui) return;
  const endpoint = name === 'import-fetch' ? '/api/import-fetch' : '/api/process-data';
  // Optimistically render a "starting" job so the panel shows up before
  // the first poll lands. The server will overwrite this on the next tick.
  JOB_LAST_SNAPSHOT[name] = {
    name,
    status: 'running',
    started_at: new Date().toISOString(),
    finished_at: null,
    step_index: 0,
    total_steps: 0,
    current_step: 'starting…',
    current_step_started_at: new Date().toISOString(),
    completed_steps: [],
  };
  JOB_OWNED.add(name);
  renderJobs();
  startJobPolling();
  setStatus(ui.statusRunning, 'running');
  try {
    const res = await fetch(endpoint, { method: 'POST' });
    const j = await res.json().catch(() => ({}));
    if (!j.ok) {
      setStatus(`${ui.verb.toLowerCase()} failed — see console`, 'err');
      console.error(`${ui.verb.toLowerCase()} log:\n` + (j.log || j.error || ''));
    } else {
      setStatus(`${ui.statusDone} — reloading stats…`, 'running');
      await loadAll();
      renderStats(); renderTiles(); renderRecent();
      setStatus(`${ui.statusDone}.`, '');
      setTimeout(() => setStatus('', ''), 4000);
    }
  } catch (e) {
    // Network errors (server restart, page nav) are fine — polling will
    // continue to reflect server-side state. Don't alert; the panel will
    // show whatever the server records.
    console.warn(`${name} POST failed:`, e);
  } finally {
    // One last refresh so the final state lands in the panel.
    refreshJobsAndPoll();
  }
}

async function refreshJobsAndPoll() {
  await refreshJobs();
  // If anything is still running, keep polling. Otherwise just leave the
  // last snapshot rendered so the user can see the most recent result.
  if (anyRunning()) startJobPolling();
}

async function refreshJobs() {
  try {
    const r = await fetch('/api/job-status');
    const j = await r.json();
    if (!j.ok) return;
    JOB_LAST_SNAPSHOT = j.jobs || {};
    renderJobs();
  } catch (e) {
    // server might not be running yet — ignore.
  }
}

function startJobPolling() {
  if (JOB_POLL_TIMER) return;
  JOB_POLL_TIMER = setInterval(async () => {
    await refreshJobs();
    if (!anyRunning()) {
      clearInterval(JOB_POLL_TIMER);
      JOB_POLL_TIMER = null;
      // Stop the elapsed-time tick too — there's nothing to tick when
      // no jobs are running. Earlier version left this firing forever
      // at 1Hz after a job finished.
      if (JOB_TICK_TIMER) {
        clearInterval(JOB_TICK_TIMER);
        JOB_TICK_TIMER = null;
      }
    }
  }, 2000);
  if (!JOB_TICK_TIMER) {
    // Re-render every second so elapsed times tick smoothly without
    // hitting the server. The poll updates the underlying snapshot.
    JOB_TICK_TIMER = setInterval(() => {
      if (anyRunning()) renderJobs();
    }, 1000);
  }
}

function anyRunning() {
  return Object.values(JOB_LAST_SNAPSHOT || {}).some(j => j && j.status === 'running');
}

function renderJobs() {
  const host = document.getElementById('job-progress');
  if (!host) return;
  // Update each button's running/disabled state to match server-side
  // truth. A returning tab will see the button "running" again because
  // the job is genuinely still in progress somewhere.
  for (const name of Object.keys(JOB_UI)) {
    const ui = JOB_UI[name];
    const job = JOB_LAST_SNAPSHOT[name];
    const btn = document.getElementById(ui.btnId);
    const label = document.getElementById(ui.labelId);
    if (!btn || !label) continue;
    if (job && job.status === 'running') {
      btn.disabled = true;
      btn.classList.add('is-running');
      const elapsed = elapsedSeconds(job.started_at);
      label.textContent = `${ui.verb}… ${formatMs(elapsed)}`;
    } else {
      btn.disabled = false;
      btn.classList.remove('is-running');
      label.textContent = ui.displayName;
    }
  }
  // Build / hide the panel. We show the panel whenever there's at least
  // one job we know about (running or finished); blank otherwise.
  const jobs = Object.values(JOB_LAST_SNAPSHOT || {}).filter(Boolean);
  if (!jobs.length) { host.innerHTML = ''; return; }
  jobs.sort((a, b) => (b.started_at || '').localeCompare(a.started_at || ''));
  host.innerHTML = jobs.map(renderJobCard).join('');
}

function renderJobCard(job) {
  const ui = JOB_UI[job.name] || { displayName: job.name };
  const running = job.status === 'running';
  const okClass = job.status === 'ok' ? 'ok' : job.status === 'error' ? 'err' : 'running';
  const elapsed = running
    ? elapsedSeconds(job.started_at)
    : Math.max(0, Math.floor((new Date(job.finished_at).getTime() - new Date(job.started_at).getTime()) / 1000));
  const headerRight = running
    ? `<span class="jp-elapsed">running ${formatMs(elapsed)}</span>`
    : `<span class="jp-elapsed">${job.status === 'ok' ? 'done' : 'failed'} in ${formatMs(elapsed)} · ${relativeTime(job.finished_at)}</span>`;
  const total = Math.max(job.total_steps || (job.completed_steps || []).length, 1);
  const completedCount = (job.completed_steps || []).length;
  const progressPct = running
    ? Math.min(100, Math.round((completedCount / total) * 100))
    : 100;

  // Render the per-step list. Completed steps come from the server; the
  // currently-running step is appended live.
  const stepRows = [];
  for (const s of (job.completed_steps || [])) {
    const icon = s.ok ? '✓' : '✗';
    const cls = s.ok ? 'ok' : 'err';
    const detail = s.note
      ? `<span class="jp-step-note">${escapeHtml(s.note)}</span>`
      : (s.stdout_tail ? `<span class="jp-step-note">${escapeHtml(s.stdout_tail)}</span>` : '');
    stepRows.push(
      `<li class="jp-step ${cls}"><span class="jp-step-icon">${icon}</span>` +
      `<span class="jp-step-label">${escapeHtml(s.label)}</span>` +
      `<span class="jp-step-time">${formatMs(s.duration_s || 0)}</span>${detail}</li>`,
    );
  }
  if (running && job.current_step) {
    const stepElapsed = elapsedSeconds(job.current_step_started_at);
    stepRows.push(
      `<li class="jp-step running"><span class="jp-step-icon">⟳</span>` +
      `<span class="jp-step-label">${escapeHtml(job.current_step)}</span>` +
      `<span class="jp-step-time">${formatMs(stepElapsed)}</span></li>`,
    );
  }

  return `
    <div class="jp-card jp-${okClass}">
      <div class="jp-head">
        <div class="jp-title"><strong>${escapeHtml(ui.displayName)}</strong> — ${escapeHtml(job.status)}</div>
        ${headerRight}
      </div>
      <div class="jp-bar"><div class="jp-bar-fill" style="width:${progressPct}%"></div></div>
      <ol class="jp-steps">${stepRows.join('')}</ol>
    </div>
  `;
}

function elapsedSeconds(iso) {
  if (!iso) return 0;
  const t = new Date(iso).getTime();
  if (!t) return 0;
  return Math.max(0, Math.floor((Date.now() - t) / 1000));
}

function formatMs(seconds) {
  const s = Math.max(0, Math.round(seconds));
  return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, '0')}`;
}

async function onSuggest() {
  setStatus('Haiku refining + retraining ML + suggesting — usually 5-20 min…', 'running');
  try {
    const res = await fetch('/api/suggest-tasks', { method: 'POST' });
    const j = await res.json();
    if (!j.ok) {
      setStatus('suggester failed — see console', 'err');
      console.error('suggester log:\n' + (j.log || j.error || ''));
      alert('Suggester failed. Check the browser console for the script log.');
      return;
    }
    setStatus('suggester done — reloading stats…', 'running');
    await loadAll();
    renderStats(); renderTiles(); renderRecent();
    setStatus('suggester done.', '');
    setTimeout(() => setStatus('', ''), 4000);
  } catch (e) {
    setStatus('error: ' + e.message, 'err');
  }
}

function setStatus(text, cls) {
  const el = document.getElementById('act-status');
  el.textContent = text;
  el.className = 'act-status' + (cls ? ' ' + cls : '');
}

function relativeTime(isoStr) {
  if (!isoStr) return '';
  const then = new Date(isoStr).getTime();
  if (!then) return '';
  const diffMs = Date.now() - then;
  const mins = Math.round(diffMs / 60000);
  if (mins < 1) return 'just now';
  if (mins < 60) return `${mins} min ago`;
  const hrs = Math.round(mins / 60);
  if (hrs < 24) return `${hrs}h ago`;
  const days = Math.round(hrs / 24);
  if (days < 30) return `${days}d ago`;
  return isoStr.slice(0, 10);
}

function escapeHtml(s) {
  return String(s == null ? '' : s).replace(/[&<>"']/g, c => ({
    '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;',
  }[c]));
}

/* ---------- Category retag with Firestore mirror ----------
 *
 * /api/retag-item is a server-side endpoint that updates JSON archives
 * (email_archive/category_overrides.json, calendar_archive/category_overrides.json,
 * tasks/inbox.json, activity_ledger.json) plus inline records in by_year files.
 * It does NOT touch Firestore. With the multi-tenant migration, Firestore is
 * the source of truth for per-user overrides — so other tabs (email-review,
 * calendar, this page) subscribe to those Firestore docs and miss any change
 * that only landed in JSON.
 *
 * Wrap /api/retag-item with a Firestore mirror: same field-level update, same
 * doc path the email-review/calendar live-sync subscribers are listening to.
 * Tab-to-tab live sync now fires for retags initiated from this page.
 */
async function _retagItemFirestoreMirror(kind, id, category, sub) {
  try {
    if (typeof firebridge === 'undefined' || !firebridge.getUser) return;
    const user = firebridge.getUser();
    if (!user) return;
    const db = firebridge.db();
    const ts = firebase.firestore.FieldValue.serverTimestamp();
    if (kind === 'email') {
      await db.doc(`userData/${user.uid}/emailArchive/categoryOverrides`).set({
        overrides: { [id]: { category, sub_category: sub || '' } },
        updatedAt: ts,
      }, { merge: true });
    } else if (kind === 'event') {
      await db.doc(`userData/${user.uid}/calendarArchive/categoryOverrides`).set({
        overrides: { [id]: { category, sub_category: sub || '' } },
        updatedAt: ts,
      }, { merge: true });
    } else if (kind === 'task') {
      // Per-task field update — tasks are individual docs in userData/{uid}/tasks/{id}.
      await db.doc(`userData/${user.uid}/tasks/${id}`).set({
        category, sub_category: sub || '', user_edited: true, updatedAt: ts,
      }, { merge: true });
    } else if (kind === 'activity') {
      await db.doc(`userData/${user.uid}/activityLedger/${id}`).set({
        category, sub_category: sub || '', updatedAt: ts,
      }, { merge: true });
    }
  } catch (err) {
    console.warn('[activity-overview] Firestore retag mirror failed:', err.message || err);
  }
}

async function retagItemWithSync(body) {
  let r = null;
  try {
    const res = await fetch('/api/retag-item', {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    });
    r = await res.json();
  } catch (err) {
    console.warn('[activity-overview] /api/retag-item failed:', err.message || err);
  }
  // Mirror to Firestore so live-sync fires on other tabs (this page, email-review, calendar).
  // Mark the next remote snapshot as our own write so the subscription's debounced
  // refresh doesn't bounce.
  _activityLive.suppressUntil = Date.now() + 2500;
  await _retagItemFirestoreMirror(body.kind, body.id, body.category, body.sub_category);
  return r;
}

/* ---------- Live tab-to-tab sync ----------
 * Subscribe to the per-user override docs that retags write to. When another
 * tab (or another window of this page) commits a retag, fire a debounced
 * loadCategoryExplorer() to refresh CX state. Self-write echo is gated by
 * suppressUntil — set in retagItemWithSync just before the Firestore write.
 */
const _activityLive = {
  suppressUntil: 0,
  refreshTimer: null,
  unsubs: [],
};

function _activityScheduleRefresh() {
  if (_activityLive.refreshTimer) return;
  _activityLive.refreshTimer = setTimeout(async () => {
    _activityLive.refreshTimer = null;
    const scrollY = window.scrollY;
    const active = document.activeElement;
    const activeId = active && active.id;
    try {
      await loadCategoryExplorer();
    } catch (err) {
      console.warn('[activity-overview] live-sync refresh failed:', err);
    } finally {
      window.scrollTo({ top: scrollY, left: 0, behavior: 'instant' });
      if (activeId) {
        const el = document.getElementById(activeId);
        if (el) { try { el.focus(); } catch (e) {} }
      }
    }
  }, 200);
}

function _activityAttachLiveSync() {
  if (typeof api.subscribe !== 'function') return;
  if (_activityLive.unsubs.length) return;
  const paths = [
    'email_archive/category_overrides.json',
    'calendar_archive/category_overrides.json',
  ];
  for (const p of paths) {
    try {
      let firstFireConsumed = false;
      const unsub = api.subscribe(p, function () {
        if (Date.now() < _activityLive.suppressUntil) return;
        if (!firstFireConsumed) { firstFireConsumed = true; return; }
        _activityScheduleRefresh();
      });
      _activityLive.unsubs.push(unsub);
    } catch (err) {
      console.warn('[activity-overview] live sync attach failed for', p, err.message);
    }
  }
}

/* ---------- Category Explorer ---------- */

async function loadCategoryExplorer() {
  const countsEl = document.getElementById('cx-counts');
  countsEl.textContent = 'loading…';
  try {
    const res = await fetch('/api/category-explorer');
    const j = await res.json();
    if (!j.ok) throw new Error(j.error || 'load failed');
    CX.buckets = j.buckets || [];
    buildCxTree();
    wireCxSearch();
    wireCxAddButton();
    wireCxSelectButton();
    wireCxSplitButton();
    wireCxExpandButton();
    applySelectModeClass();
    renderCxBulkbar();
    renderCxPills();
    renderCx();
    renderCxSplitRight();
    updateCxMoveArrow();
  } catch (e) {
    countsEl.textContent = 'failed: ' + e.message;
  }
}

// Build the picker's {tree, counts} from the aggregated buckets so the
// category picker (used in the merge dialog) has the right suggestions.
function buildCxTree() {
  CX.tree = {};
  CX.counts = {};
  for (const b of CX.buckets) {
    const cat = b.category || '';
    const sub = b.sub_category || '';
    if (!cat) continue;
    const totalN = Object.values(b.counts).reduce((a, b2) => a + b2, 0);
    if (!CX.tree[cat]) CX.tree[cat] = {};
    if (sub) {
      const segs = sub.split(':').filter(Boolean);
      let node = CX.tree[cat];
      for (const s of segs) {
        if (!node[s]) node[s] = {};
        node = node[s];
      }
      CX.counts[`${cat}:${sub}`] = (CX.counts[`${cat}:${sub}`] || 0) + totalN;
    }
  }
}

function wireCxSearch() {
  const input = document.getElementById('cx-search');
  if (!input || input._wired) return;
  input._wired = true;
  input.addEventListener('input', () => {
    CX.search = input.value.trim().toLowerCase();
    renderCx();
  });
}

// Aggressive, belt-and-suspenders cleanup of drag state. HTML5 DnD is
// notoriously twitchy — `dragend` doesn't fire reliably when the source
// element is removed from the DOM mid-gesture (common here because drops
// trigger re-renders), and leftover `cx-dragging` / `cx-drop-*` classes or
// a lingering setDragImage element can make the NEXT drag "look inert"
// even though the handlers are all wired correctly. Until we can prove a
// single cleanup trigger is sufficient, fire cleanup on every plausible
// event at the document level.
// ─── MANUAL DRAG ENGINE ────────────────────────────────────────────────
//
// Five rounds of HTML5 DnD fixes later, the "drag works once then dies
// after a re-render" bug kept coming back. This replaces row drag
// entirely with a hand-rolled mousedown/mousemove/mouseup system —
// the browser's native drag machinery isn't involved for rows at all,
// so none of its caching, race conditions, or re-render quirks can
// break us.
//
// How it works:
//   1. The drag handle is a plain <span> with a mousedown listener.
//   2. mousedown captures the source spec (which row, what payload).
//   3. A global mousemove listener fires; once the user has moved more
//      than a few pixels, we show a ghost and start scanning for drop
//      targets under the cursor via document.elementFromPoint(...).
//   4. Drop targets are marked with data-cx-drop="<kind>" attributes.
//      On mousemove we walk up ancestors looking for one, and highlight
//      the match.
//   5. On mouseup over a compatible drop target we fire the matching
//      handler (moveItems, mergeTreeNodes, reparentL1, etc.) — the
//      same back-end logic the HTML5 path used.
//
// Pill drags (L1 + sub-pill) stay on HTML5 DnD for now since those
// were never reported as broken. Only rows move to the manual path.

const CX_DRAG = { active: null };

function makeDragHandle(sourceSpec) {
  const handle = document.createElement('span');
  handle.className = 'cx-drag-handle';
  handle.textContent = '⋮⋮';
  handle.title = 'Drag from here';
  handle.setAttribute('aria-label', 'Drag handle');
  handle.addEventListener('mousedown', (ev) => {
    if (ev.button !== 0) return;
    // Prevent text selection and default browser drag.
    ev.preventDefault();
    ev.stopPropagation();
    cxDragStart(ev, handle.closest('.cx-tree-node, .cx-items-row, .cx-row'), sourceSpec(ev));
  });
  return handle;
}

// Start a manual drag. Registers mousemove + mouseup on document and
// defers the "active" state until the cursor has moved a few pixels,
// so a stray click on the handle doesn't create a ghost.
function cxDragStart(initialEv, sourceEl, spec) {
  if (!spec || !sourceEl) return;
  // Cancel any stale drag first (paranoia — should already be null)
  cxDragCleanup();
  CX_DRAG.active = {
    spec,                       // {kind, data, shiftKey} assembled by source
    sourceEl,
    startX: initialEv.clientX,
    startY: initialEv.clientY,
    started: false,
    ghost: null,
    currentDrop: null,
  };
  document.addEventListener('mousemove', cxDragMove);
  document.addEventListener('mouseup', cxDragUp, { once: true });
  // Esc cancels the drag.
  document.addEventListener('keydown', cxDragKey);
}

function cxDragMove(ev) {
  const s = CX_DRAG.active;
  if (!s) return;
  if (!s.started) {
    const dx = ev.clientX - s.startX, dy = ev.clientY - s.startY;
    if (Math.hypot(dx, dy) < 4) return;   // ignore tiny jitters
    s.started = true;
    s.ghost = cxBuildGhost(s.spec);
    document.body.appendChild(s.ghost);
    s.sourceEl?.classList.add('cx-dragging');
    // Update Shift state each frame — user can toggle mid-drag.
    updateGhostModeHint(s);
  }
  s.ghost.style.left = (ev.clientX + 14) + 'px';
  s.ghost.style.top = (ev.clientY + 14) + 'px';
  // Live Shift toggling for tree-node drags (nest vs flatten).
  s.spec.shiftKey = ev.shiftKey;
  updateGhostModeHint(s);
  // Find drop target under cursor. Walk up to find [data-cx-drop].
  const el = document.elementFromPoint(ev.clientX, ev.clientY);
  const dropEl = cxFindDropTarget(el, s.spec);
  if (dropEl !== s.currentDrop) {
    s.currentDrop?.classList.remove('cx-drop-over');
    dropEl?.classList.add('cx-drop-over');
    s.currentDrop = dropEl;
  }
}

async function cxDragUp(ev) {
  const s = CX_DRAG.active;
  if (!s) { cxDragCleanup(); return; }
  document.removeEventListener('mousemove', cxDragMove);
  document.removeEventListener('keydown', cxDragKey);
  // Snapshot for async dispatch before cleanup clears it.
  const spec = s.spec, dropEl = s.currentDrop, started = s.started;
  cxDragCleanup();
  if (!started || !dropEl) return;
  try {
    await cxDispatchDrop(spec, dropEl);
  } catch (err) {
    console.warn('cxDispatchDrop failed:', err);
    cxToast('Drop failed: ' + (err.message || err), 'error');
  }
}

function cxDragKey(ev) {
  if (ev.key === 'Escape') {
    cxDragCleanup();
  }
}

function cxDragCleanup() {
  const s = CX_DRAG.active;
  CX_DRAG.active = null;
  document.removeEventListener('mousemove', cxDragMove);
  document.removeEventListener('keydown', cxDragKey);
  if (!s) return;
  s.ghost?.remove();
  s.sourceEl?.classList.remove('cx-dragging');
  s.currentDrop?.classList.remove('cx-drop-over');
  document.querySelectorAll('.cx-drop-over').forEach(el => el.classList.remove('cx-drop-over'));
}

// Walk up from `el` looking for a drop target compatible with `spec`.
// Returns the element (with data-cx-drop attribute) or null.
function cxFindDropTarget(el, spec) {
  while (el && el !== document.body) {
    const d = el.dataset?.cxDrop;
    if (d && cxDropCompatible(spec, d, el)) return el;
    el = el.parentElement;
  }
  return null;
}

// Compatibility rules: source kind × drop kind.
function cxDropCompatible(spec, dropKind, dropEl) {
  const src = spec.kind;
  if (src === 'item' && dropKind === 'tree-node') return dropEl.dataset.cxDirect === 'true';
  if (src === 'item' && dropKind === 'l1-pill') return true;
  if (src === 'tree-node' && dropKind === 'tree-node') return dropEl.dataset.cxPath !== spec.data.path;
  if (src === 'tree-node' && dropKind === 'l1-pill') return dropEl.dataset.cxL1 !== spec.data.l1;
  return false;
}

// Dispatch the drop: read source + target, route to the appropriate
// back-end function (moveItems, mergeTreeNodes, reparentL1).
async function cxDispatchDrop(spec, dropEl) {
  const dropKind = dropEl.dataset.cxDrop;
  const combo = `${spec.kind}->${dropKind}`;
  if (combo === 'item->tree-node') {
    const tgtL1 = dropEl.dataset.cxL1 || '';
    const tgtSub = dropEl.dataset.cxSub || '';
    return moveItems(spec.data.items, tgtL1, tgtSub);
  }
  if (combo === 'item->l1-pill') {
    const tgtL1 = dropEl.dataset.cxL1;
    // Per-item retag keeping each's sub.
    for (const it of spec.data.items) {
      if (it.category === tgtL1) continue;
      try {
        await retagItemWithSync({ kind: it.kind, id: it.id, category: tgtL1, sub_category: it.sub_category || '' });
      } catch { /* best effort */ }
    }
    await loadCategoryExplorer();
    cxToast(`Moved ${spec.data.items.length} item${spec.data.items.length === 1 ? '' : 's'} → ${tgtL1}`);
    return;
  }
  if (combo === 'tree-node->tree-node') {
    // Reconstruct node objects from dataset.
    const srcNode = spec.data;
    const tgtNode = {
      l1: dropEl.dataset.cxL1,
      subSegments: (dropEl.dataset.cxSub || '').split(':').filter(Boolean),
      path: dropEl.dataset.cxPath,
      depth: Number(dropEl.dataset.cxDepth || 0),
      label: dropEl.dataset.cxLabel || '',
    };
    return mergeTreeNodes(srcNode, tgtNode, { nest: !spec.shiftKey });
  }
  if (combo === 'tree-node->l1-pill') {
    const tgtL1 = dropEl.dataset.cxL1;
    const srcNode = spec.data;
    return reparentL1(
      [{ category: srcNode.l1, sub_category: srcNode.subSegments.join(':') }],
      tgtL1,
    );
  }
}

function cxBuildGhost(spec) {
  const g = document.createElement('div');
  g.className = 'cx-drag-ghost';
  let count = 1, label = '';
  if (spec.kind === 'item') {
    count = spec.data.items.length;
    label = count === 1 ? 'item' : 'items';
  } else if (spec.kind === 'tree-node') {
    count = spec.data.rollupCount || 1;
    label = spec.data.label || spec.data.l1;
  }
  const modeHint = spec.kind === 'tree-node' ? '<span class="cx-drag-ghost-mode"></span>' : '';
  g.innerHTML =
    `<span class="cx-drag-ghost-icon">${count > 1 ? '📦' : '•'}</span>` +
    `<span class="cx-drag-ghost-count"><strong>${count}</strong> ${escapeHtml(label)}</span>` +
    modeHint;
  return g;
}

function updateGhostModeHint(s) {
  if (s.spec.kind !== 'tree-node' || !s.ghost) return;
  const hint = s.ghost.querySelector('.cx-drag-ghost-mode');
  if (!hint) return;
  hint.textContent = s.spec.shiftKey ? '⇧ flatten' : 'nest';
}

function cxResetDragState() {
  document.querySelectorAll('.cx-dragging, .cx-drop-over, .cx-drop-armed, .cx-drop-eligible')
    .forEach(el => el.classList.remove('cx-dragging', 'cx-drop-over', 'cx-drop-armed', 'cx-drop-eligible'));
  const pills = document.querySelector('.cx-pills');
  if (pills) delete pills.dataset.dragCount;
  if (typeof clearDragBadge === 'function') clearDragBadge();
}
if (!window._cxDragGlobalWired) {
  window._cxDragGlobalWired = true;
  // dragend should be the canonical "I'm done dragging" signal. Capture-phase
  // so we still see it even if a child handler cancels propagation.
  document.addEventListener('dragend', cxResetDragState, true);
  // drop fires before dragend but is also a terminal event for the drag. Run
  // cleanup on a 50ms delay so per-row dragend handlers get a turn first.
  document.addEventListener('drop', () => setTimeout(cxResetDragState, 50), true);
  // mouseup catches the case where a drag "stalls" — user releases but
  // dragend never fires (seen after mid-drag re-renders). Harmless when a
  // normal drag ended cleanly: the classes are already gone.
  document.addEventListener('mouseup', () => setTimeout(cxResetDragState, 100), true);
  // Switching tabs mid-drag invalidates the drag entirely in every browser.
  document.addEventListener('visibilitychange', () => {
    if (document.hidden) cxResetDragState();
  });
  // Finally, always start a fresh drag with a clean slate — if any prior
  // state is lingering, scrub it on capture before the row handler runs.
  document.addEventListener('dragstart', cxResetDragState, true);
}

function renderCx() {
  const list = document.getElementById('cx-list');
  const countsEl = document.getElementById('cx-counts');
  // Defensive: drop any drag-related sticky state from previous gestures
  // before we repaint. Prevents "first drag works, later drags inert"
  // symptoms when a dragend handler was bound to an element that got
  // destroyed mid-gesture (rare, but cheap to cover here).
  const pills = document.querySelector('.cx-pills');
  if (pills) {
    pills.classList.remove('cx-drop-armed');
    delete pills.dataset.dragCount;
  }
  if (typeof clearDragBadge === 'function') clearDragBadge();
  list.innerHTML = '';

  let filtered = CX.buckets;
  // In split view, the top pills drive the RIGHT pane's scope instead of
  // filtering the left list — so the left stays wide-open while the user
  // picks a target on the right.
  if (!CX.split.on) {
    if (CX.pillFilter.size) {
      filtered = filtered.filter(b => CX.pillFilter.has(b.category || ''));
    }
    if (CX.pillFilter.size === 1 && CX.subPath.length) {
      const prefix = CX.subPath.join(':');
      filtered = filtered.filter(b => {
        const s = b.sub_category || '';
        return s === prefix || s.startsWith(prefix + ':');
      });
    }
  }
  if (CX.search) {
    filtered = filtered.filter(b => matchesSearch(b, CX.search));
    // Narrow each surfaced bucket's item list to just the matches so the
    // expanded view doesn't pull unrelated siblings along. Rebuild counts
    // so tree rollups + the bucket badge reflect the filtered set instead
    // of the full bucket size.
    filtered = filtered.map(b => {
      const nameHit = bucketNameMatches(b, CX.search);
      const matches = (b.items || []).filter(it => itemMatchesSearch(it, CX.search));
      // Count per kind so the kind-colored counts UI stays meaningful.
      const counts = { tasks: 0, activities: 0, emails: 0, events: 0 };
      const kindToKey = { task: 'tasks', activity: 'activities', email: 'emails', event: 'events' };
      for (const it of matches) {
        const k = kindToKey[it.kind];
        if (k) counts[k]++;
      }
      return {
        ...b,
        items: matches,
        counts,
        _searchNameHit: nameHit,       // bucket's own name matched
        _searchItemHit: matches.length, // how many items matched
      };
    });
  }

  const hasFilter = CX.search || CX.pillFilter.size;
  countsEl.textContent = hasFilter
    ? `${filtered.length} of ${CX.buckets.length} buckets`
    : `${CX.buckets.length} buckets`;

  if (!filtered.length) {
    const empty = document.createElement('div');
    empty.className = 'cx-empty';
    empty.textContent = hasFilter ? 'No categories match the current filter.' : 'No items yet.';
    list.appendChild(empty);
    return;
  }

  // Auto-expand paths touched by a text search so matches surface without
  // an extra click. We do this once per render; it's additive so manually
  // collapsed nodes aren't re-opened the next frame.
  if (CX.search) {
    for (const b of filtered) {
      const segs = (b.sub_category || '').split(':').filter(Boolean);
      let path = b.category || '';
      CX.expandedPaths.add(path);
      for (const s of segs) {
        path = path + ':' + s;
        CX.expandedPaths.add(path);
      }
    }
  }

  const treeRoot = buildCxTreeView(filtered);
  const order = (window.YR_SHARED?.CAT_ORDER) || ['research','teaching','service','admin','personal','noise','unknown'];
  const l1Nodes = Array.from(treeRoot.children.entries()).sort(([a], [b]) => {
    const ia = order.indexOf(a); const ib = order.indexOf(b);
    if (ia !== ib) return (ia === -1 ? 999 : ia) - (ib === -1 ? 999 : ib);
    return a.localeCompare(b);
  });
  for (const [, n] of l1Nodes) list.appendChild(renderCxTreeNode(n));
}

// Build a hierarchical view of the current (filtered) bucket list. Each node
// represents one path segment; descendants form the sub-tree. `directBucket`
// is set on whichever node corresponds to a bucket whose full path ends
// there, so nodes can render items inline (and be drag sources) while
// pathway nodes above them roll up descendant counts.
function buildCxTreeView(buckets) {
  const root = { children: new Map() };
  for (const b of buckets) {
    const cat = b.category || '—';
    const segs = (b.sub_category || '').split(':').filter(Boolean);
    const fullSegs = [cat, ...segs];
    let node = root;
    for (let i = 0; i < fullSegs.length; i++) {
      const seg = fullSegs[i];
      if (!node.children.has(seg)) {
        node.children.set(seg, {
          label: seg,
          depth: i,                                  // 0 = L1
          l1: cat,
          subSegments: fullSegs.slice(1, i + 1),     // path *below* L1
          path: fullSegs.slice(0, i + 1).join(':'),  // full path incl L1
          rollupCount: 0,
          directBucket: null,
          children: new Map(),
        });
      }
      node = node.children.get(seg);
    }
    node.directBucket = b;
  }
  // Post-order rollup so parents include every descendant's count.
  (function rollup(n) {
    const own = n.directBucket
      ? Object.values(n.directBucket.counts || {}).reduce((a, v) => a + (v || 0), 0)
      : 0;
    let total = own;
    for (const c of n.children.values()) total += rollup(c);
    n.rollupCount = total;
    return total;
  })(root);
  return root;
}

// Render one tree node + its expanded subtree. The structure is:
//   <wrap>
//     <row> chevron  [check]  label  count  … </row>
//     (when expanded) <children> [sub-nodes]  [direct-bucket items] </children>
//   </wrap>
function renderCxTreeNode(node) {
  const colorMap = (window.YR_SHARED?.CAT_COLOR) || {};
  const expanded = CX.expandedPaths.has(node.path);
  const hasChildren = node.children.size > 0;
  const hasOwnItems = !!(node.directBucket && (node.directBucket.items?.length || 0));

  const wrap = document.createElement('div');
  wrap.className = 'cx-tree-wrap';

  const row = document.createElement('div');
  row.className = 'cx-tree-node' + (expanded ? ' expanded' : '');
  row.dataset.path = node.path;
  row.dataset.depth = String(node.depth);
  row.style.setProperty('--cat-color', colorMap[node.l1] || '#6b7280');
  // Indent by depth — each level nudges the row right for fast scanning.
  row.style.paddingLeft = `${8 + node.depth * 16}px`;

  // Tree-node is a drop target for items (when it has a direct bucket)
  // and for other tree-nodes (for merge). Attributes are read by the
  // manual drag engine's cxFindDropTarget / cxDispatchDrop.
  row.dataset.cxDrop = 'tree-node';
  row.dataset.cxL1 = node.l1;
  row.dataset.cxSub = node.subSegments.join(':');
  row.dataset.cxPath = node.path;
  row.dataset.cxDepth = String(node.depth);
  row.dataset.cxLabel = node.label;
  row.dataset.cxDirect = node.directBucket ? 'true' : 'false';

  // Drag handle — mousedown starts a manual drag. The source spec is
  // rebuilt at mousedown time so multi-select state is always current.
  row.appendChild(makeDragHandle(() => {
    if (node.directBucket) {
      const b = node.directBucket;
      // Selected buckets travel along even if the dragged row isn't in
      // the selection, mirroring the prior behavior.
      const selKeys = new Set(CX.selected);
      const selected = CX.buckets.filter(x => selKeys.has(cxKey(x)));
      const extra = selKeys.has(cxKey(b)) ? [] : [b];
      const allSources = [...selected, ...extra];
      // If the user has a single-row drag and no multi-select, just use
      // node. If multi-select, merging becomes "reparent each onto tgt".
      if (allSources.length > 1) {
        // When the user drops onto an L1 pill, reparentL1 expects the
        // {category, sub_category} shape — keep tree-node kind but cram
        // selection into the payload for the reparent path.
        return { kind: 'tree-node', data: node, selectedBuckets: allSources, shiftKey: false };
      }
      return { kind: 'tree-node', data: node, shiftKey: false };
    }
    return { kind: 'tree-node', data: node, shiftKey: false };
  }));

  // Chevron: toggles expand. Disabled on leaf nodes with nothing to show.
  const chev = document.createElement('button');
  chev.type = 'button';
  chev.className = 'cx-tree-chev';
  const hasAny = hasChildren || hasOwnItems;
  chev.textContent = hasAny ? (expanded ? '▾' : '▸') : '·';
  chev.disabled = !hasAny;
  chev.addEventListener('click', (ev) => {
    ev.stopPropagation();
    if (expanded) CX.expandedPaths.delete(node.path);
    else CX.expandedPaths.add(node.path);
    renderCx();
  });
  row.appendChild(chev);

  // Checkbox — always visible. Direct-bucket nodes select the bucket key;
  // pathway nodes get a disabled placeholder so the grid stays aligned (a
  // pathway-node subtree-select affordance can come later; for now, bulk
  // selection at non-leaf levels is handled via drag-merge).
  if (node.directBucket) {
    const key = cxKey(node.directBucket);
    if (CX.selected.has(key)) row.classList.add('row-selected');
    const cb = document.createElement('input');
    cb.type = 'checkbox';
    cb.className = 'cx-tree-check';
    cb.checked = CX.selected.has(key);
    cb.addEventListener('click', (ev) => ev.stopPropagation());
    cb.addEventListener('change', () => {
      if (cb.checked) CX.selected.add(key); else CX.selected.delete(key);
      row.classList.toggle('row-selected', cb.checked);
      renderCxBulkbar();
    });
    row.appendChild(cb);
  } else {
    const spacer = document.createElement('span');
    spacer.className = 'cx-tree-check-spacer';
    row.appendChild(spacer);
  }

  const label = document.createElement('span');
  label.className = 'cx-tree-label' + (node.depth === 0 ? ' l1' : '');
  label.textContent = node.label;
  label.title = `${node.path}\u2002\u00b7\u2002double-click to rename`;
  // Single click expands (matches tree-view conventions); double-click enters
  // edit mode. spellcheck off so the browser doesn't underline slugs.
  label.spellcheck = false;
  label.addEventListener('click', (ev) => {
    if (label.isContentEditable) return;  // let the editor keep focus
    if (!hasAny) return;
    if (expanded) CX.expandedPaths.delete(node.path);
    else CX.expandedPaths.add(node.path);
    renderCx();
  });
  label.addEventListener('dblclick', (ev) => {
    ev.stopPropagation();
    if (label.isContentEditable) return;
    beginInlineRename(label, node);
  });
  row.appendChild(label);

  const count = document.createElement('span');
  count.className = 'cx-tree-count';
  count.textContent = String(node.rollupCount);
  count.title = node.directBucket
    ? `${node.rollupCount} items total • direct: ${Object.values(node.directBucket.counts || {}).reduce((a, v) => a + (v || 0), 0)}`
    : `${node.rollupCount} items across ${node.children.size} sub-categor${node.children.size === 1 ? 'y' : 'ies'}`;
  row.appendChild(count);

  // Per-row actions. Pin is universal — any node can be the drop target for
  // items dragged in from other parts of the tree. Merge is still here as
  // an escape hatch to open the full picker for edge cases beyond drag-merge.
  const actions = document.createElement('span');
  actions.className = 'cx-tree-actions';

  if (node.directBucket) {
    const key = cxKey(node.directBucket);
    const pinBtn = document.createElement('button');
    pinBtn.type = 'button';
    const isPinned = CX.split.pinnedBucketKey === key;
    pinBtn.className = 'cx-tree-pin' + (isPinned ? ' pinned' : '');
    pinBtn.textContent = isPinned ? '📌' : '📍';
    pinBtn.title = isPinned
      ? 'Unpin (remove as drop target)'
      : 'Pin this bucket as the drop target — drag items from anywhere to land here';
    pinBtn.addEventListener('click', (ev) => {
      ev.stopPropagation();
      if (isPinned) {
        CX.split.pinnedBucketKey = null;
      } else {
        CX.split.pinnedBucketKey = key;
        // Auto-open the side pane so the user sees what they just pinned.
        if (!CX.split.on) openSplitView();
      }
      renderCx();
      renderCxSplitRight();
      updateCxMoveArrow();
      renderCxBulkbar();
    });
    actions.appendChild(pinBtn);

    const mergeBtn = document.createElement('button');
    mergeBtn.type = 'button';
    mergeBtn.className = 'btn btn-sm';
    mergeBtn.textContent = 'Merge';
    mergeBtn.title = 'Open the full merge picker (edge cases — prefer drag-merge on the tree)';
    mergeBtn.addEventListener('click', (ev) => {
      ev.stopPropagation();
      openMergeDialog(node.directBucket);
    });
    actions.appendChild(mergeBtn);
  }

  // Delete button — available on every node (L1, pathway, direct-bucket).
  // Opens a dialog that picks a destination for any items under the subtree.
  const delBtn = document.createElement('button');
  delBtn.type = 'button';
  delBtn.className = 'btn btn-sm cx-tree-delete';
  delBtn.textContent = 'Delete';
  delBtn.title = node.rollupCount
    ? `Delete "${node.path}" — ${node.rollupCount} item${node.rollupCount === 1 ? '' : 's'} will be moved to a destination you pick`
    : `Delete "${node.path}" (empty)`;
  delBtn.addEventListener('click', (ev) => {
    ev.stopPropagation();
    openDeleteCategoryDialog(node);
  });
  actions.appendChild(delBtn);

  row.appendChild(actions);

  // Every tree node is a drag source AND a drop target. Direct-bucket nodes
  // Row is NOT HTML5-draggable. The manual drag engine (cxDragStart)
  // handles row→tree / row→pill drags via mousedown on the handle above.
  // HTML5 drag listeners below are kept ONLY for drops from pill drags
  // (L1 pills and sub-pills still use native HTML5 DnD since they have
  // never exhibited the "drag only works once" bug that plagued rows).
  row.addEventListener('dragover', (ev) => {
    const t = ev.dataTransfer?.types;
    if (!t) return;
    const accepts = t.includes('application/x-cx-items')
                 || t.includes('application/x-cx-tree-node');
    // Items can only land on direct-bucket nodes (they need a concrete path).
    if (t.includes('application/x-cx-items') && !node.directBucket) return;
    if (!accepts) return;
    ev.preventDefault();
    ev.dataTransfer.dropEffect = 'move';
    row.classList.add('cx-drop-over');
  });
  row.addEventListener('dragleave', () => row.classList.remove('cx-drop-over'));
  row.addEventListener('drop', async (ev) => {
    ev.preventDefault();
    row.classList.remove('cx-drop-over');
    const itemsRaw = ev.dataTransfer.getData('application/x-cx-items');
    const nodeRaw  = ev.dataTransfer.getData('application/x-cx-tree-node');
    if (itemsRaw && node.directBucket) {
      let items;
      try { items = JSON.parse(itemsRaw); } catch { return; }
      if (!Array.isArray(items) || !items.length) return;
      const b = node.directBucket;
      await moveItems(items, b.category || '', b.sub_category || '');
      return;
    }
    if (nodeRaw) {
      let src;
      try { src = JSON.parse(nodeRaw); } catch { return; }
      if (!src || src.path === node.path) return;
      // Default: nest the dragged category as a sub-category of the target.
      // Shift modifier flattens the source into the target (contents only,
      // source's own label is dropped).
      await mergeTreeNodes(src, node, { nest: !ev.shiftKey });
      return;
    }
  });

  wrap.appendChild(row);

  if (expanded && hasAny) {
    const inner = document.createElement('div');
    inner.className = 'cx-tree-children';
    // Sort children by rollupCount desc, then alpha — keeps the densest
    // subtrees at the top of each level so noise falls to the bottom.
    const kids = Array.from(node.children.values()).sort((a, b) => {
      if (a.rollupCount !== b.rollupCount) return b.rollupCount - a.rollupCount;
      return a.label.localeCompare(b.label);
    });
    for (const c of kids) inner.appendChild(renderCxTreeNode(c));
    // Items belonging directly at this path (not in a descendant) render
    // AFTER the children — matches the "drill down, then peek" reading order.
    if (hasOwnItems) {
      const itemsWrap = document.createElement('div');
      itemsWrap.className = 'cx-tree-items';
      itemsWrap.style.paddingLeft = `${8 + (node.depth + 1) * 16}px`;
      for (const it of node.directBucket.items) {
        itemsWrap.appendChild(renderCxItemRow(it, node.directBucket));
      }
      inner.appendChild(itemsWrap);
    }
    wrap.appendChild(inner);
  }

  return wrap;
}

function renderCxPills() {
  const host = document.getElementById('cx-pills');
  if (!host) return;
  host.innerHTML = '';

  // Count buckets per category from the full unfiltered list.
  const byCat = new Map();
  for (const b of CX.buckets) {
    const c = b.category || 'unknown';
    byCat.set(c, (byCat.get(c) || 0) + 1);
  }
  // Sort: yr-shared's canonical order first, then anything else alphabetical.
  const canonical = (window.YR_SHARED?.CAT_ORDER) || [
    'research', 'teaching', 'service', 'admin', 'personal', 'noise', 'unknown',
  ];
  const keys = Array.from(byCat.keys()).sort((a, b) => {
    const ia = canonical.indexOf(a); const ib = canonical.indexOf(b);
    if (ia !== ib) return (ia === -1 ? 999 : ia) - (ib === -1 ? 999 : ib);
    return a.localeCompare(b);
  });

  // --- L1 row ---------------------------------------------------------
  const l1Row = document.createElement('div');
  l1Row.className = 'cx-pill-row';

  // "All" reset pill — active only when pillFilter is empty.
  const all = document.createElement('button');
  all.type = 'button';
  all.className = 'cx-pill cx-pill-all' + (CX.pillFilter.size ? '' : ' active');
  all.innerHTML = `All <span class="cx-pill-count">${CX.buckets.length}</span>`;
  all.addEventListener('click', () => {
    CX.pillFilter.clear();
    CX.subPath = [];
    renderCxPills();
    renderCx();
    if (CX.split.on) renderCxSplitRight();
  });
  l1Row.appendChild(all);

  for (const c of keys) {
    const btn = document.createElement('button');
    btn.type = 'button';
    btn.className = 'cx-pill cx-pill-l1' + (CX.pillFilter.has(c) ? ' active' : '');
    btn.dataset.cat = c;
    btn.draggable = true;
    // Manual-drag drop target: items + tree-nodes from the manual engine
    // land here via mouseup dispatch. L1-pill drags + pill-scope drops
    // still use HTML5 DnD (dragover/drop listeners below).
    btn.dataset.cxDrop = 'l1-pill';
    btn.dataset.cxL1 = c;
    // Apply the canonical L1 color so pills are visually distinct at a glance —
    // critical for drop-target discoverability. Border always colored; fill
    // tinted until the pill is active or hovered during a drag.
    const color = (window.YR_SHARED?.CAT_COLOR || {})[c] || '#6b7280';
    btn.style.setProperty('--cat-color', color);
    btn.innerHTML = `${escapeHtml(c)} <span class="cx-pill-count">${byCat.get(c)}</span>`;
    btn.addEventListener('click', () => {
      if (CX.split.on) {
        // Single-select mode: picking a pill in split view sets the target
        // scope to exactly this L1. Clicking the active one clears.
        if (CX.pillFilter.size === 1 && CX.pillFilter.has(c)) {
          CX.pillFilter.clear();
        } else {
          CX.pillFilter = new Set([c]);
        }
      } else {
        // Default (non-split): multi-select filter for the left list.
        if (CX.pillFilter.has(c)) CX.pillFilter.delete(c);
        else CX.pillFilter.add(c);
      }
      CX.subPath = [];
      renderCxPills();
      renderCx();
      if (CX.split.on) renderCxSplitRight();
    });
    // Drag source: dragging one L1 pill onto another merges the whole L1
    // bucket into the target category. Uses a dedicated MIME so row-drags
    // and pill-drags can be distinguished on the drop target.
    btn.addEventListener('dragstart', (ev) => {
      try {
        ev.dataTransfer.effectAllowed = 'move';
        ev.dataTransfer.setData('application/x-cx-pill-l1', JSON.stringify({ category: c }));
        btn.classList.add('cx-dragging');
        document.querySelector('.cx-pills')?.classList.add('cx-drop-armed');
      } catch (err) {
        console.warn('cx-pill-l1 dragstart aborted:', err);
        cxResetDragState();
      }
    });
    btn.addEventListener('dragend', () => {
      btn.classList.remove('cx-dragging');
      document.querySelector('.cx-pills')?.classList.remove('cx-drop-armed');
      document.querySelectorAll('.cx-pill.cx-drop-over').forEach(el => el.classList.remove('cx-drop-over'));
    });
    // Drop target: accepts three payloads
    //   • application/x-cx-bucket (rows) → reparent each row keeping its sub
    //   • application/x-cx-pill-l1       → merge whole source L1 into this one
    //   • application/x-cx-items         → move each item to this L1 keeping
    //                                      its sub_category (item-level swap)
    btn.addEventListener('dragover', (ev) => {
      const t = ev.dataTransfer?.types;
      if (!t) return;
      if (!(t.includes('application/x-cx-bucket') ||
            t.includes('application/x-cx-pill-l1') ||
            t.includes('application/x-cx-items'))) return;
      ev.preventDefault();
      ev.dataTransfer.dropEffect = 'move';
      btn.classList.add('cx-drop-over');
    });
    btn.addEventListener('dragleave', () => btn.classList.remove('cx-drop-over'));
    btn.addEventListener('drop', async (ev) => {
      ev.preventDefault();
      btn.classList.remove('cx-drop-over');
      const rowPayload = ev.dataTransfer.getData('application/x-cx-bucket');
      const pillPayload = ev.dataTransfer.getData('application/x-cx-pill-l1');
      const itemsPayload = ev.dataTransfer.getData('application/x-cx-items');
      if (itemsPayload) {
        try {
          const items = JSON.parse(itemsPayload);
          if (!Array.isArray(items) || !items.length) return;
          // For each item: keep its sub_category, change L1 to this pill's cat.
          // If multiple items come from different sub_categories, each retag
          // call gets that item's own sub.
          let moved = 0, failed = 0;
          for (const it of items) {
            if ((it.category || '') === c) continue; // same-L1 no-op
            try {
              const j = await retagItemWithSync({
                kind: it.kind, id: it.id,
                category: c, sub_category: it.sub_category || '',
              });
              if (j && j.ok && j.updated) moved++; else failed++;
            } catch { failed++; }
          }
          if (moved && !failed) cxToast(`Moved ${moved} item${moved === 1 ? '' : 's'} → ${c}`);
          else if (moved) cxToast(`Moved ${moved} items (${failed} failed).`, 'warn');
          else cxToast(`No items moved.`, 'warn');
          CX.selectedItems.clear();
          renderCxBulkbar();
          await loadCategoryExplorer();
        } catch { /* ignore */ }
        return;
      }
      if (pillPayload) {
        try {
          const src = JSON.parse(pillPayload);
          await renameL1(src.category, c);
        } catch { /* ignore */ }
        return;
      }
      if (rowPayload) {
        try {
          const parsed = JSON.parse(rowPayload);
          const srcs = Array.isArray(parsed) ? parsed : [parsed];
          await reparentL1(srcs, c);
        } catch { /* ignore */ }
        return;
      }
    });
    l1Row.appendChild(btn);
  }
  host.appendChild(l1Row);

  // --- Progressive sub-rows (retired in Phase 1 of the tree redesign) ---
  // The collapsible tree below now expresses drill-down natively. Rendering
  // duplicate pills here was the "two overlapping scope systems" friction
  // point. Bail early; the legacy code after this point is intentionally
  // unreachable and stays only as a reference during the transition.
  return;
  // Only render progressive pills when exactly one L1 is active — multi-L1
  // drill-down would be ambiguous (different categories have different L2
  // vocabularies).
  if (CX.pillFilter.size !== 1) return;
  const cat = Array.from(CX.pillFilter)[0];
  const tree = (CX.tree && CX.tree[cat]) || {};

  // Walk the tree one level deeper than the current subPath, emitting one
  // row per level. Stops when there are no further children.
  const pathSoFar = [];
  let node = tree;
  // Also render a row for levels already drilled into, so the user sees the
  // full breadcrumb of active sub-pills and can click to deselect/rewind.
  for (let depth = 0; depth <= CX.subPath.length; depth++) {
    const children = Object.keys(node || {});
    if (!children.length) break;
    // Count buckets per L(depth+2) child using prefix match on sub_category.
    const base = pathSoFar.length ? pathSoFar.join(':') : '';
    const childCount = new Map();
    for (const b of CX.buckets) {
      if ((b.category || '') !== cat) continue;
      const sub = b.sub_category || '';
      if (base) {
        if (sub !== base && !sub.startsWith(base + ':')) continue;
      }
      // Get the segment immediately after the current base.
      const rest = base ? sub.slice(base.length + 1) : sub;
      if (!rest) continue;
      const seg = rest.split(':')[0];
      if (!seg) continue;
      childCount.set(seg, (childCount.get(seg) || 0) + 1);
    }
    // Sort by count desc, then alpha.
    const childSegs = Array.from(childCount.keys()).sort((a, b) => {
      const da = childCount.get(b) - childCount.get(a);
      if (da !== 0) return da;
      return a.localeCompare(b);
    });
    if (!childSegs.length) break;

    const row = document.createElement('div');
    row.className = 'cx-pill-row cx-pill-sub';

    const arrow = document.createElement('span');
    arrow.className = 'cx-pill-arrow';
    arrow.textContent = '\u21B3'; // ↳
    row.appendChild(arrow);

    const activeSeg = CX.subPath[depth]; // undefined at the frontier level
    // Snapshot the prefix for this row — needed by drag handlers below, since
    // `pathSoFar` mutates as the loop walks deeper.
    const rowPathSoFar = pathSoFar.slice();
    for (const seg of childSegs) {
      const btn = document.createElement('button');
      btn.type = 'button';
      btn.className = 'cx-pill cx-pill-sub-item' + (activeSeg === seg ? ' active' : '');
      btn.draggable = true;
      btn.dataset.depth = String(depth);
      btn.dataset.seg = seg;
      btn.innerHTML = `${escapeHtml(seg)} <span class="cx-pill-count">${childCount.get(seg)}</span>`;
      btn.addEventListener('click', () => {
        if (CX.subPath[depth] === seg) {
          // Clicking the active segment at this level rewinds to this depth.
          CX.subPath = CX.subPath.slice(0, depth);
        } else {
          // Picking a new segment at this level truncates anything deeper.
          CX.subPath = CX.subPath.slice(0, depth).concat([seg]);
        }
        renderCxPills();
        renderCx();
        if (CX.split.on) renderCxSplitRight();
      });
      // Drag source: sub-pill → sub-pill at same depth/pathSoFar renames the
      // level across every bucket. Uses a level-tagged MIME so drops only
      // register when the depths match.
      btn.addEventListener('dragstart', (ev) => {
        ev.dataTransfer.effectAllowed = 'move';
        ev.dataTransfer.setData('application/x-cx-pill-sub', JSON.stringify({
          l1: cat,
          depth,
          pathSoFar: rowPathSoFar,
          value: seg,
        }));
        // A level-specific MIME lets dragover filter drop targets by depth.
        ev.dataTransfer.setData(`application/x-cx-pill-sub-depth-${depth}`, '1');
        btn.classList.add('cx-dragging');
        document.querySelector('.cx-pills')?.classList.add('cx-drop-armed');
      });
      btn.addEventListener('dragend', () => {
        btn.classList.remove('cx-dragging');
        document.querySelector('.cx-pills')?.classList.remove('cx-drop-armed');
        document.querySelectorAll('.cx-pill.cx-drop-over').forEach(el => el.classList.remove('cx-drop-over'));
      });
      // Drop target: only accept a sub-pill dragged from the same depth (and
      // implicitly the same L1+pathSoFar, since those are the pills visible
      // in this row of the pill tree).
      btn.addEventListener('dragover', (ev) => {
        const types = ev.dataTransfer?.types;
        if (!types?.includes(`application/x-cx-pill-sub-depth-${depth}`)) return;
        ev.preventDefault();
        ev.dataTransfer.dropEffect = 'move';
        btn.classList.add('cx-drop-over');
      });
      btn.addEventListener('dragleave', () => btn.classList.remove('cx-drop-over'));
      btn.addEventListener('drop', async (ev) => {
        ev.preventDefault();
        btn.classList.remove('cx-drop-over');
        const raw = ev.dataTransfer.getData('application/x-cx-pill-sub');
        if (!raw) return;
        let src;
        try { src = JSON.parse(raw); } catch { return; }
        // Extra safety: require same L1 + same prefix path + same depth.
        if (src.l1 !== cat || src.depth !== depth) return;
        if ((src.pathSoFar || []).join(':') !== rowPathSoFar.join(':')) return;
        if (src.value === seg) return;
        await renameSubLevel(cat, rowPathSoFar, depth, src.value, seg);
      });
      row.appendChild(btn);
    }
    host.appendChild(row);

    // Advance for the next iteration: only walks deeper if the user has
    // already picked a segment at this level.
    if (activeSeg === undefined) break;
    pathSoFar.push(activeSeg);
    node = node[activeSeg] || {};
  }
}

function wireCxAddButton() {
  const btn = document.getElementById('cx-add-btn');
  if (!btn || btn._wired) return;
  btn._wired = true;
  btn.addEventListener('click', openAddSubCategoryDialog);
}

// Phase 4 retired the select-mode toggle; checkboxes are always visible.
// The three stubs below are left as no-ops so any lingering callsites in
// loadCategoryExplorer() or future code don't break on an undefined symbol.
function wireCxSelectButton() { /* no-op: Phase 4 removed the toggle */ }
function updateSelectButton() { /* no-op */ }
function applySelectModeClass() { /* no-op */ }

function wireCxExpandButton() {
  const btn = document.getElementById('cx-expand-btn');
  if (!btn || btn._wired) return;
  btn._wired = true;
  btn.addEventListener('click', () => toggleCxExpand());
  // Esc exits fullscreen mode. Attach once, check the class inside.
  if (!wireCxExpandButton._escWired) {
    wireCxExpandButton._escWired = true;
    document.addEventListener('keydown', (ev) => {
      if (ev.key === 'Escape') {
        const wrap = document.querySelector('.cx-wrap.cx-expanded');
        if (wrap) toggleCxExpand();
      }
    });
  }
}

function toggleCxExpand() {
  const wrap = document.querySelector('.cx-wrap');
  const btn = document.getElementById('cx-expand-btn');
  if (!wrap) return;
  const goingOn = !wrap.classList.contains('cx-expanded');
  wrap.classList.toggle('cx-expanded', goingOn);
  if (btn) btn.textContent = goingOn ? '⤡ Collapse' : '⤢ Expand';
  // Add/remove the dim backdrop when entering/exiting fullscreen.
  let bd = document.querySelector('.cx-expand-backdrop');
  if (goingOn) {
    if (!bd) {
      bd = document.createElement('div');
      bd.className = 'cx-expand-backdrop';
      bd.addEventListener('click', () => toggleCxExpand());
      document.body.appendChild(bd);
    }
  } else if (bd) {
    bd.remove();
  }
  document.body.style.overflow = goingOn ? 'hidden' : '';
}

// Opens the split pane without toggling fullscreen. Called when the user
// pins a bucket but the pane is still closed.
function openSplitView() {
  CX.split.on = true;
  applySplitViewState();
}

function applySplitViewState() {
  const btn = document.getElementById('cx-split-btn');
  const split = document.getElementById('cx-split');
  const right = document.getElementById('cx-split-right');
  const divider = document.getElementById('cx-split-divider');
  const pills = document.querySelector('.cx-pills');
  if (btn) {
    btn.classList.toggle('cx-select-btn-on', CX.split.on);
    btn.textContent = CX.split.on ? 'Close compare' : 'Fullscreen Compare';
  }
  if (split) split.classList.toggle('split-on', CX.split.on);
  if (right) right.style.display = CX.split.on ? '' : 'none';
  if (divider) divider.style.display = CX.split.on ? '' : 'none';
  if (pills) pills.classList.toggle('scoped-right', CX.split.on);
  renderCxPills();
  renderCx();
  renderCxSplitRight();
  updateCxMoveArrow();
}

function wireCxSplitButton() {
  const btn = document.getElementById('cx-split-btn');
  if (!btn || btn._wired) return;
  btn._wired = true;
  btn.addEventListener('click', () => {
    // "Fullscreen Compare": turn split on AND enter fullscreen together, so
    // the pinned drop target gets maximum real estate. Clicking again exits
    // both. Pinning a bucket inline already opens the side pane by itself;
    // this button is the one-click path to the roomy version.
    const goingOn = !CX.split.on;
    CX.split.on = goingOn;
    // Resetting pill state is only meaningful when we're opening — the
    // scope-right / filter-left semantics flip here.
    if (goingOn) {
      CX.pillFilter.clear();
      CX.subPath = [];
    }
    const wrap = document.querySelector('.cx-wrap');
    const alreadyFullscreen = wrap?.classList.contains('cx-expanded');
    if (goingOn && !alreadyFullscreen) toggleCxExpand();
    else if (!goingOn && alreadyFullscreen) toggleCxExpand();
    applySplitViewState();
  });

  // Right pane-wide drop listeners: accept pills dropped ANYWHERE on the
  // right pane and convert them into a scope filter. This makes the whole
  // target side a big drop target for "show me only <this>'s subtree".
  const pane = document.getElementById('cx-split-right');
  if (pane && !pane._scopeWired) {
    pane._scopeWired = true;
    pane.addEventListener('dragover', (ev) => {
      const t = ev.dataTransfer?.types;
      if (!t) return;
      if (!(t.includes('application/x-cx-pill-l1') || t.includes('application/x-cx-pill-sub'))) return;
      ev.preventDefault();
      ev.dataTransfer.dropEffect = 'link';
      pane.classList.add('cx-drop-over-scope');
    });
    pane.addEventListener('dragleave', (ev) => {
      // Only clear when the pointer actually leaves the pane — not a child
      if (ev.target === pane) pane.classList.remove('cx-drop-over-scope');
    });
    pane.addEventListener('drop', (ev) => {
      const l1Raw = ev.dataTransfer.getData('application/x-cx-pill-l1');
      const subRaw = ev.dataTransfer.getData('application/x-cx-pill-sub');
      if (!l1Raw && !subRaw) return;
      ev.preventDefault();
      pane.classList.remove('cx-drop-over-scope');
      // Translate pill drops into the unified top-pill state. The main pills
      // now serve as the scope for the right pane, so dropping a pill here
      // is equivalent to clicking it up top.
      if (subRaw) {
        try {
          const src = JSON.parse(subRaw);
          CX.pillFilter = new Set([src.l1]);
          CX.subPath = [...(src.pathSoFar || []), src.value];
        } catch { return; }
      } else {
        try {
          const src = JSON.parse(l1Raw);
          CX.pillFilter = new Set([src.category]);
          CX.subPath = [];
        } catch { return; }
      }
      CX.split.query = '';
      CX.split.pinnedBucketKey = null;
      renderCxPills();
      renderCx();
      renderCxSplitRight();
    });
  }
}

// Enable/disable + label the split-divider arrow. Enabled when split view is
// on, there's at least one selected item, and a target is pinned. Clicking
// moves every selected item into the pinned bucket.
function updateCxMoveArrow() {
  const btn = document.getElementById('cx-move-arrow');
  const hint = document.getElementById('cx-move-arrow-hint');
  if (!btn || !hint) return;
  const n = CX.selectedItems.size;
  const pinned = CX.buckets.find(b => cxKey(b) === CX.split.pinnedBucketKey);
  const ready = CX.split.on && n > 0 && pinned;
  btn.disabled = !ready;
  if (!CX.split.on) {
    hint.innerHTML = '';
  } else if (!pinned) {
    hint.innerHTML = 'pick a<br>target<br>first';
  } else if (n === 0) {
    hint.innerHTML = 'select<br>items on<br>the left';
  } else {
    hint.innerHTML = `move<br><strong>${n}</strong><br>item${n === 1 ? '' : 's'}`;
  }
  if (!btn._wired) {
    btn._wired = true;
    btn.addEventListener('click', async () => {
      const pinnedNow = CX.buckets.find(b => cxKey(b) === CX.split.pinnedBucketKey);
      if (!pinnedNow || CX.selectedItems.size === 0) return;
      const items = Array.from(CX.selectedItems.values()).map(v => ({
        kind: v.kind, id: v.id, title: v.title || '',
        category: v._srcCategory || '', sub_category: v._srcSub || '',
      }));
      await moveItems(items, pinnedNow.category || '', pinnedNow.sub_category || '');
      renderCxSplitRight();
      updateCxMoveArrow();
    });
  }
}

// Render the right-hand drop-target pane. In split view, the main pill row
// at the top of the Category Explorer controls the scope here (pick an L1
// and optional sub-path to narrow the target list). This pane just shows
// the scoped options, the pinned target, a drop zone, and the target's items.
function renderCxSplitRight() {
  const host = document.getElementById('cx-split-right');
  if (!host) return;
  if (!CX.split.on) { host.innerHTML = ''; return; }
  host.innerHTML = '';

  const colorMap = (window.YR_SHARED?.CAT_COLOR) || {};

  const header = document.createElement('div');
  header.className = 'cx-split-right-header';

  const lbl = document.createElement('label');
  lbl.textContent = 'Target bucket (drop zone)';
  header.appendChild(lbl);

  // Scope = main pill state. In split mode the top pills single-select an L1
  // and CX.subPath tracks the drill-down path; both read-only here.
  const scopedL1 = CX.pillFilter.size === 1 ? Array.from(CX.pillFilter)[0] : null;
  const scopedSubPrefix = (CX.subPath || []).join(':');

  // Small breadcrumb showing what the top pills have scoped to — makes it
  // obvious that "the pills above filter this listbox".
  const scope = document.createElement('div');
  scope.className = 'cx-split-scope';
  if (scopedL1) {
    scope.style.setProperty('--cat-color', colorMap[scopedL1] || '#6b7280');
    scope.innerHTML = `scope (from pills above): <strong>${escapeHtml(scopedL1)}</strong>`
      + (scopedSubPrefix ? ` <code>${escapeHtml(scopedSubPrefix)}</code>` : '');
  } else {
    scope.style.setProperty('--cat-color', '#94a3b8');
    scope.innerHTML = `<span style="opacity:.85">scope: pick an L1 pill above to narrow the list</span>`;
  }
  header.appendChild(scope);

  // --- Search input (filters the options by text across cat:sub) ---
  const searchWrap = document.createElement('div');
  searchWrap.className = 'cx-split-search-wrap';
  const search = document.createElement('input');
  search.type = 'text';
  search.className = 'cx-split-target-picker';
  search.placeholder = CX.split.pinnedBucketKey
    ? 'Search to change target…'
    : 'Search target bucket…';
  search.value = CX.split.query || '';
  search.autocomplete = 'off';
  searchWrap.appendChild(search);

  // --- Pinned target chip (shown above the listbox) ---
  const pinned = CX.buckets.find(b => cxKey(b) === CX.split.pinnedBucketKey);
  if (pinned) {
    const pinChip = document.createElement('div');
    pinChip.className = 'cx-split-pinned';
    pinChip.style.setProperty('--cat-color', colorMap[pinned.category] || '#6b7280');
    pinChip.innerHTML = `pinned: <strong>${escapeHtml(pinned.category)}</strong> / <code>${escapeHtml(pinned.sub_category || '(none)')}</code> `;
    const clear = document.createElement('button');
    clear.type = 'button';
    clear.textContent = '\u00D7';
    clear.title = 'Unpin';
    clear.className = 'cx-split-pinned-clear';
    clear.addEventListener('click', () => {
      CX.split.pinnedBucketKey = null;
      renderCxSplitRight();
    });
    pinChip.appendChild(clear);
    searchWrap.appendChild(pinChip);
  }
  header.appendChild(searchWrap);

  // --- Filtered option list (listbox) ---
  const listbox = document.createElement('div');
  listbox.className = 'cx-split-listbox';
  const q = (CX.split.query || '').trim().toLowerCase();
  const scopePrefix = scopedSubPrefix.toLowerCase();
  const filtered = CX.buckets
    .filter(b => !scopedL1 || (b.category || '') === scopedL1)
    .filter(b => {
      if (!scopePrefix) return true;
      const sub = (b.sub_category || '').toLowerCase();
      return sub === scopePrefix || sub.startsWith(scopePrefix + ':');
    })
    .filter(b => {
      if (!q) return true;
      const hay = `${b.category || ''}:${b.sub_category || ''}`.toLowerCase();
      return hay.includes(q);
    })
    .sort((a, b) => {
      const ac = a.category || ''; const bc = b.category || '';
      if (ac !== bc) return ac.localeCompare(bc);
      return (a.sub_category || '').localeCompare(b.sub_category || '');
    })
    .slice(0, 100); // cap visible options so the DOM stays light on huge sets

  if (!filtered.length) {
    const none = document.createElement('div');
    none.className = 'cx-split-listbox-empty';
    none.textContent = 'No buckets match — try clearing the filter.';
    listbox.appendChild(none);
  } else {
    for (const b of filtered) {
      const opt = document.createElement('button');
      opt.type = 'button';
      opt.className = 'cx-split-opt';
      const key = cxKey(b);
      if (CX.split.pinnedBucketKey === key) opt.classList.add('active');
      opt.style.setProperty('--cat-color', colorMap[b.category] || '#6b7280');
      const nItems = Object.values(b.counts || {}).reduce((a, n) => a + n, 0);
      opt.innerHTML =
        `<span class="cx-split-opt-cat">${escapeHtml(b.category || '—')}</span>` +
        `<span class="cx-split-opt-sub">${escapeHtml(b.sub_category || '(no sub-category)')}</span>` +
        `<span class="cx-split-opt-count">${nItems}</span>`;
      opt.addEventListener('click', () => {
        CX.split.pinnedBucketKey = key;
        CX.split.query = '';
        renderCxSplitRight();
      });
      listbox.appendChild(opt);
    }
    // Visual hint if we truncated the list — encourage the user to refine.
    const matchingUnfiltered = CX.buckets.filter(b => {
      if (scopedL1 && (b.category || '') !== scopedL1) return false;
      if (scopePrefix) {
        const s = (b.sub_category || '').toLowerCase();
        if (s !== scopePrefix && !s.startsWith(scopePrefix + ':')) return false;
      }
      if (q && !`${b.category || ''}:${b.sub_category || ''}`.toLowerCase().includes(q)) return false;
      return true;
    }).length;
    if (matchingUnfiltered > filtered.length) {
      const more = document.createElement('div');
      more.className = 'cx-split-listbox-empty';
      more.textContent = `Showing 100 of ${matchingUnfiltered} — refine the search.`;
      listbox.appendChild(more);
    }
  }

  // Keep input focused across re-renders so typing feels continuous.
  search.addEventListener('input', () => {
    CX.split.query = search.value;
    renderCxSplitRight();
    // After re-render the new input element exists — put caret back at end.
    const newInput = document.querySelector('#cx-split-right .cx-split-target-picker');
    if (newInput) {
      newInput.focus();
      const v = newInput.value;
      newInput.setSelectionRange(v.length, v.length);
    }
  });
  // Enter → pick the first filtered result.
  search.addEventListener('keydown', (ev) => {
    if (ev.key === 'Enter' && filtered.length) {
      ev.preventDefault();
      CX.split.pinnedBucketKey = cxKey(filtered[0]);
      CX.split.query = '';
      renderCxSplitRight();
    } else if (ev.key === 'Escape') {
      CX.split.query = '';
      renderCxSplitRight();
    }
  });

  header.appendChild(listbox);
  host.appendChild(header);

  const drop = document.createElement('div');
  drop.className = 'cx-split-dropzone';
  drop.textContent = pinned
    ? `Drop items here → ${pinned.category}:${pinned.sub_category || '(no sub-category)'}`
    : 'Pick a target bucket above, then drop items here.';
  drop.addEventListener('dragover', (ev) => {
    if (!pinned) return;
    if (!ev.dataTransfer?.types.includes('application/x-cx-items')) return;
    ev.preventDefault();
    ev.dataTransfer.dropEffect = 'move';
    drop.classList.add('cx-drop-over');
  });
  drop.addEventListener('dragleave', () => drop.classList.remove('cx-drop-over'));
  drop.addEventListener('drop', async (ev) => {
    ev.preventDefault();
    drop.classList.remove('cx-drop-over');
    if (!pinned) return;
    const raw = ev.dataTransfer.getData('application/x-cx-items');
    if (!raw) return;
    let items;
    try { items = JSON.parse(raw); } catch { return; }
    if (!Array.isArray(items) || !items.length) return;
    await moveItems(items, pinned.category || '', pinned.sub_category || '');
    renderCxSplitRight();
  });
  host.appendChild(drop);

  const list = document.createElement('div');
  list.className = 'cx-split-right-list';
  if (!pinned) {
    const empty = document.createElement('div');
    empty.className = 'cx-split-right-empty';
    empty.textContent = 'No bucket pinned yet.';
    list.appendChild(empty);
  } else if (!pinned.items?.length) {
    const empty = document.createElement('div');
    empty.className = 'cx-split-right-empty';
    empty.textContent = 'This bucket is empty. Drop items here to populate it.';
    list.appendChild(empty);
  } else {
    for (const it of pinned.items) {
      list.appendChild(renderCxItemRow(it, pinned));
    }
  }
  host.appendChild(list);
  updateCxMoveArrow();
}

// Bulk-action strip shown above the bucket list whenever at least one row
// is checked. Contents re-paint every time the selection changes.
function renderCxBulkbar() {
  const host = document.getElementById('cx-bulkbar');
  if (!host) return;
  const bucketN = CX.selected.size;
  const itemN = CX.selectedItems.size;
  // The bulkbar is driven by selection now instead of a mode toggle.
  if (bucketN === 0 && itemN === 0) {
    host.style.display = 'none';
    host.innerHTML = '';
    return;
  }
  host.style.display = '';
  host.innerHTML = '';
  const parts = [];
  if (bucketN) parts.push(`<strong>${bucketN}</strong> bucket${bucketN === 1 ? '' : 's'}`);
  if (itemN) parts.push(`<strong>${itemN}</strong> item${itemN === 1 ? '' : 's'}`);
  const count = document.createElement('span');
  count.innerHTML = parts.join(' + ') + ' selected';
  host.appendChild(count);

  const pinned = CX.buckets.find(b => cxKey(b) === CX.split.pinnedBucketKey);
  const hint = document.createElement('span');
  hint.style.cssText = 'font-size:11.5px;color:#1e3a8a;opacity:.85;margin-left:10px';
  if (pinned) hint.textContent = `— pinned target: ${pinned.category}:${pinned.sub_category || '(none)'}`;
  else if (itemN > 0) hint.textContent = '— drag onto a bucket or L1 pill, or pin a target 📍';
  else if (bucketN > 0) hint.textContent = '— drag any selected row onto an L1 pill to reparent';
  host.appendChild(hint);

  const spacer = document.createElement('div');
  spacer.className = 'spacer';
  host.appendChild(spacer);

  // Quick "Move to pinned" — when a target is pinned, one-click ships the
  // selection to it without opening the full picker.
  if (pinned && (itemN > 0 || bucketN > 0)) {
    const moveBtn = document.createElement('button');
    moveBtn.className = 'btn btn-sm btn-primary';
    moveBtn.textContent = `→ ${pinned.category}:${pinned.sub_category || '—'}`;
    moveBtn.title = 'Send the selection to the pinned target bucket';
    moveBtn.addEventListener('click', async () => {
      if (itemN > 0) {
        const items = Array.from(CX.selectedItems.values()).map(v => ({
          kind: v.kind, id: v.id, title: v.title || '',
          category: v._srcCategory || '', sub_category: v._srcSub || '',
        }));
        await moveItems(items, pinned.category || '', pinned.sub_category || '');
      }
      if (bucketN > 0) {
        const srcs = CX.buckets.filter(b => CX.selected.has(cxKey(b)));
        // Search-scoped safety: route per-item retag so filtered-out siblings
        // don't ride along on a path-level remap.
        if (CX.search) {
          const items = visibleItemsFromBuckets(srcs);
          if (items.length) await moveItems(items, pinned.category || '', pinned.sub_category || '');
          else cxToast('Selected buckets have no visible items to move.', 'warn');
        } else {
          const moves = srcs.map(b => ({
            from_category: b.category || '', from_sub_category: b.sub_category || '',
            to_category: pinned.category || '', to_sub_category: pinned.sub_category || '',
            include_prefix: true,
          }));
          if (moves.length) await bulkRemap(moves, `Selection → ${pinned.category}:${pinned.sub_category || '—'}`);
        }
      }
    });
    host.appendChild(moveBtn);
  }

  if (bucketN) {
    const mergeBtn = document.createElement('button');
    mergeBtn.className = 'btn btn-sm';
    mergeBtn.textContent = 'Full picker\u2026';
    mergeBtn.title = 'Open the full merge picker for the selected buckets';
    mergeBtn.addEventListener('click', () => {
      const srcs = CX.buckets.filter(b => CX.selected.has(cxKey(b)));
      if (!srcs.length) return;
      openBulkMergeDialog(srcs);
    });
    host.appendChild(mergeBtn);
  }

  const clearBtn = document.createElement('button');
  clearBtn.className = 'btn btn-sm';
  clearBtn.textContent = 'Clear';
  clearBtn.addEventListener('click', () => {
    CX.selected.clear();
    CX.selectedItems.clear();
    renderCxBulkbar();
    renderCx();
  });
  host.appendChild(clearBtn);
}

// Drag badge REMOVED — it was the "drag only works once, then needs a
// reload" culprit. setDragImage() is a known rough edge in HTML5 DnD:
// on several Chromium + Safari versions, an off-screen element passed
// as a drag image can poison the drag-source session so subsequent
// dragstart events silently fail until the page unloads.
//
// Stub kept as a no-op so existing callsites (5+ dragstart handlers)
// don't need to be individually stripped. The count was a nice-to-have,
// not load-bearing; the drag row itself serves as the default ghost.
// If the count matters later, re-introduce it via a manually positioned
// pill that follows the cursor on `drag` events — never via setDragImage.
function setDragBadge(/* ev, n, kindLabel */) { /* no-op */ }
function clearDragBadge() { /* no-op */ }

function cxToastHost() {
  let host = document.getElementById('cx-toast-host');
  if (!host) {
    host = document.createElement('div');
    host.id = 'cx-toast-host';
    host.style.cssText = 'position:fixed;top:16px;right:16px;z-index:9999;display:flex;flex-direction:column;gap:6px;pointer-events:none';
    document.body.appendChild(host);
  }
  return host;
}

// Small ephemeral toast anchored to the top-right. Used for quick status
// feedback where no undo is needed (warnings, no-op notices, errors).
function cxToast(msg, kind = 'info') {
  const host = cxToastHost();
  const t = document.createElement('div');
  const bg = kind === 'error' ? '#dc2626' : kind === 'warn' ? '#d97706' : '#16a34a';
  t.style.cssText = `background:${bg};color:#fff;padding:8px 14px;border-radius:6px;font-size:13px;box-shadow:0 4px 12px rgba(0,0,0,.15);max-width:340px`;
  t.textContent = msg;
  host.appendChild(t);
  setTimeout(() => { t.style.transition = 'opacity .25s'; t.style.opacity = '0'; }, 2600);
  setTimeout(() => t.remove(), 3000);
}

// Snackbar with a live Undo button + countdown. Replaces the confirm()
// popups that used to front every merge/rename — actions fire immediately
// and the user gets ~8 seconds to reverse the change. Clicking Undo runs
// the supplied undoFn and dismisses the snackbar. The underlying endpoint
// writes .bak files on every mutation so even missed undo windows are
// recoverable from disk.
function cxUndoable(message, undoFn, opts = {}) {
  const ttl = opts.ttl ?? 8000;
  const host = cxToastHost();
  const t = document.createElement('div');
  t.style.cssText = `
    background:#0f172a;color:#fff;padding:10px 14px;border-radius:6px;
    font-size:13px;box-shadow:0 6px 18px rgba(0,0,0,.25);min-width:280px;max-width:420px;
    display:flex;align-items:center;gap:10px;pointer-events:auto;
  `;
  const msg = document.createElement('span');
  msg.style.cssText = 'flex:1;line-height:1.35';
  msg.textContent = message;
  t.appendChild(msg);

  const btn = document.createElement('button');
  btn.type = 'button';
  btn.textContent = 'Undo';
  btn.style.cssText = `
    background:transparent;border:1px solid rgba(255,255,255,.4);color:#fff;
    padding:3px 10px;border-radius:4px;font-size:12px;font-weight:600;
    cursor:pointer;letter-spacing:.3px;
  `;
  t.appendChild(btn);

  const bar = document.createElement('div');
  bar.style.cssText = `
    position:absolute;left:0;bottom:0;height:2px;background:#60a5fa;
    width:100%;transform-origin:left;transition:transform ${ttl}ms linear;
  `;
  t.style.position = 'relative';
  t.appendChild(bar);
  // kick off the countdown after the element is painted so the animation
  // actually plays (transitions from an already-applied value are no-ops).
  requestAnimationFrame(() => { bar.style.transform = 'scaleX(0)'; });

  host.appendChild(t);

  let dismissed = false;
  const dismiss = () => {
    if (dismissed) return;
    dismissed = true;
    t.style.transition = 'opacity .2s';
    t.style.opacity = '0';
    setTimeout(() => t.remove(), 220);
  };
  btn.addEventListener('click', async () => {
    if (dismissed) return;
    btn.disabled = true;
    btn.textContent = 'Undoing…';
    try { await undoFn(); } catch (e) { cxToast(`Undo failed: ${e.message || e}`, 'error'); }
    dismiss();
  });
  const timer = setTimeout(dismiss, ttl);
  // If the host scrolls out or the next action fires, allow manual dismissal
  // by clicking anywhere on the snackbar background (not the button).
  t.addEventListener('click', (ev) => { if (ev.target !== btn) { clearTimeout(timer); dismiss(); } });
  return { dismiss };
}

// Flip a move's direction so it undoes itself. Used by bulkRemap + callers
// to assemble undo specs.
function reverseMove(m) {
  return {
    from_category: m.to_category || '',
    from_sub_category: m.to_sub_category || '',
    to_category: m.from_category || '',
    to_sub_category: m.from_sub_category || '',
    include_prefix: !!m.include_prefix,
  };
}

// Generic remap executor. Fires one /api/remap-category POST per move,
// aggregates counts, and refreshes the explorer. Returns {total, failures,
// applied} so callers can feed `applied.map(reverseMove)` into cxUndoable
// and offer a one-click reversal. Default behaviour surfaces an undo
// snackbar; pass {silent: true} to suppress (e.g. when the caller owns
// the UX, like an undo operation undoing itself).
async function bulkRemap(moves, actionLabel, opts = {}) {
  const silent = !!opts.silent;
  if (!moves.length) {
    if (!silent) cxToast('Nothing to move.', 'warn');
    return { total: 0, failures: 0, applied: [] };
  }
  const totals = { tasks: 0, activities: 0, emails: 0, events: 0, yr: 0 };
  let failures = 0;
  const applied = [];
  for (const m of moves) {
    try {
      const res = await fetch('/api/remap-category', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          from_category: m.from_category || '',
          from_sub_category: m.from_sub_category || '',
          to_category: m.to_category || '',
          to_sub_category: m.to_sub_category || '',
          include_prefix: !!m.include_prefix,
        }),
      });
      const j = await res.json();
      if (!j.ok) { failures++; continue; }
      const c = j.counts || {};
      const moved = Object.values(c).reduce((a, v) => a + (v || 0), 0);
      if (moved > 0) applied.push(m);         // only reverse moves that actually moved something
      for (const k of Object.keys(totals)) totals[k] += (c[k] || 0);
    } catch {
      failures++;
    }
  }
  const total = Object.values(totals).reduce((a, b) => a + b, 0);

  if (!silent) {
    if (failures && total === 0) {
      cxToast(`${actionLabel} failed for all ${failures} bucket${failures === 1 ? '' : 's'}.`, 'error');
    } else if (applied.length === 0) {
      cxToast(`${actionLabel}: no items moved.`, 'warn');
    } else {
      const suffix = failures ? ` (${failures} failed)` : '';
      cxUndoable(
        `${actionLabel}: ${total} item${total === 1 ? '' : 's'}${suffix}`,
        async () => {
          await bulkRemap(applied.map(reverseMove), `Undo: ${actionLabel}`, { silent: true });
          await loadCategoryExplorer();
        },
      );
    }
  }
  CX.selected.clear();
  renderCxBulkbar();
  await loadCategoryExplorer();
  return { total, failures, applied };
}

// Move individual items via /api/retag-item. One POST per item; aggregates
// per-item success/failure. Stores each item's pre-move (category, sub) so
// undo can restore it one call at a time. Pass {silent: true} to suppress
// the snackbar (used by the undo path itself).
// Flatten an array of buckets into per-item payloads (kind/id + source
// cat/sub) for retag-item. Used by the "search-scoped merge" path so
// bucket-level gestures during an active filter only move the items that
// are currently visible — not every sibling the LLM lumped into the same
// (category, sub_category) tuple. Returns an empty array when no bucket
// carries a visible item.
function visibleItemsFromBuckets(buckets) {
  const items = [];
  for (const b of buckets) {
    for (const it of (b.items || [])) {
      items.push({
        kind: it.kind, id: it.id, title: it.title || '',
        category: b.category || '',
        sub_category: b.sub_category || '',
      });
    }
  }
  return items;
}

async function moveItems(items, toCategory, toSub, opts = {}) {
  const silent = !!opts.silent;
  if (!items?.length) return { moved: 0, failed: 0, applied: [] };
  const moves = items.filter(it => (it.category || '') !== toCategory || (it.sub_category || '') !== (toSub || ''));
  if (!moves.length) {
    if (!silent) cxToast(`Already at ${toCategory}${toSub ? ':' + toSub : ''}.`, 'warn');
    return { moved: 0, failed: 0, applied: [] };
  }
  let ok = 0, fail = 0;
  const applied = [];  // each: {kind, id, prevCategory, prevSub}
  for (const it of moves) {
    try {
      const j = await retagItemWithSync({
        kind: it.kind, id: it.id,
        category: toCategory, sub_category: toSub || '',
      });
      if (j && j.ok && j.updated) {
        ok++;
        applied.push({ kind: it.kind, id: it.id, prevCategory: it.category || '', prevSub: it.sub_category || '' });
      } else fail++;
    } catch { fail++; }
  }
  if (!silent) {
    if (ok && applied.length) {
      const suffix = fail ? ` (${fail} failed)` : '';
      cxUndoable(
        `Moved ${ok} item${ok === 1 ? '' : 's'} → ${toCategory}${toSub ? ':' + toSub : ''}${suffix}`,
        async () => {
          // Undo by retagging each applied item back to its previous (cat, sub).
          for (const a of applied) {
            try {
              await retagItemWithSync({
                kind: a.kind, id: a.id,
                category: a.prevCategory, sub_category: a.prevSub,
              });
            } catch { /* best-effort */ }
          }
          await loadCategoryExplorer();
        },
      );
    } else {
      cxToast(`Could not move any of ${moves.length} items.`, 'error');
    }
  }
  CX.selectedItems.clear();
  renderCxBulkbar();
  await loadCategoryExplorer();
  return { moved: ok, failed: fail, applied };
}

// Inline rename workflow. Turns the tree-node label into a contenteditable
// span so the user can retype the segment in place and commit with Enter.
// Escape reverts. Commit fires a remap of every matching bucket across all
// stores. No modal, no confirm — mistakes are recoverable via the undo
// snackbar (Phase 3) and the .bak files the endpoint writes.
function beginInlineRename(labelEl, node) {
  const original = node.label;
  labelEl.contentEditable = 'true';
  labelEl.classList.add('cx-tree-label-editing');
  labelEl.focus();
  // Select all so typing replaces the whole segment.
  const sel = window.getSelection();
  const range = document.createRange();
  range.selectNodeContents(labelEl);
  sel.removeAllRanges();
  sel.addRange(range);

  let committed = false;
  const commit = async () => {
    if (committed) return;
    committed = true;
    labelEl.contentEditable = 'false';
    labelEl.classList.remove('cx-tree-label-editing');
    const raw = (labelEl.textContent || '').trim();
    if (!raw || raw === original) {
      labelEl.textContent = original;
      return;
    }
    // Normalize to lowercase kebab-case so inline edits feed the same slug
    // format the rest of the taxonomy uses.
    const clean = raw.toLowerCase().replace(/\s+/g, '-').replace(/[^a-z0-9\-]/g, '-').replace(/-+/g, '-').replace(/^-|-$/g, '');
    if (!clean || clean === original) {
      labelEl.textContent = original;
      return;
    }
    labelEl.textContent = clean;
    await inlineRenameNode(node, clean);
  };
  const cancel = () => {
    if (committed) return;
    committed = true;
    labelEl.contentEditable = 'false';
    labelEl.classList.remove('cx-tree-label-editing');
    labelEl.textContent = original;
  };
  labelEl.addEventListener('keydown', (ev) => {
    if (ev.key === 'Enter') { ev.preventDefault(); commit(); }
    else if (ev.key === 'Escape') { ev.preventDefault(); cancel(); }
  });
  labelEl.addEventListener('blur', commit, { once: true });
}

// Issue the right kind of remap for a tree node's inline rename. L1 (depth=0)
// renames fire a bulk move from one category to another; deeper renames
// rewrite exactly one sub_category segment across every matching bucket.
async function inlineRenameNode(node, newLabel) {
  if (node.depth === 0) {
    // L1 rename: every bucket whose category equals the old label moves to
    // the new L1 category, keeping sub_category intact.
    const affected = CX.buckets.filter(b => (b.category || '') === node.label);
    if (!affected.length) return;
    const moves = affected.map(b => ({
      from_category: node.label, from_sub_category: b.sub_category || '',
      to_category: newLabel,    to_sub_category: b.sub_category || '',
      include_prefix: false,
    }));
    await bulkRemap(moves, `Rename L1: ${node.label} → ${newLabel}`);
    return;
  }
  // Sub-level rename: find every bucket where the sub_category segment at
  // this node's depth equals the old label (and the path-so-far prefix
  // matches), then rewrite just that segment.
  const pathSoFar = node.subSegments.slice(0, -1);
  const base = pathSoFar.join(':');
  const subIdx = node.depth - 1;                // 0-based within sub_category
  const affected = CX.buckets.filter(b => {
    if ((b.category || '') !== node.l1) return false;
    const s = b.sub_category || '';
    if (base && s !== base && !s.startsWith(base + ':')) return false;
    const segs = s.split(':');
    return segs[subIdx] === node.label;
  });
  if (!affected.length) return;
  const moves = affected.map(b => {
    const parts = (b.sub_category || '').split(':');
    parts[subIdx] = newLabel;
    return {
      from_category: node.l1, from_sub_category: b.sub_category || '',
      to_category: node.l1,   to_sub_category: parts.join(':'),
      include_prefix: false,
    };
  });
  await bulkRemap(moves, `Rename ${node.label} → ${newLabel}`);
}

// Drag-merge between tree nodes. Two flavors, selected by the drop-time
// Shift key:
//
//   • NEST (default, no Shift): the dragged category becomes a SUB-CATEGORY
//     of the target. Source's own label is preserved in the new path.
//       teaching:student-committee:cason-hancock  ─dropped on→  research:mentorship
//       → research:mentorship:cason-hancock  (and :cason-hancock:phd, etc.)
//
//   • CONTENTS-ONLY (Shift held): flatten the source INTO the target. Source's
//     own label is dropped; only its descendants land under the target.
//       teaching:student-committee:cason-hancock  ─Shift-dropped on→  research:mentorship
//       → research:mentorship                      (items previously at cason-hancock)
//       → research:mentorship:phd                  (items previously at cason-hancock:phd)
//
// Works at every depth (L1↔L1, L2↔L3, cross-L1, etc.). An L1 source with no
// subSegments has an empty label relative to its own sub_category; for it,
// NEST uses the source's L1 slug as the new folder name under the target.
async function mergeTreeNodes(srcNode, tgtNode, opts = {}) {
  if (srcNode.path === tgtNode.path) return;
  const nest = opts.nest !== false;  // default true — user must opt OUT with Shift
  const srcL1 = srcNode.l1;
  const srcSub = srcNode.subSegments.join(':');
  const tgtL1 = tgtNode.l1;
  const tgtSub = tgtNode.subSegments.join(':');

  const affected = CX.buckets.filter(b => {
    if ((b.category || '') !== srcL1) return false;
    const s = b.sub_category || '';
    if (!srcSub) return true;
    return s === srcSub || s.startsWith(srcSub + ':');
  });
  if (!affected.length) {
    cxToast('Nothing to merge — source is empty.', 'warn');
    return;
  }

  // Compute the effective target prefix once. In nest mode we append the
  // source's own label so it becomes a folder under the target; in contents-
  // only mode we just use the target's sub as-is.
  const srcLabel = srcNode.label || srcL1;  // fall back to L1 slug for root-level drags
  const tgtPrefix = nest
    ? (tgtSub ? `${tgtSub}:${srcLabel}` : srcLabel)
    : tgtSub;

  // Derive the rewritten sub_category for one affected bucket, given the
  // chosen tgtPrefix. Shared across the search-scoped and default branches.
  const rewriteSub = (s) => {
    if (!srcSub) {
      // srcSub empty = L1 root drag; s is the bucket's whole sub_category.
      return tgtPrefix ? (tgtPrefix + (s ? ':' + s : '')) : s;
    }
    if (s === srcSub) return tgtPrefix;
    const tail = s.slice(srcSub.length + 1);  // +1 skips the separator
    return tgtPrefix ? (tgtPrefix + ':' + tail) : tail;
  };

  // Search-scoped safety: a path-level remap during an active filter would
  // pull every sibling back into motion. When CX.search is set the bucket's
  // `items` array already holds only matches, so route per-item via retag-
  // item.
  if (CX.search) {
    let moved = 0;
    for (const b of affected) {
      if (!b.items?.length) continue;
      const s = b.sub_category || '';
      const items = b.items.map(it => ({
        kind: it.kind, id: it.id, title: it.title || '',
        category: b.category || '', sub_category: s,
      }));
      await moveItems(items, tgtL1, rewriteSub(s));
      moved += items.length;
    }
    if (!moved) cxToast('No visible items under this source.', 'warn');
    return;
  }

  const moves = affected.map(b => ({
    from_category: srcL1, from_sub_category: b.sub_category || '',
    to_category:   tgtL1, to_sub_category:   rewriteSub(b.sub_category || ''),
    include_prefix: false,
  }));
  const label = nest
    ? `${srcNode.path} → ${tgtNode.path} (nested)`
    : `${srcNode.path} → ${tgtNode.path} (flatten)`;
  await bulkRemap(moves, label);
}

// Drag-drop reparent: keep each source's sub_category (and every deeper path)
// intact, only swap L1. Uses include_prefix=true so subtrees travel with their
// root. Same-L1 sources are skipped (no-op). Accepts one or many sources.
async function reparentL1(srcs, toCategory) {
  if (!Array.isArray(srcs)) srcs = [srcs];
  if (!toCategory) return;
  const cands = srcs.filter(s => (s.category || '') !== toCategory);
  if (!cands.length) {
    cxToast(`All selected buckets are already in "${toCategory}".`, 'warn');
    return;
  }
  // Search-scoped safety: when a filter is active, the bucket's `items` array
  // has already been narrowed to matches. A path-level remap (include_prefix)
  // would sweep every sibling the user filtered OUT back into motion, which
  // was the "I merged 3 items but 47 moved" bug. Re-route to retag-item per
  // visible item so the move tracks what's on screen.
  if (CX.search) {
    const liveBuckets = cands
      .map(s => CX.buckets.find(b => (b.category || '') === s.category && (b.sub_category || '') === (s.sub_category || '')))
      .filter(Boolean);
    const items = visibleItemsFromBuckets(liveBuckets);
    if (!items.length) {
      cxToast('Nothing visible to reparent — clear the search or check items directly.', 'warn');
      return;
    }
    // Preserve each item's sub_category; only flip its L1 to the target.
    for (const it of items) it._tgtSub = it.sub_category;
    // Group by sub_category so we issue one moveItems call per destination:
    // same sub_category → same toSub.
    const byTgtSub = new Map();
    for (const it of items) {
      const k = it.sub_category || '';
      if (!byTgtSub.has(k)) byTgtSub.set(k, []);
      byTgtSub.get(k).push(it);
    }
    for (const [tgtSub, group] of byTgtSub) {
      await moveItems(group, toCategory, tgtSub);
    }
    return;
  }
  const moves = cands.map(s => ({
    from_category: s.category || '',
    from_sub_category: s.sub_category || '',
    to_category: toCategory,
    to_sub_category: s.sub_category || '',
    include_prefix: true,
  }));
  await bulkRemap(moves, `Reparent → ${toCategory}`);
}

// L1-pill → L1-pill drag. Moves every bucket whose L1 equals `fromCategory`
// into `toCategory`, preserving each bucket's sub_category.
async function renameL1(fromCategory, toCategory) {
  if (!fromCategory || !toCategory || fromCategory === toCategory) return;
  const affected = CX.buckets.filter(b => (b.category || '') === fromCategory);
  if (!affected.length) {
    cxToast(`No buckets in "${fromCategory}".`, 'warn');
    return;
  }
  // Search-scoped safety: even with include_prefix=false, a path-level remap
  // moves EVERY item at that exact (cat, sub) pair — not just the ones the
  // search filter is showing. Route per-item when a filter is active.
  if (CX.search) {
    // Group visible items by sub_category so each group can land at the
    // matching sub under the new L1.
    const bySub = new Map();
    for (const b of affected) {
      for (const it of (b.items || [])) {
        const k = b.sub_category || '';
        if (!bySub.has(k)) bySub.set(k, []);
        bySub.get(k).push({ kind: it.kind, id: it.id, title: it.title || '',
          category: fromCategory, sub_category: k });
      }
    }
    if (!bySub.size) {
      cxToast('No visible items under this L1.', 'warn');
      return;
    }
    for (const [sub, items] of bySub) await moveItems(items, toCategory, sub);
  } else {
    const moves = affected.map(b => ({
      from_category: fromCategory,
      from_sub_category: b.sub_category || '',
      to_category: toCategory,
      to_sub_category: b.sub_category || '',
      include_prefix: false,
    }));
    await bulkRemap(moves, `${fromCategory} → ${toCategory}`);
  }
  // After a big L1 collapse the filter pill disappears, so clear it.
  CX.pillFilter.delete(fromCategory);
  CX.subPath = [];
  renderCxPills();
  renderCx();
}

// Sub-pill → sub-pill drag. Both pills must live at the same depth under the
// same L1 and the same `pathSoFar` prefix. Every bucket whose segment at that
// depth equals `fromSeg` has that segment rewritten to `toSeg`; deeper paths
// stay intact. Example: drag `f25` onto `s25` under teaching:course:bme-466-566
// → every `teaching:course:bme-466-566:f25[:*]` becomes `…:s25[:*]`.
async function renameSubLevel(l1, pathSoFar, depth, fromSeg, toSeg) {
  if (fromSeg === toSeg) return;
  const base = pathSoFar.join(':');
  const affected = CX.buckets.filter(b => {
    if ((b.category || '') !== l1) return false;
    const sub = b.sub_category || '';
    if (base && sub !== base && !sub.startsWith(base + ':')) return false;
    const segs = sub.split(':');
    return segs[depth] === fromSeg;
  });
  if (!affected.length) {
    cxToast(`No buckets to rename.`, 'warn');
    return;
  }
  const moves = affected.map(b => {
    const parts = (b.sub_category || '').split(':');
    parts[depth] = toSeg;
    return {
      from_category: l1,
      from_sub_category: b.sub_category || '',
      to_category: l1,
      to_sub_category: parts.join(':'),
      include_prefix: false,
    };
  });
  await bulkRemap(moves, `Rename "${fromSeg}" → "${toSeg}"`);
  // Drilled-down path may have just been rewritten — update if so.
  if (pathSoFar.join(':') === base && CX.subPath[depth] === fromSeg) {
    CX.subPath[depth] = toSeg;
  }
  renderCxPills();
}

async function openAddSubCategoryDialog() {
  // Lightweight modal — reuse the cx-dialog-back/.cx-dialog styles from the
  // merge dialog so the look stays consistent.
  const back = document.createElement('div');
  back.className = 'cx-dialog-back';
  const dlg = document.createElement('div');
  dlg.className = 'cx-dialog';
  dlg.innerHTML = `
    <h3>Add sub-category</h3>
    <p style="margin:0 0 10px 0;font-size:12.5px;color:#6b7280">
      Adds a path to <code>data/settings/category_seeds.json</code> so it shows up in
      pickers and this explorer even with zero items attached. Perfect for
      pre-creating a bucket you know you'll fill later.
    </p>
    <div style="display:flex;flex-direction:column;gap:10px">
      <label style="font-size:12px;color:#374151;font-weight:600">Category
        <select id="asc-cat" style="display:block;width:100%;margin-top:4px;padding:6px;font-size:13px;border:1px solid #d1d5db;border-radius:4px"></select>
      </label>
      <label style="font-size:12px;color:#374151;font-weight:600">Sub-category path
        <input type="text" id="asc-sub" placeholder="e.g. grant:nih:r01:my-new-project"
          style="display:block;width:100%;margin-top:4px;padding:6px;font-size:13px;border:1px solid #d1d5db;border-radius:4px;font-family:ui-monospace,SFMono-Regular,Menlo,monospace">
      </label>
      <div style="font-size:11.5px;color:#6b7280">
        Use colons to nest: <code>activity:context:specific</code>. Segments are lower-cased and
        hyphenated automatically.
      </div>
    </div>
    <div class="cx-dialog-foot">
      <div class="spacer"></div>
      <button type="button" class="btn" id="asc-cancel">Cancel</button>
      <button type="button" class="btn btn-primary" id="asc-add">Add</button>
    </div>
  `;
  back.appendChild(dlg);
  document.body.appendChild(back);

  // Populate the category <select> from the canonical list.
  const cats = (window.YR_SHARED?.CAT_ORDER) || [
    'research', 'teaching', 'service', 'admin', 'personal', 'noise', 'unknown',
  ];
  const sel = dlg.querySelector('#asc-cat');
  for (const c of cats) {
    const opt = document.createElement('option');
    opt.value = c; opt.textContent = c;
    sel.appendChild(opt);
  }
  sel.value = 'research';
  setTimeout(() => dlg.querySelector('#asc-sub').focus(), 20);

  const close = () => { back.remove(); };
  dlg.querySelector('#asc-cancel').addEventListener('click', close);
  back.addEventListener('click', (ev) => { if (ev.target === back) close(); });

  dlg.querySelector('#asc-add').addEventListener('click', async () => {
    const cat = (sel.value || '').trim();
    let sub = (dlg.querySelector('#asc-sub').value || '').trim();
    if (!cat) { alert('Pick a category.'); return; }
    if (!sub) { alert('Enter a sub-category path.'); return; }
    // Slugify each segment locally so the saved path is canonical.
    sub = sub.split(':').map(s =>
      s.trim().toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '')
    ).filter(Boolean).join(':');
    if (!sub) { alert('Path is empty after slugifying.'); return; }
    try {
      await addCategorySeed(cat, sub);
      close();
      await loadCategoryExplorer();
    } catch (e) {
      alert('Add failed: ' + e.message);
    }
  });
}

// Append a {category, sub_category} path to category_seeds.json. Idempotent —
// skips duplicates. Generic /api/data handler writes the file.
async function addCategorySeed(category, sub_category) {
  let doc;
  try {
    doc = await api.load('settings/category_seeds.json');
  } catch {
    doc = { paths: [] };
  }
  if (!Array.isArray(doc.paths)) doc.paths = [];
  const exists = doc.paths.some(p =>
    (p.category || '') === category && (p.sub_category || '') === sub_category
  );
  if (!exists) {
    doc.paths.push({ category, sub_category, added_at: new Date().toISOString() });
    await api.save('settings/category_seeds.json', doc);
  }
}

// Remove every seed whose (category, sub_category) falls under the given tree
// node's subtree. Used after a delete so the cleared paths don't linger as
// empty buckets. Returns the number of seed rows removed.
async function removeCategorySeedsUnder(node) {
  let doc;
  try {
    doc = await api.load('settings/category_seeds.json');
  } catch {
    return 0;
  }
  if (!Array.isArray(doc?.paths)) return 0;
  const srcL1 = node.l1;
  const srcSub = node.subSegments.join(':');
  const keep = doc.paths.filter(p => {
    if ((p.category || '') !== srcL1) return true;
    const s = p.sub_category || '';
    if (!srcSub) return false;                    // L1 delete — drop every seed in this L1
    if (s === srcSub) return false;
    if (s.startsWith(srcSub + ':')) return false;
    return true;
  });
  const removed = doc.paths.length - keep.length;
  if (removed > 0) {
    doc.paths = keep;
    await api.save('settings/category_seeds.json', doc);
  }
  return removed;
}

// Modal for deleting a tree node (L1, pathway, or direct-bucket). If the
// subtree contains items, forces the user to pick a destination category so
// the items are preserved — no silent data loss. Empty subtrees short-circuit
// to a plain confirm.
function openDeleteCategoryDialog(node) {
  const back = document.createElement('div');
  back.className = 'cx-dialog-back';
  const dlg = document.createElement('div');
  dlg.className = 'cx-dialog';

  const n = node.rollupCount;
  const header = document.createElement('h3');
  header.innerHTML = `Delete <code>${escapeHtml(node.path)}</code>?`;
  dlg.appendChild(header);

  const intro = document.createElement('p');
  intro.style.cssText = 'margin:0 0 10px 0;font-size:12.5px;color:#6b7280';
  if (n === 0) {
    intro.innerHTML = `This category is empty. Its seed entry will be removed from <code>data/settings/category_seeds.json</code>.`;
  } else {
    intro.innerHTML = `<strong>${n}</strong> item${n === 1 ? '' : 's'} currently live under this path. Pick where they should go — the category itself will then be removed.`;
  }
  dlg.appendChild(intro);

  let picker = null;
  if (n > 0) {
    const pickerWrap = document.createElement('div');
    pickerWrap.style.cssText = 'margin:8px 0';
    picker = YR_SHARED.renderPicker({
      ctx: { category: '', sub_category: '' },
      tree: CX.tree,
      counts: CX.counts,
      mode: 'full',
      mruKey: 'cx-delete',
    });
    pickerWrap.appendChild(picker);
    dlg.appendChild(pickerWrap);

    const hint = document.createElement('div');
    hint.style.cssText = 'font-size:11.5px;color:#6b7280;margin-top:-4px';
    hint.innerHTML = `Items keep their relative sub-path under the destination. Pick <code>unknown</code> with no sub-category to leave them uncategorized.`;
    dlg.appendChild(hint);
  }

  const status = document.createElement('div');
  status.style.cssText = 'font-size:12px;color:#6b7280;margin-top:10px;min-height:16px';
  dlg.appendChild(status);

  const foot = document.createElement('div');
  foot.className = 'cx-dialog-foot';
  const cancel = document.createElement('button');
  cancel.className = 'btn';
  cancel.textContent = 'Cancel';
  const spacer = document.createElement('div');
  spacer.className = 'spacer';
  const go = document.createElement('button');
  go.className = 'btn btn-primary';
  go.textContent = 'Delete';
  go.style.background = '#b91c1c';
  go.style.borderColor = '#b91c1c';

  const close = () => { if (back.parentNode) document.body.removeChild(back); };
  cancel.addEventListener('click', close);
  back.addEventListener('click', (ev) => { if (ev.target === back) close(); });

  go.addEventListener('click', async () => {
    let target = null;
    if (n > 0) {
      target = YR_SHARED.getPickerResult(picker);
      if (!target || !target.category) {
        status.textContent = 'Pick a destination category first.';
        return;
      }
      const srcSub = node.subSegments.join(':');
      const sameL1 = (target.category === node.l1);
      const sameSub = ((target.sub_category || '') === srcSub);
      if (sameL1 && sameSub) {
        status.textContent = 'Destination is the same as the category being deleted.';
        return;
      }
    }
    go.disabled = true; cancel.disabled = true;
    status.textContent = n > 0 ? 'Moving items…' : 'Removing seed…';
    try {
      const summary = await deleteTreeNode(node, target);
      status.textContent = `Done. ${summary}`;
      setTimeout(close, 700);
    } catch (e) {
      status.textContent = 'Failed: ' + (e.message || e);
      go.disabled = false; cancel.disabled = false;
    }
  });

  foot.appendChild(cancel);
  foot.appendChild(spacer);
  foot.appendChild(go);
  dlg.appendChild(foot);

  back.appendChild(dlg);
  document.body.appendChild(back);
}

// Move every item under `node` to (target.category, target.sub_category +
// relative-tail), then strip matching seed rows so the path disappears
// cleanly. `target` may be null only when the subtree has no items.
async function deleteTreeNode(node, target) {
  const srcL1 = node.l1;
  const srcSub = node.subSegments.join(':');
  const affected = CX.buckets.filter(b => {
    if ((b.category || '') !== srcL1) return false;
    const s = b.sub_category || '';
    if (!srcSub) return true;
    return s === srcSub || s.startsWith(srcSub + ':');
  });

  let moveSummary = '';
  if (affected.length) {
    if (!target || !target.category) throw new Error('destination required');
    const tgtCat = target.category;
    const tgtSub = (target.sub_category || '');
    const rewriteSub = (s) => {
      if (!srcSub) return tgtSub ? (s ? `${tgtSub}:${s}` : tgtSub) : s;
      if (s === srcSub) return tgtSub;
      const tail = s.slice(srcSub.length + 1);
      return tgtSub ? (tail ? `${tgtSub}:${tail}` : tgtSub) : tail;
    };
    const moves = affected.map(b => ({
      from_category: srcL1,
      from_sub_category: b.sub_category || '',
      to_category: tgtCat,
      to_sub_category: rewriteSub(b.sub_category || ''),
      include_prefix: false,
    }));
    const { total, failures } = await bulkRemap(
      moves,
      `Delete ${node.path} → ${tgtCat}${tgtSub ? ':' + tgtSub : ''}`,
    );
    moveSummary = `${total} item${total === 1 ? '' : 's'} moved`
      + (failures ? ` (${failures} failed)` : '');
  }

  const removed = await removeCategorySeedsUnder(node);
  const seedSummary = removed
    ? `${removed} seed path${removed === 1 ? '' : 's'} removed`
    : '';
  await loadCategoryExplorer();

  return [moveSummary, seedSummary].filter(Boolean).join(' · ')
    || 'Nothing to do (category was already empty and had no seed entry).';
}

// Search matches on category, sub_category, or any item title/extra in the
// bucket's sample. Keeps the filter behavior useful when the user types e.g.
// a student's name.
function itemMatchesSearch(it, q) {
  if ((it.title || '').toLowerCase().includes(q)) return true;
  if ((it.extra || '').toLowerCase().includes(q)) return true;
  return false;
}

function bucketNameMatches(b, q) {
  if ((b.category || '').toLowerCase().includes(q)) return true;
  if ((b.sub_category || '').toLowerCase().includes(q)) return true;
  return false;
}

// A bucket surfaces during search if its own name matches OR at least one
// of its items matches. Separate from filterBucketItemsForSearch (below),
// which decides what to render inside a surfaced bucket.
function matchesSearch(b, q) {
  if (bucketNameMatches(b, q)) return true;
  return (b.items || []).some(it => itemMatchesSearch(it, q));
}

function cxKey(b) { return `${b.category}\u00A7${b.sub_category}`; }

function renderCxRow(b) {
  const key = cxKey(b);
  const expanded = CX.expanded.has(key);
  const isSelected = CX.selected.has(key);

  const hasItems = Object.values(b.counts || {}).some(n => n > 0);
  const seedOnly = b.is_seed && !hasItems;
  const row = document.createElement('div');
  row.className = 'cx-row'
    + (expanded ? ' expanded' : '')
    + (seedOnly ? ' seed-only' : '')
    + (isSelected ? ' row-selected' : '');

  // Legacy .cx-row is only used by the Split-view right pane's items list;
  // it's not a primary drag source in the tree redesign. Drop as a drag
  // SOURCE entirely. Drop-TARGET listeners are kept below for the
  // items-drag use case. (Manual drag for .cx-row sources could be added
  // later by attaching a handle + spec; not needed in current workflow.)
  const _placeholderHandle = document.createElement('span');
  _placeholderHandle.className = 'cx-drag-handle';
  _placeholderHandle.style.visibility = 'hidden';
  row.appendChild(_placeholderHandle);

  // Always-on checkbox (Phase 4). The legacy .cx-row layout was 4-column by
  // default + 5-column in select-mode; it's now permanently 5-column since
  // the checkbox never hides.
  const checkCell = document.createElement('div');
  checkCell.className = 'cx-row-check';
  const cb = document.createElement('input');
  cb.type = 'checkbox';
  cb.checked = isSelected;
  cb.addEventListener('click', (ev) => ev.stopPropagation());
  cb.addEventListener('change', () => {
    if (cb.checked) CX.selected.add(key);
    else CX.selected.delete(key);
    renderCxBulkbar();
    row.classList.toggle('row-selected', cb.checked);
  });
  checkCell.appendChild(cb);
  row.appendChild(checkCell);

  const cat = document.createElement('div');
  cat.className = 'cx-row-cat';
  cat.textContent = b.category || '—';
  row.appendChild(cat);

  const sub = document.createElement('div');
  sub.className = 'cx-row-sub' + (b.sub_category ? '' : ' empty');
  sub.textContent = b.sub_category || '(no sub-category)';
  sub.title = sub.textContent;
  row.appendChild(sub);

  const counts = document.createElement('div');
  counts.className = 'cx-row-counts';
  const parts = [];
  if (b.counts.tasks)      parts.push(`${b.counts.tasks} task${b.counts.tasks === 1 ? '' : 's'}`);
  if (b.counts.activities) parts.push(`${b.counts.activities} activit${b.counts.activities === 1 ? 'y' : 'ies'}`);
  if (b.counts.emails)     parts.push(`${b.counts.emails} email${b.counts.emails === 1 ? '' : 's'}`);
  if (b.counts.events)     parts.push(`${b.counts.events} event${b.counts.events === 1 ? '' : 's'}`);
  counts.innerHTML = parts.map(p => `<span>${escapeHtml(p)}</span>`).join('');
  row.appendChild(counts);

  const btns = document.createElement('div');
  btns.className = 'cx-row-btns';

  const toggleBtn = document.createElement('button');
  toggleBtn.className = 'btn btn-sm';
  toggleBtn.textContent = expanded ? 'Hide items' : 'Show items';
  toggleBtn.addEventListener('click', (ev) => {
    ev.stopPropagation();
    if (expanded) CX.expanded.delete(key); else CX.expanded.add(key);
    renderCx();
  });
  btns.appendChild(toggleBtn);

  const mergeBtn = document.createElement('button');
  mergeBtn.className = 'btn btn-sm btn-primary';
  mergeBtn.textContent = 'Merge into…';
  mergeBtn.addEventListener('click', (ev) => {
    ev.stopPropagation();
    openMergeDialog(b);
  });
  btns.appendChild(mergeBtn);
  row.appendChild(btns);

  // Drop target: accept items dragged from any bucket's expanded list.
  // Items land in this bucket's exact (category, sub_category). The row
  // advertises itself as a drop zone via .cx-drop-eligible whenever a drag is
  // in progress (set globally by the item dragstart handler).
  row.addEventListener('dragover', (ev) => {
    if (!ev.dataTransfer?.types.includes('application/x-cx-items')) return;
    ev.preventDefault();
    ev.dataTransfer.dropEffect = 'move';
    row.classList.add('cx-drop-over');
  });
  row.addEventListener('dragleave', () => row.classList.remove('cx-drop-over'));
  row.addEventListener('drop', async (ev) => {
    ev.preventDefault();
    row.classList.remove('cx-drop-over');
    const raw = ev.dataTransfer.getData('application/x-cx-items');
    if (!raw) return;
    let items;
    try { items = JSON.parse(raw); } catch { return; }
    if (!Array.isArray(items) || !items.length) return;
    await moveItems(items, b.category || '', b.sub_category || '');
  });

  const wrap = document.createElement('div');
  wrap.appendChild(row);

  if (expanded) {
    const detail = document.createElement('div');
    detail.className = 'cx-detail';
    if (!b.items?.length) {
      detail.innerHTML = '<div class="cx-empty">No items in this bucket.</div>';
    } else {
      const grid = document.createElement('div');
      grid.className = 'cx-items';
      for (const it of b.items) {
        grid.appendChild(renderCxItemRow(it, b));
      }
      detail.appendChild(grid);
    }
    wrap.appendChild(detail);
  }

  return wrap;
}

// Keep per-item Edit buttons in sync with the current multi-selection. When
// an item is in a selection of 2+, its button shifts to "Edit N selected"
// and promotes to primary style so it's the obvious target for bulk edits.
// Called after every selection change — faster than re-rendering the tree
// and keeps scroll/focus intact.
function applyItemEditBtnLabel(btn, key) {
  const n = CX.selectedItems.size;
  const inBulk = CX.selectedItems.has(key) && n > 1;
  if (inBulk) {
    btn.textContent = 'multi-edit';
    btn.title = `Retag all ${n} selected items to one destination`;
    btn.classList.add('btn-primary');
  } else {
    btn.textContent = 'Edit';
    btn.title = 'Retag just this item';
    btn.classList.remove('btn-primary');
  }
}
function refreshItemEditButtons() {
  document.querySelectorAll('.cx-item-action button[data-edit-for]').forEach(btn => {
    applyItemEditBtnLabel(btn, btn.dataset.editFor);
  });
}

// One draggable, selectable, expandable row per item inside an expanded bucket.
// Structure: [chevron][checkbox][kind][date][title][extra][action]. The row is
// an HTML5 drag source; when 2+ items are checked, dragging any selected row
// (or clicking its Edit button) carries the whole batch.
function renderCxItemRow(it, srcBucket) {
  const key = itemKey(it);
  const isSelected = CX.selectedItems.has(key);
  const isExpanded = CX.expandedItems.has(key);
  const row = document.createElement('div');
  row.className = 'cx-items-row select-mode'  // grid is permanently select-mode (always-on checkbox)
    + (isSelected ? ' row-selected' : '')
    + (isExpanded ? ' item-expanded' : '');
  row.dataset.itemKey = key;

  // Manual drag handle. Spec assembled at mousedown time so the current
  // multi-selection state is always fresh. If this item is part of a
  // non-empty multi-selection, the drag carries every selected item
  // (plus this one if it wasn't already in the set).
  row.appendChild(makeDragHandle(() => {
    let items;
    if (CX.selectedItems.size > 0) {
      items = Array.from(CX.selectedItems.values()).map(v => ({
        kind: v.kind, id: v.id, title: v.title || '',
        category: v._srcCategory || '', sub_category: v._srcSub || '',
      }));
      if (!CX.selectedItems.has(key)) {
        items.push({
          kind: it.kind, id: it.id, title: it.title || '',
          category: srcBucket.category || '', sub_category: srcBucket.sub_category || '',
        });
      }
    } else {
      items = [{
        kind: it.kind, id: it.id, title: it.title || '',
        category: srcBucket.category || '', sub_category: srcBucket.sub_category || '',
      }];
    }
    return { kind: 'item', data: { items }, shiftKey: false };
  }));

  const chev = document.createElement('button');
  chev.type = 'button';
  chev.className = 'cx-item-chev';
  chev.textContent = isExpanded ? '▾' : '▸';
  chev.title = isExpanded ? 'Collapse details' : 'Show details';
  chev.addEventListener('click', (ev) => {
    ev.stopPropagation();
    if (isExpanded) CX.expandedItems.delete(key); else CX.expandedItems.add(key);
    renderCx();
  });
  row.appendChild(chev);

  // Always-on checkbox (Phase 4).
  const chkCell = document.createElement('div');
  chkCell.className = 'cx-item-check';
  const chk = document.createElement('input');
  chk.type = 'checkbox';
  chk.checked = isSelected;
  chk.addEventListener('click', (ev) => ev.stopPropagation());
  chk.addEventListener('change', () => {
    if (chk.checked) {
      CX.selectedItems.set(key, { ...it, _srcCategory: srcBucket.category, _srcSub: srcBucket.sub_category || '' });
    } else {
      CX.selectedItems.delete(key);
    }
    row.classList.toggle('row-selected', chk.checked);
    renderCxBulkbar();
    updateCxMoveArrow();
    refreshItemEditButtons();
  });
  chkCell.appendChild(chk);
  row.appendChild(chkCell);

  const kind = document.createElement('div');
  kind.className = `cx-item-kind ${it.kind}`;
  kind.textContent = it.kind;
  row.appendChild(kind);

  const dt = document.createElement('div');
  dt.className = 'cx-item-when';
  dt.textContent = (it.when || '').slice(0, 10);
  row.appendChild(dt);

  const title = document.createElement('div');
  title.className = 'cx-item-title';
  title.textContent = it.title || '(no title)';
  title.title = it.title || '';
  row.appendChild(title);

  const extra = document.createElement('div');
  extra.className = 'cx-item-extra';
  extra.textContent = it.extra || '';
  extra.title = it.extra || '';
  row.appendChild(extra);

  const actionCell = document.createElement('div');
  actionCell.className = 'cx-item-action';
  const editBtn = document.createElement('button');
  editBtn.type = 'button';
  editBtn.dataset.editFor = key;
  // Text/title/primary-style are driven by refreshItemEditButtons() and
  // re-applied every time the selection changes. The click handler reads
  // the current CX.selectedItems state at click time (not at render time)
  // so the right dialog opens regardless of when the user picked things.
  editBtn.addEventListener('click', (ev) => {
    ev.stopPropagation();
    if (CX.selectedItems.has(key) && CX.selectedItems.size > 1) {
      openBulkItemRetagDialog(Array.from(CX.selectedItems.values()), srcBucket);
    } else {
      openRetagDialog(it, srcBucket);
    }
  });
  actionCell.appendChild(editBtn);
  row.appendChild(actionCell);
  applyItemEditBtnLabel(editBtn, key);

  // Row is NOT HTML5-draggable. Manual drag engine handles row drag via
  // mousedown on the handle above. HTML5 drop listeners are not needed
  // here — items are drag SOURCES only (the tree nodes they live in are
  // the drop targets).

  // Full item row wrapper (adds the expanded detail body as a second sub-row)
  const wrap = document.createElement('div');
  wrap.className = 'cx-items-wrap';
  wrap.appendChild(row);
  if (isExpanded) {
    const body = document.createElement('div');
    body.className = 'cx-item-body';
    body.dataset.detailKey = key;
    // Summary up top — useful regardless of fetch outcome.
    const summary = document.createElement('div');
    summary.className = 'cx-item-body-summary';
    const pieces = [];
    if (it.title)  pieces.push(`<strong>${escapeHtml(it.title)}</strong>`);
    if (it.when)   pieces.push(`<span style="color:#6b7280">${escapeHtml(it.when)}</span>`);
    if (it.extra)  pieces.push(`<span style="color:#6b7280">${escapeHtml(it.extra)}</span>`);
    pieces.push(`<code style="color:#6b7280">${escapeHtml(it.kind)}:${escapeHtml(it.id)}</code>`);
    pieces.push(`<code style="color:#6b7280">@ ${escapeHtml(srcBucket.category)}:${escapeHtml(srcBucket.sub_category || '(none)')}</code>`);
    summary.innerHTML = pieces.join('<br>');
    body.appendChild(summary);
    // Full detail section (lazy, fetched once + cached).
    const detail = document.createElement('div');
    detail.className = 'cx-item-body-detail';
    body.appendChild(detail);
    wrap.appendChild(body);
    loadCxItemDetail(it, detail);
  }
  return wrap;
}

// ---- Full-detail loader for the Category Explorer's expanded items -----
// Mirrors the inline expansion on the Item Explorer view; fetches once per
// (kind:id) and memoizes so re-expanding is free. Re-renders the detail
// section in place rather than triggering a full renderCx().

const CX_DETAIL_CACHE = new Map();   // key → {state:'loading'|'ok'|'err', detail?, error?}

function loadCxItemDetail(it, host) {
  const key = itemKey(it);
  const cached = CX_DETAIL_CACHE.get(key);
  if (cached && cached.state === 'ok') {
    host.replaceChildren(renderCxFullDetail(it.kind, cached.detail));
    return;
  }
  if (cached && cached.state === 'err') {
    host.innerHTML = `<div class="cx-detail-err">Failed to load details: ${escapeHtml(cached.error)}</div>`;
    return;
  }
  host.innerHTML = '<div class="cx-detail-loading">Loading…</div>';
  if (cached && cached.state === 'loading') return;  // already in flight
  CX_DETAIL_CACHE.set(key, { state: 'loading' });
  fetch(`/api/item-detail?kind=${encodeURIComponent(it.kind)}&id=${encodeURIComponent(it.id)}`)
    .then(r => r.json())
    .then(j => {
      if (!j.ok) throw new Error(j.error || 'fetch failed');
      CX_DETAIL_CACHE.set(key, { state: 'ok', detail: j.detail });
    })
    .catch(e => {
      CX_DETAIL_CACHE.set(key, { state: 'err', error: e.message || String(e) });
    })
    .finally(() => {
      // Find any open body for this key on the page (the user may have
      // scrolled away or triggered another renderCx during the request).
      const target = document.querySelector(`.cx-item-body[data-detail-key="${CSS.escape(key)}"] .cx-item-body-detail`);
      if (target) loadCxItemDetail(it, target);
    });
}

function renderCxFullDetail(kind, d) {
  // Defer to the shared module so the look matches the By Item view + the
  // task-list page. Falls back to a JSON pretty-print if the module isn't
  // loaded (e.g. on an older Activity Overview page that hasn't been
  // updated to include explorer-detail.js).
  if (window.EXPLORER_DETAIL) {
    return window.EXPLORER_DETAIL.render(kind, d);
  }
  const wrap = document.createElement('div');
  wrap.className = 'cx-item-detail-rich';
  const pre = document.createElement('pre');
  pre.className = 'cx-detail-text';
  pre.textContent = JSON.stringify(d, null, 2);
  wrap.appendChild(pre);
  return wrap;
}

/* ---- Bulk item retag dialog (multi-selection) ---- */

// Picks one destination and retags every selected item to it. The selected
// items may come from different buckets — that's the whole point. Uses
// moveItems under the hood so the undo snackbar works the same as drag-
// drop. Post-save, the selection clears (moveItems already does that) and
// the tree refreshes.
function openBulkItemRetagDialog(items, anchorBucket) {
  const back = document.createElement('div');
  back.className = 'cx-dialog-back';
  const dlg = document.createElement('div');
  dlg.className = 'cx-dialog';

  const header = document.createElement('h3');
  header.innerHTML = `Retag <strong>${items.length}</strong> selected item${items.length === 1 ? '' : 's'}`;
  dlg.appendChild(header);

  // Show a per-kind breakdown + up to 5 sample titles so the user sees what
  // they're about to move. Items from different buckets are deliberately
  // lumped together — that's the whole point of multi-select across
  // categories.
  const summary = document.createElement('div');
  summary.style.cssText = 'font-size:12px;color:#6b7280;margin-bottom:8px;line-height:1.5';
  const byKind = {};
  for (const it of items) byKind[it.kind] = (byKind[it.kind] || 0) + 1;
  const kindLine = Object.entries(byKind)
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([k, n]) => `${n} ${k}${n === 1 ? '' : 's'}`).join(' · ');
  const sampleTitles = items.slice(0, 5).map(it => `• ${escapeHtml(it.title || '(no title)')}`).join('<br>');
  const more = items.length > 5 ? `<br><em>…and ${items.length - 5} more</em>` : '';
  summary.innerHTML = `<strong>${kindLine}</strong><br>${sampleTitles}${more}`;
  dlg.appendChild(summary);

  const pickerWrap = document.createElement('div');
  pickerWrap.style.cssText = 'margin:8px 0';
  // Seed the picker from the first item's current path so the common "most
  // of these are misfiled the same way" case is one click from done.
  const seed = items[0] || {};
  const picker = YR_SHARED.renderPicker({
    ctx: {
      category: seed._srcCategory || seed.category || anchorBucket?.category || '',
      sub_category: seed._srcSub || seed.sub_category || anchorBucket?.sub_category || '',
    },
    tree: CX.tree,
    counts: CX.counts,
    mode: 'full',
    mruKey: 'cx-retag-bulk',
  });
  pickerWrap.appendChild(picker);
  dlg.appendChild(pickerWrap);

  const status = document.createElement('div');
  status.style.cssText = 'font-size:12px;color:#6b7280;margin-top:10px;min-height:16px';
  dlg.appendChild(status);

  const foot = document.createElement('div');
  foot.className = 'cx-dialog-foot';
  const cancel = document.createElement('button');
  cancel.className = 'btn';
  cancel.textContent = 'Cancel';
  cancel.addEventListener('click', () => document.body.removeChild(back));
  const spacer = document.createElement('div');
  spacer.className = 'spacer';
  const save = document.createElement('button');
  save.className = 'btn btn-primary';
  save.textContent = `Retag ${items.length}`;
  save.addEventListener('click', async () => {
    const dest = YR_SHARED.getPickerResult(picker);
    if (!dest.category) { status.textContent = 'Pick a destination category first.'; return; }
    save.disabled = true; cancel.disabled = true;
    status.textContent = 'Saving…';
    // Normalize each item into the shape moveItems expects — it reads
    // .category/.sub_category as the source, so pull those from _srcCategory/
    // _srcSub if the item came from CX.selectedItems (which stashes source
    // on those keys to support cross-bucket drags).
    const payload = items.map(it => ({
      kind: it.kind, id: it.id, title: it.title || '',
      category: it._srcCategory || it.category || '',
      sub_category: it._srcSub || it.sub_category || '',
    }));
    try {
      await moveItems(payload, dest.category, dest.sub_category || '');
      if (back.parentNode) document.body.removeChild(back);
    } catch (e) {
      status.textContent = 'Failed: ' + (e.message || e);
      save.disabled = false; cancel.disabled = false;
    }
  });
  foot.appendChild(cancel);
  foot.appendChild(spacer);
  foot.appendChild(save);
  dlg.appendChild(foot);

  back.appendChild(dlg);
  document.body.appendChild(back);
  back.addEventListener('click', (ev) => { if (ev.target === back) document.body.removeChild(back); });
}

/* ---- Single-item retag dialog ---- */

function openRetagDialog(item, srcBucket) {
  const back = document.createElement('div');
  back.className = 'cx-dialog-back';
  const dlg = document.createElement('div');
  dlg.className = 'cx-dialog';

  const header = document.createElement('h3');
  const kindLabel = item.kind[0].toUpperCase() + item.kind.slice(1);
  header.innerHTML = `Retag ${escapeHtml(kindLabel)}: <span style="font-weight:400;color:#6b7280">${escapeHtml(item.title || '(no title)')}</span>`;
  dlg.appendChild(header);

  const current = document.createElement('div');
  current.style.cssText = 'font-size:12px;color:#6b7280;margin-bottom:8px';
  current.innerHTML = `Currently: <code>${escapeHtml(srcBucket.category)}</code> / <code>${escapeHtml(srcBucket.sub_category || '(none)')}</code>`;
  dlg.appendChild(current);

  const pickerWrap = document.createElement('div');
  pickerWrap.style.cssText = 'margin:8px 0';
  const picker = YR_SHARED.renderPicker({
    ctx: { category: srcBucket.category, sub_category: srcBucket.sub_category || '' },
    tree: CX.tree,
    counts: CX.counts,
    mode: 'full',
    mruKey: 'cx-retag',
  });
  pickerWrap.appendChild(picker);
  dlg.appendChild(pickerWrap);

  const status = document.createElement('div');
  status.style.cssText = 'font-size:12px;color:#6b7280;margin-top:10px;min-height:16px';
  dlg.appendChild(status);

  const foot = document.createElement('div');
  foot.className = 'cx-dialog-foot';
  const cancel = document.createElement('button');
  cancel.className = 'btn';
  cancel.textContent = 'Cancel';
  cancel.addEventListener('click', () => document.body.removeChild(back));
  const spacer = document.createElement('div');
  spacer.className = 'spacer';
  const save = document.createElement('button');
  save.className = 'btn btn-primary';
  save.textContent = 'Save';
  save.addEventListener('click', async () => {
    const dest = YR_SHARED.getPickerResult(picker);
    if (!dest.category) { status.textContent = 'Pick a destination category first.'; return; }
    const same = dest.category === srcBucket.category && (dest.sub_category || '') === (srcBucket.sub_category || '');
    if (same) { status.textContent = 'Already at that path.'; return; }
    save.disabled = true; cancel.disabled = true;
    status.textContent = 'Saving…';
    try {
      const j = await retagItemWithSync({
        kind: item.kind,
        id: item.id,
        category: dest.category,
        sub_category: dest.sub_category || '',
      });
      if (!j || !j.ok) throw new Error((j && j.error) || 'save failed');
      if (!j.updated) throw new Error('item not found in its store');
      status.textContent = 'Saved.';
      await loadCategoryExplorer();
      setTimeout(() => { if (back.parentNode) document.body.removeChild(back); }, 500);
    } catch (e) {
      status.textContent = 'Failed: ' + e.message;
      save.disabled = false; cancel.disabled = false;
    }
  });
  foot.appendChild(cancel);
  foot.appendChild(spacer);
  foot.appendChild(save);
  dlg.appendChild(foot);

  back.appendChild(dlg);
  back.addEventListener('click', (ev) => {
    if (ev.target === back) document.body.removeChild(back);
  });
  document.body.appendChild(back);
}

/* ---- Bulk merge dialog ----
 *
 * Target use case: the user has several sub-category variants that drifted
 * apart (e.g. teaching:course:bme466, teaching:course:bme466-fall, etc) and
 * wants to consolidate them under one canonical path. Each source is remapped
 * via the existing /api/remap-category endpoint in sequence; per-source
 * results accumulate in the status area so a partial failure is visible.
 */

function openBulkMergeDialog(srcs) {
  const back = document.createElement('div');
  back.className = 'cx-dialog-back';
  const dlg = document.createElement('div');
  dlg.className = 'cx-dialog';

  const totalN = srcs.reduce((t, b) =>
    t + Object.values(b.counts || {}).reduce((a, c) => a + c, 0), 0);
  const header = document.createElement('h3');
  header.innerHTML = `Merge <strong>${srcs.length}</strong> bucket${srcs.length === 1 ? '' : 's'} (<strong>${totalN}</strong> item${totalN === 1 ? '' : 's'}) into:`;
  dlg.appendChild(header);

  // Source list — read-only so the user can review what they're about to
  // move. Each row shows the full path + item count for quick sanity check.
  const srcWrap = document.createElement('div');
  srcWrap.style.cssText = 'margin:6px 0 12px 0;max-height:160px;overflow:auto;border:1px solid #e5e7eb;border-radius:6px;background:#f9fafb';
  for (const s of srcs) {
    const row = document.createElement('div');
    row.style.cssText = 'display:flex;gap:8px;padding:4px 10px;font-size:12px;border-bottom:1px solid #f1f5f9;align-items:center;font-family:ui-monospace,SFMono-Regular,Menlo,monospace';
    const n = Object.values(s.counts || {}).reduce((a, c) => a + c, 0);
    row.innerHTML = `
      <span style="color:#6b7280;text-transform:uppercase;font-size:10px;letter-spacing:.3px;font-family:inherit">${escapeHtml(s.category || '—')}</span>
      <span style="flex:1;color:#111827;overflow:hidden;text-overflow:ellipsis;white-space:nowrap">${escapeHtml(s.sub_category || '(no sub-category)')}</span>
      <span style="color:#6b7280;font-size:11px;font-variant-numeric:tabular-nums;font-family:inherit">${n}</span>
    `;
    srcWrap.appendChild(row);
  }
  dlg.appendChild(srcWrap);

  // Destination picker — seed from the first source so the common case
  // (merging bme466 variants into the canonical bme466) pre-fills most of
  // the path and the user only tweaks the leaf.
  const pickerWrap = document.createElement('div');
  pickerWrap.style.cssText = 'margin:8px 0';
  const picker = YR_SHARED.renderPicker({
    ctx: { category: srcs[0].category, sub_category: srcs[0].sub_category || '' },
    tree: CX.tree,
    counts: CX.counts,
    mode: 'full',
    mruKey: 'cx-merge',
  });
  pickerWrap.appendChild(picker);
  dlg.appendChild(pickerWrap);

  // "Keep sub-category" — preserve each source's sub_category verbatim and only
  // change L1. Useful for reparenting "correctly sub-classified, wrong L1" items
  // like teaching:student-committee:cason-hancock:phd → research:student-committee:cason-hancock:phd.
  // When checked, the picker's sub_category is ignored; prefix-match auto-enables
  // so the entire subtree travels intact.
  const keepRow = document.createElement('label');
  keepRow.style.cssText = 'display:flex;align-items:center;gap:6px;font-size:12px;color:#374151;margin-top:6px';
  const keepCb = document.createElement('input');
  keepCb.type = 'checkbox';
  keepRow.appendChild(keepCb);
  keepRow.appendChild(document.createTextNode('Keep sub-category — only change L1 (the destination sub-category below is ignored)'));
  dlg.appendChild(keepRow);

  const prefRow = document.createElement('label');
  prefRow.style.cssText = 'display:flex;align-items:center;gap:6px;font-size:12px;color:#374151;margin-top:6px';
  const prefCb = document.createElement('input');
  prefCb.type = 'checkbox';
  prefRow.appendChild(prefCb);
  prefRow.appendChild(document.createTextNode('Also move any deeper paths (prefix match) — e.g. sub-buckets under each source path'));
  dlg.appendChild(prefRow);

  // When "keep sub-category" toggles on, auto-enable prefix match so deeper
  // paths come along — otherwise only the exact source bucket moves and its
  // children are orphaned under the old L1.
  keepCb.addEventListener('change', () => {
    if (keepCb.checked) { prefCb.checked = true; prefCb.disabled = true; }
    else { prefCb.disabled = false; }
  });

  const status = document.createElement('div');
  status.style.cssText = 'font-size:12px;color:#6b7280;margin-top:10px;min-height:16px;max-height:160px;overflow:auto;font-family:ui-monospace,SFMono-Regular,Menlo,monospace;white-space:pre-wrap';
  dlg.appendChild(status);

  const foot = document.createElement('div');
  foot.className = 'cx-dialog-foot';
  const cancel = document.createElement('button');
  cancel.className = 'btn';
  cancel.textContent = 'Cancel';
  cancel.addEventListener('click', () => document.body.removeChild(back));
  const spacer = document.createElement('div');
  spacer.className = 'spacer';
  const go = document.createElement('button');
  go.className = 'btn btn-primary';
  go.textContent = `Merge ${srcs.length}`;
  go.addEventListener('click', async () => {
    const dest = YR_SHARED.getPickerResult(picker);
    if (!dest.category) { status.textContent = 'Pick a destination category first.'; return; }
    const keepSub = keepCb.checked;
    // Drop any source that's identical to the destination — a no-op for the
    // server and confusing in the progress log. When keepSub is on, the only
    // no-op is same L1 (the sub_category is always preserved).
    const toMerge = srcs.filter(s => {
      if (keepSub) return s.category !== dest.category;
      return !(s.category === dest.category && (s.sub_category || '') === (dest.sub_category || ''));
    });
    if (!toMerge.length) {
      status.textContent = 'All selected buckets already match the destination.';
      return;
    }
    go.disabled = true; cancel.disabled = true;
    const lines = [];
    const append = (line) => { lines.push(line); status.textContent = lines.join('\n'); };
    const totals = { tasks: 0, activities: 0, emails: 0, events: 0, yr: 0 };
    let failures = 0;

    for (let i = 0; i < toMerge.length; i++) {
      const s = toMerge[i];
      const destSub = keepSub ? (s.sub_category || '') : (dest.sub_category || '');
      append(`[${i + 1}/${toMerge.length}] ${s.category}/${s.sub_category || '(none)'} \u2192 ${dest.category}/${destSub || '(none)'} \u2026`);
      try {
        const res = await fetch('/api/remap-category', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            from_category: s.category,
            from_sub_category: s.sub_category || '',
            to_category: dest.category,
            to_sub_category: destSub,
            include_prefix: prefCb.checked,
          }),
        });
        const j = await res.json();
        if (!j.ok) throw new Error(j.error || 'merge failed');
        const c = j.counts || {};
        for (const k of Object.keys(totals)) totals[k] += (c[k] || 0);
        // Update the last line in place with the per-source count summary.
        lines[lines.length - 1] += ` ok (${c.tasks || 0}t ${c.activities || 0}a ${c.emails || 0}e ${c.events || 0}v ${c.yr || 0}yr)`;
        status.textContent = lines.join('\n');
      } catch (e) {
        failures++;
        lines[lines.length - 1] += ` FAILED: ${e.message}`;
        status.textContent = lines.join('\n');
      }
    }

    append('');
    append(`Totals: ${totals.tasks} tasks, ${totals.activities} activities, ${totals.emails} emails, ${totals.events} events, ${totals.yr} year-review rows.`);
    if (failures) append(`${failures} source${failures === 1 ? '' : 's'} failed \u2014 re-select those and retry if needed.`);
    else append('All sources merged successfully.');

    // Refresh the explorer so merged buckets disappear and the destination
    // count climbs. Keep the dialog open a moment so the user can read the
    // summary; close on their next click via Cancel or backdrop.
    CX.selected.clear();
    await loadCategoryExplorer();
    cancel.disabled = false;
    cancel.textContent = 'Close';
  });
  foot.appendChild(cancel);
  foot.appendChild(spacer);
  foot.appendChild(go);
  dlg.appendChild(foot);

  back.appendChild(dlg);
  back.addEventListener('click', (ev) => {
    if (ev.target === back) document.body.removeChild(back);
  });
  document.body.appendChild(back);
}

/* ---- Merge dialog ---- */

function openMergeDialog(srcBucket) {
  const back = document.createElement('div');
  back.className = 'cx-dialog-back';
  const dlg = document.createElement('div');
  dlg.className = 'cx-dialog';

  const totalN = Object.values(srcBucket.counts).reduce((a, b) => a + b, 0);
  const headerText = `Merge ${totalN} item${totalN === 1 ? '' : 's'} from `;
  const header = document.createElement('h3');
  header.innerHTML = `${escapeHtml(headerText)}<code>${escapeHtml(srcBucket.category)}</code> / <code>${escapeHtml(srcBucket.sub_category || '(none)')}</code> into:`;
  dlg.appendChild(header);

  // Picker for the destination
  const pickerWrap = document.createElement('div');
  pickerWrap.style.cssText = 'margin:8px 0';
  const picker = YR_SHARED.renderPicker({
    ctx: { category: srcBucket.category, sub_category: srcBucket.sub_category || '' },
    tree: CX.tree,
    counts: CX.counts,
    mode: 'full',
    mruKey: 'cx-merge',
  });
  pickerWrap.appendChild(picker);
  dlg.appendChild(pickerWrap);

  // Include-prefix toggle
  const prefRow = document.createElement('label');
  prefRow.style.cssText = 'display:flex;align-items:center;gap:6px;font-size:12px;color:#374151;margin-top:6px';
  const prefCb = document.createElement('input');
  prefCb.type = 'checkbox';
  prefRow.appendChild(prefCb);
  prefRow.appendChild(document.createTextNode('Also move any deeper paths (prefix match) — e.g. sub-buckets under this path'));
  dlg.appendChild(prefRow);

  // Status + action buttons
  const status = document.createElement('div');
  status.style.cssText = 'font-size:12px;color:#6b7280;margin-top:10px;min-height:16px';
  dlg.appendChild(status);

  const foot = document.createElement('div');
  foot.className = 'cx-dialog-foot';
  const cancel = document.createElement('button');
  cancel.className = 'btn';
  cancel.textContent = 'Cancel';
  cancel.addEventListener('click', () => document.body.removeChild(back));
  const spacer = document.createElement('div');
  spacer.className = 'spacer';
  const go = document.createElement('button');
  go.className = 'btn btn-primary';
  go.textContent = 'Merge';
  go.addEventListener('click', async () => {
    const dest = YR_SHARED.getPickerResult(picker);
    if (!dest.category) { status.textContent = 'Pick a destination category first.'; return; }
    const isSameAsSource = dest.category === srcBucket.category && (dest.sub_category || '') === (srcBucket.sub_category || '');
    if (isSameAsSource) { status.textContent = 'Destination is the same as the source.'; return; }
    go.disabled = true; cancel.disabled = true;
    status.textContent = 'Merging…';
    try {
      const res = await fetch('/api/remap-category', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          from_category: srcBucket.category,
          from_sub_category: srcBucket.sub_category || '',
          to_category: dest.category,
          to_sub_category: dest.sub_category || '',
          include_prefix: prefCb.checked,
        }),
      });
      const j = await res.json();
      if (!j.ok) throw new Error(j.error || 'merge failed');
      const c = j.counts || {};
      status.textContent = `Done: ${c.tasks || 0} tasks, ${c.activities || 0} activities, ${c.emails || 0} emails, ${c.events || 0} events, ${c.yr || 0} year-review rows.`;
      // Reload the explorer so the merged bucket disappears.
      await loadCategoryExplorer();
      setTimeout(() => { if (back.parentNode) document.body.removeChild(back); }, 900);
    } catch (e) {
      status.textContent = 'Failed: ' + e.message;
      go.disabled = false; cancel.disabled = false;
    }
  });
  foot.appendChild(cancel);
  foot.appendChild(spacer);
  foot.appendChild(go);
  dlg.appendChild(foot);

  back.appendChild(dlg);
  back.addEventListener('click', (ev) => {
    if (ev.target === back) document.body.removeChild(back);
  });
  document.body.appendChild(back);
}

/* ─────────────────────────────────────────────────────────────────────────
 * Deploy-mode dashboard (Phase 8)
 *
 * Renders a lightweight per-user activity panel sourced from the Firestore
 * collections written by the Phase 7 scrapers (gmail-scraper, calendar-scraper,
 * ics-scraper) and the on-disk archive backfill. Replaces the rich activity-
 * overview engine when running on mcgheelab.com/rm/ (no server.py).
 *
 * Stats shown:
 *   • Email volume — this year / 30d / 7d / today
 *   • Top senders this month
 *   • Calendar load — events this week, hours-on-meetings
 *   • Top categories (from backfill metadata; falls back to "uncategorized")
 *   • Last sync time per provider
 * ───────────────────────────────────────────────────────────────────────── */
async function renderDeployActivityDashboard() {
  const root = document.getElementById('act-stats') || document.body;
  if (!root) return;
  root.innerHTML = '<div style="padding:24px;color:#6b7280;">Loading your activity…</div>';

  const currentYear = String(new Date().getFullYear());
  // Phase 13: pull pre-aggregated stats first — these hold full-year counts +
  // breakdowns without paginating through raw collections. Falls back to the
  // raw-message scan if stats aren't seeded yet.
  let emailStats = null, calendarStats = null;
  try {
    const s = await api.load('stats/email-' + currentYear + '.json');
    if (s && s.totalCount != null) emailStats = s;
  } catch {}
  try {
    const s = await api.load('stats/calendar-' + currentYear + '.json');
    if (s && s.totalCount != null) calendarStats = s;
  } catch {}

  // Always pull recent raw rows for "today / 7d" cards which need timestamps
  // finer than the stats doc tracks (stats has byMonth + byHour but not
  // running 30-day windows). Capped via the paginated route — small fetch.
  let messages = [], events = [];
  try {
    const m = await api.load('email_archive/messages.json');
    messages = (m && m.messages) || [];
  } catch (err) { console.warn('[activity] inbox load failed:', err.message); }
  try {
    const e = await api.load('calendar_archive/events.json');
    events = (e && e.events) || [];
  } catch (err) { console.warn('[activity] events load failed:', err.message); }

  if (!messages.length && !events.length && !emailStats && !calendarStats) {
    root.innerHTML = '<div class="card" style="padding:24px;max-width:680px;margin:24px auto;">' +
      '<h2 style="margin:0 0 8px;font-size:18px;">Connect your data sources</h2>' +
      '<p style="color:#4b5563;">' +
        'No synced emails or calendar events yet. Go to ' +
        '<a href="/rm/pages/settings.html">Settings → Connections</a> to link Gmail, ' +
        'Google Calendar, or your Outlook ICS feed.' +
      '</p></div>';
    return;
  }

  // Buckets
  const now = Date.now();
  const todayKey = new Date(now).toISOString().slice(0, 10);
  const sevenDaysAgo = now - 7 * 86400_000;
  const thirtyDaysAgo = now - 30 * 86400_000;
  const yearStart = new Date(new Date().getFullYear(), 0, 1).getTime();

  let mailToday = 0, mail7 = 0, mail30 = 0, mailYear = 0;
  const senderCount = new Map();
  const categoryCount = new Map();

  // Year total comes from the stats doc when available — that's the FULL
  // year count, not the loaded 250-row subset. Recent windows (today / 7d /
  // 30d / 30-day senders) come from the raw paginated rows because the
  // stats doc only tracks coarser month/hour granularity.
  if (emailStats) {
    mailYear = emailStats.totalCount || 0;
    // Categories: pull from the stats doc's byCategory map (full year).
    const cats = emailStats.byCategory || {};
    for (const [cat, n] of Object.entries(cats)) categoryCount.set(cat, n);
  }
  for (const m of messages) {
    const t = Number(m.internalDate) || 0;
    if (!t) continue;
    if (!emailStats && t >= yearStart) mailYear++;
    if (t >= thirtyDaysAgo) mail30++;
    if (t >= sevenDaysAgo) mail7++;
    const dateKey = new Date(t).toISOString().slice(0, 10);
    if (dateKey === todayKey) mailToday++;

    if (t >= thirtyDaysAgo) {
      const sender = senderName(m.from || '');
      if (sender) senderCount.set(sender, (senderCount.get(sender) || 0) + 1);
    }
    if (!emailStats) {
      const cat = (m.category || '').trim();
      if (cat) categoryCount.set(cat, (categoryCount.get(cat) || 0) + 1);
    }
  }

  let evtsWeek = 0, hoursMtg = 0;
  const orgCount = new Map();
  const startOfWeek = (() => {
    const d = new Date(); d.setHours(0, 0, 0, 0);
    d.setDate(d.getDate() - d.getDay());
    return d.getTime();
  })();
  const endOfWeek = startOfWeek + 7 * 86400_000;
  for (const ev of events) {
    const t = Date.parse(ev.start_at || '');
    if (isNaN(t)) continue;
    if (t >= startOfWeek && t < endOfWeek) {
      evtsWeek++;
      const tEnd = Date.parse(ev.end_at || '');
      if (!isNaN(tEnd) && tEnd > t) hoursMtg += (tEnd - t) / 3600_000;
    }
    if (t >= thirtyDaysAgo) {
      const o = (ev.organizer_email || '').split('@')[0];
      if (o) orgCount.set(o, (orgCount.get(o) || 0) + 1);
    }
  }

  function senderName(from) {
    const m = from.match(/^"?([^"<]+?)"?\s*<.+>$/);
    return (m ? m[1] : from).trim();
  }
  function topN(map, n) {
    return Array.from(map.entries()).sort((a, b) => b[1] - a[1]).slice(0, n);
  }
  function escapeHtml(s) {
    return String(s || '').replace(/[&<>"']/g, c => (
      { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]
    ));
  }
  function statCard(label, big, sub) {
    return '<div class="card" style="flex:1;min-width:160px;padding:14px 18px;">' +
      '<div class="card-title" style="font-size:12px;color:#6b7280;text-transform:uppercase;letter-spacing:.04em;">' + label + '</div>' +
      '<div class="card-count" style="font-size:28px;font-weight:600;margin-top:4px;">' + big + '</div>' +
      (sub ? '<div class="card-body" style="font-size:12px;color:#6b7280;margin-top:2px;">' + sub + '</div>' : '') +
      '</div>';
  }

  // Render
  let html = '';

  // Stat strip
  html += '<div style="display:flex;gap:12px;flex-wrap:wrap;margin-bottom:18px;">';
  html += statCard('Today', mailToday.toLocaleString(), 'emails');
  html += statCard('Last 7 days', mail7.toLocaleString(), 'emails');
  html += statCard('Last 30 days', mail30.toLocaleString(), 'emails');
  html += statCard('This year', mailYear.toLocaleString(), 'emails');
  html += statCard('This week', evtsWeek.toLocaleString(), 'events · ' + hoursMtg.toFixed(1) + ' hrs in meetings');
  html += '</div>';

  // Two columns: top senders + top categories
  html += '<div style="display:grid;grid-template-columns:1fr 1fr;gap:16px;max-width:920px;">';

  // Top senders
  html += '<div class="card" style="padding:14px 18px;">';
  html += '<div style="font-size:12px;font-weight:600;color:#6b7280;text-transform:uppercase;letter-spacing:.04em;margin-bottom:10px;">Top senders (last 30 days)</div>';
  const topSenders = topN(senderCount, 8);
  if (!topSenders.length) html += '<div style="color:#9ca3af;font-size:13px;">No senders yet.</div>';
  else {
    html += '<div style="display:flex;flex-direction:column;gap:4px;">';
    topSenders.forEach(([name, c]) => {
      html += '<div style="display:flex;justify-content:space-between;font-size:13px;padding:4px 0;border-bottom:1px solid #f3f4f6;">' +
        '<span style="overflow:hidden;text-overflow:ellipsis;white-space:nowrap;flex:1;min-width:0;">' + escapeHtml(name) + '</span>' +
        '<span style="color:#6b7280;font-variant-numeric:tabular-nums;">' + c + '</span>' +
        '</div>';
    });
    html += '</div>';
  }
  html += '</div>';

  // Top categories OR top organizers
  html += '<div class="card" style="padding:14px 18px;">';
  if (categoryCount.size) {
    html += '<div style="font-size:12px;font-weight:600;color:#6b7280;text-transform:uppercase;letter-spacing:.04em;margin-bottom:10px;">Top email categories</div>';
    html += '<div style="font-size:11px;color:#9ca3af;margin-bottom:6px;">From backfilled archive — newer scrapes don\'t carry categories yet.</div>';
    const topCats = topN(categoryCount, 8);
    html += '<div style="display:flex;flex-direction:column;gap:4px;">';
    topCats.forEach(([cat, c]) => {
      html += '<div style="display:flex;justify-content:space-between;font-size:13px;padding:4px 0;border-bottom:1px solid #f3f4f6;">' +
        '<span style="overflow:hidden;text-overflow:ellipsis;white-space:nowrap;flex:1;min-width:0;text-transform:capitalize;">' + escapeHtml(cat.replace(/_/g, ' ')) + '</span>' +
        '<span style="color:#6b7280;font-variant-numeric:tabular-nums;">' + c + '</span>' +
        '</div>';
    });
    html += '</div>';
  } else {
    html += '<div style="font-size:12px;font-weight:600;color:#6b7280;text-transform:uppercase;letter-spacing:.04em;margin-bottom:10px;">Top meeting organizers (last 30 days)</div>';
    const topOrgs = topN(orgCount, 8);
    if (!topOrgs.length) html += '<div style="color:#9ca3af;font-size:13px;">No organizers yet.</div>';
    else {
      html += '<div style="display:flex;flex-direction:column;gap:4px;">';
      topOrgs.forEach(([name, c]) => {
        html += '<div style="display:flex;justify-content:space-between;font-size:13px;padding:4px 0;border-bottom:1px solid #f3f4f6;">' +
          '<span style="overflow:hidden;text-overflow:ellipsis;white-space:nowrap;flex:1;min-width:0;">' + escapeHtml(name) + '</span>' +
          '<span style="color:#6b7280;font-variant-numeric:tabular-nums;">' + c + '</span>' +
          '</div>';
      });
      html += '</div>';
    }
  }
  html += '</div>';

  html += '</div>';  // end grid

  html += '<div style="margin-top:16px;font-size:12px;color:#9ca3af;max-width:920px;">' +
    'Drawn from <a href="/rm/pages/email-review.html">Email</a> and <a href="/rm/pages/calendar.html">Calendar</a>. ' +
    'Manage data sources in <a href="/rm/pages/settings.html">Settings → Connections</a>.' +
    '</div>';

  root.innerHTML = html;
}
