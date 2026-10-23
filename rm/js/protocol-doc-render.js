/* protocol-doc-render.js — shared read-only block renderers for the
 * "final form" of a protocol. Extracted from protocol-doc.js so BOTH the
 * read-only document view AND the editor's per-section "complete" preview
 * render blocks identically (single source of truth — the preview IS the
 * final form).
 *
 * Every renderer takes a ProtocolWidgets `ctx` (holds table/refreshers/
 * readOnly) instead of a module-global, so any surface can mount it.
 * Prose goes through PW.bindProse(ctx, …); interactive kinds delegate to
 * the shared ProtocolWidgets renderers.
 *
 * Public: window.ProtocolDocRender.renderBlock(plainBlock, ctx, opts).
 *   opts.stepNumber — the number shown on a `step` block.
 * Returns a DOM node, or null for blocks with nothing to show (docHeader
 * is rendered by the masthead, empty figure/table/kv/timeline collapse).
 */

(function () {
  var PW = function () { return window.ProtocolWidgets; };
  function esc(s) { return PW().escapeHtml(s); }
  function bindProse(ctx, el, raw) { PW().bindProse(ctx, el, raw); }

  function renderStep(b, ctx, num) {
    var el = document.createElement('div');
    el.className = 'prd-step';
    var badge = document.createElement('div');
    badge.className = 'prd-step-num';
    badge.textContent = String(num || 1);
    el.appendChild(badge);
    var body = document.createElement('div');
    body.className = 'prd-step-body prd-prose';
    bindProse(ctx, body, b.body || '');
    el.appendChild(body);
    return el;
  }

  var CALLOUT_META = {
    critical: { label: 'Critical', icon: 'exclamation-triangle' },
    note:     { label: 'Note',     icon: 'information-circle' },
    assume:   { label: 'Assumption', icon: 'cog-6-tooth' },
    timing:   { label: 'Timing',   icon: 'clock' },
  };
  function calloutType(b) {
    if (b.kind === 'callout') return CALLOUT_META[(b.attrs || {}).type] ? b.attrs.type : 'note';
    if (b.kind === 'safety') return 'critical';
    return 'note';
  }
  function renderCallout(b, ctx) {
    var type = calloutType(b);
    var meta = CALLOUT_META[type];
    if (type === 'timing') {
      var pill = document.createElement('div');
      pill.className = 'prd-timing';
      var inner = document.createElement('span');
      inner.className = 'prd-timing-pill';
      var label = document.createElement('span');
      label.className = 'prd-timing-icon';
      ICON.label(label, meta.icon);
      inner.appendChild(label);
      var body = document.createElement('span');
      body.className = 'prd-prose';
      bindProse(ctx, body, b.body || '');
      inner.appendChild(body);
      pill.appendChild(inner);
      return pill;
    }
    var el = document.createElement('div');
    el.className = 'prd-callout prd-callout-' + type;
    var head = document.createElement('div');
    head.className = 'prd-callout-label';
    ICON.label(head, meta.icon, ' ' + meta.label);
    el.appendChild(head);
    var body2 = document.createElement('div');
    body2.className = 'prd-callout-body prd-prose';
    bindProse(ctx, body2, b.body || '');
    el.appendChild(body2);
    return el;
  }

  function renderMaterials(b, ctx) {
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
        tr.innerHTML = '<td class="prd-col-num prd-mono">' + esc(r.qty || '') +
          '</td><td>' + esc(r.unit || '') +
          '</td><td>' + (r.item_ref ? ICON.svg('test-tube') + ' ' : '') + esc(label) + '</td>';
        tbody.appendChild(tr);
      });
    }
    renderRows();
    ctx.refreshers.push(renderRows);
    table.appendChild(tbody);
    el.appendChild(table);
    return el;
  }

  function renderFigure(b, ctx) {
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
      bindProse(ctx, cap, b.body);
      el.appendChild(cap);
    }
    return el;
  }

  function renderHeading(b, ctx) {
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
    bindProse(ctx, t, b.body || '');
    h.appendChild(t);
    el.appendChild(h);
    return el;
  }

  function renderGenericTable(b, ctx) {
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
        bindProse(ctx, td, row[col.key] || '');
        tr.appendChild(td);
      });
      tbody.appendChild(tr);
    });
    table.appendChild(tbody);
    el.appendChild(table);
    if ((b.body || '').trim()) {
      var cap = document.createElement('div');
      cap.className = 'prd-table-caption prd-prose';
      bindProse(ctx, cap, b.body);
      el.appendChild(cap);
    }
    return el;
  }

  function renderKv(b, ctx) {
    var items = ((b.attrs || {}).items) || [];
    var real = items.filter(function (it) { return it && ((it.term || '').trim() || (it.def || '').trim()); });
    if (!real.length) return null;
    var dl = document.createElement('dl');
    dl.className = 'prd-kv';
    real.forEach(function (it) {
      var dt = document.createElement('dt');
      dt.className = 'prd-prose';
      bindProse(ctx, dt, it.term || '');
      dl.appendChild(dt);
      var dd = document.createElement('dd');
      dd.className = 'prd-prose';
      bindProse(ctx, dd, it.def || '');
      dl.appendChild(dd);
    });
    return dl;
  }

  function renderTimeline(b, ctx) {
    var marks = ((b.attrs || {}).marks) || [];
    var real = marks.filter(function (m) { return m && ((m.at || '').trim() || (m.label || '').trim()); });
    if (!real.length) return null;
    var el = document.createElement('div');
    el.className = 'prd-timeline';
    if ((b.body || '').trim()) {
      var title = document.createElement('div');
      title.className = 'prd-timeline-title prd-prose';
      bindProse(ctx, title, b.body);
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
      bindProse(ctx, at, m.at || '');
      mk.appendChild(at);
      if ((m.label || '').trim()) {
        var lab = document.createElement('div');
        lab.className = 'prd-timeline-label prd-prose';
        bindProse(ctx, lab, m.label);
        mk.appendChild(lab);
      }
      if ((m.sub || '').trim()) {
        var sub = document.createElement('div');
        sub.className = 'prd-timeline-sub prd-prose';
        bindProse(ctx, sub, m.sub);
        mk.appendChild(sub);
      }
      track.appendChild(mk);
    });
    el.appendChild(track);
    return el;
  }

  /* Node-graph design block: compile → register item lists → render
   * inputs + list, reusing the shared widgets. */
  function renderDesign(b, ctx) {
    var el = document.createElement('div');
    el.className = 'prd-design';
    if (!window.ProtocolGraph) {
      el.textContent = '[node-graph module not loaded]';
      return el;
    }
    var res = window.ProtocolGraph.compile(b.attrs || {});
    var spec = window.ProtocolGraph.designInputsOutputs(res);
    var calcBlock = { attrs: {
      label: (b.attrs || {}).label || 'Calculator',
      formula: (b.attrs || {}).formula || '',
      inputs: spec.inputs, outputs: spec.outputs, table: { dataset: '', columns: [] },
    } };
    el.appendChild(PW().renderCalculator(ctx, calcBlock));
    // registerDataset emits protocol-vars-changed, and assembleAll is
    // itself a refresher the bus re-runs on that event — so register only
    // when the rows actually changed, or the doc view's refresher bus
    // recurses infinitely (mirrors the builder's fingerprint guard).
    var lastReg = {};
    function assembleAll() {
      res.datasets.forEach(function (d) {
        var rows = window.ProtocolGraph.assembleRows(d.spec, ctx.table, ctx.math,
          window.ProtocolGraph.cartesianPicks(d.spec, null));
        var fp = JSON.stringify(rows);
        if (fp !== lastReg[d.name]) {
          lastReg[d.name] = fp;
          window.ProtocolFormulas.registerDataset(d.name, rows);
        }
      });
    }
    assembleAll();
    ctx.refreshers.push(assembleAll);
    res.datasets.forEach(function (d) {
      var cols = [];
      (d.spec.dims || []).forEach(function (dim) {
        cols.push(dim.source === 'params'
          ? { key: dim.field + '_label', label: dim.label || dim.field }
          : { key: dim.field, label: dim.label || dim.field, mono: true });
      });
      (d.spec.derived || []).forEach(function (df) {
        cols.push({ key: df.field, label: df.field, mono: true });
      });
      el.appendChild(PW().renderList(ctx, { datasetName: d.name, label: d.spec.name, columns: cols.length ? cols : undefined }));
    });
    if (res.warnings && res.warnings.length) {
      var w = document.createElement('div');
      w.className = 'prd-calc-control-hint';
      ICON.label(w, 'exclamation-triangle', ' ' + res.warnings.join(' · '));
      el.appendChild(w);
    }
    return el;
  }

  /* Single dispatch used by both the doc view and the editor preview. */
  function renderBlock(b, ctx, opts) {
    opts = opts || {};
    if (!b) return null;
    switch (b.kind) {
      case 'step':       return renderStep(b, ctx, opts.stepNumber);
      case 'note':
      case 'safety':
      case 'callout':    return renderCallout(b, ctx);
      case 'materials':  return renderMaterials(b, ctx);
      case 'figure':     return renderFigure(b, ctx);
      case 'heading':    return renderHeading(b, ctx);
      case 'table':      return renderGenericTable(b, ctx);
      case 'kv':         return renderKv(b, ctx);
      case 'timeline':   return renderTimeline(b, ctx);
      case 'formula':    return PW().renderFormula(ctx, b);
      case 'calculator': return PW().renderCalculator(ctx, b);
      case 'builder':    return PW().renderBuilder(ctx, b);
      case 'layoutMap':  return ((b.attrs || {}).assign && PW().renderPlatePlanner)
        ? PW().renderPlatePlanner(ctx, b) : PW().renderLayoutMap(ctx, b);
      case 'design':     return renderDesign(b, ctx);
      case 'docHeader':  return null;
      default:           return null;
    }
  }

  window.ProtocolDocRender = {
    renderBlock: renderBlock,
    CALLOUT_META: CALLOUT_META,
  };
})();
