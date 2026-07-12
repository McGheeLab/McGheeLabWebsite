/* protocol-schemas.js — closed vocabularies and tree helpers for the Protocols Builder.
 *
 * V3.113 — Phase 1 ships materials/step/note/figure/safety. The kinds
 * `formula` and `python` are reserved (declared in PROTOCOL_BLOCK_KINDS)
 * so a future-version doc that contains them loads without crashing —
 * `normalizeTree` coerces unknown kinds back to `step`. A future phase
 * implements the renderers.
 *
 * Mirrors the public surface of paper-schemas.js (window.PaperSchemas) so
 * UI code that already understands the {id, kind, status, body, attrs}
 * block shape works on protocols too.
 *
 * Document shape in Firestore: protocols/{protocolId} = {
 *   id, title, ownerUid, authorUids[], status, category, tags[], summary,
 *   tree: {meta, sections}, created_at, updated_at, schema_version,
 *   current_version, published_at,            // reserved for Phase 5
 *   symbol_table_cache, inventory_refs[],     // reserved for Phases 2-3
 *   linked_buckets[],                         // reserved for Phase 4
 * }
 *
 * The Yjs CRDT layer (protocol-yjs.js) hydrates `tree.sections` into a
 * Y.Array<Y.Map<block>> with body fields as Y.Text — same convention as
 * paper-yjs.js.
 */

(function () {
  /* Block kinds — closed list. Phase 1 renders the first five; the last
   * two are reserved so a future-version doc doesn't crash. */
  var PROTOCOL_BLOCK_KINDS = [
    'materials',
    'step',
    'note',      // legacy — folds into `callout` at render time (V3.315)
    'figure',
    'safety',    // legacy — folds into `callout` at render time (V3.315)
    'formula',
    'heading',   // V3.315 — stage heading (code + title + rule)
    'callout',   // V3.315 — generalized note/safety/assumption/timing
    'docHeader', // V3.315 — branded document header for the doc view
    'table',     // V3.316 — generic table (columns + rows, plain JSON)
    'kv',        // V3.316 — definition / derivation list
    'timeline',  // V3.316 — horizontal timeline track
    'calculator', // V3.318 — rich inputs + hero cards + computed table
    'builder',   // V3.324 — params + pickers + combination assembler → named dataset
    'layoutMap', // V3.324 — dataset → well-plate grid
    'python',    // Later phase — Pyodide-backed; not rendered yet
  ];

  /* Block kinds rendered today. Phase 2 (V3.117) added `formula`; V3.315
   * added heading/callout/docHeader; a later phase adds `python`. The
   * PHASE1 name is kept (rather than renamed to RENDERED) for stability
   * of any external scripts that imported it. */
  var PHASE1_BLOCK_KINDS = ['materials', 'step', 'note', 'figure', 'safety', 'formula',
    'heading', 'callout', 'docHeader', 'table', 'kv', 'timeline', 'calculator',
    'builder', 'layoutMap'];

  var BLOCK_STATUSES = ['draft', 'needs-review', 'complete'];

  var PROTOCOL_STATUSES = ['draft', 'published', 'archived'];

  var DEFAULT_TAGS = [
    'wet-lab', 'cell-culture', 'microscopy', 'hydrogel', 'bioprinting',
    'fabrication', 'imaging', 'analysis', 'sop',
  ];

  /* ── Templates — picked at "+ New protocol" time. Authors edit freely after. */
  var PROTOCOL_TEMPLATES = {
    'wet-lab': {
      id: 'wet-lab',
      name: 'Wet-lab protocol',
      description: 'Materials list, three numbered steps, a safety callout, and a figure placeholder.',
      sections: [
        {
          label: 'Experimental Design', order: 0,
          children: [
            { kind: 'materials' },
          ],
        },
        {
          label: 'Protocol', order: 1,
          children: [
            { kind: 'step' },
            { kind: 'step' },
            { kind: 'step' },
            { kind: 'safety', attrs: { severity: 'caution' } },
            { kind: 'figure' },
          ],
        },
      ],
    },
    'equipment-sop': {
      id: 'equipment-sop',
      name: 'Equipment SOP',
      description: 'Operating procedure for a piece of lab equipment. Materials, five steps, a note, a safety callout.',
      sections: [
        {
          label: 'Setup', order: 0,
          children: [
            { kind: 'materials' },
            { kind: 'note', attrs: { flavor: 'info' } },
          ],
        },
        {
          label: 'Operation', order: 1,
          children: [
            { kind: 'step' },
            { kind: 'step' },
            { kind: 'step' },
            { kind: 'step' },
            { kind: 'step' },
          ],
        },
        {
          label: 'Safety + Cleanup', order: 2,
          children: [
            { kind: 'safety', attrs: { severity: 'warning' } },
            { kind: 'step' },
          ],
        },
      ],
    },
    'blank': {
      id: 'blank',
      name: 'Blank',
      description: 'No starter sections. Build your own.',
      sections: [],
    },
  };

  /* ── Tree helpers ── */

  /* Crockford-base32 short id, ~7 chars. Same alphabet as paper-schemas. */
  function shortId(prefix) {
    var alphabet = '0123456789abcdefghjkmnpqrstvwxyz';
    var s = '';
    for (var i = 0; i < 7; i++) s += alphabet[Math.floor(Math.random() * alphabet.length)];
    return (prefix || '') + s;
  }

  function newSection(label, order) {
    return {
      id: shortId('sec-'),
      label: label || 'Untitled section',
      order: order || 0,
      status: 'draft',
      children: [],
    };
  }

  function newStep(opts) {
    opts = opts || {};
    return {
      id: shortId('blk-'),
      kind: 'step',
      status: 'draft',
      body: opts.body || '',
      attrs: {},
    };
  }

  function newMaterials(opts) {
    opts = opts || {};
    return {
      id: shortId('blk-'),
      kind: 'materials',
      status: 'draft',
      body: '',
      attrs: {
        rows: opts.rows || [
          { qty: '', unit: '', free_text: '', item_ref: null },
        ],
      },
    };
  }

  function newNote(opts) {
    opts = opts || {};
    return {
      id: shortId('blk-'),
      kind: 'note',
      status: 'draft',
      body: opts.body || '',
      attrs: { flavor: opts.flavor || 'info' },
    };
  }

  function newFigure(opts) {
    opts = opts || {};
    return {
      id: shortId('blk-'),
      kind: 'figure',
      status: 'draft',
      body: opts.body || '', // caption
      attrs: {
        image_url: opts.image_url || '',
        image_alt: opts.image_alt || '',
        width_pct: opts.width_pct || 100,
        storage_path: opts.storage_path || '',
        hash: opts.hash || '',
        mime: opts.mime || '',
      },
    };
  }

  function newSafety(opts) {
    opts = opts || {};
    return {
      id: shortId('blk-'),
      kind: 'safety',
      status: 'draft',
      body: opts.body || '',
      attrs: { severity: opts.severity || 'caution' },
    };
  }

  /* V3.117 — formula block. Variables are user-editable inputs; output
   * is the computed value of `expression` evaluated against the union of
   * every formula's inputs (and earlier formulas' outputs) in the doc.
   * The output's `name` becomes a usable token via [!var:<name>] in any
   * step/note/safety body. */
  function newFormula(opts) {
    opts = opts || {};
    return {
      id: shortId('blk-'),
      kind: 'formula',
      status: 'draft',
      body: '',
      attrs: {
        label: opts.label || 'Calculation',
        description: opts.description || '',
        expression: opts.expression || '',
        variables: Array.isArray(opts.variables) && opts.variables.length
          ? opts.variables
          : [
              { name: 'x', label: 'Input', default: 1, unit: '' },
            ],
        output: opts.output || {
          name: 'result',
          label: 'Result',
          unit: '',
          decimals: 3,
        },
      },
    };
  }

  /* V3.315 — stage heading. Body is the stage title; `code` is the
   * two-digit stage number rendered before it ("03 · Calculator");
   * `rule` toggles the top hairline in the doc view. */
  function newHeading(opts) {
    opts = opts || {};
    return {
      id: shortId('blk-'),
      kind: 'heading',
      status: 'draft',
      body: opts.body || '',
      attrs: {
        code: opts.code || '',
        rule: opts.rule !== false,
      },
    };
  }

  /* V3.315 — generalized callout. Folds the legacy note/safety kinds:
   * type ∈ critical | note | assume | timing. `timing` renders the
   * "15–30 min active" pill in the doc view. */
  var CALLOUT_TYPES = ['critical', 'note', 'assume', 'timing'];

  function newCallout(opts) {
    opts = opts || {};
    return {
      id: shortId('blk-'),
      kind: 'callout',
      status: 'draft',
      body: opts.body || '',
      attrs: { type: CALLOUT_TYPES.indexOf(opts.type) >= 0 ? opts.type : 'note' },
    };
  }

  /* V3.315 — branded document header (doc-view masthead). Body is the
   * subtitle line. `chips` is a plain JSON array — each {text, var}
   * where `var` optionally names a symbol-table variable whose live
   * value renders next to the text. Brand falls back to
   * labConfig/branding when empty. */
  function newDocHeader(opts) {
    opts = opts || {};
    return {
      id: shortId('blk-'),
      kind: 'docHeader',
      status: 'draft',
      body: opts.body || '',
      attrs: {
        brand: opts.brand || '',
        title: opts.title || '',
        chips: Array.isArray(opts.chips) ? opts.chips : [],
      },
    };
  }

  /* V3.316 — generic table. Columns + rows live as PLAIN JSON arrays on
   * the attrs map (coarse-grained collaboration: an edit replaces the
   * whole array — matches the docHeader chips precedent). Each column:
   * {key, label, align:'left'|'center'|'right', mono:bool}; each row is
   * an object keyed by column key. Body = optional caption. */
  function newTable(opts) {
    opts = opts || {};
    return {
      id: shortId('blk-'),
      kind: 'table',
      status: 'draft',
      body: opts.body || '',
      attrs: {
        columns: Array.isArray(opts.columns) && opts.columns.length
          ? opts.columns
          : [
              { key: 'c1', label: 'Column 1', align: 'left', mono: false },
              { key: 'c2', label: 'Column 2', align: 'left', mono: false },
            ],
        rows: Array.isArray(opts.rows) ? opts.rows : [{}],
      },
    };
  }

  /* V3.316 — definition / derivation list (the appendix "kv" block). */
  function newKv(opts) {
    opts = opts || {};
    return {
      id: shortId('blk-'),
      kind: 'kv',
      status: 'draft',
      body: '',
      attrs: {
        items: Array.isArray(opts.items) && opts.items.length
          ? opts.items
          : [{ term: '', def: '' }],
      },
    };
  }

  /* V3.316 — horizontal timeline. marks[]: {at, label, sub, included}.
   * `at` is the tick caption (e.g. "0 min", "Day 3"); `included:false`
   * renders the mark dimmed/struck (on the axis but not run). Body =
   * optional title above the track. */
  function newTimeline(opts) {
    opts = opts || {};
    return {
      id: shortId('blk-'),
      kind: 'timeline',
      status: 'draft',
      body: opts.body || '',
      attrs: {
        marks: Array.isArray(opts.marks) && opts.marks.length
          ? opts.marks
          : [
              { at: '0', label: '', sub: '', included: true },
              { at: '', label: '', sub: '', included: true },
            ],
      },
    };
  }

  /* V3.318 — calculator: rich inputs (slider/number rows) feeding the
   * shared symbol table, hero-card outputs, and an optional computed
   * table over a named dataset (registered by Release-4 builder blocks).
   * All attrs are plain JSON values. Each output's `expr` is a mathjs
   * expression evaluated against the symbol-table scope; the result is
   * published under `name`, so [!var:name] works everywhere. */
  function newCalculator(opts) {
    opts = opts || {};
    return {
      id: shortId('blk-'),
      kind: 'calculator',
      status: 'draft',
      body: '',
      attrs: {
        label: opts.label || 'Calculator',
        description: opts.description || '',
        inputs: Array.isArray(opts.inputs) && opts.inputs.length
          ? opts.inputs
          : [
              { name: 'x', label: 'Input', widget: 'slider',
                min: 0, max: 10, step: 1, unit: '', rangeHint: '', default: 5 },
            ],
        outputs: Array.isArray(opts.outputs) ? opts.outputs : [],
        table: opts.table || { dataset: '', columns: [] },
      },
    };
  }

  /* V3.324 — interactive builder: parameter sliders (with optional
   * monotonic `lt` cross-constraints), segmented pickers per dimension
   * (params-choice or editable string list), per-row derived fields,
   * and a declarative dedupe rule. Assembled rows register as a named
   * dataset consumed by calculator computed tables + layoutMap grids.
   * Assembly is session-local in the doc view; the block stores only
   * the config. */
  function newBuilder(opts) {
    opts = opts || {};
    return {
      id: shortId('blk-'),
      kind: 'builder',
      status: 'draft',
      body: '',
      attrs: {
        label: opts.label || 'Condition builder',
        description: opts.description || '',
        dataset: opts.dataset || 'conditions',
        params: Array.isArray(opts.params) ? opts.params : [],
        dims: Array.isArray(opts.dims) && opts.dims.length
          ? opts.dims
          : [
              { field: 'option', label: 'Option', source: 'list',
                options: ['A', 'B'], editable: true },
            ],
        derived: Array.isArray(opts.derived) ? opts.derived : [],
        dedupe: opts.dedupe || { when: '', ignore: [] },
      },
    };
  }

  /* V3.324 — layout map: renders a named dataset as a plate-style grid.
   * cellLabel / cellSub are per-row mathjs expressions (bare field
   * names work; strings pass through); colorField's distinct values map
   * to a small palette; unused wells show spareLabel. */
  function newLayoutMap(opts) {
    opts = opts || {};
    return {
      id: shortId('blk-'),
      kind: 'layoutMap',
      status: 'draft',
      body: '',
      attrs: {
        label: opts.label || 'Plate map',
        dataset: opts.dataset || 'conditions',
        rows: (typeof opts.rows === 'number') ? opts.rows : 4,
        cols: (typeof opts.cols === 'number') ? opts.cols : 6,
        cellLabel: opts.cellLabel || '',
        cellSub: opts.cellSub || '',
        colorField: opts.colorField || '',
        spareLabel: (typeof opts.spareLabel === 'string') ? opts.spareLabel : '—',
      },
    };
  }

  /* Factory dispatcher used by the editor's "+ Add block" menu. */
  function newBlock(kind, opts) {
    switch (kind) {
      case 'materials': return newMaterials(opts);
      case 'step':      return newStep(opts);
      case 'note':      return newNote(opts);
      case 'figure':    return newFigure(opts);
      case 'safety':    return newSafety(opts);
      case 'formula':   return newFormula(opts);
      case 'heading':   return newHeading(opts);
      case 'callout':   return newCallout(opts);
      case 'docHeader': return newDocHeader(opts);
      case 'table':     return newTable(opts);
      case 'kv':        return newKv(opts);
      case 'timeline':  return newTimeline(opts);
      case 'calculator': return newCalculator(opts);
      case 'builder':   return newBuilder(opts);
      case 'layoutMap': return newLayoutMap(opts);
      default:          return newStep(opts);  // unknown → fall back to step
    }
  }

  /* Build a fresh protocol tree from a template id. */
  function newTree(templateId, title) {
    var tpl = PROTOCOL_TEMPLATES[templateId] || PROTOCOL_TEMPLATES['blank'];
    var sections = (tpl.sections || []).map(function (s, i) {
      var sec = newSection(s.label, i);
      (s.children || []).forEach(function (c) {
        sec.children.push(newBlock(c.kind, c.attrs ? { ...c.attrs } : {}));
      });
      return sec;
    });
    return {
      meta: { title: title || '' },
      sections: sections,
    };
  }

  /* Build a fresh empty protocol doc. Caller fills id + ownerUid (+ ideally
   * author_uid + author_name for the V3.119 byline). */
  function protocolEmptyDoc(opts) {
    opts = opts || {};
    var now = new Date().toISOString();
    return {
      id: opts.id || '',
      title: opts.title || '',
      ownerUid: opts.ownerUid || '',
      authorUids: opts.ownerUid ? [opts.ownerUid] : [],
      // V3.119 — explicit author tracking. `author_uid` is immutable
      // after creation (the original creator); `ownerUid` controls edit
      // permission and could later be transferred. They start equal.
      // `author_name` is cached at creation for fast list rendering.
      author_uid: opts.author_uid || opts.ownerUid || '',
      author_name: opts.author_name || '',
      status: 'draft',
      category: opts.category || '',
      tags: opts.tags || [],
      summary: opts.summary || '',
      tree: opts.tree || newTree(opts.template_id || 'blank', opts.title || ''),
      created_at: now,
      updated_at: now,
      schema_version: 2,         // V3.119 bumped from 1 → 2
      // V3.119 — version control + forking.
      current_version: 0,        // 0 = no manual snapshots yet (V3.119)
      latest_snapshot_at: null,  // ISO of last saveVersion call
      fork_count: 0,
      forked_from: opts.forked_from || null, // {protocol_id, version, ...}
      published_at: null,        // Phase 5b
      // Reserved for later phases — declared so Firestore doc shape is stable.
      symbol_table_cache: {},
      inventory_refs: [],
      linked_buckets: [],
    };
  }

  /* Hydrate a loaded doc — coerces missing fields, keeps last-known-good shape.
   * V3.119 — adds defaults for new author + version + fork fields so legacy
   * V3.113-era docs (schema_version 1) load without crashing. */
  function protocolHydrate(d) {
    if (!d || typeof d !== 'object') return protocolEmptyDoc();
    if (typeof d.title !== 'string') d.title = '';
    if (typeof d.ownerUid !== 'string') d.ownerUid = '';
    if (!Array.isArray(d.authorUids)) d.authorUids = d.ownerUid ? [d.ownerUid] : [];
    if (typeof d.author_uid !== 'string') d.author_uid = d.ownerUid || '';
    if (typeof d.author_name !== 'string') d.author_name = '';
    if (PROTOCOL_STATUSES.indexOf(d.status) < 0) d.status = 'draft';
    if (typeof d.category !== 'string') d.category = '';
    if (!Array.isArray(d.tags)) d.tags = [];
    if (typeof d.summary !== 'string') d.summary = '';
    if (!d.tree) d.tree = newTree('blank', d.title);
    normalizeTree(d.tree);
    if (typeof d.schema_version !== 'number') d.schema_version = 1;
    if (typeof d.current_version !== 'number') d.current_version = 0;
    if (typeof d.fork_count !== 'number') d.fork_count = 0;
    if (d.forked_from === undefined) d.forked_from = null;
    if (!d.symbol_table_cache) d.symbol_table_cache = {};
    if (!Array.isArray(d.inventory_refs)) d.inventory_refs = [];
    if (!Array.isArray(d.linked_buckets)) d.linked_buckets = [];
    return d;
  }

  function normalizeTree(tree) {
    if (!tree || typeof tree !== 'object') return tree;
    if (!tree.meta) tree.meta = {};
    if (!Array.isArray(tree.sections)) tree.sections = [];
    tree.sections.forEach(function (sec, i) {
      if (!sec.id) sec.id = shortId('sec-');
      if (typeof sec.label !== 'string') sec.label = 'Untitled section';
      if (typeof sec.order !== 'number') sec.order = i;
      if (BLOCK_STATUSES.indexOf(sec.status) < 0) sec.status = 'draft';
      if (!Array.isArray(sec.children)) sec.children = [];
      sec.children.forEach(function (blk) {
        if (!blk.id) blk.id = shortId('blk-');
        // Unknown kinds (e.g. a future `formula` doc loaded into Phase 1)
        // fall back to `step` so the renderer doesn't crash. The original
        // kind is preserved on the block until it's edited; once edited,
        // the fallback sticks.
        if (PROTOCOL_BLOCK_KINDS.indexOf(blk.kind) < 0) blk.kind = 'step';
        if (BLOCK_STATUSES.indexOf(blk.status) < 0) blk.status = 'draft';
        if (typeof blk.body !== 'string') blk.body = '';
        if (!blk.attrs) blk.attrs = {};
        // V3.315 — defaults for the new kinds so partial docs stay valid.
        if (blk.kind === 'callout' && CALLOUT_TYPES.indexOf(blk.attrs.type) < 0) {
          blk.attrs.type = 'note';
        }
        if (blk.kind === 'heading') {
          if (typeof blk.attrs.code !== 'string') blk.attrs.code = '';
          if (typeof blk.attrs.rule !== 'boolean') blk.attrs.rule = true;
        }
        if (blk.kind === 'docHeader') {
          if (typeof blk.attrs.brand !== 'string') blk.attrs.brand = '';
          if (typeof blk.attrs.title !== 'string') blk.attrs.title = '';
          if (!Array.isArray(blk.attrs.chips)) blk.attrs.chips = [];
        }
        // V3.316 defaults
        if (blk.kind === 'table') {
          if (!Array.isArray(blk.attrs.columns)) blk.attrs.columns = [];
          if (!Array.isArray(blk.attrs.rows)) blk.attrs.rows = [];
        }
        if (blk.kind === 'kv' && !Array.isArray(blk.attrs.items)) blk.attrs.items = [];
        if (blk.kind === 'timeline' && !Array.isArray(blk.attrs.marks)) blk.attrs.marks = [];
        // V3.318 defaults
        if (blk.kind === 'calculator') {
          if (!Array.isArray(blk.attrs.inputs)) blk.attrs.inputs = [];
          if (!Array.isArray(blk.attrs.outputs)) blk.attrs.outputs = [];
          if (!blk.attrs.table || typeof blk.attrs.table !== 'object') {
            blk.attrs.table = { dataset: '', columns: [] };
          }
          if (!Array.isArray(blk.attrs.table.columns)) blk.attrs.table.columns = [];
        }
        // V3.324 defaults
        if (blk.kind === 'builder') {
          if (typeof blk.attrs.dataset !== 'string') blk.attrs.dataset = 'conditions';
          if (!Array.isArray(blk.attrs.params)) blk.attrs.params = [];
          if (!Array.isArray(blk.attrs.dims)) blk.attrs.dims = [];
          if (!Array.isArray(blk.attrs.derived)) blk.attrs.derived = [];
          if (!blk.attrs.dedupe || typeof blk.attrs.dedupe !== 'object') {
            blk.attrs.dedupe = { when: '', ignore: [] };
          }
          if (!Array.isArray(blk.attrs.dedupe.ignore)) blk.attrs.dedupe.ignore = [];
        }
        if (blk.kind === 'layoutMap') {
          if (typeof blk.attrs.dataset !== 'string') blk.attrs.dataset = '';
          if (typeof blk.attrs.rows !== 'number') blk.attrs.rows = 4;
          if (typeof blk.attrs.cols !== 'number') blk.attrs.cols = 6;
          if (typeof blk.attrs.cellLabel !== 'string') blk.attrs.cellLabel = '';
          if (typeof blk.attrs.cellSub !== 'string') blk.attrs.cellSub = '';
          if (typeof blk.attrs.colorField !== 'string') blk.attrs.colorField = '';
          if (typeof blk.attrs.spareLabel !== 'string') blk.attrs.spareLabel = '—';
        }
      });
    });
    tree.sections.sort(function (a, b) { return (a.order || 0) - (b.order || 0); });
    tree.sections.forEach(function (sec, i) { sec.order = i; });
    return tree;
  }

  /* Project a list-row from a full protocol doc — used by the list view
   * so we don't have to load every full tree to render a card. */
  function protocolListRow(p) {
    return {
      id: p.id,
      title: p.title || '(untitled)',
      status: p.status || 'draft',
      owner_uid: p.ownerUid || '',
      summary: p.summary || '',
      category: p.category || '',
      tags: Array.isArray(p.tags) ? p.tags.slice() : [],
      updated_at: p.updated_at || '',
    };
  }

  /* Public surface. */
  window.ProtocolSchemas = {
    PROTOCOL_BLOCK_KINDS: PROTOCOL_BLOCK_KINDS,
    PHASE1_BLOCK_KINDS: PHASE1_BLOCK_KINDS,
    BLOCK_STATUSES: BLOCK_STATUSES,
    PROTOCOL_STATUSES: PROTOCOL_STATUSES,
    DEFAULT_TAGS: DEFAULT_TAGS,
    CALLOUT_TYPES: CALLOUT_TYPES,
    PROTOCOL_TEMPLATES: PROTOCOL_TEMPLATES,
    shortId: shortId,
    newSection: newSection,
    newBlock: newBlock,
    newStep: newStep,
    newMaterials: newMaterials,
    newNote: newNote,
    newFigure: newFigure,
    newSafety: newSafety,
    newFormula: newFormula,
    newHeading: newHeading,
    newCallout: newCallout,
    newDocHeader: newDocHeader,
    newTable: newTable,
    newKv: newKv,
    newTimeline: newTimeline,
    newCalculator: newCalculator,
    newBuilder: newBuilder,
    newLayoutMap: newLayoutMap,
    newTree: newTree,
    protocolEmptyDoc: protocolEmptyDoc,
    protocolHydrate: protocolHydrate,
    protocolListRow: protocolListRow,
    normalizeTree: normalizeTree,
  };
})();
