/* paper-builder.js — list of lab papers + "new paper" creation flow.
 *
 * Reads `data/projects/papers.json` for paper metadata. Phase A: each paper
 * card links into `paper-editor.html?id=…`. The editor stores the document
 * tree in Firestore at `papers/{paperId}/draft`; this list page does NOT touch
 * Firestore — it's safe to view papers when offline or signed out.
 *
 * Creating a new paper writes a row to papers.json via the existing
 * /api/data PUT endpoint. The Firestore draft doc is materialized by the
 * editor on first save (we don't pre-create empty docs because that requires
 * Firestore admin auth and the user creating the paper might not be one yet).
 */

(function () {
  var statusEl   = document.getElementById('pb-status');
  var listEl     = document.getElementById('pb-list');
  var newBtn     = document.getElementById('pb-new-paper-btn');
  var modalEl    = document.getElementById('pb-modal');
  var modalClose = document.getElementById('pb-modal-close');
  var modalCancel= document.getElementById('pb-modal-cancel');
  var modalCreate= document.getElementById('pb-modal-create');
  var modalError = document.getElementById('pb-modal-error');
  var titleInput = document.getElementById('pb-new-title');
  var idInput    = document.getElementById('pb-new-id');
  var templateSel= document.getElementById('pb-new-template');
  var templateHint = document.getElementById('pb-new-template-hint');
  var journalInput = document.getElementById('pb-new-journal');
  var repoInput  = document.getElementById('pb-new-repo');

  var papers = [];

  function setStatus(msg, kind) {
    statusEl.textContent = msg || '';
    statusEl.className = 'pb-status' + (kind ? ' pb-status-' + kind : '');
  }

  /* ── Load & render ── */

  async function load() {
    try {
      var data = await api.load('projects/papers.json');
      papers = (data && data.papers) || [];
      render();
    } catch (err) {
      listEl.innerHTML = '<div class="empty-state">Failed to load papers: ' + err.message + '</div>';
    }
  }

  function render() {
    listEl.innerHTML = '';
    if (!papers.length) {
      listEl.innerHTML = '<div class="empty-state">No papers yet. Click "New paper" to start.</div>';
      return;
    }
    papers.forEach(function (p) {
      listEl.appendChild(renderCard(p));
    });
  }

  function renderCard(p) {
    var card = document.createElement('a');
    card.className = 'pb-card';
    card.href = '/rm/pages/paper-editor.html?id=' + encodeURIComponent(p.id);

    var coauthorCount = (p.coauthor_uids || []).length + (p.coauthor_emails || []).length;
    var statusHTML = typeof statusChip === 'function' ? statusChip(p.status) : '<span class="chip">' + (p.status || '') + '</span>';

    card.innerHTML =
      '<div class="pb-card-row">' +
        '<div class="pb-card-title">' + escapeHtml(p.title || '(untitled)') + '</div>' +
        statusHTML +
      '</div>' +
      '<div class="pb-card-meta">' +
        '<span>' + escapeHtml(p.lead_author || 'Unknown lead') + '</span>' +
        (p.target_journal ? ' · <span>' + escapeHtml(p.target_journal) + '</span>' : '') +
        (coauthorCount ? ' · <span>' + coauthorCount + ' coauthor' + (coauthorCount === 1 ? '' : 's') + '</span>' : '') +
        (p.template_id ? ' · <span class="pb-template-tag">' + escapeHtml(p.template_id) + '</span>' : '') +
      '</div>' +
      (p.repo_path ? '<div class="pb-card-repo">' + escapeHtml(p.repo_path) + '</div>' : '');
    return card;
  }

  function escapeHtml(s) {
    return String(s || '').replace(/[&<>"']/g, function (c) {
      return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c];
    });
  }

  /* ── New-paper modal ── */

  function populateTemplateSelect() {
    var tpls = window.PaperSchemas.PAPER_TEMPLATES;
    templateSel.innerHTML = '';
    Object.keys(tpls).forEach(function (k) {
      var opt = document.createElement('option');
      opt.value = k;
      opt.textContent = tpls[k].name;
      templateSel.appendChild(opt);
    });
    templateSel.value = 'mebp-journal';
    updateTemplateHint();
  }

  function updateTemplateHint() {
    var t = window.PaperSchemas.PAPER_TEMPLATES[templateSel.value];
    templateHint.textContent = t ? t.description : '';
  }

  function openModal() {
    modalEl.hidden = false;
    titleInput.value = '';
    idInput.value = '';
    journalInput.value = '';
    repoInput.value = '';
    modalError.hidden = true;
    modalError.textContent = '';
    populateTemplateSelect();
    setTimeout(function () { titleInput.focus(); }, 50);
  }

  function closeModal() {
    modalEl.hidden = true;
  }

  function suggestSlug() {
    if (!idInput.value.trim() && titleInput.value.trim()) {
      idInput.value = slugify(titleInput.value);
    }
  }

  async function createPaper() {
    var title = titleInput.value.trim();
    var id = (idInput.value.trim() || (title && slugify(title)) || '').toLowerCase();
    var template_id = templateSel.value;
    var target_journal = journalInput.value.trim() || 'TBD';
    var repo_path = repoInput.value.trim() || '';

    modalError.hidden = true;
    modalError.textContent = '';

    if (!title) {
      modalError.textContent = 'Title is required.';
      modalError.hidden = false;
      return;
    }
    if (!/^[a-z0-9][a-z0-9-]*$/.test(id)) {
      modalError.textContent = 'Slug must be kebab-case (lowercase, digits, hyphens).';
      modalError.hidden = false;
      return;
    }
    if (papers.some(function (p) { return p.id === id; })) {
      modalError.textContent = 'A paper with that slug already exists.';
      modalError.hidden = false;
      return;
    }

    var user = (typeof firebridge !== 'undefined') ? firebridge.getUser() : null;
    var profile = (typeof firebridge !== 'undefined') ? firebridge.getProfile() : null;

    var newRow = {
      id: id,
      title: title,
      target_journal: target_journal,
      status: 'drafting',
      lead_author: (profile && profile.name) || (user && user.email) || 'Unknown',
      lead_author_uid: user ? user.uid : '',
      lead_author_email: user ? (user.email || '') : '',
      coauthor_uids: [],
      coauthor_emails: [],
      template_id: template_id,
      repo_path: repo_path,
      repo_org: '',
      notes: '',
    };

    modalCreate.disabled = true;
    modalCreate.textContent = 'Creating…';
    try {
      var data = await api.load('projects/papers.json');
      var arr = (data && data.papers) || [];
      arr.push(newRow);
      await api.save('projects/papers.json', { papers: arr });
      // Navigate straight into the editor.
      window.location.href = '/rm/pages/paper-editor.html?id=' + encodeURIComponent(id);
    } catch (err) {
      modalError.textContent = 'Failed to create: ' + err.message;
      modalError.hidden = false;
      modalCreate.disabled = false;
      modalCreate.textContent = 'Create';
    }
  }

  /* ── Wire ── */

  newBtn.addEventListener('click', openModal);
  modalClose.addEventListener('click', closeModal);
  modalCancel.addEventListener('click', closeModal);
  modalCreate.addEventListener('click', createPaper);
  modalEl.addEventListener('click', function (e) {
    if (e.target === modalEl) closeModal();
  });
  titleInput.addEventListener('blur', suggestSlug);
  templateSel.addEventListener('change', updateTemplateHint);
  document.addEventListener('keydown', function (e) {
    if (e.key === 'Escape' && !modalEl.hidden) closeModal();
  });

  load();
})();
