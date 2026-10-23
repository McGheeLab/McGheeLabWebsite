/* library-comments.js — cross-paper annotation feed.
 *
 * Pulls every annotation in the lab via Firestore collectionGroup queries
 * (the annotation schema is identical per paper, so a single CG query works
 * across the whole project). Merges lab-visible annotations with the
 * signed-in user's own private annotations, joins each row against
 * data/items.json (loaded once) for the parent paper's title + tags, then
 * renders a filterable feed.
 *
 * Filters apply client-side over the merged in-memory list so the user can
 * tweak without refetching. The first time this page runs against a fresh
 * project, Firestore will demand two composite indexes — the console
 * surfaces a one-click "Create index" link that you click and wait ~1 min.
 */

(function () {
  let _papersById = new Map();   // id → item (for title + tags lookup)
  let _annotations = [];          // raw annotation rows from Firestore
  let _colors = [];               // [{ id, name, hex, ... }]
  let _claimToDraft = new Map();  // claimId → draftPaperId (lit-review bridge)
  let _annotationsLoadError = '';
  let _drafts = [];               // [{id, title}, ...] — papers we are writing
  // V3.622 — per-paper section open/closed memory (survives live re-renders),
  // inline comment editors, and the evidence (claims) form state.
  const _groupToggles = new Map();  // 'section|paperId' → bool
  const _commentForm = new Map();   // annId → { text, busy, err }
  const _evForm = new Map();        // annId → { open, draftId, claims, claimId, stance, busy, err, newStmt }
  let _currentUid = '';
  let _expandedRows = new Set();  // ann __id of rows whose edit panel is open
  let _annUnsubs = [];            // per-paper onSnapshot unsub fns (Phase C live sync)
  let _annDocsByPaper = new Map(); // paperId → Map<docId, row> for incremental merge
  let _filters = {
    paper_id: '',            // '' = all papers; otherwise filter to this items.json id
    search: '',
    tag: '',
    stance: 'all',           // 'all' | 'for' | 'against' | 'plain'
    from: '',
    to: '',
    has_comment: false,
    authors: new Set(),      // creator.uid
    colors: new Set(),       // color_id
  };
  let _busy = false;

  // ---- DOM helpers ----

  function _$(id) { return document.getElementById(id); }
  function _esc(s) {
    return String(s ?? '').replace(/[&<>"']/g, c =>
      ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c])
    );
  }
  function _setStatus(msg) {
    const el = _$('lc-status');
    if (el) el.textContent = msg || '';
  }

  // ---- Loading ----

  /* V3.631 — this page resolved drafts from the WRONG collection.
   *
   * Every other surface (the reader toolbar picker, the sidebar pills, the
   * library row popover, the builder References tab) resolves paper drafts
   * from `projects/papers.json` — the paper builder's source of truth. This
   * page alone scanned `items.json` for `type:'paper'` rows without
   * `is_library_entry`, i.e. LEGACY items-collection paper rows. There are
   * none in the current data, so `_drafts` came back empty and the per-card
   * Drafts pill row plus the whole evidence form's draft select silently
   * degraded to "No drafts available." — on the page that V3.622 made the
   * home of the categorization workflow.
   *
   * `items.json` is still loaded, because `_papersById` needs it: it maps an
   * annotation's parent paper id to its title, and those parents ARE library
   * items. Only the draft list moves. Grant drafts come along too, filtered by
   * the one shared status vocabulary (LIBRARY_LINKS.GRANT_DRAFT_STATUSES), so
   * this page finally offers the same set as every other picker. */
  async function _loadPapers() {
    _papersById = new Map();
    _drafts = [];
    try {
      const data = await api.load('items.json');
      const items = (data && data.items) || [];
      const isGrantDraft = (window.LIBRARY_LINKS && LIBRARY_LINKS.isGrantDraftStatus)
        ? LIBRARY_LINKS.isGrantDraftStatus
        : (s) => ['drafting', 'submitted', 'under_review', 'revising', 'rejected'].indexOf(s) !== -1;
      for (const it of items) {
        // Annotation parents: every paper item, library entry or not.
        if (it.type === 'paper') _papersById.set(it.id, it);
        // Grant proposals we'd still cite toward are valid draft targets.
        if (it.type === 'grant' && isGrantDraft(it.status)) {
          _drafts.push({ id: it.id, title: it.title || it.id });
        }
      }
    } catch (e) {
      console.warn('[library-comments] could not load items.json:', e.message);
    }
    try {
      const pdata = await api.load('projects/papers.json');
      const papers = (pdata && pdata.papers) || [];
      for (const p of papers) {
        if (p.status === 'published') continue;   // matches LIBRARY_ASSOC's active test
        _drafts.push({ id: p.id, title: p.title || p.id });
      }
    } catch (e) {
      console.warn('[library-comments] could not load projects/papers.json:', e.message);
    }
    _drafts.sort((a, b) => (a.title || '').localeCompare(b.title || ''));
  }

  /* V3.631 — `_isDraft(paper)` deleted. It tested "a paper item without
   * is_library_entry" against `_papersById`, which holds the annotations'
   * PARENT papers — all library entries by definition — so it returned false
   * for every input and left both of its callers with an empty draft list.
   * The draft list now comes from `_drafts` (built in _loadPapers from
   * projects/papers.json + proposal-status grants, the same source every
   * other picker uses). */

  // Build the claim → draft bridge by querying each draft's claims
  // subcollection directly. Avoids Firestore collectionGroup queries,
  // which require a `{path=**}/claims/{claimId}` recursive-wildcard rule
  // — the existing rule only matches the specific `drafts/*/claims/*`
  // path, so CG queries fail with "Missing or insufficient permissions".
  // Per-draft queries match the existing rule directly.
  let _claimsLoadError = '';
  async function _loadClaims() {
    _claimsLoadError = '';
    if (typeof firebase === 'undefined' || !firebase.firestore) {
      _claimsLoadError = 'Firestore SDK missing';
      return;
    }
    if (!firebase.auth || !firebase.auth().currentUser) {
      _claimsLoadError = 'not signed in';
      return;
    }
    // V3.631 — `_drafts` for the same reason as _renderPaperPicker: the
    // claim→draft bridge queries drafts/{draftId}/claims, and deriving the
    // draft list from the annotations' library-entry parents found none, so
    // _claimToDraft stayed empty and no highlight ever counted as
    // "categorized by claim evidence".
    const drafts = _drafts;
    if (!drafts.length) return;
    const db = firebase.firestore();
    _claimToDraft = new Map();
    const draftCounts = new Map();
    const failures = [];

    await Promise.all(drafts.map(async (paper) => {
      try {
        const snap = await db.collection('drafts').doc(paper.id).collection('claims').get();
        snap.forEach(doc => {
          _claimToDraft.set(doc.id, paper.id);
          draftCounts.set(paper.id, (draftCounts.get(paper.id) || 0) + 1);
        });
      } catch (e) {
        failures.push(`${paper.id}: ${e.message || e}`);
      }
    }));

    if (failures.length) {
      _claimsLoadError = `${failures.length}/${drafts.length} drafts failed: ${failures[0]}`;
      console.warn('[library-comments] claim subcollection queries failed:', failures);
    }
    console.log(
      `[library-comments] loaded ${_claimToDraft.size} claim${_claimToDraft.size === 1 ? '' : 's'} across`,
      draftCounts.size,
      `of ${drafts.length} draft(s):`,
      Array.from(draftCounts.entries()).map(([d, n]) => `${d}=${n}`).join(', ') || '(none)'
    );
  }

  /* V3.620 — palette single-sourced in annotation-colors.js (this file used
   * to carry a "keep in sync" duplicate; the per-user palette route it
   * consulted was dead code with no writer — V3.608's root cause). */
  async function _loadColors() {
    _colors = (window.ANNOTATION_COLORS && window.ANNOTATION_COLORS.DEFAULT) || [];
  }

  // Per-paper subcollection queries instead of collectionGroup, for the
  // same reason as _loadClaims: Firestore CG queries require rules with
  // recursive-wildcard match paths, which the annotations rule doesn't
  // have. Per-paper queries match the existing
  // `match /papers/{paperId}/annotations/{annId}` rule directly.
  //
  // Two single-equality queries per paper (no composite indexes needed):
  //   1) visibility == 'lab'           — readable by any auth user
  //   2) creator.uid == <me>           — readable by the creator (any vis)
  // Union-then-dedupe by doc id covers both my-own-private and shared-lab
  // annotations across every paper in items.json.
  // Phase C — per-paper live sync. For each paper in the library, attach two
  // onSnapshot listeners (lab-visible + the signed-in user's own private).
  // Snapshots merge into _annDocsByPaper incrementally; debounced re-render
  // flattens to _annotations and refreshes the feed.
  //
  // Why per-paper instead of collectionGroup: rules require a path-shaped
  // match (papers/{paperId}/annotations/{annId}) so collectionGroup fails.
  // With items.json at ~35 entries, ~70 listeners is acceptable. If the
  // library grows past a few hundred entries, revisit (paginate by recently-
  // active paper, or onSnapshot only the filtered subset).
  function _flattenAnnotations() {
    const out = [];
    _annDocsByPaper.forEach((m) => m.forEach((row) => out.push(row)));
    return out.sort((a, b) => {
      const ta = a.created && a.created.toMillis ? a.created.toMillis() : 0;
      const tb = b.created && b.created.toMillis ? b.created.toMillis() : 0;
      return tb - ta;
    });
  }

  const _renderDebounced = _debounce(() => {
    _annotations = _flattenAnnotations();
    _render();
  }, 150);

  function _detachAnnotationListeners() {
    for (const u of _annUnsubs) {
      try { u(); } catch (_) { /* best-effort */ }
    }
    _annUnsubs = [];
    _annDocsByPaper = new Map();
  }

  async function _attachAnnotationListeners() {
    if (typeof firebase === 'undefined' || !firebase.firestore || !firebase.auth) {
      throw new Error('Firebase not initialized.');
    }
    const user = firebase.auth().currentUser;
    if (!user) throw new Error('Not signed in.');
    _detachAnnotationListeners();
    const db = firebase.firestore();
    const papers = Array.from(_papersById.values());
    const failures = [];

    function _absorbSnap(snap, paperId) {
      let m = _annDocsByPaper.get(paperId);
      if (!m) { m = new Map(); _annDocsByPaper.set(paperId, m); }
      snap.docChanges().forEach((chg) => {
        if (chg.type === 'removed') {
          m.delete(chg.doc.id);
          return;
        }
        const d = chg.doc.data();
        d.__id = chg.doc.id;
        if (!d.paperId) d.paperId = paperId;
        m.set(chg.doc.id, d);
      });
      _renderDebounced();
    }

    // V3.621 — listener errors arrive ASYNC (a rules rejection fires the
    // error callback long after this function returned), so the old
    // synchronous check below never saw them: the failures array was
    // write-only and the feed silently omitted those papers. _noteFailure
    // updates the visible status line whenever one lands.
    function _noteFailure(msg) {
      failures.push(msg);
      _annotationsLoadError = `${failures.length} subqueries failed: ${failures[0]}`;
      console.warn('[library-comments] annotation listener failure:', msg);
      _renderDebounced();
    }

    for (const p of papers) {
      const col = db.collection('papers').doc(p.id).collection('annotations');
      try {
        const u1 = col.where('visibility', '==', 'lab').onSnapshot(
          (snap) => _absorbSnap(snap, p.id),
          (err) => _noteFailure(`${p.id} lab: ${err.message || err}`)
        );
        _annUnsubs.push(u1);
      } catch (e) { _noteFailure(`${p.id} lab: ${e.message || e}`); }
      try {
        const u2 = col.where('creator.uid', '==', user.uid).onSnapshot(
          (snap) => _absorbSnap(snap, p.id),
          (err) => _noteFailure(`${p.id} mine: ${err.message || err}`)
        );
        _annUnsubs.push(u2);
      } catch (e) { _noteFailure(`${p.id} mine: ${e.message || e}`); }
    }

    if (!failures.length) _annotationsLoadError = '';
    console.log(
      `[library-comments] live listeners attached: ${_annUnsubs.length} ` +
      `(${papers.length} papers × 2 queries), signed-in uid=${user.uid}`
    );
  }

  // ---- Filtering ----

  function _applyFilters(rows) {
    const q = (_filters.search || '').toLowerCase();
    const tagQ = (_filters.tag || '').toLowerCase();
    const fromMs = _filters.from ? Date.parse(_filters.from + 'T00:00:00') : 0;
    const toMs = _filters.to ? Date.parse(_filters.to + 'T23:59:59') : Infinity;

    return rows.filter(r => {
      // Draft filter — when set, keep annotations that are EITHER:
      //   (a) evidence for a claim on the selected draft (claim-bridge), OR
      //   (b) directly tagged via cite_in_drafts (lit-review feed)
      if (_filters.paper_id) {
        const claimIds = Array.isArray(r.evidence_for_claim_ids) ? r.evidence_for_claim_ids : [];
        const viaClaim = claimIds.some(cid => _claimToDraft.get(cid) === _filters.paper_id);
        const viaCite = Array.isArray(r.cite_in_drafts) && r.cite_in_drafts.includes(_filters.paper_id);
        if (!viaClaim && !viaCite) return false;
      }
      // Stance.
      if (_filters.stance !== 'all') {
        const stance = r.evidence_stance || (r.evidence_for_claim_ids && r.evidence_for_claim_ids.length ? 'plain-tagged' : 'plain');
        if (_filters.stance === 'plain') {
          if (r.evidence_stance) return false;
          if (r.evidence_for_claim_ids && r.evidence_for_claim_ids.length) return false;
        } else if (_filters.stance === 'for') {
          if (r.evidence_stance !== 'for') return false;
        } else if (_filters.stance === 'against') {
          if (r.evidence_stance !== 'against') return false;
        }
      }
      // Date range.
      if (fromMs || toMs !== Infinity) {
        const ms = r.created && r.created.toMillis ? r.created.toMillis() : 0;
        if (ms < fromMs || ms > toMs) return false;
      }
      // Has-comment toggle.
      if (_filters.has_comment && !(r.comment && String(r.comment).trim())) return false;
      // Authors.
      if (_filters.authors.size && r.creator) {
        if (!_filters.authors.has(r.creator.uid)) return false;
      } else if (_filters.authors.size && !r.creator) {
        return false;
      }
      // Colors.
      if (_filters.colors.size && !_filters.colors.has(r.color_id)) return false;
      // Search text — match comment + highlighted text + paper title.
      if (q) {
        const blob = `${r.comment || ''} ${_quoteText(r)} ${(_papersById.get(r.paperId) || {}).title || ''}`.toLowerCase();
        if (!blob.includes(q)) return false;
      }
      // Tag prefix — annotations inherit their paper's tags.
      if (tagQ) {
        const paper = _papersById.get(r.paperId);
        const tags = paper && window.LIBRARY_TAGS ? LIBRARY_TAGS.getTags(paper) : [];
        if (!window.LIBRARY_TAGS || !LIBRARY_TAGS.matchPrefix(tags, tagQ)) return false;
      }
      return true;
    });
  }

  function _quoteText(r) {
    // Pull the highlighted text (textQuote.exact) from the first page anchor.
    if (!r.target || !Array.isArray(r.target.pages) || !r.target.pages.length) return '';
    const first = r.target.pages[0] || {};
    const sel = first.selectors || {};
    return (sel.textQuote && sel.textQuote.exact) || '';
  }

  // ---- Rendering ----

  function _colorById(id) {
    return _colors.find(c => c.id === id) || { hex: '#d1d5db', name: id || 'Unknown' };
  }

  // Populate the dropdown with every DRAFT paper (papers we are writing),
  // not library entries. Each option shows a count of annotations in its
  // lit review — i.e. annotations linked as evidence to any claim on
  // that draft. Sort: highest evidence count first, then alphabetical.
  function _renderPaperPicker(rows) {
    const sel = _$('lc-paper');
    if (!sel) return;

    // Count per-draft annotations via BOTH:
    //   (a) evidence_for_claim_ids → claim → draft (the claim-bridge), and
    //   (b) cite_in_drafts directly tagged on the annotation.
    const counts = new Map();
    for (const r of rows) {
      const draftsHit = new Set();
      const claimIds = Array.isArray(r.evidence_for_claim_ids) ? r.evidence_for_claim_ids : [];
      for (const cid of claimIds) {
        const did = _claimToDraft.get(cid);
        if (did) draftsHit.add(did);
      }
      const cited = Array.isArray(r.cite_in_drafts) ? r.cite_in_drafts : [];
      for (const did of cited) draftsHit.add(did);

      for (const did of draftsHit) {
        counts.set(did, (counts.get(did) || 0) + 1);
      }
    }

    /* V3.631 — from `_drafts` (projects/papers.json + proposal-status grants),
     * not from `_papersById` filtered by _isDraft. `_papersById` holds the
     * annotations' PARENT papers, which are library entries, so `_isDraft`
     * rejected every one and this dropdown always rendered its "No draft
     * papers yet" disabled row. Same wrong-collection root cause as
     * _loadPapers. */
    const drafts = _drafts
      .map(p => ({ paperId: p.id, title: p.title || p.id, n: counts.get(p.id) || 0 }));
    drafts.sort((a, b) => {
      if (a.n !== b.n) return b.n - a.n;        // most-evidenced first
      return a.title.localeCompare(b.title);    // tie: alphabetical
    });

    const cur = _filters.paper_id || '';
    let html = `<option value="">All drafts (${rows.length} annotation${rows.length === 1 ? '' : 's'})</option>`;
    if (!drafts.length) {
      html += `<option value="" disabled>No draft papers yet — add one on Research → Projects</option>`;
    }
    for (const d of drafts) {
      const isCur = d.paperId === cur ? ' selected' : '';
      const countLabel = d.n ? ` (${d.n} evidence)` : ' (—)';
      html += `<option value="${_esc(d.paperId)}"${isCur}>${_esc(d.title.slice(0, 90))}${countLabel}</option>`;
    }
    sel.innerHTML = html;
  }

  function _renderAuthorPicker(rows) {
    const host = _$('lc-authors');
    if (!host) return;
    const seen = new Map();   // uid → displayName
    for (const r of rows) {
      if (r.creator && r.creator.uid) {
        if (!seen.has(r.creator.uid)) {
          seen.set(r.creator.uid, r.creator.displayName || r.creator.email || r.creator.uid.slice(0, 8));
        }
      }
    }
    if (!seen.size) {
      host.innerHTML = '<span style="color:#9ca3af;font-size:11px;font-style:italic;">No authors yet.</span>';
      return;
    }
    host.innerHTML = Array.from(seen.entries()).map(([uid, name]) => `
      <span class="lc-ms-pill ${_filters.authors.has(uid) ? 'on' : ''}" data-author="${_esc(uid)}">${_esc(name)}</span>
    `).join('');
  }

  function _renderColorPicker() {
    const host = _$('lc-colors');
    if (!host) return;
    if (!_colors.length) {
      host.innerHTML = '<span style="color:#9ca3af;font-size:11px;font-style:italic;">No color seed loaded.</span>';
      return;
    }
    host.innerHTML = _colors.map(c => `
      <span class="lc-ms-pill ${_filters.colors.has(c.id) ? 'on' : ''}" data-color="${_esc(c.id)}" style="border-left:4px solid ${c.hex};">${_esc(c.name)}</span>
    `).join('');
  }

  function _isEvidence(r) {
    if (r.evidence_stance) return true;
    return Array.isArray(r.evidence_for_claim_ids) && r.evidence_for_claim_ids.length > 0;
  }

  /* V3.622 — "categorized" means the highlight has reached a paper we're
   * writing: filed into a draft (cite_in_drafts) or tagged as claim
   * evidence. Everything else is the triage queue — the reader's quick
   * note happens while reading; the deep categorization happens HERE. */
  function _isCategorized(r) {
    if (Array.isArray(r.cite_in_drafts) && r.cite_in_drafts.length) return true;
    return _isEvidence(r);
  }

  function _latestMs(list) {
    let ms = 0;
    for (const r of list) {
      const t = r.created && r.created.toMillis ? r.created.toMillis() : 0;
      if (t > ms) ms = t;
    }
    return ms;
  }

  /* V3.622 — rows grouped into collapsible per-paper sections (the flat
   * cross-paper stream made triage impossible). Open/closed choices are
   * remembered across the live re-renders in _groupToggles. */
  function _renderPaperGroups(rows, sectionKey, openByDefault) {
    const by = new Map();
    for (const r of rows) {
      if (!by.has(r.paperId)) by.set(r.paperId, []);
      by.get(r.paperId).push(r);
    }
    const groups = Array.from(by.entries())
      .sort((a, b) => _latestMs(b[1]) - _latestMs(a[1]));
    return groups.map(([pid, list]) => {
      const paper = _papersById.get(pid) || {};
      const title = paper.title || pid || 'Unknown paper';
      const key = `${sectionKey}|${pid}`;
      const open = _groupToggles.has(key) ? _groupToggles.get(key) : openByDefault;
      return `
        <details class="lc-paper-group" data-group-key="${_esc(key)}"${open ? ' open' : ''}>
          <summary class="lc-paper-summary">${ICON.svg('document-text')} ${_esc(title.slice(0, 110))}
            <span class="lc-section-count">${list.length} highlight${list.length === 1 ? '' : 's'}</span>
          </summary>
          ${list.map(_renderRow).join('')}
        </details>`;
    }).join('');
  }

  function _renderRows(rows) {
    const host = _$('lc-rows');
    if (!host) return;
    if (!rows.length) {
      host.innerHTML = '<div class="lc-empty">No annotations match the current filters.</div>';
      return;
    }
    const triage = rows.filter(r => !_isCategorized(r));
    const done = rows.filter(_isCategorized);
    let html = '';
    if (triage.length) {
      html += `<div class="lc-section-head"><span class="lc-section-tag lc-section-triage">${ICON.svg('arrow-down-tray')} To categorize</span> <span class="lc-section-count">${triage.length} highlight${triage.length === 1 ? '' : 's'} not yet filed to a draft or claim</span></div>`;
      html += _renderPaperGroups(triage, 'triage', true);
    }
    if (done.length) {
      html += `<div class="lc-section-head"><span class="lc-section-tag lc-section-evidence">${ICON.svg('rectangle-stack')} Categorized</span> <span class="lc-section-count">${done.length} highlight${done.length === 1 ? '' : 's'}</span></div>`;
      html += _renderPaperGroups(done, 'done', !triage.length);
    }
    host.innerHTML = html;
  }

  function _renderRow(r) {
    const paper = _papersById.get(r.paperId) || {};
    const paperTitle = paper.title || r.paperId || 'Unknown paper';
    const lib = (paper.meta && paper.meta.library) || {};
    const tags = window.LIBRARY_TAGS ? LIBRARY_TAGS.getTags(paper) : [];
    const color = _colorById(r.color_id);
    const author = r.creator && (r.creator.displayName || r.creator.email) || 'Unknown';
    const isPrivate = r.visibility === 'private';
    const isMine = r.creator && r.creator.uid === _currentUid;
    const stanceBadge = r.evidence_stance === 'for'
      ? '<span class="lc-stance-for">supporting</span>'
      : r.evidence_stance === 'against'
        ? '<span class="lc-stance-against">counter</span>'
        : '';
    const dateStr = r.created && r.created.toDate
      ? r.created.toDate().toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric' })
      : '';
    const quote = _quoteText(r);
    const truncQ = quote.length > 240 ? quote.slice(0, 240) + '…' : quote;
    const pageNum = (r.target && Array.isArray(r.target.pages) && r.target.pages[0] && r.target.pages[0].page) || '';

    const tagChips = tags.slice(0, 4).map(t =>
      `<span class="lc-tag-chip" data-tag="${_esc(t)}">${_esc(t)}</span>`
    ).join('');

    // Drafts: chips for tagged + dropdown to add more (collapsed by default).
    const cited = Array.isArray(r.cite_in_drafts) ? r.cite_in_drafts : [];
    const taggedDrafts = _drafts.filter(d => cited.includes(d.id));
    const untaggedDrafts = _drafts.filter(d => !cited.includes(d.id));
    const draftsRow = _drafts.length ? `
      <div class="lc-edit-line">
        <span class="lc-edit-label">Drafts</span>
        <div class="lc-draft-chips">
          ${taggedDrafts.map(d => `
            <span class="lc-draft-chip">${_esc((d.title || d.id).slice(0, 24))}${(d.title || d.id).length > 24 ? '…' : ''}<button class="lc-draft-x" data-paper="${_esc(r.paperId)}" data-ann="${_esc(r.__id || '')}" data-draft="${_esc(d.id)}" title="Remove">×</button></span>
          `).join('') || '<span class="lc-empty-mini">none</span>'}
        </div>
        ${untaggedDrafts.length ? `
          <select class="lc-draft-add" data-paper="${_esc(r.paperId)}" data-ann="${_esc(r.__id || '')}">
            <option value="">+ add draft…</option>
            ${untaggedDrafts.map(d => `<option value="${_esc(d.id)}">${_esc((d.title || d.id).slice(0, 60))}</option>`).join('')}
          </select>` : ''}
      </div>` : '';

    // V3.620 — group dropdown retired: the annotation `group` field was
    // write-only (nothing read it anywhere). Legacy values stay on old docs.

    const annId = r.__id || '';

    // V3.622 — the claims/evidence flow lives HERE now (demoted out of the
    // reader panel): draft → claim (pick or create) → stance → tag.
    const ev = _evForm.get(annId);
    let evidenceBlock = '';
    if (ev && ev.open) {
      const draftOpts = _drafts.map(d =>
        `<option value="${_esc(d.id)}"${d.id === ev.draftId ? ' selected' : ''}>${_esc((d.title || d.id).slice(0, 60))}</option>`).join('');
      let claimsList;
      if (!ev.draftId) claimsList = '<div class="lc-empty-mini">No drafts available.</div>';
      else if (ev.claims === null) claimsList = '<div class="lc-empty-mini">Loading claims…</div>';
      else if (!ev.claims.length) claimsList = '<div class="lc-empty-mini">No claims yet on this draft — create one below.</div>';
      else {
        claimsList = ev.claims.map(c => `
          <label class="lc-claim-pick">
            <input type="radio" name="lc-claim-${_esc(annId)}" value="${_esc(c.id)}"
              data-paper="${_esc(r.paperId)}" data-ann="${_esc(annId)}"${c.id === ev.claimId ? ' checked' : ''}>
            <span>${_esc((c.statement || '(no statement)').slice(0, 120))}${(c.statement || '').length > 120 ? '…' : ''}</span>
          </label>`).join('');
      }
      evidenceBlock = `
        <div class="lc-ev-form" data-ann="${_esc(annId)}">
          <div class="lc-edit-line"><span class="lc-edit-label">Draft</span>
            <select class="lc-ev-draft" data-paper="${_esc(r.paperId)}" data-ann="${_esc(annId)}">${draftOpts || '<option value="">(no drafts)</option>'}</select>
          </div>
          <div class="lc-edit-line"><span class="lc-edit-label">Claim</span>
            <div class="lc-claims-list">${claimsList}</div>
          </div>
          <div class="lc-edit-line"><span class="lc-edit-label">+ new</span>
            <input type="text" class="lc-ev-newclaim" data-paper="${_esc(r.paperId)}" data-ann="${_esc(annId)}" placeholder="Or create a new claim on this draft" value="${_esc(ev.newStmt || '')}">
            <button class="btn btn-sm lc-ev-newclaim-btn" data-paper="${_esc(r.paperId)}" data-ann="${_esc(annId)}">Add</button>
          </div>
          <div class="lc-edit-line"><span class="lc-edit-label">Stance</span>
            <label><input type="radio" name="lc-stance-${_esc(annId)}" value="for" data-ann="${_esc(annId)}"${ev.stance === 'for' ? ' checked' : ''}> Supports</label>
            <label><input type="radio" name="lc-stance-${_esc(annId)}" value="against" data-ann="${_esc(annId)}"${ev.stance === 'against' ? ' checked' : ''}> Against</label>
          </div>
          ${ev.err ? `<div class="lc-ev-err">${_esc(ev.err)}</div>` : ''}
          <div class="lc-edit-line">
            <button class="btn btn-sm lc-ev-cancel" data-ann="${_esc(annId)}"${ev.busy ? ' disabled' : ''}>Cancel</button>
            <button class="btn btn-sm btn-primary lc-ev-save" data-paper="${_esc(r.paperId)}" data-ann="${_esc(annId)}"${(ev.busy || !ev.claimId) ? ' disabled' : ''}>${ev.busy ? 'Linking…' : ICON.svg('scale') + ' Tag as evidence'}</button>
          </div>
        </div>`;
    }

    // V3.622 — inline comment editor (replaces the window.prompt). Text
    // survives the live re-renders via _commentForm.
    const cf = _commentForm.get(annId);
    const commentEditor = cf ? `
      <div class="lc-comment-form" data-ann="${_esc(annId)}">
        <textarea class="lc-comment-input" data-paper="${_esc(r.paperId)}" data-ann="${_esc(annId)}" rows="2"${cf.busy ? ' disabled' : ''}>${_esc(cf.text || '')}</textarea>
        ${cf.err ? `<div class="lc-ev-err">${_esc(cf.err)}</div>` : ''}
        <div class="lc-edit-line">
          <button class="btn btn-sm lc-comment-cancel" data-ann="${_esc(annId)}"${cf.busy ? ' disabled' : ''}>Cancel</button>
          <button class="btn btn-sm btn-primary lc-comment-save" data-paper="${_esc(r.paperId)}" data-ann="${_esc(annId)}"${cf.busy ? ' disabled' : ''}>${cf.busy ? 'Saving…' : 'Save'}</button>
        </div>
      </div>` : '';

    // Owner-only controls: color, visibility, stance clear, comment-edit, delete.
    const ownerControls = isMine ? `
      <div class="lc-owner-row">
        <select class="lc-edit-color" data-paper="${_esc(r.paperId)}" data-ann="${_esc(annId)}">
          ${_colors.map(cc => `<option value="${_esc(cc.id)}"${cc.id === r.color_id ? ' selected' : ''}>${_esc(cc.name)}</option>`).join('')}
        </select>
        <select class="lc-edit-vis" data-paper="${_esc(r.paperId)}" data-ann="${_esc(annId)}">
          <option value="lab"${r.visibility === 'lab' ? ' selected' : ''}>Lab</option>
          <option value="private"${r.visibility === 'private' ? ' selected' : ''}>Private</option>
        </select>
        ${r.evidence_stance ? `<button class="lc-clear-stance" data-paper="${_esc(r.paperId)}" data-ann="${_esc(annId)}" title="Move back to the triage queue (unlink claims + clear stance)">Move to Information</button>` : ''}
        <button class="lc-edit-delete" data-paper="${_esc(r.paperId)}" data-ann="${_esc(annId)}" title="Delete">${ICON.svg('trash')}</button>
      </div>` : '';

    const expanded = _expandedRows.has(annId);
    const editToggleLabel = expanded ? '▾ less' : '▸ edit';
    const editPanel = expanded ? `
      <div class="lc-edit-panel">
        ${draftsRow}
        <div class="lc-edit-line">
          <button class="btn btn-sm lc-ev-open" data-paper="${_esc(r.paperId)}" data-ann="${_esc(annId)}">${ICON.svg('scale')} Evidence for a claim…</button>
          ${isMine ? `<button class="btn btn-sm lc-edit-comment" data-paper="${_esc(r.paperId)}" data-ann="${_esc(annId)}">${r.comment ? '✎ Edit comment' : '+ Comment'}</button>` : ''}
        </div>
        ${evidenceBlock}
        ${ownerControls}
      </div>` : '';

    // V3.622 — category badge: the color's NAME in the color's hue (same
    // single-source palette as the reader).
    const catBadge = `<span class="lc-cat" style="background:${color.hex}33;border:1px solid ${color.hex};">${_esc(color.name)}</span>`;

    return `
      <div class="lc-row" data-ann="${_esc(annId)}">
        <div class="lc-color-bar" style="background:${color.hex};"></div>
        <div class="lc-body">
          <div class="lc-row-head">
            <a class="lc-paper-link" href="/rm/pages/library-paper.html?id=${encodeURIComponent(r.paperId)}#ann-${encodeURIComponent(annId)}">${_esc(paperTitle.slice(0, 100))}</a>
            ${catBadge}
            <span class="lc-author-chip">${_esc(author)}</span>
            ${isPrivate ? '<span class="lc-private">' + ICON.svg('lock-closed') + ' private</span>' : ''}
            ${stanceBadge}
            <span class="lc-row-meta">${pageNum ? 'p.' + pageNum + ' · ' : ''}${_esc(dateStr)}</span>
            <button class="lc-edit-toggle" data-paper="${_esc(r.paperId)}" data-ann="${_esc(annId)}" title="Categorize: drafts / evidence / edit">${editToggleLabel}</button>
          </div>
          ${truncQ ? `<div class="lc-quote">${_esc(truncQ)}</div>` : ''}
          ${r.comment && !cf ? `<div class="lc-comment">${_esc(r.comment)}</div>` : ''}
          ${commentEditor}
          ${tagChips ? `<div class="lc-paper-tags">${tagChips}</div>` : ''}
          ${editPanel}
        </div>
      </div>
    `;
  }

  function _render() {
    const filtered = _applyFilters(_annotations);
    const total = _annotations.length;
    // Wire edit controls after every render — _renderRows replaces innerHTML,
    // so prior listeners are gone.
    setTimeout(_wireRowControls, 0);
    let status = `${filtered.length} of ${total} annotation${total === 1 ? '' : 's'}`;
    if (_annotationsLoadError) {
      status += ` · ${_annotationsLoadError}`;
    } else if (_claimsLoadError) {
      status += ` · claims-bridge error: ${_claimsLoadError}`;
    } else if (_filters.paper_id) {
      status += ` · ${_claimToDraft.size} claims indexed`;
    } else if (total === 0) {
      status += ` · check console for [library-comments] log lines`;
    }
    _setStatus(status);

    // When a draft is picked but no annotations match, log enough
    // diagnostic info to figure out where the bridge breaks.
    if (_filters.paper_id && filtered.length === 0 && total > 0) {
      const taggedAnns = _annotations.filter(r =>
        Array.isArray(r.evidence_for_claim_ids) && r.evidence_for_claim_ids.length
      );
      const evClaimIds = new Set();
      taggedAnns.forEach(r => r.evidence_for_claim_ids.forEach(cid => evClaimIds.add(cid)));
      const knownClaims = Array.from(evClaimIds).map(cid => ({
        claimId: cid,
        draftId: _claimToDraft.get(cid) || '(not in bridge)',
      }));
      console.log(
        '[library-comments] draft filter active but no annotations match.',
        '\n  selected draft:', _filters.paper_id,
        '\n  annotations with evidence_for_claim_ids set:', taggedAnns.length,
        '\n  claim ids referenced by those annotations:', knownClaims,
        '\n  total claims in bridge:', _claimToDraft.size,
      );
    }

    // Paper picker is populated from the FULL annotation set so the user
    // can switch to a paper that's currently filtered out by other facets.
    _renderPaperPicker(_annotations);
    _renderAuthorPicker(_annotations);
    _renderColorPicker();
    _renderRows(filtered);
  }

  // ---- Wiring ----

  // ---- Inline edit ------------------------------------------------------

  function _findRow(paperId, annId) {
    return _annotations.find(r => r.paperId === paperId && r.__id === annId) || null;
  }

  function _replaceRow(paperId, annId, patch) {
    const row = _findRow(paperId, annId);
    if (!row) return;
    Object.assign(row, patch);
    _render();
  }

  async function _onUpdateField(paperId, annId, patch) {
    if (!window.ANNOTATION_SYNC) {
      alert('annotation-sync not loaded');
      return;
    }
    try {
      await window.ANNOTATION_SYNC.update(paperId, annId, patch);
      _replaceRow(paperId, annId, patch);
    } catch (e) {
      alert(`Update failed: ${e.message || e}`);
    }
  }

  async function _onDeleteRow(paperId, annId) {
    if (!confirm('Delete this annotation? This cannot be undone.')) return;
    try {
      await window.ANNOTATION_SYNC.remove(paperId, annId);
      _annotations = _annotations.filter(r => !(r.paperId === paperId && r.__id === annId));
      _render();
    } catch (e) {
      alert(`Delete failed: ${e.message || e}`);
    }
  }

  function _wireRowControls() {
    const host = _$('lc-rows');
    if (!host) return;

    // V3.622 — remember per-paper section open/closed across live
    // re-renders (a snapshot landing used to reset every <details>).
    host.querySelectorAll('.lc-paper-group').forEach(det => {
      det.addEventListener('toggle', () => {
        _groupToggles.set(det.dataset.groupKey, det.open);
      });
    });

    // Edit-panel expand toggle.
    host.querySelectorAll('.lc-edit-toggle').forEach(btn => {
      btn.addEventListener('click', () => {
        const id = btn.dataset.ann;
        if (_expandedRows.has(id)) _expandedRows.delete(id);
        else _expandedRows.add(id);
        _render();
      });
    });

    // Drafts dropdown — add a new draft (anyone authenticated).
    host.querySelectorAll('.lc-draft-add').forEach(sel => {
      sel.addEventListener('change', async () => {
        const draftId = sel.value;
        if (!draftId) return;
        const { paper, ann } = sel.dataset;
        const row = _findRow(paper, ann);
        const cur = Array.isArray(row && row.cite_in_drafts) ? row.cite_in_drafts.slice() : [];
        try {
          await window.ANNOTATION_SYNC.toggleCiteInDraft(paper, ann, draftId, 'add');
          if (!cur.includes(draftId)) cur.push(draftId);
          _replaceRow(paper, ann, { cite_in_drafts: cur });
        } catch (e) {
          alert(`Could not tag draft: ${e.message}`);
        }
        sel.value = '';
      });
    });

    // Drafts chip × — remove a draft tag.
    host.querySelectorAll('.lc-draft-x').forEach(btn => {
      btn.addEventListener('click', async (ev) => {
        ev.stopPropagation();
        const { paper, ann, draft } = btn.dataset;
        const row = _findRow(paper, ann);
        const cur = Array.isArray(row && row.cite_in_drafts)
          ? row.cite_in_drafts.filter(d => d !== draft) : [];
        try {
          await window.ANNOTATION_SYNC.toggleCiteInDraft(paper, ann, draft, 'remove');
          _replaceRow(paper, ann, { cite_in_drafts: cur });
        } catch (e) {
          alert(`Could not remove draft tag: ${e.message}`);
        }
      });
    });

    // Owner-only.
    host.querySelectorAll('.lc-edit-color').forEach(sel => {
      sel.addEventListener('change', () => {
        _onUpdateField(sel.dataset.paper, sel.dataset.ann, { color_id: sel.value });
      });
    });
    host.querySelectorAll('.lc-edit-vis').forEach(sel => {
      sel.addEventListener('change', () => {
        _onUpdateField(sel.dataset.paper, sel.dataset.ann, { visibility: sel.value });
      });
    });
    // V3.622 — inline comment editor (was a window.prompt). Text survives
    // live re-renders via _commentForm; save closes only on success.
    host.querySelectorAll('.lc-edit-comment').forEach(btn => {
      btn.addEventListener('click', () => {
        const { paper, ann } = btn.dataset;
        const row = _findRow(paper, ann);
        _commentForm.set(ann, { text: (row && row.comment) || '', busy: false, err: '' });
        _render();
      });
    });
    host.querySelectorAll('.lc-comment-input').forEach(ta => {
      ta.addEventListener('input', () => {
        const state = _commentForm.get(ta.dataset.ann);
        if (state) state.text = ta.value;
      });
    });
    host.querySelectorAll('.lc-comment-cancel').forEach(btn => {
      btn.addEventListener('click', () => {
        _commentForm.delete(btn.dataset.ann);
        _render();
      });
    });
    host.querySelectorAll('.lc-comment-save').forEach(btn => {
      btn.addEventListener('click', async () => {
        const { paper, ann } = btn.dataset;
        const state = _commentForm.get(ann);
        if (!state) return;
        state.busy = true; state.err = '';
        _render();
        try {
          await window.ANNOTATION_SYNC.update(paper, ann, { comment: state.text });
          _commentForm.delete(ann);
          _replaceRow(paper, ann, { comment: state.text });
        } catch (e) {
          state.busy = false;
          state.err = `Save failed: ${e.message || e}`;
          _render();
        }
      });
    });

    host.querySelectorAll('.lc-edit-delete').forEach(btn => {
      btn.addEventListener('click', () => {
        _onDeleteRow(btn.dataset.paper, btn.dataset.ann);
      });
    });
    host.querySelectorAll('.lc-clear-stance').forEach(btn => {
      btn.addEventListener('click', async () => {
        // V3.622 — "Move to Information" now unlinks BOTH sides: the claim
        // docs' evidence arrays via CLAIMS.removeEvidenceForAnnotation
        // (previously only the annotation was cleared and the claims kept
        // dangling pointers), then any leftover annotation-side state.
        const { paper, ann } = btn.dataset;
        const row = _findRow(paper, ann);
        if (row && window.CLAIMS && window.CLAIMS.removeEvidenceForAnnotation) {
          try {
            await window.CLAIMS.removeEvidenceForAnnotation(
              Object.assign({ id: ann, paperId: paper }, row));
          } catch (e) {
            console.warn('[library-comments] claim unlink failed:', e.message || e);
          }
        }
        _onUpdateField(paper, ann, {
          evidence_stance: null,
          evidence_for_claim_ids: [],
        });
      });
    });

    // ---- V3.622 evidence (claims) flow ----
    host.querySelectorAll('.lc-ev-open').forEach(btn => {
      btn.addEventListener('click', () => {
        const { ann } = btn.dataset;
        const cur = _evForm.get(ann);
        if (cur && cur.open) { _evForm.delete(ann); _render(); return; }
        const state = { open: true, draftId: (_drafts[0] && _drafts[0].id) || '', claims: null, claimId: '', stance: 'for', busy: false, err: '', newStmt: '' };
        _evForm.set(ann, state);
        _loadEvClaims(ann);
        _render();
      });
    });
    host.querySelectorAll('.lc-ev-cancel').forEach(btn => {
      btn.addEventListener('click', () => {
        _evForm.delete(btn.dataset.ann);
        _render();
      });
    });
    host.querySelectorAll('.lc-ev-draft').forEach(sel => {
      sel.addEventListener('change', () => {
        const state = _evForm.get(sel.dataset.ann);
        if (!state) return;
        state.draftId = sel.value;
        state.claims = null;
        state.claimId = '';
        state.err = '';
        _loadEvClaims(sel.dataset.ann);
        _render();
      });
    });
    host.querySelectorAll('input[name^="lc-claim-"]').forEach(input => {
      input.addEventListener('change', () => {
        const state = _evForm.get(input.dataset.ann);
        if (!state) return;
        state.claimId = input.value;
        state.err = '';
        _render();
      });
    });
    host.querySelectorAll('input[name^="lc-stance-"]').forEach(input => {
      input.addEventListener('change', () => {
        const state = _evForm.get(input.dataset.ann);
        if (state) state.stance = input.value;
      });
    });
    host.querySelectorAll('.lc-ev-newclaim').forEach(input => {
      input.addEventListener('input', () => {
        const state = _evForm.get(input.dataset.ann);
        if (state) state.newStmt = input.value;
      });
    });
    host.querySelectorAll('.lc-ev-newclaim-btn').forEach(btn => {
      btn.addEventListener('click', async () => {
        const { ann } = btn.dataset;
        const state = _evForm.get(ann);
        if (!state) return;
        const stmt = (state.newStmt || '').trim();
        if (!stmt) { state.err = 'Type a claim statement first.'; _render(); return; }
        if (!window.CLAIMS) { state.err = 'CLAIMS module missing.'; _render(); return; }
        state.busy = true; state.err = '';
        _render();
        try {
          const newId = await window.CLAIMS.create(state.draftId, { statement: stmt });
          state.claims = await _loadClaimsForDraft(state.draftId);
          state.claimId = newId;
          state.newStmt = '';
        } catch (e) {
          state.err = `Create failed: ${e.message || e}`;
        }
        state.busy = false;
        _render();
      });
    });
    host.querySelectorAll('.lc-ev-save').forEach(btn => {
      btn.addEventListener('click', async () => {
        const { paper, ann } = btn.dataset;
        const state = _evForm.get(ann);
        if (!state || !state.draftId || !state.claimId || !state.stance) return;
        if (!window.CLAIMS) { alert('CLAIMS module missing.'); return; }
        state.busy = true; state.err = '';
        _render();
        try {
          await window.CLAIMS.addEvidence(state.draftId, state.claimId, paper, ann, state.stance);
          // Auto-link the draft to the source paper so the reader's
          // "Used in paper drafts" pills accrue (V3.475 behavior).
          if (window.LIBRARY_LINKS && window.LIBRARY_LINKS.toggleDraftLink) {
            try { await window.LIBRARY_LINKS.toggleDraftLink(paper, state.draftId, true); }
            catch (_) { /* non-fatal */ }
          }
          _evForm.delete(ann);
          const row = _findRow(paper, ann);
          const claimIds = Array.isArray(row && row.evidence_for_claim_ids) ? row.evidence_for_claim_ids.slice() : [];
          if (!claimIds.includes(state.claimId)) claimIds.push(state.claimId);
          const cited = Array.isArray(row && row.cite_in_drafts) ? row.cite_in_drafts.slice() : [];
          if (!cited.includes(state.draftId)) cited.push(state.draftId);
          _replaceRow(paper, ann, {
            evidence_for_claim_ids: claimIds,
            evidence_stance: state.stance,
            cite_in_drafts: cited,
          });
        } catch (e) {
          state.busy = false;
          state.err = `Tag failed: ${e.message || e}`;
          _render();
        }
      });
    });
  }

  /* V3.622 — lazy claims loader for the evidence form. */
  function _loadClaimsForDraft(draftId) {
    if (!draftId || typeof firebase === 'undefined' || !firebase.firestore) return Promise.resolve([]);
    return firebase.firestore()
      .collection('drafts').doc(draftId).collection('claims').get()
      .then(snap => {
        const out = [];
        snap.forEach(doc => out.push(Object.assign({ id: doc.id }, doc.data())));
        out.sort((a, b) => {
          const ta = a.created && a.created.toMillis ? a.created.toMillis() : 0;
          const tb = b.created && b.created.toMillis ? b.created.toMillis() : 0;
          return ta - tb;
        });
        return out;
      });
  }

  async function _loadEvClaims(annId) {
    const state = _evForm.get(annId);
    if (!state || !state.draftId) return;
    const forDraft = state.draftId;
    try {
      const claims = await _loadClaimsForDraft(forDraft);
      const cur = _evForm.get(annId);
      if (!cur || cur.draftId !== forDraft) return;
      cur.claims = claims;
    } catch (e) {
      const cur = _evForm.get(annId);
      if (cur) { cur.claims = []; cur.err = `Could not load claims: ${e.message || e}`; }
    }
    _render();
  }

  function _wireFilters() {
    _$('lc-paper').addEventListener('change', () => {
      _filters.paper_id = _$('lc-paper').value;
      _render();
    });
    _$('lc-search').addEventListener('input', _debounce(() => {
      _filters.search = _$('lc-search').value;
      _render();
    }, 150));
    _$('lc-tag').addEventListener('input', _debounce(() => {
      _filters.tag = _$('lc-tag').value;
      _render();
    }, 150));
    _$('lc-stance').addEventListener('change', () => {
      _filters.stance = _$('lc-stance').value;
      _render();
    });
    _$('lc-from').addEventListener('change', () => {
      _filters.from = _$('lc-from').value;
      _render();
    });
    _$('lc-to').addEventListener('change', () => {
      _filters.to = _$('lc-to').value;
      _render();
    });
    _$('lc-has-comment').addEventListener('change', () => {
      _filters.has_comment = _$('lc-has-comment').checked;
      _render();
    });

    _$('lc-authors').addEventListener('click', (e) => {
      const pill = e.target.closest('[data-author]');
      if (!pill) return;
      const uid = pill.getAttribute('data-author');
      if (_filters.authors.has(uid)) _filters.authors.delete(uid);
      else _filters.authors.add(uid);
      _render();
    });
    _$('lc-colors').addEventListener('click', (e) => {
      const pill = e.target.closest('[data-color]');
      if (!pill) return;
      const id = pill.getAttribute('data-color');
      if (_filters.colors.has(id)) _filters.colors.delete(id);
      else _filters.colors.add(id);
      _render();
    });

    // Click a paper-tag chip → push it into the tag filter.
    _$('lc-rows').addEventListener('click', (e) => {
      const chip = e.target.closest('[data-tag]');
      if (!chip) return;
      e.preventDefault();
      _filters.tag = chip.getAttribute('data-tag');
      _$('lc-tag').value = _filters.tag;
      _render();
    });
  }

  function _debounce(fn, ms) {
    let t;
    return (...args) => { clearTimeout(t); t = setTimeout(() => fn(...args), ms); };
  }

  function _updateAuthHint() {
    const hint = _$('lc-auth-hint');
    if (!hint) return;
    const authed = !!(typeof firebase !== 'undefined' && firebase.auth && firebase.auth().currentUser);
    hint.style.display = authed ? 'none' : 'block';
  }

  // ---- Init ----

  async function init() {
    _wireFilters();
    // Honor ?paper=<id> in the URL so the page can deep-link to a single
    // paper's feed (e.g. from the library card or shared with a colleague).
    try {
      const params = new URLSearchParams(window.location.search);
      const paper = params.get('paper');
      if (paper) _filters.paper_id = paper;
    } catch (_) { /* ignore */ }

    _setStatus('Loading items.json…');
    await _loadPapers();
    await _loadColors();
    _updateAuthHint();
    // Populate the paper picker now (no annotations yet → counts will be 0,
    // but the dropdown is usable immediately, before auth resolves).
    _render();

    // Wait for auth, then fetch annotations.
    const start = async (user) => {
      _updateAuthHint();
      if (!user) {
        _setStatus('Sign in to load annotations.');
        return;
      }
      _currentUid = user.uid;

      // V3.620 — ANNOTATION_GROUPS subscription removed with the group
      // dropdown (the field was write-only; this subscription also leaked a
      // callback per auth event since the unsubscribe was discarded).

      if (_busy) return;
      _busy = true;
      try {
        _setStatus('Attaching live annotation listeners…');
        // Phase C: live sync per-paper. _attachAnnotationListeners returns
        // immediately after wiring; the first onSnapshot fire populates the
        // feed (debounced render). Claims-bridge runs in parallel since it's
        // a separate one-shot read.
        await Promise.all([
          _attachAnnotationListeners(),
          _loadClaims(),
        ]);
        // Don't call _render() here — debounced render will fire after the
        // first batch of onSnapshot callbacks lands (~150ms).
      } catch (e) {
        console.error('[library-comments] load failed:', e);
        _setStatus(`Error: ${e.message || e}`);
      } finally {
        _busy = false;
      }
    };

    // Detach all annotation listeners on page nav so we don't leak Firestore
    // WebChannel slots. The api-firestore-adapter's beforeunload also fires
    // detachAll() for adapter-tracked listeners; these are direct Firestore
    // listeners outside the adapter, so we wire our own beforeunload.
    window.addEventListener('beforeunload', _detachAnnotationListeners);

    // Use firebase.auth().onAuthStateChanged directly so we know when
    // auth has actually resolved (firebridge.onAuth fires once with null
    // before resolution — we'd duplicate-load).
    if (typeof firebase !== 'undefined' && firebase.auth) {
      firebase.auth().onAuthStateChanged(start);
    }
  }

  document.addEventListener('DOMContentLoaded', init);
})();
