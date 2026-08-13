/* viewer-touch.js — V3.613 touch gestures for the pdf.js viewer.
 *
 * The Ourlab app's forced viewport (`user-scalable=no`, applied by
 * OurlabMobile/scripts/sync-rm.mjs) kills browser pinch-zoom, so the
 * mobile reader implements its own:
 *
 *   • PINCH — two fingers scale a CSS transform on the viewer's
 *     .pv-content wrapper (pdf-viewer's `contentWrapper` opt) during the
 *     gesture — zero pdf.js work per frame — then ONE real
 *     viewer.setZoom() fires on release. The caller wraps setZoom to
 *     redraw the annotation overlay, so highlights re-align for free.
 *     Scroll is re-anchored so the pinched point stays under the fingers.
 *   • DOUBLE-TAP — toggles fit-width ↔ 2× fit, centered on the tap.
 *   • TAP on a highlight — .ann-rect is pointer-events:none, so taps
 *     resolve by geometry via ANNOTATION_OVERLAY.annotationAt(); the
 *     caller opens its notes panel on the returned id.
 *
 * Singleton, same init/destroy contract as the rest of the reader stack:
 *
 *   VIEWER_TOUCH.init({
 *     viewer,            // pdf-viewer instance (created with contentWrapper)
 *     viewerEl,          // the scroll container
 *     onUserZoom,        // fired after a pinch commits (caller clears fit mode)
 *     onFitToggle,       // fired when a double-tap lands on fit-width
 *     onTapAnnotation,   // (annId) tap landed on an existing highlight
 *   });
 *   VIEWER_TOUCH.destroy();
 *
 * Interplay with geom-selection.js: both track their own pointers.
 * geom-selection cancels itself when a second finger lands, so a pinch
 * that starts mid-long-press wins cleanly. A quick single tap never
 * reaches geom-selection's commit path (taps don't select), so the
 * highlight hit-test here can act on it without conflict.
 */
(function () {
  'use strict';

  let _viewer = null;
  let _viewerEl = null;
  let _content = null;
  let _onUserZoom = null;
  let _onFitToggle = null;
  let _onTapAnnotation = null;

  const ZOOM_MIN = 0.4, ZOOM_MAX = 4.0;
  const TAP_MAX_MS = 250;        // press longer than this is not a tap
  const TAP_SLOP_PX = 8;
  const DBL_MS = 300;            // max gap between double-tap taps
  const DBL_SLOP_PX = 30;

  // Active touch pointers on the viewer: pointerId → {x, y}
  const _pointers = new Map();

  const _pinch = {
    active: false,
    startDist: 0,
    startZoom: 1,
    startScrollLeft: 0,
    startScrollTop: 0,
    // Gesture midpoint in viewer-viewport coords (constant origin choice)
    midX: 0, midY: 0,
    // Live midpoint drift (two-finger pan)
    dMidX: 0, dMidY: 0,
    scale: 1,
  };

  const _tap = { downX: 0, downY: 0, downT: 0, lastUpT: 0, lastUpX: 0, lastUpY: 0, moved: false };

  function _dist() {
    const pts = Array.from(_pointers.values());
    if (pts.length < 2) return 0;
    const dx = pts[0].x - pts[1].x, dy = pts[0].y - pts[1].y;
    return Math.hypot(dx, dy) || 1;
  }

  function _mid() {
    const pts = Array.from(_pointers.values());
    const r = _viewerEl.getBoundingClientRect();
    return {
      x: (pts[0].x + pts[1].x) / 2 - r.left,
      y: (pts[0].y + pts[1].y) / 2 - r.top,
    };
  }

  function _clampScale(s) {
    const z = _pinch.startZoom;
    return Math.max(ZOOM_MIN / z, Math.min(ZOOM_MAX / z, s));
  }

  function _beginPinch() {
    _pinch.active = true;
    _pinch.startDist = _dist();
    _pinch.startZoom = _viewer.zoom;
    _pinch.startScrollLeft = _viewerEl.scrollLeft;
    _pinch.startScrollTop = _viewerEl.scrollTop;
    const m = _mid();
    _pinch.midX = m.x;
    _pinch.midY = m.y;
    _pinch.dMidX = 0;
    _pinch.dMidY = 0;
    _pinch.scale = 1;
    if (_content) {
      // Origin at the content-space point under the gesture midpoint so
      // that point stays fixed while the transform scales around it.
      _content.style.transformOrigin =
        `${_pinch.startScrollLeft + _pinch.midX}px ${_pinch.startScrollTop + _pinch.midY}px`;
      _content.style.willChange = 'transform';
    }
  }

  function _updatePinch() {
    if (!_pinch.active || !_content) return;
    const s = _clampScale(_dist() / _pinch.startDist);
    _pinch.scale = s;
    const m = _mid();
    _pinch.dMidX = m.x - _pinch.midX;
    _pinch.dMidY = m.y - _pinch.midY;
    _content.style.transform =
      `translate(${_pinch.dMidX}px, ${_pinch.dMidY}px) scale(${s})`;
  }

  /* V3.615 — pre-size every rendered page's shell (wrap + layers +
   * --scale-factor) to the new zoom SYNCHRONOUSLY. Layout change, scroll
   * re-anchor, and transform removal then land in ONE paint — no flash of
   * the old zoom and no late scroll jump while pdf.js re-renders the
   * canvases underneath (they sharpen in place). */
  function _presizeShells(ratio) {
    _viewer.forEachPage((node) => {
      const w = parseFloat(node.wrap.style.width) || 0;
      const h = parseFloat(node.wrap.style.height) || 0;
      if (!w || !h) return;
      const nw = `${Math.floor(w * ratio)}px`;
      const nh = `${Math.floor(h * ratio)}px`;
      node.wrap.style.width = nw;      node.wrap.style.height = nh;
      node.canvas.style.width = nw;    node.canvas.style.height = nh;
      node.textLayer.style.width = nw; node.textLayer.style.height = nh;
      node.overlay.style.width = nw;   node.overlay.style.height = nh;
      if (node.selLayer) { node.selLayer.style.width = nw; node.selLayer.style.height = nh; }
      const sf = parseFloat(node.wrap.style.getPropertyValue('--scale-factor')) || 0;
      if (sf) {
        node.wrap.style.setProperty('--scale-factor', sf * ratio);
        node.textLayer.style.setProperty('--scale-factor', sf * ratio);
      }
      const tsf = parseFloat(node.wrap.style.getPropertyValue('--total-scale-factor')) || 0;
      if (tsf) node.wrap.style.setProperty('--total-scale-factor', tsf * ratio);
    });
  }

  /* V3.615 — the one zoom-application path (pinch release + double-tap):
   * presize shells → anchored scroll → drop the gesture transform, all in
   * one frame; then kick the real re-render. viewer.zoom flips
   * synchronously inside setZoom, so the immediate overlay redraw puts
   * highlights on the presized layout right away (the patched setZoom
   * redraws once more when the canvases are sharp). */
  async function _applyZoom(newZoom, anchor) {
    const startZoom = _viewer.zoom;
    const ratio = newZoom / startZoom;
    const fromLeft = (anchor.fromLeft != null) ? anchor.fromLeft : _viewerEl.scrollLeft;
    const fromTop = (anchor.fromTop != null) ? anchor.fromTop : _viewerEl.scrollTop;
    _presizeShells(ratio);
    _viewerEl.scrollLeft = (fromLeft + anchor.cx) * ratio - anchor.cx - (anchor.dMidX || 0);
    _viewerEl.scrollTop = (fromTop + anchor.cy) * ratio - anchor.cy - (anchor.dMidY || 0);
    if (_content) {
      _content.style.transform = '';
      _content.style.transformOrigin = '';
      _content.style.willChange = '';
    }
    const done = _viewer.setZoom(newZoom);
    if (window.ANNOTATION_OVERLAY) {
      try { window.ANNOTATION_OVERLAY.redraw(); } catch (e) { /* redrawn again on completion */ }
    }
    try { await done; } catch (e) { console.warn('[viewer-touch] setZoom failed:', e); }
  }

  async function _endPinch() {
    if (!_pinch.active) return;
    _pinch.active = false;
    const s = _pinch.scale;
    // V3.614 — snap the release zoom to full-page / column fit when close.
    const newZoom = _snapZoom(
      Math.max(ZOOM_MIN, Math.min(ZOOM_MAX, _pinch.startZoom * s)));
    if (Math.abs(newZoom - _pinch.startZoom) < 0.005) {
      // No real change — just drop the gesture transform.
      if (_content) {
        _content.style.transform = '';
        _content.style.transformOrigin = '';
        _content.style.willChange = '';
      }
      return;
    }
    await _applyZoom(newZoom, {
      cx: _pinch.midX,
      cy: _pinch.midY,
      dMidX: _pinch.dMidX,
      dMidY: _pinch.dMidY,
      fromLeft: _pinch.startScrollLeft,
      fromTop: _pinch.startScrollTop,
    });
    _snapColumnEdge();
    if (_onUserZoom) { try { _onUserZoom(_viewer.zoom); } catch (e) { console.error(e); } }
  }

  /* V3.614 — after a snap to column fit, nudge the horizontal scroll onto
   * the nearest column edge (page-left for the left column, page-right for
   * the right) so the column sits framed instead of straddling the cut. */
  function _snapColumnEdge() {
    const fit = _fitZoom();
    if (fit == null || Math.abs(_viewer.zoom - fit * 2) > 0.001) return;
    let pageW = 0, pageLeft = 0;
    _viewer.forEachPage((node) => {
      if (pageW) return;
      const w = parseFloat(node.wrap.style.width) || 0;
      if (w > 0) { pageW = w; pageLeft = node.wrap.offsetLeft; }
    });
    if (!pageW) return;
    const vw = _viewerEl.clientWidth;
    const targets = [pageLeft, pageLeft + pageW - vw];   // left col, right col
    for (const t of targets) {
      if (Math.abs(_viewerEl.scrollLeft - t) < vw * 0.18) {
        _viewerEl.scrollLeft = Math.max(0, t);
        return;
      }
    }
  }

  // ---- fit math ------------------------------------------------------------

  /* V3.614 — zoom anchors a pinch release snaps to: full-page fit and
   * COLUMN fit (half the page width fills the viewport — one column of a
   * two-column paper). Reading zoom on a phone is almost always one of
   * these two; free zoom stays available outside the snap band. */
  const SNAP_TOLERANCE = 0.12;   // snap when within ±12% of an anchor

  function _anchorZooms() {
    const fit = _fitZoom();
    if (fit == null) return [];
    const anchors = [fit];
    const col = fit * 2;   // half the page across the viewport
    if (col <= ZOOM_MAX) anchors.push(col);
    return anchors;
  }

  function _snapZoom(z) {
    for (const a of _anchorZooms()) {
      if (Math.abs(z - a) / a <= SNAP_TOLERANCE) return a;
    }
    return z;
  }

  function _fitZoom() {
    // Derive the natural page width from any rendered page wrap: its CSS
    // width is naturalWidth × zoom.
    let naturalW = 0;
    _viewer.forEachPage((node) => {
      if (naturalW) return;
      const w = parseFloat(node.wrap.style.width) || 0;
      if (w > 0) naturalW = w / _viewer.zoom;
    });
    if (!naturalW) return null;
    const targetW = _viewerEl.clientWidth - 24;
    if (targetW <= 0) return null;
    return Math.max(ZOOM_MIN, Math.min(ZOOM_MAX, targetW / naturalW));
  }

  async function _zoomTo(z, cx, cy) {
    // V3.615 — same single-frame path as pinch release (no jitter).
    await _applyZoom(z, { cx, cy });
  }

  async function _onDoubleTap(clientX, clientY) {
    const fit = _fitZoom();
    if (fit == null) return;
    const r = _viewerEl.getBoundingClientRect();
    const cx = clientX - r.left, cy = clientY - r.top;
    if (Math.abs(_viewer.zoom - fit) / fit < 0.05) {
      // At fit → zoom in 2×, centered on the tap.
      await _zoomTo(Math.min(ZOOM_MAX, fit * 2), cx, cy);
      if (_onUserZoom) { try { _onUserZoom(_viewer.zoom); } catch (e) { console.error(e); } }
    } else {
      // Anywhere else → back to fit-width.
      await _zoomTo(fit, cx, cy);
      if (_onFitToggle) { try { _onFitToggle(); } catch (e) { console.error(e); } }
    }
  }

  // ---- tap → highlight hit-test ---------------------------------------------

  function _pageWrapAt(clientX, clientY) {
    let el = document.elementFromPoint(clientX, clientY);
    while (el && (!el.classList || !el.classList.contains('pv-page-wrap'))) {
      el = el.parentElement;
    }
    return el;
  }

  function _hitAnnotation(clientX, clientY) {
    if (!_onTapAnnotation || !window.ANNOTATION_OVERLAY || !window.ANNOTATION_OVERLAY.annotationAt) return false;
    const wrap = _pageWrapAt(clientX, clientY);
    if (!wrap) return false;
    const page = parseInt(wrap.dataset.page, 10);
    if (!page) return false;
    const r = wrap.getBoundingClientRect();
    const annId = window.ANNOTATION_OVERLAY.annotationAt(page, clientX - r.left, clientY - r.top);
    if (!annId) return false;
    try { _onTapAnnotation(annId); } catch (e) { console.error(e); }
    return true;
  }

  // ---- pointer plumbing ------------------------------------------------------

  function _onPointerDown(ev) {
    if (ev.pointerType === 'mouse') return;
    _pointers.set(ev.pointerId, { x: ev.clientX, y: ev.clientY });
    if (_pointers.size === 2) {
      _beginPinch();
    } else if (_pointers.size === 1) {
      _tap.downX = ev.clientX;
      _tap.downY = ev.clientY;
      _tap.downT = ev.timeStamp;
      _tap.moved = false;
    }
  }

  function _onPointerMove(ev) {
    if (!_pointers.has(ev.pointerId)) return;
    _pointers.set(ev.pointerId, { x: ev.clientX, y: ev.clientY });
    if (_pinch.active) {
      _updatePinch();
      return;
    }
    if (_pointers.size === 1) {
      const dx = ev.clientX - _tap.downX, dy = ev.clientY - _tap.downY;
      if (dx * dx + dy * dy > TAP_SLOP_PX * TAP_SLOP_PX) _tap.moved = true;
    }
  }

  function _onPointerUp(ev) {
    if (!_pointers.has(ev.pointerId)) return;
    _pointers.delete(ev.pointerId);
    if (_pinch.active && _pointers.size < 2) {
      _endPinch();
      return;
    }
    if (_pointers.size !== 0) return;

    // Single-finger release: tap / double-tap detection. Ignore when the
    // press was long (a long-press belongs to geom-selection) or drifted.
    const dt = ev.timeStamp - _tap.downT;
    if (_tap.moved || dt > TAP_MAX_MS) return;
    const sinceLast = ev.timeStamp - _tap.lastUpT;
    const dx = ev.clientX - _tap.lastUpX, dy = ev.clientY - _tap.lastUpY;
    if (sinceLast > 0 && sinceLast < DBL_MS && dx * dx + dy * dy < DBL_SLOP_PX * DBL_SLOP_PX) {
      _tap.lastUpT = 0;   // consume the pair
      _onDoubleTap(ev.clientX, ev.clientY);
      return;
    }
    _tap.lastUpT = ev.timeStamp;
    _tap.lastUpX = ev.clientX;
    _tap.lastUpY = ev.clientY;
    // Deliberately act on the FIRST tap (no double-tap delay): a first tap
    // of a double on a highlight harmlessly focuses it.
    _hitAnnotation(ev.clientX, ev.clientY);
  }

  function _onPointerCancel(ev) {
    if (!_pointers.has(ev.pointerId)) return;
    _pointers.delete(ev.pointerId);
    if (_pinch.active && _pointers.size < 2) {
      // Cancelled mid-pinch: drop the transform without committing.
      _pinch.active = false;
      if (_content) {
        _content.style.transform = '';
        _content.style.transformOrigin = '';
        _content.style.willChange = '';
      }
    }
  }

  // Non-passive: block native scrolling while two fingers are pinching
  // (mobile web / ?mobileShell=1 preview; in the app the viewport already
  // suppresses page zoom, but two-finger scroll would still fight the
  // transform).
  function _onTouchMove(ev) {
    if (_pinch.active) ev.preventDefault();
  }

  function init(opts) {
    destroy();
    _viewer = opts.viewer;
    _viewerEl = opts.viewerEl;
    _content = (opts.viewer && opts.viewer.getContentEl && opts.viewer.getContentEl()) || null;
    _onUserZoom = opts.onUserZoom || null;
    _onFitToggle = opts.onFitToggle || null;
    _onTapAnnotation = opts.onTapAnnotation || null;
    if (!window.PointerEvent || !_viewerEl) return;
    _viewerEl.addEventListener('pointerdown', _onPointerDown);
    _viewerEl.addEventListener('pointermove', _onPointerMove);
    _viewerEl.addEventListener('pointerup', _onPointerUp);
    _viewerEl.addEventListener('pointercancel', _onPointerCancel);
    _viewerEl.addEventListener('touchmove', _onTouchMove, { passive: false });
  }

  function destroy() {
    if (_viewerEl) {
      _viewerEl.removeEventListener('pointerdown', _onPointerDown);
      _viewerEl.removeEventListener('pointermove', _onPointerMove);
      _viewerEl.removeEventListener('pointerup', _onPointerUp);
      _viewerEl.removeEventListener('pointercancel', _onPointerCancel);
      _viewerEl.removeEventListener('touchmove', _onTouchMove);
    }
    if (_content) {
      _content.style.transform = '';
      _content.style.transformOrigin = '';
      _content.style.willChange = '';
    }
    _pointers.clear();
    _pinch.active = false;
    _viewer = null;
    _viewerEl = null;
    _content = null;
    _onUserZoom = null;
    _onFitToggle = null;
    _onTapAnnotation = null;
  }

  window.VIEWER_TOUCH = { init, destroy };
})();
