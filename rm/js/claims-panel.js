/* claims-panel.js — render the claims panel for a draft paper.
 *
 * Used on the draft paper's detail view (in the item explorer) to show
 * all claims attached to that draft along with their evidence (links back
 * to source papers + annotations).
 *
 * Public API (window.CLAIMS_PANEL):
 *   mount(rootEl, draftId)  → returns an unmount() fn
 */
(function () {
  function _esc(s) {
    return String(s ?? '').replace(/[&<>"']/g, c =>
      ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c])
    );
  }

  function _renderClaim(c, allItems) {
    const supporting = c.supporting_evidence_ids || [];
    const counter = c.counter_evidence_ids || [];
    const statusClass = `cp-status cp-status-${_esc(c.status || 'developing')}`;
    return `
      <div class="cp-card" data-id="${_esc(c.id)}">
        <div class="cp-card-head">
          <span class="${statusClass}">${_esc(c.status || 'developing')}</span>
          <span class="cp-creator" title="${_esc((c.creator && c.creator.email) || '')}">${_esc((c.creator && c.creator.displayName) || '')}</span>
        </div>
        <div class="cp-statement">${_esc(c.statement || '(no statement)')}</div>
        <div class="cp-evidence">
          <div class="cp-evidence-section">
            <span class="cp-evidence-label cp-evidence-for">Supporting (${supporting.length})</span>
            <div class="cp-evidence-list">${supporting.length ? supporting.map(e => _renderEvidence(e, allItems)).join('') : '<span class="cp-evidence-empty">none yet</span>'}</div>
          </div>
          <div class="cp-evidence-section">
            <span class="cp-evidence-label cp-evidence-against">Against (${counter.length})</span>
            <div class="cp-evidence-list">${counter.length ? counter.map(e => _renderEvidence(e, allItems)).join('') : '<span class="cp-evidence-empty">none yet</span>'}</div>
          </div>
        </div>
        <div class="cp-card-foot">
          <button class="cp-edit-btn" data-id="${_esc(c.id)}">Edit</button>
          <button class="cp-status-btn" data-id="${_esc(c.id)}">Set status…</button>
          <button class="cp-delete-btn" data-id="${_esc(c.id)}">Delete</button>
        </div>
      </div>
    `;
  }

  function _renderEvidence(ev, allItems) {
    const paper = (allItems || []).find(it => it.id === ev.paperId);
    const title = (paper && paper.title) || ev.paperId;
    const href = `/pages/library-paper.html?id=${encodeURIComponent(ev.paperId)}#ann-${encodeURIComponent(ev.annId)}`;
    return `<a class="cp-evidence-pill" href="${_esc(href)}" title="${_esc(title)}">${_esc(title.slice(0, 40))}${title.length > 40 ? '…' : ''}</a>`;
  }

  function mount(rootEl, draftId) {
    if (!rootEl || !draftId) return () => {};

    let claims = [];
    let allItems = [];
    let unsub = null;

    function render() {
      const html = `
        <div class="cp-panel">
          <div class="cp-head">
            <div class="cp-head-title">Claims</div>
            <button class="cp-add-btn" id="cp-add-btn">+ New claim</button>
          </div>
          <div class="cp-new-row" id="cp-new-row" style="display:none">
            <input type="text" id="cp-new-input" placeholder="State the claim you'll defend…">
            <button class="btn btn-sm" id="cp-new-save">Add</button>
            <button class="btn btn-sm" id="cp-new-cancel">Cancel</button>
          </div>
          <div class="cp-list">
            ${claims.length
              ? claims.map(c => _renderClaim(c, allItems)).join('')
              : '<div class="cp-empty">No claims yet. Click <strong>+ New claim</strong> to start, or tag highlights as evidence from a source paper.</div>'}
          </div>
        </div>
      `;
      rootEl.innerHTML = html;
      wire();
    }

    function wire() {
      const addBtn = rootEl.querySelector('#cp-add-btn');
      const newRow = rootEl.querySelector('#cp-new-row');
      const newInput = rootEl.querySelector('#cp-new-input');
      const newSave = rootEl.querySelector('#cp-new-save');
      const newCancel = rootEl.querySelector('#cp-new-cancel');
      if (addBtn) addBtn.addEventListener('click', () => {
        newRow.style.display = 'flex';
        newInput.focus();
      });
      if (newCancel) newCancel.addEventListener('click', () => {
        newRow.style.display = 'none';
        newInput.value = '';
      });
      if (newSave) newSave.addEventListener('click', async () => {
        const stmt = newInput.value.trim();
        if (!stmt) return;
        try {
          await window.CLAIMS.create(draftId, { statement: stmt });
          newInput.value = '';
          newRow.style.display = 'none';
        } catch (e) {
          alert(`Could not create claim: ${e.message || e}`);
        }
      });
      if (newInput) newInput.addEventListener('keydown', (e) => {
        if (e.key === 'Enter') newSave.click();
        if (e.key === 'Escape') newCancel.click();
      });

      rootEl.querySelectorAll('.cp-edit-btn').forEach(b => {
        b.addEventListener('click', async () => {
          const c = claims.find(x => x.id === b.dataset.id);
          if (!c) return;
          const next = window.prompt('Edit claim statement:', c.statement || '');
          if (next === null) return;
          try {
            await window.CLAIMS.update(draftId, c.id, { statement: next });
          } catch (e) {
            alert(`Update failed: ${e.message}`);
          }
        });
      });
      rootEl.querySelectorAll('.cp-status-btn').forEach(b => {
        b.addEventListener('click', async () => {
          const c = claims.find(x => x.id === b.dataset.id);
          if (!c) return;
          const opts = ['developing', 'supported', 'needs-more-evidence', 'abandoned'];
          const next = window.prompt(`Status (${opts.join(' | ')}):`, c.status || 'developing');
          if (!next || !opts.includes(next.trim())) return;
          try { await window.CLAIMS.update(draftId, c.id, { status: next.trim() }); }
          catch (e) { alert(`Update failed: ${e.message}`); }
        });
      });
      rootEl.querySelectorAll('.cp-delete-btn').forEach(b => {
        b.addEventListener('click', async () => {
          if (!confirm('Delete this claim? Existing evidence links will be left dangling.')) return;
          try { await window.CLAIMS.remove(draftId, b.dataset.id); }
          catch (e) { alert(`Delete failed: ${e.message}`); }
        });
      });
    }

    // Load items.json once for resolving evidence pill labels.
    (async () => {
      try {
        const data = await api.load('items.json');
        allItems = data.items || [];
        render();
      } catch (e) {
        console.warn('[claims-panel] items load failed:', e);
        render();
      }
    })();

    unsub = window.CLAIMS.subscribe(draftId, (list) => {
      claims = list;
      render();
    }, (err) => {
      rootEl.innerHTML = `<div class="cp-empty">Claim sync error: ${_esc((err.message || '') + '')}</div>`;
    });

    return function unmount() {
      if (unsub) try { unsub(); } catch (_) { /* ignore */ }
      rootEl.innerHTML = '';
    };
  }

  window.CLAIMS_PANEL = { mount };
})();
