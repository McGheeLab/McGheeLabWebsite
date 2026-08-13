/* protocol-widgets.js — shared live interactive widgets for protocol
 * definitions (FuturePlan 06, Phase 0).
 *
 * These renderers were extracted verbatim (behavior-preserving) from
 * protocol-doc.js so that BOTH the read-only document view AND a
 * lab-notebook run can mount the same live widgets. The only structural
 * change is that the module-global `state` became a per-mount `ctx`
 * passed as the first argument to every renderer — so more than one
 * surface can host widgets without sharing globals.
 *
 * `ctx` shape (build via createContext):
 *   { container, math, formulas, table, overrides, refreshers[],
 *     readOnly, onChange, builderState }
 *   - overrides   {name→number} session-local input values
 *   - table       current symbol table (rebuilt by recompute)
 *   - refreshers  closures re-run after every recompute
 *   - onChange(reason)  persistence seam — undefined = ephemeral (the
 *                 doc view passes none; the notebook passes a debounced
 *                 save). Called after input/assembly/assignment edits.
 *   - builderState {blockId→{rows,picks,options,dataset}} seed + writeback
 *                 so a run can persist list-builder session state.
 *
 * Depends only on window.ProtocolFormulas (the pure compute kernel) and
 * optionally window.PROTOCOL_INVENTORY.
 *
 * IMPORTANT single-active-context assumption: ProtocolFormulas' dataset
 * registry + `protocol-vars-changed` bus are module-global. One live
 * widget context per page (one doc view; one open notebook entry).
 * mountRefresherBus returns an unlisten fn — call it on unmount.
 */

(function () {
  var PF = function () { return window.ProtocolFormulas; };

  function escapeHtml(s) {
    return String(s || '').replace(/[&<>"']/g, function (c) {
      return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c];
    });
  }

  function fmtNum(v, decimals) {
    if (typeof v !== 'number' || !isFinite(v)) return String(v);
    var dec = (typeof decimals === 'number') ? decimals : 3;
    return String(parseFloat(v.toFixed(dec)));
  }

  function createContext(opts) {
    opts = opts || {};
    return {
      container: opts.container || null,
      math: opts.math || null,
      formulas: opts.formulas || [],
      table: opts.table || {},
      overrides: opts.overrides || {},
      refreshers: [],
      readOnly: !!opts.readOnly,
      onChange: (typeof opts.onChange === 'function') ? opts.onChange : null,
      builderState: opts.builderState || {},
    };
  }

  function recompute(ctx) {
    if (!ctx.math) return;
    ctx.table = PF().buildSymbolTable(ctx.formulas, ctx.math, ctx.overrides);
    ctx.refreshers.forEach(function (fn) { try { fn(); } catch (e) {} });
    if (ctx.onChange) ctx.onChange('recompute');
  }

  function bindProse(ctx, el, raw) {
    var render = function () { el.innerHTML = PF().renderProse(raw, ctx.table); };
    render();
    ctx.refreshers.push(render);
  }

  function symValueHtml(ctx, name) {
    var sym = ctx.table[name];
    return escapeHtml(sym ? PF().formatSymbolValue(sym) : '?');
  }

  /* Scoped recompute bus: a builder registering its dataset fires
   * `protocol-vars-changed`; re-run every refresher so downstream grids
   * / computed tables repaint regardless of DOM order. Returns unlisten. */
  function mountRefresherBus(ctx) {
    var handler = function () {
      ctx.refreshers.forEach(function (fn) { try { fn(); } catch (e) {} });
    };
    document.addEventListener('protocol-vars-changed', handler);
    document.addEventListener('protocol-inventory-loaded', handler);
    return function unlisten() {
      document.removeEventListener('protocol-vars-changed', handler);
      document.removeEventListener('protocol-inventory-loaded', handler);
    };
  }

  /* ── Formula (single expression) ───────────────────────────────── */
  function renderFormula(ctx, b) {
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
      bindProse(ctx, desc, a.description);
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
        inp.disabled = ctx.readOnly;
        var dflt = (typeof v.default === 'number') ? v.default : parseFloat(v.default);
        var cur = (ctx.overrides[v.name] !== undefined) ? ctx.overrides[v.name] : dflt;
        if (isFinite(cur)) inp.value = String(cur);
        inp.addEventListener('input', function () {
          var n = parseFloat(inp.value);
          if (isFinite(n)) ctx.overrides[v.name] = n;
          else delete ctx.overrides[v.name];
          recompute(ctx);
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
        var sym = ctx.table[outName];
        var err = sym && sym.error;
        out.innerHTML =
          '<span class="prd-calc-out-value' + (err ? ' prd-calc-out-error' : '') + '">' +
            (err ? '⚠ ' + escapeHtml(sym.error) : symValueHtml(ctx, outName)) +
          '</span>' +
          '<span class="prd-calc-out-label">' + escapeHtml(a.output.label || outName) + '</span>';
      };
      refresh();
      ctx.refreshers.push(refresh);
      el.appendChild(out);
    }
    return el;
  }

  /* ── Calculator (rich inputs, hero cards, computed table) ──────── */
  function renderCalculator(ctx, b) {
    var a = b.attrs || {};
    var el = document.createElement('div');
    el.className = 'prd-calc prd-calculator';
    // Gold-standard head bar: title on the left, an optional formula/key
    // (attrs.formula) in mono on the right.
    if (a.label || a.formula) {
      var head = document.createElement('div');
      head.className = 'prd-calc-headbar';
      var htitle = document.createElement('span');
      htitle.className = 'prd-calc-headbar-title';
      htitle.textContent = a.label || 'Calculator';
      head.appendChild(htitle);
      if (a.formula) {
        var hkey = document.createElement('span');
        hkey.className = 'prd-calc-headbar-k';
        hkey.textContent = a.formula;
        head.appendChild(hkey);
      }
      el.appendChild(head);
    }
    if (a.description) {
      var desc = document.createElement('div');
      desc.className = 'prd-calc-desc prd-prose';
      bindProse(ctx, desc, a.description);
      el.appendChild(desc);
    }
    // Two-panel body: inputs on the left, outputs (cards + tables) right.
    var body2 = document.createElement('div');
    body2.className = 'prd-calc-body2';
    var inPanel = document.createElement('div');
    inPanel.className = 'prd-calc-inpanel';
    var outPanel = document.createElement('div');
    outPanel.className = 'prd-calc-outpanel';
    body2.appendChild(inPanel);
    body2.appendChild(outPanel);
    el.appendChild(body2);
    var inputs = (Array.isArray(a.inputs) ? a.inputs : []).filter(function (v) { return v && v.name; });
    var needsReseed = false;      // a driven default changed an override at mount
    var reseedPending = false;    // debounce refresher-triggered recomputes
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
        // `drivers` = {min|max|step|default → sourceVar}: a param binding
        // from the design graph drives this field with a live variable.
        var drv = (v.drivers && typeof v.drivers === 'object') ? v.drivers : null;
        function drivenNum(field) {
          if (!drv || !drv[field]) return undefined;
          var sym = ctx.table[drv[field]];
          var n = sym && !sym.error ? sym.value : undefined;
          return (typeof n === 'number' && isFinite(n)) ? n : undefined;
        }
        function effDefault() {
          var d = drivenNum('default');
          return d !== undefined ? d : dflt;
        }
        // A pre-existing override is the user's saved choice; a driven
        // default only tracks the driver while the control is untouched.
        var touched = ctx.overrides[v.name] !== undefined;
        function syncDrivenDefault() {
          if (touched) return false;
          var d = drivenNum('default');
          if (d === undefined || ctx.overrides[v.name] === d) return false;
          ctx.overrides[v.name] = d;
          return true;
        }
        if (syncDrivenDefault()) needsReseed = true;
        function showVal(n) { valEl.textContent = fmtNum(n) + (v.unit ? ' ' + v.unit : ''); }
        showVal(ctx.overrides[v.name] !== undefined ? ctx.overrides[v.name] : effDefault());
        var inp = document.createElement('input');
        inp.type = ((v.widget || 'slider') === 'slider') ? 'range' : 'number';
        function effBounds() {
          var mn = drivenNum('min'); if (mn === undefined && typeof v.min === 'number') mn = v.min;
          var mx = drivenNum('max'); if (mx === undefined && typeof v.max === 'number') mx = v.max;
          return { mn: mn, mx: mx };
        }
        /* V3.433 — typed values obey the (possibly DRIVEN) bounds. HTML
         * `max` on a number input doesn't block typing, so a reader
         * could exceed a lab-set cap: clamp what's STORED on every
         * keystroke (the math never sees an over-cap number) and snap
         * the visible text on commit. */
        function clampBounds(nv) {
          var b = effBounds();
          if (b.mx !== undefined && nv > b.mx) nv = b.mx;
          if (b.mn !== undefined && nv < b.mn) nv = b.mn;
          return nv;
        }
        function applyBounds() {
          var b = effBounds();
          var mn = b.mn, mx = b.mx;
          var st = drivenNum('step'); if (st === undefined && typeof v.step === 'number') st = v.step;
          if (inp.type === 'range') {
            inp.min = (mn !== undefined) ? String(mn) : '0';
            inp.max = (mx !== undefined) ? String(mx) : '100';
          } else {
            if (mn !== undefined) inp.min = String(mn); else inp.removeAttribute('min');
            if (mx !== undefined) inp.max = String(mx); else inp.removeAttribute('max');
          }
          inp.step = (st !== undefined) ? String(st) : 'any';
        }
        applyBounds();
        // a saved override from an earlier session may already sit
        // outside the current (driven) bounds — clamp it before seeding
        if (ctx.overrides[v.name] !== undefined) {
          var cl0 = clampBounds(ctx.overrides[v.name]);
          if (cl0 !== ctx.overrides[v.name]) { ctx.overrides[v.name] = cl0; needsReseed = true; }
        }
        inp.disabled = ctx.readOnly;
        inp.value = String(ctx.overrides[v.name] !== undefined ? ctx.overrides[v.name] : effDefault());
        inp.addEventListener('input', function () {
          touched = true;
          var n = parseFloat(inp.value);
          if (isFinite(n)) { n = clampBounds(n); ctx.overrides[v.name] = n; showVal(n); }
          else delete ctx.overrides[v.name];
          recompute(ctx);
        });
        // commit (change/blur): the field text itself snaps to the
        // clamped value — never mid-typing, so "15" can transit "1"
        inp.addEventListener('change', function () {
          var n = parseFloat(inp.value);
          if (!isFinite(n)) return;
          var c = clampBounds(n);
          if (c !== n) { inp.value = String(c); showVal(c); }
        });
        // keep the control in sync when another widget recomputes
        ctx.refreshers.push(function () {
          applyBounds();
          // V3.433 — the cap moved: the rail must HOLD. A saved override
          // outside the new bounds snaps to them and folds into the
          // table on the next tick (same pattern as driven defaults).
          if (ctx.overrides[v.name] !== undefined) {
            var clr = clampBounds(ctx.overrides[v.name]);
            if (clr !== ctx.overrides[v.name]) {
              ctx.overrides[v.name] = clr;
              if (!reseedPending) {
                reseedPending = true;
                setTimeout(function () { reseedPending = false; recompute(ctx); }, 0);
              }
            }
          }
          if (syncDrivenDefault() && !reseedPending) {
            // the driving variable moved: fold the new default into the
            // table on the next tick (converges — 2nd pass is a no-op)
            reseedPending = true;
            setTimeout(function () { reseedPending = false; recompute(ctx); }, 0);
          }
          var cur = ctx.overrides[v.name] !== undefined ? ctx.overrides[v.name] : effDefault();
          if (document.activeElement !== inp) inp.value = String(cur);
          showVal(cur);
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
      inPanel.appendChild(grid);
      // driven defaults seeded at mount: rebuild the table before outputs
      // render so their first paint already reflects the seeded values
      if (needsReseed && ctx.math) ctx.table = PF().buildSymbolTable(ctx.formulas, ctx.math, ctx.overrides);
    }
    var outputs = (Array.isArray(a.outputs) ? a.outputs : []).filter(function (o) { return o && o.name; });
    if (outputs.length) {
      var cards = document.createElement('div');
      cards.className = 'prd-calc-cards';
      outputs.forEach(function (o) {
        var card = document.createElement('div');
        card.className = 'prd-calc-card';
        var refresh = function () {
          var sym = ctx.table[o.name];
          var dec = o.decimals;
          if (o.drivers && o.drivers.decimals) {
            var ds = ctx.table[o.drivers.decimals];
            if (ds && !ds.error && isFinite(ds.value)) dec = Math.max(0, Math.round(ds.value));
          }
          var valHtml;
          if (!sym) valHtml = '?';
          else if (sym.error) valHtml = '<span class="prd-calc-out-error">⚠</span>';
          else valHtml = escapeHtml(fmtNum(sym.value, dec));
          card.innerHTML =
            '<div class="prd-calc-card-value">' + valHtml +
              (o.unit ? '<span class="prd-calc-card-unit">' + escapeHtml(o.unit) + '</span>' : '') +
            '</div>' +
            '<div class="prd-calc-card-label">' + escapeHtml(o.label || o.name) + '</div>';
        };
        refresh();
        ctx.refreshers.push(refresh);
        cards.appendChild(card);
      });
      outPanel.appendChild(cards);
    }
    var tcfg = (a.table && typeof a.table === 'object') ? a.table : null;
    if (tcfg && tcfg.dataset && Array.isArray(tcfg.columns) && tcfg.columns.length) {
      var wrap = document.createElement('div');
      wrap.className = 'prd-calc-tablewrap';
      outPanel.appendChild(wrap);
      var refreshTable = function () {
        wrap.innerHTML = '';
        var rows = PF().getDataset(tcfg.dataset);
        if (!rows || !rows.length) {
          var hintEl = document.createElement('div');
          hintEl.className = 'prd-calc-control-hint';
          hintEl.textContent = 'List "' + tcfg.dataset + '" is empty.';
          wrap.appendChild(hintEl);
          return;
        }
        var table = document.createElement('table');
        table.className = 'prd-table';
        var thead = document.createElement('thead');
        var trh = document.createElement('tr');
        tcfg.columns.forEach(function (c) {
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
            var res = PF().evalExpression(c.expr, ctx.table, ctx.math, row);
            if (res.error) {
              td.innerHTML = '<span class="prd-calc-out-error" title="' + escapeHtml(res.error) + '">⚠</span>';
            } else if (typeof res.value === 'number') {
              td.textContent = fmtNum(res.value, c.decimals);
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
      ctx.refreshers.push(refreshTable);
    }
    return el;
  }

  /* ── Builder (assembles a named item list) ─────────────────────
   * Session state (rows/picks/options) is seeded from and written back
   * to ctx.builderState[blockId] so a run can persist it. */
  function renderBuilder(ctx, b) {
    var a = b.attrs || {};
    var params = (Array.isArray(a.params) ? a.params : []).filter(function (p) { return p && p.name; });
    var dims = (Array.isArray(a.dims) ? a.dims : []).filter(function (d) { return d && d.field; });
    var derived = (Array.isArray(a.derived) ? a.derived : []).filter(function (d) { return d && d.field && d.expr; });
    var dedupe = (a.dedupe && typeof a.dedupe === 'object') ? a.dedupe : { when: '', ignore: [] };
    var datasetName = a.dataset || 'items';
    var spec = { name: datasetName, params: params, dims: dims, derived: derived, dedupe: dedupe };

    var bId = b.id || datasetName;
    var seed = ctx.builderState[bId] || {};

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
      bindProse(ctx, desc, a.description);
      el.appendChild(desc);
    }

    var picks = {};
    var options = {};
    dims.forEach(function (d) {
      options[d.field] = (seed.options && seed.options[d.field]) ? seed.options[d.field].slice()
        : (d.source === 'params' ? params.map(function (p) { return p.name; })
          : (Array.isArray(d.options) ? d.options.slice() : []));
      picks[d.field] = (seed.picks && seed.picks[d.field] !== undefined) ? seed.picks[d.field]
        : (options[d.field][0] || '');
    });
    // Rows are stored as pickSets (dim→pick) so they survive recompute.
    var pickSets = Array.isArray(seed.pickSets) ? seed.pickSets.slice() : [];
    var rows = [];
    var lastRegistered = '';

    function paramValue(name) {
      if (ctx.overrides[name] !== undefined) return ctx.overrides[name];
      for (var i = 0; i < params.length; i++) {
        if (params[i].name === name) {
          var d = (typeof params[i].default === 'number') ? params[i].default : parseFloat(params[i].default);
          return isFinite(d) ? d : 0;
        }
      }
      return 0;
    }
    function enforceConstraints() {
      params.forEach(function (p) {
        if (!p.lt) return;
        var has = params.some(function (q) { return q.name === p.lt; });
        if (!has) return;
        var step = (typeof p.step === 'number' && p.step > 0) ? p.step : 1;
        var bound = paramValue(p.lt);
        if (paramValue(p.name) >= bound) {
          var clamped = bound - step;
          if (typeof p.min === 'number' && clamped < p.min) clamped = p.min;
          ctx.overrides[p.name] = clamped;
        }
      });
    }

    function persist() {
      ctx.builderState[bId] = { pickSets: pickSets.slice(), picks: picks, options: options, dataset: datasetName };
      if (ctx.onChange) ctx.onChange('builder');
    }

    function syncAndRegister() {
      rows = window.ProtocolGraph
        ? window.ProtocolGraph.assembleRows(spec, ctx.table, ctx.math, pickSets)
        : pickSets.map(function (ps) { return ps; }); // graph module always present in practice
      var fingerprint = JSON.stringify(rows);
      renderRowsTable();
      if (fingerprint !== lastRegistered) {
        lastRegistered = fingerprint;
        PF().registerDataset(datasetName, rows);
      }
      persist();
    }

    if (params.length) {
      var pgrid = document.createElement('div');
      pgrid.className = 'prd-calc-controls';
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
        inp.disabled = ctx.readOnly;
        var refresh = function () {
          var v = paramValue(p.name);
          if (document.activeElement !== inp) inp.value = String(v);
          valEl.textContent = fmtNum(v) + (p.unit ? ' ' + p.unit : '');
        };
        refresh();
        ctx.refreshers.push(refresh);
        inp.addEventListener('input', function () {
          var n = parseFloat(inp.value);
          if (isFinite(n)) ctx.overrides[p.name] = n;
          enforceConstraints();
          recompute(ctx);
          syncAndRegister();
        });
        row.appendChild(inp);
        if (p.lt) {
          var hint = document.createElement('div');
          hint.className = 'prd-calc-control-hint';
          hint.textContent = 'kept below ' + p.lt;
          row.appendChild(hint);
        }
        pgrid.appendChild(row);
      });
      el.appendChild(pgrid);
    }

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
          var pLabel = null;
          if (d.source === 'params') {
            for (var i = 0; i < params.length; i++) if (params[i].name === opt) pLabel = params[i].label || params[i].name;
          }
          chip.textContent = pLabel || opt;
          chip.disabled = ctx.readOnly;
          chip.addEventListener('click', function () { picks[d.field] = opt; renderPickers(); persist(); });
          chips.appendChild(chip);
          if (d.editable && d.source !== 'params' && !ctx.readOnly) {
            var rm = document.createElement('button');
            rm.type = 'button';
            rm.className = 'prd-builder-chip-rm';
            rm.textContent = '×';
            rm.title = 'Remove option (this run)';
            rm.addEventListener('click', function () {
              options[d.field] = options[d.field].filter(function (o) { return o !== opt; });
              if (picks[d.field] === opt) picks[d.field] = options[d.field][0] || '';
              renderPickers(); persist();
            });
            chips.appendChild(rm);
          }
        });
        if (d.editable && d.source !== 'params' && !ctx.readOnly) {
          var addInp = document.createElement('input');
          addInp.type = 'text';
          addInp.className = 'prd-builder-chip-add';
          addInp.placeholder = '+ option';
          addInp.addEventListener('keydown', function (e) {
            if (e.key !== 'Enter') return;
            var v = addInp.value.trim();
            if (v && options[d.field].indexOf(v) < 0) { options[d.field].push(v); picks[d.field] = v; renderPickers(); persist(); }
            addInp.value = '';
          });
          chips.appendChild(addInp);
        }
        row.appendChild(chips);
        pickersWrap.appendChild(row);
      });
    }
    renderPickers();

    if (!ctx.readOnly) {
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
      }
      actionBtn('+ Add', 'Add the currently picked combination', function () {
        var ps = {}; dims.forEach(function (d) { ps[d.field] = picks[d.field]; });
        pickSets.push(ps); syncAndRegister();
      }, true);
      actionBtn('Add all', 'Add every combination', function () {
        pickSets = pickSets.concat(window.ProtocolGraph.cartesianPicks(spec, options));
        syncAndRegister();
      });
      actionBtn('Clear', 'Remove all', function () { pickSets = []; syncAndRegister(); });
      el.appendChild(actions);
    }

    var rowsWrap = document.createElement('div');
    rowsWrap.className = 'prd-calc-tablewrap';
    el.appendChild(rowsWrap);
    function renderRowsTable() {
      rowsWrap.innerHTML = '';
      if (!rows.length) {
        var hint = document.createElement('div');
        hint.className = 'prd-calc-control-hint';
        hint.textContent = ctx.readOnly ? 'No items.' : 'No items yet — pick values above and press + Add.';
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
        (ctx.readOnly ? '' : '<th></th>') + '</tr></thead>';
      var tbody = document.createElement('tbody');
      rows.forEach(function (row, i) {
        var tr = document.createElement('tr');
        var cells = '<td class="prd-col-num prd-mono">' + (i + 1) + '</td>';
        cols.forEach(function (c) {
          var v = row[c.key];
          var s = (v === null || v === undefined) ? '' : (typeof v === 'number') ? fmtNum(v) : String(v);
          cells += '<td' + (c.mono ? ' class="prd-mono"' : '') + '>' + escapeHtml(s) + '</td>';
        });
        tr.innerHTML = cells;
        if (!ctx.readOnly) {
          var tdRm = document.createElement('td');
          var rm = document.createElement('button');
          rm.type = 'button';
          rm.className = 'prd-builder-chip-rm';
          rm.textContent = '×';
          rm.title = 'Remove item';
          rm.addEventListener('click', function () { pickSets.splice(i, 1); syncAndRegister(); });
          tdRm.appendChild(rm);
          tr.appendChild(tdRm);
        }
        tbody.appendChild(tr);
      });
      table.appendChild(tbody);
      rowsWrap.appendChild(table);
    }

    // Keep param-bound values + derived fields live as sliders move.
    ctx.refreshers.push(function () { syncAndRegister(); });
    // Initial assemble + register (from seeded pickSets, or empty).
    rows = window.ProtocolGraph.assembleRows(spec, ctx.table, ctx.math, pickSets);
    renderRowsTable();
    PF().registerDataset(datasetName, rows);
    lastRegistered = JSON.stringify(rows);
    return el;
  }

  /* ── Read-only layout map (dataset → grid preview) ─────────────── */
  var PLATE_ROWLETTERS = 'ABCDEFGHIJKLMNOP';
  // Standard microplate formats for "+ Add plate" (V3.436). rows×cols
  // stay within the planner's 16×24 clamp (≤384-well).
  var PLATE_PRESETS = [
    { label: '96-well', name: '96-well', rows: 8, cols: 12 },
    { label: '384-well', name: '384-well', rows: 16, cols: 24 },
    { label: '24-well', name: '24-well', rows: 4, cols: 6 },
    { label: '12-well', name: '12-well', rows: 3, cols: 4 },
    { label: '6-well', name: '6-well', rows: 2, cols: 3 },
  ];

  function renderLayoutMap(ctx, b) {
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
      var res = PF().evalExpression(expr, ctx.table, ctx.math, row);
      if (res.error) return '⚠';
      if (typeof res.value === 'number') return fmtNum(res.value);
      return String(res.value === undefined || res.value === null ? fallback : res.value);
    }
    function refresh() {
      wrap.innerHTML = '';
      var rows = PF().getDataset(a.dataset) || [];
      var colorIdx = {}; var nextColor = 0;
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
            } else { td.classList.add('prd-well-filled'); }
            var labelTxt = cellText(a.cellLabel, row, String(i + 1));
            var subTxt = a.cellSub ? cellText(a.cellSub, row, '') : '';
            td.innerHTML = '<div class="prd-well-label">' + escapeHtml(labelTxt) + '</div>' +
              (subTxt ? '<div class="prd-well-sub">' + escapeHtml(subTxt) + '</div>' : '');
          } else {
            td.classList.add('prd-well-spare');
            td.innerHTML = '<div class="prd-well-label">' + escapeHtml(a.spareLabel === undefined ? '—' : a.spareLabel) + '</div>';
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
        hint.textContent = 'List "' + a.dataset + '" is empty.';
        wrap.appendChild(hint);
      } else if (rows.length > gridRows * gridCols) {
        var overflow = document.createElement('div');
        overflow.className = 'prd-calc-control-hint';
        overflow.textContent = '⚠ ' + (rows.length - gridRows * gridCols) + ' of ' + rows.length +
          ' items don\'t fit this ' + gridRows + '×' + gridCols + ' grid and are not shown.';
        wrap.appendChild(overflow);
      }
    }
    refresh();
    ctx.refreshers.push(refresh);
    return el;
  }

  /* ── Item-list table (renders a compiled dataset) ──────────────
   * opts: {datasetName, columns?} — columns [{key,label,mono}]; if
   * omitted, inferred from the first row's keys. */
  function renderList(ctx, opts) {
    opts = opts || {};
    var el = document.createElement('div');
    el.className = 'prd-materials prd-itemlist';
    if (opts.label) {
      var head = document.createElement('div');
      head.className = 'prd-materials-label';
      head.textContent = opts.label;
      el.appendChild(head);
    }
    var wrap = document.createElement('div');
    wrap.className = 'prd-calc-tablewrap';
    el.appendChild(wrap);
    function refresh() {
      wrap.innerHTML = '';
      var rows = PF().getDataset(opts.datasetName) || [];
      if (!rows.length) {
        var hint = document.createElement('div');
        hint.className = 'prd-calc-control-hint';
        hint.textContent = 'No items yet.';
        wrap.appendChild(hint);
        return;
      }
      var columns = opts.columns;
      if (!columns) {
        columns = Object.keys(rows[0])
          .filter(function (k) { return k.indexOf('_value') < 0; })
          .map(function (k) { return { key: k, label: k.replace(/_label$/, '') }; });
      }
      var table = document.createElement('table');
      table.className = 'prd-table';
      table.innerHTML = '<thead><tr><th class="prd-col-num">#</th>' +
        columns.map(function (c) { return '<th>' + escapeHtml(c.label || c.key) + '</th>'; }).join('') +
        '</tr></thead>';
      var tbody = document.createElement('tbody');
      rows.forEach(function (row, i) {
        var tr = document.createElement('tr');
        var cells = '<td class="prd-col-num prd-mono">' + (i + 1) + '</td>';
        columns.forEach(function (c) {
          var v = row[c.key];
          var s = (v === null || v === undefined) ? '' : (typeof v === 'number') ? fmtNum(v, c.decimals) : String(v);
          cells += '<td' + (c.mono ? ' class="prd-mono"' : '') + '>' + escapeHtml(s) + '</td>';
        });
        tr.innerHTML = cells;
        tbody.appendChild(tr);
      });
      table.appendChild(tbody);
      wrap.appendChild(table);
    }
    refresh();
    ctx.refreshers.push(refresh);
    return el;
  }

  /* ── FuturePlan 06 run-time widgets ──────────────────────────── */

  /* Stable per-item key (matches ProtocolGraph.rowKey semantics): the
   * dim picks only, so assignments survive recompute reordering. */
  function defaultKeyOf(keyFields) {
    return function (row) {
      var k = {};
      (keyFields || []).forEach(function (f) { k[f] = row[f]; });
      return JSON.stringify(k, Object.keys(k).sort());
    };
  }

  function itemLabel(row, opts) {
    if (opts.labelField && row[opts.labelField] != null) return String(row[opts.labelField]);
    // fall back to joining the key fields' labels/values
    var parts = (opts.keyFields || []).map(function (f) {
      var v = row[f + '_label'] !== undefined ? row[f + '_label'] : row[f];
      return (v === undefined || v === null) ? '' : String(v);
    }).filter(Boolean);
    return parts.join(' · ') || '(item)';
  }

  /* Count how many slots each itemKey occupies across all grids. */
  function slotCounts(grids, assignment) {
    var counts = {};
    (grids || []).forEach(function (g) {
      var a = (assignment && assignment[g.id]) || {};
      var gr = Math.max(1, Math.min(16, parseInt(g.rows, 10) || 4));
      var gc = Math.max(1, Math.min(24, parseInt(g.cols, 10) || 6));
      Object.keys(a).forEach(function (slot) {
        var k = a[slot];
        if (!k) return;
        // ignore slots outside the grid's current size (a shrunk grid
        // leaves orphaned assignments that must not inflate the totals)
        var rc = slot.split('-');
        var r = parseInt(rc[0], 10), c = parseInt(rc[1], 10);
        if (isFinite(r) && isFinite(c) && (r >= gr || c >= gc)) return;
        counts[k] = (counts[k] || 0) + 1;
      });
    });
    return counts;
  }

  /* Interactive grid assignment: an item palette + one editable grid per
   * grid-def. Click a palette item to select it, click slots to assign
   * (repeat for replicates), click an assigned slot to clear it. Writes
   * opts.assignment / opts.grids in place and calls opts.onAssignChange. */
  function renderGridAssignment(ctx, opts) {
    opts = opts || {};
    var keyOf = opts.keyOf || defaultKeyOf(opts.keyFields);
    var selected = null;

    var el = document.createElement('div');
    el.className = 'prd-assign';

    // ── Direct manipulation (V3.436) ─────────────────────────────
    // Drag a palette chip onto a well to place it; drag a filled well
    // to another to move/swap; drag a well off the plate (or onto the
    // trash zone) to remove it. A tap (no movement) falls through to the
    // legacy click behaviour, so touch tap-to-place still works. Pointer
    // capture is on `el` (survives the refresher's re-render) and drops
    // resolve geometrically via elementFromPoint — the touch/pen-safe
    // house pattern (mirrors protocol-graph-editor + huddle). Wells carry
    // data-gid/data-slot so a drop target is pure data, not a live node.
    var drag = null;            // { src, x0, y0, pid, ghost }
    var dragging = false;       // true once past the move threshold
    var trash = null;           // lazy "remove" drop zone
    var DRAG_THRESH = 5;
    function ensureTrash() {
      if (trash) return trash;
      trash = document.createElement('div');
      trash.className = 'prd-planner-trash';
      trash.innerHTML = '🗑 drop here to remove';
      el.appendChild(trash);
      return trash;
    }
    function clearHover() {
      Array.prototype.forEach.call(el.querySelectorAll('.prd-well-drop-hover'), function (w) { w.classList.remove('prd-well-drop-hover'); });
      if (trash) trash.classList.remove('prd-planner-trash-over');
    }
    function wellAt(x, y) {
      var n = document.elementFromPoint(x, y);
      while (n && n.nodeType === 1) {
        if (n.classList && n.classList.contains('prd-well') && n.dataset && n.dataset.slot != null && n.dataset.gid != null) return n;
        n = n.parentNode;
      }
      return null;
    }
    function overTrash(x, y) {
      if (!trash || !trash.classList.contains('prd-planner-trash-show')) return false;
      var r = trash.getBoundingClientRect();
      return x >= r.left && x <= r.right && y >= r.top && y <= r.bottom;
    }
    function endDrag() {
      if (drag && drag.ghost && drag.ghost.parentNode) drag.ghost.parentNode.removeChild(drag.ghost);
      clearHover();
      if (trash) trash.classList.remove('prd-planner-trash-show');
      try { if (drag && drag.pid != null) el.releasePointerCapture(drag.pid); } catch (_) {}
      drag = null; dragging = false;
    }
    function armPointer(e, src) {
      if (ctx.readOnly) return;
      if (e.button != null && e.button !== 0) return;
      e.preventDefault();
      drag = { src: src, x0: e.clientX, y0: e.clientY, pid: e.pointerId, ghost: null };
      try { el.setPointerCapture(e.pointerId); } catch (_) {}
    }
    el.addEventListener('pointermove', function (e) {
      if (!drag) return;
      if (!dragging) {
        if (!drag.src.draggable) return;
        if (Math.abs(e.clientX - drag.x0) < DRAG_THRESH && Math.abs(e.clientY - drag.y0) < DRAG_THRESH) return;
        dragging = true;
        var gh = document.createElement('div');
        gh.className = 'prd-well-ghost ' + (drag.src.colorClass || 'prd-well-filled');
        gh.textContent = drag.src.label || '';
        document.body.appendChild(gh);
        drag.ghost = gh;
        if (drag.src.kind === 'well') ensureTrash().classList.add('prd-planner-trash-show');
        var srcTd = el.querySelector('.prd-well[data-gid="' + drag.src.gid + '"][data-slot="' + drag.src.slot + '"]');
        if (srcTd) srcTd.classList.add('prd-well-drag-src');
      }
      drag.ghost.style.left = e.clientX + 'px';
      drag.ghost.style.top = e.clientY + 'px';
      clearHover();
      var w = wellAt(e.clientX, e.clientY);
      if (w) w.classList.add('prd-well-drop-hover');
      else if (overTrash(e.clientX, e.clientY)) trash.classList.add('prd-planner-trash-over');
    });
    function finishPointer(e) {
      if (!drag) return;
      var src = drag.src, wasDragging = dragging, x = e.clientX, y = e.clientY;
      endDrag();
      if (!wasDragging) {
        // tap → legacy click behaviour (touch tap-to-place preserved)
        if (src.kind === 'chip') { selected = (selected === src.key) ? null : src.key; render(); return; }
        var a = opts.assignment[src.gid] || (opts.assignment[src.gid] = {});
        if (a[src.slot]) delete a[src.slot];
        else if (selected) a[src.slot] = selected;
        change(); render(); return;
      }
      var w = wellAt(x, y);
      if (src.kind === 'chip') {
        if (w) {
          var ta = opts.assignment[w.dataset.gid] || (opts.assignment[w.dataset.gid] = {});
          ta[w.dataset.slot] = src.key;
        }
      } else {
        var sa = opts.assignment[src.gid] || (opts.assignment[src.gid] = {});
        var moving = sa[src.slot];
        if (moving != null) {
          if (w) {
            var tg = w.dataset.gid, ts = w.dataset.slot;
            if (!(tg === src.gid && ts === src.slot)) {
              var tA = opts.assignment[tg] || (opts.assignment[tg] = {});
              var occupied = tA[ts];
              tA[ts] = moving;
              if (occupied != null) sa[src.slot] = occupied; else delete sa[src.slot];
            }
          } else {
            delete sa[src.slot]; // off-plate / trash → remove
          }
        }
      }
      change(); render();
    }
    el.addEventListener('pointerup', finishPointer);
    el.addEventListener('pointercancel', function () { endDrag(); render(); });

    var palette = document.createElement('div');
    palette.className = 'prd-assign-palette';
    el.appendChild(palette);

    var gridsWrap = document.createElement('div');
    gridsWrap.className = 'prd-assign-grids';
    el.appendChild(gridsWrap);

    if (!ctx.readOnly) {
      // "+ Add plate ▾" — standard formats set rows×cols; Custom uses the
      // block/config defaults. The per-grid rows/cols inputs stay for tweaks.
      var addWrap = document.createElement('span');
      addWrap.className = 'prd-addplate';
      var addBtn = document.createElement('button');
      addBtn.type = 'button';
      addBtn.className = 'prd-builder-btn';
      addBtn.textContent = '+ Add plate ▾';
      var menu = document.createElement('div');
      menu.className = 'prd-addplate-menu';
      menu.hidden = true;
      function addPlate(rows, cols, name) {
        opts.grids.push({
          id: 'g' + (Date.now().toString(36)) + opts.grids.length,
          label: (name ? name + ' ' : 'Plate ') + (opts.grids.length + 1),
          rows: rows, cols: cols,
        });
        change(); render();
      }
      PLATE_PRESETS.forEach(function (p) {
        var it = document.createElement('button');
        it.type = 'button';
        it.className = 'prd-addplate-item';
        it.textContent = p.label + '  (' + p.rows + '×' + p.cols + ')';
        it.addEventListener('click', function () {
          menu.hidden = true;
          addPlate(p.rows, p.cols, p.name);
        });
        menu.appendChild(it);
      });
      var custom = document.createElement('button');
      custom.type = 'button';
      custom.className = 'prd-addplate-item';
      custom.textContent = 'Custom…';
      custom.addEventListener('click', function () {
        menu.hidden = true;
        addPlate(opts.defaultRows || 4, opts.defaultCols || 6, 'Plate');
      });
      menu.appendChild(custom);
      addBtn.addEventListener('click', function (e) {
        e.stopPropagation();
        menu.hidden = !menu.hidden;
      });
      document.addEventListener('pointerdown', function (e) {
        if (!menu.hidden && !addWrap.contains(e.target)) menu.hidden = true;
      });
      addWrap.appendChild(addBtn);
      addWrap.appendChild(menu);
      el.appendChild(addWrap);
    }

    function change() { if (opts.onAssignChange) opts.onAssignChange(); }

    function currentItems() { return PF().getDataset(opts.datasetName) || []; }

    function colorClassFor(row, colorIdx, next) {
      if (!opts.colorField) return 'prd-well-filled';
      var cv = String(row[opts.colorField]);
      if (!(cv in colorIdx)) colorIdx[cv] = (next.n++) % 8;
      return 'prd-well-c' + colorIdx[cv];
    }

    function render() {
      var items = currentItems();
      var byKey = {};
      items.forEach(function (r) { byKey[keyOf(r)] = r; });
      var colorIdx = {}; var next = { n: 0 };

      // palette
      palette.innerHTML = '';
      if (!items.length) {
        var hint = document.createElement('div');
        hint.className = 'prd-calc-control-hint';
        hint.textContent = 'No items to assign yet — set inputs / build the list above.';
        palette.appendChild(hint);
      }
      items.forEach(function (row) {
        var k = keyOf(row);
        var cc = colorClassFor(row, colorIdx, next);
        var chip = document.createElement('button');
        chip.type = 'button';
        chip.className = 'prd-assign-chip ' + cc + (selected === k ? ' prd-assign-chip-on' : '');
        chip.textContent = itemLabel(row, opts);
        chip.disabled = ctx.readOnly;
        chip.style.touchAction = 'none';
        chip.title = 'Drag onto a well to place · tap to select';
        chip.addEventListener('pointerdown', function (e) {
          armPointer(e, { kind: 'chip', key: k, label: itemLabel(row, opts), colorClass: cc, draggable: true });
        });
        palette.appendChild(chip);
      });

      // grids
      gridsWrap.innerHTML = '';
      (opts.grids || []).forEach(function (g, gi) {
        var gridRows = Math.max(1, Math.min(16, parseInt(g.rows, 10) || 4));
        var gridCols = Math.max(1, Math.min(24, parseInt(g.cols, 10) || 6));
        var assign = opts.assignment[g.id] = opts.assignment[g.id] || {};

        var box = document.createElement('div');
        box.className = 'prd-assign-grid';
        var head = document.createElement('div');
        head.className = 'prd-assign-grid-head';
        head.textContent = g.label || ('Grid ' + (gi + 1));
        if (!ctx.readOnly) {
          ['rows', 'cols'].forEach(function (dim) {
            var inp = document.createElement('input');
            inp.type = 'number'; inp.min = '1'; inp.max = (dim === 'cols' ? '24' : '16');
            inp.className = 'prd-assign-dim';
            inp.value = String(g[dim] || (dim === 'cols' ? 6 : 4));
            inp.title = dim;
            inp.addEventListener('change', function () {
              g[dim] = Math.max(1, parseInt(inp.value, 10) || 1);
              change(); render();
            });
            head.appendChild(document.createTextNode(' ' + dim.charAt(0) + ':'));
            head.appendChild(inp);
          });
          var rm = document.createElement('button');
          rm.type = 'button'; rm.className = 'prd-builder-chip-rm';
          rm.textContent = '× grid';
          rm.addEventListener('click', function () {
            opts.grids.splice(gi, 1); delete opts.assignment[g.id]; change(); render();
          });
          head.appendChild(rm);
        }
        box.appendChild(head);

        var table = document.createElement('table');
        table.className = 'prd-plate prd-assign-plate';
        var thead = document.createElement('thead');
        var trh = document.createElement('tr');
        trh.innerHTML = '<th></th>' + Array.from({ length: gridCols }, function (_, c) { return '<th>' + (c + 1) + '</th>'; }).join('');
        thead.appendChild(trh);
        table.appendChild(thead);
        var tbody = document.createElement('tbody');
        for (var r = 0; r < gridRows; r++) {
          var tr = document.createElement('tr');
          var th = document.createElement('th');
          th.textContent = PLATE_ROWLETTERS[r] || String(r + 1);
          tr.appendChild(th);
          for (var c = 0; c < gridCols; c++) {
            (function (r, c) {
              var slot = r + '-' + c;
              var td = document.createElement('td');
              td.className = 'prd-well';
              td.dataset.gid = g.id;
              td.dataset.slot = slot;
              td.title = (PLATE_ROWLETTERS[r] || String(r + 1)) + (c + 1);
              var k = assign[slot];
              var wellCC = null, wellLabel = '';
              if (k && byKey[k]) {
                wellCC = colorClassFor(byKey[k], colorIdx, next);
                wellLabel = itemLabel(byKey[k], opts);
                td.classList.add(wellCC);
                td.innerHTML = '<div class="prd-well-label">' + escapeHtml(wellLabel) + '</div>';
              } else if (k) {
                // assignment references an item that no longer exists
                td.classList.add('prd-well-orphan');
                td.innerHTML = '<div class="prd-well-label">⚠ removed</div>';
              } else {
                td.classList.add('prd-well-spare');
              }
              if (!ctx.readOnly) {
                td.style.cursor = 'pointer';
                td.style.touchAction = 'none';
                td.addEventListener('pointerdown', function (e) {
                  armPointer(e, { kind: 'well', key: (k && byKey[k]) ? k : null, gid: g.id, slot: slot,
                    label: wellLabel, colorClass: wellCC || 'prd-well-filled', draggable: !!(k && byKey[k]) });
                });
              }
              tr.appendChild(td);
            })(r, c);
          }
          tbody.appendChild(tr);
        }
        table.appendChild(tbody);
        box.appendChild(table);
        gridsWrap.appendChild(box);
      });
    }
    render();
    // a recompute mid-drag must not yank the DOM out from under the drag;
    // skip the repaint while dragging (the drag commit re-renders anyway).
    ctx.refreshers.push(function () { if (dragging) return; render(); });
    return el;
  }

  /* Live prep totals over the assignment. opts: datasetName, grids,
   * assignment, keyOf|keyFields, poolBy, quantityFields, factor. */
  function renderPrepTotals(ctx, opts) {
    opts = opts || {};
    var keyOf = opts.keyOf || defaultKeyOf(opts.keyFields);
    var el = document.createElement('div');
    el.className = 'prd-materials prd-preptotals';
    var head = document.createElement('div');
    head.className = 'prd-materials-label';
    head.textContent = opts.label || 'Totals to prepare';
    el.appendChild(head);
    var wrap = document.createElement('div');
    wrap.className = 'prd-calc-tablewrap';
    el.appendChild(wrap);

    function refresh() {
      wrap.innerHTML = '';
      var items = PF().getDataset(opts.datasetName) || [];
      var counts = slotCounts(opts.grids, opts.assignment);
      var totalAssigned = Object.keys(counts).reduce(function (s, k) { return s + counts[k]; }, 0);
      if (!totalAssigned) {
        var hint = document.createElement('div');
        hint.className = 'prd-calc-control-hint';
        hint.textContent = 'Assign items to slots above to compute totals.';
        wrap.appendChild(hint);
        return;
      }
      var agg = PF().aggregatePrep(items, {
        countOf: function (row) { return counts[keyOf(row)] || 0; },
        poolBy: opts.poolBy || [],
        quantityFields: opts.quantityFields,
        factor: (typeof opts.factor === 'number') ? opts.factor : 1,
      });
      if (!agg.pools.length) {
        // assignments exist but reference items no longer in the list
        var h0 = document.createElement('div');
        h0.className = 'prd-calc-control-hint';
        h0.textContent = 'Assigned experiments are no longer in the list — re-assign to compute totals.';
        wrap.appendChild(h0);
        return;
      }
      if (!agg.quantityFields.length) {
        var h2 = document.createElement('div');
        h2.className = 'prd-calc-control-hint';
        h2.textContent = 'No numeric per-item quantities to total.';
        wrap.appendChild(h2);
        return;
      }
      var table = document.createElement('table');
      table.className = 'prd-table';
      table.innerHTML = '<thead><tr><th>Pool</th>' +
        agg.quantityFields.map(function (q) { return '<th>' + escapeHtml(q) + '</th>'; }).join('') +
        '</tr></thead>';
      var tbody = document.createElement('tbody');
      agg.pools.forEach(function (p) {
        var tr = document.createElement('tr');
        var cells = '<td>' + escapeHtml(p.label) + '</td>';
        agg.quantityFields.forEach(function (q) { cells += '<td class="prd-mono">' + escapeHtml(fmtNum(p.totals[q])) + '</td>'; });
        tr.innerHTML = cells;
        tbody.appendChild(tr);
      });
      if (agg.pools.length > 1) {
        var gr = document.createElement('tr');
        gr.className = 'prd-preptotals-grand';
        var gc = '<td><strong>Grand total</strong></td>';
        agg.quantityFields.forEach(function (q) { gc += '<td class="prd-mono"><strong>' + escapeHtml(fmtNum(agg.grand[q])) + '</strong></td>'; });
        gr.innerHTML = gc;
        tbody.appendChild(gr);
      }
      table.appendChild(tbody);
      wrap.appendChild(table);
    }
    refresh();
    ctx.refreshers.push(refresh);
    return el;
  }

  function _refreshAll(ctx) {
    (ctx.refreshers || []).forEach(function (fn) { try { fn(); } catch (e) {} });
  }

  /* Plate planner — the interactive "lay out my experiments" surface.
   * Composes the item palette + one grid per plate (add/remove plates) +
   * manual click-assign + an Auto-fill that lays every experiment across
   * the plates replicated by `replicateVar` (wells/condition) + live
   * master-batch totals scaled by `factorVar` (prep excess). State lives
   * in ctx.builderState[blockId] so a notebook run persists it; the doc
   * view is ephemeral (ctx.onChange null). opts come from a layoutMap
   * block with attrs.assign === true. */
  function renderPlatePlanner(ctx, b) {
    var a = b.attrs || {};
    var el = document.createElement('div');
    el.className = 'prd-planner';
    if (a.label) {
      var h = document.createElement('div');
      h.className = 'prd-materials-label';
      h.textContent = a.label;
      el.appendChild(h);
    }

    var bId = b.id || a.dataset || 'planner';
    var seed = ctx.builderState[bId] || {};
    var grids = (Array.isArray(seed.grids) && seed.grids.length)
      ? seed.grids
      : [{ id: 'g1', label: 'Plate 1', rows: a.rows || 4, cols: a.cols || 6 }];
    var assignment = (seed.assignment && typeof seed.assignment === 'object') ? seed.assignment : {};
    var keyFields = Array.isArray(a.keyFields) ? a.keyFields : [];
    var keyOf = defaultKeyOf(keyFields);
    function persistState() {
      ctx.builderState[bId] = { grids: grids, assignment: assignment, arrange: arrange };
      if (ctx.onChange) ctx.onChange('planner');
    }
    function numVar(name, dflt) {
      var s = name && ctx.table[name];
      var n = (s && !s.error) ? s.value : undefined;
      return (typeof n === 'number' && isFinite(n)) ? n : dflt;
    }
    function repsVal() { return Math.max(1, Math.round(numVar(a.replicateVar, 1))); }
    function factorVal() { return numVar(a.factorVar, 1); }

    // V3.438 — arrange strategy persists alongside grids/assignment so a
    // run remembers HOW it was laid out. Defaults are back-compatible.
    var arrange = (seed.arrange && typeof seed.arrange === 'object') ? seed.arrange : { mode: 'fill', direction: 'row' };
    if (!arrange.rowField && keyFields[0]) arrange.rowField = keyFields[0];
    if (!arrange.colField && keyFields[1]) arrange.colField = keyFields[1];
    if (typeof arrange.seed !== 'number') arrange.seed = 1;
    var PGk = window.ProtocolGraph;

    // controls: an Arrange strategy group (mode + contextual options +
    // Arrange), a Clear, and a plain-language note of what reps/excess do.
    var controls = document.createElement('div');
    controls.className = 'prd-planner-controls';
    var warn = document.createElement('div');
    warn.className = 'prd-planner-warn';
    if (!ctx.readOnly && PGk && PGk.plateArrange) {
      var arr = document.createElement('div');
      arr.className = 'prd-arrange';
      var modeSel = document.createElement('select');
      modeSel.className = 'prd-arrange-mode';
      [['fill', 'Fill direction'], ['factorAxis', 'Map factor → axis'], ['spread', 'Spread replicates'], ['random', 'Randomize']]
        .forEach(function (m) { var o = document.createElement('option'); o.value = m[0]; o.textContent = m[1]; modeSel.appendChild(o); });
      modeSel.value = arrange.mode || 'fill';
      var optRow = document.createElement('span');
      optRow.className = 'prd-arrange-opts';
      function fieldSelect(cur, onPick) {
        var s = document.createElement('select');
        s.className = 'prd-arrange-field';
        var none = document.createElement('option'); none.value = ''; none.textContent = '(none)'; s.appendChild(none);
        keyFields.forEach(function (f) { var o = document.createElement('option'); o.value = f; o.textContent = f; s.appendChild(o); });
        s.value = cur || '';
        s.addEventListener('change', function () { onPick(s.value); persistState(); });
        return s;
      }
      function renderOpts() {
        optRow.innerHTML = '';
        if (arrange.mode === 'fill') {
          var ds = document.createElement('select');
          ds.className = 'prd-arrange-field';
          [['row', 'row-major →'], ['col', 'column-major ↓'], ['snake', 'snake ⤵']]
            .forEach(function (d) { var o = document.createElement('option'); o.value = d[0]; o.textContent = d[1]; ds.appendChild(o); });
          ds.value = arrange.direction || 'row';
          ds.addEventListener('change', function () { arrange.direction = ds.value; persistState(); });
          optRow.appendChild(ds);
        } else if (arrange.mode === 'factorAxis') {
          optRow.appendChild(document.createTextNode(' rows:'));
          optRow.appendChild(fieldSelect(arrange.rowField, function (v) { arrange.rowField = v; }));
          optRow.appendChild(document.createTextNode(' cols:'));
          optRow.appendChild(fieldSelect(arrange.colField, function (v) { arrange.colField = v; }));
        } else if (arrange.mode === 'spread') {
          var lab = document.createElement('label');
          lab.className = 'prd-arrange-check';
          var cb = document.createElement('input'); cb.type = 'checkbox'; cb.checked = !!arrange.avoidEdges;
          cb.addEventListener('change', function () { arrange.avoidEdges = cb.checked; persistState(); });
          lab.appendChild(cb); lab.appendChild(document.createTextNode(' avoid edge wells'));
          optRow.appendChild(lab);
        } else if (arrange.mode === 'random') {
          var sn = document.createElement('input');
          sn.type = 'number'; sn.className = 'prd-arrange-seed'; sn.value = String(arrange.seed); sn.title = 'seed (reproducible)';
          sn.addEventListener('change', function () { var n = parseInt(sn.value, 10); arrange.seed = isFinite(n) ? n : 1; persistState(); });
          var die = document.createElement('button');
          die.type = 'button'; die.className = 'prd-builder-btn prd-arrange-die'; die.textContent = '🎲'; die.title = 'new random seed';
          die.addEventListener('click', function () { arrange.seed = Math.floor(Math.random() * 1e9); sn.value = String(arrange.seed); persistState(); });
          optRow.appendChild(sn); optRow.appendChild(die);
        }
      }
      modeSel.addEventListener('change', function () { arrange.mode = modeSel.value; persistState(); renderOpts(); });
      var apply = document.createElement('button');
      apply.type = 'button'; apply.className = 'prd-builder-btn prd-builder-btn-primary';
      apply.textContent = '⚙ Arrange';
      apply.title = 'Lay every experiment across the plates using the chosen strategy';
      apply.addEventListener('click', applyArrange);
      arr.appendChild(modeSel);
      arr.appendChild(optRow);
      arr.appendChild(apply);
      controls.appendChild(arr);
      renderOpts();

      var clr = document.createElement('button');
      clr.type = 'button'; clr.className = 'prd-builder-btn';
      clr.textContent = 'Clear';
      clr.addEventListener('click', function () {
        grids.forEach(function (g) { assignment[g.id] = {}; });
        persistState(); _refreshAll(ctx); warn.textContent = '';
      });
      controls.appendChild(clr);
    }
    el.appendChild(controls);
    var note = document.createElement('div');
    note.className = 'prd-planner-note';
    el.appendChild(note);
    el.appendChild(warn);
    function refreshNote() {
      note.textContent = 'Drag experiments onto wells (or tap to place); drag a well off the plate to remove it. ' +
        '⚙ Arrange lays each experiment ×' + repsVal() + ' (wells/condition) across the plates; ' +
        'the master batch below scales ×' + fmtNum(factorVal()) + ' (prep excess).';
    }
    refreshNote();
    ctx.refreshers.push(refreshNote);

    // manual assignment (palette + plates; "+ Add grid" = add a plate)
    el.appendChild(renderGridAssignment(ctx, {
      datasetName: a.dataset, grids: grids, assignment: assignment,
      keyFields: keyFields, colorField: a.colorField,
      defaultRows: a.rows, defaultCols: a.cols,
      // repaint the master-batch totals on every manual assign/plate edit
      onAssignChange: function () { persistState(); _refreshAll(ctx); },
    }));

    // live master-batch totals; factor tracks the excess input each refresh
    var totalsOpts = {
      datasetName: a.dataset, grids: grids, assignment: assignment,
      keyFields: keyFields, poolBy: a.poolBy || [], quantityFields: a.quantityFields,
      factor: factorVal(), label: 'Master batch — total to prepare (× wells × excess)',
    };
    ctx.refreshers.push(function () { totalsOpts.factor = factorVal(); });
    el.appendChild(renderPrepTotals(ctx, totalsOpts));

    function applyArrange() {
      if (!PGk || !PGk.plateArrange) return;
      var items = PF().getDataset(a.dataset) || [];
      var res = PGk.plateArrange(items, {
        grids: grids, reps: repsVal(), keyOf: keyOf,
        mode: arrange.mode, direction: arrange.direction,
        rowField: arrange.rowField, colField: arrange.colField,
        avoidEdges: arrange.avoidEdges, seed: arrange.seed,
      });
      // keep the same top-level `assignment` object (totals + grid reads
      // hold that reference); replace each grid's slot map in place.
      grids.forEach(function (g) { assignment[g.id] = res.assignment[g.id] || {}; });
      if (typeof res.seedUsed === 'number') arrange.seed = res.seedUsed;
      persistState();
      _refreshAll(ctx);
      var msgs = (res.warnings || []).slice();
      if (res.overflow) msgs.unshift('⚠ ' + res.overflow + ' well(s) didn’t fit — add a plate with “+ Add plate”.');
      warn.textContent = msgs.join(' · ');
    }

    return el;
  }

  window.ProtocolWidgets = {
    escapeHtml: escapeHtml,
    fmtNum: fmtNum,
    renderPlatePlanner: renderPlatePlanner,
    createContext: createContext,
    recompute: recompute,
    bindProse: bindProse,
    mountRefresherBus: mountRefresherBus,
    renderFormula: renderFormula,
    renderCalculator: renderCalculator,
    renderBuilder: renderBuilder,
    renderLayoutMap: renderLayoutMap,
    renderList: renderList,
    renderGridAssignment: renderGridAssignment,
    renderPrepTotals: renderPrepTotals,
    slotCounts: slotCounts,
    PLATE_ROWLETTERS: PLATE_ROWLETTERS,
  };
})();
