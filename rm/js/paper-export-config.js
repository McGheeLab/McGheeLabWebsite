/* paper-export-config.js — Paper Export Workspace V3.231
 *
 * Renders the form on the left side of pages/paper-export.html. State
 * lives in a plain `config` object that the orchestrator (paper-export.js)
 * persists to Firestore at `paperExports/{paperId}`.
 *
 * Public API:
 *   PaperExportConfig.populateTemplateSelect(selectEl, currentId)
 *   PaperExportConfig.renderAddons(containerEl, enabledIds, onChange)
 *   PaperExportConfig.bindOverrides(formRoot, overrides, onChange)
 *   PaperExportConfig.checkConflicts(templateId, enabledAddonIds) → [warnings]
 *
 * The add-on registry itself lives in paper-export-tex.js
 * (`window.PaperExportTex.ADDON_REGISTRY`) so the build pipeline and the
 * UI consume the same source of truth.
 */

(function () {
  /* Known templates registered in data/paper-templates/. The list is
   * tiny today (Phase 1 ships mebp-journal only) — adding a journal is
   * a future PR that drops a JSON in that directory and adds it here.
   * Loading these client-side avoids a Firestore round-trip per page
   * since they're small (<2 KB each) and rarely change. */
  var KNOWN_TEMPLATES = [
    { id: 'mebp-journal', label: 'Journal article (MEBP / SLAS Technology)' },
  ];

  /* ── Template select ── */

  async function populateTemplateSelect(selectEl, currentId) {
    selectEl.innerHTML = '';
    KNOWN_TEMPLATES.forEach(function (t) {
      var opt = document.createElement('option');
      opt.value = t.id;
      opt.textContent = t.label;
      if (currentId && currentId === t.id) opt.selected = true;
      selectEl.appendChild(opt);
    });
    /* If currentId is set but not in KNOWN_TEMPLATES, append it anyway
     * so the page doesn't silently swap the user's saved choice. */
    if (currentId && !KNOWN_TEMPLATES.some(function (t) { return t.id === currentId; })) {
      var opt = document.createElement('option');
      opt.value = currentId;
      opt.textContent = currentId + ' (unregistered)';
      opt.selected = true;
      selectEl.appendChild(opt);
    }
  }

  async function loadTemplateDescription(templateId) {
    try {
      var data = await api.load('paper-templates/' + templateId + '.json');
      return (data && data.description) || '';
    } catch (e) {
      return '';
    }
  }

  /* ── Add-on toggle list ── */

  function renderAddons(containerEl, enabledIds, onChange) {
    containerEl.innerHTML = '';
    var enabled = new Set(enabledIds || []);
    var registry = (window.PaperExportTex && window.PaperExportTex.ADDON_REGISTRY) || [];
    registry.forEach(function (addon) {
      var row = document.createElement('label');
      row.className = 'px-addon';
      var cb = document.createElement('input');
      cb.type = 'checkbox';
      cb.value = addon.id;
      cb.checked = enabled.has(addon.id);
      cb.addEventListener('change', function () {
        var ids = Array.prototype.slice.call(
          containerEl.querySelectorAll('input[type="checkbox"]:checked')
        ).map(function (el) { return el.value; });
        onChange(ids);
      });
      row.appendChild(cb);
      var textWrap = document.createElement('div');
      var lbl = document.createElement('div');
      lbl.className = 'px-addon-label';
      lbl.textContent = addon.label;
      textWrap.appendChild(lbl);
      if (addon.notes) {
        var notes = document.createElement('div');
        notes.className = 'px-addon-notes';
        notes.textContent = addon.notes;
        textWrap.appendChild(notes);
      }
      row.appendChild(textWrap);
      containerEl.appendChild(row);
    });
  }

  /* ── Style override binding ── */

  function bindOverrides(formRoot, overrides, onChange) {
    var fig = (overrides && overrides.figure) || {};
    var tab = (overrides && overrides.table) || {};
    var eq  = (overrides && overrides.equation) || {};

    function $(id) { return formRoot.querySelector('#' + id); }

    $('px-fig-placement').value = fig.placement || '';
    $('px-fig-width').value     = fig.default_width || '';
    /* Booleans persist as strings in the DOM (option values are 'true'/'false'/'') */
    $('px-tab-booktabs').value  =
      (typeof tab.use_booktabs === 'boolean') ? String(tab.use_booktabs) : '';
    $('px-tab-placement').value = tab.placement || '';
    $('px-eq-display').value    = eq.display || '';

    function emit() {
      var out = {};
      var p = $('px-fig-placement').value;
      var w = $('px-fig-width').value;
      if (p || w) out.figure = {};
      if (p) out.figure.placement = p;
      if (w) out.figure.default_width = w;

      var tp = $('px-tab-placement').value;
      var tb = $('px-tab-booktabs').value;
      if (tp || tb) out.table = {};
      if (tp) out.table.placement = tp;
      if (tb) out.table.use_booktabs = (tb === 'true');

      var ed = $('px-eq-display').value;
      if (ed) out.equation = { display: ed };
      onChange(out);
    }

    ['px-fig-placement','px-fig-width','px-tab-booktabs','px-tab-placement','px-eq-display']
      .forEach(function (id) {
        $(id).addEventListener('change', emit);
      });
  }

  /* ── Conflict detection (hard rules only) ── */

  function checkConflicts(templateId, enabledAddonIds) {
    var warnings = [];
    var registry = (window.PaperExportTex && window.PaperExportTex.ADDON_REGISTRY) || [];
    var byId = {};
    registry.forEach(function (a) { byId[a.id] = a; });
    var enabled = new Set(enabledAddonIds || []);

    enabled.forEach(function (id) {
      var addon = byId[id];
      if (!addon) return;
      var ic = addon.incompatible_with || {};
      if (templateId && (ic.templates || []).indexOf(templateId) >= 0) {
        warnings.push('“' + addon.label + '” is incompatible with template "' + templateId + '".');
      }
      (ic.addons || []).forEach(function (other) {
        if (enabled.has(other)) {
          warnings.push('“' + addon.label + '” conflicts with “' + (byId[other] && byId[other].label || other) + '”.');
        }
      });
    });
    return warnings;
  }

  window.PaperExportConfig = {
    populateTemplateSelect: populateTemplateSelect,
    loadTemplateDescription: loadTemplateDescription,
    renderAddons: renderAddons,
    bindOverrides: bindOverrides,
    checkConflicts: checkConflicts,
    KNOWN_TEMPLATES: KNOWN_TEMPLATES,
  };
})();
