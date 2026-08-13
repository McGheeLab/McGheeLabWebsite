/* roadmap-data.js — V3.600 (Research Roadmap program R1)
 *
 * The data layer for an output card's ROADMAP: the experiments that must
 * run, the analyses each one yields, and the figure each analysis is
 * supposed to produce. The research map (research-data.js) says WHAT the
 * lab is building; the roadmap says HOW we get there.
 *
 *   experiment — a thing you go and do at a bench or a scope
 *                ("confocal time-point measurements of granules in
 *                various conditions")
 *   analysis   — a measurement extracted from that experiment
 *                ("void space over time"), the unit a student's week
 *                aligns to
 *   figure     — what the analysis is FOR: the panel it becomes
 *
 * Three storage shapes, because three different people write them:
 *
 *   researchFoci/{fociId}.roadmap        ADMIN — the structure itself.
 *     { intro_html,
 *       experiments: [ { id, title, description_html, status, owner_uids,
 *                        order,
 *                        analyses: [ { id, title, method_note, status,
 *                                      owner_uids,
 *                                      figure: { needed, kind, caption_target,
 *                                                status, figure_ref, media_id } } ] } ],
 *       updated_by, updated_at }
 *     Embedded arrays, not a subcollection: admin-authored structure of
 *     tens of items, and the hub already renders the whole map from one
 *     get(). Same call as media[] / links.patents[] / overview_blocks[].
 *
 *   researchFoci/{fociId}/refs/{refId}   ANY LAB MEMBER — reference papers.
 *     The focus doc is admin-write-only, so member-editable attachments
 *     have to be a subcollection (the labThemes/{id}/groups precedent).
 *     refId = `${itemId}__${targetId||'root'}` — deterministic, so
 *     attaching the same paper to the same target twice is idempotent
 *     rather than a duplicate row.
 *     The point of a ref is the NOTE: why this paper is appropriate here.
 *
 *   roadmapClaims/{uid}__{analysisId}    SELF — who is on what, this week.
 *     A denormalized mirror of focusAreas.focus_ref.analysis_id, never the
 *     source of truth. It exists because the focusAreas rule is
 *     owner-or-mentor-or-admin, so a student cannot read a peer's focus —
 *     but the hub band has to show the whole lab who is working on which
 *     analysis. Flat top-level collection = one whole-collection get, no
 *     collectionGroup, no composite index.
 *
 * Deliberately standalone: own firebridge.db() refs, no RESEARCH_DATA
 * dependency, so library.html and library-paper.html can load this plus
 * roadmap-attach.js without pulling in the whole research stack.
 *
 * Globals: window.ROADMAP_DATA
 */
(function () {
  'use strict';

  var FOCI_COLL = 'researchFoci';
  var CLAIMS_COLL = 'roadmapClaims';

  function db() {
    if (typeof firebridge !== 'undefined' && firebridge.db) return firebridge.db();
    if (typeof firebase !== 'undefined' && firebase.firestore) return firebase.firestore();
    throw new Error('Firestore unavailable — cannot reach research roadmaps.');
  }
  function foci() { return db().collection(FOCI_COLL); }
  function me() {
    var u = (typeof firebridge !== 'undefined' && firebridge.getUser) ? firebridge.getUser() : null;
    return u ? u.uid : null;
  }
  function myName() {
    var u = (typeof firebridge !== 'undefined' && firebridge.getUser) ? firebridge.getUser() : null;
    return (u && (u.displayName || u.email)) || 'Someone';
  }
  function isAdmin() {
    return typeof firebridge !== 'undefined' && firebridge.isAdmin && firebridge.isAdmin();
  }
  function isoNow() { return new Date().toISOString(); }
  function newId(prefix) {
    return (prefix || 'rm') + '-' + Date.now().toString(36) + '-' + Math.random().toString(36).slice(2, 6);
  }
  function esc(s) {
    return String(s == null ? '' : s).replace(/[&<>"']/g, function (c) {
      return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c];
    });
  }

  /* ── vocabulary ─────────────────────────────────────────────── */

  /* Roadmap-item lifecycle. Deliberately its OWN vocabulary rather than
   * an extension of RESEARCH_DATA.STATUS_META — a card is never "running"
   * and an analysis is never "awarded_published"; merging the two would
   * make both pill sets lie. */
  var STATUS_META = {
    planned: { label: 'Planned',     color: '#6d28d9', bg: '#ede9fe', open: true },
    running: { label: 'Running',     color: '#1e40af', bg: '#dbeafe', open: false },
    blocked: { label: 'Blocked',     color: '#b91c1c', bg: '#fee2e2', open: true },
    done:    { label: 'Done',        color: '#166534', bg: '#dcfce7', open: false },
  };
  var STATUS_ORDER = ['planned', 'running', 'blocked', 'done'];

  var FIGURE_KINDS = {
    figure:     { label: 'Figure',     icon: '📊' },
    panel:      { label: 'Panel',      icon: '🔲' },
    table:      { label: 'Table',      icon: '▦' },
    supplement: { label: 'Supplement', icon: '📎' },
  };
  var FIGURE_STATUS = {
    none:  { label: 'Not started', color: '#6b7280', bg: '#f3f4f6' },
    draft: { label: 'Draft',       color: '#b45309', bg: '#fef3c7' },
    final: { label: 'Final',       color: '#166534', bg: '#dcfce7' },
  };

  /* Paper-ref relevance — same 3/2/1 vocabulary as library theme_relevance
   * so a student reads one scale across the whole app. */
  var RELEVANCE = { 3: 'Core', 2: 'Supporting', 1: 'Tangential' };

  /* ── hydration ──────────────────────────────────────────────── */

  /* The analysis-side figure SPEC — what the figure should show. Distinct
   * from a board figure (below), which is the actual image. `refs` points
   * into the board; `figure_ref` is the free-text escape hatch for a
   * figure that doesn't exist on the board yet. */
  function hydrateFigureSpec(g) {
    g = g || {};
    return {
      needed: g.needed !== false,
      kind: FIGURE_KINDS[g.kind] ? g.kind : 'figure',
      caption_target: g.caption_target || '',
      status: FIGURE_STATUS[g.status] ? g.status : 'none',
      figure_ref: g.figure_ref || '',
      media_id: g.media_id || null,
      // V3.606 — pointers into roadmap.figures: [{figure_id, panel_id|null}]
      refs: (Array.isArray(g.refs) ? g.refs : [])
        .filter(function (r) { return r && r.figure_id; })
        .map(function (r) { return { figure_id: r.figure_id, panel_id: r.panel_id || null }; }),
    };
  }

  function hydrateAnalysis(a) {
    a = a || {};
    return {
      id: a.id || newId('an'),
      title: a.title || '',
      method_note: a.method_note || '',
      status: STATUS_META[a.status] ? a.status : 'planned',
      owner_uids: Array.isArray(a.owner_uids) ? a.owner_uids : [],
      figure: hydrateFigureSpec(a.figure),
    };
  }

  /* ── the figure board (V3.605) ──────────────────────────────── */

  /* A board figure is the thing we are trying to BUILD — the visual
   * statement of the roadmap. It holds an optional whole-figure image
   * plus an ordered list of panels (subfigures), each its own image.
   *
   * Panel labels follow the paper builder's rule exactly (uppercase
   * A/B/C by position — see paper-fig-compose.js `_letter`) so a figure
   * that graduates from a roadmap into a manuscript keeps its labels.
   * They are DERIVED from position, never stored as authored text:
   * deleting panel B must renumber C→B, and any stored label would drift.
   *
   * Image entries reuse the RESEARCH_MEDIA variant shape verbatim
   * ({storage_dir, variants:{thumb,medium,full}, mime}) so uploads go
   * through `uploadImageVariants` and no new storage path or rule is
   * needed — researchFoci/{fociId}/** is already covered. */
  function panelLetter(i) { return String.fromCharCode(65 + (i % 26)); }

  function hydrateImage(v) {
    if (!v || !v.variants) return null;
    return {
      storage_dir: v.storage_dir || '',
      variants: {
        thumb: v.variants.thumb || '',
        medium: v.variants.medium || '',
        full: v.variants.full || '',
      },
      mime: v.mime || 'image/webp',
    };
  }
  /** Best available URL for a board image at a given intent. */
  function imageUrl(img, size) {
    if (!img || !img.variants) return '';
    var v = img.variants;
    if (size === 'thumb') return v.thumb || v.medium || v.full || '';
    if (size === 'full') return v.full || v.medium || v.thumb || '';
    return v.medium || v.full || v.thumb || '';
  }

  function hydratePanel(p) {
    p = p || {};
    return {
      id: p.id || newId('pn'),
      title: p.title || '',
      image: hydrateImage(p.image),
    };
  }

  function hydrateBoardFigure(x, idx) {
    x = x || {};
    return {
      id: x.id || newId('fig'),
      title: x.title || '',
      caption: x.caption || '',
      status: FIGURE_STATUS[x.status] ? x.status : 'none',
      order: typeof x.order === 'number' ? x.order : idx * 10,
      image: hydrateImage(x.image),
      panels: (Array.isArray(x.panels) ? x.panels : []).map(hydratePanel),
    };
  }

  /** Board figures in order, each stamped with its derived number and
   * label, and each panel with its derived letter. This is THE read path
   * for anything that displays or references a figure. */
  function boardFigures(roadmap) {
    var figs = hydrate(roadmap).figures;
    return figs.map(function (x, i) {
      x.num = i + 1;
      x.label = 'Fig ' + x.num;
      x.panels.forEach(function (p, j) {
        p.letter = panelLetter(j);
        p.label = x.label + p.letter;
      });
      return x;
    });
  }

  /** Resolve one {figure_id, panel_id} pointer against the board. Returns
   * null when the figure was deleted — callers render the free-text
   * fallback rather than a dangling "Fig undefined". */
  function resolveFigureRef(roadmap, ref) {
    if (!ref || !ref.figure_id) return null;
    var hit = boardFigures(roadmap).filter(function (x) { return x.id === ref.figure_id; })[0];
    if (!hit) return null;
    if (!ref.panel_id) {
      return { figure: hit, panel: null, label: hit.label, title: hit.title, image: hit.image };
    }
    var pan = hit.panels.filter(function (p) { return p.id === ref.panel_id; })[0];
    if (!pan) return { figure: hit, panel: null, label: hit.label, title: hit.title, image: hit.image };
    return {
      figure: hit, panel: pan, label: pan.label,
      title: pan.title || hit.title,
      image: pan.image || hit.image,
    };
  }

  /** Everything a figure pointer can name, in render order — the option
   * list for the analysis editor's picker. */
  function figureRefTargets(roadmap) {
    var rows = [];
    boardFigures(roadmap).forEach(function (x) {
      rows.push({
        figure_id: x.id, panel_id: null, label: x.label,
        title: x.title, depth: 0, whole: true,
      });
      x.panels.forEach(function (p) {
        rows.push({
          figure_id: x.id, panel_id: p.id, label: p.label,
          title: p.title, depth: 1, whole: false,
        });
      });
    });
    return rows;
  }

  /** Reverse index: which analyses feed a given figure (or one panel of
   * it). The payoff of the board — look at a figure, see the measurements
   * that produce it. Pass panelId to narrow; omit for the whole figure
   * including all its panels. */
  function analysesForFigure(roadmap, figureId, panelId) {
    return flattenAnalyses(roadmap).filter(function (a) {
      return (a.analysis.figure.refs || []).some(function (r) {
        if (r.figure_id !== figureId) return false;
        return panelId ? r.panel_id === panelId : true;
      });
    });
  }

  function hydrateExperiment(x, idx) {
    x = x || {};
    return {
      id: x.id || newId('exp'),
      title: x.title || '',
      description_html: x.description_html || '',
      status: STATUS_META[x.status] ? x.status : 'planned',
      owner_uids: Array.isArray(x.owner_uids) ? x.owner_uids : [],
      order: typeof x.order === 'number' ? x.order : idx * 10,
      analyses: (Array.isArray(x.analyses) ? x.analyses : []).map(hydrateAnalysis),
    };
  }

  /** Normalize a roadmap blob off a focus doc. Always returns an object —
   * an output card with no roadmap yet reads as an empty one. */
  function hydrate(r) {
    r = r || {};
    return {
      intro_html: r.intro_html || '',
      // V3.605 — the figure board: what we're trying to build.
      figures: (Array.isArray(r.figures) ? r.figures : [])
        .map(hydrateBoardFigure)
        .sort(function (a, b) { return a.order - b.order; }),
      experiments: (Array.isArray(r.experiments) ? r.experiments : [])
        .map(hydrateExperiment)
        .sort(function (a, b) { return a.order - b.order; }),
      updated_by: r.updated_by || null,
      updated_at: r.updated_at || null,
    };
  }

  function isEmpty(r) {
    r = r || {};
    return !(r.experiments || []).length && !(r.figures || []).length && !r.intro_html;
  }

  /* ── derived views ──────────────────────────────────────────── */

  /** Every analysis in a roadmap, flattened with its experiment context.
   * The unit everything downstream (pickers, claims, the hub band) works
   * in — an analysis is only meaningful alongside the experiment it came
   * from. */
  function flattenAnalyses(roadmap) {
    var out = [];
    (hydrate(roadmap).experiments).forEach(function (x) {
      x.analyses.forEach(function (a) {
        out.push({
          analysis: a,
          analysis_id: a.id,
          analysis_title: a.title,
          experiment_id: x.id,
          experiment_title: x.title,
          experiment_status: x.status,
        });
      });
    });
    return out;
  }

  /** { total, done, open } over a roadmap's analyses. */
  function progressOf(roadmap) {
    var rows = flattenAnalyses(roadmap);
    var done = rows.filter(function (r) { return r.analysis.status === 'done'; }).length;
    return { total: rows.length, done: done, open: rows.length - done };
  }

  /** { total, final, drafted } over the figure board — "how much of the
   * paper's visual argument actually exists yet". */
  function figureProgressOf(roadmap) {
    var figs = hydrate(roadmap).figures;
    var fin = figs.filter(function (x) { return x.status === 'final'; }).length;
    var dr = figs.filter(function (x) { return x.status === 'draft'; }).length;
    return { total: figs.length, final: fin, drafted: dr };
  }

  /** Everything a paper can be attached to on one card, in render order:
   * the roadmap as a whole, then each experiment, then its analyses. */
  function attachTargets(roadmap) {
    var rows = [{ kind: 'roadmap', id: null, label: 'The whole roadmap', depth: 0 }];
    hydrate(roadmap).experiments.forEach(function (x) {
      rows.push({ kind: 'experiment', id: x.id, label: x.title || '(untitled experiment)', depth: 1 });
      x.analyses.forEach(function (a) {
        rows.push({
          kind: 'analysis', id: a.id, depth: 2,
          label: a.title || '(untitled analysis)', experiment_title: x.title,
        });
      });
    });
    return rows;
  }

  /* ── focus-card reads ───────────────────────────────────────── */

  /** Output cards that can carry a roadmap, each with its roadmap
   * hydrated. One whole-collection get + client sort (the map is tens of
   * docs) — same shape as RESEARCH_DATA.listAll, but standalone so the
   * library pages can call it without the research stack. */
  async function listRoadmapCards(opts) {
    opts = opts || {};
    try {
      var snap = await foci().get();
      var rows = [];
      snap.docs.forEach(function (doc) {
        var d = doc.data() || {};
        if ((d.level || 'concept') !== 'output') return;
        var rm = hydrate(d.roadmap);
        if (opts.withRoadmapOnly && isEmpty(rm)) return;
        rows.push({
          id: doc.id,
          title: d.title || doc.id,
          icon: d.icon || '📄',
          one_liner: d.one_liner || '',
          status: d.status || '',
          member_uids: Array.isArray(d.member_uids) ? d.member_uids : [],
          roadmap: rm,
        });
      });
      return rows.sort(function (a, b) { return (a.title || '').localeCompare(b.title || ''); });
    } catch (err) {
      console.warn('[roadmap-data] listRoadmapCards failed:', err && err.message);
      return [];
    }
  }

  /* ── structure writes (admin) ───────────────────────────────── */

  function assertAdmin() {
    if (!isAdmin()) throw new Error('Only the PI can edit a roadmap’s structure.');
  }

  /** Replace a card's whole roadmap. The editor modal collects the full
   * tree and saves once, so there is no partial-write race to design
   * around (and the doc is admin-write, i.e. single-author by rule). */
  async function saveRoadmap(fociId, roadmap) {
    assertAdmin();
    if (!fociId) throw new Error('fociId is required.');
    var body = hydrate(roadmap);
    body.updated_by = me();
    body.updated_at = isoNow();
    await foci().doc(fociId).update({
      roadmap: body,
      updated_by: me(),
      updated_at: isoNow(),
    });
    return body;
  }

  /* ── reference papers (any lab member) ──────────────────────── */

  function refsColl(fociId) { return foci().doc(fociId).collection('refs'); }

  /** Deterministic ref id so a re-attach updates rather than duplicates.
   * Firestore ids may not contain '/', which a kebab item id never does. */
  function refIdFor(itemId, targetId) {
    return String(itemId) + '__' + (targetId || 'root');
  }

  function hydrateRef(d) {
    d = d || {};
    d.target = d.target || { kind: 'roadmap', id: null };
    d.note = d.note || '';
    var w = parseInt(d.relevance, 10);
    d.relevance = (w === 1 || w === 2 || w === 3) ? w : 2;
    return d;
  }

  async function listRefs(fociId) {
    if (!fociId) return [];
    try {
      var snap = await refsColl(fociId).get();
      return snap.docs
        .map(function (d) { return hydrateRef(Object.assign({ id: d.id }, d.data())); })
        .sort(function (a, b) {
          return (b.relevance - a.relevance) || (a.added_at || '').localeCompare(b.added_at || '');
        });
    } catch (err) {
      console.warn('[roadmap-data] listRefs failed:', err && err.message);
      return [];
    }
  }

  /** Attach a library paper to a roadmap target with the note that says
   * WHY. `snapshot` carries title/authors/year so the roadmap renders its
   * pills without loading the library. Also mirrors the card id onto
   * meta.library.roadmaps so the reader/library can show "on N roadmaps"
   * without a collectionGroup query. */
  async function addRef(fociId, opts) {
    opts = opts || {};
    if (!fociId || !opts.itemId) throw new Error('fociId and itemId are required.');
    var target = opts.target || { kind: 'roadmap', id: null };
    var refId = refIdFor(opts.itemId, target.id);
    var snap = opts.snapshot || {};
    var existing = null;
    try { existing = await refsColl(fociId).doc(refId).get(); } catch (e) {}

    var body = {
      item_id: opts.itemId,
      target: { kind: target.kind || 'roadmap', id: target.id || null },
      note: (opts.note || '').trim(),
      relevance: [1, 2, 3].indexOf(opts.relevance) !== -1 ? opts.relevance : 2,
      title_snapshot: snap.title || '',
      authors_snapshot: snap.authors || '',
      year_snapshot: snap.year || '',
      last_editor: me(),
      modified_at: isoNow(),
    };
    if (!(existing && existing.exists)) {
      body.added_by = me();
      body.creator_name = myName();
      body.added_at = isoNow();
    }
    await refsColl(fociId).doc(refId).set(body, { merge: true });

    // Reverse index on the paper — rides the V3.309 items rule, so no
    // rules change. Best-effort: the ref is the source of truth and a
    // failed mirror must not lose the note the user just typed.
    if (window.LIBRARY_LINKS && LIBRARY_LINKS.toggleRoadmap) {
      try { await LIBRARY_LINKS.toggleRoadmap(opts.itemId, fociId, true); }
      catch (e) { console.warn('[roadmap-data] roadmaps mirror failed:', e && e.message); }
    }
    return hydrateRef(Object.assign({ id: refId }, body));
  }

  async function updateRef(fociId, refId, patch) {
    if (!fociId || !refId) throw new Error('fociId and refId are required.');
    var body = Object.assign({}, patch || {});
    body.last_editor = me();
    body.modified_at = isoNow();
    await refsColl(fociId).doc(refId).update(body);
  }

  /** Detach a paper from one target. The meta.library.roadmaps mirror is
   * only cleared when this was the paper's LAST ref on that card — the
   * same paper may be attached to several analyses of one roadmap. */
  async function removeRef(fociId, refId, itemId) {
    if (!fociId || !refId) throw new Error('fociId and refId are required.');
    await refsColl(fociId).doc(refId).delete();
    if (!itemId || !(window.LIBRARY_LINKS && LIBRARY_LINKS.toggleRoadmap)) return;
    try {
      var rest = await listRefs(fociId);
      var stillHere = rest.some(function (r) { return r.item_id === itemId; });
      if (!stillHere) await LIBRARY_LINKS.toggleRoadmap(itemId, fociId, false);
    } catch (e) { console.warn('[roadmap-data] roadmaps mirror cleanup failed:', e && e.message); }
  }

  /** Every roadmap attachment for one library item, resolved from the
   * paper's own meta.library.roadmaps mirror — one get per attached card
   * (usually zero or one), never a scan of the whole map. */
  async function listRefsForItem(item) {
    var lib = (item && item.meta && item.meta.library) || {};
    var cards = Array.isArray(lib.roadmaps) ? lib.roadmaps : [];
    if (!cards.length) return [];
    var out = [];
    for (var i = 0; i < cards.length; i++) {
      var fociId = cards[i];
      var refs = await listRefs(fociId);
      refs.filter(function (r) { return r.item_id === item.id; })
        .forEach(function (r) { out.push(Object.assign({ foci_id: fociId }, r)); });
    }
    return out;
  }

  /* ── claims (self-write mirror of focusAreas.focus_ref) ─────── */

  function claimsColl() { return db().collection(CLAIMS_COLL); }
  function claimIdFor(uid, analysisId) { return String(uid) + '__' + String(analysisId); }

  /** Every current claim, lab-wide. One whole-collection get; the hub
   * band filters by week client-side. */
  async function listClaims() {
    try {
      var snap = await claimsColl().get();
      return snap.docs.map(function (d) { return Object.assign({ id: d.id }, d.data()); });
    } catch (err) {
      console.warn('[roadmap-data] listClaims failed:', err && err.message);
      return [];
    }
  }

  async function setClaim(opts) {
    opts = opts || {};
    var uid = opts.uid || me();
    if (!uid || !opts.analysis_id) throw new Error('uid and analysis_id are required.');
    await claimsColl().doc(claimIdFor(uid, opts.analysis_id)).set({
      uid: uid,
      name: opts.name || myName(),
      foci_id: opts.foci_id || null,
      experiment_id: opts.experiment_id || null,
      analysis_id: opts.analysis_id,
      analysis_title: opts.analysis_title || '',
      week_id: opts.week_id || '',
      created_at: isoNow(),
    });
  }

  async function clearClaim(uid, analysisId) {
    uid = uid || me();
    if (!uid || !analysisId) return;
    try { await claimsColl().doc(claimIdFor(uid, analysisId)).delete(); }
    catch (e) { console.warn('[roadmap-data] clearClaim failed:', e && e.message); }
  }

  /* ── exports ────────────────────────────────────────────────── */

  window.ROADMAP_DATA = {
    STATUS_META: STATUS_META,
    STATUS_ORDER: STATUS_ORDER,
    FIGURE_KINDS: FIGURE_KINDS,
    FIGURE_STATUS: FIGURE_STATUS,
    RELEVANCE: RELEVANCE,

    esc: esc,
    newId: newId,
    isAdmin: isAdmin,

    hydrate: hydrate,
    hydrateAnalysis: hydrateAnalysis,
    hydrateExperiment: hydrateExperiment,
    isEmpty: isEmpty,
    flattenAnalyses: flattenAnalyses,
    progressOf: progressOf,
    attachTargets: attachTargets,

    // figure board (V3.605) + analysis→figure pointers (V3.606)
    hydrateBoardFigure: hydrateBoardFigure,
    hydratePanel: hydratePanel,
    panelLetter: panelLetter,
    imageUrl: imageUrl,
    boardFigures: boardFigures,
    resolveFigureRef: resolveFigureRef,
    figureRefTargets: figureRefTargets,
    analysesForFigure: analysesForFigure,
    figureProgressOf: figureProgressOf,

    listRoadmapCards: listRoadmapCards,
    saveRoadmap: saveRoadmap,

    refIdFor: refIdFor,
    listRefs: listRefs,
    addRef: addRef,
    updateRef: updateRef,
    removeRef: removeRef,
    listRefsForItem: listRefsForItem,

    listClaims: listClaims,
    setClaim: setClaim,
    clearClaim: clearClaim,
  };
})();
