/* library-mobile-paper.js — V3.613 the Ourlab app's single-paper reader.
 *
 * A thin phone orchestrator over the SAME modules the desktop reader
 * (library-paper.js) drives: PDF_VIEWER (with the V3.613 phone opts),
 * GEOM_SELECTION (long-press / 🖍-armed touch selection), ANNOTATION_OVERLAY
 * (rect rendering + tap hit-test), ANNOTATION_SYNC (live Firestore),
 * and ANNOTATION_PANEL (filters, visibility, evidence tagging,
 * cite-in-draft) — so every highlight round-trips live with desktop.
 * Differences from desktop, by design:
 *
 *   • ONE paper per page — no tab strip, no warm-viewer pool (back returns
 *     to library-mobile.html). This alone removes the iOS canvas-memory
 *     problem the desktop's 10-tab model would cause.
 *   • Post-selection UX is an APP_SHEET bottom sheet (color names WITH
 *     meanings, optional comment, visibility) instead of the desktop
 *     create popover — this page routes GEOM_SELECTION.onCommit to its
 *     own sheet.
 *   • Notes live in a full-height slide-up panel hosting the unmodified
 *     ANNOTATION_PANEL; tapping a highlight on the page opens it scrolled
 *     to that card (ANNOTATION_OVERLAY.annotationAt + focusCard).
 *   • Pinch zoom / double-tap fit via viewer-touch.js (the app viewport
 *     disables browser zoom).
 *   • Cut on phone: equation/figure capture, in-PDF search, citations /
 *     cited-by panes, overlays/types, metadata editing — desktop-only.
 */
(function () {
  'use strict';

  const RECENT_KEY = 'rm_libm_recent';

  let _viewer = null;
  let _item = null;
  let _annotations = [];
  let _colors = [];
  let _drafts = [];
  let _allDrafts = [];
  let _unsubSync = null;
  let _canAnnotate = false;
  let _fitMode = true;
  let _booted = false;
  let _pendingHashAnn = null;
  let _pillTimer = 0;

  // V3.620 — palette single-sourced in annotation-colors.js (the copy that
  // used to live here was one of THREE byte-identical duplicates).
  const DEFAULT_COLORS = (window.ANNOTATION_COLORS && window.ANNOTATION_COLORS.DEFAULT) || [];
  const COLOR_TO_TYPE = (window.ANNOTATION_COLORS && window.ANNOTATION_COLORS.COLOR_TO_TYPE) || {};

  function _qs(key) { return new URLSearchParams(location.search).get(key); }

  function _esc(s) {
    return String(s ?? '').replace(/[&<>"']/g, c => ({
      '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;'
    }[c]));
  }

  function _setStatus(msg) {
    const el = document.getElementById('lmp-status');
    if (el) { el.textContent = msg || ''; el.hidden = !msg; }
  }

  /* Deploy detection (library-paper.js V3.583 pattern) with one addition:
   * the Capacitor webview serves from localhost, which reads "local" — but
   * the app has no /api proxy, so native ALWAYS counts as deploy (direct
   * signed URLs, full single-GET download). */
  function _isDeployRuntime() {
    try {
      const C = window.Capacitor;
      if (C && C.isNativePlatform && C.isNativePlatform()) return true;
    } catch (_) { /* not the app */ }
    if (window.RM_RUNTIME) return !!window.RM_RUNTIME.isDeploy;
    const host = (window.location && window.location.hostname) || '';
    return !(host === 'localhost' || host === '127.0.0.1' ||
             host === '0.0.0.0' || host.endsWith('.local'));
  }

  // ---- access (library-paper.js V3.605 pattern) -----------------------------

  async function _computeAccess() {
    try { await firebridge.loadAccessGrant(); } catch (_) { /* role-only */ }
    const isMember = firebridge.isAdmin() || firebridge.isLabMember();
    _canAnnotate = isMember || firebridge.hasCapability('library-paper:annotate');
    firebridge.onAuth(function () {
      const member = firebridge.isAdmin() || firebridge.isLabMember();
      const next = member || firebridge.hasCapability('library-paper:annotate');
      if (next && !_canAnnotate) {
        _canAnnotate = true;
        const note = document.querySelector('#lp-annotations .lp-readonly-note');
        if (note) note.remove();
        const hl = document.getElementById('lmp-hl');
        if (hl) hl.hidden = false;
      }
    });
  }

  // ---- info panel -----------------------------------------------------------

  function _authorLine(authors) {
    return (authors || [])
      .map(a => [a.given, a.family].filter(Boolean).join(' '))
      .join('; ');
  }

  function _renderInfo(item) {
    const lib = (item.meta && item.meta.library) || {};
    const titleEl = document.getElementById('lmp-title');
    if (titleEl) titleEl.textContent = item.title || 'Untitled';
    const host = document.getElementById('lmp-info');
    if (!host) return;
    const rows = [
      ['Authors', _esc(_authorLine(lib.authors))],
      ['Journal', _esc([lib.journal, lib.year].filter(Boolean).join(' · '))],
      ['DOI', lib.doi ? `<a href="https://doi.org/${_esc(lib.doi)}" target="_blank" rel="noopener">${_esc(lib.doi)}</a>` : ''],
      ['PMID', lib.pmid ? `<a href="https://pubmed.ncbi.nlm.nih.gov/${_esc(lib.pmid)}/" target="_blank" rel="noopener">${_esc(lib.pmid)}</a>` : ''],
      ['arXiv', lib.arxiv_id ? `<a href="https://arxiv.org/abs/${_esc(lib.arxiv_id)}" target="_blank" rel="noopener">${_esc(lib.arxiv_id)}</a>` : ''],
      ['Citation key', lib.citation_key ? `<code>${_esc(lib.citation_key)}</code>` : ''],
      ['Tags', (lib.tags || item.tags || []).map(t => `<span class="lmp-tag">${_esc(t)}</span>`).join(' ')],
    ].filter(r => r[1]);
    host.innerHTML = rows.map(r =>
      `<div class="lmp-info-row"><span class="lmp-info-k">${r[0]}</span><span class="lmp-info-v">${r[1]}</span></div>`
    ).join('') || '<div class="lmp-info-row">No metadata.</div>';
  }

  function _recordRecent(item) {
    try {
      const raw = localStorage.getItem(RECENT_KEY);
      let list = raw ? JSON.parse(raw) : [];
      if (!Array.isArray(list)) list = [];
      list = list.filter(r => r && r.id !== item.id);
      list.unshift({ id: item.id, title: item.title || item.id });
      localStorage.setItem(RECENT_KEY, JSON.stringify(list.slice(0, 10)));
    } catch (_) { /* private mode */ }
  }

  // ---- notes panel ------------------------------------------------------------

  function _openPanel() {
    const panel = document.getElementById('lmp-panel');
    const back = document.getElementById('lmp-panel-back');
    if (!panel) return;
    panel.classList.add('open');
    panel.setAttribute('aria-hidden', 'false');
    if (back) back.hidden = false;
  }

  function _closePanel() {
    const panel = document.getElementById('lmp-panel');
    const back = document.getElementById('lmp-panel-back');
    if (!panel) return;
    panel.classList.remove('open');
    panel.setAttribute('aria-hidden', 'true');
    if (back) back.hidden = true;
  }

  // ---- page pill ---------------------------------------------------------------

  function _showPill(page) {
    const pill = document.getElementById('lmp-pill');
    if (!pill || !_viewer) return;
    pill.textContent = `${page} / ${_viewer.numPages}`;
    pill.hidden = false;
    pill.classList.remove('fade');
    if (_pillTimer) clearTimeout(_pillTimer);
    _pillTimer = setTimeout(() => { pill.classList.add('fade'); }, 1200);
  }

  // ---- create sheet -------------------------------------------------------------

  function _openCreateSheet(anchors) {
    if (!window.APP_SHEET || !anchors || !anchors.length) return;
    const defaultVis = (window.ANNOTATION_PANEL && ANNOTATION_PANEL.getDefaultVisibility()) || 'lab';
    const colors = _colors.length ? _colors : DEFAULT_COLORS;
    APP_SHEET.open({
      title: 'New highlight',
      onClose() { if (window.GEOM_SELECTION) GEOM_SELECTION.clear(); },
      build(body, api) {
        body.innerHTML = `
          <div class="lmp-swatches">
            ${colors.map(c => `
              <button class="lmp-swatch-row" data-color="${_esc(c.id)}">
                <span class="lmp-swatch-dot" style="background:${_esc(c.hex)}"></span>
                <span class="lmp-swatch-text">
                  <span class="lmp-swatch-name">${_esc(c.name)}</span>
                  <span class="lmp-swatch-meaning">${_esc(c.meaning || '')}</span>
                </span>
              </button>`).join('')}
          </div>
          <details class="lmp-create-details">
            <summary>＋ Comment, visibility</summary>
            <textarea id="lmp-create-comment" placeholder="Comment (optional)"></textarea>
            <div class="lmp-create-row">
              <label>Visibility</label>
              <select id="lmp-create-vis">
                <option value="lab"${defaultVis === 'lab' ? ' selected' : ''}>Lab — everyone</option>
                <option value="private"${defaultVis === 'private' ? ' selected' : ''}>Private — only me</option>
              </select>
            </div>
          </details>
          <div class="lmp-create-hint">Tap a color to save the highlight.</div>`;
        body.addEventListener('click', async (ev) => {
          const b = ev.target.closest('[data-color]');
          if (!b) return;
          const colorId = b.getAttribute('data-color');
          const color = colors.find(c => c.id === colorId);
          const autoFlags = (color && color.auto_flags) || [];
          const comment = (body.querySelector('#lmp-create-comment') || {}).value || '';
          const visibility = (body.querySelector('#lmp-create-vis') || {}).value || defaultVis;
          api.close();
          try {
            // V3.620 parity with the desktop popover: annotation_type from
            // color, cite_in_drafts from active overlays (PAPER_OVERLAYS is
            // desktop-only, so [] here). Group select retired — the field
            // was write-only.
            await window.ANNOTATION_SYNC.create(_item.id, {
              color_id: colorId,
              annotation_type: COLOR_TO_TYPE[colorId] || 'note',
              visibility,
              comment: comment.trim(),
              target: { pages: anchors },
              cite_in_drafts: [],
              marked_for_investigation: autoFlags.includes('marked_for_investigation'),
            });
            if (window.TOAST) TOAST.success('Highlight saved');
          } catch (e) {
            alert(`Could not save highlight: ${e.message}`);
          }
          if (window.GEOM_SELECTION) GEOM_SELECTION.clear();
        });
      },
    });
  }

  // ---- annotation stack ------------------------------------------------------------

  async function _loadColors() {
    // V3.620 — the per-user palette route was dead code with no writer
    // (V3.608's root cause); the palette is annotation-colors.js.
    _colors = DEFAULT_COLORS;
  }

  /* V3.629 — mobile counterpart of library-paper.js's _ensureDraftLinked:
   * filing a highlight to a draft links the PAPER to that draft, so the
   * evidence is visible in the builder's Evidence Inbox (which fans out over
   * linked_drafts). PAPER_OVERLAYS is desktop-only, so this writes through
   * LIBRARY_LINKS directly — the module library-mobile-paper.html has always
   * loaded and never used. Best-effort: never lose the highlight over a
   * failed link. */
  async function _ensureDraftLinked(draftId) {
    if (!_item || !draftId || !window.LIBRARY_LINKS) return;
    try {
      const lib = (_item.meta && _item.meta.library) || {};
      const linked = Array.isArray(lib.linked_drafts) ? lib.linked_drafts : [];
      if (linked.indexOf(draftId) >= 0) return;
      const fresh = await window.LIBRARY_LINKS.toggleDraftLink(_item.id, draftId, true);
      _item.meta = _item.meta || {};
      _item.meta.library = _item.meta.library || {};
      _item.meta.library.linked_drafts = fresh;
    } catch (e) {
      console.warn('[library-mobile-paper] auto-link to draft failed:', e.message || e);
    }
  }

  async function _loadDrafts() {
    // Evidence/cite pickers: all active paper drafts + grant drafts, linked
    // ones first (library-paper.js V3.475 behavior).
    _drafts = [];
    _allDrafts = [];
    // V3.631 — one definition, in library-links.js (loaded on this page since
    // V3.613; the local list is only a load-order fallback).
    const GRANT_DRAFT_STATUSES = new Set(
      (window.LIBRARY_LINKS && window.LIBRARY_LINKS.GRANT_DRAFT_STATUSES) ||
      ['drafting', 'submitted', 'under_review', 'revising', 'rejected']
    );
    try {
      const member = firebridge.isAdmin() || firebridge.isLabMember();
      const [papersData, itemsData] = await Promise.all([
        api.load('projects/papers.json').catch(() => ({ papers: [] })),
        member ? api.load('items.json').catch(() => ({ items: [] })) : Promise.resolve({ items: [] }),
      ]);
      const paperDrafts = ((papersData && papersData.papers) || [])
        .map(p => ({ id: p.id, title: p.title || p.id, kind: 'paper' }));
      const grantDrafts = ((itemsData && itemsData.items) || [])
        .filter(it => it.type === 'grant' && GRANT_DRAFT_STATUSES.has(it.status))
        .map(it => ({ id: it.id, title: it.title || it.id, kind: 'grant' }));
      _allDrafts = paperDrafts.concat(grantDrafts);
      const linkedIds = new Set(((_item.meta && _item.meta.library && _item.meta.library.linked_drafts) || []));
      const flagged = _allDrafts.map(d => Object.assign({}, d, { linked: linkedIds.has(d.id) }));
      flagged.sort((a, b) => (b.linked ? 1 : 0) - (a.linked ? 1 : 0));
      _drafts = flagged;
    } catch (e) {
      console.warn('[library-mobile-paper] drafts load failed:', e.message);
    }
  }

  async function _mountAnnotations() {
    const paperId = _item.id;
    const user = firebase.auth().currentUser;
    const panelEl = document.getElementById('lp-annotations-inner');
    const viewerEl = document.getElementById('lp-viewer');

    window.ANNOTATION_OVERLAY.init({
      viewer: _viewer,
      container: viewerEl,
      getColors: () => _colors,
      // The desktop popover path is never used here: GEOM_SELECTION.onCommit
      // routes to the bottom sheet below, so onCreate stays unused.
      onCreate: null,
    });

    window.GEOM_SELECTION.init({
      viewer: _viewer,
      viewerEl,
      onCommit: (anchors) => {
        if (!_canAnnotate) return;   // rules would reject the write anyway
        _openCreateSheet(anchors);
      },
    });

    // Read-only note for users without annotate access.
    const panelHost = document.getElementById('lp-annotations');
    if (!_canAnnotate && panelHost && !panelHost.querySelector('.lp-readonly-note')) {
      const note = document.createElement('div');
      note.className = 'lp-readonly-note';
      note.style.cssText = 'font-size:11.5px;color:#92400e;background:#fffbeb;' +
        'border:1px solid #fde68a;border-radius:6px;padding:6px 8px;margin:6px;';
      note.textContent = 'Read-only: you can view lab annotations, but creating highlights needs the annotate permission (ask the PI).';
      panelHost.insertBefore(note, panelHost.firstChild);
    }

    // V3.620 — annotation-level groups retired (write-only field; see the
    // desktop reader). ANNOTATION_GROUPS wiring removed with the panel's
    // group picker.

    window.ANNOTATION_PANEL.init({
      rootEl: panelEl,
      viewer: _viewer,
      getColors: () => _colors,
      getDrafts: () => _drafts,
      currentUserUid: (user && user.uid) || '',
      canWrite: _canAnnotate,
      defaultVisibility: 'lab',
      onFocus: (annId) => {
        _closePanel();   // jumping to the page should show the page
        window.ANNOTATION_OVERLAY.focus(annId);
      },
      // V3.620 — rethrows so the panel's comment editor can keep unsaved
      // text on failure; other panel controls alert via their own wrapper.
      // Color changes re-stamp annotation_type (color IS the category).
      onUpdate: async (annId, patch) => {
        if (patch && patch.color_id) {
          const ann = _annotations.find(a => a.id === annId);
          if (!ann || !ann.kind) {
            patch = Object.assign({}, patch, {
              annotation_type: COLOR_TO_TYPE[patch.color_id] || 'note',
            });
          }
        }
        return window.ANNOTATION_SYNC.update(paperId, annId, patch);
      },
      onDelete: async (annId) => {
        try {
          // V3.621 — same claim-evidence unlink as desktop (best-effort).
          const ann = _annotations.find(a => a.id === annId);
          if (ann && window.CLAIMS && window.CLAIMS.removeEvidenceForAnnotation) {
            try { await window.CLAIMS.removeEvidenceForAnnotation(ann); }
            catch (e) { console.warn('[library-mobile-paper] evidence unlink failed:', e.message || e); }
          }
          await window.ANNOTATION_SYNC.remove(paperId, annId);
        } catch (e) { alert(`Delete failed: ${e.message}`); }
      },
      onCiteToggle: async (annId, draftId, on) => {
        try {
          await window.ANNOTATION_SYNC.toggleCiteInDraft(paperId, annId, draftId, on ? 'add' : 'remove');
          if (on) await _ensureDraftLinked(draftId);
        } catch (e) {
          alert(`Could not ${on ? 'tag' : 'untag'} draft: ${e.message}`);
        }
      },
      // (V3.622 — onEnsureDraftLinked removed with the panel's evidence
      // flow; evidence tagging lives on Library → Comments.)
    });
    window.ANNOTATION_PANEL.onFilterChange(() => {
      window.ANNOTATION_OVERLAY.setFilter(window.ANNOTATION_PANEL.getFilterFn());
      window.ANNOTATION_PANEL.setAnnotations(_annotations);
    });

    _unsubSync = window.ANNOTATION_SYNC.start({
      paperId,
      onChange: (list) => {
        _annotations = list;
        window.ANNOTATION_OVERLAY.setAnnotations(list);
        window.ANNOTATION_PANEL.setAnnotations(list);
        if (_pendingHashAnn && list.some(a => a.id === _pendingHashAnn)) {
          const annId = _pendingHashAnn;
          _pendingHashAnn = null;
          try { window.ANNOTATION_OVERLAY.focus(annId); } catch (e) { /* ignore */ }
          setTimeout(() => {
            try { window.ANNOTATION_OVERLAY.focus(annId); } catch (e) { /* ignore */ }
          }, 250);
        }
      },
      onError: (err) => {
        console.error('[library-mobile-paper] annotation sync error:', err);
        _setStatus(`Annotation sync error: ${err.message || err}`);
      },
    });

    // Overlay redraw after every zoom (library-paper.js V3.294 pattern).
    if (!_viewer.__overlayZoomWrapped) {
      const origSetZoom = _viewer.setZoom;
      _viewer.setZoom = async function (z) {
        const r = await origSetZoom.call(_viewer, z);
        if (window.ANNOTATION_OVERLAY) window.ANNOTATION_OVERLAY.redraw();
        return r;
      };
      _viewer.__overlayZoomWrapped = true;
    }

    // Touch gestures: pinch, double-tap fit, tap-a-highlight → notes panel.
    if (window.VIEWER_TOUCH) {
      window.VIEWER_TOUCH.init({
        viewer: _viewer,
        viewerEl,
        onUserZoom: () => { _fitMode = false; },
        onFitToggle: () => { _fitMode = true; },
        onTapAnnotation: (annId) => {
          window.ANNOTATION_OVERLAY.focus(annId);
          _openPanel();
          setTimeout(() => {
            if (window.ANNOTATION_PANEL.focusCard) window.ANNOTATION_PANEL.focusCard(annId);
          }, 120);
        },
      });
    }
  }

  // ---- boot ------------------------------------------------------------------------

  async function _boot() {
    const id = _qs('id');
    if (!id) { _setStatus('No paper id in the URL.'); return; }

    const hash = location.hash || '';
    if (hash.startsWith('#ann-')) _pendingHashAnn = decodeURIComponent(hash.slice(5));

    await _computeAccess();

    // Single-doc read works for members AND cap-granted :view guests (the
    // rules scope guests to library entries; a doc get is provable).
    let snap;
    try {
      snap = await firebridge.db().collection('items').doc(id).get();
    } catch (e) {
      _setStatus('You do not have access to this paper (ask the PI for the reader permission).');
      return;
    }
    if (!snap.exists) { _setStatus('Paper not found.'); return; }
    _item = Object.assign({ id: snap.id }, snap.data());

    _renderInfo(_item);
    _recordRecent(_item);
    await _loadColors();
    await _loadDrafts();

    // Top bar wiring
    const backBtn = document.getElementById('lmp-back');
    if (backBtn) backBtn.addEventListener('click', () => {
      if (history.length > 1 && document.referrer.indexOf('library-mobile') >= 0) history.back();
      else location.href = '/rm/pages/library-mobile.html';
    });
    const notesBtn = document.getElementById('lmp-notes');
    if (notesBtn) notesBtn.addEventListener('click', _openPanel);
    const closeBtn = document.getElementById('lmp-panel-close');
    if (closeBtn) closeBtn.addEventListener('click', _closePanel);
    const panelBack = document.getElementById('lmp-panel-back');
    if (panelBack) panelBack.addEventListener('click', _closePanel);
    const hlBtn = document.getElementById('lmp-hl');
    if (hlBtn) {
      hlBtn.hidden = !_canAnnotate;
      hlBtn.addEventListener('click', () => {
        const on = !(window.GEOM_SELECTION && GEOM_SELECTION.isArmed());
        if (window.GEOM_SELECTION) GEOM_SELECTION.setArmed(on);
        hlBtn.setAttribute('aria-pressed', String(on));
        hlBtn.classList.toggle('on', on);
      });
    }

    // PDF
    const lib = (_item.meta && _item.meta.library) || {};
    if (!lib.pdf || !lib.pdf.storage_path) {
      _setStatus('No PDF attached to this paper yet — attach one from the desktop library (or ⤓ Fetch missing PDFs there). Notes still work below.');
      await _mountAnnotationsWithoutViewer();
      return;
    }
    _setStatus('Fetching PDF…');
    let signedUrl;
    try {
      signedUrl = await window.LIBRARY_UPLOAD.downloadUrl(lib.pdf.storage_path);
    } catch (e) {
      _setStatus(`Could not fetch the PDF: ${e.message || e}`);
      return;
    }
    const isDeploy = _isDeployRuntime();
    const fetchUrl = isDeploy ? signedUrl
      : `/api/library/pdf-proxy?url=${encodeURIComponent(signedUrl)}`;

    // pdf-viewer.js is an ES module — it can land after auth settles.
    for (let i = 0; !window.PDF_VIEWER && i < 200; i++) {
      await new Promise(r => setTimeout(r, 50));
    }
    if (!window.PDF_VIEWER) { _setStatus('PDF viewer failed to load.'); return; }

    const viewerEl = document.getElementById('lp-viewer');
    try {
      _viewer = await window.PDF_VIEWER.create(viewerEl, fetchUrl, {
        fitToContainer: true,
        disableRange: isDeploy,
        disableStream: isDeploy,
        // V3.613 phone caps: ≤2x render scale, ≤4.2M device px per canvas
        // (~16 MB), half-res segmentation probe, scroll-window canvas
        // recycling, and the .pv-content pinch-transform wrapper.
        dprCap: 2,
        maxCanvasPixels: 4.2e6,
        lowResProbe: true,
        virtualize: true,
        contentWrapper: true,
        onPageChange: (p) => _showPill(p),
        onPageReady: (pageNum) => {
          if (window.ANNOTATION_OVERLAY) window.ANNOTATION_OVERLAY.redrawPage(pageNum);
        },
      });
    } catch (e) {
      console.error('[library-mobile-paper] viewer failed:', e);
      _setStatus(`Could not render the PDF: ${e.message || e}`);
      return;
    }
    _setStatus('');

    await _mountAnnotations();

    // Refit on rotation / resize while in fit mode.
    let resizeTimer = 0;
    window.addEventListener('resize', () => {
      if (resizeTimer) clearTimeout(resizeTimer);
      resizeTimer = setTimeout(async () => {
        resizeTimer = 0;
        if (_fitMode && _viewer) {
          try {
            await _viewer.fitToWidth();
            if (window.ANNOTATION_OVERLAY) window.ANNOTATION_OVERLAY.redraw();
          } catch (_) { /* ignore */ }
        }
      }, 250);
    });

    // Native tab shell: suspend render work while another tab is showing.
    window.OURLAB_TAB_LIFECYCLE = {
      pause() { if (_viewer && _viewer.pause) _viewer.pause(); },
      resume() { if (_viewer && _viewer.resume) _viewer.resume(); },
    };
  }

  /* No-PDF papers still get the notes panel (comments/evidence round-trip
   * with desktop); highlights need page geometry, so creation is off. */
  async function _mountAnnotationsWithoutViewer() {
    const panelEl = document.getElementById('lp-annotations-inner');
    const user = firebase.auth().currentUser;
    window.ANNOTATION_PANEL.init({
      rootEl: panelEl,
      viewer: null,
      getColors: () => _colors,
      getDrafts: () => _drafts,
      currentUserUid: (user && user.uid) || '',
      canWrite: _canAnnotate,
      defaultVisibility: 'lab',
      onUpdate: async (annId, patch) => {
        return window.ANNOTATION_SYNC.update(_item.id, annId, patch);
      },
      onDelete: async (annId) => {
        try { await window.ANNOTATION_SYNC.remove(_item.id, annId); }
        catch (e) { alert(`Delete failed: ${e.message}`); }
      },
    });
    _unsubSync = window.ANNOTATION_SYNC.start({
      paperId: _item.id,
      onChange: (list) => {
        _annotations = list;
        window.ANNOTATION_PANEL.setAnnotations(list);
      },
      onError: (err) => _setStatus(`Annotation sync error: ${err.message || err}`),
    });
    _openPanel();
  }

  window.addEventListener('beforeunload', () => {
    try { _unsubSync && _unsubSync(); } catch (_) { /* ignore */ }
    try { window.VIEWER_TOUCH && VIEWER_TOUCH.destroy(); } catch (_) { /* ignore */ }
    try { window.GEOM_SELECTION && GEOM_SELECTION.destroy(); } catch (_) { /* ignore */ }
    try { _viewer && _viewer.destroy(); } catch (_) { /* ignore */ }
  });

  document.addEventListener('DOMContentLoaded', () => {
    if (typeof firebridge === 'undefined') {
      _setStatus('Firebase failed to load — check your connection.');
      return;
    }
    firebridge.onAuth((user) => {
      if (user && !_booted) {
        _booted = true;
        _boot().catch(e => {
          console.error('[library-mobile-paper] boot failed:', e);
          _setStatus(`Could not open the paper: ${e.message || e}`);
        });
      }
    });
  });
})();
