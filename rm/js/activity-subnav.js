/* activity-subnav.js — horizontal pill-nav shared across Activity pages.
 *
 * Auto-mounts on any page whose path matches ACTIVITY_PAGES. Injected just
 * below the top nav and above the main page content so it stays visible as
 * the user moves through the activity workflow.
 *
 * Include via:   <script src="/rm/js/activity-subnav.js"></script>
 */
(function () {
  const ACTIVITY_PAGES = [
    { label: 'Overview',       href: '/rm/pages/activity-overview.html' },
    { label: 'Explorer',       href: '/rm/pages/explorer.html' },
    { label: 'Calendar',       href: '/rm/pages/calendar.html' },
    { label: 'Email',          href: '/rm/pages/email-review.html' },
    { label: 'Task',           href: '/rm/pages/tasks.html' },
    { label: 'Year',           href: '/rm/pages/year-review.html' },
    { label: 'PMR',            href: '/rm/pages/pmr.html' },
    { label: 'API usage',      href: '/rm/pages/api-usage.html' },
  ];
  // These pages still count as "activity" for auto-mount purposes so the
  // sub-nav appears on them, but they don't get their own pill (they're
  // reached via the Task dashboard's own hub tabs).
  const ACTIVITY_EXTRA_PATHS = [
    '/rm/pages/tasks-inbox.html',
    '/rm/pages/tasks-archive.html',
    '/rm/pages/tasks-add.html',
  ];

  // Inject the pill styles once per page load — scoped so they don't collide
  // with any page's own .act-* classes.
  function injectStyles() {
    if (document.getElementById('activity-subnav-styles')) return;
    const st = document.createElement('style');
    st.id = 'activity-subnav-styles';
    st.textContent = `
      .act-subnav{display:flex;gap:6px;align-items:center;flex-wrap:wrap;padding:10px 24px;background:var(--bg);border-bottom:1px solid var(--border)}
      .act-subnav a{display:inline-block;padding:5px 14px;font-size:13px;font-weight:500;color:var(--text-muted);background:var(--surface);border:1px solid var(--border);border-radius:999px;text-decoration:none;white-space:nowrap;transition:background .12s, color .12s, border-color .12s}
      .act-subnav a:hover{color:var(--text);border-color:var(--primary);background:#fff}
      .act-subnav a.active{background:var(--primary);color:#fff;border-color:var(--primary)}
      .act-subnav .lbl{font-size:11px;text-transform:uppercase;letter-spacing:.5px;color:var(--text-muted);font-weight:600;margin-right:8px}
    `;
    document.head.appendChild(st);
  }

  // Task hub sub-pages — the Task pill highlights on any of them.
  const TASK_PATHS = new Set([
    '/rm/pages/tasks.html',
    '/rm/pages/tasks-add.html',
    '/rm/pages/tasks-inbox.html',
    '/rm/pages/tasks-archive.html',
  ]);

  function buildBar() {
    const bar = document.createElement('nav');
    bar.className = 'act-subnav';
    bar.setAttribute('aria-label', 'Activity navigation');
    const currentPath = window.location.pathname;

    const lbl = document.createElement('span');
    lbl.className = 'lbl';
    lbl.textContent = 'Activity';
    bar.appendChild(lbl);

    for (const p of ACTIVITY_PAGES) {
      const a = document.createElement('a');
      a.href = p.href;
      a.textContent = p.label;
      const isTaskPill = p.href === '/rm/pages/tasks.html';
      if (p.href === currentPath || (isTaskPill && TASK_PATHS.has(currentPath))) {
        a.classList.add('active');
      }
      bar.appendChild(a);
    }
    return bar;
  }

  function placeBar(bar, attempt = 0) {
    // nav.js prepends `<nav class="top-nav">` as body's first child on its
    // own DOMContentLoaded handler. Wait for it so we can insert the sub-nav
    // immediately after it (keeps stacking + sticky offsets predictable).
    const topNav = document.querySelector('nav.top-nav');
    if (topNav) {
      if (topNav.nextSibling) {
        topNav.parentNode.insertBefore(bar, topNav.nextSibling);
      } else {
        topNav.parentNode.appendChild(bar);
      }
      return;
    }
    if (attempt < 20) {
      requestAnimationFrame(() => placeBar(bar, attempt + 1));
    } else {
      // Give up waiting — fall back to body-prepend so the sub-nav at least
      // renders rather than silently dropping.
      document.body.prepend(bar);
    }
  }

  function run() {
    const currentPath = window.location.pathname;
    const onActivity = ACTIVITY_PAGES.some(p => p.href === currentPath)
                    || ACTIVITY_EXTRA_PATHS.includes(currentPath);
    if (!onActivity) return;
    injectStyles();
    placeBar(buildBar());
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', run);
  } else {
    run();
  }
})();
