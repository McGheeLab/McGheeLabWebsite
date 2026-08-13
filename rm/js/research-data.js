/* research-data.js — V3.544 (Research Foci program R1)
 *
 * THE data layer for the lab's research map: rm/pages/research.html. A
 * research focus is one of three levels —
 *
 *   specialty — a lab-unique core capability (MEBP, In-Situ ELISA, GELS,
 *               CELS, STEM, TFM). The verbs of the lab.
 *   concept   — a broad idea that COMBINES one or more specialties
 *               (e.g. Tissue engineering). The sentences.
 *   output    — a grant / paper / patent effort combining the others.
 *               The paragraphs we ship.
 *
 * One collection discriminated by `level` (not three) so cross-level links
 * are cheap and the whole map renders from one get() + client sort. The
 * PI (admin) authors everything; students are attached via member_uids and
 * read-only. Mirrors the labThemes / focus-areas conventions: direct
 * firebridge.db() refs, NEVER the api-routes adapter (whose collection
 * save is a whole-collection batch replace).
 *
 * Doc: researchFoci/{fociId}   (fociId = kebab slug — 'mebp', 'tfm', …)
 *   { id, level, title, abbr, icon, color, one_liner,
 *     template_fields: { template_version, answers: {…} },
 *     description_html,                       // internal detail body (V3.545)
 *     media: [ {id, kind:'image'|'video'|'html', order, caption, …} ],  // V3.546-547
 *     links: { specialty_ids[], concept_ids[], output_ids[], theme_id,
 *              draft_refs:[{id,title,kind}], patents:[{…}], training_slugs[] }, // V3.548
 *     grant_meta: { agency, mechanism, submit_to, submission_url,
 *                   target_deadline, scope_html, promoted_draft_id },   // V3.558: on CONCEPT cards — grants fund concepts, outputs are papers/patents
 *     member_uids: [], member_roles: { uid: 'lead'|'contributor' },
 *     status, status_source: 'manual'|'derived', order,
 *     overview_blocks: [ … ],                 // public overview (V3.552)
 *     published, published_at,                // publish snapshot (V3.553)
 *     created_by, created_at, updated_by, updated_at, schema_version }
 *
 * Access: read isLabMember, write isAdmin (firestore.rules V3.544).
 *
 * Globals: window.RESEARCH_DATA
 */
(function () {
  'use strict';

  var COLL = 'researchFoci';
  var SCHEMA_VERSION = 1;

  function db() {
    if (typeof firebridge !== 'undefined' && firebridge.db) return firebridge.db();
    if (typeof firebase !== 'undefined' && firebase.firestore) return firebase.firestore();
    throw new Error('Firestore unavailable — cannot reach research foci.');
  }
  function coll() { return db().collection(COLL); }
  function me() {
    var u = (typeof firebridge !== 'undefined' && firebridge.getUser) ? firebridge.getUser() : null;
    return u ? u.uid : null;
  }
  function isAdmin() {
    return typeof firebridge !== 'undefined' && firebridge.isAdmin && firebridge.isAdmin();
  }
  function isoNow() { return new Date().toISOString(); }
  function newId(prefix) {
    return (prefix || 'rf') + '-' + Date.now().toString(36) + '-' + Math.random().toString(36).slice(2, 6);
  }
  function esc(s) {
    return String(s == null ? '' : s).replace(/[&<>"']/g, function (c) {
      return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c];
    });
  }

  /* Allowlist HTML sanitizer for rich-text card descriptions + overview
   * text blocks — applied on save AND render (defense in depth). Lifted
   * from library-themes.js so both surfaces share one policy. */
  var _SAFE_TAGS = { B: 1, I: 1, U: 1, EM: 1, STRONG: 1, A: 1, UL: 1, OL: 1, LI: 1,
    P: 1, BR: 1, DIV: 1, CODE: 1, SUB: 1, SUP: 1, H3: 1, H4: 1, BLOCKQUOTE: 1 };
  function sanitizeHtml(html) {
    var doc = new DOMParser().parseFromString('<div>' + String(html || '') + '</div>', 'text/html');
    var root = doc.body.firstChild;
    (function walk(node) {
      Array.prototype.slice.call(node.childNodes).forEach(function (child) {
        if (child.nodeType === Node.TEXT_NODE) return;
        if (child.nodeType !== Node.ELEMENT_NODE || !_SAFE_TAGS[child.tagName]) {
          while (child.firstChild) node.insertBefore(child.firstChild, child);
          node.removeChild(child);
          return;
        }
        Array.prototype.slice.call(child.attributes).forEach(function (attr) {
          if (child.tagName === 'A' && attr.name === 'href' && /^https?:/i.test(child.getAttribute('href') || '')) return;
          child.removeAttribute(attr.name);
        });
        if (child.tagName === 'A') { child.setAttribute('target', '_blank'); child.setAttribute('rel', 'noopener'); }
        walk(child);
      });
    })(root);
    return root.innerHTML;
  }

  function slugify(s) {
    return String(s || '').toLowerCase().trim()
      .replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 60);
  }

  /* ── level + status metadata (shared by the renderer) ───────── */

  var LEVELS = {
    specialty: {
      key: 'specialty', label: 'Specialty', plural: 'Specialties',
      icon: '🧪', blurb: 'Lab-unique core capabilities.',
    },
    concept: {
      key: 'concept', label: 'Concept', plural: 'Concepts',
      icon: '💡', blurb: 'Broad ideas that combine our specialties.',
    },
    output: {
      key: 'output', label: 'Output', plural: 'Outputs',
      icon: '📄', blurb: 'Papers and patents we are building.',
    },
  };
  var LEVEL_ORDER = ['specialty', 'concept', 'output'];

  // Status vocab differs by level; the renderer maps to pills.
  var STATUS_META = {
    concept:          { label: 'Concept',        color: '#6d28d9', bg: '#ede9fe' },
    active:           { label: 'Active',         color: '#166534', bg: '#dcfce7' },
    paused:           { label: 'Paused',         color: '#b45309', bg: '#fef3c7' },
    archived:         { label: 'Archived',       color: '#374151', bg: '#e5e7eb' },
    // output-card lifecycle
    planning:         { label: 'Planning',       color: '#6d28d9', bg: '#ede9fe' },
    drafting:         { label: 'Drafting',       color: '#1e40af', bg: '#dbeafe' },
    submitted:        { label: 'Submitted',      color: '#0e7490', bg: '#cffafe' },
    under_review:     { label: 'Under review',   color: '#b45309', bg: '#fef3c7' },
    awarded_published:{ label: 'Awarded / published', color: '#166534', bg: '#dcfce7' },
    closed:           { label: 'Closed',         color: '#374151', bg: '#e5e7eb' },
  };
  var DEFAULT_STATUS = { specialty: 'active', concept: 'active', output: 'planning' };

  /* ── hydration ──────────────────────────────────────────────── */

  function hydrate(d) {
    d = d || {};
    d.level = LEVELS[d.level] ? d.level : 'concept';
    d.title = d.title || '';
    d.abbr = d.abbr || '';
    d.icon = d.icon || LEVELS[d.level].icon;
    d.color = d.color || '';
    d.one_liner = d.one_liner || '';
    d.template_fields = d.template_fields || { template_version: 1, answers: {} };
    if (!d.template_fields.answers) d.template_fields.answers = {};
    d.description_html = d.description_html || '';
    d.media = Array.isArray(d.media) ? d.media : [];
    d.links = d.links || {};
    d.links.specialty_ids = Array.isArray(d.links.specialty_ids) ? d.links.specialty_ids : [];
    d.links.concept_ids = Array.isArray(d.links.concept_ids) ? d.links.concept_ids : [];
    d.links.output_ids = Array.isArray(d.links.output_ids) ? d.links.output_ids : [];
    d.links.theme_id = d.links.theme_id || null;
    d.links.draft_refs = Array.isArray(d.links.draft_refs) ? d.links.draft_refs : [];
    d.links.patents = Array.isArray(d.links.patents) ? d.links.patents : [];
    d.links.training_slugs = Array.isArray(d.links.training_slugs) ? d.links.training_slugs : [];
    d.grant_meta = d.grant_meta || null;
    // V3.557 — draft-backed output card: the card IS an existing paper/
    // grant. Title + status derive live from the record; no typed fields.
    d.source_draft_id = d.source_draft_id || null;
    d.member_uids = Array.isArray(d.member_uids) ? d.member_uids : [];
    d.member_roles = d.member_roles || {};
    d.status = STATUS_META[d.status] ? d.status : (DEFAULT_STATUS[d.level] || 'active');
    d.status_source = d.status_source === 'derived' ? 'derived' : 'manual';
    d.order = typeof d.order === 'number' ? d.order : 0;
    d.overview_blocks = Array.isArray(d.overview_blocks) ? d.overview_blocks : [];
    d.published = !!d.published;
    d.published_at = d.published_at || null;
    return d;
  }

  /* ── reads ──────────────────────────────────────────────────── */

  /** Every focus, sorted by level (specialty → concept → output) then
   * order then title. One whole-collection get — the map is tens of docs. */
  async function listAll() {
    try {
      var snap = await coll().get();
      return snap.docs
        .map(function (doc) { return hydrate(Object.assign({ id: doc.id }, doc.data())); })
        .sort(function (a, b) {
          var la = LEVEL_ORDER.indexOf(a.level), lb = LEVEL_ORDER.indexOf(b.level);
          if (la !== lb) return la - lb;
          if (a.order !== b.order) return a.order - b.order;
          return (a.title || '').localeCompare(b.title || '');
        });
    } catch (err) {
      console.warn('[research-data] listAll failed:', err && err.message);
      return [];
    }
  }

  async function get(fociId) {
    if (!fociId) return null;
    try {
      var doc = await coll().doc(fociId).get();
      if (!doc.exists) return null;
      return hydrate(Object.assign({ id: doc.id }, doc.data()));
    } catch (err) {
      console.warn('[research-data] get failed:', err && err.message);
      return null;
    }
  }

  /* ── writes (admin-only; rules enforce, we guard for a clean error) ── */

  function assertAdmin() {
    if (!isAdmin()) throw new Error('Only the PI can edit research foci.');
  }

  /** Create a focus. `fields` must include level + title; id defaults to a
   * slug of the title (or fields.id). Rejects a duplicate id. */
  async function create(fields) {
    assertAdmin();
    fields = fields || {};
    var id = slugify(fields.id || fields.title);
    if (!id) throw new Error('A title (or id) is required.');
    if (!LEVELS[fields.level]) throw new Error('level must be specialty, concept, or output.');
    var ref = coll().doc(id);
    var existing = await ref.get();
    if (existing.exists) throw new Error('A focus with the id "' + id + '" already exists.');

    var doc = hydrate({
      id: id,
      level: fields.level,
      title: (fields.title || '').trim(),
      abbr: (fields.abbr || '').trim(),
      icon: fields.icon || '',
      color: fields.color || '',
      one_liner: (fields.one_liner || '').trim(),
      template_fields: fields.template_fields || { template_version: 1, answers: {} },
      description_html: fields.description_html || '',
      links: fields.links || {},
      grant_meta: fields.grant_meta || null,
      source_draft_id: fields.source_draft_id || null,
      member_uids: fields.member_uids || [],
      member_roles: fields.member_roles || {},
      status: fields.status || DEFAULT_STATUS[fields.level],
      status_source: fields.status_source || 'manual',
      order: typeof fields.order === 'number' ? fields.order : 0,
    });
    doc.created_by = me();
    doc.created_at = isoNow();
    doc.updated_by = me();
    doc.updated_at = isoNow();
    doc.schema_version = SCHEMA_VERSION;
    // Strip the client id key — it's the doc id, not a field.
    var toWrite = Object.assign({}, doc); delete toWrite.id;
    await ref.set(toWrite);
    return doc;
  }

  /** Shallow-merge a patch onto a focus. Always stamps updated_by/at. Dotted
   * field paths in `patch` are honored by Firestore update(). */
  async function update(fociId, patch) {
    assertAdmin();
    if (!fociId) throw new Error('fociId is required.');
    var body = Object.assign({}, patch || {});
    body.updated_by = me();
    body.updated_at = isoNow();
    await coll().doc(fociId).update(body);
  }

  async function remove(fociId) {
    assertAdmin();
    if (!fociId) throw new Error('fociId is required.');
    await coll().doc(fociId).delete();
  }

  /* ── shared modal shell (used by composer / links / create / media) ── */
  // Returns { el, body, close }. `opts`: { title, wide, onClose }. The
  // caller fills body.innerHTML and wires its own buttons; close() removes
  // it. Backdrop click + Esc cancel. Styles live in research.css.
  function modal(opts) {
    opts = opts || {};
    var back = document.createElement('div');
    back.className = 'rf-modal-backdrop';
    back.innerHTML =
      '<div class="rf-modal' + (opts.wide ? ' rf-modal-wide' : '') + '" role="dialog" aria-modal="true">' +
        '<div class="rf-modal-head"><h3></h3><button class="rf-modal-x" aria-label="Close">✕</button></div>' +
        '<div class="rf-modal-body"></div>' +
      '</div>';
    back.querySelector('h3').textContent = opts.title || '';
    var body = back.querySelector('.rf-modal-body');
    function close() {
      document.removeEventListener('keydown', onKey, true);
      back.remove();
      if (opts.onClose) opts.onClose();
    }
    function onKey(e) { if (e.key === 'Escape') { e.stopPropagation(); close(); } }
    back.querySelector('.rf-modal-x').addEventListener('click', close);
    back.addEventListener('mousedown', function (e) { if (e.target === back) close(); });
    document.addEventListener('keydown', onKey, true);
    document.body.appendChild(back);
    return { el: back, body: body, close: close };
  }

  /* ── exports ────────────────────────────────────────────────── */

  window.RESEARCH_DATA = {
    COLL: COLL,
    LEVELS: LEVELS,
    LEVEL_ORDER: LEVEL_ORDER,
    STATUS_META: STATUS_META,
    DEFAULT_STATUS: DEFAULT_STATUS,
    slugify: slugify,
    newId: newId,
    esc: esc,
    sanitizeHtml: sanitizeHtml,
    modal: modal,
    hydrate: hydrate,
    listAll: listAll,
    get: get,
    create: create,
    update: update,
    remove: remove,
    isAdmin: isAdmin,
  };
})();
