/* paper-label-mode.js — see and correct the structure of a paper
 * (V3.644).
 *
 * The reader already detects figures so it can offer click-to-snip.  This
 * turns that hidden machinery into something you can look at and argue
 * with: a toggle at the bottom of the left column paints EVERY detected
 * region on the page — figure, table, equation, inline citation, body
 * text, title, authors, affiliation, abstract, keywords, notes, running
 * heads — and lets you fix any of them.
 *
 * A correction does two jobs at once:
 *   1. it fixes THIS paper, permanently and for everyone — stored labels
 *      win over the detector, so the figure hotspots follow your boxes;
 *   2. it becomes training data — `⤓ Export` emits the same JSON shape the
 *      offline training harness eats, so the detector gets better with use.
 *
 * Storage: papers/{paperId}/pageLabels/{page}
 *   { page, nw, nh, boxes: [{id,x,y,w,h,t,src,by,at}], updatedAt, updatedBy }
 * Boxes are NATURAL coordinates (zoom 1) so they survive zoom + re-render.
 * `src` is 'auto' (detector, untouched), 'edited' (auto box a human moved
 * or retyped) or 'human' (drawn from scratch) — the distinction is what
 * makes the export useful for scoring.
 *
 * Public API (window.PAPER_LABEL_MODE):
 *   init({paperId, viewer, hostEl, canEdit})  — per-paper wiring
 *   refreshPage(pageNum)                      — repaint one page's layer
 *   regionsFor(pageNum)                       — corrected figure/table
 *                                               regions, or null
 *   isOn()                                    — mode state
 *   destroy()                                 — tab detach
 */
(function () {
  'use strict';

  var _paperId = null;
  var _viewer = null;
  var _host = null;
  var _canEdit = false;
  var _on = false;
  var _armed = null;          // type armed for drawing, or null
  var _pages = {};            // pageNum → {boxes:[], loaded:bool, dirty:bool}
  var _saveTimer = null;
  var _panel = null;
  var _visible = {};          // type → bool

  function _types() {
    return (window.PAGE_REGIONS && window.PAGE_REGIONS.TYPES) || [];
  }
  function _color(t) {
    return (window.PAGE_REGIONS && window.PAGE_REGIONS.COLOR[t]) || '#666';
  }
  function _uid() {
    return 'b' + Date.now().toString(36) + Math.random().toString(36).slice(2, 7);
  }
  function _me() {
    try { return window.firebridge.user().uid; } catch (e) { return null; }
  }

  /* ── init / destroy ──────────────────────────────────────────────── */

  function init(opts) {
    destroy();
    _paperId = (opts && opts.paperId) || null;
    _viewer = (opts && opts.viewer) || null;
    _host = (opts && opts.hostEl) || null;
    _canEdit = !!(opts && opts.canEdit);
    _pages = {};
    _visible = {};
    _types().forEach(function (d) { _visible[d.t] = true; });
    if (_host) _mountToggle();
  }

  function destroy() {
    _flush();
    _on = false;
    _armed = null;
    _paperId = null;
    _viewer = null;
    _pages = {};
    if (_saveTimer) { clearTimeout(_saveTimer); _saveTimer = null; }
    document.querySelectorAll('.plm-layer').forEach(function (l) { l.remove(); });
    if (_panel) { _panel.remove(); _panel = null; }
    if (_host) _host.innerHTML = '';
    document.body.classList.remove('plm-active');
  }

  function isOn() { return _on; }

  /* ── the left-column toggle + panel ──────────────────────────────── */

  function _mountToggle() {
    _host.innerHTML = '';
    var btn = document.createElement('button');
    btn.type = 'button';
    btn.className = 'btn btn-sm plm-toggle';
    btn.id = 'plm-toggle';
    _setToggleLabel(btn);
    btn.addEventListener('click', function () {
      _on = !_on;
      _setToggleLabel(btn);
      document.body.classList.toggle('plm-active', _on);
      if (_on) {
        _buildPanel();
        _refreshAll();
      } else {
        _armed = null;
        if (_panel) { _panel.remove(); _panel = null; }
        document.querySelectorAll('.plm-layer').forEach(function (l) { l.remove(); });
        _flush();
      }
    });
    _host.appendChild(btn);
    _panel = null;
  }

  function _setToggleLabel(btn) {
    btn.innerHTML = '';
    if (window.ICON && window.ICON.label) {
      window.ICON.label(btn, 'tag', _on ? 'Hide labels' : 'Label mode');
    } else {
      btn.textContent = _on ? 'Hide labels' : 'Label mode';
    }
    btn.classList.toggle('plm-toggle-on', _on);
    btn.title = _on
      ? 'Hide the structure overlay'
      : 'Show what the reader thinks each part of this paper is — and correct it';
  }

  function _buildPanel() {
    if (_panel) _panel.remove();
    var p = document.createElement('div');
    p.className = 'plm-panel';
    p.innerHTML =
      '<div class="plm-panel-head">Label mode</div>' +
      '<div class="plm-hint">Click a box to retype it, drag its edges to ' +
      'resize, <b>×</b> to delete. Pick a type below then drag on the page ' +
      'to add one.</div>' +
      '<div class="plm-palette"></div>' +
      '<div class="plm-actions">' +
      '  <button type="button" class="btn btn-sm" data-act="redetect">Re-detect page</button>' +
      '  <button type="button" class="btn btn-sm" data-act="clear">Clear page</button>' +
      '  <button type="button" class="btn btn-sm" data-act="export">Export labels</button>' +
      '</div>' +
      '<div class="plm-status" id="plm-status"></div>';
    var pal = p.querySelector('.plm-palette');
    _types().forEach(function (d) {
      var row = document.createElement('div');
      row.className = 'plm-pal-row';
      row.innerHTML =
        '<button type="button" class="plm-pal" data-t="' + d.t + '" ' +
        'style="--plm-c:' + d.color + '" title="Draw a ' + d.label + ' box">' +
        '<span class="plm-sw"></span><span class="plm-nm">' + d.label + '</span>' +
        '<span class="plm-ct" data-ct="' + d.t + '"></span></button>' +
        '<button type="button" class="plm-eye" data-eye="' + d.t + '" ' +
        'title="Show/hide ' + d.label + '">●</button>';
      pal.appendChild(row);
    });
    pal.addEventListener('click', function (e) {
      var b = e.target.closest('.plm-pal');
      if (b) {
        _armed = (_armed === b.dataset.t) ? null : b.dataset.t;
        pal.querySelectorAll('.plm-pal').forEach(function (x) {
          x.classList.toggle('plm-pal-on', x.dataset.t === _armed);
        });
        /* Arming a type puts the layer in draw mode: existing boxes stop
         * swallowing the pointer so a new one can be drawn ON TOP of them
         * (a citation inside a text run, a panel inside a figure). */
        document.querySelectorAll('.plm-layer').forEach(function (l) {
          l.classList.toggle('plm-drawing', !!_armed);
        });
        return;
      }
      var eye = e.target.closest('.plm-eye');
      if (eye) {
        var t = eye.dataset.eye;
        _visible[t] = !_visible[t];
        eye.classList.toggle('plm-eye-off', !_visible[t]);
        _refreshAll();
      }
    });
    p.querySelector('.plm-actions').addEventListener('click', function (e) {
      var b = e.target.closest('button');
      if (!b) return;
      if (b.dataset.act === 'redetect') _redetect(_viewer && _viewer.currentPage);
      if (b.dataset.act === 'clear') _clearPage(_viewer && _viewer.currentPage);
      if (b.dataset.act === 'export') _exportLabels();
    });
    _host.appendChild(p);
    _panel = p;
    if (!_canEdit) {
      p.querySelector('.plm-palette').style.opacity = '.55';
      p.querySelector('.plm-hint').textContent =
        'Read-only — you can see the structure but not correct it.';
    }
  }

  function _status(msg) {
    var el = document.getElementById('plm-status');
    if (el) el.textContent = msg || '';
  }

  function _counts() {
    var c = {};
    Object.keys(_pages).forEach(function (p) {
      (_pages[p].boxes || []).forEach(function (b) { c[b.t] = (c[b.t] || 0) + 1; });
    });
    document.querySelectorAll('[data-ct]').forEach(function (el) {
      el.textContent = c[el.dataset.ct] || '';
    });
  }

  /* ── data ────────────────────────────────────────────────────────── */

  function _doc(page, paperId) {
    return window.firebridge.db()
      .collection('papers').doc(paperId || _paperId)
      .collection('pageLabels').doc(String(page));
  }

  async function _load(page) {
    if (_pages[page] && _pages[page].loaded) return _pages[page];
    var paperId = _paperId;
    var st = _pages[page] = _pages[page] || { boxes: [], loaded: false, dirty: false };
    try {
      var snap = await _doc(page, paperId).get();
      if (paperId !== _paperId) return st;    // tab switched mid-read
      if (snap.exists) {
        var d = snap.data() || {};
        st.boxes = (d.boxes || []).map(function (b) {
          return Object.assign({}, b, { id: b.id || _uid() });
        });
        st.nw = d.nw; st.nh = d.nh;
      }
    } catch (e) {
      console.warn('[label-mode] load failed p' + page, e);
    }
    st.loaded = true;
    if (!st.boxes.length) _detectInto(st, page);
    return st;
  }

  /** Run the detector for a page and seed the store with `src:'auto'`. */
  function _detectInto(st, page) {
    if (!window.PAGE_REGIONS || !_viewer || !_viewer.getPageNode) return;
    var node = _viewer.getPageNode(page);
    if (!node || !node.items) return;
    var z = _viewer.zoom || 1;
    var nat = (node.items || []).map(function (it) {
      return {
        x: it.x / z, y: it.y / z,
        w: (it.width != null ? it.width : it.w) / z,
        h: (it.height != null ? it.height : it.h) / z,
        text: it.text || it.str || '',
      };
    });
    var W = (node.wrap ? node.wrap.clientWidth : 0) / z;
    var H = (node.wrap ? node.wrap.clientHeight : 0) / z;
    if (!(W > 0 && H > 0)) return;
    var regions = window.PAGE_REGIONS.detect(nat, {
      pageWidth: W, pageHeight: H, pageNum: page,
      numPages: _viewer.numPages, inkProbe: null,
      /* V3.826 — same artwork boxes the hotspots were drawn from */
      graphics: (_viewer.getPageGraphics ? _viewer.getPageGraphics(page) : null) || undefined,
    }) || [];
    st.nw = W; st.nh = H;
    st.boxes = regions.map(function (r) {
      return {
        id: _uid(), x: r.x, y: r.y, w: r.w, h: r.h, t: r.t,
        src: 'auto', label: (r.label || '').slice(0, 120),
      };
    });
  }

  function _touch(page) {
    var st = _pages[page];
    if (!st) return;
    st.dirty = true;
    _status('Saving…');
    if (_saveTimer) clearTimeout(_saveTimer);
    _saveTimer = setTimeout(_flush, 900);
  }

  /* destroy() calls this and then immediately clears _paperId/_pages, so
   * EVERYTHING the writes need is snapshotted synchronously, before the
   * first await. Reading module state after the await would write the
   * outgoing paper's labels into the incoming paper (the same tab-switch
   * bug figure-capture hit in V3.621). */
  async function _flush() {
    if (_saveTimer) { clearTimeout(_saveTimer); _saveTimer = null; }
    if (!_paperId || !_canEdit) return;
    var paperId = _paperId;
    var uid = _me();
    var jobs = [];
    Object.keys(_pages).forEach(function (p) {
      var st = _pages[p];
      if (!st.dirty) return;
      st.dirty = false;
      jobs.push({
        page: Number(p), st: st,
        payload: {
          page: Number(p),
          nw: st.nw || null, nh: st.nh || null,
          boxes: st.boxes.map(function (b) {
            return {
              id: b.id, x: b.x, y: b.y, w: b.w, h: b.h, t: b.t,
              src: b.src || 'human', label: (b.label || '').slice(0, 120),
              by: b.by || uid,
            };
          }),
          updatedAt: new Date().toISOString(),
          updatedBy: uid,
        },
      });
    });
    if (!jobs.length) return;
    for (var i = 0; i < jobs.length; i++) {
      try {
        await _doc(jobs[i].page, paperId).set(jobs[i].payload, { merge: true });
      } catch (e) {
        console.warn('[label-mode] save failed p' + jobs[i].page, e);
        jobs[i].st.dirty = true;
        _status('Could not save — check your access.');
        return;
      }
    }
    _status('Saved.');
    setTimeout(function () { _status(''); }, 1600);
  }

  /* ── the per-page overlay ────────────────────────────────────────── */

  async function refreshPage(page) {
    if (!_on || !_viewer || !_viewer.getPageNode) return;
    var node = _viewer.getPageNode(page);
    if (!node || !node.wrap) return;
    var paperId = _paperId;
    var st = await _load(page);
    if (!_on || paperId !== _paperId) return;   // toggled off / tab switched
    var layer = node.wrap.querySelector('.plm-layer');
    if (!layer) {
      layer = document.createElement('div');
      layer.className = 'plm-layer';
      node.wrap.appendChild(layer);
      _wireDraw(layer, page);
    }
    layer.innerHTML = '';
    layer.classList.toggle('plm-drawing', !!_armed);
    var z = _viewer.zoom || 1;
    /* Biggest first, so a small box nested inside a big one (an inline
     * citation sitting in a body-text run) ends up ON TOP and stays
     * clickable. Painted the other way round the little ones are
     * unreachable — you can see them but never grab them. */
    st.boxes.slice()
      .sort(function (a, b) { return (b.w * b.h) - (a.w * a.h); })
      .forEach(function (b) {
        if (!_visible[b.t]) return;
        layer.appendChild(_boxEl(b, page, z));
      });
    _counts();
  }

  function _boxEl(b, page, z) {
    var el = document.createElement('div');
    el.className = 'plm-box plm-box-' + b.t + (b.src === 'auto' ? ' plm-auto' : '');
    el.style.left = (b.x * z) + 'px';
    el.style.top = (b.y * z) + 'px';
    el.style.width = (b.w * z) + 'px';
    el.style.height = (b.h * z) + 'px';
    el.style.setProperty('--plm-c', _color(b.t));
    el.dataset.id = b.id;
    el.title = (b.label || '').slice(0, 160);
    /* An inline citation is ~22×12px — a type chip would be four times its
     * size. Tiny boxes keep the chip tucked away until hover. */
    if (b.w * z < 64 || b.h * z < 18) el.classList.add('plm-tiny');

    var chip = document.createElement('button');
    chip.type = 'button';
    chip.className = 'plm-chip';
    var meta = _types().filter(function (d) { return d.t === b.t; })[0];
    chip.textContent = (meta ? meta.label : b.t) + (b.src === 'auto' ? '' : ' ✓');
    chip.addEventListener('click', function (e) {
      e.preventDefault(); e.stopPropagation();
      if (_canEdit) _typeMenu(chip, b, page);
    });
    el.appendChild(chip);

    if (_canEdit) {
      var del = document.createElement('button');
      del.type = 'button';
      del.className = 'plm-del';
      del.textContent = '×';
      del.title = 'Delete this label';
      del.addEventListener('click', function (e) {
        e.preventDefault(); e.stopPropagation();
        var st = _pages[page];
        st.boxes = st.boxes.filter(function (x) { return x.id !== b.id; });
        _touch(page);
        refreshPage(page);
      });
      el.appendChild(del);
      _addHandles(el, b, page);
    }
    return el;
  }

  /** Eight drag handles. Editing an auto box marks it `edited` — that flag
   *  is what tells the offline scorer the detector got this one wrong. */
  function _addHandles(el, b, page) {
    ['nw', 'n', 'ne', 'w', 'e', 'sw', 's', 'se'].forEach(function (dir) {
      var h = document.createElement('div');
      h.className = 'plm-h plm-h-' + dir;
      h.addEventListener('pointerdown', function (ev) {
        ev.preventDefault(); ev.stopPropagation();
        var z = _viewer.zoom || 1;
        var start = { x: ev.clientX, y: ev.clientY };
        var o = { x: b.x, y: b.y, w: b.w, h: b.h };
        function move(e2) {
          var dx = (e2.clientX - start.x) / z, dy = (e2.clientY - start.y) / z;
          var n = { x: o.x, y: o.y, w: o.w, h: o.h };
          if (dir.indexOf('w') >= 0) { n.x = o.x + dx; n.w = o.w - dx; }
          if (dir.indexOf('e') >= 0) { n.w = o.w + dx; }
          if (dir.indexOf('n') >= 0) { n.y = o.y + dy; n.h = o.h - dy; }
          if (dir.indexOf('s') >= 0) { n.h = o.h + dy; }
          if (n.w < 6 || n.h < 5) return;
          b.x = n.x; b.y = n.y; b.w = n.w; b.h = n.h;
          el.style.left = (b.x * z) + 'px';
          el.style.top = (b.y * z) + 'px';
          el.style.width = (b.w * z) + 'px';
          el.style.height = (b.h * z) + 'px';
        }
        function up() {
          window.removeEventListener('pointermove', move);
          window.removeEventListener('pointerup', up);
          if (b.src === 'auto') b.src = 'edited';
          el.classList.remove('plm-auto');
          _touch(page);
          refreshPage(page);
        }
        window.addEventListener('pointermove', move);
        window.addEventListener('pointerup', up);
      });
      el.appendChild(h);
    });
  }

  function _typeMenu(anchor, b, page) {
    document.querySelectorAll('.plm-menu').forEach(function (m) { m.remove(); });
    var m = document.createElement('div');
    m.className = 'plm-menu';
    _types().forEach(function (d) {
      var it = document.createElement('button');
      it.type = 'button';
      it.className = 'plm-menu-it' + (d.t === b.t ? ' plm-menu-on' : '');
      it.innerHTML = '<span class="plm-sw" style="--plm-c:' + d.color +
        '"></span>' + d.label;
      it.addEventListener('click', function (e) {
        e.stopPropagation();
        b.t = d.t;
        if (b.src === 'auto') b.src = 'edited';
        m.remove();
        _touch(page);
        refreshPage(page);
      });
      m.appendChild(it);
    });
    var r = anchor.getBoundingClientRect();
    m.style.left = r.left + 'px';
    m.style.top = (r.bottom + 4) + 'px';
    document.body.appendChild(m);
    setTimeout(function () {
      document.addEventListener('click', function once() {
        m.remove();
        document.removeEventListener('click', once);
      });
    }, 0);
  }

  /** Drag on empty page area with a type armed → a new human box. */
  function _wireDraw(layer, page) {
    layer.addEventListener('pointerdown', function (ev) {
      if (!_on || !_armed || !_canEdit) return;
      if (ev.target !== layer) return;             // started on a box
      ev.preventDefault();
      var z = _viewer.zoom || 1;
      var r = layer.getBoundingClientRect();
      var ox = ev.clientX - r.left, oy = ev.clientY - r.top;
      var ghost = document.createElement('div');
      ghost.className = 'plm-box plm-ghost';
      ghost.style.setProperty('--plm-c', _color(_armed));
      layer.appendChild(ghost);
      function move(e2) {
        var cx = e2.clientX - r.left, cy = e2.clientY - r.top;
        ghost.style.left = Math.min(ox, cx) + 'px';
        ghost.style.top = Math.min(oy, cy) + 'px';
        ghost.style.width = Math.abs(cx - ox) + 'px';
        ghost.style.height = Math.abs(cy - oy) + 'px';
      }
      function up(e2) {
        window.removeEventListener('pointermove', move);
        window.removeEventListener('pointerup', up);
        var cx = e2.clientX - r.left, cy = e2.clientY - r.top;
        var x = Math.min(ox, cx), y = Math.min(oy, cy);
        var w = Math.abs(cx - ox), h = Math.abs(cy - oy);
        ghost.remove();
        if (w < 8 || h < 6) return;
        var st = _pages[page];
        if (!st) return;
        st.boxes.push({
          id: _uid(), x: x / z, y: y / z, w: w / z, h: h / z,
          t: _armed, src: 'human', label: '',
        });
        _touch(page);
        refreshPage(page);
      }
      window.addEventListener('pointermove', move);
      window.addEventListener('pointerup', up);
    });
  }

  function _refreshAll() {
    if (!_viewer || !_viewer.forEachPage) return;
    _viewer.forEachPage(function (node, pageNum) { refreshPage(pageNum); });
  }

  function _redetect(page) {
    if (!page || !_canEdit) return;
    var st = _pages[page] = _pages[page] || { boxes: [], loaded: true, dirty: false };
    st.loaded = true;
    _detectInto(st, page);
    _touch(page);
    refreshPage(page);
    _status('Re-detected page ' + page + '.');
  }

  function _clearPage(page) {
    if (!page || !_canEdit) return;
    var st = _pages[page];
    if (!st) return;
    st.boxes = [];
    _touch(page);
    refreshPage(page);
  }

  /** The same JSON the offline training harness reads, so a corrected
   *  paper can be dropped straight into the training set. */
  function _exportLabels() {
    var pages = {};
    Object.keys(_pages).forEach(function (p) {
      var boxes = (_pages[p].boxes || []).filter(function (b) {
        return b.src !== 'auto';       // only what a human vouched for
      });
      if (boxes.length) {
        pages[p] = boxes.map(function (b) {
          return {
            x: +b.x.toFixed(1), y: +b.y.toFixed(1),
            w: +b.w.toFixed(1), h: +b.h.toFixed(1), t: b.t, src: b.src,
          };
        });
      }
    });
    var payload = {};
    payload[_paperId] = { pages: pages, source: 'reader-label-mode' };
    var blob = new Blob([JSON.stringify(payload, null, 1)],
      { type: 'application/json' });
    var a = document.createElement('a');
    a.href = URL.createObjectURL(blob);
    a.download = 'labels-' + _paperId + '.json';
    document.body.appendChild(a);
    a.click();
    setTimeout(function () { URL.revokeObjectURL(a.href); a.remove(); }, 1000);
    var n = Object.keys(pages).reduce(function (s, k) { return s + pages[k].length; }, 0);
    _status('Exported ' + n + ' confirmed label' + (n === 1 ? '' : 's') + '.');
  }

  /** Corrected figure/table regions for a page, or null when a human has
   *  not touched it — that null is what lets the live detector keep
   *  driving the snip hotspots on every other paper. */
  function regionsFor(page) {
    var st = _pages[page];
    if (!st || !st.loaded) return null;
    var touched = st.boxes.some(function (b) { return b.src !== 'auto'; });
    if (!touched) return null;
    return st.boxes
      .filter(function (b) { return b.t === 'figure' || b.t === 'table'; })
      .map(function (b) {
        return { x: b.x, y: b.y, w: b.w, h: b.h, label: b.label || '', kind: b.t };
      });
  }

  /** Warm the store for a page without turning the overlay on, so
   *  regionsFor() can answer for papers that have stored corrections. */
  async function prime(page) {
    if (!_paperId) return;
    try { await _load(page); } catch (e) { /* optional */ }
  }

  window.PAPER_LABEL_MODE = {
    init: init,
    destroy: destroy,
    refreshPage: refreshPage,
    regionsFor: regionsFor,
    prime: prime,
    isOn: isOn,
  };
})();
