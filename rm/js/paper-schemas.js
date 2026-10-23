/* paper-schemas.js — closed vocabularies and default templates for the paper builder.
 *
 * Phase A scope: paragraph blocks only (skeleton + body). Equation, figure, table,
 * and list block kinds are reserved for Phase C; they're declared here so the
 * editor can render an "(unsupported in this phase)" placeholder for any tree
 * loaded from a future version.
 *
 * The vocabularies must stay in sync with `paper_md.py` (Phase E) and with the
 * LaTeX templates in `data/paper-templates/` (Phase F).
 */

(function () {
  /* Section kinds — closed list. `custom` is the escape hatch (free-form label). */
  var PAPER_SECTION_KINDS = [
    'abstract',
    'keywords',
    'introduction',
    'background',
    'methods',
    'results',
    'discussion',
    'conclusions',
    'acknowledgements',
    'references',
    /* Submission documents (S-α) — live in the section map, EXCLUDED
     * from the manuscript (resolveSectionCommand skips them on
     * manuscript templates), compiled as SEPARATE PDFs via subdoc
     * templates. MUST be registered here or normalizeTree coerces them
     * to 'custom' on every load. */
    'cover_letter',
    'suggested_reviewers',
    'rebuttal',
    /* Grant "attached documents" (V3.4xx grant-writing unification) —
     * same treatment as the submission-doc kinds above: excluded from
     * the main compile, each its own template/PDF. The grant NARRATIVE
     * (Overview, Background, Research Plan/Aims, Education Plan, …)
     * deliberately gets NO new kinds — real proposals write it as
     * flowing prose with a heading hierarchy, which `custom` sections +
     * subheading blocks already handle (verified against a real,
     * submitted-quality NSF CAREER Project Description). `references`/
     * `cover_letter`/`suggested_reviewers` above are reused as-is for
     * grants too. Equipment folds into `facilities` (no separate kind —
     * real NSF facilities docs cover both, no dollar amounts). */
    'project_summary',
    'specific_aims',
    'research_strategy',
    'biosketch',
    'facilities',
    'budget',
    'budget_justification',
    'current_pending',
    'collaborators_coa',
    'synergistic_activities',
    'data_management_plan',
    'mentoring_plan',
    'resource_sharing',
    'vertebrate_animals',
    'human_subjects',
    'select_agents',
    'letters_of_support',
    'pecase_statement',
    'custom',
  ];

  var SECTION_KIND_LABELS = {
    abstract: 'Abstract',
    keywords: 'Keywords',
    introduction: 'Introduction',
    background: 'Background',
    methods: 'Materials and Methods',
    results: 'Results',
    discussion: 'Discussion',
    conclusions: 'Conclusions',
    acknowledgements: 'Acknowledgements',
    references: 'References',
    cover_letter: 'Cover Letter',
    suggested_reviewers: 'Suggested Reviewers',
    rebuttal: 'Response to Reviewers',
    project_summary: 'Project Summary',
    specific_aims: 'Specific Aims',
    research_strategy: 'Research Strategy',
    biosketch: 'Biographical Sketch',
    facilities: 'Facilities, Equipment & Other Resources',
    budget: 'Budget',
    budget_justification: 'Budget Justification',
    current_pending: 'Current & Pending Support',
    collaborators_coa: 'Collaborators & Other Affiliations',
    synergistic_activities: 'Synergistic Activities',
    data_management_plan: 'Data Management & Sharing Plan',
    mentoring_plan: 'Mentoring Plan',
    resource_sharing: 'Resource Sharing Plan',
    vertebrate_animals: 'Vertebrate Animals',
    human_subjects: 'Human Subjects',
    select_agents: 'Select Agents',
    letters_of_support: 'Letters of Support / Collaboration',
    pecase_statement: 'PECASE Eligibility Statement',
    custom: 'Custom Section',
  };

  /* Per-section style/policy. Phase A respects only the structural fields
   * (allowFigures, allowSubsections, allowInventoryQuickInsert). Word counts
   * are advisory. Phase D will enforce maxWords at status=complete. */
  var SECTION_STYLE = {
    abstract:        { maxWords: 250, allowFigures: false, allowEquations: false, allowSubsections: false },
    keywords:        { maxWords: 30,  allowFigures: false, allowEquations: false, allowSubsections: false },
    introduction:    { allowFigures: true,  allowEquations: true,  allowSubsections: true },
    background:      { allowFigures: true,  allowEquations: true,  allowSubsections: true },
    methods:         { allowFigures: true,  allowEquations: true,  allowSubsections: true,
                       allowInventoryQuickInsert: true },
    results:         { allowFigures: true,  allowEquations: true,  allowSubsections: true },
    discussion:      { allowFigures: true,  allowEquations: true,  allowSubsections: true },
    conclusions:     { allowFigures: false, allowEquations: false, allowSubsections: false },
    acknowledgements:{ allowFigures: false, allowEquations: false, allowSubsections: false },
    references:      { allowFigures: false, allowEquations: false, allowSubsections: false,
                       autoGenerated: true },
    /* Submission docs — prose-only; the rebuttal gets subheadings
     * (Reviewer 1 / Reviewer 2) and lists for point-by-point replies. */
    cover_letter:        { allowFigures: false, allowEquations: false, allowSubsections: false },
    suggested_reviewers: { allowFigures: false, allowEquations: false, allowSubsections: false },
    rebuttal:            { allowFigures: false, allowEquations: false, allowSubsections: true },
    /* Grant attached documents. `pageBudget` is the same advisory-only
     * page-limit convention as `maxWords` above — surfaced in the UI,
     * not enforced. specific_aims/research_strategy allow figures +
     * subsections because for NIH-style mechanisms they ARE the
     * narrative (Significance/Innovation/Approach as subheadings
     * inside research_strategy); facilities allows subsections (real
     * facilities docs use Facilities/Equipment/Other Resources
     * headings) but not figures/equations. */
    project_summary:        { pageBudget: 1,  allowFigures: false, allowEquations: false, allowSubsections: false },
    specific_aims:          { pageBudget: 1,  allowFigures: true,  allowEquations: false, allowSubsections: false },
    research_strategy:      { pageBudget: 12, allowFigures: true,  allowEquations: true,  allowSubsections: true },
    biosketch:              { allowFigures: false, allowEquations: false, allowSubsections: false },
    facilities:             { allowFigures: false, allowEquations: false, allowSubsections: true },
    budget:                 { allowFigures: false, allowEquations: false, allowSubsections: false },
    budget_justification:   { pageBudget: 5,  allowFigures: false, allowEquations: false, allowSubsections: false },
    current_pending:        { allowFigures: false, allowEquations: false, allowSubsections: false },
    collaborators_coa:      { allowFigures: false, allowEquations: false, allowSubsections: false },
    synergistic_activities: { pageBudget: 1,  allowFigures: false, allowEquations: false, allowSubsections: false },
    data_management_plan:   { pageBudget: 2,  allowFigures: false, allowEquations: false, allowSubsections: true },
    mentoring_plan:          { pageBudget: 1,  allowFigures: false, allowEquations: false, allowSubsections: false },
    resource_sharing:        { pageBudget: 1,  allowFigures: false, allowEquations: false, allowSubsections: false },
    vertebrate_animals:      { allowFigures: false, allowEquations: false, allowSubsections: false },
    human_subjects:          { allowFigures: false, allowEquations: false, allowSubsections: false },
    select_agents:           { allowFigures: false, allowEquations: false, allowSubsections: false },
    letters_of_support:      { allowFigures: false, allowEquations: false, allowSubsections: false },
    pecase_statement:        { allowFigures: false, allowEquations: false, allowSubsections: false },
    custom:          { allowFigures: true,  allowEquations: true,  allowSubsections: true },
  };

  /* V3.4xx — grant attached-document kinds: excluded from the main
   * compile (own template, own PDF) exactly like the journal
   * submission-doc kinds above. `references`/`cover_letter`/
   * `suggested_reviewers` are already covered by the existing
   * SUBMISSION_DOC_KINDS-style guards and are NOT repeated here. */
  /* V3.470 — the document types a paper can be. Single source of truth
   * for the validation that was duplicated across paper-export.js /
   * paper-doc-view.js. `normalizePaperType` coerces anything unknown to
   * 'journal' (the default). */
  var PAPER_TYPES = ['journal', 'grant', 'editorial', 'book-chapter'];
  function normalizePaperType(v) {
    return PAPER_TYPES.indexOf(v) >= 0 ? v : 'journal';
  }

  var GRANT_ATTACHED_KINDS = [
    'project_summary', 'specific_aims', 'research_strategy', 'biosketch',
    'facilities', 'budget', 'budget_justification', 'current_pending',
    'collaborators_coa', 'synergistic_activities', 'data_management_plan',
    'mentoring_plan', 'resource_sharing', 'vertebrate_animals',
    'human_subjects', 'select_agents', 'letters_of_support', 'pecase_statement',
  ];

  /* Block kinds — Phase A renders only `paragraph`. Others are declared so
   * stored docs from later phases parse without crashing.
   * V3.4xx — `subheading` is a lightweight heading block that flows inside a
   * section (the LaTeX \subsection / \subsubsection model): its `body` holds
   * the heading text and attrs.level (2|3) picks the depth. */
  var PAPER_BLOCK_KINDS = ['paragraph', 'subheading', 'equation', 'figure', 'table', 'list'];

  var MAX_SUBHEADING_LEVEL = 3;   // 2 = subsection, 3 = subsubsection

  var BLOCK_STATUSES = ['draft', 'needs-review', 'complete'];

  /* Default templates — controls which sections seed a new paper. The
   * `template_id` on each paper in papers.json picks one of these. Authors can
   * add/remove sections freely after creation; the template is just a starter. */
  var PAPER_TEMPLATES = {
    'mebp-journal': {
      id: 'mebp-journal',
      name: 'Journal article (MEBP-style)',
      description: 'Standard journal article structure: abstract, intro, methods, results, discussion, conclusion.',
      types: ['journal'],
      sections: [
        { kind: 'abstract',     label: 'Abstract' },
        { kind: 'introduction', label: 'Introduction' },
        { kind: 'methods',      label: 'Materials and Methods' },
        { kind: 'results',      label: 'Results' },
        { kind: 'discussion',   label: 'Discussion' },
        { kind: 'conclusions',  label: 'Conclusion' },
      ],
    },
    /* Grant starters (V3.4xx). Narrative sections are plain `custom` —
     * see the PAPER_SECTION_KINDS comment: real proposals write flowing
     * prose with a heading hierarchy, not one kind per subsection.
     * `specific_aims`/`research_strategy` ARE separate kinds because for
     * NIH-style mechanisms they are genuinely separate uploaded
     * documents (each its own template/PDF via GRANT_ATTACHED_KINDS),
     * not just headings within one document. */
    'nih-r01': {
      id: 'nih-r01',
      name: 'NIH R01 (Research Project)',
      description: '12-page Research Strategy (Significance/Innovation/Approach as subheadings) + 1-page Specific Aims + standard NIH attachments.',
      types: ['grant'],
      sections: [
        { kind: 'specific_aims',        label: 'Specific Aims' },
        { kind: 'research_strategy',    label: 'Research Strategy' },
        { kind: 'references',           label: 'References Cited' },
        { kind: 'biosketch',            label: 'Biographical Sketch' },
        { kind: 'current_pending',      label: 'Current & Pending Support' },
        { kind: 'budget',               label: 'Budget' },
        { kind: 'budget_justification', label: 'Budget Justification' },
        { kind: 'facilities',           label: 'Facilities & Other Resources' },
        { kind: 'resource_sharing',     label: 'Resource Sharing Plan' },
        { kind: 'vertebrate_animals',   label: 'Vertebrate Animals' },
        { kind: 'human_subjects',       label: 'Human Subjects' },
        { kind: 'letters_of_support',   label: 'Letters of Support' },
      ],
    },
    'nih-r21': {
      id: 'nih-r21',
      name: 'NIH R21 (Exploratory/Developmental)',
      description: '6-page Research Strategy — exploratory / high-risk projects.',
      types: ['grant'],
      sections: [
        { kind: 'specific_aims',        label: 'Specific Aims' },
        { kind: 'research_strategy',    label: 'Research Strategy' },
        { kind: 'references',           label: 'References Cited' },
        { kind: 'biosketch',            label: 'Biographical Sketch' },
        { kind: 'current_pending',      label: 'Current & Pending Support' },
        { kind: 'budget',               label: 'Budget' },
        { kind: 'budget_justification', label: 'Budget Justification' },
        { kind: 'facilities',           label: 'Facilities & Other Resources' },
        { kind: 'vertebrate_animals',   label: 'Vertebrate Animals' },
        { kind: 'human_subjects',       label: 'Human Subjects' },
      ],
    },
    'nsf-standard': {
      id: 'nsf-standard',
      name: 'NSF (Standard Research)',
      description: 'NSF PAPPG: 1-page Project Summary + up-to-15-page Project Description (Intellectual Merit/Broader Impacts as subheadings).',
      types: ['grant'],
      sections: [
        { kind: 'project_summary',      label: 'Project Summary' },
        { kind: 'custom',               label: 'Project Description' },
        { kind: 'references',           label: 'References Cited' },
        { kind: 'biosketch',            label: 'Biographical Sketch' },
        { kind: 'current_pending',      label: 'Current & Pending Support' },
        { kind: 'collaborators_coa',    label: 'Collaborators & Other Affiliations' },
        { kind: 'budget',               label: 'Budget' },
        { kind: 'budget_justification', label: 'Budget Justification' },
        { kind: 'facilities',           label: 'Facilities, Equipment, and Other Resources' },
        { kind: 'data_management_plan', label: 'Data Management Plan' },
      ],
    },
    /* Mirrors the real NSF CAREER Project Description's own outline
     * (verified against a submitted-quality example) — ten `custom`
     * narrative sections rather than one per NSF "requirement". */
    'nsf-career': {
      id: 'nsf-career',
      name: 'NSF CAREER',
      description: 'Integrated research + education Project Description, following a real submitted CAREER outline.',
      types: ['grant'],
      sections: [
        { kind: 'project_summary',        label: 'Project Summary' },
        { kind: 'custom',                 label: 'Overview and Objectives' },
        { kind: 'custom',                 label: 'Research Significance' },
        { kind: 'custom',                 label: 'Background' },
        { kind: 'custom',                 label: 'Relation to Other Work in Progress' },
        { kind: 'custom',                 label: 'Research Plan' },
        { kind: 'custom',                 label: 'Education Plan' },
        { kind: 'custom',                 label: 'Integration of Research, Teaching, Outreach, and Service' },
        { kind: 'custom',                 label: 'Assessment and Evaluation' },
        { kind: 'custom',                 label: 'Broader Impacts' },
        { kind: 'custom',                 label: 'Timetable' },
        { kind: 'references',             label: 'References Cited' },
        { kind: 'biosketch',              label: 'Biographical Sketch' },
        { kind: 'current_pending',        label: 'Current & Pending Support' },
        { kind: 'collaborators_coa',      label: 'Collaborators & Other Affiliations' },
        { kind: 'budget',                 label: 'Budget' },
        { kind: 'budget_justification',   label: 'Budget Justification' },
        { kind: 'facilities',             label: 'Facilities, Equipment, and Other Resources' },
        { kind: 'data_management_plan',   label: 'Data Management & Sharing Plan' },
        { kind: 'mentoring_plan',         label: 'Mentoring Plan' },
        { kind: 'synergistic_activities', label: 'Synergistic Activities' },
        { kind: 'letters_of_support',     label: 'Departmental Letter / Letters of Collaboration' },
        { kind: 'pecase_statement',       label: 'PECASE Eligibility Statement' },
        { kind: 'cover_letter',           label: 'Cover Letter' },
        { kind: 'suggested_reviewers',    label: 'Suggested Reviewers' },
      ],
    },
    'blank': {
      id: 'blank',
      name: 'Blank',
      description: 'No starter sections. Build your own outline.',
      types: ['journal', 'grant', 'editorial', 'book-chapter'],
      sections: [],
    },
  };

  /* ── Tree helpers ── */

  /* Crockford-base32 short id, ~7 chars, ~35 bits. Plenty for per-paper uniqueness. */
  function shortId(prefix) {
    var alphabet = '0123456789abcdefghjkmnpqrstvwxyz';
    var s = '';
    for (var i = 0; i < 7; i++) s += alphabet[Math.floor(Math.random() * alphabet.length)];
    return (prefix || '') + s;
  }

  function newSection(kind, label, order, opts) {
    var k = PAPER_SECTION_KINDS.indexOf(kind) >= 0 ? kind : 'custom';
    var sec = {
      id: shortId('sec-'),
      kind: k,
      label: label || SECTION_KIND_LABELS[k] || 'Untitled section',
      order: order || 0,
      style_overrides: {},
      status: 'draft',
      children: [],
    };
    /* V3.413 — section styles. `special` keys into a template's
     * special_sections catalog (PNAS Significance etc.); special_render
     * ('box'|'heading') is the cross-journal fallback captured at
     * creation. Keys are set ONLY when provided — legacy sections keep
     * their exact serialized shape. */
    if (opts && opts.special) sec.special = String(opts.special);
    if (opts && opts.special_render) sec.special_render = String(opts.special_render);
    /* Appendix flag: the first section flagged starts the appendix zone
     * (\appendix; A/B numbering). `ref_label` is the cross-reference
     * anchor for [!sec:label]. Both set only when provided. */
    if (opts && opts.appendix) sec.appendix = true;
    if (opts && opts.ref_label) sec.ref_label = String(opts.ref_label);
    return sec;
  }

  /* V3.104 — skeleton bullet items. Per-paragraph skeleton is now an
   * outline (Y.Array<Y.Map>) rather than a flat Y.Text. Depth caps at 3
   * to keep the UI manageable; deeper structure suggests the paragraph
   * should split. claim_id is null until the bullet is explicitly flagged
   * as a claim — most bullets stay null. */
  var MAX_SKELETON_DEPTH = 3;

  function newSkeletonItem(opts) {
    opts = opts || {};
    var d = (typeof opts.depth === 'number') ? opts.depth : 0;
    if (d < 0) d = 0;
    if (d > MAX_SKELETON_DEPTH) d = MAX_SKELETON_DEPTH;
    return {
      id: shortId('sk-'),
      depth: d,
      text: opts.text || '',
      claim_id: opts.claim_id || null,
    };
  }

  function newParagraph() {
    return {
      id: shortId('p-'),
      kind: 'paragraph',
      status: 'draft',
      // Legacy field kept for one release as rollback safety. New blocks
      // also seed skeleton_items with one empty depth-0 bullet; renderers
      // prefer skeleton_items when non-empty.
      skeleton: '',
      skeleton_items: [newSkeletonItem()],
      body: '',
      attrs: {},
    };
  }

  /* Subheading block factory. `body` holds the heading text (Y.Text once
   * hydrated); attrs.level 2 = subsection, 3 = subsubsection. Uses the
   * 'p-' id prefix like every other block so ids stay uniform. */
  function newSubheading(opts) {
    opts = opts || {};
    var lvl = (opts.level === 3) ? 3 : 2;
    return {
      id: shortId('p-'),
      kind: 'subheading',
      status: 'draft',
      skeleton: '',
      body: opts.text || '',
      attrs: { level: lvl },
    };
  }

  /* ── V3.649 — lists inside a paragraph body ──────────────────────
   *
   * Alex: "I need the ability to add lists to the write version of the
   * paragraph, either bullet or numbers." The list BLOCK below already
   * existed, but it is a sibling of the paragraph — you had to leave the
   * prose you were writing, add a block, and come back. This lets a list
   * live inside the body Y.Text of the paragraph itself.
   *
   * Syntax, matching the list block's own convention so the two cannot
   * drift: a line beginning `- ` or `* ` is a bullet item; `1. ` / `1) `
   * (any digits) is a numbered item; two leading spaces per nesting level.
   * A run of consecutive item lines is one list. Anything else is prose.
   *
   * ONE parser, shared by all four consumers — the editor's rendered view,
   * the Document view, the LaTeX exporter, and the toolbar buttons that
   * write the syntax. A second implementation anywhere is a guarantee that
   * the PDF and the screen eventually disagree.
   *
   * Returns runs: [{ type:'prose', text }
   *              | { type:'list', listType:'bullet'|'number',
   *                  items:[{depth, text}] }]
   */
  var BULLET_RE = /^(\s*)[-*]\s+(.*)$/;
  var NUMBER_RE = /^(\s*)\d+[.)]\s+(.*)$/;

  function parseBodyRuns(text) {
    var runs = [];
    var src = String(text == null ? '' : text);
    if (!src) return runs;
    var prose = [];
    var list = null;

    function flushProse() {
      if (!prose.length) return;
      /* Keep the blank lines the writer typed; only drop a run that is
       * nothing but whitespace, which would render as an empty paragraph. */
      var joined = prose.join('\n');
      if (joined.trim()) runs.push({ type: 'prose', text: joined });
      prose = [];
    }
    function flushList() {
      if (list && list.items.length) runs.push(list);
      list = null;
    }

    src.split('\n').forEach(function (line) {
      var mB = BULLET_RE.exec(line);
      var mN = mB ? null : NUMBER_RE.exec(line);
      var m = mB || mN;
      if (!m) {
        /* A blank line inside a list ends it; a blank line elsewhere is
         * ordinary prose whitespace. */
        flushList();
        prose.push(line);
        return;
      }
      var kind = mB ? 'bullet' : 'number';
      var depth = Math.min(3, Math.floor(m[1].replace(/\t/g, '  ').length / 2));
      var itemText = m[2].replace(/\s+$/, '');
      flushProse();
      /* A bullet run and a numbered run are different lists even when
       * adjacent — switching marker starts a new one. */
      if (list && list.listType !== kind) flushList();
      if (!list) list = { type: 'list', listType: kind, items: [] };
      list.items.push({ depth: depth, text: itemText });
    });
    flushList();
    flushProse();
    return runs;
  }

  /* V3.649 — is this ONE line a list item? Returns {listType, depth,
   * markerLength} or null. Used by the Write view to lay each item out with
   * a hanging indent, so the source you edit reads like the list it is. */
  function listLineMatch(line) {
    var mB = BULLET_RE.exec(line);
    var mN = mB ? null : NUMBER_RE.exec(line);
    var m = mB || mN;
    if (!m) return null;
    return {
      listType: mB ? 'bullet' : 'number',
      indent: m[1],
      depth: Math.min(3, Math.floor(m[1].replace(/\t/g, '  ').length / 2)),
      /* Length of the marker itself ("- " / "12. "), excluding the indent. */
      markerLength: String(line).length - m[2].length - m[1].length,
      /* The item's own text, marker and indent stripped. */
      content: m[2],
    };
  }

  /* True when the body contains at least one list item — lets consumers
   * skip the run machinery entirely for ordinary prose. */
  function bodyHasList(text) {
    var src = String(text == null ? '' : text);
    if (src.indexOf('\n') === -1 && !BULLET_RE.test(src) && !NUMBER_RE.test(src)) return false;
    return src.split('\n').some(function (l) { return BULLET_RE.test(l) || NUMBER_RE.test(l); });
  }

  /* V3.650 — canonical numbering for every ordered run in the body.
   *
   * Structural edits (Enter mid-list, indent, outdent, delete) leave the
   * typed numbers wrong — insert between "1." and "2." and the source says
   * 1, 2, 2. Rather than display a number that differs from the source
   * (which would then serialize back wrong), renumber the SOURCE after any
   * structural edit, so what you see and what is stored stay the same
   * string. Numbering restarts per run and per depth, which is what
   * enumerate does. */
  function renumberOrderedRuns(text) {
    var lines = String(text == null ? '' : text).split('\n');
    var counters = [];      // per depth
    var inRun = false;
    var out = lines.map(function (line) {
      var m = listLineMatch(line);
      if (!m) { inRun = false; counters = []; return line; }
      if (!inRun) { inRun = true; counters = []; }
      if (m.listType !== 'number') return line;
      var d = m.depth;
      counters.length = d + 1;
      counters[d] = (counters[d] || 0) + 1;
      var body = line.slice(m.markerLength + m.indent.length);
      return m.indent + counters[d] + '. ' + body;
    });
    return out.join('\n');
  }

  /* Toggle list markers across the given source lines. `type` is
   * 'bullet' | 'number'; re-applying the same type strips them, so the
   * toolbar buttons behave like every other formatting toggle. */
  function toggleListLines(lines, type) {
    var re = type === 'number' ? NUMBER_RE : BULLET_RE;
    var allMarked = lines.every(function (l) { return !l.trim() || re.test(l); });
    var n = 0;
    return lines.map(function (line) {
      if (!line.trim()) return line;
      var mB = BULLET_RE.exec(line), mN = NUMBER_RE.exec(line);
      var m = mB || mN;
      var indent = m ? m[1] : (/^(\s*)/.exec(line)[1] || '');
      var body = m ? m[2] : line.replace(/^\s+/, '');
      if (allMarked) return indent + body;                 // strip
      n++;
      return indent + (type === 'number' ? (n + '. ') : '- ') + body;
    });
  }

  /* List block factory. `body` holds the items — one per line; leading
   * spaces (2 per level) nest. attrs.list_type 'bullet' → itemize,
   * 'number' → enumerate. */
  function newList(opts) {
    opts = opts || {};
    return {
      id: shortId('p-'),
      kind: 'list',
      status: 'draft',
      skeleton: '',
      body: opts.text || '',
      attrs: { list_type: opts.list_type === 'number' ? 'number' : 'bullet' },
    };
  }

  /* V3.109 — inline equation library entry. Each library entry is a
   * named, reusable inline equation that can be inserted into paragraph
   * text via the right-click "Insert inline equation" picker. Display /
   * numbered equations remain block-level and live in section.children
   * — they don't go through the library. */
  var MAX_EQ_LABEL_LENGTH = 64;

  function newEquationLibraryEntry(opts) {
    opts = opts || {};
    /* V3.124 — type categorizes the entry as inline (small one-liner
     * for in-prose use) vs main (longer / important; intended to be
     * inserted as a numbered display block). Both types are
     * insertable inline; main entries also surface an "Insert as
     * block" action. */
    return {
      id: shortId('eq-'),
      name: opts.name || '',
      latex: opts.latex || '',
      type: opts.type === 'main' ? 'main' : 'inline',
    };
  }

  /* ── V3.645 — value keys ──────────────────────────────────────────
   * A per-paper table of named values the writer references from prose
   * instead of retyping. Two token families read from this ONE table:
   *
   *   [!val:KEY]    paper-local value  (kind 'text' | 'number')
   *   [@item:KEY]   lab inventory item (kind 'inventory')
   *
   * The namespace split is the rule the builder already follows:
   * `[@…]` refers OUT to a shared lab record (library, inventory),
   * `[!…]` refers to something inside this paper (fig/sec/eq/val).
   *
   * kind 'text' vs 'number' is deliberately a discriminator, not a
   * text field with optional numeric companions: a typed string and a
   * num/unit pair that can silently disagree is a data-integrity bug
   * waiting to print the wrong number in a manuscript.
   *
   * kind 'inventory' carries a SNAPSHOT of the inventory row rather
   * than resolving live. Three reasons, all load-bearing: the
   * inventory is ~3,481 docs / 1+ MB (never on the render path); a
   * submitted manuscript must not change because someone edited an
   * inventory row two years later; and `inventory` is isLabMember()-
   * read-only, so a live resolve would 403 for any outside reader of a
   * shared paper. `↻ Refresh from inventory` re-pulls deliberately. */

  var MAX_VALUE_KEY_LENGTH = 48;

  /* Leading digits are allowed on purpose — real keys look like `24WP`. */
  var VALUE_KEY_RE = /^[A-Za-z0-9][A-Za-z0-9_-]*$/;

  var DEFAULT_ITEM_FORMAT = '({vendor} {catalogue_number})';

  var VALUE_KINDS = ['text', 'number', 'inventory'];

  function normalizeValueKind(k) {
    return VALUE_KINDS.indexOf(k) >= 0 ? k : 'text';
  }

  function isValidValueKey(key) {
    key = String(key == null ? '' : key);
    return !!key && key.length <= MAX_VALUE_KEY_LENGTH && VALUE_KEY_RE.test(key);
  }

  function newValueEntry(opts) {
    opts = opts || {};
    var kind = normalizeValueKind(opts.kind);
    return {
      id: shortId('val-'),
      key: String(opts.key || ''),
      kind: kind,
      note: String(opts.note || ''),
      /* kind 'text' */
      value: String(opts.value || ''),
      /* kind 'number' — `num` stays a Number so rounding is a render
       * concern, not a storage one; sigfigs null = print as authored. */
      num: (typeof opts.num === 'number' && isFinite(opts.num)) ? opts.num : null,
      unit: String(opts.unit || ''),
      sigfigs: (typeof opts.sigfigs === 'number' && opts.sigfigs > 0)
        ? Math.min(15, Math.round(opts.sigfigs)) : null,
      /* kind 'inventory' */
      inv_id: String(opts.inv_id || ''),
      inv_kind: opts.inv_kind === 'chemical' ? 'chemical' : 'item',
      snapshot: {
        name: String((opts.snapshot && opts.snapshot.name) || ''),
        vendor: String((opts.snapshot && opts.snapshot.vendor) || ''),
        catalogue_number: String((opts.snapshot && opts.snapshot.catalogue_number) || ''),
      },
      format: String(opts.format || DEFAULT_ITEM_FORMAT),
      refreshed_at: opts.refreshed_at || null,
    };
  }

  /* Render a number for printing. `sigfigs` uses toPrecision, whose
   * trailing zeros are the POINT (0.5 at 2 s.f. is "0.50") — don't
   * strip them. Exponential output is left alone; it only appears when
   * the author explicitly asked for a precision that needs it. */
  function formatValueNumber(num, sigfigs) {
    if (typeof num !== 'number' || !isFinite(num)) return '';
    if (sigfigs) {
      try { return num.toPrecision(sigfigs); } catch (e) { /* range */ }
    }
    return String(num);
  }

  function formatInventorySnapshot(snap, format) {
    snap = snap || {};
    var out = String(format || DEFAULT_ITEM_FORMAT)
      .replace(/\{name\}/g, snap.name || '')
      .replace(/\{vendor\}/g, snap.vendor || '')
      .replace(/\{catalogue_number\}/g, snap.catalogue_number || '')
      .replace(/\{cat\}/g, snap.catalogue_number || '');
    /* Collapse the holes a missing field leaves behind so a row with no
     * catalogue number prints "(Nest)" rather than "(Nest )". */
    out = out.replace(/\s+/g, ' ').replace(/\(\s+/g, '(').replace(/\s+\)/g, ')');
    out = out.replace(/\(\s*\)/g, '').replace(/\[\s*\]/g, '');
    return out.trim();
  }

  /* THE resolver. Editor chips, Document view, .tex export and the
   * bundle's paper.md all print through this one function — a second
   * implementation anywhere is how the editor and the PDF start
   * disagreeing about what the paper says. */
  function formatValueEntry(entry) {
    if (!entry) return '';
    var kind = normalizeValueKind(entry.kind);
    if (kind === 'inventory') {
      return formatInventorySnapshot(entry.snapshot, entry.format);
    }
    if (kind === 'number') {
      var n = formatValueNumber(entry.num, entry.sigfigs);
      var u = String(entry.unit || '').trim();
      if (!n) return u;
      return u ? (n + ' ' + u) : n;
    }
    return String(entry.value || '');
  }

  /* V3.102 — figure block factory. `body` holds the caption (Y.Text once
   * hydrated into Yjs). attrs.* carry the Storage pointer + LaTeX render
   * options. Defaults match the most common single-column journal layout.
   *
   * V3.115 — figures auto-number unless the writer suppresses (numbered=false
   * for inline-only demonstrative figures). subfigures is a free-text list
   * of panel labels (A/B/C/i/ii/…) that drive the [!fig:label:A] reference
   * picker; each entry hydrates into a Y.Map so concurrent additions merge. */
  var MAX_SUBFIGURES = 12;

  function newFigure() {
    return {
      id: shortId('p-'),
      kind: 'figure',
      status: 'draft',
      skeleton: '',
      body: '',
      attrs: {
        storage_path: '',
        download_url: '',
        hash: '',
        mime: '',
        width: '\\linewidth',
        placement: 'H',
        centering: true,
        label: '',
        alt: '',
        numbered: true,        // V3.115
        subfigures: [],        // V3.115 — array of {id, label}; hydrates to Y.Array<Y.Map>
        /* V3.395 — layout intent (Layout Mode). Presence of `anchor`
         * opts the block into PaperLayout.resolveFloat at export; legacy
         * blocks without it keep verbatim attrs.placement emission.
         * normalizeTree must NEVER inject these into old blocks. */
        anchor: 'flow',        // 'flow' | 'top' | 'bottom' | 'float-page' | 'wrap'
        span: 'column',        // 'column' | 'page'
        lock: false,
        size_key: 'single',    // 'single'|'oneAndHalf'|'double'|'custom' (R5 snap)
        /* V3.485 — corner/side wrap (single-column only). Only meaningful
         * when anchor === 'wrap'; text flows around the figure box on the
         * given side. Like the anchor triad above, normalizeTree must
         * never inject this into legacy blocks. */
        wrap_side: 'right',    // 'left' | 'right'
      },
    };
  }

  function newSubfigure(opts) {
    opts = opts || {};
    return {
      id: shortId('sf-'),
      label: opts.label || '',
    };
  }

  /* Build a fresh paper tree from a template id. */
  function newTree(templateId, paperTitle) {
    var tpl = PAPER_TEMPLATES[templateId] || PAPER_TEMPLATES['blank'];
    var sections = (tpl.sections || []).map(function (s, i) {
      var sec = newSection(s.kind, s.label, i);
      // Seed each section with one empty paragraph so the editor isn't a wall of empty headers.
      sec.children.push(newParagraph());
      return sec;
    });
    return {
      meta: { title: paperTitle || '' },
      sections: sections,
    };
  }

  /* Validate a loaded tree — coerces missing fields, keeps last-known-good shape. */
  function normalizeTree(tree) {
    if (!tree || typeof tree !== 'object') tree = {};
    if (!tree.meta) tree.meta = {};
    if (!Array.isArray(tree.sections)) tree.sections = [];
    tree.sections.forEach(function (sec, i) {
      if (!sec.id) sec.id = shortId('sec-');
      if (PAPER_SECTION_KINDS.indexOf(sec.kind) < 0) sec.kind = 'custom';
      if (typeof sec.label !== 'string') sec.label = SECTION_KIND_LABELS[sec.kind] || 'Untitled';
      if (typeof sec.order !== 'number') sec.order = i;
      if (!sec.style_overrides) sec.style_overrides = {};
      if (BLOCK_STATUSES.indexOf(sec.status) < 0) sec.status = 'draft';
      if (!Array.isArray(sec.children)) sec.children = [];
      sec.children.forEach(function (blk) {
        if (!blk.id) blk.id = shortId('p-');
        if (PAPER_BLOCK_KINDS.indexOf(blk.kind) < 0) blk.kind = 'paragraph';
        if (BLOCK_STATUSES.indexOf(blk.status) < 0) blk.status = 'draft';
        if (typeof blk.skeleton !== 'string') blk.skeleton = '';
        if (typeof blk.body !== 'string') blk.body = '';
        if (!blk.attrs) blk.attrs = {};
      });
    });
    // Reorder by `order`, then renormalize indices for predictable saves.
    tree.sections.sort(function (a, b) { return (a.order || 0) - (b.order || 0); });
    tree.sections.forEach(function (sec, i) { sec.order = i; });
    return tree;
  }

  function styleFor(section) {
    var base = SECTION_STYLE[section.kind] || SECTION_STYLE.custom;
    return Object.assign({}, base, section.style_overrides || {});
  }

  /* Public surface */
  window.PaperSchemas = {
    PAPER_SECTION_KINDS: PAPER_SECTION_KINDS,
    SECTION_KIND_LABELS: SECTION_KIND_LABELS,
    SECTION_STYLE: SECTION_STYLE,
    PAPER_BLOCK_KINDS: PAPER_BLOCK_KINDS,
    BLOCK_STATUSES: BLOCK_STATUSES,
    PAPER_TEMPLATES: PAPER_TEMPLATES,
    GRANT_ATTACHED_KINDS: GRANT_ATTACHED_KINDS,
    PAPER_TYPES: PAPER_TYPES,
    normalizePaperType: normalizePaperType,
    MAX_SKELETON_DEPTH: MAX_SKELETON_DEPTH,
    MAX_EQ_LABEL_LENGTH: MAX_EQ_LABEL_LENGTH,
    MAX_SUBFIGURES: MAX_SUBFIGURES,
    shortId: shortId,
    newSection: newSection,
    newParagraph: newParagraph,
    newSubheading: newSubheading,
    MAX_SUBHEADING_LEVEL: MAX_SUBHEADING_LEVEL,
    newList: newList,
    newFigure: newFigure,
    newSubfigure: newSubfigure,
    newSkeletonItem: newSkeletonItem,
    newEquationLibraryEntry: newEquationLibraryEntry,
    MAX_VALUE_KEY_LENGTH: MAX_VALUE_KEY_LENGTH,
    VALUE_KINDS: VALUE_KINDS,
    DEFAULT_ITEM_FORMAT: DEFAULT_ITEM_FORMAT,
    isValidValueKey: isValidValueKey,
    normalizeValueKind: normalizeValueKind,
    newValueEntry: newValueEntry,
    formatValueEntry: formatValueEntry,
    formatValueNumber: formatValueNumber,
    formatInventorySnapshot: formatInventorySnapshot,
    /* V3.649 — paragraph-body lists (see parseBodyRuns). */
    parseBodyRuns: parseBodyRuns,
    listLineMatch: listLineMatch,
    renumberOrderedRuns: renumberOrderedRuns,
    bodyHasList: bodyHasList,
    toggleListLines: toggleListLines,
    newTree: newTree,
    normalizeTree: normalizeTree,
    styleFor: styleFor,
  };
})();
