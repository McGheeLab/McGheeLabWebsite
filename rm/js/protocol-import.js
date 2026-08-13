/* protocol-import.js — V3.139.
 *
 * Page-side importer for the protocol-import skill's JSON output.
 * Pipeline:
 *   1. Parse + validate JSON.
 *   2. Pre-flight: slug uniqueness, format version, structural sanity.
 *   3. For each figure with image_data_uri, decode → Blob, upload via
 *      PROTOCOL_FIGURES.uploadImage(id, blob); replace data URI with
 *      storage_path + image_url + hash + mime.
 *   4. Build the protocol doc via ProtocolSchemas.protocolEmptyDoc and
 *      write `protocols/{id}` to Firestore.
 *   5. Auto-snapshot v1 via PROTOCOL_VERSIONS.saveVersion labeled
 *      "Imported from <source.filename>".
 *   6. Return the new id so the list controller can navigate to
 *      `?protocol=<id>&match=1` (the &match=1 triggers the matcher
 *      modal once on first load).
 *
 * Also provides `openMatcher(protocolId)` — the always-available
 * "🔁 Match inventory" modal that walks unlinked materials rows + lets
 * the user accept / pick / skip inventory matches.
 *
 * Public surface: window.PROTOCOL_IMPORT.{ parseJson, validate,
 * summarize, createFromJson, openMatcher }.
 */

(function () {
  // V3.325 — kept in sync with ProtocolSchemas.PROTOCOL_BLOCK_KINDS /
  // CALLOUT_TYPES. Duplicated (not imported) because the importer runs
  // in list mode where protocol-schemas.js is loaded, but validate()
  // must not hard-depend on load order.
  var KNOWN_KINDS = [
    'materials', 'step', 'note', 'figure', 'safety', 'formula',
    'heading', 'callout', 'docHeader', 'table', 'kv', 'timeline',
    'calculator', 'builder', 'layoutMap',
    'design', // FuturePlan 06 — node-graph dataflow definition
    // Reserved: renders as an "unsupported" placeholder, not a step.
    // Listed here so it doesn't trip the mislabeled unknown-kind warning.
    'python',
  ];
  var CALLOUT_TYPES = ['critical', 'note', 'assume', 'timing'];

  function escapeHtml(s) {
    return String(s || '').replace(/[&<>"']/g, function (c) {
      return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c];
    });
  }

  /* ── Parse + validate ──────────────────────────────────────── */

  function parseJson(text) {
    try {
      var obj = JSON.parse(text);
      return { ok: true, parsed: obj, errors: [] };
    } catch (err) {
      return { ok: false, parsed: null, errors: ['JSON parse failed: ' + err.message] };
    }
  }

  /* Returns { ok, errors[], warnings[] }. */
  function validate(parsed) {
    var errors = [];
    var warnings = [];
    if (!parsed || typeof parsed !== 'object') {
      return { ok: false, errors: ['Top-level value is not an object.'], warnings: [] };
    }
    if (parsed.format !== 'protocol-import-v1') {
      errors.push('Missing or wrong `format` field. Expected "protocol-import-v1", got: ' + JSON.stringify(parsed.format));
    }
    var p = parsed.protocol;
    if (!p || typeof p !== 'object') {
      errors.push('Missing `protocol` object.');
      return { ok: errors.length === 0, errors: errors, warnings: warnings };
    }
    if (!p.title || typeof p.title !== 'string') errors.push('protocol.title is required.');
    if (!p.tree || typeof p.tree !== 'object') errors.push('protocol.tree is required.');
    var tree = p.tree || {};
    if (!Array.isArray(tree.sections)) {
      errors.push('protocol.tree.sections must be an array.');
    } else {
      tree.sections.forEach(function (sec, i) {
        if (!sec || typeof sec !== 'object') {
          errors.push('Section ' + i + ' is not an object.');
          return;
        }
        if (!sec.label) warnings.push('Section ' + i + ' has no label.');
        if (!Array.isArray(sec.children)) {
          errors.push('Section ' + i + ' children must be an array.');
          return;
        }
        sec.children.forEach(function (b, j) {
          if (!b || typeof b !== 'object') {
            errors.push('Section ' + i + ' block ' + j + ' is not an object.');
            return;
          }
          if (!b.kind) {
            errors.push('Section ' + i + ' block ' + j + ' missing `kind`.');
            return;
          }
          var where = 'section ' + i + ' block ' + j + ' (' + b.kind + ')';
          // Unknown kinds coerce to `step` on normalize — non-fatal, but
          // warn so a typo'd kind doesn't silently vanish.
          if (KNOWN_KINDS.indexOf(b.kind) < 0) {
            warnings.push('Unknown kind "' + b.kind + '" in ' + where +
              ' — it will import as a plain step.');
          }
          var a = b.attrs || {};
          if (b.kind === 'formula') {
            if (!a.expression) warnings.push('Formula in ' + where + ' has no expression.');
            if (!a.output || !a.output.name) errors.push('Formula in ' + where + ' missing output.name.');
            if (!Array.isArray(a.variables) || !a.variables.length) {
              warnings.push('Formula in ' + where + ' has no variables.');
            }
          } else if (b.kind === 'callout') {
            if (CALLOUT_TYPES.indexOf(a.type) < 0) {
              warnings.push('Callout in ' + where + ' has no/unknown attrs.type — will default to "note".');
            }
          } else if (b.kind === 'calculator') {
            var hasInputs = Array.isArray(a.inputs) && a.inputs.length;
            var hasOutputs = Array.isArray(a.outputs) && a.outputs.length;
            // a table-only calculator (a computed table over a named
            // dataset, no sliders/cards of its own) is legitimate
            var hasTable = a.table && a.table.dataset &&
              Array.isArray(a.table.columns) && a.table.columns.length;
            if (!hasInputs && !hasOutputs && !hasTable) {
              warnings.push('Calculator in ' + where + ' has no inputs, outputs, or table.');
            }
            (Array.isArray(a.outputs) ? a.outputs : []).forEach(function (o, oi) {
              if (!o || !o.name || !o.expr) {
                errors.push('Calculator output ' + oi + ' in ' + where + ' needs both name and expr.');
              }
            });
          } else if (b.kind === 'builder') {
            if (!a.dataset) warnings.push('Builder in ' + where + ' has no dataset name — downstream tables/maps can\'t find it.');
            if (!Array.isArray(a.dims) || !a.dims.length) {
              warnings.push('Builder in ' + where + ' has no dimensions.');
            }
          } else if (b.kind === 'layoutMap') {
            if (!a.dataset) warnings.push('Layout map in ' + where + ' has no dataset name.');
          } else if (b.kind === 'design') {
            if (!Array.isArray(a.nodes)) errors.push('Design in ' + where + ' needs an array `attrs.nodes`.');
            if (!Array.isArray(a.edges)) errors.push('Design in ' + where + ' needs an array `attrs.edges`.');
            // V3.380 — transparency: code nodes run JavaScript when the
            // protocol is viewed. Not an error (lab-authored trust model).
            if (Array.isArray(a.nodes) && a.nodes.some(function (nd) { return nd && nd.type === 'code'; })) {
              warnings.push('Design in ' + where + ' contains a script (code) node — its JavaScript runs when the protocol is viewed.');
            }
          }
        });
      });
    }
    return { ok: errors.length === 0, errors: errors, warnings: warnings };
  }

  function summarize(parsed) {
    var s = {
      sections: 0, steps: 0, materials: 0, notes: 0, safeties: 0,
      figures: 0, formulas: 0, images: 0,
      // V3.325 — new kinds.
      headings: 0, callouts: 0, docHeaders: 0, tables: 0, kvs: 0,
      timelines: 0, calculators: 0, builders: 0, layoutMaps: 0, designs: 0,
    };
    if (!parsed || !parsed.protocol || !parsed.protocol.tree) return s;
    var sections = parsed.protocol.tree.sections || [];
    s.sections = sections.length;
    sections.forEach(function (sec) {
      (sec.children || []).forEach(function (b) {
        switch (b.kind) {
          case 'step':       s.steps++; break;
          case 'materials':  s.materials++; break;
          case 'note':       s.notes++; break;
          case 'safety':     s.safeties++; break;
          case 'figure':
            s.figures++;
            if (b.attrs && b.attrs.image_data_uri && b.attrs.image_data_uri.indexOf('data:') === 0) s.images++;
            break;
          case 'formula':    s.formulas++; break;
          case 'heading':    s.headings++; break;
          case 'callout':    s.callouts++; break;
          case 'docHeader':  s.docHeaders++; break;
          case 'table':      s.tables++; break;
          case 'kv':         s.kvs++; break;
          case 'timeline':   s.timelines++; break;
          case 'calculator': s.calculators++; break;
          case 'builder':    s.builders++; break;
          case 'layoutMap':  s.layoutMaps++; break;
          case 'design':     s.designs++; break;
        }
      });
    });
    return s;
  }

  /* ── Image data URI → Blob ────────────────────────────────── */

  function _dataUriToBlob(dataUri) {
    var m = /^data:([^;,]+)(?:;[^,]*)?,(.*)$/.exec(dataUri || '');
    if (!m) throw new Error('Bad data URI');
    var mime = m[1];
    var payload = m[2];
    var isBase64 = /;base64/.test(dataUri.slice(0, dataUri.indexOf(',')));
    var bytes;
    if (isBase64) {
      var bin = atob(payload);
      bytes = new Uint8Array(bin.length);
      for (var i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
    } else {
      bytes = new TextEncoder().encode(decodeURIComponent(payload));
    }
    return new Blob([bytes], { type: mime });
  }

  /* Walk the tree; for each figure with image_data_uri, upload via
   * PROTOCOL_FIGURES, replace fields. Mutates `tree` in place. Calls
   * `onProgress(done, total, currentLabel)` per upload if provided. */
  async function _uploadFigureImages(protocolId, tree, onProgress) {
    var sections = (tree && tree.sections) || [];
    var pending = [];
    sections.forEach(function (sec) {
      (sec.children || []).forEach(function (b) {
        if (b.kind === 'figure' && b.attrs && b.attrs.image_data_uri
            && b.attrs.image_data_uri.indexOf('data:') === 0) {
          pending.push(b);
        }
      });
    });
    if (!pending.length) return;
    var done = 0;
    for (var i = 0; i < pending.length; i++) {
      var b = pending[i];
      var label = (b.body || '').slice(0, 40) || ('figure ' + (i + 1));
      if (typeof onProgress === 'function') onProgress(done, pending.length, label);
      try {
        var blob = _dataUriToBlob(b.attrs.image_data_uri);
        var res = await window.PROTOCOL_FIGURES.uploadImage(protocolId, blob);
        b.attrs.image_url    = res.download_url;
        b.attrs.storage_path = res.storage_path;
        b.attrs.hash         = res.hash;
        b.attrs.mime         = res.mime;
        delete b.attrs.image_data_uri;
      } catch (err) {
        console.warn('[protocol-import] image upload failed for figure', i, err);
        // Leave a broken figure with the data URI cleared; the user can
        // re-upload manually post-import via the V3.113 figure UI.
        delete b.attrs.image_data_uri;
        b.attrs.image_url    = '';
        b.attrs.storage_path = '';
        b.body = (b.body || '') + ' [image upload failed]';
      }
      done++;
    }
    if (typeof onProgress === 'function') onProgress(done, pending.length, '');
  }

  /* ── createFromJson ───────────────────────────────────────── */

  /* Returns Promise<{ id, autoMatch }>. `autoMatch` is true iff at
   * least one materials row landed with item_ref:null AND there's an
   * inventory list to match against — the caller should navigate to
   * `?protocol=<id>&match=1` to auto-open the matcher. */
  async function createFromJson(parsed, opts) {
    opts = opts || {};
    var onProgress = opts.onProgress || function () {};

    if (typeof firebridge === 'undefined' || !firebridge.getUser()) {
      throw new Error('You must be signed in to import a protocol.');
    }
    var user = firebridge.getUser();
    var profile = firebridge.getProfile && firebridge.getProfile();
    var displayName = (profile && profile.name) || user.displayName || user.email || user.uid;

    var v = validate(parsed);
    if (!v.ok) throw new Error('Invalid import file:\n' + v.errors.join('\n'));

    var src = parsed.protocol;
    var slug = (opts.slug || src.id || '').toLowerCase().trim();
    if (!slug) throw new Error('A slug is required (kebab-case).');
    if (!/^[a-z0-9][a-z0-9-]*$/.test(slug)) {
      throw new Error('Slug must be kebab-case (lowercase, digits, hyphens).');
    }

    onProgress({ stage: 'check-uniqueness' });
    var db = firebridge.db();
    var existing = await db.collection('protocols').doc(slug).get();
    if (existing.exists) {
      throw new Error('A protocol with id "' + slug + '" already exists. Pick a different slug.');
    }

    onProgress({ stage: 'upload-images', done: 0, total: 0 });
    // Deep-clone the tree so we don't mutate the caller's parsed object
    // (in case they want to reuse it).
    var tree = JSON.parse(JSON.stringify(src.tree || { meta: {}, sections: [] }));
    await _uploadFigureImages(slug, tree, function (done, total, label) {
      onProgress({ stage: 'upload-images', done: done, total: total, label: label });
    });

    // Coerce the imported tree through the schema normalizer so any
    // forward-version block kinds are coerced back to `step` and the
    // structure is well-formed.
    if (window.ProtocolSchemas && window.ProtocolSchemas.normalizeTree) {
      window.ProtocolSchemas.normalizeTree(tree);
    }

    onProgress({ stage: 'create-doc' });
    var doc = window.ProtocolSchemas.protocolEmptyDoc({
      id: slug,
      title: src.title,
      ownerUid: user.uid,
      author_uid: user.uid,
      author_name: displayName,
      summary: src.summary || '',
      category: src.category || '',
      tags: Array.isArray(src.tags) ? src.tags.slice() : [],
      tree: tree,
    });
    // V3.386 — caller-supplied root fields (e.g. the demo loader stamps
    // {is_demo, demo_of} so demo copies can be filtered + cleaned up).
    if (opts.extraFields && typeof opts.extraFields === 'object') {
      Object.keys(opts.extraFields).forEach(function (k) { doc[k] = opts.extraFields[k]; });
    }
    await db.collection('protocols').doc(slug).set(doc);

    onProgress({ stage: 'snapshot-v1' });
    if (window.PROTOCOL_VERSIONS) {
      try {
        var sourceLabel = (parsed.source && parsed.source.filename)
          || (parsed.source && parsed.source.kind)
          || 'import';
        await window.PROTOCOL_VERSIONS.saveVersion(slug, tree, {
          label: 'Imported from ' + sourceLabel,
          message: 'Auto-snapshot taken at import time. Source format: ' +
            ((parsed.source && parsed.source.kind) || 'unknown') + '.',
        });
      } catch (err) {
        // Non-fatal — the doc is created, snapshot just failed.
        console.warn('[protocol-import] auto-snapshot failed:', err && err.message);
      }
    }

    // Detect whether a matcher run is worth auto-opening.
    var autoMatch = _hasUnlinkedMaterials(tree);
    onProgress({ stage: 'done', id: slug, autoMatch: autoMatch });
    return { id: slug, autoMatch: autoMatch };
  }

  function _hasUnlinkedMaterials(tree) {
    var sections = (tree && tree.sections) || [];
    for (var i = 0; i < sections.length; i++) {
      var ch = sections[i].children || [];
      for (var j = 0; j < ch.length; j++) {
        if (ch[j].kind !== 'materials') continue;
        var rows = (ch[j].attrs && ch[j].attrs.rows) || [];
        for (var k = 0; k < rows.length; k++) {
          if (!rows[k].item_ref && (rows[k].free_text || '').trim()) return true;
        }
      }
    }
    return false;
  }

  /* ── openMatcher ──────────────────────────────────────────────
   * Walks the open editor's Y.Doc, finds materials rows with no
   * item_ref + non-empty free_text, calls
   * PROTOCOL_INVENTORY.findMatches for each, and shows a modal listing
   * candidates. On Apply, sets item_ref on each accepted row's Y.Map.
   *
   * The editor (protocol-editor.js) calls this; the editor's Y.Doc
   * is read via window.__PROTOCOL_EDITOR_STATE.yTree (exposed by
   * editor) so we don't need to pass it in. */

  function _ensureMatcherModal() {
    var existing = document.getElementById('pre-matcher-modal');
    if (existing) return existing;
    var modal = document.createElement('div');
    modal.id = 'pre-matcher-modal';
    modal.className = 'pb-modal pre-matcher-modal';
    modal.hidden = true;
    modal.innerHTML =
      '<div class="pb-modal-card pre-matcher-card">' +
        '<div class="pb-modal-header">' +
          '<h2>Match materials to lab inventory</h2>' +
          '<button class="pb-icon-btn" id="pre-matcher-close" aria-label="Close">×</button>' +
        '</div>' +
        '<div class="pb-modal-body pre-matcher-body">' +
          '<p class="pre-matcher-intro" id="pre-matcher-intro"></p>' +
          '<div class="pre-matcher-list" id="pre-matcher-list"></div>' +
        '</div>' +
        '<div class="pb-modal-actions">' +
          '<button class="btn" id="pre-matcher-cancel">Cancel</button>' +
          '<button class="btn btn-primary" id="pre-matcher-apply">Apply matches</button>' +
        '</div>' +
      '</div>';
    document.body.appendChild(modal);
    return modal;
  }

  /* Walk the Y tree and collect every materials row needing a match. */
  function _collectUnlinkedRows(yTree) {
    var rows = [];
    if (!yTree || typeof yTree.get !== 'function') return rows;
    var ySections = yTree.get('sections');
    if (!ySections || typeof ySections.toArray !== 'function') return rows;
    ySections.toArray().forEach(function (ySec, secIdx) {
      var yChildren = ySec.get('children');
      if (!yChildren) return;
      yChildren.toArray().forEach(function (yBlock, blkIdx) {
        if (yBlock.get('kind') !== 'materials') return;
        var attrs = yBlock.get('attrs');
        var yRows = attrs && attrs.get('rows');
        if (!yRows) return;
        yRows.toArray().forEach(function (yRow, rowIdx) {
          var item_ref = yRow.get('item_ref');
          var free_text = (yRow.get('free_text') || '').trim();
          if (item_ref) return;
          if (!free_text) return;
          rows.push({
            yRow: yRow,
            free_text: free_text,
            qty: yRow.get('qty') || '',
            unit: yRow.get('unit') || '',
            secIdx: secIdx,
            blkIdx: blkIdx,
            rowIdx: rowIdx,
          });
        });
      });
    });
    return rows;
  }

  async function openMatcher(protocolId) {
    if (!window.PROTOCOL_INVENTORY) {
      alert('Inventory module not loaded.');
      return;
    }
    var st = window.__PROTOCOL_EDITOR_STATE;
    if (!st || !st.yTree) {
      alert('Open a protocol first to match its materials.');
      return;
    }
    if (!st.canEdit) {
      alert('Read-only — only the protocol owner or an admin can apply matches.');
      return;
    }

    await window.PROTOCOL_INVENTORY.ensureList();
    var unlinked = _collectUnlinkedRows(st.yTree);

    var modal = _ensureMatcherModal();
    var introEl = modal.querySelector('#pre-matcher-intro');
    var listEl  = modal.querySelector('#pre-matcher-list');
    var closeBtn = modal.querySelector('#pre-matcher-close');
    var cancelBtn= modal.querySelector('#pre-matcher-cancel');
    var applyBtn = modal.querySelector('#pre-matcher-apply');

    if (!unlinked.length) {
      introEl.textContent = 'Every materials row in this protocol is already linked to your lab inventory. Nothing to match.';
      listEl.innerHTML = '';
      applyBtn.hidden = true;
    } else {
      introEl.innerHTML =
        escapeHtml(String(unlinked.length)) +
        ' materials row' + (unlinked.length === 1 ? '' : 's') +
        ' aren\'t linked to inventory yet. Pick a match for each — or Skip to leave free-text.';
      applyBtn.hidden = false;
    }

    // Each row is `{ row, picked: entry|null, candidates: [{entry, score, reasons}] }`.
    var picks = unlinked.map(function (row) {
      var matches = window.PROTOCOL_INVENTORY.findMatches(row.free_text, { limit: 4 });
      return {
        row: row,
        candidates: matches,
        picked: matches.length ? matches[0].entry : null,
        skipped: false,
      };
    });

    function renderList() {
      if (!picks.length) { listEl.innerHTML = ''; return; }
      listEl.innerHTML = '';
      picks.forEach(function (p, i) {
        var rowDiv = document.createElement('div');
        rowDiv.className = 'pre-matcher-row';
        if (p.skipped) rowDiv.classList.add('pre-matcher-skipped');
        if (!p.candidates.length) rowDiv.classList.add('pre-matcher-nomatch');

        var srcLabel = (p.row.qty || p.row.unit)
          ? (p.row.qty + ' ' + p.row.unit + ' · ' + p.row.free_text)
          : p.row.free_text;

        var best = p.picked;
        var bestHtml;
        if (p.skipped) {
          bestHtml = '<em>Skipped — leaving as free text.</em>';
        } else if (best) {
          bestHtml =
            '<span class="proto-inv proto-inv-computed">' +
              '🧪 ' + escapeHtml(window.PROTOCOL_INVENTORY.formatLabel(best)) +
            '</span> ' +
            (window.PROTOCOL_INVENTORY.formatStockChipHtml(best) || '');
        } else {
          bestHtml = '<em>No close match.</em>';
        }

        var actions =
          '<button class="btn pre-matcher-action" data-i="' + i + '" data-act="accept"' +
            (best && !p.skipped ? '' : ' disabled') + '>Accept</button>' +
          '<button class="btn pre-matcher-action" data-i="' + i + '" data-act="pick">Pick different…</button>' +
          '<button class="btn pre-matcher-action" data-i="' + i + '" data-act="skip"' +
            (p.skipped ? ' disabled' : '') + '>Skip</button>';

        var altsHtml = '';
        if (p.candidates.length > 1) {
          altsHtml = '<details class="pre-matcher-alts"><summary>Other candidates (' + (p.candidates.length - 1) + ')</summary>';
          p.candidates.slice(1).forEach(function (c, idx) {
            altsHtml +=
              '<div class="pre-matcher-alt"><span class="proto-inv">🧪 ' +
                escapeHtml(window.PROTOCOL_INVENTORY.formatLabel(c.entry)) +
              '</span> ' +
              (window.PROTOCOL_INVENTORY.formatStockChipHtml(c.entry) || '') +
              ' <button class="btn pre-matcher-altpick" data-i="' + i + '" data-cand="' + (idx + 1) + '">Choose</button></div>';
          });
          altsHtml += '</details>';
        }

        rowDiv.innerHTML =
          '<div class="pre-matcher-rowhead">' +
            '<span class="pre-matcher-rowidx">' + (i + 1) + '/' + picks.length + '</span>' +
            '<span class="pre-matcher-source">' + escapeHtml(srcLabel) + '</span>' +
          '</div>' +
          '<div class="pre-matcher-best">→ ' + bestHtml + '</div>' +
          '<div class="pre-matcher-actions">' + actions + '</div>' +
          altsHtml;

        listEl.appendChild(rowDiv);
      });
    }

    function onAction(e) {
      var t = e.target;
      if (!t || !t.dataset) return;
      var i = parseInt(t.dataset.i, 10);
      if (isNaN(i) || !picks[i]) return;
      var act = t.dataset.act;
      var p = picks[i];
      if (t.classList.contains('pre-matcher-altpick')) {
        var idx = parseInt(t.dataset.cand, 10);
        if (p.candidates[idx]) {
          p.picked = p.candidates[idx].entry;
          p.skipped = false;
          renderList();
        }
        return;
      }
      if (act === 'accept') {
        p.skipped = false; // already had `picked`; nothing to do
        return;
      }
      if (act === 'pick') {
        window.PROTOCOL_INVENTORY.openPicker({
          anchorEl: t,
          onPick: function (entry) {
            p.picked = entry;
            p.skipped = false;
            renderList();
          },
        });
        return;
      }
      if (act === 'skip') {
        p.skipped = true;
        renderList();
      }
    }
    listEl.addEventListener('click', onAction);

    function close() {
      modal.hidden = true;
      listEl.removeEventListener('click', onAction);
    }
    closeBtn.onclick = close;
    cancelBtn.onclick = close;
    modal.onclick = function (e) { if (e.target === modal) close(); };

    applyBtn.onclick = function () {
      var applied = 0;
      // All Y.Map sets in one transaction so the editor re-renders once.
      var Y = st.Y;
      var yDoc = st.yDoc;
      yDoc.transact(function () {
        picks.forEach(function (p) {
          if (p.skipped || !p.picked) return;
          var entry = p.picked;
          var label = window.PROTOCOL_INVENTORY.formatLabel(entry);
          p.row.yRow.set('item_ref', entry.id);
          // Also normalize free_text so an unlink later leaves a label.
          if (!p.row.yRow.get('free_text') || p.row.yRow.get('free_text') === p.row.free_text) {
            p.row.yRow.set('free_text', label);
          }
          applied++;
        });
      });
      if (typeof toast === 'function') {
        toast(applied
          ? ('Linked ' + applied + ' material' + (applied === 1 ? '' : 's') + ' to inventory')
          : 'No matches applied'
        );
      }
      // Mark editor dirty so the tree flush picks up.
      if (st.markDirty) st.markDirty();
      close();
    };

    renderList();
    modal.hidden = false;
  }

  window.PROTOCOL_IMPORT = {
    parseJson: parseJson,
    validate: validate,
    summarize: summarize,
    createFromJson: createFromJson,
    openMatcher: openMatcher,
  };
})();
