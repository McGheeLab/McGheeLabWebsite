/* mathlive-loader.js — shared lazy loader for the vendored MathLive
 * visual equation editor (rm/vendor/mathlive/, pinned 0.110.0).
 *
 * Loaded by BOTH the paper builder (Equations page toggles, in-doc
 * "Edit visually" overlay) and the library paper reader (equation
 * capture) — which is why it is its own tiny module rather than living
 * in paper-editor.js.
 *
 * Usage:
 *   ensureMathlive().then(function (ML) {
 *     var mf = document.createElement('math-field');   // registered
 *     mf.value = '\\frac{F}{A}';
 *     host.appendChild(mf);
 *     // read back: mf.getValue('latex')
 *     // static render: ML.convertLatexToMarkup(latex)  (+ the vendored
 *     //   mathlive-static.css for glyphs)
 *   });
 *
 * Mirrors ensureKatex's memoized dynamic-import pattern: nothing loads
 * until the first visual-editor request (viewers never pay the 843 KB),
 * and the single import guards customElements double-registration.
 * fontsDirectory MUST be absolute — a relative default 404s under some
 * FTP path layouts and renders tofu. */
(function () {
  'use strict';

  var MATHLIVE_URL = '/rm/vendor/mathlive/mathlive.min.mjs';
  var _promise = null;

  function ensureMathlive() {
    if (_promise) return _promise;
    _promise = import(MATHLIVE_URL).then(function (mod) {
      try {
        if (mod.MathfieldElement) {
          mod.MathfieldElement.fontsDirectory = '/rm/vendor/mathlive/fonts';
          mod.MathfieldElement.soundsDirectory = null;   // sounds not vendored
        }
      } catch (e) { /* config is best-effort */ }
      return mod;
    }).catch(function (e) {
      _promise = null;   // allow a retry after a transient failure
      throw e;
    });
    return _promise;
  }

  window.ensureMathlive = ensureMathlive;

  /* ── V3.458 — shared snippet toolbar ──────────────────────────────
   * mathliveSnippetBar(mf) returns a toolbar element with accents
   * (\dot/\ddot/\hat/…), structure (frac/sqrt/sup/sub), a matrix
   * builder (pmatrix/bmatrix/vmatrix/cases, rows×cols) and common
   * operators. Lives here so every math-field surface — the builder's
   * Visual toggles + in-doc overlay AND the reader's capture modal —
   * gets the same bar with zero page-specific CSS (styles self-inject).
   *
   * Buttons preventDefault on mousedown so the field keeps focus AND
   * selection — `#@` snippets wrap the selected atoms (MathLive turns
   * `#@` into the selection, `#?` into an editable placeholder). After
   * a programmatic insert we dispatch a synthetic 'input' on the field:
   * every mount site's dirty-guard listens for 'input', and a toolbar
   * insert is a real edit (the untouched-open/close fidelity guarantee
   * is unaffected). */

  var _snipCssDone = false;
  function _injectSnipbarCss() {
    if (_snipCssDone) return;
    _snipCssDone = true;
    var st = document.createElement('style');
    st.textContent =
      '.ml-snipbar{display:flex;flex-wrap:wrap;align-items:center;gap:2px;' +
        'padding:4px 6px;margin:0 0 4px;background:#f8fafc;border:1px solid #e2e8f0;' +
        'border-radius:8px;position:relative;}' +
      '.ml-snipbar-sep{width:1px;align-self:stretch;background:#e2e8f0;margin:0 4px;}' +
      '.ml-snipbar button{font-size:13px;line-height:1;padding:4px 6px;min-width:26px;' +
        'border:1px solid transparent;border-radius:6px;background:none;color:#334155;' +
        'cursor:pointer;font-family:STIXGeneral,"Times New Roman",serif;}' +
      '.ml-snipbar button:hover{background:#e2e8f0;border-color:#cbd5e1;}' +
      '.ml-snipbar-pop{position:absolute;top:100%;left:0;z-index:9000;margin-top:4px;' +
        'background:#fff;border:1px solid #cbd5e1;border-radius:8px;' +
        'box-shadow:0 8px 22px rgba(15,23,42,.18);padding:8px;display:flex;' +
        'flex-direction:column;gap:6px;font-size:12px;color:#334155;}' +
      '.ml-snipbar-pop label{display:flex;align-items:center;gap:6px;justify-content:space-between;}' +
      '.ml-snipbar-pop select,.ml-snipbar-pop input{font-size:12px;padding:2px 6px;' +
        'border:1px solid #cbd5e1;border-radius:6px;width:88px;box-sizing:border-box;}' +
      '.ml-snipbar-pop .ml-snipbar-go{background:#2563eb;color:#fff;border:none;' +
        'border-radius:6px;padding:5px 0;cursor:pointer;font-size:12px;}' +
      '.ml-snipbar-pop .ml-snipbar-go:hover{background:#1d4ed8;}';
    document.head.appendChild(st);
  }

  function _snipInsert(mf, latex) {
    if (!mf) return;
    try {
      if (typeof mf.insert === 'function') mf.insert(latex, { focus: true });
      else if (typeof mf.executeCommand === 'function') mf.executeCommand(['insert', latex]);
      else return;
      try { mf.focus(); } catch (e0) { /* focus is best-effort */ }
      mf.dispatchEvent(new Event('input', { bubbles: true }));
    } catch (e) { /* never break the host editor over a snippet */ }
  }

  function mathliveSnippetBar(mf) {
    _injectSnipbarCss();
    var bar = document.createElement('div');
    bar.className = 'ml-snipbar';

    function addBtn(glyph, latex, title) {
      var b = document.createElement('button');
      b.type = 'button';
      b.textContent = glyph;
      b.title = title + '  —  ' + latex.replace(/#@|#\?/g, '□');
      b.addEventListener('mousedown', function (ev) { ev.preventDefault(); });
      b.addEventListener('click', function () { _snipInsert(mf, latex); });
      bar.appendChild(b);
      return b;
    }
    function addSep() {
      var s = document.createElement('span');
      s.className = 'ml-snipbar-sep';
      bar.appendChild(s);
    }

    /* Accents — #@ wraps the current selection. */
    addBtn('ẋ', '\\dot{#@}', 'Dot (time derivative)');
    addBtn('ẍ', '\\ddot{#@}', 'Double dot');
    addBtn('x̂', '\\hat{#@}', 'Hat');
    addBtn('x̄', '\\bar{#@}', 'Bar');
    addBtn('x⃗', '\\vec{#@}', 'Vector arrow');
    addBtn('x̃', '\\tilde{#@}', 'Tilde');
    addBtn('x′', '{#@}^{\\prime}', 'Prime');
    addSep();
    /* Structure */
    addBtn('a⁄b', '\\frac{#@}{#?}', 'Fraction');
    addBtn('√', '\\sqrt{#@}', 'Square root');
    addBtn('xⁿ', '{#@}^{#?}', 'Superscript');
    addBtn('xₙ', '{#@}_{#?}', 'Subscript');
    addSep();
    /* Matrix builder popover */
    var matBtn = document.createElement('button');
    matBtn.type = 'button';
    matBtn.textContent = '⊞ Matrix ▾';
    matBtn.title = 'Insert a matrix (pmatrix / bmatrix / vmatrix / cases)';
    matBtn.style.fontFamily = 'inherit';
    bar.appendChild(matBtn);
    var pop = null;
    function closePop() {
      if (pop) { pop.remove(); pop = null; }
      document.removeEventListener('pointerdown', onDocDown, true);
    }
    function onDocDown(ev) {
      if (!document.contains(bar)) { closePop(); return; }
      if (pop && !pop.contains(ev.target) && ev.target !== matBtn) closePop();
    }
    matBtn.addEventListener('click', function () {
      if (pop) { closePop(); return; }
      pop = document.createElement('div');
      pop.className = 'ml-snipbar-pop';
      pop.innerHTML =
        '<label>Type <select class="ml-mat-type">' +
          '<option value="pmatrix">( ) pmatrix</option>' +
          '<option value="bmatrix">[ ] bmatrix</option>' +
          '<option value="vmatrix">| | vmatrix</option>' +
          '<option value="Bmatrix">{ } Bmatrix</option>' +
          '<option value="cases">cases</option>' +
        '</select></label>' +
        '<label>Rows <input class="ml-mat-rows" type="number" min="1" max="6" value="2"></label>' +
        '<label>Columns <input class="ml-mat-cols" type="number" min="1" max="6" value="2"></label>' +
        '<button type="button" class="ml-snipbar-go">Insert</button>';
      pop.querySelector('.ml-snipbar-go').addEventListener('click', function () {
        var env = pop.querySelector('.ml-mat-type').value;
        var rows = Math.max(1, Math.min(6, parseInt(pop.querySelector('.ml-mat-rows').value, 10) || 2));
        var cols = Math.max(1, Math.min(6, parseInt(pop.querySelector('.ml-mat-cols').value, 10) || 2));
        if (env === 'cases') cols = 2;   // value & condition
        var rowTex = [];
        for (var r = 0; r < rows; r++) {
          var cells = [];
          for (var c = 0; c < cols; c++) cells.push('\\placeholder{}');
          rowTex.push(cells.join(' & '));
        }
        var latex = '\\begin{' + env + '} ' + rowTex.join(' \\\\ ') + ' \\end{' + env + '}';
        closePop();
        _snipInsert(mf, latex);
      });
      bar.appendChild(pop);
      document.addEventListener('pointerdown', onDocDown, true);
    });
    addSep();
    /* Operators */
    addBtn('∑', '\\sum_{#?}^{#?}', 'Sum');
    addBtn('∏', '\\prod_{#?}^{#?}', 'Product');
    addBtn('∫', '\\int_{#?}^{#?}', 'Integral');
    addBtn('∮', '\\oint', 'Contour integral');
    addBtn('∂', '\\partial', 'Partial');
    addBtn('∇', '\\nabla', 'Nabla / del');
    addBtn('∞', '\\infty', 'Infinity');
    addBtn('±', '\\pm', 'Plus-minus');
    addBtn('⋅', '\\cdot', 'Dot product');
    addBtn('×', '\\times', 'Cross / times');

    return bar;
  }

  window.mathliveSnippetBar = mathliveSnippetBar;
})();
