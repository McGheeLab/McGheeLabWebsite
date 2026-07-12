/* grant-schemas.js — V3.179.
 *
 * Closed vocabularies + default templates for the grant writer. Sibling of
 * paper-schemas.js. The on-disk data shape mirrors the paper schema (sections
 * → children → block) so a future Yjs upgrade (V3.183+) can hydrate the tree
 * into a Y.Doc without a migration.
 *
 * Storage: grantDrafts/{grantId}.tree = {
 *   meta: { title },
 *   sections: [
 *     { id, kind, label, order, status, children: [
 *       { id, kind, status, body, attrs }
 *     ] }
 *   ]
 * }
 *
 * Block kinds added vs. paper-schemas:
 *   - aim-bullets       — Hypothesis + Aim 1/2/3 skeleton, drives Specific Aims
 *   - budget-table      — embeds the budget editor (data lives in /budget/{year} subcoll)
 *   - personnel-table   — quick personnel snapshot (independent of budget)
 *   - compliance-row    — yes/no checkbox row (vertebrate animals, human subjects, etc.)
 *   - letter-card       — placeholder for a letter of support (V3.183 wires up uploads)
 */

(function () {
  'use strict';

  /* ── Section kinds ── */

  var GRANT_SECTION_KINDS = [
    'specific-aims',
    'significance',
    'innovation',
    'approach',
    'approach-aim',
    'project-summary',
    'project-description',
    'intellectual-merit',
    'broader-impacts',
    'preliminary-results',
    'research-strategy',
    'training-plan',
    'mentoring-plan',
    'education-plan',
    'environment',
    'facilities',
    'equipment-section',
    'references',
    'biosketch-ref',
    'budget',
    'budget-justification',
    'current-pending',
    'resource-sharing',
    'data-management-plan',
    'vertebrate-animals',
    'human-subjects',
    'select-agents',
    'letters-of-support',
    'appendix',
    'custom',
  ];

  var SECTION_KIND_LABELS = {
    'specific-aims':        'Specific Aims',
    'significance':         'Significance',
    'innovation':           'Innovation',
    'approach':             'Approach',
    'approach-aim':         'Approach — Aim',
    'project-summary':      'Project Summary',
    'project-description':  'Project Description',
    'intellectual-merit':   'Intellectual Merit',
    'broader-impacts':      'Broader Impacts',
    'preliminary-results':  'Preliminary Results',
    'research-strategy':    'Research Strategy',
    'training-plan':        'Training Plan',
    'mentoring-plan':       'Mentoring Plan',
    'education-plan':       'Education Plan',
    'environment':          'Environment',
    'facilities':           'Facilities & Other Resources',
    'equipment-section':    'Equipment',
    'references':           'References Cited',
    'biosketch-ref':        'Biographical Sketches',
    'budget':               'Budget',
    'budget-justification': 'Budget Justification',
    'current-pending':      'Current & Pending Support',
    'resource-sharing':     'Resource Sharing Plan',
    'data-management-plan': 'Data Management Plan',
    'vertebrate-animals':   'Vertebrate Animals',
    'human-subjects':       'Human Subjects',
    'select-agents':        'Select Agents',
    'letters-of-support':   'Letters of Support',
    'appendix':             'Appendix',
    'custom':               'Custom Section',
  };

  /* Per-section style/policy. pageBudget is advisory — surfaced in the UI but
   * not enforced. A future phase can flag overruns at status=complete. */
  var SECTION_STYLE = {
    'specific-aims':        { pageBudget: 1,  allowFigures: false, allowEquations: false },
    'significance':         { pageBudget: 3,  allowFigures: true,  allowEquations: true  },
    'innovation':           { pageBudget: 1,  allowFigures: true,  allowEquations: false },
    'approach':             { pageBudget: 8,  allowFigures: true,  allowEquations: true  },
    'approach-aim':         { pageBudget: 4,  allowFigures: true,  allowEquations: true  },
    'project-summary':      { pageBudget: 1,  allowFigures: false, allowEquations: false },
    'project-description':  { pageBudget: 15, allowFigures: true,  allowEquations: true  },
    'intellectual-merit':   { pageBudget: 0,  allowFigures: true,  allowEquations: true  },
    'broader-impacts':      { pageBudget: 0,  allowFigures: false, allowEquations: false },
    'preliminary-results':  { pageBudget: 2,  allowFigures: true,  allowEquations: true  },
    'research-strategy':    { pageBudget: 12, allowFigures: true,  allowEquations: true  },
    'training-plan':        { pageBudget: 6,  allowFigures: false, allowEquations: false },
    'mentoring-plan':       { pageBudget: 1,  allowFigures: false, allowEquations: false },
    'education-plan':       { pageBudget: 5,  allowFigures: true,  allowEquations: false },
    'environment':          { pageBudget: 0,  allowFigures: false, allowEquations: false },
    'facilities':           { pageBudget: 0,  allowFigures: false, allowEquations: false },
    'equipment-section':    { pageBudget: 0,  allowFigures: false, allowEquations: false },
    'references':           { pageBudget: 0,  allowFigures: false, allowEquations: false, autoGenerated: true },
    'biosketch-ref':        { pageBudget: 5,  allowFigures: false, allowEquations: false, autoGenerated: true },
    'budget':               { pageBudget: 0,  allowFigures: false, allowEquations: false, autoGenerated: true },
    'budget-justification': { pageBudget: 3,  allowFigures: false, allowEquations: false },
    'current-pending':      { pageBudget: 0,  allowFigures: false, allowEquations: false },
    'resource-sharing':     { pageBudget: 1,  allowFigures: false, allowEquations: false },
    'data-management-plan': { pageBudget: 2,  allowFigures: false, allowEquations: false },
    'vertebrate-animals':   { pageBudget: 0,  allowFigures: false, allowEquations: false },
    'human-subjects':       { pageBudget: 0,  allowFigures: false, allowEquations: false },
    'select-agents':        { pageBudget: 0,  allowFigures: false, allowEquations: false },
    'letters-of-support':   { pageBudget: 0,  allowFigures: false, allowEquations: false },
    'appendix':             { pageBudget: 0,  allowFigures: true,  allowEquations: true  },
    'custom':               { pageBudget: 0,  allowFigures: true,  allowEquations: true  },
  };

  /* ── Block kinds ── */

  var GRANT_BLOCK_KINDS = [
    'paragraph',
    'aim-bullets',
    'budget-table',
    'personnel-table',
    'compliance-row',
    'letter-card',
    'figure',
    'equation',
    'table',
    'list',
  ];

  var BLOCK_STATUSES = ['draft', 'needs-review', 'complete'];

  /* ── Templates ── */

  var GRANT_TEMPLATES = {
    'nih-r01': {
      id: 'nih-r01',
      name: 'NIH R01 (Research Project)',
      agency: 'NIH',
      mechanism: 'R01',
      description: '12-page Research Strategy + Specific Aims + standard NIH components.',
      pageLimits: { 'specific-aims': 1, 'research-strategy': 12 },
      sections: [
        { kind: 'specific-aims',       label: 'Specific Aims' },
        { kind: 'significance',        label: 'Significance' },
        { kind: 'innovation',          label: 'Innovation' },
        { kind: 'approach-aim',        label: 'Approach — Aim 1' },
        { kind: 'approach-aim',        label: 'Approach — Aim 2' },
        { kind: 'approach-aim',        label: 'Approach — Aim 3' },
        { kind: 'references',          label: 'References Cited' },
        { kind: 'biosketch-ref',       label: 'Biosketches' },
        { kind: 'budget',              label: 'Budget' },
        { kind: 'budget-justification',label: 'Budget Justification' },
        { kind: 'facilities',          label: 'Facilities & Other Resources' },
        { kind: 'equipment-section',   label: 'Equipment' },
        { kind: 'resource-sharing',    label: 'Resource Sharing Plan' },
        { kind: 'vertebrate-animals',  label: 'Vertebrate Animals' },
        { kind: 'human-subjects',      label: 'Human Subjects' },
        { kind: 'letters-of-support',  label: 'Letters of Support' },
      ],
    },
    'nih-r21': {
      id: 'nih-r21',
      name: 'NIH R21 (Exploratory/Developmental)',
      agency: 'NIH',
      mechanism: 'R21',
      description: '6-page Research Strategy — exploratory / high-risk projects.',
      pageLimits: { 'specific-aims': 1, 'research-strategy': 6 },
      sections: [
        { kind: 'specific-aims',       label: 'Specific Aims' },
        { kind: 'significance',        label: 'Significance' },
        { kind: 'innovation',          label: 'Innovation' },
        { kind: 'approach',            label: 'Approach' },
        { kind: 'references',          label: 'References Cited' },
        { kind: 'biosketch-ref',       label: 'Biosketches' },
        { kind: 'budget',              label: 'Budget' },
        { kind: 'budget-justification',label: 'Budget Justification' },
        { kind: 'facilities',          label: 'Facilities & Other Resources' },
        { kind: 'equipment-section',   label: 'Equipment' },
        { kind: 'vertebrate-animals',  label: 'Vertebrate Animals' },
        { kind: 'human-subjects',      label: 'Human Subjects' },
      ],
    },
    'nsf-standard': {
      id: 'nsf-standard',
      name: 'NSF (Standard Research)',
      agency: 'NSF',
      mechanism: 'Standard',
      description: 'NSF PAPPG: 15-page Project Description, separate Intellectual Merit + Broader Impacts.',
      pageLimits: { 'project-summary': 1, 'project-description': 15 },
      sections: [
        { kind: 'project-summary',     label: 'Project Summary' },
        { kind: 'project-description', label: 'Project Description' },
        { kind: 'intellectual-merit',  label: 'Intellectual Merit' },
        { kind: 'broader-impacts',     label: 'Broader Impacts' },
        { kind: 'references',          label: 'References Cited' },
        { kind: 'biosketch-ref',       label: 'Biographical Sketches' },
        { kind: 'budget',              label: 'Budget' },
        { kind: 'budget-justification',label: 'Budget Justification' },
        { kind: 'current-pending',     label: 'Current & Pending Support' },
        { kind: 'facilities',          label: 'Facilities, Equipment, and Other Resources' },
        { kind: 'data-management-plan',label: 'Data Management Plan' },
      ],
    },
    'nsf-career': {
      id: 'nsf-career',
      name: 'NSF CAREER',
      agency: 'NSF',
      mechanism: 'CAREER',
      description: 'NSF CAREER: integrated 15-page research + education project description.',
      pageLimits: { 'project-summary': 1, 'project-description': 15 },
      sections: [
        { kind: 'project-summary',     label: 'Project Summary' },
        { kind: 'project-description', label: 'Project Description (Integrated Research & Education)' },
        { kind: 'intellectual-merit',  label: 'Intellectual Merit' },
        { kind: 'broader-impacts',     label: 'Broader Impacts' },
        { kind: 'education-plan',      label: 'Education Plan' },
        { kind: 'mentoring-plan',      label: 'Mentoring Plan (Postdoc)' },
        { kind: 'references',          label: 'References Cited' },
        { kind: 'biosketch-ref',       label: 'Biographical Sketches' },
        { kind: 'budget',              label: 'Budget' },
        { kind: 'budget-justification',label: 'Budget Justification' },
        { kind: 'current-pending',     label: 'Current & Pending Support' },
        { kind: 'facilities',          label: 'Facilities, Equipment, and Other Resources' },
        { kind: 'data-management-plan',label: 'Data Management Plan' },
        { kind: 'letters-of-support',  label: 'Letters of Collaboration' },
      ],
    },
    'blank': {
      id: 'blank',
      name: 'Blank',
      agency: '',
      mechanism: '',
      description: 'No starter sections. Build your own outline.',
      pageLimits: {},
      sections: [],
    },
  };

  /* ── Tree helpers ── */

  function shortId(prefix) {
    var alphabet = '0123456789abcdefghjkmnpqrstvwxyz';
    var s = '';
    for (var i = 0; i < 7; i++) s += alphabet[Math.floor(Math.random() * alphabet.length)];
    return (prefix || '') + s;
  }

  function newSection(kind, label, order) {
    var k = GRANT_SECTION_KINDS.indexOf(kind) >= 0 ? kind : 'custom';
    return {
      id: shortId('sec-'),
      kind: k,
      label: label || SECTION_KIND_LABELS[k] || 'Untitled',
      order: order || 0,
      status: 'draft',
      children: [],
    };
  }

  function newParagraph(body) {
    return {
      id: shortId('p-'),
      kind: 'paragraph',
      status: 'draft',
      body: body || '',
      attrs: {},
    };
  }

  function newAimBullets() {
    return {
      id: shortId('p-'),
      kind: 'aim-bullets',
      status: 'draft',
      body: '',  // overall hypothesis / framing paragraph
      attrs: {
        hypothesis: '',
        aims: [
          { id: shortId('aim-'), title: 'Aim 1', summary: '' },
          { id: shortId('aim-'), title: 'Aim 2', summary: '' },
          { id: shortId('aim-'), title: 'Aim 3', summary: '' },
        ],
      },
    };
  }

  function newBudgetTable() {
    return {
      id: shortId('p-'),
      kind: 'budget-table',
      status: 'draft',
      body: '',
      attrs: {
        years: ['Y1', 'Y2', 'Y3', 'Y4', 'Y5'],
        // Per-year budget data lives in grantDrafts/{id}/budget/{year}.
        // The block itself is just a placement marker the editor renders into.
      },
    };
  }

  function newPersonnelTable() {
    return {
      id: shortId('p-'),
      kind: 'personnel-table',
      status: 'draft',
      body: '',
      attrs: { rows: [] },
    };
  }

  function newComplianceRow(question) {
    return {
      id: shortId('p-'),
      kind: 'compliance-row',
      status: 'draft',
      body: question || '',
      attrs: { answer: '' },  // 'yes' | 'no' | 'na' | ''
    };
  }

  function newLetterCard() {
    return {
      id: shortId('p-'),
      kind: 'letter-card',
      status: 'draft',
      body: '',
      attrs: { from: '', institution: '', role: '', storagePath: '', requestedAt: null, receivedAt: null },
    };
  }

  /* Seed sensible default blocks for each section kind. */
  function seedBlocksForSection(kind) {
    switch (kind) {
      case 'specific-aims':
        return [newAimBullets()];
      case 'budget':
        return [newBudgetTable()];
      case 'budget-justification':
        return [newParagraph('Personnel: '), newParagraph('Equipment: '), newParagraph('Supplies: '), newParagraph('Travel: '), newParagraph('Indirect costs: ')];
      case 'vertebrate-animals':
        return [
          newComplianceRow('Vertebrate animals involved in research?'),
          newParagraph(''),
        ];
      case 'human-subjects':
        return [
          newComplianceRow('Human subjects involved in research?'),
          newParagraph(''),
        ];
      case 'select-agents':
        return [newComplianceRow('Select Agents involved in research?')];
      case 'letters-of-support':
        return [newLetterCard()];
      case 'biosketch-ref':
      case 'facilities':
      case 'equipment-section':
      case 'references':
        // Auto-generated sections — render placeholder + cross-reference instructions.
        return [newParagraph('')];
      default:
        return [newParagraph('')];
    }
  }

  function newTree(templateId, grantTitle) {
    var tpl = GRANT_TEMPLATES[templateId] || GRANT_TEMPLATES['blank'];
    var sections = (tpl.sections || []).map(function (s, i) {
      var sec = newSection(s.kind, s.label, i);
      sec.children = seedBlocksForSection(s.kind);
      return sec;
    });
    return {
      meta: { title: grantTitle || '', templateId: tpl.id },
      sections: sections,
    };
  }

  function normalizeTree(tree) {
    if (!tree || typeof tree !== 'object') tree = {};
    if (!tree.meta) tree.meta = {};
    if (!Array.isArray(tree.sections)) tree.sections = [];
    tree.sections.forEach(function (sec, i) {
      if (!sec.id) sec.id = shortId('sec-');
      if (GRANT_SECTION_KINDS.indexOf(sec.kind) < 0) sec.kind = 'custom';
      if (typeof sec.label !== 'string') sec.label = SECTION_KIND_LABELS[sec.kind] || 'Untitled';
      if (typeof sec.order !== 'number') sec.order = i;
      if (BLOCK_STATUSES.indexOf(sec.status) < 0) sec.status = 'draft';
      if (!Array.isArray(sec.children)) sec.children = [];
      sec.children.forEach(function (blk) {
        if (!blk.id) blk.id = shortId('p-');
        if (GRANT_BLOCK_KINDS.indexOf(blk.kind) < 0) blk.kind = 'paragraph';
        if (BLOCK_STATUSES.indexOf(blk.status) < 0) blk.status = 'draft';
        if (typeof blk.body !== 'string') blk.body = '';
        if (!blk.attrs) blk.attrs = {};
      });
    });
    tree.sections.sort(function (a, b) { return (a.order || 0) - (b.order || 0); });
    tree.sections.forEach(function (sec, i) { sec.order = i; });
    return tree;
  }

  function styleFor(section) {
    return SECTION_STYLE[section.kind] || SECTION_STYLE.custom;
  }

  /* ── Public ── */

  window.GrantSchemas = {
    GRANT_SECTION_KINDS: GRANT_SECTION_KINDS,
    SECTION_KIND_LABELS: SECTION_KIND_LABELS,
    SECTION_STYLE: SECTION_STYLE,
    GRANT_BLOCK_KINDS: GRANT_BLOCK_KINDS,
    BLOCK_STATUSES: BLOCK_STATUSES,
    GRANT_TEMPLATES: GRANT_TEMPLATES,
    shortId: shortId,
    newSection: newSection,
    newParagraph: newParagraph,
    newAimBullets: newAimBullets,
    newBudgetTable: newBudgetTable,
    newPersonnelTable: newPersonnelTable,
    newComplianceRow: newComplianceRow,
    newLetterCard: newLetterCard,
    seedBlocksForSection: seedBlocksForSection,
    newTree: newTree,
    normalizeTree: normalizeTree,
    styleFor: styleFor,
  };
})();
