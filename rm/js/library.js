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
  let _items = [];                  // full items.json items list
  let _libraryPapers = [];          // filter: type=paper, meta.library.is_library_entry
  let _filterText = '';
  let _busy = false;
  let _tagFilter = '';              // active tag-prefix filter (clicking a chip)
  let _tagIndex = null;             // built from _libraryPapers on each _load

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
      const data = await api.load('items.json');
      _items = (data && data.items) || [];
      _libraryPapers = _items.filter(it =>
        it.type === 'paper' &&
        it.meta && it.meta.library && it.meta.library.is_library_entry
      );
      // Refresh the tag autocomplete index after every load. Cheap — one
      // O(papers × tags-per-paper) walk and the result is reused for chip
      // rendering, autocomplete, and prefix filtering.
      _tagIndex = window.LIBRARY_TAGS ? LIBRARY_TAGS.buildIndex(_libraryPapers) : null;
    } finally {
      _setBusy('');
    }
  }

  async function _saveItems() {
    await api.save('items.json', { items: _items });
  }

  // ---- Search ------------------------------------------------------------

  function _parseQuery(q) {
    // Supported: free text + field:value tokens (title:, author:, year:,
    // journal:, tag:). Quotes optional. Negation via leading "-".
    // tag: takes a colon-delimited prefix, e.g. tag:research:papers:2026
    // — the tokenizer captures everything from the colon to the next
    // whitespace as one value, including embedded colons.
    const fields = { title: [], author: [], year: [], journal: [], tag: [] };
    const free = [];
    const negFree = [];
    const re = /(-?)(?:(title|author|year|journal|tag):)?(?:"([^"]+)"|(\S+))/g;
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
    try {
      if (firstPage.doi_guess) {
        meta = await LIBRARY_METADATA.lookup({ doi: firstPage.doi_guess });
      } else if (firstPage.arxiv_guess) {
        meta = await LIBRARY_METADATA.lookup({ arxiv_id: firstPage.arxiv_guess });
      } else if (firstPage.text) {
        // Last resort: first non-empty line as title query
        const titleGuess = (firstPage.text.split('\n').find(l => l.trim().length > 12) || '').trim();
        if (titleGuess) {
          meta = await LIBRARY_METADATA.lookup({ title: titleGuess.slice(0, 200) });
        }
      }
    } catch (e) {
      console.warn('[library] metadata lookup failed:', e.message);
    }
    if (!meta || meta.error) {
      meta = {
        title: file.name.replace(/\.pdf$/i, ''),
        authors: [],
        year: '',
        journal: '',
        source: 'manual',
      };
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
    _items.push(item);
    _setBusy(`Saving items.json…`);
    await _saveItems();
    _setBusy('');
    _toast(`Added "${item.title}".`, 'ok');
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

  function _renderRow(it) {
    const lib = it.meta.library;
    const tr = document.createElement('tr');
    tr.dataset.id = it.id;
    const journalYear = [lib.journal, lib.year].filter(Boolean).join(' · ');
    const star = lib.starred ? '★' : '☆';
    tr.innerHTML = `
      <td class="lib-col-star" title="Toggle star">
        <button class="lib-star-btn" data-id="${_escape(it.id)}">${star}</button>
      </td>
      <td class="lib-col-title">
        <div class="lib-title">
          <a href="/rm/pages/library-paper.html?id=${encodeURIComponent(it.id)}" class="lib-title-link">${_escape(it.title || 'Untitled')}</a>
        </div>
        <div class="lib-authors">${_escape(_authorLine(lib.authors))}</div>
      </td>
      <td class="lib-col-journal">${_escape(journalYear)}</td>
      <td class="lib-col-key"><code>${_escape(lib.citation_key || '')}</code></td>
      <td class="lib-col-actions">
        ${lib.pdf ? `<a class="btn btn-sm" href="/rm/pages/library-paper.html?id=${encodeURIComponent(it.id)}">Read</a>` : '<span class="muted">no PDF</span>'}
        ${lib.pdf ? `<button class="btn btn-sm" data-act="open-pdf-tab" data-id="${_escape(it.id)}" title="Open raw PDF in new tab">↗</button>` : ''}
        ${lib.doi ? `<a class="btn btn-sm" href="https://doi.org/${_escape(lib.doi)}" target="_blank" rel="noopener">DOI</a>` : ''}
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

    const parsed = _parseQuery(_filterText);
    let filtered = visiblePool.filter(p => _matches(p, parsed));
    if (_tagFilter) {
      filtered = filtered.filter(p =>
        window.LIBRARY_TAGS && LIBRARY_TAGS.matchPrefix(LIBRARY_TAGS.getTags(p), _tagFilter)
      );
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

    for (const p of filtered) tbody.appendChild(_renderRow(p));
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

    if (btn.classList.contains('lib-star-btn')) {
      lib.starred = !lib.starred;
      it.updated_at = new Date().toISOString().slice(0, 10);
      try {
        await _saveItems();
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
    input.addEventListener('input', () => {
      _filterText = input.value;
      _render();
    });
  }

  function _wireDoiAdd() {
    const btn = document.getElementById('library-add-doi');
    if (!btn) return;
    btn.addEventListener('click', async () => {
      const q = window.prompt('Enter DOI, PMID, or arXiv ID:');
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
        const item = LIBRARY_METADATA.buildPaperItem(meta, null, null);
        if (_items.some(x => x.id === item.id)) {
          _toast(`"${item.title}" is already in the library.`, 'info');
          return;
        }
        _items.push(item);
        await _saveItems();
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

  // ---- Extension capture sync (phase 6c) ---------------------------------

  let _syncedThisSession = false;
  let _lastSyncMs = 0;

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
      });
  }

  // Truthy iff the signed-in user is admin per any source we can reach:
  // local mirror, firebridge profile, or firebridge's _ready boolean.
  function _isAdminAny() {
    if (_ownProfileCache && _ownProfileCache.role === 'admin') return true;
    const fbProfile = window.firebridge && firebridge.getProfile && firebridge.getProfile();
    if (fbProfile && fbProfile.role === 'admin') return true;
    if (window.firebridge && firebridge.isReady && firebridge.isReady()) return true;
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
    const fbReady = !!(window.firebridge && firebridge.isReady && firebridge.isReady());
    const fbProfile = window.firebridge && firebridge.getProfile && firebridge.getProfile();
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
    if (window.firebridge && typeof firebridge.onAuth === 'function') {
      firebridge.onAuth(async (user) => {
        _updateAuthHint();
        _updateExtensionMemberStatus();
        _renderAccountDiagnostic();
        if (user && window.LIBRARY_PREFS) {
          await LIBRARY_PREFS.load();
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
