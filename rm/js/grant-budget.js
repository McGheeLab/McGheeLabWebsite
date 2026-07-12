/* grant-budget.js — V3.180.
 *
 * Budget editor modal mounted by the grant editor. Reads/writes
 * grantDrafts/{grantId}/budget/{year} (one doc per project year Y1..Y5),
 * uses GrantBudgetModel for pure calc, and writes a denormalized summary
 * back to grantDrafts/{grantId}.budgetSummary so list views can show a
 * total without loading every year doc.
 *
 * Public API: window.GrantBudget.open({ grantId, onClose })
 */

(function () {
  'use strict';

  var COLL = 'grantDrafts';

  /* ---- helpers ---- */
  function esc(s) {
    if (s == null) return '';
    return String(s).replace(/[&<>"']/g, function (c) {
      return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c];
    });
  }
  function numFmt(n) { return (Number(n) || 0).toLocaleString('en-US', { maximumFractionDigits: 0 }); }
  function numInp(value, onChange, opts) {
    opts = opts || {};
    var i = document.createElement('input');
    i.type = 'number';
    i.value = (value == null ? '' : String(value));
    i.step = opts.step || '1';
    i.style.cssText = 'width:' + (opts.width || '100px') + ';padding:4px 6px;border:1px solid var(--border,#ddd);border-radius:4px;font-size:13px;';
    i.addEventListener('input', function () { onChange(i.value === '' ? 0 : Number(i.value)); });
    return i;
  }
  function textInp(value, onChange, opts) {
    opts = opts || {};
    var i = document.createElement('input');
    i.type = 'text';
    i.value = value || '';
    i.placeholder = opts.placeholder || '';
    i.style.cssText = 'width:' + (opts.width || '100%') + ';padding:4px 6px;border:1px solid var(--border,#ddd);border-radius:4px;font-size:13px;';
    i.addEventListener('input', function () { onChange(i.value); });
    return i;
  }

  /* ---- state ---- */

  var state = {
    grantId: null,
    onClose: null,
    years: [],          // array of year docs, Y1..Yn
    activeYearIdx: 0,
    saveTimer: 0,
  };

  /* ---- modal ---- */

  function buildModal() {
    var existing = document.getElementById('gbudget-modal');
    if (existing) existing.remove();
    var overlay = document.createElement('div');
    overlay.id = 'gbudget-modal';
    overlay.style.cssText = 'position:fixed;inset:0;background:rgba(15,23,42,0.55);z-index:9999;display:flex;align-items:flex-start;justify-content:center;overflow-y:auto;padding:40px 16px;';

    var card = document.createElement('div');
    card.style.cssText = 'background:#fff;border-radius:8px;max-width:1100px;width:100%;padding:18px;box-shadow:0 8px 32px rgba(0,0,0,0.2);';
    overlay.appendChild(card);

    var head = document.createElement('div');
    head.style.cssText = 'display:flex;align-items:center;gap:8px;margin-bottom:12px;';
    head.innerHTML = '<h2 style="margin:0;font-size:18px;flex:1 1 auto;">Budget</h2>';
    var closeBtn = document.createElement('button');
    closeBtn.className = 'btn';
    closeBtn.textContent = 'Close';
    closeBtn.addEventListener('click', closeModal);
    head.appendChild(closeBtn);
    card.appendChild(head);

    var yearTabs = document.createElement('div');
    yearTabs.id = 'gbudget-tabs';
    yearTabs.style.cssText = 'display:flex;gap:4px;margin-bottom:12px;flex-wrap:wrap;';
    card.appendChild(yearTabs);

    var body = document.createElement('div');
    body.id = 'gbudget-body';
    card.appendChild(body);

    var foot = document.createElement('div');
    foot.id = 'gbudget-foot';
    foot.style.cssText = 'margin-top:14px;padding-top:10px;border-top:1px solid var(--border,#e5e7eb);';
    card.appendChild(foot);

    overlay.addEventListener('click', function (e) { if (e.target === overlay) closeModal(); });
    document.body.appendChild(overlay);
    return overlay;
  }

  async function loadYears() {
    var snap = await firebridge.db().collection(COLL).doc(state.grantId).collection('budget').get();
    var byYear = {};
    snap.docs.forEach(function (d) {
      var data = d.data();
      byYear[d.id] = Object.assign({ year: d.id }, data);
    });
    // Always materialize Y1..Y5 (unsaved Y2..Y5 just stay locally until edited).
    var years = [];
    ['Y1', 'Y2', 'Y3', 'Y4', 'Y5'].forEach(function (y, idx) {
      var existing = byYear[y];
      if (existing) years.push(existing);
      else years.push(window.GrantBudgetModel.emptyYear(y));
    });
    state.years = years;
  }

  function renderTabs() {
    var host = document.getElementById('gbudget-tabs');
    host.innerHTML = '';
    state.years.forEach(function (y, idx) {
      var btn = document.createElement('button');
      btn.className = 'btn' + (state.activeYearIdx === idx ? ' btn-primary' : '');
      btn.style.fontSize = '13px';
      btn.textContent = y.year;
      btn.addEventListener('click', function () {
        state.activeYearIdx = idx;
        renderTabs();
        renderBody();
        renderFoot();
      });
      host.appendChild(btn);
    });

    var modeWrap = document.createElement('span');
    modeWrap.style.cssText = 'margin-left:16px;display:inline-flex;gap:6px;align-items:center;font-size:13px;';
    modeWrap.innerHTML = '<span>Mode:</span>';
    ['modular', 'detailed'].forEach(function (m) {
      var lbl = document.createElement('label');
      lbl.style.cssText = 'display:inline-flex;align-items:center;gap:4px;';
      var rb = document.createElement('input');
      rb.type = 'radio';
      rb.name = 'gbudget-mode';
      rb.value = m;
      if ((state.years[state.activeYearIdx].mode || 'detailed') === m) rb.checked = true;
      rb.addEventListener('change', function () {
        state.years[state.activeYearIdx].mode = m;
        renderBody();
        renderFoot();
        scheduleSave(state.activeYearIdx);
      });
      lbl.appendChild(rb);
      lbl.appendChild(document.createTextNode(m));
      modeWrap.appendChild(lbl);
    });
    host.appendChild(modeWrap);
  }

  function renderBody() {
    var host = document.getElementById('gbudget-body');
    host.innerHTML = '';
    var year = state.years[state.activeYearIdx];
    if (year.mode === 'modular') {
      renderModularBody(host, year);
    } else {
      renderDetailedBody(host, year);
    }
  }

  function renderModularBody(host, year) {
    var card = document.createElement('div');
    card.style.cssText = 'padding:14px;border:1px solid var(--border,#e5e7eb);border-radius:6px;background:#fafbff;';
    card.innerHTML = '<p style="margin:0 0 8px;font-size:13px;color:var(--text-muted,#6b7280);">'
      + 'Modular budgets request direct costs in $25,000 increments (NIH modular ceiling is $250,000/yr direct).'
      + '</p>';
    var lbl = document.createElement('label');
    lbl.style.cssText = 'font-weight:600;display:block;margin-bottom:4px;';
    lbl.textContent = 'Direct costs requested ($)';
    card.appendChild(lbl);
    var inp = numInp(year.modularAmount, function (v) {
      year.modularAmount = v;
      renderFoot();
      scheduleSave(state.activeYearIdx);
    }, { step: '25000', width: '160px' });
    card.appendChild(inp);

    var note = document.createElement('div');
    note.style.cssText = 'margin-top:10px;font-size:12px;color:var(--text-muted,#6b7280);';
    note.innerHTML = 'Round to the nearest $25,000. Indirect costs apply on top per your institution\'s F&amp;A rate.';
    card.appendChild(note);
    host.appendChild(card);
  }

  function sectionCard(title, child) {
    var card = document.createElement('div');
    card.style.cssText = 'border:1px solid var(--border,#e5e7eb);border-radius:6px;padding:10px 12px;margin-bottom:10px;background:#fff;';
    var head = document.createElement('div');
    head.style.cssText = 'font-weight:600;margin-bottom:6px;';
    head.textContent = title;
    card.appendChild(head);
    card.appendChild(child);
    return card;
  }

  function renderDetailedBody(host, year) {
    /* Personnel */
    var personnelHost = document.createElement('div');
    var pTable = document.createElement('table');
    pTable.style.cssText = 'width:100%;border-collapse:collapse;font-size:13px;';
    pTable.innerHTML = '<thead><tr>'
      + '<th style="text-align:left;padding:4px 6px;border-bottom:1px solid var(--border);">Name</th>'
      + '<th style="text-align:left;padding:4px 6px;border-bottom:1px solid var(--border);">Role</th>'
      + '<th style="padding:4px 6px;border-bottom:1px solid var(--border);">Base salary</th>'
      + '<th style="padding:4px 6px;border-bottom:1px solid var(--border);">Acad %</th>'
      + '<th style="padding:4px 6px;border-bottom:1px solid var(--border);">Sum %</th>'
      + '<th style="padding:4px 6px;border-bottom:1px solid var(--border);">Cal %</th>'
      + '<th style="padding:4px 6px;border-bottom:1px solid var(--border);">Fringe</th>'
      + '<th style="padding:4px 6px;border-bottom:1px solid var(--border);">Salary+Fringe</th>'
      + '<th style="border-bottom:1px solid var(--border);"></th>'
      + '</tr></thead>';
    var pBody = document.createElement('tbody');
    (year.personnel || []).forEach(function (row, idx) {
      var tr = document.createElement('tr');
      tr.appendChild(td(textInp(row.name, function (v) { row.name = v; recompute(); }, { width: '140px' })));
      tr.appendChild(td(textInp(row.role, function (v) { row.role = v; }, { width: '120px' })));
      tr.appendChild(td(numInp(row.baseSalary, function (v) { row.baseSalary = v; recompute(); }, { step: '1000' })));
      tr.appendChild(td(numInp(row.effortAcademicPct, function (v) { row.effortAcademicPct = v; recompute(); }, { width: '70px' })));
      tr.appendChild(td(numInp(row.effortSummerPct,   function (v) { row.effortSummerPct = v;   recompute(); }, { width: '70px' })));
      tr.appendChild(td(numInp(row.effortCalendarPct, function (v) { row.effortCalendarPct = v; recompute(); }, { width: '70px' })));

      var fringeSel = document.createElement('select');
      fringeSel.style.cssText = 'padding:4px;border:1px solid var(--border);border-radius:4px;font-size:13px;';
      ['academic', 'summer', 'postdoc', 'student'].forEach(function (k) {
        var opt = document.createElement('option');
        opt.value = k; opt.textContent = k;
        if ((row.fringeKind || 'academic') === k) opt.selected = true;
        fringeSel.appendChild(opt);
      });
      fringeSel.addEventListener('change', function () { row.fringeKind = fringeSel.value; recompute(); });
      tr.appendChild(td(fringeSel));

      var totalTd = document.createElement('td');
      totalTd.dataset.col = 'persontotal';
      totalTd.style.padding = '4px 6px';
      totalTd.style.borderBottom = '1px solid var(--border)';
      totalTd.style.textAlign = 'right';
      var pc = window.GrantBudgetModel.personnelCost(row, year.fringeRates, year.escalation, state.activeYearIdx);
      totalTd.textContent = '$' + numFmt(pc.total);
      tr.appendChild(totalTd);

      var rmTd = document.createElement('td');
      var rm = document.createElement('button');
      rm.className = 'btn pe-block-action';
      rm.textContent = '×';
      rm.addEventListener('click', function (e) {
        e.preventDefault();
        year.personnel.splice(idx, 1);
        renderBody();
        renderFoot();
        scheduleSave(state.activeYearIdx);
      });
      rmTd.appendChild(rm);
      tr.appendChild(rmTd);

      pBody.appendChild(tr);
    });
    pTable.appendChild(pBody);
    personnelHost.appendChild(pTable);
    var addP = document.createElement('button');
    addP.className = 'btn';
    addP.style.marginTop = '4px';
    addP.textContent = '+ Add person';
    addP.addEventListener('click', function (e) {
      e.preventDefault();
      year.personnel = year.personnel || [];
      year.personnel.push({
        name: '', role: '', baseSalary: 0,
        effortAcademicPct: 0, effortSummerPct: 0, effortCalendarPct: 0,
        fringeKind: 'academic', notes: '',
      });
      renderBody();
      renderFoot();
      scheduleSave(state.activeYearIdx);
    });
    personnelHost.appendChild(addP);
    host.appendChild(sectionCard('Personnel', personnelHost));

    /* Equipment */
    host.appendChild(sectionCard('Equipment (>$5k typically excluded from MTDC)',
      lineItemTable(year.equipment || [], [
        { key: 'item', label: 'Item', kind: 'text', width: '200px' },
        { key: 'vendor', label: 'Vendor', kind: 'text', width: '140px' },
        { key: 'cost', label: 'Cost ($)', kind: 'num', width: '120px' },
        { key: 'justification', label: 'Justification', kind: 'text', width: '300px' },
      ], function (arr) { year.equipment = arr; scheduleSave(state.activeYearIdx); renderFoot(); })));

    /* Supplies */
    host.appendChild(sectionCard('Supplies',
      lineItemTable(year.supplies || [], [
        { key: 'category', label: 'Category', kind: 'text', width: '180px' },
        { key: 'cost', label: 'Cost ($)', kind: 'num', width: '120px' },
        { key: 'notes', label: 'Notes', kind: 'text', width: '320px' },
      ], function (arr) { year.supplies = arr; scheduleSave(state.activeYearIdx); renderFoot(); })));

    /* Travel */
    host.appendChild(sectionCard('Travel',
      lineItemTable(year.travel || [], [
        { key: 'purpose', label: 'Purpose', kind: 'text', width: '220px' },
        { key: 'destinationKind', label: 'Destination', kind: 'select', options: ['domestic', 'international'], width: '140px' },
        { key: 'cost', label: 'Cost ($)', kind: 'num', width: '120px' },
        { key: 'attendees', label: 'Attendees', kind: 'text', width: '160px' },
      ], function (arr) { year.travel = arr; scheduleSave(state.activeYearIdx); renderFoot(); })));

    /* Consultants */
    host.appendChild(sectionCard('Consultants',
      lineItemTable(year.consultants || [], [
        { key: 'name', label: 'Name', kind: 'text', width: '180px' },
        { key: 'rate', label: 'Day rate ($)', kind: 'num', width: '120px' },
        { key: 'days', label: 'Days', kind: 'num', width: '80px' },
      ], function (arr) { year.consultants = arr; scheduleSave(state.activeYearIdx); renderFoot(); })));

    /* Subawards */
    host.appendChild(sectionCard('Subawards',
      lineItemTable(year.subawards || [], [
        { key: 'institution', label: 'Institution', kind: 'text', width: '200px' },
        { key: 'pi', label: 'Sub PI', kind: 'text', width: '160px' },
        { key: 'directs', label: 'Directs ($)', kind: 'num', width: '120px' },
        { key: 'indirects', label: 'Indirects ($)', kind: 'num', width: '120px' },
      ], function (arr) { year.subawards = arr; scheduleSave(state.activeYearIdx); renderFoot(); })));

    /* Other direct */
    host.appendChild(sectionCard('Other direct costs',
      lineItemTable(year.otherDirect || [], [
        { key: 'label', label: 'Label', kind: 'text', width: '240px' },
        { key: 'cost', label: 'Cost ($)', kind: 'num', width: '120px' },
      ], function (arr) { year.otherDirect = arr; scheduleSave(state.activeYearIdx); renderFoot(); })));

    /* Publications + Settings */
    var settings = document.createElement('div');
    settings.style.cssText = 'display:grid;grid-template-columns:repeat(auto-fit, minmax(220px, 1fr));gap:10px;';
    settings.appendChild(settingPair('Publications budget ($)',
      numInp(year.publications, function (v) { year.publications = v; renderFoot(); scheduleSave(state.activeYearIdx); }, { step: '100' })));
    settings.appendChild(settingPair('IDC rate (e.g. 0.547 for 54.7%)',
      numInp(year.idc && year.idc.rate, function (v) { year.idc = year.idc || {}; year.idc.rate = v; renderFoot(); scheduleSave(state.activeYearIdx); }, { step: '0.001' })));
    var basisSel = document.createElement('select');
    basisSel.style.cssText = 'padding:4px;border:1px solid var(--border);border-radius:4px;';
    ['MTDC', 'TDC'].forEach(function (b) {
      var opt = document.createElement('option');
      opt.value = b; opt.textContent = b;
      if ((year.idc && year.idc.basis) === b) opt.selected = true;
      basisSel.appendChild(opt);
    });
    basisSel.addEventListener('change', function () { year.idc = year.idc || {}; year.idc.basis = basisSel.value; renderFoot(); scheduleSave(state.activeYearIdx); });
    settings.appendChild(settingPair('IDC basis', basisSel));
    settings.appendChild(settingPair('Annual escalation (e.g. 0.03)',
      numInp(year.escalation, function (v) { year.escalation = v; renderFoot(); scheduleSave(state.activeYearIdx); }, { step: '0.005' })));
    host.appendChild(sectionCard('Settings', settings));

    function recompute() {
      // Update the right-most "Salary+Fringe" cell for each personnel row.
      var rows = pBody.querySelectorAll('tr');
      (year.personnel || []).forEach(function (row, i) {
        var tr = rows[i];
        if (!tr) return;
        var pc = window.GrantBudgetModel.personnelCost(row, year.fringeRates, year.escalation, state.activeYearIdx);
        var totalCell = tr.querySelector('[data-col="persontotal"]');
        if (totalCell) totalCell.textContent = '$' + numFmt(pc.total);
      });
      renderFoot();
      scheduleSave(state.activeYearIdx);
    }
  }

  function settingPair(labelText, child) {
    var wrap = document.createElement('div');
    var lbl = document.createElement('label');
    lbl.style.cssText = 'display:block;font-size:11px;color:var(--text-muted,#6b7280);margin-bottom:2px;';
    lbl.textContent = labelText;
    wrap.appendChild(lbl);
    wrap.appendChild(child);
    return wrap;
  }

  function td(child) {
    var c = document.createElement('td');
    c.style.padding = '4px 6px';
    c.style.borderBottom = '1px solid var(--border)';
    c.appendChild(child);
    return c;
  }

  function lineItemTable(rows, columns, onChange) {
    var wrap = document.createElement('div');
    var tbl = document.createElement('table');
    tbl.style.cssText = 'width:100%;border-collapse:collapse;font-size:13px;';
    var thead = document.createElement('thead');
    var headRow = document.createElement('tr');
    columns.forEach(function (col) {
      var th = document.createElement('th');
      th.style.cssText = 'text-align:left;padding:4px 6px;border-bottom:1px solid var(--border);';
      th.textContent = col.label;
      headRow.appendChild(th);
    });
    headRow.appendChild(document.createElement('th'));
    thead.appendChild(headRow);
    tbl.appendChild(thead);
    var tbody = document.createElement('tbody');
    rows.forEach(function (r, idx) {
      var tr = document.createElement('tr');
      columns.forEach(function (col) {
        var cell;
        if (col.kind === 'select') {
          var sel = document.createElement('select');
          sel.style.cssText = 'padding:4px;border:1px solid var(--border);border-radius:4px;font-size:13px;';
          (col.options || []).forEach(function (opt) {
            var o = document.createElement('option');
            o.value = opt; o.textContent = opt;
            if (r[col.key] === opt) o.selected = true;
            sel.appendChild(o);
          });
          sel.addEventListener('change', function () { r[col.key] = sel.value; onChange(rows); });
          cell = sel;
        } else if (col.kind === 'num') {
          cell = numInp(r[col.key], function (v) { r[col.key] = v; onChange(rows); }, { width: col.width || '100px' });
        } else {
          cell = textInp(r[col.key], function (v) { r[col.key] = v; onChange(rows); }, { width: col.width || '160px' });
        }
        tr.appendChild(td(cell));
      });
      var rmTd = document.createElement('td');
      var rm = document.createElement('button');
      rm.className = 'btn pe-block-action';
      rm.textContent = '×';
      rm.addEventListener('click', function (e) {
        e.preventDefault();
        rows.splice(idx, 1);
        onChange(rows);
        renderBody();
        renderFoot();
      });
      rmTd.appendChild(rm);
      tr.appendChild(rmTd);
      tbody.appendChild(tr);
    });
    tbl.appendChild(tbody);
    wrap.appendChild(tbl);
    var addBtn = document.createElement('button');
    addBtn.className = 'btn';
    addBtn.style.marginTop = '4px';
    addBtn.textContent = '+ Add row';
    addBtn.addEventListener('click', function (e) {
      e.preventDefault();
      var fresh = {};
      columns.forEach(function (col) { fresh[col.key] = col.kind === 'num' ? 0 : ''; });
      rows.push(fresh);
      onChange(rows);
      renderBody();
      renderFoot();
    });
    wrap.appendChild(addBtn);
    return wrap;
  }

  function renderFoot() {
    var year = state.years[state.activeYearIdx];
    var summary = window.GrantBudgetModel.yearSummary(year, state.activeYearIdx);
    var grand = window.GrantBudgetModel.aggregateYears(state.years);

    var host = document.getElementById('gbudget-foot');
    host.innerHTML = ''
      + '<div style="display:grid;grid-template-columns:1fr 1fr;gap:16px;">'
      +   '<div>'
      +     '<div style="font-size:13px;color:var(--text-muted,#6b7280);">This year (' + esc(year.year) + ')</div>'
      +     '<div style="font-size:16px;margin-top:4px;">'
      +       '<strong>Direct:</strong> $' + numFmt(summary.totals.directs)
      +     '</div>'
      +     '<div style="font-size:13px;color:var(--text-muted,#6b7280);">MTDC base: $' + numFmt(summary.mtdcBase) + '</div>'
      +     '<div style="font-size:13px;color:var(--text-muted,#6b7280);">Indirects @ ' + ((year.idc && year.idc.rate) || 0) * 100 + '% ' + ((year.idc && year.idc.basis) || 'MTDC') + ': $' + numFmt(summary.indirects) + '</div>'
      +     '<div style="font-size:18px;margin-top:4px;"><strong>Year total: $' + numFmt(summary.total) + '</strong></div>'
      +   '</div>'
      +   '<div>'
      +     '<div style="font-size:13px;color:var(--text-muted,#6b7280);">All years</div>'
      +     '<div style="font-size:16px;margin-top:4px;"><strong>Direct:</strong> $' + numFmt(grand.directs) + '</div>'
      +     '<div style="font-size:13px;color:var(--text-muted,#6b7280);">Indirect: $' + numFmt(grand.indirects) + '</div>'
      +     '<div style="font-size:18px;margin-top:4px;color:var(--primary,#1d4ed8);"><strong>Grand total: $' + numFmt(grand.total) + '</strong></div>'
      +   '</div>'
      + '</div>';
  }

  /* ---- Persistence (per-year doc + summary back to parent) ---- */

  function scheduleSave(idx) {
    clearTimeout(state.saveTimer);
    state.saveTimer = setTimeout(function () { persistYear(idx); }, 700);
  }

  async function persistYear(idx) {
    var year = state.years[idx];
    if (!year || !state.grantId) return;
    try {
      var stamp = firebase.firestore.FieldValue.serverTimestamp();
      var summary = window.GrantBudgetModel.yearSummary(year, idx);
      var payload = Object.assign({}, year, {
        computedTotals: {
          directs: summary.totals.directs,
          mtdcBase: summary.mtdcBase,
          indirects: summary.indirects,
          total: summary.total,
        },
        updatedAt: stamp,
      });
      await firebridge.db().collection(COLL).doc(state.grantId).collection('budget').doc(year.year).set(payload, { merge: true });
      var grand = window.GrantBudgetModel.aggregateYears(state.years);
      await firebridge.db().collection(COLL).doc(state.grantId).update({
        budgetSummary: grand,
        updatedAt: stamp,
      });
    } catch (e) {
      console.error('[grant-budget] save failed:', e);
    }
  }

  function closeModal() {
    var overlay = document.getElementById('gbudget-modal');
    if (overlay) overlay.remove();
    if (state.onClose) {
      var grand = window.GrantBudgetModel.aggregateYears(state.years);
      state.onClose(grand);
    }
  }

  /* ---- Public ---- */

  async function open(opts) {
    state.grantId = opts.grantId;
    state.onClose = opts.onClose || null;
    state.activeYearIdx = 0;
    buildModal();
    try {
      await loadYears();
      renderTabs();
      renderBody();
      renderFoot();
    } catch (e) {
      console.error('[grant-budget] open failed:', e);
      alert('Failed to load budget: ' + e.message);
      closeModal();
    }
  }

  window.GrantBudget = { open: open };
})();
