/* page-registry.js — flat list of every workflow-eligible RM page.
 *
 * V3.63 — introduced for the workflow-driven UX redesign. Built by walking
 * `nav.js`'s NAV_ITEMS at startup, so adding a page to the nav automatically
 * makes it pickable in the admin permissions matrix and the workflow builder.
 *
 * Each page entry has:
 *   id     — stable slug derived from URL+tab. e.g.
 *              /rm/pages/library.html              → 'library'
 *              /rm/pages/library.html?tab=comments → 'library__tab__comments'
 *              /rm/pages/activity-overview.html?tab=tracker → 'activity-overview__tab__tracker'
 *   label  — human-readable, surfaced in matrices + workflow chips
 *   href   — full URL (path + ?tab if any), used as link target
 *   group  — top-level NAV_ITEMS section ("Activity", "Research", etc.)
 *   gate   — optional 'admin' or 'lab-member' carried over from NAV_ITEMS
 *   icon   — Heroicon name from the NAV_ITEMS entry (V3.809)
 *   desc   — one-line blurb from nav.js's NAV_PAGE_DESCRIPTIONS (V3.809)
 *
 * Two helpers are exported on `window.PAGE_REGISTRY`:
 *   PAGE_REGISTRY.list   — array of all pages
 *   PAGE_REGISTRY.byId   — Map<id, entry>
 *   PAGE_REGISTRY.byHref — Map<href, entry>  (used by canAccessPage at runtime)
 *
 * The five default workflows are seeded here (DEFAULT_WORKFLOWS). The admin
 * permissions matrix lets admins edit each default workflow's pageIds in
 * Firestore (labConfig/defaultWorkflows); this file's defaults are the
 * one-time seed values + the fallback when Firestore is empty.
 *
 * Loaded after nav.js so NAV_ITEMS is available. Both nav.js and this file
 * declare const NAV_ITEMS and PAGE_REGISTRY at script scope; later loaders
 * (workflow-chooser, admin-permissions, future workflow-shell) read them. */

(function () {
  if (typeof NAV_ITEMS === 'undefined') {
    console.warn('[page-registry] NAV_ITEMS not in scope; load nav.js first.');
    return;
  }

  /* Stable id from URL: drops the /rm/pages/ prefix + .html, replaces
   * `?tab=<X>` with `__tab__<X>`. Idempotent — calling on an existing id
   * returns it unchanged. Special case `/rm/index.html` → 'dashboard'. */
  function pageIdFromHref(href) {
    if (!href) return '';
    if (href === '/rm/index.html' || href === '/rm/' || href === '/') return 'dashboard';
    var m = href.match(/^\/rm\/pages\/([a-z0-9-]+)\.html(\?(.*))?$/);
    if (!m) return href;  // unknown shape — pass through
    var slug = m[1];
    var query = m[3] || '';
    if (!query) return slug;
    // Parse only ?tab=<X> for now; other params get URL-encoded into the id.
    var qp = new URLSearchParams(query);
    var tab = qp.get('tab');
    if (tab) return slug + '__tab__' + tab;
    return slug + '__q__' + query.replace(/[^a-z0-9_-]/gi, '-');
  }

  function flattenNav() {
    var pages = [];
    var seen = new Set();
    // V3.809 — entries carry the Heroicon name declared on the NAV_ITEMS
    // entry and the blurb from NAV_PAGE_DESCRIPTIONS (both live in nav.js),
    // so the home tiles, the palette and the chips agree on one icon.
    var DESC = (typeof NAV_PAGE_DESCRIPTIONS !== 'undefined') ? NAV_PAGE_DESCRIPTIONS : {};
    function add(label, href, group, gate, icon) {
      if (!href) return;
      var id = pageIdFromHref(href);
      if (seen.has(id)) return;  // first occurrence wins
      seen.add(id);
      pages.push({ id: id, label: label, href: href, group: group, gate: gate || null,
                   icon: icon || 'document-text', desc: DESC[id] || '' });
    }
    NAV_ITEMS.forEach(function (item) {
      // V3.542 — a top-level nav item may declare `pageGroup` so the
      // All Pages grid files it under an existing section instead of
      // minting a one-tile group (e.g. My Week → Activity).
      var groupLabel = item.pageGroup || item.label;
      if (item.children && item.children.length) {
        // Group entry — also add the group's own href if it points somewhere.
        if (item.href) add(item.label, item.href, groupLabel, item.gate, item.icon);
        item.children.forEach(function (child) {
          add(child.label, child.href, groupLabel, child.gate || item.gate, child.icon || item.icon);
        });
      } else if (item.href) {
        // Top-level direct link (Home, Split View).
        add(item.label, item.href, groupLabel, item.gate, item.icon);
      }
    });
    return pages;
  }

  var list = flattenNav();
  var byId = new Map();
  var byHref = new Map();
  list.forEach(function (p) {
    byId.set(p.id, p);
    byHref.set(p.href, p);
  });

  /* Five default workflows seeded at first run. The admin permissions matrix
   * can edit `labConfig/defaultWorkflows` to override these — but the seeds
   * here are the source of truth when Firestore is empty (first load) and
   * the source for the one-time seed migration tool.
   *
   * `landingPageId` (V3.66) is the page that loads when a user clicks the
   * workflow card in the chooser or selects it from the pinned-nav dropdown.
   * Falls back to the first accessible pageId if landingPageId is unset or
   * not accessible to the user. */
  var DEFAULT_WORKFLOWS = [
    {
      id: 'lab-research',
      label: 'Lab Research',
      description: 'Daily research workflow — track activity, browse the library, manage projects, and capture tasks.',
      icon: 'microscope',
      landingPageId: 'activity-overview__tab__tracker',
      pageIds: [
        'activity-overview__tab__tracker',
        'library',
        'projects',
        'tasks',
        // V3.830 — the block notebook (notebook.html) replaced lab-notebook here
        'notebook',
        'protocols',
      ],
    },
    {
      id: 'paper-writing',
      label: 'Paper Writing',
      description: 'Compose papers with the editor, pull annotations from the library, track tasks and PMRs, coordinate via chat.',
      icon: 'pencil-square',
      landingPageId: 'paper-builder',
      pageIds: [
        'paper-builder',
        'library',
        'library__tab__comments',
        'tasks',
        'pmr',
        'chat',
        'notebook',
      ],
    },
    {
      id: 'certification-training',
      label: 'Certification & Training',
      description: 'Compliance protocols, chemical safety, training records, and tenure-track milestones.',
      icon: 'academic-cap',
      landingPageId: 'compliance',
      pageIds: [
        'compliance',
        'chemicals',
        'career',
        'tasks',
      ],
    },
    {
      id: 'task-scheduling',
      label: 'Task Scheduling & Activity Reports',
      description: 'Plan tasks, track activity (tracker / year / email), schedule meetings, share assignments, file PMRs.',
      icon: 'chart-bar',
      landingPageId: 'tasks',
      pageIds: [
        'tasks',
        'activity-overview',
        'activity-overview__tab__tracker',
        'activity-overview__tab__timeline',
        'activity-overview__tab__email',
        'scheduler',
        // V3.480 — Task Market moved to tasks.html?tab=market, so the
        // nav-derived page id is now `tasks__tab__market` (was `task-market`).
        'tasks__tab__market',
        'pmr',
      ],
    },
    {
      id: 'meetings',
      label: 'Meetings',
      description: 'Run lab meetings, huddles, and 1:1s with chat, calendar, and task capture wired up.',
      icon: 'megaphone',
      landingPageId: 'meetings',
      pageIds: [
        'meetings',
        'huddle',
        'chat',
        'tasks',
        'calendar',
      ],
    },
  ];

  window.PAGE_REGISTRY = {
    list: list,
    byId: byId,
    byHref: byHref,
    pageIdFromHref: pageIdFromHref,
    DEFAULT_WORKFLOWS: DEFAULT_WORKFLOWS,
    // Union of all pageIds across the 5 default workflows. Used by
    // firebridge.canAccessPage as the implicit baseline when a user has no
    // `allowedPageIds` document. NB: includes future placeholders like
    // 'lab-notebook' and 'protocols'; harmless because the page lookup will
    // miss and the workflow chip won't render.
    defaultPageIdSet: (function () {
      var s = new Set();
      DEFAULT_WORKFLOWS.forEach(function (wf) {
        (wf.pageIds || []).forEach(function (id) { s.add(id); });
      });
      return s;
    })(),
  };
})();
