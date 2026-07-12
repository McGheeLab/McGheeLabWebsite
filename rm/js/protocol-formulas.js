/* protocol-formulas.js — V3.117 Phase 2 of the Protocols Builder.
 *
 * Provides:
 *   1. mathjs lazy loader (CDN ESM, ~150 KB gz, fetched only when the
 *      first formula block renders).
 *   2. Symbol table — walks every formula block in the protocol tree,
 *      collects {name → {value, unit, label, computed}} so prose tokens
 *      can resolve names. Inputs from `attrs.variables`, outputs from
 *      evaluating `attrs.expression` against current inputs.
 *   3. Token resolver — substitutes `[!var:<name>]` occurrences in a
 *      text string with rendered HTML chips (`<span class="proto-var">…</span>`).
 *      Token grammar is a deliberate echo of paper-equations.js's
 *      `[!eqi:<id>]` / `[!eqr:<label>]` family so muscle memory carries
 *      across the two builders.
 *   4. Re-render bus — `rebuild(yTree)` recomputes the table and emits a
 *      `protocol-vars-changed` CustomEvent on the editor root. Block
 *      renderers listen and refresh their token spans without a full
 *      tree re-render.
 *
 * Public surface: window.ProtocolFormulas.{ ensureMathjs, collectFormulas,
 * buildSymbolTable, renderTextWithTokens, formatSymbolValue, rebuild,
 * getSymbolTable, setRoot }.
 *
 * Pyodide / `python` block kind is NOT loaded here — that's a later
 * phase. The schema reserves the kind so tagging this evaluator as
 * "mathjs only" is explicit.
 */

(function () {
  var MATHJS_CDN = 'https://cdn.jsdelivr.net/npm/mathjs@12/+esm';
  var _math = null;
  var _mathjsPromise = null;

  function ensureMathjs() {
    if (_math) return Promise.resolve(_math);
    if (_mathjsPromise) return _mathjsPromise;
    _mathjsPromise = import(MATHJS_CDN).then(function (mod) {
      _math = (mod && (mod.default || mod)) || null;
      if (!_math || typeof _math.evaluate !== 'function') {
        // Some +esm builds expose evaluate at the top level; fall back to a
        // direct module reference.
        _math = mod;
      }
      return _math;
    }).catch(function (err) {
      _mathjsPromise = null;
      throw err;
    });
    return _mathjsPromise;
  }

  function escapeHtml(s) {
    return String(s || '').replace(/[&<>"']/g, function (c) {
      return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c];
    });
  }

  /* Coerce a Y.Map row into a plain JS object. */
  function _yMapToObj(yMap) {
    if (!yMap || typeof yMap.forEach !== 'function') return yMap || {};
    var obj = {};
    yMap.forEach(function (v, k) { obj[k] = v; });
    return obj;
  }

  /* Walk every formula block and return [{variables:[…], output:{…},
   * expression: str, label: str, blockId: str}]. Order matches document
   * order so cross-block references (output of an earlier formula used
   * as an input variable in a later one) resolve correctly.
   *
   * V3.318 — calculator blocks contribute too: their `inputs[]` (plain
   * JSON array) become a variables-only entry, and each `outputs[]`
   * item becomes its own expression entry. buildSymbolTable is reused
   * unchanged; calculator inputs/outputs land in the same table so
   * [!var:] tokens, docHeader chips, and later formulas all see them. */
  function collectFormulas(yTree) {
    var formulas = [];
    if (!yTree || typeof yTree.get !== 'function') return formulas;
    var ySections = yTree.get('sections');
    if (!ySections || typeof ySections.toArray !== 'function') return formulas;
    ySections.toArray().forEach(function (ySec) {
      var yChildren = ySec.get && ySec.get('children');
      if (!yChildren || typeof yChildren.toArray !== 'function') return;
      yChildren.toArray().forEach(function (yBlock) {
        if (!yBlock || typeof yBlock.get !== 'function') return;
        var kind = yBlock.get('kind');
        var attrs = yBlock.get('attrs');
        if (!attrs || typeof attrs.get !== 'function') return;
        if (kind === 'formula') {
          var entry = {
            blockId: yBlock.get('id') || '',
            label: attrs.get('label') || '',
            description: attrs.get('description') || '',
            expression: attrs.get('expression') || '',
            variables: [],
            output: null,
          };
          var yVars = attrs.get('variables');
          if (yVars && typeof yVars.toArray === 'function') {
            yVars.toArray().forEach(function (yVar) { entry.variables.push(_yMapToObj(yVar)); });
          } else if (Array.isArray(yVars)) {
            entry.variables = yVars.slice();
          }
          var yOutput = attrs.get('output');
          if (yOutput) entry.output = _yMapToObj(yOutput);
          formulas.push(entry);
        } else if (kind === 'calculator') {
          formulas.push.apply(formulas, calculatorToFormulaEntries({
            id: yBlock.get('id') || '',
            attrs: {
              label: attrs.get('label') || '',
              inputs: attrs.get('inputs'),
              outputs: attrs.get('outputs'),
            },
          }));
        } else if (kind === 'builder') {
          // V3.324 — builder params are symbol-table variables too.
          formulas.push.apply(formulas, builderToFormulaEntries({
            id: yBlock.get('id') || '',
            attrs: {
              label: attrs.get('label') || '',
              params: attrs.get('params'),
            },
          }));
        }
      });
    });
    return formulas;
  }

  /* V3.318 — expand one calculator block (plain shape) into formula
   * entries consumable by buildSymbolTable. Shared by the Y walker
   * above and plain-tree walkers (protocol-doc.js). */
  function calculatorToFormulaEntries(block) {
    var a = (block && block.attrs) || {};
    var entries = [];
    var inputs = Array.isArray(a.inputs) ? a.inputs : [];
    entries.push({
      blockId: block.id || '',
      label: a.label || '',
      description: '',
      expression: '',
      variables: inputs,
      output: null,
    });
    (Array.isArray(a.outputs) ? a.outputs : []).forEach(function (out) {
      if (!out || !out.name || !out.expr) return;
      entries.push({
        blockId: block.id || '',
        label: a.label || '',
        description: '',
        expression: out.expr,
        variables: [],
        output: {
          name: out.name,
          label: out.label || out.name,
          unit: out.unit || '',
          decimals: (typeof out.decimals === 'number') ? out.decimals : 3,
        },
      });
    });
    return entries;
  }

  /* V3.324 — expand one builder block (plain shape) into a variables-
   * only formula entry so its params land in the symbol table (and
   * calculators can reference them directly). */
  function builderToFormulaEntries(block) {
    var a = (block && block.attrs) || {};
    var params = Array.isArray(a.params) ? a.params : [];
    if (!params.length) return [];
    return [{
      blockId: block.id || '',
      label: a.label || '',
      description: '',
      expression: '',
      variables: params,
      output: null,
    }];
  }

  /* ── V3.318 — named datasets + per-row expression evaluation ──
   * Datasets are session-scoped row arrays registered by builder blocks
   * (Release 4) and consumed by calculator computed tables. */
  var _datasets = {};

  function registerDataset(name, rows) {
    if (!name) return;
    _datasets[name] = Array.isArray(rows) ? rows : [];
    _emitChange(); // computed tables listen on protocol-vars-changed
  }

  function getDataset(name) {
    return Object.prototype.hasOwnProperty.call(_datasets, name) ? _datasets[name] : null;
  }

  function listDatasets() { return Object.keys(_datasets); }

  /* Evaluate a mathjs expression under the numeric symbol-table scope
   * with an optional extra scope merged on top (per-row fields shadow
   * globals). Returns {value} or {error}. */
  function evalExpression(expr, table, math, extraScope) {
    if (!expr) return { error: 'empty expression' };
    if (!math) return { error: 'mathjs not loaded' };
    var scope = {};
    table = table || _currentTable;
    Object.keys(table).forEach(function (k) {
      if (typeof table[k].value === 'number') scope[k] = table[k].value;
    });
    if (extraScope) {
      Object.keys(extraScope).forEach(function (k) {
        var v = extraScope[k];
        if (typeof v === 'string' && v !== '') {
          var n = parseFloat(v);
          if (!isNaN(n) && isFinite(n) && String(n) === v.trim()) v = n;
        }
        scope[k] = v;
      });
    }
    try {
      return { value: math.evaluate(expr, scope) };
    } catch (err) {
      return { error: (err && err.message) || String(err) };
    }
  }

  /* Build symbol table. Two passes: inputs first (so an output formula
   * sees them), then outputs in document order. Last-write wins — we
   * surface a console warning so duplicate-name bugs are visible.
   *
   * V3.315 — optional `overrides` map {name → number}: session-local
   * values (doc-view calculator inputs, Release-3 sliders) that shadow
   * each input variable's stored default without writing to the doc. */
  function buildSymbolTable(formulas, math, overrides) {
    var table = {};
    var seenNames = {};
    overrides = overrides || {};

    function _setSym(name, sym) {
      if (seenNames[name]) {
        console.warn('[protocol-formulas] duplicate variable name:', name,
          '— last definition wins. Rename the conflicting variable.');
      }
      seenNames[name] = true;
      table[name] = sym;
    }

    formulas.forEach(function (f) {
      (f.variables || []).forEach(function (v) {
        if (!v || !v.name) return;
        var raw = v.default;
        var val = raw;
        if (typeof raw === 'string' && raw.length) {
          var n = parseFloat(raw);
          if (!isNaN(n) && isFinite(n)) val = n;
        }
        if (Object.prototype.hasOwnProperty.call(overrides, v.name)
            && typeof overrides[v.name] === 'number'
            && isFinite(overrides[v.name])) {
          val = overrides[v.name];
        }
        _setSym(v.name, {
          value: val,
          unit: v.unit || '',
          label: v.label || v.name,
          computed: false,
        });
      });
    });

    formulas.forEach(function (f) {
      if (!f.output || !f.output.name || !f.expression) return;
      var scope = {};
      Object.keys(table).forEach(function (k) {
        var v = table[k].value;
        if (typeof v === 'number') scope[k] = v;
      });
      try {
        var result = math.evaluate(f.expression, scope);
        // mathjs Unit results — coerce to a plain number where we can.
        // For V1, formulas with units in the expression get a string-rendered
        // result (e.g. "0.1 g"). Pure-number results get rounded via
        // output.decimals.
        var dec = (typeof f.output.decimals === 'number') ? f.output.decimals : 3;
        if (typeof result === 'number') {
          if (isFinite(result)) {
            var rounded = parseFloat(result.toFixed(dec));
            _setSym(f.output.name, {
              value: rounded,
              unit: f.output.unit || '',
              label: f.output.label || f.output.name,
              computed: true,
            });
          } else {
            _setSym(f.output.name, {
              value: null,
              unit: f.output.unit || '',
              label: f.output.label || f.output.name,
              computed: true,
              error: 'non-finite result',
            });
          }
        } else if (result && typeof result === 'object' && typeof result.toString === 'function') {
          _setSym(f.output.name, {
            value: result.toString(),
            unit: '',
            label: f.output.label || f.output.name,
            computed: true,
          });
        } else {
          _setSym(f.output.name, {
            value: result,
            unit: f.output.unit || '',
            label: f.output.label || f.output.name,
            computed: true,
          });
        }
      } catch (err) {
        _setSym(f.output.name, {
          value: null,
          unit: f.output.unit || '',
          label: f.output.label || f.output.name,
          computed: true,
          error: (err && err.message) || String(err),
        });
      }
    });

    return table;
  }

  function formatSymbolValue(sym) {
    if (!sym) return '?';
    if (sym.error) return '⚠';
    if (sym.value === null || sym.value === undefined || sym.value === '') return '?';
    var s = String(sym.value);
    if (sym.unit) s += ' ' + sym.unit;
    return s;
  }

  /* Substitute [!var:name] tokens in a plain text string with rendered
   * HTML chips. Untokenized text is HTML-escaped. */
  var TOKEN_RE = /\[!var:([a-zA-Z_][a-zA-Z0-9_]*)\]/g;

  function renderTextWithTokens(text, symbolTable) {
    if (!text) return '';
    symbolTable = symbolTable || {};
    var html = '';
    var last = 0;
    var m;
    TOKEN_RE.lastIndex = 0;
    while ((m = TOKEN_RE.exec(text)) !== null) {
      html += escapeHtml(text.substring(last, m.index));
      var name = m[1];
      var sym = symbolTable[name];
      var label = sym ? formatSymbolValue(sym) : '?';
      var titleStr = sym
        ? (sym.error ? (sym.label + ' — ' + sym.error) : (sym.label || name))
        : ('Unknown variable: ' + name);
      var cls = 'proto-var';
      if (!sym) cls += ' proto-var-unknown';
      else if (sym.error) cls += ' proto-var-error';
      else if (sym.computed) cls += ' proto-var-computed';
      html += '<span class="' + cls + '" data-var="' + escapeHtml(name) +
              '" title="' + escapeHtml(titleStr) +
              '" contenteditable="false">' + escapeHtml(label) + '</span>';
      last = m.index + m[0].length;
    }
    html += escapeHtml(text.substring(last));
    return html;
  }

  /* Returns true iff the text contains at least one [!var:…] token. Used
   * by renderers to avoid HTML-escaping work on token-free strings. */
  function textHasTokens(text) {
    if (!text) return false;
    TOKEN_RE.lastIndex = 0;
    return TOKEN_RE.test(text);
  }

  /* ── V3.315 — inline vocabulary + single-pass prose renderer ──
   *
   * Grammar (rendered on blur / in the doc view; raw while editing):
   *   [!var:name]            → live value chip (above)
   *   [!inv:id]              → inventory chip (via window.PROTOCOL_INVENTORY)
   *   [!pill:kind:text]      → styled tag span; kind ∈ functional | inert
   *                            get dedicated colors, others neutral
   *   `code`                 → <code class="proto-code">
   *   ~text~ / ^text^        → <sub> / <sup>
   * Inline markup applies only to plain segments, never inside tokens. */
  var PILL_RE = /\[!pill:([a-zA-Z][a-zA-Z0-9_-]*):([^\]]+)\]/g;

  function _renderInlineMarkup(escaped) {
    return escaped
      .replace(/`([^`]+)`/g, '<code class="proto-code">$1</code>')
      .replace(/~([^~]+)~/g, '<sub>$1</sub>')
      .replace(/\^([^^]+)\^/g, '<sup>$1</sup>');
  }

  function textHasProse(text) {
    if (!text) return false;
    if (textHasTokens(text)) return true;
    if (window.PROTOCOL_INVENTORY && window.PROTOCOL_INVENTORY.textHasTokens
        && window.PROTOCOL_INVENTORY.textHasTokens(text)) return true;
    PILL_RE.lastIndex = 0;
    if (PILL_RE.test(text)) return true;
    return /`[^`]+`|~[^~]+~|\^[^^]+\^/.test(text);
  }

  /* Render a plain-text body to HTML: all token grammars substituted in
   * one left-to-right pass, inline markup applied to the plain segments
   * between matches, everything else HTML-escaped. `symbolTable`
   * defaults to the module's current table. */
  function renderProse(raw, symbolTable) {
    raw = String(raw || '');
    var st = symbolTable || _currentTable;
    var matches = [];
    var m;

    var reVar = new RegExp(TOKEN_RE.source, 'g');
    while ((m = reVar.exec(raw)) !== null) {
      matches.push({
        start: m.index, end: m.index + m[0].length,
        html: renderTextWithTokens(m[0], st),
      });
    }
    if (window.PROTOCOL_INVENTORY && window.PROTOCOL_INVENTORY.TOKEN_RE) {
      var reInv = new RegExp(window.PROTOCOL_INVENTORY.TOKEN_RE.source, 'g');
      while ((m = reInv.exec(raw)) !== null) {
        matches.push({
          start: m.index, end: m.index + m[0].length,
          html: window.PROTOCOL_INVENTORY.renderTextWithTokens(m[0]),
        });
      }
    }
    var rePill = new RegExp(PILL_RE.source, 'g');
    while ((m = rePill.exec(raw)) !== null) {
      var kind = m[1].toLowerCase();
      var known = (kind === 'functional' || kind === 'inert');
      matches.push({
        start: m.index, end: m.index + m[0].length,
        html: '<span class="proto-pill' + (known ? ' proto-pill-' + kind : '') +
              '" contenteditable="false">' + escapeHtml(m[2]) + '</span>',
      });
    }

    matches.sort(function (a, b) { return a.start - b.start; });
    var html = '';
    var cursor = 0;
    matches.forEach(function (mm) {
      if (mm.start < cursor) return; // overlap — earlier match wins
      html += _renderInlineMarkup(escapeHtml(raw.substring(cursor, mm.start)));
      html += mm.html;
      cursor = mm.end;
    });
    html += _renderInlineMarkup(escapeHtml(raw.substring(cursor)));
    return html;
  }

  /* ── Re-render bus ─────────────────────────────────────────── */

  var _currentTable = {};
  var _currentRoot = null;
  var _overrides = {};   // V3.315 — session-local input values (never persisted)
  var _lastYTree = null;

  function setRoot(rootEl) { _currentRoot = rootEl || null; }

  /* V3.315 — set a session-local input value and recompute. Passing a
   * non-finite value clears the override (falls back to the stored
   * default). Used by doc-view calculator inputs + Release-3 sliders. */
  function setOverride(name, value) {
    if (!name) return;
    if (typeof value === 'number' && isFinite(value)) _overrides[name] = value;
    else delete _overrides[name];
    if (_lastYTree) rebuild(_lastYTree);
  }

  function getOverrides() { return _overrides; }
  function clearOverrides() { _overrides = {}; }

  function _emitChange() {
    var ev = new CustomEvent('protocol-vars-changed', {
      detail: { symbolTable: _currentTable },
      bubbles: true,
    });
    if (_currentRoot) _currentRoot.dispatchEvent(ev);
    else document.dispatchEvent(ev);
  }

  /* Recompute the symbol table from the current Y tree and emit a
   * change event. Returns a Promise so callers can await mathjs load
   * on first call. */
  async function rebuild(yTree) {
    _lastYTree = yTree || _lastYTree;
    var math;
    try { math = await ensureMathjs(); }
    catch (err) {
      console.warn('[protocol-formulas] mathjs load failed:', err && err.message);
      _currentTable = {};
      _emitChange();
      return _currentTable;
    }
    var formulas = collectFormulas(yTree);
    _currentTable = buildSymbolTable(formulas, math, _overrides);
    _emitChange();
    return _currentTable;
  }

  function getSymbolTable() { return _currentTable; }

  window.ProtocolFormulas = {
    ensureMathjs: ensureMathjs,
    collectFormulas: collectFormulas,
    buildSymbolTable: buildSymbolTable,
    renderTextWithTokens: renderTextWithTokens,
    formatSymbolValue: formatSymbolValue,
    textHasTokens: textHasTokens,
    textHasProse: textHasProse,
    renderProse: renderProse,
    setOverride: setOverride,
    getOverrides: getOverrides,
    clearOverrides: clearOverrides,
    calculatorToFormulaEntries: calculatorToFormulaEntries,
    builderToFormulaEntries: builderToFormulaEntries,
    registerDataset: registerDataset,
    getDataset: getDataset,
    listDatasets: listDatasets,
    evalExpression: evalExpression,
    rebuild: rebuild,
    getSymbolTable: getSymbolTable,
    setRoot: setRoot,
    TOKEN_RE: TOKEN_RE,
    PILL_RE: PILL_RE,
  };
})();
