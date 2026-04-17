/* ================================================================
   Purchase Requests — McGheeLab Lab App
   Students request equipment/supplies. PI reviews from ResearchManagement.
   ================================================================ */
(() => {
  'use strict';
  const appEl = document.getElementById('app');
  const COLLECTION = 'purchaseRequests';
  let _user, _profile, _tab = 'request';

  document.addEventListener('DOMContentLoaded', () => {
    McgheeLab.AppBridge.init();
    McgheeLab.AppBridge.onReady((user, profile) => {
      _user = user; _profile = profile; render();
    });
  });

  function esc(s) { if (!s) return ''; const d = document.createElement('div'); d.textContent = s; return d.innerHTML; }
  function notifyResize() { if (McgheeLab.AppBridge.isEmbedded()) window.parent.postMessage({ type: 'mcgheelab-app-resize', height: document.body.scrollHeight }, window.location.origin); }

  function badgeHTML(status) {
    return `<span class="pur-badge pur-badge--${status}">${status}</span>`;
  }

  function render() {
    appEl.innerHTML = `
      <div class="pur-tabs">
        <button class="pur-tab ${_tab === 'request' ? 'active' : ''}" data-tab="request">New Request</button>
        <button class="pur-tab ${_tab === 'history' ? 'active' : ''}" data-tab="history">My Requests</button>
      </div>
      <div id="pur-content"></div>`;
    appEl.querySelectorAll('.pur-tab').forEach(b => b.addEventListener('click', () => { _tab = b.dataset.tab; render(); }));
    if (_tab === 'request') renderForm(); else renderHistory();
    notifyResize();
  }

  function renderForm() {
    const c = document.getElementById('pur-content');
    c.innerHTML = `
      <div class="app-card pur-form">
        <h2>Request a Purchase</h2>
        <p style="color:var(--muted);font-size:.82rem;margin-bottom:1rem;">Describe what you need. The PI will review and handle ordering.</p>
        <label class="app-label">What do you need? *</label>
        <textarea class="app-input" id="pur-desc" rows="3" placeholder="e.g. 100 mL polyethylene glycol (PEG), MW 6000"></textarea>
        <label class="app-label">Vendor (if known)</label>
        <input class="app-input" id="pur-vendor" type="text" placeholder="e.g. Sigma-Aldrich, Fisher" />
        <label class="app-label">Estimated Cost ($)</label>
        <input class="app-input" id="pur-cost" type="number" step="0.01" min="0" placeholder="0.00" />
        <label class="app-label">Justification *</label>
        <textarea class="app-input" id="pur-justify" rows="2" placeholder="Why is this needed? Which experiment/project?"></textarea>
        <label class="app-label">Urgency</label>
        <select class="app-input" id="pur-urgency">
          <option value="routine">Routine</option>
          <option value="needed_soon">Needed Soon</option>
          <option value="urgent">Urgent</option>
        </select>
        <label class="app-label">Category</label>
        <select class="app-input" id="pur-category">
          <option value="supplies">Supplies</option>
          <option value="equipment">Equipment</option>
          <option value="software">Software</option>
          <option value="other">Other</option>
        </select>
        <div id="pur-error" style="color:var(--danger);font-size:.82rem;margin-top:.75rem;display:none;"></div>
        <div style="margin-top:1rem;"><button class="app-btn app-btn--primary" id="pur-submit">Submit Request</button></div>
      </div>`;

    document.getElementById('pur-submit').addEventListener('click', async () => {
      const desc = document.getElementById('pur-desc').value.trim();
      const justify = document.getElementById('pur-justify').value.trim();
      const errEl = document.getElementById('pur-error');
      if (!desc || !justify) { errEl.textContent = 'Description and justification are required.'; errEl.style.display = 'block'; return; }
      const btn = document.getElementById('pur-submit');
      btn.disabled = true; btn.textContent = 'Submitting...'; errEl.style.display = 'none';
      try {
        await McgheeLab.db.collection(COLLECTION).add({
          requestedBy: _user.uid,
          requesterName: _profile.name || _user.email,
          itemDescription: desc,
          vendor: document.getElementById('pur-vendor').value.trim(),
          estimatedCost: parseFloat(document.getElementById('pur-cost').value) || 0,
          justification: justify,
          urgency: document.getElementById('pur-urgency').value,
          category: document.getElementById('pur-category').value,
          status: 'requested',
          piNotes: '',
          createdAt: firebase.firestore.FieldValue.serverTimestamp(),
          updatedAt: firebase.firestore.FieldValue.serverTimestamp(),
        });
        _tab = 'history'; render();
      } catch (err) {
        errEl.textContent = 'Failed: ' + err.message; errEl.style.display = 'block';
        btn.disabled = false; btn.textContent = 'Submit Request';
      }
    });
    notifyResize();
  }

  async function renderHistory() {
    const c = document.getElementById('pur-content');
    c.innerHTML = '<div class="app-empty"><p>Loading&hellip;</p></div>';
    try {
      const snap = await McgheeLab.db.collection(COLLECTION)
        .where('requestedBy', '==', _user.uid)
        .orderBy('createdAt', 'desc').get();
      const reqs = snap.docs.map(d => ({ id: d.id, ...d.data() }));
      if (!reqs.length) { c.innerHTML = '<div class="app-empty"><p>No requests yet.</p></div>'; notifyResize(); return; }

      let html = `<table class="pur-table"><thead><tr><th>Item</th><th>Est. Cost</th><th>Urgency</th><th>Status</th></tr></thead><tbody>`;
      reqs.forEach(r => {
        html += `<tr>
          <td><strong>${esc(r.itemDescription).slice(0, 80)}</strong>${r.vendor ? '<br><span style="color:var(--muted);font-size:.75rem;">' + esc(r.vendor) + '</span>' : ''}</td>
          <td>${r.estimatedCost ? '$' + r.estimatedCost.toFixed(2) : ''}</td>
          <td>${esc(r.urgency)}</td>
          <td>${badgeHTML(r.status)}</td>
        </tr>`;
        if (r.piNotes) html += `<tr><td colspan="4" style="font-size:.78rem;color:var(--muted);padding:.25rem .75rem .5rem;"><strong>PI:</strong> ${esc(r.piNotes)}</td></tr>`;
      });
      html += '</tbody></table>';
      c.innerHTML = html;
    } catch (err) {
      c.innerHTML = `<div class="app-empty"><p style="color:var(--danger);">Error: ${err.message}</p></div>`;
    }
    notifyResize();
  }
})();
