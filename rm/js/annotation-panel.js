/* annotation-panel.js — sidebar list of annotations + filter chips +
 * per-annotation comment / draft-filing / evidence controls.
 *
 * V3.620 panel diet: a card is quote → comment → draft chips → footer
 * (Jump to · Comment · ⋯). "Tag as information" and the group picker are
 * gone (the group field was write-only — nothing ever read it; the real
 * "groups" concept is PAPER-level library groups, V3.622). V3.622: the
 * claims/evidence flow moved to Library → Comments (the categorization
 * workspace) — the reader is quick capture only. Mutating controls render
 * only when `canWrite`, mirroring firestore.rules instead of alerting on
 * a doomed click.
 *
 * Public API (window.ANNOTATION_PANEL):
 *   init({rootEl, viewer, getColors, onFocus, onUpdate, onDelete,
 *         canWrite, currentUserUid, defaultVisibility,
 *         onVisibilityDefaultChange, getDrafts, onCiteToggle})
 *   setAnnotations(list)      — replace data; re-render
 *   getFilterFn()             — returns a fn(ann)→bool that respects current filters
 *   onFilterChange(cb)        — invoked whenever filter state changes
 *   getDefaultVisibility() / focusCard(annId)
 *
 * Filters are stored in URL search params (author, color, stance) and
 * mirrored to localStorage so each user retains their last view.
 */
(function () {
  let _root = null;
  let _viewer = null;
  let _annotations = [];
  let _getColors = () => [];
  let _currentUid = '';
  let _canWrite = true;           // V3.620 — host passes _canAnnotate
  let _onFocus = null;
  let _onUpdate = null;
  let _getDrafts = null;          // () → [{id, title}, ...]
  let _onCiteToggle = null;       // (annId, draftId, on:boolean) → ...
  let _expandedCards = new Set(); // ann.id of cards whose "⋯" edit panel is open
  // Per-card form state lives in these Maps so an in-progress edit
  // survives the full re-renders that every Firestore snapshot triggers
  // (V3.620 — a teammate's highlight used to eat your half-typed comment).
  let _cardSection = new Map();   // annId → 'comment' | null
  let _commentForm = new Map();   // annId → { text, busy, err }
  let _onDelete = null;
  let _onVisibilityDefaultChange = null;
  let _defaultVisibility = 'lab';
  let _filters = { authors: null, colors: null, stance: null, onlyMine: false };
  let _filterCallbacks = [];

  // ---- Utility -----------------------------------------------------------

  function _esc(s) {
    return String(s ?? '').replace(/[&<>"']/g, c =>
      ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c])
    );
  }

  function _color(id) {
    // Same resolution + fallback as the page overlay (annotation-colors.js
    // is THE palette) so a card's accent can never disagree with its rect.
    return _getColors().find(c => c.id === id)
      || (window.ANNOTATION_COLORS && window.ANNOTATION_COLORS.byId(id))
      || { hex: '#facc15', name: 'Note' };
  }

  function _firstQuote(ann) {
    const pages = (ann.target && ann.target.pages) || [];
    for (const p of pages) {
      if (p.selectors && p.selectors.textQuote && p.selectors.textQuote.exact) {
        return p.selectors.textQuote.exact;
      }
    }
    return '';
  }

  function _displayName(ann) {
    return (ann.creator && (ann.creator.displayName || ann.creator.email)) || 'Anon';
  }

  function _initials(label) {
    const s = (label || '?').replace(/@.*/, '').split(/[\s._-]+/).filter(Boolean);
    if (s.length >= 2) return (s[0][0] + s[1][0]).toUpperCase();
    return (label || '?').slice(0, 2).toUpperCase();
  }

  // ---- Filter state ------------------------------------------------------

  function _readFiltersFromUrl() {
    const url = new URL(window.location.href);
    const authors = url.searchParams.get('author');
    const colors = url.searchParams.get('color');
    const stance = url.searchParams.get('stance');
    const mine = url.searchParams.get('mine') === '1';
    return {
      authors: authors ? authors.split(',').filter(Boolean) : null,
      colors: colors ? colors.split(',').filter(Boolean) : null,
      stance: stance ? stance.split(',').filter(Boolean) : null,
      onlyMine: mine,
    };
  }

  function _writeFiltersToUrl() {
    const url = new URL(window.location.href);
    function set(key, val) {
      if (val && val.length) url.searchParams.set(key, Array.isArray(val) ? val.join(',') : val);
      else url.searchParams.delete(key);
    }
    set('author', _filters.authors);
    set('color', _filters.colors);
    set('stance', _filters.stance);
    if (_filters.onlyMine) url.searchParams.set('mine', '1');
    else url.searchParams.delete('mine');
    history.replaceState(null, '', url.toString());
    try {
      localStorage.setItem('rm_lib_filters', JSON.stringify(_filters));
    } catch (_) { /* ignore quota */ }
  }

  function _readFiltersFromStorage() {
    try {
      const raw = localStorage.getItem('rm_lib_filters');
      if (raw) return JSON.parse(raw);
    } catch (_) { /* ignore */ }
    return null;
  }

  function getFilterFn() {
    return (ann) => {
      if (_filters.onlyMine && ann.creator && ann.creator.uid !== _currentUid) return false;
      if (_filters.authors && _filters.authors.length) {
        const uid = ann.creator && ann.creator.uid;
        if (!_filters.authors.includes(uid)) return false;
      }
      if (_filters.colors && _filters.colors.length) {
        if (!_filters.colors.includes(ann.color_id)) return false;
      }
      if (_filters.stance && _filters.stance.length) {
        if (!_filters.stance.includes(ann.evidence_stance || 'none')) return false;
      }
      return true;
    };
  }

  function onFilterChange(cb) { _filterCallbacks.push(cb); }
  function _emitFilterChange() {
    _writeFiltersToUrl();
    for (const cb of _filterCallbacks) {
      try { cb(getFilterFn()); } catch (e) { console.error(e); }
    }
  }

  // ---- Render ------------------------------------------------------------

  function _renderHeader() {
    const colors = _getColors();
    const authorMap = new Map();
    for (const a of _annotations) {
      const uid = a.creator && a.creator.uid;
      if (!uid) continue;
      if (!authorMap.has(uid)) {
        authorMap.set(uid, _displayName(a));
      }
    }

    const colorChips = colors.map(c => {
      const active = !_filters.colors || _filters.colors.includes(c.id);
      return `<button class="ann-chip ann-chip-color${active ? ' active' : ''}" data-color="${_esc(c.id)}" style="background:${_esc(c.hex)}66;border-color:${_esc(c.hex)};" title="${_esc(c.name)} — ${_esc(c.meaning)}">${_esc(c.name)}</button>`;
    }).join('');

    const authorChips = Array.from(authorMap.entries()).map(([uid, name]) => {
      const active = !_filters.authors || _filters.authors.includes(uid);
      return `<button class="ann-chip ann-chip-author${active ? ' active' : ''}" data-uid="${_esc(uid)}" title="${_esc(name)}">${_esc(_initials(name))}</button>`;
    }).join('');

    const stanceChips = `
      <button class="ann-chip ann-chip-stance${(!_filters.stance || _filters.stance.includes('for')) ? ' active' : ''}" data-stance="for" title="Evidence supporting a claim">For</button>
      <button class="ann-chip ann-chip-stance${(!_filters.stance || _filters.stance.includes('against')) ? ' active' : ''}" data-stance="against" title="Counter-evidence">Against</button>
      <button class="ann-chip ann-chip-stance${(!_filters.stance || _filters.stance.includes('none')) ? ' active' : ''}" data-stance="none" title="Plain highlights (no claim link)">Plain</button>
    `;

    const visToggle = `
      <label class="ann-vis-toggle" title="Default visibility for new highlights">
        New &rarr;
        <select id="ann-default-vis">
          <option value="lab"${_defaultVisibility === 'lab' ? ' selected' : ''}>Lab</option>
          <option value="private"${_defaultVisibility === 'private' ? ' selected' : ''}>Private</option>
        </select>
      </label>
    `;

    return `
      <div class="ann-panel-header">
        <div class="ann-filter-row">
          <span class="ann-filter-label">Authors</span>
          <div class="ann-chips">${authorChips || '<span class="ann-empty">no annotators yet</span>'}</div>
        </div>
        <div class="ann-filter-row">
          <span class="ann-filter-label">Colors</span>
          <div class="ann-chips">${colorChips}</div>
        </div>
        <div class="ann-filter-row">
          <span class="ann-filter-label">Stance</span>
          <div class="ann-chips">${stanceChips}</div>
        </div>
        <div class="ann-filter-row ann-filter-row-bottom">
          <label class="ann-only-mine"><input type="checkbox" id="ann-only-mine"${_filters.onlyMine ? ' checked' : ''}> Only mine</label>
          ${visToggle}
        </div>
      </div>
    `;
  }

  function _renderAnnotation(ann) {
    const c = _color(ann.color_id);
    const isMine = ann.creator && ann.creator.uid === _currentUid;
    const dn = _displayName(ann);
    const pages = (ann.target && ann.target.pages) || [];
    const pageLabel = pages.length ? `p.${pages.map(p => p.page).join(',')}` : '';
    const quote = _firstQuote(ann);
    const evCount = (ann.evidence_for_claim_ids || []).length;
    const stanceBadge = ann.evidence_stance
      ? `<span class="ann-stance ann-stance-${_esc(ann.evidence_stance)}" title="Evidence ${_esc(ann.evidence_stance)} ${evCount} claim${evCount === 1 ? '' : 's'}">${_esc(ann.evidence_stance)}${evCount > 1 ? ` ×${evCount}` : ''}</span>` : '';
    const investigateBadge = ann.marked_for_investigation
      ? '<span class="ann-investigate" title="Marked for further investigation">' + ICON.svg('flag') + '</span>' : '';
    const visBadge = ann.visibility === 'private'
      ? '<span class="ann-vis ann-vis-private" title="Only you can see this">' + ICON.svg('lock-closed') + '</span>'
      : '<span class="ann-vis ann-vis-lab" title="Visible to the whole lab">' + ICON.svg('users') + '</span>';

    // Category badge — color IS the category (V3.619/620); same hue as the
    // page rect so the panel and the page can never disagree.
    const catBadge = `<span class="ann-cat" style="background:${_esc(c.hex)}33;border-color:${_esc(c.hex)};">${_esc(c.name)}</span>`;

    // ---- Drafts: inline on EVERY card (V3.620 — this is the workflow's
    // point, it was buried inside "Tag as information"). Chips for tagged +
    // a dropdown to add more.
    // V3.629 — comment corrected: `_getDrafts()` does NOT return only linked
    // drafts. Since V3.475 the host passes a SHORTLIST of every active draft
    // in the lab with the linked ones floated to the top (library-paper.js
    // _draftShortlist), so this dropdown can file a highlight into a draft
    // the paper isn't linked to. That's now safe — the host's onCiteToggle
    // links the paper on the way (V3.629 _ensureDraftLinked), because
    // otherwise the evidence never reached the builder's Evidence Inbox and
    // an engaged draft lens could hide the highlight. The "＋ Link another
    // draft…" option still opens PAPER_OVERLAYS.openLinkPicker for linking
    // the paper explicitly, without filing this highlight.
    const cited = Array.isArray(ann.cite_in_drafts) ? ann.cite_in_drafts : [];
    const drafts = (_getDrafts && _getDrafts()) || [];
    const taggedDrafts = drafts.filter(d => cited.includes(d.id));
    const untaggedDrafts = drafts.filter(d => !cited.includes(d.id));
    /* V3.628 — ONE control, not two. This row used to carry a "+ add draft…"
     * <select> AND a "+ Link draft…" button side by side, visually identical
     * but doing different things (file THIS highlight vs. link a draft to
     * the PAPER so it becomes offerable). The link action is now the last
     * option inside the same dropdown. */
    const canLink = _canWrite && window.PAPER_OVERLAYS && window.PAPER_OVERLAYS.openLinkPicker;
    const draftsBlock = `
      <div class="ann-edit-row ann-drafts-inline" title="Drafts this highlight feeds into (cite_in_drafts)">
        <span class="ann-tiny-label">Drafts</span>
        <div class="ann-draft-chips">
          ${taggedDrafts.map(d => `
            <span class="ann-draft-chip">${_esc((d.title || d.id).slice(0, 24))}${(d.title || d.id).length > 24 ? '…' : ''}${_canWrite ? `<button class="ann-draft-x" data-id="${_esc(ann.id)}" data-draft="${_esc(d.id)}" title="Remove">${ICON.svg('x-mark')}</button>` : ''}</span>
          `).join('') || (drafts.length ? '<span class="ann-empty">none</span>' : '<span class="ann-empty">no drafts in the lab yet</span>')}
        </div>
        ${_canWrite ? `
          <select class="ann-draft-add" data-id="${_esc(ann.id)}">
            <option value="">${untaggedDrafts.length ? '+ file to draft…' : '+ draft…'}</option>
            ${untaggedDrafts.map(d => `<option value="${_esc(d.id)}">${_esc((d.title || d.id).slice(0, 60))}</option>`).join('')}
            ${canLink ? `<option value="__link__">${ICON.svg('plus')} Link another draft to this paper…</option>` : ''}
          </select>` : ''}
      </div>`;

    const ownerActions = (isMine && _canWrite) ? `
      <div class="ann-row-actions">
        <select class="ann-row-color" data-id="${_esc(ann.id)}">
          ${_getColors().map(cc => `<option value="${_esc(cc.id)}"${cc.id === ann.color_id ? ' selected' : ''}>${_esc(cc.name)}</option>`).join('')}
        </select>
        <select class="ann-row-vis" data-id="${_esc(ann.id)}">
          <option value="lab"${ann.visibility === 'lab' ? ' selected' : ''}>Lab</option>
          <option value="private"${ann.visibility === 'private' ? ' selected' : ''}>Private</option>
        </select>
        <button class="ann-row-investigate${ann.marked_for_investigation ? ' active' : ''}" data-id="${_esc(ann.id)}" title="Mark for investigation">⚑</button>
        <button class="ann-row-delete" data-id="${_esc(ann.id)}" title="Delete">${ICON.svg('trash')}</button>
      </div>` : '';

    // Inline action panels (replace prompts/modals with expansions).
    const section = _cardSection.get(ann.id) || null;
    const sectionPanel = section ? _renderSectionPanel(ann, section, drafts) : '';

    // The "⋯" edit panel — owner controls. V3.622: the claims/evidence
    // flow moved to the Library → Comments categorization workspace (the
    // reader is for quick capture: color + note + draft chips).
    const expanded = _expandedCards.has(ann.id);
    const editToggleLabel = expanded ? '▾ less' : '⋯';
    const evidenceLink = _isEvidence(ann)
      ? `<a class="ann-ev-link" href="/rm/pages/library.html?tab=comments" title="Claim evidence is managed on the Comments page">${ICON.svg('scale')} evidence — manage in Comments</a>`
      : '';
    const editPanel = (expanded && _canWrite) ? `
      <div class="ann-edit-panel">
        ${ownerActions}
        ${evidenceLink ? `<div class="ann-row-actions">${evidenceLink}</div>` : ''}
      </div>` : '';

    return `
      <div class="ann-card" data-id="${_esc(ann.id)}" style="border-left-color:${_esc(c.hex)}">
        <div class="ann-card-head">
          <span class="ann-avatar" title="${_esc(dn)}">${_esc(_initials(dn))}</span>
          <span class="ann-card-meta">
            <span class="ann-card-name">${_esc(dn)}</span>
            <span class="ann-card-page">${_esc(pageLabel)}</span>
            ${catBadge}
            ${visBadge}
            ${investigateBadge}
            ${stanceBadge}
          </span>
        </div>
        ${ann.kind === 'equation' ? `
          <div class="ann-eq-block">
            ${ann.name ? `<div class="ann-eq-name">${_esc(ann.name)}</div>` : ''}
            <div class="ann-eq-math" data-eq-id="${_esc(ann.id)}"></div>
            ${ann.snip_data_uri ? `<img class="ann-eq-snip" src="${_esc(ann.snip_data_uri)}" alt="Snip from the paper" title="Snipped from the page — reference for the transcription">` : ''}
            ${(isMine && _canWrite) ? `<button class="ann-eq-edit" data-id="${_esc(ann.id)}">${ICON.svg('pencil')} Transcription</button>` : ''}
          </div>` : ''}
        ${ann.kind === 'figure' ? `
          <div class="ann-eq-block">
            ${ann.name ? `<div class="ann-eq-name">${ICON.svg('photo')} ${_esc(ann.name)}</div>` : ''}
            ${(ann.image && ann.image.download_url) || ann.snip_data_uri ? `<img class="ann-eq-snip" src="${_esc((ann.image && ann.image.download_url) || ann.snip_data_uri)}" alt="Figure snipped from the paper" title="Captured figure — available in the paper builder's Figure board" loading="lazy">` : ''}
          </div>` : ''}
        ${quote ? `<blockquote class="ann-quote">${_esc(quote.slice(0, 600))}${quote.length > 600 ? '…' : ''}</blockquote>` : ''}
        ${ann.comment && section !== 'comment' ? `<div class="ann-comment">${_esc(ann.comment)}</div>` : ''}
        ${draftsBlock}
        ${sectionPanel}
        ${editPanel}
        <div class="ann-card-foot">
          <button class="ann-link-jump" data-id="${_esc(ann.id)}">Jump to →</button>
          ${(isMine && _canWrite) ? `<button class="ann-link-section${section === 'comment' ? ' on' : ''}" data-id="${_esc(ann.id)}" data-section="comment">${ann.comment ? 'Edit comment' : '+ Comment'}</button>` : ''}
          ${_canWrite ? `<button class="ann-link-edit-toggle" data-id="${_esc(ann.id)}" title="More edit controls">${editToggleLabel}</button>` : ''}
        </div>
      </div>
    `;
  }

  // ---- Inline section panels --------------------------------------------

  function _isEvidence(ann) {
    if (ann.evidence_stance) return true;
    return Array.isArray(ann.evidence_for_claim_ids) && ann.evidence_for_claim_ids.length > 0;
  }

  function _renderSectionPanel(ann, section, drafts) {
    if (section === 'comment') return _renderCommentPanel(ann);
    return '';
  }

  function _renderCommentPanel(ann) {
    // V3.620 — in-progress text lives in _commentForm so the snapshot-driven
    // full re-renders can't eat it; save awaits the write and only closes on
    // success (failure keeps the editor open with the text intact).
    const state = _commentForm.get(ann.id) || null;
    const text = state && typeof state.text === 'string' ? state.text : (ann.comment || '');
    const busy = !!(state && state.busy);
    const err = (state && state.err) || '';
    return `
      <div class="ann-section-panel ann-section-comment">
        <textarea class="ann-comment-input" data-id="${_esc(ann.id)}"
          rows="3" placeholder="Type a comment about this highlight…"${busy ? ' disabled' : ''}>${_esc(text)}</textarea>
        ${err ? `<div class="ann-section-err">${_esc(err)}</div>` : ''}
        <div class="ann-section-actions">
          <button class="ann-section-cancel" data-id="${_esc(ann.id)}"${busy ? ' disabled' : ''}>Cancel</button>
          <button class="ann-section-save ann-comment-save" data-id="${_esc(ann.id)}"${busy ? ' disabled' : ''}>${busy ? 'Saving…' : 'Save'}</button>
        </div>
      </div>`;
  }

  // V3.622 — _renderEvidencePanel deleted: the claims/evidence flow lives
  // on Library → Comments (the categorization workspace). The reader is
  // for quick capture only.

  // V3.620 — _renderInfoPanel deleted: its Drafts row is inline on every
  // card now, and the group picker is gone (write-only field; the real
  // "save this paper to a group" concept is paper-level, V3.622).

  function _render() {
    if (!_root) return;
    const filterFn = getFilterFn();
    // V3.621 — the `!a.parent_id` filter is gone: threading never shipped
    // (parent_id was always written null), but a non-null value — e.g.
    // from a hand-authored overlay import — made the annotation render on
    // the PAGE while being invisible/uneditable here.
    const visible = _annotations.filter(filterFn);
    const html = `
      ${_renderHeader()}
      <div class="ann-list">
        ${visible.length
          ? visible.map(_renderAnnotation).join('')
          : '<div class="ann-empty-list">No annotations match the current filters.</div>'}
      </div>
    `;
    _root.innerHTML = html;
    _wireEvents();
  }

  // ---- Events ------------------------------------------------------------

  function _toggleFilter(key, value) {
    const cur = _filters[key];
    if (cur === null) {
      // First click — keep all enabled, then disable this one.
      // But "Active" rendering treats null as "all". To make a single
      // chip click immediately filter to JUST that chip, do:
      _filters[key] = [value];
    } else if (cur.includes(value)) {
      _filters[key] = cur.filter(v => v !== value);
      if (!_filters[key].length) _filters[key] = null;
    } else {
      _filters[key] = cur.concat([value]);
    }
    _emitFilterChange();
    _render();
  }

  function _wireEvents() {
    _root.querySelectorAll('.ann-chip-color').forEach(btn => {
      btn.addEventListener('click', () => _toggleFilter('colors', btn.dataset.color));
    });
    _root.querySelectorAll('.ann-chip-author').forEach(btn => {
      btn.addEventListener('click', () => _toggleFilter('authors', btn.dataset.uid));
    });
    _root.querySelectorAll('.ann-chip-stance').forEach(btn => {
      btn.addEventListener('click', () => _toggleFilter('stance', btn.dataset.stance));
    });
    const onlyMine = _root.querySelector('#ann-only-mine');
    if (onlyMine) {
      onlyMine.addEventListener('change', () => {
        _filters.onlyMine = onlyMine.checked;
        _emitFilterChange();
        _render();
      });
    }
    const defaultVis = _root.querySelector('#ann-default-vis');
    if (defaultVis) {
      defaultVis.addEventListener('change', () => {
        _defaultVisibility = defaultVis.value;
        if (_onVisibilityDefaultChange) _onVisibilityDefaultChange(_defaultVisibility);
        try {
          localStorage.setItem('rm_lib_default_vis', _defaultVisibility);
        } catch (_) { /* ignore */ }
      });
    }
    _root.querySelectorAll('.ann-link-jump').forEach(btn => {
      btn.addEventListener('click', () => _onFocus && _onFocus(btn.dataset.id));
    });
    // Fire-and-forget updates surface failures via alert (the comment save
    // below handles its own errors inline instead).
    const _updateOrAlert = (id, patch) => {
      if (!_onUpdate) return;
      Promise.resolve(_onUpdate(id, patch))
        .catch(e => alert(`Update failed: ${e.message || e}`));
    };
    _root.querySelectorAll('.ann-row-color').forEach(sel => {
      sel.addEventListener('change', () => _updateOrAlert(sel.dataset.id, { color_id: sel.value }));
    });
    _root.querySelectorAll('.ann-row-vis').forEach(sel => {
      sel.addEventListener('change', () => _updateOrAlert(sel.dataset.id, { visibility: sel.value }));
    });
    _root.querySelectorAll('.ann-row-investigate').forEach(btn => {
      btn.addEventListener('click', () => {
        const ann = _annotations.find(a => a.id === btn.dataset.id);
        if (!ann) return;
        _updateOrAlert(btn.dataset.id, { marked_for_investigation: !ann.marked_for_investigation });
      });
    });
    _root.querySelectorAll('.ann-row-delete').forEach(btn => {
      btn.addEventListener('click', () => {
        if (!confirm('Delete this highlight? This cannot be undone.')) return;
        _onDelete && _onDelete(btn.dataset.id);
      });
    });
    // Edit-panel expand/collapse toggle — defaults to collapsed.
    _root.querySelectorAll('.ann-link-edit-toggle').forEach(btn => {
      btn.addEventListener('click', () => {
        const id = btn.dataset.id;
        if (_expandedCards.has(id)) _expandedCards.delete(id);
        else _expandedCards.add(id);
        _render();
      });
    });

    // Drafts dropdown — adding a new draft (any lab member; the R1
    // cite_in_drafts rules carve-out makes this legal on others' cards).
    _root.querySelectorAll('.ann-draft-add').forEach(sel => {
      sel.addEventListener('change', () => {
        const draftId = sel.value;
        if (!draftId) return;
        // V3.628 — the merged control's last option opens the paper-level
        // link picker instead of filing this highlight.
        if (draftId === '__link__') {
          sel.value = '';
          if (window.PAPER_OVERLAYS && window.PAPER_OVERLAYS.openLinkPicker) {
            window.PAPER_OVERLAYS.openLinkPicker();
          }
          return;
        }
        const annId = sel.dataset.id;
        if (_onCiteToggle) {
          _onCiteToggle(annId, draftId, true);
        } else {
          const ann = _annotations.find(a => a.id === annId);
          const cur = Array.isArray(ann && ann.cite_in_drafts) ? ann.cite_in_drafts.slice() : [];
          if (!cur.includes(draftId)) cur.push(draftId);
          _updateOrAlert(annId, { cite_in_drafts: cur });
        }
        sel.value = '';
      });
    });

    // Drafts chip × — remove an existing draft tag.
    _root.querySelectorAll('.ann-draft-x').forEach(btn => {
      btn.addEventListener('click', (ev) => {
        ev.stopPropagation();
        const annId = btn.dataset.id;
        const draftId = btn.dataset.draft;
        if (_onCiteToggle) {
          _onCiteToggle(annId, draftId, false);
        } else {
          const ann = _annotations.find(a => a.id === annId);
          const cur = Array.isArray(ann && ann.cite_in_drafts)
            ? ann.cite_in_drafts.filter(d => d !== draftId) : [];
          _updateOrAlert(annId, { cite_in_drafts: cur });
        }
      });
    });

    // (V3.628 — the separate "+ Link draft…" button is gone; the action is
    // the last option of the .ann-draft-add dropdown above.)

    // ---- Section-based inline panels ----

    // Section button toggle (Comment — V3.622: evidence moved to the
    // Library → Comments workspace).
    _root.querySelectorAll('.ann-link-section').forEach(btn => {
      btn.addEventListener('click', () => {
        const id = btn.dataset.id;
        const target = btn.dataset.section;
        const cur = _cardSection.get(id) || null;
        if (cur === target) _cardSection.delete(id);
        else _cardSection.set(id, target);
        _render();
      });
    });

    _root.querySelectorAll('.ann-section-cancel').forEach(btn => {
      btn.addEventListener('click', () => {
        _cardSection.delete(btn.dataset.id);
        _commentForm.delete(btn.dataset.id);
        _render();
      });
    });

    // Keep in-progress comment text across snapshot re-renders. Typing
    // itself never re-renders — this only records the draft.
    _root.querySelectorAll('.ann-comment-input').forEach(ta => {
      ta.addEventListener('input', () => {
        const id = ta.dataset.id;
        const state = _commentForm.get(id) || {};
        state.text = ta.value;
        _commentForm.set(id, state);
      });
    });

    // E3 — captured equations: render the LaTeX as static math + wire
    // the transcription editor.
    _root.querySelectorAll('.ann-eq-math[data-eq-id]').forEach(el => {
      const ann = _annotations.find(a => a.id === el.dataset.eqId);
      if (ann && ann.latex && window.EQUATION_CAPTURE) {
        window.EQUATION_CAPTURE.renderStatic(ann.latex, el);
      } else if (ann && ann.latex) {
        el.textContent = ann.latex;
      }
    });
    _root.querySelectorAll('.ann-eq-edit').forEach(btn => {
      btn.addEventListener('click', () => {
        const ann = _annotations.find(a => a.id === btn.dataset.id);
        if (ann && window.EQUATION_CAPTURE) window.EQUATION_CAPTURE.openForAnnotation(ann);
      });
    });

    // Comment section save. V3.620 — await the write; close only on
    // success. The old handler closed the textarea and re-rendered from
    // stale state BEFORE the write resolved, so a failure lost the only
    // copy of the typed text.
    _root.querySelectorAll('.ann-comment-save').forEach(btn => {
      btn.addEventListener('click', async () => {
        const id = btn.dataset.id;
        const ta = _root.querySelector(`.ann-comment-input[data-id="${id}"]`);
        const next = ta ? ta.value : '';
        const state = _commentForm.get(id) || {};
        state.text = next; state.busy = true; state.err = '';
        _commentForm.set(id, state);
        _render();
        try {
          await (_onUpdate ? _onUpdate(id, { comment: next }) : Promise.resolve());
          _commentForm.delete(id);
          _cardSection.delete(id);
        } catch (e) {
          state.busy = false;
          state.err = `Save failed: ${e.message || e}`;
          _commentForm.set(id, state);
        }
        _render();
      });
    });
  }

  function setAnnotations(list) {
    _annotations = Array.isArray(list) ? list.slice() : [];
    _render();
  }

  function getDefaultVisibility() { return _defaultVisibility; }

  /* V3.613 — scroll the panel to an annotation's card and flash it. The
   * mobile reader calls this when the user taps a highlight on the page,
   * so the drawer opens already centered on the right card. */
  function focusCard(annId) {
    if (!_root || !annId) return;
    let card = null;
    try { card = _root.querySelector(`.ann-card[data-id="${CSS.escape(String(annId))}"]`); }
    catch (_) { /* CSS.escape unavailable — skip */ }
    if (!card) return;
    try { card.scrollIntoView({ block: 'center', behavior: 'smooth' }); } catch (_) { card.scrollIntoView(); }
    card.classList.add('ann-card-flash');
    setTimeout(() => { try { card.classList.remove('ann-card-flash'); } catch (_) {} }, 1600);
  }

  /* V3.628 — open a highlight's comment from outside the panel (clicking the
   * rect on the page). Owners get the editor open and focused; everyone else
   * just gets the card scrolled to + flashed, since the comment already
   * renders on it. */
  function openComment(annId) {
    if (!annId) return;
    const ann = _annotations.find(a => a.id === annId);
    const isMine = ann && ann.creator && ann.creator.uid === _currentUid;
    if (ann && isMine && _canWrite) {
      if (!_commentForm.has(annId)) {
        _commentForm.set(annId, { text: ann.comment || '', busy: false, err: '' });
      }
      _cardSection.set(annId, 'comment');
      _render();
    }
    focusCard(annId);
    const ta = _root && _root.querySelector(`.ann-comment-input[data-id="${annId}"]`);
    if (ta) { try { ta.focus({ preventScroll: true }); } catch (_) { ta.focus(); } }
  }

  function init(opts) {
    // V3.294 — reset accumulating per-paper state so re-init on a tab switch
    // doesn't stack duplicate filter callbacks (each would fire on every
    // chip click) or leave stale per-card form/expansion entries behind.
    _filterCallbacks = [];
    _expandedCards.clear();
    _cardSection.clear();
    _commentForm.clear();
    _annotations = [];
    _root = opts.rootEl;
    _viewer = opts.viewer;
    _getColors = opts.getColors || (() => []);
    _currentUid = opts.currentUserUid || '';
    _canWrite = (opts.canWrite !== undefined) ? !!opts.canWrite : true;
    _onFocus = opts.onFocus || null;
    _onUpdate = opts.onUpdate || null;
    _getDrafts = opts.getDrafts || null;
    _onCiteToggle = opts.onCiteToggle || null;
    _onDelete = opts.onDelete || null;
    _onVisibilityDefaultChange = opts.onVisibilityDefaultChange || null;

    let stored = null;
    try { stored = localStorage.getItem('rm_lib_default_vis'); } catch (_) { /* ignore */ }
    _defaultVisibility = stored || opts.defaultVisibility || 'lab';

    const fromUrl = _readFiltersFromUrl();
    const fromStorage = _readFiltersFromStorage();
    const initial = (fromUrl.authors || fromUrl.colors || fromUrl.stance || fromUrl.onlyMine)
      ? fromUrl
      : (fromStorage || _filters);
    _filters = Object.assign({ authors: null, colors: null, stance: null, onlyMine: false }, initial);

    _render();
  }

  window.ANNOTATION_PANEL = {
    init,
    setAnnotations,
    getFilterFn,
    onFilterChange,
    getDefaultVisibility,
    focusCard,
    openComment,   // V3.628 — clicking a highlight on the page
  };
})();
