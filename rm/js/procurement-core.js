/* ================================================================
   procurement-core.js — V3.813
   ----------------------------------------------------------------
   The procurement state machine, with NO DOM and NO Firebase. The
   page (procurement.js) renders it; the emulator E2E suite and the
   node fixtures run these exact bytes, so what the tests prove is
   what the page does.

   One ticket = one procurementTickets/{id} document that walks

     requested ⇄ needs_info → approved → ordered → received → placed
                      ↘ denied          ↘ cancelled

   Roles (see actorFrom):
     requester  — ticket.requestedBy === actor.uid
     approver   — admin or cap 'procurement:approve'
     purchaser  — admin or cap 'procurement:order'
     member     — anyone who can open the page (isLabMember)
     admin      — role 'admin'

   Every mutation goes through buildPatch(): it validates, returns the
   field patch, and returns `appends` (history entry, note, watcher)
   for the writer to wrap in arrayUnion. firestore.rules enforces the
   same transition table server-side (V3.813 block).

   Exports: window.PROC_CORE in the browser, module.exports in node.
   ================================================================ */
(function (root, factory) {
  'use strict';
  var api = factory();
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  if (root) root.PROC_CORE = api;
})(typeof window !== 'undefined' ? window : null, function () {
  'use strict';

  /* ─── Vocabulary ──────────────────────────────────────────── */
  var STATUS = {
    requested:  { label: 'Awaiting approval',     short: 'Requested',  chip: 'pending',   order: 1, active: true  },
    needs_info: { label: 'Question for requester', short: 'Question',   chip: 'question',  order: 2, active: true  },
    approved:   { label: 'Approved — to order',   short: 'Approved',   chip: 'approved',  order: 3, active: true  },
    ordered:    { label: 'On order',              short: 'Ordered',    chip: 'ordered',   order: 4, active: true  },
    received:   { label: 'Arrived — put away',    short: 'Arrived',    chip: 'received',  order: 5, active: true  },
    placed:     { label: 'In inventory',          short: 'Placed',     chip: 'placed',    order: 6, active: false },
    denied:     { label: 'Denied',                short: 'Denied',     chip: 'denied',    order: 7, active: false },
    cancelled:  { label: 'Withdrawn',             short: 'Withdrawn',  chip: 'cancelled', order: 8, active: false },
  };
  var STATUS_IDS = Object.keys(STATUS);

  var URGENCY = {
    routine:     { label: 'Routine',              rank: 0 },
    needed_soon: { label: 'Needed soon',          rank: 1 },
    urgent:      { label: 'Urgent — blocking',    rank: 2 },
  };

  /* Request categories → the inventory category the item lands in. */
  var CATEGORIES = [
    { id: 'consumable', label: 'Consumable',          inventory: 'consumable' },
    { id: 'reagent',    label: 'Reagent / kit',       inventory: 'research_reagents' },
    { id: 'chemical',   label: 'Chemical',            inventory: 'research_chem' },
    { id: 'cells',      label: 'Cells / biologics',   inventory: 'research_cells' },
    { id: 'equipment',  label: 'Equipment',           inventory: 'equipment' },
    { id: 'computer',   label: 'Computer / parts',    inventory: 'computer' },
    { id: 'software',   label: 'Software / license',  inventory: 'software' },
    { id: 'office',     label: 'Office / furniture',  inventory: 'office' },
    { id: 'other',      label: 'Other',               inventory: 'other' },
  ];
  var CATEGORY_IDS = CATEGORIES.map(function (c) { return c.id; });

  var METHODS = [
    { id: 'pcard',           label: 'P-card' },
    { id: 'buyways',         label: 'BuyWays (UA)' },
    { id: 'ilab',            label: 'iLab' },
    { id: 'amazon_business', label: 'Amazon Business' },
    { id: 'vendor_po',       label: 'Vendor PO / quote' },
    { id: 'internal',        label: 'Internal / stockroom' },
    { id: 'other',           label: 'Other' },
  ];
  var METHOD_IDS = METHODS.map(function (m) { return m.id; });

  /* V3.814 — the form asks whether this is a one-off or something the lab
   * will buy again (a recurring item is worth a standing source). */
  var PURCHASE_TYPES = [
    { id: 'one_time',  label: 'One-time purchase' },
    { id: 'recurring', label: 'Possibly recurring — we will buy this again' },
  ];
  var PURCHASE_TYPE_IDS = PURCHASE_TYPES.map(function (p) { return p.id; });
  var RECURRENCE = [
    { id: 'monthly',   label: 'About monthly' },
    { id: 'quarterly', label: 'Every few months' },
    { id: 'semester',  label: 'Each semester' },
    { id: 'yearly',    label: 'About yearly' },
    { id: 'unsure',    label: 'Not sure how often' },
  ];
  var RECURRENCE_IDS = RECURRENCE.map(function (r) { return r.id; });
  /* Price-comparison rows: a few sources, not a catalogue. */
  var MAX_COMPARISONS = 6;
  var COMPARISON_KEYS = ['vendor', 'catalogueNumber', 'url', 'unitPrice', 'packSize', 'leadTime', 'notes'];

  /* Fields a requester/approver may change with the `edit` action. */
  var EDITABLE = ['itemDescription', 'productUrl', 'vendor', 'catalogueNumber', 'quantity',
    'unitCost', 'estimatedCost', 'category', 'projectId', 'project', 'fundingAccount', 'fundingLabel',
    'neededBy', 'urgency', 'reason', 'purchaseType', 'recurrence', 'comparisons'];

  /* Keys a same-status "note / flag / watch" update may touch — mirrored in
   * firestore.rules' onlyTouches() list. Keep the two in step. */
  var NOTE_ONLY_KEYS = ['notes', 'history', 'updatedAt', 'issue', 'issueBy', 'issueByName',
    'issueAt', 'watcherUids', 'lastActorUid', 'lastActivityAt'];
  /* V3.814 — what a `reassign` (change the funding string, any stage) may
   * touch beyond NOTE_ONLY_KEYS. Mirrored in firestore.rules' fundingKeys(). */
  var FUNDING_KEYS = ['projectId', 'project', 'fundingAccount', 'fundingLabel',
    'fundingChangedBy', 'fundingChangedByName', 'fundingChangedAt', 'fundingChangedFrom'];

  var ALL = STATUS_IDS.slice();

  /* ─── Transition table ────────────────────────────────────── */
  /* roles: any one suffices. 'requester' is the ticket's requester;
   * 'approver' / 'purchaser' / 'admin' come from the actor's caps.
   * `to` may be a function of (ticket, actor). */
  var TRANSITIONS = {
    edit:        { from: ['requested', 'needs_info', 'approved'], roles: ['requester', 'approver'],
                   to: function (t, a) {
                     // A requester's edit after approval needs re-approval; a requester's
                     // edit while a question is open IS the answer (the rules let a
                     // requester leave needs_info only towards requested/cancelled).
                     if (t.status === 'approved')   return (isRequester(t, a) && !a.canApprove) ? 'requested' : 'approved';
                     if (t.status === 'needs_info') return (isRequester(t, a) && !a.canApprove) ? 'requested' : 'needs_info';
                     return t.status;
                   } },
    ask:         { from: ['requested'],                            to: 'needs_info', roles: ['approver'],  needsNote: true },
    answer:      { from: ['needs_info'],                           to: 'requested',  roles: ['requester'], needsNote: true },
    approve:     { from: ['requested', 'needs_info'],              to: 'approved',   roles: ['approver'] },
    deny:        { from: ['requested', 'needs_info', 'approved'],  to: 'denied',     roles: ['approver'],  needsNote: true },
    unapprove:   { from: ['approved'],                             to: 'requested',  roles: ['approver'] },
    order:       { from: ['approved'],                             to: 'ordered',    roles: ['purchaser'] },
    edit_order:  { from: ['ordered'],                              to: 'ordered',    roles: ['purchaser'] },
    unorder:     { from: ['ordered'],                              to: 'approved',   roles: ['purchaser'] },
    receive:     { from: ['ordered'],                              to: 'received',   roles: ['member'] },
    unreceive:   { from: ['received'],                             to: 'ordered',    roles: ['purchaser'] },
    place:       { from: ['received'],                             to: 'placed',     roles: ['member'] },
    cancel:      { from: ['requested', 'needs_info', 'approved'],  to: 'cancelled',  roles: ['requester'] },
    reopen:      { from: ['cancelled', 'denied'],                  to: 'requested',  roles: ['approver', 'requester-of-cancelled'] },
    note:        { from: ALL,                                      roles: ['member'],   same: true },
    flag:        { from: ['ordered', 'received'],                  roles: ['member'],   same: true, needsNote: true },
    clear_issue: { from: ['ordered', 'received'],                  roles: ['purchaser'], same: true },
    // V3.814 — the funding string can be moved at ANY live stage (a cost
    // transfer after the fact included); the requester is told by the function.
    reassign:    { from: ['requested', 'needs_info', 'approved', 'ordered', 'received', 'placed'], roles: ['approver'], same: true },
    delete:      { from: ALL,                                      roles: ['admin'] },
  };

  /* Display order: what the person most likely wants comes first. */
  var ACTION_ORDER = ['answer', 'approve', 'ask', 'order', 'receive', 'place', 'deny', 'edit', 'edit_order',
    'unapprove', 'unorder', 'unreceive', 'reopen', 'cancel', 'flag', 'clear_issue', 'reassign', 'note', 'delete'];

  var ACTION_LABEL = {
    submit: 'Submitted', edit: 'Edit request', ask: 'Ask a question', answer: 'Answer', approve: 'Approve', deny: 'Deny',
    unapprove: 'Undo approval', order: 'Mark ordered', edit_order: 'Edit order', unorder: 'Undo order',
    receive: 'Mark received', unreceive: 'Undo received', place: 'Put away', cancel: 'Withdraw',
    reopen: 'Reopen', note: 'Add note', flag: 'Flag a problem', clear_issue: 'Clear flag', reassign: 'Change funding', delete: 'Delete',
  };
  /* Human names for the request fields (edit history, errors). */
  var FIELD_LABEL = { itemDescription: 'item', productUrl: 'link', vendor: 'vendor', catalogueNumber: 'catalogue #', quantity: 'quantity',
    unitCost: 'unit cost', estimatedCost: 'estimated total', category: 'category', fundingAccount: 'funding string', fundingLabel: 'funding string',
    projectId: 'project', project: 'project', neededBy: 'needed-by date', urgency: 'urgency', reason: 'reason',
    purchaseType: 'purchase type', recurrence: 'how often', comparisons: 'price comparison' };
  /* Which actions change status (drive the primary-button styling). */
  var PRIMARY = { answer: 1, approve: 1, order: 1, receive: 1, place: 1 };

  /* ─── Helpers ─────────────────────────────────────────────── */
  function genId() {
    var c = (typeof crypto !== 'undefined' && crypto.randomUUID) ? crypto : null;
    if (c) return c.randomUUID();
    return 'xxxxxxxx-xxxx-4xxx-yxxx-xxxxxxxxxxxx'.replace(/[xy]/g, function (ch) {
      var r = (Math.random() * 16) | 0; return (ch === 'x' ? r : (r & 3) | 8).toString(16);
    });
  }
  function num(v, d) { var n = parseFloat(v); return isFinite(n) ? n : (d == null ? 0 : d); }
  function str(v) { return v == null ? '' : String(v).trim(); }
  // A real calendar date: 2026-02-30 parses in some engines but is not one.
  function isDateStr(s) {
    if (!/^\d{4}-\d{2}-\d{2}$/.test(s)) return false;
    var d = new Date(s + 'T00:00:00Z');
    return !isNaN(d.getTime()) && d.toISOString().slice(0, 10) === s;
  }
  // Strictly a plain decimal number (no $ sign, no units, no 1e5, no Infinity).
  function isPlainNumber(v) { return typeof v === 'number' ? isFinite(v) : /^-?\d+(\.\d+)?$/.test(str(v)); }
  function pad(n) { return String(n).padStart(2, '0'); }
  function todayStr(now) {
    var d = now ? new Date(now) : new Date();
    return d.getFullYear() + '-' + pad(d.getMonth() + 1) + '-' + pad(d.getDate());
  }
  /* Firestore Timestamp | Date | ISO | number | 'YYYY-MM-DD' → ms (0 if unknown). */
  function toMs(v) {
    if (!v) return 0;
    if (typeof v === 'number') return v;
    if (v instanceof Date) return v.getTime();
    if (typeof v.toMillis === 'function') return v.toMillis();
    if (typeof v.seconds === 'number') return v.seconds * 1000;
    if (typeof v._seconds === 'number') return v._seconds * 1000;
    if (typeof v === 'string') {
      var t = Date.parse(/^\d{4}-\d{2}-\d{2}$/.test(v) ? v + 'T12:00:00' : v);
      return isFinite(t) ? t : 0;
    }
    return 0;
  }
  function fmtDate(v) {
    var ms = toMs(v); if (!ms) return '';
    var d = new Date(ms);
    return d.getFullYear() + '-' + pad(d.getMonth() + 1) + '-' + pad(d.getDate());
  }
  function fmtDateLong(v) {
    var ms = toMs(v); if (!ms) return '';
    return new Date(ms).toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric' });
  }
  function fmtMoney(n) {
    if (n == null || n === '' || !isFinite(+n)) return '';
    return '$' + (+n).toFixed(2).replace(/\B(?=(\d{3})+(?!\d))/g, ',');
  }
  function ageDays(v, now) {
    var ms = toMs(v); if (!ms) return 0;
    return Math.floor(((now ? toMs(now) : Date.now()) - ms) / 86400000);
  }
  function ageLabel(v, now) {
    var d = ageDays(v, now);
    if (d <= 0) return 'today';
    if (d === 1) return 'yesterday';
    if (d < 14) return d + 'd ago';
    if (d < 60) return Math.round(d / 7) + 'w ago';
    return Math.round(d / 30) + 'mo ago';
  }
  function normVendor(v) { return str(v).toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim(); }

  function actorName(actor) { return (actor && actor.name) || ''; }
  function isRequester(t, a) { return !!(t && a && t.requestedBy && t.requestedBy === a.uid); }

  /** Build the actor the page passes everywhere. hasCap is firebridge.hasCapability. */
  function actorFrom(user, profile, hasCap) {
    var isAdmin = !!(profile && profile.role === 'admin');
    var cap = function (c) { return isAdmin || !!(typeof hasCap === 'function' && hasCap(c)); };
    return {
      uid: user ? user.uid : '',
      name: (profile && profile.name) || (user && (user.displayName || user.email)) || '',
      isAdmin: isAdmin,
      canApprove: cap('procurement:approve'),
      canOrder: cap('procurement:order'),
      isInvMgr: cap('inventory:manage'),
    };
  }

  function hasRole(role, t, a) {
    switch (role) {
      case 'member':    return true;
      case 'requester': return isRequester(t, a);
      case 'approver':  return !!a.canApprove;
      case 'purchaser': return !!a.canOrder;
      case 'admin':     return !!a.isAdmin;
      case 'requester-of-cancelled': return isRequester(t, a) && t.status === 'cancelled';
    }
    return false;
  }

  /** May `actor` take `action` on `ticket` right now? */
  function can(action, t, a) {
    var tr = TRANSITIONS[action];
    if (!tr || !t || !a) return false;
    var st = t.status || 'requested';
    if (tr.from.indexOf(st) < 0) return false;
    if (action === 'clear_issue' && !t.issue) return false;
    if (action === 'flag' && t.issue) return false;
    return tr.roles.some(function (r) { return hasRole(r, t, a); });
  }

  function availableActions(t, a) {
    return ACTION_ORDER.filter(function (act) { return can(act, t, a); });
  }

  function targetStatus(action, t, a) {
    var tr = TRANSITIONS[action];
    if (!tr) return t.status;
    if (tr.same) return t.status || 'requested';
    return typeof tr.to === 'function' ? tr.to(t, a) : tr.to;
  }

  /* ─── Validation ──────────────────────────────────────────── */
  function cleanRequest(values) {
    var v = values || {};
    var qty = num(v.quantity, 1); if (!(qty > 0)) qty = 1;
    var unit = num(v.unitCost, 0); if (!(unit >= 0)) unit = 0;
    // The estimate FOLLOWS unit × qty whenever a unit cost is known; a stored
    // estimatedCost is only trusted when there is no unit cost to derive it
    // from (legacy tickets, or a lump-sum guess). Otherwise an edit that
    // changes the quantity would keep the old total (caught by the E2E suite).
    var est = unit > 0 ? +(unit * qty).toFixed(2)
            : ((v.estimatedCost != null && v.estimatedCost !== '') ? num(v.estimatedCost, 0) : 0);
    var out = {
      itemDescription: str(v.itemDescription),
      productUrl: str(v.productUrl),
      vendor: str(v.vendor),
      catalogueNumber: str(v.catalogueNumber),
      quantity: qty,
      unitCost: unit,
      estimatedCost: est < 0 ? 0 : est,
      // Unknown but non-empty categories are kept (a legacy ticket edited in
      // place must not be silently re-filed as 'consumable').
      category: CATEGORY_IDS.indexOf(v.category) >= 0 ? v.category : (str(v.category) || 'consumable'),
      projectId: str(v.projectId) === '__other' ? '' : str(v.projectId),
      project: str(v.project),
      fundingAccount: str(v.fundingAccount),
      fundingLabel: str(v.fundingLabel) || str(v.fundingAccount),
      neededBy: isDateStr(str(v.neededBy)) ? str(v.neededBy) : '',
      urgency: URGENCY[v.urgency] ? v.urgency : 'routine',
      reason: str(v.reason),
      // V3.814 — one-off or recurring, and the price comparison (optional).
      purchaseType: PURCHASE_TYPE_IDS.indexOf(v.purchaseType) >= 0 ? v.purchaseType : '',
      recurrence: v.purchaseType === 'recurring' && RECURRENCE_IDS.indexOf(v.recurrence) >= 0 ? v.recurrence : '',
      comparisons: cleanComparisons(v.comparisons, v),
    };
    return out;
  }

  var URL_RE = /^https?:\/\/[^\s"'<>]+$/i;
  /** Normalise the comparison rows: trim, drop rows with nothing in them,
   * cap at MAX_COMPARISONS, mark the row that matches the main vendor as
   * `chosen` when none is. Bad prices/links are kept as typed so
   * validateComparisons() can point at the row. */
  function cleanComparisons(rows, v) {
    var out = [];
    (Array.isArray(rows) ? rows : []).forEach(function (r) {
      if (!r || typeof r !== 'object') return;
      var c = {};
      COMPARISON_KEYS.forEach(function (k) { c[k] = k === 'unitPrice' ? priceVal(r[k]) : str(r[k]); });
      c.chosen = !!r.chosen;
      if (!COMPARISON_KEYS.some(function (k) { return c[k] !== '' && c[k] != null; })) return;   // an empty row is no row
      out.push(c);
    });
    out = out.slice(0, MAX_COMPARISONS);
    if (out.length && !out.some(function (r) { return r.chosen; }) && v && str(v.vendor)) {
      var vk = normVendor(v.vendor);
      var hit = out.find(function (r) { return normVendor(r.vendor) === vk; });
      if (hit) hit.chosen = true;
    }
    return out;
  }
  /* A price as typed OR as an AI wrote it ("$12.50", "12,345.00 USD") → number | '' | the raw junk. */
  function priceVal(raw) {
    if (raw == null || str(raw) === '') return '';
    if (typeof raw === 'number') return isFinite(raw) ? raw : str(raw);
    var s = str(raw);
    if (isPlainNumber(s)) return +s;
    var m = s.replace(/,/g, '').match(/-?\d+(\.\d+)?/);
    // "$12.50", "USD 4.50", "12,345.00 USD", "€45.00" — a currency mark before or after, nothing else.
    return (m && /^\s*(usd|us\$|\$|eur|€|gbp|£)?\s*-?[\d.,]+\s*(usd|us\$|\$|eur|€|gbp|£)?\s*$/i.test(s)) ? +m[0] : s;
  }
  function validateComparisons(rows) {
    for (var i = 0; i < rows.length; i++) {
      var r = rows[i], n = i + 1;
      if (!r.vendor) return { error: 'Source ' + n + ' needs a vendor name.', field: 'comparisons', row: i };
      if (r.unitPrice !== '' && !(typeof r.unitPrice === 'number' && r.unitPrice >= 0)) return { error: 'Source ' + n + ': the price must be a plain number, not negative.', field: 'comparisons', row: i };
      if (r.url && !URL_RE.test(r.url)) return { error: 'Source ' + n + ': the link must start with http:// or https:// and contain no spaces or quotes.', field: 'comparisons', row: i };
    }
    return null;
  }

  function validateRequest(values) {
    var v = cleanRequest(values);
    if (!v.itemDescription) return { error: 'Say what you need.', field: 'itemDescription' };
    if (v.itemDescription.length > 300) return { error: 'Keep the item to one line (300 characters).', field: 'itemDescription' };
    if (!v.reason) return { error: 'Say why you need it — which experiment or step.', field: 'reason' };
    var rawQ = values && values.quantity, rawU = values && values.unitCost;
    if (str(rawQ) !== '' && !(isPlainNumber(rawQ) && num(rawQ, 0) > 0)) return { error: 'Quantity must be a number of 1 or more.', field: 'quantity' };
    if (str(rawU) !== '' && !(isPlainNumber(rawU) && num(rawU, -1) >= 0)) return { error: 'Unit cost must be a plain number — no $ sign, not negative.', field: 'unitCost' };
    if (v.productUrl && !URL_RE.test(v.productUrl)) return { error: 'Product link must start with http:// or https:// and contain no spaces or quotes', field: 'productUrl' };
    if (str(values && values.neededBy) && !v.neededBy) return { error: 'Needed-by must be a date.', field: 'neededBy' };
    // The project decides the funding string purchasing uses, so it is required:
    // one from the lab's funded-project list, or "Other" with a name typed.
    if (!v.project) return { error: 'Say which project this is for — it decides the funding string.', field: 'projectId' };
    // V3.814 — the form asks whether the lab will buy this again. (Tickets
    // from before V3.814 have no purchaseType; an edit of one must still save.)
    if (!v.purchaseType && !(values && values._legacyPurchaseType)) return { error: 'Say whether this is a one-time purchase or something we will buy again.', field: 'purchaseType' };
    var ce = validateComparisons(v.comparisons);
    if (ce) return ce;
    return { values: v };
  }

  /* ─── History / notes entries ─────────────────────────────── */
  function entry(action, from, to, actor, note, nowISO) {
    return { id: genId(), at: nowISO, by: actor.uid, byName: actorName(actor), action: action,
             from: from || null, to: to || null, note: str(note) || null };
  }
  function noteEntry(actor, text, nowISO, kind) {
    return { id: genId(), at: nowISO, by: actor.uid, byName: actorName(actor), text: str(text), kind: kind || 'note' };
  }

  /* ─── Create ──────────────────────────────────────────────── */
  /**
   * @param values   composer values
   * @param actor    actorFrom()
   * @param now      Date | ms  (history ISO stamps)
   * @param stamp    the value to store in createdAt/updatedAt (FieldValue.serverTimestamp() in the page)
   * @param extra    optional { inventoryItemId, source }  (reorder provenance)
   */
  function buildCreate(values, actor, now, stamp, extra) {
    var r = validateRequest(values);
    if (r.error) return r;
    var nowISO = new Date(toMs(now) || Date.now()).toISOString();
    var data = r.values;
    data.requestedBy = actor.uid;
    data.requesterName = actorName(actor);
    data.status = 'requested';
    data.piNotes = '';
    data.question = null;
    data.issue = null;
    data.inventoryItemId = (extra && extra.inventoryItemId) || null;   // reorder → restock target
    data.source = (extra && extra.source) || 'form';
    data.repeatOf = (extra && extra.repeatOf) || null;                 // V3.814 — "Request again" provenance
    data.captureId = (extra && extra.captureId) || null;               // V3.819 — the browser-extension capture it came from
    data.history = [entry('submit', null, 'requested', actor, null, nowISO)];
    data.notes = [];
    data.watcherUids = [actor.uid];
    data.lastActorUid = actor.uid;
    data.lastActivityAt = nowISO;
    data.createdAt = stamp;
    data.updatedAt = stamp;
    return { data: data };
  }

  /* ─── Patch ───────────────────────────────────────────────── */
  /**
   * Returns { patch, appends: { history:[], notes:[], watcherUids:[] }, to }
   * or { error, field }. The writer wraps each `appends` array in
   * FieldValue.arrayUnion(...) — the core never touches Firebase.
   */
  function buildPatch(action, t, values, actor, now, stamp) {
    if (!can(action, t, actor)) return { error: 'You can’t ' + (ACTION_LABEL[action] || action).toLowerCase() + ' this ticket.', field: null };
    var v = values || {};
    var tr = TRANSITIONS[action];
    var from = t.status || 'requested';
    var to = targetStatus(action, t, actor);
    var nowISO = new Date(toMs(now) || Date.now()).toISOString();
    var note = str(v.note);
    if (tr.needsNote && !note) {
      var need = { ask: 'Type the question.', answer: 'Type your answer.', deny: 'Give a reason — the requester sees it.', flag: 'Describe the problem.' }[action] || 'A note is required.';
      return { error: need, field: 'note' };
    }
    var patch = {};
    var appends = { history: [], notes: [], watcherUids: [actor.uid] };
    var histNote = note;

    switch (action) {
      case 'edit': {
        // A pre-V3.814 ticket has no purchaseType; editing it must not demand one
        // unless the editor touched the field.
        var r = validateRequest(Object.assign({}, v, { _legacyPurchaseType: !str(t.purchaseType) && !cleanRequest(v).purchaseType }));
        if (r.error) return r;
        var changed = [];
        EDITABLE.forEach(function (k) {
          var nv = r.values[k], ov = t[k];
          var same = (k === 'comparisons') ? JSON.stringify(cleanComparisons(ov)) === JSON.stringify(nv)
                   : (typeof nv === 'number') ? num(ov, NaN) === nv : str(ov) === str(nv);
          if (k === 'comparisons' && !nv.length && !(Array.isArray(ov) && ov.length)) same = true;   // [] vs missing
          if (!same) { changed.push(k); patch[k] = nv; }
        });
        if (!changed.length) return { error: 'Nothing changed.', field: null };
        var names = []; changed.forEach(function (k) { var n = FIELD_LABEL[k] || k; if (names.indexOf(n) < 0) names.push(n); });
        histNote = 'Changed ' + names.join(', ') + (note ? ' — ' + note : '');
        if (to !== from && from === 'approved') {
          patch.approvedBy = null; patch.approvedByName = null; patch.approvedAt = null;
          histNote += ' (needs re-approval)';
        }
        if (to !== from && from === 'needs_info') {
          patch.question = null; patch.answeredAt = nowISO;
          histNote += ' (answers the open question)';
        }
        break;
      }
      case 'ask':
        patch.question = note; patch.questionBy = actor.uid; patch.questionByName = actorName(actor); patch.questionAt = nowISO;
        appends.notes.push(noteEntry(actor, note, nowISO, 'question'));
        break;
      case 'answer':
        patch.question = null; patch.answeredAt = nowISO;
        appends.notes.push(noteEntry(actor, note, nowISO, 'answer'));
        break;
      case 'approve': {
        // An approved ticket always carries the funding string the purchaser
        // charges: an "Other" project (or a V3.44 ticket with only a tag) must
        // be assigned a project here.
        if (str(v.fundingAccount)) { patch.fundingAccount = str(v.fundingAccount); patch.fundingLabel = str(v.fundingLabel) || str(v.fundingAccount); if (str(v.project)) patch.project = str(v.project); if (str(v.projectId) && v.projectId !== '__other') patch.projectId = str(v.projectId); }
        if (!str(t.fundingAccount) && !str(patch.fundingAccount)) return { error: 'Pick the project this is charged to — the purchaser needs its funding string.', field: 'projectId' };
        patch.approvedBy = actor.uid; patch.approvedByName = actorName(actor); patch.approvedAt = stamp;
        patch.piNotes = note; patch.question = null;
        patch.deniedBy = null; patch.deniedAt = null;
        if (note) appends.notes.push(noteEntry(actor, note, nowISO, 'decision'));
        break;
      }
      case 'deny':
        patch.deniedBy = actor.uid; patch.deniedByName = actorName(actor); patch.deniedAt = stamp;
        patch.piNotes = note; patch.question = null;
        appends.notes.push(noteEntry(actor, note, nowISO, 'decision'));
        break;
      case 'unapprove':
        patch.approvedBy = null; patch.approvedByName = null; patch.approvedAt = null; patch.piNotes = '';
        if (note) appends.notes.push(noteEntry(actor, note, nowISO));
        break;
      case 'order':
      case 'edit_order': {
        var od = str(v.orderDate) || todayStr(now);
        if (!isDateStr(od)) return { error: 'Order date must be a date.', field: 'orderDate' };
        var eta = str(v.expectedDelivery);
        if (eta && !isDateStr(eta)) return { error: 'Expected delivery must be a date.', field: 'expectedDelivery' };
        var method = METHOD_IDS.indexOf(v.purchaseMethod) >= 0 ? v.purchaseMethod : (t.purchaseMethod || '');
        if (!method) return { error: 'Pick how it was bought.', field: 'purchaseMethod' };
        patch.poNumber = str(v.poNumber);
        patch.purchaseMethod = method;
        patch.orderDate = od;
        patch.expectedDelivery = eta;
        if (v.poUrl != null) { patch.poUrl = str(v.poUrl); patch.poStoragePath = str(v.poStoragePath); }
        if (v.orderGroupId) patch.orderGroupId = str(v.orderGroupId);
        if (v.actualCost != null && str(v.actualCost) !== '') {
          var oc = num(v.actualCost, NaN); if (!isFinite(oc) || oc < 0) return { error: 'Cost must be a number.', field: 'actualCost' };
          patch.orderedCost = oc;
        }
        if (action === 'order') {
          patch.orderedBy = actor.uid; patch.orderedByName = actorName(actor); patch.orderedAt = stamp;
        }
        if (note) appends.notes.push(noteEntry(actor, note, nowISO));
        histNote = (patch.poNumber ? 'PO ' + patch.poNumber : methodLabel(method)) + (eta ? ', ETA ' + eta : '') + (note ? ' — ' + note : '');
        break;
      }
      case 'unorder':
        patch.orderedBy = null; patch.orderedByName = null; patch.orderedAt = null;
        if (note) appends.notes.push(noteEntry(actor, note, nowISO));
        break;
      case 'receive': {
        var qr = str(v.quantityReceived) === '' ? num(t.quantity, 1) : num(v.quantityReceived, NaN);
        if (str(v.quantityReceived) !== '' && !isPlainNumber(v.quantityReceived)) return { error: 'Quantity must be a number.', field: 'quantityReceived' };
        if (!isFinite(qr) || qr < 0) return { error: 'Quantity can’t be negative — 0 means nothing arrived yet.', field: 'quantityReceived' };
        var ac = str(v.actualCost) === '' ? null : num(v.actualCost, NaN);
        if (ac !== null && !isPlainNumber(v.actualCost)) return { error: 'Cost must be a plain number — no $ sign.', field: 'actualCost' };
        if (ac !== null && (!isFinite(ac) || ac < 0)) return { error: 'Cost can’t be negative.', field: 'actualCost' };
        patch.quantityReceived = qr;
        patch.actualCost = ac;
        patch.receiptUrl = str(v.receiptUrl) || t.receiptUrl || '';
        patch.receiptStoragePath = str(v.receiptStoragePath) || t.receiptStoragePath || '';
        patch.receivedNote = note;
        patch.receivedBy = actor.uid; patch.receivedByName = actorName(actor); patch.receivedAt = stamp;
        if (note) appends.notes.push(noteEntry(actor, note, nowISO));
        histNote = (qr !== num(t.quantity, 1) ? 'Received ' + qr + ' of ' + num(t.quantity, 1) : '') + (note ? (qr !== num(t.quantity, 1) ? ' — ' : '') + note : '');
        break;
      }
      case 'unreceive':
        patch.receivedBy = null; patch.receivedByName = null; patch.receivedAt = null;
        if (note) appends.notes.push(noteEntry(actor, note, nowISO));
        break;
      case 'place': {
        var loc = str(v.location);
        if (!loc) return { error: 'Where did it go? A location is required.', field: 'location' };
        var mode = v.mode === 'restock' ? 'restock' : 'new';
        var pq = placeQty(t, v), pp = placePrice(t, v);
        if (pq.error) return pq; if (pp.error) return pp;
        if (!str(v.inventoryItemId)) return { error: mode === 'restock' ? 'Pick the inventory item to restock.' : 'Inventory item was not created.', field: 'inventoryItemId' };
        patch.location = loc;
        patch.placementMode = mode;
        patch.inventoryItemId = str(v.inventoryItemId);
        patch.placedBy = actor.uid; patch.placedByName = actorName(actor); patch.placedAt = stamp;
        if (note) appends.notes.push(noteEntry(actor, note, nowISO));
        histNote = loc + (mode === 'restock' ? ' (restocked existing item)' : '') + (note ? ' — ' + note : '');
        break;
      }
      case 'cancel':
        patch.cancelledBy = actor.uid; patch.cancelledAt = nowISO; patch.question = null;
        if (note) appends.notes.push(noteEntry(actor, note, nowISO));
        break;
      case 'reopen':
        patch.cancelledBy = null; patch.cancelledAt = null; patch.deniedBy = null; patch.deniedByName = null; patch.deniedAt = null;
        patch.approvedBy = null; patch.approvedByName = null; patch.approvedAt = null; patch.piNotes = '';
        if (note) appends.notes.push(noteEntry(actor, note, nowISO));
        break;
      case 'note':
        if (!note) return { error: 'Type a note.', field: 'note' };
        appends.notes.push(noteEntry(actor, note, nowISO));
        break;
      case 'flag':
        patch.issue = note; patch.issueBy = actor.uid; patch.issueByName = actorName(actor); patch.issueAt = nowISO;
        appends.notes.push(noteEntry(actor, note, nowISO, 'issue'));
        break;
      case 'clear_issue':
        patch.issue = null; patch.issueBy = null; patch.issueByName = null; patch.issueAt = null;
        if (note) appends.notes.push(noteEntry(actor, note, nowISO));
        break;
      case 'reassign': {
        // V3.814 — move the charge to another project. The form passes the
        // picked project (applyProject has already stamped project /
        // fundingAccount / fundingLabel) or "Other" with a name.
        var pid = str(v.projectId) === '__other' ? '' : str(v.projectId);
        var pname = str(v.project), pfs = str(v.fundingAccount), plabel = str(v.fundingLabel) || pfs;
        if (!pname) return { error: 'Pick the project this should be charged to.', field: 'projectId' };
        // Past approval a ticket always carries a funding string (approve enforces
        // it); "Other" is only allowed while it is still being decided.
        if (!pfs && from !== 'requested' && from !== 'needs_info') return { error: 'Pick a funded project — an approved ticket must carry a funding string.', field: 'projectId' };
        if (pid === str(t.projectId) && pfs === str(t.fundingAccount) && pname === str(t.project)) return { error: 'That is already the project on this ticket.', field: 'projectId' };
        var was = str(t.fundingLabel) || str(t.fundingAccount) || str(t.project) || 'nothing';
        patch.projectId = pid; patch.project = pname; patch.fundingAccount = pfs; patch.fundingLabel = plabel;
        patch.fundingChangedBy = actor.uid; patch.fundingChangedByName = actorName(actor); patch.fundingChangedAt = nowISO;
        patch.fundingChangedFrom = was;
        histNote = 'Now charged to ' + (plabel || pname + ' (no funding string yet)') + ' (was ' + was + ')' + (note ? ' — ' + note : '');
        appends.notes.push(noteEntry(actor, histNote, nowISO, 'funding'));
        break;
      }
      case 'delete':
        return { patch: null, to: null, appends: appends, deleteDoc: true };
    }

    if (to !== from) patch.status = to;
    patch.updatedAt = stamp;
    patch.lastActorUid = actor.uid;
    patch.lastActivityAt = nowISO;
    appends.history.push(entry(action, from, to !== from ? to : null, actor, histNote, nowISO));
    return { patch: patch, appends: appends, to: to };
  }

  function methodLabel(id) {
    for (var i = 0; i < METHODS.length; i++) if (METHODS[i].id === id) return METHODS[i].label;
    return id || '';
  }
  function categoryLabel(id) {
    for (var i = 0; i < CATEGORIES.length; i++) if (CATEGORIES[i].id === id) return CATEGORIES[i].label;
    return id || '';
  }
  function inventoryCategoryFor(id) {
    for (var i = 0; i < CATEGORIES.length; i++) if (CATEGORIES[i].id === id) return CATEGORIES[i].inventory;
    return 'other';
  }
  /* inventory category → request category (reorder prefill). */
  function requestCategoryFor(invCat) {
    for (var i = 0; i < CATEGORIES.length; i++) if (CATEGORIES[i].inventory === invCat) return CATEGORIES[i].id;
    if (/^research_/.test(invCat || '')) return 'reagent';
    return 'other';
  }

  /* ─── Batch ordering ──────────────────────────────────────── */
  /** Other approved tickets from the same vendor — candidates for one PO. */
  function batchCandidates(tickets, t) {
    var vk = normVendor(t && t.vendor);
    if (!vk) return [];
    return (tickets || []).filter(function (x) {
      return x.id !== t.id && x.status === 'approved' && normVendor(x.vendor) === vk;
    });
  }

  /* ─── Inventory hand-off ──────────────────────────────────── */
  /** How many are being put away: what the form says, else what was RECEIVED
   * (0 received must not fall back to the ordered quantity — adversary Q1/Q2). */
  function placeQty(t, v) {
    var raw = v && v.quantity;
    if (str(raw) !== '') {
      if (!isPlainNumber(raw) || !(num(raw, 0) > 0)) return { error: 'Quantity must be more than 0 — if nothing arrived, undo “received” instead.', field: 'quantity' };
      return { qty: num(raw) };
    }
    var rec = t.quantityReceived;
    var q = (rec != null && str(rec) !== '' && isFinite(+rec)) ? +rec : num(t.quantity, 1);
    if (!(q > 0)) return { error: 'Nothing was received — undo “received” instead of putting it away.', field: 'quantity' };
    return { qty: q };
  }
  /** Unit price: the form's, else actual cost ÷ quantity RECEIVED, else the estimate. */
  function placePrice(t, v) {
    var raw = v && v.unitPrice;
    if (str(raw) !== '') {
      if (!isPlainNumber(raw) || num(raw, -1) < 0) return { error: 'Unit price must be a plain number, not negative.', field: 'unitPrice' };
      return { price: num(raw) };
    }
    var rec = (t.quantityReceived != null && +t.quantityReceived > 0) ? +t.quantityReceived : num(t.quantity, 1);
    if (t.actualCost != null && str(t.actualCost) !== '' && rec > 0) return { price: +(num(t.actualCost) / rec).toFixed(2) };
    return { price: num(t.unitCost, 0) };
  }
  /** The inventory/{new} document for a `place` in 'new' mode. */
  function newInventoryItem(t, v, actor, stamp) {
    var qty = placeQty(t, v).qty || 1;
    var price = placePrice(t, v).price || 0;
    var cat = str(v.category) || inventoryCategoryFor(t.category);
    var data = {
      kind: 'item',
      name: t.itemDescription || 'Untitled item',
      category: cat,
      vendor: t.vendor || '',
      catalogue_number: t.catalogueNumber || '',
      quantity: qty,
      unit_price: price,
      extended_price: +(price * qty).toFixed(2),
      date_acquired: fmtDate(t.receivedAt) || todayStr(),
      account_number: t.fundingAccount || '',
      project_tag: t.projectId || t.project || '',
      stock_status: 'full',
      locations: [{ name: str(v.location), quantity: qty, notes: '' }],
      notes: str(v.notes),
      reorder: { url: t.productUrl || '', vendor: t.vendor || '', catalogue_number: t.catalogueNumber || '',
                 last_price: price || null, lead_time_days: leadTimeDays(t), notes: '',
                 // V3.814 — the next "Request reorder" starts with the comparison already done.
                 recurring: t.purchaseType === 'recurring', alternatives: cleanComparisons(t.comparisons, t) },
      // `unit_price` — the key inventory.js's price-history table and trend arrows read.
      price_history: price ? [{ date: todayStr(), unit_price: price, vendor: t.vendor || '', source: 'procurement:' + t.id }] : [],
      procurementTicketId: t.id,
      requestedBy: t.requestedBy || null,
      addedBy: actor.uid,
      addedAt: stamp,
      updatedAt: stamp,
    };
    return data;
  }

  function leadTimeDays(t) {
    var a = toMs(t.orderDate || t.orderedAt), b = toMs(t.receivedAt);
    if (!a || !b || b < a) return null;
    return Math.round((b - a) / 86400000);
  }

  /**
   * Restock an EXISTING inventory item. Returns { patch, usage, ledgerRaised }.
   * A member may append a location and bump `quantity`; raising qty_remaining
   * on a tracked item is a manager act (firestore.rules V3.646), so it is only
   * planned when actor.isInvMgr, and then an inventoryUsage 'add' row goes
   * with it for the ledger.
   */
  function restockPlan(item, t, v, actor, stamp) {
    var qty = placeQty(t, v).qty || 1;
    var price = placePrice(t, v).price || 0;
    var loc = str(v.location);
    var locations = (item.locations || []).map(function (l) { return Object.assign({}, l); });
    var hit = locations.find(function (l) { return str(l.name).toLowerCase() === loc.toLowerCase(); });
    if (hit) hit.quantity = num(hit.quantity, 0) + qty;
    else locations.push({ name: loc, quantity: qty, notes: '' });
    var patch = {
      quantity: num(item.quantity, 0) + qty,
      locations: locations,
      stock_status: 'full',
      updatedAt: stamp,
      last_restocked_at: todayStr(),
      last_procurement_ticket_id: t.id,
    };
    if (price > 0) {
      patch.unit_price = price;
      patch.price_history = (item.price_history || []).concat([{ date: todayStr(), unit_price: price, vendor: t.vendor || item.vendor || '', source: 'procurement:' + t.id }]);
    }
    patch.reorder = Object.assign({}, item.reorder || {}, {
      vendor: t.vendor || (item.reorder && item.reorder.vendor) || item.vendor || '',
      catalogue_number: t.catalogueNumber || (item.reorder && item.reorder.catalogue_number) || item.catalogue_number || '',
      url: t.productUrl || (item.reorder && item.reorder.url) || '',
      last_price: price > 0 ? price : ((item.reorder && item.reorder.last_price) || null),
      lead_time_days: leadTimeDays(t) != null ? leadTimeDays(t) : ((item.reorder && item.reorder.lead_time_days) || null),
    });
    // V3.814 — a restock from a ticket that compared sources, or was marked
    // recurring, teaches the inventory item for the next reorder.
    var alts = cleanComparisons(t.comparisons, t);
    if (alts.length) patch.reorder.alternatives = alts;
    if (t.purchaseType === 'recurring') patch.reorder.recurring = true;
    var usage = null, ledgerRaised = false;
    // A tracked item with no count yet cannot be restocked by a member at all
    // (inventory rules: qtyPresentIfTracked) — the page routes them elsewhere.
    var ledgerBlocked = item.qty_tracked === true && !actor.isInvMgr && typeof item.qty_remaining !== 'number';
    if (item.qty_tracked === true && actor.isInvMgr) {
      var before = num(item.qty_remaining, 0), after = before + qty;
      patch.qty_remaining = after;
      patch.qty_made = num(item.qty_made, 0) + qty;
      usage = { itemId: item.id, event: 'add', qty: qty, delta: qty, before: before, after: after,
                userUid: actor.uid, userName: actorName(actor), note: 'Restock from procurement ' + t.id, createdAt: stamp };
      ledgerRaised = true;
    }
    return { patch: patch, usage: usage, ledgerRaised: ledgerRaised, ledgerBlocked: ledgerBlocked, qty: qty, price: price };
  }

  /** Composer prefill when a request starts from an inventory item (Reorder). */
  function prefillFromInventory(item) {
    if (!item) return {};
    var r = item.reorder || {};
    var price = num(r.last_price, NaN); if (!isFinite(price) || !price) price = num(item.unit_price, 0);
    return {
      itemDescription: item.name || '',
      vendor: r.vendor || item.vendor || '',
      catalogueNumber: r.catalogue_number || item.catalogue_number || '',
      productUrl: r.url || '',
      unitCost: price || '',
      quantity: 1,
      category: requestCategoryFor(item.category),
      fundingAccount: item.account_number || '',
      reason: '',
      inventoryItemId: item.id,
      // V3.814 — a reorder IS a recurring purchase; bring back the sources compared last time.
      purchaseType: 'recurring',
      recurrence: r.recurring ? 'unsure' : '',
      comparisons: cleanComparisons(r.alternatives, { vendor: r.vendor || item.vendor }),
    };
  }

  /** V3.814 — "Request again": the composer prefilled from an earlier ticket.
   * Dates and urgency start over; the inventory link survives so putting the
   * new box away restocks the same item. */
  function prefillFromTicket(t) {
    if (!t) return {};
    var v = cleanRequest(t);
    v.neededBy = ''; v.urgency = 'routine';
    if (!v.purchaseType) v.purchaseType = 'recurring';
    if (v.purchaseType === 'recurring' && !v.recurrence) v.recurrence = 'unsure';
    v.inventoryItemId = t.inventoryItemId || '';
    v.repeatOf = t.id || '';
    return v;
  }

  /** V3.819 — the New-item composer prefilled from a browser-extension capture
   * (userData/{uid}/procurementCaptures/{id}). The capture's vendor + price
   * become the first, chosen price-comparison row; project, one-time/recurring
   * and the rest of "why" are still the person's to fill in. */
  function prefillFromCapture(c) {
    if (!c) return {};
    var price = (typeof c.price === 'number' && c.price >= 0) ? c.price : priceVal(c.priceText);
    if (typeof price !== 'number' || price < 0) price = '';
    var url = URL_RE.test(str(c.url)) ? str(c.url) : '';
    var qty = num(c.quantity, 1); if (!(qty > 0)) qty = 1;
    var host = str(c.sourceHost).replace(/^www\./, '');
    var v = {
      itemDescription: str(c.name).slice(0, 300), vendor: str(c.vendor), catalogueNumber: str(c.catalogueNumber).slice(0, 80), productUrl: url,
      quantity: qty, unitCost: price, purchaseType: '', recurrence: '', reason: str(c.note),
      comparisons: str(c.vendor) ? [{ vendor: str(c.vendor), catalogueNumber: str(c.catalogueNumber).slice(0, 80), url: url, unitPrice: price, packSize: str(c.packSize),
        leadTime: '', notes: 'captured from ' + (host || 'the vendor page') + (c.capturedAtIso ? ' on ' + fmtDate(c.capturedAtIso) : ''), chosen: true }] : [],
      captureId: str(c.id),
    };
    return v;
  }

  /* ─── Price watch (V3.820) ────────────────────────────────── */
  /* KEEP IN SYNC with ResearchManagement/extension/price-watch-core.js:
   * normalizeProductUrl + watchIdFor must give the same id on both sides. */
  var WATCH_KEEP_QUERY = ['sku', 'productid', 'product_id', 'id', 'catalognumber', 'catalog', 'item', 'itemid', 'asin', 'pid', 'variant', 'code', 'productcode'];
  function normalizeProductUrl(u) {
    var x; try { x = new URL(str(u)); } catch (e) { return ''; }
    if (!/^https?:$/.test(x.protocol)) return '';
    var host = x.hostname.toLowerCase().replace(/^www\./, '');
    var path = x.pathname.replace(/\/+/g, '/').replace(/\/+$/, '');
    var asin = path.match(/\/(?:dp|gp\/product)\/([A-Z0-9]{10})(?:[/?]|$)/i);
    if (/(^|\.)amazon\./.test(host) && asin) path = '/dp/' + asin[1].toUpperCase();
    var q = [];
    x.searchParams.forEach(function (v, k) { if (WATCH_KEEP_QUERY.indexOf(k.toLowerCase()) >= 0 && v) q.push(k.toLowerCase() + '=' + v); });
    q.sort();
    return host + path + (q.length ? '?' + q.join('&') : '');
  }
  function fnv1a(s, seed) {
    var h = seed >>> 0;
    for (var i = 0; i < s.length; i++) { h ^= s.charCodeAt(i); h = Math.imul(h, 16777619) >>> 0; }
    return ('00000000' + h.toString(16)).slice(-8);
  }
  function watchIdFor(u) {
    var n = normalizeProductUrl(u); if (!n) return '';
    var host = n.split('/')[0].replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '').slice(0, 24);
    return host + '-' + fnv1a(n, 2166136261) + fnv1a(n, 0x9747b28c);
  }
  /** The price observations a request carries: its link + unit cost, and every comparison row with a link and a price. Deduped by watch id. */
  function priceObservationsFrom(values, ticketId) {
    var v = values || {}, out = [], seen = {};
    var add = function (url, price, vendor, cat, name) {
      var id = watchIdFor(url); var p = typeof price === 'number' ? price : priceVal(price);
      if (!id || seen[id] || typeof p !== 'number' || !(p >= 0)) return;
      seen[id] = 1; out.push({ id: id, url: str(url), price: +p.toFixed(2), currency: 'USD', vendor: str(vendor), catalogueNumber: str(cat), name: str(name), method: 'request', ticketId: ticketId || null });
    };
    if (num(v.unitCost, 0) > 0) add(v.productUrl, num(v.unitCost), v.vendor, v.catalogueNumber, v.itemDescription);
    cleanComparisons(v.comparisons, v).forEach(function (r) { if (r.url && typeof r.unitPrice === 'number') add(r.url, r.unitPrice, r.vendor, r.catalogueNumber, v.itemDescription); });
    return out;
  }
  /** A new priceWatch doc from one observation (the site's create path; the extension's mergeWatch does the same). */
  function newWatchDoc(o, nowISO, uid) {
    var entry = { at: nowISO, price: o.price, method: o.method || 'request', by: uid };
    return { url: o.url, normUrl: normalizeProductUrl(o.url), host: normalizeProductUrl(o.url).split('/')[0], vendor: o.vendor || '', catalogueNumber: o.catalogueNumber || '', name: o.name || '', currency: o.currency || 'USD',
      latest: entry, history: [entry], lastCheckedAt: nowISO, nextCheckAt: new Date(toMs(nowISO) + 90 * 86400000).toISOString(), checkEveryDays: 90,
      status: 'active', failures: 0, lastError: null, claimedAt: null, claimedBy: null, inventoryItemId: o.inventoryItemId || null, ticketIds: o.ticketId ? [o.ticketId] : [],
      createdAt: nowISO, createdBy: uid, updatedAt: nowISO, lastActorUid: uid };
  }
  /** The watch for a URL, from the loaded priceWatch docs (array with ids). */
  function watchFor(watches, url) {
    var id = watchIdFor(url); if (!id) return null;
    return (watches || []).find(function (w) { return w && w.id === id; }) || null;
  }
  function watchSummary(w) {
    if (!w || !w.latest || typeof w.latest.price !== 'number') return null;
    return { id: w.id, price: w.latest.price, at: w.latest.at, method: w.latest.method, checks: Array.isArray(w.history) ? w.history.length : 0, status: w.status || 'active', nextCheckAt: w.nextCheckAt || '', url: w.url };
  }

  /* ─── Price comparison + AI assist (V3.814) ───────────────── */
  /** Copy comparison row `idx` into the main fields and mark it chosen. */
  function applyComparison(values, idx) {
    // Works on the rows AS TYPED (the form may hold empty rows), so idx is the
    // index the person clicked, not the index after cleaning.
    var rows = Array.isArray(values.comparisons) ? values.comparisons : [];
    var r = rows[idx]; if (!r || !str(r.vendor)) return values;
    rows.forEach(function (x, i) { if (x && typeof x === 'object') x.chosen = i === idx; });
    values.vendor = str(r.vendor);
    if (str(r.catalogueNumber)) values.catalogueNumber = str(r.catalogueNumber);
    if (str(r.url) && URL_RE.test(str(r.url))) values.productUrl = str(r.url);
    var p = priceVal(r.unitPrice);
    if (typeof p === 'number' && p >= 0) { values.unitCost = p; delete values.estimatedCost; }
    return values;
  }

  var AI_SCHEMA = [
    '{',
    '  "item": "<what you priced, one line>",',
    '  "sources": [',
    '    { "vendor": "", "catalogueNumber": "", "url": "", "unitPrice": 0.00, "packSize": "", "leadTime": "", "notes": "" }',
    '  ],',
    '  "recommended": 0,',
    '  "whyRecommended": "<one sentence>",',
    '  "purchaseType": "one_time" or "recurring",',
    '  "recurrence": "monthly" | "quarterly" | "semester" | "yearly" | "unsure" | ""',
    '}',
  ].join('\n');

  /**
   * The prompt a requester pastes into whatever AI they use. ctx: { lab, today }.
   * Asks for JSON ONLY so parseAiResults() is deterministic.
   */
  function aiPrompt(values, ctx) {
    var v = values || {}, c = ctx || {};
    var lab = c.lab || 'a university research lab';
    var lines = [];
    lines.push('You are helping ' + lab + ' buy a lab item. Find where to buy it, compare prices, and answer ONLY with the JSON block described at the end — no prose before or after it.');
    lines.push('');
    lines.push('ITEM: ' + (str(v.itemDescription) || '(not given — ask for it)'));
    if (str(v.vendor) || str(v.catalogueNumber)) lines.push('KNOWN SOURCE: ' + [str(v.vendor), str(v.catalogueNumber) ? 'cat# ' + str(v.catalogueNumber) : ''].filter(Boolean).join(', '));
    if (str(v.productUrl)) lines.push('KNOWN LINK: ' + str(v.productUrl));
    lines.push('QUANTITY NEEDED: ' + (num(v.quantity, 1) || 1));
    if (str(v.category)) lines.push('CATEGORY: ' + (categoryLabel(v.category) || str(v.category)));
    if (str(v.reason)) lines.push('WHY WE NEED IT: ' + str(v.reason));
    lines.push('');
    lines.push('What to do:');
    lines.push('1. Find 2 to 4 sources that sell exactly this item (or a direct equivalent — say so in notes). Prefer suppliers a US university buys from: Fisher Scientific, VWR / Avantor, Sigma-Aldrich / MilliporeSigma, Thermo Fisher, Cole-Parmer, Amazon Business, McMaster-Carr, Digi-Key, Grainger, or the manufacturer directly.');
    lines.push('2. For each source give: vendor, catalogue / part number, a direct product URL, the unit price in US dollars as sold (per pack or bottle), the pack size, the typical lead time, and notes (equivalence, minimum order, shipping, whether the price is a list price).');
    lines.push('3. Recommend one source: lowest landed cost for the quantity above unless lead time or quality argues otherwise. Say why in one sentence.');
    lines.push('4. Say whether a lab like this typically buys this item once ("one_time") or repeatedly ("recurring"), and roughly how often.');
    lines.push('5. Prices change; use what you can see today (' + (c.today || todayStr()) + ') and say in notes if a price is older or uncertain.');
    lines.push('');
    lines.push('Reply with ONLY this JSON, filled in (keep the field names exactly; "recommended" is the 0-based index into "sources"; unitPrice is a plain number):');
    lines.push(AI_SCHEMA);
    return lines.join('\n');
  }

  /**
   * Parse what the AI returned. Tolerates code fences, prose around the JSON,
   * "$12.50" prices, a missing/out-of-range recommendation. Returns
   * { results: { item, sources[], recommended, whyRecommended, purchaseType, recurrence } }
   * or { error }.
   */
  function parseAiResults(text) {
    var s = str(text);
    if (!s) return { error: 'Paste the AI’s answer first.' };
    s = s.replace(/```[a-zA-Z]*\s*/g, '').replace(/```/g, '');
    var a = s.indexOf('{'), b = s.lastIndexOf('}');
    if (a < 0 || b <= a) return { error: 'Couldn’t find a JSON block in that — paste the whole answer, from { to }.' };
    var body = s.slice(a, b + 1), obj = null;
    try { obj = JSON.parse(body); }
    catch (e) {
      // Common AI slips: trailing commas, smart quotes.
      var fixed = body.replace(/[“”]/g, '"').replace(/,\s*([}\]])/g, '$1');
      try { obj = JSON.parse(fixed); } catch (e2) { return { error: 'That JSON would not parse (' + (e2 && e2.message || 'syntax') + ') — ask the AI to resend only the JSON block.' }; }
    }
    if (!obj || typeof obj !== 'object') return { error: 'Expected a JSON object.' };
    var rows = Array.isArray(obj.sources) ? obj.sources : (Array.isArray(obj.options) ? obj.options : []);
    var sources = cleanComparisons(rows.map(function (r) {
      if (!r || typeof r !== 'object') return null;
      return { vendor: r.vendor || r.supplier || r.name || '', catalogueNumber: r.catalogueNumber || r.catalogNumber || r.catalogue || r.partNumber || r.sku || '',
               url: r.url || r.link || '', unitPrice: r.unitPrice != null ? r.unitPrice : (r.price != null ? r.price : ''),
               packSize: r.packSize || r.pack || '', leadTime: r.leadTime || r.lead_time || '', notes: r.notes || r.note || '' };
    }).filter(Boolean));
    sources = sources.filter(function (r) { return !!r.vendor; });
    sources.forEach(function (r) { if (typeof r.unitPrice !== 'number') r.unitPrice = ''; if (r.url && !URL_RE.test(r.url)) { r.notes = (r.notes ? r.notes + ' · ' : '') + 'link given: ' + r.url; r.url = ''; } });
    if (!sources.length) return { error: 'No sources with a vendor name in that answer.' };
    var rec = parseInt(obj.recommended, 10);
    if (!(rec >= 0 && rec < sources.length)) {
      rec = -1; var best = Infinity;
      sources.forEach(function (r, i) { if (typeof r.unitPrice === 'number' && r.unitPrice < best) { best = r.unitPrice; rec = i; } });
      if (rec < 0) rec = 0;
    }
    sources.forEach(function (r, i) { r.chosen = i === rec; });
    var pt = str(obj.purchaseType).toLowerCase().replace(/[\s-]+/g, '_');
    if (pt === 'onetime' || pt === 'one_off' || pt === 'once') pt = 'one_time';
    if (pt === 'repeat' || pt === 'repeated' || pt === 'repeatedly') pt = 'recurring';
    var rc = str(obj.recurrence).toLowerCase();
    return { results: {
      item: str(obj.item), sources: sources, recommended: rec, whyRecommended: str(obj.whyRecommended || obj.why || ''),
      purchaseType: PURCHASE_TYPE_IDS.indexOf(pt) >= 0 ? pt : '',
      recurrence: RECURRENCE_IDS.indexOf(rc) >= 0 ? rc : '',
    } };
  }

  /** Merge parsed AI results into the composer values. What the person
   * already typed wins; what is empty is filled. Returns what changed. */
  function applyAiResults(values, results) {
    var r = results || {}, took = { sources: 0, main: false, purchaseType: false };
    if (!r.sources || !r.sources.length) return took;
    values.comparisons = r.sources.map(function (x) { return Object.assign({}, x); });
    took.sources = values.comparisons.length;
    var rec = values.comparisons[r.recommended] || values.comparisons[0];
    if (rec && (!str(values.vendor) || str(values.unitCost) === '')) {
      var idx = values.comparisons.indexOf(rec);
      applyComparison(values, idx);
      took.main = true;
    }
    if (!str(values.purchaseType) && r.purchaseType) { values.purchaseType = r.purchaseType; took.purchaseType = true; }
    if (values.purchaseType === 'recurring' && !str(values.recurrence) && r.recurrence) values.recurrence = r.recurrence;
    if (r.whyRecommended) values._aiWhy = r.whyRecommended;
    return took;
  }
  function purchaseTypeLabel(id) { for (var i = 0; i < PURCHASE_TYPES.length; i++) if (PURCHASE_TYPES[i].id === id) return PURCHASE_TYPES[i].label; return ''; }
  function recurrenceLabel(id) { for (var i = 0; i < RECURRENCE.length; i++) if (RECURRENCE[i].id === id) return RECURRENCE[i].label; return ''; }

  /** Search an inventory list for a restock target. */
  function searchInventory(items, q, limit) {
    var k = str(q).toLowerCase();
    if (!k) return [];
    var out = [];
    for (var i = 0; i < (items || []).length && out.length < (limit || 8); i++) {
      var it = items[i];
      if (it.kind && it.kind !== 'item') continue;
      var hay = ((it.name || '') + ' ' + (it.vendor || '') + ' ' + (it.catalogue_number || '')).toLowerCase();
      if (hay.indexOf(k) >= 0) out.push(it);
    }
    return out;
  }

  /* ─── Lists, inbox, filters ───────────────────────────────── */
  function isActive(t) { var s = STATUS[t.status || 'requested']; return s ? s.active : true; }
  function isMine(t, uid) { return !!uid && t.requestedBy === uid; }
  function lastActivityMs(t) { return toMs(t.lastActivityAt) || toMs(t.updatedAt) || toMs(t.createdAt); }

  /** What needs THIS person. Sections only appear when non-empty. */
  function inboxFor(tickets, actor) {
    var all = tickets || [];
    var sections = [
      { key: 'answer',  title: 'Questions for you',             hint: 'The approver needs an answer before deciding.',
        items: all.filter(function (t) { return t.status === 'needs_info' && isMine(t, actor.uid); }) },
      { key: 'approve', title: 'Waiting for your approval',     hint: 'Approve, ask, or deny.',
        items: actor.canApprove ? all.filter(function (t) { return t.status === 'requested'; }) : [] },
      { key: 'order',   title: 'Approved — ready to order',     hint: 'Place the order and record the PO.',
        items: actor.canOrder ? all.filter(function (t) { return t.status === 'approved'; }) : [] },
      { key: 'issues',  title: 'Flagged problems',              hint: 'Someone flagged a problem with an order.',
        items: actor.canOrder ? all.filter(function (t) { return !!t.issue && (t.status === 'ordered' || t.status === 'received'); }) : [] },
      { key: 'place',   title: 'Arrived — needs putting away',  hint: 'Record where it went so it lands in inventory.',
        items: all.filter(function (t) { return t.status === 'received'; }) },
      { key: 'mine',    title: 'Your open requests',            hint: '',
        items: all.filter(function (t) { return isMine(t, actor.uid) && isActive(t) && t.status !== 'needs_info' && t.status !== 'received'; }) },
    ];
    // A ticket shows once: an approver's own request sits under approvals, not twice.
    var seen = {};
    sections.forEach(function (s) { s.items = s.items.filter(function (t) { if (seen[t.id]) return false; seen[t.id] = 1; return true; }); });
    return sections.filter(function (s) { return s.items.length; });
  }

  function matchesQuery(t, q) {
    var k = str(q).toLowerCase();
    if (!k) return true;
    var hay = [t.itemDescription, t.vendor, t.catalogueNumber, t.requesterName, t.project, t.fundingLabel,
      t.fundingAccount, t.location, t.poNumber, t.reason, t.piNotes, t.issue, STATUS[t.status] && STATUS[t.status].label,
      t.purchaseType === 'recurring' ? 'recurring' : '', (Array.isArray(t.comparisons) ? t.comparisons : []).map(function (c) { return c && c.vendor; }).join(' ')]
      .map(function (s) { return str(s).toLowerCase(); }).join(' ');
    return k.split(/\s+/).every(function (w) { return hay.indexOf(w) >= 0; });
  }

  /** opts: { view: 'active'|'mine'|'archive'|'all', uid, status, q } */
  function filterTickets(tickets, opts) {
    var o = opts || {};
    return (tickets || []).filter(function (t) {
      if (o.view === 'active' && !isActive(t)) return false;
      if (o.view === 'archive' && isActive(t)) return false;
      if (o.view === 'mine' && !isMine(t, o.uid)) return false;
      if (o.status && t.status !== o.status) return false;
      if (o.urgency && t.urgency !== o.urgency) return false;
      if (!matchesQuery(t, o.q)) return false;
      return true;
    });
  }

  function sortTickets(tickets, key) {
    var list = (tickets || []).slice();
    var cmp = {
      updated: function (a, b) { return lastActivityMs(b) - lastActivityMs(a); },
      created: function (a, b) { return toMs(b.createdAt) - toMs(a.createdAt); },
      urgency: function (a, b) {
        var d = (URGENCY[b.urgency] || URGENCY.routine).rank - (URGENCY[a.urgency] || URGENCY.routine).rank;
        return d || (toMs(a.createdAt) - toMs(b.createdAt));
      },
      cost: function (a, b) { return num(b.actualCost != null ? b.actualCost : b.estimatedCost) - num(a.actualCost != null ? a.actualCost : a.estimatedCost); },
      status: function (a, b) {
        var d = (STATUS[a.status] || STATUS.requested).order - (STATUS[b.status] || STATUS.requested).order;
        return d || (lastActivityMs(b) - lastActivityMs(a));
      },
    }[key] || null;
    if (cmp) list.sort(cmp);
    return list;
  }

  function counts(tickets, uid) {
    var c = { active: 0, mine: 0, archive: 0 };
    STATUS_IDS.forEach(function (s) { c[s] = 0; });
    (tickets || []).forEach(function (t) {
      c[t.status || 'requested'] = (c[t.status || 'requested'] || 0) + 1;
      if (isActive(t)) c.active++; else c.archive++;
      if (isMine(t, uid)) c.mine++;
    });
    return c;
  }

  /* ─── Timeline (history, or synthesized for pre-V3.813 tickets) ── */
  function timelineOf(t) {
    if (Array.isArray(t.history) && t.history.length) {
      return t.history.slice().sort(function (a, b) { return toMs(a.at) - toMs(b.at); });
    }
    var out = [];
    var push = function (action, at, byName, to, note) { if (toMs(at)) out.push({ id: action + '-' + toMs(at), at: new Date(toMs(at)).toISOString(), by: null, byName: byName || '', action: action, from: null, to: to, note: note || null, synthesized: true }); };
    push('submit', t.createdAt, t.requesterName, 'requested');
    if (t.status === 'denied') push('deny', t.approvedAt || t.deniedAt, t.approvedByName || t.deniedByName, 'denied', t.piNotes);
    else push('approve', t.approvedAt, t.approvedByName, 'approved', t.piNotes);
    push('order', t.orderedAt || t.orderDate, t.orderedByName, 'ordered', t.poNumber ? 'PO ' + t.poNumber : null);
    push('receive', t.receivedAt, t.receivedByName, 'received');
    push('place', t.placedAt, t.placedByName, 'placed', t.location);
    return out.sort(function (a, b) { return toMs(a.at) - toMs(b.at); });
  }

  /* ─── Report ──────────────────────────────────────────────── */
  function spend(t) {
    if (t.actualCost != null && t.actualCost !== '') return num(t.actualCost);
    if (t.orderedCost != null && t.orderedCost !== '') return num(t.orderedCost);
    return num(t.estimatedCost);
  }
  /** UA fiscal year starts July 1. */
  function fiscalYearStart(now) {
    var d = new Date(toMs(now) || Date.now());
    var y = d.getMonth() >= 6 ? d.getFullYear() : d.getFullYear() - 1;
    return y + '-07-01';
  }
  /**
   * Rows by funding account (and by category): committed = requested +
   * approved + ordered (estimates / ordered cost); spent = received + placed
   * (actual where known). Period filters on createdAt.
   */
  /** Local-midnight bounds for a YYYY-MM-DD period: [fromMs, toMs). toMs('YYYY-MM-DD')
   * is local NOON, which would run a report noon-to-noon. */
  function periodBounds(from, to) {
    var f = isDateStr(str(from)) ? Date.parse(str(from) + 'T00:00:00') : 0;
    var t = isDateStr(str(to)) ? Date.parse(str(to) + 'T00:00:00') + 86400000 : Infinity;
    return { fromMs: isFinite(f) ? f : 0, toMs: isFinite(t) ? t : Infinity };
  }
  function summarize(tickets, opts) {
    var o = opts || {};
    var b = periodBounds(o.from, o.to), fromMs = b.fromMs, toMsv = b.toMs;
    var rows = {}, cats = {}, projs = {}, totals = { committed: 0, spent: 0, count: 0, pending: 0 };
    var periodSet = !!(o.from || o.to);
    (tickets || []).forEach(function (t) {
      var c = toMs(t.createdAt);
      if (periodSet && (!c || c < fromMs || c >= toMsv)) return;   // no createdAt → in no period
      if (t.status === 'denied' || t.status === 'cancelled') return;
      var key = t.fundingAccount || '(no account)';
      var r = rows[key] || (rows[key] = { account: key, label: t.fundingLabel || key, committed: 0, spent: 0, count: 0, pending: 0 });
      var ck = categoryLabel(t.category) || '(none)';
      var cr = cats[ck] || (cats[ck] = { category: ck, committed: 0, spent: 0, count: 0 });
      var pkey = t.project || '(no project)';
      var pr = projs[pkey] || (projs[pkey] = { project: pkey, committed: 0, spent: 0, count: 0 });
      var amt = spend(t);
      r.count++; cr.count++; pr.count++; totals.count++;
      if (t.status === 'received' || t.status === 'placed') { r.spent += amt; cr.spent += amt; pr.spent += amt; totals.spent += amt; }
      else { r.committed += amt; cr.committed += amt; pr.committed += amt; totals.committed += amt; if (t.status === 'requested' || t.status === 'needs_info') { r.pending++; totals.pending++; } }
    });
    var byAccount = Object.keys(rows).map(function (k) { return rows[k]; }).sort(function (a, b) { return (b.spent + b.committed) - (a.spent + a.committed); });
    var byCategory = Object.keys(cats).map(function (k) { return cats[k]; }).sort(function (a, b) { return (b.spent + b.committed) - (a.spent + a.committed); });
    var byProject = Object.keys(projs).map(function (k) { return projs[k]; }).sort(function (a, b) { return (b.spent + b.committed) - (a.spent + a.committed); });
    return { byAccount: byAccount, byCategory: byCategory, byProject: byProject, totals: totals };
  }

  var CSV_COLS = [
    ['id', 'id'], ['status', 'status'], ['item', 'itemDescription'], ['vendor', 'vendor'], ['catalogue', 'catalogueNumber'],
    ['product_url', 'productUrl'], ['project_id', 'projectId'], ['quantity', 'quantity'], ['unit_cost', 'unitCost'], ['estimated_cost', 'estimatedCost'],
    ['actual_cost', 'actualCost'], ['category', 'category'], ['funding_account', 'fundingAccount'], ['funding_label', 'fundingLabel'],
    ['project', 'project'], ['urgency', 'urgency'], ['needed_by', 'neededBy'], ['reason', 'reason'],
    ['requester', 'requesterName'], ['requested_on', function (t) { return fmtDate(t.createdAt); }],
    ['approved_by', 'approvedByName'], ['approved_on', function (t) { return fmtDate(t.approvedAt); }], ['pi_notes', 'piNotes'],
    ['po_number', 'poNumber'], ['purchase_method', 'purchaseMethod'], ['order_date', 'orderDate'], ['expected_delivery', 'expectedDelivery'],
    ['received_by', 'receivedByName'], ['received_on', function (t) { return fmtDate(t.receivedAt); }],
    ['location', 'location'], ['inventory_item', 'inventoryItemId'], ['issue', 'issue'],
    ['purchase_type', 'purchaseType'], ['recurrence', 'recurrence'], ['sources_compared', function (t) { return Array.isArray(t.comparisons) ? t.comparisons.length : 0; }],
    ['funding_changed_from', 'fundingChangedFrom'], ['funding_changed_by', 'fundingChangedByName'],
  ];
  function csvCell(v) {
    var s = v == null ? '' : String(v);
    // A cell starting with = + - @ would run as a formula in Excel/Sheets.
    if (/^[=+\-@]/.test(s)) s = "'" + s;
    return /[",\n\r]/.test(s) ? '"' + s.replace(/"/g, '""') + '"' : s;
  }
  function toCSV(tickets) {
    var lines = [CSV_COLS.map(function (c) { return c[0]; }).join(',')];
    (tickets || []).forEach(function (t) {
      lines.push(CSV_COLS.map(function (c) { var g = c[1]; return csvCell(typeof g === 'function' ? g(t) : t[g]); }).join(','));
    });
    return lines.join('\r\n');
  }

  /* ─── Funded projects → funding strings ───────────────────── */
  /**
   * The projects a request can be charged to. `fundedProjects` is the
   * labConfig/fundedProjects doc's `projects[]` (published from the Grant
   * Accounts page: id, name, account_number, funding_string?, status). When it
   * is absent the legacy labConfig/fundingSources entries stand in, so the
   * form works before an admin has published anything.
   * Returns [{ id, name, funding_string, label }] — active projects only.
   */
  function fundedProjectOptions(fundedProjects, legacySources) {
    var out = [], seen = {};
    var add = function (id, name, fs) { id = str(id); fs = str(fs); name = str(name) || fs; if (!id || seen[id]) return; seen[id] = 1; out.push({ id: id, name: name, funding_string: fs, label: fs ? name + ' · ' + fs : name }); };
    (fundedProjects || []).forEach(function (p) {
      if (p.status && !/^active$/i.test(str(p.status))) return;
      add(p.id || p.name, p.name, p.funding_string || p.account_number);
    });
    if (!out.length) (legacySources || []).forEach(function (s) {
      var label = str(s.label || s.id), name = label.replace(/\s*\([^)]*\)\s*$/, '');
      add('src:' + (s.id || label), name, s.id || label);
    });
    return out;
  }
  /** Stamp project + funding string onto form values from the chosen project id. */
  function applyProject(values, options, projectId) {
    var id = projectId != null ? str(projectId) : str(values.projectId);
    values.projectId = id;
    if (id === '__other' || !id) { values.project = str(values.projectOther); values.fundingAccount = ''; values.fundingLabel = ''; return values; }
    var p = (options || []).find(function (o) { return o.id === id; });
    if (!p) { values.project = str(values.project); return values; }
    values.project = p.name; values.fundingAccount = p.funding_string; values.fundingLabel = p.label;
    return values;
  }
  /** The option whose funding string matches a stored account (reorder prefill, legacy tickets). */
  function projectForAccount(options, account) {
    var a = str(account); if (!a) return null;
    return (options || []).find(function (o) { return o.funding_string === a; }) || null;
  }

  /* ─── Option lists ────────────────────────────────────────── */
  /** awards (active), accounts, labConfig/fundingSources.sources → [{id,label}] deduped. */
  function fundingOptions(awards, accounts, sources, tickets) {
    var out = [], seen = {};
    var add = function (id, label) { id = str(id); if (!id || seen[id]) return; seen[id] = 1; out.push({ id: id, label: str(label) || id }); };
    (awards || []).forEach(function (a) {
      if (a.status && str(a.status).toLowerCase() !== 'active') return;
      var id = a.account_number || a.id;
      add(id, a.account_number ? (a.title || a.id) + ' (' + a.account_number + ')' : (a.title || a.id));
    });
    (accounts || []).forEach(function (a) {
      var id = a.account_number || a.id;
      add(id, a.account_number ? (a.label || a.title || a.id) + ' (' + a.account_number + ')' : (a.label || a.title || a.id));
    });
    (sources || []).forEach(function (s) { add(s.id || s.label, s.label || s.id); });
    (tickets || []).forEach(function (t) { if (t.fundingAccount) add(t.fundingAccount, t.fundingLabel || t.fundingAccount); });
    return out;
  }
  /** Project names for the datalist: project docs' titles + values already used on tickets. */
  function projectOptions(projectDocs, tickets) {
    var out = [], seen = {};
    var add = function (s) { s = str(s); if (!s || seen[s.toLowerCase()]) return; seen[s.toLowerCase()] = 1; out.push(s); };
    (projectDocs || []).forEach(function (p) { if (!p.status || !/^(done|archived|retired|published)$/i.test(p.status)) add(p.short_title || p.title || p.name || p.id); });
    (tickets || []).forEach(function (t) { add(t.project); });
    return out;
  }
  /** Location names for the put-away datalist: boxes + prior placements + item locations. */
  function locationOptions(boxes, tickets, items) {
    var out = [], seen = {};
    var add = function (s) { s = str(s); if (!s || seen[s.toLowerCase()]) return; seen[s.toLowerCase()] = 1; out.push(s); };
    (tickets || []).forEach(function (t) { add(t.location); });
    (boxes || []).forEach(function (b) { add(b.name); });
    (items || []).forEach(function (it) { (it.locations || []).forEach(function (l) { add(l.name); }); });
    return out;
  }

  /* ─── Reorder catalogue (V3.816) ──────────────────────────── */
  /* The "existing item database": inventory items ∪ procurement tickets
   * that reached approval, merged so one glove box is one row. */
  var INV_CATEGORY_LABEL = {
    equipment: 'Equipment', infrastructure: 'Infrastructure', consumable: 'Consumables', computer: 'Computers',
    lab_furniture: 'Lab furniture', office: 'Office', remodel: 'Remodel', research_analysis: 'Analysis',
    research_cells: 'Cells / biologics', research_chem: 'Chemicals', research_gas: 'Gases', research_gels: 'Gels',
    research_reagents: 'Reagents / kits', software: 'Software', other: 'Other',
  };
  var INV_CATEGORY_ORDER = Object.keys(INV_CATEGORY_LABEL);
  function invCategoryLabel(id) { id = str(id); return INV_CATEGORY_LABEL[id] || (id ? id.replace(/_/g, ' ') : 'Uncategorised'); }
  var STOCK_RANK = { out_of_stock: 0, low: 1, full: 2, 'n/a': 3, '': 3 };
  var STOCK_LABEL = { out_of_stock: 'out of stock', low: 'low', full: 'in stock', 'n/a': '' };
  /** A tracked item's count against its minimum, else the inventory stock_status. */
  function stockOf(item) {
    if (!item) return '';
    if (item.qty_tracked === true && typeof item.qty_remaining === 'number') {
      if (item.qty_remaining <= 0) return 'out_of_stock';
      var min = num(item.qty_min, NaN);
      if (isFinite(min) && item.qty_remaining <= min) return 'low';
      return 'full';
    }
    var s = str(item.stock_status);
    return STOCK_RANK[s] != null ? s : '';
  }
  var APPROVED_STATUSES = { approved: 1, ordered: 1, received: 1, placed: 1 };
  function normName(s) { return str(s).toLowerCase().replace(/[^a-z0-9µ]+/g, ' ').trim(); }
  function ticketKey(t) { return normVendor(t.vendor) + '|' + normName(t.itemDescription) + '|' + normName(t.catalogueNumber); }
  function ticketPrice(t) {
    var rec = (t.quantityReceived != null && +t.quantityReceived > 0) ? +t.quantityReceived : num(t.quantity, 1);
    if (t.actualCost != null && str(t.actualCost) !== '' && rec > 0) return +(num(t.actualCost) / rec).toFixed(2);
    if (t.orderedCost != null && str(t.orderedCost) !== '' && num(t.quantity, 1) > 0) return +(num(t.orderedCost) / num(t.quantity, 1)).toFixed(2);
    return num(t.unitCost, 0) || null;
  }
  /**
   * @param items    inventory docs (any kind; only `item`s are used)
   * @param tickets  procurement tickets (only approved/ordered/received/placed count)
   * @returns entries sorted by name
   */
  function catalogue(items, tickets, watches) {
    var out = [], byInv = {}, byKey = {}, byName = {};
    var nameKey = function (vendor, name) { return normVendor(vendor) + '|' + normName(name); };
    (items || []).forEach(function (it) {
      if (!it || (it.kind && it.kind !== 'item')) return;
      var r = it.reorder || {};
      var e = {
        id: 'inv:' + it.id, kind: 'inventory', invId: it.id, ticketId: null,
        name: str(it.name) || 'Untitled item', vendor: str(r.vendor || it.vendor), catalogueNumber: str(r.catalogue_number || it.catalogue_number),
        url: str(r.url), category: str(it.category), categoryLabel: invCategoryLabel(it.category),
        lastPrice: num(r.last_price, NaN) > 0 ? num(r.last_price) : (num(it.unit_price, NaN) > 0 ? num(it.unit_price) : null),
        quantity: num(it.quantity, 0), qtyRemaining: typeof it.qty_remaining === 'number' ? it.qty_remaining : null, qtyUnit: str(it.qty_unit),
        stock: stockOf(it), locations: (it.locations || []).map(function (l) { return str(l && l.name); }).filter(Boolean),
        timesBought: 0, lastBought: toMs(it.last_restocked_at) || toMs(it.date_acquired) || 0,
        recurring: r.recurring === true, project: str(it.project_tag), account: str(it.account_number),
        alternatives: Array.isArray(r.alternatives) ? r.alternatives.length : 0,
      };
      if (it.procurementTicketId) e.timesBought = 1;
      out.push(e); byInv[it.id] = e;
      var nk = nameKey(e.vendor, e.name); if (!byName[nk]) byName[nk] = e;
    });
    (tickets || []).slice().sort(function (a, b) { return toMs(a.createdAt) - toMs(b.createdAt); }).forEach(function (t) {
      if (!t || !APPROVED_STATUSES[t.status]) return;
      var when = toMs(t.createdAt), price = ticketPrice(t);
      // Linked by id, else by vendor + name: an unlinked order for a thing the
      // lab already stocks is that thing, not a second row.
      var e = (t.inventoryItemId && byInv[t.inventoryItemId]) || byName[nameKey(t.vendor, t.itemDescription)];
      if (e) {
        // The item's own creation ticket is already counted once above.
        if (t.id !== (items || []).reduce(function (acc, it) { return it && it.id === t.inventoryItemId ? it.procurementTicketId : acc; }, null)) e.timesBought++;
        if (when > e.lastBought) { e.lastBought = when; if (price) e.lastPrice = price; }
        if (t.purchaseType === 'recurring') e.recurring = true;
        if (!e.url && t.productUrl) e.url = str(t.productUrl);
        return;
      }
      var k = ticketKey(t);
      var g = byKey[k];
      if (!g) {
        g = {
          id: 'tkt:' + k.replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '').slice(0, 80), kind: 'ticket', invId: null, ticketId: t.id,
          name: str(t.itemDescription), vendor: str(t.vendor), catalogueNumber: str(t.catalogueNumber), url: str(t.productUrl),
          category: inventoryCategoryFor(t.category), categoryLabel: invCategoryLabel(inventoryCategoryFor(t.category)),
          lastPrice: price, quantity: 0, qtyRemaining: null, qtyUnit: '', stock: '', locations: [],
          timesBought: 0, lastBought: 0, recurring: false, project: str(t.project), account: str(t.fundingAccount),
          alternatives: Array.isArray(t.comparisons) ? t.comparisons.length : 0, status: t.status,
        };
        byKey[k] = g; out.push(g);
      }
      g.timesBought++;
      // The latest ticket is the one "Reorder" prefills from, so it decides what the row says.
      if (when >= g.lastBought) { g.lastBought = when; g.ticketId = t.id; g.status = t.status; if (price) g.lastPrice = price; if (t.productUrl) g.url = str(t.productUrl); g.project = str(t.project) || g.project; g.account = str(t.fundingAccount) || g.account; g.alternatives = Array.isArray(t.comparisons) ? t.comparisons.length : 0; }
      if (t.purchaseType === 'recurring') g.recurring = true;
    });
    // V3.820 — the watched list price (the extension's quarterly re-check) beside the last paid price.
    if (watches && watches.length) out.forEach(function (e) { var w = watchSummary(watchFor(watches, e.url)); if (w) { e.watchPrice = w.price; e.watchAt = w.at; e.watchChecks = w.checks; e.watchId = w.id; } });
    return out.sort(function (a, b) { return a.name.localeCompare(b.name, undefined, { sensitivity: 'base' }); });
  }
  function entryMatches(e, q) {
    var k = str(q).toLowerCase(); if (!k) return true;
    var hay = [e.name, e.vendor, e.catalogueNumber, e.categoryLabel, e.locations.join(' '), e.project, e.account].map(function (s) { return str(s).toLowerCase(); }).join(' ');
    return k.split(/\s+/).every(function (w) { return hay.indexOf(w) >= 0; });
  }
  /** opts: { q, category, vendor, stock: ''|'low', kind: ''|'inventory'|'ticket', sort: 'name'|'recent'|'often'|'stock' } */
  function filterCatalogue(entries, opts) {
    var o = opts || {};
    var list = (entries || []).filter(function (e) {
      // '~' is the facet id for "no category" ('' would collide with "all").
      if (o.category && (o.category === '~' ? !!e.category : e.category !== o.category)) return false;
      if (o.vendor && normVendor(e.vendor) !== normVendor(o.vendor)) return false;
      if (o.stock === 'low' && !(e.stock === 'low' || e.stock === 'out_of_stock')) return false;
      if (o.kind && e.kind !== o.kind) return false;
      return entryMatches(e, o.q);
    });
    var byName = function (a, b) { return a.name.localeCompare(b.name, undefined, { sensitivity: 'base' }); };
    var cmp = {
      name: byName,
      recent: function (a, b) { return (b.lastBought - a.lastBought) || byName(a, b); },
      often: function (a, b) { return (b.timesBought - a.timesBought) || (b.lastBought - a.lastBought) || byName(a, b); },
      stock: function (a, b) { return (STOCK_RANK[a.stock] - STOCK_RANK[b.stock]) || byName(a, b); },
    }[o.sort || 'name'] || byName;
    return list.sort(cmp);
  }
  /** by: 'category' | 'vendor' | 'location' | 'none' → [{ key, label, items }] */
  function groupCatalogue(entries, by) {
    var groups = {}, order = [];
    var put = function (key, label, e) { key = str(key) || '~'; if (!groups[key]) { groups[key] = { key: key, label: label, items: [] }; order.push(key); } groups[key].items.push(e); };
    (entries || []).forEach(function (e) {
      if (by === 'vendor') put(normVendor(e.vendor) || '~', e.vendor || 'No vendor', e);
      else if (by === 'location') { if (e.locations.length) e.locations.forEach(function (l) { put(l.toLowerCase(), l, e); }); else put(e.kind === 'ticket' ? '~~tkt' : '~', e.kind === 'ticket' ? 'Not in inventory' : 'No location recorded', e); }
      else if (by === 'none') put('all', 'All items', e);
      else put(e.category || '~', e.categoryLabel, e);
    });
    var list = order.map(function (k) { return groups[k]; });
    // '~…' keys are the catch-alls and sort last (no location, then not in inventory).
    if (by === 'category') list.sort(function (a, b) { var ia = INV_CATEGORY_ORDER.indexOf(a.key), ib = INV_CATEGORY_ORDER.indexOf(b.key); if (ia < 0) ia = 99; if (ib < 0) ib = 99; return ia - ib || a.label.localeCompare(b.label); });
    else if (by !== 'none') list.sort(function (a, b) { var ta = a.key.charAt(0) === '~', tb = b.key.charAt(0) === '~'; if (ta && tb) return a.key.localeCompare(b.key); if (ta) return 1; if (tb) return -1; return a.label.localeCompare(b.label, undefined, { sensitivity: 'base' }); });
    return list;
  }
  /** Filter options with counts, from the UNFILTERED catalogue. */
  function catalogueFacets(entries) {
    var cats = {}, vends = {}, low = 0, inv = 0, tkt = 0;
    (entries || []).forEach(function (e) {
      var c = e.category || '~'; cats[c] = (cats[c] || 0) + 1;
      var v = normVendor(e.vendor); if (v) { vends[v] = vends[v] || { id: e.vendor, label: e.vendor, n: 0 }; vends[v].n++; }
      if (e.stock === 'low' || e.stock === 'out_of_stock') low++;
      if (e.kind === 'inventory') inv++; else tkt++;
    });
    var categories = Object.keys(cats).map(function (c) { return { id: c, label: c === '~' ? 'Uncategorised' : invCategoryLabel(c), n: cats[c] }; })
      .sort(function (a, b) { var ia = INV_CATEGORY_ORDER.indexOf(a.id), ib = INV_CATEGORY_ORDER.indexOf(b.id); if (ia < 0) ia = 99; if (ib < 0) ib = 99; return ia - ib || a.label.localeCompare(b.label); });
    var vendors = Object.keys(vends).map(function (k) { return vends[k]; }).sort(function (a, b) { return b.n - a.n || a.label.localeCompare(b.label); });
    return { categories: categories, vendors: vendors, low: low, inventory: inv, tickets: tkt, total: (entries || []).length };
  }
  function stockLabel(s) { return STOCK_LABEL[s] || ''; }

  /* ─── Sweep predicates (shared with functions/procurement-notify.js by copy) ── */
  function overdueOrders(tickets, now, graceDays) {
    var g = (graceDays == null ? 2 : graceDays) * 86400000, n = toMs(now) || Date.now();
    return (tickets || []).filter(function (t) { return t.status === 'ordered' && toMs(t.expectedDelivery) && n - toMs(t.expectedDelivery) > g; });
  }
  // Stale = no ACTIVITY for N days (an answer or a reopen restarts the clock).
  function staleRequests(tickets, now, days) {
    var g = (days == null ? 5 : days) * 86400000, n = toMs(now) || Date.now();
    return (tickets || []).filter(function (t) { var a = lastActivityMs(t); return t.status === 'requested' && a && n - a > g; });
  }
  /** Other ordered tickets on the same PO (orderGroupId). */
  function orderGroupSiblings(tickets, t) {
    if (!t || !t.orderGroupId) return [];
    return (tickets || []).filter(function (x) { return x.id !== t.id && x.orderGroupId === t.orderGroupId && x.status === 'ordered'; });
  }
  function unplacedArrivals(tickets, now, days) {
    var g = (days == null ? 3 : days) * 86400000, n = toMs(now) || Date.now();
    return (tickets || []).filter(function (t) { return t.status === 'received' && toMs(t.receivedAt) && n - toMs(t.receivedAt) > g; });
  }

  return {
    STATUS: STATUS, STATUS_IDS: STATUS_IDS, URGENCY: URGENCY, CATEGORIES: CATEGORIES, METHODS: METHODS,
    PURCHASE_TYPES: PURCHASE_TYPES, RECURRENCE: RECURRENCE, MAX_COMPARISONS: MAX_COMPARISONS, COMPARISON_KEYS: COMPARISON_KEYS,
    TRANSITIONS: TRANSITIONS, ACTION_ORDER: ACTION_ORDER, ACTION_LABEL: ACTION_LABEL, PRIMARY: PRIMARY,
    EDITABLE: EDITABLE, NOTE_ONLY_KEYS: NOTE_ONLY_KEYS, FUNDING_KEYS: FUNDING_KEYS,
    actorFrom: actorFrom, can: can, availableActions: availableActions, targetStatus: targetStatus,
    validateRequest: validateRequest, cleanRequest: cleanRequest, buildCreate: buildCreate, buildPatch: buildPatch,
    cleanComparisons: cleanComparisons, validateComparisons: validateComparisons, applyComparison: applyComparison,
    aiPrompt: aiPrompt, parseAiResults: parseAiResults, applyAiResults: applyAiResults, prefillFromTicket: prefillFromTicket, prefillFromCapture: prefillFromCapture,
    purchaseTypeLabel: purchaseTypeLabel, recurrenceLabel: recurrenceLabel,
    catalogue: catalogue, filterCatalogue: filterCatalogue, groupCatalogue: groupCatalogue, catalogueFacets: catalogueFacets,
    normalizeProductUrl: normalizeProductUrl, watchIdFor: watchIdFor, priceObservationsFrom: priceObservationsFrom, newWatchDoc: newWatchDoc, watchFor: watchFor, watchSummary: watchSummary,
    stockOf: stockOf, stockLabel: stockLabel, invCategoryLabel: invCategoryLabel, INV_CATEGORY_LABEL: INV_CATEGORY_LABEL,
    batchCandidates: batchCandidates, orderGroupSiblings: orderGroupSiblings, newInventoryItem: newInventoryItem, restockPlan: restockPlan, placeQty: placeQty, placePrice: placePrice, FIELD_LABEL: FIELD_LABEL, isPlainNumber: isPlainNumber,
    prefillFromInventory: prefillFromInventory, searchInventory: searchInventory,
    inboxFor: inboxFor, filterTickets: filterTickets, sortTickets: sortTickets, counts: counts, timelineOf: timelineOf,
    summarize: summarize, toCSV: toCSV, spend: spend, fiscalYearStart: fiscalYearStart, periodBounds: periodBounds,
    fundingOptions: fundingOptions, projectOptions: projectOptions, locationOptions: locationOptions,
    fundedProjectOptions: fundedProjectOptions, applyProject: applyProject, projectForAccount: projectForAccount,
    overdueOrders: overdueOrders, staleRequests: staleRequests, unplacedArrivals: unplacedArrivals,
    methodLabel: methodLabel, categoryLabel: categoryLabel, inventoryCategoryFor: inventoryCategoryFor, requestCategoryFor: requestCategoryFor,
    isActive: isActive, isMine: isMine, lastActivityMs: lastActivityMs, isRequester: isRequester,
    fmtMoney: fmtMoney, fmtDate: fmtDate, fmtDateLong: fmtDateLong, toMs: toMs, ageDays: ageDays, ageLabel: ageLabel, todayStr: todayStr, genId: genId, num: num, str: str,
  };
});
