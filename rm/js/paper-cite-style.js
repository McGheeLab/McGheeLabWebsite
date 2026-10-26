/* paper-cite-style.js — V3.344
 *
 * Editor-side citation styling (FuturePlan 07 Release 4). Makes the
 * [@key] citation chips in the paper editor render the way the paper's
 * selected export template will typeset them:
 *
 *   render_family        chip rendering
 *   ─────────────        ──────────────────────────────────────────
 *   superscript          raised  ¹,²   (Nature, SLAS, ACS)
 *   numeric-bracket      [1, 2]        (PLOS, IEEE, elsarticle, preprint)
 *   numeric-paren        (1, 2)        (Science)
 *   author-year          (Smith 2024; Lee 2023)   (plainnat preprint)
 *   (none loaded)        legacy "Author Year" short labels
 *
 * Numbers are FIRST-APPEARANCE order over the document — the same order
 * unsrt-style BibTeX styles assign at compile time — recomputed lazily
 * from the Yjs tree and invalidated on every 'paper-panel-changed'.
 *
 * The template id comes from the shared export config at
 * paperExports/{paperId} (written by the Export Workspace); the template
 * JSON is fetched through PaperExportTex.fetchTemplate (static file with
 * dev fallback). Nothing here blocks editing — until init() resolves,
 * chips render exactly as before.
 *
 * Public surface:
 *   PaperCiteStyle.init(paperId)   → Promise (never rejects)
 *   PaperCiteStyle.getFamily()     → family string | null
 *   PaperCiteStyle.getNumber(key)  → 1-based number | null
 */
(function () {
  'use strict';

  var FAMILIES = { 'superscript': 1, 'numeric-bracket': 1, 'numeric-paren': 1, 'author-year': 1 };

  var _family = null;
  var _numbers = null;        // {key → n} cache
  var _numbersDirty = true;

  window.addEventListener('paper-panel-changed', function () { _numbersDirty = true; });

  function _yStr(y) {
    if (!y) return '';
    if (typeof y === 'string') return y;
    if (typeof y.toString === 'function') return y.toString();
    return '';
  }

  /* Walk the paper tree in document order and assign first-appearance
   * numbers to every cited key. Scans the same text surfaces the editor
   * renders chips in: paragraph bodies + skeleton bullets, figure
   * captions (body), table captions (attrs.caption). A leading `*`
   * (narrative citation) is not part of the key. */
  function _recomputeNumbers() {
    var numbers = Object.create(null);
    var counter = 0;
    var PE = window.PaperEditor;
    var map = PE && PE.getPaperMap && PE.getPaperMap();
    if (!map || typeof map.get !== 'function') { _numbers = numbers; return; }
    var sections = map.get('sections');
    if (!sections || typeof sections.forEach !== 'function') { _numbers = numbers; return; }

    function scan(text) {
      if (!text) return;
      /* V3.920 — and \cite{a,b} written in the paper's own LaTeX (an
       * imported paper): the PDF numbers those in the same text order,
       * so skipping them shifted every later number */
      var re = /\[@([^\]\n]+)\]|\\(?:cite|citep|citet|citealp|citealt|citeauthor|citeyear|parencite|textcite|autocite)\*?(?:\[[^\]]*\]){0,2}\{([^}]*)\}/g, m;
      while ((m = re.exec(text))) {
        if (m[2] != null) {
          m[2].split(',').forEach(function (k) {
            k = (k || '').trim();
            if (k && /^[\w:.\-+/]+$/.test(k) && !(k in numbers)) numbers[k] = ++counter;
          });
          continue;
        }
        /* V3.645 — skip `[@item:KEY]` inventory references. Without
         * this they consume citation numbers, shifting every real
         * citation in the paper by one. */
        if (String(m[1]).replace(/^\*/, '').indexOf('item:') === 0) continue;
        m[1].split(/\s*;\s*@?/).forEach(function (k) {
          k = (k || '').trim().replace(/^\*/, '');
          if (!k || !/^[\w:.\-+/]+$/.test(k)) return;
          if (!(k in numbers)) numbers[k] = ++counter;
        });
      }
    }

    sections.forEach(function (secMap) {
      if (!secMap || typeof secMap.get !== 'function') return;
      var children = secMap.get('children');
      if (!children || typeof children.forEach !== 'function') return;
      children.forEach(function (blk) {
        if (!blk || typeof blk.get !== 'function') return;
        var kind = blk.get('kind');
        if (kind === 'paragraph' || kind === 'figure' || kind === 'list') scan(_yStr(blk.get('body')));   // V3.920 — lists cite too
        if (kind === 'paragraph') {
          var sk = blk.get('skeleton_items');
          if (sk && typeof sk.forEach === 'function') {
            sk.forEach(function (it) { if (it && it.get) scan(_yStr(it.get('text'))); });
          }
        }
        if (kind === 'table') {
          var attrs = blk.get('attrs');
          if (attrs && typeof attrs.get === 'function') {
            scan(_yStr(attrs.get('caption')));
            scan(_yStr(attrs.get('raw_tex')));   // V3.920 — an imported table's own \cite
          }
        }
      });
    });
    _numbers = numbers;
  }

  window.PaperCiteStyle = {
    init: function (paperId) {
      /* firebridge is a top-level `const` in firebase-bridge.js — a lexical
       * global, NOT a window property, so `window.firebridge` is ALWAYS
       * undefined. The old `!window.firebridge` guard therefore bailed on
       * EVERY call: init returned immediately, _family was never set, and
       * every [@key] chip stayed on the legacy "Author Year" short label
       * (the whole V3.388/389 citation hunt — getNumber worked because it
       * never touches firebridge; getFamily stayed null because init bailed).
       * Check the bare lexical binding, matching the firebridge.db() call
       * below. `typeof` keeps it safe if the script somehow loads first. */
      if (!paperId || typeof firebridge === 'undefined' || !firebridge) {
        return Promise.resolve();
      }
      /* Resolve the template id the same way paper-export.js:389 + the
       * Document view do: paperExports.templateId → meta.template_id →
       * 'mebp-journal'. This covers BOTH a missing doc AND a REJECTED read
       * (permissions / offline) — otherwise a rejected get() skips straight
       * to .catch and the family never loads, so every inline [@key] chip
       * renders as a legacy "Author Year" label instead of numbering. */
      function metaFallbackId() {
        var meta = (window.PaperEditor && window.PaperEditor.getPaperMeta && window.PaperEditor.getPaperMeta()) || {};
        return meta.template_id || 'mebp-journal';
      }
      /* V3.492 — grants use numbered citations. If a grant paper's template
       * carries no known render_family (or the fetch fails — e.g. a grant
       * subtype whose export template file doesn't exist yet), fall back to
       * numeric-bracket so [@key] chips render as [1] rather than raw tokens. */
      function _grantFallbackFamily() {
        var meta = (window.PaperEditor && window.PaperEditor.getPaperMeta && window.PaperEditor.getPaperMeta()) || {};
        return meta.paper_type === 'grant' ? 'numeric-bracket' : null;
      }
      /* PaperExportTex normally loads before us (script order), but a
       * transient script-load failure — service-worker churn, a flaky host,
       * a slow parallel fetch — can leave window.PaperExportTex undefined at
       * the moment the editor calls init(). init USED to bail in that case,
       * which left citations stuck on Author-Year until a manual reload
       * (root cause of the long V3.388/389 citation hunt). Instead, poll
       * briefly (~10 s) for it so init self-recovers once the script lands. */
      function waitForExportTex(tries) {
        if (window.PaperExportTex && typeof window.PaperExportTex.fetchTemplate === 'function') {
          return Promise.resolve();
        }
        if (tries <= 0) return Promise.reject(new Error('PaperExportTex unavailable after waiting'));
        return new Promise(function (res) { setTimeout(res, 400); })
          .then(function () { return waitForExportTex(tries - 1); });
      }
      return waitForExportTex(25)
        .then(function () {
          return firebridge.db().collection('paperExports').doc(paperId).get()
            .then(
              function (snap) { return (snap.exists && snap.data().templateId) || metaFallbackId(); },
              function () { return metaFallbackId(); }
            );
        })
        .then(function (templateId) {
          return window.PaperExportTex.fetchTemplate(templateId);
        })
        .then(function (tpl) {
          var fam = tpl && tpl.citation && tpl.citation.render_family;
          if (!fam || !FAMILIES[fam]) fam = _grantFallbackFamily();   // grants → numeric
          if (fam && FAMILIES[fam]) {
            _family = fam;
            _numbersDirty = true;
            /* Repaint already-rendered bodies. The editor's bound
             * contenteditables listen for this event and re-render when
             * their source contains chip tokens. */
            try { window.dispatchEvent(new CustomEvent('paper-equations-changed')); } catch (e) {}
          } else {
            console.info('[paper-cite-style] template has no known render_family:', tpl && tpl.id);
          }
        })
        .catch(function (e) {
          /* Template fetch itself failed. Grants still render numeric; other
           * paper types keep the legacy Author-Year rendering. */
          var fam = _grantFallbackFamily();
          if (fam) { _family = fam; _numbersDirty = true; try { window.dispatchEvent(new CustomEvent('paper-equations-changed')); } catch (ev) {} }
          else console.info('[paper-cite-style] no template style loaded:', e && e.message);
        });
    },
    getFamily: function () { return _family; },
    getNumber: function (key) {
      if (_numbersDirty || !_numbers) { _recomputeNumbers(); _numbersDirty = false; }
      return _numbers[key] || null;
    },
  };
})();
