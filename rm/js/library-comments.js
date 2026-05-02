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
  let _groups = [{ id: 'general', name: 'General' }];
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

  async function _loadPapers() {
    try {
      const data = await api.load('items.json');
      const items = (data && data.items) || [];
      _papersById = new Map();
      _drafts = [];
      // Include every paper item (library entries AND lab drafts) — both
      // can host annotations, so both are valid picks for the feed.
      for (const it of items) {
        if (it.type !== 'paper') continue;
        _papersById.set(it.id, it);
        // Drafts are papers we're writing (not library entries) — used in
        // the per-card Drafts pill row so users can re-tag from this page.
        const lib = (it.meta || {}).library || {};
        if (!lib.is_library_entry) {
          _drafts.push({ id: it.id, title: it.title || it.id });
        }
      }
    } catch (e) {
      console.warn('[library-comments] could not load items.json:', e.message);
    }
  }

  // A paper is a draft (paper "we are writing") iff it does NOT carry the
  // is_library_entry flag. Library entries (papers we're reading) get
  // hidden from the draft picker.
  function _isDraft(paper) {
    if (!paper || paper.type !== 'paper') return false;
    const lib = (paper.meta || {}).library || {};
    return !lib.is_library_entry;
  }

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
    const drafts = Array.from(_papersById.values()).filter(_isDraft);
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

  async function _loadColors() {
    try {
      const data = await api.load('library/highlight_colors.json');
      _colors = (data && data.colors) || [];
    } catch (e) {
      console.warn('[library-comments] could not load highlight_colors.json:', e.message);
      _colors = [];
    }
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

    for (const p of papers) {
      const col = db.collection('papers').doc(p.id).collection('annotations');
      try {
        const u1 = col.where('visibility', '==', 'lab').onSnapshot(
          (snap) => _absorbSnap(snap, p.id),
          (err) => failures.push(`${p.id} lab: ${err.message || err}`)
        );
        _annUnsubs.push(u1);
      } catch (e) { failures.push(`${p.id} lab: ${e.message || e}`); }
      try {
        const u2 = col.where('creator.uid', '==', user.uid).onSnapshot(
          (snap) => _absorbSnap(snap, p.id),
          (err) => failures.push(`${p.id} mine: ${err.message || err}`)
        );
        _annUnsubs.push(u2);
      } catch (e) { failures.push(`${p.id} mine: ${e.message || e}`); }
    }

    if (failures.length) {
      _annotationsLoadError = `${failures.length} subqueries failed: ${failures[0]}`;
      console.warn('[library-comments] annotation listener attach failures:', failures);
    } else {
      _annotationsLoadError = '';
    }
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

    const drafts = Array.from(_papersById.values())
      .filter(_isDraft)
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

  function _renderRows(rows) {
    const host = _$('lc-rows');
    if (!host) return;
    if (!rows.length) {
      host.innerHTML = '<div class="lc-empty">No annotations match the current filters.</div>';
      return;
    }
    const evidence = rows.filter(_isEvidence);
    const info = rows.filter(r => !_isEvidence(r));
    let html = '';
    if (evidence.length) {
      html += `<div class="lc-section-head"><span class="lc-section-tag lc-section-evidence">Evidence</span> <span class="lc-section-count">${evidence.length} annotation${evidence.length === 1 ? '' : 's'}</span></div>`;
      html += evidence.map(_renderRow).join('');
    }
    if (info.length) {
      html += `<div class="lc-section-head"><span class="lc-section-tag lc-section-info">Information</span> <span class="lc-section-count">${info.length} annotation${info.length === 1 ? '' : 's'}</span></div>`;
      html += info.map(_renderRow).join('');
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

    // Group dropdown.
    const groupCur = r.group || 'general';
    const hasCur = _groups.some(g => g.id === groupCur);
    const groupRow = `
      <div class="lc-edit-line">
        <span class="lc-edit-label">Group</span>
        <select class="lc-edit-group" data-paper="${_esc(r.paperId)}" data-ann="${_esc(r.__id || '')}">
          ${_groups.map(g => `<option value="${_esc(g.id)}"${g.id === groupCur ? ' selected' : ''}>${_esc(g.name || g.id)}</option>`).join('')}
          ${hasCur ? '' : `<option value="${_esc(groupCur)}" selected>${_esc(groupCur)} (legacy)</option>`}
          <option value="__new__">+ New group…</option>
        </select>
      </div>`;

    // Owner-only controls: color, visibility, stance clear, comment-edit, delete.
    const ownerControls = isMine ? `
      <div class="lc-owner-row">
        <select class="lc-edit-color" data-paper="${_esc(r.paperId)}" data-ann="${_esc(r.__id || '')}">
          ${_colors.map(cc => `<option value="${_esc(cc.id)}"${cc.id === r.color_id ? ' selected' : ''}>${_esc(cc.name)}</option>`).join('')}
        </select>
        <select class="lc-edit-vis" data-paper="${_esc(r.paperId)}" data-ann="${_esc(r.__id || '')}">
          <option value="lab"${r.visibility === 'lab' ? ' selected' : ''}>Lab</option>
          <option value="private"${r.visibility === 'private' ? ' selected' : ''}>Private</option>
        </select>
        ${r.evidence_stance ? `<button class="lc-clear-stance" data-paper="${_esc(r.paperId)}" data-ann="${_esc(r.__id || '')}" title="Move to Information (clear stance + claim links)">Move to Information</button>` : ''}
        <button class="lc-edit-comment" data-paper="${_esc(r.paperId)}" data-ann="${_esc(r.__id || '')}">${r.comment ? 'Edit comment' : '+ Comment'}</button>
        <button class="lc-edit-delete" data-paper="${_esc(r.paperId)}" data-ann="${_esc(r.__id || '')}" title="Delete">🗑</button>
      </div>` : '';

    const annId = r.__id || '';
    const expanded = _expandedRows.has(annId);
    const editToggleLabel = expanded ? '▾ less' : '▸ edit';
    const editPanel = expanded ? `
      <div class="lc-edit-panel">
        ${draftsRow}
        ${groupRow}
        ${ownerControls}
      </div>` : '';

    return `
      <div class="lc-row" data-ann="${_esc(annId)}">
        <div class="lc-color-bar" style="background:${color.hex};"></div>
        <div class="lc-body">
          <div class="lc-row-head">
            <a class="lc-paper-link" href="/rm/pages/library-paper.html?id=${encodeURIComponent(r.paperId)}#ann=${encodeURIComponent(annId)}">${_esc(paperTitle.slice(0, 100))}</a>
            <span class="lc-author-chip">${_esc(author)}</span>
            ${isPrivate ? '<span class="lc-private">🔒 private</span>' : ''}
            ${stanceBadge}
            <span class="lc-row-meta">${pageNum ? 'p.' + pageNum + ' · ' : ''}${_esc(dateStr)}</span>
            <button class="lc-edit-toggle" data-paper="${_esc(r.paperId)}" data-ann="${_esc(annId)}" title="Show drafts / group / edit controls">${editToggleLabel}</button>
          </div>
          ${truncQ ? `<div class="lc-quote">${_esc(truncQ)}</div>` : ''}
          ${r.comment ? `<div class="lc-comment">${_esc(r.comment)}</div>` : ''}
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

    // Group dropdown (anyone, includes "+ New group…" option).
    host.querySelectorAll('.lc-edit-group').forEach(sel => {
      sel.addEventListener('change', async () => {
        const { paper, ann } = sel.dataset;
        if (sel.value === '__new__') {
          const row = _findRow(paper, ann);
          sel.value = (row && row.group) || 'general';
          const name = window.prompt('New group name (e.g. "method", "open question"):');
          if (!name || !name.trim()) return;
          if (!window.ANNOTATION_GROUPS) {
            alert('annotation-groups module missing');
            return;
          }
          try {
            const id = await window.ANNOTATION_GROUPS.create(name.trim());
            _onUpdateField(paper, ann, { group: id });
          } catch (e) {
            alert(`Could not create group: ${e.message}`);
          }
          return;
        }
        _onUpdateField(paper, ann, { group: sel.value });
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
    host.querySelectorAll('.lc-edit-comment').forEach(btn => {
      btn.addEventListener('click', () => {
        const { paper, ann } = btn.dataset;
        const row = _findRow(paper, ann);
        const cur = (row && row.comment) || '';
        const next = window.prompt('Comment (leave blank to clear):', cur);
        if (next === null) return;
        _onUpdateField(paper, ann, { comment: next });
      });
    });
    host.querySelectorAll('.lc-edit-delete').forEach(btn => {
      btn.addEventListener('click', () => {
        _onDeleteRow(btn.dataset.paper, btn.dataset.ann);
      });
    });
    host.querySelectorAll('.lc-clear-stance').forEach(btn => {
      btn.addEventListener('click', () => {
        // "Move to Information" — clears stance and removes all claim links
        // (the claim docs keep their evidence pointers; that drift is a
        // known limitation; cleaning both sides requires a transaction).
        _onUpdateField(btn.dataset.paper, btn.dataset.ann, {
          evidence_stance: null,
          evidence_for_claim_ids: [],
        });
      });
    });
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

      // Subscribe to lab-shared groups so the per-card dropdowns update
      // live when anyone adds a new group.
      if (window.ANNOTATION_GROUPS) {
        try { await window.ANNOTATION_GROUPS.ensureSeed(); }
        catch (e) { console.warn('[library-comments] ensureSeed failed:', e.message); }
        window.ANNOTATION_GROUPS.subscribe((g) => {
          _groups = g.slice();
          _render();
        });
      }

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
