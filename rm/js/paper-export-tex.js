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
    runExport: runExport,
    /* Exposed for the test doc + future-phase Phase E .md generator. */
    paperTreeFromYDoc: paperTreeFromYDoc,
    sectionToTex: sectionToTex,
    blockToTex: blockToTex,
    paragraphTextToTex: paragraphTextToTex,
    collectCitationKeys: collectCitationKeys,
    buildBibtex: buildBibtex,
  };

  /* ── Tree extraction (Y.Map → plain JS) ── */

  function paperTreeFromYDoc(yDoc) {
    var paperMap = yDoc.getMap('paper');
    var meta = paperMap.get('meta');
    var titleY = meta && meta.get('title');
    var sections = paperMap.get('sections');
    var tree = {
      title: titleY ? titleY.toString() : '',
      sections: [],
    };
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
          sec.children.push({
            id: b.get('id'),
            kind: b.get('kind'),
            status: b.get('status') || 'draft',
            skeleton: yTextToString(skY),
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
    return paragraphTextToTex(block.body || '');
  }

  /* Text-level transforms inside a paragraph: Pandoc cite, bold/italic. */
  function paragraphTextToTex(text) {
    if (!text) return '';
    // Citations: [@k1; @k2] → \cite{k1,k2}
    var out = text.replace(/\[@([^\]]+)\]/g, function (_m, inner) {
      var keys = inner.split(/\s*;\s*@?/).map(function (s) { return s.trim(); }).filter(Boolean);
      if (!keys.length) return _m;
      return '\\cite{' + keys.join(',') + '}';
    });
    // Bold and emph (markdown-ish from importer)
    out = out.replace(/\*\*([^*\n]+)\*\*/g, '\\textbf{$1}');
    out = out.replace(/\*([^*\n]+)\*/g, '\\emph{$1}');
    return out;
  }

  function equationToTex(block, template) {
    var src = (block.body || '').trim();
    if (!src) {
      // Fall back to imported raw_tex if body is empty (legacy Phase A imports).
      if (block.attrs && block.attrs.raw_tex) return block.attrs.raw_tex;
      return '';
    }
    var displayMode = !!(block.attrs && block.attrs.display);
    var env = (template.equation_environment && template.equation_environment.display) || 'equation';
    var inlineDelim = (template.equation_environment && template.equation_environment.inline_delim) || '$';
    if (!displayMode) {
      return inlineDelim + src + inlineDelim;
    }
    return '\\begin{' + env + '}\n' +
           src + '\n' +
           '\\label{eq:' + block.id + '}\n' +
           '\\end{' + env + '}';
  }

  function figureToTex(block, template) {
    // Phase C imported figures keep the full \begin{figure}...\end{figure}
    // in attrs.raw_tex. We just emit that until the figure block kind is
    // properly editable.
    if (block.attrs && block.attrs.raw_tex) return block.attrs.raw_tex;
    var env = (template.figure_environment && template.figure_environment.env) || 'figure';
    var place = (template.figure_environment && template.figure_environment.placement) || 'H';
    var width = (template.figure_environment && template.figure_environment.default_width) || '0.9\\linewidth';
    var src = block.attrs && block.attrs.path ? block.attrs.path : 'figures/PLACEHOLDER.pdf';
    var caption = block.attrs && block.attrs.caption ? block.attrs.caption : '';
    return '\\begin{' + env + '}[' + place + ']\n' +
           '  \\centering\n' +
           '  \\includegraphics[width=' + width + ']{' + src + '}\n' +
           '  \\caption{' + escapeTex(caption) + '}\n' +
           '  \\label{fig:' + block.id + '}\n' +
           '\\end{' + env + '}';
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
      var booktabs = !!(template.table_environment && template.table_environment.use_booktabs);
      var colSpec = 'l'.repeat(cols).split('').join('');
      var lines = [];
      lines.push('\\begin{' + env + '}[' + place + ']');
      lines.push('  \\centering');
      lines.push('  \\begin{tabular}{' + colSpec + '}');
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
        if (r === 0 && booktabs) lines.push('    \\midrule');
      }
      if (booktabs) lines.push('    \\bottomrule');
      lines.push('  \\end{tabular}');
      var caption = attrs.caption ? (attrs.caption.toString ? attrs.caption.toString() : String(attrs.caption)) : '';
      if (caption) lines.push('  \\caption{' + escapeTex(caption) + '}');
      lines.push('  \\label{tab:' + block.id + '}');
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
    (tree.sections || []).forEach(function (sec) {
      (sec.children || []).forEach(function (b) {
        if (b.kind !== 'paragraph') return;
        var text = b.body || '';
        var re = /\[@([^\]]+)\]/g;
        var m;
        while ((m = re.exec(text))) {
          m[1].split(/\s*;\s*@?/).forEach(function (k) {
            k = k.trim();
            if (k && !seen[k]) { seen[k] = true; keys.push(k); }
          });
        }
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

  /* ── End-to-end orchestrator ── */

  /** Run a full export.
   * opts: { paperId, repoPath, templateId, outputMode, yDoc, citationByKey, fullItemsByKey }
   * Returns: { ok, files_written: [...], target_dir, bib_written }
   */
  async function runExport(opts) {
    var template = await fetchTemplate(opts.templateId);
    var tree = paperTreeFromYDoc(opts.yDoc);
    if (opts.titleOverride) tree.title = opts.titleOverride;

    /* Render sections to per-file .tex */
    var sectionFiles = [];
    var inputLines = [];
    tree.sections.forEach(function (sec) {
      var content = sectionToTex(sec, template);
      if (!content || content.trim() === '') return;
      var slug = slugForSection(sec, template);
      sectionFiles.push({
        relpath: 'sections/' + slug + '.tex',
        content: content,
      });
      inputLines.push('\\input{sections/' + slug + '}');
    });

    /* Render main.tex from template */
    var leadAuthor = (opts.leadAuthor || 'Lead Author');
    var bibBasename = (template.bib_filename || 'references').replace(/\.bib$/i, '');
    var preamble = template.preamble || '\\documentclass{article}';
    var mainTpl = template.main_template || '{{PREAMBLE}}\n\\begin{document}\n{{INPUTS}}\n\\bibliographystyle{plain}\n\\bibliography{{{BIB_BASENAME}}}\n\\end{document}\n';
    var main = mainTpl
      .replace('{{PREAMBLE}}', preamble)
      .replace('{{TITLE}}', escapeTex(tree.title || opts.paperId))
      .replace('{{LEAD_AUTHOR}}', escapeTex(leadAuthor))
      .replace('{{INPUTS}}', inputLines.join('\n'))
      .replace('{{BIB_BASENAME}}', bibBasename);

    /* Bib */
    var keys = collectCitationKeys(tree);
    // Augment citationByKey with full items.json rows, if provided
    var citeIndex = opts.fullItemsByKey || opts.citationByKey || {};
    var bibText = buildBibtex(keys, citeIndex);

    var files = [{ relpath: template.main_file || 'main.tex', content: main }];
    sectionFiles.forEach(function (f) { files.push(f); });
    files.push({ relpath: bibBasename + '.bib', content: bibText });

    /* POST to server.py */
    var resp = await fetch('/api/paper/export-tex', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        paper_id: opts.paperId,
        repo_path: opts.repoPath,
        output_mode: opts.outputMode || 'preview',
        files: files,
      }),
    });
    if (!resp.ok) {
      var t = await resp.text();
      throw new Error('Export failed: ' + resp.status + ' — ' + t);
    }
    var result = await resp.json();
    result.citationKeys = keys;
    result.tree = tree;
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
