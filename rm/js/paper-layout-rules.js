/* paper-layout-rules.js — Layout Mode R1 (foundation)
 *
 * Single source of truth for how a figure/table block's LAYOUT INTENT
 * (anchor / span / lock — written by the Document view's layout mode and
 * the legacy placement dropdowns) becomes a concrete LaTeX float:
 * environment (figure vs figure*), placement string ([t]/[b]/[p]/[!t]/[H]),
 * width spec, and caption position. Consumed by BOTH:
 *
 *   - the exporter (paper-export-tex.js figureToTex/tableToTex), and
 *   - the Document-view preview (paper-doc-view.js), so what you see is
 *     derived from the exact rules the .tex build uses.
 *
 * Layout intent attrs (on the block's attrs Y.Map; see the V3.395 plan):
 *
 *   anchor  'flow' | 'top' | 'bottom' | 'float-page'   default 'flow'
 *   span    'column' | 'page'                           default 'column'
 *   lock    bool                                        default false
 *   size_key 'single'|'oneAndHalf'|'double'|'custom'    figures only (R5)
 *
 * BACK-COMPAT CONTRACT: blocks WITHOUT an `anchor` key are legacy — the
 * exporter must keep emitting their stored attrs.placement verbatim
 * (byte-identical .tex for old papers). resolveFloat is only called when
 * `anchor` is present. normalizeTree must never inject these keys.
 *
 * BUILD TARGETS (paperExports.buildTarget, default 'submission'):
 *   'submission' — journal float specs per the journal's own author
 *                  documentation; never [H]. A lock is noted as a warning
 *                  (it only takes effect in the preprint target).
 *   'preprint'   — we publish the PDF ourselves (arXiv/local): pinning is
 *                  honored (lock → [H], requires \usepackage{float}) and
 *                  top/bottom anchors are forced with '!'.
 *
 * LaTeX facts encoded here:
 *   - figure* / table* exist only in twocolumn classes (IEEEtran is the
 *     only template that compiles two-column — figure_environment.
 *     compiled_columns === 2). In single-column classes span='page'
 *     degrades to a normal float at \textwidth.
 *   - Starred floats accept only [t]/[p] reliably; [b]/[h]/[H] are
 *     ignored or error. bottom/lock on a starred float falls back to 't'
 *     with a warning.
 *   - [H] needs \usepackage{float} (present in all 9 template preambles
 *     as of R1 — acs.json gained it in this release).
 */
(function () {
  'use strict';

  var ANCHORS = { 'flow': 1, 'top': 1, 'bottom': 1, 'float-page': 1, 'wrap': 1 };

  /* Default per-journal layout rules when a template ships no
   * render_hints.layout block. Fractions of the column width. */
  var DEFAULT_RULES = {
    figure_widths_mm: null,                 // journals define; null → use _frac
    figure_widths_frac: { single: 0.5, oneAndHalf: 0.7, double: 1.0 },
    figure_max_height_mm: null,
    allowed_placements: ['H', 'h', 't', 'b', 'p'],
    default_placement: null,                // null → template figure_environment.placement
    allow_here: true,
    notes: '',
  };

  function getRules(template) {
    var rh = template && template.render_hints;
    var layout = (rh && rh.layout) || {};
    return Object.assign({}, DEFAULT_RULES, layout);
  }

  /* Map a legacy LaTeX placement spec to layout intent. Used so the three
   * legacy placement dropdowns keep anchors consistent when they write. */
  function placementToAnchor(place) {
    switch (String(place || '').trim()) {
      case 'H':          return { anchor: 'flow', lock: true };
      case 'h':
      case '!h':         return { anchor: 'flow', lock: false };
      case 't':
      case '!t':         return { anchor: 'top', lock: false };
      case 'b':
      case '!b':         return { anchor: 'bottom', lock: false };
      case 'p':          return { anchor: 'float-page', lock: false };
      default:           return { anchor: 'flow', lock: false };
    }
  }

  /* Reverse mapping for UI display — what spec would this intent emit
   * for the given target? (Non-starred single-column case; the full
   * derivation incl. starred fallbacks lives in resolveFloat.) */
  function anchorToPlacement(anchor, lock, buildTarget) {
    var preprint = buildTarget === 'preprint';
    if (lock) return preprint ? 'H' : 'tbp';
    switch (anchor) {
      case 'top':        return preprint ? '!t' : 't';
      case 'bottom':     return preprint ? '!b' : 'b';
      case 'float-page': return 'p';
      case 'flow':
      default:           return 'tbp';
    }
  }

  /* Resolve the width spec for a float. Figures only — tables have no
   * width mechanism (they size to content; span picks table vs table*). */
  function resolveWidth(attrs, template) {
    if (attrs.span === 'page') return '\\textwidth';
    var fe = (template && template.figure_environment) || {};
    return attrs.width || fe.default_width || '\\linewidth';
  }

  /* The core mapping: layout intent → concrete LaTeX float parameters.
   *
   *   resolveFloat(attrs, template, kind) →
   *     { env, place, width, captionAbove, warnings: [] }
   *
   * kind: 'figure' | 'table'. Only call when attrs.anchor is present —
   * legacy blocks take the verbatim-placement path in the exporter. */
  function resolveFloat(attrs, template, kind) {
    attrs = attrs || {};
    template = template || {};
    var isTable = kind === 'table';
    var envCfg = (isTable ? template.table_environment : template.figure_environment) || {};
    var figCfg = template.figure_environment || {};
    var warnings = [];

    var anchor = ANCHORS[attrs.anchor] ? attrs.anchor : 'flow';
    var span = attrs.span === 'page' ? 'page' : 'column';
    var lock = attrs.lock === true;
    var target = template._buildTarget === 'preprint' ? 'preprint' : 'submission';
    var twoCol = figCfg.compiled_columns === 2;
    var starred = span === 'page' && twoCol;

    var baseEnv = envCfg.env || (isTable ? 'table' : 'figure');
    var env = starred ? baseEnv + '*' : baseEnv;

    /* V3.485 — corner/side wrap (wrapfig). Single-column classes only:
     * `wrapfigure` lives INSIDE the running text and floats to one margin
     * so paragraphs flow around it. There is no two-column analogue (the
     * text is already narrow), and tables are never wrapped — both cases
     * degrade to the normal float path below with a warning. The exporter
     * (figureToTex) is responsible for emitting the wrapfigure env just
     * before the anchored paragraph; here we only resolve its params. */
    if (anchor === 'wrap' && !isTable && !twoCol) {
      return {
        env: (envCfg.env_wrap || 'wrapfigure'),
        place: attrs.wrap_side === 'left' ? 'l' : 'r',
        width: resolveWidth(attrs, template),
        height: (typeof attrs.max_h === 'number' && attrs.max_h > 0) ? Math.round(attrs.max_h) + 'mm' : null,
        captionAbove: false,
        spacingTex: null,
        wrap: true,
        warnings: warnings,
      };
    }
    if (anchor === 'wrap') {
      anchor = 'flow';
      warnings.push((isTable ? 'Tables' : 'Figures') + ' cannot wrap text in ' +
        (twoCol ? 'a two-column layout' : 'this context') +
        ' — placed in the text flow instead.');
    }

    var place;
    if (starred) {
      /* Starred floats: [t]/[p] only. */
      if (anchor === 'float-page') {
        place = 'p';
      } else {
        place = 't';
        if (anchor === 'bottom') {
          warnings.push((isTable ? 'Table' : 'Figure') + ' spans both columns — LaTeX cannot place a spanning float at the bottom; using top.');
        }
      }
      if (lock) {
        warnings.push('Locked ' + (isTable ? 'table' : 'figure') + ' spans both columns — spanning floats cannot be pinned exactly; placed at the top of a page.');
      }
    } else if (target === 'preprint') {
      if (lock) {
        place = 'H';                     // exact pin — needs \usepackage{float}
      } else if (anchor === 'top') {
        place = '!t';
      } else if (anchor === 'bottom') {
        place = '!b';
      } else if (anchor === 'float-page') {
        place = 'p';
      } else {
        place = 'tbp';
      }
    } else {
      /* submission — journal float specs, never [H] */
      var rules = getRules(template);
      if (lock) {
        place = 'tbp';
        warnings.push('Lock on ' + (isTable ? 'a table' : 'a figure') + ' is honored only in the preprint build target — the submission build uses journal float specs (tbp).');
      } else if (anchor === 'top') {
        /* Honor a template's forced-top default (IEEE '!t'), else 't'.
         * Match ONLY a pure top spec — a multi-letter template/override
         * placement like 'htbp' merely CONTAINS 't' and must not defeat
         * an explicit top anchor (review finding, V3.395). */
        var tplPlace = String(envCfg.placement || '').trim();
        place = /^!?t$/.test(tplPlace) ? tplPlace : 't';
      } else if (anchor === 'bottom') {
        place = 'b';
      } else if (anchor === 'float-page') {
        place = 'p';
      } else {
        place = rules.default_placement || 'tbp';
      }

      /* Journal-rules advisory (V3.395 review finding — warn only, never
       * clamp; the R5 rules advisor builds on this). If the derived spec
       * has NO letter the journal's author guidance allows, say so
       * through the warnings channel already plumbed to bundle.warnings. */
      var allowed = rules.allowed_placements;
      if (Array.isArray(allowed) && allowed.length) {
        var permitted = place.replace(/!/g, '').split('').some(function (c) {
          if (allowed.indexOf(c) >= 0) return true;
          return (c === 'h' || c === 'H') && rules.allow_here;
        });
        if (!permitted) {
          warnings.push((isTable ? 'Table' : 'Figure') + ' anchored "' + anchor +
            '" emits [' + place + '], but ' + (template.name || template.id || 'this journal') +
            ' places floats only [' + allowed.join('') + '] — the journal may reposition it.');
        }
      }
    }

    if (span === 'page' && !twoCol && anchor !== 'float-page') {
      /* Single-column compiled class: 'page span' just means full text
       * width — no starred env exists to jump columns. Width handles it. */
    }

    /* V3.405 — the figure BOX model's height cap. attrs.max_h is the
     * IMAGE max-height in mm (never the box total — export must stay
     * deterministic with no DOM); it maps straight to
     * \includegraphics height= + keepaspectratio in figureToTex.
     * Advisory only when it exceeds the journal's figure area. */
    var maxH = (!isTable && typeof attrs.max_h === 'number' && attrs.max_h > 0)
      ? Math.round(attrs.max_h) : null;
    if (maxH) {
      var hRules = getRules(template);
      if (hRules.figure_max_height_mm && maxH > hRules.figure_max_height_mm) {
        warnings.push('Figure height cap ' + maxH + ' mm exceeds ' +
          (template.name || template.id || 'this journal') +
          "'s figure area (" + hRules.figure_max_height_mm +
          ' mm) — it may be scaled down.');
      }
    }

    /* V3.410 — per-float spacing / nudge. attrs.spacing is a SIGNED mm
     * value: extra (or reclaimed) space on the float's TEXT-FACING side
     * — the only per-float vertical lever LaTeX has is a \vspace inside
     * the env, so the anchor picks the side: top float → text below →
     * vspace AFTER the content; bottom → BEFORE; flow/[H] → after;
     * float-page → nothing (no adjacent text). Additive on top of the
     * document floatSpacing preset (globals can't be overridden
     * per-float). 0/absent → null — byte-identical. */
    var spacingTex = null;
    var spacingMm = (typeof attrs.spacing === 'number' && isFinite(attrs.spacing))
      ? Math.round(attrs.spacing) : 0;
    if (spacingMm !== 0 && anchor !== 'float-page') {
      var vs = '\\vspace{' + spacingMm + 'mm}';
      spacingTex = (anchor === 'bottom') ? { before: vs, after: null }
                                         : { before: null, after: vs };
      if (target === 'submission') {
        warnings.push('Per-' + (isTable ? 'table' : 'figure') + ' spacing nudge (' +
          spacingMm + ' mm) is a manual override — the journal may reset float spacing in production.');
      }
    }

    return {
      env: env,
      place: place,
      width: isTable ? null : resolveWidth(attrs, template),
      height: maxH ? maxH + 'mm' : null,
      captionAbove: isTable && envCfg.caption_position === 'above',
      spacingTex: spacingTex,
      warnings: warnings,
    };
  }

  /* ── Table merges + column widths (Tables II) ─────────────────
   * Stored as SCALAR attrs so they survive every move path:
   *   merges_json — {"r-c": {"rs": N, "cs": M}} anchored top-left
   *   widths_json — per-column [{"mode":"auto"|"frac"|"mm","v":N}, …]
   * Shared by the panel editor, the doc-side preview, the doc view,
   * and tableToTex (and the node harness via module.exports). */

  function parseTableMerges(json) {
    var out = {};
    if (!json) return out;
    var raw;
    try { raw = typeof json === 'string' ? JSON.parse(json) : json; } catch (e) { return out; }
    if (!raw || typeof raw !== 'object') return out;
    Object.keys(raw).forEach(function (key) {
      if (!/^\d+-\d+$/.test(key)) return;
      var m = raw[key] || {};
      var rs = Math.max(1, Math.floor(Number(m.rs) || 1));
      var cs = Math.max(1, Math.floor(Number(m.cs) || 1));
      if (rs === 1 && cs === 1) return;   // not a merge
      out[key] = { rs: rs, cs: cs };
    });
    return out;
  }

  /* Expand merges over an rows×cols grid. Returns:
   *   anchors — {'r-c': {rs, cs}} clipped to the grid
   *   skip    — {'r-c': true}  cells swallowed entirely (same-row colspan
   *             tails + non-anchor columns of continuation rows)
   *   cont    — {'r-c': cs}    rowspan continuation cells at the ANCHOR
   *             column: LaTeX needs an EMPTY placeholder there (an empty
   *             \multicolumn{cs} when the merge also spans columns) to
   *             keep the column count right.
   * Overlapping merges: first anchor (row-major) wins; anchors landing
   * on already-covered cells are dropped. */
  function tableCoverMap(merges, rows, cols) {
    var anchors = {}, skip = {}, cont = {};
    for (var r = 0; r < rows; r++) {
      for (var c = 0; c < cols; c++) {
        var key = r + '-' + c;
        var m = merges[key];
        if (!m || skip[key] || cont[key]) continue;
        var rs = Math.min(m.rs, rows - r);
        var cs = Math.min(m.cs, cols - c);
        if (rs === 1 && cs === 1) continue;
        anchors[key] = { rs: rs, cs: cs };
        for (var rr = r; rr < r + rs; rr++) {
          for (var cc = c; cc < c + cs; cc++) {
            if (rr === r && cc === c) continue;
            var k2 = rr + '-' + cc;
            if (rr > r && cc === c) cont[k2] = cs;
            else skip[k2] = true;
          }
        }
      }
    }
    return { anchors: anchors, skip: skip, cont: cont };
  }

  function parseTableWidths(json, cols) {
    var out = [];
    var raw = null;
    if (json) {
      try { raw = typeof json === 'string' ? JSON.parse(json) : json; } catch (e) { raw = null; }
    }
    for (var c = 0; c < cols; c++) {
      var w = (Array.isArray(raw) && raw[c]) || null;
      if (w && w.mode === 'frac' && Number(w.v) > 0 && Number(w.v) <= 1) {
        out.push({ mode: 'frac', v: Number(w.v) });
      } else if (w && w.mode === 'mm' && Number(w.v) > 0) {
        out.push({ mode: 'mm', v: Number(w.v) });
      } else {
        out.push({ mode: 'auto' });
      }
    }
    return out;
  }

  /* V3.486 — body-text line density (grant "lines per inch" compliance).
   * The lines-per-inch value fixes the LEADING (baseline pitch), which is
   * the metric reviewers check: leading_pt = 72 / lpi (72pt = 1 inch). The
   * body font tracks the leading at a single-spaced ratio (font ≈
   * leading / 1.2 → 6 lpi ⇒ 12pt leading ⇒ 10pt font, the NSF canonical),
   * clamped to [fontMin, fontMax] for readability/compliance. When the
   * font clamps, the LEADING is left untouched so the lines-per-inch stays
   * EXACT (only the font/leading ratio shifts) — a warning reports it.
   * Headings/titles are unaffected: the exporter changes only \normalsize
   * and the preview scopes the CSS vars to body paragraphs. Returns null
   * when no lpi is set (feature off). DOM-free — shared by preview + export
   * + the node harness. */
  var BODY_FONT_RATIO = 1.2;
  function _round(n, d) { var f = Math.pow(10, d || 0); return Math.round(n * f) / f; }
  function resolveBodyDensity(opts) {
    opts = opts || {};
    var lpi = Number(opts.lpi);
    if (!(lpi > 0) || !isFinite(lpi)) return null;
    var fontMin = Number(opts.fontMin) > 0 ? Number(opts.fontMin) : 9;
    var fontMax = Number(opts.fontMax) > 0 ? Number(opts.fontMax) : 12;
    if (fontMax < fontMin) { var t = fontMin; fontMin = fontMax; fontMax = t; }
    var leadingPt = 72 / lpi;
    var raw = leadingPt / BODY_FONT_RATIO;
    var fontPt = Math.max(fontMin, Math.min(fontMax, raw));
    var clamped = Math.abs(fontPt - raw) > 0.05;
    var warning = null;
    if (clamped) {
      warning = 'Body font clamped to ' + _round(fontPt, 1) + 'pt (the ' +
        _round(lpi, 2) + ' lines/inch target implies ' + _round(raw, 1) +
        'pt) — line spacing still holds at ' + _round(lpi, 2) +
        ' lines/inch, so the compliance metric is met.';
    }
    return {
      lpi: lpi,
      leadingPt: _round(leadingPt, 2),
      fontPt: _round(fontPt, 1),
      clamped: clamped,
      warning: warning,
    };
  }

  var api = {
    resolveFloat: resolveFloat,
    resolveWidth: resolveWidth,
    resolveBodyDensity: resolveBodyDensity,
    placementToAnchor: placementToAnchor,
    anchorToPlacement: anchorToPlacement,
    getRules: getRules,
    parseTableMerges: parseTableMerges,
    tableCoverMap: tableCoverMap,
    parseTableWidths: parseTableWidths,
  };
  if (typeof window !== 'undefined') window.PaperLayout = api;
  /* V3.405 — Node guard so the fit/rules harnesses can require() this
   * module directly (it is DOM-free by design). */
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
})();
