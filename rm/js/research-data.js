/* research-data.js — V3.544, levels reworked V3.717
 *
 * THE data layer for the lab's research map: rm/pages/research.html. A
 * research focus is one of FIVE levels, forming one chain —
 *
 *   specialty — a lab-unique core capability (MEBP, In-Situ ELISA, GELS,
 *               CELS, STEM, TFM). The verbs of the lab.
 *   concept   — a broad idea that COMBINES one or more specialties
 *               (e.g. Tissue engineering). The sentences.
 *   grant     — a funded (or proposed) program built from concepts. V3.717
 *               promoted this out of `concept.grant_meta`: a grant now has
 *               its own card, its own MANUAL status (in_preparation →
 *               submitted → awarded → completed — the card is the lab's one
 *               source of truth, never derived from a builder draft), and
 *               its own review page rolling up everyone's work under it.
 *   aim       — a target result the grant needs in order to succeed.
 *   output    — the synthesis of those results: a paper or a patent.
 *
 * `aim` and `output` are peers rendered in ONE hub band ("Aims & outputs")
 * but kept as separate levels for bookkeeping — see BANDS.
 *
 * One collection discriminated by `level` (not five) so cross-level links
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
 *     links: { specialty_ids[], concept_ids[], grant_ids[], aim_ids[],
 *              output_ids[], theme_id,
 *              draft_refs:[{id,title,kind}], patents:[{…}], training_slugs[] }, // V3.548, V3.717
 *     grant_meta: { agency, mechanism, submit_to, submission_url,
 *                   target_deadline, scope_html, promoted_draft_id,
 *                   award_number, period_start, period_end },           // V3.717: on GRANT cards
 *     member_uids: [], member_roles: { uid: 'lead'|'contributor' },
 *     status, status_source: 'manual'|'derived', order,
 *     overview_blocks: [ … ],                 // public overview (V3.552)
 *     published, published_at,                // publish snapshot (V3.553)
 *     approval: { status:'proposed'|'approved'|'declined', proposed_by,
 *                 proposed_at, decided_by, decided_at, note },        // V3.851 — ABSENT on a legacy card = approved
 *     created_by, created_at, updated_by, updated_at, schema_version }
 *
 * Children point UP (links.<parent-level>_ids) and every parent list is
 * DERIVED by scanning children — see PARENTS / LINK_KEY / childrenOf. That
 * is why re-parenting an aim retroactively fixes every past attribution:
 * nothing is denormalized onto a focusArea. grantIdsForCard() is the
 * resolver the whole grant roll-up rests on.
 *
 * Access: read isLabMember; write isAdmin (firestore.rules V3.544) — OR,
 * since V3.851, any lab member may PROPOSE a card (created in their own
 * name with approval.status 'proposed'), keep editing it while it is
 * undecided, and withdraw it; the proposer's mentors
 * (users/{proposer}.mentor_uids — the direct advisor) and the PI decide it.
 * Once approved it is admin-write like every older card. mayEdit() /
 * mayDecide() below are the client mirror of that rule; the rule is the
 * boundary.
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
  function isLabMember() {
    if (typeof firebridge === 'undefined') return false;
    if (firebridge.isLabMember) return !!firebridge.isLabMember();
    return !!me();
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
      icon: 'test-tube', blurb: 'Lab-unique core capabilities.',
    },
    concept: {
      key: 'concept', label: 'Concept', plural: 'Concepts',
      icon: 'light-bulb', blurb: 'Broad ideas that combine our specialties.',
    },
    grant: {
      key: 'grant', label: 'Grant', plural: 'Grants',
      icon: 'bookmark-square', blurb: 'Funded and proposed programs built from our concepts.',
    },
    aim: {
      key: 'aim', label: 'Aim', plural: 'Aims',
      icon: 'target', blurb: 'The target results a grant needs to succeed.',
    },
    output: {
      key: 'output', label: 'Output', plural: 'Outputs',
      icon: 'document-text', blurb: 'Papers and patents that synthesize those results.',
    },
  };
  var LEVEL_ORDER = ['specialty', 'concept', 'grant', 'aim', 'output'];

  /* Never returns undefined. A card written by a NEWER build carries a level
   * this one has never heard of; every renderer that reaches for an icon or a
   * label needs an answer rather than a TypeError. The placeholder is
   * deliberately bland — an unknown level should look unfinished, not like a
   * concept. */
  var UNKNOWN_LEVEL = { key: '', label: 'Card', plural: 'Cards', icon: 'square', blurb: '' };
  function levelMeta(level) { return LEVELS[level] || UNKNOWN_LEVEL; }

  /* V3.717 — the hub's SECTIONS, deliberately decoupled from the levels.
   * Aims and outputs are peers under a grant ("aims are the results we
   * need, outputs are the synthesis of them"), so they share one band and
   * are sub-grouped inside it rather than stacked as two more rows. */
  var BANDS = [
    { key: 'specialty', levels: ['specialty'] },
    { key: 'concept',   levels: ['concept'] },
    { key: 'grant',     levels: ['grant'] },
    { key: 'delivery',  levels: ['aim', 'output'], title: 'Aims & outputs',
      blurb: 'Aims are the results a grant needs; outputs are the synthesis of them.' },
  ];

  /* Which levels a card of each level may link UP to, most-specific first.
   * Replaces the `level === 'specialty' ? 'specialty_ids' : 'concept_ids'`
   * ternary that used to be copy-pasted across four files. The trailing
   * legacy entries on aim/output keep pre-V3.717 links resolving. */
  var PARENTS = {
    specialty: [],
    concept:   ['specialty'],
    grant:     ['concept', 'specialty'],
    aim:       ['grant'],
    output:    ['aim', 'grant', 'concept', 'specialty'],
  };
  var LINK_KEY = {
    specialty: 'specialty_ids',
    concept:   'concept_ids',
    grant:     'grant_ids',
    aim:       'aim_ids',
  };

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
    // V3.717 grant lifecycle (manual, always — see effStatus in research.js)
    in_preparation:   { label: 'In preparation', color: '#6d28d9', bg: '#ede9fe' },
    awarded:          { label: 'Awarded',        color: '#166534', bg: '#dcfce7' },
    completed:        { label: 'Completed',      color: '#374151', bg: '#e5e7eb' },
  };
  /* The grant lifecycle, in order — the ONLY statuses a grant card offers.
   * `submitted` is shared with the output vocab above on purpose. */
  var GRANT_STATUSES = ['in_preparation', 'submitted', 'awarded', 'completed'];

  var DEFAULT_STATUS = {
    specialty: 'active', concept: 'active',
    grant: 'in_preparation', aim: 'planning', output: 'planning',
  };

  /* ── hydration ──────────────────────────────────────────────── */

  function hydrate(d) {
    d = d || {};
    /* V3.718 — an UNKNOWN level keeps its own name and is rendered nowhere,
     * rather than being coerced into 'concept'. That coercion is exactly how
     * the References card (level 'reference') showed up in the Concepts band
     * for anyone still running pre-V3.718 code: new data reached the browser
     * before the code that understood it. Since BANDS drives the hub by exact
     * level, an unrecognized card now simply doesn't render there — the safe
     * failure for a level this build has never heard of. Only a truly missing
     * level still defaults, and to 'concept' as before. */
    d.level = d.level ? String(d.level) : 'concept';
    d.title = d.title || '';
    d.abbr = d.abbr || '';
    d.icon = d.icon || levelMeta(d.level).icon;
    d.color = d.color || '';
    d.one_liner = d.one_liner || '';
    d.template_fields = d.template_fields || { template_version: 1, answers: {} };
    if (!d.template_fields.answers) d.template_fields.answers = {};
    d.description_html = d.description_html || '';
    d.media = Array.isArray(d.media) ? d.media : [];
    d.links = d.links || {};
    d.links.specialty_ids = Array.isArray(d.links.specialty_ids) ? d.links.specialty_ids : [];
    d.links.concept_ids = Array.isArray(d.links.concept_ids) ? d.links.concept_ids : [];
    d.links.grant_ids = Array.isArray(d.links.grant_ids) ? d.links.grant_ids : [];      // V3.717
    d.links.aim_ids = Array.isArray(d.links.aim_ids) ? d.links.aim_ids : [];            // V3.717
    d.links.output_ids = Array.isArray(d.links.output_ids) ? d.links.output_ids : [];
    d.links.theme_id = d.links.theme_id || null;
    d.links.draft_refs = Array.isArray(d.links.draft_refs) ? d.links.draft_refs : [];
    d.links.patents = Array.isArray(d.links.patents) ? d.links.patents : [];
    d.links.training_slugs = Array.isArray(d.links.training_slugs) ? d.links.training_slugs : [];
    d.grant_meta = d.grant_meta || null;
    /* V3.721 — on a GRANT card: where its bibliography comes from,
     * { kind:'draft_citations', draft_id }. Never the list itself — the
     * entries already live in the lab library tagged `cited_in_drafts`, so
     * the grant review reads them live and a citation added in the builder
     * shows up with no re-sync. (V3.718 briefly gave this its own card and
     * level; Alex wanted the references inside the grant, which is both
     * simpler and one fewer doc to keep in step.) */
    d.ref_source = d.ref_source || null;
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
    // V3.851 — absent on every pre-V3.851 card, which therefore reads as
    // approved (see approvalStatus). Kept as-is, never normalized into an
    // {status:'approved'} map: the rule treats a missing key as approved
    // and a write that ADDS the key is what a proposal is.
    d.approval = (d.approval && typeof d.approval === 'object') ? d.approval : null;
    return d;
  }

  /* ── V3.851 approval: student proposals ─────────────────────── */

  function approvalStatus(d) {
    var a = d && d.approval;
    return (a && a.status) ? String(a.status) : 'approved';
  }
  function isProposed(d) { return approvalStatus(d) === 'proposed'; }
  function isDeclined(d) { return approvalStatus(d) === 'declined'; }
  function isApproved(d) { return approvalStatus(d) === 'approved'; }
  /** Who proposed the card: approval.proposed_by, else its creator. */
  function proposerOf(d) {
    return (d && ((d.approval && d.approval.proposed_by) || d.created_by)) || null;
  }

  /* The signed-in user's mentees — the uids whose users/{uid}.mentor_uids
   * names them. One array-contains query, memoised for the page's life
   * (the mentor list changes on the permissions page, not here). Admins
   * never need it: isAdmin() short-circuits every check below. */
  var _mentees = null, _menteesPromise = null;
  function loadMentees() {
    if (_mentees) return Promise.resolve(_mentees);
    if (_menteesPromise) return _menteesPromise;
    _menteesPromise = (async function () {
      var set = {};
      try {
        var uid = me();
        if (uid && !isAdmin()) {
          var snap = await db().collection('users').where('mentor_uids', 'array-contains', uid).get();
          snap.docs.forEach(function (d) { set[d.id] = true; });
        }
      } catch (err) {
        console.warn('[research-data] mentee lookup failed:', err && err.message);
      }
      _mentees = set;
      return set;
    })();
    return _menteesPromise;
  }
  function isMenteeOfMe(uid) { return !!(uid && _mentees && _mentees[uid]); }

  /** May the signed-in user propose a card at all? Any lab member. */
  function canPropose() { return !!me() && isLabMember(); }

  /** May the signed-in user edit this card? Admin: always. Otherwise only
   * while it is undecided (proposed / declined), and only its proposer or
   * one of the proposer's mentors. Call loadMentees() first for the mentor
   * half; before it resolves a mentor reads as an outsider, never the
   * reverse. */
  function mayEdit(d) {
    if (!d) return false;
    if (isAdmin()) return true;
    if (isApproved(d)) return false;
    var p = proposerOf(d);
    return !!p && (p === me() || isMenteeOfMe(p));
  }
  /** May the signed-in user approve / decline this card? Admin: while it
   * is undecided. A mentor of the proposer: likewise, and never for their
   * own proposal (the rule forbids a self-decision; an admin's own cards
   * never carry an approval key in the first place). */
  function mayDecide(d) {
    if (!d || isApproved(d)) return false;
    if (isAdmin()) return true;
    var p = proposerOf(d);
    return !!p && p !== me() && isMenteeOfMe(p);
  }

  /* ── the card graph (V3.717) ────────────────────────────────── */

  /** The parent ids a card points UP at, as [{ id, level }] in PARENTS
   * order. Undefined levels (bad data) yield []. */
  function parentRefsOf(card) {
    if (!card) return [];
    var out = [];
    (PARENTS[card.level] || []).forEach(function (lvl) {
      ((card.links && card.links[LINK_KEY[lvl]]) || []).forEach(function (id) {
        out.push({ id: id, level: lvl });
      });
    });
    return out;
  }

  /** The cards one level DOWN that point at `card`. Parent lists are never
   * stored, so this is a scan — the map is tens of docs, and `allFoci` is
   * already in hand at every call site. `levels` narrows the result (e.g.
   * ['aim'] for just a grant's aims). */
  function childrenOf(card, allFoci, levels) {
    if (!card) return [];
    var key = LINK_KEY[card.level];
    if (!key) return [];
    return (allFoci || []).filter(function (x) {
      if (levels && levels.indexOf(x.level) === -1) return false;
      return ((x.links && x.links[key]) || []).indexOf(card.id) !== -1;
    });
  }

  /* THE attribution resolver. Given any card, which grant(s) does work on it
   * count toward? Every roll-up (the grant review, the My Week picker) goes
   * through here, so re-parenting an aim retroactively re-attributes every
   * past week — nothing is denormalized onto a focusArea.
   *
   *   grant     → itself
   *   aim       → links.grant_ids
   *   output    → links.grant_ids ∪ the grants of its links.aim_ids
   *   concept   → the grants built ON it (reverse scan), flagged INDIRECT:
   *               a concept is broader than any one grant, so its work is
   *               shown in its own muted group rather than counted as if it
   *               had been aimed at the grant.
   *   specialty → nothing; a capability underpins everything and would
   *               attribute to every grant at once, which is noise.
   *
   * Returns [{ id, indirect }] — ids are unique, direct hits first. */
  function grantIdsForCard(card, allFoci) {
    if (!card) return [];
    var seen = {}, out = [];
    function push(id, indirect) {
      if (!id || seen[id]) return;
      seen[id] = 1; out.push({ id: id, indirect: !!indirect });
    }
    if (card.level === 'grant') { push(card.id, false); return out; }
    // Anything whose only parent level IS 'grant' resolves the same way, so
    // a future level of that shape needs no branch here.
    if ((PARENTS[card.level] || []).join() === 'grant') {
      (card.links.grant_ids || []).forEach(function (id) { push(id, false); });
      return out;
    }
    if (card.level === 'output') {
      (card.links.grant_ids || []).forEach(function (id) { push(id, false); });
      var byId = {};
      (allFoci || []).forEach(function (x) { byId[x.id] = x; });
      (card.links.aim_ids || []).forEach(function (aimId) {
        var aim = byId[aimId];
        if (aim) (aim.links.grant_ids || []).forEach(function (id) { push(id, false); });
      });
      return out;
    }
    if (card.level === 'concept') {
      (allFoci || []).forEach(function (x) {
        if (x.level === 'grant' && (x.links.concept_ids || []).indexOf(card.id) !== -1) push(x.id, true);
      });
      return out;
    }
    return out;
  }

  /** Every card whose work rolls up to `grant` — the grant itself plus its
   * aims and the outputs that synthesize them. The id set the review page
   * matches focus_refs against. */
  function cardsUnderGrant(grant, allFoci) {
    if (!grant || grant.level !== 'grant') return [];
    var out = [grant];
    (allFoci || []).forEach(function (x) {
      if (x.id === grant.id) return;
      if (x.level !== 'aim' && x.level !== 'output') return;
      var hit = grantIdsForCard(x, allFoci).some(function (g) { return g.id === grant.id && !g.indirect; });
      if (hit) out.push(x);
    });
    return out;
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

  /* ── writes (rules enforce; we guard for a clean error) ─────── */

  /* V3.851 — admin writes go straight through. Anyone else must be editing
   * an undecided card they proposed or mentor; that needs the card, so a
   * non-admin write costs one extra read (writes are rare). Resolves to
   * the card, or null for an admin. */
  async function assertMayWrite(fociId) {
    if (isAdmin()) return null;
    if (!isLabMember()) throw new Error('Only lab members can edit research foci.');
    var doc = await get(fociId);
    if (!doc) throw new Error('That card no longer exists.');
    await loadMentees();
    if (!mayEdit(doc)) {
      throw new Error(isApproved(doc)
        ? 'Only the PI can edit an approved card.'
        : 'Only the proposer, their advisor, or the PI can edit a card that is awaiting approval.');
    }
    return doc;
  }

  /** Create a focus. `fields` must include level + title; id defaults to a
   * slug of the title (or fields.id). Rejects a duplicate id.
   *
   * V3.851 — a non-admin lab member creates a PROPOSAL: the shape the rule
   * requires is stamped here (created_by + approval.proposed_by = me,
   * status 'proposed', published false), the proposer is attached as the
   * card's lead member, and nothing the caller passed can override that —
   * so the only way the write fails is a real permission problem. */
  async function create(fields) {
    fields = fields || {};
    var proposing = !isAdmin();
    if (proposing && !canPropose()) throw new Error('Only lab members can propose a research focus.');
    var id = slugify(fields.id || fields.title);
    if (!id) throw new Error('A title (or id) is required.');
    if (!LEVELS[fields.level]) throw new Error('level must be one of: ' + LEVEL_ORDER.join(', ') + '.');
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
      ref_source: fields.ref_source || null,
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
    if (proposing) {
      doc.approval = { status: 'proposed', proposed_by: me(), proposed_at: isoNow(),
                       decided_by: null, decided_at: null, note: '' };
      doc.published = false;
      doc.published_at = null;
      if (doc.member_uids.indexOf(me()) === -1) doc.member_uids.push(me());
      if (!doc.member_roles[me()]) doc.member_roles[me()] = 'lead';
    }
    // Strip the client id key — it's the doc id, not a field. An absent
    // `approval` is the legacy (approved) shape — never write it as null,
    // which the rule's map lookup would choke on for a later non-admin write.
    var toWrite = Object.assign({}, doc); delete toWrite.id;
    if (toWrite.approval == null) delete toWrite.approval;
    await ref.set(toWrite);
    return doc;
  }

  /** Shallow-merge a patch onto a focus. Always stamps updated_by/at. Dotted
   * field paths in `patch` are honored by Firestore update(). */
  async function update(fociId, patch) {
    if (!fociId) throw new Error('fociId is required.');
    var body = Object.assign({}, patch || {});
    if (await assertMayWrite(fociId)) {
      // A non-admin can never publish; the rule pins the flag false, so
      // dropping the keys here turns a denial into a no-op.
      delete body.published; delete body.published_at;
    }
    body.updated_by = me();
    body.updated_at = isoNow();
    await coll().doc(fociId).update(body);
  }

  async function remove(fociId) {
    if (!fociId) throw new Error('fociId is required.');
    await assertMayWrite(fociId);
    await coll().doc(fociId).delete();
  }

  /* V3.851 — the three approval moves. Each writes the whole `approval`
   * map (the rule reads it as a map), stamped in the caller's own name,
   * which is what the rule checks. */
  async function approve(card) {
    await loadMentees();
    if (!mayDecide(card)) throw new Error('Only the PI or the proposer’s advisor can approve a card.');
    var next = Object.assign({}, card.approval || {}, {
      status: 'approved', decided_by: me(), decided_at: isoNow(), note: '',
    });
    if (!next.proposed_by) next.proposed_by = proposerOf(card);
    await update(card.id, { approval: next });
    return next;
  }
  async function decline(card, note) {
    await loadMentees();
    if (!mayDecide(card)) throw new Error('Only the PI or the proposer’s advisor can decline a card.');
    var next = Object.assign({}, card.approval || {}, {
      status: 'declined', decided_by: me(), decided_at: isoNow(), note: String(note || '').trim(),
    });
    if (!next.proposed_by) next.proposed_by = proposerOf(card);
    await update(card.id, { approval: next });
    return next;
  }
  /** The proposer sends a declined card back for another look. The note
   * that declined it rides along as `previous_note` so the decider sees
   * what they asked for last time. */
  async function repropose(card) {
    if (!card || proposerOf(card) !== me()) throw new Error('Only the proposer can re-propose a card.');
    if (!isDeclined(card)) throw new Error('Only a declined card can be re-proposed.');
    var next = {
      status: 'proposed', proposed_by: me(), proposed_at: isoNow(),
      decided_by: null, decided_at: null, note: '',
      previous_note: (card.approval && card.approval.note) || '',
      reproposed: true,
    };
    await update(card.id, { approval: next });
    return next;
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
    levelMeta: levelMeta,
    LEVEL_ORDER: LEVEL_ORDER,
    BANDS: BANDS,
    PARENTS: PARENTS,
    LINK_KEY: LINK_KEY,
    STATUS_META: STATUS_META,
    GRANT_STATUSES: GRANT_STATUSES,
    DEFAULT_STATUS: DEFAULT_STATUS,
    parentRefsOf: parentRefsOf,
    childrenOf: childrenOf,
    grantIdsForCard: grantIdsForCard,
    cardsUnderGrant: cardsUnderGrant,
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
    isLabMember: isLabMember,
    // V3.851 — student proposals
    approvalStatus: approvalStatus,
    isProposed: isProposed,
    isDeclined: isDeclined,
    isApproved: isApproved,
    proposerOf: proposerOf,
    loadMentees: loadMentees,
    canPropose: canPropose,
    mayEdit: mayEdit,
    mayDecide: mayDecide,
    approve: approve,
    decline: decline,
    repropose: repropose,
  };
})();
