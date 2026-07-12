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
    // V3.138 — bench-workflow lifecycle
    phase: 'plan',
    run_started_at: null,
    run_ended_at: null,
    summary: '',
    observations: [],
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
  } else {
    d.design = null;
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
    status: entry.status || 'open',
    updated_at: entry.updated_at,
  };
}
