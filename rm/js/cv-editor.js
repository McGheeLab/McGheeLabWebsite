/* cv-editor.js — edit your own cvData/{uid} document.
 *
 * This is the RM-side editor that shares the Firestore cvData contract with
 * the McGheeLabWebsite cv-builder app. Either side can create, edit, or
 * delete entries — the document is the single source of truth. Entries are
 * keyed by `_id` (7-char random string) so updates/deletes work regardless
 * of which UI wrote the row.
 *
 * Public surface (window.CVEditor) is consumed by year-review.js when it
 * sends an item to the CV: CVEditor.appendEntry(section, entry).
 */

(function () {
  var root = document.getElementById('cve-root');
  var statusEl = document.getElementById('cve-status');
  var whoEl = document.getElementById('cve-who');
  var modal = document.getElementById('cve-modal');
  var modalTitle = document.getElementById('cve-modal-title');
  var modalBody = document.getElementById('cve-modal-body');

  var state = {
    uid: null,
    doc: null,              // full cvData document
    section: 'journals',    // currently selected section
    editing: null,          // entry being edited (null when adding)
  };

  /* ── auth gate ── */

  function showNotConnected() {
    root.innerHTML =
      '<div class="cve-gated">' +
        '<p><strong>Not connected to the website.</strong></p>' +
        '<p style="margin-top:8px">Sign in from <a href="/rm/pages/settings.html">Settings</a> to edit your CV.</p>' +
      '</div>';
  }

  function setStatus(msg, kind) {
    statusEl.textContent = msg || '';
    statusEl.className = 'cve-status' + (kind ? ' ' + kind : '');
    if (msg) setTimeout(function () {
      if (statusEl.textContent === msg) { statusEl.textContent = ''; statusEl.className = 'cve-status'; }
    }, 3000);
  }

  /* ── load / save ── */

  async function loadDoc() {
    var user = firebridge.getUser();
    if (!user) { showNotConnected(); return; }
    state.uid = user.uid;
    var profile = firebridge.getProfile();
    whoEl.textContent = (profile && profile.name) ? profile.name : user.email;
    try {
      var doc = await firebridge.getDoc('cvData', state.uid);
      state.doc = doc || makeEmptyDoc();
      // Ensure all sections exist as arrays
      CV_SECTION_KEYS.forEach(function (k) { if (!Array.isArray(state.doc[k])) state.doc[k] = []; });
      render();
    } catch (err) {
      root.innerHTML = '<div class="cve-gated" style="background:#fee2e2;border-color:#fecaca;color:#991b1b">Failed to load CV: ' + err.message + '</div>';
    }
  }

  function makeEmptyDoc() {
    var d = { profile: {} };
    CV_SECTION_KEYS.forEach(function (k) { d[k] = []; });
    return d;
  }

  async function saveSection(sectionKey) {
    var payload = {};
    payload[sectionKey] = state.doc[sectionKey];
    try {
      await firebridge.setDoc('cvData', state.uid, payload, true);
      setStatus('Saved.', 'ok');
    } catch (err) {
      setStatus('Save failed: ' + err.message, 'err');
      throw err;
    }
  }

  /* ── render ── */

  function render() {
    root.innerHTML = '';
    root.appendChild(renderToolbar());
    var wrap = document.createElement('div');
    wrap.className = 'cve-layout';
    wrap.appendChild(renderSidebar());
    wrap.appendChild(renderSection());
    root.appendChild(wrap);
  }

  /* Toolbar — ORCID sync, BibTeX import, Citations refresh, Export. */
  function renderToolbar() {
    var bar = document.createElement('div');
    bar.style.cssText = 'display:flex;gap:8px;flex-wrap:wrap;padding:10px 12px;margin-bottom:14px;background:#f9fafb;border:1px solid #e5e7eb;border-radius:10px';
    function mkBtn(label, onClick, color) {
      var b = document.createElement('button');
      b.className = 'btn';
      b.textContent = label;
      if (color) { b.style.borderColor = color; b.style.color = color; }
      b.addEventListener('click', onClick);
      return b;
    }
    bar.appendChild(mkBtn('⊕ ORCID sync',     openORCIDDialog,  '#059669'));
    bar.appendChild(mkBtn('⇓ Import BibTeX',   openBibTeXDialog, '#2563eb'));
    bar.appendChild(mkBtn('↻ Refresh citations', runCitationRefresh, '#7c3aed'));
    var sep = document.createElement('span');
    sep.style.cssText = 'flex:1';
    bar.appendChild(sep);
    bar.appendChild(mkBtn('⇩ Markdown',      function () { CVExport.downloadMarkdown(state.doc, exportBaseName()); }));
    bar.appendChild(mkBtn('⇩ HTML',          function () { CVExport.downloadHTML(state.doc, exportBaseName()); }));
    bar.appendChild(mkBtn('🖨 Print / PDF',   function () { CVExport.openPrintPreview(state.doc); }));
    return bar;
  }

  function exportBaseName() {
    var name = (state.doc.profile && state.doc.profile.name) || 'cv';
    return 'cv-' + String(name).toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '');
  }

  function renderSidebar() {
    var side = document.createElement('div');
    side.className = 'cve-side';
    CV_SECTION_GROUPS.forEach(function (grp) {
      var hdr = document.createElement('div');
      hdr.className = 'cve-side-group';
      hdr.textContent = grp.label;
      side.appendChild(hdr);
      grp.keys.forEach(function (k) {
        var btn = document.createElement('button');
        var count = k === 'profile' ? '' : (state.doc[k] || []).length;
        btn.innerHTML = CV_SECTION_LABELS_EXT[k] + (count === '' ? '' : '<span class="cve-side-count">' + count + '</span>');
        if (k === state.section) btn.classList.add('active');
        btn.addEventListener('click', function () { state.section = k; render(); });
        side.appendChild(btn);
      });
    });
    return side;
  }

  function renderSection() {
    var main = document.createElement('div');
    main.className = 'cve-main';
    var head = document.createElement('div');
    head.className = 'cve-section-head';
    head.innerHTML = '<h2>' + CV_SECTION_LABELS_EXT[state.section] + '</h2>';
    if (state.section !== 'profile') {
      var addBtn = document.createElement('button');
      addBtn.className = 'btn btn-primary';
      addBtn.textContent = '+ Add entry';
      addBtn.addEventListener('click', function () { openModal(state.section, null); });
      head.appendChild(addBtn);
    }
    main.appendChild(head);

    if (state.section === 'profile') {
      main.appendChild(renderProfileEditor());
      return main;
    }

    var entries = state.doc[state.section] || [];
    if (!entries.length) {
      var empty = document.createElement('div');
      empty.className = 'cve-empty';
      empty.textContent = 'No entries yet. Click "Add entry" to create one.';
      main.appendChild(empty);
      return main;
    }
    // Sort newest first by the section's year field (if any).
    var yearKey = (CV_DISPLAY[state.section] || {}).year;
    var sorted = entries.slice();
    if (yearKey) sorted.sort(function (a, b) { return String(b[yearKey] || '').localeCompare(String(a[yearKey] || '')); });
    sorted.forEach(function (entry) { main.appendChild(renderEntry(entry)); });
    return main;
  }

  function renderEntry(entry) {
    var disp = CV_DISPLAY[state.section] || { title: 'title', meta: [], year: null };
    var card = document.createElement('div');
    card.className = 'cve-entry';
    card.addEventListener('click', function (ev) {
      if (ev.target.closest('.del')) return;
      openModal(state.section, entry);
    });
    var actions = document.createElement('div');
    actions.className = 'actions';
    var yearVal = disp.year ? String(entry[disp.year] || '').slice(0, 4) : '';
    if (yearVal) {
      var y = document.createElement('span');
      y.className = 'y';
      y.textContent = yearVal;
      actions.appendChild(y);
    }
    var del = document.createElement('span');
    del.className = 'del';
    del.textContent = 'delete';
    del.addEventListener('click', async function (ev) {
      ev.stopPropagation();
      if (!confirm('Delete this entry?')) return;
      state.doc[state.section] = state.doc[state.section].filter(function (e) { return e._id !== entry._id; });
      await saveSection(state.section);
      render();
    });
    actions.appendChild(del);
    card.appendChild(actions);

    var title = document.createElement('div');
    title.className = 't';
    title.textContent = cvCleanText(entry[disp.title]) || '(untitled)';
    card.appendChild(title);
    var metaParts = disp.meta.map(function (k) { return cvCleanText(entry[k]); }).filter(Boolean);
    if (metaParts.length) {
      var meta = document.createElement('div');
      meta.className = 'm';
      meta.textContent = metaParts.join(' · ');
      card.appendChild(meta);
    }
    return card;
  }

  /* ── modal form ── */

  function openModal(sectionKey, entry) {
    state.section = sectionKey;
    state.editing = entry;
    var schema = CV_SCHEMAS[sectionKey];
    if (!schema) return;
    modalTitle.textContent = (entry ? 'Edit ' : 'Add ') + CV_SECTION_LABELS[sectionKey];
    modalBody.innerHTML = '';
    var form = document.createElement('div');
    form.className = 'cve-form';
    schema.fields.forEach(function (f) {
      var label = document.createElement('label');
      if (f.span === 2) label.className = 'span-2';
      var labelText = f.label + (f.required ? ' <span class="req">*</span>' : '');
      var input = buildInput(f, entry ? entry[f.key] : undefined);
      label.innerHTML = '<span>' + labelText + '</span>';
      label.appendChild(input);
      if (f.hint) {
        var h = document.createElement('div');
        h.className = 'hint';
        h.textContent = f.hint;
        label.appendChild(h);
      }
      form.appendChild(label);
    });
    modalBody.appendChild(form);
    attachDOIFetch(modalBody, sectionKey);
    if (window.__cveModalGuard) window.__cveModalGuard.reset();
    modal.classList.add('open');
  }

  function buildInput(field, value) {
    var el;
    // Clean HTML/LaTeX/Markdown artifacts from text-ish fields on form open,
    // so the user sees a clean value and saving an untouched entry scrubs
    // legacy markup in-place. Numbers/dates/checkboxes are passed through.
    var cleanValue = (field.type === 'number' || field.type === 'date' || field.type === 'checkbox')
      ? value : (value == null ? '' : cvCleanText(value));
    if (field.type === 'textarea') {
      el = document.createElement('textarea');
      el.value = cleanValue || '';
    } else if (field.type === 'select') {
      el = document.createElement('select');
      (field.options || []).forEach(function (opt) {
        var o = document.createElement('option');
        o.value = opt;
        o.textContent = opt || '(none)';
        if ((cleanValue || '') === opt) o.selected = true;
        el.appendChild(o);
      });
    } else if (field.type === 'checkbox') {
      el = document.createElement('input');
      el.type = 'checkbox';
      el.checked = !!cleanValue;
      el.style.width = 'auto';
    } else {
      el = document.createElement('input');
      el.type = field.type === 'number' ? 'number' : (field.type === 'date' ? 'date' : 'text');
      if (cleanValue !== undefined && cleanValue !== null && cleanValue !== '') el.value = cleanValue;
    }
    el.dataset.fieldKey = field.key;
    el.dataset.fieldType = field.type;
    return el;
  }

  function readForm() {
    var out = {};
    modalBody.querySelectorAll('[data-field-key]').forEach(function (el) {
      var key = el.dataset.fieldKey;
      var type = el.dataset.fieldType;
      if (type === 'checkbox') out[key] = !!el.checked;
      else if (type === 'number') out[key] = el.value === '' ? '' : Number(el.value);
      else out[key] = el.value;
    });
    return out;
  }

  function validateForm(sectionKey, values) {
    var schema = CV_SCHEMAS[sectionKey];
    for (var i = 0; i < schema.fields.length; i++) {
      var f = schema.fields[i];
      if (f.required && (values[f.key] === '' || values[f.key] === null || values[f.key] === undefined)) {
        return f.label + ' is required.';
      }
    }
    return null;
  }

  document.getElementById('cve-cancel').addEventListener('click', function () {
    modal.classList.remove('open');
    state.editing = null;
    if (window.__cveModalGuard) window.__cveModalGuard.reset();
  });

  document.getElementById('cve-save').addEventListener('click', async function () {
    var sectionKey = state.section;
    var values = readForm();
    var err = validateForm(sectionKey, values);
    if (err) { alert(err); return; }
    var list = state.doc[sectionKey] = state.doc[sectionKey] || [];
    if (state.editing) {
      values._id = state.editing._id;
      var idx = list.findIndex(function (e) { return e._id === state.editing._id; });
      if (idx >= 0) list[idx] = values;
      else list.push(values);
    } else {
      values._id = cvUid();
      list.push(values);
    }
    try {
      await saveSection(sectionKey);
      modal.classList.remove('open');
      state.editing = null;
      render();
    } catch (e) { /* status set in saveSection */ }
  });

  /* Close modal on backdrop click — guarded so drag-selects and accidental
   * clicks don't wipe the draft. `modalBody` is re-rendered each time the
   * modal opens, so we scope the dirty tracker to the modal panel itself. */
  var modalGuard = safeCloseOnBackdrop(modal, modal.querySelector('.cve-modal'), function () {
    modal.classList.remove('open');
    state.editing = null;
  });
  /* The entry modal is persistent (one element re-opened many times). Reset
   * the dirty tracker whenever we open it or close it via Cancel/Save so
   * stale state doesn't trigger a false "Discard?" on the next open. */
  window.__cveModalGuard = modalGuard;

  /* ── profile editor ── */

  function renderProfileEditor() {
    var wrap = document.createElement('div');
    wrap.style.cssText = 'display:grid;grid-template-columns:1fr 1fr;gap:10px 12px';
    state.doc.profile = state.doc.profile || {};
    CV_PROFILE_FIELDS.forEach(function (f) {
      var label = document.createElement('label');
      label.style.cssText = 'display:flex;flex-direction:column;font-size:11px;color:#6b7280;text-transform:uppercase;letter-spacing:.4px;gap:3px';
      if (f.type === 'textarea') label.style.gridColumn = '1/-1';
      label.innerHTML = '<span>' + f.label + '</span>';
      var input;
      if (f.type === 'textarea') {
        input = document.createElement('textarea');
        input.style.cssText = 'min-height:70px;padding:6px 8px;border:1px solid #d1d5db;border-radius:6px;font-family:inherit;font-size:13px;color:#111827;text-transform:none;letter-spacing:normal;resize:vertical';
      } else {
        input = document.createElement('input');
        input.type = 'text';
        input.style.cssText = 'padding:6px 8px;border:1px solid #d1d5db;border-radius:6px;font-size:13px;text-transform:none;letter-spacing:normal';
      }
      input.value = state.doc.profile[f.key] || '';
      input.dataset.profileKey = f.key;
      label.appendChild(input);
      if (f.hint) {
        var h = document.createElement('div');
        h.style.cssText = 'font-size:10px;color:#9ca3af;text-transform:none;letter-spacing:0;margin-top:2px';
        h.textContent = f.hint;
        label.appendChild(h);
      }
      wrap.appendChild(label);
    });
    var btnRow = document.createElement('div');
    btnRow.style.cssText = 'grid-column:1/-1;display:flex;gap:8px;margin-top:8px';
    var saveBtn = document.createElement('button');
    saveBtn.className = 'btn btn-primary';
    saveBtn.textContent = 'Save profile';
    saveBtn.addEventListener('click', async function () {
      var profile = {};
      wrap.querySelectorAll('[data-profile-key]').forEach(function (el) {
        profile[el.dataset.profileKey] = el.value;
      });
      state.doc.profile = profile;
      try {
        await firebridge.setDoc('cvData', state.uid, { profile: profile }, true);
        setStatus('Profile saved.', 'ok');
      } catch (err) {
        setStatus('Save failed: ' + err.message, 'err');
      }
    });
    btnRow.appendChild(saveBtn);
    wrap.appendChild(btnRow);
    return wrap;
  }

  /* ── bulk dialogs ── */

  /* Reusable modal helper — returns a back element that can be removed. */
  function openDialog(title, bodyHTML) {
    var back = document.createElement('div');
    back.style.cssText = 'position:fixed;inset:0;background:rgba(0,0,0,.45);z-index:200;display:flex;align-items:flex-start;justify-content:center;padding:30px 12px;overflow-y:auto';
    var panel = document.createElement('div');
    panel.style.cssText = 'background:#fff;border-radius:10px;max-width:820px;width:100%;padding:18px 20px;box-shadow:0 20px 40px rgba(0,0,0,.25)';
    panel.innerHTML = '<h3 style="margin:0 0 12px 0;font-size:15px">' + title + '</h3>' + bodyHTML;
    back.appendChild(panel);
    document.body.appendChild(back);
    var handle = { back: back, panel: panel, close: function () { if (back.parentNode) document.body.removeChild(back); } };
    safeCloseOnBackdrop(back, panel, handle.close);
    return handle;
  }

  function openORCIDDialog() {
    if (!firebridge.isReady()) { alert('Not signed in.'); return; }
    var existingOrcid = (state.doc.profile && state.doc.profile.orcid) || '';
    var dlg = openDialog('ORCID Sync',
      '<p style="margin:0 0 10px 0;font-size:13px;color:#374151">Paste your ORCID iD and fetch your works. New items are appended to Journals or Conferences; duplicates are skipped.</p>' +
      '<div style="display:flex;gap:8px;margin-bottom:10px">' +
        '<input type="text" id="cve-orcid-id" placeholder="0000-0000-0000-0000" value="' + escAttr(existingOrcid) + '" style="flex:1;padding:6px 8px;border:1px solid #d1d5db;border-radius:6px;font-size:13px">' +
        '<button class="btn btn-primary" id="cve-orcid-fetch">Fetch works</button>' +
      '</div>' +
      '<div id="cve-orcid-status" style="font-size:12px;color:#6b7280;margin-bottom:8px"></div>' +
      '<div id="cve-orcid-results"></div>' +
      '<div style="display:flex;gap:8px;justify-content:flex-end;margin-top:12px;padding-top:10px;border-top:1px solid #f1f5f9">' +
        '<button class="btn" id="cve-orcid-close">Close</button>' +
      '</div>');
    dlg.panel.querySelector('#cve-orcid-close').addEventListener('click', dlg.close);
    var statusDiv = dlg.panel.querySelector('#cve-orcid-status');
    var resultsDiv = dlg.panel.querySelector('#cve-orcid-results');
    dlg.panel.querySelector('#cve-orcid-fetch').addEventListener('click', async function () {
      var id = dlg.panel.querySelector('#cve-orcid-id').value.trim();
      statusDiv.textContent = 'Fetching…';
      resultsDiv.innerHTML = '';
      try {
        var works = await CVImport.fetchORCID(id);
        // Match each work against existing doc for dedupe
        var rows = works.map(function (w) {
          var section = CVImport.orcidSectionFor(w);
          var probe = { title: w.title, doi: w.doi };
          var dupes = CVImport.findDuplicates(probe, state.doc);
          return { work: w, section: section, isDupe: dupes.length > 0 };
        });
        if (!rows.length) { statusDiv.textContent = 'No works found for this ORCID iD.'; return; }
        var html = '<div style="font-size:12px;color:#374151;margin-bottom:6px">' + rows.length + ' works — unchecked rows look like duplicates and will be skipped.</div>' +
          '<div style="max-height:340px;overflow:auto;border:1px solid #e5e7eb;border-radius:6px">';
        rows.forEach(function (r, i) {
          html += '<div style="display:flex;gap:8px;padding:8px 10px;border-bottom:1px solid #f1f5f9;align-items:flex-start">' +
            '<input type="checkbox" data-orcid-idx="' + i + '" ' + (r.isDupe ? '' : 'checked') + ' style="margin-top:3px">' +
            '<div style="flex:1;min-width:0">' +
              '<div style="font-size:13px;color:#111827">' + escHtml(r.work.title || '(untitled)') + (r.isDupe ? ' <span style="color:#dc2626;font-size:11px">[duplicate]</span>' : '') + '</div>' +
              '<div style="font-size:11px;color:#6b7280">' + escHtml([r.work.journal, r.work.year, r.section].filter(Boolean).join(' · ')) + '</div>' +
            '</div>' +
          '</div>';
        });
        html += '</div>' +
          '<div style="margin-top:10px;display:flex;gap:8px">' +
            '<button class="btn btn-primary" id="cve-orcid-import">Import selected</button>' +
            '<span id="cve-orcid-save-orcid" style="font-size:12px;color:#6b7280;align-self:center"></span>' +
          '</div>';
        resultsDiv.innerHTML = html;
        statusDiv.textContent = '';
        // Persist ORCID in profile if it wasn't set
        if (!existingOrcid) {
          state.doc.profile = state.doc.profile || {};
          state.doc.profile.orcid = id;
          try { await firebridge.setDoc('cvData', state.uid, { profile: state.doc.profile }, true); } catch (e) {}
        }
        resultsDiv.querySelector('#cve-orcid-import').addEventListener('click', async function () {
          var toAdd = { journals: [], conferences: [] };
          resultsDiv.querySelectorAll('[data-orcid-idx]').forEach(function (cb) {
            if (!cb.checked) return;
            var r = rows[Number(cb.dataset.orcidIdx)];
            var w = r.work;
            var entry = {
              _id: cvUid(),
              title: w.title || '',
              year: w.year || '',
              doi: w.doi || '',
              authors: '',
              status: 'Published',
            };
            if (r.section === 'conferences') entry.conference = w.journal || '';
            else entry.journal = w.journal || '';
            toAdd[r.section].push(entry);
          });
          var total = toAdd.journals.length + toAdd.conferences.length;
          if (!total) { statusDiv.textContent = 'Nothing selected.'; return; }
          statusDiv.textContent = 'Saving ' + total + ' entries…';
          var payload = {};
          if (toAdd.journals.length) {
            state.doc.journals = (state.doc.journals || []).concat(toAdd.journals);
            payload.journals = state.doc.journals;
          }
          if (toAdd.conferences.length) {
            state.doc.conferences = (state.doc.conferences || []).concat(toAdd.conferences);
            payload.conferences = state.doc.conferences;
          }
          try {
            await firebridge.setDoc('cvData', state.uid, payload, true);
            setStatus('Imported ' + total + ' from ORCID.', 'ok');
            dlg.close();
            render();
          } catch (err) {
            statusDiv.textContent = 'Save failed: ' + err.message;
          }
        });
      } catch (err) {
        statusDiv.textContent = 'Fetch failed: ' + err.message;
      }
    });
  }

  function openBibTeXDialog() {
    if (!firebridge.isReady()) { alert('Not signed in.'); return; }
    var dlg = openDialog('Import BibTeX',
      '<p style="margin:0 0 10px 0;font-size:13px;color:#374151">Paste BibTeX entries. Each entry is classified by type; duplicates against the existing CV are flagged.</p>' +
      '<textarea id="cve-bib-text" style="width:100%;min-height:200px;padding:8px;border:1px solid #d1d5db;border-radius:6px;font-family:ui-monospace,SFMono-Regular,Menlo,monospace;font-size:12px" placeholder="@article{...}"></textarea>' +
      '<div style="display:flex;gap:8px;margin-top:10px">' +
        '<button class="btn btn-primary" id="cve-bib-parse">Parse</button>' +
        '<button class="btn" id="cve-bib-close">Close</button>' +
        '<span id="cve-bib-status" style="font-size:12px;color:#6b7280;align-self:center"></span>' +
      '</div>' +
      '<div id="cve-bib-results" style="margin-top:12px"></div>');
    dlg.panel.querySelector('#cve-bib-close').addEventListener('click', dlg.close);
    var statusDiv = dlg.panel.querySelector('#cve-bib-status');
    var resultsDiv = dlg.panel.querySelector('#cve-bib-results');
    dlg.panel.querySelector('#cve-bib-parse').addEventListener('click', function () {
      var raw = dlg.panel.querySelector('#cve-bib-text').value;
      var entries = CVImport.parseBibtex(raw);
      if (!entries.length) { statusDiv.textContent = 'No entries parsed.'; resultsDiv.innerHTML = ''; return; }
      var rows = entries.map(function (e) {
        var dupes = CVImport.findDuplicates(e, state.doc);
        return { entry: e, isDupe: dupes.length > 0 };
      });
      statusDiv.textContent = entries.length + ' parsed';
      var html = '<div style="max-height:280px;overflow:auto;border:1px solid #e5e7eb;border-radius:6px">';
      rows.forEach(function (r, i) {
        html += '<div style="display:flex;gap:8px;padding:8px 10px;border-bottom:1px solid #f1f5f9;align-items:flex-start">' +
          '<input type="checkbox" data-bib-idx="' + i + '" ' + (r.isDupe ? '' : 'checked') + ' style="margin-top:3px">' +
          '<div style="flex:1;min-width:0">' +
            '<div style="font-size:13px;color:#111827">' + escHtml(r.entry.title || r.entry.name || r.entry.role || '(no title)') + (r.isDupe ? ' <span style="color:#dc2626;font-size:11px">[duplicate]</span>' : '') + '</div>' +
            '<div style="font-size:11px;color:#6b7280">' + escHtml([r.entry.section, r.entry.year, r.entry.journal || r.entry.conference || r.entry.publisher].filter(Boolean).join(' · ')) + '</div>' +
          '</div>' +
        '</div>';
      });
      html += '</div><div style="margin-top:10px"><button class="btn btn-primary" id="cve-bib-import">Import selected</button></div>';
      resultsDiv.innerHTML = html;
      resultsDiv.querySelector('#cve-bib-import').addEventListener('click', async function () {
        var bySec = {};
        resultsDiv.querySelectorAll('[data-bib-idx]').forEach(function (cb) {
          if (!cb.checked) return;
          var r = rows[Number(cb.dataset.bibIdx)];
          var sec = r.entry.section;
          var clean = Object.assign({}, r.entry);
          delete clean.section;
          (bySec[sec] = bySec[sec] || []).push(clean);
        });
        var total = Object.keys(bySec).reduce(function (s, k) { return s + bySec[k].length; }, 0);
        if (!total) { statusDiv.textContent = 'Nothing selected.'; return; }
        var payload = {};
        Object.keys(bySec).forEach(function (sec) {
          state.doc[sec] = (state.doc[sec] || []).concat(bySec[sec]);
          payload[sec] = state.doc[sec];
        });
        try {
          await firebridge.setDoc('cvData', state.uid, payload, true);
          setStatus('Imported ' + total + ' from BibTeX.', 'ok');
          dlg.close();
          render();
        } catch (err) {
          statusDiv.textContent = 'Save failed: ' + err.message;
        }
      });
    });
  }

  async function runCitationRefresh() {
    if (!firebridge.isReady()) { alert('Not signed in.'); return; }
    var papers = [].concat(state.doc.journals || [], state.doc.conferences || []).filter(function (e) { return e.doi; });
    if (!papers.length) { alert('No entries with DOI — nothing to refresh.'); return; }
    if (!confirm('Refresh citation counts for ' + papers.length + ' entries? (one request per entry, ~350ms each)')) return;
    setStatus('Refreshing 0/' + papers.length + '…');
    var updated = 0;
    for (var i = 0; i < papers.length; i++) {
      setStatus('Refreshing ' + (i + 1) + '/' + papers.length + '…');
      try {
        var count = await CVImport.fetchCitationCount(papers[i].doi);
        if (count != null) {
          var old = Number(papers[i].citations) || 0;
          if (count !== old) {
            papers[i].citations = count;
            updated++;
          }
        }
      } catch (err) { /* skip failed */ }
      await new Promise(function (r) { setTimeout(r, 350); });
    }
    try {
      await firebridge.setDoc('cvData', state.uid, {
        journals: state.doc.journals,
        conferences: state.doc.conferences,
      }, true);
      setStatus(updated ? ('Updated ' + updated + ' citation counts.') : 'All counts current.', 'ok');
      render();
    } catch (err) {
      setStatus('Save failed: ' + err.message, 'err');
    }
  }

  /* ── DOI fetch inside entry form ── */

  function attachDOIFetch(formHost, sectionKey) {
    if (!/journals|conferences|books/.test(sectionKey)) return;
    var doiInput = formHost.querySelector('[data-field-key="doi"]');
    if (!doiInput) return;
    var wrap = doiInput.parentElement;
    var btn = document.createElement('button');
    btn.type = 'button';
    btn.className = 'btn';
    btn.textContent = 'Fetch from DOI';
    btn.style.cssText = 'margin-top:4px;padding:4px 10px;font-size:12px;align-self:flex-start';
    btn.addEventListener('click', async function () {
      var doi = doiInput.value.trim();
      if (!doi) { alert('Paste a DOI first.'); return; }
      btn.disabled = true; btn.textContent = 'Fetching…';
      try {
        var r = await CVImport.fetchDOI(doi);
        // Apply to matching fields
        var map = {
          journals:    { title:'title', authors:'authors', journal:'journal', year:'year', volume:'volume', issue:'issue', pages:'pages', abstract:'abstract', citations:'citations', doi:'doi' },
          conferences: { title:'title', authors:'authors', conference:'journal', year:'year', pages:'pages', abstract:'abstract', doi:'doi' },
          books:       { title:'title', authors:'authors', year:'year', doi:'doi' },
        };
        var fieldMap = map[sectionKey] || {};
        Object.keys(fieldMap).forEach(function (targetKey) {
          var src = r[fieldMap[targetKey]];
          if (src == null || src === '') return;
          var el = formHost.querySelector('[data-field-key="' + targetKey + '"]');
          if (el && el.value === '') el.value = src;
        });
        btn.textContent = 'Applied ✓';
        setTimeout(function () { btn.textContent = 'Fetch from DOI'; btn.disabled = false; }, 1200);
      } catch (err) {
        alert('DOI fetch failed: ' + err.message);
        btn.textContent = 'Fetch from DOI'; btn.disabled = false;
      }
    });
    wrap.appendChild(btn);
  }

  /* ── html helpers ── */

  function escHtml(s) {
    return String(s == null ? '' : s).replace(/[&<>"']/g, function (c) {
      return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c];
    });
  }
  function escAttr(s) { return escHtml(s); }

  /* ── boot ── */
  if (typeof firebridge !== 'undefined') {
    firebridge.onAuth(function (user) {
      if (user && firebridge.isReady()) loadDoc();
      else showNotConnected();
    });
  } else {
    document.addEventListener('DOMContentLoaded', showNotConnected);
  }
})();
