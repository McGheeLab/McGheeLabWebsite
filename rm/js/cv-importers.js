/* cv-importers.js — CrossRef DOI lookup, ORCID works fetch, BibTeX parser.
 * Ported from McGheeLabWebsite/cv-builder.js so the RM editor can pull in
 * publications the same way as the website. Output entries are compatible
 * with the cvData Firestore contract — both apps read/write the same arrays.
 */

var CVImport = (function () {

  /* ── CrossRef DOI lookup ──
   * Returns a partial journal/conference entry. Caller assigns _id/section.
   * All text fields run through cvCleanText so HTML (e.g. <i>In-Situ</i> in
   * JATS titles), LaTeX, and entity markup never reach the stored CV. */
  async function fetchDOI(doi) {
    var clean = String(doi || '').replace(/^https?:\/\/doi\.org\//i, '').trim();
    if (!clean) throw new Error('empty DOI');
    var res = await fetch('https://api.crossref.org/works/' + encodeURIComponent(clean));
    if (!res.ok) throw new Error('DOI not found (CrossRef ' + res.status + ')');
    var j = await res.json();
    var w = j.message || {};
    var authors = (w.author || []).map(function (a) {
      var given = (a.given || '').split(' ').map(function (n) { return (n[0] || ''); }).join('');
      return (a.family || '') + (given ? ' ' + given : '');
    }).filter(Boolean).join(', ').trim();
    return {
      title: cvCleanText((w.title || [''])[0] || ''),
      authors: cvCleanText(authors),
      doi: clean,
      journal: cvCleanText((w['container-title'] || [''])[0] || ''),
      year: (w.issued && w.issued['date-parts'] && w.issued['date-parts'][0] && w.issued['date-parts'][0][0]) || '',
      volume: cvCleanText(w.volume || ''),
      issue: cvCleanText(w.issue || ''),
      pages: cvCleanText(w.page || ''),
      abstract: cvCleanText(w.abstract || ''),
      citations: w['is-referenced-by-count'] || 0,
    };
  }

  async function fetchCitationCount(doi) {
    var clean = String(doi || '').replace(/^https?:\/\/doi\.org\//i, '').trim();
    if (!clean) return null;
    var res = await fetch('https://api.crossref.org/works/' + encodeURIComponent(clean));
    if (!res.ok) return null;
    var j = await res.json();
    var w = j.message || {};
    return w['is-referenced-by-count'] != null ? w['is-referenced-by-count'] : null;
  }

  /* ── ORCID works fetch ──
   * Returns a list of partial entries with raw_type we can use to decide
   * whether something is a journal vs conference entry. */
  async function fetchORCID(orcidId) {
    var id = String(orcidId || '').trim();
    if (!/^\d{4}-\d{4}-\d{4}-\d{3}[\dX]$/.test(id)) throw new Error('Invalid ORCID iD format');
    var res = await fetch('https://pub.orcid.org/v3.0/' + id + '/works', {
      headers: { Accept: 'application/json' },
    });
    if (!res.ok) throw new Error('ORCID API ' + res.status);
    var j = await res.json();
    return (j.group || []).flatMap(function (g) {
      return (g['work-summary'] || []).slice(0, 1);
    }).map(function (w) {
      var ext = (w['external-ids'] && w['external-ids']['external-id']) || [];
      var doiRef = ext.find(function (x) { return x['external-id-type'] === 'doi'; });
      return {
        title: cvCleanText((w.title && w.title.title && w.title.title.value) || ''),
        year: (w['publication-date'] && w['publication-date'].year && w['publication-date'].year.value) || '',
        journal: cvCleanText((w['journal-title'] && w['journal-title'].value) || ''),
        doi: (doiRef && doiRef['external-id-value']) || '',
        type_raw: w.type || '',
      };
    });
  }

  /* Section guess for an ORCID work (journal vs conference). */
  function orcidSectionFor(work) {
    return (work.type_raw || '').toLowerCase().indexOf('conference') >= 0 ? 'conferences' : 'journals';
  }

  /* ── BibTeX parser ──
   * Ported from cv-builder.js. Supports standard + custom entry types. */
  /* Strip LaTeX font commands, escapes, HTML tags, and HTML entities. BibTeX
   * out in the wild contains all three — LaTeX from academic tooling, HTML
   * from journal exports, entities from manual copy-paste. */
  function cleanLatex(s) {
    if (!s) return '';
    var out = s
      .replace(/\\textbf\{([^}]*)\}/g, '$1')
      .replace(/\\textit\{([^}]*)\}/g, '$1')
      .replace(/\\emph\{([^}]*)\}/g, '$1')
      .replace(/\\textsc\{([^}]*)\}/g, '$1')
      .replace(/\\textrm\{([^}]*)\}/g, '$1')
      .replace(/\\href\{[^}]*\}\{([^}]*)\}/g, '$1')
      .replace(/\\url\{([^}]*)\}/g, '$1')
      .replace(/\\newline/g, '')
      .replace(/[{}]/g, '')
      .replace(/\\\\/g, '')
      .replace(/\\&/g, '&')
      .replace(/~+/g, ' ');
    // Run through the shared CV cleaner to catch HTML tags/entities and
    // normalise whitespace.
    return cvCleanText(out);
  }

  /* Entry-type → section mapping for standard BibTeX types. */
  var TYPE_SEC = {
    article: 'journals',
    inproceedings: 'conferences',
    conference: 'conferences',
    book: 'books',
    incollection: 'books',
    patent: 'patents',
    presentation: 'presentations',
    grant: 'grants',
    student: 'students',
    award: 'awards',
    service: 'service',
    course: 'courses',
  };

  function parseBibtex(raw) {
    var out = [];
    var re = /@(\w+)\s*\{([^,]+),([^@]*)\}/gs;
    var m;
    while ((m = re.exec(raw)) !== null) {
      var t = m[1].toLowerCase();
      var body = m[3];
      var f = {};
      var fr = /(\w+)\s*=\s*(?:\{([^{}]*(?:\{[^{}]*\}[^{}]*)*)\}|"([^"]*)")/g;
      var fm;
      while ((fm = fr.exec(body)) !== null) {
        f[fm[1].toLowerCase()] = cleanLatex(fm[2] || fm[3] || '');
      }
      var authors = cleanLatex((f.author || '').replace(/\s+and\s+/gi, ', '));
      var title = cleanLatex(f.title || '');
      var year = f.year || '';
      var doi = f.doi || '';
      var sec = TYPE_SEC[t] || 'journals';
      var entry = { section: sec, _id: cvUid(), title: title, year: year };
      if (doi) entry.doi = doi;

      if (sec === 'journals') {
        entry.authors = authors;
        entry.journal = cleanLatex(f.journal || '');
        entry.volume = f.volume || '';
        entry.issue = f.number || '';
        entry.pages = cleanLatex(f.pages || '');
        entry.status = 'Published';
        if (f.abstract) entry.abstract = f.abstract;
      } else if (sec === 'conferences') {
        entry.authors = authors;
        entry.conference = cleanLatex(f.booktitle || f.journal || '');
        entry.location = cleanLatex(f.publisher || f.address || '');
        entry.pages = cleanLatex(f.pages || '');
        entry.status = 'Published';
      } else if (sec === 'books') {
        entry.authors = authors;
        entry.publisher = cleanLatex(f.publisher || '');
        entry.isbn = f.isbn || '';
        entry.chapter = cleanLatex(f.chapter || '');
        entry.editors = cleanLatex(f.editor || '');
        entry.role = (t === 'incollection') ? 'Chapter Author' : 'Author';
      } else if (sec === 'patents') {
        entry.number = f.number || cleanLatex(f.journal || '');
        entry.inventors = authors;
        entry.status = cleanLatex(f.note || f.status || 'Granted');
      } else if (sec === 'presentations') {
        entry.event = cleanLatex(f.event || f.booktitle || f.journal || '');
        entry.location = cleanLatex(f.address || f.publisher || '');
        entry.type = f.type || 'Invited Talk';
        entry.date = year.match(/^\d{4}-/) ? year : (year ? year + '-01-01' : '');
      } else if (sec === 'grants') {
        entry.agency = cleanLatex(f.agency || '');
        entry.role = f.role || 'PI';
        entry.amount = f.amount || '';
        entry.start_date = year;
        entry.end_date = f.endyear || '';
        entry.status = f.status || 'Active';
      } else if (sec === 'students') {
        entry.name = f.name || '';
        entry.degree = f.degree || 'PhD';
        entry.thesis_title = title;
        entry.start_year = year;
        entry.end_year = f.endyear || '';
        entry.status = 'Current';
        entry.current_position = f.position || '';
      } else if (sec === 'awards') {
        entry.awarding_body = cleanLatex(f.organization || '');
        entry.category = f.category || 'Recognition';
      } else if (sec === 'service') {
        entry.role = f.role || '';
        entry.organization = cleanLatex(f.organization || '');
        entry.type = f.type || 'Other';
        entry.start_year = year;
        entry.end_year = f.endyear || '';
      } else if (sec === 'courses') {
        entry.name = f.name || title;
        entry.code = f.code || '';
        entry.role = f.role || 'Instructor';
        entry.semester = f.semester || '';
        entry.institution = cleanLatex(f.institution || '');
      }
      out.push(entry);
    }
    return out;
  }

  /* ── Duplicate detection ── */
  function normalizeStr(s) {
    return String(s || '').toLowerCase().replace(/[^a-z0-9]/g, '').trim();
  }

  function findDuplicates(entry, existingData) {
    var dupes = [];
    var nTitle = normalizeStr(entry.title || entry.name || entry.role || '');
    if (!nTitle || nTitle.length < 4) return dupes;
    for (var i = 0; i < CV_SECTION_KEYS.length; i++) {
      var secKey = CV_SECTION_KEYS[i];
      var list = existingData[secKey] || [];
      for (var j = 0; j < list.length; j++) {
        var ex = list[j];
        var eTitle = normalizeStr(ex.title || ex.name || ex.role || '');
        if (!eTitle || eTitle.length < 4) continue;
        var titleMatch = (
          nTitle === eTitle ||
          (nTitle.length > 10 && eTitle.length > 10 &&
            (nTitle.indexOf(eTitle) >= 0 || eTitle.indexOf(nTitle) >= 0))
        );
        var doiMatch = entry.doi && ex.doi && normalizeStr(entry.doi) === normalizeStr(ex.doi);
        if (titleMatch || doiMatch) {
          dupes.push({ section: secKey, entry: ex, matchType: doiMatch ? 'doi' : 'title' });
          break; // one dupe per section is enough
        }
      }
    }
    return dupes;
  }

  return {
    fetchDOI: fetchDOI,
    fetchCitationCount: fetchCitationCount,
    fetchORCID: fetchORCID,
    orcidSectionFor: orcidSectionFor,
    parseBibtex: parseBibtex,
    findDuplicates: findDuplicates,
  };
})();
