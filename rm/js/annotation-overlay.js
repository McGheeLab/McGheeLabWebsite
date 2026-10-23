/* annotation-overlay.js — render highlights as DOM rects in `.pv-overlay`,
 * detect new selections, and surface a small floating "create" toolbar.
 *
 * Public API (window.ANNOTATION_OVERLAY):
 *   init({viewer, container, onCreate, onSelect, getColors})
 *   setAnnotations(list)              — replace the rendered set
 *   redraw()                          — re-render rects (e.g., after zoom)
 *   redrawPage(pageNumber)            — re-render rects for one page
 *   focus(annotationId)               — scroll-to + highlight
 *   destroy()
 *
 * The overlay is a sibling of pdf-viewer; it does not reach into pdf-viewer
 * state beyond the public getPageNode().
 */
(function () {
  let _viewer = null;
  let _container = null;
  let _onCreate = null;
  let _onAnnotationClick = null;   // V3.628 — click a rect on the page
  let _onCaptureEquation = null;   // E3 — equation capture action
  let _onCaptureFigure = null;     // V3.610 — figure capture action
  let _getColors = () => [];
  let _annotations = [];
  let _popoverEl = null;
  let _popoverZoom = null;         // viewer.zoom when the popover opened
  let _popoverEsc = null;          // bound Escape handler while open
  let _popoverRefreshDrafts = null; // rebuilds the draft chips after linking
  let _selectionDebounce = 0;
  let _filterFn = () => true;
  let _focusedId = null;

  // ---- Create popover ------------------------------------------------------
  // V3.620 — the swatch bubble became a single create popover: labeled
  // color/category swatches + optional comment + draft-filing chips, saved
  // in one click (clicking a swatch IS the save). Anchored absolutely
  // inside the page wrap so it scrolls with the selection — the old
  // position:fixed bubble stranded itself on scroll and died if you
  // clicked ANY control outside the viewer.

  function _hidePopover() {
    if (_popoverEl) {
      _popoverEl.remove();
      _popoverEl = null;
    }
    _popoverZoom = null;
    _popoverRefreshDrafts = null;
    if (_popoverEsc) {
      document.removeEventListener('keydown', _popoverEsc, true);
      _popoverEsc = null;
    }
  }

  function _clearSelection() {
    const G = window.GEOM_SELECTION;
    if (!G) return;
    // clearCommitted() only clears a COMMITTED selection — never an
    // in-flight gesture (pointerdown fires before mousedown, so a plain
    // clear() here would kill a drag the user just started).
    if (G.clearCommitted) G.clearCommitted();
    else G.clear();
  }

  function _mkBtn(className, text, title) {
    const b = document.createElement('button');
    b.type = 'button';
    b.className = className;
    b.textContent = text;
    b.title = title || '';
    return b;
  }

  function _showCreatePopover(anchors) {
    _hidePopover();
    if (!anchors || !anchors.length) return;
    const last = anchors[anchors.length - 1];
    if (!last.rects || !last.rects.length) return;
    const node = _viewer.getPageNode(last.page);
    if (!node) return;
    const r = last.rects[last.rects.length - 1];

    const pop = document.createElement('div');
    pop.className = 'ann-popover';

    // Swatch row — color IS the category, so show the names. Clicking one
    // saves immediately.
    const swRow = document.createElement('div');
    swRow.className = 'ann-pop-swatches';
    const errEl = document.createElement('div');
    errEl.className = 'ann-pop-error';
    errEl.style.display = 'none';

    const ta = document.createElement('textarea');
    ta.className = 'ann-pop-comment';
    ta.rows = 2;
    ta.placeholder = 'Comment (optional)…';

    // Draft-filing chips: pre-checked from the active overlays, toggleable
    // per-highlight before saving.
    const selected = new Set(
      (window.PAPER_OVERLAYS && window.PAPER_OVERLAYS.getActiveDraftIds)
        ? window.PAPER_OVERLAYS.getActiveDraftIds() : []
    );
    const draftsRow = document.createElement('div');
    draftsRow.className = 'ann-pop-drafts';

    function renderDraftChips() {
      draftsRow.innerHTML = '';
      const drafts = (window.PAPER_OVERLAYS && window.PAPER_OVERLAYS.getLinkedDrafts)
        ? window.PAPER_OVERLAYS.getLinkedDrafts() : [];
      const live = new Set(drafts.map(d => d.id));
      for (const id of Array.from(selected)) if (!live.has(id)) selected.delete(id);
      const lab = document.createElement('span');
      lab.className = 'ann-pop-drafts-label';
      lab.textContent = 'File to:';
      draftsRow.appendChild(lab);
      for (const d of drafts) {
        const chip = _mkBtn('ann-pop-draft', d.title, d.title);
        chip.setAttribute('aria-pressed', selected.has(d.id) ? 'true' : 'false');
        const colorFor = window.PAPER_OVERLAYS && window.PAPER_OVERLAYS.getColorForDraft;
        if (colorFor) chip.style.setProperty('--draft-dot', colorFor(d.id));
        chip.addEventListener('click', (e) => {
          e.preventDefault();
          if (selected.has(d.id)) selected.delete(d.id); else selected.add(d.id);
          chip.setAttribute('aria-pressed', selected.has(d.id) ? 'true' : 'false');
        });
        draftsRow.appendChild(chip);
      }
      const add = _mkBtn('ann-pop-draft ann-pop-draft-add', '+ draft…',
        'Link another paper/grant draft to this paper');
      add.addEventListener('click', (e) => {
        e.preventDefault();
        if (window.PAPER_OVERLAYS && window.PAPER_OVERLAYS.openLinkPicker) {
          window.PAPER_OVERLAYS.openLinkPicker();
        }
      });
      draftsRow.appendChild(add);
    }
    renderDraftChips();
    // Re-render the chips if the link picker (opened from "+ draft…")
    // changes the linked set while the popover is up. Newly linked drafts
    // arrive auto-activated (paper-overlays), so pre-check them here too.
    _popoverRefreshDrafts = () => {
      const active = (window.PAPER_OVERLAYS && window.PAPER_OVERLAYS.getActiveDraftIds)
        ? window.PAPER_OVERLAYS.getActiveDraftIds() : [];
      for (const id of active) selected.add(id);
      renderDraftChips();
    };

    let busy = false;
    function setBusy(on) {
      busy = on;
      pop.classList.toggle('ann-pop-busy', on);
      pop.querySelectorAll('button, textarea').forEach(el => { el.disabled = on; });
    }

    async function save(colorId) {
      if (busy) return;
      errEl.style.display = 'none';
      setBusy(true);
      // V3.621 — offline guard: with Firestore persistence on, a create
      // issued offline never settles until reconnect, which would leave
      // the popover stuck "busy" forever. If the write hasn't settled in
      // 4s, assume it's queued (the highlight already painted via latency
      // compensation), close up, and surface any LATE rejection loudly.
      const QUEUED = Symbol('queued');
      const createP = _onCreate({
        anchors,
        colorId,
        comment: ta.value,
        draftIds: Array.from(selected),
      });
      let settled = false;
      try {
        const winner = await Promise.race([
          createP.then(v => { settled = true; return v; },
                       e => { settled = true; throw e; }),
          new Promise(res => setTimeout(() => res(QUEUED), 4000)),
        ]);
        if (winner === QUEUED && !settled) {
          createP.catch(e => alert(`A highlight you made could not be saved: ${e.message || e}`));
        }
        _hidePopover();
        if (window.GEOM_SELECTION) window.GEOM_SELECTION.clear();
      } catch (e) {
        // Keep everything — selection, comment text, chips — so the user
        // can retry. The old bubble alert()ed AFTER discarding all of it.
        setBusy(false);
        errEl.textContent = `Couldn't save: ${e.message || e}`;
        errEl.style.display = '';
      }
    }

    const colors = _getColors();
    for (const c of colors) {
      const swatch = _mkBtn('ann-pop-swatch', '', `${c.name} — ${c.meaning}`);
      swatch.setAttribute('aria-label', c.name);
      const dot = document.createElement('span');
      dot.className = 'ann-pop-swatch-dot';
      dot.style.background = c.hex;
      const name = document.createElement('span');
      name.textContent = c.name;
      swatch.appendChild(dot);
      swatch.appendChild(name);
      swatch.addEventListener('mousedown', (e) => e.preventDefault()); // keep textarea focus
      swatch.addEventListener('click', (e) => {
        e.preventDefault();
        e.stopPropagation();
        save(c.id);
      });
      swRow.appendChild(swatch);
    }

    // Footer: capture actions + cancel.
    const foot = document.createElement('div');
    foot.className = 'ann-pop-foot';
    if (_onCaptureEquation) {
      const eqBtn = _mkBtn('ann-toolbar-eq', 'ƒ', 'Capture equation — snip this region and transcribe it');
      eqBtn.addEventListener('mousedown', (e) => e.preventDefault());
      eqBtn.addEventListener('click', (e) => {
        e.preventDefault(); e.stopPropagation();
        _hidePopover();
        _onCaptureEquation({ anchors });
      });
      foot.appendChild(eqBtn);
    }
    if (_onCaptureFigure) {
      const figBtn = _mkBtn('ann-toolbar-eq', '', 'Capture figure — snip this region as a reference image');
      ICON.label(figBtn, 'photo');
      figBtn.addEventListener('mousedown', (e) => e.preventDefault());
      figBtn.addEventListener('click', (e) => {
        e.preventDefault(); e.stopPropagation();
        _hidePopover();
        _onCaptureFigure({ anchors });
      });
      foot.appendChild(figBtn);
    }
    const cancel = _mkBtn('ann-toolbar-cancel', '×', 'Cancel (Esc)');
    cancel.addEventListener('mousedown', (e) => e.preventDefault());
    cancel.addEventListener('click', (e) => {
      e.preventDefault(); e.stopPropagation();
      _hidePopover();
      _clearSelection();
    });
    foot.appendChild(cancel);

    pop.appendChild(swRow);
    pop.appendChild(ta);
    pop.appendChild(draftsRow);
    pop.appendChild(errEl);
    pop.appendChild(foot);

    // Anchor inside the page wrap (NOT .pv-overlay — redrawPage wipes that
    // layer's innerHTML on every snapshot). Position below the selection's
    // last rect, clamped to the wrap; flip above when there's no room.
    node.wrap.appendChild(pop);
    const wrapW = node.wrap.clientWidth;
    const wrapH = node.wrap.clientHeight;
    const popW = pop.offsetWidth || 320;
    const popH = pop.offsetHeight || 150;
    let left = Math.max(4, Math.min(r.x, wrapW - popW - 4));
    let top = r.y + r.height + 6;
    if (top + popH > wrapH && r.y - popH - 6 >= 0) top = r.y - popH - 6;
    pop.style.left = `${left}px`;
    pop.style.top = `${Math.max(4, top)}px`;

    _popoverEl = pop;
    _popoverZoom = _viewer.zoom;

    _popoverEsc = (e) => {
      if (e.key !== 'Escape') return;
      e.preventDefault();
      e.stopPropagation();
      _hidePopover();
      _clearSelection();
    };
    document.addEventListener('keydown', _popoverEsc, true);

    try { ta.focus({ preventScroll: true }); } catch (_) { ta.focus(); }
  }

  // Geom-selection commits anchors via onCommit; we just need to surface
  // the create popover at the appropriate spot. (Old browser-Selection
  // mouseup path is removed.)
  function _onGeomCommit(anchors) {
    if (!anchors || !anchors.length) {
      _hidePopover();
      return;
    }
    _showCreatePopover(anchors);
  }

  /* V3.628 — click a highlight ON THE PAGE to open its comment.
   *
   * `.ann-rect` stays `pointer-events:none` on purpose (making the rects
   * clickable is what caused the old "blinky selection" bug — they sit over
   * the text layer and swallow drag starts). So resolve the click
   * geometrically instead, exactly as the touch reader already does via
   * annotationAt(). A click that ENDED a drag is ignored: the create
   * popover is open in that case, and geom-selection reports a committed
   * selection. */
  function _onContainerClick(ev) {
    if (!_viewer || !_onAnnotationClick) return;
    if (_popoverEl) return;                       // just finished a selection
    if (ev.target && ev.target.closest && ev.target.closest('.ann-popover')) return;
    const G = window.GEOM_SELECTION;
    if (G && G.selectedAnchors && (G.selectedAnchors() || []).length) return;
    let wrap = ev.target;
    while (wrap && (!wrap.classList || !wrap.classList.contains('pv-page-wrap'))) {
      wrap = wrap.parentElement;
    }
    if (!wrap) return;
    const page = parseInt(wrap.dataset.page, 10);
    if (!page) return;
    const r = wrap.getBoundingClientRect();
    const id = annotationAt(page, ev.clientX - r.left, ev.clientY - r.top);
    if (!id) return;
    ev.preventDefault();
    ev.stopPropagation();
    _onAnnotationClick(id);
  }

  /* V3.628 — cursor affordance for the above. The rects can't take :hover
   * (pointer-events:none), so hit-test on move — rAF-throttled to at most
   * one test per frame, and skipped entirely while selecting or with no
   * annotations loaded. */
  let _moveRaf = 0;
  function _onContainerMove(ev) {
    if (!_viewer || !_onAnnotationClick || !_annotations.length) return;
    if (_moveRaf) return;
    const cx = ev.clientX, cy = ev.clientY;
    _moveRaf = requestAnimationFrame(() => {
      _moveRaf = 0;
      if (!_viewer || !_container) return;
      let wrap = document.elementFromPoint(cx, cy);
      while (wrap && (!wrap.classList || !wrap.classList.contains('pv-page-wrap'))) {
        wrap = wrap.parentElement;
      }
      if (!wrap) { _container.style.cursor = ''; return; }
      const page = parseInt(wrap.dataset.page, 10);
      if (!page) { _container.style.cursor = ''; return; }
      const r = wrap.getBoundingClientRect();
      const hit = annotationAt(page, cx - r.left, cy - r.top);
      _container.style.cursor = hit ? 'pointer' : '';
    });
  }

  function _onDocClick(ev) {
    if (_popoverEl && _popoverEl.contains(ev.target)) return;
    // V3.613 — taps inside an APP_SHEET bottom sheet (the mobile reader's
    // post-selection surface) synthesize mousedown on iOS; the sheet is a
    // body child, so without this guard every tap in it would clear the
    // selection preview mid-interaction.
    if (ev.target && ev.target.closest && ev.target.closest('.app-sheet-back')) return;
    // The draft link picker opened from the popover's "+ draft…" chip is a
    // body-level modal — interacting with it must not tear the popover down.
    if (ev.target && ev.target.closest && ev.target.closest('#lp-overlays-linkmodal')) return;
    // V3.620 — everywhere else dismisses, INCLUDING plain clicks inside the
    // viewer (the old bubble survived those with stale anchors — clicking a
    // swatch then highlighted text that no longer looked selected).
    // _clearSelection() is drag-safe, so a mousedown that begins a new
    // selection gesture is never harmed.
    _hidePopover();
    _clearSelection();
  }

  // ---- Render existing highlights ----------------------------------------

  function _colorById(id) {
    return _getColors().find(c => c.id === id)
      || (window.ANNOTATION_COLORS && window.ANNOTATION_COLORS.byId(id))
      || { hex: '#facc15', name: 'Note' };
  }

  function _ensurePageOverlay(pageNumber) {
    const node = _viewer.getPageNode(pageNumber);
    return node ? node.overlay : null;
  }

  function _clearPageOverlay(pageNumber) {
    const ov = _ensurePageOverlay(pageNumber);
    if (ov) ov.innerHTML = '';
  }

  function _renderRectsForPage(pageNumber, annsOnPage) {
    const ov = _ensurePageOverlay(pageNumber);
    if (!ov) return;
    ov.innerHTML = '';
    for (const ann of annsOnPage) {
      if (!_filterFn(ann)) continue;
      const pages = (ann.target && ann.target.pages) || [];
      const pageAnchor = pages.find(p => p.page === pageNumber);
      if (!pageAnchor) continue;
      const rects = window.ANNOTATION_ANCHOR.anchorToRects(_viewer, pageAnchor);
      const color = _colorById(ann.color_id);
      // V3.103 — when the highlight cites into multiple drafts AND more
      // than one draft overlay is active, draw a thin colored left-
      // stripe per draft so the user can see which draft the
      // highlight is evidence for. Skip for "general" highlights
      // (empty cite_in_drafts).
      // Falls back to legacy ann.bucket_ids when cite_in_drafts is
      // absent, so existing data renders correctly until migrated.
      const annDrafts = Array.isArray(ann.cite_in_drafts) && ann.cite_in_drafts.length
        ? ann.cite_in_drafts
        : (Array.isArray(ann.bucket_ids) ? ann.bucket_ids : []);
      const activeOverlayIds = (window.PAPER_OVERLAYS && window.PAPER_OVERLAYS.getActiveDraftIds)
        ? new Set(window.PAPER_OVERLAYS.getActiveDraftIds())
        : new Set();
      const showStripes = annDrafts.length > 0 && activeOverlayIds.size > 1;
      for (let ri = 0; ri < rects.length; ri++) {
        const r = rects[ri];
        const div = document.createElement('div');
        div.className = 'ann-rect';
        if (ann.id === _focusedId) div.classList.add('ann-rect-focused');
        div.dataset.annId = ann.id;
        div.style.left = `${r.x}px`;
        div.style.top = `${r.y}px`;
        div.style.width = `${r.width}px`;
        div.style.height = `${r.height}px`;
        // Use a translucent background; mix-blend-mode: multiply (in CSS)
        // keeps the underlying canvas text legible.
        div.style.backgroundColor = `${color.hex}99`;
        // No click handler / no pointer-events — see CSS comment in
        // .ann-rect for why. Click-to-focus is via the side panel.
        ov.appendChild(div);
        // Add left-edge stripes ONLY on the first rect of the highlight
        // (otherwise multi-line highlights duplicate the stripe per line,
        // which clutters the page). 3px stripes side-by-side per bucket.
        if (showStripes && ri === 0 && window.PAPER_OVERLAYS) {
          const stripeDrafts = annDrafts.filter(id => activeOverlayIds.has(id));
          const colorFor = window.PAPER_OVERLAYS.getColorForDraft;
          stripeDrafts.forEach((did, idx) => {
            const s = document.createElement('div');
            s.className = 'ann-bucket-stripe';
            s.style.left = `${r.x - 4 - idx * 4}px`;
            s.style.top = `${r.y}px`;
            s.style.width = '3px';
            s.style.height = `${r.height}px`;
            s.style.backgroundColor = colorFor(did);
            s.title = did;
            ov.appendChild(s);
          });
        }
      }
    }
  }

  function redrawPage(pageNumber) {
    if (!_viewer) return;   // overlay hasn't been initialized yet
    const annsOnPage = _annotations.filter(a => {
      const pages = (a.target && a.target.pages) || [];
      return pages.some(p => p.page === pageNumber);
    });
    _renderRectsForPage(pageNumber, annsOnPage);
  }

  function redraw() {
    if (!_viewer) return;
    // V3.620 — a zoom/refit invalidates the popover's stored anchors
    // (page-local coordinates change scale), so dismiss it. Snapshot-driven
    // redraws keep the same zoom and leave an open popover alone — a
    // teammate's highlight landing mustn't eat a half-typed comment.
    if (_popoverEl && _popoverZoom != null && _viewer.zoom !== _popoverZoom) {
      _hidePopover();
      _clearSelection();
    }
    for (let p = 1; p <= _viewer.numPages; p++) {
      redrawPage(p);
    }
  }

  function setAnnotations(list) {
    _annotations = Array.isArray(list) ? list.slice() : [];
    redraw();
  }

  function setFilter(fn) {
    _filterFn = typeof fn === 'function' ? fn : () => true;
    redraw();
  }

  /* V3.613 — coordinate hit-test for touch: .ann-rect is deliberately
   * pointer-events:none, so the mobile reader resolves a tap to an
   * annotation id by geometry. (x, y) are page-wrap-local CSS pixels on
   * pageNumber. Respects the active filter; smallest-area hit wins so a
   * short highlight nested inside a long one is pickable. Returns the
   * annotation id or null. */
  function annotationAt(pageNumber, x, y) {
    if (!_viewer) return null;
    let bestId = null, bestArea = Infinity;
    for (const ann of _annotations) {
      if (!_filterFn(ann)) continue;
      const pages = (ann.target && ann.target.pages) || [];
      const pageAnchor = pages.find(p => p.page === pageNumber);
      if (!pageAnchor) continue;
      let rects = [];
      try { rects = window.ANNOTATION_ANCHOR.anchorToRects(_viewer, pageAnchor) || []; }
      catch (_) { continue; }
      for (const r of rects) {
        if (x >= r.x && x <= r.x + r.width && y >= r.y && y <= r.y + r.height) {
          const area = r.width * r.height;
          if (area < bestArea) { bestArea = area; bestId = ann.id; }
        }
      }
    }
    return bestId;
  }

  function focus(annotationId) {
    _focusedId = annotationId;
    if (!annotationId) { redraw(); return; }
    const ann = _annotations.find(a => a.id === annotationId);
    if (!ann) { redraw(); return; }
    const pages = (ann.target && ann.target.pages) || [];
    if (!pages.length) { redraw(); return; }
    const firstPage = pages[0].page;
    _viewer.gotoPage(firstPage);
    redraw();
    setTimeout(() => {
      const node = _viewer.getPageNode(firstPage);
      if (!node) return;
      // Use anchorToRects so the rect is in current-zoom coordinates,
      // not the saved-zoom coords stored on the anchor.
      const rects = window.ANNOTATION_ANCHOR.anchorToRects(_viewer, pages[0]);
      const r = (rects && rects[0]) || (pages[0].rects && pages[0].rects[0]);
      if (!r) return;
      const container = document.getElementById('lp-viewer');
      if (!container) return;
      // Center the rect vertically in the viewer container.
      const rectCenterY = node.wrap.offsetTop + r.y + r.height / 2;
      const target = rectCenterY - container.clientHeight / 2;
      container.scrollTo({
        top: Math.max(0, target),
        behavior: 'smooth',
      });
    }, 50);
  }

  function init(opts) {
    _viewer = opts.viewer;
    _container = opts.container;
    _onCreate = opts.onCreate || null;
    _onAnnotationClick = opts.onAnnotationClick || null;   // V3.628
    _onCaptureEquation = opts.onCaptureEquation || null;   // E3
    _onCaptureFigure = opts.onCaptureFigure || null;       // V3.610
    _getColors = opts.getColors || (() => []);
    document.addEventListener('mousedown', _onDocClick);
    if (_container) {
      _container.addEventListener('click', _onContainerClick);
      _container.addEventListener('mousemove', _onContainerMove);
    }
  }

  // Public so library-paper.js can pass it as the onCommit callback to
  // GEOM_SELECTION.init.
  function onSelectionCommit(anchors) { _onGeomCommit(anchors); }

  function destroy() {
    _hidePopover();
    document.removeEventListener('mousedown', _onDocClick);
    if (_container) {
      _container.removeEventListener('click', _onContainerClick);
      _container.removeEventListener('mousemove', _onContainerMove);
      _container.style.cursor = '';
    }
    if (_moveRaf) { cancelAnimationFrame(_moveRaf); _moveRaf = 0; }
    _annotations = [];
    _onAnnotationClick = null;
    // V3.621 — fully reset: destroy() used to leave _viewer/_filterFn/
    // callbacks pointing at the outgoing tab, so anything that called
    // redraw() between detach and the next init() (e.g. a pane-resizer
    // drag hitting _applyLayout) painted an emptied list into the OLD
    // viewer's page nodes. redraw()/focus() no-op on _viewer == null.
    _viewer = null;
    _container = null;
    _onCreate = null;
    _onCaptureEquation = null;
    _onCaptureFigure = null;
    _getColors = () => [];
    _filterFn = () => true;
    _focusedId = null;
  }

  // V3.620 — lets library-paper's PAPER_OVERLAYS.onChange handler refresh
  // the popover's draft chips after the "+ draft…" link picker saves.
  function refreshPopoverDrafts() {
    if (_popoverRefreshDrafts) _popoverRefreshDrafts();
  }

  window.ANNOTATION_OVERLAY = {
    init,
    setAnnotations,
    setFilter,
    redraw,
    redrawPage,
    focus,
    annotationAt,
    destroy,
    onSelectionCommit,
    refreshPopoverDrafts,
  };
})();
