/* grant-builder.js — V3.179.
 *
 * List of grant drafts + "new grant" creation flow. Mirrors paper-builder.js
 * but reads/writes the `grantDrafts/{id}` collection directly via firebridge
 * (no JSON shadow, no adapter route — Firestore-native collection).
 *
 * Phase A scope: each card links into grant-builder.html?grant=<id>. The
 * editor materializes the tree subdoc on first save.
 */

(function () {
  'use strict';

  var COLL = 'grantDrafts';

  var statusEl   = document.getElementById('gb-status');
  var listEl     = document.getElementById('gb-list');
  var newBtn     = document.getElementById('gb-new-grant-btn');
  var modalEl    = document.getElementById('gb-modal');
  var modalClose = document.getElementById('gb-modal-close');
  var modalCancel= document.getElementById('gb-modal-cancel');
  var modalCreate= document.getElementById('gb-modal-create');
  var modalError = document.getElementById('gb-modal-error');
  var titleInput = document.getElementById('gb-new-title');
  var templateSel= document.getElementById('gb-new-template');
  var templateHint = document.getElementById('gb-new-template-hint');
  var mechInput  = document.getElementById('gb-new-mechanism');
  var agencyInput= document.getElementById('gb-new-agency');
  var deadlineInput = document.getElementById('gb-new-deadline');

  var drafts = [];

  function esc(s) {
    return String(s == null ? '' : s).replace(/[&<>"']/g, function (c) {
      return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c];
    });
  }

  function setStatus(msg, kind) {
    if (!statusEl) return;
    statusEl.textContent = msg || '';
    statusEl.className = 'pb-status' + (kind ? ' pb-status-' + kind : '');
  }

  function statusChipHtml(s) {
    var label = s || 'draft';
    var color = {
      'draft':           '#6b7280',
      'internal-review': '#0369a1',
      'submitted':       '#7c3aed',
      'awarded':         '#047857',
      'declined':        '#b91c1c',
    }[label] || '#6b7280';
    return '<span class="chip" style="background:' + color + ';color:#fff;">' + esc(label) + '</span>';
  }

  function fmtDate(d) {
    if (!d) return '';
    try {
      if (typeof d === 'string') return d;
      if (d.toDate) return d.toDate().toLocaleDateString();
      if (d.seconds) return new Date(d.seconds * 1000).toLocaleDateString();
    } catch (e) {}
    return '';
  }

  async function load() {
    if (typeof firebridge === 'undefined' || !firebridge.db) {
      listEl.innerHTML = '<div class="empty-state">Firebase not ready — try refreshing.</div>';
      return;
    }
    try {
      var snap = await firebridge.db().collection(COLL).orderBy('updatedAt', 'desc').get();
      drafts = snap.docs.map(function (d) { return Object.assign({ id: d.id }, d.data()); });
    } catch (e) {
      // Fallback if updatedAt index isn't ready.
      var snap2 = await firebridge.db().collection(COLL).get();
      drafts = snap2.docs.map(function (d) { return Object.assign({ id: d.id }, d.data()); });
    }
    render();
  }

  function render() {
    listEl.innerHTML = '';
    if (!drafts.length) {
      listEl.innerHTML = '<div class="empty-state">No grant drafts yet. Click "+ New grant" to start.</div>';
      return;
    }
    drafts.forEach(function (g) { listEl.appendChild(renderCard(g)); });
  }

  function renderCard(g) {
    var card = document.createElement('a');
    card.className = 'pb-card';
    card.href = '/rm/pages/grant-builder.html?grant=' + encodeURIComponent(g.id);

    var deadline = g.deadlineISO ? fmtDate(g.deadlineISO) : '';
    var daysLeft = '';
    if (g.deadlineISO) {
      var ms = Date.parse(g.deadlineISO);
      if (!isNaN(ms)) {
        var d = Math.ceil((ms - Date.now()) / 86400000);
        if (d >= 0) daysLeft = d + ' day' + (d === 1 ? '' : 's') + ' left';
        else daysLeft = 'past due';
      }
    }

    card.innerHTML = ''
      + '<div class="pb-card-row">'
      +   '<div class="pb-card-title">' + esc(g.title || '(untitled)') + '</div>'
      +   statusChipHtml(g.status)
      + '</div>'
      + '<div class="pb-card-meta">'
      +   (g.agency ? '<span>' + esc(g.agency) + '</span>' : '<span>—</span>')
      +   (g.mechanism ? ' · <span>' + esc(g.mechanism) + '</span>' : '')
      +   (deadline ? ' · <span title="Deadline">📅 ' + esc(deadline) + '</span>' : '')
      +   (daysLeft ? ' · <span class="pb-template-tag">' + esc(daysLeft) + '</span>' : '')
      + '</div>'
      + (g.tree && g.tree.meta && g.tree.meta.templateId
          ? '<div class="pb-card-repo">' + esc(g.tree.meta.templateId) + '</div>'
          : '');
    return card;
  }

  function populateTemplateSelect() {
    var tpls = window.GrantSchemas.GRANT_TEMPLATES;
    templateSel.innerHTML = '';
    Object.keys(tpls).forEach(function (k) {
      var opt = document.createElement('option');
      opt.value = k;
      opt.textContent = tpls[k].name;
      templateSel.appendChild(opt);
    });
    templateSel.value = 'nih-r01';
    updateTemplateHint();
  }

  function updateTemplateHint() {
    var t = window.GrantSchemas.GRANT_TEMPLATES[templateSel.value];
    templateHint.textContent = t ? t.description : '';
    if (t) {
      if (t.mechanism && !mechInput.value) mechInput.value = t.mechanism;
      if (t.agency && !agencyInput.value) agencyInput.value = t.agency;
    }
  }

  function openModal() {
    modalEl.hidden = false;
    titleInput.value = '';
    mechInput.value = '';
    agencyInput.value = '';
    deadlineInput.value = '';
    modalError.hidden = true;
    modalError.textContent = '';
    populateTemplateSelect();
    setTimeout(function () { titleInput.focus(); }, 50);
  }

  function closeModal() { modalEl.hidden = true; }

  async function createGrant() {
    var title = titleInput.value.trim();
    var templateId = templateSel.value;
    var mechanism = mechInput.value.trim();
    var agency = agencyInput.value.trim();
    var deadlineISO = deadlineInput.value || '';

    modalError.hidden = true;
    modalError.textContent = '';
    if (!title) {
      modalError.textContent = 'Title is required.';
      modalError.hidden = false;
      return;
    }

    var user = firebridge.getUser();
    if (!user) {
      modalError.textContent = 'Sign in to create a grant draft.';
      modalError.hidden = false;
      return;
    }

    var profile = firebridge.getProfile();
    var tpl = window.GrantSchemas.GRANT_TEMPLATES[templateId] || window.GrantSchemas.GRANT_TEMPLATES.blank;
    var tree = window.GrantSchemas.newTree(templateId, title);
    var stamp = firebase.firestore.FieldValue.serverTimestamp();

    var doc = {
      title: title,
      status: 'draft',
      mechanism: mechanism || tpl.mechanism || '',
      agency: agency || tpl.agency || '',
      programOfficer: '',
      pi: { uid: user.uid, name: (profile && profile.name) || user.email },
      coIs: [],
      collaborators: [],
      deadlineISO: deadlineISO,
      submittedAt: null,
      awardedAt: null,
      fundingId: null,           // populated on submission
      opportunityId: null,       // populated when started from a portal NOFO
      budgetSummary: { directs: 0, indirects: 0, total: 0, years: [] },
      attachments: { biosketchVariantIds: [], facilitiesDocIds: [] },
      tree: tree,
      createdBy: user.uid,
      createdAt: stamp,
      updatedAt: stamp,
    };

    modalCreate.disabled = true;
    modalCreate.textContent = 'Creating…';
    try {
      var ref = await firebridge.db().collection('grantDrafts').add(doc);
      window.location.href = '/rm/pages/grant-builder.html?grant=' + encodeURIComponent(ref.id);
    } catch (err) {
      modalError.textContent = 'Failed to create: ' + (err && err.message ? err.message : String(err));
      modalError.hidden = false;
      modalCreate.disabled = false;
      modalCreate.textContent = 'Create';
    }
  }

  /* V3.470 — new grants are authored in the unified Paper editor now.
   * Hand off to its creation modal with the grant type preselected;
   * old grantDrafts still open in this page's editor mode. (The legacy
   * openModal/createGrant flow below is left intact but unwired as a
   * fallback.) */
  newBtn.addEventListener('click', function () {
    window.location.href = '/rm/pages/paper-builder.html?new=1&type=grant';
  });
  modalClose.addEventListener('click', closeModal);
  modalCancel.addEventListener('click', closeModal);
  modalCreate.addEventListener('click', createGrant);
  modalEl.addEventListener('click', function (e) { if (e.target === modalEl) closeModal(); });
  templateSel.addEventListener('change', updateTemplateHint);
  document.addEventListener('keydown', function (e) {
    if (e.key === 'Escape' && !modalEl.hidden) closeModal();
  });

  if (firebridge.requireSignIn) firebridge.requireSignIn('Sign in to manage grant drafts.');
  firebridge.onAuth(function (user) {
    if (!user) {
      listEl.innerHTML = '<div class="empty-state">Sign in to see grant drafts.</div>';
      return;
    }
    load().then(function () {
      // V3.229 — deep-link with ?new=1 (e.g. research view "+ Add Item"
      // type=grant) expected the create modal immediately.
      // V3.470 — new grants are authored in the unified Paper editor now,
      // so hand the deep-link off there with the grant type preselected.
      try {
        var params = new URLSearchParams(window.location.search);
        if (params.get('new') === '1') {
          window.location.href = '/rm/pages/paper-builder.html?new=1&type=grant';
        }
      } catch {}
    });
  });
})();
