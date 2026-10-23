/* paper-evidence-inbox.js — V3.350
 *
 * "Reading evidence for this draft" — the reader→builder bridge
 * (FuturePlan 08, Release 1). The paper reader lets a student flag any
 * highlight with "Cite in draft X" (annotation.cite_in_drafts) and tag
 * highlights as claim evidence; until now the builder never read either
 * signal back. This module renders both into a collapsible section at
 * the top of the References pill tab: every highlight destined for this
 * draft, grouped by source paper, with the quote, the student's
 * comment, stance/type badges, one-click Insert-citation at the caret,
 * and an Open-highlight deep link (#ann-{annId}, made live in
 * library-paper.js this release).
 *
 * Data sources (deduped by paperId|annId):
 *   1. cite_in_drafts queries — for each paper in the fan-out set
 *      (linked to this draft ∪ already cited ∪ referenced by claims),
 *      TWO one-shot Firestore queries mirroring ANNOTATION_SYNC's
 *      split, because the annotations read rule only *proves*
 *      visibility=='lab' or own-uid:
 *        Q1  visibility=='lab'         AND cite_in_drafts contains draft
 *        Q2  creator.uid==me AND
 *            visibility=='private'     AND cite_in_drafts contains draft
 *      Others' private highlights are excluded by construction — the
 *      same guarantee the reader gives. No rules change needed.
 *   2. Claims evidence — this draft's claims
 *      (PaperBulletClaims.getAllClaims) reference annotations as
 *      {paperId, annId}; each is fetched by id and a rules rejection
 *      (someone else's private highlight) is silently skipped.
 *
 * No live subscriptions: rows load when the References tab opens, on
 * the section's ↻ button, and (debounced) on 'paper-citations-loaded'.
 * A 5-minute staleness window makes repeat renders free.
 *
 * Public surface (consumed by paper-equations.js):
 *   PaperEvidenceInbox.render(containerEl, {paperId, insertKey})
 *   PaperEvidenceInbox.refresh(paperId, force)
 *   PaperEvidenceInbox.invalidate()
 */
(function () {
  'use strict';

  var STALE_MS = 5 * 60 * 1000;
  var QUOTE_MAX = 200;

  var _state = {
    draftId: null,
    rows: [],           // [{paperId, annId, quote, comment, stance, type, fromClaims}]
    loadedAt: 0,
    loading: false,
    containerEl: null,
    insertKey: null,    // fn(citationKey)
  };

  /* ── Data assembly ─────────────────────────────────────────────────── */

  function _fs() {
    return (typeof firebase !== 'undefined' && firebase.firestore) ? firebase.firestore() : null;
  }

  function _uid() {
    try { return firebase.auth().currentUser && firebase.auth().currentUser.uid; }
    catch (e) { return null; }
  }

  /* Index projections, keyed by library itemId. */
  function _indexByItemId() {
    var list = (window.PaperEditor && window.PaperEditor.getCitationList &&
                window.PaperEditor.getCitationList()) || [];
    var by = Object.create(null);
    list.forEach(function (e) { if (e.itemId) by[e.itemId] = e; });
    return by;
  }

  function _quoteFromAnnotation(data) {
    var pages = (data.target && data.target.pages) || [];
    var parts = [];
    pages.forEach(function (p) {
      var q = p && p.selectors && p.selectors.textQuote && p.selectors.textQuote.exact;
      if (q) parts.push(q);
    });
    return parts.join(' / ');
  }

  function _rowFromAnnotation(paperId, annId, data, fromClaims) {
    return {
      paperId: paperId,
      annId: annId,
      quote: _quoteFromAnnotation(data),
      comment: data.comment || '',
      stance: data.evidence_stance || null,
      type: data.annotation_type || null,
      fromClaims: !!fromClaims,
    };
  }

  /* The papers worth querying: linked to this draft, already cited, or
   * referenced by claims evidence. Bounded — no library-wide scan. */
  function _fanOutItemIds(draftId, claimRefs) {
    var ids = Object.create(null);
    var byItem = _indexByItemId();
    var citedKeys = Object.create(null);
    ((window.PaperEditor && window.PaperEditor.getCitedKeysInPaper &&
      window.PaperEditor.getCitedKeysInPaper()) || []).forEach(function (k) {
      citedKeys[k] = true;
    });
    Object.keys(byItem).forEach(function (itemId) {
      var e = byItem[itemId];
      if (Array.isArray(e.linkedDrafts) && e.linkedDrafts.indexOf(draftId) >= 0) ids[itemId] = true;
      if (citedKeys[e.key]) ids[itemId] = true;
    });
    (claimRefs || []).forEach(function (r) { if (r && r.paperId) ids[r.paperId] = true; });
    return Object.keys(ids);
  }

  /* Claims evidence refs for this draft: [{paperId, annId, stance}]. */
  function _claimEvidenceRefs() {
    var claims = (window.PaperBulletClaims && window.PaperBulletClaims.getAllClaims &&
                  window.PaperBulletClaims.getAllClaims()) || [];
    var refs = [];
    claims.forEach(function (c) {
      (c.supporting_evidence_ids || []).forEach(function (r) {
        if (r && r.paperId && r.annId) refs.push({ paperId: r.paperId, annId: r.annId, stance: 'for' });
      });
      (c.counter_evidence_ids || []).forEach(function (r) {
        if (r && r.paperId && r.annId) refs.push({ paperId: r.paperId, annId: r.annId, stance: 'against' });
      });
    });
    return refs;
  }

  async function _queryCiteInDrafts(db, itemId, draftId, uid) {
    var col = db.collection('papers').doc(itemId).collection('annotations');
    var queries = [
      col.where('visibility', '==', 'lab')
         .where('cite_in_drafts', 'array-contains', draftId).get(),
    ];
    if (uid) {
      queries.push(
        col.where('creator.uid', '==', uid)
           .where('visibility', '==', 'private')
           .where('cite_in_drafts', 'array-contains', draftId).get()
      );
    }
    var snaps = await Promise.all(queries.map(function (q) {
      return q.catch(function (e) {
        // V3.621 — counted and surfaced in the render instead of only a
        // console.warn (a missing composite index used to look exactly
        // like "no evidence"; V3.619 deployed the indexes).
        _state.queryFailures = (_state.queryFailures || 0) + 1;
        console.warn('[evidence-inbox] query failed for', itemId, ':', e.message);
        return null;
      });
    }));
    var rows = [];
    snaps.forEach(function (snap) {
      if (!snap) return;
      snap.forEach(function (doc) {
        rows.push(_rowFromAnnotation(itemId, doc.id, doc.data(), false));
      });
    });
    return rows;
  }

  async function _fetchClaimAnnotation(db, ref) {
    try {
      var snap = await db.collection('papers').doc(ref.paperId)
        .collection('annotations').doc(ref.annId).get();
      if (!snap.exists) return null;
      var row = _rowFromAnnotation(ref.paperId, ref.annId, snap.data(), true);
      if (!row.stance) row.stance = ref.stance;
      return row;
    } catch (e) {
      /* Rules rejection (someone else's private highlight) — skip. */
      return null;
    }
  }

  async function _load(draftId) {
    var db = _fs();
    if (!db) return [];
    var uid = _uid();
    var claimRefs = _claimEvidenceRefs();
    var itemIds = _fanOutItemIds(draftId, claimRefs);

    var citeRowLists = await Promise.all(itemIds.map(function (itemId) {
      return _queryCiteInDrafts(db, itemId, draftId, uid);
    }));
    var claimRows = await Promise.all(claimRefs.map(function (r) {
      return _fetchClaimAnnotation(db, r);
    }));

    var seen = Object.create(null);
    var rows = [];
    citeRowLists.forEach(function (list) {
      list.forEach(function (r) {
        var k = r.paperId + '|' + r.annId;
        if (seen[k]) return;
        seen[k] = r;
        rows.push(r);
      });
    });
    claimRows.forEach(function (r) {
      if (!r) return;
      var k = r.paperId + '|' + r.annId;
      if (seen[k]) { seen[k].fromClaims = true; return; }   // dedupe, keep marker
      seen[k] = r;
      rows.push(r);
    });
    return rows;
  }

  /* ── Rendering ─────────────────────────────────────────────────────── */

  function _el(tag, cls, text) {
    var e = document.createElement(tag);
    if (cls) e.className = cls;
    if (text != null) e.textContent = text;
    return e;
  }

  function _renderRows() {
    var root = _state.containerEl;
    if (!root || !document.body.contains(root)) return;
    root.innerHTML = '';

    var countEl = document.getElementById('pe-evidence-count');
    if (countEl) countEl.textContent = _state.rows.length ? '(' + _state.rows.length + ')' : '';

    if (_state.loading && !_state.rows.length) {
      root.appendChild(_el('div', 'pe-equations-empty', 'Loading reading evidence…'));
      return;
    }
    // V3.621 — failed queries are no longer silent: an empty inbox caused
    // by rejections/missing indexes must not read as "no evidence".
    if (_state.queryFailures) {
      var failNote = _el('div', 'pe-equations-empty');
      ICON.label(failNote, 'exclamation-triangle',
        ' ' + _state.queryFailures + ' paper(s) could not be queried — the list below may be incomplete.');
      root.appendChild(failNote);
    }
    if (!_state.rows.length) {
      root.appendChild(_el('div', 'pe-equations-empty',
        'No reading evidence yet — highlight in the paper reader and tag it "Cite in draft" (or as claim evidence).'));
      return;
    }

    var byItem = _indexByItemId();
    var citedKeys = Object.create(null);
    ((window.PaperEditor && window.PaperEditor.getCitedKeysInPaper &&
      window.PaperEditor.getCitedKeysInPaper()) || []).forEach(function (k) { citedKeys[k] = true; });

    /* Group by paper. */
    var groups = Object.create(null);
    var order = [];
    _state.rows.forEach(function (r) {
      if (!groups[r.paperId]) { groups[r.paperId] = []; order.push(r.paperId); }
      groups[r.paperId].push(r);
    });
    order.sort(function (a, b) {
      var la = (byItem[a] && byItem[a].shortLabel) || a;
      var lb = (byItem[b] && byItem[b].shortLabel) || b;
      return la.localeCompare(lb);
    });

    order.forEach(function (itemId) {
      var entry = byItem[itemId] || null;
      var head = _el('div', 'pe-evidence-group-head');
      var titleLink = document.createElement('a');
      titleLink.href = '/rm/pages/library-paper.html?id=' + encodeURIComponent(itemId);
      titleLink.target = '_blank';
      titleLink.rel = 'noopener';
      titleLink.className = 'pe-evidence-group-title';
      titleLink.textContent = entry
        ? (entry.shortLabel + ' — ' + (entry.title || '').slice(0, 90))
        : itemId;
      head.appendChild(titleLink);
      root.appendChild(head);

      groups[itemId].forEach(function (r) {
        var row = _el('div', 'pe-evidence-row');
        if (entry && citedKeys[entry.key]) row.classList.add('pe-evidence-row--used');

        if (r.quote) {
          var q = _el('div', 'pe-evidence-quote');
          q.textContent = r.quote.length > QUOTE_MAX ? r.quote.slice(0, QUOTE_MAX) + '…' : r.quote;
          row.appendChild(q);
        }
        if (r.comment) row.appendChild(_el('div', 'pe-evidence-comment', r.comment));

        var meta = _el('div', 'pe-evidence-meta');
        if (r.stance === 'for')     meta.appendChild(_el('span', 'pe-evidence-stance pe-evidence-stance-for', 'supports'));
        if (r.stance === 'against') meta.appendChild(_el('span', 'pe-evidence-stance pe-evidence-stance-against', 'contradicts'));
        if (r.type && r.type !== 'note') meta.appendChild(_el('span', 'pe-evidence-type', r.type));
        if (r.fromClaims) meta.appendChild(_el('span', 'pe-evidence-type pe-evidence-claim-mark', '⚑ claim evidence'));
        if (entry && citedKeys[entry.key]) meta.appendChild(_el('span', 'pe-evidence-used-mark', 'cited ✓'));

        var spacer = _el('span', 'pe-evidence-meta-spacer');
        meta.appendChild(spacer);

        if (entry && entry.key) {
          var insertBtn = _el('button', 'btn btn-sm', 'Insert citation');
          insertBtn.type = 'button';
          insertBtn.title = 'Insert [@' + entry.key + '] at the caret';
          insertBtn.addEventListener('click', function () {
            if (_state.insertKey) _state.insertKey(entry.key);
          });
          meta.appendChild(insertBtn);
        }
        var openLink = document.createElement('a');
        openLink.className = 'btn btn-sm';
        openLink.href = '/rm/pages/library-paper.html?id=' + encodeURIComponent(r.paperId) +
                        '#ann-' + encodeURIComponent(r.annId);
        openLink.target = '_blank';
        openLink.rel = 'noopener';
        openLink.textContent = 'Open highlight';
        openLink.title = 'Open the paper at this highlight';
        meta.appendChild(openLink);

        row.appendChild(meta);
        root.appendChild(row);
      });
    });
  }

  /* ── Public API ────────────────────────────────────────────────────── */

  async function refresh(draftId, force) {
    if (!draftId) return;
    if (_state.loading) return;
    var fresh = _state.draftId === draftId &&
                (Date.now() - _state.loadedAt) < STALE_MS;
    if (fresh && !force) { _renderRows(); return; }
    _state.draftId = draftId;
    _state.loading = true;
    _state.queryFailures = 0;
    _renderRows();
    try {
      _state.rows = await _load(draftId);
      _state.loadedAt = Date.now();
    } catch (e) {
      console.warn('[evidence-inbox] load failed:', e.message);
    } finally {
      _state.loading = false;
      _renderRows();
    }
  }

  window.PaperEvidenceInbox = {
    render: function (containerEl, opts) {
      if (!containerEl) return;
      _state.containerEl = containerEl;
      if (opts && opts.insertKey) _state.insertKey = opts.insertKey;
      var draftId = (opts && opts.paperId) || _state.draftId;
      refresh(draftId, false);
    },
    refresh: refresh,
    invalidate: function () { _state.loadedAt = 0; _state.rows = []; },
  };

  /* Re-check when the citation index reloads (link toggles, new library
   * entries) — but only when the inbox is actually on screen. */
  var _debounce = null;
  window.addEventListener('paper-citations-loaded', function () {
    if (!_state.containerEl || !document.body.contains(_state.containerEl)) return;
    if (_debounce) return;
    _debounce = setTimeout(function () {
      _debounce = null;
      if (_state.draftId) refresh(_state.draftId, true);
    }, 500);
  });
})();
