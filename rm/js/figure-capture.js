/* figure-capture.js — capture FIGURES while reading a paper
 * (V3.610, figure-board program R2).
 *
 * Flow: marquee-select the figure region in the reader (geom-selection's
 * V3.610 marquee mode — ⬚ Snip toolbar toggle or Alt-drag; a text
 * selection works too) → the annotation toolbar's 🖼 action calls
 * FIGURE_CAPTURE.open({anchors}) → the region is SNIPPED from the
 * rendered page canvas at up to 1200px wide → a small dialog (snip
 * preview; name + note) → the full-size snip uploads to Storage via
 * PAPER_FIGURES.uploadImage (paper-figures/{libraryItemId}/ — the rule
 * already allows image/*) → saved as a REGULAR reader annotation
 * (papers/{itemId}/annotations via ANNOTATION_SYNC) with extra fields:
 *
 *   kind: 'figure', annotation_type: 'figure',
 *   name, image: {storage_path, download_url},
 *   snip_data_uri (≤240px JPEG thumb, inline fallback),
 *   comment (the note), target: {pages: anchors}
 *
 * It therefore inherits anchoring, lab/private visibility, and the
 * type-filter pills for free (equation-capture's exact trick). The paper
 * builder's 🧭 Figure board lists these captures for placement as
 * reference cards.
 *
 * V3.616 — FIGURE HOTSPOTS: nobody discovered the ⬚ Snip toggle, so the
 * reader now identifies figures itself (pdf-viewer._detectFigureRegions:
 * connected ink minus text items) and paints a click target over each —
 * hover shows a dashed outline + "🖼 Snip figure", one click opens the
 * capture dialog for exactly that region. refreshHotspots(pageNum) is
 * called from library-paper's onPageReady on every page render, so the
 * rects track zoom. Marquee/Alt-drag remains for custom regions.
 *
 * Public API (window.FIGURE_CAPTURE):
 *   init({paperId, viewer})     — per-paper wiring (reader tab attach)
 *   open({anchors})             — create flow from a selection
 *   refreshHotspots(pageNum)    — (re)paint the click-to-snip layer
 */
(function () {
  'use strict';

  var _paperId = null;
  var _viewer = null;

  function init(opts) {
    _paperId = opts.paperId || null;
    _viewer = opts.viewer || null;
  }

  /* Crop the selection's union rect from the rendered page canvas.
   * Same coordinate math as equation-capture._snipFromAnchors, but kept
   * at up to 1200px wide (figures carry detail equations don't) and
   * returned as BOTH a Blob for Storage and a small inline thumb. */
  function _snipFromAnchors(anchors) {
    return new Promise(function (resolve) {
      try {
        var a = anchors && anchors[0];
        if (!a || !a.rects || !a.rects.length || !_viewer || !_viewer.getPageNode) return resolve(null);
        var node = _viewer.getPageNode(a.page);
        if (!node || !node.canvas || !node.wrap) return resolve(null);
        var x0 = Infinity, y0 = Infinity, x1 = -Infinity, y1 = -Infinity;
        a.rects.forEach(function (r) {
          x0 = Math.min(x0, r.x); y0 = Math.min(y0, r.y);
          x1 = Math.max(x1, r.x + r.width); y1 = Math.max(y1, r.y + r.height);
        });
        var pad = 6;
        x0 = Math.max(0, x0 - pad); y0 = Math.max(0, y0 - pad);
        x1 += pad; y1 += pad;
        var cssW = node.wrap.clientWidth || 1;
        var k = node.canvas.width / cssW;
        var sx = x0 * k, sy = y0 * k, sw = (x1 - x0) * k, sh = (y1 - y0) * k;
        sw = Math.min(sw, node.canvas.width - sx);
        sh = Math.min(sh, node.canvas.height - sy);
        if (sw <= 2 || sh <= 2) return resolve(null);
        var outW = Math.min(1200, Math.round(sw));
        var outH = Math.round(sh * (outW / sw));
        var off = document.createElement('canvas');
        off.width = outW; off.height = outH;
        var ctx = off.getContext('2d');
        ctx.fillStyle = '#fff';
        ctx.fillRect(0, 0, outW, outH);
        ctx.drawImage(node.canvas, sx, sy, sw, sh, 0, 0, outW, outH);
        /* inline thumb: ≤240px, small enough for the annotation doc */
        var tW = Math.min(240, outW);
        var tH = Math.round(outH * (tW / outW));
        var toff = document.createElement('canvas');
        toff.width = tW; toff.height = tH;
        toff.getContext('2d').drawImage(off, 0, 0, tW, tH);
        var thumb = toff.toDataURL('image/jpeg', 0.8);
        var previewUri = off.toDataURL('image/jpeg', 0.85);
        off.toBlob(function (blob) {
          resolve(blob ? { blob: blob, thumb: thumb, preview: previewUri } : null);
        }, 'image/jpeg', 0.9);
      } catch (e) {
        console.warn('[fig-capture] snip failed:', e);
        resolve(null);
      }
    });
  }

  function open(opts) {
    var anchors = (opts && opts.anchors) || [];
    _snipFromAnchors(anchors).then(function (snip) {
      if (!snip) {
        alert('Could not snip that region — try re-selecting the figure (⬚ Snip mode or Alt-drag a box over it).');
        return;
      }
      _openModal(anchors, snip);
    });
  }

  function _openModal(anchors, snip) {
    var old = document.getElementById('figcap-overlay');
    if (old) old.remove();
    /* Reuses the eqcap-* modal styles from style.css — same look. */
    var overlay = document.createElement('div');
    overlay.className = 'eqcap-overlay';
    overlay.id = 'figcap-overlay';
    var card = document.createElement('div');
    card.className = 'eqcap-card';
    overlay.appendChild(card);

    var head = document.createElement('div');
    head.className = 'eqcap-head';
    head.textContent = 'Capture figure';
    card.appendChild(head);

    var snipWrap = document.createElement('div');
    snipWrap.className = 'eqcap-snip';
    var img = document.createElement('img');
    img.src = snip.preview;
    img.alt = 'Snipped figure from the paper';
    snipWrap.appendChild(img);
    card.appendChild(snipWrap);

    var nameIn = document.createElement('input');
    nameIn.type = 'text';
    nameIn.className = 'eqcap-name';
    nameIn.placeholder = 'Name (e.g. Fig 3b — stiffness vs. strain)';
    card.appendChild(nameIn);

    var noteIn = document.createElement('textarea');
    noteIn.className = 'eqcap-note';
    noteIn.rows = 2;
    noteIn.placeholder = 'Notes — why this figure is a useful reference… (behaves like any highlight comment)';
    card.appendChild(noteIn);

    var actions = document.createElement('div');
    actions.className = 'eqcap-actions';
    var cancel = document.createElement('button');
    cancel.type = 'button'; cancel.className = 'btn btn-sm'; cancel.textContent = 'Cancel';
    var save = document.createElement('button');
    save.type = 'button'; save.className = 'btn btn-sm btn-primary'; save.textContent = 'Capture';
    actions.appendChild(cancel);
    actions.appendChild(save);
    card.appendChild(actions);

    function close() {
      document.removeEventListener('keydown', onKey, true);
      overlay.remove();
    }
    function onKey(ev) { if (ev.key === 'Escape') { ev.stopPropagation(); close(); } }
    document.addEventListener('keydown', onKey, true);
    cancel.addEventListener('click', close);
    overlay.addEventListener('mousedown', function (ev) { if (ev.target === overlay) close(); });

    save.addEventListener('click', function () {
      if (!window.ANNOTATION_SYNC || !_paperId) { alert('Annotation sync unavailable.'); return; }
      if (!window.PAPER_FIGURES) { alert('Upload module unavailable.'); return; }
      save.disabled = true;
      save.textContent = 'Uploading…';
      window.PAPER_FIGURES.uploadImage(_paperId, snip.blob).then(function (up) {
        var vis = (window.ANNOTATION_PANEL && window.ANNOTATION_PANEL.getDefaultVisibility &&
                   window.ANNOTATION_PANEL.getDefaultVisibility()) || 'lab';
        return window.ANNOTATION_SYNC.create(_paperId, {
          kind: 'figure',
          annotation_type: 'figure',
          color_id: 'yellow',
          visibility: vis,
          name: nameIn.value.trim(),
          image: { storage_path: up.storage_path, download_url: up.download_url },
          snip_data_uri: snip.thumb,
          comment: noteIn.value,
          target: { pages: anchors },
        });
      }).then(function () {
        close();
        if (window.GEOM_SELECTION) window.GEOM_SELECTION.clear();
      }).catch(function (e) {
        save.disabled = false;
        save.textContent = 'Capture';
        alert('Could not save the capture: ' + (e.message || e));
      });
    });

    document.body.appendChild(overlay);
    nameIn.focus();
  }

  /* ── click-to-snip hotspots (V3.616) ─────────────────────────────── */

  function refreshHotspots(pageNum) {
    if (!_viewer || !_viewer.getPageNode || !_viewer.getFigureRegions) return;
    var node = _viewer.getPageNode(pageNum);
    if (!node || !node.wrap) return;
    var layer = node.wrap.querySelector('.fc-hotspot-layer');
    var regions = _viewer.getFigureRegions(pageNum) || [];
    if (!regions.length) {
      if (layer) layer.remove();
      return;
    }
    if (!layer) {
      layer = document.createElement('div');
      layer.className = 'fc-hotspot-layer';
      node.wrap.appendChild(layer);
    }
    layer.innerHTML = '';
    regions.forEach(function (r) {
      var hs = document.createElement('div');
      hs.className = 'fc-hotspot';
      hs.style.left = r.x + 'px';
      hs.style.top = r.y + 'px';
      hs.style.width = r.width + 'px';
      hs.style.height = r.height + 'px';
      hs.title = 'Click to snip this figure';
      var badge = document.createElement('span');
      badge.className = 'fc-hotspot-badge';
      badge.textContent = '🖼';
      hs.appendChild(badge);
      /* A drag that starts here is a selection gesture (marquee / Alt) —
       * only a genuine click opens the capture dialog. */
      var down = null;
      hs.addEventListener('pointerdown', function (e) { down = { x: e.clientX, y: e.clientY }; });
      hs.addEventListener('click', function (e) {
        if (down && Math.hypot(e.clientX - down.x, e.clientY - down.y) > 6) return;
        e.preventDefault();
        e.stopPropagation();
        open({
          anchors: [{
            page: pageNum,
            rects: [{ x: r.x, y: r.y, width: r.width, height: r.height }],
            saved_scale: _viewer.zoom,
            marquee: true,
          }],
        });
      });
      layer.appendChild(hs);
    });
  }

  window.FIGURE_CAPTURE = {
    init: init,
    open: open,
    refreshHotspots: refreshHotspots,
  };
})();
