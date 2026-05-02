/* paper-blocks.js — per-block-kind renderers (Phase B: Yjs-backed).
 *
 * Each block lives in a Y.Map with keys: id, kind, status, skeleton (Y.Text),
 * body (Y.Text), attrs (Y.Map). renderYBlock(yBlock, ctx) returns a DOM node
 * with Y.Text bindings wired up; structural changes (status, kind) are
 * observed and update the block's toolbar without a full editor re-render.
 *
 * Phase A's renderBlock(plainJson, ctx) is removed; the editor only ever
 * passes Y.Map blocks now (Phase A migration converts on first load).
 */

(function () {
  function renderYBlock(yBlock, ctx) {
    var kind = yBlock.get('kind');
    switch (kind) {
      case 'paragraph': return renderParagraph(yBlock, ctx);
      case 'equation':  return renderEquation(yBlock, ctx);
      case 'figure':    return renderUnsupported(yBlock, ctx, 'Figure');
      case 'table':     return renderTable(yBlock, ctx);
      case 'list':      return renderUnsupported(yBlock, ctx, 'List');
      default:          return renderUnsupported(yBlock, ctx, kind || 'unknown');
    }
  }

  /* Paragraph — toolbar + skeleton/body Y.Text contenteditable. */
  function renderParagraph(yBlock, ctx) {
    var Y = ctx.Y;
    var blockId = yBlock.get('id');

    var wrap = document.createElement('div');
    wrap.className = 'pe-block';
    wrap.dataset.blockId = blockId;
    wrap.dataset.kind = 'paragraph';

    var bar = document.createElement('div');
    bar.className = 'pe-block-toolbar';

    var handle = document.createElement('span');
    handle.className = 'pe-block-handle';
    handle.title = 'Reorder (Phase B: drag deferred)';
    handle.textContent = '⋮⋮';
    bar.appendChild(handle);

    /* Mode toggle (skeleton/body view per block; ephemeral, not stored in Yjs). */
    var blockMode = (yBlock.get('body') && yBlock.get('body').toString()) ? 'body' : 'skeleton';
    var modeWrap = document.createElement('div');
    modeWrap.className = 'pe-mode-toggle';
    var skBtn = document.createElement('button');
    skBtn.type = 'button';
    skBtn.textContent = 'Skeleton';
    skBtn.title = 'Bullet/summary version';
    var bdBtn = document.createElement('button');
    bdBtn.type = 'button';
    bdBtn.textContent = 'Write';
    bdBtn.title = 'Full prose';
    modeWrap.appendChild(skBtn);
    modeWrap.appendChild(bdBtn);
    bar.appendChild(modeWrap);

    /* Status pill (cycles draft → needs-review → complete). */
    var pill = document.createElement('button');
    pill.type = 'button';
    pill.className = 'pe-status-pill';
    pill.dataset.status = yBlock.get('status') || 'draft';
    pill.textContent = labelForStatus(pill.dataset.status);
    pill.addEventListener('click', function () {
      if (!ctx.editable) return;
      var next = nextStatus(yBlock.get('status'));
      yBlock.doc.transact(function () { yBlock.set('status', next); }, 'local-status');
    });
    bar.appendChild(pill);

    /* Presence dots for any other users focused on this block. */
    var presenceWrap = document.createElement('div');
    presenceWrap.className = 'pe-block-presence';
    bar.appendChild(presenceWrap);
    refreshBlockPresence(presenceWrap, ctx, blockId);

    /* Comment button + count chip (Phase D). */
    var commentBtn = document.createElement('button');
    commentBtn.type = 'button';
    commentBtn.className = 'pe-comment-btn';
    commentBtn.title = 'Open comments for this paragraph';
    function refreshCommentCount() {
      var n = (window.PaperComments && window.PaperComments.countFor(blockId)) || 0;
      commentBtn.textContent = '💬' + (n ? ' ' + n : '');
      commentBtn.classList.toggle('pe-comment-btn-active', n > 0);
    }
    refreshCommentCount();
    commentBtn.addEventListener('click', function () {
      if (window.PaperComments) {
        var label = 'Paragraph (' + blockId.slice(0, 8) + ')';
        window.PaperComments.open(blockId, label);
      }
    });
    bar.appendChild(commentBtn);
    var onCountsChanged = function () { refreshCommentCount(); };
    window.addEventListener('paper-comment-counts-changed', onCountsChanged);

    /* Block actions (delete). */
    var actions = document.createElement('div');
    actions.className = 'pe-block-actions';
    var delBtn = document.createElement('button');
    delBtn.type = 'button';
    delBtn.title = 'Delete paragraph';
    delBtn.textContent = '✕';
    delBtn.addEventListener('click', function () {
      if (!ctx.editable) return;
      ctx.onDelete(blockId);
    });
    if (!ctx.editable) delBtn.disabled = true;
    actions.appendChild(delBtn);
    bar.appendChild(actions);

    wrap.appendChild(bar);

    /* Two contenteditable areas — one for skeleton, one for body. We render
     * both in the DOM and toggle visibility based on the per-block mode and
     * the doc-level view filter. Keeping both bound avoids re-binding on
     * mode toggle (and avoids losing remote edits to the hidden field). */
    var skEl = document.createElement('div');
    skEl.className = 'pe-block-content skeleton';
    skEl.dataset.placeholder = 'Bullet summary: what is this paragraph about?';

    var bdEl = document.createElement('div');
    bdEl.className = 'pe-block-content';
    bdEl.dataset.placeholder = 'Write the full paragraph…';

    var skUnbind = window.PaperEditor.bindYTextToContentEditable(yBlock.get('skeleton'), skEl, {
      readOnly: !ctx.editable,
      onLocalChange: function () { ctx.onFocusBlock && ctx.onFocusBlock(blockId); },
      // Skeleton renders with same paragraph contract — math + citations.
      renderHtml: window.PaperEditor.renderParagraphHtml,
    });
    var bdUnbind = window.PaperEditor.bindYTextToContentEditable(yBlock.get('body'), bdEl, {
      readOnly: !ctx.editable,
      onLocalChange: function () { ctx.onFocusBlock && ctx.onFocusBlock(blockId); },
      renderHtml: window.PaperEditor.renderParagraphHtml,
    });

    [skEl, bdEl].forEach(function (el) {
      el.addEventListener('focus', function () {
        if (ctx.onFocusBlock) ctx.onFocusBlock(blockId);
      });
    });

    wrap.appendChild(skEl);
    wrap.appendChild(bdEl);

    function applyMode(m) {
      blockMode = m;
      skBtn.classList.toggle('active', m === 'skeleton');
      bdBtn.classList.toggle('active', m === 'body');
      // Visibility based on view filter override.
      var effective = ctx.viewFilter === 'skeleton' ? 'skeleton' :
                      ctx.viewFilter === 'body'     ? 'body'     : m;
      skEl.style.display = (effective === 'skeleton') ? '' : 'none';
      bdEl.style.display = (effective === 'body')     ? '' : 'none';
    }
    skBtn.addEventListener('click', function () { if (ctx.editable) applyMode('skeleton'); });
    bdBtn.addEventListener('click', function () { if (ctx.editable) applyMode('body'); });
    applyMode(blockMode);

    /* Observe block-level changes (status flips from remote, kind changes). */
    var blockObserver = function (event, transaction) {
      // Skip our own status writes — they already updated the pill via the
      // click handler. Remote status writes need to update the UI.
      if (transaction.origin === 'local-status') {
        pill.dataset.status = yBlock.get('status') || 'draft';
        pill.textContent = labelForStatus(pill.dataset.status);
        return;
      }
      // Remote: refresh status and kind tag.
      pill.dataset.status = yBlock.get('status') || 'draft';
      pill.textContent = labelForStatus(pill.dataset.status);
    };
    yBlock.observe(blockObserver);

    /* Listen for presence-changed events fired by paper-editor.js when the
     * presence list updates. Cheaper than polling. */
    var onPresenceChanged = function () { refreshBlockPresence(presenceWrap, ctx, blockId); };
    window.addEventListener('paper-presence-changed', onPresenceChanged);

    /* Cleanup: register unbind + unobserve. */
    if (ctx.registerSubscription) {
      ctx.registerSubscription(yBlock, function () {
        try { skUnbind(); } catch (e) {}
        try { bdUnbind(); } catch (e) {}
        try { yBlock.unobserve(blockObserver); } catch (e) {}
        window.removeEventListener('paper-presence-changed', onPresenceChanged);
        window.removeEventListener('paper-comment-counts-changed', onCountsChanged);
      });
    }

    return wrap;
  }

  function refreshBlockPresence(presenceWrap, ctx, blockId) {
    var arr = ctx.getPresenceForBlock ? ctx.getPresenceForBlock(blockId) : [];
    presenceWrap.innerHTML = '';
    arr.forEach(function (p) {
      var dot = document.createElement('span');
      dot.className = 'pe-presence-dot pe-presence-mini';
      dot.title = p.name + ' is editing this paragraph';
      dot.style.background = p.color;
      dot.textContent = (p.name || '?').slice(0, 1).toUpperCase();
      presenceWrap.appendChild(dot);
    });
  }

  /* Equation block — KaTeX-rendered display or inline math. The block's
   * `body` Y.Text holds the LaTeX source. attrs.display toggles display vs
   * inline rendering. */
  function renderEquation(yBlock, ctx) {
    var Y = ctx.Y;
    var blockId = yBlock.get('id');

    var wrap = document.createElement('div');
    wrap.className = 'pe-block pe-block-equation';
    wrap.dataset.blockId = blockId;
    wrap.dataset.kind = 'equation';

    var bar = document.createElement('div');
    bar.className = 'pe-block-toolbar';

    var handle = document.createElement('span');
    handle.className = 'pe-block-handle';
    handle.textContent = '⋮⋮';
    bar.appendChild(handle);

    var kindTag = document.createElement('span');
    kindTag.className = 'pe-section-kind';
    kindTag.textContent = 'Equation';
    bar.appendChild(kindTag);

    /* Display vs inline toggle (writes attrs.display). */
    var attrs = yBlock.get('attrs');
    if (!attrs) {
      yBlock.doc.transact(function () { yBlock.set('attrs', new Y.Map()); }, 'init-eq-attrs');
      attrs = yBlock.get('attrs');
    }
    var modeWrap = document.createElement('div');
    modeWrap.className = 'pe-mode-toggle';
    var dispBtn = document.createElement('button');
    dispBtn.type = 'button';
    dispBtn.textContent = 'Display';
    var inlineBtn = document.createElement('button');
    inlineBtn.type = 'button';
    inlineBtn.textContent = 'Inline';
    function reflectMode() {
      var d = !!attrs.get('display');
      dispBtn.classList.toggle('active', d);
      inlineBtn.classList.toggle('active', !d);
      // Re-render the body since the mode changed.
      // The bound contenteditable will pick this up via the renderHtml callback.
      if (document.activeElement !== bodyEl) {
        var v = yBlock.get('body').toString();
        bodyEl.innerHTML = window.PaperEditor.renderEquationHtml(v, d) || '';
        bodyEl.dataset.empty = v ? 'false' : 'true';
      }
    }
    dispBtn.addEventListener('click', function () {
      if (!ctx.editable) return;
      yBlock.doc.transact(function () { attrs.set('display', true); }, 'local-status');
    });
    inlineBtn.addEventListener('click', function () {
      if (!ctx.editable) return;
      yBlock.doc.transact(function () { attrs.set('display', false); }, 'local-status');
    });
    modeWrap.appendChild(dispBtn);
    modeWrap.appendChild(inlineBtn);
    bar.appendChild(modeWrap);

    /* Status pill (cycles draft → needs-review → complete). */
    var pill = document.createElement('button');
    pill.type = 'button';
    pill.className = 'pe-status-pill';
    pill.dataset.status = yBlock.get('status') || 'draft';
    pill.textContent = labelForStatus(pill.dataset.status);
    pill.addEventListener('click', function () {
      if (!ctx.editable) return;
      var next = nextStatus(yBlock.get('status'));
      yBlock.doc.transact(function () { yBlock.set('status', next); }, 'local-status');
    });
    bar.appendChild(pill);

    var actions = document.createElement('div');
    actions.className = 'pe-block-actions';
    var delBtn = document.createElement('button');
    delBtn.type = 'button';
    delBtn.title = 'Delete equation';
    delBtn.textContent = '✕';
    delBtn.addEventListener('click', function () {
      if (!ctx.editable) return;
      ctx.onDelete(blockId);
    });
    if (!ctx.editable) delBtn.disabled = true;
    actions.appendChild(delBtn);
    bar.appendChild(actions);

    wrap.appendChild(bar);

    /* Body — LaTeX source contenteditable. Whole-source KaTeX render. */
    var bodyEl = document.createElement('div');
    bodyEl.className = 'pe-block-content pe-equation-body';
    bodyEl.dataset.placeholder = 'LaTeX source — e.g.  \\sigma = F / A';

    var bodyUnbind = window.PaperEditor.bindYTextToContentEditable(yBlock.get('body'), bodyEl, {
      readOnly: !ctx.editable,
      renderHtml: function (text) {
        return window.PaperEditor.renderEquationHtml(text, !!attrs.get('display'));
      },
      onLocalChange: function () { ctx.onFocusBlock && ctx.onFocusBlock(blockId); },
    });
    bodyEl.addEventListener('focus', function () {
      if (ctx.onFocusBlock) ctx.onFocusBlock(blockId);
    });
    wrap.appendChild(bodyEl);

    /* Observers. */
    var blockObserver = function () {
      pill.dataset.status = yBlock.get('status') || 'draft';
      pill.textContent = labelForStatus(pill.dataset.status);
    };
    yBlock.observe(blockObserver);
    var attrsObserver = function () { reflectMode(); };
    attrs.observe(attrsObserver);

    if (ctx.registerSubscription) {
      ctx.registerSubscription(yBlock, function () {
        try { bodyUnbind(); } catch (e) {}
        try { yBlock.unobserve(blockObserver); } catch (e) {}
        try { attrs.unobserve(attrsObserver); } catch (e) {}
      });
    }

    reflectMode();
    return wrap;
  }

  /* Table block — minimal grid editor (Phase C).
   *
   * Schema: yBlock.attrs has
   *   rows: number, cols: number,
   *   cells: Y.Map of "<r>-<c>" → Y.Text  (per-cell collaborative text)
   *   caption: Y.Text
   *   raw_tex: string (legacy fallback for imported tables)
   *
   * For imported tables (raw_tex but no cells map), we render a read-only
   * preview noting the raw .tex was preserved; the user can convert by
   * clicking "Add row / col" once and then editing. Phase F's tableToTex
   * uses cells when present, falls back to raw_tex.
   */
  function renderTable(yBlock, ctx) {
    var Y = ctx.Y;
    var blockId = yBlock.get('id');
    var attrs = yBlock.get('attrs');
    if (!attrs) {
      // Defensive: imported blocks may not have an attrs Y.Map.
      yBlock.doc.transact(function () { yBlock.set('attrs', new Y.Map()); }, 'init-table-attrs');
      attrs = yBlock.get('attrs');
    }
    var hasCells = attrs.get('cells') instanceof Y.Map;
    var rawTex = attrs.get('raw_tex');

    var wrap = document.createElement('div');
    wrap.className = 'pe-block pe-block-table';
    wrap.dataset.blockId = blockId;
    wrap.dataset.kind = 'table';

    /* Toolbar */
    var bar = document.createElement('div');
    bar.className = 'pe-block-toolbar';
    var handle = document.createElement('span');
    handle.className = 'pe-block-handle';
    handle.textContent = '⋮⋮';
    bar.appendChild(handle);
    var kindTag = document.createElement('span');
    kindTag.className = 'pe-section-kind';
    kindTag.textContent = 'Table';
    bar.appendChild(kindTag);

    if (ctx.editable && hasCells) {
      bar.appendChild(mkSmallBtn('+ Row', function () {
        yBlock.doc.transact(function () {
          var r = (attrs.get('rows') || 0);
          var cells = attrs.get('cells');
          var cols = attrs.get('cols') || 0;
          for (var c = 0; c < cols; c++) cells.set(r + '-' + c, new Y.Text(''));
          attrs.set('rows', r + 1);
        }, 'table-add-row');
      }));
      bar.appendChild(mkSmallBtn('+ Col', function () {
        yBlock.doc.transact(function () {
          var c = (attrs.get('cols') || 0);
          var cells = attrs.get('cells');
          var rows = attrs.get('rows') || 0;
          for (var r = 0; r < rows; r++) cells.set(r + '-' + c, new Y.Text(''));
          attrs.set('cols', c + 1);
        }, 'table-add-col');
      }));
    }
    if (ctx.editable && rawTex && !hasCells) {
      bar.appendChild(mkSmallBtn('Convert to grid', function () {
        // Initialize a minimal 1x1 grid so the user can rebuild from the
        // preserved raw_tex below. Future iteration: actually parse the
        // tabular into cells.
        yBlock.doc.transact(function () {
          attrs.set('rows', 1);
          attrs.set('cols', 1);
          attrs.set('cells', new Y.Map());
          attrs.get('cells').set('0-0', new Y.Text(''));
        }, 'table-convert');
      }));
    }

    /* Status pill (cycles draft → needs-review → complete). */
    var pill = document.createElement('button');
    pill.type = 'button';
    pill.className = 'pe-status-pill';
    pill.dataset.status = yBlock.get('status') || 'draft';
    pill.textContent = labelForStatus(pill.dataset.status);
    pill.addEventListener('click', function () {
      if (!ctx.editable) return;
      var next = nextStatus(yBlock.get('status'));
      yBlock.doc.transact(function () { yBlock.set('status', next); }, 'local-status');
    });
    bar.appendChild(pill);

    /* Delete */
    var actions = document.createElement('div');
    actions.className = 'pe-block-actions';
    var delBtn = document.createElement('button');
    delBtn.type = 'button';
    delBtn.title = 'Delete table';
    delBtn.textContent = '✕';
    delBtn.addEventListener('click', function () {
      if (!ctx.editable) return;
      ctx.onDelete(blockId);
    });
    if (!ctx.editable) delBtn.disabled = true;
    actions.appendChild(delBtn);
    bar.appendChild(actions);
    wrap.appendChild(bar);

    /* Body */
    var body = document.createElement('div');
    body.className = 'pe-table-body';
    var cellUnbinds = [];
    if (hasCells) {
      var rows = attrs.get('rows') || 0;
      var cols = attrs.get('cols') || 0;
      var cells = attrs.get('cells');
      var table = document.createElement('table');
      table.className = 'pe-grid-table';
      for (var r = 0; r < rows; r++) {
        var tr = document.createElement('tr');
        for (var c = 0; c < cols; c++) {
          var td = document.createElement('td');
          var key = r + '-' + c;
          var cellY = cells.get(key);
          if (!(cellY instanceof Y.Text)) {
            // Defensive: create on demand if missing.
            cellY = new Y.Text('');
            yBlock.doc.transact(function () { cells.set(key, cellY); }, 'init-cell');
          }
          var cellEl = document.createElement('div');
          cellEl.className = 'pe-grid-cell';
          var unbind = window.PaperEditor.bindYTextToContentEditable(cellY, cellEl, {
            readOnly: !ctx.editable,
            renderHtml: window.PaperEditor.renderParagraphHtml,
          });
          cellUnbinds.push(unbind);
          td.appendChild(cellEl);
          tr.appendChild(td);
        }
        table.appendChild(tr);
      }
      body.appendChild(table);
    } else if (rawTex) {
      var pre = document.createElement('pre');
      pre.className = 'pe-table-rawtex';
      pre.textContent = rawTex;
      body.appendChild(pre);
      var note = document.createElement('div');
      note.className = 'pe-unsupported';
      note.textContent = 'Imported LaTeX preserved above. Click "Convert to grid" to start a fresh editable table — this does NOT auto-parse the .tex (yet); use the source for reference.';
      body.appendChild(note);
    } else {
      var note2 = document.createElement('div');
      note2.className = 'pe-unsupported';
      note2.textContent = 'Empty table — add rows/columns from the toolbar.';
      body.appendChild(note2);
    }
    wrap.appendChild(body);

    /* Observers */
    var blockObserver = function () {
      pill.dataset.status = yBlock.get('status') || 'draft';
      pill.textContent = labelForStatus(pill.dataset.status);
    };
    yBlock.observe(blockObserver);
    var attrsObserver = function () { ctx.requestRender && ctx.requestRender(); };
    attrs.observe(attrsObserver);
    var cellsMap = attrs.get('cells');
    var cellsObserver = function () { ctx.requestRender && ctx.requestRender(); };
    if (cellsMap instanceof Y.Map) cellsMap.observe(cellsObserver);

    if (ctx.registerSubscription) {
      ctx.registerSubscription(yBlock, function () {
        cellUnbinds.forEach(function (u) { try { u(); } catch (e) {} });
        try { yBlock.unobserve(blockObserver); } catch (e) {}
        try { attrs.unobserve(attrsObserver); } catch (e) {}
        if (cellsMap instanceof Y.Map) {
          try { cellsMap.unobserve(cellsObserver); } catch (e) {}
        }
      });
    }

    return wrap;
  }

  function mkSmallBtn(label, onClick) {
    var b = document.createElement('button');
    b.type = 'button';
    b.className = 'pe-section-kind pe-tbl-small-btn';
    b.style.cursor = 'pointer';
    b.textContent = label;
    b.addEventListener('click', onClick);
    return b;
  }

  /* Placeholder for kinds reserved for later phases. */
  function renderUnsupported(yBlock, ctx, kindLabel) {
    var blockId = yBlock.get('id');
    var wrap = document.createElement('div');
    wrap.className = 'pe-block';
    wrap.dataset.blockId = blockId;
    wrap.dataset.kind = yBlock.get('kind');

    var bar = document.createElement('div');
    bar.className = 'pe-block-toolbar';
    var handle = document.createElement('span');
    handle.className = 'pe-block-handle';
    handle.textContent = '⋮⋮';
    bar.appendChild(handle);
    var tag = document.createElement('span');
    tag.className = 'pe-section-kind';
    tag.textContent = kindLabel;
    bar.appendChild(tag);

    var actions = document.createElement('div');
    actions.className = 'pe-block-actions';
    var delBtn = document.createElement('button');
    delBtn.type = 'button';
    delBtn.textContent = '✕';
    delBtn.title = 'Delete block';
    delBtn.addEventListener('click', function () {
      if (!ctx.editable) return;
      ctx.onDelete(blockId);
    });
    if (!ctx.editable) delBtn.disabled = true;
    actions.appendChild(delBtn);
    bar.appendChild(actions);
    wrap.appendChild(bar);

    var msg = document.createElement('div');
    msg.className = 'pe-unsupported';
    msg.textContent = kindLabel + ' blocks ship in a later phase. The block is preserved on save but cannot be edited here yet.';
    wrap.appendChild(msg);
    return wrap;
  }

  function nextStatus(s) {
    var order = ['draft', 'needs-review', 'complete'];
    var i = order.indexOf(s);
    return order[(i + 1) % order.length];
  }
  function labelForStatus(s) {
    return ({ 'draft': 'Draft', 'needs-review': 'Needs review', 'complete': 'Complete' })[s] || 'Draft';
  }

  window.PaperBlocks = {
    renderYBlock: renderYBlock,
    nextStatus: nextStatus,
    labelForStatus: labelForStatus,
  };
})();
