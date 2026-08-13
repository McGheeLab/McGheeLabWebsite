/* grant-editor.js — V3.179.
 *
 * Single-author grant editor. Stores the entire section/block tree on the
 * grant doc as `grantDrafts/{id}.tree` and rewrites it on autosave (debounced
 * 700 ms after the last keystroke). No Yjs — the data shape matches the
 * paper-editor's Y.Doc tree exactly so a future V3.183 Yjs upgrade can
 * hydrate without migration.
 *
 * The editor renders:
 *   - Topbar: title + savestate
 *   - Sidebar: section outline (drag-reorder via simple up/down arrows)
 *   - Main: per-section blocks (paragraph, aim-bullets, budget-table embed,
 *           personnel-table, compliance-row, letter-card)
 *
 * Block kinds:
 *   - paragraph        — contenteditable rich text
 *   - aim-bullets      — hypothesis textarea + 3 aim cards with title + summary
 *   - budget-table     — placement marker; clicking opens the budget modal
 *   - personnel-table  — simple table
 *   - compliance-row   — yes/no/na radio
 *   - letter-card      — name + role + status placeholder (uploads in V3.183)
 *
 * Cross-page integration:
 *   - "Attach biosketch" button — picks a `biosketches/{uid}/variants/{vid}`
 *     and stamps the id onto attachments.biosketchVariantIds + biosketches/{uid}/
 *     variants/{vid}.grantDraftIds.
 *   - "Attach facilities" button — same pattern with facilitiesDocs/{docId}.
 */

(function () {
  'use strict';

  var COLL = 'grantDrafts';

  /* ---- escape helpers ---- */
  function esc(s) {
    if (s == null) return '';
    return String(s)
      .replace(/&/g, '&amp;')
      .replace(/</g, '&lt;')
      .replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;')
      .replace(/'/g, '&#39;');
  }

  /* ---- State ---- */

  var state = {
    grantId: null,
    doc: null,           // full grant doc
    tree: null,          // normalized section/block tree
    activeSectionId: null,
    saveTimer: 0,
    saveStatus: 'idle',
  };

  function $(id) { return document.getElementById(id); }

  function setSaveStatus(s) {
    state.saveStatus = s;
    var el = $('ge-savestate');
    if (!el) return;
    el.textContent = s === 'saving' ? 'Saving…' : s === 'saved' ? 'Saved' : s === 'error' ? 'Save failed' : '';
  }

  /* ---- Persistence ---- */

  function scheduleSave() {
    if (!state.grantId || !state.doc) return;
    clearTimeout(state.saveTimer);
    setSaveStatus('saving');
    state.saveTimer = setTimeout(persist, 700);
  }

  async function persist() {
    if (!state.grantId) return;
    try {
      var stamp = firebase.firestore.FieldValue.serverTimestamp();
      await firebridge.db().collection(COLL).doc(state.grantId).update({
        title: state.doc.title,
        tree: state.tree,
        attachments: state.doc.attachments || { biosketchVariantIds: [], facilitiesDocIds: [] },
        budgetSummary: state.doc.budgetSummary || { directs: 0, indirects: 0, total: 0, years: [] },
        repo_path: state.doc.repo_path || '',
        updatedAt: stamp,
      });
      setSaveStatus('saved');
    } catch (e) {
      console.error('[grant-editor] save failed:', e);
      setSaveStatus('error');
    }
  }

  /* ---- Block renderers ---- */

  function renderBlock(sec, blk) {
    var el = document.createElement('div');
    el.className = 'pe-block pe-block-' + blk.kind;
    el.dataset.blockId = blk.id;

    var toolbar = document.createElement('div');
    toolbar.className = 'pe-block-toolbar';
    toolbar.innerHTML = ''
      + '<span class="pe-block-handle" title="Drag — coming soon">⋮⋮</span>'
      + '<select class="pe-status-pill" data-status-select>'
      +   '<option value="draft">draft</option>'
      +   '<option value="needs-review">needs review</option>'
      +   '<option value="complete">complete</option>'
      + '</select>'
      + '<span style="flex:1 1 auto;"></span>'
      + '<button class="btn pe-block-action" data-action="delete" title="Delete block">×</button>';

    var statusSel = toolbar.querySelector('[data-status-select]');
    statusSel.value = blk.status || 'draft';
    statusSel.addEventListener('change', function () {
      blk.status = statusSel.value;
      scheduleSave();
    });
    toolbar.querySelector('[data-action="delete"]').addEventListener('click', function (e) {
      e.preventDefault();
      if (!confirm('Delete this block?')) return;
      sec.children = sec.children.filter(function (b) { return b.id !== blk.id; });
      if (!sec.children.length) {
        sec.children.push(window.GrantSchemas.newParagraph(''));
      }
      renderSection(sec);
      scheduleSave();
    });

    el.appendChild(toolbar);

    var body = document.createElement('div');
    body.className = 'pe-block-body';
    switch (blk.kind) {
      case 'paragraph':       renderParagraphInto(body, blk); break;
      case 'aim-bullets':     renderAimBulletsInto(body, blk); break;
      case 'budget-table':    renderBudgetTableInto(body, blk); break;
      case 'personnel-table': renderPersonnelTableInto(body, blk); break;
      case 'compliance-row':  renderComplianceRowInto(body, blk); break;
      case 'letter-card':     renderLetterCardInto(body, blk); break;
      default:                body.innerHTML = '<p style="color:#888;">Unsupported block kind: ' + esc(blk.kind) + '</p>';
    }
    el.appendChild(body);
    return el;
  }

  function renderParagraphInto(host, blk) {
    var div = document.createElement('div');
    div.contentEditable = 'true';
    div.className = 'pe-paragraph';
    div.style.minHeight = '60px';
    div.style.padding = '8px';
    div.style.border = '1px solid transparent';
    div.style.borderRadius = '4px';
    div.style.whiteSpace = 'pre-wrap';
    div.innerHTML = blk.body || '';
    div.addEventListener('focus', function () { div.style.borderColor = '#dbeafe'; });
    div.addEventListener('blur', function () { div.style.borderColor = 'transparent'; });
    div.addEventListener('input', function () {
      blk.body = div.innerHTML;
      scheduleSave();
    });
    host.appendChild(div);
  }

  function renderAimBulletsInto(host, blk) {
    blk.attrs = blk.attrs || {};
    var hypoLabel = document.createElement('label');
    hypoLabel.textContent = 'Hypothesis / Framing';
    hypoLabel.style.fontWeight = '600';
    hypoLabel.style.display = 'block';
    hypoLabel.style.marginBottom = '4px';
    host.appendChild(hypoLabel);

    var hypo = document.createElement('textarea');
    hypo.value = blk.attrs.hypothesis || '';
    hypo.rows = 3;
    hypo.style.width = '100%';
    hypo.placeholder = 'State the central hypothesis or framing in one or two sentences…';
    hypo.addEventListener('input', function () {
      blk.attrs.hypothesis = hypo.value;
      scheduleSave();
    });
    host.appendChild(hypo);

    var aims = Array.isArray(blk.attrs.aims) ? blk.attrs.aims : [];

    var grid = document.createElement('div');
    grid.style.display = 'grid';
    grid.style.gridTemplateColumns = 'repeat(auto-fit, minmax(260px, 1fr))';
    grid.style.gap = '12px';
    grid.style.marginTop = '12px';

    aims.forEach(function (aim, idx) {
      var card = document.createElement('div');
      card.style.cssText = 'border:1px solid var(--border,#e5e7eb);border-radius:6px;padding:10px;background:#fafbff;';
      var head = document.createElement('div');
      head.style.cssText = 'display:flex;align-items:center;gap:6px;margin-bottom:6px;';
      head.innerHTML = '<strong style="flex:1 1 auto;">Aim ' + (idx + 1) + '</strong>'
        + '<button class="btn pe-block-action" data-aim-rm="' + esc(aim.id) + '" title="Remove">×</button>';
      head.querySelector('[data-aim-rm]').addEventListener('click', function (e) {
        e.preventDefault();
        blk.attrs.aims = blk.attrs.aims.filter(function (a) { return a.id !== aim.id; });
        renderBlocksFor(state.activeSectionId);
        scheduleSave();
      });
      card.appendChild(head);

      var titleIn = document.createElement('input');
      titleIn.type = 'text';
      titleIn.placeholder = 'Aim title (1 line)';
      titleIn.style.cssText = 'width:100%;padding:6px;font-weight:600;border:1px solid var(--border,#e5e7eb);border-radius:4px;margin-bottom:6px;';
      titleIn.value = aim.title || '';
      titleIn.addEventListener('input', function () { aim.title = titleIn.value; scheduleSave(); });
      card.appendChild(titleIn);

      var summ = document.createElement('textarea');
      summ.placeholder = 'Aim summary — what will you do, in what model, to test what?';
      summ.rows = 3;
      summ.style.width = '100%';
      summ.value = aim.summary || '';
      summ.addEventListener('input', function () { aim.summary = summ.value; scheduleSave(); });
      card.appendChild(summ);

      grid.appendChild(card);
    });

    host.appendChild(grid);

    var addBtn = document.createElement('button');
    addBtn.className = 'btn';
    addBtn.textContent = '+ Aim';
    addBtn.style.marginTop = '8px';
    addBtn.addEventListener('click', function (e) {
      e.preventDefault();
      blk.attrs.aims = blk.attrs.aims || [];
      blk.attrs.aims.push({
        id: window.GrantSchemas.shortId('aim-'),
        title: 'Aim ' + (blk.attrs.aims.length + 1),
        summary: '',
      });
      renderBlocksFor(state.activeSectionId);
      scheduleSave();
    });
    host.appendChild(addBtn);
  }

  function renderBudgetTableInto(host, blk) {
    host.innerHTML = '';
    var card = document.createElement('div');
    card.style.cssText = 'border:1px dashed var(--border,#cbd5e1);border-radius:6px;padding:14px;background:#f8fafc;';

    var head = document.createElement('div');
    head.style.cssText = 'display:flex;align-items:center;justify-content:space-between;margin-bottom:8px;';
    var summary = (state.doc && state.doc.budgetSummary) || { directs: 0, indirects: 0, total: 0, years: [] };
    head.innerHTML = '<strong>Budget</strong>'
      + '<span style="font-size:13px;color:var(--text-muted,#6b7280);">'
      +   'Direct: $' + numFmt(summary.directs || 0)
      +   ' · Indirect: $' + numFmt(summary.indirects || 0)
      +   ' · <strong>Total: $' + numFmt(summary.total || 0) + '</strong>'
      + '</span>';
    card.appendChild(head);

    var openBtn = document.createElement('button');
    openBtn.className = 'btn btn-primary';
    openBtn.textContent = 'Open budget editor';
    openBtn.addEventListener('click', function (e) {
      e.preventDefault();
      if (!window.GrantBudget || !window.GrantBudget.open) {
        alert('Budget editor not loaded.');
        return;
      }
      window.GrantBudget.open({
        grantId: state.grantId,
        onClose: function (newSummary) {
          state.doc.budgetSummary = newSummary || state.doc.budgetSummary;
          renderBlocksFor(state.activeSectionId);
          scheduleSave();
        }
      });
    });
    card.appendChild(openBtn);

    host.appendChild(card);
  }

  function renderPersonnelTableInto(host, blk) {
    blk.attrs = blk.attrs || { rows: [] };
    var rows = Array.isArray(blk.attrs.rows) ? blk.attrs.rows : [];

    var tbl = document.createElement('table');
    tbl.className = 'pe-personnel-table';
    tbl.style.cssText = 'width:100%;border-collapse:collapse;font-size:13px;';
    tbl.innerHTML = '<thead><tr>'
      + '<th style="text-align:left;padding:4px 6px;border-bottom:1px solid var(--border);">Name</th>'
      + '<th style="text-align:left;padding:4px 6px;border-bottom:1px solid var(--border);">Role</th>'
      + '<th style="text-align:left;padding:4px 6px;border-bottom:1px solid var(--border);">Effort</th>'
      + '<th style="text-align:left;padding:4px 6px;border-bottom:1px solid var(--border);">Notes</th>'
      + '<th style="border-bottom:1px solid var(--border);"></th>'
      + '</tr></thead>';

    var body = document.createElement('tbody');
    rows.forEach(function (row, idx) {
      var tr = document.createElement('tr');
      ['name', 'role', 'effort', 'notes'].forEach(function (k) {
        var td = document.createElement('td');
        td.style.padding = '4px 6px';
        td.style.borderBottom = '1px solid var(--border)';
        var inp = document.createElement('input');
        inp.type = 'text';
        inp.value = row[k] || '';
        inp.style.cssText = 'width:100%;padding:4px 6px;border:1px solid transparent;background:transparent;';
        inp.addEventListener('focus', function () { inp.style.background = '#fff'; inp.style.borderColor = 'var(--border)'; });
        inp.addEventListener('blur', function () { inp.style.background = 'transparent'; inp.style.borderColor = 'transparent'; });
        inp.addEventListener('input', function () { row[k] = inp.value; scheduleSave(); });
        td.appendChild(inp);
        tr.appendChild(td);
      });
      var rmTd = document.createElement('td');
      var rm = document.createElement('button');
      rm.className = 'btn pe-block-action';
      rm.textContent = '×';
      rm.addEventListener('click', function (e) {
        e.preventDefault();
        blk.attrs.rows.splice(idx, 1);
        renderBlocksFor(state.activeSectionId);
        scheduleSave();
      });
      rmTd.appendChild(rm);
      tr.appendChild(rmTd);
      body.appendChild(tr);
    });
    tbl.appendChild(body);
    host.appendChild(tbl);

    var addBtn = document.createElement('button');
    addBtn.className = 'btn';
    addBtn.textContent = '+ Add person';
    addBtn.style.marginTop = '6px';
    addBtn.addEventListener('click', function (e) {
      e.preventDefault();
      blk.attrs.rows = blk.attrs.rows || [];
      blk.attrs.rows.push({ name: '', role: '', effort: '', notes: '' });
      renderBlocksFor(state.activeSectionId);
      scheduleSave();
    });
    host.appendChild(addBtn);
  }

  function renderComplianceRowInto(host, blk) {
    blk.attrs = blk.attrs || {};
    var row = document.createElement('div');
    row.style.cssText = 'display:flex;align-items:center;gap:12px;padding:6px 0;';
    var lbl = document.createElement('label');
    lbl.style.flex = '1 1 auto';
    lbl.textContent = blk.body || 'Compliance question';
    row.appendChild(lbl);

    ['yes', 'no', 'na'].forEach(function (v) {
      var rb = document.createElement('label');
      rb.style.cssText = 'display:inline-flex;gap:4px;align-items:center;font-size:13px;';
      var i = document.createElement('input');
      i.type = 'radio';
      i.name = 'compliance-' + blk.id;
      i.value = v;
      if (blk.attrs.answer === v) i.checked = true;
      i.addEventListener('change', function () { blk.attrs.answer = v; scheduleSave(); });
      rb.appendChild(i);
      rb.appendChild(document.createTextNode(v === 'na' ? 'N/A' : (v.charAt(0).toUpperCase() + v.slice(1))));
      row.appendChild(rb);
    });
    host.appendChild(row);
  }

  function renderLetterCardInto(host, blk) {
    blk.attrs = blk.attrs || {};
    var card = document.createElement('div');
    card.style.cssText = 'border:1px solid var(--border);border-radius:6px;padding:10px;background:#fff;';

    ['from', 'institution', 'role'].forEach(function (k) {
      var lbl = document.createElement('label');
      lbl.style.cssText = 'display:block;font-size:11px;color:var(--text-muted,#6b7280);margin-top:6px;';
      lbl.textContent = k === 'from' ? 'Letter writer' : (k === 'institution' ? 'Institution' : 'Role');
      card.appendChild(lbl);
      var inp = document.createElement('input');
      inp.type = 'text';
      inp.style.cssText = 'width:100%;padding:6px;border:1px solid var(--border);border-radius:4px;';
      inp.value = blk.attrs[k] || '';
      inp.addEventListener('input', function () { blk.attrs[k] = inp.value; scheduleSave(); });
      card.appendChild(inp);
    });

    var note = document.createElement('div');
    note.style.cssText = 'margin-top:8px;font-size:11px;color:var(--text-muted,#6b7280);';
    note.textContent = 'Upload integration ships in V3.183. For now, track the request manually.';
    card.appendChild(note);

    host.appendChild(card);
  }

  /* ---- Section rendering ---- */

  function renderOutline() {
    var ul = $('ge-outline');
    if (!ul) return;
    ul.innerHTML = '';
    state.tree.sections.forEach(function (sec) {
      var li = document.createElement('li');
      li.className = 'pe-sidebar-item' + (state.activeSectionId === sec.id ? ' active' : '');
      li.dataset.sectionId = sec.id;
      var styleObj = window.GrantSchemas.styleFor(sec) || {};
      var pageBudget = styleObj.pageBudget ? (' · ' + styleObj.pageBudget + 'p') : '';
      li.innerHTML = ''
        + '<span class="pe-sec-label">' + esc(sec.label || 'Untitled') + '</span>'
        + '<span class="pe-sec-meta" style="font-size:10px;color:var(--text-muted,#6b7280);">'
        +   esc(sec.kind) + pageBudget
        + '</span>';
      li.style.cssText = 'padding:6px 8px;border-radius:4px;cursor:pointer;' + (state.activeSectionId === sec.id ? 'background:#eef2ff;' : '');
      li.addEventListener('click', function () { setActiveSection(sec.id); });
      ul.appendChild(li);
    });
  }

  function renderSection(sec) {
    state.activeSectionId = sec.id;
    renderOutline();
    var host = $('ge-content');
    host.innerHTML = '';
    var header = document.createElement('div');
    header.className = 'pe-section-header';
    header.style.cssText = 'display:flex;align-items:baseline;gap:8px;margin-bottom:12px;';
    var labelInput = document.createElement('input');
    labelInput.type = 'text';
    labelInput.value = sec.label || '';
    labelInput.style.cssText = 'font-size:22px;font-weight:600;border:none;outline:none;flex:1 1 auto;background:transparent;';
    labelInput.addEventListener('input', function () {
      sec.label = labelInput.value;
      renderOutline();
      scheduleSave();
    });
    header.appendChild(labelInput);

    var styleObj = window.GrantSchemas.styleFor(sec) || {};
    if (styleObj.pageBudget) {
      var pb = document.createElement('span');
      pb.style.cssText = 'font-size:12px;color:var(--text-muted,#6b7280);';
      pb.textContent = 'Page limit: ' + styleObj.pageBudget;
      header.appendChild(pb);
    }

    var rmBtn = document.createElement('button');
    rmBtn.className = 'btn';
    rmBtn.textContent = 'Delete section';
    rmBtn.addEventListener('click', function (e) {
      e.preventDefault();
      if (!confirm('Delete section "' + (sec.label || sec.kind) + '" and all its blocks?')) return;
      state.tree.sections = state.tree.sections.filter(function (s) { return s.id !== sec.id; });
      state.activeSectionId = state.tree.sections.length ? state.tree.sections[0].id : null;
      renderOutline();
      if (state.activeSectionId) {
        renderSection(state.tree.sections.find(function (s) { return s.id === state.activeSectionId; }));
      } else {
        host.innerHTML = '<div class="empty-state">No sections. Click + Add section.</div>';
      }
      scheduleSave();
    });
    header.appendChild(rmBtn);

    host.appendChild(header);

    var blocksHost = document.createElement('div');
    blocksHost.id = 'ge-blocks';
    host.appendChild(blocksHost);

    renderBlocksFor(sec.id);
  }

  function renderBlocksFor(sectionId) {
    var sec = (state.tree.sections || []).find(function (s) { return s.id === sectionId; });
    if (!sec) return;
    var host = $('ge-blocks');
    if (!host) return;
    host.innerHTML = '';
    (sec.children || []).forEach(function (blk) {
      host.appendChild(renderBlock(sec, blk));
    });
    host.appendChild(renderBlockToolbar(sec));
  }

  function renderBlockToolbar(sec) {
    var bar = document.createElement('div');
    bar.className = 'pe-block-toolbar-add';
    bar.style.cssText = 'display:flex;gap:6px;flex-wrap:wrap;margin-top:12px;padding-top:8px;border-top:1px dashed var(--border);';

    var label = document.createElement('span');
    label.textContent = 'Add block:';
    label.style.cssText = 'font-size:12px;color:var(--text-muted,#6b7280);align-self:center;';
    bar.appendChild(label);

    var styleObj = window.GrantSchemas.styleFor(sec) || {};
    var options = [
      { kind: 'paragraph',       label: 'Paragraph',       factory: function () { return window.GrantSchemas.newParagraph(''); } },
      { kind: 'aim-bullets',     label: 'Aim bullets',     factory: function () { return window.GrantSchemas.newAimBullets(); } },
      { kind: 'budget-table',    label: 'Budget table',    factory: function () { return window.GrantSchemas.newBudgetTable(); } },
      { kind: 'personnel-table', label: 'Personnel table', factory: function () { return window.GrantSchemas.newPersonnelTable(); } },
      { kind: 'compliance-row',  label: 'Compliance row',  factory: function () { return window.GrantSchemas.newComplianceRow('Custom compliance question?'); } },
      { kind: 'letter-card',     label: 'Letter of support', factory: function () { return window.GrantSchemas.newLetterCard(); } },
    ];

    options.forEach(function (opt) {
      var btn = document.createElement('button');
      btn.className = 'btn';
      btn.style.fontSize = '12px';
      btn.textContent = '+ ' + opt.label;
      btn.addEventListener('click', function (e) {
        e.preventDefault();
        sec.children = sec.children || [];
        sec.children.push(opt.factory());
        renderBlocksFor(sec.id);
        scheduleSave();
      });
      bar.appendChild(btn);
    });

    return bar;
  }

  function setActiveSection(id) {
    var sec = state.tree.sections.find(function (s) { return s.id === id; });
    if (!sec) return;
    renderSection(sec);
  }

  /* ---- Add-section dialog ---- */

  function addSectionDialog() {
    var kinds = window.GrantSchemas.GRANT_SECTION_KINDS;
    var labelMap = window.GrantSchemas.SECTION_KIND_LABELS;
    var list = kinds.map(function (k, i) { return (i + 1) + '. ' + (labelMap[k] || k) + ' (' + k + ')'; }).join('\n');
    var pick = prompt('Add section — type a kind from this list:\n\n' + list + '\n\nOr a custom label like "custom:My Section"');
    if (!pick) return;
    pick = pick.trim();
    var kind, label;
    if (pick.indexOf('custom:') === 0) {
      kind = 'custom';
      label = pick.slice(7).trim() || 'Custom section';
    } else if (kinds.indexOf(pick) >= 0) {
      kind = pick;
      label = labelMap[kind] || kind;
    } else {
      // Try matching by label.
      var found = null;
      kinds.forEach(function (k) { if ((labelMap[k] || '').toLowerCase() === pick.toLowerCase()) found = k; });
      if (found) {
        kind = found;
        label = labelMap[found];
      } else {
        kind = 'custom';
        label = pick;
      }
    }
    var sec = window.GrantSchemas.newSection(kind, label, state.tree.sections.length);
    sec.children = window.GrantSchemas.seedBlocksForSection(kind);
    state.tree.sections.push(sec);
    setActiveSection(sec.id);
    scheduleSave();
  }

  /* ---- Attachments (biosketches + facilities) ---- */

  async function pickBiosketch() {
    var user = firebridge.getUser();
    if (!user) { alert('Sign in first.'); return; }
    try {
      var snap = await firebridge.db().collection('biosketches').doc(user.uid).collection('variants').get();
      var variants = snap.docs.map(function (d) { return Object.assign({ id: d.id }, d.data()); });
      if (!variants.length) {
        alert('No biosketch variants yet. Create one at /rm/pages/grant-biosketch.html');
        return;
      }
      var list = variants.map(function (v, i) { return (i + 1) + '. ' + (v.label || 'Untitled') + ' (' + (v.mechanism || 'NIH-5pg') + ')'; }).join('\n');
      var pick = prompt('Attach which biosketch?\n\n' + list + '\n\nEnter number:');
      var idx = parseInt(pick, 10) - 1;
      if (isNaN(idx) || idx < 0 || idx >= variants.length) return;
      var v = variants[idx];
      state.doc.attachments = state.doc.attachments || { biosketchVariantIds: [], facilitiesDocIds: [] };
      if (state.doc.attachments.biosketchVariantIds.indexOf(v.id) < 0) {
        state.doc.attachments.biosketchVariantIds.push(v.id);
      }
      // Backref onto the biosketch variant so the variant's own UI can show
      // which grants it's attached to.
      try {
        await firebridge.db().collection('biosketches').doc(user.uid).collection('variants').doc(v.id).update({
          grantDraftIds: firebase.firestore.FieldValue.arrayUnion(state.grantId),
        });
      } catch (e) { console.warn('[grant-editor] biosketch backref failed:', e); }
      renderAttachedList();
      scheduleSave();
    } catch (e) {
      console.error('[grant-editor] biosketch pick failed:', e);
      alert('Failed to load biosketches: ' + e.message);
    }
  }

  async function pickFacilities() {
    try {
      var snap = await firebridge.db().collection('facilitiesDocs').get();
      var docs = snap.docs.map(function (d) { return Object.assign({ id: d.id }, d.data()); });
      if (!docs.length) {
        alert('No facilities docs yet. Create one at /rm/pages/grant-facilities.html');
        return;
      }
      var list = docs.map(function (d, i) { return (i + 1) + '. ' + (d.label || 'Untitled'); }).join('\n');
      var pick = prompt('Attach which facilities doc?\n\n' + list + '\n\nEnter number:');
      var idx = parseInt(pick, 10) - 1;
      if (isNaN(idx) || idx < 0 || idx >= docs.length) return;
      var d = docs[idx];
      state.doc.attachments = state.doc.attachments || { biosketchVariantIds: [], facilitiesDocIds: [] };
      if (state.doc.attachments.facilitiesDocIds.indexOf(d.id) < 0) {
        state.doc.attachments.facilitiesDocIds.push(d.id);
      }
      try {
        await firebridge.db().collection('facilitiesDocs').doc(d.id).update({
          attachedTo: firebase.firestore.FieldValue.arrayUnion(state.grantId),
        });
      } catch (e) { console.warn('[grant-editor] facilities backref failed:', e); }
      renderAttachedList();
      scheduleSave();
    } catch (e) {
      console.error('[grant-editor] facilities pick failed:', e);
      alert('Failed to load facilities docs: ' + e.message);
    }
  }

  async function renderAttachedList() {
    var host = $('ge-attached-list');
    if (!host) return;
    var atts = (state.doc && state.doc.attachments) || { biosketchVariantIds: [], facilitiesDocIds: [] };
    var html = '';
    var bioCount = (atts.biosketchVariantIds || []).length;
    var facCount = (atts.facilitiesDocIds || []).length;
    if (!bioCount && !facCount) {
      html = '<em>No attachments yet.</em>';
    } else {
      if (bioCount) html += '<div>📄 Biosketches: ' + bioCount + '</div>';
      if (facCount) html += '<div>🏛 Facilities: ' + facCount + '</div>';
      html += '<a href="#" id="ge-clear-attachments" style="font-size:11px;">Clear all</a>';
    }
    host.innerHTML = html;
    var clear = $('ge-clear-attachments');
    if (clear) {
      clear.addEventListener('click', function (e) {
        e.preventDefault();
        if (!confirm('Detach all biosketches + facilities docs?')) return;
        state.doc.attachments = { biosketchVariantIds: [], facilitiesDocIds: [] };
        renderAttachedList();
        scheduleSave();
      });
    }
  }

  /* ---- V3.187 Linked Papers panel ---- */
  //
  // Queries items.json for library papers whose meta.library.linked_drafts
  // includes this grantDraft's id. Click → opens library-paper.html with
  // ?draft=<grantId> so the paper reader auto-activates this grant's
  // overlay. "+ Link" picks any library paper and writes the grantId into
  // its linked_drafts array. Drop a .paper-overlay.md → uploads to
  // grant-overlays/{grantId}/{sha256}.md (V3.188 wires the materialization
  // pipeline; this drop zone is the entry point).

  async function renderLinkedPapers() {
    var host = $('ge-linked-papers-list');
    if (!host) return;
    host.innerHTML = '<em>Loading…</em>';
    try {
      var data = await api.load('items.json');
      var items = (data && data.items) || [];
      var papers = items.filter(function (it) {
        if (it.type !== 'paper') return false;
        var ld = it.meta && it.meta.library && it.meta.library.linked_drafts;
        return Array.isArray(ld) && ld.indexOf(state.grantId) >= 0;
      });
      if (!papers.length) {
        host.innerHTML = '<em>No papers tagged with this grant yet.</em>';
        return;
      }
      host.innerHTML = papers.map(function (p) {
        var m = (p.meta && p.meta.library) || {};
        var title = (m.title || p.title || p.id);
        var meta  = [m.year, m.authors_short || m.authors || ''].filter(Boolean).join(' · ');
        return ''
          + '<div style="margin-bottom:6px;padding:6px;border-radius:4px;background:#fff;border:1px solid var(--border,#e5e7eb);">'
          +   '<a href="/rm/pages/library-paper.html?id=' + encodeURIComponent(p.id) + '&draft=' + encodeURIComponent(state.grantId) + '" '
          +     'style="font-weight:600;color:var(--primary,#1d4ed8);text-decoration:none;display:block;line-height:1.2;">'
          +     esc(title.slice(0, 80)) + (title.length > 80 ? '…' : '')
          +   '</a>'
          +   (meta ? ('<div style="font-size:10px;color:var(--text-muted,#6b7280);margin-top:2px;">' + esc(meta) + '</div>') : '')
          +   '<a href="#" data-unlink="' + esc(p.id) + '" style="font-size:10px;color:var(--text-muted,#9ca3af);">untag</a>'
          + '</div>';
      }).join('');
      host.querySelectorAll('[data-unlink]').forEach(function (a) {
        a.addEventListener('click', async function (e) {
          e.preventDefault();
          var paperId = a.getAttribute('data-unlink');
          await unlinkPaperFromGrant(paperId);
          renderLinkedPapers();
        });
      });
    } catch (e) {
      console.warn('[grant-editor] linked-papers load failed:', e);
      host.innerHTML = '<em>Failed to load linked papers.</em>';
    }
  }

  /* V3.352 — routed through LIBRARY_LINKS.toggleDraftLink (atomic
   * single-doc arrayUnion/arrayRemove; concurrency-safe). */
  async function tagPaperWithGrant(paperId) {
    if (!paperId || !state.grantId) return;
    await window.LIBRARY_LINKS.toggleDraftLink(paperId, state.grantId, true);
  }

  async function unlinkPaperFromGrant(paperId) {
    if (!paperId || !state.grantId) return;
    await window.LIBRARY_LINKS.toggleDraftLink(paperId, state.grantId, false);
  }

  async function pickPaperToLink() {
    try {
      var data = await api.load('items.json');
      var items = (data && data.items) || [];
      var papers = items.filter(function (it) {
        if (it.type !== 'paper') return false;
        var ld = (it.meta && it.meta.library && it.meta.library.linked_drafts) || [];
        return ld.indexOf(state.grantId) < 0;  // not already linked
      });
      if (!papers.length) {
        alert('No library papers found that aren\'t already linked.');
        return;
      }
      // Sort by year desc + truncate to top 50 — bigger picker UX is a V3.190+ polish.
      papers.sort(function (a, b) {
        var ya = (a.meta && a.meta.library && a.meta.library.year) || 0;
        var yb = (b.meta && b.meta.library && b.meta.library.year) || 0;
        return (yb || 0) - (ya || 0);
      });
      var top = papers.slice(0, 50);
      var list = top.map(function (p, i) {
        var m = (p.meta && p.meta.library) || {};
        var t = (m.title || p.title || p.id).slice(0, 70);
        return (i + 1) + '. ' + t + (m.year ? (' (' + m.year + ')') : '');
      }).join('\n');
      var pick = prompt('Tag which library paper with this grant?\n\n' + list + '\n\nEnter number:');
      var idx = parseInt(pick, 10) - 1;
      if (isNaN(idx) || idx < 0 || idx >= top.length) return;
      await tagPaperWithGrant(top[idx].id);
      renderLinkedPapers();
    } catch (e) {
      console.error('[grant-editor] pick paper failed:', e);
      alert('Failed: ' + e.message);
    }
  }

  /* ---- V3.188 Overlay file upload ---- */

  async function sha256Hex(blob) {
    var buf = await blob.arrayBuffer();
    var hash = await crypto.subtle.digest('SHA-256', buf);
    return Array.from(new Uint8Array(hash))
      .map(function (b) { return b.toString(16).padStart(2, '0'); })
      .join('');
  }

  async function uploadOverlayFile(file) {
    if (!file || !/\.(md|markdown)$/i.test(file.name)) {
      alert('Drop a .paper-overlay.md or .md file.');
      return;
    }
    if (file.size > 1024 * 1024) {
      alert('Overlay file exceeds 1 MB.');
      return;
    }
    var user = firebridge.getUser();
    if (!user) { alert('Sign in first.'); return; }
    try {
      var text = await file.text();
      var hash = await sha256Hex(file);
      var storagePath = 'grant-overlays/' + state.grantId + '/' + hash + '.md';
      var storageRef = firebase.storage().ref(storagePath);
      // Skip re-upload if same hash already exists.
      var existingUrl = null;
      try { existingUrl = await storageRef.getDownloadURL(); } catch (_) { /* not present */ }
      if (!existingUrl) {
        await storageRef.putString(text, 'raw', { contentType: 'text/markdown' });
        existingUrl = await storageRef.getDownloadURL();
      }
      // Parse front-matter to pull out paper_id/doi + draft_id for metadata.
      var fm = parseFrontmatter(text);
      var paperId = fm.paper_id || '';
      var stamp = firebase.firestore.FieldValue.serverTimestamp();
      var overlayMeta = {
        fileName: file.name,
        fileHash: hash,
        fileSize: file.size,
        storagePath: storagePath,
        downloadUrl: existingUrl,
        paperId: paperId,
        paperDoi: fm.paper_doi || '',
        draftId: fm.draft_id || fm.grant_id || state.grantId,
        overlayTitle: fm.overlay_title || '',
        uploadedBy: user.uid,
        uploadedAt: stamp,
      };
      // Use the hash as the doc id — idempotent re-upload.
      await firebridge.db().collection('grantDrafts').doc(state.grantId)
        .collection('overlays').doc(hash).set(overlayMeta, { merge: true });
      // Best-effort: also tag the paper with this grant id if paper_id matches a library item.
      if (paperId) {
        try { await tagPaperWithGrant(paperId); } catch (e) { console.warn('[grant-editor] auto-tag failed:', e); }
      }
      if (window.TOAST) window.TOAST.success('Overlay uploaded — open the paper to materialize highlights.');
      renderLinkedPapers();
      renderOverlayFilesList();
    } catch (e) {
      console.error('[grant-editor] overlay upload failed:', e);
      alert('Upload failed: ' + (e.message || e));
    }
  }

  function parseFrontmatter(text) {
    var lines = String(text || '').replace(/\r\n/g, '\n').split('\n');
    if (!/^---\s*$/.test(lines[0] || '')) return {};
    var out = {};
    for (var i = 1; i < lines.length; i++) {
      if (/^---\s*$/.test(lines[i])) break;
      var m = /^([a-zA-Z_][a-zA-Z0-9_]*)\s*:\s*(.*)$/.exec(lines[i]);
      if (m) out[m[1]] = m[2].trim().replace(/^["']|["']$/g, '');
    }
    return out;
  }

  async function renderOverlayFilesList() {
    var host = $('ge-overlay-files');
    if (!host) return;
    try {
      var snap = await firebridge.db().collection('grantDrafts').doc(state.grantId).collection('overlays').get();
      var docs = snap.docs.map(function (d) { return Object.assign({ id: d.id }, d.data()); });
      if (!docs.length) {
        host.innerHTML = '';
        return;
      }
      host.innerHTML = '<div style="font-weight:600;margin:6px 0 4px;">Uploaded overlays (' + docs.length + ')</div>'
        + docs.map(function (o) {
            var fn = (o.fileName || '(overlay)').slice(0, 28);
            var openLink = o.paperId
              ? ('<a href="/rm/pages/library-paper.html?id=' + encodeURIComponent(o.paperId) + '&draft=' + encodeURIComponent(state.grantId)
                 + '&import=' + encodeURIComponent(o.id) + '" style="font-size:10px;">open & import</a>')
              : '';
            return '<div style="margin-bottom:3px;">📎 ' + esc(fn) + ' ' + openLink + '</div>';
          }).join('');
    } catch (e) {
      console.warn('[grant-editor] overlay list failed:', e);
    }
  }

  function wireOverlayDropzone() {
    var zone = $('ge-overlay-dropzone');
    if (!zone) return;
    zone.addEventListener('dragover', function (e) {
      if (!e.dataTransfer || !Array.from(e.dataTransfer.types).includes('Files')) return;
      e.preventDefault();
      e.dataTransfer.dropEffect = 'copy';
      zone.style.borderColor = 'var(--primary,#6366f1)';
      zone.style.background = '#eef2ff';
    });
    zone.addEventListener('dragleave', function () {
      zone.style.borderColor = 'var(--border,#cbd5e1)';
      zone.style.background = '#fafbff';
    });
    zone.addEventListener('drop', function (e) {
      e.preventDefault();
      zone.style.borderColor = 'var(--border,#cbd5e1)';
      zone.style.background = '#fafbff';
      var files = Array.from(e.dataTransfer.files || []);
      var md = files.find(function (f) { return /\.(md|markdown)$/i.test(f.name); });
      if (md) uploadOverlayFile(md);
    });
    // Click to upload as a fallback.
    zone.addEventListener('click', function () {
      var inp = document.createElement('input');
      inp.type = 'file';
      inp.accept = '.md,.markdown';
      inp.addEventListener('change', function () {
        if (inp.files && inp.files[0]) uploadOverlayFile(inp.files[0]);
      });
      inp.click();
    });
  }

  /* ---- Helpers ---- */

  function numFmt(n) {
    var x = Number(n) || 0;
    return x.toLocaleString('en-US', { maximumFractionDigits: 0 });
  }

  /* ---- Boot ---- */

  async function load() {
    var gid = window.__GRANT_ID;
    if (!gid) {
      $('ge-content').innerHTML = '<div class="empty-state">Missing ?grant=&lt;id&gt;</div>';
      return;
    }
    state.grantId = gid;
    try {
      var doc = await firebridge.getDoc(COLL, gid);
      if (!doc) {
        $('ge-content').innerHTML = '<div class="empty-state">Grant draft not found.</div>';
        return;
      }
      state.doc = doc;
      state.tree = window.GrantSchemas.normalizeTree(doc.tree || window.GrantSchemas.newTree('blank', doc.title || ''));
      // Update meta UI.
      $('ge-title').value = doc.title || '';
      $('ge-title').disabled = false;
      $('ge-title').addEventListener('input', function () {
        state.doc.title = $('ge-title').value;
        scheduleSave();
      });
      $('ge-meta-mech').textContent = doc.mechanism || '—';
      $('ge-meta-agency').textContent = doc.agency || '—';
      $('ge-meta-deadline').textContent = doc.deadlineISO || '—';
      var repoIn = $('ge-meta-repo');
      if (repoIn) {
        repoIn.value = doc.repo_path || '';
        repoIn.addEventListener('input', function () {
          state.doc.repo_path = repoIn.value;
          scheduleSave();
        });
      }

      $('ge-add-section-btn').disabled = false;
      $('ge-add-section-btn').addEventListener('click', addSectionDialog);
      $('ge-attach-bio-btn').addEventListener('click', pickBiosketch);
      $('ge-attach-fac-btn').addEventListener('click', pickFacilities);
      $('ge-export-tex-btn').addEventListener('click', function () {
        if (!window.GRANT_EXPORT_TEX) { alert('LaTeX export not loaded.'); return; }
        window.GRANT_EXPORT_TEX.runExport(state.doc, state.tree);
      });
      $('ge-print-btn').addEventListener('click', function () { window.print(); });

      var linkBtn = $('ge-link-paper-btn');
      if (linkBtn) linkBtn.addEventListener('click', pickPaperToLink);
      wireOverlayDropzone();

      renderOutline();
      renderAttachedList();
      renderLinkedPapers();
      renderOverlayFilesList();
      if (state.tree.sections.length) {
        setActiveSection(state.tree.sections[0].id);
      } else {
        $('ge-content').innerHTML = '<div class="empty-state">No sections yet. Click + Add section.</div>';
      }
    } catch (e) {
      console.error('[grant-editor] load failed:', e);
      $('ge-content').innerHTML = '<div class="empty-state">Failed to load: ' + esc(e.message) + '</div>';
    }
  }

  firebridge.onAuth(function (user) {
    if (!user) {
      $('ge-content').innerHTML = '<div class="empty-state">Sign in to edit grants.</div>';
      return;
    }
    load();
  });
})();
