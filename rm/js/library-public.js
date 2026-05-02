/* library-public.js — public-share viewer.
 *
 * Reads ?id=<paper_id> from the URL, calls /api/public/paper/<id> for the
 * minimal metadata + signed Storage URL, and renders a clean read-only
 * page that doesn't require any sign-in. The signed URL embedded in
 * `public_url` works for anyone — that's the whole point.
 */

(function () {
  function $(id) { return document.getElementById(id); }
  function esc(s) {
    return String(s ?? '').replace(/[&<>"']/g, c =>
      ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c])
    );
  }

  function getPaperId() {
    try {
      const params = new URLSearchParams(window.location.search);
      const id = (params.get('id') || '').trim();
      if (!id) return '';
      // Strip anything that looks unsafe — server enforces too, but
      // belt-and-braces avoids confusing fetch errors.
      if (/[\/\\]/.test(id) || id.includes('..')) return '';
      return id;
    } catch (_) { return ''; }
  }

  function authorLine(authors) {
    if (!Array.isArray(authors) || !authors.length) return '';
    return authors
      .map(a => [a.given, a.family].filter(Boolean).join(' '))
      .filter(Boolean)
      .join('; ');
  }

  function renderEmpty(headline, body) {
    $('lp-pub-main').innerHTML = `
      <div class="lp-pub-empty">
        <h2>${esc(headline)}</h2>
        <p>${esc(body || '')}</p>
      </div>
    `;
  }

  function renderPaper(paper) {
    const journalLine = [
      paper.journal,
      paper.year,
      paper.volume && `Vol ${paper.volume}`,
      paper.issue && `Iss ${paper.issue}`,
      paper.pages,
    ].filter(Boolean).join(' · ');

    const metaRows = [];
    if (paper.doi)   metaRows.push(['DOI', `<a href="https://doi.org/${esc(paper.doi)}" target="_blank" rel="noopener">${esc(paper.doi)}</a>`]);
    if (paper.year)  metaRows.push(['Year', esc(paper.year)]);
    if (paper.journal) metaRows.push(['Journal', esc(paper.journal)]);

    const main = $('lp-pub-main');
    main.innerHTML = `
      <div class="lp-pub-wrap">
        <aside class="lp-pub-meta">
          <h1>${esc(paper.title || 'Untitled')}</h1>
          <div class="lp-pub-authors">${esc(authorLine(paper.authors))}</div>
          <div class="lp-pub-journal">${esc(journalLine)}</div>
          ${metaRows.map(([k, v]) => `<div class="lp-pub-row"><span class="k">${esc(k)}</span><span class="v">${v}</span></div>`).join('')}
          ${paper.public_url ? `<div style="margin-top:12px;"><a class="lp-pub-download" href="${esc(paper.public_url)}" target="_blank" rel="noopener">↓ Download PDF</a></div>` : ''}
          ${paper.doi ? `<div style="margin-top:8px;"><a class="lp-pub-doi" href="https://doi.org/${esc(paper.doi)}" target="_blank" rel="noopener">View on publisher</a></div>` : ''}
          ${paper.abstract ? `
            <div class="lp-pub-abstract">
              <h3>Abstract</h3>
              <div>${esc(paper.abstract)}</div>
            </div>` : ''}
        </aside>
        <section class="lp-pub-pdf">
          ${paper.public_url
            ? `<iframe src="${esc(paper.public_url)}#zoom=page-fit" title="${esc(paper.title || 'paper')}"></iframe>`
            : `<div class="lp-pub-empty"><h2>No PDF</h2><p>This paper was shared without an attached PDF.</p></div>`}
        </section>
      </div>
    `;

    if (paper.shared_by || paper.shared_at_iso) {
      const date = paper.shared_at_iso ? paper.shared_at_iso.slice(0, 10) : '';
      $('lp-pub-share').textContent = paper.shared_by
        ? `Shared by ${paper.shared_by}${date ? ' · ' + date : ''}`
        : (date ? `Shared ${date}` : '');
    }
    document.title = (paper.title ? paper.title + ' — ' : '') + 'McGhee Lab';
  }

  async function init() {
    const id = getPaperId();
    if (!id) {
      renderEmpty('No paper requested', 'This page expects a ?id=<paper_id> in the URL.');
      return;
    }
    try {
      const res = await fetch(`/api/public/paper/${encodeURIComponent(id)}`, { credentials: 'omit' });
      if (res.status === 404) {
        renderEmpty('Paper not available', 'This paper either does not exist or has not been shared publicly.');
        return;
      }
      if (!res.ok) {
        renderEmpty('Could not load paper', `Server returned ${res.status} ${res.statusText}.`);
        return;
      }
      const paper = await res.json();
      renderPaper(paper);
    } catch (e) {
      renderEmpty('Network error', e.message || String(e));
    }
  }

  document.addEventListener('DOMContentLoaded', init);
})();
