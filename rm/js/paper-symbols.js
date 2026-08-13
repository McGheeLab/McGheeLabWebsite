/* paper-symbols.js — "∑ Symbols" page of the paper builder (V3.459).
 *
 * A focused math-symbol palette: every symbol is a tile (KaTeX-rendered
 * glyph + its LaTeX) — click copies the LaTeX to the clipboard for
 * pasting into equation blocks / the visual editor / capture modals.
 * Symbols are grouped into section CARDS (Greek, operators, relations,
 * arrows, accents, matrices, calculus, sets & logic, misc); each card
 * expands/collapses, and cards reorder by drag (≡ handle) or ▲▼ — the
 * order and the collapsed set persist per user at
 * userSettings/{uid}.paperSymbols (the library-prefs.js debounced
 * merge-write pattern; rules already allow owner writes), so the
 * arrangement becomes the user's default on every device.
 *
 * Contract mirrors paper-writing-guide.js: loaded before
 * paper-equations.js, which calls PaperSymbols.buildTabContent(root)
 * from _refreshPanel when the symbols tab/page is active (idempotent).
 * Rendering uses PaperEditor.ensureKatex() + renderEquationHtml — the
 * KaTeX CSS is already on the builder page. */
(function () {
  'use strict';

  /* ── Symbol catalog (KaTeX-safe commands only) ──
   * Entries are either a LaTeX string (caption = the string itself) or
   * {l: latex, n: caption} where the raw LaTeX is too long to caption. */
  var SECTIONS = [
    { id: 'greek-lower', title: 'Greek — lowercase', symbols: [
      '\\alpha', '\\beta', '\\gamma', '\\delta', '\\epsilon', '\\varepsilon',
      '\\zeta', '\\eta', '\\theta', '\\vartheta', '\\iota', '\\kappa',
      '\\lambda', '\\mu', '\\nu', '\\xi', '\\pi', '\\varpi', '\\rho',
      '\\varrho', '\\sigma', '\\varsigma', '\\tau', '\\upsilon', '\\phi',
      '\\varphi', '\\chi', '\\psi', '\\omega',
    ] },
    { id: 'greek-upper', title: 'Greek — uppercase', symbols: [
      '\\Gamma', '\\Delta', '\\Theta', '\\Lambda', '\\Xi', '\\Pi',
      '\\Sigma', '\\Upsilon', '\\Phi', '\\Psi', '\\Omega',
    ] },
    { id: 'accents', title: 'Accents & decorations', symbols: [
      '\\dot{x}', '\\ddot{x}', '\\hat{x}', '\\bar{x}', '\\vec{x}',
      '\\tilde{x}', '\\breve{x}', '\\check{x}', '\\acute{x}', '\\grave{x}',
      '\\mathring{x}', "x^{\\prime}", "x^{\\prime\\prime}",
      '\\widehat{xy}', '\\widetilde{xy}', '\\overline{xy}',
      '\\underline{xy}', '\\overrightarrow{AB}',
      { l: '\\overbrace{a+b}^{n}', n: 'overbrace' },
      { l: '\\underbrace{a+b}_{n}', n: 'underbrace' },
    ] },
    { id: 'operators', title: 'Operators', symbols: [
      '\\pm', '\\mp', '\\times', '\\div', '\\cdot', '\\ast', '\\star',
      '\\circ', '\\bullet', '\\oplus', '\\ominus', '\\otimes', '\\oslash',
      '\\odot', '\\cap', '\\cup', '\\sqcap', '\\sqcup', '\\vee', '\\wedge',
      '\\setminus', '\\diamond', '\\triangleleft', '\\triangleright',
      { l: '\\frac{a}{b}', n: 'fraction' }, '\\sqrt{x}',
      { l: '\\sqrt[n]{x}', n: 'n-th root' },
      { l: 'x^{n}', n: 'superscript' }, { l: 'x_{n}', n: 'subscript' },
      '\\binom{n}{k}',
    ] },
    { id: 'relations', title: 'Relations', symbols: [
      '\\leq', '\\geq', '\\neq', '\\approx', '\\equiv', '\\sim', '\\simeq',
      '\\cong', '\\propto', '\\ll', '\\gg', '\\subset', '\\supset',
      '\\subseteq', '\\supseteq', '\\perp', '\\parallel', '\\mid',
      '\\asymp', '\\doteq', '\\prec', '\\succ', '\\preceq', '\\succeq',
      '\\models', '\\vdash', '\\dashv', '\\bowtie',
    ] },
    { id: 'arrows', title: 'Arrows', symbols: [
      '\\leftarrow', '\\rightarrow', '\\uparrow', '\\downarrow',
      '\\leftrightarrow', '\\Leftarrow', '\\Rightarrow', '\\Leftrightarrow',
      '\\updownarrow', '\\mapsto', '\\longmapsto', '\\longrightarrow',
      '\\longleftarrow', '\\hookrightarrow', '\\rightharpoonup',
      '\\rightleftharpoons', '\\nearrow', '\\searrow', '\\swarrow',
      '\\nwarrow', '\\implies', '\\iff', '\\to', '\\gets',
    ] },
    { id: 'calculus', title: 'Calculus & big operators', symbols: [
      '\\partial', '\\nabla', '\\infty',
      { l: '\\frac{dy}{dx}', n: 'derivative' },
      { l: '\\frac{\\partial f}{\\partial x}', n: 'partial deriv.' },
      { l: '\\int_{a}^{b}', n: 'integral' },
      '\\iint', '\\iiint', '\\oint',
      { l: '\\sum_{i=1}^{n}', n: 'sum' },
      { l: '\\prod_{i=1}^{n}', n: 'product' },
      '\\coprod',
      { l: '\\lim_{x \\to 0}', n: 'limit' },
      { l: '\\bigcup_{i}', n: 'big union' },
      { l: '\\bigcap_{i}', n: 'big intersection' },
      '\\mathrm{d}x',
    ] },
    { id: 'matrices', title: 'Matrices & delimiters', symbols: [
      { l: '\\begin{pmatrix} a & b \\\\ c & d \\end{pmatrix}', n: 'pmatrix ( )' },
      { l: '\\begin{bmatrix} a & b \\\\ c & d \\end{bmatrix}', n: 'bmatrix [ ]' },
      { l: '\\begin{vmatrix} a & b \\\\ c & d \\end{vmatrix}', n: 'vmatrix | |' },
      { l: '\\begin{Bmatrix} a & b \\\\ c & d \\end{Bmatrix}', n: 'Bmatrix { }' },
      { l: '\\begin{cases} a & x > 0 \\\\ b & x \\leq 0 \\end{cases}', n: 'cases' },
      { l: '\\left( \\frac{a}{b} \\right)', n: 'auto-sized ( )' },
      '\\langle x \\rangle', '\\lceil x \\rceil', '\\lfloor x \\rfloor',
      { l: '\\left\\| x \\right\\|', n: 'norm' },
      { l: '\\left| x \\right|', n: 'absolute value' },
    ] },
    { id: 'sets-logic', title: 'Sets & logic', symbols: [
      '\\in', '\\ni', '\\notin', '\\emptyset', '\\varnothing',
      '\\mathbb{R}', '\\mathbb{N}', '\\mathbb{Z}', '\\mathbb{Q}',
      '\\mathbb{C}', '\\forall', '\\exists', '\\nexists', '\\neg',
      '\\land', '\\lor', '\\therefore', '\\because', '\\aleph',
      '\\mathcal{L}', '\\mathcal{F}', '\\mathfrak{g}',
    ] },
    { id: 'misc', title: 'Miscellaneous', symbols: [
      '\\hbar', '\\ell', '\\Re', '\\Im', '\\wp', '\\angle', '\\triangle',
      '\\square', '\\checkmark', '\\dagger', '\\ddagger', '\\S', '\\P',
      { l: '90^{\\circ}', n: 'degrees' },
      { l: '\\times 10^{3}', n: 'sci. notation' },
      '\\%', '\\ldots', '\\cdots', '\\vdots', '\\ddots', '\\prime',
      '\\circledR', '\\copyright',
    ] },
  ];

  var _root = null;
  var _prefs = { order: [], collapsed: {} };
  var _loaded = false;
  var _loading = null;
  var _saveTimer = null;

  /* ── Persistence — userSettings/{uid}.paperSymbols (library-prefs
   * pattern: direct firebase refs, debounced merge write). ── */
  function _docRef() {
    if (typeof firebase === 'undefined' || !firebase.firestore || !firebase.auth) return null;
    var user = firebase.auth().currentUser;
    if (!user) return null;
    return firebase.firestore().collection('userSettings').doc(user.uid);
  }
  function _loadPrefs() {
    if (_loading) return _loading;
    var ref = _docRef();
    if (!ref) { _loaded = true; return Promise.resolve(_prefs); }
    _loading = ref.get().then(function (snap) {
      var data = (snap && snap.exists && snap.data()) || {};
      var ps = data.paperSymbols || {};
      _prefs.order = Array.isArray(ps.order) ? ps.order.slice() : [];
      _prefs.collapsed = (ps.collapsed && typeof ps.collapsed === 'object') ? ps.collapsed : {};
      _loaded = true;
      return _prefs;
    }).catch(function (e) {
      console.warn('[paper-symbols] prefs load failed:', e && e.message);
      _loaded = true;
      return _prefs;
    });
    return _loading;
  }
  function _savePrefs() {
    if (_saveTimer) clearTimeout(_saveTimer);
    _saveTimer = setTimeout(function () {
      _saveTimer = null;
      var ref = _docRef();
      if (!ref) return;
      ref.set({
        paperSymbols: {
          order: _prefs.order,
          collapsed: _prefs.collapsed,
          updated_at: firebase.firestore.FieldValue.serverTimestamp(),
        },
      }, { merge: true }).catch(function (e) {
        console.warn('[paper-symbols] prefs save failed:', e && e.message);
      });
    }, 500);
  }

  /* Sections in the user's order; ids the catalog no longer has are
   * dropped, new catalog sections append in default order. */
  function _orderedSections() {
    var byId = {};
    SECTIONS.forEach(function (s) { byId[s.id] = s; });
    var out = [];
    (_prefs.order || []).forEach(function (id) {
      if (byId[id]) { out.push(byId[id]); delete byId[id]; }
    });
    SECTIONS.forEach(function (s) { if (byId[s.id]) out.push(s); });
    return out;
  }
  function _commitOrder(orderIds) {
    _prefs.order = orderIds;
    _savePrefs();
    _render();
  }

  /* ── Rendering ── */
  function _texOf(sym) { return typeof sym === 'string' ? sym : sym.l; }
  function _nameOf(sym) { return typeof sym === 'string' ? sym : (sym.n || sym.l); }

  function _renderTileMath(el, latex) {
    var pe = window.PaperEditor;
    if (pe && pe.renderEquationHtml) {
      try { el.innerHTML = pe.renderEquationHtml(latex, false); return; } catch (e) { /* fall through */ }
    }
    el.textContent = latex;
  }

  function _copy(text, tile) {
    function flash() {
      tile.classList.add('pe-symtile-copied');
      setTimeout(function () { tile.classList.remove('pe-symtile-copied'); }, 900);
    }
    if (navigator.clipboard && navigator.clipboard.writeText) {
      navigator.clipboard.writeText(text).then(flash).catch(function () { _copyFallback(text); flash(); });
    } else {
      _copyFallback(text);
      flash();
    }
  }
  function _copyFallback(text) {
    var ta = document.createElement('textarea');
    ta.value = text;
    ta.style.cssText = 'position:fixed;left:-9999px;top:0;';
    document.body.appendChild(ta);
    ta.select();
    try { document.execCommand('copy'); } catch (e) { /* best effort */ }
    ta.remove();
  }

  function _buildCard(section, idx, total) {
    var card = document.createElement('section');
    card.className = 'pe-symcard';
    card.dataset.symSection = section.id;
    var collapsed = !!_prefs.collapsed[section.id];

    var head = document.createElement('div');
    head.className = 'pe-symcard-head';

    var handle = document.createElement('span');
    handle.className = 'pe-symcard-handle';
    handle.textContent = '≡';
    handle.title = 'Drag to reorder — the order is saved as your default';
    head.appendChild(handle);

    var title = document.createElement('span');
    title.className = 'pe-symcard-title';
    title.textContent = section.title;
    head.appendChild(title);

    var count = document.createElement('span');
    count.className = 'pe-symcard-count';
    count.textContent = section.symbols.length;
    head.appendChild(count);

    var spacer = document.createElement('span');
    spacer.className = 'pe-symcard-spacer';
    head.appendChild(spacer);

    function mkBtn(txt, titleText, fn, disabled) {
      var b = document.createElement('button');
      b.type = 'button';
      b.textContent = txt;
      b.title = titleText;
      b.disabled = !!disabled;
      b.addEventListener('click', function (ev) { ev.stopPropagation(); fn(); });
      head.appendChild(b);
      return b;
    }
    mkBtn('▲', 'Move this section up', function () {
      var ids = _orderedSections().map(function (s) { return s.id; });
      if (idx > 0) { ids.splice(idx - 1, 0, ids.splice(idx, 1)[0]); _commitOrder(ids); }
    }, idx <= 0);
    mkBtn('▼', 'Move this section down', function () {
      var ids = _orderedSections().map(function (s) { return s.id; });
      if (idx < total - 1) { ids.splice(idx + 1, 0, ids.splice(idx, 1)[0]); _commitOrder(ids); }
    }, idx >= total - 1);
    var chev = mkBtn(collapsed ? '▸' : '▾', collapsed ? 'Expand' : 'Collapse', toggle);

    function toggle() {
      collapsed = !collapsed;
      if (collapsed) _prefs.collapsed[section.id] = true;
      else delete _prefs.collapsed[section.id];
      _savePrefs();
      card.classList.toggle('pe-symcard-collapsed', collapsed);
      chev.textContent = collapsed ? '▸' : '▾';
      chev.title = collapsed ? 'Expand' : 'Collapse';
    }
    head.addEventListener('click', function (ev) {
      if (ev.target.closest('button') || ev.target === handle) return;
      toggle();
    });
    card.appendChild(head);

    var grid = document.createElement('div');
    grid.className = 'pe-symcard-grid';
    section.symbols.forEach(function (sym) {
      var latex = _texOf(sym);
      var tile = document.createElement('button');
      tile.type = 'button';
      tile.className = 'pe-symtile';
      tile.title = latex + '  —  click to copy';
      var math = document.createElement('span');
      math.className = 'pe-symtile-math';
      _renderTileMath(math, latex);
      var cap = document.createElement('span');
      cap.className = 'pe-symtile-cap';
      cap.textContent = _nameOf(sym);
      tile.appendChild(math);
      tile.appendChild(cap);
      tile.addEventListener('click', function () { _copy(latex, tile); });
      grid.appendChild(tile);
    });
    card.appendChild(grid);
    if (collapsed) card.classList.add('pe-symcard-collapsed');

    _wireDrag(card, handle);
    return card;
  }

  /* Pointer-drag reorder (same custom-pointer approach as the doc
   * view's section drag — NOT HTML5 draggable). The dragged card gets a
   * ghost class; the card the pointer is over gets a drop line; drop
   * splices the id order and persists. */
  function _wireDrag(card, handle) {
    handle.addEventListener('pointerdown', function (ev) {
      ev.preventDefault();
      var cards = Array.prototype.slice.call(_root.querySelectorAll('.pe-symcard'));
      var dragId = card.dataset.symSection;
      card.classList.add('pe-symcard-dragging');
      var dropBefore = null;   // section id to insert before; null = end

      function clearMarks() {
        cards.forEach(function (c) { c.classList.remove('pe-symcard-dropline'); });
      }
      function onMove(e) {
        clearMarks();
        dropBefore = null;
        for (var i = 0; i < cards.length; i++) {
          var r = cards[i].getBoundingClientRect();
          if (e.clientY < r.top + r.height / 2) {
            dropBefore = cards[i].dataset.symSection;
            cards[i].classList.add('pe-symcard-dropline');
            break;
          }
        }
      }
      function onUp() {
        document.removeEventListener('pointermove', onMove);
        document.removeEventListener('pointerup', onUp);
        clearMarks();
        card.classList.remove('pe-symcard-dragging');
        if (dropBefore === dragId) return;
        var ids = _orderedSections().map(function (s) { return s.id; })
          .filter(function (id) { return id !== dragId; });
        var at = dropBefore ? ids.indexOf(dropBefore) : -1;
        if (at < 0) ids.push(dragId); else ids.splice(at, 0, dragId);
        _commitOrder(ids);
      }
      document.addEventListener('pointermove', onMove);
      document.addEventListener('pointerup', onUp);
    });
  }

  function _render() {
    if (!_root) return;
    _root.innerHTML = '';
    var hint = document.createElement('div');
    hint.className = 'pe-sym-hint';
    hint.textContent = 'Click a symbol to copy its LaTeX. Drag ≡ (or use ▲▼) to reorder sections — the order is saved as your default.';
    _root.appendChild(hint);
    var list = _orderedSections();
    list.forEach(function (section, i) {
      _root.appendChild(_buildCard(section, i, list.length));
    });
  }

  /* Idempotent mount — same contract as PaperWritingGuide. */
  function buildTabContent(rootEl) {
    if (!rootEl) return;
    _root = rootEl;
    if (!_root.classList.contains('pe-symbols')) _root.classList.add('pe-symbols');
    var katexReady = (window.PaperEditor && window.PaperEditor.ensureKatex)
      ? window.PaperEditor.ensureKatex().catch(function () {})
      : Promise.resolve();
    if (!_loaded) {
      _root.innerHTML = '<div class="pe-sym-hint">Loading symbol palette…</div>';
      Promise.all([_loadPrefs(), katexReady]).then(_render);
    } else {
      katexReady.then(_render);
    }
  }

  window.PaperSymbols = { buildTabContent: buildTabContent };
})();
