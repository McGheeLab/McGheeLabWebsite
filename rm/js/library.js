/* library.js — Paperpile-style library page (list view + upload + search).
 *
 * Phase 1 scope:
 *   - Drag-drop PDF upload → Firebase Cloud Storage + DOI lookup → items.json
 *   - List view of all paper items with library entry
 *   - Fielded search (title:, author:, year:, journal:) over the in-memory list
 *   - "Open PDF" → signed URL in a new tab
 *
 * Out of scope for Phase 1: pdf.js viewer, annotations, claims, BibTeX. Those
 * land in later phases (see the plan file).
 */

(function () {
  // V3.206 — single in-memory pool. The library page only ever reads /
  // writes type='paper' items, so we drop the parallel `_items` list and
  // load through the type-filtered `library/papers.json` route. `_items`
  // stays as an alias for back-compat with code that scans the pool for
  // dedup (LIBRARY_UPLOAD.findDuplicate, _onTableClick, _syncedThisSession).
  let _items = [];                  // alias of _libraryPapers
  /* V3.352 — draft id → title for the linkage badge tooltip. */
  let _draftTitleById = {};
  /* V3.367 — theme id → name for the theme: search token. Loaded
   * fire-and-forget in _load(); empty map on failure (token then
   * matches raw ids only). */
  let _themeNameById = {};
  let _libraryPapers = [];          // filter: type=paper, meta.library.is_library_entry
  let _filterText = '';
  let _busy = false;
  let _tagFilter = '';              // active tag-prefix filter (clicking a chip)
  let _missingOnly = false;         // V3.311 — missing-PDF queue filter
  let _tagIndex = null;             // built from _libraryPapers on each _load

  // V3.206 — debounced search + memoized parsed query. _searchDebounce
  // holds the pending setTimeout id so a fast typer collapses N keystrokes
  // into one render. _parsedQueryCache memoizes _parseQuery(_filterText)
  // since the same string is parsed once per render + once per row
  // matched; cheap to skip on rapid edits.
  let _searchDebounce = 0;
  let _parsedQueryCache = { key: null, val: null };

  // V3.206 — chunked render bookkeeping. Library lists with N>50 rows
  // block the main thread on first paint; instead we paint the first 50
  // synchronously and schedule the rest in idle-time batches of 100.
  // _renderToken cancels in-flight batches when a new render starts.
  const RENDER_FIRST_BATCH = 50;
  const RENDER_BATCH_SIZE  = 100;
  let _renderToken = 0;

  function _setBusy(msg) {
    _busy = !!msg;
    const el = document.getElementById('library-status');
    if (el) el.textContent = msg || '';
  }

  function _toast(msg, kind) {
    const el = document.getElementById('library-toast');
    if (!el) {
      console.log('[library]', msg);
      return;
    }
    el.textContent = msg;
    el.className = 'library-toast ' + (kind || '');
    el.style.display = 'block';
    clearTimeout(_toast._t);
    _toast._t = setTimeout(() => { el.style.display = 'none'; }, 4000);
  }

  // ---- Loading -----------------------------------------------------------

  async function _load() {
    _setBusy('Loading library…');
    try {
      // V3.206 — fast-path: read only type='paper' items via the dedicated
      // library/papers.json route. Server-side `where('type','==','paper')`
      // drops grants/courses/tools from the read; LONG cache TTL +
      // MAX(updatedAt) probe means repeat visits hit IDB. Old path read
      // every items.json doc and filtered client-side.
      //
      // V3.207 fallback: in local dev the shadow-JSON fallback for the
      // new route hits `/api/data/library/papers.json` which doesn't
      // exist (server.py only ships `data/items.json`), so an empty
      // Firestore items collection leaves the page empty. Retry against
      // the unified items.json route and filter client-side. Harmless
      // in production: Firestore returns rows directly and this branch
      // never fires.
      let papers = [];
      try {
        const data = await api.load('library/papers.json');
        papers = (data && data.papers) || [];
      } catch (e) {
        console.warn('[library] library/papers.json load failed:', e.message || e);
      }
      /* V3.352 — draft titles for the "→ N drafts" linkage badge
       * tooltip. Grant titles would need full items.json; the tooltip
       * falls back to the raw id for those (future work). */
      try {
        const drafts = await api.load('projects/papers.json');
        _draftTitleById = {};
        ((drafts && drafts.papers) || []).forEach((d) => {
          if (d && d.id) _draftTitleById[d.id] = d.title || d.id;
        });
      } catch (e) { _draftTitleById = {}; }
      /* V3.365 — full association resolver (titles + kind + derived
       * active/inactive, grants included). Fire-and-forget: badges fall
       * back to _draftTitleById/raw counts until it lands, then the
       * .then re-render upgrades them. */
      if (window.LIBRARY_ASSOC) {
        LIBRARY_ASSOC.loadDraftInfo()
          .then(() => _render())
          .catch(() => { /* badges keep their fallback rendering */ });
      }
      /* V3.367 — theme names for the theme: search token. Direct
       * firestore get (labThemes is not an api route by design). */
      try {
        if (typeof firebridge !== 'undefined' && firebridge.db &&
            firebridge.isLabMember && firebridge.isLabMember()) {
          firebridge.db().collection('labThemes').get().then((snap) => {
            _themeNameById = {};
            snap.docs.forEach((d) => {
              _themeNameById[d.id] = (d.data() || {}).name || d.id;
            });
          }).catch(() => { _themeNameById = {}; });
        }
      } catch (e) { _themeNameById = {}; }
      if (!papers.length) {
        try {
          const fallback = await api.load('items.json');
          const all = (fallback && fallback.items) || [];
          papers = all.filter(it => it.type === 'paper');
          if (papers.length) {
            console.info(`[library] V3.206 fast-path empty; fell back to items.json (${papers.length} papers).`);
          }
        } catch (e) {
          console.warn('[library] items.json fallback load failed:', e.message || e);
        }
      }
      _libraryPapers = papers.filter(it =>
        it.meta && it.meta.library && it.meta.library.is_library_entry
      );
      _items = _libraryPapers;     // back-compat alias for dedup callers
      _parsedQueryCache = { key: null, val: null };
      // Refresh the tag autocomplete index after every load. Cheap — one
      // O(papers × tags-per-paper) walk and the result is reused for chip
      // rendering, autocomplete, and prefix filtering.
      _tagIndex = window.LIBRARY_TAGS ? LIBRARY_TAGS.buildIndex(_libraryPapers) : null;
    } finally {
      _setBusy('');
    }
  }

  // WHOLE-COLLECTION replace. Reserve this for genuinely multi-row writes
  // (the capture-sync merge). Every other caller should use _saveOne():
  // this rewrites all ~158 paper docs in one batch AND deletes any server
  // doc missing from `_libraryPapers`, so a tab holding a pre-import
  // snapshot silently deletes rows someone else just added (V3.583 — the
  // same reasoning that moved the paper-import flow to a direct set in
  // V3.485).
  async function _saveItems() {
    // V3.206 — write to the type='paper' route. The Firestore adapter
    // scopes the collection-replace batch to docs matching the route's
    // `where` clause, so grants/courses/tools in the items collection
    // are left untouched. Each row in the payload gets `type:'paper'`
    // stamped by the route's discriminator on the way down.
    await api.save('library/papers.json', { papers: _libraryPapers });
    _items = _libraryPapers;
  }

  // ---- Search ------------------------------------------------------------

  function _parseQuery(q) {
    // Supported: free text + field:value tokens (title:, author:, year:,
    // journal:, tag:, draft:). Quotes optional. Negation via leading "-".
    // tag: takes a colon-delimited prefix, e.g. tag:research:papers:2026
    // — the tokenizer captures everything from the colon to the next
    // whitespace as one value, including embedded colons.
    // draft: (V3.365) matches against linked_drafts ids AND their
    // resolved draft/grant titles, e.g. draft:gels or draft:prostate.
    // theme: (V3.367) matches meta.library.themes ids AND theme names.
    const fields = { title: [], author: [], year: [], journal: [], tag: [], draft: [], theme: [] };
    const free = [];
    const negFree = [];
    const re = /(-?)(?:(title|author|year|journal|tag|draft|theme):)?(?:"([^"]+)"|(\S+))/g;
    let m;
    while ((m = re.exec(q || '')) !== null) {
      const neg = m[1] === '-';
      const field = (m[2] || '').toLowerCase();
      const value = (m[3] || m[4] || '').toLowerCase();
      if (!value) continue;
      if (field) fields[field].push(value);
      else if (neg) negFree.push(value);
      else free.push(value);
    }
    return { fields, free, negFree };
  }

  function _matches(paper, parsed) {
    const lib = paper.meta.library;
    const title = (paper.title || '').toLowerCase();
    const journal = (lib.journal || '').toLowerCase();
    const year = (lib.year || '').toString();
    const authorBlob = (lib.authors || [])
      .map(a => `${a.given || ''} ${a.family || ''}`.trim())
      .join(' ')
      .toLowerCase();
    const tags = (window.LIBRARY_TAGS ? LIBRARY_TAGS.getTags(paper) : []) || [];

    for (const t of parsed.fields.title) {
      if (!title.includes(t)) return false;
    }
    for (const t of parsed.fields.author) {
      if (!authorBlob.includes(t)) return false;
    }
    for (const t of parsed.fields.year) {
      if (!year.startsWith(t)) return false;
    }
    for (const t of parsed.fields.journal) {
      if (!journal.includes(t)) return false;
    }
    for (const t of parsed.fields.tag) {
      // Each tag: token is a prefix that any of the paper's tags must match.
      if (!window.LIBRARY_TAGS || !LIBRARY_TAGS.matchPrefix(tags, t)) return false;
    }
    if (parsed.fields.draft.length) {
      // V3.365 — draft: token matches linked draft ids and resolved titles.
      const linked = Array.isArray(lib.linked_drafts) ? lib.linked_drafts : [];
      const info = window.LIBRARY_ASSOC ? LIBRARY_ASSOC.getDraftInfoSync() : null;
      const draftHay = linked.map((id) => {
        const resolved = (info && info.get(id)) ? info.get(id).title : (_draftTitleById[id] || '');
        return `${id} ${resolved}`.toLowerCase();
      }).join(' ');
      for (const t of parsed.fields.draft) {
        if (!draftHay.includes(t)) return false;
      }
    }
    if (parsed.fields.theme.length) {
      // V3.367 — theme: token matches theme ids and resolved names.
      const themes = Array.isArray(lib.themes) ? lib.themes : [];
      const themeHay = themes.map((id) =>
        `${id} ${_themeNameById[id] || ''}`.toLowerCase()
      ).join(' ');
      for (const t of parsed.fields.theme) {
        if (!themeHay.includes(t)) return false;
      }
    }
    const all = `${title} ${journal} ${year} ${authorBlob} ${tags.join(' ')}`;
    for (const t of parsed.free) {
      if (!all.includes(t)) return false;
    }
    for (const t of parsed.negFree) {
      if (all.includes(t)) return false;
    }
    return true;
  }

  // ---- Upload pipeline ---------------------------------------------------

  async function _handleFiles(files) {
    if (!files || !files.length) return;
    if (!firebase || !firebase.auth || !firebase.auth().currentUser) {
      _toast('Sign in (top-right avatar) to upload PDFs.', 'error');
      return;
    }
    for (const file of files) {
      try {
        await _ingestOne(file);
      } catch (err) {
        console.error(err);
        _toast(`Upload failed for ${file.name}: ${err.message || err}`, 'error');
      }
    }
    await _load();
    _render();
  }

  // A title-search hit is fuzzy — CrossRef returns its best guess even for
  // a bad query — so never silent-apply it. The user is the fuzzy matcher.
  function _confirmTitleMatch(contextLine, meta) {
    const list = meta.authors || [];
    const authors = list.slice(0, 3).map(a => a.family).filter(Boolean).join(', ')
      + (list.length > 3 ? ' et al.' : '');
    return window.confirm(
      `${contextLine}\n\n` +
      `Best metadata match:\n${meta.title || '(untitled)'}\n` +
      `${[authors, meta.year, meta.journal].filter(Boolean).join(' · ')}\n\n` +
      `Use this metadata?`
    );
  }

  // V3.497 — a title-based library match is fuzzy, so confirm before attaching
  // the incoming PDF to that existing entry (Cancel adds it as a new paper).
  function _confirmAttach(match, filename) {
    const lib = (match.meta && match.meta.library) || {};
    return window.confirm(
      `"${filename}" looks like it's already in your library (matched by title):\n\n` +
      `${match.title || '(untitled)'}\n` +
      `${[_authorLine(lib.authors), lib.year, lib.journal].filter(Boolean).join(' · ')}\n\n` +
      `Attach this PDF to that existing entry?\n(Cancel adds it as a new paper.)`
    );
  }

  async function _ingestOne(file) {
    if (file.type !== 'application/pdf' && !/\.pdf$/i.test(file.name)) {
      throw new Error('Only PDF files are supported.');
    }
    _setBusy(`Hashing ${file.name}…`);
    const fullHash = await LIBRARY_UPLOAD.sha256Hex(file);
    const shortHash = fullHash.slice(0, 16);

    // 1. Dedupe against existing library items
    const dup = LIBRARY_UPLOAD.findDuplicate(fullHash, _items)
             || LIBRARY_UPLOAD.findDuplicate(shortHash, _items);
    if (dup) {
      _toast(`Skipped duplicate (already in library as "${dup.title}").`, 'info');
      return;
    }

    // 2. Sniff first-page text → DOI guess
    _setBusy(`Reading first page of ${file.name}…`);
    let firstPage = { text: '', doi_guess: '', arxiv_guess: '' };
    try {
      firstPage = await LIBRARY_METADATA.extractFirstPage(file);
    } catch (e) {
      console.warn('[library] first-page extract failed:', e.message);
    }

    // 3. Try metadata lookup based on the sniff
    _setBusy(`Looking up metadata for ${file.name}…`);
    let meta = {};
    let titleGuess = '';
    try {
      if (firstPage.doi_guess) {
        meta = await LIBRARY_METADATA.lookup({ doi: firstPage.doi_guess });
      } else if (firstPage.arxiv_guess) {
        meta = await LIBRARY_METADATA.lookup({ arxiv_id: firstPage.arxiv_guess });
      } else {
        // No identifier on page 1 — fall back to a title search. V3.308:
        // prefer the largest-font run pdf.js saw (title_guess) over the
        // old first-line heuristic, and confirm before applying since a
        // title match is fuzzy.
        titleGuess = (firstPage.title_guess || '').trim();
        if (!titleGuess && firstPage.text) {
          titleGuess = (firstPage.text.split('\n').find(l => l.trim().length > 12) || '').trim();
        }
        if (titleGuess) {
          const hit = await LIBRARY_METADATA.lookup({ title: titleGuess.slice(0, 200) });
          if (hit && !hit.error &&
              _confirmTitleMatch(`No DOI or arXiv id found in "${file.name}" — searched by title instead. Cancel keeps the PDF with its own title.`, hit)) {
            meta = hit;
          }
        }
      }
    } catch (e) {
      console.warn('[library] metadata lookup failed:', e.message);
    }
    if (!meta || meta.error || !meta.title) {
      meta = {
        title: titleGuess || file.name.replace(/\.pdf$/i, ''),
        authors: [],
        year: '',
        journal: '',
        source: 'manual',
      };
    }

    // 3b. V3.497 — dedupe against an EXISTING library entry before creating a
    // new one. The step-1 hash dedupe only sees rows that already have a PDF,
    // so a metadata-only entry is invisible to it. Match by identifier
    // (DOI/PMID/arXiv → auto) or title+year (→ confirm). A PDF-less match gets
    // THIS pdf attached instead of a duplicate row; a match that already has a
    // PDF is skipped (no dup, no clobber).
    const hit = LIBRARY_UPLOAD.findExistingEntry
      ? LIBRARY_UPLOAD.findExistingEntry(meta, _items)
      : null;
    if (hit) {
      const match = hit.item;
      match.meta = match.meta || {};
      match.meta.library = match.meta.library || {};
      const mlib = match.meta.library;
      const isTitleMatch = hit.matchedBy === 'title';
      // Decide up front — never prompt for a match we're going to skip, and
      // never drop the file on a fuzzy match to an already-complete entry.
      if (mlib.pdf) {
        if (!isTitleMatch) {
          // Confident (identifier) match that already has a PDF → same paper,
          // nothing to do.
          _setBusy('');
          _toast(`"${match.title}" is already in the library with a PDF — skipped.`, 'info');
          return;
        }
        // Fuzzy title match to an entry that already has a PDF → probably a
        // different paper (or a re-scan). Fall through and add as a new entry
        // rather than silently discarding the upload.
      } else if (!isTitleMatch || _confirmAttach(match, file.name)) {
        // Existing entry has NO PDF and this is a confident match (or the user
        // confirmed the fuzzy one) → attach THIS pdf to it.
        _setBusy(`Attaching PDF to "${match.title}"…`);
        const attachInfo = await LIBRARY_UPLOAD.uploadPdf(match.id, file);
        mlib.pdf = {
          storage_path: attachInfo.storage_path,
          hash: attachInfo.hash,
          filename_safe: `${match.id}.pdf`,
          size_bytes: attachInfo.size_bytes,
          uploaded_at: attachInfo.uploaded_at,
          uploaded_by: attachInfo.uploaded_by,
          source: 'manual_attach',
        };
        delete mlib.pdf_status;   // clear an old "unobtainable" flag now that it's here
        _setBusy('Saving library…');
        await _saveOne(match);   // V3.583 — one doc, not the whole collection
        _setBusy('');
        _toast(`Attached PDF to existing entry "${match.title}".`, 'ok');
        if (LIBRARY_UPLOAD.parseAndCacheRefs) {
          LIBRARY_UPLOAD.parseAndCacheRefs(match.id, file).catch(e =>
            console.warn('[library] attach ref parse failed:', e));
        }
        if (LIBRARY_UPLOAD.enrichItemFromSemanticScholar) {
          LIBRARY_UPLOAD.enrichItemFromSemanticScholar(match.id).catch(e =>
            console.warn('[library] attach SS enrichment failed:', e));
        }
        return;
      }
      // Identifier match can't reach here; a title match either had a PDF
      // already or was declined → fall through and create a new entry.
    }

    // 4. Build a paper item to know the ID before uploading
    const provisional = LIBRARY_METADATA.buildPaperItem(meta, null, null);
    let paperId = provisional.id;
    // If id collides, append the hash to disambiguate
    if (_items.some(it => it.id === paperId)) {
      paperId = `${paperId}-${shortHash.slice(0, 6)}`;
    }

    // 5. Upload PDF to Firebase Cloud Storage
    _setBusy(`Uploading ${file.name}…`);
    const pdfInfo = await LIBRARY_UPLOAD.uploadPdf(paperId, file);

    // 6. Build final item + persist
    const item = LIBRARY_METADATA.buildPaperItem(meta, pdfInfo, null);
    item.id = paperId;
    _libraryPapers.push(item);
    _items = _libraryPapers;
    _setBusy(`Saving library…`);
    await _saveOne(item);   // V3.583 — one doc, not the whole collection
    _setBusy('');
    _toast(`Added "${item.title}".`, 'ok');
    // V3.93 — fire-and-forget background ref parse so the citation
    // panel is pre-populated when the user opens the paper.
    if (LIBRARY_UPLOAD.parseAndCacheRefs) {
      LIBRARY_UPLOAD.parseAndCacheRefs(item.id, file).catch(e =>
        console.warn('[library] background ref parse failed:', e));
    }
    // V3.112 — fire-and-forget Semantic Scholar enrichment for
    // structured references + cited-by + abstract + tldr.
    if (LIBRARY_UPLOAD.enrichItemFromSemanticScholar) {
      LIBRARY_UPLOAD.enrichItemFromSemanticScholar(item.id).catch(e =>
        console.warn('[library] SS enrichment failed:', e));
    }
  }

  // ---- Rendering ---------------------------------------------------------

  function _escape(s) {
    return String(s ?? '').replace(/[&<>"']/g, c => ({
      '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;'
    }[c]));
  }

  function _authorLine(authors) {
    if (!authors || !authors.length) return '';
    const names = authors.slice(0, 3).map(a => {
      const family = a.family || '';
      const initials = (a.given || '').split(/\s+/).map(s => s[0]).filter(Boolean).join('. ');
      return [family, initials ? initials + '.' : ''].filter(Boolean).join(', ');
    });
    if (authors.length > 3) names.push('et al.');
    return names.join('; ');
  }

  // True when the signed-in user is allowed to remove this paper from
  // the library: admin per `_isAdminAny` OR original uploader (matching
  // `meta.library.pdf.uploaded_by`). Pure visibility gate — the Cloud
  // Function re-checks server-side before doing anything.
  function _canDelete(it) {
    const lib = (it && it.meta && it.meta.library) || {};
    if (_isAdminAny()) return true;
    const me = (typeof firebase !== 'undefined' && firebase.auth && firebase.auth().currentUser) || null;
    const myEmail = me ? (me.email || '').toLowerCase() : '';
    const uploadedBy = ((lib.pdf && lib.pdf.uploaded_by) || '').toLowerCase();
    return !!myEmail && myEmail === uploadedBy;
  }

  // Pick the best journal/source URL we have for a library item, in
  // descending preference: DOI → arXiv → PMID → captured `url`.
  // Returns { url, host } or null when no source identifier is set.
  function _sourceUrl(lib) {
    if (lib.doi)      return { url: `https://doi.org/${lib.doi}`,                   host: 'doi.org' };
    if (lib.arxiv_id) return { url: `https://arxiv.org/abs/${lib.arxiv_id}`,        host: 'arxiv.org' };
    if (lib.pmid)     return { url: `https://pubmed.ncbi.nlm.nih.gov/${lib.pmid}/`, host: 'pubmed.ncbi.nlm.nih.gov' };
    if (lib.url) {
      try { return { url: lib.url, host: new URL(lib.url).host }; }
      catch { return { url: lib.url, host: 'source' }; }
    }
    return null;
  }

  // V3.309 — rows whose metadata clearly failed at ingest get an inline
  // repair affordance under the title.
  function _needsMetadataFix(lib) {
    return lib.source === 'manual' || !(lib.authors && lib.authors.length);
  }

  // ---- V3.311 missing-PDF queue -------------------------------------------

  function _pdfStatus(it) {
    const lib = (it.meta && it.meta.library) || {};
    if (lib.pdf && lib.pdf.storage_path) return 'ok';
    if (lib.pdf_status === 'unobtainable') return 'unobtainable';
    return 'missing';
  }

  // Targeted single-doc write (V3.309 pattern) — row-level actions must
  // not rewrite the whole papers collection.
  async function _saveOne(it) {
    it.updated_at = new Date().toISOString().slice(0, 10);
    const payload = JSON.parse(JSON.stringify(it));
    delete payload.updatedAt;
    payload.updatedAt = firebase.firestore.FieldValue.serverTimestamp();
    await firebase.firestore().collection('items').doc(it.id).set(payload);
    // Direct write bypasses api.save — bust the list route caches so a reload
    // (or the reader) doesn't serve the stale pre-write copy (V3.498).
    if (typeof api !== 'undefined' && api.invalidate) {
      api.invalidate('items.json');
      api.invalidate('library/papers.json');
    }
  }

  function _missingActionsHtml(it) {
    const lib = it.meta.library;
    if (_pdfStatus(it) === 'unobtainable') {
      return `<span class="muted" title="Marked unobtainable — no PDF exists or none is accessible">🚫 no PDF</span>
        <button class="btn btn-sm" data-act="pdf-unobtainable" data-id="${_escape(it.id)}" title="Clear the unobtainable flag (back into the missing-PDF queue)">↩</button>`;
    }
    return `<span class="muted"${lib.pdf_retry && lib.pdf_retry.last_error ? ` title="${_escape(lib.pdf_retry.last_error)}"` : ''}>no PDF</span>
      ${(lib.doi || lib.pmid || lib.arxiv_id || lib.url) ? `<button class="btn btn-sm" data-act="pdf-retry" data-id="${_escape(it.id)}" title="Auto-fetch the open-access PDF — server-side, tries Unpaywall + arXiv + PMC + Semantic Scholar + the publisher's PDF link${lib.pdf_retry ? ` (attempt ${(lib.pdf_retry.attempts || 0) + 1})` : ''}">↻</button>` : ''}
      <button class="btn btn-sm" data-act="pdf-upload" data-id="${_escape(it.id)}" title="Upload the PDF manually — attaches to THIS entry">⬆</button>
      <button class="btn btn-sm" data-act="pdf-unobtainable" data-id="${_escape(it.id)}" title="Mark unobtainable (drops out of the missing-PDF queue; reversible)">🚫</button>`;
  }

  let _pdfUploadTarget = null;

  function _ensurePdfUploadInput() {
    let inp = document.getElementById('library-pdf-upload-input');
    if (inp) return inp;
    inp = document.createElement('input');
    inp.type = 'file';
    inp.accept = 'application/pdf';
    inp.id = 'library-pdf-upload-input';
    inp.hidden = true;
    document.body.appendChild(inp);
    inp.addEventListener('change', async () => {
      const file = inp.files && inp.files[0];
      const it = _pdfUploadTarget;
      _pdfUploadTarget = null;
      inp.value = '';
      if (!file || !it) return;
      await _attachPdf(it, file);
    });
    return inp;
  }

  async function _attachPdf(it, blob) {
    _setBusy(`Uploading PDF for "${it.title}"…`);
    try {
      const pdfInfo = await LIBRARY_UPLOAD.uploadPdf(it.id, blob);
      const lib = it.meta.library;
      lib.pdf = {
        storage_path: pdfInfo.storage_path,
        hash: pdfInfo.hash,
        filename_safe: `${it.id}.pdf`,
        size_bytes: pdfInfo.size_bytes,
        uploaded_at: pdfInfo.uploaded_at,
        uploaded_by: pdfInfo.uploaded_by,
      };
      delete lib.pdf_status;
      await _saveOne(it);
      _render();
      _toast(`PDF attached to "${it.title}".`, 'ok');
      // Same background follow-ups as a fresh ingest.
      if (LIBRARY_UPLOAD.parseAndCacheRefs) {
        LIBRARY_UPLOAD.parseAndCacheRefs(it.id, blob).catch(e =>
          console.warn('[library] attach ref parse failed:', e));
      }
      if (LIBRARY_UPLOAD.enrichItemFromSemanticScholar) {
        LIBRARY_UPLOAD.enrichItemFromSemanticScholar(it.id).catch(e =>
          console.warn('[library] attach SS enrichment failed:', e));
      }
    } catch (e) {
      _toast(`Upload failed: ${e.message || e}`, 'error');
    } finally {
      _setBusy('');
    }
  }

  // V3.498 — the "auto-fetch PDF" row action. Tries the server-side
  // fetchPaperPdf engine first (no CORS; Unpaywall all-locations + arXiv +
  // Europe PMC + Semantic Scholar + the publisher's citation_pdf_url), then
  // falls back to the client Unpaywall path only if the function is unreachable.
  async function _retryPdf(it) {
    const lib = it.meta.library;
    if (!lib.doi && !lib.pmid && !lib.arxiv_id && !lib.url && !lib.pdf_candidate_url) {
      _toast('No DOI/PMID/arXiv id on this entry — add one via ✎ first, then retry.', 'error');
      return;
    }
    _setBusy('Auto-fetching PDF…');
    const retry = Object.assign({ attempts: 0 }, lib.pdf_retry || {});
    retry.attempts = (retry.attempts || 0) + 1;
    retry.last_at = new Date().toISOString();
    retry.last_error = '';

    // 1. Server-side fetch. The function uploads to Storage itself, so on
    // success we only stamp meta.library.pdf + save.
    try {
      const out = await LIBRARY_UPLOAD.serverFetchPdf(it);
      if (out && out.ok && out.storage_path) {
        const me = (firebase.auth && firebase.auth().currentUser) || null;
        lib.pdf = {
          storage_path: out.storage_path,
          hash: out.hash,
          filename_safe: `${it.id}.pdf`,
          size_bytes: out.size_bytes,
          uploaded_at: new Date().toISOString().slice(0, 10),
          uploaded_by: (me && me.email) || '',
          source: out.source ? `oa_${out.source}` : 'oa_auto',
        };
        delete lib.pdf_status;
        delete lib.pdf_candidate_url;
        lib.pdf_retry = retry;
        await _saveOne(it);
        _setBusy('');
        _render();
        _toast(`Fetched PDF for "${it.title}" (via ${out.source || 'OA'}).`, 'ok');
        // The blob lives server-side, so skip the local ref-parse; SS
        // enrichment still fills references / cited-by.
        if (LIBRARY_UPLOAD.enrichItemFromSemanticScholar) {
          LIBRARY_UPLOAD.enrichItemFromSemanticScholar(it.id).catch(e =>
            console.warn('[library] fetch SS enrichment failed:', e));
        }
        return;
      }
      retry.last_error = (out && out.error) || 'No open-access PDF found.';
    } catch (e) {
      // 2. Transport/auth error → client Unpaywall fallback (the rare
      // CORS-permitted OA host still works without the function).
      console.warn('[library] serverFetchPdf failed; trying client Unpaywall:', e.message || e);
      if (lib.doi && LIBRARY_UPLOAD.unpaywallLookup) {
        try {
          const oa = await LIBRARY_UPLOAD.unpaywallLookup(lib.doi);
          if (oa && oa.bestPdfUrl) {
            const blob = await LIBRARY_UPLOAD.fetchPdfBlob(oa.bestPdfUrl);
            if (blob) { lib.pdf_retry = retry; await _attachPdf(it, blob); return; }
            lib.pdf_candidate_url = oa.bestPdfUrl;
            lib.pdf_candidate_source = oa.source || '';
            retry.last_error = 'OA PDF found but auto-fetch was blocked — open the candidate URL, then ⬆ upload.';
          } else {
            retry.last_error = e.message || 'Auto-fetch failed.';
          }
        } catch (e2) {
          retry.last_error = e2.message || String(e2);
        }
      } else {
        retry.last_error = e.message || String(e);
      }
    }
    lib.pdf_retry = retry;
    try { await _saveOne(it); } catch (e) { console.warn('[library] retry stamp failed:', e); }
    _setBusy('');
    _render();
    _toast(retry.last_error || 'Fetch finished.', retry.last_error ? 'error' : 'ok');
  }

  function _renderRow(it) {
    const lib = it.meta.library;
    const tr = document.createElement('tr');
    tr.dataset.id = it.id;
    const journalYear = [lib.journal, lib.year].filter(Boolean).join(' · ');
    const star = lib.starred ? '★' : '☆';
    const src = _sourceUrl(lib);
    const canDel = _canDelete(it);
    // V3.363 — per-user pin + group membership row actions (groups shelf).
    // Gated on the shelf widget toggles so hiding a section also drops its
    // row affordance. LIBRARY_PREFS.get() is a cached sync read.
    const wg = (window.LIBRARY_PREFS && LIBRARY_PREFS.get().widgets_enabled) || {};
    const isPinned = !!(window.LIBRARY_GROUPS && LIBRARY_GROUPS.isPinned(it.id));
    const pinBtn = (window.LIBRARY_GROUPS && wg.shelf_pinned !== false)
      ? `<button class="btn btn-sm lib-pin-btn${isPinned ? ' on' : ''}" data-act="pin-toggle" data-id="${_escape(it.id)}" title="${isPinned ? 'Unpin — remove from your pinned papers' : 'Pin to your pinned papers (per-user, only you see it)'}">📌</button>`
      : '';
    const grpBtn = (window.LIBRARY_GROUPS && wg.shelf_groups !== false)
      ? `<button class="btn btn-sm" data-act="add-to-group" data-id="${_escape(it.id)}" title="Add / remove this paper in your groups">📁</button>`
      : '';
    /* V3.601 — attach to a research roadmap (an experiment or analysis on
     * an output card) with a note saying why. Count comes off the reverse
     * index the ref writer maintains, so no extra read per row. */
    const nRoadmaps = Array.isArray(lib.roadmaps) ? lib.roadmaps.length : 0;
    const roadBtn = (window.ROADMAP_ATTACH && wg.roadmap !== false)
      ? `<button class="btn btn-sm${nRoadmaps ? ' on' : ''}" data-act="add-to-roadmap" data-id="${_escape(it.id)}" title="${nRoadmaps ? `On ${nRoadmaps} roadmap${nRoadmaps === 1 ? '' : 's'} — click to manage` : 'Attach this paper to an experiment or analysis on a research roadmap'}">🗺${nRoadmaps ? ` ${nRoadmaps}` : ''}</button>`
      : '';
    /* V3.365 — interactive associations badge. Active/inactive derives
     * from draft status via LIBRARY_ASSOC (falls back to raw counts +
     * _draftTitleById while the resolver cache is cold). Zero-assoc rows
     * get a subtle "+ draft" quick-add ghost. */
    const linkedDrafts = Array.isArray(lib.linked_drafts) ? lib.linked_drafts : [];
    let assocBtn;
    if (!linkedDrafts.length) {
      assocBtn = `<button class="lib-links-badge lib-links-badge-ghost" data-act="assoc-pop" data-id="${_escape(it.id)}" title="Associate this paper with a draft we're writing">+ draft</button>`;
    } else if (window.LIBRARY_ASSOC && LIBRARY_ASSOC.getDraftInfoSync()) {
      const infos = linkedDrafts.map((d) => LIBRARY_ASSOC.resolve(d));
      const nActive = infos.filter((i) => i.active).length;
      const nInactive = infos.length - nActive;
      const tip = infos
        .map((i) => i.title + (i.active ? '' : ` (${i.status || 'inactive'})`))
        .join('\n') + '\nClick to manage associations';
      assocBtn = `<button class="lib-links-badge" data-act="assoc-pop" data-id="${_escape(it.id)}" title="${_escape(tip)}">→ ${nActive} active${nInactive ? ` · ${nInactive} inactive` : ''}</button>`;
    } else {
      assocBtn = `<button class="lib-links-badge" data-act="assoc-pop" data-id="${_escape(it.id)}" title="${_escape(linkedDrafts.map((d) => _draftTitleById[d] || d).join('\n'))}">→ ${linkedDrafts.length} draft${linkedDrafts.length === 1 ? '' : 's'}</button>`;
    }
    tr.innerHTML = `
      <td class="lib-col-star" title="Toggle star">
        <button class="lib-star-btn" data-id="${_escape(it.id)}">${star}</button>
      </td>
      <td class="lib-col-title">
        <div class="lib-title">
          <a href="/rm/pages/library-paper.html?id=${encodeURIComponent(it.id)}" class="lib-title-link">${_escape(it.title || 'Untitled')}</a>
        </div>
        <div class="lib-authors">${_escape(_authorLine(lib.authors))}</div>
        ${assocBtn}
        ${_needsMetadataFix(lib) ? `<button class="btn btn-sm" data-act="edit-meta" data-id="${_escape(it.id)}" style="margin-top:3px;background:#fef3c7;border-color:#fde68a;color:#92400e;" title="Lookup failed at ingest — edit the metadata or pull it from a DOI">⚠ Fix metadata</button>` : ''}
      </td>
      <td class="lib-col-journal">${_escape(journalYear)}</td>
      <td class="lib-col-key"><code>${_escape(lib.citation_key || '')}</code></td>
      <td class="lib-col-actions">
        ${lib.pdf ? `<a class="btn btn-sm" href="/rm/pages/library-paper.html?id=${encodeURIComponent(it.id)}">Read</a>` : _missingActionsHtml(it)}
        ${lib.pdf ? `<button class="btn btn-sm" data-act="open-pdf-tab" data-id="${_escape(it.id)}" title="Open raw PDF in new tab">↗</button>` : ''}
        ${src ? `<a class="btn btn-sm" href="${_escape(src.url)}" target="_blank" rel="noopener" title="Open at ${_escape(src.host)}">Go to source</a>` : ''}
        <button class="btn btn-sm" data-act="edit-meta" data-id="${_escape(it.id)}" title="Edit metadata / fetch from DOI">✎</button>
        ${pinBtn}${grpBtn}${roadBtn}
        <button class="btn btn-sm" data-act="assign-paper" data-id="${_escape(it.id)}" title="Send this paper to a teammate">Send</button>
        ${canDel ? `<button class="btn btn-sm lib-delete-btn" data-act="delete-paper" data-id="${_escape(it.id)}" title="Delete this paper, its PDF, and all annotations">🗑</button>` : ''}
      </td>
    `;
    return tr;
  }

  // Apply per-user visibility filter (prefs.visibility) on top of the
  // library's static filter (type=paper, is_library_entry). 'all' shows
  // everyone's papers, 'mine' restricts to the signed-in user's captures,
  // and 'selected' restricts to a chosen list of UIDs (interpreted as
  // captured_by emails OR uploaded_by emails OR user UIDs since the
  // capture record stores email rather than uid).
  function _applyVisibilityFilter(papers) {
    const prefs = window.LIBRARY_PREFS ? LIBRARY_PREFS.get() : null;
    if (!prefs || !prefs.visibility) return papers;
    const mode = prefs.visibility.mode;
    if (mode === 'all') return papers;
    const me = (typeof firebase !== 'undefined' && firebase.auth && firebase.auth().currentUser) || null;
    const myEmail = me ? (me.email || '').toLowerCase() : '';
    if (mode === 'mine') {
      if (!myEmail) return [];   // Not signed in → 'mine' = empty.
      return papers.filter(p => _capturedBy(p) === myEmail);
    }
    if (mode === 'selected') {
      const allow = new Set((prefs.visibility.uids || []).map(u => String(u).toLowerCase()));
      if (!allow.size) return [];
      return papers.filter(p => allow.has(_capturedBy(p)));
    }
    return papers;
  }

  function _capturedBy(paper) {
    const lib = paper && paper.meta && paper.meta.library;
    if (!lib) return '';
    return String(
      lib.captured_by ||
      (lib.pdf && lib.pdf.uploaded_by) ||
      ''
    ).toLowerCase();
  }

  function _sortFor(mode) {
    if (mode === 'title') {
      return (a, b) => (a.title || '').localeCompare(b.title || '');
    }
    if (mode === 'date_added') {
      return (a, b) => String(b.meta.library.date_added || '').localeCompare(String(a.meta.library.date_added || ''));
    }
    if (mode === 'starred') {
      return (a, b) => {
        const sa = a.meta.library.starred ? 0 : 1;
        const sb = b.meta.library.starred ? 0 : 1;
        if (sa !== sb) return sa - sb;
        return (a.title || '').localeCompare(b.title || '');
      };
    }
    if (mode === 'associations') {
      // V3.365 — most active draft associations first (derived from
      // draft status via LIBRARY_ASSOC; raw count fallback while cold).
      const info = window.LIBRARY_ASSOC ? LIBRARY_ASSOC.getDraftInfoSync() : null;
      const nActive = (p) => {
        const linked = p.meta.library.linked_drafts;
        if (!Array.isArray(linked) || !linked.length) return 0;
        if (!info) return linked.length;
        return linked.filter((id) => {
          const i = info.get(id);
          return !!(i && i.active);
        }).length;
      };
      return (a, b) => {
        const ca = nActive(a), cb = nActive(b);
        if (ca !== cb) return cb - ca;
        return (a.title || '').localeCompare(b.title || '');
      };
    }
    // year-desc default
    return (a, b) => {
      const ya = parseInt(a.meta.library.year || 0, 10);
      const yb = parseInt(b.meta.library.year || 0, 10);
      if (ya !== yb) return yb - ya;
      return (a.title || '').localeCompare(b.title || '');
    };
  }

  function _render() {
    const tbody = document.getElementById('library-tbody');
    const countEl = document.getElementById('library-count');
    if (!tbody) return;
    tbody.innerHTML = '';

    const prefs = window.LIBRARY_PREFS ? LIBRARY_PREFS.get() : null;
    const visiblePool = _applyVisibilityFilter(_libraryPapers);

    // V3.206 — memoize parsed query across renders triggered by the same
    // input string (sort toggle, star click, tag chip click all rerun
    // _render without touching the search box).
    const parsed = (_parsedQueryCache.key === _filterText)
      ? _parsedQueryCache.val
      : (_parsedQueryCache = { key: _filterText, val: _parseQuery(_filterText) }).val;

    let filtered = visiblePool.filter(p => _matches(p, parsed));
    if (_tagFilter) {
      filtered = filtered.filter(p =>
        window.LIBRARY_TAGS && LIBRARY_TAGS.matchPrefix(LIBRARY_TAGS.getTags(p), _tagFilter)
      );
    }
    // V3.311 — missing-PDF queue: the chip filters to rows without a PDF
    // (unobtainable ones included so ↩ stays reachable) and keeps its
    // count current on every render.
    if (_missingOnly) filtered = filtered.filter(p => _pdfStatus(p) !== 'ok');
    const missBtn = document.getElementById('library-missing-pdfs');
    if (missBtn) {
      const nMissing = _libraryPapers.filter(p => _pdfStatus(p) === 'missing').length;
      missBtn.textContent = `${_missingOnly ? '✓ ' : ''}Missing PDFs (${nMissing})`;
      missBtn.style.display = (nMissing || _missingOnly) ? '' : 'none';
    }

    const sortMode = (prefs && prefs.default_sort) || 'year-desc';
    filtered.sort(_sortFor(sortMode));

    if (countEl) {
      const denom = visiblePool.length;
      countEl.textContent =
        `${filtered.length} of ${denom} paper${denom === 1 ? '' : 's'}` +
        (visiblePool.length !== _libraryPapers.length ? ` (filtered from ${_libraryPapers.length})` : '');
    }

    _renderTagStrip();
    _applyWidgetVisibility();

    // V3.363 — groups shelf. Hidden while any filter is active so search
    // results stay the focus; the 💾 Save-as-group button appears only
    // when there's a query/tag filter worth saving.
    if (window.LIBRARY_GROUPS) {
      LIBRARY_GROUPS.render({
        filterActive: !!(_filterText.trim() || _tagFilter || _missingOnly),
      });
    }
    const sgBtn = document.getElementById('library-save-group');
    if (sgBtn) sgBtn.style.display = (_filterText.trim() || _tagFilter) ? '' : 'none';

    if (!filtered.length) {
      const tr = document.createElement('tr');
      tr.innerHTML = `<td colspan="5" class="lib-empty">${
        _libraryPapers.length
          ? (visiblePool.length === 0 ? 'No papers visible — try ⚙ Customize → Whose papers to show.' : 'No papers match the current filter.')
          : 'No papers yet — drop a PDF onto the upload zone above to get started.'
      }</td>`;
      tbody.appendChild(tr);
      return;
    }

    // V3.206 — chunked render. Paint the first RENDER_FIRST_BATCH rows
    // synchronously so the user sees content immediately, then schedule
    // the remainder in RENDER_BATCH_SIZE-row batches via
    // requestIdleCallback. _renderToken cancels any in-flight batches
    // when a new render starts (filter change, sort change, etc.) — we
    // capture it here and check it inside the batch loop. With ~1000
    // papers the first paint drops from ~250 ms to ~15 ms; the rest
    // streams in over a few idle slices.
    const token = ++_renderToken;
    const head = filtered.slice(0, RENDER_FIRST_BATCH);
    const tail = filtered.slice(RENDER_FIRST_BATCH);
    const headFrag = document.createDocumentFragment();
    for (const p of head) headFrag.appendChild(_renderRow(p));
    tbody.appendChild(headFrag);

    if (!tail.length) return;

    const schedule = window.requestIdleCallback
      ? (cb) => window.requestIdleCallback(cb, { timeout: 200 })
      : (cb) => setTimeout(() => cb({ timeRemaining: () => 0, didTimeout: true }), 0);

    let i = 0;
    function batch(deadline) {
      if (token !== _renderToken) return;          // a newer render preempted us
      const stopAt = Math.min(i + RENDER_BATCH_SIZE, tail.length);
      const frag = document.createDocumentFragment();
      for (; i < stopAt; i++) frag.appendChild(_renderRow(tail[i]));
      tbody.appendChild(frag);
      if (i < tail.length) schedule(batch);
    }
    schedule(batch);
  }

  // Render the tag-chip strip between the search box and the table. Shows
  // pinned tags (from prefs) plus the most-used tags from the index, plus
  // an "Active: …" indicator if a tag filter is on. Hidden when the tags
  // widget is disabled in customize-view OR no tags exist.
  function _renderTagStrip() {
    const strip = document.getElementById('library-tag-strip');
    const chipsHost = document.getElementById('library-tag-chips');
    const activeEl = document.getElementById('library-tag-active');
    if (!strip || !chipsHost) return;
    const prefs = window.LIBRARY_PREFS ? LIBRARY_PREFS.get() : null;
    const widgetOn = !prefs || (prefs.widgets_enabled && prefs.widgets_enabled.tags !== false);
    const hasTags = _tagIndex && _tagIndex.allTags && _tagIndex.allTags.size > 0;
    if (!widgetOn || !hasTags) {
      strip.style.display = 'none';
      return;
    }
    strip.style.display = 'flex';

    const pinned = (prefs && prefs.pinned_tags) || [];
    const top = _topTags(8 - Math.min(pinned.length, 8));
    const seen = new Set();
    const chips = [];

    for (const t of pinned) {
      if (!t || seen.has(t)) continue;
      seen.add(t);
      chips.push(_tagChip(t, true));
    }
    for (const t of top) {
      if (!t || seen.has(t)) continue;
      seen.add(t);
      chips.push(_tagChip(t, false));
    }
    chipsHost.innerHTML = chips.join(' ');

    if (_tagFilter) {
      activeEl.innerHTML = `Filtering by <code>${_escape(_tagFilter)}</code> · <a href="#" id="lib-tag-clear" style="color:#1e40af;">clear</a>`;
      const clear = document.getElementById('lib-tag-clear');
      if (clear) clear.addEventListener('click', (e) => {
        e.preventDefault();
        _tagFilter = '';
        _render();
      });
    } else {
      activeEl.textContent = '';
    }
  }

  // Toggle body-level classes that the page's CSS uses to hide widgets
  // the user has unchecked in the customize modal. The corresponding CSS
  // rules live at the top of pages/library.html.
  function _applyWidgetVisibility() {
    const prefs = window.LIBRARY_PREFS ? LIBRARY_PREFS.get() : null;
    const widgets = (prefs && prefs.widgets_enabled) || {};
    document.body.classList.toggle('lib-hide-search', widgets.search === false);
    document.body.classList.toggle('lib-hide-stars',  widgets.stars  === false);
    // tags is gated inside _renderTagStrip — no body class needed
  }

  function _topTags(n) {
    if (!_tagIndex || !_tagIndex.usage) return [];
    return Array.from(_tagIndex.usage.entries())
      .sort((a, b) => b[1] - a[1])
      .slice(0, n)
      .map(([t]) => t);
  }

  function _tagChip(tag, pinned) {
    const active = (_tagFilter === tag);
    const bg = active ? '#1e40af' : (pinned ? '#dbeafe' : '#f3f4f6');
    const fg = active ? '#fff' : (pinned ? '#1e3a8a' : '#374151');
    return `<button type="button" data-tag-chip="${_escape(tag)}" style="background:${bg};color:${fg};border:1px solid ${active ? '#1e3a8a' : '#d1d5db'};border-radius:14px;padding:3px 10px;font-size:11px;font-family:ui-monospace,monospace;cursor:pointer;">${_escape(tag)}${pinned ? ' 📌' : ''}</button>`;
  }

  // ---- Row actions -------------------------------------------------------

  /* V3.365 — association quick-manage popover anchored to the row badge.
   * Hosts LIBRARY_ASSOC.renderPills; add/remove writes are atomic via
   * LIBRARY_LINKS, then the row repaints through _render(). One popover
   * at a time; closes on outside mousedown, Escape, or scroll. */
  let _assocPopEl = null;
  function _closeAssocPopover() {
    if (!_assocPopEl) return;
    _assocPopEl.remove();
    _assocPopEl = null;
    document.removeEventListener('mousedown', _assocPopOutside, true);
    document.removeEventListener('keydown', _assocPopEsc, true);
    window.removeEventListener('scroll', _closeAssocPopover, true);
  }
  function _assocPopOutside(ev) {
    if (_assocPopEl && !_assocPopEl.contains(ev.target)) _closeAssocPopover();
  }
  function _assocPopEsc(ev) {
    if (ev.key === 'Escape') _closeAssocPopover();
  }
  function _openAssocPopover(it, anchor) {
    if (!window.LIBRARY_ASSOC || !window.LIBRARY_LINKS) {
      _toast('Associations are unavailable on this page.', 'error');
      return;
    }
    _closeAssocPopover();
    const pop = document.createElement('div');
    pop.className = 'la-popover';
    const r = anchor.getBoundingClientRect();
    pop.style.left = `${Math.max(8, Math.min(r.left, window.innerWidth - 346))}px`;
    pop.style.top = `${Math.min(r.bottom + 6, window.innerHeight - 120)}px`;
    pop.innerHTML = `
      <div class="la-pop-title">Draft associations — ${_escape(it.title || it.id)}</div>
      <div class="la-pop-body"></div>
    `;
    document.body.appendChild(pop);
    _assocPopEl = pop;
    document.addEventListener('mousedown', _assocPopOutside, true);
    document.addEventListener('keydown', _assocPopEsc, true);
    window.addEventListener('scroll', _closeAssocPopover, true);
    LIBRARY_ASSOC.renderPills(pop.querySelector('.la-pop-body'), it, {
      showCited: true,
      onChanged: () => _render(),   // repaint badges; `it` already patched
    });
  }

  async function _onTableClick(ev) {
    const btn = ev.target.closest('button, a');
    if (!btn) return;
    const id = btn.dataset.id;
    if (!id) return;
    const it = _items.find(x => x.id === id);
    if (!it) return;
    const lib = it.meta.library;

    if (btn.dataset.act === 'open-pdf-tab' && lib.pdf && lib.pdf.storage_path) {
      try {
        _setBusy('Fetching PDF…');
        const url = await LIBRARY_UPLOAD.downloadUrl(lib.pdf.storage_path);
        window.open(url, '_blank', 'noopener');
      } catch (e) {
        _toast(`Could not open PDF: ${e.message || e}`, 'error');
      } finally {
        _setBusy('');
      }
      return;
    }

    if (btn.dataset.act === 'pdf-retry') {
      await _retryPdf(it);
      return;
    }

    if (btn.dataset.act === 'pdf-upload') {
      _pdfUploadTarget = it;
      _ensurePdfUploadInput().click();
      return;
    }

    if (btn.dataset.act === 'pdf-unobtainable') {
      if (lib.pdf_status === 'unobtainable') delete lib.pdf_status;
      else lib.pdf_status = 'unobtainable';
      try {
        await _saveOne(it);
        _render();
      } catch (e) {
        _toast(`Save failed: ${e.message || e}`, 'error');
      }
      return;
    }

    // V3.363 — groups shelf row actions. Both delegate to library-groups.js,
    // which persists via LIBRARY_PREFS and calls back into _render().
    if (btn.dataset.act === 'pin-toggle') {
      if (window.LIBRARY_GROUPS) LIBRARY_GROUPS.togglePin(it.id);
      return;
    }

    if (btn.dataset.act === 'add-to-group') {
      if (window.LIBRARY_GROUPS) LIBRARY_GROUPS.openGroupPicker(it.id);
      return;
    }

    // V3.601 — attach to a research roadmap item, with the "why" note.
    // The modal writes meta.library.roadmaps back onto `it`, so a plain
    // re-render refreshes the row's count.
    if (btn.dataset.act === 'add-to-roadmap') {
      if (window.ROADMAP_ATTACH) ROADMAP_ATTACH.open({ item: it, onDone: () => _render() });
      return;
    }

    // V3.365 — association pills popover (interactive linkage badge).
    if (btn.dataset.act === 'assoc-pop') {
      _openAssocPopover(it, btn);
      return;
    }

    if (btn.dataset.act === 'edit-meta') {
      if (!window.LIBRARY_EDIT) {
        _toast('Metadata editor is unavailable on this page.', 'error');
        return;
      }
      LIBRARY_EDIT.open(it, {
        onSaved(updated) {
          const idx = _libraryPapers.findIndex(x => x.id === updated.id);
          if (idx >= 0) _libraryPapers[idx] = updated;
          _items = _libraryPapers;
          _render();
        },
      });
      return;
    }

    if (btn.dataset.act === 'assign-paper') {
      if (!window.TASK_ASSIGN) {
        _toast('Send is unavailable on this page.', 'error');
        return;
      }
      const authorLine = (lib.authors || [])
        .map(a => [a.given, a.family].filter(Boolean).join(' '))
        .join('; ');
      window.TASK_ASSIGN.open({
        paperRef: {
          paperId:      it.id,
          paperTitle:   it.title || lib.title || it.id,
          paperAuthors: authorLine,
        },
      });
      return;
    }

    if (btn.dataset.act === 'delete-paper') {
      const title = it.title || lib.title || it.id;
      if (!confirm(`Delete "${title}"?\n\nThis removes the PDF, all annotations, and any task evidence references. Cannot be undone.`)) {
        return;
      }
      const me = (typeof firebase !== 'undefined' && firebase.auth && firebase.auth().currentUser) || null;
      if (!me) {
        _toast('Sign in to delete papers.', 'error');
        return;
      }
      _setBusy('Deleting…');
      try {
        const idToken = await me.getIdToken();
        const r = await fetch('https://us-central1-mcgheelab-f56cc.cloudfunctions.net/deletePaper', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json', 'Authorization': 'Bearer ' + idToken },
          body: JSON.stringify({ itemId: it.id }),
        });
        const j = await r.json().catch(() => ({}));
        if (!r.ok || !j.ok) {
          throw new Error(j.error || ('HTTP ' + r.status));
        }
        // V3.487 — the delete runs in a Cloud Function (Admin SDK), outside
        // api.save, so the adapter's items cache isn't cleared; its
        // stale-while-revalidate cheap check ignores deletes (max updatedAt
        // unchanged), so a plain refresh would resurrect the deleted paper.
        // Bust the cache so the next load fetches fresh.
        try { if (window.api && api.invalidate) await api.invalidate('items.json'); } catch (e) { /* non-fatal */ }
        // Drop the row from the in-memory caches and re-render.
        _libraryPapers = _libraryPapers.filter(x => x.id !== it.id);
        _items = _libraryPapers;
        _render();
        _toast(`Deleted "${title}".`, 'ok');
      } catch (e) {
        _toast(`Delete failed: ${e.message || e}`, 'error');
      } finally {
        _setBusy('');
      }
      return;
    }

    if (btn.classList.contains('lib-star-btn')) {
      lib.starred = !lib.starred;
      try {
        await _saveOne(it);   // V3.583 — row action, one doc
        _render();
      } catch (e) {
        _toast(`Save failed: ${e.message}`, 'error');
      }
    }
  }

  // ---- Wiring ------------------------------------------------------------

  function _wireUploadZone() {
    const zone = document.getElementById('library-dropzone');
    const fileInput = document.getElementById('library-file-input');
    if (!zone || !fileInput) return;

    zone.addEventListener('click', () => fileInput.click());
    fileInput.addEventListener('change', () => {
      _handleFiles(Array.from(fileInput.files || []));
      fileInput.value = '';
    });

    ['dragenter', 'dragover'].forEach(ev => {
      zone.addEventListener(ev, e => { e.preventDefault(); zone.classList.add('dragover'); });
    });
    ['dragleave', 'drop'].forEach(ev => {
      zone.addEventListener(ev, e => { e.preventDefault(); zone.classList.remove('dragover'); });
    });
    zone.addEventListener('drop', e => {
      const files = Array.from((e.dataTransfer && e.dataTransfer.files) || []);
      _handleFiles(files.filter(f => f.type === 'application/pdf' || /\.pdf$/i.test(f.name)));
    });
  }

  function _wireSearch() {
    const input = document.getElementById('library-search');
    if (!input) return;
    // V3.206 — debounce 150 ms so a fast typer collapses N keystrokes
    // into one render. Chunked rendering still preempts on each rerun
    // via _renderToken, but skipping the parse + filter + sort entirely
    // on intermediate keystrokes is cheaper.
    input.addEventListener('input', () => {
      _filterText = input.value;
      if (_searchDebounce) clearTimeout(_searchDebounce);
      _searchDebounce = setTimeout(() => { _searchDebounce = 0; _render(); }, 150);
    });
  }

  function _wireDoiAdd() {
    const btn = document.getElementById('library-add-doi');
    if (!btn) return;
    btn.addEventListener('click', async () => {
      const q = window.RM_DIALOG
        ? await RM_DIALOG.prompt({ title: 'Add paper by identifier', placeholder: 'DOI, PMID, or arXiv ID', okText: 'Look up' })
        : window.prompt('Enter DOI, PMID, or arXiv ID:');
      if (!q) return;
      const trimmed = q.trim();
      let params = {};
      if (/^10\./i.test(trimmed) || /doi\.org/i.test(trimmed)) params.doi = trimmed;
      else if (/^\d+$/.test(trimmed)) params.pmid = trimmed;
      else if (/^\d{4}\.\d{4,5}/.test(trimmed) || /^arxiv:/i.test(trimmed)) params.arxiv_id = trimmed;
      else params.title = trimmed;
      try {
        _setBusy('Looking up…');
        const meta = await LIBRARY_METADATA.lookup(params);
        if (meta.error) throw new Error(meta.error);
        // V3.308 — a free-text title query is a fuzzy match; confirm it.
        if (params.title &&
            !_confirmTitleMatch(`"${trimmed}" isn't a DOI/PMID/arXiv id — searched CrossRef by title instead.`, meta)) {
          return;
        }
        // V3.497 — robust dedupe: match an existing entry by identifier
        // (auto) or title+year (confirm), not just an id-slug collision, so a
        // legacy row with a different slug can't spawn a duplicate.
        const dupHit = LIBRARY_UPLOAD.findExistingEntry
          ? LIBRARY_UPLOAD.findExistingEntry(meta, _libraryPapers)
          : null;
        if (dupHit) {
          const blockIt = dupHit.matchedBy !== 'title'
            || window.confirm(
              `"${dupHit.item.title}" looks like it's already in your library. ` +
              `Skip adding a duplicate?\n(Cancel adds it anyway.)`);
          if (blockIt) {
            _toast(`"${dupHit.item.title}" is already in the library.`, 'info');
            return;
          }
        }
        const item = LIBRARY_METADATA.buildPaperItem(meta, null, null);
        // Slug-collision backstop for a genuinely distinct paper whose
        // generated id happens to match an existing one.
        if (_libraryPapers.some(x => x.id === item.id)) {
          item.id = `${item.id}-${Date.now().toString(36).slice(-4)}`;
        }
        _libraryPapers.push(item);
        _items = _libraryPapers;
        await _saveOne(item);   // V3.583 — one doc, not the whole collection
        await _load();
        _render();
        _toast(`Added "${item.title}" (no PDF yet).`, 'ok');
      } catch (e) {
        _toast(`Lookup failed: ${e.message}`, 'error');
      } finally {
        _setBusy('');
      }
    });
  }

  // V3.483 — bulk references importer (BibTeX / DOI list → citation-only
  // library entries). Reuses REFERENCE_IMPORT's shared dialog; commit writes
  // each new item as a single doc, then we mirror them into the in-memory
  // list + reload so a later whole-array save can't clobber them.
  function _wireImportRefs() {
    const btn = document.getElementById('library-import-refs');
    if (!btn) return;
    btn.addEventListener('click', () => {
      if (!window.REFERENCE_IMPORT) {
        _toast('Reference importer not loaded on this page.', 'error');
        return;
      }
      REFERENCE_IMPORT.open({
        mode: 'library',
        existingItems: _libraryPapers,
        onCommit: async ({ builtItems, close }) => {
          try {
            builtItems.forEach(it => _libraryPapers.push(it));
            _items = _libraryPapers;
            await _load();
            _render();
            _toast(`Added ${builtItems.length} reference${builtItems.length === 1 ? '' : 's'} to the library.`, 'ok');
          } catch (e) {
            _toast(`Import save issue: ${e.message || e}`, 'error');
          } finally {
            if (close) close();
          }
        },
      });
    });
  }

  // V3.326 — bulk metadata re-check. onItemSaved swaps rows in place so
  // the table reflects each save without a reload; one render at the end
  // of interaction is enough (the modal itself shows live progress).
  function _wireRecheck() {
    const btn = document.getElementById('library-recheck');
    if (!btn) return;
    btn.addEventListener('click', () => {
      if (!window.LIBRARY_RECHECK) {
        _toast('Re-check module not loaded on this page.', 'error');
        return;
      }
      LIBRARY_RECHECK.open(_libraryPapers, {
        onItemSaved(updated) {
          const idx = _libraryPapers.findIndex(x => x.id === updated.id);
          if (idx >= 0) _libraryPapers[idx] = updated;
          _items = _libraryPapers;
          _render();
        },
      });
    });
  }

  // V3.498 — bulk server-side OA PDF fetch. Same onItemSaved-swaps-rows
  // pattern as the re-check sweep; the modal shows live per-paper progress.
  function _wireFetchPdfs() {
    const btn = document.getElementById('library-fetch-pdfs');
    if (!btn) return;
    btn.addEventListener('click', () => {
      if (!window.LIBRARY_FETCH_PDFS) {
        _toast('PDF-fetch module not loaded on this page.', 'error');
        return;
      }
      LIBRARY_FETCH_PDFS.open(_libraryPapers, {
        onItemSaved(updated) {
          const idx = _libraryPapers.findIndex(x => x.id === updated.id);
          if (idx >= 0) _libraryPapers[idx] = updated;
          _items = _libraryPapers;
          _render();
        },
      });
    });
  }

  // V3.500 — "Grab PDF for RM" bookmarklet generator (paywalled papers).
  function _wireBookmarklet() {
    const btn = document.getElementById('library-bookmarklet');
    if (!btn) return;
    btn.addEventListener('click', () => {
      if (!window.LIBRARY_BOOKMARKLET) {
        _toast('Bookmarklet module not loaded on this page.', 'error');
        return;
      }
      LIBRARY_BOOKMARKLET.open();
    });
  }

  // V3.311 — missing-PDF queue chip toggle.
  function _wireMissingChip() {
    const btn = document.getElementById('library-missing-pdfs');
    if (!btn) return;
    btn.addEventListener('click', () => {
      _missingOnly = !_missingOnly;
      btn.classList.toggle('btn-primary', _missingOnly);
      _render();
    });
  }

  // V3.363 — "💾 Save as group": snapshot the active search + tag filter
  // as a smart group (auto-updates as matching papers arrive). The tag
  // chip folds into the query string as a tag: token — one string is the
  // whole group definition, replayed through _parseQuery/_matches.
  function _wireSaveGroupBtn() {
    const btn = document.getElementById('library-save-group');
    if (!btn) return;
    btn.addEventListener('click', async () => {
      if (!window.LIBRARY_GROUPS) return;
      const q = [_filterText.trim(), _tagFilter ? 'tag:' + _tagFilter : '']
        .filter(Boolean).join(' ');
      if (!q) return;
      const name = window.RM_DIALOG
        ? await RM_DIALOG.prompt({ title: `Save filter as smart group — "${q}"`, placeholder: 'Group name', okText: 'Save' })
        : window.prompt(`Name for the smart group (filter: ${q}):`);
      if (!name || !name.trim()) return;
      LIBRARY_GROUPS.createSmartGroup(name.trim(), q);
      _toast(`Saved smart group "${name.trim()}" — clear the filter to see it on the shelf.`, 'ok');
    });
  }

  // ---- Extension capture sync (phase 6c) ---------------------------------

  let _syncedThisSession = false;
  let _lastSyncMs = 0;
  // V3.583 — set once LIBRARY_SYNC reports the user isn't on the capture
  // allowlist, so the refocus handler stops re-asking.
  let _captureSyncUnavailable = false;

  // Track whether we've gotten a definitive answer from Firebase about
  // auth state. The banner stays hidden until then — otherwise it flashes
  // briefly on every page load while Firebase restores the session.
  let _authResolved = false;

  function _updateAuthHint() {
    const hint = document.getElementById('library-auth-hint');
    if (!hint) return;
    if (!_authResolved) {
      hint.style.display = 'none';
      return;
    }
    const authed = !!(typeof firebase !== 'undefined' && firebase.auth && firebase.auth().currentUser);
    hint.style.display = authed ? 'none' : 'block';
  }

  // Generic email-allowlist loader for any labConfig doc that stores
  // `{ emails: string[] }`. Used for both `extensionMembers` and
  // `guestEditors` (the v2 "edit-only guest" tier).
  // Cached at module scope: the diagnostic poller calls this 20× during the
  // first 10 seconds of page load, and these allowlists rarely change. The
  // cache is invalidated by _addToAllowlist / _removeFromAllowlist after a
  // successful write.
  const _ALLOWLIST_CACHE = {};
  async function _loadAllowlist(docId) {
    if (typeof firebase === 'undefined' || !firebase.firestore) return null;
    if (Object.prototype.hasOwnProperty.call(_ALLOWLIST_CACHE, docId)) {
      return _ALLOWLIST_CACHE[docId];
    }
    try {
      const doc = await firebase.firestore().collection('labConfig').doc(docId).get();
      const data = doc.exists ? (doc.data() || {}) : {};
      const list = Array.isArray(data.emails) ? data.emails.map(e => String(e).toLowerCase()) : [];
      _ALLOWLIST_CACHE[docId] = list;
      return list;
    } catch (e) {
      console.warn(`[library] ${docId} read failed:`, e.message);
      return null;
    }
  }
  function _invalidateAllowlistCache(docId) {
    if (docId) delete _ALLOWLIST_CACHE[docId];
    else { for (const k of Object.keys(_ALLOWLIST_CACHE)) delete _ALLOWLIST_CACHE[k]; }
  }

  // Backwards-compat shim — _updateExtensionMemberStatus calls this.
  async function _loadExtensionMembers() { return _loadAllowlist('extensionMembers'); }

  // Admin-status diagnostic. Renders a small "your UID / email / admin
  // yes/no, here are the lab admins" panel in the install card so the
  // user can see at a glance:
  //   - which Google account they're signed in as
  //   - whether THAT account has admin (driving Member-access visibility)
  //   - who else is admin (in case they need to ask)
  // Especially useful when the user is signed in to a different account
  // than the one set up as the lab PI in users/{uid}.role=='admin'.
  // Cached lab-admins list — the where('role','==','admin') query runs once
  // in the background and may take a while (or fail) on flaky networks
  // (QUIC errors). The diagnostic itself never blocks on it.
  let _adminListCache = null;       // null = pending, [] = done empty, [{uid,email,name}, ...] = done
  let _adminListErr = null;
  let _adminListInFlight = false;
  let _diagRenderCount = 0;

  // Local mirror of the signed-in user's users/{uid} doc. firebridge owns
  // its own copy in _profile but it can lag or fail on flaky networks
  // (QUIC channel errors leave firebridge.getProfile() returning null
  // indefinitely). We fetch it ourselves and treat it as the source of
  // truth for admin checks, falling back to firebridge if our copy is
  // missing.
  let _ownProfileCache = null;
  let _ownProfileErr = null;
  let _ownProfileInFlight = false;
  let _ownProfileLastUid = null;

  function _refreshOwnProfile() {
    if (_ownProfileInFlight) return;
    if (typeof firebase === 'undefined' || !firebase.auth || !firebase.firestore) return;
    const u = firebase.auth().currentUser;
    if (!u) return;
    // If we already loaded this uid's profile, don't refetch on every poll.
    if (_ownProfileCache && _ownProfileLastUid === u.uid) return;
    _ownProfileInFlight = true;
    _ownProfileLastUid = u.uid;
    firebase.firestore()
      .collection('users')
      .doc(u.uid)
      .get()
      .then(d => {
        if (d.exists) {
          _ownProfileCache = Object.assign({ id: d.id }, d.data() || {});
          _ownProfileErr = null;
        } else {
          _ownProfileCache = null;
          _ownProfileErr = 'doc does not exist';
        }
      })
      .catch(e => {
        _ownProfileErr = e.message || String(e);
        console.warn('[library] own profile fetch failed:', _ownProfileErr);
      })
      .finally(() => {
        _ownProfileInFlight = false;
        _renderAccountDiagnostic();
        _updateExtensionMemberStatus();
        // V3.363 — admin-only shelf controls (＋ Lab group, shared-group
        // edit tools) depend on _isAdminAny(), which may flip only once
        // this profile fetch lands. render() with no args reuses the
        // shelf's last state.
        if (window.LIBRARY_GROUPS) LIBRARY_GROUPS.render();
      });
  }

  // Truthy iff the signed-in user is admin per any source we can reach:
  // the local own-profile mirror or firebridge's cached profile.
  function _isAdminAny() {
    if (_ownProfileCache && _ownProfileCache.role === 'admin') return true;
    // `firebridge` is a lexical const (firebase-bridge.js), never assigned
    // to window — so the old `window.firebridge && …` checks here were
    // permanently dead. isAdmin() reads _profile.role === 'admin'.
    // The old code ALSO had `if (firebridge.isReady()) return true`, but
    // isReady() only means "auth resolved," NOT "is admin" — activating
    // that line as written would have granted admin to every signed-in
    // user, so it is dropped here, not swapped to the bare binding.
    if (typeof firebridge !== 'undefined' && firebridge.isAdmin && firebridge.isAdmin()) return true;
    return false;
  }

  function _refreshAdminListAsync() {
    if (_adminListInFlight) return;
    if (typeof firebase === 'undefined' || !firebase.firestore) return;
    _adminListInFlight = true;
    firebase.firestore()
      .collection('users')
      .where('role', '==', 'admin')
      .get()
      .then(snap => {
        const admins = [];
        snap.forEach(doc => {
          const d = doc.data() || {};
          admins.push({
            uid: doc.id,
            email: d.email || '',
            name: d.displayName || d.name || '',
          });
        });
        _adminListCache = admins;
        _adminListErr = null;
      })
      .catch(e => {
        _adminListErr = e.message || String(e);
        console.warn('[library] could not list admins:', _adminListErr);
      })
      .finally(() => {
        _adminListInFlight = false;
        _renderAccountDiagnostic();   // re-render once results are in
      });
  }

  // Synchronous renderer — never awaits anything. Reads firebridge state
  // live, writes the DOM immediately. The admin-list query runs in the
  // background via _refreshAdminListAsync; when it resolves, this function
  // is called again to fold the result in.
  function _renderAccountDiagnostic() {
    const host = document.getElementById('lib-account-diag');
    if (!host) return;
    _diagRenderCount++;

    host.style.display = 'block';

    if (typeof firebase === 'undefined' || !firebase.auth) {
      host.innerHTML = `<div><strong>Diagnostic:</strong> Firebase SDK didn't load — reload the page.</div>`;
      return;
    }

    // Kick off the admin-list query if we haven't yet. Each render after
    // it resolves will read the cached result.
    if (_adminListCache === null && !_adminListInFlight) {
      _refreshAdminListAsync();
    }
    // Same for our own profile — firebridge can hang on flaky networks,
    // so we fetch this doc ourselves as a fallback.
    if (!_ownProfileCache && firebase.auth().currentUser) {
      _refreshOwnProfile();
    }

    const adminLine = _adminListCache === null
      ? '<em>loading…</em>'
      : (_adminListCache.length
          ? _adminListCache.map(a => `${_escape(a.email || a.name || '(no email)')} <span style="color:#6b7280;">(uid <code>${_escape(a.uid)}</code>)</span>`).join('<br>')
          : (_adminListErr
              ? `<em>could not list (${_escape(_adminListErr)})</em>`
              : '<em>none — no users/{uid} doc has role:"admin" yet</em>'));

    const user = firebase.auth().currentUser;
    const fbReady = !!(typeof firebridge !== 'undefined' && firebridge.isReady && firebridge.isReady());
    const fbProfile = (typeof firebridge !== 'undefined' && firebridge.getProfile) ? firebridge.getProfile() : null;
    const tsNow = new Date().toLocaleTimeString();
    const isAdmin = _isAdminAny();
    const ownProfStr = _ownProfileCache
      ? (_ownProfileCache.role || '(no role)')
      : (_ownProfileErr ? `err:${_ownProfileErr.slice(0, 40)}` : (_ownProfileInFlight ? 'loading' : '(none)'));

    const traceLine = `<div style="margin-top:6px;color:#6b7280;font-size:10px;font-family:ui-monospace,monospace;">render #${_diagRenderCount} @ ${tsNow} · ownProfile.role=${ownProfStr} · firebridge.isReady=${fbReady} · firebridge.profile.role=${fbProfile ? (fbProfile.role || '(none)') : '(no profile)'} · auth=${user ? 'yes' : 'no'} · adminList=${_adminListCache === null ? 'loading' : _adminListCache.length}</div>`;

    if (!user) {
      host.innerHTML = `
        <div><strong>Your account:</strong> <em>not signed in</em></div>
        <div><strong>Admin:</strong> n/a until signed in</div>
        <div><strong>Lab admins:</strong> ${adminLine}</div>
        <div style="margin-top:4px;color:#6b7280;">Sign in via <a href="/rm/pages/profile.html" style="color:#1e40af;">the profile page</a> for the Member-access controls below to appear.</div>
        ${traceLine}
      `;
      return;
    }

    host.innerHTML = `
      <div><strong>Your account:</strong> ${_escape(user.email || '(no email)')} <span style="color:#6b7280;">(uid <code>${_escape(user.uid)}</code>)</span></div>
      <div><strong>Admin:</strong> ${isAdmin ? '✓ yes' : '✗ no'}${isAdmin ? '' : ' &mdash; the Member-access admin panel below is only visible to admins.'}</div>
      <div><strong>Lab admins (Firestore <code>users.where(role=admin)</code>):</strong> ${adminLine}</div>
      ${traceLine}
    `;
  }

  async function _updateExtensionMemberStatus() {
    const el = document.getElementById('lib-ext-member-status');
    if (!el) return;
    if (typeof firebase === 'undefined' || !firebase.auth || !firebase.auth().currentUser) {
      el.textContent = '— sign in to see your access status';
      el.style.color = '';
      return;
    }
    const user = firebase.auth().currentUser;
    const email = (user.email || '').toLowerCase();
    const list = await _loadExtensionMembers();
    // Pull from any source we can — firebridge's _ready can lag the actual
    // loaded profile on flaky networks (Listen channel hangs), so accept
    // local mirror, firebridge profile, or firebridge._ready.
    if (!_ownProfileCache) _refreshOwnProfile();
    const isAdmin = _isAdminAny();
    if (list === null) {
      el.textContent = '(could not check the allowlist — see console)';
      el.style.color = '#6b7280';
      return;
    }
    if (isAdmin || list.includes(email)) {
      el.textContent = `✓ ${email} has access${isAdmin ? ' (admin)' : ''}`;
      el.style.color = '#15803d';
    } else {
      el.textContent = `✗ ${email} is NOT on the allowlist — ask the PI to add you`;
      el.style.color = '#b91c1c';
    }
    // Reveal the admin blocks if the current user is an admin.
    const adminBlock = document.getElementById('lib-ext-admin');
    if (adminBlock) {
      adminBlock.style.display = isAdmin ? 'block' : 'none';
      if (isAdmin) {
        await _renderAllowlistAdmin('extensionMembers', list);
        const guestList = await _loadAllowlist('guestEditors');
        await _renderAllowlistAdmin('guestEditors', guestList || []);
      }
    }
  }

  // DOM-id mapping per allowlist doc. Two parallel UIs render side-by-side
  // in the admin panel; each has its own list, input, button, status line.
  const _ALLOWLIST_DOM = {
    extensionMembers: {
      list:   'lib-ext-member-list',
      input:  'lib-ext-add-email',
      addBtn: 'lib-ext-add-btn',
      status: 'lib-ext-admin-status',
      removeAttr: 'data-ext-remove-email',
    },
    guestEditors: {
      list:   'lib-ged-member-list',
      input:  'lib-ged-add-email',
      addBtn: 'lib-ged-add-btn',
      status: 'lib-ged-admin-status',
      removeAttr: 'data-ged-remove-email',
    },
  };

  async function _renderAllowlistAdmin(docId, list) {
    const cfg = _ALLOWLIST_DOM[docId];
    if (!cfg) return;
    const ul = document.getElementById(cfg.list);
    if (!ul) return;
    list = list || [];
    if (list.length === 0) {
      ul.innerHTML = '<li style="padding:10px;color:#9ca3af;font-style:italic;">No members yet — add one above.</li>';
      return;
    }
    ul.innerHTML = list.map(em => `
      <li style="display:flex;align-items:center;justify-content:space-between;gap:8px;padding:6px 10px;border-bottom:1px solid #eef2ff;">
        <code style="font-size:12px;">${_escape(em)}</code>
        <button class="btn btn-sm" ${cfg.removeAttr}="${_escape(em)}" style="background:#fee2e2;color:#b91c1c;border:none;font-size:11px;padding:3px 8px;">Remove</button>
      </li>
    `).join('');
  }

  async function _addToAllowlist(docId, email) {
    const cfg = _ALLOWLIST_DOM[docId];
    const status = cfg && document.getElementById(cfg.status);
    email = String(email || '').trim().toLowerCase();
    if (!email || !/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(email)) {
      if (status) { status.textContent = 'Enter a valid email.'; status.style.color = '#b91c1c'; }
      return;
    }
    const list = (await _loadAllowlist(docId)) || [];
    if (list.includes(email)) {
      if (status) { status.textContent = `${email} is already on the list.`; status.style.color = '#6b7280'; }
      return;
    }
    const next = list.concat(email);
    try {
      await firebase.firestore().collection('labConfig').doc(docId).set({
        emails: next,
        updated_at: firebase.firestore.FieldValue.serverTimestamp(),
        updated_by: firebase.auth().currentUser ? firebase.auth().currentUser.email : '',
      }, { merge: true });
      _ALLOWLIST_CACHE[docId] = next;
      if (status) { status.textContent = `Added ${email}.`; status.style.color = '#15803d'; }
      const input = document.getElementById(cfg.input);
      if (input) input.value = '';
      await _renderAllowlistAdmin(docId, next);
    } catch (e) {
      if (status) { status.textContent = `Add failed: ${e.message || e}`; status.style.color = '#b91c1c'; }
    }
  }

  async function _removeFromAllowlist(docId, email) {
    const cfg = _ALLOWLIST_DOM[docId];
    const status = cfg && document.getElementById(cfg.status);
    const list = (await _loadAllowlist(docId)) || [];
    const next = list.filter(e => e !== email);
    try {
      await firebase.firestore().collection('labConfig').doc(docId).set({
        emails: next,
        updated_at: firebase.firestore.FieldValue.serverTimestamp(),
        updated_by: firebase.auth().currentUser ? firebase.auth().currentUser.email : '',
      }, { merge: true });
      _ALLOWLIST_CACHE[docId] = next;
      if (status) { status.textContent = `Removed ${email}.`; status.style.color = '#15803d'; }
      await _renderAllowlistAdmin(docId, next);
    } catch (e) {
      if (status) { status.textContent = `Remove failed: ${e.message || e}`; status.style.color = '#b91c1c'; }
    }
  }

  // Backwards-compat shims — older code paths called these specific names.
  function _addExtensionMember(email)    { return _addToAllowlist('extensionMembers', email); }
  function _removeExtensionMember(email) { return _removeFromAllowlist('extensionMembers', email); }

  async function _runCaptureSync(opts) {
    const force = !!(opts && opts.force);
    const silent = !!(opts && opts.silent);   // suppress no-op toasts (auto-resync)
    // One sync per page load is enough by default — extra captures only
    // happen via the extension while the user is on a different tab anyway.
    if (_syncedThisSession && !force) return;
    // V3.583 — the queue is allowlist-gated; once we know this user isn't on
    // it, stop re-running on every refocus.
    if (_captureSyncUnavailable) return;
    if (!window.LIBRARY_SYNC) {
      if (force) _toast('library-sync.js not loaded — reload the page.', 'error');
      return;
    }
    if (typeof firebase === 'undefined' || !firebase.auth || !firebase.auth().currentUser) {
      if (force) _toast('Sign in first (profile page) to merge extension captures.', 'error');
      _updateAuthHint();
      return;
    }
    _syncedThisSession = true;
    _updateAuthHint();

    _setBusy(force ? 'Syncing extension captures (forced)…' : 'Syncing extension captures…');
    console.log('[library] running capture sync (force=' + force + ')');
    try {
      const result = await LIBRARY_SYNC.syncPendingCaptures(_items);
      // V3.583 — not on the capture allowlist: nothing was read and there's
      // nothing to report. Say so once (only when the user explicitly asked)
      // and don't sync again this session.
      if (result.notMember) {
        _captureSyncUnavailable = true;
        if (force && !silent) {
          _toast('Extension capture isn\'t enabled for your account — ask an admin to add you to the capture allowlist in Settings.', 'info');
        }
        return;
      }
      console.log('[library] sync result:', result);
      const merged = result.merged || [];
      if (merged.length) {
        await _saveItems();
        await _load();   // recompute _libraryPapers
        _render();
        const titles = merged.slice(0, 3).map(m => m.title || m.paper_id).join(', ');
        const more = merged.length > 3 ? ` (+${merged.length - 3} more)` : '';
        _toast(`Merged ${merged.length} extension capture${merged.length === 1 ? '' : 's'}: ${titles}${more}`, 'ok');
      } else if (result.skipped && result.skipped.length && !silent) {
        _toast(`Cleared ${result.skipped.length} already-merged capture${result.skipped.length === 1 ? '' : 's'}.`, 'info');
      } else if (force && !silent) {
        _toast('No pending captures.', 'info');
      }
      if (result.errors && result.errors.length) {
        console.warn('[library] sync errors:', result.errors);
        _toast(`Sync hit ${result.errors.length} error${result.errors.length === 1 ? '' : 's'} — see console.`, 'error');
      }
      // Phase E: surface the "more pending" hint when the batch was capped.
      if (result.more && !silent) {
        _toast('More captures pending — click "Sync captures" again to drain the next batch.', 'info');
      }
    } catch (e) {
      console.error('[library] sync failed:', e);
      _toast(`Capture sync failed: ${e.message || e}`, 'error');
    } finally {
      _setBusy('');
      _lastSyncMs = Date.now();
    }
  }

  // Re-sync when the library tab regains focus or visibility, so a paper
  // captured in another tab via the extension shows up automatically when
  // the user comes back. Throttle to one sync per 3 seconds to avoid
  // hammering Firestore on rapid alt-tab.
  function _wireRefocusSync() {
    const handle = () => {
      if (document.visibilityState !== 'visible') return;
      if (!firebase || !firebase.auth || !firebase.auth().currentUser) return;
      if (Date.now() - _lastSyncMs < 3000) return;
      _runCaptureSync({ force: true, silent: true });
    };
    document.addEventListener('visibilitychange', handle);
    window.addEventListener('focus', handle);
  }

  // ---- Init --------------------------------------------------------------

  async function init() {
    _wireUploadZone();
    _wireSearch();
    _wireDoiAdd();
    _wireImportRefs();
    _wireMissingChip();
    _wireRecheck();
    _wireFetchPdfs();
    _wireBookmarklet();
    _wireSaveGroupBtn();
    // V3.363 — groups shelf. library.js owns the paper pool + search
    // grammar; the shelf module gets them as callbacks and calls
    // onChanged() → _render() after any pin/group mutation.
    if (window.LIBRARY_GROUPS) {
      LIBRARY_GROUPS.init({
        getPapers: () => _applyVisibilityFilter(_libraryPapers),
        parseQuery: _parseQuery,
        matches: _matches,
        isAdmin: _isAdminAny,
        getDraftTitles: () => _draftTitleById,
        onChanged: () => _render(),
        toast: _toast,
      });
    }
    document.getElementById('library-tbody')
      ?.addEventListener('click', _onTableClick);
    await _load();
    _render();

    // Manual "Sync captures" button — bypasses the once-per-session gate.
    const syncBtn = document.getElementById('library-sync-btn');
    if (syncBtn) syncBtn.addEventListener('click', () => _runCaptureSync({ force: true }));

    // Auto-resync on tab refocus so captures made elsewhere appear without
    // a manual click. Throttled to 1/3s.
    _wireRefocusSync();

    // Render the diagnostic immediately (even before auth resolves) so the
    // user sees something concrete. Poll every 500ms (capped at 10s) until
    // both the own-profile fetch and the admin-list fetch have resolved, then
    // stop. The earlier "always poll all 20 ticks" version was firing 20
    // labConfig/extensionMembers reads per page load via _updateExtensionMemberStatus.
    _renderAccountDiagnostic();
    let _diagPolls = 0;
    const _diagPoller = setInterval(() => {
      _renderAccountDiagnostic();
      _updateExtensionMemberStatus();
      _diagPolls++;
      const ownDone = _ownProfileCache != null || _ownProfileErr != null
        || (typeof firebase !== 'undefined' && firebase.auth && !firebase.auth().currentUser);
      const adminDone = _adminListCache !== null;
      if ((ownDone && adminDone) || _diagPolls >= 20) clearInterval(_diagPoller);
    }, 500);

    // Tag chip click delegation.
    document.getElementById('library-tag-chips')?.addEventListener('click', (e) => {
      const btn = e.target.closest('[data-tag-chip]');
      if (!btn) return;
      const tag = btn.getAttribute('data-tag-chip');
      _tagFilter = (_tagFilter === tag) ? '' : tag;  // toggle off when clicking the active chip
      _render();
    });

    // Customize-view modal wiring.
    _wireCustomizeModal();

    // Allowlist admin blocks (only revealed for admins by _updateExtensionMemberStatus).
    // Wire both extensionMembers and guestEditors with the same shape.
    function _wireAllowlistBlock(docId) {
      const cfg = _ALLOWLIST_DOM[docId];
      if (!cfg) return;
      const addBtn = document.getElementById(cfg.addBtn);
      const addInput = document.getElementById(cfg.input);
      if (addBtn && addInput) {
        addBtn.addEventListener('click', () => _addToAllowlist(docId, addInput.value));
        addInput.addEventListener('keydown', (e) => {
          if (e.key === 'Enter') { e.preventDefault(); _addToAllowlist(docId, addInput.value); }
        });
      }
      document.getElementById(cfg.list)?.addEventListener('click', (e) => {
        const btn = e.target.closest(`[${cfg.removeAttr}]`);
        if (!btn) return;
        const email = btn.getAttribute(cfg.removeAttr);
        const label = docId === 'extensionMembers' ? 'extension allowlist' : 'guest-editors allowlist';
        if (email && confirm(`Remove ${email} from the ${label}?`)) {
          _removeFromAllowlist(docId, email);
        }
      });
    }
    _wireAllowlistBlock('extensionMembers');
    _wireAllowlistBlock('guestEditors');

    // Hook firebase.auth().onAuthStateChanged directly so we know when
    // auth has actually resolved. firebridge.onAuth's "fire immediately"
    // path uses _user=null as initial state, which we can't distinguish
    // from "resolved as not signed in" — so it can't drive the banner.
    if (typeof firebase !== 'undefined' && firebase.auth) {
      firebase.auth().onAuthStateChanged(() => {
        _authResolved = true;
        _updateAuthHint();
      });
    }

    // Sync extension captures + load per-user prefs once auth resolves.
    // firebridge.onAuth fires immediately if signed in, and re-fires on
    // auth state changes — so signing in mid-session triggers both.
    if (typeof firebridge !== 'undefined' && typeof firebridge.onAuth === 'function') {
      if (firebridge.requireSignIn) firebridge.requireSignIn('Sign in to view the lab library.');
      firebridge.onAuth(async (user) => {
        _updateAuthHint();
        _updateExtensionMemberStatus();
        _renderAccountDiagnostic();
        if (user && window.LIBRARY_PREFS) {
          await LIBRARY_PREFS.load();
          // V3.363 — lab-shared groups need isLabMember, so load after auth.
          if (window.LIBRARY_GROUPS) await LIBRARY_GROUPS.loadShared();
          _render();
        }
        if (user) _runCaptureSync();
      });
    } else {
      _runCaptureSync();
    }
  }

  // ---- Customize modal --------------------------------------------------

  function _wireCustomizeModal() {
    const btn = document.getElementById('library-customize-btn');
    const modal = document.getElementById('library-customize-modal');
    const close = document.getElementById('library-customize-close');
    if (!btn || !modal || !close) return;

    btn.addEventListener('click', () => {
      _populateCustomizeModal();
      modal.style.display = 'flex';
    });
    close.addEventListener('click', () => { modal.style.display = 'none'; });
    modal.addEventListener('click', (e) => {
      // Click on the backdrop (not the inner card) closes the modal.
      if (e.target === modal) modal.style.display = 'none';
    });

    // Visibility radio change.
    modal.addEventListener('change', (e) => {
      if (!window.LIBRARY_PREFS) return;
      const prefs = LIBRARY_PREFS.get();
      const next = JSON.parse(JSON.stringify(prefs));

      if (e.target.name === 'lib-cv-vis') {
        next.visibility = next.visibility || { mode: 'all', uids: [] };
        next.visibility.mode = e.target.value;
        document.getElementById('lib-cv-vis-selected').style.display =
          (e.target.value === 'selected') ? 'block' : 'none';
      } else if (e.target.id === 'lib-cv-sort') {
        next.default_sort = e.target.value;
      } else if (e.target.matches('[data-widget-key]')) {
        const k = e.target.getAttribute('data-widget-key');
        next.widgets_enabled = Object.assign({}, next.widgets_enabled);
        next.widgets_enabled[k] = !!e.target.checked;
      } else if (e.target.matches('[data-uid-toggle]')) {
        const uid = e.target.getAttribute('data-uid-toggle');
        const on = !!e.target.checked;
        const set = new Set(next.visibility.uids || []);
        if (on) set.add(uid); else set.delete(uid);
        next.visibility.uids = Array.from(set);
      }
      LIBRARY_PREFS.save(next);
      _render();
    });

    // Pinned tags input — debounce on input.
    const pinned = document.getElementById('lib-cv-pinned');
    if (pinned) {
      let t;
      pinned.addEventListener('input', () => {
        clearTimeout(t);
        t = setTimeout(() => {
          if (!window.LIBRARY_PREFS) return;
          const prefs = LIBRARY_PREFS.get();
          const next = JSON.parse(JSON.stringify(prefs));
          next.pinned_tags = window.LIBRARY_TAGS
            ? LIBRARY_TAGS.parse(pinned.value)
            : pinned.value.split(',').map(s => s.trim()).filter(Boolean);
          LIBRARY_PREFS.save(next);
          _render();
        }, 350);
      });
    }
  }

  function _populateCustomizeModal() {
    if (!window.LIBRARY_PREFS) return;
    const prefs = LIBRARY_PREFS.get();
    const visMode = (prefs.visibility && prefs.visibility.mode) || 'all';
    document.querySelectorAll('input[name="lib-cv-vis"]').forEach(el => {
      el.checked = (el.value === visMode);
    });
    document.getElementById('lib-cv-vis-selected').style.display =
      (visMode === 'selected') ? 'block' : 'none';
    document.getElementById('lib-cv-sort').value = prefs.default_sort || 'year-desc';
    document.getElementById('lib-cv-pinned').value = (prefs.pinned_tags || []).join(', ');

    // Widget checkboxes — render dynamically from DEFAULTS so adding a
    // widget key in library-prefs.js auto-shows here without HTML edits.
    const widgetsHost = document.getElementById('lib-cv-widgets');
    const widgetKeys = Object.keys(LIBRARY_PREFS.DEFAULTS.widgets_enabled);
    const labels = {
      search: 'Search box',
      stars:  'Star column',
      tags:   'Tag chip strip',
      shelf_reader: 'Shelf: open in reader',
      shelf_pinned: 'Shelf: pinned papers',
      shelf_groups: 'Shelf: paper groups',
      roadmap: 'Row button: add to a research roadmap',
    };
    widgetsHost.innerHTML = widgetKeys.map(k => `
      <label style="display:flex;align-items:center;gap:6px;">
        <input type="checkbox" data-widget-key="${k}" ${prefs.widgets_enabled[k] === false ? '' : 'checked'}>
        <span>${labels[k] || k}</span>
      </label>
    `).join('');

    // Selected-uid list — autocomplete from union of captured_by emails.
    const uidHost = document.getElementById('lib-cv-uid-list');
    const allEmails = new Set();
    for (const p of _libraryPapers) {
      const e = _capturedBy(p);
      if (e) allEmails.add(e);
    }
    const enabled = new Set((prefs.visibility && prefs.visibility.uids) || []);
    uidHost.innerHTML = Array.from(allEmails).sort().map(em => `
      <label style="display:flex;align-items:center;gap:6px;">
        <input type="checkbox" data-uid-toggle="${_escape(em)}" ${enabled.has(em) ? 'checked' : ''}>
        <code style="font-size:11px;">${_escape(em)}</code>
      </label>
    `).join('') || '<div style="color:#9ca3af;font-style:italic;">No captures yet from any lab member.</div>';
  }

  document.addEventListener('DOMContentLoaded', async () => {
    await init();
    // No LIVE_SYNC.attach: items.json updates only via explicit user action
    // (PDF upload, "+ Add by DOI", or extension capture sync). _wireRefocusSync
    // already re-runs the capture sync when the tab regains focus, which is
    // the only practical cross-tab path. Skipping the onSnapshot saves one
    // listener + first-fire round-trip on every library page load.
  });
})();
