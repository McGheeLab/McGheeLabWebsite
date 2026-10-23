/* research-references.js — V3.718, moved onto the grant V3.721
 *
 * The bibliography section of a grant's review page. A GRANT stores WHERE
 * its references come from, never the list itself:
 *
 *     ref_source: { kind: 'draft_citations', draft_id: '<builder draft id>' }
 *
 * The entries already live in the lab library (`items` where `type == 'paper'`
 * and `meta.library.is_library_entry`), each carrying
 * `meta.library.cited_in_drafts[]` — stamped when the paper bundle was
 * imported. So this reads them live through the registered `library/papers.json`
 * route: cite something new in the builder and it appears here with no
 * re-sync, and there is exactly one copy of every reference in the lab.
 *
 * Grouped newest-year-first because that is how a bibliography gets scanned
 * for "what is recent here". Entries with no DOI are flagged rather than
 * hidden — the GELS CAREER import left two of them thin, and a bibliography
 * that quietly drops its weakest rows is worse than one that points at them.
 *
 * V3.718 gave this its own card and its own `reference` level; V3.721 moved
 * it inside the grant, where Alex wanted it. Same renderer, one fewer doc to
 * keep in step, and no card that a stale build could misfile.
 *
 * Globals: window.RESEARCH_REFS.
 */
(function () {
  'use strict';

  var RD = window.RESEARCH_DATA;
  var esc = RD.esc;

  function libMeta(it) { return (it && it.meta && it.meta.library) || {}; }

  /** Every library entry cited by `draftId`, newest first. Returns [] on any
   * failure — a reference card that cannot reach the library shows an empty
   * state, never an error. */
  async function load(draftId) {
    if (!draftId) return [];
    try {
      var data = await api.load('library/papers.json');
      return ((data && data.papers) || [])
        .filter(function (it) {
          var L = libMeta(it);
          return L.is_library_entry && (L.cited_in_drafts || []).indexOf(draftId) !== -1;
        })
        .sort(function (a, b) {
          var ya = +libMeta(a).year || 0, yb = +libMeta(b).year || 0;
          return yb - ya || String(a.title || '').localeCompare(String(b.title || ''));
        });
    } catch (e) {
      console.warn('[research-references] load failed:', e && e.message);
      return [];
    }
  }

  /** "Smith, Jones & Lee" — first three, then et al. Authors arrive as
   * strings or {family,given} objects depending on the import source. */
  function authorLine(L) {
    var a = L.authors || [];
    if (!a.length) return '';
    var names = a.map(function (x) {
      if (typeof x === 'string') return x.split(',')[0].trim();
      return (x.family || x.last || x.name || '').trim();
    }).filter(Boolean);
    if (!names.length) return '';
    if (names.length <= 3) return names.join(', ');
    return names.slice(0, 3).join(', ') + ' et al.';
  }

  function row(it) {
    var L = libMeta(it);
    var venue = L.journal || L.journal_iso || '';
    var doi = L.doi || '';
    var thin = !doi && !L.pmid && !L.arxiv_id;
    return '<li class="rr-row' + (thin ? ' rr-thin' : '') + '">' +
      '<a class="rr-title" href="/rm/pages/library-paper.html?id=' + encodeURIComponent(it.id) + '">' +
        esc(it.title || '(untitled)') + '</a>' +
      '<div class="rr-meta">' +
        (authorLine(L) ? '<span class="rr-authors">' + esc(authorLine(L)) + '</span>' : '') +
        (venue ? '<span class="rr-venue">' + esc(venue) + '</span>' : '') +
        (doi
          ? '<a class="rr-doi" href="https://doi.org/' + encodeURIComponent(doi) + '" target="_blank" rel="noopener">doi</a>'
          : (thin ? '<span class="rr-flag" title="No DOI, PMID or arXiv id — added from parsed text. Open it in the library to enrich.">no identifier — enrich</span>' : '')) +
      '</div>' +
    '</li>';
  }

  function groupByYear(items) {
    var order = [], by = {};
    items.forEach(function (it) {
      var y = libMeta(it).year || 'Undated';
      if (!by[y]) { by[y] = []; order.push(y); }
      by[y].push(it);
    });
    return order.map(function (y) { return { year: y, items: by[y] }; });
  }

  /* Render into `host`. `opts.heading` false renders the list alone (the
   * grant review embeds it under its own heading). */
  async function render(host, card, opts) {
    if (!host) return;
    opts = opts || {};
    var src = card && card.ref_source;
    if (!src || !src.draft_id) {
      host.innerHTML = '<p class="rf-empty-sm">This grant has no source draft set, so there is nothing to list yet.</p>';
      return;
    }
    host.innerHTML = '<p class="rf-empty-sm">Loading the bibliography…</p>';
    var items = await load(src.draft_id);
    if (!items.length) {
      host.innerHTML = '<p class="rf-empty-sm">No library entries are cited by that draft yet.</p>';
      return;
    }
    var thin = items.filter(function (it) {
      var L = libMeta(it);
      return !L.doi && !L.pmid && !L.arxiv_id;
    }).length;

    host.innerHTML =
      (opts.heading === false ? '' :
        '<div class="rr-head"><h2>' + ICON.svg('books') + ' References cited ' +
          '<span class="rf-band-count">' + items.length + '</span></h2>' +
          '<a class="rf-btn rf-btn-sm" href="/rm/pages/paper-builder.html?paper=' +
            encodeURIComponent(src.draft_id) + '">Open the draft →</a>' +
        '</div>') +
      '<p class="rr-note">Read live from the lab library — cite something new in the builder and it appears here.' +
        (thin ? ' <strong>' + thin + '</strong> ' + (thin === 1 ? 'entry has' : 'entries have') +
                ' no DOI, PMID or arXiv id; open one to enrich it.' : '') +
      '</p>' +
      groupByYear(items).map(function (g) {
        return '<section class="rr-year">' +
          '<h3>' + esc(g.year) + ' <span class="rr-count">' + g.items.length + '</span></h3>' +
          '<ul class="rr-list">' + g.items.map(row).join('') + '</ul>' +
        '</section>';
      }).join('');
  }

  /** Just the count — the grant review's summary line, without rendering. */
  async function count(card) {
    var src = card && card.ref_source;
    if (!src || !src.draft_id) return 0;
    return (await load(src.draft_id)).length;
  }

  window.RESEARCH_REFS = { render: render, load: load, count: count };
})();
