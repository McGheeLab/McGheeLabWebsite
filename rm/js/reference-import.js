/* reference-import.js — parse a paper's references (BibTeX or a DOI list)
 * into lab-LIBRARY citation entries, then let the caller attach + cite them.
 *
 * The library already supports citation-only entries (no PDF) via
 * LIBRARY_METADATA.buildPaperItem(meta, null, null) — same shape the "Add by
 * DOI" button creates. The editor resolves [@key] by string-matching the
 * whole library and auto-generates the bibliography at compile, so all this
 * module has to do is (1) turn a references blob into well-keyed library
 * items, (2) persist them, (3) optionally map numeric [N] markers → [@key].
 *
 * Public API (window.REFERENCE_IMPORT):
 *   parseBibtex(raw)                       → unified metadata[]
 *   parseDoiList(raw)                      → [{ id, kind }]
 *   resolveDois(ids, {onProgress})         → Promise<unified metadata[]>  (order-preserving, partial-tolerant)
 *   dedupeAndKey(metas, existingItems)     → { entries, keyByOrder }
 *   newItems(result)                       → item[]  (the status:'new' library rows)
 *   commitToLibrary(items)                 → Promise<number>  (direct single-doc creates)
 *   rewriteNumericMarkers(text, keyByOrder)→ { text, replaced, unmapped }
 *   open({ mode, draftId, existingItems, onCommit })   → shared import dialog
 *
 * "unified metadata" = the LIBRARY_METADATA.lookup shape:
 *   { title, authors:[{family,given}], year, journal, journal_iso, issn,
 *     volume, issue, pages, doi, pmid, arxiv_id, abstract, url, source }
 */
(function () {
  'use strict';

  /* ── LaTeX / string helpers ── */
  function cleanLatex(s) {
    return String(s || '')
      .replace(/[{}]/g, '')
      .replace(/\\&/g, '&').replace(/\\%/g, '%').replace(/\\_/g, '_').replace(/\\#/g, '#')
      .replace(/\\'(?:\{?([a-zA-Z])\}?)/g, '$1').replace(/\\`(?:\{?([a-zA-Z])\}?)/g, '$1')
      .replace(/\\"(?:\{?([a-zA-Z])\}?)/g, '$1').replace(/\\~(?:\{?([a-zA-Z])\}?)/g, '$1')
      .replace(/\\[a-zA-Z]+/g, '')
      .replace(/\s+/g, ' ')
      .trim();
  }
  function normTitle(t) { return String(t || '').toLowerCase().replace(/[^a-z0-9]/g, ''); }

  // "Family, Given" or "Given Family" (BibTeX author token) → {family, given}.
  function parseAuthorToken(tok) {
    var t = cleanLatex(tok);
    if (!t) return null;
    if (t.indexOf(',') >= 0) {
      var parts = t.split(',');
      return { family: parts[0].trim(), given: (parts[1] || '').trim() };
    }
    var words = t.split(/\s+/);
    if (words.length === 1) return { family: words[0], given: '' };
    return { family: words[words.length - 1], given: words.slice(0, -1).join(' ') };
  }
  function parseAuthorsField(raw) {
    if (!raw) return [];
    return String(raw).split(/\s+and\s+/i).map(parseAuthorToken).filter(Boolean);
  }

  /* ── BibTeX → unified[] ── */
  function parseBibtex(raw) {
    var out = [];
    var re = /@(\w+)\s*\{\s*([^,\s]+)\s*,([^@]*)\}/g;   // entry: @type{key, body}
    var m;
    while ((m = re.exec(raw)) !== null) {
      var type = m[1].toLowerCase();
      if (type === 'comment' || type === 'string' || type === 'preamble') continue;
      var bibkey = (m[2] || '').trim();
      var body = m[3] || '';
      var f = {};
      var fr = /(\w+)\s*=\s*(?:\{((?:[^{}]|\{[^{}]*\})*)\}|"([^"]*)"|([^,}\s][^,}]*))/g;
      var fm;
      while ((fm = fr.exec(body)) !== null) {
        f[fm[1].toLowerCase()] = (fm[2] != null ? fm[2] : (fm[3] != null ? fm[3] : fm[4] || ''));
      }
      var doi = cleanLatex(f.doi || '').replace(/^https?:\/\/(dx\.)?doi\.org\//i, '');
      var arxiv = cleanLatex(f.eprint || f.archiveprefix ? (f.eprint || '') : '');
      out.push({
        title: cleanLatex(f.title || ''),
        authors: parseAuthorsField(f.author || ''),
        year: cleanLatex(f.year || '').slice(0, 4),
        journal: cleanLatex(f.journal || f.booktitle || ''),
        journal_iso: '',
        issn: cleanLatex(f.issn || ''),
        volume: cleanLatex(f.volume || ''),
        issue: cleanLatex(f.number || f.issue || ''),
        pages: cleanLatex(f.pages || '').replace(/--/g, '–'),
        doi: doi.toLowerCase(),
        pmid: cleanLatex(f.pmid || ''),
        arxiv_id: arxiv,
        abstract: cleanLatex(f.abstract || ''),
        url: cleanLatex(f.url || (doi ? 'https://doi.org/' + doi : '')),
        source: 'bibtex',
        _bibkey: bibkey,
      });
    }
    return out;
  }

  /* ── DOI / identifier list → [{id, kind}] ── */
  function parseDoiList(raw) {
    var out = [];
    String(raw || '').split(/\r?\n/).forEach(function (lineRaw) {
      var line = lineRaw.trim().replace(/^\[\d+\]\s*/, '').replace(/[.,;]\s*$/, '');
      if (!line) return;
      line = line.replace(/^(doi:|https?:\/\/(dx\.)?doi\.org\/)/i, '')
                 .replace(/^https?:\/\/arxiv\.org\/abs\//i, 'arxiv:');
      var kind, id = line;
      if (/^10\.\d{3,}/.test(line)) { kind = 'doi'; }
      else if (/^arxiv:/i.test(line) || /^\d{4}\.\d{4,5}(v\d+)?$/.test(line)) { kind = 'arxiv_id'; id = line.replace(/^arxiv:/i, ''); }
      else if (/^\d+$/.test(line)) { kind = 'pmid'; }
      else { kind = 'doi'; }   // best-effort
      out.push({ id: id, kind: kind });
    });
    return out;
  }

  /* ── Resolve identifiers via the existing CrossRef/PubMed/arXiv CF ──
   * Sequential + order-preserving. A failed lookup yields an in-order stub so
   * numeric [N] mapping never shifts. */
  function resolveDois(ids, opts) {
    opts = opts || {};
    var results = [];
    var i = 0;
    function next() {
      if (i >= ids.length) return Promise.resolve(results);
      var entry = ids[i];
      var params = {}; params[entry.kind] = entry.id;
      if (opts.onProgress) opts.onProgress(i + 1, ids.length, entry.id);
      return Promise.resolve(window.LIBRARY_METADATA.lookup(params))
        .then(function (meta) {
          if (!meta || meta.error) {
            results.push({ title: '(lookup failed: ' + entry.id + ')', authors: [], year: '',
              doi: entry.kind === 'doi' ? entry.id.toLowerCase() : '', pmid: entry.kind === 'pmid' ? entry.id : '',
              arxiv_id: entry.kind === 'arxiv_id' ? entry.id : '', source: 'doi', _error: (meta && meta.error) || 'not found' });
          } else {
            meta.source = meta.source || 'crossref';
            results.push(meta);
          }
        })
        .catch(function (e) {
          results.push({ title: '(lookup error: ' + entry.id + ')', authors: [], year: '',
            doi: entry.kind === 'doi' ? entry.id.toLowerCase() : '', source: 'doi', _error: (e && e.message) || String(e) });
        })
        .then(function () { i++; return next(); });
    }
    return next();
  }

  /* ── Dedupe + collision-safe keys ── */
  function dedupeAndKey(metas, existingItems) {
    var byDoi = {}, byArxiv = {}, byTitle = {}, usedKeys = {}, usedIds = {};
    (existingItems || []).forEach(function (it) {
      var lib = (it.meta && it.meta.library) || {};
      if (lib.doi) byDoi[String(lib.doi).toLowerCase()] = it;
      if (lib.arxiv_id) byArxiv[String(lib.arxiv_id).toLowerCase()] = it;
      var nt = normTitle(it.title); if (nt) byTitle[nt] = it;
      if (lib.citation_key) usedKeys[lib.citation_key] = true;
      if (it.id) usedIds[it.id] = true;
    });

    function uniq(base, used) {
      if (!used[base]) return base;
      var suffixes = 'abcdefghijklmnopqrstuvwxyz';
      for (var k = 0; k < suffixes.length; k++) { if (!used[base + suffixes[k]]) return base + suffixes[k]; }
      var n = 2; while (used[base + n]) n++; return base + n;
    }
    function uniqId(base, used) {
      if (!used[base]) return base;
      var n = 2; while (used[base + '-' + n]) n++; return base + '-' + n;
    }

    var entries = [], keyByOrder = [];
    (metas || []).forEach(function (meta) {
      var dup = null;
      if (meta.doi && byDoi[String(meta.doi).toLowerCase()]) dup = byDoi[String(meta.doi).toLowerCase()];
      else if (meta.arxiv_id && byArxiv[String(meta.arxiv_id).toLowerCase()]) dup = byArxiv[String(meta.arxiv_id).toLowerCase()];
      else { var nt = normTitle(meta.title); if (nt && nt.length >= 6 && byTitle[nt]) dup = byTitle[nt]; }

      if (dup) {
        var ek = (dup.meta && dup.meta.library && dup.meta.library.citation_key) || '';
        entries.push({ meta: meta, status: 'existing', existingId: dup.id, key: ek });
        keyByOrder.push(ek);
        return;
      }
      var item = window.LIBRARY_METADATA.buildPaperItem(meta, null, null);
      var key = uniq(item.meta.library.citation_key, usedKeys); usedKeys[key] = true;
      item.meta.library.citation_key = key;
      var id = uniqId(item.id, usedIds); usedIds[id] = true; item.id = id;
      // keep the batch's own DOI/title indexed so intra-batch dupes collapse too
      if (item.meta.library.doi) byDoi[item.meta.library.doi] = item;
      var it2 = normTitle(item.title); if (it2) byTitle[it2] = item;
      entries.push({ meta: meta, status: 'new', item: item, key: key });
      keyByOrder.push(key);
    });
    return { entries: entries, keyByOrder: keyByOrder };
  }

  function newItems(result) {
    return (result.entries || []).filter(function (e) { return e.status === 'new'; }).map(function (e) { return e.item; });
  }

  /* ── Persist new library items (direct single-doc creates) ── */
  function commitToLibrary(items) {
    var db = (window.firebridge && firebridge.db && firebridge.db())
      || (window.firebase && firebase.firestore && firebase.firestore());
    if (!db) return Promise.reject(new Error('Firestore unavailable'));
    var i = 0;
    function done() {
      // V3.493 — these are DIRECT single-doc writes (they bypass api.save), so
      // the stale-while-revalidate `items.json` route cache would not include
      // them. Consumers that read items.json (the export pre-flight's
      // `_loadFullCitations`, the editor's citation index, the library list)
      // would then report the freshly-imported citation keys as "missing".
      // Bust the cache so the next read is fresh.
      if (window.api && api.invalidate) {
        try { return Promise.resolve(api.invalidate('items.json')).then(function () { return items.length; }); }
        catch (e) { /* non-fatal */ }
      }
      return Promise.resolve(items.length);
    }
    function next() {
      if (i >= items.length) return done();
      var it = items[i++];
      return db.collection('items').doc(it.id).set(it).then(next);
    }
    return next();
  }

  /* ── Numeric [N] markers → [@key] ── */
  function rewriteNumericMarkers(text, keyByOrder) {
    var unmapped = [], replaced = 0;
    // Only bracket groups whose interior is digits / commas / dashes / spaces —
    // this structurally excludes [@key], [!sec:x], and prose.
    var out = String(text || '').replace(/\[(\s*\d[\d\s,–-]*)\]/g, function (whole, inner) {
      var nums = [];
      var ok = true;
      inner.split(',').forEach(function (part) {
        part = part.trim(); if (!part) return;
        var range = part.split(/\s*[–-]\s*/);
        if (range.length === 2 && /^\d+$/.test(range[0]) && /^\d+$/.test(range[1])) {
          var a = +range[0], b = +range[1];
          if (a > b) { ok = false; return; }
          for (var n = a; n <= b; n++) nums.push(n);
        } else if (/^\d+$/.test(part)) {
          nums.push(+part);
        } else { ok = false; }
      });
      if (!ok || !nums.length) { unmapped.push(whole); return whole; }
      var keys = [];
      for (var j = 0; j < nums.length; j++) {
        var key = keyByOrder[nums[j] - 1];
        if (!key) { unmapped.push(whole); return whole; }   // out of range / unresolved → leave verbatim
        keys.push(key);
      }
      replaced++;
      return '[' + keys.map(function (k) { return '@' + k; }).join('; ') + ']';
    });
    return { text: out, replaced: replaced, unmapped: unmapped };
  }

  window.REFERENCE_IMPORT = {
    parseBibtex: parseBibtex,
    parseDoiList: parseDoiList,
    resolveDois: resolveDois,
    dedupeAndKey: dedupeAndKey,
    newItems: newItems,
    commitToLibrary: commitToLibrary,
    rewriteNumericMarkers: rewriteNumericMarkers,
    _normTitle: normTitle,
  };

  /* ─────────────────────────── Shared dialog ─────────────────────────── */
  function el(tag, cls, html) {
    var e = document.createElement(tag);
    if (cls) e.className = cls;
    if (html != null) e.innerHTML = html;
    return e;
  }
  function esc(s) {
    return String(s == null ? '' : s).replace(/[&<>"]/g, function (c) {
      return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c];
    });
  }
  function authorLine(authors) {
    return (authors || []).slice(0, 3).map(function (a) { return [a.given, a.family].filter(Boolean).join(' '); })
      .join(', ') + ((authors || []).length > 3 ? ', et al.' : '');
  }

  function open(cfg) {
    cfg = cfg || {};
    var existing = cfg.existingItems || [];
    var back = el('div', 'ri-backdrop');
    var modal = el('div', 'ri-modal');
    modal.innerHTML =
      '<div class="ri-head"><span class="ri-title">Import references</span>' +
        '<button type="button" class="ri-x" aria-label="Close">✕</button></div>' +
      '<div class="ri-tabs"><button type="button" class="ri-tab ri-tab-active" data-tab="doi">DOI list</button>' +
        '<button type="button" class="ri-tab" data-tab="bib">BibTeX</button></div>' +
      '<div class="ri-body">' +
        '<div class="ri-pane" data-pane="doi">' +
          '<p class="ri-hint">One identifier per line — DOI, arXiv id, or PMID. Order is preserved (used for numeric-marker mapping).</p>' +
          '<textarea class="ri-ta" data-in="doi" rows="7" placeholder="10.1007/s11340-017-0337-4&#10;10.1016/j.softx.2022.101204"></textarea>' +
        '</div>' +
        '<div class="ri-pane ri-hidden" data-pane="bib">' +
          '<p class="ri-hint">Paste BibTeX or choose a .bib file.</p>' +
          '<input type="file" class="ri-file" accept=".bib,text/plain">' +
          '<textarea class="ri-ta" data-in="bib" rows="7" placeholder="@article{key, title={…}, author={…}, year={…}, doi={…}}"></textarea>' +
        '</div>' +
      '</div>' +
      '<div class="ri-actions"><span class="ri-status"></span>' +
        '<button type="button" class="ri-parse">Parse &amp; preview</button>' +
        '<button type="button" class="ri-commit" disabled>Add to library</button></div>' +
      '<div class="ri-preview"></div>';
    back.appendChild(modal);
    document.body.appendChild(back);

    var statusEl = modal.querySelector('.ri-status');
    var previewEl = modal.querySelector('.ri-preview');
    var commitBtn = modal.querySelector('.ri-commit');
    var parseBtn = modal.querySelector('.ri-parse');
    var lastResult = null;

    function close() { if (back.parentNode) back.parentNode.removeChild(back); }
    function setStatus(m) { statusEl.textContent = m || ''; }
    function activeTab() { var t = modal.querySelector('.ri-tab-active'); return t ? t.dataset.tab : 'doi'; }

    modal.querySelector('.ri-x').addEventListener('click', close);
    back.addEventListener('click', function (e) { if (e.target === back) close(); });
    modal.querySelectorAll('.ri-tab').forEach(function (tab) {
      tab.addEventListener('click', function () {
        modal.querySelectorAll('.ri-tab').forEach(function (t) { t.classList.remove('ri-tab-active'); });
        tab.classList.add('ri-tab-active');
        modal.querySelectorAll('.ri-pane').forEach(function (p) {
          p.classList.toggle('ri-hidden', p.dataset.pane !== tab.dataset.tab);
        });
      });
    });
    modal.querySelector('.ri-file').addEventListener('change', function (e) {
      var file = e.target.files && e.target.files[0]; if (!file) return;
      var r = new FileReader();
      r.onload = function () { modal.querySelector('[data-in="bib"]').value = r.result; };
      r.readAsText(file);
    });

    function renderPreview(result) {
      var rows = result.entries.map(function (en, i) {
        var m = en.meta;
        var badge = en.status === 'existing'
          ? '<span class="ri-badge ri-dup">in library</span>'
          : (m._error ? '<span class="ri-badge ri-err">lookup failed</span>' : '<span class="ri-badge ri-new">new</span>');
        return '<tr><td class="ri-num">' + (i + 1) + '</td>' +
          '<td><div class="ri-t">' + esc(m.title || '(untitled)') + '</div>' +
          '<div class="ri-a">' + esc(authorLine(m.authors)) + (m.year ? ' · ' + esc(m.year) : '') + '</div></td>' +
          '<td class="ri-k">' + esc(en.key || '—') + '</td><td>' + badge + '</td></tr>';
      }).join('');
      var nNew = result.entries.filter(function (e) { return e.status === 'new'; }).length;
      var nDup = result.entries.length - nNew;
      previewEl.innerHTML =
        '<table class="ri-tbl"><thead><tr><th>#</th><th>Reference</th><th>Key</th><th></th></tr></thead>' +
        '<tbody>' + rows + '</tbody></table>' +
        '<div class="ri-sum">' + nNew + ' new · ' + nDup + ' already in library</div>';
      commitBtn.disabled = nNew === 0;
      commitBtn.textContent = cfg.mode === 'editor'
        ? ('Add ' + nNew + ' + attach to paper')
        : ('Add ' + nNew + ' to library');
    }

    parseBtn.addEventListener('click', function () {
      var tab = activeTab();
      parseBtn.disabled = true;
      if (tab === 'bib') {
        var metas = parseBibtex(modal.querySelector('[data-in="bib"]').value);
        if (!metas.length) { setStatus('No BibTeX entries found.'); parseBtn.disabled = false; return; }
        lastResult = dedupeAndKey(metas, existing);
        setStatus(''); renderPreview(lastResult); parseBtn.disabled = false;
      } else {
        var ids = parseDoiList(modal.querySelector('[data-in="doi"]').value);
        if (!ids.length) { setStatus('No identifiers found.'); parseBtn.disabled = false; return; }
        setStatus('Looking up 0/' + ids.length + '…');
        resolveDois(ids, { onProgress: function (n, tot) { setStatus('Looking up ' + n + '/' + tot + '…'); } })
          .then(function (metas) {
            lastResult = dedupeAndKey(metas, existing);
            var failed = metas.filter(function (m) { return m._error; }).length;
            setStatus(failed ? (failed + ' lookup(s) failed — kept as stubs.') : '');
            renderPreview(lastResult); parseBtn.disabled = false;
          });
      }
    });

    commitBtn.addEventListener('click', function () {
      if (!lastResult) return;
      var items = newItems(lastResult);
      commitBtn.disabled = true; setStatus('Saving ' + items.length + ' to library…');
      commitToLibrary(items)
        .then(function () {
          setStatus('Done.');
          if (cfg.onCommit) cfg.onCommit({ builtItems: items, keyByOrder: lastResult.keyByOrder, entries: lastResult.entries, close: close });
          else close();
        })
        .catch(function (e) { setStatus('Save failed: ' + (e.message || e)); commitBtn.disabled = false; });
    });

    return { close: close };
  }
  window.REFERENCE_IMPORT.open = open;
})();
