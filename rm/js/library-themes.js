/* library-themes.js — V3.367 (foundation) + V3.368 (notes & voting)
 *                      + V3.496 (research groups, relevance, related themes)
 *
 * Topics (called "Lab Themes" until V3.630 — the rename is user-facing only;
 * ids, the `labThemes` collection, the `?tab=themes` URL and the `theme:`
 * search token are all unchanged, so every existing link and saved query
 * still works). Shared literature-review clusters around the lab's core
 * concepts: **what a paper is ABOUT**. The sibling axis is the research map's
 * "Lab focus" — what a paper is FOR. Those two boxes sat adjacent in the
 * reader named "Lab themes" and "Lab focus" and were indistinguishable; see
 * V3.630's plan doc.
 *
 * Data model:
 *
 *   labThemes/{themeId}                — {name, description, created_by,
 *                                        creator_name, created_at,
 *                                        updated_at, archived}
 *   labThemes/{themeId}/notes/{id}     — co-written synthesis blocks
 *                                        {order, body_html, created_by,
 *                                        creator_name, created_at,
 *                                        last_editor, modified_at}
 *   labThemes/{themeId}/votes/{uid}    — one "helped me" doc per user:
 *                                        {helped: [itemId], updated_at}
 *   labThemes/{themeId}/comments/{id}  — SECTION_COMMENTS thread
 *   labThemes/{themeId}/groups/{key}   — V3.496 research-group curation
 *                                        {key, canonical_name, institution,
 *                                        note, starred, merged_keys[],
 *                                        created_by, last_editor, …}
 *   labThemes/{themeId}/related/{id}   — V3.496 manually-ranked related
 *                                        themes {rank, added_by, added_at}
 *   items/{id}.meta.library.themes[]   — paper membership (written via
 *                                        LIBRARY_LINKS.toggleTheme)
 *   items/{id}.meta.library.theme_relevance{themeId:1|2|3} — V3.496 per-
 *                                        theme paper weight (Core/Supporting/
 *                                        Tangential) via setThemeRelevance;
 *                                        drives the research-group ranking.
 *
 * V3.496 research groups are DERIVED client-side: a theme's papers are
 * grouped by last-author PI (keyed by ORCID when present, else family+first-
 * initial), ranked by Σ relevance (⭐ starred pinned first), and used to
 * filter the paper list. Per-theme curation (canonical name / institution /
 * note / star / name-variant merges) lives in the groups subcollection.
 *
 * Deliberately NOT an api route: the adapter's lab-scope save is a
 * whole-collection batch replace — exactly the last-write-wins hazard
 * co-edited data must avoid. All access is direct firebridge.db() refs
 * (the PMR / SECTION_COMMENTS precedent). All reads are whole-collection
 * gets / snapshots with CLIENT-SIDE sort — no orderBy+where, so no
 * composite indexes. Keep it that way.
 *
 * Concurrency (V3.368 notes): one doc per note block, live onSnapshot.
 * Two people editing DIFFERENT notes never conflict; the SAME note is
 * block-level last-write-wins — a focused note defers remote repaints
 * until blur and shows an "edited by X" notice instead of clobbering
 * the caret. protocol-yjs.js is the documented upgrade path if
 * character-level co-editing is ever needed.
 *
 * Rendering boots only on library.html?tab=themes (__LIB_TAB guard); the
 * paper reader also loads this file purely for the lookup API.
 *
 * Public API (window.LIBRARY_THEMES):
 *   loadThemes(force) → Promise<theme[]> (non-archived, name-sorted)
 *   getThemes()        → cached theme[] or null
 *   getThemeNameById(id) → name or id
 */
(function () {
  'use strict';

  var _themes = null;        // cached non-archived theme list (name-sorted)
  var _allThemes = [];       // incl. archived (themes-tab management)
  var _loading = null;
  var _papers = [];          // library/papers.json pool (themes tab only)
  var _openId = null;        // open theme id (detail view)
  var _voteCounts = {};      // itemId → count (open theme)
  var _myVotes = new Set();  // itemIds I voted helped (open theme)
  var _notes = [];           // open theme's notes
  var _notesUnsub = null;
  var _commentsMount = null;
  var _noteTimers = {};      // noteId → debounce timer
  var _noteDirty = {};       // noteId → unsaved local edits flag
  var _statusT = null;
  /* V3.496 — research groups + related themes (open theme). */
  var _groups = {};          // groupKey → curation doc {key, canonical_name, …}
  var _related = [];         // related-theme rows (rank-sorted)
  var _groupFilter = null;   // active research-group key filtering the paper list
  var _groupsShown = 5;      // visible group cards (5 → 10 → all)
  var _relatedShown = 5;     // visible related-theme cards
  var _suggExpanded = {};    // groupKey → suggested-papers panel expanded?

  /* ── Shared helpers ─────────────────────────────────────── */

  function _esc(s) {
    return String(s == null ? '' : s).replace(/[&<>"']/g, function (c) {
      return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c];
    });
  }

  function _db() {
    if (typeof firebase === 'undefined' || !firebase.firestore) {
      throw new Error('Firestore unavailable.');
    }
    return firebase.firestore();
  }
  function _themeRef(id) { return _db().collection('labThemes').doc(id); }
  function _me() {
    var u = (firebase.auth && firebase.auth().currentUser) || null;
    var prof = (typeof firebridge !== 'undefined' && firebridge.getProfile && firebridge.getProfile()) || null;
    return {
      uid: u ? u.uid : null,
      name: (prof && prof.name) || (u && (u.displayName || u.email)) || 'unknown',
    };
  }
  function _isAdmin() {
    return !!(typeof firebridge !== 'undefined' && firebridge.isAdmin && firebridge.isAdmin());
  }
  function _canEditTheme(t) {
    var me = _me();
    return _isAdmin() || (me.uid && t.created_by === me.uid);
  }
  function _nowIso() { return new Date().toISOString(); }
  function _today() { return new Date().toISOString().slice(0, 10); }

  /* Allowlist HTML sanitizer for co-written note bodies — applied on
   * save AND render (defense in depth against a peer's bad paste). */
  var _SAFE_TAGS = { B: 1, I: 1, U: 1, EM: 1, STRONG: 1, A: 1, UL: 1, OL: 1, LI: 1, P: 1, BR: 1, DIV: 1, CODE: 1, SUB: 1, SUP: 1 };
  function _sanitizeHtml(html) {
    var doc = new DOMParser().parseFromString('<div>' + String(html || '') + '</div>', 'text/html');
    var root = doc.body.firstChild;
    (function walk(node) {
      var children = Array.prototype.slice.call(node.childNodes);
      children.forEach(function (child) {
        if (child.nodeType === Node.TEXT_NODE) return;
        if (child.nodeType !== Node.ELEMENT_NODE || !_SAFE_TAGS[child.tagName]) {
          // Unwrap: keep the text/children, drop the element (kills
          // script/style/iframe and unknown wrappers alike).
          while (child.firstChild) node.insertBefore(child.firstChild, child);
          node.removeChild(child);
          return;
        }
        // Strip every attribute except a safe href on <a>.
        Array.prototype.slice.call(child.attributes).forEach(function (attr) {
          if (child.tagName === 'A' && attr.name === 'href' && /^https?:/i.test(child.getAttribute('href') || '')) return;
          child.removeAttribute(attr.name);
        });
        if (child.tagName === 'A') {
          child.setAttribute('target', '_blank');
          child.setAttribute('rel', 'noopener');
        }
        walk(child);
      });
    })(root);
    return root.innerHTML;
  }

  function _setStatus(msg) {
    var el = document.getElementById('lt-status');
    if (!el) return;
    el.textContent = msg || '';
    if (_statusT) clearTimeout(_statusT);
    if (msg) _statusT = setTimeout(function () { el.textContent = ''; }, 4000);
  }

  /* ── Theme lookup API (used by the reader chips + library token) ── */

  function loadThemes(force) {
    if (!force && _themes) return Promise.resolve(_themes);
    if (_loading) return _loading;
    _loading = _db().collection('labThemes').get().then(function (snap) {
      _allThemes = snap.docs.map(function (d) {
        var x = d.data() || {};
        x.id = d.id;
        return x;
      });
      _allThemes.sort(function (a, b) { return (a.name || '').localeCompare(b.name || ''); });
      _themes = _allThemes.filter(function (t) { return !t.archived; });
      _loading = null;
      return _themes;
    }, function (err) {
      _loading = null;
      throw err;
    });
    return _loading;
  }
  function getThemes() { return _themes; }
  function getThemeNameById(id) {
    var t = (_allThemes || []).find(function (x) { return x.id === id; });
    return t ? (t.name || id) : id;
  }

  /* ── Create theme ───────────────────────────────────────── */

  function _slugify(name) {
    var base = String(name || '').toLowerCase().trim()
      .replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 48) || 'theme';
    var slug = base, n = 2;
    var taken = new Set(_allThemes.map(function (t) { return t.id; }));
    while (taken.has(slug)) slug = base + '-' + (n++);
    return slug;
  }

  function _openCreateModal() {
    var me = _me();
    if (!me.uid) { _setStatus('Sign in first.'); return; }
    _openMetaModal({
      title: 'New topic',
      name: '',
      description: '',
      onSave: async function (name, description) {
        var id = _slugify(name);
        await _themeRef(id).set({
          name: name,
          description: description,
          created_by: me.uid,
          creator_name: me.name,
          created_at: _nowIso(),
          updated_at: _nowIso(),
          archived: false,
        });
        await loadThemes(true);
        _renderCards();
        _openTheme(id);
      },
    });
  }

  /* Shared name/description modal (create + edit). Reuses the reader's
   * lp-oim modal CSS so it matches the association picker. */
  function _openMetaModal(opts) {
    var existing = document.getElementById('lt-meta-modal');
    if (existing) existing.remove();
    var modal = document.createElement('div');
    modal.id = 'lt-meta-modal';
    modal.className = 'lp-overlay-import-modal';
    modal.innerHTML =
      '<div class="lp-oim-backdrop"></div>' +
      '<div class="lp-oim-card">' +
      '<div class="lp-oim-head">' + _esc(opts.title) + '</div>' +
      '<div class="lt-meta-form">' +
      '<label>Name<input type="text" id="lt-meta-name" maxlength="80" placeholder="e.g. Traction force microscopy" value="' + _esc(opts.name) + '"></label>' +
      '<label>Description<textarea id="lt-meta-desc" rows="3" placeholder="What this concept covers and why it matters for the lab…">' + _esc(opts.description) + '</textarea></label>' +
      '</div>' +
      '<div class="lp-oim-foot">' +
      '<button class="btn btn-sm" id="lt-meta-cancel">Cancel</button>' +
      '<button class="btn btn-sm lp-oim-primary" id="lt-meta-save">Save</button>' +
      '</div></div>';
    document.body.appendChild(modal);
    var close = function () { modal.remove(); };
    modal.querySelector('.lp-oim-backdrop').addEventListener('click', close);
    modal.querySelector('#lt-meta-cancel').addEventListener('click', close);
    var nameInp = modal.querySelector('#lt-meta-name');
    setTimeout(function () { nameInp.focus(); }, 0);
    modal.querySelector('#lt-meta-save').addEventListener('click', async function (ev) {
      var name = nameInp.value.trim();
      if (!name) { nameInp.focus(); return; }
      var btn = ev.currentTarget;
      btn.disabled = true; btn.textContent = 'Saving…';
      try {
        await opts.onSave(name, modal.querySelector('#lt-meta-desc').value.trim());
        close();
      } catch (e) {
        console.error('[library-themes] save failed:', e);
        btn.disabled = false; btn.textContent = 'Save';
        alert('Save failed: ' + (e.message || e));
      }
    });
  }

  /* ── Cards view ─────────────────────────────────────────── */

  function _paperCountFor(themeId) {
    var n = 0;
    _papers.forEach(function (p) {
      var th = p.meta && p.meta.library && p.meta.library.themes;
      if (Array.isArray(th) && th.indexOf(themeId) >= 0) n++;
    });
    return n;
  }

  function _renderCards() {
    var host = document.getElementById('lt-cards');
    var detail = document.getElementById('lt-detail');
    if (!host) return;
    if (detail) detail.style.display = 'none';
    host.style.display = '';
    var themes = _themes || [];
    var archived = _allThemes.filter(function (t) { return t.archived; });
    var html = '';
    if (!themes.length) {
      html += '<div class="lt-empty">No topics yet. Create the first one — e.g. a core concept every new student needs (TFM, bioprinting rheology, microfluidic droplet physics…).</div>';
    } else {
      html += themes.map(function (t) {
        var n = _paperCountFor(t.id);
        return '<button class="lt-card" data-theme-id="' + _esc(t.id) + '">' +
          '<div class="lt-card-name">' + _esc(t.name || t.id) + '</div>' +
          (t.description ? '<div class="lt-card-desc">' + _esc(t.description) + '</div>' : '') +
          '<div class="lt-card-meta">' + n + ' paper' + (n === 1 ? '' : 's') +
          (t.creator_name ? ' · by ' + _esc(t.creator_name) : '') + '</div>' +
          '</button>';
      }).join('');
    }
    if (archived.length) {
      html += '<details class="lt-archived"><summary>' + ICON.svg('archive-box') + ' ' + archived.length + ' archived topic' + (archived.length === 1 ? '' : 's') + '</summary>' +
        archived.map(function (t) {
          return '<div class="lt-archived-row"><span>' + _esc(t.name || t.id) + '</span>' +
            (_canEditTheme(t) ? '<button class="btn btn-sm" data-lt-restore="' + _esc(t.id) + '">' + ICON.svg('arrow-uturn-left') + ' restore</button>' : '') +
            '</div>';
        }).join('') + '</details>';
    }
    host.innerHTML = html;
    host.onclick = function (ev) {
      var restore = ev.target.closest('[data-lt-restore]');
      if (restore) {
        var rid = restore.getAttribute('data-lt-restore');
        _themeRef(rid).update({ archived: false, updated_at: _nowIso() })
          .then(function () { return loadThemes(true); })
          .then(_renderCards)
          .catch(function (e) { alert('Restore failed: ' + (e.message || e)); });
        return;
      }
      var card = ev.target.closest('.lt-card');
      if (card) _openTheme(card.getAttribute('data-theme-id'));
    };
  }

  /* ── Detail view ────────────────────────────────────────── */

  function _closeTheme() {
    _openId = null;
    if (_notesUnsub) { try { _notesUnsub(); } catch (e) {} _notesUnsub = null; }
    if (_commentsMount) { try { _commentsMount.unmount(); } catch (e) {} _commentsMount = null; }
    _notes = [];
    _noteTimers = {};
    _noteDirty = {};
    _groups = {};
    _related = [];
    _groupFilter = null;
    _groupsShown = 5;
    _relatedShown = 5;
    _suggExpanded = {};
    var url = new URL(location.href);
    url.searchParams.delete('theme');
    history.replaceState(null, '', url.toString());
    _renderCards();
  }

  async function _openTheme(themeId) {
    var t = _allThemes.find(function (x) { return x.id === themeId; });
    if (!t) return;
    // Re-entry (e.g. after an edit-meta save re-opens the same theme):
    // release the previous mount's listeners before rebuilding the DOM.
    if (_commentsMount) { try { _commentsMount.unmount(); } catch (e) {} _commentsMount = null; }
    if (_notesUnsub) { try { _notesUnsub(); } catch (e) {} _notesUnsub = null; }
    _openId = themeId;
    var url = new URL(location.href);
    url.searchParams.set('theme', themeId);
    history.replaceState(null, '', url.toString());

    var cards = document.getElementById('lt-cards');
    var detail = document.getElementById('lt-detail');
    if (cards) cards.style.display = 'none';
    if (!detail) return;
    detail.style.display = '';
    detail.innerHTML =
      '<div class="lt-detail-head">' +
      '<button class="btn btn-sm" id="lt-back">← All topics</button>' +
      '<h2 class="lt-detail-name">' + _esc(t.name || t.id) + '</h2>' +
      (_canEditTheme(t)
        ? '<button class="btn btn-sm" id="lt-edit-meta" title="Edit name / description">' + ICON.svg('pencil') + '</button>' +
          '<button class="btn btn-sm" id="lt-archive" title="Archive this topic (hidden from the grid, restorable)">' + ICON.svg('archive-box') + '</button>'
        : '') +
      '</div>' +
      (t.description ? '<div class="lt-detail-desc">' + _esc(t.description) + '</div>' : '') +
      /* V3.631 — the reverse half of the ABOUT↔FOR bridge. `links.theme_id`
       * pointed one way only: a focus card named its topic, but a topic had
       * no idea which of the lab's work rested on it. Filled async by
       * _renderThemeFoci so the rest of the detail view paints immediately. */
      '<div id="lt-foci" class="lt-foci"></div>' +
      '<div class="lt-section">' +
      '<div class="lt-section-head"><span class="lt-section-title">Research groups</span>' +
      '<span class="lt-section-hint">key labs by last-author PI · click a lab to filter the papers · ' + ICON.svg('pencil') + ' to curate</span></div>' +
      '<div id="lt-groups" class="lt-groups"><div class="lt-empty">Loading…</div></div>' +
      '</div>' +
      '<div class="lt-section">' +
      '<div class="lt-section-head"><span class="lt-section-title">Papers</span>' +
      '<span class="lt-section-hint">' + ICON.svg('hand-thumb-up') + ' = helped me understand this topic · top 3 with ≥2 votes get <b>Start here</b></span>' +
      '<button class="btn btn-sm" id="lt-import-papers" title="Bulk-import a list of DOIs / PMIDs / arXiv IDs or BibTeX into this topic — already-in-library papers are just tagged">' + ICON.svg('plus') + ' Import list</button>' +
      '<button class="btn btn-sm" id="lt-add-papers">' + ICON.svg('plus') + ' Add papers</button></div>' +
      '<div id="lt-paper-list" class="lt-paper-list"><div class="lt-empty">Loading…</div></div>' +
      '</div>' +
      '<div class="lt-section">' +
      '<div class="lt-section-head"><span class="lt-section-title">Synthesis notes</span>' +
      '<span class="lt-section-hint">shared with the whole lab — everyone can edit; each note saves on its own</span>' +
      '<button class="btn btn-sm" id="lt-add-note">' + ICON.svg('plus') + ' Add note</button></div>' +
      '<div id="lt-notes" class="lt-notes"></div>' +
      '</div>' +
      '<div class="lt-section">' +
      '<div class="lt-section-head"><span class="lt-section-title">Related topics</span>' +
      '<span class="lt-section-hint">explore next — concepts that enrich this one</span>' +
      '<button class="btn btn-sm" id="lt-add-related">' + ICON.svg('plus') + ' Add / suggest</button></div>' +
      '<div id="lt-related" class="lt-related"><div class="lt-empty">Loading…</div></div>' +
      '</div>' +
      '<div class="lt-section"><div id="lt-discussion"></div></div>';

    document.getElementById('lt-back').addEventListener('click', _closeTheme);
    var editBtn = document.getElementById('lt-edit-meta');
    if (editBtn) {
      editBtn.addEventListener('click', function () {
        _openMetaModal({
          title: 'Edit topic',
          name: t.name || '',
          description: t.description || '',
          onSave: async function (name, description) {
            await _themeRef(themeId).update({ name: name, description: description, updated_at: _nowIso() });
            await loadThemes(true);
            t = _allThemes.find(function (x) { return x.id === themeId; }) || t;
            _openTheme(themeId);
          },
        });
      });
    }
    var archBtn = document.getElementById('lt-archive');
    if (archBtn) {
      archBtn.addEventListener('click', async function () {
        if (!confirm('Archive "' + (t.name || themeId) + '"? Papers keep their tag; the theme hides from the grid and can be restored.')) return;
        try {
          await _themeRef(themeId).update({ archived: true, updated_at: _nowIso() });
          await loadThemes(true);
          _closeTheme();
        } catch (e) { alert('Archive failed: ' + (e.message || e)); }
      });
    }
    document.getElementById('lt-add-papers').addEventListener('click', function () {
      _openAddPapersPicker(themeId);
    });
    var impBtn = document.getElementById('lt-import-papers');
    if (impBtn) impBtn.addEventListener('click', function () { _openImportPapersModal(themeId); });
    document.getElementById('lt-add-note').addEventListener('click', function () {
      _addNote(themeId);
    });
    document.getElementById('lt-add-related').addEventListener('click', function () {
      _openRelatedPicker(themeId);
    });

    /* V3.368 — votes + live notes + discussion thread.
     * V3.496 — research groups (curation + ranking) + related themes. */
    _groupFilter = null;
    _groupsShown = 5;
    _relatedShown = 5;
    _suggExpanded = {};
    _renderThemeFoci(themeId);   // V3.631 — reverse ABOUT↔FOR bridge (async, non-blocking)
    await Promise.all([_loadVotes(themeId), _loadGroups(themeId), _loadRelated(themeId)]);
    _renderGroups(themeId);
    _renderPaperList(themeId);
    _renderRelated(themeId);
    _mountNotes(themeId);
    if (window.SECTION_COMMENTS) {
      _commentsMount = SECTION_COMMENTS.mount({
        container: document.getElementById('lt-discussion'),
        collectionPath: 'labThemes/' + themeId + '/comments',
        scope: { theme_id: themeId },
        label: 'Topic discussion',
      });
    }
  }

  /* ── Papers in theme + helped-me voting (V3.368) ────────── */

  function _themePapers(themeId) {
    return _papers.filter(function (p) {
      var th = p.meta && p.meta.library && p.meta.library.themes;
      return Array.isArray(th) && th.indexOf(themeId) >= 0;
    });
  }

  /* ── V3.631: which lab work rests on this topic ──────────────
   *
   * `researchFoci/{id}.links.theme_id` was the ONE bridge between a paper's
   * ABOUT axis (topics) and its FOR axis (the research map), and it pointed
   * one way only: a focus card could name its topic, but opening a topic told
   * you nothing about which of the lab's work it underpins. V3.630 fixed the
   * forward half (the card printed a raw slug and didn't deep-link); this is
   * the reverse.
   *
   * One whole-collection get, filtered client-side — `researchFoci` is single
   * digits of docs and this is exactly the "whole-collection get + client
   * sort, no composite index" convention the rest of this module and
   * roadmap-data.js follow. Cached per page load.
   *
   * The empty state is deliberate rather than hidden: 8 of 9 real focus cards
   * have no `theme_id`, so a topic reading "not yet linked from the research
   * map" is the only place anyone would learn the relationship exists. */
  var _fociByTheme = null;   // themeId → [{id,title,icon,level}], or null

  async function _loadFociByTheme() {
    if (_fociByTheme) return _fociByTheme;
    var map = {};
    try {
      var snap = await firebridge.db().collection('researchFoci').get();
      snap.docs.forEach(function (d) {
        var v = d.data() || {};
        var tid = (v.links || {}).theme_id;
        if (!tid) return;
        (map[tid] = map[tid] || []).push({
          id: d.id,
          title: v.title || d.id,
          icon: v.icon || 'document-text',
          level: v.level || 'concept',
        });
      });
      Object.keys(map).forEach(function (k) {
        map[k].sort(function (a, b) { return (a.title || '').localeCompare(b.title || ''); });
      });
    } catch (e) {
      console.warn('[library-themes] foci-by-topic load failed:', e.message || e);
    }
    _fociByTheme = map;
    return _fociByTheme;
  }

  async function _renderThemeFoci(themeId) {
    var host = document.getElementById('lt-foci');
    if (!host) return;
    var map = await _loadFociByTheme();
    // The user may have navigated away during the get.
    host = document.getElementById('lt-foci');
    if (!host) return;
    var cards = map[themeId] || [];
    if (!cards.length) {
      host.innerHTML = '<div class="lt-foci-empty">Not yet linked from the research map. ' +
        'A focus card names the topic its literature sits on — the PI sets that on ' +
        '<a href="/rm/pages/research.html">the research map</a>.</div>';
      return;
    }
    host.innerHTML = '<div class="lt-foci-label">This topic underpins</div>' +
      cards.map(function (c) {
        return '<a class="lt-foci-chip" href="/rm/pages/research.html?id=' +
          encodeURIComponent(c.id) + '" title="Open this focus card on the research map">' +
          ICON.render(c.icon) + ' ' + _esc(c.title) +
          '<span class="lt-foci-level">' + _esc(_levelLabel(c.level)) + '</span></a>';
      }).join('');
  }

  /* V3.717 — five levels now, and a raw slug ("aim") reads worse than the
   * label ("Aim"). RESEARCH_DATA owns the vocabulary; this page does not
   * always load it, so fall back to the slug. */
  function _levelLabel(level) {
    var L = window.RESEARCH_DATA && RESEARCH_DATA.LEVELS[level];
    return L ? L.label : (level || '');
  }

  async function _loadVotes(themeId) {
    _voteCounts = {};
    _myVotes = new Set();
    var me = _me();
    try {
      var snap = await _themeRef(themeId).collection('votes').get();
      snap.docs.forEach(function (d) {
        var helped = (d.data() || {}).helped;
        if (!Array.isArray(helped)) return;
        helped.forEach(function (itemId) {
          _voteCounts[itemId] = (_voteCounts[itemId] || 0) + 1;
        });
        if (me.uid && d.id === me.uid) _myVotes = new Set(helped);
      });
    } catch (e) {
      console.warn('[library-themes] votes load failed:', e.message || e);
    }
  }

  async function _toggleVote(themeId, itemId) {
    var me = _me();
    if (!me.uid) return;
    var on = _myVotes.has(itemId);
    try {
      await _themeRef(themeId).collection('votes').doc(me.uid).set({
        helped: on
          ? firebase.firestore.FieldValue.arrayRemove(itemId)
          : firebase.firestore.FieldValue.arrayUnion(itemId),
        updated_at: _nowIso(),
      }, { merge: true });
      if (on) { _myVotes.delete(itemId); _voteCounts[itemId] = Math.max(0, (_voteCounts[itemId] || 1) - 1); }
      else { _myVotes.add(itemId); _voteCounts[itemId] = (_voteCounts[itemId] || 0) + 1; }
      _renderPaperList(themeId);
    } catch (e) {
      alert('Vote failed: ' + (e.message || e));
    }
  }

  function _renderPaperList(themeId) {
    var host = document.getElementById('lt-paper-list');
    if (!host || _openId !== themeId) return;
    var all = _themePapers(themeId);
    if (!all.length) {
      host.innerHTML = '<div class="lt-empty">No papers tagged yet — use ' + ICON.svg('plus') + ' Add papers, or tag from the reader’s Topics row.</div>';
      return;
    }
    // V3.496 — group filter: restrict to one lab's last-authored papers.
    var mm = _mergeMap();
    var filterLabel = '';
    if (_groupFilter) {
      var fg = _deriveGroups(themeId).find(function (g) { return g.key === _groupFilter; });
      filterLabel = fg ? fg.label : _groupFilter;
    }
    var rows = _groupFilter
      ? all.filter(function (p) { return _paperGroupKey(p, mm) === _groupFilter; })
      : all.slice();
    // Sort: vote count desc, then title. "Start here" = top 3 with ≥2 votes.
    rows.sort(function (a, b) {
      var va = _voteCounts[a.id] || 0, vb = _voteCounts[b.id] || 0;
      if (va !== vb) return vb - va;
      return (a.title || '').localeCompare(b.title || '');
    });
    var startHere = new Set();
    rows.forEach(function (p) {
      if (startHere.size < 3 && (_voteCounts[p.id] || 0) >= 2) startHere.add(p.id);
    });
    var banner = _groupFilter
      ? '<div class="lt-filter-banner">Filtered to <b>' + _esc(filterLabel) + '</b> · ' + rows.length +
        ' paper' + (rows.length === 1 ? '' : 's') +
        ' <button class="lt-filter-clear" data-lt-clear-filter="1">' + ICON.svg('x-mark') + ' clear</button></div>'
      : '';
    var listHtml = rows.map(function (p) {
      var lib = (p.meta && p.meta.library) || {};
      var authorYear = [
        (lib.authors && lib.authors[0] && (lib.authors[0].family || lib.authors[0].given)) || '',
        lib.year || '',
      ].filter(Boolean).join(' ');
      var n = _voteCounts[p.id] || 0;
      var mine = _myVotes.has(p.id);
      var rel = _relevanceOf(p, themeId);
      return '<div class="lt-paper-row">' +
        (startHere.has(p.id) ? '<span class="lt-start-badge" title="Top-voted — a good first read for this topic">Start here</span>' : '') +
        '<a class="lt-paper-title" href="/rm/pages/library-paper.html?id=' + encodeURIComponent(p.id) + '">' + _esc(p.title || p.id) + '</a>' +
        '<span class="lt-paper-meta">' + _esc(authorYear) + (lib.journal ? ' · ' + _esc(lib.journal) : '') + '</span>' +
        '<span class="lt-paper-spacer"></span>' +
        '<select class="lt-rel-select" data-lt-rel="' + _esc(p.id) + '" title="How central is this paper to the topic? Feeds the lab ranking.">' + _relOptionsHtml(rel) + '</select>' +
        '<button class="lt-vote-btn' + (mine ? ' on' : '') + '" data-lt-vote="' + _esc(p.id) + '" title="' + (mine ? 'Remove your vote' : 'This paper helped me understand this topic') + '">' + ICON.svg('hand-thumb-up') + ' ' + n + '</button>' +
        '<button class="lt-remove-btn" data-lt-remove-paper="' + _esc(p.id) + '" title="Remove this paper from the topic">' + ICON.svg('x-mark') + '</button>' +
        '</div>';
    }).join('');
    host.innerHTML = banner + (rows.length ? listHtml : '<div class="lt-empty">No papers from this lab in the topic.</div>');
    host.onchange = function (ev) {
      var sel = ev.target.closest('[data-lt-rel]');
      if (!sel) return;
      var itemId = sel.getAttribute('data-lt-rel');
      var w = parseInt(sel.value, 10) || 2;
      _patchLocalRelevance(itemId, themeId, w);
      _renderGroups(themeId);   // relevance-weighted scores shift
      window.LIBRARY_LINKS.setThemeRelevance(itemId, themeId, w).catch(function (e) {
        _setStatus('Relevance save failed: ' + (e.message || e));
      });
    };
    host.onclick = async function (ev) {
      var clr = ev.target.closest('[data-lt-clear-filter]');
      if (clr) { _groupFilter = null; _renderGroups(themeId); _renderPaperList(themeId); return; }
      var voteBtn = ev.target.closest('[data-lt-vote]');
      if (voteBtn) { _toggleVote(themeId, voteBtn.getAttribute('data-lt-vote')); return; }
      var rmBtn = ev.target.closest('[data-lt-remove-paper]');
      if (rmBtn) {
        var itemId = rmBtn.getAttribute('data-lt-remove-paper');
        rmBtn.disabled = true;
        try {
          var fresh = await window.LIBRARY_LINKS.toggleTheme(itemId, themeId, false);
          _patchLocalPaperThemes(itemId, fresh);
          _patchLocalRelevance(itemId, themeId, null);  // toggleTheme cleared it server-side
          _renderGroups(themeId);
          _renderPaperList(themeId);
        } catch (e) {
          rmBtn.disabled = false;
          alert('Remove failed: ' + (e.message || e));
        }
      }
    };
  }

  function _patchLocalPaperThemes(itemId, freshThemes) {
    var p = _papers.find(function (x) { return x.id === itemId; });
    if (!p) return;
    p.meta = p.meta || {};
    p.meta.library = p.meta.library || {};
    p.meta.library.themes = freshThemes;
  }

  /* ── Per-paper relevance (V3.496) ───────────────────────── */

  // Core 3 / Supporting 2 / Tangential 1. Unset membership reads as
  // Supporting so pre-V3.496 tags keep today's plain-count behaviour.
  var RELEVANCE = { 3: 'Core', 2: 'Supporting', 1: 'Tangential' };
  var RELEVANCE_ORDER = [3, 2, 1];

  function _relevanceOf(p, themeId) {
    var m = p && p.meta && p.meta.library && p.meta.library.theme_relevance;
    var w = parseInt(m && m[themeId], 10);
    return (w === 1 || w === 2 || w === 3) ? w : 2;
  }
  function _relOptionsHtml(selected) {
    return RELEVANCE_ORDER.map(function (w) {
      return '<option value="' + w + '"' + (selected === w ? ' selected' : '') + '>' + RELEVANCE[w] + '</option>';
    }).join('');
  }
  function _patchLocalRelevance(itemId, themeId, weight) {
    var p = _papers.find(function (x) { return x.id === itemId; });
    if (!p) return;
    p.meta = p.meta || {}; p.meta.library = p.meta.library || {};
    p.meta.library.theme_relevance = p.meta.library.theme_relevance || {};
    if (weight) p.meta.library.theme_relevance[themeId] = weight;
    else delete p.meta.library.theme_relevance[themeId];
  }

  /* ── PI (last-author) keying (V3.496) ───────────────────── */

  function _lastAuthor(p) {
    var a = p && p.meta && p.meta.library && p.meta.library.authors;
    return (Array.isArray(a) && a.length) ? a[a.length - 1] : null;
  }
  // Prefer ORCID (globally unique — auto-merges name variants + splits
  // same-initial PIs); else family + first-initial slug.
  function _rawAuthorKey(a) {
    if (!a) return '';
    if (a.orcid) return 'orcid:' + String(a.orcid).trim().toLowerCase();
    var fam = String(a.family || '').toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '');
    if (!fam) return '';
    var gi = String(a.given || '').trim().charAt(0).toLowerCase();
    return fam + (gi ? '-' + gi : '');
  }
  function _authorDisplay(a) {
    if (!a) return 'Unknown';
    return [a.given, a.family].filter(Boolean).join(' ') || a.family || a.given || 'Unknown';
  }
  function _groupDocId(key) {
    return String(key).replace(/[^a-zA-Z0-9_-]/g, '_').slice(0, 200) || 'g';
  }
  // rawKey → canonical group key, from curation docs' merged_keys.
  function _mergeMap() {
    var map = {};
    Object.keys(_groups).forEach(function (canon) {
      var mk = _groups[canon] && _groups[canon].merged_keys;
      if (Array.isArray(mk)) mk.forEach(function (rk) { if (rk && rk !== canon) map[rk] = canon; });
    });
    return map;
  }
  function _paperGroupKey(p, mm) {
    var raw = _rawAuthorKey(_lastAuthor(p));
    if (!raw) return '__unattributed';
    return (mm && mm[raw]) || raw;
  }

  // Build the ranked research-group list for a theme. ⭐ pinned first, then
  // relevance-weighted score desc, count desc, label; unattributed last.
  function _deriveGroups(themeId) {
    var mm = _mergeMap();
    var byKey = {};
    _themePapers(themeId).forEach(function (p) {
      var a = _lastAuthor(p);
      var raw = _rawAuthorKey(a);
      var key = raw ? (mm[raw] || raw) : '__unattributed';
      var g = byKey[key] || (byKey[key] = { key: key, papers: [], score: 0, sample: null });
      g.papers.push(p);
      g.score += _relevanceOf(p, themeId);
      if (!g.sample && a) g.sample = a;
    });
    // Single whole-library pass: last-author counts (context figure) +
    // suggestion buckets. Suggestions = library papers NOT yet tagged in
    // this theme where the PI is the last author (strong) or any coauthor
    // (weak) — keyed through the same merge map.
    var libCounts = {};
    var suggByKey = {};
    _papers.forEach(function (p) {
      var authors = (p.meta && p.meta.library && p.meta.library.authors) || [];
      if (!authors.length) return;
      var lastRaw = _rawAuthorKey(authors[authors.length - 1]);
      var lastKey = lastRaw ? (mm[lastRaw] || lastRaw) : null;
      if (lastKey) libCounts[lastKey] = (libCounts[lastKey] || 0) + 1;
      var th = (p.meta && p.meta.library && p.meta.library.themes) || [];
      if (Array.isArray(th) && th.indexOf(themeId) >= 0) return;  // already tagged
      var seen = {};
      authors.forEach(function (a) {
        var raw = _rawAuthorKey(a);
        if (!raw) return;
        var key = mm[raw] || raw;
        if (seen[key]) return;
        seen[key] = 1;
        (suggByKey[key] = suggByKey[key] || []).push({ paper: p, last: key === lastKey });
      });
    });
    var list = Object.keys(byKey).map(function (key) {
      var g = byKey[key];
      var cur = _groups[key] || null;
      var unattributed = key === '__unattributed';
      return {
        key: key,
        label: (cur && cur.canonical_name) || (unattributed ? 'Unattributed' : (g.sample ? _authorDisplay(g.sample) : key)),
        institution: (cur && cur.institution) || (g.sample && g.sample.affiliation) || '',
        note: (cur && cur.note) || '',
        starred: !!(cur && cur.starred),
        curated: !!cur,
        sample: g.sample,
        count: g.papers.length,
        score: g.score,
        libCount: libCounts[key] || g.papers.length,
        papers: g.papers,
        suggested: unattributed ? [] : (suggByKey[key] || []).slice().sort(function (sa, sb) {
          if (sa.last !== sb.last) return sa.last ? -1 : 1;   // last-author first
          var ya = parseInt(((sa.paper.meta || {}).library || {}).year, 10) || 0;
          var yb = parseInt(((sb.paper.meta || {}).library || {}).year, 10) || 0;
          if (ya !== yb) return yb - ya;
          return (sa.paper.title || '').localeCompare(sb.paper.title || '');
        }),
        unattributed: unattributed,
      };
    });
    list.sort(function (a, b) {
      if (a.unattributed !== b.unattributed) return a.unattributed ? 1 : -1;
      if (!!a.starred !== !!b.starred) return a.starred ? -1 : 1;
      if (a.score !== b.score) return b.score - a.score;
      if (a.count !== b.count) return b.count - a.count;
      return String(a.label).localeCompare(String(b.label));
    });
    return list;
  }

  async function _loadGroups(themeId) {
    _groups = {};
    try {
      var snap = await _themeRef(themeId).collection('groups').get();
      snap.docs.forEach(function (d) {
        var x = d.data() || {};
        x.key = x.key || d.id;
        _groups[x.key] = x;
      });
    } catch (e) {
      console.warn('[library-themes] groups load failed:', e.message || e);
    }
  }

  /* ── Research-group cards + filter (V3.496) ─────────────── */

  function _renderGroups(themeId) {
    var host = document.getElementById('lt-groups');
    if (!host || _openId !== themeId) return;
    var groups = _deriveGroups(themeId);
    if (!groups.length) {
      host.innerHTML = '<div class="lt-empty">Research groups appear here once papers with author data are tagged. Add papers below.</div>';
      return;
    }
    var visible = groups.slice(0, _groupsShown);
    var hidden = groups.length - visible.length;
    var cards = visible.map(function (g) {
      var active = _groupFilter === g.key;
      var sub = [];
      if (g.institution) sub.push(_esc(g.institution));
      sub.push(g.count + ' here');
      if (g.libCount && g.libCount !== g.count) sub.push(g.libCount + ' in library');
      return '<div class="lt-group-card' + (active ? ' active' : '') + (g.starred ? ' starred' : '') + (g.unattributed ? ' unattributed' : '') +
          '" data-lt-group-filter="' + _esc(g.key) + '" role="button" tabindex="0" title="Show only this lab’s papers below">' +
        '<div class="lt-group-top">' +
          (g.starred ? '<span class="lt-group-star" title="Key lab">' + ICON.svg('star') + '</span>' : '') +
          '<span class="lt-group-name">' + _esc(g.label) + '</span>' +
          '<span class="lt-group-score" title="Relevance-weighted score — Core 3 · Supporting 2 · Tangential 1">' + g.score + '</span>' +
          (g.unattributed ? '' : '<button class="lt-group-edit" data-lt-group-edit="' + _esc(g.key) + '" title="Curate this lab (name, institution, note, merge, star)">' + ICON.svg('pencil') + '</button>') +
        '</div>' +
        '<div class="lt-group-sub">' + sub.join(' · ') + '</div>' +
        (g.note ? '<div class="lt-group-note">' + _esc(g.note) + '</div>' : '') +
        (!g.unattributed || (g.suggested && g.suggested.length)
          ? '<div class="lt-group-actions">' +
              (g.suggested && g.suggested.length
                ? '<button class="lt-group-sugg-toggle" data-lt-sugg-toggle="1" title="Library papers by this lab not yet in this topic">' + ICON.svg('magnifying-glass') + ' ' +
                    g.suggested.length + ' suggested</button>'
                : '') +
              (g.unattributed
                ? ''
                : '<button class="lt-group-recent" data-lt-recent="' + _esc(g.key) + '" title="Fetch recent publications by this lab (ORCID / CrossRef) and import the relevant ones">' + ICON.svg('satellite') + ' recent</button>') +
            '</div>'
          : '') +
        (g.suggested && g.suggested.length
          ? '<div class="lt-group-sugg"' + (_suggExpanded[g.key] ? '' : ' hidden') + '>' +
              g.suggested.map(function (s) {
                var lib = (s.paper.meta && s.paper.meta.library) || {};
                var yr = lib.year ? ' (' + _esc(lib.year) + ')' : '';
                return '<div class="lt-sugg-row">' +
                  '<button class="lt-sugg-add" data-lt-sugg-add="' + _esc(s.paper.id) + '" title="Add this paper to the topic">' + ICON.svg('plus') + '</button>' +
                  '<a class="lt-sugg-title" href="/rm/pages/library-paper.html?id=' + encodeURIComponent(s.paper.id) + '" title="Open paper">' + _esc(s.paper.title || s.paper.id) + yr + '</a>' +
                  (s.last ? '' : '<span class="lt-sugg-tag" title="PI is a coauthor, not the last author">coauthor</span>') +
                  '</div>';
              }).join('') +
            '</div>'
          : '') +
      '</div>';
    }).join('');
    var more = '';
    if (hidden > 0) {
      var next = _groupsShown < 10 ? 10 : groups.length;
      more = '<button class="btn btn-sm lt-group-more" data-lt-group-more="' + next + '">＋ Show ' +
        (next >= groups.length ? 'all ' + groups.length : 'top ' + next) + '</button>';
    } else if (_groupsShown > 5 && groups.length > 5) {
      more = '<button class="btn btn-sm lt-group-more" data-lt-group-more="5">Show fewer</button>';
    }
    host.innerHTML = '<div class="lt-group-grid">' + cards + '</div>' +
      (more ? '<div class="lt-group-more-wrap">' + more + '</div>' : '');
    host.onclick = function (ev) {
      var edit = ev.target.closest('[data-lt-group-edit]');
      if (edit) { ev.stopPropagation(); _openGroupEditor(themeId, edit.getAttribute('data-lt-group-edit')); return; }
      var recent = ev.target.closest('[data-lt-recent]');
      if (recent) {
        var grp = groups.find(function (g) { return g.key === recent.getAttribute('data-lt-recent'); });
        if (grp) _openRecentPapersModal(themeId, grp);
        return;
      }
      var sToggle = ev.target.closest('[data-lt-sugg-toggle]');
      if (sToggle) {
        var cardEl = sToggle.closest('[data-lt-group-filter]');
        var gk = cardEl && cardEl.getAttribute('data-lt-group-filter');
        var box = cardEl && cardEl.querySelector('.lt-group-sugg');
        if (gk) _suggExpanded[gk] = !_suggExpanded[gk];
        if (box) box.hidden = !(gk && _suggExpanded[gk]);
        return;
      }
      var sAdd = ev.target.closest('[data-lt-sugg-add]');
      if (sAdd) { _addSuggestedPaper(themeId, sAdd.getAttribute('data-lt-sugg-add')); return; }
      if (ev.target.closest('.lt-group-sugg') || ev.target.closest('.lt-group-actions')) return;  // suggestion/action clicks never filter
      var moreBtn = ev.target.closest('[data-lt-group-more]');
      if (moreBtn) { _groupsShown = parseInt(moreBtn.getAttribute('data-lt-group-more'), 10) || 5; _renderGroups(themeId); return; }
      var card = ev.target.closest('[data-lt-group-filter]');
      if (card) {
        var k = card.getAttribute('data-lt-group-filter');
        _groupFilter = (_groupFilter === k) ? null : k;
        _renderGroups(themeId);
        _renderPaperList(themeId);
      }
    };
  }

  // Add a suggested (untagged) library paper to the theme. Relevance is left
  // unset (reads as Supporting) — adjustable from the paper list afterwards.
  async function _addSuggestedPaper(themeId, itemId) {
    try {
      var fresh = await window.LIBRARY_LINKS.toggleTheme(itemId, themeId, true);
      _patchLocalPaperThemes(itemId, fresh);
      _renderGroups(themeId);
      _renderPaperList(themeId);
    } catch (e) {
      alert('Add failed: ' + (e.message || e));
    }
  }

  /* ── Recent-papers finder: fetch a lab's new works + import (V3.496) ── */

  var RECENT_YEARS = 3;   // "recent" window for the finder
  var _RECENT_STOP = (function () {
    var s = {};
    ('a an the of and or in on for to with from by as at is are be this that we our study results result using use used via over under between into role effect effects novel toward towards based high low new using their its can may show shows report reports paper article review analysis approach method methods model models system systems').split(' ')
      .forEach(function (w) { s[w] = 1; });
    return s;
  })();

  function _relTokens(str) {
    return String(str || '').toLowerCase().replace(/[^a-z0-9\s-]/g, ' ').split(/\s+/)
      .filter(function (w) { return w.length > 3 && !_RECENT_STOP[w]; });
  }
  // Token bag for a theme: name + description (weighted) + tagged titles.
  function _themeTokenBag(themeId) {
    var t = (_allThemes || []).find(function (x) { return x.id === themeId; }) || {};
    var bag = {};
    _relTokens(t.name).concat(_relTokens(t.description)).forEach(function (w) { bag[w] = (bag[w] || 0) + 3; });
    _themePapers(themeId).forEach(function (p) {
      var uniq = {};
      _relTokens(p.title).forEach(function (w) { uniq[w] = 1; });
      Object.keys(uniq).forEach(function (w) { bag[w] = (bag[w] || 0) + 1; });
    });
    return bag;
  }
  function _relevanceScore(bag, work) {
    var toks = _relTokens((work.title || '') + ' ' + (work.journal || ''));
    if (!toks.length) return 0;
    var uniq = {}; toks.forEach(function (w) { uniq[w] = 1; });
    var keys = Object.keys(uniq), hit = 0;
    keys.forEach(function (w) { if (bag[w]) hit += Math.min(bag[w], 3); });
    return hit / Math.max(5, keys.length);   // normalize by candidate length
  }

  async function _fetchOrcidWorks(orcid) {
    var id = String(orcid || '').trim();
    if (!/^\d{4}-\d{4}-\d{4}-\d{3}[\dxX]$/.test(id)) throw new Error('Invalid ORCID id.');
    var res = await fetch('https://pub.orcid.org/v3.0/' + id + '/works', { headers: { Accept: 'application/json' } });
    if (!res.ok) throw new Error('ORCID API ' + res.status);
    var j = await res.json();
    return (j.group || []).flatMap(function (g) { return (g['work-summary'] || []).slice(0, 1); }).map(function (w) {
      var ext = (w['external-ids'] && w['external-ids']['external-id']) || [];
      var doiRef = ext.find(function (x) { return x['external-id-type'] === 'doi'; });
      return {
        title: (w.title && w.title.title && w.title.title.value) || '',
        year: (w['publication-date'] && w['publication-date'].year && w['publication-date'].year.value) || '',
        journal: (w['journal-title'] && w['journal-title'].value) || '',
        doi: ((doiRef && doiRef['external-id-value']) || '').toLowerCase(),
      };
    });
  }

  async function _fetchCrossrefAuthorWorks(name) {
    var fromYear = (new Date().getFullYear() - RECENT_YEARS) + '-01-01';
    // Fetch authors too (V3.500) — needed to VERIFY the fuzzy name match
    // actually belongs to this PI (family name + coauthors + affiliation).
    var url = 'https://api.crossref.org/works?query.author=' + encodeURIComponent(name) +
      '&filter=from-pub-date:' + fromYear + ',type:journal-article' +
      '&sort=published&order=desc&rows=60' +
      '&select=DOI,title,issued,container-title,author';
    var res = await fetch(url, { headers: { Accept: 'application/json' } });
    if (!res.ok) throw new Error('CrossRef ' + res.status);
    var j = await res.json();
    return ((j.message && j.message.items) || []).map(function (it) {
      var parts = (it.issued && it.issued['date-parts'] && it.issued['date-parts'][0]) || [];
      return {
        title: (it.title && it.title[0]) || '',
        year: parts[0] ? String(parts[0]) : '',
        journal: (it['container-title'] && it['container-title'][0]) || '',
        doi: (it.DOI || '').toLowerCase(),
        authors: it.author || [],
      };
    });
  }

  /* ── PI identity verification for the name-search finder (V3.500) ──
   * A CrossRef author-name search is fuzzy: "Christian Franck" also returns
   * "Christian Courtois". Before attributing a fetched paper to a PI we
   * require an author whose FAMILY name matches (+ given initial) AND ≥1 more
   * corroborating signal (shared coauthor / same institution / full given
   * name / matching ORCID). Family-name mismatches are dropped outright. */
  var _AFFIL_STOP = (function () {
    var s = {};
    ('university univ department dept division school college institute institution center centre laboratory laboratories lab labs faculty program programme graduate national international research group unit hospital medical medicine sciences science engineering technology state the and for of at')
      .split(' ').forEach(function (w) { s[w] = 1; });
    return s;
  })();
  function _normName(s) { return String(s || '').toLowerCase().replace(/[^a-z]/g, ''); }
  function _affilTokens(s) {
    return String(s || '').toLowerCase().replace(/[^a-z0-9\s]/g, ' ').split(/\s+/)
      .filter(function (w) { return w.length > 3 && !_AFFIL_STOP[w]; });
  }
  function _piKnownPapers(group, mm) {
    mm = mm || _mergeMap();
    return (_papers || []).filter(function (p) {
      var authors = (p.meta && p.meta.library && p.meta.library.authors) || [];
      return authors.some(function (a) { var raw = _rawAuthorKey(a); return raw && (mm[raw] || raw) === group.key; });
    });
  }
  // Profile the PI from their known library papers: family / given / ORCID +
  // the set of coauthor family names + the PI's own affiliation tokens.
  function _buildPiProfile(group) {
    var mm = _mergeMap();
    var isPi = function (a) { var raw = _rawAuthorKey(a); return raw && (mm[raw] || raw) === group.key; };
    var fam = _normName(group.sample && group.sample.family);
    var given = String((group.sample && group.sample.given) || '').trim().toLowerCase();
    var orcid = (group.key.indexOf('orcid:') === 0) ? group.key.slice(6) : ((group.sample && group.sample.orcid) || '');
    var coauthors = {}, affils = {};
    _piKnownPapers(group, mm).forEach(function (p) {
      ((p.meta.library && p.meta.library.authors) || []).forEach(function (a) {
        if (isPi(a)) { if (a.orcid && !orcid) orcid = a.orcid; _affilTokens(a.affiliation).forEach(function (t) { affils[t] = 1; }); }
        else { var nf = _normName(a.family); if (nf) coauthors[nf] = 1; }
      });
    });
    if (!fam && group.label) {
      var parts = String(group.label).trim().split(/\s+/);
      fam = _normName(parts[parts.length - 1]);
      if (!given) given = parts.slice(0, -1).join(' ').toLowerCase();
    }
    return { family: fam, given: given, gi: given.charAt(0), orcid: String(orcid || '').toLowerCase(), coauthors: coauthors, affils: affils };
  }
  // Score a fetched work against the PI profile. matched=false ⇒ no author's
  // family matches the PI (a different person → dropped, e.g. Courtois).
  function _scorePiMatch(profile, work) {
    var authors = work.authors || [];
    var me = null;
    for (var i = 0; i < authors.length && profile.family; i++) {
      if (_normName(authors[i].family) === profile.family) {
        var gi = String(authors[i].given || '').trim().charAt(0).toLowerCase();
        if (!profile.gi || !gi || gi === profile.gi) { me = authors[i]; break; }
      }
    }
    if (!me) return { matched: false, ok: false, signals: [] };
    var signals = ['family name'];
    var mo = String(me.ORCID || '').replace(/^https?:\/\/orcid\.org\//i, '').trim().toLowerCase();
    if (profile.orcid && mo && mo === profile.orcid) signals.push('ORCID ✓');
    if (profile.given && String(me.given || '').trim().toLowerCase() === profile.given) signals.push('full name');
    var shared = [];
    authors.forEach(function (a) { var nf = _normName(a.family); if (nf && nf !== profile.family && profile.coauthors[nf]) shared.push(a.family); });
    if (shared.length) signals.push('coauthor: ' + shared.slice(0, 2).join(', '));
    var aff = false;
    _affilTokens((me.affiliation && me.affiliation[0] && me.affiliation[0].name) || '').forEach(function (t) { if (profile.affils[t]) aff = true; });
    if (aff) signals.push('same institution');
    // Require family + ≥1 more signal (or a decisive ORCID hit) → 2-3 pieces.
    return { matched: true, ok: signals.indexOf('ORCID ✓') >= 0 || signals.length >= 2, signals: signals };
  }

  async function _openRecentPapersModal(themeId, group) {
    var me = _me();
    if (!me.uid) { _setStatus('Sign in first.'); return; }
    if (!window.LIBRARY_UPLOAD || !window.LIBRARY_METADATA) {
      alert('Import tools not loaded on this page — reload and try again.');
      return;
    }
    var existing = document.getElementById('lt-recent-modal');
    if (existing) existing.remove();
    var modal = document.createElement('div');
    modal.id = 'lt-recent-modal';
    modal.className = 'lp-overlay-import-modal';
    modal.innerHTML =
      '<div class="lp-oim-backdrop"></div>' +
      '<div class="lp-oim-card">' +
      '<div class="lp-oim-head">Recent papers · ' + _esc(group.label) + '</div>' +
      '<div class="lp-oim-summary" id="lt-recent-status">Fetching recent publications…</div>' +
      '<div class="lp-linkpick-list" id="lt-recent-list"></div>' +
      '<div class="lp-oim-foot">' +
      '<button class="btn btn-sm" id="lt-recent-cancel">Close</button>' +
      '<span style="flex:1"></span>' +
      '<button class="btn btn-sm lp-oim-primary" id="lt-recent-import" disabled>Import + tag selected</button>' +
      '</div></div>';
    document.body.appendChild(modal);
    var close = function () { modal.remove(); };
    modal.querySelector('.lp-oim-backdrop').addEventListener('click', close);
    modal.querySelector('#lt-recent-cancel').addEventListener('click', close);
    var statusEl = modal.querySelector('#lt-recent-status');
    var listEl = modal.querySelector('#lt-recent-list');
    var importBtn = modal.querySelector('#lt-recent-import');

    // Resolve identity: ORCID if the group is ORCID-keyed or the sample
    // author carries one; else a CrossRef author-name search.
    var orcid = '';
    if (group.key.indexOf('orcid:') === 0) orcid = group.key.slice(6);
    else if (group.sample && group.sample.orcid) orcid = group.sample.orcid;

    var works;
    try {
      if (orcid) { statusEl.textContent = 'Fetching from ORCID ' + orcid + '…'; works = await _fetchOrcidWorks(orcid); }
      else { statusEl.textContent = 'Searching CrossRef for “' + group.label + '”…'; works = await _fetchCrossrefAuthorWorks(group.label); }
    } catch (e) {
      statusEl.textContent = 'Lookup failed: ' + (e.message || e);
      return;
    }

    var cutoff = new Date().getFullYear() - RECENT_YEARS;
    var haveDois = new Set((_papers || []).map(function (p) {
      return ((p.meta && p.meta.library && p.meta.library.doi) || '').toLowerCase();
    }).filter(Boolean));
    var bag = _themeTokenBag(themeId);
    var byName = !orcid;                     // ORCID works are already authoritative
    var profile = byName ? _buildPiProfile(group) : null;
    var noDoi = 0, already = 0, wrongPerson = 0, seen = {};
    var cands = [];
    (works || []).forEach(function (w) {
      var yr = parseInt(w.year, 10) || 0;
      if (yr && yr < cutoff) return;
      if (!w.doi) { noDoi++; return; }
      if (haveDois.has(w.doi)) { already++; return; }
      if (seen[w.doi]) return;
      seen[w.doi] = 1;
      if (byName) {
        var m = _scorePiMatch(profile, w);
        if (!m.matched) { wrongPerson++; return; }   // different author (e.g. Courtois) — drop
        w.match = m;
      } else {
        w.match = { matched: true, ok: true, signals: ['ORCID (authoritative)'] };
      }
      w.rel = _relevanceScore(bag, w);
      cands.push(w);
    });
    // Confident matches first, then relevance, then recency.
    cands.sort(function (a, b) {
      if (!!a.match.ok !== !!b.match.ok) return a.match.ok ? -1 : 1;
      if (b.rel !== a.rel) return b.rel - a.rel;
      return (parseInt(b.year, 10) || 0) - (parseInt(a.year, 10) || 0);
    });

    if (!cands.length) {
      statusEl.textContent = 'No new recent papers confidently attributed to ' + group.label +
        (wrongPerson ? ' — ' + wrongPerson + ' name match' + (wrongPerson === 1 ? '' : 'es') + ' rejected as a different author' : '') +
        (already ? ' · ' + already + ' already in the library' : '') + '.';
      return;
    }
    var maxRel = cands.reduce(function (m, w) { return Math.max(m, w.rel); }, 0);
    var verifiedN = cands.filter(function (w) { return w.match.ok; }).length;
    statusEl.innerHTML = '<b>' + verifiedN + '</b> of ' + cands.length + ' confidently attributed to ' + _esc(group.label) +
      (wrongPerson ? ' · <b>' + wrongPerson + '</b> rejected (different author)' : '') +
      '. Only confident matches (family name + a corroborating signal) are pre-ticked.';
    listEl.innerHTML = cands.map(function (w) {
      var pct = maxRel > 0 ? Math.round((w.rel / maxRel) * 100) : 0;
      var bucket = (maxRel > 0 && w.rel >= 0.66 * maxRel) ? 'high' : ((maxRel > 0 && w.rel >= 0.33 * maxRel) ? 'med' : 'low');
      var pre = w.match.ok && (maxRel === 0 || w.rel >= 0.33 * maxRel);
      var sig = w.match.ok
        ? '<span class="lt-match-sig" title="Attribution signals — why this is the right PI">' + ICON.svg('check') + ' ' + _esc(w.match.signals.join(' · ')) + '</span>'
        : '<span class="lt-match-warn" title="Only the family name matched — confirm this is the right ' + _esc(group.label) + ' before importing">' + ICON.svg('exclamation-triangle') + ' unverified — only family name</span>';
      return '<label class="lp-linkpick-row">' +
        '<input type="checkbox" data-recent-doi="' + _esc(w.doi) + '"' + (pre ? ' checked' : '') + '>' +
        '<span class="lp-linkpick-titlewrap">' +
        '<span class="lp-linkpick-title">' + _esc(w.title || w.doi) + '</span>' +
        '<span class="lp-linkpick-hint">' + [_esc(w.year), _esc(w.journal)].filter(Boolean).join(' · ') + '</span>' +
        sig +
        '</span>' +
        '<span class="lt-rel-badge lt-rel-' + bucket + '" title="Heuristic relevance to this topic">' + pct + '%</span>' +
        '</label>';
    }).join('');
    importBtn.disabled = false;
    importBtn.addEventListener('click', async function () {
      var dois = Array.prototype.slice.call(modal.querySelectorAll('[data-recent-doi]'))
        .filter(function (c) { return c.checked; }).map(function (c) { return c.getAttribute('data-recent-doi'); });
      if (!dois.length) { close(); return; }
      importBtn.disabled = true;
      var ok = 0, fail = 0;
      for (var i = 0; i < dois.length; i++) {
        statusEl.textContent = 'Importing ' + (i + 1) + '/' + dois.length + '…';
        try {
          var res = await window.LIBRARY_UPLOAD.fromDoi(dois[i]);
          var item = res.item;
          var fresh = await window.LIBRARY_LINKS.toggleTheme(item.id, themeId, true);
          item.meta = item.meta || {}; item.meta.library = item.meta.library || {};
          item.meta.library.themes = fresh;
          if (_papers.some(function (p) { return p.id === item.id; })) _patchLocalPaperThemes(item.id, fresh);
          else _papers.push(item);
          ok++;
        } catch (e) {
          console.warn('[library-themes] recent import failed for', dois[i], e.message || e);
          fail++;
        }
      }
      statusEl.textContent = 'Imported ' + ok + ' paper' + (ok === 1 ? '' : 's') + (fail ? ' · ' + fail + ' failed' : '') + '.';
      _renderGroups(themeId);
      _renderPaperList(themeId);
      setTimeout(close, 1400);
    });
  }

  /* ── Bulk import a list into the theme (V3.499) ─────────── */

  // Paste DOIs / PMIDs / arXiv IDs (one per line) or a BibTeX blob → resolve
  // via REFERENCE_IMPORT → dedupe against the library → import the new ones
  // and tag ALL (new + already-present) to the theme. "may or may not be in
  // the library" is handled by dedupeAndKey's new/existing split.
  function _openImportPapersModal(themeId) {
    var me = _me();
    if (!me.uid) { _setStatus('Sign in first.'); return; }
    if (!window.REFERENCE_IMPORT || !window.LIBRARY_METADATA) {
      alert('Import tools not loaded on this page — reload and try again.');
      return;
    }
    var existing = document.getElementById('lt-import-modal');
    if (existing) existing.remove();
    var modal = document.createElement('div');
    modal.id = 'lt-import-modal';
    modal.className = 'lp-overlay-import-modal';
    modal.innerHTML =
      '<div class="lp-oim-backdrop"></div>' +
      '<div class="lp-oim-card">' +
      '<div class="lp-oim-head">Import papers into this topic</div>' +
      '<div class="lp-oim-summary">Paste DOIs, PMIDs, or arXiv IDs (one per line) — or a BibTeX export. Papers already in the library are just tagged; new ones are imported first.</div>' +
      '<textarea id="lt-imp-text" class="lt-imp-text" rows="7" placeholder="10.1038/s41586-020-2612-2&#10;32901234&#10;2103.00020&#10;&#10;…or paste BibTeX (@article{ ... })"></textarea>' +
      '<div class="lt-imp-relrow">Relevance for imported papers: <select id="lt-imp-rel">' + _relOptionsHtml(2) + '</select></div>' +
      '<div class="lp-linkpick-list" id="lt-imp-list" style="display:none;"></div>' +
      '<div class="lp-oim-summary" id="lt-imp-status"></div>' +
      '<div class="lp-oim-foot">' +
      '<button class="btn btn-sm" id="lt-imp-cancel">Cancel</button>' +
      '<span style="flex:1"></span>' +
      '<button class="btn btn-sm" id="lt-imp-resolve">Resolve</button>' +
      '<button class="btn btn-sm lp-oim-primary" id="lt-imp-commit" disabled>Import + tag</button>' +
      '</div></div>';
    document.body.appendChild(modal);
    var close = function () { modal.remove(); };
    modal.querySelector('.lp-oim-backdrop').addEventListener('click', close);
    modal.querySelector('#lt-imp-cancel').addEventListener('click', close);
    var textEl = modal.querySelector('#lt-imp-text');
    var listEl = modal.querySelector('#lt-imp-list');
    var statusEl = modal.querySelector('#lt-imp-status');
    var resolveBtn = modal.querySelector('#lt-imp-resolve');
    var commitBtn = modal.querySelector('#lt-imp-commit');
    var entries = [];
    setTimeout(function () { textEl.focus(); }, 0);

    resolveBtn.addEventListener('click', async function () {
      var raw = textEl.value.trim();
      if (!raw) { textEl.focus(); return; }
      resolveBtn.disabled = true; commitBtn.disabled = true;
      entries = [];
      listEl.style.display = 'none';
      var metas;
      try {
        if (/@\w+\s*\{/.test(raw)) {
          statusEl.textContent = 'Parsing BibTeX…';
          metas = window.REFERENCE_IMPORT.parseBibtex(raw);
        } else {
          var ids = window.REFERENCE_IMPORT.parseDoiList(raw);
          if (!ids.length) { statusEl.textContent = 'No DOIs / PMIDs / arXiv IDs found.'; resolveBtn.disabled = false; return; }
          metas = await window.REFERENCE_IMPORT.resolveDois(ids, {
            onProgress: function (n, t, id) { statusEl.textContent = 'Resolving ' + n + '/' + t + ' — ' + id + '…'; },
          });
        }
      } catch (e) {
        statusEl.textContent = 'Parse/resolve failed: ' + (e.message || e);
        resolveBtn.disabled = false; return;
      }
      var good = (metas || []).filter(function (m) { return m && !m._error && m.title; });
      var failN = (metas || []).length - good.length;
      if (!good.length) {
        statusEl.textContent = 'Nothing resolved' + (failN ? ' (' + failN + ' failed)' : '') + '.';
        resolveBtn.disabled = false; return;
      }
      var res = window.REFERENCE_IMPORT.dedupeAndKey(good, _papers);
      entries = res.entries;
      var newN = 0, existN = 0;
      listEl.innerHTML = entries.map(function (e, idx) {
        var m = e.meta || {};
        var isNew = e.status === 'new';
        if (isNew) newN++; else existN++;
        var sub = [m.year, (m.authors && m.authors[0] && m.authors[0].family) || '', m.journal].filter(Boolean).join(' · ');
        return '<label class="lp-linkpick-row">' +
          '<input type="checkbox" data-imp-idx="' + idx + '" checked>' +
          '<span class="lp-linkpick-titlewrap">' +
          '<span class="lp-linkpick-title">' + _esc(m.title || '(untitled)') + '</span>' +
          (sub ? '<span class="lp-linkpick-hint">' + _esc(sub) + '</span>' : '') +
          '</span>' +
          '<span class="lt-imp-badge ' + (isNew ? 'lt-imp-new' : 'lt-imp-exist') + '">' + (isNew ? 'new' : 'in library') + '</span>' +
          '</label>';
      }).join('');
      listEl.style.display = '';
      statusEl.innerHTML = '<b>' + newN + '</b> new · <b>' + existN + '</b> already in library' +
        (failN ? ' · <b>' + failN + '</b> unresolved (skipped)' : '') + '. Untick any you don’t want.';
      commitBtn.disabled = (newN + existN === 0);
      resolveBtn.disabled = false;
    });

    commitBtn.addEventListener('click', async function () {
      var chosen = [];
      modal.querySelectorAll('[data-imp-idx]').forEach(function (c) {
        if (c.checked) chosen.push(entries[parseInt(c.getAttribute('data-imp-idx'), 10)]);
      });
      if (!chosen.length) { close(); return; }
      commitBtn.disabled = true; resolveBtn.disabled = true;
      var relW = parseInt(modal.querySelector('#lt-imp-rel').value, 10) || 2;
      var toCommit = chosen.filter(function (e) { return e.status === 'new'; }).map(function (e) { return e.item; });
      try {
        if (toCommit.length) {
          statusEl.textContent = 'Creating ' + toCommit.length + ' new library entr' + (toCommit.length === 1 ? 'y' : 'ies') + '…';
          await window.REFERENCE_IMPORT.commitToLibrary(toCommit);
          toCommit.forEach(function (it) { if (!_papers.some(function (p) { return p.id === it.id; })) _papers.push(it); });
        }
        var ids = chosen.map(function (e) { return e.status === 'new' ? e.item.id : e.existingId; }).filter(Boolean);
        var ok = 0;
        for (var i = 0; i < ids.length; i++) {
          statusEl.textContent = 'Tagging ' + (i + 1) + '/' + ids.length + '…';
          try {
            var fresh = await window.LIBRARY_LINKS.toggleTheme(ids[i], themeId, true);
            _patchLocalPaperThemes(ids[i], fresh);
            if (relW !== 2) {
              await window.LIBRARY_LINKS.setThemeRelevance(ids[i], themeId, relW);
              _patchLocalRelevance(ids[i], themeId, relW);
            }
            ok++;
          } catch (e) { console.warn('[library-themes] import-tag failed', ids[i], e.message || e); }
        }
        statusEl.textContent = 'Added ' + ok + ' paper' + (ok === 1 ? '' : 's') + ' to the topic' +
          (toCommit.length ? ' (' + toCommit.length + ' newly imported)' : '') + '.';
        _renderGroups(themeId);
        _renderPaperList(themeId);
        setTimeout(close, 1600);
      } catch (e) {
        statusEl.textContent = 'Import failed: ' + (e.message || e);
        commitBtn.disabled = false; resolveBtn.disabled = false;
      }
    });
  }

  /* ── Group curation editor (V3.496) ─────────────────────── */

  function _openGroupEditor(themeId, groupKey) {
    var me = _me();
    if (!me.uid) { _setStatus('Sign in first.'); return; }
    var groups = _deriveGroups(themeId);
    var derived = groups.find(function (g) { return g.key === groupKey; }) || { label: groupKey, institution: '', note: '', starred: false };
    var cur = _groups[groupKey] || null;
    var mergeCandidates = groups.filter(function (g) { return g.key !== groupKey && !g.unattributed; });

    var existing = document.getElementById('lt-group-modal');
    if (existing) existing.remove();
    var modal = document.createElement('div');
    modal.id = 'lt-group-modal';
    modal.className = 'lp-overlay-import-modal';
    modal.innerHTML =
      '<div class="lp-oim-backdrop"></div>' +
      '<div class="lp-oim-card">' +
      '<div class="lp-oim-head">Curate research group</div>' +
      '<div class="lt-meta-form">' +
      '<label>PI name<input type="text" id="lt-grp-name" maxlength="120" value="' + _esc((cur && cur.canonical_name) || derived.label) + '"></label>' +
      '<label>Institution<input type="text" id="lt-grp-inst" maxlength="160" placeholder="e.g. UPenn" value="' + _esc((cur && cur.institution) || derived.institution) + '"></label>' +
      '<label>Note<textarea id="lt-grp-note" rows="3" placeholder="Why this lab matters here — e.g. pioneered granular hydrogels; start with their 2015 Nat Mater paper.">' + _esc((cur && cur.note) || '') + '</textarea></label>' +
      '<label class="lt-grp-check"><input type="checkbox" id="lt-grp-star"' + ((cur && cur.starred) ? ' checked' : '') + '> ' + ICON.svg('star') + ' Key lab (pin to the top)</label>' +
      (mergeCandidates.length
        ? '<div class="lt-grp-merge"><div class="lt-grp-merge-head">Merge other labs into this one</div>' +
          '<div class="lt-grp-merge-hint">Fold name variants of the same PI together. (Two different PIs sharing initials only split apart once ORCID is captured — run library re-check.)</div>' +
          mergeCandidates.map(function (g) {
            return '<label class="lt-grp-merge-row"><input type="checkbox" data-merge-key="' + _esc(g.key) + '"> ' +
              _esc(g.label) + ' <span class="lt-grp-merge-count">(' + g.count + ')</span></label>';
          }).join('') + '</div>'
        : '') +
      '</div>' +
      '<div class="lp-oim-foot">' +
      (cur ? '<button class="btn btn-sm" id="lt-grp-clear" title="Remove curation (revert to auto-derived)">Reset</button>' : '') +
      '<span style="flex:1"></span>' +
      '<button class="btn btn-sm" id="lt-grp-cancel">Cancel</button>' +
      '<button class="btn btn-sm lp-oim-primary" id="lt-grp-save">Save</button>' +
      '</div></div>';
    document.body.appendChild(modal);
    var close = function () { modal.remove(); };
    modal.querySelector('.lp-oim-backdrop').addEventListener('click', close);
    modal.querySelector('#lt-grp-cancel').addEventListener('click', close);
    var clearBtn = modal.querySelector('#lt-grp-clear');
    if (clearBtn) {
      clearBtn.addEventListener('click', async function () {
        if (!confirm('Remove curation for this lab? It reverts to the auto-derived name/institution.')) return;
        try {
          await _themeRef(themeId).collection('groups').doc(_groupDocId(groupKey)).delete();
          await _loadGroups(themeId);
          _renderGroups(themeId); _renderPaperList(themeId);
          close();
        } catch (e) { alert('Reset failed: ' + (e.message || e)); }
      });
    }
    modal.querySelector('#lt-grp-save').addEventListener('click', async function (ev) {
      var btn = ev.currentTarget;
      btn.disabled = true; btn.textContent = 'Saving…';
      var mergeKeys = Array.prototype.slice.call(modal.querySelectorAll('[data-merge-key]'))
        .filter(function (c) { return c.checked; })
        .map(function (c) { return c.getAttribute('data-merge-key'); });
      try {
        await _saveGroup(themeId, groupKey, {
          name: modal.querySelector('#lt-grp-name').value.trim(),
          institution: modal.querySelector('#lt-grp-inst').value.trim(),
          note: modal.querySelector('#lt-grp-note').value.trim(),
          starred: modal.querySelector('#lt-grp-star').checked,
          mergeKeys: mergeKeys,
        });
        close();
      } catch (e) {
        console.error('[library-themes] group save failed:', e);
        btn.disabled = false; btn.textContent = 'Save';
        alert('Save failed: ' + (e.message || e));
      }
    });
  }

  async function _saveGroup(themeId, groupKey, vals) {
    var me = _me();
    var ref = _themeRef(themeId).collection('groups').doc(_groupDocId(groupKey));
    var existing = _groups[groupKey] || null;
    var merged = {};
    if (existing && Array.isArray(existing.merged_keys)) existing.merged_keys.forEach(function (k) { merged[k] = 1; });
    (vals.mergeKeys || []).forEach(function (mk) {
      if (mk === groupKey) return;
      merged[mk] = 1;
      var other = _groups[mk];
      if (other && Array.isArray(other.merged_keys)) other.merged_keys.forEach(function (k) { if (k !== groupKey) merged[k] = 1; });
    });
    var doc = {
      key: groupKey,
      canonical_name: vals.name || '',
      institution: vals.institution || '',
      note: vals.note || '',
      starred: !!vals.starred,
      merged_keys: Object.keys(merged),
      last_editor: me.name,
      modified_at: _nowIso(),
    };
    if (existing) {
      await ref.set(doc, { merge: true });
    } else {
      doc.created_by = me.uid;
      doc.creator_name = me.name;
      doc.created_at = _nowIso();
      await ref.set(doc);
    }
    // Absorb merged groups' own curation docs (folded in here now).
    for (var i = 0; i < (vals.mergeKeys || []).length; i++) {
      var mk = vals.mergeKeys[i];
      if (mk !== groupKey && _groups[mk]) {
        try { await _themeRef(themeId).collection('groups').doc(_groupDocId(mk)).delete(); } catch (e) {}
      }
    }
    await _loadGroups(themeId);
    if (_groupFilter && !_deriveGroups(themeId).some(function (g) { return g.key === _groupFilter; })) _groupFilter = null;
    _renderGroups(themeId);
    _renderPaperList(themeId);
  }

  /* ── Related topics: manual rank + suggest (V3.496) ─────── */

  async function _loadRelated(themeId) {
    _related = [];
    try {
      var snap = await _themeRef(themeId).collection('related').get();
      _related = snap.docs.map(function (d) {
        var x = d.data() || {};
        x.id = d.id;
        return x;
      });
      _related.sort(function (a, b) {
        var ra = typeof a.rank === 'number' ? a.rank : Infinity;
        var rb = typeof b.rank === 'number' ? b.rank : Infinity;
        return ra - rb;
      });
      // Drop dangling links to deleted/archived themes.
      _related = _related.filter(function (r) {
        return _allThemes.some(function (t) { return t.id === r.id && !t.archived; });
      });
    } catch (e) {
      console.warn('[library-themes] related load failed:', e.message || e);
    }
  }

  // Suggestion signal: how many library papers carry BOTH themes.
  function _sharedPaperCounts(themeId) {
    var counts = {};
    _papers.forEach(function (p) {
      var th = p.meta && p.meta.library && p.meta.library.themes;
      if (!Array.isArray(th) || th.indexOf(themeId) < 0) return;
      th.forEach(function (t) { if (t !== themeId) counts[t] = (counts[t] || 0) + 1; });
    });
    return counts;
  }

  function _renderRelated(themeId) {
    var host = document.getElementById('lt-related');
    if (!host || _openId !== themeId) return;
    if (!_related.length) {
      host.innerHTML = '<div class="lt-empty">No related topics yet — add the concepts a student should explore next (' + ICON.svg('plus') + ' Add / suggest).</div>';
      return;
    }
    var visible = _related.slice(0, _relatedShown);
    var hidden = _related.length - visible.length;
    var cards = visible.map(function (r, idx) {
      return '<div class="lt-related-card" data-rel-id="' + _esc(r.id) + '">' +
        '<a class="lt-related-name" href="/rm/pages/library.html?tab=themes&theme=' + encodeURIComponent(r.id) + '" title="Open this topic">' + _esc(getThemeNameById(r.id)) + '</a>' +
        '<span class="lt-related-controls">' +
          '<button class="lt-related-btn" data-rel-up="' + _esc(r.id) + '"' + (idx === 0 ? ' disabled' : '') + ' title="Move up">▲</button>' +
          '<button class="lt-related-btn" data-rel-down="' + _esc(r.id) + '"' + (idx === visible.length - 1 && !hidden ? ' disabled' : '') + ' title="Move down">▼</button>' +
          '<button class="lt-related-btn" data-rel-remove="' + _esc(r.id) + '" title="Remove">' + ICON.svg('x-mark') + '</button>' +
        '</span>' +
      '</div>';
    }).join('');
    var more = '';
    if (hidden > 0) more = '<button class="btn btn-sm lt-group-more" data-rel-more="all">' + ICON.svg('plus') + ' Show all ' + _related.length + '</button>';
    else if (_relatedShown > 5 && _related.length > 5) more = '<button class="btn btn-sm lt-group-more" data-rel-more="5">Show fewer</button>';
    host.innerHTML = '<div class="lt-related-list">' + cards + '</div>' + (more ? '<div class="lt-group-more-wrap">' + more + '</div>' : '');
    host.onclick = function (ev) {
      var moreBtn = ev.target.closest('[data-rel-more]');
      if (moreBtn) { _relatedShown = moreBtn.getAttribute('data-rel-more') === 'all' ? _related.length : 5; _renderRelated(themeId); return; }
      var up = ev.target.closest('[data-rel-up]');
      if (up) { _moveRelated(themeId, up.getAttribute('data-rel-up'), -1); return; }
      var down = ev.target.closest('[data-rel-down]');
      if (down) { _moveRelated(themeId, down.getAttribute('data-rel-down'), 1); return; }
      var rm = ev.target.closest('[data-rel-remove]');
      if (rm) { _removeRelated(themeId, rm.getAttribute('data-rel-remove')); return; }
    };
  }

  async function _moveRelated(themeId, id, dir) {
    var idx = _related.findIndex(function (r) { return r.id === id; });
    var j = idx + dir;
    if (idx < 0 || j < 0 || j >= _related.length) return;
    var arr = _related.slice();
    var tmp = arr[idx]; arr[idx] = arr[j]; arr[j] = tmp;
    try {
      await Promise.all(arr.map(function (r, i) {
        return _themeRef(themeId).collection('related').doc(r.id).set({ rank: i }, { merge: true });
      }));
      arr.forEach(function (r, i) { r.rank = i; });
      _related = arr;
      _renderRelated(themeId);
    } catch (e) { alert('Reorder failed: ' + (e.message || e)); }
  }

  async function _removeRelated(themeId, id) {
    try {
      await _themeRef(themeId).collection('related').doc(id).delete();
      _related = _related.filter(function (r) { return r.id !== id; });
      _renderRelated(themeId);
    } catch (e) { alert('Remove failed: ' + (e.message || e)); }
  }

  function _openRelatedPicker(themeId) {
    var me = _me();
    if (!me.uid) { _setStatus('Sign in first.'); return; }
    var existing = document.getElementById('lt-related-picker');
    if (existing) existing.remove();
    var already = new Set(_related.map(function (r) { return r.id; }));
    var shared = _sharedPaperCounts(themeId);
    var candidates = (_themes || []).filter(function (t) { return t.id !== themeId && !already.has(t.id); });
    candidates.sort(function (a, b) {
      var sa = shared[a.id] || 0, sb = shared[b.id] || 0;
      if (sa !== sb) return sb - sa;
      return (a.name || '').localeCompare(b.name || '');
    });
    var modal = document.createElement('div');
    modal.id = 'lt-related-picker';
    modal.className = 'lp-overlay-import-modal';
    var rowsHtml = candidates.map(function (t) {
      var n = shared[t.id] || 0;
      return '<label class="lp-linkpick-row">' +
        '<input type="checkbox" data-rel-add="' + _esc(t.id) + '">' +
        '<span class="lp-linkpick-titlewrap">' +
        '<span class="lp-linkpick-title">' + _esc(t.name || t.id) + '</span>' +
        (n ? '<span class="lp-linkpick-hint">' + ICON.svg('sparkles') + ' shares ' + n + ' paper' + (n === 1 ? '' : 's') + '</span>' : '') +
        '</span></label>';
    }).join('');
    modal.innerHTML =
      '<div class="lp-oim-backdrop"></div>' +
      '<div class="lp-oim-card">' +
      '<div class="lp-oim-head">Add related topics</div>' +
      '<div class="lp-oim-summary">Concepts a student should explore next. Topics are ranked by ' + ICON.svg('sparkles') + ' shared papers — top suggestions first. You order them after adding.</div>' +
      '<div class="lp-linkpick-list">' + (rowsHtml || '<div class="lp-linkpick-empty">No other topics to link.</div>') + '</div>' +
      '<div class="lp-oim-foot">' +
      '<button class="btn btn-sm" id="lt-rel-cancel">Cancel</button>' +
      '<button class="btn btn-sm lp-oim-primary" id="lt-rel-save">Add selected</button>' +
      '</div></div>';
    document.body.appendChild(modal);
    var close = function () { modal.remove(); };
    modal.querySelector('.lp-oim-backdrop').addEventListener('click', close);
    modal.querySelector('#lt-rel-cancel').addEventListener('click', close);
    modal.querySelector('#lt-rel-save').addEventListener('click', async function (ev) {
      var btn = ev.currentTarget;
      var ids = Array.prototype.slice.call(modal.querySelectorAll('[data-rel-add]'))
        .filter(function (c) { return c.checked; })
        .map(function (c) { return c.getAttribute('data-rel-add'); });
      if (!ids.length) { close(); return; }
      btn.disabled = true; btn.textContent = 'Adding…';
      try {
        var maxRank = _related.reduce(function (m, r) { return (typeof r.rank === 'number' && r.rank > m) ? r.rank : m; }, -1);
        for (var i = 0; i < ids.length; i++) {
          maxRank += 1;
          await _themeRef(themeId).collection('related').doc(ids[i]).set({
            rank: maxRank, added_by: me.uid, added_at: _nowIso(),
          });
        }
        await _loadRelated(themeId);
        _renderRelated(themeId);
        close();
      } catch (e) {
        console.error('[library-themes] related add failed:', e);
        btn.disabled = false; btn.textContent = 'Add selected';
        alert('Add failed: ' + (e.message || e));
      }
    });
  }

  /* ── Add-papers picker ──────────────────────────────────── */

  function _openAddPapersPicker(themeId) {
    var existing = document.getElementById('lt-paper-picker');
    if (existing) existing.remove();
    var member = new Set(_themePapers(themeId).map(function (p) { return p.id; }));
    var modal = document.createElement('div');
    modal.id = 'lt-paper-picker';
    modal.className = 'lp-overlay-import-modal';
    var rowsHtml = _papers.map(function (p) {
      var lib = (p.meta && p.meta.library) || {};
      var authorYear = [
        (lib.authors && lib.authors[0] && (lib.authors[0].family || '')) || '',
        lib.year || '',
      ].filter(Boolean).join(' ');
      var hay = ((p.title || '') + ' ' + authorYear + ' ' + (lib.citation_key || '')).toLowerCase();
      var isIn = member.has(p.id);
      return '<label class="lp-linkpick-row' + (isIn ? ' lp-linkpick-row-linked' : '') + '" data-row-search="' + _esc(hay) + '">' +
        '<input type="checkbox" data-item-id="' + _esc(p.id) + '"' + (isIn ? ' checked' : '') + '>' +
        '<span class="lp-linkpick-titlewrap">' +
        '<span class="lp-linkpick-title">' + _esc(p.title || p.id) + '</span>' +
        (authorYear ? '<span class="lp-linkpick-hint">' + _esc(authorYear) + '</span>' : '') +
        '</span>' +
        '<select class="lt-rel-select" data-rel-for="' + _esc(p.id) + '" title="Relevance to this topic (feeds the lab ranking)">' + _relOptionsHtml(_relevanceOf(p, themeId)) + '</select>' +
        '</label>';
    }).join('');
    modal.innerHTML =
      '<div class="lp-oim-backdrop"></div>' +
      '<div class="lp-oim-card">' +
      '<div class="lp-oim-head">Add papers to this topic</div>' +
      '<div class="lp-oim-summary">Tick every library paper that belongs to this concept. A paper can carry several topics.</div>' +
      '<div class="lp-linkpick-search-wrap"><input id="lt-pick-search" type="text" placeholder="Search title / author / year / key…" autocomplete="off"></div>' +
      '<div class="lp-linkpick-list">' + (rowsHtml || '<div class="lp-linkpick-empty">Library is empty.</div>') + '</div>' +
      '<div class="lp-oim-foot">' +
      '<button class="btn btn-sm" id="lt-pick-cancel">Cancel</button>' +
      '<button class="btn btn-sm lp-oim-primary" id="lt-pick-save">Save</button>' +
      '</div></div>';
    document.body.appendChild(modal);
    var close = function () { modal.remove(); };
    modal.querySelector('.lp-oim-backdrop').addEventListener('click', close);
    modal.querySelector('#lt-pick-cancel').addEventListener('click', close);
    var searchInp = modal.querySelector('#lt-pick-search');
    searchInp.addEventListener('input', function () {
      var tokens = searchInp.value.trim().toLowerCase().split(/\s+/).filter(Boolean);
      modal.querySelectorAll('.lp-linkpick-row').forEach(function (row) {
        var hay = row.getAttribute('data-row-search') || '';
        row.style.display = (!tokens.length || tokens.every(function (t) { return hay.indexOf(t) >= 0; })) ? '' : 'none';
      });
    });
    setTimeout(function () { searchInp.focus(); }, 0);
    modal.querySelector('#lt-pick-save').addEventListener('click', async function (ev) {
      var btn = ev.currentTarget;
      btn.disabled = true; btn.textContent = 'Saving…';
      try {
        var desired = new Set();
        modal.querySelectorAll('input[data-item-id]').forEach(function (c) {
          if (c.checked) desired.add(c.getAttribute('data-item-id'));
        });
        // V3.496 — relevance selection per row (Core/Supporting/Tangential).
        var relById = {};
        modal.querySelectorAll('select[data-rel-for]').forEach(function (s) {
          relById[s.getAttribute('data-rel-for')] = parseInt(s.value, 10) || 2;
        });
        for (const id of desired) {
          if (!member.has(id)) {
            _patchLocalPaperThemes(id, await window.LIBRARY_LINKS.toggleTheme(id, themeId, true));
          }
        }
        for (const id of member) {
          if (!desired.has(id)) {
            _patchLocalPaperThemes(id, await window.LIBRARY_LINKS.toggleTheme(id, themeId, false));
            _patchLocalRelevance(id, themeId, null);
          }
        }
        // Persist each kept paper's relevance weight — only when it actually
        // changed (unset already reads as Supporting=2, so no write needed).
        for (const id of desired) {
          var w = relById[id] || 2;
          var pp = _papers.find(function (x) { return x.id === id; });
          if (pp && _relevanceOf(pp, themeId) === w) continue;
          _patchLocalRelevance(id, themeId, w);
          await window.LIBRARY_LINKS.setThemeRelevance(id, themeId, w);
        }
        close();
        _renderGroups(themeId);
        _renderPaperList(themeId);
      } catch (e) {
        console.error('[library-themes] picker save failed:', e);
        btn.disabled = false; btn.textContent = 'Save';
        alert('Failed to save: ' + (e.message || e));
      }
    });
  }

  /* ── Synthesis notes (V3.368) ───────────────────────────── */

  function _mountNotes(themeId) {
    if (_notesUnsub) { try { _notesUnsub(); } catch (e) {} }
    _notesUnsub = _themeRef(themeId).collection('notes').onSnapshot(function (snap) {
      if (_openId !== themeId) return;
      _notes = snap.docs.map(function (d) {
        var x = d.data() || {};
        x.id = d.id;
        return x;
      });
      _notes.sort(function (a, b) {
        var oa = typeof a.order === 'number' ? a.order : Infinity;
        var ob = typeof b.order === 'number' ? b.order : Infinity;
        if (oa !== ob) return oa - ob;
        return String(a.created_at || '').localeCompare(String(b.created_at || ''));
      });
      _renderNotes(themeId);
    }, function (err) {
      console.warn('[library-themes] notes snapshot failed:', err.message || err);
    });
  }

  function _focusedNoteId() {
    var ae = document.activeElement;
    if (!ae) return null;
    var card = ae.closest ? ae.closest('.lt-note[data-note-id]') : null;
    return card ? card.getAttribute('data-note-id') : null;
  }

  function _renderNotes(themeId) {
    var host = document.getElementById('lt-notes');
    if (!host || _openId !== themeId) return;
    var focusedId = _focusedNoteId();
    var me = _me();

    if (!_notes.length) {
      host.innerHTML = '<div class="lt-empty">No notes yet. Start the shared synthesis — key equations, canonical protocols, how the papers relate, pitfalls for new students…</div>';
      return;
    }

    _notes.forEach(function (note) {
      var card = host.querySelector('.lt-note[data-note-id="' + note.id + '"]');
      var editedLine = (note.last_editor ? _esc(note.last_editor) : _esc(note.creator_name || '')) +
        (note.modified_at ? ' · ' + _esc(String(note.modified_at).slice(0, 16).replace('T', ' ')) : '');
      if (!card) {
        card = document.createElement('div');
        card.className = 'lt-note';
        card.setAttribute('data-note-id', note.id);
        card.innerHTML =
          '<div class="lt-note-head">' +
          '<span class="lt-note-byline"></span>' +
          '<span class="lt-note-notice" hidden></span>' +
          '<button class="lt-remove-btn" data-lt-del-note="' + _esc(note.id) + '" title="Delete this note">' + ICON.svg('x-mark') + '</button>' +
          '</div>' +
          '<div class="lt-note-body" contenteditable="true" data-mtime=""></div>';
        host.appendChild(card);
      }
      var body = card.querySelector('.lt-note-body');
      var byline = card.querySelector('.lt-note-byline');
      var notice = card.querySelector('.lt-note-notice');
      var delBtn = card.querySelector('[data-lt-del-note]');
      byline.innerHTML = editedLine;
      delBtn.style.display = (_isAdmin() || note.created_by === me.uid) ? '' : 'none';
      var canApply = note.id !== focusedId && !_noteDirty[note.id];
      if (canApply) {
        if (body.getAttribute('data-mtime') !== String(note.modified_at || '')) {
          body.innerHTML = _sanitizeHtml(note.body_html || '');
          body.setAttribute('data-mtime', String(note.modified_at || ''));
        }
        notice.hidden = true;
      } else if (body.getAttribute('data-mtime') !== String(note.modified_at || '')) {
        /* Remote edit landed while this note is focused/dirty locally:
         * DON'T clobber the caret — flag it. Applied on blur. */
        ICON.label(notice, 'pencil', ' ' + (note.last_editor || 'someone') + ' edited this note — your version saves over theirs on blur');
        notice.hidden = false;
        card._pendingRemote = note;
      }
    });

    // Drop cards whose docs were deleted remotely.
    Array.prototype.slice.call(host.querySelectorAll('.lt-note[data-note-id]')).forEach(function (card) {
      var id = card.getAttribute('data-note-id');
      if (!_notes.some(function (n) { return n.id === id; })) card.remove();
    });

    if (!host._wired) {
      host._wired = true;
      host.addEventListener('input', function (ev) {
        var card = ev.target.closest('.lt-note[data-note-id]');
        if (!card || !ev.target.classList.contains('lt-note-body')) return;
        var id = card.getAttribute('data-note-id');
        _noteDirty[id] = true;
        if (_noteTimers[id]) clearTimeout(_noteTimers[id]);
        _noteTimers[id] = setTimeout(function () { _saveNote(themeId, card); }, 800);
      });
      host.addEventListener('focusout', function (ev) {
        var card = ev.target.closest ? ev.target.closest('.lt-note[data-note-id]') : null;
        if (!card || !ev.target.classList.contains('lt-note-body')) return;
        var id = card.getAttribute('data-note-id');
        if (_noteTimers[id]) { clearTimeout(_noteTimers[id]); _noteTimers[id] = null; }
        if (_noteDirty[id]) _saveNote(themeId, card);
        card._pendingRemote = null;   // our save wins; snapshot will repaint
        var notice = card.querySelector('.lt-note-notice');
        if (notice) notice.hidden = true;
      });
      host.addEventListener('click', async function (ev) {
        var del = ev.target.closest('[data-lt-del-note]');
        if (!del) return;
        if (!confirm('Delete this note for everyone?')) return;
        try {
          await _themeRef(themeId).collection('notes').doc(del.getAttribute('data-lt-del-note')).delete();
        } catch (e) { alert('Delete failed: ' + (e.message || e)); }
      });
    }
  }

  async function _saveNote(themeId, card) {
    var id = card.getAttribute('data-note-id');
    var body = card.querySelector('.lt-note-body');
    if (!body) return;
    var me = _me();
    var clean = _sanitizeHtml(body.innerHTML);
    var mtime = _nowIso();
    try {
      await _themeRef(themeId).collection('notes').doc(id).update({
        body_html: clean,
        last_editor: me.name,
        modified_at: mtime,
      });
      _noteDirty[id] = false;
      body.setAttribute('data-mtime', mtime);
    } catch (e) {
      console.warn('[library-themes] note save failed:', e.message || e);
      _setStatus('Note save failed — retrying on next edit.');
    }
  }

  async function _addNote(themeId) {
    var me = _me();
    if (!me.uid) { _setStatus('Sign in first.'); return; }
    var maxOrder = _notes.reduce(function (m, n) {
      return typeof n.order === 'number' && n.order > m ? n.order : m;
    }, 0);
    try {
      await _themeRef(themeId).collection('notes').add({
        order: maxOrder + 1,
        body_html: '',
        created_by: me.uid,
        creator_name: me.name,
        created_at: _nowIso(),
        last_editor: me.name,
        modified_at: _nowIso(),
      });
      // onSnapshot renders the card; focus it once it lands.
      setTimeout(function () {
        var host = document.getElementById('lt-notes');
        var cards = host ? host.querySelectorAll('.lt-note-body') : [];
        if (cards.length) cards[cards.length - 1].focus();
      }, 400);
    } catch (e) {
      alert('Could not add note: ' + (e.message || e));
    }
  }

  /* ── Tab boot ───────────────────────────────────────────── */

  async function _start() {
    var hint = document.getElementById('lt-auth-hint');
    var member = typeof firebridge !== 'undefined' && firebridge.isLabMember && firebridge.isLabMember();
    if (!member) {
      if (hint) hint.style.display = '';
      return;
    }
    if (hint) hint.style.display = 'none';
    _setStatus('Loading themes…');
    try {
      var papersP = (typeof api !== 'undefined' && api.load)
        ? api.load('library/papers.json').then(function (d) {
            _papers = ((d && d.papers) || []).filter(function (p) {
              return p.meta && p.meta.library && p.meta.library.is_library_entry;
            });
          }).catch(function () { _papers = []; })
        : Promise.resolve();
      await Promise.all([loadThemes(true), papersP]);
      _setStatus('');
      _renderCards();
      var deepLink = new URLSearchParams(location.search).get('theme');
      if (deepLink && _allThemes.some(function (t) { return t.id === deepLink; })) {
        _openTheme(deepLink);
      }
    } catch (e) {
      console.error('[library-themes] boot failed:', e);
      _setStatus('Failed to load themes: ' + (e.message || e));
    }
    var newBtn = document.getElementById('lt-new-theme');
    if (newBtn && !newBtn._wired) {
      newBtn._wired = true;
      newBtn.addEventListener('click', _openCreateModal);
    }
  }

  if (typeof window !== 'undefined' && window.__LIB_TAB === 'themes') {
    document.addEventListener('DOMContentLoaded', function () {
      /* Boot on firebridge.onAuth rather than raw onAuthStateChanged:
       * isLabMember() reads the users/{uid} profile doc, which lands
       * AFTER auth resolves — onAuth fires again when it does, so a
       * member isn't misread as a guest on a cold load. _booted guards
       * the full data load against duplicate callbacks. */
      var _booted = false;
      var _maybeBoot = function () {
        if (_booted) return;
        if (typeof firebridge !== 'undefined' && firebridge.isLabMember && firebridge.isLabMember()) {
          _booted = true;
        }
        _start();
      };
      if (typeof firebridge !== 'undefined' && firebridge.onAuth) firebridge.onAuth(_maybeBoot);
      else if (typeof firebase !== 'undefined' && firebase.auth) {
        firebase.auth().onAuthStateChanged(_maybeBoot);
      }
    });
  }

  window.LIBRARY_THEMES = {
    loadThemes: loadThemes,
    getThemes: getThemes,
    getThemeNameById: getThemeNameById,
  };
})();
