/* paper-fig-compose.js — multi-panel figure COMPOSER (F1 of Paper
 * Builder III). Alex's chosen model: compose panels client-side and
 * BAKE one image through the existing single-image pipeline — the
 * figure block's `storage_path` stays a single composite, so export /
 * compile / doc view / PDF reader are untouched, and `[!fig:label:A]`
 * panel references keep working (subfigure labels sync to the panels).
 *
 * Data (SCALAR attrs — survive every move path per V3.435):
 *   panels_json  — [{storage_path, download_url, hash, mime, label,
 *                    span}]           span: 1 = one column, 0 = full row
 *   compose_json — {cols, gapPx, labelSize, bg}
 *
 * Panels upload through PAPER_FIGURES.uploadImage (content-hash dedup,
 * same paper-figures/{paperId}/ folder). Re-opening the composer
 * rehydrates from panels_json — the composite is always regenerable.
 *
 * Public API (window.PAPER_FIG_COMPOSE):
 *   open({paperId, blockId, attrs, yBlock}) — attrs = the block's Y.Map
 */
(function () {
  'use strict';

  var MAX_PANELS = 12;          // mirrors PaperSchemas.MAX_SUBFIGURES
  var MAX_EDGE = 4000;          // px cap on the baked composite's long edge

  function _parsePanels(json) {
    try {
      var arr = JSON.parse(json || '[]');
      return Array.isArray(arr) ? arr.filter(function (p) { return p && p.download_url; }) : [];
    } catch (e) { return []; }
  }
  function _parseCompose(json) {
    var d = { cols: 2, gapPx: 16, labelSize: 28, bg: '#ffffff' };
    try {
      var o = JSON.parse(json || '{}') || {};
      if (o.cols >= 1 && o.cols <= 4) d.cols = Math.floor(o.cols);
      if (o.gapPx >= 0 && o.gapPx <= 80) d.gapPx = Math.floor(o.gapPx);
      if (o.labelSize >= 10 && o.labelSize <= 80) d.labelSize = Math.floor(o.labelSize);
      if (o.bg === 'transparent') d.bg = 'transparent';
    } catch (e) { /* defaults */ }
    return d;
  }
  function _letter(i) { return String.fromCharCode(65 + (i % 26)); }

  /* Load a panel image with EXIF orientation honored. */
  function _loadBitmap(url) {
    return fetch(url).then(function (r) {
      if (!r.ok) throw new Error('image fetch failed (' + r.status + ')');
      return r.blob();
    }).then(function (blob) {
      if (window.createImageBitmap) {
        return createImageBitmap(blob, { imageOrientation: 'from-image' })
          .catch(function () { return createImageBitmap(blob); });
      }
      return new Promise(function (res, rej) {
        var img = new Image();
        img.onload = function () { res(img); };
        img.onerror = rej;
        img.src = URL.createObjectURL(blob);
      });
    });
  }

  /* Lay panels into rows: span-0 panels take a full row; span-1 panels
   * fill `cols` per row. Returns rows of panel indices. */
  function _layoutRows(panels, cols) {
    var rows = [];
    var cur = [];
    panels.forEach(function (p, i) {
      if (p.span === 0) {
        if (cur.length) { rows.push(cur); cur = []; }
        rows.push([i]);
        return;
      }
      cur.push(i);
      if (cur.length >= cols) { rows.push(cur); cur = []; }
    });
    if (cur.length) rows.push(cur);
    return rows;
  }

  /* Compose panels onto a canvas at unit column width `colW`. Returns
   * the canvas. bitmaps[i] matches panels[i]. */
  function _compose(panels, bitmaps, cfg, colW) {
    var gap = cfg.gapPx;
    var rows = _layoutRows(panels, cfg.cols);
    var fullW = cfg.cols * colW + (cfg.cols - 1) * gap;
    /* Row heights: each panel scales to its cell width; row = max height. */
    var y = 0;
    var placements = [];
    rows.forEach(function (row) {
      var n = row.length;
      var isFull = n === 1 && panels[row[0]].span === 0;
      var cellW = isFull ? fullW : colW;
      var rowH = 0;
      row.forEach(function (pi) {
        var bm = bitmaps[pi];
        var h = bm ? cellW * (bm.height / bm.width) : cellW * 0.75;
        rowH = Math.max(rowH, h);
      });
      row.forEach(function (pi, ci) {
        var bm = bitmaps[pi];
        var w = cellW;
        var h = bm ? cellW * (bm.height / bm.width) : rowH;
        placements.push({
          pi: pi,
          x: isFull ? 0 : ci * (colW + gap),
          y: y + (rowH - h) / 2,
          w: w, h: h,
        });
      });
      y += rowH + gap;
    });
    var totalH = Math.max(1, y - gap);
    var canvas = document.createElement('canvas');
    canvas.width = Math.round(fullW);
    canvas.height = Math.round(totalH);
    var ctx = canvas.getContext('2d');
    if (cfg.bg !== 'transparent') {
      ctx.fillStyle = cfg.bg;
      ctx.fillRect(0, 0, canvas.width, canvas.height);
    }
    placements.forEach(function (pl) {
      var bm = bitmaps[pl.pi];
      if (bm) ctx.drawImage(bm, pl.x, pl.y, pl.w, pl.h);
      /* Panel letter — bold sans, white halo for visibility. */
      var label = panels[pl.pi].label || _letter(pl.pi);
      var size = cfg.labelSize;
      ctx.font = '700 ' + size + 'px Helvetica, Arial, sans-serif';
      ctx.textBaseline = 'top';
      ctx.lineWidth = Math.max(2, size / 8);
      ctx.strokeStyle = 'rgba(255,255,255,0.9)';
      ctx.strokeText(label, pl.x + size * 0.35, pl.y + size * 0.25);
      ctx.fillStyle = '#111111';
      ctx.fillText(label, pl.x + size * 0.35, pl.y + size * 0.25);
    });
    return canvas;
  }

  function open(opts) {
    var attrs = opts.attrs;
    var paperId = opts.paperId;
    if (!attrs || !paperId || !window.PAPER_FIGURES) return;
    var panels = _parsePanels(attrs.get('panels_json'));
    var cfg = _parseCompose(attrs.get('compose_json'));
    var bitmaps = [];   // index-matched to panels

    var old = document.getElementById('pfc-overlay');
    if (old) old.remove();
    var overlay = document.createElement('div');
    overlay.className = 'pfc-overlay';
    overlay.id = 'pfc-overlay';
    var card = document.createElement('div');
    card.className = 'pfc-card';
    overlay.appendChild(card);
    card.innerHTML =
      '<div class="pfc-head">🧩 Compose panels' +
      '<span class="pfc-hint">Panels bake into ONE image — the manuscript pipeline sees a single figure; panel letters sync to the [!fig:…:A] references.</span></div>';

    /* Controls row. */
    var controls = document.createElement('div');
    controls.className = 'pfc-controls';
    function numCtl(label, val, min, max, onChange) {
      var w = document.createElement('label');
      w.className = 'pfc-ctl';
      w.appendChild(document.createTextNode(label + ' '));
      var inp = document.createElement('input');
      inp.type = 'number'; inp.min = min; inp.max = max; inp.value = val;
      inp.addEventListener('change', function () {
        var v = parseInt(inp.value, 10);
        if (isNaN(v)) return;
        v = Math.max(min, Math.min(max, v));
        inp.value = v;
        onChange(v);
        renderPreview();
      });
      w.appendChild(inp);
      return w;
    }
    controls.appendChild(numCtl('Columns', cfg.cols, 1, 4, function (v) { cfg.cols = v; }));
    controls.appendChild(numCtl('Gap px', cfg.gapPx, 0, 80, function (v) { cfg.gapPx = v; }));
    controls.appendChild(numCtl('Label px', cfg.labelSize, 10, 80, function (v) { cfg.labelSize = v; }));
    var addBtn = document.createElement('button');
    addBtn.type = 'button'; addBtn.className = 'btn btn-sm';
    addBtn.textContent = '+ Add panels…';
    var fileIn = document.createElement('input');
    fileIn.type = 'file';
    fileIn.accept = 'image/png,image/jpeg,image/webp';
    fileIn.multiple = true;
    fileIn.style.display = 'none';
    addBtn.addEventListener('click', function () { fileIn.click(); });
    controls.appendChild(addBtn);
    controls.appendChild(fileIn);
    card.appendChild(controls);

    /* Panel list + preview. */
    var body = document.createElement('div');
    body.className = 'pfc-body';
    var listHost = document.createElement('div');
    listHost.className = 'pfc-list';
    var prevHost = document.createElement('div');
    prevHost.className = 'pfc-preview';
    body.appendChild(listHost);
    body.appendChild(prevHost);
    card.appendChild(body);

    var status = document.createElement('div');
    status.className = 'pfc-status';
    card.appendChild(status);

    var actions = document.createElement('div');
    actions.className = 'pfc-actions';
    var cancel = document.createElement('button');
    cancel.type = 'button'; cancel.className = 'btn btn-sm'; cancel.textContent = 'Close';
    var bake = document.createElement('button');
    bake.type = 'button'; bake.className = 'btn btn-sm btn-primary';
    bake.textContent = '✓ Bake into figure';
    actions.appendChild(cancel);
    actions.appendChild(bake);
    card.appendChild(actions);
    document.body.appendChild(overlay);

    function close() {
      document.removeEventListener('keydown', onKey, true);
      overlay.remove();
    }
    function onKey(ev) { if (ev.key === 'Escape') { ev.stopPropagation(); close(); } }
    document.addEventListener('keydown', onKey, true);
    cancel.addEventListener('click', close);
    overlay.addEventListener('mousedown', function (ev) { if (ev.target === overlay) close(); });

    function relabel() {
      panels.forEach(function (p, i) { p.label = _letter(i); });
    }
    function renderList() {
      relabel();
      listHost.innerHTML = '';
      if (!panels.length) {
        listHost.innerHTML = '<div class="pfc-empty">No panels yet — add images above.</div>';
        return;
      }
      panels.forEach(function (p, i) {
        var rowEl = document.createElement('div');
        rowEl.className = 'pfc-panel';
        var thumb = document.createElement('img');
        thumb.src = p.download_url;
        thumb.alt = 'Panel ' + p.label;
        rowEl.appendChild(thumb);
        var meta = document.createElement('div');
        meta.className = 'pfc-panel-meta';
        meta.textContent = p.label;
        rowEl.appendChild(meta);
        var spanBtn = document.createElement('button');
        spanBtn.type = 'button'; spanBtn.className = 'btn btn-sm';
        spanBtn.textContent = p.span === 0 ? '↔ full row' : '□ column';
        spanBtn.title = 'Toggle: one column vs the full figure width';
        spanBtn.addEventListener('click', function () {
          p.span = p.span === 0 ? 1 : 0;
          renderList(); renderPreview();
        });
        rowEl.appendChild(spanBtn);
        var upBtn = document.createElement('button');
        upBtn.type = 'button'; upBtn.className = 'btn btn-sm'; upBtn.textContent = '◀';
        upBtn.title = 'Move earlier';
        upBtn.disabled = i === 0;
        upBtn.addEventListener('click', function () {
          panels.splice(i - 1, 0, panels.splice(i, 1)[0]);
          bitmaps.splice(i - 1, 0, bitmaps.splice(i, 1)[0]);
          renderList(); renderPreview();
        });
        rowEl.appendChild(upBtn);
        var downBtn = document.createElement('button');
        downBtn.type = 'button'; downBtn.className = 'btn btn-sm'; downBtn.textContent = '▶';
        downBtn.title = 'Move later';
        downBtn.disabled = i === panels.length - 1;
        downBtn.addEventListener('click', function () {
          panels.splice(i + 1, 0, panels.splice(i, 1)[0]);
          bitmaps.splice(i + 1, 0, bitmaps.splice(i, 1)[0]);
          renderList(); renderPreview();
        });
        rowEl.appendChild(downBtn);
        var rm = document.createElement('button');
        rm.type = 'button'; rm.className = 'btn btn-sm'; rm.textContent = '✕';
        rm.addEventListener('click', function () {
          panels.splice(i, 1);
          bitmaps.splice(i, 1);
          renderList(); renderPreview();
        });
        rowEl.appendChild(rm);
        listHost.appendChild(rowEl);
      });
    }

    function ensureBitmaps() {
      return Promise.all(panels.map(function (p, i) {
        if (bitmaps[i]) return bitmaps[i];
        return _loadBitmap(p.download_url).then(function (bm) {
          bitmaps[i] = bm;
          return bm;
        }).catch(function () { bitmaps[i] = null; return null; });
      }));
    }

    function renderPreview() {
      if (!panels.length) { prevHost.innerHTML = ''; return; }
      ensureBitmaps().then(function () {
        var canvas = _compose(panels, bitmaps, cfg, 300);   // preview at 300px columns
        canvas.className = 'pfc-preview-canvas';
        prevHost.innerHTML = '';
        prevHost.appendChild(canvas);
      });
    }

    fileIn.addEventListener('change', function () {
      var files = Array.prototype.slice.call(fileIn.files || []);
      fileIn.value = '';
      if (!files.length) return;
      if (panels.length + files.length > MAX_PANELS) {
        alert('At most ' + MAX_PANELS + ' panels.');
        return;
      }
      status.textContent = 'Uploading ' + files.length + ' panel(s)…';
      var chain = Promise.resolve();
      files.forEach(function (f) {
        chain = chain.then(function () {
          return window.PAPER_FIGURES.uploadImage(paperId, f).then(function (res) {
            panels.push({
              storage_path: res.storage_path,
              download_url: res.download_url,
              hash: res.hash,
              mime: res.mime,
              label: '',
              span: 1,
            });
            bitmaps.push(null);
          });
        });
      });
      chain.then(function () {
        status.textContent = '';
        renderList(); renderPreview();
      }).catch(function (e) {
        status.textContent = 'Upload failed: ' + (e.message || e);
      });
    });

    bake.addEventListener('click', function () {
      if (!panels.length) { alert('Add at least one panel.'); return; }
      bake.disabled = true;
      status.textContent = 'Composing…';
      ensureBitmaps().then(function () {
        /* Full-res compose: column width = the widest panel's natural
         * width (capped so the long edge stays ≤ MAX_EDGE). */
        var natural = 600;
        bitmaps.forEach(function (bm) { if (bm) natural = Math.max(natural, bm.width); });
        var colW = Math.min(natural, 1800);
        var canvas = _compose(panels, bitmaps, cfg, colW);
        if (Math.max(canvas.width, canvas.height) > MAX_EDGE) {
          var k = MAX_EDGE / Math.max(canvas.width, canvas.height);
          var small = document.createElement('canvas');
          small.width = Math.round(canvas.width * k);
          small.height = Math.round(canvas.height * k);
          small.getContext('2d').drawImage(canvas, 0, 0, small.width, small.height);
          canvas = small;
        }
        return new Promise(function (res, rej) {
          canvas.toBlob(function (blob) {
            if (!blob) { rej(new Error('compose failed')); return; }
            res(blob);
          }, 'image/png');
        });
      }).then(function (blob) {
        status.textContent = 'Uploading the composite…';
        return window.PAPER_FIGURES.uploadImage(paperId, blob);
      }).then(function (res) {
        /* One transact: the block's single image becomes the composite;
         * panel metadata persists for re-editing; subfigure labels sync
         * to the panels so [!fig:x:A] references resolve. */
        var yBlock = opts.yBlock;
        var Y = window.PaperEditor.getY();
        yBlock.doc.transact(function () {
          attrs.set('storage_path', res.storage_path);
          attrs.set('download_url', res.download_url);
          attrs.set('hash', res.hash);
          attrs.set('mime', res.mime);
          attrs.set('panels_json', JSON.stringify(panels));
          attrs.set('compose_json', JSON.stringify(cfg));
          attrs.set('subfigures', new Y.Array());
          var subs = attrs.get('subfigures');
          panels.forEach(function (p) {
            var m = new Y.Map();
            subs.push([m]);
            m.set('id', window.PaperSchemas.shortId('sf-'));
            m.set('label', p.label);
          });
        }, 'fig-compose-bake');
        close();
      }).catch(function (e) {
        bake.disabled = false;
        status.textContent = 'Bake failed: ' + (e.message || e);
      });
    });

    renderList();
    renderPreview();
  }

  window.PAPER_FIG_COMPOSE = { open: open };
})();
