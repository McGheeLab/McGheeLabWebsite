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
    ADDON_REGISTRY: ADDON_REGISTRY,
    /* Exposed for the test doc + future-phase Phase E .md generator. */
    paperTreeFromYDoc: paperTreeFromYDoc,
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
      id: 'twocolumn',
      label: 'Two-column body',
      preamble: '% twocolumn handled at \\documentclass via build-time class options\n',
      requires_shell_escape: false,
      incompatible_with: { templates: ['ieeetran'], addons: [] },
      notes: 'IEEEtran is already two-column — leave off there.',
    },
  ];

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
    if (!sections) return tree;
    sections.forEach(function (secMap) {
      var labelY = secMap.get('label');
      var sec = {
        id: secMap.get('id'),
        kind: secMap.get('kind'),
        label: (labelY && labelY.toString) ? labelY.toString() : String(labelY || ''),
        order: secMap.get('order') || 0,
        status: secMap.get('status') || 'draft',
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

  function sectionToTex(sec, template) {
    var cmd = (template.section_kind_to_command || {})[sec.kind] || 'section';
    if (cmd === 'skip') return '';

    var label = sec.label || (template.default_section_label || {})[sec.kind] || '';
    var inner = (sec.children || []).map(function (b) {
      return blockToTex(b, template);
    }).filter(Boolean).join('\n\n');

    if (cmd === 'abstract_env') {
      // SLAS-style: \begin{abstract}<text>\end{abstract} (no \section header).
      return '\\begin{abstract}\n' + inner + '\n\\end{abstract}\n';
    }
    var head;
    if (cmd === 'section_star') head = '\\section*{' + escapeTex(label) + '}';
    else                        head = '\\section{' + escapeTex(label) + '}';
    return head + '\n\n' + inner + '\n';
  }

  function blockToTex(block, template) {
    switch (block.kind) {
      case 'paragraph': return paragraphToTex(block);
      case 'equation':  return equationToTex(block, template);
      case 'figure':    return figureToTex(block, template);
      case 'table':     return tableToTex(block, template);
      case 'list':      return listToTex(block);
      default:          return '% [unsupported block kind: ' + escapeTex(block.kind) + ']';
    }
  }

  function paragraphToTex(block) {
    return prefixSkeletonComment(block) + paragraphTextToTex(block.body || '');
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

  function paragraphTextToTex(text) {
    if (!text) return '';
    var out = text;

    /* V3.109 — resolve [!eqi:<id>] inline equation references against
     * the paper's equation library, emitting `\(<latex>\)`. Unknown
     * ids fall back to a clearly-broken comment so the .tex still
     * compiles instead of failing silently. Resolved early so the
     * inserted LaTeX doesn't trip the markdown patterns below (e.g. an
     * inline equation containing `*` would otherwise match as italic). */
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
        return '% [missing inline equation: ' + id + ']';
      }
      return '\\(' + entry.latex + '\\)';
    });

    /* V3.109 — [!eqr:<label>] references emit \eqref{<label>}; the
     * numbered display block this label belongs to provides the actual
     * \label{} command in equationToTex. */
    out = out.replace(/\[!eqr:([\w:.\-]+)\]/g, function (_m, label) {
      return '\\eqref{' + label + '}';
    });

    /* V3.115 — figure references. Three shapes:
     *   [!fig:label]              → \ref{label}
     *   [!fig:label:A]            → \ref{label}\,(A)
     *   [!fig:label:A-B]          → \ref{label}\,(A--B)   (en-dash for ranges)
     * The figure block itself emits \label{...} via figureToTex when
     * attrs.numbered is true. Single-letter ranges go through with a
     * LaTeX en-dash (`--`); multi-letter or non-letter ranges are kept
     * as-is so the user's intent isn't auto-mangled. */
    out = out.replace(/\[!fig:([\w:.\-]+?)(?::([\w]+(?:-[\w]+)?))?\]/g,
      function (_m, label, panel) {
        if (!panel) return '\\ref{' + label + '}';
        var renderedPanel = panel;
        if (/^\w-\w$/.test(panel)) {
          renderedPanel = panel.replace('-', '--');
        }
        return '\\ref{' + label + '}\\,(' + renderedPanel + ')';
      });

    /* V3.120 — table references. */
    out = out.replace(/\[!tab:([\w:.\-]+)\]/g, function (_m, label) {
      return '\\ref{' + label + '}';
    });

    // Code spans (V3.107) — protect content via a placeholder so later
    // markdown passes don't touch it. Reinsert at the end.
    var codePlaceholders = [];
    out = out.replace(/`([^`\n]+)`/g, function (_m, inner) {
      var idx = codePlaceholders.length;
      codePlaceholders.push(inner);
      return ' CODE' + idx + ' ';
    });

    // Bold (must come before italic — `**foo**` would otherwise match as
    // two adjacent italics).
    out = out.replace(/\*\*([^*\n]+)\*\*/g, '\\textbf{$1}');
    // Italic.
    out = out.replace(/\*([^*\n]+)\*/g, '\\emph{$1}');
    // Subscript (V3.107).
    out = out.replace(/~([^~\n]+)~/g, '\\textsubscript{$1}');
    // Superscript (V3.107).
    out = out.replace(/\^([^\^\n]+)\^/g, '\\textsuperscript{$1}');

    // Citations: [@k1; @k2] → \cite{k1,k2}
    out = out.replace(/\[@([^\]]+)\]/g, function (_m, inner) {
      var keys = inner.split(/\s*;\s*@?/).map(function (s) { return s.trim(); }).filter(Boolean);
      if (!keys.length) return _m;
      return '\\cite{' + keys.join(',') + '}';
    });

    // Reinsert code spans now that all the markdown passes are done.
    out = out.replace(/ CODE(\d+) /g, function (_m, idx) {
      var inner = codePlaceholders[Number(idx)] || '';
      return '\\texttt{' + inner + '}';
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
    if (numbered) {
      var label = attrs.label || ('eq:' + block.id);
      return '\\begin{' + env + '}\n' +
             src + '\n' +
             '\\label{' + label + '}\n' +
             '\\end{' + env + '}';
    }
    return '\\[' + src + '\\]';
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
    var caption = paragraphTextToTex(captionRaw);

    /* V3.115 — only emit \label and \caption (with the \figurename
     * counter increment) when attrs.numbered isn't false. An unnumbered
     * figure becomes a captionless float so [!fig:label] references
     * still resolve nothing — and the writer sees the [?Fig.] chip. */
    var numbered = (attrs.numbered !== false);

    var lines = ['\\begin{' + env + '}[' + place + ']'];
    if (centering) lines.push('  \\centering');
    lines.push('  \\includegraphics[width=' + width + ']{' + src + '}');
    if (numbered) {
      lines.push('  \\caption{' + caption + '}');
      lines.push('  \\label{' + label + '}');
    } else if (caption) {
      // Unnumbered: use \caption*{} (caption package) — caption text
      // appears, no number, no entry in \listoffigures.
      lines.push('  \\caption*{' + caption + '}');
    }
    lines.push('\\end{' + env + '}');
    return lines.join('\n');
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

      var lines = [];
      lines.push('\\begin{' + env + '}[' + place + ']');
      lines.push('  \\centering');
      lines.push('  \\begin{tabular}{' + alignStr + '}');
      if (booktabs) lines.push('    \\toprule');
      for (var r = 0; r < rows; r++) {
        var rowCells = [];
        for (var c = 0; c < cols; c++) {
          var cell = cells[r + '-' + c];
          // cell may be a Y.Text (toString needed) or a plain string from
          // paperTreeFromYDoc; normalize.
          if (cell && typeof cell.toString === 'function' && cell !== cell.toString) {
            cell = cell.toString();
          }
          rowCells.push(escapeTex(cell || ''));
        }
        lines.push('    ' + rowCells.join(' & ') + ' \\\\');
        if (r === 0 && booktabs && headerRow) lines.push('    \\midrule');
      }
      if (booktabs) lines.push('    \\bottomrule');
      lines.push('  \\end{tabular}');

      /* V3.120 — caption may be a Y.Text (live mode) or a string
       * (extracted projection). Route through paragraphTextToTex so
       * cite + math + markdown tokens render correctly in the caption. */
      var captionRaw = '';
      if (attrs.caption != null) {
        captionRaw = (attrs.caption.toString && attrs.caption !== attrs.caption.toString)
          ? attrs.caption.toString()
          : String(attrs.caption);
      }
      var captionTex = paragraphTextToTex(captionRaw);
      if (numbered) {
        if (captionTex) lines.push('  \\caption{' + captionTex + '}');
        lines.push('  \\label{' + label + '}');
      } else if (captionTex) {
        // Unnumbered: \caption*{} (caption package), no \label
        lines.push('  \\caption*{' + captionTex + '}');
      }
      lines.push('\\end{' + env + '}');
      return lines.join('\n');
    }
    // Imported tables fall back to raw_tex.
    if (attrs.raw_tex) return attrs.raw_tex;
    return '% [table block ' + block.id + ' — populate via the grid editor when available]';
  }

  function listToTex(block) {
    if (block.attrs && block.attrs.raw_tex) return block.attrs.raw_tex;
    return '% [list block ' + block.id + ' — TODO]';
  }

  /* ── Citation collection + BibTeX ── */

  function collectCitationKeys(tree) {
    var seen = Object.create(null);
    var keys = [];
    function scan(text) {
      if (!text) return;
      var re = /\[@([^\]]+)\]/g;
      var m;
      while ((m = re.exec(text))) {
        m[1].split(/\s*;\s*@?/).forEach(function (k) {
          k = k.trim();
          if (k && !seen[k]) { seen[k] = true; keys.push(k); }
        });
      }
    }
    (tree.sections || []).forEach(function (sec) {
      (sec.children || []).forEach(function (b) {
        // Paragraphs and figure captions both render via the paragraph
        // contract, so both can carry [@cite] tokens.
        if (b.kind === 'paragraph' || b.kind === 'figure') scan(b.body || '');
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
    if (year)    fields.push('  year      = {' + year + '}');
    if (volume)  fields.push('  volume    = {' + volume + '}');
    if (issue)   fields.push('  number    = {' + issue + '}');
    if (pages)   fields.push('  pages     = {' + pages + '}');
    if (doi)     fields.push('  doi       = {' + doi + '}');
    if (url && !doi) fields.push('  url       = {' + url + '}');
    var type = (lib.arxiv_id && !lib.doi) ? 'misc' : 'article';
    return '@' + type + '{' + key + ',\n' + fields.join(',\n') + '\n}\n';
  }

  function bibEscape(s) {
    return String(s || '')
      .replace(/[{}\\]/g, function (c) { return '\\' + c; });
  }

  /* ── Tex escape (for plain text → LaTeX) ── */

  function escapeTex(s) {
    if (!s) return '';
    return String(s)
      .replace(/\\/g, '\\textbackslash{}')
      .replace(/[#$%&_{}]/g, '\\$&')
      .replace(/~/g, '\\textasciitilde{}')
      .replace(/\^/g, '\\textasciicircum{}');
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
    var effectiveTemplate = mergeTemplateWithOverrides(template, opts.overrides);

    var addonResult = applyAddons(effectiveTemplate.preamble, opts.addons, effectiveTemplate.id);
    effectiveTemplate.preamble = addonResult.preamble;

    var tree = paperTreeFromYDoc(opts.yDoc);
    if (opts.titleOverride) tree.title = opts.titleOverride;

    /* V3.109 — make the equation library available to paragraphTextToTex
     * so it can resolve [!eqi:<id>] tokens. Module-level set/clear
     * around the section rendering keeps it scoped to this run. */
    _exportEqLibrary = tree.equation_library || [];

    /* Render sections to per-file .tex */
    var sectionFiles = [];
    var inputLines = [];
    try {
      tree.sections.forEach(function (sec) {
        var content = sectionToTex(sec, effectiveTemplate);
        if (!content || content.trim() === '') return;
        var slug = slugForSection(sec, effectiveTemplate);
        sectionFiles.push({
          relpath: 'sections/' + slug + '.tex',
          content: content,
        });
        inputLines.push('\\input{sections/' + slug + '}');
      });
    } finally {
      _exportEqLibrary = null;
    }

    /* Render main.tex from template */
    var leadAuthor = (opts.leadAuthor || 'Lead Author');
    var bibBasename = (effectiveTemplate.bib_filename || 'references').replace(/\.bib$/i, '');
    var preamble = effectiveTemplate.preamble || '\\documentclass{article}';
    var mainTpl = effectiveTemplate.main_template || '{{PREAMBLE}}\n\\begin{document}\n{{INPUTS}}\n\\bibliographystyle{plain}\n\\bibliography{{{BIB_BASENAME}}}\n\\end{document}\n';
    var main = mainTpl
      .replace('{{PREAMBLE}}', preamble)
      .replace('{{TITLE}}', escapeTex(tree.title || opts.paperId))
      .replace('{{LEAD_AUTHOR}}', escapeTex(leadAuthor))
      .replace('{{INPUTS}}', inputLines.join('\n'))
      .replace('{{BIB_BASENAME}}', bibBasename);

    /* Bib */
    var keys = collectCitationKeys(tree);
    var citeIndex = opts.fullItemsByKey || opts.citationByKey || {};
    var bibText = buildBibtex(keys, citeIndex);

    var files = [{ relpath: effectiveTemplate.main_file || 'main.tex', content: main }];
    sectionFiles.forEach(function (f) { files.push(f); });
    files.push({ relpath: bibBasename + '.bib', content: bibText });

    return {
      files: files,
      citationKeys: keys,
      warnings: addonResult.warnings,
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
    // Route through the adapter so this works on the deploy. Templates are
    // currently lab-shared on disk; if api.load returns an empty fallback
    // (no Firestore route) we re-throw with a clear error.
    if (typeof api === 'undefined' || !api.load) {
      throw new Error('api.load not available — cannot fetch template ' + id);
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
