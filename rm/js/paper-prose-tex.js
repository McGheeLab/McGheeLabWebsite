/* paper-prose-tex.js — V3.915: LaTeX written inside prose.
 *
 * A paper imported from a LaTeX source carries LaTeX in its paragraphs:
 * siunitx units (`5~\si{\micro\metre}`, `\SI{37}{\degreeCelsius}`),
 * cleveref (`\cref{fig:setup}`), escaped specials (`\%`, `\$`), ties
 * (`n~=~3`), `\textsubscript{2}`. The builder's own prose vocabulary is
 * markdown-ish (`**bold**`, `~sub~`, `[!fig:x]`), so before this file the
 * Document view printed the commands raw, the .tex export (since V3.906)
 * escaped their backslashes, and a tie pair such as `[X]~\si{…} (n~` was
 * read as one long `~subscript~`, which set a whole clause as a single
 * unbreakable box that ran into the margin.
 *
 * One reader for both sides, so the preview and the PDF agree:
 *   readCommand(s, i)  → the control sequence at s[i] with its arguments
 *   tildeAt(s, i)      → what a `~` is: {kind:'sub', end} | 'tie' | 'text'
 *   unitHtml / numHtml → siunitx output, as the PDF sets it
 *   toHtml(cmd, ctx)   → Document view HTML (ctx renders nested prose,
 *                        reference chips, citations, footnotes, math)
 *   toTex(cmd, ctx)    → .tex (verbatim, except references and citations,
 *                        which follow the template the way the builder's
 *                        own [!fig:…] / [@key] tokens do)
 *   packagesFor(tex)   → packages the authored LaTeX needs (siunitx,
 *                        cleveref, booktabs, float)
 *   parseTabular(raw)  → an imported `\begin{tabular}` as rows of cells
 *
 * Pure: no DOM. Loaded by paper-builder.html and paper-export.html before
 * paper-editor.js / paper-export-tex.js; Node-tested by
 * scripts/tests/paper-prose-tex.test.mjs. */
(function (root) {
  'use strict';

  /* ── reading a control sequence ───────────────────────────── */

  /* How many {…} arguments a known command takes, and whether it takes a
   * leading […] option. Unknown commands take every {…} group that
   * follows directly. */
  var ARITY = {
    si: 1, unit: 1, num: 1, ang: 1, SI: 2, qty: 2, SIrange: 3, qtyrange: 3, numrange: 2,
    SIlist: 2, qtylist: 2, numlist: 1, complexnum: 1, tablenum: 1,
    cref: 1, Cref: 1, ref: 1, autoref: 1, eqref: 1, pageref: 1, nameref: 1, crefrange: 2, Crefrange: 2,
    cite: 1, citep: 1, citet: 1, citealp: 1, citealt: 1, citeauthor: 1, citeyear: 1, parencite: 1, textcite: 1,
    textbf: 1, textit: 1, emph: 1, textsl: 1, textsc: 1, texttt: 1, textrm: 1, textsf: 1, textup: 1,
    textmd: 1, textnormal: 1, underline: 1, uline: 1, mbox: 1, text: 1, hbox: 1,
    textsubscript: 1, textsuperscript: 1, footnote: 1, ensuremath: 1, url: 1, href: 2,
    label: 1, index: 1, hspace: 1, vspace: 1, phantom: 1,
  };
  var OPTIONAL = {
    si: 1, unit: 1, num: 1, ang: 1, SI: 1, qty: 1, SIrange: 1, qtyrange: 1, numrange: 1,
    SIlist: 1, qtylist: 1, numlist: 1, cite: 2, citep: 2, citet: 2, citealp: 2, parencite: 2,
    textcite: 2, footnote: 1, hspace: 0,
  };

  /* index of the bracket matching s[i] (balanced, `\{` / `\}` skipped), or -1 */
  function matchGroup(s, i, open, close) {
    var depth = 0;
    for (var j = i; j < s.length; j++) {
      var c = s[j];
      if (c === '\\') { j++; continue; }
      if (c === open) depth++;
      else if (c === close) { depth--; if (depth === 0) return j; }
      else if (c === '\n' && open === '[') return -1;
    }
    return -1;
  }

  /* The control sequence at s[i] (which is a backslash):
   *   {name, star, opts:[…], args:[…], end, src, symbol}
   * `symbol` is true for a control symbol (`\%`, `\,`). Returns null when
   * s[i] is not a backslash or ends the string, or when a known command's
   * arguments are missing or unbalanced (the caller then treats the
   * backslash as text). */
  function readCommand(s, i) {
    if (s.charAt(i) !== '\\' || i + 1 >= s.length) return null;
    var c = s.charAt(i + 1);
    if (!/[A-Za-z]/.test(c)) {
      return { name: c, symbol: true, star: false, opts: [], args: [], end: i + 2, src: s.slice(i, i + 2) };
    }
    var j = i + 1;
    while (j < s.length && /[A-Za-z]/.test(s.charAt(j))) j++;
    var name = s.slice(i + 1, j);
    var star = false;
    if (s.charAt(j) === '*') { star = true; j++; }
    var opts = [], args = [];
    var maxOpt = OPTIONAL[name] || 0;
    while (opts.length < maxOpt && s.charAt(j) === '[') {
      var e = matchGroup(s, j, '[', ']');
      if (e < 0) break;
      opts.push(s.slice(j + 1, e));
      j = e + 1;
    }
    var want = ARITY.hasOwnProperty(name) ? ARITY[name] : -1;
    while ((want < 0 || args.length < want) && s.charAt(j) === '{') {
      var g = matchGroup(s, j, '{', '}');
      if (g < 0) return want > 0 ? null : { name: name, star: star, opts: opts, args: args, end: j, src: s.slice(i, j) };
      args.push(s.slice(j + 1, g));
      j = g + 1;
    }
    if (want > 0 && args.length < want) return null;
    /* a control word swallows the spaces after it when it takes no
     * argument (`\pm 5` sets "±5"); keep them in `src` for verbatim
     * output but report where the text resumes */
    var resume = j;
    if (!args.length && !opts.length) while (s.charAt(resume) === ' ') resume++;
    return { name: name, star: star, opts: opts, args: args, end: j, resume: resume, src: s.slice(i, j) };
  }

  /* ── tildes ────────────────────────────────────────────────── */

  /* What the `~` at s[i] is. The builder writes subscripts `H~2~O`,
   * `OVA~257–264~`, `τ~1/2~`; LaTeX writes ties `5~mm`, `n~=~3`,
   * `[X]~\si{\micro\metre}`. A subscript is short and word-like — no
   * spaces, brackets, braces, parentheses, `=`, sentence punctuation,
   * backslashes or placeholders, at least one letter or digit — right
   * after a non-space character. Anything else between two non-space
   * characters is a tie (a no-break space); a `~` beside a space is the
   * character itself ("~5 µm" = about 5 µm). */
  var SUB_BAD = /[\s~\\\[\]{}()=<>;:!?"&%$#@-]/;
  function tildeAt(s, i) {
    var prev = i > 0 ? s.charAt(i - 1) : '';
    var next = s.charAt(i + 1);
    if (prev && !/\s/.test(prev)) {
      var j = s.indexOf('~', i + 1);
      if (j > i + 1 && j - i - 1 <= 24) {
        var inner = s.slice(i + 1, j);
        if (!SUB_BAD.test(inner) && /[0-9A-Za-zª-ￜ]/.test(inner)) return { kind: 'sub', end: j, inner: inner };
      }
    }
    if (prev && next && !/\s/.test(prev) && !/\s/.test(next)) return { kind: 'tie' };
    return { kind: 'text' };
  }

  /* ── siunitx ───────────────────────────────────────────────── */

  var PREFIX = {
    quecto: 'q', ronto: 'r', yocto: 'y', zepto: 'z', atto: 'a', femto: 'f', pico: 'p', nano: 'n',
    micro: 'µ', milli: 'm', centi: 'c', deci: 'd', deca: 'da', deka: 'da', hecto: 'h', kilo: 'k',
    mega: 'M', giga: 'G', tera: 'T', peta: 'P', exa: 'E', zetta: 'Z', yotta: 'Y',
  };
  /* siunitx's own symbols (\litre is "l", \liter "L", as in the PDF) */
  var UNIT = {
    metre: 'm', meter: 'm', gram: 'g', kilogram: 'kg', second: 's', minute: 'min', hour: 'h', day: 'd',
    litre: 'l', liter: 'L', ampere: 'A', kelvin: 'K', mole: 'mol', candela: 'cd', becquerel: 'Bq',
    degreeCelsius: '°C', celsius: '°C', coulomb: 'C', farad: 'F', gray: 'Gy', hertz: 'Hz',
    henry: 'H', joule: 'J', katal: 'kat', lumen: 'lm', lux: 'lx', newton: 'N', ohm: 'Ω',
    pascal: 'Pa', radian: 'rad', siemens: 'S', sievert: 'Sv', steradian: 'sr', tesla: 'T',
    volt: 'V', watt: 'W', weber: 'Wb', tonne: 't', hectare: 'ha', electronvolt: 'eV', dalton: 'Da',
    atomicmassunit: 'u', astronomicalunit: 'au', bar: 'bar', angstrom: 'Å', barn: 'b',
    bel: 'B', decibel: 'dB', neper: 'Np', knot: 'kn', mmHg: 'mmHg', molar: 'M', Molar: 'M',
    percent: '%', degree: '°', arcminute: '′', arcsecond: '″', rpm: 'rpm',
    hectopascal: 'hPa', calorie: 'cal', gauss: 'G', torr: 'Torr', erg: 'erg', poise: 'P',
    clight: 'c', electronmass: 'mₑ', planckbar: 'ħ', elementarycharge: 'e',
  };
  var POWER_PREFIX = { square: '2', cubic: '3' };
  var POWER_POSTFIX = { squared: '2', cubed: '3' };
  var SUPERSCRIPT_CHARS = { '-': '−', '−': '−' };

  function esc(t) {
    return String(t).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
  }
  function supHtml(p) { return '<sup>' + esc(String(p).replace(/-/g, '−')) + '</sup>'; }

  /* A siunitx unit spec → HTML ("µm", "mm min<sup>−1</sup>", "°C").
   * Products are joined with a thin space, \per gives a −1 power (siunitx's
   * default per-mode), literal units (`mm/min`, `kg.m^2`) pass through. */
  var THIN = ' ';   // narrow no-break space: siunitx's \, inside a unit
  function unitHtml(spec) {
    var s = String(spec || '');
    var units = [];       // {sym, pow, literal}
    var prefix = '', per = false, prePow = '';
    function push(sym, literal) {
      var pow = prePow;
      if (per) pow = pow ? '-' + pow : '-1';
      units.push({ sym: prefix + sym, pow: pow, literal: !!literal });
      prefix = ''; per = false; prePow = '';
    }
    var lit = '';
    function flushLit() {
      if (!lit) return;
      push(lit, true);
      lit = '';
    }
    for (var i = 0; i < s.length;) {
      var c = s.charAt(i);
      if (c === '\\') {
        var cmd = readCommand(s, i);
        if (!cmd) { lit += c; i++; continue; }
        flushLit();
        var n = cmd.name;
        if (PREFIX.hasOwnProperty(n)) prefix += PREFIX[n];
        else if (UNIT.hasOwnProperty(n)) push(UNIT[n]);
        else if (n === 'per') per = true;
        else if (POWER_PREFIX[n]) prePow = POWER_PREFIX[n];
        else if (POWER_POSTFIX[n] && units.length) {
          var last = units[units.length - 1];
          last.pow = last.pow && last.pow.charAt(0) === '-' ? '-' + POWER_POSTFIX[n] : POWER_POSTFIX[n];
        } else if (n === 'tothe' && units.length) units[units.length - 1].pow = cmd.args[0] || '';
        else if (n === 'raiseto') prePow = cmd.args[0] || '';
        else if (n === 'of' && units.length) units[units.length - 1].sub = cmd.args[0] || '';
        else if (cmd.symbol && cmd.name === ',') { /* product separator */ }
        else if (cmd.args.length) lit += cmd.args[cmd.args.length - 1];
        i = cmd.end;
        continue;
      }
      if (c === '^') {
        flushLit();
        var pw = '';
        if (s.charAt(i + 1) === '{') {
          var e = matchGroup(s, i + 1, '{', '}');
          if (e > 0) { pw = s.slice(i + 2, e); i = e + 1; } else i++;
        } else { pw = s.charAt(i + 1); i += 2; }
        if (units.length) units[units.length - 1].pow = pw;
        continue;
      }
      if (c === '.' || c === '~' || c === ' ') { flushLit(); i++; continue; }
      lit += c;
      i++;
    }
    flushLit();
    if (prefix) units.push({ sym: prefix, pow: '' });
    return units.map(function (u, k) {
      var h = esc(u.sym) + (u.sub ? '<sub>' + esc(u.sub) + '</sub>' : '') + (u.pow ? supHtml(u.pow) : '');
      /* a literal unit carries its own separators (mm/min) */
      return (k && !(u.literal && /^\//.test(u.sym)) && !(units[k - 1].literal && /\/$/.test(units[k - 1].sym)) ? THIN : '') + h;
    }).join('');
  }

  /* A siunitx number → HTML: "1.5e-3" → "1.5 × 10<sup>−3</sup>",
   * "1.2 +- 0.1" → "1.2 ± 0.1", digit groups of five or more get thin
   * spaces (12 345), a leading minus is a real minus. */
  function groupDigits(int) {
    if (int.length < 5) return int;
    return int.replace(/\B(?=(\d{3})+(?!\d))/g, THIN);
  }
  function numHtml(spec) {
    var s = String(spec || '').trim();
    s = s.replace(/\\pm|\+-/g, ' ± ').replace(/\\times/g, ' × ')
      .replace(/(\d)\s*x\s*(?=\d)/g, '$1 × ').replace(/\s+/g, ' ').trim();
    return s.split(' ').map(function (tok) {
      var m = /^([+\-]?)(\d*)([.,]?)(\d*)(?:[eEdD]([+\-]?\d+))?$/.exec(tok);
      if (!m || (!m[2] && !m[4])) return esc(tok);
      var out = (m[1] === '-' ? '−' : m[1]) + groupDigits(m[2] || '0') + (m[3] ? '.' + m[4] : '');
      if (m[5] != null) out += ' × 10' + supHtml(String(parseInt(m[5], 10)));
      return out;
    }).join(' ');
  }

  /* ── what each command becomes ─────────────────────────────── */

  var REF = { cref: 1, Cref: 1, ref: 1, autoref: 1, eqref: 1, pageref: 1, nameref: 1, crefrange: 1, Crefrange: 1 };
  var CITE = { cite: 1, citep: 1, citet: 1, citealp: 1, citealt: 1, citeauthor: 1, citeyear: 1, parencite: 1, textcite: 1 };
  var SIUNITX = { si: 1, unit: 1, num: 1, ang: 1, SI: 1, qty: 1, SIrange: 1, qtyrange: 1, numrange: 1, SIlist: 1, qtylist: 1, numlist: 1 };
  var FORMAT = {
    textbf: 'strong', textit: 'em', emph: 'em', textsl: 'em', textsc: 'sc', texttt: 'code',
    textsubscript: 'sub', textsuperscript: 'sup', underline: 'u', uline: 'u',
    textrm: '', textsf: '', textup: '', textmd: '', textnormal: '', mbox: '', text: '', hbox: '',
  };
  /* text symbols (and math commands written outside math) */
  var SYMBOL = {
    textdegree: '°', degree: '°', textmu: 'µ', micro: 'µ', textpm: '±', pm: '±',
    times: '×', texttimes: '×', div: '÷', cdot: '·', textperiodcentered: '·',
    ldots: '…', dots: '…', textellipsis: '…', textendash: '–', textemdash: '—',
    textasciitilde: '~', textbackslash: '\\', textless: '<', textgreater: '>', textbar: '|',
    textquoteleft: '‘', textquoteright: '’', textquotedblleft: '“', textquotedblright: '”',
    S: '§', P: '¶', copyright: '©', textcopyright: '©', textregistered: '®',
    texttrademark: '™', dag: '†', ddag: '‡', textdagger: '†', textdaggerdbl: '‡',
    pounds: '£', texteuro: '€', euro: '€', ss: 'ß', ae: 'æ', AE: 'Æ',
    o: 'ø', O: 'Ø', oe: 'œ', OE: 'Œ', aa: 'å', AA: 'Å', l: 'ł', L: 'Ł',
    LaTeX: 'LaTeX', TeX: 'TeX', textpercent: '%', percent: '%', approx: '≈', sim: '∼',
    leq: '≤', geq: '≥', le: '≤', ge: '≥', neq: '≠', ne: '≠', rightarrow: '→',
    to: '→', leftarrow: '←', infty: '∞', alpha: 'α', beta: 'β', gamma: 'γ',
    delta: 'δ', Delta: 'Δ', epsilon: 'ε', lambda: 'λ', mu: 'μ', pi: 'π',
    sigma: 'σ', tau: 'τ', theta: 'θ', omega: 'ω', Omega: 'Ω', phi: 'φ',
    newline: ' ', linebreak: ' ', par: ' ', noindent: '', centering: '', relax: '', ignorespaces: '',
    xspace: '', protect: '', nobreak: '', smallskip: '', medskip: '', bigskip: '', quad: ' ',
    qquad: '  ', enspace: ' ', thinspace: ' ', allowbreak: '', label: '',
  };
  /* control symbols: the character itself, or a space */
  var CONTROL_SYMBOL = {
    '%': '%', '$': '$', '&': '&', '#': '#', '_': '_', '{': '{', '}': '}', ',': ' ', ' ': ' ',
    ';': ' ', ':': ' ', '!': '', '-': '', '/': '', '\\': ' ', '@': '', '\'': '', '"': '',
  };
  var ACCENT = { '\'': '́', '`': '̀', '^': '̂', '"': '̈', '~': '̃', '=': '̄',
    '.': '̇', u: '̆', v: '̌', H: '̋', c: '̧', k: '̨', r: '̊', d: '̣' };

  function refKind(label) {
    var p = String(label).split(':')[0].toLowerCase();
    if (/^(fig|sfig|figure)$/.test(p)) return 'figure';
    if (/^(tab|tbl|stab|table)$/.test(p)) return 'table';
    if (/^(eq|eqn|equation)$/.test(p)) return 'equation';
    if (/^(sec|ssec|subsec|chap|app|appendix|part)$/.test(p)) return 'section';
    return 'unknown';
  }
  function joinList(parts, and) {
    if (parts.length < 2) return parts.join('');
    return parts.slice(0, -1).join(', ') + (parts.length > 2 ? ',' : '') + ' ' + and + ' ' + parts[parts.length - 1];
  }
  function splitKeys(arg) { return String(arg || '').split(',').map(function (k) { return k.trim(); }).filter(Boolean); }

  /* Document view HTML for one command, or null when the caller should
   * print the source. ctx: {
   *   render(text)                → HTML of nested prose,
   *   ref(kind, label, form)      → HTML of one reference; form 'name'
   *                                 ("Fig. 3") or 'number' ("3"),
   *   cite(keys[], narrative)     → HTML of a citation group,
   *   footnote(text)              → HTML of a footnote marker,
   *   math(tex)                   → inline math HTML }. */
  function toHtml(cmd, ctx) {
    var n = cmd.name, a = cmd.args;
    if (cmd.symbol) {
      if (CONTROL_SYMBOL.hasOwnProperty(n)) return esc(CONTROL_SYMBOL[n]);
      return null;
    }
    if (ACCENT[n] && a.length === 1 && a[0].length === 1) return esc((a[0] + ACCENT[n]).normalize('NFC'));
    if (SIUNITX[n]) {
      if (n === 'si' || n === 'unit') return '<span class="pe-si">' + unitHtml(a[0]) + '</span>';
      if (n === 'num' || n === 'numlist') return '<span class="pe-si">' + numHtml(String(a[0]).replace(/;/g, ', ')) + '</span>';
      if (n === 'ang') return '<span class="pe-si">' + numHtml(a[0]) + '°</span>';
      if (n === 'SI' || n === 'qty') {
        var u = unitHtml(a[1]);
        /* siunitx sets angles (\degree, \arcminute) against the number */
        return '<span class="pe-si">' + numHtml(a[0]) + (/^[°′″]$/.test(u) ? '' : THIN) + u + '</span>';
      }
      if (n === 'SIlist' || n === 'qtylist') {
        var ul = unitHtml(a[1]);
        return '<span class="pe-si">' + joinList(String(a[0]).split(';').map(function (x) { return numHtml(x) + THIN + ul; }), 'and') + '</span>';
      }
      if (n === 'SIrange' || n === 'qtyrange') {
        var ur = unitHtml(a[2]);
        return '<span class="pe-si">' + numHtml(a[0]) + THIN + ur + ' to ' + numHtml(a[1]) + THIN + ur + '</span>';
      }
      if (n === 'numrange') return '<span class="pe-si">' + numHtml(a[0]) + ' to ' + numHtml(a[1]) + '</span>';
    }
    if (REF[n]) {
      var labels = splitKeys(a[0]);
      if (n === 'crefrange' || n === 'Crefrange') labels = [a[0], a[1]];
      var form = (n === 'ref' || n === 'eqref' || n === 'pageref') ? 'number' : 'name';
      var parts = labels.map(function (lb, k) {
        return ctx.ref(refKind(lb), lb, k === 0 ? form : 'number');
      });
      var h = joinList(parts, n.indexOf('range') > 0 ? 'to' : 'and');
      if (n === 'eqref') h = '(' + h + ')';
      return h;
    }
    if (CITE[n]) return ctx.cite(splitKeys(a[0]), n === 'citet' || n === 'textcite' || n === 'citeauthor');
    if (n === 'footnote') return ctx.footnote(a[0] || '');
    if (n === 'ensuremath') return ctx.math(a[0] || '');
    if (n === 'url') return '<span class="pe-url">' + esc(a[0] || '') + '</span>';
    if (n === 'href') return ctx.render(a[1] || '');
    if (n === 'label' || n === 'index' || n === 'hspace' || n === 'vspace' || n === 'phantom') return '';
    if (FORMAT.hasOwnProperty(n) && a.length) {
      var tag = FORMAT[n], inner = ctx.render(a[0]);
      if (!tag) return inner;
      if (tag === 'sc') return '<span style="font-variant:small-caps">' + inner + '</span>';
      return '<' + tag + '>' + inner + '</' + tag + '>';
    }
    if (SYMBOL.hasOwnProperty(n)) return esc(SYMBOL[n]);
    /* an unknown command (a macro from the original preamble, a typo, a
     * Windows path): the source as text — what the PDF prints too */
    return null;
  }

  /* Commands the export may pass to LaTeX as they are: standard LaTeX or
   * a package packagesFor() loads. */
  function known(name) {
    return ARITY.hasOwnProperty(name) || SYMBOL.hasOwnProperty(name) || FORMAT.hasOwnProperty(name) ||
      ACCENT.hasOwnProperty(name) || SIUNITX.hasOwnProperty(name);
  }
  /* written outside math, these need math mode in LaTeX */
  var MATH_ONLY = {
    pm: 1, times: 1, div: 1, cdot: 1, approx: 1, sim: 1, leq: 1, geq: 1, le: 1, ge: 1, neq: 1, ne: 1,
    rightarrow: 1, to: 1, leftarrow: 1, infty: 1, alpha: 1, beta: 1, gamma: 1, delta: 1, Delta: 1,
    epsilon: 1, lambda: 1, mu: 1, pi: 1, sigma: 1, tau: 1, theta: 1, omega: 1, Omega: 1, phi: 1,
  };
  /* siunitx v3 defines its unit macros only inside \si / \unit */
  var TEXT_FORM = { micro: '\\textmu{}', degree: '\\textdegree{}', percent: '\\%', texttimes: '\\texttimes{}' };

  /* .tex for one command: a string, null to keep the source verbatim, or
   * false for an unknown command (the caller sets its source as text).
   * ctx: { ref(kind, label, form, capital) → LaTeX of one reference,
   *        cite(keys[], narrative, command) → LaTeX, useCref: bool }. */
  function toTex(cmd, ctx) {
    var n = cmd.name, a = cmd.args;
    if (cmd.symbol) return CONTROL_SYMBOL.hasOwnProperty(n) || ACCENT[n] ? null : false;
    if (REF[n] && !(ctx.useCref && n !== 'autoref')) {
      if (n === 'ref' || n === 'eqref' || n === 'pageref' || n === 'nameref') return null;
      var labels = splitKeys(a[0]);
      if (n === 'crefrange' || n === 'Crefrange') labels = [a[0], a[1]];
      var parts = labels.map(function (lb, k) {
        return ctx.ref(refKind(lb), lb, k === 0 ? 'name' : 'number', n.charAt(0) === 'C');
      });
      return joinList(parts, n.indexOf('range') > 0 ? 'to' : 'and');
    }
    if (CITE[n] && ctx.cite) return ctx.cite(splitKeys(a[0]), n === 'citet' || n === 'textcite', n);
    if (TEXT_FORM[n]) return TEXT_FORM[n];
    if (MATH_ONLY[n]) return '\\ensuremath{' + cmd.src + '}';
    return known(n) ? null : false;
  }

  /* Packages the authored LaTeX in a .tex body needs. */
  function packagesFor(tex) {
    var s = String(tex || '');
    var need = [];
    if (/\\(si|SI|num|qty|unit|ang|SIrange|qtyrange|numrange|SIlist|qtylist|numlist|tablenum)\s*[\[{]/.test(s)) need.push('siunitx');
    if (/\\(cref|Cref|crefrange|Crefrange)\s*\{/.test(s)) need.push('cleveref');
    if (/\\(toprule|midrule|bottomrule|cmidrule)\b/.test(s)) need.push('booktabs');
    if (/\\begin\{(table|figure)\*?\}\s*\[[^\]]*H/.test(s)) need.push('float');
    if (/\\(uline|sout)\s*\{/.test(s)) need.push('ulem');
    return need;
  }
  /* Is a package already loaded by this preamble? (A class may load it
   * too; loading it again without options never clashes.) */
  function preambleLoads(preamble, pkg) {
    var re = new RegExp('\\\\(usepackage|RequirePackage)(\\[[^\\]]*\\])?\\{[^}]*\\b' + pkg + '\\b[^}]*\\}');
    return re.test(String(preamble || ''));
  }

  /* ── imported tables ───────────────────────────────────────── */

  /* `\begin{table}…\caption{…}\label{…}\begin{tabular}{spec}…\end{tabular}`
   * → {caption, label, align, rows:[[cell,…],…], rules:[rowIndex…], header}
   * Cells are prose (LaTeX) for the caller's renderer. Returns null when
   * there is no tabular. */
  function parseTabular(raw) {
    var s = String(raw || '');
    var out = { caption: '', label: '', align: '', rows: [], rulesAfter: [], header: false, small: /\\(small|footnotesize|scriptsize)\b/.test(s) };
    var cap = s.indexOf('\\caption');
    if (cap >= 0) {
      var cc = readCommand(s, cap);
      if (cc && cc.args.length) out.caption = cc.args[cc.args.length - 1];
    }
    var lab = /\\label\{([^}]*)\}/.exec(s);
    if (lab) out.label = lab[1];
    var b = /\\begin\{(tabular\*?|tabularx|longtable|tabulary)\}/.exec(s);
    if (!b) return null;
    var j = b.index + b[0].length;
    if (b[1] === 'tabular*' || b[1] === 'tabularx' || b[1] === 'tabulary') {      // width argument
      var w = matchGroup(s, j, '{', '}');
      if (w > 0) j = w + 1;
    }
    var spec = '';
    if (s.charAt(j) === '{') {
      var se = matchGroup(s, j, '{', '}');
      if (se > 0) { spec = s.slice(j + 1, se); j = se + 1; }
    }
    var end = s.indexOf('\\end{' + b[1] + '}', j);
    var body = s.slice(j, end < 0 ? s.length : end);
    /* column alignments: l c r, p{…}/m{…}/b{…}/X → l, ignore | @{} >{} <{} */
    var al = '';
    for (var k = 0; k < spec.length; k++) {
      var ch = spec.charAt(k);
      if (ch === '{') { var ge = matchGroup(spec, k, '{', '}'); k = ge < 0 ? k : ge; continue; }
      if (ch === '@' || ch === '>' || ch === '<' || ch === '!') {
        var ne = spec.indexOf('{', k);
        if (ne >= 0) { var ge2 = matchGroup(spec, ne, '{', '}'); k = ge2 < 0 ? k : ge2; }
        continue;
      }
      if (/[lcr]/.test(ch)) al += ch;
      else if (/[pmbXLCRS]/.test(ch)) al += ch === 'C' ? 'c' : ch === 'R' || ch === 'S' ? 'r' : 'l';
    }
    out.align = al;
    /* rows: split on \\ at brace depth 0, cells on & at depth 0 */
    var rowsSrc = [], cur = '', depth = 0;
    for (var p = 0; p < body.length; p++) {
      var c = body.charAt(p);
      if (c === '\\' && body.charAt(p + 1) === '\\' && depth === 0) {
        rowsSrc.push(cur); cur = ''; p++;
        if (body.charAt(p + 1) === '[') { var oe = body.indexOf(']', p + 1); if (oe > 0) p = oe; }
        continue;
      }
      if (c === '\\') { cur += c + body.charAt(p + 1); p++; continue; }
      if (c === '{') depth++;
      if (c === '}') depth--;
      cur += c;
    }
    rowsSrc.push(cur);
    var RULE = /\\(toprule|midrule|bottomrule|hline|cline\{[^}]*\}|cmidrule(\([^)]*\))?\{[^}]*\}|addlinespace(\[[^\]]*\])?)/g;
    rowsSrc.forEach(function (r) {
      var hadRule = /\\(midrule|hline|cmidrule|cline)/.test(r);
      var text = r.replace(RULE, '').trim();
      if (hadRule && out.rows.length && text.indexOf('&') < 0 && !text) out.rulesAfter.push(out.rows.length - 1);
      else if (hadRule && out.rows.length && /^\s*\\(midrule|hline|cmidrule|cline)/.test(r)) out.rulesAfter.push(out.rows.length - 1);
      if (!text) return;
      var cells = [], cell = '', d = 0;
      for (var q = 0; q < text.length; q++) {
        var t = text.charAt(q);
        if (t === '\\') { cell += t + text.charAt(q + 1); q++; continue; }
        if (t === '{') d++;
        if (t === '}') d--;
        if (t === '&' && d === 0) { cells.push(cell.trim()); cell = ''; continue; }
        cell += t;
      }
      cells.push(cell.trim());
      out.rows.push(cells.map(function (x) {
        /* \multicolumn{n}{a}{text} → its text (span recorded) */
        var m = /^\\multicolumn\{(\d+)\}\{[^}]*\}\{([\s\S]*)\}$/.exec(x);
        return m ? { text: m[2], span: parseInt(m[1], 10) } : { text: x, span: 1 };
      }));
    });
    out.header = out.rulesAfter.indexOf(0) >= 0;
    return out;
  }

  /* BibTeX-style accents in metadata (`Andr{\'e}`, `J\'{e}r\^{o}me`,
   * `{\ss}`, `\"o`) → Unicode, so the .bib writer and the Document view
   * treat them like any other accented letter. Other braces are dropped
   * only when they wrapped an accent. */
  var ACCENT_RE = /\{?\\(['`^"~=.uvHckrdb])\s*(?:\{\s*(\\[ij]|[A-Za-z])\s*\}|(\\[ij]|[A-Za-z]))\}?/g;
  var LETTER_CMD = { ss: 'ß', o: 'ø', O: 'Ø', ae: 'æ', AE: 'Æ', oe: 'œ',
    OE: 'Œ', aa: 'å', AA: 'Å', l: 'ł', L: 'Ł', i: 'ı', j: 'ȷ' };
  function decodeAccents(s) {
    var str = String(s == null ? '' : s);
    if (str.indexOf('\\') < 0) return str;
    var ACC = { '\'': '́', '`': '̀', '^': '̂', '"': '̈', '~': '̃', '=': '̄',
      '.': '̇', u: '̆', v: '̌', H: '̋', c: '̧', k: '̨', r: '̊', d: '̣', b: '̱' };
    str = str.replace(ACCENT_RE, function (m, acc, b1, b2) {
      var base = b1 || b2;
      if (base === '\\i') base = 'i';
      if (base === '\\j') base = 'j';
      return (base + ACC[acc]).normalize ? (base + ACC[acc]).normalize('NFC') : base + ACC[acc];
    });
    return str.replace(/\{?\\(ss|o|O|ae|AE|oe|OE|aa|AA|l|L)\b\s*(\{\})?\}?/g, function (m, w) { return LETTER_CMD[w]; });
  }

  var API = {
    decodeAccents: decodeAccents,
    readCommand: readCommand, tildeAt: tildeAt, unitHtml: unitHtml, numHtml: numHtml,
    toHtml: toHtml, toTex: toTex, refKind: refKind, packagesFor: packagesFor,
    preambleLoads: preambleLoads, parseTabular: parseTabular, SIUNITX: SIUNITX,
  };
  if (typeof module !== 'undefined' && module.exports) module.exports = API;
  root.PaperProseTex = API;
})(typeof window !== 'undefined' ? window : globalThis);
