/* nav.js — renders the ONE shared top bar on every RM page (V3.809).
 *
 *   [McGhee Lab] [⌕ Go to… ⌘K] │ [chip][chip][chip]… [+] │ [Workflows ▾] [⊟] [sync] [avatar]
 *
 * The bar has the same shape everywhere. What changes is what the chips
 * are:
 *   - normally: the user's PINNED pages (userData/{uid}/navPrefs/pins,
 *     mirrored in localStorage) followed by RECENT pages ranked by
 *     frecency (localStorage, per device on purpose). The current page is
 *     always among them and highlighted.
 *   - while a workflow is active (sessionStorage, see the V3.64 helpers
 *     below): the workflow's pages — × to remove, drag to reorder, + to
 *     add, Save when dirty. Same chips, `top-nav--workflow` tint.
 *
 * "Go to…" (⌘K / Ctrl+K / "/") opens the command palette in
 * rm/js/nav-palette.js, lazy-loaded on first use. ⌥1–⌥9 jump to chips.
 *
 * Per-item access gating: each nav item may carry a `gate` field:
 *   - 'admin'      → only visible when firebridge.isAdmin() is true
 *   - 'lab-member' → only visible when firebridge.isLabMember() is true
 *                    (any non-guest signed-in user)
 *   - undefined    → always visible
 *
 * Gating is applied AFTER initial render — the bar appears immediately so
 * the page never flashes empty. firebridge.onAuth then hides gated chips.
 *
 * NAV_ITEMS is still the single source of truth for which pages exist:
 * page-registry.js flattens it, all-pages.js tiles it, the admin matrix
 * and the workflow builder pick from it. Each entry carries an `icon`
 * (Heroicon name, see rm/js/icons.js) and NAV_PAGE_DESCRIPTIONS below
 * carries its one-line blurb — both live HERE because nav.js is the one
 * script every RM page loads, and the chips + palette need them on every
 * page. */

const NAV_ITEMS = [
  // V3.809 — "Dashboard" is now "Home". The page id stays `dashboard`
  // (page-registry special-cases /rm/index.html) so stored workflow page
  // lists and tracker entries keep resolving.
  { label: 'Home', href: '/rm/index.html', icon: 'home' },

  // V3.526/V3.535 — My Week: the unified "start here" surface; entries fan
  // out to huddle / equipment / notebook / tracker via day-distribute.js.
  // Top-level (first after Home) — it's the page students open first.
  // pageGroup files it under Activity in the All Pages grid (V3.542).
  { label: 'My Week', href: '/rm/pages/my-week.html', gate: 'lab-member', pageGroup: 'Activity', icon: 'sun' },

  { label: 'Activity', href: '/rm/pages/activity-overview.html', icon: 'chart-bar', children: [
    // V3.536 — mentor↔mentee weekly-focus loop (assign / edit / sign off).
    { label: 'Team Focus', href: '/rm/pages/team-focus.html', gate: 'lab-member', icon: 'target' },
    { label: 'Overview', href: '/rm/pages/activity-overview.html', icon: 'chart-bar' },
    { label: 'Tracker',  href: '/rm/pages/activity-overview.html?tab=tracker', icon: 'clock' },
    { label: 'Email',    href: '/rm/pages/activity-overview.html?tab=email', icon: 'envelope' },
    { label: 'Year',     href: '/rm/pages/activity-overview.html?tab=timeline', icon: 'calendar-days' },
    { label: 'PMR',      href: '/rm/pages/pmr.html', icon: 'clipboard-document-list' },
    { label: 'Calendar', href: '/rm/pages/calendar.html', icon: 'calendar-days' },
    { label: 'Tasks',    href: '/rm/pages/tasks.html', icon: 'check-circle' },
    // V3.844 — what you did (items used, equipment booked), ready for the notebook
    { label: 'My actions', href: '/rm/pages/actions.html', gate: 'lab-member', icon: 'bolt' },
    // V3.313 — the marketplace carries every cross-user task flow
    // (offers, "I need work" requests, help/handoff asks). V3.317 folded
    // the legacy Sharing page's tabs into its Assignments view.
    // V3.480 — the board is now the `market` tab of the unified Tasks page;
    // task-market.html redirects here.
    { label: 'Task Market', href: '/rm/pages/tasks.html?tab=market', gate: 'lab-member', icon: 'user-group' },
    { label: 'Explorer', href: '/rm/pages/explorer.html', icon: 'magnifying-glass' },
  ]},

  // V3.544 — the Research landing is now the Research Foci hub (the lab's
  // specialty/concept/output map); the projects pin-grid stays as a child.
  { label: 'Research', href: '/rm/pages/research.html', icon: 'microscope', children: [
    { label: 'Research Foci', href: '/rm/pages/research.html', icon: 'compass' },
    { label: 'Outputs',      href: '/rm/pages/outputs.html', icon: 'document' },
    { label: 'Projects',     href: '/rm/pages/projects.html', icon: 'folder' },
    { label: 'Library',      href: '/rm/pages/library.html', icon: 'books' },
    { label: 'Comments',     href: '/rm/pages/library.html?tab=comments', icon: 'chat-bubble-left-right' },
    // V3.630 — the Topics tab (formerly "Lab Themes") had NO nav entry since
    // V3.367, so it was reachable only from the library's in-page tab bar.
    { label: 'Topics',       href: '/rm/pages/library.html?tab=themes', icon: 'tag' },
    // V3.837 — the canvas notebook is THE Lab Notebook; lab-notebook.html and notebook-blocks.html redirect here
    { label: 'Lab Notebook', href: '/rm/pages/notebook.html', gate: 'lab-member', icon: 'book-open' },
    { label: 'Protocols',    href: '/rm/pages/protocols.html', gate: 'lab-member', icon: 'queue-list' },
    { label: 'Papers',       href: '/rm/pages/paper-builder.html', icon: 'pencil-square' },
    // V3.178 — Grants workflow phase 1. V3.179 added the grant writer +
    // budget editor; the federal grants portal + AI matcher land last.
    { label: 'Grants',         href: '/rm/pages/grant-builder.html',    gate: 'lab-member', icon: 'banknotes' },
    { label: 'Biosketches',    href: '/rm/pages/grant-biosketch.html',  gate: 'lab-member', icon: 'identification' },
    { label: 'Facilities Doc', href: '/rm/pages/grant-facilities.html', gate: 'lab-member', icon: 'building-office' },
    { label: 'Teaching',     href: '/rm/pages/teaching.html', icon: 'academic-cap' },
    { label: 'Service',      href: '/rm/pages/service.html', icon: 'building-library' },
  ]},

  // V3.200 — Training is now a single entry under Operations. The 26
  // individual training pages still live on disk and are discoverable
  // via the landing page at /rm/pages/training.html (which has the full
  // categorized grid); they were dropped from NAV_ITEMS so the workflow
  // page-map + All Pages grid don't have to scroll past a wall of
  // training rows. If individual trainings need to become workflow-
  // addable later, add them back as children of a 'Training' sub-list —
  // but the landing page is intentionally the primary discovery surface.
  { label: 'Operations', gate: 'lab-member', icon: 'wrench', children: [
    { label: 'Training',  href: '/rm/pages/training.html', icon: 'academic-cap' },
    { label: 'Chat',      href: '/rm/pages/chat.html', icon: 'chat-bubble-oval-left' },
    { label: 'Huddle',    href: '/rm/pages/huddle.html', icon: 'users' },
    { label: 'Meetings',  href: '/rm/pages/meetings.html', icon: 'megaphone' },
    { label: 'Scheduler', href: '/rm/pages/scheduler.html', icon: 'clock' },
    { label: 'Equipment', href: '/rm/pages/equipment.html', icon: 'microscope' },
  ]},

  { label: 'Lab Admin', gate: 'lab-member', icon: 'briefcase', children: [
    { label: 'Compliance',        href: '/rm/pages/compliance.html', icon: 'scale' },
    { label: 'Chemical Safety',   href: '/rm/pages/chemicals.html', icon: 'beaker' },
    { label: 'Inventory',         href: '/rm/pages/inventory.html', icon: 'cube' },
    { label: 'Scan a label',      href: '/rm/pages/scan.html', gate: 'lab-member', icon: 'camera' },   // V3.844
    { label: 'Lab Members',       href: '/rm/pages/people.html', icon: 'user-circle' },
    { label: 'Important People',  href: '/rm/pages/people.html?tab=important', icon: 'star' },
    { label: 'Career & Tenure',   href: '/rm/pages/career.html', icon: 'trophy' },
    { label: 'Procurement',       href: '/rm/pages/procurement.html', icon: 'shopping-cart' },
    { label: 'Pcard Helper',      href: '/rm/pages/pcard-helper.html', icon: 'credit-card' },
    { label: 'Receipts & Budget', href: '/rm/pages/receipts.html', icon: 'receipt-percent' },
    { label: 'Grant Accounts',    href: '/rm/pages/projects-grants.html', icon: 'banknotes' },
    { label: 'Budget',            href: '/rm/pages/budget.html', icon: 'currency-dollar' },
    { label: 'Analytics',         href: '/rm/pages/analytics.html', icon: 'arrow-trending-up' },
    { label: 'Travel',            href: '/rm/pages/finance.html', icon: 'paper-airplane' },
  ]},

  { label: 'Settings', gate: 'lab-member', icon: 'cog-6-tooth', children: [
    { label: 'Profile',         href: '/rm/pages/profile.html', icon: 'identification' },
    { label: 'Settings',        href: '/rm/pages/settings.html', icon: 'cog-6-tooth' },
    // V3.809 — the label used to carry a 🚀 emoji; the icon field does that now.
    { label: "What's New",      href: '/rm/pages/whats-new.html', icon: 'rocket-launch' },
    { label: 'CV Editor',       href: '/rm/pages/cv-editor.html', icon: 'document-text' },
    { label: 'CV Overview',     href: '/rm/pages/cv-editor.html?tab=lab', gate: 'admin', icon: 'table-cells' },
    { label: 'Member Activity', href: '/rm/pages/activity-overview.html?tab=lab-stats', gate: 'admin', icon: 'chart-bar' },
    { label: 'Classifier Settings', href: '/rm/pages/classifier-settings.html', gate: 'lab-member', icon: 'funnel' },
    { label: 'API Usage',       href: '/rm/pages/api-usage.html', gate: 'admin', icon: 'bolt' },
    { label: 'Permissions',     href: '/rm/pages/admin-permissions.html', gate: 'admin', icon: 'lock-closed' },
    // V3.811 — the default-workflows editor (replaces the matrix tab on Permissions).
    { label: 'Default Workflows', href: '/rm/pages/admin-workflows.html', gate: 'admin', icon: 'rectangle-stack' },
    // V3.304 — external teacher/student platform oversight
    { label: 'Teachers',        href: '/rm/pages/admin-teachers.html', gate: 'admin', icon: 'users' },
    { label: 'Guests',          href: '/rm/pages/admin-guests.html', gate: 'admin', icon: 'arrow-right-start-on-rectangle' },
  ]},

  // V3.56 — Split View opens a side-by-side shell with two RM pages
  // in iframes. Adapted from the lab-apps.js _splitAppId/_splitRatio
  // harness that the user explicitly flagged as a wanted feature.
  // Top-level entry (no children) so it sits visually distinct from
  // the regular section dropdowns.
  { label: 'Split', href: '/rm/pages/split-view.html', icon: 'view-columns' },
];

/* One-line blurb per page id (page-registry.pageIdFromHref shape). Shown
 * as chip tooltips, palette row subtitles and All Pages tile bodies —
 * and SEARCHED by the palette, so a blurb should name the words a lab
 * member would type ("notebook", "bookings", "receipts"). A page without
 * a blurb still renders; it's just less findable. Moved here from
 * all-pages.js in V3.809 so every page has it, not only the home page. */
const NAV_PAGE_DESCRIPTIONS = {
  'dashboard':                          'RM home — jump back in, workflows, every page.',

  /* Activity */
  'my-week':                            'Your week, planned once — focus + protocol + equipment + task combine and fan out to huddle, bookings, notebook, tracker.',
  'team-focus':                         'Mentor↔mentee weekly focus — assign, edit, sign off, and review focus areas and their tasks.',
  'activity-overview':                  'At-a-glance summary of your activity across the lab — emails, calendar, tasks, year review.',
  'activity-overview__tab__tracker':    'Daily activity logger — track time on research, teaching, service.',
  'activity-overview__tab__email':      'Triage and rate inbound email; assign categories and tasks.',
  'activity-overview__tab__timeline':   'Year-in-review timeline of events, emails, and activities grouped by category.',
  'activity-overview__tab__lab-stats':  'Cross-member activity stats (admin only).',
  'pmr':                                'Project Management Reports — 1:1 prep, goals, barriers, weekly entries shared with the PI.',
  'calendar':                           'Lab calendar with deadlines, meetings, and Outlook/Google event imports.',
  'tasks':                              'Bucket-based task workspace — projects, sub-buckets, subtasks, evidence.',
  'tasks__tab__market':                 'Task marketplace — offer work, ask for help, claim posts from teammates.',
  'explorer':                           'Cross-cutting search across activities, emails, events, and tasks.',

  /* Research */
  'research':                           'Research Foci — the lab\'s specialty → concept → output map, with grants and aims.',
  'outputs':                            'Output cards — papers, figures, datasets and the experiments and analyses behind them.',
  'projects':                           'Lab projects, papers, courses, infrastructure, tools — the master list.',
  'library':                            'Captured papers (Chrome extension or PDF drop), tags, citations, the reader.',
  'library__tab__comments':             'Cross-paper annotations + claims feed for literature review.',
  'library__tab__themes':               'Topics — the lab\'s reading themes and key labs, with bulk import.',
  'paper-builder':                      'Paper editor — write, draft, manage figures, export to LaTeX.',
  'teaching':                           'Course planning + outlines for current and upcoming courses.',
  'service':                            'Conferences, committees, reviews, outreach activities.',
  'notebook':                           'Electronic lab notebook — entries built from blocks: notes, calculators, protocols followed, figures, checklists and a personal whiteboard with voice recording.',
  'lab-notebook':                       'Redirects to the Lab Notebook — the old editor is retired (V3.837).',
  'protocols':                          'Protocol library — interactive documents with live calculators and run widgets.',
  'grant-builder':                      'Grant writing workspace — proposals as structured documents with attached docs.',
  'grant-biosketch':                    'NIH/NSF biosketches assembled from your CV data.',
  'grant-facilities':                   'Facilities & resources documents for proposals.',

  /* Operations */
  'chat':                               'Lab chat — channels, DMs, huddles, voice calls, file uploads via Drive.',
  'huddle':                             'Daily huddle planning + help requests + rundown.',
  'meetings':                           'Lab meetings — rotation, slides pipeline, timed agenda, minutes, chores.',
  'scheduler':                          'Public scheduling pages for talks + your personal calendar.',
  'equipment':                          'Lab equipment — bookings, training sign-off, calendar overlays, reminders.',
  'training':                           'Self-paced training modules — RM workflows, microscopy, paper writing, cell culture.',

  /* Lab Admin */
  'compliance':                         'IACUC, IRB, IBC protocols + safety paperwork.',
  'chemicals':                          'Hazardous chemicals — GHS hazards, MSDS, expiration dates.',
  'inventory':                          'All lab items — locations, stock, ownership.',
  'people':                             'Roster — PI, postdocs, students, alumni + roles.',
  'people__tab__important':             'Regents, donors, collaborators, key initiatives.',
  'career':                             'PI tenure dossier — milestones + supporting documents.',
  'procurement':                        'Ask for what you need; approve, order, receive and put away — each step notifies the right person.',
  'receipts':                           'Receipt uploads + budget tracking by account.',
  'projects-grants':                    'Funded projects — budgets, expenses by grant.',
  'budget':                             'Lab-wide budget model + projections.',
  'analytics':                          'Expense charts + trends across categories and accounts.',
  'pcard-helper':                       'P-card purchase helper — compliant description text per expense type.',
  'finance':                            'Travel trips + receipt parsing for reimbursements.',

  /* Settings */
  'profile':                            'Your profile, calendar connections (Outlook/Google), Gmail OAuth.',
  'settings':                           'Notification preferences, calendar sync, all OAuth connections.',
  'whats-new':                          'What changed in RM and the Ourlab app, release by release.',
  'cv-editor':                          'Edit your CV — publications, presentations, grants, service.',
  'cv-editor__tab__lab':                'Lab-wide CV table — see everyone\'s CVs at a glance.',
  'classifier-settings':                'Email auto-classification rules, categories, and review queue.',
  'api-usage':                          'Claude API usage + cost dashboard (admin only).',
  'admin-permissions':                  'User × page access matrix, per-user grants, page tracking, mentors (admin).',
  'admin-workflows':                    'Edit the lab\'s default workflows — which ones exist, their order, icon, blurb, landing page and pages (admin).',
  'admin-teachers':                     'Manage teacher accounts for the public-site class modules (admin).',
  'admin-guests':                       'Review guest sign-ins and promote them to lab members (admin).',

  /* Top-level */
  'split-view':                         'Open two pages side by side.',
};


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
    id: 'lab-research', label: 'Lab Research', icon: 'microscope',
    description: 'Daily research workflow — track activity, browse the library, manage projects, and capture tasks.',
    landingPageId: 'activity-overview__tab__tracker',
    pageIds: ['activity-overview__tab__tracker', 'library', 'projects', 'tasks', 'notebook', 'protocols'],
  },
  {
    id: 'paper-writing', label: 'Paper Writing', icon: 'pencil-square',
    description: 'Compose papers with the editor, pull annotations from the library, track tasks and PMRs, coordinate via chat.',
    landingPageId: 'paper-builder',
    pageIds: ['paper-builder', 'library', 'library__tab__comments', 'tasks', 'pmr', 'chat', 'notebook'],
  },
  {
    id: 'certification-training', label: 'Certification & Training', icon: 'academic-cap',
    description: 'Compliance protocols, chemical safety, training records, and tenure-track milestones.',
    landingPageId: 'compliance',
    pageIds: ['compliance', 'chemicals', 'career', 'tasks'],
  },
  {
    id: 'task-scheduling', label: 'Task Scheduling & Activity Reports', icon: 'chart-bar',
    description: 'Plan tasks, track activity (tracker / year / email), schedule meetings, share assignments, file PMRs.',
    landingPageId: 'tasks',
    pageIds: ['tasks', 'activity-overview', 'activity-overview__tab__tracker', 'activity-overview__tab__timeline', 'activity-overview__tab__email', 'scheduler', 'task-market', 'pmr'],
  },
  {
    id: 'meetings', label: 'Meetings', icon: 'megaphone',
    description: 'Run lab meetings, huddles, and 1:1s with chat, calendar, and task capture wired up.',
    landingPageId: 'meetings',
    pageIds: ['meetings', 'huddle', 'chat', 'tasks', 'calendar'],
  },
  // V3.178 — Grant Writing workflow. V3.179 adds the grant writer +
  // budget editor; the federal grants portal + AI matcher land last.
  {
    id: 'grant-writing', label: 'Grant Writing', icon: 'banknotes',
    description: 'Author proposals end-to-end: grant writer + budget builder, biosketch generator, facilities & equipment boilerplate, and (last) an idea-to-grant matcher backed by the federal opportunities portal.',
    landingPageId: 'grant-builder',
    pageIds: ['grant-builder', 'grant-biosketch', 'grant-facilities', 'tasks', 'chat'],
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

/* V3.632 — entries now also carry `gate` ('admin' | 'lab-member' | null);
 * V3.809 — and `icon` (the Heroicon name declared on the NAV_ITEMS entry,
 * a child inheriting its group's when it has none).
 * Children INHERIT the group's gate when they don't declare their own —
 * every Operations / Lab Admin child relies on that (the group carries
 * `gate: 'lab-member'`, the children carry nothing). Same inheritance
 * rule as page-registry.js. Additive: existing consumers ignore it. */
function _wfBuildPageMap() {
  const m = new Map();
  NAV_ITEMS.forEach(item => {
    const groupLabel = item.label;
    const groupGate = item.gate || null;
    if (item.children && item.children.length) {
      if (item.href) {
        const id = _wfPageIdFromHref(item.href);
        if (!m.has(id)) m.set(id, { id, label: item.label, href: item.href, group: groupLabel, gate: groupGate, icon: item.icon || null });
      }
      item.children.forEach(child => {
        const id = _wfPageIdFromHref(child.href);
        if (!m.has(id)) m.set(id, { id, label: child.label, href: child.href, group: groupLabel, gate: child.gate || groupGate, icon: child.icon || item.icon || null });
      });
    } else if (item.href) {
      const id = _wfPageIdFromHref(item.href);
      if (!m.has(id)) m.set(id, { id, label: item.label, href: item.href, group: groupLabel, gate: groupGate, icon: item.icon || null });
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

/* V3.75 — match a chip's base URL against a split pane URL (path + ?tab).
 * V3.632 — hoisted out of renderWorkflowStrip (it closes over nothing) so
 * the out-of-workflow pane pickers use the same matcher as the strip. */
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



/* ═══════════════════════════════════════════════════════════════════════
 * V3.809 — ONE BAR
 *
 * Everything from here to the drag-reorder handlers is the unified bar:
 * the two stores (recent pages, pinned pages), the bar itself, the chip
 * row in its two flavours (personal / workflow), the Workflows menu, the
 * palette loader and the keyboard shortcuts.
 *
 * Contracts kept from the strip era so the shells need no changes:
 *   - sessionStorage 'mcgheelab.activeWorkflow' shape (helpers above)
 *   - events rm:shell:set-active / rm:shell:switch-workflow (workflow-shell.js)
 *   - events rm:split:swap / rm:split:set-active / rm:split:close (split-view.js)
 *   - _wfRefreshStrip() — workflow-shell.js calls it; it re-renders the bar
 * ═══════════════════════════════════════════════════════════════════════ */

const NAV_RECENT_KEY     = 'rm.nav.recent.v1';
const NAV_PINS_KEY       = 'rm.nav.pins.v1';
const NAV_DEFAULT_PINS   = ['my-week', 'tasks', 'chat'];
const NAV_HALF_LIFE_DAYS = 7;     // a visit is worth half as much a week later
const NAV_MAX_CHIPS      = 10;    // before width fitting; ⌥1–⌥9 cover the first nine
const NAV_RECENT_CAP     = 40;    // pages remembered per device

function _navEsc(s) {
  return String(s == null ? '' : s)
    .replace(/&/g, '&amp;').replace(/</g, '&lt;')
    .replace(/>/g, '&gt;').replace(/"/g, '&quot;');
}
function _navLsGet(key) {
  try { const raw = localStorage.getItem(key); return raw ? JSON.parse(raw) : null; }
  catch (e) { return null; }
}
function _navLsSet(key, val) {
  try { localStorage.setItem(key, JSON.stringify(val)); } catch (e) { /* private mode */ }
}
function _navIsMac() { return /Mac|iPhone|iPad/.test(navigator.platform || ''); }
function _navIsShellHost() { return location.pathname === '/rm/pages/workflow-shell.html'; }
function _navIsSplitHost() { return location.pathname === '/rm/pages/split-view.html'; }

/* ── Recent pages — frecency, per device ──
 *
 * localStorage['rm.nav.recent.v1'] = { pages: { <pageId>: { s, t, n } }, seeded }
 *   s  decayed score at time t      t  last visit (ms)      n  visit count
 * On a visit:  s = s·0.5^(Δdays/7) + 1.   On read: s_eff = s·0.5^(Δdays/7).
 * Per device ON PURPOSE: the lab iPad and the office desktop have different
 * habits, and a sync read would delay the first paint. */
const NavRecents = {
  decay(score, lastMs, nowMs) {
    const days = Math.max(0, ((nowMs || Date.now()) - (lastMs || 0)) / 86400000);
    return (Number(score) || 0) * Math.pow(0.5, days / NAV_HALF_LIFE_DAYS);
  },
  _read() {
    const d = _navLsGet(NAV_RECENT_KEY);
    return (d && typeof d === 'object' && d.pages && typeof d.pages === 'object')
      ? d : { pages: {}, seeded: false };
  },
  _prune(d) {
    const ids = Object.keys(d.pages);
    if (ids.length <= NAV_RECENT_CAP) return;
    ids.sort((a, b) => (d.pages[b].t || 0) - (d.pages[a].t || 0))
       .slice(NAV_RECENT_CAP).forEach(id => { delete d.pages[id]; });
  },
  record(pageId, nowMs) {
    if (!pageId) return null;
    const now = nowMs || Date.now();
    const d = this._read();
    const e = d.pages[pageId] || { s: 0, t: now, n: 0 };
    e.s = this.decay(e.s, e.t, now) + 1;
    e.t = now;
    e.n = (e.n || 0) + 1;
    d.pages[pageId] = e;
    this._prune(d);
    _navLsSet(NAV_RECENT_KEY, d);
    return e;
  },
  list(nowMs) {
    const now = nowMs || Date.now();
    const d = this._read();
    return Object.keys(d.pages).map(id => {
      const e = d.pages[id] || {};
      return { id: id, score: this.decay(e.s, e.t, now), last: e.t || 0, count: e.n || 0 };
    }).filter(r => r.score > 0.05)
      .sort((a, b) => (b.score - a.score) || (b.last - a.last));
  },
  /* First-run seed from the page-time tracker's per-day docs. Adds only
   * ids not already present; marks the store seeded either way. */
  seed(entries, nowMs) {
    const now = nowMs || Date.now();
    const d = this._read();
    let added = 0;
    (entries || []).forEach(en => {
      if (!en || !en.id || d.pages[en.id]) return;
      const w = Math.max(0.5, Number(en.weight) || 1);
      d.pages[en.id] = { s: w, t: en.lastMs || now, n: Math.round(w) };
      added++;
    });
    d.seeded = true;
    this._prune(d);
    _navLsSet(NAV_RECENT_KEY, d);
    return added;
  },
  isSeeded() { return !!this._read().seeded; },
  isEmpty()  { return Object.keys(this._read().pages).length === 0; },
  forget(pageId) {
    const d = this._read();
    if (d.pages[pageId]) { delete d.pages[pageId]; _navLsSet(NAV_RECENT_KEY, d); }
  },
};

/* ── Pinned pages — cross-device ──
 *
 * userData/{uid}/navPrefs/pins = { pageIds: [...], updatedAt } (the blanket
 * owner rule on userData covers it — no rules change), mirrored to
 * localStorage['rm.nav.pins.v1'] so the first paint needs no network.
 * effective() = local mirror, else the defaults. loadCloud() overwrites
 * the mirror when a doc exists. */
const NavPins = {
  _mirror() {
    const d = _navLsGet(NAV_PINS_KEY);
    return (d && Array.isArray(d.pageIds)) ? d : null;
  },
  local() {
    const m = this._mirror();
    return m ? m.pageIds.slice() : null;
  },
  /* True while the mirror holds a change the cloud doesn't have yet (pinned
   * before sign-in resolved, offline, or while the first cloud read was
   * still in flight). loadCloud() then PUSHES instead of pulling — V3.812,
   * the bug Alex hit: a star pressed in the first second got reverted by
   * the stale read landing afterwards. */
  isDirty() { const m = this._mirror(); return !!(m && m.dirty); },
  effective() {
    const l = this.local();
    return l ? l : NAV_DEFAULT_PINS.slice();
  },
  has(id) { return this.effective().indexOf(id) >= 0; },
  set(ids, opts) {
    const clean = Array.from(new Set((ids || []).filter(Boolean)));
    const silent = !!(opts && opts.silent);
    _navLsSet(NAV_PINS_KEY, { pageIds: clean, t: Date.now(), dirty: !silent });
    if (!silent) {
      this._save(clean);
      window.dispatchEvent(new CustomEvent('rm:nav:pins-change', { detail: { pageIds: clean } }));
    }
    return clean;
  },
  toggle(id) {
    const ids = this.effective();
    const i = ids.indexOf(id);
    if (i >= 0) ids.splice(i, 1); else ids.push(id);
    this.set(ids);
    this._announce(id, i < 0);
    return i < 0;       // true = now pinned
  },
  _announce(id, pinned) {
    try {
      const p = _wfBuildPageMap().get(id);
      const name = p ? p.label : id;
      const inWorkflow = !!_wfReadState();
      if (window.toast && toast.success && toast.info) {
        if (pinned) toast.success('★ Pinned ' + name + ' to your bar' + (inWorkflow ? ' — you\'ll see it once you leave this workflow' : ''));
        else toast.info('Unpinned ' + name);
      }
    } catch (e) { /* garnish */ }
  },
  _cloudLoaded: false,
  async loadCloud() {
    if (this._cloudLoaded) return;
    if (typeof firebridge === 'undefined' || !firebridge.db) return;
    try { if (firebridge.whenAuthResolved) await firebridge.whenAuthResolved(); } catch (e) { /* ignore */ }
    const u = firebridge.getUser && firebridge.getUser();
    if (!u) return;
    this._cloudLoaded = true;
    if (this.isDirty()) { await this._save(this.effective()); return; }   // local wins
    const readStartedAt = Date.now();
    try {
      const snap = await firebridge.db()
        .collection('userData').doc(u.uid)
        .collection('navPrefs').doc('pins').get();
      // A toggle made while the read was in flight outranks what the read
      // returns — even if its own write already landed and cleared `dirty`
      // (the read may still carry the pre-write document). Push, don't pull.
      const m = this._mirror();
      if (this.isDirty() || (m && m.t && m.t >= readStartedAt)) { await this._save(this.effective()); return; }
      if (!snap.exists) return;
      const d = snap.data() || {};
      if (!Array.isArray(d.pageIds)) return;
      const before = JSON.stringify(this.effective());
      this.set(d.pageIds, { silent: true });
      if (JSON.stringify(this.effective()) !== before) {
        window.dispatchEvent(new CustomEvent('rm:nav:pins-change', { detail: { pageIds: d.pageIds, source: 'cloud' } }));
      }
    } catch (err) {
      console.warn('[nav] pins read failed:', err && err.message);
    }
  },
  async _save(ids) {
    if (typeof firebridge === 'undefined' || !firebridge.db) return;
    const u = firebridge.getUser && firebridge.getUser();
    if (!u) return;                      // stays dirty; loadCloud pushes it after sign-in
    try {
      await firebridge.db()
        .collection('userData').doc(u.uid)
        .collection('navPrefs').doc('pins')
        .set({ pageIds: ids, updatedAt: new Date() }, { merge: true });
      const m = this._mirror();
      if (m && JSON.stringify(m.pageIds) === JSON.stringify(ids)) {
        _navLsSet(NAV_PINS_KEY, Object.assign({}, m, { dirty: false }));
      }
    } catch (err) {
      console.warn('[nav] pins save failed:', err && err.message);
      if (window.toast && toast.warn) toast.warn('Pin kept on this device for now — it will sync next time.');
    }
  },
};

/* The page id the browser is on, resolved against the NAV_ITEMS page map:
 * path + ?tab first, then the tab-less slug. null for pages outside the
 * nav (a specific paper, a protocol document, the shells). */
function _navCurrentPageId(pageMap) {
  const id = _wfPageIdFromHref(_splitCanonHref(location.pathname + location.search));
  if (pageMap.has(id)) return id;
  const slug = String(id).split('__tab__')[0];
  return pageMap.has(slug) ? slug : null;
}

/* Default workflows = inlined seeds merged with labConfig/defaultWorkflows
 * (Firestore wins on id). Shares _wfDefaultsCache with _wfFetchWorkflow. */
async function _navLoadDefaultWorkflows() {
  if (_wfDefaultsCache) return _wfDefaultsCache;
  let firestoreList = [];
  if (typeof firebridge !== 'undefined' && firebridge.db) {
    try {
      const snap = await firebridge.db().collection('labConfig').doc('defaultWorkflows').get();
      if (snap.exists) {
        const data = snap.data() || {};
        firestoreList = Array.isArray(data.workflows) ? data.workflows : [];
      }
    } catch (e) { /* seeds */ }
  }
  const byId = new Map();
  _WF_DEFAULT_SEEDS.forEach(w => byId.set(w.id, w));
  firestoreList.forEach(w => { if (w && w.id) byId.set(w.id, w); });
  _wfDefaultsCache = Array.from(byId.values());
  return _wfDefaultsCache;
}

let _wfCustomCache = null;
async function _navLoadCustomWorkflows() {
  if (_wfCustomCache) return _wfCustomCache;
  if (typeof firebridge === 'undefined' || !firebridge.db) return [];
  const u = firebridge.getUser && firebridge.getUser();
  if (!u) return [];
  const out = [];
  try {
    const snap = await firebridge.db()
      .collection('userData').doc(u.uid)
      .collection('customWorkflows').get();
    snap.forEach(d => out.push(Object.assign({ id: d.id }, d.data() || {})));
  } catch (e) { /* ignore */ }
  _wfCustomCache = out;
  return out;
}

/* Landing page for a workflow: landingPageId when accessible, else the
 * first accessible page. Returns a page-map entry or null. */
function _navWorkflowLanding(wf, pageMap, canAccess) {
  const ok = id => id && pageMap.get(id) && canAccess(id);
  if (ok(wf.landingPageId)) return pageMap.get(wf.landingPageId);
  const first = (wf.pageIds || []).find(ok);
  return first ? pageMap.get(first) : null;
}
function _navCanAccessFn() {
  const isAdmin = (typeof firebridge !== 'undefined') && firebridge.isAdmin && firebridge.isAdmin();
  return id => {
    if (isAdmin) return true;
    if (typeof firebridge !== 'undefined' && firebridge.canAccessPage) return firebridge.canAccessPage(id);
    return true;
  };
}

/* ── The bar ── */

/* Chrome other scripts inject into .top-nav (firebase-bridge's profile
 * chip, sync-status's chip). They inject once, so a re-render must carry
 * them over instead of losing them. */
let _navDetachedChrome = null;

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
    const st = document.createElement('style');
    st.textContent = 'html[data-rm-embed="1"] .top-nav,'
                   + 'html[data-rm-embed="1"] .workflow-strip,'
                   + 'html[data-rm-embed="1"] #firebridge-indicator { display: none !important; }'
                   + 'html[data-rm-embed="1"] body { padding-top: 0 !important; }';
    document.head.appendChild(st);
    return;
  }
  // V3.64 — adopt ?workflow=<id> from URL into sessionStorage.
  const wfState = _wfAdoptFromUrl();
  // Called twice (a page that also calls renderNav by hand, a harness that
  // races DOMContentLoaded)? Redraw instead of stacking a second bar.
  if (document.querySelector('nav.top-nav')) { _wfRefreshStrip(); return; }
  _navBuildBar(wfState);
}

/* Re-render the bar in place (after add/remove/reorder/leave, and from
 * workflow-shell.js after an in-place workflow switch). The name is the
 * strip era's — workflow-shell.js calls it by this name. */
function _wfRefreshStrip() {
  const old = document.querySelector('nav.top-nav');
  if (old) {
    _navDetachedChrome = ['sync-status-chip', 'fb-profile-wrap']
      .map(id => document.getElementById(id)).filter(Boolean);
    _navDetachedChrome.forEach(el => el.remove());
    old.remove();
  }
  if (document.documentElement.dataset.rmEmbed === '1') return;
  _navBuildBar(_wfReadState());
}

function _navBuildBar(wfState) {
  // workflow.css carries the modal + chip-drag styles; idempotent inject.
  if (!document.querySelector('link[href="/rm/css/workflow.css"]')) {
    const link = document.createElement('link');
    link.rel = 'stylesheet';
    link.href = '/rm/css/workflow.css';
    document.head.appendChild(link);
  }
  const onShell = _navIsShellHost();
  const onSplit = _navIsSplitHost();

  const nav = document.createElement('nav');
  nav.className = 'top-nav' + (wfState ? ' top-nav--workflow' : '');
  nav.setAttribute('aria-label', 'RM navigation');

  const brand = document.createElement('a');
  brand.className = 'brand';
  brand.href = '/rm/index.html';
  brand.textContent = 'McGhee Lab';
  brand.title = 'Home';
  nav.appendChild(brand);

  // ⌕ Go to…
  const go = document.createElement('button');
  go.type = 'button';
  go.className = 'nav-goto nav-app-hide';
  go.title = 'Find any page — ' + (_navIsMac() ? '⌘K' : 'Ctrl+K') + ' or /';
  go.appendChild(ICON.el('magnifying-glass'));
  const goLab = document.createElement('span');
  goLab.className = 'nav-label';
  goLab.textContent = 'Go to…';
  go.appendChild(goLab);
  const kbd = document.createElement('kbd');
  kbd.className = 'nav-kbd';
  kbd.textContent = _navIsMac() ? '⌘K' : 'Ctrl K';
  go.appendChild(kbd);
  go.addEventListener('click', (e) => { e.stopPropagation(); _navOpenPalette({ mode: 'go' }); });
  nav.appendChild(go);

  // Chip row — filled below (sync for personal, async for workflow).
  const row = document.createElement('div');
  row.className = 'nav-chips nav-app-hide';
  row.setAttribute('role', 'list');
  nav.appendChild(row);

  // Workflows ▾
  const wfMenu = _navBuildWorkflowsMenu(wfState);
  nav.appendChild(wfMenu);

  // ⊟ Split — on the split shell itself the pane pickers replace it (V3.632).
  if (onSplit) {
    _splitBuildPaneControls(nav);
  } else {
    const split = document.createElement('a');
    split.className = 'nav-iconbtn nav-split-link nav-app-hide';
    split.href = wfState ? _wfDecorateHref('/rm/pages/split-view.html', wfState.id) : '/rm/pages/split-view.html';
    split.title = 'Split view — two pages side by side';
    split.appendChild(ICON.el('view-columns'));
    nav.appendChild(split);
  }

  // Close any open dropdown on an outside click (installed once).
  if (!window.__navOutsideClickInstalled) {
    window.__navOutsideClickInstalled = true;
    document.addEventListener('click', () => {
      document.querySelectorAll('.nav-dropdown.open').forEach(d => d.classList.remove('open'));
    });
  }

  document.body.prepend(nav);

  // Carry over chrome other scripts injected into the previous bar.
  if (_navDetachedChrome && _navDetachedChrome.length) {
    _navDetachedChrome.forEach(el => nav.appendChild(el));
    _navDetachedChrome = null;
  }

  applyNavGates();

  if (wfState) _navRenderWorkflowChips(nav, row, wfState);
  else _navRenderPersonalChips(nav, row);

  _navFillWorkflowsMenu(wfMenu, wfState);
  if (onSplit) _splitFillPaneControls(nav);
  if (!onShell) _navObserveRow(row);
  _navInstallShortcuts();
  _navRecordVisit();
  _navSchedulePalettePrefetch();
  _navInitPagePopouts(wfState);
}

/* ── V3.810 — quick contexts: Chat (left) and Tasks (right) on EVERY page ──
 *
 * The shells (workflow-shell.html, split-view.html) have had the shared
 * ShellPopouts overlays since V3.85/V3.89. Alex: "i still want chat and
 * tasks to be on the sides of the page as quick contexts" — so ordinary
 * pages get the same module in PAGE MODE: fixed under the bar, closed by
 * default (a pill at each screen edge, mid-height), state in localStorage
 * only under its own key, and the side that would show the page you are
 * already on is hidden. Not mounted: in the phone app (its tab bar owns
 * chat/tasks), inside any iframe (renderNav already returned for embeds —
 * and a popout's own iframe is one, so this is also what stops recursion),
 * on the two shells (they init themselves), on phone/tablet widths, for
 * signed-out users and guests (the panes would just show sign-in gates).
 * Loads /rm/js/shell-popouts.js + /rm/css/workflow-shell.css on demand. */
const NAV_POPOUT_SKIP_PATHS = /\/(workflow-shell|split-view|app-shell|library-mobile[a-z-]*)\.html$/;

function _navIsAppRuntime() {
  try {
    if (window.Capacitor && typeof Capacitor.isNativePlatform === 'function' && Capacitor.isNativePlatform()) return true;
    if (sessionStorage.getItem('ourlab-shell-preview') === '1' || /[?&]mobileShell=1/.test(location.search)) return true;
    if (document.body && document.body.classList.contains('ourlab-app')) return true;
    if (window.parent && window.parent !== window && window.parent.document
        && window.parent.document.body && window.parent.document.body.getAttribute('data-app-shell') === '1') return true;
  } catch (e) { /* cross-origin parent — not the app shell */ }
  return false;
}

let _navPopoutsLoading = null;
function _navLoadPopouts() {
  if (window.ShellPopouts) return Promise.resolve(window.ShellPopouts);
  if (_navPopoutsLoading) return _navPopoutsLoading;
  if (!document.querySelector('link[href="/rm/css/workflow-shell.css"]')) {
    const link = document.createElement('link');
    link.rel = 'stylesheet';
    link.href = '/rm/css/workflow-shell.css';
    document.head.appendChild(link);
  }
  _navPopoutsLoading = new Promise((resolve, reject) => {
    const s = document.createElement('script');
    s.src = '/rm/js/shell-popouts.js';
    s.async = true;
    s.onload = () => window.ShellPopouts ? resolve(window.ShellPopouts) : reject(new Error('popouts missing'));
    s.onerror = () => { _navPopoutsLoading = null; reject(new Error('popouts failed to load')); };
    document.head.appendChild(s);
  });
  return _navPopoutsLoading;
}

async function _navInitPagePopouts(wfState) {
  if (document.getElementById('shell-popout-left')) return;        // a shell, or already mounted
  if (NAV_POPOUT_SKIP_PATHS.test(location.pathname)) return;
  if (_navIsAppRuntime()) return;
  if (window.matchMedia && window.matchMedia('(max-width: 1024px)').matches) return;
  if (typeof firebridge === 'undefined') return;
  try { if (firebridge.whenAuthResolved) await firebridge.whenAuthResolved(); } catch (e) { return; }
  const u = firebridge.getUser && firebridge.getUser();
  if (!u) return;
  if (firebridge.isLabMember && !firebridge.isLabMember()) return;
  if (firebridge.loadAccessGrant) { try { await firebridge.loadAccessGrant(); } catch (e) { /* ignore */ } }
  if (document.getElementById('shell-popout-left')) return;        // raced with a shell's own init
  let P;
  try { P = await _navLoadPopouts(); } catch (e) { return; }
  if (document.getElementById('shell-popout-left')) return;
  const pageMap = _wfBuildPageMap();
  const canAccess = _navCanAccessFn();
  const chipIds = Array.from(document.querySelectorAll('.top-nav .nav-chip[data-page-id]')).map(c => c.dataset.pageId);
  P.init({
    container: document.body,
    pageMode: true,
    urlState: false,
    stateKey: 'mcgheelab.pagePopout.state',
    hideFor: _navCurrentPageId(pageMap),
    // The picker's "This workflow" group: the active workflow's chips, else
    // the user's own chips (pins + recents) — the pages they actually use.
    workflowPageIds: chipIds,
    canAccessPage: (id) => { const p = pageMap.get(id); return !!p && canAccess(id); },
    defaults: { left: 'chat', right: 'tasks' },
  });
}

/* ── Chips ── */

function _navMakeChip(p, o) {
  o = o || {};
  const a = document.createElement('a');
  a.className = 'nav-chip' + (o.active ? ' active' : '') + (o.pinned ? ' nav-chip--pinned' : '');
  a.href = o.href || p.href;
  a.dataset.pageId = p.id;
  if (p.gate) a.dataset.gate = p.gate;
  a.setAttribute('role', 'listitem');
  a.appendChild(ICON.el(p.icon || 'document-text'));
  const lab = document.createElement('span');
  lab.className = 'nav-label';
  lab.textContent = p.label;
  a.appendChild(lab);
  const desc = NAV_PAGE_DESCRIPTIONS[p.id];
  a.title = (p.group || '') + ' · ' + p.label + (desc ? ' — ' + desc : '');
  if (o.pinnable) {
    const pin = document.createElement('button');
    pin.type = 'button';
    pin.className = 'nav-chip-pin';
    pin.tabIndex = -1;
    ICON.label(pin, 'star', '', { variant: o.pinned ? 'solid' : 'outline' });
    pin.title = o.pinned ? 'Unpin ' + p.label : 'Pin ' + p.label + ' to this bar';
    pin.addEventListener('click', (e) => { e.preventDefault(); e.stopPropagation(); NavPins.toggle(p.id); });
    pin.addEventListener('mousedown', (e) => e.stopPropagation());
    a.appendChild(pin);
  }
  return a;
}

/* Which pages are the personal chips: pins (user order) then recents by
 * frecency, the current page guaranteed a seat. Home and Split are never
 * chips — the brand is Home, the ⊟ button is Split. */
function _navPersonalChipIds(pageMap) {
  const skip = id => !pageMap.has(id) || id === 'dashboard' || id === 'split-view';
  const cur = _navCurrentPageId(pageMap);
  const pins = NavPins.effective().filter(id => !skip(id));
  const seen = new Set(pins);
  const recents = NavRecents.list().map(r => r.id).filter(id => !skip(id) && !seen.has(id));
  recents.forEach(id => seen.add(id));
  let ids = pins.concat(recents);
  if (cur && !skip(cur) && !seen.has(cur)) ids.push(cur);
  if (ids.length > NAV_MAX_CHIPS) {
    const keep = ids.slice(0, NAV_MAX_CHIPS);
    if (cur && keep.indexOf(cur) < 0 && ids.indexOf(cur) >= 0) keep[NAV_MAX_CHIPS - 1] = cur;
    ids = keep;
  }
  return { ids: ids, cur: cur, pinned: new Set(pins) };
}

function _navRenderPersonalChips(nav, row) {
  const pageMap = _wfBuildPageMap();
  const sel = _navPersonalChipIds(pageMap);
  row.innerHTML = '';
  sel.ids.forEach(id => {
    const p = pageMap.get(id);
    row.appendChild(_navMakeChip(p, { active: id === sel.cur, pinned: sel.pinned.has(id), pinnable: true }));
  });
  const add = document.createElement('button');
  add.type = 'button';
  add.className = 'nav-chip nav-chip-add';
  ICON.label(add, 'plus');
  add.title = 'Find a page — star it there to pin it here';
  add.addEventListener('click', (e) => { e.stopPropagation(); _navOpenPalette({ mode: 'go', hint: 'pin' }); });
  row.appendChild(add);
  _navFitChips(row);
  _navRefinePersonalChips(nav, row);
}

/* After auth: drop chips the signed-in user can't open, then pull cloud
 * pins and (first run) seed recents — each of which may re-render. */
async function _navRefinePersonalChips(nav, row) {
  if (typeof firebridge === 'undefined') return;
  try { if (firebridge.whenAuthResolved) await firebridge.whenAuthResolved(); } catch (e) { /* ignore */ }
  if (firebridge.loadAccessGrant) { try { await firebridge.loadAccessGrant(); } catch (e) { /* ignore */ } }
  if (!document.body.contains(row)) return;
  const u = firebridge.getUser && firebridge.getUser();
  if (u) {
    const pageMap = _wfBuildPageMap();
    const isAdmin = firebridge.isAdmin && firebridge.isAdmin();
    const isLabMember = firebridge.isLabMember && firebridge.isLabMember();
    row.querySelectorAll('.nav-chip[data-page-id]').forEach(chip => {
      const p = pageMap.get(chip.dataset.pageId);
      if (p && !_splitPageAllowed(p, isAdmin, isLabMember)) chip.remove();
    });
  }
  applyNavGates();
  _navFitChips(row);
  NavPins.loadCloud();
  _navMaybeSeedRecents();
}

window.addEventListener('rm:nav:pins-change', () => {
  if (_wfReadState()) return;                      // workflow chips don't show pins
  const nav = document.querySelector('nav.top-nav');
  const row = nav && nav.querySelector('.nav-chips');
  if (row) _navRenderPersonalChips(nav, row);
});

let _navSeedAttempted = false;
async function _navMaybeSeedRecents() {
  if (_navSeedAttempted) return;
  _navSeedAttempted = true;
  if (NavRecents.isSeeded() || !NavRecents.isEmpty()) return;
  if (typeof firebridge === 'undefined' || !firebridge.db) return;
  const u = firebridge.getUser && firebridge.getUser();
  if (!u) return;
  if (firebridge.isLabMember && !firebridge.isLabMember()) return;
  try {
    const since = new Date(Date.now() - 30 * 86400000).toISOString().slice(0, 10);
    // Single-field range → no composite index; `source` is filtered here.
    const snap = await firebridge.db()
      .collection('trackerEntries').doc(u.uid).collection('entries')
      .where('date', '>=', since).get();
    const pageMap = _wfBuildPageMap();
    const agg = {};
    snap.forEach(d => {
      const x = d.data() || {};
      if (x.source !== 'rm-page-time') return;
      const slug = x.source_ref && x.source_ref.id;
      if (!slug || !pageMap.has(slug)) return;
      const a = agg[slug] || (agg[slug] = { id: slug, weight: 0, lastMs: 0 });
      a.weight += 1;
      const t = Date.parse(String(x.date) + 'T12:00:00');
      if (t > a.lastMs) a.lastMs = t;
    });
    const added = NavRecents.seed(Object.keys(agg).map(k => agg[k]));
    if (added && !_wfReadState()) {
      const nav = document.querySelector('nav.top-nav');
      const row = nav && nav.querySelector('.nav-chips');
      if (row) _navRenderPersonalChips(nav, row);
    }
  } catch (err) {
    console.warn('[nav] recents seed skipped:', err && err.message);
    NavRecents.seed([]);
  }
}

/* Hide chips that don't fit the row, last first, never the active one.
 * Hidden chips stay reachable through the palette. Also numbers the
 * visible chips for ⌥1–⌥9. */
function _navFitChips(row) {
  if (!row || !row.isConnected) return;
  const chips = Array.from(row.querySelectorAll('.nav-chip[data-page-id]'));
  chips.forEach(c => c.classList.remove('nav-chip--overflow'));
  const gap = 6;
  const fixed = Array.from(row.children)
    .filter(c => chips.indexOf(c) < 0)
    .reduce((w, c) => w + (c.offsetWidth || 0) + gap, 0);
  const avail = row.clientWidth - fixed;
  const widths = chips.map(c => (c.style.display === 'none' ? 0 : c.offsetWidth + gap));
  let total = widths.reduce((a, b) => a + b, 0);
  for (let i = chips.length - 1; i >= 0 && total > avail; i--) {
    if (chips[i].classList.contains('active')) continue;
    if (!widths[i]) continue;
    chips[i].classList.add('nav-chip--overflow');
    total -= widths[i];
  }
  let n = 0;
  chips.forEach(c => {
    const shown = !c.classList.contains('nav-chip--overflow') && c.style.display !== 'none';
    if (!shown) { c.removeAttribute('data-alt'); return; }
    n++;
    if (n <= 9) c.dataset.alt = String(n); else c.removeAttribute('data-alt');
  });
  row.dataset.overflow = String(chips.filter(c => c.classList.contains('nav-chip--overflow')).length);
}

function _navObserveRow(row) {
  if (!window.ResizeObserver || row.__navRO) return;
  row.__navRO = new ResizeObserver(() => _navFitChips(row));
  row.__navRO.observe(row);
}

/* Workflow chips — the strip's pills, now in the same row. */
let _navLastShellActive = null;

async function _navRenderWorkflowChips(nav, row, state) {
  const onSplit = _navIsSplitHost();
  const onShell = _navIsShellHost();
  row.innerHTML = '<span class="nav-chip nav-chip--ghost">Loading workflow…</span>';

  if (typeof firebridge !== 'undefined') {
    try { if (firebridge.whenAuthResolved) await firebridge.whenAuthResolved(); } catch (e) { /* ignore */ }
    if (firebridge.loadAccessGrant) { try { await firebridge.loadAccessGrant(); } catch (e) { /* ignore */ } }
  }
  if (!document.body.contains(row)) return;

  const wf = await _wfFetchWorkflow(state);
  if (!document.body.contains(row)) return;
  // V3.812 — your own version of a default workflow: pull the saved
  // add/remove/order overlay BEFORE computing the chip list (no flash of the
  // lab default), once per session state.
  await _navHydrateWorkflowPrefs(state);
  if (!document.body.contains(row)) return;
  row.innerHTML = '';
  if (!wf) {
    row.innerHTML = '<span class="nav-chip nav-chip--ghost">Workflow not found</span>';
    _navSetWorkflowLabel(nav, null);
    return;
  }
  _navSetWorkflowLabel(nav, wf);

  const pageMap = _wfBuildPageMap();
  const ids = _wfEffectivePageIds(wf.pageIds || [], state);
  const canAccess = _navCanAccessFn();

  let splitState = null;
  if (onSplit) splitState = _splitReadState();
  const shellActiveId = onShell ? (new URLSearchParams(location.search).get('active') || '') : null;
  if (onShell && shellActiveId && shellActiveId !== _navLastShellActive) {
    // A chip switch inside the shell is a visit too — otherwise someone
    // who lives in workflows would never build up recents.
    _navLastShellActive = shellActiveId;
    if (pageMap.has(shellActiveId)) NavRecents.record(shellActiveId);
  }

  // V3.73 — which chip is the current page (most specific match wins), so
  // its full URL (paper id, tab…) is remembered for the next click.
  const currentPath = location.pathname;
  const currentTab = new URLSearchParams(location.search).get('tab') || '';
  let activeChipId = null, genericFallback = null;
  ids.forEach(id => {
    const p = pageMap.get(id);
    if (!p) return;
    const u = new URL(p.href, location.origin);
    if (u.pathname !== currentPath) return;
    const pTab = new URLSearchParams(u.search).get('tab') || '';
    if (pTab === currentTab) activeChipId = id;
    else if (!pTab && !genericFallback) genericFallback = id;
  });
  if (!activeChipId) activeChipId = genericFallback;
  if (activeChipId) {
    state.pageState = state.pageState || {};
    state.pageState[activeChipId] = location.pathname + location.search + location.hash;
    _wfWriteState(state);
  }

  const accessibleIds = ids.filter(id => pageMap.get(id) && canAccess(id));
  const splitLink = nav.querySelector('.nav-split-link');
  if (splitLink && accessibleIds.length) {
    splitLink.href = _navWorkflowSplitHref(state, pageMap, accessibleIds, activeChipId);
  }

  let any = false;
  ids.forEach(id => {
    const p = pageMap.get(id);
    if (!p || !canAccess(id)) return;
    any = true;
    const remembered = (state.pageState && state.pageState[id]) || null;
    const baseHref = remembered || p.href;
    const chip = _navMakeChip(p, { href: _wfDecorateHref(baseHref, state.id) });
    chip.draggable = true;
    chip.title = (p.group || '') + ' · ' + p.label
      + (remembered && remembered !== p.href ? ' · resumes where you left off' : '')
      + ' · drag to reorder';

    let openSide = null;
    if (onSplit && splitState) {
      if (_splitMatch(baseHref, splitState.left)) openSide = 'left';
      else if (_splitMatch(baseHref, splitState.right)) openSide = 'right';
      if (openSide) {
        chip.classList.add('nav-chip--open', 'nav-chip--open-' + openSide);
        if (openSide === splitState.active) chip.classList.add('nav-chip--active-split');
        chip.title = (p.group || '') + ' · ' + p.label + ' · open in ' + openSide
          + (openSide === splitState.active ? ' (active — click another chip to swap it)' : ' — click to make active');
      }
    }
    if (!onSplit && !onShell) {
      const target = new URL(p.href, location.origin);
      if (target.pathname === currentPath
          && (target.search === location.search || target.search === '')) chip.classList.add('active');
    }
    if (onShell) {
      if (id === shellActiveId) chip.classList.add('active');
      chip.addEventListener('click', (e) => {
        e.preventDefault();
        if (id === shellActiveId) return;
        // The listener in workflow-shell.js owns the URL update (V3.83).
        window.dispatchEvent(new CustomEvent('rm:shell:set-active', { detail: { pageId: id } }));
        _wfRefreshStrip();
      });
    }
    if (onSplit) {
      chip.addEventListener('click', (e) => {
        e.preventDefault();
        if (openSide && openSide === splitState.active) return;
        if (openSide) {
          window.dispatchEvent(new CustomEvent('rm:split:set-active', { detail: { side: openSide } }));
        } else {
          window.dispatchEvent(new CustomEvent('rm:split:swap', { detail: { side: splitState.active, href: baseHref } }));
        }
      });
    }
    chip.addEventListener('dragstart', _wfChipDragStart);
    chip.addEventListener('dragend',   _wfChipDragEnd);
    chip.addEventListener('dragover',  _wfChipDragOver);
    chip.addEventListener('dragleave', _wfChipDragLeave);
    chip.addEventListener('drop',      _wfChipDrop);
    row.appendChild(chip);

    const rm = document.createElement('button');
    rm.className = 'nav-chip-remove';
    rm.type = 'button';
    rm.tabIndex = -1;
    ICON.label(rm, 'x-mark');
    rm.title = 'Remove ' + p.label + ' from this workflow';
    rm.draggable = false;
    rm.addEventListener('click', (e) => { e.preventDefault(); e.stopPropagation(); _wfRemovePage(id); _wfRefreshStrip(); });
    rm.addEventListener('mousedown', (e) => e.stopPropagation());
    rm.addEventListener('dragstart', (e) => e.preventDefault());
    chip.appendChild(rm);
  });
  if (!any) {
    row.innerHTML = '<span class="nav-chip nav-chip--ghost">No accessible pages in this workflow</span>';
  }

  const add = document.createElement('button');
  add.type = 'button';
  add.className = 'nav-chip nav-chip-add';
  ICON.label(add, 'plus');
  add.title = 'Add a page to this workflow';
  add.addEventListener('click', (e) => { e.stopPropagation(); _navAddPageToWorkflow(state, wf); });
  row.appendChild(add);

  // V3.812 — no Save chip: edits persist by themselves (a per-user overlay
  // for a default workflow, the doc itself for a custom one). The Workflows ▾
  // menu shows "customized" + "Reset to lab default", and still offers
  // "Save as my workflow…" for anyone who wants a separate copy.
  _navMarkCustomized(nav, _navIsCustomized(state));
  const wfMenu = nav.querySelector('.nav-dropdown-wf');
  if (wfMenu) _navFillWorkflowsMenu(wfMenu, state);
  _navFitChips(row);
  _navObserveRow(row);
}

/* ── V3.812 — your own version of a default workflow ──
 *
 * Alex: "i want to be able to customize my workflow pages without having to
 * make a custom type". The session state already carries addedPageIds /
 * removedPageIds / orderOverride on top of the lab's pageIds; it used to
 * live only in sessionStorage until "Save as mine" forked a custom
 * workflow. Now that overlay is persisted per user and per default workflow:
 *   userData/{uid}/workflowPrefs/{workflowId} = { addedPageIds, removedPageIds, orderOverride }
 * (blanket owner rule — no rules change), written 400ms after each edit
 * and read into a fresh session state the first time the bar renders that
 * workflow. The admin's later changes still flow through: effective =
 * lab pageIds ∪ added − removed, in the override order with new pages at
 * the end (_wfEffectivePageIds). Edits to a custom workflow are folded
 * into its own doc the same way. */
const NAV_PREFS_DEBOUNCE_MS = 400;
let _navPrefsTimer = null;

function _navIsCustomized(state) {
  return !!(state && ((state.addedPageIds || []).length || (state.removedPageIds || []).length || state.orderOverride));
}
function _navPrefsRef(uid, wfId) {
  return firebridge.db().collection('userData').doc(uid).collection('workflowPrefs').doc(wfId);
}
async function _navHydrateWorkflowPrefs(state) {
  if (!state || state.kind !== 'default' || state.prefsLoaded) return state;
  if (typeof firebridge === 'undefined' || !firebridge.db) return state;
  const u = firebridge.getUser && firebridge.getUser();
  if (!u) return state;
  try {
    const snap = await _navPrefsRef(u.uid, state.id).get();
    if (snap.exists && !_navIsCustomized(state)) {       // edits made in this tab win over the saved overlay
      const d = snap.data() || {};
      state.addedPageIds   = Array.isArray(d.addedPageIds)   ? d.addedPageIds   : [];
      state.removedPageIds = Array.isArray(d.removedPageIds) ? d.removedPageIds : [];
      state.orderOverride  = Array.isArray(d.orderOverride)  ? d.orderOverride  : null;
    }
  } catch (err) {
    console.warn('[nav] workflow prefs read failed:', err && err.message);
  }
  state.prefsLoaded = true;
  _wfWriteState(state);
  return state;
}
function _navQueueWorkflowPrefsSave() {
  if (typeof firebridge === 'undefined' || !firebridge.db) return;
  clearTimeout(_navPrefsTimer);
  _navPrefsTimer = setTimeout(_navSaveWorkflowPrefs, NAV_PREFS_DEBOUNCE_MS);
}
async function _navSaveWorkflowPrefs() {
  const s = _wfReadState();
  if (!s) return;
  const u = firebridge.getUser && firebridge.getUser();
  if (!u) return;
  try {
    if (s.kind === 'custom') {
      // The custom doc is the user's own — fold the edits into it (what the
      // old Save button did), then clear the session overlay.
      const wf = await _wfFetchWorkflow(s);
      if (!wf) return;
      const effective = _wfEffectivePageIds(wf.pageIds || [], s);
      if (JSON.stringify(effective) !== JSON.stringify(wf.pageIds || [])) {
        await firebridge.db().collection('userData').doc(u.uid)
          .collection('customWorkflows').doc(s.id)
          .set({ pageIds: effective, updatedAt: new Date() }, { merge: true });
        _wfCustomCache = null;
      }
      const cur = _wfReadState();
      if (cur && cur.id === s.id) { cur.addedPageIds = []; cur.removedPageIds = []; cur.orderOverride = null; _wfWriteState(cur); }
      return;
    }
    const ref = _navPrefsRef(u.uid, s.id);
    if (!_navIsCustomized(s)) {
      await ref.delete();
    } else {
      await ref.set({
        workflowId: s.id,
        addedPageIds: s.addedPageIds || [],
        removedPageIds: s.removedPageIds || [],
        orderOverride: s.orderOverride || null,
        updatedAt: new Date(),
      });
    }
    const nav = document.querySelector('nav.top-nav');
    if (nav) _navMarkCustomized(nav, _navIsCustomized(s));
  } catch (err) {
    console.warn('[nav] workflow prefs save failed:', err && err.message);
    if (window.toast && toast.warn) toast.warn('Could not save your workflow changes — they stay in this tab only.');
  }
}
function _navResetWorkflowPrefs() {
  const s = _wfReadState();
  if (!s) return;
  s.addedPageIds = []; s.removedPageIds = []; s.orderOverride = null; s.prefsLoaded = true;
  _wfWriteState(s);
  _navQueueWorkflowPrefsSave();
  _wfRefreshStrip();
  if (window.toast && toast.info) toast.info('Back to the lab default for this workflow.');
}
function _navMarkCustomized(nav, on) {
  const wrap = nav && nav.querySelector('.nav-dropdown-wf');
  if (wrap) wrap.classList.toggle('nav-dropdown-wf--customized', !!on);
}

/* ⊟ from inside a workflow opens TWO workflow pages: left = the current
 * page with its state, right = the next workflow page (V3.73/V3.88). */
function _navWorkflowSplitHref(state, pageMap, accessibleIds, activeChipId) {
  let leftURL;
  if (_navIsShellHost()) {
    const activeFromUrl = new URLSearchParams(location.search).get('active') || activeChipId;
    const activeP = activeFromUrl && pageMap.get(activeFromUrl);
    const remembered = state.pageState && state.pageState[activeFromUrl];
    leftURL = remembered || (activeP && activeP.href) || '/rm/index.html';
  } else {
    leftURL = location.pathname + location.search + location.hash;
  }
  let rightId = null;
  if (activeChipId) {
    const idx = accessibleIds.indexOf(activeChipId);
    if (idx >= 0) rightId = accessibleIds[(idx + 1) % accessibleIds.length];
  }
  if (!rightId) rightId = accessibleIds[0];
  if (rightId === activeChipId && accessibleIds.length > 1) rightId = accessibleIds[1];
  const rightP = pageMap.get(rightId);
  const rightRemembered = state.pageState && state.pageState[rightId];
  const rightURL = rightRemembered || (rightP && rightP.href) || '/rm/index.html';
  return '/rm/pages/split-view.html?' + new URLSearchParams({
    workflow: state.id, left: leftURL, right: rightURL, ratio: '0.5',
  }).toString();
}

function _navAddPageToWorkflow(state, wf) {
  _navLoadPalette()
    .then(P => P.open(Object.assign(_navPaletteContext(), { mode: 'add' })))
    .catch(() => _wfOpenAddPageModal(state, wf));
}

/* ── Workflows ▾ ── */

function _navBuildWorkflowsMenu(wfState) {
  const wrap = document.createElement('div');
  wrap.className = 'nav-dropdown nav-dropdown-wf nav-app-hide' + (wfState ? ' nav-dropdown-wf--active' : '');
  const trigger = document.createElement('button');
  trigger.type = 'button';
  trigger.className = 'nav-dropdown-trigger nav-wf-trigger';
  const ic = document.createElement('span');
  ic.className = 'nav-wf-trigger-icon';
  ic.appendChild(ICON.el('rectangle-stack'));
  trigger.appendChild(ic);
  const lab = document.createElement('span');
  lab.className = 'nav-label';
  lab.textContent = wfState ? 'Workflow' : 'Workflows';
  trigger.appendChild(lab);
  trigger.title = wfState
    ? 'This workflow — switch, add a page, save, or leave'
    : 'Workflows — a bundle of pages for one kind of work';
  const menu = document.createElement('div');
  menu.className = 'dropdown-menu nav-wf-menu';
  menu.innerHTML = '<div class="nav-wf-menu-loading">Loading…</div>';
  trigger.addEventListener('click', (e) => {
    e.stopPropagation();
    const wasOpen = wrap.classList.contains('open');
    document.querySelectorAll('.nav-dropdown.open').forEach(d => d.classList.remove('open'));
    if (!wasOpen) wrap.classList.add('open');
  });
  menu.addEventListener('click', (e) => {
    // Links navigate; buttons act — either way the menu closes.
    if (e.target.closest('a, button')) wrap.classList.remove('open');
  });
  wrap.appendChild(trigger);
  wrap.appendChild(menu);
  return wrap;
}

function _navSetWorkflowLabel(nav, wf) {
  const trig = nav.querySelector('.nav-wf-trigger');
  if (!trig) return;
  const ic = trig.querySelector('.nav-wf-trigger-icon');
  const lab = trig.querySelector('.nav-label');
  if (wf) {
    if (ic) ic.innerHTML = ICON.render(wf.icon || 'rectangle-stack');
    if (lab) lab.textContent = wf.label || wf.id;
    trig.title = 'Workflow: ' + (wf.label || wf.id) + ' — switch, add a page, save, or leave';
  } else {
    if (ic) ic.innerHTML = ICON.svg('rectangle-stack');
    if (lab) lab.textContent = 'Workflow';
  }
}

function _navMenuHeader(text) {
  const h = document.createElement('div');
  h.className = 'nav-wf-menu-header';
  h.textContent = text;
  return h;
}
function _navMenuDivider() {
  const d = document.createElement('div');
  d.className = 'dropdown-divider';
  return d;
}
function _navMenuAction(icon, text, onClick, extraClass) {
  const b = document.createElement('button');
  b.type = 'button';
  b.className = 'nav-wf-item nav-wf-action' + (extraClass ? ' ' + extraClass : '');
  b.innerHTML = '<span class="nav-wf-item-icon">' + ICON.svg(icon) + '</span><span class="nav-wf-item-label">' + _navEsc(text) + '</span>';
  b.addEventListener('click', (e) => { e.preventDefault(); onClick(e); });
  return b;
}
function _navMenuLink(icon, text, href, extraClass) {
  const a = document.createElement('a');
  a.className = 'nav-wf-item' + (extraClass ? ' ' + extraClass : '');
  a.href = href;
  a.innerHTML = '<span class="nav-wf-item-icon">' + ICON.svg(icon) + '</span><span class="nav-wf-item-label">' + _navEsc(text) + '</span>';
  return a;
}

async function _navFillWorkflowsMenu(wrap, wfState) {
  const menu = wrap.querySelector('.nav-wf-menu');
  if (!menu) return;
  if (typeof firebridge !== 'undefined') {
    try { if (firebridge.whenAuthResolved) await firebridge.whenAuthResolved(); } catch (e) { /* ignore */ }
    if (firebridge.loadAccessGrant) { try { await firebridge.loadAccessGrant(); } catch (e) { /* ignore */ } }
  }
  if (!document.body.contains(wrap)) return;
  const u = (typeof firebridge !== 'undefined') && firebridge.getUser && firebridge.getUser();
  const defaults = await _navLoadDefaultWorkflows();
  const customs = u ? await _navLoadCustomWorkflows() : [];
  if (!document.body.contains(wrap)) return;

  const pageMap = _wfBuildPageMap();
  const canAccess = _navCanAccessFn();
  const accessibleCount = wf => (wf.pageIds || []).filter(id => pageMap.get(id) && canAccess(id)).length;

  menu.innerHTML = '';
  if (wfState) {
    const active = defaults.find(w => w.id === wfState.id) || customs.find(w => w.id === wfState.id);
    const live = _wfReadState() || wfState;                 // hydration may have landed since the bar was built
    const customized = _navIsCustomized(live);
    menu.appendChild(_navMenuHeader('Active · ' + ((active && active.label) || wfState.id) + (customized ? ' · customized for you' : '')));
    menu.appendChild(_navMenuAction('x-mark', 'Leave workflow', () => _navLeaveWorkflow()));
    menu.appendChild(_navMenuAction('plus', 'Add a page…', () => _navAddPageToWorkflow(live, active)));
    if (live.kind === 'default' && customized) {
      menu.appendChild(_navMenuAction('arrow-uturn-left', 'Reset to lab default', () => _navResetWorkflowPrefs()));
    }
    if (active && live.kind === 'default') {
      menu.appendChild(_navMenuAction('bookmark', 'Save as my workflow…', () => _wfSaveCurrent(live, active)));
    }
    if (!_navIsSplitHost()) {
      const splitHref = (document.querySelector('.nav-split-link') || {}).href || '/rm/pages/split-view.html';
      menu.appendChild(_navMenuLink('view-columns', 'Open in split view', splitHref));
    }
    menu.appendChild(_navMenuDivider());
  }

  // V3.811 — `enabled:false` keeps a workflow in the doc but hides it (admin drafts).
  const visibleDefaults = defaults.filter(w => w.enabled !== false && accessibleCount(w) > 0);
  if (visibleDefaults.length) {
    menu.appendChild(_navMenuHeader('Workflows'));
    visibleDefaults.forEach(w => menu.appendChild(_navWfEntry(w, 'default', wfState, pageMap, canAccess)));
  }
  if (customs.length) {
    menu.appendChild(_navMenuHeader('My workflows'));
    customs.forEach(w => menu.appendChild(_navWfEntry(w, 'custom', wfState, pageMap, canAccess)));
  }
  if (!visibleDefaults.length && !customs.length) {
    const empty = document.createElement('div');
    empty.className = 'nav-wf-menu-loading';
    empty.textContent = u ? 'No workflows you can open yet.' : 'Sign in to use workflows.';
    menu.appendChild(empty);
  }
  menu.appendChild(_navMenuDivider());
  menu.appendChild(_navMenuLink('plus', 'New workflow…', '/rm/index.html#new-workflow', 'nav-wf-item--muted'));
  menu.appendChild(_navMenuLink('squares-2x2', 'All workflows on Home', '/rm/index.html#workflows', 'nav-wf-item--muted'));
  if (typeof firebridge !== 'undefined' && firebridge.isAdmin && firebridge.isAdmin()) {
    menu.appendChild(_navMenuLink('cog-6-tooth', 'Edit default workflows', '/rm/pages/admin-workflows.html', 'nav-wf-item--muted'));
  }
}

function _navWfEntry(w, kind, wfState, pageMap, canAccess) {
  const landing = _navWorkflowLanding(w, pageMap, canAccess);
  const n = (w.pageIds || []).filter(id => pageMap.get(id) && canAccess(id)).length;
  const a = document.createElement('a');
  const isActive = !!(wfState && wfState.id === w.id);
  a.className = 'nav-wf-item' + (isActive ? ' active' : '');
  a.href = '/rm/pages/workflow-shell.html?workflow=' + encodeURIComponent(w.id)
         + (landing ? '&active=' + encodeURIComponent(landing.id) : '');
  a.innerHTML =
    '<span class="nav-wf-item-icon">' + ICON.render(w.icon || (kind === 'custom' ? 'star' : 'rectangle-stack')) + '</span>'
    + '<span class="nav-wf-item-label">' + _navEsc(w.label || w.id) + '</span>'
    + '<span class="nav-wf-item-count">' + n + ' page' + (n === 1 ? '' : 's') + '</span>';
  a.title = (w.description || w.label || w.id);
  a.addEventListener('click', (e) => {
    if (isActive) { e.preventDefault(); return; }
    _navEnterWorkflow(w, kind, e);
  });
  return a;
}

/* Enter a workflow: inside the shell switch in place (popouts and loaded
 * iframes survive — V3.89); elsewhere navigate to the shell. */
function _navEnterWorkflow(w, kind, e) {
  if (_navIsShellHost()) {
    if (e) e.preventDefault();
    window.dispatchEvent(new CustomEvent('rm:shell:switch-workflow', { detail: { workflowId: w.id, kind: kind } }));
    return;
  }
  // Write the kind up front so the shell reads a custom workflow as custom.
  _wfWriteState({ id: w.id, kind: kind || 'default', addedPageIds: [], removedPageIds: [], orderOverride: null, pageState: {} });
  if (e) return;      // the <a> navigates itself
  const pageMap = _wfBuildPageMap();
  const landing = _navWorkflowLanding(w, pageMap, _navCanAccessFn());
  location.href = '/rm/pages/workflow-shell.html?workflow=' + encodeURIComponent(w.id)
    + (landing ? '&active=' + encodeURIComponent(landing.id) : '');
}

/* Leave: in the shell, go to the active page's REAL url (where the strip
 * used to reload the shell); on a normal page just redraw the bar. */
function _navLeaveWorkflow() {
  const state = _wfReadState();
  if (_navIsShellHost()) {
    const active = new URLSearchParams(location.search).get('active');
    const pageMap = _wfBuildPageMap();
    let target = '/rm/index.html';
    if (active) {
      target = (state && state.pageState && state.pageState[active])
            || (pageMap.get(active) || {}).href || target;
    }
    _wfClearState();
    location.href = target;
    return;
  }
  _wfClearState();
  _wfRefreshStrip();
}

/* ── Palette (lazy) ── */

let _navPaletteLoading = null;
function _navLoadPalette() {
  if (window.NavPalette) return Promise.resolve(window.NavPalette);
  if (_navPaletteLoading) return _navPaletteLoading;
  _navPaletteLoading = new Promise((resolve, reject) => {
    const s = document.createElement('script');
    s.src = '/rm/js/nav-palette.js';
    s.async = true;
    s.onload = () => window.NavPalette ? resolve(window.NavPalette) : reject(new Error('palette missing'));
    s.onerror = () => { _navPaletteLoading = null; reject(new Error('palette failed to load')); };
    document.head.appendChild(s);
  });
  return _navPaletteLoading;
}
function _navSchedulePalettePrefetch() {
  if (window.__navPalettePrefetched || window.Capacitor) return;
  window.__navPalettePrefetched = true;
  const run = () => { _navLoadPalette().catch(() => {}); };
  if ('requestIdleCallback' in window) requestIdleCallback(run, { timeout: 4000 });
  else setTimeout(run, 2500);
}

/* Everything the palette needs from this page, handed over as data +
 * callbacks so nav-palette.js stays DOM + search only. */
function _navPaletteContext() {
  const pageMap = _wfBuildPageMap();
  const state = _wfReadState();
  const fb = (typeof firebridge !== 'undefined') ? firebridge : null;
  const u = fb && fb.getUser && fb.getUser();
  const isAdmin = !!(fb && fb.isAdmin && fb.isAdmin());
  const isLabMember = !!(fb && fb.isLabMember && fb.isLabMember());
  const canAccess = _navCanAccessFn();
  const chipIds = Array.from(document.querySelectorAll('.top-nav .nav-chip[data-page-id]')).map(c => c.dataset.pageId);
  return {
    pageMap: pageMap,
    descriptions: NAV_PAGE_DESCRIPTIONS,
    currentPageId: _navCurrentPageId(pageMap),
    allowed: p => (!fb || !u) ? !p.gate : _splitPageAllowed(p, isAdmin, isLabMember),
    pins: NavPins,
    recents: NavRecents,
    workflowState: state,
    workflowPageIds: state ? chipIds : [],
    onShell: _navIsShellHost(),
    onSplit: _navIsSplitHost(),
    isMac: _navIsMac(),
    loadWorkflows: async () => {
      const defaults = (await _navLoadDefaultWorkflows())
        .filter(w => w.enabled !== false && (w.pageIds || []).some(id => pageMap.get(id) && canAccess(id)));
      const customs = u ? await _navLoadCustomWorkflows() : [];
      return { defaults: defaults, customs: customs };
    },
    navigate: (p, newTab) => _navGoTo(p, newTab),
    addToWorkflow: (id) => {
      _wfAddPage(id);
      if (_navIsShellHost()) window.dispatchEvent(new CustomEvent('rm:shell:set-active', { detail: { pageId: id } }));
      _wfRefreshStrip();
    },
    switchWorkflow: (w, kind) => _navEnterWorkflow(w, kind),
    leaveWorkflow: () => _navLeaveWorkflow(),
  };
}

function _navOpenPalette(opts) {
  _navLoadPalette()
    .then(P => P.open(Object.assign(_navPaletteContext(), opts || {})))
    .catch(() => { location.href = '/rm/index.html?view=all-pages'; });
}

/* Where "go to page" lands depends on the surface:
 *   shell  → stay in the shell: add the page to the workflow if needed,
 *            make it the active iframe (workflow-shell.js ensureFrame
 *            takes any registry page)
 *   split  → swap the ACTIVE pane (what the pane pickers do)
 *   else   → navigate; inside a workflow keep its context + remembered url */
function _navGoTo(p, newTab) {
  const state = _wfReadState();
  const href = state
    ? _wfDecorateHref((state.pageState && state.pageState[p.id]) || p.href, state.id)
    : p.href;
  if (newTab) { window.open(href, '_blank', 'noopener'); return; }
  if (_navIsShellHost() && state) {
    const chipIds = Array.from(document.querySelectorAll('.top-nav .nav-chip[data-page-id]')).map(c => c.dataset.pageId);
    if (chipIds.indexOf(p.id) < 0) _wfAddPage(p.id);
    window.dispatchEvent(new CustomEvent('rm:shell:set-active', { detail: { pageId: p.id } }));
    _wfRefreshStrip();
    return;
  }
  if (_navIsSplitHost()) {
    const s = _splitReadState();
    window.dispatchEvent(new CustomEvent('rm:split:swap', { detail: { side: s.active, href: p.href } }));
    return;
  }
  location.href = href;
}

/* ── Keyboard ── */

function _navIsEditable(el) {
  if (!el || el.nodeType !== 1) return false;
  const t = (el.tagName || '').toLowerCase();
  return t === 'input' || t === 'textarea' || t === 'select' || el.isContentEditable;
}
let _navShortcutsInstalled = false;
function _navInstallShortcuts() {
  if (_navShortcutsInstalled) return;
  _navShortcutsInstalled = true;
  document.addEventListener('keydown', (e) => {
    if (e.defaultPrevented) return;
    const k = e.key;
    if ((e.metaKey || e.ctrlKey) && !e.shiftKey && !e.altKey && (k === 'k' || k === 'K')) {
      e.preventDefault();
      _navOpenPalette({ mode: 'go' });
      return;
    }
    // ⌥1–⌥9: e.key is a symbol on macOS (⌥1 = ¡), so read the physical key.
    if (e.altKey && !e.metaKey && !e.ctrlKey && e.code && /^Digit[1-9]$/.test(e.code)) {
      const n = e.code.replace('Digit', '');
      const chip = document.querySelector('.top-nav .nav-chip[data-alt="' + n + '"]');
      if (chip) { e.preventDefault(); chip.click(); }
      return;
    }
    if (k === '/' && !e.metaKey && !e.ctrlKey && !e.altKey && !_navIsEditable(e.target)) {
      e.preventDefault();
      _navOpenPalette({ mode: 'go' });
    }
  });
}

/* ── Visits ── */

function _navRecordVisit() {
  if (_navIsShellHost() || _navIsSplitHost()) return;
  const pageMap = _wfBuildPageMap();
  const id = _navCurrentPageId(pageMap);
  if (!id || id === 'dashboard' || id === 'split-view') return;
  NavRecents.record(id);
}

/* ── V3.66 — Drag-to-reorder strip chips ──
 *
 * HTML5 drag-and-drop. Each workflow .nav-chip has draggable=true (V3.809). dragstart
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
  const currentOrder = Array.from(document.querySelectorAll('.top-nav .nav-chip[data-page-id]'))
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
  _navQueueWorkflowPrefsSave();      // V3.812 — persists per user
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
  _navQueueWorkflowPrefsSave();      // V3.812 — persists per user
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
  _navQueueWorkflowPrefsSave();      // V3.812 — persists per user
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
        icon: 'star',
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

/* ── V3.632 — split-view pane pickers ──
 *
 * Splitting OUTSIDE a workflow used to render three navigation bars: the
 * parent's, plus a full one inside each pane. That was V3.75's deliberate
 * trade — with no workflow strip on the parent, the pane's own nav was the
 * only way to retarget a pane. These pickers replace that nav, so panes can
 * be embedded unconditionally (split-view.js) and one bar drives both.
 *
 * Inside a workflow none of this runs: renderNav returns at the strip
 * branch long before it, and the strip already owns swap/close.
 *
 * Events are the SAME ones the strip pills dispatch, so split-view.js
 * needed no new listeners — see its bridge near the bottom of the file. */

let _splitPickerEls = null;   // { left: {wrap, trigger, menu}, right: {…} }

/* Normalize a pane URL for page-map lookup: drop the hash and every query
 * param except ?tab. Without this a deep-linked pane (…/library-paper.html
 * ?id=xyz) hashes to a `__q__id-xyz` id that no map entry can match. */
function _splitCanonHref(href) {
  try {
    const u = new URL(href, location.origin);
    const tab = new URLSearchParams(u.search).get('tab');
    return u.pathname + (tab ? '?tab=' + encodeURIComponent(tab) : '');
  } catch (e) { return href || ''; }
}

/* Best available human label for whatever a pane currently shows. */
function _splitLabelForHref(href, pageMap) {
  if (!href) return 'Page';
  const canon = _splitCanonHref(href);
  const exact = pageMap && pageMap.get(_wfPageIdFromHref(canon));
  if (exact) return exact.label;
  const m = canon.match(/^\/rm\/pages\/([a-z0-9-]+)\.html/);
  if (m) {
    const bySlug = pageMap && pageMap.get(m[1]);
    if (bySlug) return bySlug.label;
    // Deep link with no map entry (a specific paper, a specific protocol).
    // Titlecase the slug the way split-view.js labels its iframe titles.
    return m[1].replace(/-/g, ' ').replace(/\b\w/g, c => c.toUpperCase());
  }
  if (canon === '/rm/index.html' || canon === '/rm/' || canon === '/') return 'Dashboard';
  return canon;
}

/* split-view.js's IIFE runs at parse time (it is the last script on the
 * page) and calls writeState() immediately, so __SPLIT_STATE is already
 * populated by the time renderNav fires on DOMContentLoaded. The URL parse
 * is the fallback for any other ordering. */
function _splitReadState() {
  if (window.__SPLIT_STATE) return window.__SPLIT_STATE;
  const p = new URLSearchParams(location.search);
  return {
    left:  p.get('left')  || '/rm/index.html',
    right: p.get('right') || '/rm/index.html',
    active: p.get('active') === 'right' ? 'right' : 'left',
  };
}

/* Gate + access filter for one picker entry.
 *
 * `gate` is checked IN ADDITION to canAccessPage, not instead of it: a
 * non-admin whose allowedPageIds happens to include an admin page would
 * otherwise see Permissions in the picker, and canAccessPage is permissive
 * (returns true) when the page registry hasn't loaded. The lab-member
 * branch mirrors applyNavGates's V3.605 escape hatch so a collaborator
 * with an explicit per-page grant keeps the page. */
function _splitPageAllowed(p, isAdmin, isLabMember) {
  if (typeof firebridge === 'undefined') return true;
  if (p.gate === 'admin' && !isAdmin) return false;
  if (p.gate === 'lab-member' && !isLabMember && !isAdmin) {
    const slug = String(p.id).split('__tab__')[0];
    const granted =
      (firebridge.hasExplicitPageGrant && (firebridge.hasExplicitPageGrant(p.id) || firebridge.hasExplicitPageGrant(slug))) ||
      (firebridge.hasAnyCapabilityFor && firebridge.hasAnyCapabilityFor(slug));
    if (!granted) return false;
  }
  if (isAdmin) return true;
  if (firebridge.canAccessPage) return firebridge.canAccessPage(p.id);
  return true;
}

/* Label-only refresh — never rebuilds a menu, so an open dropdown survives
 * a pane navigating underneath it. Fired by rm:split:state-change. */
function _splitRefreshPickers(state) {
  if (!_splitPickerEls || !state) return;
  const pageMap = _wfBuildPageMap();
  ['left', 'right'].forEach(side => {
    const els = _splitPickerEls[side];
    if (!els) return;
    const href = state[side] || '';
    const lab = els.trigger.querySelector('.nav-label');
    if (lab) lab.textContent = _splitLabelForHref(href, pageMap);
    els.trigger.title = (side === 'left' ? 'Left' : 'Right') + ' pane — ' + _splitLabelForHref(href, pageMap) + ' · click to choose another page';
    els.wrap.classList.toggle('split-pane-picker--active', state.active === side);
    const otherHref = state[side === 'left' ? 'right' : 'left'] || '';
    els.menu.querySelectorAll('a[data-href]').forEach(a => {
      a.classList.toggle('active', _splitMatch(a.dataset.href, href));
      a.classList.toggle('split-picker-open-other', _splitMatch(a.dataset.href, otherHref));
    });
  });
}

/* Build both pickers + the close button. Shell renders synchronously (so
 * the bar never flashes empty); the option lists fill after auth resolves,
 * exactly like _wfPinCustomWorkflows. */
function _splitBuildPaneControls(navEl) {
  const state = _splitReadState();
  const pageMap = _wfBuildPageMap();
  _splitPickerEls = {};

  ['left', 'right'].forEach(side => {
    const wrap = document.createElement('div');
    wrap.className = 'nav-dropdown split-pane-picker split-pane-picker--' + side + ' nav-app-hide';
    if (state.active === side) wrap.classList.add('split-pane-picker--active');

    const trigger = document.createElement('button');
    trigger.type = 'button';
    trigger.className = 'nav-dropdown-trigger';
    trigger.appendChild(document.createTextNode((side === 'left' ? '◧' : '◨') + ' '));
    const lab = document.createElement('span');
    lab.className = 'nav-label';
    lab.textContent = _splitLabelForHref(state[side], pageMap);
    trigger.appendChild(lab);

    const menu = document.createElement('div');
    menu.className = 'dropdown-menu';
    menu.innerHTML = '<div class="split-picker-empty">Loading pages…</div>';

    trigger.addEventListener('click', (e) => {
      e.stopPropagation();
      const wasOpen = wrap.classList.contains('open');
      document.querySelectorAll('.nav-dropdown.open').forEach(d => d.classList.remove('open'));
      if (!wasOpen) {
        wrap.classList.add('open');
        // Opening a pane's picker focuses that pane, so "× Close split"
        // (keep: 'active') keeps the pane the user was just working in.
        window.dispatchEvent(new CustomEvent('rm:split:set-active', { detail: { side } }));
      }
    });

    wrap.appendChild(trigger);
    wrap.appendChild(menu);
    navEl.appendChild(wrap);
    _splitPickerEls[side] = { wrap, trigger, menu };
  });

  // Close button is NOT gated behind the async fill — if the page list
  // never resolves, the user must still be able to get out of split.
  const close = document.createElement('button');
  close.type = 'button';
  close.className = 'nav-dropdown-trigger split-close-btn nav-app-hide';
  ICON.label(close, 'x-mark', ' Close split');
  close.title = 'Exit split view; the active pane becomes the full page';
  close.addEventListener('click', () => {
    window.dispatchEvent(new CustomEvent('rm:split:close', { detail: { keep: 'active' } }));
  });
  navEl.appendChild(close);
  // NOTE: the option lists are filled by _splitFillPaneControls, which
  // renderNav calls AFTER the nav is in the document — see the call site.
}

/* Fill both menus. Must be called once `navEl` is attached: when
 * firebridge is absent this function reaches its liveness check with no
 * await in between, so calling it against a detached nav would bail and
 * leave both menus stuck on "Loading pages…". */
async function _splitFillPaneControls(navEl) {
  const pageMap = _wfBuildPageMap();
  if (typeof firebridge !== 'undefined') {
    if (firebridge.whenAuthResolved) {
      try { await firebridge.whenAuthResolved(); } catch (e) { /* ignore */ }
    }
    if (firebridge.loadAccessGrant) {
      try { await firebridge.loadAccessGrant(); } catch (e) { /* ignore */ }
    }
  }
  if (!document.body.contains(navEl) || !_splitPickerEls) return;

  const isAdmin     = (typeof firebridge !== 'undefined') && firebridge.isAdmin && firebridge.isAdmin();
  const isLabMember = (typeof firebridge !== 'undefined') && firebridge.isLabMember && firebridge.isLabMember();

  // Map insertion order IS NAV_ITEMS order, so grouping by iteration keeps
  // the picker in the same order as the nav itself. Don't alphabetize.
  const groups = [];
  const byGroup = new Map();
  pageMap.forEach(p => {
    if (p.id === 'split-view') return;         // no split inside a split
    if (!_splitPageAllowed(p, isAdmin, isLabMember)) return;
    if (!byGroup.has(p.group)) { byGroup.set(p.group, []); groups.push(p.group); }
    byGroup.get(p.group).push(p);
  });

  const state = _splitReadState();
  ['left', 'right'].forEach(side => {
    const els = _splitPickerEls[side];
    if (!els) return;
    els.menu.innerHTML = '';
    if (!groups.length) {
      els.menu.innerHTML = '<div class="split-picker-empty">No pages available</div>';
      return;
    }
    const otherSide = side === 'left' ? 'right' : 'left';
    groups.forEach(g => {
      const head = document.createElement('div');
      head.className = 'split-picker-group';
      head.textContent = g;
      els.menu.appendChild(head);
      byGroup.get(g).forEach(p => {
        const a = document.createElement('a');
        a.href = '#';
        a.dataset.href = p.href;
        a.textContent = p.label;
        if (_splitMatch(p.href, state[side]))      a.classList.add('active');
        if (_splitMatch(p.href, state[otherSide])) a.classList.add('split-picker-open-other');
        a.addEventListener('click', (e) => {
          e.preventDefault();
          e.stopPropagation();
          els.wrap.classList.remove('open');
          window.dispatchEvent(new CustomEvent('rm:split:swap', { detail: { side, href: p.href } }));
        });
        els.menu.appendChild(a);
      });
    });
  });
  _splitRefreshPickers(_splitReadState());
}

/* Show/hide nav entries based on the signed-in user's permissions. Called
 * once at render and again from firebridge.onAuth whenever auth state
 * changes (sign in, sign out, role promotion via live profile snapshot). */
function applyNavGates() {
  const isAdmin     = (typeof firebridge !== 'undefined') && firebridge.isAdmin && firebridge.isAdmin();
  const isLabMember = (typeof firebridge !== 'undefined') && firebridge.isLabMember && firebridge.isLabMember();
  const allowed = (gate, el) => {
    if (!gate) return true;
    if (gate === 'admin') return !!isAdmin;
    if (gate === 'lab-member') {
      if (isLabMember) return true;
      // V3.605 — a non-member (guest/collaborator) with an explicit
      // per-user grant on this item's page still gets the link. Page id
      // comes from the element's href; grants are allowedPageIds entries
      // or any 'library-paper:*'-style capability on the slug.
      const href = el && el.getAttribute && el.getAttribute('href');
      const m = href && href.match(/^\/rm\/pages\/([a-z0-9-]+)\.html/);
      if (m && typeof firebridge !== 'undefined' && firebridge.hasExplicitPageGrant) {
        return firebridge.hasExplicitPageGrant(m[1]) || firebridge.hasAnyCapabilityFor(m[1]);
      }
      return false;
    }
    return true;
  };

  // Hide individual items whose gate is unmet.
  document.querySelectorAll('.top-nav [data-gate]').forEach(el => {
    el.style.display = allowed(el.dataset.gate, el) ? '' : 'none';
  });

  // Hide a dropdown group whose visible children are all hidden — keeps the
  // nav from showing an empty "Activity ▾" with no entries inside.
  document.querySelectorAll('.top-nav .nav-dropdown').forEach(group => {
    if (group.dataset.gate && !allowed(group.dataset.gate, group)) {
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
    else if (!group.dataset.gate || allowed(group.dataset.gate, group)) group.style.display = '';
  });
}

document.addEventListener('DOMContentLoaded', renderNav);

// V3.75 — split-view.js dispatches this when its URL state changes
// (active flip, pane swap). The strip needs to re-render to update
// open/active visual states. Guarded so the initial writeState call
// at split-view.js IIFE time (which fires BEFORE nav.js renders the
// strip on DOMContentLoaded) doesn't try to refresh a strip that
// doesn't exist yet — the natural DCL render handles initial state.
window.addEventListener('rm:split:state-change', (e) => {
  // V3.632 — outside a workflow the pane pickers are what needs relabeling
  // (no-op until they exist, same guard rationale as the strip below).
  _splitRefreshPickers((e && e.detail) || null);
  if (typeof _wfRefreshStrip !== 'function') return;
  if (!document.querySelector('.top-nav--workflow')) return;
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

// V3.226 — auto-inject the silent page-time tracker on every RM page.
// Loading via nav.js (which every RM page already includes) means we
// don't have to add the <script> tag manually on each page. The tracker
// itself is a self-installing IIFE that waits for firebridge.onAuth, so
// it's safe to fire before/after firebase-bridge.js depending on browser
// scheduling.
(function injectPageTimeTracker() {
  try {
    if (window.__rmPageTimeTrackerInjected) return;
    window.__rmPageTimeTrackerInjected = true;
    var s = document.createElement('script');
    s.src = '/rm/js/page-time-tracker.js';
    s.async = true;
    (document.head || document.documentElement).appendChild(s);
  } catch (e) { /* nav.js shouldn't block on this */ }
})();

// V3.596 — auto-inject the presence heartbeat on every RM page, same
// reasoning as the tracker above: it has to be everywhere, so injecting it
// here beats a <script> tag on 72 pages. It publishes what this surface is
// showing to userPresence/{uid} so the push pipeline can skip notifying
// someone who is already looking at the thing (functions/helpers/presence.js).
(function injectPresence() {
  try {
    if (window.__rmPresenceInjected) return;
    window.__rmPresenceInjected = true;
    var s = document.createElement('script');
    s.src = '/rm/js/presence.js';
    s.async = true;
    (document.head || document.documentElement).appendChild(s);
  } catch (e) { /* nav.js shouldn't block on this */ }
})();
