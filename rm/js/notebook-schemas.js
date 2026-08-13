/* notebook-schemas.js — Lab Notebook (ELN) entry schema constants.
 *
 * Document shape in Firestore: userData/{uid}/notebook/{entryId} = {
 *   id, title, date, body_html, body_text, status, tags[], project_id,
 *   protocol_id, attachments[], reference_links[], comments[], witnessed_by,
 *   reference_count, mentions[], created_at, updated_at, ownerUid,
 *   schema_version
 * }
 *
 * The companion index doc lives at userData/{uid}/notebook/_index and holds
 * a lightweight summary list `{ entries: [{id, title, date, tags,
 * project_id, attachment_count, status, updated_at}] }` so the left rail
 * loads in a single Firestore read instead of a collection scan.
 *
 * Invariant: NEVER inline base64 image data into body_html. Firestore
 * docs are capped at 1 MB; even a single phone photo encoded as base64
 * blows that limit. The paste/drop/camera flows in lab-notebook.js MUST
 * upload to Storage at notebook-figures/{uid}/{shortHash}.{ext} via
 * NOTEBOOK_FIGURES.uploadImage, then insert an <img src="https://…">
 * pointing at the resulting download URL.
 */

var NOTEBOOK_ENTRY_STATUSES = ['open', 'closed', 'archived'];

var NOTEBOOK_DEFAULT_TAGS = [
  'microscopy',
  'hydrogel',
  'bioprinting',
  'cell-culture',
  'imaging',
  'analysis',
  'prep',
  'meeting',
];

var NOTEBOOK_ATTACHMENT_KINDS = ['image', 'pdf', 'link'];

/* Mirror PMR's REF_KINDS shape so reference_links round-trip between the
 * two surfaces without translation. 'notebook' is intentionally listed —
 * an entry can reference a sibling entry by URL until the Phase-2 entry
 * picker lands. */
var NOTEBOOK_REF_KINDS = ['notes', 'notebook', 'protocol', 'paper', 'data', 'other'];

/* V3.138 — Phase 3 (slice 1): plan → execute → complete lifecycle.
 * - 'plan'     : the default for new entries; the entry is the experimental plan
 * - 'running'  : the user clicked ▶ Start run at the bench; observations
 *                accumulate; planned content is visible read-only
 * - 'complete' : the user clicked ⏹ End run; a Summary textarea + the
 *                observations log become the post-run record
 *
 * Legacy entries that predate the phase field are coerced to 'complete'
 * by notebookHydrate so they don't suddenly look unfinished. */
var NOTEBOOK_PHASES = ['plan', 'running', 'complete'];

var NOTEBOOK_PHASE_LABELS = {
  plan:     'Plan',
  running:  'Running',
  complete: 'Complete',
};

var NOTEBOOK_PHASE_GLYPHS = {
  plan:     '📝',
  running:  '▶',
  complete: '✅',
};

var NOTEBOOK_DOE_TYPES = ['lhs', 'factorial', 'ccd'];

var NOTEBOOK_DOE_TYPE_LABELS = {
  lhs:       'Latin Hypercube',
  factorial: 'Full Factorial',
  ccd:       'Central Composite',
};

var NOTEBOOK_SCHEMA_VERSION = 1;

/* V3.361 — experimental-design plan scaffold. Lives on the entry as a
 * always-present object (legacy docs get the empty shape backfilled by
 * notebookHydrate). The panel renders above the body and is emphasized
 * while phase === 'plan'. */
function notebookEmptyPlan() {
  return {
    hypothesis: '',
    independent_vars: [],
    dependent_vars: [],
    controls: '',
    success_criteria: '',
  };
}

function notebookHydratePlan(p) {
  if (!p || typeof p !== 'object') return notebookEmptyPlan();
  if (typeof p.hypothesis !== 'string') p.hypothesis = '';
  p.independent_vars = Array.isArray(p.independent_vars) ? p.independent_vars.filter(function (v) { return typeof v === 'string' && v; }) : [];
  p.dependent_vars   = Array.isArray(p.dependent_vars)   ? p.dependent_vars.filter(function (v) { return typeof v === 'string' && v; }) : [];
  if (typeof p.controls !== 'string') p.controls = '';
  if (typeof p.success_criteria !== 'string') p.success_criteria = '';
  return p;
}

function notebookPlanHasContent(p) {
  return !!(p && (p.hypothesis || p.controls || p.success_criteria ||
    (p.independent_vars && p.independent_vars.length) ||
    (p.dependent_vars && p.dependent_vars.length)));
}

/* V3.362 — pull sibling-entry ids out of reference_links so the rail
 * index can answer "which entries link to X" without loading full docs.
 * Matches both absolute and relative lab-notebook URLs. */
function notebookLinkedEntryIds(referenceLinks) {
  var out = [];
  var seen = {};
  (Array.isArray(referenceLinks) ? referenceLinks : []).forEach(function (r) {
    if (!r || r.kind !== 'notebook' || !r.url) return;
    var m = String(r.url).match(/[?&]entry=([A-Za-z0-9_-]+)/);
    if (m && m[1] && !seen[m[1]]) { seen[m[1]] = true; out.push(m[1]); }
  });
  return out;
}

/* Build a fresh empty entry. Caller fills id + ownerUid + uploaded_by. */
function notebookEmptyEntry() {
  var now = new Date().toISOString();
  return {
    id: '',
    title: '',
    date: now.slice(0, 10),
    body_html: '',
    body_text: '',
    status: 'open',
    tags: [],
    project_id: null,
    protocol_id: null,
    attachments: [],
    reference_links: [],
    // V3.234 — external links (Synology share URLs, Drive links, anything).
    // Rendered by EXTERNAL_LINKS.mount in lab-notebook.js's renderEditor.
    externalLinks: [],
    inventory_refs: [],
    protocol_refs: [],
    calc_runs: [],
    design: null,
    // V3.161 — figures flagged for review at the next PMR period. Each
    // entry pairs with an entry in pmr.figure_reviews[] in the matching
    // userData/{uid}/pmr/{periodId} doc. storage_path is the stable join
    // key (attachment array index changes when attachments are removed).
    pmr_review_figures: [],
    // FuturePlan 06 — live protocol run instance. Null until the user
    // loads a definition into this run. Shape:
    //   { protocol_id, protocol_title, protocol_version|null, loaded_at,
    //     inputs:{name→number},              // === widget ctx.overrides
    //     graph_state:{[blockId]:{pickSets,picks,options,dataset}},
    //     grids:[{id,label,rows,cols}],
    //     assignment:{[gridId]:{[slotKey]:itemKey}},
    //     factor:number,                      // aggregation multiplier
    //     computed:{items[],totals}|null,     // non-authoritative cache
    //     frozen:bool, frozen_at:null, snapshot:null }
    // Kept separate from calc_runs[] (the frozen-snippet-in-body feature).
    protocol_run: null,
    // V3.138 — bench-workflow lifecycle
    phase: 'plan',
    run_started_at: null,
    run_ended_at: null,
    summary: '',
    observations: [],
    // V3.361 — experimental-design scaffold (hypothesis / variables /
    // controls / success criteria). Always an object; see notebookEmptyPlan.
    plan: notebookEmptyPlan(),
    comments: [],
    witnessed_by: null,
    reference_count: 0,
    mentions: [],
    created_at: now,
    updated_at: now,
    ownerUid: '',
    schema_version: NOTEBOOK_SCHEMA_VERSION,
  };
}

function notebookHydrate(d) {
  if (!d || typeof d !== 'object') return d;
  d.tags             = Array.isArray(d.tags) ? d.tags : [];
  d.attachments      = Array.isArray(d.attachments) ? d.attachments : [];
  d.reference_links  = Array.isArray(d.reference_links) ? d.reference_links : [];
  // V3.234 — external links (Synology share URLs etc). Coerced via the
  // shared hydrator when available so legacy docs without the field load
  // cleanly and partial rows get back-filled with defaults.
  d.externalLinks    = (typeof window !== 'undefined' && window.EXTERNAL_LINKS && window.EXTERNAL_LINKS.hydrate)
    ? window.EXTERNAL_LINKS.hydrate(d.externalLinks)
    : (Array.isArray(d.externalLinks) ? d.externalLinks : []);
  d.inventory_refs   = Array.isArray(d.inventory_refs) ? d.inventory_refs : [];
  d.protocol_refs    = Array.isArray(d.protocol_refs) ? d.protocol_refs : [];
  // V3.135 — protocol-calculator runs. Each entry is the materialised
  // record of one calc invocation (inputs the user typed + outputs
  // mathjs computed at insert time + chosen format). Persisted so that
  // clicking the inserted block can re-open the modal pre-filled.
  d.calc_runs        = Array.isArray(d.calc_runs) ? d.calc_runs : [];
  // V3.161 — backfill for entries created before V3.161 ran.
  d.pmr_review_figures = Array.isArray(d.pmr_review_figures) ? d.pmr_review_figures : [];
  d.observations     = Array.isArray(d.observations) ? d.observations : [];
  if (typeof d.summary !== 'string') d.summary = '';
  // V3.138 — phase. Legacy entries that lack the field default to
  // 'complete' so the run-mode UI doesn't surface for entries that
  // were authored as static records under the V3.110 → V3.137 model.
  if (NOTEBOOK_PHASES.indexOf(d.phase) < 0) {
    d.phase = (d.phase === undefined || d.phase === null || d.phase === '') ? 'complete' : 'plan';
  }
  if (typeof d.run_started_at !== 'string' && d.run_started_at !== null) d.run_started_at = null;
  if (typeof d.run_ended_at   !== 'string' && d.run_ended_at   !== null) d.run_ended_at   = null;
  // V3.123 — design is null until the user generates one. When present,
  // shape is `{type, factors:[{name,low,high,levels?}], runs:[{name:value,...}],
  // config:{nRuns?,n0?,alpha?}, created_at}`.
  if (d.design && typeof d.design === 'object') {
    if (!Array.isArray(d.design.factors)) d.design.factors = [];
    if (!Array.isArray(d.design.runs))    d.design.runs    = [];
    if (typeof d.design.type !== 'string') d.design.type = 'lhs';
    // V3.361 — per-run results, parallel array keyed by run index (kept
    // out of the run rows themselves so a factor named "result" can't
    // collide). Each slot is {value:'', note:''}.
    if (!Array.isArray(d.design.run_results)) d.design.run_results = [];
    while (d.design.run_results.length < d.design.runs.length) {
      d.design.run_results.push({ value: '', note: '' });
    }
    d.design.run_results.length = d.design.runs.length;
    d.design.run_results = d.design.run_results.map(function (r) {
      if (!r || typeof r !== 'object') return { value: '', note: '' };
      if (typeof r.value !== 'string') r.value = (r.value === null || r.value === undefined) ? '' : String(r.value);
      if (typeof r.note  !== 'string') r.note  = (r.note  === null || r.note  === undefined) ? '' : String(r.note);
      return r;
    });
  } else {
    d.design = null;
  }
  // V3.361 — plan scaffold backfill.
  d.plan = notebookHydratePlan(d.plan);
  // FuturePlan 06 — protocol_run. Null until a definition is loaded;
  // partial rows get back-filled so legacy + in-progress docs load clean.
  if (d.protocol_run && typeof d.protocol_run === 'object') {
    var r = d.protocol_run;
    if (typeof r.protocol_id !== 'string') r.protocol_id = '';
    if (typeof r.protocol_title !== 'string') r.protocol_title = '';
    if (!r.inputs || typeof r.inputs !== 'object') r.inputs = {};
    if (!r.graph_state || typeof r.graph_state !== 'object') r.graph_state = {};
    if (!Array.isArray(r.grids)) r.grids = [];
    if (!r.assignment || typeof r.assignment !== 'object') r.assignment = {};
    if (typeof r.factor !== 'number') r.factor = 1;
    if (!r.computed || typeof r.computed !== 'object') r.computed = null;
    r.frozen = !!r.frozen;
    if (typeof r.frozen_at !== 'string' && r.frozen_at !== null) r.frozen_at = null;
    if (r.snapshot !== null && typeof r.snapshot !== 'object') r.snapshot = null;
  } else {
    d.protocol_run = null;
  }
  d.comments         = Array.isArray(d.comments) ? d.comments : [];
  d.mentions         = Array.isArray(d.mentions) ? d.mentions : [];
  if (typeof d.body_html !== 'string') d.body_html = '';
  if (typeof d.body_text !== 'string') d.body_text = '';
  if (typeof d.title     !== 'string') d.title     = '';
  if (typeof d.status    !== 'string') d.status    = 'open';
  if (typeof d.date      !== 'string') d.date      = new Date().toISOString().slice(0, 10);
  if (typeof d.reference_count !== 'number') d.reference_count = 0;
  if (typeof d.schema_version  !== 'number') d.schema_version  = NOTEBOOK_SCHEMA_VERSION;
  return d;
}

/* Project the small index row out of a full entry doc — kept in sync on
 * every save in lab-notebook.js's saveEntry. */
function notebookIndexRow(entry) {
  return {
    id: entry.id,
    title: entry.title || '(untitled)',
    date: entry.date,
    tags: Array.isArray(entry.tags) ? entry.tags.slice() : [],
    project_id: entry.project_id || null,
    attachment_count: Array.isArray(entry.attachments) ? entry.attachments.length : 0,
    inventory_count:  Array.isArray(entry.inventory_refs) ? entry.inventory_refs.length : 0,
    protocol_count:   Array.isArray(entry.protocol_refs) ? entry.protocol_refs.length : 0,
    calc_count:       Array.isArray(entry.calc_runs) ? entry.calc_runs.length : 0,
    obs_count:        Array.isArray(entry.observations) ? entry.observations.length : 0,
    phase:            (NOTEBOOK_PHASES.indexOf(entry.phase) >= 0) ? entry.phase : 'complete',
    design_runs:      (entry.design && Array.isArray(entry.design.runs)) ? entry.design.runs.length : 0,
    // FuturePlan 06 — protocol-run summary for the rail.
    has_protocol_run: !!entry.protocol_run,
    run_items:        (entry.protocol_run && entry.protocol_run.computed && Array.isArray(entry.protocol_run.computed.items)) ? entry.protocol_run.computed.items.length : 0,
    run_frozen:       !!(entry.protocol_run && entry.protocol_run.frozen),
    // V3.361 — plan scaffold flag for the rail.
    has_plan: notebookPlanHasContent(entry.plan),
    // V3.362 — body excerpt so rail search covers entry content, and
    // sibling-entry links so backlinks compute from the index alone.
    excerpt: String(entry.body_text || '').slice(0, 300),
    linked_entry_ids: notebookLinkedEntryIds(entry.reference_links),
    status: entry.status || 'open',
    updated_at: entry.updated_at,
  };
}
