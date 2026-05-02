/* annotation-anchor.js — render saved annotation rects at the current zoom.
 *
 * Anchor source-of-truth: geom-selection.js stores per-page anchors with
 *   - rects[]      page-wrap-local CSS pixels at save time
 *   - saved_scale  the viewer.zoom at which the rects were captured
 *
 * To render at any zoom, we just multiply by (currentScale / savedScale).
 * No DOM walking, no fuzzy text matching — those approaches all produced
 * incorrect rects on multi-column / figure-heavy pages.
 *
 * Public API (window.ANNOTATION_ANCHOR):
 *   anchorToRects(viewer, pageAnchor)  →  [{x, y, width, height}, ...]
 */
(function () {
  function anchorToRects(viewer, pageAnchor) {
    if (!pageAnchor) return [];
    const savedRects = pageAnchor.rects || [];
    const savedScale = pageAnchor.saved_scale;
    if (!savedRects.length || typeof savedScale !== 'number' || savedScale <= 0) {
      return savedRects;
    }
    const factor = viewer.zoom / savedScale;
    return savedRects.map(r => ({
      x: r.x * factor,
      y: r.y * factor,
      width: r.width * factor,
      height: r.height * factor,
    }));
  }

  window.ANNOTATION_ANCHOR = { anchorToRects };
})();
