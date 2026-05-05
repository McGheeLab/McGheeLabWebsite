/* ================================================================
   Procurement — V3.44
   ----------------------------------------------------------------
   Unified ticket lifecycle: a single page covers the full pipeline
   from request → approval → order → receive → place → inventory.

   Pipeline stages (mapped to procurementTickets/{id}.status):

     1. requested  — student fills form: itemDescription, vendor,
                     estimatedCost, justification, reason, urgency,
                     category, project, fundingAccount.
     2. approved   — admin approves (or denies → 'denied'); piNotes,
                     approvedBy, approvedAt stamped.
     3. ordered    — admin uploads PO (PDF/image to Storage) and
                     captures poNumber + orderDate + expectedDelivery.
     4. received   — any lab member marks the package received from
                     the Open Orders list. Optional receipt upload +
                     actualCost capture. receivedBy / receivedAt.
     5. placed     — anyone records `location` ("cold room shelf 3",
                     "freezer A drawer 2", etc.). Auto-creates an
                     inventory/{id} doc with kind='item' and stamps
                     inventoryItemId on the ticket so the two stay
                     linked.

   Tabs (gated by role):
     - Submit Request  (everyone)
     - My Tickets      (everyone, filter requestedBy === uid)
     - Pending         (admin only, status=requested)
     - Awaiting Order  (admin only, status=approved & !poUrl)
     - Open Orders     (everyone, status=ordered)
     - Awaiting Place  (everyone, status=received)
     - Archive         (everyone, status in [placed, denied])

   Data layer follows the rm/js/meetings.js pattern: api.load for
   initial paint, LIVE_SYNC.attach for cross-tab/user updates,
   surgical Firestore writes via firebridge.db() with
   _live.suppressUntil to skip the echo.

   Storage paths: procurement/{ticketId}/po-* and
                  procurement/{ticketId}/receipt-*
   covered by the storage.rules block widened in V3.44 to accept
   images alongside PDFs (phone photos of receipts).
   ================================================================ */

(function () {
  'use strict';

  const root = document.getElementById('proc-root');
  if (!root) {
    console.warn('[procurement] #proc-root container missing');
    return;
  }

  /* ─── State ─────────────────────────────────────────────── */
  let _user = null;
  let _profile = null;
  let _tickets = [];
  let _users = [];
  let _projects = [];
  let _fundingSources = [];
  let _activeTab = 'my';
  let _live = null;
  let _toastTimer = null;
  let _archiveSearch = '';

  function db() {
    if (typeof firebridge !== 'undefined' && firebridge.db) return firebridge.db();
    if (typeof firebase === 'undefined') throw new Error('Firebase SDK not loaded');
    return firebase.firestore();
  }

  /* ─── Boot ──────────────────────────────────────────────── */
  (async function () {
    if (typeof firebridge === 'undefined') {
      console.warn('[procurement] firebridge not available');
      return;
    }
    firebridge.gateSignedIn();
    if (firebridge.whenAuthResolved) await firebridge.whenAuthResolved();

    _user = firebridge.getUser ? firebridge.getUser() : null;
    _profile = firebridge.getProfile ? firebridge.getProfile() : null;
    if (!_user) return;

    try {
      await loadAndRender();
    } catch (err) {
      console.warn('[procurement] initial load failed:', err);
      root.innerHTML = '<div class="empty-state">Failed to load procurement — see console.</div>';
      return;
    }

    if (typeof LIVE_SYNC !== 'undefined' && LIVE_SYNC.attach) {
      _live = LIVE_SYNC.attach({
        paths: ['procurement/tickets.json', 'lab/users.json'],
        refresh: loadAndRender,
        tag: 'procurement',
      });
    }

    if (firebridge.onAuth) {
      firebridge.onAuth(function () {
        const prevRole = _profile && _profile.role;
        _user = firebridge.getUser ? firebridge.getUser() : _user;
        _profile = firebridge.getProfile ? firebridge.getProfile() : _profile;
        if ((_profile && _profile.role) !== prevRole) render();
      });
    }
  })();

  async function loadAndRender() {
    const [tix, usersData, projDoc, fundDoc] = await Promise.all([
      api.load('procurement/tickets.json'),
      api.load('lab/users.json'),
      // labConfig docs read directly — not registered as routes; small,
      // single-doc reads fine without cache.
      db().collection('labConfig').doc('projects').get().catch(() => null),
      db().collection('labConfig').doc('fundingSources').get().catch(() => null),
    ]);

    _tickets = (tix && tix.tickets) || [];
    _tickets.sort(function (a, b) {
      // Newest first by createdAt; null-safe.
      const ta = (a.createdAt && a.createdAt.seconds) || 0;
      const tb = (b.createdAt && b.createdAt.seconds) || 0;
      return tb - ta;
    });

    const allUsers = (usersData && usersData.users) || [];
    _users = allUsers.filter(u => u.role !== 'guest');

    _projects = (projDoc && projDoc.exists && (projDoc.data().projects || projDoc.data().items)) || [];
    _fundingSources = (fundDoc && fundDoc.exists && (fundDoc.data().fundingSources || fundDoc.data().sources || fundDoc.data().items)) || [];

    render();
  }

  /* ─── Helpers ───────────────────────────────────────────── */
  function escHTML(s) {
    if (s == null) return '';
    const d = document.createElement('div');
    d.textContent = String(s);
    return d.innerHTML;
  }

  function genId() {
    return (typeof crypto !== 'undefined' && crypto.randomUUID)
      ? crypto.randomUUID()
      : 'xxxx-xxxx-xxxx'.replace(/x/g, () => ((Math.random() * 16) | 0).toString(16));
  }

  function isAdmin() { return _profile && _profile.role === 'admin'; }

  function userName(uid) {
    if (!uid) return '';
    const u = _users.find(x => x.uid === uid);
    return u ? (u.name || u.displayName || u.email) : uid.slice(0, 6);
  }

  function fmtMoney(n) {
    if (n == null || n === '' || isNaN(+n)) return '';
    return '$' + (+n).toFixed(2);
  }

  function fmtDate(d) {
    if (!d) return '';
    if (typeof d === 'string') return d;
    if (d.seconds) return new Date(d.seconds * 1000).toISOString().slice(0, 10);
    if (d instanceof Date) return d.toISOString().slice(0, 10);
    return '';
  }

  function fmtDateLong(d) {
    const s = fmtDate(d);
    if (!s) return '';
    return new Date(s + 'T12:00:00').toLocaleDateString('en-US', {
      month: 'short', day: 'numeric', year: 'numeric'
    });
  }

  function todayStr() {
    const d = new Date();
    return d.getFullYear() + '-' + String(d.getMonth() + 1).padStart(2, '0') + '-' + String(d.getDate()).padStart(2, '0');
  }

  function statusChip(s) {
    const map = {
      requested: 'pending',
      approved:  'approved',
      denied:    'denied',
      ordered:   'ordered',
      received:  'received',
      placed:    'placed',
    };
    const cls = map[s] || 'pending';
    return '<span class="proc-chip proc-chip--' + cls + '">' + (s || 'requested') + '</span>';
  }

  function urgencyChip(u) {
    const cls = u === 'urgent' ? 'urgent' : (u === 'needed_soon' ? 'soon' : 'routine');
    const label = (u || 'routine').replace(/_/g, ' ');
    return '<span class="proc-chip proc-chip-urg--' + cls + '">' + label + '</span>';
  }

  function toast(msg, kind) {
    if (typeof window !== 'undefined' && typeof window.toast === 'function' && window.toast !== toast) {
      try { window.toast(msg, kind); return; } catch (e) {}
    }
    const ex = document.querySelector('.proc-toast');
    if (ex) ex.remove();
    clearTimeout(_toastTimer);
    const el = document.createElement('div');
    el.className = 'proc-toast' + (kind === 'error' ? ' proc-toast--error' : '');
    el.textContent = msg;
    document.body.appendChild(el);
    _toastTimer = setTimeout(() => el.remove(), 2800);
  }

  function _suppress(ms) { if (_live) _live.suppressUntil = Date.now() + (ms || 2500); }

  /* ─── Tabs ──────────────────────────────────────────────── */
  function tabs() {
    const t = [
      { key: 'submit',  label: '+ Submit Request' },
      { key: 'my',      label: 'My Tickets (' + countMine() + ')' },
    ];
    if (isAdmin()) {
      t.push({ key: 'pending', label: 'Pending (' + countByStatus('requested') + ')' });
      t.push({ key: 'awaiting-order', label: 'Awaiting Order (' + countAwaitingOrder() + ')' });
    }
    t.push({ key: 'open-orders',  label: 'Open Orders (' + countByStatus('ordered') + ')' });
    t.push({ key: 'awaiting-place', label: 'Awaiting Placement (' + countByStatus('received') + ')' });
    t.push({ key: 'archive', label: 'Archive' });
    return t;
  }

  function countMine() { return _user ? _tickets.filter(t => t.requestedBy === _user.uid).length : 0; }
  function countByStatus(s) { return _tickets.filter(t => t.status === s).length; }
  function countAwaitingOrder() { return _tickets.filter(t => t.status === 'approved' && !t.poUrl).length; }

  /* ─── Render dispatcher ─────────────────────────────────── */
  function render() {
    const tabHTML = tabs().map(t =>
      '<button class="tab-btn' + (_activeTab === t.key ? ' active' : '') +
      '" data-tab="' + t.key + '">' + escHTML(t.label) + '</button>'
    ).join('');

    root.innerHTML =
      '<div class="proc-tabbar">' + tabHTML + '</div>' +
      '<div id="proc-content" class="proc-content"></div>';

    root.querySelectorAll('[data-tab]').forEach(btn => {
      btn.addEventListener('click', () => {
        _activeTab = btn.dataset.tab;
        render();
      });
    });

    renderActiveTab();
  }

  function renderActiveTab() {
    const c = document.getElementById('proc-content');
    if (!c) return;
    switch (_activeTab) {
      case 'submit':         return renderSubmit(c);
      case 'my':             return renderList(c, _tickets.filter(t => _user && t.requestedBy === _user.uid),
                                                 'You haven’t submitted any tickets yet.');
      case 'pending':        return renderList(c, _tickets.filter(t => t.status === 'requested'),
                                                 'No requests pending approval.');
      case 'awaiting-order': return renderList(c, _tickets.filter(t => t.status === 'approved' && !t.poUrl),
                                                 'No approved tickets waiting for a PO.');
      case 'open-orders':    return renderList(c, _tickets.filter(t => t.status === 'ordered'),
                                                 'No open orders right now.');
      case 'awaiting-place': return renderList(c, _tickets.filter(t => t.status === 'received'),
                                                 'No items waiting to be placed.');
      case 'archive':        return renderArchive(c);
      default:               return renderList(c, _tickets, 'No tickets.');
    }
  }

  /* ─── Submit Request form ───────────────────────────────── */
  function renderSubmit(c) {
    c.innerHTML =
      '<div class="proc-card">' +
        '<h2 class="proc-h2">Request a Purchase</h2>' +
        '<p class="proc-muted">Describe what you need. The PI reviews the request, places the order, and the package gets routed through receipt + placement before landing in inventory.</p>' +
        '<div class="proc-form">' +
          formRow('What do you need?*', 'textarea', 'pr-desc', '', 'e.g. 100 mL polyethylene glycol (PEG), MW 6000') +
          gridRow(
            formRow('Vendor (if known)', 'text', 'pr-vendor', '', 'e.g. Sigma-Aldrich'),
            formRow('Catalogue / Part #', 'text', 'pr-catalog', '', '')
          ) +
          gridRow(
            formRow('Estimated Cost ($)', 'number', 'pr-cost', '', '0.00'),
            formRow('Quantity', 'number', 'pr-qty', '1', '')
          ) +
          gridRow(
            selectRow('Project', 'pr-project', _projects.map(p => ({ value: p.id || p.slug || p.name, label: p.name || p.title || p.id }))),
            selectRow('Funding Source', 'pr-funding', _fundingSources.map(f => ({ value: f.id || f.slug || f.name, label: f.name || f.label || f.id })))
          ) +
          formRow('Why do you need this? (Reason / experiment context)*', 'textarea', 'pr-reason', '', 'Which experiment, which protocol step, what would block without this?') +
          gridRow(
            selectRow('Urgency', 'pr-urgency', [
              { value: 'routine', label: 'Routine' },
              { value: 'needed_soon', label: 'Needed Soon' },
              { value: 'urgent', label: 'Urgent (block on this)' },
            ]),
            selectRow('Category', 'pr-category', [
              { value: 'consumable', label: 'Consumable' },
              { value: 'reagent',    label: 'Reagent / Chemical' },
              { value: 'equipment',  label: 'Equipment' },
              { value: 'software',   label: 'Software / License' },
              { value: 'office',     label: 'Office / Furniture' },
              { value: 'other',      label: 'Other' },
            ])
          ) +
          '<div class="proc-form-actions">' +
            '<div id="pr-error" class="proc-error" hidden></div>' +
            '<button class="btn btn-primary" id="pr-submit">Submit Request</button>' +
          '</div>' +
        '</div>' +
      '</div>';

    document.getElementById('pr-submit').addEventListener('click', async () => {
      const desc   = (document.getElementById('pr-desc').value || '').trim();
      const reason = (document.getElementById('pr-reason').value || '').trim();
      const errEl  = document.getElementById('pr-error');
      if (!desc || !reason) {
        errEl.textContent = 'Description and reason are both required.';
        errEl.hidden = false;
        return;
      }
      errEl.hidden = true;
      const btn = document.getElementById('pr-submit');
      btn.disabled = true;
      btn.textContent = 'Submitting…';
      try {
        await createTicket({
          itemDescription: desc,
          vendor: (document.getElementById('pr-vendor').value || '').trim(),
          catalogueNumber: (document.getElementById('pr-catalog').value || '').trim(),
          estimatedCost: parseFloat(document.getElementById('pr-cost').value) || 0,
          quantity: parseFloat(document.getElementById('pr-qty').value) || 1,
          project: document.getElementById('pr-project').value || '',
          fundingAccount: document.getElementById('pr-funding').value || '',
          reason: reason,
          urgency: document.getElementById('pr-urgency').value || 'routine',
          category: document.getElementById('pr-category').value || 'consumable',
        });
        _activeTab = 'my';
        render();
      } catch (err) {
        errEl.textContent = 'Submit failed: ' + (err.message || err);
        errEl.hidden = false;
        btn.disabled = false;
        btn.textContent = 'Submit Request';
      }
    });
  }

  function formRow(label, type, id, value, placeholder) {
    const required = label.endsWith('*');
    const safeLabel = escHTML(label);
    if (type === 'textarea') {
      return '<div class="proc-form-row">' +
        '<label class="proc-label" for="' + id + '">' + safeLabel + '</label>' +
        '<textarea class="proc-input" id="' + id + '" rows="3" placeholder="' + escHTML(placeholder || '') + '">' + escHTML(value || '') + '</textarea>' +
      '</div>';
    }
    return '<div class="proc-form-row">' +
      '<label class="proc-label" for="' + id + '">' + safeLabel + '</label>' +
      '<input class="proc-input" id="' + id + '" type="' + type + '" value="' + escHTML(value || '') + '" placeholder="' + escHTML(placeholder || '') + '"' + (required ? ' required' : '') + ' />' +
    '</div>';
  }

  function selectRow(label, id, options) {
    const opts = (options || []).map(o =>
      '<option value="' + escHTML(o.value) + '">' + escHTML(o.label) + '</option>'
    ).join('');
    return '<div class="proc-form-row">' +
      '<label class="proc-label" for="' + id + '">' + escHTML(label) + '</label>' +
      '<select class="proc-input" id="' + id + '">' +
        '<option value="">— select —</option>' + opts +
      '</select>' +
    '</div>';
  }

  function gridRow() {
    const cells = Array.prototype.slice.call(arguments).map(s => '<div>' + s + '</div>').join('');
    return '<div class="proc-grid-2">' + cells + '</div>';
  }

  /* ─── List view (per-tab table) ─────────────────────────── */
  function renderList(c, list, emptyMsg) {
    if (!list.length) {
      c.innerHTML = '<div class="empty-state">' + escHTML(emptyMsg) + '</div>';
      return;
    }

    c.innerHTML =
      '<div class="proc-list">' +
        list.map(t => ticketCard(t)).join('') +
      '</div>';

    list.forEach(t => wireTicket(t.id));
  }

  /* ─── Archive view (placed + denied, with search) ───────── */
  function renderArchive(c) {
    const archive = _tickets.filter(t => t.status === 'placed' || t.status === 'denied');
    let view = archive;
    if (_archiveSearch) {
      const q = _archiveSearch.toLowerCase();
      view = view.filter(t =>
        (t.itemDescription || '').toLowerCase().includes(q) ||
        (t.vendor || '').toLowerCase().includes(q) ||
        (t.requesterName || '').toLowerCase().includes(q) ||
        (t.location || '').toLowerCase().includes(q)
      );
    }

    c.innerHTML =
      '<div class="proc-archive">' +
        '<div class="proc-archive-bar">' +
          '<input class="proc-input" id="proc-archive-search" type="text" ' +
            'placeholder="Search archive (item, vendor, requester, location)" ' +
            'value="' + escHTML(_archiveSearch) + '" />' +
          '<span class="proc-muted">Showing ' + view.length + ' of ' + archive.length + '</span>' +
        '</div>' +
        (view.length
          ? '<div class="proc-list">' + view.map(t => ticketCard(t)).join('') + '</div>'
          : '<div class="empty-state">No archived tickets match.</div>') +
      '</div>';

    const search = document.getElementById('proc-archive-search');
    if (search) {
      let timer;
      search.addEventListener('input', () => {
        clearTimeout(timer);
        timer = setTimeout(() => {
          _archiveSearch = search.value || '';
          renderActiveTab();
        }, 250);
      });
    }
    view.forEach(t => wireTicket(t.id));
  }

  /* ─── Single-ticket card (used by every tab) ────────────── */
  function ticketCard(t) {
    const own = _user && t.requestedBy === _user.uid;
    const urgent = t.urgency === 'urgent';
    return (
      '<div class="proc-ticket' + (urgent ? ' proc-ticket--urgent' : '') + '" data-ticket="' + t.id + '">' +
        '<div class="proc-ticket-head">' +
          '<div class="proc-ticket-title">' +
            '<strong>' + escHTML(t.itemDescription) + '</strong>' +
            (t.vendor ? '<span class="proc-muted"> — ' + escHTML(t.vendor) + '</span>' : '') +
          '</div>' +
          '<div class="proc-ticket-chips">' +
            statusChip(t.status) +
            urgencyChip(t.urgency) +
          '</div>' +
        '</div>' +

        '<div class="proc-ticket-meta">' +
          '<span><strong>Requester:</strong> ' + escHTML(t.requesterName || userName(t.requestedBy)) + '</span>' +
          (t.project        ? '<span><strong>Project:</strong> ' + escHTML(t.project) + '</span>' : '') +
          (t.fundingAccount ? '<span><strong>Funding:</strong> ' + escHTML(t.fundingAccount) + '</span>' : '') +
          (t.estimatedCost  ? '<span><strong>Est. cost:</strong> ' + fmtMoney(t.estimatedCost) + '</span>' : '') +
          (t.quantity       ? '<span><strong>Qty:</strong> ' + escHTML(t.quantity) + '</span>' : '') +
          (t.catalogueNumber ? '<span><strong>Cat#:</strong> ' + escHTML(t.catalogueNumber) + '</span>' : '') +
        '</div>' +

        (t.reason ? '<div class="proc-ticket-reason"><strong>Why:</strong> ' + escHTML(t.reason) + '</div>' : '') +
        (t.justification ? '<div class="proc-ticket-just"><strong>Justification:</strong> ' + escHTML(t.justification) + '</div>' : '') +

        // Lifecycle stamps
        '<div class="proc-ticket-stamps">' +
          (t.approvedAt ? '<span>✅ Approved by ' + escHTML(t.approvedByName || userName(t.approvedBy)) + ' on ' + fmtDateLong(t.approvedAt) + '</span>' : '') +
          (t.piNotes ? '<span class="proc-pi-notes"><strong>PI notes:</strong> ' + escHTML(t.piNotes) + '</span>' : '') +
          (t.poNumber || t.poUrl ? '<span>📄 PO ' + (t.poNumber ? '#' + escHTML(t.poNumber) : '') +
            (t.poUrl ? ' — <a href="' + escHTML(t.poUrl) + '" target="_blank" rel="noopener">view</a>' : '') +
            (t.orderDate ? ' (ordered ' + fmtDateLong(t.orderDate) + ')' : '') + '</span>' : '') +
          (t.expectedDelivery ? '<span>🚚 ETA ' + fmtDateLong(t.expectedDelivery) + '</span>' : '') +
          (t.receivedAt ? '<span>📦 Received by ' + escHTML(t.receivedByName || userName(t.receivedBy)) + ' on ' + fmtDateLong(t.receivedAt) +
            (t.actualCost ? ' — ' + fmtMoney(t.actualCost) : '') +
            (t.receiptUrl ? ' — <a href="' + escHTML(t.receiptUrl) + '" target="_blank" rel="noopener">receipt</a>' : '') + '</span>' : '') +
          (t.location ? '<span>📍 Placed at <strong>' + escHTML(t.location) + '</strong>' +
            (t.placedByName || t.placedBy ? ' by ' + escHTML(t.placedByName || userName(t.placedBy)) : '') + '</span>' : '') +
          (t.inventoryItemId ? '<span>📚 In inventory: <code>' + escHTML(t.inventoryItemId) + '</code></span>' : '') +
        '</div>' +

        // Action bar — affordances depend on stage + role
        '<div class="proc-ticket-actions">' +
          actionsHTML(t, own) +
        '</div>' +
      '</div>'
    );
  }

  function actionsHTML(t, own) {
    const buttons = [];

    if (t.status === 'requested') {
      if (isAdmin()) {
        buttons.push('<button class="btn btn-primary" data-act="approve">Approve</button>');
        buttons.push('<button class="btn" data-act="deny">Deny</button>');
      }
      if (own) {
        buttons.push('<button class="btn" data-act="cancel">Cancel</button>');
      }
    } else if (t.status === 'approved') {
      if (isAdmin()) {
        buttons.push('<button class="btn btn-primary" data-act="upload-po">Upload PO &amp; mark Ordered</button>');
      }
    } else if (t.status === 'ordered') {
      buttons.push('<button class="btn btn-primary" data-act="receive">Mark Received</button>');
    } else if (t.status === 'received') {
      buttons.push('<button class="btn btn-primary" data-act="place">Record Placement &amp; add to Inventory</button>');
    } else if (t.status === 'placed') {
      if (t.inventoryItemId) {
        buttons.push('<a class="btn" href="/rm/pages/inventory.html#' + escHTML(t.inventoryItemId) + '">Open in Inventory</a>');
      }
    }

    if (isAdmin() && t.status !== 'placed') {
      buttons.push('<button class="btn proc-btn-danger" data-act="delete">Delete</button>');
    }

    return buttons.join('');
  }

  function wireTicket(ticketId) {
    const card = root.querySelector('[data-ticket="' + ticketId + '"]');
    if (!card) return;
    card.querySelectorAll('[data-act]').forEach(btn => {
      btn.addEventListener('click', () => onAction(ticketId, btn.dataset.act));
    });
  }

  /* ─── Action dispatcher ─────────────────────────────────── */
  async function onAction(ticketId, act) {
    const t = _tickets.find(x => x.id === ticketId);
    if (!t) return;
    switch (act) {
      case 'approve':   return approveTicket(t);
      case 'deny':      return denyTicket(t);
      case 'cancel':    return cancelTicket(t);
      case 'upload-po': return openPOModal(t);
      case 'receive':   return openReceiveModal(t);
      case 'place':     return openPlaceModal(t);
      case 'delete':    return deleteTicket(t);
    }
  }

  /* ─── Lifecycle writes ──────────────────────────────────── */
  async function createTicket(payload) {
    const data = {
      ...payload,
      requestedBy: _user.uid,
      requesterName: (_profile && _profile.name) || _user.displayName || _user.email,
      status: 'requested',
      piNotes: '',
      createdAt: firebase.firestore.FieldValue.serverTimestamp(),
      updatedAt: firebase.firestore.FieldValue.serverTimestamp(),
    };
    _suppress();
    const ref = await db().collection('procurementTickets').add(data);
    _tickets.unshift({ id: ref.id, ...data });
    toast('Request submitted');
  }

  async function approveTicket(t) {
    const notes = window.prompt('Add a PI note (optional):', t.piNotes || '');
    if (notes === null) return; // cancel
    const patch = {
      status: 'approved',
      piNotes: notes || '',
      approvedBy: _user.uid,
      approvedByName: (_profile && _profile.name) || _user.displayName || _user.email,
      approvedAt: firebase.firestore.FieldValue.serverTimestamp(),
      updatedAt: firebase.firestore.FieldValue.serverTimestamp(),
    };
    await applyPatch(t, patch, 'approved');
  }

  async function denyTicket(t) {
    const notes = window.prompt('Reason for denial (optional):', '');
    if (notes === null) return;
    const patch = {
      status: 'denied',
      piNotes: notes || '',
      approvedBy: _user.uid,
      approvedByName: (_profile && _profile.name) || _user.displayName || _user.email,
      approvedAt: firebase.firestore.FieldValue.serverTimestamp(),
      updatedAt: firebase.firestore.FieldValue.serverTimestamp(),
    };
    await applyPatch(t, patch, 'denied');
  }

  async function cancelTicket(t) {
    if (!confirm('Cancel this request? It will be marked denied.')) return;
    const patch = {
      status: 'denied',
      piNotes: 'Cancelled by requester.',
      updatedAt: firebase.firestore.FieldValue.serverTimestamp(),
    };
    await applyPatch(t, patch, 'cancelled');
  }

  async function deleteTicket(t) {
    if (!confirm('Delete this ticket permanently?')) return;
    _suppress();
    await db().collection('procurementTickets').doc(t.id).delete();
    _tickets = _tickets.filter(x => x.id !== t.id);
    toast('Ticket deleted');
    render();
  }

  async function applyPatch(t, patch, label) {
    _suppress();
    await db().collection('procurementTickets').doc(t.id).update(patch);
    Object.assign(t, patch);
    if (label) toast('Marked ' + label);
    render();
  }

  /* ─── PO upload modal ───────────────────────────────────── */
  function openPOModal(t) {
    const overlay = makeModal('Upload Purchase Order',
      '<p class="proc-muted">Mark <strong>' + escHTML(t.itemDescription) + '</strong> as ordered. Attach the PO PDF or image and capture the order details.</p>' +
      formRow('PO Number', 'text', 'po-number', t.poNumber || '', 'e.g. ILAB-12345 or PO-2026-001') +
      gridRow(
        formRow('Order Date', 'date', 'po-date', t.orderDate || todayStr(), ''),
        formRow('Expected Delivery', 'date', 'po-eta', t.expectedDelivery || '', '')
      ) +
      '<div class="proc-form-row">' +
        '<label class="proc-label">PO file (PDF or image)</label>' +
        '<input class="proc-input" id="po-file" type="file" accept="application/pdf,image/*" />' +
      '</div>' +
      '<div class="proc-form-row" hidden id="po-progress"></div>',
      [
        { label: 'Confirm — mark Ordered', primary: true, async onClick(closeFn) {
          const poNum  = (document.getElementById('po-number').value || '').trim();
          const date   = document.getElementById('po-date').value;
          const eta    = document.getElementById('po-eta').value;
          const fileEl = document.getElementById('po-file');
          const file   = fileEl.files && fileEl.files[0];
          const prog   = document.getElementById('po-progress');

          let poUrl = t.poUrl || '';
          let poStoragePath = t.poStoragePath || '';
          if (file) {
            try {
              prog.hidden = false;
              prog.textContent = 'Uploading PO…';
              const up = await uploadFile(t.id, file, 'po');
              poUrl = up.url;
              poStoragePath = up.path;
            } catch (err) {
              prog.textContent = 'Upload failed: ' + (err.message || err);
              return;
            }
          }
          await applyPatch(t, {
            status: 'ordered',
            poNumber: poNum,
            poUrl: poUrl,
            poStoragePath: poStoragePath,
            orderDate: date || todayStr(),
            expectedDelivery: eta || '',
            updatedAt: firebase.firestore.FieldValue.serverTimestamp(),
          }, 'ordered');
          closeFn();
        } },
        { label: 'Cancel' },
      ]
    );
  }

  /* ─── Receive modal ─────────────────────────────────────── */
  function openReceiveModal(t) {
    makeModal('Mark package received',
      '<p class="proc-muted">Confirm <strong>' + escHTML(t.itemDescription) + '</strong> arrived. Optionally attach a receipt and capture the actual cost.</p>' +
      formRow('Actual cost paid ($, optional)', 'number', 'rcv-cost', '', t.estimatedCost ? String(t.estimatedCost) : '0.00') +
      '<div class="proc-form-row">' +
        '<label class="proc-label">Receipt (PDF or photo, optional)</label>' +
        '<input class="proc-input" id="rcv-file" type="file" accept="application/pdf,image/*" />' +
      '</div>' +
      '<div class="proc-form-row" hidden id="rcv-progress"></div>',
      [
        { label: 'Confirm — mark Received', primary: true, async onClick(closeFn) {
          const cost   = parseFloat(document.getElementById('rcv-cost').value);
          const fileEl = document.getElementById('rcv-file');
          const file   = fileEl.files && fileEl.files[0];
          const prog   = document.getElementById('rcv-progress');

          let url = '';
          let path = '';
          if (file) {
            try {
              prog.hidden = false;
              prog.textContent = 'Uploading receipt…';
              const up = await uploadFile(t.id, file, 'receipt');
              url = up.url;
              path = up.path;
            } catch (err) {
              prog.textContent = 'Upload failed: ' + (err.message || err);
              return;
            }
          }
          await applyPatch(t, {
            status: 'received',
            actualCost: isNaN(cost) ? null : cost,
            receiptUrl: url || (t.receiptUrl || ''),
            receiptStoragePath: path || (t.receiptStoragePath || ''),
            receivedBy: _user.uid,
            receivedByName: (_profile && _profile.name) || _user.displayName || _user.email,
            receivedAt: firebase.firestore.FieldValue.serverTimestamp(),
            updatedAt: firebase.firestore.FieldValue.serverTimestamp(),
          }, 'received');
          closeFn();
        } },
        { label: 'Cancel' },
      ]
    );
  }

  /* ─── Placement modal — also creates the inventory doc ──── */
  function openPlaceModal(t) {
    makeModal('Record placement & add to inventory',
      '<p class="proc-muted">Where did <strong>' + escHTML(t.itemDescription) + '</strong> end up? An inventory record is created in <code>inventory/</code> with kind <code>item</code>, linked back to this ticket.</p>' +
      formRow('Location*', 'text', 'pl-loc', '', 'e.g. Cold room shelf 3, Freezer A drawer 2, Bench 4 cabinet') +
      gridRow(
        formRow('Quantity received', 'number', 'pl-qty', String(t.quantity || 1), ''),
        formRow('Unit price ($, optional)', 'number', 'pl-price',
          String((t.actualCost && t.quantity) ? (t.actualCost / t.quantity).toFixed(2) :
                 (t.actualCost || t.estimatedCost || 0)), '')
      ) +
      formRow('Inventory category', 'text', 'pl-cat', t.category || 'consumable', '') +
      formRow('Notes (optional)', 'textarea', 'pl-notes', '', 'Anything reorder-relevant — minimum stock, lot #, expiration, etc.'),
      [
        { label: 'Confirm — create inventory item', primary: true, async onClick(closeFn) {
          const loc = (document.getElementById('pl-loc').value || '').trim();
          if (!loc) { toast('Location is required', 'error'); return; }

          const qty   = parseFloat(document.getElementById('pl-qty').value) || 1;
          const price = parseFloat(document.getElementById('pl-price').value) || 0;
          const cat   = (document.getElementById('pl-cat').value || 'consumable').trim();
          const notes = (document.getElementById('pl-notes').value || '').trim();

          // Create inventory doc first so we have its ID for back-ref.
          const invId = await createInventoryItem(t, { location: loc, quantity: qty, unit_price: price, category: cat, notes });

          await applyPatch(t, {
            status: 'placed',
            location: loc,
            placedBy: _user.uid,
            placedByName: (_profile && _profile.name) || _user.displayName || _user.email,
            placedAt: firebase.firestore.FieldValue.serverTimestamp(),
            inventoryItemId: invId,
            updatedAt: firebase.firestore.FieldValue.serverTimestamp(),
          }, 'placed & added to inventory');
          closeFn();
        } },
        { label: 'Cancel' },
      ]
    );
  }

  async function createInventoryItem(t, opts) {
    _suppress();
    const data = {
      name: t.itemDescription || 'Untitled item',
      category: opts.category || t.category || 'consumable',
      vendor: t.vendor || '',
      catalogue_number: t.catalogueNumber || '',
      quantity: opts.quantity || 1,
      unit_price: opts.unit_price || 0,
      stock_status: 'full',
      locations: [{ name: opts.location, qty: opts.quantity || 1, notes: '' }],
      notes: opts.notes || '',
      kind: 'item',
      procurementTicketId: t.id,
      addedBy: _user.uid,
      addedAt: firebase.firestore.FieldValue.serverTimestamp(),
      updatedAt: firebase.firestore.FieldValue.serverTimestamp(),
    };
    const ref = await db().collection('inventory').add(data);
    return ref.id;
  }

  /* ─── Storage upload helper ─────────────────────────────── */
  async function uploadFile(ticketId, file, kind) {
    if (typeof firebase === 'undefined' || !firebase.storage) {
      throw new Error('Firebase Storage SDK not loaded');
    }
    const safe = file.name.replace(/[^a-zA-Z0-9._-]/g, '_');
    const path = 'procurement/' + ticketId + '/' + kind + '-' + Date.now() + '-' + safe;
    const ref = firebase.storage().ref().child(path);
    const snap = await ref.put(file);
    const url = await snap.ref.getDownloadURL();
    return { url, path };
  }

  /* ─── Modal helper ──────────────────────────────────────── */
  function makeModal(title, bodyHTML, actions) {
    const overlay = document.createElement('div');
    overlay.className = 'proc-modal-overlay';
    const actHTML = (actions || []).map((a, i) =>
      '<button class="btn ' + (a.primary ? 'btn-primary' : '') + '" data-act-i="' + i + '">' + escHTML(a.label) + '</button>'
    ).join('');
    overlay.innerHTML =
      '<div class="proc-modal">' +
        '<h3 class="proc-modal-title">' + escHTML(title) + '</h3>' +
        '<div class="proc-modal-body">' + bodyHTML + '</div>' +
        '<div class="proc-modal-actions">' + actHTML + '</div>' +
      '</div>';
    document.body.appendChild(overlay);

    function close() { overlay.remove(); }
    overlay.addEventListener('click', e => { if (e.target === overlay) close(); });

    overlay.querySelectorAll('[data-act-i]').forEach(btn => {
      const i = parseInt(btn.dataset.actI);
      btn.addEventListener('click', async () => {
        const a = actions[i];
        if (!a || !a.onClick) { close(); return; }
        try {
          btn.disabled = true;
          await a.onClick(close);
        } catch (err) {
          console.warn('[procurement] modal action failed:', err);
          toast('Action failed: ' + (err.message || err), 'error');
          btn.disabled = false;
        }
      });
    });

    return overlay;
  }
})();
