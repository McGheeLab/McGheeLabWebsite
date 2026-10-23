/* all-pages.js — the "All pages" section of RM Home (V3.74, reshaped V3.809).
 *
 * Renders every NAV_ITEMS page the signed-in user can open as a tile grid
 * grouped by section, into #home-pages-grid on rm/index.html. Each tile
 * has the page's icon, label, group badge, one-line blurb and a ★ that
 * pins/unpins it to the top bar (NavPins, nav.js).
 *
 * V3.809 — icons and blurbs now come from the page registry entries
 * (page-registry.js copies them from nav.js's NAV_ITEMS `icon` fields and
 * NAV_PAGE_DESCRIPTIONS), so the home tiles, the bar chips and the
 * palette can't disagree. The two-tab home (Workflows | All Pages) is
 * gone: this section is always on the page, filtered by the box above it. */

(function () {
  function escHtml(s) {
    return String(s == null ? '' : s)
      .replace(/&/g, '&amp;').replace(/</g, '&lt;')
      .replace(/>/g, '&gt;').replace(/"/g, '&quot;');
  }

  var _rendered = false;

  async function boot() {
    if (typeof firebridge === 'undefined') return;
    await firebridge.whenAuthResolved();
    var grid = document.getElementById('home-pages-grid');
    if (!grid) return;
    if (!firebridge.getUser()) {
      grid.innerHTML = '<div class="empty-state">Sign in to browse pages.</div>';
      return;
    }
    await firebridge.loadAccessGrant();
    render();
    wireFilter();
    window.addEventListener('rm:nav:pins-change', paintStars);
  }

  function render() {
    var REG = window.PAGE_REGISTRY;
    var grid = document.getElementById('home-pages-grid');
    if (!grid) return;
    if (!REG || !REG.list || !REG.list.length) {
      grid.innerHTML = '<div class="empty-state">Page registry not loaded.</div>';
      return;
    }
    var isAdmin = firebridge.isAdmin && firebridge.isAdmin();
    var isLabMember = firebridge.isLabMember && firebridge.isLabMember();
    // Group by NAV_ITEMS section.
    var groups = new Map();
    REG.list.forEach(function (p) {
      if (p.id === 'dashboard') return;              // we ARE the home page
      // Gate + grant, same test the bar and the palette use (nav.js).
      if (typeof _splitPageAllowed === 'function') {
        if (!_splitPageAllowed(p, isAdmin, isLabMember)) return;
      } else if (!firebridge.canAccessPage(p.id)) return;
      var g = p.group || 'Other';
      if (!groups.has(g)) groups.set(g, []);
      groups.get(g).push(p);
    });

    grid.innerHTML = '';
    if (!groups.size) {
      grid.innerHTML = '<div class="empty-state">No accessible pages. Ask the admin to grant page access via the Permissions matrix.</div>';
      return;
    }

    // Stable group order (matches NAV_ITEMS top-level layout).
    var order = ['Home', 'Activity', 'Research', 'Operations', 'Lab Admin', 'Settings', 'Split', 'Other'];   // lockstep with nav.js NAV_ITEMS labels
    var orderedGroups = order.filter(function (g) { return groups.has(g); });
    groups.forEach(function (_, g) { if (orderedGroups.indexOf(g) < 0) orderedGroups.push(g); });

    orderedGroups.forEach(function (groupName) {
      var pages = groups.get(groupName);
      if (!pages || !pages.length) return;
      var section = document.createElement('section');
      section.className = 'wf-section ap-group';
      section.dataset.group = groupName;
      var heading = document.createElement('h3');
      heading.className = 'wf-section-title';
      heading.textContent = groupName;
      section.appendChild(heading);
      var tiles = document.createElement('div');
      tiles.className = 'ap-grid';
      pages.forEach(function (p) { tiles.appendChild(renderPageCard(p, groupName)); });
      section.appendChild(tiles);
      grid.appendChild(section);
    });
    _rendered = true;
    paintStars();
    applyFilter();
  }

  function renderPageCard(p, groupName) {
    var card = document.createElement('a');
    card.className = 'ap-card';
    card.href = p.href;
    card.dataset.pageId = p.id;
    card.dataset.search = (p.label + ' ' + groupName + ' ' + (p.desc || '')).toLowerCase();
    var gateBadge = p.gate === 'admin'
      ? '<span class="ap-gate-badge ap-gate-admin">admin</span>'
      : '';
    card.innerHTML =
      '<div class="ap-card-head">' +
      '  <div class="ap-card-icon">' + ICON.svg(p.icon || 'document-text', { size: 'xl' }) + '</div>' +   /* trusted markup — do not esc() */
      '  <div class="ap-card-titlebox">' +
      '    <div class="ap-card-label">' + escHtml(p.label) + gateBadge + '</div>' +
      '    <div class="ap-card-group">' + escHtml(groupName) + '</div>' +
      '  </div>' +
      '</div>' +
      (p.desc ? '<div class="ap-card-desc">' + escHtml(p.desc) + '</div>' : '') +
      '<button type="button" class="ap-card-star" title="Pin to the bar" aria-label="Pin ' + escHtml(p.label) + ' to the bar">' + ICON.svg('star') + '</button>';
    card.querySelector('.ap-card-star').addEventListener('click', function (e) {
      e.preventDefault(); e.stopPropagation();
      if (window.NavPins) NavPins.toggle(p.id);
    });
    return card;
  }

  /* Stars reflect NavPins (nav.js); re-run on rm:nav:pins-change so a pin
   * made from the bar or the palette shows up here too. */
  function paintStars() {
    if (!_rendered || !window.NavPins) return;
    document.querySelectorAll('#home-pages-grid .ap-card').forEach(function (card) {
      var on = NavPins.has(card.dataset.pageId);
      var star = card.querySelector('.ap-card-star');
      if (!star) return;
      star.classList.toggle('on', on);
      star.innerHTML = ICON.svg('star', { variant: on ? 'solid' : 'outline' });
      star.title = on ? 'Unpin from the bar' : 'Pin to the bar';
    });
  }

  /* Filter box: hides tiles whose label/group/blurb don't contain the
   * query, and whole groups that end up empty. */
  function wireFilter() {
    var input = document.getElementById('home-pages-filter');
    if (!input) return;
    input.addEventListener('input', applyFilter);
    input.addEventListener('keydown', function (e) {
      if (e.key === 'Escape') { input.value = ''; applyFilter(); input.blur(); }
      if (e.key === 'Enter') {
        var first = document.querySelector('#home-pages-grid .ap-card:not(.ap-card--hidden)');
        if (first) { e.preventDefault(); first.click(); }
      }
    });
  }
  function applyFilter() {
    var input = document.getElementById('home-pages-filter');
    var q = ((input && input.value) || '').trim().toLowerCase();
    document.querySelectorAll('#home-pages-grid .ap-group').forEach(function (sec) {
      var any = false;
      sec.querySelectorAll('.ap-card').forEach(function (card) {
        var hit = !q || (card.dataset.search || '').indexOf(q) >= 0;
        card.classList.toggle('ap-card--hidden', !hit);
        if (hit) any = true;
      });
      sec.classList.toggle('wf-section--empty-filter', !any);
    });
    var empty = document.getElementById('home-pages-empty');
    if (empty) {
      var anyShown = !!document.querySelector('#home-pages-grid .ap-card:not(.ap-card--hidden)');
      empty.hidden = anyShown;
      if (!anyShown) empty.textContent = 'No page matches “' + q + '”.';
    }
  }

  document.addEventListener('DOMContentLoaded', boot);
})();
