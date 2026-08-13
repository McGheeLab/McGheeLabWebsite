/* protocol-graph.js — headless dataflow-graph engine for protocol
 * definitions (FuturePlan 06).
 *
 * A definition's calculation chain is a directed acyclic graph:
 * variables are nodes, attributes give them behavior, wires express
 * dataflow. The graph COMPILES to the shapes the existing compute
 * kernel (protocol-formulas.js) already consumes — an ordered array of
 * formula entries for buildSymbolTable, plus item-list (dataset) specs
 * for registerDataset — so there is no new evaluator.
 *
 * Node types (sockets are derived from type, not stored):
 *   input     — scalar the user sets (slider/number)     → out
 *   constant  — fixed scalar                             → out
 *   choices   — a set of options; GENERATOR (downstream
 *               becomes per-item)                        → out
 *   ordered   — named numeric values with a monotonic
 *               ordering constraint; GENERATOR            → out
 *   equation  — computed from wired inputs; scope
 *               inferred (per-item iff any input is)     ← in*, → out
 *   list      — terminal; assembles wired generators +
 *               per-item equations into an item list     ← in*
 *
 * Sockets are per-variable (derived, not stored) — nodeSockets() gives
 * a node's produced-variable outputs (right) and one input per incoming
 * binding (left), each colored by the variable's unit dimension. An
 * edge is a BINDING: {id, from, to, sourceVar?, role?, paramField?} with
 * role ∈ 'math' (source var usable in the target equation's expression)
 * | 'param' (drives the target's paramField setting) | 'none' | (for a
 * list target) 'structural'.
 *
 * Pure and DOM-free: loadable in Node (with a `window` shim) for the
 * verification harness. `assembleRows` is THE single source of truth
 * for item-list assembly (cartesian expansion, per-row derived fields,
 * declarative dedupe) — the live list widget and the notebook runtime
 * both call it, so the two surfaces can never drift.
 *
 * Public surface: window.ProtocolGraph.{ NODE_TYPES, newNode, newEdge,
 * normalizeGraph, validateGraph, topoSort, wouldCycle, inferScopes,
 * compile, cartesianPicks, assembleRows, rowKey }.
 */

(function () {
  var NODE_TYPES = ['input', 'constant', 'choices', 'ordered', 'equation', 'list', 'code', 'cards', 'refs'];

  function _shortId(prefix) {
    var alphabet = '0123456789abcdefghjkmnpqrstvwxyz';
    var s = '';
    for (var i = 0; i < 7; i++) s += alphabet[Math.floor(Math.random() * alphabet.length)];
    return (prefix || '') + s;
  }

  /* Type defaults seeded when a node is created with no params, so its
   * produced variable (and therefore its output socket) exists at
   * creation instead of only after the user types a name. Names are
   * suffixed with part of the node id to avoid symbol-table collisions. */
  function _defaultParams(type, id) {
    var s = String(id || '').slice(-4) || 'x';
    switch (type) {
      case 'input':    return { name: 'value_' + s, label: 'Value', widget: 'slider', min: 0, max: 100, step: 1, default: 0, unit: '' };
      case 'constant': return { name: 'k_' + s, label: 'Constant', value: 0, unit: '' };
      case 'equation': return { name: 'calc_' + s, label: 'Result', expr: '', unit: '', decimals: 3 };
      case 'choices':  return { field: 'opt_' + s, label: 'Option', options: [] };
      case 'ordered':  return { field: 'seq_' + s, label: 'Sequence', unit: '', items: [] };
      case 'list':     return { name: 'list_' + s, dedupe: { when: '', ignore: [] } };
      case 'code':     return { label: 'Script', body: 'return { out_' + s + ': 0 };',
                                outputs: [{ name: 'out_' + s, label: 'Output', unit: '', decimals: 3 }] };
      case 'cards':    return { label: 'Results' };
      case 'refs':     return { label: 'References' };
      default:         return {};
    }
  }

  function newNode(type, params, pos) {
    if (NODE_TYPES.indexOf(type) < 0) type = 'input';
    var id = _shortId('nd-');
    // Only auto-seed when the caller passes no params (interactive
    // "+ Add node"); explicit params (import, starter, tests) pass through.
    if (!params || Object.keys(params).length === 0) params = _defaultParams(type, id);
    return {
      id: id,
      type: type,
      x: (pos && pos.x) || 0,
      y: (pos && pos.y) || 0,
      params: params,
    };
  }

  /* An edge carries an optional binding: role ∈ 'math'|'param'|'none'
   * plus `sourceVar` (which produced variable is bound) and, for param,
   * `paramField` (which target setting the value drives). Structural
   * edges into a `list` need no role. */
  function newEdge(fromNodeId, toNodeId, opts) {
    opts = opts || {};
    var e = { id: _shortId('ed-'), from: fromNodeId, to: toNodeId };
    if (opts.sourceVar) e.sourceVar = opts.sourceVar;
    if (opts.role) e.role = opts.role;
    if (opts.paramField) e.paramField = opts.paramField;
    return e;
  }

  /* V3.417 — an equation node can hold SEVERAL result equations
   * (params.results = [{name, label, expr, unit, decimals}, …]), each
   * a produced variable with its own out-connector; earlier results
   * are usable in later expressions within the same node (entries are
   * emitted in order, so the scope accumulates). Legacy single-result
   * params (name/expr/unit/decimals at top level) read as one result;
   * the editor mirrors results[0] back to the top level so tours,
   * per-item list assembly, and old readers keep working. */
  function _eqResults(p) {
    p = p || {};
    if (Array.isArray(p.results) && p.results.length) return p.results;
    return [{ name: p.name, label: p.label, expr: p.expr, unit: p.unit, decimals: p.decimals }];
  }

  /* Resolved role for an edge given its target type. Edges into a list
   * are structural (they feed dims/derived); edges into an equation
   * default to 'math'; anything else defaults to 'none'. */
  function edgeRole(edge, targetType) {
    if (edge && edge.role) return edge.role;
    if (targetType === 'list') return 'structural';
    if (targetType === 'equation') return 'math';
    if (targetType === 'code') return 'math';
    if (targetType === 'cards' || targetType === 'refs') return 'display';
    return 'none';
  }

  /* Coerce a stored graph into shape without losing data. */
  function normalizeGraph(graph) {
    if (!graph || typeof graph !== 'object') graph = {};
    if (!Array.isArray(graph.nodes)) graph.nodes = [];
    if (!Array.isArray(graph.edges)) graph.edges = [];
    graph.nodes.forEach(function (n) {
      if (!n.id) n.id = _shortId('nd-');
      if (NODE_TYPES.indexOf(n.type) < 0) n.type = 'input';
      if (typeof n.x !== 'number') n.x = 0;
      if (typeof n.y !== 'number') n.y = 0;
      if (!n.params || typeof n.params !== 'object') n.params = {};
    });
    var ids = {};
    graph.nodes.forEach(function (n) { ids[n.id] = true; });
    graph.edges = graph.edges.filter(function (e) {
      return e && ids[e.from] && ids[e.to] && e.from !== e.to;
    });
    graph.edges.forEach(function (e) { if (!e.id) e.id = _shortId('ed-'); });
    return graph;
  }

  /* ── Units → dimension → color ────────────────────────────────
   * A variable's unit determines its physical dimension, which colors
   * its socket. Matching is case-sensitive first (so molar `M`/`mM`/`µM`
   * don't collide with metric `m`/`mm`/`µm`), with both µ and u spellings
   * and both ² and 2 spellings enumerated. */
  var CATEGORY_COLORS = {
    volume: '#2f6db3', length: '#8259b3', area: '#b3792f', mass: '#c23b3b',
    temperature: '#d98c1f', time: '#22884c', amount: '#1f9e9e',
    ratio: '#6b7280', categorical: '#475569', none: '#9aa4b0', other: '#9aa4b0',
  };
  var CATEGORY_LABELS = {
    volume: 'Volume', length: 'Length', area: 'Area', mass: 'Mass',
    temperature: 'Temperature', time: 'Time', amount: 'Amount / conc.',
    ratio: 'Ratio', categorical: 'Category', none: 'Unitless', other: 'Other',
  };
  var UNIT_CATEGORIES = Object.keys(CATEGORY_LABELS).map(function (k) {
    return { key: k, label: CATEGORY_LABELS[k], color: CATEGORY_COLORS[k] };
  });
  // Case-sensitive unit → category. Both µ and u; both ² and 2.
  var UNIT_MAP = {
    // volume
    'L': 'volume', 'mL': 'volume', 'µL': 'volume', 'uL': 'volume', 'nL': 'volume',
    'cL': 'volume', 'dL': 'volume', 'kL': 'volume', 'm³': 'volume', 'm3': 'volume',
    'cm³': 'volume', 'cm3': 'volume', 'mm³': 'volume', 'mm3': 'volume',
    // length
    'm': 'length', 'cm': 'length', 'mm': 'length', 'µm': 'length', 'um': 'length',
    'nm': 'length', 'km': 'length', 'pm': 'length', 'in': 'length', 'ft': 'length',
    // area
    'm²': 'area', 'm2': 'area', 'cm²': 'area', 'cm2': 'area', 'mm²': 'area', 'mm2': 'area',
    'µm²': 'area', 'µm2': 'area', 'um²': 'area', 'um2': 'area', 'nm²': 'area', 'nm2': 'area', 'ha': 'area',
    // mass
    'kg': 'mass', 'g': 'mass', 'mg': 'mass', 'µg': 'mass', 'ug': 'mass', 'ng': 'mass',
    'pg': 'mass', 'lb': 'mass', 'oz': 'mass', 'Da': 'mass', 'kDa': 'mass',
    // temperature
    '°C': 'temperature', 'C': 'temperature', 'K': 'temperature', '°F': 'temperature', 'F': 'temperature',
    // time
    's': 'time', 'sec': 'time', 'ms': 'time', 'min': 'time', 'h': 'time', 'hr': 'time',
    'hour': 'time', 'd': 'time', 'day': 'time', 'wk': 'time', 'week': 'time',
    // amount / concentration (molar family is capital M)
    'mol': 'amount', 'mmol': 'amount', 'µmol': 'amount', 'umol': 'amount', 'nmol': 'amount',
    'M': 'amount', 'mM': 'amount', 'µM': 'amount', 'uM': 'amount', 'nM': 'amount', 'pM': 'amount',
    'g/L': 'amount', 'mg/mL': 'amount',
    // ratio / dimensionless
    '%': 'ratio', 'x': 'ratio', '×': 'ratio', 'X': 'ratio', 'fraction': 'ratio',
    'ratio': 'ratio', 'AU': 'ratio', 'au': 'ratio', '1': 'ratio',
  };
  function categoryOfUnit(unit) {
    if (unit === undefined || unit === null) return 'none';
    var u = String(unit).trim();
    if (u === '') return 'none';
    if (UNIT_MAP.hasOwnProperty(u)) return UNIT_MAP[u];
    // normalize µ/u and ²/2 spellings, retry
    var n = u.replace(/µ/g, 'u').replace(/²/g, '2');
    if (UNIT_MAP.hasOwnProperty(n)) return UNIT_MAP[n];
    var n2 = u.replace(/u/g, 'µ');
    if (UNIT_MAP.hasOwnProperty(n2)) return UNIT_MAP[n2];
    return 'other';
  }
  function colorOfCategory(key) { return CATEGORY_COLORS[key] || CATEGORY_COLORS.other; }

  /* ── Typed units (V3.400) ─────────────────────────────────────
   * Curated canonical unit choices per dimension — powers the editor's
   * Type → Unit dropdown pair so users pick from a valid subset instead
   * of free-typing (µL not "ul.", °C not "c"). Every entry is a
   * UNIT_MAP key in canonical spelling (µ over u, ² over 2).
   * params.unit stays the single stored value; the TYPE is always
   * DERIVED via categoryOfUnit(), so existing graphs work unchanged and
   * exotic hand-typed units simply present as "Custom". */
  var UNIT_TYPE_ORDER = ['volume', 'mass', 'amount', 'length', 'area', 'temperature', 'time', 'ratio'];
  var UNITS_BY_CATEGORY = {
    volume: ['nL', 'µL', 'mL', 'L'],
    mass: ['pg', 'ng', 'µg', 'mg', 'g', 'kg'],
    amount: ['pM', 'nM', 'µM', 'mM', 'M', 'nmol', 'µmol', 'mmol', 'mol', 'mg/mL', 'g/L'],
    length: ['nm', 'µm', 'mm', 'cm', 'm'],
    area: ['µm²', 'mm²', 'cm²', 'm²'],
    temperature: ['°C', 'K', '°F'],
    time: ['s', 'min', 'h', 'd'],
    ratio: ['%', '×', 'AU', 'fraction'],
  };
  function unitTypeOptions() {
    return UNIT_TYPE_ORDER.map(function (k) {
      return { key: k, label: CATEGORY_LABELS[k], units: UNITS_BY_CATEGORY[k].slice() };
    });
  }
  function unitsForCategory(cat) {
    return (UNITS_BY_CATEGORY[cat] || []).slice();
  }

  /* ── Scientific constants (V3.428) ───────────────────────────
   * Predefined values for the 📌 Constant node's preset picker. Keys
   * are valid expression identifiers (they become the variable name
   * while the node still wears a seeded/auto/preset name). Units use
   * catalog spellings wherever the dimension system can represent
   * them (m/s, L/mol, g/mL, 1/mol decompose — and NAME themselves:
   * speed, molar volume, density, per amount); energy-based units
   * (J/K, J·s, J/(mol·K)) aren't representable in the category system
   * and ride as custom atoms — numerically fine, dimension-silent.
   * NOTE: coulomb-per-mole is written C·mol⁻¹, NOT C/mol — a '/'
   * split would misread C as Celsius; same reason q_e says
   * 'coulomb', never bare 'C'. */
  var SCIENTIFIC_CONSTANTS = [
    { key: 'pi', label: 'Pi (π)', value: Math.PI, display: '3.14159…', unit: '', note: 'circle constant' },
    { key: 'N_A', label: 'Avogadro constant', value: 6.02214076e23, display: '6.022e23', unit: '1/mol', note: 'entities per mole (exact SI)' },
    { key: 'k_B', label: 'Boltzmann constant', value: 1.380649e-23, display: '1.381e-23', unit: 'J/K', note: 'exact SI value' },
    { key: 'R_gas', label: 'Gas constant', value: 8.314462618, display: '8.314', unit: 'J/(mol·K)', note: 'molar gas constant R' },
    { key: 'V_molar', label: 'Molar gas volume (STP)', value: 22.41396954, display: '22.414', unit: 'L/mol', note: 'ideal gas at 0 °C, 1 atm' },
    { key: 'c_light', label: 'Speed of light', value: 299792458, display: '2.998e8', unit: 'm/s', note: 'exact SI value' },
    { key: 'h_planck', label: 'Planck constant', value: 6.62607015e-34, display: '6.626e-34', unit: 'J·s', note: 'exact SI value' },
    { key: 'q_e', label: 'Elementary charge', value: 1.602176634e-19, display: '1.602e-19', unit: 'coulomb', note: 'exact SI value' },
    { key: 'faraday', label: 'Faraday constant', value: 96485.33212, display: '96485', unit: 'C·mol⁻¹', note: 'charge per mole of electrons' },
    { key: 'g_std', label: 'Standard gravity', value: 9.80665, display: '9.807', unit: 'm/s²', note: 'centrifuge RCF is multiples of this' },
    { key: 'rho_water', label: 'Density of water (25 °C)', value: 0.99705, display: '0.997', unit: 'g/mL', note: '1.000 g/mL at 4 °C' },
    { key: 'T_room', label: 'Room temperature', value: 298.15, display: '298.15', unit: 'K', note: '25 °C in kelvin' },
    { key: 'K_w', label: 'Ion product of water (25 °C)', value: 1e-14, display: '1e-14', unit: 'M²', note: '[H⁺][OH⁻] at 25 °C' },
    { key: 'ln10', label: 'ln(10)', value: Math.LN10, display: '2.3026', unit: '', note: 'pH ↔ concentration conversions' },
  ];

  /* type_XX auto-naming (V3.400). Only a node's seeded placeholder name
   * (value_xxxx / k_xxxx / calc_xxxx / … from _defaultParams, suffixed
   * with THIS node's id tail) or a previous auto-name (volume_01, …) is
   * safe to rewrite when the user picks a unit type — a hand-typed name
   * (volume_each, k_on, dose) is never touched. */
  function isAutoName(name, nodeId) {
    var nm = String(name || '');
    if (!nm) return true;
    var s = String(nodeId || '').slice(-4) || 'x';
    if (['value_', 'k_', 'calc_', 'out_', 'seq_', 'opt_', 'list_'].some(function (pre) { return nm === pre + s; })) return true;
    return new RegExp('^(' + UNIT_TYPE_ORDER.join('|') + ')_\\d{2,}$').test(nm);
  }
  function autoNameForCategory(graph, category) {
    if (UNIT_TYPE_ORDER.indexOf(category) < 0) return null;
    var used = {};
    ((graph && graph.nodes) || []).forEach(function (n) {
      producedVars(n).forEach(function (v) { used[v.key] = true; });
    });
    for (var i = 1; i < 100; i++) {
      var nm = category + '_' + (i < 10 ? '0' + i : String(i));
      if (!used[nm]) return nm;
    }
    return category + '_' + _shortId('').slice(-4);
  }

  /* ── Formula pad (V3.407) ─────────────────────────────────────
   * Equation formulas are CLICK-BUILT, never free-typed. Wired math
   * inputs get short dimension aliases (V1, L1, D1 …) and the pad
   * appends tokens (variable / unitless number / operator / parens /
   * √) under a click grammar that makes syntax errors unclickable.
   * `params.expr` stays the stored source of truth — real variable
   * names in mathjs syntax — so compile / doc view / notebook / import
   * / recipes are untouched: these helpers tokenize expr for display
   * and serialize clicks back to it. */
  var DIMENSION_LETTERS = {
    volume: 'V', length: 'L', area: 'A', mass: 'M', temperature: 'T',
    time: 'D', amount: 'C', ratio: 'R', none: 'X', other: 'X', categorical: 'X',
  };
  /* Aliases for a node's wired math inputs, in edge order, numbered
   * within each dimension letter: [{alias, name, unit, category, cats,
   * qty, unitLabel}]. V3.422 — letters/colors come from graph-RESOLVED
   * quantities (resolveQuantities), so a chained computed input letters
   * by what it actually IS: a computed pure-volume result gets V (not
   * X), and a mixed-unit result (volume·amount …) gets Q with its
   * constituent cats for pie coloring. Pass `qtys` to reuse a caller's
   * per-render resolution; omitted, it resolves internally. */
  function equationAliases(graph, node, uptoResultIndex, qtys) {
    if (!node) return [];
    var byId = {};
    ((graph && graph.nodes) || []).forEach(function (n) { byId[n.id] = n; });
    qtys = qtys || resolveQuantities(graph);
    var counters = {}, out = [], seen = {};
    function pushAlias(name, unit, isLocal) {
      var q = qtys[name] || quantityOfUnit(unit);
      var cats, letter;
      if (unit) {
        // V3.425 — a DECLARED unit keeps its single catalog category
        // even when the algebra decomposes it (mg/mL stays C/amount,
        // no pie) — only computed quantities letter by their dims.
        var cat0 = categoryOfUnit(unit);
        cats = [cat0];
        letter = DIMENSION_LETTERS[cat0] || 'X';
      } else {
        cats = dimCategories(q.dim || {});
        letter = cats.length > 1 ? 'Q'
          : cats.length === 1 ? (DIMENSION_LETTERS[cats[0]] || 'X')
            : 'X';
      }
      counters[letter] = (counters[letter] || 0) + 1;
      var entry = {
        alias: letter + counters[letter], name: name, unit: unit || '',
        category: cats.length === 1 ? cats[0] : categoryOfUnit(unit),
        cats: cats, qty: q,
        unitLabel: unit || quantityLabel(q),
      };
      if (isLocal) entry.local = true;
      out.push(entry);
    }
    var allVars = _varsByName(graph);
    ((graph && graph.edges) || []).forEach(function (e) {
      if (e.to !== node.id) return;
      if (edgeRole(e, node.type) !== 'math') return;
      var src = byId[e.from];
      if (!src) return;
      var pv = producedVars(src), v = null;
      for (var i = 0; i < pv.length; i++) if (pv[i].key === e.sourceVar) v = pv[i];
      // V3.423 — the from node may merely PASS the var through
      if (!v && e.sourceVar && allVars[e.sourceVar]) v = allVars[e.sourceVar];
      if (!v) v = pv[0];
      if (!v || seen[v.key]) return;
      seen[v.key] = true;
      pushAlias(v.key, v.unit || '', false);
    });
    // V3.417 — earlier results of THIS node are legal operands in later
    // results: pass uptoResultIndex to append them as local aliases
    if (typeof uptoResultIndex === 'number' && node.type === 'equation') {
      _eqResults(node.params).slice(0, uptoResultIndex).forEach(function (r) {
        if (!r || !r.name || seen[r.name]) return;
        seen[r.name] = true;
        pushAlias(r.name, r.unit || '', true);
      });
    }
    return out;
  }
  /* Known function names the tokenizer accepts (existing hand-written
   * or imported exprs keep working); the pad itself only OFFERS √. */
  var FPAD_FUNC_NAMES = ['sqrt', 'abs', 'round', 'min', 'max', 'floor', 'ceil', 'log', 'exp'];
  /* expr string → token list. {ok:false} when the expr uses anything
   * the pad can't represent (unknown functions, stray characters) —
   * the editor then shows it read-only with AC as the way back. */
  function tokenizeExpr(expr) {
    var s = String(expr == null ? '' : expr);
    var toks = [], i = 0;
    var isSpace = /\s/, isDigit = /[0-9.]/, isIdStart = /[A-Za-z_]/, isId = /[A-Za-z0-9_]/;
    while (i < s.length) {
      var c = s[i];
      if (isSpace.test(c)) { i++; continue; }
      if (c === '(') { toks.push({ t: 'open' }); i++; continue; }
      if (c === ')') { toks.push({ t: 'close' }); i++; continue; }
      if (c === ',') { toks.push({ t: 'comma' }); i++; continue; }
      if ('+-*/^'.indexOf(c) >= 0) { toks.push({ t: 'op', v: c }); i++; continue; }
      if (isDigit.test(c)) {
        var j = i;
        while (j < s.length && isDigit.test(s[j])) j++;
        var num = s.slice(i, j);
        if ((num.match(/\./g) || []).length > 1) return { ok: false, tokens: [] };
        toks.push({ t: 'num', v: num });
        i = j; continue;
      }
      if (isIdStart.test(c)) {
        var k = i;
        while (k < s.length && isId.test(s[k])) k++;
        var word = s.slice(i, k);
        var m = k;
        while (m < s.length && isSpace.test(s[m])) m++;
        if (s[m] === '(') {
          if (FPAD_FUNC_NAMES.indexOf(word) < 0) return { ok: false, tokens: [] };
          toks.push({ t: 'func', v: word });
          i = m + 1; continue;
        }
        toks.push({ t: 'var', name: word });
        i = k; continue;
      }
      return { ok: false, tokens: [] };
    }
    return { ok: true, tokens: toks };
  }
  function serializeTokens(tokens) {
    var out = '';
    (tokens || []).forEach(function (tk) {
      if (tk.t === 'var') out += tk.name;
      else if (tk.t === 'num') out += tk.v;
      else if (tk.t === 'op') out += ' ' + tk.v + ' ';
      else if (tk.t === 'open') out += '(';
      else if (tk.t === 'close') out += ')';
      else if (tk.t === 'comma') out += ', ';
      else if (tk.t === 'func') out += tk.v + '(';
    });
    return out.replace(/\s+/g, ' ').trim();
  }
  /* Click grammar: what may legally come next. The pad greys everything
   * else, so an unfinished or malformed formula can't be clicked into
   * existence (unary minus is the pad-side exception: − is also allowed
   * at operand position). */
  function fpadNextAllowed(tokens) {
    var toks = tokens || [];
    var depth = 0;
    toks.forEach(function (tk) {
      if (tk.t === 'open' || tk.t === 'func') depth++;
      else if (tk.t === 'close') depth--;
    });
    var last = toks.length ? toks[toks.length - 1] : null;
    var operandPos = !last || last.t === 'op' || last.t === 'open' || last.t === 'func' || last.t === 'comma';
    return {
      operand: operandPos,
      operator: !operandPos,
      close: !operandPos && depth > 0,
      complete: !operandPos && depth === 0 && toks.length > 0,
    };
  }

  /* ── Dimensional consistency (V3.417) ─────────────────────────
   * Dimensions are exponent maps over the unit categories
   * ({volume:1, amount:-1} = volume per amount). Ratio/unitless map to
   * {}. Checks are at the DIMENSION level — µL vs mL is the same
   * dimension (magnitude conversion is out of scope). */
  function dimOfUnit(unit) {
    var cat = categoryOfUnit(unit);
    if (cat === 'none' || cat === 'ratio' || cat === 'other' || cat === 'categorical') return {};
    var d = {};
    d[cat] = 1;
    return d;
  }
  /* V3.418 — MAGNITUDE tracking. Values in the symbol table are raw
   * numbers, so µL + mL is numerically wrong even though the dimension
   * matches: every catalog unit carries a multiplicative scale to its
   * category base, and non-interconvertible families sharing a category
   * (molar vs moles vs mass-concentration; °C/K/°F, which are offset
   * scales) carry a KIND. Unknown/custom units have scale null — the
   * checker falls back to dimension-only for them (no false alarms). */
  var UNIT_SCALES = {
    nL: 1e-9, 'µL': 1e-6, uL: 1e-6, mL: 1e-3, cL: 1e-2, dL: 1e-1, L: 1, kL: 1e3,
    pg: 1e-12, ng: 1e-9, 'µg': 1e-6, ug: 1e-6, mg: 1e-3, g: 1, kg: 1e3,
    pm: 1e-12, nm: 1e-9, 'µm': 1e-6, um: 1e-6, mm: 1e-3, cm: 1e-2, m: 1, km: 1e3,
    'µm2': 1e-12, um2: 1e-12, mm2: 1e-6, cm2: 1e-4, m2: 1,
    ms: 1e-3, s: 1, sec: 1, min: 60, h: 3600, hr: 3600, hour: 3600, d: 86400, day: 86400, wk: 604800, week: 604800,
    pM: 1e-12, nM: 1e-9, 'µM': 1e-6, uM: 1e-6, mM: 1e-3, M: 1,
    nmol: 1e-9, 'µmol': 1e-6, umol: 1e-6, mmol: 1e-3, mol: 1,
    'mg/mL': 1, 'g/L': 1,
    '%': 1, x: 1, '×': 1, X: 1, fraction: 1, ratio: 1, AU: 1, au: 1, '1': 1,
    '°C': 1, C: 1, K: 1, '°F': 1, F: 1,
  };
  /* V3.425 — molar/moles/massconc kinds RETIRED: those families now
   * DECOMPOSE (M → mol/L, mg/mL → mg per mL), so their dims differ and
   * dimension checks distinguish them exactly. Keeping the kinds would
   * be wrong post-decomposition (M × L IS mol, but a lingering 'molar'
   * kind would fight mmol's 'moles'). Temperatures keep kinds — same
   * dim, non-multiplicative offset scales. */
  var UNIT_KINDS = {
    '°C': 'degC', C: 'degC', K: 'degK', '°F': 'degF', F: 'degF',
  };
  function _unitLookup(map, u) {
    if (map.hasOwnProperty(u)) return map[u];
    var n = u.replace(/µ/g, 'u').replace(/²/g, '2');
    if (map.hasOwnProperty(n)) return map[n];
    return undefined;
  }
  /* V3.422 — canonical unit spelling (µL over uL, µm² over um2) so
   * unit-NAME algebra cancels across nodes no matter how a unit was
   * typed. Non-catalog units pass through as-typed. */
  var _CANON_UNITS = (function () {
    function score(k) { return (/µ/.test(k) ? 1 : 0) + (/²/.test(k) ? 1 : 0); }
    var m = {};
    Object.keys(UNIT_MAP).forEach(function (k) {
      var norm = k.replace(/µ/g, 'u').replace(/²/g, '2');
      if (!m.hasOwnProperty(norm) || score(k) > score(m[norm])) m[norm] = k;
    });
    return m;
  })();
  function canonicalUnit(unit) {
    var u = String(unit == null ? '' : unit).trim();
    if (!u) return '';
    var norm = u.replace(/µ/g, 'u').replace(/²/g, '2');
    return _CANON_UNITS.hasOwnProperty(norm) ? _CANON_UNITS[norm] : u;
  }
  /* unit string → {dim, scale, kinds, units}. scale null = unknown
   * magnitude. `units` (V3.422) is an exponent map over canonical unit
   * NAMES ({µL:1}) composed through ×/÷/^ exactly like dims — matching
   * names cancel (µL·mol / mol → µL), so a composite unit born in one
   * node survives the chain into the next and collapses back to a
   * single unit when the math cancels it. Only dimensional units enter
   * the map; ratio/custom units are dimensionless by convention
   * (mirrors dimOfUnit). */
  /* V3.425 — ratio units DECOMPOSE. A declared mg/mL used to be an
   * atomic 'amount' quantity, so result1(mg/mL) × volume could never
   * cancel back to mass (Alex's repro). Now any A/B whose halves are
   * both dimensional catalog units becomes the true quotient
   * ({mass:1, volume:-1}, units {mg:1, mL:-1}), and the molar family
   * becomes mol/L at its scale — so concentration × volume collapses
   * to mass/moles like it should. The unit's CATEGORY (colors, Type
   * dropdown, C letter for declared inputs) is untouched. */
  var _MOLAR_UNITS = { M: 1, mM: 1, 'µM': 1, uM: 1, nM: 1, pM: 1 };
  function _dimensionalCat(cat) {
    return cat !== 'none' && cat !== 'ratio' && cat !== 'other' && cat !== 'categorical';
  }
  function quantityOfUnit(unit) {
    var u = String(unit == null ? '' : unit).trim();
    if (u === '') return { dim: {}, scale: 1, kinds: {}, units: {} };
    // molar family → amount per volume (mol/L), scale already the ratio
    if (_unitLookup(_MOLAR_UNITS, u)) {
      var mscale = _unitLookup(UNIT_SCALES, u);
      return { dim: { amount: 1, volume: -1 }, scale: (mscale === undefined ? null : mscale),
               kinds: {}, units: { mol: 1, L: -1 } };
    }
    // generic A/B compounds (mg/mL, g/L, hand-typed µg/µL …); V3.428 —
    // a numerator of literal '1' works too (1/mol = per mole)
    var slash = u.indexOf('/');
    if (slash > 0 && u.indexOf('/', slash + 1) < 0) {
      var numU = u.slice(0, slash).trim(), denU = u.slice(slash + 1).trim();
      var numOne = numU === '1';
      if ((numOne || _dimensionalCat(categoryOfUnit(numU))) && _dimensionalCat(categoryOfUnit(denU))) {
        var sN = numOne ? 1 : _unitLookup(UNIT_SCALES, numU), sD = _unitLookup(UNIT_SCALES, denU);
        var cN = numOne ? '' : canonicalUnit(numU), cD = canonicalUnit(denU);
        var units2 = {};
        if (cN) units2[cN] = 1;
        units2[cD] = (units2[cD] || 0) - 1; // cN === cD (mL/mL) → nets to 0
        Object.keys(units2).forEach(function (k) { if (!units2[k]) delete units2[k]; });
        return {
          dim: dimDiv(numOne ? {} : dimOfUnit(numU), dimOfUnit(denU)),
          scale: (sN === undefined || sD === undefined) ? null : sN / sD,
          kinds: {},
          units: unitsCollapse(units2),
        };
      }
    }
    var dim = dimOfUnit(u);
    var scale = _unitLookup(UNIT_SCALES, u);
    var kind = _unitLookup(UNIT_KINDS, u);
    var kinds = {};
    if (kind) kinds[kind] = 1;
    var units = {};
    if (Object.keys(dim).length) units[canonicalUnit(u)] = 1;
    return { dim: dim, scale: (scale === undefined ? null : scale), kinds: kinds, units: units };
  }
  function _dimClean(d) {
    var out = {};
    Object.keys(d).forEach(function (k) { if (d[k]) out[k] = d[k]; });
    return out;
  }
  function dimMul(a, b) {
    var out = {};
    Object.keys(a).forEach(function (k) { out[k] = (out[k] || 0) + a[k]; });
    Object.keys(b).forEach(function (k) { out[k] = (out[k] || 0) + b[k]; });
    return _dimClean(out);
  }
  function dimDiv(a, b) {
    var out = {};
    Object.keys(a).forEach(function (k) { out[k] = (out[k] || 0) + a[k]; });
    Object.keys(b).forEach(function (k) { out[k] = (out[k] || 0) - b[k]; });
    return _dimClean(out);
  }
  function dimPow(a, k) {
    var out = {};
    Object.keys(a).forEach(function (key) { out[key] = a[key] * k; });
    return _dimClean(out);
  }
  function dimsEqual(a, b) {
    var ka = Object.keys(a), kb = Object.keys(b);
    if (ka.length !== kb.length) return false;
    return ka.every(function (k) { return a[k] === b[k]; });
  }
  function dimCategories(d) {
    var order = UNIT_TYPE_ORDER;
    return Object.keys(d).sort(function (x, y) { return order.indexOf(x) - order.indexOf(y); });
  }
  function dimLabel(d) {
    var num = [], den = [];
    dimCategories(d).forEach(function (k) {
      var e = d[k], abs = Math.abs(e);
      var t = k + (abs > 1 ? '^' + abs : '');
      (e > 0 ? num : den).push(t);
    });
    if (!num.length && !den.length) return 'unitless';
    return (num.length ? num.join('·') : '1') + (den.length ? ' / ' + den.join('·') : '');
  }
  /* V3.426 — canonical NAMES for recognizable derived dimensions. A
   * mixed variable keeps its constituent pie colors (the legend stays
   * fundamental-categories-only, by design) but is CALLED what it is
   * wherever its dimension is described: mass/volume = density,
   * amount/volume = concentration, area/time = diffusivity … Exact
   * match on the exponent map; unnamed combinations fall back to the
   * spelled-out dimLabel. */
  var DERIVED_DIM_NAMES = [
    [{ mass: 1, volume: -1 }, 'density'],
    [{ amount: 1, volume: -1 }, 'concentration'],
    [{ mass: 1, amount: -1 }, 'molar mass'],
    [{ volume: 1, amount: -1 }, 'molar volume'],
    [{ length: 1, time: -1 }, 'speed'],
    [{ length: 1, time: -2 }, 'acceleration'],
    [{ volume: 1, time: -1 }, 'flow rate'],
    [{ mass: 1, time: -1 }, 'mass flow'],
    [{ amount: 1, time: -1 }, 'molar flow'],
    [{ amount: 1, volume: -1, time: -1 }, 'reaction rate'],
    [{ area: 1, time: -1 }, 'diffusivity'],
    [{ mass: 1, area: -1 }, 'surface density'],
    [{ amount: 1, area: -1 }, 'surface concentration'],
    [{ mass: 1, length: -1 }, 'linear density'],
    [{ volume: 1, mass: -1 }, 'specific volume'],
    [{ area: 1, volume: -1 }, 'surface-to-volume'],
    [{ temperature: 1, time: -1 }, 'heating rate'],
    [{ time: -1 }, 'frequency'],
    [{ volume: -1 }, 'per volume'],
  ];
  function dimName(d) {
    if (!d) return '';
    for (var i = 0; i < DERIVED_DIM_NAMES.length; i++) {
      if (dimsEqual(DERIVED_DIM_NAMES[i][0], d)) return DERIVED_DIM_NAMES[i][1];
    }
    return '';
  }
  /* The human way to SAY a dimension: its canonical name when one
   * exists, else the spelled-out compound. */
  function dimDisplay(d) {
    return dimName(d) || dimLabel(d);
  }
  /* V3.425 — fold a cancellation the dim algebra already performed:
   * when ONE category holds names of OPPOSITE signs (µL·…/mL), those
   * names differ only by magnitude — which `scale` tracks — so the
   * map reduces to the net exponent on the dominant name (net 0 →
   * gone). Same-sign names (µL·mL) are left alone: nothing cancelled. */
  function unitsCollapse(units) {
    var keys = Object.keys(units || {});
    if (keys.length < 2) return units || {};
    var byCat = {};
    keys.forEach(function (k) {
      var c = categoryOfUnit(k);
      (byCat[c] = byCat[c] || []).push(k);
    });
    var out = {};
    Object.keys(byCat).forEach(function (cat) {
      var names = byCat[cat];
      var hasPos = names.some(function (k) { return units[k] > 0; });
      var hasNeg = names.some(function (k) { return units[k] < 0; });
      if (names.length < 2 || !hasPos || !hasNeg) {
        names.forEach(function (k) { out[k] = units[k]; });
        return;
      }
      var net = 0, dom = names[0];
      names.forEach(function (k) {
        net += units[k];
        if (Math.abs(units[k]) > Math.abs(units[dom])) dom = k;
      });
      if (net) out[dom] = net;
    });
    return out;
  }
  /* Composite unit label from an exponent map over unit names:
   * {µL:1, mol:-1} → "µL / mol"; squares/cubes render as ²/³. Ordered
   * by the category wheel then name, so labels are stable. */
  function unitsLabel(units) {
    var keys = Object.keys(units || {});
    if (!keys.length) return '';
    var order = UNIT_TYPE_ORDER;
    keys.sort(function (x, y) {
      var cx = order.indexOf(categoryOfUnit(x)), cy = order.indexOf(categoryOfUnit(y));
      if (cx !== cy) return cx - cy;
      return x < y ? -1 : x > y ? 1 : 0;
    });
    function sup(e) { return e === 2 ? '²' : e === 3 ? '³' : '^' + e; }
    var num = [], den = [];
    keys.forEach(function (k) {
      var e = units[k], abs = Math.abs(e);
      var t = k + (abs !== 1 ? sup(abs) : '');
      (e > 0 ? num : den).push(t);
    });
    return (num.length ? num.join('·') : '1') + (den.length ? ' / ' + den.join('·') : '');
  }
  /* Human label for a resolved quantity: its composite unit when the
   * name algebra tracked one, else the dimension ("volume·amount") for
   * dim-only quantities, else '' (true unitless). */
  function quantityLabel(q) {
    if (!q) return '';
    var ul = unitsLabel(q.units);
    if (ul) return ul;
    if (q.dim && Object.keys(q.dim).length) return dimLabel(q.dim);
    return '';
  }
  /* Recursive-descent dimensional check over a formula-pad token list.
   * dimByName: variable name → dim map. Returns {ok, dim, warnings[]}
   * — mismatches WARN (with the offending combination named) rather
   * than hard-fail; malformed token streams return ok:false and are
   * simply not checked. */
  function checkTokenDims(tokens, qtyByName) {
    var toks = tokens || [];
    var pos = 0;
    var warnings = [];
    // per-name entries may be full quantities ({dim, scale, kinds}) or
    // plain dim maps (legacy callers/tests) → normalize; plain maps get
    // scale null so magnitude checking simply stays silent for them
    function normQ(v) {
      if (v && v.dim) return { dim: v.dim, scale: (v.scale === undefined ? null : v.scale), kinds: v.kinds || {}, units: v.units || {} };
      return { dim: v || {}, scale: null, kinds: {}, units: {} };
    }
    var ONE = function () { return { dim: {}, scale: 1, kinds: {}, units: {} }; };
    function qMulOp(a, b, div) {
      return {
        dim: div ? dimDiv(a.dim, b.dim) : dimMul(a.dim, b.dim),
        scale: (a.scale == null || b.scale == null) ? null : (div ? a.scale / b.scale : a.scale * b.scale),
        kinds: div ? dimDiv(a.kinds, b.kinds) : dimMul(a.kinds, b.kinds),
        units: unitsCollapse(div ? dimDiv(a.units, b.units) : dimMul(a.units, b.units)),
      };
    }
    function qPow(a, k) {
      return {
        dim: dimPow(a.dim, k),
        scale: (a.scale == null) ? null : Math.pow(a.scale, k),
        kinds: dimPow(a.kinds, k),
        units: dimPow(a.units, k),
      };
    }
    function _scaleEq(a, b) {
      if (a === b) return true;
      var hi = Math.max(Math.abs(a), Math.abs(b));
      return hi === 0 || Math.abs(a - b) / hi < 1e-9;
    }
    function _fmtRatio(r) {
      var v = r >= 1 ? r : 1 / r;
      if (v >= 1e5) return v.toExponential(0).replace('e+', 'e');
      return (Math.round(v * 100) / 100).toString();
    }
    // same-dimension combination (+, −, min, max): kinds must match
    // (molar vs mass-conc can't convert) and known magnitudes must agree
    function addCheck(a, b, what) {
      if (!dimsEqual(a.dim, b.dim)) {
        warnings.push(what + ' ' + dimDisplay(a.dim) + ' to ' + dimDisplay(b.dim));
        return a;
      }
      if (!dimsEqual(a.kinds, b.kinds)) {
        warnings.push(what + ' incompatible unit families (°C vs K — offset temperature scales)');
        return a;
      }
      if (a.scale != null && b.scale != null && !_scaleEq(a.scale, b.scale)) {
        warnings.push(what + ' values whose magnitudes differ ×' + _fmtRatio(a.scale / b.scale) + ' (µL vs mL style) — convert one side first');
      }
      return a;
    }
    function peek() { return toks[pos] || null; }
    function next() { return toks[pos++] || null; }
    function parseAtom() {
      var tk = next();
      if (!tk) return null;
      if (tk.t === 'op' && tk.v === '-') { // unary minus
        return parseAtom();
      }
      if (tk.t === 'num') return ONE();
      if (tk.t === 'var') return normQ(qtyByName[tk.name]);
      if (tk.t === 'open') {
        var q = parseExpr();
        if (peek() && peek().t === 'close') next();
        return q;
      }
      if (tk.t === 'func') {
        var args = [];
        var a = parseExpr();
        if (a !== null) args.push(a);
        while (peek() && peek().t === 'comma') { next(); args.push(parseExpr()); }
        if (peek() && peek().t === 'close') next();
        var fn = tk.v, q0 = args[0] || ONE();
        if (fn === 'sqrt') {
          var odd = Object.keys(q0.dim).some(function (k) { return q0.dim[k] % 2 !== 0; });
          if (odd) warnings.push('sqrt of a non-square dimension (' + dimDisplay(q0.dim) + ')');
          return qPow(q0, 0.5);
        }
        if (fn === 'log' || fn === 'exp') {
          if (Object.keys(q0.dim).length) warnings.push(fn + '() needs a unitless argument, got ' + dimDisplay(q0.dim));
          return ONE();
        }
        if (fn === 'min' || fn === 'max') {
          for (var i = 1; i < args.length; i++) {
            addCheck(q0, args[i] || ONE(), fn + '() mixes');
          }
          return q0;
        }
        return q0; // abs/round/floor/ceil pass through
      }
      return ONE();
    }
    function parsePow() {
      var base = parseAtom();
      if (base === null) return null;
      while (peek() && peek().t === 'op' && peek().v === '^') {
        next();
        var expTok = peek();
        var exp = parsePow(); // right-assoc
        if (exp === null) break;
        if (Object.keys(exp.dim).length) {
          warnings.push('exponent must be unitless, got ' + dimDisplay(exp.dim));
        }
        if (Object.keys(base.dim).length || (base.scale != null && base.scale !== 1)) {
          if (expTok && expTok.t === 'num') {
            base = qPow(base, parseFloat(expTok.v));
          } else {
            warnings.push('raising ' + dimDisplay(base.dim) + ' to a non-constant power — dimension unknown');
          }
        }
      }
      return base;
    }
    function parseTerm() {
      var q = parsePow();
      if (q === null) return null;
      while (peek() && peek().t === 'op' && (peek().v === '*' || peek().v === '/')) {
        var op = next().v;
        var r = parsePow();
        if (r === null) break;
        q = qMulOp(q, r, op === '/');
      }
      return q;
    }
    function parseExpr() {
      var q = parseTerm();
      if (q === null) return null;
      while (peek() && peek().t === 'op' && (peek().v === '+' || peek().v === '-')) {
        next();
        var r = parseTerm();
        if (r === null) break;
        q = addCheck(q, r, 'adding');
      }
      return q;
    }
    if (!toks.length) return { ok: false, dim: {}, scale: null, kinds: {}, units: {}, warnings: [] };
    var q = parseExpr();
    if (q === null || pos < toks.length) return { ok: false, dim: {}, scale: null, kinds: {}, units: {}, warnings: warnings };
    return { ok: true, dim: q.dim, scale: q.scale, kinds: q.kinds, units: q.units, warnings: warnings };
  }

  /* ── Graph-wide quantity resolution (V3.422) ─────────────────
   * Topo-order walk returning {varName → quantity} for every produced
   * variable in the graph. Declared units resolve directly (marked
   * `declared`); an equation result with NO declared unit gets the
   * quantity its formula COMPUTES from its already-resolved operands
   * (marked `computed: true`) — so a composite unit born in one node
   * plugs into the next, keeps combining, and cancels back down when
   * the math does. Unresolvable results (pad-unrepresentable exprs,
   * cycles) fall back to an unknown unitless quantity. */
  function resolveQuantities(graph) {
    var nodes = (graph && Array.isArray(graph.nodes)) ? graph.nodes : [];
    var edges = ((graph && Array.isArray(graph.edges)) ? graph.edges : []).filter(function (e) { return !!e; });
    var byId = {};
    nodes.forEach(function (n) { byId[n.id] = n; });
    edges = edges.filter(function (e) { return byId[e.from] && byId[e.to]; });
    var topo = topoSort({ nodes: nodes, edges: edges });
    var order = topo.order || nodes.map(function (n) { return n.id; });
    var qtys = {};
    order.forEach(function (id) {
      var n = byId[id];
      if (!n) return;
      if (n.type === 'equation') {
        _eqResults(n.params || {}).forEach(function (r) {
          if (!r || !r.name) return;
          if (r.unit) {
            qtys[r.name] = quantityOfUnit(r.unit);
            qtys[r.name].declared = r.unit;
            return;
          }
          var parsed = tokenizeExpr(r.expr || '');
          if (parsed.ok && parsed.tokens.length) {
            var chk = checkTokenDims(parsed.tokens, qtys);
            if (chk.ok) {
              qtys[r.name] = { dim: chk.dim, scale: chk.scale, kinds: chk.kinds, units: chk.units || {}, computed: true };
              return;
            }
          }
          qtys[r.name] = { dim: {}, scale: null, kinds: {}, units: {}, computed: false };
        });
      } else {
        producedVars(n).forEach(function (v) {
          qtys[v.key] = quantityOfUnit(v.unit);
          if (v.unit) qtys[v.key].declared = v.unit;
        });
      }
    });
    return qtys;
  }

  /* Variables a node PRODUCES (its output sockets), each with unit +
   * derived category. */
  function producedVars(node) {
    var p = (node && node.params) || {};
    switch (node && node.type) {
      case 'input':
      case 'constant':
        return p.name ? [{ key: p.name, label: p.label || p.name, unit: p.unit || '', category: categoryOfUnit(p.unit) }] : [];
      case 'choices':
        return p.field ? [{ key: p.field, label: p.label || p.field, unit: '', category: 'categorical' }] : [];
      case 'ordered':
        return (Array.isArray(p.items) ? p.items : []).filter(function (it) { return it && it.name; })
          .map(function (it) { return { key: it.name, label: it.label || it.name, unit: it.unit || p.unit || '', category: categoryOfUnit(it.unit || p.unit) }; });
      case 'equation':
        return _eqResults(p).filter(function (r) { return r && r.name; })
          .map(function (r) { return { key: r.name, label: r.label || r.name, unit: r.unit || '', category: categoryOfUnit(r.unit) }; });
      case 'code':
        return (Array.isArray(p.outputs) ? p.outputs : []).filter(function (o) { return o && o.name; })
          .map(function (o) { return { key: o.name, label: o.label || o.name, unit: o.unit || '', category: categoryOfUnit(o.unit) }; });
      default:
        return [];
    }
  }

  /* All produced vars in the graph keyed by (globally unique) name. */
  function _varsByName(graph) {
    var m = {};
    ((graph && graph.nodes) || []).forEach(function (n) {
      producedVars(n).forEach(function (v) { if (!m[v.key]) m[v.key] = v; });
    });
    return m;
  }

  /* ── Pass-through re-export (V3.423) ─────────────────────────
   * Variables a node RECEIVES on its left side (math operands + param
   * drivers) are re-exported on its right side, so downstream nodes
   * can chain from the nearest card instead of tracing a wire all the
   * way back to the producer. An edge may therefore carry a sourceVar
   * its `from` node merely passes through — resolution falls back to
   * the graph-wide name table (names are validated unique). Structural
   * feeds are excluded (compile reads a list generator's node TYPE, so
   * generators must wire from their true producer), as are names the
   * node itself produces. Edge order, deduped; chains re-export too. */
  function passThroughVars(graph, node) {
    if (!node) return [];
    var byId = {};
    ((graph && graph.nodes) || []).forEach(function (n) { byId[n.id] = n; });
    var all = _varsByName(graph);
    var own = {};
    producedVars(node).forEach(function (v) { own[v.key] = true; });
    var out = [], seen = {};
    ((graph && graph.edges) || []).forEach(function (e) {
      if (e.to !== node.id) return;
      var role = edgeRole(e, node.type);
      if (role !== 'math' && role !== 'param') return;
      var src = byId[e.from];
      var pv = src ? producedVars(src) : [];
      var v = null;
      for (var i = 0; i < pv.length; i++) if (pv[i].key === e.sourceVar) v = pv[i];
      if (!v && e.sourceVar && all[e.sourceVar]) v = all[e.sourceVar];
      if (!v) v = pv[0];
      if (!v || own[v.key] || seen[v.key]) return;
      seen[v.key] = true;
      out.push({ key: v.key, label: v.label, unit: v.unit || '', category: v.category, passThrough: true });
    });
    return out;
  }

  /* ── Output gates (V3.434) ───────────────────────────────────
   * 📊 Cards / 🔗 References nodes GATE what the document shows: a
   * cards node's wired variables render as the calculator's hero
   * cards; a refs node's variables are offered by the editor's 🔗
   * reference picker — and card variables are automatically
   * referencable too (the picker lists both group kinds). STRICT: no
   * cards node → no cards; no gate nodes → the picker offers nothing.
   * Prose [!var:] tokens are NOT gated — everything still computes;
   * the gate governs what is OFFERED. Per-item vars are skipped here
   * (they aren't scalar symbols; compile warns). */
  function displayGroups(graph) {
    var nodes = (graph && Array.isArray(graph.nodes)) ? graph.nodes : [];
    var edges = ((graph && Array.isArray(graph.edges)) ? graph.edges : []).filter(function (e) { return !!e; });
    var gateNodes = nodes.filter(function (n) { return n && (n.type === 'cards' || n.type === 'refs'); });
    if (!gateNodes.length) return [];
    var byId = {};
    nodes.forEach(function (n) { byId[n.id] = n; });
    edges = edges.filter(function (e) { return byId[e.from] && byId[e.to]; });
    var sub = { nodes: nodes, edges: edges };
    var all = _varsByName(graph);
    var scopes = inferScopes(sub);
    var qtys = resolveQuantities(graph);
    var producerOf = {};
    nodes.forEach(function (nn) {
      producedVars(nn).forEach(function (v) { if (!producerOf[v.key]) producerOf[v.key] = nn.id; });
    });
    return gateNodes.map(function (gn) {
      var seen = {}, vars = [];
      edges.forEach(function (e) {
        if (e.to !== gn.id) return;
        var src = byId[e.from];
        var pv = src ? producedVars(src) : [];
        var v = null;
        for (var i = 0; i < pv.length; i++) if (pv[i].key === e.sourceVar) v = pv[i];
        if (!v && e.sourceVar && all[e.sourceVar]) v = all[e.sourceVar]; // pass-through
        if (!v) v = pv[0];
        if (!v || seen[v.key]) return;
        if (scopes[producerOf[v.key]] === 'item') return;
        seen[v.key] = true;
        var q = qtys[v.key];
        var unit = v.unit || ((q && q.computed) ? quantityLabel(q) : '');
        vars.push({ name: v.key, label: v.label || v.key, unit: unit });
      });
      return {
        nodeId: gn.id, type: gn.type,
        label: (gn.params && gn.params.label) || (gn.type === 'cards' ? 'Results' : 'References'),
        vars: vars,
      };
    });
  }

  /* Numeric settings a node exposes as parameter-binding targets. */
  function paramTargets(node) {
    switch (node && node.type) {
      case 'input':    return [{ field: 'min', label: 'Min' }, { field: 'max', label: 'Max' }, { field: 'step', label: 'Step' }, { field: 'default', label: 'Default' }];
      case 'constant': return [{ field: 'value', label: 'Value' }];
      case 'equation': return [{ field: 'decimals', label: 'Decimals' }];
      default:         return [];
    }
  }

  /* Declared LEFT-dot input slots for a node — independent of any edge,
   * so the editor can draw plug-in sockets before a wire exists. Derived
   * mechanically from paramTargets (+ per-type dynamic ports), so it can
   * never offer a slot compile() wouldn't accept. Each slot:
   *   { kind, role, paramField?, label, dynamic?, arity:'one'|'many' }
   * - param slots (kind 'param') drive a settable field (arity one).
   * - a 'math' slot (equation) accepts operands (arity many, re-spawns).
   * - a 'structural' slot (list) accepts feeds (arity many, re-spawns).
   * choices / ordered have no driveable input slots. */
  function inputSlots(node) {
    var t = node && node.type;
    var slots = paramTargets(node).map(function (pt) {
      return { kind: 'param', role: 'param', paramField: pt.field, label: pt.label, arity: 'one' };
    });
    if (t === 'equation') slots.push({ kind: 'math', role: 'math', label: 'math input', dynamic: true, arity: 'many' });
    if (t === 'code') slots.push({ kind: 'math', role: 'math', label: 'argument', dynamic: true, arity: 'many' });
    if (t === 'list') slots.push({ kind: 'structural', role: 'structural', label: 'items', dynamic: true, arity: 'many' });
    if (t === 'cards') slots.push({ kind: 'display', role: 'display', label: 'variable to show as a card', dynamic: true, arity: 'many' });
    if (t === 'refs') slots.push({ kind: 'display', role: 'display', label: 'variable to offer inline', dynamic: true, arity: 'many' });
    return slots;
  }

  /* Input + output sockets for a node given the whole graph (needs the
   * graph to resolve each incoming edge's source variable + its unit
   * category). Inputs render on the left, outputs on the right. */
  function nodeSockets(node, graph) {
    var byId = {};
    (graph.nodes || []).forEach(function (n) { byId[n.id] = n; });
    var allVars = _varsByName(graph);
    var outputs = producedVars(node);
    var inputs = (graph.edges || []).filter(function (e) { return e.to === node.id; }).map(function (e) {
      var src = byId[e.from];
      var srcVars = producedVars(src);
      var sv = e.sourceVar
        ? (srcVars.filter(function (v) { return v.key === e.sourceVar; })[0] || allVars[e.sourceVar] || srcVars[0])
        : srcVars[0];
      var role = edgeRole(e, node.type);
      return {
        key: e.id,
        edgeId: e.id,
        from: e.from,
        sourceVar: (sv && sv.key) || e.sourceVar || '',
        label: (sv && sv.label) || e.sourceVar || '(input)',
        category: sv ? sv.category : 'other',
        role: role,
        paramField: e.paramField || '',
      };
    });
    return { inputs: inputs, outputs: outputs };
  }

  /* ── Topology ─────────────────────────────────────────────────── */

  /* Kahn's algorithm. Returns {order: [nodeId…]} or {cycle: [nodeId…]}. */
  function topoSort(graph) {
    var indeg = {};
    var adj = {};
    graph.nodes.forEach(function (n) { indeg[n.id] = 0; adj[n.id] = []; });
    graph.edges.forEach(function (e) {
      indeg[e.to]++;
      adj[e.from].push(e.to);
    });
    var queue = [];
    graph.nodes.forEach(function (n) { if (indeg[n.id] === 0) queue.push(n.id); });
    var order = [];
    while (queue.length) {
      var id = queue.shift();
      order.push(id);
      adj[id].forEach(function (t) {
        if (--indeg[t] === 0) queue.push(t);
      });
    }
    if (order.length !== graph.nodes.length) {
      var cycle = graph.nodes.map(function (n) { return n.id; })
        .filter(function (id) { return order.indexOf(id) < 0; });
      return { order: null, cycle: cycle };
    }
    return { order: order, cycle: null };
  }

  /* Would adding from→to close a cycle? (Is `from` reachable FROM `to`?) */
  function wouldCycle(graph, fromNodeId, toNodeId) {
    if (fromNodeId === toNodeId) return true;
    var adj = {};
    graph.nodes.forEach(function (n) { adj[n.id] = []; });
    graph.edges.forEach(function (e) { if (adj[e.from]) adj[e.from].push(e.to); });
    var stack = [toNodeId];
    var seen = {};
    while (stack.length) {
      var id = stack.pop();
      if (id === fromNodeId) return true;
      if (seen[id]) continue;
      seen[id] = true;
      (adj[id] || []).forEach(function (t) { stack.push(t); });
    }
    return false;
  }

  /* ── Scope inference ──────────────────────────────────────────
   * A node is per-item ('item') iff it is a generator (choices/
   * ordered) or any wired input is per-item; else 'scalar'. The list
   * terminal is '—' (it consumes both). Propagated in topo order. */
  function inferScopes(graph, topo) {
    topo = topo || topoSort(graph);
    var scope = {};
    var byId = {};
    graph.nodes.forEach(function (n) { byId[n.id] = n; });
    // Only math/structural bindings carry per-item scope; param + none
    // bindings are scalar settings and don't make a target per-item.
    var inEdges = {};
    graph.edges.forEach(function (e) {
      var role = edgeRole(e, byId[e.to] && byId[e.to].type);
      if (role === 'param' || role === 'none' || role === 'display') return;
      (inEdges[e.to] = inEdges[e.to] || []).push(e.from);
    });
    (topo.order || []).forEach(function (id) {
      var n = byId[id];
      if (n.type === 'choices' || n.type === 'ordered') { scope[id] = 'item'; return; }
      if (n.type === 'list') { scope[id] = 'list'; return; }
      var perItem = (inEdges[id] || []).some(function (src) { return scope[src] === 'item'; });
      scope[id] = perItem ? 'item' : 'scalar';
    });
    return scope;
  }

  /* ── Validation ───────────────────────────────────────────────── */

  function _nodeName(n) {
    var p = n.params || {};
    return p.name || p.field || p.label || n.id;
  }

  function validateGraph(graph) {
    var errors = [];
    var warnings = [];
    var topo = topoSort(graph);
    if (topo.cycle) {
      errors.push('Cycle detected involving: ' + topo.cycle.join(', '));
      return { errors: errors, warnings: warnings, topo: topo };
    }
    var names = {};
    graph.nodes.forEach(function (n) {
      var p = n.params || {};
      if (n.type === 'input' || n.type === 'constant') {
        if (!p.name) errors.push(n.type + ' node ' + n.id + ' needs a variable name.');
        else if (names[p.name]) errors.push('Duplicate variable name "' + p.name + '".');
        else names[p.name] = true;
      }
      if (n.type === 'equation') {
        var rs = _eqResults(p);
        var named = rs.filter(function (r) { return r && r.name; });
        if (!named.length) errors.push('equation node ' + n.id + ' needs a variable name.');
        named.forEach(function (r) {
          if (names[r.name]) errors.push('Duplicate variable name "' + r.name + '".');
          else names[r.name] = true;
          if (!r.expr) warnings.push('Equation result "' + r.name + '" has no expression.');
        });
      }
      if (n.type === 'choices') {
        if (!p.field) errors.push('Choices node ' + n.id + ' needs a field name.');
        if (!Array.isArray(p.options) || !p.options.length) {
          warnings.push('Choices "' + _nodeName(n) + '" has no options.');
        }
      }
      if (n.type === 'ordered') {
        if (!p.field) errors.push('Ordered-set node ' + n.id + ' needs a field name.');
        var items = Array.isArray(p.items) ? p.items : [];
        if (!items.length) warnings.push('Ordered set "' + _nodeName(n) + '" has no members.');
        items.forEach(function (it) {
          if (!it || !it.name) errors.push('Ordered-set member in "' + _nodeName(n) + '" needs a name.');
          else if (names[it.name]) errors.push('Duplicate variable name "' + it.name + '".');
          else names[it.name] = true;
        });
      }
      if (n.type === 'list' && !p.name) {
        errors.push('List node ' + n.id + ' needs a list name.');
      }
      if (n.type === 'cards' || n.type === 'refs') {
        var hasWire = graph.edges.some(function (e) { return e.to === n.id; });
        if (!hasWire) {
          warnings.push((n.type === 'cards' ? 'Cards' : 'References') + ' node "' + _nodeName(n) + '" has no variables wired in — it gates nothing.');
        }
      }
      if (n.type === 'code') {
        var couts = Array.isArray(p.outputs) ? p.outputs : [];
        if (!couts.some(function (o) { return o && o.name; })) {
          warnings.push('Code node "' + _nodeName(n) + '" declares no named outputs.');
        }
        if (!p.body || !String(p.body).trim()) {
          warnings.push('Code node "' + _nodeName(n) + '" has an empty script.');
        }
        couts.forEach(function (o) {
          if (!o || !o.name) return;
          if (names[o.name]) errors.push('Duplicate variable name "' + o.name + '".');
          else names[o.name] = true;
        });
      }
    });
    // Binding-role validation. A `math` binding only makes sense on an
    // equation; a `param` binding must name a settable field on the
    // target; structural (list) + none are always fine.
    var byId = {};
    graph.nodes.forEach(function (n) { byId[n.id] = n; });
    graph.edges.forEach(function (e) {
      var to = byId[e.to];
      if (!to) return;
      var role = edgeRole(e, to.type);
      if (role === 'math' && to.type !== 'equation' && to.type !== 'code') {
        errors.push('Math binding into "' + _nodeName(to) + '" (' + to.type + ') — only equations and code nodes take value inputs.');
      } else if (role === 'structural' && to.type !== 'list') {
        errors.push('Structural wire into "' + _nodeName(to) + '" (' + to.type + ') — only a list assembles wired inputs.');
      } else if (role === 'display' && to.type !== 'cards' && to.type !== 'refs') {
        errors.push('Display wire into "' + _nodeName(to) + '" (' + to.type + ') — only 📊 Cards / 🔗 References nodes take display wires.');
      } else if (role === 'param') {
        var fields = paramTargets(to).map(function (t) { return t.field; });
        if (!e.paramField) {
          warnings.push('Parameter binding on "' + _nodeName(to) + '" has no target field selected.');
        } else if (fields.indexOf(e.paramField) < 0) {
          warnings.push('Parameter binding on "' + _nodeName(to) + '" targets unknown field "' + e.paramField + '".');
        }
      }
    });
    return { errors: errors, warnings: warnings, topo: topo };
  }

  /* ── Compile ──────────────────────────────────────────────────
   * → { entries, datasets:[{name, spec}], scopeMap, errors, warnings }
   * `entries` feed ProtocolFormulas.buildSymbolTable unchanged; each
   * dataset spec feeds assembleRows below. Scalar equations are emitted
   * in topological order so cross-references resolve (the kernel
   * evaluates outputs in array order). */
  function compile(graph) {
    graph = normalizeGraph(graph);
    var v = validateGraph(graph);
    if (v.errors.length) {
      return { entries: [], datasets: [], scopeMap: {}, errors: v.errors, warnings: v.warnings };
    }
    var topo = v.topo;
    var scopeMap = inferScopes(graph, topo);
    var qtys = resolveQuantities(graph);
    var byId = {};
    graph.nodes.forEach(function (n) { byId[n.id] = n; });
    var inEdges = {};
    graph.edges.forEach(function (e) {
      (inEdges[e.to] = inEdges[e.to] || []).push(e.from);
    });

    var entries = [];
    var datasets = [];
    var warnings = v.warnings.slice();

    topo.order.forEach(function (id) {
      var n = byId[id];
      var p = n.params || {};
      if (n.type === 'input') {
        entries.push({
          blockId: n.id, label: p.label || p.name || '', description: '', expression: '',
          variables: [{
            name: p.name, label: p.label || p.name,
            default: (typeof p.default === 'number') ? p.default : parseFloat(p.default) || 0,
            unit: p.unit || '',
          }],
          output: null,
          // Widget hints ride alongside (buildSymbolTable ignores them).
          widget: { kind: p.widget || 'slider', min: p.min, max: p.max, step: p.step, rangeHint: p.rangeHint || '' },
        });
      } else if (n.type === 'constant') {
        // A param binding driving `value` turns the constant into a live
        // mirror of the source variable (emitted as a computed output so
        // the kernel keeps it reactive; topo order guarantees the source
        // is defined first).
        var valueDriver = '';
        graph.edges.forEach(function (e) {
          if (e.to !== id || edgeRole(e, 'constant') !== 'param' || e.paramField !== 'value') return;
          var pv = producedVars(byId[e.from]);
          valueDriver = e.sourceVar || (pv[0] && pv[0].key) || valueDriver;
        });
        if (valueDriver) {
          entries.push({
            blockId: n.id, label: p.label || p.name || '', description: '', expression: valueDriver,
            variables: [],
            output: { name: p.name, label: p.label || p.name, unit: p.unit || '', decimals: (typeof p.decimals === 'number') ? p.decimals : 3 },
          });
        } else {
          entries.push({
            blockId: n.id, label: p.label || p.name || '', description: '', expression: '',
            variables: [{
              name: p.name, label: p.label || p.name,
              default: (typeof p.value === 'number') ? p.value : parseFloat(p.value) || 0,
              unit: p.unit || '',
            }],
            output: null,
            widget: { kind: 'constant' },
          });
        }
      } else if (n.type === 'ordered') {
        // Each member is a scalar variable; monotonic constraint derived
        // from order (member i must stay strictly below member i+1).
        var items = Array.isArray(p.items) ? p.items : [];
        var params = items.map(function (it, i) {
          return {
            name: it.name, label: it.label || it.name,
            min: it.min, max: it.max, step: it.step,
            default: (typeof it.default === 'number') ? it.default : parseFloat(it.default) || 0,
            unit: it.unit || p.unit || '',
            lt: (i < items.length - 1) ? items[i + 1].name : '',
          };
        });
        entries.push({
          blockId: n.id, label: p.label || p.field || '', description: '', expression: '',
          variables: params, output: null,
          widget: { kind: 'ordered', params: params },
        });
        n._compiledParams = params; // consumed when a list wires this in
      } else if (n.type === 'equation' && scopeMap[id] === 'scalar') {
        // one entry per result, in declaration order — the symbol table
        // evaluates entries sequentially, so result 2 can use result 1
        _eqResults(p).forEach(function (r, ri) {
          if (!r || !r.name) return;
          // V3.422 — an undeclared result unit is FILLED with the label
          // the unit algebra computed (µL·mol, mL / min …), so the
          // calculator cards, node badges, and [!var:] doc tokens all
          // say what the number actually is.
          var q = qtys[r.name];
          var computedUnit = (!r.unit && q && q.computed) ? quantityLabel(q) : '';
          var outSpec = {
            name: r.name, label: r.label || r.name, unit: r.unit || computedUnit,
            decimals: (typeof r.decimals === 'number') ? r.decimals : 3,
          };
          if (computedUnit) outSpec.unitComputed = true;
          entries.push({
            blockId: n.id + (ri ? ':' + ri : ''), label: r.label || r.name || '', description: '', expression: r.expr || '',
            variables: [],
            output: outSpec,
          });
        });
      } else if (n.type === 'code') {
        // V3.380 — a script whose named arguments are the wired (math-
        // role) variables and whose returned object keys match the
        // declared outputs. Emitted as ONE multi-output entry the kernel
        // evaluates once per rebuild; topo order already places it after
        // its producers. Scalar scope only in v1.
        if (scopeMap[id] !== 'scalar') {
          warnings.push('Code node "' + _nodeName(n) + '" receives per-item inputs — scripts run at scalar scope only, so it was skipped.');
        } else {
          var argNames = [];
          var _seenArg = {};
          var allVars = _varsByName(graph);
          graph.edges.forEach(function (e) {
            if (e.to !== id || edgeRole(e, 'code') !== 'math') return;
            var pv = producedVars(byId[e.from]);
            // V3.423 — a pass-through edge's sourceVar resolves by name
            var sv = (e.sourceVar && (pv.some(function (v2) { return v2.key === e.sourceVar; }) || allVars[e.sourceVar]))
              ? e.sourceVar : ((pv[0] && pv[0].key) || '');
            if (!sv || _seenArg[sv]) return;
            _seenArg[sv] = true;
            argNames.push(sv);
          });
          entries.push({
            blockId: n.id, label: p.label || '', description: '', expression: '',
            variables: [],
            output: null,
            code: String(p.body == null ? '' : p.body),
            argNames: argNames,
            outputs: (Array.isArray(p.outputs) ? p.outputs : [])
              .filter(function (o) { return o && o.name; })
              .map(function (o) {
                return { name: o.name, label: o.label || o.name, unit: o.unit || '',
                         decimals: (typeof o.decimals === 'number') ? o.decimals : 3 };
              }),
          });
        }
      } else if (n.type === 'list') {
        var spec = { name: p.name || 'items', params: [], dims: [], derived: [], dedupe: p.dedupe || { when: '', ignore: [] } };
        var _seenSrc = {};
        var structuralSrcs = graph.edges
          .filter(function (e) { return e.to === id && edgeRole(e, 'list') === 'structural'; })
          .map(function (e) { return e.from; })
          // one dim per source node — a second edge from the same source
          // would duplicate its dimension/params, corrupting the list.
          .filter(function (fromId) { if (_seenSrc[fromId]) return false; _seenSrc[fromId] = true; return true; });
        structuralSrcs.forEach(function (srcId) {
          var src = byId[srcId];
          var sp = src.params || {};
          if (src.type === 'choices') {
            spec.dims.push({
              field: sp.field, label: sp.label || sp.field,
              source: 'list',
              options: Array.isArray(sp.options) ? sp.options.slice() : [],
              editable: sp.editable !== false,
            });
          } else if (src.type === 'ordered') {
            spec.params = spec.params.concat(src._compiledParams || []);
            spec.dims.push({ field: sp.field, label: sp.label || sp.field, source: 'params' });
          } else if (src.type === 'equation' && scopeMap[srcId] === 'item') {
            spec.derived.push({ field: sp.name, expr: sp.expr || '' });
          }
          // Wired scalars need no spec entry — they're already in the
          // symbol table, so per-item expressions see them globally.
        });
        if (!spec.dims.length) {
          warnings.push('List "' + spec.name + '" has no generator wired in — it will produce no items.');
        }
        datasets.push({ name: spec.name, spec: spec, nodeId: id });
      }
      // per-item equations not wired to any list: warn.
    });

    // Per-item equations must terminate at a list to have any effect.
    graph.nodes.forEach(function (n) {
      if (n.type !== 'equation' || scopeMap[n.id] !== 'item') return;
      var used = datasets.some(function (d) {
        return d.spec.derived.some(function (df) { return df.field === (n.params || {}).name; });
      });
      if (!used) warnings.push('Per-item equation "' + _nodeName(n) + '" is not wired into a list — it computes nothing.');
    });

    // V3.434 — display gates: what the document offers. Per-item vars
    // were skipped by displayGroups (not scalar symbols) — warn here.
    var displays = displayGroups(graph);
    graph.edges.forEach(function (e) {
      var to = byId[e.to];
      if (!to || (to.type !== 'cards' && to.type !== 'refs')) return;
      var src = byId[e.from];
      if (src && scopeMap[src.id] === 'item') {
        warnings.push('Per-item variable "' + (e.sourceVar || _nodeName(src)) + '" can’t display as a ' +
          (to.type === 'cards' ? 'card' : 'reference') + ' — wire it into a List instead.');
      }
    });

    // Parameter bindings: {targetNode, paramField, sourceVar}. A consumer
    // (editor / widget) reads sourceVar's live value from the symbol
    // table and substitutes it for the target node's paramField.
    var paramOverrides = [];
    graph.edges.forEach(function (e) {
      var to = byId[e.to];
      if (!to || edgeRole(e, to.type) !== 'param' || !e.paramField) return;
      var srcVars = producedVars(byId[e.from]);
      var sv = e.sourceVar || (srcVars[0] && srcVars[0].key) || '';
      if (sv) paramOverrides.push({ targetNode: e.to, paramField: e.paramField, sourceVar: sv });
    });

    return { entries: entries, datasets: datasets, scopeMap: scopeMap, paramOverrides: paramOverrides, displays: displays, errors: [], warnings: warnings };
  }

  /* ── Item-list assembly (single source of truth) ─────────────────
   * spec = {name, params:[{name,label,…,lt}], dims:[{field,label,
   * source:'list'|'params',options,editable}], derived:[{field,expr}],
   * dedupe:{when,ignore[]}}. `pickSets` is an array of {dimField→pick};
   * for source:'params' dims the pick is a param NAME. `table` is the
   * current symbol table; `optionsMap` (optional) overrides each dim's
   * live option list (session-edited copies). Returns deduped rows. */

  function _paramByName(spec, name) {
    for (var i = 0; i < (spec.params || []).length; i++) {
      if (spec.params[i].name === name) return spec.params[i];
    }
    return null;
  }

  function _paramValue(spec, table, name) {
    var sym = table && table[name];
    if (sym && typeof sym.value === 'number') return sym.value;
    var p = _paramByName(spec, name);
    var d = p && ((typeof p.default === 'number') ? p.default : parseFloat(p.default));
    return isFinite(d) ? d : 0;
  }

  function _truthy(v) { return !!v && v !== 0; }

  function assembleRows(spec, table, math, pickSets) {
    var PF = window.ProtocolFormulas;
    var dims = Array.isArray(spec.dims) ? spec.dims : [];
    var derived = (Array.isArray(spec.derived) ? spec.derived : [])
      .filter(function (d) { return d && d.field && d.expr; });
    var dedupe = (spec.dedupe && typeof spec.dedupe === 'object') ? spec.dedupe : { when: '', ignore: [] };

    var rows = (pickSets || []).map(function (picks) {
      var row = {};
      dims.forEach(function (d) {
        var v = picks[d.field];
        row[d.field] = v;
        if (d.source === 'params') {
          var p = _paramByName(spec, v);
          row[d.field + '_label'] = (p && p.label) || v;
          row[d.field + '_value'] = _paramValue(spec, table, v);
        }
      });
      derived.forEach(function (df) {
        var res = PF.evalExpression(df.expr, table, math, row);
        row[df.field] = res.error ? null : res.value;
      });
      return row;
    });

    // Dedupe: rows matching `when` get `ignore` fields blanked before
    // identity-keying; identical keys merge (first kept).
    var seen = {};
    var out = [];
    rows.forEach(function (row) {
      var keyRow = row;
      if (dedupe.when) {
        var res = PF.evalExpression(dedupe.when, table, math, row);
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
      out.push(keyRow === row ? row : keyRow);
    });
    return out;
  }

  /* Cartesian product of every dim's options → pickSets. `optionsMap`
   * (field → live option list) overrides spec options per dim. */
  function cartesianPicks(spec, optionsMap) {
    var dims = Array.isArray(spec.dims) ? spec.dims : [];
    var sets = [{}];
    dims.forEach(function (d) {
      var opts = (optionsMap && optionsMap[d.field]) ||
        (d.source === 'params'
          ? (spec.params || []).map(function (p) { return p.name; })
          : (Array.isArray(d.options) ? d.options : []));
      var next = [];
      sets.forEach(function (s) {
        opts.forEach(function (opt) {
          var c = {};
          Object.keys(s).forEach(function (k) { c[k] = s[k]; });
          c[d.field] = opt;
          next.push(c);
        });
      });
      sets = next;
    });
    return sets;
  }

  /* Stable identity for a row: its dim picks only — computed values and
   * labels change with the symbol table, picks don't. Used as the
   * assignment key so slot assignments survive recompute. */
  function rowKey(spec, row) {
    var key = {};
    (Array.isArray(spec.dims) ? spec.dims : []).forEach(function (d) {
      key[d.field] = row[d.field];
    });
    return JSON.stringify(key, Object.keys(key).sort());
  }

  /* ── Plate auto-arrange (V3.438) ──────────────────────────────
   * Pure position planner: lays experiment `items` × `reps` into the
   * plate `grids` under one of several STRATEGIES, returning
   * { assignment:{gid:{"r-c":itemKey}}, overflow, warnings, seedUsed }.
   * Arrangement is COSMETIC to the reagent math — totals key off well
   * COUNTS × quantity × factor (aggregatePrep), never position — so the
   * caller can swap strategies freely without touching quantities.
   *
   *   opts = { grids, reps, keyOf, mode, ...modeOpts }
   *   mode 'fill'       — direction 'row'|'col'|'snake'; reps contiguous.
   *                       'row' reproduces the legacy row-major Auto-fill.
   *   mode 'factorAxis' — rowField/colField (dim field names): each
   *                       condition placed at (row=level index of
   *                       rowField, col=level index of colField); reps
   *                       stack into the next free wells; warns when a
   *                       factor has more levels than its axis length.
   *   mode 'spread'     — round-robin one rep of each condition per pass
   *                       across wells; avoidEdges skips the perimeter
   *                       first (falls back to edges + warns on overflow).
   *   mode 'random'     — seeded shuffle of the slot order (reproducible;
   *                       seed comes from the caller — no Math.random). */
  function _mulberry32(seed) {
    var a = (seed >>> 0) || 1;
    return function () {
      a |= 0; a = (a + 0x6D2B79F5) | 0;
      var t = Math.imul(a ^ (a >>> 15), 1 | a);
      t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
      return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
    };
  }
  function _gridDims(g) {
    return {
      rows: Math.max(1, Math.min(16, parseInt(g.rows, 10) || 4)),
      cols: Math.max(1, Math.min(24, parseInt(g.cols, 10) || 6)),
    };
  }
  /* Ordered slot list across all grids for a fill direction. */
  function _slotsInOrder(grids, direction) {
    var slots = [];
    (grids || []).forEach(function (g) {
      var d = _gridDims(g);
      if (direction === 'col') {
        for (var c = 0; c < d.cols; c++) for (var r = 0; r < d.rows; r++) slots.push({ gid: g.id, slot: r + '-' + c });
      } else if (direction === 'snake') {
        for (var r2 = 0; r2 < d.rows; r2++) {
          if (r2 % 2 === 0) { for (var c2 = 0; c2 < d.cols; c2++) slots.push({ gid: g.id, slot: r2 + '-' + c2 }); }
          else { for (var c3 = d.cols - 1; c3 >= 0; c3--) slots.push({ gid: g.id, slot: r2 + '-' + c3 }); }
        }
      } else { // row-major (default)
        for (var r3 = 0; r3 < d.rows; r3++) for (var c4 = 0; c4 < d.cols; c4++) slots.push({ gid: g.id, slot: r3 + '-' + c4 });
      }
    });
    return slots;
  }
  function _isEdge(slot, g) {
    var d = _gridDims(g), p = slot.split('-'), r = +p[0], c = +p[1];
    return r === 0 || c === 0 || r === d.rows - 1 || c === d.cols - 1;
  }
  function _emptyAssignment(grids) {
    var a = {};
    (grids || []).forEach(function (g) { a[g.id] = {}; });
    return a;
  }
  function plateArrange(items, opts) {
    opts = opts || {};
    var grids = Array.isArray(opts.grids) ? opts.grids : [];
    var reps = Math.max(1, Math.round(opts.reps || 1));
    var keyOf = opts.keyOf || function (r) { return JSON.stringify(r); };
    var mode = opts.mode || 'fill';
    var warnings = [];
    var assignment = _emptyAssignment(grids);
    items = Array.isArray(items) ? items : [];

    function place(list, order) {
      var si = 0, overflow = 0;
      list.forEach(function (entry) {
        for (var i = 0; i < entry.n; i++) {
          if (si < order.length) { assignment[order[si].gid][order[si].slot] = entry.key; si++; }
          else overflow++;
        }
      });
      return overflow;
    }

    if (mode === 'factorAxis') {
      var byId = {};
      grids.forEach(function (g) { byId[g.id] = g; });
      var rowField = opts.rowField, colField = opts.colField;
      // level order = first-seen across items (stable, matches palette)
      function levels(field) {
        var seen = {}, out = [];
        items.forEach(function (r) { var v = r[field]; if (field && !(v in seen)) { seen[v] = 1; out.push(v); } });
        return out;
      }
      var rLevels = rowField ? levels(rowField) : [''];
      var cLevels = colField ? levels(colField) : [''];
      var g0 = grids[0];
      if (!g0) return { assignment: assignment, overflow: items.length * reps, warnings: ['No plate to arrange into.'], seedUsed: null };
      var d0 = _gridDims(g0);
      if (rLevels.length > d0.rows) warnings.push(rowField + ' has ' + rLevels.length + ' levels but the plate has only ' + d0.rows + ' rows — extra levels stack into free wells.');
      if (cLevels.length > d0.cols) warnings.push(colField + ' has ' + cLevels.length + ' levels but the plate has only ' + d0.cols + ' cols — extra levels stack into free wells.');
      var overflow2 = 0;
      // free-slot fallback order for reps / out-of-range levels
      var freeOrder = _slotsInOrder(grids, 'row');
      var used = {};
      function nextFree(key) {
        for (var i = 0; i < freeOrder.length; i++) {
          var o = freeOrder[i], k = o.gid + '|' + o.slot;
          if (!used[k]) { used[k] = 1; assignment[o.gid][o.slot] = key; return true; }
        }
        return false;
      }
      items.forEach(function (row) {
        var key = keyOf(row);
        var ri = rowField ? rLevels.indexOf(row[rowField]) : 0;
        var ci = colField ? cLevels.indexOf(row[colField]) : 0;
        for (var i = 0; i < reps; i++) {
          var placed = false;
          if (i === 0 && ri >= 0 && ri < d0.rows && ci >= 0 && ci < d0.cols) {
            var slot = ri + '-' + ci, k = g0.id + '|' + slot;
            if (!used[k]) { used[k] = 1; assignment[g0.id][slot] = key; placed = true; }
          }
          if (!placed && !nextFree(key)) overflow2++;
        }
      });
      return { assignment: assignment, overflow: overflow2, warnings: warnings, seedUsed: null };
    }

    if (mode === 'spread') {
      var order = _slotsInOrder(grids, 'row');
      var gById = {}; grids.forEach(function (g) { gById[g.id] = g; });
      if (opts.avoidEdges) {
        var interior = order.filter(function (o) { return !_isEdge(o.slot, gById[o.gid]); });
        var need = items.length * reps;
        if (interior.length >= need) order = interior;
        else { warnings.push('Not enough interior wells to avoid edges — using edge wells too.'); /* keep full order */ }
      }
      // round-robin: rep-pass outer, items inner → each condition's reps
      // spread apart across the plate
      var seq = [];
      for (var pass = 0; pass < reps; pass++) items.forEach(function (row) { seq.push({ key: keyOf(row), n: 1 }); });
      var of = place(seq, order);
      return { assignment: assignment, overflow: of, warnings: warnings, seedUsed: null };
    }

    if (mode === 'random') {
      var seed = (typeof opts.seed === 'number' && isFinite(opts.seed)) ? (opts.seed | 0) : 1;
      var rnd = _mulberry32(seed);
      var pool = _slotsInOrder(grids, 'row').slice();
      for (var i = pool.length - 1; i > 0; i--) { var j = Math.floor(rnd() * (i + 1)); var t = pool[i]; pool[i] = pool[j]; pool[j] = t; }
      var seqR = items.map(function (row) { return { key: keyOf(row), n: reps }; });
      var ofR = place(seqR, pool);
      return { assignment: assignment, overflow: ofR, warnings: warnings, seedUsed: seed };
    }

    // default: fill (row | col | snake), replicates contiguous
    var dir = opts.direction || 'row';
    var seqF = items.map(function (row) { return { key: keyOf(row), n: reps }; });
    var ofF = place(seqF, _slotsInOrder(grids, dir));
    return { assignment: assignment, overflow: ofF, warnings: warnings, seedUsed: null };
  }

  /* ── Recipes (V3.381) ─────────────────────────────────────────
   * Common pre-wired node patterns a user can drop onto the canvas in
   * one click. Templates use LOCAL refs; instantiateRecipe() clones
   * them with fresh node/edge ids and collision-safe variable names
   * (when any template name already exists in the graph, EVERY template
   * name gets one consistent `_k` suffix and all cross-references —
   * expressions, script bodies, dedupe rules, edge sourceVars — are
   * rewritten to match). Pure: never mutates the passed graph. */
  var RECIPES = [
    {
      key: 'dilution', icon: '💧', label: 'Dilute a stock (C1·V1 = C2·V2)',
      hint: 'Stock conc. + target conc. + final volume → stock and diluent volumes.',
      nodes: [
        { ref: 'c1', type: 'input', dx: 0, dy: 0, params: { name: 'C1', label: 'Stock conc.', widget: 'number', min: 0.001, max: 1000, step: 0.1, default: 10, unit: 'mM' } },
        { ref: 'c2', type: 'input', dx: 0, dy: 200, params: { name: 'C2', label: 'Final conc.', widget: 'slider', min: 0.1, max: 10, step: 0.1, default: 1, unit: 'mM' } },
        { ref: 'v2', type: 'input', dx: 0, dy: 400, params: { name: 'V2', label: 'Final volume', widget: 'slider', min: 10, max: 5000, step: 10, default: 500, unit: 'µL' } },
        { ref: 'v1', type: 'equation', dx: 320, dy: 100, params: { name: 'V1', label: 'Stock to add', expr: 'C2 * V2 / C1', unit: 'µL', decimals: 1 } },
        { ref: 'vd', type: 'equation', dx: 320, dy: 320, params: { name: 'Vdiluent', label: 'Diluent to add', expr: 'V2 - V1', unit: 'µL', decimals: 1 } },
      ],
      edges: [
        { from: 'c1', to: 'v1', sourceVar: 'C1', role: 'math' },
        { from: 'c2', to: 'v1', sourceVar: 'C2', role: 'math' },
        { from: 'v2', to: 'v1', sourceVar: 'V2', role: 'math' },
        { from: 'v1', to: 'vd', sourceVar: 'V1', role: 'math' },
        { from: 'v2', to: 'vd', sourceVar: 'V2', role: 'math' },
      ],
    },
    {
      key: 'percent', icon: '％', label: 'Percent of a total',
      hint: 'A total and a percentage slider → the computed part.',
      nodes: [
        { ref: 't', type: 'input', dx: 0, dy: 0, params: { name: 'total', label: 'Total', widget: 'number', min: 0, max: 100000, step: 1, default: 1000, unit: '' } },
        { ref: 'p', type: 'input', dx: 0, dy: 200, params: { name: 'pct', label: 'Percent', widget: 'slider', min: 0, max: 100, step: 1, default: 10, unit: '%' } },
        { ref: 'x', type: 'equation', dx: 320, dy: 100, params: { name: 'part', label: 'Part', expr: 'total * pct / 100', unit: '', decimals: 2 } },
      ],
      edges: [
        { from: 't', to: 'x', sourceVar: 'total', role: 'math' },
        { from: 'p', to: 'x', sourceVar: 'pct', role: 'math' },
      ],
    },
    {
      key: 'sets-list', icon: '🧪', label: 'Two sets → experiment list',
      hint: 'A choices set × an ordered set assemble into an item list.',
      nodes: [
        { ref: 'cond', type: 'choices', dx: 0, dy: 0, params: { field: 'condition', label: 'Condition', options: ['A', 'B'], editable: true } },
        { ref: 'lvl', type: 'ordered', dx: 0, dy: 220, params: { field: 'level', label: 'Level', unit: '', items: [
          { name: 'low', label: 'Low', default: 1, unit: '', min: 0, max: 100, step: 1 },
          { name: 'mid', label: 'Mid', default: 5, unit: '', min: 0, max: 100, step: 1 },
          { name: 'high', label: 'High', default: 10, unit: '', min: 0, max: 100, step: 1 },
        ] } },
        { ref: 'lst', type: 'list', dx: 340, dy: 110, params: { name: 'experiments', dedupe: { when: '', ignore: [] } } },
      ],
      edges: [
        { from: 'cond', to: 'lst', sourceVar: 'condition', role: 'structural' },
        { from: 'lvl', to: 'lst', sourceVar: 'low', role: 'structural' },
      ],
    },
    {
      key: 'drive-setting', icon: '🎛', label: 'Drive a setting (binding)',
      hint: 'A constant drives another node’s setting — here a slider’s max.',
      nodes: [
        { ref: 'cap', type: 'constant', dx: 0, dy: 0, params: { name: 'cap', label: 'Upper cap', value: 100, unit: '' } },
        { ref: 'dose', type: 'input', dx: 320, dy: 0, params: { name: 'dose', label: 'Dose', widget: 'slider', min: 0, max: 50, step: 1, default: 10, unit: '' } },
      ],
      edges: [
        { from: 'cap', to: 'dose', sourceVar: 'cap', role: 'param', paramField: 'max' },
      ],
    },
    {
      key: 'code-transform', icon: '📜', label: 'Script transform (code)',
      hint: 'An input feeds a JavaScript snippet with a named output.',
      nodes: [
        { ref: 'x', type: 'input', dx: 0, dy: 0, params: { name: 'x', label: 'X', widget: 'slider', min: 0, max: 20, step: 1, default: 4, unit: '' } },
        { ref: 'fn', type: 'code', dx: 320, dy: 0, params: { label: 'Square it', body: 'return { y: x * x };', outputs: [
          { name: 'y', label: 'X squared', unit: '', decimals: 2 },
        ] } },
      ],
      edges: [
        { from: 'x', to: 'fn', sourceVar: 'x', role: 'math' },
      ],
    },
  ];

  function _graphNames(graph) {
    var names = {};
    (graph.nodes || []).forEach(function (n) {
      producedVars(n).forEach(function (v) { names[v.key] = true; });
      var p = n.params || {};
      if ((n.type === 'choices' || n.type === 'ordered') && p.field) names[p.field] = true;
      if (n.type === 'list' && p.name) names[p.name] = true;
    });
    return names;
  }

  function _recipeNames(recipe) {
    var names = [];
    (recipe.nodes || []).forEach(function (tn) {
      var p = tn.params || {};
      if (p.name) names.push(p.name);
      if (p.field) names.push(p.field);
      (Array.isArray(p.items) ? p.items : []).forEach(function (it) { if (it && it.name) names.push(it.name); });
      (Array.isArray(p.outputs) ? p.outputs : []).forEach(function (o) { if (o && o.name) names.push(o.name); });
    });
    return names;
  }

  function _renameIdentifiers(text, renames) {
    var out = String(text);
    Object.keys(renames).forEach(function (old) {
      var safe = old.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
      out = out.replace(new RegExp('\\b' + safe + '\\b', 'g'), renames[old]);
    });
    return out;
  }

  /* Clone a recipe template into fresh nodes/edges positioned at `at`.
   * Returns {nodes, edges} — the caller appends them to its graph. */
  function instantiateRecipe(recipe, graph, at) {
    if (!recipe || !Array.isArray(recipe.nodes)) return { nodes: [], edges: [] };
    graph = graph || { nodes: [], edges: [] };
    at = at || { x: 40, y: 40 };
    var existing = _graphNames(graph);
    var rnames = _recipeNames(recipe);
    var renames = {};
    if (rnames.some(function (nm) { return existing[nm]; })) {
      var k = 2;
      while (k < 1000 && !rnames.every(function (nm) { return !existing[nm + '_' + k]; })) k++;
      rnames.forEach(function (nm) { renames[nm] = nm + '_' + k; });
    }
    var hasRenames = Object.keys(renames).length > 0;
    var idByRef = {};
    var nodes = (recipe.nodes || []).map(function (tn) {
      var params = JSON.parse(JSON.stringify(tn.params || {}));
      if (hasRenames) {
        if (params.name && renames[params.name]) params.name = renames[params.name];
        if (params.field && renames[params.field]) params.field = renames[params.field];
        (Array.isArray(params.items) ? params.items : []).forEach(function (it) {
          if (it && it.name && renames[it.name]) it.name = renames[it.name];
        });
        (Array.isArray(params.outputs) ? params.outputs : []).forEach(function (o) {
          if (o && o.name && renames[o.name]) o.name = renames[o.name];
        });
        if (params.expr) params.expr = _renameIdentifiers(params.expr, renames);
        if (params.body) params.body = _renameIdentifiers(params.body, renames);
        if (params.dedupe && params.dedupe.when) params.dedupe.when = _renameIdentifiers(params.dedupe.when, renames);
      }
      var node = newNode(tn.type, params, { x: at.x + (tn.dx || 0), y: at.y + (tn.dy || 0) });
      idByRef[tn.ref] = node.id;
      return node;
    });
    var edges = (recipe.edges || [])
      .filter(function (te) { return idByRef[te.from] && idByRef[te.to]; })
      .map(function (te) {
        var sv = te.sourceVar || '';
        if (sv && renames[sv]) sv = renames[sv];
        return newEdge(idByRef[te.from], idByRef[te.to], { sourceVar: sv, role: te.role, paramField: te.paramField });
      });
    return { nodes: nodes, edges: edges };
  }

  /* Map a compile() result to the calculator input/output specs the
   * shared widgets render. Scalar input/ordered entries become sliders
   * (ordered sets expand to one slider per member); output entries
   * become cards. `paramOverrides` attach as per-field `drivers` so a
   * bound variable can live-drive a control. Shared by the doc view and
   * the notebook run so both render a design block identically. */
  function designInputsOutputs(res) {
    var driversByNode = {};
    (res.paramOverrides || []).forEach(function (o) {
      (driversByNode[o.targetNode] = driversByNode[o.targetNode] || {})[o.paramField] = o.sourceVar;
    });
    var inputs = [];
    (res.entries || []).forEach(function (e) {
      if (e.output || !e.widget || e.widget.kind === 'constant') return;
      var drivers = driversByNode[e.blockId] || null;
      if (e.widget.kind === 'ordered') {
        // one slider per member (strictly-increasing set)
        (e.widget.params || []).forEach(function (p) {
          inputs.push({ name: p.name, label: p.label || p.name, unit: p.unit || '',
            default: p.default, widget: 'slider', min: p.min, max: p.max, step: p.step });
        });
        return;
      }
      if (!(e.variables || []).length) return;
      var v = e.variables[0];
      inputs.push({ name: v.name, label: v.label, unit: v.unit, default: v.default,
        widget: e.widget.kind || 'number',
        min: e.widget.min, max: e.widget.max, step: e.widget.step,
        rangeHint: e.widget.rangeHint, drivers: drivers });
    });
    // V3.434 — cards are GATED: only variables wired into a 📊 Cards
    // node render as document cards, in group + wire order; no cards
    // node → no cards (strict — references and [!var:] tokens are a
    // separate, ungated concern). Compiled output specs are reused
    // verbatim (decimals + drivers, so driven decimals keep working);
    // input/constant variables synthesize a minimal spec — the card
    // reads the live symbol table by name, so input cards track.
    var specByName = {};
    var inputVarByName = {};
    (res.entries || []).forEach(function (e) {
      if (e.output && e.output.name) {
        specByName[e.output.name] = { entry: e, out: e.output, code: false };
      } else if (e.code != null && Array.isArray(e.outputs)) {
        e.outputs.forEach(function (o) {
          specByName[o.name] = { entry: e, out: o, code: true };
        });
      }
      (e.variables || []).forEach(function (v) { inputVarByName[v.name] = v; });
    });
    var outputs = [];
    var seenCard = {};
    (res.displays || []).filter(function (g) { return g && g.type === 'cards'; }).forEach(function (g) {
      (g.vars || []).forEach(function (v) {
        if (!v || !v.name || seenCard[v.name]) return;
        seenCard[v.name] = true;
        var hit = specByName[v.name];
        if (hit) {
          outputs.push({ name: hit.out.name, label: hit.out.label, unit: hit.out.unit,
            decimals: hit.out.decimals, expr: hit.code ? '' : hit.entry.expression,
            unitComputed: !!hit.out.unitComputed,
            drivers: hit.code ? null : (driversByNode[hit.entry.blockId] || null) });
        } else {
          var iv = inputVarByName[v.name];
          outputs.push({ name: v.name, label: (iv && iv.label) || v.label || v.name,
            unit: (iv && iv.unit) || v.unit || '', expr: '', drivers: null });
        }
      });
    });
    return { inputs: inputs, outputs: outputs };
  }

  window.ProtocolGraph = {
    NODE_TYPES: NODE_TYPES,
    RECIPES: RECIPES,
    instantiateRecipe: instantiateRecipe,
    designInputsOutputs: designInputsOutputs,
    UNIT_CATEGORIES: UNIT_CATEGORIES,
    newNode: newNode,
    newEdge: newEdge,
    edgeRole: edgeRole,
    normalizeGraph: normalizeGraph,
    validateGraph: validateGraph,
    topoSort: topoSort,
    wouldCycle: wouldCycle,
    inferScopes: inferScopes,
    categoryOfUnit: categoryOfUnit,
    colorOfCategory: colorOfCategory,
    unitTypeOptions: unitTypeOptions,
    SCIENTIFIC_CONSTANTS: SCIENTIFIC_CONSTANTS,
    unitsForCategory: unitsForCategory,
    isAutoName: isAutoName,
    autoNameForCategory: autoNameForCategory,
    DIMENSION_LETTERS: DIMENSION_LETTERS,
    equationAliases: equationAliases,
    tokenizeExpr: tokenizeExpr,
    serializeTokens: serializeTokens,
    fpadNextAllowed: fpadNextAllowed,
    eqResults: _eqResults,
    dimOfUnit: dimOfUnit,
    dimMul: dimMul,
    dimDiv: dimDiv,
    dimPow: dimPow,
    dimsEqual: dimsEqual,
    dimCategories: dimCategories,
    dimLabel: dimLabel,
    dimName: dimName,
    dimDisplay: dimDisplay,
    quantityOfUnit: quantityOfUnit,
    canonicalUnit: canonicalUnit,
    unitsLabel: unitsLabel,
    unitsCollapse: unitsCollapse,
    quantityLabel: quantityLabel,
    resolveQuantities: resolveQuantities,
    checkTokenDims: checkTokenDims,
    producedVars: producedVars,
    passThroughVars: passThroughVars,
    displayGroups: displayGroups,
    nodeSockets: nodeSockets,
    paramTargets: paramTargets,
    inputSlots: inputSlots,
    compile: compile,
    assembleRows: assembleRows,
    cartesianPicks: cartesianPicks,
    rowKey: rowKey,
    plateArrange: plateArrange,
  };
})();
