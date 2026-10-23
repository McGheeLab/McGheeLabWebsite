/* paper-bullet-claims.js — V3.104.
 *
 * Bridge between the paper-builder skeleton outline (per-bullet `claim_id`
 * pointer in skeleton_items) and the existing `window.CLAIMS` namespace
 * defined in rm/js/claims.js. Lives entirely client-side; no new
 * Firestore paths, no new rules. Scope: a single open paper (the editor
 * mounts and tears down per-paper).
 *
 * What this module owns:
 *   - One CLAIMS.subscribe(paperId, ...) subscription per paper editor mount
 *   - Cache: claimId → claim doc (so per-bullet pills can sync-render)
 *   - The flag-as-claim modal that wraps CLAIMS.create + writes claim_id
 *     back into the bullet Y.Map
 *   - The claim-detail slide-out panel listing supporting/counter evidence
 *   - A 'paper-claims-changed' window event so all bullet pills can refresh
 *
 * Public API (window.PaperBulletClaims):
 *   attach(paperId)                       → start subscription, returns unsub()
 *   getClaim(claimId)                     → claim doc | null (may be stale on first call)
 *   flagBullet({yBlock, itemMap, paperId})→ open the flag modal
 *   openClaimDetail(claimId)              → open the slide-out panel
 */

(function () {
  var _state = {
    paperId: null,
    claims: [],
    byId: {},
    unsub: null,
  };

  function attach(paperId) {
    if (!paperId) {
      console.warn('[paper-bullet-claims] attach: paperId required');
      return function () {};
    }
    if (_state.paperId === paperId && _state.unsub) {
      return _state.unsub;
    }
    detach();
    _state.paperId = paperId;
    if (!window.CLAIMS || typeof window.CLAIMS.subscribe !== 'function') {
      console.warn('[paper-bullet-claims] CLAIMS namespace unavailable; bullet pills will stay in loading state.');
      return function () {};
    }
    try {
      _state.unsub = window.CLAIMS.subscribe(paperId, function (claims) {
        _state.claims = claims || [];
        _state.byId = Object.create(null);
        _state.claims.forEach(function (c) { _state.byId[c.id] = c; });
        try {
          window.dispatchEvent(new CustomEvent('paper-claims-changed', {
            detail: { paperId: paperId, count: _state.claims.length },
          }));
        } catch (e) { /* ignore */ }
      }, function (err) {
        console.warn('[paper-bullet-claims] subscribe error:', err && err.message || err);
      });
    } catch (e) {
      console.warn('[paper-bullet-claims] subscribe failed:', e.message || e);
    }
    return detach;
  }

  function detach() {
    if (_state.unsub) {
      try { _state.unsub(); } catch (e) {}
    }
    _state.paperId = null;
    _state.claims = [];
    _state.byId = {};
    _state.unsub = null;
  }

  function getClaim(claimId) {
    return claimId ? (_state.byId[claimId] || null) : null;
  }

  /* ── Flag-as-claim modal ─────────────────────────────────────────── */
  function flagBullet(args) {
    args = args || {};
    var yBlock = args.yBlock;
    var itemMap = args.itemMap;
    var paperId = args.paperId || _state.paperId;
    if (!yBlock || !itemMap || !paperId) {
      console.warn('[paper-bullet-claims] flagBullet: missing args', args);
      return;
    }
    if (!window.CLAIMS || typeof window.CLAIMS.create !== 'function') {
      alert('Claims module not loaded — cannot flag bullet.');
      return;
    }
    var existingClaimId = itemMap.get('claim_id');
    if (existingClaimId) {
      // Already flagged — open the detail panel instead of recreating.
      openClaimDetail(existingClaimId);
      return;
    }
    var bulletText = '';
    try { bulletText = (itemMap.get('text') || '').toString(); } catch (e) {}
    openFlagModal({
      bulletText: bulletText,
      onSave: async function (statement, status, onErr) {
        try {
          var claimId = await window.CLAIMS.create(paperId, {
            statement: statement,
            status: status || 'developing',
          });
          // Write claim_id back to the bullet Y.Map.
          yBlock.doc.transact(function () {
            itemMap.set('claim_id', claimId);
          }, 'skeleton-flag-claim');
        } catch (err) {
          console.warn('[paper-bullet-claims] CLAIMS.create failed:', err);
          onErr(err && err.message ? err.message : String(err));
          return;
        }
      },
    });
  }

  function openFlagModal(opts) {
    opts = opts || {};
    var existing = document.getElementById('pe-claim-flag-modal');
    if (existing) existing.remove();

    var overlay = document.createElement('div');
    overlay.className = 'pe-claim-flag-modal-overlay';
    overlay.id = 'pe-claim-flag-modal';

    var card = document.createElement('div');
    card.className = 'pe-claim-flag-modal-card';

    var head = document.createElement('div');
    head.className = 'pe-claim-flag-modal-head';
    var title = document.createElement('h3');
    title.textContent = 'Flag bullet as claim';
    var closeBtn = document.createElement('button');
    closeBtn.type = 'button';
    closeBtn.className = 'pe-icon-btn';
    closeBtn.setAttribute('aria-label', 'Close');
    ICON.label(closeBtn, 'x-mark');
    closeBtn.addEventListener('click', function () { overlay.remove(); });
    head.appendChild(title);
    head.appendChild(closeBtn);

    var body = document.createElement('div');
    body.className = 'pe-claim-flag-modal-body';

    var hint = document.createElement('p');
    hint.className = 'pe-claim-flag-hint';
    hint.textContent = 'A claim is an assertion that needs literature support. ' +
      'Once flagged, you can attach highlights as evidence from the paper reader. ' +
      'Bullets that are notes or methodological details should not be flagged.';
    body.appendChild(hint);

    var stmtLabel = document.createElement('label');
    stmtLabel.textContent = 'Claim statement';
    stmtLabel.htmlFor = 'pe-claim-flag-statement';
    body.appendChild(stmtLabel);

    var stmtArea = document.createElement('textarea');
    stmtArea.id = 'pe-claim-flag-statement';
    stmtArea.rows = 3;
    stmtArea.className = 'pe-claim-flag-statement';
    stmtArea.value = (opts.bulletText || '').trim();
    stmtArea.placeholder = 'e.g. "Cells uptake more glucose under shear stress."';
    body.appendChild(stmtArea);

    var statusLabel = document.createElement('label');
    statusLabel.textContent = 'Initial status';
    statusLabel.htmlFor = 'pe-claim-flag-status';
    body.appendChild(statusLabel);

    var statusSel = document.createElement('select');
    statusSel.id = 'pe-claim-flag-status';
    statusSel.className = 'pe-claim-flag-status';
    [
      ['developing', 'Developing — looking for evidence'],
      ['needs-more-evidence', 'Needs more evidence'],
      ['supported', 'Supported (already)'],
    ].forEach(function (opt) {
      var o = document.createElement('option');
      o.value = opt[0];
      o.textContent = opt[1];
      statusSel.appendChild(o);
    });
    statusSel.value = 'developing';
    body.appendChild(statusSel);

    var errEl = document.createElement('div');
    errEl.className = 'pe-claim-flag-err';
    errEl.style.display = 'none';
    body.appendChild(errEl);

    var foot = document.createElement('div');
    foot.className = 'pe-claim-flag-modal-foot';
    var cancelBtn = document.createElement('button');
    cancelBtn.type = 'button';
    cancelBtn.className = 'btn';
    cancelBtn.textContent = 'Cancel';
    cancelBtn.addEventListener('click', function () { overlay.remove(); });
    var saveBtn = document.createElement('button');
    saveBtn.type = 'button';
    saveBtn.className = 'btn btn-primary';
    saveBtn.textContent = 'Flag as claim';
    saveBtn.addEventListener('click', async function () {
      var stmt = (stmtArea.value || '').trim();
      if (!stmt) {
        errEl.textContent = 'Statement is required.';
        errEl.style.display = '';
        stmtArea.focus();
        return;
      }
      saveBtn.disabled = true;
      cancelBtn.disabled = true;
      errEl.style.display = 'none';
      await opts.onSave(stmt, statusSel.value, function (msg) {
        errEl.textContent = msg;
        errEl.style.display = '';
        saveBtn.disabled = false;
        cancelBtn.disabled = false;
      });
      // If onSave didn't error, close the modal.
      if (errEl.style.display === 'none') overlay.remove();
    });
    foot.appendChild(cancelBtn);
    foot.appendChild(saveBtn);

    card.appendChild(head);
    card.appendChild(body);
    card.appendChild(foot);
    overlay.appendChild(card);

    overlay.addEventListener('click', function (e) {
      if (e.target === overlay) overlay.remove();
    });
    document.addEventListener('keydown', function escHandler(e) {
      if (e.key === 'Escape' && document.body.contains(overlay)) {
        overlay.remove();
        document.removeEventListener('keydown', escHandler);
      }
    });

    document.body.appendChild(overlay);
    setTimeout(function () { stmtArea.focus(); stmtArea.select(); }, 50);
  }

  /* ── Claim detail slide-out panel ────────────────────────────────── */
  function openClaimDetail(claimId) {
    var c = getClaim(claimId);
    var existing = document.getElementById('pe-claim-detail-panel');
    if (existing) existing.remove();

    var panel = document.createElement('aside');
    panel.id = 'pe-claim-detail-panel';
    panel.className = 'pe-claim-detail-panel';

    var head = document.createElement('div');
    head.className = 'pe-claim-detail-head';
    var title = document.createElement('span');
    title.className = 'pe-claim-detail-title';
    title.textContent = c ? ('⚑ ' + (c.status || 'developing')) : '⚑ Claim';
    var close = document.createElement('button');
    close.type = 'button';
    close.className = 'pe-icon-btn';
    close.setAttribute('aria-label', 'Close');
    ICON.label(close, 'x-mark');
    close.addEventListener('click', function () { panel.remove(); });
    head.appendChild(title);
    head.appendChild(close);
    panel.appendChild(head);

    if (!c) {
      var loading = document.createElement('div');
      loading.className = 'pe-claim-detail-loading';
      loading.textContent = 'Loading claim…';
      panel.appendChild(loading);
    } else {
      var stmt = document.createElement('div');
      stmt.className = 'pe-claim-detail-stmt';
      stmt.textContent = c.statement || '(no statement)';
      panel.appendChild(stmt);

      var supporting = (c.supporting_evidence_ids || []);
      var counter = (c.counter_evidence_ids || []);
      panel.appendChild(_renderEvidenceSection('Supporting (' + supporting.length + ')', 'for', supporting));
      panel.appendChild(_renderEvidenceSection('Against (' + counter.length + ')', 'against', counter));

      // Status changer
      var statusRow = document.createElement('div');
      statusRow.className = 'pe-claim-detail-status-row';
      var lbl = document.createElement('span');
      lbl.textContent = 'Status:';
      var sel = document.createElement('select');
      ['developing', 'needs-more-evidence', 'supported', 'abandoned'].forEach(function (s) {
        var o = document.createElement('option');
        o.value = s;
        o.textContent = s;
        if (s === c.status) o.selected = true;
        sel.appendChild(o);
      });
      sel.addEventListener('change', async function () {
        try {
          await window.CLAIMS.update(_state.paperId, claimId, { status: sel.value });
        } catch (e) {
          console.warn('[paper-bullet-claims] update status failed:', e);
        }
      });
      statusRow.appendChild(lbl);
      statusRow.appendChild(sel);
      panel.appendChild(statusRow);
    }

    document.body.appendChild(panel);

    // Auto-refresh when subscription delivers updates.
    var listener = function () {
      var nc = getClaim(claimId);
      if (!nc) return;
      title.textContent = '⚑ ' + (nc.status || 'developing');
      // Lazy refresh: rebuild evidence sections if counts changed.
      var sec = panel.querySelector('.pe-claim-detail-section');
      if (sec) {
        var supList = panel.querySelectorAll('.pe-claim-detail-section');
        // Easier: detach and re-mount the panel to redraw.
      }
    };
    window.addEventListener('paper-claims-changed', listener);
    panel.addEventListener('remove', function () {
      window.removeEventListener('paper-claims-changed', listener);
    });
  }

  function _renderEvidenceSection(headingText, stance, evidenceList) {
    var sec = document.createElement('div');
    sec.className = 'pe-claim-detail-section';
    var h = document.createElement('div');
    h.className = 'pe-claim-detail-heading pe-claim-detail-heading-' + stance;
    h.textContent = headingText;
    sec.appendChild(h);
    if (!evidenceList.length) {
      var empty = document.createElement('div');
      empty.className = 'pe-claim-detail-empty';
      empty.textContent = 'none yet';
      sec.appendChild(empty);
      return sec;
    }
    evidenceList.forEach(function (ev) {
      var a = document.createElement('a');
      a.className = 'pe-claim-detail-evidence';
      a.href = '/rm/pages/library-paper.html?id=' + encodeURIComponent(ev.paperId) +
               '#ann-' + encodeURIComponent(ev.annId);
      a.target = '_blank';
      a.rel = 'noopener';
      a.title = 'Open in library reader';
      a.textContent = ev.paperId + ' · ' + ev.annId.slice(0, 12);
      sec.appendChild(a);
    });
    return sec;
  }

  window.PaperBulletClaims = {
    attach: attach,
    detach: detach,
    getClaim: getClaim,
    flagBullet: flagBullet,
    openClaimDetail: openClaimDetail,
    /* V3.350 — snapshot of this draft's claims for the Evidence Inbox
     * (paper-evidence-inbox.js walks supporting/counter_evidence_ids). */
    getAllClaims: function () { return _state.claims.slice(); },
  };
})();
