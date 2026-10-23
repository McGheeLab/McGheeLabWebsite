/* research.js — V3.544+, four-band map V3.717: the hub renderer.
 *
 * rm/pages/research.html. Three views off one page:
 *   • Hub (default) — the lab's research map as FOUR bands (RD.BANDS): a
 *     specialty chip strip, a concept grid, a grants rail, and "Aims &
 *     outputs" (one band, two sub-groups). A student sees the whole map
 *     with their own foci highlighted; the PI (admin) gets "＋ New card"
 *     and inline edit affordances. V3.851 — a student gets "＋ Propose":
 *     their card joins the map marked Proposed, editable by them until the
 *     PI or their advisor approves or declines it (RESEARCH_DATA.mayEdit /
 *     mayDecide); deciders get an "Awaiting your approval" strip at the top
 *     of the hub and an approval banner on the card.
 *   • Grant review (?id=<grantId>) — V3.717. A grant is where the lab's
 *     work is actually spent, so its page is not a card detail but a
 *     review: its aims, the outputs synthesizing them, its drafts, and
 *     every person's semester/weekly focus rolled up under it. Rendered by
 *     research-grant-review.js.
 *   • Detail (?id=<fociId>) — any other card in full: media gallery,
 *     description, what it combines (cross-level pills), children with
 *     derived status, linked theme, trainings, aligned people, per-thrust
 *     progress (admin/mentor), and (admin) publish controls.
 *
 * Data: window.RESEARCH_DATA. Authoring modals live in research-composer.js
 * (guided templates), research-links.js (attachments), research-create.js
 * (spawn paper / grant card), research-media.js (upload + render). This file
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
    canPropose: false,  // V3.851 — a non-admin lab member may propose a card
    all: [],            // V3.851 — every card, hydrated + sorted; byId indexes this
    foci: [],           // the cards the map SHOWS: `all` minus declined proposals that aren't mine
    byId: {},
    viewId: null,       // ?id → detail; else hub
    expanded: null,     // hub: concept id whose inline details are open
    declining: null,    // V3.851 — card id whose inline decline form is open
  };
  // V3.851 — handed to research-grant-review.js as pageState so its
  // "New aim / New output / Edit people" buttons follow the same gate.
  state.canEditCard = function (f) { return RD.mayEdit(f); };

  function toast(kind, msg) { if (window.TOAST && TOAST[kind]) TOAST[kind](msg); }
  function byId(id) { return state.byId[id] || null; }
  function fociUrl(id) { return '/rm/pages/research.html?id=' + encodeURIComponent(id); }
  function onThisFocus(f) { return state.me && f.member_uids.indexOf(state.me.uid) !== -1; }

  function indexFoci() {
    state.byId = {};
    state.all.forEach(function (f) { state.byId[f.id] = f; });
  }

  /* V3.851 — a declined proposal is the proposer's to fix or withdraw; it
   * stays off everyone else's map (the PI still sees it). */
  function hiddenFromMe(f) {
    return RD.isDeclined(f) && !state.isAdmin && RD.proposerOf(f) !== (state.me && state.me.uid);
  }

  async function loadAll() {
    state.all = await RD.listAll();
    // Draft-backed output cards derive title/status from the real record.
    // Force-fresh the draft roster first: a paper deleted via the
    // deleteBuilderPaper Cloud Function bumps no updatedAt, so the cached
    // projects/papers.json would otherwise keep resolving a gone paper.
    // V3.647 — `typeof api`; `window.api` is always undefined (lexical const).
    if (typeof api !== 'undefined' && api.invalidate) { try { await api.invalidate('projects/papers.json'); } catch (e) {} }
    if (window.LIBRARY_ASSOC && LIBRARY_ASSOC.invalidate) { try { LIBRARY_ASSOC.invalidate(); } catch (e) {} }
    if (window.LIBRARY_ASSOC && LIBRARY_ASSOC.loadDraftInfo) {
      try { await LIBRARY_ASSOC.loadDraftInfo(); } catch (e) {}
    }
    await pruneOrphanCards();
    state.foci = state.all.filter(function (f) { return !hiddenFromMe(f); });
    indexFoci();
  }

  /* A draft-backed output card whose source paper/grant was deleted is an
   * orphan — its whole identity is gone. After the resolver is loaded, a
   * source_draft_id that resolves to kind 'unknown' means the record no
   * longer exists. Admins delete the dead card; everyone filters it from
   * view so the map never shows a paper that 404s on click.
   *
   * V3.717 — OUTPUT cards only, deliberately. A grant card may also carry a
   * source_draft_id, but its identity is its own (manual status, aims,
   * members, the work rolled up under it); losing the builder draft must
   * never delete the grant. */
  function isOrphan(f) {
    if (f.level !== 'output' || !f.source_draft_id) return false;
    if (!(window.LIBRARY_ASSOC && LIBRARY_ASSOC.resolve)) return false;
    var d = LIBRARY_ASSOC.resolve(f.source_draft_id);
    return !d || d.kind === 'unknown';
  }
  async function pruneOrphanCards() {
    var orphans = state.all.filter(isOrphan);
    if (!orphans.length) return;
    if (state.isAdmin) {
      for (var i = 0; i < orphans.length; i++) {
        try { await RD.remove(orphans[i].id); } catch (e) {}
      }
    }
    var dead = {}; orphans.forEach(function (o) { dead[o.id] = 1; });
    state.all = state.all.filter(function (f) { return !dead[f.id]; });
  }

  /* Draft-backed output cards (source_draft_id set) present the live paper/
   * grant title + status; authored cards use their own stored fields. */
  function draftInfo(f) {
    return (f && f.source_draft_id && window.LIBRARY_ASSOC && LIBRARY_ASSOC.resolve)
      ? LIBRARY_ASSOC.resolve(f.source_draft_id) : null;
  }
  function titleOf(f) { var d = draftInfo(f); return (d && d.title) || f.title || '(untitled)'; }
  /* V3.717 — a GRANT's status is manual, always: the card is the lab's one
   * source of truth for where a grant stands, so a linked builder draft can
   * never flip it. The draft's own status still shows, as a muted secondary
   * pill on its chip (draftStatusPill). */
  function effStatus(f) {
    if (f.level === 'grant') return f.status;
    var d = draftInfo(f);
    return (d && d.status) || f.status;
  }

  /* ── status pill ────────────────────────────────────────────── */
  function statusPill(f) {
    // V3.851 — an undecided card's lifecycle status is moot; the pill says
    // where it stands instead, on every surface that shows a pill.
    if (RD.isProposed(f)) return '<span class="rf-status rf-status-proposed">Proposed</span>';
    if (RD.isDeclined(f)) return '<span class="rf-status rf-status-declined">Declined</span>';
    var s = effStatus(f);
    var m = RD.STATUS_META[s] || { label: s, color: '#374151', bg: '#e5e7eb' };
    return '<span class="rf-status" style="color:' + m.color + ';background:' + m.bg + '">' + esc(m.label) + '</span>';
  }
  function iconFor(f) { return f.icon || RD.levelMeta(f.level).icon; }
  // Render an icon value as safe HTML — emoji as text, a custom-upload URL
  // as an <img> — via the shared ICON_PICKER (falls back to escaped text).
  function iconHtml(f, size) {
    var v = iconFor(f);
    return window.ICON_PICKER ? ICON_PICKER.html(v, { size: size || '1.1em' }) : esc(v);
  }

  /* ── HUB ────────────────────────────────────────────────────── */

  function render() {
    if (!root) return;
    if (state.viewId) renderDetail(byId(state.viewId));
    else renderHub();
    hydrateNames();   // V3.851 — proposer / decider names in strips and banners
  }

  function renderHub() {
    var mine = state.foci.filter(onThisFocus);
    var bands = RD.BANDS.map(renderBand).join('');

    root.innerHTML =
      '<div class="rf-hub">' +
        '<header class="rf-hub-head">' +
          '<p class="rf-hub-intro">The lab’s research map — the capabilities that make us unique, the concepts they combine into, the grants they fund, and the results each grant needs.</p>' +
          (state.isAdmin
            ? '<div class="rf-toolbar">' +
                (!state.foci.length ? '<button class="rf-btn rf-btn-primary" data-act="seed">' + ICON.svg('sparkles') + ' Seed the 6 lab specialties</button>' : '') +
                '<button class="rf-btn" data-act="add-existing">' + ICON.svg('arrow-turn-right-down') + ' Add existing paper</button>' +
                (legacyGrantConcepts().length
                  ? '<button class="rf-btn rf-btn-primary" data-act="migrate-grants">' + ICON.svg('arrow-turn-right-up') + ' Move grants out of concepts (' + legacyGrantConcepts().length + ')</button>'
                  : '') +
              '</div>'
            : (state.canPropose
                ? '<div class="rf-toolbar"><button class="rf-btn rf-btn-primary" data-act="new" data-level="concept">' +
                    ICON.svg('plus') + ' Propose a focus</button></div>'
                : '')) +
        '</header>' +
        approvalsStrip() +
        (mine.length
          ? '<div class="rf-mine"><span class="rf-mine-label">Your foci</span>' +
              mine.map(function (f) { return '<a class="rf-mine-chip" href="' + fociUrl(f.id) + '">' + iconHtml(f) + ' ' + esc(titleOf(f)) + '</a>'; }).join('') +
            '</div>'
          : '') +
        myProposalsStrip() +
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

  /* V3.851 — the cards waiting on the signed-in user's decision: proposals
   * by their mentees, or, for the PI, by anyone. Approve is one tap; the
   * decline note is a textarea IN the row — never a browser prompt. */
  function approvalsStrip() {
    var pending = state.all.filter(function (f) { return RD.isProposed(f) && RD.mayDecide(f); });
    if (!pending.length) return '';
    return '<div class="rf-approvals">' +
      '<div class="rf-approvals-title">Awaiting your approval <span class="rf-band-count">' + pending.length + '</span></div>' +
      pending.map(function (f) {
        var a = f.approval || {};
        return '<div class="rf-approval-row">' +
          '<a class="rf-mine-chip" href="' + fociUrl(f.id) + '">' + iconHtml(f) + ' ' + esc(titleOf(f)) + '</a>' +
          '<span class="rf-approval-by">' + esc(RD.levelMeta(f.level).label) + ' · proposed by ' +
            '<span data-uname="' + esc(RD.proposerOf(f) || '') + '">…</span>' +
            (a.proposed_at ? ' on ' + esc(String(a.proposed_at).slice(0, 10)) : '') +
            (a.reproposed ? ' · re-proposed' : '') + '</span>' +
          (state.declining === f.id ? declineForm(f) : decideButtons(f)) +
        '</div>';
      }).join('') +
    '</div>';
  }
  function decideButtons(f) {
    return '<span class="rf-sec-actions">' +
      '<button class="rf-btn rf-btn-sm rf-btn-primary" data-act="approve" data-id="' + esc(f.id) + '">' + ICON.svg('check') + ' Approve</button>' +
      '<button class="rf-btn rf-btn-sm" data-act="decline" data-id="' + esc(f.id) + '">' + ICON.svg('x-mark') + ' Decline…</button>' +
    '</span>';
  }
  function declineForm(f) {
    return '<form class="rf-decline-form" data-decline-form="' + esc(f.id) + '">' +
      '<textarea name="note" rows="2" placeholder="What should change before it can be approved? The proposer sees this."></textarea>' +
      '<span class="rf-sec-actions">' +
        '<button type="submit" class="rf-btn rf-btn-sm rf-btn-danger">Decline</button>' +
        '<button type="button" class="rf-btn rf-btn-sm" data-act="decline-cancel">Cancel</button>' +
      '</span></form>';
  }
  /* V3.851 — the proposer's own undecided cards, with where each stands. */
  function myProposalsStrip() {
    if (state.isAdmin || !state.me) return '';
    var uid = state.me.uid;
    var mine = state.all.filter(function (f) { return !RD.isApproved(f) && RD.proposerOf(f) === uid; });
    if (!mine.length) return '';
    return '<div class="rf-mine rf-mine-proposals"><span class="rf-mine-label">Your proposals</span>' +
      mine.map(function (f) {
        return '<a class="rf-mine-chip" href="' + fociUrl(f.id) + '">' + iconHtml(f) + ' ' + esc(titleOf(f)) + ' ' + statusPill(f) + '</a>';
      }).join('') +
      '<span class="rf-approval-by">The PI or your advisor decides. You can keep editing until then.</span>' +
    '</div>';
  }

  /* One hub section. A band may hold more than one level (V3.717's "Aims &
   * outputs"): those render as labelled sub-groups inside the single
   * section, so aims and outputs read as the peers they are while staying
   * separate levels underneath. */
  function renderBand(band) {
    var single = band.levels.length === 1 ? RD.LEVELS[band.levels[0]] : null;
    var title = band.title || (single ? single.plural : band.key);
    var blurb = band.blurb || (single ? single.blurb : '');
    var total = state.foci.filter(function (f) { return band.levels.indexOf(f.level) !== -1; }).length;

    // V3.851 — a non-admin member gets the same buttons, worded as what
    // they are: a proposal the PI or their advisor still has to approve.
    var addBtn = state.isAdmin
      ? band.levels.map(function (lvl) {
          return '<button class="rf-btn rf-btn-ghost" data-act="new" data-level="' + lvl + '">' +
            ICON.svg('plus') + ' ' + (single ? 'Add' : RD.LEVELS[lvl].label) + '</button>';
        }).join('')
      : (state.canPropose
          ? band.levels.map(function (lvl) {
              return '<button class="rf-btn rf-btn-ghost" data-act="new" data-level="' + lvl + '">' +
                ICON.svg('plus') + ' Propose' + (single ? '' : ' ' + RD.LEVELS[lvl].label.toLowerCase()) + '</button>';
            }).join('')
          : '');

    var body;
    if (!total) {
      body = '<div class="rf-band-empty">Nothing here yet.' +
             (state.isAdmin ? ' <button class="rf-link" data-act="new" data-level="' + band.levels[0] + '">Add the first →</button>'
               : (state.canPropose ? ' <button class="rf-link" data-act="new" data-level="' + band.levels[0] + '">Propose the first →</button>' : '')) + '</div>';
    } else if (single) {
      body = levelGroup(band.levels[0]);
    } else {
      body = band.levels.map(function (lvl) {
        var n = state.foci.filter(function (f) { return f.level === lvl; }).length;
        return '<div class="rf-subband rf-subband-' + lvl + '">' +
                 '<h3 class="rf-subband-title">' + ICON.render(RD.LEVELS[lvl].icon) + ' ' + esc(RD.LEVELS[lvl].plural) +
                   (n ? ' <span class="rf-band-count">' + n + '</span>' : '') + '</h3>' +
                 (n ? levelGroup(lvl) : '<p class="rf-empty-sm">None yet.</p>') +
               '</div>';
      }).join('');
    }

    return '<section class="rf-band rf-band-' + band.key + '">' +
             '<div class="rf-band-head">' +
               '<div><h2 class="rf-band-title">' + esc(title) +
                 (total ? ' <span class="rf-band-count">' + total + '</span>' : '') + '</h2>' +
                 '<p class="rf-band-sub">' + esc(blurb) + '</p></div>' +
               '<span class="rf-band-actions">' + addBtn + '</span>' +
             '</div>' +
             body +
           '</section>';
  }

  /* The cards of ONE level, in that level's own layout. */
  function levelGroup(level) {
    var list = state.foci.filter(function (f) { return f.level === level; });
    if (level === 'specialty') {
      return '<div class="rf-specialty-strip">' + list.map(specialtyChip).join('') + '</div>';
    }
    if (level === 'concept') {
      // Clicking a concept card expands its details INLINE (grants, aims,
      // description) — the expansion row spans the full grid width and sits
      // right after the clicked card.
      return '<div class="rf-concept-grid">' + list.map(function (f) {
        return conceptCard(f) + (state.expanded === f.id ? conceptExpand(f) : '');
      }).join('') + '</div>';
    }
    if (level === 'grant') {
      return '<div class="rf-grant-rail">' + list.map(grantCard).join('') + '</div>';
    }
    if (level === 'aim') {
      // V3.719 — aims read as "what THIS grant has to deliver", so they group
      // under their grant rather than forming one undifferentiated rail. A
      // flat list of every aim in the lab answers nobody's question.
      return groupedByGrant(list, aimCard, 'No grant yet');
    }
    return '<div class="rf-output-rail">' + list.map(outputCard).join('') + '</div>';
  }

  /* Cards bucketed under the grant they serve, in the grants' own hub order,
   * with anything unattached collected last so it stays visible rather than
   * quietly vanishing. Grants with no cards are skipped — an empty heading
   * per grant is noise. */
  function groupedByGrant(list, cardFn, emptyLabel) {
    var grants = state.foci.filter(function (f) { return f.level === 'grant'; });
    var buckets = [], loose = [];
    grants.forEach(function (g) {
      var mine = list.filter(function (c) {
        return RD.grantIdsForCard(c, state.foci).some(function (h) {
          return h.id === g.id && !h.indirect;
        });
      });
      if (mine.length) buckets.push({ grant: g, cards: mine });
    });
    var claimed = {};
    buckets.forEach(function (b) { b.cards.forEach(function (c) { claimed[c.id] = 1; }); });
    loose = list.filter(function (c) { return !claimed[c.id]; });
    if (loose.length) buckets.push({ grant: null, cards: loose });

    if (!buckets.length) return '<p class="rf-empty-sm">None yet.</p>';
    return buckets.map(function (b) {
      var head = b.grant
        ? '<a class="rf-gbg-title" href="' + fociUrl(b.grant.id) + '">' +
            iconHtml(b.grant) + ' ' + esc(b.grant.abbr || titleOf(b.grant)) +
            ' ' + statusPill(b.grant) + '</a>'
        : '<span class="rf-gbg-title rf-gbg-loose">' + esc(emptyLabel) + '</span>';
      return '<div class="rf-gbg">' +
        '<div class="rf-gbg-head">' + head +
          '<span class="rf-gbg-count">' + b.cards.length + '</span></div>' +
        '<div class="rf-output-rail">' + b.cards.map(cardFn).join('') + '</div>' +
      '</div>';
    }).join('');
  }

  // V3.851 — an undecided card also gets the dashed "proposed" outline, on
  // every card shape, so the map shows what is settled and what is not.
  function mineRing(f) {
    return (onThisFocus(f) ? ' rf-card-mine' : '') + (RD.isApproved(f) ? '' : ' rf-card-proposed');
  }

  function specialtyChip(f) {
    return '<a class="rf-chip' + mineRing(f) + '" href="' + fociUrl(f.id) + '"' +
             (f.color ? ' style="--rf-accent:' + esc(f.color) + '"' : '') + '>' +
             '<span class="rf-icon-tile">' + iconHtml(f, '22px') + '</span>' +
             '<span class="rf-chip-text"><strong>' + esc(f.abbr || titleOf(f)) + '</strong>' +
               (f.abbr ? '<span class="rf-chip-sub">' + esc(titleOf(f)) + '</span>' : '') +
               (RD.isApproved(f) ? '' : statusPill(f)) +
             '</span>' +
           '</a>';
  }

  /* The card-face "what this sits on" chips. V3.717 — walks RD.PARENTS and
   * shows the FIRST non-empty parent level, so a card face stays one line:
   * a concept shows its specialties, a grant its concepts, an aim its
   * grant, an output its aims (falling through the legacy levels for
   * pre-V3.717 outputs that were linked straight to a concept). */
  /* `linked:false` renders the pills as spans. Grant / aim / output cards
   * are themselves one big <a>, and an <a> inside an <a> is invalid HTML:
   * the parser closes the card early and re-opens empty clones of it, which
   * paint as stray bordered boxes beside every card. The whole card already
   * links to itself, so the pills lose nothing by being inert there. The
   * CONCEPT card is a <div role=button>, so its pills stay real links. */
  function parentPillsFor(f, linked) {
    var ids = [];
    (RD.PARENTS[f.level] || []).some(function (lvl) {
      ids = ((f.links && f.links[RD.LINK_KEY[lvl]]) || []).slice();
      return ids.length > 0;
    });
    if (!ids.length) return '';
    return '<div class="rf-combine">' + ids.map(function (id) {
      var t = byId(id);
      if (!t) return '';
      var body = iconHtml(t) + ' ' + esc(t.abbr || titleOf(t));
      return linked === false
        ? '<span class="rf-combine-pill rf-combine-pill-flat">' + body + '</span>'
        : '<a class="rf-combine-pill" href="' + fociUrl(t.id) + '">' + body + '</a>';
    }).join('') + '</div>';
  }

  /* V3.719 — which grant(s) an output serves, on its card face. Resolved
   * through grantIdsForCard, so an output linked to an AIM shows that aim's
   * grant without needing a redundant direct link; an output can serve
   * several. Indirect (concept-level) hits are excluded — they are not an
   * association anyone chose, and showing them would imply one. */
  function grantChipsFor(f) {
    var hits = RD.grantIdsForCard(f, state.foci).filter(function (h) { return !h.indirect; });
    if (!hits.length) {
      return state.isAdmin
        ? '<div class="rf-combine"><span class="rf-combine-pill rf-combine-pill-flat rf-pill-warn">no grant yet</span></div>'
        : '';
    }
    return '<div class="rf-combine">' + hits.map(function (h) {
      var g = byId(h.id);
      if (!g) return '';
      return '<span class="rf-combine-pill rf-combine-pill-flat">' +
        iconHtml(g) + ' ' + esc(g.abbr || titleOf(g)) + '</span>';
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
    var grants = RD.childrenOf(f, state.foci, ['grant']);
    var grantChip = grants.length
      ? '<span class="rf-grant-chip" title="Grants built on this concept">' + ICON.svg('bookmark-square') + ' ' +
          grants.length + ' grant' + (grants.length === 1 ? '' : 's') + '</span>'
      : (conceptHasLegacyGrant(f)
          ? '<span class="rf-grant-chip rf-grant-chip-legacy" title="Grant still stored inside this concept — run “Move grants out of concepts”">' +
              ICON.svg('bookmark-square') + ' grant (unmoved)</span>'
          : '');
    return '<div class="rf-concept-card' + mineRing(f) + (open ? ' rf-open' : '') + '" role="button" tabindex="0" ' +
             'data-expand="' + esc(f.id) + '" aria-expanded="' + open + '"' +
             (f.color ? ' style="--rf-accent:' + esc(f.color) + '"' : '') + '>' +
             coverThumb(f) +
             '<div class="rf-card-body">' +
               '<div class="rf-card-head"><span class="rf-icon-tile rf-icon-tile-sm">' + iconHtml(f, '18px') + '</span>' +
                 '<h3 class="rf-clamp2">' + esc(titleOf(f)) + '</h3>' +
                 '<span class="rf-chevron">' + (open ? '▴' : '▾') + '</span></div>' +
               (f.one_liner ? '<p class="rf-card-liner rf-clamp2">' + esc(f.one_liner) + '</p>' : '') +
               '<div class="rf-card-foot">' + parentPillsFor(f) + grantChip + (RD.isApproved(f) ? '' : statusPill(f)) + '</div>' +
             '</div>' +
           '</div>';
  }

  /* Inline expansion under a concept card: description, the grants built on
   * it (each with its aim count), and the door to the full detail page. */
  function conceptExpand(f) {
    var grants = RD.childrenOf(f, state.foci, ['grant']);
    var grantHtml = grants.length
      ? '<div class="rf-combine">' + grants.map(function (g) {
          var aims = RD.childrenOf(g, state.foci, ['aim']).length;
          return '<a class="rf-combine-pill" href="' + fociUrl(g.id) + '">' + iconHtml(g) + ' ' + esc(titleOf(g)) +
            ' ' + statusPill(g) + (aims ? ' <span class="rf-mini-status">' + aims + ' aim' + (aims === 1 ? '' : 's') + '</span>' : '') + '</a>';
        }).join('') + '</div>'
      : '<p class="rf-empty-sm">No grants built on this concept yet.</p>';
    // Legacy outputs linked straight to a concept (pre-V3.717) still belong
    // on this expansion — they have not been re-parented under an aim yet.
    var outs = RD.childrenOf(f, state.foci, ['output']);
    var outHtml = outs.length
      ? '<div class="rf-combine">' + outs.map(function (o) {
          return '<a class="rf-combine-pill" href="' + fociUrl(o.id) + '">' + iconHtml(o) + ' ' + esc(titleOf(o)) + ' ' + statusPill(o) + '</a>';
        }).join('') + '</div>'
      : '';
    var desc = f.description_html
      ? '<div class="rf-richtext rf-expand-desc">' + RD.sanitizeHtml(f.description_html) + '</div>' : '';
    return '<div class="rf-concept-expand"' + (f.color ? ' style="--rf-accent:' + esc(f.color) + '"' : '') + '>' +
      desc +
      '<div class="rf-expand-cols">' +
        '<div><h4>Grants</h4>' + grantHtml + '</div>' +
        (outHtml ? '<div><h4>Outputs linked here</h4>' + outHtml + '</div>' : '') +
      '</div>' +
      '<div class="rf-expand-foot"><a class="rf-btn rf-btn-sm" href="' + fociUrl(f.id) + '">Open full page →</a></div>' +
    '</div>';
  }

  /* V3.717 — a grant is the unit the lab's work is spent against, so its
   * card leads with the manual status and the two facts a decision turns on:
   * who funds it, and when it is due. */
  function grantCard(f) {
    var gm = f.grant_meta || {};
    var aims = RD.childrenOf(f, state.foci, ['aim']).length;
    var outs = RD.cardsUnderGrant(f, state.foci).filter(function (x) { return x.level === 'output'; }).length;
    var agency = [gm.agency, gm.mechanism].filter(Boolean).join(' · ');
    var due = gm.target_deadline && gm.target_deadline !== 'TBD' ? gm.target_deadline : '';
    return '<a class="rf-grant-card' + mineRing(f) + '" href="' + fociUrl(f.id) + '"' +
             (f.color ? ' style="--rf-accent:' + esc(f.color) + '"' : '') + '>' +
             '<div class="rf-output-top">' +
               '<span class="rf-icon-tile rf-icon-tile-sm">' + iconHtml(f, '18px') + '</span>' +
               statusPill(f) +
             '</div>' +
             '<h3 class="rf-clamp2">' + esc(titleOf(f)) + '</h3>' +
             (agency ? '<p class="rf-grant-agency">' + esc(agency) + '</p>' : '') +
             (f.one_liner ? '<p class="rf-card-liner rf-clamp2">' + esc(f.one_liner) + '</p>' : '') +
             '<div class="rf-grant-counts">' +
               '<span>' + ICON.render(RD.LEVELS.aim.icon) + ' ' + aims + ' aim' + (aims === 1 ? '' : 's') + '</span>' +
               '<span>' + ICON.render(RD.LEVELS.output.icon) + ' ' + outs + ' output' + (outs === 1 ? '' : 's') + '</span>' +
               (due ? '<span class="rf-grant-due">' + ICON.svg('clock') + ' ' + esc(due) + '</span>' : '') +
             '</div>' +
             '<div class="rf-card-foot">' + parentPillsFor(f, false) + '</div>' +
           '</a>';
  }

  /* Aims and outputs are peers in one band, so they share a card shape and
   * differ only by accent class — an aim is a target result, an output is
   * the synthesis of results. */
  // An aim already sits under its grant's heading in the band, so repeating
  // the grant on the card would be noise — its foot stays empty. An output
  // is NOT grouped, so it carries its grant associations itself.
  function aimCard(f) { return deliveryCard(f, 'rf-aim-card', ''); }
  function outputCard(f) { return deliveryCard(f, 'rf-output-card', grantChipsFor(f)); }
  function deliveryCard(f, cls, footHtml) {
    return '<a class="' + cls + mineRing(f) + '" href="' + fociUrl(f.id) + '"' +
             (f.color ? ' style="--rf-accent:' + esc(f.color) + '"' : '') + '>' +
             '<div class="rf-output-top">' +
               '<span class="rf-icon-tile rf-icon-tile-sm">' + iconHtml(f, '18px') + '</span>' +
               statusPill(f) +
             '</div>' +
             '<h3 class="rf-clamp2">' + esc(titleOf(f)) + '</h3>' +
             (f.one_liner ? '<p class="rf-card-liner rf-clamp2">' + esc(f.one_liner) + '</p>' : '') +
             (footHtml ? '<div class="rf-card-foot">' + footHtml + '</div>' : '') +
           '</a>';
  }

  /* ── DETAIL ─────────────────────────────────────────────────── */

  function renderDetail(f) {
    if (!f) {
      root.innerHTML = '<div class="rf-detail"><a class="rf-back" href="/rm/pages/research.html">← Research</a>' +
        '<p class="rf-band-empty">That focus was not found.</p></div>';
      return;
    }
    var meta = RD.levelMeta(f.level);
    var canEdit = RD.mayEdit(f);   // V3.851 — admin, or proposer / advisor while undecided
    var withdraw = !RD.isApproved(f) && RD.proposerOf(f) === (state.me && state.me.uid);

    // V3.717 — a grant opens as a REVIEW, not a card detail: what it has
    // to deliver and who is delivering it. Own module, own layout.
    if (f.level === 'grant' && window.GRANT_REVIEW) { renderGrantReview(f, canEdit); return; }

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
            (canEdit ? '<button class="rf-btn" data-act="edit">' + ICON.svg('pencil') + ' Edit</button>' +
              // Draft-backed output cards REMOVE from the map (the paper
              // record itself is untouched — true deletion lives on the
              // Outputs page); every authored card deletes outright.
              (f.level === 'output' && !withdraw
                ? '<button class="rf-btn rf-btn-danger" data-act="remove-card">' + ICON.svg('x-mark') + ' Remove from map</button>'
                : '<button class="rf-btn rf-btn-danger" data-act="delete">' + (withdraw ? 'Withdraw' : 'Delete') + '</button>') : '') +
          '</div>' +
        '</header>' +
        approvalBanner(f) +
        '<div class="rf-detail-grid">' +
          '<div class="rf-detail-main">' +
            sectionMedia(f, canEdit) +
            sectionDescription(f, canEdit) +
            sectionRoadmap(f, canEdit) +
            sectionOverview(f, canEdit) +
          '</div>' +
          '<aside class="rf-detail-side">' +
            sectionCombine(f, canEdit) +
            (f.level === 'output' || f.level === 'aim' ? sectionOutputs(f, canEdit) : '') +
            sectionChildren(f, canEdit) +
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

  /* V3.600 — the experiment → analysis → figure roadmap. Aim and output
   * cards only (V3.717): a specialty is a capability, a concept is an idea
   * and a grant is a program — none of them has bench work of its own. An
   * AIM is precisely the thing with experiments to run, and an output is
   * where they get written up. */
  function sectionRoadmap(f, canEdit) {
    if ((f.level !== 'aim' && f.level !== 'output') || !window.RESEARCH_ROADMAP) return '';
    return RESEARCH_ROADMAP.renderSection(f, canEdit);
  }

  function sectionMedia(f, canEdit) {
    return '<section class="rf-sec rf-sec-media">' +
      '<div class="rf-sec-head"><h2>Media</h2>' +
        (canEdit ? '<button class="rf-btn rf-btn-sm" data-act="add-media">' + ICON.svg('plus') + ' Add image / video / HTML</button>' : '') +
      '</div>' +
      '<div data-media-gallery>' + ((f.media || []).length ? '' : '<p class="rf-empty-sm">No media yet.</p>') + '</div>' +
    '</section>';
  }

  /* V3.851 — the one place a card's approval state is spelled out: who
   * proposed it and when; for a decider, Approve / Decline (the note form
   * opens inline); for the proposer, Withdraw, and after a decline the
   * note plus "Re-propose". Nothing for an approved card. */
  function approvalBanner(f) {
    if (RD.isApproved(f)) return '';
    var a = f.approval || {};
    var uid = state.me ? state.me.uid : null;
    var proposer = RD.proposerOf(f) || '';
    var mine = proposer === uid;
    var who = mine ? '<strong>you</strong>' : '<strong data-uname="' + esc(proposer) + '">…</strong>';
    var when = a.proposed_at ? ' on ' + esc(String(a.proposed_at).slice(0, 10)) : '';
    var canDecide = RD.mayDecide(f);
    var body = '', actions = '';
    if (RD.isProposed(f)) {
      body = '<div class="rf-approval-text">Proposed by ' + who + when +
        ' — awaiting approval from the PI or ' + (mine ? 'your' : 'their') + ' advisor.' +
        (a.reproposed && a.previous_note
          ? '<div class="rf-approval-note">Last time: “' + esc(a.previous_note) + '”</div>' : '') +
        (mine && !canDecide ? '<div class="rf-approval-hint">You can keep editing it until it is reviewed.</div>' : '') +
      '</div>';
      if (canDecide) actions = state.declining === f.id ? declineForm(f) : decideButtons(f);
    } else {
      body = '<div class="rf-approval-text">Declined by <strong data-uname="' + esc(a.decided_by || '') + '">…</strong>' +
        (a.decided_at ? ' on ' + esc(String(a.decided_at).slice(0, 10)) : '') + '.' +
        (a.note ? '<div class="rf-approval-note">“' + esc(a.note) + '”</div>' : '') +
        (mine ? '<div class="rf-approval-hint">Edit the card, then send it back for another look — or withdraw it.</div>' : '') +
      '</div>';
      if (mine) actions = '<span class="rf-sec-actions"><button class="rf-btn rf-btn-sm rf-btn-primary" data-act="repropose">Re-propose</button></span>';
      else if (canDecide) actions = '<span class="rf-sec-actions"><button class="rf-btn rf-btn-sm rf-btn-primary" data-act="approve" data-id="' + esc(f.id) + '">' + ICON.svg('check') + ' Approve after all</button></span>';
    }
    return '<div class="rf-approval rf-approval-' + esc(RD.approvalStatus(f)) + '">' + body + actions + '</div>';
  }

  function sectionDescription(f, canEdit) {
    var html = f.description_html ? RD.sanitizeHtml(f.description_html) : '';
    return '<section class="rf-sec rf-sec-desc">' +
      '<h2>Description</h2>' +
      (html ? '<div class="rf-richtext">' + html + '</div>'
            : '<p class="rf-empty-sm">' + (canEdit ? 'Use ✎ Edit card to write the description with the guided template.' : 'No description yet.') + '</p>') +
    '</section>';
  }

  function sectionOverview(f, canEdit) {
    // V3.851 — publishing stays the PI's, and only for an approved card.
    var canPublish = state.isAdmin && RD.isApproved(f);
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
          '<button class="rf-btn rf-btn-sm" data-act="edit-overview">' + ICON.svg('pencil') + ' Build overview</button>' +
          (canPublish && f.overview_blocks && f.overview_blocks.length
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
    // V3.717 — every parent level this card may point at, in PARENTS order,
    // so a grant shows its concepts and an aim shows its grant without this
    // function knowing the chain.
    var refs = RD.parentRefsOf(f);
    var wants = (RD.PARENTS[f.level] || []).map(function (l) { return RD.LEVELS[l].plural.toLowerCase(); }).join(' / ');
    return '<section class="rf-sec"><div class="rf-sec-head"><h2>Builds on</h2>' +
      (canEdit ? '<button class="rf-btn rf-btn-sm" data-act="edit-links" data-part="combine">' + ICON.svg('pencil') + '</button>' : '') + '</div>' +
      (refs.length ? '<div class="rf-combine">' + refs.map(function (r) {
        var t = byId(r.id); return t ? '<a class="rf-combine-pill" href="' + fociUrl(t.id) + '">' + iconHtml(t) + ' ' + esc(titleOf(t)) + '</a>' : '';
      }).join('') + '</div>' : '<p class="rf-empty-sm">No ' + esc(wants) + ' linked yet.</p>') +
    '</section>';
  }

  /* V3.717 — grants used to live INSIDE concepts (`grant_meta` + `kind:'grant'`
   * draft_refs). They are their own level now. These two helpers exist only
   * to spot concepts that still hold the old shape so the hub can offer the
   * one-click move; nothing renders from them. */
  function conceptHasLegacyGrant(f) {
    if (!f || f.level !== 'concept') return false;
    var gm = f.grant_meta;
    var refs = ((f.links && f.links.draft_refs) || []).filter(function (r) { return r.kind === 'grant'; });
    return refs.length > 0 || !!(gm && (gm.agency || gm.scope_html || gm.submit_to || gm.promoted_draft_id));
  }
  function legacyGrantConcepts() {
    return state.foci.filter(conceptHasLegacyGrant);
  }

  /* The cards one level DOWN from this one — a specialty's concepts, a
   * concept's grants, a grant's aims, an aim's outputs. Replaces V3.558's
   * concept/specialty-only "Outputs" section: the heading, the empty state
   * and the "＋ New" level all come from RD.PARENTS, so the chain is
   * described once (research-data.js) and rendered once (here). */
  function sectionChildren(f, canEdit) {
    var childLevels = RD.LEVEL_ORDER.filter(function (lvl) {
      return (RD.PARENTS[lvl] || []).indexOf(f.level) !== -1;
    });
    if (!childLevels.length) return '';
    return childLevels.map(function (lvl) {
      var meta = RD.LEVELS[lvl];
      var kids = RD.childrenOf(f, state.foci, [lvl]);
      // An empty legacy level (outputs hanging off a concept) is noise —
      // only offer it where it is the card's real child level.
      var primary = (RD.PARENTS[lvl] || [])[0] === f.level;
      if (!kids.length && !primary) return '';
      var actions = canEdit
        ? '<span class="rf-sec-actions">' +
            (lvl === 'output'
              ? '<button class="rf-btn rf-btn-sm" data-act="link-outputs">' + ICON.svg('pencil') + ' Link</button>' : '') +
            '<button class="rf-btn rf-btn-sm rf-btn-primary" data-act="new-child" data-level="' + lvl + '">' +
              ICON.svg('plus') + ' New</button>' +
          '</span>'
        : '';
      var body = kids.length
        ? '<div class="rf-combine">' + kids.map(function (o) {
            return '<a class="rf-combine-pill" href="' + fociUrl(o.id) + '">' + iconHtml(o) + ' ' + esc(titleOf(o)) + ' ' + statusPill(o) + '</a>';
          }).join('') + '</div>'
        : '<p class="rf-empty-sm">No ' + esc(meta.plural.toLowerCase()) + ' yet.' +
            (canEdit ? ' ' + esc(meta.blurb) : '') + '</p>';
      return '<section class="rf-sec rf-sec-children">' +
        '<div class="rf-sec-head"><h2>' + esc(meta.plural) + '</h2>' + actions + '</div>' + body +
      '</section>';
    }).join('');
  }

  /* The drafts and patents attached to an aim or output card. V3.717 — the
   * grant_meta block that used to trail this section has moved to the grant
   * review, where grant_meta now lives. */
  function sectionOutputs(f, canEdit) {
    var refs = f.links.draft_refs || [];
    var patents = f.links.patents || [];
    var head = '<div class="rf-sec-head"><h2>Papers, drafts &amp; patents</h2>' +
      (canEdit ? '<span class="rf-sec-actions">' +
        '<button class="rf-btn rf-btn-sm" data-act="new-paper">' + ICON.svg('plus') + ' Paper</button>' +
        '<button class="rf-btn rf-btn-sm" data-act="edit-links" data-part="drafts">' + ICON.svg('pencil') + ' Link</button>' +
      '</span>' : '') + '</div>';
    var body = '<div data-draft-pills>' +
      (refs.length ? refs.map(function (r) {
        return '<span class="rf-draft-pill" data-kind="' + esc(r.kind || 'paper') + '">' +
          '<a href="/rm/pages/paper-builder.html?paper=' + encodeURIComponent(r.id) + '">' +
          ICON.svg(r.kind === 'grant' ? 'bookmark-square' : 'pencil-square') + ' ' + esc(r.title || r.id) + '</a>' +
          '<span class="rf-draft-status" data-status-for="' + esc(r.id) + '">…</span></span>';
      }).join('') : '') +
      patents.map(function (p) {
        return '<span class="rf-draft-pill" data-kind="patent">' + ICON.svg('scale') + ' ' + esc(p.title || p.number || 'Patent') +
          (p.status ? ' <span class="rf-draft-status">' + esc(p.status) + '</span>' : '') + '</span>';
      }).join('') +
      (!refs.length && !patents.length ? '<p class="rf-empty-sm">No linked papers, grants, or patents yet.</p>' : '') +
    '</div>';
    return '<section class="rf-sec rf-sec-outputs">' + head + body + '</section>';
  }

  /* The grant_meta facts, shared by the grant review and the grant card's
   * own editor. V3.717 — one renderer so the two never drift. */
  function grantMetaBlock(f, canEdit) {
    var gm = f.grant_meta || {};
    var rows = [
      gm.agency ? '<div><strong>Agency:</strong> ' + esc(gm.agency) + (gm.mechanism ? ' · ' + esc(gm.mechanism) : '') + '</div>' : '',
      gm.submit_to ? '<div><strong>Submit to:</strong> ' + (gm.submission_url ? '<a href="' + esc(gm.submission_url) + '" target="_blank" rel="noopener">' + esc(gm.submit_to) + '</a>' : esc(gm.submit_to)) + '</div>' : '',
      gm.target_deadline && gm.target_deadline !== 'TBD' ? '<div><strong>Target deadline:</strong> ' + esc(gm.target_deadline) + '</div>' : '',
      gm.award_number ? '<div><strong>Award number:</strong> ' + esc(gm.award_number) + '</div>' : '',
      (gm.period_start || gm.period_end) ? '<div><strong>Period:</strong> ' + esc(gm.period_start || 'TBD') + ' → ' + esc(gm.period_end || 'TBD') + '</div>' : '',
    ].filter(Boolean).join('');
    var scope = gm.scope_html ? '<div class="rf-richtext">' + RD.sanitizeHtml(gm.scope_html) + '</div>' : '';
    var promote = (canEdit && !gm.promoted_draft_id && !f.source_draft_id)
      ? '<button class="rf-btn rf-btn-sm rf-btn-primary" data-act="promote-grant">Promote to grant draft →</button>' : '';
    if (!rows && !scope && !promote) return '';
    return '<div class="rf-grant-meta">' + rows + scope + promote + '</div>';
  }

  /* V3.630 — `links.theme_id` is the ONE bridge between a focus card ("what a
   * paper is FOR") and a library topic ("what it's ABOUT"), and it was
   * half-built: it printed the raw kebab slug instead of the topic's name, and
   * linked to the Topics tab WITHOUT the `&theme=` deep link that tab has
   * supported since V3.367. Both fixed here. `_themeNames` is filled by one
   * 6-doc get in init(); an unresolved id still falls back to the slug so this
   * never renders empty. The reverse direction (a topic listing the focus
   * cards that point at it) is V3.631. */
  var _themeNames = null;   // id → name, or null until loaded

  async function loadThemeNames() {
    try {
      var snap = await firebridge.db().collection('labThemes').get();
      var map = {};
      snap.docs.forEach(function (d) { map[d.id] = (d.data().name || d.id); });
      _themeNames = map;
    } catch (e) {
      _themeNames = {};   // never retry-loop; the slug fallback is fine
    }
  }

  function sectionTheme(f, canEdit) {
    if (!f.links.theme_id && !canEdit) return '';
    var id = f.links.theme_id;
    var name = (_themeNames && _themeNames[id]) || id;
    return '<section class="rf-sec"><div class="rf-sec-head"><h2>Topic</h2>' +
      (canEdit ? '<button class="rf-btn rf-btn-sm" data-act="edit-links" data-part="theme">' + ICON.svg('pencil') + '</button>' : '') + '</div>' +
      (id
        ? '<a class="rf-theme-link" href="/rm/pages/library.html?tab=themes&theme=' +
            encodeURIComponent(id) + '" title="Open this topic’s papers, notes and key labs">' + ICON.svg('books') + ' ' +
            esc(name) + ' →</a>'
        : '<p class="rf-empty-sm">No linked topic — the literature this card sits on.</p>') +
    '</section>';
  }

  function sectionTrainings(f, canEdit) {
    var slugs = f.links.training_slugs || [];
    if (!slugs.length && !canEdit) return '';
    return '<section class="rf-sec"><div class="rf-sec-head"><h2>Trainings</h2>' +
      (canEdit ? '<button class="rf-btn rf-btn-sm" data-act="edit-links" data-part="trainings">' + ICON.svg('pencil') + '</button>' : '') + '</div>' +
      (slugs.length ? '<div class="rf-combine">' + slugs.map(function (s) {
        return '<a class="rf-combine-pill" href="/rm/pages/training-' + esc(s) + '.html">' + ICON.svg('academic-cap') + ' ' + esc(s) + '</a>';
      }).join('') + '</div>' : '<p class="rf-empty-sm">No linked trainings.</p>') +
    '</section>';
  }

  function sectionPeople(f, canEdit) {
    var uids = f.member_uids || [];
    return '<section class="rf-sec rf-sec-people"><div class="rf-sec-head"><h2>Aligned people</h2>' +
      (canEdit ? '<button class="rf-btn rf-btn-sm" data-act="edit-links" data-part="people">' + ICON.svg('pencil') + '</button>' : '') + '</div>' +
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

  /* ── GRANT REVIEW (V3.717) ──────────────────────────────────── */

  /* A grant is the unit the lab's work is actually spent against, so its
   * page answers "what is happening under this grant?" rather than "what is
   * this card?". Structure and the people roll-up live in
   * research-grant-review.js; this owns the frame, the status control, and
   * the sections it shares with every other card. */
  function renderGrantReview(f, canEdit) {
    var gm = f.grant_meta || {};
    var agency = [gm.agency, gm.mechanism].filter(Boolean).join(' · ');
    var draftPill = '';
    if (f.source_draft_id) {
      var d = draftInfo(f);
      draftPill = '<a class="rf-draft-pill" data-kind="grant" href="/rm/pages/paper-builder.html?paper=' +
        encodeURIComponent(f.source_draft_id) + '">' + ICON.svg('bookmark-square') + ' open in builder' +
        (d && d.status ? '<span class="rf-draft-status">' + esc(d.status) + '</span>' : '') + '</a>';
    }

    root.innerHTML =
      '<div class="rf-detail rf-grant-review" data-foci="' + esc(f.id) + '">' +
        '<nav class="rf-crumbs"><a href="/rm/pages/research.html">Research map</a>' +
          '<span class="rf-crumb-sep">/</span><span>' + esc(RD.LEVELS.grant.plural) + '</span></nav>' +
        '<header class="rf-detail-head"' + (f.color ? ' style="--rf-accent:' + esc(f.color) + '"' : '') + '>' +
          '<div class="rf-detail-title">' +
            '<span class="rf-icon-tile rf-icon-tile-lg">' + iconHtml(f, '30px') + '</span>' +
            '<div>' +
              '<span class="rf-detail-level">' + esc(RD.LEVELS.grant.label) + '</span>' +
              '<h1>' + esc(titleOf(f)) + (f.abbr ? ' <span class="rf-detail-abbr">' + esc(f.abbr) + '</span>' : '') + '</h1>' +
              (agency ? '<p class="rf-grant-agency">' + esc(agency) + '</p>' : '') +
              (f.one_liner ? '<p class="rf-detail-liner">' + esc(f.one_liner) + '</p>' : '') +
              (draftPill ? '<div class="rf-grant-draft">' + draftPill + '</div>' : '') +
            '</div>' +
          '</div>' +
          '<div class="rf-detail-meta">' + grantStatusControl(f, canEdit) +
            (canEdit
              ? '<button class="rf-btn" data-act="edit">' + ICON.svg('pencil') + ' Edit</button>' +
                '<button class="rf-btn rf-btn-danger" data-act="delete">Delete</button>'
              : '') +
          '</div>' +
        '</header>' +
        // Filled by research-grant-review.js: aims, outputs, drafts, and the
        // per-person roll-up (one focusAreas read per member, denied reads
        // degrade to a hidden-count rather than an error).
        approvalBanner(f) +
        '<div data-grant-review><p class="rf-empty-sm">Loading what’s happening under this grant…</p></div>' +
        '<div class="rf-detail-grid">' +
          '<div class="rf-detail-main">' +
            sectionMedia(f, canEdit) +
            sectionDescription(f, canEdit) +
            sectionOverview(f, canEdit) +
          '</div>' +
          '<aside class="rf-detail-side">' +
            '<section class="rf-sec rf-sec-grant"><div class="rf-sec-head"><h2>Grant details</h2>' +
              (canEdit ? '<button class="rf-btn rf-btn-sm" data-act="edit">' + ICON.svg('pencil') + '</button>' : '') +
            '</div>' +
            (grantMetaBlock(f, canEdit) || '<p class="rf-empty-sm">No agency, mechanism, or deadline recorded yet.</p>') +
            '</section>' +
            sectionCombine(f, canEdit) +
            sectionTheme(f, canEdit) +
            sectionTrainings(f, canEdit) +
            // V3.722 — no "Aligned people" here. The grant's roster lives in
            // "Work under this grant" below, with primary/secondary roles and
            // its own editor; a second list with a second editor for the same
            // member_uids is how the two drift.
          '</aside>' +
        '</div>' +
      '</div>';

    if (window.RESEARCH_MEDIA) {
      var mc = root.querySelector('[data-media-gallery]');
      if (mc) RESEARCH_MEDIA.renderGallery(mc, f, { editable: canEdit });
    }
    GRANT_REVIEW.render(root.querySelector('[data-grant-review]'), f, state);
  }

  /* The one source of truth for where a grant stands. Admin gets an inline
   * <select> — no modal, no page hop — over RD.GRANT_STATUSES; everyone else
   * sees the pill. Never derived from a linked draft (see effStatus). */
  function grantStatusControl(f, canEdit) {
    if (!canEdit) return statusPill(f);
    return '<label class="rf-grant-status-set">' +
      '<span class="rf-sr-only">Grant status</span>' +
      '<select data-grant-status>' + RD.GRANT_STATUSES.map(function (s) {
        return '<option value="' + s + '"' + (f.status === s ? ' selected' : '') + '>' +
          esc(RD.STATUS_META[s].label) + '</option>';
      }).join('') + '</select></label>';
  }

  async function onGrantStatusChange(sel) {
    var f = state.viewId ? byId(state.viewId) : null;
    if (!f) return;
    var next = sel.value, prev = f.status;
    sel.disabled = true;
    try {
      await RD.update(f.id, { status: next, status_source: 'manual' });
      f.status = next;
      toast('success', 'Grant marked ' + RD.STATUS_META[next].label.toLowerCase() + '.');
    } catch (err) {
      sel.value = prev;
      toast('error', 'Could not save the status: ' + (err && err.message));
    }
    sel.disabled = false;
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
      // V3.851 — the whole map rides along so the composer can offer the
      // parent cards ("Builds on") without a second read.
      if (window.RESEARCH_COMPOSER) RESEARCH_COMPOSER.openCreate(t.getAttribute('data-level'), afterMutation, null, state.all);
      return;
    }
    // V3.851 — approval moves. The hub strip carries data-id; on a card's
    // own page the card is `detail`. Above the `if (!detail)` gate for that
    // reason.
    if (act === 'approve' || act === 'decline' || act === 'decline-cancel' || act === 'repropose') {
      var target = byId(t.getAttribute('data-id')) || detail;
      if (act === 'decline-cancel') { state.declining = null; render(); return; }
      if (!target) return;
      if (act === 'approve') { doApprove(target); return; }
      if (act === 'decline') { state.declining = target.id; render(); focusDeclineNote(target.id); return; }
      if (act === 'repropose') { doRepropose(target); return; }
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
    if (act === 'migrate-grants') { migrateGrantsOutOfConcepts(); return; }
    if (!detail) return;
    // V3.717 — grants are their own level. ✎ edits THIS grant card's
    // grant_meta; ⤵ attaches a builder grant draft to it. The old
    // one-grant-per-concept confirm() is gone with the rule it enforced.
    if (act === 'grant-idea') {
      if (window.RESEARCH_CREATE) RESEARCH_CREATE.openGrantIdea(detail, afterMutation);
      return;
    }
    if (act === 'edit-grant-people') {
      if (window.GRANT_REVIEW) GRANT_REVIEW.openPeopleEditor(detail, afterMutation);
      return;
    }
    if (act === 'grant-link') {
      if (window.RESEARCH_LINKS) RESEARCH_LINKS.openGrantLinker(detail, afterMutation);
      return;
    }
    if (act === 'edit') { if (window.RESEARCH_COMPOSER) RESEARCH_COMPOSER.openEdit(detail, afterMutation); return; }
    if (act === 'edit-overview') { if (window.RESEARCH_COMPOSER) RESEARCH_COMPOSER.openOverview(detail, afterMutation); return; }
    if (act === 'add-media') { if (window.RESEARCH_MEDIA) RESEARCH_MEDIA.openUploader(detail, afterMutation); return; }
    if (act === 'edit-links') { if (window.RESEARCH_LINKS) RESEARCH_LINKS.openEditor(detail, state.foci, t.getAttribute('data-part'), afterMutation); return; }
    if (act === 'new-paper') { if (window.RESEARCH_CREATE) RESEARCH_CREATE.openPaper(detail, afterMutation); return; }
    if (act === 'link-outputs') { if (window.RESEARCH_LINKS) RESEARCH_LINKS.openOutputLinker(detail, state.foci, afterMutation); return; }
    if (act === 'new-child') {
      if (window.RESEARCH_COMPOSER) {
        // Pre-link the new child back to this card so it auto-propagates
        // the moment it's created — the link key comes from the PARENTS
        // table, so this one handler serves every level in the chain.
        var ck = RD.LINK_KEY[detail.level];
        var cs = {}; if (ck) cs[ck] = [detail.id];
        RESEARCH_COMPOSER.openCreate(t.getAttribute('data-level'), afterMutation, { links: cs }, state.all);
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

  /* ── V3.851 approval moves ──────────────────────────────────── */

  async function doApprove(f) {
    try {
      await RD.approve(f);
      toast('success', '“' + titleOf(f) + '” is approved and on the map.');
      await afterMutation();
    } catch (err) { toast('error', 'Could not approve: ' + (err && err.message)); }
  }
  async function doDecline(f, note) {
    try {
      await RD.decline(f, note);
      state.declining = null;
      toast('success', 'Declined — the proposer has been told.');
      await afterMutation();
    } catch (err) { toast('error', 'Could not decline: ' + (err && err.message)); }
  }
  async function doRepropose(f) {
    try {
      await RD.repropose(f);
      toast('success', 'Sent back for another look — the PI and your advisor will see it.');
      await afterMutation();
    } catch (err) { toast('error', 'Could not re-propose: ' + (err && err.message)); }
  }
  function focusDeclineNote(id) {
    var ta = root.querySelector('[data-decline-form="' + CSS.escape(id) + '"] textarea');
    if (ta) ta.focus();
  }
  function onSubmit(e) {
    var form = e.target.closest && e.target.closest('[data-decline-form]');
    if (!form) return;
    e.preventDefault();
    var f = byId(form.getAttribute('data-decline-form'));
    var ta = form.querySelector('textarea');
    if (!f) return;
    form.querySelectorAll('button').forEach(function (b) { b.disabled = true; });
    doDecline(f, ta ? ta.value : '');
  }

  /* Names for every [data-uname="<uid>"] on the page, from users/{uid}
   * (lab-readable). One get per distinct uid, cached for the page's life. */
  var _names = {};
  async function hydrateNames() {
    if (!root) return;
    var els = Array.prototype.slice.call(root.querySelectorAll('[data-uname]'));
    var uids = {}; els.forEach(function (el) { var u = el.getAttribute('data-uname'); if (u) uids[u] = 1; });
    await Promise.all(Object.keys(uids).map(async function (uid) {
      if (!_names[uid]) {
        try {
          var d = await firebridge.db().collection('users').doc(uid).get();
          _names[uid] = (d.exists && (d.data().name || d.data().displayName || d.data().email)) || uid;
        } catch (e) { _names[uid] = uid; }
      }
      els.forEach(function (el) { if (el.getAttribute('data-uname') === uid) el.textContent = _names[uid]; });
    }));
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
      var okDetach = await confirmDialog({
        title: 'Detach this paper?',
        okLabel: 'Detach', danger: true,
        bodyHtml: '<p>It comes off the roadmap here. The paper itself stays in the library.</p>',
      });
      if (!okDetach) return;
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
    var okRemove = await confirmDialog({
      title: 'Remove from the research map?',
      okLabel: 'Remove from map', danger: true,
      bodyHtml: '<p><strong>' + esc(titleOf(f)) + '</strong> comes off the map.</p>' +
        '<p class="rf-empty-sm">The paper itself is NOT deleted — it stays in the builder, and “' + ICON.svg('arrow-turn-right-down') + ' Add existing paper” puts it back any time.</p>',
    });
    if (!okRemove) return;
    try {
      if (window.RESEARCH_PUBLISH && f.published) { try { await RESEARCH_PUBLISH.unpublish(f); } catch (e) {} }
      await RD.remove(f.id);
      toast('success', 'Removed from the map.');
      window.location.href = '/rm/pages/research.html';
    } catch (err) { toast('error', 'Remove failed: ' + (err && err.message)); }
  }

  /* Inline confirm on the RD.modal shell. The lab rule is that a decision is
   * made IN the surface already open — never a browser popup, which also
   * hangs any headless run that stubs window.confirm. Resolves true/false. */
  function confirmDialog(opts) {
    return new Promise(function (resolve) {
      var settled = false;
      function done(v) { if (settled) return; settled = true; resolve(v); }
      var m = RD.modal({ title: opts.title, onClose: function () { done(false); } });
      m.body.innerHTML =
        '<div class="rf-confirm-body">' + (opts.bodyHtml || '') + '</div>' +
        '<div class="rf-modal-actions">' +
          '<button type="button" class="rf-btn" data-act="no">' + esc(opts.cancelLabel || 'Cancel') + '</button>' +
          '<button type="button" class="rf-btn ' + (opts.danger ? 'rf-btn-danger' : 'rf-btn-primary') + '" data-act="yes">' +
            esc(opts.okLabel || 'Continue') + '</button>' +
        '</div>';
      m.body.addEventListener('click', function (e) {
        var a = e.target.closest('[data-act]');
        if (!a) return;
        var yes = a.getAttribute('data-act') === 'yes';
        done(yes);
        m.close();
      });
      var ok = m.body.querySelector('[data-act="yes"]');
      if (ok) ok.focus();
    });
  }

  /* ── V3.717 migration: grants out of concepts ───────────────── */

  /* Before V3.717 a grant was a facet of a concept — `grant_meta` plus
   * `kind:'grant'` entries in the concept's draft_refs. Each of those
   * becomes its own grant card linked back to the concept it came from.
   * Idempotent: a concept whose grant card already exists is skipped, so
   * re-running reports nothing to move. */
  async function migrateGrantsOutOfConcepts() {
    var todo = legacyGrantConcepts();
    if (!todo.length) { toast('info', 'No grants left inside concepts.'); return; }

    var plan = todo.map(function (c) {
      var refs = ((c.links && c.links.draft_refs) || []).filter(function (r) { return r.kind === 'grant'; });
      var ref = refs[0] || null;
      return {
        concept: c,
        ref: ref,
        // The builder draft's slug makes the best card id — the grant and
        // its draft then share one name. Fall back to the concept's.
        id: RD.slugify((ref && ref.id) || (c.id + '-grant')),
        title: (ref && ref.title) || (c.title + ((c.grant_meta && c.grant_meta.agency) ? ' — ' + c.grant_meta.agency : ' grant')),
      };
    }).filter(function (p) { return !byId(p.id); });

    if (!plan.length) { toast('info', 'Those grant cards already exist — nothing to move.'); return; }

    var okd = await confirmDialog({
      title: 'Move grants out of concepts',
      okLabel: 'Move ' + plan.length + ' grant' + (plan.length === 1 ? '' : 's'),
      bodyHtml:
        '<p>Each of these becomes its own <strong>grant card</strong>, linked back to the concept it came from. ' +
        'Every new card starts as <em>In preparation</em> — set the real status on each afterwards.</p>' +
        '<ul class="rf-confirm-list">' + plan.map(function (p) {
          return '<li>' + esc(p.title) + ' <span class="rf-mini-status">from ' + esc(p.concept.title) + '</span></li>';
        }).join('') + '</ul>' +
        '<p class="rf-empty-sm">The concepts keep everything else; only the grant moves. Safe to run again.</p>',
    });
    if (!okd) return;

    var moved = 0, failed = 0;
    for (var i = 0; i < plan.length; i++) {
      var p = plan[i], c = p.concept;
      try {
        await RD.create({
          id: p.id,
          level: 'grant',
          title: p.title,
          one_liner: c.one_liner || '',
          color: c.color || '',
          status: 'in_preparation',
          status_source: 'manual',
          grant_meta: c.grant_meta || null,
          source_draft_id: p.ref ? p.ref.id : null,
          links: Object.assign(
            { concept_ids: [c.id] },
            p.ref ? { draft_refs: [p.ref] } : {}
          ),
          member_uids: (c.member_uids || []).slice(),
          member_roles: Object.assign({}, c.member_roles || {}),
        });
        // Only now strip the concept — a failed create must not lose data.
        var keptRefs = ((c.links && c.links.draft_refs) || []).filter(function (r) { return r.kind !== 'grant'; });
        await RD.update(c.id, { grant_meta: null, 'links.draft_refs': keptRefs });
        moved++;
      } catch (err) {
        failed++;
        console.warn('[research] grant migration failed for', p.id, err && err.message);
      }
    }
    toast(failed ? 'error' : 'success',
      moved + ' grant' + (moved === 1 ? '' : 's') + ' moved out of concepts.' +
      (failed ? ' ' + failed + ' failed — see the console.' : ' Set each one’s real status next.'));
    await afterMutation();
  }

  // Seed the six lab specialty cards as editable stubs (admin only).
  var SEED_SPECIALTIES = [
    { id: 'mebp', title: 'Microscope-Enabled Bioprinting', abbr: 'MEBP', icon: 'microscope', one_liner: 'In-situ printing under live microscopy.' },
    { id: 'in-situ-elisa', title: 'In-Situ ELISA', abbr: 'ELISA', icon: 'beaker', one_liner: 'Spatially-resolved protein readout in place.' },
    { id: 'gels', title: 'Granule-Enabled Living Scaffolds', abbr: 'GELS', icon: 'circle-dot', one_liner: 'Granular hydrogels as living tissue scaffolds.' },
    { id: 'cels', title: 'Cell-Embedded Living Scaffold', abbr: 'CELS', icon: 'puzzle-piece', one_liner: 'Cells embedded directly into the scaffold matrix.' },
    { id: 'stem', title: 'Spatio-Temporal Embedded Morphogens', abbr: 'STEM', icon: 'sprout', one_liner: 'Morphogen gradients patterned in space and time.' },
    { id: 'tfm', title: 'Traction Force Microscopy', abbr: 'TFM', icon: 'variable', one_liner: 'Measuring the forces cells exert on their matrix.' },
  ];
  async function seedSpecialties(btn) {
    var okSeed = await confirmDialog({
      title: 'Seed the 6 lab specialties?',
      okLabel: 'Create them',
      bodyHtml: '<p>Creates MEBP, In-Situ ELISA, GELS, CELS, STEM and TFM as editable stubs. Rename, describe, or delete any of them freely afterwards.</p>',
    });
    if (!okSeed) return;
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
    // V3.851 — a proposer taking back their own undecided card is a withdrawal.
    var withdraw = !RD.isApproved(f) && RD.proposerOf(f) === (state.me && state.me.uid);
    var okDel = await confirmDialog({
      title: withdraw ? 'Withdraw this proposal?' : 'Delete this card?',
      okLabel: withdraw ? 'Withdraw' : 'Delete', danger: true,
      bodyHtml: '<p><strong>' + esc(f.title) + '</strong> ' + (withdraw ? 'comes off the map; nobody needs to approve or decline it.' : 'is removed from the map and unpublished.') + '</p>' +
        '<p class="rf-empty-sm">Attached students and linked drafts are not affected. Cards linked to it keep their link ids, which simply stop resolving.</p>',
    });
    if (!okDel) return;
    try {
      if (window.RESEARCH_PUBLISH) { try { await RESEARCH_PUBLISH.unpublish(f); } catch (e) {} }
      await RD.remove(f.id);
      toast('success', withdraw ? 'Withdrawn.' : 'Deleted.');
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
    // V3.851 — who may propose, and (for a mentor) whose proposals they
    // decide. The mentee set must be in hand before the first render, or
    // the approvals strip would miss a mentor's own mentees.
    state.canPropose = !state.isAdmin && RD.canPropose();
    if (!state.isAdmin) await RD.loadMentees();
    var params = new URLSearchParams(location.search);
    state.viewId = params.get('id') || null;

    root.addEventListener('click', onClick);
    root.addEventListener('submit', onSubmit);   // V3.851 — inline decline note
    // V3.717 — the grant status <select> saves on change, in place. It is
    // the one place a grant's status is ever set.
    root.addEventListener('change', function (e) {
      var sel = e.target.closest('[data-grant-status]');
      if (sel) onGrantStatusChange(sel);
    });
    root.addEventListener('keydown', function (e) {
      if (e.key !== 'Enter' && e.key !== ' ') return;
      var card = e.target.closest && e.target.closest('[data-expand]');
      if (card && e.target === card) { e.preventDefault(); card.click(); }
    });
    await loadAll();
    await loadThemeNames();   // V3.630 — so the topic link shows a name, not a slug
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
