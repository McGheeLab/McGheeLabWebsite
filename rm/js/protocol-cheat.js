/* protocol-cheat.js — condensed "cheat sheet" view for protocols (V3.503).
 *
 * Fourth mode of pages/protocols.html (`?protocol=<id>&view=cheat`),
 * parallel to the read-only doc view (?view=doc). It renders the SAME
 * projected JSON tree, but boiled down for a user who already knows the
 * protocol: bare-minimum numbered steps + the live numbers they check at
 * the bench (volumes / temps / times), dense enough for a lab-notebook
 * paste or a one-page printout.
 *
 * V3.515 — the contents are USER-SELECTED (not a hardcoded keep-set): a pill
 * bar toggles the four categories (Materials / Safety / Figures & maps /
 * Timing; steps + stage headings are always on) and a "Customize" checklist
 * force-includes/excludes individual lines. The selection persists per (user,
 * protocol) and is shared with the lab-notebook run. Dropped widgets'
 * OUTPUTS still resolve inside kept steps via the shared symbol table, so
 * [!var:] tokens keep their live values.
 *
 * Steps are condensed to one line: the authored `attrs.cheat` line when
 * present, else an auto-extracted first line/sentence of the step body.
 *
 * No Yjs, no writes; inputs recompute session-locally. Browser
 * print-to-PDF (the 🖨 button) is the export path, same as the doc view.
 */

(function () {
  var protocolId = window.__PROTOCOL_ID;
  if (window.__PROTOCOL_MODE !== 'cheat' || !protocolId) return;

  var PW = window.ProtocolWidgets;

  var statusEl = document.getElementById('prc-status');
  var docEl    = document.getElementById('prc-doc');
  var backEl   = document.getElementById('prc-back');
  var fullDocEl = document.getElementById('prc-fulldoc');
  var printBtn = document.getElementById('prc-print');

  var state = {
    doc: null,
    tree: null,
    ctx: null,        // ProtocolWidgets context (holds table/overrides/refreshers)
    prefs: null,      // cheat selection (per user+protocol) — see ProtocolCheatRender
    customizing: false,
  };

  function setStatus(text) {
    statusEl.textContent = text || '';
    statusEl.hidden = !text;
  }

  /* V3.506 — the selection model + renderers live in the shared
   * window.ProtocolCheatRender module so the lab-notebook protocol run
   * renders the identical cheat sheet. This page keeps its own chrome
   * (compact header, footer, boot) + wires the config bar to that module. */
  var PCR = window.ProtocolCheatRender;

  /* ── Compact header (replaces the branded masthead) ────────────────*/
  function renderHeader() {
    var el = document.createElement('header');
    el.className = 'prc-header';
    var h1 = document.createElement('h1');
    h1.className = 'prc-title';
    h1.textContent = state.doc.title || '(untitled protocol)';
    el.appendChild(h1);
    var bits = [];
    if (state.doc.current_version > 0) bits.push('v' + state.doc.current_version);
    if (state.doc.category) bits.push(state.doc.category);
    if (state.doc.author_name) bits.push(state.doc.author_name);
    if (state.doc.updated_at) bits.push(state.doc.updated_at.slice(0, 10));
    bits.push('cheat sheet');
    var meta = document.createElement('div');
    meta.className = 'prc-meta';
    meta.textContent = bits.join(' · ');
    el.appendChild(meta);
    return el;
  }

  /* ── Document assembly ─────────────────────────────────────────────*/
  function renderCheat() {
    docEl.innerHTML = '';
    state.ctx.refreshers = [];

    docEl.appendChild(renderHeader());

    var prefs = state.prefs || (state.prefs = PCR.defaultPrefs());
    var handlers = {
      customizing: state.customizing,
      onToggleCategory: function (c, next) {
        prefs.categories[c] = next; PCR.savePrefs(protocolId, prefs); renderCheat();
      },
      onToggleBlock: function (id, val) {
        prefs.overrides[id] = val; PCR.savePrefs(protocolId, prefs); renderCheat();
      },
      onToggleCustomize: function (next) { state.customizing = next; renderCheat(); },
      onReset: function () {
        var d = PCR.defaultPrefs();
        prefs.categories = d.categories; prefs.overrides = d.overrides;
        PCR.savePrefs(protocolId, prefs); renderCheat();
      },
    };
    docEl.appendChild(PCR.buildConfigBar(prefs, handlers));

    // Single source of truth with the lab-notebook run (V3.506 + V3.515).
    if (state.customizing) PCR.renderChecklistInto(docEl, state.tree, prefs, handlers);
    else PCR.renderSectionsInto(docEl, state.tree, state.ctx, { prefs: prefs });

    var footer = document.createElement('footer');
    footer.className = 'prc-footer';
    footer.textContent = 'Cheat sheet · ' + (state.doc.title || protocolId) + ' · ' + protocolId +
      (state.doc.current_version > 0 ? ' · v' + state.doc.current_version : '') +
      ' · rendered ' + new Date().toISOString().slice(0, 10) + ' · mcgheelab.com/rm';
    docEl.appendChild(footer);
  }

  /* ── Boot ──────────────────────────────────────────────────────────*/
  async function boot() {
    backEl.href = '/rm/pages/protocols.html?protocol=' + encodeURIComponent(protocolId);
    if (fullDocEl) {
      fullDocEl.href = '/rm/pages/protocols.html?protocol=' + encodeURIComponent(protocolId) + '&view=doc';
    }
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
    document.title = (state.doc.title || 'Protocol') + ' — cheat sheet';

    // Build the shared symbol table so [!var:] tokens in kept steps resolve
    // to live values (formula/calculator outputs are captured statically —
    // their widgets don't need to render). Mirrors the doc view's boot.
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
      catch (err) { console.warn('[protocol-cheat] mathjs load failed:', err && err.message); }
    }

    state.ctx = PW.createContext({ container: docEl, math: math, formulas: formulas, overrides: {} });
    if (math) state.ctx.table = window.ProtocolFormulas.buildSymbolTable(formulas, math, state.ctx.overrides);

    // Load this user's saved selection for this protocol (shared with the
    // lab-notebook run); falls back to defaults for a first-time viewer.
    state.prefs = await PCR.loadPrefs(protocolId);

    setStatus('');
    docEl.hidden = false;
    renderCheat();

    PW.mountRefresherBus(state.ctx);

    if (window.PROTOCOL_INVENTORY) {
      window.PROTOCOL_INVENTORY.ensureList().catch(function () {});
    }
  }

  boot().catch(function (err) {
    console.error('[protocol-cheat] boot failed:', err);
    setStatus('Error: ' + (err && err.message || err));
  });
})();
