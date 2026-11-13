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
 * V3.986: the doc-view chrome (masthead, section headers) moved to
 * protocol-doc-render.js too, shared with the public site's protocol
 * pages; this file is the lab's page — sign-in gate, load, widget
 * context, print.
 *
 * No Yjs, no writes; inputs recompute session-locally. Browser
 * print-to-PDF (the 🖨 button) is the export path.
 */

(function () {
  var protocolId = window.__PROTOCOL_ID;
  if (window.__PROTOCOL_MODE !== 'doc' || !protocolId) return;

  var PW = window.ProtocolWidgets;

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

  /* The document itself — masthead, numbered sections, block renderers —
   * is assembled by protocol-doc-render.js (V3.986: moved there so the
   * public site renders a posted protocol the same way). This file keeps
   * the page: sign-in gate, load, widget context, print. */
  function renderDocument() {
    window.ProtocolDocRender.renderDocument(docEl, {
      doc: state.doc,
      tree: state.tree,
      brand: state.brand,
      ctx: state.ctx,
      footerText: 'Protocol "' + (state.doc.title || protocolId) + '" · ' +
        protocolId + ' · rendered ' + new Date().toISOString().slice(0, 10) +
        ' · mcgheelab.com/rm',
    });
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
