/* paper-doc-view.js — V3.387
 *
 * Document view: the paper rendered as discrete journal-styled page
 * sheets (8.5×11 / A4 on a gray desk) that closely resemble the eventual
 * compiled PDF — WITHOUT building a PDF. Title/author block, abstract,
 * numbered/unnumbered sections per journal, resolved prose (typeset
 * citations via PaperCiteStyle, KaTeX, cross-refs), figures at their
 * configured LaTeX widths with "Figure N." captions, booktabs tables,
 * (N)-numbered display equations, and a formatted bibliography.
 *
 * It is also:
 *   - the surface for DESIGNING figure layout: click a figure → popover
 *     with width / placement / centering that writes the block attrs via
 *     the exact same transacts as the Figures panel (paper-blocks.js),
 *     so the panel + LaTeX export pick the change up for free;
 *   - THE way to change the target journal: the toolbar template select
 *     writes paperExports/{paperId}.templateId (set-merge — students may
 *     write, isLabContributor rule) and refreshes PaperCiteStyle so
 *     citation chips restyle everywhere.
 *
 * Fidelity model (deliberate estimates, page count shown as "≈ N"):
 *   - Block-atomic greedy pagination: blocks are measured off-screen and
 *     packed into pages; a block never splits across PAGES (paragraphs
 *     may split across COLUMNS inside a page, like LaTeX).
 *   - Two-column journals (ieee) pack column runs at 2× column capacity
 *     and render them in fixed-height CSS multicol segments; full-width
 *     items (title strip, \textwidth figures) sit BETWEEN segments — no
 *     column-span:all.
 *   - Columns/margins/fonts are baked into LaTeX preambles, not template
 *     JSON fields, so DOC_HINTS below carries per-template render hints.
 *
 * Live: re-renders ~1.5 s after any Yjs update (local or remote) and on
 * paper-panel-changed while open; listeners detach on close.
 *
 * Public API (window.PaperDocView): open(), close(), isOpen().
 */
(function () {
  'use strict';

  /* ── Per-template render hints (columns etc. live only inside LaTeX
   * preamble strings, so the doc view carries its own map; unknown ids
   * fall back to `default`). Future template JSONs may add structured
   * render hints — check tpl.render_hints first. ── */
  /* These describe the PUBLISHED, camera-ready look of each journal (the
   * two-column layout + small body font readers recognize), NOT the
   * single-column manuscript-submission templates the .tex export ships
   * today. The whole reason for hand-rolled LaTeX is to control that final
   * typeset output, so this is the target the Document view designs toward;
   * aligning the compiled .tex to it (twocolumn classes, figure*, spanning
   * title/abstract) is a separate follow-up. PLOS + preprints are genuinely
   * single-column even when published. Sizes/margins are close, tunable
   * approximations — column COUNT is the load-bearing value. */
  var DOC_HINTS = {
    'default':             { page: 'letter', marginIn: 1.0,  cols: 1, fontPt: 11 },
    'mebp-journal':        { page: 'a4',     marginIn: 1.0,  cols: 1, fontPt: 11 },
    'nature':              { page: 'letter', marginIn: 0.7,  cols: 2, fontPt: 9,   colGapIn: 0.22 },
    'science':             { page: 'letter', marginIn: 0.7,  cols: 2, fontPt: 9.5, colGapIn: 0.22 },
    'plos':                { page: 'letter', marginIn: 1.0,  cols: 1, fontPt: 10 },
    'elsevier':            { page: 'letter', marginIn: 0.7,  cols: 2, fontPt: 9.5, colGapIn: 0.25 },
    'ieee':                { page: 'letter', marginIn: 0.65, cols: 2, fontPt: 9.7, colGapIn: 0.2,  abstractRunIn: true, numbering: 'ieee' },
    'acs':                 { page: 'letter', marginIn: 0.75, cols: 2, fontPt: 9.8, colGapIn: 0.25 },
    /* V3.415 — PNAS compiles TWO-column on the real pnas-new class
     * (17.8 cm text block ≈ 0.75in margins on letter; 9pt body). */
    'pnas-new':            { page: 'letter', marginIn: 0.75, cols: 2, fontPt: 9.4, colGapIn: 0.16 },
    'preprint-numeric':    { page: 'letter', marginIn: 1.0,  cols: 1, fontPt: 11 },
    'preprint-authoryear': { page: 'letter', marginIn: 1.0,  cols: 1, fontPt: 11 },
  };
  /* CSS px at 96 dpi are exact for physical units. */
  var PAGE_SIZES = { letter: { w: 816, h: 1056 }, a4: { w: 794, h: 1123 } };
  var FILL_FACTOR = 0.99;      // V3.421 line-level splitting prevents clip,
                               // so columns fill nearly the full body height
                               // (was 0.97 for CSS-multicol drift — that left
                               // a ~3% blank strip at every page foot)
  var FLOAT_MAX_FRAC = 0.72;   // V3.397 — max page fraction float bands may
                               // claim (LaTeX's \topfraction analogue). Keeps
                               // text from starving AND prevents pack
                               // oscillation; locked floats ignore it.
  var FLOAT_REGIONS = { flow: 1, top: 1, bottom: 1, 'float-page': 1 };  // valid anchors ('wrap' is handled separately, not a band)
  /* V3.485 / V3.495 — a wrap figure absorbs the following flow blocks into
   * its group so text (INCLUDING subheadings — V3.495) flows around the
   * figure. Only a hard boundary stops the sweep: another float/full-width
   * item, a new figure/table, the bibliography, or the title block. Headings
   * and subheadings are NOT stops — they wrap beside the figure like body
   * text. (Cross-section is stopped separately by a sectionId change.) */
  var WRAP_STOP_KINDS = { figure: 1, table: 1, bibliography: 1, title: 1 };
  var MAX_SHEETS = 80;
  var BLOCK_GAP = 10;          // uniform vertical gap between flow items (px)
  /* V3.408 — document float-spacing preset (paperExports.floatSpacing).
   * 'normal' (or absent) === today's BLOCK_GAP, so untouched papers
   * render pixel-identical. Mirrors the exporter's \setlength presets
   * (tight/loose \textfloatsep etc.) — the preview analogue. */
  var FLOAT_GAP_PRESETS = { tight: 7, normal: 10, loose: 16 };
  function baseGapPx() {
    var preset = state.config && state.config.floatSpacing;
    /* V3.908 — a journal look's \textfloatsep (scaled by the Spacing
     * preset, as the exporter's preset block scales it). */
    var lk = state.lastLook;
    if (lk && lk.floats && lk.floats.textfloatsep) {
      var sc = preset === 'tight' ? 0.7 : preset === 'loose' ? 1.6 : 1;
      return Math.round(lk.floats.textfloatsep * (4 / 3) * sc);
    }
    return FLOAT_GAP_PRESETS[preset] || BLOCK_GAP;
  }
  /* Per-float gap: base preset + the block's own signed `spacing` nudge
   * (mm → px @96dpi; the R4 attr — absent = 0). Floored so a negative
   * nudge can never collapse a band row into its neighbor. Stamped ONCE
   * on each band row at pack time (`row.gap`) and read by BOTH
   * _recordRects and _mountBand — rects↔DOM alignment by construction. */
  function gapForFloat(f) {
    if (f && f.float && typeof f.float.gapPx === 'number') return f.float.gapPx;   // V3.909 — a note's own skip
    var mm = (f && f.float && typeof f.float.spacing === 'number') ? f.float.spacing : 0;
    return Math.max(2, baseGapPx() + Math.round(mm * (96 / 25.4)));
  }
  /* V3.427 — column-fill tightness (paperExports.columnFill). How many
   * lines of a paragraph must fit at a column/page foot before it breaks
   * there; the leftover carries to the next column. 'tight' fills the
   * most (splits down to a single line — the least blank, at the cost of
   * the occasional one-line orphan); 'loose' keeps more of a paragraph
   * together (more blank at page feet). Preview-only: the compiled PDF
   * fills columns via LaTeX's own \flushbottom glue. */
  var COLUMN_FILL_LINES = { tight: 1, normal: 2, loose: 4 };
  function fillMinLines() {
    var preset = state.config && state.config.columnFill;
    return COLUMN_FILL_LINES[preset] || COLUMN_FILL_LINES.tight;
  }
  /* V3.454 — Spacing preset drives the WHOLE preview's vertical rhythm,
   * not just float bands (Alex: "Spacing does nothing" — on papers whose
   * figures use the default 'flow' anchor, baseGapPx was never consulted).
   * One CSS var scales the pdv flow margins (paragraphs, headings,
   * figures, tables, lists) via calc(); it is set on the overlay AND the
   * measurement probe, and measureBatch reads computed margins, so
   * pagination follows automatically. 0.7/1.6 match the 7/10/16 px float
   * presets. */
  var GAP_SCALE = { tight: 0.7, normal: 1, loose: 1.6 };
  function _applySpacingScale() {
    var preset = state.config && state.config.floatSpacing;
    var v = String(GAP_SCALE[preset] || 1);
    if (state.overlayEl) state.overlayEl.style.setProperty('--pdv-gapscale', v);
    if (state.probeEl) state.probeEl.style.setProperty('--pdv-gapscale', v);
  }

  /* V3.486 — body line density (grant lines-per-inch). Resolves the
   * canonical bodyLpi to a body font + leading (shared PaperLayout math),
   * then sets --pdv-body-font / --pdv-body-lh (px) on the overlay + probe
   * so BOTH the mounted sheets and the measurement pass carry it, and the
   * `pdv-density-on` class gates the CSS. Body paragraphs + lists opt in
   * via `.pdv-density-body`; headings/title/captions keep their sizes.
   * Called before _measureItems so pagination follows the new line box.
   * Returns the resolved descriptor (or null) for the toolbar readout. */
  function _resolveBodyDensity() {
    if (!(state.config && state.config.bodyLpi > 0)) return null;
    if (!(window.PaperLayout && window.PaperLayout.resolveBodyDensity)) return null;
    return window.PaperLayout.resolveBodyDensity({
      lpi: state.config.bodyLpi,
      fontMin: state.config.bodyFontMin,
      fontMax: state.config.bodyFontMax,
    });
  }
  function _applyBodyDensity() {
    /* V3.913 — under a journal / grant look the look's own size and line
     * pitch rule (Check panel → Page settings); the older lines-per-inch
     * control is hidden and ignored, as in the export */
    var d = state.lastLook ? null : _resolveBodyDensity();
    var dmSel = state.overlayEl && state.overlayEl.querySelector('#pdv-density-mode');
    var field = dmSel && dmSel.closest('label');
    if (field) field.hidden = !!state.lastLook;
    var dvInp = state.overlayEl && state.overlayEl.querySelector('#pdv-density-value');
    if (dvInp && dvInp.closest('label') && dvInp.closest('label') !== field) dvInp.closest('label').hidden = !!state.lastLook;
    [state.overlayEl, state.probeEl].forEach(function (el) {
      if (!el) return;
      if (d) {
        el.style.setProperty('--pdv-body-font', (d.fontPt * 1.333) + 'px');
        el.style.setProperty('--pdv-body-lh', (d.leadingPt * 1.333) + 'px');
        el.classList.add('pdv-density-on');
      } else {
        el.style.removeProperty('--pdv-body-font');
        el.style.removeProperty('--pdv-body-lh');
        el.classList.remove('pdv-density-on');
      }
    });
    return d;
  }
  /* V3.401 — transact origins this view (or its own drop writes) issues.
   * During a layout session these skip the live-render debounce (each
   * manipulation schedules its own render); any OTHER origin is a
   * collaborator's edit → banner + defer until the session exits. */
  var LAYOUT_ORIGINS = {
    'fig-width': 1, 'fig-placement': 1, 'fig-center': 1,
    'fig-anchor': 1, 'fig-span': 1, 'fig-lock': 1, 'fig-size': 1,
    'tab-anchor': 1, 'tab-span': 1, 'tab-lock': 1,
    'fig-spacing': 1, 'tab-spacing': 1, 'eq-span': 1,
    'add-section': 1, 'delete-section': 1, 'move-section': 1, 'rename-section': 1,
    'figure-upload': 1,
    'move-block-within-section': 1, 'move-block-cross-section': 1,
  };
  var DRAG_THRESHOLD = 5;      // px of movement before a press becomes a drag
  var AUTO_SCROLL_EDGE = 48;   // px from the desk edge that auto-scrolls
  var AUTO_SCROLL_STEP = 14;

  var state = {
    open: false,
    overlayEl: null,
    deskEl: null,
    scaleEl: null,
    scaleOuterEl: null,
    probeEl: null,
    statusEl: null,
    pagesLabelEl: null,
    templateSelEl: null,
    paperId: null,
    config: null,           // paperExports doc data (or defaults)
    template: null,         // fetched template JSON
    templateCache: {},      // id → json | Promise
    imgSizeCache: {},       // url → {w, h}
    renderSeq: 0,
    renderTimer: null,
    lastRenderSig: null,    // skip rebuild when nothing visible changed
    forceRender: false,     // one-shot bypass of the signature guard
    zoom: 'fit',            // 'fit' | number
    openPopover: null,      // {blockId} — survives re-renders
    popEl: null,
    citePanelEl: null,      // V3.393 — left citation-details panel
    citePanelSeq: 0,        // guards async evidence loads
    layoutViz: false,       // V3.399 — ⬒ Layout region overlay on/off
    layoutSelectedId: null, // selected float blockId (highlight only)
    layoutSelectedSecId: null, // V3.424 — selected section (heading/box) id
    layoutSession: false,   // V3.401 — interactive session (viz + editable)
    layoutRemotePending: false, // collaborator edited mid-session
    measureCache: null,     // session-scoped height memo (content frozen)
    zoomK: 1,               // current scale factor (drag hit-testing)
    lastPages: null,        // last pack result (drop targets read firstFlow)
    lastGeom: null,         // V3.402 — last geometry (resize snap targets)
    yDoc: null,
    onYUpdate: null,
    onPanelChanged: null,
    onCitesLoaded: null,
    onResize: null,
    resizeTimer: null,
    onKeydown: null,
  };

  function _esc(s) {
    return String(s == null ? '' : s).replace(/[&<>"']/g, function (c) {
      return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c];
    });
  }
  function _pe() { return window.PaperEditor; }
  function _status(msg) {
    if (state.statusEl) state.statusEl.textContent = msg || '';
  }

  /* ── Template + config loading ─────────────────────────────── */

  function fetchTemplateCached(id) {
    if (state.templateCache[id] && typeof state.templateCache[id].then !== 'function') {
      return Promise.resolve(state.templateCache[id]);
    }
    if (state.templateCache[id]) return state.templateCache[id];
    var p = window.PaperExportTex.fetchTemplate(id).then(function (tpl) {
      state.templateCache[id] = tpl;
      return tpl;
    }, function (err) {
      delete state.templateCache[id];
      throw err;
    });
    state.templateCache[id] = p;
    return p;
  }

  /* Minimal fallback when a template can't be fetched — everything
   * renders as a plain numbered article with bracket citations. */
  function fallbackTemplate(id) {
    return {
      id: id || 'fallback',
      name: (id || 'template') + ' (offline fallback)',
      citation: { render_family: 'numeric-bracket' },
      refs: {},
      section_kind_to_command: { abstract: 'abstract_env', keywords: 'keywords_placeholder', references: 'skip' },
      default_section_label: {},
      figure_environment: { default_width: '0.9\\linewidth', placement: 'H' },
      table_environment: { use_booktabs: true },
    };
  }

  async function loadConfig() {
    var pe = _pe();
    var meta = (pe.getPaperMeta && pe.getPaperMeta()) || {};
    var cfg = {
      templateId: meta.template_id || 'mebp-journal',
      authors: [],
      affiliations: [],
      buildTarget: 'submission',   // V3.395 — 'submission' | 'preprint'
      floatSpacing: 'normal',      // V3.408 — 'tight' | 'normal' | 'loose'
      paperType: 'journal',        // V3.419 — gates the journal picker
      columnFill: 'tight',         // V3.427 — 'tight' | 'normal' | 'loose'
      layoutLook: 'published',     // V3.907 — 'published' | 'submission' (journal look vs manuscript)
      sectionNumbering: 'auto',    // 'auto' | 'on' | 'off'
      bodyLpi: null,               // V3.486 — grant lines-per-inch (null = off)
      bodyDensityMode: 'off',      // 'off' | 'lpi' | 'lpp'
      bodyDensityValue: 6,
      lookOverrides: null,         // V3.911 — this paper's own look settings (grant fitting knobs)
    };
    try {
      var snap = await firebridge.db().collection('paperExports').doc(state.paperId).get();
      if (snap.exists) {
        var d = snap.data() || {};
        if (d.templateId) cfg.templateId = d.templateId;
        if (Array.isArray(d.authors)) cfg.authors = d.authors;
        if (Array.isArray(d.affiliations)) cfg.affiliations = d.affiliations;
        if (d.buildTarget === 'preprint') cfg.buildTarget = 'preprint';   // V3.395
        if (FLOAT_GAP_PRESETS[d.floatSpacing]) cfg.floatSpacing = d.floatSpacing;   // V3.408
        if (window.PaperSchemas) {   // V3.470 — centralized type validation
          var _pt = window.PaperSchemas.normalizePaperType(d.paperType);
          if (_pt !== 'journal') cfg.paperType = _pt;
        }
        if (COLUMN_FILL_LINES[d.columnFill]) cfg.columnFill = d.columnFill;   // V3.427
        if (d.layoutLook === 'submission') cfg.layoutLook = 'submission';     // V3.907
        if (['auto', 'on', 'off'].indexOf(d.sectionNumbering) >= 0) cfg.sectionNumbering = d.sectionNumbering;
        /* V3.486 — body line density (grant lines-per-inch). */
        if (typeof d.bodyLpi === 'number' && d.bodyLpi > 0) cfg.bodyLpi = d.bodyLpi;
        if (['lpi', 'lpp'].indexOf(d.bodyDensityMode) >= 0) cfg.bodyDensityMode = d.bodyDensityMode;
        if (typeof d.bodyDensityValue === 'number' && d.bodyDensityValue > 0) cfg.bodyDensityValue = d.bodyDensityValue;
        if (d.lookOverrides && typeof d.lookOverrides === 'object') cfg.lookOverrides = d.lookOverrides;   // V3.911
      }
    } catch (e) {
      console.warn('[paper-doc-view] paperExports load failed:', e.message || e);
    }
    return cfg;
  }

  function hintsFor(templateId, tpl) {
    var h = DOC_HINTS[templateId] || DOC_HINTS['default'];
    /* Future-proofing: structured hints in the template JSON win. */
    if (tpl && tpl.render_hints) {
      h = Object.assign({}, h, tpl.render_hints);
    }
    return h;
  }

  function geometryFor(hints) {
    var size = PAGE_SIZES[hints.page] || PAGE_SIZES.letter;
    var margin = Math.round((hints.marginIn || 1) * 96);
    var cols = hints.cols === 2 ? 2 : 1;
    var colGap = Math.round((hints.colGapIn || 0.25) * 96);
    var bodyW = size.w - 2 * margin;
    var bodyH = size.h - 2 * margin;
    return {
      pageW: size.w, pageH: size.h, margin: margin,
      mT: margin, mR: margin, mB: margin, mL: margin,   // V3.907 — per-side (looks differ)
      bodyW: bodyW, bodyH: bodyH, cols: cols, colGap: colGap,
      colW: cols === 2 ? Math.floor((bodyW - colGap) / 2) : bodyW,
      fontPt: hints.fontPt || 11,
      abstractRunIn: !!hints.abstractRunIn,
      numbering: hints.numbering || 'arabic',   // section-number format
    };
  }

  /* V3.907 — the journal look in force (PaperLook), or null for the
   * legacy hint-based preview (templates without a look, or a paper set
   * to its submission manuscript). */
  function _lookFor(tpl) {
    if (!window.PaperLook || !tpl) return null;
    return window.PaperLook.resolve(tpl, { layoutLook: state.config && state.config.layoutLook,
      lookOverrides: state.config && state.config.lookOverrides });
  }
  /* Geometry straight from the look's numbers — the same page, margins,
   * columns and type sizes the .tex export compiles. */
  function geometryForLook(look) {
    var G = window.PaperLook.geometry(look);
    return {
      pageW: G.pageW, pageH: G.pageH, margin: G.marginLeft,
      mT: G.marginTop, mR: G.marginRight, mB: G.marginBottom, mL: G.marginLeft,
      bodyW: G.bodyW, bodyH: G.bodyH, cols: G.cols, colGap: G.colGap, colW: G.colW,
      fontPt: look.body.size, leadPx: G.leadPx,
      abstractRunIn: false,
      numbering: look.numbering || 'arabic',
      look: look,
    };
  }
  /* Fonts + the look's CSS, once per render, scoped to the overlay and the
   * measuring probe (both carry .pdv-look-on). Resolves when the look's
   * font files are loaded — measuring with a fallback font would break
   * every line differently. */
  function _applyLookCss(look) {
    var id = 'pdv-look-css';
    var el = document.getElementById(id);
    [state.overlayEl, state.probeEl].forEach(function (x) {
      if (!x) return;
      x.classList.toggle('pdv-look-on', !!look);
      if (look) x.dataset.look = look.id || ''; else delete x.dataset.look;
    });
    if (!look) { if (el) el.textContent = ''; return Promise.resolve(); }
    if (!el) { el = document.createElement('style'); el.id = id; document.head.appendChild(el); }
    el.textContent = window.PaperLook.fontFaceCss() + '\n' + window.PaperLook.css(look, '.pdv-look-on');
    if (!document.fonts || !document.fonts.load) return Promise.resolve();
    var fams = [];
    ['text', 'sans'].forEach(function (k) {
      var f = window.PaperLook.FONTS[look.fonts[k]];
      if (f && fams.indexOf(f.css) < 0) fams.push(f.css);
    });
    var loads = [];
    fams.forEach(function (fam) {
      ['400 normal', '700 normal', '400 italic', '700 italic'].forEach(function (v) {
        var parts = v.split(' ');
        loads.push(document.fonts.load(parts[1] + ' ' + parts[0] + ' 12px "' + fam + '"').catch(function () {}));
      });
    });
    return Promise.race([Promise.all(loads), new Promise(function (r) { setTimeout(r, 6000); })]);
  }

  /* ── Section-number formatting ──────────────────────────────
   * style 'arabic' → 1 / 1.1 / 1.1.1 ; style 'ieee' → I. / A. / 1) .
   * Preview only; the compiled PDF numbers via the LaTeX class. */
  function _romanUpper(n) {
    var map = [[1000, 'M'], [900, 'CM'], [500, 'D'], [400, 'CD'], [100, 'C'],
      [90, 'XC'], [50, 'L'], [40, 'XL'], [10, 'X'], [9, 'IX'], [5, 'V'], [4, 'IV'], [1, 'I']];
    var out = ''; n = n || 0;
    for (var i = 0; i < map.length && n > 0; i++) { while (n >= map[i][0]) { out += map[i][1]; n -= map[i][0]; } }
    return out || '0';
  }
  function _alphaUpper(n) {
    n = n || 1; var s = '';
    while (n > 0) { var r = (n - 1) % 26; s = String.fromCharCode(65 + r) + s; n = Math.floor((n - 1) / 26); }
    return s;
  }
  /* `appendix` (optional) forces alpha section letters (A, B / A.1 / A.1.1)
   * regardless of the base style — matches LaTeX's \appendix. */
  function fmtSectionNum(style, s, appendix) {
    if (appendix) return _alphaUpper(s) + '.';
    return style === 'ieee' ? _romanUpper(s) + '.' : s + '.';
  }
  function fmtSubNum(style, s, sub, appendix) {
    if (appendix) return _alphaUpper(s) + '.' + sub;
    return style === 'ieee' ? _alphaUpper(sub) + '.' : s + '.' + sub;
  }
  function fmtSubsubNum(style, s, sub, ss, appendix) {
    if (appendix) return _alphaUpper(s) + '.' + sub + '.' + ss;
    return style === 'ieee' ? ss + ')' : s + '.' + sub + '.' + ss;
  }

  /* List body (one item per line; 2-space indent = one nest level) →
   * nested <ul>/<ol>. Each item runs through the paragraph contract so
   * inline cites/math/formatting render. */
  function _listHtml(body, listType) {
    var items = [];
    String(body || '').split('\n').forEach(function (line) {
      var m = line.match(/^(\s*)(.*)$/);
      var text = m[2].replace(/\s+$/, '');
      if (!text) return;
      items.push({ depth: Math.min(3, Math.floor(m[1].replace(/\t/g, '  ').length / 2)), text: text });
    });
    return _listItemsHtml(items, listType);
  }
  /* V3.917 — [{depth, text}] → the same nested list (a list block's lines,
   * or a paragraph's "- item" run from PaperSchemas.parseBodyRuns) */
  function _listItemsHtml(items, listType) {
    var pe = _pe();
    var tag = listType === 'number' ? 'ol' : 'ul';
    if (!items.length) return '<' + tag + ' class="pdv-list"><li><span class="pdv-draft">empty list</span></li></' + tag + '>';
    var html = '<' + tag + ' class="pdv-list">', depth = 0;
    items.forEach(function (it) {
      while (depth < it.depth) { html += '<' + tag + ' class="pdv-list">'; depth++; }
      while (depth > it.depth) { html += '</' + tag + '>'; depth--; }
      html += '<li>' + (pe ? pe.renderParagraphHtml(it.text) : _esc(it.text)) + '</li>';
    });
    while (depth-- > 0) html += '</' + tag + '>';
    return html + '</' + tag + '>';
  }

  /* ── LaTeX width spec → CSS ────────────────────────────────── */

  // Returns {frac, base:'column'|'page'} — \textwidth targets the page
  // body (spans both columns in 2-col); \linewidth/\columnwidth target
  // the current column. Unparseable specs render full column width.
  function parseWidth(spec, defaultSpec) {
    var s = String(spec || defaultSpec || '\\linewidth').trim();
    var m = s.match(/^([0-9.]*)\s*\\(linewidth|columnwidth|textwidth)$/);
    if (!m) {
      /* V3.395 — absolute units (89mm Nature single-column etc.), the
       * other spec form the exporter round-trips. mm→px at CSS 96dpi. */
      var mAbs = s.match(/^([0-9.]+)\s*(mm|cm|in|pt)$/);
      if (mAbs) {
        var per = { mm: 96 / 25.4, cm: 96 / 2.54, in: 96, pt: 96 / 72 }[mAbs[2]];
        var px = parseFloat(mAbs[1]) * per;
        if (px > 0) return { absPx: px, base: 'absolute' };
      }
      console.info('[paper-doc-view] unparseable width spec "' + s + '" — rendering full width');
      return { frac: 1, base: 'column' };
    }
    var frac = m[1] ? parseFloat(m[1]) : 1;
    if (!(frac > 0) || frac > 1.5) frac = 1;
    return { frac: frac, base: m[2] === 'textwidth' ? 'page' : 'column' };
  }

  /* ── Open / close ──────────────────────────────────────────── */

  function isOpen() { return state.open; }

  async function open() {
    if (state.open) return;
    var pe = _pe();
    if (!pe || !pe.getPaperMap || !pe.getPaperMap()) {
      alert('Document view needs an open paper.');
      return;
    }
    state.open = true;
    state.paperId = pe.getPaperId();
    _buildShell();
    _status('Laying out…');
    try {
      var results = await Promise.all([
        loadConfig(),
        (pe.ensureKatex ? pe.ensureKatex().catch(function () {
          _status('KaTeX unavailable — math renders as source.');
          return null;
        }) : Promise.resolve(null)),
        /* Ensure the citation family + first-appearance numbers are ready
         * before the first render — otherwise renderParagraphHtml falls
         * back to legacy "Author Year" labels for inline citations even on
         * a numeric/superscript journal. Idempotent; its repaint event
         * isn't one this view listens to. */
        (window.PaperCiteStyle && window.PaperCiteStyle.init
          ? window.PaperCiteStyle.init(state.paperId).catch(function () { return null; })
          : Promise.resolve(null)),
      ]);
      if (!state.open) return;
      state.config = results[0];
      try {
        state.template = await fetchTemplateCached(state.config.templateId);
      } catch (e) {
        console.warn('[paper-doc-view] template fetch failed:', e.message || e);
        state.template = fallbackTemplate(state.config.templateId);
        _status('Template offline — using a generic article layout.');
      }
      if (!state.open) return;
      if (state.templateSelEl && window.PaperExportConfig) {
        window.PaperExportConfig.populateTemplateSelect(state.templateSelEl, state.config.templateId, state.config.paperType);
      }
      var btSelInit = state.overlayEl && state.overlayEl.querySelector('#pdv-build-target');
      if (btSelInit) {
        btSelInit.value = state.config.buildTarget || 'submission';
        if (_pe().isEditable()) btSelInit.disabled = false;   // config is loaded — safe to change
      }
      var fsSelInit = state.overlayEl && state.overlayEl.querySelector('#pdv-float-spacing');
      if (fsSelInit) {
        fsSelInit.value = state.config.floatSpacing || 'normal';
        if (_pe().isEditable()) fsSelInit.disabled = false;   // V3.408
      }
      var cfSelInit = state.overlayEl && state.overlayEl.querySelector('#pdv-column-fill');
      if (cfSelInit) {
        cfSelInit.value = state.config.columnFill || 'tight';
        if (_pe().isEditable()) cfSelInit.disabled = false;   // V3.427
      }
      var nmSelInit = state.overlayEl && state.overlayEl.querySelector('#pdv-numbering');
      if (nmSelInit) {
        nmSelInit.value = state.config.sectionNumbering || 'auto';
        if (_pe().isEditable()) nmSelInit.disabled = false;
      }
      _syncDensityControls();   // V3.486 — mode/value + enabled state + readout
      var insBtn = state.overlayEl && state.overlayEl.querySelector('#pdv-insert');
      if (insBtn && _pe().isEditable() && _pe().addSection) insBtn.hidden = false;   // V3.416
      _attachLive();
      await renderDocument();
    } catch (e) {
      console.error('[paper-doc-view] open failed:', e);
      _status('Failed to render: ' + (e.message || e));
    }
  }

  function close() {
    if (!state.open) return;
    state.open = false;
    state.renderSeq++;                    // abandon in-flight renders
    if (state.renderTimer) { clearTimeout(state.renderTimer); state.renderTimer = null; }
    _detachLive();
    _closeFigPopover();
    _closeCitePanel();
    _closeCheckPanel();          // V3.910
    _cancelDrag();               // V3.401
    _closeInsertMenu();          // V3.416
    if (state.onDocClick) { document.removeEventListener('click', state.onDocClick); state.onDocClick = null; }
    state.layoutViz = false;
    state.layoutSession = false;
    state.layoutRemotePending = false;
    state.layoutSelectedId = null;
    state.measureCache = null;
    state.lastPages = null;
    if (state.overlayEl) state.overlayEl.remove();
    if (state.probeEl) state.probeEl.remove();
    state.overlayEl = state.deskEl = state.scaleEl = state.scaleOuterEl = null;
    state.probeEl = state.statusEl = state.pagesLabelEl = state.templateSelEl = null;
    state.lastRenderSig = null;           // so reopening re-renders from scratch
    document.body.style.overflow = '';
  }

  function _buildShell() {
    var editable = _pe().isEditable();
    var overlay = document.createElement('div');
    overlay.className = 'pdv-overlay';
    overlay.innerHTML =
      '<div class="pdv-toolbar">' +
      '<span class="pdv-toolbar-title">' + ICON.svg('document-text') + ' Document view</span>' +
      '<label class="pdv-toolbar-field">Journal ' +
      '<select id="pdv-template"' + (editable ? '' : ' disabled title="Read-only — only paper authors can change the journal"') + '></select>' +
      '</label>' +
      /* V3.914 — a grant's separate uploads (NSF: Project Description,
       * References Cited, Project Summary, DMSP …), each in the grant's
       * look with its own page limit */
      '<label class="pdv-toolbar-field" id="pdv-doc-field" hidden title="The funder\'s separate documents, each with its own page limit">Document ' +
      '<select id="pdv-doc"></select></label>' +
      '<label class="pdv-toolbar-field">Zoom ' +
      '<select id="pdv-zoom">' +
      '<option value="fit">Fit width</option>' +
      '<option value="0.75">75%</option>' +
      '<option value="1">100%</option>' +
      '<option value="1.25">125%</option>' +
      '</select></label>' +
      /* V3.399 — color-coded layout regions (margins / columns / float
       * areas / text / footnotes), drawn from each page's recorded
       * rects. Viz only in R3; becomes the interactive mode in R4. */
      '<button class="btn btn-sm" id="pdv-layout" title="Show the page\'s layout regions — margins, columns, figure/table areas">⬒ Layout</button>' +
      /* V3.910 — layout check (journal looks): loose lines, widows and
       * orphans, figures far from their first mention, lines to save. */
      '<button class="btn btn-sm" id="pdv-check" hidden title="Check the layout — loose lines, widows and orphans, figures far from where they are cited, and lines you can save">' +
        ICON.svg('check-circle') + ' Check <span class="pdv-check-count" id="pdv-check-count"></span></button>' +
      /* V3.416 — section styles: insert the current journal's special
       * sections (PNAS Significance…), any other journal's, or a custom
       * style. Editable-gated in open(). */
      '<button class="btn btn-sm" id="pdv-insert" title="Insert a section — journal special sections or custom styles" hidden>' + ICON.svg('plus') + ' Insert ' + ICON.svg('chevron-down') + '</button>' +
      '<span class="pdv-pages-label" id="pdv-pages"></span>' +
      '<span class="pdv-status" id="pdv-status"></span>' +
      '<span class="pdv-toolbar-spacer"></span>' +
      /* V3.395 — build target: how anchors/locks map to LaTeX floats.
       * Shares paperExports.buildTarget with the Export workspace. */
      '<label class="pdv-toolbar-field" title="Submission follows the journal\'s float rules; preprint pins locked figures exactly ([H]).">Build ' +
      /* Starts disabled until loadConfig resolves (review fix: a change
       * before state.config exists would throw + silently revert);
       * re-enabled for editors in open() once the config lands. */
      '<select id="pdv-build-target" disabled>' +
      '<option value="submission">Submission</option>' +
      '<option value="preprint">Preprint (exact)</option>' +
      '</select></label>' +
      /* V3.408 — document float spacing: how tight figures/tables sit
       * against the text. Round-trips as a \setlength preamble block.
       * V3.454 — also scales the preview's whole vertical rhythm
       * (paragraph/heading/figure/table gaps) via --pdv-gapscale. */
      '<label class="pdv-toolbar-field" title="Vertical density of the page — paragraph, heading, figure and table gaps in the preview. Floats also carry it into the compiled PDF (\\textfloatsep/\\floatsep).">Spacing ' +
      '<select id="pdv-float-spacing" disabled>' +
      '<option value="tight">Tight</option>' +
      '<option value="normal">Normal</option>' +
      '<option value="loose">Loose</option>' +
      '</select></label>' +
      /* V3.427 — column fill: how completely a paragraph fills a column
       * foot before breaking to the next page. Preview-only. */
      '<label class="pdv-toolbar-field" title="How completely paragraphs fill a column before breaking to the next page. Tight = least blank (allows one-line orphans); Loose = needs 4 free lines to break and never strands a single carried-over line. Preview only — the PDF fills columns via LaTeX.">Fill ' +
      '<select id="pdv-column-fill" disabled>' +
      '<option value="tight">Tight</option>' +
      '<option value="normal">Balanced</option>' +
      '<option value="loose">Loose</option>' +
      '</select></label>' +
      /* Section numbering: auto (per journal) / on / off. Numbers
       * sections + subheadings; also emits secnumdepth on compile. */
      '<label class="pdv-toolbar-field" title="Number sections and subheadings. Auto follows the journal class; On forces numbers (even on styles that default to unnumbered); Off suppresses them. Applies to the preview and the compiled PDF (secnumdepth).">Numbering ' +
      '<select id="pdv-numbering" disabled>' +
      '<option value="auto">Auto</option>' +
      '<option value="on">Numbered</option>' +
      '<option value="off">Unnumbered</option>' +
      '</select></label>' +
      /* V3.486 — body-text line density (grant lines-per-inch). Mode Off /
       * per-inch / per-page + a value; the body font & leading auto-adjust
       * (headings/title unchanged) in the preview AND the compiled PDF.
       * Per-inch is the compliance metric; per-page converts to it using
       * the current text height. */
      '<label class="pdv-toolbar-field" title="Grant line-density: cap body text at a set lines-per-inch (e.g. NSF = 6) or a target lines-per-page. The BODY font size + leading auto-adjust to hit it; headings and the title are unchanged. Applies to the preview and the compiled PDF.">Lines ' +
      '<select id="pdv-density-mode" disabled>' +
      '<option value="off">Off</option>' +
      '<option value="lpi">Per inch</option>' +
      '<option value="lpp">Per page</option>' +
      '</select>' +
      '<input id="pdv-density-value" type="number" min="1" max="99" step="0.5" style="width:54px;margin-left:4px" disabled>' +
      '<span id="pdv-density-readout" class="pdv-density-readout"></span>' +
      '</label>' +
      '<a class="btn btn-sm" id="pdv-compile-link" href="/rm/pages/paper-export.html?paper=' +
        encodeURIComponent(state.paperId) + '" title="Open the Export workspace to compile the real PDF">Compile PDF →</a>' +
      '<button class="btn btn-sm" id="pdv-close" title="Close (Esc)">' + ICON.svg('x-mark') + '</button>' +
      '</div>' +
      '<div class="pdv-desk"><div class="pdv-scale-outer"><div class="pdv-scale"></div></div></div>' +
      /* V3.406 — Layout-mode color key. Content washes out while the
       * per-type tints color every block by what it IS; this legend
       * names the colors. Lives in the overlay (unscaled, unwashed),
       * hidden until ⬒ Layout is on. */
      '<div class="pdv-legend" hidden>' +
      '<span class="pdv-legend-chip"><i style="background:rgba(37,99,235,.55)"></i>Figure</span>' +
      '<span class="pdv-legend-chip"><i style="background:rgba(147,51,234,.55)"></i>Table</span>' +
      '<span class="pdv-legend-chip"><i style="background:rgba(20,184,166,.55)"></i>Equation</span>' +
      '<span class="pdv-legend-chip"><i style="background:rgba(100,116,139,.45)"></i>Text</span>' +
      '<span class="pdv-legend-chip"><i style="background:rgba(245,158,11,.55)"></i>Heading</span>' +
      '<span class="pdv-legend-chip"><i style="background:rgba(244,63,94,.45)"></i>Front matter</span>' +
      '</div>';
    document.body.appendChild(overlay);
    state.overlayEl = overlay;
    state.deskEl = overlay.querySelector('.pdv-desk');
    state.scaleEl = overlay.querySelector('.pdv-scale');
    state.scaleOuterEl = overlay.querySelector('.pdv-scale-outer');
    state.statusEl = overlay.querySelector('#pdv-status');
    state.pagesLabelEl = overlay.querySelector('#pdv-pages');
    state.templateSelEl = overlay.querySelector('#pdv-template');
    var docSel = overlay.querySelector('#pdv-doc');
    if (docSel) docSel.addEventListener('change', function () {
      state.grantDoc = docSel.value || 'project_description';
      state.fitResult = null;
      state.forceRender = true;
      renderDocument().catch(function (e) { console.warn('[paper-doc-view] render failed:', e.message || e); });
    });

    var probe = document.createElement('div');
    probe.className = 'pdv-probe';
    document.body.appendChild(probe);
    state.probeEl = probe;

    document.body.style.overflow = 'hidden';
    overlay.querySelector('#pdv-close').addEventListener('click', close);
    state.onKeydown = function (ev) {
      if (ev.key !== 'Escape') return;
      if (_resize) { _cancelResize(); return; }                // V3.405
      if (_drag && _drag.started) { _cancelDrag(); return; }   // V3.401
      if (state.popEl) { _closeFigPopover(); return; }
      if (state.citePanelEl) { _closeCitePanel(); return; }
      /* V3.399 — layout overlay: deselect first, then turn the viz off. */
      if (state.layoutViz && (state.layoutSelectedId || state.layoutSelectedSecId)) {
        state.layoutSelectedId = null;
        state.layoutSelectedSecId = null;
        _applyLayoutSelection();
        return;
      }
      if (state.layoutViz) { _toggleLayoutViz(); return; }
      close();
    };
    document.addEventListener('keydown', state.onKeydown, true);

    var zoomSel = overlay.querySelector('#pdv-zoom');
    zoomSel.value = String(state.zoom);
    zoomSel.addEventListener('change', function () {
      state.zoom = zoomSel.value === 'fit' ? 'fit' : parseFloat(zoomSel.value);
      _applyZoom();
    });

    if (editable && state.templateSelEl) {
      state.templateSelEl.addEventListener('change', _onTemplateChange);
    }
    var fsSel = overlay.querySelector('#pdv-float-spacing');
    if (fsSel) {
      fsSel.addEventListener('change', function () { _onFloatSpacingChange(fsSel); });
    }
    var cfSel = overlay.querySelector('#pdv-column-fill');
    if (cfSel) {
      cfSel.addEventListener('change', function () { _onColumnFillChange(cfSel); });
    }
    var nmSel = overlay.querySelector('#pdv-numbering');
    if (nmSel) {
      nmSel.addEventListener('change', function () { _onNumberingChange(nmSel); });
    }
    /* V3.486 — body line density: mode select + value input both commit
     * through one handler. */
    var dmSel = overlay.querySelector('#pdv-density-mode');
    var dvInp = overlay.querySelector('#pdv-density-value');
    if (dmSel) dmSel.addEventListener('change', function () { _onBodyDensityChange(dmSel, dvInp); });
    if (dvInp) dvInp.addEventListener('change', function () { _onBodyDensityChange(dmSel, dvInp); });
    var btSel = overlay.querySelector('#pdv-build-target');
    if (editable && btSel) {
      btSel.addEventListener('change', function () { _onBuildTargetChange(btSel); });
    }
    var layoutBtn = overlay.querySelector('#pdv-layout');
    if (layoutBtn) layoutBtn.addEventListener('click', _toggleLayoutViz);
    var checkBtn = overlay.querySelector('#pdv-check');
    if (checkBtn) checkBtn.addEventListener('click', function () {
      if (state.checkPanelEl) _closeCheckPanel(); else _openCheckPanel();
    });
    /* V3.416 — section-style Insert menu. */
    var insertBtn = overlay.querySelector('#pdv-insert');
    if (insertBtn) insertBtn.addEventListener('click', function (ev) {
      ev.stopPropagation();
      if (state.insertMenuEl) _closeInsertMenu();
      else _openInsertMenu(insertBtn);
    });
    document.addEventListener('click', state.onDocClick = function (ev) {
      if (state.insertMenuEl && !state.insertMenuEl.contains(ev.target) &&
          ev.target !== insertBtn) _closeInsertMenu();
    });
    /* V3.401 — drag floats in a layout session. */
    state.deskEl.addEventListener('pointerdown', _onDeskPointerDown);
    /* Figure popover + citation panel — one delegated listener on the
     * desk. Citation clicks come FIRST and are NOT editable-gated:
     * read-only viewers can inspect metadata + evidence too. */
    state.deskEl.addEventListener('click', function (ev) {
      var cite = ev.target.closest && ev.target.closest('.pe-cite-group');
      if (cite && state.deskEl.contains(cite)) {
        var keys = (cite.getAttribute('data-cite-keys') || '')
          .split(';').map(function (s) { return s.trim(); }).filter(Boolean);
        if (keys.length) { _openCitePanel(keys); return; }
      }
      /* V3.399 — with the layout overlay on, clicking a figure/table
       * highlights its region rect (any viewer; no writes). Falls
       * through so editors still get the layout popover. */
      if (state.layoutViz) {
        var area = ev.target.closest && ev.target.closest(
          '.pdv-figure[data-block-id], .pdv-table-wrap[data-block-id]');
        var secSel = ev.target.closest && ev.target.closest(
          '.pdv-heading[data-section-id], .pdv-significance[data-section-id]');
        state.layoutSelectedId = (area && state.deskEl.contains(area)) ? area.dataset.blockId : null;
        /* V3.424 — a section (heading/boxed special) is selectable too;
         * its colored boundary frame is drawn and the region becomes a
         * move handle. Selecting one clears the float selection. */
        state.layoutSelectedSecId = (!area && secSel && state.deskEl.contains(secSel)) ? secSel.dataset.sectionId : null;
        _applyLayoutSelection();
      }
      if (!_pe().isEditable()) return;
      /* V3.401 — tables get the layout popover too (anchor/span/lock). */
      var fig = ev.target.closest('.pdv-figure[data-block-id], .pdv-table-wrap[data-block-id]');
      if (fig) { _openFigPopover(fig); return; }
      /* V3.412 — display equations get a minimal Span popover (column
       * vs both-columns; exports via cuted's strip in 2-col classes). */
      var eq = ev.target.closest('.pdv-eq[data-block-id]');
      if (eq) { _openEqPopover(eq); return; }
      /* V3.416 — section headings + boxed specials: rename/move/delete. */
      var sec = ev.target.closest('.pdv-heading[data-section-id], .pdv-significance[data-section-id]');
      if (sec && sec.dataset.sectionId) { _openSecPopover(sec); return; }
      if (state.popEl && !state.popEl.contains(ev.target)) _closeFigPopover();
    });
    /* The popover is anchored by fixed viewport coords, so scrolling the
     * desk would detach it from its figure — dismiss it instead. */
    state.deskEl.addEventListener('scroll', function () {
      if (state.popEl) _closeFigPopover();
    });
    /* V3.419 — citation HOVER preview. With the panel open, hovering
     * any cite group loads it over the set (debounced); leaving reverts
     * to the set. Click still sets. */
    function _hoverKeys(ev) {
      var g = ev.target.closest && ev.target.closest('.pe-cite-group');
      if (!g || !state.deskEl.contains(g)) return null;
      var keys = (g.getAttribute('data-cite-keys') || '')
        .split(';').map(function (x) { return x.trim(); }).filter(Boolean);
      return keys.length ? keys : null;
    }
    state.deskEl.addEventListener('mouseover', function (ev) {
      if (!state.citePanelEl) return;
      var keys = _hoverKeys(ev);
      if (!keys) return;
      if (state.citeHoverTimer) clearTimeout(state.citeHoverTimer);
      state.citeHoverTimer = setTimeout(function () {
        state.citeHoverTimer = null;
        if (!state.citePanelEl) return;
        if (keys.join(';') === state.citeShownKeys) return;
        _openCitePanel(keys, { preview: true });
      }, 130);
    });
    state.deskEl.addEventListener('mouseout', function (ev) {
      if (!state.citePanelEl || !state.citeSetKeys) return;
      if (!_hoverKeys(ev)) return;
      var into = ev.relatedTarget;
      if (into && into.closest && into.closest('.pe-cite-group')) return;
      if (state.citeHoverTimer) clearTimeout(state.citeHoverTimer);
      state.citeHoverTimer = setTimeout(function () {
        state.citeHoverTimer = null;
        if (!state.citePanelEl || !state.citeSetKeys) return;
        if (state.citeSetKeys.join(';') === state.citeShownKeys) return;
        _openCitePanel(state.citeSetKeys);
      }, 200);
    });
  }

  /* ── Live updates ──────────────────────────────────────────── */

  function scheduleRender(ms) {
    if (!state.open) return;
    if (state.renderTimer) clearTimeout(state.renderTimer);
    state.renderTimer = setTimeout(function () {
      state.renderTimer = null;
      renderDocument().catch(function (e) {
        console.warn('[paper-doc-view] render failed:', e.message || e);
      });
    }, typeof ms === 'number' ? ms : 1500);
  }

  function _attachLive() {
    var paperMap = _pe().getPaperMap();
    state.yDoc = paperMap && paperMap.doc;
    /* V3.401 — origin-discriminated during a layout session: our own
     * layout writes already schedule their render; a COLLABORATOR's
     * write must not blow away an in-progress drag (renderDocument
     * replaces scale.innerHTML), so it raises a banner and defers the
     * refresh to session exit. */
    state.onYUpdate = function (update, origin) {
      if (state.layoutSession) {
        if (LAYOUT_ORIGINS[origin]) return;
        state.layoutRemotePending = true;
        _showRemoteBanner();
        return;
      }
      scheduleRender(1500);
    };
    state.onPanelChanged = function () {
      if (state.layoutSession) return;   // panel echoes of our own writes
      scheduleRender(1500);
    };
    if (state.yDoc) state.yDoc.on('update', state.onYUpdate);
    window.addEventListener('paper-panel-changed', state.onPanelChanged);
    /* The bibliography depends on library metadata that can land after the
     * first render; the signature guard wouldn't see that change, so force
     * one render when the citation index (re)loads. */
    state.onCitesLoaded = function () { state.forceRender = true; scheduleRender(300); };
    window.addEventListener('paper-citations-loaded', state.onCitesLoaded);
    /* V3.453 — the citation FAMILY (superscript / [1] / (1) / author-
     * year) resolves from the export template, which can land after the
     * first paint; chips are baked into rendered HTML, so the sheet kept
     * the legacy look until an unrelated repaint. paper-equations-changed
     * fires for every panel event, so diff the family and only force a
     * render when it actually changed. */
    state.lastCiteFamily = (window.PaperCiteStyle && window.PaperCiteStyle.getFamily()) || null;
    state.onEqPanelChanged = function () {
      var fam = (window.PaperCiteStyle && window.PaperCiteStyle.getFamily()) || null;
      if (fam === state.lastCiteFamily) return;
      state.lastCiteFamily = fam;
      state.forceRender = true;
      scheduleRender(300);
    };
    window.addEventListener('paper-equations-changed', state.onEqPanelChanged);
    /* Refit "fit" zoom + dismiss the popover on window resize (debounced). */
    state.onResize = function () {
      if (state.resizeTimer) clearTimeout(state.resizeTimer);
      state.resizeTimer = setTimeout(function () {
        state.resizeTimer = null;
        if (!state.open) return;
        if (state.popEl) _closeFigPopover();
        if (state.zoom === 'fit') _applyZoom();
      }, 120);
    };
    window.addEventListener('resize', state.onResize);
  }
  function _detachLive() {
    if (state.yDoc && state.onYUpdate) {
      try { state.yDoc.off('update', state.onYUpdate); } catch (e) { /* ignore */ }
    }
    if (state.onPanelChanged) window.removeEventListener('paper-panel-changed', state.onPanelChanged);
    if (state.onCitesLoaded) window.removeEventListener('paper-citations-loaded', state.onCitesLoaded);
    if (state.onEqPanelChanged) window.removeEventListener('paper-equations-changed', state.onEqPanelChanged);
    if (state.onResize) window.removeEventListener('resize', state.onResize);
    if (state.resizeTimer) { clearTimeout(state.resizeTimer); state.resizeTimer = null; }
    if (state.onKeydown) document.removeEventListener('keydown', state.onKeydown, true);
    state.yDoc = null;
    state.onYUpdate = state.onPanelChanged = state.onCitesLoaded = state.onEqPanelChanged = state.onResize = state.onKeydown = null;
  }

  /* ── Template switcher ─────────────────────────────────────── */

  /* V3.395 — build-target switch (submission vs preprint). Set-merge on
   * the shared paperExports doc (mirrors _onTemplateChange); the Export
   * workspace reads the same field. Re-render so any anchored floats
   * re-derive their effective placement via PaperLayout.resolveFloat. */
  /* V3.408 — document float-spacing preset. Same shape as the
   * build-target switch: paperExports set-merge (NOT a Y.Doc transact,
   * so LAYOUT_ORIGINS isn't involved), then a forced re-render picks up
   * the new baseGapPx everywhere. */
  async function _onFloatSpacingChange(sel) {
    var preset = FLOAT_GAP_PRESETS[sel.value] ? sel.value : 'normal';
    var prev = (state.config && state.config.floatSpacing) || 'normal';
    if (!state.config || preset === prev) { sel.value = prev; return; }
    try {
      var user = firebridge.getUser && firebridge.getUser();
      await firebridge.db().collection('paperExports').doc(state.paperId).set({
        floatSpacing: preset,
        updatedAt: new Date().toISOString(),
        updatedBy: user ? user.uid : null,
      }, { merge: true });
      state.config.floatSpacing = preset;
      state.forceRender = true;
      scheduleRender(150);
      _status('Float spacing: ' + preset + ' (preview + compiled PDF).');
    } catch (e) {
      console.error('[paper-doc-view] float-spacing switch failed:', e);
      _status('Could not save the spacing preset: ' + (e.message || e));
      sel.value = prev;
    }
  }

  /* V3.427 — column-fill tightness. Preview-only (no LaTeX effect), but
   * persisted on the paperExports doc like the other presets so it sticks
   * across sessions and mirrors into the Export panel. */
  async function _onColumnFillChange(sel) {
    var preset = COLUMN_FILL_LINES[sel.value] ? sel.value : 'tight';
    var prev = (state.config && state.config.columnFill) || 'tight';
    if (!state.config || preset === prev) { sel.value = prev; return; }
    try {
      var user = firebridge.getUser && firebridge.getUser();
      await firebridge.db().collection('paperExports').doc(state.paperId).set({
        columnFill: preset,
        updatedAt: new Date().toISOString(),
        updatedBy: user ? user.uid : null,
      }, { merge: true });
      state.config.columnFill = preset;
      state.forceRender = true;
      scheduleRender(150);
      _status('Column fill: ' + preset + ' (preview only — the PDF fills via LaTeX).');
    } catch (e) {
      console.error('[paper-doc-view] column-fill switch failed:', e);
      _status('Could not save the fill preset: ' + (e.message || e));
      sel.value = prev;
    }
  }

  /* V3.486 — body line density. Reflects state.config into the mode
   * select + value input, toggles the value input on mode, enables for
   * editors, and paints the derived readout. */
  function _syncDensityControls() {
    var dmSel = state.overlayEl && state.overlayEl.querySelector('#pdv-density-mode');
    var dvInp = state.overlayEl && state.overlayEl.querySelector('#pdv-density-value');
    if (!dmSel || !dvInp) return;
    var mode = (state.config && state.config.bodyDensityMode) || 'off';
    var val = (state.config && state.config.bodyDensityValue) || 6;
    dmSel.value = mode;
    dvInp.value = String(val);
    dvInp.style.visibility = (mode === 'off') ? 'hidden' : '';
    if (_pe().isEditable()) { dmSel.disabled = false; dvInp.disabled = false; }
    _paintDensityReadout();
  }
  /* Derived readout: body font pt · lines/inch · ≈lines/page, ⚠ if the
   * font clamped. Uses the current geometry for the lines/page estimate. */
  function _paintDensityReadout() {
    var out = state.overlayEl && state.overlayEl.querySelector('#pdv-density-readout');
    if (!out) return;
    var d = _resolveBodyDensity();
    if (!d) { out.textContent = ''; out.removeAttribute('title'); return; }
    var g = state.lastGeom;
    var textIn = g ? g.bodyH / 96 : null;
    var parts = ['≈' + d.fontPt + 'pt', d.lpi + '/in'];
    if (textIn) parts.push('≈' + Math.round(d.lpi * textIn) + '/pg');
    if (d.clamped) ICON.label(out, 'exclamation-triangle', ' ' + parts.join(' · '));
    else out.textContent = parts.join(' · ');
    if (d.warning) out.title = d.warning; else out.removeAttribute('title');
  }
  /* Commit a density change. bodyLpi is the canonical stored metric: 'lpi'
   * mode stores the value directly; 'lpp' converts through the current
   * text height (lpi = lines-per-page ÷ text-height-in-inches) so the
   * saved value stays margin-independent (= grant-compliant). */
  async function _onBodyDensityChange(dmSel, dvInp) {
    if (!state.config) { _syncDensityControls(); return; }
    var mode = ['lpi', 'lpp'].indexOf(dmSel.value) >= 0 ? dmSel.value : 'off';
    var val = parseFloat(dvInp.value);
    if (!(val > 0) || !isFinite(val)) val = state.config.bodyDensityValue || 6;
    var lpi = null;
    if (mode === 'lpi') {
      lpi = Math.max(1, Math.min(20, val));
    } else if (mode === 'lpp') {
      var g = state.lastGeom;
      var textIn = g ? g.bodyH / 96 : 9;    // letter text height fallback
      if (textIn > 0) lpi = Math.max(1, Math.min(20, val / textIn));
    }
    var prev = {
      lpi: state.config.bodyLpi || null,
      mode: state.config.bodyDensityMode || 'off',
      val: state.config.bodyDensityValue || 6,
    };
    try {
      var user = firebridge.getUser && firebridge.getUser();
      await firebridge.db().collection('paperExports').doc(state.paperId).set({
        bodyLpi: lpi,
        bodyDensityMode: mode,
        bodyDensityValue: val,
        updatedAt: new Date().toISOString(),
        updatedBy: user ? user.uid : null,
      }, { merge: true });
      state.config.bodyLpi = lpi;
      state.config.bodyDensityMode = mode;
      state.config.bodyDensityValue = val;
      _syncDensityControls();
      state.forceRender = true;
      scheduleRender(150);
      _status(mode === 'off'
        ? 'Body line density: off (template default).'
        : 'Body line density: ' + (lpi ? (Math.round(lpi * 100) / 100) + ' lines/inch' : '—') + ' (preview + compiled PDF).');
    } catch (e) {
      console.error('[paper-doc-view] body-density switch failed:', e);
      _status('Could not save the line-density setting: ' + (e.message || e));
      state.config.bodyLpi = prev.lpi; state.config.bodyDensityMode = prev.mode; state.config.bodyDensityValue = prev.val;
      _syncDensityControls();
    }
  }

  /* Section numbering (auto | on | off). Affects the preview AND the
   * compiled PDF (secnumdepth + star flip in the exporter). */
  async function _onNumberingChange(sel) {
    var mode = ['auto', 'on', 'off'].indexOf(sel.value) >= 0 ? sel.value : 'auto';
    var prev = (state.config && state.config.sectionNumbering) || 'auto';
    if (!state.config || mode === prev) { sel.value = prev; return; }
    try {
      var user = firebridge.getUser && firebridge.getUser();
      await firebridge.db().collection('paperExports').doc(state.paperId).set({
        sectionNumbering: mode,
        updatedAt: new Date().toISOString(),
        updatedBy: user ? user.uid : null,
      }, { merge: true });
      state.config.sectionNumbering = mode;
      state.forceRender = true;
      scheduleRender(150);
      _status('Section numbering: ' + mode + ' (preview + compiled PDF).');
    } catch (e) {
      console.error('[paper-doc-view] numbering switch failed:', e);
      _status('Could not save the numbering setting: ' + (e.message || e));
      sel.value = prev;
    }
  }

  async function _onBuildTargetChange(sel) {
    var newTarget = sel.value === 'preprint' ? 'preprint' : 'submission';
    /* Belt over the disabled-until-loaded suspenders: never deref a
     * config that hasn't loaded yet. */
    var prev = (state.config && state.config.buildTarget) || 'submission';
    if (!state.config || newTarget === prev) { sel.value = prev; return; }
    try {
      var user = firebridge.getUser && firebridge.getUser();
      await firebridge.db().collection('paperExports').doc(state.paperId).set({
        buildTarget: newTarget,
        updatedAt: new Date().toISOString(),
        updatedBy: user ? user.uid : null,
      }, { merge: true });
      state.config.buildTarget = newTarget;
      state.forceRender = true;
      scheduleRender(150);
      _status(newTarget === 'preprint'
        ? 'Preprint build — locked figures pin exactly.'
        : 'Submission build — journal float rules.');
    } catch (e) {
      console.error('[paper-doc-view] build-target switch failed:', e);
      _status('Could not save the build target: ' + (e.message || e));
      sel.value = prev;
    }
  }

  async function _onTemplateChange() {
    var sel = state.templateSelEl;
    var newId = sel.value;
    var prevId = state.config.templateId;
    if (newId === prevId) return;
    _status('Switching journal…');
    try {
      var user = firebridge.getUser && firebridge.getUser();
      /* Mirror paper-export.js _saveConfigNow — set-merge preserves
       * authors/affiliations/addons/overrides on the doc. */
      await firebridge.db().collection('paperExports').doc(state.paperId).set({
        templateId: newId,
        updatedAt: new Date().toISOString(),
        updatedBy: user ? user.uid : null,
      }, { merge: true });
      state.config.templateId = newId;
      state.template = await fetchTemplateCached(newId).catch(function () {
        return fallbackTemplate(newId);
      });
      /* Re-read the family so citation chips (editor + this view)
       * restyle; then invalidate the global number cache. */
      if (window.PaperCiteStyle && window.PaperCiteStyle.init) {
        await window.PaperCiteStyle.init(state.paperId);
      }
      window.dispatchEvent(new CustomEvent('paper-panel-changed'));
      _status('Journal set to ' + (state.template.name || newId) + '.');
      scheduleRender(0);
    } catch (e) {
      console.error('[paper-doc-view] template switch failed:', e);
      _status('Could not save the journal change: ' + (e.message || e));
      sel.value = prevId;
    }
  }

  /* ── Document rendering ────────────────────────────────────── */

  /* V3.914 — the Document picker: shown for a grant look, listing the
   * narrative and the funder's other documents */
  function _syncDocPicker(rawTpl, look) {
    var field = state.overlayEl && state.overlayEl.querySelector('#pdv-doc-field');
    var sel = field && field.querySelector('#pdv-doc');
    if (!field || !sel) return;
    var docs = (look && rawTpl && rawTpl.grant && rawTpl.grant.documents) || [];
    field.hidden = !docs.length;
    if (!docs.length) { state.grantDoc = null; return; }
    var sig = docs.map(function (d) { return d.key; }).join(',');
    if (sel.dataset.sig !== sig) {
      sel.innerHTML = docs.map(function (d) {
        return '<option value="' + _esc(d.key) + '">' + _esc(d.label) + (d.page_limit ? ' (' + d.page_limit + ' p)' : '') + '</option>';
      }).join('');
      sel.dataset.sig = sig;
    }
    if (!state.grantDoc || !docs.some(function (d) { return d.key === state.grantDoc; })) state.grantDoc = docs[0].key;
    sel.value = state.grantDoc;
  }

  async function renderDocument() {
    if (!state.open) return;
    var seq = ++state.renderSeq;
    var pe = _pe();
    var rawTpl = state.template || fallbackTemplate(state.config && state.config.templateId);
    /* V3.907 — a journal look drives the page (and the template the walker
     * reads is the look-applied one: abstract/keyword placement, hidden
     * headings, caption labels), exactly as the exporter sees it. */
    var look = _lookFor(rawTpl);
    var tpl = look ? window.PaperLook.applyToTemplate(rawTpl, look) : rawTpl;
    var hints = hintsFor(state.config.templateId, rawTpl);
    var geom = look ? geometryForLook(look) : geometryFor(hints);
    state.lastLook = look;

    var tree = window.PaperExportTex.paperTreeFromYDoc(pe.getPaperMap().doc);

    /* V3.914 — a grant document other than the narrative: its own
     * sections (or, for References Cited, the bibliography alone), set in
     * the grant's look without the title */
    _syncDocPicker(rawTpl, look);
    var gdoc = (look && rawTpl.grant && state.grantDoc && state.grantDoc !== 'project_description')
      ? (rawTpl.grant.documents || []).filter(function (d) { return d.key === state.grantDoc; })[0] : null;
    state.subdocRefs = !!(gdoc && gdoc.references);
    if (gdoc) {
      look = window.PaperLook.merge(look, { title: { show: false } });
      tpl = window.PaperLook.applyToTemplate(rawTpl, look);
      var skd = Object.assign({}, tpl.section_kind_to_command || {});
      (gdoc.kinds || []).forEach(function (k) { skd[k] = 'section_star'; });
      tpl.section_kind_to_command = skd;
      geom = geometryForLook(look);
      state.lastLook = look;
      tree = Object.assign({}, tree, { sections: gdoc.references ? [] : (tree.sections || []).filter(function (sec) {
        return (gdoc.kinds || []).indexOf(sec.kind) >= 0;
      }) });
    }

    /* Skip the expensive rebuild (KaTeX per paragraph, off-screen measure,
     * full DOM teardown) when nothing that affects the rendered page has
     * changed. The yDoc 'update' event fires for many writes that don't
     * touch visible content — presence, title/status sync, citation-index
     * cache stamps — and this signature collapses all of those to a no-op.
     * The stringify is O(tree) but tiny next to a full render, and only
     * runs when the 1.5 s debounce fires, not per keystroke. */
    var family = (window.PaperCiteStyle && window.PaperCiteStyle.getFamily && window.PaperCiteStyle.getFamily()) ||
      (tpl.citation && tpl.citation.render_family) || 'numeric-bracket';
    var sig = null;
    try {
      var D = '\u0001';   // delimiter that never appears in JSON output
      sig = [
        JSON.stringify(tree), state.config.templateId, family,
        JSON.stringify(state.config.authors || []),
        JSON.stringify(state.config.affiliations || []),
        state.config.sectionNumbering || 'auto',
        state.config.layoutLook || 'published',
        JSON.stringify(state.config.lookOverrides || null),
        state.grantDoc || '',
        (pe.getCitedKeysInPaper() || []).join(',')
      ].join(D);
    } catch (e) { sig = null; }
    if (sig && sig === state.lastRenderSig && !state.forceRender) { _status(''); return; }
    state.forceRender = false;

    var figNums = {}, tabNums = {}, eqNums = {};
    (pe.getNumberedFigures() || []).forEach(function (f) { figNums[f.blockId] = f.num; });
    (pe.getNumberedTables() || []).forEach(function (t) { tabNums[t.blockId] = t.num; });
    (pe.getNumberedEquations() || []).forEach(function (e) { eqNums[e.blockId] = e.num; });

    var items = _buildFlowItems(tree, tpl, geom, { fig: figNums, tab: tabNums, eq: eqNums });
    /* V3.907 — a stand-alone front page (look.front_page_alone): the body
     * starts on page 2, like the PDF's \twocolumn after the front matter. */
    if (geom.look && geom.look.front_page_alone) {
      for (var bi = 0; bi < items.length; bi++) {
        var bk = items[bi].blockKind;
        if (bk !== 'title' && bk !== 'abstract' && bk !== 'keywords') { items[bi].breakBefore = true; break; }
      }
    }
    _extractFootnotes(items);
    _rewriteRefPrefixes(items, tpl);

    await _applyLookCss(look);   // V3.907 — look CSS + its fonts loaded BEFORE measuring
    if (seq !== state.renderSeq || !state.open) return;
    _applySpacingScale();   // V3.454 — before measuring: margins scale with the preset
    _applyBodyDensity();    // V3.486 — before measuring: body font/leading from lines-per-inch
    /* V3.495 — group wrap figures AFTER the probe carries the spacing +
     * density vars, so the figure-clear measurement matches the real layout. */
    if (!geom.look) _groupWrapFigures(items, geom);   // V3.485 — CSS wrap grouping; a look uses wrapfig's rules (V3.912)
    state.tsReport = {};   // V3.910 — per-paragraph typesetting results for the layout check
    state.wrapReport = {};  // V3.912 — where each wrapped figure was set (here / held / collision)
    await _measureItems(items, geom, seq);
    if (seq !== state.renderSeq || !state.open) return;

    var pages = _packPages(items, geom);
    state.lastPages = pages;   // V3.401 — drop targets read firstFlow/pageIdx
    state.lastGeom = geom;     // V3.402 — resize snap targets read colW/bodyW/cols
    _mountSheets(pages, geom, hints);
    _resolveSecRefs();   // upgrade [!sec:] chips to their computed numbers
    _joinAdjacentCites();   // V3.453 — fixed-width gaps between adjacent cite groups
    _paintDensityReadout();   // V3.486 — lines/page estimate needs the packed geometry
    _buildLayoutReport(geom);   // V3.910 — the layout check reads the mounted pages
    /* V3.495 — re-apply the layout selection so a selected figure keeps its
     * resize handles across a re-render. Without this, switching a figure to
     * Wrap (or any attr change that re-renders) rebuilt the DOM and the
     * boundary frame vanished — the figure read as "not draggable" until you
     * clicked it again. */
    if (state.layoutViz) _applyLayoutSelection();
    state.lastRenderSig = sig;
    _status('');
  }

  /* Build the linear flow: title block, sections (per
   * section_kind_to_command), blocks, bibliography. Each item:
   * { node, type:'full'|'col', h, footnotes:[{node,h}], blockKind }. */
  function _buildFlowItems(tree, tpl, geom, nums) {
    var pe = _pe();
    var items = [];
    var kindCmd = tpl.section_kind_to_command || {};
    var defLabels = tpl.default_section_label || {};

    /* V3.397 — items carry their source ids (sectionId/blockId — needed
     * by the R3 overlay + R4 drag writes) and a float classification:
     * float = null → in-flow (today's behavior); float = {region:
     * 'top'|'bottom'|'float-page', span:'page'|'column', lock} → the
     * packer diverts the item to a page band instead of the text flow. */
    function push(node, type, blockKind, sectionId, blockId, floatSpec) {
      items.push({
        node: node, type: type, h: 0, footnotes: [],
        blockKind: blockKind || '',
        sectionId: sectionId || null,
        blockId: blockId || null,
        float: floatSpec || null,
      });
    }

    var lookFront = geom.look ? _buildLookFront(tree.title, geom.look) : null;
    push(lookFront ? lookFront.block : _buildTitleBlock(tree.title), 'full', 'title');
    if (lookFront && lookFront.note) {
      /* affiliations as the first page's foot note (Nature family) — the
       * packer's page-footnote area, measured like any footnote */
      items[items.length - 1].footnotes.push({ node: lookFront.note, h: 0 });
    }
    if (lookFront && lookFront.colnote) {
      /* the IEEE author note: a footnote of column 1, page 1, \skip\footins
       * below the text */
      var lkA = geom.look, afS = lkA.affiliations;
      var noteGap = window.PaperLook.texGap(lkA, { family: 'text', size: lkA.body.size, lead: lkA.body.lead },
        afS, afS.note_skip != null ? afS.note_skip : 9) * 4 / 3;
      push(lookFront.colnote, 'col', 'factbox', null, null,
        { region: 'bottom', span: 'column', lock: false, col: 0, gapPx: Math.round(noteGap * 100) / 100 });
    }
    var LOOK = geom.look || null;
    /* V3.909 — a class's first-page fact box (PNAS: Significance,
     * Author contributions): those specials leave the flow and sit at the
     * foot of page 1's second column, where the class floats them. */
    var FACT = (LOOK && LOOK.factbox && Array.isArray(LOOK.factbox.specials)) ? LOOK.factbox : null;
    var factSecs = FACT ? tree.sections.filter(function (s) { return s.special && FACT.specials.indexOf(s.special) >= 0; }) : [];
    if (factSecs.length) {
      var fbox = document.createElement('div');
      fbox.className = 'pdv-factbox';
      fbox.innerHTML = factSecs.map(function (s) {
        var body = s.children
          .filter(function (b) { return b.kind === 'paragraph' && String(b.body || '').trim(); })
          .map(function (b) { return '<p class="pdv-para">' + pe.renderParagraphHtml(b.body) + '</p>'; })
          .join('');
        if (!body) return '';
        return specialPreview(s) === 'box'
          ? '<div class="pdv-significance"><div class="pdv-significance-head">' + _esc(s.label || 'Significance') + '</div>' + body + '</div>'
          : body;
      }).join('');
      if (fbox.innerHTML) {
        push(fbox, 'col', 'factbox', null, null,
          { region: 'bottom', span: 'column', lock: false, col: FACT.col != null ? FACT.col : 1 });
      }
    }

    var secCounter = 0, subCounter = 0, subsubCounter = 0;
    var sectionNumbered = false;   // does the CURRENT section carry a number
    var inAppendix = false;        // \appendix zone → alpha section letters
    var secRefNums = {};           // ref_label → number, for [!sec:] chips
    var numMode = (state.config && state.config.sectionNumbering) || 'auto';
    var numStyle = geom.numbering || 'arabic';
    /* Whether a body section (by its resolved command) gets a number:
     * 'off' never; 'on' any real \section/\section* body section; 'auto'
     * only the numbered \section (matches the compiled class). Specials
     * (box/abstract/keywords/placeholder/skip) are never numbered. */
    function sectionGetsNumber(cmdName) {
      if (numMode === 'off') return false;
      if (cmdName === 'section') return true;
      if (numMode === 'on' && cmdName === 'section_star') return true;
      return false;
    }
    /* V3.415 — the preview look of a special section: the catalog
     * entry's `preview` hint, else the section's own special_render. */
    function specialPreview(sec) {
      if (!sec.special) return null;
      var list = tpl.special_sections || [];
      for (var i = 0; i < list.length; i++) {
        if (list[i] && list[i].key === sec.special) return list[i].preview || 'heading';
      }
      return sec.special_render || 'heading';
    }
    tree.sections.forEach(function (sec) {
      if (factSecs.indexOf(sec) >= 0) return;
      /* The first section flagged `appendix` opens the appendix zone —
       * section letters switch to A, B, … (reset once at the switch). */
      if (sec.appendix && !inAppendix) {
        inAppendix = true; secCounter = 0; subCounter = 0; subsubCounter = 0;
      }
      /* V3.415 — command resolution mirrors the exporter EXACTLY
       * (special-first + the object vocabulary) via the shared
       * PaperExportTex.resolveSectionCommand; the legacy string switch
       * below keys on the normalized object. */
      var cmdObj = (window.PaperExportTex && window.PaperExportTex.resolveSectionCommand)
        ? window.PaperExportTex.resolveSectionCommand(sec, tpl)
        : { type: (kindCmd.hasOwnProperty(sec.kind) ? null : 'section') };
      var cmd = kindCmd.hasOwnProperty(sec.kind) ? kindCmd[sec.kind] : 'section';
      if (cmdObj && cmdObj.type) {
        /* Map the object back onto the walker's dispatch vocabulary. */
        if (cmdObj.type === 'skip') cmd = 'skip';
        else if (cmdObj.type === 'bare') cmd = 'bare';   // V3.907 — body, no heading
        else if (cmdObj.type === 'keywords') cmd = 'keywords_placeholder';
        else if (cmdObj.type === 'env' && cmdObj.name === 'abstract') cmd = 'abstract_env';
        else if (cmdObj.type === 'placeholder' && cmdObj.token === '{{ABSTRACT}}') cmd = 'abstract_placeholder';
        else if (cmdObj.type === 'section') cmd = 'section';
        else cmd = 'section_star';   // env/macro/placeholder/box/section_star → unnumbered
      }
      if (cmd === 'skip') return;
      var label = sec.label || defLabels[sec.kind] || sec.kind;

      /* V3.415 — boxed special sections (PNAS Significance & friends)
       * render as a callout at their flow position. */
      if (specialPreview(sec) === 'box') {
        var callout = document.createElement('div');
        callout.className = 'pdv-significance';
        callout.dataset.sectionId = sec.id;
        var boxBody = sec.children
          .filter(function (b) { return b.kind === 'paragraph' && String(b.body || '').trim(); })
          .map(function (b) { return '<p class="pdv-para">' + pe.renderParagraphHtml(b.body) + '</p>'; })
          .join('');
        callout.innerHTML =
          '<div class="pdv-significance-head">' + _esc(label) + '</div>' +
          (boxBody || '<p class="pdv-para"><span class="pdv-draft">nothing here yet</span></p>');
        push(callout, 'col', 'special', sec.id);
        return;
      }

      if (cmd === 'abstract_env' || cmd === 'abstract_placeholder') {
        var abs = document.createElement('div');
        abs.className = 'pdv-abstract' + (geom.abstractRunIn ? ' pdv-abstract-runin' : '');
        var absBody = sec.children
          .filter(function (b) { return b.kind === 'paragraph' && String(b.body || '').trim(); })
          .map(function (b) { return '<p class="pdv-para">' + pe.renderParagraphHtml(b.body) + '</p>'; })
          .join('');
        if (LOOK) {
          /* V3.907 — the look's abstract: its own label (or none), run-in
           * or as a heading; width/size from the look CSS. */
          var la = LOOK.abstract || {};
          var body0 = absBody || '<p class="pdv-para"><span class="pdv-draft">no abstract yet</span></p>';
          if (la.label && la.label_style === 'runin') {
            /* IEEE: "Abstract—" bold italic, run straight into the text */
            var labHtml = '<b>' + (la.label_italic ? '<i>' + _esc(la.label) + '</i>' : _esc(la.label)) + '</b>' +
              (la.label_sep != null ? _esc(la.label_sep) : '&ensp;');
            body0 = body0.replace(/^<p class="pdv-para">/, '<p class="pdv-para">' + labHtml);
          } else if (la.label) {
            body0 = '<div class="pdv-abstract-head">' + _esc(la.label) + '</div>' + body0;
          }
          abs.innerHTML = body0;
        } else
        abs.innerHTML = geom.abstractRunIn
          ? '<p class="pdv-para"><i><b>Abstract</b></i>—' + (absBody ? absBody.replace(/^<p class="pdv-para">/, '').replace(/<\/p>$/, '') : '<span class="pdv-draft">no abstract yet</span>') + '</p>'
          : '<div class="pdv-abstract-head">Abstract</div>' + (absBody || '<p class="pdv-para"><span class="pdv-draft">no abstract yet</span></p>');
        /* Published 2-col journals run a full-width abstract above the
         * columns; IEEE keeps its in-column run-in. */
        /* a look may set the abstract in the first column (PNAS) instead
         * of across both */
        var absSpan = LOOK ? ((LOOK.abstract || {}).mode !== 'column' && geom.cols === 2) : (geom.cols === 2 && !geom.abstractRunIn);
        push(abs, absSpan ? 'full' : 'col', 'abstract', sec.id);
        return;
      }
      if (cmd === 'keywords_placeholder') {
        var kwText = sec.children
          .filter(function (b) { return b.kind === 'paragraph'; })
          .map(function (b) { return String(b.body || '').trim(); })
          .filter(Boolean).join(', ');
        if (kwText && !(LOOK && LOOK.keywords && LOOK.keywords.show === false)) {
          var kw = document.createElement('p');
          kw.className = 'pdv-keywords';
          /* a look names its own label (none in PNAS) */
          var kwL = (LOOK && LOOK.keywords) || {};
          var kwLabel = LOOK ? kwL.label : 'Keywords:';
          kw.innerHTML = (kwLabel ? '<b>' + (kwL.label_italic ? '<i>' + _esc(kwLabel) + '</i>' : _esc(kwLabel)) + '</b>' +
            (kwL.label_sep != null ? _esc(kwL.label_sep) : ' ') : '') + _esc(kwText);
          /* under a look the keywords sit with the abstract (the front box
           * spans both columns unless the abstract is set in column 1) */
          var kwSpan = LOOK && geom.cols === 2 && (LOOK.abstract || {}).mode !== 'column';
          push(kw, kwSpan ? 'full' : 'col', 'keywords', sec.id);
        }
        return;
      }

      /* V3.907 — a section the look sets in its own type (Nature's
       * small-print Methods): every node of it carries the style class. */
      var secStyleKey = null;
      if (LOOK && LOOK.section_styles && window.PaperLook.sectionStyle(LOOK, sec)) {
        secStyleKey = (sec.special && LOOK.section_styles[sec.special]) ? sec.special : sec.kind;
      }
      var pushSec = function (node, type, kind, sid, bid, fl) {
        if (secStyleKey && node && node.classList && kind !== 'figure' && kind !== 'table') node.classList.add('pdv-secstyle-' + secStyleKey);
        push(node, type, kind, sid, bid, fl);
      };
      /* Regular heading — numbered per the sectionNumbering mode + the
       * section's resolved command. Sub-counters reset at each new
       * numbered section. */
      var head = document.createElement('div');
      head.className = 'pdv-heading';
      head.dataset.sectionId = sec.id || '';   // V3.415 — R8 click target
      sectionNumbered = cmd !== 'bare' && sectionGetsNumber(cmd);
      /* V3.909 — a section the class opens with a run-in label instead of
       * a heading (PNAS: "ACKNOWLEDGMENTS." in bold sans, then small text) */
      var secRunHead = secStyleKey && LOOK.section_styles[secStyleKey].runin_head;
      if (cmd === 'bare' || secRunHead) {
        head = null;
      } else if (sectionNumbered) {
        secCounter++; subCounter = 0; subsubCounter = 0;
        var secNumStr = fmtSectionNum(numStyle, secCounter, inAppendix);
        head.innerHTML = '<span class="pdv-heading-num">' + _esc(secNumStr) + '</span> ' + _esc(label);
        if (sec.ref_label) secRefNums[sec.ref_label] = _refNum(secNumStr);
      } else {
        head.textContent = label;
      }
      if (head) push(head, 'col', 'heading', sec.id);

      var prevBlk = null;
      /* V3.908 — indentation is decided HERE, not by CSS adjacency (the
       * typesetter measures each paragraph on its own): the first paragraph
       * after a heading is not indented (titlesec's \titlespacing* — the
       * exporter's rule), nor is text continuing around a display. */
      var afterHeading = !!head && !(LOOK && LOOK.indent_after_heading);   // IEEE indents the first paragraph
      /* A run-in subheading (look h2/h3 `runin`, e.g. Nature's Methods)
       * opens the first line of the paragraph after it, as in the PDF. */
      var pendingRunIn = null;
      var secLook = secStyleKey ? LOOK.section_styles[secStyleKey] : null;
      var secFirstMargin = null;
      if (secRunHead) {
        var rh = secRunHead;
        pendingRunIn = { html: '<span class="pdv-runin pts-atom" style="' + window.PaperLook.inlineCss(LOOK, rh) +
          'padding-right:' + ((rh.gap || 0) * 4 / 3).toFixed(2) + 'px">' + _esc(rh.text || label) + '</span>', el: null, blk: null };
        // the class's \vskip before it, from the last body baseline
        var bodyS = { family: 'text', size: LOOK.body.size, lead: LOOK.body.lead };
        var secS = { family: secLook.family || 'text', size: secLook.size || LOOK.body.size, lead: secLook.lead || LOOK.body.lead };
        secFirstMargin = window.PaperLook.texGap(LOOK, bodyS, secS, secLook.before || 0) * 4 / 3;
      }
      function runInStyle(lvl) {
        if (!LOOK) return null;
        var h = (secLook && secLook['h' + lvl]) || LOOK['h' + lvl];
        return h && h.runin ? h : null;
      }
      sec.children.forEach(function (blk) {
        /* V3.906 — how this block joins the one before it (shared with the
         * exporter): text continuing a sentence around a display equation
         * is not a new paragraph — no indent, no paragraph space. */
        var join = (window.PaperLayout && window.PaperLayout.blockJoin) ? window.PaperLayout.blockJoin(prevBlk, blk) : 'par';
        if (String(blk.body || '').trim() || blk.kind === 'figure' || blk.kind === 'table') prevBlk = blk;
        /* Subheadings are headings in the flow (\subsection /
         * \subsubsection), numbered under the current section. */
        if (blk.kind === 'subheading') {
          var lvl = (blk.attrs && blk.attrs.level === 3) ? 3 : 2;
          var subEl = document.createElement('div');
          subEl.className = 'pdv-subheading pdv-subheading-l' + lvl;
          subEl.dataset.blockId = blk.id || '';
          var numStr = '';
          if (sectionNumbered) {
            if (lvl === 2) { subCounter++; subsubCounter = 0; numStr = fmtSubNum(numStyle, secCounter, subCounter, inAppendix); }
            else { subsubCounter++; numStr = fmtSubsubNum(numStyle, secCounter, subCounter, subsubCounter, inAppendix); }
          }
          if (numStr && blk.attrs && blk.attrs.ref_label) secRefNums[blk.attrs.ref_label] = _refNum(numStr);
          subEl.innerHTML = (numStr ? '<span class="pdv-heading-num">' + _esc(numStr) + '</span> ' : '') +
            pe.renderParagraphHtml(blk.body || '');
          var ri = runInStyle(lvl);
          if (ri) {
            var sepRi = ri.runin_sep == null ? '.' : ri.runin_sep;
            var txt = subEl.innerHTML.replace(/\s+$/, '');
            pendingRunIn = { html: '<span class="pdv-runin" data-block-id="' + _esc(blk.id || '') + '" style="font-weight:' +
              (ri.weight === 'bold' ? 700 : 400) + ';font-style:' + (ri.style === 'italic' ? 'italic' : 'normal') + '">' +
              txt + (sepRi && !/[.:?!]$/.test(subEl.textContent.trim()) ? _esc(sepRi) : '') + '</span> ', el: subEl, blk: blk };
            return;
          }
          pushSec(subEl, 'col', 'subheading', sec.id, blk.id);
          afterHeading = true;
          return;
        }
        /* Lists (itemize / enumerate) — body is one item per line, leading
         * spaces nest. Rendered as a real <ul>/<ol>, packed as one item. */
        if (blk.kind === 'list') {
          var listEl = document.createElement('div');
          listEl.className = 'pdv-list-block pdv-density-body';   // V3.486 — grant line density applies to body lists
          listEl.dataset.blockId = blk.id || '';
          listEl.innerHTML = _listHtml(blk.body || '', (blk.attrs && blk.attrs.list_type) || 'bullet');
          pushSec(listEl, 'col', 'list', sec.id, blk.id);
          return;
        }
        var node = _buildBlockNode(blk, tpl, geom, nums);
        if (!node) return;
        if (join === 'continue' && node.el.classList) node.el.classList.add('pdv-para-cont', 'pdv-after-display');
        if (join === 'attach' && node.el.classList) node.el.classList.add('pdv-eq-attached');
        var isPara = node.el.classList && node.el.classList.contains('pdv-bodypara');
        if (pendingRunIn) {
          if (isPara) {
            node.el.insertAdjacentHTML('afterbegin', pendingRunIn.html);
            node.el.classList.add('pdv-noindent', 'pdv-has-runin');
            if (secFirstMargin != null) { node.el.style.marginTop = secFirstMargin.toFixed(2) + 'px'; secFirstMargin = null; }
          } else if (pendingRunIn.el) {
            pushSec(pendingRunIn.el, 'col', 'subheading', sec.id, pendingRunIn.blk.id);
          }
          pendingRunIn = null;
        } else if (isPara && afterHeading) {
          node.el.classList.add('pdv-noindent');
        }
        if (blk.kind === 'paragraph' || blk.kind === 'equation' || blk.kind === 'list') afterHeading = false;
        pushSec(node.el, node.type, blk.kind, sec.id, blk.id, node.float || null);
        (node.more || []).forEach(function (m) { pushSec(m.el, m.type, m.kind, sec.id, blk.id); });   // V3.917
      });
      if (pendingRunIn && pendingRunIn.el) pushSec(pendingRunIn.el, 'col', 'subheading', sec.id, pendingRunIn.blk.id);
    });

    /* Bibliography (V3.911 — not in this document when the look makes the
     * references their own upload, NSF's References Cited). */
    var bib = (LOOK && LOOK.bib && LOOK.bib.where === 'separate' && !state.subdocRefs) ? null : _buildBibliography(tpl);
    /* V3.914 — a grant document with nothing in it yet */
    if (state.grantDoc && state.grantDoc !== 'project_description' && !state.subdocRefs &&
        !items.some(function (it) { return it.blockKind && it.blockKind !== 'title'; })) {
      var none = document.createElement('p');
      none.className = 'pdv-para pdv-empty-doc';
      none.textContent = 'This document has no section in the paper yet. Add it with + Add section in the editor, or upload its PDF on the Grant Docs page.';
      push(none, 'col', 'note');
    }
    if (bib) {
      var bibHead = document.createElement('div');
      bibHead.className = 'pdv-heading';
      bibHead.textContent = (LOOK && LOOK.bib && LOOK.bib.head != null) ? LOOK.bib.head : 'References';
      if (bibHead.textContent) push(bibHead, 'col', 'heading');   // some journals print no heading
      if (LOOK) {
        /* V3.908 — one item per reference, so the list flows across columns
         * and pages the way LaTeX's thebibliography does (one atomic block
         * jumped whole to the next page and left a hole). */
        Array.prototype.slice.call(bib.children).forEach(function (entry) {
          var one = document.createElement('div');
          one.className = bib.className + ' pdv-bib-one';
          one.appendChild(entry);
          push(one, 'col', 'bibentry');
        });
      } else {
        push(bib, 'col', 'bibliography');
      }
    }
    state.secRefNums = secRefNums;   // consumed by _resolveSecRefs post-mount
    return items;
  }

  /* V3.485 / V3.495 — corner/side wrap grouping (single-column only). A
   * figure rendered with data-anchor="wrap" is combined with just enough of
   * the flow blocks that follow it — text AND subheadings — into ONE
   * `.pdv-wrap-group` (a flow-root container) so the browser wraps the
   * running text around the floated figure, and _measureItems reads the
   * TRUE wrapped height (summing the figure and each paragraph separately
   * would double-count the column space beside the figure and break
   * pagination).
   *
   * V3.495 — page-fill fix. The group is trimmed to the FIGURE-CLEAR point:
   * we keep only the blocks that sit beside the figure (their top is above
   * the figure's bottom) and hand the rest back to the normal flow, which
   * fills the page full-width below the figure and paginates normally. This
   * (a) lets subheadings wrap beside the figure, and (b) stops the group
   * from swallowing a whole section into one atomic block — so text keeps
   * flowing to fill every page (grants/papers with page limits need every
   * line). The clear point is found by one throwaway probe measurement;
   * once images are decoded it is exact, and it self-corrects on the next
   * render if the first pass measured before decode.
   *
   * The group is still packed ATOMICALLY (blockKind 'wrap-group' is not
   * 'paragraph', so _packPages never splits it) — but because it is now
   * bounded to ≈ the figure height it fits on a page, so the atomic
   * constraint rarely strands space. Child block els keep their
   * data-block-id, so selection / [!ref] / cite-join / drag / resize keep
   * targeting the real figure and paragraphs. Two-column degrades to
   * in-flow (the figure never carries data-anchor="wrap" there), so no-op. */
  function _groupWrapFigures(items, geom) {
    if (geom.cols !== 1) return;
    var probe = state.probeEl;
    for (var i = 0; i < items.length; i++) {
      var it = items[i];
      if (it.blockKind !== 'figure' || it.float || !it.node ||
          !it.node.dataset || it.node.dataset.anchor !== 'wrap') continue;
      /* Candidate blocks: the following in-flow column blocks up to a hard
       * boundary (another float/full item, a new figure/table/bib/title, or
       * a section change). Headings/subheadings are NOT boundaries. */
      var cand = [];
      var j = i + 1;
      while (j < items.length) {
        var nx = items[j];
        if (nx.type === 'full' || nx.float) break;
        if (nx.sectionId !== it.sectionId) break;
        if (WRAP_STOP_KINDS[nx.blockKind]) break;
        cand.push(nx);
        j++;
      }
      var group = document.createElement('div');
      group.className = 'pdv-wrap-group';
      group.dataset.wrapSide = it.node.dataset.wrapSide || 'right';
      /* Copy the figure's measure-cache discriminators onto the group so a
       * resize (which changes the child figure's box % but can leave
       * innerHTML.length identical, e.g. "50%"→"80%") re-measures. */
      group.dataset.w = it.node.dataset.w || '';
      group.dataset.h = it.node.dataset.h || '';
      group.appendChild(it.node);                              // float first, in source order
      cand.forEach(function (c) { group.appendChild(c.node); });

      /* Find the figure-clear point: keep candidates whose top is above the
       * figure's bottom (they sit beside it); the first one that starts at
       * or below the figure bottom — and everything after — leaves the group
       * to flow full-width and fill the page. Default keep-all covers "the
       * figure is taller than all the remaining text". */
      var keep = cand.length;
      if (probe && cand.length) {
        var savedW = probe.style.width;
        probe.style.width = geom.colW + 'px';
        probe.appendChild(group);
        var figBox = it.node.querySelector('.pdv-fig-box');
        var gTop = group.getBoundingClientRect().top;
        var figBottom = figBox ? (figBox.getBoundingClientRect().bottom - gTop) : 0;
        for (var k = 0; k < cand.length; k++) {
          var cTop = cand[k].node.getBoundingClientRect().top - gTop;
          if (cTop >= figBottom - 1) { keep = k; break; }
        }
        probe.removeChild(group);
        probe.style.width = savedW;
      }
      if (keep < 1) keep = 1;   // always wrap at least the first block beside the figure

      /* Hand the below-the-figure blocks back to the normal flow. */
      var leave = cand.slice(keep);
      leave.forEach(function (c) { group.removeChild(c.node); });
      var kept = cand.slice(0, keep);
      var notes = it.footnotes.slice();
      kept.forEach(function (c) { notes = notes.concat(c.footnotes); });
      var groupItem = {
        node: group, type: 'col', h: 0, footnotes: notes,
        blockKind: 'wrap-group',
        sectionId: it.sectionId, blockId: it.blockId,   // target the figure for selection/drag
        float: null,
      };
      items.splice(i, 1 + kept.length, groupItem);   // leave[] stay as normal items after the group
      // i now indexes the group; the loop's i++ moves past it.
    }
  }

  /* Ref-friendly number: the displayed heading number without trailing
   * punctuation ("3." → "3", "A." → "A", "3.2" → "3.2"). */
  function _refNum(s) { return String(s || '').replace(/[.)]+$/, ''); }

  /* After mount, upgrade every [!sec:label] chip from its editor title to
   * the computed "Section N" using the numbers gathered during the walk.
   * Forward + backward refs both resolve because the map is complete. */
  function _resolveSecRefs() {
    var map = state.secRefNums || {};
    if (!state.scaleEl) return;
    state.scaleEl.querySelectorAll('.pe-secref-chip[data-secref-label]').forEach(function (chip) {
      var num = map[chip.dataset.secrefLabel];
      if (num) {
        chip.textContent = 'Section ' + num;
        chip.classList.remove('pe-secref-chip-unknown');
      }
    });
  }

  /* V3.453 — adjacent citation tokens ("[@a] [@b]") render as separate
   * .pe-cite-group spans joined by a bare space, and text-align: justify
   * stretches that space in narrow columns — Alex's "too much space
   * between numbers" from the second paragraph on (the wide first block
   * barely stretches). Post-mount, swap each whitespace-only text node
   * BETWEEN two cite groups for a fixed-width .pdv-cite-join span. Runs
   * after _mountSheets, so split-paragraph halves are final; the joiner
   * is ~one space wide, so measured heights stay valid. */
  function _joinAdjacentCites() {
    if (!state.scaleEl) return;
    state.scaleEl.querySelectorAll('.pdv-para').forEach(function (p) {
      var tw = document.createTreeWalker(p, NodeFilter.SHOW_TEXT);
      var swaps = [], node;
      while ((node = tw.nextNode())) {
        if (!/^\s+$/.test(node.nodeValue)) continue;
        var prev = node.previousSibling, next = node.nextSibling;
        if (prev && prev.nodeType === 1 && prev.classList.contains('pe-cite-group') &&
            next && next.nodeType === 1 && next.classList.contains('pe-cite-group')) {
          swaps.push(node);
        }
      }
      swaps.forEach(function (n) {
        var join = document.createElement('span');
        join.className = 'pdv-cite-join';
        n.parentNode.replaceChild(join, n);
      });
    });
  }

  function _buildTitleBlock(title) {
    var cfg = state.config || {};
    var wrap = document.createElement('div');
    wrap.className = 'pdv-titleblock';
    var html = '<div class="pdv-title">' + _esc(title || 'Untitled paper') + '</div>';
    var authors = Array.isArray(cfg.authors) ? cfg.authors : [];
    var affs = Array.isArray(cfg.affiliations) ? cfg.affiliations : [];
    if (authors.length) {
      html += '<div class="pdv-authors">' + authors.map(function (a) {
        var idx = [].concat(a.affiliationIdx != null ? a.affiliationIdx : [])   // V3.916 — a lone number too
          .map(function (i) { return i + 1; }).join(',');
        return _esc(a.name || '') +
          (idx ? '<sup>' + _esc(idx) + '</sup>' : '') +
          (a.corresponding ? '<sup>*</sup>' : '');
      }).join(', ') + '</div>';
      if (affs.length) {
        html += '<div class="pdv-affils">' + affs.map(function (t, i) {
          return '<div><sup>' + (i + 1) + '</sup> ' + _esc(t) + '</div>';
        }).join('') + '</div>';
      }
      var corr = authors.filter(function (a) { return a.corresponding && a.email; });
      if (corr.length) {
        html += '<div class="pdv-corr"><sup>*</sup> Correspondence: ' +
          corr.map(function (a) { return _esc(a.email); }).join(', ') + '</div>';
      }
    } else {
      var meta = (_pe().getPaperMeta && _pe().getPaperMeta()) || {};
      if (meta.lead_author) {
        html += '<div class="pdv-authors">' + _esc(meta.lead_author) + '</div>';
      }
      if (_pe().isEditable()) {
        html += '<div class="pdv-authors-hint">Add the author list + affiliations on the Export page — it renders here.</div>';
      }
    }
    wrap.innerHTML = html;
    return wrap;
  }

  /* "Figure 3." / "Fig. 3 " / "Table 1 |" — the look's caption label and
   * separator (the .tex sets the same via \figurename + labelsep). */
  function _captionLabel(geom, kind, num) {
    var c = geom.look && geom.look.caption;
    if (!c) return '<b>' + (kind === 'tab' ? 'Table' : 'Figure') + ' ' + num + '.</b> ';
    var lab = (kind === 'tab' ? c.label_tab : c.label_fig) + ' ' + num;
    var sep = c.sep == null ? '. ' : c.sep;
    var html = c.label_weight === 'bold' ? '<b>' + _esc(lab) + '</b>' : _esc(lab);
    return html + _esc(sep).replace(/ $/, '&#32;').replace(/^ /, '&#32;');
  }

  /* V3.907 — the journal look's front matter: the same pieces, marks and
   * order PaperLook.texAuthors writes into the .tex (superscript
   * affiliation numbers only when there is more than one affiliation, "*"
   * for the corresponding author, "&" before the last name when the look
   * says so). Affiliations go in the block, or — `where: 'footnote'` — into
   * a note the packer sets at the foot of page 1. */
  function _buildLookFront(title, look) {
    var cfg = state.config || {};
    var authors = (Array.isArray(cfg.authors) ? cfg.authors : []).filter(function (a) { return a && a.name; });
    var affs = Array.isArray(cfg.affiliations) ? cfg.affiliations : [];
    var many = affs.length > 1;
    var wrap = document.createElement('div');
    wrap.className = 'pdv-titleblock pdv-look-front';
    var html = (look.title && look.title.show === false) ? ''
      : '<div class="pdv-title">' + _pe().renderParagraphHtml(title || 'Untitled paper') + '</div>';
    /* V3.911 — a grant narrative names no authors */
    if (look.authors && look.authors.show === false) {
      wrap.innerHTML = html;
      return { block: wrap, note: null, colnote: null };
    }
    var names;
    if (authors.length) {
      var runs = authors.map(function (a) {
        var idx = (Array.isArray(a.affiliationIdx) ? a.affiliationIdx : (a.affiliationIdx != null ? [a.affiliationIdx] : []))
          .filter(function (i) { return affs[i] != null; }).map(function (i) { return i + 1; });
        var colNote = look.affiliations && look.affiliations.where === 'colnote';
        var marks = (many && !colNote) ? idx.map(String) : [];
        if (a.corresponding && !colNote && !(look.authors && look.authors.corresponding === false)) marks.push('*');
        return _esc(a.name) + (marks.length ? '<sup>' + marks.join(',') + '</sup>' : '');
      });
      names = runs.length > 1
        ? runs.slice(0, -1).join(', ') + ((look.authors && look.authors.and === '&') ? ' &amp; ' : ', and ') + runs[runs.length - 1]
        : runs[0];
    } else {
      var meta = (_pe().getPaperMeta && _pe().getPaperMeta()) || {};
      names = _esc(meta.lead_author || '');
    }
    html += '<div class="pdv-authors">' + names + '</div>';
    /* a class that prints the corresponding author elsewhere (PNAS's
     * fact box) says `authors.corresponding: false` */
    var corr = (look.authors && look.authors.corresponding === false) ? null
      : authors.filter(function (a) { return a.corresponding && a.email; })[0];
    var affLines = affs.map(function (t, i) { return (many ? '<sup>' + (i + 1) + '</sup>' : '') + _esc(t); });
    if (corr) affLines.push('<sup>*</sup>Correspondence: ' + _esc(corr.email));
    var note = null, colnote = null;
    var where = (look.affiliations && look.affiliations.where) || 'front';
    if (where === 'colnote' && affs.length) {
      /* IEEE: one first-page note at the foot of column 1, worded as the
       * exporter's \thanks ("The authors are with …; … (e-mail: …).") */
      var corrN = authors.filter(function (a) { return a.corresponding && a.email; })[0];
      colnote = document.createElement('div');
      colnote.className = 'pdv-affils pdv-affil-colnote';
      colnote.textContent = (look.affiliations.prefix != null ? look.affiliations.prefix : 'The authors are with ') +
        affs.join('; ') + (corrN ? ' (e-mail: ' + corrN.email + ')' : '') + '.';
    } else if (affLines.length) {
      if (where === 'footnote') {
        note = document.createElement('div');
        note.className = 'pdv-affils pdv-affil-note';
        note.innerHTML = affLines.join(' ');
      } else {
        /* `affiliations.inline` runs them on as one paragraph with that
         * separator (authblk's "; " in PNAS) */
        var inl = look.affiliations && look.affiliations.inline;
        html += '<div class="pdv-affils">' + (inl ? '<div>' + affLines.join(_esc(inl)) + '</div>'
          : affLines.map(function (l) { return '<div>' + l + '</div>'; }).join('')) + '</div>';
      }
    }
    wrap.innerHTML = html;
    return { block: wrap, note: note, colnote: colnote };
  }

  function _buildBlockNode(blk, tpl, geom, nums) {
    var pe = _pe();
    if (blk.kind === 'paragraph') {
      var body = String(blk.body || '').trim();
      if (!body) {
        var hasSkeleton = (blk.skeleton_items || []).some(function (it) { return String(it.text || '').trim(); }) ||
          String(blk.skeleton || '').trim();
        if (!hasSkeleton) return null;
        var d = document.createElement('p');
        d.className = 'pdv-para';
        d.innerHTML = '<span class="pdv-draft">· unwritten block (skeleton only) ·</span>';
        return { el: d, type: 'col' };
      }
      var p = document.createElement('p');
      p.className = 'pdv-para pdv-bodypara pdv-density-body';   // V3.486 — grant line density applies to body text
      /* V3.401 — flow items carry their block id so drag-drops can
       * resolve "insert before this paragraph". */
      p.dataset.blockId = blk.id || '';
      p.dataset.blockKind = 'paragraph';
      /* V3.910 — Tighten / Loosen from the layout check: \looseness */
      var lzA = blk.attrs && blk.attrs.looseness;
      if (lzA === -1 || lzA === 1) p.dataset.looseness = String(lzA);
      /* V3.649 — body lists render here too, or the journal preview would
       * print the raw "- item" lines the editor shows as a list. */
      /* V3.908 — under a journal look, inline formulas are split at the
       * points where TeX may break them (PaperTypeset.breakableMathText),
       * so the typesetter can break there too. */
      var srcBody = (geom.look && window.PaperTypeset && window.PaperTypeset.breakableMathText)
        ? window.PaperTypeset.breakableMathText(body) : body;
      /* V3.917 — a single line break inside a paragraph (hard-wrapped text
       * from a .tex or .md import) is a space, as LaTeX reads it in the
       * PDF; it was a <br> here, which the typesetter set as a line end with
       * no space ("adding the" / "ME3B" → "theME3B"). A blank line stays a
       * break. List lines keep their newlines (parseBodyRuns needs them). */
      function softBreaks(t) { return String(t).replace(/([^\n])\n(?=[^\n])/g, '$1 '); }
      /* V3.917 — a body with "- item" lines is prose, list, prose: each its
       * own page item, so the typesetter sets the prose like any paragraph
       * and never cuts lines through a list (it did: every cut line became
       * a bullet of its own, drawn over the next, with a stray hyphen), and
       * the page may break between them as LaTeX's itemize allows. Prose
       * after a list continues the paragraph — no indent, as in the PDF. */
      var PSr = window.PaperSchemas;
      if (PSr && PSr.bodyHasList && PSr.parseBodyRuns && PSr.bodyHasList(srcBody)) {
        var parts = PSr.parseBodyRuns(srcBody).map(function (run, ri) {
          if (run.type === 'list') {
            var lw = document.createElement('div');
            lw.className = 'pdv-list-block pdv-density-body';
            lw.dataset.blockId = blk.id || '';
            lw.innerHTML = _listItemsHtml(run.items, run.listType);
            return { el: lw, type: 'col', kind: 'list' };
          }
          var pp = ri === 0 ? p : document.createElement('p');
          if (ri) {
            pp.className = 'pdv-para pdv-bodypara pdv-density-body pdv-noindent pdv-para-cont';
            pp.dataset.blockId = blk.id || '';
            pp.dataset.blockKind = 'paragraph';
          }
          pp.innerHTML = pe.renderParagraphHtml(softBreaks(run.text));
          return { el: pp, type: 'col', kind: 'paragraph' };
        });
        if (parts.length) return { el: parts[0].el, type: 'col', more: parts.slice(1) };
      }
      p.innerHTML = (!PSr && pe.renderParagraphBodyHtml)   // no list parser loaded: the old renderer
        ? pe.renderParagraphBodyHtml(srcBody)
        : pe.renderParagraphHtml(softBreaks(srcBody));
      return { el: p, type: 'col' };
    }

    if (blk.kind === 'equation') {
      var attrs = blk.attrs || {};
      var src = String(blk.body || '').trim();
      if (!src) return null;
      /* V3.906 — the editor's and exporter's rule (`!!attrs.display`):
       * an equation block without the flag is INLINE. The preview used
       * `!== false`, so such a block was a display here and inline math
       * in the PDF. */
      var display = !!attrs.display;
      var el = document.createElement('div');
      if (!display) {
        el.className = 'pdv-para';
        el.innerHTML = pe.renderEquationHtml(src, false);
        return { el: el, type: 'col' };
      }
      el.className = 'pdv-eq';
      el.dataset.blockId = blk.id || '';
      el.dataset.blockKind = 'equation';
      /* V3.412 — optional page span (Alex: "many of these blocks would
       * be per column or spanning optional"). span='page' in a 2-col
       * layout breaks the column run and spans the text region ('full'
       * item — the title/abstract path); exports via cuted's strip.
       * Absent key = legacy = column-bound. */
      var eqSpan = attrs.span === 'page' ? 'page' : 'column';
      el.dataset.span = eqSpan;
      var num = (attrs.numbered && nums.eq[blk.id]) ? nums.eq[blk.id] : null;
      el.innerHTML =
        '<div class="pdv-eq-math">' + pe.renderEquationHtml(src, true) + '</div>' +
        (num ? '<span class="pdv-eq-num">(' + num + ')</span>' : '');
      return { el: el, type: (eqSpan === 'page' && geom.cols === 2) ? 'full' : 'col' };
    }

    if (blk.kind === 'figure') {
      var fa = blk.attrs || {};
      var defaultWidth = (tpl.figure_environment && tpl.figure_environment.default_width) || '0.9\\linewidth';
      /* V3.395 — anchored blocks derive their effective width through
       * PaperLayout (span='page' → \textwidth) so the preview matches
       * exactly what the exporter will emit. */
      var widthSpec = fa.width;
      if (typeof fa.anchor === 'string' && fa.anchor &&
          window.PaperLayout && window.PaperLayout.resolveWidth) {
        widthSpec = window.PaperLayout.resolveWidth(fa, tpl);
      }
      var w = parseWidth(widthSpec, defaultWidth);
      var type, pct;
      if (w.base === 'absolute') {
        /* Absolute width (e.g. 89mm): wider than a column → spans the
         * page in 2-col layouts; else a fraction of the column. */
        var spansPage = geom.cols === 2 && w.absPx > geom.colW * 1.02;
        type = spansPage ? 'full' : 'col';
        var containerW = spansPage ? geom.bodyW : geom.colW;
        pct = Math.max(5, Math.min(100, Math.round(w.absPx / containerW * 100)));
      } else {
        type = (w.base === 'page' && geom.cols === 2) ? 'full' : 'col';
        pct = Math.round(w.frac * 100);
      }
      /* V3.397 — float classification. anchor 'flow' (or legacy absent)
       * keeps today's in-flow behavior; top/bottom/float-page divert the
       * item to a page band in _packPages. span mirrors the measured
       * container so band slots get the width the item was measured at. */
      /* V3.485 — corner/side wrap: single-column only. `wrap` is NOT a
       * band region (not in FLOAT_REGIONS), so it must be recognized
       * BEFORE the unknown-anchor coercion below, and it never sets
       * figFloat (no band diversion) — instead _groupWrapFigures wraps it
       * plus the following paragraphs into one flow-root group so text
       * flows around it. In a two-column layout it degrades to in-flow. */
      var isWrap = fa.anchor === 'wrap' && geom.cols === 1;
      var anchorVal = (typeof fa.anchor === 'string' && fa.anchor) ? fa.anchor : 'flow';
      if (isWrap) anchorVal = 'wrap';
      else if (!FLOAT_REGIONS[anchorVal]) anchorVal = 'flow';   // unknown value (incl. wrap in 2-col) → in-flow
      var figFloat = (anchorVal !== 'flow' && anchorVal !== 'wrap')
        ? { region: anchorVal, span: type === 'full' ? 'page' : 'column', lock: fa.lock === true,
            spacing: (typeof fa.spacing === 'number' && isFinite(fa.spacing)) ? fa.spacing : 0 }  // V3.410
        : null;
      /* V3.908 — under a journal look the PDF floats an unanchored figure
       * ([tbp]): top of the current column/page, else its bottom, else a
       * later page. The preview follows instead of drawing it in place. */
      if (!figFloat && anchorVal === 'flow' && geom.look) {
        figFloat = { region: 'auto', span: type === 'full' ? 'page' : 'column', lock: false,
          spacing: (typeof fa.spacing === 'number' && isFinite(fa.spacing)) ? fa.spacing : 0 };
      }
      var fig = document.createElement('figure');
      fig.className = 'pdv-figure';
      fig.dataset.blockId = blk.id || '';
      fig.dataset.blockKind = 'figure';
      fig.dataset.anchor = anchorVal;
      if (isWrap) {
        fig.dataset.wrapSide = (fa.wrap_side === 'left') ? 'left' : 'right';
        /* V3.912 — under a look the paginator places it the way wrapfig
         * does (a box beside the next N lines), not a CSS float */
        if (geom.look) fig.classList.add('pdv-wrapfig-tex');
        /* The floated FIGURE carries the % width so it claims only pct% of
         * the column; the box inside fills it (100%). */
        fig.style.width = pct + '%';
      }
      fig.dataset.span = type === 'full' ? 'page' : 'column';
      fig.dataset.w = String(pct);   // V3.402 — measure-cache discriminator
                                     // (same-length pct changes must not alias)
      var centered = fa.centering !== false;
      /* V3.405 — the figure BOX model. Image + caption are sub-blocks of
       * one sized box (.pdv-fig-box, pct% of the container). The image
       * auto-fits via the shared PaperFigFit.fit(): maximized within the
       * box width and the optional max_h image-height cap (mm; absent =
       * unconstrained = today's width-bound render, byte-identical).
       * When height-bound the image letterboxes (centered, narrower than
       * the box); the caption always spans the box. */
      var maxHCap = (typeof fa.max_h === 'number' && fa.max_h > 0) ? Math.round(fa.max_h) : null;
      /* V3.907 — the look's page-fit cap (artwork + caption must fit the
       * text area; PaperLook.figureMaxHeight, the exporter's rule). mm. */
      if (geom.look && window.PaperLook) {
        var capBp = window.PaperLook.figureMaxHeight(geom.look, String(blk.body || fa.caption || ''), type === 'full' || geom.cols === 1);
        var capMm = Math.floor(capBp * 25.4 / 72);
        if (!maxHCap || capMm < maxHCap) maxHCap = capMm;
      }
      fig.dataset.h = maxHCap ? String(maxHCap) : '';  // measure-cache discriminator (aliasing bug class)
      var cache = fa.download_url ? state.imgSizeCache[fa.download_url] : null;
      var aspect = (cache && cache.w > 0 && cache.h > 0) ? cache.w / cache.h : null;
      fig.dataset.ar = aspect ? String(Math.round(aspect * 10000) / 10000) : '';
      var imgHtml;
      if (fa.download_url) {
        var boxWpx = pct / 100 * (type === 'full' ? geom.bodyW : geom.colW);
        var fitRes = (aspect && window.PaperFigFit)
          ? window.PaperFigFit.fit({ boxWpx: boxWpx, maxHmm: maxHCap, aspect: aspect })
          : null;
        var imgStyle;
        if (fitRes && fitRes.imgHpx != null) {
          /* Explicit px from the shared fit — deterministic for the
           * measure pass, exact for the resize chip. */
          imgStyle = 'width:' + (Math.round(fitRes.imgWpx * 10) / 10) + 'px;' +
                     'height:' + (Math.round(fitRes.imgHpx * 10) / 10) + 'px;' +
                     'max-width:100%;margin:0 auto;';
        } else {
          /* Aspect unknown (not decoded yet): width-bound CSS fallback. */
          imgStyle = cache ? 'aspect-ratio:' + cache.w + '/' + cache.h + ';' : '';
        }
        imgHtml = '<img src="' + _esc(fa.download_url) + '" alt="' + _esc(fa.alt || '') + '"' +
                  (imgStyle ? ' style="' + imgStyle + '"' : '') + '>';
      } else {
        imgHtml = '<div class="pdv-fig-missing">' + _esc(fa.alt || 'figure image not uploaded yet') + '</div>';
      }
      var num = (fa.numbered !== false && nums.fig[blk.id]) ? nums.fig[blk.id] : null;
      var captionSrc = String(blk.body || fa.caption || '').trim();
      /* V3.485 — a wrap figure's box fills the floated figure (100%); the
       * figure element itself carries the pct% width set above. */
      var boxWidthCss = isWrap ? '100%' : (pct + '%');
      var boxMarginCss = (isWrap || !centered) ? 'margin:0;' : 'margin:0 auto;';
      var capHtml = (captionSrc || num)
        ? '<figcaption class="pdv-figcap">' +
          (num ? _captionLabel(geom, 'fig', num) : '') +
          pe.renderParagraphHtml(captionSrc) + '</figcaption>'
        : '';
      /* V3.906 — journals run a caption across the whole column (or page,
       * for a spanning figure) however narrow the artwork is; the export
       * does the same. caption_fit:'box' keeps the old caption-under-the-
       * image box (a minipage in the .tex). Wrap figures keep it boxed. */
      var capInBox = isWrap || fa.caption_fit === 'box';
      fig.innerHTML =
        '<div class="pdv-fig-box" style="width:' + boxWidthCss + ';' + boxMarginCss + '">' +
        '<div class="pdv-fig-imgwrap">' + imgHtml + '</div>' +
        (capInBox ? capHtml : '') +
        '</div>' + (capInBox ? '' : capHtml);
      if (_pe().isEditable()) fig.title = 'Click to adjust layout (anchor / span / width / lock)';
      return { el: fig, type: type, float: figFloat };
    }

    if (blk.kind === 'table') {
      var ta = blk.attrs || {};
      /* V3.397 — same float classification as figures (tables are
       * anchor + span only; no width resize). span='page' in a 2-col
       * journal measures at body width like other 'full' items. */
      var tAnchor = (typeof ta.anchor === 'string' && ta.anchor) ? ta.anchor : 'flow';
      if (!FLOAT_REGIONS[tAnchor]) tAnchor = 'flow';       // unknown value → in-flow
      var tType = (ta.span === 'page' && geom.cols === 2) ? 'full' : 'col';
      var tFloat = tAnchor !== 'flow'
        ? { region: tAnchor, span: tType === 'full' ? 'page' : 'column', lock: ta.lock === true,
            spacing: (typeof ta.spacing === 'number' && isFinite(ta.spacing)) ? ta.spacing : 0 }  // V3.410
        : (geom.look ? { region: 'auto', span: tType === 'full' ? 'page' : 'column', lock: false,   // V3.908 — [tbp]
            spacing: (typeof ta.spacing === 'number' && isFinite(ta.spacing)) ? ta.spacing : 0 } : null);
      var el2 = document.createElement('div');
      el2.className = 'pdv-table-wrap';
      el2.dataset.blockId = blk.id || '';
      el2.dataset.blockKind = 'table';
      el2.dataset.anchor = tAnchor;
      el2.dataset.span = tType === 'full' ? 'page' : 'column';
      var rows = parseInt(ta.rows, 10) || 0;
      var cols = parseInt(ta.cols, 10) || 0;
      var cells = ta.cells || {};
      var align = String(ta.align || '');
      var booktabs = ta.booktabs !== false &&
        !(tpl.table_environment && tpl.table_environment.use_booktabs === false);
      var headerRow = ta.header_row !== false;
      /* V3.915 — a table imported as LaTeX (attrs.raw_tex, no cells): the
       * PDF sets that LaTeX, so the page shows its rows, rules and
       * caption instead of an empty "Table 1." */
      var rawTab = (!rows && ta.raw_tex && window.PaperProseTex)
        ? window.PaperProseTex.parseTabular(ta.raw_tex) : null;
      if (rawTab && rawTab.rows.length) {
        rows = rawTab.rows.length;
        cols = 0;
        cells = {};
        rawTab.rows.forEach(function (r, ri) {
          var cc = 0;
          r.forEach(function (cell) { cells[ri + '-' + cc] = cell.text; cc += cell.span; });
          cols = Math.max(cols, cc);
        });
        align = rawTab.align;
        headerRow = rawTab.header;
      } else rawTab = null;
      /* Tables II — merged cells + per-column widths (scalar attrs,
       * parsed via the shared PaperLayout helpers; absent = legacy). */
      var PLt = window.PaperLayout || {};
      var tMerges = PLt.parseTableMerges ? PLt.parseTableMerges(ta.merges_json) : {};
      var tCover = PLt.tableCoverMap ? PLt.tableCoverMap(tMerges, rows, cols) : { anchors: {}, skip: {}, cont: {} };
      var tWidths = PLt.parseTableWidths ? PLt.parseTableWidths(ta.widths_json, cols) : null;
      /* V3.651 — table styling, from the same shared parse the editor and
       * the .tex export read, so the journal-page preview shows the rules,
       * striping, row height, font size and per-cell formatting that will
       * actually compile. */
      var tSt = PLt.parseTableStyle ? PLt.parseTableStyle(ta.style_json, ta.booktabs) : null;
      var tCellSt = PLt.parseTableCellStyles ? PLt.parseTableCellStyles(ta.cell_styles_json) : {};
      var tFills = PLt.TABLE_FILLS || {};
      var tRowExt = PLt.parseTableRowExtras
        ? PLt.parseTableRowExtras(ta.row_heights_json) : {};
      var tCls = 'pdv-table' + (booktabs ? ' pdv-booktabs' : ' pdv-grid');
      var tStyleAttr = '';
      if (tSt) {
        tCls += ' pdv-tbl-rules-' + tSt.rules + ' pdv-tbl-dens-' + tSt.density +
          (tSt.zebra ? ' pdv-tbl-zebra' : '') + (tSt.wrap ? ' pdv-tbl-wrap' : '');
        if (tSt.sizeCss !== 1) tStyleAttr = ' style="font-size:' + (tSt.sizeCss * 100).toFixed(0) + '%"';
      }
      if (rawTab && rawTab.small && !tStyleAttr) tStyleAttr = ' style="font-size:90%"';   // \small
      var html = '<table class="' + tCls + '"' + tStyleAttr + '>';
      /* V3.652 — a wrapping table is table-layout:fixed, which needs a
       * width on every column; the shares match the .tex exactly. */
      var tShares = (tSt && tSt.wrap && PLt.tableColShares)
        ? PLt.tableColShares(tWidths, cols) : tWidths;
      var anyWidth = tShares && tShares.some(function (w) { return w.mode !== 'auto'; });
      if (anyWidth) {
        html += '<colgroup>';
        for (var wc = 0; wc < cols; wc++) {
          var w = tShares[wc];
          if (w.mode === 'frac') html += '<col style="width:' + (w.v * 100).toFixed(1) + '%">';
          else if (w.mode === 'mm') html += '<col style="width:' + (w.v * 96 / 25.4).toFixed(0) + 'px">';
          else html += '<col>';
        }
        html += '</colgroup>';
      }
      for (var r = 0; r < rows; r++) {
        var trCls = [];
        if (headerRow && r === 0) trCls.push('pdv-thead');
        if (r === 0) trCls.push('pdv-tbl-r-first');
        if (r === rows - 1) trCls.push('pdv-tbl-r-last');
        if (tSt && tSt.rule_after.indexOf(r) !== -1) trCls.push('pdv-tbl-ruled');
        if (rawTab && r > 0 && rawTab.rulesAfter.indexOf(r) !== -1) trCls.push('pdv-tbl-ruled');
        if (tSt && tSt.zebra && r % 2 === 1) trCls.push('pdv-tbl-zebrarow');
        var trStyle = '';
        if (tRowExt[r] > 0) {
          trCls.push('pdv-tbl-rowext');
          trStyle = ' style="--pdv-row-extra:' + (tRowExt[r] * 96 / 72).toFixed(1) + 'px"';
        }
        html += '<tr' + (trCls.length ? ' class="' + trCls.join(' ') + '"' : '') + trStyle + '>';
        for (var c = 0; c < cols; c++) {
          var key = r + '-' + c;
          if (tCover.skip[key] || tCover.cont[key] != null) continue;   // merged away
          var v = cells[key];
          var cSt = tCellSt[key] || {};
          var aCh = cSt.al || align.charAt(c);
          var a = aCh === 'c' ? 'center' : aCh === 'r' ? 'right' : 'left';
          var anchor = tCover.anchors[key];
          var spanAttrs = anchor
            ? (anchor.cs > 1 ? ' colspan="' + anchor.cs + '"' : '') +
              (anchor.rs > 1 ? ' rowspan="' + anchor.rs + '"' : '')
            : '';
          var tdCss = 'text-align:' + a;
          if (cSt.b) tdCss += ';font-weight:700';
          if (cSt.i) tdCss += ';font-style:italic';
          var tdCls = '';
          if (cSt.bg && tFills[cSt.bg]) {
            tdCss += ';background:' + tFills[cSt.bg].css;
            tdCls = ' class="pdv-cell-filled"';
          }
          /* V3.906 — cells are prose (math, citations, refs, **bold**),
           * the same inline contract the .tex export now applies. */
          html += '<td' + spanAttrs + tdCls + ' style="' + tdCss + '">' +
            (v == null || v === '' ? '' : _pe().renderParagraphHtml(String(v))) + '</td>';
        }
        html += '</tr>';
      }
      html += '</table>';
      var tnum = (ta.numbered !== false && nums.tab[blk.id]) ? nums.tab[blk.id] : null;
      var tcap = String(ta.caption || '').trim() || (rawTab ? rawTab.caption : '');
      if (tcap || tnum) {
        html += '<div class="pdv-tabcap">' + (tnum ? _captionLabel(geom, 'tab', tnum) : '') +
          _pe().renderParagraphHtml(tcap) + '</div>';
      }
      /* Tables II — table notes under the caption (threeparttable look). */
      var tNotes = String(ta.notes || '').split('\n')
        .map(function (s) { return s.trim(); }).filter(Boolean);
      if (tNotes.length) {
        html += '<div class="pdv-tabnotes">' + tNotes.map(function (n) {
          return '<div>' + _pe().renderParagraphHtml(n) + '</div>';
        }).join('') + '</div>';
      }
      el2.innerHTML = html;
      return { el: el2, type: tType, float: tFloat };
    }
    return null;
  }

  /* One author → "A. B. Surname" (initials-first, IEEE/Science) or
   * "Surname, A. B." (surname-first, Nature/APA), from {family, given}. */
  function _authorName(a, initialsFirst) {
    var fam = String((a && a.family) || '').trim();
    var giv = String((a && a.given) || '').trim();
    var initials = giv
      ? giv.split(/[\s.]+/).filter(Boolean).map(function (g) {
          return g.charAt(0).toUpperCase() + '.';
        }).join(' ')
      : '';
    if (initialsFirst) return (initials ? initials + ' ' : '') + fam;
    return fam + (initials ? ', ' + initials : '');
  }

  /* Escaped, journal-joined author list. opts: {initialsFirst, lastSep,
   * etAlAfter}. Falls back to the flat `authors` strings when the richer
   * `authorsFull` isn't present. */
  function _authorList(entry, opts) {
    var list = (entry.authorsFull && entry.authorsFull.length)
      ? entry.authorsFull
      : (entry.authors || []).map(function (n) { return { family: n, given: '' }; });
    /* V3.911 — no authors (a statute, a web page): BibTeX prints none,
     * never the citation key */
    if (!list.length) return _esc(entry.firstAuthor || '');
    var total = entry.authorCount || list.length;
    var cap = opts.etAlAfter || 99;
    var shown = list.slice(0, cap).map(function (a) { return _esc(_authorName(a, opts.initialsFirst)); });
    if (total > shown.length) return shown.join(', ') + ', et al.';
    if (shown.length === 1) return shown[0];
    return shown.slice(0, -1).join(', ') + ' ' + (opts.lastSep || '&') + ' ' + shown[shown.length - 1];
  }

  /* V3.914 — natbib's unsrtnat.bst, as the PDF sets it: every author as
   * stored ("A, B, and C"), the title in BibTeX's sentence case, the
   * journal in italics with volume (number):pages and year, then the DOI. */
  function _sentenceCase(t) {
    var out = '', after = true;
    for (var i = 0; i < t.length; i++) {
      var c = t.charAt(i);
      out += after ? c : c.toLowerCase();
      if (/[A-Za-z0-9]/.test(c)) after = false;
      if (c === ':' && t.charAt(i + 1) === ' ') {   // BibTeX keeps the letter after ": "
        out += ' '; i++;
        after = true;
      }
    }
    return out;
  }
  function _formatUnsrtnat(entry, number, family) {
    function dec(x) { var t = document.createElement('textarea'); t.innerHTML = String(x || ''); return t.value; }
    var list = (entry.authorsFull && entry.authorsFull.length) ? entry.authorsFull
      : (entry.authors || []).map(function (n) { return { family: n, given: '' }; });
    var names = list.map(function (a) { return _esc(((a.given ? a.given + ' ' : '') + (a.family || '')).trim()); }).filter(Boolean);
    var au = names.length > 2 ? names.slice(0, -1).join(', ') + ', and ' + names[names.length - 1]
      : names.join(' and ');
    var blocks = [];
    if (au) blocks.push(au);
    var title = dec(entry.title).trim().replace(/\.$/, '');
    if (title) blocks.push(_esc(_sentenceCase(title)));
    var j = dec(entry.journal).trim();
    var vol = String(entry.volume || '').trim(), iss = String(entry.issue || '').trim();
    var pages = String(entry.pages || '').trim().replace(/-+/g, '\u2013');
    var vnp = vol + (iss ? ' (' + iss + ')' : '') + (pages ? (vol || iss ? ':' : 'pages ') + pages : '');
    var pub = [j ? '<i>' + _esc(j) + '</i>' : '', _esc(vnp), _esc(entry.year ? String(entry.year) : '')].filter(Boolean).join(', ');
    if (pub) blocks.push(pub);
    if (entry.doi) blocks.push('doi: ' + _esc(entry.doi));
    var html = blocks.map(function (b) { return /[.?!]$/.test(b.replace(/<[^>]+>/g, '')) ? b : b + '.'; }).join(' ');
    var lab = ((state.lastLook || {}).bib || {}).label || (family === 'numeric-bracket' ? 'bracket' : 'dot');
    var prefix = lab === 'bracket' ? '[' + number + '] ' : lab === 'paren' ? '(' + number + ') ' : lab === 'plain' ? number + ' ' : number + '. ';
    return { prefix: prefix, html: html };
  }

  /* Format one reference the way the target family's .bst roughly would.
   * Not byte-exact to each .bst, but recognizably the right style. Returns
   * {prefix, html} — html carries <i>/<b> so fields are escaped piecewise. */
  function _formatBibEntry(entry, family, number) {
    var vol = String(entry.volume || '').trim();
    var iss = String(entry.issue || '').trim();
    var pages = String(entry.pages || '').trim();
    var year = entry.year ? String(entry.year) : '';
    /* V3.911 — Crossref's HTML-escaped names ("Science &amp; Engineering"),
     * decoded as the .bib writer does */
    function dec(x) {
      var t = document.createElement('textarea');
      t.innerHTML = String(x || '');
      return t.value;
    }
    var title = dec(entry.title).trim();
    var journal = dec(entry.journal).trim();
    var prefix, html;

    if (family === 'numeric-bracket') {
      /* IEEE / Elsevier / PLOS: "[n] A. B. Author, C. Author, "Title,"
       * <i>Journal</i>, vol. V, no. I, pp. P, Year." */
      prefix = '[' + number + '] ';
      html = _authorList(entry, { initialsFirst: true, lastSep: 'and', etAlAfter: 6 });
      if (title)   html += ', “' + _esc(title) + ',”';
      if (journal) html += ' <i>' + _esc(journal) + '</i>';
      if (vol)     html += ', vol. ' + _esc(vol);
      if (iss)     html += ', no. ' + _esc(iss);
      if (pages)   html += ', pp. ' + _esc(pages);
      if (year)    html += ', ' + _esc(year);
      html += '.';
    } else if (family === 'numeric-paren') {
      /* Science: "n. A. Author, B. Author, Title. <i>Journal</i> <b>V</b>,
       * Pages (Year)." */
      prefix = number + '. ';
      html = _authorList(entry, { initialsFirst: true, lastSep: ',', etAlAfter: 6 });
      if (title)   html += ', ' + _esc(title) + '.';
      if (journal) html += ' <i>' + _esc(journal) + '</i>';
      if (vol)     html += ' <b>' + _esc(vol) + '</b>';
      if (pages)   html += ', ' + _esc(pages);
      if (year)    html += ' (' + _esc(year) + ')';
      html += '.';
    } else if (family === 'superscript') {
      /* Nature / mebp / ACS: "n. Surname, A. B. & Surname, C. Title.
       * <i>Journal</i> <b>V</b>, Pages (Year)." */
      prefix = number + '. ';
      html = _authorList(entry, { initialsFirst: false, lastSep: '&', etAlAfter: 5 });
      if (title)   html += '. ' + _esc(title) + '.';
      if (journal) html += ' <i>' + _esc(journal) + '</i>';
      if (vol)     html += ' <b>' + _esc(vol) + '</b>';
      if (pages)   html += ', ' + _esc(pages);
      if (year)    html += ' (' + _esc(year) + ')';
      html += '.';
    } else {
      /* author-year (APA-ish, unnumbered): "Surname, A. B., & Surname, C.
       * (Year). Title. <i>Journal</i>, <i>V</i>(I), Pages." */
      prefix = '';
      html = _authorList(entry, { initialsFirst: false, lastSep: '&', etAlAfter: 20 });
      if (year)  html += ' (' + _esc(year) + ').';
      if (title) html += ' ' + _esc(title) + '.';
      if (journal) {
        html += ' <i>' + _esc(journal) + '</i>';
        if (vol) { html += ', <i>' + _esc(vol) + '</i>'; if (iss) html += '(' + _esc(iss) + ')'; }
        if (pages) html += ', ' + _esc(pages);
        html += '.';
      }
    }
    html = html.replace(/^\s*[,.]\s*/, '');   // an entry with no authors starts at its title
    return { prefix: prefix, html: html };
  }

  /* Bibliography per citation family. Numeric families order by
   * PaperCiteStyle first-appearance numbers; author-year alphabetizes
   * (matching what plainnat does at compile time). */
  /* V3.915 — a copy of a library entry with BibTeX accents decoded in the
   * fields the bibliography prints (metadata imported from a .bib). */
  function _decodeEntryAccents(e) {
    var PT = window.PaperProseTex;
    if (!PT) return e;
    var d = PT.decodeAccents;
    var c = Object.assign({}, e);
    ['title', 'journal', 'firstAuthor'].forEach(function (k) { if (typeof c[k] === 'string') c[k] = d(c[k]); });
    if (Array.isArray(c.authors)) c.authors = c.authors.map(function (a) { return typeof a === 'string' ? d(a) : a; });
    if (Array.isArray(c.authorsFull)) {
      c.authorsFull = c.authorsFull.map(function (a) {
        return a ? Object.assign({}, a, { family: d(a.family || ''), given: d(a.given || '') }) : a;
      });
    }
    return c;
  }

  function _buildBibliography(tpl) {
    var pe = _pe();
    var keys = pe.getCitedKeysInPaper() || [];
    if (!keys.length) return null;
    var byKey = pe.getCitationByKey() || {};
    var family = (window.PaperCiteStyle && window.PaperCiteStyle.getFamily()) ||
      (tpl.citation && tpl.citation.render_family) || 'numeric-bracket';
    var numeric = family !== 'author-year';
    var PCS = window.PaperCiteStyle;
    var ordered = keys.slice();
    if (numeric && PCS && PCS.getNumber) {
      ordered.sort(function (a, b) { return (PCS.getNumber(a) || 9999) - (PCS.getNumber(b) || 9999); });
    } else {
      ordered.sort(function (a, b) {
        var ea = byKey[a], eb = byKey[b];
        return String((ea && ea.firstAuthor) || a).localeCompare(String((eb && eb.firstAuthor) || b));
      });
    }
    /* V3.914 — under a look the bibliography is set the way the template's
     * .bst writes it, where the preview knows that style (unsrtnat) */
    var bst = state.lastLook ? ((tpl.citation || {}).bibliography_style || '') : '';
    var wrap = document.createElement('div');
    wrap.className = 'pdv-bib pdv-bib-' + family;
    wrap.innerHTML = ordered.map(function (key, i) {
      var e = byKey[key];
      var n = numeric ? ((PCS && PCS.getNumber && PCS.getNumber(key)) || (i + 1)) : null;
      if (!e) {
        var mp = family === 'numeric-bracket' ? '[' + n + '] ' : (numeric ? n + '. ' : '');
        return '<div class="pdv-bib-entry pdv-bib-missing">' + _esc(mp) + '@' + _esc(key) +
          ' — not in the lab library</div>';
      }
      e = _decodeEntryAccents(e);   // V3.915 — Andr{\'e} → André, as the PDF prints it
      var f = bst === 'unsrtnat' && numeric ? _formatUnsrtnat(e, n, family) : _formatBibEntry(e, family, n);
      return '<div class="pdv-bib-entry">' +
        (f.prefix ? '<span class="pdv-bib-num">' + _esc(f.prefix) + '</span>' : '') +
        f.html + '</div>';
    }).join('');
    return wrap;
  }

  /* Footnotes: replace the editor's dagger chips with sequential
   * superscript numbers; the note text rides the chip's title attr. */
  function _extractFootnotes(items) {
    var counter = 0;
    items.forEach(function (item) {
      var chips = item.node.querySelectorAll ? item.node.querySelectorAll('.pe-footnote-chip') : [];
      Array.prototype.forEach.call(chips, function (chip) {
        counter++;
        var text = chip.getAttribute('title') || chip.getAttribute('data-note') || chip.textContent || '';
        text = text.replace(/^footnote:?\s*/i, '').trim();
        var sup = document.createElement('sup');
        sup.className = 'pdv-fn-mark';
        sup.textContent = String(counter);
        chip.replaceWith(sup);
        var line = document.createElement('div');
        line.className = 'pdv-fn-line';
        line.innerHTML = '<sup>' + counter + '</sup> ' + _esc(text || '(footnote)');
        item.footnotes.push({ node: line, h: 0 });
      });
    });
  }

  /* Cross-ref chip prefixes per template.refs ("Tab." → "Table", plos
   * "Fig." → "Fig", ieee equations → "(N)"). Cheap text-only rewrite. */
  function _rewriteRefPrefixes(items, tpl) {
    var refs = tpl.refs || {};
    /* V3.915 — the prefix is tied to the number with a no-break space, as
     * the PDF's "Fig.~\ref{…}" is (the typesetter never breaks there) */
    function prefixOf(r, fallback) {
      if (!r || !r.prefix) return fallback;
      return String(r.prefix).replace(/~/g, ' ').trim() + '\u00A0';
    }
    var figPrefix = prefixOf(refs.figure, 'Fig.\u00A0');
    var tabPrefix = prefixOf(refs.table, 'Tab.\u00A0');
    var eqPrefix = prefixOf(refs.equation, 'Eq.\u00A0');
    items.forEach(function (item) {
      if (!item.node.querySelectorAll) return;
      /* V3.915 — a reference to a label the paper does not have prints
       * as LaTeX prints it ("Fig. ??"), not the editor's "[?Fig. label]"
       * marker, which as one unbreakable box wrecked the line it sat on.
       * The label stays on the tooltip. */
      item.node.querySelectorAll('.pe-figref-chip-unknown, .pe-tabref-chip-unknown, .pe-eqref-chip-unknown').forEach(function (c) {
        var bare = !/^\[\?(Fig|Tab|Eq)\./.test(c.textContent);
        var pre = c.classList.contains('pe-figref-chip-unknown') ? 'Fig.\u00A0'
          : c.classList.contains('pe-tabref-chip-unknown') ? 'Tab.\u00A0' : 'Eq.\u00A0';
        var lab = c.dataset.figrefLabel || c.dataset.tabrefLabel || c.dataset.eqrefLabel || '';
        c.title = 'No numbered item labelled ' + lab;
        c.textContent = (bare ? '' : pre) + '??';
      });
      item.node.querySelectorAll('.pe-figref-chip').forEach(function (c) {
        c.textContent = c.textContent.replace(/^Fig\.\s*/, figPrefix);
      });
      item.node.querySelectorAll('.pe-tabref-chip').forEach(function (c) {
        c.textContent = c.textContent.replace(/^Tab\.\s*/, tabPrefix);
      });
      item.node.querySelectorAll('.pe-eqref-chip').forEach(function (c) {
        c.textContent = c.textContent.replace(/^Eq\.\s*/, eqPrefix);
      });
    });
  }

  /* ── Measurement ───────────────────────────────────────────── */

  async function _measureItems(items, geom, seq) {
    var probe = state.probeEl;
    if (!probe) return;
    probe.style.fontSize = (geom.fontPt * 1.333) + 'px';

    /* First render ever: wait for unknown images so heights are real.
     * Afterwards the aspect-ratio style makes measurement synchronous. */
    var pending = [];
    var refit = false;   // a figure built before its aspect was known
    items.forEach(function (item) {
      if (!item.node.querySelectorAll) return;
      item.node.querySelectorAll('img').forEach(function (img) {
        var url = img.getAttribute('src');
        if (!url || state.imgSizeCache[url]) return;
        var figEl = img.closest('.pdv-figure');
        pending.push(
          Promise.race([
            (img.decode ? img.decode() : Promise.resolve()),
            new Promise(function (res) { setTimeout(res, 8000); }),
          ]).then(function () {
            if (img.naturalWidth && img.naturalHeight) {
              state.imgSizeCache[url] = { w: img.naturalWidth, h: img.naturalHeight };
              img.style.aspectRatio = img.naturalWidth + '/' + img.naturalHeight;
              if (figEl && figEl.dataset.h) refit = true;
            }
          }).catch(function () { /* broken image — CSS placeholder height */ })
        );
      });
    });

    function measureBatch(list, width) {
      probe.innerHTML = '';
      probe.style.width = width + 'px';
      list.forEach(function (x) { probe.appendChild(x.node); });
      /* One forced reflow, then batch-read. Height includes the item's own
       * vertical margins (getBoundingClientRect excludes them) so the pack
       * accounts for real spacing now that body paragraphs carry no gap.
       * Summing both margins slightly over-counts collapsed margins, which
       * is the safe direction — a little extra whitespace, never a clipped
       * line. */
      void probe.offsetHeight;
      list.forEach(function (x) {
        var rect = x.node.getBoundingClientRect();
        var mt = 0, mb = 0;
        try {
          var cs = window.getComputedStyle(x.node);
          mt = parseFloat(cs.marginTop) || 0;
          mb = parseFloat(cs.marginBottom) || 0;
        } catch (e) { /* ignore */ }
        /* V3.912 — under a look heights are exact (lines × leading); a
         * whole-pixel ceiling per item added ~2 px a page and lost the
         * line TeX fits exactly at the foot */
        x.h = state.lastLook ? Math.round((rect.height + mt + mb) * 1000) / 1000 : Math.ceil(rect.height + mt + mb);
        x.mt = mt; x.mb = mb;   // V3.912 — the paginator collapses adjoining margins as CSS (and \addvspace) do
      });
      probe.innerHTML = '';
    }

    var colItems = items.filter(function (i) { return i.type === 'col'; });
    var fullItems = items.filter(function (i) { return i.type === 'full'; });
    var noteLines = [];
    items.forEach(function (i) { i.footnotes.forEach(function (f) { noteLines.push(f); }); });

    /* V3.401 — layout-session height memo. During a session, document
     * CONTENT is frozen (our own writes touch only layout attrs; remote
     * edits banner + defer), so an item's height is fully determined by
     * its rendered HTML + measurement width. Keyed on html length +
     * blockId — safe ONLY under the session freeze, hence the gate;
     * the live loop must never trust it (same-length text edits could
     * alias). Cuts each manipulation's re-render to ~one probe pass of
     * the manipulated item. */
    var cache = state.layoutSession ? state.measureCache : null;
    function cacheKey(x, width) {
      /* dataset.w (figure width %) is a mandatory discriminator — a
       * 50%→80% width change keeps innerHTML.length identical while the
       * height changes massively (V3.402 fix; resize would alias). */
      var w = (x.node.dataset && x.node.dataset.w) || '';
      /* dataset.h (image height cap, mm) is the V3.405 discriminator —
       * a cap change alters the box height with identical innerHTML. */
      var hcap = (x.node.dataset && x.node.dataset.h) || '';
      return (x.blockId || x.blockKind || 'i') + '|' + x.type + '|' + width +
             '|' + w + '|' + hcap + '|' + (x.node.innerHTML ? x.node.innerHTML.length : 0);
    }
    function measureCached(list, width) {
      if (!cache) { measureBatch(list, width); return; }
      var misses = [];
      list.forEach(function (x) {
        var k = cacheKey(x, width);
        if (cache[k] != null) { x.h = cache[k].h; x.mt = cache[k].mt; x.mb = cache[k].mb; }
        else misses.push(x);
      });
      if (misses.length) {
        measureBatch(misses, width);
        misses.forEach(function (x) { cache[cacheKey(x, width)] = { h: x.h, mt: x.mt, mb: x.mb }; });
      }
    }

    if (pending.length) {
      /* Images must be in the DOM to decode reliably — mount everything
       * in the probe at column width first, await, then measure. */
      probe.style.width = geom.colW + 'px';
      probe.innerHTML = '';
      items.forEach(function (x) { probe.appendChild(x.node); });
      await Promise.allSettled(pending);
      /* A newer render may have superseded us during the decode wait — bail
       * before touching the shared probe further so the two don't collide. */
      if (typeof seq === 'number' && (seq !== state.renderSeq || !state.open)) { probe.innerHTML = ''; return; }
      probe.innerHTML = '';
      /* V3.909 — a height-capped figure (fa.max_h, a look's page-fit cap)
       * can only be fitted once its aspect is known: it was built
       * width-bound, so start the render again now that every decoded
       * image is in the cache (once — cached images never wait). The
       * superseded render bails at its next sequence check. */
      if (refit && typeof seq === 'number') {
        state.forceRender = true;
        renderDocument().catch(function (e) { console.warn('[paper-doc-view] render failed:', e.message || e); });
        return;
      }
    }

    /* V3.908 — under a journal look, body paragraphs are set the way TeX
     * sets them (Knuth–Plass + TeX hyphenation, same fonts) BEFORE their
     * height is read, so each one has exactly the PDF's line count, its
     * height is lines × leading, and a column/page split is a clean cut
     * between two lines. Every render, cache or not — the mounted node
     * must be the laid-out one. */
    if (geom.look && window.PaperTypeset) {
      _typesetParagraphs(colItems, geom.colW);
      _typesetParagraphs(fullItems, geom.bodyW);
    }
    measureCached(colItems, geom.colW);
    measureCached(fullItems, geom.bodyW);
    if (noteLines.length) measureBatch(noteLines, geom.bodyW);
    if (geom.look) _setDisplays(colItems, geom);   // V3.914 — TeX's display spacing
    /* V3.912 — a wrapped figure's box (width, height): wrapfig's sums
     * start from it */
    if (geom.look && geom.cols === 1) {
      var wr = colItems.filter(function (x) { return x.node && x.node.classList && x.node.classList.contains('pdv-wrapfig-tex'); });
      if (wr.length) {
        probe.innerHTML = '';
        probe.style.width = geom.colW + 'px';
        wr.forEach(function (x) { probe.appendChild(x.node); });
        void probe.offsetHeight;
        wr.forEach(function (x) {
          var rc = x.node.getBoundingClientRect();
          x.wrapFig = true; x.figW = rc.width; x.figH = rc.height;
          x.side = x.node.dataset.wrapSide === 'left' ? 'left' : 'right';
        });
        probe.innerHTML = '';
      }
    }
  }

  /* V3.914 — a display equation, spaced the way TeX spaces it (TeXbook
   * ch. 19, tex.web §1199–1206): from the baseline above to the baseline
   * below, the line's depth, \abovedisplayskip, interline glue against the
   * equation box's height (\baselineskip − depth − height, or \lineskip
   * when that is negative), the box, \belowdisplayskip, interline glue
   * against its depth, the next line's height. The short skips apply when
   * the equation starts right of where the line above ends (+2em), and a
   * display that starts a paragraph (after a heading) sits under an empty
   * line. The box's height and depth are KaTeX's struts (TeX's own metrics)
   * at the body size; XeTeX gives each text line the face's ascender and
   * descender. Replaces KaTeX's 1em display margins, which overstated
   * every equation by about a line and a half. */
  function _setDisplays(list, geom) {
    var look = geom.look, probe = state.probeEl;
    if (!look || !probe || !window.PaperLook) return;
    var PXb = 4 / 3;
    var fnt = window.PaperLook.FONTS[look.fonts.text] || {};
    var size = look.body.size, bs = look.body.lead;
    var pd = (fnt.desc || 0.25) * size, htNext = (fnt.ht || 0.7) * size, lsk = 0.99626;
    var lineOff = window.PaperLook.lineOff(look, { family: 'text', size: size, lead: bs });
    var A = (look.display || {}).above || 0, B = (look.display || {}).below || 0;
    function glue(x) { return x >= 0 ? x : lsk; }
    list.forEach(function (x, i) {
      var node = x.node;
      if (!node || !node.classList || !node.classList.contains('pdv-eq')) return;
      var prev = list[i - 1];
      var attached = node.classList.contains('pdv-eq-attached') && prev && prev.node &&
        prev.node.classList && prev.node.classList.contains('pts-para');
      probe.innerHTML = '';
      probe.style.width = geom.colW + 'px';
      if (attached) probe.appendChild(prev.node);
      probe.appendChild(node);
      void probe.offsetHeight;
      var kx = node.querySelector('.katex');
      var html = node.querySelector('.katex-html');
      if (!kx || !html) { probe.innerHTML = ''; return; }
      var kfs = parseFloat(getComputedStyle(kx).fontSize) || 16;
      var h = 0, d = 0;
      html.querySelectorAll('.strut').forEach(function (st) {
        var H = parseFloat(st.style.height) || 0;
        var D = -(parseFloat(st.style.verticalAlign) || 0);
        if (H - D > h) h = H - D;
        if (D > d) d = D;
      });
      h *= size; d *= size;                                   // em → bp at the body size
      var bodyPx = size * PXb;
      // the formula's own width: KaTeX makes .katex-html a full-width block in display mode
      var bl = Infinity, br = -Infinity;
      Array.prototype.forEach.call(html.children, function (b) {
        if (!b.classList || !b.classList.contains('base')) return;
        var r = b.getBoundingClientRect();
        if (r.left < bl) bl = r.left;
        if (r.right > br) br = r.right;
      });
      var wPx = br > bl ? br - bl : html.getBoundingClientRect().width;
      var w = wPx * bodyPx / kfs / PXb;   // bp, at TeX's math size
      var short = true, emptyLine = !attached;
      if (attached) {
        var lns = prev.node.querySelectorAll('.pts-ln');
        var last = lns[lns.length - 1];
        var lw = 0;
        if (last) {
          var rg = document.createRange();
          rg.selectNodeContents(last);
          var rr = rg.getBoundingClientRect(), lr = last.getBoundingClientRect();
          lw = (rr.right - lr.left) / PXb;
        }
        var shift = (geom.colW / PXb - w) / 2;
        short = shift > lw + 2 * size;                        // \predisplaysize = line width + 2em
      }
      var above = short ? 0 : A, below = short ? 0.6 * B : B;
      var p0 = emptyLine ? 0 : pd;
      var top = (emptyLine ? bs : 0) + p0 + above + glue(bs - p0 - h);   // baseline above → box top
      var D = top + h + d + below + glue(bs - d - htNext) + htNext;      // → baseline below
      var blockH = (D - bs) * PXb;
      var baseY = (top + h - (bs - lineOff)) * PXb;           // the equation's baseline, from the block top
      // where KaTeX's baseline sits in its container
      var math = node.querySelector('.pdv-eq-math');
      var mk = document.createElement('span');
      mk.style.cssText = 'display:inline-block;width:0;height:0;vertical-align:baseline';
      kx.appendChild(mk);
      var mTop = mk.getBoundingClientRect().top - math.getBoundingClientRect().top;
      mk.remove();
      probe.innerHTML = '';
      node.classList.add('pdv-eq-tex');
      node.style.margin = '0';   // the look's .pdv-eq margins are TeX's skips, now inside the height
      node.style.height = blockH.toFixed(2) + 'px';
      math.style.top = (baseY - mTop).toFixed(2) + 'px';
      var num = node.querySelector('.pdv-eq-num');
      if (num) num.style.top = (baseY - 0.75 * size * PXb).toFixed(2) + 'px';
      x.h = blockH; x.mt = 0; x.mb = 0;
    });
    probe.innerHTML = '';
  }

  /* V3.912 — set a body paragraph again with its first n lines `narrow`
   * px wide, shifted `offset` px when the figure is on the left: wrapfig's
   * \parshape, at its \tolerance 9999 (wrapfig sets every paragraph that
   * starts while it wraps that sloppily). Returns the paragraph's lines. */
  function _setWrappedPara(item, n, narrow, offset, geom, isHead) {
    var el = item.node, probe = state.probeEl;
    var lead = isHead ? (parseFloat(window.getComputedStyle(el).lineHeight) || geom.leadPx) : geom.leadPx;
    var old = parseInt(el.dataset.ptsLines || '0', 10) || Math.round(item.h / lead);
    if (!probe || el._ptsSrc == null || !window.PaperTypeset) return old;
    el.innerHTML = el._ptsSrc;
    el.classList.remove('pts-para');
    probe.innerHTML = '';
    probe.style.width = geom.colW + 'px';
    probe.appendChild(el);
    void probe.offsetHeight;
    var widths = [], offs = [];
    for (var i = 0; i < n; i++) { widths.push(narrow); offs.push(offset); }
    widths.push(geom.colW); offs.push(0);
    var r = null;
    try {
      r = window.PaperTypeset.layoutParagraph(el, { width: geom.colW, widths: widths, offsets: offs,
        params: Object.assign(_lineBreakParams(el), { tolerance: 9999 }) });
    } catch (e) {
      console.warn('[paper-doc-view] wrap typeset failed', e);
    }
    probe.innerHTML = '';
    if (!r) return old;
    item.h += (r.lines - old) * lead;
    el.classList.add('pdv-wrapped');
    var bid = el.dataset && el.dataset.blockId;
    if (bid && state.tsReport && state.tsReport[bid]) {
      state.tsReport[bid].lines = r.lines;
      state.tsReport[bid].ratios = r.ratios || [];
      state.tsReport[bid].overfull = !!r.overfull;
      state.tsReport[bid].pass = r.pass;
      state.tsReport[bid].wrapped = true;
    }
    return r.lines;
  }
  /* A heading beside a wrapped figure: set at the narrow measure (a
   * titlesec heading is a paragraph, so the \parshape reaches it too). */
  function _setWrappedHeading(item, n, narrow, offset, geom) {
    var el = item.node, probe = state.probeEl;
    if (!probe || !el) return 1;
    if (el._ptsSrc != null && window.PaperTypeset) return _setWrappedPara(item, n, narrow, offset, geom, true);
    el.style.width = narrow + 'px';
    if (offset) el.style.marginLeft = offset + 'px';
    probe.innerHTML = '';
    probe.style.width = geom.colW + 'px';
    probe.appendChild(el);
    void probe.offsetHeight;
    var rc = el.getBoundingClientRect();
    var cs = window.getComputedStyle(el);
    var lead = parseFloat(cs.lineHeight) || geom.leadPx;
    item.h = Math.round((rc.height + (parseFloat(cs.marginTop) || 0) + (parseFloat(cs.marginBottom) || 0)) * 1000) / 1000;
    probe.innerHTML = '';
    return Math.max(1, Math.round(rc.height / lead));
  }

  /* The look's line-breaking settings (the .tex sets the same). The
   * emergency stretch is in em of THIS paragraph's font (small-print
   * sections have a smaller em). */
  function _lineBreakParams(node) {
    var look = state.lastLook;
    var lb = (look && look.linebreak) || {};
    var em = parseFloat(getComputedStyle(node).fontSize) || 12;
    /* V3.909 — LaTeX sets everything inside a float or a \parbox after
     * \@parboxrestore, which ends in \sloppy (tolerance 9999, emergency
     * stretch 3em): captions, the fact box, a boxed abstract (a look's
     * `abstract.parbox`, or a shaded box) set their lines that way. */
    var ab = (look && look.abstract) || {};
    var sloppy = !!(node.closest && (node.closest('.pdv-figure, .pdv-table-wrap, .pdv-factbox, .pdv-figcap, .pdv-tabcap') ||
      ((ab.parbox || (ab.box && ab.box.bg)) && node.closest('.pdv-abstract'))));
    // a class's own penalties (IEEEtran raises the hyphen and math ones)
    var pen = {};
    ['hyphenpenalty', 'exhyphenpenalty', 'relpenalty', 'binoppenalty'].forEach(function (k) {
      if (lb[k] != null) pen[k] = lb[k];
    });
    /* V3.913 — a look's document-wide \looseness (Fit), unless the
     * paragraph sets its own */
    var lz = node.dataset ? parseInt(node.dataset.looseness || '0', 10) : 0;
    var glz = look && look.body && look.body.looseness ? Math.round(look.body.looseness) : 0;
    if (lz) pen.looseness = lz;   // V3.910 — the paragraph's \looseness
    else if (glz) pen.looseness = glz;
    if (sloppy) {
      return Object.assign(pen, { pretolerance: lb.pretolerance != null ? lb.pretolerance : 100, tolerance: 9999, emergencystretch: 3 * em });
    }
    return Object.assign(pen, {
      pretolerance: lb.pretolerance != null ? lb.pretolerance : 100,
      tolerance: lb.tolerance != null ? lb.tolerance : 800,
      emergencystretch: (lb.emergency || 0) * em,
    });
  }

  /* Knuth–Plass every body paragraph of `list` at `width` (CSS px), in the
   * probe so the look's CSS (font, size, indent) applies. The abstract,
   * keywords and figure/table captions inside an item are set the same
   * way at their own measure, so the boxes they make are the PDF's
   * height too. */
  var TYPESET_SEL = '.pdv-bodypara';
  /* V3.917 — list items too (justified and broken as the PDF's itemize sets
   * them); an item holding a nested list is left to the browser */
  var TYPESET_INNER_SEL = '.pdv-abstract .pdv-para, .pdv-keywords, .pdv-figcap, .pdv-tabcap, .pdv-factbox .pdv-para, .pdv-affil-colnote, .pdv-list-block li';
  function _typesetParagraphs(list, width) {
    var probe = state.probeEl;
    var jobs = [];
    /* natbib's numeric styles print "(5, 6)" / "[5, 6]" — a space after
     * each comma (only its superscript style packs "5,6") */
    var citeSt = ((state.lastLook || {}).cite || {}).style;
    if (citeSt === 'ieee') {
      /* IEEEtran's \cite: every reference in its own brackets, "[2], [3],
       * [4]", never compressed to a range — separate boxes a line may
       * break between */
      list.forEach(function (x) {
        if (!x.node || !x.node.querySelectorAll) return;
        x.node.querySelectorAll('.pe-cite-group.pe-cite-family-numeric-bracket').forEach(function (g) {
          var m = /^\[(.*)\]$/.exec(g.textContent.trim());
          if (!m) return;
          var nums = [];
          m[1].split(',').forEach(function (part) {
            var r = /^\s*(\d+)\s*[\u2013-]\s*(\d+)\s*$/.exec(part);
            if (r) { for (var k = +r[1]; k <= +r[2] && nums.length < 200; k++) nums.push(k); }
            else if (part.trim()) nums.push(part.trim());
          });
          if (nums.length < 2 && !/[\u2013-]/.test(m[1])) return;
          var frag = document.createDocumentFragment();
          nums.forEach(function (nm, i) {
            if (i) frag.appendChild(document.createTextNode(', '));
            var one = g.cloneNode(false);
            one.textContent = '[' + nm + ']';
            frag.appendChild(one);
          });
          g.parentNode.replaceChild(frag, g);
        });
      });
    }
    if (citeSt === 'paren' || citeSt === 'bracket') {
      list.forEach(function (x) {
        if (!x.node || !x.node.querySelectorAll) return;
        x.node.querySelectorAll('.pe-cite-family-numeric-paren .pe-cite-sep, .pe-cite-family-numeric-bracket .pe-cite-sep')
          .forEach(function (sp) { if (sp.textContent === ',') sp.textContent = ', '; });
      });
    }
    /* V3.912 — a grant look's headings are LaTeX's own \@startsection
     * paragraphs: justified, broken by TeX like body text (and narrowed,
     * line by line, beside a wrapped figure) */
    var headsTex = !!(state.lastLook && state.lastLook.rigid_headings);
    list.forEach(function (x) {
      var node = x.node;
      if (!node || !node.matches) return;
      if (node.matches(TYPESET_SEL)) {
        if (!node.classList.contains('pts-para')) jobs.push({ el: node, item: x });
        return;
      }
      if (headsTex && node.matches('.pdv-heading, .pdv-subheading')) {
        if (!node.classList.contains('pts-para')) jobs.push({ el: node, item: null, head: x });
        return;
      }
      var inner = node.matches(TYPESET_INNER_SEL) ? [node] : Array.prototype.slice.call(node.querySelectorAll(TYPESET_INNER_SEL));
      /* the typesetter justifies; a centred or ragged caption keeps the
       * browser's line breaking */
      var capAlign = ((state.lastLook || {}).caption || {}).align;
      var capJustified = !capAlign || capAlign === 'justify';
      inner.forEach(function (el) {
        if (el.classList.contains('pts-para')) return;
        if (el.tagName === 'LI' && el.querySelector('ul, ol')) return;
        if (!capJustified && el.matches('.pdv-figcap, .pdv-tabcap')) return;
        jobs.push({ el: el, item: null });
      });
    });
    if (!jobs.length) return;
    probe.innerHTML = '';
    probe.style.width = width + 'px';
    list.forEach(function (x) { if (x.node) probe.appendChild(x.node); });
    void probe.offsetHeight;
    jobs.forEach(function (j) {
      try {
        var w = width;
        if (!j.item) {
          var cs = getComputedStyle(j.el);
          w = j.el.getBoundingClientRect().width - (parseFloat(cs.paddingLeft) || 0) - (parseFloat(cs.paddingRight) || 0) -
            (parseFloat(cs.borderLeftWidth) || 0) - (parseFloat(cs.borderRightWidth) || 0);
        }
        /* V3.912 — the paragraph's own HTML, kept so the paginator can set
         * it again at other widths (the lines beside a wrapped figure) */
        if (j.item || j.head) j.el._ptsSrc = j.el.innerHTML;
        if (j.head) w = width;
        var lbp = _lineBreakParams(j.el);
        var r = window.PaperTypeset.layoutParagraph(j.el, { width: w, params: lbp,
          probeTighten: !!j.item && j.el.dataset.looseness !== '-1' && !lbp.looseness });
        if (r && j.item) {
          j.item.typeset = r;
          var bidT = j.el.dataset && j.el.dataset.blockId;
          if (bidT && state.tsReport) {
            state.tsReport[bidT] = { lines: r.lines, ratios: r.ratios || [], overfull: !!r.overfull, pass: r.pass,
              canTighten: !!r.canTighten, looseness: parseInt(j.el.dataset.looseness || '0', 10) || 0,
              lz: lbp.looseness || 0 };
          }
        }
      } catch (e) {
        console.warn('[paper-doc-view] typeset failed — browser line breaking for this paragraph', e);
      }
    });
    probe.innerHTML = '';
  }

  /* V3.419 — split a paragraph item at a LINE boundary so text flows
   * continuously across pages. Returns [partA, partB] (both measured)
   * or null when no useful split exists (tiny slack, chip-only line,
   * would orphan a single line). Mechanics: clone into the probe at
   * column width, find the last character whose LINE bottom fits the
   * budget (binary search on Range rects), back up to a word boundary,
   * then Range.extractContents — which correctly bisects nested inline
   * formatting while ATOMIC inlines (citation chips, KaTeX, ref chips)
   * stay whole on one side because the split point is always a bare
   * text node outside them. Part B is marked .pdv-para-cont (no
   * first-line indent — it continues a sentence). */
  var SPLIT_GUARD_SEL = '.pe-cite-group, .katex, .pe-ref, .pe-refchip, .pe-secref-chip, .pdv-eq, .pe-eq-inline, .pdv-list';
  function _splitColItem(item, availPx, geom) {
    var node = item.node;
    var probe = state.probeEl;
    if (!probe || !node || typeof node.cloneNode !== 'function') return null;
    if (!(availPx > 0)) return null;
    if (node.classList && node.classList.contains('pts-para')) return _splitTypeset(item, availPx);
    probe.style.width = geom.colW + 'px';
    probe.innerHTML = '';
    var meas = node.cloneNode(true);
    probe.appendChild(meas);
    try {
      var cs = getComputedStyle(meas);
      var mt = parseFloat(cs.marginTop) || 0;
      var mb = parseFloat(cs.marginBottom) || 0;
      var lineH = parseFloat(cs.lineHeight);
      if (!isFinite(lineH) || lineH <= 0) lineH = (parseFloat(cs.fontSize) || 12) * 1.45;
      var budget = availPx - mt;               // content-box budget for part A
      /* Break a paragraph across the boundary once the column foot has at
       * least `fillMinLines()` lines of room (the ⬒ Layout "Column fill"
       * setting) — instead of jumping the whole paragraph to the next
       * page and stranding blank lines. 'tight' (1 line) fills the most;
       * 'loose' (4) keeps more of a paragraph together. */
      if (budget < lineH * fillMinLines()) { probe.innerHTML = ''; return null; }
      var topY = meas.getBoundingClientRect().top;
      var range = document.createRange();
      function lineBottom(tn, off) {
        range.setStart(tn, Math.max(0, off - 1));
        range.setEnd(tn, off);
        var rects = range.getClientRects();
        var r = rects[rects.length - 1];
        return r ? (r.bottom - topY) : 0;
      }
      /* Walk text nodes in order; keep the LAST fitting position in a
       * splittable text node. */
      var walker = document.createTreeWalker(meas, NodeFilter.SHOW_TEXT, null);
      var best = null;
      var tn;
      while ((tn = walker.nextNode())) {
        var len = tn.nodeValue ? tn.nodeValue.length : 0;
        if (!len) continue;
        var guarded = tn.parentElement && tn.parentElement.closest &&
                      tn.parentElement.closest(SPLIT_GUARD_SEL);
        var endB = lineBottom(tn, len);
        if (endB <= budget) {
          if (!guarded) best = { tn: tn, off: len };
          continue;
        }
        /* This node crosses the budget — binary-search inside it. */
        if (!guarded) {
          var lo = 1, hi = len, fitOff = 0;
          while (lo <= hi) {
            var mid = (lo + hi) >> 1;
            if (lineBottom(tn, mid) <= budget) { fitOff = mid; lo = mid + 1; }
            else hi = mid - 1;
          }
          if (fitOff > 0) {
            /* Back up to a word boundary so justification stays clean. */
            var txt = tn.nodeValue;
            var ws = fitOff;
            while (ws > 0 && !/\s/.test(txt.charAt(ws - 1))) ws--;
            if (ws > 0) best = { tn: tn, off: ws };
            else if (fitOff === len) best = { tn: tn, off: len };
          }
        }
        break;   // everything after this node is below the budget line
      }
      if (!best) { probe.innerHTML = ''; return null; }
      /* Part A must hold at least ~1 line (filling the column foot); part
       * B must keep real content (checked below). Was ≥2 lines, which
       * forced short columns when only 1 line of room remained. */
      if (lineBottom(best.tn, best.off) < lineH * 0.9) { probe.innerHTML = ''; return null; }
      var tail = document.createRange();
      tail.setStart(best.tn, best.off);
      tail.setEnd(meas, meas.childNodes.length);
      var frag = tail.extractContents();
      var nodeB = node.cloneNode(false);
      nodeB.appendChild(frag);
      if (!String(nodeB.textContent || '').trim() && !nodeB.querySelector('*')) {
        probe.innerHTML = '';
        return null;   // nothing real left for part B — don't split
      }
      nodeB.classList.add('pdv-para-cont');
      if (meas.dataset) meas.dataset.blockPart = '1';
      if (nodeB.dataset) nodeB.dataset.blockPart = '2';
      /* Measure both halves (margins included, like measureBatch). */
      var hA = Math.ceil(meas.getBoundingClientRect().height + mt + mb);
      probe.appendChild(nodeB);
      var csB = getComputedStyle(nodeB);
      var hB = Math.ceil(nodeB.getBoundingClientRect().height +
                         (parseFloat(csB.marginTop) || 0) + (parseFloat(csB.marginBottom) || 0));
      /* V3.454 — 'loose' fill also refuses to strand a one-line
       * continuation at the next column's top (the widow analog of the
       * entry guard): move the whole paragraph instead. tight/normal
       * keep any real tail — filling the foot is their point. */
      if ((state.config && state.config.columnFill) === 'loose' &&
          nodeB.getBoundingClientRect().height < lineH * 1.9) {
        probe.innerHTML = '';
        return null;
      }
      probe.innerHTML = '';                       // detach; references stay valid
      if (hA > availPx + 1) return null;          // rounding pushed A over — bail
      function mk(n, h, part) {
        return {
          node: n, type: 'col', h: h,
          footnotes: part === 1 ? (item.footnotes || []) : [],
          blockKind: item.blockKind, sectionId: item.sectionId,
          blockId: item.blockId, float: null, part: part,
        };
      }
      return [mk(meas, hA, 1), mk(nodeB, hB, 2)];
    } catch (e) {
      probe.innerHTML = '';
      return null;      // any surprise → atomic fallback (old behavior)
    }
  }

  /* V3.908 — a paragraph the typesetter laid out is a stack of fixed-
   * height lines: the split is a count, no Range surgery. Part A keeps the
   * first k lines that fit (k ≥ the Column-fill minimum), part B the rest
   * (no indent — it continues a sentence; the first line's indent lives on
   * line 1 of part A as padding, so it stays put). */
  function _splitTypeset(item, availPx) {
    var node = item.node;
    var lines = Array.prototype.slice.call(node.children).filter(function (c) { return c.classList.contains('pts-ln'); });
    if (lines.length < 2) return null;
    var lead = lines[0].getBoundingClientRect ? parseFloat(lines[0].style.height) : 0;
    if (!(lead > 0)) return null;
    var k = Math.floor((availPx + 0.5) / lead);
    if (k < fillMinLines()) return null;
    if (k >= lines.length) return null;
    var a = node.cloneNode(false), b = node.cloneNode(false);
    lines.forEach(function (ln, i) { (i < k ? a : b).appendChild(ln.cloneNode(true)); });
    b.classList.add('pdv-para-cont');
    if (a.dataset) a.dataset.blockPart = '1';
    if (b.dataset) b.dataset.blockPart = '2';
    function mk(n, nl, part) {
      return {
        node: n, type: 'col', h: nl * lead,
        footnotes: part === 1 ? (item.footnotes || []) : [],
        blockKind: item.blockKind, sectionId: item.sectionId,
        blockId: item.blockId, float: null, part: part, keepNext: false,
      };
    }
    return [mk(a, k, 1), mk(b, lines.length - k, 2)];
  }

  /* ── Pagination (block-atomic greedy packing; paragraphs split at
   * line boundaries since V3.419) ──────────────── */

  /* V3.397 — two-pass float engine. Anchored floats (item.float set)
   * claim page BANDS (top/bottom stacks, LaTeX's own float-area model);
   * text + in-flow items pack into the remainder. Deterministic
   * assignment = LaTeX's rule: a float lands on the page where its
   * source position falls, or the next page with room, via a `pending`
   * queue drained on every float push and at each fresh page.
   * anchor='float-page' items become dedicated sheets between text
   * pages. Every page records `rects` (page-local px) for the R3
   * region overlay. */
  function _packPages(items, geom) {
    /* V3.908 — under a journal look every height is exact (typeset lines),
     * so a column holds exactly its text height, as in the PDF. */
    var cap = geom.look ? geom.bodyH : Math.floor(geom.bodyH * FILL_FACTOR);
    var cols = geom.cols;
    var pages = [];
    var page = null;
    var pending = [];        // top/bottom floats awaiting a page with room
    var floatPageQueue = []; // 'float-page' floats → dedicated sheets

    function makePage() {
      return { segments: [], topFloats: [], bottomFloats: [], topH: 0, bottomH: 0,
               footnotes: [], footH: 0, usedH: 0, run: null, grid: null, overflow: false,
               isFloatPage: false, rects: null, firstFlow: null };
    }
    function remaining() { return cap - page.usedH - page.footH - page.topH - page.bottomH; }
    /* V3.908 — the share of a page floats may take: the look's LaTeX
     * fractions (\topfraction, \dbltopfraction for spanning floats in two
     * columns, \bottomfraction; never more than 1 − \textfraction), else
     * the legacy fixed budget. */
    function floatFrac(f) {
      if (!geom.look) return FLOAT_MAX_FRAC;
      var fl = geom.look.floats || {};
      var fr = f.float.region === 'bottom' ? (fl.bottomfraction || 0.3)
        : (cols === 2 && f.float.span === 'page') ? (fl.dbltopfraction || 0.7) : (fl.topfraction || 0.7);
      return Math.min(fr, 1 - (fl.textfraction || 0.2));
    }

    /* ── V3.421 — per-column flow (2-col) ────────────────────────
     * The 2-col analogue of the 1-col run: a COLGRID holds two
     * independent columns, each an ordered stack of flow nodes with an
     * optional single-column float reserved at its top and/or bottom.
     * Text fills column 0 to the page's remaining height (splitting the
     * crossing paragraph), then column 1 — so a figure in one column no
     * longer stops the other, and text runs right up to the figure's
     * boundary instead of stranding a full-width band's worth of white
     * space. Spanning floats (starred figures/tables, and every float in
     * 1-col) keep their full-width top/bottom bands — they truly span. */
    function colObj() { return { items: [], itemsH: 0, floatTop: null, floatBottom: null }; }
    function newGrid() { return { cols: [colObj(), colObj()], fillCol: 0 }; }
    function fTopH(c) { return c.floatTop ? c.floatTop.h + c.floatTop.gap : 0; }
    function fBotH(c) { return c.floatBottom ? c.floatBottom.h + c.floatBottom.gap : 0; }
    function colContentH(c) { return fTopH(c) + c.itemsH + fBotH(c); }
    function gridProjH() {
      if (!page.grid) return 0;
      return Math.max(colContentH(page.grid.cols[0]), colContentH(page.grid.cols[1]));
    }
    function gridIsEmpty(g) {
      return g.cols.every(function (c) { return !c.items.length && !c.floatTop && !c.floatBottom; });
    }
    function gridFloatArea(g) {
      var a = 0;
      g.cols.forEach(function (c) { a += fTopH(c) + fBotH(c); });
      return a;
    }
    function ensureGrid() { if (!page.grid) page.grid = newGrid(); }
    /* V3.909 — LaTeX's float column (\@tryfcolumn at every \@startcolumn
     * in two-column mode): the column floats waiting at the head of the
     * queue that together fill at least \floatpagefraction of a column
     * get that column to themselves, centred vertically. Journal looks
     * only. `atEnd` (the trailing drain, LaTeX's \clearpage) drops the
     * fraction test so a short [p] float still lands. */
    var atEnd = false;
    function tryFloatColumn(c) {
      if (!geom.look || cols !== 2 || c.items.length || c.floatTop || c.floatBottom) return false;
      var fl = geom.look.floats || {};
      var sep = Math.round((fl.floatsep || 12) * (4 / 3));
      var take = [], hsum = 0;
      for (var qi = 0; qi < pending.length; qi++) {
        var pf = pending[qi];
        if (pf.float.span === 'page' || pf.float.lock) break;
        if (pf.notBeforePage != null && pages.length - 1 < pf.notBeforePage) break;
        var add = pf.h + (take.length ? sep : 0);
        if (hsum + add > cap) break;
        take.push(pf); hsum += add;
      }
      if (!take.length || (!atEnd && hsum < (fl.floatpagefraction || 0.5) * cap)) return false;
      pending.splice(0, take.length);
      c.floatTop = { items: take, span: 'column', h: hsum, gap: 0, fcol: true, sep: sep };
      c.floatOnly = true;
      take.forEach(addFootnotes);
      return true;
    }
    /* move the fill to column 1 — a column start, so a float column may
     * claim it first */
    function nextCol(g) {
      g.fillCol = 1;
      tryFloatColumn(g.cols[1]);
    }

    /* Projected height of the OPEN flow (1-col run OR 2-col grid) — a
     * float placed mid-page must reserve it, or text already admitted
     * under a larger remaining() would overflow the sheet. */
    function openFlowH() {
      if (cols === 2) { var p = gridProjH(); return p ? p + baseGapPx() : 0; }
      return (page.run && page.run.items.length) ? page.run.sumH : 0;
    }
    /* Close the open flow: dispatch to the grid closer (2-col) or the
     * 1-col run closer (unchanged accounting). */
    /* V3.912 — the one-column analogue of colEff / colPut: the space
     * before an item is dropped at the top of a page, and collapses with
     * the space after whatever precedes it (in this run, or the full-width
     * block above it) */
    function runEff(item) {
      if (!geom.look || !(item.mt > 0)) return item.h;
      var r = page.run;
      var first = !r || !r.items.length;
      if (first && page.usedH === 0) return item.h - item.mt;
      var prevMb = first ? (page.lastMb || 0) : (r.items[r.items.length - 1].mb || 0);
      return item.h - Math.min(prevMb, item.mt);
    }
    function runPut(item) {
      if (!page.run) page.run = { items: [], sumH: 0 };
      var e = runEff(item);
      if (geom.look && item.mt > 0 && !page.run.items.length && page.usedH === 0 && item.node && item.node.style) {
        item.node.style.marginTop = '0px';
      }
      page.run.items.push(item);
      page.run.sumH += e;
      return e;
    }
    function closeRun() {
      if (cols === 2) { closeGrid(false); return; }
      if (page.run && page.run.items.length) page.lastMb = page.run.items[page.run.items.length - 1].mb || 0;
      if (!page.run || !page.run.items.length) { page.run = null; return; }
      var h = openFlowH();   // = sumH for 1-col
      page.segments.push({ type: 'cols', nodes: page.run.items.map(function (i) { return i.node; }), height: h });
      page.usedH += h;
      page.run = null;
    }
    /* Emit the open colgrid as a segment. fillToBottom=true (a page
     * break forced the close) claims all the page's remaining height so
     * the columns fill and any [b] float bottom-anchors to the sheet
     * foot; fillToBottom=false (a spanning item or end-of-doc closed it)
     * uses the columns' natural height. */
    function closeGrid(fillToBottom) {
      var g = page.grid;
      if (!g) return;
      page.grid = null;
      if (gridIsEmpty(g)) return;
      var natural = Math.max(colContentH(g.cols[0]), colContentH(g.cols[1]));
      var avail = remaining();
      var height = fillToBottom ? Math.max(natural, avail) : natural;
      page.segments.push({ type: 'colgrid', cols: g.cols, height: height });
      page.usedH += height;
      if (natural > avail + 1) page.overflow = true;
    }
    function colTextCap(c, targetH) { return targetH - fTopH(c) - fBotH(c); }
    /* V3.912 — under a look an item's height in the flow: TeX discards the
     * space before it at the top of a column, and two adjoining spaces
     * count once, the larger (\addvspace; CSS collapses margins the same
     * way). Without this a heading after spaced content over-counted its
     * space and lost the line TeX fits at the foot. */
    function colEff(c, item) {
      if (!geom.look || !(item.mt > 0)) return item.h;
      if (c.itemsH === 0) return item.h - item.mt;
      return item.h - Math.min(c.lastMb || 0, item.mt);
    }
    function colPut(c, item) {
      var e = colEff(c, item);
      if (geom.look && item.mt > 0 && c.itemsH === 0 && item.node && item.node.style) item.node.style.marginTop = '0px';
      c.items.push(item.node); c.itemsH += e; c.lastMb = item.mb || 0;
      addFootnotes(item);
      return e;
    }
    /* Place one column flow item into the open grid. Fills column 0 then
     * column 1; splits a crossing paragraph at the column boundary and
     * returns {split: partB} for the caller to splice back into the work
     * queue; breaks the page when both columns are full. An EMPTY column
     * always accepts (guarantees progress). */
    function addColItem(item) {
      ensureGrid();
      var g = page.grid;
      var targetH = remaining() - noteH(item);
      var c = g.cols[g.fillCol];
      if (item.blockId && !page.firstFlow) {
        page.firstFlow = { sectionId: item.sectionId, blockId: item.blockId };
      }
      if (c.floatOnly) {
        if (g.fillCol === 0) { nextCol(g); return addColItem(item); }
        closeGrid(true);
        newPage();
        return addColItem(item);
      }
      var capC = colTextCap(c, targetH);
      /* V3.908 — a column that holds only a float is not "empty": an item
       * (or a heading + its first lines) that does not fit moves on to the
       * next column / page instead of being forced in and overflowing. The
       * forced placement stays for a truly empty column (progress). */
      if (c.itemsH === 0 && (c.floatTop || c.floatBottom) &&
          item.h + (item.keepNextH || 0) > capC && !(item.blockKind === 'paragraph' && capC >= 2 * (geom.leadPx || 14))) {
        if (g.fillCol === 0) { nextCol(g); return addColItem(item); }
        closeGrid(true);
        newPage();
        return addColItem(item);
      }
      if (c.itemsH === 0) {
        /* A paragraph taller than the whole column still splits — fill
         * this column, carry the rest to the next — instead of being
         * dropped in whole and overflowing (clip) or stranding space. */
        if (item.blockKind === 'paragraph' && item.h > capC) {
          var partsE = _splitColItem(item, capC, geom);
          if (partsE) {
            colPut(c, partsE[0]);
            return { split: partsE[1] };
          }
        }
        if (colPut(c, item) > capC) page.overflow = true;
        return null;
      }
      /* V3.908 — a heading never ends a column: it needs room for itself
       * AND the start of what follows (LaTeX's \@afterheading nobreak). */
      var keepH = item.keepNextH || 0;
      if (c.itemsH + colEff(c, item) + keepH <= capC) {
        colPut(c, item);
        return null;
      }
      if (item.blockKind === 'paragraph') {
        var parts = _splitColItem(item, capC - c.itemsH, geom);
        if (parts) {
          colPut(c, parts[0]);
          return { split: parts[1] };
        }
      }
      if (g.fillCol === 0) { nextCol(g); return addColItem(item); }
      closeGrid(true);
      newPage();
      return addColItem(item);
    }
    /* Reserve a single-column float's slot in the open grid: the column
     * (0 then 1) whose top/bottom slot is free and has room. Deferred
     * (returns false) → the pending queue carries it to the next page. */
    function tryPlaceColFloat(f) {
      ensureGrid();
      var g = page.grid;
      var targetH = remaining();
      var region = f.float.region;   // 'top' | 'bottom'
      var gap = gapForFloat(f);
      var forced = f.float.lock || (pageIsEmpty() && gridIsEmpty(g));
      for (var ci = 0; ci < 2; ci++) {
        if (f.float.col != null && ci !== f.float.col) continue;   // a fixed column (the PNAS fact box)
        var c = g.cols[ci];
        if (region === 'bottom' ? c.floatBottom : c.floatTop) continue;
        var otherH = region === 'bottom' ? fTopH(c) : fBotH(c);
        var need = c.itemsH + otherH + f.h + gap;
        if (!forced) {
          if (need > targetH) continue;
          if (gridFloatArea(g) + f.h + gap > cap * floatFrac(f)) continue;
        }
        var slot = { items: [f], span: 'column', h: f.h, gap: gap };
        if (region === 'bottom') c.floatBottom = slot; else c.floatTop = slot;
        addFootnotes(f);
        if (need > cap) page.overflow = true;
        return true;
      }
      return false;
    }
    function addFootnotes(item) {
      item.footnotes.forEach(function (f) {
        page.footnotes.push(f.node);
        page.footH += f.h;
      });
    }
    function noteH(item) {
      return item.footnotes.reduce(function (s, f) { return s + f.h; }, 0);
    }
    function pageIsEmpty() {
      return page.usedH === 0 && (!page.run || !page.run.items.length) &&
             !(page.grid && !gridIsEmpty(page.grid)) &&
             !page.segments.length && !page.topFloats.length && !page.bottomFloats.length;
    }

    /* Try to place float f in the current page's top/bottom band.
     * Column-span floats pair two-up into one row (LaTeX per-column
     * float areas); full-span floats own a full-width row. The
     * FLOAT_MAX_FRAC budget keeps text from starving; a LOCKED float
     * or a float opening an EMPTY page places regardless (guaranteed
     * progress for the trailing drain). */
    function tryPlaceFloat(f) {
      if (f.notBeforePage != null && pages.length - 1 < f.notBeforePage) return false;
      var rows = f.float.region === 'bottom' ? page.bottomFloats : page.topFloats;
      var fH = noteH(f);
      var last = rows[rows.length - 1];
      var join = f.float.span === 'column' && cols === 2 && last &&
                 last.span === 'column' && last.items.length < 2;
      /* V3.408 — per-row gap (preset base + per-float nudge). A join's
       * delta covers both the height growth AND any gap growth (the
       * paired row's gap = max of its floats'), keeping the band
       * accumulators exact. */
      var gap = gapForFloat(f);
      var delta = join
        ? Math.max(0, f.h - last.h) + Math.max(0, gap - last.gap)
        : f.h + gap;
      var forced = f.float.lock || pageIsEmpty();
      if (!forced) {
        if (page.topH + page.bottomH + delta > cap * floatFrac(f)) return false;
        if (delta + fH > remaining() - openFlowH()) return false;
      }
      if (join) {
        last.items.push(f);
        last.h = Math.max(last.h, f.h);
        last.gap = Math.max(last.gap, gap);
      } else {
        rows.push({
          span: (f.float.span === 'page' || cols === 1) ? 'page' : 'column',
          items: [f],
          h: f.h,
          gap: gap,
        });
      }
      if (f.float.region === 'bottom') page.bottomH += delta; else page.topH += delta;
      addFootnotes(f);
      /* Forced placements (lock / empty page) can exceed the page —
       * the user's explicit choice, but flag it. */
      if (delta > cap || page.topH + page.bottomH > cap) page.overflow = true;
      return true;
    }
    function placeFloat(f) {
      /* V3.908 — a float-page float is never set in a band; it waits in
       * the ordered queue until a page break turns it into its own page. */
      if (f.float.region === 'float-page') return false;
      /* V3.908 — [tbp]: top of the current column/page, else its bottom. */
      if (f.float.region === 'auto') {
        f.float.region = 'top';
        if (placeFloat(f)) return true;
        f.float.region = 'bottom';
        if (placeFloat(f)) return true;
        f.float.region = 'auto';
        return false;
      }
      /* V3.421 — route: single-column floats in a 2-col layout flow
       * INTO a column (in-column float); spanning starred floats and
       * every 1-col float claim a full-width top/bottom band. */
      return (cols === 2 && f.float.span === 'column')
        ? tryPlaceColFloat(f) : tryPlaceFloat(f);
    }
    function drainFloats() {
      /* STRICT source order (LaTeX's float queue): stop at the first
       * float that doesn't fit, so a page can never show Figure 3 in a
       * band while Figure 2 is still deferred. Progress stays
       * guaranteed — a fresh page force-places its first pending. */
      while (pending.length) {
        if (!placeFloat(pending[0])) break;
        pending.shift();
      }
    }
    function flushFloatPages() {
      /* V3.908 — LaTeX keeps floats IN ORDER: a [p] float becomes a float
       * page only when it reaches the head of the queue (an earlier figure
       * still waiting holds it back), and never on the page where it
       * occurs. */
      while (pending.length && pending[0].float.region === 'float-page' &&
             !(geom.look && cols === 2 && pending[0].float.span === 'column') &&   // V3.909 — a float COLUMN instead
             (pending[0].notBeforePage == null || pages.length >= pending[0].notBeforePage)) {
        floatPageQueue.push(pending.shift());
      }
      /* V3.908 — LaTeX's \@tryfcolumn: at the start of every page, waiting
       * floats that together fill at least the float-page fraction of the
       * page (\dblfloatpagefraction for spanning floats in two columns,
       * \floatpagefraction otherwise) are set as a page of floats, before
       * any of them is tried at the top of the new page. Journal looks
       * only (the legacy preview keeps its band behaviour). */
      if (geom.look) {
        var fl = geom.look.floats || {};
        for (;;) {
          var take = [], hsum = 0;
          for (var qi = 0; qi < pending.length; qi++) {
            var pf = pending[qi];
            if (pf.notBeforePage != null && pages.length < pf.notBeforePage) break;
            if (cols === 2 && pf.float.span !== 'page' && pf.float.region !== 'float-page') break;
            var add = pf.h + (take.length ? gapForFloat(pf) : 0);
            if (hsum + add > cap) break;
            take.push(pf); hsum += add;
          }
          var frac = cols === 2 ? (fl.dblfloatpagefraction || 0.5) : (fl.floatpagefraction || 0.5);
          if (!take.length || hsum < frac * cap) break;
          pending.splice(0, take.length);
          var fpg = makePage();
          fpg.isFloatPage = true;
          take.forEach(function (tf) {
            fpg.topFloats.push({ span: (tf.float.span === 'page' || cols === 1) ? 'page' : 'column', items: [tf], h: tf.h, gap: gapForFloat(tf) });
            fpg.topH += tf.h + gapForFloat(tf);
            tf.footnotes.forEach(function (nn) { fpg.footnotes.push(nn.node); fpg.footH += nn.h; });
          });
          pages.push(fpg);
        }
      }
      while (floatPageQueue.length) {
        var f = floatPageQueue.shift();
        var fp = makePage();
        fp.isFloatPage = true;
        /* Slot span mirrors the float's MEASURED container — a
         * column-width figure keeps a column-width slot (a 100% slot
         * would inflate its rendered width past its measured height). */
        fp.topFloats.push({
          span: (f.float.span === 'page' || cols === 1) ? 'page' : 'column',
          items: [f],
          h: f.h,
          gap: gapForFloat(f),
        });
        fp.topH = f.h + gapForFloat(f);
        if (f.h > cap) fp.overflow = true;
        f.footnotes.forEach(function (n) { fp.footnotes.push(n.node); fp.footH += n.h; });
        pages.push(fp);
      }
    }
    function newPage() {
      /* Close the outgoing page's open flow first. The main loop already
       * closes the run/grid before its own newPage() calls (no-op here),
       * but the trailing-float drain opens grids on fresh pages via
       * tryPlaceColFloat and relies on this to emit them as segments. */
      if (page) closeRun();
      flushFloatPages();     // dedicated float sheets slot between text pages
      page = makePage();
      pages.push(page);
      if (geom.look && cols === 2) {
        ensureGrid();
        if (tryFloatColumn(page.grid.cols[0])) nextCol(page.grid);
        if (gridIsEmpty(page.grid)) page.grid = null;
      }
      drainFloats();         // deferred floats land at the fresh page's bands
    }

    /* ── V3.912 — wrapped figures, set the way wrapfig 3.6 sets them
     * (one-column looks; the .tex writes \begin{wrapfigure}{R|L}{w}):
     * the figure waits for the next paragraph start; there, if its box
     * (depth + 1.5\baselineskip + 2\intextsep) fits the room left on the
     * page it is set beside the next ⌊(size + 1.1\baselineskip) /
     * \baselineskip⌋ − 1 lines, each \linewidth − width − \columnsep
     * wide, across paragraphs and headings; if not, it waits for a later
     * paragraph start, unless less than a line is left, when the page
     * breaks and it opens the next one. */
    var WRAP_TEX = !!(geom.look && cols === 1 && window.PaperLook && window.PaperLook.lineOff);
    var wrapQ = [], wrapAct = null;
    var PAR_START = { paragraph: 1, heading: 1, subheading: 1, list: 1, equation: 1 };
    function wrapGeom() {
      var lk = geom.look, PXb = 4 / 3;
      var fnt = window.PaperLook.FONTS[lk.fonts.text] || {};
      return {
        lead: geom.leadPx,
        is: ((lk.floats || {}).intextsep || 0) * PXb,
        ex14: 1.4 * (fnt.xh || 0.45) * lk.body.size * PXb,
        gap: (lk.colsep != null ? lk.colsep : 10) * PXb,
        base: window.PaperLook.lineOff(lk, { family: 'text', size: lk.body.size, lead: lk.body.lead }) * PXb,
        dp: (fnt.desc || 0.25) * lk.body.size * PXb,
        ht: (fnt.ht || 0.7) * lk.body.size * PXb,
      };
    }
    /* \WFclear: a figure still waiting when the next wrapped figure begins
     * is set where it is, as a plain box after a \bigskip, with no text
     * beside it (wrapfig's "Collision between wrapping environments") */
    function wrapDump(f, atEndDoc) {
      var W = wrapGeom();
      f.node.classList.add('pdv-wrap-dumped');
      /* between the line boxes around it: \bigskip, \baselineskip less
       * the last line's depth, the box's depth (height − 1.4ex),
       * \lineskip, the next line's height, less one \baselineskip (XeTeX
       * gives every line the face's descender as depth and ascender as
       * height — measured: 283.84 bp for this sum on a Tectonic compile) */
      var big = 12 * 0.99626 * 4 / 3;
      var dumpH = big - W.dp + (f.figH - W.ex14) + 0.99626 * 4 / 3 + W.ht;
      var mt = big - W.dp - W.ex14 + W.base;
      /* a box like any other: one that does not fit starts the next page,
       * where the \bigskip before it is discarded */
      if (dumpH > remaining() - page.run.sumH + 0.01 && (page.run.sumH > 0 || page.usedH > 0)) {
        closeRun(); newPage(); page.run = { items: [], sumH: 0 };
      }
      if (page.run.sumH === 0 && page.usedH === 0) { dumpH -= big; mt = Math.max(0, mt - big); }
      f.node.style.marginTop = mt.toFixed(2) + 'px';
      f.node.style.marginBottom = (dumpH - mt - f.figH).toFixed(2) + 'px';   // may be negative: the next line box overlaps
      page.run.items.push({ node: f.node, type: 'col', h: dumpH, footnotes: [], blockKind: 'wrapfig',
        sectionId: f.sectionId, blockId: f.blockId, float: null });
      page.run.sumH += dumpH;
      addFootnotes(f);
      if (state.wrapReport && f.blockId) state.wrapReport[f.blockId] = { state: atEndDoc ? 'end' : 'collision', page: pages.length };
    }
    function wrapTryPlace() {
      if (!wrapQ.length || wrapAct) return;
      var W = wrapGeom();
      var f = wrapQ[0];
      var size = f.figH - W.ex14 + 1.5 * W.lead + 2 * W.is;            // \WF@size
      var room = remaining() - page.run.sumH;                           // \pagegoal − \pagetotal
      if (size > room + 0.01) {
        if (room >= W.lead) { f.held = true; return; }                  // floats on (R/L)
        closeRun(); newPage(); page.run = { items: [], sumH: 0 };       // \pagebreak, then here
      }
      var atTop = page.usedH === 0 && page.run.sumH === 0;
      if (atTop) size -= W.is;
      var count = Math.floor((size + 1.1 * W.lead) / W.lead + 1e-6);   // \c@WF@wrappedlines
      var anchor = document.createElement('div');
      anchor.className = 'pdv-wrap-anchor';
      // wrapfig's numbers, in bp (read by the Paper Lab against the .log)
      anchor.dataset.wfSize = (size * 0.75).toFixed(2);
      anchor.dataset.wfLines = String(count - 1);
      anchor.dataset.wfRoom = (room * 0.75).toFixed(2);
      f.node.style.top = ((atTop ? 0 : W.is) + W.base - W.ex14).toFixed(2) + 'px';
      f.node.style.left = f.side === 'left' ? '0px' : '';
      f.node.style.right = f.side === 'left' ? '' : '0px';
      anchor.appendChild(f.node);
      page.run.items.push({ node: anchor, type: 'col', h: 0, footnotes: [], blockKind: 'wrapfig',
        sectionId: f.sectionId, blockId: f.blockId, float: null });
      addFootnotes(f);
      wrapQ.shift();
      if (state.wrapReport && f.blockId) {
        state.wrapReport[f.blockId] = { state: f.held ? 'held' : 'here', page: pages.length, lines: count - 1 };
      }
      if (count > 1) {
        wrapAct = { left: count - 1, narrow: geom.colW - f.figW - W.gap,
          offset: f.side === 'left' ? f.figW + W.gap : 0 };
      }
    }
    function wrapApply(item) {
      if (!wrapAct) return;
      var lines;
      if (item.blockKind === 'paragraph' && item.node && item.node._ptsSrc != null) {
        lines = _setWrappedPara(item, wrapAct.left, wrapAct.narrow, wrapAct.offset, geom);
      } else if (item.blockKind === 'heading' || item.blockKind === 'subheading') {
        lines = _setWrappedHeading(item, wrapAct.left, wrapAct.narrow, wrapAct.offset, geom);
      } else {
        lines = Math.max(1, Math.round(item.h / geom.leadPx));
      }
      wrapAct.left -= lines;                                            // \c@WF@wrappedlines − \prevgraf
      if (wrapAct.left < 1) wrapAct = null;                             // \WF@finale
    }

    newPage();
    /* V3.419 — indexed WORK QUEUE (not forEach): a split paragraph's
     * remainder splices in as the next item, so it re-enters the normal
     * flow — including splitting AGAIN when it exceeds the next page
     * (multi-page paragraphs). */
    var work = items.slice();
    var leadPx = geom.leadPx || 0;
    for (var wi = 0; wi < work.length; wi++) {
      var item = work[wi];
      if (pages.length > MAX_SHEETS) continue;
      /* V3.908 — a stand-alone front page (Nature family): the first body
       * item starts a new page. */
      if (item.breakBefore && !pageIsEmpty()) { closeRun(); newPage(); }
      if ((item.blockKind === 'heading' || item.blockKind === 'subheading') && leadPx) {
        var nx = work[wi + 1];
        item.keepNextH = nx && !nx.float ? Math.min(nx.h, 2 * leadPx) : 0;
        /* V3.912 — headings in a row never break between them (LaTeX's
         * \@nobreak), so a heading keeps the whole chain and the first two
         * lines after it */
        if (geom.look && nx && (nx.blockKind === 'heading' || nx.blockKind === 'subheading')) {
          var chainH = 0, cj = wi + 1;
          while (work[cj] && !work[cj].float && (work[cj].blockKind === 'heading' || work[cj].blockKind === 'subheading')) {
            chainH += work[cj].h; cj++;
          }
          item.keepNextH = chainH + (work[cj] && !work[cj].float ? Math.min(work[cj].h, 2 * leadPx) : 0);
        }
        /* V3.912 — wrapfig: a waiting figure that finds less than a line
         * left at the paragraph after this heading forces \pagebreak there,
         * which overrides keep-with-next — the heading ends this page */
        if (WRAP_TEX && wrapQ.length && !wrapAct && nx && nx.blockKind === 'paragraph' && page.run) {
          var roomAfter = remaining() - page.run.sumH - item.h;
          var Wk = wrapGeom();
          if (roomAfter >= 0 && roomAfter < Wk.lead &&
              wrapQ[0].figH - Wk.ex14 + 1.5 * Wk.lead + 2 * Wk.is > roomAfter) item.keepNextH = 0;
        }
      }
      if (item.float) {
        if (item.float.region === 'float-page') {
          item.notBeforePage = pages.length;   // V3.908 — next page at the earliest, in order
          pending.push(item);
          continue;
        }
        /* V3.908 — LaTeX never sets a page-wide float (figure*) on the
         * page where it occurs: the top of the NEXT page at the earliest.
         * The queue stays in strict order, so later floats wait too (the
         * kernel's two-column float ordering since 2015). */
        if (cols === 2 && item.float.span === 'page') item.notBeforePage = pages.length;
        pending.push(item);
        /* May land on the CURRENT page — LaTeX [t] floats backward to
         * the top of the page containing their source, [b] to its
         * bottom. openFlowH() inside tryPlaceFloat keeps it safe. */
        drainFloats();
        continue;
      }
      var fH = noteH(item);
      /* V3.401 — remember each page's first REAL block so a band drop on
       * page K can reorder the dragged float to just before it. */
      if (item.blockId && !page.firstFlow) {
        page.firstFlow = { sectionId: item.sectionId, blockId: item.blockId };
      }
      if (item.type === 'full') {
        closeRun();
        if ((page.usedH > 0 || page.topH + page.bottomH > 0) && item.h + fH > remaining()) {
          newPage();
          if (item.blockId && !page.firstFlow) {
            page.firstFlow = { sectionId: item.sectionId, blockId: item.blockId };
          }
        }
        page.segments.push({ type: 'full', node: item.node, height: item.h });
        page.usedH += item.h;
        page.lastMb = item.mb || 0;
        /* Band-aware: a full item landing under a fresh page's drained
         * band can overflow even when the item alone fits the cap. */
        if (item.h + fH > cap ||
            page.usedH + page.footH + page.topH + page.bottomH > cap) {
          page.overflow = true;
        }
        addFootnotes(item);
      } else if (cols === 2) {
        /* V3.421 — per-column flow. addColItem fills column 0 then
         * column 1, splitting the crossing paragraph and (on both
         * columns full) breaking the page; its split remainder splices
         * back into the work queue exactly like the 1-col path. */
        var resC = addColItem(item);
        if (resC && resC.split) work.splice(wi + 1, 0, resC.split);
      } else {
        if (!page.run) page.run = { items: [], sumH: 0 };
        /* V3.912 — wrapfig: a wrapped figure waits for a paragraph start;
         * a paragraph that starts while it wraps is set narrower */
        if (WRAP_TEX && item.wrapFig) {
          while (wrapQ.length) wrapDump(wrapQ.shift());
          wrapQ.push(item);
          continue;
        }
        if (WRAP_TEX && PAR_START[item.blockKind] && item.part !== 2) {
          /* a heading is never where a figure is placed (the look gives
           * headings a 1sp hanging indent, which wrapfig refuses) */
          if (item.blockKind !== 'heading' && item.blockKind !== 'subheading') wrapTryPlace();
          wrapApply(item);
        }
        var runCap = cols * (remaining() - fH);
        var hEff = runEff(item);   // V3.912 — page-top space discarded, adjoining spaces collapsed
        var fits = (page.run.sumH + hEff + (item.keepNextH || 0)) <= runCap;   // V3.908 — headings keep with next
        var pageEmpty = pageIsEmpty();
        /* V3.419 — CONTINUOUS FLOW. A paragraph that crosses the page
         * boundary splits at a line break: the first lines fill this
         * page's remaining run capacity, the remainder splices in as
         * the next work item (block-atomic packing stranded white space
         * at every page end — this is LaTeX's own page-break model). */
        if (!fits && item.blockKind === 'paragraph') {
          var parts = _splitColItem(item, runCap - page.run.sumH, geom);
          if (parts) {
            runPut(parts[0]);
            addFootnotes(parts[0]);
            work.splice(wi + 1, 0, parts[1]);
            continue;
          }
        }
        if (fits || pageEmpty) {
          runPut(item);
          addFootnotes(item);
          if (pageEmpty && item.h > cols * cap) page.overflow = true;
        } else {
          closeRun();
          newPage();
          page.run = { items: [], sumH: 0 };
          runPut(item);
          addFootnotes(item);
          if (item.h > cols * cap) page.overflow = true;
        }
      }
    }
    /* a wrapped figure no paragraph followed: \AtEndDocument{\WFclear} */
    while (WRAP_TEX && wrapQ.length) {
      if (!page.run) page.run = { items: [], sumH: 0 };
      wrapDump(wrapQ.shift(), true);
    }
    closeRun();
    atEnd = true;

    /* Trailing floats: keep opening pages until everything lands.
     * tryPlaceFloat force-places on an empty page, so every iteration
     * consumes at least one pending float. */
    flushFloatPages();
    var guard = 0;
    while (pending.length && pages.length < MAX_SHEETS && guard++ < MAX_SHEETS) {
      var before = pending.length;
      newPage();
      if (pending.length >= before) {
        /* Safety net — unreachable in theory (empty pages force-place). */
        var f0 = pending.shift();
        page.topFloats.push({ span: 'page', items: [f0], h: f0.h, gap: gapForFloat(f0) });
        page.topH += f0.h + gapForFloat(f0);
        page.overflow = true;
      }
    }
    /* Emit the final page's open grid (a trailing column float may have
     * opened one on the last drain page). */
    closeRun();

    if (pages.length > MAX_SHEETS) {
      pages = pages.slice(0, MAX_SHEETS);
      pages.truncated = true;
    }
    /* Floats that never landed (page cap reached exactly) must not
     * vanish silently — surface the same truncation notice. */
    if (pending.length || floatPageQueue.length) pages.truncated = true;
    _recordRects(pages, geom);
    return pages;
  }

  /* V3.397 — record every page's region rectangles in PAGE-LOCAL px
   * (origin = sheet top-left; content starts at geom.margin). Float
   * rects are EXACT (fixed measured heights + band accumulation); the
   * text-region rect is schematic (multicol balances short of the
   * estimate — cosmetic for the overlay). Consumed by the R3 overlay
   * with zero re-measurement. */
  function _recordRects(pages, geom) {
    var m = geom.mL != null ? geom.mL : geom.margin;      // x origin (left margin)
    var mt = geom.mT != null ? geom.mT : geom.margin;     // y origin (top margin)
    var mb = geom.mB != null ? geom.mB : geom.margin;
    pages.forEach(function (page) {
      var floats = [];
      function rowRects(rows, startY) {
        var y = startY;
        rows.forEach(function (row) {
          var x = m;
          row.items.forEach(function (f, i) {
            var w = row.span === 'page' ? geom.bodyW : geom.colW;
            if (row.span === 'column' && i === 1) x = m + geom.colW + geom.colGap;
            floats.push({
              blockId: f.blockId || null, kind: f.blockKind || '',
              region: f.float ? f.float.region : 'top',
              span: row.span, x: x, y: y, w: w, h: f.h,
            });
          });
          y += row.h + (row.gap != null ? row.gap : BLOCK_GAP);
        });
        return y;
      }
      var topEnd = rowRects(page.topFloats, mt);
      var footTop = geom.pageH - mb - page.footH;
      var bottomH2 = page.bottomFloats.reduce(function (s, r) { return s + r.h + (r.gap != null ? r.gap : BLOCK_GAP); }, 0);
      rowRects(page.bottomFloats, footTop - bottomH2);
      var textY = topEnd;
      var textH = Math.max(0, (footTop - bottomH2) - textY);
      /* V3.421 — in-column float rects: walk the text region's segments
       * so each column figure/table box lands at its true Y (its column
       * top for [t], the column bottom for [b]). Same `floats` array the
       * overlay colors and _pageIndexOfFloat scans. */
      var segY = textY;
      page.segments.forEach(function (seg) {
        var h = seg.height || 0;
        if (seg.type === 'colgrid') {
          seg.cols.forEach(function (c, ci) {
            var cx = m + (ci === 1 ? geom.colW + geom.colGap : 0);
            if (c.floatTop) {
              var ft = c.floatTop.items[0];
              floats.push({ blockId: ft.blockId || null, kind: ft.blockKind || '',
                region: 'top', span: 'column', x: cx, y: segY, w: geom.colW, h: c.floatTop.h });
            }
            if (c.floatBottom) {
              var fb = c.floatBottom.items[0];
              floats.push({ blockId: fb.blockId || null, kind: fb.blockKind || '',
                region: 'bottom', span: 'column', x: cx, y: segY + h - c.floatBottom.h, w: geom.colW, h: c.floatBottom.h });
            }
          });
        }
        segY += h;
      });
      page.rects = {
        margin: { x: m, y: mt, w: geom.bodyW, h: geom.bodyH },
        cols: geom.cols === 2
          ? [{ x: m, y: textY, w: geom.colW, h: textH },
             { x: m + geom.colW + geom.colGap, y: textY, w: geom.colW, h: textH }]
          : [{ x: m, y: textY, w: geom.bodyW, h: textH }],
        text: { x: m, y: textY, w: geom.bodyW, h: textH },
        foot: page.footH ? { x: m, y: footTop, w: geom.bodyW, h: page.footH } : null,
        floats: floats,
      };
    });
  }

  /* ── Layout region overlay (V3.399, R3) ─────────────────────
   * A per-sheet absolutely-positioned layer drawn from page.rects —
   * margin frame, column guides, text region, footnote strip, and one
   * color-coded box per float area (figures blue, tables purple).
   * Mounted on every render, toggled by a class on .pdv-scale (pure
   * CSS, free once mounted). Clicking a float area while the overlay
   * is on highlights its region; no writes (R4 adds interaction). */

  function _toggleLayoutViz() {
    state.layoutViz = !state.layoutViz;
    if (!state.layoutViz) state.layoutSelectedId = null;
    /* V3.401 — for editors the overlay IS the interactive layout
     * session: drags enabled, live loop origin-discriminated, heights
     * memoized (content is frozen — remote edits banner + defer). */
    var wasSession = state.layoutSession;
    state.layoutSession = state.layoutViz && _pe().isEditable();
    if (state.layoutSession) {
      state.measureCache = {};
    } else if (wasSession) {
      state.measureCache = null;
      _cancelDrag();
      if (state.layoutRemotePending) {
        state.layoutRemotePending = false;
        _hideRemoteBanner();
        state.forceRender = true;
        scheduleRender(0);       // absorb the collaborator's edits now
      }
    }
    _syncLayoutViz();
  }

  function _syncLayoutViz() {
    if (state.scaleEl) {
      state.scaleEl.classList.toggle('pdv-regions-on', state.layoutViz);
      /* V3.424 — session class on the sheet ancestor too, so editable
       * regions can show a grab cursor (drag is session-gated anyway). */
      state.scaleEl.classList.toggle('pdv-session', state.layoutSession);
    }
    if (state.overlayEl) state.overlayEl.classList.toggle('pdv-session', state.layoutSession);
    var btn = state.overlayEl && state.overlayEl.querySelector('#pdv-layout');
    if (btn) btn.classList.toggle('pdv-layout-on', state.layoutViz);
    /* V3.406 — the color-key legend follows the viz toggle. */
    var legend = state.overlayEl && state.overlayEl.querySelector('.pdv-legend');
    if (legend) legend.hidden = !state.layoutViz;
    _applyLayoutSelection();
  }

  function _showRemoteBanner() {
    if (!state.overlayEl || state.overlayEl.querySelector('.pdv-remote-banner')) return;
    var b = document.createElement('div');
    b.className = 'pdv-remote-banner';
    b.textContent = 'A collaborator edited the paper — exit ⬒ Layout to refresh.';
    state.overlayEl.appendChild(b);
  }
  function _hideRemoteBanner() {
    var b = state.overlayEl && state.overlayEl.querySelector('.pdv-remote-banner');
    if (b) b.remove();
  }

  function _applyLayoutSelection() {
    if (!state.scaleEl) return;
    state.scaleEl.querySelectorAll('.pdv-region-selected').forEach(function (el) {
      el.classList.remove('pdv-region-selected');
    });
    _detachResizeHandles();
    if (!state.layoutViz) return;
    if (state.layoutSelectedId) {
      state.scaleEl.querySelectorAll(
        '.pdv-region-float[data-block-id="' + state.layoutSelectedId + '"]'
      ).forEach(function (el) { el.classList.add('pdv-region-selected'); });
      /* V3.402 — in a session, a selected FIGURE grows resize handles. */
      if (state.layoutSession) {
        var el = state.deskEl && state.deskEl.querySelector(
          '.pdv-figure[data-block-id="' + state.layoutSelectedId + '"]');
        if (el) _attachResizeHandles(el);
      }
      return;
    }
    /* V3.424 — a selected section (heading/boxed special) draws its
     * colored boundary frame. Text sections reflow in LaTeX, so the
     * frame carries no resize handles — it marks the region you grab to
     * MOVE it (drag the colored region → reorder the whole section). */
    if (state.layoutSelectedSecId && state.layoutSession) {
      var secEl = state.deskEl && state.deskEl.querySelector(
        '.pdv-heading[data-section-id="' + state.layoutSelectedSecId + '"], ' +
        '.pdv-significance[data-section-id="' + state.layoutSelectedSecId + '"]');
      if (secEl) _attachSectionFrame(secEl);
    }
  }

  /* V3.424 — a visual boundary frame around a selected section's
   * heading/box (sheet-local, zoom-corrected). Pointer-transparent: the
   * drag is initiated from the region element itself (_onDeskPointerDown),
   * so the frame never intercepts clicks. No resize handles — moving is
   * the only honest lever for a reflowing text section. */
  function _attachSectionFrame(secEl) {
    var sheet = secEl.closest && secEl.closest('.pdv-sheet');
    if (!sheet) return;
    var frame = document.createElement('div');
    frame.className = 'pdv-area-frame pdv-area-frame-move';
    frame.title = 'Drag this section to reorder it';
    sheet.appendChild(frame);
    state.areaFrameEl = frame;
    _syncSectionFrame(secEl);
  }
  function _syncSectionFrame(secEl) {
    var frame = state.areaFrameEl;
    var sheet = secEl && secEl.closest && secEl.closest('.pdv-sheet');
    if (!frame || !sheet) return;
    var k = state.zoomK || 1;
    var br = secEl.getBoundingClientRect();
    var sr = sheet.getBoundingClientRect();
    frame.style.left = ((br.left - sr.left) / k - 3) + 'px';
    frame.style.top = ((br.top - sr.top) / k - 3) + 'px';
    frame.style.width = (br.width / k + 6) + 'px';
    frame.style.height = (br.height / k + 6) + 'px';
  }

  /* ── Resize handles (V3.402 R5; box model V3.405) ────────────
   * A selected figure in a layout session grows handles on its BOX:
   * E/W size the box width (snapping to the journal's canonical
   * figure sizes, span crossover past the column edge), S caps the
   * image height (the image auto-fits around the caption via
   * PaperFigFit — the user never touches the caption), SE does both.
   * Dragging is visual-only (style mutation through the same fit());
   * ONE transact on release; Esc cancels. */
  var _resize = null;  // V3.405 box-model resize state — see _onResizeDown

  function _detachResizeHandles() {
    if (!state.deskEl) return;
    /* V3.420 — the handles ride the area boundary frame. */
    state.deskEl.querySelectorAll('.pdv-area-frame').forEach(function (f) { f.remove(); });
    state.areaFrameEl = null;
    state.deskEl.querySelectorAll('.pdv-resize-h, .pdv-resize-s, .pdv-resize-se').forEach(function (h) { h.remove(); });
    state.deskEl.querySelectorAll('.pdv-resizing').forEach(function (el) { el.classList.remove('pdv-resizing'); });
  }

  function _attachResizeHandles(figEl) {
    /* V3.420 — you resize the AREA, never the figure. A kind-colored
     * boundary frame is drawn around the figure's allocation (its box:
     * image + caption) as a sheet-level overlay, and the handles ride
     * the FRAME's edges: E/W size the area width, S the area height,
     * SE both — the figure inside auto-fits to match (PaperFigFit:
     * image maximized around the caption). The drag math is unchanged
     * (it still mutates the fig box + img styles); the frame re-tracks
     * the live bounds every move. */
    var box = figEl.querySelector('.pdv-fig-box');
    var sheet = figEl.closest && figEl.closest('.pdv-sheet');
    if (!box || !sheet) return;
    var frame = document.createElement('div');
    frame.className = 'pdv-area-frame';
    ['e', 'w'].forEach(function (side) {
      var h = document.createElement('div');
      h.className = 'pdv-resize-h pdv-resize-' + side;
      h.title = 'Drag the area boundary — the figure resizes to fit it';
      h.addEventListener('pointerdown', function (ev) { _onResizeDown(ev, figEl, side); });
      frame.appendChild(h);
    });
    var s = document.createElement('div');
    s.className = 'pdv-resize-s';
    s.title = 'Drag the area boundary — the image auto-fits, the caption stays';
    s.addEventListener('pointerdown', function (ev) { _onResizeDown(ev, figEl, 's'); });
    frame.appendChild(s);
    var se = document.createElement('div');
    se.className = 'pdv-resize-se';
    se.title = 'Drag the area corner — the figure fits the area you give it';
    se.addEventListener('pointerdown', function (ev) { _onResizeDown(ev, figEl, 'se'); });
    frame.appendChild(se);
    sheet.appendChild(frame);
    state.areaFrameEl = frame;
    _syncAreaFrame(figEl);
  }

  /* Position the boundary frame over the figure's CURRENT allocation
   * (sheet-local coords, zoom-corrected). Called on attach and on every
   * live resize step so the boundary is what the user sees moving. */
  function _syncAreaFrame(figEl) {
    var frame = state.areaFrameEl;
    var box = figEl && figEl.querySelector && figEl.querySelector('.pdv-fig-box');
    var sheet = figEl && figEl.closest && figEl.closest('.pdv-sheet');
    if (!frame || !box || !sheet) return;
    var k = state.zoomK || 1;
    var br = box.getBoundingClientRect();
    var sr = sheet.getBoundingClientRect();
    frame.style.left = ((br.left - sr.left) / k - 3) + 'px';
    frame.style.top = ((br.top - sr.top) / k - 3) + 'px';
    frame.style.width = (br.width / k + 6) + 'px';
    frame.style.height = (br.height / k + 6) + 'px';
  }

  /* Snap targets in CONTAINER px: journal canonical sizes (mm → px at
   * 96 dpi, or fractions for preprints) ∪ the width presets. */
  function _snapTargets(containerW) {
    var targets = [];
    function add(px, spec, sizeKey, label) {
      targets.push({ px: px, spec: spec, sizeKey: sizeKey, label: label });
    }
    var rules = (window.PaperLayout && window.PaperLayout.getRules)
      ? window.PaperLayout.getRules(state.template || {}) : {};
    var MM = 96 / 25.4;
    var geom = state.lastGeom;
    if (rules.figure_widths_mm) {
      var mm = rules.figure_widths_mm;
      if (mm.single) add(Math.min(mm.single * MM, containerW), '\\linewidth', 'single', mm.single + ' mm — 1 column');
      /* oneAndHalf / double exceed a column — they surface via the span
       * crossover (page container), added below when container = bodyW. */
      if (geom && containerW >= geom.bodyW - 2) {
        if (mm.oneAndHalf && mm.double) {
          var frac = Math.round(mm.oneAndHalf / mm.double * 100) / 100;
          add(mm.oneAndHalf * MM, frac + '\\textwidth', 'oneAndHalf', mm.oneAndHalf + ' mm — 1.5 column');
        }
        if (mm.double) add(Math.min(mm.double * MM, containerW), '\\textwidth', 'double', mm.double + ' mm — full width');
      }
    }
    if (rules.figure_widths_frac) {
      var fr = rules.figure_widths_frac;
      if (fr.single) add(containerW * fr.single, fr.single + '\\linewidth', 'single', Math.round(fr.single * 100) + '% — single');
      if (fr.oneAndHalf) add(containerW * fr.oneAndHalf, fr.oneAndHalf + '\\linewidth', 'oneAndHalf', Math.round(fr.oneAndHalf * 100) + '% — 1.5');
    }
    [[1, '\\linewidth', 'Full column'], [0.9, '0.9\\linewidth', '90% of column'],
     [0.8, '0.8\\linewidth', '80% of column'], [0.5, '0.5\\linewidth', 'Half column']].forEach(function (p) {
      add(containerW * p[0], p[1], p[0] === 1 ? 'single' : 'custom', p[2]);
    });
    return targets;
  }

  /* V3.405 — vertical snap targets, in IMAGE-height px: the journal's
   * figure-area max (render_hints.layout.figure_max_height_mm) and the
   * natural height (= release the cap entirely). */
  function _snapTargetsV(boxWpx, aspect) {
    var targets = [];
    var MM = 96 / 25.4;
    var rules = (window.PaperLayout && window.PaperLayout.getRules)
      ? window.PaperLayout.getRules(state.template || {}) : {};
    if (rules.figure_max_height_mm) {
      targets.push({ px: rules.figure_max_height_mm * MM, mm: rules.figure_max_height_mm,
                     label: rules.figure_max_height_mm + ' mm — page max', release: false });
    }
    if (aspect) {
      targets.push({ px: boxWpx / aspect, mm: null, label: 'Natural — no height cap', release: true });
    }
    return targets;
  }

  /* Esc mid-drag: restore the pointer-down styles, commit nothing. */
  function _cancelResize() {
    var r = _resize;
    if (!r) return;
    document.removeEventListener('pointermove', _onResizeMove);
    document.removeEventListener('pointerup', _onResizeUp);
    if (r.chip) r.chip.remove();
    r.figEl.classList.remove('pdv-resizing');
    r.box.style.width = r.startBoxW;
    if (r.isWrap) r.figEl.style.width = r.startFigW;   // V3.485 — restore the floated width too
    if (r.img) r.img.setAttribute('style', r.startImgCss);
    _resize = null;
    _syncAreaFrame(r.figEl);   // V3.420 — boundary snaps back too
  }

  function _onResizeDown(ev, figEl, side) {
    if (!state.layoutSession || ev.button !== 0) return;
    ev.preventDefault();
    ev.stopPropagation();          // never start a move-drag from a handle
    var box = figEl.querySelector('.pdv-fig-box');
    if (!box) return;
    var img = box.querySelector('.pdv-fig-imgwrap img');
    var capEl = box.querySelector('.pdv-figcap');
    var aspect = parseFloat(figEl.dataset.ar || '') ||
      (img && img.naturalWidth > 0 && img.naturalHeight > 0 ? img.naturalWidth / img.naturalHeight : null);
    var axis = side === 's' ? 'y' : (side === 'se' ? 'xy' : 'x');
    /* Height needs a decoded aspect; without one the S handle is inert
     * and SE degrades to width-only. */
    if (axis === 'y' && (!img || !aspect)) return;
    if (axis === 'xy' && (!img || !aspect)) axis = 'x';
    var chip = document.createElement('div');
    chip.className = 'pdv-drag-chip';
    state.overlayEl.appendChild(chip);
    /* V3.485 — a wrap figure IS sized to a % of the column (the box is
     * 100% of the floated figure), so width resizes the FIGURE and the
     * pct is relative to the column (bodyW), not the shrunk figure. */
    var isWrap = figEl.dataset.anchor === 'wrap';
    var geomNow = state.lastGeom;
    _resize = {
      blockId: figEl.dataset.blockId,
      figEl: figEl, box: box, img: img, side: side, axis: axis,
      isWrap: isWrap,
      containerW: (isWrap && geomNow) ? geomNow.bodyW : figEl.clientWidth,
      startWpx: box.offsetWidth,
      startImgH: img ? img.offsetHeight : 0,
      startCapPx: capEl ? capEl.offsetHeight : 0,
      startFigW: figEl.style.width,
      capGap: capEl ? 6 : 0,
      aspect: aspect,
      startX: ev.clientX, startY: ev.clientY,
      startBoxW: box.style.width,
      startImgCss: img ? (img.getAttribute('style') || '') : '',
      snap: null, vsnap: null, crossover: false, chip: chip,
      liveMaxH: undefined,   // undefined = height untouched this drag
    };
    figEl.classList.add('pdv-resizing');
    document.addEventListener('pointermove', _onResizeMove);
    document.addEventListener('pointerup', _onResizeUp);
  }

  function _onResizeMove(ev) {
    var r = _resize;
    if (!r) return;
    var k = state.zoomK || 1;
    var MM = 96 / 25.4;

    /* ── width axis ── */
    var newW = r.startWpx;
    if (r.axis !== 'y') {
      var dir = r.side === 'w' ? -1 : 1;
      newW = r.startWpx + dir * (ev.clientX - r.startX) / k;
      newW = Math.max(48, Math.min(newW, r.containerW * 1.08));
      var geom = state.lastGeom;
      var canSpan = geom && geom.cols === 2 &&
        (r.figEl.dataset.span || 'column') === 'column';
      r.crossover = !!(canSpan && newW > r.containerW * 1.02);
      r.snap = null;
      if (!r.crossover) {
        var targets = _snapTargets(r.containerW);
        for (var i = 0; i < targets.length; i++) {
          if (Math.abs(newW - targets[i].px) <= 8) { r.snap = targets[i]; newW = targets[i].px; break; }
        }
      }
    }
    var pct = Math.max(5, Math.min(100, Math.round(newW / r.containerW * 100)));
    var boxWpx = pct / 100 * r.containerW;

    /* ── height axis (image cap; the caption is fixed content) ── */
    var vLabel = null;
    if (r.axis !== 'x' && r.aspect) {
      var capBlock = r.startCapPx ? r.capGap + r.startCapPx : 0;
      var newBoxH = (r.startImgH + capBlock) + (ev.clientY - r.startY) / k;
      var cand = Math.max(48, newBoxH - capBlock);   // candidate image height px
      var widthBoundH = boxWpx / r.aspect;
      r.vsnap = null;
      var vt = _snapTargetsV(boxWpx, r.aspect);
      for (var j = 0; j < vt.length; j++) {
        if (Math.abs(cand - vt[j].px) <= 8) { r.vsnap = vt[j]; cand = vt[j].px; break; }
      }
      if ((r.vsnap && r.vsnap.release) || cand >= widthBoundH - 1) {
        r.liveMaxH = null;                            // at/past natural → release the cap
        vLabel = 'Natural — no height cap';
      } else {
        r.liveMaxH = Math.max(13, Math.round(cand / MM));
        vLabel = r.vsnap ? r.vsnap.label : r.liveMaxH + ' mm tall';
      }
    }

    /* ── apply live styles through the shared fit ── */
    /* V3.485 — for a wrap figure the box stays 100%; the FIGURE carries
     * the % width (so the float only claims pct% of the column). */
    if (r.isWrap) r.figEl.style.width = pct + '%';
    else r.box.style.width = pct + '%';
    r.livePct = pct;
    if (r.img && r.aspect && window.PaperFigFit) {
      var capNow = (r.liveMaxH === undefined)
        ? (parseFloat(r.figEl.dataset.h) || null)     // width-only drag keeps the stored cap
        : r.liveMaxH;
      var fr = window.PaperFigFit.fit({ boxWpx: boxWpx, maxHmm: capNow, aspect: r.aspect });
      if (fr.imgHpx != null) {
        r.img.style.width = (Math.round(fr.imgWpx * 10) / 10) + 'px';
        r.img.style.height = (Math.round(fr.imgHpx * 10) / 10) + 'px';
        r.img.style.maxWidth = '100%';
        r.img.style.margin = '0 auto';
        r.img.style.display = 'block';
      }
    }
    r.moved = true;
    _syncAreaFrame(r.figEl);   // V3.420 — the boundary is what moves
    r.chip.style.left = (ev.clientX + 14) + 'px';
    r.chip.style.top = (ev.clientY - 28) + 'px';
    var wLabel = r.crossover
      ? '→ spans both columns (\\textwidth)'
      : (r.snap ? r.snap.label : pct + '% of column');
    r.chip.textContent =
      r.axis === 'y' ? vLabel :
      r.axis === 'x' ? wLabel :
      wLabel + (vLabel ? ' · ' + vLabel : '');
  }

  function _onResizeUp() {
    var r = _resize;
    if (!r) return;
    document.removeEventListener('pointermove', _onResizeMove);
    document.removeEventListener('pointerup', _onResizeUp);
    r.chip.remove();
    r.figEl.classList.remove('pdv-resizing');
    _resize = null;
    if (!r.moved) return;   // plain click on a handle — commit nothing

    /* Commit: full intent + width + size_key in ONE transact (the full
     * write opts legacy blocks in — the V3.395 review rule). */
    var blk = _findLiveBlock(r.blockId);
    if (!blk) return;
    var attrs = blk.get('attrs');
    if (!attrs) return;
    var curAnchor = attrs.get('anchor');
    if (typeof curAnchor !== 'string' || (!FLOAT_REGIONS[curAnchor] && curAnchor !== 'wrap')) curAnchor = 'flow';
    var kv = { anchor: curAnchor, lock: attrs.get('lock') === true };
    /* V3.485 — preserve the wrap side across a width/height commit. */
    if (curAnchor === 'wrap') kv.wrap_side = (attrs.get('wrap_side') === 'left') ? 'left' : 'right';
    if (r.axis === 'y') {
      /* Pure height drag — the width intent is untouched (a stored
       * '89mm' or preset spec must not be rewritten as a rounded
       * fraction). Full-intent rule still applies: anchor/span/lock. */
      kv.span = attrs.get('span') === 'page' ? 'page' : 'column';
    } else if (r.crossover) {
      kv.span = 'page';
      kv.width = '\\textwidth';
      kv.size_key = 'double';
    } else {
      kv.span = attrs.get('span') === 'page' ? 'page' : 'column';
      if (r.snap) {
        kv.width = r.snap.spec;
        kv.size_key = r.snap.sizeKey;
      } else {
        var frac = Math.max(0.05, Math.min(1, (r.livePct || 100) / 100));
        kv.width = (frac === 1 ? '' : (Math.round(frac * 100) / 100)) + '\\linewidth';
        kv.size_key = 'custom';
      }
      /* Shrinking a page-span figure back under the column width
       * returns it to a single column. */
      if (kv.span === 'page' && state.lastGeom && state.lastGeom.cols === 2 &&
          (r.livePct || 100) / 100 * r.containerW < state.lastGeom.colW * 0.98) {
        kv.span = 'column';
      }
    }
    /* V3.405 — image height cap. null = the drag released the cap (at/
     * past natural height) → the key is DELETED, restoring the
     * unconstrained sentinel. undefined = height untouched this drag. */
    var origin = 'fig-width';
    if (r.liveMaxH !== undefined) {
      kv.max_h = r.liveMaxH;
      origin = 'fig-size';
    }
    _writeFigAttrs(r.blockId, kv, origin);
    state.layoutSelectedId = r.blockId;
  }

  /* ── Drag & drop (V3.401, R4) ────────────────────────────────
   * In a layout session, press-and-drag a figure/table area to move it:
   * drop on a page's TOP/BOTTOM strip → anchor there (+ reorder the
   * block to that page); drop on a text block → back into the flow,
   * inserted before it. Visual-only during the drag (fixed-position
   * ghost); ONE set of transacts on release; the session's origin
   * filter keeps the live loop quiet and the explicit
   * scheduleRender(150) repacks once. */
  var _drag = null;   // {blockId, kind, srcEl, ghost, chip, started, startX, startY, target, scrollDir, scrollRaf}

  function _onDeskPointerDown(ev) {
    if (!state.layoutSession || ev.button !== 0) return;
    var area = ev.target.closest && ev.target.closest(
      '.pdv-figure[data-block-id], .pdv-table-wrap[data-block-id]');
    if (area && area.dataset.blockId) {
      ev.preventDefault();   // stop text selection; click still fires
      _drag = {
        blockId: area.dataset.blockId,
        kind: area.dataset.blockKind || 'figure',
        srcEl: area,
        startX: ev.clientX, startY: ev.clientY,
        started: false, ghost: null, chip: null, target: null,
        scrollDir: 0, scrollRaf: null,
      };
      document.addEventListener('pointermove', _onDragMove);
      document.addEventListener('pointerup', _onDragUp);
      return;
    }
    /* V3.424 — grab a section by its colored region (heading / boxed
     * special) to reorder the whole section. A no-move click still opens
     * the section popover; a drag reorders. */
    var secEl = ev.target.closest && ev.target.closest(
      '.pdv-heading[data-section-id], .pdv-significance[data-section-id]');
    if (secEl && secEl.dataset.sectionId) {
      ev.preventDefault();
      _drag = {
        sectionId: secEl.dataset.sectionId,
        kind: 'section',
        srcEl: secEl,
        startX: ev.clientX, startY: ev.clientY,
        started: false, ghost: null, chip: null, target: null,
        scrollDir: 0, scrollRaf: null,
      };
      document.addEventListener('pointermove', _onDragMove);
      document.addEventListener('pointerup', _onDragUp);
    }
  }

  function _startDragVisuals(ev) {
    var d = _drag;
    d.started = true;
    _closeFigPopover();
    var r = d.srcEl.getBoundingClientRect();
    var ghost = d.srcEl.cloneNode(true);
    ghost.className += ' pdv-drag-ghost';
    ghost.style.width = r.width + 'px';
    ghost.style.height = r.height + 'px';
    ghost.style.left = (ev.clientX + 12) + 'px';
    ghost.style.top = (ev.clientY + 12) + 'px';
    state.overlayEl.appendChild(ghost);
    d.ghost = ghost;
    var chip = document.createElement('div');
    chip.className = 'pdv-drag-chip';
    state.overlayEl.appendChild(chip);
    d.chip = chip;
    d.srcEl.classList.add('pdv-drag-source');
    state.overlayEl.classList.add('pdv-drag-active');
    if (d.kind === 'section') {
      state.layoutSelectedId = null;
      state.layoutSelectedSecId = d.sectionId;
    } else {
      state.layoutSelectedId = d.blockId;
      state.layoutSelectedSecId = null;
    }
    _applyLayoutSelection();
  }

  /* Geometric drop resolution: which sheet is under the pointer, and is
   * the pointer in its top strip, bottom strip, or over a flow block?
   * Sheet-local y = (clientY − sheetRect.top) / zoomK. */
  function _resolveDropTarget(ev) {
    var el = document.elementFromPoint(ev.clientX, ev.clientY);
    if (!el || !state.deskEl.contains(el)) return null;
    var sheet = el.closest && el.closest('.pdv-sheet');
    if (!sheet) return null;
    var pageIdx = parseInt(sheet.dataset.pageIdx, 10);
    var k = state.zoomK || 1;
    var rect = sheet.getBoundingClientRect();
    var localY = (ev.clientY - rect.top) / k;
    var pageH = rect.height / k;
    var margin = parseFloat(sheet.style.padding) || 96;
    var STRIP = 64;
    /* V3.424 — section reorder: a section drag resolves to the target
     * section under the pointer (its heading/box, or the section owning
     * the flow block under the pointer), before/after by pointer half. */
    if (_drag && _drag.kind === 'section') {
      var secHit = el.closest && el.closest('[data-section-id]');
      var targetSecId = secHit && secHit.dataset.sectionId;
      if (!targetSecId) {
        var blk = el.closest && el.closest('[data-block-id]');
        if (blk && blk.dataset.blockId) {
          var loc = _locateLiveBlock(blk.dataset.blockId);
          if (loc) targetSecId = loc.sectionId;
        }
      }
      if (!targetSecId || targetSecId === _drag.sectionId) return null;
      var tRect = (secHit || el).getBoundingClientRect();
      return {
        kind: 'section',
        targetSecId: targetSecId,
        after: ev.clientY > tRect.top + tRect.height / 2,
        pageIdx: pageIdx, el: secHit || el, sheet: sheet,
      };
    }
    /* V3.412 — float-onto-float: reorder within/into a band. Tested
     * BEFORE the strip checks (a band can be taller than the strip, and
     * the slot is the more specific target). Reordering the SOURCE
     * blocks is the only portable pairing lever — LaTeX places floats
     * in source order, and the packer's greedy join pairs adjacent
     * column floats, so adjacency IS the pairing control. */
    var slotEl = el.closest && el.closest('.pdv-float-slot[data-block-id]');
    if (slotEl && slotEl.dataset.blockId && slotEl.dataset.blockId !== _drag.blockId) {
      var slotRect = slotEl.getBoundingClientRect();
      return {
        kind: 'band-slot',
        beforeFloatBlockId: slotEl.dataset.blockId,
        after: ev.clientY > slotRect.top + slotRect.height / 2,
        /* V3.421 — in-column floats carry their region on the slot; band
         * floats fall back to which band they sit in. */
        region: slotEl.dataset.floatRegion ||
          (slotEl.closest('.pdv-float-band-bottom') ? 'bottom' : 'top'),
        pageIdx: pageIdx, el: slotEl, sheet: sheet,
      };
    }
    if (localY <= margin + STRIP) return { kind: 'band', region: 'top', pageIdx: pageIdx, sheet: sheet };
    if (localY >= pageH - margin - STRIP) return { kind: 'band', region: 'bottom', pageIdx: pageIdx, sheet: sheet };
    var flowEl = el.closest && el.closest('.pdv-textregion [data-block-id]');
    if (flowEl && flowEl.dataset.blockId && flowEl.dataset.blockId !== _drag.blockId) {
      /* V3.485 — horizontal half → wrap side (used only when the dragged
       * block is a wrap figure; harmless otherwise). */
      var localX = (ev.clientX - rect.left) / k;
      var pageW = rect.width / k;
      return { kind: 'flow', beforeId: flowEl.dataset.blockId, el: flowEl, pageIdx: pageIdx,
               side: localX < pageW / 2 ? 'left' : 'right' };
    }
    return { kind: 'band', region: localY < pageH / 2 ? 'top' : 'bottom', pageIdx: pageIdx, sheet: sheet };
  }

  function _paintDropTarget(t) {
    var d = _drag;
    /* clear previous highlight */
    state.deskEl.querySelectorAll('.pdv-drop-hot').forEach(function (x) { x.classList.remove('pdv-drop-hot'); });
    state.deskEl.querySelectorAll('.pdv-drop-before').forEach(function (x) { x.classList.remove('pdv-drop-before'); });
    state.deskEl.querySelectorAll('.pdv-drop-after').forEach(function (x) { x.classList.remove('pdv-drop-after'); });
    if (!t) { d.chip.style.display = 'none'; return; }
    d.chip.style.display = '';
    if (t.kind === 'band') {
      var strip = t.sheet.querySelector('.pdv-dropzone-' + t.region);
      if (strip) strip.classList.add('pdv-drop-hot');
      d.chip.textContent = (t.region === 'top' ? 'Top of page ' : 'Bottom of page ') + (t.pageIdx + 1);
    } else if (t.kind === 'band-slot') {
      /* V3.412 — before/after accent on the target float's slot. */
      t.el.classList.add(t.after ? 'pdv-drop-after' : 'pdv-drop-before');
      d.chip.textContent = (t.after ? 'After' : 'Before') + ' this ' +
        (t.el.dataset.blockKind === 'table' ? 'table' : 'figure') +
        ' (page ' + (t.pageIdx + 1) + ') — adjacent floats pair up';
    } else if (t.kind === 'section') {
      /* V3.424 — before/after accent on the target section. */
      t.el.classList.add(t.after ? 'pdv-drop-after' : 'pdv-drop-before');
      d.chip.textContent = 'Move section ' + (t.after ? 'after' : 'before') + ' this one';
    } else {
      t.el.classList.add('pdv-drop-before');
      /* V3.485 — dragging a wrap figure: the chip shows the side the drop
       * position picks, so the corner is predictable before releasing. */
      if (d.srcEl && d.srcEl.dataset && d.srcEl.dataset.anchor === 'wrap') {
        d.chip.textContent = 'Wrap ' + (t.side === 'left' ? 'left' : 'right') +
          ' — here on page ' + (t.pageIdx + 1);
      } else {
        d.chip.textContent = 'Into the text on page ' + (t.pageIdx + 1) + ' — before this block';
      }
    }
  }

  function _autoScroll(ev) {
    var d = _drag;
    var r = state.deskEl.getBoundingClientRect();
    var dir = 0;
    if (ev.clientY < r.top + AUTO_SCROLL_EDGE) dir = -1;
    else if (ev.clientY > r.bottom - AUTO_SCROLL_EDGE) dir = 1;
    d.scrollDir = dir;
    if (dir && !d.scrollRaf) {
      var step = function () {
        if (!_drag || !_drag.scrollDir) { if (_drag) _drag.scrollRaf = null; return; }
        state.deskEl.scrollTop += _drag.scrollDir * AUTO_SCROLL_STEP;
        _drag.scrollRaf = requestAnimationFrame(step);
      };
      d.scrollRaf = requestAnimationFrame(step);
    }
  }

  function _onDragMove(ev) {
    var d = _drag;
    if (!d) return;
    if (!d.started) {
      if (Math.abs(ev.clientX - d.startX) < DRAG_THRESHOLD &&
          Math.abs(ev.clientY - d.startY) < DRAG_THRESHOLD) return;
      _startDragVisuals(ev);
    }
    d.ghost.style.left = (ev.clientX + 12) + 'px';
    d.ghost.style.top = (ev.clientY + 12) + 'px';
    d.chip.style.left = (ev.clientX + 12) + 'px';
    d.chip.style.top = (ev.clientY - 26) + 'px';
    d.target = _resolveDropTarget(ev);
    _paintDropTarget(d.target);
    _autoScroll(ev);
  }

  function _onDragUp() {
    var d = _drag;
    if (!d) return;
    var target = d.started ? d.target : null;
    var kind = d.kind;
    var id = kind === 'section' ? d.sectionId : d.blockId;
    _cancelDrag();          // tear down visuals first — commit below re-renders
    if (!target) return;    // plain click (no threshold) or dropped outside
    _commitDrop(id, kind, target);
  }

  function _cancelDrag() {
    var d = _drag;
    if (!d) return;
    document.removeEventListener('pointermove', _onDragMove);
    document.removeEventListener('pointerup', _onDragUp);
    if (d.scrollRaf) cancelAnimationFrame(d.scrollRaf);
    if (d.ghost) d.ghost.remove();
    if (d.chip) d.chip.remove();
    if (d.srcEl) d.srcEl.classList.remove('pdv-drag-source');
    if (state.overlayEl) state.overlayEl.classList.remove('pdv-drag-active');
    if (state.deskEl) {
      state.deskEl.querySelectorAll('.pdv-drop-hot').forEach(function (x) { x.classList.remove('pdv-drop-hot'); });
      state.deskEl.querySelectorAll('.pdv-drop-before').forEach(function (x) { x.classList.remove('pdv-drop-before'); });
      state.deskEl.querySelectorAll('.pdv-drop-after').forEach(function (x) { x.classList.remove('pdv-drop-after'); });
    }
    _drag = null;
  }

  /* Where is this block in the LIVE tree right now? (resolved at drop
   * time, not from any snapshot — mirrors _findLiveBlock). */
  function _locateLiveBlock(blockId) {
    var pe = _pe();
    var sections = pe.getPaperMap && pe.getPaperMap().get('sections');
    if (!sections || typeof sections.forEach !== 'function') return null;
    var hit = null;
    sections.forEach(function (sec) {
      if (hit || !sec || typeof sec.get !== 'function') return;
      var children = sec.get('children');
      if (!children || typeof children.forEach !== 'function') return;
      var i = 0;
      children.forEach(function (blk) {
        if (!hit && blk && typeof blk.get === 'function' && blk.get('id') === blockId) {
          hit = { sectionId: sec.get('id'), index: i };
        }
        i++;
      });
    });
    return hit;
  }

  /* V3.485 — the live anchor of a block ('flow' when absent/invalid). */
  function _blockAnchor(blockId) {
    var blk = _findLiveBlock(blockId);
    var attrs = blk && blk.get && blk.get('attrs');
    var a = attrs && attrs.get('anchor');
    return typeof a === 'string' ? a : 'flow';
  }

  function _commitDrop(blockId, kind, target) {
    /* V3.424 — a section drag reorders the whole section. Compute the
     * destination index in the list with the dragged section removed
     * (moveSection deletes-then-inserts at idx+delta, so delta =
     * finalIndex − curIndex). */
    if (kind === 'section') {
      if (target.kind !== 'section' || !_pe().moveSection || !_pe().getSectionsSummary) return;
      var summ = _pe().getSectionsSummary() || [];
      var order = summ.map(function (r) { return r.id; });
      var curIdx = order.indexOf(blockId);          // blockId carries the sectionId here
      if (curIdx < 0) return;
      var without = order.slice(0, curIdx).concat(order.slice(curIdx + 1));
      var tPos = without.indexOf(target.targetSecId);
      if (tPos < 0) return;
      var finalIdx = tPos + (target.after ? 1 : 0);
      var delta = finalIdx - curIdx;
      if (delta === 0) return;
      _pe().moveSection(blockId, delta);
      state.forceRender = true;
      scheduleRender(150);
      return;
    }
    var originPrefix = kind === 'table' ? 'tab' : 'fig';
    if (target.kind === 'band') {
      _writeFigAttrs(blockId, { anchor: target.region }, originPrefix + '-anchor');
      /* Cross-page: reorder the block to just before the target page's
       * first real block so the deterministic packer lands it there. */
      var curPage = _pageIndexOfFloat(blockId);
      var pageInfo = state.lastPages && state.lastPages[target.pageIdx];
      if (curPage !== target.pageIdx && pageInfo && pageInfo.firstFlow) {
        var src = _locateLiveBlock(blockId);
        var dst = _locateLiveBlock(pageInfo.firstFlow.blockId);
        if (src && dst && _pe().moveBlockToPosition) {
          _pe().moveBlockToPosition(src.sectionId, blockId, dst.sectionId, dst.index);
          scheduleRender(150);
        }
      }
    } else if (target.kind === 'band-slot') {
      /* V3.412 — adopt the target float's band, then reorder the SOURCE
       * blocks so the packer's source-order join makes them adjacent
       * (pairing = adjacency; no extra persistence). `after` inserts
       * before the NEXT block — same index semantics as flow drops. */
      _writeFigAttrs(blockId, { anchor: target.region }, originPrefix + '-anchor');
      var src3 = _locateLiveBlock(blockId);
      var dst3 = _locateLiveBlock(target.beforeFloatBlockId);
      if (src3 && dst3 && _pe().moveBlockToPosition) {
        _pe().moveBlockToPosition(src3.sectionId, blockId, dst3.sectionId,
          dst3.index + (target.after ? 1 : 0));
        scheduleRender(150);
      }
    } else if (target.kind === 'flow') {
      /* V3.485 — a wrap figure dropped into the text stays wrapped: only
       * its side (from the drop's horizontal half) and its position
       * change. Dropping it on a top/bottom band above still converts it
       * to a band float — an intentional un-wrap. Tables never wrap. */
      if (kind !== 'table' && _blockAnchor(blockId) === 'wrap') {
        _writeFigAttrs(blockId, { anchor: 'wrap', wrap_side: target.side === 'left' ? 'left' : 'right' },
          originPrefix + '-wrapside');
      } else {
        _writeFigAttrs(blockId, { anchor: 'flow' }, originPrefix + '-anchor');
      }
      var src2 = _locateLiveBlock(blockId);
      var dst2 = _locateLiveBlock(target.beforeId);
      if (src2 && dst2 && _pe().moveBlockToPosition) {
        _pe().moveBlockToPosition(src2.sectionId, blockId, dst2.sectionId, dst2.index);
        scheduleRender(150);
      }
    }
    state.layoutSelectedId = blockId;
  }

  /* Which page does this float currently sit on (bands or flow)? */
  function _pageIndexOfFloat(blockId) {
    var el = state.deskEl && state.deskEl.querySelector('[data-block-id="' + blockId + '"]');
    var sheet = el && el.closest && el.closest('.pdv-sheet');
    return sheet ? parseInt(sheet.dataset.pageIdx, 10) : -1;
  }

  function _buildRegionLayer(page, geom) {
    var layer = document.createElement('div');
    layer.className = 'pdv-regions';
    layer.setAttribute('aria-hidden', 'true');
    var r = page.rects;
    if (!r) return layer;
    function box(cls, rect, blockId) {
      if (!rect) return;
      var d = document.createElement('div');
      d.className = 'pdv-region ' + cls;
      d.style.left = rect.x + 'px';
      d.style.top = rect.y + 'px';
      d.style.width = rect.w + 'px';
      d.style.height = rect.h + 'px';
      if (blockId) d.dataset.blockId = blockId;
      layer.appendChild(d);
    }
    box('pdv-region-margin', r.margin);
    (r.cols || []).forEach(function (c) { box('pdv-region-col', c); });
    box('pdv-region-text', r.text);
    if (r.foot) box('pdv-region-foot', r.foot);
    (r.floats || []).forEach(function (f) {
      box('pdv-region-float ' + (f.kind === 'table' ? 'pdv-region-tab' : 'pdv-region-fig'),
          f, f.blockId);
    });
    return layer;
  }

  /* ── Mounting ──────────────────────────────────────────────── */

  /* V3.397 — mount a float band (top or bottom): rows of one full-width
   * slot or up to two column-width slots side by side (LaTeX's
   * per-column float areas). Slot widths equal the widths the items
   * were measured at, so band heights stay truthful. */
  function _mountBand(rows, region, geom) {
    var band = document.createElement('div');
    band.className = 'pdv-float-band pdv-float-band-' + region;
    rows.forEach(function (row) {
      var rowEl = document.createElement('div');
      rowEl.className = 'pdv-float-row';
      rowEl.style.gap = geom.colGap + 'px';
      /* Match the packer's per-row gap accounting so the mounted band
       * height equals what _recordRects recorded (the R3 overlay
       * aligns) — and floats read as separated, like LaTeX \floatsep.
       * V3.408: the gap is stamped on the row at pack time (preset base
       * + per-float nudge) — read the stamp, never recompute. */
      rowEl.style.marginBottom = (row.gap != null ? row.gap : BLOCK_GAP) + 'px';
      row.items.forEach(function (f) {
        var slot = document.createElement('div');
        slot.className = 'pdv-float-slot';
        slot.style.width = row.span === 'page' ? '100%' : geom.colW + 'px';
        if (f.blockId) {
          slot.dataset.blockId = f.blockId;
          slot.dataset.blockKind = f.blockKind || '';
        }
        slot.appendChild(f.node);
        rowEl.appendChild(slot);
      });
      band.appendChild(rowEl);
    });
    return band;
  }

  /* V3.421 — mount a colgrid segment: two independent columns side by
   * side, each a flex column that stacks its flow nodes and, when
   * present, reserves a single-column float at its top and/or bottom.
   * The [b] float bottom-anchors via margin-top:auto, so its column's
   * text runs from the top down to the float; the other column flows its
   * full height independently. The strip's fixed height lets the bottom
   * floats align to the page's text-region foot. */
  function _mountColGrid(seg, geom) {
    var strip = document.createElement('div');
    strip.className = 'pdv-cols-strip';
    strip.style.gap = geom.colGap + 'px';
    strip.style.minHeight = seg.height + 'px';
    seg.cols.forEach(function (c) {
      var col = document.createElement('div');
      col.className = 'pdv-col';
      col.style.width = geom.colW + 'px';
      if (c.floatOnly) col.style.justifyContent = 'center';   // V3.909 — a float column
      if (c.floatTop) col.appendChild(_mountColFloat(c.floatTop, 'top'));
      var flow = document.createElement('div');
      flow.className = 'pdv-col-flow';
      c.items.forEach(function (n) { flow.appendChild(n); });
      col.appendChild(flow);
      if (c.floatBottom) col.appendChild(_mountColFloat(c.floatBottom, 'bottom'));
      strip.appendChild(col);
    });
    return strip;
  }
  function _mountColFloat(slot, region) {
    var wrap = document.createElement('div');
    wrap.className = 'pdv-float-slot pdv-col-float pdv-col-float-' + region;
    var f = slot.items[0];
    if (f.blockId) {
      wrap.dataset.blockId = f.blockId;
      wrap.dataset.blockKind = f.blockKind || '';
      wrap.dataset.floatRegion = region;
    }
    /* [t] separates from the flow below; [b] pushes to the column foot. */
    if (region === 'top') wrap.style.marginBottom = slot.gap + 'px';
    else { wrap.style.marginTop = 'auto'; wrap.style.paddingTop = slot.gap + 'px'; }
    wrap.appendChild(f.node);
    /* a float column stacks every float it took, \floatsep apart */
    if (slot.fcol) {
      slot.items.slice(1).forEach(function (g) {
        g.node.style.marginTop = slot.sep + 'px';
        wrap.appendChild(g.node);
      });
    }
    return wrap;
  }

  function _mountSheets(pages, geom, hints) {
    var scale = state.scaleEl;
    if (!scale) return;
    var frag = document.createDocumentFragment();
    var total = pages.length;

    pages.forEach(function (page, idx) {
      var sheet = document.createElement('div');
      sheet.className = 'pdv-sheet' + (page.isFloatPage ? ' pdv-floatpage' : '');
      sheet.dataset.pageIdx = String(idx);   // V3.401 — drop-target resolution
      /* V3.912 — the paginator's accounting for this page, in px (read by the
       * Paper Lab when a page breaks differently from the PDF) */
      sheet.dataset.acct = JSON.stringify({ used: page.usedH, top: page.topH, bottom: page.bottomH, foot: page.footH,
        cap: geom.look ? geom.bodyH : null, segs: page.segments.map(function (sg) { return Math.round((sg.height || 0) * 100) / 100; }) });
      sheet.style.width = geom.pageW + 'px';
      sheet.style.height = geom.pageH + 'px';
      sheet.style.padding = (geom.mT != null)   // V3.907 — per-side margins (journal looks)
        ? geom.mT + 'px ' + geom.mR + 'px ' + geom.mB + 'px ' + geom.mL + 'px'
        : geom.margin + 'px';
      sheet.style.fontSize = (geom.fontPt * 1.333) + 'px';
      var body = document.createElement('div');
      body.className = 'pdv-sheet-body';
      /* V3.397 — page = [top float band][text region][bottom float band];
       * the bottom band bottom-anchors via margin-top:auto (flex column). */
      if (page.topFloats.length) body.appendChild(_mountBand(page.topFloats, 'top', geom));
      var textRegion = document.createElement('div');
      textRegion.className = 'pdv-textregion';
      page.segments.forEach(function (seg) {
        if (seg.type === 'full') {
          textRegion.appendChild(seg.node);
        } else if (seg.type === 'colgrid') {
          /* V3.421 — two INDEPENDENT columns (was CSS column-count, which
           * balanced both to one height and forced a full-width band for
           * any float). Each column stacks its flow nodes and bottom-
           * anchors its [b] float, so text runs to the figure boundary in
           * one column while the other flows past it. */
          textRegion.appendChild(_mountColGrid(seg, geom));
        } else {
          var run = document.createElement('div');
          run.className = 'pdv-cols';
          seg.nodes.forEach(function (n) { run.appendChild(n); });
          textRegion.appendChild(run);
        }
      });
      body.appendChild(textRegion);
      if (page.bottomFloats.length) body.appendChild(_mountBand(page.bottomFloats, 'bottom', geom));
      sheet.appendChild(body);
      if (page.footnotes.length) {
        var fns = document.createElement('div');
        fns.className = 'pdv-footnotes';
        page.footnotes.forEach(function (n) { fns.appendChild(n); });
        sheet.appendChild(fns);
      }
      if (page.overflow) {
        var flag = document.createElement('div');
        flag.className = 'pdv-overflow-flag';
        flag.textContent = 'content exceeds one page — the PDF will flow it across pages';
        sheet.appendChild(flag);
      }
      var pn = document.createElement('div');
      pn.className = 'pdv-pageno';
      pn.textContent = (idx + 1) + ' / ≈' + total;
      sheet.appendChild(pn);
      /* V3.399 — layout-region overlay layer (topmost; pointer-events
       * none; shown only while .pdv-regions-on is set on the scale). */
      sheet.appendChild(_buildRegionLayer(page, geom));
      /* V3.401 — drop-zone strips (visual affordance only; hit-testing
       * is geometric). Shown while a drag is active. */
      var dz = document.createElement('div');
      dz.className = 'pdv-dropzones';
      dz.innerHTML =
        '<div class="pdv-dropzone pdv-dropzone-top" data-region="top" style="left:' + (geom.mL != null ? geom.mL : geom.margin) + 'px;top:' + (geom.mT != null ? geom.mT : geom.margin) + 'px;width:' + geom.bodyW + 'px;"></div>' +
        '<div class="pdv-dropzone pdv-dropzone-bottom" data-region="bottom" style="left:' + (geom.mL != null ? geom.mL : geom.margin) + 'px;bottom:' + (geom.mB != null ? geom.mB : geom.margin) + 'px;width:' + geom.bodyW + 'px;"></div>';
      sheet.appendChild(dz);
      frag.appendChild(sheet);
    });

    if (pages.truncated) {
      var note = document.createElement('div');
      note.className = 'pdv-truncated';
      note.textContent = 'Preview capped at ' + MAX_SHEETS + ' pages.';
      frag.appendChild(note);
    }

    /* V3.393 — the editor stamps cite groups with "Click to edit
     * citation"; in the doc view a click opens the details/evidence
     * panel instead, so rewrite the affordance. Per-chip tooltips
     * (numbered titles) are left alone. */
    frag.querySelectorAll('.pe-cite-group[data-cite-keys]').forEach(function (g) {
      g.setAttribute('title', 'Click for citation details & evidence');
    });

    scale.innerHTML = '';
    scale.appendChild(frag);
    scale.style.width = geom.pageW + 'px';
    if (state.pagesLabelEl) {
      state.pagesLabelEl.textContent = '≈ ' + total + ' page' + (total === 1 ? '' : 's');
      /* V3.913 — a grant document shows its limit */
      var lim = null;
      if (geom.look && state.template && state.template.grant && window.PaperGrantRules) {
        var dr = window.PaperGrantRules.docRule(state.template, state.grantDoc || 'project_description');
        lim = dr && dr.page_limit;
      }
      state.pagesLabelEl.classList.toggle('pdv-pages-over', !!(lim && total > lim));
      state.pagesLabelEl.classList.toggle('pdv-pages-ok', !!(lim && total <= lim));
      if (lim) state.pagesLabelEl.textContent = total + ' / ' + lim + ' pages';
    }
    _applyZoom();

    /* Re-anchor a popover that was open across the re-render.
     * V3.401 — tables can hold the popover too; V3.412 — equations. */
    if (state.openPopover) {
      var fig = state.deskEl.querySelector(
        '.pdv-figure[data-block-id="' + state.openPopover.blockId + '"], ' +
        '.pdv-table-wrap[data-block-id="' + state.openPopover.blockId + '"]');
      var eqEl = !fig && state.deskEl.querySelector(
        '.pdv-eq[data-block-id="' + state.openPopover.blockId + '"]');
      if (fig) _openFigPopover(fig, true);
      else if (eqEl) _openEqPopover(eqEl, true);
      else _closeFigPopover();
    }
    /* V3.399 — re-apply the layout overlay class + selection after the
     * full remount (scale.innerHTML was replaced). */
    _syncLayoutViz();
  }

  function _applyZoom() {
    var scale = state.scaleEl;
    var outer = state.scaleOuterEl;
    if (!scale || !outer || !state.deskEl) return;
    var pageW = parseFloat(scale.style.width) || 816;
    var k = state.zoom === 'fit'
      ? Math.max(0.3, Math.min(1.6, (state.deskEl.clientWidth - 48) / pageW))
      : state.zoom;
    state.zoomK = k;   // V3.401 — drag hit-testing divides by this
    scale.style.transform = 'scale(' + k + ')';
    scale.style.transformOrigin = 'top left';
    var naturalH = scale.scrollHeight;
    outer.style.width = Math.ceil(pageW * k) + 'px';
    outer.style.height = Math.ceil(naturalH * k) + 'px';
  }

  /* ── Figure layout popover ─────────────────────────────────── */

  var WIDTH_PRESETS = ['\\linewidth', '0.9\\linewidth', '0.8\\linewidth', '0.5\\linewidth', '\\textwidth', '\\columnwidth'];
  /* Plain-English labels shown in the popover; the option VALUE stays the
   * LaTeX spec so the Figures panel + export round-trip is unchanged. */
  var WIDTH_LABELS = {
    '\\linewidth': 'Full column width',
    '0.9\\linewidth': '90% of column',
    '0.8\\linewidth': '80% of column',
    '0.5\\linewidth': 'Half column (50%)',
    '\\textwidth': 'Full page width (spans columns)',
    '\\columnwidth': 'Column width',
  };
  function _widthLabel(spec) {
    if (WIDTH_LABELS[spec]) return WIDTH_LABELS[spec];
    var m = String(spec).match(/^([0-9.]+)\\(?:line|column)width$/);
    if (m) return Math.round(parseFloat(m[1]) * 100) + '% of column';
    var t = String(spec).match(/^([0-9.]+)\\textwidth$/);
    if (t) return Math.round(parseFloat(t[1]) * 100) + '% of page width';
    return spec;
  }
  /* Ordered by how often you'd reach for them. */
  var PLACEMENTS = ['H', 't', 'b', 'p', 'h'];
  var PLACEMENT_LABELS = {
    'H': 'Right here (fixed in place)',
    'h': 'Near here (may shift a little)',
    't': 'Top of the page',
    'b': 'Bottom of the page',
    'p': 'On its own page',
    '!t': 'Top of the page (forced)',
    '!b': 'Bottom of the page (forced)',
  };
  function _placementLabel(p) {
    return PLACEMENT_LABELS[p] || (p + ' — custom placement');
  }

  function _findLiveBlock(blockId) {
    var sections = _pe().getPaperMap().get('sections');
    var hit = null;
    if (!sections) return null;
    sections.forEach(function (sec) {
      var children = sec.get && sec.get('children');
      if (!children || hit) return;
      children.forEach(function (blk) {
        if (!hit && blk.get && blk.get('id') === blockId) hit = blk;
      });
    });
    return hit;
  }

  function _closeFigPopover() {
    if (state.popEl) { state.popEl.remove(); state.popEl = null; }
    state.openPopover = null;
  }

  /* ── Section styles: Insert menu + heading popover (V3.416, R8) ──
   * The Insert ▾ menu lists the CURRENT journal's special-section
   * catalog (singletons greyed once present), every OTHER journal's
   * catalog (drop-ins keep their look via the R6 special_render
   * fallback — a Significance box works on any template), and custom
   * styles. Creation funnels through PaperEditor.addSection (origins in
   * LAYOUT_ORIGINS), landing per the entry's default_position. */

  function _closeInsertMenu() {
    if (state.insertMenuEl) { state.insertMenuEl.remove(); state.insertMenuEl = null; }
  }

  function _insertIndexFor(pos) {
    var summary = (_pe().getSectionsSummary && _pe().getSectionsSummary()) || [];
    if (pos === 'front') {
      var idx = 0;
      for (var i = 0; i < summary.length; i++) {
        if (summary[i].kind === 'abstract' || summary[i].kind === 'keywords') idx = i + 1;
      }
      return idx;
    }
    if (pos === 'back') {
      for (var j = 0; j < summary.length; j++) {
        if (summary[j].kind === 'references') return j;
      }
      return summary.length;
    }
    return summary.length;
  }

  function _insertSpecial(key, label, render, pos, fromJournal) {
    _closeInsertMenu();
    var id = _pe().addSection('custom', label, {
      special: key || null,
      special_render: render || 'heading',
      atIndex: _insertIndexFor(pos || 'anywhere'),
    });
    if (!id) { _status('Could not create the section.'); return; }
    state.forceRender = true;
    scheduleRender(150);
    _status('Added "' + label + '"' + (fromJournal ? ' (' + fromJournal + ' style)' : '') +
      ' — it is a real section in the editor too.');
  }

  function _menuItem(html, onClick, disabled) {
    var it = document.createElement('button');
    it.type = 'button';
    it.className = 'pdv-ins-item';
    it.innerHTML = html;
    if (disabled) it.disabled = true;
    else it.addEventListener('click', onClick);
    return it;
  }

  function _menuHead(text) {
    var h = document.createElement('div');
    h.className = 'pdv-ins-head';
    h.textContent = text;
    return h;
  }

  function _openInsertMenu(btn) {
    _closeInsertMenu();
    var menu = document.createElement('div');
    menu.className = 'pdv-ins-menu';
    var r = btn.getBoundingClientRect();
    menu.style.left = Math.round(r.left) + 'px';
    menu.style.top = Math.round(r.bottom + 6) + 'px';
    var present = {};
    ((_pe().getSectionsSummary && _pe().getSectionsSummary()) || []).forEach(function (s) {
      if (s.special) present[s.special] = true;
    });
    var tpl = state.template || {};

    function addCatalog(catalog, journalName, intoEl) {
      (catalog || []).forEach(function (e) {
        if (!e || !e.key || !e.label) return;
        var taken = e.singleton && present[e.key];
        intoEl.appendChild(_menuItem(
          (e.preview === 'box' ? '▣ ' : '¶ ') + _esc(e.label) +
          (taken ? ' <span class="pdv-ins-note">already added</span>' : '') +
          (e.hint ? '<span class="pdv-ins-hint">' + _esc(e.hint) + '</span>' : ''),
          function () {
            _insertSpecial(e.key, e.label, e.preview || 'heading', e.default_position, journalName);
          }, taken));
      });
    }

    menu.appendChild(_menuHead('This journal — ' + (tpl.name || tpl.id || 'sections')));
    if ((tpl.special_sections || []).length) addCatalog(tpl.special_sections, null, menu);
    else {
      var none = document.createElement('div');
      none.className = 'pdv-ins-note';
      none.textContent = 'No special sections declared.';
      menu.appendChild(none);
    }

    /* Other journals — loaded lazily on expand (static template JSONs). */
    var otherBtn = _menuItem(ICON.svg('globe-alt') + ' Other journals’ sections…', function () {
      otherBtn.disabled = true;
      otherBtn.innerHTML = 'Loading catalogs…';
      var known = (window.PaperExportConfig && window.PaperExportConfig.KNOWN_TEMPLATES) || [];
      var fetches = known
        .filter(function (t) { return t.id !== (tpl.id || ''); })
        .map(function (t) {
          return window.PaperExportTex.fetchTemplate(t.id).then(function (d) {
            return { label: t.label, tpl: d };
          }).catch(function () { return null; });
        });
      Promise.all(fetches).then(function (list) {
        if (!state.insertMenuEl) return;
        otherBtn.remove();
        list.filter(Boolean).forEach(function (row) {
          if (!(row.tpl.special_sections || []).length) return;
          menu.appendChild(_menuHead(row.label));
          addCatalog(row.tpl.special_sections, row.label, menu);
        });
      });
    });
    menu.appendChild(otherBtn);

    menu.appendChild(_menuHead('Custom style'));
    menu.appendChild(_menuItem('▣ Boxed callout…', function () {
      var name = window.prompt('Title for the boxed section?', 'Key Points');
      if (name) _insertSpecial('custom-box', name, 'box', 'anywhere', null);
    }));
    menu.appendChild(_menuItem('¶ Plain section…', function () {
      var name = window.prompt('Section title?', 'New section');
      if (name) {
        _closeInsertMenu();
        var id = _pe().addSection('custom', name, {});
        if (id) { state.forceRender = true; scheduleRender(150); _status('Added "' + name + '".'); }
      }
    }));

    /* V3.456 — appendix divider (one per paper; placed before the last
     * section, then moved with the ▲▼ on the bar in the write page). */
    if (_pe().setAppendixBoundary) {
      var apxTaken = _pe().getAppendixBoundaryIdx && _pe().getAppendixBoundaryIdx() >= 0;
      menu.appendChild(_menuHead('Appendices'));
      menu.appendChild(_menuItem(
        '§ Appendix divider' +
        (apxTaken ? ' <span class="pdv-ins-note">already placed — move it on the write page</span>'
                  : '<span class="pdv-ins-hint">sections below it become Appendix A, B, C</span>'),
        function () {
          _closeInsertMenu();
          var secs = (_pe().getSectionsSummary && _pe().getSectionsSummary()) || [];
          if (secs.length) {
            _pe().setAppendixBoundary(secs.length - 1);
            _status('Appendix divider placed before the last section.');
          }
        }, apxTaken));
    }

    state.overlayEl.appendChild(menu);
    state.insertMenuEl = menu;
  }

  /* V3.416 — section heading popover: rename / move / delete right from
   * the page. Shares the .pdv-fig-pop shell + popEl lifecycle. */
  function _openSecPopover(el) {
    var sectionId = el.dataset.sectionId;
    if (!sectionId) return;
    _closeFigPopover();
    var pop = document.createElement('div');
    pop.className = 'pdv-fig-pop';
    pop.innerHTML =
      '<div class="pdv-fig-pop-title">Section</div>' +
      '<div class="pdv-fig-pop-actions pdv-sec-actions">' +
      '<button type="button" data-sec-rename>' + ICON.svg('pencil') + ' Rename…</button>' +
      '<button type="button" data-sec-up>↑ Up</button>' +
      '<button type="button" data-sec-down>↓ Down</button>' +
      '</div>' +
      '<div class="pdv-fig-pop-actions pdv-sec-actions">' +
      '<button type="button" data-sec-start>⤒ To start</button>' +
      '<button type="button" data-sec-end>' + ICON.svg('arrow-down-tray') + ' To end</button>' +
      '<button type="button" data-sec-del>' + ICON.svg('trash') + ' Delete</button>' +
      '</div>' +
      '<div class="pdv-fig-pop-hint">Moves reorder the whole section (and its .tex file). Rename edits the section label.</div>' +
      '<button class="pdv-fig-pop-close" title="Close">' + ICON.svg('x-mark') + '</button>';
    state.overlayEl.appendChild(pop);
    state.popEl = pop;
    var r = el.getBoundingClientRect();
    pop.style.left = Math.max(8, Math.min(r.right + 10, window.innerWidth - 260)) + 'px';
    pop.style.top = Math.max(58, Math.min(r.top, window.innerHeight - 190)) + 'px';
    pop.querySelector('.pdv-fig-pop-close').addEventListener('click', _closeFigPopover);

    function summaryRow() {
      var s = ((_pe().getSectionsSummary && _pe().getSectionsSummary()) || []);
      for (var i = 0; i < s.length; i++) if (s[i].id === sectionId) return { row: s[i], count: s.length };
      return null;
    }
    function move(delta) {
      if (_pe().moveSection) _pe().moveSection(sectionId, delta);
      state.forceRender = true;
      scheduleRender(150);
    }
    pop.querySelector('[data-sec-rename]').addEventListener('click', function () {
      var cur = summaryRow();
      var name = window.prompt('Section title?', (cur && cur.row.label) || '');
      if (name === null || !name.trim()) return;
      var sections = _pe().getPaperMap && _pe().getPaperMap().get('sections');
      if (!sections) return;
      sections.forEach(function (m) {
        if (m.get('id') !== sectionId) return;
        var label = m.get('label');
        if (label && label.delete && label.insert) {
          label.doc.transact(function () {
            label.delete(0, label.length);
            label.insert(0, name.trim());
          }, 'rename-section');
        }
      });
      state.forceRender = true;
      scheduleRender(150);
      _closeFigPopover();
    });
    pop.querySelector('[data-sec-up]').addEventListener('click', function () { move(-1); });
    pop.querySelector('[data-sec-down]').addEventListener('click', function () { move(1); });
    pop.querySelector('[data-sec-start]').addEventListener('click', function () {
      var cur = summaryRow();
      if (cur) move(-cur.row.index);
    });
    pop.querySelector('[data-sec-end]').addEventListener('click', function () {
      var cur = summaryRow();
      if (cur) move(cur.count - 1 - cur.row.index);
    });
    pop.querySelector('[data-sec-del]').addEventListener('click', function () {
      var cur = summaryRow();
      if (!window.confirm('Delete the section "' + ((cur && cur.row.label) || '') + '" and everything in it?')) return;
      if (_pe().deleteSection) _pe().deleteSection(sectionId, { skipConfirm: true });
      _closeFigPopover();
      state.forceRender = true;
      scheduleRender(150);
    });
  }

  /* V3.412 — minimal equation popover: Span only (column vs both
   * columns; exports via cuted's strip in two-column classes). Reuses
   * the .pdv-fig-pop shell + state.popEl lifecycle so re-anchor / Esc /
   * outside-click behave exactly like the figure popover. */
  function _openEqPopover(eqEl, reanchorOnly) {
    var blockId = eqEl.dataset.blockId;
    if (!blockId) return;
    if (!reanchorOnly) _closeFigPopover();
    else if (state.popEl) { state.popEl.remove(); state.popEl = null; }
    state.openPopover = { blockId: blockId };
    var blk = _findLiveBlock(blockId);
    if (!blk) { _closeFigPopover(); return; }
    var attrs = blk.get('attrs');
    if (!attrs) { _closeFigPopover(); return; }
    var curSpan = attrs.get('span') === 'page' ? 'page' : 'column';
    var pop = document.createElement('div');
    pop.className = 'pdv-fig-pop';
    pop.innerHTML =
      '<div class="pdv-fig-pop-title">Equation layout</div>' +
      '<label>Span <select data-pdv-eq-span>' +
      '<option value="column"' + (curSpan === 'column' ? ' selected' : '') + '>One column</option>' +
      '<option value="page"' + (curSpan === 'page' ? ' selected' : '') + '>Both columns</option>' +
      '</select></label>' +
      '<div class="pdv-fig-pop-hint">In two-column journals a spanning equation breaks the column run (LaTeX: cuted\'s strip environment — it lands where the column ends). One-column layouts ignore span.</div>' +
      '<button class="pdv-fig-pop-close" title="Close">' + ICON.svg('x-mark') + '</button>';
    state.overlayEl.appendChild(pop);
    state.popEl = pop;
    var er = eqEl.getBoundingClientRect();
    pop.style.left = Math.max(8, Math.min(er.right + 10, window.innerWidth - 250)) + 'px';
    pop.style.top = Math.max(58, Math.min(er.top, window.innerHeight - 160)) + 'px';
    pop.querySelector('.pdv-fig-pop-close').addEventListener('click', _closeFigPopover);
    pop.querySelector('[data-pdv-eq-span]').addEventListener('change', function (ev2) {
      _writeFigAttrs(blockId, { span: ev2.target.value === 'page' ? 'page' : 'column' }, 'eq-span');
    });
  }

  function _openFigPopover(figEl, reanchorOnly) {
    var blockId = figEl.dataset.blockId;
    if (!blockId) return;
    /* V3.401 — tables share the popover in anchor/span/lock-only form
     * (no width/centering — LaTeX tables size to content). */
    var isTable = (figEl.dataset.blockKind || '') === 'table';
    var originPrefix = isTable ? 'tab' : 'fig';
    if (!reanchorOnly) _closeFigPopover();
    else if (state.popEl) { state.popEl.remove(); state.popEl = null; }
    state.openPopover = { blockId: blockId };

    var blk = _findLiveBlock(blockId);
    if (!blk) { _closeFigPopover(); return; }
    var attrs = blk.get('attrs');
    if (!attrs) { _closeFigPopover(); return; }
    var curWidth = attrs.get('width') || ((state.template && state.template.figure_environment && state.template.figure_environment.default_width) || '\\linewidth');
    var curPlace = attrs.get('placement') || ((state.template && state.template.figure_environment && state.template.figure_environment.placement) || 'H');
    var curCenter = attrs.get('centering') !== false;
    /* V3.395 — layout intent. A legacy block (no anchor yet) derives its
     * initial intent from the stored placement so the selects are honest;
     * the first change opts the block into the anchored export path. */
    var curAnchor = attrs.get('anchor');
    var curLock = attrs.get('lock') === true;
    if (typeof curAnchor !== 'string' || !curAnchor) {
      var derived = (window.PaperLayout && window.PaperLayout.placementToAnchor)
        ? window.PaperLayout.placementToAnchor(curPlace)
        : { anchor: 'flow', lock: false };
      curAnchor = derived.anchor;
      curLock = derived.lock;
    }
    var curSpan = attrs.get('span') === 'page' ? 'page' : 'column';
    /* V3.410 — per-float spacing / nudge (signed mm, 0 = default). */
    var curSpacing = attrs.get('spacing');
    if (typeof curSpacing !== 'number' || !isFinite(curSpacing)) curSpacing = 0;
    /* V3.485 — corner/side wrap side. Only offered for figures in a
     * single-column layout (wrapfig has no two-column analogue). */
    var curWrapSide = attrs.get('wrap_side') === 'left' ? 'left' : 'right';
    var singleCol = !(state.lastGeom && state.lastGeom.cols === 2);
    var ANCHOR_OPTS = [
      ['flow', 'In the text flow'],
      ['top', 'Top of the page'],
      ['bottom', 'Bottom of the page'],
      ['float-page', 'Own floats page'],
    ];
    if (!isTable && singleCol) ANCHOR_OPTS.push(['wrap', 'Wrap text around (corner)']);

    var widths = WIDTH_PRESETS.slice();
    if (widths.indexOf(curWidth) < 0) widths.unshift(curWidth);
    var places = PLACEMENTS.slice();
    if (places.indexOf(curPlace) < 0) places.unshift(curPlace);

    var pop = document.createElement('div');
    pop.className = 'pdv-fig-pop';
    pop.innerHTML =
      '<div class="pdv-fig-pop-title">' + (isTable ? 'Table layout' : 'Figure layout') + '</div>' +
      /* Width / legacy placement / centering are figure-only — LaTeX
       * tables size to their content (anchor + span + lock only). */
      (isTable ? '' :
      '<label>Width <select data-pdv-width>' +
      widths.map(function (w) {
        return '<option value="' + _esc(w) + '"' + (w === curWidth ? ' selected' : '') + '>' + _esc(_widthLabel(w)) + '</option>';
      }).join('') + '</select></label>' +
      '<label>Placement <select data-pdv-place>' +
      places.map(function (p) {
        return '<option value="' + _esc(p) + '"' + (p === curPlace ? ' selected' : '') + '>' + _esc(_placementLabel(p)) + '</option>';
      }).join('') + '</select></label>') +
      /* V3.395 — layout intent (anchor / span / lock). */
      '<label>Anchor <select data-pdv-anchor>' +
      ANCHOR_OPTS.map(function (a) {
        return '<option value="' + a[0] + '"' + (a[0] === curAnchor ? ' selected' : '') + '>' + a[1] + '</option>';
      }).join('') + '</select></label>' +
      /* V3.485 — wrap side, shown only while anchor === 'wrap'. */
      (isTable ? '' :
      '<label data-pdv-wrapside-row' + (curAnchor === 'wrap' ? '' : ' hidden') + '>Wrap side <select data-pdv-wrapside>' +
      '<option value="right"' + (curWrapSide === 'right' ? ' selected' : '') + '>Right</option>' +
      '<option value="left"' + (curWrapSide === 'left' ? ' selected' : '') + '>Left</option>' +
      '</select></label>') +
      '<label>Span <select data-pdv-span>' +
      '<option value="column"' + (curSpan === 'column' ? ' selected' : '') + '>One column</option>' +
      '<option value="page"' + (curSpan === 'page' ? ' selected' : '') + '>Full page width</option>' +
      '</select></label>' +
      /* V3.410 — spacing / nudge stepper: signed mm on the float's
       * text-facing side, additive over the document Spacing preset.
       * A stepper (not a slider): one change → one transact → one
       * debounced render. Tables included. */
      '<label class="pdv-fig-pop-spacing">Spacing ' +
      '<span class="pdv-fig-pop-step">' +
      '<button type="button" data-pdv-sp-minus title="Tighter (−1 mm)">−</button>' +
      '<b data-pdv-sp-val>' + (curSpacing === 0 ? 'default' : ((curSpacing > 0 ? '+' : '') + curSpacing + ' mm')) + '</b>' +
      '<button type="button" data-pdv-sp-plus title="Looser (+1 mm)">+</button>' +
      '<button type="button" data-pdv-sp-reset title="Back to the document default"' + (curSpacing === 0 ? ' hidden' : '') + '>reset</button>' +
      '</span></label>' +
      '<label class="pdv-fig-pop-check"><input type="checkbox" data-pdv-lock' + (curLock ? ' checked' : '') + '> ' + ICON.svg('lock-closed') + ' Lock exact position <span class="pdv-fig-pop-sub">(preprint builds)</span></label>' +
      (isTable ? '' :
      '<label class="pdv-fig-pop-check"><input type="checkbox" data-pdv-center' + (curCenter ? ' checked' : '') + '> Centered</label>' +
      /* V3.402 — replace the image (upload or unplaced-figures library). */
      '<div class="pdv-fig-pop-actions">' +
      '<button type="button" data-pdv-upload>' + ICON.svg('photo') + ' Upload image…</button>' +
      '<button type="button" data-pdv-library>' + ICON.svg('books') + ' From library…</button>' +
      '</div>' +
      '<input type="file" data-pdv-file accept="image/png,image/jpeg,image/gif,image/webp,image/svg+xml,application/pdf" style="display:none">' +
      '<div class="pdv-fig-pop-lib" data-pdv-lib hidden></div>') +
      '<div class="pdv-fig-pop-hint">Anchor + span + lock drive the LaTeX float (' + (isTable ? 'table' : 'figure') + '* spans both columns in two-column journals). Spacing nudges the gap on the text side (mm, on top of the document preset) — the preview shows it for top/bottom-anchored floats; in-flow blocks carry it to the PDF only. Changes save to the block — the panels and export see them too.</div>' +
      '<button class="pdv-fig-pop-close" title="Close">' + ICON.svg('x-mark') + '</button>';
    state.overlayEl.appendChild(pop);
    state.popEl = pop;

    /* Anchor to the figure, clamped to the viewport. */
    var r = figEl.getBoundingClientRect();
    pop.style.left = Math.max(8, Math.min(r.right + 10, window.innerWidth - 250)) + 'px';
    pop.style.top = Math.max(58, Math.min(r.top, window.innerHeight - 220)) + 'px';

    pop.querySelector('.pdv-fig-pop-close').addEventListener('click', _closeFigPopover);
    var widthSel = pop.querySelector('[data-pdv-width]');
    if (widthSel) widthSel.addEventListener('change', function (ev) {
      _writeFigAttr(blockId, 'width', ev.target.value, 'fig-width');
    });
    var placeSelEl = pop.querySelector('[data-pdv-place]');
    if (placeSelEl) placeSelEl.addEventListener('change', function (ev) {
      /* V3.395 — a legacy placement choice also updates the layout
       * intent so the two vocabularies never diverge. One transact. */
      var kv = { placement: ev.target.value };
      if (window.PaperLayout && window.PaperLayout.placementToAnchor) {
        var la = window.PaperLayout.placementToAnchor(ev.target.value);
        kv.anchor = la.anchor;
        kv.lock = la.lock;
      }
      _writeFigAttrs(blockId, kv, 'fig-placement');
      var aSel = pop.querySelector('[data-pdv-anchor]');
      if (aSel && kv.anchor) aSel.value = kv.anchor;
      var lCb = pop.querySelector('[data-pdv-lock]');
      if (lCb && 'lock' in kv) lCb.checked = !!kv.lock;
    });
    /* V3.395 review fix — every intent change writes the FULL current
     * intent (anchor + span + lock, read live from the popover) in one
     * transact. A single-key write on a LEGACY block (no anchor attr)
     * would be a silent no-op: both figureToTex and the preview gate on
     * `attrs.anchor`, so Span/Lock alone never opted the block in. This
     * also keeps the three keys from diverging from what the popover
     * displays. */
    function _currentIntent() {
      var anchorVal = pop.querySelector('[data-pdv-anchor]').value;
      var kv = {
        anchor: anchorVal,
        span: pop.querySelector('[data-pdv-span]').value === 'page' ? 'page' : 'column',
        lock: !!pop.querySelector('[data-pdv-lock]').checked,
      };
      /* V3.485 — carry the wrap side whenever the block is wrapped. */
      if (anchorVal === 'wrap') {
        var wsSel = pop.querySelector('[data-pdv-wrapside]');
        kv.wrap_side = (wsSel && wsSel.value === 'left') ? 'left' : 'right';
      }
      return kv;
    }
    pop.querySelector('[data-pdv-anchor]').addEventListener('change', function (ev) {
      /* V3.485 — reveal/hide the wrap-side control, and when switching TO
       * wrap default a wide figure down to a corner-friendly width so it
       * actually leaves room for text to flow beside it. */
      var toWrap = ev.target.value === 'wrap';
      var wsRow = pop.querySelector('[data-pdv-wrapside-row]');
      if (wsRow) wsRow.hidden = !toWrap;
      var kv = _currentIntent();
      if (toWrap) {
        var wParsed = parseWidth(curWidth, '\\linewidth');
        var tooWide = !wParsed || wParsed.base !== 'absolute' && (wParsed.frac == null || wParsed.frac >= 0.9);
        if (tooWide) {
          kv.width = '0.4\\linewidth';
          kv.size_key = 'custom';
          curWidth = kv.width;
          var wSel = pop.querySelector('[data-pdv-width]');
          if (wSel) {
            if (![].slice.call(wSel.options).some(function (o) { return o.value === kv.width; })) {
              var opt = document.createElement('option');
              opt.value = kv.width; opt.textContent = _widthLabel(kv.width);
              wSel.insertBefore(opt, wSel.firstChild);
            }
            wSel.value = kv.width;
          }
        }
      }
      _writeFigAttrs(blockId, kv, originPrefix + '-anchor');
    });
    var wrapSideSel = pop.querySelector('[data-pdv-wrapside]');
    if (wrapSideSel) wrapSideSel.addEventListener('change', function () {
      _writeFigAttrs(blockId, _currentIntent(), originPrefix + '-wrapside');
    });
    pop.querySelector('[data-pdv-span]').addEventListener('change', function () {
      _writeFigAttrs(blockId, _currentIntent(), originPrefix + '-span');
    });
    pop.querySelector('[data-pdv-lock]').addEventListener('change', function () {
      _writeFigAttrs(blockId, _currentIntent(), originPrefix + '-lock');
    });
    /* V3.410 — spacing stepper. Each click = ONE transact carrying the
     * full intent (legacy opt-in rule) + the new spacing; 0 deletes the
     * key (back to the document default). Clamped ±[-6, +18] mm. */
    var spVal = pop.querySelector('[data-pdv-sp-val]');
    var spReset = pop.querySelector('[data-pdv-sp-reset]');
    function _writeSpacing(mm) {
      mm = Math.max(-6, Math.min(18, Math.round(mm)));
      curSpacing = mm;
      spVal.textContent = mm === 0 ? 'default' : ((mm > 0 ? '+' : '') + mm + ' mm');
      if (spReset) spReset.hidden = (mm === 0);
      var kv = _currentIntent();
      kv.spacing = mm === 0 ? null : mm;    // null → attrs.delete
      _writeFigAttrs(blockId, kv, originPrefix + '-spacing');
    }
    var spMinus = pop.querySelector('[data-pdv-sp-minus]');
    if (spMinus) spMinus.addEventListener('click', function () { _writeSpacing(curSpacing - 1); });
    var spPlus = pop.querySelector('[data-pdv-sp-plus]');
    if (spPlus) spPlus.addEventListener('click', function () { _writeSpacing(curSpacing + 1); });
    if (spReset) spReset.addEventListener('click', function () { _writeSpacing(0); });
    var centerCb = pop.querySelector('[data-pdv-center]');
    if (centerCb) centerCb.addEventListener('change', function (ev) {
      _writeFigAttr(blockId, 'centering', !!ev.target.checked, 'fig-center');
    });

    /* V3.402 — replace the figure's image: fresh upload, or copy the
     * pixels from an unplaced library figure (image attrs ONLY — the
     * placed block keeps its caption, number, label, cross-refs). */
    var upBtn = pop.querySelector('[data-pdv-upload]');
    var fileIn = pop.querySelector('[data-pdv-file]');
    if (upBtn && fileIn) {
      upBtn.addEventListener('click', function () {
        if (!window.PAPER_FIGURES || !window.PAPER_FIGURES.uploadImage) {
          _status('Upload module not loaded.');
          return;
        }
        fileIn.click();
      });
      fileIn.addEventListener('change', function () {
        var file = fileIn.files && fileIn.files[0];
        if (!file) return;
        upBtn.disabled = true;
        upBtn.textContent = 'Uploading…';
        window.PAPER_FIGURES.uploadImage(state.paperId, file).then(function (res) {
          _applyImageSwap(blockId, res.storage_path, res.download_url, res.hash, res.mime);
          _closeFigPopover();
          _status('Image replaced.');
        }).catch(function (e) {
          _status('Upload failed: ' + ((e && e.message) || e));
          upBtn.disabled = false;
          ICON.label(upBtn, 'photo', ' Upload image…');
        });
      });
    }
    var libBtn = pop.querySelector('[data-pdv-library]');
    var libEl = pop.querySelector('[data-pdv-lib]');
    if (libBtn && libEl) {
      libBtn.addEventListener('click', function () {
        if (!libEl.hidden) { libEl.hidden = true; return; }
        var rows = (_pe().getUnplacedFigures ? _pe().getUnplacedFigures() : [])
          .filter(function (r) { return r.downloadUrl; });
        libEl.innerHTML = rows.length
          ? rows.map(function (r) {
              return '<button type="button" class="pdv-fig-pop-libitem" data-lib-id="' + _esc(r.blockId) + '">' +
                '<img src="' + _esc(r.downloadUrl) + '" alt="">' +
                '<span>' + _esc(r.label || r.caption || r.blockId) + '</span></button>';
            }).join('')
          : '<div class="pdv-fig-pop-libempty">No images in the unplaced-figures library.</div>';
        libEl.hidden = false;
      });
      libEl.addEventListener('click', function (ev) {
        var item = ev.target.closest && ev.target.closest('[data-lib-id]');
        if (!item) return;
        var src = _pe().findUnplacedYMap && _pe().findUnplacedYMap('figure', item.dataset.libId);
        var sattrs = src && src.get && src.get('attrs');
        if (!sattrs) return;
        _applyImageSwap(blockId,
          sattrs.get('storage_path') || '', sattrs.get('download_url') || '',
          sattrs.get('hash') || '', sattrs.get('mime') || '');
        _closeFigPopover();
        _status('Image replaced from the library.');
      });
    }
  }

  /* V3.402 — swap a figure's pixels in place: image attrs only, one
   * 'figure-upload' transact (the Figures panel + export read it as a
   * normal re-upload). The old aspect-ratio cache entry is dropped so
   * the new image re-measures; the session height memo resets too —
   * a same-length URL would otherwise alias the cache key. */
  function _applyImageSwap(blockId, storagePath, downloadUrl, hash, mime) {
    var blk = _findLiveBlock(blockId);
    if (!blk) return;
    var attrs = blk.get('attrs');
    if (!attrs) return;
    var oldUrl = attrs.get('download_url');
    if (oldUrl) delete state.imgSizeCache[oldUrl];
    if (state.measureCache) state.measureCache = {};
    _writeFigAttrs(blockId, {
      storage_path: storagePath,
      download_url: downloadUrl,
      hash: hash,
      mime: mime,
    }, 'figure-upload');
  }

  /* Same attr keys + transact origins as the Figures-panel layout UI
   * (paper-blocks.js) — its observers and the export read them as-is.
   * The write's own yDoc update event re-arms the shared render timer,
   * so the popover's 150 ms call wins and exactly one render happens. */
  function _writeFigAttr(blockId, key, value, origin) {
    var kv = {};
    kv[key] = value;
    _writeFigAttrs(blockId, kv, origin);
  }

  /* V3.395 — multi-key variant: one transact for writes that must stay
   * atomic (e.g. placement + its derived anchor/lock). */
  /* ── V3.910 — Layout check ──────────────────────────────────────
   * Under a journal look every paragraph is set by the TeX line breaker,
   * so the Document view knows the PDF line by line. The check reads that
   * (state.tsReport, filled by _typesetParagraphs) and the mounted pages:
   *   loose      a line stretched past badness 500, the emergency pass, or
   *              an overfull line;
   *   orphan     a paragraph's first line alone at a column foot;
   *   widow      its last line alone at the head of the next column;
   *   far        a figure or table two or more pages after its first
   *              mention (a chip, or "Fig. 3" / "Table 2" in the text);
   *   last page  how full the last page is;
   *   save       paragraphs \looseness=-1 would set one line shorter.
   * Tighten / Loosen write attrs.looseness (−1 / +1) on the block. The
   * exporter writes the same \looseness, so the PDF follows. */
  function _buildLayoutReport(geom) {
    var btn = state.overlayEl && state.overlayEl.querySelector('#pdv-check');
    if (!btn) return;
    if (!geom.look || !state.scaleEl) {
      btn.hidden = true;
      state.layoutReport = null;
      if (state.checkPanelEl) _closeCheckPanel();
      return;
    }
    btn.hidden = false;
    var pe = _pe();
    var sheets = Array.prototype.slice.call(state.scaleEl.querySelectorAll('.pdv-sheet'));
    var ts = state.tsReport || {};
    var rep = { pages: sheets.length, loose: [], orphans: [], widows: [], far: [], save: [], adjusted: [], lastFrac: 0, lastLines: 0 };
    function snippet(el) { return (el.textContent || '').replace(/\s+/g, ' ').trim().slice(0, 90); }
    var frags = {}, order = [];
    sheets.forEach(function (sh, pi) {
      sh.querySelectorAll('.pts-para[data-block-id]').forEach(function (el) {
        if (el.closest('.pdv-figure, .pdv-table-wrap, .pdv-abstract, .pdv-factbox')) return;
        var id = el.dataset.blockId;
        var n = 0;
        for (var c = el.firstChild; c; c = c.nextSibling) if (c.classList && c.classList.contains('pts-ln')) n++;
        if (!frags[id]) { frags[id] = []; order.push(id); }
        frags[id].push({ page: pi, lines: n, el: el });
      });
    });
    order.forEach(function (id) {
      var f = frags[id], r = ts[id], first = f[0];
      var item = { id: id, page: first.page, text: snippet(first.el) };
      if (f.length > 1) {
        if (first.lines === 1) rep.orphans.push(item);
        if (f[f.length - 1].lines === 1) rep.widows.push({ id: id, page: f[f.length - 1].page, text: item.text });
      }
      if (!r) return;
      var worst = 0;
      (r.ratios || []).slice(0, -1).forEach(function (x) { if (x > worst) worst = x; });   // a short last line is fine
      var bad = Math.round(100 * Math.pow(Math.max(0, worst), 3));
      /* with a \looseness TeX runs on to its last pass to reach the line
       * count, so the pass says nothing about the spacing then (V3.913) */
      if (r.overfull || bad > 500 || (r.pass === 3 && !r.lz)) {
        rep.loose.push({ id: id, page: item.page, text: item.text, badness: bad, overfull: r.overfull, emergency: r.pass === 3 });
      }
      if (r.canTighten) rep.save.push(item);
      if (r.looseness) rep.adjusted.push({ id: id, page: item.page, text: item.text, looseness: r.looseness });
    });
    /* figures and tables far from where they are first cited */
    var byNum = {}, labelOf = {};
    (pe.getNumberedFigures ? pe.getNumberedFigures() : []).forEach(function (x) { byNum['F' + x.num] = x.blockId; labelOf[x.blockId] = 'Fig. ' + x.num; });
    (pe.getNumberedTables ? pe.getNumberedTables() : []).forEach(function (x) { byNum['T' + x.num] = x.blockId; labelOf[x.blockId] = 'Table ' + x.num; });
    var floatPage = {}, mention = {};
    var refRe = /(Supplementary\s+)?\b(Fig(?:ure)?s?\.?|Tables?)\s*(\d+)/g;
    sheets.forEach(function (sh, pi) {
      sh.querySelectorAll('.pdv-figure[data-block-id], .pdv-table-wrap[data-block-id]').forEach(function (el) {
        if (floatPage[el.dataset.blockId] == null) floatPage[el.dataset.blockId] = pi;
      });
      sh.querySelectorAll('.pe-figref-chip[data-block-id], .pe-tabref-chip[data-block-id]').forEach(function (el) {
        if (mention[el.dataset.blockId] == null) mention[el.dataset.blockId] = pi;
      });
      sh.querySelectorAll('.pts-para').forEach(function (el) {
        if (el.closest('.pdv-figure, .pdv-table-wrap')) return;
        var t = el.textContent || '', m;
        refRe.lastIndex = 0;
        while ((m = refRe.exec(t))) {
          if (m[1]) continue;   // "Supplementary Fig. 2" is not this paper's figure
          var b = byNum[(m[2].charAt(0) === 'T' ? 'T' : 'F') + m[3]];
          if (b && mention[b] == null) mention[b] = pi;
        }
      });
    });
    Object.keys(floatPage).forEach(function (b) {
      if (mention[b] == null || !labelOf[b]) return;
      if (floatPage[b] - mention[b] >= 2) rep.far.push({ id: b, page: floatPage[b], mention: mention[b], label: labelOf[b] });
    });
    /* how full the last page is */
    var pages = state.lastPages || [];
    var last = pages[pages.length - 1];
    if (last && !last.isFloatPage) {
      var used = (last.usedH || 0) + (last.topH || 0) + (last.bottomH || 0) + (last.footH || 0);
      rep.lastFrac = Math.min(1, used / (geom.bodyH * (geom.cols === 2 ? 1 : 1)));
      rep.lastLines = Math.ceil(used / (geom.leadPx || 14));
    }
    /* V3.912 — wrapped figures wrapfig could not set beside text */
    rep.wraps = [];
    Object.keys(state.wrapReport || {}).forEach(function (b) {
      var w = state.wrapReport[b];
      if (w.state === 'collision' || w.state === 'end') rep.wraps.push({ id: b, page: w.page - 1, label: labelOf[b] || 'A figure', kind: w.state });
      else if (w.state === 'held' && mention[b] != null && w.page - 1 > mention[b]) {
        rep.wraps.push({ id: b, page: w.page - 1, label: labelOf[b] || 'A figure', kind: 'held', mention: mention[b] });
      }
    });
    rep.grant = _grantReport(geom, sheets, rep);
    state.layoutReport = rep;
    var count = rep.loose.length + rep.orphans.length + rep.widows.length + rep.far.length +
      rep.wraps.length + (rep.grant ? rep.grant.errors : 0);
    var cEl = state.overlayEl.querySelector('#pdv-check-count');
    if (cEl) cEl.textContent = count ? String(count) : '';
    if (state.checkPanelEl) _renderCheckPanel();
  }

  /* V3.913 — a grant document against its funder's rules
   * (PaperGrantRules) and its page limit, measured on the laid-out pages. */
  function _grantReport(geom, sheets, rep) {
    var tpl = state.template;
    if (!window.PaperGrantRules || !tpl || !tpl.grant || !geom.look) return null;
    var key = state.grantDoc || 'project_description';
    var rule = window.PaperGrantRules.docRule(tpl, key) || {};
    var pages = state.lastPages || [];
    var lead = geom.leadPx || 16;
    var perPage = Math.floor(geom.bodyH / lead + 1e-6);
    function lines(pg) { return pg ? ((pg.usedH || 0) + (pg.topH || 0) + (pg.bottomH || 0) + (pg.footH || 0)) / lead : 0; }
    var limit = rule.page_limit || null;
    var over = 0;
    if (limit && pages.length > limit) {
      for (var i = limit; i < pages.length; i++) over += Math.ceil(lines(pages[i]) - 0.05);
    }
    var lastLines = Math.ceil(lines(pages[pages.length - 1]) - 0.05);
    var spare = limit && pages.length <= limit ? (limit - pages.length) * perPage + Math.max(0, perPage - lastLines) : 0;
    // headings, where they fall, and how many pages each section spans
    var heads = [], tops = [];
    sheets.forEach(function (sh, pi) {
      var body = sh.querySelector('.pdv-sheet-body');
      var top0 = body ? body.getBoundingClientRect().top : sh.getBoundingClientRect().top;
      sh.querySelectorAll('.pdv-heading, .pdv-subheading').forEach(function (h) {
        var t = (h.textContent || '').replace(/\s+/g, ' ').trim();
        if (!t) return;
        var z = state.zoomK || 1;
        var at = pi + (h.getBoundingClientRect().top - top0) / z / geom.bodyH;
        var lvl = h.classList.contains('pdv-heading') ? 1 : (h.classList.contains('pdv-subheading-l3') ? 3 : 2);
        heads.push({ text: t, page: pi + 1, level: lvl, at: at });
      });
    });
    var endAt = (pages.length - 1) + Math.min(1, lines(pages[pages.length - 1]) / perPage);
    var sectionPages = {}, sections = [];
    heads.forEach(function (h, i) {
      var nx = null;
      for (var j = i + 1; j < heads.length; j++) if (heads[j].level <= h.level) { nx = heads[j]; break; }
      var span = (nx ? nx.at : endAt) - h.at;
      sectionPages[h.text] = Math.round(span * 100) / 100;
      if (h.level === 1) sections.push({ text: h.text, pages: Math.round(span * 10) / 10, lines: Math.round(span * perPage) });
    });
    var text = '';
    sheets.forEach(function (sh) {
      sh.querySelectorAll('.pdv-bodypara, .pdv-figcap, .pdv-tabcap').forEach(function (p) { text += ' ' + (p.textContent || ''); });
    });
    var checks = window.PaperGrantRules.check({ template: tpl, look: geom.look,
      doc: { key: key, pages: pages.length, linesOver: over, lastPageLines: lastLines, linesPerPage: perPage,
        headings: heads, text: text, sectionPages: sectionPages } });
    var errors = checks.filter(function (c) { return c.level === 'error'; }).length;
    return { key: key, rule: rule, limit: limit, pages: pages.length, over: over, spare: spare, perPage: perPage,
      checks: checks, errors: errors, sections: sections, guide: tpl.grant.guide || '' };
  }

  /* V3.913 — this paper's own look settings (paperExports.lookOverrides):
   * the PDF and the preview both read them. */
  async function _saveLookOverrides(ov) {
    var prev = state.config.lookOverrides || null;
    state.config.lookOverrides = ov && Object.keys(ov).length ? ov : null;
    state.forceRender = true;
    scheduleRender(30);
    try {
      await firebridge.db().collection('paperExports').doc(state.paperId).set({
        lookOverrides: state.config.lookOverrides,
        updatedBy: (firebridge.getUser() || {}).uid || null,
      }, { merge: true });
    } catch (e) {
      state.config.lookOverrides = prev;
      state.forceRender = true;
      scheduleRender(30);
      _status('Could not save the page settings: ' + (e.message || e));
    }
  }

  /* V3.913 — Fit to the page limit. The steps, gentlest first, each
   * adding to the last: paragraphs TeX can set a line shorter; captions
   * 9.5 then 9 pt; the line pitch down to the PAPPG's 12 pt; the text
   * size down to the typeface's minimum. Every step stays inside the
   * rules. Lays the document out for each candidate (a binary search over
   * the ladder) and stops at the first that fits; nothing is saved until
   * Keep. */
  function _fitLadder(look, ov, tf) {
    var steps = [], cur = Object.assign({}, ov || {});
    function push(label, patch) { cur = Object.assign({}, cur, patch); steps.push({ label: label, cat: Object.keys(patch)[0], ov: Object.assign({}, cur) }); }
    if (!cur['body.looseness']) push('tighten every paragraph TeX can set a line shorter', { 'body.looseness': -1 });
    [9.5, 9].forEach(function (s) {
      if (look.caption.size > s + 0.01) push('captions ' + s + ' pt', { 'caption.size': s, 'caption.lead': Math.round(s * 1.15 * 100) / 100 });
    });
    [12.4, 12.2, 12].forEach(function (l) {
      if (look.body.lead > l + 0.01) push('line pitch ' + l + ' pt', { 'body.lead': l });
    });
    var min = tf ? tf.min_size : look.body.size;
    for (var s = look.body.size - 0.5; s >= min - 0.01; s -= 0.5) push('text ' + s + ' pt', { 'body.size': s });
    return steps;
  }
  async function _fitToLimit() {
    var g = state.layoutReport && state.layoutReport.grant;
    if (!g || !g.limit || state.fitting) return;
    var look = state.lastLook;
    var tf = window.PaperGrantRules.typeface(state.template, look.fonts.text);
    var orig = state.config.lookOverrides || {};
    var steps = _fitLadder(look, orig, tf);
    state.fitting = { status: 'Laying out…', orig: orig };
    _renderCheckPanel();
    async function pagesWith(ov) {
      state.config.lookOverrides = ov;
      state.forceRender = true;
      await renderDocument();
      return (state.lastPages || []).length;
    }
    var lo = 0, hi = steps.length - 1, best = -1, tries = 0;
    if (!steps.length) hi = -1;
    while (lo <= hi && tries < 8) {
      var mid = (lo + hi) >> 1;
      state.fitting.status = 'Trying: ' + steps.slice(0, mid + 1).map(function (x) { return x.label; }).join(', ') + '…';
      _renderCheckPanel();
      var n = await pagesWith(steps[mid].ov);
      tries++;
      if (n <= g.limit) { best = mid; hi = mid - 1; } else lo = mid + 1;
    }
    var result;
    if (best >= 0) {
      await pagesWith(steps[best].ov);
      var g2 = state.layoutReport && state.layoutReport.grant;
      // one label per setting: the last step of each kind says its final value
      var labels = [];
      steps.slice(0, best + 1).forEach(function (x, i, arr) {
        if (!arr.slice(i + 1).some(function (y) { return y.cat === x.cat; })) labels.push(x.label);
      });
      result = { ok: true, ov: steps[best].ov, labels: labels, spare: g2 ? g2.spare : 0 };
    } else {
      // even the last step does not fit: show how far it is, then go back
      var last = steps.length ? steps[steps.length - 1].ov : orig;
      await pagesWith(last);
      var g3 = state.layoutReport && state.layoutReport.grant;
      result = { ok: false, over: g3 ? g3.over : null, pages: g3 ? g3.pages : null };
      await pagesWith(orig);
    }
    state.fitting = null;
    state.fitResult = result;
    _renderCheckPanel();
  }
  function _fitKeep() {
    var r = state.fitResult;
    state.fitResult = null;
    if (r && r.ok) _saveLookOverrides(r.ov);
    else _renderCheckPanel();
  }
  function _fitUndo() {
    state.fitResult = null;
    state.config.lookOverrides = (state.fitting && state.fitting.orig) || state.savedOverrides || state.config.lookOverrides;
    _reloadOverrides();
  }
  async function _reloadOverrides() {
    try {
      var snap = await firebridge.db().collection('paperExports').doc(state.paperId).get();
      var d = snap.exists ? (snap.data() || {}) : {};
      state.config.lookOverrides = d.lookOverrides && typeof d.lookOverrides === 'object' ? d.lookOverrides : null;
    } catch (e) { /* keep what we have */ }
    state.forceRender = true;
    scheduleRender(30);
  }

  /* The grant part of the Check panel: the page budget, Fit, the
   * funder's rules, wrapped-figure trouble, the page settings and the
   * length of each section. */
  function _grantPanelHtml(rep, editable) {
    var g = rep.grant;
    if (!g) return '';
    var look = state.lastLook || {};
    var ov = state.config.lookOverrides || {};
    var tpl = state.template || {};
    var h = '';
    var label = (g.rule && g.rule.label) || 'Document';
    if (g.limit) {
      var overCls = g.pages > g.limit ? ' pdv-budget-over' : '';
      h += '<div class="pdv-budget' + overCls + '"><div class="pdv-budget-n">' + g.pages + ' / ' + g.limit + ' pages</div><div>' + _esc(label) + ' · ' +
        (g.pages > g.limit ? 'about ' + g.over + ' line' + (g.over === 1 ? '' : 's') + ' over the limit'
          : g.spare + ' line' + (g.spare === 1 ? '' : 's') + ' to spare') + '</div>';
      if (editable && state.fitting) h += '<div class="pdv-check-hint">' + _esc(state.fitting.status) + '</div>';
      else if (editable && state.fitResult) {
        var r = state.fitResult;
        h += r.ok
          ? '<div class="pdv-fit-res">Fits in ' + g.limit + ' pages with: ' + _esc(r.labels.join('; ')) + '. ' + r.spare + ' line' + (r.spare === 1 ? '' : 's') +
            ' to spare.<div class="pdv-check-acts"><button class="btn btn-sm btn-primary" data-pdv-check="fit-keep">Keep</button>' +
            '<button class="btn btn-sm" data-pdv-check="fit-undo">Undo</button></div></div>'
          : '<div class="pdv-fit-res">Even at the smallest type the rules allow it runs ' + r.pages + ' pages, about ' + r.over +
            ' lines over: shorten the text by that much (the section lengths are below).' +
            '<div class="pdv-check-acts"><button class="btn btn-sm" data-pdv-check="fit-dismiss">OK</button></div></div>';
      } else if (editable && g.pages > g.limit) {
        h += '<div class="pdv-check-acts"><button class="btn btn-sm btn-primary" data-pdv-check="fit">Fit to ' + g.limit + ' pages</button>' +
          '<span class="pdv-check-hint">tries the gentlest settings first; nothing is kept until you say so</span></div>';
      }
      h += '</div>';
    }
    // the funder's rules: problems listed, passes counted
    var bad = g.checks.filter(function (c) { return c.level === 'error' || c.level === 'warn'; });
    var info = g.checks.filter(function (c) { return c.level === 'info'; });
    var good = g.checks.filter(function (c) { return c.level === 'ok'; });
    h += '<h4>' + _esc(tpl.grant.agency || 'Funder') + ' rules <span class="pdv-check-hint">' + _esc(g.guide) + '</span></h4><ul>';
    bad.concat(info).forEach(function (c) {
      h += '<li class="pdv-rule pdv-rule-' + c.level + '"><div class="pdv-check-row">' + ICON.svg(c.level === 'error' ? 'x-circle' : c.level === 'warn' ? 'exclamation-triangle' : 'information-circle') +
        '<span>' + _esc(c.title) + '</span></div>' + (c.detail ? '<div class="pdv-check-note">' + _esc(c.detail) + '</div>' : '') +
        (c.fix ? '<div class="pdv-check-note">' + _esc(c.fix) + '</div>' : '') + '</li>';
    });
    h += '</ul><details class="pdv-rule-ok"><summary>' + ICON.svg('check') + ' ' + good.length + ' rule' + (good.length === 1 ? '' : 's') + ' met</summary><ul>' +
      good.map(function (c) { return '<li>' + _esc(c.title) + (c.detail ? ' <span class="pdv-check-hint">' + _esc(c.detail) + '</span>' : '') + '</li>'; }).join('') +
      '</ul></details>';
    // wrapped figures
    if (rep.wraps.length) {
      h += '<h4>Wrapped figures <span class="pdv-check-n">' + rep.wraps.length + '</span></h4><ul>' + rep.wraps.map(function (w) {
        var note = w.kind === 'collision'
          ? 'It was still waiting for room beside text when the next wrapped figure began, so it is set alone (outlined). Move it earlier, make it smaller, or move the next wrapped figure further on.'
          : w.kind === 'end'
          ? 'No paragraph after it had room beside it (or the figure before was still wrapping), so it is set alone at the end. Move it earlier, or give it a paragraph to sit beside.'
          : 'No room beside text where it is placed, so it waited until page ' + (w.page + 1) + ' (cited on page ' + (w.mention + 1) + '). A smaller figure or an earlier position keeps it with its text.';
        return '<li><div class="pdv-check-row"><span class="pdv-check-page">p. ' + (w.page + 1) + '</span><span class="pdv-check-text">' + _esc(w.label) +
          '</span></div><div class="pdv-check-note">' + note + '</div><div class="pdv-check-acts"><button class="btn btn-sm" data-pdv-check="show" data-id="' +
          _esc(w.id) + '">Show</button></div></li>';
      }).join('') + '</ul>';
    }
    // page settings: the knobs, each inside the rules
    if (editable) {
      var tfs = (tpl.grant.typefaces || []);
      var curFont = look.fonts && look.fonts.text;
      var tf = window.PaperGrantRules.typeface(tpl, curFont);
      function num(key, lab, val, min, max, step, hint) {
        return '<label class="pdv-ov-row"><span>' + lab + '</span><input type="number" data-pdv-ov="' + key + '" value="' + (Math.round(val * 100) / 100) +
          '" min="' + min + '" max="' + max + '" step="' + step + '"><span class="pdv-check-hint">' + hint + '</span></label>';
      }
      h += '<h4>Page settings</h4><div class="pdv-ov">' +
        '<label class="pdv-ov-row"><span>Typeface</span><select data-pdv-ov="fonts.text">' + tfs.map(function (t) {
          return '<option value="' + _esc(t.font) + '"' + (t.font === curFont ? ' selected' : '') + '>' + _esc(t.label) + ' (' + t.min_size + ' pt+)</option>';
        }).join('') + '</select></label>' +
        num('body.size', 'Text size', look.body.size, tf ? tf.min_size : 8, 14, 0.5, 'pt, ' + (tf ? tf.min_size : '') + ' or more') +
        num('body.lead', 'Line pitch', look.body.lead, 12, 20, 0.05, 'pt, 12 or more (6 lines an inch)') +
        num('body.parskip', 'Paragraph space', look.body.parskip || 0, 0, 12, 1, 'pt between paragraphs') +
        num('caption.size', 'Caption size', look.caption.size, 7, 12, 0.5, 'pt (smaller is allowed)') +
        num('colsep', 'Gap beside wrapped figures', look.colsep, 4, 24, 1, 'pt') +
        '<label class="pdv-ov-row"><span>Tighten paragraphs</span><input type="checkbox" data-pdv-ov="body.looseness"' + (look.body.looseness ? ' checked' : '') +
        '><span class="pdv-check-hint">one line shorter wherever TeX can</span></label>' +
        (Object.keys(ov).length ? '<div class="pdv-check-acts"><button class="btn btn-sm" data-pdv-check="ov-reset">Back to the ' + _esc(look.name || 'template') + ' settings</button></div>' : '') +
        '</div>';
    }
    if (g.sections.length) {
      h += '<details class="pdv-sections"><summary>Length of each section</summary><ul>' + g.sections.map(function (s) {
        return '<li><div class="pdv-check-row"><span class="pdv-check-text">' + _esc(s.text) + '</span><span class="pdv-check-page">' + s.pages + ' p · ' + s.lines + ' lines</span></div></li>';
      }).join('') + '</ul></details>';
    }
    return h;
  }

  function _closeCheckPanel() {
    if (state.checkPanelEl && state.checkPanelEl.parentNode) state.checkPanelEl.parentNode.removeChild(state.checkPanelEl);
    state.checkPanelEl = null;
  }
  function _openCheckPanel() {
    if (!state.overlayEl) return;
    var el = document.createElement('div');
    el.className = 'pdv-check-panel';
    state.overlayEl.appendChild(el);
    state.checkPanelEl = el;
    /* V3.913 — page settings: each change is this paper's look */
    el.addEventListener('change', function (ev) {
      var inp = ev.target.closest('[data-pdv-ov]');
      if (!inp || !_pe().isEditable()) return;
      var key = inp.dataset.pdvOv;
      var ov = Object.assign({}, state.config.lookOverrides || {});
      if (inp.type === 'checkbox') { if (inp.checked) ov[key] = -1; else delete ov[key]; }
      else if (inp.tagName === 'SELECT') {
        ov[key] = inp.value;
        var tf = window.PaperGrantRules && window.PaperGrantRules.typeface(state.template, inp.value);
        var cur = state.lastLook && state.lastLook.body.size;
        if (tf && cur < tf.min_size) ov['body.size'] = tf.min_size;   // keep the text legal for the new face
      } else {
        var v = parseFloat(inp.value);
        if (!isFinite(v)) return;
        ov[key] = v;
        if (key === 'caption.size') ov['caption.lead'] = Math.round(v * 1.15 * 100) / 100;
      }
      _saveLookOverrides(ov);
    });
    el.addEventListener('click', function (ev) {
      var t = ev.target.closest('[data-pdv-check]');
      if (!t) return;
      var act = t.dataset.pdvCheck, id = t.dataset.id;
      if (act === 'close') { _closeCheckPanel(); return; }
      if (act === 'show') { _showBlock(id); return; }
      if (!_pe().isEditable()) return;
      if (act === 'fit') { _fitToLimit(); return; }
      if (act === 'fit-keep') { _fitKeep(); return; }
      if (act === 'fit-undo') { _fitUndo(); return; }
      if (act === 'fit-dismiss') { state.fitResult = null; _renderCheckPanel(); return; }
      if (act === 'ov-reset') { _saveLookOverrides(null); return; }
      if (act === 'tighten') _writeFigAttrs(id, { looseness: -1 }, 'looseness');
      else if (act === 'loosen') _writeFigAttrs(id, { looseness: 1 }, 'looseness');
      else if (act === 'reset') _writeFigAttrs(id, { looseness: null }, 'looseness');
      else if (act === 'save-page') {
        var rep = state.layoutReport || {};
        var n = parseInt(t.dataset.n || '0', 10);
        /* the paragraphs nearest the end move the last lines first */
        (rep.save || []).slice(-n).forEach(function (s) { _writeFigAttrs(s.id, { looseness: -1 }, 'looseness'); });
      }
    });
    _renderCheckPanel();
  }
  function _showBlock(id) {
    var el = state.scaleEl && state.scaleEl.querySelector('.pdv-sheet [data-block-id="' + (window.CSS && CSS.escape ? CSS.escape(id) : id) + '"]');
    if (!el) return;
    el.scrollIntoView({ block: 'center', behavior: 'smooth' });
    el.classList.add('pdv-flash');
    setTimeout(function () { el.classList.remove('pdv-flash'); }, 1600);
  }
  function _renderCheckPanel() {
    var el = state.checkPanelEl, rep = state.layoutReport;
    if (!el) return;
    var editable = _pe().isEditable();
    function row(it, extra, actions) {
      return '<li><div class="pdv-check-row"><span class="pdv-check-page">p. ' + (it.page + 1) + '</span>' +
        '<span class="pdv-check-text">' + _esc(it.text || it.label || '') + '</span></div>' +
        (extra ? '<div class="pdv-check-note">' + extra + '</div>' : '') +
        '<div class="pdv-check-acts"><button class="btn btn-sm" data-pdv-check="show" data-id="' + _esc(it.id) + '">Show</button>' +
        (editable ? (actions || []).map(function (a) {
          return '<button class="btn btn-sm" data-pdv-check="' + a[0] + '" data-id="' + _esc(it.id) + '" title="' + _esc(a[2]) + '">' + a[1] + '</button>';
        }).join('') : '') + '</div></li>';
    }
    var TIGHT = ['tighten', 'Tighten', 'Set this paragraph one line shorter (\\looseness=-1), when TeX can'];
    var LOOSE = ['loosen', 'Loosen', 'Set this paragraph one line longer (\\looseness=1)'];
    var h = '<div class="pdv-check-head">' + ICON.svg('check-circle') + ' Layout check' +
      '<button class="pdv-check-x" data-pdv-check="close" title="Close">' + ICON.svg('x-mark') + '</button></div>';
    if (!rep) {
      el.innerHTML = h + '<p class="pdv-check-empty">Pick a journal with a published look to check its layout.</p>';
      return;
    }
    var fill = Math.round(rep.lastFrac * 100);
    h += _grantPanelHtml(rep, editable);   // V3.913 — a grant: page budget, rules, Fit
    h += '<p class="pdv-check-sum">' + rep.pages + ' pages · the last page is ' + fill + '% full' +
      (rep.save.length ? ' · ' + rep.save.length + ' paragraph' + (rep.save.length === 1 ? '' : 's') + ' could lose a line' : '') + '</p>';
    if (editable && rep.lastFrac > 0 && rep.lastFrac < 0.25 && rep.save.length >= rep.lastLines && rep.lastLines > 0) {
      h += '<div class="pdv-check-save">About ' + rep.lastLines + ' line' + (rep.lastLines === 1 ? '' : 's') + ' run onto the last page. ' +
        '<button class="btn btn-sm btn-primary" data-pdv-check="save-page" data-n="' + rep.lastLines + '">Tighten ' + rep.lastLines +
        ' paragraph' + (rep.lastLines === 1 ? '' : 's') + '</button> <span class="pdv-check-hint">the ones nearest the end; undo with Reset below</span></div>';
    }
    function section(title, list, fmt, cap) {
      if (!list.length) return '';
      var shown = cap ? list.slice(-cap) : list;   // capped lists keep the ones nearest the end
      return '<h4>' + title + ' <span class="pdv-check-n">' + list.length + '</span></h4><ul>' + shown.map(fmt).join('') + '</ul>' +
        (shown.length < list.length ? '<p class="pdv-check-hint">' + (list.length - shown.length) + ' more earlier in the paper.</p>' : '');
    }
    var body =
      section('Loose lines', rep.loose, function (it) {
        return row(it, it.overfull ? 'A line runs into the margin.' : it.emergency ? 'TeX needed its emergency stretch here.' : 'Widest spacing: badness ' + it.badness + '.',
          [TIGHT, LOOSE]);
      }) +
      section('Orphans', rep.orphans, function (it) {
        return row(it, 'The first line sits alone at the foot of a column.', [TIGHT, LOOSE]);
      }) +
      section('Widows', rep.widows, function (it) {
        return row(it, 'The last line sits alone at the top of a column.', [TIGHT, LOOSE]);
      }) +
      section('Figures and tables far from their citation', rep.far, function (it) {
        return row({ id: it.id, page: it.page, text: it.label }, 'First cited on page ' + (it.mention + 1) + ', set ' + (it.page - it.mention) + ' pages later.', []);
      }) +
      section('Paragraphs you adjusted', rep.adjusted, function (it) {
        return row(it, it.looseness < 0 ? 'Set one line shorter.' : 'Set one line longer.', [['reset', 'Reset', 'Let TeX choose the lines again']]);
      }) +
      section('Could lose a line', rep.save, function (it) { return row(it, '', [TIGHT]); }, 10);
    el.innerHTML = h + (body || '<p class="pdv-check-empty">' + ICON.svg('check') + ' Nothing to fix: no loose lines, widows, orphans or stray figures.</p>');
  }

  function _writeFigAttrs(blockId, kv, origin) {
    var blk = _findLiveBlock(blockId);
    if (!blk) return;
    var attrs = blk.get('attrs');
    if (!attrs) return;
    blk.doc.transact(function () {
      Object.keys(kv).forEach(function (k) {
        /* null = delete the key (V3.405 — e.g. releasing a max_h cap
         * restores the absent-key sentinel, not a stored null). */
        if (kv[k] === null) attrs.delete(k);
        else attrs.set(k, kv[k]);
      });
    }, origin);
    scheduleRender(150);
  }

  /* ── Citation details panel (V3.393) ───────────────────────────
   * Click an inline citation chip → left slide-in panel with the
   * citation's library metadata plus every piece of claim evidence
   * attached to that citation's use in this draft. Claims come from
   * the PaperBulletClaims cache (subscribed at editor mount); each
   * claim's supporting/counter refs are {paperId, annId} pairs whose
   * highlight text lives at papers/{paperId}/annotations/{annId} —
   * the exact chain the editor's citation popover walks (V3.192).
   * Read-only; open to viewers, survives re-renders (sibling of the
   * desk, not inside .pdv-scale). */

  function _closeCitePanel() {
    if (state.citePanelEl && state.citePanelEl.parentNode) {
      state.citePanelEl.parentNode.removeChild(state.citePanelEl);
    }
    state.citePanelEl = null;
    /* V3.419 — the panel DISPLACES the paper (no overlay): closing
     * releases the desk margin; the set + any pending hover die too. */
    state.citeSetKeys = null;
    if (state.citeHoverTimer) { clearTimeout(state.citeHoverTimer); state.citeHoverTimer = null; }
    if (state.overlayEl) state.overlayEl.classList.remove('pdv-cite-open');
    state.citePanelSeq++;               // abandon in-flight evidence loads
  }

  function _famNumLabel(key) {
    var cs = window.PaperCiteStyle;
    var n = cs && cs.getNumber ? cs.getNumber(key) : null;
    if (n == null) return '@';
    var fam = (cs.getFamily && cs.getFamily()) || null;
    return fam === 'numeric-paren' ? '(' + n + ')' : '[' + n + ']';
  }

  function _openCitePanel(keys, opts) {
    opts = opts || {};
    /* V3.419 — set vs hover: a CLICK sets the panel's citations; a
     * HOVER previews over the set and reverts on mouse-out. Both paths
     * rebuild the panel (the evidence load is seq-guarded async). */
    if (!opts.preview) state.citeSetKeys = keys.slice();
    var keepSet = state.citeSetKeys;
    if (state.citePanelEl && state.citePanelEl.parentNode) {
      state.citePanelEl.parentNode.removeChild(state.citePanelEl);
      state.citePanelEl = null;
      if (state.citeHoverTimer) { clearTimeout(state.citeHoverTimer); state.citeHoverTimer = null; }
    }
    state.citePanelSeq++;               // abandon the previous panel's loads
    state.citeSetKeys = keepSet;
    if (state.overlayEl) state.overlayEl.classList.add('pdv-cite-open');
    state.citeShownKeys = keys.join(';');
    var pe = _pe();
    var byKey = (pe && pe.getCitationByKey && pe.getCitationByKey()) || {};

    var panel = document.createElement('div');
    panel.className = 'pdv-cite-panel';
    var toolbar = state.overlayEl && state.overlayEl.querySelector('.pdv-toolbar');
    panel.style.top = ((toolbar && toolbar.offsetHeight) || 48) + 'px';

    var html = '<div class="pdv-cite-panel-head">' +
      '<span>Citation' + (keys.length > 1 ? 's' : '') + ' &amp; evidence' +
      (opts.preview ? ' <i class="pdv-cite-preview-tag">hover preview — click to set</i>' : '') +
      '</span>' +
      '<button class="pdv-cite-panel-close" title="Close (Esc)">' + ICON.svg('x-mark') + '</button></div>' +
      '<div class="pdv-cite-panel-body">';
    keys.forEach(function (key) {
      var hit = byKey[key];
      html += '<div class="pdv-cite-entry">' +
        '<div class="pdv-cite-entry-head">' +
        '<span class="pdv-cite-entry-num">' + _esc(_famNumLabel(key)) + '</span>';
      if (hit) {
        html += '<span class="pdv-cite-entry-title">' + _esc(hit.title || key) + '</span></div>';
        var authors = _authorList(hit, { initialsFirst: false, lastSep: '&', etAlAfter: 8 });
        if (authors) html += '<div class="pdv-cite-entry-authors">' + authors + '</div>';
        var srcBits = [];
        if (hit.journal) srcBits.push('<i>' + _esc(hit.journal) + '</i>');
        var volPages = (hit.volume || '') +
          (hit.issue ? '(' + hit.issue + ')' : '') +
          (hit.pages ? ':' + hit.pages : '');
        srcBits.push(_esc([hit.year, volPages].filter(Boolean).join('; ')));
        html += '<div class="pdv-cite-entry-src">' + srcBits.filter(Boolean).join(' · ') + '</div>';
        if (hit.doi) {
          html += '<div class="pdv-cite-entry-doi"><a href="https://doi.org/' + _esc(hit.doi) +
                  '" target="_blank" rel="noopener">doi:' + _esc(hit.doi) + '</a></div>';
        }
        html += '<div class="pdv-cite-entry-key">@' + _esc(key) + '</div>';
      } else {
        html += '<span class="pdv-cite-entry-title pdv-cite-missing">@' + _esc(key) +
                ' — not in the lab library</span></div>';
      }
      html += '<div class="pdv-cite-evhead">Evidence in this draft</div>' +
              '<div class="pdv-cite-evidence" data-ev-key="' + _esc(key) + '">' +
              '<div class="pdv-cite-ev-loading">Loading evidence…</div></div></div>';
    });
    html += '</div>';
    panel.innerHTML = html;
    panel.querySelector('.pdv-cite-panel-close').addEventListener('click', _closeCitePanel);
    state.overlayEl.appendChild(panel);
    state.citePanelEl = panel;

    var seq = state.citePanelSeq;
    _loadCiteEvidence(keys).then(function (evByKey) {
      if (seq !== state.citePanelSeq || !state.citePanelEl) return;
      keys.forEach(function (key) {
        var host = state.citePanelEl.querySelector('[data-ev-key="' + (window.CSS && CSS.escape ? CSS.escape(key) : key) + '"]');
        if (!host) return;
        var groups = evByKey[key] || [];
        if (!groups.length) {
          host.innerHTML = '<div class="pdv-muted">No claim evidence is linked to this citation yet. ' +
            'Flag a bullet as a claim in the editor and attach reader highlights as evidence.</div>';
          return;
        }
        host.innerHTML = groups.map(_claimCardHtml).join('');
      });
    }).catch(function () {
      if (seq !== state.citePanelSeq || !state.citePanelEl) return;
      state.citePanelEl.querySelectorAll('.pdv-cite-ev-loading').forEach(function (el) {
        el.textContent = 'Evidence unavailable.';
      });
    });
  }

  function _claimCardHtml(group) {
    var h = '<div class="pdv-cite-claim">' +
      '<div class="pdv-cite-claim-head"><span class="pdv-cite-claim-badge">Claim</span>' +
      (group.status ? '<span class="pdv-cite-claim-status">' + _esc(group.status) + '</span>' : '') +
      '</div>' +
      '<div class="pdv-cite-claim-statement">' + _esc(group.statement || '(no statement)') + '</div>';
    group.evidence.forEach(function (ev) {
      h += '<div class="pdv-cite-ev ' + (ev.stance === 'against' ? 'pdv-cite-ev-against' : 'pdv-cite-ev-for') + '">' +
           '<span class="pdv-cite-ev-stance">' + (ev.stance === 'against' ? '✗ counters' : '✓ supports') + '</span>';
      if (ev.text) h += '<blockquote>' + _esc(ev.text) + '</blockquote>';
      if (ev.comment) h += '<div class="pdv-cite-ev-comment">' + _esc(ev.comment) + '</div>';
      if (!ev.text && !ev.comment) h += '<div class="pdv-cite-ev-comment pdv-muted">highlight unavailable</div>';
      h += '</div>';
    });
    return h + '</div>';
  }

  /* key → [{claimId, statement, status, evidence:[{stance, text, comment}]}]
   * Walks ALL of the draft's claims (not just one paragraph's) so the
   * panel shows every use of the citation as evidence. */
  function _loadCiteEvidence(keys) {
    var pe = _pe();
    var claims = (window.PaperBulletClaims && window.PaperBulletClaims.getAllClaims)
      ? window.PaperBulletClaims.getAllClaims() : [];
    var keyByItemId = {};
    ((pe && pe.getCitationList && pe.getCitationList()) || []).forEach(function (e) {
      if (e && e.itemId) keyByItemId[e.itemId] = e.key;
    });
    var out = {};
    keys.forEach(function (k) { out[k] = []; });
    var pending = [];
    claims.forEach(function (claim) {
      var perKey = {};   // one card per (claim, key) even with several highlights
      [['supporting_evidence_ids', 'for'], ['counter_evidence_ids', 'against']].forEach(function (pair) {
        (claim[pair[0]] || []).forEach(function (ref) {
          if (!ref || !ref.paperId || !ref.annId) return;
          var key = keyByItemId[ref.paperId];
          if (!key || !(key in out)) return;
          if (!perKey[key]) {
            perKey[key] = {
              claimId: claim.id,
              statement: claim.statement || '',
              status: claim.status || '',
              evidence: [],
            };
            out[key].push(perKey[key]);
          }
          var slot = { stance: pair[1], text: '', comment: '' };
          perKey[key].evidence.push(slot);
          pending.push(_fetchAnn(ref.paperId, ref.annId).then(function (ann) {
            if (!ann) return;
            slot.text = ((ann.target && ann.target.pages) || []).map(function (p) {
              return (p && p.selectors && p.selectors.textQuote && p.selectors.textQuote.exact) || '';
            }).filter(Boolean).join(' / ');
            slot.comment = ann.comment || '';
          }));
        });
      });
    });
    return Promise.all(pending).then(function () { return out; });
  }

  function _fetchAnn(paperId, annId) {
    if (typeof firebase === 'undefined' || !firebase.firestore) return Promise.resolve(null);
    try {
      return firebase.firestore()
        .collection('papers').doc(paperId)
        .collection('annotations').doc(annId).get()
        .then(function (snap) { return snap.exists ? snap.data() : null; })
        .catch(function () { return null; });
    } catch (e) { return Promise.resolve(null); }
  }

  window.PaperDocView = { open: open, close: close, isOpen: isOpen };
})();
