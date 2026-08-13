/* cv-onboarding.js — "Get started" guidance for the CV editor (V3.357).
 *
 * Not a modal carousel: a persistent checklist rail whose steps deep-link
 * the editor's EXISTING flows (profile pane, library pull, ORCID, BibTeX,
 * preview). Completion is DERIVED from the document contents — the only
 * stored state is cv_meta.onboarding_dismissed and cv_meta.last_export_at
 * (both additive to the cvData contract).
 *
 * Also owns the per-section empty states (example line + the right import
 * buttons instead of a bare "no entries yet").
 *
 * Consumed by cv-editor.js:
 *   CV_ONBOARDING.render(ctx)        → rail node | null (hidden when
 *                                      dismissed or complete)
 *   CV_ONBOARDING.healthChip(ctx)    → toolbar chip node ("CV health k/4")
 *   CV_ONBOARDING.emptyStateFor(sectionKey, ctx) → empty-state node
 * ctx = { doc, actions: { goSection, addEntry, pull, orcid, bibtex,
 *         preview }, setDismissed(bool) }
 */

var CV_ONBOARDING = (function () {

  /* One believable example line per section — shows students what a
   * finished entry reads like before they open the blank form. */
  var EXAMPLES = {
    journals: 'Smith J, McGhee A. Traction force microscopy of engineered microtissues. Biophysical Journal 2025;124(3):411–420. doi:10.1016/…',
    conferences: 'Smith J, McGhee A. 3D-bioprinted granule scaffolds. BMES Annual Meeting, Phoenix AZ, 2025 (Poster).',
    books: 'McGhee A. Microfluidic organ models. In: Advances in Biofabrication, Springer, 2024.',
    patents: 'US 11,234,567. Microfluidic droplet sorter. Smith J, McGhee A. Granted 2024.',
    presentations: 'Engineering soft tissue mechanics. Invited seminar, University of Arizona BME, 2025-03-12.',
    grants: 'NIH R01 — Granule-based tissue scaffolds (Co-I), 2024–2028.',
    awards: 'Outstanding Graduate Researcher, College of Engineering, 2025.',
    service: 'Reviewer, Lab on a Chip (2024–present).',
    students: 'Jane Doe, BSc — Honors thesis: hydrogel rheology (2024–2025).',
    courses: 'BME 310 Biomechanics — Teaching Assistant, Fall 2025.',
    software: 'TFM-Toolkit — open-source traction force analysis (Python), 2025.',
  };

  /* Sections a student should round out after publications land. */
  var ROUND_OUT_KEYS = ['awards', 'presentations', 'service', 'grants', 'students', 'courses', 'software', 'patents', 'books'];

  function steps(doc) {
    var p = doc.profile || {};
    var pubs = (doc.journals || []).length + (doc.conferences || []).length;
    var rounded = ROUND_OUT_KEYS.filter(function (k) { return (doc[k] || []).length > 0; }).length;
    var meta = doc.cv_meta || {};
    return [
      {
        key: 'profile',
        label: 'Fill in your profile',
        detail: 'Name, title, and institution head every export.',
        done: !!(p.name && (p.title || p.institution)),
        actionLabel: 'Open profile',
        action: 'profile',
      },
      {
        key: 'pubs',
        label: 'Import your publications',
        detail: 'Pull them from the lab library or ORCID — no typing.',
        done: pubs > 0,
        actionLabel: 'Import…',
        action: 'import',
      },
      {
        key: 'roundout',
        label: 'Round out two more sections',
        detail: 'Awards, presentations, service, teaching…',
        done: rounded >= 2,
        actionLabel: 'Add awards',
        action: 'roundout',
      },
      {
        key: 'export',
        label: 'Preview & export',
        detail: 'Check the live preview, then download PDF or Word.',
        done: !!meta.last_export_at,
        actionLabel: 'Preview',
        action: 'preview',
      },
    ];
  }

  function doneCount(doc) {
    return steps(doc).filter(function (s) { return s.done; }).length;
  }

  function runAction(action, ctx) {
    var a = ctx.actions || {};
    if (action === 'profile') a.goSection && a.goSection('profile');
    else if (action === 'import') a.pull && a.pull();
    else if (action === 'roundout') a.goSection && a.goSection('awards');
    else if (action === 'preview') a.preview && a.preview();
  }

  function render(ctx) {
    var doc = ctx.doc;
    var meta = doc.cv_meta || {};
    var list = steps(doc);
    var done = list.filter(function (s) { return s.done; }).length;
    if (meta.onboarding_dismissed || done === list.length) return null;

    var rail = document.createElement('div');
    rail.className = 'cve-onboard';
    var head = document.createElement('div');
    head.className = 'cve-onboard-head';
    head.innerHTML = '<span class="cve-onboard-title">🚀 Get your CV started</span>' +
      '<span class="cve-onboard-progress">' + done + '/' + list.length + '</span>';
    var dismiss = document.createElement('button');
    dismiss.className = 'cve-onboard-dismiss';
    dismiss.textContent = '✕';
    dismiss.title = 'Hide this checklist (the toolbar chip brings it back)';
    dismiss.addEventListener('click', function () { ctx.setDismissed(true); });
    head.appendChild(dismiss);
    rail.appendChild(head);

    var row = document.createElement('div');
    row.className = 'cve-onboard-steps';
    list.forEach(function (s) {
      var step = document.createElement('div');
      step.className = 'cve-onboard-step' + (s.done ? ' done' : '');
      var mark = s.done ? '✓' : '○';
      step.innerHTML = '<div class="cve-onboard-mark">' + mark + '</div>' +
        '<div class="cve-onboard-body"><div class="cve-onboard-label">' + s.label + '</div>' +
        '<div class="cve-onboard-detail">' + s.detail + '</div></div>';
      if (!s.done) {
        var btn = document.createElement('button');
        btn.className = 'btn';
        btn.textContent = s.actionLabel;
        btn.addEventListener('click', function () { runAction(s.action, ctx); });
        step.appendChild(btn);
      }
      row.appendChild(step);
    });
    rail.appendChild(row);
    return rail;
  }

  /* Toolbar chip — always available; reopens the rail when dismissed. */
  function healthChip(ctx) {
    var list = steps(ctx.doc);
    var done = list.filter(function (s) { return s.done; }).length;
    var chip = document.createElement('button');
    chip.className = 'cve-health-chip' + (done === list.length ? ' complete' : '');
    chip.textContent = done === list.length ? 'CV ✓' : 'CV health ' + done + '/' + list.length;
    chip.title = done === list.length
      ? 'All set — profile, publications, extra sections, and an export.'
      : 'Missing: ' + list.filter(function (s) { return !s.done; }).map(function (s) { return s.label.toLowerCase(); }).join(' · ');
    chip.addEventListener('click', function () { ctx.setDismissed(false); });
    return chip;
  }

  /* Per-section empty state: example line + the right starting actions. */
  function emptyStateFor(sectionKey, ctx) {
    var a = ctx.actions || {};
    var empty = document.createElement('div');
    empty.className = 'cve-empty';
    var label = (typeof CV_SECTION_LABELS !== 'undefined' && CV_SECTION_LABELS[sectionKey]) || sectionKey;
    var html = '<div style="font-weight:600;color:#374151;margin-bottom:4px">No ' + label.toLowerCase() + ' yet</div>';
    if (EXAMPLES[sectionKey]) {
      html += '<div style="font-size:12px;color:#9ca3af;font-style:italic;max-width:520px;margin:0 auto 12px">A finished entry looks like:<br>“' + EXAMPLES[sectionKey] + '”</div>';
    }
    empty.innerHTML = html;
    var btnRow = document.createElement('div');
    btnRow.style.cssText = 'display:flex;gap:8px;justify-content:center;flex-wrap:wrap';
    function mk(label, fn, primary) {
      var b = document.createElement('button');
      b.className = 'btn' + (primary ? ' btn-primary' : '');
      b.textContent = label;
      b.addEventListener('click', fn);
      return b;
    }
    if (sectionKey === 'journals' || sectionKey === 'conferences') {
      if (a.pull) btnRow.appendChild(mk('📚 Pull from library', a.pull, true));
      if (a.orcid) btnRow.appendChild(mk('⊕ Import from ORCID', a.orcid));
      if (a.bibtex) btnRow.appendChild(mk('⇓ Paste BibTeX', a.bibtex));
      if (a.addEntry) btnRow.appendChild(mk('+ Add manually', a.addEntry));
    } else {
      if (a.addEntry) btnRow.appendChild(mk('+ Add your first entry', a.addEntry, true));
    }
    empty.appendChild(btnRow);
    return empty;
  }

  return { render: render, healthChip: healthChip, emptyStateFor: emptyStateFor, steps: steps, doneCount: doneCount };
})();
