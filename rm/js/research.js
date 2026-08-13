/* research.js — V3.544+ (Research Foci program): the hub renderer.
 *
 * rm/pages/research.html. Two views off one page:
 *   • Hub (default) — the lab's research map as three bands: a specialty
 *     chip strip, a concept grid, and an outputs rail. A student sees the
 *     whole map read-only with their own foci highlighted; the PI (admin)
 *     gets "＋ New card" and inline edit affordances.
 *   • Detail (?id=<fociId>) — one card in full: media gallery, description,
 *     what it combines (cross-level pills), outputs/drafts with derived
 *     status, linked theme, trainings, aligned people, per-thrust progress
 *     (admin/mentor), and (admin) publish controls.
 *
 * Data: window.RESEARCH_DATA. Authoring modals live in research-composer.js
 * (guided templates), research-links.js (attachments), research-create.js
 * (spawn paper / grant idea), research-media.js (upload + render). This file
 * owns layout, routing, and event delegation only.
 */
(function () {
  'use strict';

  var RD = window.RESEARCH_DATA;
  var esc = RD ? RD.esc : function (s) { return String(s == null ? '' : s); };

  var root;
  var state = {
    me: null,
    isAdmin: false,
    foci: [],           // all, hydrated + sorted
    byId: {},
    viewId: null,       // ?id → detail; else hub
    expanded: null,     // hub: concept id whose inline details are open
  };

  function toast(kind, msg) { if (window.TOAST && TOAST[kind]) TOAST[kind](msg); }
  function byId(id) { return state.byId[id] || null; }
  function fociUrl(id) { return '/rm/pages/research.html?id=' + encodeURIComponent(id); }
  function onThisFocus(f) { return state.me && f.member_uids.indexOf(state.me.uid) !== -1; }

  function indexFoci() {
    state.byId = {};
    state.foci.forEach(function (f) { state.byId[f.id] = f; });
  }

  async function loadAll() {
    state.foci = await RD.listAll();
    // Draft-backed output cards derive title/status from the real record.
    // Force-fresh the draft roster first: a paper deleted via the
    // deleteBuilderPaper Cloud Function bumps no updatedAt, so the cached
    // projects/papers.json would otherwise keep resolving a gone paper.
    if (window.api && api.invalidate) { try { await api.invalidate('projects/papers.json'); } catch (e) {} }
    if (window.LIBRARY_ASSOC && LIBRARY_ASSOC.invalidate) { try { LIBRARY_ASSOC.invalidate(); } catch (e) {} }
    if (window.LIBRARY_ASSOC && LIBRARY_ASSOC.loadDraftInfo) {
      try { await LIBRARY_ASSOC.loadDraftInfo(); } catch (e) {}
    }
    await pruneOrphanCards();
    indexFoci();
  }

  /* A draft-backed output card whose source paper/grant was deleted is an
   * orphan — its whole identity is gone. After the resolver is loaded, a
   * source_draft_id that resolves to kind 'unknown' means the record no
   * longer exists. Admins delete the dead card; everyone filters it from
   * view so the map never shows a paper that 404s on click. */
  function isOrphan(f) {
    if (f.level !== 'output' || !f.source_draft_id) return false;
    if (!(window.LIBRARY_ASSOC && LIBRARY_ASSOC.resolve)) return false;
    var d = LIBRARY_ASSOC.resolve(f.source_draft_id);
    return !d || d.kind === 'unknown';
  }
  async function pruneOrphanCards() {
    var orphans = state.foci.filter(isOrphan);
    if (!orphans.length) return;
    if (state.isAdmin) {
      for (var i = 0; i < orphans.length; i++) {
        try { await RD.remove(orphans[i].id); } catch (e) {}
      }
    }
    var dead = {}; orphans.forEach(function (o) { dead[o.id] = 1; });
    state.foci = state.foci.filter(function (f) { return !dead[f.id]; });
  }

  /* Draft-backed output cards (source_draft_id set) present the live paper/
   * grant title + status; authored cards use their own stored fields. */
  function draftInfo(f) {
    return (f && f.source_draft_id && window.LIBRARY_ASSOC && LIBRARY_ASSOC.resolve)
      ? LIBRARY_ASSOC.resolve(f.source_draft_id) : null;
  }
  function titleOf(f) { var d = draftInfo(f); return (d && d.title) || f.title || '(untitled)'; }
  function effStatus(f) { var d = draftInfo(f); return (d && d.status) || f.status; }

  /* ── status pill ────────────────────────────────────────────── */
  function statusPill(f) {
    var s = effStatus(f);
    var m = RD.STATUS_META[s] || { label: s, color: '#374151', bg: '#e5e7eb' };
    return '<span class="rf-status" style="color:' + m.color + ';background:' + m.bg + '">' + esc(m.label) + '</span>';
  }
  function iconFor(f) { return f.icon || RD.LEVELS[f.level].icon; }
  // Render an icon value as safe HTML — emoji as text, a custom-upload URL
  // as an <img> — via the shared ICON_PICKER (falls back to escaped text).
  function iconHtml(f, size) {
    var v = iconFor(f);
    return window.ICON_PICKER ? ICON_PICKER.html(v, { size: size || '1.1em' }) : esc(v);
  }

  /* ── HUB ────────────────────────────────────────────────────── */

  function render() {
    if (!root) return;
    if (state.viewId) { renderDetail(byId(state.viewId)); return; }
    renderHub();
  }

  function renderHub() {
    var mine = state.foci.filter(onThisFocus);
    var bands = RD.LEVEL_ORDER.map(function (lvl) {
      return renderBand(lvl, state.foci.filter(function (f) { return f.level === lvl; }));
    }).join('');

    root.innerHTML =
      '<div class="rf-hub">' +
        '<header class="rf-hub-head">' +
          '<p class="rf-hub-intro">The lab’s research map — the capabilities that make us unique, the concepts they combine into, and what we’re building from them.</p>' +
          (state.isAdmin
            ? '<div class="rf-toolbar">' +
                (!state.foci.length ? '<button class="rf-btn rf-btn-primary" data-act="seed">✨ Seed the 6 lab specialties</button>' : '') +
                '<button class="rf-btn" data-act="add-existing">⤵ Add existing paper</button>' +
              '</div>'
            : '') +
        '</header>' +
        (mine.length
          ? '<div class="rf-mine"><span class="rf-mine-label">Your foci</span>' +
              mine.map(function (f) { return '<a class="rf-mine-chip" href="' + fociUrl(f.id) + '">' + iconHtml(f) + ' ' + esc(titleOf(f)) + '</a>'; }).join('') +
            '</div>'
          : '') +
        // V3.603 — the student band: what we're driving toward, what's
        // unclaimed, who's on what. Filled async (one roadmapClaims get);
        // an empty host collapses to nothing.
        '<div data-roadmap-band></div>' +
        bands +
      '</div>';

    if (window.RESEARCH_ROADMAP) {
      RESEARCH_ROADMAP.renderHubBand(root.querySelector('[data-roadmap-band]'), state);
    }
  }

  function renderBand(level, list) {
    var meta = RD.LEVELS[level];
    var addBtn = state.isAdmin
      ? '<button class="rf-btn rf-btn-ghost" data-act="new" data-level="' + level + '">＋ Add</button>'
      : '';
    var body;
    if (!list.length) {
      body = '<div class="rf-band-empty">Nothing here yet.' +
             (state.isAdmin ? ' <button class="rf-link" data-act="new" data-level="' + level + '">Add the first →</button>' : '') + '</div>';
    } else if (level === 'specialty') {
      body = '<div class="rf-specialty-strip">' + list.map(specialtyChip).join('') + '</div>';
    } else if (level === 'concept') {
      // Clicking a concept card expands its details INLINE (outputs, grant,
      // description) — the expansion row spans the full grid width and sits
      // right after the clicked card.
      body = '<div class="rf-concept-grid">' + list.map(function (f) {
        return conceptCard(f) + (state.expanded === f.id ? conceptExpand(f) : '');
      }).join('') + '</div>';
    } else {
      body = '<div class="rf-output-rail">' + list.map(outputCard).join('') + '</div>';
    }
    return '<section class="rf-band rf-band-' + level + '">' +
             '<div class="rf-band-head">' +
               '<div><h2 class="rf-band-title">' + esc(meta.plural) +
                 (list.length ? ' <span class="rf-band-count">' + list.length + '</span>' : '') + '</h2>' +
                 '<p class="rf-band-sub">' + esc(meta.blurb) + '</p></div>' +
               addBtn +
             '</div>' +
             body +
           '</section>';
  }

  function mineRing(f) { return onThisFocus(f) ? ' rf-card-mine' : ''; }

  function specialtyChip(f) {
    return '<a class="rf-chip' + mineRing(f) + '" href="' + fociUrl(f.id) + '"' +
             (f.color ? ' style="--rf-accent:' + esc(f.color) + '"' : '') + '>' +
             '<span class="rf-icon-tile">' + iconHtml(f, '22px') + '</span>' +
             '<span class="rf-chip-text"><strong>' + esc(f.abbr || titleOf(f)) + '</strong>' +
               (f.abbr ? '<span class="rf-chip-sub">' + esc(titleOf(f)) + '</span>' : '') +
             '</span>' +
           '</a>';
  }

  function specialtyPillsFor(f) {
    // The specialties a concept/output combines — small linked chips.
    var ids = (f.links.specialty_ids || []).concat(f.level === 'output' ? (f.links.concept_ids || []) : []);
    if (!ids.length) return '';
    return '<div class="rf-combine">' + ids.map(function (id) {
      var t = byId(id);
      return t ? '<a class="rf-combine-pill" href="' + fociUrl(t.id) + '">' + iconHtml(t) + ' ' + esc(t.abbr || titleOf(t)) + '</a>' : '';
    }).join('') + '</div>';
  }

  function coverThumb(f) {
    var img = (f.media || []).filter(function (m) { return m.kind === 'image' && m.variants; })[0];
    var src = img && img.variants ? (img.variants.medium || img.variants.full || img.variants.thumb) : '';
    // No image → a quiet accent-tinted panel so the grid stays uniform.
    return src
      ? '<div class="rf-card-cover"><img loading="lazy" src="' + esc(src) + '" alt=""></div>'
      : '<div class="rf-card-cover rf-cover-ph"><span>' + iconHtml(f, '34px') + '</span></div>';
  }

  function conceptCard(f) {
    var open = state.expanded === f.id;
    var grantChip = conceptHasGrant(f)
      ? '<span class="rf-grant-chip" title="This concept has a grant">📑 grant</span>' : '';
    return '<div class="rf-concept-card' + mineRing(f) + (open ? ' rf-open' : '') + '" role="button" tabindex="0" ' +
             'data-expand="' + esc(f.id) + '" aria-expanded="' + open + '"' +
             (f.color ? ' style="--rf-accent:' + esc(f.color) + '"' : '') + '>' +
             coverThumb(f) +
             '<div class="rf-card-body">' +
               '<div class="rf-card-head"><span class="rf-icon-tile rf-icon-tile-sm">' + iconHtml(f, '18px') + '</span>' +
                 '<h3 class="rf-clamp2">' + esc(titleOf(f)) + '</h3>' +
                 '<span class="rf-chevron">' + (open ? '▴' : '▾') + '</span></div>' +
               (f.one_liner ? '<p class="rf-card-liner rf-clamp2">' + esc(f.one_liner) + '</p>' : '') +
               '<div class="rf-card-foot">' + specialtyPillsFor(f) + grantChip + '</div>' +
             '</div>' +
           '</div>';
  }

  /* Inline expansion under a concept card: description, grant summary, the
   * outputs that build on it, and the door to the full detail page. */
  function conceptExpand(f) {
    var outs = state.foci.filter(function (x) {
      return x.level === 'output' && ((x.links && x.links.concept_ids) || []).indexOf(f.id) !== -1;
    });
    var outHtml = outs.length
      ? '<div class="rf-combine">' + outs.map(function (o) {
          return '<a class="rf-combine-pill" href="' + fociUrl(o.id) + '">' + iconHtml(o) + ' ' + esc(titleOf(o)) + ' ' + statusPill(o) + '</a>';
        }).join('') + '</div>'
      : '<p class="rf-empty-sm">No papers or patents under this concept yet.</p>';
    var grantRefs = conceptGrantRefs(f);
    var gm = f.grant_meta;
    var grantHtml = '';
    if (grantRefs.length) {
      grantHtml = grantRefs.map(function (r) {
        return '<a class="rf-combine-pill" href="/rm/pages/paper-builder.html?paper=' + encodeURIComponent(r.id) + '">📑 ' + esc(r.title || r.id) + '</a>';
      }).join(' ');
    } else if (gm && (gm.agency || gm.submit_to)) {
      grantHtml = '<span class="rf-empty-sm">💡 ' + esc(gm.agency || '') + (gm.mechanism ? ' ' + esc(gm.mechanism) : '') +
        (gm.target_deadline && gm.target_deadline !== 'TBD' ? ' · due ' + esc(gm.target_deadline) : '') + '</span>';
    }
    var desc = f.description_html
      ? '<div class="rf-richtext rf-expand-desc">' + RD.sanitizeHtml(f.description_html) + '</div>' : '';
    return '<div class="rf-concept-expand"' + (f.color ? ' style="--rf-accent:' + esc(f.color) + '"' : '') + '>' +
      desc +
      '<div class="rf-expand-cols">' +
        '<div><h4>Outputs</h4>' + outHtml + '</div>' +
        (grantHtml ? '<div><h4>Grant</h4>' + grantHtml + '</div>' : '') +
      '</div>' +
      '<div class="rf-expand-foot"><a class="rf-btn rf-btn-sm" href="' + fociUrl(f.id) + '">Open full page →</a></div>' +
    '</div>';
  }

  function outputCard(f) {
    // Outputs are papers + patents (V3.558 — grants live within concepts).
    return '<a class="rf-output-card' + mineRing(f) + '" href="' + fociUrl(f.id) + '"' +
             (f.color ? ' style="--rf-accent:' + esc(f.color) + '"' : '') + '>' +
             '<div class="rf-output-top">' +
               '<span class="rf-icon-tile rf-icon-tile-sm">' + iconHtml(f, '18px') + '</span>' +
               statusPill(f) +
             '</div>' +
             '<h3 class="rf-clamp2">' + esc(titleOf(f)) + '</h3>' +
             (f.one_liner ? '<p class="rf-card-liner rf-clamp2">' + esc(f.one_liner) + '</p>' : '') +
             '<div class="rf-card-foot">' + specialtyPillsFor(f) + '</div>' +
           '</a>';
  }

  /* ── DETAIL ─────────────────────────────────────────────────── */

  function renderDetail(f) {
    if (!f) {
      root.innerHTML = '<div class="rf-detail"><a class="rf-back" href="/rm/pages/research.html">← Research</a>' +
        '<p class="rf-band-empty">That focus was not found.</p></div>';
      return;
    }
    var meta = RD.LEVELS[f.level];
    var canEdit = state.isAdmin;

    root.innerHTML =
      '<div class="rf-detail" data-foci="' + esc(f.id) + '">' +
        '<nav class="rf-crumbs"><a href="/rm/pages/research.html">Research map</a>' +
          '<span class="rf-crumb-sep">/</span><span>' + esc(meta.plural) + '</span></nav>' +
        '<header class="rf-detail-head"' + (f.color ? ' style="--rf-accent:' + esc(f.color) + '"' : '') + '>' +
          '<div class="rf-detail-title">' +
            '<span class="rf-icon-tile rf-icon-tile-lg">' + iconHtml(f, '30px') + '</span>' +
            '<div>' +
              '<span class="rf-detail-level">' + esc(meta.label) + '</span>' +
              '<h1>' + esc(titleOf(f)) + (f.abbr ? ' <span class="rf-detail-abbr">' + esc(f.abbr) + '</span>' : '') + '</h1>' +
              (f.one_liner ? '<p class="rf-detail-liner">' + esc(f.one_liner) + '</p>' : '') +
            '</div>' +
          '</div>' +
          '<div class="rf-detail-meta">' + statusPill(f) +
            (canEdit ? '<button class="rf-btn" data-act="edit">✎ Edit</button>' +
              // Output cards REMOVE from the map (the paper/grant record
              // itself is untouched — true deletion lives on the Outputs
              // page); specialty/concept cards delete outright.
              (f.level === 'output'
                ? '<button class="rf-btn rf-btn-danger" data-act="remove-card">✕ Remove from map</button>'
                : '<button class="rf-btn rf-btn-danger" data-act="delete">Delete</button>') : '') +
          '</div>' +
        '</header>' +
        '<div class="rf-detail-grid">' +
          '<div class="rf-detail-main">' +
            sectionMedia(f, canEdit) +
            sectionDescription(f) +
            sectionRoadmap(f, canEdit) +
            sectionOverview(f, canEdit) +
          '</div>' +
          '<aside class="rf-detail-side">' +
            sectionCombine(f, canEdit) +
            (f.level === 'concept' ? sectionGrant(f, canEdit) : '') +
            (f.level === 'output' ? sectionOutputs(f, canEdit) : sectionChildOutputs(f, canEdit)) +
            sectionTheme(f, canEdit) +
            sectionTrainings(f, canEdit) +
            sectionPeople(f, canEdit) +
          '</aside>' +
        '</div>' +
        '<div class="rf-detail-progress" data-progress></div>' +
      '</div>';

    // Media gallery (async — resolves storage URLs).
    if (window.RESEARCH_MEDIA) {
      var mc = root.querySelector('[data-media-gallery]');
      if (mc) RESEARCH_MEDIA.renderGallery(mc, f, { editable: canEdit });
    }
    // Per-thrust progress (async, cross-user reads; admin/mentor only).
    renderProgress(f);
    // Roadmap reference papers + claim chips (async, own subcollection).
    if (window.RESEARCH_ROADMAP) {
      RESEARCH_ROADMAP.hydrateSection(root, f, state);
    }
  }

  /* V3.600 — the experiment → analysis → figure roadmap. Output cards
   * only: a specialty is a capability and a concept is an idea, neither
   * of which "ships" and so neither has experiments to run. */
  function sectionRoadmap(f, canEdit) {
    if (f.level !== 'output' || !window.RESEARCH_ROADMAP) return '';
    return RESEARCH_ROADMAP.renderSection(f, canEdit);
  }

  function sectionMedia(f, canEdit) {
    return '<section class="rf-sec rf-sec-media">' +
      '<div class="rf-sec-head"><h2>Media</h2>' +
        (canEdit ? '<button class="rf-btn rf-btn-sm" data-act="add-media">＋ Add image / video / HTML</button>' : '') +
      '</div>' +
      '<div data-media-gallery>' + ((f.media || []).length ? '' : '<p class="rf-empty-sm">No media yet.</p>') + '</div>' +
    '</section>';
  }

  function sectionDescription(f) {
    var html = f.description_html ? RD.sanitizeHtml(f.description_html) : '';
    return '<section class="rf-sec rf-sec-desc">' +
      '<h2>Description</h2>' +
      (html ? '<div class="rf-richtext">' + html + '</div>'
            : '<p class="rf-empty-sm">' + (state.isAdmin ? 'Use ✎ Edit card to write the description with the guided template.' : 'No description yet.') + '</p>') +
    '</section>';
  }

  function sectionOverview(f, canEdit) {
    var pubBadge = f.published ? '<span class="rf-pub-badge">● Published</span>' : '<span class="rf-pub-badge rf-pub-off">Draft</span>';
    var body;
    if ((f.overview_blocks || []).length) {
      body = '<div class="rf-overview-preview">' +
        f.overview_blocks.map(function (b) {
          return window.RESEARCH_MEDIA ? RESEARCH_MEDIA.renderOverviewBlock(b, f) : '';
        }).join('') + '</div>';
    } else {
      body = '<p class="rf-empty-sm">No public overview yet.' + (canEdit ? ' Build one to publish this focus to the lab website.' : '') + '</p>';
    }
    return '<section class="rf-sec rf-sec-overview">' +
      '<div class="rf-sec-head"><h2>Public overview ' + pubBadge + '</h2>' +
        (canEdit ? '<span class="rf-sec-actions">' +
          '<button class="rf-btn rf-btn-sm" data-act="edit-overview">✎ Build overview</button>' +
          (f.overview_blocks && f.overview_blocks.length
            ? '<button class="rf-btn rf-btn-sm ' + (f.published ? 'rf-btn-danger' : 'rf-btn-primary') + '" data-act="' + (f.published ? 'unpublish' : 'publish') + '">' +
                (f.published ? 'Unpublish' : 'Publish to site') + '</button>'
            : '') +
        '</span>' : '') +
      '</div>' + body +
    '</section>';
  }

  function sectionCombine(f, canEdit) {
    if (f.level === 'specialty') {
      // Show concepts/outputs that build ON this specialty (reverse links).
      var users = state.foci.filter(function (x) {
        return (x.links.specialty_ids || []).indexOf(f.id) !== -1;
      });
      if (!users.length && !canEdit) return '';
      return '<section class="rf-sec"><h2>Used in</h2>' +
        (users.length ? '<div class="rf-combine">' + users.map(function (t) {
          return '<a class="rf-combine-pill" href="' + fociUrl(t.id) + '">' + iconHtml(t) + ' ' + esc(titleOf(t)) + '</a>';
        }).join('') + '</div>' : '<p class="rf-empty-sm">Not linked from any concept or output yet.</p>') +
      '</section>';
    }
    var ids = (f.links.specialty_ids || []).concat(f.links.concept_ids || []);
    return '<section class="rf-sec"><div class="rf-sec-head"><h2>Combines</h2>' +
      (canEdit ? '<button class="rf-btn rf-btn-sm" data-act="edit-links" data-part="combine">✎</button>' : '') + '</div>' +
      (ids.length ? '<div class="rf-combine">' + ids.map(function (id) {
        var t = byId(id); return t ? '<a class="rf-combine-pill" href="' + fociUrl(t.id) + '">' + iconHtml(t) + ' ' + esc(titleOf(t)) + '</a>' : '';
      }).join('') + '</div>' : '<p class="rf-empty-sm">No specialties/concepts linked yet.</p>') +
    '</section>';
  }

  /* V3.558 — grants live WITHIN concepts (outputs are papers/patents).
   * A concept's grant = its grant_meta (the idea: agency, mechanism, where
   * to submit, deadline, scope) and/or linked grant drafts (draft_refs with
   * kind 'grant', status derived live). Soft rule: one grant per concept —
   * the handlers warn before adding a second. */
  function conceptGrantRefs(f) {
    return ((f.links && f.links.draft_refs) || []).filter(function (r) { return r.kind === 'grant'; });
  }
  function conceptHasGrant(f) {
    var gm = f.grant_meta;
    return conceptGrantRefs(f).length > 0 ||
      !!(gm && (gm.agency || gm.scope_html || gm.submit_to || gm.promoted_draft_id));
  }

  function sectionGrant(f, canEdit) {
    var gm = f.grant_meta;
    var refs = conceptGrantRefs(f);
    if (!gm && !refs.length && !canEdit) return '';
    var head = '<div class="rf-sec-head"><h2>Grant</h2>' +
      (canEdit ? '<span class="rf-sec-actions">' +
        '<button class="rf-btn rf-btn-sm" data-act="grant-idea">💡 ' + (gm ? 'Edit idea' : 'Grant idea') + '</button>' +
        '<button class="rf-btn rf-btn-sm" data-act="grant-link">⤵ Link grant</button>' +
      '</span>' : '') + '</div>';
    var pills = refs.map(function (r) {
      return '<span class="rf-draft-pill" data-kind="grant">' +
        '<a href="/rm/pages/paper-builder.html?paper=' + encodeURIComponent(r.id) + '">📑 ' + esc(r.title || r.id) + '</a>' +
        '<span class="rf-draft-status" data-status-for="' + esc(r.id) + '">…</span></span>';
    }).join('');
    var ideaBlock = '';
    if (gm && (gm.agency || gm.scope_html || gm.submit_to)) {
      ideaBlock = '<div class="rf-grant-meta">' +
        (gm.agency ? '<div><strong>Agency:</strong> ' + esc(gm.agency) + (gm.mechanism ? ' · ' + esc(gm.mechanism) : '') + '</div>' : '') +
        (gm.submit_to ? '<div><strong>Submit to:</strong> ' + (gm.submission_url ? '<a href="' + esc(gm.submission_url) + '" target="_blank" rel="noopener">' + esc(gm.submit_to) + '</a>' : esc(gm.submit_to)) + '</div>' : '') +
        (gm.target_deadline && gm.target_deadline !== 'TBD' ? '<div><strong>Target deadline:</strong> ' + esc(gm.target_deadline) + '</div>' : '') +
        (gm.scope_html ? '<div class="rf-richtext">' + RD.sanitizeHtml(gm.scope_html) + '</div>' : '') +
        (canEdit && !gm.promoted_draft_id && !refs.length
          ? '<button class="rf-btn rf-btn-sm rf-btn-primary" data-act="promote-grant">Promote to grant draft →</button>' : '') +
      '</div>';
    }
    var body = (pills || ideaBlock)
      ? pills + ideaBlock
      : '<p class="rf-empty-sm">No grant yet — capture the idea (💡) or link an existing grant draft.</p>';
    return '<section class="rf-sec rf-sec-grant">' + head + body + '</section>';
  }

  // For concept + specialty cards: the outputs (grants/papers/patents) that
  // build on this. Derived by scanning output cards whose concept_ids /
  // specialty_ids include this card. Admin can link existing outputs with a
  // checkbox each, or spawn a new output pre-linked back to this card.
  function sectionChildOutputs(f, canEdit) {
    var key = f.level === 'specialty' ? 'specialty_ids' : 'concept_ids';
    var outs = state.foci.filter(function (x) {
      return x.level === 'output' && ((x.links && x.links[key]) || []).indexOf(f.id) !== -1;
    });
    var head = '<div class="rf-sec-head"><h2>Outputs</h2>' +
      (canEdit ? '<span class="rf-sec-actions">' +
        '<button class="rf-btn rf-btn-sm" data-act="link-outputs">✎ Link</button>' +
        '<button class="rf-btn rf-btn-sm rf-btn-primary" data-act="new-output">＋ New</button>' +
      '</span>' : '') + '</div>';
    var body = outs.length
      ? '<div class="rf-combine">' + outs.map(function (o) {
          return '<a class="rf-combine-pill" href="' + fociUrl(o.id) + '">' + iconHtml(o) + ' ' + esc(titleOf(o)) + ' ' + statusPill(o) + '</a>';
        }).join('') + '</div>'
      : '<p class="rf-empty-sm">No grants, papers, or patents linked to this yet.' + (canEdit ? ' Link an existing output or make a new one.' : '') + '</p>';
    return '<section class="rf-sec rf-sec-children">' + head + body + '</section>';
  }

  function sectionOutputs(f, canEdit) {
    var refs = f.links.draft_refs || [];
    var patents = f.links.patents || [];
    var head = '<div class="rf-sec-head"><h2>Outputs &amp; drafts</h2>' +
      (canEdit ? '<span class="rf-sec-actions">' +
        '<button class="rf-btn rf-btn-sm" data-act="new-paper">＋ Paper</button>' +
        '<button class="rf-btn rf-btn-sm" data-act="edit-links" data-part="drafts">✎ Link</button>' +
      '</span>' : '') + '</div>';
    var body = '<div data-draft-pills>' +
      (refs.length ? refs.map(function (r) {
        return '<span class="rf-draft-pill" data-kind="' + esc(r.kind || 'paper') + '">' +
          '<a href="/rm/pages/paper-builder.html?paper=' + encodeURIComponent(r.id) + '">' +
          (r.kind === 'grant' ? '📑 ' : '📝 ') + esc(r.title || r.id) + '</a>' +
          '<span class="rf-draft-status" data-status-for="' + esc(r.id) + '">…</span></span>';
      }).join('') : '') +
      patents.map(function (p) {
        return '<span class="rf-draft-pill" data-kind="patent">⚖️ ' + esc(p.title || p.number || 'Patent') +
          (p.status ? ' <span class="rf-draft-status">' + esc(p.status) + '</span>' : '') + '</span>';
      }).join('') +
      (!refs.length && !patents.length ? '<p class="rf-empty-sm">No linked papers, grants, or patents yet.</p>' : '') +
    '</div>';
    // grant-idea specifics
    var gm = f.grant_meta;
    var ideaBlock = '';
    if (gm && (gm.agency || gm.scope_html || gm.submit_to)) {
      ideaBlock = '<div class="rf-grant-meta">' +
        (gm.agency ? '<div><strong>Agency:</strong> ' + esc(gm.agency) + (gm.mechanism ? ' · ' + esc(gm.mechanism) : '') + '</div>' : '') +
        (gm.submit_to ? '<div><strong>Submit to:</strong> ' + (gm.submission_url ? '<a href="' + esc(gm.submission_url) + '" target="_blank" rel="noopener">' + esc(gm.submit_to) + '</a>' : esc(gm.submit_to)) + '</div>' : '') +
        (gm.target_deadline && gm.target_deadline !== 'TBD' ? '<div><strong>Target deadline:</strong> ' + esc(gm.target_deadline) + '</div>' : '') +
        (gm.scope_html ? '<div class="rf-richtext">' + RD.sanitizeHtml(gm.scope_html) + '</div>' : '') +
        (canEdit && !gm.promoted_draft_id ? '<button class="rf-btn rf-btn-sm rf-btn-primary" data-act="promote-grant">Promote to grant draft →</button>' : '') +
      '</div>';
    }
    return '<section class="rf-sec rf-sec-outputs">' + head + body + ideaBlock + '</section>';
  }

  function sectionTheme(f, canEdit) {
    if (!f.links.theme_id && !canEdit) return '';
    return '<section class="rf-sec"><div class="rf-sec-head"><h2>Literature theme</h2>' +
      (canEdit ? '<button class="rf-btn rf-btn-sm" data-act="edit-links" data-part="theme">✎</button>' : '') + '</div>' +
      (f.links.theme_id
        ? '<a class="rf-theme-link" href="/rm/pages/library.html?tab=themes">📚 ' + esc(f.links.theme_id) + ' →</a>'
        : '<p class="rf-empty-sm">No linked Lab Theme.</p>') +
    '</section>';
  }

  function sectionTrainings(f, canEdit) {
    var slugs = f.links.training_slugs || [];
    if (!slugs.length && !canEdit) return '';
    return '<section class="rf-sec"><div class="rf-sec-head"><h2>Trainings</h2>' +
      (canEdit ? '<button class="rf-btn rf-btn-sm" data-act="edit-links" data-part="trainings">✎</button>' : '') + '</div>' +
      (slugs.length ? '<div class="rf-combine">' + slugs.map(function (s) {
        return '<a class="rf-combine-pill" href="/rm/pages/training-' + esc(s) + '.html">🎓 ' + esc(s) + '</a>';
      }).join('') + '</div>' : '<p class="rf-empty-sm">No linked trainings.</p>') +
    '</section>';
  }

  function sectionPeople(f, canEdit) {
    var uids = f.member_uids || [];
    return '<section class="rf-sec rf-sec-people"><div class="rf-sec-head"><h2>Aligned people</h2>' +
      (canEdit ? '<button class="rf-btn rf-btn-sm" data-act="edit-links" data-part="people">✎</button>' : '') + '</div>' +
      (uids.length ? '<div data-people-list class="rf-people">' + uids.map(function (uid) {
        var role = f.member_roles[uid];
        return '<span class="rf-person" data-uid="' + esc(uid) + '">' + esc(uid) + (role ? ' <em>' + esc(role) + '</em>' : '') + '</span>';
      }).join('') + '</div>' : '<p class="rf-empty-sm">No students attached yet.</p>') +
    '</section>';
  }

  /* Resolve names for the people list + draft statuses after render. */
  async function hydrateSidebar(f) {
    // Draft statuses via LIBRARY_ASSOC resolver (populate cache first,
    // then resolve() synchronously per ref).
    if (window.LIBRARY_ASSOC && (f.links.draft_refs || []).length) {
      try {
        if (LIBRARY_ASSOC.loadDraftInfo) await LIBRARY_ASSOC.loadDraftInfo();
        (f.links.draft_refs).forEach(function (r) {
          var info = LIBRARY_ASSOC.resolve ? LIBRARY_ASSOC.resolve(r.id) : null;
          var el = root.querySelector('[data-status-for="' + CSS.escape(r.id) + '"]');
          if (el) el.textContent = info && info.status ? info.status : (r.kind || '');
        });
      } catch (e) {}
    }
    // People names from world-readable users/{uid}.
    var people = root.querySelectorAll('[data-people-list] .rf-person');
    people.forEach(async function (el) {
      var uid = el.getAttribute('data-uid');
      try {
        var doc = await firebridge.db().collection('users').doc(uid).get();
        var name = (doc.exists && (doc.data().name || doc.data().displayName)) || uid;
        var role = f.member_roles[uid];
        el.innerHTML = esc(name) + (role ? ' <em>' + esc(role) + '</em>' : '');
      } catch (e) {}
    });
  }

  /* ── per-thrust progress (V3.551) ───────────────────────────── */
  async function renderProgress(f) {
    var host = root.querySelector('[data-progress]');
    if (!host || !window.RESEARCH_PROGRESS) return;
    try {
      await RESEARCH_PROGRESS.render(host, f, state);
    } catch (e) { console.warn('[research] progress failed:', e && e.message); }
  }

  /* ── events ─────────────────────────────────────────────────── */

  function onClick(e) {
    // Concept-card inline expansion: toggle unless an inner link/button was
    // the real target (pills etc. keep navigating).
    var card = e.target.closest('[data-expand]');
    if (card && !e.target.closest('a') && !e.target.closest('[data-act]')) {
      var id = card.getAttribute('data-expand');
      state.expanded = state.expanded === id ? null : id;
      render();
      if (state.expanded) {
        var opened = root.querySelector('[data-expand="' + CSS.escape(id) + '"]');
        if (opened) opened.scrollIntoView({ block: 'nearest', behavior: 'smooth' });
      }
      return;
    }
    var t = e.target.closest('[data-act]');
    if (!t) return;
    var act = t.getAttribute('data-act');
    var detail = state.viewId ? byId(state.viewId) : null;

    if (act === 'new') {
      e.preventDefault();
      if (window.RESEARCH_COMPOSER) RESEARCH_COMPOSER.openCreate(t.getAttribute('data-level'), afterMutation);
      return;
    }
    if (act === 'seed') { seedSpecialties(t); return; }
    // V3.603 — student band: claim an open analysis for this week. Hub
    // view only, so it sits above the `if (!detail) return` gate.
    if (act === 'roadmap-claim') {
      if (window.RESEARCH_ROADMAP) {
        RESEARCH_ROADMAP.claimAnalysis(t, state).then(function (okd) { if (okd) render(); });
      }
      return;
    }
    if (act === 'add-existing') {
      // Each checked paper/grant becomes its own draft-backed output card —
      // nothing to type.
      if (window.RESEARCH_LINKS) RESEARCH_LINKS.openOutputLinker(null, state.foci, afterMutation);
      return;
    }
    if (!detail) return;
    // V3.558 — grants live within concepts. 💡 edits the concept's own
    // grant_meta; ⤵ links an existing grant draft onto the concept. Soft
    // rule: one grant per concept — warn (never block) on a second.
    if (act === 'grant-idea') {
      if (!window.RESEARCH_CREATE) return;
      if (!detail.grant_meta && conceptHasGrant(detail) &&
          !confirm('"' + titleOf(detail) + '" already has a grant.\n\nOne grant per concept is the rule — add a second only as a special case. Continue?')) return;
      RESEARCH_CREATE.openGrantIdea(detail, afterMutation);
      return;
    }
    if (act === 'grant-link') {
      if (!window.RESEARCH_LINKS) return;
      if (conceptHasGrant(detail) &&
          !confirm('"' + titleOf(detail) + '" already has a grant.\n\nOne grant per concept is the rule — link a second only as a special case. Continue?')) return;
      RESEARCH_LINKS.openGrantLinker(detail, afterMutation);
      return;
    }
    if (act === 'edit') { if (window.RESEARCH_COMPOSER) RESEARCH_COMPOSER.openEdit(detail, afterMutation); return; }
    if (act === 'edit-overview') { if (window.RESEARCH_COMPOSER) RESEARCH_COMPOSER.openOverview(detail, afterMutation); return; }
    if (act === 'add-media') { if (window.RESEARCH_MEDIA) RESEARCH_MEDIA.openUploader(detail, afterMutation); return; }
    if (act === 'edit-links') { if (window.RESEARCH_LINKS) RESEARCH_LINKS.openEditor(detail, state.foci, t.getAttribute('data-part'), afterMutation); return; }
    if (act === 'new-paper') { if (window.RESEARCH_CREATE) RESEARCH_CREATE.openPaper(detail, afterMutation); return; }
    if (act === 'link-outputs') { if (window.RESEARCH_LINKS) RESEARCH_LINKS.openOutputLinker(detail, state.foci, afterMutation); return; }
    if (act === 'new-output') {
      if (window.RESEARCH_COMPOSER) {
        // Pre-link the new output back to this concept/specialty so it
        // auto-propagates the moment it's created.
        var key = detail.level === 'specialty' ? 'specialty_ids' : 'concept_ids';
        var seedLinks = {}; seedLinks[key] = [detail.id];
        RESEARCH_COMPOSER.openCreate('output', afterMutation, { links: seedLinks });
      }
      return;
    }
    if (act === 'edit-roadmap') { if (window.RESEARCH_ROADMAP) RESEARCH_ROADMAP.openEditor(detail, afterMutation); return; }
    // V3.601 — roadmap reference papers. These write to the card's refs
    // SUBcollection (lab-member writable), not the admin-only card doc,
    // so they re-hydrate the section rather than reloading the whole map.
    if (act === 'roadmap-add-ref' || act === 'roadmap-ref-edit' || act === 'roadmap-ref-remove') {
      onRoadmapRefAct(act, t, detail);
      return;
    }
    if (act === 'promote-grant') { if (window.RESEARCH_CREATE) RESEARCH_CREATE.promoteGrantIdea(detail, afterMutation); return; }
    if (act === 'publish' || act === 'unpublish') { doPublish(detail, act === 'publish'); return; }
    if (act === 'delete') { doDelete(detail); return; }
    if (act === 'remove-card') { doRemoveCard(detail); return; }
  }

  /* V3.601 — attach / re-note / detach a reference paper on a roadmap
   * item. Only the refs subcollection changed, so re-hydrate the section
   * instead of reloading and re-rendering the entire map. */
  async function onRoadmapRefAct(act, btn, detail) {
    if (!detail || !window.ROADMAP_ATTACH || !window.RESEARCH_ROADMAP) return;
    var refresh = function () { return RESEARCH_ROADMAP.hydrateSection(root, detail, state); };

    if (act === 'roadmap-add-ref') {
      var kind = btn.getAttribute('data-target-kind') || 'roadmap';
      var tid = btn.getAttribute('data-target-id') || null;
      // The button lives inside the item it targets, so the label the
      // user is about to see in the modal comes straight off the DOM.
      var host = tid ? root.querySelector('#rmap-' + CSS.escape(tid)) : null;
      var label = host
        ? (host.querySelector('.rmap-an-title') || host.querySelector('.rmap-exp-title') || {}).textContent
        : ('the ' + titleOf(detail) + ' roadmap');
      ROADMAP_ATTACH.openForTarget({
        fociId: detail.id,
        target: { kind: kind, id: tid },
        targetLabel: (label || '').trim() || titleOf(detail),
        onDone: refresh,
      });
      return;
    }

    var li = btn.closest('[data-ref]');
    if (!li) return;
    var refId = li.getAttribute('data-ref');
    var itemId = li.getAttribute('data-item');

    if (act === 'roadmap-ref-remove') {
      if (!confirm('Detach this paper from the roadmap? The paper itself stays in the library.')) return;
      try {
        await window.ROADMAP_DATA.removeRef(detail.id, refId, itemId);
        toast('success', 'Detached.');
        await refresh();
      } catch (err) { toast('error', 'Detach failed: ' + (err && err.message)); }
      return;
    }

    // roadmap-ref-edit — re-open just the note + relevance.
    try {
      var refs = await window.ROADMAP_DATA.listRefs(detail.id);
      var ref = refs.filter(function (r) { return r.id === refId; })[0];
      if (!ref) { toast('error', 'That reference is gone — refreshing.'); await refresh(); return; }
      ROADMAP_ATTACH.openNoteEditor(detail.id, ref, refresh);
    } catch (err) { toast('error', 'Could not open that note: ' + (err && err.message)); }
  }

  // Remove an OUTPUT card from the research map only — the underlying
  // paper/grant record is untouched (site-wide deletion lives on the
  // Outputs page). Re-adding later via ⤵ Existing recreates the card.
  async function doRemoveCard(f) {
    if (!confirm('Remove "' + titleOf(f) + '" from the research map?\n\n' +
      'The paper/grant itself is NOT deleted — it stays in the builder and can be re-added any time via "⤵ Add existing paper" or a concept\'s Grant section.')) return;
    try {
      if (window.RESEARCH_PUBLISH && f.published) { try { await RESEARCH_PUBLISH.unpublish(f); } catch (e) {} }
      await RD.remove(f.id);
      toast('success', 'Removed from the map.');
      window.location.href = '/rm/pages/research.html';
    } catch (err) { toast('error', 'Remove failed: ' + (err && err.message)); }
  }

  // Seed the six lab specialty cards as editable stubs (admin only).
  var SEED_SPECIALTIES = [
    { id: 'mebp', title: 'Microscope-Enabled Bioprinting', abbr: 'MEBP', icon: '🔬', one_liner: 'In-situ printing under live microscopy.' },
    { id: 'in-situ-elisa', title: 'In-Situ ELISA', abbr: 'ELISA', icon: '🧫', one_liner: 'Spatially-resolved protein readout in place.' },
    { id: 'gels', title: 'Granule-Enabled Living Scaffolds', abbr: 'GELS', icon: '🫧', one_liner: 'Granular hydrogels as living tissue scaffolds.' },
    { id: 'cels', title: 'Cell-Embedded Living Scaffold', abbr: 'CELS', icon: '🧩', one_liner: 'Cells embedded directly into the scaffold matrix.' },
    { id: 'stem', title: 'Spatio-Temporal Embedded Morphogens', abbr: 'STEM', icon: '🌱', one_liner: 'Morphogen gradients patterned in space and time.' },
    { id: 'tfm', title: 'Traction Force Microscopy', abbr: 'TFM', icon: '📐', one_liner: 'Measuring the forces cells exert on their matrix.' },
  ];
  async function seedSpecialties(btn) {
    if (!confirm('Create the 6 lab specialty cards as editable stubs? You can rename, describe, and delete them freely afterward.')) return;
    btn.disabled = true; btn.textContent = 'Seeding…';
    try {
      for (var i = 0; i < SEED_SPECIALTIES.length; i++) {
        var s = SEED_SPECIALTIES[i];
        try { await RD.create(Object.assign({ level: 'specialty', order: i * 10 }, s)); }
        catch (e) { /* skip an id that already exists */ }
      }
      toast('success', 'Specialty cards created — edit each to add the description.');
      await afterMutation();
    } catch (err) { toast('error', 'Seed failed: ' + (err && err.message)); btn.disabled = false; }
  }

  async function doPublish(f, publish) {
    if (!window.RESEARCH_PUBLISH) { toast('error', 'Publish module not loaded.'); return; }
    try {
      await (publish ? RESEARCH_PUBLISH.publish(f) : RESEARCH_PUBLISH.unpublish(f));
      toast('success', publish ? 'Published to the lab website.' : 'Unpublished.');
      await afterMutation();
    } catch (err) { toast('error', 'Publish failed: ' + (err && err.message)); }
  }

  async function doDelete(f) {
    if (!confirm('Delete "' + f.title + '"? This removes the card and unpublishes it. Attached students and linked drafts are not affected.')) return;
    try {
      if (window.RESEARCH_PUBLISH) { try { await RESEARCH_PUBLISH.unpublish(f); } catch (e) {} }
      await RD.remove(f.id);
      toast('success', 'Deleted.');
      window.location.href = '/rm/pages/research.html';
    } catch (err) { toast('error', 'Delete failed: ' + (err && err.message)); }
  }

  // Reload data + re-render after any create/edit/link/media/publish, and
  // (on a detail view) refresh the async sidebars. Every authoring modal's
  // onDone callback routes here.
  async function afterMutation() {
    await loadAll();
    render();
    if (state.viewId) { var f = byId(state.viewId); if (f) hydrateSidebar(f); }
  }

  /* ── boot ───────────────────────────────────────────────────── */

  async function init() {
    root = document.getElementById('research-root');
    if (!root || typeof firebridge === 'undefined' || !window.RESEARCH_DATA) return;
    if (firebridge.requireSignIn) await firebridge.requireSignIn();
    state.me = firebridge.getUser();
    if (!state.me) return; // pending-access overlay covers guests
    if (firebridge.isLabMember && !firebridge.isLabMember()) {
      root.innerHTML = '<div class="rf-band-empty">The research map is for lab members.</div>';
      return;
    }
    state.isAdmin = !!(firebridge.isAdmin && firebridge.isAdmin());
    var params = new URLSearchParams(location.search);
    state.viewId = params.get('id') || null;

    root.addEventListener('click', onClick);
    root.addEventListener('keydown', function (e) {
      if (e.key !== 'Enter' && e.key !== ' ') return;
      var card = e.target.closest && e.target.closest('[data-expand]');
      if (card && e.target === card) { e.preventDefault(); card.click(); }
    });
    await loadAll();
    render();
    if (state.viewId) { var f = byId(state.viewId); if (f) hydrateSidebar(f); }
    scrollToHash();
  }

  /* Roadmap items carry ids (#rmap-<experimentId|analysisId>) so a paper's
   * roadmap chip can deep-link to the exact analysis it was attached to.
   * The card renders after load, so the browser's own hash jump has
   * already missed — do it once here. */
  function scrollToHash() {
    if (!location.hash || !root) return;
    var el = null;
    try { el = root.querySelector(location.hash); } catch (e) { return; }
    if (!el) return;
    el.scrollIntoView({ block: 'center', behavior: 'smooth' });
    el.classList.add('rmap-flash');
    setTimeout(function () { el.classList.remove('rmap-flash'); }, 2000);
  }

  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', init);
  else init();
})();
