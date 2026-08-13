/* paper-figure-board.js — the "🧭 Figure board" page of the paper editor
 * (V3.609, figure-board program R1).
 *
 * A freeform planning canvas per paper: students lay out the figures they
 * intend to produce, the experiments that feed them, reference-figure
 * snips from papers they've read, and sticky notes — then connect them
 * with arrows to describe the narrative flow. It is a methods-and-results
 * PLANNING surface: nothing here enters the manuscript (promotion of a
 * board card into a real figure block is deliberately deferred).
 *
 * Data: papers/{paperId}/boardItems/{itemId}
 *   { type: 'figure'|'experiment'|'snip'|'note'|'arrow',
 *     x, y, w, z,                        // world px (arrows omit these)
 *     title, body, body_html, status,    // body = plain-text mirror of body_html (V3.617)
 *     image: {storage_path, download_url} | null,
 *     source: {item_id, ann_id, page} | null,   // snips (R2 library picker)
 *     from_id, to_id,                    // arrows only
 *     created_by, createdAt, updatedAt, updated_by }
 *
 * Live-syncs via onSnapshot; last-write-wins per item. A card being
 * dragged or actively edited locally is never clobbered by a remote
 * update mid-gesture (paper-doc-view's origin-discrimination pattern).
 * Images upload through PAPER_FIGURES.uploadImage (same Storage prefix
 * as manuscript figures — paper-figures/{paperId}/).
 *
 * Contract: window.PaperFigureBoard.buildTabContent(rootEl) — idempotent,
 * called by paper-equations._refreshPanel when the figure-board page is
 * active (same contract as PaperWritingGuide / PaperGrantDocs).
 */
(function () {
  'use strict';

  var MIN_SCALE = 0.25, MAX_SCALE = 2;
  var DRAG_THRESHOLD = 5;          // px before a pointerdown becomes a drag
  var CARD_DEFAULT_W = { figure: 280, experiment: 250, snip: 280, note: 220 };
  var CARD_MIN_W = 160, CARD_MAX_W = 640;
  var STATUS_CYCLE = {
    figure:     ['planned', 'expected', 'collected'],
    experiment: ['planned', 'running', 'done'],
  };
  var TYPE_META = {
    figure:     { chip: '🧪 Planned figure',  hint: 'What should this figure show?' },
    experiment: { chip: '🔬 Experiment',      hint: 'Method / conditions / n…' },
    snip:       { chip: '📎 Reference',       hint: 'Why is this figure a good model?' },
    note:       { chip: '📝 Note',            hint: 'Thinking out loud…' },
  };

  var _root = null;          // #pe-figure-board-root
  var _paperId = null;
  var _unsub = null;
  var _items = {};           // id → doc data
  var _els = {};             // id → card element
  var _canvas = null, _world = null, _svg = null, _statusEl = null;
  var _view = { tx: 60, ty: 40, scale: 1 };
  var _drag = null;          // {id, startX, startY, origX, origY, moved} | {pan:true,...} | {resize:...}
  var _pointers = {};        // pointerId → {x,y} (for pinch)
  var _pinch = null;         // {dist, cx, cy}
  var _connect = { armed: false, fromId: null };
  var _saveTimers = {};      // id → debounce timer for text edits
  var _maxZ = 1;
  var _viewKeyLoaded = false;
  /* V3.611 — per-card comment threads (papers/{id}/boardComments via
   * SECTION_COMMENTS). One collection-wide listener maintains counts;
   * the thread pane itself lazy-mounts per card (PMR's pattern). */
  var _commentsUnsub = null;
  var _commentCounts = {};   // item_id → open-comment count
  var _commentLatest = {};   // item_id → newest OTHER-author comment millis (R4)
  var _panel = null;         // { el, itemId, handle } — the open thread pane
  /* V3.612 — change review: baseline = when THIS user last had the board
   * open (userSettings/{uid}.figure_boards[paperId]). Cards whose
   * updatedAt (by someone else) or newest other-author comment is newer
   * than the baseline carry a "changed" ring; ▶ Review steps through them. */
  var _lastSeenMs = 0;
  var _reviewIdx = -1;
  var _onPageHide = null;

  /* ── small helpers ─────────────────────────────────────────────── */

  function _db() {
    try { return (typeof firebridge !== 'undefined' && firebridge.db) ? firebridge.db() : null; }
    catch (e) { return null; }
  }
  function _uid() {
    try { return firebase.auth().currentUser.uid; } catch (e) { return null; }
  }
  function _coll() {
    return _db().collection('papers').doc(_paperId).collection('boardItems');
  }
  function _ts() { return firebase.firestore.FieldValue.serverTimestamp(); }
  function _esc(s) {
    return String(s == null ? '' : s).replace(/[&<>"']/g, function (c) {
      return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c];
    });
  }

  /* V3.617 — card bodies are rich text (lists!). Tiny defensive allowlist:
   * structure + emphasis only — no links, images, classes, or styles.
   * Anything else is unwrapped to its text (paste-safe). */
  var RT_TAGS = { DIV: 1, P: 1, BR: 1, UL: 1, OL: 1, LI: 1, B: 1, STRONG: 1, I: 1, EM: 1, U: 1 };
  function _sanitizeRich(html) {
    var wrap = document.createElement('div');
    wrap.innerHTML = String(html || '');
    (function walk(node) {
      Array.prototype.slice.call(node.childNodes).forEach(function (child) {
        if (child.nodeType === 8) { node.removeChild(child); return; }
        if (child.nodeType !== 1) return;
        if (!RT_TAGS[child.tagName]) {
          while (child.firstChild) node.insertBefore(child.firstChild, child);
          node.removeChild(child);
          return;
        }
        Array.prototype.slice.call(child.attributes).forEach(function (a) {
          child.removeAttribute(a.name);
        });
        walk(child);
      });
    })(wrap);
    return wrap.innerHTML;
  }
  /* Legacy plain-text bodies render as escaped text with line breaks. */
  function _plainToHtml(text) {
    return _esc(text).replace(/\n/g, '<br>');
  }
  function _bodyHtmlOf(it) {
    return it.body_html != null ? it.body_html : _plainToHtml(it.body || '');
  }
  function _status(msg, isErr) {
    if (!_statusEl) return;
    _statusEl.textContent = msg || '';
    _statusEl.classList.toggle('pfb-status-err', !!isErr);
    if (msg) {
      clearTimeout(_status._t);
      _status._t = setTimeout(function () { _statusEl.textContent = ''; }, 4000);
    }
  }

  /* Screen (canvas-local) → world coordinates. */
  function _toWorld(sx, sy) {
    return { x: (sx - _view.tx) / _view.scale, y: (sy - _view.ty) / _view.scale };
  }
  function _applyView() {
    if (!_world) return;
    _world.style.transform =
      'translate(' + _view.tx + 'px,' + _view.ty + 'px) scale(' + _view.scale + ')';
    var pct = _canvas && _canvas.querySelector('.pfb-zoom-pct');
    if (pct) pct.textContent = Math.round(_view.scale * 100) + '%';
    _persistView();
  }
  function _viewKey() { return 'rm_pfb_view_' + _paperId; }
  function _persistView() {
    if (!_viewKeyLoaded) return;
    try { localStorage.setItem(_viewKey(), JSON.stringify(_view)); } catch (e) {}
  }
  function _restoreView() {
    try {
      var v = JSON.parse(localStorage.getItem(_viewKey()) || 'null');
      if (v && isFinite(v.tx) && isFinite(v.ty) && isFinite(v.scale)) {
        _view = { tx: v.tx, ty: v.ty, scale: Math.min(MAX_SCALE, Math.max(MIN_SCALE, v.scale)) };
      }
    } catch (e) {}
    _viewKeyLoaded = true;
  }

  /* ── mount / teardown ──────────────────────────────────────────── */

  function buildTabContent(rootEl) {
    if (!rootEl) return;
    var pid = window.__PAPER_ID;
    if (!pid) return;
    /* Idempotent: same paper already mounted into this root → done. */
    if (_root === rootEl && _paperId === pid && rootEl.querySelector('.pfb-wrap')) return;
    _teardown();
    _root = rootEl;
    _paperId = pid;
    var db = _db();
    if (!db || !_uid()) {
      rootEl.innerHTML = '<div class="pfb-placeholder">Connecting…</div>';
      setTimeout(function () {
        if (_root === rootEl) { _root = null; buildTabContent(rootEl); }
      }, 600);
      return;
    }
    _restoreView();
    _buildDom(rootEl);
    _loadSeen().then(function () {
      _subscribe();
      _subscribeComments();
    });
    _onPageHide = function () { _stampSeen(); };
    window.addEventListener('pagehide', _onPageHide);
  }

  function _teardown() {
    if (_paperId) _stampSeen();
    if (_onPageHide) { window.removeEventListener('pagehide', _onPageHide); _onPageHide = null; }
    if (_unsub) { try { _unsub(); } catch (e) {} _unsub = null; }
    if (_commentsUnsub) { try { _commentsUnsub(); } catch (e) {} _commentsUnsub = null; }
    _closeCommentPanel();
    _commentCounts = {}; _commentLatest = {};
    _lastSeenMs = 0; _reviewIdx = -1;
    Object.keys(_saveTimers).forEach(function (k) { clearTimeout(_saveTimers[k]); });
    _saveTimers = {};
    _items = {}; _els = {}; _drag = null; _pointers = {}; _pinch = null;
    _connect = { armed: false, fromId: null };
    if (_root) _root.innerHTML = '';
    _root = null; _canvas = null; _world = null; _svg = null; _statusEl = null;
    _viewKeyLoaded = false;
  }

  function _buildDom(rootEl) {
    rootEl.innerHTML = '';
    var wrap = document.createElement('div');
    wrap.className = 'pfb-wrap';

    /* Toolbar */
    var bar = document.createElement('div');
    bar.className = 'pfb-toolbar';
    bar.innerHTML =
      '<button type="button" class="btn pfb-add" data-type="figure">＋ Figure</button>' +
      '<button type="button" class="btn pfb-add" data-type="experiment">＋ Experiment</button>' +
      '<button type="button" class="btn pfb-add" data-type="note">＋ Note</button>' +
      '<button type="button" class="btn pfb-add-lib">＋ 📚 From library</button>' +
      '<button type="button" class="btn pfb-add-ref">＋ Reference image</button>' +
      '<input type="file" class="pfb-ref-file" accept="image/*" hidden>' +
      '<button type="button" class="btn pfb-connect" title="Connect two cards with an arrow (Esc cancels)">↗ Connect</button>' +
      '<button type="button" class="btn pfb-review" title="Step through cards changed since you last looked" hidden>▶ Review</button>' +
      '<span class="pfb-bar-spacer"></span>' +
      '<span class="pfb-status" role="status"></span>';
    wrap.appendChild(bar);

    /* Canvas + world */
    _canvas = document.createElement('div');
    _canvas.className = 'pfb-canvas';
    _world = document.createElement('div');
    _world.className = 'pfb-world';
    _svg = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
    _svg.setAttribute('class', 'pfb-arrows');
    _svg.setAttribute('width', '2');
    _svg.setAttribute('height', '2');
    _svg.innerHTML =
      '<defs><marker id="pfb-arrowhead" markerWidth="9" markerHeight="7" ' +
      'refX="8" refY="3.5" orient="auto"><polygon points="0 0, 9 3.5, 0 7"></polygon>' +
      '</marker></defs><g class="pfb-arrow-layer"></g>';
    _world.appendChild(_svg);
    _canvas.appendChild(_world);

    var hint = document.createElement('div');
    hint.className = 'pfb-empty-hint';
    hint.innerHTML =
      '<h2>🧭 Figure board</h2>' +
      '<p>Plan this paper\'s methods &amp; results: add the <strong>figures</strong> you ' +
      'intend to produce, the <strong>experiments</strong> that generate them, reference ' +
      'images from your reading, and notes — then <strong>↗ Connect</strong> them to map the flow.</p>' +
      '<p class="pfb-empty-sub">Drag the background to pan · scroll to pan · ' +
      'ctrl/⌘-scroll or pinch to zoom · drag cards to arrange</p>';
    _canvas.appendChild(hint);

    /* V3.617 — zoom controls float over the canvas top-right as one
     * grouped cluster (they act on the canvas, so they live on it). */
    var zoomCtl = document.createElement('div');
    zoomCtl.className = 'pfb-zoomctl';
    zoomCtl.innerHTML =
      '<button type="button" class="pfb-zoom-out" title="Zoom out">−</button>' +
      '<span class="pfb-zoom-pct">100%</span>' +
      '<button type="button" class="pfb-zoom-in" title="Zoom in">＋</button>' +
      '<button type="button" class="pfb-zoom-fit" title="Fit all cards in view">⤢</button>';
    ['pointerdown', 'pointermove', 'pointerup', 'wheel'].forEach(function (t) {
      zoomCtl.addEventListener(t, function (e) { e.stopPropagation(); });
    });
    _canvas.appendChild(zoomCtl);

    wrap.appendChild(_canvas);
    rootEl.appendChild(wrap);
    _statusEl = bar.querySelector('.pfb-status');

    /* Toolbar wiring */
    bar.querySelectorAll('.pfb-add').forEach(function (b) {
      b.addEventListener('click', function () { _addCard(b.dataset.type); });
    });
    bar.querySelector('.pfb-add-lib').addEventListener('click', _openLibraryCaptureBrowser);
    var refBtn = bar.querySelector('.pfb-add-ref');
    var refFile = bar.querySelector('.pfb-ref-file');
    refBtn.addEventListener('click', function () { refFile.click(); });
    refFile.addEventListener('change', function () {
      var f = refFile.files && refFile.files[0];
      refFile.value = '';
      if (f) _addSnipFromFile(f);
    });
    var connectBtn = bar.querySelector('.pfb-connect');
    connectBtn.addEventListener('click', function () {
      _setConnect(!_connect.armed);
    });
    bar.querySelector('.pfb-review').addEventListener('click', _reviewNext);
    zoomCtl.querySelector('.pfb-zoom-in').addEventListener('click', function () { _zoomBy(1.2); });
    zoomCtl.querySelector('.pfb-zoom-out').addEventListener('click', function () { _zoomBy(1 / 1.2); });
    zoomCtl.querySelector('.pfb-zoom-fit').addEventListener('click', _zoomFit);

    /* Canvas interactions */
    _canvas.addEventListener('pointerdown', _onCanvasPointerDown);
    _canvas.addEventListener('pointermove', _onCanvasPointerMove);
    _canvas.addEventListener('pointerup', _onCanvasPointerUp);
    _canvas.addEventListener('pointercancel', _onCanvasPointerUp);
    _canvas.addEventListener('wheel', _onWheel, { passive: false });
    document.addEventListener('keydown', _onKeyDown);
    _applyView();
  }

  function _setConnect(on) {
    _connect.armed = on;
    _connect.fromId = null;
    var btn = _root && _root.querySelector('.pfb-connect');
    if (btn) btn.classList.toggle('pfb-connect-armed', on);
    if (_canvas) _canvas.classList.toggle('pfb-connecting', on);
    Object.keys(_els).forEach(function (id) {
      _els[id].classList.remove('pfb-connect-from');
    });
    _status(on ? 'Connect: click the source card, then the target card.' : '');
  }

  function _onKeyDown(e) {
    if (e.key === 'Escape' && _connect.armed) _setConnect(false);
  }

  /* ── pan / zoom ────────────────────────────────────────────────── */

  function _canvasPoint(e) {
    var r = _canvas.getBoundingClientRect();
    return { x: e.clientX - r.left, y: e.clientY - r.top };
  }

  function _onWheel(e) {
    e.preventDefault();
    if (e.ctrlKey || e.metaKey) {
      var p = _canvasPoint(e);
      _zoomAt(Math.pow(1.0015, -e.deltaY), p.x, p.y);
    } else {
      _view.tx -= e.deltaX;
      _view.ty -= e.deltaY;
      _applyView();
    }
  }

  function _zoomAt(factor, sx, sy) {
    var ns = Math.min(MAX_SCALE, Math.max(MIN_SCALE, _view.scale * factor));
    factor = ns / _view.scale;
    if (factor === 1) return;
    /* keep the point under the cursor stationary */
    _view.tx = sx - (sx - _view.tx) * factor;
    _view.ty = sy - (sy - _view.ty) * factor;
    _view.scale = ns;
    _applyView();
  }
  function _zoomBy(factor) {
    var r = _canvas.getBoundingClientRect();
    _zoomAt(factor, r.width / 2, r.height / 2);
  }
  function _zoomFit() {
    var ids = Object.keys(_items).filter(function (id) { return _items[id].type !== 'arrow'; });
    if (!ids.length) { _view = { tx: 60, ty: 40, scale: 1 }; _applyView(); return; }
    var minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
    ids.forEach(function (id) {
      var it = _items[id];
      var el = _els[id];
      var h = el ? el.offsetHeight : 160;
      minX = Math.min(minX, it.x); minY = Math.min(minY, it.y);
      maxX = Math.max(maxX, it.x + (it.w || 240)); maxY = Math.max(maxY, it.y + h);
    });
    var r = _canvas.getBoundingClientRect();
    var pad = 60;
    var s = Math.min((r.width - pad * 2) / Math.max(1, maxX - minX),
                     (r.height - pad * 2) / Math.max(1, maxY - minY));
    s = Math.min(1, Math.max(MIN_SCALE, Math.min(MAX_SCALE, s)));
    _view.scale = s;
    _view.tx = (r.width - (maxX - minX) * s) / 2 - minX * s;
    _view.ty = (r.height - (maxY - minY) * s) / 2 - minY * s;
    _applyView();
  }

  /* ── pointer plumbing (pan, card drag, resize, pinch) ──────────── */

  function _onCanvasPointerDown(e) {
    _pointers[e.pointerId] = { x: e.clientX, y: e.clientY };
    var pids = Object.keys(_pointers);
    if (pids.length === 2) {
      /* second finger → pinch takes over, cancel any drag/pan */
      _drag = null;
      var a = _pointers[pids[0]], b = _pointers[pids[1]];
      _pinch = {
        dist: Math.hypot(a.x - b.x, a.y - b.y),
        scale: _view.scale,
      };
      return;
    }
    var cardEl = e.target.closest('.pfb-card');
    if (cardEl && _connect.armed) {
      e.preventDefault();
      _onConnectClick(cardEl.dataset.id);
      return;
    }
    if (e.target.closest('.pfb-resize')) {
      var id0 = e.target.closest('.pfb-card').dataset.id;
      var it0 = _items[id0];
      _drag = { resize: true, id: id0, startX: e.clientX, origW: it0.w || 240 };
      _canvas.setPointerCapture(e.pointerId);
      e.preventDefault();
      return;
    }
    if (cardEl) {
      /* Interactive children keep native behavior (text edit, buttons). */
      if (e.target.closest('input, textarea, button, a, select, [contenteditable]')) return;
      var id = cardEl.dataset.id;
      var it = _items[id];
      if (!it) return;
      _drag = { id: id, startX: e.clientX, startY: e.clientY, origX: it.x, origY: it.y, moved: false };
      _canvas.setPointerCapture(e.pointerId);
      _bringToFront(id);
      e.preventDefault();
      return;
    }
    /* background → pan */
    _drag = { pan: true, startX: e.clientX, startY: e.clientY, origTx: _view.tx, origTy: _view.ty };
    _canvas.setPointerCapture(e.pointerId);
  }

  function _onCanvasPointerMove(e) {
    if (_pointers[e.pointerId]) _pointers[e.pointerId] = { x: e.clientX, y: e.clientY };
    var pids = Object.keys(_pointers);
    if (_pinch && pids.length === 2) {
      var a = _pointers[pids[0]], b = _pointers[pids[1]];
      var dist = Math.hypot(a.x - b.x, a.y - b.y);
      var r = _canvas.getBoundingClientRect();
      var cx = (a.x + b.x) / 2 - r.left, cy = (a.y + b.y) / 2 - r.top;
      var target = _pinch.scale * (dist / Math.max(1, _pinch.dist));
      _zoomAt(target / _view.scale, cx, cy);
      return;
    }
    if (!_drag) return;
    if (_drag.pan) {
      _view.tx = _drag.origTx + (e.clientX - _drag.startX);
      _view.ty = _drag.origTy + (e.clientY - _drag.startY);
      _applyView();
      return;
    }
    if (_drag.resize) {
      var it = _items[_drag.id];
      if (!it) return;
      var w = _drag.origW + (e.clientX - _drag.startX) / _view.scale;
      it.w = Math.round(Math.min(CARD_MAX_W, Math.max(CARD_MIN_W, w)));
      var el = _els[_drag.id];
      if (el) el.style.width = it.w + 'px';
      _drag.moved = true;
      _renderArrows();
      return;
    }
    var dx = (e.clientX - _drag.startX) / _view.scale;
    var dy = (e.clientY - _drag.startY) / _view.scale;
    if (!_drag.moved && Math.hypot(e.clientX - _drag.startX, e.clientY - _drag.startY) < DRAG_THRESHOLD) return;
    _drag.moved = true;
    var item = _items[_drag.id];
    if (!item) return;
    item.x = Math.round(_drag.origX + dx);
    item.y = Math.round(_drag.origY + dy);
    var cardEl = _els[_drag.id];
    if (cardEl) {
      cardEl.style.left = item.x + 'px';
      cardEl.style.top = item.y + 'px';
    }
    _renderArrows();
  }

  function _onCanvasPointerUp(e) {
    delete _pointers[e.pointerId];
    if (_pinch && Object.keys(_pointers).length < 2) _pinch = null;
    if (!_drag) return;
    var d = _drag;
    _drag = null;
    if (d.pan) return;
    var it = _items[d.id];
    if (!it || !d.moved) return;
    var patch = d.resize
      ? { w: it.w }
      : { x: it.x, y: it.y, z: it.z };
    _update(d.id, patch);
  }

  function _bringToFront(id) {
    var it = _items[id];
    if (!it) return;
    if ((it.z || 0) >= _maxZ) return;
    it.z = ++_maxZ;
    var el = _els[id];
    if (el) el.style.zIndex = it.z;
    /* z persists with the next position write (pointerup) — a plain
     * select/click doesn't need a Firestore round-trip. */
  }

  /* ── Firestore CRUD ────────────────────────────────────────────── */

  function _subscribe() {
    _unsub = _coll().onSnapshot(function (snap) {
      snap.docChanges().forEach(function (ch) {
        var id = ch.doc.id;
        if (ch.type === 'removed') {
          delete _items[id];
          if (_els[id]) { _els[id].remove(); delete _els[id]; }
          return;
        }
        var data = ch.doc.data();
        data.id = id;
        /* Never clobber a card mid-gesture / mid-edit with a remote echo. */
        var busy = (_drag && _drag.id === id) ||
                   (_els[id] && _els[id].contains(document.activeElement));
        if (busy && ch.type === 'modified') {
          var local = _items[id];
          data.x = local.x; data.y = local.y; data.w = local.w;
          data.title = local.title; data.body = local.body;
          data.body_html = local.body_html;
        }
        _items[id] = data;
        _maxZ = Math.max(_maxZ, data.z || 0);
        _renderCard(id);
        _syncChangedState(id);
      });
      _renderArrows();
      _updateEmptyHint();
      _updateReviewButton();
    }, function (err) {
      console.warn('[figure-board] subscribe failed', err);
      _status(err && err.code === 'permission-denied'
        ? 'You need to be an author on this paper to use its figure board.'
        : 'Figure board failed to load: ' + (err && err.message), true);
    });
  }

  function _newId() {
    return 'bi-' + Date.now().toString(36) + '-' + Math.random().toString(36).slice(2, 7);
  }

  function _create(data) {
    var id = _newId();
    data.created_by = _uid();
    data.updated_by = _uid();
    data.createdAt = _ts();
    data.updatedAt = _ts();
    /* optimistic local echo so the card appears instantly */
    var local = Object.assign({}, data, { id: id });
    _items[id] = local;
    if (local.type !== 'arrow') _renderCard(id);
    _renderArrows();
    _updateEmptyHint();
    _coll().doc(id).set(data).catch(function (err) {
      delete _items[id];
      if (_els[id]) { _els[id].remove(); delete _els[id]; }
      _renderArrows();
      _status('Could not save: ' + (err && err.message), true);
    });
    return id;
  }

  function _update(id, patch) {
    patch.updatedAt = _ts();
    patch.updated_by = _uid();
    _coll().doc(id).update(patch).catch(function (err) {
      _status('Could not save: ' + (err && err.message), true);
    });
  }

  function _remove(id) {
    /* deleting a card also deletes arrows touching it */
    var doomed = [id];
    Object.keys(_items).forEach(function (k) {
      var it = _items[k];
      if (it.type === 'arrow' && (it.from_id === id || it.to_id === id)) doomed.push(k);
    });
    var batch = _db().batch();
    doomed.forEach(function (k) { batch.delete(_coll().doc(k)); });
    batch.commit().catch(function (err) {
      _status('Could not delete: ' + (err && err.message), true);
    });
  }

  /* ── card creation ─────────────────────────────────────────────── */

  function _spawnPoint() {
    var r = _canvas.getBoundingClientRect();
    var p = _toWorld(r.width / 2, r.height / 2);
    /* cascade so repeated adds don't stack exactly */
    var n = Object.keys(_items).length % 7;
    return { x: Math.round(p.x - 120 + n * 24), y: Math.round(p.y - 90 + n * 20) };
  }

  function _addCard(type) {
    var p = _spawnPoint();
    var data = {
      type: type,
      x: p.x, y: p.y, w: CARD_DEFAULT_W[type] || 240, z: ++_maxZ,
      title: '', body: '', body_html: '',
      status: (STATUS_CYCLE[type] || [null])[0],
      image: null, source: null,
    };
    var id = _create(data);
    /* focus the new card's title for immediate typing */
    setTimeout(function () {
      var el = _els[id];
      var t = el && el.querySelector('.pfb-title');
      if (t) t.focus();
    }, 50);
  }

  function _addSnipFromFile(file) {
    var p = _spawnPoint();
    _status('Uploading image…');
    window.PAPER_FIGURES.uploadImage(_paperId, file).then(function (up) {
      _create({
        type: 'snip',
        x: p.x, y: p.y, w: CARD_DEFAULT_W.snip, z: ++_maxZ,
        title: '', body: '',
        status: null,
        image: { storage_path: up.storage_path, download_url: up.download_url },
        source: null,
      });
      _status('');
    }).catch(function (err) {
      _status('Upload failed: ' + (err && err.message), true);
    });
  }

  function _setCardImage(id, file) {
    _status('Uploading image…');
    window.PAPER_FIGURES.uploadImage(_paperId, file).then(function (up) {
      _update(id, { image: { storage_path: up.storage_path, download_url: up.download_url } });
      _status('');
    }).catch(function (err) {
      _status('Upload failed: ' + (err && err.message), true);
    });
  }

  /* ── change review (V3.612, program R4) ───────────────────────────── */

  function _loadSeen() {
    /* Baseline first, THEN stamp now — the in-memory baseline drives this
     * visit's highlights while the stored stamp resets for the next one.
     * Opening the board also marks the user's collapsed "board updated"
     * feed item read, re-arming the (unread-gated) notification. */
    var uid = _uid();
    return _db().collection('userSettings').doc(uid).get().then(function (snap) {
      var iso = snap.exists && snap.data().figure_boards && snap.data().figure_boards[_paperId];
      _lastSeenMs = iso ? Date.parse(iso) || 0 : 0;
    }).catch(function () { _lastSeenMs = 0; })
      .then(function () {
        _stampSeen();
        _markFeedRead();
      });
  }

  function _stampSeen() {
    var uid = _uid();
    if (!uid || !_paperId) return;
    var patch = { figure_boards: {} };
    patch.figure_boards[_paperId] = new Date().toISOString();
    _db().collection('userSettings').doc(uid).set(patch, { merge: true }).catch(function () {});
  }

  function _markFeedRead() {
    var uid = _uid();
    if (!uid) return;
    _db().collection('userData').doc(uid).collection('notifications')
      .where('tag', '==', 'figboard-' + _paperId)
      .where('readAt', '==', null)
      .get().then(function (snap) {
        snap.docs.forEach(function (d) {
          d.ref.update({ readAt: firebase.firestore.FieldValue.serverTimestamp() }).catch(function () {});
        });
      }).catch(function () {});
  }

  function _isChanged(it) {
    if (!it || it.type === 'arrow') return false;
    var me = _uid();
    var t = (it.updatedAt && it.updatedAt.toMillis) ? it.updatedAt.toMillis() : 0;
    if (t > _lastSeenMs && it.updated_by && it.updated_by !== me) return true;
    if ((_commentLatest[it.id] || 0) > _lastSeenMs) return true;
    return false;
  }

  function _syncChangedState(id) {
    var el = _els[id];
    if (!el) return;
    el.classList.toggle('pfb-changed', _isChanged(_items[id]));
  }

  function _changedIds() {
    return Object.keys(_items).filter(function (id) { return _isChanged(_items[id]); });
  }

  function _updateReviewButton() {
    var btn = _root && _root.querySelector('.pfb-review');
    if (!btn) return;
    var n = _changedIds().length;
    btn.hidden = n === 0;
    btn.textContent = '▶ Review ' + n + ' changed';
  }

  function _reviewNext() {
    var ids = _changedIds();
    if (!ids.length) return;
    _reviewIdx = (_reviewIdx + 1) % ids.length;
    _panToCard(ids[_reviewIdx]);
  }

  function _panToCard(id) {
    var it = _items[id];
    var el = _els[id];
    if (!it || !_canvas) return;
    var r = _canvas.getBoundingClientRect();
    var w = it.w || 240;
    var h = el ? el.offsetHeight : 160;
    _view.tx = r.width / 2 - (it.x + w / 2) * _view.scale;
    _view.ty = r.height / 2 - (it.y + h / 2) * _view.scale;
    _applyView();
    if (el) {
      el.classList.add('pfb-flash');
      setTimeout(function () { el.classList.remove('pfb-flash'); }, 1200);
    }
  }

  /* ── per-card comment threads (V3.611, program R3) ────────────────── */

  function _subscribeComments() {
    /* Whole-collection listener, counts client-side — same no-index
     * trade-off as SECTION_COMMENTS itself (boards stay small). */
    var me = _uid();
    _commentsUnsub = _db().collection('papers').doc(_paperId)
      .collection('boardComments').onSnapshot(function (snap) {
        _commentCounts = {}; _commentLatest = {};
        snap.docs.forEach(function (d) {
          var c = d.data();
          var k = c.item_id;
          if (!k) return;
          if (!c.resolved) _commentCounts[k] = (_commentCounts[k] || 0) + 1;
          /* own comments never count as "changed for me" (V3.612) */
          if (c.authorUid === me) return;
          var t = (c.modifiedAt && c.modifiedAt.toMillis) ? c.modifiedAt.toMillis()
                : (c.createdAt && c.createdAt.toMillis) ? c.createdAt.toMillis() : 0;
          if (t > (_commentLatest[k] || 0)) _commentLatest[k] = t;
        });
        Object.keys(_els).forEach(function (id) {
          _syncCommentBadge(id);
          _syncChangedState(id);
        });
        _updateReviewButton();
      }, function (err) {
        console.warn('[figure-board] comments subscribe failed', err);
      });
  }

  function _syncCommentBadge(id) {
    var el = _els[id];
    if (!el) return;
    var btn = el.querySelector('.pfb-comment-btn');
    if (!btn) return;
    var n = _commentCounts[id] || 0;
    btn.textContent = n ? ('💬 ' + n) : '💬';
    btn.classList.toggle('pfb-has-comments', n > 0);
  }

  function _closeCommentPanel() {
    if (!_panel) return;
    if (_panel.handle) { try { _panel.handle.unmount(); } catch (e) {} }
    if (_panel.el) _panel.el.remove();
    _panel = null;
  }

  function _openCommentPanel(id) {
    var it = _items[id];
    if (!it || !window.SECTION_COMMENTS) return;
    if (_panel && _panel.itemId === id) { _closeCommentPanel(); return; }
    _closeCommentPanel();
    var el = document.createElement('div');
    el.className = 'pfb-comments-panel';
    var head = document.createElement('div');
    head.className = 'pfb-comments-head';
    var title = document.createElement('span');
    var meta = TYPE_META[it.type] || TYPE_META.note;
    title.textContent = it.title || meta.chip;
    var closeBtn = document.createElement('button');
    closeBtn.type = 'button';
    closeBtn.className = 'pfb-del';
    closeBtn.textContent = '×';
    closeBtn.title = 'Close discussion';
    closeBtn.addEventListener('click', _closeCommentPanel);
    head.appendChild(title);
    head.appendChild(closeBtn);
    el.appendChild(head);
    var body = document.createElement('div');
    body.className = 'pfb-comments-body';
    el.appendChild(body);
    _canvas.appendChild(el);
    /* the panel is UI chrome, not canvas content — keep pointer events
     * from falling through into pan/drag handling */
    ['pointerdown', 'pointermove', 'pointerup', 'wheel'].forEach(function (t) {
      el.addEventListener(t, function (e) { e.stopPropagation(); });
    });
    var handle = window.SECTION_COMMENTS.mount({
      container: body,
      collectionPath: 'papers/' + _paperId + '/boardComments',
      scope: { item_id: id },
      label: 'Discussion — how should this flow?',
    });
    _panel = { el: el, itemId: id, handle: handle };
  }

  /* ── library capture browser (V3.610, program R2) ──────────────────
   * Clone of paper-equations._openCaptureBrowser with kind=='figure':
   * pane 1 lists library papers (linked-to-this-draft first), pane 2
   * shows that paper's figure captures with a "Place on board" action.
   * Reuses the pe-eqviz-* / pe-doc-picker-* modal styles from
   * paper-editor.css. */

  function _openLibraryCaptureBrowser() {
    var old = document.getElementById('pfb-libbrowse-overlay');
    if (old) old.remove();
    var overlay = document.createElement('div');
    overlay.className = 'pe-eqviz-overlay';
    overlay.id = 'pfb-libbrowse-overlay';
    var card = document.createElement('div');
    card.className = 'pe-eqviz-card';
    overlay.appendChild(card);
    var head = document.createElement('div');
    head.className = 'pe-eqviz-head';
    head.textContent = 'Place a captured figure from your reading library';
    card.appendChild(head);
    var search = document.createElement('input');
    search.type = 'text';
    search.className = 'pe-doc-picker-search';
    search.placeholder = 'Filter papers…';
    card.appendChild(search);
    var listHost = document.createElement('div');
    listHost.className = 'pe-eqcap-browse-list';
    card.appendChild(listHost);
    var closeRow = document.createElement('div');
    closeRow.className = 'pe-eqviz-actions';
    var closeBtn = document.createElement('button');
    closeBtn.type = 'button'; closeBtn.className = 'btn btn-sm'; closeBtn.textContent = 'Close';
    closeRow.appendChild(closeBtn);
    card.appendChild(closeRow);
    function close() { overlay.remove(); }
    closeBtn.addEventListener('click', close);
    overlay.addEventListener('mousedown', function (ev) { if (ev.target === overlay) close(); });
    document.body.appendChild(overlay);

    var pe = window.PaperEditor;
    function renderItems() {
      var items = (pe && pe.getCitationList ? pe.getCitationList() : []) || [];
      items = items.slice();
      var q = (search.value || '').trim().toLowerCase();
      items.sort(function (a, b) {
        var al = (a.linkedDrafts || []).indexOf(_paperId) >= 0 ? 0 : 1;
        var bl = (b.linkedDrafts || []).indexOf(_paperId) >= 0 ? 0 : 1;
        return al - bl || a.key.localeCompare(b.key);
      });
      if (q) items = items.filter(function (it) { return (it.searchHaystack || '').indexOf(q) >= 0; });
      listHost.innerHTML = '';
      if (!items.length) {
        listHost.innerHTML = '<div class="pe-eqimport-hint">No library papers found. Import papers on the Library page, then capture figures in the reader (⬚ Snip a region → 🖼).</div>';
        return;
      }
      items.slice(0, 40).forEach(function (it) {
        var row = document.createElement('button');
        row.type = 'button';
        row.className = 'pe-doc-picker-row';
        row.innerHTML = '<span class="pe-doc-picker-row-title">' + _esc(it.shortLabel) +
          ((it.linkedDrafts || []).indexOf(_paperId) >= 0 ? ' <span class="pe-eqcap-linked">linked</span>' : '') +
          '</span><span class="pe-doc-picker-row-subtitle">' + _esc((it.title || '').slice(0, 80)) + '</span>';
        row.addEventListener('click', function () { showCaptures(it); });
        listHost.appendChild(row);
      });
    }
    search.addEventListener('input', renderItems);
    renderItems();

    function showCaptures(item) {
      head.textContent = 'Captured figures — ' + item.shortLabel;
      search.style.display = 'none';
      listHost.innerHTML = 'Loading…';
      var col = _db().collection('papers').doc(item.itemId).collection('annotations');
      var me = firebase.auth().currentUser;
      var qs = [col.where('kind', '==', 'figure').where('visibility', '==', 'lab').get()];
      if (me) {
        qs.push(col.where('kind', '==', 'figure')
          .where('creator.uid', '==', me.uid).where('visibility', '==', 'private').get());
      }
      Promise.all(qs).then(function (snaps) {
        var seen = {};
        var caps = [];
        snaps.forEach(function (snap) {
          snap.docs.forEach(function (d) {
            if (seen[d.id]) return;
            seen[d.id] = true;
            caps.push(Object.assign({ id: d.id }, d.data()));
          });
        });
        listHost.innerHTML = '';
        if (!caps.length) {
          listHost.innerHTML = '<div class="pe-eqimport-hint">No figure captures on this paper yet — in the reader, toggle ⬚ Snip (or Alt-drag) a box over the figure, then 🖼.</div>';
          return;
        }
        caps.forEach(function (cap) {
          var row = document.createElement('div');
          row.className = 'pe-eqcap-browse-row';
          var url = (cap.image && cap.image.download_url) || cap.snip_data_uri || '';
          if (url) {
            var prev = document.createElement('img');
            prev.className = 'pfb-browse-img';
            prev.src = url;
            prev.alt = cap.name || 'Captured figure';
            prev.loading = 'lazy';
            row.appendChild(prev);
          }
          var meta = document.createElement('div');
          meta.className = 'pe-eqcap-browse-meta';
          meta.textContent = (cap.name || '(unnamed)') + '  ·  source [@' + item.key + ']';
          row.appendChild(meta);
          var placeBtn = document.createElement('button');
          placeBtn.type = 'button'; placeBtn.className = 'btn btn-sm btn-primary';
          placeBtn.textContent = 'Place on board';
          placeBtn.addEventListener('click', function () {
            var p = _spawnPoint();
            var firstPage = null;
            try { firstPage = cap.target.pages[0].page; } catch (e) {}
            _create({
              type: 'snip',
              x: p.x, y: p.y, w: CARD_DEFAULT_W.snip, z: ++_maxZ,
              title: cap.name || '',
              body: cap.comment || '',
              status: null,
              image: (cap.image && cap.image.download_url)
                ? { storage_path: cap.image.storage_path || null, download_url: cap.image.download_url }
                : null,
              source: { item_id: item.itemId, ann_id: cap.id, page: firstPage },
            });
            close();
          });
          row.appendChild(placeBtn);
          listHost.appendChild(row);
        });
      }).catch(function (e) {
        listHost.textContent = 'Could not load captures: ' + (e.message || e);
      });
    }
  }

  /* ── connect (arrows) ──────────────────────────────────────────── */

  function _onConnectClick(id) {
    if (!_connect.fromId) {
      _connect.fromId = id;
      if (_els[id]) _els[id].classList.add('pfb-connect-from');
      _status('Now click the target card.');
      return;
    }
    if (_connect.fromId === id) { _setConnect(false); return; }
    var from = _connect.fromId;
    /* skip duplicates (either direction is a distinct arrow; exact dup only) */
    var dup = Object.keys(_items).some(function (k) {
      var it = _items[k];
      return it.type === 'arrow' && it.from_id === from && it.to_id === id;
    });
    if (!dup) {
      _create({ type: 'arrow', from_id: from, to_id: id, title: '', body: '', status: null, image: null, source: null });
    }
    _setConnect(false);
  }

  /* Intersection of the segment (center A → center B) with rect B's
   * boundary, so the arrowhead lands on the card edge, not under it. */
  function _edgePoint(cx, cy, rect) {
    var dx = rect.cx - cx, dy = rect.cy - cy;
    if (!dx && !dy) return { x: rect.cx, y: rect.cy };
    var tx = Infinity, ty = Infinity;
    if (dx) tx = (rect.w / 2) / Math.abs(dx);
    if (dy) ty = (rect.h / 2) / Math.abs(dy);
    var t = Math.min(tx, ty);
    return { x: rect.cx - dx * t, y: rect.cy - dy * t };
  }

  function _cardRect(id) {
    var it = _items[id];
    if (!it) return null;
    var el = _els[id];
    var w = it.w || 240;
    var h = el ? el.offsetHeight : 160;
    return { cx: it.x + w / 2, cy: it.y + h / 2, w: w, h: h };
  }

  function _renderArrows() {
    if (!_svg) return;
    var layer = _svg.querySelector('.pfb-arrow-layer');
    if (!layer) return;
    var html = '';
    Object.keys(_items).forEach(function (id) {
      var it = _items[id];
      if (it.type !== 'arrow') return;
      var a = _cardRect(it.from_id), b = _cardRect(it.to_id);
      if (!a || !b) return;
      var start = _edgePoint(b.cx, b.cy, a);
      var end = _edgePoint(a.cx, a.cy, b);
      var mx = (start.x + end.x) / 2, my = (start.y + end.y) / 2;
      /* slight curve for legibility when cards align */
      var nx = -(end.y - start.y), ny = end.x - start.x;
      var len = Math.hypot(nx, ny) || 1;
      var bow = Math.min(30, len * 0.08);
      var cx = mx + (nx / len) * bow, cy = my + (ny / len) * bow;
      var d = 'M' + start.x + ' ' + start.y + ' Q' + cx + ' ' + cy + ' ' + end.x + ' ' + end.y;
      html += '<path class="pfb-arrow-hit" data-id="' + _esc(id) + '" d="' + d + '"></path>' +
              '<path class="pfb-arrow" data-id="' + _esc(id) + '" d="' + d + '" marker-end="url(#pfb-arrowhead)"></path>';
    });
    layer.innerHTML = html;
    layer.querySelectorAll('.pfb-arrow-hit').forEach(function (p) {
      p.addEventListener('pointerdown', function (e) {
        e.stopPropagation();
        var id = p.dataset.id;
        if (confirm('Delete this arrow?')) _remove(id);
      });
    });
  }

  /* ── card rendering ────────────────────────────────────────────── */

  function _renderCard(id) {
    var it = _items[id];
    if (!it || it.type === 'arrow') return;
    var el = _els[id];
    if (!el) {
      el = document.createElement('div');
      el.className = 'pfb-card';
      el.dataset.id = id;
      _els[id] = el;
      _world.appendChild(el);
      _buildCardDom(el, it);
    }
    el.className = 'pfb-card pfb-card-' + it.type;
    el.style.left = it.x + 'px';
    el.style.top = it.y + 'px';
    el.style.width = (it.w || 240) + 'px';
    el.style.zIndex = it.z || 1;
    _syncCardFields(el, it);
  }

  function _buildCardDom(el, it) {
    var meta = TYPE_META[it.type] || TYPE_META.note;
    el.innerHTML =
      '<div class="pfb-card-head">' +
        '<span class="pfb-chip">' + meta.chip + '</span>' +
        '<button type="button" class="pfb-stat" title="Click to change status"></button>' +
        '<span class="pfb-head-spacer"></span>' +
        '<button type="button" class="pfb-del" title="Delete card">×</button>' +
      '</div>' +
      '<input class="pfb-title" type="text" placeholder="Title…">' +
      '<div class="pfb-img-wrap" hidden><img class="pfb-img" alt=""><button type="button" class="pfb-img-swap" title="Replace image">↻</button></div>' +
      /* V3.617 — rich-text body (lists via the pop-up bar below) */
      '<div class="pfb-bodywrap">' +
        '<div class="pfb-body" contenteditable="true" data-ph="' + _esc(meta.hint) + '"></div>' +
        '<div class="pfb-richbar">' +
          '<button type="button" data-cmd="bold" title="Bold (⌘B)"><b>B</b></button>' +
          '<button type="button" data-cmd="italic" title="Italic (⌘I)"><i>I</i></button>' +
          '<button type="button" data-cmd="insertUnorderedList" title="Bulleted list">• List</button>' +
          '<button type="button" data-cmd="insertOrderedList" title="Numbered list">1. List</button>' +
        '</div>' +
      '</div>' +
      '<div class="pfb-card-foot">' +
        (it.type === 'figure' || it.type === 'snip'
          ? '<button type="button" class="pfb-img-btn">🖼 Add image</button>' +
            '<input type="file" class="pfb-img-file" accept="image/*" hidden>'
          : '') +
        '<a class="pfb-src-link" target="_blank" hidden>↗ source paper</a>' +
        '<span class="pfb-foot-spacer"></span>' +
        '<button type="button" class="pfb-comment-btn" title="Discuss this card (student ↔ mentor thread)">💬</button>' +
      '</div>' +
      '<div class="pfb-resize" title="Drag to resize"></div>';

    var id = el.dataset.id;
    var title = el.querySelector('.pfb-title');
    var body = el.querySelector('.pfb-body');
    function queueTextSave() {
      clearTimeout(_saveTimers[id]);
      _saveTimers[id] = setTimeout(flushTextSave, 700);
    }
    function flushTextSave() {
      clearTimeout(_saveTimers[id]);
      var cur = _items[id];
      if (!cur) return;
      var html = _sanitizeRich(body.innerHTML);
      var text = (body.textContent || '').trim();
      if (!text) html = '';                    // an "empty" editable keeps a stray <br>
      if (cur.title === title.value && (cur.body_html || '') === html) return;
      cur.title = title.value;
      cur.body_html = html;
      cur.body = text;                         // plain-text mirror (search, legacy)
      _update(id, { title: title.value, body_html: html, body: text });
    }
    title.addEventListener('input', queueTextSave);
    body.addEventListener('input', queueTextSave);
    title.addEventListener('blur', flushTextSave);
    body.addEventListener('blur', flushTextSave);
    body.addEventListener('input', _renderArrows);   // height changes move arrows

    /* V3.617 — rich-text bar: pops up under the body while it's being
     * edited (CSS :focus-within on .pfb-bodywrap). mousedown-preventDefault
     * keeps the selection + focus inside the editable while clicking. */
    el.querySelectorAll('.pfb-richbar button').forEach(function (b) {
      b.addEventListener('mousedown', function (e) { e.preventDefault(); });
      b.addEventListener('click', function (e) {
        e.preventDefault();
        try { document.execCommand(b.dataset.cmd, false, null); } catch (err) {}
        body.focus();
        queueTextSave();
      });
    });

    el.querySelector('.pfb-del').addEventListener('click', function () {
      var cur = _items[id] || {};
      var label = cur.title ? '"' + cur.title + '"' : 'this card';
      if (confirm('Delete ' + label + '? Its arrows go with it.')) _remove(id);
    });

    el.querySelector('.pfb-stat').addEventListener('click', function () {
      var cur = _items[id];
      var cycle = STATUS_CYCLE[cur.type];
      if (!cycle) return;
      var next = cycle[(cycle.indexOf(cur.status) + 1) % cycle.length];
      cur.status = next;
      _syncCardFields(el, cur);
      _update(id, { status: next });
    });

    var imgBtn = el.querySelector('.pfb-img-btn');
    if (imgBtn) {
      var imgFile = el.querySelector('.pfb-img-file');
      imgBtn.addEventListener('click', function () { imgFile.click(); });
      el.querySelector('.pfb-img-swap').addEventListener('click', function () { imgFile.click(); });
      imgFile.addEventListener('change', function () {
        var f = imgFile.files && imgFile.files[0];
        imgFile.value = '';
        if (f) _setCardImage(id, f);
      });
    }
    var img = el.querySelector('.pfb-img');
    img.addEventListener('load', _renderArrows);

    el.querySelector('.pfb-comment-btn').addEventListener('click', function () {
      _openCommentPanel(id);
    });
    _syncCommentBadge(id);
  }

  function _syncCardFields(el, it) {
    var focusedInside = el.contains(document.activeElement);
    var title = el.querySelector('.pfb-title');
    var body = el.querySelector('.pfb-body');
    if (!focusedInside) {
      if (title.value !== (it.title || '')) title.value = it.title || '';
      var wantHtml = _sanitizeRich(_bodyHtmlOf(it));
      if (body.innerHTML !== wantHtml) body.innerHTML = wantHtml;
    }
    var stat = el.querySelector('.pfb-stat');
    if (STATUS_CYCLE[it.type]) {
      stat.hidden = false;
      stat.textContent = it.status || STATUS_CYCLE[it.type][0];
      stat.className = 'pfb-stat pfb-stat-' + (it.status || STATUS_CYCLE[it.type][0]);
    } else {
      stat.hidden = true;
    }
    var imgWrap = el.querySelector('.pfb-img-wrap');
    var img = el.querySelector('.pfb-img');
    var imgBtn = el.querySelector('.pfb-img-btn');
    if (it.image && it.image.download_url) {
      imgWrap.hidden = false;
      if (img.getAttribute('src') !== it.image.download_url) img.src = it.image.download_url;
      if (imgBtn) imgBtn.hidden = true;
    } else {
      imgWrap.hidden = true;
      if (imgBtn) imgBtn.hidden = false;
    }
    var src = el.querySelector('.pfb-src-link');
    if (it.source && it.source.item_id) {
      src.hidden = false;
      src.href = '/rm/pages/library-paper.html?id=' + encodeURIComponent(it.source.item_id);
    } else {
      src.hidden = true;
    }
  }

  function _updateEmptyHint() {
    var hint = _canvas && _canvas.querySelector('.pfb-empty-hint');
    if (!hint) return;
    var hasCards = Object.keys(_items).some(function (id) { return _items[id].type !== 'arrow'; });
    hint.hidden = hasCards;
  }

  window.PaperFigureBoard = {
    buildTabContent: buildTabContent,
  };
})();
