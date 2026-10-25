/* paper-subdocs.js — submission documents (S-β of Paper Builder III).
 *
 * Cover letter / suggested reviewers / rebuttal live IN the paper's
 * section map (kinds registered in V3.448; excluded from the manuscript
 * by resolveSectionCommand) and compile as SEPARATE PDFs through
 * dedicated minimal templates:
 *
 *   cover_letter → rm-cover-letter.json  (letter; the Suggested
 *                  Reviewers section folds in when present)
 *   rebuttal     → rm-rebuttal.json      (point-by-point; own refs.bib)
 *
 * buildSubdocBundle() reuses PaperExportTex.buildBundle with
 * opts.sectionFilter — citations / assets / stash follow the filtered
 * tree. Manuscript-only addons (anonymize — a cover letter must stay
 * signed) are never forwarded.
 *
 * Public API (window.PaperSubdocs):
 *   DOCS                                  — [{docKind, label, kinds, templateId}]
 *   sectionsPresent(yDoc, docKind)        — {present, hasContent}
 *   buildSubdocBundle({docKind, yDoc, authorsCfg, fullItemsByKey,
 *                      leadAuthor, paperId, titleOverride}) → bundle
 */
(function () {
  'use strict';

  var DOCS = [
    {
      docKind: 'cover_letter',
      label: 'Cover letter',
      hint: 'Compiled from the Cover Letter section; Suggested Reviewers append when that section exists.',
      kinds: ['cover_letter', 'suggested_reviewers'],
      templateId: 'rm-cover-letter',
      types: ['journal', 'grant'],
    },
    {
      docKind: 'rebuttal',
      label: 'Response to reviewers',
      hint: 'Point-by-point rebuttal — use subheadings for Reviewer 1 / 2 and lists for each point.',
      kinds: ['rebuttal'],
      templateId: 'rm-rebuttal',
      types: ['journal'],
    },
  ];

  /* V3.465 — grant "attached documents". Each compiles standalone from
   * its one in-paper section through the shared rm-grant-attachment
   * template (a plain single-column article). `uploadOnly: true` marks
   * artifacts produced OUTSIDE the editor (SciENcv biosketch / current &
   * pending, the COA .xlsx, the Research.gov budget form) — the Grant
   * Docs page shows only an upload slot for those, no compile/zip. The
   * rest are prose the editor authors, so they get .zip source download
   * now and (after the DOC_KINDS server gate is extended + redeployed)
   * PDF compile. docKind === the section kind for all grant entries. */
  var GRANT_DOCS = [
    { kind: 'project_summary',        label: 'Project Summary' },
    { kind: 'specific_aims',          label: 'Specific Aims' },
    { kind: 'research_strategy',      label: 'Research Strategy' },
    { kind: 'facilities',             label: 'Facilities, Equipment & Other Resources' },
    { kind: 'budget_justification',   label: 'Budget Justification' },
    { kind: 'synergistic_activities', label: 'Synergistic Activities' },
    { kind: 'data_management_plan',   label: 'Data Management & Sharing Plan' },
    { kind: 'mentoring_plan',         label: 'Mentoring Plan' },
    { kind: 'resource_sharing',       label: 'Resource Sharing Plan' },
    { kind: 'pecase_statement',       label: 'PECASE Eligibility Statement' },
    { kind: 'letters_of_support',     label: 'Letters of Support / Collaboration' },
    { kind: 'vertebrate_animals',     label: 'Vertebrate Animals' },
    { kind: 'human_subjects',         label: 'Human Subjects' },
    { kind: 'select_agents',          label: 'Select Agents' },
    // Upload-only (produced in SciENcv / NSF Excel / Research.gov):
    { kind: 'biosketch',              label: 'Biographical Sketch',        uploadOnly: true },
    { kind: 'current_pending',        label: 'Current & Pending Support',  uploadOnly: true },
    { kind: 'collaborators_coa',      label: 'Collaborators & Other Affiliations', uploadOnly: true },
    { kind: 'budget',                 label: 'Budget',                     uploadOnly: true },
  ];
  GRANT_DOCS.forEach(function (g) {
    DOCS.push({
      docKind: g.kind,
      label: g.label,
      hint: '',
      kinds: [g.kind],
      templateId: 'rm-grant-attachment',
      types: ['grant'],
      uploadOnly: !!g.uploadOnly,
    });
  });

  function _docFor(docKind) {
    for (var i = 0; i < DOCS.length; i++) if (DOCS[i].docKind === docKind) return DOCS[i];
    return null;
  }

  /* Does the paper carry the doc's section(s), and any real content? */
  function sectionsPresent(yDoc, docKind) {
    var doc = _docFor(docKind);
    if (!doc || !yDoc || !window.PaperExportTex) return { present: false, hasContent: false };
    var tree = window.PaperExportTex.paperTreeFromYDoc(yDoc);
    var present = false, hasContent = false;
    (tree.sections || []).forEach(function (sec) {
      if (doc.kinds.indexOf(sec.kind) < 0) return;
      present = true;
      (sec.children || []).forEach(function (b) {
        if (String(b.body || '').trim()) hasContent = true;
      });
    });
    return { present: present, hasContent: hasContent };
  }

  function buildSubdocBundle(opts) {
    var doc = _docFor(opts.docKind);
    if (!doc) return Promise.reject(new Error('Unknown submission doc: ' + opts.docKind));
    return window.PaperExportTex.fetchTemplate(doc.templateId).then(function (template) {
      return window.PaperExportTex.buildBundle({
        paperId: opts.paperId,
        template: template,
        overrides: {},
        addons: [],                       // anonymize & co. never apply
        buildTarget: 'preprint',
        yDoc: opts.yDoc,
        sectionFilter: function (sec) { return doc.kinds.indexOf(sec.kind) >= 0; },
        authorsCfg: opts.authorsCfg || null,
        fullItemsByKey: opts.fullItemsByKey || null,
        leadAuthor: opts.leadAuthor || '',
        titleOverride: opts.titleOverride,
      });
    });
  }

  /* ── V3.911 / V3.914 — a funder's documents, set in the grant's look ──
   * A grant template with a `grant` block (nsf-career) lists the
   * documents NSF takes as separate uploads. Each compiles from the
   * paper's own template — same look, fonts, margins, the paper's
   * lookOverrides — with only its sections, the title hidden, and the
   * section label as its heading. References Cited is the bibliography
   * alone, numbered in the order the Project Description first cites. */
  function grantDocs(template) {
    var g = template && template.grant;
    if (!g || !Array.isArray(g.documents)) return [];
    return g.documents.filter(function (d) { return !d.narrative; }).map(function (d) {
      return { docKind: 'grant_' + d.key, key: d.key, label: d.label, kinds: d.kinds || [], references: !!d.references,
        page_limit: d.page_limit || null, note: d.note || '', grant: true, templateId: template.id + '#' + d.key };
    });
  }
  function _clone(o) { return JSON.parse(JSON.stringify(o)); }
  /* the citation keys in the order LaTeX writes them to the .aux: main.tex
   * with each \input{sections/…} expanded where it stands */
  function citeOrder(files) {
    var byPath = {};
    files.forEach(function (f) { byPath[f.relpath] = f.content; });
    var keys = [], seen = {};
    function scan(text, depth) {
      if (depth > 4) return;
      var re = /\\input\{([^}]+)\}|\\(?:cite[a-z]*|nocite)\*?(?:\[[^\]]*\])*\{([^}]*)\}/g, m;
      while ((m = re.exec(text))) {
        if (m[1]) {
          var pth = m[1].replace(/\.tex$/, '') + '.tex';
          if (byPath[pth] != null) scan(byPath[pth], depth + 1);
        } else {
          m[2].split(',').forEach(function (k) {
            k = k.trim();
            if (k && !seen[k]) { seen[k] = true; keys.push(k); }
          });
        }
      }
    }
    var main = files.filter(function (f) { return /(^|\/)main\.tex$/.test(f.relpath); })[0] || files[0];
    var body = main.content;
    var b = body.indexOf('\\begin{document}');
    scan(b >= 0 ? body.slice(b) : body, 0);
    return keys;
  }
  function buildGrantDocBundle(opts) {
    var template = opts.template;
    var doc = grantDocs(template).filter(function (d) { return d.docKind === opts.docKind || d.key === opts.docKind; })[0];
    if (!doc) return Promise.reject(new Error('Unknown grant document: ' + opts.docKind));
    var common = {
      paperId: opts.paperId, overrides: {}, addons: [], buildTarget: 'submission',
      yDoc: opts.yDoc, authorsCfg: opts.authorsCfg || null, fullItemsByKey: opts.fullItemsByKey || null,
      leadAuthor: opts.leadAuthor || '', layoutLook: 'published', lookOverrides: opts.lookOverrides || null,
      sectionNumbering: opts.sectionNumbering || 'auto',
    };
    if (doc.references) {
      return window.PaperExportTex.buildBundle(Object.assign({ template: template }, common)).then(function (bundle) {
        var keys = citeOrder(bundle.files);
        var main = bundle.files.filter(function (f) { return /(^|\/)main\.tex$/.test(f.relpath); })[0];
        var pre = main.content.slice(0, main.content.indexOf('\\begin{document}'));
        var bst = (template.citation && template.citation.bibliography_style) || 'unsrtnat';
        var bibBase = (template.bib_filename || 'references.bib').replace(/\.bib$/, '');
        main.content = pre + '\\begin{document}\n' +
          '% References Cited: the Project Description\'s citations, in the order it first cites them\n' +
          '\\nocite{' + keys.join(',') + '}\n\\bibliographystyle{' + bst + '}\n\\bibliography{' + bibBase + '}\n\\end{document}\n';
        bundle.files = bundle.files.filter(function (f) { return !/^sections\//.test(f.relpath); });
        bundle.figureAssets = [];
        bundle.citeKeys = keys;
        bundle.doc = doc;
        return bundle;
      });
    }
    var t = _clone(template);
    t.look = t.look || {};
    t.look.title = Object.assign({}, t.look.title || {}, { show: false });
    var skc = t.section_kind_to_command || {};
    doc.kinds.forEach(function (k) { skc[k] = 'section_star'; });
    t.section_kind_to_command = skc;
    return window.PaperExportTex.buildBundle(Object.assign({ template: t, titleOverride: opts.titleOverride,
      sectionFilter: function (sec) { return doc.kinds.indexOf(sec.kind) >= 0; } }, common)).then(function (bundle) {
      bundle.doc = doc;
      return bundle;
    });
  }

  /* Subdocs available for a paper_type (Grant Docs page / Export page
   * each render their own). A doc with no `types` defaults to journal. */
  function docsForType(type) {
    return DOCS.filter(function (d) {
      return (d.types || ['journal']).indexOf(type) >= 0;
    });
  }

  window.PaperSubdocs = {
    DOCS: DOCS,
    docsForType: docsForType,
    grantDocs: grantDocs,                     // V3.911
    buildGrantDocBundle: buildGrantDocBundle, // V3.911
    citeOrder: citeOrder,
    sectionsPresent: sectionsPresent,
    buildSubdocBundle: buildSubdocBundle,
  };
})();
