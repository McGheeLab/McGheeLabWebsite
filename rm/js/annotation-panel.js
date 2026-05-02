/* annotation-panel.js — sidebar list of annotations + filter chips +
 * comment threads + per-annotation visibility / color / delete controls.
 *
 * Public API (window.ANNOTATION_PANEL):
 *   init({rootEl, viewer, getColors, onFocus, onUpdate, onDelete, onReply,
 *         currentUserUid, defaultVisibility, onVisibilityDefaultChange})
 *   setAnnotations(list)      — replace data; re-render
 *   getFilterFn()             — returns a fn(ann)→bool that respects current filters
 *   onFilterChange(cb)        — invoked whenever filter state changes
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
  let _onFocus = null;
  let _onUpdate = null;
  let _getDrafts = null;          // () → [{id, title}, ...]
  let _getGroups = null;          // () → [{id, name}, ...]
  let _onCreateGroup = null;      // (name) → Promise<groupId>
  let _onCiteToggle = null;       // (annId, draftId, on:boolean) → ...
  let _expandedCards = new Set(); // ann.id of cards whose general "▸ more" edit panel is open
  // For inline forms, each card can have ONE active section: 'comment',
  // 'evidence', or 'info'. null means none. Per-card draft selection +
  // claim cache lives here so the form survives re-renders inside the page.
  let _cardSection = new Map();   // annId → 'comment' | 'evidence' | 'info' | null
  let _evidenceForm = new Map();  // annId → { draftId, claims, claimId, stance, busy, err, newStmt }
  let _onDelete = null;
  let _onReply = null;
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
    return _getColors().find(c => c.id === id) || { hex: '#facc15', name: 'Note' };
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
      ? '<span class="ann-investigate" title="Marked for further investigation">⚑</span>' : '';
    const visBadge = ann.visibility === 'private'
      ? '<span class="ann-vis ann-vis-private" title="Only you can see this">🔒</span>'
      : '<span class="ann-vis ann-vis-lab" title="Visible to the whole lab">👥</span>';

    // ---- Drafts: chips for tagged + a dropdown to add more (NOT pills).
    const cited = Array.isArray(ann.cite_in_drafts) ? ann.cite_in_drafts : [];
    const drafts = (_getDrafts && _getDrafts()) || [];
    const taggedDrafts = drafts.filter(d => cited.includes(d.id));
    const untaggedDrafts = drafts.filter(d => !cited.includes(d.id));
    const draftsBlock = drafts.length ? `
      <div class="ann-edit-row" title="Drafts this highlight feeds into (cite_in_drafts)">
        <span class="ann-tiny-label">Drafts</span>
        <div class="ann-draft-chips">
          ${taggedDrafts.map(d => `
            <span class="ann-draft-chip">${_esc((d.title || d.id).slice(0, 24))}${(d.title || d.id).length > 24 ? '…' : ''}<button class="ann-draft-x" data-id="${_esc(ann.id)}" data-draft="${_esc(d.id)}" title="Remove">×</button></span>
          `).join('') || '<span class="ann-empty">none</span>'}
        </div>
        ${untaggedDrafts.length ? `
          <select class="ann-draft-add" data-id="${_esc(ann.id)}">
            <option value="">+ add draft…</option>
            ${untaggedDrafts.map(d => `<option value="${_esc(d.id)}">${_esc((d.title || d.id).slice(0, 60))}</option>`).join('')}
          </select>` : ''}
      </div>` : '';

    // ---- Group selector + create-new affordance.
    const groupCur = ann.group || 'general';
    const groups = (_getGroups && _getGroups()) || [{ id: 'general', name: 'General' }];
    const hasCur = groups.some(g => g.id === groupCur);
    const groupBlock = `
      <div class="ann-edit-row" title="Organize this highlight into a group (lab-shared)">
        <span class="ann-tiny-label">Group</span>
        <select class="ann-row-group" data-id="${_esc(ann.id)}">
          ${groups.map(g => `<option value="${_esc(g.id)}"${g.id === groupCur ? ' selected' : ''}>${_esc(g.name || g.id)}</option>`).join('')}
          ${hasCur ? '' : `<option value="${_esc(groupCur)}" selected>${_esc(groupCur)} (legacy)</option>`}
          <option value="__new__">+ New group…</option>
        </select>
      </div>`;

    const ownerActions = isMine ? `
      <div class="ann-row-actions">
        <select class="ann-row-color" data-id="${_esc(ann.id)}">
          ${_getColors().map(cc => `<option value="${_esc(cc.id)}"${cc.id === ann.color_id ? ' selected' : ''}>${_esc(cc.name)}</option>`).join('')}
        </select>
        <select class="ann-row-vis" data-id="${_esc(ann.id)}">
          <option value="lab"${ann.visibility === 'lab' ? ' selected' : ''}>Lab</option>
          <option value="private"${ann.visibility === 'private' ? ' selected' : ''}>Private</option>
        </select>
        <button class="ann-row-investigate${ann.marked_for_investigation ? ' active' : ''}" data-id="${_esc(ann.id)}" title="Mark for investigation">⚑</button>
        <button class="ann-row-delete" data-id="${_esc(ann.id)}" title="Delete">🗑</button>
      </div>` : '';

    // Inline action panels (replace prompts/modals with expansions).
    const section = _cardSection.get(ann.id) || null;
    const sectionPanel = section ? _renderSectionPanel(ann, section, drafts, groups, groupCur) : '';

    // The general "▸ more" edit panel — color/visibility/investigate/delete.
    const expanded = _expandedCards.has(ann.id);
    const editToggleLabel = expanded ? '▾ less' : '▸ more';
    const editPanel = expanded ? `
      <div class="ann-edit-panel">
        ${draftsBlock}
        ${groupBlock}
        ${ownerActions}
      </div>` : '';

    return `
      <div class="ann-card" data-id="${_esc(ann.id)}" style="border-left-color:${_esc(c.hex)}">
        <div class="ann-card-head">
          <span class="ann-avatar" title="${_esc(dn)}">${_esc(_initials(dn))}</span>
          <span class="ann-card-meta">
            <span class="ann-card-name">${_esc(dn)}</span>
            <span class="ann-card-page">${_esc(pageLabel)}</span>
            ${visBadge}
            ${investigateBadge}
            ${stanceBadge}
          </span>
        </div>
        ${quote ? `<blockquote class="ann-quote">${_esc(quote.slice(0, 600))}${quote.length > 600 ? '…' : ''}</blockquote>` : ''}
        ${ann.comment && section !== 'comment' ? `<div class="ann-comment">${_esc(ann.comment)}</div>` : ''}
        ${sectionPanel}
        ${editPanel}
        <div class="ann-card-foot">
          <button class="ann-link-jump" data-id="${_esc(ann.id)}">Jump to →</button>
          ${isMine ? `<button class="ann-link-section${section === 'comment' ? ' on' : ''}" data-id="${_esc(ann.id)}" data-section="comment">${ann.comment ? 'Edit comment' : '+ Comment'}</button>` : ''}
          <button class="ann-link-section${section === 'evidence' ? ' on' : ''}" data-id="${_esc(ann.id)}" data-section="evidence">Tag as evidence</button>
          <button class="ann-link-section${section === 'info' ? ' on' : ''}" data-id="${_esc(ann.id)}" data-section="info">Tag as information</button>
          <button class="ann-link-edit-toggle" data-id="${_esc(ann.id)}" title="More edit controls">${editToggleLabel}</button>
        </div>
      </div>
    `;
  }

  // ---- Inline section panels --------------------------------------------

  function _renderSectionPanel(ann, section, drafts, groups, groupCur) {
    if (section === 'comment') return _renderCommentPanel(ann);
    if (section === 'evidence') return _renderEvidencePanel(ann, drafts);
    if (section === 'info') return _renderInfoPanel(ann, drafts, groups, groupCur);
    return '';
  }

  function _renderCommentPanel(ann) {
    return `
      <div class="ann-section-panel ann-section-comment">
        <textarea class="ann-comment-input" data-id="${_esc(ann.id)}"
          rows="3" placeholder="Type a comment about this highlight…">${_esc(ann.comment || '')}</textarea>
        <div class="ann-section-actions">
          <button class="ann-section-cancel" data-id="${_esc(ann.id)}">Cancel</button>
          <button class="ann-section-save ann-comment-save" data-id="${_esc(ann.id)}">Save</button>
        </div>
      </div>`;
  }

  function _renderEvidencePanel(ann, drafts) {
    const state = _evidenceForm.get(ann.id) || { draftId: '', claims: null, claimId: '', stance: 'for', busy: false, err: '', newStmt: '' };
    if (!state.draftId && drafts.length) state.draftId = drafts[0].id;
    _evidenceForm.set(ann.id, state);

    const draftOpts = drafts.map(d =>
      `<option value="${_esc(d.id)}"${d.id === state.draftId ? ' selected' : ''}>${_esc((d.title || d.id).slice(0, 60))}</option>`
    ).join('');

    let claimsList;
    if (!state.draftId) {
      claimsList = '<div class="ann-section-empty">No drafts available.</div>';
    } else if (state.claims === null) {
      claimsList = '<div class="ann-section-empty">Loading claims…</div>';
    } else if (state.claims.length === 0) {
      claimsList = '<div class="ann-section-empty">No claims yet on this draft.</div>';
    } else {
      claimsList = state.claims.map(c => `
        <label class="ann-claim-pick">
          <input type="radio" name="ann-claim-${_esc(ann.id)}" value="${_esc(c.id)}"
            data-id="${_esc(ann.id)}"${c.id === state.claimId ? ' checked' : ''}>
          <span class="ann-claim-stmt">${_esc((c.statement || '(no statement)').slice(0, 120))}${(c.statement || '').length > 120 ? '…' : ''}</span>
        </label>
      `).join('');
    }

    return `
      <div class="ann-section-panel ann-section-evidence">
        <div class="ann-section-row">
          <span class="ann-section-label">Draft</span>
          <select class="ann-evidence-draft" data-id="${_esc(ann.id)}">${draftOpts || '<option value="">(no drafts)</option>'}</select>
        </div>
        <div class="ann-section-row">
          <span class="ann-section-label">Claim</span>
          <div class="ann-claims-list">${claimsList}</div>
        </div>
        <div class="ann-section-row">
          <span class="ann-section-label">+ new</span>
          <input type="text" class="ann-evidence-newclaim" data-id="${_esc(ann.id)}"
            placeholder="Or create a new claim on this draft" value="${_esc(state.newStmt || '')}">
          <button class="ann-evidence-newclaim-btn" data-id="${_esc(ann.id)}">Add</button>
        </div>
        <div class="ann-section-row">
          <span class="ann-section-label">Stance</span>
          <label><input type="radio" name="ann-stance-${_esc(ann.id)}" value="for" data-id="${_esc(ann.id)}"${state.stance === 'for' ? ' checked' : ''}> Supports</label>
          <label><input type="radio" name="ann-stance-${_esc(ann.id)}" value="against" data-id="${_esc(ann.id)}"${state.stance === 'against' ? ' checked' : ''}> Against</label>
        </div>
        ${state.err ? `<div class="ann-section-err">${_esc(state.err)}</div>` : ''}
        <div class="ann-section-actions">
          <button class="ann-section-cancel" data-id="${_esc(ann.id)}">Cancel</button>
          <button class="ann-section-save ann-evidence-save" data-id="${_esc(ann.id)}"${(state.busy || !state.claimId) ? ' disabled' : ''}>${state.busy ? 'Linking…' : 'Tag as evidence'}</button>
        </div>
      </div>`;
  }

  function _renderInfoPanel(ann, drafts, groups, groupCur) {
    const cited = Array.isArray(ann.cite_in_drafts) ? ann.cite_in_drafts : [];
    const tagged = drafts.filter(d => cited.includes(d.id));
    const untagged = drafts.filter(d => !cited.includes(d.id));
    return `
      <div class="ann-section-panel ann-section-info">
        <div class="ann-section-row">
          <span class="ann-section-label">Drafts</span>
          <div class="ann-draft-chips">
            ${tagged.map(d => `<span class="ann-draft-chip">${_esc((d.title || d.id).slice(0, 24))}<button class="ann-draft-x" data-id="${_esc(ann.id)}" data-draft="${_esc(d.id)}">×</button></span>`).join('') || '<span class="ann-empty">none</span>'}
          </div>
          ${untagged.length ? `
            <select class="ann-draft-add" data-id="${_esc(ann.id)}">
              <option value="">+ add draft…</option>
              ${untagged.map(d => `<option value="${_esc(d.id)}">${_esc((d.title || d.id).slice(0, 60))}</option>`).join('')}
            </select>` : ''}
        </div>
        <div class="ann-section-row">
          <span class="ann-section-label">Group</span>
          <select class="ann-row-group" data-id="${_esc(ann.id)}">
            ${groups.map(g => `<option value="${_esc(g.id)}"${g.id === groupCur ? ' selected' : ''}>${_esc(g.name || g.id)}</option>`).join('')}
            ${groups.some(g => g.id === groupCur) ? '' : `<option value="${_esc(groupCur)}" selected>${_esc(groupCur)} (legacy)</option>`}
            <option value="__new__">+ New group…</option>
          </select>
        </div>
        <div class="ann-section-actions">
          <button class="ann-section-cancel" data-id="${_esc(ann.id)}">Done</button>
        </div>
      </div>`;
  }

  function _render() {
    if (!_root) return;
    const filterFn = getFilterFn();
    const visible = _annotations.filter(a => !a.parent_id).filter(filterFn);
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
    _root.querySelectorAll('.ann-row-color').forEach(sel => {
      sel.addEventListener('change', () => _onUpdate && _onUpdate(sel.dataset.id, { color_id: sel.value }));
    });
    _root.querySelectorAll('.ann-row-vis').forEach(sel => {
      sel.addEventListener('change', () => _onUpdate && _onUpdate(sel.dataset.id, { visibility: sel.value }));
    });
    _root.querySelectorAll('.ann-row-investigate').forEach(btn => {
      btn.addEventListener('click', () => {
        const ann = _annotations.find(a => a.id === btn.dataset.id);
        if (!ann) return;
        _onUpdate && _onUpdate(btn.dataset.id, { marked_for_investigation: !ann.marked_for_investigation });
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

    // Drafts dropdown — adding a new draft (anyone authenticated).
    _root.querySelectorAll('.ann-draft-add').forEach(sel => {
      sel.addEventListener('change', () => {
        const draftId = sel.value;
        if (!draftId) return;
        const annId = sel.dataset.id;
        if (_onCiteToggle) {
          _onCiteToggle(annId, draftId, true);
        } else {
          const ann = _annotations.find(a => a.id === annId);
          const cur = Array.isArray(ann && ann.cite_in_drafts) ? ann.cite_in_drafts.slice() : [];
          if (!cur.includes(draftId)) cur.push(draftId);
          _onUpdate && _onUpdate(annId, { cite_in_drafts: cur });
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
          _onUpdate && _onUpdate(annId, { cite_in_drafts: cur });
        }
      });
    });

    // Group dropdown — change to a known group, or "+ New group..." opens
    // a prompt and creates one in Firestore via _onCreateGroup.
    _root.querySelectorAll('.ann-row-group').forEach(sel => {
      sel.addEventListener('change', async () => {
        const annId = sel.dataset.id;
        const next = sel.value;
        if (next === '__new__') {
          // Reset to current value while we prompt; user may cancel.
          const ann = _annotations.find(a => a.id === annId);
          const prevGroup = (ann && ann.group) || 'general';
          sel.value = prevGroup;
          const name = window.prompt('New group name (e.g. "method", "open question"):');
          if (!name || !name.trim()) return;
          if (!_onCreateGroup) {
            alert('Create-group not wired on this page.');
            return;
          }
          try {
            const id = await _onCreateGroup(name.trim());
            _onUpdate && _onUpdate(annId, { group: id });
          } catch (e) {
            alert(`Could not create group: ${e.message || e}`);
          }
          return;
        }
        _onUpdate && _onUpdate(annId, { group: next });
      });
    });

    // ---- Section-based inline panels ----

    // Section button toggle (Comment / Evidence / Information).
    _root.querySelectorAll('.ann-link-section').forEach(btn => {
      btn.addEventListener('click', () => {
        const id = btn.dataset.id;
        const target = btn.dataset.section;
        const cur = _cardSection.get(id) || null;
        if (cur === target) {
          _cardSection.delete(id);
        } else {
          _cardSection.set(id, target);
          if (target === 'evidence') _ensureEvidenceClaims(id);
        }
        _render();
      });
    });

    _root.querySelectorAll('.ann-section-cancel').forEach(btn => {
      btn.addEventListener('click', () => {
        _cardSection.delete(btn.dataset.id);
        _render();
      });
    });

    // Comment section save.
    _root.querySelectorAll('.ann-comment-save').forEach(btn => {
      btn.addEventListener('click', () => {
        const id = btn.dataset.id;
        const ta = _root.querySelector(`.ann-comment-input[data-id="${id}"]`);
        const next = ta ? ta.value : '';
        _onUpdate && _onUpdate(id, { comment: next });
        _cardSection.delete(id);
        _render();
      });
    });

    // Evidence section: draft, claim radio, stance radio, new-claim, save.
    _root.querySelectorAll('.ann-evidence-draft').forEach(sel => {
      sel.addEventListener('change', () => {
        const id = sel.dataset.id;
        const state = _evidenceForm.get(id) || {};
        state.draftId = sel.value;
        state.claims = null;
        state.claimId = '';
        state.err = '';
        _evidenceForm.set(id, state);
        _ensureEvidenceClaims(id);
        _render();
      });
    });
    _root.querySelectorAll(`input[name^="ann-claim-"]`).forEach(input => {
      input.addEventListener('change', () => {
        const id = input.dataset.id;
        const state = _evidenceForm.get(id) || {};
        state.claimId = input.value;
        state.err = '';
        _evidenceForm.set(id, state);
        _render();
      });
    });
    _root.querySelectorAll(`input[name^="ann-stance-"]`).forEach(input => {
      input.addEventListener('change', () => {
        const id = input.dataset.id;
        const state = _evidenceForm.get(id) || {};
        state.stance = input.value;
        _evidenceForm.set(id, state);
      });
    });
    _root.querySelectorAll('.ann-evidence-newclaim').forEach(input => {
      input.addEventListener('input', () => {
        const id = input.dataset.id;
        const state = _evidenceForm.get(id) || {};
        state.newStmt = input.value;
        _evidenceForm.set(id, state);
      });
    });
    _root.querySelectorAll('.ann-evidence-newclaim-btn').forEach(btn => {
      btn.addEventListener('click', async () => {
        const id = btn.dataset.id;
        const state = _evidenceForm.get(id) || {};
        const stmt = String(state.newStmt || '').trim();
        if (!stmt) { state.err = 'Type a claim statement first.'; _evidenceForm.set(id, state); _render(); return; }
        if (!window.CLAIMS) { state.err = 'CLAIMS module missing.'; _evidenceForm.set(id, state); _render(); return; }
        state.busy = true; state.err = '';
        _evidenceForm.set(id, state);
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
        _evidenceForm.set(id, state);
        _render();
      });
    });
    _root.querySelectorAll('.ann-evidence-save').forEach(btn => {
      btn.addEventListener('click', async () => {
        const id = btn.dataset.id;
        const state = _evidenceForm.get(id) || {};
        if (!state.draftId || !state.claimId || !state.stance) return;
        const ann = _annotations.find(a => a.id === id);
        if (!ann || !window.CLAIMS) return;
        state.busy = true; state.err = '';
        _evidenceForm.set(id, state);
        _render();
        try {
          await window.CLAIMS.addEvidence(state.draftId, state.claimId, ann.paperId, ann.id, state.stance);
          _cardSection.delete(id);
          _evidenceForm.delete(id);
        } catch (e) {
          state.err = `Tag failed: ${e.message || e}`;
          state.busy = false;
          _evidenceForm.set(id, state);
        }
        _render();
      });
    });
  }

  // Lazy-load claims for the chosen draft when the Evidence form opens.
  async function _ensureEvidenceClaims(annId) {
    const state = _evidenceForm.get(annId);
    if (!state || !state.draftId || (state.claims !== null && state.claims !== undefined && Array.isArray(state.claims))) return;
    try {
      const claims = await _loadClaimsForDraft(state.draftId);
      const cur = _evidenceForm.get(annId);
      if (!cur || cur.draftId !== state.draftId) return;
      cur.claims = claims;
      _evidenceForm.set(annId, cur);
    } catch (e) {
      const cur = _evidenceForm.get(annId) || state;
      cur.claims = [];
      cur.err = `Could not load claims: ${e.message || e}`;
      _evidenceForm.set(annId, cur);
    }
    _render();
  }

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

  function setAnnotations(list) {
    _annotations = Array.isArray(list) ? list.slice() : [];
    _render();
  }

  function getDefaultVisibility() { return _defaultVisibility; }

  function init(opts) {
    _root = opts.rootEl;
    _viewer = opts.viewer;
    _getColors = opts.getColors || (() => []);
    _currentUid = opts.currentUserUid || '';
    _onFocus = opts.onFocus || null;
    _onUpdate = opts.onUpdate || null;
    _getDrafts = opts.getDrafts || null;
    _getGroups = opts.getGroups || null;
    _onCreateGroup = opts.onCreateGroup || null;
    _onCiteToggle = opts.onCiteToggle || null;
    _onDelete = opts.onDelete || null;
    _onReply = opts.onReply || null;
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
  };
})();
