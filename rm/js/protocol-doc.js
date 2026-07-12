/* protocol-doc.js — V3.315 — read-only document view for protocols.
 *
 * Third mode of pages/protocols.html (`?protocol=<id>&view=doc`).
 * Renders the protocol's **projected JSON tree** (protocols/{id}.tree —
 * kept fresh by the editor's flushTreeNow) into a print-ready document:
 * branded masthead, numbered stage headers, callouts, materials tables,
 * figures, and live formula calculators. No Yjs, no writes; formula
 * inputs recompute session-locally via ProtocolFormulas.buildSymbolTable
 * overrides. Browser print-to-PDF (the 🖨 button) is the export path —
 * @media print rules live in css/protocol-doc.css.
 *
 * Same access gate as the editor: signed in + lab member.
 */

(function () {
  var protocolId = window.__PROTOCOL_ID;
  if (window.__PROTOCOL_MODE !== 'doc' || !protocolId) return;

  var statusEl = document.getElementById('prd-status');
  var docEl    = document.getElementById('prd-doc');
  var backEl   = document.getElementById('prd-back');
  var printBtn = document.getElementById('prd-print');

  var state = {
    doc: null,        // hydrated protocol doc
    tree: null,       // doc.tree (plain JSON)
    formulas: [],     // plain-tree formula entries (collectFormulas shape)
    table: {},        // current symbol table
    overrides: {},    // session-local input values
    math: null,
    brand: null,      // {name, sub} from labConfig/branding (best-effort)
    refreshers: [],   // closures re-run after every recompute
  };

  function escapeHtml(s) {
    return String(s || '').replace(/[&<>"']/g, function (c) {
      return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c];
    });
  }

  function setStatus(text) {
    statusEl.textContent = text || '';
    statusEl.hidden = !text;
  }

  /* ── Formula collection over the PLAIN tree ─────────────────────
   * Mirrors ProtocolFormulas.collectFormulas (which walks Y types) so
   * buildSymbolTable gets the same entry shape. */
  function collectPlainFormulas(tree) {
    var out = [];
    ((tree && tree.sections) || []).forEach(function (sec) {
      (sec.children || []).forEach(function (b) {
        if (!b) return;
        if (b.kind === 'formula') {
          var a = b.attrs || {};
          out.push({
            blockId: b.id || '',
            label: a.label || '',
            description: a.description || '',
            expression: a.expression || '',
            variables: Array.isArray(a.variables) ? a.variables : [],
            output: a.output || null,
          });
        } else if (b.kind === 'calculator') {
          // V3.318 — calculator inputs/outputs feed the same table.
          out.push.apply(out, window.ProtocolFormulas.calculatorToFormulaEntries(b));
        } else if (b.kind === 'builder') {
          // V3.324 — builder params feed the same table.
          out.push.apply(out, window.ProtocolFormulas.builderToFormulaEntries(b));
        }
      });
    });
    return out;
  }

  function recompute() {
    if (!state.math) return;
    state.table = window.ProtocolFormulas.buildSymbolTable(
      state.formulas, state.math, state.overrides);
    state.refreshers.forEach(function (fn) { try { fn(); } catch (e) {} });
  }

  function prose(raw) {
    return window.ProtocolFormulas.renderProse(raw, state.table);
  }

  /* Register an element whose innerHTML is prose of `raw` — re-rendered
   * after every recompute (and after inventory load). */
  function bindProse(el, raw) {
    var render = function () { el.innerHTML = prose(raw); };
    render();
    state.refreshers.push(render);
  }

  function symValueHtml(name) {
    var sym = state.table[name];
    return escapeHtml(sym ? window.ProtocolFormulas.formatSymbolValue(sym) : '?');
  }

  /* ── Block renderers ───────────────────────────────────────────── */

  function renderStep(b, num) {
    var el = document.createElement('div');
    el.className = 'prd-step';
    var badge = document.createElement('div');
    badge.className = 'prd-step-num';
    badge.textContent = String(num);
    el.appendChild(badge);
    var body = document.createElement('div');
    body.className = 'prd-step-body prd-prose';
    bindProse(body, b.body || '');
    el.appendChild(body);
    return el;
  }

  var CALLOUT_META = {
    critical: { label: 'Critical', icon: '⚠' },
    note:     { label: 'Note',     icon: 'ℹ' },
    assume:   { label: 'Assumption', icon: '⚙' },
    timing:   { label: 'Timing',   icon: '⏱' },
  };

  function calloutType(b) {
    if (b.kind === 'callout') {
      return CALLOUT_META[(b.attrs || {}).type] ? b.attrs.type : 'note';
    }
    if (b.kind === 'safety') return 'critical';
    return 'note';
  }

  function renderCallout(b) {
    var type = calloutType(b);
    var meta = CALLOUT_META[type];
    if (type === 'timing') {
      // The gold standard's timing pill — inline, not a box.
      var pill = document.createElement('div');
      pill.className = 'prd-timing';
      var inner = document.createElement('span');
      inner.className = 'prd-timing-pill';
      var label = document.createElement('span');
      label.className = 'prd-timing-icon';
      label.textContent = meta.icon;
      inner.appendChild(label);
      var body = document.createElement('span');
      body.className = 'prd-prose';
      bindProse(body, b.body || '');
      inner.appendChild(body);
      pill.appendChild(inner);
      return pill;
    }
    var el = document.createElement('div');
    el.className = 'prd-callout prd-callout-' + type;
    var head = document.createElement('div');
    head.className = 'prd-callout-label';
    head.textContent = meta.icon + ' ' + meta.label;
    el.appendChild(head);
    var body2 = document.createElement('div');
    body2.className = 'prd-callout-body prd-prose';
    bindProse(body2, b.body || '');
    el.appendChild(body2);
    return el;
  }

  function renderMaterials(b) {
    var el = document.createElement('div');
    el.className = 'prd-materials';
    var head = document.createElement('div');
    head.className = 'prd-materials-label';
    head.textContent = 'Materials';
    el.appendChild(head);
    var table = document.createElement('table');
    table.className = 'prd-table';
    table.innerHTML = '<thead><tr><th class="prd-col-num">Qty</th><th>Unit</th><th>Item</th></tr></thead>';
    var tbody = document.createElement('tbody');
    var rows = ((b.attrs || {}).rows) || [];
    function renderRows() {
      tbody.innerHTML = '';
      rows.forEach(function (r) {
        var label = r.free_text || '';
        if (r.item_ref && window.PROTOCOL_INVENTORY) {
          var entry = window.PROTOCOL_INVENTORY.findById(r.item_ref);
          if (entry) label = window.PROTOCOL_INVENTORY.formatLabel(entry);
        }
        if (!label && !r.qty && !r.unit) return;
        var tr = document.createElement('tr');
        tr.innerHTML = '<td class="prd-col-num prd-mono">' + escapeHtml(r.qty || '') +
          '</td><td>' + escapeHtml(r.unit || '') +
          '</td><td>' + (r.item_ref ? '🧪 ' : '') + escapeHtml(label) + '</td>';
        tbody.appendChild(tr);
      });
    }
    renderRows();
    state.refreshers.push(renderRows); // inventory load refresh reuses the bus
    table.appendChild(tbody);
    el.appendChild(table);
    return el;
  }

  function renderFigure(b) {
    var a = b.attrs || {};
    if (!a.image_url && !(b.body || '').trim()) return null;
    var el = document.createElement('figure');
    el.className = 'prd-figure';
    if (a.image_url) {
      var img = document.createElement('img');
      img.src = a.image_url;
      img.alt = a.image_alt || '';
      var pct = parseInt(a.width_pct, 10) || 100;
      img.style.maxWidth = pct + '%';
      el.appendChild(img);
    }
    if ((b.body || '').trim()) {
      var cap = document.createElement('figcaption');
      cap.className = 'prd-prose';
      bindProse(cap, b.body);
      el.appendChild(cap);
    }
    return el;
  }

  function renderHeading(b, stageCode) {
    var a = b.attrs || {};
    var el = document.createElement('div');
    el.className = 'prd-stage' + (a.rule === false ? ' prd-stage-norule' : '');
    var code = (a.code || '').trim();
    var h = document.createElement('h2');
    h.className = 'prd-stage-title';
    if (code) {
      var codeSpan = document.createElement('span');
      codeSpan.className = 'prd-stage-code';
      codeSpan.textContent = code;
      h.appendChild(codeSpan);
    }
    var t = document.createElement('span');
    t.className = 'prd-prose';
    bindProse(t, b.body || '');
    h.appendChild(t);
    el.appendChild(h);
    return el;
  }

  /* Live calculator card for a formula block. Inputs are editable and
   * recompute the whole document's symbol table session-locally. */
  function renderFormula(b) {
    var a = b.attrs || {};
    var el = document.createElement('div');
    el.className = 'prd-calc';

    if (a.label) {
      var head = document.createElement('div');
      head.className = 'prd-calc-label';
      head.textContent = a.label;
      el.appendChild(head);
    }
    if (a.description) {
      var desc = document.createElement('div');
      desc.className = 'prd-calc-desc prd-prose';
      bindProse(desc, a.description);
      el.appendChild(desc);
    }

    var vars = Array.isArray(a.variables) ? a.variables : [];
    if (vars.length) {
      var grid = document.createElement('div');
      grid.className = 'prd-calc-inputs';
      vars.forEach(function (v) {
        if (!v || !v.name) return;
        var row = document.createElement('label');
        row.className = 'prd-calc-input-row';
        var lab = document.createElement('span');
        lab.className = 'prd-calc-input-label';
        lab.textContent = v.label || v.name;
        row.appendChild(lab);
        var inp = document.createElement('input');
        inp.type = 'number';
        inp.step = 'any';
        var dflt = (typeof v.default === 'number') ? v.default : parseFloat(v.default);
        if (isFinite(dflt)) inp.value = String(dflt);
        inp.addEventListener('input', function () {
          var n = parseFloat(inp.value);
          if (isFinite(n)) state.overrides[v.name] = n;
          else delete state.overrides[v.name];
          recompute();
        });
        row.appendChild(inp);
        if (v.unit) {
          var unit = document.createElement('span');
          unit.className = 'prd-calc-input-unit';
          unit.textContent = v.unit;
          row.appendChild(unit);
        }
        grid.appendChild(row);
      });
      el.appendChild(grid);
    }

    var outName = a.output && a.output.name;
    if (outName) {
      var out = document.createElement('div');
      out.className = 'prd-calc-out';
      var refresh = function () {
        var sym = state.table[outName];
        var err = sym && sym.error;
        out.innerHTML =
          '<span class="prd-calc-out-value' + (err ? ' prd-calc-out-error' : '') + '">' +
            (err ? '⚠ ' + escapeHtml(sym.error) : symValueHtml(outName)) +
          '</span>' +
          '<span class="prd-calc-out-label">' +
            escapeHtml((a.output.label || outName)) +
          '</span>';
      };
      refresh();
      state.refreshers.push(refresh);
      el.appendChild(out);
    }
    return el;
  }

  /* ── V3.318 — calculator: slider/number inputs, hero cards, computed
   * table over a named dataset. All values session-local. */

  function _fmtNum(v, decimals) {
    if (typeof v !== 'number' || !isFinite(v)) return String(v);
    var dec = (typeof decimals === 'number') ? decimals : 3;
    return String(parseFloat(v.toFixed(dec)));
  }

  function renderCalculator(b) {
    var a = b.attrs || {};
    var el = document.createElement('div');
    el.className = 'prd-calc prd-calculator';

    if (a.label) {
      var head = document.createElement('div');
      head.className = 'prd-calc-label';
      head.textContent = a.label;
      el.appendChild(head);
    }
    if (a.description) {
      var desc = document.createElement('div');
      desc.className = 'prd-calc-desc prd-prose';
      bindProse(desc, a.description);
      el.appendChild(desc);
    }

    /* Inputs — slider rows with live value, or plain number rows. */
    var inputs = (Array.isArray(a.inputs) ? a.inputs : []).filter(function (v) {
      return v && v.name;
    });
    if (inputs.length) {
      var grid = document.createElement('div');
      grid.className = 'prd-calc-controls';
      inputs.forEach(function (v) {
        var row = document.createElement('div');
        row.className = 'prd-calc-control';
        var top = document.createElement('div');
        top.className = 'prd-calc-control-top';
        var lab = document.createElement('span');
        lab.className = 'prd-calc-input-label';
        lab.textContent = v.label || v.name;
        top.appendChild(lab);
        var valEl = document.createElement('span');
        valEl.className = 'prd-calc-control-value';
        top.appendChild(valEl);
        row.appendChild(top);

        var dflt = (typeof v.default === 'number') ? v.default : parseFloat(v.default);
        if (!isFinite(dflt)) dflt = 0;

        function showVal(n) {
          valEl.textContent = _fmtNum(n) + (v.unit ? ' ' + v.unit : '');
        }
        showVal(state.overrides[v.name] !== undefined ? state.overrides[v.name] : dflt);

        var inp = document.createElement('input');
        if ((v.widget || 'slider') === 'slider') {
          inp.type = 'range';
          inp.min = (typeof v.min === 'number') ? String(v.min) : '0';
          inp.max = (typeof v.max === 'number') ? String(v.max) : '100';
          inp.step = (typeof v.step === 'number') ? String(v.step) : 'any';
        } else {
          inp.type = 'number';
          if (typeof v.min === 'number') inp.min = String(v.min);
          if (typeof v.max === 'number') inp.max = String(v.max);
          inp.step = (typeof v.step === 'number') ? String(v.step) : 'any';
        }
        inp.value = String(state.overrides[v.name] !== undefined ? state.overrides[v.name] : dflt);
        inp.addEventListener('input', function () {
          var n = parseFloat(inp.value);
          if (isFinite(n)) { state.overrides[v.name] = n; showVal(n); }
          else delete state.overrides[v.name];
          recompute();
        });
        row.appendChild(inp);

        if (v.rangeHint) {
          var hint = document.createElement('div');
          hint.className = 'prd-calc-control-hint';
          hint.textContent = v.rangeHint;
          row.appendChild(hint);
        }
        grid.appendChild(row);
      });
      el.appendChild(grid);
    }

    /* Hero cards. */
    var outputs = (Array.isArray(a.outputs) ? a.outputs : []).filter(function (o) {
      return o && o.name;
    });
    if (outputs.length) {
      var cards = document.createElement('div');
      cards.className = 'prd-calc-cards';
      outputs.forEach(function (o) {
        var card = document.createElement('div');
        card.className = 'prd-calc-card';
        var refresh = function () {
          var sym = state.table[o.name];
          var valHtml;
          if (!sym) valHtml = '?';
          else if (sym.error) valHtml = '<span class="prd-calc-out-error">⚠</span>';
          else valHtml = escapeHtml(_fmtNum(sym.value, o.decimals));
          card.innerHTML =
            '<div class="prd-calc-card-value">' + valHtml +
              (o.unit ? '<span class="prd-calc-card-unit">' + escapeHtml(o.unit) + '</span>' : '') +
            '</div>' +
            '<div class="prd-calc-card-label">' + escapeHtml(o.label || o.name) + '</div>';
        };
        refresh();
        state.refreshers.push(refresh);
        cards.appendChild(card);
      });
      el.appendChild(cards);
    }

    /* Computed table over a named dataset. */
    var tcfg = (a.table && typeof a.table === 'object') ? a.table : null;
    if (tcfg && tcfg.dataset && Array.isArray(tcfg.columns) && tcfg.columns.length) {
      var wrap = document.createElement('div');
      wrap.className = 'prd-calc-tablewrap';
      el.appendChild(wrap);
      var refreshTable = function () {
        wrap.innerHTML = '';
        var rows = window.ProtocolFormulas.getDataset(tcfg.dataset);
        if (!rows || !rows.length) {
          var hintEl = document.createElement('div');
          hintEl.className = 'prd-calc-control-hint';
          hintEl.textContent = 'Dataset "' + tcfg.dataset + '" is empty — configure the builder block above.';
          wrap.appendChild(hintEl);
          return;
        }
        var table = document.createElement('table');
        table.className = 'prd-table';
        var thead = document.createElement('thead');
        var trh = document.createElement('tr');
        tcfg.columns.forEach(function (c) {
          // Build via DOM (not innerHTML) so an author-supplied `align`
          // string can't break out of the attribute into markup — it
          // reaches upload unsanitized through the import JSON path.
          var th = document.createElement('th');
          th.style.textAlign = c.align || 'left';
          th.textContent = c.label || '';
          trh.appendChild(th);
        });
        thead.appendChild(trh);
        table.appendChild(thead);
        var tbody = document.createElement('tbody');
        rows.forEach(function (row) {
          var tr = document.createElement('tr');
          tcfg.columns.forEach(function (c) {
            var td = document.createElement('td');
            td.style.textAlign = c.align || 'left';
            if (c.mono) td.className = 'prd-mono';
            var res = window.ProtocolFormulas.evalExpression(
              c.expr, state.table, state.math, row);
            if (res.error) {
              td.innerHTML = '<span class="prd-calc-out-error" title="' +
                escapeHtml(res.error) + '">⚠</span>';
            } else if (typeof res.value === 'number') {
              td.textContent = _fmtNum(res.value, c.decimals);
            } else {
              td.textContent = String(res.value === undefined || res.value === null ? '' : res.value);
            }
            tr.appendChild(td);
          });
          tbody.appendChild(tr);
        });
        table.appendChild(tbody);
        wrap.appendChild(table);
      };
      refreshTable();
      state.refreshers.push(refreshTable);
    }

    return el;
  }

  /* ── V3.324 — interactive builder → named dataset ──────────────
   * Session-local assembly: sliders (with monotonic `lt` clamping),
   * segmented pickers per dim, editable option lists, add / add-all /
   * remove, derived fields, declarative dedupe. Every change registers
   * the dataset so calculator tables + layout maps refresh live. */

  function _truthy(v) {
    return !!v && v !== 0;
  }

  function renderBuilder(b) {
    var a = b.attrs || {};
    var params = (Array.isArray(a.params) ? a.params : []).filter(function (p) { return p && p.name; });
    var dims = (Array.isArray(a.dims) ? a.dims : []).filter(function (d) { return d && d.field; });
    var derived = (Array.isArray(a.derived) ? a.derived : []).filter(function (d) { return d && d.field && d.expr; });
    var dedupe = (a.dedupe && typeof a.dedupe === 'object') ? a.dedupe : { when: '', ignore: [] };
    var datasetName = a.dataset || 'conditions';

    var el = document.createElement('div');
    el.className = 'prd-calc prd-builder';

    if (a.label) {
      var head = document.createElement('div');
      head.className = 'prd-calc-label';
      head.textContent = a.label;
      el.appendChild(head);
    }
    if (a.description) {
      var desc = document.createElement('div');
      desc.className = 'prd-calc-desc prd-prose';
      bindProse(desc, a.description);
      el.appendChild(desc);
    }

    /* Session state for this builder instance. */
    var picks = {};                       // dim field → picked value / param name
    var options = {};                     // dim field → live option list (editable copies)
    dims.forEach(function (d) {
      options[d.field] = (d.source === 'params')
        ? params.map(function (p) { return p.name; })
        : (Array.isArray(d.options) ? d.options.slice() : []);
      picks[d.field] = options[d.field][0] || '';
    });
    var rows = [];                        // assembled rows (source of truth)
    var lastRegistered = '';

    function paramByName(name) {
      for (var i = 0; i < params.length; i++) if (params[i].name === name) return params[i];
      return null;
    }
    function paramValue(name) {
      if (state.overrides[name] !== undefined) return state.overrides[name];
      var p = paramByName(name);
      var d = p && ((typeof p.default === 'number') ? p.default : parseFloat(p.default));
      return isFinite(d) ? d : 0;
    }

    /* Monotonic chain: clamp every param with `lt` strictly below its
     * bound. One forward pass per change handles L_S < L_M < L_L. */
    function enforceConstraints() {
      params.forEach(function (p) {
        if (!p.lt || !paramByName(p.lt)) return;
        var step = (typeof p.step === 'number' && p.step > 0) ? p.step : 1;
        var bound = paramValue(p.lt);
        if (paramValue(p.name) >= bound) {
          var clamped = bound - step;
          if (typeof p.min === 'number' && clamped < p.min) clamped = p.min;
          state.overrides[p.name] = clamped;
        }
      });
    }

    /* Materialize one row from current picks + param values. */
    function buildRow(pickSet) {
      var row = {};
      dims.forEach(function (d) {
        var v = pickSet[d.field];
        row[d.field] = v;
        if (d.source === 'params') {
          var p = paramByName(v);
          row[d.field + '_label'] = (p && p.label) || v;
          row[d.field + '_value'] = paramValue(v);
        }
      });
      derived.forEach(function (df) {
        var res = window.ProtocolFormulas.evalExpression(df.expr, state.table, state.math, row);
        row[df.field] = res.error ? null : res.value;
      });
      return row;
    }

    /* Refresh param-bound values + derived fields on existing rows,
     * apply dedupe, and register. Guarded against the re-entrant
     * protocol-vars-changed cycle by a change check. */
    function syncAndRegister() {
      var synced = rows.map(function (row) {
        var pickSet = {};
        dims.forEach(function (d) { pickSet[d.field] = row[d.field]; });
        return buildRow(pickSet);
      });
      // Dedupe: rows matching `when` get `ignore` fields blanked before
      // identity-keying; identical keys merge (first kept).
      var seen = {};
      var deduped = [];
      synced.forEach(function (row) {
        var keyRow = row;
        if (dedupe.when) {
          var res = window.ProtocolFormulas.evalExpression(dedupe.when, state.table, state.math, row);
          if (!res.error && _truthy(res.value)) {
            keyRow = {};
            Object.keys(row).forEach(function (k) { keyRow[k] = row[k]; });
            (dedupe.ignore || []).forEach(function (f) {
              keyRow[f] = '';
              keyRow[f + '_label'] = '';
              keyRow[f + '_value'] = '';
            });
          }
        }
        var key = JSON.stringify(keyRow, Object.keys(keyRow).sort());
        if (seen[key]) return;
        seen[key] = true;
        deduped.push(keyRow === row ? row : keyRow);
      });
      rows = deduped;
      var fingerprint = JSON.stringify(rows);
      renderRowsTable();
      if (fingerprint !== lastRegistered) {
        lastRegistered = fingerprint;
        window.ProtocolFormulas.registerDataset(datasetName, rows);
      }
    }

    /* Sliders for params. */
    if (params.length) {
      var grid = document.createElement('div');
      grid.className = 'prd-calc-controls';
      params.forEach(function (p) {
        var row = document.createElement('div');
        row.className = 'prd-calc-control';
        var top = document.createElement('div');
        top.className = 'prd-calc-control-top';
        var lab = document.createElement('span');
        lab.className = 'prd-calc-input-label';
        lab.textContent = p.label || p.name;
        top.appendChild(lab);
        var valEl = document.createElement('span');
        valEl.className = 'prd-calc-control-value';
        top.appendChild(valEl);
        row.appendChild(top);

        var inp = document.createElement('input');
        inp.type = 'range';
        inp.min = (typeof p.min === 'number') ? String(p.min) : '0';
        inp.max = (typeof p.max === 'number') ? String(p.max) : '100';
        inp.step = (typeof p.step === 'number') ? String(p.step) : 'any';

        var refresh = function () {
          var v = paramValue(p.name);
          if (document.activeElement !== inp) inp.value = String(v);
          valEl.textContent = _fmtNum(v) + (p.unit ? ' ' + p.unit : '');
        };
        refresh();
        state.refreshers.push(refresh);

        inp.addEventListener('input', function () {
          var n = parseFloat(inp.value);
          if (isFinite(n)) state.overrides[p.name] = n;
          enforceConstraints();
          recompute();          // refreshers update sliders + rows resync below
          syncAndRegister();
        });
        row.appendChild(inp);
        if (p.lt) {
          var hint = document.createElement('div');
          hint.className = 'prd-calc-control-hint';
          hint.textContent = 'kept below ' + ((paramByName(p.lt) || {}).label || p.lt);
          row.appendChild(hint);
        }
        grid.appendChild(row);
      });
      el.appendChild(grid);
    }

    /* Segmented pickers per dim. */
    var pickersWrap = document.createElement('div');
    pickersWrap.className = 'prd-builder-dims';
    el.appendChild(pickersWrap);

    function renderPickers() {
      pickersWrap.innerHTML = '';
      dims.forEach(function (d) {
        var row = document.createElement('div');
        row.className = 'prd-builder-dim';
        var lab = document.createElement('div');
        lab.className = 'prd-builder-dim-label';
        lab.textContent = d.label || d.field;
        row.appendChild(lab);
        var chips = document.createElement('div');
        chips.className = 'prd-builder-chips';
        options[d.field].forEach(function (opt) {
          var chip = document.createElement('button');
          chip.type = 'button';
          chip.className = 'prd-builder-chip' + (picks[d.field] === opt ? ' prd-builder-chip-on' : '');
          var p = (d.source === 'params') ? paramByName(opt) : null;
          chip.textContent = p ? (p.label || p.name) : opt;
          chip.addEventListener('click', function () {
            picks[d.field] = opt;
            renderPickers();
          });
          chips.appendChild(chip);
          if (d.editable && d.source !== 'params') {
            var rm = document.createElement('button');
            rm.type = 'button';
            rm.className = 'prd-builder-chip-rm';
            rm.textContent = '×';
            rm.title = 'Remove option (this session)';
            rm.addEventListener('click', function () {
              options[d.field] = options[d.field].filter(function (o) { return o !== opt; });
              if (picks[d.field] === opt) picks[d.field] = options[d.field][0] || '';
              renderPickers();
            });
            chips.appendChild(rm);
          }
        });
        if (d.editable && d.source !== 'params') {
          var addInp = document.createElement('input');
          addInp.type = 'text';
          addInp.className = 'prd-builder-chip-add';
          addInp.placeholder = '+ option';
          addInp.addEventListener('keydown', function (e) {
            if (e.key !== 'Enter') return;
            var v = addInp.value.trim();
            if (v && options[d.field].indexOf(v) < 0) {
              options[d.field].push(v);
              picks[d.field] = v;
              renderPickers();
            }
            addInp.value = '';
          });
          chips.appendChild(addInp);
        }
        row.appendChild(chips);
        pickersWrap.appendChild(row);
      });
    }
    renderPickers();

    /* Actions. */
    var actions = document.createElement('div');
    actions.className = 'prd-builder-actions';
    function actionBtn(label, title, handler, primary) {
      var btn = document.createElement('button');
      btn.type = 'button';
      btn.className = 'prd-builder-btn' + (primary ? ' prd-builder-btn-primary' : '');
      btn.textContent = label;
      btn.title = title;
      btn.addEventListener('click', handler);
      actions.appendChild(btn);
      return btn;
    }
    actionBtn('+ Add', 'Add the currently picked combination', function () {
      rows.push(buildRow(picks));
      syncAndRegister();
    }, true);
    actionBtn('Add all', 'Add every combination (cartesian product of all dimensions)', function () {
      var sets = [{}];
      dims.forEach(function (d) {
        var next = [];
        sets.forEach(function (s) {
          options[d.field].forEach(function (opt) {
            var c = {};
            Object.keys(s).forEach(function (k) { c[k] = s[k]; });
            c[d.field] = opt;
            next.push(c);
          });
        });
        sets = next;
      });
      sets.forEach(function (s) { rows.push(buildRow(s)); });
      syncAndRegister();
    });
    actionBtn('Clear', 'Remove all assembled rows', function () {
      rows = [];
      syncAndRegister();
    });
    el.appendChild(actions);

    /* Assembled-rows table. */
    var rowsWrap = document.createElement('div');
    rowsWrap.className = 'prd-calc-tablewrap';
    el.appendChild(rowsWrap);

    function renderRowsTable() {
      rowsWrap.innerHTML = '';
      if (!rows.length) {
        var hint = document.createElement('div');
        hint.className = 'prd-calc-control-hint';
        hint.textContent = 'No combinations yet — pick values above and press + Add. Rows register as dataset "' + datasetName + '".';
        rowsWrap.appendChild(hint);
        return;
      }
      var cols = [];
      dims.forEach(function (d) {
        cols.push({ key: (d.source === 'params') ? d.field + '_label' : d.field, label: d.label || d.field });
        if (d.source === 'params') cols.push({ key: d.field + '_value', label: 'value', mono: true });
      });
      derived.forEach(function (df) { cols.push({ key: df.field, label: df.field, mono: true }); });

      var table = document.createElement('table');
      table.className = 'prd-table';
      table.innerHTML = '<thead><tr><th class="prd-col-num">#</th>' +
        cols.map(function (c) { return '<th>' + escapeHtml(c.label) + '</th>'; }).join('') +
        '<th></th></tr></thead>';
      var tbody = document.createElement('tbody');
      rows.forEach(function (row, i) {
        var tr = document.createElement('tr');
        var cells = '<td class="prd-col-num prd-mono">' + (i + 1) + '</td>';
        cols.forEach(function (c) {
          var v = row[c.key];
          var s = (v === null || v === undefined) ? ''
            : (typeof v === 'number') ? _fmtNum(v) : String(v);
          cells += '<td' + (c.mono ? ' class="prd-mono"' : '') + '>' + escapeHtml(s) + '</td>';
        });
        tr.innerHTML = cells;
        var tdRm = document.createElement('td');
        var rm = document.createElement('button');
        rm.type = 'button';
        rm.className = 'prd-builder-chip-rm';
        rm.textContent = '×';
        rm.title = 'Remove row';
        rm.addEventListener('click', function () {
          rows.splice(i, 1);
          syncAndRegister();
        });
        tdRm.appendChild(rm);
        tr.appendChild(tdRm);
        tbody.appendChild(tr);
      });
      table.appendChild(tbody);
      rowsWrap.appendChild(table);
    }
    renderRowsTable();

    /* Keep param-bound row values + derived fields live as sliders move
     * elsewhere in the document. */
    state.refreshers.push(function () { syncAndRegister(); });

    /* Publish the (empty) dataset immediately so downstream widgets show
     * their configured-but-empty state instead of "unknown dataset". */
    window.ProtocolFormulas.registerDataset(datasetName, rows);
    lastRegistered = JSON.stringify(rows);

    return el;
  }

  /* ── V3.324 — layout map: dataset → plate grid ─────────────────── */

  var PLATE_ROWLETTERS = 'ABCDEFGHIJKLMNOP';

  function renderLayoutMap(b) {
    var a = b.attrs || {};
    if (!a.dataset) return null;
    var gridRows = Math.max(1, Math.min(16, parseInt(a.rows, 10) || 4));
    var gridCols = Math.max(1, Math.min(24, parseInt(a.cols, 10) || 6));

    var el = document.createElement('div');
    el.className = 'prd-layoutmap';
    if (a.label) {
      var head = document.createElement('div');
      head.className = 'prd-materials-label';
      head.textContent = a.label;
      el.appendChild(head);
    }
    var wrap = document.createElement('div');
    wrap.className = 'prd-layoutmap-wrap';
    el.appendChild(wrap);

    function cellText(expr, row, fallback) {
      if (!expr) return fallback;
      var res = window.ProtocolFormulas.evalExpression(expr, state.table, state.math, row);
      if (res.error) return '⚠';
      if (typeof res.value === 'number') return _fmtNum(res.value);
      return String(res.value === undefined || res.value === null ? fallback : res.value);
    }

    function refresh() {
      wrap.innerHTML = '';
      var rows = window.ProtocolFormulas.getDataset(a.dataset) || [];
      // Distinct color classes by colorField value, in first-seen order.
      var colorIdx = {};
      var nextColor = 0;
      var table = document.createElement('table');
      table.className = 'prd-plate';
      var thead = document.createElement('thead');
      var trh = document.createElement('tr');
      trh.innerHTML = '<th></th>' + Array.from({ length: gridCols }, function (_, c) {
        return '<th>' + (c + 1) + '</th>';
      }).join('');
      thead.appendChild(trh);
      table.appendChild(thead);
      var tbody = document.createElement('tbody');
      for (var r = 0; r < gridRows; r++) {
        var tr = document.createElement('tr');
        var th = document.createElement('th');
        th.textContent = PLATE_ROWLETTERS[r] || String(r + 1);
        tr.appendChild(th);
        for (var c = 0; c < gridCols; c++) {
          var i = r * gridCols + c;
          var td = document.createElement('td');
          td.className = 'prd-well';
          if (i < rows.length) {
            var row = rows[i];
            if (a.colorField) {
              var cv = String(row[a.colorField]);
              if (!(cv in colorIdx)) colorIdx[cv] = (nextColor++) % 8;
              td.classList.add('prd-well-c' + colorIdx[cv]);
            } else {
              td.classList.add('prd-well-filled');
            }
            var labelTxt = cellText(a.cellLabel, row, String(i + 1));
            var subTxt = a.cellSub ? cellText(a.cellSub, row, '') : '';
            td.innerHTML = '<div class="prd-well-label">' + escapeHtml(labelTxt) + '</div>' +
              (subTxt ? '<div class="prd-well-sub">' + escapeHtml(subTxt) + '</div>' : '');
          } else {
            td.classList.add('prd-well-spare');
            td.innerHTML = '<div class="prd-well-label">' +
              escapeHtml(a.spareLabel === undefined ? '—' : a.spareLabel) + '</div>';
          }
          tr.appendChild(td);
        }
        tbody.appendChild(tr);
      }
      table.appendChild(tbody);
      wrap.appendChild(table);
      if (!rows.length) {
        var hint = document.createElement('div');
        hint.className = 'prd-calc-control-hint';
        hint.textContent = 'Dataset "' + a.dataset + '" is empty — assemble combinations in the builder above.';
        wrap.appendChild(hint);
      } else if (rows.length > gridRows * gridCols) {
        // Never drop conditions silently — a mis-plated experiment is
        // worse than an ugly warning.
        var overflow = document.createElement('div');
        overflow.className = 'prd-calc-control-hint';
        overflow.textContent = '⚠ ' + (rows.length - gridRows * gridCols) +
          ' of ' + rows.length + ' conditions don\'t fit this ' + gridRows +
          '×' + gridCols + ' grid and are not shown — enlarge the grid or split the layout.';
        wrap.appendChild(overflow);
      }
    }
    refresh();
    state.refreshers.push(refresh);
    return el;
  }

  /* ── V3.316 — generic table / kv / timeline ────────────────────── */

  function renderGenericTable(b) {
    var a = b.attrs || {};
    var columns = Array.isArray(a.columns) ? a.columns : [];
    var rows = Array.isArray(a.rows) ? a.rows : [];
    if (!columns.length) return null;
    var el = document.createElement('div');
    el.className = 'prd-materials';
    var table = document.createElement('table');
    table.className = 'prd-table';
    var thead = document.createElement('thead');
    var trh = document.createElement('tr');
    columns.forEach(function (col) {
      var th = document.createElement('th');
      th.style.textAlign = col.align || 'left';
      th.textContent = col.label || '';
      trh.appendChild(th);
    });
    thead.appendChild(trh);
    table.appendChild(thead);
    var tbody = document.createElement('tbody');
    rows.forEach(function (row) {
      var any = columns.some(function (col) { return (row[col.key] || '').trim(); });
      if (!any) return;
      var tr = document.createElement('tr');
      columns.forEach(function (col) {
        var td = document.createElement('td');
        td.style.textAlign = col.align || 'left';
        if (col.mono) td.className = 'prd-mono';
        td.className += (td.className ? ' ' : '') + 'prd-prose';
        bindProse(td, row[col.key] || '');
        tr.appendChild(td);
      });
      tbody.appendChild(tr);
    });
    table.appendChild(tbody);
    el.appendChild(table);
    if ((b.body || '').trim()) {
      var cap = document.createElement('div');
      cap.className = 'prd-table-caption prd-prose';
      bindProse(cap, b.body);
      el.appendChild(cap);
    }
    return el;
  }

  function renderKv(b) {
    var items = ((b.attrs || {}).items) || [];
    var real = items.filter(function (it) {
      return it && ((it.term || '').trim() || (it.def || '').trim());
    });
    if (!real.length) return null;
    var dl = document.createElement('dl');
    dl.className = 'prd-kv';
    real.forEach(function (it) {
      var dt = document.createElement('dt');
      dt.className = 'prd-prose';
      bindProse(dt, it.term || '');
      dl.appendChild(dt);
      var dd = document.createElement('dd');
      dd.className = 'prd-prose';
      bindProse(dd, it.def || '');
      dl.appendChild(dd);
    });
    return dl;
  }

  function renderTimeline(b) {
    var marks = ((b.attrs || {}).marks) || [];
    var real = marks.filter(function (m) {
      return m && ((m.at || '').trim() || (m.label || '').trim());
    });
    if (!real.length) return null;
    var el = document.createElement('div');
    el.className = 'prd-timeline';
    if ((b.body || '').trim()) {
      var title = document.createElement('div');
      title.className = 'prd-timeline-title prd-prose';
      bindProse(title, b.body);
      el.appendChild(title);
    }
    var track = document.createElement('div');
    track.className = 'prd-timeline-track';
    real.forEach(function (m) {
      var mk = document.createElement('div');
      mk.className = 'prd-timeline-mark' + (m.included === false ? ' prd-timeline-excluded' : '');
      var dot = document.createElement('div');
      dot.className = 'prd-timeline-dot';
      mk.appendChild(dot);
      var at = document.createElement('div');
      at.className = 'prd-timeline-at prd-prose';
      bindProse(at, m.at || '');
      mk.appendChild(at);
      if ((m.label || '').trim()) {
        var lab = document.createElement('div');
        lab.className = 'prd-timeline-label prd-prose';
        bindProse(lab, m.label);
        mk.appendChild(lab);
      }
      if ((m.sub || '').trim()) {
        var sub = document.createElement('div');
        sub.className = 'prd-timeline-sub prd-prose';
        bindProse(sub, m.sub);
        mk.appendChild(sub);
      }
      track.appendChild(mk);
    });
    el.appendChild(track);
    return el;
  }

  /* ── Masthead ──────────────────────────────────────────────────── */

  function findDocHeader(tree) {
    var found = null;
    ((tree && tree.sections) || []).forEach(function (sec) {
      (sec.children || []).forEach(function (b) {
        if (!found && b && b.kind === 'docHeader') found = b;
      });
    });
    return found;
  }

  function renderMasthead(headerBlock) {
    var a = (headerBlock && headerBlock.attrs) || {};
    var el = document.createElement('header');
    el.className = 'prd-masthead';

    var brandName = a.brand || (state.brand && state.brand.name) || 'McGhee Lab';
    var brand = document.createElement('div');
    brand.className = 'prd-brand';
    brand.textContent = brandName;
    el.appendChild(brand);

    var h1 = document.createElement('h1');
    h1.className = 'prd-title';
    h1.textContent = a.title || state.doc.title || '(untitled protocol)';
    el.appendChild(h1);

    var subtitleRaw = (headerBlock && headerBlock.body) || '';
    if (subtitleRaw.trim()) {
      var sub = document.createElement('div');
      sub.className = 'prd-subtitle prd-prose';
      bindProse(sub, subtitleRaw);
      el.appendChild(sub);
    }

    var chips = Array.isArray(a.chips) ? a.chips : [];
    var metaBits = [];
    if (state.doc.author_name) metaBits.push(state.doc.author_name);
    if (state.doc.created_at) metaBits.push(state.doc.created_at.slice(0, 10));
    if (state.doc.current_version > 0) metaBits.push('v' + state.doc.current_version);

    if (chips.length || metaBits.length) {
      var row = document.createElement('div');
      row.className = 'prd-chips';
      chips.forEach(function (chip) {
        if (!chip || (!chip.text && !chip.var)) return;
        var c = document.createElement('span');
        c.className = 'prd-chip';
        var refresh = function () {
          c.innerHTML = escapeHtml(chip.text || '') +
            (chip.var ? ' <strong>' + symValueHtml(chip.var) + '</strong>' : '');
        };
        refresh();
        if (chip.var) state.refreshers.push(refresh);
        row.appendChild(c);
      });
      metaBits.forEach(function (bit) {
        var c = document.createElement('span');
        c.className = 'prd-chip prd-chip-meta';
        c.textContent = bit;
        row.appendChild(c);
      });
      el.appendChild(row);
    }
    return el;
  }

  /* ── Document assembly ─────────────────────────────────────────── */

  function renderDocument() {
    docEl.innerHTML = '';
    state.refreshers = [];

    var headerBlock = findDocHeader(state.tree);
    docEl.appendChild(renderMasthead(headerBlock));

    var stepCounter = 0;
    var sections = (state.tree.sections || []);
    sections.forEach(function (sec, i) {
      var secEl = document.createElement('section');
      secEl.className = 'prd-section';

      var code = String(i + 1);
      if (code.length < 2) code = '0' + code;
      var h = document.createElement('h2');
      h.className = 'prd-stage-title';
      h.innerHTML = '<span class="prd-stage-code">' + code + '</span>' +
        escapeHtml(sec.label || 'Untitled section');
      var stage = document.createElement('div');
      stage.className = 'prd-stage';
      stage.appendChild(h);
      secEl.appendChild(stage);

      (sec.children || []).forEach(function (b) {
        if (!b || b === headerBlock) return;
        var el = null;
        switch (b.kind) {
          case 'step':      stepCounter++; el = renderStep(b, stepCounter); break;
          case 'note':
          case 'safety':
          case 'callout':   el = renderCallout(b); break;
          case 'materials': el = renderMaterials(b); break;
          case 'figure':    el = renderFigure(b); break;
          case 'formula':   el = renderFormula(b); break;
          case 'heading':   el = renderHeading(b); break;
          case 'table':     el = renderGenericTable(b); break;
          case 'kv':        el = renderKv(b); break;
          case 'timeline':  el = renderTimeline(b); break;
          case 'calculator': el = renderCalculator(b); break;
          case 'builder':   el = renderBuilder(b); break;
          case 'layoutMap': el = renderLayoutMap(b); break;
          case 'docHeader': el = null; break; // only the first renders (as masthead)
          default:          el = null; // unknown/future kinds skipped in doc view
        }
        if (el) secEl.appendChild(el);
      });
      docEl.appendChild(secEl);
    });

    var footer = document.createElement('footer');
    footer.className = 'prd-footer';
    footer.textContent = 'Protocol "' + (state.doc.title || protocolId) + '" · ' +
      protocolId + ' · rendered ' + new Date().toISOString().slice(0, 10) +
      ' · mcgheelab.com/rm';
    docEl.appendChild(footer);
  }

  /* ── Boot ──────────────────────────────────────────────────────── */

  async function boot() {
    backEl.href = '/rm/pages/protocols.html?protocol=' + encodeURIComponent(protocolId);
    printBtn.addEventListener('click', function () { window.print(); });

    var gate = await firebridge.gateSignedIn('Sign in to view this protocol.');
    if (!gate.allowed) { setStatus(''); return; }
    if (!firebridge.isLabMember()) { setStatus(''); return; }

    var db = firebridge.db();
    var snap;
    try {
      snap = await db.collection('protocols').doc(protocolId).get();
    } catch (err) {
      setStatus('Failed to load protocol: ' + (err.message || err));
      return;
    }
    if (!snap.exists) {
      setStatus('Protocol not found: ' + protocolId);
      return;
    }
    state.doc = window.ProtocolSchemas.protocolHydrate(snap.data());
    state.tree = state.doc.tree;
    document.title = (state.doc.title || 'Protocol') + ' — McGhee Lab';

    // Best-effort brand lookup (FuturePlan 05 tenancy seam). The doc
    // may not exist yet — fall back silently.
    try {
      var brandSnap = await db.collection('labConfig').doc('branding').get();
      if (brandSnap.exists) state.brand = brandSnap.data();
    } catch (e) { /* fall back to the hard-coded brand */ }

    // Symbol table: mathjs only loads if the doc actually needs it —
    // formula/calculator/builder entries, or any expression-driven
    // widget (V3.324: builders and layout maps evaluate row exprs even
    // when they declare no params).
    state.formulas = collectPlainFormulas(state.tree);
    var needsMath = state.formulas.length > 0 ||
      (state.tree.sections || []).some(function (sec) {
        return (sec.children || []).some(function (b) {
          return b && (b.kind === 'builder' || b.kind === 'layoutMap');
        });
      });
    if (needsMath) {
      try {
        state.math = await window.ProtocolFormulas.ensureMathjs();
        state.table = window.ProtocolFormulas.buildSymbolTable(
          state.formulas, state.math, state.overrides);
      } catch (err) {
        console.warn('[protocol-doc] mathjs load failed:', err && err.message);
      }
    }

    setStatus('');
    docEl.hidden = false;
    renderDocument();

    // A builder registering its dataset (on Add / Add all / Clear /
    // remove-row) emits `protocol-vars-changed` but nothing in doc view
    // listens by default — so downstream layout maps + computed tables
    // would only repaint when a slider happened to fire recompute().
    // Re-run every refresher on the event; syncAndRegister's fingerprint
    // guard stops the re-register from looping, and running all
    // refreshers AFTER registration keeps consumers correct regardless
    // of whether they sit above or below the producing builder.
    document.addEventListener('protocol-vars-changed', function () {
      state.refreshers.forEach(function (fn) { try { fn(); } catch (e) {} });
    });

    // Inventory chips resolve asynchronously; refresh everything once
    // the list lands (renderers re-read findById on refresh).
    if (window.PROTOCOL_INVENTORY) {
      document.addEventListener('protocol-inventory-loaded', function () {
        state.refreshers.forEach(function (fn) { try { fn(); } catch (e) {} });
      });
      window.PROTOCOL_INVENTORY.ensureList().catch(function () {});
    }
  }

  boot().catch(function (err) {
    console.error('[protocol-doc] boot failed:', err);
    setStatus('Error: ' + (err && err.message || err));
  });
})();
