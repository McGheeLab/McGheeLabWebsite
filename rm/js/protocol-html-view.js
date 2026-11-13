/* protocol-html-view.js — V3.987: an HTML protocol in RM.
 *
 * Mode `html` of pages/protocols.html (`?protocol=<id>&view=html`). The
 * protocol is a web page a lab member uploaded (protocol-html.js): it is
 * drawn in a sandboxed frame that fills the page, so its own scrolling,
 * anchors and fixed controls behave as its author made them.
 *
 * Every lab member can read it, download it and print it. Its owner (or an
 * admin) also gets: Details (title, summary, tags, status — what the
 * website lists it by), Replace file (a new revision; earlier files stay
 * downloadable), and Post to website (protocol-publish.js, the same dialog
 * as a block protocol, contributors and all).
 */
(function () {
  var protocolId = window.__PROTOCOL_ID;
  if (window.__PROTOCOL_MODE !== 'html' || !protocolId) return;

  var H = window.ProtocolHtml;
  function $(id) { return document.getElementById(id); }
  function esc(s) {
    return String(s == null ? '' : s).replace(/[&<>"']/g, function (c) {
      return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c];
    });
  }

  var els = {
    title: $('prh-title'), byline: $('prh-byline'), status: $('prh-status'), wrap: $('prh-frame-wrap'),
    detailsBtn: $('prh-details-btn'), details: $('prh-details'), replaceBtn: $('prh-replace-btn'),
    replaceInput: $('prh-replace-input'), downloadBtn: $('prh-download-btn'), printBtn: $('prh-print-btn'),
    publishBtn: $('prh-publish-btn'), inTitle: $('prh-in-title'), inSummary: $('prh-in-summary'),
    inTags: $('prh-in-tags'), inStatus: $('prh-in-status'), revisions: $('prh-revisions'),
    saveState: $('prh-savestate'),
  };

  var state = { doc: null, html: '', frame: null, canEdit: false, saveTimer: null, publishUI: null, roster: null };

  function setStatus(text) {
    els.status.textContent = text || '';
    els.status.hidden = !text;
  }
  function setSave(text, kind) {
    els.saveState.textContent = text || '';
    els.saveState.className = 'prh-savestate' + (kind ? ' prh-savestate-' + kind : '');
  }
  function day(iso) { return iso ? String(iso).slice(0, 10) : ''; }

  function renderHeader() {
    var d = state.doc;
    els.title.textContent = d.title || '(untitled protocol)';
    var f = d.html_file || {};
    var bits = [];
    if (d.author_name) bits.push('by ' + esc(d.author_name));
    bits.push('HTML file' + (f.size ? ' · ' + esc(H.fmtSize(f.size)) : ''));
    if (f.rev > 1) bits.push('version ' + f.rev);
    if (f.uploaded_at) bits.push('uploaded ' + esc(day(f.uploaded_at)) + (f.uploaded_by_name ? ' by ' + esc(f.uploaded_by_name) : ''));
    els.byline.innerHTML = bits.join(' · ');
    document.title = (d.title || 'Protocol') + ' — McGhee Lab';
  }

  function renderRevisions() {
    var revs = state.doc.html_revisions || [];
    if (!revs.length) { els.revisions.innerHTML = ''; return; }
    els.revisions.innerHTML = '<span class="prh-rev-label">Earlier files:</span> ' + revs.map(function (r) {
      return '<button type="button" class="prh-rev" data-rev="' + esc(r.rev) + '" title="Download this file">' +
        'v' + esc(r.rev) + ' · ' + esc(day(r.uploaded_at)) + (r.uploaded_by_name ? ' · ' + esc(r.uploaded_by_name) : '') +
        '</button>';
    }).join(' ');
  }

  function showFile(html) {
    state.html = html;
    setStatus('');
    state.frame = H.mountFrame(els.wrap, html, { title: state.doc.title, className: 'prh-frame' });
    els.downloadBtn.disabled = false;
    els.printBtn.disabled = false;
  }

  /* ── Details (owner) ─────────────────────────────────────────────── */

  function fillDetails() {
    var d = state.doc;
    els.inTitle.value = d.title || '';
    els.inSummary.value = d.summary || '';
    els.inTags.value = (d.tags || []).join(', ');
    els.inStatus.value = d.status || 'draft';
    renderRevisions();
  }

  function scheduleSave() {
    if (state.saveTimer) clearTimeout(state.saveTimer);
    setSave('editing…');
    state.saveTimer = setTimeout(saveDetails, 600);
  }

  async function saveDetails() {
    state.saveTimer = null;
    if (!state.canEdit) return;
    var update = {
      title: els.inTitle.value.trim() || state.doc.title || '',
      summary: els.inSummary.value.trim(),
      tags: els.inTags.value.split(',').map(function (s) { return s.trim(); }).filter(Boolean),
      updated_at: new Date().toISOString(),
    };
    try {
      setSave('saving…');
      await firebridge.db().collection('protocols').doc(protocolId).update(update);
      Object.assign(state.doc, update);
      renderHeader();
      if (state.publishUI) state.publishUI.refresh();
      setSave('saved');
      setTimeout(function () { if (els.saveState.textContent === 'saved') setSave(''); }, 1500);
    } catch (err) {
      console.warn('[protocol-html-view] save failed:', err);
      setSave('save failed', 'error');
    }
  }

  /* ── Replace the file (owner) ────────────────────────────────────── */

  async function replaceWith(file) {
    if (!file || !state.canEdit) return;
    var html = await file.text();
    var size = H.byteSize(html);
    if (size > H.MAX_BYTES) {
      window.alert('That file is ' + H.fmtSize(size) + '; the limit is ' + H.fmtSize(H.MAX_BYTES) + '. Shrink the pictures inside it.');
      return;
    }
    var warns = H.warnings(html);
    var posted = state.doc.status === 'published';
    var msg = 'Replace the file of “' + (state.doc.title || protocolId) + '” with ' + file.name + '?\n\n' +
      'The current file stays in Earlier files and can still be downloaded.' +
      (posted ? '\nThe website keeps showing the posted copy until you press Update website.' : '') +
      (warns.length ? '\n\nNote:\n• ' + warns.join('\n• ') : '');
    if (!window.confirm(msg)) return;
    els.replaceBtn.disabled = true;
    setStatus('Uploading ' + file.name + '…');
    try {
      var user = firebridge.getUser();
      var profile = firebridge.getProfile ? firebridge.getProfile() : null;
      var update = await H.replaceFile(firebridge.db(), protocolId, state.doc, html, {
        name: file.name, uid: user && user.uid,
        userName: (profile && profile.name) || (user && (user.displayName || user.email)) || '',
      });
      Object.assign(state.doc, update);
      renderHeader();
      renderRevisions();
      showFile(html);
      if (state.publishUI) state.publishUI.refresh();
      if (typeof toast === 'function') toast('File replaced' + (posted ? ' — press Update website to post it' : ''));
    } catch (err) {
      console.error('[protocol-html-view] replace failed:', err);
      setStatus('');
      window.alert('The file could not be replaced: ' + (err.message || err));
    } finally {
      els.replaceBtn.disabled = false;
      els.replaceInput.value = '';
    }
  }

  async function downloadRevision(rev) {
    var r = (state.doc.html_revisions || []).filter(function (x) { return String(x.rev) === String(rev); })[0];
    if (!r) return;
    try {
      var html = await H.readRevision(firebridge.db(), protocolId, r);
      H.download(html, H.fileName(state.doc.title, protocolId).replace(/\.html$/, ' (v' + r.rev + ').html'));
    } catch (err) {
      window.alert('That file could not be read: ' + (err.message || err));
    }
  }

  /* ── The lab roster, for the contributors list ───────────────────── */

  async function loadRoster() {
    if (state.roster) return state.roster;
    var data = await api.load('lab/users.json');
    state.roster = ((data && data.users) || [])
      .filter(function (u) { return u && u.uid && LAB_USERS.isVisible(u); });
    return state.roster;
  }

  /* ── Boot ────────────────────────────────────────────────────────── */

  async function boot() {
    var gate = await firebridge.requireSignIn('Sign in to view this protocol.');
    if (!gate.allowed) { setStatus(''); return; }
    if (!firebridge.isLabMember()) { setStatus(''); return; }

    var db = firebridge.db();
    var snap;
    try { snap = await db.collection('protocols').doc(protocolId).get(); }
    catch (err) { setStatus('Failed to load protocol: ' + (err.message || err)); return; }
    if (!snap.exists) { setStatus('Protocol not found: ' + protocolId); return; }
    state.doc = window.ProtocolSchemas.protocolHydrate(snap.data());
    if (state.doc.kind !== 'html') {
      // a block protocol opened with view=html: send it to its editor
      location.replace('/rm/pages/protocols.html?protocol=' + encodeURIComponent(protocolId));
      return;
    }
    var user = firebridge.getUser();
    state.canEdit = state.doc.ownerUid === user.uid || (firebridge.isAdmin && firebridge.isAdmin());

    renderHeader();
    if (state.canEdit) {
      els.detailsBtn.hidden = false;
      els.replaceBtn.hidden = false;
      fillDetails();
      // a protocol that has never been posted opens with its details showing,
      // so the summary and tags the website will list are in front of you
      if (state.doc.status !== 'published' && (!state.doc.summary || !(state.doc.tags || []).length)) {
        els.details.hidden = false;
        els.detailsBtn.classList.add('prh-on');
      }
    }

    els.detailsBtn.addEventListener('click', function () {
      els.details.hidden = !els.details.hidden;
      els.detailsBtn.classList.toggle('prh-on', !els.details.hidden);
    });
    [els.inTitle, els.inSummary, els.inTags].forEach(function (el) { el.addEventListener('input', scheduleSave); });
    els.inStatus.addEventListener('change', function () {
      if (state.publishUI && state.publishUI.interceptStatus(els.inStatus.value)) return;
      var next = els.inStatus.value;
      firebridge.db().collection('protocols').doc(protocolId)
        .update({ status: next, updated_at: new Date().toISOString() })
        .then(function () { state.doc.status = next; })
        .catch(function (err) { setSave('save failed', 'error'); console.warn(err); });
    });
    els.revisions.addEventListener('click', function (e) {
      var b = e.target.closest('[data-rev]');
      if (b) downloadRevision(b.getAttribute('data-rev'));
    });
    els.replaceBtn.addEventListener('click', function () { els.replaceInput.click(); });
    els.replaceInput.addEventListener('change', function () { replaceWith(els.replaceInput.files[0]); });
    els.downloadBtn.addEventListener('click', function () {
      if (state.html) H.download(state.html, (state.doc.html_file && state.doc.html_file.name) || H.fileName(state.doc.title, protocolId));
    });
    els.printBtn.addEventListener('click', function () { H.print(state.frame); });
    // Ctrl/Cmd+P on the RM page prints the protocol, not RM around it (the
    // frame handles the same keys when the reader has clicked inside it).
    window.addEventListener('keydown', function (e) {
      if ((e.metaKey || e.ctrlKey) && !e.altKey && String(e.key).toLowerCase() === 'p' && state.frame) {
        e.preventDefault();
        H.print(state.frame);
      }
    });

    if (window.PROTOCOL_PUBLISH) {
      state.publishUI = window.PROTOCOL_PUBLISH.attachEditor({
        protocolId: protocolId,
        button: els.publishBtn,
        statusSelect: els.inStatus,
        getDoc: function () { return state.doc; },
        canEdit: function () { return state.canEdit; },
        getTree: async function () { return state.doc.tree; },
        getHtml: async function () {
          if (state.saveTimer) { clearTimeout(state.saveTimer); await saveDetails(); }
          return state.html;
        },
        loadRoster: loadRoster,
        onChanged: function (update) { Object.assign(state.doc, update); },
      });
    }

    setStatus('Loading the file…');
    try {
      showFile(await H.readRevision(db, protocolId, state.doc.html_file));
    } catch (err) {
      console.error('[protocol-html-view] file load failed:', err);
      setStatus('The file could not be loaded: ' + (err.message || err));
    }
  }

  boot().catch(function (err) {
    console.error('[protocol-html-view] boot failed:', err);
    setStatus('Error: ' + (err && err.message || err));
  });
})();
