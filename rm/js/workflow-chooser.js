/* workflow-chooser.js — V3.64 RM front-page workflow chooser, V3.65
 * extended with the "My workflows" section and custom-workflow builder.
 *
 * Replaces the old 14-card stats dashboard at rm/index.html. Renders:
 *   - Default workflows (5 from labConfig/defaultWorkflows or seed)
 *   - My workflows (from userData/{uid}/customWorkflows)
 *   - "+ New custom workflow" card
 *
 * Click a workflow card → WorkflowState.setActive() → navigate to the
 * workflow's first accessible page. nav.js then renders the workflow
 * strip (instead of the six-group nav) on every page in the workflow.
 */

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
      var root = document.getElementById('workflow-root');
      if (root) root.innerHTML = '<div class="empty-state">Sign in to see your workflows.</div>';
      return;
    }
    await firebridge.loadAccessGrant();

    var defaults = await WorkflowState.loadDefaultWorkflows();
    var custom = [];
    try { custom = await WorkflowState.loadCustomWorkflows(); } catch (e) { /* ignore */ }

    render(defaults, custom);
  }

  function pageChips(wf) {
    var REG = window.PAGE_REGISTRY || { byId: new Map() };
    var pageIds = wf.pageIds || [];
    var accessiblePages = pageIds
      .map(function (id) { return REG.byId.get(id); })
      .filter(function (p) { return p && firebridge.canAccessPage(p.id); });
    return accessiblePages;
  }

  function renderDefaultCard(wf) {
    var accessiblePages = pageChips(wf);
    if (!accessiblePages.length) return null;

    var card = document.createElement('a');
    card.className = 'wf-card';
    card.href = '#';
    card.dataset.id = wf.id;
    card.dataset.kind = 'default';
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
      (wf.description ? '<div class="wf-desc">' + escHtml(wf.description) + '</div>' : '') +
      '<div class="wf-pages">' + pageList + more + '</div>';

    card.addEventListener('click', function (e) {
      e.preventDefault();
      WorkflowState.setActive(wf.id, 'default');
      var first = accessiblePages[0];
      location.href = WorkflowState.decorateHref(first.href, wf.id);
    });
    return card;
  }

  function renderCustomCard(wf) {
    var accessiblePages = pageChips(wf);
    var card = document.createElement('div');
    card.className = 'wf-card wf-custom-card';
    card.dataset.id = wf.id;
    card.dataset.kind = 'custom';
    var pageList = accessiblePages.slice(0, 6).map(function (p) {
      return '<span class="wf-chip">' + escHtml(p.label) + '</span>';
    }).join('') || '<span class="wf-chip wf-chip-more">no accessible pages</span>';
    var more = accessiblePages.length > 6
      ? '<span class="wf-chip wf-chip-more">+' + (accessiblePages.length - 6) + ' more</span>'
      : '';
    card.innerHTML =
      '<div class="wf-card-head">' +
      '  <div class="wf-icon">' + escHtml(wf.icon || '⭐') + '</div>' +
      '  <div class="wf-titlebox">' +
      '    <div class="wf-label">' + escHtml(wf.label) + '</div>' +
      '    <div class="wf-pagecount">' + accessiblePages.length + ' page' +
              (accessiblePages.length === 1 ? '' : 's') + '</div>' +
      '  </div>' +
      '  <div class="wf-card-actions">' +
      '    <button class="btn btn-sm" data-action="rename">Rename</button>' +
      '    <button class="btn btn-sm" data-action="delete">Delete</button>' +
      '  </div>' +
      '</div>' +
      (wf.description ? '<div class="wf-desc">' + escHtml(wf.description) + '</div>' : '') +
      '<div class="wf-pages">' + pageList + more + '</div>';

    // Card body click → enter workflow. Rename / Delete buttons stop
    // propagation.
    card.addEventListener('click', function (e) {
      if (e.target.closest('[data-action]')) return;
      if (!accessiblePages.length) return;
      WorkflowState.setActive(wf.id, 'custom');
      var first = accessiblePages[0];
      location.href = WorkflowState.decorateHref(first.href, wf.id);
    });
    card.querySelector('[data-action="rename"]').addEventListener('click', function (e) {
      e.preventDefault(); e.stopPropagation();
      renameCustom(wf);
    });
    card.querySelector('[data-action="delete"]').addEventListener('click', function (e) {
      e.preventDefault(); e.stopPropagation();
      deleteCustom(wf);
    });
    return card;
  }

  function renderNewCustomCard() {
    var card = document.createElement('div');
    card.className = 'wf-card wf-new-card';
    card.innerHTML =
      '<div class="wf-card-head">' +
      '  <div class="wf-icon">+</div>' +
      '  <div class="wf-titlebox">' +
      '    <div class="wf-label">New custom workflow</div>' +
      '    <div class="wf-pagecount">Bundle pages around your task</div>' +
      '  </div>' +
      '</div>' +
      '<div class="wf-desc">Pick from the pages you have access to and save your own workflow under your account.</div>';
    card.addEventListener('click', function () { openBuilder(); });
    return card;
  }

  function render(defaults, custom) {
    var root = document.getElementById('workflow-root');
    if (!root) return;
    root.innerHTML = '';

    // Default workflows section.
    var defaultsSection = document.createElement('section');
    defaultsSection.className = 'wf-section';
    defaultsSection.innerHTML =
      '<h2 class="wf-section-title">Workflows</h2>' +
      '<p class="wf-section-sub">Pick a workflow to get a focused page strip on top of every page you visit. Each workflow is a curated bundle of related tools — leave anytime to return to the full nav.</p>';
    var grid = document.createElement('div');
    grid.className = 'wf-grid';
    var anyVisible = false;
    defaults.forEach(function (wf) {
      var card = renderDefaultCard(wf);
      if (card) { grid.appendChild(card); anyVisible = true; }
    });
    if (!anyVisible) {
      grid.innerHTML = '<div class="empty-state">No accessible workflows. Ask the admin to grant page access.</div>';
    }
    defaultsSection.appendChild(grid);
    root.appendChild(defaultsSection);

    // My workflows section.
    var customSection = document.createElement('section');
    customSection.className = 'wf-section';
    customSection.innerHTML =
      '<h2 class="wf-section-title">My workflows</h2>' +
      '<p class="wf-section-sub">Custom workflows you saved. Build new ones with the card below or by clicking <em>Save as custom</em> from any default workflow strip.</p>';
    var cgrid = document.createElement('div');
    cgrid.className = 'wf-grid';
    custom.forEach(function (wf) {
      var card = renderCustomCard(wf);
      if (card) cgrid.appendChild(card);
    });
    cgrid.appendChild(renderNewCustomCard());
    customSection.appendChild(cgrid);
    root.appendChild(customSection);
  }

  /* ── Builder modal: pick name + pages, save ── */

  function openBuilder() {
    var REG = window.PAGE_REGISTRY || { list: [] };
    var pages = REG.list.filter(function (p) { return firebridge.canAccessPage(p.id); });
    pages.sort(function (a, b) {
      return (a.group || '').localeCompare(b.group || '')
          || (a.label || '').localeCompare(b.label || '');
    });
    var picked = new Set();

    var back = document.createElement('div');
    back.className = 'ws-modal-back';
    back.addEventListener('click', function (e) { if (e.target === back) back.remove(); });
    var modal = document.createElement('div');
    modal.className = 'ws-modal';
    modal.innerHTML =
      '<h3>New custom workflow</h3>' +
      '<div class="ws-modal-sub">Pick the pages you want to bundle. You can edit the list anytime by entering the workflow and using the strip\'s <em>+ Add page</em> button.</div>' +
      '<label style="display:block;font-size:11px;text-transform:uppercase;letter-spacing:.4px;color:#6b7280;margin-bottom:4px;">Name</label>' +
      '<input type="text" id="wf-build-name" class="ws-modal-search" placeholder="e.g. Onboarding tasks" style="margin-bottom:10px;">' +
      '<input type="text" id="wf-build-search" class="ws-modal-search" placeholder="Filter pages…">' +
      '<div class="ws-modal-list" id="wf-build-list"></div>' +
      '<div class="ws-modal-sub" style="margin-top:6px;font-size:11px;"><span id="wf-build-count">0</span> selected</div>' +
      '<div class="ws-modal-actions">' +
      '  <button class="btn" id="wf-build-cancel">Cancel</button>' +
      '  <button class="btn btn-primary" id="wf-build-save">Create</button>' +
      '</div>';
    back.appendChild(modal);
    document.body.appendChild(back);

    var list = modal.querySelector('#wf-build-list');
    pages.forEach(function (p) {
      var row = document.createElement('label');
      row.className = 'ws-modal-row';
      row.style.cursor = 'pointer';
      row.innerHTML =
        '<div style="display:flex;align-items:center;gap:8px;grid-column:1;"><input type="checkbox" data-page-id="' + escHtml(p.id) + '" style="margin:0;"><span class="group">' + escHtml(p.group || '') + '</span></div>' +
        '<div class="label">' + escHtml(p.label) + '</div>';
      var cb = row.querySelector('input');
      cb.addEventListener('change', function () {
        if (cb.checked) picked.add(p.id); else picked.delete(p.id);
        modal.querySelector('#wf-build-count').textContent = String(picked.size);
      });
      list.appendChild(row);
    });
    modal.querySelector('#wf-build-search').addEventListener('input', function (e) {
      var q = (e.target.value || '').trim().toLowerCase();
      list.querySelectorAll('.ws-modal-row').forEach(function (r) {
        var text = r.textContent.toLowerCase();
        r.style.display = (!q || text.indexOf(q) >= 0) ? '' : 'none';
      });
    });
    modal.querySelector('#wf-build-cancel').addEventListener('click', function () { back.remove(); });
    modal.querySelector('#wf-build-save').addEventListener('click', async function () {
      var name = (modal.querySelector('#wf-build-name').value || '').trim();
      if (!name) { modal.querySelector('#wf-build-name').focus(); return; }
      if (!picked.size) { alert('Pick at least one page.'); return; }
      var slug = name.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '');
      if (!slug) { alert('Name must include letters or numbers.'); return; }
      var u = firebridge.getUser();
      if (!u) return;
      // Preserve picking order (set is insertion-ordered).
      var pageIds = Array.from(picked);
      try {
        await firebridge.db()
          .collection('userData').doc(u.uid)
          .collection('customWorkflows').doc(slug)
          .set({
            id: slug, label: name, icon: '⭐',
            description: '',
            pageIds: pageIds,
            createdAt: new Date(), updatedAt: new Date(),
          });
        if (window.toast) toast.show('Created "' + name + '".', 'ok');
        back.remove();
        boot();   // re-render the chooser
      } catch (err) {
        alert('Create failed: ' + err.message);
      }
    });
    modal.querySelector('#wf-build-name').focus();
  }

  function renameCustom(wf) {
    var newName = prompt('Rename "' + wf.label + '" to:', wf.label);
    if (newName == null) return;
    newName = newName.trim();
    if (!newName || newName === wf.label) return;
    var u = firebridge.getUser();
    if (!u) return;
    firebridge.db()
      .collection('userData').doc(u.uid)
      .collection('customWorkflows').doc(wf.id)
      .set({ label: newName, updatedAt: new Date() }, { merge: true })
      .then(function () { if (window.toast) toast.show('Renamed.', 'ok'); boot(); })
      .catch(function (err) { alert('Rename failed: ' + err.message); });
  }

  function deleteCustom(wf) {
    if (!confirm('Delete "' + wf.label + '"? This cannot be undone.')) return;
    var u = firebridge.getUser();
    if (!u) return;
    firebridge.db()
      .collection('userData').doc(u.uid)
      .collection('customWorkflows').doc(wf.id)
      .delete()
      .then(function () { if (window.toast) toast.show('Deleted.', 'ok'); boot(); })
      .catch(function (err) { alert('Delete failed: ' + err.message); });
  }

  document.addEventListener('DOMContentLoaded', boot);
})();
