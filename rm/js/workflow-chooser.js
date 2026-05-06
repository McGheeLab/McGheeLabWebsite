/* workflow-chooser.js — V3.64 RM front-page workflow chooser.
 *
 * Replaces the old 14-card stats dashboard at rm/index.html. Renders the
 * 5 default workflows as clickable cards (filtered by user accessibility);
 * future PR 3 (V3.65) adds a "My workflows" section with custom workflows
 * and a "+ New custom workflow" card.
 *
 * Click a workflow card → WorkflowState.setActive() → navigate to the
 * workflow's first accessible page. nav.js then renders the workflow
 * strip (instead of the six-group nav) on every page in the workflow.
 *
 * This page does NOT render the workflow strip itself — the strip is
 * only useful while inside a workflow, and the chooser is the "no
 * active workflow" home. If a user lands here while a workflow is
 * active, the strip appears (since nav.js reads sessionStorage) but
 * users typically reach the chooser via "Switch workflow" / "Leave
 * workflow" which clear state first. */

(function () {
  function escHtml(s) {
    return String(s == null ? '' : s)
      .replace(/&/g, '&amp;').replace(/</g, '&lt;')
      .replace(/>/g, '&gt;').replace(/"/g, '&quot;');
  }

  async function boot() {
    if (typeof firebridge === 'undefined') return;
    await firebridge.whenAuthResolved();
    if (!firebridge.getUser()) {
      // Show the existing "sign in" experience — nav already prompts.
      var root = document.getElementById('workflow-root');
      if (root) root.innerHTML = '<div class="empty-state">Sign in to see your workflows.</div>';
      return;
    }
    // Pending-access gate: handled globally by firebridge for guests.

    await firebridge.loadAccessGrant();

    var defaults = await WorkflowState.loadDefaultWorkflows();
    // Custom workflows: PR 3 will populate; harmless empty array for now.
    var custom = [];
    try { custom = await WorkflowState.loadCustomWorkflows(); } catch (e) { /* ignore */ }

    render(defaults, custom);
  }

  /** Render a single workflow card. */
  function renderCard(wf, kind) {
    var REG = window.PAGE_REGISTRY || { byId: new Map() };
    var pageIds = wf.pageIds || [];
    // Filter to pages the current user can access AND that exist in the registry.
    var accessiblePages = pageIds
      .map(function (id) { return REG.byId.get(id); })
      .filter(function (p) { return p && firebridge.canAccessPage(p.id); });

    if (!accessiblePages.length) return null;

    var card = document.createElement('a');
    card.className = 'wf-card';
    card.href = '#';
    card.dataset.id = wf.id;
    card.dataset.kind = kind;
    var pageList = accessiblePages.slice(0, 6).map(function (p) {
      return '<span class="wf-chip">' + escHtml(p.label) + '</span>';
    }).join('');
    var more = accessiblePages.length > 6
      ? '<span class="wf-chip wf-chip-more">+' + (accessiblePages.length - 6) + ' more</span>'
      : '';
    card.innerHTML =
      '<div class="wf-card-head">' +
      '  <div class="wf-icon">' + escHtml(wf.icon || '🗂') + '</div>' +
      '  <div class="wf-titlebox">' +
      '    <div class="wf-label">' + escHtml(wf.label) + '</div>' +
      '    <div class="wf-pagecount">' + accessiblePages.length + ' page' +
              (accessiblePages.length === 1 ? '' : 's') + '</div>' +
      '  </div>' +
      '</div>' +
      (wf.description
        ? '<div class="wf-desc">' + escHtml(wf.description) + '</div>'
        : '') +
      '<div class="wf-pages">' + pageList + more + '</div>';

    card.addEventListener('click', function (e) {
      e.preventDefault();
      WorkflowState.setActive(wf.id, kind);
      // Land on the first accessible page in the workflow.
      var first = accessiblePages[0];
      // Decorate URL with ?workflow=<id> so a Cmd-clicked-into-new-tab
      // navigation still picks up the workflow context (the param is
      // stripped from the URL by WorkflowState.adoptFromUrl after read).
      location.href = WorkflowState.decorateHref(first.href, wf.id);
    });
    return card;
  }

  function render(defaults, custom) {
    var root = document.getElementById('workflow-root');
    if (!root) return;
    root.innerHTML = '';

    var defaultsSection = document.createElement('section');
    defaultsSection.className = 'wf-section';
    defaultsSection.innerHTML =
      '<h2 class="wf-section-title">Workflows</h2>' +
      '<p class="wf-section-sub">Pick a workflow to get a focused page strip on top of every page you visit. Each workflow is a curated bundle of related tools — leave anytime to return to the full nav.</p>';
    var grid = document.createElement('div');
    grid.className = 'wf-grid';
    var anyVisible = false;
    defaults.forEach(function (wf) {
      var card = renderCard(wf, 'default');
      if (card) { grid.appendChild(card); anyVisible = true; }
    });
    if (!anyVisible) {
      grid.innerHTML = '<div class="empty-state">No accessible workflows. Ask the admin to grant page access.</div>';
    }
    defaultsSection.appendChild(grid);
    root.appendChild(defaultsSection);

    // PR 3 hook — render custom workflows (currently always empty).
    if (custom && custom.length) {
      var customSection = document.createElement('section');
      customSection.className = 'wf-section';
      customSection.innerHTML =
        '<h2 class="wf-section-title">My workflows</h2>' +
        '<p class="wf-section-sub">Custom workflows you saved. <em>(PR 3 / V3.65 wires this up.)</em></p>';
      var cgrid = document.createElement('div');
      cgrid.className = 'wf-grid';
      custom.forEach(function (wf) {
        var card = renderCard(wf, 'custom');
        if (card) cgrid.appendChild(card);
      });
      customSection.appendChild(cgrid);
      root.appendChild(customSection);
    }
  }

  document.addEventListener('DOMContentLoaded', boot);
})();
