/* paper-export-bundle.js — portable paper import/export (E1: export).
 *
 * Serializes a paper draft into a portable `<slug>.paperbundle.zip`:
 *   paper.json     authoritative round-trip manifest (tree + config + meta +
 *                  equation library + unplaced libraries + bibliography +
 *                  asset index)
 *   paper.md       human-readable prose (generated; not parsed on import v1)
 *   refs.bib       generated BibTeX (readability)
 *   comments.json  papers/{id}/comments (blockId-bound; ids preserved)
 *   assets/<hash>.<ext>   every referenced Storage image, by content hash
 *
 * The tree serializer mirrors paper-editor's `_snapshotYValue` `{__ytype}`
 * convention EXACTLY (not the exporter's lossy `extractAttrs`), because
 * `appendBlockFromTree` on the import side rehydrates those shapes — table
 * `cells` (Y.Map<Y.Text>), figure `subfigures` (Y.Array<Y.Map>), etc. must
 * round-trip as Y-types, which a flattened plain object would break.
 * Section + block ids are emitted so comments' `blockId` bindings survive.
 *
 * Runs on paper-export.html (JSZip + PAPER_FIGURES + the live Yjs
 * connection state.yConn all in scope). E2/E3 add the import + comment
 * restore that consume this bundle.
 *
 * Public API: window.PaperExportBundle.buildAndDownload(ctx) / serialize(yConn).
 */
(function () {
  'use strict';

  var BUNDLE_VERSION = 1;

  /* ── Faithful Y → snapshot (mirror of paper-editor _snapshotYValue) ── */
  function snapY(v, Y) {
    if (v == null) return v;
    if (typeof v === 'string' || typeof v === 'number' || typeof v === 'boolean') return v;
    if (Y && v instanceof Y.Text) return { __ytype: 'text', value: v.toString() };
    if (Y && v instanceof Y.Array) {
      var items = [];
      v.forEach(function (item) { items.push(snapY(item, Y)); });
      return { __ytype: 'array', items: items };
    }
    if (Y && v instanceof Y.Map) {
      var entries = {};
      v.forEach(function (val, key) { entries[key] = snapY(val, Y); });
      return { __ytype: 'map', entries: entries };
    }
    if (Array.isArray(v)) return v.slice();
    if (typeof v === 'object') return Object.assign({}, v);
    return v;
  }

  function snapAttrs(attrsY, Y) {
    var out = {};
    if (!attrsY) return out;
    if (typeof attrsY.forEach === 'function' && typeof attrsY.get === 'function') {
      attrsY.forEach(function (v, k) { out[k] = snapY(v, Y); });
    }
    return out;
  }

  function ytext(v) {
    if (v == null) return '';
    return (v.toString && typeof v.forEach !== 'function') ? v.toString() : String(v || '');
  }

  function snapBlock(b, Y) {
    var skItems = [];
    var sk = b.get('skeleton_items');
    if (sk && typeof sk.forEach === 'function') {
      sk.forEach(function (it) {
        if (!it || typeof it.get !== 'function') return;
        skItems.push({
          id: it.get('id') || '',
          depth: it.get('depth') || 0,
          text: ytext(it.get('text')),
          claim_id: it.get('claim_id') || null,
        });
      });
    }
    return {
      id: b.get('id'),
      kind: b.get('kind'),
      status: b.get('status') || 'draft',
      skeleton: ytext(b.get('skeleton')),
      skeleton_items: skItems,
      body: ytext(b.get('body')),
      attrs: snapAttrs(b.get('attrs'), Y),
    };
  }

  function snapSection(secMap, Y) {
    var children = [];
    var kids = secMap.get('children');
    if (kids && typeof kids.forEach === 'function') {
      kids.forEach(function (b) { children.push(snapBlock(b, Y)); });
    }
    var uf = secMap.get('uploaded_file');
    return {
      id: secMap.get('id'),
      kind: secMap.get('kind'),
      label: ytext(secMap.get('label')),
      order: secMap.get('order') || 0,
      status: secMap.get('status') || 'draft',
      style_overrides: secMap.get('style_overrides') || {},
      completed_at: secMap.get('completed_at') || null,
      completed_by: secMap.get('completed_by') || null,
      revision_by: secMap.get('revision_by') || null,
      revision_at: secMap.get('revision_at') || null,
      special: secMap.get('special') || null,
      special_render: secMap.get('special_render') || null,
      appendix: !!secMap.get('appendix'),
      ref_label: secMap.get('ref_label') || null,
      uploaded_file: (uf && typeof uf === 'object') ? uf : null,
      children: children,
    };
  }

  function snapLibrary(arrY, Y) {
    var out = [];
    if (arrY && typeof arrY.forEach === 'function') {
      arrY.forEach(function (b) { if (b && typeof b.get === 'function') out.push(snapBlock(b, Y)); });
    }
    return out;
  }

  /* Whole-paper faithful serialization. */
  function serialize(yConn) {
    var Y = yConn.Y;
    var paperMap = yConn.yDoc.getMap('paper');
    var meta = paperMap.get('meta');
    var sectionsY = paperMap.get('sections');
    var sections = [];
    if (sectionsY && typeof sectionsY.forEach === 'function') {
      sectionsY.forEach(function (s) { sections.push(snapSection(s, Y)); });
    }
    var eqLib = [];
    var lib = paperMap.get('equation_library');
    if (lib && typeof lib.forEach === 'function') {
      lib.forEach(function (e) {
        if (!e || typeof e.get !== 'function') return;
        eqLib.push({
          id: e.get('id') || '',
          name: ytext(e.get('name')),
          latex: ytext(e.get('latex')),
          type: e.get('type') || 'inline',
        });
      });
    }
    return {
      title: meta && meta.get('title') ? ytext(meta.get('title')) : '',
      sections: sections,
      equation_library: eqLib,
      figure_unplaced: snapLibrary(paperMap.get('figure_unplaced'), Y),
      table_unplaced: snapLibrary(paperMap.get('table_unplaced'), Y),
    };
  }

  /* ── Assets: gather every Storage pointer across the serialized paper ── */
  function collectAssetPaths(tree, config) {
    var seen = {};
    var out = [];
    function add(sp) {
      if (!sp || typeof sp !== 'string' || seen[sp]) return;
      seen[sp] = 1;
      var m = sp.match(/\/([^/]+)\.([a-z0-9]+)$/i);
      out.push({ storage_path: sp, hash: m ? m[1] : ('asset' + out.length), ext: m ? m[2] : 'bin' });
    }
    function scanAttrs(a) {
      if (!a) return;
      add(a.storage_path);
      // composed-figure panels_json is a JSON string of [{storage_path,...}]
      if (a.panels_json) {
        try { (JSON.parse(a.panels_json) || []).forEach(function (p) { add(p && p.storage_path); }); }
        catch (e) { /* ignore malformed */ }
      }
    }
    function scanBlocks(blocks) {
      (blocks || []).forEach(function (b) { if (b.attrs) scanAttrs(b.attrs); });
    }
    (tree.sections || []).forEach(function (s) {
      scanBlocks(s.children);
      if (s.uploaded_file && s.uploaded_file.storage_path) add(s.uploaded_file.storage_path);
    });
    scanBlocks(tree.figure_unplaced);
    scanBlocks(tree.table_unplaced);
    if (config && config.graphicalAbstract && config.graphicalAbstract.storage_path) {
      add(config.graphicalAbstract.storage_path);
    }
    return out;
  }

  function fetchAsset(a) {
    // Re-mint a fresh download URL (stored ones expire), then fetch bytes.
    var urlP = (window.PAPER_FIGURES && window.PAPER_FIGURES.downloadUrl)
      ? window.PAPER_FIGURES.downloadUrl(a.storage_path)
      : Promise.reject(new Error('no PAPER_FIGURES'));
    return Promise.resolve(urlP)
      .then(function (url) { return fetch(url); })
      .then(function (r) { if (!r.ok) throw new Error('fetch ' + r.status); return r.blob(); })
      .then(function (blob) { return { ok: true, blob: blob, a: a }; })
      .catch(function (e) { return { ok: false, err: (e && e.message) || String(e), a: a }; });
  }

  /* ── paper.md (readable companion) ── */
  function esc(s) { return String(s == null ? '' : s); }
  function assetRel(sp, assetMap) {
    var hit = assetMap[sp];
    return hit ? ('assets/' + hit.hash + '.' + hit.ext) : (sp || '');
  }
  function buildMarkdown(tree, manifest, assetMap) {
    var out = [];
    out.push('# ' + esc(tree.title || 'Untitled paper'));
    out.push('');
    (tree.sections || []).forEach(function (s) {
      out.push('## ' + esc(s.label || s.kind));
      out.push('');
      (s.children || []).forEach(function (b) {
        if (b.kind === 'subheading') {
          var lvl = (b.attrs && b.attrs.level === 3) ? '#### ' : '### ';
          out.push(lvl + esc(b.body)); out.push('');
        } else if (b.kind === 'figure') {
          var sp = b.attrs && b.attrs.storage_path;
          out.push('![' + esc(b.body).replace(/\n/g, ' ') + '](' + assetRel(sp, assetMap) + ')');
          out.push('');
        } else if (b.kind === 'equation') {
          out.push('$$' + esc(b.body) + '$$'); out.push('');
        } else if (b.kind === 'list') {
          var num = b.attrs && b.attrs.list_type === 'number';
          String(b.body || '').split('\n').forEach(function (line, i) {
            if (!line.trim()) return;
            out.push((num ? (i + 1) + '. ' : '- ') + esc(line.trim()));
          });
          out.push('');
        } else if (b.kind === 'table') {
          out.push('*(table — see paper.json for cell data)*'); out.push('');
        } else {
          out.push(esc(b.body)); out.push('');
        }
      });
      if (s.uploaded_file && s.uploaded_file.filename) {
        out.push('*(attached document: ' + esc(s.uploaded_file.filename) + ')*'); out.push('');
      }
    });
    var bib = manifest.bibliography || {};
    var keys = Object.keys(bib);
    if (keys.length) {
      out.push('## References Cited'); out.push('');
      keys.forEach(function (k, i) {
        var it = bib[k] || {};
        var auth = (it.authors || []).map(function (a) { return (a.family || '') + (a.given ? ' ' + a.given[0] + '.' : ''); }).join(', ');
        out.push((i + 1) + '. ' + esc(auth) + '. ' + esc(it.title || '') + '. *' + esc(it.journal || '') + '* ' + esc(it.year || '') + (it.doi ? '. https://doi.org/' + esc(it.doi) : '') + '  [@' + k + ']');
      });
      out.push('');
    }
    return out.join('\n');
  }

  /* ── Bibliography projection from the lab library ── */
  function buildBibliography(tree, fullCitationByKey) {
    var bib = {};
    if (!window.PaperExportTex || !window.PaperExportTex.collectCitationKeys) return bib;
    var keys = window.PaperExportTex.collectCitationKeys({ sections: tree.sections }, null) || [];
    keys.forEach(function (k) {
      var item = fullCitationByKey && fullCitationByKey[k];
      var lib = item && item.meta && item.meta.library;
      if (lib) {
        bib[k] = {
          citation_key: lib.citation_key || k,
          authors: lib.authors || [],
          year: lib.year || '', title: lib.title || '', journal: lib.journal || '',
          volume: lib.volume || '', issue: lib.issue || '', pages: lib.pages || '',
          doi: lib.doi || '', url: lib.url || '', arxiv_id: lib.arxiv_id || '',
        };
      } else {
        bib[k] = { citation_key: k, authors: [], year: '', title: '', journal: '', missing: true };
      }
    });
    return bib;
  }

  /* ── Comments read ── */
  function readComments(paperId) {
    var db = (typeof firebridge !== 'undefined' && firebridge.db) ? firebridge.db() : null;
    if (!db || !paperId) return Promise.resolve([]);
    return db.collection('papers').doc(paperId).collection('comments').orderBy('createdAt', 'asc').get()
      .then(function (snap) {
        return snap.docs.map(function (d) {
          var c = d.data() || {};
          function ms(t) { return t && t.toMillis ? t.toMillis() : (typeof t === 'number' ? t : null); }
          var out = { id: d.id, blockId: c.blockId || '', body: c.body || '',
            authorUid: c.authorUid || '', authorName: c.authorName || '',
            resolved: !!c.resolved, createdAt: ms(c.createdAt), modifiedAt: ms(c.modifiedAt) };
          if (typeof c.anchorStart === 'number') { out.anchorStart = c.anchorStart; out.anchorEnd = c.anchorEnd; out.anchorText = c.anchorText || ''; }
          return out;
        });
      })
      .catch(function (e) { console.warn('[export-bundle] comments read failed', e); return []; });
  }

  function slugify(s) {
    return String(s || 'paper').toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 60) || 'paper';
  }

  /* ── Orchestrator ── */
  function buildAndDownload(ctx, statusCb) {
    function say(m) { if (statusCb) statusCb(m); }
    if (typeof window.JSZip !== 'function') { alert('Zip library not loaded.'); return Promise.reject(); }
    var tree = serialize(ctx.yConn);
    var config = ctx.config || {};
    var meta = ctx.meta || {};
    var assets = collectAssetPaths(tree, config);
    var assetMap = {};
    assets.forEach(function (a) { assetMap[a.storage_path] = a; });

    var bibliography = buildBibliography(tree, ctx.fullCitationByKey);

    var manifest = {
      bundle_version: BUNDLE_VERSION,
      exported_at: new Date().toISOString(),
      paper: {
        title: tree.title || meta.title || '',
        paper_type: meta.paper_type || config.paperType || 'journal',
        grant_subtype: meta.grant_subtype || null,
        template_id: (config.templateId || meta.template_id || null),
        target_journal: meta.target_journal || '',
        repo_path: meta.repo_path || '', repo_org: meta.repo_org || '', notes: meta.notes || '',
      },
      config: config,
      tree: { meta: { title: tree.title }, sections: tree.sections },
      equation_library: tree.equation_library,
      figure_unplaced: tree.figure_unplaced,
      table_unplaced: tree.table_unplaced,
      bibliography: bibliography,
      assets: assets.map(function (a) { return { hash: a.hash, ext: a.ext, storage_path_original: a.storage_path, relpath: 'assets/' + a.hash + '.' + a.ext }; }),
    };

    say('Reading comments…');
    return readComments(ctx.paperId).then(function (comments) {
      manifest.comment_count = comments.length;
      say('Fetching ' + assets.length + ' image asset' + (assets.length === 1 ? '' : 's') + '…');
      return Promise.all(assets.map(fetchAsset)).then(function (results) {
        var zip = new window.JSZip();
        zip.file('paper.json', JSON.stringify(manifest, null, 1));
        zip.file('paper.md', buildMarkdown(tree, manifest, assetMap));
        zip.file('comments.json', JSON.stringify(comments, null, 1));
        // refs.bib (best-effort via the exporter's bibtex builder)
        try {
          if (window.PaperExportTex && window.PaperExportTex.buildBibtex) {
            var keys = window.PaperExportTex.collectCitationKeys({ sections: tree.sections }, null) || [];
            zip.file('refs.bib', window.PaperExportTex.buildBibtex(keys, ctx.fullCitationByKey || {}));
          }
        } catch (e) { /* bib optional */ }
        var okCount = 0, failed = [];
        results.forEach(function (r) {
          if (r.ok) { zip.file('assets/' + r.a.hash + '.' + r.a.ext, r.blob); okCount++; }
          else failed.push(r.a.storage_path + ' (' + r.err + ')');
        });
        if (failed.length) manifest.asset_failures = failed;
        // re-write paper.json if failures were appended
        if (failed.length) zip.file('paper.json', JSON.stringify(manifest, null, 1));
        say('Zipping…');
        return zip.generateAsync({ type: 'blob' }).then(function (blob) {
          var name = slugify(tree.title || ctx.paperId) + '.paperbundle.zip';
          var url = URL.createObjectURL(blob);
          var a = document.createElement('a');
          a.href = url; a.download = name;
          document.body.appendChild(a); a.click(); a.remove();
          setTimeout(function () { URL.revokeObjectURL(url); }, 2000);
          say('Exported ' + name + ' — ' + okCount + '/' + assets.length + ' images, ' + comments.length + ' comments.');
          return { name: name, assets: okCount, assetsFailed: failed.length, comments: comments.length };
        });
      });
    });
  }

  window.PaperExportBundle = { buildAndDownload: buildAndDownload, serialize: serialize, BUNDLE_VERSION: BUNDLE_VERSION };
})();
