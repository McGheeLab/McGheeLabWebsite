/* paper-tree-build.js — self-contained bundle-tree → Yjs builder.
 *
 * The paper EDITOR owns the canonical builders (appendSectionFromTree /
 * appendBlockFromTree / _writeAttrValue in paper-editor.js). But the V3.490
 * import engine runs on the LIST page, off a headless PaperYjs connection,
 * where paper-editor.js is not loaded. Rather than refactor that large,
 * much-debugged file, this module re-implements the SAME builder contract as a
 * standalone, dependency-light unit (only window.PaperSchemas.shortId), so the
 * import engine can materialize a paper into a fresh Y.Doc without the editor.
 *
 * The two builders MUST stay behaviorally identical; `test-tree-build.js`
 * round-trips a bundle (PaperExportBundle.serialize shape → buildInto →
 * re-read) and asserts ids + deep `{__ytype}` attrs survive, matching
 * appendBlockFromTree's contract (paper-editor.js:476-522, :1738-1790).
 *
 * Public API (window.PaperTreeBuild):
 *   writeAttrValue(parent, key, snap, Y)
 *   appendBlock(childrenArr, blk, Y)   → Y.Map (also returns it)
 *   appendSection(sectionsArr, sec, Y) → Y.Map
 *   buildInto(paperMap, bundle, Y, opts) → { sectionsBuilt }
 *     opts.sectionFilter(sec) → bool (default: keep all)
 *     opts.replace (V3.742) → clear sections / equation_library /
 *       figure_unplaced / table_unplaced / value_library and reset the title
 *       BEFORE building, so a checked-out bundle updates a paper IN PLACE.
 *       Ordinary Y edits — no admin snapshot surgery needed. Only safe because
 *       the paper is locked while its bundle is out (no concurrent editors).
 *
 * V3.742 — round-trip fidelity: skeleton_items (paragraph outlines),
 * style_overrides and value_library were emitted by the exporter but dropped
 * here, which with `replace` would have silently deleted them on every
 * export→edit→import cycle. All three now rebuild.
 *
 * Callers MUST invoke buildInto inside a yDoc.transact (attach-then-mutate:
 * shared types must be integrated before nested shared types are set on them).
 */
(function () {
  'use strict';

  function shortId(prefix) {
    if (window.PaperSchemas && window.PaperSchemas.shortId) return window.PaperSchemas.shortId(prefix);
    return prefix + Math.random().toString(36).slice(2, 10);
  }

  /* Mirrors paper-editor.js `_writeAttrValue` (:1738-1790) exactly. */
  function writeAttrValue(parent, key, snap, Y) {
    if (snap == null) { parent.set(key, snap); return; }
    if (typeof snap === 'string' || typeof snap === 'number' || typeof snap === 'boolean') { parent.set(key, snap); return; }
    if (snap.__ytype === 'text') { parent.set(key, new Y.Text(snap.value || '')); return; }
    if (snap.__ytype === 'array') {
      parent.set(key, new Y.Array());
      var arr = parent.get(key);
      snap.items.forEach(function (item) {
        if (item && item.__ytype === 'map') {
          var m = new Y.Map(); arr.push([m]);
          Object.keys(item.entries).forEach(function (k) { writeAttrValue(m, k, item.entries[k], Y); });
        } else if (item && item.__ytype === 'array') {
          var inner = new Y.Array(); arr.push([inner]);
          item.items.forEach(function (it) {
            if (typeof it === 'string' || typeof it === 'number' || typeof it === 'boolean') inner.push([it]);
          });
        } else if (item && item.__ytype === 'text') {
          arr.push([new Y.Text(item.value || '')]);
        } else if (item != null && (typeof item === 'string' || typeof item === 'number' || typeof item === 'boolean')) {
          arr.push([item]);
        }
      });
      return;
    }
    if (snap.__ytype === 'map') {
      parent.set(key, new Y.Map());
      var m2 = parent.get(key);
      Object.keys(snap.entries).forEach(function (k) { writeAttrValue(m2, k, snap.entries[k], Y); });
      return;
    }
    parent.set(key, snap);   // plain object/array — store as-is
  }

  /* Mirrors paper-editor.js `appendBlockFromTree` (:476-522). */
  function appendBlock(childrenArr, blk, Y) {
    var m = new Y.Map();
    childrenArr.push([m]);
    m.set('id', blk.id || shortId('p-'));
    m.set('kind', blk.kind || 'paragraph');
    m.set('status', blk.status || 'draft');
    m.set('skeleton', new Y.Text(blk.skeleton ? String(blk.skeleton) : ''));
    m.set('body', new Y.Text(blk.body ? String(blk.body) : ''));
    m.set('attrs', new Y.Map());
    var attrs = m.get('attrs');
    if (blk.attrs && typeof blk.attrs === 'object') {
      Object.keys(blk.attrs).forEach(function (k) {
        var v = blk.attrs[k];
        if (v === null || typeof v === 'string' || typeof v === 'number' || typeof v === 'boolean') {
          attrs.set(k, v);
        } else if (v && v.__ytype) {
          writeAttrValue(attrs, k, v, Y);
        } else if (Array.isArray(v)) {
          writeAttrValue(attrs, k, {
            __ytype: 'array',
            items: v.map(function (item) {
              if (item && typeof item === 'object' && !Array.isArray(item)) {
                var entries = {};
                Object.keys(item).forEach(function (ik) {
                  var iv = item[ik];
                  if (iv === null || typeof iv === 'string' || typeof iv === 'number' || typeof iv === 'boolean') entries[ik] = iv;
                });
                return { __ytype: 'map', entries: entries };
              }
              return item;
            }),
          }, Y);
        } else {
          attrs.set(k, v);
        }
      });
    }
    writeSkeletonItems(m, blk.skeleton_items, Y);   // V3.742
    return m;
  }

  /* V3.742 — paragraph outline items. Bundle shape is the exporter's plain
   * array [{id, depth, text, claim_id}]; the live shape is Y.Array<Y.Map> with
   * `text` a Y.Text (paper-blocks.js ensureSkeletonItems). A `{__ytype:'array'}`
   * snapshot (editor move paths) is accepted too. Empty/missing → no key, so
   * the editor's lazy seeding from the legacy `skeleton` string still runs. */
  function writeSkeletonItems(m, items, Y) {
    if (!items) return;
    if (items.__ytype) { writeAttrValue(m, 'skeleton_items', items, Y); return; }
    if (!Array.isArray(items) || !items.length) return;
    var arr = new Y.Array();
    m.set('skeleton_items', arr);
    items.forEach(function (it) {
      if (!it || typeof it !== 'object') return;
      var im = new Y.Map();
      arr.push([im]);
      im.set('id', it.id || shortId('sk-'));
      im.set('depth', typeof it.depth === 'number' ? it.depth : 0);
      im.set('text', new Y.Text(it.text ? String(it.text) : ''));
      im.set('claim_id', it.claim_id || null);
    });
  }

  /* Mirrors paper-editor.js `appendSectionFromTree` (:444-474). */
  function appendSection(sectionsArr, sec, Y) {
    var m = new Y.Map();
    sectionsArr.push([m]);
    m.set('id', sec.id || shortId('sec-'));
    m.set('kind', sec.kind || 'custom');
    m.set('label', new Y.Text(sec.label ? String(sec.label) : ''));
    m.set('order', typeof sec.order === 'number' ? sec.order : 0);
    m.set('status', sec.status || 'draft');
    if (sec.completed_at) m.set('completed_at', sec.completed_at);
    if (sec.completed_by) m.set('completed_by', sec.completed_by);
    if (sec.revision_by) m.set('revision_by', sec.revision_by);
    if (sec.revision_at) m.set('revision_at', sec.revision_at);
    if (sec.uploaded_file) m.set('uploaded_file', sec.uploaded_file);
    if (sec.special) m.set('special', sec.special);
    if (sec.special_render) m.set('special_render', sec.special_render);
    if (sec.appendix) m.set('appendix', true);
    if (sec.ref_label) m.set('ref_label', sec.ref_label);
    // V3.742 — per-section style overrides (plain JSON), when non-empty.
    if (sec.style_overrides && typeof sec.style_overrides === 'object' &&
        Object.keys(sec.style_overrides).length) m.set('style_overrides', sec.style_overrides);
    var childrenArr = new Y.Array();
    m.set('children', childrenArr);
    (sec.children || []).forEach(function (blk) { appendBlock(childrenArr, blk, Y); });
    return m;
  }

  /* V3.742 — value keys (mirrors paper-editor.js _hydrateBundle / _writeValueMap:
   * scalars on a Y.Map, `snapshot` a nested Y.Map). */
  function appendValueEntry(valLib, v, Y) {
    var e = (window.PaperSchemas && window.PaperSchemas.newValueEntry)
      ? window.PaperSchemas.newValueEntry(v || {}) : Object.assign({}, v || {});
    var m = new Y.Map(); valLib.push([m]);
    Object.keys(e).forEach(function (k) {
      if (k === 'snapshot') {
        var sm = new Y.Map();
        m.set('snapshot', sm);
        Object.keys(e.snapshot || {}).forEach(function (sk) { sm.set(sk, e.snapshot[sk]); });
      } else {
        m.set(k, e[k]);
      }
    });
    return m;
  }

  function clearYArray(arr) {
    if (arr && typeof arr.delete === 'function' && arr.length) arr.delete(0, arr.length);
  }

  /* Initialize the paperMap structure (mirrors paper-editor.js:248-273) and
   * build the whole bundle into it. Call INSIDE a yDoc.transact. */
  function buildInto(paperMap, bundle, Y, opts) {
    opts = opts || {};
    var filter = opts.sectionFilter || function () { return true; };

    if (!paperMap.has('meta')) {
      paperMap.set('meta', new Y.Map());
      paperMap.get('meta').set('title', new Y.Text(''));
    }
    if (!paperMap.has('sections')) paperMap.set('sections', new Y.Array());
    if (!paperMap.has('equation_library')) paperMap.set('equation_library', new Y.Array());
    if (!paperMap.has('figure_unplaced')) paperMap.set('figure_unplaced', new Y.Array());
    if (!paperMap.has('table_unplaced')) paperMap.set('table_unplaced', new Y.Array());
    if (!paperMap.has('value_library')) paperMap.set('value_library', new Y.Array());   // V3.742

    var titleStr = (bundle.tree && bundle.tree.meta && bundle.tree.meta.title) ||
      (bundle.paper && bundle.paper.title) || (bundle.title) || '';
    var titleY = paperMap.get('meta').get('title');

    if (opts.replace) {
      // V3.742 — update in place: empty every library the bundle carries, then
      // rebuild below. Same transact → one atomic Y update.
      ['sections', 'equation_library', 'figure_unplaced', 'table_unplaced', 'value_library']
        .forEach(function (k) { clearYArray(paperMap.get(k)); });
      if (titleY && titleY.length) titleY.delete(0, titleY.length);
    }

    // Title (only if the doc has none yet — always true after replace).
    if (titleStr && titleY && titleY.length === 0) titleY.insert(0, String(titleStr));

    // Sections (filtered).
    var sectionsArr = paperMap.get('sections');
    var secs = (bundle.tree && bundle.tree.sections) || bundle.sections || [];
    var built = 0;
    secs.forEach(function (sec, i) {
      if (!filter(sec)) return;
      appendSection(sectionsArr, Object.assign({ order: (typeof sec.order === 'number' ? sec.order : i) }, sec), Y);
      built++;
    });

    // Inline equation library.
    var eqSrc = bundle.equation_library || [];
    var eqLib = paperMap.get('equation_library');
    eqSrc.forEach(function (e) {
      var m = new Y.Map(); eqLib.push([m]);
      m.set('id', e.id || shortId('eq-'));
      m.set('name', new Y.Text(e.name || ''));
      m.set('latex', new Y.Text(e.latex || ''));
      m.set('type', e.type === 'main' ? 'main' : 'inline');
    });

    // Unplaced figure/table libraries (same block shape).
    ['figure_unplaced', 'table_unplaced'].forEach(function (k) {
      var arr = bundle[k];
      var yarr = paperMap.get(k);
      if (Array.isArray(arr)) arr.forEach(function (blk) { appendBlock(yarr, blk, Y); });
    });

    // V3.742 — value keys.
    var valSrc = bundle.value_library || [];
    var valLib = paperMap.get('value_library');
    if (valLib && Array.isArray(valSrc)) valSrc.forEach(function (v) { appendValueEntry(valLib, v, Y); });

    return { sectionsBuilt: built };
  }

  window.PaperTreeBuild = {
    writeAttrValue: writeAttrValue,
    writeSkeletonItems: writeSkeletonItems,   // V3.742
    appendValueEntry: appendValueEntry,       // V3.742
    appendBlock: appendBlock,
    appendSection: appendSection,
    buildInto: buildInto,
  };
})();
