/* all-pages.js — V3.74 RM front-page "All Pages" view.
 *
 * Sibling to workflow-chooser.js. When `?view=all-pages` is on the URL
 * (toggled via the tab in rm/index.html), this renders a grouped tile
 * grid of every NAV_ITEMS page the current user can access. Each tile
 * has an icon, label, group badge, and a short one-line description.
 *
 * The PAGE_DESCRIPTIONS map below is the source of truth for the
 * per-page blurbs. Adding a new page to NAV_ITEMS automatically makes
 * it appear in the All Pages grid (with a fallback "" description if
 * not in the map). */

(function () {
  function escHtml(s) {
    return String(s == null ? '' : s)
      .replace(/&/g, '&amp;').replace(/</g, '&lt;')
      .replace(/>/g, '&gt;').replace(/"/g, '&quot;');
  }

  /* Per-page blurbs keyed by page id (as derived from URL by
   * page-registry.js's pageIdFromHref). Adding a new page requires:
   *   1. Add to NAV_ITEMS (nav.js)
   *   2. Add a description here (otherwise the card shows just the
   *      label without a body — still functional but less helpful). */
  var PAGE_DESCRIPTIONS = {
    'dashboard':                          'RM home — workflow chooser + all-pages browser.',

    /* Activity */
    'activity-overview':                  'At-a-glance summary of your activity across the lab — emails, calendar, tasks, year review.',
    'activity-overview__tab__tracker':    'Daily activity logger — track time on research, teaching, service.',
    'activity-overview__tab__email':      'Triage and rate inbound email; assign categories and tasks.',
    'activity-overview__tab__timeline':   'Year-in-review timeline of events, emails, and activities grouped by category.',
    'activity-overview__tab__lab-stats':  'Cross-member activity stats (admin only).',
    'pmr':                                'Project Management Reports — periodic summaries shared with the PI.',
    'calendar':                           'Lab calendar with deadlines, meetings, and Outlook/Google event imports.',
    'tasks':                              'Bucket-based task workspace — projects, sub-buckets, subtasks, evidence.',
    'sharing':                            'Send tasks to teammates and review tasks they\'ve sent you.',
    'explorer':                           'Cross-cutting search across activities, emails, events, and tasks.',

    /* Research */
    'projects':                           'Lab projects, papers, courses, infrastructure, tools — the master list.',
    'library':                            'Captured papers (Chrome extension or PDF drop), tags, citations.',
    'library__tab__comments':             'Cross-paper annotations + claims feed for literature review.',
    'paper-builder':                      'Paper editor — write, draft, manage figures, export to LaTeX.',
    'teaching':                           'Course planning + outlines for current and upcoming courses.',
    'service':                            'Conferences, committees, reviews, outreach activities.',

    /* Operations */
    'chat':                               'Lab chat — channels, DMs, file uploads via Drive.',
    'huddle':                             'Daily huddle planning + help requests + rundown.',
    'meetings':                           'Lab meetings — agenda, presenters, action items.',
    'scheduler':                          'Public scheduling pages for talks + your personal calendar.',
    'equipment':                          'Lab equipment — bookings, training, calendar overlays.',

    /* Lab Admin */
    'compliance':                         'IACUC, IRB, IBC protocols + safety paperwork.',
    'chemicals':                          'Hazardous chemicals — GHS hazards, MSDS, expiration dates.',
    'inventory':                          'All lab items — locations, stock, ownership.',
    'people':                             'Roster — PI, postdocs, students, alumni + roles.',
    'people__tab__important':             'Regents, donors, collaborators, key initiatives.',
    'career':                             'PI tenure dossier — milestones + supporting documents.',
    'procurement':                        'Purchase request → approve → order → receive → place lifecycle.',
    'receipts':                           'Receipt uploads + budget tracking by account.',
    'projects-grants':                    'Funded projects — budgets, expenses by grant.',
    'budget':                             'Lab-wide budget model + projections.',
    'analytics':                          'Expense charts + trends across categories and accounts.',
    'finance':                            'Travel trips + receipt parsing for reimbursements.',

    /* Settings */
    'profile':                            'Your profile, calendar connections (Outlook/Google), Gmail OAuth.',
    'settings':                           'Notification preferences, calendar sync, all OAuth connections.',
    'cv-editor':                          'Edit your CV — publications, presentations, grants, service.',
    'cv-editor__tab__lab':                'Lab-wide CV table — see everyone\'s CVs at a glance.',
    'api-usage':                          'Claude API usage + cost dashboard (admin only).',
    'admin-permissions':                  'User × page access matrix + default workflow contents (admin).',

    /* Top-level */
    'split-view':                         'Open two pages side by side.',
  };

  /* Per-page icons keyed by page id. Falls back to a generic glyph if
   * unset. */
  var PAGE_ICONS = {
    'dashboard':                          '🏠',
    'activity-overview':                  '📊',
    'activity-overview__tab__tracker':    '⏱',
    'activity-overview__tab__email':      '✉️',
    'activity-overview__tab__timeline':   '📆',
    'activity-overview__tab__lab-stats':  '🧪',
    'pmr':                                '📋',
    'calendar':                           '🗓',
    'tasks':                              '✅',
    'sharing':                            '🤝',
    'explorer':                           '🔎',
    'projects':                           '📁',
    'library':                            '📚',
    'library__tab__comments':             '💬',
    'paper-builder':                      '📝',
    'teaching':                           '🎓',
    'service':                            '🏛',
    'chat':                               '💭',
    'huddle':                             '👥',
    'meetings':                           '🗣',
    'scheduler':                          '⌚',
    'equipment':                          '🔬',
    'compliance':                         '⚖️',
    'chemicals':                          '🧪',
    'inventory':                          '📦',
    'people':                             '👤',
    'people__tab__important':             '⭐',
    'career':                             '🎖',
    'procurement':                        '🛒',
    'receipts':                           '🧾',
    'projects-grants':                    '💰',
    'budget':                             '💵',
    'analytics':                          '📈',
    'finance':                            '✈️',
    'profile':                            '🪪',
    'settings':                           '⚙️',
    'cv-editor':                          '📄',
    'cv-editor__tab__lab':                '📚',
    'api-usage':                          '⚡',
    'admin-permissions':                  '🔐',
    'split-view':                         '⊟',
  };

  async function boot() {
    if (window.__RM_HOME_VIEW !== 'all-pages') return;
    if (typeof firebridge === 'undefined') return;
    await firebridge.whenAuthResolved();
    if (!firebridge.getUser()) {
      var root = document.getElementById('rm-home-root');
      if (root) root.innerHTML = '<div class="empty-state">Sign in to browse pages.</div>';
      return;
    }
    await firebridge.loadAccessGrant();
    render();
  }

  function render() {
    var REG = window.PAGE_REGISTRY;
    if (!REG || !REG.list || !REG.list.length) {
      var root = document.getElementById('rm-home-root');
      if (root) root.innerHTML = '<div class="empty-state">Page registry not loaded.</div>';
      return;
    }
    // Group by NAV_ITEMS section.
    var groups = new Map();
    REG.list.forEach(function (p) {
      // Skip the dashboard self-entry (we ARE the dashboard).
      if (p.id === 'dashboard') return;
      // Skip pages the user can't access.
      if (!firebridge.canAccessPage(p.id)) return;
      var g = p.group || 'Other';
      if (!groups.has(g)) groups.set(g, []);
      groups.get(g).push(p);
    });

    var root = document.getElementById('rm-home-root');
    if (!root) return;
    root.innerHTML = '';

    if (!groups.size) {
      root.innerHTML = '<div class="empty-state">No accessible pages. Ask the admin to grant page access via the Permissions matrix.</div>';
      return;
    }

    // Stable group order (matches NAV_ITEMS top-level layout).
    var order = ['Dashboard', 'Activity', 'Research', 'Operations', 'Lab Admin', 'Settings', '⊟ Split', 'Other'];
    var orderedGroups = order.filter(function (g) { return groups.has(g); });
    // Append any group not in the canonical order at the end.
    groups.forEach(function (_, g) {
      if (orderedGroups.indexOf(g) < 0) orderedGroups.push(g);
    });

    var intro = document.createElement('p');
    intro.className = 'wf-section-sub';
    intro.style.marginTop = '4px';
    intro.textContent = 'Every page in RM, grouped by section. Click a tile to open the page directly. Workflows on the other tab give you a focused subset for a specific task.';
    root.appendChild(intro);

    orderedGroups.forEach(function (groupName) {
      var pages = groups.get(groupName);
      if (!pages || !pages.length) return;
      var section = document.createElement('section');
      section.className = 'wf-section';
      var heading = document.createElement('h2');
      heading.className = 'wf-section-title';
      heading.textContent = groupName;
      section.appendChild(heading);
      var grid = document.createElement('div');
      grid.className = 'ap-grid';
      pages.forEach(function (p) {
        grid.appendChild(renderPageCard(p, groupName));
      });
      section.appendChild(grid);
      root.appendChild(section);
    });
  }

  function renderPageCard(p, groupName) {
    var card = document.createElement('a');
    card.className = 'ap-card';
    card.href = p.href;
    card.dataset.pageId = p.id;
    var icon = PAGE_ICONS[p.id] || '📄';
    var desc = PAGE_DESCRIPTIONS[p.id] || '';
    var gateBadge = p.gate === 'admin'
      ? '<span class="ap-gate-badge ap-gate-admin">admin</span>'
      : '';
    card.innerHTML =
      '<div class="ap-card-head">' +
      '  <div class="ap-card-icon">' + escHtml(icon) + '</div>' +
      '  <div class="ap-card-titlebox">' +
      '    <div class="ap-card-label">' + escHtml(p.label) + gateBadge + '</div>' +
      '    <div class="ap-card-group">' + escHtml(groupName) + '</div>' +
      '  </div>' +
      '</div>' +
      (desc ? '<div class="ap-card-desc">' + escHtml(desc) + '</div>' : '');
    return card;
  }

  document.addEventListener('DOMContentLoaded', boot);
})();
