/* evidence-tag-dialog.js — modal dialog: tag an annotation as evidence for
 * a claim on one of the lab's draft papers.
 *
 * Public API (window.EVIDENCE_TAG_DIALOG):
 *   open({paperId, annId, currentLinks})
 *
 * `currentLinks` is the annotation's existing evidence_for_claim_ids array
 * (so we can show which claims it's already linked to). Calling open()
 * resolves once the modal is dismissed.
 */
(function () {
  let _backdrop = null;

  function _esc(s) {
    return String(s ?? '').replace(/[&<>"']/g, c =>
      ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c])
    );
  }

  function _close() {
    if (_backdrop) {
      _backdrop.remove();
      _backdrop = null;
    }
  }

  async function _loadDrafts() {
    const data = await api.load('items.json');
    // Any paper item is a valid evidence target — both lab drafts and
    // library entries can host claims.
    return (data.items || []).filter(it => it.type === 'paper');
  }

  async function _loadClaimsOnce(draftId) {
    return new Promise((resolve, reject) => {
      let resolved = false;
      const unsub = window.CLAIMS.subscribe(draftId, (claims) => {
        if (!resolved) {
          resolved = true;
          unsub();
          resolve(claims);
        }
      }, (err) => {
        if (!resolved) {
          resolved = true;
          unsub();
          reject(err);
        }
      });
      setTimeout(() => {
        if (!resolved) {
          resolved = true;
          unsub();
          resolve([]);
        }
      }, 5000);
    });
  }

  function _render(state) {
    const { drafts, draftId, claims, claimId, stance, statementInput, busyMsg, errorMsg } = state;
    const draftOptions = drafts.map(d =>
      `<option value="${_esc(d.id)}"${d.id === draftId ? ' selected' : ''}>${_esc(d.title || d.id)}</option>`
    ).join('');

    const claimList = claims.map(c => `
      <label class="ev-claim-row">
        <input type="radio" name="ev-claim" value="${_esc(c.id)}"${c.id === claimId ? ' checked' : ''}>
        <span class="ev-claim-text">
          <span class="ev-claim-statement">${_esc(c.statement || '(no statement)')}</span>
          <span class="ev-claim-meta">${_esc(c.status)} · supporting ${(c.supporting_evidence_ids || []).length} · against ${(c.counter_evidence_ids || []).length}</span>
        </span>
      </label>
    `).join('');

    return `
      <div class="ev-modal">
        <div class="ev-modal-head">
          <div class="ev-modal-title">Tag as evidence</div>
          <button class="ev-modal-close" data-action="close" aria-label="Close">×</button>
        </div>
        <div class="ev-modal-body">
          <div class="ev-row">
            <label class="ev-label">Draft paper</label>
            <select id="ev-draft-select">
              ${drafts.length ? draftOptions : '<option value="">No paper items yet — add one on the Research page</option>'}
            </select>
          </div>
          <div class="ev-row">
            <label class="ev-label">Claim</label>
            <div class="ev-claim-list">
              ${claims.length ? claimList : '<div class="ev-empty">No claims yet on this draft.</div>'}
            </div>
            <div class="ev-new-claim">
              <input type="text" id="ev-new-claim-input" placeholder="Or create a new claim…" value="${_esc(statementInput || '')}">
              <button class="btn btn-sm" id="ev-create-claim-btn"${draftId ? '' : ' disabled'}>Create</button>
            </div>
          </div>
          <div class="ev-row">
            <label class="ev-label">Stance</label>
            <div class="ev-stance">
              <label class="ev-stance-opt"><input type="radio" name="ev-stance" value="for"${stance === 'for' ? ' checked' : ''}> Supports</label>
              <label class="ev-stance-opt"><input type="radio" name="ev-stance" value="against"${stance === 'against' ? ' checked' : ''}> Against</label>
            </div>
          </div>
          ${errorMsg ? `<div class="ev-err">${_esc(errorMsg)}</div>` : ''}
          ${busyMsg ? `<div class="ev-busy">${_esc(busyMsg)}</div>` : ''}
        </div>
        <div class="ev-modal-foot">
          <button class="btn" data-action="close">Cancel</button>
          <button class="btn btn-primary" id="ev-save-btn"${(claimId && stance && draftId && !busyMsg) ? '' : ' disabled'}>Tag as evidence</button>
        </div>
      </div>
    `;
  }

  async function open(opts) {
    const { paperId, annId } = opts;
    if (!paperId || !annId) throw new Error('paperId and annId required');

    _close();
    _backdrop = document.createElement('div');
    _backdrop.className = 'ev-backdrop';
    document.body.appendChild(_backdrop);

    const state = {
      drafts: [],
      draftId: '',
      claims: [],
      claimId: '',
      stance: 'for',
      statementInput: '',
      busyMsg: 'Loading drafts…',
      errorMsg: '',
    };

    function rerender() {
      if (!_backdrop) return;
      _backdrop.innerHTML = _render(state);
      wire();
    }

    function wire() {
      _backdrop.querySelectorAll('[data-action="close"]').forEach(b => {
        b.addEventListener('click', _close);
      });
      _backdrop.addEventListener('click', (e) => {
        if (e.target === _backdrop) _close();
      });
      const draftSel = _backdrop.querySelector('#ev-draft-select');
      if (draftSel) {
        draftSel.addEventListener('change', async () => {
          state.draftId = draftSel.value;
          state.claims = [];
          state.claimId = '';
          state.busyMsg = 'Loading claims…';
          rerender();
          try {
            state.claims = await _loadClaimsOnce(state.draftId);
            state.busyMsg = '';
          } catch (e) {
            state.errorMsg = `Could not load claims: ${e.message || e}`;
            state.busyMsg = '';
          }
          rerender();
        });
      }
      _backdrop.querySelectorAll('input[name="ev-claim"]').forEach(r => {
        r.addEventListener('change', () => {
          state.claimId = r.value;
          rerender();
        });
      });
      _backdrop.querySelectorAll('input[name="ev-stance"]').forEach(r => {
        r.addEventListener('change', () => {
          state.stance = r.value;
          rerender();
        });
      });
      const newInput = _backdrop.querySelector('#ev-new-claim-input');
      if (newInput) {
        newInput.addEventListener('input', () => {
          state.statementInput = newInput.value;
        });
      }
      const createBtn = _backdrop.querySelector('#ev-create-claim-btn');
      if (createBtn) {
        createBtn.addEventListener('click', async () => {
          const stmt = (newInput && newInput.value || '').trim();
          if (!stmt) { state.errorMsg = 'Enter a claim statement first.'; rerender(); return; }
          state.busyMsg = 'Creating claim…';
          state.errorMsg = '';
          rerender();
          try {
            const newId = await window.CLAIMS.create(state.draftId, { statement: stmt });
            state.claims = await _loadClaimsOnce(state.draftId);
            state.claimId = newId;
            state.statementInput = '';
            state.busyMsg = '';
          } catch (e) {
            state.errorMsg = `Create failed: ${e.message || e}`;
            state.busyMsg = '';
          }
          rerender();
        });
      }
      const saveBtn = _backdrop.querySelector('#ev-save-btn');
      if (saveBtn) {
        saveBtn.addEventListener('click', async () => {
          if (!state.draftId || !state.claimId || !state.stance) return;
          state.busyMsg = 'Linking…';
          state.errorMsg = '';
          rerender();
          try {
            await window.CLAIMS.addEvidence(state.draftId, state.claimId, paperId, annId, state.stance);
            _close();
          } catch (e) {
            state.errorMsg = `Tag failed: ${e.message || e}`;
            state.busyMsg = '';
            rerender();
          }
        });
      }
    }

    rerender();
    try {
      state.drafts = await _loadDrafts();
      state.draftId = state.drafts[0] ? state.drafts[0].id : '';
      state.busyMsg = state.draftId ? 'Loading claims…' : '';
      rerender();
      if (state.draftId) {
        state.claims = await _loadClaimsOnce(state.draftId);
        state.busyMsg = '';
        rerender();
      }
    } catch (e) {
      state.errorMsg = e.message || String(e);
      state.busyMsg = '';
      rerender();
    }
  }

  window.EVIDENCE_TAG_DIALOG = { open };
})();
