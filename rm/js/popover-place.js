/* popover-place.js — V3.827: keep a fixed-position popover fully on screen.
 *
 * Alex: "when the user selects the organize button, the full popup should be
 * shown, and none of it should be off screen". The Organize / associations
 * popovers used to clamp only their top-left corner, so a tall popover opened
 * near the bottom of the window ran off it. `fit()` measures the popover
 * after it is in the DOM and places it below the anchor, above it when below
 * does not fit, and otherwise as high as needed — never past any edge.
 *
 *   POPOVER_PLACE.compute({ w, h, anchor:{left,top,right,bottom}, viewport:{w,h}, preferLeft?, gap?, margin? })
 *     → { left, top, placement: 'below'|'above'|'clamped', maxHeight }
 *   POPOVER_PLACE.fit(popEl, anchorRect, { preferLeft?, gap?, margin? }) → the same, applied
 *
 * compute() is pure (node-tested). */
(function (root) {
  'use strict';

  function compute(o) {
    const gap = o.gap == null ? 6 : o.gap, margin = o.margin == null ? 8 : o.margin;
    const vw = o.viewport.w, vh = o.viewport.h;
    const maxHeight = Math.max(80, vh - 2 * margin);
    const h = Math.min(o.h, maxHeight), w = Math.min(o.w, Math.max(120, vw - 2 * margin));
    const a = o.anchor;
    const wantLeft = typeof o.preferLeft === 'number' ? o.preferLeft : a.left;
    const left = Math.max(margin, Math.min(wantLeft, vw - w - margin));
    let top = a.bottom + gap, placement = 'below';
    if (top + h > vh - margin) {
      if (a.top - gap - h >= margin) { top = a.top - gap - h; placement = 'above'; }
      else { top = Math.max(margin, vh - margin - h); placement = 'clamped'; }
    }
    return { left: Math.round(left), top: Math.round(top), placement, maxHeight, width: Math.round(w) };
  }

  function fit(pop, anchorRect, opts) {
    opts = opts || {};
    if (!pop || !anchorRect) return null;
    pop.style.position = 'fixed';
    pop.style.boxSizing = 'border-box';   // max-height / width then include padding + border — what the window sees
    pop.style.maxHeight = '';
    const vw = root.innerWidth || document.documentElement.clientWidth;
    const vh = root.innerHeight || document.documentElement.clientHeight;
    const r = compute({ w: pop.offsetWidth || 340, h: pop.offsetHeight || 200, anchor: anchorRect, viewport: { w: vw, h: vh }, preferLeft: opts.preferLeft, gap: opts.gap, margin: opts.margin });
    pop.style.left = r.left + 'px';
    pop.style.top = r.top + 'px';
    pop.style.maxHeight = r.maxHeight + 'px';
    if (pop.offsetWidth > r.width) pop.style.width = r.width + 'px';
    pop.style.overflow = 'auto';
    pop.dataset.placement = r.placement;
    return r;
  }

  const API = { compute, fit };
  if (typeof module !== 'undefined' && module.exports) module.exports = API;
  if (root) root.POPOVER_PLACE = API;
})(typeof window !== 'undefined' ? window : null);
