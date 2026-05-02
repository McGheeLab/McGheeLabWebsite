/* email-review.js
 *
 * - Year picker + category/search/tasks filter
 * - Monthly timeline chart (stacked, by category)
 * - Activity rollup with 1-5 star rating per activity_type
 * - Email rows with per-email 1-5 star rating and click-to-expand detail
 *
 * Data:
 *   GET  /api/data/email_archive/summary.json
 *   GET  /api/data/email_archive/by_year/<YYYY>.json
 *   GET  /api/data/email_archive/ratings.json
 *   GET  /api/email?path=<rel>   (full body + attachments)
 *   PUT  /api/data/email_archive/ratings.json
 */

const CAT_COLORS = {
  research: '#2563eb',
  teaching: '#d97706',
  service:  '#7c3aed',
  admin:    '#64748b',
  personal: '#dc2626',
  noise:    '#cbd5e1',
  unknown:  '#f59e0b',
};
const CATS = Object.keys(CAT_COLORS);

const ALL_CATS = ['research', 'teaching', 'service', 'admin', 'personal', 'noise', 'unknown'];

function loadCatFilter() {
  // Persist toggle state in localStorage. Default: everything except noise.
  try {
    const raw = localStorage.getItem('emailReview.cats');
    if (raw) {
      const arr = JSON.parse(raw);
      if (Array.isArray(arr)) return new Set(arr);
    }
  } catch {}
  return new Set(ALL_CATS.filter(c => c !== 'noise'));
}

function saveCatFilter(set) {
  try {
    localStorage.setItem('emailReview.cats', JSON.stringify(Array.from(set)));
  } catch {}
}

const STATE = {
  year: null,
  summary: null,
  emails: [],
  ratings: { by_email: {}, by_activity: {} },
  predictions: {},            // id -> predicted_score
  categoryOverrides: {},      // id -> category (user edits)
  expandedEmails: new Set(),  // id set
  detailCache: {},            // id -> {body_text, body_html, attachments}
  filter: { cats: loadCatFilter(), search: '', onlyTasks: false },
  sort: 'date-desc',
  timelineChart: null,
  trash: [],                  // [{ id, deleted_at, email: {...} }]
  permanentlyDeletedIds: [],  // [id, ...]
  showTrash: false,
  dispositions: {},           // email_id -> { value, source, updated_at }
  dispositionSuggestions: {}, // email_id -> { value, confidence, reason } (phase 2)
  selectionMode: false,
  selected: new Set(),        // email_ids
  tasksInbox: null,           // cached {tasks:[...]} from tasks/inbox.json (lazy)
  relatedTasksOpen: new Set(),// email_ids whose Related-tasks section is expanded
  pinnedBucketKeys: null,     // Set of `cat§sub` keys; null = not loaded yet
};

// Three-way email disposition: immediate action, watch-later, FYI.
// Shape glyphs are colour-coded by importance — red (hot), amber, gray.
const DISP_OPTIONS = [
  { value: 'actionable', label: 'Actionable', shape: '\u25CF' }, // ●
  { value: 'reminder',   label: 'Reminder',   shape: '\u25B2' }, // ▲
  { value: 'info',       label: 'Info',       shape: '\u25A0' }, // ■
];

async function loadDispositions() {
  try {
    const j = await api.load('email_archive/dispositions.json');
    STATE.dispositions = j.dispositions || {};
  } catch { STATE.dispositions = {}; }
  // Phase 2 will populate this from email_archive/disposition_suggestions.json.
  try {
    const j = await api.load('email_archive/disposition_suggestions.json');
    const m = {};
    for (const s of (j.suggestions || [])) m[s.id] = s;
    STATE.dispositionSuggestions = m;
  } catch { STATE.dispositionSuggestions = {}; }
}

// Heuristic fallback until the ML model fills in — not persisted. Keeps
// `dispositions.json` honest about what's actually user-confirmed.
function seedDisposition(e) {
  if (e.has_task) return { value: 'actionable', source: 'rule' };
  if (e.category === 'noise') return { value: 'info', source: 'rule' };
  return null;
}

function setSelectionMode(on) {
  STATE.selectionMode = !!on;
  if (!on) STATE.selected.clear();
  const btn = document.getElementById('select-mode-btn');
  if (btn) {
    btn.textContent = on ? 'Exit select' : 'Select';
    btn.classList.toggle('btn-primary', on);
  }
  const content = document.getElementById('content');
  if (content) content.classList.toggle('select-mode', on);
  updateBulkBar();
}

function toggleSelection(emailId, checked) {
  if (checked) STATE.selected.add(emailId);
  else STATE.selected.delete(emailId);
  // Update only the row's visual state; avoid a full re-render on each click.
  const row = document.querySelector(`[data-email-id="${CSS.escape(emailId)}"] .ch-line`);
  if (row) {
    row.classList.toggle('row-selected', checked);
    const cb = row.querySelector('.col-select input');
    if (cb) cb.checked = checked;
  }
  updateBulkBar();
}

function updateBulkBar() {
  const bar = document.getElementById('em-bulk-bar');
  const cnt = document.getElementById('em-bulk-count');
  if (!bar || !cnt) return;
  const n = STATE.selected.size;
  bar.classList.toggle('active', STATE.selectionMode && n > 0);
  cnt.textContent = `${n} selected`;
}

function selectAllVisible() {
  const filtered = filterEmails();
  for (const e of filtered) STATE.selected.add(e.id);
  renderEmails(filtered);
  updateBulkBar();
}

function clearSelection() {
  STATE.selected.clear();
  if (STATE.selectionMode) renderEmails(filterEmails());
  updateBulkBar();
}

async function bulkSetDisposition(value) {
  const ids = Array.from(STATE.selected);
  if (!ids.length) return;
  const ts = new Date().toISOString();
  for (const id of ids) {
    if (!value) delete STATE.dispositions[id];
    else STATE.dispositions[id] = { value, source: 'user', updated_at: ts };
  }
  try {
    await saveDispositions();
  } catch (err) {
    alert('Save failed: ' + err.message);
    return;
  }
  // Best-effort append each to the training log.
  for (const id of ids) {
    const e = STATE.emails.find(x => x.id === id);
    if (!e) continue;
    fetch('/api/disposition-decision', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        email_id: id,
        value: value || '',
        source: 'user',
        subject: e.subject || '',
        category: e.category,
        activity_type: e.activity_type || '',
      }),
    }).catch(() => {});
  }
  renderEmails(filterEmails());
}

async function bulkDelete() {
  const ids = Array.from(STATE.selected);
  if (!ids.length) return;
  if (!confirm(`Move ${ids.length} email${ids.length === 1 ? '' : 's'} to Trash?`)) return;
  for (const id of ids) {
    const e = STATE.emails.find(x => x.id === id);
    if (!e) continue;
    if (STATE.trash.some(t => t.id === id)) continue;
    STATE.trash.push({
      id, deleted_at: new Date().toISOString(), email: { ...e },
    });
  }
  await saveEmailTrash();
  STATE.selected.clear();
  await refresh();
}

async function bulkReassignCategory() {
  const ids = Array.from(STATE.selected);
  if (!ids.length) return;
  if (!window.YR_SHARED || !YR_SHARED.openBulkPicker) {
    alert('Category picker is not available on this page.');
    return;
  }
  // Seed the picker with the most common category/sub in the selection.
  const catCounts = {}, subCounts = {};
  for (const id of ids) {
    const e = STATE.emails.find(x => x.id === id);
    if (!e) continue;
    catCounts[e.category] = (catCounts[e.category] || 0) + 1;
    if (e.sub_category) subCounts[e.sub_category] = (subCounts[e.sub_category] || 0) + 1;
  }
  const dominantCat = Object.entries(catCounts).sort((a, b) => b[1] - a[1])[0]?.[0] || '';
  const dominantSub = Object.entries(subCounts).sort((a, b) => b[1] - a[1])[0]?.[0] || '';
  YR_SHARED.openBulkPicker({
    tree: STATE.subcatTree || {},
    counts: STATE.subcatCounts || {},
    initial: { category: dominantCat, sub_category: dominantSub },
    title: `Reassign ${ids.length} email${ids.length === 1 ? '' : 's'}`,
    mruKey: 'email',
    onApply: async ({ category, sub_category }) => {
      if (!category) return;
      for (const id of ids) {
        const e = STATE.emails.find(x => x.id === id);
        if (!e) continue;
        e.category = category;
        e.sub_category = sub_category;
        e.category_source = 'manual';
        e.activity_type = sub_category || category || e.activity_type;
        const existing = overrideToObj(STATE.categoryOverrides[id]) || {};
        STATE.categoryOverrides[id] = {
          ...existing,
          category,
          sub_category,
        };
      }
      await saveCategoryOverrides();
      if (category && sub_category) {
        YR_SHARED.addPathToTree(STATE.subcatTree, category, sub_category);
        YR_SHARED.addPathToCounts(STATE.subcatCounts, category, sub_category);
      }
      // Fire auto-attach in parallel (each lands on the same task per path).
      if (sub_category) {
        await Promise.all(ids.map(id => {
          const e = STATE.emails.find(x => x.id === id);
          return e ? attachEmailToTask(e) : null;
        }));
      }
      await refresh();
    },
  });
}

async function saveDispositions() {
  // Use the same api.save path every other settings file in this app uses —
  // it's proven to work and keeps disposition persistence independent of the
  // training-log append below (which is nice-to-have, not critical).
  await api.save('email_archive/dispositions.json', {
    dispositions: STATE.dispositions,
  });
}

async function setDisposition(email, value) {
  console.log('[disposition] setDisposition', email.id, '->', value || '(cleared)');
  const before = STATE.dispositions[email.id] || null;
  const cleared = !value;
  if (cleared) {
    delete STATE.dispositions[email.id];
  } else {
    STATE.dispositions[email.id] = {
      value, source: 'user', updated_at: new Date().toISOString(),
    };
  }
  // 1) persist disposition state — this is the critical write.
  try {
    await saveDispositions();
  } catch (err) {
    console.error('[disposition] save failed', err);
    alert('Could not save disposition: ' + err.message);
    return;
  }
  // 2) append to training log (best-effort; don't block UI on this).
  fetch('/api/disposition-decision', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      email_id: email.id,
      value: value || '',
      source: 'user',
      before,
      subject: email.subject || '',
      category: email.category,
      activity_type: email.activity_type || '',
    }),
  }).catch(err => console.warn('[disposition] training-log append failed', err));
  // 3) re-render just this row.
  const entry = document.querySelector(`[data-email-id="${CSS.escape(email.id)}"]`);
  if (entry && entry.parentNode) {
    const replacement = renderEmailEntry(email);
    entry.parentNode.replaceChild(replacement, entry);
  } else {
    console.warn('[disposition] could not find row to re-render; triggering full refresh');
    renderEmails(filterEmails());
  }
}

function renderDispositionChips(e) {
  const wrap = document.createElement('div');
  wrap.className = 'disp-chips';
  const current = STATE.dispositions[e.id] || null;          // { value, source }
  const suggestion = STATE.dispositionSuggestions[e.id] || null; // { value, confidence, reason }
  const seeded = !current ? seedDisposition(e) : null;       // heuristic when no user pick + no ML
  for (const opt of DISP_OPTIONS) {
    const chip = document.createElement('button');
    chip.type = 'button';
    chip.className = `disp-chip disp-${opt.value}`;
    const isUser = current && current.source === 'user' && current.value === opt.value;
    const isMLHint = !current && suggestion && suggestion.value === opt.value;
    const isSeedHint = !current && !suggestion && seeded && seeded.value === opt.value;
    if (isUser)      chip.classList.add('user-chosen');
    if (isMLHint)    chip.classList.add('ml-hint');
    if (isSeedHint)  chip.classList.add('seed-hint');
    chip.innerHTML = `<span class="disp-shape">${opt.shape}</span><span class="disp-label">${opt.label}</span>`;
    const tipParts = [];
    if (isMLHint) tipParts.push(`AI suggests: ${opt.label}${suggestion.reason ? ` \u2014 ${suggestion.reason}` : ''}`);
    else if (isSeedHint) tipParts.push(`Suggested by rule: ${opt.label}`);
    else tipParts.push(`Mark as ${opt.label}`);
    chip.title = tipParts.join(' \u2014 ');
    chip.addEventListener('click', async (ev) => {
      ev.stopPropagation();
      // Toggle off if they click the chip they already picked.
      const next = (isUser) ? '' : opt.value;
      await setDisposition(e, next);
    });
    wrap.appendChild(chip);
  }
  // ✨ Refine with AI — calls /api/refine-disposition and stores the result
  // under STATE.dispositionSuggestions[id] with source='llm' so it renders
  // as an ml-hint until the user accepts. Click-a-chip then confirms.
  const sug = document.createElement('button');
  sug.type = 'button';
  sug.className = 'disp-refine';
  sug.textContent = '\u2728';
  sug.title = 'Refine with AI';
  sug.addEventListener('click', async (ev) => {
    ev.stopPropagation();
    if (sug.disabled) return;
    sug.disabled = true;
    const prev = sug.textContent;
    sug.textContent = '\u2026';
    try {
      const res = await fetch('/api/refine-disposition', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ email_id: e.id }),
      });
      const j = await res.json();
      if (!j.ok) {
        alert('Refine failed: ' + (j.error || res.status));
        return;
      }
      STATE.dispositionSuggestions[e.id] = {
        id: e.id,
        value: j.value,
        confidence: j.confidence,
        reason: j.reason || 'AI suggestion',
        source: 'llm',
      };
      // Re-render the row so the hint appears on the matching chip.
      const entry = document.querySelector(`[data-email-id="${CSS.escape(e.id)}"]`);
      if (entry && entry.parentNode) {
        const replacement = renderEmailEntry(e);
        entry.parentNode.replaceChild(replacement, entry);
      }
    } catch (err) {
      alert('Refine failed: ' + err.message);
    } finally {
      sug.textContent = prev;
      sug.disabled = false;
    }
  });
  wrap.appendChild(sug);
  return wrap;
}

async function loadPredictions() {
  try {
    const j = await api.load('email_archive/predictions.json');
    STATE.predictions = {};
    for (const p of (j.predictions || [])) {
      STATE.predictions[p.id] = p.predicted_score;
    }
  } catch {
    STATE.predictions = {};
  }
}

// Overrides are stored as `{id: {category, sub_category?, assigned_task_id?}}`.
// Read also accepts the older bare-string shape `{id: "research"}` and upgrades
// it in memory so every code path can assume the object form.
function overrideToObj(v) {
  if (!v) return null;
  if (typeof v === 'string') return { category: v };
  return v;
}
function applyOverrideToEmail(e, ov) {
  if (!ov) return;
  if (ov.category) e.category = ov.category;
  if (ov.sub_category !== undefined) e.sub_category = ov.sub_category;
  if (ov.assigned_task_id) e.assigned_task_id = ov.assigned_task_id;
  e.category_source = 'manual';
  // User's picker choice becomes the activity_type, overriding the LLM's
  // free-form phrase. Rollup + sender breakdown then group by the path the
  // user actually picked.
  e.activity_type = ov.sub_category || ov.category || e.activity_type;
}

async function loadCategoryOverrides() {
  try {
    const j = await api.load('email_archive/category_overrides.json');
    STATE.categoryOverrides = j.overrides || {};
  } catch {
    STATE.categoryOverrides = {};
  }
  for (const e of STATE.emails) {
    applyOverrideToEmail(e, overrideToObj(STATE.categoryOverrides[e.id]));
  }
}

async function saveCategoryOverrides() {
  await api.save('email_archive/category_overrides.json', { overrides: STATE.categoryOverrides });
}

async function loadSubCategoryTree() {
  // Union of year-review paths + inbox tasks + ledger — same source the tasks
  // inbox uses. Keeps the picker tree in sync across pages.
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
  // Also include any sub_category values already in email overrides
  for (const v of Object.values(STATE.categoryOverrides || {})) {
    const o = overrideToObj(v);
    if (o && o.sub_category) records.push({ category: o.category, sub_category: o.sub_category });
  }
  STATE.subcatTree = YR_SHARED.buildTreeFromRecords(records);
  STATE.subcatCounts = YR_SHARED.buildCountsFromRecords(records);
  // Merge user-added seed paths so empty-but-pre-created sub-categories
  // show up as picker suggestions.
  if (YR_SHARED.mergeSeedsIntoTree) {
    await YR_SHARED.mergeSeedsIntoTree(STATE.subcatTree, STATE.subcatCounts);
  }
}

/* Phase 9 — paginated per-user email reads.
 *
 * Loading all 8.5k emails at once causes Firestore Listen channel timeouts
 * (QUIC_TOO_MANY_RTOS) on flaky connections and ~5s of stall on every page
 * load. Switching to year-bucketed pagination via direct Firestore queries:
 *
 *   - Boot: query userData/{uid}/emailMessages where internalDate ∈ [thisYear]
 *           limit 1000 (most recent first). ~600KB, ~1s.
 *   - Year picker change: same query, different range.
 *   - "Load older" button: cursor-paginated next 500 within the year.
 *   - summary.years: synthesized from a tiny aggregation query on a sample
 *                    OR statically 2024..currentYear+1 — most labs span 2-5 years.
 *
 * The IndexedDB cache (LOCAL_CACHE) keys per-year so repeat year clicks are
 * instant from cache. */
// Hard cap on the initial year fetch. 1000 docs ≈ 1.2 MB on the wire and
// dominates page LCP. Keep this small for the first paint; users can hit
// "Load more" to pull older messages within the year.
const EMAIL_PAGE_LIMIT = 250;

async function loadSummary() {
  const me = (typeof firebridge !== 'undefined' && firebridge.getUser) ? firebridge.getUser() : null;
  const yearsCache = window.LOCAL_CACHE && window.LOCAL_CACHE.scope('emailYears', 24 * 60 * 60_000);

  // Fast path: if we have a cached years list, use it immediately and skip
  // the network round-trip. Refresh in the background so new years (Jan 1
  // rollover) catch up within a day.
  if (yearsCache) {
    const cached = await yearsCache.get();
    if (cached && Array.isArray(cached.data) && cached.data.length) {
      STATE.summary = { years: cached.data, by_year: {} };
      STATE._sourceMode = 'firestore-paged';
      // Fire-and-forget refresh — corrects the cached years list if anything
      // changed (e.g. a new year just landed).
      _refreshYearsInBackground(me, yearsCache);
      return;
    }
  }

  if (me && firebridge.db) {
    try {
      const coll = firebridge.db().collection('userData').doc(me.uid).collection('emailMessages');
      const [oldest, newest] = await Promise.all([
        coll.orderBy('internalDate', 'asc').limit(1).get(),
        coll.orderBy('internalDate', 'desc').limit(1).get(),
      ]);
      if (!newest.empty) {
        const newestT = Number(newest.docs[0].data().internalDate) || 0;
        const oldestT = oldest.empty ? newestT : (Number(oldest.docs[0].data().internalDate) || newestT);
        const newestY = new Date(newestT).getFullYear();
        const oldestY = new Date(oldestT).getFullYear();
        const years = [];
        for (let y = oldestY; y <= newestY; y++) years.push(String(y));
        STATE.summary = { years, by_year: {} };  // counts filled lazily
        STATE._sourceMode = 'firestore-paged';
        if (yearsCache) yearsCache.put(years);
        return;
      }
    } catch (err) {
      console.warn('[email-review] year detection failed:', err.message);
    }
  }
  // Fallback: legacy on-disk summary.json (Alex's local-dev workflow).
  try {
    STATE.summary = (await api.load('email_archive/summary.json')).summary;
    STATE._sourceMode = 'legacy';
  } catch (e) {
    document.getElementById('content').innerHTML = `
      <div class="card" style="padding:20px">
        <p><strong>No email archive yet.</strong></p>
        <p>Connect Gmail in <a href="/rm/pages/settings.html">Settings</a> to sync your inbox,
           or run <code>python3 scripts/email_pipeline.py</code> locally to populate the legacy archive.</p>
        <p style="color:#9ca3af;font-size:12px;">Error: ${e.message}</p>
      </div>`;
    throw e;
  }
}

async function _refreshYearsInBackground(me, yearsCache) {
  if (!me || !firebridge.db) return;
  try {
    const coll = firebridge.db().collection('userData').doc(me.uid).collection('emailMessages');
    const [oldest, newest] = await Promise.all([
      coll.orderBy('internalDate', 'asc').limit(1).get(),
      coll.orderBy('internalDate', 'desc').limit(1).get(),
    ]);
    if (newest.empty) return;
    const newestT = Number(newest.docs[0].data().internalDate) || 0;
    const oldestT = oldest.empty ? newestT : (Number(oldest.docs[0].data().internalDate) || newestT);
    const years = [];
    for (let y = new Date(oldestT).getFullYear(); y <= new Date(newestT).getFullYear(); y++) years.push(String(y));
    yearsCache.put(years);
    // If the cached years differ from STATE.summary.years (e.g. new year added),
    // update the picker silently. The current year's data is still rendered.
    if (STATE.summary && JSON.stringify(years) !== JSON.stringify(STATE.summary.years || [])) {
      STATE.summary.years = years;
      // Re-render the picker if the page renders one.
      if (typeof renderYearPicker === 'function') renderYearPicker();
    }
  } catch (err) {
    console.warn('[email-review] year refresh failed:', err.message);
  }
}

// Cache scope per-year so each year load is instant on repeat visits.
// 1 hour TTL — emails arrive in batches every 15 min via the scrape so a
// stale cache for an hour just misses the most recent few messages, which
// the background refresh corrects within a beat.
function _emailYearCache(year) {
  return window.LOCAL_CACHE && window.LOCAL_CACHE.scope('emailMessages-' + year, 60 * 60_000);
}

// Cheap freshness check: 1-doc query to find the year's most-recent email's
// internalDate. If max <= cache savedAt, no new mail has arrived in this
// year since we last synced — skip the background refetch entirely.
// Returns `true` when a refetch IS needed.
async function _emailYearProbe(year, cachedSavedAt) {
  if (!cachedSavedAt) return true;
  try {
    const me = firebridge.getUser && firebridge.getUser();
    if (!me) return false;
    const yMin = new Date(year + '-01-01T00:00:00Z').getTime();
    const yMax = new Date((Number(year) + 1) + '-01-01T00:00:00Z').getTime();
    const snap = await firebridge.db()
      .collection('userData').doc(me.uid).collection('emailMessages')
      .where('internalDate', '>=', yMin)
      .where('internalDate', '<', yMax)
      .orderBy('internalDate', 'desc')
      .limit(1)
      .get();
    if (snap.empty) return false; // nothing in this year — no refresh needed
    const top = Number(snap.docs[0].data().internalDate) || 0;
    // Allow 60s slack so clock skew between client + server doesn't cause
    // false-positive refetches.
    return top > (cachedSavedAt + 60_000);
  } catch (err) {
    // Fail-safe: probe error → do the refetch (don't risk stale data).
    console.warn('[email-review] probe failed:', err.message);
    return true;
  }
}

// Direct Firestore query for one year, ordered newest-first, with hard limit.
async function _fetchEmailMessagesForYear(year) {
  const me = firebridge.getUser && firebridge.getUser();
  if (!me) return [];
  const yMin = new Date(year + '-01-01T00:00:00Z').getTime();
  const yMax = new Date((Number(year) + 1) + '-01-01T00:00:00Z').getTime();
  const snap = await firebridge.db()
    .collection('userData').doc(me.uid).collection('emailMessages')
    .where('internalDate', '>=', yMin)
    .where('internalDate', '<', yMax)
    .orderBy('internalDate', 'desc')
    .limit(EMAIL_PAGE_LIMIT)
    .get();
  return snap.docs.map(d => Object.assign({ id: d.id }, d.data()));
}

/* Reshape an emailMessages doc (flat schema from the Gmail scraper or the
 * archive backfill) into the shape email-review's renderer expects:
 *   - from/to/cc as [{name, email}] arrays (the renderer reads e.from[0].email)
 *   - body_preview alias for snippet
 *   - keep category/activity_type/etc. from backfill metadata when present */
function _coerceLegacyEmailShape(m) {
  function parseAddrs(s) {
    if (!s) return [];
    if (Array.isArray(s)) {
      // Already parsed (some backfill rows use the legacy list-of-dicts shape).
      return s.map(x => typeof x === 'string'
        ? { name: '', email: x }
        : { name: x.name || '', email: x.email || '' });
    }
    // Split comma-separated, then extract Name <email> per part.
    return String(s).split(/,\s*/).map(part => {
      const m = part.match(/^"?([^"<]+?)"?\s*<([^>]+)>$/);
      if (m) return { name: m[1].trim(), email: m[2].trim() };
      return { name: '', email: part.trim() };
    }).filter(x => x.email || x.name);
  }
  return Object.assign({}, m, {
    from: parseAddrs(m.from),
    to: parseAddrs(m.to),
    cc: parseAddrs(m.cc),
    body_preview: m.body_preview || m.snippet || '',
  });
}

function _synthesizeEmailSummary(messages) {
  const byYear = {};
  for (const m of messages) {
    const t = Number(m.internalDate) || 0;
    let y = '';
    if (t) y = new Date(t).getFullYear().toString();
    else if (m.date) y = (m.date.match(/\b(20\d\d)\b/) || [])[1] || '';
    if (!/^\d{4}$/.test(y)) continue;
    if (!byYear[y]) byYear[y] = { total: 0 };
    byYear[y].total++;
  }
  const years = Object.keys(byYear).sort();
  return { years, by_year: byYear };
}

async function loadRatings() {
  try {
    STATE.ratings = await api.load('email_archive/ratings.json');
    if (!STATE.ratings.by_email) STATE.ratings.by_email = {};
    if (!STATE.ratings.by_activity) STATE.ratings.by_activity = {};
    if (!STATE.ratings.by_sender) STATE.ratings.by_sender = {};
  } catch {
    STATE.ratings = { by_email: {}, by_activity: {}, by_sender: {} };
  }
}

function senderKey(e) {
  const a = (e.from || [])[0];
  return a ? (a.email || '').toLowerCase() : '';
}

function effectiveRating(e) {
  if (e.id in STATE.ratings.by_email) return STATE.ratings.by_email[e.id];
  const sk = senderKey(e);
  if (sk && sk in STATE.ratings.by_sender) return STATE.ratings.by_sender[sk];
  if (e.activity_type && e.activity_type in STATE.ratings.by_activity) {
    return STATE.ratings.by_activity[e.activity_type];
  }
  return 0;
}

async function saveRatings() {
  await api.save('email_archive/ratings.json', STATE.ratings);
}

async function loadEmailTrash() {
  try {
    const t = await api.load('email_archive/trash.json');
    STATE.trash = Array.isArray(t.trash) ? t.trash : [];
    STATE.permanentlyDeletedIds = Array.isArray(t.permanently_deleted_ids) ? t.permanently_deleted_ids : [];
  } catch {
    STATE.trash = [];
    STATE.permanentlyDeletedIds = [];
  }
}

async function saveEmailTrash() {
  await api.save('email_archive/trash.json', {
    trash: STATE.trash,
    permanently_deleted_ids: STATE.permanentlyDeletedIds,
  });
}

function emailDeletedIdSet() {
  const s = new Set(STATE.permanentlyDeletedIds);
  for (const t of STATE.trash) s.add(t.id);
  return s;
}

async function deleteEmail(e) {
  if (!e || !e.id) return;
  if (STATE.trash.some(t => t.id === e.id)) return;
  STATE.trash.push({
    id: e.id,
    deleted_at: new Date().toISOString(),
    email: { ...e },
  });
  await saveEmailTrash();
}

async function restoreEmail(id) {
  STATE.trash = STATE.trash.filter(t => t.id !== id);
  await saveEmailTrash();
}

async function emptyEmailTrash() {
  for (const t of STATE.trash) {
    if (!STATE.permanentlyDeletedIds.includes(t.id)) {
      STATE.permanentlyDeletedIds.push(t.id);
    }
  }
  STATE.trash = [];
  await saveEmailTrash();
}

async function loadYear(year) {
  STATE.expandedEmails = new Set();
  STATE.detailCache = {};

  if (STATE._sourceMode === 'firestore-paged') {
    // 'all' would explode the load to 8500 docs — cap at the most recent year
    // when user picks 'all', else load just the requested year. The user can
    // change the year picker for older mail.
    const targetYear = (year === 'all') ? String(new Date().getFullYear()) : year;
    const cache = _emailYearCache(targetYear);

    let raw = null;
    const t0 = performance.now();
    if (cache) {
      const cached = await cache.get();
      if (cached && Array.isArray(cached.data) && cached.data.length) {
        raw = cached.data;
        const cachedSavedAt = (cached && cached.age != null) ? Date.now() - cached.age : 0;
        console.info('[email-review] cache HIT for', targetYear,
                     '— ' + raw.length + ' rows in ' + Math.round(performance.now() - t0) + 'ms' +
                     (cached.stale ? ' (stale)' : ' (fresh)'));
        // Only fire the probe when the cache is past its TTL. Within the TTL
        // window (1 hour for email per-year) we serve cached and skip the
        // freshness check entirely — saves the probe's network round-trip
        // AND any followup full re-fetch when new mail has arrived since
        // last sync. Tradeoff: at most 1 hour of staleness for new email
        // metadata in this view; click "Refresh" or pick a different year
        // to force a sync.
        if (cached.stale) {
          _emailYearProbe(targetYear, cachedSavedAt).then(needsRefresh => {
            if (!needsRefresh) {
              console.info('[email-review] probe says ' + targetYear + ' unchanged; skipping refetch');
              // Re-put with current timestamp so the TTL window restarts.
              cache.put(raw);
              return;
            }
            return _fetchEmailMessagesForYear(targetYear).then(fresh => {
              if (fresh && fresh.length) cache.put(fresh);
              if (fresh && fresh.length !== raw.length) {
                STATE.emails = fresh.map(_coerceLegacyEmailShape);
                for (const e of STATE.emails) {
                  applyOverrideToEmail(e, overrideToObj(STATE.categoryOverrides[e.id]));
                }
                if (typeof render === 'function') render();
              }
            });
          }).catch(err => console.warn('[email-review] year refresh failed:', err.message));
        }
      } else {
        console.info('[email-review] cache MISS for', targetYear);
      }
    }
    if (!raw) {
      raw = await _fetchEmailMessagesForYear(targetYear);
      // Await the put so the cache is durable BEFORE the user can reload.
      // Without this, fast reloads can race the IndexedDB write and miss.
      if (cache) await cache.put(raw);
    }
    STATE.emails = raw.map(_coerceLegacyEmailShape);
    if (STATE.summary && STATE.summary.by_year) {
      STATE.summary.by_year[targetYear] = { total: raw.length };
    }
    STATE.year = year;
    for (const e of STATE.emails) {
      applyOverrideToEmail(e, overrideToObj(STATE.categoryOverrides[e.id]));
    }
    return;
  }

  if (year === 'all') {
    // Legacy on-disk path: pull every year file in parallel, concatenate.
    const years = (STATE.summary?.years || []).slice().sort();
    const docs = await Promise.all(
      years.map(y => api.load(`email_archive/by_year/${y}.json`).catch(() => ({ emails: [] })))
    );
    STATE.emails = [].concat(...docs.map(d => d.emails || []));
  } else {
    const data = await api.load(`email_archive/by_year/${year}.json`);
    STATE.emails = data.emails || [];
  }
  STATE.year = year;
  for (const e of STATE.emails) {
    applyOverrideToEmail(e, overrideToObj(STATE.categoryOverrides[e.id]));
  }
}

function renderCatToggles() {
  const host = document.getElementById('cat-toggles');
  host.innerHTML = '';
  // Per-category counts for the CURRENT year (to show on the chips)
  const counts = {};
  for (const c of ALL_CATS) counts[c] = 0;
  for (const e of STATE.emails) counts[e.category] = (counts[e.category] || 0) + 1;
  for (const c of ALL_CATS) {
    if (!counts[c] && c !== 'unknown') continue; // hide empty chips except unknown
    const btn = document.createElement('span');
    btn.className = `cat-toggle cat-toggle-${c}` + (STATE.filter.cats.has(c) ? '' : ' off');
    btn.dataset.cat = c;
    btn.title = `Toggle ${c} — click to show/hide`;
    btn.textContent = `${c} ${counts[c].toLocaleString()}`;
    btn.addEventListener('click', () => {
      if (STATE.filter.cats.has(c)) STATE.filter.cats.delete(c);
      else STATE.filter.cats.add(c);
      saveCatFilter(STATE.filter.cats);
      refresh();
    });
    host.appendChild(btn);
  }
  // "All" / "None" quick actions
  const spacer = document.createElement('span');
  spacer.style.width = '12px';
  host.appendChild(spacer);
  for (const [label, fn] of [
    ['all', () => { STATE.filter.cats = new Set(ALL_CATS); }],
    ['none', () => { STATE.filter.cats = new Set(); }],
    ['-noise', () => { STATE.filter.cats = new Set(ALL_CATS.filter(c => c !== 'noise')); }],
  ]) {
    const b = document.createElement('span');
    b.className = 'cat-toggle';
    b.style.background = '#fff';
    b.style.border = '1px solid #e5e7eb';
    b.style.color = '#374151';
    b.textContent = label;
    b.addEventListener('click', () => {
      fn();
      saveCatFilter(STATE.filter.cats);
      refresh();
    });
    host.appendChild(b);
  }
}

function populateYearSelect() {
  const sel = document.getElementById('year-filter');
  sel.innerHTML = '';
  const years = (STATE.summary.years || []).slice().sort().reverse();
  const grandTotal = years.reduce(
    (s, y) => s + (STATE.summary.by_year[y]?.total || 0), 0,
  );
  const allOpt = document.createElement('option');
  allOpt.value = 'all';
  allOpt.textContent = `All years (${grandTotal.toLocaleString()})`;
  sel.appendChild(allOpt);
  for (const y of years) {
    const opt = document.createElement('option');
    opt.value = y;
    const total = STATE.summary.by_year[y]?.total || 0;
    opt.textContent = `${y} (${total})`;
    sel.appendChild(opt);
  }
}

function categoryTag(cat) {
  return `<span class="er-tag er-tag-${cat || 'unknown'}">${cat || 'unknown'}</span>`;
}

function starBar(current, onSet) {
  const el = document.createElement('span');
  el.className = 'stars';
  for (let i = 1; i <= 5; i++) {
    const s = document.createElement('span');
    s.className = 's' + (i <= (current || 0) ? ' on' : '');
    s.textContent = '\u2605';
    s.addEventListener('click', async (ev) => {
      ev.stopPropagation();
      const v = i === current ? 0 : i;
      await onSet(v);
    });
    el.appendChild(s);
  }
  return el;
}

function filterEmails() {
  const { cats, search, onlyTasks } = STATE.filter;
  const q = (search || '').toLowerCase().trim();
  const deleted = emailDeletedIdSet();
  let rows = STATE.emails.filter(e => {
    if (deleted.has(e.id)) return false;
    if (!cats.has(e.category)) return false;
    if (onlyTasks && !e.has_task) return false;
    if (q) {
      // Include the full "category:sub_category" path so searches like
      // "research:grant:onr" match the path prefix in one go.
      const path = (e.category || '') + (e.sub_category ? ':' + e.sub_category : '');
      const hay = (
        (e.subject || '') + ' ' +
        (e.from || []).map(a => a.email || '').join(' ') + ' ' +
        (e.activity_type || '') + ' ' +
        path + ' ' +
        (e.sub_category || '')
      ).toLowerCase();
      if (!hay.includes(q)) return false;
    }
    return true;
  });
  switch (STATE.sort) {
    case 'date-asc':
      rows.sort((a, b) => (a.date || '').localeCompare(b.date || ''));
      break;
    case 'predicted-desc':
      rows.sort((a, b) => (STATE.predictions[b.id] || 0) - (STATE.predictions[a.id] || 0));
      break;
    case 'rating-desc':
      rows.sort((a, b) => effectiveRating(b) - effectiveRating(a));
      break;
    default: // date-desc
      rows.sort((a, b) => (b.date || '').localeCompare(a.date || ''));
  }
  return rows;
}

function renderYearReview(emails) {
  const host = document.getElementById('year-review');
  if (!emails.length) { host.innerHTML = ''; return; }
  const byCat = { research: 0, teaching: 0, service: 0, admin: 0, personal: 0, noise: 0, unknown: 0 };
  const byStar = { 0: 0, 1: 0, 2: 0, 3: 0, 4: 0, 5: 0 };
  let taskCount = 0;
  let attachCount = 0;
  for (const e of emails) {
    byCat[e.category] = (byCat[e.category] || 0) + 1;
    if (e.has_task) taskCount += 1;
    if (e.attachment_hashes?.length) attachCount += e.attachment_hashes.length;
    const r = effectiveRating(e);
    byStar[r] = (byStar[r] || 0) + 1;
  }
  const total = emails.length;
  const pct = (n) => total ? ((n / total) * 100).toFixed(1) + '%' : '0%';
  const rated = total - byStar[0];
  host.innerHTML = `
    <h3 style="margin-bottom:10px">${STATE.year === 'all' ? 'All-years snapshot' : `Year-end snapshot \u2014 ${STATE.year}`}</h3>
    <div style="display:grid;grid-template-columns:repeat(auto-fit,minmax(140px,1fr));gap:10px;font-size:13px">
      <div><strong style="font-size:20px">${total.toLocaleString()}</strong><br><span style="color:#6b7280">emails total</span></div>
      <div><strong style="font-size:20px">${taskCount}</strong><br><span style="color:#6b7280">actionable tasks</span></div>
      <div><strong style="font-size:20px">${attachCount}</strong><br><span style="color:#6b7280">attachments</span></div>
      <div><strong style="font-size:20px">${rated}</strong><br><span style="color:#6b7280">rated (of ${total})</span></div>
    </div>
    <div style="margin-top:10px;font-size:13px">
      ${['research','teaching','service','admin','personal','noise','unknown'].map(c =>
        byCat[c] ? `${categoryTag(c)} <strong>${byCat[c]}</strong> <span style="color:#9ca3af">(${pct(byCat[c])})</span>` : ''
      ).filter(Boolean).join(' \u00b7 ')}
    </div>`;
}

function renderTimeline(emails) {
  // Two axes: single year → 12 monthly buckets; 'all' → one bucket per year.
  const isAll = STATE.year === 'all';
  let buckets, labels;
  if (isAll) {
    const yearsSeen = new Set();
    for (const e of emails) {
      const y = (e.date || '').slice(0, 4);
      if (y) yearsSeen.add(y);
    }
    labels = Array.from(yearsSeen).sort();
  } else {
    labels = Array.from({ length: 12 }, (_, i) => `${STATE.year}-${String(i + 1).padStart(2, '0')}`);
  }
  const keyToIdx = Object.fromEntries(labels.map((k, i) => [k, i]));
  const counts = {};
  for (const c of CATS) counts[c] = new Array(labels.length).fill(0);
  for (const e of emails) {
    const d = e.date || '';
    if (!d) continue;
    const key = isAll ? d.slice(0, 4) : d.slice(0, 7);
    const idx = keyToIdx[key];
    if (idx === undefined) continue;
    const c = CATS.includes(e.category) ? e.category : 'unknown';
    if (!STATE.filter.cats.has(c)) continue;
    counts[c][idx] += 1;
  }
  const datasets = CATS
    .filter(c => STATE.filter.cats.has(c) && counts[c].some(v => v > 0))
    .map(c => ({
      label: c,
      data: counts[c],
      backgroundColor: CAT_COLORS[c],
      stack: 'cat',
    }));
  const canvas = document.getElementById('timeline-chart');
  if (!canvas) return;
  if (STATE.timelineChart) {
    // In-place update avoids flicker + the canvas disappearing between renders.
    STATE.timelineChart.data.labels = labels;
    STATE.timelineChart.data.datasets = datasets;
    STATE.timelineChart.update('none');
    return;
  }
  STATE.timelineChart = new Chart(canvas.getContext('2d'), {
    type: 'bar',
    data: { labels, datasets },
    options: {
      responsive: true, maintainAspectRatio: false,
      plugins: {
        legend: { position: 'bottom', labels: { boxWidth: 10, font: { size: 11 } } },
      },
      scales: {
        x: { stacked: true, ticks: { font: { size: 10 }, autoSkip: false } },
        y: { stacked: true, beginAtZero: true },
      },
    },
  });
}

function renderActivityRollup(emails) {
  // `emails` already respects the current category filter, so the rollup
  // only surfaces activities from visible categories.
  const byActivity = {};
  for (const e of emails) {
    const k = e.activity_type || '(unspecified)';
    const b = byActivity[k] || (byActivity[k] = { count: 0, cat: e.category, withTasks: 0, emails: [] });
    b.count += 1;
    if (e.has_task) b.withTasks += 1;
    b.emails.push(e);
  }
  const rows = Object.entries(byActivity)
    .filter(([k]) => k !== '(unspecified)')
    .sort((a, b) => b[1].count - a[1].count).slice(0, 20);
  const host = document.getElementById('activity-rollup');
  // Panel header already says "Top activities by volume"; just render rows.
  host.innerHTML = '';
  if (!rows.length) {
    host.innerHTML = '<div style="padding:8px;color:#6b7280;font-size:12px">No activities match the current filter.</div>';
    return;
  }

  for (const [name, info] of rows) {
    const row = document.createElement('div');
    row.className = 'activity-item';
    row.style.cursor = 'pointer';
    const lbl = document.createElement('div');
    lbl.className = 'lbl';
    const expanded = STATE.expandedActivities && STATE.expandedActivities.has(name);
    const caret = expanded ? '\u25BE' : '\u25B8';
    lbl.innerHTML = `<span style="display:inline-block;width:12px;color:#9ca3af">${caret}</span>${categoryTag(info.cat)} <span style="margin-left:6px">${escapeHtml(name)}</span>`;
    const cnt = document.createElement('div');
    cnt.className = 'cnt';
    cnt.textContent = `${info.count} (${info.withTasks} tasks)`;
    const stars = starBar(STATE.ratings.by_activity[name] || 0, async (v) => {
      if (v === 0) delete STATE.ratings.by_activity[name];
      else STATE.ratings.by_activity[name] = v;
      await saveRatings();
      renderActivityRollup(emails);
      renderEmails(filterEmails());
    });
    row.appendChild(lbl);
    row.appendChild(cnt);
    row.appendChild(stars);
    row.addEventListener('click', (ev) => {
      // don't toggle if the click landed on a star
      if (ev.target.closest('.stars')) return;
      if (!STATE.expandedActivities) STATE.expandedActivities = new Set();
      if (STATE.expandedActivities.has(name)) STATE.expandedActivities.delete(name);
      else STATE.expandedActivities.add(name);
      renderActivityRollup(emails);
    });
    host.appendChild(row);

    if (expanded) {
      host.appendChild(renderSenderBreakdown(name, info.emails));
    }
  }
}

function renderSenderBreakdown(activityName, emails) {
  const wrap = document.createElement('div');
  wrap.style.cssText = 'margin:2px 0 8px 24px;padding:8px 10px;background:#fff;border:1px solid #e5e7eb;border-radius:6px';
  const bySender = {};
  for (const e of emails) {
    const key = senderKey(e) || '(unknown)';
    const s = bySender[key] || (bySender[key] = { count: 0, name: '', example: '' });
    s.count += 1;
    const a = (e.from || [])[0];
    if (a && a.name && !s.name) s.name = a.name;
    if (!s.example) s.example = e.subject || '';
  }
  const rows = Object.entries(bySender).sort((a, b) => b[1].count - a[1].count).slice(0, 10);
  const header = document.createElement('div');
  header.style.cssText = 'font-size:11px;color:#9ca3af;margin-bottom:4px;text-transform:uppercase;letter-spacing:.5px';
  header.textContent = `top senders for "${activityName}"`;
  wrap.appendChild(header);
  for (const [sk, info] of rows) {
    const r = document.createElement('div');
    r.className = 'activity-item';
    r.style.padding = '3px 0';
    const lbl = document.createElement('div');
    lbl.className = 'lbl';
    lbl.style.fontSize = '12px';
    lbl.innerHTML = `<span style="color:#374151">${escapeHtml(info.name || sk)}</span>
      <span style="color:#9ca3af;margin-left:6px;font-size:11px">${escapeHtml(sk)}</span>
      <div style="color:#9ca3af;font-size:11px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;max-width:480px">e.g. ${escapeHtml(info.example)}</div>`;
    const cnt = document.createElement('div');
    cnt.className = 'cnt';
    cnt.style.fontSize = '12px';
    cnt.textContent = `${info.count}`;
    const stars = starBar(STATE.ratings.by_sender[sk] || 0, async (v) => {
      if (v === 0) delete STATE.ratings.by_sender[sk];
      else STATE.ratings.by_sender[sk] = v;
      await saveRatings();
      renderActivityRollup(emails);
      renderEmails(filterEmails());
    });
    r.appendChild(lbl);
    r.appendChild(cnt);
    r.appendChild(stars);
    wrap.appendChild(r);
  }
  return wrap;
}

function renderEmails(emails) {
  const host = document.getElementById('content');
  host.innerHTML = '';
  if (!emails.length) {
    host.innerHTML = `<div style="padding:20px;color:#6b7280">No emails match the current filter.</div>`;
    return;
  }
  const wrap = document.createElement('div');
  wrap.className = 'card';
  for (const e of emails.slice(0, 500)) {
    wrap.appendChild(renderEmailEntry(e));
  }
  host.appendChild(wrap);
  if (emails.length > 500) {
    const more = document.createElement('div');
    more.style.padding = '10px';
    more.style.color = '#6b7280';
    more.textContent = `(showing first 500 of ${emails.length} — narrow filters to see more)`;
    host.appendChild(more);
  }
}

function renderEmailEntry(e) {
  // Mirrors the calendar-history row layout (.ch-line) so both activity views
  // read the same way: date · category · title+sub · meta · stars · actions.
  const entry = document.createElement('div');
  entry.className = 'email-entry';
  entry.dataset.emailId = e.id;

  const caret = STATE.expandedEmails.has(e.id) ? '\u25BE' : '\u25B8';
  const fromStr = (e.from || []).map(a => a.name || a.email).filter(Boolean).join(', ');
  // After a manual override, activity_type mirrors sub_category — show just
  // one so the row doesn't repeat the same path twice.
  const showSub = e.sub_category && e.sub_category !== e.activity_type;
  const subLine = [
    e.activity_type ? escapeHtml(e.activity_type) : '',
    fromStr ? escapeHtml(fromStr) : '',
    showSub ? escapeHtml(e.sub_category) : '',
  ].filter(Boolean).join(' \u00b7 ');

  // col-meta = compact signal column: task badge + attachment count.
  const metaBits = [];
  if (e.assigned_task_id) {
    const title = e.assigned_task_title || e.assigned_task_id;
    metaBits.push(`<span title="Task: ${escapeHtml(e.assigned_task_id)}">\u2192 ${escapeHtml(title)}</span>`);
  } else if (e.has_task) {
    metaBits.push('<span style="color:#166534">task</span>');
  }
  if (e.attachment_hashes?.length) {
    metaBits.push(`${e.attachment_hashes.length}\u{1F4CE}`);
  }

  const row = document.createElement('div');
  row.className = 'ch-line';
  const isSelected = STATE.selected.has(e.id);
  if (isSelected) row.classList.add('row-selected');
  row.innerHTML = `
    <div class="col-select"><input type="checkbox"${isSelected ? ' checked' : ''}></div>
    <div class="col-date">${escapeHtml((e.date || '').slice(0, 10))}</div>
    <div>${categoryTag(e.category)}${e.category_source === 'manual' ? '<span style="margin-left:4px;font-size:10px;padding:1px 4px;background:#fde68a;color:#78350f;border-radius:4px">edit</span>' : ''}</div>
    <div class="col-main">
      <div class="title"><span style="color:#9ca3af;margin-right:4px">${caret}</span>${escapeHtml(e.subject || '(no subject)')}</div>
      <div class="sub">${subLine}</div>
      <div class="disp-slot"></div>
    </div>
    <div class="col-meta">${metaBits.join(' \u00b7 ')}</div>
    <div class="col-stars"></div>
    <div class="col-actions"></div>
  `;
  row.querySelector('.disp-slot').appendChild(renderDispositionChips(e));

  // Checkbox is always in the DOM; only visible (via CSS) in selection mode.
  const selBox = row.querySelector('.col-select input');
  selBox.addEventListener('click', (ev) => {
    ev.stopPropagation();
    toggleSelection(e.id, selBox.checked);
  });

  row.querySelector('.col-stars').appendChild(starBar(
    effectiveRating(e),
    async (v) => {
      if (v === 0) delete STATE.ratings.by_email[e.id];
      else STATE.ratings.by_email[e.id] = v;
      await saveRatings();
      const fresh = renderEmailEntry(e);
      entry.parentNode.replaceChild(fresh, entry);
    },
  ));

  const del = document.createElement('button');
  del.className = 'ch-del-btn';
  del.type = 'button';
  del.title = 'Move to Trash';
  del.innerHTML = '\u{1F5D1}';
  del.addEventListener('click', async (ev) => {
    ev.stopPropagation();
    await deleteEmail(e);
    await refresh();
  });
  row.querySelector('.col-actions').appendChild(del);

  row.addEventListener('click', (ev) => {
    if (ev.target.closest('.stars')) return;
    if (ev.target.closest('.col-actions')) return;
    if (ev.target.closest('.disp-chips')) return;
    if (ev.target.closest('.col-select')) return;
    if (STATE.selectionMode) {
      toggleSelection(e.id, !STATE.selected.has(e.id));
      return;
    }
    toggleEmailExpand(e, entry);
  });
  entry.appendChild(row);

  if (STATE.expandedEmails.has(e.id)) {
    entry.appendChild(renderEmailExpand(e));
  }
  return entry;
}

function renderEmailExpand(e) {
  const panel = document.createElement('div');
  panel.className = 'ch-detail';
  panel.addEventListener('click', (ev) => ev.stopPropagation());
  const meta = document.createElement('div');
  meta.style.cssText = 'font-size:12px;color:#6b7280;margin-bottom:8px';
  meta.textContent = `from ${(e.from || []).map(a => a.email).join(', ')} \u00b7 ${(e.date || '').slice(0, 10)} \u00b7 ${e.category}${e.activity_type ? ' / ' + e.activity_type : ''}`;
  panel.appendChild(meta);

  // Body + attachments are hidden until the user asks for them. This keeps
  // the expand cheap (no body fetch) and keeps long email text out of the
  // way when the user is just rating or recategorizing.
  const toggle = document.createElement('button');
  toggle.type = 'button';
  toggle.className = 'btn btn-sm';
  toggle.style.cssText = 'font-size:12px;padding:4px 10px;margin-bottom:8px';
  toggle.textContent = '\u25B8 Show email body';

  const bodyEl = document.createElement('div');
  bodyEl.className = 'body';
  bodyEl.style.display = 'none';

  const attsEl = document.createElement('div');
  attsEl.className = 'atts';
  attsEl.style.display = 'none';

  let loaded = false;
  let open = false;
  toggle.addEventListener('click', async (ev) => {
    ev.stopPropagation();
    open = !open;
    if (!open) {
      bodyEl.style.display = 'none';
      attsEl.style.display = 'none';
      toggle.textContent = '\u25B8 Show email body';
      return;
    }
    toggle.textContent = '\u25BE Hide email body';
    bodyEl.style.display = '';
    if (!loaded) {
      bodyEl.textContent = 'loading\u2026';
      try {
        const detail = await fetchEmailDetail(e);
        if (!detail) {
          bodyEl.textContent = '(failed to load)';
          return;
        }
        const body = detail.body_text || stripHtml(detail.body_html) || '(no body)';
        bodyEl.textContent = body;
        const atts = detail.attachments || [];
        if (atts.length) {
          const parts = ['<strong>Attachments:</strong> '];
          for (const a of atts) {
            parts.push(`<a href="${a.url}" target="_blank" rel="noopener">${escapeHtml(a.filename)} (${fmtBytes(a.size_bytes)})</a>`);
          }
          attsEl.innerHTML = parts.join('');
          attsEl.style.display = '';
        }
        loaded = true;
      } catch (err) {
        bodyEl.textContent = 'failed to load: ' + err.message;
      }
    } else if (attsEl.innerHTML) {
      attsEl.style.display = '';
    }
  });

  panel.appendChild(toggle);
  panel.appendChild(bodyEl);
  panel.appendChild(attsEl);
  panel.appendChild(renderCategoryEditor(e));
  panel.appendChild(renderRelatedTasksSection(e));

  // "Build a task from this email" — pick a project + fill fields + create.
  if (window.TASK_QUICK_BUILDER) {
    const fromStr = (e.from || []).map(a => a.email || a.name).filter(Boolean).join(', ');
    const dateStr = (e.date || '').slice(0, 10);
    const descParts = [];
    if (fromStr) descParts.push(`From: ${fromStr}`);
    if (dateStr) descParts.push(`Date: ${dateStr}`);
    if (e.snippet) descParts.push('', e.snippet);
    panel.appendChild(window.TASK_QUICK_BUILDER.render({
      kind: 'email',
      sourceId: e.id,
      defaultTitle: e.subject || '(untitled)',
      defaultDescription: descParts.join('\n'),
      defaultDue: null,
    }));
  }
  return panel;
}

/* ---------- Related tasks section ----------
 *
 * Collapsed-by-default panel that lists tasks sharing this email's
 * category/sub_category path. Each task renders via TASK_EDITOR.render so
 * the UI and save behavior are identical to the tasks-inbox page.
 */

async function loadTasksInboxIfNeeded(force) {
  if (STATE.tasksInbox && !force) return STATE.tasksInbox;
  try {
    STATE.tasksInbox = await api.load('tasks/inbox.json');
  } catch {
    STATE.tasksInbox = { tasks: [] };
  }
  if (!Array.isArray(STATE.tasksInbox.tasks)) STATE.tasksInbox.tasks = [];
  return STATE.tasksInbox;
}

async function saveTasksInbox() {
  if (!STATE.tasksInbox) return;
  STATE.tasksInbox.generated_at = new Date().toISOString();
  await api.save('tasks/inbox.json', STATE.tasksInbox);
}

async function loadPinnedBucketsIfNeeded(force) {
  if (STATE.pinnedBucketKeys && !force) return STATE.pinnedBucketKeys;
  try {
    const doc = await api.load('tasks/pinned_buckets.json');
    STATE.pinnedBucketKeys = new Set(
      (doc.buckets || []).map(b => `${b.category || ''}\u00A7${b.sub_category || ''}`)
    );
  } catch {
    STATE.pinnedBucketKeys = new Set();
  }
  return STATE.pinnedBucketKeys;
}

// Toggle the bucket that contains `task` (category + sub_category pair).
// Matches the bucket-pinning scheme on tasks-inbox — one source of truth,
// rendered on the dashboard as an "Engaged Projects" box for each bucket.
async function toggleBucketPin(task) {
  const cat = task.category || '';
  const sub = task.sub_category || '';
  const key = `${cat}\u00A7${sub}`;
  let doc;
  try { doc = await api.load('tasks/pinned_buckets.json'); }
  catch { doc = { buckets: [] }; }
  doc.buckets = doc.buckets || [];
  const existing = doc.buckets.findIndex(b =>
    (b.category || '') === cat && (b.sub_category || '') === sub);
  if (existing >= 0) doc.buckets.splice(existing, 1);
  else doc.buckets.push({ category: cat, sub_category: sub });
  doc.updated_at = new Date().toISOString();
  await api.save('tasks/pinned_buckets.json', doc);
  STATE.pinnedBucketKeys = new Set(doc.buckets.map(b =>
    `${b.category || ''}\u00A7${b.sub_category || ''}`));
  return STATE.pinnedBucketKeys.has(key);
}

function tasksMatchingEmail(email, inbox) {
  // Match the tag: same category AND same sub_category (if the email has one).
  // If the email has no sub_category, fall back to category-only match so the
  // user still sees something to anchor the relationship on.
  const cat = email.category || '';
  const sub = email.sub_category || '';
  const tasks = (inbox?.tasks || []);
  if (!cat) return [];
  if (sub) {
    return tasks.filter(t => t.category === cat && t.sub_category === sub);
  }
  return tasks.filter(t => t.category === cat && !t.sub_category);
}

function renderRelatedTasksSection(email) {
  const wrap = document.createElement('div');
  wrap.className = 'related-tasks-section';
  wrap.style.cssText = 'margin-top:10px;padding-top:8px;border-top:1px dashed #e5e7eb';

  const isOpen = STATE.relatedTasksOpen.has(email.id);

  const header = document.createElement('button');
  header.type = 'button';
  header.style.cssText = 'background:none;border:none;padding:4px 0;cursor:pointer;font-size:12px;color:#374151;display:flex;align-items:center;gap:6px;width:100%;text-align:left;font-weight:600;text-transform:uppercase;letter-spacing:.4px';
  const caret = document.createElement('span');
  caret.style.cssText = 'color:#9ca3af;font-size:10px';
  caret.textContent = isOpen ? '\u25BE' : '\u25B8';
  const label = document.createElement('span');
  label.textContent = 'Related tasks';
  const tagChip = document.createElement('span');
  tagChip.style.cssText = 'font-weight:400;text-transform:none;letter-spacing:0;color:#6b7280;font-size:11px';
  const tagPath = [email.category, email.sub_category].filter(Boolean).join(' / ') || '(no category)';
  tagChip.textContent = tagPath;
  const countSlot = document.createElement('span');
  countSlot.className = 'rt-count';
  countSlot.style.cssText = 'margin-left:auto;font-weight:400;text-transform:none;letter-spacing:0;color:#9ca3af;font-size:11px';
  header.appendChild(caret);
  header.appendChild(label);
  header.appendChild(tagChip);
  header.appendChild(countSlot);
  wrap.appendChild(header);

  const body = document.createElement('div');
  body.className = 'rt-body';
  body.style.cssText = 'margin-top:6px;display:none';
  wrap.appendChild(body);

  const paint = async () => {
    body.innerHTML = '<div style="font-size:12px;color:#9ca3af;padding:6px 0">loading\u2026</div>';
    const inbox = await loadTasksInboxIfNeeded();
    const matches = tasksMatchingEmail(email, inbox);
    countSlot.textContent = matches.length ? `${matches.length} task${matches.length === 1 ? '' : 's'}` : 'none';
    body.innerHTML = '';
    if (!email.category) {
      body.innerHTML = '<div style="font-size:12px;color:#9ca3af;padding:6px 0">Pick a category above to see related tasks.</div>';
      return;
    }
    if (!matches.length) {
      const empty = document.createElement('div');
      empty.style.cssText = 'font-size:12px;color:#9ca3af;padding:6px 0';
      empty.innerHTML = `No tasks tagged <code>${escapeHtml(tagPath)}</code> yet.`;
      body.appendChild(empty);
    } else {
      for (const t of matches) body.appendChild(renderRelatedTaskCard(t, paint));
    }
    body.appendChild(renderAddTaskButton(email, paint));
  };

  if (isOpen) {
    body.style.display = '';
    paint();
  } else {
    // Render count eagerly so user knows whether expanding is worthwhile.
    loadTasksInboxIfNeeded().then(inbox => {
      const n = tasksMatchingEmail(email, inbox).length;
      countSlot.textContent = n ? `${n} task${n === 1 ? '' : 's'}` : 'none';
    });
  }

  header.addEventListener('click', async () => {
    if (STATE.relatedTasksOpen.has(email.id)) {
      STATE.relatedTasksOpen.delete(email.id);
      body.style.display = 'none';
      caret.textContent = '\u25B8';
    } else {
      STATE.relatedTasksOpen.add(email.id);
      body.style.display = '';
      caret.textContent = '\u25BE';
      await paint();
    }
  });

  return wrap;
}

// One card per matching task: title header + the shared task editor (same
// Description/Planning/Pacing/Action-items UI used on the tasks-inbox page).
// `repaint` is the parent section's paint() so that edits which change the
// category/sub_category can re-filter the list without a page reload.
function renderRelatedTaskCard(task, repaint) {
  const card = document.createElement('div');
  card.style.cssText = 'padding:8px 10px;margin-bottom:8px;background:#fff;border:1px solid #e5e7eb;border-radius:8px';

  const header = document.createElement('div');
  header.style.cssText = 'display:flex;align-items:center;gap:8px;margin-bottom:6px';
  // Title is click-to-edit so a task created from an email with a vague
  // subject can be renamed without leaving the email page (quick-capture).
  const title = document.createElement('div');
  title.style.cssText = 'font-weight:600;color:#111827;flex:1;overflow:hidden;font-size:13px;padding:2px 4px;border-radius:4px;cursor:text;outline:none';
  title.contentEditable = 'true';
  title.spellcheck = true;
  title.textContent = task.title || '(untitled task)';
  title.addEventListener('focus', () => {
    title.style.background = '#eff6ff';
  });
  title.addEventListener('blur', async () => {
    title.style.background = '';
    const v = title.textContent.trim();
    if (!v || v === (task.title || '')) {
      title.textContent = task.title || '(untitled task)';
      return;
    }
    task.title = v;
    task.user_edited = true;
    await saveTasksInbox();
  });
  title.addEventListener('keydown', (ev) => {
    if (ev.key === 'Enter') { ev.preventDefault(); title.blur(); }
    if (ev.key === 'Escape') {
      title.textContent = task.title || '(untitled task)';
      title.blur();
    }
  });
  const status = document.createElement('span');
  status.style.cssText = 'font-size:10px;padding:1px 6px;border-radius:8px;background:#e5e7eb;color:#374151;text-transform:uppercase;letter-spacing:.4px';
  status.textContent = task.status || 'unknown';
  const pin = renderBucketPinButton(task);
  header.appendChild(title);
  header.appendChild(status);
  header.appendChild(pin);
  card.appendChild(header);

  const editor = TASK_EDITOR.render(task, {
    save: saveTasksInbox,
    // Pacing uses hours logged; the email page doesn't load the ledger —
    // the Related tasks section is a quick-capture surface, not a full
    // task manager. See feedback_email_task_intent memory.
    hoursLogged: () => 0,
    onTaskChange: async (t) => {
      // Keep the status chip in sync with any in-place mutations (e.g.
      // planned_for flipping accepted → active).
      status.textContent = t.status || 'unknown';
      if (document.activeElement !== title) {
        title.textContent = t.title || '(untitled task)';
      }
      // If the tag changed, the task may no longer belong here — repaint
      // the section to refresh the filter.
      if (typeof repaint === 'function') await repaint();
    },
  });
  card.appendChild(editor);
  return card;
}

// Pin button — mirrors the 📍/📌 toggle on tasks-inbox. Pinning toggles the
// TASK'S BUCKET (category + sub_category pair), not the task itself — the
// dashboard shows all open tasks in each pinned bucket. Loads the pin set
// lazily so the button doesn't block the first paint.
function renderBucketPinButton(task) {
  const btn = document.createElement('button');
  btn.type = 'button';
  btn.style.cssText = 'background:none;border:none;cursor:pointer;font-size:14px;padding:2px 4px;border-radius:4px;line-height:1;color:#9ca3af';
  btn.textContent = '\ud83d\udccd'; // neutral 📍 until we know the state
  btn.title = 'Pin bucket to dashboard';

  const applyState = (pinned) => {
    const cat = task.category || '';
    const sub = task.sub_category || '';
    const path = `${cat}${sub ? ' / ' + sub : ''}`;
    btn.textContent = pinned ? '\ud83d\udccc' : '\ud83d\udccd';
    btn.style.color = pinned ? '#dc2626' : '#9ca3af';
    btn.title = pinned
      ? `Unpin bucket: ${path}`
      : `Pin bucket to dashboard: ${path}`;
  };

  loadPinnedBucketsIfNeeded().then(set => {
    const key = `${task.category || ''}\u00A7${task.sub_category || ''}`;
    applyState(set.has(key));
  });

  btn.addEventListener('click', async (ev) => {
    ev.stopPropagation();
    btn.disabled = true;
    try {
      const nowPinned = await toggleBucketPin(task);
      applyState(nowPinned);
    } catch (err) {
      alert('Pin failed: ' + err.message);
    } finally {
      btn.disabled = false;
    }
  });

  return btn;
}

// Quick-capture entry point: one click creates a new task skeleton pre-filled
// from the email (subject, category path, email linked as evidence) and
// re-renders the section so the user can immediately plan it.
function renderAddTaskButton(email, repaint) {
  const btn = document.createElement('button');
  btn.type = 'button';
  btn.className = 'btn';
  btn.style.cssText = 'font-size:12px;padding:4px 10px;margin-top:4px;color:#166534;border-color:#bbf7d0;background:#f0fdf4';
  btn.textContent = email.category ? '+ new task for this tag' : '+ new task';
  btn.addEventListener('click', async () => {
    if (!email.category) {
      alert('Pick a category above before creating a task for this email.');
      return;
    }
    btn.disabled = true;
    try {
      await createTaskFromEmail(email);
      if (typeof repaint === 'function') await repaint();
    } catch (err) {
      alert('Failed to create task: ' + err.message);
    } finally {
      btn.disabled = false;
    }
  });
  return btn;
}

async function createTaskFromEmail(email) {
  // New model: write a proposed subtask into data/tasks/buckets.json →
  // proj-inbox / buk-inbox-unfiled. Dedupe by email id (offers to open existing).
  const now = new Date().toISOString();
  const buckets = await api.load('tasks/buckets.json').catch(() => null);
  if (!buckets || !Array.isArray(buckets.projects)) {
    throw new Error('buckets.json missing — run scripts/migrate_inbox_to_buckets.py first');
  }
  // Dedupe: any subtask (anywhere) already carrying this email id?
  const existing = findSubtaskByEmailId(buckets, email.id);
  if (existing) {
    const open = confirm(`A subtask for this email already exists:\n\n"${existing.text}"\n\nOpen the Proposed workspace instead?`);
    if (open) window.location.href = '/rm/pages/tasks.html';
    return existing;
  }

  let inbox = buckets.projects.find(p => p.id === 'proj-inbox');
  if (!inbox) {
    inbox = {
      id: 'proj-inbox', title: 'Proposed', status: 'active', category: '',
      due_date: 'TBD', hours_estimate: 0, tracker_entry_id: null,
      evidence: { email_ids: [], event_ids: [], item_ids: [] }, notes: '',
      created_at: now.slice(0, 10), completed_at: null,
      reserved: true, buckets: [],
    };
    buckets.projects.unshift(inbox);
  }
  let unfiled = (inbox.buckets || []).find(b => b.id === 'buk-inbox-unfiled');
  if (!unfiled) {
    unfiled = {
      id: 'buk-inbox-unfiled', category: '', sub_category: '', title: 'Unfiled / Inbox',
      due_date: 'TBD', hours_estimate: 0, tracker_entry_id: null,
      evidence: { email_ids: [], event_ids: [], item_ids: [] }, notes: '',
      reserved: true, subtasks: [],
    };
    inbox.buckets.push(unfiled);
  }
  const fromStr = (email.from || []).map(a => a.email || a.name).filter(Boolean).join(', ');
  const dateStr = (email.date || '').slice(0, 10);
  const descParts = [];
  if (fromStr) descParts.push(`From: ${fromStr}`);
  if (dateStr) descParts.push(`Date: ${dateStr}`);
  if (email.snippet) descParts.push('', email.snippet);

  const subtask = {
    id: `sub-${now.slice(0, 10)}-${Math.random().toString(36).slice(2, 8)}`,
    text: email.subject || '(untitled)',
    description: descParts.join('\n'),
    done: false, done_at: null,
    due_date: 'TBD', priority: 'normal',
    hours_estimate: 0, tracker_entry_id: null,
    evidence: { email_ids: [email.id], event_ids: [], item_ids: [] },
    notes: '',
    proposed: true,
    proposed_source: 'email',
    proposed_at: now,
    suggestion_meta: {
      category: email.category || '',
      sub_category: email.sub_category || '',
    },
    children: [],
  };
  unfiled.subtasks.push(subtask);
  buckets.updated_at = now;
  await api.save('tasks/buckets.json', buckets);
  return subtask;
}

function findSubtaskByEmailId(buckets, emailId) {
  for (const p of buckets.projects || []) {
    for (const b of p.buckets || []) {
      const found = searchSubtaskTree(b.subtasks || [], emailId);
      if (found) return found;
    }
  }
  return null;
}
function searchSubtaskTree(nodes, emailId) {
  for (const st of nodes) {
    const emails = (st.evidence && st.evidence.email_ids) || [];
    if (emails.includes(emailId)) return st;
    const child = searchSubtaskTree(st.children || [], emailId);
    if (child) return child;
  }
  return null;
}

function renderCategoryEditor(e) {
  const wrap = document.createElement('div');
  wrap.className = 'cat-edit-row';
  wrap.style.cssText = 'display:flex;flex-direction:column;gap:8px;margin-top:6px';
  const label = document.createElement('div');
  label.className = 'label';
  label.style.cssText = 'font-size:11px;color:#6b7280;text-transform:uppercase;letter-spacing:.4px';
  label.textContent = 'Category / sub-category — saves as you pick';
  wrap.appendChild(label);

  const picker = YR_SHARED.renderPicker({
    ctx: { category: e.category, sub_category: e.sub_category || '' },
    tree: STATE.subcatTree || {},
    counts: STATE.subcatCounts || {},
    mode: 'full',
    mruKey: 'email',
    onChange: async (result) => {
      e.category = result.category;
      e.sub_category = result.sub_category;
      e.category_source = 'manual';
      e.activity_type = result.sub_category || result.category || e.activity_type;
      const existing = overrideToObj(STATE.categoryOverrides[e.id]) || {};
      STATE.categoryOverrides[e.id] = {
        ...existing,
        category: result.category,
        sub_category: result.sub_category,
      };
      await saveCategoryOverrides();
      await attachEmailToTask(e);
      await refresh();
    },
  });
  wrap.appendChild(picker);

  const clear = document.createElement('button');
  clear.type = 'button';
  clear.className = 'btn';
  clear.style.cssText = 'align-self:flex-start;font-size:11px;padding:3px 9px';
  clear.textContent = 'Clear override';
  clear.addEventListener('click', async () => {
    delete STATE.categoryOverrides[e.id];
    try {
      const fresh = (await api.load(`email_archive/by_year/${STATE.year}.json`)).emails.find(x => x.id === e.id);
      if (fresh) { e.category = fresh.category; e.sub_category = fresh.sub_category || ''; }
    } catch {}
    e.category_source = 'rules';
    await saveCategoryOverrides();
    const entry = wrap.closest('.email-entry');
    if (entry) {
      const replacement = renderEmailEntry(e);
      entry.parentNode.replaceChild(replacement, entry);
    }
    renderYearReview(STATE.emails);
    renderCatToggles();
    renderTimeline(STATE.emails);
  });
  wrap.appendChild(clear);
  return wrap;
}

function extractEmailFeatures(e) {
  const fromList = (e.from || []).map(a => (a && (a.email || a.name)) || '').filter(Boolean);
  const toList   = (e.to   || []).map(a => (a && (a.email || a.name)) || '').filter(Boolean);
  return {
    sender: fromList[0] || '',
    recipients: toList,
    organizer: '',
    attendees: [],
    subject: e.subject || '',
    location: '',
    body_sample: (e.snippet || '').slice(0, 200),
  };
}

// Skip auto-attach for category values that aren't meaningful as task paths.
const AUTO_ATTACH_BLOCK_CATS = new Set(['noise']);

async function attachEmailToTask(e) {
  if (!e.sub_category || !e.category) return;
  if (AUTO_ATTACH_BLOCK_CATS.has(e.category)) return;
  try {
    const res = await fetch('/api/attach-source', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        source_type: 'email',
        source_id: e.id,
        category: e.category,
        sub_category: e.sub_category,
        features: extractEmailFeatures(e),
      }),
    });
    const j = await res.json();
    if (!j.ok) return;
    e.assigned_task_id = j.task_id;
    e.assigned_task_title = j.task_title;
    // Mirror the assignment into our in-memory overrides so refreshes show it.
    const ov = overrideToObj(STATE.categoryOverrides[e.id]) || {};
    STATE.categoryOverrides[e.id] = { ...ov, assigned_task_id: j.task_id };
  } catch {}
}

function renderTaskAssignBadge(e) {
  if (!e.assigned_task_id) return '';
  const title = e.assigned_task_title || e.assigned_task_id;
  return `<span class="task-chip" style="background:#dcfce7;color:#166534" title="Assigned to task ${e.assigned_task_id}">\u2192 ${escapeHtml(title)}</span>`;
}

async function fetchEmailDetail(e) {
  if (STATE.detailCache[e.id]) return STATE.detailCache[e.id];
  if (!e.path) return null;
  const res = await fetch(`/api/email?path=${encodeURIComponent(e.path)}`);
  if (!res.ok) throw new Error(`status ${res.status}`);
  const j = await res.json();
  STATE.detailCache[e.id] = j;
  return j;
}

function toggleEmailExpand(e, entry) {
  const caret = entry.querySelector('.title span');
  if (STATE.expandedEmails.has(e.id)) {
    STATE.expandedEmails.delete(e.id);
    const expand = entry.querySelector('.ch-detail');
    if (expand) expand.remove();
    if (caret) caret.textContent = '\u25B8';
  } else {
    STATE.expandedEmails.add(e.id);
    entry.appendChild(renderEmailExpand(e));
    if (caret) caret.textContent = '\u25BE';
  }
}

function stripHtml(s) {
  if (!s) return '';
  return s.replace(/<style[^>]*>[\s\S]*?<\/style>/gi, '')
          .replace(/<script[^>]*>[\s\S]*?<\/script>/gi, '')
          .replace(/<[^>]+>/g, ' ').replace(/&nbsp;/g, ' ').replace(/\s+/g, ' ').trim();
}

function fmtBytes(n) {
  if (!n) return '0 B';
  const units = ['B', 'KB', 'MB', 'GB'];
  let i = 0;
  while (n >= 1024 && i < units.length - 1) { n /= 1024; i++; }
  return `${n.toFixed(n < 10 ? 1 : 0)} ${units[i]}`;
}

function escapeHtml(s) {
  return String(s || '').replace(/[&<>"']/g, c => ({
    '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;',
  }[c]));
}

async function refresh() {
  updateEmailTrashButton();
  if (STATE.showTrash) {
    // Hide the normal panels when viewing trash. Also bail out of selection
    // mode so the checkbox column doesn't leak into trash rendering.
    if (STATE.selectionMode) setSelectionMode(false);
    setDisplay('year-review', 'none');
    setDisplay('cat-toggles', 'none');
    setDisplay('email-analytics', 'none');
    setDisplay('email-events-toolbar', 'none');
    setDisplay('em-bulk-bar', 'none');
    document.getElementById('result-count').textContent = `${STATE.trash.length} in trash`;
    renderEmailTrash();
    return;
  }
  setDisplay('year-review', '');
  setDisplay('cat-toggles', 'flex');
  setDisplay('email-analytics', 'grid');
  setDisplay('email-events-toolbar', 'flex');
  setDisplay('em-bulk-bar', '');
  updateBulkBar();
  const titleEl = document.getElementById('timeline-title');
  if (titleEl) {
    titleEl.textContent = STATE.year === 'all'
      ? 'Yearly email volume by category \u2014 All years'
      : `Monthly email volume by category \u2014 ${STATE.year}`;
  }
  renderYearReview(STATE.emails);
  renderCatToggles();
  const filtered = filterEmails();
  renderTimeline(STATE.emails);          // reads STATE.filter.cats internally
  renderActivityRollup(filtered);
  document.getElementById('result-count').textContent = `${filtered.length} of ${STATE.emails.length} emails`;
  renderEmails(filtered);
  // Coming back from the trash view, the canvas was display:none — nudge the
  // chart to recompute size now that it's visible again.
  if (STATE.timelineChart) { try { STATE.timelineChart.resize(); } catch {} }
}

function setDisplay(id, v) { const el = document.getElementById(id); if (el) el.style.display = v; }

function updateEmailTrashButton() {
  const btn = document.getElementById('email-trash-btn');
  if (!btn) return;
  const n = STATE.trash.length;
  btn.textContent = STATE.showTrash
    ? 'Back to inbox'
    : (n ? `Trash (${n})` : 'Trash');
  btn.classList.toggle('btn-primary', STATE.showTrash);
}

function renderEmailTrash() {
  const host = document.getElementById('content');
  host.innerHTML = '';
  const items = STATE.trash.slice().sort((a, b) => (b.deleted_at || '').localeCompare(a.deleted_at || ''));
  if (!items.length) {
    host.innerHTML = '<div class="card" style="padding:16px;color:#6b7280">Trash is empty.</div>';
    return;
  }
  const header = document.createElement('div');
  header.style.cssText = 'display:flex;justify-content:space-between;align-items:center;margin-bottom:10px;font-size:13px;color:#6b7280';
  header.innerHTML = `<span>${items.length} item${items.length === 1 ? '' : 's'} in trash — recoverable until emptied.</span>`;
  const emptyBtn = document.createElement('button');
  emptyBtn.className = 'btn btn-danger btn-sm';
  emptyBtn.textContent = 'Empty Trash';
  emptyBtn.addEventListener('click', async () => {
    if (!confirm(`Permanently delete ${items.length} item${items.length === 1 ? '' : 's'}? This cannot be undone.`)) return;
    await emptyEmailTrash();
    await refresh();
  });
  header.appendChild(emptyBtn);
  host.appendChild(header);

  const wrap = document.createElement('div');
  wrap.className = 'card';
  for (const t of items) {
    const e = t.email || { id: t.id };
    const row = document.createElement('div');
    row.className = 'email-row';
    const when = t.deleted_at ? new Date(t.deleted_at).toLocaleString('en-US', { month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit' }) : '';
    const fromStr = (e.from || []).map(a => a.name || a.email).join(', ');
    row.innerHTML = `
      <div class="date">${escapeHtml((e.date || '').slice(0, 10))}</div>
      <div><span class="cat-tag-host">${categoryTag(e.category || 'unknown')}</span></div>
      <div>
        <div class="subj">${escapeHtml(e.subject || '(no subject)')}</div>
        <div class="snip">deleted ${escapeHtml(when)}${fromStr ? ' · ' + escapeHtml(fromStr) : ''}</div>
      </div>
      <div></div>
      <div></div>
      <div class="email-actions"></div>
    `;
    const restore = document.createElement('button');
    restore.className = 'btn btn-sm';
    restore.type = 'button';
    restore.textContent = 'Restore';
    restore.addEventListener('click', async (ev) => {
      ev.stopPropagation();
      await restoreEmail(t.id);
      await refresh();
    });
    row.querySelector('.email-actions').appendChild(restore);
    wrap.appendChild(row);
  }
  host.appendChild(wrap);
}

// Live-sync state for the 4 per-user email-archive paths. Keep at module scope
// so attachLiveSync's gate checks (suppressUntil + savePending) survive across
// boot-time mutations.
const _emailLive = {
  suppressUntil: 0,
  savePending: false,
  unsubs: [],
  refreshTimer: null,
};

/* Debounced scroll-preserving re-render. Multiple snapshots arriving in quick
 * succession coalesce into a single refresh, and the user's scroll position
 * + active selection survive the rebuild — so a remote update no longer looks
 * like a full page reload. */
function _emailScheduleRefresh() {
  if (_emailLive.refreshTimer) return;
  _emailLive.refreshTimer = setTimeout(async () => {
    _emailLive.refreshTimer = null;
    const scrollY = window.scrollY;
    const active = document.activeElement;
    const activeId = active && active.id;
    const activeSel = (active && (active.tagName === 'INPUT' || active.tagName === 'TEXTAREA'))
      ? { start: active.selectionStart, end: active.selectionEnd }
      : null;
    try {
      await refresh();
    } catch (err) {
      console.warn('[email-review live-sync refresh failed]', err);
    } finally {
      // Restore viewport position; restore focus if the focused element is
      // still in the DOM (e.g. the year selector).
      window.scrollTo({ top: scrollY, left: 0, behavior: 'instant' });
      if (activeId) {
        const el = document.getElementById(activeId);
        if (el) {
          try { el.focus(); } catch (e) {}
          if (activeSel && el.setSelectionRange) {
            try { el.setSelectionRange(activeSel.start, activeSel.end); } catch (e) {}
          }
        }
      }
    }
  }, 150);
}

/* Wrap the 4 mutating api.save calls so we can mark _savePending while the
 * save is in flight — without this, an inbound snapshot during a 400ms-debounced
 * action would clobber STATE.* before the save persists. The pattern matches
 * the bucket files' _savePending gate. Called once after boot completes. */
function _emailWrapSaves() {
  if (_emailWrapSaves._wrapped) return;
  _emailWrapSaves._wrapped = true;
  const origSave = api.save.bind(api);
  api.save = async function (path, data) {
    const isEmailUserPath = (
      path === 'email_archive/ratings.json' ||
      path === 'email_archive/dispositions.json' ||
      path === 'email_archive/category_overrides.json' ||
      path === 'email_archive/trash.json'
    );
    if (isEmailUserPath) {
      _emailLive.savePending = true;
      _emailLive.suppressUntil = Date.now() + 2500;
    }
    try {
      return await origSave(path, data);
    } finally {
      if (isEmailUserPath) _emailLive.savePending = false;
    }
  };
}

/* Subscribe to each per-user email-archive doc. On a remote update (i.e. the
 * other tab made a change), update the relevant STATE field and call refresh()
 * to redraw rows + counts + analytics. Skips its own write echo via the
 * suppressUntil + savePending gates. */
function _emailAttachLiveSync() {
  if (typeof api.subscribe !== 'function') return;
  if (_emailLive.unsubs.length) return;
  const targets = [
    {
      path: 'email_archive/ratings.json',
      apply: (data) => {
        // Mirror loadRatings() defaulting — without these, an empty Firestore
        // doc leaves STATE.ratings.by_email undefined and effectiveRating()
        // throws "Cannot use 'in' operator to search ... in undefined".
        const r = data || {};
        if (!r.by_email)    r.by_email    = {};
        if (!r.by_activity) r.by_activity = {};
        if (!r.by_sender)   r.by_sender   = {};
        STATE.ratings = r;
      },
    },
    {
      path: 'email_archive/dispositions.json',
      apply: (data) => { STATE.dispositions = (data && data.dispositions) || {}; },
    },
    {
      path: 'email_archive/category_overrides.json',
      apply: (data) => {
        STATE.categoryOverrides = (data && data.overrides) || {};
        // Re-apply overrides to the in-memory email list so the row badges refresh.
        for (const e of STATE.emails || []) {
          applyOverrideToEmail(e, overrideToObj(STATE.categoryOverrides[e.id]));
        }
      },
    },
    {
      path: 'email_archive/trash.json',
      apply: (data) => {
        STATE.trash = (data && data.trash) || [];
      },
    },
  ];
  for (const t of targets) {
    try {
      // Skip the first fire — Firestore subscribes always emit the current
      // server state immediately, but boot-time api.load already populated
      // STATE.* with the same data. Re-rendering for it is a wasted DOM
      // rebuild on every page load.
      let firstFireConsumed = false;
      const unsub = api.subscribe(t.path, function (data) {
        if (Date.now() < _emailLive.suppressUntil) return;
        if (_emailLive.savePending) return;
        if (!data) return;
        try { t.apply(data); }
        catch (err) { console.warn('[email-review live-sync apply failed]', t.path, err); return; }
        if (!firstFireConsumed) {
          firstFireConsumed = true;
          return;
        }
        // Debounced + scroll-preserving re-render. Coalesces bursts of remote
        // updates into a single refresh and keeps the viewport stable.
        _emailScheduleRefresh();
      });
      _emailLive.unsubs.push(unsub);
    } catch (err) {
      console.warn('[email-review] live sync attach failed for', t.path, err.message);
    }
  }
}

async function boot() {
  _emailWrapSaves();
  await loadSummary();
  await loadRatings();
  await loadPredictions();
  await loadDispositions();
  await loadEmailTrash();
  // Category overrides first so they apply when we load year data
  try {
    STATE.categoryOverrides = (await api.load('email_archive/category_overrides.json')).overrides || {};
  } catch { STATE.categoryOverrides = {}; }
  await loadSubCategoryTree();
  populateYearSelect();
  const years = (STATE.summary.years || []).slice().sort().reverse();
  const initialYear = years[0];
  document.getElementById('year-filter').value = initialYear;
  await loadYear(initialYear);
  const trashBtn = document.getElementById('email-trash-btn');
  if (trashBtn) {
    trashBtn.addEventListener('click', () => {
      STATE.showTrash = !STATE.showTrash;
      refresh();
    });
  }
  await refresh();
  // Live-sync intentionally OFF on email-review (Phase 12). The page is
  // view-mostly; tab-to-tab edits aren't worth the 4 onSnapshot streams +
  // their initial-state network cost on every page boot. Saves ~20-30 KB +
  // 4 stream-establish round-trips. Live-sync stays on tasks pages where
  // active-editing flow needs it.
  // _emailAttachLiveSync();

  document.getElementById('year-filter').addEventListener('change', async (ev) => {
    await loadYear(ev.target.value);
    await refresh();
  });
  function debounce(fn, ms) {
    let t;
    return (...args) => { clearTimeout(t); t = setTimeout(() => fn(...args), ms); };
  }
  const applySearchFilter = () => {
    if (STATE.showTrash) return;
    const filtered = filterEmails();
    renderActivityRollup(filtered);
    document.getElementById('result-count').textContent = `${filtered.length} of ${STATE.emails.length} emails`;
    renderEmails(filtered);
  };
  const debouncedSearch = debounce(applySearchFilter, 120);
  document.getElementById('search-box').addEventListener('input', (ev) => {
    STATE.filter.search = ev.target.value;
    debouncedSearch();
  });
  document.getElementById('only-tasks').addEventListener('change', (ev) => {
    STATE.filter.onlyTasks = ev.target.checked;
    if (STATE.showTrash) return;
    const filtered = filterEmails();
    renderActivityRollup(filtered);
    document.getElementById('result-count').textContent = `${filtered.length} of ${STATE.emails.length} emails`;
    renderEmails(filtered);
  });
  document.getElementById('sort-by').addEventListener('change', (ev) => {
    STATE.sort = ev.target.value;
    if (STATE.showTrash) return;
    renderEmails(filterEmails());
  });

  // Multi-select mode + bulk action bar.
  document.getElementById('select-mode-btn').addEventListener('click', () => {
    setSelectionMode(!STATE.selectionMode);
    if (!STATE.showTrash) renderEmails(filterEmails());
  });
  document.getElementById('em-bulk-select-all').addEventListener('click', selectAllVisible);
  document.getElementById('em-bulk-clear').addEventListener('click', clearSelection);
  document.getElementById('em-bulk-delete').addEventListener('click', bulkDelete);
  document.getElementById('em-bulk-category').addEventListener('click', bulkReassignCategory);
  document.querySelectorAll('#em-bulk-bar [data-disp]').forEach(btn => {
    btn.addEventListener('click', () => bulkSetDisposition(btn.dataset.disp));
  });
}

document.addEventListener('DOMContentLoaded', async function () {
  // Phase 9: email-review now reads per-user emailMessages (Phase 7 Gmail
  // OAuth + items.json archive backfill), so it works for any signed-in
  // lab member with their own data — no admin gate, no deploy redirect.
  if (typeof firebridge !== 'undefined' && firebridge.whenAuthResolved) {
    try { await firebridge.whenAuthResolved(); } catch (_) {}
  }
  if (typeof firebridge !== 'undefined' && firebridge.gateSignedIn) {
    var gate = await firebridge.gateSignedIn(
      'Sign in to triage your inbox. Connect Gmail in Settings to populate this view.'
    );
    if (!gate.allowed) return;
  }
  boot();
});
