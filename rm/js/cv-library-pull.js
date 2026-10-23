/* cv-library-pull.js — "Pull from lab library" for the CV editor (V3.356).
 *
 * The RM library (api route library/papers.json → items collection, entries
 * flagged meta.library.is_library_entry) stores full publication metadata:
 * authors[{given,family}], journal, year, volume, issue, pages, doi. This
 * module lets a lab member import their own publications from it instead of
 * typing them in.
 *
 * Library entries carry NO author↔uid link (only paper drafts have
 * coauthorUids), so matching is by NAME — family-name match, plus given-
 * initial agreement when both sides have a given name — and always behind a
 * review checklist: matches are pre-checked, everything else is listed
 * unchecked under "show all", and nothing imports without the user
 * confirming. Duplicates against the existing CV (CVImport.findDuplicates)
 * are flagged and unchecked by default.
 *
 * Usage (from cv-editor.js):
 *   CV_LIBRARY_PULL.open({
 *     getDoc: () => state.doc,          // current cvData document
 *     save: (payload) => savePayload(payload),   // editor's write path
 *     profileName: 'Alex McGhee',       // name to match against
 *     onDone: () => render(),
 *   });
 */

var CV_LIBRARY_PULL = (function () {

  function escHtml(s) {
    return String(s == null ? '' : s).replace(/[&<>"']/g, function (c) {
      return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c];
    });
  }

  /* "Alex Q. McGhee" → { given: 'alex q.', family: 'mcghee' } */
  function splitName(name) {
    var parts = String(name || '').trim().split(/\s+/);
    if (!parts.length || !parts[0]) return null;
    return {
      family: parts[parts.length - 1].toLowerCase(),
      given: parts.slice(0, -1).join(' ').toLowerCase(),
    };
  }

  function authorMatches(me, author) {
    if (!me || !author || !author.family) return false;
    if (String(author.family).toLowerCase() !== me.family) return false;
    var g = String(author.given || '').toLowerCase();
    if (!g || !me.given) return true;           // family-only match when a given name is missing
    return g[0] === me.given[0];                // given initials must agree
  }

  /* meta.library.authors[{given,family}] → "McGhee A, Smith J" (CV format). */
  function formatAuthors(list) {
    return (list || []).map(function (a) {
      var initials = String(a.given || '').split(/\s+/).map(function (w) { return w ? w[0].toUpperCase() : ''; }).join('');
      return [a.family, initials].filter(Boolean).join(' ');
    }).filter(Boolean).join(', ');
  }

  function libToEntry(lib) {
    return {
      _id: cvUid(),
      title: lib.title || '',
      authors: formatAuthors(lib.authors),
      journal: lib.journal || '',
      year: lib.year || '',
      doi: lib.doi || '',
      volume: lib.volume || '',
      issue: lib.issue || '',
      pages: lib.pages || '',
      status: 'Published',
    };
  }

  async function loadLibraryPapers() {
    var data = await api.load('library/papers.json');
    return ((data && data.papers) || []).filter(function (it) {
      return it && it.meta && it.meta.library && it.meta.library.is_library_entry;
    }).map(function (it) {
      var lib = Object.assign({}, it.meta.library);
      if (!lib.title) lib.title = it.title || it.name || '';
      return lib;
    });
  }

  function open(ctx) {
    if (typeof firebridge === 'undefined' || !firebridge.isReady()) {
      if (typeof TOAST !== 'undefined') TOAST.warn('Not signed in', { detail: 'Sign in from Settings to use this.' });
      return;
    }
    var me = splitName(ctx.profileName);

    var back = document.createElement('div');
    back.style.cssText = 'position:fixed;inset:0;background:rgba(0,0,0,.45);z-index:200;display:flex;align-items:flex-start;justify-content:center;padding:30px 12px;overflow-y:auto';
    var panel = document.createElement('div');
    panel.className = 'cve-dialog-panel';
    panel.style.cssText = 'background:#fff;border-radius:10px;max-width:820px;width:100%;padding:18px 20px;box-shadow:0 20px 40px rgba(0,0,0,.25)';
    panel.innerHTML =
      '<h3 style="margin:0 0 12px 0;font-size:15px">' + ICON.svg('books') + ' Pull publications from the lab library</h3>' +
      '<p style="margin:0 0 10px 0;font-size:13px;color:#374151">Papers in the lab library that list <strong>' + escHtml(ctx.profileName || 'you') + '</strong> as an author are pre-checked (matched by name — review before importing). Duplicates already on your CV are skipped by default.</p>' +
      '<div style="display:flex;gap:10px;align-items:center;margin-bottom:8px">' +
        '<span id="cvlp-status" style="font-size:12px;color:#6b7280;flex:1">Loading library…</span>' +
        '<label style="font-size:12px;color:#374151;display:flex;gap:5px;align-items:center;cursor:pointer">' +
          '<input type="checkbox" id="cvlp-all"> show all library papers</label>' +
      '</div>' +
      '<div id="cvlp-rows"></div>' +
      '<div style="display:flex;gap:8px;margin-top:12px;padding-top:10px;border-top:1px solid #f1f5f9;justify-content:flex-end">' +
        '<button class="btn" id="cvlp-close">Close</button>' +
        '<button class="btn btn-primary" id="cvlp-import" disabled>Import selected</button>' +
      '</div>';
    back.appendChild(panel);
    document.body.appendChild(back);
    var close = function () { if (back.parentNode) document.body.removeChild(back); };
    safeCloseOnBackdrop(back, panel, close);
    panel.querySelector('#cvlp-close').addEventListener('click', close);

    var statusEl = panel.querySelector('#cvlp-status');
    var rowsEl = panel.querySelector('#cvlp-rows');
    var importBtn = panel.querySelector('#cvlp-import');
    var allToggle = panel.querySelector('#cvlp-all');
    var rows = [];

    function renderRows() {
      var showAll = allToggle.checked;
      var visible = rows.filter(function (r) { return showAll || r.mine; });
      if (!visible.length) {
        rowsEl.innerHTML = '<div style="padding:16px;text-align:center;color:#6b7280;font-size:13px">' +
          (rows.length ? 'No name matches — tick "show all library papers" to browse everything.' : 'The lab library has no publication entries yet.') +
          '</div>';
        importBtn.disabled = true;
        return;
      }
      var html = '<div style="max-height:340px;overflow:auto;border:1px solid #e5e7eb;border-radius:6px">';
      visible.forEach(function (r) {
        var idx = rows.indexOf(r);
        html += '<div style="display:flex;gap:8px;padding:8px 10px;border-bottom:1px solid #f1f5f9;align-items:flex-start">' +
          '<input type="checkbox" data-cvlp-idx="' + idx + '" ' + (r.checked ? 'checked' : '') + ' style="margin-top:3px">' +
          '<div style="flex:1;min-width:0">' +
            '<div style="font-size:13px;color:#111827">' + escHtml(r.lib.title || '(untitled)') +
              (r.isDupe ? ' <span style="color:#dc2626;font-size:11px">[already on CV]</span>' : '') +
              (r.mine ? '' : ' <span style="color:#9ca3af;font-size:11px">[no name match]</span>') +
            '</div>' +
            '<div style="font-size:11px;color:#6b7280">' + escHtml([formatAuthors(r.lib.authors), r.lib.journal, r.lib.year].filter(Boolean).join(' · ')) + '</div>' +
          '</div>' +
        '</div>';
      });
      html += '</div>';
      rowsEl.innerHTML = html;
      importBtn.disabled = false;
      rowsEl.querySelectorAll('[data-cvlp-idx]').forEach(function (cb) {
        cb.addEventListener('change', function () {
          rows[Number(cb.dataset.cvlpIdx)].checked = cb.checked;
        });
      });
    }

    allToggle.addEventListener('change', renderRows);

    importBtn.addEventListener('click', async function () {
      var picked = rows.filter(function (r) { return r.checked; });
      if (!picked.length) { statusEl.textContent = 'Nothing selected.'; return; }
      importBtn.disabled = true;
      statusEl.textContent = 'Importing ' + picked.length + '…';
      var doc = ctx.getDoc();
      doc.journals = (doc.journals || []).concat(picked.map(function (r) { return libToEntry(r.lib); }));
      try {
        await ctx.save({ journals: doc.journals });
        statusEl.textContent = '';
        if (typeof TOAST !== 'undefined') TOAST.success('Imported ' + picked.length + ' publication' + (picked.length === 1 ? '' : 's') + ' from the library');
        close();
        if (ctx.onDone) ctx.onDone();
      } catch (err) {
        importBtn.disabled = false;
        statusEl.textContent = 'Save failed: ' + err.message;
      }
    });

    loadLibraryPapers().then(function (libs) {
      var doc = ctx.getDoc();
      rows = libs.map(function (lib) {
        var mine = (lib.authors || []).some(function (a) { return authorMatches(me, a); });
        var isDupe = CVImport.findDuplicates({ title: lib.title, doi: lib.doi }, doc).length > 0;
        return { lib: lib, mine: mine, isDupe: isDupe, checked: mine && !isDupe };
      });
      // Matches first, then by year desc.
      rows.sort(function (a, b) {
        if (a.mine !== b.mine) return a.mine ? -1 : 1;
        return String(b.lib.year || '').localeCompare(String(a.lib.year || ''));
      });
      var matches = rows.filter(function (r) { return r.mine; }).length;
      statusEl.textContent = libs.length + ' library papers · ' + matches + ' name match' + (matches === 1 ? '' : 'es');
      renderRows();
    }).catch(function (err) {
      statusEl.textContent = 'Library load failed: ' + (err.message || err);
    });
  }

  return { open: open };
})();
