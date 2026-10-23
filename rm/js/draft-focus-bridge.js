/* draft-focus-bridge.js — V3.631 (library-categorization program R3)
 *
 * "Linking this paper to a draft" and "attaching it to that draft's card on
 * the research map" were two storages for one act:
 *
 *   items/{id}.meta.library.linked_drafts   ← the draft link
 *   researchFoci/{fociId}/refs/{refId}      ← the roadmap attachment
 *
 * An `output` focus card frequently IS a draft — it carries
 * `source_draft_id` (created from it) and/or `links.draft_refs[]` (the PI
 * pointed it there) — so a student had to know both existed and do both,
 * with nothing on screen suggesting the second one. In the real lab data
 * `linked_drafts` has 105 papers on it and the refs subcollections have ZERO.
 *
 * So: after a draft link lands from an interactive picker, if a focus card
 * represents that draft and this paper isn't attached there yet, offer to do
 * the other half — and ask for the **note**, which is the entire reason
 * roadmap refs exist ("this paper matters to that experiment, and here is
 * why") and which the draft-link axis has never had.
 *
 * Rules of engagement:
 *   - The link has ALREADY happened when we open. Nothing here can undo it,
 *     and Skip is always free. This is an offer, never a gate.
 *   - Only wired to the two INTERACTIVE pickers. Never to
 *     PAPER_OVERLAYS.linkDraft itself, because that is what
 *     library-paper.js's _ensureDraftLinked calls while the user is filing a
 *     highlight (V3.629) — a modal must not ambush that flow.
 *   - Bulk paths (reference import, .paperbundle, overlay-md) link dozens of
 *     papers at once and deliberately never prompt.
 *   - Attaches to the roadmap ROOT target ({kind:'roadmap', id:null}) since
 *     a draft link says nothing about WHICH experiment. Refining to an
 *     experiment/analysis is the 🗺 modal's job (ROADMAP_ATTACH).
 *
 * Reuses the reader's picker CSS (.lp-overlay-import-modal / .lp-oim-*)
 * rather than inventing another modal look.
 *
 * Public API (window.DRAFT_FOCUS_BRIDGE):
 *   offerForDrafts({ item, draftIds, onDone }) → Promise<number>
 *     Resolves with how many roadmap refs were written. Safe to await and
 *     safe to ignore; resolves 0 immediately when there's nothing to offer.
 */
(function () {
  'use strict';

  function _esc(s) {
    return String(s == null ? '' : s).replace(/[&<>"']/g, function (c) {
      return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c];
    });
  }

  /* V3.717 — five levels now; show the label ("Aim"), not the slug. This
   * page does not always load research-data.js, so fall back to the slug. */
  function _levelLabel(level) {
    var L = window.RESEARCH_DATA && RESEARCH_DATA.LEVELS[level];
    return L ? L.label : (level || '');
  }

  function _toast(kind, msg) {
    if (window.TOAST && window.TOAST[kind]) window.TOAST[kind](msg);
    else if (kind === 'error') alert(msg);
  }

  function _snapshotOf(item) {
    // Same shape ROADMAP_ATTACH writes, so a ref created here is
    // indistinguishable from one created there.
    var lib = (item && item.meta && item.meta.library) || {};
    var authors = Array.isArray(lib.authors) ? lib.authors : [];
    var names = authors.slice(0, 3).map(function (a) {
      return (a && (a.family || a.given)) ? (a.family || a.given) : String(a || '');
    }).filter(Boolean);
    if (authors.length > 3) names.push('et al.');
    return {
      title: item.title || lib.title || item.id,
      authors: names.join(', '),
      year: lib.year || '',
    };
  }

  function _draftTitle(draftId) {
    if (window.LIBRARY_ASSOC && window.LIBRARY_ASSOC.resolve) {
      var info = window.LIBRARY_ASSOC.resolve(draftId);
      if (info && info.title) return info.title;
    }
    return draftId;
  }

  /* Which (draft, card) pairs are worth offering: a card represents the
   * draft, and this paper is not already attached to that card. The
   * already-attached check reads the paper's own meta.library.roadmaps
   * mirror — no query, and it's the same field the reader's chip count uses. */
  async function _pending(item, draftIds) {
    var RM = window.ROADMAP_DATA;
    if (!RM || !RM.cardsForDraft) return [];
    var lib = (item && item.meta && item.meta.library) || {};
    var already = Array.isArray(lib.roadmaps) ? lib.roadmaps : [];
    var out = [];
    var seenCard = {};
    for (var i = 0; i < draftIds.length; i++) {
      var draftId = draftIds[i];
      var cards;
      try { cards = await RM.cardsForDraft(draftId); }
      catch (e) { continue; }
      for (var j = 0; j < cards.length; j++) {
        var c = cards[j];
        if (already.indexOf(c.id) !== -1) continue;   // already on that card
        if (seenCard[c.id]) continue;                 // two drafts, one card
        seenCard[c.id] = true;
        out.push({ draftId: draftId, card: c });
      }
    }
    return out;
  }

  async function offerForDrafts(opts) {
    opts = opts || {};
    var item = opts.item;
    var draftIds = (opts.draftIds || []).filter(Boolean);
    if (!item || !item.id || !draftIds.length) return 0;

    var RM = window.ROADMAP_DATA;
    if (!RM || !RM.addRef) return 0;

    var pending = await _pending(item, draftIds);
    if (!pending.length) return 0;

    var old = document.getElementById('dfb-offer-modal');
    if (old) old.remove();

    var rows = pending.map(function (p, idx) {
      return '' +
        '<div class="dfb-row" data-idx="' + idx + '">' +
          '<label class="dfb-check">' +
            '<input type="checkbox" data-dfb-on checked>' +
            '<span class="dfb-card">' + ICON.render(p.card.icon) + ' ' + _esc(p.card.title) + '</span>' +
            '<span class="dfb-level">' + _esc(_levelLabel(p.card.level)) + '</span>' +
          '</label>' +
          '<div class="dfb-because">for <b>' + _esc(_draftTitle(p.draftId)) + '</b></div>' +
          '<div class="dfb-why">' +
            '<select class="dfb-rel">' +
              [3, 2, 1].map(function (w) {
                return '<option value="' + w + '"' + (w === 2 ? ' selected' : '') + '>' +
                  _esc((RM.RELEVANCE && RM.RELEVANCE[w]) || String(w)) + '</option>';
              }).join('') +
            '</select>' +
            '<input type="text" class="dfb-note" placeholder="Why does this paper belong here?">' +
          '</div>' +
        '</div>';
    }).join('');

    var modal = document.createElement('div');
    modal.id = 'dfb-offer-modal';
    modal.className = 'lp-overlay-import-modal';
    modal.innerHTML = '' +
      '<div class="lp-oim-backdrop"></div>' +
      '<div class="lp-oim-card">' +
        '<div class="lp-oim-head">Linked — also add it to the research map?</div>' +
        '<div class="lp-oim-summary">' +
          (pending.length === 1
            ? 'That draft is on the research map. Adding the paper there too is what lets '
            : 'Those drafts are on the research map. Adding the paper there too is what lets ') +
          'anyone reading the roadmap see which literature it rests on — and the note is the point: ' +
          'the next person wants to know <b>why</b> this paper belongs.' +
        '</div>' +
        '<div class="dfb-rows">' + rows + '</div>' +
        '<div class="lp-oim-foot">' +
          '<button class="btn btn-sm" id="dfb-skip">Not now</button>' +
          '<button class="btn btn-sm lp-oim-primary" id="dfb-save">Add to the map</button>' +
        '</div>' +
      '</div>';
    document.body.appendChild(modal);

    return new Promise(function (resolve) {
      var settled = false;
      function done(n) {
        if (settled) return;
        settled = true;
        modal.remove();
        document.removeEventListener('keydown', onKey, true);
        resolve(n);
      }
      function onKey(ev) { if (ev.key === 'Escape') done(0); }

      modal.querySelector('.lp-oim-backdrop').addEventListener('click', function () { done(0); });
      modal.querySelector('#dfb-skip').addEventListener('click', function () { done(0); });
      document.addEventListener('keydown', onKey, true);

      // Hide the why-row when its checkbox is off, same affordance as
      // ROADMAP_ATTACH's reveal-on-check.
      modal.addEventListener('change', function (ev) {
        var cb = ev.target.closest && ev.target.closest('input[data-dfb-on]');
        if (!cb) return;
        var why = cb.closest('.dfb-row').querySelector('.dfb-why');
        if (why) why.hidden = !cb.checked;
      });

      var first = modal.querySelector('.dfb-note');
      if (first) setTimeout(function () { try { first.focus(); } catch (e) {} }, 0);

      modal.querySelector('#dfb-save').addEventListener('click', async function (ev) {
        var btn = ev.currentTarget;
        btn.disabled = true;
        btn.textContent = 'Adding…';
        var written = 0, failed = 0;
        var snapshot = _snapshotOf(item);
        var rowEls = Array.prototype.slice.call(modal.querySelectorAll('.dfb-row'));
        for (var i = 0; i < rowEls.length; i++) {
          var row = rowEls[i];
          var on = row.querySelector('input[data-dfb-on]');
          if (!on || !on.checked) continue;
          var p = pending[parseInt(row.getAttribute('data-idx'), 10)];
          if (!p) continue;
          var relEl = row.querySelector('.dfb-rel');
          var noteEl = row.querySelector('.dfb-note');
          try {
            await RM.addRef(p.card.id, {
              itemId: item.id,
              target: { kind: 'roadmap', id: null },
              note: noteEl ? noteEl.value : '',
              relevance: relEl ? (parseInt(relEl.value, 10) || 2) : 2,
              snapshot: snapshot,
            });
            // addRef mirrors the card id onto meta.library.roadmaps, but it
            // wrote through LIBRARY_LINKS against Firestore — patch the
            // in-memory item too so the caller's re-render (and a second
            // offer in the same session) sees the truth.
            item.meta = item.meta || {};
            item.meta.library = item.meta.library || {};
            var arr = Array.isArray(item.meta.library.roadmaps)
              ? item.meta.library.roadmaps : [];
            if (arr.indexOf(p.card.id) === -1) arr.push(p.card.id);
            item.meta.library.roadmaps = arr;
            written++;
          } catch (e) {
            failed++;
            console.warn('[draft-focus-bridge] addRef failed for', p.card.id, e && e.message);
          }
        }
        if (failed) _toast('error', 'Could not add ' + failed + ' of them to the map.');
        else if (written) _toast('success', written === 1
          ? 'Added to the research map.'
          : 'Added to ' + written + ' roadmap cards.');
        if (written && typeof opts.onDone === 'function') {
          try { opts.onDone(written); } catch (e) { /* caller's problem */ }
        }
        done(written);
      });
    });
  }

  window.DRAFT_FOCUS_BRIDGE = { offerForDrafts: offerForDrafts };
})();
