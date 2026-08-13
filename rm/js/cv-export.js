/* cv-export.js — render a full CV document from cvData.
 *
 * Outputs:
 *   CVExport.toMarkdown(doc, opts) — plain text, paste-friendly
 *   CVExport.toHTML(doc, opts)     — standalone printable HTML (Cmd-P → PDF)
 *   CVExport.downloadDoc(...)      — Word-compatible .doc (HTML-Word shell,
 *                                    same pattern as grant-biosketch-export)
 *
 * V3.354: `opts.template` picks one of CVExport.TEMPLATES (serif | compact
 * | modern) — one HTML generator, themed CSS blocks, so the live preview,
 * print PDF, HTML download, and Word export always agree.
 * `opts.variant` ({hiddenSections, hiddenEntries}) filters the doc before
 * rendering — driven by the audience-variants UI (V3.355), same shape the
 * parent cv-builder's cv_versions[] uses.
 *
 * All downloaders trigger browser downloads / print dialogs. No server
 * involvement.
 */

var CVExport = (function () {

  /* ── formatters per section ──
   * Each returns `{ heading, lines: [ "Markdown line for this entry", ... ] }`.
   * Lines are plain Markdown — renderers wrap them for HTML. */

  function yearOf(v) {
    if (!v) return '';
    var m = String(v).match(/(\d{4})/);
    return m ? m[1] : String(v);
  }

  function joinNonEmpty(sep, parts) {
    return parts.filter(Boolean).join(sep);
  }

  /* Clone an entry with every string field scrubbed of HTML/LaTeX/Markdown
   * markup. CrossRef and ORCID leak <i>…</i>, LaTeX macros, and HTML
   * entities into titles — we want the CV output to be plain text. We keep
   * numbers/booleans untouched. */
  function cleanEntry(e) {
    var out = {};
    for (var k in e) {
      if (!Object.prototype.hasOwnProperty.call(e, k)) continue;
      out[k] = (typeof e[k] === 'string') ? cvCleanText(e[k]) : e[k];
    }
    return out;
  }

  function fmtJournal(e) {
    e = cleanEntry(e);
    // e.g. "Smith J, Doe A. Title of paper. *Journal Name* 2025;12(3):100-110. doi:10.1000/..."
    var line = joinNonEmpty('. ', [
      e.authors,
      e.title,
    ]);
    var venue = joinNonEmpty(' ', [
      e.journal ? '*' + e.journal + '*' : '',
      [e.year, e.volume && (e.volume + (e.issue ? '(' + e.issue + ')' : '')) + (e.pages ? ':' + e.pages : '')]
        .filter(Boolean).join(';'),
    ]);
    if (venue) line += '. ' + venue;
    if (e.doi) line += ' doi:' + e.doi;
    if (e.status && e.status !== 'Published') line += ' *[' + e.status + ']*';
    return line;
  }

  function fmtConference(e) {
    e = cleanEntry(e);
    var line = joinNonEmpty('. ', [
      e.authors,
      e.title,
    ]);
    var venue = joinNonEmpty(', ', [
      e.conference ? '*' + e.conference + '*' : '',
      e.location,
      e.year,
    ]);
    if (venue) line += '. ' + venue;
    if (e.type) line += ' (' + e.type + ')';
    if (e.doi) line += ' doi:' + e.doi;
    return line;
  }

  function fmtBook(e) {
    e = cleanEntry(e);
    var line = joinNonEmpty('. ', [
      e.authors || e.editors,
      e.chapter || e.title,
    ]);
    if (e.chapter && e.title) line += '. In: *' + e.title + '*';
    var tail = joinNonEmpty(', ', [e.publisher, e.year]);
    if (tail) line += '. ' + tail;
    if (e.isbn) line += '. ISBN:' + e.isbn;
    return line;
  }

  function fmtPatent(e) {
    e = cleanEntry(e);
    var line = joinNonEmpty('. ', [
      e.inventors,
      e.title,
      e.number,
    ]);
    if (e.grant_date) line += ', granted ' + e.grant_date;
    else if (e.filing_date) line += ', filed ' + e.filing_date;
    if (e.status) line += ' (' + e.status + ')';
    return line;
  }

  function fmtPresentation(e) {
    e = cleanEntry(e);
    var y = yearOf(e.date);
    var line = joinNonEmpty('. ', [
      e.title,
      joinNonEmpty(', ', [e.event, e.location, y]),
    ]);
    if (e.type) line += ' — ' + e.type;
    return line;
  }

  function fmtGrant(e) {
    e = cleanEntry(e);
    var yrs = joinNonEmpty('–', [yearOf(e.start_date), yearOf(e.end_date)].filter(Boolean));
    var parts = [
      '**' + (e.title || '') + '**',
      e.agency,
      e.role ? '(' + e.role + ')' : '',
      yrs,
      e.amount ? ('$' + Number(e.amount).toLocaleString()) : '',
      e.status && e.status !== 'Active' ? '[' + e.status + ']' : '',
    ].filter(Boolean);
    return parts.join('. ');
  }

  function fmtAward(e) {
    e = cleanEntry(e);
    return joinNonEmpty('. ', [
      '**' + (e.title || '') + '**',
      e.awarding_body,
      e.year,
    ]) + (e.category ? ' (' + e.category + ')' : '');
  }

  function fmtService(e) {
    e = cleanEntry(e);
    var yrs = joinNonEmpty('–', [e.start_year, e.ongoing ? 'present' : e.end_year].filter(Boolean));
    var line = joinNonEmpty('. ', [
      '**' + (e.role || '') + '**',
      e.organization,
      yrs,
    ]) + (e.type ? ' — ' + e.type : '');
    // Service entries created from Year Review summaries carry effort notes
    // (e.g. "8 events · 138 emails · 77.4 hours") in `description`. Surface
    // them on the CV line so the rollup numbers show up in the exported doc.
    if (e.description) line += (e.type ? ' · ' : ' — ') + e.description;
    return line;
  }

  function fmtStudent(e) {
    e = cleanEntry(e);
    var yrs = joinNonEmpty('–', [e.start_year, e.end_year || 'present'].filter(Boolean));
    return joinNonEmpty('. ', [
      '**' + (e.name || '') + '**',
      e.degree,
      yrs,
      e.thesis_title,
      e.current_position ? 'Now: ' + e.current_position : '',
    ]);
  }

  function fmtCourse(e) {
    e = cleanEntry(e);
    return joinNonEmpty('. ', [
      '**' + (e.name || '') + (e.code ? ' (' + e.code + ')' : '') + '**',
      e.institution,
      joinNonEmpty(' ', [e.semester, e.year].filter(Boolean)),
      e.enrollment ? ('n=' + e.enrollment) : '',
      e.role,
    ]);
  }

  function fmtSoftware(e) {
    e = cleanEntry(e);
    return joinNonEmpty('. ', [
      '**' + (e.name || '') + '**',
      e.description,
      e.url,
      e.language,
      e.year,
    ]);
  }

  var SECTION_ORDER = [
    ['awards',        'Awards & Honors',            fmtAward,        'year'],
    ['grants',        'Grants & Funding',           fmtGrant,        'start_date'],
    ['journals',      'Journal Publications',       fmtJournal,      'year'],
    ['conferences',   'Conference Papers',          fmtConference,   'year'],
    ['books',         'Books & Book Chapters',      fmtBook,         'year'],
    ['patents',       'Patents',                    fmtPatent,       'grant_date'],
    ['presentations', 'Presentations & Invited Talks', fmtPresentation, 'date'],
    ['courses',       'Courses Taught',             fmtCourse,       'year'],
    ['students',      'Students Supervised',        fmtStudent,      'start_year'],
    ['service',       'Service & Editorial',        fmtService,      'start_year'],
    ['software',      'Software & Datasets',        fmtSoftware,     'year'],
  ];

  /* ── variant filter ──
   * Same shape as the parent cv-builder's cv_versions[] entries:
   * { hiddenSections: ['courses', ...], hiddenEntries: { journals: [_id, ...] } }
   * Returns a shallow-filtered copy; the original doc is never mutated. */
  function applyVariant(doc, variant) {
    if (!variant) return doc;
    var out = { profile: doc.profile };
    var hiddenSections = variant.hiddenSections || [];
    var hiddenEntries = variant.hiddenEntries || {};
    SECTION_ORDER.forEach(function (row) {
      var k = row[0];
      if (hiddenSections.indexOf(k) >= 0) { out[k] = []; return; }
      var hidden = hiddenEntries[k] || [];
      out[k] = (doc[k] || []).filter(function (e) {
        return e && hidden.indexOf(e._id) < 0;
      });
    });
    return out;
  }

  /* ── Markdown renderer ── */

  function toMarkdown(doc, opts) {
    doc = applyVariant(doc, opts && opts.variant);
    var lines = [];
    var p = cleanEntry(doc.profile || {});
    if (p.name) lines.push('# ' + p.name);
    var contact = joinNonEmpty(' · ', [p.title, p.institution, p.department].filter(Boolean));
    if (contact) lines.push(contact);
    var contact2 = joinNonEmpty(' · ', [p.email, p.phone, p.website].filter(Boolean));
    if (contact2) lines.push(contact2);
    var ids = joinNonEmpty(' · ', [
      p.orcid ? 'ORCID: ' + p.orcid : '',
      p.scholar ? 'Google Scholar: ' + p.scholar : '',
    ].filter(Boolean));
    if (ids) lines.push(ids);
    if (p.bio) { lines.push(''); lines.push(p.bio); }
    lines.push('');

    for (var i = 0; i < SECTION_ORDER.length; i++) {
      var secKey = SECTION_ORDER[i][0];
      var secLabel = SECTION_ORDER[i][1];
      var fmt = SECTION_ORDER[i][2];
      var sortKey = SECTION_ORDER[i][3];
      var entries = (doc[secKey] || []).filter(Boolean);
      if (!entries.length) continue;
      lines.push('');
      lines.push('## ' + secLabel);
      var grouped = groupByYear(entries, sortKey);
      grouped.forEach(function (bucket) {
        lines.push('');
        lines.push('### ' + bucket.label);
        lines.push('');
        bucket.entries.forEach(function (e) {
          lines.push('- ' + fmt(e));
        });
      });
    }
    return lines.join('\n');
  }

  /* Group entries by year (most recent first). Entries with no parseable
   * year land in an "Undated" bucket at the bottom — still visible but
   * clearly unsorted, so you notice and fix them. */
  function groupByYear(entries, sortKey) {
    var buckets = {}; // year string → [entries]
    entries.forEach(function (e) {
      var raw = e[sortKey];
      var y = '';
      if (raw != null && raw !== '') {
        var m = String(raw).match(/(\d{4})/);
        if (m) y = m[1];
      }
      (buckets[y] = buckets[y] || []).push(e);
    });
    var years = Object.keys(buckets).filter(function (y) { return y !== ''; });
    years.sort(function (a, b) { return b.localeCompare(a); });
    var out = years.map(function (y) { return { label: y, entries: buckets[y] }; });
    if (buckets['']) out.push({ label: 'Undated', entries: buckets[''] });
    return out;
  }

  /* ── HTML renderer — standalone printable page ── */

  function escHtml(s) {
    return String(s || '').replace(/[&<>"']/g, function (c) {
      return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c];
    });
  }

  /* Minimal Markdown → HTML converter for the subset we use (bold, italic,
   * escaping). Keeps the output self-contained. */
  function mdInline(s) {
    return escHtml(s)
      .replace(/\*\*([^*]+)\*\*/g, '<strong>$1</strong>')
      .replace(/\*([^*]+)\*/g, '<em>$1</em>');
  }

  /* ── templates ──
   * One generator, themed CSS. Shared structural rules live in BASE_CSS;
   * each template only restates type + color decisions. */
  var BASE_CSS =
    'body{max-width:820px;margin:24px auto;padding:0 20px;line-height:1.45}' +
    'h1{margin:0 0 4px 0}' +
    '.sub{margin:0;font-size:13px}' +
    '.bio{margin:14px 0 0;font-size:13px}' +
    '.yr-group{display:grid;grid-template-columns:56px 1fr;gap:10px;align-items:start;margin:6px 0}' +
    '.yr-label{font-weight:700;font-size:13px;padding-top:3px}' +
    '.yr-group ul{padding-left:16px;margin:0;list-style:disc}' +
    'li{margin:2px 0;font-size:13px}' +
    '@media print{body{max-width:none}}';

  var TEMPLATES = {
    serif: {
      label: 'Classic serif',
      css: BASE_CSS +
        'body{font-family:Georgia,serif;color:#111}' +
        'h1{font-size:26px}' +
        '.sub{color:#555}.bio{color:#333}.yr-label{color:#111}' +
        'h2{font-size:15px;border-bottom:1px solid #999;margin:22px 0 8px;padding-bottom:3px;text-transform:uppercase;letter-spacing:1px}',
    },
    modern: {
      label: 'Modern sans',
      css: BASE_CSS +
        'body{font-family:-apple-system,BlinkMacSystemFont,"Segoe UI",Helvetica,Arial,sans-serif;color:#1f2430}' +
        'h1{font-size:24px;letter-spacing:-.3px}' +
        '.sub{color:#5b6472}.bio{color:#3a4150}.yr-label{color:#2563eb}' +
        'h2{font-size:13px;color:#2563eb;border-left:3px solid #2563eb;padding-left:8px;margin:22px 0 8px;text-transform:uppercase;letter-spacing:1.4px}',
    },
    compact: {
      label: 'Compact',
      css: BASE_CSS +
        'body{font-family:Helvetica,Arial,sans-serif;color:#111;line-height:1.3;max-width:860px}' +
        'h1{font-size:20px}' +
        '.sub{color:#555;font-size:11.5px}.bio{color:#333;font-size:11.5px;margin-top:8px}' +
        'h2{font-size:12px;border-bottom:1px solid #bbb;margin:14px 0 5px;padding-bottom:2px;text-transform:uppercase;letter-spacing:.8px}' +
        '.yr-group{grid-template-columns:44px 1fr;gap:8px;margin:3px 0}' +
        '.yr-label{font-size:11.5px;padding-top:2px}' +
        'li{margin:1px 0;font-size:11.5px}',
    },
  };
  var DEFAULT_TEMPLATE = 'serif';

  function toHTML(doc, opts) {
    doc = applyVariant(doc, opts && opts.variant);
    var tpl = TEMPLATES[(opts && opts.template) || DEFAULT_TEMPLATE] || TEMPLATES[DEFAULT_TEMPLATE];
    var p = cleanEntry(doc.profile || {});
    var head = '';
    if (p.name) head += '<h1>' + escHtml(p.name) + '</h1>';
    var sub1 = [p.title, p.institution, p.department].filter(Boolean).map(escHtml).join(' &middot; ');
    var sub2 = [p.email, p.phone, p.website].filter(Boolean).map(escHtml).join(' &middot; ');
    var ids = [
      p.orcid ? 'ORCID: ' + escHtml(p.orcid) : '',
      p.scholar ? 'Google Scholar: ' + escHtml(p.scholar) : '',
    ].filter(Boolean).join(' &middot; ');
    if (sub1) head += '<p class="sub">' + sub1 + '</p>';
    if (sub2) head += '<p class="sub">' + sub2 + '</p>';
    if (ids)  head += '<p class="sub">' + ids + '</p>';
    if (p.bio) head += '<p class="bio">' + escHtml(p.bio) + '</p>';

    var body = '';
    for (var i = 0; i < SECTION_ORDER.length; i++) {
      var secKey = SECTION_ORDER[i][0];
      var secLabel = SECTION_ORDER[i][1];
      var fmt = SECTION_ORDER[i][2];
      var sortKey = SECTION_ORDER[i][3];
      var entries = (doc[secKey] || []).filter(Boolean);
      if (!entries.length) continue;
      body += '<h2>' + escHtml(secLabel) + '</h2>';
      var grouped = groupByYear(entries, sortKey);
      grouped.forEach(function (bucket) {
        body += '<div class="yr-group"><div class="yr-label">' + escHtml(bucket.label) + '</div>';
        body += '<ul>';
        bucket.entries.forEach(function (e) {
          body += '<li>' + mdInline(fmt(e)) + '</li>';
        });
        body += '</ul></div>';
      });
    }

    return '<!DOCTYPE html><html><head><meta charset="utf-8">' +
      '<title>' + escHtml(p.name || 'CV') + '</title>' +
      '<style>' + tpl.css + '</style></head><body>' + head + body + '</body></html>';
  }

  /* ── browser helpers ── */

  function downloadBlob(name, type, content) {
    var blob = new Blob([content], { type: type });
    var a = document.createElement('a');
    a.href = URL.createObjectURL(blob);
    a.download = name;
    document.body.appendChild(a);
    a.click();
    setTimeout(function () {
      URL.revokeObjectURL(a.href);
      document.body.removeChild(a);
    }, 100);
  }

  function downloadMarkdown(doc, baseName, opts) {
    downloadBlob((baseName || 'cv') + '.md', 'text/markdown;charset=utf-8', toMarkdown(doc, opts));
  }

  function downloadHTML(doc, baseName, opts) {
    downloadBlob((baseName || 'cv') + '.html', 'text/html;charset=utf-8', toHTML(doc, opts));
  }

  /* Word-compatible export — the grant-biosketch-export pattern: wrap the
   * rendered HTML in a Word-HTML shell and serve it as a .doc blob. Word
   * (and Google Docs) open it as an editable document. */
  function downloadDoc(doc, baseName, opts) {
    var html = toHTML(doc, opts)
      .replace('<html>', '<html xmlns:o="urn:schemas-microsoft-com:office:office" xmlns:w="urn:schemas-microsoft-com:office:word">');
    downloadBlob((baseName || 'cv') + '.doc', 'application/msword;charset=utf-8', html);
  }

  function openPrintPreview(doc, opts) {
    var w = window.open('', '_blank');
    if (!w) { alert('Popup blocked — allow popups for this site to preview.'); return; }
    w.document.open();
    w.document.write(toHTML(doc, opts));
    w.document.close();
    // Let layout settle before invoking print.
    setTimeout(function () { try { w.focus(); w.print(); } catch (e) {} }, 400);
  }

  return {
    TEMPLATES: TEMPLATES,
    DEFAULT_TEMPLATE: DEFAULT_TEMPLATE,
    applyVariant: applyVariant,
    toMarkdown: toMarkdown,
    toHTML: toHTML,
    downloadMarkdown: downloadMarkdown,
    downloadHTML: downloadHTML,
    downloadDoc: downloadDoc,
    downloadBlob: downloadBlob,
    openPrintPreview: openPrintPreview,
  };
})();
