/* library-public.js — public-share viewer (Firestore-direct, no auth).
 *
 * Reads ?id=<paper_id> from the URL and looks up the paper directly in
 * Firestore at `items/{id}` using the anonymous Firestore SDK. No sign-in
 * required for the recipient. The Firestore rule allows reads of items
 * docs only when `meta.library.public == true`, so non-shared papers
 * silently 404 (look the same as nonexistent).
 *
 * Why direct Firestore + not server.py: production hosting (godaddy) is
 * static-only; there's no /api/public/paper endpoint there. Pre-rendering
 * static JSON at deploy time was tried briefly but items.json on disk is
 * stale relative to Firestore (the lab's source of truth post-multi-tenant
 * migration), so the static files would lag by however long since the last
 * deploy. Reading Firestore live keeps shares working immediately.
 *
 * The signed Storage download URL embedded in `meta.library.public_url`
 * works for anyone — that's how the PDF actually loads.
 */

(function () {
  // Same Firebase project as firebase-bridge.js. Kept inline here so this
  // page stays standalone (no firebase-bridge.js, no api-firestore-adapter,
  // no profile-bootstrap — none of which are appropriate for an unauthed
  // public viewer).
  var FIREBASE_CONFIG = {
    apiKey:            'AIzaSyAnkKivjCcjAS8_Lp-R2JSIG4wSDSJBFI0',
    authDomain:        'mcgheelab-f56cc.firebaseapp.com',
    projectId:         'mcgheelab-f56cc',
    storageBucket:     'mcgheelab-f56cc.firebasestorage.app',
    messagingSenderId: '665438582202',
    appId:             '1:665438582202:web:57416863d588bcdeff9983',
  };

  function $(id) { return document.getElementById(id); }
  function esc(s) {
    return String(s == null ? '' : s).replace(/[&<>"']/g, function (c) {
      return ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c];
    });
  }

  function getPaperId() {
    try {
      var params = new URLSearchParams(window.location.search);
      var id = (params.get('id') || '').trim();
      if (!id) return '';
      // Strip anything that looks unsafe — Firestore enforces too, but
      // belt-and-braces avoids confusing fetch errors.
      if (/[\/\\]/.test(id) || id.indexOf('..') >= 0) return '';
      return id;
    } catch (_) { return ''; }
  }

  function authorLine(authors) {
    if (!Array.isArray(authors) || !authors.length) return '';
    return authors
      .map(function (a) { return [a.given, a.family].filter(Boolean).join(' '); })
      .filter(Boolean)
      .join('; ');
  }

  function renderEmpty(headline, body) {
    $('lp-pub-main').innerHTML =
      '<div class="lp-pub-empty">' +
        '<h2>' + esc(headline) + '</h2>' +
        '<p>' + esc(body || '') + '</p>' +
      '</div>';
  }

  function renderPaper(paper) {
    var journalLine = [
      paper.journal,
      paper.year,
      paper.volume && ('Vol ' + paper.volume),
      paper.issue && ('Iss ' + paper.issue),
      paper.pages,
    ].filter(Boolean).join(' · ');

    var metaRows = [];
    if (paper.doi)     metaRows.push(['DOI', '<a href="https://doi.org/' + esc(paper.doi) + '" target="_blank" rel="noopener">' + esc(paper.doi) + '</a>']);
    if (paper.year)    metaRows.push(['Year', esc(paper.year)]);
    if (paper.journal) metaRows.push(['Journal', esc(paper.journal)]);

    var main = $('lp-pub-main');
    main.innerHTML =
      '<div class="lp-pub-wrap">' +
        '<aside class="lp-pub-meta">' +
          '<h1>' + esc(paper.title || 'Untitled') + '</h1>' +
          '<div class="lp-pub-authors">' + esc(authorLine(paper.authors)) + '</div>' +
          '<div class="lp-pub-journal">' + esc(journalLine) + '</div>' +
          metaRows.map(function (kv) {
            return '<div class="lp-pub-row"><span class="k">' + esc(kv[0]) + '</span><span class="v">' + kv[1] + '</span></div>';
          }).join('') +
          (paper.public_url ? '<div style="margin-top:12px;"><a class="lp-pub-download" href="' + esc(paper.public_url) + '" target="_blank" rel="noopener">↓ Download PDF</a></div>' : '') +
          (paper.doi ? '<div style="margin-top:8px;"><a class="lp-pub-doi" href="https://doi.org/' + esc(paper.doi) + '" target="_blank" rel="noopener">View on publisher</a></div>' : '') +
          (paper.abstract ?
            '<div class="lp-pub-abstract"><h3>Abstract</h3><div>' + esc(paper.abstract) + '</div></div>' : '') +
        '</aside>' +
        '<section class="lp-pub-pdf">' +
          (paper.public_url
            ? '<iframe src="' + esc(paper.public_url) + '#zoom=page-fit" title="' + esc(paper.title || 'paper') + '"></iframe>'
            : '<div class="lp-pub-empty"><h2>No PDF</h2><p>This paper was shared without an attached PDF.</p></div>') +
        '</section>' +
      '</div>';

    if (paper.shared_by || paper.shared_at_iso) {
      var date = paper.shared_at_iso ? paper.shared_at_iso.slice(0, 10) : '';
      $('lp-pub-share').textContent = paper.shared_by
        ? ('Shared by ' + paper.shared_by + (date ? ' · ' + date : ''))
        : (date ? 'Shared ' + date : '');
    }
    document.title = (paper.title ? paper.title + ' — ' : '') + 'McGhee Lab';
  }

  /* Slim items/{id} doc into the same shape the page renders. Defensive about
   * field locations — items.json papers wrap citation metadata in
   * `meta.library`, but if that ever flattens we'll still pick fields up. */
  function slimFromItem(item) {
    var lib = (item.meta && item.meta.library) || {};
    return {
      id: item.id,
      title: item.title || lib.title || '',
      authors: lib.authors || [],
      year: lib.year || '',
      journal: lib.journal || '',
      volume: lib.volume || '',
      issue: lib.issue || '',
      pages: lib.pages || '',
      doi: lib.doi || '',
      abstract: lib.abstract || '',
      public_url: lib.public_url || '',
      shared_at_iso: lib.shared_at_iso || '',
      shared_by: lib.shared_by || '',
      _isPublic: !!lib.public,
    };
  }

  async function init() {
    var id = getPaperId();
    if (!id) {
      renderEmpty('No paper requested', 'This page expects a ?id=<paper_id> in the URL.');
      return;
    }
    if (typeof firebase === 'undefined' || !firebase.firestore) {
      renderEmpty('Could not load paper', 'Firebase SDK failed to load — check the network tab.');
      return;
    }
    try {
      if (!firebase.apps.length) {
        firebase.initializeApp(FIREBASE_CONFIG);
      }
      var doc = await firebase.firestore().collection('items').doc(id).get();
      if (!doc.exists) {
        renderEmpty('Paper not available', 'This paper either does not exist or has not been shared publicly.');
        return;
      }
      var item = Object.assign({ id: doc.id }, doc.data());
      var slim = slimFromItem(item);
      if (!slim._isPublic || !slim.public_url) {
        // Treat not-yet-shared the same as "doesn't exist" for the recipient.
        renderEmpty('Paper not available', 'This paper either does not exist or has not been shared publicly.');
        return;
      }
      renderPaper(slim);
    } catch (e) {
      // Most common: PERMISSION_DENIED if the paper isn't public (Firestore
      // rules block reads of non-public items). Surface as 404-equivalent.
      if (e && e.code === 'permission-denied') {
        renderEmpty('Paper not available', 'This paper either does not exist or has not been shared publicly.');
        return;
      }
      renderEmpty('Could not load paper', e.message || String(e));
    }
  }

  document.addEventListener('DOMContentLoaded', init);
})();
