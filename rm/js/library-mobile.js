/* library-mobile.js — V3.613 the Ourlab app's Library list page.
 *
 * A purpose-built phone surface over the SAME data the desktop library
 * (pages/library.html + js/library.js) uses — items in Firestore via
 * api.load('library/papers.json'), per-user prefs via LIBRARY_PREFS,
 * pins/groups via LIBRARY_GROUPS, metadata + upload pipelines via
 * LIBRARY_METADATA / LIBRARY_UPLOAD. The desktop page is untouched; this
 * page deliberately ships a reader-first SUBSET:
 *
 *   • search (plain multi-field contains — not the desktop field grammar)
 *   • Recently read row (localStorage; written by library-mobile-paper.js)
 *   • groups-shelf chips + pinned-tag chips (filter only; group MANAGEMENT
 *     stays on desktop — smart groups are desktop-only since they need the
 *     search grammar)
 *   • paper cards → the mobile reader; ★ star, 📌 pin, ⋯ action sheet
 *   • ＋ FAB → APP_SHEET quick-add: add by DOI/PMID/arXiv, upload PDF
 *   • Comments feed view (one-shot paged reads, concurrency-capped — NOT
 *     the desktop library-comments.js listener fan-out)
 *
 * Deliberately absent (desktop-only): bulk tools (re-check metadata, fetch
 * missing PDFs, bookmarklet, extension), reference bulk import, Lab Themes
 * management, customize view, roadmap attach, draft associations, send to
 * teammate, delete.
 */
(function () {
  'use strict';

  // ---- state ----------------------------------------------------------------
  let _papers = [];
  let _filterText = '';
  let _tagFilter = '';          // colon-path prefix from a tag chip
  let _groupFilter = null;      // null | {kind:'pinned'} | {kind:'group', id, shared}
  let _renderToken = 0;
  let _searchDebounce = 0;
  let _member = false;
  let _booted = false;
  let _lastLoadAt = 0;
  let _tagIndex = null;
  let _view = 'papers';         // 'papers' | 'comments'

  // Comments feed state (one-shot paged; papers ordered by updated_at desc)
  const FEED_PAPERS_PER_PAGE = 12;
  const FEED_CONCURRENCY = 6;
  let _feedCursor = 0;
  let _feedRows = [];
  let _feedLoading = false;
  let _feedStarted = false;

  const RECENT_KEY = 'rm_libm_recent';   // written by library-mobile-paper.js

  // ---- tiny utils -------------------------------------------------------------
  function _esc(s) {
    return String(s ?? '').replace(/[&<>"']/g, c => ({
      '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;'
    }[c]));
  }

  function _toast(msg, kind) {
    if (window.TOAST) {
      if (kind === 'error') TOAST.error(msg);
      else if (kind === 'ok') TOAST.success(msg);
      else TOAST.info(msg);
    } else console.log('[library-mobile]', msg);
  }

  function _setBusy(msg) {
    const el = document.getElementById('libm-status');
    if (el) el.textContent = msg || '';
  }

  function _authorLine(authors) {
    if (!authors || !authors.length) return '';
    const names = authors.slice(0, 3)
      .map(a => a.family || [a.given, a.family].filter(Boolean).join(' '))
      .filter(Boolean);
    return names.join(', ') + (authors.length > 3 ? ' et al.' : '');
  }

  /* Mirror of library.js _saveOne — single-doc write + route-cache bust so
   * the next load (here or in the desktop tab) doesn't serve a stale copy. */
  async function _saveOne(it) {
    it.updated_at = new Date().toISOString().slice(0, 10);
    const payload = JSON.parse(JSON.stringify(it));
    delete payload.updatedAt;
    payload.updatedAt = firebase.firestore.FieldValue.serverTimestamp();
    await firebase.firestore().collection('items').doc(it.id).set(payload);
    if (typeof api !== 'undefined' && api.invalidate) {
      api.invalidate('items.json');
      api.invalidate('library/papers.json');
    }
  }

  // ---- data ------------------------------------------------------------------

  async function _loadPapers() {
    _setBusy('Loading library…');
    try {
      let papers = [];
      if (_member) {
        try {
          const data = await api.load('library/papers.json');
          papers = (data && data.papers) || [];
        } catch (e) {
          console.warn('[library-mobile] papers.json load failed:', e.message || e);
        }
        if (!papers.length) {
          try {
            const fallback = await api.load('items.json');
            papers = ((fallback && fallback.items) || []).filter(it => it.type === 'paper');
          } catch (e) { /* handled below */ }
        }
      } else {
        // Cap-granted non-member: the whole-collection query is unprovable
        // under rules — query with the matching filter (library-paper.js
        // V3.605 pattern).
        const snap = await firebridge.db().collection('items')
          .where('meta.library.is_library_entry', '==', true).get();
        papers = [];
        snap.forEach(d => papers.push(Object.assign({ id: d.id }, d.data())));
      }
      _papers = papers.filter(it =>
        it.meta && it.meta.library && it.meta.library.is_library_entry);
      _tagIndex = window.LIBRARY_TAGS ? LIBRARY_TAGS.buildIndex(_papers) : null;
      _lastLoadAt = Date.now();
    } finally {
      _setBusy('');
    }
  }

  // ---- filtering ---------------------------------------------------------------

  function _groupPaperIds(g) {
    if (!g) return null;
    if (g.kind === 'manual') return new Set(g.paper_ids || []);
    if (g.kind === 'draft') {
      const set = new Set();
      for (const p of _papers) {
        const linked = (p.meta.library.linked_drafts || []);
        if (linked.indexOf(g.draft_id) >= 0) set.add(p.id);
      }
      return set;
    }
    return new Set();   // smart groups are desktop-only
  }

  function _visiblePapers() {
    const q = _filterText.trim().toLowerCase();
    const terms = q ? q.split(/\s+/) : [];
    let groupSet = null;
    if (_groupFilter && _groupFilter.kind === 'group') {
      const g = _findGroup(_groupFilter.id, _groupFilter.shared);
      groupSet = g ? _groupPaperIds(g) : new Set();
    }
    const prefs = window.LIBRARY_PREFS ? LIBRARY_PREFS.get() : null;
    const pinned = new Set((prefs && prefs.pinned_papers) || []);

    const out = _papers.filter(p => {
      const lib = p.meta.library;
      if (_groupFilter) {
        if (_groupFilter.kind === 'pinned' && !pinned.has(p.id)) return false;
        if (groupSet && !groupSet.has(p.id)) return false;
      }
      if (_tagFilter) {
        const tags = lib.tags || p.tags || [];
        if (!tags.some(t => String(t).toLowerCase().startsWith(_tagFilter.toLowerCase()))) return false;
      }
      if (terms.length) {
        const hay = [
          p.title, lib.journal, lib.year, lib.citation_key, lib.doi,
          _authorLine(lib.authors),
          (lib.tags || p.tags || []).join(' '),
        ].join(' ').toLowerCase();
        for (const t of terms) if (hay.indexOf(t) < 0) return false;
      }
      return true;
    });
    // Starred first, then by year desc, then title — a phone-friendly
    // default (desktop sort modes are a Customize feature we don't ship).
    out.sort((a, b) => {
      const sa = a.meta.library.starred ? 0 : 1;
      const sb = b.meta.library.starred ? 0 : 1;
      if (sa !== sb) return sa - sb;
      const ya = parseInt(a.meta.library.year, 10) || 0;
      const yb = parseInt(b.meta.library.year, 10) || 0;
      if (ya !== yb) return yb - ya;
      return String(a.title || '').localeCompare(String(b.title || ''));
    });
    return out;
  }

  function _findGroup(gid, shared) {
    if (shared) {
      // Lab-shared groups are loaded by LIBRARY_GROUPS.loadShared into its
      // private state; we keep our own copy from the route for chips.
      return (_sharedGroups || []).find(g => g.id === gid) || null;
    }
    const prefs = window.LIBRARY_PREFS ? LIBRARY_PREFS.get() : null;
    return ((prefs && prefs.paper_groups) || []).find(g => g.id === gid) || null;
  }

  let _sharedGroups = [];
  async function _loadSharedGroups() {
    try {
      const data = await api.load('library/shared_groups.json');
      _sharedGroups = (data && data.groups) || [];
    } catch (e) { _sharedGroups = []; }
  }

  // ---- rendering -----------------------------------------------------------------

  function _recentList() {
    try {
      const raw = localStorage.getItem(RECENT_KEY);
      const list = raw ? JSON.parse(raw) : [];
      return Array.isArray(list) ? list.filter(r => r && r.id) : [];
    } catch (_) { return []; }
  }

  function _renderRecent() {
    const host = document.getElementById('libm-recent');
    if (!host) return;
    const recent = _recentList().slice(0, 8);
    if (!recent.length) { host.innerHTML = ''; host.hidden = true; return; }
    host.hidden = false;
    host.innerHTML =
      '<div class="libm-sec-label">Recently read</div>' +
      '<div class="libm-recent-row">' +
      recent.map(r =>
        `<a class="libm-recent-chip" href="/rm/pages/library-mobile-paper.html?id=${encodeURIComponent(r.id)}">${_esc((r.title || r.id).slice(0, 40))}${(r.title || '').length > 40 ? '…' : ''}</a>`
      ).join('') +
      '</div>';
  }

  function _renderChips() {
    const host = document.getElementById('libm-chips');
    if (!host) return;
    const prefs = window.LIBRARY_PREFS ? LIBRARY_PREFS.get() : null;
    const chips = [];
    const on = (sel) => sel ? ' on' : '';

    // Pinned papers chip
    const pinnedCount = ((prefs && prefs.pinned_papers) || []).length;
    if (pinnedCount) {
      chips.push(`<button class="libm-chip${on(_groupFilter && _groupFilter.kind === 'pinned')}" data-chip="pinned">📌 Pinned (${pinnedCount})</button>`);
    }
    // User groups (manual + draft; smart is desktop-only)
    for (const g of ((prefs && prefs.paper_groups) || [])) {
      if (g.kind === 'smart') continue;
      const active = _groupFilter && _groupFilter.kind === 'group' && _groupFilter.id === g.id && !_groupFilter.shared;
      chips.push(`<button class="libm-chip${on(active)}" data-chip="group" data-gid="${_esc(g.id)}">📁 ${_esc(g.name)}</button>`);
    }
    // Lab-shared groups
    for (const g of _sharedGroups) {
      if (g.kind === 'smart') continue;
      const active = _groupFilter && _groupFilter.kind === 'group' && _groupFilter.id === g.id && _groupFilter.shared;
      chips.push(`<button class="libm-chip${on(active)}" data-chip="group" data-gid="${_esc(g.id)}" data-shared="1">🏛 ${_esc(g.name)}</button>`);
    }
    // Tag chips: pinned tags + top tags
    const pinnedTags = (prefs && prefs.pinned_tags) || [];
    const topTags = [];
    if (_tagIndex && _tagIndex.usage) {
      const entries = Array.from(_tagIndex.usage.entries());
      entries.sort((a, b) => b[1] - a[1]);
      for (const [t] of entries.slice(0, 6)) {
        if (pinnedTags.indexOf(t) < 0) topTags.push(t);
      }
    }
    for (const t of pinnedTags.concat(topTags)) {
      const active = _tagFilter && _tagFilter.toLowerCase() === String(t).toLowerCase();
      chips.push(`<button class="libm-chip libm-chip-tag${on(active)}" data-chip="tag" data-tag="${_esc(t)}">${_esc(t)}</button>`);
    }
    host.innerHTML = chips.join('');
    host.hidden = !chips.length;
  }

  function _cardHtml(p) {
    const lib = p.meta.library;
    const star = lib.starred ? '★' : '☆';
    const isPinned = window.LIBRARY_GROUPS && LIBRARY_GROUPS.isPinned(p.id);
    const sub = [_authorLine(lib.authors), [lib.journal, lib.year].filter(Boolean).join(' · ')]
      .filter(Boolean).join(' — ');
    const noPdf = !(lib.pdf && lib.pdf.storage_path);
    return `<div class="libm-card" data-id="${_esc(p.id)}">
      <button class="libm-star${lib.starred ? ' on' : ''}" data-act="star" data-id="${_esc(p.id)}" aria-label="Star">${star}</button>
      <a class="libm-card-main" href="/rm/pages/library-mobile-paper.html?id=${encodeURIComponent(p.id)}">
        <div class="libm-card-title">${_esc(p.title || 'Untitled')}</div>
        ${sub ? `<div class="libm-card-sub">${_esc(sub)}</div>` : ''}
        ${(isPinned || noPdf) ? `<div class="libm-card-badges">${isPinned ? '<span>📌 pinned</span>' : ''}${noPdf ? '<span class="libm-badge-nopdf">no PDF</span>' : ''}</div>` : ''}
      </a>
      <button class="libm-more" data-act="more" data-id="${_esc(p.id)}" aria-label="More actions">⋯</button>
    </div>`;
  }

  function _render() {
    if (_view !== 'papers') return;
    const host = document.getElementById('libm-list');
    const count = document.getElementById('libm-count');
    if (!host) return;
    const token = ++_renderToken;
    const rows = _visiblePapers();
    if (count) count.textContent = `${rows.length} paper${rows.length === 1 ? '' : 's'}`;
    _renderRecent();
    _renderChips();
    if (!rows.length) {
      host.innerHTML = `<div class="libm-empty">${_papers.length ? 'No papers match.' : 'The library is empty — add a paper with ＋.'}</div>`;
      return;
    }
    // Chunked render: first 50 sync, then idle batches (library.js pattern).
    const CHUNK = 50, IDLE_CHUNK = 100;
    host.innerHTML = rows.slice(0, CHUNK).map(_cardHtml).join('');
    let i = CHUNK;
    function more() {
      if (token !== _renderToken || i >= rows.length) return;
      const frag = rows.slice(i, i + IDLE_CHUNK).map(_cardHtml).join('');
      i += IDLE_CHUNK;
      host.insertAdjacentHTML('beforeend', frag);
      (window.requestIdleCallback || window.requestAnimationFrame)(more);
    }
    if (i < rows.length) (window.requestIdleCallback || window.requestAnimationFrame)(more);
  }

  // ---- card actions ------------------------------------------------------------

  function _paperById(id) { return _papers.find(p => p.id === id) || null; }

  async function _toggleStar(id) {
    const p = _paperById(id);
    if (!p) return;
    p.meta.library.starred = !p.meta.library.starred;
    try {
      await _saveOne(p);
      _render();
    } catch (e) {
      p.meta.library.starred = !p.meta.library.starred;   // roll back
      _toast(`Save failed: ${e.message}`, 'error');
    }
  }

  function _openRowSheet(id) {
    const p = _paperById(id);
    if (!p || !window.APP_SHEET) return;
    const lib = p.meta.library;
    const isPinned = window.LIBRARY_GROUPS && LIBRARY_GROUPS.isPinned(id);
    APP_SHEET.open({
      title: (p.title || 'Paper').slice(0, 60),
      build(body, api) {
        body.innerHTML = `
          <button class="libm-sheet-row" data-row="open">📖 <span>Open in reader</span></button>
          <button class="libm-sheet-row" data-row="star">${lib.starred ? '☆' : '★'} <span>${lib.starred ? 'Remove star' : 'Star'}</span></button>
          <button class="libm-sheet-row" data-row="pin">📌 <span>${isPinned ? 'Unpin' : 'Pin to my papers'}</span></button>
          <button class="libm-sheet-row" data-row="group">📁 <span>Add to group…</span></button>`;
        body.addEventListener('click', (ev) => {
          const b = ev.target.closest('[data-row]');
          if (!b) return;
          const act = b.getAttribute('data-row');
          api.close();
          if (act === 'open') {
            location.href = `/rm/pages/library-mobile-paper.html?id=${encodeURIComponent(id)}`;
          } else if (act === 'star') {
            _toggleStar(id);
          } else if (act === 'pin') {
            if (window.LIBRARY_GROUPS) { LIBRARY_GROUPS.togglePin(id); }
          } else if (act === 'group') {
            if (window.LIBRARY_GROUPS) LIBRARY_GROUPS.openGroupPicker(id);
          }
        });
      },
    });
  }

  // ---- quick-add (＋ FAB) ---------------------------------------------------------

  function _openQuickAdd() {
    if (!window.APP_SHEET) return;
    APP_SHEET.open({
      title: 'Add to library',
      build(body, api) {
        body.innerHTML = `
          <label class="libm-sheet-label">Add by DOI, PMID, or arXiv id</label>
          <div class="libm-sheet-addrow">
            <input type="text" id="libm-add-input" placeholder="10.1234/… or 12345678" autocapitalize="off" autocorrect="off">
            <button class="btn" id="libm-add-go">Look up</button>
          </div>
          <div class="libm-sheet-div"></div>
          <button class="libm-sheet-row" data-row="upload">⬆️ <span>Upload PDF from Files</span></button>`;
        body.querySelector('#libm-add-go').addEventListener('click', () => {
          const q = (body.querySelector('#libm-add-input').value || '').trim();
          if (!q) return;
          api.close();
          _addByIdentifier(q);
        });
        body.addEventListener('click', (ev) => {
          const b = ev.target.closest('[data-row="upload"]');
          if (!b) return;
          api.close();
          const inp = document.getElementById('libm-file');
          if (inp) inp.click();
        });
      },
    });
  }

  /* Mirror of the desktop _wireDoiAdd pipeline (library.js V3.497 dedupe):
   * lookup → dedupe by identifier/title → buildPaperItem → one-doc save. */
  async function _addByIdentifier(trimmed) {
    const params = {};
    if (/^10\./i.test(trimmed) || /doi\.org/i.test(trimmed)) params.doi = trimmed;
    else if (/^\d+$/.test(trimmed)) params.pmid = trimmed;
    else if (/^\d{4}\.\d{4,5}/.test(trimmed) || /^arxiv:/i.test(trimmed)) params.arxiv_id = trimmed;
    else params.title = trimmed;
    try {
      _setBusy('Looking up…');
      const meta = await LIBRARY_METADATA.lookup(params);
      if (meta.error) throw new Error(meta.error);
      if (params.title) {
        const authors = (meta.authors || []).slice(0, 3).map(a => a.family).filter(Boolean).join(', ');
        const ok = window.confirm(
          `"${trimmed}" isn't a DOI/PMID/arXiv id — searched by title instead.\n\n` +
          `Best match:\n${meta.title || '(untitled)'}\n` +
          `${[authors, meta.year, meta.journal].filter(Boolean).join(' · ')}\n\nAdd this paper?`);
        if (!ok) return;
      }
      const dupHit = LIBRARY_UPLOAD.findExistingEntry
        ? LIBRARY_UPLOAD.findExistingEntry(meta, _papers)
        : null;
      if (dupHit) {
        const blockIt = dupHit.matchedBy !== 'title'
          || window.confirm(`"${dupHit.item.title}" looks like it's already in the library. Skip adding a duplicate?\n(Cancel adds it anyway.)`);
        if (blockIt) {
          _toast(`"${dupHit.item.title}" is already in the library.`, 'info');
          return;
        }
      }
      const item = LIBRARY_METADATA.buildPaperItem(meta, null, null);
      if (_papers.some(x => x.id === item.id)) {
        item.id = `${item.id}-${Date.now().toString(36).slice(-4)}`;
      }
      await _saveOne(item);
      await _loadPapers();
      _render();
      _toast(`Added "${item.title}" (no PDF yet).`, 'ok');
    } catch (e) {
      _toast(`Lookup failed: ${e.message}`, 'error');
    } finally {
      _setBusy('');
    }
  }

  /* Lazy pdf.js: the metadata first-page sniff + import-time ref parse need
   * window.PDF_VIEWER, which this page doesn't load at boot (it's the list —
   * keep first paint light). Inject page-layout + the viewer module on the
   * first upload. */
  let _pdfEnginePromise = null;
  function _ensurePdfEngine() {
    if (window.PDF_VIEWER) return Promise.resolve();
    if (_pdfEnginePromise) return _pdfEnginePromise;
    _pdfEnginePromise = new Promise((resolve) => {
      const s1 = document.createElement('script');
      s1.src = '/rm/js/page-layout.js';
      document.body.appendChild(s1);
      const s2 = document.createElement('script');
      s2.type = 'module';
      s2.src = '/rm/js/pdf-viewer.js';
      s2.onload = () => resolve();
      s2.onerror = () => resolve();   // sniff degrades gracefully without it
      document.body.appendChild(s2);
    });
    return _pdfEnginePromise;
  }

  /* Lean mirror of the desktop _ingestOne (hash dedupe → first-page sniff →
   * metadata lookup → attach-or-create → upload → one-doc save + background
   * ref parse / Semantic Scholar enrichment). */
  async function _ingestOne(file) {
    if (file.type !== 'application/pdf' && !/\.pdf$/i.test(file.name)) {
      throw new Error('Only PDF files are supported.');
    }
    await _ensurePdfEngine();
    _setBusy(`Hashing ${file.name}…`);
    const fullHash = await LIBRARY_UPLOAD.sha256Hex(file);
    const shortHash = fullHash.slice(0, 16);
    const dup = LIBRARY_UPLOAD.findDuplicate(fullHash, _papers)
             || LIBRARY_UPLOAD.findDuplicate(shortHash, _papers);
    if (dup) {
      _toast(`Skipped duplicate (already in library as "${dup.title}").`, 'info');
      return;
    }

    _setBusy(`Reading ${file.name}…`);
    let firstPage = { text: '', doi_guess: '', arxiv_guess: '', title_guess: '' };
    try { firstPage = await LIBRARY_METADATA.extractFirstPage(file); }
    catch (e) { console.warn('[library-mobile] first-page extract failed:', e.message); }

    _setBusy(`Looking up metadata…`);
    let meta = {};
    let titleGuess = '';
    try {
      if (firstPage.doi_guess) meta = await LIBRARY_METADATA.lookup({ doi: firstPage.doi_guess });
      else if (firstPage.arxiv_guess) meta = await LIBRARY_METADATA.lookup({ arxiv_id: firstPage.arxiv_guess });
      else {
        titleGuess = (firstPage.title_guess || '').trim();
        if (!titleGuess && firstPage.text) {
          titleGuess = (firstPage.text.split('\n').find(l => l.trim().length > 12) || '').trim();
        }
        if (titleGuess) {
          const hit = await LIBRARY_METADATA.lookup({ title: titleGuess.slice(0, 200) });
          if (hit && !hit.error && window.confirm(
            `No DOI found in "${file.name}" — searched by title.\n\nBest match:\n${hit.title || '(untitled)'}\n\nUse this metadata? (Cancel keeps the PDF with its own title.)`)) {
            meta = hit;
          }
        }
      }
    } catch (e) { console.warn('[library-mobile] metadata lookup failed:', e.message); }
    if (!meta || meta.error || !meta.title) {
      meta = { title: titleGuess || file.name.replace(/\.pdf$/i, ''), authors: [], year: '', journal: '', source: 'manual' };
    }

    // Attach to an existing PDF-less entry on a confident match.
    const hit = LIBRARY_UPLOAD.findExistingEntry
      ? LIBRARY_UPLOAD.findExistingEntry(meta, _papers) : null;
    if (hit) {
      const match = hit.item;
      match.meta = match.meta || {};
      match.meta.library = match.meta.library || {};
      const mlib = match.meta.library;
      const isTitleMatch = hit.matchedBy === 'title';
      if (mlib.pdf) {
        if (!isTitleMatch) {
          _setBusy('');
          _toast(`"${match.title}" is already in the library with a PDF — skipped.`, 'info');
          return;
        }
      } else if (!isTitleMatch || window.confirm(
        `"${file.name}" looks like "${match.title}" (already in the library, no PDF). Attach this PDF to it?\n(Cancel adds it as a new paper.)`)) {
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
        delete mlib.pdf_status;
        await _saveOne(match);
        _setBusy('');
        _toast(`Attached PDF to "${match.title}".`, 'ok');
        if (LIBRARY_UPLOAD.parseAndCacheRefs) {
          LIBRARY_UPLOAD.parseAndCacheRefs(match.id, file).catch(e =>
            console.warn('[library-mobile] ref parse failed:', e));
        }
        if (LIBRARY_UPLOAD.enrichItemFromSemanticScholar) {
          LIBRARY_UPLOAD.enrichItemFromSemanticScholar(match.id).catch(e =>
            console.warn('[library-mobile] SS enrichment failed:', e));
        }
        return;
      }
    }

    const provisional = LIBRARY_METADATA.buildPaperItem(meta, null, null);
    let paperId = provisional.id;
    if (_papers.some(it => it.id === paperId)) {
      paperId = `${paperId}-${shortHash.slice(0, 6)}`;
    }
    _setBusy(`Uploading ${file.name}…`);
    const pdfInfo = await LIBRARY_UPLOAD.uploadPdf(paperId, file);
    const item = LIBRARY_METADATA.buildPaperItem(meta, pdfInfo, null);
    item.id = paperId;
    _setBusy('Saving…');
    await _saveOne(item);
    _setBusy('');
    _toast(`Added "${item.title}".`, 'ok');
    if (LIBRARY_UPLOAD.parseAndCacheRefs) {
      LIBRARY_UPLOAD.parseAndCacheRefs(item.id, file).catch(e =>
        console.warn('[library-mobile] ref parse failed:', e));
    }
    if (LIBRARY_UPLOAD.enrichItemFromSemanticScholar) {
      LIBRARY_UPLOAD.enrichItemFromSemanticScholar(item.id).catch(e =>
        console.warn('[library-mobile] SS enrichment failed:', e));
    }
  }

  async function _handleFiles(files) {
    if (!files || !files.length) return;
    if (!firebase || !firebase.auth || !firebase.auth().currentUser) {
      _toast('Sign in to upload PDFs.', 'error');
      return;
    }
    for (const file of files) {
      try { await _ingestOne(file); }
      catch (err) {
        console.error(err);
        _toast(`Upload failed for ${file.name}: ${err.message || err}`, 'error');
      }
    }
    await _loadPapers();
    _render();
  }

  // ---- comments feed --------------------------------------------------------------

  function _feedOrder() {
    // Recently-touched papers first — a cheap proxy for "recently annotated"
    // that costs zero extra reads.
    return _papers.slice().sort((a, b) =>
      String(b.updated_at || '').localeCompare(String(a.updated_at || '')));
  }

  async function _loadFeedPage() {
    if (_feedLoading) return;
    _feedLoading = true;
    const moreBtn = document.getElementById('libm-feed-more');
    if (moreBtn) { moreBtn.disabled = true; moreBtn.textContent = 'Loading…'; }
    try {
      const ordered = _feedOrder();
      const page = ordered.slice(_feedCursor, _feedCursor + FEED_PAPERS_PER_PAGE);
      _feedCursor += page.length;
      const db = firebridge.db();
      const me = firebase.auth().currentUser;
      const queue = page.slice();
      const rows = [];
      async function worker() {
        while (queue.length) {
          const p = queue.shift();
          const col = db.collection('papers').doc(p.id).collection('annotations');
          try {
            const [labSnap, mineSnap] = await Promise.all([
              col.where('visibility', '==', 'lab').get(),
              me ? col.where('creator.uid', '==', me.uid).where('visibility', '==', 'private').get() : Promise.resolve(null),
            ]);
            const seen = new Set();
            const absorb = (snap) => {
              if (!snap) return;
              snap.forEach(d => {
                if (seen.has(d.id)) return;
                seen.add(d.id);
                rows.push(Object.assign({ id: d.id, paperId: p.id, paperTitle: p.title }, d.data()));
              });
            };
            absorb(labSnap); absorb(mineSnap);
          } catch (e) { /* per-paper failures are non-fatal */ }
        }
      }
      await Promise.all(Array.from({ length: Math.min(FEED_CONCURRENCY, page.length) }, worker));
      _feedRows = _feedRows.concat(rows);
      _renderFeed();
    } finally {
      _feedLoading = false;
      const btn = document.getElementById('libm-feed-more');
      if (btn) {
        const done = _feedCursor >= _papers.length;
        btn.disabled = done;
        btn.textContent = done ? 'All papers checked' : 'Load more';
      }
    }
  }

  function _annSnippet(ann) {
    const pages = (ann.target && ann.target.pages) || [];
    for (const pg of pages) {
      const q = pg.selectors && pg.selectors.textQuote && pg.selectors.textQuote.exact;
      if (q) return q;
    }
    return '';
  }

  function _renderFeed() {
    const host = document.getElementById('libm-feed');
    if (!host) return;
    const rows = _feedRows.slice().sort((a, b) => {
      const ta = a.created && a.created.toMillis ? a.created.toMillis() : 0;
      const tb = b.created && b.created.toMillis ? b.created.toMillis() : 0;
      return tb - ta;
    });
    if (!rows.length) {
      host.innerHTML = `<div class="libm-empty">${_feedCursor ? 'No annotations found yet — load more papers below.' : 'Loading…'}</div>`;
      return;
    }
    host.innerHTML = rows.map(ann => {
      const snippet = _annSnippet(ann);
      const who = (ann.creator && ann.creator.displayName) || '';
      const when = ann.created && ann.created.toDate ? ann.created.toDate().toLocaleDateString() : '';
      return `<a class="libm-feed-row" href="/rm/pages/library-mobile-paper.html?id=${encodeURIComponent(ann.paperId)}#ann-${encodeURIComponent(ann.id)}">
        <div class="libm-feed-paper">${_esc(ann.paperTitle || ann.paperId)}</div>
        ${snippet ? `<div class="libm-feed-quote">“${_esc(snippet.slice(0, 160))}${snippet.length > 160 ? '…' : ''}”</div>` : ''}
        ${ann.comment ? `<div class="libm-feed-comment">💬 ${_esc(String(ann.comment).slice(0, 160))}</div>` : ''}
        <div class="libm-feed-meta">${_esc([who, when].filter(Boolean).join(' · '))}</div>
      </a>`;
    }).join('');
  }

  function _switchView(view) {
    _view = view;
    document.getElementById('libm-view-papers').hidden = view !== 'papers';
    document.getElementById('libm-view-comments').hidden = view !== 'comments';
    document.querySelectorAll('#libm-seg button').forEach(b =>
      b.classList.toggle('on', b.getAttribute('data-view') === view));
    if (view === 'comments' && !_feedStarted) {
      _feedStarted = true;
      _loadFeedPage();
    }
    if (view === 'papers') _render();
  }

  // ---- boot -----------------------------------------------------------------------

  async function _boot() {
    try { await firebridge.loadAccessGrant(); } catch (_) { /* role-only */ }
    _member = firebridge.isAdmin() || firebridge.isLabMember();

    if (window.LIBRARY_PREFS) {
      try { await LIBRARY_PREFS.load(); } catch (_) { /* defaults */ }
    }
    if (window.LIBRARY_GROUPS) {
      LIBRARY_GROUPS.init({
        getPapers: () => _visiblePapers(),
        parseQuery: (q) => q,
        matches: () => true,          // smart groups are desktop-only here
        isAdmin: () => firebridge.isAdmin(),
        getDraftTitles: () => ({}),
        onChanged: () => { _render(); },
        toast: _toast,
      });
      LIBRARY_GROUPS.loadShared().catch(() => {});
    }
    await Promise.all([_loadPapers(), _loadSharedGroups()]);
    _render();

    // Search
    const input = document.getElementById('libm-search');
    if (input) {
      input.addEventListener('input', () => {
        _filterText = input.value;
        if (_searchDebounce) clearTimeout(_searchDebounce);
        _searchDebounce = setTimeout(() => { _searchDebounce = 0; _render(); }, 150);
      });
    }

    // Chips + list delegation
    const chips = document.getElementById('libm-chips');
    if (chips) {
      chips.addEventListener('click', (ev) => {
        const b = ev.target.closest('[data-chip]');
        if (!b) return;
        const kind = b.getAttribute('data-chip');
        if (kind === 'pinned') {
          _groupFilter = (_groupFilter && _groupFilter.kind === 'pinned') ? null : { kind: 'pinned' };
        } else if (kind === 'group') {
          const gid = b.getAttribute('data-gid');
          const shared = b.getAttribute('data-shared') === '1';
          const active = _groupFilter && _groupFilter.kind === 'group'
            && _groupFilter.id === gid && !!_groupFilter.shared === shared;
          _groupFilter = active ? null : { kind: 'group', id: gid, shared };
        } else if (kind === 'tag') {
          const tag = b.getAttribute('data-tag');
          _tagFilter = (_tagFilter === tag) ? '' : tag;
        }
        _render();
      });
    }
    const list = document.getElementById('libm-list');
    if (list) {
      list.addEventListener('click', (ev) => {
        const b = ev.target.closest('button[data-act]');
        if (!b) return;
        ev.preventDefault();
        const act = b.getAttribute('data-act');
        const id = b.getAttribute('data-id');
        if (act === 'star') _toggleStar(id);
        else if (act === 'more') _openRowSheet(id);
      });
    }

    // Segmented control
    const seg = document.getElementById('libm-seg');
    if (seg) {
      seg.addEventListener('click', (ev) => {
        const b = ev.target.closest('button[data-view]');
        if (b) _switchView(b.getAttribute('data-view'));
      });
    }
    const moreBtn = document.getElementById('libm-feed-more');
    if (moreBtn) moreBtn.addEventListener('click', _loadFeedPage);

    // Upload input
    const fileInput = document.getElementById('libm-file');
    if (fileInput) {
      fileInput.addEventListener('change', () => {
        _handleFiles(Array.from(fileInput.files || []));
        fileInput.value = '';
      });
    }

    // ＋ FAB
    if (window.APP_SHEET) {
      const fab = APP_SHEET.fab({ label: 'Add to library', onClick: _openQuickAdd });
      document.body.appendChild(fab);
    }

    // Tab-lifecycle: nothing to pause (no listeners); refresh when the tab
    // comes back after >5 minutes so the list doesn't go stale on a phone
    // that sits on another tab all day.
    window.OURLAB_TAB_LIFECYCLE = {
      pause() { /* no live listeners on the list page */ },
      resume() {
        if (Date.now() - _lastLoadAt > 5 * 60 * 1000) {
          _loadPapers().then(_render).catch(() => {});
        } else {
          _renderRecent();   // cheap: pick up papers read since we hid
        }
      },
    };
  }

  document.addEventListener('DOMContentLoaded', () => {
    if (typeof firebridge === 'undefined') {
      _setBusy('Firebase failed to load — check your connection.');
      return;
    }
    firebridge.onAuth((user) => {
      if (user && !_booted) {
        _booted = true;
        _boot().catch(e => {
          console.error('[library-mobile] boot failed:', e);
          _setBusy(`Could not load the library: ${e.message || e}`);
        });
      }
    });
  });
})();
