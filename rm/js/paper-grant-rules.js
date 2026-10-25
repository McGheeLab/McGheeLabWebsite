/* paper-grant-rules.js — a funder's formatting rules, checked (V3.911).
 *
 * A grant template carries a `grant` block (rm/data/paper-templates/
 * nsf-career.json: the PAPPG typefaces and minimum sizes, margins, line
 * pitch, and each uploaded document's page limit and required headings).
 * This module checks a laid-out document against it. The Document view
 * passes what it measured (pages, headings and the pages they fall on, the
 * text); the Export page passes the same before a compile.
 *
 *   PaperGrantRules.rules(template)            → the grant block, or null
 *   PaperGrantRules.docRule(template, key)     → one document's rule
 *   PaperGrantRules.typeface(template, font)   → {font,label,pappg,min_size,…} | null
 *   PaperGrantRules.check({ template, look, doc }) → [{ id, level, title, detail, fix }]
 *       level: 'error' (NSF returns the proposal without review) |
 *              'warn' (likely a problem) | 'info' | 'ok'
 *       doc: { key, pages, linesOver, lastPageLines, linesPerPage,
 *              headings: [{ text, page, level }], text,
 *              sectionPages: { <heading text>: pages spanned } }
 *
 * Pure: no DOM, Node-requireable (scripts/tests/paper-grant-rules.test.mjs).
 */
(function (root) {
  'use strict';

  function rules(template) {
    return (template && template.grant) || null;
  }
  function docRule(template, key) {
    var g = rules(template);
    if (!g || !Array.isArray(g.documents)) return null;
    for (var i = 0; i < g.documents.length; i++) if (g.documents[i].key === key) return g.documents[i];
    return null;
  }
  function typeface(template, font) {
    var g = rules(template);
    if (!g || !Array.isArray(g.typefaces)) return null;
    for (var i = 0; i < g.typefaces.length; i++) if (g.typefaces[i].font === font) return g.typefaces[i];
    return null;
  }

  // a heading's words, without its number ("9. Broader Impacts" → "broader impacts")
  function headWords(t) {
    return String(t || '').replace(/^\s*[0-9IVXivx]+(\.[0-9]+)*\.?\s*/, '').replace(/[:.]\s*$/, '').trim().toLowerCase();
  }
  function findHeading(doc, text) {
    var want = String(text).toLowerCase();
    return (doc.headings || []).filter(function (h) { return headWords(h.text).indexOf(want) === 0; })[0] || null;
  }
  function fmt(n) { return (Math.round(n * 100) / 100).toString(); }

  var URL_RE = /\b(?:https?:\/\/|www\.)[^\s)\]]+/gi;

  function check(o) {
    var template = o.template, look = o.look || {}, doc = o.doc || {};
    var g = rules(template);
    var out = [];
    function add(id, level, title, detail, fix) { out.push({ id: id, level: level, title: title, detail: detail || '', fix: fix || '' }); }
    if (!g) return out;
    var f = g.format || {};
    var rule = docRule(template, doc.key) || {};
    var guide = g.guide || 'the funder\'s guide';

    // ── the page ──
    var pg = look.page || {};
    if (f.paper && (Math.abs(pg.w - f.paper[0]) > 0.5 || Math.abs(pg.h - f.paper[1]) > 0.5)) {
      add('paper', 'error', 'Paper size is not US Letter', fmt(pg.w / 72) + ' × ' + fmt(pg.h / 72) + ' in', 'Use 8.5 × 11 in.');
    } else add('paper', 'ok', 'US Letter, 8.5 × 11 in');
    var m = look.margins || {};
    var minM = f.min_margin_bp || 72;
    var tight = ['top', 'bottom', 'left', 'right'].filter(function (k) { return (m[k] || 0) < minM - 0.01; });
    if (tight.length) add('margins', 'error', 'Margins under 1 in: ' + tight.join(', '), '', 'Every margin must be at least 1 in (' + guide + ').');
    else add('margins', 'ok', 'Margins at least 1 in on every side');
    if (f.page_numbers === false && look.footer && look.footer.page_numbers) {
      add('pagenum', 'warn', 'Page numbers are printed', 'NSF asks for no page numbers (Research.gov numbers the pages).', 'Turn page numbers off.');
    }

    // ── type: the body (References Cited is set at the bibliography's size) ──
    var fonts = look.fonts || {};
    var tf = typeface(template, fonts.text);
    var isRefs = !!rule.references;
    var size = isRefs ? ((look.bib || {}).size || (look.body || {}).size) : (look.body || {}).size;
    var lead = isRefs ? ((look.bib || {}).lead || (look.body || {}).lead) : (look.body || {}).lead;
    if (!tf) {
      add('typeface', 'error', 'Typeface is not one the PAPPG lists', 'Allowed: ' + (g.typefaces || []).map(function (t) { return t.pappg; }).join(', ') + '.',
        'Choose a listed typeface.');
    } else {
      add('typeface', tf.exact ? 'ok' : 'info', tf.label + (tf.exact ? '' : ' — accepted as ' + tf.pappg), tf.note || '');
      if (size < tf.min_size - 0.01) {
        add('size', 'error', 'Text is ' + fmt(size) + ' pt; ' + tf.pappg + ' must be ' + tf.min_size + ' pt or larger', '',
          'Raise the text size to ' + tf.min_size + ' pt.');
      } else add('size', 'ok', 'Text ' + fmt(size) + ' pt (' + tf.pappg + ' minimum ' + tf.min_size + ' pt)');
    }
    var minLead = f.min_lead_bp || 12;
    if (lead < minLead - 0.005) {
      add('lpi', 'error', fmt(72 / lead) + ' lines per inch — more than 6', 'Line pitch ' + fmt(lead) + ' pt; the PAPPG allows at most six lines in a vertical inch (' + minLead + ' pt pitch).',
        'Set the line pitch to at least ' + minLead + ' pt.');
    } else add('lpi', 'ok', fmt(72 / lead) + ' lines per inch (6 at most)');
    var cap = look.caption || {};
    if (!isRefs && cap.size) {
      var minRead = g.min_readable_bp || 8;
      if (cap.size < minRead - 0.01) add('caption', 'warn', 'Captions at ' + fmt(cap.size) + ' pt may be hard to read', g.small_type || '', 'Keep captions at ' + minRead + ' pt or larger.');
      else if (tf && cap.size < tf.min_size - 0.01) add('caption', 'info', 'Captions at ' + fmt(cap.size) + ' pt', g.small_type || '');
    }

    // ── length ──
    if (rule.page_limit && doc.pages) {
      if (doc.pages > rule.page_limit) {
        var over = doc.linesOver != null ? doc.linesOver : null;
        add('pages', 'error', rule.label + ': ' + doc.pages + ' pages, limit ' + rule.page_limit,
          over != null ? 'About ' + over + ' line' + (over === 1 ? '' : 's') + ' over.' : '',
          'Use Fit above, or shorten the text (the section lengths are listed below).');
      } else {
        var spare = doc.linesPerPage && doc.lastPageLines != null
          ? (rule.page_limit - doc.pages) * doc.linesPerPage + (doc.linesPerPage - doc.lastPageLines) : null;
        add('pages', 'ok', rule.label + ': ' + doc.pages + ' of ' + rule.page_limit + ' pages',
          spare != null ? spare + ' line' + (spare === 1 ? '' : 's') + ' to spare.' : '');
      }
    }
    if (rule.char_limit && doc.text != null) {
      var n = String(doc.text).length;
      if (n > rule.char_limit) add('chars', 'error', n + ' characters; the Research.gov boxes hold ' + rule.char_limit, '', 'Shorten the summary.');
      else add('chars', 'ok', n + ' of ' + rule.char_limit + ' characters');
    }

    // ── headings ──
    (rule.required_headings || []).forEach(function (h) {
      var hit = findHeading(doc, h.text);
      if (hit) add('head-' + h.text, 'ok', '"' + h.text + '" heading present', hit.page ? 'Page ' + hit.page + '.' : '');
      else add('head-' + h.text, 'error', 'No "' + h.text + '" heading', h.why || '', 'Add a heading "' + h.text + '" on its own line.');
    });
    (rule.optional_headings || []).forEach(function (h) {
      var hit = findHeading(doc, h.text);
      if (!hit) { add('head-' + h.text, 'info', 'No "' + h.text + '" section', h.why || ''); return; }
      var span = doc.sectionPages ? doc.sectionPages[hit.text] : null;
      if (h.page_limit && span != null && span > h.page_limit) {
        add('head-' + h.text, 'error', '"' + h.text + '" runs ' + fmt(span) + ' pages; limit ' + h.page_limit, h.why || '', 'Shorten it.');
      } else add('head-' + h.text, 'ok', '"' + h.text + '" present' + (span != null ? ' (' + fmt(span) + ' pages)' : ''));
    });

    // ── content ──
    if (rule.no_urls && doc.text != null) {
      var urls = String(doc.text).match(URL_RE) || [];
      if (urls.length) {
        add('urls', 'error', urls.length + ' web address' + (urls.length === 1 ? '' : 'es') + ' in the ' + (rule.label || 'document'),
          'First: ' + urls[0], 'The Project Description must be self-contained; remove the URLs (cite the work instead).');
      } else add('urls', 'ok', 'No web addresses');
    }
    return out;
  }

  var api = { rules: rules, docRule: docRule, typeface: typeface, check: check, headWords: headWords };
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  else root.PaperGrantRules = api;
})(typeof window !== 'undefined' ? window : this);
