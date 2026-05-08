/* nav.js — renders shared top navigation with dropdown groups.
 *
 * Per-item access gating: each nav item may carry a `gate` field:
 *   - 'admin'      → only visible when firebridge.isAdmin() is true
 *   - 'lab-member' → only visible when firebridge.isLabMember() is true
 *                    (any non-guest signed-in user)
 *   - undefined    → always visible
 *
 * Items without a gate render for everyone, including signed-out users.
 * Guests are covered by the global pending-access overlay (in firebase-bridge.js)
 * so nav-level hiding for them is secondary; the gate machinery exists mainly
 * to keep grad students / undergrads from seeing PI-only links like Email
 * Triage and the lab-shared Calendar.
 *
 * Gating is applied AFTER initial render — nav appears immediately so the
 * page never flashes empty. firebridge.onAuth then hides gated entries; if
 * every child of a group ends up hidden, the group itself is hidden.
 */

/* Six-group layout introduced in V3.40 to absorb the migrated lab apps and
 * public-site admin into RM. Operations links route through Phase-A iframe
 * bridges (rm/pages/app-<name>.html) until each app is ported to a native
 * RM page in Phase B (V3.41+); the iframe wrapper is replaced with a
 * <meta refresh> redirect at port time so bookmarks survive. */
const NAV_ITEMS = [
  { label: 'Dashboard', href: '/rm/index.html' },

  { label: 'Activity', href: '/rm/pages/activity-overview.html', children: [
    { label: 'Overview', href: '/rm/pages/activity-overview.html' },
    { label: 'Tracker',  href: '/rm/pages/activity-overview.html?tab=tracker' },
    { label: 'Email',    href: '/rm/pages/activity-overview.html?tab=email' },
    { label: 'Year',     href: '/rm/pages/activity-overview.html?tab=timeline' },
    { label: 'PMR',      href: '/rm/pages/pmr.html' },
    { label: 'Calendar', href: '/rm/pages/calendar.html' },
    { label: 'Tasks',    href: '/rm/pages/tasks.html' },
    { label: 'Sharing',  href: '/rm/pages/sharing.html' },
    { label: 'Explorer', href: '/rm/pages/explorer.html' },
  ]},

  { label: 'Research', href: '/rm/pages/projects.html', children: [
    { label: 'Projects', href: '/rm/pages/projects.html' },
    { label: 'Library',  href: '/rm/pages/library.html' },
    { label: 'Comments', href: '/rm/pages/library.html?tab=comments' },
    { label: 'Papers',   href: '/rm/pages/paper-builder.html' },
    { label: 'Teaching', href: '/rm/pages/teaching.html' },
    { label: 'Service',  href: '/rm/pages/service.html' },
  ]},

  { label: 'Operations', gate: 'lab-member', children: [
    { label: 'Chat',      href: '/rm/pages/chat.html' },
    { label: 'Huddle',    href: '/rm/pages/huddle.html' },
    { label: 'Meetings',  href: '/rm/pages/meetings.html' },
    { label: 'Scheduler', href: '/rm/pages/scheduler.html' },
    { label: 'Equipment', href: '/rm/pages/equipment.html' },
  ]},

  { label: 'Lab Admin', gate: 'lab-member', children: [
    { label: 'Compliance',        href: '/rm/pages/compliance.html' },
    { label: 'Chemical Safety',   href: '/rm/pages/chemicals.html' },
    { label: 'Inventory',         href: '/rm/pages/inventory.html' },
    { label: 'Lab Members',       href: '/rm/pages/people.html' },
    { label: 'Important People',  href: '/rm/pages/people.html?tab=important' },
    { label: 'Career & Tenure',   href: '/rm/pages/career.html' },
    { label: 'Procurement',       href: '/rm/pages/procurement.html' },
    { label: 'Receipts & Budget', href: '/rm/pages/receipts.html' },
    { label: 'Grant Accounts',    href: '/rm/pages/projects-grants.html' },
    { label: 'Budget',            href: '/rm/pages/budget.html' },
    { label: 'Analytics',         href: '/rm/pages/analytics.html' },
    { label: 'Travel',            href: '/rm/pages/finance.html' },
  ]},

  { label: 'Settings', gate: 'lab-member', children: [
    { label: 'Profile',         href: '/rm/pages/profile.html' },
    { label: 'Settings',        href: '/rm/pages/settings.html' },
    { label: 'CV Editor',       href: '/rm/pages/cv-editor.html' },
    { label: 'CV Overview',     href: '/rm/pages/cv-editor.html?tab=lab' },
    { label: 'Member Activity', href: '/rm/pages/activity-overview.html?tab=lab-stats', gate: 'admin' },
    { label: 'API Usage',       href: '/rm/pages/api-usage.html', gate: 'admin' },
    { label: 'Permissions',     href: '/rm/pages/admin-permissions.html', gate: 'admin' },
  ]},

  // V3.56 — Split View opens a side-by-side shell with two RM pages
  // in iframes. Adapted from the lab-apps.js _splitAppId/_splitRatio
  // harness that the user explicitly flagged as a wanted feature.
  // Top-level entry (no children) so it sits visually distinct from
  // the regular section dropdowns.
  { label: '⊟ Split', href: '/rm/pages/split-view.html' },
];

/* ── V3.64 — Workflow strip ──
 *
 * When a workflow is active in sessionStorage, nav.js renders a focused
 * strip (workflow icon + name + page chips + Leave button) instead of
 * the six-group NAV_ITEMS dropdown bar. The strip's read logic is kept
 * inline here so every page that loads nav.js gets the strip without
 * needing to load page-registry.js / workflow-state.js.
 *
 * Mutations (setActive, addPage, removePage, save-as-custom) are NOT in
 * scope here — those happen on the chooser page (rm/index.html, V3.64)
 * and the custom-workflow builder (V3.65), both of which load the full
 * helpers. */

const _WF_STORAGE_KEY = 'mcgheelab.activeWorkflow';
let _wfDefaultsCache = null;

/* V3.68 — Inlined default-workflow seeds so the strip works on every
 * RM page without needing page-registry.js. Mirrors
 * PAGE_REGISTRY.DEFAULT_WORKFLOWS in rm/js/page-registry.js — keep
 * them in sync. The strip falls back to these whenever the Firestore
 * `labConfig/defaultWorkflows` doc is missing or doesn't contain the
 * requested workflow id. Without this fallback, users entering a
 * default workflow before admin seeds Firestore (or before deploy)
 * see "Workflow not found" on the strip. */
const _WF_DEFAULT_SEEDS = [
  {
    id: 'lab-research', label: 'Lab Research', icon: '🔬',
    description: 'Daily research workflow — track activity, browse the library, manage projects, and capture tasks.',
    landingPageId: 'activity-overview__tab__tracker',
    pageIds: ['activity-overview__tab__tracker', 'library', 'projects', 'tasks', 'lab-notebook', 'protocols'],
  },
  {
    id: 'paper-writing', label: 'Paper Writing', icon: '📝',
    description: 'Compose papers with the editor, pull annotations from the library, track tasks and PMRs, coordinate via chat.',
    landingPageId: 'paper-builder',
    pageIds: ['paper-builder', 'library', 'library__tab__comments', 'tasks', 'pmr', 'chat', 'lab-notebook'],
  },
  {
    id: 'certification-training', label: 'Certification & Training', icon: '🎓',
    description: 'Compliance protocols, chemical safety, training records, and tenure-track milestones.',
    landingPageId: 'compliance',
    pageIds: ['compliance', 'chemicals', 'career', 'tasks'],
  },
  {
    id: 'task-scheduling', label: 'Task Scheduling & Activity Reports', icon: '📊',
    description: 'Plan tasks, track activity (tracker / year / email), schedule meetings, share assignments, file PMRs.',
    landingPageId: 'tasks',
    pageIds: ['tasks', 'activity-overview', 'activity-overview__tab__tracker', 'activity-overview__tab__timeline', 'activity-overview__tab__email', 'scheduler', 'sharing', 'pmr'],
  },
  {
    id: 'meetings', label: 'Meetings', icon: '🗣️',
    description: 'Run lab meetings, huddles, and 1:1s with chat, calendar, and task capture wired up.',
    landingPageId: 'meetings',
    pageIds: ['meetings', 'huddle', 'chat', 'tasks', 'calendar'],
  },
];

function _wfReadState() {
  try {
    const raw = sessionStorage.getItem(_WF_STORAGE_KEY);
    if (!raw) return null;
    const s = JSON.parse(raw);
    if (!s || !s.id) return null;
    s.kind = s.kind || 'default';
    s.addedPageIds = Array.isArray(s.addedPageIds) ? s.addedPageIds : [];
    s.removedPageIds = Array.isArray(s.removedPageIds) ? s.removedPageIds : [];
    // V3.66 — orderOverride is null until the user drag-reorders.
    s.orderOverride = Array.isArray(s.orderOverride) ? s.orderOverride : null;
    // V3.73 — pageState[pageId] = full URL (path+search+hash) the user
    // was last on for that page within this workflow session. Lets chips
    // reopen the user's previous context (e.g. ?paper=mebp on the paper
    // editor) instead of always landing on the canonical chip URL.
    s.pageState = (s.pageState && typeof s.pageState === 'object') ? s.pageState : {};
    return s;
  } catch (e) { return null; }
}

function _wfClearState() { sessionStorage.removeItem(_WF_STORAGE_KEY); }

/* Adopt `?workflow=<id>` from the URL into sessionStorage. Strip the
 * param from the URL via history.replaceState so the address bar stays
 * clean while the workflow context persists across navigations. */
function _wfAdoptFromUrl() {
  const qp = new URLSearchParams(location.search);
  const wfId = qp.get('workflow');
  if (!wfId) return _wfReadState();
  const existing = _wfReadState();
  let state;
  if (existing && existing.id === wfId) {
    state = existing;  // preserve dirty edits across navigations
  } else {
    state = { id: wfId, kind: 'default', addedPageIds: [], removedPageIds: [], orderOverride: null, pageState: {} };
  }
  sessionStorage.setItem(_WF_STORAGE_KEY, JSON.stringify(state));
  qp.delete('workflow');
  const qs = qp.toString();
  const newUrl = location.pathname + (qs ? '?' + qs : '') + location.hash;
  try { history.replaceState(history.state, '', newUrl); } catch (e) { /* ignore */ }
  return state;
}

/* Build a flat map of every workflow-pickable page from NAV_ITEMS.
 * Page id is derived from URL+?tab= (matching page-registry.js's logic
 * exactly so ids agree across the codebase). */
function _wfPageIdFromHref(href) {
  if (!href) return '';
  if (href === '/rm/index.html' || href === '/rm/' || href === '/') return 'dashboard';
  const m = href.match(/^\/rm\/pages\/([a-z0-9-]+)\.html(\?(.*))?$/);
  if (!m) return href;
  const slug = m[1];
  const query = m[3] || '';
  if (!query) return slug;
  const qp = new URLSearchParams(query);
  const tab = qp.get('tab');
  if (tab) return slug + '__tab__' + tab;
  return slug + '__q__' + query.replace(/[^a-z0-9_-]/gi, '-');
}

function _wfBuildPageMap() {
  const m = new Map();
  NAV_ITEMS.forEach(item => {
    const groupLabel = item.label;
    if (item.children && item.children.length) {
      if (item.href) {
        const id = _wfPageIdFromHref(item.href);
        if (!m.has(id)) m.set(id, { id, label: item.label, href: item.href, group: groupLabel });
      }
      item.children.forEach(child => {
        const id = _wfPageIdFromHref(child.href);
        if (!m.has(id)) m.set(id, { id, label: child.label, href: child.href, group: groupLabel });
      });
    } else if (item.href) {
      const id = _wfPageIdFromHref(item.href);
      if (!m.has(id)) m.set(id, { id, label: item.label, href: item.href, group: groupLabel });
    }
  });
  return m;
}

/* Fetch the active workflow's record (label + ordered pageIds). Tries
 * Firestore (labConfig/defaultWorkflows or userData/{uid}/customWorkflows
 * for the custom kind); falls back to undefined if not reachable. */
async function _wfFetchWorkflow(state) {
  if (state.kind === 'default') {
    // Try Firestore first; fall back to the inlined seed for any id the
    // Firestore doc doesn't cover (or when the doc is missing entirely,
    // e.g. before admin seeds it via the matrix). This makes default
    // workflows usable out-of-the-box even on a fresh deploy.
    if (!_wfDefaultsCache) {
      let firestoreList = [];
      if (typeof firebridge !== 'undefined' && firebridge.db) {
        try {
          const snap = await firebridge.db().collection('labConfig').doc('defaultWorkflows').get();
          if (snap.exists) {
            const data = snap.data() || {};
            firestoreList = Array.isArray(data.workflows) ? data.workflows : [];
          }
        } catch (e) { /* ignore — fall back to seeds */ }
      }
      // Merge: Firestore wins on id conflicts; missing ids fall back to seed.
      const byId = new Map();
      _WF_DEFAULT_SEEDS.forEach(w => byId.set(w.id, w));
      firestoreList.forEach(w => { if (w && w.id) byId.set(w.id, w); });
      _wfDefaultsCache = Array.from(byId.values());
    }
    return _wfDefaultsCache.find(w => w.id === state.id) || null;
  }
  if (typeof firebridge === 'undefined' || !firebridge.db) return null;
  if (state.kind === 'custom') {
    const u = firebridge.getUser && firebridge.getUser();
    if (!u) return null;
    try {
      const doc = await firebridge.db()
        .collection('userData').doc(u.uid)
        .collection('customWorkflows').doc(state.id).get();
      if (doc.exists) return Object.assign({ id: doc.id }, doc.data() || {});
    } catch (e) { /* ignore */ }
    return null;
  }
  return null;
}

function _wfEffectivePageIds(basePageIds, state) {
  const removed = new Set(state.removedPageIds || []);
  const seen = new Set();
  const out = [];

  // V3.66 — orderOverride lets the user drag-to-reorder. When present,
  // it dictates the visible order. New ids (added or in basePageIds but
  // not yet in the override) get appended at the end so reorder doesn't
  // hide subsequent additions.
  const order = Array.isArray(state.orderOverride) ? state.orderOverride : null;
  const sourceIds = (basePageIds || []).concat(state.addedPageIds || []);

  if (order) {
    // First pass: emit ids from the override that still exist in source.
    const sourceSet = new Set(sourceIds);
    order.forEach(id => {
      if (removed.has(id)) return;
      if (seen.has(id)) return;
      if (!sourceSet.has(id)) return;  // page no longer in source — drop
      seen.add(id);
      out.push(id);
    });
  }
  // Append anything not already in the override (or, if no override,
  // everything in source order).
  sourceIds.forEach(id => {
    if (removed.has(id)) return;
    if (seen.has(id)) return;
    seen.add(id);
    out.push(id);
  });
  return out;
}

function _wfDecorateHref(href, wfId) {
  if (!href || !wfId) return href;
  const idx = href.indexOf('#');
  const hash = idx >= 0 ? href.slice(idx) : '';
  const path = idx >= 0 ? href.slice(0, idx) : href;
  const qIdx = path.indexOf('?');
  const qs = qIdx >= 0 ? path.slice(qIdx + 1) : '';
  const basePath = qIdx >= 0 ? path.slice(0, qIdx) : path;
  const qp = new URLSearchParams(qs);
  qp.set('workflow', wfId);
  return basePath + '?' + qp.toString() + hash;
}

async function renderWorkflowStrip(state) {
  // Inject workflow.css if the page didn't already include it. Idempotent —
  // browser deduplicates by href.
  if (!document.querySelector('link[href="/rm/css/workflow.css"]')) {
    const link = document.createElement('link');
    link.rel = 'stylesheet';
    link.href = '/rm/css/workflow.css';
    document.head.appendChild(link);
  }

  const strip = document.createElement('nav');
  strip.className = 'workflow-strip';

  // Brand link → chooser
  const brand = document.createElement('a');
  brand.className = 'ws-brand';
  brand.href = '/rm/index.html';
  brand.title = 'Switch workflow';
  brand.innerHTML = '<span class="ws-icon">🗂</span><span class="ws-brand-label">Loading…</span>';
  strip.appendChild(brand);

  const pagesEl = document.createElement('div');
  pagesEl.className = 'ws-pages';
  strip.appendChild(pagesEl);

  const actionsEl = document.createElement('div');
  actionsEl.className = 'ws-actions';
  strip.appendChild(actionsEl);

  // V3.75 — detect split-view mode. When on /rm/pages/split-view.html,
  // the strip pills become the swap UI: pills matching the open panes
  // get .ws-page-open + side badge; the active pane gets a red border
  // (.ws-page-active-split). Pill clicks dispatch events to split-view.js
  // instead of navigating the parent. The "⊟ Split" button is replaced
  // with "× Close split" in this mode.
  const onSplit = location.pathname === '/rm/pages/split-view.html';
  let splitState = null;
  if (onSplit) {
    const sp = new URLSearchParams(location.search);
    splitState = {
      left: sp.get('left') || '/rm/index.html',
      right: sp.get('right') || '/rm/index.html',
      active: sp.get('active') === 'right' ? 'right' : 'left',
    };
  }

  // V3.78 — detect workflow-shell mode. When on workflow-shell.html, chip
  // clicks dispatch rm:shell:set-active events instead of navigating
  // (the shell swaps which iframe is visible, no full-page reload).
  const onShell = location.pathname === '/rm/pages/workflow-shell.html';
  let shellActiveId = null;
  if (onShell) {
    shellActiveId = new URLSearchParams(location.search).get('active') || '';
  }

  // Split + Leave buttons render immediately; page chips wait for fetch.
  let splitLink = null;
  if (!onSplit) {
    splitLink = document.createElement('a');
    splitLink.className = 'ws-btn';
    splitLink.href = _wfDecorateHref('/rm/pages/split-view.html', state.id);
    splitLink.textContent = '⊟ Split';
    splitLink.title = 'Open the split-view shell with the workflow context preserved';
    actionsEl.appendChild(splitLink);
  } else {
    const closeSplitBtn = document.createElement('button');
    closeSplitBtn.className = 'ws-btn';
    closeSplitBtn.type = 'button';
    closeSplitBtn.textContent = '× Close split';
    closeSplitBtn.title = 'Exit split view; the active pane becomes the full page';
    closeSplitBtn.addEventListener('click', () => {
      window.dispatchEvent(new CustomEvent('rm:split:close', { detail: { keep: 'active' } }));
    });
    actionsEl.appendChild(closeSplitBtn);
    splitLink = closeSplitBtn;     // sentinel for insertBefore() below
  }

  const leaveBtn = document.createElement('button');
  leaveBtn.className = 'ws-btn';
  leaveBtn.type = 'button';
  leaveBtn.textContent = '× Leave workflow';
  leaveBtn.addEventListener('click', () => {
    _wfClearState();
    location.reload();
  });
  actionsEl.appendChild(leaveBtn);

  document.body.prepend(strip);

  // Wait for auth + access-grant to resolve so canAccessPage filters
  // correctly. firebridge may still be initializing on first paint;
  // both helpers are safe to call before sign-in (they no-op).
  if (typeof firebridge !== 'undefined') {
    if (firebridge.whenAuthResolved) {
      try { await firebridge.whenAuthResolved(); } catch (e) { /* ignore */ }
    }
    if (firebridge.loadAccessGrant) {
      try { await firebridge.loadAccessGrant(); } catch (e) { /* ignore */ }
    }
  }

  // Fetch the workflow record async; populate label + chips.
  const wf = await _wfFetchWorkflow(state);
  if (!wf) {
    brand.querySelector('.ws-brand-label').textContent = 'Workflow not found';
    pagesEl.innerHTML = '<span class="ws-page" style="opacity:.5">No pages</span>';
    return;
  }
  brand.innerHTML = '<span class="ws-icon">' + (wf.icon || '🗂') + '</span>'
                  + '<span class="ws-brand-label">' + (wf.label || wf.id) + '</span>';

  const pageMap = _wfBuildPageMap();
  const ids = _wfEffectivePageIds(wf.pageIds || [], state);
  const isAdmin = (typeof firebridge !== 'undefined') && firebridge.isAdmin && firebridge.isAdmin();
  const canAccess = (id) => {
    if (isAdmin) return true;
    if (typeof firebridge !== 'undefined' && firebridge.canAccessPage) {
      return firebridge.canAccessPage(id);
    }
    return true;
  };
  const currentPath = location.pathname;
  const currentSearch = location.search;
  const currentTab = new URLSearchParams(currentSearch).get('tab') || '';
  // V3.73 — find which chip pageId corresponds to the current page so we
  // can persist the full URL (path+search+hash) for reopening later. Most
  // specific match wins: same pathname + same ?tab beats same pathname
  // alone (so /library.html?tab=comments persists onto the Comments chip,
  // not the Library Papers chip).
  let activeChipId = null;
  let activeChipGenericFallback = null;
  ids.forEach(id => {
    const p = pageMap.get(id);
    if (!p) return;
    const u = new URL(p.href, location.origin);
    if (u.pathname !== currentPath) return;
    const pTab = new URLSearchParams(u.search).get('tab') || '';
    if (pTab === currentTab) activeChipId = id;
    else if (!pTab && !activeChipGenericFallback) activeChipGenericFallback = id;
  });
  if (!activeChipId) activeChipId = activeChipGenericFallback;
  if (activeChipId) {
    state.pageState = state.pageState || {};
    state.pageState[activeChipId] = location.pathname + location.search + location.hash;
    _wfWriteState(state);
  }

  // V3.73 — pre-fill the strip's "⊟ Split" link with workflow context so
  // splitting opens TWO workflow pages side-by-side (left = current, right
  // = next workflow page). Both panes inherit the workflow context via
  // ?workflow=<id> + ?embed=1 (suppresses nested nav inside iframes).
  const accessibleIds = ids.filter(id => {
    const pp = pageMap.get(id);
    return pp && canAccess(id);
  });
  if (accessibleIds.length) {
    // Left pane = current page (with any state — paper id, tab, etc.).
    // V3.88 — when the user is in the workflow shell, location is
    // /rm/pages/workflow-shell.html (a container). Splitting from
    // there must use the ACTIVE workflow page's URL as the left pane,
    // not the shell URL — otherwise each split iframe loads the shell
    // again, which renders its own popouts + nested iframe inside the
    // pane (the user's "split pages have their own workflow nav"
    // report). Pull the active page's remembered URL or canonical
    // href from pageMap.
    let leftURL;
    if (location.pathname === '/rm/pages/workflow-shell.html') {
      const activeFromUrl = new URLSearchParams(location.search).get('active') || activeChipId;
      const activeP = activeFromUrl && pageMap.get(activeFromUrl);
      const remembered = state.pageState && state.pageState[activeFromUrl];
      leftURL = remembered || (activeP && activeP.href) || '/rm/index.html';
    } else {
      leftURL = location.pathname + location.search + location.hash;
    }
    // Right pane = next workflow page after current; wrap to first if at end.
    let rightId = null;
    if (activeChipId) {
      const idx = accessibleIds.indexOf(activeChipId);
      if (idx >= 0) rightId = accessibleIds[(idx + 1) % accessibleIds.length];
    }
    if (!rightId) rightId = accessibleIds[0];
    if (rightId === activeChipId && accessibleIds.length > 1) {
      rightId = accessibleIds[1];
    }
    const rightP = pageMap.get(rightId);
    const rightRemembered = state.pageState && state.pageState[rightId];
    const rightURL = rightRemembered || (rightP && rightP.href) || '/rm/index.html';
    const splitParams = new URLSearchParams({
      workflow: state.id,
      left: leftURL,
      right: rightURL,
      ratio: '0.5',
    });
    splitLink.href = '/rm/pages/split-view.html?' + splitParams.toString();
    splitLink.title = 'Open ' + (rightP ? rightP.label : 'a workflow page') + ' side-by-side with the current page';
  }

  // V3.75 — match a chip's base URL against a split pane URL (path + ?tab).
  function _splitMatch(chipHref, paneHref) {
    try {
      const a = new URL(chipHref, location.origin);
      const b = new URL(paneHref, location.origin);
      if (a.pathname !== b.pathname) return false;
      const aTab = new URLSearchParams(a.search).get('tab') || '';
      const bTab = new URLSearchParams(b.search).get('tab') || '';
      // Most-specific match: same tab. Generic chip (no tab) matches any
      // pane URL with the same pathname so the open marker still appears.
      if (!aTab) return true;
      return aTab === bTab;
    } catch (e) { return false; }
  }

  let renderedAny = false;
  ids.forEach(id => {
    const p = pageMap.get(id);
    if (!p) return;       // page no longer exists — silently skip per locked decision #6
    if (!canAccess(id)) return;
    renderedAny = true;
    const a = document.createElement('a');
    a.className = 'ws-page';
    // V3.73 — chip links to the LAST URL the user visited for this page in
    // this workflow session (e.g. ?paper=mebp on the editor), not just the
    // canonical chip href. Falls back to the canonical href on first visit.
    const remembered = (state.pageState && state.pageState[id]) || null;
    const baseHref = remembered || p.href;
    a.href = _wfDecorateHref(baseHref, state.id);
    a.textContent = p.label;
    a.title = p.group + ' · ' + p.label
            + (remembered && remembered !== p.href ? ' · resumes where you left off' : '')
            + ' · drag to reorder';
    a.dataset.pageId = id;
    a.draggable = true;       // V3.66 — enable HTML5 drag-and-drop
    // V3.75 — split-mode states: open + active.
    let openSide = null;      // 'left' | 'right' | null
    if (onSplit && splitState) {
      if (_splitMatch(baseHref, splitState.left))      openSide = 'left';
      else if (_splitMatch(baseHref, splitState.right)) openSide = 'right';
      if (openSide) {
        a.classList.add('ws-page-open');
        a.classList.add('ws-page-open--' + openSide);
        if (openSide === splitState.active) a.classList.add('ws-page-active-split');
        a.title = p.group + ' · ' + p.label + ' · open in ' + openSide
                + (openSide === splitState.active ? ' (active — click another pill to swap it)' : ' — click to make active');
      }
    }
    // Active highlight when the path+query matches (single-page mode).
    if (!onSplit && !onShell) {
      const target = new URL(p.href, location.origin);
      if (target.pathname === currentPath
          && (target.search === currentSearch || target.search === '')) {
        a.classList.add('active');
      }
    }
    // V3.78 — shell-mode active state: pill is active when its id ===
    // ?active= in the URL. Pill clicks dispatch rm:shell:set-active
    // events instead of navigating; workflow-shell.js handles the URL
    // update via writeState + swaps which iframe is visible.
    //
    // V3.83 — DO NOT update the URL here. Earlier the click handler
    // updated `?active=` BEFORE dispatching the event; workflow-shell's
    // listener then read readState() which already had the new value
    // and its `if (pageId === s.active) return` early-bailed, so
    // showActiveFrame never fired and the iframe never swapped. Now
    // the listener owns the URL update — single source of truth.
    if (onShell) {
      if (id === shellActiveId) a.classList.add('active');
      a.addEventListener('click', (e) => {
        e.preventDefault();
        if (id === shellActiveId) return;     // already active — no-op
        // CustomEvent dispatch is synchronous — the listener in
        // workflow-shell.js runs (writeState updates URL, iframe
        // swaps) before the next line executes, so the strip refresh
        // reads the new ?active= and lights up the right pill.
        window.dispatchEvent(new CustomEvent('rm:shell:set-active', { detail: { pageId: id } }));
        if (typeof _wfRefreshStrip === 'function') _wfRefreshStrip();
      });
    }
    // V3.75 — split-mode click: dispatch events instead of navigating.
    // split-view.js applies the change and fires rm:split:state-change,
    // which the listener at the bottom of this file uses to re-render
    // the strip — no need for a setTimeout fallback.
    if (onSplit) {
      a.addEventListener('click', (e) => {
        e.preventDefault();
        if (openSide && openSide === splitState.active) return;     // already active
        if (openSide) {
          window.dispatchEvent(new CustomEvent('rm:split:set-active', { detail: { side: openSide } }));
        } else {
          window.dispatchEvent(new CustomEvent('rm:split:swap', { detail: { side: splitState.active, href: baseHref } }));
        }
      });
    }
    // V3.66 — drag handlers for reordering chips. The × button has its
    // own click handler that stopPropagations, so removal still works.
    a.addEventListener('dragstart', _wfChipDragStart);
    a.addEventListener('dragend',   _wfChipDragEnd);
    a.addEventListener('dragover',  _wfChipDragOver);
    a.addEventListener('dragleave', _wfChipDragLeave);
    a.addEventListener('drop',      _wfChipDrop);
    pagesEl.appendChild(a);

    // V3.65 — × button removes the page from the workflow.
    const rm = document.createElement('button');
    rm.className = 'ws-page-remove';
    rm.type = 'button';
    rm.textContent = '×';
    rm.title = 'Remove ' + p.label + ' from this workflow';
    rm.draggable = false;     // don't initiate drag from the × button
    rm.addEventListener('click', (e) => {
      e.preventDefault();
      e.stopPropagation();
      _wfRemovePage(id);
      _wfRefreshStrip();
    });
    // Stop the × button from initiating chip drag.
    rm.addEventListener('mousedown', (e) => e.stopPropagation());
    rm.addEventListener('dragstart', (e) => e.preventDefault());
    a.appendChild(rm);
  });
  if (!renderedAny) {
    pagesEl.innerHTML = '<span class="ws-page" style="opacity:.5">No accessible pages in this workflow</span>';
  }

  // V3.65 — + Add page button. Opens picker modal of accessible pages
  // not already in the workflow.
  const addBtn = document.createElement('button');
  addBtn.className = 'ws-btn';
  addBtn.type = 'button';
  addBtn.textContent = '+ Add page';
  addBtn.title = 'Add a page to this workflow';
  addBtn.addEventListener('click', () => _wfOpenAddPageModal(state, wf));
  actionsEl.insertBefore(addBtn, splitLink);

  // V3.65 + V3.66 — Save as custom (default workflows) / Save changes (custom).
  // Dirty when the user has added, removed, OR reordered pages.
  const dirty = (state.addedPageIds.length || state.removedPageIds.length || state.orderOverride);
  if (dirty || state.kind === 'custom') {
    const saveBtn = document.createElement('button');
    saveBtn.className = 'ws-btn ws-btn-primary';
    saveBtn.type = 'button';
    saveBtn.textContent = state.kind === 'default' ? 'Save as custom' : 'Save changes';
    saveBtn.title = state.kind === 'default'
      ? 'Save this modified workflow under your account'
      : 'Persist edits to this custom workflow';
    saveBtn.addEventListener('click', () => _wfSaveCurrent(state, wf));
    actionsEl.insertBefore(saveBtn, splitLink);
  }
}

/* ── V3.66 — Drag-to-reorder strip chips ──
 *
 * HTML5 drag-and-drop. Each .ws-page has draggable=true. dragstart
 * captures the pageId being dragged; dragover indicates valid drop
 * targets (other chips); drop computes the new order and writes
 * orderOverride to sessionStorage, then refreshes the strip in place.
 *
 * The × button is excluded from drag (its dragstart handler returns
 * preventDefault, and a mousedown stopPropagation prevents the parent
 * chip's dragstart from firing when the user clicks the ×).
 *
 * For custom workflows: the reorder lives in sessionStorage's
 * orderOverride until the user clicks "Save changes" — same pattern
 * as add/remove. */

let _wfDragSourceId = null;

function _wfChipDragStart(e) {
  const chip = e.currentTarget;
  _wfDragSourceId = chip.dataset.pageId;
  chip.classList.add('ws-page-dragging');
  // Required for Firefox compatibility.
  if (e.dataTransfer) {
    e.dataTransfer.effectAllowed = 'move';
    try { e.dataTransfer.setData('text/plain', _wfDragSourceId); } catch (err) { /* IE quirks */ }
  }
}

function _wfChipDragEnd(e) {
  e.currentTarget.classList.remove('ws-page-dragging');
  document.querySelectorAll('.ws-page-drop-before, .ws-page-drop-after')
    .forEach(el => el.classList.remove('ws-page-drop-before', 'ws-page-drop-after'));
  _wfDragSourceId = null;
}

function _wfChipDragOver(e) {
  if (!_wfDragSourceId) return;
  const chip = e.currentTarget;
  if (chip.dataset.pageId === _wfDragSourceId) return;
  e.preventDefault();
  if (e.dataTransfer) e.dataTransfer.dropEffect = 'move';
  // Decide before/after based on horizontal midpoint of the target chip.
  const rect = chip.getBoundingClientRect();
  const isBefore = (e.clientX - rect.left) < rect.width / 2;
  chip.classList.toggle('ws-page-drop-before', isBefore);
  chip.classList.toggle('ws-page-drop-after',  !isBefore);
}

function _wfChipDragLeave(e) {
  e.currentTarget.classList.remove('ws-page-drop-before', 'ws-page-drop-after');
}

function _wfChipDrop(e) {
  if (!_wfDragSourceId) return;
  const target = e.currentTarget;
  if (target.dataset.pageId === _wfDragSourceId) return;
  e.preventDefault();
  e.stopPropagation();

  // Build the current effective order from the DOM (so what the user
  // sees is what we persist).
  const currentOrder = Array.from(document.querySelectorAll('.ws-page'))
    .map(el => el.dataset.pageId).filter(Boolean);
  const fromIdx = currentOrder.indexOf(_wfDragSourceId);
  let toIdx = currentOrder.indexOf(target.dataset.pageId);
  if (fromIdx < 0 || toIdx < 0) return;

  const rect = target.getBoundingClientRect();
  const isBefore = (e.clientX - rect.left) < rect.width / 2;
  // Remove dragged item; recompute insertion index after the removal.
  currentOrder.splice(fromIdx, 1);
  if (toIdx > fromIdx) toIdx -= 1;
  if (!isBefore) toIdx += 1;
  currentOrder.splice(toIdx, 0, _wfDragSourceId);

  // Persist as orderOverride and refresh the strip.
  const s = _wfReadState();
  if (!s) return;
  s.orderOverride = currentOrder;
  _wfWriteState(s);
  _wfRefreshStrip();
}

/* ── V3.65 strip mutations ── */

function _wfWriteState(state) {
  if (!state) sessionStorage.removeItem(_WF_STORAGE_KEY);
  else sessionStorage.setItem(_WF_STORAGE_KEY, JSON.stringify(state));
}

function _wfRemovePage(pageId) {
  const s = _wfReadState();
  if (!s) return;
  if (s.addedPageIds.indexOf(pageId) >= 0) {
    s.addedPageIds = s.addedPageIds.filter(x => x !== pageId);
  } else if (s.removedPageIds.indexOf(pageId) < 0) {
    s.removedPageIds.push(pageId);
  }
  _wfWriteState(s);
}

function _wfAddPage(pageId) {
  const s = _wfReadState();
  if (!s) return;
  if (s.removedPageIds.indexOf(pageId) >= 0) {
    s.removedPageIds = s.removedPageIds.filter(x => x !== pageId);
  } else if (s.addedPageIds.indexOf(pageId) < 0) {
    s.addedPageIds.push(pageId);
  }
  _wfWriteState(s);
}

/* Re-render the strip in place — used after add/remove without
 * navigating. Removes the existing strip and renders a fresh one. */
function _wfRefreshStrip() {
  const existing = document.querySelector('.workflow-strip');
  if (existing) existing.remove();
  const state = _wfReadState();
  if (state) renderWorkflowStrip(state);
}

function _wfOpenAddPageModal(state, wf) {
  const pageMap = _wfBuildPageMap();
  const effective = new Set(_wfEffectivePageIds(wf && wf.pageIds || [], state));
  const isAdmin = (typeof firebridge !== 'undefined') && firebridge.isAdmin && firebridge.isAdmin();
  const canAccess = (id) => {
    if (isAdmin) return true;
    if (typeof firebridge !== 'undefined' && firebridge.canAccessPage) {
      return firebridge.canAccessPage(id);
    }
    return true;
  };
  const candidates = [];
  pageMap.forEach((p, id) => {
    if (effective.has(id)) return;     // already in workflow
    if (!canAccess(id)) return;
    candidates.push(p);
  });
  candidates.sort((a, b) => (a.group || '').localeCompare(b.group || '')
                          || (a.label || '').localeCompare(b.label || ''));

  const back = document.createElement('div');
  back.className = 'ws-modal-back';
  back.addEventListener('click', (e) => { if (e.target === back) back.remove(); });
  const modal = document.createElement('div');
  modal.className = 'ws-modal';
  modal.innerHTML =
    '<h3>Add a page to ' + (wf && wf.label || 'this workflow') + '</h3>' +
    '<div class="ws-modal-sub">Pages you can access that aren\'t already in this workflow.</div>' +
    '<input type="text" class="ws-modal-search" placeholder="Filter…">' +
    '<div class="ws-modal-list"></div>' +
    '<div class="ws-modal-actions">' +
    '  <button class="btn" id="ws-modal-cancel">Close</button>' +
    '</div>';
  back.appendChild(modal);
  document.body.appendChild(back);
  modal.querySelector('#ws-modal-cancel').addEventListener('click', () => back.remove());

  const list = modal.querySelector('.ws-modal-list');
  if (!candidates.length) {
    list.innerHTML = '<div class="ws-modal-empty">No more accessible pages to add.</div>';
  } else {
    candidates.forEach(p => {
      const row = document.createElement('div');
      row.className = 'ws-modal-row';
      row.innerHTML = '<div class="group">' + (p.group || '') + '</div>'
                    + '<div class="label">' + p.label + '</div>';
      row.addEventListener('click', () => {
        _wfAddPage(p.id);
        back.remove();
        _wfRefreshStrip();
      });
      list.appendChild(row);
    });
  }
  // Search filter
  modal.querySelector('.ws-modal-search').addEventListener('input', (e) => {
    const q = (e.target.value || '').trim().toLowerCase();
    list.querySelectorAll('.ws-modal-row').forEach(r => {
      const text = r.textContent.toLowerCase();
      r.style.display = (!q || text.indexOf(q) >= 0) ? '' : 'none';
    });
  });
  modal.querySelector('.ws-modal-search').focus();
}

/* Save current strip state as a custom workflow (kind=default + dirty)
 * or persist edits back to the custom doc (kind=custom). */
function _wfSaveCurrent(state, wf) {
  if (typeof firebridge === 'undefined' || !firebridge.db) {
    alert('Firebase not ready.');
    return;
  }
  const u = firebridge.getUser && firebridge.getUser();
  if (!u) { alert('Sign in to save workflows.'); return; }
  const effective = _wfEffectivePageIds(wf && wf.pageIds || [], state);
  if (state.kind === 'custom') {
    // Direct save back to existing custom doc.
    firebridge.db()
      .collection('userData').doc(u.uid)
      .collection('customWorkflows').doc(state.id)
      .set({ pageIds: effective, updatedAt: new Date() }, { merge: true })
      .then(() => {
        // Reset dirty edits — pageIds are now the persisted list, and
        // orderOverride is folded in.
        const s = _wfReadState();
        if (s) {
          s.addedPageIds = []; s.removedPageIds = []; s.orderOverride = null;
          _wfWriteState(s);
        }
        _wfRefreshStrip();
        if (window.toast) toast.show('Workflow saved.', 'ok');
      })
      .catch(err => { alert('Save failed: ' + err.message); });
    return;
  }
  // kind === 'default' — open name modal, save as new custom doc.
  _wfOpenSaveAsModal(state, wf, effective);
}

function _wfOpenSaveAsModal(state, wf, effectivePageIds) {
  const back = document.createElement('div');
  back.className = 'ws-modal-back';
  back.addEventListener('click', (e) => { if (e.target === back) back.remove(); });
  const modal = document.createElement('div');
  modal.className = 'ws-modal';
  const suggested = (wf && wf.label ? wf.label + ' (mine)' : 'My workflow');
  modal.innerHTML =
    '<h3>Save as custom workflow</h3>' +
    '<div class="ws-modal-sub">Stored under your account at <code>userData/{your-uid}/customWorkflows</code>. Only you can see and edit it.</div>' +
    '<label style="display:block;font-size:11px;text-transform:uppercase;letter-spacing:.4px;color:#6b7280;margin-bottom:4px;">Name</label>' +
    '<input type="text" id="ws-save-name" class="ws-modal-search" value="' + suggested.replace(/"/g, '&quot;') + '">' +
    '<div class="ws-modal-actions">' +
    '  <button class="btn" id="ws-save-cancel">Cancel</button>' +
    '  <button class="btn btn-primary" id="ws-save-confirm">Save</button>' +
    '</div>';
  back.appendChild(modal);
  document.body.appendChild(back);
  const nameInput = modal.querySelector('#ws-save-name');
  nameInput.focus();
  nameInput.select();
  modal.querySelector('#ws-save-cancel').addEventListener('click', () => back.remove());
  modal.querySelector('#ws-save-confirm').addEventListener('click', async () => {
    const name = (nameInput.value || '').trim();
    if (!name) { nameInput.focus(); return; }
    const slug = name.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '');
    if (!slug) { alert('Name must include letters or numbers.'); return; }
    const u = firebridge.getUser && firebridge.getUser();
    if (!u) return;
    const docRef = firebridge.db()
      .collection('userData').doc(u.uid)
      .collection('customWorkflows').doc(slug);
    // V3.66 — inherit the source workflow's landingPageId when it's still
    // in the effective list; else fall back to the first page.
    var landingId = (wf && wf.landingPageId && effectivePageIds.indexOf(wf.landingPageId) >= 0)
      ? wf.landingPageId : '';
    try {
      await docRef.set({
        id: slug,
        label: name,
        description: 'Custom — based on ' + (wf && wf.label || state.id),
        icon: '⭐',
        pageIds: effectivePageIds,
        landingPageId: landingId,
        basedOn: state.id,
        createdAt: new Date(),
        updatedAt: new Date(),
      }, { merge: false });
      // Switch active state to the new custom workflow. Preserve the
      // user's pageState (V3.73) so they keep their open URLs across the
      // save-as transition (e.g. the paper they were editing stays).
      const carriedPageState = (state && state.pageState) || {};
      _wfWriteState({ id: slug, kind: 'custom', addedPageIds: [], removedPageIds: [], orderOverride: null, pageState: carriedPageState });
      back.remove();
      _wfRefreshStrip();
      if (window.toast) toast.show('Saved as "' + name + '".', 'ok');
    } catch (err) {
      alert('Save failed: ' + err.message);
    }
  });
}

function renderNav() {
  // V3.76 — embed suppression is checked in two complementary ways:
  //   1. window.name starts with 'rm-embed' (split-view iframes V3.75)
  //      OR 'rm-shell-' (workflow-shell iframes V3.78). The browsing
  //      context name SURVIVES navigations within the same frame (HTML
  //      spec), so iframes stay nav-suppressed even after in-page
  //      `<a href>` clicks that drop the `?embed=1` query.
  //   2. ?embed=1 query (V3.73 mechanism) — kept as defense-in-depth
  //      and for the initial document load.
  const isEmbed = (typeof window.name === 'string' && /^rm-(embed|shell)/.test(window.name))
               || (new URLSearchParams(location.search).get('embed') === '1');
  if (isEmbed) {
    document.documentElement.dataset.rmEmbed = '1';
    // Inject minimal CSS to hide ancillary chrome that other scripts add
    // (sync-status indicator etc.) — keeps embedded panes visually clean.
    const st = document.createElement('style');
    st.textContent = 'html[data-rm-embed="1"] .top-nav,'
                   + 'html[data-rm-embed="1"] .workflow-strip,'
                   + 'html[data-rm-embed="1"] #firebridge-indicator { display: none !important; }'
                   + 'html[data-rm-embed="1"] body { padding-top: 0 !important; }';
    document.head.appendChild(st);
    return;
  }

  // V3.64 — adopt ?workflow=<id> from URL into sessionStorage, then
  // pick which nav to render. If a workflow is active, the strip
  // replaces the six-group nav.
  const wfState = _wfAdoptFromUrl();
  if (wfState) {
    renderWorkflowStrip(wfState);
    return;
  }

  const nav = document.createElement('nav');
  nav.className = 'top-nav';

  const brand = document.createElement('a');
  brand.className = 'brand';
  brand.href = '/rm/index.html';
  brand.textContent = 'McGhee Lab';
  nav.appendChild(brand);

  // V3.74 — non-workflow nav slimmed to two primary options ("Workflows"
  // and "All Pages") + Split. The old six-group dropdowns (Activity /
  // Research / Operations / Lab Admin / Settings) are gone — page
  // discovery now goes through the All Pages tile grid at
  // /rm/index.html?view=all-pages, which also shows page descriptions.
  // Direct links remain via in-page links + the pinned ⭐ My Workflows
  // dropdown (V3.66) when the user has saved custom workflows.
  const currentPath = window.location.pathname;
  const currentSearch = window.location.search;
  const currentView = new URLSearchParams(currentSearch).get('view') || '';
  const onHome = (currentPath === '/rm/index.html' || currentPath === '/rm/' || currentPath === '/');

  function makeTopLink(label, href, isActive) {
    const a = document.createElement('a');
    a.href = href;
    a.textContent = label;
    if (isActive) a.classList.add('active');
    return a;
  }

  nav.appendChild(makeTopLink('🗂 Workflows', '/rm/index.html', onHome && currentView !== 'all-pages'));
  nav.appendChild(makeTopLink('⊞ All Pages', '/rm/index.html?view=all-pages', onHome && currentView === 'all-pages'));
  nav.appendChild(makeTopLink('⊟ Split', '/rm/pages/split-view.html', currentPath === '/rm/pages/split-view.html'));

  // Close dropdowns when clicking outside
  document.addEventListener('click', () => {
    document.querySelectorAll('.nav-dropdown.open').forEach(d => d.classList.remove('open'));
  });

  document.body.prepend(nav);
  // Apply current auth state immediately (likely a no-op if firebridge hasn't
  // fired yet — onAuth will re-call it).
  applyNavGates();

  // V3.66 — pin custom workflows as a dropdown after the regular groups.
  // Async; appends to `nav` after firebridge auth resolves.
  _wfPinCustomWorkflows(nav);
}

/* ── V3.66 — Pin custom workflows to the nav ──
 *
 * After the regular six-group nav renders, fetch the user's custom
 * workflows and append a "My Workflows ▾" dropdown. Each entry is
 * one custom workflow; clicking enters the workflow at its first
 * accessible page. Dropdown is hidden when the user has no custom
 * workflows.
 *
 * Only renders when no workflow is active (it's part of the regular
 * six-group nav, not the strip). */

let _wfCustomCache = null;

async function _wfPinCustomWorkflows(navEl) {
  if (typeof firebridge === 'undefined') return;
  // Inject workflow.css (idempotent — browser dedupes by href). Needed
  // for .nav-dropdown-pinned styles below.
  if (!document.querySelector('link[href="/rm/css/workflow.css"]')) {
    const link = document.createElement('link');
    link.rel = 'stylesheet';
    link.href = '/rm/css/workflow.css';
    document.head.appendChild(link);
  }
  // Wait for sign-in to resolve so the doc reads succeed.
  try { await firebridge.whenAuthResolved(); } catch (e) { /* ignore */ }
  const u = firebridge.getUser && firebridge.getUser();
  if (!u) return;
  // Also wait for the access grant so canAccessPage filters correctly.
  if (firebridge.loadAccessGrant) {
    try { await firebridge.loadAccessGrant(); } catch (e) { /* ignore */ }
  }

  let workflows = _wfCustomCache;
  if (!workflows) {
    try {
      const snap = await firebridge.db()
        .collection('userData').doc(u.uid)
        .collection('customWorkflows').get();
      workflows = [];
      snap.forEach(d => workflows.push(Object.assign({ id: d.id }, d.data() || {})));
    } catch (err) {
      return;
    }
    _wfCustomCache = workflows;
  }
  if (!workflows.length) return;
  if (!document.body.contains(navEl)) return;  // nav was replaced

  const pageMap = _wfBuildPageMap();
  const isAdmin = firebridge.isAdmin && firebridge.isAdmin();
  const canAccess = (id) => {
    if (isAdmin) return true;
    if (firebridge.canAccessPage) return firebridge.canAccessPage(id);
    return true;
  };

  // Compute, per workflow, the landing page href (landingPageId if set
  // and accessible; else first accessible page).
  const entries = [];
  workflows.forEach(wf => {
    const pageIds = wf.pageIds || [];
    let landingId = wf.landingPageId;
    if (landingId && (!canAccess(landingId) || !pageMap.get(landingId))) landingId = null;
    if (!landingId) {
      landingId = pageIds.find(id => canAccess(id) && pageMap.get(id));
    }
    if (!landingId) return;     // no accessible pages — skip
    const p = pageMap.get(landingId);
    if (!p) return;
    entries.push({
      id: wf.id,
      label: wf.label || wf.id,
      icon: wf.icon || '⭐',
      href: _wfDecorateHref(p.href, wf.id),
    });
  });
  if (!entries.length) return;

  // Build the dropdown.
  const wrapper = document.createElement('div');
  wrapper.className = 'nav-dropdown nav-dropdown-pinned';
  const trigger = document.createElement('button');
  trigger.className = 'nav-dropdown-trigger';
  trigger.textContent = '⭐ My Workflows';
  trigger.title = 'Custom workflows you saved';
  const menu = document.createElement('div');
  menu.className = 'dropdown-menu';
  entries.forEach(e => {
    const a = document.createElement('a');
    a.href = e.href;
    a.textContent = e.icon + ' ' + e.label;
    menu.appendChild(a);
  });
  // Add a divider + "Manage workflows…" link to the chooser.
  const div = document.createElement('div');
  div.className = 'dropdown-divider';
  menu.appendChild(div);
  const manage = document.createElement('a');
  manage.href = '/rm/index.html';
  manage.textContent = 'Manage workflows…';
  manage.style.fontStyle = 'italic';
  manage.style.color = 'var(--text-muted, #6b7280)';
  menu.appendChild(manage);

  trigger.addEventListener('click', (e) => {
    e.stopPropagation();
    const wasOpen = wrapper.classList.contains('open');
    document.querySelectorAll('.nav-dropdown.open').forEach(d => d.classList.remove('open'));
    if (!wasOpen) wrapper.classList.add('open');
  });
  wrapper.appendChild(trigger);
  wrapper.appendChild(menu);
  navEl.appendChild(wrapper);
}

/* Show/hide nav entries based on the signed-in user's permissions. Called
 * once at render and again from firebridge.onAuth whenever auth state
 * changes (sign in, sign out, role promotion via live profile snapshot). */
function applyNavGates() {
  const isAdmin     = (typeof firebridge !== 'undefined') && firebridge.isAdmin && firebridge.isAdmin();
  const isLabMember = (typeof firebridge !== 'undefined') && firebridge.isLabMember && firebridge.isLabMember();
  const allowed = (gate) => {
    if (!gate) return true;
    if (gate === 'admin') return !!isAdmin;
    if (gate === 'lab-member') return !!isLabMember;
    return true;
  };

  // Hide individual items whose gate is unmet.
  document.querySelectorAll('.top-nav [data-gate]').forEach(el => {
    el.style.display = allowed(el.dataset.gate) ? '' : 'none';
  });

  // Hide a dropdown group whose visible children are all hidden — keeps the
  // nav from showing an empty "Activity ▾" with no entries inside.
  document.querySelectorAll('.top-nav .nav-dropdown').forEach(group => {
    if (group.dataset.gate && !allowed(group.dataset.gate)) {
      group.style.display = 'none';
      return;
    }
    const links = group.querySelectorAll('.dropdown-menu > a');
    if (!links.length) return;
    let anyVisible = false;
    links.forEach(a => {
      if (a.style.display !== 'none') anyVisible = true;
    });
    if (!anyVisible) group.style.display = 'none';
    else if (!group.dataset.gate || allowed(group.dataset.gate)) group.style.display = '';
  });
}

document.addEventListener('DOMContentLoaded', renderNav);

// V3.75 — split-view.js dispatches this when its URL state changes
// (active flip, pane swap). The strip needs to re-render to update
// open/active visual states. Guarded so the initial writeState call
// at split-view.js IIFE time (which fires BEFORE nav.js renders the
// strip on DOMContentLoaded) doesn't try to refresh a strip that
// doesn't exist yet — the natural DCL render handles initial state.
window.addEventListener('rm:split:state-change', () => {
  if (typeof _wfRefreshStrip !== 'function') return;
  if (!document.querySelector('.workflow-strip')) return;
  _wfRefreshStrip();
});

// Re-apply gates whenever firebridge auth state changes. firebridge.onAuth
// is registered via window.addEventListener so we don't depend on script load
// order — it'll exist by the time the listener runs.
window.addEventListener('DOMContentLoaded', () => {
  if (typeof firebridge !== 'undefined' && firebridge.onAuth) {
    firebridge.onAuth(() => applyNavGates());
  }
});
