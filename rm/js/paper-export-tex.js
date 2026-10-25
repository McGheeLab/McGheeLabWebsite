/* paper-export-tex.js — browser-side LaTeX export for the paper builder.
 *
 * Phase F1 ships the MEBP-journal template end-to-end. The flow:
 *   1. Walk the paper's Yjs Y.Map → tree of plain JS objects.
 *   2. For each section: render its label as a LaTeX section command per
 *      the template's section_kind_to_command mapping; each block becomes
 *      a paragraph / equation / figure / table / list snippet.
 *   3. Walk all paragraph bodies for `[@key]` tokens, collect unique
 *      citation keys, and build a BibTeX file from the lab's
 *      data/items.json paper-library entries.
 *   4. POST the finished files to /api/paper/export-tex (server-side
 *      sandbox-bound writes). Bib goes via the existing /api/library/write-bib
 *      endpoint so there's one bib-writing path.
 *
 * The template registry is data/paper-templates/<id>.json — see that file
 * for the schema. Adding a new template is data-only (no JS changes).
 */

(function () {
  /* ── Public surface ── */
  window.PaperExportTex = {
    /* V3.231 — buildBundle is the pure (no I/O) helper used by both the
     * legacy /api/paper/export-tex POST path and the new paper-export
     * workspace page (Cloud Run compile + .zip download). */
    buildBundle: buildBundle,
    runExport: runExport,
    fetchTemplate: fetchTemplate,
    mergeTemplateWithOverrides: mergeTemplateWithOverrides,
    applyAddons: applyAddons,
    /* NOTE: ADDON_REGISTRY is (re)attached right after its var
     * initializes below — capturing it here reads the hoisted-but-
     * unassigned var and shipped `undefined` for every release since
     * V3.231 (the export page's add-on list silently rendered empty).
     * Fixed V3.345. */
    ADDON_REGISTRY: null,
    /* Exposed for the test doc + future-phase Phase E .md generator. */
    paperTreeFromYDoc: paperTreeFromYDoc,
    bibEscape: bibEscape,   // V3.906 — for scripts/tests/paper-tex-escape.test.mjs
    /* V3.415 — the Document view mirrors the exporter's section-command
     * resolution (special-first + object vocabulary) through these. */
    normalizeCommand: normalizeCommand,
    resolveSectionCommand: resolveSectionCommand,
    sectionToTex: sectionToTex,
    blockToTex: blockToTex,
    paragraphTextToTex: paragraphTextToTex,
    collectCitationKeys: collectCitationKeys,
    buildBibtex: buildBibtex,
  };

  /* ── V3.231 Add-on registry ──
   * Each add-on is a name → snippet that gets appended to the template
   * preamble when enabled on the paper-export page. The registry is the
   * single source of truth — the page reads `ADDON_REGISTRY` to render
   * the toggle list; `applyAddons` reads it to compose the final preamble.
   *
   * Hard conflicts go in `incompatible_with.templates` (matched by
   * template.id) or `incompatible_with.addons` (matched by id). Soft
   * conflicts compile-and-warn rather than block. */
  var ADDON_REGISTRY = [
    {
      id: 'lineno',
      label: 'Line numbers',
      preamble: '\\usepackage{lineno}\n\\linenumbers\n',
      requires_shell_escape: false,
      incompatible_with: { templates: [], addons: [] },
      notes: 'Adds reviewer-friendly line numbers. Some AMS math environments need \\linenomathNonumbers; if so, disable.',
    },
    {
      id: 'setspace-double',
      label: 'Double-spaced body',
      preamble: '\\usepackage{setspace}\n\\doublespacing\n',
      requires_shell_escape: false,
      incompatible_with: { templates: [], addons: [] },
      notes: 'Submission-friendly double spacing. Toggle off for final camera-ready.',
    },
    {
      id: 'microtype',
      label: 'Microtype (subtle kerning)',
      preamble: '\\usepackage{microtype}\n',
      requires_shell_escape: false,
      incompatible_with: { templates: [], addons: [] },
      notes: 'Better typography. Safe on virtually every class.',
    },
    {
      id: 'cleveref',
      label: 'Smart \\cref references',
      preamble: '\\usepackage{cleveref}\n',
      requires_shell_escape: false,
      incompatible_with: { templates: [], addons: [] },
      notes: 'Lets you write \\cref{fig:x} instead of "Fig.~\\ref{fig:x}".',
    },
    {
      id: 'hyperref-colors',
      label: 'Colored hyperlinks',
      preamble: '\\hypersetup{colorlinks=true,linkcolor=blue!50!black,citecolor=teal!50!black,urlcolor=blue!50!black}\n',
      requires_shell_escape: false,
      incompatible_with: { templates: [], addons: [] },
      notes: 'Replaces hidelinks. Useful for online review; turn off for print submission.',
    },
    {
      id: 'anonymize',
      label: 'Anonymize authors (double-blind)',
      preamble: '\\renewcommand{\\@author}{Anonymous}\n\\makeatletter\\let\\@oldauthor\\author\\renewcommand{\\author}[1]{}\\makeatother\n',
      requires_shell_escape: false,
      incompatible_with: { templates: [], addons: [] },
      notes: 'Strips author block for double-blind review submissions.',
    },
    {
      id: 'placeins',
      label: 'Float barriers at sections',
      preamble: '\\usepackage[section]{placeins}\n',
      requires_shell_escape: false,
      incompatible_with: { templates: [], addons: [] },
      notes: 'Keeps figures from drifting across section boundaries.',
    },
    {
      id: 'siunitx',
      label: 'siunitx (units & uncertainties)',
      preamble: '\\usepackage{siunitx}\n',
      requires_shell_escape: false,
      incompatible_with: { templates: ['mebp-journal'], addons: [] },
      notes: '\\SI{5}{\\micro\\meter}, \\num{}, unit-aware tables. Already in the MEBP preamble — enable for the leaner templates.',
    },
    {
      id: 'mhchem',
      label: 'mhchem (chemical formulas)',
      preamble: '\\usepackage[version=4]{mhchem}\n',
      requires_shell_escape: false,
      incompatible_with: { templates: [], addons: [] },
      notes: '\\ce{H2SO4} chemistry markup. Suggested for ACS / bio-chem submissions.',
    },
    {
      id: 'endfloat',
      label: 'Figures & tables at end',
      preamble: '\\usepackage[nolists]{endfloat}\n',
      requires_shell_escape: false,
      incompatible_with: { templates: ['ieee', 'ieeetran'], addons: [] },
      notes: 'Moves every float to the end of the manuscript — a classic submission requirement. Leave off for two-column classes.',
    },
    {
      id: 'twocolumn',
      label: 'Two-column body',
      preamble: '% twocolumn handled at \\documentclass via build-time class options\n',
      requires_shell_escape: false,
      incompatible_with: { templates: ['ieeetran', 'ieee'], addons: [] },
      notes: 'IEEEtran is already two-column — leave off there.',
    },
  ];

  /* V3.345 — attach the registry now that the var has a value (see the
   * note in the public-surface object above). */
  window.PaperExportTex.ADDON_REGISTRY = ADDON_REGISTRY;

  /* ── Tree extraction (Y.Map → plain JS) ── */

  function paperTreeFromYDoc(yDoc) {
    var paperMap = yDoc.getMap('paper');
    var meta = paperMap.get('meta');
    var titleY = meta && meta.get('title');
    var sections = paperMap.get('sections');
    var tree = {
      title: titleY ? titleY.toString() : '',
      sections: [],
      equation_library: [],   // V3.109
      value_library: [],      // V3.645
    };
    /* V3.109 — extract the inline equation library so paragraphTextToTex
     * can resolve [!eqi:<id>] tokens to the entry's latex source at
     * export time. */
    var lib = paperMap.get('equation_library');
    if (lib && typeof lib.forEach === 'function') {
      lib.forEach(function (e) {
        if (!e || typeof e.get !== 'function') return;
        var nameY = e.get('name');
        var latexY = e.get('latex');
        tree.equation_library.push({
          id: e.get('id') || '',
          name: yTextToString(nameY),
          latex: yTextToString(latexY),
        });
      });
    }
    /* V3.645 — value keys, so paragraphTextToTex can resolve
     * [!val:KEY] / [@item:KEY] to their printed text at export time. */
    var vlib = paperMap.get('value_library');
    if (vlib && typeof vlib.forEach === 'function') {
      vlib.forEach(function (v) {
        if (!v || typeof v.get !== 'function') return;
        var snapY = v.get('snapshot');
        var snap = { name: '', vendor: '', catalogue_number: '' };
        if (snapY && typeof snapY.get === 'function') {
          snap.name = snapY.get('name') || '';
          snap.vendor = snapY.get('vendor') || '';
          snap.catalogue_number = snapY.get('catalogue_number') || '';
        }
        tree.value_library.push({
          id: v.get('id') || '', key: v.get('key') || '',
          kind: v.get('kind') || 'text', note: v.get('note') || '',
          value: v.get('value') || '',
          num: (typeof v.get('num') === 'number') ? v.get('num') : null,
          unit: v.get('unit') || '',
          sigfigs: (typeof v.get('sigfigs') === 'number') ? v.get('sigfigs') : null,
          inv_id: v.get('inv_id') || '', inv_kind: v.get('inv_kind') || 'item',
          snapshot: snap, format: v.get('format') || '',
          refreshed_at: v.get('refreshed_at') || null,
        });
      });
    }
    if (!sections) return tree;
    sections.forEach(function (secMap) {
      var labelY = secMap.get('label');
      var sec = {
        id: secMap.get('id'),
        kind: secMap.get('kind'),
        label: (labelY && labelY.toString) ? labelY.toString() : String(labelY || ''),
        order: secMap.get('order') || 0,
        status: secMap.get('status') || 'draft',
        /* V3.413 — section styles: `special` keys into the template's
         * special_sections catalog; `special_render` ('box'|'heading')
         * is the cross-journal fallback captured at creation. This
         * reader feeds BOTH the exporter and the Document view. */
        special: secMap.get('special') || null,
        special_render: secMap.get('special_render') || null,
        appendix: !!secMap.get('appendix'),
        ref_label: secMap.get('ref_label') || null,
        children: [],
      };
      var children = secMap.get('children');
      if (children) {
        children.forEach(function (b) {
          var attrs = extractAttrs(b.get('attrs'));
          var skY = b.get('skeleton');
          var bdY = b.get('body');
          /* V3.104 — skeleton is now a Y.Array<Y.Map> outline. Extract as
           * a structured array of {depth, text, claim_id}. Falls back to
           * legacy flat-text skeleton when items are absent. */
          var skItems = b.get('skeleton_items');
          var skeletonItems = [];
          if (skItems && typeof skItems.forEach === 'function' && typeof skItems.toArray === 'function') {
            skItems.forEach(function (it) {
              var t = it && it.get && it.get('text');
              skeletonItems.push({
                id: (it.get && it.get('id')) || '',
                depth: (it.get && it.get('depth')) || 0,
                text: yTextToString(t),
                claim_id: (it.get && it.get('claim_id')) || null,
              });
            });
          }
          sec.children.push({
            id: b.get('id'),
            kind: b.get('kind'),
            status: b.get('status') || 'draft',
            skeleton: yTextToString(skY),
            skeleton_items: skeletonItems,
            body:     yTextToString(bdY),
            attrs: attrs,
          });
        });
      }
      tree.sections.push(sec);
    });
    return tree;
  }

  /* ── Y.Type → plain JS helpers ── */

  /* Identify Y.Text by duck-typing: it has toString() but no forEach (Y.Map
   * has both, Y.Array has forEach without toString). Avoids importing Y
   * here. */
  function yTextToString(y) {
    if (y == null) return '';
    if (typeof y === 'string') return y;
    if (y.toString && typeof y.forEach !== 'function' && typeof y.length !== 'number') {
      return y.toString();
    }
    return String(y || '');
  }

  function extractAttrs(attrsY) {
    if (!attrsY) return {};
    var out = {};
    // Y.Map has forEach((value, key) => ...).
    if (attrsY.forEach && !Array.isArray(attrsY)) {
      attrsY.forEach(function (v, k) {
        if (v == null) { out[k] = v; return; }
        // Y.Map nested → recurse (used for table.cells).
        if (typeof v.forEach === 'function' && typeof v.toString !== 'function') {
          out[k] = extractAttrs(v);
        } else if (typeof v.forEach === 'function' && typeof v.toString === 'function' &&
                   typeof v.length !== 'number') {
          // Y.Map (has toString returning [object Object]) — recurse, taking
          // entries via forEach.
          out[k] = extractAttrs(v);
        } else if (v.toString && (v.constructor && v.constructor.name &&
                                  v.constructor.name.indexOf('Text') >= 0)) {
          // Y.Text-ish.
          out[k] = v.toString();
        } else {
          out[k] = v;
        }
      });
    } else {
      out = attrsY;
    }
    return out;
  }

  /* ── Per-block LaTeX rendering ── */

  /* V3.413 — the section-command vocabulary generalized to OBJECTS.
   * Every legacy string normalizes to an object whose emission is
   * byte-identical to the old if/else chain (harness-pinned); templates
   * may now also declare object commands directly — in
   * section_kind_to_command or in a special_sections catalog entry:
   *   {type:'env', name}          \begin{name}…\end{name}
   *   {type:'macro', name}        \name{…}
   *   {type:'placeholder', token} stash → main_template token
   *   {type:'box'}                generic rmcallout (injected on use)
   *   {type:'section'|'section_star'|'skip'|'keywords'} */
  function normalizeCommand(cmd) {
    if (cmd && typeof cmd === 'object') return cmd;
    switch (cmd) {
      case 'skip':                 return { type: 'skip' };
      case 'abstract_placeholder': return { type: 'placeholder', token: '{{ABSTRACT}}' };
      case 'keywords_placeholder': return { type: 'keywords' };
      case 'abstract_env':         return { type: 'env', name: 'abstract' };
      case 'section_star':         return { type: 'section_star' };
      default:                     return { type: 'section' };
    }
  }

  /* V3.413 — special-first resolution. A section carrying `special`
   * uses the CURRENT template's catalog entry (authentic journal
   * command); a catalog miss (paper switched journals) degrades via the
   * special_render hint captured at creation ('box' → generic callout,
   * 'heading' → \section*) — a warning only when there's no hint at
   * all. Sections without `special` keep the kind-mapped path. */
  /* Submission-document kinds (S-α) — sections that live in the paper's
   * section map but are NOT part of the manuscript: manuscript templates
   * (which don't map these kinds) skip them in BOTH export and the
   * Document view (shared resolver); the subdoc templates
   * (rm-cover-letter / rm-rebuttal) DO map them, so the same sections
   * render there. Zero manuscript-template edits. */
  var SUBMISSION_DOC_KINDS = { cover_letter: 1, suggested_reviewers: 1, rebuttal: 1 };

  /* V3.465 — grant "attached documents" (biosketch, facilities, budget,
   * data-management plan, …) behave EXACTLY like the submission-doc kinds
   * above: excluded from the manuscript unless the active template maps
   * the kind (an attachment's own subdoc template does). Read lazily from
   * PaperSchemas so there is ONE source of truth (paper-schemas.js
   * GRANT_ATTACHED_KINDS) rather than a second hardcoded copy here. In
   * the harness (which loads this module without PaperSchemas) the getter
   * returns {} and only the static SUBMISSION_DOC_KINDS apply — the
   * harness loads paper-schemas.js explicitly to exercise the grant path. */
  function _grantAttachedKindMap() {
    var out = {};
    var list = (window.PaperSchemas && window.PaperSchemas.GRANT_ATTACHED_KINDS) || [];
    for (var i = 0; i < list.length; i++) out[list[i]] = 1;
    return out;
  }
  /* Kinds excluded from the MAIN manuscript (compile + doc view + .bib):
   * submission docs + grant attachments. */
  function _manuscriptExcludedKinds() {
    var m = _grantAttachedKindMap();
    for (var k in SUBMISSION_DOC_KINDS) m[k] = 1;
    return m;
  }

  function resolveSectionCommand(sec, template) {
    if (_manuscriptExcludedKinds()[sec.kind] &&
        !((template && template.section_kind_to_command) || {})[sec.kind]) {
      return { type: 'skip' };
    }
    if (sec.special) {
      var list = template.special_sections || [];
      for (var i = 0; i < list.length; i++) {
        if (list[i] && list[i].key === sec.special && list[i].command) {
          return normalizeCommand(list[i].command);
        }
      }
      if (sec.special_render === 'box') return { type: 'box' };
      if (sec.special_render === 'heading') return { type: 'section_star' };
      if (_layoutWarnings) {
        _layoutWarnings.push('Section "' + (sec.label || sec.special) + '" uses the "' +
          sec.special + '" style, which ' + (template.name || template.id || 'this journal') +
          ' has no equivalent for — exported as an unnumbered section.');
      }
      return { type: 'section_star' };
    }
    var c = normalizeCommand((template.section_kind_to_command || {})[sec.kind] || 'section');
    /* Force-numbered mode promotes an unnumbered body section to a
     * numbered one (secnumdepth prints the number). 'off' keeps the
     * command and relies on secnumdepth{-1} to suppress the number. */
    if (template._sectionNumbering === 'on' && c.type === 'section_star') return { type: 'section' };
    return c;
  }

  /* A subheading block → \subsection / \subsubsection. Starred to match
   * the template's body-section style in 'auto' mode (an unnumbered
   * journal like Nature stars its sections, so its subheadings star too);
   * 'on'/'off' use the plain command and let secnumdepth do the work. */
  function subheadingToTex(block, template) {
    var lvl = (block.attrs && block.attrs.level === 3) ? 'subsubsection' : 'subsection';
    var text = paragraphTextToTex(block.body || '', template);
    var star = false;
    var mode = template._sectionNumbering;
    if (mode !== 'on' && mode !== 'off') {
      var kc = template.section_kind_to_command || {};
      var bodyCmd = normalizeCommand(kc.custom || kc.introduction || 'section');
      star = bodyCmd.type === 'section_star';
    }
    var lbl = (block.attrs && block.attrs.ref_label) ? '\\label{' + block.attrs.ref_label + '}\n' : '';
    return '\\' + lvl + (star ? '*' : '') + '{' + text + '}\n' + lbl;
  }

  function sectionToTex(sec, template) {
    var cmd = resolveSectionCommand(sec, template);
    if (cmd.type === 'skip') return '';

    var label = sec.label || (template.default_section_label || {})[sec.kind] || '';
    var inner = joinBlocksTex(sec.children || [], template);
    /* V3.907 — a section the journal look sets in its own type (Nature's
     * small-print Methods with run-in subheads). */
    var secStyle = (template._look && window.PaperLook) ? window.PaperLook.sectionStyle(template._look, sec) : null;
    /* a class look (PNAS) only describes the class's own type — the .tex
     * is left to the class */
    if (secStyle && inner && template._look.engine !== 'class') {
      inner = window.PaperLook.texSectionOpen(template._look, secStyle) + inner + '\n' + window.PaperLook.texSectionClose();
    }

    switch (cmd.type) {
      /* V3.341 — placeholder commands stash the section's content for a
       * main_template token instead of emitting a section file. Used by
       * classes whose frontmatter owns the position (elsarticle,
       * IEEEtran abstract/keywords; PNAS significance et al.).
       * V3.415 — optional cmd.wrap ('\\acknow{%s}\n\\showacknow'):
       * non-empty content substitutes into %s; EMPTY content stashes ''
       * so the wrapper macro never prints a bare end-matter heading. */
      case 'placeholder':
        if (_placeholderStash && cmd.token) {
          _placeholderStash.tokens[cmd.token] =
            cmd.wrap ? (inner ? cmd.wrap.split('%s').join(inner) : '') : inner;
        }
        return '';
      case 'keywords':
        if (_placeholderStash) {
          var kwTok = cmd.token || '{{KEYWORDS}}';
          var kw = (sec.children || [])
            .filter(function (b) { return b.kind === 'paragraph'; })
            .map(function (b) { return paragraphTextToTex(b.body || '', template); })
            .filter(Boolean).join(cmd.sep || ', ');
          _placeholderStash.tokens[kwTok] =
            cmd.wrap ? (kw ? cmd.wrap.split('%s').join(kw) : '') : kw;
        }
        return '';
      case 'bare':
        /* V3.907 — body with no heading (Nature-family introductions). */
        return inner + '\n';
      case 'env':
        // SLAS-style: \begin{abstract}<text>\end{abstract} (no \section header).
        return '\\begin{' + cmd.name + '}\n' + inner + '\n\\end{' + cmd.name + '}\n';
      case 'macro':
        return '\\' + cmd.name + '{' + inner + '}\n';
      case 'box':
        /* Generic boxed callout (Significance-statement look on ANY
         * journal) — the rmcallout definition joins the preamble on
         * demand only. */
        _usedCallout = true;
        return '\\begin{rmcallout}{' + escapeTex(label) + '}\n' + inner + '\n\\end{rmcallout}\n';
      case 'section_star':
        return '\\section*{' + escapeTex(label) + '}\n' + secLabelTex(sec) + '\n' + inner + '\n';
      default:
        return '\\section{' + escapeTex(label) + '}\n' + secLabelTex(sec) + '\n' + inner + '\n';
    }
  }

  /* \label{<ref_label>} line for a section/subheading cross-reference
   * anchor, or '' when none — keeps untagged headings byte-identical. */
  function secLabelTex(sec) {
    return (sec && sec.ref_label) ? '\\label{' + sec.ref_label + '}\n' : '';
  }

  /* V3.906 — blocks → section body. A blank line (\par) separates
   * ordinary blocks; a display equation is attached to the text before it
   * and a continuing paragraph to the equation before it (no blank line),
   * exactly as an author writes LaTeX — PaperLayout.blockJoin is the one
   * rule the Document view also follows. */
  function joinBlocksTex(blocks, template) {
    var out = '';
    var prev = null;
    var PL = window.PaperLayout;
    blocks.forEach(function (b) {
      var tex = blockToTex(b, template);
      if (!tex) return;
      if (out) {
        var j = (PL && PL.blockJoin) ? PL.blockJoin(prev, b) : 'par';
        out += (j === 'par') ? '\n\n' : '\n';
      }
      out += tex;
      prev = b;
    });
    return out;
  }

  function blockToTex(block, template) {
    switch (block.kind) {
      case 'paragraph': return paragraphToTex(block, template);
      case 'subheading': return subheadingToTex(block, template);
      case 'equation':  return equationToTex(block, template);
      case 'figure':    return figureToTex(block, template);
      case 'table':     return tableToTex(block, template);
      case 'list':      return listToTex(block, template);
      default:          return '% [unsupported block kind: ' + escapeTex(block.kind) + ']';
    }
  }

  function paragraphToTex(block, template) {
    /* V3.910 — the Document view's Tighten / Loosen: TeX sets this
     * paragraph one line shorter / longer when it can (\looseness resets
     * itself after the paragraph); the preview runs the same request */
    var lz = block.attrs && block.attrs.looseness;
    var loose = (lz === -1 || lz === 1) ? '\\looseness=' + lz + '\\relax\n' : '';
    return prefixSkeletonComment(block) + loose + paragraphBodyToTex(block.body || '', template);
  }

  /* V3.649 — a paragraph body may contain bullet / numbered lists (see
   * PaperSchemas.parseBodyRuns). Prose runs go through the inline
   * contract unchanged; list runs become itemize / enumerate. Without
   * this the PDF prints the literal "- item" lines the editor and the
   * Document view both render as a list — the exact class of screen/PDF
   * disagreement the shared parser exists to prevent. */
  function paragraphBodyToTex(body, template) {
    var PS = window.PaperSchemas;
    if (!PS || !PS.bodyHasList || !PS.bodyHasList(body)) {
      return paragraphTextToTex(body || '', template);
    }
    var out = '';
    PS.parseBodyRuns(body).forEach(function (run) {
      if (run.type === 'prose') {
        var tex = paragraphTextToTex(run.text, template);
        if (tex) out += tex + '\n';
        return;
      }
      out += listItemsToTex(run.items, run.listType, template);
    });
    return out;
  }

  /* Shared by the list BLOCK and by lists inside a paragraph body, so the
   * two can never nest or indent differently. */
  function listItemsToTex(items, listType, template) {
    if (!items || !items.length) return '';
    var env = listType === 'number' ? 'enumerate' : 'itemize';
    function ind(n) { return new Array(n + 1).join('  '); }
    var out = '\\begin{' + env + '}\n', depth = 0;
    items.forEach(function (it) {
      while (depth < it.depth) { depth++; out += ind(depth) + '\\begin{' + env + '}\n'; }
      while (depth > it.depth) { out += ind(depth) + '\\end{' + env + '}\n'; depth--; }
      out += ind(depth + 1) + '\\item ' + paragraphTextToTex(it.text, template) + '\n';
    });
    while (depth > 0) { out += ind(depth) + '\\end{' + env + '}\n'; depth--; }
    return out + '\\end{' + env + '}\n';
  }

  /* V3.104 — emit the paragraph's skeleton bullets as a LaTeX comment
   * block above the body content. Skeleton is authoring scaffold, not
   * publication content; comments preserve it for the human writer
   * without touching the rendered output. Returns '' if no bullets or
   * only an empty bullet. Falls back to the legacy flat skeleton text
   * for blocks that haven't been migrated yet. */
  function prefixSkeletonComment(block) {
    var items = (block.skeleton_items || []).filter(function (it) {
      return (it.text || '').trim().length > 0;
    });
    if (items.length === 0) {
      var legacy = (block.skeleton || '').trim();
      if (!legacy) return '';
      return '% Skeleton:\n' + legacy.split('\n').map(function (l) {
        return '%   ' + l;
      }).join('\n') + '\n';
    }
    var lines = ['% Skeleton:'];
    items.forEach(function (it) {
      var indent = '  '.repeat(Math.max(0, Math.min(3, it.depth || 0)));
      lines.push('%   ' + indent + '- ' + (it.text || ''));
    });
    return lines.join('\n') + '\n';
  }

  /* Text-level transforms inside a paragraph: Pandoc cite + markdown
   * formatting tokens. The vocabulary tracks renderParagraphHtml in
   * paper-editor.js (V3.107) — same source produces the same on-screen
   * formatting and the same LaTeX output.
   *
   * Order matters: code spans are protected first (their content is
   * passed through verbatim, otherwise `*foo*` inside a code span would
   * be wrongly italicised). Bold runs before italic so `**foo**` matches
   * as bold rather than as two adjacent italics. Citations are last
   * because their contents are always pure key tokens — no markdown to
   * worry about. */
  /* V3.109 — equation library lookup for [!eqi:<id>] resolution.
   * Set by runExport at the start of an export run; cleared in finally
   * so a stale library can't leak into the next run. Module-level
   * state is acceptable because export runs are serial. */
  var _exportEqLibrary = null;

  /* V3.645 — per-run value-key table, same lifecycle as
   * _exportEqLibrary. Resolved through PaperSchemas.formatValueEntry so
   * the .tex and the on-screen chip can never print different text. */
  var _exportValueLibrary = null;

  function _valueEntryByKey(key) {
    /* Defensive fallback to the live editor table. paragraphTextToTex
     * is only ever called inside a buildBundle run today (where
     * _exportValueLibrary is set), but it is a PUBLIC export — if a
     * future caller invokes it outside a run, silently emitting
     * "% [missing value key]" would drop real numbers out of the PDF
     * with no visible error. */
    var lib = _exportValueLibrary;
    if (!lib) {
      try {
        lib = (window.PaperEditor && window.PaperEditor.getValueEntries)
          ? window.PaperEditor.getValueEntries() : [];
      } catch (e) { lib = []; }
    }
    for (var i = 0; i < lib.length; i++) {
      if (lib[i] && lib[i].key === key) return lib[i];
    }
    return null;
  }

  /* V3.341 — per-run collector for abstract_placeholder /
   * keywords_placeholder sections (see sectionToTex). Set/cleared by
   * buildBundle around section rendering, same lifecycle as
   * _exportEqLibrary. */
  var _placeholderStash = null;

  /* V3.395 — per-run collector for layout-intent warnings raised by
   * PaperLayout.resolveFloat inside figureToTex/tableToTex (e.g. "lock
   * is honored only in the preprint target"). Same lifecycle as
   * _exportEqLibrary; merged into the bundle's warnings list. */
  var _layoutWarnings = null;

  /* V3.412 — per-run flag: a spanning display equation was emitted via
   * cuted's strip env, so buildBundle must add \usepackage{cuted} to
   * the preamble (injected on demand only — untouched papers stay
   * byte-identical). Same lifecycle as the collectors above. */
  var _usedCuted = false;

  /* V3.413 — per-run flag: a boxed callout section was emitted, so the
   * rmcallout environment definition (mdframed-based, stock TeX Live)
   * joins the preamble on demand only. */
  var _usedCallout = false;

  /* Tables II — per-run flags: a merged cell spanning rows needs
   * \usepackage{multirow}; a width-set column with c/r alignment needs
   * the array package's >{...} column prefixes; multi-page tables need
   * longtable; table notes need threeparttable. Same lifecycle. */
  var _usedMultirow = false;
  var _usedColortbl = false;   // V3.651 — cell/row shading, zebra striping
  var _usedArray = false;
  var _usedLongtable = false;
  var _usedThreeparttable = false;

  /* V3.485 — per-run flag: a corner/side wrap figure was emitted
   * (\begin{wrapfigure}), so \usepackage{wrapfig} (stock TeX Live) joins
   * the preamble on demand only. Same lifecycle as the collectors above. */
  var _usedWrapfig = false;

  /* V3.341 — author block generator for the {{AUTHOR_BLOCK}} placeholder.
   * Until the authors & affiliations panel ships (FuturePlan 07 Release 6)
   * only the lead author is available, so each format emits a one-author
   * block with placeholder affiliation text the writer edits at
   * submission. Formats: superscript (plain article), elsarticle, ieee,
   * achemso. */
  /* V3.346 — structured authors. `authorsCfg` comes from
   * paperExports/{paperId}: { authors: [{name, affiliationIdx: [0,…],
   * corresponding, email}], affiliations: ["Dept, Univ, City, …"] }.
   * When absent (no panel data yet), each format emits the legacy
   * single-lead-author block with placeholder affiliation text. */
  function renderAuthorBlock(template, leadAuthor, authorsCfg) {
    var format = (template.author_block && template.author_block.format) || 'superscript';
    var authors = (authorsCfg && Array.isArray(authorsCfg.authors)) ? authorsCfg.authors.filter(function (a) { return a && a.name; }) : [];
    var affils = (authorsCfg && Array.isArray(authorsCfg.affiliations)) ? authorsCfg.affiliations : [];
    if (authors.length) {
      return renderStructuredAuthors(format, authors, affils);
    }
    var name = escapeTex(leadAuthor || 'Lead Author');
    switch (format) {
      case 'elsarticle':
        return '\\author[1]{' + name + '\\corref{cor1}}\n' +
               '\\ead{email@institution.edu}\n' +
               '\\cortext[cor1]{Corresponding author}\n' +
               '\\affiliation[1]{organization={Department, Institution}, city={City}, country={Country}}';
      case 'ieee':
        return '\\author{' + name +
               '\\thanks{The author is with the Department, Institution, City, Country (e-mail: email@institution.edu).}}';
      case 'achemso':
        return '\\author{' + name + '}\n' +
               '\\affiliation{Department, Institution, City, Country}\n' +
               '\\email{email@institution.edu}';
      case 'authblk':
        /* V3.415 — authblk classes (pnas-new RequirePackages it). */
        return '\\author[1]{' + name + '}\n' +
               '\\affil[1]{Department, Institution, City, Country}';
      case 'superscript':
      default:
        /* V3.906 — no structured authors: just the lead author's name.
         * (The old fallback printed a made-up "Department, Institution,
         * City" affiliation and a fake corresponding address into the
         * PDF.) */
        return name;
    }
  }

  /* V3.346 — multi-author generators per author_block.format. Affiliation
   * indices are 0-based in storage, rendered 1-based. */
  function renderStructuredAuthors(format, authors, affils) {
    function affNums(a) {
      var idxs = Array.isArray(a.affiliationIdx) ? a.affiliationIdx.filter(function (i) { return affils[i] != null; }) : [];
      return idxs.map(function (i) { return i + 1; });
    }
    /* Author name + optional ORCID icon link (orcidlink package — pulled
     * into the preamble by buildBundle when any author carries an iD). */
    function nameTex(a) {
      var n = escapeTex(a.name);
      return (a.orcid ? n + '\\,\\orcidlink{' + escapeTex(a.orcid) + '}' : n);
    }
    var corresponding = authors.filter(function (a) { return a.corresponding; });
    var lines = [];
    if (format === 'authblk') {
      /* V3.415 — authblk (\author[nums]{Name} + \affil[n]{...}); the
       * pnas-new class styles these itself. */
      authors.forEach(function (a) {
        var nums = affNums(a);
        lines.push('\\author[' + (nums.length ? nums.join(',') : '1') + ']{' + nameTex(a) + '}');
      });
      affils.forEach(function (t, i) {
        lines.push('\\affil[' + (i + 1) + ']{' + escapeTex(String(t)) + '}');
      });
      if (!affils.length) lines.push('\\affil[1]{Department, Institution, City, Country}');
      return lines.join('\n');
    }
    if (format === 'elsarticle') {
      authors.forEach(function (a, ai) {
        var nums = affNums(a);
        var opts = nums.length ? nums.join(',') : '1';
        var cor = a.corresponding ? '\\corref{cor1}' : '';
        lines.push('\\author[' + opts + ']{' + nameTex(a) + cor + '}');
        if (a.corresponding && a.email) lines.push('\\ead{' + escapeTex(a.email) + '}');
      });
      if (corresponding.length) lines.push('\\cortext[cor1]{Corresponding author}');
      if (affils.length) {
        affils.forEach(function (aff, i) {
          lines.push('\\affiliation[' + (i + 1) + ']{organization={' + escapeTex(aff) + '}}');
        });
      } else {
        lines.push('\\affiliation[1]{organization={Department, Institution}}');
      }
      return lines.join('\n');
    }
    if (format === 'ieee') {
      var names = authors.map(function (a) { return nameTex(a); });
      var nameRun = names.length > 1
        ? names.slice(0, -1).join(', ') + ', and ' + names[names.length - 1]
        : names[0];
      var thanks = affils.length ? escapeTex(affils.join('; ')) : 'Department, Institution';
      var mail = corresponding.length && corresponding[0].email ? ' (e-mail: ' + escapeTex(corresponding[0].email) + ')' : '';
      return '\\author{' + nameRun + '\\thanks{The authors are with ' + thanks + mail + '.}}';
    }
    if (format === 'revtex') {
      /* V3.907 — REVTeX 4.2: \author then its \affiliation(s); with the
       * superscriptaddress option the class numbers them itself. */
      authors.forEach(function (a) {
        lines.push('\\author{' + nameTex(a) + '}');
        var nums = affNums(a);
        (nums.length ? nums : (affils.length ? [1] : [])).forEach(function (k) {
          lines.push('\\affiliation{' + escapeTex(affils[k - 1]) + '}');
        });
        if (a.corresponding && a.email) lines.push('\\email{' + escapeTex(a.email) + '}');
      });
      return lines.join('\n');
    }
    if (format === 'achemso') {
      authors.forEach(function (a) {
        lines.push('\\author{' + nameTex(a) + '}');
        var nums = affNums(a);
        var aff = nums.length ? affils[nums[0] - 1] : (affils[0] || 'Department, Institution');
        lines.push('\\affiliation{' + escapeTex(aff) + '}');
        if (a.corresponding && a.email) lines.push('\\email{' + escapeTex(a.email) + '}');
      });
      return lines.join('\n');
    }
    /* superscript (article-class default) */
    var runs = authors.map(function (a) {
      var marks = affNums(a).map(String);
      if (a.corresponding) marks.push('*');
      return nameTex(a) + (marks.length ? '\\textsuperscript{' + marks.join(',') + '}' : '');
    });
    lines.push(runs.join(', '));
    lines.push('\\\\[6pt]');
    if (affils.length) {
      affils.forEach(function (aff, i) {
        lines.push('\\textsuperscript{' + (i + 1) + '}' + escapeTex(aff) + ' \\\\');
      });
    }
    if (corresponding.length) {
      var em = corresponding[0].email ? ': ' + escapeTex(corresponding[0].email) : '';
      lines.push('\\textsuperscript{*}Corresponding author' + em);
    }
    return lines.join('\n');
  }

  /* V3.341 — template-aware token mapping (schema v2). `template` is the
   * effective template from buildBundle; when absent (legacy callers,
   * tests) the pre-v2 behavior applies: bare \ref / \eqref and \cite.
   *   template.refs.{figure,table}.prefix  — e.g. "Fig.~" → Fig.~\ref{…}
   *   template.refs.equation.{prefix,command}
   *   template.citation.command            — \cite | \citep | …
   *   template._use_cref                   — stamped by buildBundle when
   *                                          the cleveref add-on is on;
   *                                          refs emit bare \cref{} and
   *                                          prefixes are suppressed. */
  function refSpecFor(template, kind) {
    var refs = (template && template.refs) || {};
    return refs[kind] || {};
  }

  function citeCommandFor(template) {
    if (template && template.citation && template.citation.command) {
      return template.citation.command;
    }
    if (template && template.cite_command) return template.cite_command;
    return '\\cite';
  }

  function paragraphTextToTex(text, template) {
    if (!text) return '';
    var out = text;
    var useCref = !!(template && template._use_cref);


    /* V3.341 — every token below is resolved to LaTeX and stashed behind
     * an inert placeholder, so the markdown passes (bold/italic/sub/sup)
     * only ever run on the user's prose. Without this, injected LaTeX
     * collides with markdown: a ref prefix like "Fig.~" and a later
     * "Table~" would be swallowed by the subscript pass `~x~`, and an
     * inline equation containing `^`/`*` would be mangled too. The
     * placeholder uses private-use code points that cannot appear in
     * user text nor match any markdown / token regex. */
    var frags = [];
    function protect(latex) {
      var idx = frags.length;
      frags.push(latex);
      return '\uE000' + idx + '\uE001';
    }

    /* V3.345 — [^text] footnotes → \footnote{…}. FIRST of the token
     * passes: the note text runs through paragraphTextToTex recursively
     * (its own placeholder scope) so citations/refs/markdown inside the
     * note export correctly — `[^see [@smith2024]]` works. Running
     * before the other token passes keeps their placeholders out of the
     * note text (nested placeholders would survive reinsert as garbage).
     * The inner text can never contain a complete nested footnote token
     * because `]` is excluded, so recursion terminates. */
    out = out.replace(/\[\^((?:[^\[\]\n]|\[[^\]\n]*\])+)\]/g, function (_m, txt) {
      return protect('\\footnote{' + paragraphTextToTex(txt, template) + '}');
    });

    /* V3.906 — inline math is LaTeX already: protect $…$ and \(…\)
     * VERBATIM before the markdown + escaping passes, scanning exactly
     * the way the editor's renderParagraphHtml does (an unescaped $ to
     * the next unescaped $). Without this a paragraph with two inline
     * equations that use ^ had the superscript pass pair the carets
     * ACROSS the spans: $A_0^i$ … $P_0^i$ became
     * \textsuperscript{i$ … $P_0}, which does not compile. A \$ in
     * prose is a literal dollar sign. */
    out = _protectInlineMath(out, protect);

    /* V3.915 — LaTeX the author wrote in prose (\si{\micro\metre}, \%,
     * \cref{fig:x}, ties) goes to LaTeX as written again, as before
     * V3.906; references and citations follow the template like the
     * builder's own tokens; an unknown command is escaped as text so it
     * cannot break the compile. Each `~` is resolved here too: a tie
     * (no-break space) or the builder's ~subscript~ (paper-prose-tex.js,
     * the rule the Document view uses). */
    var proseTex = window.PaperProseTex || null;
    if (proseTex) out = _protectProseTex(out, template, protect, useCref, proseTex);

    /* V3.109 — resolve [!eqi:<id>] inline equation references against
     * the paper's equation library, emitting `\(<latex>\)`. Unknown
     * ids fall back to a clearly-broken comment so the .tex still
     * compiles instead of failing silently. */
    out = out.replace(/\[!eqi:([\w:.\-]+)\]/g, function (_m, id) {
      var lib = _exportEqLibrary || [];
      var entry = null;
      /* V3.144 — match by id first (legacy tokens), then by slugified
       * name (new tokens emitted by paper-equations.js). */
      for (var i = 0; i < lib.length; i++) {
        if (lib[i] && lib[i].id === id) { entry = lib[i]; break; }
      }
      if (!entry) {
        for (var j = 0; j < lib.length; j++) {
          if (!lib[j] || !lib[j].name) continue;
          var slug = String(lib[j].name).toLowerCase()
            .replace(/[^a-z0-9_-]+/g, '-')
            .replace(/^-+|-+$/g, '')
            .slice(0, 60);
          if (slug && slug === id) { entry = lib[j]; break; }
        }
      }
      if (!entry || !entry.latex) {
        return protect('% [missing inline equation: ' + id + ']');
      }
      return protect('\\(' + entry.latex + '\\)');
    });

    /* V3.109 — [!eqr:<label>] references emit \eqref{<label>}; the
     * numbered display block this label belongs to provides the actual
     * \label{} command in equationToTex. V3.341 — the command and an
     * optional prefix come from template.refs.equation. */
    out = out.replace(/\[!eqr:([\w:.\-]+)\]/g, function (_m, label) {
      if (useCref) return protect('\\cref{' + label + '}');
      var spec = refSpecFor(template, 'equation');
      var cmd = spec.command || '\\eqref';
      return protect((spec.prefix || '') + cmd + '{' + label + '}');
    });

    /* V3.115 — figure references. Three shapes:
     *   [!fig:label]              → \ref{label}
     *   [!fig:label:A]            → \ref{label}\,(A)
     *   [!fig:label:A-B]          → \ref{label}\,(A--B)   (en-dash for ranges)
     * The figure block itself emits \label{...} via figureToTex when
     * attrs.numbered is true. Single-letter ranges go through with a
     * LaTeX en-dash (`--`); multi-letter or non-letter ranges are kept
     * as-is so the user's intent isn't auto-mangled. */
    out = out.replace(/\[!fig:([^\]\n]+)\]/g, function (_m, inner) {
      /* V3.341 — labels are stored WITH their `fig:` prefix, so a real
       * token is double-prefixed: `[!fig:fig:setup]` or
       * `[!fig:fig:setup:A]`. The old regex `([\w:.\-]+?)(?::panel)?`
       * mis-split the no-panel case into label="fig", panel="setup".
       * Correct rule: a trailing `:PANEL` (letters, optional A-B range)
       * is a panel only when stripping it leaves a valid `prefix:slug`
       * label (i.e. the remainder still contains a colon). */
      var label = inner, panel = null;
      var mm = inner.match(/^(.+:[^:]+):([A-Za-z]+(?:-[A-Za-z]+)?)$/);
      if (mm) { label = mm[1]; panel = mm[2]; }
      /* template.refs.figure.prefix puts the "Fig.~" word in the PDF
       * (the editor chip always showed it; export used to drop it, so
       * the compiled text read "as shown in 3"). */
      var base = useCref
        ? '\\cref{' + label + '}'
        : (refSpecFor(template, 'figure').prefix || '') + '\\ref{' + label + '}';
      if (!panel) return protect(base);
      var renderedPanel = /^\w-\w$/.test(panel) ? panel.replace('-', '--') : panel;
      return protect(base + '\\,(' + renderedPanel + ')');
    });

    /* V3.120 — table references. V3.341 — prefixed per template.refs.table. */
    out = out.replace(/\[!tab:([\w:.\-]+)\]/g, function (_m, label) {
      if (useCref) return protect('\\cref{' + label + '}');
      return protect((refSpecFor(template, 'table').prefix || '') + '\\ref{' + label + '}');
    });

    /* Section / subheading references → \ref (or \cref with cleveref).
     * The heading emits \label{<ref_label>}; LaTeX numbers it. */
    out = out.replace(/\[!sec:([\w:.\-]+)\]/g, function (_m, label) {
      if (useCref) return protect('\\cref{' + label + '}');
      return protect('Section~\\ref{' + label + '}');
    });

    // Code spans (V3.107) — protect content via a placeholder so later
    // markdown passes don't touch it. Reinsert at the end.
    var codePlaceholders = [];
    out = out.replace(/`([^`\n]+)`/g, function (_m, inner) {
      var idx = codePlaceholders.length;
      codePlaceholders.push(inner);
      return '\u0000CODE' + idx + '\u0000';
    });

    // Citations: [@k1; @k2] → \cite{k1,k2}. V3.341 — the command comes
    // from template.citation.command (\citep for natbib author-year /
    // elsarticle templates), falling back to the legacy cite_command
    // field and finally \cite. V3.344 — resolved BEFORE the markdown
    // passes (protected): the narrative token [@*key] carries a `*`
    // that the italic pass would otherwise pair with a later asterisk
    // and mangle. A leading `*` on a single key emits the template's
    // narrative_command (\citet) instead.
    /* V3.645 — value keys. BOTH passes run BEFORE the citation pass
     * below, because that pass's regex is a wide-open /\[@([^\]]+)\]/
     * that would otherwise swallow `[@item:24WP]` and emit
     * \cite{item:24WP} — an undefined citation in the compiled PDF.
     * Resolved text is escapeTex'd and protect()ed: a catalogue number
     * containing `_` or a unit containing `^` must not be re-read by
     * the markdown passes further down. An unknown key emits a LaTeX
     * comment rather than silently vanishing, matching how [!eqi:]
     * handles a missing entry. */
    out = out.replace(/\[!val:([A-Za-z0-9][\w-]*)\]/g, function (_m, key) {
      var entry = _valueEntryByKey(key);
      /* An unknown key emits a VISIBLE `[?KEY]` marker, not a `%`
       * comment: `%` runs to end of line in LaTeX, so a comment placed
       * mid-paragraph silently deletes the rest of the sentence from
       * the PDF. `[?KEY]` matches what the editor chip shows and shows
       * up in the proof where the author will catch it. */
      if (!entry) return protect(escapeTex('[?' + key + ']'));
      return protect(escapeTex(window.PaperSchemas.formatValueEntry(entry)));
    });
    out = out.replace(/\[@item:([A-Za-z0-9][\w-]*)\]/g, function (_m, key) {
      var entry = _valueEntryByKey(key);
      if (!entry || entry.kind !== 'inventory') {
        return protect(escapeTex('[?' + key + ']'));
      }
      return protect(escapeTex(window.PaperSchemas.formatValueEntry(entry)));
    });

    var citeCmd = citeCommandFor(template);
    out = out.replace(/\[@([^\]]+)\]/g, function (_m, inner) {
      var narrative = inner.charAt(0) === '*';
      var keys = (narrative ? inner.slice(1) : inner)
        .split(/\s*;\s*@?/)
        .map(function (s) { return s.trim().replace(/^\*/, ''); })
        .filter(Boolean);
      if (!keys.length) return _m;
      var cmd = citeCmd;
      if (narrative && keys.length === 1 && template && template.citation &&
          template.citation.narrative_command) {
        cmd = template.citation.narrative_command;
      }
      return protect(cmd + '{' + keys.join(',') + '}');
    });

    /* Markdown → private-use MARKERS first (V3.906), so the prose
     * between them can be escaped as plain text below; the markers turn
     * into \textbf{ … } etc. only after escaping. (Before V3.906 prose
     * was never escaped at all: a "50%" commented out the rest of the
     * paragraph — every paragraph is one source line — and & # _ broke
     * the compile.) Bold must come before italic, or `**foo**` would
     * match as two adjacent italics. */
    out = out.replace(/\*\*([^*\n]+)\*\*/g, '\uE101$1\uE102');
    out = out.replace(/\*([^*\n]+)\*/g, '\uE103$1\uE104');
    // Subscript / superscript (V3.107). V3.915 \u2014 subscripts were marked
    // with the ties above.
    if (!proseTex) out = out.replace(/~([^~\n]+)~/g, '\uE105$1\uE106');
    out = out.replace(/\^([^\^\n]+)\^/g, '\uE107$1\uE108');

    out = escapeProseTex(out, template);
    out = out.replace(/\uE101/g, '\\textbf{').replace(/\uE103/g, '\\emph{')
      .replace(/\uE105/g, '\\textsubscript{').replace(/\uE107/g, '\\textsuperscript{')
      .replace(/[\uE102\uE104\uE106\uE108]/g, '}');

    // Reinsert code spans now that all the markdown passes are done.
    out = out.replace(/\u0000CODE(\d+)\u0000/g, function (_m, idx) {
      var inner = codePlaceholders[Number(idx)] || '';
      return '\\texttt{' + escapeTex(inner) + '}';
    });

    /* V3.341 — reinsert every protected fragment (inline equations, ref
     * tokens, citations) now that the markdown passes are done. The
     * placeholders are private-use code points that markdown never
     * touched. */
    out = out.replace(/\uE000(\d+)\uE001/g, function (_m, idx) {
      return frags[Number(idx)] || '';
    });
    return out;
  }

  function equationToTex(block, template) {
    var src = (block.body || '').trim();
    if (!src) {
      // Fall back to imported raw_tex if body is empty (legacy Phase A imports).
      if (block.attrs && block.attrs.raw_tex) return block.attrs.raw_tex;
      return '';
    }
    var attrs = block.attrs || {};
    var displayMode = !!attrs.display;
    var numbered = !!attrs.numbered;
    /* V3.231 — equation_environment.display may have been swapped by the
     * paper-export workspace's override (e.g. equation* for unnumbered
     * floats); fall back to "equation" otherwise. */
    var env = (template.equation_environment && template.equation_environment.display) || 'equation';

    /* V3.109 — three cases:
     *   - inline mode → \(...\) (was: $...$ via template.inline_delim,
     *     but \(...\) is more LaTeX-canonical and matches the reader).
     *   - display + numbered → \begin{equation}\label{...}...\end{equation}
     *     so [!eqr:<label>] references can resolve via \eqref{}.
     *   - display + unnumbered → \[ ... \] (no number, no label)
     */
    if (!displayMode) {
      return '\\(' + src + '\\)';
    }
    /* V3.412 — optional page span. In a two-column compiled class a
     * display equation lives inside its column; span='page' wraps it in
     * cuted's \begin{strip} so it spans both columns (the only portable
     * primitive — flags \usepackage{cuted} for on-demand injection).
     * One-column classes: span is moot, emission unchanged. Absent key
     * = legacy = byte-identical. */
    var spanning = attrs.span === 'page' &&
      (template.figure_environment && template.figure_environment.compiled_columns === 2);
    if (spanning) {
      _usedCuted = true;
      if (_layoutWarnings && template._buildTarget !== 'preprint') {
        _layoutWarnings.push('A spanning equation uses the strip environment — it lands where the column ends; the journal may reposition it.');
      }
    }
    var body;
    if (numbered) {
      var label = attrs.label || ('eq:' + block.id);
      body = '\\begin{' + env + '}\n' +
             src + '\n' +
             '\\label{' + label + '}\n' +
             '\\end{' + env + '}';
    } else {
      body = '\\[' + src + '\\]';
    }
    return spanning ? '\\begin{strip}\n' + body + '\n\\end{strip}' : body;
  }

  function figureToTex(block, template) {
    var attrs = block.attrs || {};
    // Imported figures (Phase C predecessor) keep the full
    // \begin{figure}...\end{figure} in attrs.raw_tex. Until the user
    // re-uploads via the V3.102 figure block, emit the preserved source.
    if (attrs.raw_tex) return attrs.raw_tex;

    var env = (template.figure_environment && template.figure_environment.env) || 'figure';
    var defaultPlace = (template.figure_environment && template.figure_environment.placement) || 'H';
    var defaultWidth = (template.figure_environment && template.figure_environment.default_width) || '\\linewidth';

    /* V3.102 — prefer the new attrs schema, fall back to legacy attrs.path. */
    var place = attrs.placement || defaultPlace;
    var width = attrs.width || defaultWidth;

    /* V3.395 — Layout Mode: a block carrying `anchor` derives env/place/
     * width from PaperLayout.resolveFloat (anchor/span/lock × build
     * target × journal rules — incl. figure* for page-spanning floats in
     * two-column classes). Legacy blocks (no anchor key) keep the
     * verbatim attrs.placement path above → byte-identical old output. */
    var gfxH = null;      // V3.405 — image height cap ('120mm') from max_h
    var spacingTex = null; // V3.410 — per-float \vspace nudge
    var anchored = false;
    var isWrap = false;   // V3.485 — corner/side wrap (wrapfigure)
    if (typeof attrs.anchor === 'string' && attrs.anchor &&
        window.PaperLayout && window.PaperLayout.resolveFloat) {
      var resolved = window.PaperLayout.resolveFloat(attrs, template, 'figure');
      env = resolved.env;
      place = resolved.place;
      width = resolved.width || width;
      gfxH = resolved.height || null;
      spacingTex = resolved.spacingTex || null;
      anchored = true;
      isWrap = resolved.wrap === true;
      if (_layoutWarnings && resolved.warnings.length) {
        resolved.warnings.forEach(function (w) { _layoutWarnings.push(w); });
      }
    }
    var centering = (attrs.centering !== false);
    var label = attrs.label || ('fig:' + block.id);

    /* Source path: from attrs.storage_path → 'figures/<basename>' (the export
     * server is expected to mirror the Storage blob into <repo>/figures/);
     * fall back to legacy attrs.path; then placeholder. */
    var src;
    if (attrs.storage_path) {
      var seg = String(attrs.storage_path).split('/');
      src = 'figures/' + seg[seg.length - 1];
    } else if (attrs.path) {
      src = attrs.path;
    } else {
      src = 'figures/PLACEHOLDER.pdf';
    }

    /* Caption: V3.102 uses block.body (Y.Text) with paragraph render contract
     * for cite/math; legacy imports may have stashed it in attrs.caption. */
    var captionRaw = (block.body && String(block.body)) || attrs.caption || '';
    var caption = paragraphTextToTex(captionRaw, template);

    /* V3.115 — only emit \label and \caption (with the \figurename
     * counter increment) when attrs.numbered isn't false. An unnumbered
     * figure becomes a captionless float so [!fig:label] references
     * still resolve nothing — and the writer sees the [?Fig.] chip. */
    var numbered = (attrs.numbered !== false);

    /* V3.405 — the figure BOX model in LaTeX terms.
     * (a) max_h → \includegraphics height cap + keepaspectratio
     *     (graphicx's exact "maximize within a w×h box" incantation;
     *     `height`, not `totalheight` — rotation is out of scope).
     * (b) A NARROW anchored figure (box width < the full line) wraps
     *     image + caption in a minipage of the box width, so the PDF
     *     caption spans the box exactly like the preview (the sub-block
     *     contract). Full-width and legacy figures keep the flat form —
     *     legacy blocks never set `anchored` → byte-identical. */
    /* V3.485 — a wrapfigure sets its own box width via the env's second
     * arg, so the image is width=\linewidth (= the wrap width) with no
     * minipage, and the environment opens {side}{width} rather than
     * [place]. Everything else (centering, caption, label, height cap)
     * is identical to the boxed anchored form. */
    if (isWrap) {
      _usedWrapfig = true;
      var wGfx = 'width=\\linewidth' + (gfxH ? ', height=' + gfxH + ', keepaspectratio' : '');
      /* V3.912 — under a look, wrapfig's floating form (R / L): a figure
       * that does not fit the rest of the page waits for a later
       * paragraph instead of hanging into the bottom margin, the rule the
       * Document view's paginator follows. */
      var wPlace = template._look ? String(place).toUpperCase() : place;
      var wLines = ['\\begin{' + env + '}{' + wPlace + '}{' + width + '}'];
      if (centering) wLines.push('  \\centering');
      wLines.push('  \\includegraphics[' + wGfx + ']{' + src + '}');
      if (numbered) {
        wLines.push('  \\caption{' + caption + '}');
        wLines.push('  \\label{' + label + '}');
      } else if (caption) {
        wLines.push('  \\caption*{' + caption + '}');
      }
      wLines.push('\\end{' + env + '}');
      return wLines.join('\n');
    }

    var boxed = false;
    /* V3.906 — only when the author asks for a caption boxed under the
     * artwork (caption_fit:'box'); by default a journal caption spans the
     * column like LaTeX's own \caption, and the image alone is narrow. */
    if (anchored && attrs.caption_fit === 'box' && (numbered || caption)) {
      var mFrac = /^([0-9.]+)\s*\\(linewidth|columnwidth|textwidth)$/.exec(width);
      boxed = !!((mFrac && parseFloat(mFrac[1]) < 0.999) ||
                 /^[0-9.]+\s*(mm|cm|in|pt)$/.test(width));
    }
    /* V3.907 — a journal look caps the artwork so artwork + caption fit
     * the page (else LaTeX can never place the float and defers it past
     * the references). The tighter of the author's max_h and the cap. */
    if (template._look && window.PaperLook) {
      var spanPg = env.charAt(env.length - 1) === '*' || attrs.span === 'page';
      var capBp = window.PaperLook.figureMaxHeight(template._look, captionRaw, spanPg);
      var userBp = gfxH ? parseFloat(gfxH) * 72 / 25.4 : null;   // max_h is in mm
      if (!userBp || capBp < userBp) gfxH = capBp + 'bp';
    }
    var gfxOpts = 'width=' + (boxed ? '\\linewidth' : width) +
                  (gfxH ? ', height=' + gfxH + ', keepaspectratio' : '');
    var pad = boxed ? '    ' : '  ';

    var lines = ['\\begin{' + env + '}[' + place + ']'];
    /* V3.410 — per-float spacing nudge, on the float's text-facing side
     * (bottom float → before content; top/flow → after everything).
     * Float-LEVEL space, so it sits outside any minipage box. */
    if (spacingTex && spacingTex.before) lines.push('  ' + spacingTex.before);
    if (centering) lines.push('  \\centering');
    if (boxed) {
      lines.push('  \\begin{minipage}{' + width + '}');
      if (centering) lines.push('    \\centering');
    }
    lines.push(pad + '\\includegraphics[' + gfxOpts + ']{' + src + '}');
    if (numbered) {
      lines.push(pad + '\\caption{' + caption + '}');
      lines.push(pad + '\\label{' + label + '}');
    } else if (caption) {
      // Unnumbered: use \caption*{} (caption package) — caption text
      // appears, no number, no entry in \listoffigures.
      lines.push(pad + '\\caption*{' + caption + '}');
    }
    if (boxed) lines.push('  \\end{minipage}');
    if (spacingTex && spacingTex.after) lines.push('  ' + spacingTex.after);
    lines.push('\\end{' + env + '}');
    return lines.join('\n');
  }

  /* V3.906 — a table cell / note is prose: math, citations, cross-refs,
   * **bold**, *italic*, ~sub~ and ^sup^ work in cells exactly as in a
   * paragraph (they used to be escaped as plain text, so $n_2/n_1$ or a
   * [@cite] in a cell printed literally). */
  function cellTex(v, template) {
    return paragraphTextToTex(v == null ? '' : String(v), template);
  }

  function tableToTex(block, template) {
    var attrs = block.attrs || {};
    // If we have grid cells, render booktabs-style.
    var rows = attrs.rows;
    var cols = attrs.cols;
    var cells = attrs.cells;
    if (typeof rows === 'number' && typeof cols === 'number' && cells && cols > 0) {
      var env = (template.table_environment && template.table_environment.env) || 'table';
      var place = (template.table_environment && template.table_environment.placement) || 'H';

      /* V3.395 — Layout Mode: anchored tables derive env/place from
       * PaperLayout.resolveFloat (incl. table* for page-spanning tables
       * in two-column classes) and honor the journal's caption position
       * (IEEE sets table captions ABOVE the tabular). Legacy blocks
       * (no anchor key) keep the verbatim path → identical old output. */
      var captionAbove = false;
      var tabSpacingTex = null;   // V3.410 — per-float \vspace nudge
      if (typeof attrs.anchor === 'string' && attrs.anchor &&
          window.PaperLayout && window.PaperLayout.resolveFloat) {
        var resolved = window.PaperLayout.resolveFloat(attrs, template, 'table');
        env = resolved.env;
        place = resolved.place;
        captionAbove = resolved.captionAbove;
        tabSpacingTex = resolved.spacingTex || null;
        if (_layoutWarnings && resolved.warnings.length) {
          resolved.warnings.forEach(function (w) { _layoutWarnings.push(w); });
        }
      }

      /* V3.120 — block-level attrs override the template defaults.
       *   booktabs    — emits \toprule / \midrule / \bottomrule
       *   header_row  — controls the \midrule after row 0
       *   align       — per-column 'l|c|r' string (length === cols)
       *   numbered    — when false, emit \caption*{} (no number/no label)
       *   label       — used for \label{} when numbered (default tab:<id>)
       */
      var booktabs = (typeof attrs.booktabs === 'boolean')
        ? attrs.booktabs
        : !!(template.table_environment && template.table_environment.use_booktabs);
      var headerRow = (typeof attrs.header_row === 'boolean') ? attrs.header_row : true;
      var numbered = attrs.numbered !== false;
      var label = attrs.label || ('tab:' + block.id);

      var alignStr = (typeof attrs.align === 'string' && attrs.align.length === cols)
        ? attrs.align
        : 'l'.repeat(cols);
      // Validate alignStr — only l/c/r allowed; replace anything else with 'l'.
      alignStr = alignStr.split('').map(function (c) {
        return /[lcr]/.test(c) ? c : 'l';
      }).join('');

      /* Tables II — merged cells + per-column widths (scalar attrs;
       * parsed through the shared PaperLayout helpers). Absent attrs =
       * empty maps = byte-identical legacy emission. */
      var PL = (typeof window !== 'undefined' && window.PaperLayout) ? window.PaperLayout : null;
      var merges = PL && PL.parseTableMerges ? PL.parseTableMerges(attrs.merges_json) : {};
      var cover = PL && PL.tableCoverMap ? PL.tableCoverMap(merges, rows, cols) : { anchors: {}, skip: {}, cont: {} };
      var widths = PL && PL.parseTableWidths ? PL.parseTableWidths(attrs.widths_json, cols) : null;

      /* V3.651 — table styling, from the same shared parse the builder
       * grid, the doc-side preview and Document view read. An untouched
       * table has no style_json, `rules` falls back to the pre-V3.651
       * `booktabs` boolean and every default is a no-op, so its .tex is
       * byte-identical to what this function emitted before. */
      var tstyle = PL && PL.parseTableStyle
        ? PL.parseTableStyle(attrs.style_json, attrs.booktabs)
        : { rules: booktabs ? 'booktabs' : 'none', size: 'normal', density: 'normal',
            zebra: false, rule_after: [], stretch: 1, sizeTex: null };
      var cellSt = PL && PL.parseTableCellStyles
        ? PL.parseTableCellStyles(attrs.cell_styles_json) : {};
      var FILLS = (PL && PL.TABLE_FILLS) || {};
      var gridRules = tstyle.rules === 'grid';
      booktabs = tstyle.rules === 'booktabs';

      /* Wrap a cell's body in the formatting it carries.
       *
       * ORDER MATTERS TWICE. \cellcolor has to be the first thing in the
       * cell's content, and \multicolumn has to be the ENTIRE cell — so
       * the alignment override wraps LAST, with the shading inside it.
       * The other way round is a "Misplaced \multicolumn" error, not a
       * cosmetic difference. \multicolumn{1} is how LaTeX overrides one
       * column's alignment, which is exactly what a per-cell align is. */
      function styleCell(content, key, colChar, span) {
        var st = cellSt[key];
        if (!st) return content;
        if (st.b) content = '\\textbf{' + content + '}';
        if (st.i) content = '\\textit{' + content + '}';
        if (st.bg && FILLS[st.bg]) {
          _usedColortbl = true;
          content = '\\cellcolor{' + FILLS[st.bg].tex + '}' + content;
        }
        if (st.al && !(span && span.cs > 1)) {
          content = '\\multicolumn{1}{' + st.al + '}{' + content + '}';
        }
        return content;
      }
      /* V3.654 — per-row extra height. `\arraystretch` is per-TABLE, so a
       * single taller row is `\\[dim]`: extra space after that one row.
       * Emitted as the row terminator, so it has to be composed with the
       * `\\` every row already ends in rather than added after it. */
      var rowExtras = PL && PL.parseTableRowExtras
        ? PL.parseTableRowExtras(attrs.row_heights_json) : {};
      function rowEnd(r) {
        var pt = rowExtras[r];
        return (pt > 0) ? (' \\\\[' + pt + 'pt]') : ' \\\\';
      }
      /* Extra horizontal rules the writer drew under specific rows. The
       * last row is skipped when a closing rule is already coming, or the
       * table ends in a doubled line. */
      function ruleAfterTex(r, indent) {
        if (tstyle.rule_after.indexOf(r) === -1) return null;
        if (r === rows - 1 && (booktabs || gridRules)) return null;
        return indent + (booktabs ? '\\midrule' : '\\hline');
      }
      /* V3.652 — WRAPPING. In LaTeX a cell only wraps in a p{width} column,
       * and p{} needs a NUMBER: tabular has no "auto but wrapping" column
       * type. So when `wrap` is on, the columns the writer has not sized
       * share whatever fraction of the line is left over — via
       * PaperLayout.tableColShares, the same helper the editor's colgroup
       * and Document view use, so what you drag is what compiles.
       *
       * The \dimexpr subtracts the two \tabcolsep gutters every column
       * carries. Without it, N columns of 1/N\linewidth overrun the line by
       * 2N\tabcolsep and LaTeX reports an overfull hbox on a table that
       * looked right on screen. */
      var wrapCols = tstyle.wrap === true;
      var wShares = (wrapCols && PL && PL.tableColShares)
        ? PL.tableColShares(widths, cols) : null;
      function colspecChar(c) {
        var a = alignStr[c] || 'l';
        var w = (wShares ? wShares[c] : (widths && widths[c])) || null;
        if (!w || w.mode === 'auto') return a;
        var dim = w.mode === 'mm'
          ? (w.v + 'mm')
          : ('\\dimexpr ' + w.v + '\\linewidth-2\\tabcolsep\\relax');
        if (a === 'c') { _usedArray = true; return '>{\\centering\\arraybackslash}p{' + dim + '}'; }
        if (a === 'r') { _usedArray = true; return '>{\\raggedleft\\arraybackslash}p{' + dim + '}'; }
        /* A left-aligned p{} column is JUSTIFIED by default, which in a
         * narrow column gives the rivers of whitespace that make a wrapped
         * table look broken. \raggedright fixes it; \arraybackslash puts
         * \\ back to meaning "end of row" rather than "line break". */
        if (wrapCols) { _usedArray = true; return '>{\\raggedright\\arraybackslash}p{' + dim + '}'; }
        return 'p{' + dim + '}';
      }
      var colspec = '';
      for (var ci = 0; ci < cols; ci++) colspec += colspecChar(ci);
      /* The "grid" preset boxes every cell: vertical bars in the colspec
       * plus an \hline between every row (emitted below). */
      if (gridRules) {
        var gparts = [];
        for (var gi = 0; gi < cols; gi++) gparts.push(colspecChar(gi));
        colspec = '|' + gparts.join('|') + '|';
      }

      /* V3.120 — caption may be a Y.Text (live mode) or a string
       * (extracted projection). Route through paragraphTextToTex so
       * cite + math + markdown tokens render correctly in the caption.
       * V3.395 — computed up front so it can be emitted ABOVE the
       * tabular when the journal requires it (IEEE table captions). */
      var captionRaw = '';
      if (attrs.caption != null) {
        captionRaw = (attrs.caption.toString && attrs.caption !== attrs.caption.toString)
          ? attrs.caption.toString()
          : String(attrs.caption);
      }
      var captionTex = paragraphTextToTex(captionRaw, template);

      /* Tables II — notes (scalar attr, one per line) + longtable.
       * longtable is NOT a float and is invalid in two-column classes:
       * on compiled_columns===2 templates it degrades to the regular
       * float path with a warning. */
      var noteLines = String(attrs.notes || '').split('\n')
        .map(function (s) { return s.trim(); }).filter(Boolean);
      var twoColT = !!(template.figure_environment &&
        template.figure_environment.compiled_columns === 2);
      var longtable = attrs.longtable === true;
      if (longtable && twoColT) {
        longtable = false;
        if (_layoutWarnings) {
          _layoutWarnings.push('Table "' + (captionRaw || block.id) +
            '": longtable is not available in two-column layouts — rendered as a regular table.');
        }
      }

      if (longtable) {
        /* Multi-page table: caption lives INSIDE the longtable's first
         * head; the (optional) header row repeats on every page via
         * \endhead. Float anchor/span/lock and spacing don't apply. */
        _usedLongtable = true;
        var lt = [];
        /* V3.651 — longtable is not a float, so the size/stretch/striping
         * commands need their own group or they leak into the body text
         * that follows. */
        var ltGrouped = !!tstyle.sizeTex || tstyle.stretch !== 1 || tstyle.zebra;
        if (ltGrouped) {
          lt.push('\\begingroup');
          if (tstyle.sizeTex) lt.push('  ' + tstyle.sizeTex);
          if (tstyle.stretch !== 1) {
            lt.push('  \\renewcommand{\\arraystretch}{' + tstyle.stretch + '}');
          }
          if (tstyle.zebra) {
            _usedColortbl = true;
            lt.push('  \\rowcolors{' + (headerRow ? 2 : 1) + '}{}{black!4}');
          }
        }
        lt.push('\\begin{longtable}{' + colspec + '}');
        if (numbered) {
          lt.push('  \\caption{' + captionTex + '}\\label{' + label + '} \\\\');
        } else if (captionTex) {
          lt.push('  \\caption*{' + captionTex + '} \\\\');
        }
        if (booktabs) lt.push('  \\toprule');
        else if (gridRules) lt.push('  \\hline');
        var ltHeader = [];
        if (headerRow) {
          for (var hc = 0; hc < cols; hc++) {
            var hKey = '0-' + hc;
            if (cover.skip[hKey] || cover.cont[hKey] != null) continue;
            var hCell = cells[hKey];
            if (hCell && typeof hCell.toString === 'function' && hCell !== hCell.toString) hCell = hCell.toString();
            var hContent = styleCell(cellTex(hCell, template), hKey, alignStr[hc] || 'l',
              cover.anchors[hKey]);
            var hAnchor = cover.anchors[hKey];
            if (hAnchor && hAnchor.cs > 1) {
              hContent = '\\multicolumn{' + hAnchor.cs + '}{' +
                ((cellSt[hKey] && cellSt[hKey].al) || alignStr[hc] || 'l') + '}{' + hContent + '}';
            }
            ltHeader.push(hContent);
          }
          lt.push('  ' + ltHeader.join(' & ') + ' \\\\');
          if (booktabs) lt.push('  \\midrule');
        }
        lt.push('  \\endfirsthead');
        if (booktabs) lt.push('  \\toprule');
        if (headerRow) {
          lt.push('  ' + ltHeader.join(' & ') + ' \\\\');
          if (booktabs) lt.push('  \\midrule');
        }
        lt.push('  \\endhead');
        for (var lr = headerRow ? 1 : 0; lr < rows; lr++) {
          var ltCells = [];
          for (var lc = 0; lc < cols; lc++) {
            var lKey = lr + '-' + lc;
            if (cover.skip[lKey]) continue;
            if (cover.cont[lKey] != null) {
              var lCs = cover.cont[lKey];
              ltCells.push(lCs > 1 ? '\\multicolumn{' + lCs + '}{' + (alignStr[lc] || 'l') + '}{}' : '');
              continue;
            }
            var lCell = cells[lKey];
            if (lCell && typeof lCell.toString === 'function' && lCell !== lCell.toString) lCell = lCell.toString();
            var lContent = styleCell(cellTex(lCell, template), lKey, alignStr[lc] || 'l',
              cover.anchors[lKey]);
            var lAnchor = cover.anchors[lKey];
            if (lAnchor) {
              if (lAnchor.rs > 1) { _usedMultirow = true; lContent = '\\multirow{' + lAnchor.rs + '}{*}{' + lContent + '}'; }
              if (lAnchor.cs > 1) {
                lContent = '\\multicolumn{' + lAnchor.cs + '}{' +
                  ((cellSt[lKey] && cellSt[lKey].al) || alignStr[lc] || 'l') + '}{' + lContent + '}';
              }
            }
            ltCells.push(lContent);
          }
          lt.push('  ' + ltCells.join(' & ') + rowEnd(lr));
          var ltExtra = ruleAfterTex(lr, '  ');
          if (ltExtra) lt.push(ltExtra);
          else if (gridRules && lr < rows - 1) lt.push('  \\hline');
        }
        if (booktabs) lt.push('  \\bottomrule');
        else if (gridRules) lt.push('  \\hline');
        /* Notes inside a longtable: full-width footnotesize rows
         * (threeparttable does not pair with longtable). */
        noteLines.forEach(function (n) {
          lt.push('  \\multicolumn{' + cols + '}{l}{\\footnotesize ' + cellTex(n, template) + '} \\\\');
        });
        lt.push('\\end{longtable}');
        if (ltGrouped) lt.push('\\endgroup');
        return lt.join('\n');
      }

      var lines = [];
      lines.push('\\begin{' + env + '}[' + place + ']');
      /* V3.410 — spacing nudge on the text-facing side (see figureToTex). */
      if (tabSpacingTex && tabSpacingTex.before) lines.push('  ' + tabSpacingTex.before);
      lines.push('  \\centering');
      if (captionAbove) {
        if (numbered) {
          if (captionTex) lines.push('  \\caption{' + captionTex + '}');
          lines.push('  \\label{' + label + '}');
        } else if (captionTex) {
          lines.push('  \\caption*{' + captionTex + '}');
        }
      }
      if (noteLines.length) {
        _usedThreeparttable = true;
        lines.push('  \\begin{threeparttable}');
      }
      /* V3.651 — table-level styling, emitted inside the float so it
       * cannot leak into the body text. */
      if (tstyle.sizeTex) lines.push('  ' + tstyle.sizeTex);
      if (tstyle.stretch !== 1) {
        lines.push('  \\renewcommand{\\arraystretch}{' + tstyle.stretch + '}');
      }
      if (tstyle.zebra) {
        /* \rowcolors{n}{odd}{even} counts from the first BODY row, so a
         * header row shifts the start by one — otherwise the header takes
         * the tint and the striping reads off by one. */
        _usedColortbl = true;
        lines.push('  \\rowcolors{' + (headerRow ? 2 : 1) + '}{}{black!4}');
      }
      lines.push('  \\begin{tabular}{' + colspec + '}');
      if (booktabs) lines.push('    \\toprule');
      else if (gridRules) lines.push('    \\hline');
      for (var r = 0; r < rows; r++) {
        var rowCells = [];
        for (var c = 0; c < cols; c++) {
          var key = r + '-' + c;
          if (cover.skip[key]) continue;   // swallowed by a merge
          if (cover.cont[key] != null) {
            /* Rowspan continuation at the anchor column — an empty
             * placeholder keeps the LaTeX column count right. */
            var contCs = cover.cont[key];
            rowCells.push(contCs > 1
              ? '\\multicolumn{' + contCs + '}{' + (alignStr[c] || 'l') + '}{}'
              : '');
            continue;
          }
          var cell = cells[key];
          // cell may be a Y.Text (toString needed) or a plain string from
          // paperTreeFromYDoc; normalize.
          if (cell && typeof cell.toString === 'function' && cell !== cell.toString) {
            cell = cell.toString();
          }
          var content = cellTex(cell, template);
          var anchor = cover.anchors[key];
          if (anchor) {
            var inner = styleCell(content, key, alignStr[c] || 'l', anchor);
            if (anchor.rs > 1) {
              _usedMultirow = true;
              inner = '\\multirow{' + anchor.rs + '}{*}{' + inner + '}';
            }
            if (anchor.cs > 1) {
              var mcAlign = (cellSt[key] && cellSt[key].al) || alignStr[c] || 'l';
              inner = '\\multicolumn{' + anchor.cs + '}{' + mcAlign + '}{' + inner + '}';
            }
            rowCells.push(inner);
          } else {
            rowCells.push(styleCell(content, key, alignStr[c] || 'l', null));
          }
        }
        lines.push('    ' + rowCells.join(' & ') + rowEnd(r));
        if (r === 0 && booktabs && headerRow) lines.push('    \\midrule');
        else {
          var extra = ruleAfterTex(r, '    ');
          if (extra) lines.push(extra);
          else if (gridRules && r < rows - 1) lines.push('    \\hline');
        }
      }
      if (booktabs) lines.push('    \\bottomrule');
      else if (gridRules) lines.push('    \\hline');
      lines.push('  \\end{tabular}');
      if (noteLines.length) {
        lines.push('  \\begin{tablenotes}\\footnotesize');
        noteLines.forEach(function (n) { lines.push('    \\item ' + cellTex(n, template)); });
        lines.push('  \\end{tablenotes}');
        lines.push('  \\end{threeparttable}');
      }

      if (!captionAbove) {
        if (numbered) {
          if (captionTex) lines.push('  \\caption{' + captionTex + '}');
          lines.push('  \\label{' + label + '}');
        } else if (captionTex) {
          // Unnumbered: \caption*{} (caption package), no \label
          lines.push('  \\caption*{' + captionTex + '}');
        }
      }
      if (tabSpacingTex && tabSpacingTex.after) lines.push('  ' + tabSpacingTex.after);
      lines.push('\\end{' + env + '}');
      return lines.join('\n');
    }
    // Imported tables fall back to raw_tex.
    if (attrs.raw_tex) return attrs.raw_tex;
    return '% [table block ' + block.id + ' — populate via the grid editor when available]';
  }

  /* List block → nested itemize/enumerate. `body` is one item per line;
   * leading spaces (2 per level) nest; attrs.list_type picks the env.
   * Each item runs through the paragraph contract (cites/math/markdown).
   * Empty body falls back to an imported raw_tex passthrough. */
  function listToTex(block, template) {
    var body = String(block.body || '');
    if (!body.trim()) return (block.attrs && block.attrs.raw_tex) ? block.attrs.raw_tex : '';
    var items = [];
    body.split('\n').forEach(function (line) {
      var m = line.match(/^(\s*)(.*)$/);
      var text = m[2].replace(/\s+$/, '');
      if (!text) return;
      items.push({ depth: Math.min(3, Math.floor(m[1].replace(/\t/g, '  ').length / 2)), text: text });
    });
    if (!items.length) return '';
    /* V3.649 — one emitter for the list block and for lists inside a
     * paragraph body. */
    return listItemsToTex(items, (block.attrs && block.attrs.list_type), template);
  }

  /* ── Citation collection + BibTeX ── */

  function collectCitationKeys(tree, excludeKinds) {
    var seen = Object.create(null);
    var keys = [];
    function scan(text) {
      if (!text) return;
      var re = /\[@([^\]]+)\]/g;
      var m;
      while ((m = re.exec(text))) {
        /* V3.645 — `[@item:KEY]` is an inventory reference sharing the
         * citation namespace, not a citation. Excluded here or it would
         * enter refs.bib as a phantom entry and LaTeX would warn about
         * an undefined citation on every compile. */
        if (String(m[1]).replace(/^\*/, '').indexOf('item:') === 0) continue;
        m[1].split(/\s*;\s*@?/).forEach(function (k) {
          /* V3.344 — a leading `*` (narrative citation) is not part of
           * the key. */
          k = k.trim().replace(/^\*/, '');
          if (k && !seen[k]) { seen[k] = true; keys.push(k); }
        });
      }
      /* V3.915 — \cite{a,b} written in prose or an imported table */
      var reTex = /\\(?:cite[a-z]*|parencite|textcite)\*?(?:\[[^\]]*\]){0,2}\{([^}]+)\}/g;
      while ((m = reTex.exec(text))) {
        m[1].split(',').forEach(function (k) {
          k = k.trim();
          if (k && !seen[k]) { seen[k] = true; keys.push(k); }
        });
      }
    }
    (tree.sections || []).forEach(function (sec) {
      /* S-α — the MANUSCRIPT bundle excludes submission-doc sections
       * from its .bib (buildBundle passes excludeKinds only when no
       * sectionFilter is set — subdoc bundles collect normally). */
      if (excludeKinds && excludeKinds[sec.kind]) return;
      (sec.children || []).forEach(function (b) {
        // Paragraphs, figure captions, and subheadings all render via the
        // paragraph contract, so any can carry [@cite] tokens.
        if (b.kind === 'paragraph' || b.kind === 'figure' || b.kind === 'subheading') scan(b.body || '');
        /* V3.341 — table captions render through the paragraph contract
         * too (tableToTex) but were never scanned, so their citations
         * were missing from the .bib. The editor-side
         * getCitedKeysInPaper already counted them. */
        if (b.kind === 'table' && b.attrs && b.attrs.caption != null) {
          scan(String(b.attrs.caption));
        }
        if (b.attrs && b.attrs.raw_tex) scan(String(b.attrs.raw_tex));   // V3.915
      });
    });
    return keys;
  }

  /* Build a BibTeX file from a list of citation keys + the items.json
   * paper-library entries already loaded in the editor's citation index.
   * Unknown keys become commented-out @misc placeholders so the .tex still
   * compiles instead of failing on a missing reference. */
  function buildBibtex(keys, citationByKey) {
    var lines = [
      '% Generated by ResearchManagement paper builder — Phase F LaTeX export',
      '% Generated at: ' + new Date().toISOString(),
      '',
    ];
    keys.forEach(function (key) {
      var entry = citationByKey ? citationByKey[key] : null;
      if (!entry) {
        lines.push('% @misc{' + key + ', note = "MISSING from data/items.json paper-library — add it before submission" }');
        lines.push('');
        return;
      }
      // We have the entry's metadata in entry, but it's the projection used
      // by the chip popover. For a full BibTeX entry we re-fetch from
      // items.json; the editor has it cached on state.fullCitationByKey.
      var full = entry.full || entry;
      lines.push(bibEntryFor(full));
    });
    return lines.join('\n');
  }

  function bibEntryFor(item) {
    // item is the items.json row OR the projected entry from state.citationByKey.
    var lib = (item.meta && item.meta.library) || item;
    var key = lib.citation_key || item.key;
    var year = lib.year || '';
    var authors = (lib.authors || []).map(function (a) {
      return (a.family || '') + (a.given ? ', ' + a.given : '');
    }).join(' and ');
    var title = item.title || lib.title || '';
    var journal = lib.journal || '';
    var volume = lib.volume || '';
    var issue = lib.issue || '';
    var pages = lib.pages || '';
    var doi = lib.doi || '';
    var url = lib.url || '';

    var fields = [];
    if (authors) fields.push('  author    = {' + bibEscape(authors) + '}');
    if (title)   fields.push('  title     = {' + bibEscape(title) + '}');
    if (journal) fields.push('  journal   = {' + bibEscape(journal) + '}');
    if (year)    fields.push('  year      = {' + bibEscape(year) + '}');
    if (volume)  fields.push('  volume    = {' + bibEscape(volume) + '}');
    if (issue)   fields.push('  number    = {' + bibEscape(issue) + '}');
    // pages: a typed en dash would be dropped by T1 fonts; BibTeX wants --
    if (pages)   fields.push('  pages     = {' + bibEscape(String(pages).replace(/\s*[\u2013\u2014\u2212-]+\s*/g, '--')) + '}');
    if (doi)     fields.push('  doi       = {' + doi + '}');
    if (url && !doi) fields.push('  url       = {' + url + '}');
    var type = (lib.arxiv_id && !lib.doi) ? 'misc' : 'article';
    return '@' + type + '{' + key + ',\n' + fields.join(',\n') + '\n}\n';
  }

  /* V3.906 — .bib field text: LaTeX specials escaped (an `&` in "Cell
   * Biology & Toxicology" broke the bibliography) and non-ASCII written
   * the TeX way (an accented author name was dropped by the T1 fonts).
   * `$…$` math in titles passes through. */
  /* V3.911 — Crossref sends some titles and journal names HTML-escaped
   * ("ACS Biomaterials Science &amp; Engineering"): decode first. */
  function decodeEntities(s) {
    return String(s || '').replace(/&(amp|lt|gt|quot|apos|#39|#(\d+)|#x([0-9a-f]+));/gi, function (m, name, dec, hex) {
      if (dec) return String.fromCharCode(parseInt(dec, 10));
      if (hex) return String.fromCharCode(parseInt(hex, 16));
      return { amp: '&', lt: '<', gt: '>', quot: '"', apos: "'", '#39': "'" }[name.toLowerCase()];
    });
  }
  function bibEscape(s) {
    var str = decodeEntities(s);
    /* V3.915 — metadata imported from a .bib keeps BibTeX accents
     * (Andr{\'e}); as Unicode they get the accent commands below instead
     * of a printed backslash and a bare ^ that stopped the compile */
    if (window.PaperProseTex) str = window.PaperProseTex.decodeAccents(str);
    var out = '';
    for (var i = 0; i < str.length; i++) {
      var c = str[i];
      if (c === '\\') out += '\\textbackslash{}';
      else if (c === '&' || c === '%' || c === '#' || c === '_' || c === '$') out += '\\' + c;
      else if (c === '{' || c === '}') out += '\\' + c;
      else if (c === '~') out += '\\textasciitilde{}';
      else if (c === '^') out += '\\textasciicircum{}';
      else if (c.charCodeAt(0) > 127) out += uniToTex(c, null);
      else out += c;
    }
    return out;
  }

  /* ── Tex escape (for plain text → LaTeX) ── */

  /* V3.906 — $…$ / \(…\) spans → protect() placeholders, verbatim.
   * Mirrors renderParagraphHtml's scan so the editor, the Document view
   * and the PDF agree on what is math. \$ → a literal dollar. */
  function _protectInlineMath(text, protect) {
    var out = '', i = 0, n = text.length;
    while (i < n) {
      var ch = text[i];
      if (ch === '\\' && text[i + 1] === '$') { out += protect('\\$'); i += 2; continue; }
      if (ch === '$' && (i === 0 || text[i - 1] !== '\\')) {
        var j = i + 1;
        while (j < n && !(text[j] === '$' && text[j - 1] !== '\\')) j++;
        if (j < n && j > i + 1) { out += protect('$' + text.slice(i + 1, j) + '$'); i = j + 1; continue; }
      }
      if (ch === '\\' && text[i + 1] === '(') {
        var k = text.indexOf('\\)', i + 2);
        if (k > i) { out += protect('\\(' + text.slice(i + 2, k) + '\\)'); i = k + 2; continue; }
      }
      out += ch; i++;
    }
    return out;
  }

  /* V3.915 — LaTeX written in prose → protected fragments (see the call
   * in paragraphTextToTex). Runs after the inline math is protected, so a
   * `\` here is prose. A `~` subscript becomes the markers the markdown
   * pass uses; a tie becomes a no-break space, which escapeProseTex turns
   * back into `~`; a `~` beside a space stays a character. */
  function _protectProseTex(s, template, protect, useCref, PT) {
    if (s.indexOf('\\') < 0 && s.indexOf('~') < 0) return s;
    var ctx = {
      useCref: useCref,
      ref: function (kind, label, form, capital) {
        if (kind === 'equation') {
          var es = refSpecFor(template, 'equation');
          return (form === 'name' ? (es.prefix || '') : '') + (es.command || '\\eqref') + '{' + label + '}';
        }
        if (form === 'number') return '\\ref{' + label + '}';
        if (kind === 'section') return 'Section~\\ref{' + label + '}';
        if (kind !== 'figure' && kind !== 'table') return '\\ref{' + label + '}';
        /* \cref names the float even where the template's own tokens leave
         * the word to the author (an empty prefix) */
        var prefix = refSpecFor(template, kind).prefix || (kind === 'figure' ? 'Fig.~' : 'Table~');
        if (capital && /^Fig\.?~?$/.test(prefix)) prefix = 'Figure~';
        return prefix + '\\ref{' + label + '}';
      },
      cite: function (keys, narrative) {
        if (!keys.length) return '';
        var cmd = citeCommandFor(template);
        if (narrative && keys.length === 1 && template && template.citation && template.citation.narrative_command) {
          cmd = template.citation.narrative_command;
        }
        return cmd + '{' + keys.join(',') + '}';
      },
    };
    var out = '';
    for (var i = 0; i < s.length; i++) {
      var c = s.charAt(i);
      if (c === '\\') {
        var cmd = PT.readCommand(s, i);
        if (cmd) {
          var tex = PT.toTex(cmd, ctx);
          if (tex !== false) {
            out += protect(tex == null ? cmd.src : tex);
            i = cmd.end - 1;
            continue;
          }
        }
      } else if (c === '~') {
        var tl = PT.tildeAt(s, i);
        if (tl.kind === 'sub') { out += '' + tl.inner + ''; i = tl.end; continue; }
        if (tl.kind === 'tie') { out += ' '; continue; }
      }
      out += c;
    }
    return out;
  }

  /* V3.906 — symbols the journal text fonts lack (TeX Gyre has no ∼ ≲ ≳
   * ′ ″ ∝; Latin Modern has no Greek at all) are set as math, which
   * every font setup has — XeTeX otherwise drops a missing glyph with
   * only a log line, and pdfLaTeX stops. Greek passes through as text
   * when the template's font has Greek (template._textGreek). */
  var TEX_MATH_CHARS = {
    '∼': '\\sim', '≈': '\\approx', '≲': '\\lesssim', '≳': '\\gtrsim',
    '≤': '\\leq', '≥': '\\geq', '≠': '\\neq', '≡': '\\equiv',
    '±': '\\pm', '∓': '\\mp', '×': '\\times', '÷': '\\div',
    '−': '-', '→': '\\rightarrow', '←': '\\leftarrow', '↔': '\\leftrightarrow',
    '⇒': '\\Rightarrow', '∞': '\\infty', '∝': '\\propto', '∂': '\\partial',
    '∇': '\\nabla', '√': '\\surd', '′': '\\prime', '″': '\\prime\\prime',
    '·': '\\cdot', '…': '\\ldots', '∈': '\\in', '∑': '\\sum', '∫': '\\int',
    '↑': '\\uparrow', '↓': '\\downarrow', '•': '\\bullet', '°': '^{\\circ}',
    ' ': '\\,', ' ': '\\,',
  };
  var TEX_GREEK = {
    'α': 'alpha', 'β': 'beta', 'γ': 'gamma', 'δ': 'delta', 'ε': 'epsilon',
    'ζ': 'zeta', 'η': 'eta', 'θ': 'theta', 'ι': 'iota', 'κ': 'kappa',
    'λ': 'lambda', 'μ': 'mu', 'µ': 'mu', 'ν': 'nu', 'ξ': 'xi', 'π': 'pi',
    'ρ': 'rho', 'σ': 'sigma', 'ς': 'varsigma', 'τ': 'tau', 'υ': 'upsilon',
    'φ': 'phi', 'χ': 'chi', 'ψ': 'psi', 'ω': 'omega', 'Γ': 'Gamma',
    'Δ': 'Delta', 'Θ': 'Theta', 'Λ': 'Lambda', 'Ξ': 'Xi', 'Π': 'Pi',
    'Σ': 'Sigma', 'Φ': 'Phi', 'Ψ': 'Psi', 'Ω': 'Omega',
  };
  /* Prose → LaTeX: escape the specials, set font-missing symbols as math.
   * Leaves private-use placeholders/markers (U+E000–U+F8FF) alone. */
  function escapeProseTex(s, template) {
    if (!s) return '';
    var greekText = !!(template && template._textGreek);
    var out = '';
    for (var i = 0; i < s.length; i++) {
      var c = s[i];
      switch (c) {
        case '\\': out += '\\textbackslash{}'; continue;
        case '#': case '$': case '%': case '&': case '_': case '{': case '}':
          out += '\\' + c; continue;
        case '~': out += '\\textasciitilde{}'; continue;
        case '^': out += '\\textasciicircum{}'; continue;
        case '\u00A0': out += '~'; continue;   // no-break space = TeX's tie
      }
      if (c.charCodeAt(0) > 127) { out += uniToTex(c, template); continue; }
      out += c;
    }
    return out;
  }

  /* V3.906 — one non-ASCII character → LaTeX that compiles in EVERY font
   * setup: the legacy 8-bit T1 fonts the classes load (XeTeX cannot put a
   * Unicode code point into them — "200–300 nm" printed "200300 nm") and
   * fontspec OpenType fonts alike (their TeX ligatures turn -- into –).
   * Punctuation → TeX ligatures/commands, accented Latin → accent
   * commands (from the NFD decomposition), symbols the text fonts lack →
   * math. Private-use placeholders and anything unknown pass through. */
  var TEX_TEXT_CHARS = {
    '\u2013': '--', '\u2014': '---', '\u2018': '`', '\u2019': "'", '\u201C': '``', '\u201D': "''",
    '\u201A': '\\quotesinglbase{}', '\u201E': '\\quotedblbase{}', '\u00AB': '\\guillemotleft{}',
    '\u00BB': '\\guillemotright{}', '\u2010': '-', '\u2011': '-', '\u2012': '--', '\u2015': '---',
    '\u00A9': '\\textcopyright{}', '\u00AE': '\\textregistered{}', '\u2122': '\\texttrademark{}',
    '\u00A7': '\\S{}', '\u00B6': '\\P{}', '\u2020': '\\dag{}', '\u2021': '\\ddag{}',
    '\u00DF': '\\ss{}', '\u00E6': '\\ae{}', '\u00C6': '\\AE{}', '\u00F8': '\\o{}', '\u00D8': '\\O{}',
    '\u0153': '\\oe{}', '\u0152': '\\OE{}', '\u0142': '\\l{}', '\u0141': '\\L{}', '\u0131': '\\i{}',
    '\u0111': '\\dj{}', '\u0110': '\\DJ{}', '\u00E5': '\\aa{}', '\u00C5': '\\AA{}', '\u00F0': '\\dh{}',
    '\u00FE': '\\th{}', '\u00A3': '\\pounds{}', '\u20AC': '\\texteuro{}', '\u00A1': '!`', '\u00BF': '?`',
    '\u00B9': '\\textsuperscript{1}', '\u00B2': '\\textsuperscript{2}', '\u00B3': '\\textsuperscript{3}',
    '\u2009': '\\,', '\u202F': '\\,', '\u200B': '', '\uFEFF': '', '\u00AD': '\\-', '\uFFFD': '?',
    '\u2030': '\\textperthousand{}', '\u2116': 'No.',
  };
  var TEX_ACCENTS = {
    '\u0300': '`', '\u0301': "'", '\u0302': '^', '\u0303': '~', '\u0304': '=', '\u0306': 'u',
    '\u0307': '.', '\u0308': '"', '\u030A': 'r', '\u030B': 'H', '\u030C': 'v', '\u0327': 'c',
    '\u0328': 'k', '\u0323': 'd', '\u0331': 'b',
  };
  function uniToTex(c, template) {
    if (TEX_TEXT_CHARS.hasOwnProperty(c)) return TEX_TEXT_CHARS[c];
    if (TEX_MATH_CHARS[c]) return '\\ensuremath{' + TEX_MATH_CHARS[c] + '}';
    if (TEX_GREEK[c]) {
      return (template && template._textGreek) ? c : '\\ensuremath{\\' + TEX_GREEK[c] + '}';
    }
    var code = c.charCodeAt(0);
    if (code >= 0xE000 && code <= 0xF8FF) return c;          // our placeholders / markers
    var d = c.normalize ? c.normalize('NFD') : c;
    if (d.length === 2 && /[A-Za-z]/.test(d[0]) && TEX_ACCENTS[d[1]]) {
      var base = d[0] === 'i' ? '\\i' : d[0] === 'j' ? '\\j' : d[0];
      var acc = TEX_ACCENTS[d[1]];
      return /[a-z]/.test(acc) ? '\\' + acc + '{' + base + '}' : '{\\' + acc + base + '}';
    }
    return c;
  }

  function escapeTex(s) {
    if (!s) return '';
    return String(s)
      .replace(/\\/g, '\\textbackslash{}')
      .replace(/[#$%&_{}]/g, '\\$&')
      .replace(/~/g, '\\textasciitilde{}')
      .replace(/\^/g, '\\textasciicircum{}')
      /* V3.906 — titles, headings, author names, affiliations: non-ASCII
       * the TeX way too (an en dash in a title was dropped). */
      .replace(/\u00A0/g, '~')
      .replace(/[^\x00-\x7F]/g, function (c) { return uniToTex(c, null); });
  }

  /* ── V3.231 Template + addon composition ── */

  /* Deep-merge a template JSON with a per-paper overrides object so the
   * downstream renderers can read everything from a single "effective
   * template". Block-level attrs already in the Yjs doc still win at
   * blockToTex time (figureToTex falls back to template default only
   * when attrs.placement / attrs.width are missing); overrides change
   * those template defaults, not the per-block values. */
  function mergeTemplateWithOverrides(template, overrides) {
    if (!overrides) return template;
    var t = JSON.parse(JSON.stringify(template));   // shallow-safe clone
    /* Figure defaults */
    if (overrides.figure) {
      t.figure_environment = t.figure_environment || {};
      if (overrides.figure.placement)     t.figure_environment.placement     = overrides.figure.placement;
      if (overrides.figure.default_width) t.figure_environment.default_width = overrides.figure.default_width;
    }
    /* Table defaults */
    if (overrides.table) {
      t.table_environment = t.table_environment || {};
      if (typeof overrides.table.use_booktabs === 'boolean') {
        t.table_environment.use_booktabs = overrides.table.use_booktabs;
      }
      if (overrides.table.placement) t.table_environment.placement = overrides.table.placement;
    }
    /* Equation defaults */
    if (overrides.equation) {
      t.equation_environment = t.equation_environment || {};
      if (overrides.equation.display)      t.equation_environment.display      = overrides.equation.display;
      if (overrides.equation.inline_delim) t.equation_environment.inline_delim = overrides.equation.inline_delim;
    }
    return t;
  }

  /* Compose final preamble = template preamble + each enabled addon's
   * preamble snippet. `addonIds` is an array of registry ids; unknown
   * ids are dropped silently (already validated client-side). The
   * returned warnings list lets the caller surface
   * `requires_shell_escape` mismatches before triggering a compile. */
  /* V3.408 — document float-spacing preset → kernel \setlength block.
   * LaTeX float-separation lengths are DOCUMENT-GLOBAL (there is no
   * per-float form — the per-float lever is a \vspace inside the env,
   * R4's `spacing` attr). 'normal'/absent returns '' — the byte-identical
   * sentinel. Class defaults for reference: \textfloatsep 20pt,
   * \floatsep/\intextsep 12pt. */
  function buildFloatSpacingPreamble(preset, twoCol) {
    var P = {
      tight: { text: '10pt plus 2pt minus 2pt', sep: '8pt plus 2pt minus 2pt' },
      loose: { text: '28pt plus 4pt minus 2pt', sep: '18pt plus 2pt minus 2pt' },
    };
    var v = P[preset];
    if (!v) return '';
    var lines = [
      '',
      '% --- RM Layout Mode: float spacing (' + preset + ') ---',
      '\\setlength{\\textfloatsep}{' + v.text + '}',
      '\\setlength{\\floatsep}{' + v.sep + '}',
      '\\setlength{\\intextsep}{' + v.sep + '}',
    ];
    if (twoCol) {
      lines.push('\\setlength{\\dbltextfloatsep}{' + v.text + '}');
      lines.push('\\setlength{\\dblfloatsep}{' + v.sep + '}');
    }
    return lines.join('\n') + '\n';
  }

  /* V3.486 — body-text line density (grant "lines per inch"). Redefines
   * \normalsize to the density-derived font + leading via \@setfontsize
   * (the same primitive the document classes use), issued at
   * \begin{document}. Only \normalsize changes, so \section/\Large,
   * \small captions, and the title keep their class sizes — body text
   * only, per the request. `resolveBodyDensity` fixes the leading to hit
   * the lines-per-inch exactly and clamps just the font. Returns '' when
   * the feature is off (byte-identical). */
  function buildBodyDensityPreamble(opts) {
    if (!(window.PaperLayout && window.PaperLayout.resolveBodyDensity)) return '';
    var d = window.PaperLayout.resolveBodyDensity(opts);
    if (!d) return '';
    if (_layoutWarnings && d.warning) _layoutWarnings.push(d.warning);
    var f = d.fontPt, b = d.leadingPt;
    return [
      '',
      '% --- RM Layout Mode: body line density (' + d.lpi + ' lines/inch) ---',
      '\\makeatletter',
      '\\AtBeginDocument{\\renewcommand\\normalsize{\\@setfontsize\\normalsize{' + f + 'pt}{' + b + 'pt}}\\normalsize}',
      '\\makeatother',
    ].join('\n') + '\n';
  }

  function applyAddons(basePreamble, addonIds, templateId) {
    var preamble = basePreamble || '';
    var warnings = [];
    var enabled = new Set(addonIds || []);
    ADDON_REGISTRY.forEach(function (addon) {
      if (!enabled.has(addon.id)) return;
      var incompatTpl = (addon.incompatible_with && addon.incompatible_with.templates) || [];
      if (templateId && incompatTpl.indexOf(templateId) >= 0) {
        warnings.push('Add-on "' + addon.label + '" is marked incompatible with template "' + templateId + '"; preamble snippet still appended — disable if compile fails.');
      }
      var incompatAddons = (addon.incompatible_with && addon.incompatible_with.addons) || [];
      incompatAddons.forEach(function (otherId) {
        if (enabled.has(otherId)) {
          warnings.push('Add-on "' + addon.id + '" conflicts with "' + otherId + '"; results may be unexpected.');
        }
      });
      preamble += '\n% --- addon: ' + addon.id + ' ---\n' + addon.preamble;
    });
    return { preamble: preamble, warnings: warnings };
  }

  /* V3.907 — add-ons a published-look build ignores: manuscript
   * conventions, and layout the look itself decides. */
  var SUBMISSION_ONLY_ADDONS = ['lineno', 'setspace-double', 'endfloat', 'twocolumn', 'microtype'];

  /* ── End-to-end orchestrator ── */

  /** Build the paper bundle (no I/O — pure function over a Yjs doc).
   * opts: { paperId, templateId | template, overrides, addons, yDoc,
   *         citationByKey, fullItemsByKey, leadAuthor, titleOverride }
   * Returns: { files: [{relpath, content}], citationKeys, warnings,
   *            tree, mainTex, bibText, template }
   * Pass either `template` (already fetched) or `templateId` (will be
   * fetched via api.load). */
  async function buildBundle(opts) {
    var template = opts.template || await fetchTemplate(opts.templateId);
    /* V3.907 — journal look. A template with a `look` compiles the
     * journal's PUBLISHED page (fonts, columns, sizes, heading/caption
     * styles generated by PaperLook — the same numbers the Document view
     * lays out with) unless the paper is set to the submission manuscript
     * (paperExports.layoutLook = 'submission' → the template's own
     * preamble, unchanged). Manuscript-only add-ons (line numbers, double
     * spacing, figures-at-end) and layout add-ons the look owns
     * (twocolumn, microtype's protrusion — it moves line breaks the
     * preview predicts) belong to the submission build only. */
    var look = (window.PaperLook && window.PaperLook.resolve)
      ? window.PaperLook.resolve(template, { layoutLook: opts.layoutLook, lookOverrides: opts.lookOverrides }) : null;
    var baseTemplate = look ? window.PaperLook.applyToTemplate(template, look) : template;
    var effectiveTemplate = mergeTemplateWithOverrides(baseTemplate, look ? null : opts.overrides);
    var addonIds = look
      ? (opts.addons || []).filter(function (id) { return SUBMISSION_ONLY_ADDONS.indexOf(id) < 0; })
      : opts.addons;

    var addonResult = applyAddons(effectiveTemplate.preamble, addonIds, effectiveTemplate.id);
    effectiveTemplate.preamble = addonResult.preamble;

    /* V3.408 — document float-spacing preset (paperExports.floatSpacing):
     * a kernel \setlength block appended addon-style. 'normal'/absent
     * emits NOTHING (byte-identical for untouched papers); \dbl* lengths
     * only where a two-column class compiles (they're undefined in some
     * one-column classes). Raw \setlength, never \captionsetup — the ACS
     * template has no caption package. */
    var spacingBlock = buildFloatSpacingPreamble(
      opts.floatSpacing,
      (effectiveTemplate.figure_environment || {}).compiled_columns === 2);
    if (spacingBlock) effectiveTemplate.preamble += spacingBlock;

    /* V3.341 — the cleveref add-on switches every ref token to \cref{}
     * (and suppresses template.refs prefixes) via a flag on the
     * effective template that paragraphTextToTex reads. */
    if ((opts.addons || []).indexOf('cleveref') >= 0) {
      effectiveTemplate._use_cref = true;
    }

    /* V3.395 — build target ('submission' journal float specs, default;
     * 'preprint' arXiv/local — pinning honored). Stashed on the effective
     * template the same way as _use_cref so figureToTex/tableToTex can
     * hand it to PaperLayout.resolveFloat. */
    effectiveTemplate._buildTarget =
      (opts.buildTarget === 'preprint') ? 'preprint' : 'submission';

    /* Section-numbering mode ('auto' | 'on' | 'off'). Read by
     * resolveSectionCommand (force-number star sections) + subheadingToTex
     * (star decision). 'on'/'off' also append a secnumdepth block below. */
    effectiveTemplate._sectionNumbering =
      (['on', 'off'].indexOf(opts.sectionNumbering) >= 0) ? opts.sectionNumbering : 'auto';
    if (effectiveTemplate._sectionNumbering === 'on') {
      effectiveTemplate.preamble +=
        '\n% --- RM section numbering: forced on ---\n\\setcounter{secnumdepth}{3}\n';
    } else if (effectiveTemplate._sectionNumbering === 'off') {
      effectiveTemplate.preamble +=
        '\n% --- RM section numbering: off ---\n\\setcounter{secnumdepth}{-1}\n';
    }

    var tree = paperTreeFromYDoc(opts.yDoc);
    if (opts.titleOverride) tree.title = opts.titleOverride;
    /* S-α — subdoc builds pass a section filter (e.g. only the
     * cover_letter section); citations / figureAssets / the placeholder
     * stash all follow the filtered tree automatically. */
    if (typeof opts.sectionFilter === 'function') {
      tree.sections = tree.sections.filter(opts.sectionFilter);
    }

    /* V3.109 — make the equation library available to paragraphTextToTex
     * so it can resolve [!eqi:<id>] tokens. Module-level set/clear
     * around the section rendering keeps it scoped to this run. */
    _exportEqLibrary = tree.equation_library || [];
    _exportValueLibrary = tree.value_library || [];
    /* V3.341 — collector for placeholder sections. V3.413: a TOKEN MAP
     * — {{ABSTRACT}}/{{KEYWORDS}} always seeded (legacy behavior), plus
     * every placeholder token any special_sections catalog entry
     * declares, so an unused token substitutes to '' instead of leaking
     * a literal {{FOO}} into main.tex (the leftover-token sweep). */
    _placeholderStash = { tokens: { '{{ABSTRACT}}': '', '{{KEYWORDS}}': '' } };
    function seedToken(cmd) {
      if (cmd && typeof cmd === 'object' && cmd.token &&
          (cmd.type === 'placeholder' || cmd.type === 'keywords') &&
          !(cmd.token in _placeholderStash.tokens)) {
        _placeholderStash.tokens[cmd.token] = '';
      }
    }
    (effectiveTemplate.special_sections || []).forEach(function (e) { seedToken(e && e.command); });
    Object.keys(effectiveTemplate.section_kind_to_command || {}).forEach(function (k) {
      seedToken((effectiveTemplate.section_kind_to_command || {})[k]);
    });
    /* V3.395 — collector for layout-intent warnings. */
    _layoutWarnings = [];
    _usedCuted = false;    // V3.412 — spanning-equation flag
    _usedCallout = false;  // V3.413 — boxed-callout flag
    _usedMultirow = false; // Tables II — row-spanning merge flag
    _usedArray = false;    // Tables II — width+align colspec flag
    _usedLongtable = false;      // Tables II — multi-page table flag
    _usedThreeparttable = false; // Tables II — table-notes flag
    _usedColortbl = false;       // V3.651 — cell/row shading flag
    _usedWrapfig = false;        // V3.485 — wrapped-figure flag

    /* Render sections to per-file .tex */
    var sectionFiles = [];
    var inputLines = [];
    var stash;
    var layoutWarnings;
    var appendixEmitted = false;
    try {
      tree.sections.forEach(function (sec) {
        var content = sectionToTex(sec, effectiveTemplate);
        if (!content || content.trim() === '') return;
        var slug = slugForSection(sec, effectiveTemplate);
        sectionFiles.push({
          relpath: 'sections/' + slug + '.tex',
          content: content,
        });
        /* \appendix once, before the first appendix section — LaTeX then
         * numbers this and every later \section as A, B, C. */
        if (sec.appendix && !appendixEmitted) {
          inputLines.push('\\appendix');
          appendixEmitted = true;
        }
        inputLines.push('\\input{sections/' + slug + '}');
      });
      stash = _placeholderStash;
      layoutWarnings = _layoutWarnings;
      /* V3.412 — a spanning equation was rendered: cuted joins the
       * preamble now (the {{PREAMBLE}} substitution happens below, so
       * a flag raised during section rendering still lands). */
      if (_usedCuted) {
        effectiveTemplate.preamble +=
          '\n% --- RM Layout Mode: spanning equations ---\n\\usepackage{cuted}\n';
      }
      /* V3.413 — a boxed callout section was rendered: define rmcallout
       * (mdframed is stock TeX Live; a class that already loads it is
       * fine — no options are passed). */
      if (_usedCallout) {
        effectiveTemplate.preamble +=
          '\n% --- RM section styles: boxed callout ---\n' +
          '\\usepackage{mdframed}\n' +
          '\\newmdenv[backgroundcolor=black!4, linecolor=black!25, linewidth=0.6pt,' +
          ' innertopmargin=6pt, innerbottommargin=7pt, innerleftmargin=8pt,' +
          ' innerrightmargin=8pt, skipabove=8pt, skipbelow=8pt]{rmcalloutbox}\n' +
          '\\newenvironment{rmcallout}[1]{\\begin{rmcalloutbox}\\noindent\\textbf{#1}\\par\\smallskip}{\\end{rmcalloutbox}}\n';
      }
      /* Tables II — merged cells / width colspecs used somewhere: pull
       * in the packages on demand (both stock TeX Live). */
      if (_usedMultirow) {
        effectiveTemplate.preamble +=
          '\n% --- RM tables: merged cells ---\n\\usepackage{multirow}\n';
      }
      if (_usedArray) {
        effectiveTemplate.preamble +=
          '\n% --- RM tables: column widths ---\n\\usepackage{array}\n';
      }
      if (_usedLongtable) {
        effectiveTemplate.preamble +=
          '\n% --- RM tables: multi-page tables ---\n\\usepackage{longtable}\n';
      }
      if (_usedThreeparttable) {
        effectiveTemplate.preamble +=
          '\n% --- RM tables: table notes ---\n\\usepackage{threeparttable}\n';
      }
      /* V3.651 — cell/row shading. The `table` option is what pulls in
       * colortbl and gives us \cellcolor / \rowcolors; loading plain
       * xcolor would compile and then fail on the first \cellcolor. */
      if (_usedColortbl) {
        /* V3.906 — \PassOptionsToPackage BEFORE \documentclass, so the
         * `table` option reaches xcolor however the template or class
         * loads it. Appending \usepackage[table]{xcolor} clashed ("Option
         * clash for package xcolor") with every template that already
         * loads xcolor plainly — PLOS, Nature, mebp, preprints. */
        effectiveTemplate.preamble = '\\PassOptionsToPackage{table}{xcolor}\n' + effectiveTemplate.preamble +
          '\n% --- RM tables: cell and row shading ---\n\\usepackage{xcolor}\n';
      }
      /* V3.485 — a corner/side wrap figure was rendered: wrapfig joins the
       * preamble on demand (stock TeX Live; single-column classes only —
       * two-column wraps degrade to flow in resolveFloat, never flagged). */
      if (_usedWrapfig) {
        effectiveTemplate.preamble +=
          '\n% --- RM Layout Mode: wrapped figures ---\n\\usepackage{wrapfig}\n';
      }
      /* V3.915 — packages the paper's own LaTeX uses (siunitx units in
       * prose, booktabs rules and [H] in an imported table, \cref in an
       * imported caption), loaded when the preamble does not load them.
       * Loading a package again without options never clashes with a
       * class that loaded it first. */
      if (window.PaperProseTex) {
        var _ownTex = sectionFiles.map(function (f) { return f.content; }).join('\n') + '\n' +
          Object.keys((stash && stash.tokens) || {}).map(function (k) { return stash.tokens[k] || ''; }).join('\n');
        var _ownPkgs = window.PaperProseTex.packagesFor(_ownTex).filter(function (pkg) {
          return !(pkg === 'cleveref' && effectiveTemplate._use_cref) &&
            !window.PaperProseTex.preambleLoads(effectiveTemplate.preamble, pkg);
        });
        if (_ownPkgs.length) {
          effectiveTemplate.preamble += '\n% --- RM: packages the paper\'s own LaTeX uses ---\n' +
            _ownPkgs.map(function (p) { return '\\usepackage{' + p + '}\n'; }).join('');
        }
      }
      /* V3.486 — body line density (grant lines-per-inch). Injected here so
       * the clamp warning lands on _layoutWarnings (active now); '' when
       * off. */
      var densityBlock = buildBodyDensityPreamble({
        lpi: opts.bodyLpi, fontMin: opts.bodyFontMin, fontMax: opts.bodyFontMax,
      });
      // V3.913 — a look sets its own size and pitch (paperExports.lookOverrides)
      if (densityBlock && !effectiveTemplate._look) effectiveTemplate.preamble += densityBlock;
      /* ORCID — any author carrying an iD pulls in orcidlink (stock TeX
       * Live) for the icon link beside the name. Checked directly on the
       * authors config: renderAuthorBlock runs during the main.tex
       * substitution AFTER this preamble is finalized, so a render-time
       * flag would fire too late. */
      var _authorsForOrcid = (opts.authorsCfg && opts.authorsCfg.authors) || [];
      if (_authorsForOrcid.some(function (a) { return a && a.orcid; })) {
        effectiveTemplate.preamble +=
          '\n% --- RM authors: ORCID iDs ---\n\\usepackage{orcidlink}\n';
      }
    } finally {
      _exportEqLibrary = null;
      _exportValueLibrary = null;
      _placeholderStash = null;
      _layoutWarnings = null;
      _usedCuted = false;
      _usedCallout = false;
      _usedMultirow = false;
      _usedArray = false;
      _usedLongtable = false;
      _usedThreeparttable = false;
      _usedColortbl = false;
      _usedWrapfig = false;
    }

    /* Render main.tex from template. V3.341 — function-form replacement
     * values throughout: String.replace treats `$&`/`$'` in a plain
     * string value as substitution patterns, so a preamble containing
     * them (e.g. natbib's sort&compress is fine, but `$&` sequences in
     * custom preambles are not) would corrupt the output. */
    var leadAuthor = (opts.leadAuthor || 'Lead Author');
    var bibBasename = (effectiveTemplate.bib_filename || 'references').replace(/\.bib$/i, '');
    var preamble = effectiveTemplate.preamble || '\\documentclass{article}';
    var mainTpl = effectiveTemplate.main_template || '{{PREAMBLE}}\n\\begin{document}\n{{INPUTS}}\n\\bibliographystyle{plain}\n\\bibliography{{{BIB_BASENAME}}}\n\\end{document}\n';
    function sub(str, marker, value) {
      return str.replace(marker, function () { return value; });
    }
    var main = mainTpl;
    main = sub(main, '{{PREAMBLE}}', preamble);
    main = sub(main, '{{TITLE}}', escapeTex(tree.title || opts.paperId));
    main = sub(main, '{{LEAD_AUTHOR}}', escapeTex(leadAuthor));
    main = sub(main, '{{AUTHOR_BLOCK}}', renderAuthorBlock(effectiveTemplate, leadAuthor, opts.authorsCfg));
    /* V3.907 — a look's own front matter (title / authors / affiliations /
     * abstract / keywords in one box, spanning both columns). */
    if (effectiveTemplate._look) {
      var lk = effectiveTemplate._look;
      var la = window.PaperLook.texAuthors(lk, opts.authorsCfg, escapeTex, leadAuthor);
      main = sub(main, '{{AUTHORS}}', la.authors);
      main = sub(main, '{{AFFILIATIONS}}', la.affiliations);
      main = sub(main, '{{AFFILIATION_NOTES}}', la.notes);
      var kwText = stash.tokens['{{KEYWORDS}}'] || '';
      var kwLine = (kwText && lk.keywords && lk.keywords.show)
        ? '\\par\\vskip 4bp{\\fontsize{' + lk.keywords.size + 'bp}{' + lk.keywords.lead + 'bp}\\selectfont ' +
          (lk.keywords.label ? '\\textbf{' + escapeTex(lk.keywords.label) + '} ' : '') + kwText + '\\par}'
        : '';
      main = sub(main, '{{KEYWORDS_LINE}}', kwLine);
      main = sub(main, '{{ABSTRACT_COLUMN}}', '');
    }
    /* Graphical abstract (paperExports.graphicalAbstract) — EXPLICIT sub
     * (an image, so the text-stash sweep doesn't fit): templates carrying
     * the token (elsevier frontmatter) render the env; templates without
     * it just bundle the file (warning pushed below). */
    var ga = opts.graphicalAbstract && opts.graphicalAbstract.storage_path
      ? opts.graphicalAbstract : null;
    var gaBasename = ga ? String(ga.storage_path).split('/').pop() : '';
    if (main.indexOf('{{GRAPHICAL_ABSTRACT}}') >= 0) {
      main = sub(main, '{{GRAPHICAL_ABSTRACT}}', ga
        ? '\\begin{graphicalabstract}\n\\includegraphics[width=\\linewidth]{figures/' + gaBasename + '}\n\\end{graphicalabstract}'
        : '');
    } else if (ga && layoutWarnings) {
      layoutWarnings.push('Graphical abstract: this journal class has no in-PDF slot — the image is bundled as figures/' + gaBasename + ' for separate submission.');
    }
    /* V3.413 — one loop over the token map ({{ABSTRACT}}/{{KEYWORDS}} +
     * every catalog-declared placeholder token, all pre-seeded '') —
     * no literal {{FOO}} can survive into main.tex. */
    Object.keys(stash.tokens).forEach(function (tok) {
      main = sub(main, tok, stash.tokens[tok]);
    });
    /* V3.909 — a paper without keywords: no empty keywords environment
     * (IEEEtran printed a bare "Index Terms—"). */
    main = main.replace(/\\begin\{(IEEEkeywords|keywords?)\}\s*\\end\{\1\}\n?/g, '');
    main = sub(main, '{{INPUTS}}', inputLines.join('\n'));
    main = sub(main, '{{BIB_BASENAME}}', bibBasename);

    /* Bib */
    var keys = collectCitationKeys(tree,
      typeof opts.sectionFilter === 'function' ? null : _manuscriptExcludedKinds());
    var citeIndex = opts.fullItemsByKey || opts.citationByKey || {};
    var bibText = buildBibtex(keys, citeIndex);

    var files = [{ relpath: effectiveTemplate.main_file || 'main.tex', content: main }];
    sectionFiles.forEach(function (f) { files.push(f); });
    files.push({ relpath: bibBasename + '.bib', content: bibText });

    /* V3.341 — templates may ship journal .bst/.sty/.cls text files as
     * extra bundle entries (schema v2 `extra_files`). The Cloud Run
     * compile service writes every bundle file into the workdir, so an
     * embedded bibliography style compiles with zero service changes. */
    (effectiveTemplate.extra_files || []).forEach(function (f) {
      if (f && f.relpath && typeof f.content === 'string') {
        files.push({ relpath: f.relpath, content: f.content });
      }
    });

    /* V3.347 — figure assets for the compile service: every figure
     * block's Storage pointer, mapped to the figures/<basename> path
     * that figureToTex emitted in \includegraphics. The service
     * downloads each into the workdir before running Tectonic (the
     * fetch step was stubbed since V3.231 — journal PDFs compiled with
     * missing-figure boxes). Deduped by relpath. */
    var figureAssets = [];
    var seenAssets = Object.create(null);
    (tree.sections || []).forEach(function (sec) {
      (sec.children || []).forEach(function (b) {
        if (b.kind !== 'figure' || !b.attrs || !b.attrs.storage_path) return;
        var segs = String(b.attrs.storage_path).split('/');
        var rel = 'figures/' + segs[segs.length - 1];
        if (seenAssets[rel]) return;
        seenAssets[rel] = true;
        figureAssets.push({ relpath: rel, storagePath: String(b.attrs.storage_path) });
      });
    });
    /* Graphical abstract asset — downloaded by the compile service like
     * any figure (and lands in the .zip). */
    if (ga && !seenAssets['figures/' + gaBasename]) {
      seenAssets['figures/' + gaBasename] = true;
      figureAssets.push({ relpath: 'figures/' + gaBasename, storagePath: String(ga.storage_path) });
    }

    return {
      files: files,
      citationKeys: keys,
      warnings: addonResult.warnings.concat(layoutWarnings || []),
      figureAssets: figureAssets,
      tree: tree,
      mainTex: main,
      bibText: bibText,
      template: effectiveTemplate,
    };
  }

  /** Run a full export.
   * opts: { paperId, repoPath, templateId, outputMode, yDoc, citationByKey, fullItemsByKey }
   * Returns: { ok, files_written: [...], target_dir, bib_written }
   */
  async function runExport(opts) {
    var bundle = await buildBundle(opts);

    /* POST to server.py */
    var resp = await fetch('/api/paper/export-tex', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        paper_id: opts.paperId,
        repo_path: opts.repoPath,
        output_mode: opts.outputMode || 'preview',
        files: bundle.files,
      }),
    });
    if (!resp.ok) {
      var t = await resp.text();
      throw new Error('Export failed: ' + resp.status + ' — ' + t);
    }
    var result = await resp.json();
    result.citationKeys = bundle.citationKeys;
    result.tree = bundle.tree;
    return result;
  }

  async function fetchTemplate(id) {
    /* V3.341 — templates are static files in this repo at
     * rm/data/paper-templates/<id>.json, FTP-deployed with the site (the
     * old api.load path had no api-routes entry, so it fell through to
     * the dev-only legacy fetch and 404'd in production). The legacy
     * api.load path is kept as a fallback for sibling-repo dev JSON. */
    if (!/^[\w-]+$/.test(String(id || ''))) {
      throw new Error('Invalid template id: ' + id);
    }
    try {
      var resp = await fetch('/rm/data/paper-templates/' + id + '.json', { cache: 'no-cache' });
      if (resp.ok) {
        var json = await resp.json();
        if (json && json.id) return json;
      }
    } catch (e) {
      /* fall through to the legacy dev path */
    }
    if (typeof api === 'undefined' || !api.load) {
      throw new Error('Template not found: ' + id);
    }
    var data = await api.load('paper-templates/' + id + '.json');
    if (!data || (Array.isArray(data) && !data.length) || (typeof data === 'object' && !Object.keys(data).length)) {
      throw new Error('Template not found: ' + id);
    }
    return data;
  }

  function slugForSection(sec, template) {
    // Prefer the kind for canonical slugs; if multiple sections share the
    // kind (e.g. MEBP has methods × 3), suffix with the section id.
    if (sec._slug) return sec._slug;
    return (sec.kind || 'section') + '-' + sec.id.replace(/^sec-/, '');
  }
})();
