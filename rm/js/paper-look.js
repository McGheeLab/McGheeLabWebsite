/* paper-look.js — one journal "look", two renderers (V3.907).
 *
 * A look is the PUBLISHED page of a journal written down as numbers: page
 * size, margins, columns, fonts, sizes, leading, heading / caption /
 * abstract / bibliography styles, float spacing. The same look generates
 *
 *   - the LaTeX preamble + main.tex skeleton the export compiles
 *     (PaperLook.applyToTemplate → buildBundle), and
 *   - the CSS + page geometry the Document view lays out with
 *     (PaperLook.css / PaperLook.geometry),
 *
 * with the SAME font files (vendored in rm/vendor/fonts/, from the TeX
 * distribution Tectonic compiles with), so a line that fits in the preview
 * fits in the PDF. Before V3.907 the two disagreed by construction: the
 * Document view drew a two-column page in Georgia while most templates
 * compiled a single-column double-spaced manuscript in Computer Modern.
 *
 * Template JSON: `look` (engine 'spec' = this module writes the layout;
 * engine 'class' = the journal's own LaTeX class does, and the look only
 * describes that class's page for the preview). Config:
 * paperExports.layoutLook = 'published' (default when a look exists) |
 * 'submission' (the template's manuscript preamble, unchanged).
 *
 * Units: bp (PostScript points, 1/72 in) everywhere — what a PDF measures
 * in, and exactly 4/3 CSS px.
 *
 * Node-requireable (pure); the Paper Lab and the unit tests load it.
 */
(function (root) {
  'use strict';

  var PX = 4 / 3;   // CSS px per bp

  /* ── Fonts ─────────────────────────────────────────────────────
   * Every family is an OpenType set from TeX Live (what Tectonic loads by
   * file name) AND a web-font set in rm/vendor/fonts/ (the same files).
   * `pdftex` is the fallback for someone compiling the downloaded .zip
   * with pdfLaTeX. `greek`: the text face has Greek, so μ/α stay text.
   * asc/desc: the face's hhea ascent/descent (em) — where the browser puts
   * the baseline in a line box; ht: the height of an ascender ("l"), where
   * TeX puts the first baseline of a box at the top of the page; xh: the
   * x-height (em), TeX's 1ex (wrapfig lifts a figure by 1.4ex). */
  var FONTS = {
    termes: {
      label: 'Times (TeX Gyre Termes)', css: 'PL Termes', greek: true,
      asc: 1.055, desc: 0.281, ht: 0.683, xh: 0.45,
      files: { r: 'texgyretermes-regular.otf', b: 'texgyretermes-bold.otf', i: 'texgyretermes-italic.otf', bi: 'texgyretermes-bolditalic.otf' },
      pdftex: '\\usepackage{tgtermes}',
    },
    heros: {
      label: 'Helvetica (TeX Gyre Heros)', css: 'PL Heros', greek: true,
      asc: 1.148, desc: 0.284, ht: 0.729, xh: 0.524,
      files: { r: 'texgyreheros-regular.otf', b: 'texgyreheros-bold.otf', i: 'texgyreheros-italic.otf', bi: 'texgyreheros-bolditalic.otf' },
      pdftex: '\\usepackage{tgheros}',
    },
    libertinus: {
      label: 'Libertinus Serif', css: 'PL Libertinus', greek: true,
      asc: 0.894, desc: 0.246, ht: 0.698,
      files: { r: 'LibertinusSerif-Regular.otf', b: 'LibertinusSerif-Bold.otf', i: 'LibertinusSerif-Italic.otf', bi: 'LibertinusSerif-BoldItalic.otf' },
      pdftex: '\\usepackage{libertinus}',
    },
    'libertinus-sans': {
      label: 'Libertinus Sans', css: 'PL Libertinus Sans', greek: true,
      asc: 0.894, desc: 0.246, ht: 0.698,
      files: { r: 'LibertinusSans-Regular.otf', b: 'LibertinusSans-Bold.otf', i: 'LibertinusSans-Italic.otf', bi: 'LibertinusSans-Bold.otf' },
      pdftex: '\\usepackage{libertinus}',
    },
    lm: {
      label: 'Latin Modern (Computer Modern)', css: 'PL Latin Modern', greek: false,
      asc: 1.127, desc: 0.290, ht: 0.694, xh: 0.431,
      files: { r: 'lmroman10-regular.otf', b: 'lmroman10-bold.otf', i: 'lmroman10-italic.otf', bi: 'lmroman10-bolditalic.otf' },
      pdftex: '\\usepackage{lmodern}',
    },
    /* V3.909 — Latin Modern's optical sizes. A class that loads lmodern
     * with T1 (PNAS) sets 9pt text in LMRoman9, which is wider than
     * LMRoman10 scaled down; the Document view must use the same cut. */
    lm9: {
      label: 'Latin Modern 9pt', css: 'PL Latin Modern 9', greek: false,
      asc: 1.128, desc: 0.292, ht: 0.694,
      files: { r: 'lmroman9-regular.otf', b: 'lmroman9-bold.otf', i: 'lmroman9-italic.otf', bi: 'lmroman10-bolditalic.otf' },
      pdftex: '\\usepackage{lmodern}',
    },
    lm8: {
      label: 'Latin Modern 8pt', css: 'PL Latin Modern 8', greek: false,
      asc: 1.125, desc: 0.292, ht: 0.694,
      files: { r: 'lmroman8-regular.otf', b: 'lmroman8-bold.otf', i: 'lmroman8-italic.otf', bi: 'lmroman10-bolditalic.otf' },
      pdftex: '\\usepackage{lmodern}',
    },
    lm7: {
      label: 'Latin Modern 7pt', css: 'PL Latin Modern 7', greek: false,
      asc: 1.124, desc: 0.292, ht: 0.694,
      files: { r: 'lmroman7-regular.otf', b: 'lmroman8-bold.otf', i: 'lmroman8-italic.otf', bi: 'lmroman10-bolditalic.otf' },
      pdftex: '\\usepackage{lmodern}',
    },
    'lm-sans': {
      label: 'Latin Modern Sans', css: 'PL Latin Modern Sans', greek: false,
      asc: 1.154, desc: 0.309, ht: 0.694,
      files: { r: 'lmsans10-regular.otf', b: 'lmsans10-bold.otf', i: 'lmsans10-oblique.otf', bi: 'lmsans10-boldoblique.otf' },
      pdftex: '\\usepackage{lmodern}',
    },
    garamond: {
      label: 'EB Garamond', css: 'PL EB Garamond', greek: true,
      asc: 1.007, desc: 0.298, ht: 0.705,
      files: { r: 'EBGaramond-Regular.otf', b: 'EBGaramond-Bold.otf', i: 'EBGaramond-Italic.otf', bi: 'EBGaramond-BoldItalic.otf' },
      pdftex: '\\usepackage{ebgaramond}',
    },
    'source-sans': {
      label: 'Source Sans', css: 'PL Source Sans', greek: false,
      asc: 1.024, desc: 0.400, ht: 0.712,
      files: { r: 'SourceSansPro-Regular.otf', b: 'SourceSansPro-Bold.otf', i: 'SourceSansPro-RegularIt.otf', bi: 'SourceSansPro-BoldIt.otf' },
      pdftex: '\\usepackage[default]{sourcesanspro}',
    },
    /* V3.911 — Palatino's outlines and widths, one of the faces NSF's
     * PAPPG lists (at 10 pt or larger). Its OS/2 USE_TYPO_METRICS bit is
     * set, so browsers place lines by the typo metrics. */
    pagella: {
      label: 'Palatino (TeX Gyre Pagella)', css: 'PL Pagella', greek: true,
      asc: 0.726, desc: 0.281, ht: 0.726, xh: 0.469,
      files: { r: 'texgyrepagella-regular.otf', b: 'texgyrepagella-bold.otf', i: 'texgyrepagella-italic.otf', bi: 'texgyrepagella-bolditalic.otf' },
      pdftex: '\\usepackage{tgpagella}',
    },
  };
  var FONT_DIR = '/rm/vendor/fonts/';

  /* ── Defaults (an ordinary one-column LaTeX article) ─────────── */
  var DEFAULT = {
    engine: 'spec',
    page: { w: 612, h: 792 },
    margins: { top: 72, bottom: 72, left: 72, right: 72 },
    columns: 1, colsep: 18,
    fonts: { text: 'lm', sans: 'lm-sans' },
    body: { size: 10, lead: 12, indent: 15, parskip: 0, flushbottom: false },
    title: { family: 'text', size: 17, lead: 21, weight: 'normal', align: 'center', case: 'none', after: 10 },
    authors: { family: 'text', size: 11, lead: 14, align: 'center', after: 4 },
    affiliations: { family: 'text', size: 9, lead: 11, align: 'center', where: 'front', after: 10 },
    abstract: { mode: 'span', family: 'text', size: 9, lead: 11, weight: 'normal', label: 'Abstract',
      label_style: 'heading', indent: 30, before: 0, after: 14 },
    keywords: { show: true, label: 'Keywords:', size: 9, lead: 11 },
    front_page_alone: false,
    h1: { family: 'text', size: 12, lead: 14, weight: 'bold', before: 14, after: 6, case: 'none', align: 'left', runin: false },
    h2: { family: 'text', size: 10.5, lead: 13, weight: 'bold', before: 10, after: 4, case: 'none', align: 'left', runin: false },
    h3: { family: 'text', size: 10, lead: 12, weight: 'bold', style: 'italic', before: 8, after: 0, case: 'none', align: 'left', runin: true },
    numbering: 'arabic',
    caption: { family: 'text', size: 9, lead: 11, label_fig: 'Figure', label_tab: 'Table', label_weight: 'bold',
      sep: '. ', align: 'justify', skip: 6, table_position: 'above' },
    bib: { size: 9, lead: 11, head: 'References', label: 'bracket', sep: 2 },
    cite: { style: 'bracket' },
    display: { above: 8, below: 8 },
    floats: { textfloatsep: 14, floatsep: 12, intextsep: 12, topfraction: 0.85, bottomfraction: 0.6,
      textfraction: 0.1, floatpagefraction: 0.75, dbltopfraction: 0.85, dblfloatpagefraction: 0.75,
      topnumber: 3, bottomnumber: 2, totalnumber: 4, dbltopnumber: 2 },
    footer: { page_numbers: true },
    hide_heading_kinds: [],
    /* Line breaking, set EXPLICITLY in the .tex and used by the preview's
     * Knuth–Plass. (article.cls silently runs \sloppy in two-column mode —
     * tolerance 9999, 3em emergency stretch — which both loosens lines and
     * makes the PDF unpredictable.) emergency is in em of the body font. */
    linebreak: { pretolerance: 100, tolerance: 800, emergency: 1.5 },
  };

  function isObj(v) { return v && typeof v === 'object' && !Array.isArray(v); }
  function merge(a, b) {
    var out = {};
    Object.keys(a || {}).forEach(function (k) { out[k] = isObj(a[k]) ? merge(a[k], {}) : a[k]; });
    Object.keys(b || {}).forEach(function (k) {
      out[k] = (isObj(b[k]) && isObj(out[k])) ? merge(out[k], b[k]) : b[k];
    });
    return out;
  }

  /* The look in force for this build, or null (legacy template path).
   * cfg.lookOverrides (V3.911, paperExports.lookOverrides) are this
   * paper's own settings on top of the template's look. */
  function resolve(template, cfg) {
    if (!template || !template.look) return null;
    var mode = (cfg && (cfg.layoutLook || cfg.look)) || 'published';
    if (mode === 'submission') return null;
    var look = merge(DEFAULT, template.look);
    look.id = template.id;
    if (cfg && cfg.lookOverrides) applyOverrides(look, cfg.lookOverrides);
    return look;
  }

  /* V3.911 — the settings a writer may change per paper (the knobs a
   * grant is fitted to its page limit with): a face from FONTS, or a
   * number clamped to a sane range, since each one is written into the
   * .tex. Keys are dotted paths into the look. */
  var OVERRIDES = {
    'fonts.text': 'font', 'fonts.sans': 'font',
    'body.size': [6, 16], 'body.lead': [7, 24], 'body.parskip': [0, 14], 'body.indent': [0, 40],
    'body.looseness': [-1, 0],
    'caption.size': [5, 14], 'caption.lead': [6, 18], 'caption.skip': [0, 14],
    'h1.before': [0, 30], 'h1.after': [0, 16], 'h2.before': [0, 30], 'h2.after': [0, 16],
    'h3.before': [0, 30], 'h3.after': [0, 16],
    'floats.intextsep': [0, 30], 'floats.floatsep': [0, 30], 'floats.textfloatsep': [0, 36],
    'colsep': [2, 40],
  };
  function applyOverrides(look, ov) {
    var baseSize = look.body.size, baseLead = look.body.lead;
    Object.keys(ov || {}).forEach(function (key) {
      var rule = OVERRIDES[key];
      var v = ov[key];
      if (!rule || v == null) return;
      if (rule === 'font') { if (!FONTS[v]) return; }
      else {
        v = Number(v);
        if (!isFinite(v)) return;
        v = Math.min(rule[1], Math.max(rule[0], v));
      }
      var path = key.split('.');
      var o = look;
      for (var i = 0; i < path.length - 1; i++) {
        if (!isObj(o[path[i]])) o[path[i]] = {};
        o = o[path[i]];
      }
      o[path[path.length - 1]] = v;
    });
    // one face for the whole document unless the sans face is chosen too
    if (ov && FONTS[ov['fonts.text']] && !FONTS[ov['fonts.sans']] && look.fonts.sans_follows_text !== false) {
      look.fonts.sans = ov['fonts.text'];
    }
    // styles set at the body size and pitch (a grant's headings) follow it
    if (look.body.size !== baseSize || look.body.lead !== baseLead) {
      ['title', 'authors', 'h1', 'h2', 'h3', 'bib'].forEach(function (k) {
        var s = look[k];
        if (!s) return;
        if (s.size === baseSize) s.size = look.body.size;
        if (s.lead === baseLead) s.lead = look.body.lead;
      });
    }
    look.overridden = Object.keys(ov || {}).filter(function (k) { return OVERRIDES[k]; });
    return look;
  }

  function n(v) { return Math.round(v * 1000) / 1000; }
  function bp(v) { return n(v) + 'bp'; }
  function font(look, fam) { return FONTS[look.fonts[fam] || fam] || FONTS.lm; }

  /* ── LaTeX ─────────────────────────────────────────────────── */

  function fontspecLine(cmd, f) {
    var x = f.files;
    var base = x.r.replace(/\.otf$/, '');
    return '\\' + cmd + '{' + base + '}[Extension=.otf,UprightFont=*,BoldFont=' + x.b.replace(/\.otf$/, '') +
      ',ItalicFont=' + x.i.replace(/\.otf$/, '') + ',BoldItalicFont=' + x.bi.replace(/\.otf$/, '') + ']';
  }
  function famCmd(look, fam) {
    if (fam === 'sans') return '\\sffamily';
    return '\\rmfamily';
  }
  function styleCmds(look, s) {
    var out = famCmd(look, s.family || 'text');
    if (s.weight === 'bold') out += '\\bfseries';
    else if (s.weight === 'light') out += '\\mdseries';
    if (s.style === 'italic') out += '\\itshape';
    if (s.size) out += '\\fontsize{' + bp(s.size) + '}{' + bp(s.lead || s.size * 1.2) + '}\\selectfont';
    return out + ' ';   // a control word must not run into the text after it
  }
  function caseWrap(c) {
    return c === 'upper' ? '\\MakeUppercase' : '';
  }

  /* The full preamble for a spec look (template-specific citation setup is
   * appended by applyToTemplate). */
  function texPreamble(look) {
    var L = [];
    var twocol = look.columns === 2;
    L.push('% Generated by the McGhee Lab paper builder — journal look "' + (look.name || look.id) + '".');
    L.push('% Compile with XeLaTeX or Tectonic (the fonts are OpenType); pdfLaTeX falls back to the');
    L.push('% Type 1 versions of the same faces.');
    L.push('\\RequirePackage{fix-cm}');
    L.push('\\documentclass[' + (twocol ? 'twocolumn,' : '') + '10pt]{article}');
    L.push('\\usepackage{iftex}');
    L.push('\\ifXeTeX');
    L.push('  \\usepackage{fontspec}');
    L.push('  ' + fontspecLine('setmainfont', font(look, 'text')));
    L.push('  ' + fontspecLine('setsansfont', font(look, 'sans')));
    L.push('\\else');
    L.push('  \\usepackage[T1]{fontenc}');
    L.push('  ' + font(look, 'text').pdftex);
    if (look.fonts.sans !== look.fonts.text) L.push('  ' + font(look, 'sans').pdftex);
    L.push('\\fi');
    L.push('\\usepackage{amsmath,amssymb}');
    L.push('\\usepackage{graphicx}');
    L.push('\\usepackage{booktabs}');
    L.push('\\usepackage{xcolor}');
    L.push('\\usepackage[hidelinks]{hyperref}');
    var m = look.margins;
    L.push('\\usepackage[paperwidth=' + bp(look.page.w) + ',paperheight=' + bp(look.page.h) +
      ',left=' + bp(m.left) + ',right=' + bp(m.right) + ',top=' + bp(m.top) + ',bottom=' + bp(m.bottom) +
      ',columnsep=' + bp(look.colsep) + ',headheight=12bp,headsep=' + bp(Math.max(6, Math.min(16, m.top - 30))) +
      ',footskip=' + bp(Math.max(14, Math.min(28, m.bottom - 8))) + ']{geometry}');
    // sizes: \normalsize is the body; the rest scale from it
    var b = look.body;
    var s = b.size, l = b.lead;
    function sz(name, f) {
      return '\\renewcommand\\' + name + '{\\@setfontsize\\' + name + '{' + bp(s * f) + '}{' + bp(l * f) + '}}';
    }
    L.push('\\makeatletter');
    L.push('\\renewcommand\\normalsize{\\@setfontsize\\normalsize{' + bp(s) + '}{' + bp(l) + '}%');
    L.push('  \\abovedisplayskip ' + bp(look.display.above) + ' \\@plus2bp \\@minus3bp');
    L.push('  \\abovedisplayshortskip \\z@ \\@plus2bp');
    L.push('  \\belowdisplayshortskip ' + bp(look.display.below * 0.6) + ' \\@plus2bp \\@minus2bp');
    L.push('  \\belowdisplayskip ' + bp(look.display.below) + ' \\@plus2bp \\@minus3bp}');
    L.push(sz('small', 0.9));
    L.push(sz('footnotesize', 0.8));
    L.push(sz('scriptsize', 0.7));
    L.push(sz('tiny', 0.55));
    L.push(sz('large', 1.2));
    L.push(sz('Large', 1.44));
    L.push(sz('LARGE', 1.73));
    L.push(sz('huge', 2.07));
    L.push('\\makeatother');
    L.push('\\normalsize');
    L.push('\\setlength\\parindent{' + bp(b.indent) + '}');
    L.push('\\setlength\\parskip{' + bp(b.parskip || 0) + '}');
    L.push('\\frenchspacing');
    var lb = look.linebreak || {};
    L.push('\\pretolerance=' + (lb.pretolerance != null ? lb.pretolerance : 100) + ' \\tolerance=' +
      (lb.tolerance != null ? lb.tolerance : 800) + ' \\emergencystretch=' + n((lb.emergency || 0) * b.size) + 'bp');
    /* V3.913 — Fit's gentlest step: every paragraph TeX can set one line
     * shorter within the tolerance is (LaTeX's paragraph hook; a paragraph
     * that sets its own \\looseness keeps it) */
    if (b.looseness) L.push('\\AddToHook{para/begin}{\\ifnum\\looseness=0 \\looseness=' + Math.round(b.looseness) + '\\relax\\fi}');
    L.push(b.flushbottom || twocol ? '\\flushbottom' : '\\raggedbottom');
    L.push('\\clubpenalty=150 \\widowpenalty=150');
    // floats
    var f = look.floats;
    L.push('\\setlength\\textfloatsep{' + bp(f.textfloatsep) + ' plus 2bp minus 2bp}');
    L.push('\\setlength\\floatsep{' + bp(f.floatsep) + ' plus 2bp minus 2bp}');
    L.push('\\setlength\\intextsep{' + bp(f.intextsep) + ' plus 2bp minus 2bp}');
    if (twocol) {
      L.push('\\setlength\\dbltextfloatsep{' + bp(f.textfloatsep) + ' plus 2bp minus 2bp}');
      L.push('\\setlength\\dblfloatsep{' + bp(f.floatsep) + ' plus 2bp minus 2bp}');
    }
    L.push('\\renewcommand\\topfraction{' + f.topfraction + '}\\renewcommand\\bottomfraction{' + f.bottomfraction + '}');
    L.push('\\renewcommand\\textfraction{' + f.textfraction + '}\\renewcommand\\floatpagefraction{' + f.floatpagefraction + '}');
    L.push('\\renewcommand\\dbltopfraction{' + f.dbltopfraction + '}\\renewcommand\\dblfloatpagefraction{' + f.dblfloatpagefraction + '}');
    L.push('\\setcounter{topnumber}{' + f.topnumber + '}\\setcounter{bottomnumber}{' + f.bottomnumber + '}');
    L.push('\\setcounter{totalnumber}{' + f.totalnumber + '}\\setcounter{dbltopnumber}{' + f.dbltopnumber + '}');
    // headings
    if (look.rigid_headings) {
      /* V3.912 — a grant look (wrapped figures): LaTeX's own \@startsection
       * headings with fixed space, not titlesec. Measured with Tectonic:
       * titlesec's headings break wrapfig (after a figure placed at one, the
       * narrow lines never end), while these are plain paragraphs whose
       * lines wrapfig counts like any other. The 1sp indent makes
       * \hangindent non-zero, so wrapfig never places a figure AT a
       * heading — it waits for the next paragraph, which the Document
       * view's paginator assumes. No stretch: wrapfig reads \pagestretch. */
      L.push('\\makeatletter');
      ['h1', 'h2', 'h3'].forEach(function (h, i) {
        var cmd = ['section', 'subsection', 'subsubsection'][i];
        var st = look[h];
        var after = st.runin ? '-' + bp(st.runin_space || 4) : (st.after > 0 ? bp(st.after) : '1sp');
        L.push('\\renewcommand\\' + cmd + '{\\@startsection{' + cmd + '}{' + (i + 1) + '}{1sp}{' + bp(st.before || 0) +
          '}{' + after + '}{' + styleCmds(look, st) + (st.align === 'center' ? '\\centering' : '') + '}}');
      });
      // "1." for a section, "3.1" / "3.1.1" below it (a \csname per level, no string compare)
      L.push('\\renewcommand\\@seccntformat[1]{\\csname the#1\\endcsname\\csname rmsecpunct@#1\\endcsname\\hspace{0.5em}}');
      if (look.h1.num_dot !== false) L.push('\\def\\rmsecpunct@section{.}');
      L.push('\\makeatother');
    } else {
      L.push('\\usepackage{titlesec}');
      ['h1', 'h2', 'h3'].forEach(function (h, i) {
        var cmd = ['section', 'subsection', 'subsubsection'][i];
        var st = look[h];
        var shape = st.runin ? 'runin' : 'block';
        var align = st.align === 'center' ? '\\filcenter' : '';
        var numFmt = look.numbering === 'ieee'
          ? ['\\Roman{section}.', '\\Alph{subsection}.', '\\arabic{subsubsection})'][i]
          : ['\\thesection', '\\thesubsection', '\\thesubsubsection'][i] + (i === 0 && st.num_dot !== false ? '.' : '');
        L.push('\\titleformat{\\' + cmd + '}[' + shape + ']{' + styleCmds(look, st) + align + '}{' + numFmt + '}{0.5em}{' +
          caseWrap(st.case) + '}' + (st.runin ? '[' + (st.runin_sep || '.') + ']' : ''));
        L.push('\\titlespacing*{\\' + cmd + '}{0pt}{' + bp(st.before) + ' plus 2bp minus 1bp}{' +
          (st.runin ? bp(st.runin_space || 4) : bp(st.after) + ' plus 1bp') + '}');
      });
    }
    // captions
    var c = look.caption;
    L.push('\\usepackage{caption}');
    L.push('\\DeclareCaptionLabelSeparator{rmsep}{' + texEsc(c.sep) + '}');
    L.push('\\captionsetup{font={' + (c.family === 'sans' ? 'sf,' : '') + '},labelfont={' +
      (c.label_weight === 'bold' ? 'bf' : '') + '},labelsep=rmsep,justification=' +
      (c.align === 'center' ? 'centering' : c.align === 'left' ? 'raggedright' : 'justified') +
      ',singlelinecheck=' + (c.align === 'center' ? 'true' : 'false') + ',skip=' + bp(c.skip) + '}');
    L.push('\\DeclareCaptionFont{rmcap}{\\fontsize{' + bp(c.size) + '}{' + bp(c.lead) + '}\\selectfont}');
    L.push('\\captionsetup{font+=rmcap}');
    L.push('\\captionsetup[table]{position=' + (c.table_position === 'below' ? 'bottom' : 'top') + '}');
    L.push('\\renewcommand\\figurename{' + texEsc(c.label_fig) + '}');
    L.push('\\renewcommand\\tablename{' + texEsc(c.label_tab) + '}');
    // footer
    L.push('\\pagestyle{' + (look.footer.page_numbers ? 'plain' : 'empty') + '}');
    if (!/\\usepackage(\[[^\]]*\])?\{cuted\}/.test(L.join('\n')) && twocol) L.push('\\usepackage{cuted}');
    return L.join('\n') + '\n';
  }

  function texEsc(s) {
    return String(s == null ? '' : s).replace(/([#$%&_{}])/g, '\\$1').replace(/~/g, '\\textasciitilde{}');
  }

  /* Bibliography + citation setup for a spec look, from the look's cite
   * style and the template's bibliography_style. */
  function texCitations(look, template) {
    var cit = (template && template.citation) || {};
    var st = look.cite.style;
    var L = [];
    if (st === 'authoryear') {
      L.push('\\usepackage[round,sort]{natbib}');
    } else if (st === 'super') {
      L.push('\\usepackage[super,sort&compress,comma]{natbib}');
    } else if (st === 'paren') {
      L.push('\\usepackage[round,numbers,sort&compress]{natbib}');
    } else {
      L.push('\\usepackage[square,numbers,sort&compress]{natbib}');
    }
    var bib = look.bib;
    L.push('\\renewcommand\\bibfont{\\fontsize{' + bp(bib.size) + '}{' + bp(bib.lead) + '}\\selectfont}');
    L.push('\\setlength\\bibsep{' + bp(bib.sep) + '}');
    if (bib.label === 'dot') L.push('\\makeatletter\\renewcommand\\@biblabel[1]{#1.}\\makeatother\\renewcommand\\bibnumfmt[1]{#1.}');
    else if (bib.label === 'plain') L.push('\\renewcommand\\bibnumfmt[1]{#1}');
    else if (bib.label === 'paren') L.push('\\renewcommand\\bibnumfmt[1]{(#1)}');
    if (bib.head === '') {
      L.push('\\renewcommand\\bibsection{}');   // the journal prints no heading over the references
    } else if (bib.head != null) {
      L.push('\\renewcommand\\refname{' + texEsc(bib.head) + '}');
    }
    return L.join('\n') + '\n';
  }

  /* Front matter: title, authors, affiliations, abstract, keywords — one
   * box, set across both columns in a two-column look. Tokens are filled
   * by buildBundle (escaped text). */
  function texFront(look) {
    var t = look.title, a = look.authors, af = look.affiliations, ab = look.abstract, kw = look.keywords;
    function al(x) { return x === 'center' ? '\\centering' : x === 'right' ? '\\raggedleft' : '\\raggedright'; }
    var B = [];
    B.push('\\newcommand\\rmfront{%');
    if (t.show !== false) {
      B.push('  {' + al(t.align) + styleCmds(look, t) + caseWrap(t.case) + '{{{TITLE}}}\\par}');
      B.push('  \\vskip ' + bp(t.after));
    }
    /* V3.911 — a grant narrative names no authors (`authors.show: false`) */
    if (a.show !== false) {
      B.push('  {' + al(a.align) + styleCmds(look, a) + '{{AUTHORS}}\\par}');
      B.push('  \\vskip ' + bp(a.after));
    }
    if (af.where === 'front' && a.show !== false) {
      B.push('  {' + al(af.align) + styleCmds(look, af) + '{{AFFILIATIONS}}\\par}');
      B.push('  \\vskip ' + bp(af.after));
    }
    if (ab.mode === 'span') {
      B.push('  \\vskip ' + bp(ab.before || 0));
      var head = '';
      if (ab.label && ab.label_style === 'heading') {
        head = '{' + styleCmds(look, merge(ab, { weight: ab.label_weight || 'bold', size: ab.label_size || ab.size,
          lead: ab.label_lead || ab.lead, family: ab.label_family || ab.family })) + texEsc(ab.label) + '\\par}\\vskip 3bp';
      }
      if (ab.label && ab.label_style === 'runin') head = '';
      var absInner = '{' + styleCmds(look, ab) + (ab.label && ab.label_style === 'runin' ? '\\textbf{' + texEsc(ab.label) + '}\\enspace ' : '') +
        '{{ABSTRACT}}\\par}';
      if (ab.box) {
        /* a shaded / ruled abstract box (JACS grey panel, Elsevier rules) */
        var pad = ab.box.pad != null ? ab.box.pad : 6;
        var inner = '\\parbox{\\dimexpr\\linewidth-' + bp(2 * pad) + '}{\\noindent ' + head + absInner + '}';
        if (ab.box.bg) B.push('  {\\setlength\\fboxsep{' + bp(pad) + '}\\noindent\\colorbox[gray]{' + ab.box.bg + '}{' + inner + '}\\par}');
        else B.push('  {\\noindent\\rule{\\linewidth}{0.5bp}\\par\\vskip ' + bp(pad) + '\\noindent ' + head + absInner +
          '\\vskip ' + bp(pad) + '\\noindent\\rule{\\linewidth}{0.5bp}\\par}');
      } else {
        B.push('  {' + (ab.indent ? '\\leftskip=' + bp(ab.indent) + '\\rightskip=' + bp(ab.indent) : '') +
          (ab.width ? '\\hsize=' + bp(ab.width) : '') + '\\noindent ' + head + absInner + '}');
      }
      if (kw.show) B.push('  {{KEYWORDS_LINE}}');
      B.push('  \\vskip ' + bp(ab.after));
    }
    B.push('}');
    return B.join('\n') + '\n';
  }

  function texMain(look, template) {
    var twocol = look.columns === 2;
    var bst = ((template && template.citation) || {}).bibliography_style || 'unsrtnat';
    var M = [];
    M.push('{{PREAMBLE}}');
    M.push('');
    M.push('\\begin{document}');
    if (look.front_page_alone) {
      /* The first page is the front matter alone (Nature family): set it
       * one-column, affiliations at the foot across the full width, then
       * start the two-column body on page 2. */
      if (twocol) M.push('\\onecolumn');
      M.push('\\rmfront');
      M.push('\\vfill');
      M.push('{{AFFILIATION_NOTES}}');
      M.push(twocol ? '\\twocolumn' : '\\clearpage');
    } else {
      if (twocol) M.push('\\twocolumn[{\\rmfront}]');
      else M.push('\\rmfront');
      if (look.affiliations.where === 'footnote') M.push('{{AFFILIATION_NOTES}}');
      if (look.abstract.mode === 'column') M.push('{{ABSTRACT_COLUMN}}');
    }
    M.push('');
    M.push('{{INPUTS}}');
    M.push('');
    M.push('\\bibliographystyle{' + bst + '}');
    if (look.bib.where === 'separate') {
      /* V3.911 — the references are their own upload (NSF References
       * Cited): read the .bbl so every [n] resolves, print nothing */
      M.push('\\setbox0=\\vbox{\\bibliography{{{BIB_BASENAME}}}}');
    } else {
      M.push('\\bibliography{{{BIB_BASENAME}}}');
    }
    M.push('');
    M.push('\\end{document}');
    return M.join('\n') + '\n';
  }

  /* A section the look sets in its own type (Nature's Methods: 7.5 bp with
   * run-in bold subheads). Matched by the section's special key, then kind. */
  function sectionStyle(look, sec) {
    var ss = look && look.section_styles;
    if (!ss || !sec) return null;
    return (sec.special && ss[sec.special]) || ss[sec.kind] || null;
  }
  /* LaTeX that opens / closes that section's type: a group with the size
   * and, for its subheadings, a local \titleformat. */
  function texSectionOpen(look, st) {
    var L = ['\\begingroup'];
    if (st.size) L.push('\\fontsize{' + bp(st.size) + '}{' + bp(st.lead || st.size * 1.15) + '}\\selectfont');
    if (st.indent != null) L.push('\\setlength\\parindent{' + bp(st.indent) + '}');
    ['h2', 'h3'].forEach(function (h, i) {
      var hs = st[h];
      if (!hs) return;
      var cmd = i === 0 ? 'subsection' : 'subsubsection';
      L.push('\\titleformat{\\' + cmd + '}[' + (hs.runin ? 'runin' : 'block') + ']{' + styleCmds(look, hs) +
        '}{}{0pt}{}' + (hs.runin ? '[' + (hs.runin_sep || '.') + ']' : ''));
      L.push('\\titlespacing*{\\' + cmd + '}{0pt}{' + bp(hs.before || 4) + ' plus 1bp}{' +
        (hs.runin ? bp(hs.runin_space || 4) : bp(hs.after || 2)) + '}');
    });
    return L.join('\n') + '\n';
  }
  function texSectionClose() { return '\\par\\endgroup\n'; }

  /* The template the exporter works with, re-pointed at this look. */
  function applyToTemplate(template, look) {
    var t = merge(template, {});
    t._look = look;
    t._textGreek = !!font(look, 'text').greek;
    if (look.engine === 'class') {
      /* The journal's own class sets the page (PNAS, IEEE): keep its
       * preamble and skeleton, and add only what makes the Document view
       * able to predict it — the shared line-breaking settings, French
       * spacing, and microtype's margin protrusion OFF (it nudges every
       * line end by a fraction of a glyph, which moves line breaks). */
      var lb = look.linebreak || {};
      t.preamble = (template.preamble || '') +
        '\n% --- RM journal look: predictable line breaking (the Document view uses the same settings) ---\n' +
        '\\makeatletter\\@ifpackageloaded{microtype}{\\microtypesetup{protrusion=false}}{}\\makeatother\n' +
        '\\AtBeginDocument{\\frenchspacing\\pretolerance=' + (lb.pretolerance != null ? lb.pretolerance : 100) +
        ' \\tolerance=' + (lb.tolerance != null ? lb.tolerance : 800) +
        ' \\emergencystretch=' + n((lb.emergency || 0) * look.body.size) + 'bp}\n' + (look.preamble_extra || '');
      var skc = merge(template.section_kind_to_command || {}, {});
      (look.hide_heading_kinds || []).forEach(function (k) { skc[k] = { type: 'bare' }; });
      t.section_kind_to_command = skc;
      return t;
    }
    t.preamble = texPreamble(look) + texCitations(look, template) + texFront(look) + (look.preamble_extra || '');
    t.main_template = texMain(look, template);
    t.addon_defaults = [];
    var sk = merge(template.section_kind_to_command || {}, {});
    sk.abstract = { type: 'placeholder', token: '{{ABSTRACT}}' };
    sk.keywords = { type: 'keywords', token: '{{KEYWORDS}}', sep: ', ' };
    (look.hide_heading_kinds || []).forEach(function (k) { sk[k] = { type: 'bare' }; });
    t.section_kind_to_command = sk;
    var cols = look.columns === 2 ? 2 : 1;
    t.figure_environment = merge(template.figure_environment || {}, {
      compiled_columns: cols, placement: 'tbp', default_width: '\\linewidth', env: 'figure',
    });
    t.table_environment = merge(template.table_environment || {}, {
      placement: 'tbp', env: 'table', caption_position: look.caption.table_position === 'below' ? 'below' : 'above',
    });
    t.author_block = { format: 'look' };
    if (look.cite) {
      t.citation = merge(template.citation || {}, {
        render_family: look.cite.style === 'super' ? 'superscript' : look.cite.style === 'paren' ? 'numeric-paren'
          : look.cite.style === 'authoryear' ? 'author-year' : 'numeric-bracket',
        command: look.cite.style === 'authoryear' ? '\\citep' : '\\cite',
        narrative_command: look.cite.style === 'authoryear' ? '\\citet' : '\\cite',
      });
    }
    // special sections the look sets as unnumbered back matter
    t.special_sections = (template.special_sections || []).map(function (sp) {
      var c = sp.command;
      var type = c && typeof c === 'object' ? c.type : c;
      if (type === 'placeholder' || type === 'env' || type === 'macro') {
        return merge(sp, { command: 'section_star' });
      }
      return sp;
    });
    if (look.special_overrides) {
      t.special_sections = t.special_sections.map(function (sp) {
        return look.special_overrides[sp.key] ? merge(sp, { command: look.special_overrides[sp.key] }) : sp;
      });
    }
    return t;
  }

  /* Author / affiliation / correspondence text for the front matter.
   * esc = the exporter's escapeTex (so non-ASCII is handled one way). */
  function texAuthors(look, cfg, esc, leadAuthor) {
    var authors = ((cfg && cfg.authors) || []).filter(function (a) { return a && a.name; });
    var affils = (cfg && cfg.affiliations) || [];
    if (look.authors && look.authors.show === false) return { authors: '', affiliations: '', notes: '' };
    if (!authors.length) return { authors: esc(leadAuthor || ''), affiliations: '', notes: '' };
    var many = affils.length > 1;
    var runs = authors.map(function (a) {
      var nums = (Array.isArray(a.affiliationIdx) ? a.affiliationIdx : (a.affiliationIdx != null ? [a.affiliationIdx] : []))
        .filter(function (i) { return affils[i] != null; }).map(function (i) { return i + 1; });
      var marks = many ? nums.map(String) : [];
      if (a.corresponding) marks.push('*');
      return esc(a.name) + (marks.length ? '\\textsuperscript{' + marks.join(',') + '}' : '');
    });
    var joined = runs.length > 1 ? runs.slice(0, -1).join(', ') + (look.authors.and === '&' ? ' \\& ' : ', and ') + runs[runs.length - 1] : runs[0];
    var corr = authors.filter(function (a) { return a.corresponding && a.email; })[0];
    var affLines = affils.map(function (aff, i) {
      return (many ? '\\textsuperscript{' + (i + 1) + '}' : '') + esc(aff);
    });
    if (corr) affLines.push('\\textsuperscript{*}Correspondence: ' + esc(corr.email));
    var sepFront = look.affiliations.inline ? '. ' : '\\\\';
    var notes = '';
    if (look.affiliations.where === 'footnote' && look.front_page_alone) {
      notes = '{\\noindent\\rule{\\linewidth}{0.4bp}\\par\\vskip 2bp' + styleCmds(look, look.affiliations) + '\\noindent ' +
        affLines.join(' ') + '\\par}';
    } else if (look.affiliations.where === 'footnote') {
      notes = '\\begingroup\\renewcommand\\thefootnote{}\\footnotetext{\\fontsize{' + bp(look.affiliations.size) + '}{' +
        bp(look.affiliations.lead) + '}\\selectfont ' + affLines.join(' ') + '}\\endgroup';
    }
    return { authors: joined, affiliations: affLines.join(sepFront), notes: notes };
  }

  /* Tallest a figure's ARTWORK may be (bp) so that artwork + caption fit
   * the text area — a float taller than the page can never be placed and
   * LaTeX defers it to the very end (behind the references). The caption
   * height is estimated from its length at the look's caption size
   * (average glyph ≈ 0.47 em). Shared by the .tex export and the preview. */
  function figureMaxHeight(look, captionText, spanPage) {
    var textH = look.page.h - look.margins.top - look.margins.bottom;
    var bodyW = look.page.w - look.margins.left - look.margins.right;
    var w = (spanPage || look.columns !== 2) ? bodyW : (bodyW - look.colsep) / 2;
    var c = look.caption;
    var chars = String(captionText || '').replace(/\[[^\]]*\]|[*~^$]/g, '').length + 12;
    var lines = Math.ceil(chars * c.size * 0.47 / Math.max(50, w));
    var capH = lines * c.lead + c.skip + 4;
    return Math.max(72, Math.floor(textH - capH - 6));
  }

  /* ── Preview (Document view) ──────────────────────────────── */

  function geometry(look) {
    var cols = look.columns === 2 ? 2 : 1;
    var bodyW = (look.page.w - look.margins.left - look.margins.right) * PX;
    var colGap = cols === 2 ? look.colsep * PX : 0;
    /* V3.909 — a TeX column holds floor((\textheight − \topskip) /
     * \baselineskip) + 1 lines (the first baseline sits \topskip down);
     * CSS line boxes hold floor(height / lead). Measuring with
     * \textheight + \baselineskip − \topskip gives the same count.
     * \topskip: the look's, else article's 10pt. */
    var textH = look.page.h - look.margins.top - look.margins.bottom;
    var topskip = look.body.topskip != null ? look.body.topskip : 9.963;
    var extra = Math.max(0, look.body.lead - topskip);   // the sheet's text area grows into the foot margin
    return {
      pageW: look.page.w * PX, pageH: look.page.h * PX,
      marginTop: look.margins.top * PX, marginBottom: (look.margins.bottom - extra) * PX,
      marginLeft: look.margins.left * PX, marginRight: look.margins.right * PX,
      bodyW: bodyW, bodyH: (textH + extra) * PX,
      cols: cols, colGap: colGap, colW: cols === 2 ? (bodyW - colGap) / 2 : bodyW,
      fontPt: look.body.size, leadPx: look.body.lead * PX,
    };
  }

  function fontFaceCss() {
    var out = [];
    Object.keys(FONTS).forEach(function (id) {
      var f = FONTS[id];
      [['r', 'normal', 'normal'], ['b', 'bold', 'normal'], ['i', 'normal', 'italic'], ['bi', 'bold', 'italic']].forEach(function (v) {
        out.push('@font-face{font-family:"' + f.css + '";src:url("' + FONT_DIR + f.files[v[0]] + '") format("opentype");' +
          'font-weight:' + v[1] + ';font-style:' + v[2] + ';font-display:block;}');
      });
    });
    return out.join('\n');
  }
  function cssFam(look, fam) {
    var f = font(look, fam);
    return '"' + f.css + '", ' + (fam === 'sans' ? 'Helvetica, Arial, sans-serif' : '"Times New Roman", serif');
  }
  function cssBlock(look, s) {
    var css = 'font-family:' + cssFam(look, s.family || 'text') + ';';
    /* a class may load a family scaled (PNAS: helvet [scaled] = 0.95) —
     * the glyphs shrink, the baselineskip doesn't */
    var sc = (look.font_scale || {})[s.family || 'text'] || 1;
    if (s.size) css += 'font-size:' + n(s.size * sc * PX) + 'px;';
    if (s.lead || s.size) css += 'line-height:' + n((s.lead || s.size * 1.2) * PX) + 'px;';
    css += 'font-weight:' + (s.weight === 'bold' ? 700 : 400) + ';';
    css += 'font-style:' + (s.style === 'italic' ? 'italic' : 'normal') + ';';
    if (s.case === 'upper') css += 'text-transform:uppercase;';
    else if (s.case === 'smallcaps') css += 'font-variant:small-caps;';
    if (s.align) css += 'text-align:' + (s.align === 'justify' ? 'justify' : s.align) + ';';
    /* the family's inter-word glue, when the look gives it (the
     * typesetter reads these per space) */
    var G = look.glue || {};
    var gl = (s.weight === 'bold' && G[(s.family || 'text') + '-bold']) || G[s.family || 'text'];
    if (gl) css += '--pts-stretch:' + gl.stretch + ';--pts-shrink:' + gl.shrink + ';' + (gl.space ? '--pts-space:' + gl.space + ';' : '');
    return css;
  }

  /* ── TeX's vertical rhythm in CSS (V3.909) ──────────────────────
   * TeX sets two consecutive baselines `skip + \baselineskip` apart (the
   * NEXT line's baselineskip). CSS sets them (lead − off) + margin + off
   * apart, `off` being where the baseline sits in a line box:
   * (lead − (asc + desc)·size)/2 + asc·size with the face's hhea metrics.
   * texGap turns a TeX skip into the CSS margin that gives TeX's
   * distance; topGap moves a box at the top of the page up to TeX's first
   * baseline (the height of its tallest glyphs). */
  function lineOff(look, s) {
    var fam = s.family || 'text';
    var f = font(look, fam);
    var sz = s.size * ((look.font_scale || {})[fam] || 1);
    var asc = f.asc != null ? f.asc : 0.9, desc = f.desc != null ? f.desc : 0.25;
    return (s.lead - (asc + desc) * sz) / 2 + asc * sz;
  }
  function texGap(look, A, B, X) {
    return X + B.lead - (A.lead - lineOff(look, A)) - lineOff(look, B);
  }
  function topGap(look, s) {
    var fam = s.family || 'text';
    var f = font(look, fam);
    return (f.ht != null ? f.ht : 0.7) * s.size * ((look.font_scale || {})[fam] || 1) - lineOff(look, s);
  }

  /* an inline run's face only (no line-height: an inline must not grow
   * its line box) — a run-in label */
  function inlineCss(look, s) {
    var fam = s.family || 'text';
    var css = 'font-family:' + cssFam(look, fam) + ';';
    if (s.size) css += 'font-size:' + n(s.size * ((look.font_scale || {})[fam] || 1) * PX) + 'px;';
    css += 'font-weight:' + (s.weight === 'bold' ? 700 : 400) + ';font-style:' + (s.style === 'italic' ? 'italic' : 'normal') + ';';
    if (s.case === 'upper') css += 'text-transform:uppercase;';
    return css;
  }

  /* CSS for one look, scoped to `scope` (the overlay + the probe). */
  function css(look, scope) {
    var S = scope;
    var b = look.body;
    var R = [];
    R.push(S + '{--pl-lead:' + n(b.lead * PX) + 'px;--pl-indent:' + n(b.indent * PX) + 'px;}');
    // the sheets AND the off-screen measuring probe (it carries the scope
    // class itself) must set text identically, or pagination drifts
    R.push(S + ' .pdv-sheet, .pdv-probe' + S + '{font-family:' + cssFam(look, 'text') + ';font-size:' + n(b.size * PX) + 'px !important;line-height:' +
      n(b.lead * PX) + 'px;}');
    if (look.glue && look.glue.text) {
      R.push(S + ' .pdv-sheet, .pdv-probe' + S + '{--pts-stretch:' + look.glue.text.stretch + ';--pts-shrink:' + look.glue.text.shrink + ';' +
        (look.glue.text.space ? '--pts-space:' + look.glue.text.space + ';' : '') + '}');
    }
    /* a class set in TFM fonts kerns from the TFM's pairs, not the
     * OpenType face's — closer with the browser's kerning off (IEEE's
     * Times: 0.05 bp mean error per word instead of 0.09) */
    if (look.kerning === false) R.push(S + ' .pdv-sheet, .pdv-probe' + S + '{font-kerning:none;}');
    R.push(S + ' .pdv-para{margin:0;text-align:justify;line-height:' + n(b.lead * PX) + 'px;}');
    R.push(S + ' .pdv-bodypara{text-indent:' + n(b.indent * PX) + 'px;}');
    // headings: TeX's before/after skips between body baselines and theirs
    var bodyS = { family: 'text', size: b.size, lead: b.lead };
    function headRule(sel, h) {
      var mt = h.runin ? h.before : texGap(look, bodyS, h, h.before);
      var mb = h.runin ? h.after : texGap(look, h, bodyS, h.after);
      R.push(S + ' ' + sel + '{' + cssBlock(look, h) + 'margin:' + n(mt * PX) + 'px 0 ' + n(mb * PX) + 'px;}');
    }
    headRule('.pdv-heading', look.h1);
    headRule('.pdv-subheading-l2', look.h2);
    headRule('.pdv-subheading-l3', look.h3);
    R.push(S + ' .pdv-bodypara.pdv-noindent, ' + S + ' .pdv-bodypara.pdv-para-cont{text-indent:0 !important;}');
    // front matter: the \vskips between its pieces, as TeX spaces them
    var ab = look.abstract;
    var t = look.title, au = look.authors, af = look.affiliations;
    var noAuthors = au.show === false;   // V3.911 — a grant: the title alone
    var affFront = af.where !== 'footnote' && af.where !== 'none' && !noAuthors;
    var absHead = (ab.label && ab.label_style === 'heading')
      ? merge(ab, { size: ab.label_size || ab.size, lead: ab.label_lead || ab.lead, family: ab.label_family || ab.family }) : ab;
    if (ab.mode === 'none') absHead = bodyS;
    var lastFront = noAuthors ? t : affFront ? af : au;
    var frontX = (noAuthors ? t.after : affFront ? af.after : au.after) + (ab.before || 0);
    R.push(S + ' .pdv-title{' + cssBlock(look, t) + 'margin:0 0 ' + n((noAuthors ? 0 : texGap(look, t, au, t.after)) * PX) + 'px;}');
    R.push(S + ' .pdv-authors{' + cssBlock(look, au) + 'margin:0 0 ' + n((affFront ? texGap(look, au, af, au.after) : 0) * PX) + 'px;}');
    R.push(S + ' .pdv-affils, ' + S + ' .pdv-corr{' + cssBlock(look, af) + 'color:inherit;}');
    R.push(S + ' .pdv-titleblock{text-align:' + (t.align || 'left') + ';margin:' + n((topGap(look, t) + (t.before || 0)) * PX) + 'px 0 ' +
      n((texGap(look, lastFront, absHead, frontX) - (ab.before || 0)) * PX) + 'px;}');
    var kw = look.keywords || {};
    var kwS = merge(kw, { family: kw.family || 'text', lead: kw.lead || kw.size * 1.2 });
    var kwBefore = kw.before != null ? kw.before : 4;   // the front's \\vskip 4bp before the keywords line
    R.push(S + ' .pdv-abstract{' + cssBlock(look, ab) + 'margin:' + n((ab.before || 0) * PX) + 'px ' + n((ab.indent || 0) * PX) + 'px ' +
      n(ab.after * PX) + 'px;' + (ab.width ? 'max-width:' + n(ab.width * PX) + 'px;' : '') + '}');
    R.push(S + ' .pdv-abstract .pdv-para{font-size:inherit;line-height:inherit;text-indent:0;}');
    if (ab.first_indent) R.push(S + ' .pdv-abstract .pdv-para:first-of-type{text-indent:' + n(ab.first_indent * PX) + 'px;}');
    if (af.where === 'colnote') {
      R.push(S + ' .pdv-affil-colnote{' + cssBlock(look, merge(af, { align: 'justify' })) + 'text-indent:' + n((af.indent || 0) * PX) + 'px;}');
    }
    if (look.factbox) {
      R.push(S + ' .pdv-factbox{' + cssBlock(look, look.factbox) + 'padding-bottom:' + n((look.factbox.pad_bottom || 0) * PX) + 'px;}');
      R.push(S + ' .pdv-factbox .pdv-para{font-size:inherit;line-height:inherit;text-indent:0;margin:0 0 ' +
        n((look.factbox.parskip || 0) * PX) + 'px;}');
    }
    // after the keywords: the front's closing skip (spec looks), or — a
    // class that sets them in the first column (PNAS) — TeX's skip to the
    // first body line
    // (the keywords follow the abstract: their top margin takes back the
    // abstract's closing skip and puts TeX's gap in its place)
    var kwMB = look.engine === 'class' ? texGap(look, kwS, bodyS, kw.after || 0) : ab.after;
    R.push(S + ' .pdv-keywords{' + cssBlock(look, kwS) + 'text-indent:' + n((kw.indent || 0) * PX) + 'px;margin:' + n((texGap(look, ab, kwS, kwBefore) - ab.after) * PX) +
      'px 0 ' + n(kwMB * PX) + 'px;}');
    if (ab.box) {
      var pd = n((ab.box.pad != null ? ab.box.pad : 6) * PX);
      R.push(S + ' .pdv-abstract{padding:' + pd + 'px;' + (ab.box.bg ? 'background:rgb(' + Array(4).join(Math.round(ab.box.bg * 255) + ',').slice(0, -1) + ');'
        : 'border-top:0.67px solid #000;border-bottom:0.67px solid #000;padding-left:0;padding-right:0;') + '}');
    }
    if (ab.label_style === 'heading' && ab.label) {
      R.push(S + ' .pdv-abstract-head{' + cssBlock(look, merge(ab, { weight: ab.label_weight || 'bold', size: ab.label_size || ab.size,
        lead: ab.label_lead || ab.lead, family: ab.label_family || ab.family })) + 'margin:0 0 3px;}');
    }
    var c = look.caption;
    // \abovecaptionskip from the artwork's foot (no depth) to the first
    // caption baseline less one baselineskip, as TeX spaces it
    R.push(S + ' .pdv-figcap, ' + S + ' .pdv-tabcap{' + cssBlock(look, c) + 'margin-top:' + n((c.skip + c.lead - lineOff(look, c)) * PX) + 'px;text-align:' +
      (c.align === 'center' ? 'center' : c.align === 'left' ? 'left' : 'justify') + ';}');
    if (look.engine !== 'class') {
      /* V3.912 — the caption package sets a caption between struts: its
       * first baseline is \abovecaptionskip + 0.7 × the caption's
       * \baselineskip below the artwork, and its last line keeps the
       * strut's 0.3 × depth (measured in a wrapfigure box against
       * wrapfig's own \WF@size: the figure was 1.4 bp too tall before) */
      // (the depth as padding: a margin would collapse out of the figure box)
      var capD = lineOff(look, c) - 0.7 * c.lead;
      R.push(S + ' .pdv-figcap{margin-top:' + n((c.skip - capD + Math.min(0, capD)) * PX) + 'px;padding-bottom:' +
        n(Math.max(0, capD) * PX) + 'px;}');
    }
    var bib = look.bib;
    R.push(S + ' .pdv-bib{font-size:' + n(bib.size * ((look.font_scale || {})[bib.family || 'text'] || 1) * PX) + 'px;line-height:' +
      n(bib.lead * PX) + 'px;' + (bib.family ? 'font-family:' + cssFam(look, bib.family) + ';' : '') + '}');
    R.push(S + ' .pdv-bib-one .pdv-bib-entry{margin:0 0 ' + n((bib.sep || 0) * PX) + 'px;}');
    R.push(S + ' .pdv-eq{margin:' + n(look.display.above * PX) + 'px 0 ' + n(look.display.below * PX) + 'px;}');
    // a float's separation from the text is the band gap (\textfloatsep),
    // not a margin of its own
    R.push(S + ' .pdv-figure, ' + S + ' .pdv-table-wrap{margin:0;}');
    // \textsuperscript / \textsubscript and natbib's superscript citations
    // are set at TeX's script size (0.7 × the text size)
    R.push(S + ' sup, ' + S + ' sub{font-size:0.7em;line-height:0;}');
    R.push(S + ' .pe-cite-group.pe-cite-family-superscript{font-size:0.7em !important;}');
    // math at the text size, as TeX sets it (KaTeX's default is 1.21em) —
    // in the sheets AND the measuring probe
    R.push(S + ' .katex{font-size:1em;}');
    Object.keys(look.section_styles || {}).forEach(function (key) {
      var st = look.section_styles[key];
      var C = S + ' .pdv-secstyle-' + key;
      // every node of the section — paragraphs, lists AND display equations
      // (LaTeX scales the math with the section's \fontsize)
      if (st.size) R.push(C + ', ' + C + ' .pdv-para{font-size:' + n(st.size * PX) + 'px;line-height:' +
        n((st.lead || st.size * 1.15) * PX) + 'px;' + (st.family ? 'font-family:' + cssFam(look, st.family) + ';' : '') + '}');
      if (st.indent != null) R.push(C + '.pdv-bodypara{text-indent:' + n(st.indent * PX) + 'px;}');
      if (st.h2) R.push(C + '.pdv-subheading-l2{' + cssBlock(look, st.h2) + 'margin:' + n((st.h2.before || 4) * PX) + 'px 0 ' +
        n((st.h2.runin ? 0 : (st.h2.after || 2)) * PX) + 'px;}');
    });
    return R.join('\n');
  }

  var api = {
    FONTS: FONTS, FONT_DIR: FONT_DIR, DEFAULT: DEFAULT, PX: PX,
    resolve: resolve, merge: merge,
    texPreamble: texPreamble, texCitations: texCitations, texFront: texFront, texMain: texMain,
    applyToTemplate: applyToTemplate, texAuthors: texAuthors,
    sectionStyle: sectionStyle, texSectionOpen: texSectionOpen, texSectionClose: texSectionClose,
    texGap: texGap, inlineCss: inlineCss, lineOff: lineOff,
    figureMaxHeight: figureMaxHeight,
    geometry: geometry, css: css, fontFaceCss: fontFaceCss,
  };
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  else root.PaperLook = api;
})(typeof window !== 'undefined' ? window : this);
