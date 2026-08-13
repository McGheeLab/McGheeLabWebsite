/* paper-fig-fit.js — shared figure-box auto-fit (Layout Mode II R1, V3.405)
 *
 * THE sub-block rule for figure boxes: the user sizes the BOX; the image
 * and caption inside lay themselves out automatically — the image is
 * maximized within the box width and the optional max_h image-height cap
 * (aspect preserved, letterboxed when height-bound), the caption spans
 * the box and is never touched by hand.
 *
 * One pure function shared by the Document view's block builder and the
 * live resize drag, and Node-testable (module.exports guard below) so
 * the fit math has a real harness.
 */
(function () {
  'use strict';

  var MM_PX = 96 / 25.4;   // CSS px per mm at 96 dpi (matches parseWidth/_snapTargets)
  var CAP_GAP = 6;         // .pdv-figcap margin-top (px)

  /* Maximize the image inside a boxWpx × (maxHmm cap) area.
   *
   *   fit({ boxWpx, maxHmm, aspect, captionPx, gap, mmPx }) →
   *     { imgWpx, imgHpx, boxHpx, bound }
   *
   * aspect = naturalW / naturalH. captionPx is the caption height
   * MEASURED AT BOX WIDTH by the caller — fit never guesses it; image
   * sizing is independent of the caption. bound:
   *   'width'  — image fills the box width (no cap set)
   *   'height' — the cap binds (image letterboxed, narrower than box)
   *   'none'   — a cap exists but sits at/above natural height (inert)
   */
  function fit(opts) {
    opts = opts || {};
    var boxWpx = opts.boxWpx > 0 ? opts.boxWpx : 0;
    var aspect = opts.aspect > 0 ? opts.aspect : null;
    var gap = (typeof opts.gap === 'number') ? opts.gap : CAP_GAP;
    var captionPx = opts.captionPx > 0 ? opts.captionPx : 0;
    var mmPx = opts.mmPx > 0 ? opts.mmPx : MM_PX;

    if (!aspect || !boxWpx) {
      /* Aspect unknown (image not decoded yet / missing): width-bound
       * CSS fallback — the caller keeps width:100%; height:auto. */
      return { imgWpx: boxWpx, imgHpx: null, boxHpx: null, bound: 'width' };
    }

    var widthBoundH = boxWpx / aspect;         // image height when it fills the box width
    var maxHmm = opts.maxHmm > 0 ? opts.maxHmm : null;
    var maxHpx = maxHmm ? maxHmm * mmPx : Infinity;

    var imgHpx = Math.min(widthBoundH, maxHpx);
    var imgWpx = Math.min(boxWpx, imgHpx * aspect);
    var bound = (maxHpx < widthBoundH - 0.5) ? 'height' : (maxHmm ? 'none' : 'width');
    return {
      imgWpx: imgWpx,
      imgHpx: imgHpx,
      boxHpx: imgHpx + (captionPx ? gap + captionPx : 0),
      bound: bound,
    };
  }

  var api = { fit: fit, MM_PX: MM_PX, CAP_GAP: CAP_GAP };
  if (typeof window !== 'undefined') window.PaperFigFit = api;
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
})();
