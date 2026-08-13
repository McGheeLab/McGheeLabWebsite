/* protocol-doc.js — read-only document view for protocols.
 *
 * Third mode of pages/protocols.html (`?protocol=<id>&view=doc`).
 * Renders the protocol's projected JSON tree into a print-ready
 * document: branded masthead, numbered stage headers, callouts,
 * materials tables, figures, and the live interactive widgets
 * (formula / calculator / builder / layout map / node-graph design).
 *
 * FuturePlan 06 Phase 0: the interactive widgets were lifted into the
 * shared window.ProtocolWidgets module (mounted here via a per-page
 * `ctx`), so a lab-notebook run can mount the identical live widgets.
 * This file keeps only the doc-view chrome (masthead, section headers,
 * step/callout/materials/figure/heading/table/kv/timeline) + boot.
 * Prose binding + all interactive kinds go through ProtocolWidgets.
 *
 * No Yjs, no writes; inputs recompute session-locally. Browser
 * print-to-PDF (the 🖨 button) is the export path.
 */

(function () {
  var protocolId = window.__PROTOCOL_ID;
  if (window.__PROTOCOL_MODE !== 'doc' || !protocolId) return;

  var PW = window.ProtocolWidgets;
  var escapeHtml = PW.escapeHtml;

  var statusEl = document.getElementById('prd-status');
  var docEl    = document.getElementById('prd-doc');
  var backEl   = document.getElementById('prd-back');
  var printBtn = document.getElementById('prd-print');

  var state = {
    doc: null,
    tree: null,
    math: null,
    brand: null,
    ctx: null,   // ProtocolWidgets context (holds table/overrides/refreshers)
  };

  function setStatus(text) {
    statusEl.textContent = text || '';
    statusEl.hidden = !text;
  }

  function bindProse(el, raw) { PW.bindProse(state.ctx, el, raw); }
  function symValueHtml(name) {
    var sym = state.ctx.table[name];
    return escapeHtml(sym ? window.ProtocolFormulas.formatSymbolValue(sym) : '?');
  }

  /* Block renderers moved to protocol-doc-render.js (shared with the
   * editor's per-section "complete" preview). renderDocument delegates
   * to window.ProtocolDocRender.renderBlock. */

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
    var bn = document.createElement('span');
    bn.className = 'prd-brand-name';
    bn.textContent = brandName;
    brand.appendChild(bn);
    var tagText = a.tag || (state.brand && state.brand.tagline) || '';
    if (tagText) {
      var bt = document.createElement('span');
      bt.className = 'prd-brand-tag';
      bt.textContent = tagText;
      brand.appendChild(bt);
    }
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
        if (chip.var) state.ctx.refreshers.push(refresh);
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
    state.ctx.refreshers = [];

    var headerBlock = findDocHeader(state.tree);
    docEl.appendChild(renderMasthead(headerBlock));

    var stepCounter = 0;
    (state.tree.sections || []).forEach(function (sec, i) {
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
        if (b.kind === 'step') stepCounter++;
        // single source of truth — the same renderer the editor's
        // per-section "complete" preview uses.
        var el = window.ProtocolDocRender.renderBlock(b, state.ctx, { stepNumber: stepCounter });
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

    var gate = await firebridge.requireSignIn('Sign in to view this protocol.');
    if (!gate.allowed) { setStatus(''); return; }
    if (!firebridge.isLabMember()) { setStatus(''); return; }

    var db = firebridge.db();
    var snap;
    try { snap = await db.collection('protocols').doc(protocolId).get(); }
    catch (err) { setStatus('Failed to load protocol: ' + (err.message || err)); return; }
    if (!snap.exists) { setStatus('Protocol not found: ' + protocolId); return; }
    state.doc = window.ProtocolSchemas.protocolHydrate(snap.data());
    state.tree = state.doc.tree;
    document.title = (state.doc.title || 'Protocol') + ' — McGhee Lab';

    try {
      var brandSnap = await db.collection('labConfig').doc('branding').get();
      if (brandSnap.exists) state.brand = brandSnap.data();
    } catch (e) { /* fall back to the hard-coded brand */ }

    var formulas = window.ProtocolFormulas.collectFormulasFromPlainTree(state.tree);
    var math = null;
    var needsMath = formulas.length > 0 ||
      (state.tree.sections || []).some(function (sec) {
        return (sec.children || []).some(function (b) {
          return b && (b.kind === 'builder' || b.kind === 'layoutMap' || b.kind === 'design');
        });
      });
    if (needsMath) {
      try { math = await window.ProtocolFormulas.ensureMathjs(); }
      catch (err) { console.warn('[protocol-doc] mathjs load failed:', err && err.message); }
    }

    state.ctx = PW.createContext({ container: docEl, math: math, formulas: formulas, overrides: {} });
    if (math) state.ctx.table = window.ProtocolFormulas.buildSymbolTable(formulas, math, state.ctx.overrides);

    setStatus('');
    docEl.hidden = false;
    renderDocument();

    PW.mountRefresherBus(state.ctx);

    if (window.PROTOCOL_INVENTORY) {
      window.PROTOCOL_INVENTORY.ensureList().catch(function () {});
    }
  }

  boot().catch(function (err) {
    console.error('[protocol-doc] boot failed:', err);
    setStatus('Error: ' + (err && err.message || err));
  });
})();
