/* ================================================================
   Procurement — McGheeLab Lab App
   Students submit purchase orders/receipts with line items.
   PI reviews from the ResearchManagement dashboard.
   ================================================================ */

(() => {
  'use strict';

  const appEl = document.getElementById('app');
  const COLLECTION = 'procurement';
  let _user, _profile, _config = {}, _tab = 'submit';

  /* ─── Lifecycle ─────────────────────────────────────────── */

  document.addEventListener('DOMContentLoaded', () => {
    McgheeLab.AppBridge.init();
    McgheeLab.AppBridge.onReady(async (user, profile) => {
      _user = user;
      _profile = profile;
      await loadConfig();
      render();
    });
  });

  /* ─── Config (projects + funding sources from labConfig) ── */

  async function loadConfig() {
    try {
      const projDoc = await McgheeLab.db.collection('labConfig').doc('projects').get();
      _config.projects = projDoc.exists ? (projDoc.data().projects || []) : [];
    } catch (e) { _config.projects = []; }
    try {
      const fundDoc = await McgheeLab.db.collection('labConfig').doc('fundingSources').get();
      _config.fundingSources = fundDoc.exists ? (fundDoc.data().sources || []) : [];
    } catch (e) { _config.fundingSources = []; }

    // Fallback defaults if labConfig not populated yet
    if (!_config.projects.length) {
      _config.projects = [
        { id: 'mebp', label: 'MEBP' },
        { id: 'gels-image-segmentation', label: 'GELS Image Segmentation' },
        { id: 'serialtrack-python', label: 'SerialTrack Python' },
        { id: 'cell-tracker', label: 'Cell Tracker' },
        { id: 'lab-general', label: 'Lab General' },
      ];
    }
    if (!_config.fundingSources.length) {
      _config.fundingSources = [
        { id: '1101935', label: 'Startup (1101935)' },
        { id: '3062920', label: 'ONR (3062920)' },
        { id: '3061792', label: 'BME Research (3061792)' },
      ];
    }
  }

  /* ─── Render ────────────────────────────────────────────── */

  function render() {
    appEl.innerHTML = `
      <div class="proc-tabs">
        <button class="proc-tab ${_tab === 'submit' ? 'active' : ''}" data-tab="submit">Submit Order</button>
        <button class="proc-tab ${_tab === 'history' ? 'active' : ''}" data-tab="history">My Orders</button>
      </div>
      <div id="proc-content"></div>
    `;

    // Wire tabs
    appEl.querySelectorAll('.proc-tab').forEach(btn => {
      btn.addEventListener('click', () => {
        _tab = btn.dataset.tab;
        render();
      });
    });

    if (_tab === 'submit') renderSubmitForm();
    else renderHistory();

    notifyResize();
  }

  /* ─── Submit Form ──────────────────────────────────────── */

  function selectOptions(items, selectedId) {
    return '<option value="">-- select --</option>' +
      items.map(i => `<option value="${esc(i.id)}" ${i.id === selectedId ? 'selected' : ''}>${esc(i.label)}</option>`).join('');
  }

  function renderSubmitForm() {
    const c = document.getElementById('proc-content');
    c.innerHTML = `
      <div class="app-card proc-form">
        <h2>Submit Purchase Order / Receipt</h2>
        <p style="color:var(--muted);font-size:.82rem;margin-bottom:1rem;">Enter order details and attach the invoice PDF.</p>

        <label class="app-label">Vendor *</label>
        <input class="app-input" id="proc-vendor" type="text" placeholder="e.g. Polysciences, Amazon, iLab" required />

        <label class="app-label">Order Number</label>
        <input class="app-input" id="proc-order-num" type="text" placeholder="e.g. PS2164, 113-6210287" />

        <label class="app-label">Source Type *</label>
        <select class="app-input" id="proc-source-type">
          <option value="">-- select --</option>
          <option value="pcard">PCard</option>
          <option value="ilab">iLab</option>
          <option value="amazon_business">Amazon Business</option>
          <option value="vendor_po">Vendor PO</option>
          <option value="internal">Internal</option>
        </select>

        <label class="app-label">Project *</label>
        <select class="app-input" id="proc-project">${selectOptions(_config.projects, '')}</select>

        <label class="app-label">Funding Account *</label>
        <select class="app-input" id="proc-funding">${selectOptions(_config.fundingSources, '')}</select>

        <label class="app-label">Date</label>
        <input class="app-input" id="proc-date" type="date" value="${new Date().toISOString().slice(0,10)}" />

        <label class="app-label">Line Items</label>
        <div id="proc-lines" class="proc-line-items">
          <div class="proc-line-item">
            <input class="app-input" placeholder="Description" data-field="description" />
            <input class="app-input" placeholder="Cat #" data-field="catalogueNumber" />
            <input class="app-input" type="number" placeholder="Qty" data-field="quantity" min="1" value="1" />
            <input class="app-input" type="number" placeholder="Price" data-field="unitPrice" step="0.01" min="0" />
            <button class="proc-remove-btn" title="Remove">&times;</button>
          </div>
        </div>
        <button class="app-btn app-btn--secondary" id="proc-add-line" style="margin-top:.5rem;">+ Add Line</button>

        <label class="app-label">iLab Link (optional)</label>
        <input class="app-input" id="proc-ilab-url" type="url" placeholder="https://ua.ilab.agilent.com/..." />

        <label class="app-label">Attach Invoice PDF</label>
        <input type="file" id="proc-file" accept="application/pdf" style="margin-top:.25rem;" />

        <label class="app-label">Notes</label>
        <textarea class="app-input" id="proc-notes" rows="3" placeholder="Any additional details..."></textarea>

        <div id="proc-error" style="color:var(--danger);font-size:.82rem;margin-top:.75rem;display:none;"></div>
        <div style="margin-top:1rem;display:flex;gap:.5rem;">
          <button class="app-btn app-btn--primary" id="proc-submit-btn">Submit</button>
        </div>
      </div>
    `;

    wireSubmitForm();
  }

  function wireSubmitForm() {
    // Add line item
    document.getElementById('proc-add-line').addEventListener('click', () => {
      const container = document.getElementById('proc-lines');
      const row = document.createElement('div');
      row.className = 'proc-line-item';
      row.innerHTML = `
        <input class="app-input" placeholder="Description" data-field="description" />
        <input class="app-input" placeholder="Cat #" data-field="catalogueNumber" />
        <input class="app-input" type="number" placeholder="Qty" data-field="quantity" min="1" value="1" />
        <input class="app-input" type="number" placeholder="Price" data-field="unitPrice" step="0.01" min="0" />
        <button class="proc-remove-btn" title="Remove">&times;</button>
      `;
      container.appendChild(row);
      wireRemoveButtons();
      notifyResize();
    });

    wireRemoveButtons();

    // Submit
    document.getElementById('proc-submit-btn').addEventListener('click', handleSubmit);
  }

  function wireRemoveButtons() {
    document.querySelectorAll('.proc-remove-btn').forEach(btn => {
      btn.onclick = () => {
        const lines = document.querySelectorAll('.proc-line-item');
        if (lines.length > 1) { btn.parentElement.remove(); notifyResize(); }
      };
    });
  }

  async function handleSubmit() {
    const errEl = document.getElementById('proc-error');
    const btn = document.getElementById('proc-submit-btn');
    errEl.style.display = 'none';

    const vendor = document.getElementById('proc-vendor').value.trim();
    const sourceType = document.getElementById('proc-source-type').value;
    const project = document.getElementById('proc-project').value;
    const funding = document.getElementById('proc-funding').value;

    if (!vendor || !sourceType || !project || !funding) {
      errEl.textContent = 'Fill in all required fields (vendor, source type, project, funding account).';
      errEl.style.display = 'block';
      return;
    }

    // Collect line items
    const items = [];
    document.querySelectorAll('.proc-line-item').forEach(row => {
      const desc = row.querySelector('[data-field="description"]').value.trim();
      const cat = row.querySelector('[data-field="catalogueNumber"]').value.trim();
      const qty = parseFloat(row.querySelector('[data-field="quantity"]').value) || 1;
      const price = parseFloat(row.querySelector('[data-field="unitPrice"]').value) || 0;
      if (desc || cat) items.push({ description: desc, catalogueNumber: cat, quantity: qty, unitPrice: price });
    });

    const subtotal = items.reduce((s, i) => s + (i.quantity * i.unitPrice), 0);

    btn.disabled = true;
    btn.textContent = 'Submitting...';

    try {
      // Upload PDF if provided
      let attachmentUrl = '';
      const fileInput = document.getElementById('proc-file');
      if (fileInput.files.length) {
        const file = fileInput.files[0];
        const docId = Date.now() + '-' + Math.random().toString(36).slice(2, 8);
        const ref = McgheeLab.storage.ref().child(`procurement/${docId}/${file.name}`);
        const snap = await ref.put(file);
        attachmentUrl = await snap.ref.getDownloadURL();
      }

      await McgheeLab.db.collection(COLLECTION).add({
        submittedBy: _user.uid,
        submitterName: _profile.name || _user.email,
        vendor,
        orderNumber: document.getElementById('proc-order-num').value.trim(),
        date: document.getElementById('proc-date').value,
        sourceType,
        fundingAccount: funding,
        project,
        items,
        subtotal,
        tax: 0,
        shipping: 0,
        total: subtotal,
        attachmentUrl,
        ilabUrl: document.getElementById('proc-ilab-url').value.trim(),
        status: 'submitted',
        piNotes: '',
        notes: document.getElementById('proc-notes').value.trim(),
        createdAt: firebase.firestore.FieldValue.serverTimestamp(),
        updatedAt: firebase.firestore.FieldValue.serverTimestamp(),
      });

      _tab = 'history';
      render();
    } catch (err) {
      errEl.textContent = 'Submit failed: ' + err.message;
      errEl.style.display = 'block';
      btn.disabled = false;
      btn.textContent = 'Submit';
    }
  }

  /* ─── Order History ────────────────────────────────────── */

  async function renderHistory() {
    const c = document.getElementById('proc-content');
    c.innerHTML = '<div class="app-empty"><p>Loading orders&hellip;</p></div>';

    try {
      const snap = await McgheeLab.db.collection(COLLECTION)
        .where('submittedBy', '==', _user.uid)
        .orderBy('createdAt', 'desc')
        .get();
      const orders = snap.docs.map(d => ({ id: d.id, ...d.data() }));

      if (!orders.length) {
        c.innerHTML = '<div class="app-empty"><p>No orders yet. Submit your first one!</p></div>';
        notifyResize();
        return;
      }

      // Summary
      const totalSpent = orders.reduce((s, o) => s + (o.total || 0), 0);
      let html = `
        <div class="proc-summary">
          <div class="proc-stat"><div class="proc-stat-label">Orders</div><div class="proc-stat-value">${orders.length}</div></div>
          <div class="proc-stat"><div class="proc-stat-label">Total</div><div class="proc-stat-value">$${totalSpent.toFixed(2)}</div></div>
        </div>
      `;

      html += `<table class="proc-table">
        <thead><tr><th>Date</th><th>Vendor</th><th>Project</th><th>Items</th><th>Total</th><th>Status</th></tr></thead>
        <tbody>`;

      orders.forEach(o => {
        const projLabel = (_config.projects.find(p => p.id === o.project) || {}).label || o.project;
        const itemCount = (o.items || []).length;
        const badge = o.status === 'reviewed'
          ? '<span class="proc-badge proc-badge--reviewed">reviewed</span>'
          : '<span class="proc-badge proc-badge--submitted">submitted</span>';

        html += `<tr>
          <td>${o.date || ''}</td>
          <td><strong>${esc(o.vendor)}</strong>${o.orderNumber ? '<br><span style="color:var(--muted);font-size:.75rem;">#' + esc(o.orderNumber) + '</span>' : ''}</td>
          <td>${esc(projLabel)}</td>
          <td>${itemCount} item${itemCount !== 1 ? 's' : ''}</td>
          <td>$${(o.total || 0).toFixed(2)}</td>
          <td>${badge}</td>
        </tr>`;

        // Show PI notes if any
        if (o.piNotes) {
          html += `<tr><td colspan="6" style="padding:.25rem .75rem .5rem;font-size:.78rem;color:var(--muted);"><strong>PI:</strong> ${esc(o.piNotes)}</td></tr>`;
        }
      });

      html += '</tbody></table>';
      c.innerHTML = html;
    } catch (err) {
      c.innerHTML = `<div class="app-empty"><p style="color:var(--danger);">Error: ${err.message}</p></div>`;
    }
    notifyResize();
  }

  /* ─── Utilities ─────────────────────────────────────────── */

  function esc(s) {
    if (!s) return '';
    const d = document.createElement('div');
    d.textContent = s;
    return d.innerHTML;
  }

  function notifyResize() {
    if (McgheeLab.AppBridge.isEmbedded()) {
      window.parent.postMessage({ type: 'mcgheelab-app-resize', height: document.body.scrollHeight }, window.location.origin);
    }
  }
})();
