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
  /* Known templates registered in rm/data/paper-templates/ (static files
   * FTP-deployed with the site — V3.341). Adding a journal is a data PR:
   * drop a JSON in that directory and add a row here. `group` renders as
   * an <optgroup> in the picker. */
  /* V3.419 — `types` gates the list by the paper's document type
   * (journal | grant | editorial | book-chapter). Grant formats begin
   * with NSF (V3.911). A type with
   * NO matching templates falls back to the full list (never a dead
   * picker). */
  var KNOWN_TEMPLATES = [
    { id: 'mebp-journal',        label: 'SLAS Technology (MEBP style)',       group: 'Lab journals', types: ['journal'] },
    { id: 'nature',              label: 'Nature family',                      group: 'Publishers', types: ['journal'] },
    { id: 'science',             label: 'Science / AAAS',                     group: 'Publishers', types: ['journal'] },
    { id: 'plos',                label: 'PLOS',                               group: 'Publishers', types: ['journal'] },
    { id: 'elsevier',            label: 'Elsevier',                           group: 'Publishers', types: ['journal'] },
    { id: 'ieee',                label: 'IEEE journal (IEEEtran)',            group: 'Publishers', types: ['journal'] },
    { id: 'acs',                 label: 'ACS journals',                       group: 'Publishers', types: ['journal'] },
    { id: 'pnas-new',            label: 'PNAS (pnas-new class)',              group: 'Publishers', types: ['journal'] },
    { id: 'aps-revtex',          label: 'Physical Review / APS (REVTeX)',     group: 'Publishers', types: ['journal'] },   // V3.907
    { id: 'preprint-numeric',    label: 'Preprint — numeric citations',       group: 'Preprints', types: ['journal', 'editorial', 'book-chapter'] },
    { id: 'preprint-authoryear', label: 'Preprint — author-year citations',   group: 'Preprints', types: ['journal', 'editorial', 'book-chapter'] },
    { id: 'nsf-career',          label: 'NSF proposal (CAREER, PAPPG)',       group: 'Grants', types: ['grant'] },   // V3.911
  ];

  /* ── Template select ── */

  async function populateTemplateSelect(selectEl, currentId, paperType) {
    selectEl.innerHTML = '';
    /* V3.419 — filter by the paper's document type; empty result set
     * (grant today) falls back to everything so the picker never dies. */
    var pool = KNOWN_TEMPLATES;
    if (paperType) {
      var hits = KNOWN_TEMPLATES.filter(function (t) {
        return (t.types || ['journal']).indexOf(paperType) >= 0;
      });
      if (hits.length) pool = hits;
    }
    /* V3.341 — group rows into <optgroup>s, preserving first-appearance
     * group order. */
    var groups = [];
    var byGroup = {};
    pool.forEach(function (t) {
      var g = t.group || 'Templates';
      if (!byGroup[g]) { byGroup[g] = []; groups.push(g); }
      byGroup[g].push(t);
    });
    groups.forEach(function (g) {
      var og = document.createElement('optgroup');
      og.label = g;
      byGroup[g].forEach(function (t) {
        var opt = document.createElement('option');
        opt.value = t.id;
        opt.textContent = t.label;
        if (currentId && currentId === t.id) opt.selected = true;
        og.appendChild(opt);
      });
      selectEl.appendChild(og);
    });
    /* If currentId is set but not in the list shown, append it anyway so
     * the page doesn't silently swap the user's saved choice (V3.911: a
     * grant that uses a journal template, now that grants have their own
     * list). */
    if (currentId && !pool.some(function (t) { return t.id === currentId; })) {
      var known = KNOWN_TEMPLATES.filter(function (t) { return t.id === currentId; })[0];
      var opt = document.createElement('option');
      opt.value = currentId;
      opt.textContent = known ? known.label : currentId + ' (unregistered)';
      opt.selected = true;
      selectEl.appendChild(opt);
    }
  }

  async function loadTemplateDescription(templateId) {
    /* V3.341 — route through PaperExportTex.fetchTemplate (static file
     * first, legacy api.load fallback) so this works in production. */
    try {
      var data = await window.PaperExportTex.fetchTemplate(templateId);
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

  /* ── V3.346 — Authors & affiliations editor ──
   *
   * Renders into #px-authors. `cfg` = { authors: [{name,
   * affiliationIdx: [0-based…], corresponding, email}], affiliations:
   * [string…] }. Every input change re-emits the full cfg via
   * onChange; the orchestrator persists it to paperExports/{paperId}
   * and buildBundle renders it into {{AUTHOR_BLOCK}}. */
  /* The 14 CRediT contributor roles (credit.niso.org). Stored per author
   * as `credit: [keys]`; the statement generator + elsarticle emission
   * read them. */
  var CREDIT_ROLES = [
    'Conceptualization', 'Data curation', 'Formal analysis',
    'Funding acquisition', 'Investigation', 'Methodology',
    'Project administration', 'Resources', 'Software', 'Supervision',
    'Validation', 'Visualization', 'Writing – original draft',
    'Writing – review & editing',
  ];

  var ORCID_RE = /^\d{4}-\d{4}-\d{4}-\d{3}[\dX]$/;

  function bindAuthors(containerEl, cfg, onChange, readOnly) {
    var authors = (cfg && Array.isArray(cfg.authors)) ? JSON.parse(JSON.stringify(cfg.authors)) : [];
    var affils = (cfg && Array.isArray(cfg.affiliations)) ? cfg.affiliations.slice() : [];
    var openCreditIdx = -1;   // keep one author's CRediT panel open across re-renders

    function emit() {
      onChange({ authors: authors, affiliations: affils });
    }

    function render() {
      containerEl.innerHTML = '';

      var affHead = document.createElement('div');
      affHead.className = 'px-authors-subhead';
      affHead.textContent = 'Affiliations';
      containerEl.appendChild(affHead);
      affils.forEach(function (aff, i) {
        var row = document.createElement('div');
        row.className = 'px-affil-row';
        var num = document.createElement('span');
        num.className = 'px-affil-num';
        num.textContent = (i + 1) + '.';
        row.appendChild(num);
        var input = document.createElement('input');
        input.type = 'text';
        input.value = aff;
        input.placeholder = 'Department, Institution, City, Country';
        input.disabled = !!readOnly;
        input.addEventListener('change', function () { affils[i] = input.value.trim(); emit(); });
        row.appendChild(input);
        if (!readOnly) {
          var del = document.createElement('button');
          del.type = 'button'; del.className = 'btn btn-sm'; del.textContent = '✕';
          del.title = 'Remove affiliation';
          del.addEventListener('click', function () {
            affils.splice(i, 1);
            /* Re-point author affiliation indices past the removed one. */
            authors.forEach(function (a) {
              a.affiliationIdx = [].concat(a.affiliationIdx != null ? a.affiliationIdx : [])   // V3.916 — a lone number too
                .filter(function (x) { return x !== i; })
                .map(function (x) { return x > i ? x - 1 : x; });
            });
            emit(); render();
          });
          row.appendChild(del);
        }
        containerEl.appendChild(row);
      });
      if (!readOnly) {
        var addAff = document.createElement('button');
        addAff.type = 'button'; addAff.className = 'btn btn-sm px-authors-add';
        addAff.textContent = '+ affiliation';
        addAff.addEventListener('click', function () { affils.push(''); emit(); render(); });
        containerEl.appendChild(addAff);
      }

      var auHead = document.createElement('div');
      auHead.className = 'px-authors-subhead';
      auHead.textContent = 'Authors (in order)';
      containerEl.appendChild(auHead);
      if (!authors.length) {
        var empty = document.createElement('div');
        empty.className = 'px-authors-empty';
        empty.textContent = 'None yet — the export falls back to the paper\'s lead author with placeholder affiliation text.';
        containerEl.appendChild(empty);
      }
      authors.forEach(function (a, i) {
        var row = document.createElement('div');
        row.className = 'px-author-row';
        var name = document.createElement('input');
        name.type = 'text'; name.className = 'px-author-name';
        name.value = a.name || ''; name.placeholder = 'Full name';
        name.disabled = !!readOnly;
        name.addEventListener('change', function () { a.name = name.value.trim(); emit(); });
        row.appendChild(name);
        var affIn = document.createElement('input');
        affIn.type = 'text'; affIn.className = 'px-author-affnums';
        /* V3.916 — one affiliation stored as a number (a bundle written that way) killed the whole page */
        affIn.value = [].concat(a.affiliationIdx != null ? a.affiliationIdx : []).map(function (x) { return x + 1; }).join(',');
        affIn.placeholder = '1,2';
        affIn.title = 'Affiliation numbers (comma-separated, from the list above)';
        affIn.disabled = !!readOnly;
        affIn.addEventListener('change', function () {
          a.affiliationIdx = affIn.value.split(',')
            .map(function (t) { return parseInt(t.trim(), 10) - 1; })
            .filter(function (n) { return !isNaN(n) && n >= 0 && n < affils.length; });
          emit(); render();
        });
        row.appendChild(affIn);
        var corLbl = document.createElement('label');
        corLbl.className = 'px-author-cor';
        var cor = document.createElement('input');
        cor.type = 'checkbox'; cor.checked = !!a.corresponding; cor.disabled = !!readOnly;
        cor.addEventListener('change', function () { a.corresponding = cor.checked; emit(); render(); });
        corLbl.appendChild(cor);
        corLbl.appendChild(document.createTextNode(' '));
        corLbl.appendChild(ICON.el('envelope'));
        corLbl.title = 'Corresponding author';
        row.appendChild(corLbl);
        if (a.corresponding) {
          var email = document.createElement('input');
          email.type = 'text'; email.className = 'px-author-email';
          email.value = a.email || ''; email.placeholder = 'email@institution.edu';
          email.disabled = !!readOnly;
          email.addEventListener('change', function () { a.email = email.value.trim(); emit(); });
          row.appendChild(email);
        }
        /* ORCID iD — rendered as \orcidlink{} beside the name on compile. */
        var orcid = document.createElement('input');
        orcid.type = 'text'; orcid.className = 'px-author-orcid';
        orcid.value = a.orcid || ''; orcid.placeholder = '0000-0000-0000-0000';
        orcid.title = 'ORCID iD — adds the ORCID icon link beside the name in the PDF';
        orcid.disabled = !!readOnly;
        orcid.addEventListener('change', function () {
          var v = orcid.value.trim();
          if (v && !ORCID_RE.test(v)) {
            orcid.classList.add('px-invalid');
            orcid.title = 'ORCID iDs look like 0000-0002-1825-0097';
            return;
          }
          orcid.classList.remove('px-invalid');
          a.orcid = v;
          emit();
        });
        row.appendChild(orcid);
        /* CRediT roles — toggle panel of the 14 roles. */
        if (!readOnly) {
          var crBtn = document.createElement('button');
          crBtn.type = 'button'; crBtn.className = 'btn btn-sm px-author-credit-btn';
          var nRoles = (a.credit || []).length;
          crBtn.textContent = 'CRediT' + (nRoles ? ' (' + nRoles + ')' : '');
          crBtn.title = 'Contributor roles (CRediT taxonomy)';
          crBtn.addEventListener('click', function () {
            openCreditIdx = openCreditIdx === i ? -1 : i;
            render();
          });
          row.appendChild(crBtn);
        }
        if (!readOnly) {
          var del2 = document.createElement('button');
          del2.type = 'button'; del2.className = 'btn btn-sm'; del2.textContent = '✕';
          del2.title = 'Remove author';
          del2.addEventListener('click', function () { authors.splice(i, 1); openCreditIdx = -1; emit(); render(); });
          row.appendChild(del2);
        }
        containerEl.appendChild(row);
        if (!readOnly && openCreditIdx === i) {
          var crPanel = document.createElement('div');
          crPanel.className = 'px-credit-panel';
          CREDIT_ROLES.forEach(function (role) {
            var lbl = document.createElement('label');
            lbl.className = 'px-credit-role';
            var cb = document.createElement('input');
            cb.type = 'checkbox';
            cb.checked = (a.credit || []).indexOf(role) >= 0;
            cb.addEventListener('change', function () {
              var set = (a.credit || []).slice();
              if (cb.checked) { if (set.indexOf(role) < 0) set.push(role); }
              else set = set.filter(function (x) { return x !== role; });
              a.credit = set;
              emit();
              /* Update the count on the button without collapsing. */
              crBtn.textContent = 'CRediT' + (set.length ? ' (' + set.length + ')' : '');
            });
            lbl.appendChild(cb);
            lbl.appendChild(document.createTextNode(' ' + role));
            crPanel.appendChild(lbl);
          });
          containerEl.appendChild(crPanel);
        }
      });
      if (!readOnly) {
        var addAu = document.createElement('button');
        addAu.type = 'button'; addAu.className = 'btn btn-sm px-authors-add';
        addAu.textContent = '+ author';
        addAu.addEventListener('click', function () {
          authors.push({ name: '', affiliationIdx: affils.length ? [0] : [], corresponding: !authors.length, email: '' });
          emit(); render();
        });
        containerEl.appendChild(addAu);
      }
    }
    render();
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

  /* Compose the CRediT authorship statement from per-author roles:
   * "A.B.M.: Conceptualization, Methodology; C.D.: Software." Authors
   * without roles are skipped; '' when nobody has roles. */
  function creditStatement(authors) {
    var parts = [];
    (authors || []).forEach(function (a) {
      var roles = (a && Array.isArray(a.credit)) ? a.credit : [];
      if (!roles.length || !a.name) return;
      var initials = String(a.name).trim().split(/\s+/)
        .map(function (w) { return w.charAt(0).toUpperCase() + '.'; }).join('');
      parts.push(initials + ': ' + roles.join(', '));
    });
    return parts.length ? parts.join('; ') + '.' : '';
  }

  window.PaperExportConfig = {
    populateTemplateSelect: populateTemplateSelect,
    bindAuthors: bindAuthors,
    loadTemplateDescription: loadTemplateDescription,
    renderAddons: renderAddons,
    bindOverrides: bindOverrides,
    checkConflicts: checkConflicts,
    KNOWN_TEMPLATES: KNOWN_TEMPLATES,
    CREDIT_ROLES: CREDIT_ROLES,
    creditStatement: creditStatement,
  };
})();
