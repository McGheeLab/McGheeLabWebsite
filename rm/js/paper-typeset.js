/* paper-typeset.js — TeX-faithful paragraph typesetting for the Document
 * view (V3.908).
 *
 * The compiled PDF breaks lines with TeX's Knuth–Plass algorithm and
 * Liang's hyphenation patterns; the browser breaks greedily and
 * hyphenates with its own dictionary. Same words, different line
 * counts — and every extra or missing line moves a column break, a page
 * break, a figure. This module gives the Document view TeX's rules:
 *
 *   PaperTypeset.hyphenate(word)          → ['hy', 'phen', 'ate']  (en-US, TeX's patterns)
 *   PaperTypeset.breakLines(items, widths, params)
 *                                         → { breaks, ratios, lines, overfull }
 *   PaperTypeset.layoutParagraph(el, opts)
 *        measures the paragraph's own DOM (words, citation chips, KaTeX)
 *        in place, breaks it with Knuth–Plass, and rebuilds `el` as one
 *        block per line (`.pts-ln`), each justified exactly by
 *        word-spacing. Returns { lines, height, overfull }.
 *
 * Parameters default to LaTeX's (tolerance 200, pretolerance 100,
 * linepenalty 10, hyphenpenalty / exhyphenpenalty 50, adjdemerits 10000,
 * doublehyphendemerits 10000, finalhyphendemerits 5000, \lefthyphenmin 2,
 * \righthyphenmin 3) and to XeTeX's inter-word glue for OpenType fonts
 * (space = the font's space advance, stretch = space/2, shrink = space/3).
 * The generated LaTeX uses \frenchspacing, so every inter-word space is the
 * same glue (no extra space after periods) — the model here.
 *
 * Pure parts (hyphenate, breakLines) run in Node for tests:
 *   const PT = require('rm/js/paper-typeset.js'); PT.setPatterns(require('rm/vendor/hyphen/hyph-en-us.js'))
 */
(function (root) {
  'use strict';

  var INF_BAD = 10000;
  var EJECT = -10000;      // forced break
  var INF_PENALTY = 10000; // never break

  var DEFAULTS = {
    tolerance: 200, pretolerance: 100, linepenalty: 10,
    hyphenpenalty: 50, exhyphenpenalty: 50, adjdemerits: 10000,
    doublehyphendemerits: 10000, finalhyphendemerits: 5000,
    emergencystretch: 0, looseness: 0,
    lefthyphenmin: 2, righthyphenmin: 3,
    stretchFrac: 0.5, shrinkFrac: 1 / 3,   // XeTeX native-font glue
  };

  /* ── Liang hyphenation ─────────────────────────────────────── */

  var HYPH = null;   // { trie, exceptions, left, right }

  function setPatterns(data) {
    if (!data || !data.patterns) return;
    var trie = Object.create(null);
    data.patterns.split(/\s+/).forEach(function (p) {
      if (!p) return;
      var letters = p.replace(/[0-9]/g, '');
      var pts = [];
      var j = 0;
      for (var i = 0; i < p.length; i++) {
        var c = p.charAt(i);
        if (c >= '0' && c <= '9') pts[j] = +c;
        else j++;
      }
      var arr = [];
      for (var k = 0; k <= letters.length; k++) arr.push(pts[k] || 0);
      trie[letters] = arr;
    });
    var exc = Object.create(null);
    String(data.exceptions || '').split(/\s+/).forEach(function (w) {
      if (!w) return;
      exc[w.replace(/-/g, '')] = w.split('-');
    });
    HYPH = { trie: trie, exceptions: exc, left: data.lefthyphenmin || 2, right: data.righthyphenmin || 3 };
  }

  /* Pieces of a word at its legal hyphenation points (TeX: letters only,
   * lowercase-folded, \lefthyphenmin/\righthyphenmin respected). */
  function hyphenate(word) {
    if (!HYPH || !word) return [word];
    var lower = word.toLowerCase();
    if (!/^[a-zà-ÿ]+$/.test(lower)) return [word];
    if (word.length < HYPH.left + HYPH.right) return [word];
    var ex = HYPH.exceptions[lower];
    if (ex) {
      var out = [], pos = 0;
      ex.forEach(function (part) { out.push(word.substr(pos, part.length)); pos += part.length; });
      return out;
    }
    var w = '.' + lower + '.';
    var points = new Array(w.length + 1);
    for (var z = 0; z < points.length; z++) points[z] = 0;
    for (var i = 0; i < w.length; i++) {
      for (var j = i + 1; j <= w.length; j++) {
        var pat = HYPH.trie[w.slice(i, j)];
        if (!pat) continue;
        for (var k = 0; k < pat.length; k++) if (pat[k] > points[i + k]) points[i + k] = pat[k];
      }
    }
    // points[q] sits before w[q]; a break between word[m-1] and word[m] is points[m + 1]
    var pieces = [], start = 0;
    for (var m = HYPH.left; m <= word.length - HYPH.right; m++) {
      if (points[m + 1] % 2 === 1) { pieces.push(word.slice(start, m)); start = m; }
    }
    pieces.push(word.slice(start));
    return pieces;
  }

  /* ── Knuth–Plass (TeX's line_break) ────────────────────────── */

  /* items: {t:'box',w} | {t:'glue',w,y,z} | {t:'pen',w,p,f}
   * widths: number | array (per line; the last entry repeats) */
  function breakLines(items, widths, params) {
    var P = Object.assign({}, DEFAULTS, params || {});
    function lineWidth(line) {
      if (typeof widths === 'number') return widths;
      return widths[Math.min(line, widths.length - 1)];
    }
    var hasHyph = items.some(function (it) { return it.t === 'pen' && it.f && it.p < INF_PENALTY; });
    var passes = [];
    if (P.pretolerance >= 0) passes.push({ tol: P.pretolerance, hyph: false, final: false });
    passes.push({ tol: P.tolerance, hyph: true, final: !(P.emergencystretch > 0) });
    if (P.emergencystretch > 0) passes.push({ tol: P.tolerance, hyph: true, final: true, emerg: P.emergencystretch });

    // running sums
    var sumW = [0], sumY = [0], sumZ = [0];
    for (var a = 0; a < items.length; a++) {
      var it = items[a];
      var g = it.t === 'glue';
      sumW.push(sumW[a] + (it.t === 'pen' ? 0 : it.w));
      sumY.push(sumY[a] + (g ? it.y : 0));
      sumZ.push(sumZ[a] + (g ? it.z : 0));
    }
    // totals measured AFTER a break at index b: skip discardables
    function afterBreak(b) {
      var i = b;
      if (i < 0) i = 0;
      else if (items[i] && (items[i].t === 'glue' || items[i].t === 'pen')) {
        // the break item itself is discarded; so are following glue/penalties
        i++;
        while (i < items.length && (items[i].t === 'glue' || (items[i].t === 'pen' && items[i].p > EJECT))) i++;
      }
      return i;
    }

    /* V3.913 — with \looseness ≠ 0 TeX moves on to the next pass unless
     * this one reached the asked-for line count (tex.web §873: "if
     * (actual_looseness=looseness) or final_pass then goto done") */
    var lastRes = null;
    for (var pi = 0; pi < passes.length; pi++) {
      var pass = passes[pi];
      if (!pass.hyph && hasHyph && pi < passes.length - 1) { /* first pass ignores discretionaries */ }
      var res = runPass(pass);
      if (!res) continue;
      if (!P.looseness || res.actualLooseness === P.looseness || pass.final) return res;
      lastRes = res;
    }
    return lastRes;

    function runPass(pass) {
      var active = [{ pos: -1, start: 0, line: 0, fit: 2, dem: 0, prev: null, hyph: false }];
      var bestFinal = null, actualLoose = 0;
      for (var b = 0; b < items.length; b++) {
        var item = items[b];
        var legal = false, penalty = 0, flagged = false, extraW = 0;
        if (item.t === 'pen') {
          if (item.f && !item.explicit && !pass.hyph) continue;   // explicit hyphens break in every pass
          if (item.p >= INF_PENALTY) continue;
          legal = true; penalty = item.p; flagged = !!item.f; extraW = item.w || 0;
        } else if (item.t === 'glue') {
          legal = b > 0 && items[b - 1].t === 'box';
        }
        if (!legal) continue;
        var candidates = [];
        var nextActive = [];
        var dropped = [];
        for (var k = 0; k < active.length; k++) {
          var A = active[k];
          var s0 = A.start;
          var natural = sumW[b] - sumW[s0] + extraW;
          var stretch = sumY[b] - sumY[s0] + (pass.emerg || 0);
          var shrink = sumZ[b] - sumZ[s0];
          var target = lineWidth(A.line);
          var diff = target - natural;
          var bad, fit;
          var infiniteStretch = item.t === 'pen' && penalty === EJECT && items[b - 1] && items[b - 1].fil;
          if (infiniteStretch && diff >= 0) { bad = 0; fit = 2; }
          else if (diff > 0) {
            bad = stretch > 0 ? Math.min(INF_BAD, Math.round(100 * Math.pow(diff / stretch, 3))) : INF_BAD;
            fit = bad > 99 ? 0 : bad > 12 ? 1 : 2;
          } else if (diff < 0) {
            if (-diff > shrink) { bad = INF_BAD + 1; fit = 3; }
            else { bad = Math.min(INF_BAD, Math.round(100 * Math.pow(-diff / shrink, 3))); fit = bad > 12 ? 3 : 2; }
          } else { bad = 0; fit = 2; }
          var keep = true;
          if (bad > INF_BAD || penalty === EJECT) keep = false;   // overfull or forced: deactivate
          if (bad <= pass.tol) {
            var d = Math.pow(P.linepenalty + bad, 2);
            if (penalty > 0) d += penalty * penalty;
            else if (penalty > EJECT) d -= penalty * penalty;
            if (flagged && A.hyph) d += P.doublehyphendemerits;
            if (penalty === EJECT && A.hyph) d += P.finalhyphendemerits;
            if (Math.abs(fit - A.fit) > 1) d += P.adjdemerits;
            candidates.push({ pos: b, start: afterBreak(b), line: A.line + 1, fit: fit, dem: A.dem + d,
              prev: A, hyph: flagged, ratio: diff >= 0 ? (stretch > 0 ? diff / stretch : 0) : (shrink > 0 ? diff / shrink : -1),
              bad: bad });
          }
          if (keep) nextActive.push(A);
          else if (!(bad <= pass.tol)) dropped.push({ A: A, diff: diff, shrink: shrink, bad: bad });
        }
        /* TeX's final pass: when the last active node would die with no
         * feasible break, break here anyway (an overfull line — TeX's
         * "artificial demerits") rather than fail the paragraph. */
        if (pass.final && !candidates.length && !nextActive.length && dropped.length) {
          dropped.sort(function (u, v) { return u.A.dem - v.A.dem; });
          var D0 = dropped[0];
          candidates.push({ pos: b, start: afterBreak(b), line: D0.A.line + 1, fit: 3, dem: D0.A.dem,
            prev: D0.A, hyph: flagged, ratio: D0.shrink > 0 ? D0.diff / D0.shrink : -1, bad: D0.bad, overfull: true });
        }
        // one best candidate per (line, fitness) class, as TeX does; line
        // numbers count apart when they matter (\looseness, a \parshape)
        var byLine = !!P.looseness || typeof widths !== 'number';
        var bestBy = {}, minBy = {};
        candidates.forEach(function (c) {
          var lk = byLine ? c.line : 0;
          var key = lk + ':' + c.fit;
          if (!bestBy[key] || c.dem < bestBy[key].dem) bestBy[key] = c;
          if (minBy[lk] == null || c.dem < minBy[lk]) minBy[lk] = c.dem;
        });
        Object.keys(bestBy).forEach(function (key) {
          var c = bestBy[key];
          // TeX keeps the classes within \adjdemerits of the best for that line
          if (c.dem <= minBy[byLine ? c.line : 0] + P.adjdemerits) nextActive.push(c);
        });
        active = nextActive;
        /* the paragraph's own end; a forced break inside it (a <br>) is a
         * line end the next line starts after (V3.917 — this ended the
         * whole paragraph there and dropped the rest of its text) */
        if (item.t === 'pen' && item.p === EJECT && b === items.length - 1) {
          var finals = active.filter(function (n) { return n.pos === b; });
          if (finals.length) { bestFinal = chooseFinal(finals, P.looseness); actualLoose = bestFinal._loose || 0; }
          break;
        }
        if (!active.length) return null;
      }
      if (!bestFinal) return null;
      var chain = [];
      for (var n = bestFinal; n && n.prev; n = n.prev) chain.unshift(n);
      return {
        breaks: chain.map(function (n) { return n.pos; }),
        starts: [0].concat(chain.slice(0, -1).map(function (n) { return n.start; })),
        ratios: chain.map(function (n) { return n.ratio; }),
        hyphenated: chain.map(function (n) { return n.hyph; }),
        badness: chain.map(function (n) { return n.bad; }),
        lines: chain.length,
        overfull: chain.some(function (n) { return n.overfull; }),
        demerits: bestFinal.dem,
        pass: pass.hyph ? (pass.emerg ? 3 : 2) : 1,
        actualLooseness: actualLoose,
      };
    }
    /* TeX's choice (tex.web §875): among the paragraph's possible ends, the
     * line count nearest the fewest-demerits one + \looseness without
     * overshooting it, fewest demerits on a tie */
    function chooseFinal(finals, looseness) {
      finals.sort(function (x, y) { return x.dem - y.dem; });
      if (!looseness) return finals[0];
      var bestLine = finals[0].line, pick = finals[0], actual = 0, fewest = finals[0].dem;
      finals.forEach(function (f) {
        var d = f.line - bestLine;
        if ((d < actual && looseness <= d) || (d > actual && looseness >= d)) { pick = f; actual = d; fewest = f.dem; }
        else if (d === actual && f.dem < fewest) { pick = f; fewest = f.dem; }
      });
      pick._loose = actual;
      return pick;
    }
  }

  /* ── Breakable inline math (TeX's \relpenalty / \binoppenalty) ──
   * TeX may break an inline formula after a top-level relation (=, <, ≈ …;
   * penalty 500) or binary operator (+, −, × …; penalty 700). A KaTeX
   * render is one unbreakable box, so the Document view splits the SOURCE
   * at those points into separately rendered pieces joined by a marker the
   * typesetter reads as "penalty, then TeX's math glue": after a relation
   * \thickmuskip (5mu plus 5mu), after an operator \medmuskip (4mu plus 2mu
   * minus 4mu). A piece ending in an operator keeps its left space
   * (TeX sets a line-end operator with the space before it). */
  var REL_MARK = '\uE120', BIN_MARK = '\uE121';
  var RELS = ['=', '<', '>', '\\leq', '\\geq', '\\le', '\\ge', '\\neq', '\\ne', '\\approx', '\\sim', '\\simeq',
    '\\equiv', '\\propto', '\\lesssim', '\\gtrsim', '\\ll', '\\gg', '\\to', '\\rightarrow', '\\Rightarrow',
    '\\leftarrow', '\\mapsto', '\\cong', '\\approxeq', '\\in', '\\subset', '\\subseteq'];
  var BINS = ['+', '-', '\\pm', '\\mp', '\\times', '\\cdot', '\\div', '\\cup', '\\cap', '\\oplus', '\\otimes'];
  function splitMathSource(src) {
    var out = [], depth = 0, lr = 0, start = 0, i = 0, n = src.length;
    var lastAtom = 'start';   // what the previous top-level token was
    function tokenAt(j) {
      if (src[j] === '\\') {
        var m = /^\\([A-Za-z]+|.)/.exec(src.slice(j));
        return m ? m[0] : '\\';
      }
      return src[j];
    }
    while (i < n) {
      var t = tokenAt(i);
      if (t === '{') { depth++; i++; lastAtom = 'ord'; continue; }
      if (t === '}') { depth--; i++; lastAtom = 'ord'; continue; }
      if (t === '\\left') { lr++; i += t.length; continue; }
      if (t === '\\right') { lr--; i += t.length; continue; }
      if (depth === 0 && lr === 0 && (t === '^' || t === '_')) { i++; lastAtom = 'script'; continue; }
      var isRel = RELS.indexOf(t) >= 0, isBin = BINS.indexOf(t) >= 0;
      if (depth === 0 && lr === 0 && (isRel || isBin)) {
        var j = i + t.length;
        while (j < n && src[j] === ' ') j++;
        var more = j < n && !/^[=<>]/.test(src.slice(j));
        var realBin = isBin && lastAtom === 'ord';
        if (more && (isRel ? lastAtom !== 'start' : realBin) && lastAtom !== 'rel') {
          var left = src.slice(start, i).replace(/\s+$/, '');
          out.push({ tex: isBin ? left + '\\:{' + t + '}' : left + ' ' + t, after: isRel ? 'rel' : 'bin' });
          start = j; i = j; lastAtom = isRel ? 'rel' : 'bin';
          continue;
        }
        lastAtom = isRel ? 'rel' : 'bin';
        i += t.length;
        continue;
      }
      if (t !== ' ') lastAtom = (t === '(' || t === '[') ? 'open' : 'ord';
      i += t.length;
    }
    out.push({ tex: src.slice(start), after: null });
    return out.filter(function (c) { return c.tex.trim(); });
  }
  /* Paragraph SOURCE → same text with every breakable $…$ split into
   * pieces joined by REL_MARK / BIN_MARK (render with the editor's normal
   * paragraph renderer afterwards). Escaped \$ is left alone. */
  function breakableMathText(text) {
    if (!text || text.indexOf('$') < 0) return text;
    var out = '', i = 0, n = text.length;
    while (i < n) {
      var ch = text[i];
      if (ch === '$' && (i === 0 || text[i - 1] !== '\\')) {
        var j = i + 1;
        while (j < n && !(text[j] === '$' && text[j - 1] !== '\\')) j++;
        if (j < n && j > i + 1) {
          var parts = splitMathSource(text.slice(i + 1, j));
          out += parts.map(function (p) {
            return '$' + p.tex + '$' + (p.after === 'rel' ? REL_MARK : p.after === 'bin' ? BIN_MARK : '');
          }).join('');
          i = j + 1;
          continue;
        }
      }
      out += ch;
      i++;
    }
    return out;
  }

  /* ── DOM paragraph layout (browser) ────────────────────────── */

  var ATOMIC_SEL = '.katex, .pe-cite-group, .pe-ref, .pe-refchip, .pe-secref-chip, .pe-eq-inline, ' +
    '.pe-fn-chip, .pe-footnote, .pe-value-chip, .pe-item-chip, sup, sub, code, img, br, .pts-atom';
  var WORD_RE = /[A-Za-zÀ-ɏ]+/;

  function _measureCanvas() {
    if (!_measureCanvas.ctx) _measureCanvas.ctx = document.createElement('canvas').getContext('2d');
    return _measureCanvas.ctx;
  }

  /* Walk el in document order → segments:
   *   {k:'text', node, a, b}   a run of non-space chars in one text node
   *   {k:'space', node, a, b}  a run of spaces
   *   {k:'atom', el}           an inline element that never breaks inside */
  function _segments(el, atomicSel) {
    var segs = [];
    (function walk(n) {
      for (var c = n.firstChild; c; c = c.nextSibling) {
        if (c.nodeType === 3) {
          var s = c.nodeValue;
          /* V3.917 — Unicode's line / paragraph separators, vertical tab and
           * NEL (pasted text carries them) are word spaces, as in the PDF;
           * outside this class they glued the words either side together */
          var re = /([ \t\r\n\u000B\u0085\u2028\u2029]+)|(\u00A0)|([\uE120\uE121])|([^ \t\r\n\u000B\u0085\u2028\u2029\u00A0\uE120\uE121]+)/g, m;
          while ((m = re.exec(s))) {
            segs.push({ k: m[1] ? 'space' : m[2] ? 'nbsp' : m[3] ? (m[3] === REL_MARK ? 'mrel' : 'mbin') : 'text',
              node: c, a: m.index, b: m.index + m[0].length });
          }
        } else if (c.nodeType === 1) {
          if (c.matches && c.matches(atomicSel)) segs.push({ k: 'atom', el: c });
          else walk(c);
        }
      }
    })(el);
    return segs;
  }

  function _rangeWidth(range, node, a, b) {
    range.setStart(node, a);
    range.setEnd(node, b);
    var r = range.getBoundingClientRect();
    return r.width;
  }

  /* Lay out one paragraph element IN PLACE. opts:
   *   width (px, required), indent (px, first line; default = computed
   *   text-indent), leading (px; default = computed line-height),
   *   widths / offsets (V3.912 — px per line, the last entry repeating:
   *   TeX's \parshape, e.g. the lines beside a wrapped figure),
   *   lastLine: 'left' (default) | 'justify', hyphenate (default true),
   *   params (Knuth–Plass overrides, e.g. {looseness: -1}),
   *   atomic (extra selector of inline elements to keep whole). */
  function layoutParagraph(el, opts) {
    opts = opts || {};
    var width = opts.width;
    if (!(width > 0)) return null;
    var widths = Array.isArray(opts.widths) && opts.widths.length ? opts.widths : null;
    var offsets = Array.isArray(opts.offsets) && opts.offsets.length ? opts.offsets : null;
    function widthAt(i) { return widths ? widths[Math.min(i, widths.length - 1)] : width; }
    function offsetAt(i) { return offsets ? offsets[Math.min(i, offsets.length - 1)] : 0; }
    var cs = getComputedStyle(el);
    var indent = opts.indent != null ? opts.indent : (parseFloat(cs.textIndent) || 0);
    var leading = opts.leading || parseFloat(cs.lineHeight) || (parseFloat(cs.fontSize) * 1.2);
    var atomicSel = ATOMIC_SEL + (opts.atomic ? ', ' + opts.atomic : '');
    // the class's penalties (IEEEtran: \hyphenpenalty 750, \relpenalty 800,
    // \binoppenalty 1000) — TeX's defaults otherwise
    var PP = Object.assign({ relpenalty: 500, binoppenalty: 700 }, DEFAULTS, opts.params || {});

    // measure on one long unbroken line, natural spacing, no browser hyphens
    var saved = el.getAttribute('style') || '';
    el.style.whiteSpace = 'nowrap';
    el.style.textAlign = 'left';
    el.style.textIndent = '0';
    el.style.hyphens = 'manual';
    el.style.webkitHyphens = 'manual';
    el.style.wordSpacing = 'normal';
    el.style.width = 'max-content';
    el.style.maxWidth = 'none';

    var segs = _segments(el, atomicSel);
    var range = document.createRange();
    var ctx = _measureCanvas();
    var fontCache = Object.create(null);
    function hyphenWidth(node) {
      var p = node.parentElement || el;
      var f = getComputedStyle(p).font;
      if (fontCache[f] == null) { ctx.font = f; fontCache[f] = ctx.measureText('-').width; }
      return fontCache[f];
    }

    /* A font's own glue ratios when the look gives them (a TFM font such
     * as the Helvetica a class loads: stretch 0.6, shrink 0.24 of the
     * space — CSS custom properties --pts-stretch / --pts-shrink on the
     * element the text sits in); otherwise XeTeX's native-font glue. */
    var glueCache = typeof Map === 'function' ? new Map() : null;
    function glueFor(node) {
      var p = (node && node.parentElement) || el;
      if (glueCache && glueCache.has(p)) return glueCache.get(p);
      var cs2 = getComputedStyle(p);
      var y = parseFloat(cs2.getPropertyValue('--pts-stretch'));
      var z = parseFloat(cs2.getPropertyValue('--pts-shrink'));
      // a class that retunes the space itself (IEEEtran: 0.35em) — em
      var sp = parseFloat(cs2.getPropertyValue('--pts-space'));
      var g = { y: isFinite(y) ? y : DEFAULTS.stretchFrac, z: isFinite(z) ? z : DEFAULTS.shrinkFrac,
        w: isFinite(sp) ? sp * (parseFloat(cs2.fontSize) || 12) : null };
      if (glueCache) glueCache.set(p, g);
      return g;
    }

    var items = [];        // Knuth–Plass items
    var refs = [];         // parallel: DOM position each item maps to
    if (indent) { items.push({ t: 'box', w: indent }); refs.push(null); }
    var prevKind = null;
    var lastSpace = null;
    for (var i = 0; i < segs.length; i++) {
      var sg = segs[i];
      if (sg.k === 'mrel' || sg.k === 'mbin') {
        // penalty, then TeX's math glue (em of the math = the text size)
        var em = parseFloat(getComputedStyle(sg.node.parentElement || el).fontSize) || 12;
        var mu = em / 18;
        items.push({ t: 'pen', w: 0, p: sg.k === 'mrel' ? PP.relpenalty : PP.binoppenalty }); refs.push(null);
        items.push(sg.k === 'mrel' ? { t: 'glue', w: 5 * mu, y: 5 * mu, z: 0, math: true }
                                   : { t: 'glue', w: 4 * mu, y: 2 * mu, z: 4 * mu, math: true }); refs.push(sg);
        prevKind = 'space';
        continue;
      }
      if (sg.k === 'nbsp') {
        // TeX's ~ : the same glue as a space, but never a break
        var nw0 = _rangeWidth(range, sg.node, sg.a, sg.b);
        var ng = glueFor(sg.node);
        var nw = ng.w != null ? ng.w : nw0;
        items.push({ t: 'pen', w: 0, p: INF_PENALTY }); refs.push(null);
        items.push({ t: 'glue', w: nw, y: nw * ng.y, z: nw * ng.z, nobreak: true, dw: nw - nw0 }); refs.push(sg);
        prevKind = 'space';
        continue;
      }
      if (sg.k === 'space') {
        if (prevKind === null || prevKind === 'space') { prevKind = 'space'; continue; }
        var sw0 = _rangeWidth(range, sg.node, sg.a, Math.min(sg.b, sg.a + 1));
        var sgl = glueFor(sg.node);
        var sw = sgl.w != null ? sgl.w : sw0;
        // dw: what the rendered space glyph lacks of the space TeX uses
        items.push({ t: 'glue', w: sw, y: sw * sgl.y, z: sw * sgl.z, dw: sw - sw0 });
        refs.push(sg);
        lastSpace = sg;
        prevKind = 'space';
        continue;
      }
      if (sg.k === 'atom') {
        var r = sg.el.getBoundingClientRect();
        var acs = getComputedStyle(sg.el);
        var aw = r.width + (parseFloat(acs.marginLeft) || 0) + (parseFloat(acs.marginRight) || 0);
        if (sg.el.tagName === 'BR') {
          items.push({ t: 'glue', w: 0, y: 0, z: 0, fil: true }); refs.push(null);
          items.push({ t: 'pen', w: 0, p: EJECT, f: false }); refs.push({ k: 'brk', el: sg.el });
          prevKind = null;
          continue;
        }
        items.push({ t: 'box', w: aw }); refs.push(sg);
        prevKind = 'atom';
        continue;
      }
      // text run: split into hyphenatable word + punctuation + explicit hyphens
      var node = sg.node, txt = node.nodeValue.slice(sg.a, sg.b);
      var canHyph = opts.hyphenate !== false && prevKind !== 'text' && prevKind !== 'atom';
      var pos = 0;
      var parts = txt.split(/(-)/);   // explicit hyphens are break points (exhyphenpenalty)
      for (var pj = 0; pj < parts.length; pj++) {
        var part = parts[pj];
        if (!part) continue;
        var a0 = sg.a + pos, b0 = a0 + part.length;
        pos += part.length;
        if (part === '-') {
          items.push({ t: 'box', w: _rangeWidth(range, node, a0, b0) }); refs.push({ k: 'text', node: node, a: a0, b: b0 });
          items.push({ t: 'pen', w: 0, p: PP.exhyphenpenalty, f: true, explicit: true }); refs.push({ k: 'hy', node: node, at: b0, explicit: true });
          continue;
        }
        // TeX hyphenates only the first letter-run after glue (pj === 0)
        var m = pj === 0 && canHyph ? part.match(/^([^A-Za-zÀ-ÿ]{0,2})([A-Za-zÀ-ÿ]+)(.*)$/) : null;
        var pieces = m ? hyphenate(m[2]) : null;
        if (pieces && pieces.length > 1) {
          pieces[0] = m[1] + pieces[0];   // leading ( or quote rides with the first piece
          m[2] = m[3];
          var off = a0;
          var hw = hyphenWidth(node);
          for (var q = 0; q < pieces.length; q++) {
            var pa = off, pb = off + pieces[q].length;
            off = pb;
            items.push({ t: 'box', w: _rangeWidth(range, node, pa, pb) }); refs.push({ k: 'text', node: node, a: pa, b: pb });
            if (q < pieces.length - 1) {
              items.push({ t: 'pen', w: hw, p: PP.hyphenpenalty, f: true }); refs.push({ k: 'hy', node: node, at: pb });
            }
          }
          if (m[2]) {
            items.push({ t: 'box', w: _rangeWidth(range, node, off, b0) }); refs.push({ k: 'text', node: node, a: off, b: b0 });
          }
        } else {
          items.push({ t: 'box', w: _rangeWidth(range, node, a0, b0) }); refs.push({ k: 'text', node: node, a: a0, b: b0 });
        }
      }
      prevKind = 'text';
    }
    // drop trailing glue, add \parfillskip + forced break
    while (items.length && items[items.length - 1].t === 'glue') { items.pop(); refs.pop(); }
    items.push({ t: 'pen', w: 0, p: INF_PENALTY }); refs.push(null);
    items.push({ t: 'glue', w: 0, y: 0, z: 0, fil: true }); refs.push(null);
    items.push({ t: 'pen', w: 0, p: EJECT }); refs.push(null);

    var res = breakLines(items, widths || width, opts.params);
    /* V3.910 — would \looseness=-1 set this paragraph one line shorter?
     * (the layout check's "save a line" list) */
    var canTighten = false;
    if (opts.probeTighten && res && res.lines > 1) {
      var t1 = breakLines(items, widths || width, Object.assign({}, opts.params || {}, { looseness: -1 }));
      canTighten = !!(t1 && t1.lines < res.lines);
    }
    el.setAttribute('style', saved);
    if (!res) return null;

    /* Rebuild: one .pts-ln per line, cut from the original DOM with
     * Range.cloneContents (keeps nested <em>/<strong> intact; atoms are
     * never split because breaks only fall on spaces / hyphen points). */
    function startOf(idx) {     // DOM boundary where the item at idx begins
      var rf = refs[idx];
      if (!rf) return null;
      if (rf.k === 'text') return { node: rf.node, off: rf.a };
      if (rf.k === 'atom') return { before: rf.el };
      return null;
    }
    function endOf(idx) {
      var rf = refs[idx];
      if (!rf) return null;
      if (rf.k === 'text') return { node: rf.node, off: rf.b };
      if (rf.k === 'atom') return { after: rf.el };
      return null;
    }
    function setStart(rg, p) {
      if (p.node) rg.setStart(p.node, p.off);
      else if (p.before) rg.setStartBefore(p.before);
      else rg.setStartAfter(p.after);
    }
    function setEnd(rg, p) {
      if (p.node) rg.setEnd(p.node, p.off);
      else if (p.before) rg.setEndBefore(p.before);
      else rg.setEndAfter(p.after);
    }
    var lines = [];
    var startIdx = 0;
    for (var L = 0; L < res.lines; L++) {
      var brk = res.breaks[L];
      var s = startIdx;
      while (s < brk && !(refs[s] && (refs[s].k === 'text' || refs[s].k === 'atom'))) s++;
      var e = brk - 1;
      while (e > s && !(refs[e] && (refs[e].k === 'text' || refs[e].k === 'atom'))) e--;
      var line = { s: s, e: e, brk: brk, ratio: res.ratios[L], hy: res.hyphenated[L] && !(items[brk] && items[brk].explicit),
        last: L === res.lines - 1 };
      // natural width + spaces on the line
      var nat = 0, spaces = 0, mstretch = 0, mshrink = 0, sstretch = 0, sshrink = 0, sdw = 0;
      for (var x = s; x <= e; x++) {
        var itx = items[x];
        if (itx.t === 'box') nat += itx.w;
        else if (itx.t === 'glue' && !itx.fil) {
          nat += itx.w;
          if (itx.math) { mstretch += itx.y; mshrink += itx.z; }
          else { spaces++; sstretch += itx.y; sshrink += itx.z; sdw += itx.dw || 0; }
        }
      }
      line.mstretch = mstretch; line.mshrink = mshrink; line.sstretch = sstretch; line.sshrink = sshrink; line.sdw = sdw;
      if (line.hy) nat += items[brk].w;
      if (L === 0 && indent) nat += 0;   // indent box already counted (s may be 0)
      line.nat = nat; line.spaces = spaces;
      lines.push(line);
      startIdx = res.starts[L + 1] != null ? res.starts[L + 1] : brk + 1;
    }

    var frag = document.createDocumentFragment();
    var out = [];
    lines.forEach(function (ln, idx) {
      var div = document.createElement('span');
      div.className = 'pts-ln' + (ln.last ? ' pts-ln-last' : '');
      var a = startOf(ln.s);
      var b = endOf(ln.e);
      if (a && b) {
        var rg = document.createRange();
        setStart(rg, a);
        setEnd(rg, b);
        /* V3.915 — cloneContents keeps only the elements the range cuts
         * through; a line lying wholly inside a <strong>/<em>/<sub> comes
         * back as bare text (a bold run-in head lost its bold, the middle
         * lines of a long italic passage their italics). Re-wrap it in
         * shallow copies of every element between it and the paragraph. */
        var piece = rg.cloneContents();
        var anc = rg.commonAncestorContainer;
        if (anc && anc.nodeType === 3) anc = anc.parentNode;
        while (anc && anc !== el && el.contains(anc)) {
          var wrap = anc.cloneNode(false);
          wrap.appendChild(piece);
          piece = wrap;
          anc = anc.parentNode;
        }
        div.appendChild(piece);
      }
      if (ln.hy) div.appendChild(document.createTextNode('-'));
      var lineW = widthAt(idx) - (idx === 0 ? indent : 0);
      var extra = 0;
      /* distribute the line's slack over its glue in proportion to each
       * glue's stretch (or shrink), as TeX does: word spaces through CSS
       * word-spacing, math glue through its own span width */
      var D = lineW - ln.nat;
      var lastNatural = ln.last && D >= 0;
      var gS = D >= 0 ? ln.sstretch : ln.sshrink, gM = D >= 0 ? ln.mstretch : ln.mshrink;
      var r = (!lastNatural && (gS + gM) > 0) ? D / (gS + gM) : 0;
      if (ln.spaces > 0 && r) extra = r * gS / ln.spaces;
      if (ln.spaces > 0 && ln.sdw) extra += ln.sdw / ln.spaces;   // a retuned space (IEEEtran)
      (function sizeMathGlue(node) {
        var walker = document.createTreeWalker(node, NodeFilter.SHOW_TEXT, null);
        var hits = [], t;
        while ((t = walker.nextNode())) if (/[\uE120\uE121]/.test(t.nodeValue)) hits.push(t);
        hits.forEach(function (tn) {
          var parts = tn.nodeValue.split(/([\uE120\uE121])/);
          var f = document.createDocumentFragment();
          var em = parseFloat(getComputedStyle(tn.parentElement || el).fontSize) || 12, mu = em / 18;
          parts.forEach(function (pt) {
            if (pt === REL_MARK || pt === BIN_MARK) {
              var gw = pt === REL_MARK ? 5 * mu : 4 * mu;
              var gy = pt === REL_MARK ? 5 * mu : 2 * mu, gz = pt === REL_MARK ? 0 : 4 * mu;
              var w = gw + (r > 0 ? r * gy : r * gz);
              var sp = document.createElement('span');
              sp.className = 'pts-mg';
              sp.style.cssText = 'display:inline-block;width:' + Math.max(0, w).toFixed(2) + 'px';
              f.appendChild(sp);
            } else if (pt) f.appendChild(document.createTextNode(pt));
          });
          tn.parentNode.replaceChild(f, tn);
        });
      })(div);
      if (idx === 0 && indent) div.style.paddingLeft = indent + 'px';
      if (offsetAt(idx)) div.style.marginLeft = offsetAt(idx).toFixed(2) + 'px';   // a left-side wrap
      if (extra) div.style.wordSpacing = extra.toFixed(3) + 'px';
      div.style.height = leading + 'px';
      out.push({ ratio: ln.ratio, hy: ln.hy, extra: extra });
      frag.appendChild(div);
    });
    while (el.firstChild) el.removeChild(el.firstChild);
    el.appendChild(frag);
    el.classList.add('pts-para');
    el.dataset.ptsLines = String(lines.length);
    _fixBaselines(el, leading);
    if (opts.debug) {
      res.debugItems = items.map(function (it, i) {
        var rf = refs[i];
        var txt = rf ? (rf.k === 'text' ? rf.node.nodeValue.slice(rf.a, rf.b) : rf.k === 'atom' ? '[' + rf.el.textContent + ']' : rf.k) : '';
        return it.t + ':' + (it.w || 0).toFixed(2) + (it.p != null ? ' p' + it.p : '') + ' ' + txt;
      });
      res.width = width;
      res.rawItems = items;
      return res;
    }
    return { lines: lines.length, height: lines.length * leading, overfull: res.overfull,
      ratios: res.ratios, hyphenated: out.filter(function (o) { return o.hy; }).length, pass: res.pass,
      canTighten: canTighten };
  }

  /* Every line is exactly one leading tall (TeX's \baselineskip), but a
   * line holding tall inline content (a superscript, KaTeX) gets a taller
   * CSS line box, which pushes its baseline down. Measure each line's
   * baseline with a zero-size marker (one batched reflow) and lift the
   * displaced lines' content back to the paragraph's common baseline —
   * relative positioning, so nothing else moves. */
  var TALL_SEL = '.katex, sup, sub, .pe-cite-group, .pe-fn-chip, img';
  function _fixBaselines(el, leading) {
    var lns = Array.prototype.slice.call(el.children);
    var marks = lns.map(function (ln) {
      var m = document.createElement('span');
      m.style.cssText = 'display:inline-block;width:0;height:0;vertical-align:baseline';
      ln.insertBefore(m, ln.firstChild);
      return m;
    });
    var offs = lns.map(function (ln, i) {
      return marks[i].getBoundingClientRect().top - ln.getBoundingClientRect().top;
    });
    var plain = [];
    lns.forEach(function (ln, i) { if (!ln.querySelector(TALL_SEL)) plain.push(offs[i]); });
    var ref = plain.length ? plain.sort(function (a, b) { return a - b; })[Math.floor(plain.length / 2)] : null;
    marks.forEach(function (m) { m.remove(); });
    if (ref == null) {
      // every line has tall content: the typical text baseline of the leading
      ref = Math.min.apply(null, offs);
    }
    lns.forEach(function (ln, i) {
      var d = offs[i] - ref;
      if (d > 0.4) {
        var wrap = document.createElement('span');
        wrap.className = 'pts-shift';
        wrap.style.position = 'relative';
        wrap.style.top = (-d).toFixed(2) + 'px';
        while (ln.firstChild) wrap.appendChild(ln.firstChild);
        ln.appendChild(wrap);
      }
    });
  }

  var api = {
    DEFAULTS: DEFAULTS,
    setPatterns: setPatterns,
    hyphenate: hyphenate,
    breakLines: breakLines,
    layoutParagraph: layoutParagraph,
    splitMathSource: splitMathSource,
    breakableMathText: breakableMathText,
    ATOMIC_SEL: ATOMIC_SEL,
  };
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  else {
    root.PaperTypeset = api;
    if (root.HYPH_EN_US) setPatterns(root.HYPH_EN_US);
  }
})(typeof window !== 'undefined' ? window : this);
