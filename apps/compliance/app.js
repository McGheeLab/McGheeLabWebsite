/* ================================================================
   Training & Compliance — McGheeLab Lab App
   Students upload training completion certificates (CITI, lab safety, etc.).
   PI verifies from ResearchManagement.
   ================================================================ */
(() => {
  'use strict';
  const appEl = document.getElementById('app');
  const COLLECTION = 'complianceSubmissions';
  let _user, _profile, _tab = 'submit';

  document.addEventListener('DOMContentLoaded', () => {
    McgheeLab.AppBridge.init();
    McgheeLab.AppBridge.onReady((user, profile) => {
      _user = user; _profile = profile; render();
    });
  });

  function esc(s) { if (!s) return ''; const d = document.createElement('div'); d.textContent = s; return d.innerHTML; }
  function notifyResize() { if (McgheeLab.AppBridge.isEmbedded()) window.parent.postMessage({ type: 'mcgheelab-app-resize', height: document.body.scrollHeight }, window.location.origin); }

  function render() {
    appEl.innerHTML = `
      <div class="comp-tabs">
        <button class="comp-tab ${_tab === 'submit' ? 'active' : ''}" data-tab="submit">Submit Certificate</button>
        <button class="comp-tab ${_tab === 'history' ? 'active' : ''}" data-tab="history">My Submissions</button>
      </div>
      <div id="comp-content"></div>`;
    appEl.querySelectorAll('.comp-tab').forEach(b => b.addEventListener('click', () => { _tab = b.dataset.tab; render(); }));
    if (_tab === 'submit') renderForm(); else renderHistory();
    notifyResize();
  }

  function renderForm() {
    const c = document.getElementById('comp-content');
    c.innerHTML = `
      <div class="app-card comp-form">
        <h2>Submit Training Certificate</h2>
        <p style="color:var(--muted);font-size:.82rem;margin-bottom:1rem;">Upload your completion certificate for PI verification.</p>
        <label class="app-label">Training Type *</label>
        <select class="app-input" id="comp-type">
          <option value="">-- select --</option>
          <option value="citi_training">CITI Training</option>
          <option value="lab_safety">Lab Safety</option>
          <option value="biosafety">Biosafety</option>
          <option value="radiation">Radiation Safety</option>
          <option value="animal_care">Animal Care (IACUC)</option>
          <option value="other">Other</option>
        </select>
        <label class="app-label">Title / Course Name *</label>
        <input class="app-input" id="comp-title" type="text" placeholder="e.g. CITI Human Subjects Research - Basic" />
        <label class="app-label">Completion Date *</label>
        <input class="app-input" id="comp-date" type="date" />
        <label class="app-label">Expiration Date</label>
        <input class="app-input" id="comp-expiry" type="date" />
        <label class="app-label">Certificate (PDF or image)</label>
        <input type="file" id="comp-file" accept="application/pdf,image/*" style="margin-top:.25rem;" />
        <div id="comp-error" style="color:var(--danger);font-size:.82rem;margin-top:.75rem;display:none;"></div>
        <div style="margin-top:1rem;"><button class="app-btn app-btn--primary" id="comp-submit">Submit</button></div>
      </div>`;

    document.getElementById('comp-submit').addEventListener('click', async () => {
      const type = document.getElementById('comp-type').value;
      const title = document.getElementById('comp-title').value.trim();
      const date = document.getElementById('comp-date').value;
      const errEl = document.getElementById('comp-error');
      if (!type || !title || !date) { errEl.textContent = 'Fill in type, title, and completion date.'; errEl.style.display = 'block'; return; }

      const btn = document.getElementById('comp-submit');
      btn.disabled = true; btn.textContent = 'Submitting...'; errEl.style.display = 'none';

      try {
        let certificateUrl = '';
        const fileInput = document.getElementById('comp-file');
        if (fileInput.files.length) {
          const file = fileInput.files[0];
          const docId = Date.now() + '-' + Math.random().toString(36).slice(2, 8);
          const ref = McgheeLab.storage.ref().child(`compliance/${_user.uid}/${docId}/${file.name}`);
          const snap = await ref.put(file);
          certificateUrl = await snap.ref.getDownloadURL();
        }

        await McgheeLab.db.collection(COLLECTION).add({
          submittedBy: _user.uid,
          submitterName: _profile.name || _user.email,
          type,
          title,
          completionDate: date,
          expirationDate: document.getElementById('comp-expiry').value || '',
          certificateUrl,
          status: 'submitted',
          createdAt: firebase.firestore.FieldValue.serverTimestamp(),
          updatedAt: firebase.firestore.FieldValue.serverTimestamp(),
        });
        _tab = 'history'; render();
      } catch (err) {
        errEl.textContent = 'Failed: ' + err.message; errEl.style.display = 'block';
        btn.disabled = false; btn.textContent = 'Submit';
      }
    });
    notifyResize();
  }

  async function renderHistory() {
    const c = document.getElementById('comp-content');
    c.innerHTML = '<div class="app-empty"><p>Loading&hellip;</p></div>';
    try {
      const snap = await McgheeLab.db.collection(COLLECTION)
        .where('submittedBy', '==', _user.uid)
        .orderBy('createdAt', 'desc').get();
      const subs = snap.docs.map(d => ({ id: d.id, ...d.data() }));
      if (!subs.length) { c.innerHTML = '<div class="app-empty"><p>No submissions yet.</p></div>'; notifyResize(); return; }

      let html = `<table class="comp-table"><thead><tr><th>Type</th><th>Title</th><th>Completed</th><th>Expires</th><th>Status</th><th>Cert</th></tr></thead><tbody>`;
      subs.forEach(s => {
        const badge = s.status === 'verified' ? '<span class="comp-badge comp-badge--verified">verified</span>'
          : s.status === 'expired' ? '<span class="comp-badge comp-badge--expired">expired</span>'
          : '<span class="comp-badge comp-badge--submitted">submitted</span>';
        html += `<tr>
          <td>${esc(s.type).replace(/_/g, ' ')}</td>
          <td><strong>${esc(s.title)}</strong></td>
          <td>${s.completionDate || ''}</td>
          <td>${s.expirationDate || ''}</td>
          <td>${badge}</td>
          <td>${s.certificateUrl ? '<a href="' + s.certificateUrl + '" target="_blank" style="color:var(--accent);">View</a>' : ''}</td>
        </tr>`;
      });
      html += '</tbody></table>';
      c.innerHTML = html;
    } catch (err) {
      c.innerHTML = `<div class="app-empty"><p style="color:var(--danger);">Error: ${err.message}</p></div>`;
    }
    notifyResize();
  }
})();
