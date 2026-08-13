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
    sectionsPresent: sectionsPresent,
    buildSubdocBundle: buildSubdocBundle,
  };
})();
