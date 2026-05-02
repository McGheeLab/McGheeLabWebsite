/* util.js — shared API helpers and date utilities */

const api = {
  async load(path) {
    const res = await fetch(`/api/data/${path}`);
    if (!res.ok) throw new Error(`Failed to load ${path}: ${res.status}`);
    return res.json();
  },

  async save(path, data) {
    // Send the signed-in user's Firebase email + uid so server.py can gate
    // /api/data writes on its RM_WRITE_ALLOWLIST env var. The headers are
    // a local-machine guard, not real authn; firestore.rules is the actual
    // multi-tenant security boundary.
    const headers = { 'Content-Type': 'application/json' };
    if (typeof firebridge !== 'undefined' && firebridge.getUser) {
      const u = firebridge.getUser();
      if (u) {
        if (u.email) headers['X-RM-User-Email'] = u.email;
        if (u.uid)   headers['X-RM-User-Uid']   = u.uid;
      }
    }
    const res = await fetch(`/api/data/${path}`, {
      method: 'PUT',
      headers,
      body: JSON.stringify(data),
    });
    if (!res.ok) throw new Error(`Failed to save ${path}: ${res.status}`);
    return res.json();
  },
};

/* Date helpers */

function today() {
  return new Date().toISOString().slice(0, 10); // YYYY-MM-DD
}

function daysUntil(dateStr) {
  if (!dateStr || dateStr === 'TBD') return null;
  const target = new Date(dateStr + 'T00:00:00');
  const now = new Date();
  now.setHours(0, 0, 0, 0);
  return Math.ceil((target - now) / 86400000);
}

function formatDate(dateStr) {
  if (!dateStr || dateStr === 'TBD') return 'TBD';
  const d = new Date(dateStr + 'T00:00:00');
  return d.toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric' });
}

/* Status → chip class */

function statusChip(status) {
  const map = {
    active: 'chip-green', awarded: 'chip-green', published: 'chip-green',
    completed: 'chip-green', approved: 'chip-green', reimbursed: 'chip-green',
    drafting: 'chip-amber', submitted: 'chip-amber', 'under_review': 'chip-amber',
    revising: 'chip-amber', pending: 'chip-amber', upcoming: 'chip-amber',
    'not_submitted': 'chip-muted',
    expired: 'chip-red', overdue: 'chip-red', rejected: 'chip-red',
    inactive: 'chip-muted', alumni: 'chip-muted',
  };
  const cls = map[status] || 'chip-muted';
  const label = (status || 'unknown').replace(/_/g, ' ');
  return `<span class="chip ${cls}">${label}</span>`;
}

/* Deadline urgency chip */

function deadlineChip(dateStr) {
  const d = daysUntil(dateStr);
  if (d === null) return statusChip('TBD');
  if (d < 0) return `<span class="chip chip-red">overdue</span>`;
  if (d <= 30) return `<span class="chip chip-amber">${d}d</span>`;
  return `<span class="chip chip-green">${d}d</span>`;
}

/* Generate a kebab-case id from a title */

function slugify(text) {
  return text.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '');
}

/* Two-letter avatar initials from a name or email.
 * "Alex McGhee" -> "AM", "alex.mcghee@arizona.edu" -> "AM",
 * "alex" -> "AL", "" -> "?".
 */

function initials(s) {
  var parts = String(s || '').replace(/@.*/, '').split(/[\s._-]+/).filter(Boolean);
  if (parts.length >= 2) return (parts[0][0] + parts[1][0]).toUpperCase();
  return String(s || '?').slice(0, 2).toUpperCase();
}

/* ---- Sortable table system ----
 *
 * Usage in any page:
 *   // Define columns with sort keys
 *   var columns = [
 *     { label: 'Name', key: 'name' },
 *     { label: 'Price', key: 'unit_price', type: 'number' },
 *     { label: 'Date', key: 'date_acquired', type: 'date' },
 *     { label: 'Status', key: 'status' },       // string sort
 *     { label: 'Actions', key: null },           // not sortable
 *   ];
 *
 *   // In your render:
 *   html += sortableHeader(columns, currentSortKey, currentSortDir, 'onSortChange');
 *   var sorted = sortItems(items, currentSortKey, currentSortDir, columns);
 *
 *   // Callback:
 *   window.onSortChange = function(key) { ... toggle sort ... re-render };
 */

var _sortState = {}; // per-page sort state: { key, dir }

function sortableHeader(columns, sortKey, sortDir, callbackName) {
  var html = '<thead><tr>';
  columns.forEach(function (col) {
    if (col.key === null) {
      html += '<th>' + col.label + '</th>';
      return;
    }
    var arrow = '';
    var cls = 'sortable-th';
    if (col.key === sortKey) {
      arrow = sortDir === 'asc' ? ' \u25B2' : ' \u25BC';
      cls += ' sorted';
    }
    html += '<th class="' + cls + '" onclick="' + callbackName + '(\'' + col.key + '\')" style="cursor:pointer;user-select:none;">' + col.label + arrow + '</th>';
  });
  html += '</tr></thead>';
  return html;
}

function _getNestedVal(obj, key) {
  if (!key || !obj) return undefined;
  var parts = key.split('.');
  var val = obj;
  for (var i = 0; i < parts.length; i++) {
    if (val == null) return undefined;
    val = val[parts[i]];
  }
  return val;
}

function sortItems(items, sortKey, sortDir, columns) {
  if (!sortKey) return items;
  var col = columns.find(function (c) { return c.key === sortKey; });
  var type = (col && col.type) || 'string';

  return items.slice().sort(function (a, b) {
    var va = _getNestedVal(a, sortKey);
    var vb = _getNestedVal(b, sortKey);

    // Handle nulls/undefined — push to end
    if (va == null && vb == null) return 0;
    if (va == null) return 1;
    if (vb == null) return -1;

    var cmp = 0;
    if (type === 'number') {
      cmp = (Number(va) || 0) - (Number(vb) || 0);
    } else if (type === 'date') {
      cmp = String(va || '').localeCompare(String(vb || ''));
    } else {
      cmp = String(va || '').toLowerCase().localeCompare(String(vb || '').toLowerCase());
    }

    return sortDir === 'desc' ? -cmp : cmp;
  });
}

/* ---- Item type system ---- */

var ITEM_TYPES = {
  research_project: { label: 'Project', category: 'research', badgeClass: 'type-research_project',
    statuses: ['active', 'paused', 'completed'],
    metaFields: [
      { key: 'pi', label: 'PI', type: 'text' },
      { key: 'research_area', label: 'Research Area', type: 'text' },
    ] },
  grant: { label: 'Grant', category: 'research', badgeClass: 'type-grant',
    statuses: ['drafting', 'submitted', 'under_review', 'awarded', 'rejected', 'revising', 'active', 'no_cost_extension', 'completed'],
    metaFields: [
      { key: 'funder', label: 'Funder', type: 'select', options: ['NIH', 'NSF', 'DoD', 'DoE', 'NASA', 'Industry', 'Foundation', 'Internal', 'Other'] },
      { key: 'mechanism', label: 'Mechanism', type: 'text', placeholder: 'R01, R21, CAREER, startup' },
      { key: 'role', label: 'Role', type: 'select', options: ['PI', 'Co-PI', 'Co-I', 'Consultant', 'Subcontract PI'] },
      { key: 'submit_deadline', label: 'Submit Deadline', type: 'date' },
      { key: 'projected_submission_date', label: 'Projected Submission', type: 'date' },
      { key: 'submission_target', label: 'Submission Target', type: 'text' },
      { key: 'award_number', label: 'Award Number', type: 'text' },
      { key: 'start_date', label: 'Start Date', type: 'date' },
      { key: 'end_date', label: 'End Date', type: 'date' },
      { key: 'total_budget', label: 'Total Budget ($)', type: 'number' },
    ] },
  paper: { label: 'Paper', category: 'research', badgeClass: 'type-paper',
    statuses: ['drafting', 'submitted', 'revising', 'rejected', 'published'],
    metaFields: [
      { key: 'target_journal', label: 'Target Journal', type: 'text' },
      { key: 'lead_author', label: 'Lead Author', type: 'text' },
      { key: 'submission_target', label: 'Submission Target', type: 'text' },
      { key: 'projected_submission_date', label: 'Projected Submission', type: 'date' },
    ] },
  lab_tool: { label: 'Lab Tool', category: 'research', badgeClass: 'type-lab_tool',
    statuses: ['active', 'in_development', 'archived'],
    metaFields: [] },
  utility_tool: { label: 'Utility', category: 'research', badgeClass: 'type-utility_tool',
    statuses: ['active', 'in_development', 'archived'],
    metaFields: [
      { key: 'url', label: 'URL', type: 'text' },
    ] },
  course: { label: 'Course', category: 'teaching', badgeClass: 'type-course',
    statuses: ['active', 'upcoming', 'completed', 'on_hold'],
    metaFields: [
      { key: 'number', label: 'Course Number', type: 'text', placeholder: 'BME466' },
      { key: 'semester', label: 'Semester', type: 'text', placeholder: 'Fall 2026' },
      { key: 'enrollment', label: 'Enrollment', type: 'number' },
    ] },
  conference: { label: 'Conference', category: 'service', badgeClass: 'type-conference',
    statuses: ['upcoming', 'active', 'completed'],
    metaFields: [
      { key: 'role', label: 'Role', type: 'text', placeholder: 'Chair, Presenter, Attendee' },
      { key: 'date', label: 'Date', type: 'date' },
      { key: 'location', label: 'Location', type: 'text' },
    ] },
  peer_review: { label: 'Peer Review', category: 'service', badgeClass: 'type-peer_review',
    statuses: ['pending', 'in_progress', 'completed', 'declined'],
    metaFields: [
      { key: 'journal', label: 'Journal / Agency', type: 'text' },
      { key: 'manuscript_title', label: 'Manuscript Title', type: 'text' },
      { key: 'date_received', label: 'Date Received', type: 'date' },
      { key: 'date_due', label: 'Due Date', type: 'date' },
      { key: 'date_completed', label: 'Date Completed', type: 'date' },
    ] },
  outreach: { label: 'Outreach', category: 'service', badgeClass: 'type-outreach',
    statuses: ['upcoming', 'active', 'completed'],
    metaFields: [
      { key: 'event_type', label: 'Event Type', type: 'text' },
      { key: 'date', label: 'Date', type: 'date' },
      { key: 'location', label: 'Location', type: 'text' },
      { key: 'audience', label: 'Audience', type: 'text' },
    ] },
  committee: { label: 'Committee', category: 'service', badgeClass: 'type-committee',
    statuses: ['active', 'completed'],
    metaFields: [
      { key: 'organization', label: 'Organization', type: 'text' },
      { key: 'role', label: 'Role', type: 'text' },
      { key: 'level', label: 'Level', type: 'select', options: ['Department', 'College', 'University', 'National', 'Other'] },
      { key: 'term_start', label: 'Term Start', type: 'date' },
      { key: 'term_end', label: 'Term End', type: 'date' },
    ] },
};

var CATEGORY_ORDER = ['research', 'teaching', 'service'];
var CATEGORY_LABELS = { research: 'Research', teaching: 'Teaching', service: 'Service' };

function typeBadge(type) {
  var cfg = ITEM_TYPES[type] || { label: type, badgeClass: 'type-default' };
  return '<span class="type-badge ' + cfg.badgeClass + '">' + cfg.label + '</span>';
}

function typeLabel(type) {
  return (ITEM_TYPES[type] || {}).label || type;
}

function typeCategory(type) {
  return (ITEM_TYPES[type] || {}).category || 'research';
}

/* ----- Modal backdrop guard -----
 *
 * Backdrop-click-to-close was losing draft data in two failure modes:
 *   (1) user drags to select text in an input and releases outside the modal
 *       — the click's mouseup fires on the backdrop, closing the modal.
 *   (2) user clicks just outside the modal content by accident, wiping
 *       anything they'd typed.
 *
 * safeCloseOnBackdrop fixes both:
 *   - Requires mousedown AND click to both originate on the backdrop itself
 *     (not bubbled from inside). Kills the drag-select false positive.
 *   - Tracks whether any <input|textarea|select> in `contentEl` fired a real
 *     user `input`/`change` event; if so, requires an explicit confirm.
 *
 * Call this ONCE per modal after inserting content. Returns nothing. The
 * provided `onClose` is invoked when the backdrop click should actually
 * dismiss the modal (e.g. hide it, remove from DOM).
 */
function safeCloseOnBackdrop(backdropEl, contentEl, onClose) {
  var dirty = false;
  var scope = contentEl || backdropEl;
  scope.addEventListener('input', function () { dirty = true; }, true);
  scope.addEventListener('change', function () { dirty = true; }, true);

  var startedOnBackdrop = false;
  backdropEl.addEventListener('mousedown', function (ev) {
    startedOnBackdrop = (ev.target === backdropEl);
  });
  backdropEl.addEventListener('click', function (ev) {
    var wasOnBackdrop = startedOnBackdrop;
    startedOnBackdrop = false;
    if (ev.target !== backdropEl) return;
    if (!wasOnBackdrop) return; // drag-select / mousedown-inside-modal
    if (dirty && !confirm('Discard unsaved changes in this form?')) return;
    dirty = false;
    onClose();
  });
  return {
    /* Reset the dirty tracker — call when a persistent modal is re-opened
     * with a fresh form so stale state doesn't trigger a false confirm. */
    reset: function () { dirty = false; },
    /* Query whether the user has typed/edited anything since the last reset. */
    isDirty: function () { return dirty; },
    /* Wrap an arbitrary close trigger (e.g. Escape key) with the same
     * dirty-check the backdrop uses. Returns a handler you can call freely. */
    confirmClose: function (onClose) {
      if (dirty && !confirm('Discard unsaved changes in this form?')) return false;
      dirty = false;
      onClose();
      return true;
    },
  };
}

/* Simple element creation helper */

function el(tag, attrs, ...children) {
  const e = document.createElement(tag);
  if (attrs) Object.entries(attrs).forEach(([k, v]) => {
    if (k === 'className') e.className = v;
    else if (k.startsWith('on')) e.addEventListener(k.slice(2).toLowerCase(), v);
    else e.setAttribute(k, v);
  });
  children.forEach(c => {
    if (typeof c === 'string') e.appendChild(document.createTextNode(c));
    else if (c) e.appendChild(c);
  });
  return e;
}
