/* paper-equations.js — V3.109.
 *
 * Equation library + insertion workflow for the paper builder.
 *
 * Two surfaces:
 *   1. Inline equation library — small reusable inline equations the
 *      writer builds once and inserts anywhere. Lives in
 *      paperMap.equation_library (Y.Array<Y.Map>). Inserted into prose
 *      via the right-click "Insert inline equation" picker; rendered in
 *      paragraphs via the [!eqi:<id>] token (paper-editor.js).
 *   2. Numbered equations — these are still block kind in
 *      sections.children. The Equations panel surfaces them in doc-order
 *      with their assigned numbers; the right-click "Insert equation
 *      reference" picker emits a [!eqr:<label>] token.
 *
 * Public API (window.PaperEquations):
 *   attach()                   → install the Equations topbar button + subscriptions
 *   detach()                   → tear down
 *   showPanel() / hidePanel()  → toggle the slide-out panel
 *   bindContextMenu(el)        → bind right-click on a paragraph contenteditable
 */

(function () {
  var _state = {
    attached: false,
    panel: null,
    btn: null,
    libObserver: null,
    sectionsObserver: null,
    pickerOpen: false,
    contextMenu: null,
    /* When right-click fires, remember the focused element + its caret
     * position so we can re-insert at the right spot after the user
     * picks from the popover (which steals focus). V3.141 — also track
     * the char offset, since `savedRange` becomes stale the moment the
     * contenteditable blurs and `applyRendered` swaps its innerHTML
     * (destroying the text nodes the Range references). At insertion
     * time we rebuild a fresh Range from `savedCaret` against the
     * current DOM. */
    savedRange: null,
    savedEl: null,
    savedCaret: 0,
  };

  /* Tables II — grid cell selection for merge/unmerge:
   * {blockId, r0, c0, r1, c1} (r0/c0 = click anchor; r1/c1 = shift
   * extent). Cleared on rebuild/merge. */
  var _tblSel = null;

  /* ── MathLive Visual ⇄ LaTeX toggle (E1) ─────────────────────────
   * Mounts a two-button toggle before a LaTeX <textarea>. Visual mode
   * swaps in a <math-field> (vendored MathLive via the shared
   * ensureMathlive loader); edits write BACK THROUGH THE TEXTAREA
   * (value + synthetic change/blur events), so every existing
   * persistence path runs unchanged.
   *
   * Fidelity guard: MathLive normalizes macros it doesn't model, so an
   * untouched visual open/close writes NOTHING (dirty flag) — the
   * stored LaTeX stays byte-identical unless the user actually edits. */
  function _mountVisualToggle(srcInput) {
    if (!window.ensureMathlive || !srcInput || !srcInput.parentElement) return;
    var wrap = document.createElement('div');
    wrap.className = 'pe-visual-toggle';
    var latexBtn = document.createElement('button');
    latexBtn.type = 'button'; latexBtn.textContent = 'LaTeX'; latexBtn.className = 'active';
    var visualBtn = document.createElement('button');
    visualBtn.type = 'button'; visualBtn.textContent = 'Visual';
    visualBtn.title = 'Click-and-type equation editor (writes LaTeX back)';
    wrap.appendChild(latexBtn);
    wrap.appendChild(visualBtn);
    srcInput.parentElement.insertBefore(wrap, srcInput);

    var mf = null, bar = null, dirty = false, visualOn = false;
    function reflect() {
      latexBtn.classList.toggle('active', !visualOn);
      visualBtn.classList.toggle('active', visualOn);
    }
    function commitIfDirty() {
      if (!mf || !dirty) return;
      var v = mf.getValue ? mf.getValue('latex') : mf.value;
      if (typeof v === 'string' && v !== srcInput.value) {
        srcInput.value = v;
        srcInput.dispatchEvent(new Event('change'));
        srcInput.dispatchEvent(new Event('blur'));
      }
      dirty = false;
    }
    function closeVisual() {
      commitIfDirty();
      if (mf) { try { mf.remove(); } catch (e) {} mf = null; }
      if (bar) { try { bar.remove(); } catch (e) {} bar = null; }
      srcInput.style.display = '';
      visualOn = false;
      reflect();
    }
    function openVisual() {
      visualOn = true;
      reflect();
      window.ensureMathlive().then(function () {
        if (!visualOn || mf) return;
        mf = document.createElement('math-field');
        mf.className = 'pe-mathfield';
        mf.value = srcInput.value;
        dirty = false;
        mf.addEventListener('input', function () { dirty = true; });
        mf.addEventListener('blur', commitIfDirty);
        srcInput.parentElement.insertBefore(mf, srcInput);
        /* V3.458 — accents/matrix/operator snippet bar above the field
         * (inserts fire 'input', so the dirty guard sees real edits). */
        if (window.mathliveSnippetBar) {
          bar = window.mathliveSnippetBar(mf);
          srcInput.parentElement.insertBefore(bar, mf);
        }
        srcInput.style.display = 'none';
        try { mf.focus(); } catch (e) {}
      }).catch(function (e) {
        visualOn = false;
        reflect();
        alert('The visual editor failed to load: ' + (e.message || e));
      });
    }
    latexBtn.addEventListener('click', function () { if (visualOn) closeVisual(); });
    visualBtn.addEventListener('click', function () { if (!visualOn) openVisual(); });
  }

  function attach() {
    if (_state.attached) return;
    if (!window.PaperEditor) {
      console.warn('[paper-equations] PaperEditor not loaded; deferring attach.');
      return;
    }
    _state.attached = true;

    _installPillBar();
    _installGlobalToolbar();
    _installSubscriptions();
    _installGlobalKeydown();
    _installCitationIndexListener();
    /* Tool page (?page=…) — mount the pane full-width immediately and
     * honor a ?focus=<blockId> deep link. */
    if (_isToolPage()) {
      _mountToolPage();
      _refreshPanel();
      _applyFocusParam();
    }
  }

  function detach() {
    if (!_state.attached) return;
    _state.attached = false;
    _teardownSubscriptions();
    if (_state.panel && _state.panel.parentElement) {
      _state.panel.parentElement.removeChild(_state.panel);
    }
    _state.panel = null;
    if (_state.btn && _state.btn.parentElement) {
      _state.btn.parentElement.removeChild(_state.btn);
    }
    _state.btn = null;
    _hideContextMenu();
  }

  /* V3.122 — refresh References tab when the citation index lazy-loads.
   * Bound once at attach() time. The handler is a no-op when the
   * References tab isn't active, so it's cheap. */
  function _installCitationIndexListener() {
    if (_state._citIdxBound) return;
    _state._citIdxBound = true;
    window.addEventListener('paper-citations-loaded', function () {
      if (_activeTab === 'references' && _state.panel && !_state.panel.hidden) {
        _refreshReferencesSection();
      }
    });
  }

  /* ── Pill PAGES ───────────────────────────────────────────────────────
   *
   * The former slide-out panel tabs are full editor PAGES:
   * ?paper=<id>&page=guide|equations|symbols|figures|tables|references
   * (absent = 'write', the doc editor). The pill bar is page NAVIGATION;
   * on a tool page the pane mounts full-width into #pe-toolpage-root. */
  function _currentPage() { return window.__PAPER_PAGE || 'write'; }
  function _isToolPage() { return _currentPage() !== 'write'; }
  var _pendingNav = null;   // deferred write-page navigation (showPanel shim)

  /* Navigate to a pill page (or 'write'). opts.focus scrolls that page
   * to the block on load. */
  function _gotoPage(pageId, opts) {
    if (_pendingNav) { clearTimeout(_pendingNav); _pendingNav = null; }
    var pid = window.__PAPER_ID ||
      new URLSearchParams(location.search).get('paper') || '';
    var url = location.pathname + '?paper=' + encodeURIComponent(pid);
    if (pageId && pageId !== 'write') url += '&page=' + encodeURIComponent(pageId);
    if (opts && opts.focus) url += '&focus=' + encodeURIComponent(opts.focus);
    location.href = url;
  }

  function _installPillBar() {
    var bar = document.getElementById('pe-pillbar');
    if (!bar || bar.children.length) return;
    /* Leading Write pill returns to the doc editor. */
    var pages = [{ id: 'write', plainLabel: 'Write' }].concat(TABS);
    pages.forEach(function (t) {
      var pill = document.createElement('button');
      pill.type = 'button';
      pill.className = 'pe-pill';
      pill.dataset.tab = t.id;
      pill.setAttribute('role', 'tab');
      pill.setAttribute('aria-selected', 'false');
      // No icons — text-only labels per V3.120 design.
      pill.textContent = t.plainLabel || (t.label || '').replace(/^\S+\s+/, '');
      pill.addEventListener('click', function () {
        if (t.id !== _currentPage()) _gotoPage(t.id);
      });
      bar.appendChild(pill);
    });
    _reflectPillVisibility();
    _reflectPillState();
  }

  /* V3.466 — hide pills whose TAB.visibleFor excludes this paper_type
   * (e.g. Grant Docs on a journal paper). Called at build AND from
   * _reflectPillState, so a paper_type that resolves slightly after the
   * first build still corrects on the next state sync. The Write pill
   * (not in TABS) is always shown. */
  function _reflectPillVisibility() {
    var bar = document.getElementById('pe-pillbar');
    if (!bar) return;
    var type = _paperType();
    var byId = {};
    TABS.forEach(function (t) { byId[t.id] = t; });
    bar.querySelectorAll('.pe-pill').forEach(function (p) {
      var t = byId[p.dataset.tab];
      p.hidden = !!(t && !_tabVisibleFor(t, type));
    });
  }

  function _reflectPillState() {
    var bar = document.getElementById('pe-pillbar');
    if (!bar) return;
    _reflectPillVisibility();
    var page = _currentPage();
    var pills = bar.querySelectorAll('.pe-pill');
    pills.forEach(function (p) {
      var isActive = p.dataset.tab === page;
      p.classList.toggle('active', isActive);
      p.setAttribute('aria-selected', isActive ? 'true' : 'false');
    });
  }

  /* ── V3.120 / V3.136 — global toolbar ────────────────────────────────
   *
   * Replaces the V3.107 per-paragraph rich-text toolbar with a single
   * persistent toolbar at the top of the editor. V3.136 splits the bar
   * into three labeled groups:
   *
   *   FORMAT     bold / italic / sub / sup / code  (markdown-ish styling)
   *   INLINE     Inline Eq / Citation              (insert from library;
   *                                                  renders as a chip)
   *   REFERENCE  Eq # / Fig # / Tab #              (cross-reference to a
   *                                                  numbered object)
   *
   * Each group has a small uppercase sublabel, separated by a vertical
   * divider. Rich-text buttons call PaperEditor.wrapSelectionInTokens;
   * inline & reference buttons open the relevant picker (anchored at
   * the toolbar button). Each button uses mousedown.preventDefault to
   * keep the focused contenteditable's selection alive. */
  function _installGlobalToolbar() {
    var bar = document.getElementById('pe-global-toolbar');
    if (!bar || bar.children.length) return;

    /* ── Format group ─────────────────────────────────────────────── */
    var fmtGroup = _makeGroup('format', 'Format');
    [
      { label: 'B',  title: 'Bold (Cmd+B)',   lhs: '**', cls: 'pe-gt-bold' },
      { label: 'I',  title: 'Italic (Cmd+I)', lhs: '*',  cls: 'pe-gt-italic' },
      { label: 'X₂', title: 'Subscript',      lhs: '~',  cls: 'pe-gt-sub' },
      { label: 'X²', title: 'Superscript',    lhs: '^',  cls: 'pe-gt-sup' },
      { label: '<>', title: 'Code (Cmd+E)',   lhs: '`',  cls: 'pe-gt-code' },
    ].forEach(function (b) {
      var btn = document.createElement('button');
      btn.type = 'button';
      btn.className = 'pe-gt-btn ' + b.cls;
      btn.title = b.title;
      btn.textContent = b.label;
      btn.addEventListener('mousedown', function (e) {
        e.preventDefault();
        if (window.PaperEditor && window.PaperEditor.wrapSelectionInTokens) {
          window.PaperEditor.wrapSelectionInTokens(b.lhs);
        }
      });
      fmtGroup.row.appendChild(btn);
    });
    bar.appendChild(fmtGroup.el);

    bar.appendChild(_makeDivider());

    /* ── Inline group — V3.136 — chips that render the *thing itself*
     * inline in the prose (not pointers to numbered objects). ──── */
    var inlineGroup = _makeGroup('inline', 'Inline');
    [
      { label: '+ Inline Eq', title: 'Insert inline equation chip from the library', action: _toolbarInsertInlineEquation, id: 'pe-gt-inline-eq' },
      /* V3.158 — id stamped so Cmd+K (and any other surface that opens
       * the citation popover) can anchor the popover under the same
       * `+ Cite` button regardless of which surface triggered it. */
      { label: '+ Cite',      title: 'Insert citation (Cmd+K)',                      action: _toolbarInsertCitation,       id: 'pe-gt-cite' },
      /* V3.345 — footnote token; renders as a superscript † chip and
       * exports as \footnote{}. */
      { label: '+ Note',      title: 'Insert footnote',                              action: _toolbarInsertFootnote,       id: 'pe-gt-footnote' },
      /* V3.346 — discoverability: a static shortcuts & tips card. */
      { label: '⌨',           title: 'Keyboard shortcuts & tips',                    action: _toolbarShowShortcuts,        id: 'pe-gt-shortcuts' },
    ].forEach(function (b) {
      var btn = _makeRefBtn(b);
      inlineGroup.row.appendChild(btn);
    });
    bar.appendChild(inlineGroup.el);

    bar.appendChild(_makeDivider());

    /* ── Reference group — pointers to numbered objects. ─────────── */
    var refGroup = _makeGroup('reference', 'Reference');
    [
      { label: '+ Eq',    title: 'Insert equation reference (Eq. N)',   action: _toolbarInsertEquation },
      { label: '+ Fig',   title: 'Insert figure reference (Fig. N)',    action: _toolbarInsertFigure   },
      { label: '+ Table', title: 'Insert table reference (Tab. N)',     action: _toolbarInsertTable    },
    ].forEach(function (b) {
      var btn = _makeRefBtn(b);
      refGroup.row.appendChild(btn);
    });
    bar.appendChild(refGroup.el);
  }

  function _makeGroup(id, label) {
    var el = document.createElement('div');
    el.className = 'pe-gt-group pe-gt-group-' + id;
    var lbl = document.createElement('span');
    lbl.className = 'pe-gt-group-label';
    lbl.textContent = label;
    var row = document.createElement('div');
    row.className = 'pe-gt-group-row';
    el.appendChild(lbl);
    el.appendChild(row);
    return { el: el, row: row };
  }
  function _makeDivider() {
    var d = document.createElement('span');
    d.className = 'pe-gt-divider';
    d.setAttribute('aria-hidden', 'true');
    return d;
  }
  function _makeRefBtn(b) {
    var btn = document.createElement('button');
    btn.type = 'button';
    btn.className = 'pe-gt-btn pe-gt-ref';
    btn.title = b.title;
    btn.textContent = b.label;
    if (b.id) btn.id = b.id;
    btn.addEventListener('mousedown', function (e) {
      _saveCaretFromCurrentFocus();
      e.preventDefault();
    });
    btn.addEventListener('click', function (e) {
      e.preventDefault();
      b.action(btn);
    });
    return btn;
  }

  function _saveCaretFromCurrentFocus() {
    var active = document.activeElement;
    if (active && active.isContentEditable) {
      _state.savedEl = active;
      var sel = window.getSelection();
      if (sel && sel.rangeCount && active.contains(sel.getRangeAt(0).endContainer)) {
        var live = sel.getRangeAt(0);
        _state.savedRange = live.cloneRange();
        _state.savedCaret = _readCharOffset(active, live.endContainer, live.endOffset);
        return true;
      }
      /* Element is contenteditable but no selection inside it. Build a
       * collapsed range at the end so the picker still has somewhere to
       * insert. */
      try {
        var r = document.createRange();
        r.selectNodeContents(active);
        r.collapse(false);
        _state.savedRange = r;
        _state.savedCaret = (active.textContent || '').length;
        return true;
      } catch (e) { /* fall through */ }
    }
    /* V3.140 — fall back to PaperEditor's last-focused-editable tracker.
     * The tracker survives blur (it's set on keyup/mouseup/input on
     * every contenteditable), so even if the user blurred the
     * paragraph before clicking the toolbar button, we can still
     * recover their last caret position. */
    if (window.PaperEditor && window.PaperEditor.getLastFocusedEditable) {
      var lastEl = window.PaperEditor.getLastFocusedEditable();
      var lastCaret = window.PaperEditor.getLastFocusedCaret
        ? window.PaperEditor.getLastFocusedCaret() : 0;
      if (lastEl && document.body.contains(lastEl)) {
        _state.savedEl = lastEl;
        _state.savedCaret = lastCaret || 0;
        _state.savedRange = _rangeFromCharOffset(lastEl, _state.savedCaret);
        if (_state.savedRange) return true;
      }
    }
    return false;
  }

  /* V3.141 — read a char-offset from a (container, offset) pair inside
   * a contenteditable. Mirrors PaperEditor's readCaretCharOffset.
   * V3.159 — chip-aware: atomic chip spans contribute `data-src.length`
   * bytes (not visible text length), so the offset stays in
   * source-space and round-trips through `_rangeFromCharOffset`. */
  function _readCharOffset(el, endContainer, endOffset) {
    try {
      var count = 0;
      var done = false;
      function visit(parent) {
        for (var i = 0; i < parent.childNodes.length; i++) {
          if (done) return;
          var node = parent.childNodes[i];
          if (node === endContainer && endContainer.nodeType === 3 /* TEXT_NODE */) {
            count += endOffset;
            done = true;
            return;
          }
          if (parent === endContainer && i === endOffset) {
            done = true;
            return;
          }
          if (node.nodeType === 3 /* TEXT_NODE */) {
            count += node.length;
          } else if (node.nodeType === 1 /* ELEMENT_NODE */) {
            if (node.dataset && node.dataset.src) {
              count += node.dataset.src.length;
            } else if (node.tagName === 'BR') {
              count += 1;
            } else {
              visit(node);
            }
          }
        }
        if (parent === endContainer && endOffset === parent.childNodes.length) {
          done = true;
        }
      }
      visit(el);
      return count;
    } catch (e) { return 0; }
  }

  /* V3.137 — build a collapsed range at the given character offset
   * inside `el` (a contenteditable). Mirrors PaperEditor's
   * setCaretCharOffset walker but returns the range instead of
   * applying it to window.getSelection.
   * V3.159 — chip-aware: atomic chip spans (data-src) contribute
   * `data-src.length` bytes but are not text nodes, so the walker
   * accounts for them with parent-relative positions (before/after
   * the chip node) rather than trying to set caret inside them. */
  function _rangeFromCharOffset(el, offset) {
    if (!el) return null;
    try {
      var range = document.createRange();
      var found = false;
      var charCount = 0;
      function visit(parent) {
        for (var i = 0; i < parent.childNodes.length; i++) {
          if (found) return;
          var node = parent.childNodes[i];
          if (node.nodeType === 3 /* TEXT_NODE */) {
            var next = charCount + node.length;
            if (offset >= charCount && offset <= next) {
              range.setStart(node, offset - charCount);
              range.collapse(true);
              found = true;
              return;
            }
            charCount = next;
          } else if (node.nodeType === 1 /* ELEMENT_NODE */) {
            if (node.dataset && node.dataset.src) {
              /* Atomic chip — caret lands before (if at chip start)
               * or after (anywhere inside / past chip start). */
              var chipLen = node.dataset.src.length;
              var nextC = charCount + chipLen;
              if (offset >= charCount && offset <= nextC) {
                if (offset === charCount) {
                  range.setStart(parent, i);
                } else {
                  range.setStart(parent, i + 1);
                }
                range.collapse(true);
                found = true;
                return;
              }
              charCount = nextC;
            } else if (node.tagName === 'BR') {
              var nextB = charCount + 1;
              if (offset >= charCount && offset <= nextB) {
                if (offset === charCount) {
                  range.setStart(parent, i);
                } else {
                  range.setStart(parent, i + 1);
                }
                range.collapse(true);
                found = true;
                return;
              }
              charCount = nextB;
            } else {
              visit(node);
            }
          }
        }
      }
      visit(el);
      if (!found) {
        range.selectNodeContents(el);
        range.collapse(false);
      }
      return range;
    } catch (e) { return null; }
  }

  /* V3.137 — every toolbar reference button confirms there's a caret
   * to insert into BEFORE opening the picker. The mousedown handler
   * already saved the caret if it could; if it couldn't, fall through
   * to the PaperEditor.lastFocusedEditable tracker. If neither path
   * yields a target, alert the user immediately instead of silently
   * opening a picker whose pick will silently no-op. */
  function _ensureCaretOrAlert() {
    /* V3.154 — gate on savedEl only. The Range cache is unreliable
     * (goes stale after blur+rerender, V3.143/V3.152), so we trust the
     * char-offset (savedCaret) which we'll always rebuild fresh at
     * insertion time. As long as we have a target element, the
     * insertion logic in _insertAtSavedCaret will recover. */
    if (_state.savedEl && document.body.contains(_state.savedEl)) return true;
    if (_saveCaretFromCurrentFocus()) return true;
    alert('Place your cursor in a paragraph first, then click the button to insert.');
    return false;
  }

  /* V3.136 — inline equation insert from the global toolbar. Mirrors
   * the right-click → Insert inline equation flow but doesn't require
   * the user to remember the right-click context menu. */
  function _toolbarInsertInlineEquation(anchorBtn) {
    if (!_ensureCaretOrAlert()) return;
    var rect = anchorBtn.getBoundingClientRect();
    _openInlinePicker(rect.left, rect.bottom + 4);
  }
  function _toolbarInsertEquation(anchorBtn) {
    if (!_ensureCaretOrAlert()) return;
    var rect = anchorBtn.getBoundingClientRect();
    _openRefPicker(rect.left, rect.bottom + 4);
  }
  function _toolbarInsertFigure(anchorBtn) {
    if (!_ensureCaretOrAlert()) return;
    var rect = anchorBtn.getBoundingClientRect();
    _openFigRefPicker(rect.left, rect.bottom + 4);
  }
  function _toolbarInsertTable(anchorBtn) {
    if (!_ensureCaretOrAlert()) return;
    var rect = anchorBtn.getBoundingClientRect();
    if (typeof _openTabRefPicker === 'function') {
      _openTabRefPicker(rect.left, rect.bottom + 4);
    }
  }
  function _toolbarInsertCitation(anchorBtn) {
    if (!_ensureCaretOrAlert()) return;
    _openCitationPopoverFallback();
  }

  /* V3.345 — footnote insert: prompt for the note text, insert the
   * [^text] token at the saved caret (renders immediately as a † chip
   * via the bracket-token chip path in _insertAtSavedCaret). */
  function _toolbarInsertFootnote(anchorBtn) {
    if (!_ensureCaretOrAlert()) return;
    var txt = window.prompt('Footnote text:', '');
    if (txt === null) return;
    /* Newlines always break the token; unbalanced brackets would too. */
    txt = txt.replace(/\n/g, ' ').trim();
    var d = 0, bal = true;
    for (var ci = 0; ci < txt.length; ci++) {
      if (txt[ci] === '[') d++;
      else if (txt[ci] === ']') { d--; if (d < 0) { bal = false; break; } }
    }
    if (!bal || d !== 0) txt = txt.replace(/[\[\]]/g, ' ').replace(/\s+/g, ' ').trim();
    if (!txt) return;
    _insertAtSavedCaret('[^' + txt + ']');
  }

  /* V3.346 — static shortcuts / tips card. Singleton; dismissed on
   * outside click or Esc. Content is curated, not generated. */
  var _shortcutsEl = null;
  function _toolbarShowShortcuts(anchorBtn) {
    if (_shortcutsEl && !_shortcutsEl.hidden) { _shortcutsEl.hidden = true; return; }
    if (!_shortcutsEl) {
      _shortcutsEl = document.createElement('div');
      _shortcutsEl.className = 'pe-shortcuts-pop';
      _shortcutsEl.innerHTML =
        '<div class="pe-shortcuts-title">Shortcuts &amp; tips</div>' +
        '<table class="pe-shortcuts-table">' +
          '<tr><td><kbd>Cmd/Ctrl+K</kbd></td><td>Insert citation at the caret</td></tr>' +
          '<tr><td><kbd>Cmd/Ctrl+Enter</kbd></td><td>Commit a multi-pick in the citation popover</td></tr>' +
          '<tr><td>Right-click a paragraph</td><td>Insert inline equation / references</td></tr>' +
          '<tr><td>Click a chip</td><td>Edit that citation or footnote in place</td></tr>' +
          '<tr><td><code>**b**</code> <code>*i*</code> <code>~sub~</code> <code>^sup^</code> <code>$math$</code></td><td>Inline formatting in any paragraph</td></tr>' +
          '<tr><td><code>[^text]</code></td><td>Footnote (or use + Note)</td></tr>' +
          '<tr><td>View selector</td><td>Mixed / all-skeleton / all-body reading modes</td></tr>' +
          '<tr><td>✍️ Guide pill</td><td>Section-aware writing guidance + live checks</td></tr>' +
        '</table>';
      document.body.appendChild(_shortcutsEl);
      document.addEventListener('mousedown', function (e) {
        if (_shortcutsEl && !_shortcutsEl.hidden && !_shortcutsEl.contains(e.target)) {
          _shortcutsEl.hidden = true;
        }
      });
      document.addEventListener('keydown', function (e) {
        if (e.key === 'Escape' && _shortcutsEl) _shortcutsEl.hidden = true;
      });
    }
    var rect = anchorBtn && anchorBtn.getBoundingClientRect ? anchorBtn.getBoundingClientRect() : null;
    if (rect) {
      _shortcutsEl.style.left = Math.max(10, Math.min(window.innerWidth - 380, rect.left)) + 'px';
      _shortcutsEl.style.top = (rect.bottom + 6) + 'px';
    }
    _shortcutsEl.hidden = false;
  }

  /* ── Yjs subscriptions to keep the panel + bullet pills fresh ────── */
  function _installSubscriptions() {
    var paperMap = window.PaperEditor.getPaperMap && window.PaperEditor.getPaperMap();
    if (!paperMap) {
      // Editor hasn't connected yet. Retry shortly.
      setTimeout(_installSubscriptions, 200);
      return;
    }
    var lib = paperMap.get('equation_library');
    if (lib && typeof lib.observeDeep === 'function') {
      _state.libObserver = function () { _refreshPanel(); _refreshDocChips(); };
      lib.observeDeep(_state.libObserver);
    }
    var sections = paperMap.get('sections');
    if (sections && typeof sections.observeDeep === 'function') {
      _state.sectionsObserver = function () { _refreshPanel(); _refreshDocChips(); };
      sections.observeDeep(_state.sectionsObserver);
    }
    /* V3.132 — observe unplaced libraries so panel refreshes when an
     * unplaced figure/table is created, edited, or placed/unplaced. */
    var figLib = paperMap.get('figure_unplaced');
    if (figLib && typeof figLib.observeDeep === 'function') {
      _state.figLibObserver = function () { _refreshPanel(); _refreshDocChips(); };
      figLib.observeDeep(_state.figLibObserver);
    }
    var tabLib = paperMap.get('table_unplaced');
    if (tabLib && typeof tabLib.observeDeep === 'function') {
      _state.tabLibObserver = function () { _refreshPanel(); _refreshDocChips(); };
      tabLib.observeDeep(_state.tabLibObserver);
    }
  }
  function _teardownSubscriptions() {
    var paperMap = window.PaperEditor.getPaperMap && window.PaperEditor.getPaperMap();
    if (paperMap) {
      var lib = paperMap.get('equation_library');
      if (lib && _state.libObserver) {
        try { lib.unobserveDeep(_state.libObserver); } catch (e) {}
      }
      var sections = paperMap.get('sections');
      if (sections && _state.sectionsObserver) {
        try { sections.unobserveDeep(_state.sectionsObserver); } catch (e) {}
      }
      var figLib = paperMap.get('figure_unplaced');
      if (figLib && _state.figLibObserver) {
        try { figLib.unobserveDeep(_state.figLibObserver); } catch (e) {}
      }
      var tabLib = paperMap.get('table_unplaced');
      if (tabLib && _state.tabLibObserver) {
        try { tabLib.unobserveDeep(_state.tabLibObserver); } catch (e) {}
      }
    }
    _state.libObserver = null;
    _state.sectionsObserver = null;
    _state.figLibObserver = null;
    _state.tabLibObserver = null;
  }

  /* Bump a counter on contenteditable elements with [!eqi:] / [!eqr:]
   * tokens so the Y.Text observer re-renders them with the new
   * library/numbering state. We do this by dispatching a custom event
   * that paper-editor's bindings can listen for. Cheap broadcast. */
  function _refreshDocChips() {
    /* V3.115 — fire both event names. paper-equations-changed is the
     * legacy V3.109 name (kept for back-compat in renderEquation /
     * bindYTextToContentEditable's existing listeners). paper-panel-changed
     * is the new umbrella name covering equations / figures / tables /
     * references — V3.115+ listeners use this. Once the V3.114/V3.115
     * land, the legacy alias can be retired. */
    try {
      window.dispatchEvent(new CustomEvent('paper-equations-changed'));
      window.dispatchEvent(new CustomEvent('paper-panel-changed'));
    } catch (e) { /* ignore */ }
  }

  /* V3.124 — resize the slide-out pane via mouse drag on its left edge.
   * Width is clamped to [280, 800] and persisted to localStorage on
   * mouseup. The pane is fixed-position, anchored to right: 0, so the
   * effective width = window.innerWidth - clientX. */
  function _setupResize(panel) {
    var minW = 280;
    var maxW = 800;
    document.body.classList.add('pe-pane-resizing');
    function onMove(e) {
      var newW = Math.min(maxW, Math.max(minW, window.innerWidth - e.clientX));
      panel.style.width = newW + 'px';
    }
    function onUp() {
      document.removeEventListener('mousemove', onMove);
      document.removeEventListener('mouseup', onUp);
      document.body.classList.remove('pe-pane-resizing');
      try {
        var w = parseInt(panel.style.width, 10);
        if (w) localStorage.setItem('rm_paper_pane_width', String(w));
      } catch (e) {}
    }
    document.addEventListener('mousemove', onMove);
    document.addEventListener('mouseup', onUp);
  }

  /* ── Panel → tool pages ───────────────────────────────────────────────
   * On a tool page the pane is ALWAYS mounted (full-width, in
   * #pe-toolpage-root). On the write page there is no slide-out anymore:
   * showPanel() is a legacy shim that NAVIGATES to the page of the tab
   * selected in the same tick (callers do showPanel(); setActiveTab(t);
   * — the deferred nav picks up t). */
  function showPanel() {
    if (_isToolPage()) {
      _mountToolPage();
      _refreshPanel();
      return;
    }
    if (_pendingNav) clearTimeout(_pendingNav);
    _pendingNav = setTimeout(function () {
      _pendingNav = null;
      var tab = (_activeTab && _activeTab !== 'write') ? _activeTab : 'equations';
      _gotoPage(tab);
    }, 10);
  }
  function hidePanel() {
    if (_isToolPage()) return;   // tool pages have no "closed" state
    if (_pendingNav) { clearTimeout(_pendingNav); _pendingNav = null; }
    if (_state.panel) _state.panel.hidden = true;
    _reflectPillState();
  }

  /* Mount the pane full-width into the tool-page root and pin it to the
   * page's tab. Idempotent. */
  function _mountToolPage() {
    var root = document.getElementById('pe-toolpage-root');
    if (!root) return;
    if (!_state.panel) {
      _state.panel = _buildPanel();
      _state.panel.classList.add('pe-toolpage-pane');
      root.appendChild(_state.panel);
    }
    _state.panel.hidden = false;
    _setActiveTab(_currentPage(), _state.panel);
  }

  /* ?focus=<blockId> — scroll the tool page to the block's row once its
   * list has rendered (Yjs sync is async; retry briefly). */
  function _applyFocusParam() {
    var focus = new URLSearchParams(location.search).get('focus');
    if (!focus) return;
    var page = _currentPage();
    var tries = 0;
    (function attempt() {
      tries++;
      var row = null;
      if (page === 'figures') {
        var fl = document.getElementById('pe-equations-fig-list');
        row = fl && fl.querySelector('.pe-fig-row[data-block-id="' + _escAttr(focus) + '"]');
      } else if (page === 'tables') {
        var tl = document.getElementById('pe-equations-tab-list');
        row = tl && tl.querySelector('.pe-tab-row[data-block-id="' + _escAttr(focus) + '"]');
      } else if (_state.panel) {
        row = _state.panel.querySelector('[data-block-id="' + _escAttr(focus) + '"], [data-entry-id="' + _escAttr(focus) + '"]');
      }
      if (row) {
        row.scrollIntoView({ behavior: 'smooth', block: 'center' });
        row.classList.add('pe-block-flash');
        setTimeout(function () { row.classList.remove('pe-block-flash'); }, 1200);
      } else if (tries < 10) {
        setTimeout(attempt, 500);
      }
    })();
  }

  /* V3.115 — pane DOM shape:
   *
   *   .pe-tabbed-pane
   *     .pe-equations-head           (title + close)
   *     .pe-tab-nav
   *       button[data-tab=equations]
   *       button[data-tab=figures]
   *       button[data-tab=tables]
   *       button[data-tab=references]
   *     .pe-tab-content[data-tab=equations]
   *       (existing inline library + numbered sections)
   *     .pe-tab-content[data-tab=figures]
   *       .pe-equations-list#pe-equations-fig-list
   *     .pe-tab-content[data-tab=tables]      (V3.114 placeholder)
   *     .pe-tab-content[data-tab=references]  (V3.115 placeholder)
   *
   * The panel ID stays `pe-equations-pane` for back-compat; callers
   * that selector-look for it (none currently) keep working.
   */
  var _activeTab = null;
  var TABS = [
    /* V3.120 — plainLabel is the icon-less label used by the pill bar.
     * label is the legacy V3.115 emoji-prefixed label for the in-pane
     * tab nav (kept for back-compat; slide-out pane no longer renders
     * its own tab nav, so label is unused but harmless). */
    /* V3.334 — leftmost "Guide" tab: section-aware curated writing
     * guidance + live self-checks (rendered by paper-writing-guide.js). */
    { id: 'guide',      label: '✍️ Guide',      plainLabel: 'Guide' },
    { id: 'equations',  label: '📐 Equations',  plainLabel: 'Equations' },
    /* V3.459 — math symbol palette (rendered by paper-symbols.js;
     * copy-to-clipboard tiles, user-reorderable sections). */
    { id: 'symbols',    label: '∑ Symbols',     plainLabel: 'Symbols' },
    { id: 'figures',    label: '🖼 Figures',    plainLabel: 'Figures' },
    /* V3.609 — freeform planning canvas: figure/experiment/reference/note
     * cards + arrows (rendered by paper-figure-board.js). */
    { id: 'figure-board', label: '🧭 Figure board', plainLabel: 'Figure board' },
    { id: 'tables',     label: '📋 Tables',     plainLabel: 'Tables' },
    { id: 'references', label: '📚 References', plainLabel: 'References' },
    /* V3.466 — grant submission documents + checklist. `visibleFor`
     * limits the pill to grant papers; other tabs (no visibleFor) show
     * for every paper_type. */
    { id: 'grant-docs', label: '📎 Grant Docs', plainLabel: 'Grant Docs', visibleFor: ['grant'] },
  ];

  /* V3.466 — current paper's document type (journal | grant | …), read
   * from PaperEditor (ready by attach() time). Drives `visibleFor`. */
  function _paperType() {
    try {
      var m = window.PaperEditor && window.PaperEditor.getPaperMeta && window.PaperEditor.getPaperMeta();
      return (m && m.paper_type) || 'journal';
    } catch (e) { return 'journal'; }
  }
  function _tabVisibleFor(tab, type) {
    return !tab.visibleFor || tab.visibleFor.indexOf(type) >= 0;
  }

  function _buildPanel() {
    var panel = document.createElement('aside');
    panel.id = 'pe-equations-pane';
    panel.className = 'pe-tabbed-pane pe-equations-pane';  // dual class for back-compat
    panel.hidden = true;

    /* V3.124 — resize handle on the left edge. Drag to resize the
     * pane width; saved width persists in localStorage. */
    var savedWidth = null;
    try { savedWidth = parseInt(localStorage.getItem('rm_paper_pane_width'), 10); } catch (e) {}
    if (savedWidth && savedWidth >= 280 && savedWidth <= 800) {
      panel.style.width = savedWidth + 'px';
    }
    var resizeHandle = document.createElement('div');
    resizeHandle.className = 'pe-pane-resize-handle';
    resizeHandle.title = 'Drag to resize';
    resizeHandle.addEventListener('mousedown', function (e) {
      e.preventDefault();
      _setupResize(panel);
    });
    panel.appendChild(resizeHandle);

    var head = document.createElement('div');
    head.className = 'pe-equations-head';
    var title = document.createElement('span');
    title.className = 'pe-equations-title';
    title.id = 'pe-pane-title';
    title.textContent = '📐 Panel';
    var close = document.createElement('button');
    close.type = 'button';
    close.className = 'pe-icon-btn';
    close.setAttribute('aria-label', 'Close');
    close.textContent = '×';
    close.addEventListener('click', hidePanel);
    head.appendChild(title);
    head.appendChild(close);
    panel.appendChild(head);

    /* Tab nav. */
    var nav = document.createElement('div');
    nav.className = 'pe-tab-nav';
    TABS.forEach(function (t) {
      var btn = document.createElement('button');
      btn.type = 'button';
      btn.className = 'pe-tab-btn';
      btn.dataset.tab = t.id;
      btn.textContent = t.label;
      btn.addEventListener('click', function () { _setActiveTab(t.id); });
      nav.appendChild(btn);
    });
    panel.appendChild(nav);

    /* V3.334 — Guide tab content. Scaffolded lazily by
     * paper-writing-guide.js's buildTabContent() into #pe-guide-root. */
    var guideTab = document.createElement('div');
    guideTab.className = 'pe-tab-content';
    guideTab.dataset.tab = 'guide';
    var guideRoot = document.createElement('div');
    guideRoot.id = 'pe-guide-root';
    guideRoot.className = 'pe-guide';
    guideTab.appendChild(guideRoot);
    panel.appendChild(guideTab);

    /* V3.459 — Symbols tab content (same lazy-scaffold contract as the
     * Guide: paper-symbols.js fills #pe-symbols-root). */
    var symTab = document.createElement('div');
    symTab.className = 'pe-tab-content';
    symTab.dataset.tab = 'symbols';
    var symRoot = document.createElement('div');
    symRoot.id = 'pe-symbols-root';
    symTab.appendChild(symRoot);
    panel.appendChild(symTab);

    /* V3.466 — Grant Docs tab content (grant papers only; the pill is
     * hidden otherwise). paper-grant-docs.js fills #pe-grant-docs-root
     * in R5/R6 — until it loads, _refreshPanel renders a placeholder. */
    var gdTab = document.createElement('div');
    gdTab.className = 'pe-tab-content';
    gdTab.dataset.tab = 'grant-docs';
    var gdRoot = document.createElement('div');
    gdRoot.id = 'pe-grant-docs-root';
    gdTab.appendChild(gdRoot);
    panel.appendChild(gdTab);

    /* V3.609 — Figure board tab content (same lazy-scaffold contract:
     * paper-figure-board.js fills #pe-figure-board-root). */
    var fbTab = document.createElement('div');
    fbTab.className = 'pe-tab-content';
    fbTab.dataset.tab = 'figure-board';
    var fbRoot = document.createElement('div');
    fbRoot.id = 'pe-figure-board-root';
    fbTab.appendChild(fbRoot);
    panel.appendChild(fbTab);

    /* Equations tab content. */
    var eqTab = document.createElement('div');
    eqTab.className = 'pe-tab-content';
    eqTab.dataset.tab = 'equations';
    /* V3.124 — single + Equation button at the top of the Equations
     * tab (above all sections). All equation creation funnels through
     * the modal it opens. */
    var eqAddRow = document.createElement('div');
    eqAddRow.className = 'pe-equations-section-head pe-equations-tab-add-row';
    var eqAddTitle = document.createElement('span');
    eqAddTitle.className = 'pe-equations-section-title';
    eqAddTitle.textContent = 'Equation library';
    var eqAddBtn = document.createElement('button');
    eqAddBtn.type = 'button';
    eqAddBtn.className = 'pe-equations-add-btn';
    eqAddBtn.textContent = '+ Equation';
    eqAddBtn.addEventListener('click', _openEquationCreateModal);
    /* E4 — bulk import: paste a LaTeX block (split into entries) or
     * paste MathML from Word/MathType/Google Docs. */
    var eqImportBtn = document.createElement('button');
    eqImportBtn.type = 'button';
    eqImportBtn.className = 'pe-equations-add-btn';
    eqImportBtn.textContent = '⇪ Import';
    eqImportBtn.title = 'Paste LaTeX (one equation per blank-line block) or MathML from Word';
    eqImportBtn.addEventListener('click', _openEquationImportModal);
    eqAddRow.appendChild(eqAddTitle);
    eqAddRow.appendChild(eqImportBtn);
    eqAddRow.appendChild(eqAddBtn);
    eqTab.appendChild(eqAddRow);

    /* Inline equations section (type === 'inline'). */
    var libSec = document.createElement('section');
    libSec.className = 'pe-equations-section';
    libSec.dataset.section = 'library';
    var libHead = document.createElement('div');
    libHead.className = 'pe-equations-section-head';
    var libTitle = document.createElement('span');
    libTitle.className = 'pe-equations-section-title';
    libTitle.textContent = 'Inline equations';
    var libHint = document.createElement('span');
    libHint.className = 'pe-equations-section-hint';
    libHint.textContent = '(insert via right-click → Insert inline equation)';
    libHead.appendChild(libTitle);
    libHead.appendChild(libHint);
    libSec.appendChild(libHead);
    var libList = document.createElement('div');
    libList.className = 'pe-equations-list';
    libList.id = 'pe-equations-lib-list';
    libSec.appendChild(libList);
    eqTab.appendChild(libSec);

    /* V3.124 — Main equations section (type === 'main'). Each row has
     * an "Insert as block" button that places the equation as a numbered
     * display block in the section of the last-focused paragraph. */
    var mainSec = document.createElement('section');
    mainSec.className = 'pe-equations-section';
    mainSec.dataset.section = 'main';
    var mainHead = document.createElement('div');
    mainHead.className = 'pe-equations-section-head';
    var mainTitle = document.createElement('span');
    mainTitle.className = 'pe-equations-section-title';
    mainTitle.textContent = 'Main equations';
    var mainHint = document.createElement('span');
    mainHint.className = 'pe-equations-section-hint';
    mainHint.textContent = '(insert as numbered block via the row button)';
    mainHead.appendChild(mainTitle);
    mainHead.appendChild(mainHint);
    mainSec.appendChild(mainHead);
    var mainList = document.createElement('div');
    mainList.className = 'pe-equations-list';
    mainList.id = 'pe-equations-main-list';
    mainSec.appendChild(mainList);
    eqTab.appendChild(mainSec);

    /* Numbered equations section — placed display-equation blocks. */
    var numSec = document.createElement('section');
    numSec.className = 'pe-equations-section';
    numSec.dataset.section = 'numbered';
    var numHead = document.createElement('div');
    numHead.className = 'pe-equations-section-head';
    var numTitle = document.createElement('span');
    numTitle.className = 'pe-equations-section-title';
    numTitle.textContent = 'Numbered equations';
    var numHint = document.createElement('span');
    numHint.className = 'pe-equations-section-hint';
    numHint.textContent = '(placed equation blocks in the document)';
    numHead.appendChild(numTitle);
    numHead.appendChild(numHint);
    numSec.appendChild(numHead);
    var numList = document.createElement('div');
    numList.className = 'pe-equations-list';
    numList.id = 'pe-equations-num-list';
    numSec.appendChild(numList);
    eqTab.appendChild(numSec);
    panel.appendChild(eqTab);

    /* Figures tab content. V3.132 — + Figure button creates an unplaced
     * figure in paperMap.figure_unplaced; the doc-side picker is the
     * mechanism for placing it. */
    var figTab = document.createElement('div');
    figTab.className = 'pe-tab-content';
    figTab.dataset.tab = 'figures';
    var figAddRow = document.createElement('div');
    figAddRow.className = 'pe-equations-section-head pe-equations-tab-add-row';
    var figAddTitle = document.createElement('span');
    figAddTitle.className = 'pe-equations-section-title';
    figAddTitle.textContent = 'Figure library';
    var figAddBtn = document.createElement('button');
    figAddBtn.type = 'button';
    figAddBtn.className = 'pe-equations-add-btn';
    figAddBtn.textContent = '+ Figure';
    figAddBtn.title = 'Create a new figure in the panel; place it in the doc via + Add → Figure.';
    figAddBtn.addEventListener('click', _onClickAddFigure);
    figAddRow.appendChild(figAddTitle);
    figAddRow.appendChild(figAddBtn);
    figTab.appendChild(figAddRow);

    /* F1 — "Figure builder" placeholder (Alex's later concept — this
     * card reserves the surface on the Figure editor page; the panel
     * COMPOSER below each figure's Panels row is live today). */
    var fbCard = document.createElement('div');
    fbCard.className = 'pe-figbuilder-card';
    fbCard.innerHTML = '<b>🏗 Figure builder</b> — a guided workspace for assembling ' +
      'publication figures (plots, schematics, annotations) is planned here. For now, use ' +
      '<i>🧩 Compose panels…</i> on any figure to arrange panel images into one labeled composite.';
    figTab.appendChild(fbCard);

    var figUnplacedSec = document.createElement('section');
    figUnplacedSec.className = 'pe-equations-section';
    figUnplacedSec.dataset.section = 'figures-unplaced';
    var figUnplacedHead = document.createElement('div');
    figUnplacedHead.className = 'pe-equations-section-head';
    var figUnplacedTitle = document.createElement('span');
    figUnplacedTitle.className = 'pe-equations-section-title';
    figUnplacedTitle.textContent = 'Unplaced';
    var figUnplacedHint = document.createElement('span');
    figUnplacedHint.className = 'pe-equations-section-hint';
    figUnplacedHint.textContent = '(place via + Add → Figure in any section)';
    figUnplacedHead.appendChild(figUnplacedTitle);
    figUnplacedHead.appendChild(figUnplacedHint);
    figUnplacedSec.appendChild(figUnplacedHead);
    var figUnplacedList = document.createElement('div');
    figUnplacedList.className = 'pe-equations-list';
    figUnplacedList.id = 'pe-equations-fig-unplaced-list';
    figUnplacedSec.appendChild(figUnplacedList);
    figTab.appendChild(figUnplacedSec);

    var figSec = document.createElement('section');
    figSec.className = 'pe-equations-section';
    figSec.dataset.section = 'figures';
    var figHead = document.createElement('div');
    figHead.className = 'pe-equations-section-head';
    var figTitle = document.createElement('span');
    figTitle.className = 'pe-equations-section-title';
    figTitle.textContent = 'Placed in document';
    var figHint = document.createElement('span');
    figHint.className = 'pe-equations-section-hint';
    figHint.textContent = '(numbered figures currently in the doc)';
    figHead.appendChild(figTitle);
    figHead.appendChild(figHint);
    figSec.appendChild(figHead);
    var figList = document.createElement('div');
    figList.className = 'pe-equations-list';
    figList.id = 'pe-equations-fig-list';
    figSec.appendChild(figList);
    figTab.appendChild(figSec);
    panel.appendChild(figTab);

    /* Tables tab content (V3.120). V3.132 — + Table button + unplaced
     * library mirror Figures. */
    var tabTab = document.createElement('div');
    tabTab.className = 'pe-tab-content';
    tabTab.dataset.tab = 'tables';

    var tabAddRow = document.createElement('div');
    tabAddRow.className = 'pe-equations-section-head pe-equations-tab-add-row';
    var tabAddTitle = document.createElement('span');
    tabAddTitle.className = 'pe-equations-section-title';
    tabAddTitle.textContent = 'Table library';
    var tabAddBtn = document.createElement('button');
    tabAddBtn.type = 'button';
    tabAddBtn.className = 'pe-equations-add-btn';
    tabAddBtn.textContent = '+ Table';
    tabAddBtn.title = 'Create a new table in the panel; place it in the doc via + Add → Table.';
    tabAddBtn.addEventListener('click', _onClickAddTable);
    tabAddRow.appendChild(tabAddTitle);
    tabAddRow.appendChild(tabAddBtn);
    tabTab.appendChild(tabAddRow);

    var tabUnplacedSec = document.createElement('section');
    tabUnplacedSec.className = 'pe-equations-section';
    tabUnplacedSec.dataset.section = 'tables-unplaced';
    var tabUnplacedHead = document.createElement('div');
    tabUnplacedHead.className = 'pe-equations-section-head';
    var tabUnplacedTitle = document.createElement('span');
    tabUnplacedTitle.className = 'pe-equations-section-title';
    tabUnplacedTitle.textContent = 'Unplaced';
    var tabUnplacedHint = document.createElement('span');
    tabUnplacedHint.className = 'pe-equations-section-hint';
    tabUnplacedHint.textContent = '(place via + Add → Table in any section)';
    tabUnplacedHead.appendChild(tabUnplacedTitle);
    tabUnplacedHead.appendChild(tabUnplacedHint);
    tabUnplacedSec.appendChild(tabUnplacedHead);
    var tabUnplacedList = document.createElement('div');
    tabUnplacedList.className = 'pe-equations-list';
    tabUnplacedList.id = 'pe-equations-tab-unplaced-list';
    tabUnplacedSec.appendChild(tabUnplacedList);
    tabTab.appendChild(tabUnplacedSec);

    var tabSec = document.createElement('section');
    tabSec.className = 'pe-equations-section';
    tabSec.dataset.section = 'tables';
    var tabHead = document.createElement('div');
    tabHead.className = 'pe-equations-section-head';
    var tabTitle = document.createElement('span');
    tabTitle.className = 'pe-equations-section-title';
    tabTitle.textContent = 'Placed in document';
    var tabHint = document.createElement('span');
    tabHint.className = 'pe-equations-section-hint';
    tabHint.textContent = '(numbered tables currently in the doc)';
    tabHead.appendChild(tabTitle);
    tabHead.appendChild(tabHint);
    tabSec.appendChild(tabHead);
    var tabList = document.createElement('div');
    tabList.className = 'pe-equations-list';
    tabList.id = 'pe-equations-tab-list';
    tabSec.appendChild(tabList);
    tabTab.appendChild(tabSec);
    panel.appendChild(tabTab);

    /* References tab content (V3.122). Three sections: Cited / Linked /
     * Library search. Each section renders rows of `.pe-ref-row` with
     * status badges. Search input filters the lab's full citation
     * index. */
    var refTab = document.createElement('div');
    refTab.className = 'pe-tab-content';
    refTab.dataset.tab = 'references';

    /* V3.350 — "Reading evidence for this draft" (Evidence Inbox).
     * First section so the tab reads top-to-bottom as: evidence to use →
     * already cited → linked → bibliography. Rendered by
     * paper-evidence-inbox.js (reader highlights flagged cite-in-draft +
     * claims evidence). */
    var refEvidenceSec = document.createElement('details');
    refEvidenceSec.className = 'pe-equations-section pe-equations-collapsible';
    refEvidenceSec.dataset.section = 'ref-evidence';
    refEvidenceSec.open = true;
    var refEvidenceSummary = document.createElement('summary');
    refEvidenceSummary.className = 'pe-equations-section-head';
    var refEvidenceTitle = document.createElement('span');
    refEvidenceTitle.className = 'pe-equations-section-title';
    refEvidenceTitle.textContent = 'Reading evidence for this draft';
    var refEvidenceCount = document.createElement('span');
    refEvidenceCount.className = 'pe-equations-section-hint';
    refEvidenceCount.id = 'pe-evidence-count';
    var refEvidenceRefresh = document.createElement('button');
    refEvidenceRefresh.type = 'button';
    refEvidenceRefresh.className = 'pe-icon-btn pe-evidence-refresh';
    refEvidenceRefresh.textContent = '↻';
    refEvidenceRefresh.title = 'Re-check the reader for new flagged highlights';
    refEvidenceRefresh.addEventListener('click', function (e) {
      e.preventDefault();   // don't toggle the <details>
      e.stopPropagation();
      var pid = window.PaperEditor.getPaperId && window.PaperEditor.getPaperId();
      if (window.PaperEvidenceInbox && pid) window.PaperEvidenceInbox.refresh(pid, true);
    });
    refEvidenceSummary.appendChild(refEvidenceTitle);
    refEvidenceSummary.appendChild(refEvidenceCount);
    refEvidenceSummary.appendChild(refEvidenceRefresh);
    refEvidenceSec.appendChild(refEvidenceSummary);
    var refEvidenceList = document.createElement('div');
    refEvidenceList.className = 'pe-equations-list';
    refEvidenceList.id = 'pe-references-evidence-list';
    refEvidenceSec.appendChild(refEvidenceList);
    refTab.appendChild(refEvidenceSec);

    var refSearchSec = document.createElement('section');
    refSearchSec.className = 'pe-equations-section';
    refSearchSec.dataset.section = 'ref-search';
    var refSearchHead = document.createElement('div');
    refSearchHead.className = 'pe-equations-section-head';
    var refSearchTitle = document.createElement('span');
    refSearchTitle.className = 'pe-equations-section-title';
    refSearchTitle.textContent = 'Search library';
    refSearchHead.appendChild(refSearchTitle);
    refSearchSec.appendChild(refSearchHead);
    var refSearchInput = document.createElement('input');
    refSearchInput.type = 'text';
    refSearchInput.className = 'pe-ref-search-input';
    refSearchInput.placeholder = 'Search by title, author, year, key…';
    refSearchInput.addEventListener('input', function () {
      _refreshReferencesSection();
    });
    refSearchSec.appendChild(refSearchInput);
    var refSearchList = document.createElement('div');
    refSearchList.className = 'pe-equations-list pe-ref-search-list';
    refSearchList.id = 'pe-references-search-list';
    refSearchSec.appendChild(refSearchList);
    refTab.appendChild(refSearchSec);

    /* V3.124 — Cited and Linked sections become collapsible <details>
     * elements. Default open. Search section stays as a normal section
     * (always-on input). */
    var refCitedSec = document.createElement('details');
    refCitedSec.className = 'pe-equations-section pe-equations-collapsible';
    refCitedSec.dataset.section = 'ref-cited';
    refCitedSec.open = true;
    var refCitedSummary = document.createElement('summary');
    refCitedSummary.className = 'pe-equations-section-head';
    var refCitedTitle = document.createElement('span');
    refCitedTitle.className = 'pe-equations-section-title';
    refCitedTitle.textContent = 'Cited in this draft';
    refCitedSummary.appendChild(refCitedTitle);
    refCitedSec.appendChild(refCitedSummary);
    var refCitedList = document.createElement('div');
    refCitedList.className = 'pe-equations-list';
    refCitedList.id = 'pe-references-cited-list';
    refCitedSec.appendChild(refCitedList);
    refTab.appendChild(refCitedSec);

    var refLinkedSec = document.createElement('details');
    refLinkedSec.className = 'pe-equations-section pe-equations-collapsible';
    refLinkedSec.dataset.section = 'ref-linked';
    refLinkedSec.open = true;
    var refLinkedSummary = document.createElement('summary');
    refLinkedSummary.className = 'pe-equations-section-head';
    var refLinkedTitle = document.createElement('span');
    refLinkedTitle.className = 'pe-equations-section-title';
    refLinkedTitle.textContent = 'Linked but not cited';
    var refLinkedHint = document.createElement('span');
    refLinkedHint.className = 'pe-equations-section-hint';
    refLinkedHint.textContent = '(meta.library.linked_drafts)';
    refLinkedSummary.appendChild(refLinkedTitle);
    refLinkedSummary.appendChild(refLinkedHint);
    refLinkedSec.appendChild(refLinkedSummary);
    var refLinkedList = document.createElement('div');
    refLinkedList.className = 'pe-equations-list';
    refLinkedList.id = 'pe-references-linked-list';
    refLinkedSec.appendChild(refLinkedList);
    refTab.appendChild(refLinkedSec);

    /* V3.345 — live bibliography preview: the cited entries formatted
     * as reference-list rows, ordered as the export will number them
     * (first appearance). Final style comes from the LaTeX template at
     * export; this is a working preview. */
    var refBibSec = document.createElement('details');
    refBibSec.className = 'pe-equations-section pe-equations-collapsible';
    refBibSec.dataset.section = 'ref-bibliography';
    var refBibSummary = document.createElement('summary');
    refBibSummary.className = 'pe-equations-section-head';
    var refBibTitle = document.createElement('span');
    refBibTitle.className = 'pe-equations-section-title';
    refBibTitle.textContent = 'Bibliography preview';
    var refBibHint = document.createElement('span');
    refBibHint.className = 'pe-equations-section-hint';
    refBibHint.textContent = '(first-appearance order — final style set by the export template)';
    refBibSummary.appendChild(refBibTitle);
    refBibSummary.appendChild(refBibHint);
    refBibSec.appendChild(refBibSummary);
    var refBibList = document.createElement('div');
    refBibList.className = 'pe-equations-list';
    refBibList.id = 'pe-references-bib-list';
    refBibSec.appendChild(refBibList);
    refTab.appendChild(refBibSec);

    panel.appendChild(refTab);

    /* Restore active tab from localStorage (default: equations). */
    var saved = null;
    try { saved = localStorage.getItem('rm_paper_active_tab'); } catch (e) {}
    var pickedTab = TABS.some(function (t) { return t.id === saved; }) ? saved : 'equations';
    _setActiveTab(pickedTab, panel);

    return panel;
  }

  function _setActiveTab(tabId, panelEl) {
    panelEl = panelEl || _state.panel;
    if (!panelEl) return;
    _activeTab = tabId;
    try { localStorage.setItem('rm_paper_active_tab', tabId); } catch (e) {}
    /* Toggle btn + content visibility. */
    var btns = panelEl.querySelectorAll('.pe-tab-btn');
    btns.forEach(function (b) {
      b.classList.toggle('active', b.dataset.tab === tabId);
    });
    var contents = panelEl.querySelectorAll('.pe-tab-content');
    contents.forEach(function (c) {
      c.style.display = (c.dataset.tab === tabId) ? '' : 'none';
    });
    /* Refresh the now-visible tab. */
    if (!panelEl.hidden) _refreshPanel();
  }

  function _refreshPanel() {
    if (!_state.panel || _state.panel.hidden) return;
    /* V3.351 — a stale citation index re-fetches when the References tab
     * is on screen (fire-and-forget; rows re-render on
     * 'paper-citations-loaded'). */
    if (_activeTab === 'references' && window.PaperEditor &&
        window.PaperEditor.ensureFreshCitationIndex) {
      window.PaperEditor.ensureFreshCitationIndex();
    }
    if (_activeTab === 'guide') {
      /* V3.334 — the Guide tab is rendered by paper-writing-guide.js.
       * buildTabContent is idempotent (re-binds the root + renders). */
      if (window.PaperWritingGuide) {
        window.PaperWritingGuide.buildTabContent(document.getElementById('pe-guide-root'));
      }
      return;
    }
    if (_activeTab === 'symbols') {
      /* V3.459 — rendered by paper-symbols.js (idempotent, like Guide). */
      if (window.PaperSymbols) {
        window.PaperSymbols.buildTabContent(document.getElementById('pe-symbols-root'));
      }
      return;
    }
    if (_activeTab === 'grant-docs') {
      /* V3.466 — rendered by paper-grant-docs.js (loaded in R5/R6). Until
       * then, an explanatory placeholder so the pill/page never dead-ends. */
      var gdRoot = document.getElementById('pe-grant-docs-root');
      if (gdRoot) {
        if (window.PaperGrantDocs && window.PaperGrantDocs.buildTabContent) {
          window.PaperGrantDocs.buildTabContent(gdRoot);
        } else if (!gdRoot.dataset.placeheld) {
          gdRoot.dataset.placeheld = '1';
          gdRoot.innerHTML =
            '<div class="pe-grant-docs-placeholder">' +
            '<h2>Grant Documents</h2>' +
            '<p>Your submission checklist and reusable biosketch / facilities / ' +
            'boilerplate templates will appear here.</p>' +
            '<p class="pe-grant-docs-hint">Attached documents (Biosketch, Facilities, ' +
            'Budget Justification, …) are added from the <strong>+ Add section</strong> ' +
            'menu on the Write page; each carries its own upload slot and compiles as a ' +
            'separate PDF.</p>' +
            '</div>';
        }
      }
      return;
    }
    if (_activeTab === 'figure-board') {
      /* V3.609 — rendered by paper-figure-board.js (idempotent, like
       * Guide/Symbols/Grant Docs). */
      if (window.PaperFigureBoard) {
        window.PaperFigureBoard.buildTabContent(document.getElementById('pe-figure-board-root'));
      }
      return;
    }
    if (_activeTab === 'equations') {
      _refreshLibrarySection();
      _refreshMainSection();
      _refreshNumberedSection();
    } else if (_activeTab === 'figures') {
      _refreshFiguresSection();
    } else if (_activeTab === 'tables') {
      _refreshTablesSection();
    } else if (_activeTab === 'references') {
      _refreshReferencesSection();
    }
  }

  function _refreshLibrarySection() {
    var listEl = document.getElementById('pe-equations-lib-list');
    if (!listEl) return;
    /* V3.124 — only inline-typed entries appear here. Main entries
     * have their own section + Insert-as-block action. */
    var entries = window.PaperEditor.getInlineEquationLibrary()
      .filter(function (e) { return e.type !== 'main'; });
    listEl.innerHTML = '';
    if (!entries.length) {
      var empty = document.createElement('div');
      empty.className = 'pe-equations-empty';
      empty.textContent = 'No inline equations yet. Click "+ Equation" above to create one.';
      listEl.appendChild(empty);
      return;
    }
    entries.forEach(function (e) {
      listEl.appendChild(_buildLibraryRow(e));
    });
  }

  /* V3.124 — Main equations library section. Same row pattern as
   * Inline but with a different per-row action set: the primary action
   * is "Insert as block" (places a numbered display equation block in
   * the section of the last-focused paragraph) rather than "Insert"
   * (which would inline at caret). */
  function _refreshMainSection() {
    var listEl = document.getElementById('pe-equations-main-list');
    if (!listEl) return;
    var entries = window.PaperEditor.getInlineEquationLibrary()
      .filter(function (e) { return e.type === 'main'; });
    listEl.innerHTML = '';
    if (!entries.length) {
      var empty = document.createElement('div');
      empty.className = 'pe-equations-empty';
      empty.textContent = 'No main equations yet. Click "+ Equation" above and pick "main" to create one.';
      listEl.appendChild(empty);
      return;
    }
    entries.forEach(function (e) {
      listEl.appendChild(_buildMainRow(e));
    });
  }

  function _buildMainRow(entry) {
    var row = document.createElement('div');
    row.className = 'pe-eq-library-row';
    row.dataset.eqId = entry.id;

    var header = document.createElement('div');
    header.className = 'pe-eq-library-row-head';
    var nameInput = document.createElement('input');
    nameInput.type = 'text';
    nameInput.className = 'pe-eq-library-name';
    nameInput.value = entry.name || '';
    nameInput.placeholder = 'Name (e.g. Hookes law)';
    nameInput.addEventListener('change', function () {
      _updateLibraryEntry(entry.id, { name: nameInput.value });
    });
    header.appendChild(nameInput);

    var actions = document.createElement('div');
    actions.className = 'pe-eq-library-row-actions';
    var insertBtn = document.createElement('button');
    insertBtn.type = 'button';
    insertBtn.className = 'pe-eq-library-insert-btn';
    insertBtn.title = 'Place as numbered display block in the section of the last-focused paragraph';
    insertBtn.textContent = 'Insert as block';
    insertBtn.addEventListener('click', function (e) {
      e.preventDefault();
      _insertMainAsBlock(entry);
    });
    var delBtn = document.createElement('button');
    delBtn.type = 'button';
    delBtn.className = 'pe-icon-btn';
    delBtn.title = 'Delete';
    delBtn.textContent = '🗑';
    delBtn.addEventListener('click', function () {
      if (!confirm('Delete this main equation? Already-placed blocks in the document are not removed.')) return;
      _deleteLibraryEntry(entry.id);
    });
    actions.appendChild(insertBtn);
    actions.appendChild(delBtn);
    header.appendChild(actions);
    row.appendChild(header);

    var srcLabel = document.createElement('div');
    srcLabel.className = 'pe-eq-library-srclabel';
    srcLabel.textContent = 'LaTeX source';
    row.appendChild(srcLabel);

    var srcInput = document.createElement('textarea');
    srcInput.className = 'pe-eq-library-src';
    srcInput.rows = 2;
    srcInput.value = entry.latex || '';
    srcInput.placeholder = 'e.g. F = kx';
    srcInput.addEventListener('change', function () {
      _updateLibraryEntry(entry.id, { latex: srcInput.value });
    });
    srcInput.addEventListener('blur', function () { _renderRowPreview(row, srcInput.value); });
    row.appendChild(srcInput);
    _mountVisualToggle(srcInput);   // E1 — MathLive Visual ⇄ LaTeX

    var preview = document.createElement('div');
    preview.className = 'pe-eq-library-preview';
    row.appendChild(preview);
    _renderRowPreview(row, entry.latex || '');

    return row;
  }

  /* V3.124 — find the section containing the last-focused paragraph
   * (or any paragraph block) by walking up from _state.savedEl. The
   * section's id is on the .pe-section ancestor's data-section-id; if
   * not found, fall back to the first section in the document. */
  function _resolveSectionIdForInsert() {
    var el = _state.savedEl;
    if (!el && document.activeElement && document.activeElement.isContentEditable) {
      el = document.activeElement;
    }
    while (el && el !== document.body) {
      if (el.classList && el.classList.contains('pe-section') && el.dataset && el.dataset.sectionId) {
        return el.dataset.sectionId;
      }
      el = el.parentElement;
    }
    /* Fallback: first section. */
    var paperMap = window.PaperEditor.getPaperMap && window.PaperEditor.getPaperMap();
    if (!paperMap) return null;
    var sections = paperMap.get('sections');
    if (!sections || typeof sections.get !== 'function') return null;
    var first = sections.get(0);
    return first && first.get && first.get('id') || null;
  }

  function _insertMainAsBlock(entry) {
    var sectionId = _resolveSectionIdForInsert();
    if (!sectionId) {
      alert('Place the cursor in a paragraph first so the equation knows which section to land in.');
      return;
    }
    if (!window.PaperEditor.addEquationToSection) {
      alert('Equation block insertion is not available.');
      return;
    }
    /* Auto-slug a label from the entry name. Strip non-alphanumerics. */
    var label = '';
    if (entry.name) {
      label = 'eq:' + entry.name.replace(/[^a-z0-9_-]+/gi, '-').replace(/^-+|-+$/g, '').toLowerCase();
    }
    window.PaperEditor.addEquationToSection(sectionId, {
      body: entry.latex || '',
      display: true,
      numbered: true,
      label: label,
    });
    /* Refresh the panel so the new numbered block shows up below. */
    _refreshPanel();
  }

  /* V3.124 — single equation creation modal. Replaces V3.109's empty
   * "+ New inline" + inline-row LaTeX editing with a discrete
   * dialog: Name + LaTeX + type radio. */
  function _openEquationCreateModal() {
    if (typeof PaperEditor === 'undefined' && !window.PaperEditor) return;
    var existing = document.getElementById('pe-eq-create-modal');
    if (existing) existing.remove();

    var overlay = document.createElement('div');
    overlay.className = 'pe-claim-flag-modal-overlay';
    overlay.id = 'pe-eq-create-modal';

    var card = document.createElement('div');
    card.className = 'pe-claim-flag-modal-card';

    var head = document.createElement('div');
    head.className = 'pe-claim-flag-modal-head';
    var title = document.createElement('h3');
    title.textContent = 'New equation';
    var closeBtn = document.createElement('button');
    closeBtn.type = 'button';
    closeBtn.className = 'pe-icon-btn';
    closeBtn.textContent = '×';
    closeBtn.addEventListener('click', function () { overlay.remove(); });
    head.appendChild(title);
    head.appendChild(closeBtn);
    card.appendChild(head);

    var body = document.createElement('div');
    body.className = 'pe-claim-flag-modal-body';

    var nameLabel = document.createElement('label');
    nameLabel.textContent = 'Name (optional)';
    body.appendChild(nameLabel);
    var nameInput = document.createElement('input');
    nameInput.type = 'text';
    nameInput.className = 'pe-claim-flag-statement';
    nameInput.placeholder = 'e.g. Hookes law, alpha';
    body.appendChild(nameInput);

    var srcLabel = document.createElement('label');
    srcLabel.textContent = 'LaTeX source';
    body.appendChild(srcLabel);
    var srcInput = document.createElement('textarea');
    srcInput.className = 'pe-claim-flag-statement';
    srcInput.rows = 3;
    srcInput.placeholder = 'F = kx';
    body.appendChild(srcInput);
    _mountVisualToggle(srcInput);   // E1 — MathLive Visual ⇄ LaTeX

    var typeLabel = document.createElement('label');
    typeLabel.textContent = 'Type';
    body.appendChild(typeLabel);
    var typeWrap = document.createElement('div');
    typeWrap.className = 'pe-eq-create-type-wrap';
    [
      { val: 'inline', label: 'Inline (small in-prose equation)' },
      { val: 'main',   label: 'Main (numbered display block when placed)' },
    ].forEach(function (opt) {
      var lbl = document.createElement('label');
      lbl.className = 'pe-eq-create-type-radio';
      var radio = document.createElement('input');
      radio.type = 'radio';
      radio.name = 'pe-eq-create-type';
      radio.value = opt.val;
      if (opt.val === 'inline') radio.checked = true;
      lbl.appendChild(radio);
      var sp = document.createElement('span');
      sp.textContent = opt.label;
      lbl.appendChild(sp);
      typeWrap.appendChild(lbl);
    });
    body.appendChild(typeWrap);

    var errEl = document.createElement('div');
    errEl.className = 'pe-claim-flag-err';
    errEl.style.display = 'none';
    body.appendChild(errEl);

    card.appendChild(body);

    var foot = document.createElement('div');
    foot.className = 'pe-claim-flag-modal-foot';
    var cancelBtn = document.createElement('button');
    cancelBtn.type = 'button';
    cancelBtn.className = 'btn';
    cancelBtn.textContent = 'Cancel';
    cancelBtn.addEventListener('click', function () { overlay.remove(); });
    var saveBtn = document.createElement('button');
    saveBtn.type = 'button';
    saveBtn.className = 'btn btn-primary';
    saveBtn.textContent = 'Create';
    saveBtn.addEventListener('click', function () {
      var name = (nameInput.value || '').trim();
      var latex = (srcInput.value || '').trim();
      if (!latex) {
        errEl.textContent = 'LaTeX source is required.';
        errEl.style.display = '';
        srcInput.focus();
        return;
      }
      var typeRadio = typeWrap.querySelector('input[name="pe-eq-create-type"]:checked');
      var type = (typeRadio && typeRadio.value) || 'inline';
      _createEquationLibraryEntry({ name: name, latex: latex, type: type });
      /* V3.125 — when invoked via openEquationCreateModalAt(sectionId,
       * idx) from the inline + Add inserter, also place the new
       * equation as a block at the requested position. Only fires for
       * type === 'main' since inline equations land in the library
       * for in-prose use. */
      if (type === 'main' && _state.pendingInsertSectionId != null &&
          _state.pendingInsertIdx != null && window.PaperEditor &&
          window.PaperEditor.insertBlockAt) {
        var label = '';
        if (name) {
          label = 'eq:' + name.replace(/[^a-z0-9_-]+/gi, '-').replace(/^-+|-+$/g, '').toLowerCase();
        }
        window.PaperEditor.insertBlockAt(
          _state.pendingInsertSectionId,
          _state.pendingInsertIdx,
          'equation',
          { body: latex, display: true, numbered: true, label: label }
        );
      }
      _state.pendingInsertSectionId = null;
      _state.pendingInsertIdx = null;
      overlay.remove();
    });
    foot.appendChild(cancelBtn);
    foot.appendChild(saveBtn);
    card.appendChild(foot);

    overlay.appendChild(card);
    overlay.addEventListener('click', function (e) {
      if (e.target === overlay) overlay.remove();
    });
    document.addEventListener('keydown', function escH(e) {
      if (e.key === 'Escape' && document.body.contains(overlay)) {
        overlay.remove();
        document.removeEventListener('keydown', escH);
      }
    });

    document.body.appendChild(overlay);
    setTimeout(function () { nameInput.focus(); }, 50);
  }

  function _createEquationLibraryEntry(opts) {
    var paperMap = window.PaperEditor.getPaperMap();
    var Y = window.PaperEditor.getY();
    if (!paperMap || !Y) return;
    var lib = paperMap.get('equation_library');
    if (!lib) return;
    paperMap.doc.transact(function () {
      var m = new Y.Map();
      lib.push([m]);
      m.set('id', window.PaperSchemas.shortId('eq-'));
      m.set('name', new Y.Text(opts.name || ''));
      m.set('latex', new Y.Text(opts.latex || ''));
      m.set('type', opts.type === 'main' ? 'main' : 'inline');
    }, 'eq-library-add');
  }

  function _buildLibraryRow(entry) {
    var row = document.createElement('div');
    row.className = 'pe-eq-library-row';
    row.dataset.eqId = entry.id;

    var header = document.createElement('div');
    header.className = 'pe-eq-library-row-head';
    var nameInput = document.createElement('input');
    nameInput.type = 'text';
    nameInput.className = 'pe-eq-library-name';
    nameInput.value = entry.name || '';
    nameInput.placeholder = 'Name (e.g. alpha, fine-structure)';
    nameInput.addEventListener('change', function () {
      _updateLibraryEntry(entry.id, { name: nameInput.value });
    });
    header.appendChild(nameInput);

    var actions = document.createElement('div');
    actions.className = 'pe-eq-library-row-actions';
    var insertBtn = document.createElement('button');
    insertBtn.type = 'button';
    insertBtn.className = 'pe-eq-library-insert-btn';
    insertBtn.title = 'Insert at the last paragraph caret position';
    insertBtn.textContent = 'Insert';
    insertBtn.addEventListener('click', function (e) {
      e.preventDefault();
      _insertInlineEquationAtSavedCaret(entry.id);
    });
    var delBtn = document.createElement('button');
    delBtn.type = 'button';
    delBtn.className = 'pe-icon-btn';
    delBtn.title = 'Delete';
    delBtn.textContent = '🗑';
    delBtn.addEventListener('click', function () {
      if (!confirm('Delete this inline equation? Existing references in the paper will show "[?eq]" until updated.')) return;
      _deleteLibraryEntry(entry.id);
    });
    actions.appendChild(insertBtn);
    actions.appendChild(delBtn);
    header.appendChild(actions);
    row.appendChild(header);

    /* LaTeX source editor. */
    var srcLabel = document.createElement('div');
    srcLabel.className = 'pe-eq-library-srclabel';
    srcLabel.textContent = 'LaTeX source';
    row.appendChild(srcLabel);

    var srcInput = document.createElement('textarea');
    srcInput.className = 'pe-eq-library-src';
    srcInput.rows = 2;
    srcInput.value = entry.latex || '';
    srcInput.placeholder = 'e.g. \\alpha = 1/137';
    srcInput.addEventListener('change', function () {
      _updateLibraryEntry(entry.id, { latex: srcInput.value });
    });
    srcInput.addEventListener('blur', function () {
      // Re-render preview on blur.
      _renderRowPreview(row, srcInput.value);
    });
    row.appendChild(srcInput);
    _mountVisualToggle(srcInput);   // E1 — MathLive Visual ⇄ LaTeX

    /* KaTeX preview. */
    var preview = document.createElement('div');
    preview.className = 'pe-eq-library-preview';
    row.appendChild(preview);
    _renderRowPreview(row, entry.latex || '');

    return row;
  }

  function _renderRowPreview(rowEl, latex) {
    var preview = rowEl.querySelector('.pe-eq-library-preview');
    if (!preview) return;
    if (!latex) {
      preview.textContent = '(empty preview)';
      preview.classList.add('pe-eq-library-preview-empty');
      return;
    }
    preview.classList.remove('pe-eq-library-preview-empty');
    var html = window.PaperEditor.renderEquationHtml(latex, false);
    preview.innerHTML = html || '<span class="pe-math-err">(KaTeX render failed)</span>';
  }

  function _refreshNumberedSection() {
    var listEl = document.getElementById('pe-equations-num-list');
    if (!listEl) return;
    var nums = window.PaperEditor.getNumberedEquations();
    listEl.innerHTML = '';
    if (!nums.length) {
      var empty = document.createElement('div');
      empty.className = 'pe-equations-empty';
      empty.textContent = 'No numbered equations yet. Add an Equation block in any section, set Display + Numbered.';
      listEl.appendChild(empty);
      return;
    }
    nums.forEach(function (n) {
      var row = document.createElement('div');
      row.className = 'pe-eq-numbered-row';
      row.dataset.blockId = n.blockId;
      row.innerHTML =
        '<div class="pe-eq-numbered-head">' +
          '<span class="pe-eq-num-badge">Eq. ' + n.num + '</span>' +
          '<span class="pe-eq-numbered-label">' + _escAttr(n.label) + '</span>' +
        '</div>' +
        '<div class="pe-eq-numbered-preview"></div>';
      var preview = row.querySelector('.pe-eq-numbered-preview');
      if (n.latex) {
        preview.innerHTML = window.PaperEditor.renderEquationHtml(n.latex, true);
      } else {
        preview.textContent = '(empty)';
        preview.classList.add('pe-eq-numbered-preview-empty');
      }
      row.addEventListener('click', function () { _scrollToBlock(n.blockId); });
      listEl.appendChild(row);
    });
  }

  /* ── Figures tab (V3.115, expanded V3.132) ───────────────────────── */
  function _refreshFiguresSection() {
    /* V3.132 — two lists: unplaced (library) + placed-in-doc. The full
     * row editor (V3.131) is the same for both; the placement controls
     * differ via _buildFigureRow's `placement` parameter. */
    _refreshFiguresUnplacedList();
    _refreshFiguresPlacedList();
  }
  function _refreshFiguresUnplacedList() {
    var listEl = document.getElementById('pe-equations-fig-unplaced-list');
    if (!listEl) return;
    var entries = window.PaperEditor.getUnplacedFigures
      ? window.PaperEditor.getUnplacedFigures()
      : [];
    listEl.innerHTML = '';
    if (!entries.length) {
      var empty = document.createElement('div');
      empty.className = 'pe-equations-empty';
      empty.textContent = 'No unplaced figures. Click "+ Figure" above to create one in the panel.';
      listEl.appendChild(empty);
      return;
    }
    entries.forEach(function (f) {
      var fakeFig = {
        blockId: f.blockId,
        label: f.label,
        downloadUrl: f.downloadUrl,
        num: null,             /* unplaced figures have no number */
        subfigures: [],
      };
      listEl.appendChild(_buildFigureRow(fakeFig, { placement: 'unplaced' }));
    });
  }
  function _refreshFiguresPlacedList() {
    var listEl = document.getElementById('pe-equations-fig-list');
    if (!listEl) return;
    var figs = window.PaperEditor.getNumberedFigures
      ? window.PaperEditor.getNumberedFigures()
      : [];
    var allFigs = window.PaperEditor.getAllFigures
      ? window.PaperEditor.getAllFigures()
      : figs;
    listEl.innerHTML = '';
    if (!allFigs.length) {
      var empty = document.createElement('div');
      empty.className = 'pe-equations-empty';
      empty.textContent = 'No figures placed in the doc yet. Use + Add → Figure in a section to place one.';
      listEl.appendChild(empty);
      return;
    }
    allFigs.forEach(function (f) {
      listEl.appendChild(_buildFigureRow(f, { placement: 'placed' }));
    });
  }

  function _onClickAddFigure() {
    if (!window.PaperEditor || !window.PaperEditor.createUnplacedFigure) return;
    var blockId = window.PaperEditor.createUnplacedFigure();
    if (!blockId) return;
    /* Flash the new row + scroll into view after the next render tick. */
    setTimeout(function () {
      var listEl = document.getElementById('pe-equations-fig-unplaced-list');
      if (!listEl) return;
      var row = listEl.querySelector('.pe-fig-row[data-block-id="' + _escAttr(blockId) + '"]');
      if (!row) return;
      row.scrollIntoView({ behavior: 'smooth', block: 'center' });
      row.classList.add('pe-block-flash');
      setTimeout(function () { row.classList.remove('pe-block-flash'); }, 1200);
    }, 60);
  }

  /* V3.131 — redesigned Figures-tab row. Four sections in user-task
   * order: header (identity + actions) → caption (most-edited field) →
   * sub-panels (for Fig. N (B-C) refs) → layout (collapsed; rare edits
   * + once-per-figure upload). The redundant caption-preview line from
   * V3.115 is gone — the editor is the single caption surface. */
  function _buildFigureRow(fig, opts) {
    opts = opts || {};
    var placement = opts.placement || 'placed';
    var row = document.createElement('div');
    row.className = 'pe-fig-row pe-fig-row-v131 pe-fig-row-' + placement;
    row.dataset.blockId = fig.blockId;
    row.dataset.placement = placement;

    /* Resolve the live block once; all editor controls write through
     * blk.doc.transact so the row is always in lock-step with Yjs. */
    var blk = _findFigureBlock(fig.blockId);
    var attrs = blk && blk.get('attrs');
    var Y = window.PaperEditor.getY();

    /* ── Header: thumbnail (with Fig. N overlay) + label + numbered +
     * actions. ── */
    var header = document.createElement('div');
    header.className = 'pe-fig-row-header';

    /* Thumbnail + number badge overlay. */
    var thumb = document.createElement('div');
    thumb.className = 'pe-fig-thumb pe-fig-thumb-large';
    if (fig.downloadUrl) {
      var img = document.createElement('img');
      img.src = fig.downloadUrl;
      img.alt = fig.alt || '';
      thumb.appendChild(img);
    } else {
      var emptyHint = document.createElement('span');
      emptyHint.className = 'pe-fig-thumb-empty-hint';
      emptyHint.textContent = 'No image yet';
      thumb.appendChild(emptyHint);
      thumb.classList.add('pe-fig-thumb-empty');
    }
    if (fig.numbered && fig.num) {
      var badge = document.createElement('span');
      badge.className = 'pe-fig-num-badge-overlay';
      badge.textContent = 'Fig. ' + fig.num;
      thumb.appendChild(badge);
    } else if (placement === 'unplaced') {
      var unBadge = document.createElement('span');
      unBadge.className = 'pe-fig-num-badge-overlay pe-fig-num-badge-unplaced';
      unBadge.textContent = 'Unplaced';
      thumb.appendChild(unBadge);
    }
    header.appendChild(thumb);

    /* Identity column: label + numbered toggle. */
    var idCol = document.createElement('div');
    idCol.className = 'pe-fig-id-col';

    var labelInput = document.createElement('input');
    labelInput.type = 'text';
    labelInput.className = 'pe-fig-label-input pe-fig-label-input-large';
    labelInput.value = fig.label || '';
    labelInput.placeholder = 'fig:cellgrowth';
    labelInput.title = 'Label for cross-references — auto-prefixed with fig:';
    labelInput.addEventListener('change', function () {
      var v = (labelInput.value || '').trim();
      if (v && !/^fig:/.test(v)) {
        v = 'fig:' + v.replace(/[^a-z0-9_-]+/gi, '-').replace(/^-+|-+$/g, '').toLowerCase();
      }
      labelInput.value = v;
      _updateFigureAttrs(fig.blockId, function (a) { a.set('label', v); });
    });
    idCol.appendChild(labelInput);

    var numWrap = document.createElement('label');
    numWrap.className = 'pe-fig-numbered-toggle';
    var numCb = document.createElement('input');
    numCb.type = 'checkbox';
    numCb.checked = fig.numbered !== false;
    numCb.addEventListener('change', function () {
      _updateFigureAttrs(fig.blockId, function (a) { a.set('numbered', !!numCb.checked); });
    });
    var numLbl = document.createElement('span');
    numLbl.textContent = 'Numbered';
    numWrap.appendChild(numCb);
    numWrap.appendChild(numLbl);
    idCol.appendChild(numWrap);

    header.appendChild(idCol);

    /* Actions column. V3.132 — buttons differ by placement: unplaced
     * figures get Place + Delete; placed get Insert reference + Scroll
     * to block + Unplace + Delete. */
    var actionsCol = document.createElement('div');
    actionsCol.className = 'pe-fig-actions-col';

    if (placement === 'placed') {
      var insertBtn = document.createElement('button');
      insertBtn.type = 'button';
      insertBtn.className = 'pe-fig-action-btn pe-fig-action-primary';
      insertBtn.textContent = 'Insert reference';
      insertBtn.title = 'Insert at the last paragraph caret position';
      insertBtn.addEventListener('click', function (e) {
        e.preventDefault();
        _insertFigureReferenceAtSavedCaret(fig);
      });
      actionsCol.appendChild(insertBtn);

      var openBtn = document.createElement('button');
      openBtn.type = 'button';
      openBtn.className = 'pe-fig-action-btn';
      openBtn.textContent = 'Scroll to block';
      openBtn.addEventListener('click', function () { _scrollToBlock(fig.blockId); });
      actionsCol.appendChild(openBtn);

      var unplaceBtn = document.createElement('button');
      unplaceBtn.type = 'button';
      unplaceBtn.className = 'pe-fig-action-btn';
      unplaceBtn.textContent = 'Unplace';
      unplaceBtn.title = 'Move this figure back to the unplaced library (keep its image + caption + sub-panels).';
      unplaceBtn.addEventListener('click', function () {
        var foundSecId = _findContainingSectionId(fig.blockId);
        if (foundSecId && window.PaperEditor && window.PaperEditor.unplaceBlock) {
          window.PaperEditor.unplaceBlock(foundSecId, fig.blockId);
        }
      });
      actionsCol.appendChild(unplaceBtn);
    } else {
      /* Unplaced — primary action is Place at end of a section. */
      var placeBtn = document.createElement('button');
      placeBtn.type = 'button';
      placeBtn.className = 'pe-fig-action-btn pe-fig-action-primary';
      placeBtn.textContent = 'Place in section…';
      placeBtn.title = 'Pick a section to place this figure at the end of.';
      placeBtn.addEventListener('click', function (e) {
        e.preventDefault();
        _openPlaceUnplacedPicker('figure', fig.blockId, placeBtn);
      });
      actionsCol.appendChild(placeBtn);
    }

    var delBtn = document.createElement('button');
    delBtn.type = 'button';
    delBtn.className = 'pe-fig-action-btn pe-fig-action-danger';
    delBtn.textContent = 'Delete figure';
    delBtn.addEventListener('click', function () {
      var msg = (placement === 'unplaced')
        ? 'Delete this figure from the panel library?'
        : 'Delete this figure? The block will be removed from the document.';
      if (!confirm(msg)) return;
      if (placement === 'unplaced') {
        if (window.PaperEditor && window.PaperEditor.deleteUnplaced) {
          window.PaperEditor.deleteUnplaced('figure', fig.blockId);
        }
        return;
      }
      var foundSecId = _findContainingSectionId(fig.blockId);
      if (foundSecId && window.PaperEditor && window.PaperEditor.deleteBlockAt) {
        window.PaperEditor.deleteBlockAt(foundSecId, fig.blockId);
      }
    });
    actionsCol.appendChild(delBtn);

    header.appendChild(actionsCol);
    row.appendChild(header);

    /* If the block resolution failed (e.g., race during render), bail
     * with a graceful message instead of throwing. */
    if (!blk || !attrs || !Y) {
      var note = document.createElement('div');
      note.className = 'pe-equations-empty';
      note.textContent = 'Loading figure block…';
      row.appendChild(note);
      return row;
    }

    /* ── Caption section ── */
    var capSection = _section('Caption');
    var bodyY = blk.get('body');
    if (!(bodyY instanceof Y.Text)) {
      blk.doc.transact(function () { blk.set('body', new Y.Text('')); }, 'init-fig-body');
      bodyY = blk.get('body');
    }
    var capEl = document.createElement('div');
    capEl.className = 'pe-block-content pe-figure-caption pe-fig-caption-editor';
    capEl.dataset.placeholder = 'Figure caption — supports $math$, [@cite], **bold**, etc.';
    window.PaperEditor.bindYTextToContentEditable(bodyY, capEl, {
      readOnly: false,
      renderHtml: window.PaperEditor.renderParagraphHtml,
    });
    if (window.PaperEquations && window.PaperEquations.bindContextMenu) {
      window.PaperEquations.bindContextMenu(capEl);
    }
    capSection.appendChild(capEl);
    row.appendChild(capSection);

    /* ── Sub-panels section ── */
    var subSection = _section('Sub-panels',
      'Add A / B / C labels to reference subfigures inline (e.g. Fig. 3 (A-C)).');
    subSection.appendChild(_buildSubfiguresEditor(fig));
    row.appendChild(subSection);

    /* ── Layout (collapsed) — upload + width/placement/centering/alt. ── */
    var layoutDetails = document.createElement('details');
    layoutDetails.className = 'pe-fig-layout-details';
    var layoutSummary = document.createElement('summary');
    layoutSummary.className = 'pe-fig-section-label pe-fig-layout-summary';
    layoutSummary.textContent = 'Layout & upload';
    layoutDetails.appendChild(layoutSummary);

    var layoutBody = document.createElement('div');
    layoutBody.className = 'pe-fig-layout-body';

    /* Upload control — small button + status text. */
    var uploadRow = document.createElement('div');
    uploadRow.className = 'pe-fig-upload-row';
    var fileInput = document.createElement('input');
    fileInput.type = 'file';
    fileInput.accept = 'image/png,image/jpeg,image/gif,image/webp,image/svg+xml,application/pdf';
    fileInput.style.display = 'none';
    var uploadBtn = document.createElement('button');
    uploadBtn.type = 'button';
    uploadBtn.className = 'pe-fig-upload-btn';
    uploadBtn.textContent = attrs.get('storage_path') ? 'Replace image' : 'Upload image';
    uploadBtn.addEventListener('click', function () { fileInput.click(); });
    var statusEl = document.createElement('span');
    statusEl.className = 'pe-fig-upload-status';
    fileInput.addEventListener('change', async function () {
      var f = fileInput.files && fileInput.files[0];
      fileInput.value = '';
      if (!f) return;
      if (!window.PAPER_FIGURES) {
        statusEl.textContent = 'Upload module not loaded.';
        return;
      }
      var paperId = window.PaperEditor.getPaperId && window.PaperEditor.getPaperId();
      if (!paperId) {
        statusEl.textContent = 'No paper id — cannot upload.';
        return;
      }
      uploadBtn.disabled = true;
      statusEl.textContent = 'Uploading…';
      try {
        var info = await window.PAPER_FIGURES.uploadImage(paperId, f);
        blk.doc.transact(function () {
          attrs.set('storage_path', info.storage_path);
          attrs.set('download_url', info.download_url);
          attrs.set('hash', info.hash);
          attrs.set('mime', info.mime);
          if (!attrs.get('alt')) attrs.set('alt', f.name.replace(/\.[^.]+$/, ''));
        }, 'figure-upload');
        statusEl.textContent = info.already_existed
          ? 'Already in storage — reused.'
          : 'Uploaded ' + (info.size_bytes / 1024).toFixed(0) + ' KB.';
        uploadBtn.textContent = 'Replace image';
      } catch (err) {
        console.warn('[paper-equations] figure upload failed:', err);
        statusEl.textContent = 'Upload failed: ' + (err.message || err);
      } finally {
        uploadBtn.disabled = false;
      }
    });
    uploadRow.appendChild(fileInput);
    uploadRow.appendChild(uploadBtn);
    uploadRow.appendChild(statusEl);
    layoutBody.appendChild(uploadRow);

    /* Layout grid: 4 fields. */
    var layoutGrid = document.createElement('div');
    layoutGrid.className = 'pe-figure-layout-grid pe-fig-layout-grid-v131';

    function field(labelText, control) {
      var f = document.createElement('label');
      f.className = 'pe-figure-field';
      var l = document.createElement('span');
      l.textContent = labelText;
      f.appendChild(l);
      f.appendChild(control);
      return f;
    }

    var widthInput = document.createElement('input');
    widthInput.type = 'text';
    widthInput.value = attrs.get('width') || '\\linewidth';
    widthInput.placeholder = '\\linewidth';
    widthInput.addEventListener('change', function () {
      blk.doc.transact(function () { attrs.set('width', widthInput.value || '\\linewidth'); }, 'fig-width');
    });
    layoutGrid.appendChild(field('Width', widthInput));

    var placeSel = document.createElement('select');
    ['H', 'h', 't', 'b', 'p'].forEach(function (p) {
      var o = document.createElement('option');
      o.value = p;
      o.textContent = p + ({ H: ' — here, exactly', h: ' — here', t: ' — top', b: ' — bottom', p: ' — own page' }[p] || '');
      placeSel.appendChild(o);
    });
    placeSel.value = attrs.get('placement') || 'H';
    placeSel.addEventListener('change', function () {
      blk.doc.transact(function () {
        attrs.set('placement', placeSel.value);
        /* V3.395 — keep the layout intent (anchor/lock) in sync so the
         * Document view + export derive the same float. */
        if (window.PaperLayout && window.PaperLayout.placementToAnchor) {
          var la = window.PaperLayout.placementToAnchor(placeSel.value);
          attrs.set('anchor', la.anchor);
          attrs.set('lock', la.lock);
        }
      }, 'fig-placement');
    });
    layoutGrid.appendChild(field('Placement', placeSel));

    var centerWrap = document.createElement('label');
    centerWrap.className = 'pe-figure-checkbox';
    var centerCb = document.createElement('input');
    centerCb.type = 'checkbox';
    centerCb.checked = attrs.get('centering') !== false;
    centerCb.addEventListener('change', function () {
      blk.doc.transact(function () { attrs.set('centering', !!centerCb.checked); }, 'fig-center');
    });
    var centerLbl = document.createElement('span');
    centerLbl.textContent = '\\centering';
    centerWrap.appendChild(centerCb);
    centerWrap.appendChild(centerLbl);
    layoutGrid.appendChild(field('', centerWrap));

    var altInput = document.createElement('input');
    altInput.type = 'text';
    altInput.value = attrs.get('alt') || '';
    altInput.placeholder = 'Brief description of the image';
    altInput.addEventListener('change', function () {
      blk.doc.transact(function () { attrs.set('alt', altInput.value || ''); }, 'fig-alt');
    });
    layoutGrid.appendChild(field('Alt text', altInput));

    layoutBody.appendChild(layoutGrid);
    layoutDetails.appendChild(layoutBody);
    row.appendChild(layoutDetails);

    return row;
  }

  /* V3.131 — small helper for section labels in the figure row. */
  function _section(label, hint) {
    var sec = document.createElement('div');
    sec.className = 'pe-fig-section';
    var lbl = document.createElement('div');
    lbl.className = 'pe-fig-section-label';
    lbl.textContent = label;
    sec.appendChild(lbl);
    if (hint) {
      var hintEl = document.createElement('div');
      hintEl.className = 'pe-fig-section-hint';
      hintEl.textContent = hint;
      sec.appendChild(hintEl);
    }
    return sec;
  }

  /* V3.127 — full panel-side figure editor body. Mirrors the controls
   * that lived on the doc-side block in V3.102-V3.125 (now retired
   * there in favor of an Edit-in-panel link). Resolves the live
   * yBlock + attrs Y.Map by id; subscribes to attrs changes so remote
   * edits reflect into the panel UI. */
  function _buildFigureEditorBody(rootEl, fig) {
    var blk = _findFigureBlock(fig.blockId);
    if (!blk) {
      rootEl.innerHTML = '<div class="pe-equations-empty">Figure block not found.</div>';
      return;
    }
    var attrs = blk.get('attrs');
    if (!attrs) return;

    /* Upload row. */
    var uploadRow = document.createElement('div');
    uploadRow.className = 'pe-figure-uploadrow';
    var fileInput = document.createElement('input');
    fileInput.type = 'file';
    fileInput.accept = 'image/png,image/jpeg,image/gif,image/webp,image/svg+xml,application/pdf';
    fileInput.style.display = 'none';
    var uploadBtn = document.createElement('button');
    uploadBtn.type = 'button';
    uploadBtn.className = 'pe-figure-upload-btn';
    uploadBtn.textContent = attrs.get('storage_path') ? 'Replace image' : 'Upload image';
    uploadBtn.addEventListener('click', function () { fileInput.click(); });
    var statusEl = document.createElement('span');
    statusEl.className = 'pe-figure-uploadstatus';
    fileInput.addEventListener('change', async function () {
      var f = fileInput.files && fileInput.files[0];
      fileInput.value = '';
      if (!f) return;
      if (!window.PAPER_FIGURES) {
        statusEl.textContent = 'Upload module not loaded.';
        return;
      }
      var paperId = window.PaperEditor.getPaperId && window.PaperEditor.getPaperId();
      if (!paperId) {
        statusEl.textContent = 'No paper id — cannot upload.';
        return;
      }
      uploadBtn.disabled = true;
      statusEl.textContent = 'Uploading…';
      try {
        var info = await window.PAPER_FIGURES.uploadImage(paperId, f);
        blk.doc.transact(function () {
          attrs.set('storage_path', info.storage_path);
          attrs.set('download_url', info.download_url);
          attrs.set('hash', info.hash);
          attrs.set('mime', info.mime);
          if (!attrs.get('alt')) attrs.set('alt', f.name.replace(/\.[^.]+$/, ''));
        }, 'figure-upload');
        statusEl.textContent = info.already_existed
          ? 'Already in storage — reused.'
          : 'Uploaded ' + (info.size_bytes / 1024).toFixed(0) + ' KB.';
        uploadBtn.textContent = 'Replace image';
      } catch (err) {
        console.warn('[paper-equations] figure upload failed:', err);
        statusEl.textContent = 'Upload failed: ' + (err.message || err);
      } finally {
        uploadBtn.disabled = false;
      }
    });
    uploadRow.appendChild(fileInput);
    uploadRow.appendChild(uploadBtn);
    uploadRow.appendChild(statusEl);
    rootEl.appendChild(uploadRow);

    /* Caption Y.Text editor. */
    var capLbl = document.createElement('div');
    capLbl.className = 'pe-figure-caption-label';
    capLbl.textContent = 'Caption';
    rootEl.appendChild(capLbl);
    var capEl = document.createElement('div');
    capEl.className = 'pe-block-content pe-figure-caption';
    capEl.dataset.placeholder = 'Figure caption — supports $math$, [@cite], **bold**, etc.';
    var bodyY = blk.get('body');
    var Y = window.PaperEditor.getY();
    if (!(bodyY instanceof Y.Text)) {
      blk.doc.transact(function () { blk.set('body', new Y.Text('')); }, 'init-fig-body');
      bodyY = blk.get('body');
    }
    window.PaperEditor.bindYTextToContentEditable(bodyY, capEl, {
      readOnly: false,
      renderHtml: window.PaperEditor.renderParagraphHtml,
    });
    if (window.PaperEquations && window.PaperEquations.bindContextMenu) {
      window.PaperEquations.bindContextMenu(capEl);
    }
    rootEl.appendChild(capEl);

    /* Layout details. */
    var layoutGrid = document.createElement('div');
    layoutGrid.className = 'pe-figure-layout-grid';

    function field(labelText, control) {
      var wrap = document.createElement('label');
      wrap.className = 'pe-figure-field';
      var lbl = document.createElement('span');
      lbl.textContent = labelText;
      wrap.appendChild(lbl);
      wrap.appendChild(control);
      return wrap;
    }

    var widthInput = document.createElement('input');
    widthInput.type = 'text';
    widthInput.value = attrs.get('width') || '\\linewidth';
    widthInput.placeholder = '\\linewidth';
    widthInput.addEventListener('change', function () {
      blk.doc.transact(function () { attrs.set('width', widthInput.value || '\\linewidth'); }, 'fig-width');
    });
    layoutGrid.appendChild(field('Width', widthInput));

    var placeSel = document.createElement('select');
    ['H', 'h', 't', 'b', 'p'].forEach(function (p) {
      var o = document.createElement('option');
      o.value = p;
      o.textContent = p + ({ H: ' — here, exactly', h: ' — here', t: ' — top', b: ' — bottom', p: ' — own page' }[p] || '');
      placeSel.appendChild(o);
    });
    placeSel.value = attrs.get('placement') || 'H';
    placeSel.addEventListener('change', function () {
      blk.doc.transact(function () {
        attrs.set('placement', placeSel.value);
        /* V3.395 — keep the layout intent (anchor/lock) in sync so the
         * Document view + export derive the same float. */
        if (window.PaperLayout && window.PaperLayout.placementToAnchor) {
          var la = window.PaperLayout.placementToAnchor(placeSel.value);
          attrs.set('anchor', la.anchor);
          attrs.set('lock', la.lock);
        }
      }, 'fig-placement');
    });
    layoutGrid.appendChild(field('Placement', placeSel));

    var centerWrap = document.createElement('label');
    centerWrap.className = 'pe-figure-checkbox';
    var centerCb = document.createElement('input');
    centerCb.type = 'checkbox';
    centerCb.checked = attrs.get('centering') !== false;
    centerCb.addEventListener('change', function () {
      blk.doc.transact(function () { attrs.set('centering', !!centerCb.checked); }, 'fig-center');
    });
    var centerLbl = document.createElement('span');
    centerLbl.textContent = '\\centering';
    centerWrap.appendChild(centerCb);
    centerWrap.appendChild(centerLbl);
    layoutGrid.appendChild(field('', centerWrap));

    var altInput = document.createElement('input');
    altInput.type = 'text';
    altInput.value = attrs.get('alt') || '';
    altInput.placeholder = 'Brief description of the image';
    altInput.addEventListener('change', function () {
      blk.doc.transact(function () { attrs.set('alt', altInput.value || ''); }, 'fig-alt');
    });
    layoutGrid.appendChild(field('Alt text', altInput));

    rootEl.appendChild(layoutGrid);
  }

  function _buildSubfiguresEditor(fig) {
    var wrap = document.createElement('div');
    wrap.className = 'pe-fig-subfigs';
    var lbl = document.createElement('span');
    lbl.className = 'pe-fig-field-label';
    lbl.textContent = 'Panels:';
    wrap.appendChild(lbl);

    /* F1 — the panel COMPOSER: upload panel images, arrange in a grid
     * with auto letters, and bake ONE composite through the normal
     * figure pipeline (labels sync to these chips). */
    if (window.PAPER_FIG_COMPOSE) {
      var composeBtn = document.createElement('button');
      composeBtn.type = 'button';
      composeBtn.className = 'pe-section-kind pe-tbl-small-btn';
      composeBtn.textContent = '🧩 Compose panels…';
      composeBtn.title = 'Arrange panel images into a grid with auto A/B/C labels and bake one figure image';
      composeBtn.addEventListener('click', function () {
        var blk = _findFigureBlock(fig.blockId);
        if (!blk) { alert('Figure block not found.'); return; }
        window.PAPER_FIG_COMPOSE.open({
          paperId: window.PaperEditor.getPaperId(),
          blockId: fig.blockId,
          attrs: blk.get('attrs'),
          yBlock: blk,
        });
      });
      wrap.appendChild(composeBtn);
    }

    var chips = document.createElement('span');
    chips.className = 'pe-fig-subfig-chips';
    (fig.subfigures || []).forEach(function (sf) {
      var chip = document.createElement('span');
      chip.className = 'pe-fig-subfig-chip';
      chip.textContent = sf.label || '';
      var x = document.createElement('button');
      x.type = 'button';
      x.className = 'pe-fig-subfig-chip-x';
      x.textContent = '×';
      x.title = 'Remove panel ' + (sf.label || '');
      x.addEventListener('click', function () {
        _removeSubfigure(fig.blockId, sf.id);
      });
      chip.appendChild(x);
      chips.appendChild(chip);
    });
    wrap.appendChild(chips);

    var addBtn = document.createElement('button');
    addBtn.type = 'button';
    addBtn.className = 'pe-fig-subfig-add';
    addBtn.textContent = '+ Add panel';
    addBtn.addEventListener('click', function () {
      var nextLabel = _nextPanelLabel(fig.subfigures || []);
      _addSubfigure(fig.blockId, nextLabel);
    });
    wrap.appendChild(addBtn);
    return wrap;
  }

  /* Compute the next panel label (A, B, C, …) skipping any already in use. */
  function _nextPanelLabel(subfigures) {
    var used = (subfigures || []).map(function (s) { return (s.label || '').toUpperCase(); });
    for (var i = 0; i < 26; i++) {
      var ch = String.fromCharCode(65 + i);
      if (used.indexOf(ch) === -1) return ch;
    }
    return '';
  }

  /* ── References tab (V3.122) ─────────────────────────────────────────
   *
   * Three sections + a search input. Reads from PaperEditor's cached
   * citation index (state.citationByKey). The "Linked but not cited"
   * row is computed by filtering the index where entry.linkedDrafts
   * includes the active paperId AND the key isn't in the cited set.
   * The "Cited in this draft" rows come from getCitedKeysInPaper(),
   * which scans paragraph + caption + skeleton + table-caption Y.Texts
   * for [@key] tokens.
   *
   * Library-search rows: any non-cited / non-linked entry that matches
   * the search input by name / author / year / key. Empty search ⇒
   * empty results (we don't dump the full library).
   */
  /* V3.345 — render the bibliography preview rows. Order: the export
   * numbers references by first appearance, which PaperCiteStyle
   * exposes; fall back to the (alphabetical) cited-keys order when the
   * style module isn't loaded. Unresolved keys render as warnings —
   * the same signal the export lint gives, but live. */
  function _refreshBibliographyPreview(citedKeys, byKey) {
    var listEl = document.getElementById('pe-references-bib-list');
    if (!listEl) return;
    if (!citedKeys.length) {
      listEl.innerHTML = '<div class="pe-equations-empty">Nothing cited yet.</div>';
      return;
    }
    var keys = citedKeys.slice();
    var PCS = window.PaperCiteStyle;
    if (PCS && PCS.getNumber) {
      keys.sort(function (a, b) {
        return (PCS.getNumber(a) || 9999) - (PCS.getNumber(b) || 9999);
      });
    }
    listEl.innerHTML = '';
    keys.forEach(function (key, idx) {
      var row = document.createElement('div');
      row.className = 'pe-bib-row';
      var num = document.createElement('span');
      num.className = 'pe-bib-num';
      num.textContent = '[' + (idx + 1) + ']';
      row.appendChild(num);
      var body = document.createElement('span');
      body.className = 'pe-bib-body';
      var e = byKey[key];
      if (!e) {
        row.classList.add('pe-bib-row-unresolved');
        body.textContent = 'unresolved key: ' + key + ' — add it to the lab library before export';
      } else {
        var names = (e.authors && e.authors.length) ? e.authors.join(', ') : (e.firstAuthor || key);
        if (e.authorCount > (e.authors ? e.authors.length : 0)) names += ', et al.';
        var bits = [names];
        if (e.year) bits.push('(' + e.year + ').');
        if (e.title) bits.push(e.title + '.');
        body.textContent = bits.join(' ') + ' ';
        if (e.journal) {
          var jr = document.createElement('em');
          jr.textContent = e.journal;
          body.appendChild(jr);
        }
      }
      row.appendChild(body);
      listEl.appendChild(row);
    });
  }

  function _refreshReferencesSection() {
    var citedListEl = document.getElementById('pe-references-cited-list');
    var linkedListEl = document.getElementById('pe-references-linked-list');
    var searchListEl = document.getElementById('pe-references-search-list');
    if (!citedListEl || !linkedListEl || !searchListEl) return;

    /* Trigger lazy-load on first open (Cmd+K loader is the same path).
     * On load completion, paper-citations-loaded fires and refreshes. */
    var byKey = window.PaperEditor.getCitationByKey && window.PaperEditor.getCitationByKey();
    if (!byKey) {
      try { window.PaperEditor.loadCitationIndex(); } catch (e) {}
      var loading = '<div class="pe-equations-empty">Loading lab library…</div>';
      citedListEl.innerHTML = loading;
      linkedListEl.innerHTML = loading;
      searchListEl.innerHTML = '<div class="pe-equations-empty">Loading lab library…</div>';
      return;
    }

    var paperId = window.PaperEditor.getPaperId && window.PaperEditor.getPaperId();
    var citedKeys = (window.PaperEditor.getCitedKeysInPaper && window.PaperEditor.getCitedKeysInPaper()) || [];
    _refreshBibliographyPreview(citedKeys, byKey);   // V3.345
    /* V3.350 — Evidence Inbox (cached 5 min; render() decides freshness). */
    if (window.PaperEvidenceInbox) {
      window.PaperEvidenceInbox.render(
        document.getElementById('pe-references-evidence-list'),
        { paperId: paperId, insertKey: _insertCitationKeyAtSavedCaret });
    }
    var citedSet = Object.create(null);
    citedKeys.forEach(function (k) { citedSet[k] = true; });
    var citedList = window.PaperEditor.getCitationList ? window.PaperEditor.getCitationList() : [];

    /* Cited section. */
    citedListEl.innerHTML = '';
    if (!citedKeys.length) {
      citedListEl.innerHTML = '<div class="pe-equations-empty">No citations in this draft yet. Use Cmd+K or the + Cite toolbar button to insert one.</div>';
    } else {
      citedKeys.forEach(function (k) {
        var entry = byKey[k];
        if (entry) {
          citedListEl.appendChild(_buildRefRow(entry, 'cited', paperId));
        } else {
          citedListEl.appendChild(_buildRefRowUnknown(k));
        }
      });
    }

    /* Linked-but-not-cited section. */
    linkedListEl.innerHTML = '';
    var linkedRows = citedList.filter(function (e) {
      if (citedSet[e.key]) return false;
      return Array.isArray(e.linkedDrafts) && e.linkedDrafts.indexOf(paperId) >= 0;
    });
    if (!linkedRows.length) {
      linkedListEl.innerHTML = '<div class="pe-equations-empty">No associated-but-uncited papers. Associate papers from the reader\u2019s "Used in paper drafts" pills, the library\u2019s \u2192 badge, or the search below \u2014 they\u2019ll queue here until cited.</div>';
    } else {
      linkedRows.forEach(function (e) {
        linkedListEl.appendChild(_buildRefRow(e, 'linked', paperId));
      });
    }

    /* Library search section. */
    var input = document.querySelector('.pe-ref-search-input');
    var q = ((input && input.value) || '').trim().toLowerCase();
    searchListEl.innerHTML = '';
    if (!q) {
      searchListEl.innerHTML = '<div class="pe-equations-empty">Type to search the whole lab library. "Link to draft" on a result associates it with this draft \u2014 it then appears in the citation picker and gets a pill in the library.</div>';
      return;
    }
    var matches = citedList.filter(function (e) {
      // Exclude rows already in cited / linked so the user doesn't see
      // duplicates; surface those via their dedicated sections instead.
      if (citedSet[e.key]) return false;
      if (Array.isArray(e.linkedDrafts) && e.linkedDrafts.indexOf(paperId) >= 0) return false;
      return e.searchHaystack.indexOf(q) >= 0;
    });
    if (!matches.length) {
      searchListEl.innerHTML = '<div class="pe-equations-empty">No matches.</div>';
      return;
    }
    matches.slice(0, 50).forEach(function (e) {
      searchListEl.appendChild(_buildRefRow(e, 'library', paperId));
    });
    if (matches.length > 50) {
      var more = document.createElement('div');
      more.className = 'pe-equations-empty';
      more.textContent = '… and ' + (matches.length - 50) + ' more. Refine your search.';
      searchListEl.appendChild(more);
    }
  }

  function _buildRefRow(entry, status, paperId) {
    var row = document.createElement('div');
    row.className = 'pe-ref-row';
    row.dataset.itemId = entry.itemId || '';

    var head = document.createElement('div');
    head.className = 'pe-ref-row-head';
    var badge = document.createElement('span');
    badge.className = 'pe-ref-status pe-ref-status-' + status;
    badge.textContent = status;
    head.appendChild(badge);
    /* V3.366 — same amber hollow dot as the association pills: this row
     * is associated with the draft but not cited in it yet. */
    if (status === 'linked') {
      var dot = document.createElement('span');
      dot.className = 'pe-ref-uncited-dot';
      dot.title = 'Associated with this draft but not yet cited';
      head.appendChild(dot);
    }
    var keyEl = document.createElement('span');
    keyEl.className = 'pe-ref-row-key';
    keyEl.textContent = entry.key;
    head.appendChild(keyEl);
    row.appendChild(head);

    var title = document.createElement('a');
    title.className = 'pe-ref-row-title';
    title.textContent = entry.title || '(no title)';
    if (entry.itemId) {
      title.href = '/rm/pages/library-paper.html?id=' + encodeURIComponent(entry.itemId);
      title.target = '_blank';
      title.rel = 'noopener';
    }
    row.appendChild(title);

    var meta = document.createElement('div');
    meta.className = 'pe-ref-row-meta';
    var metaParts = [];
    if (entry.firstAuthor) metaParts.push(entry.firstAuthor);
    if (entry.year) metaParts.push(String(entry.year));
    if (entry.journal) metaParts.push(entry.journal);
    meta.textContent = metaParts.join(' · ') || '(no metadata)';
    /* V3.351 — library richness: PDF availability + tags. */
    if (entry.hasPdf) {
      var pdfIcon = document.createElement('span');
      pdfIcon.className = 'pe-cite-pdf';
      pdfIcon.title = 'PDF in the library';
      pdfIcon.textContent = ' 📄';
      meta.appendChild(pdfIcon);
    }
    (entry.tags || []).forEach(function (t) {
      var chip = document.createElement('span');
      chip.className = 'pe-cite-tag';
      chip.textContent = t;
      meta.appendChild(document.createTextNode(' '));
      meta.appendChild(chip);
    });
    row.appendChild(meta);

    var actions = document.createElement('div');
    actions.className = 'pe-ref-row-actions';

    var insertBtn = document.createElement('button');
    insertBtn.type = 'button';
    insertBtn.className = 'pe-eq-library-insert-btn';
    insertBtn.textContent = 'Insert citation';
    insertBtn.title = 'Insert [@' + entry.key + '] at the last paragraph caret';
    insertBtn.addEventListener('click', function (e) {
      e.preventDefault();
      _insertCitationKeyAtSavedCaret(entry.key);
    });
    actions.appendChild(insertBtn);

    /* V3.351 — lazy abstract preview (memoized fetch from the extras
     * subdoc via PaperEditor.fetchAbstract). */
    if (entry.itemId && window.PaperEditor && window.PaperEditor.fetchAbstract) {
      var absBtn = document.createElement('button');
      absBtn.type = 'button';
      absBtn.className = 'pe-eq-library-insert-btn';
      absBtn.textContent = 'Abstract ▸';
      var absDiv = null;
      absBtn.addEventListener('click', function (e) {
        e.preventDefault();
        if (absDiv) {
          var open = absDiv.style.display !== 'none';
          absDiv.style.display = open ? 'none' : '';
          absBtn.textContent = open ? 'Abstract ▸' : 'Abstract ▾';
          return;
        }
        absDiv = document.createElement('div');
        absDiv.className = 'pe-ref-abstract';
        absDiv.textContent = 'Loading…';
        row.appendChild(absDiv);
        absBtn.textContent = 'Abstract ▾';
        window.PaperEditor.fetchAbstract(entry.itemId).then(function (text) {
          absDiv.textContent = text || 'No abstract stored for this paper.';
        });
      });
      actions.appendChild(absBtn);
    }

    if (paperId && entry.itemId) {
      var isLinked = Array.isArray(entry.linkedDrafts) && entry.linkedDrafts.indexOf(paperId) >= 0;
      var linkBtn = document.createElement('button');
      linkBtn.type = 'button';
      linkBtn.className = 'pe-eq-library-insert-btn';
      linkBtn.textContent = isLinked ? 'Unlink from draft' : 'Link to draft';
      linkBtn.addEventListener('click', function (e) {
        e.preventDefault();
        linkBtn.disabled = true;
        _toggleLinkToDraft(entry.itemId, paperId, !isLinked).finally(function () {
          linkBtn.disabled = false;
        });
      });
      actions.appendChild(linkBtn);
    }

    row.appendChild(actions);
    return row;
  }

  function _buildRefRowUnknown(key) {
    var row = document.createElement('div');
    row.className = 'pe-ref-row pe-ref-row-unknown';

    var head = document.createElement('div');
    head.className = 'pe-ref-row-head';
    /* V3.124 — replace the V3.122 read-only `unknown` badge with a
     * clickable red "Add to library" pill that opens a small stub-create
     * modal pre-filled with the cite key. */
    var addBtn = document.createElement('button');
    addBtn.type = 'button';
    addBtn.className = 'pe-ref-status pe-ref-status-add-to-library';
    addBtn.textContent = '+ Add to library';
    addBtn.title = 'Create a stub library entry for this citation key';
    addBtn.addEventListener('click', function (e) {
      e.preventDefault();
      _openAddToLibraryModal({ key: key });
    });
    head.appendChild(addBtn);
    var keyEl = document.createElement('span');
    keyEl.className = 'pe-ref-row-key';
    keyEl.textContent = key;
    head.appendChild(keyEl);
    row.appendChild(head);

    var meta = document.createElement('div');
    meta.className = 'pe-ref-row-meta';
    meta.textContent = 'No matching library entry. Click "+ Add to library" to create a stub now (you can fill in details later).';
    row.appendChild(meta);

    return row;
  }

  /* V3.124 — modal that creates a stub library entry from an unknown
   * cite key. Title + first author + year + DOI inputs, all optional
   * except title. Save writes a minimal items.json paper with
   * `meta.library.is_library_entry: true` so the citation index picks
   * it up on next reload. */
  function _openAddToLibraryModal(opts) {
    var existing = document.getElementById('pe-add-to-library-modal');
    if (existing) existing.remove();

    var overlay = document.createElement('div');
    overlay.className = 'pe-claim-flag-modal-overlay';
    overlay.id = 'pe-add-to-library-modal';

    var card = document.createElement('div');
    card.className = 'pe-claim-flag-modal-card';

    var head = document.createElement('div');
    head.className = 'pe-claim-flag-modal-head';
    var title = document.createElement('h3');
    title.textContent = 'Add to library';
    var closeBtn = document.createElement('button');
    closeBtn.type = 'button';
    closeBtn.className = 'pe-icon-btn';
    closeBtn.textContent = '×';
    closeBtn.addEventListener('click', function () { overlay.remove(); });
    head.appendChild(title);
    head.appendChild(closeBtn);
    card.appendChild(head);

    var body = document.createElement('div');
    body.className = 'pe-claim-flag-modal-body';

    var hint = document.createElement('p');
    hint.className = 'pe-claim-flag-hint';
    hint.textContent = 'Creates a stub library entry with the cite key below. Refine the entry later in the library page.';
    body.appendChild(hint);

    function field(label, placeholder) {
      var lbl = document.createElement('label');
      lbl.textContent = label;
      body.appendChild(lbl);
      var input = document.createElement('input');
      input.type = 'text';
      input.className = 'pe-claim-flag-statement';
      input.placeholder = placeholder || '';
      body.appendChild(input);
      return input;
    }

    var keyField = field('Citation key', 'e.g. smith2024');
    keyField.value = opts.key || '';
    keyField.readOnly = true;
    keyField.style.opacity = '0.7';

    var titleField = field('Title', 'Paper title');
    var authorField = field('First author (last name)', 'Smith');
    var yearField = field('Year', '2024');
    var doiField = field('DOI (optional)', '10.1000/xyz123');

    /* V3.351 — DOI/title lookup via LIBRARY_METADATA (same Cloud
     * Function path the library page uses). Prefills the fields and
     * stashes the full metadata so _createLibraryStub can build a real
     * entry instead of a bare stub. */
    var lookedUpMeta = null;
    if (window.LIBRARY_METADATA && window.LIBRARY_METADATA.lookup) {
      var lookupBtn = document.createElement('button');
      lookupBtn.type = 'button';
      lookupBtn.className = 'btn btn-sm';
      lookupBtn.textContent = '🔍 Look up metadata';
      lookupBtn.title = 'Fetch title/authors/year/journal from the DOI (or the title)';
      lookupBtn.style.margin = '4px 0 8px';
      lookupBtn.addEventListener('click', async function () {
        var doi = (doiField.value || '').trim();
        var titleQ = (titleField.value || '').trim();
        if (!doi && titleQ.split(/\s+/).length < 4) {
          errEl.textContent = 'Enter a DOI (or at least a 4-word title) to look up.';
          errEl.style.display = '';
          return;
        }
        lookupBtn.disabled = true;
        lookupBtn.textContent = 'Looking up…';
        errEl.style.display = 'none';
        try {
          var meta = await window.LIBRARY_METADATA.lookup(doi ? { doi: doi } : { title: titleQ });
          if (!meta || (!meta.title && !meta.doi)) throw new Error('No match found.');
          lookedUpMeta = meta;
          if (meta.title) titleField.value = meta.title;
          var fam = (meta.authors && meta.authors[0] && (meta.authors[0].family || meta.authors[0].given)) || '';
          if (fam) authorField.value = fam;
          if (meta.year) yearField.value = String(meta.year);
          if (meta.doi) doiField.value = meta.doi;
          hint.textContent = 'Metadata found — Save creates a full library entry (not a stub).';
        } catch (err) {
          lookedUpMeta = null;
          errEl.textContent = 'Lookup failed: ' + (err && err.message || err);
          errEl.style.display = '';
        } finally {
          lookupBtn.disabled = false;
          lookupBtn.textContent = '🔍 Look up metadata';
        }
      });
      body.appendChild(lookupBtn);
    }

    var errEl = document.createElement('div');
    errEl.className = 'pe-claim-flag-err';
    errEl.style.display = 'none';
    body.appendChild(errEl);

    card.appendChild(body);

    var foot = document.createElement('div');
    foot.className = 'pe-claim-flag-modal-foot';
    var cancelBtn = document.createElement('button');
    cancelBtn.type = 'button';
    cancelBtn.className = 'btn';
    cancelBtn.textContent = 'Cancel';
    cancelBtn.addEventListener('click', function () { overlay.remove(); });
    var saveBtn = document.createElement('button');
    saveBtn.type = 'button';
    saveBtn.className = 'btn btn-primary';
    saveBtn.textContent = 'Save';
    saveBtn.addEventListener('click', async function () {
      var titleVal = (titleField.value || '').trim();
      if (!titleVal) {
        errEl.textContent = 'Title is required.';
        errEl.style.display = '';
        titleField.focus();
        return;
      }
      saveBtn.disabled = true;
      cancelBtn.disabled = true;
      errEl.style.display = 'none';
      try {
        await _createLibraryStub({
          key: opts.key,
          title: titleVal,
          firstAuthor: (authorField.value || '').trim(),
          year: (yearField.value || '').trim(),
          doi: (doiField.value || '').trim(),
          lookedUpMeta: lookedUpMeta,   // V3.351
        });
        overlay.remove();
      } catch (err) {
        errEl.textContent = 'Failed to save: ' + (err && err.message || err);
        errEl.style.display = '';
        saveBtn.disabled = false;
        cancelBtn.disabled = false;
      }
    });
    foot.appendChild(cancelBtn);
    foot.appendChild(saveBtn);
    card.appendChild(foot);

    overlay.appendChild(card);
    overlay.addEventListener('click', function (e) {
      if (e.target === overlay) overlay.remove();
    });
    document.addEventListener('keydown', function escH(e) {
      if (e.key === 'Escape' && document.body.contains(overlay)) {
        overlay.remove();
        document.removeEventListener('keydown', escH);
      }
    });

    document.body.appendChild(overlay);
    setTimeout(function () { titleField.focus(); }, 50);
  }

  async function _createLibraryStub(opts) {
    if (typeof api === 'undefined' || !api.load) {
      throw new Error('Adapter not loaded.');
    }
    var data = await api.load('items.json');
    var items = (data && data.items) || [];
    /* V3.351 — when the modal ran a successful metadata lookup, build a
     * REAL library entry via LIBRARY_METADATA.buildPaperItem (authors,
     * journal, ids, extras seeds) and keep the builder-chosen citation
     * key. The abstract goes to the extras subdoc, never inline. */
    if (opts.lookedUpMeta && window.LIBRARY_METADATA && window.LIBRARY_METADATA.buildPaperItem) {
      var user = null;
      try { user = firebase.auth().currentUser; } catch (e) {}
      var fullItem = window.LIBRARY_METADATA.buildPaperItem(opts.lookedUpMeta, null, user);
      fullItem.meta = fullItem.meta || {};
      fullItem.meta.library = fullItem.meta.library || {};
      fullItem.meta.library.citation_key = opts.key;
      fullItem.meta.library.stub_created_from_paper_builder = true;
      items.push(fullItem);
      await api.save('items.json', { items: items });
      if (opts.lookedUpMeta.abstract && window.LIBRARY_EXTRAS && window.LIBRARY_EXTRAS.savePatch) {
        try { await window.LIBRARY_EXTRAS.savePatch(fullItem.id, { abstract: opts.lookedUpMeta.abstract }); }
        catch (e) { console.warn('[paper-equations] abstract save failed:', e.message); }
      }
      if (window.PaperEditor && window.PaperEditor.invalidateCitationIndex) {
        window.PaperEditor.invalidateCitationIndex();
      }
      await window.PaperEditor.loadCitationIndex();
      _refreshReferencesSection();
      return;
    }
    /* Generate an id; collision-resistant prefix + 7 random chars. */
    var newId = 'lib-' + (window.PaperSchemas && window.PaperSchemas.shortId
      ? window.PaperSchemas.shortId('').slice(0, 7)
      : Math.random().toString(36).slice(2, 9));
    var today = new Date().toISOString().slice(0, 10);
    var authors = opts.firstAuthor ? [{ family: opts.firstAuthor }] : [];
    var item = {
      id: newId,
      type: 'paper',
      title: opts.title || '',
      meta: {
        library: {
          is_library_entry: true,
          citation_key: opts.key,
          title: opts.title || '',
          authors: authors,
          year: opts.year || '',
          doi: opts.doi || '',
          date_added: today,
          stub_created_from_paper_builder: true,
        },
      },
    };
    items.push(item);
    await api.save('items.json', { items: items });
    /* Invalidate + reload the citation index so the new entry shows
     * up immediately in the cited / search rows. */
    if (window.PaperEditor && window.PaperEditor.invalidateCitationIndex) {
      window.PaperEditor.invalidateCitationIndex();
    }
    await window.PaperEditor.loadCitationIndex();
    _refreshReferencesSection();
  }

  function _insertCitationKeyAtSavedCaret(key) {
    /* V3.154 — drop the stale savedRange gate; rely on savedEl +
     * savedCaret (or fall back via _saveCaretFromCurrentFocus, which
     * checks PaperEditor's lastFocusedEditable tracker). */
    if (!_state.savedEl || !document.body.contains(_state.savedEl)) {
      _saveCaretFromCurrentFocus();
    }
    if (!_state.savedEl || !document.body.contains(_state.savedEl)) {
      alert('Place the cursor in a paragraph first, then click Insert citation.');
      return;
    }
    _insertAtSavedCaret('[@' + key + ']');
  }

  /* V3.122 — toggle paperId in items.json's
   * meta.library.linked_drafts[] for the given library item. Reuses
   * api.load + api.save (same as the V3.106 reader-side picker). */
  async function _toggleLinkToDraft(itemId, paperId, makeLink) {
    /* V3.352 — routed through LIBRARY_LINKS.toggleDraftLink (atomic
     * single-doc arrayUnion/arrayRemove). The old body here was one of
     * FOUR duplicate whole-items.json read-modify-write implementations
     * — concurrent writers silently lost updates. */
    if (!window.LIBRARY_LINKS) {
      alert('library-links.js not loaded — cannot link to draft.');
      return;
    }
    try {
      await window.LIBRARY_LINKS.toggleDraftLink(itemId, paperId, makeLink);
      /* V3.122 — invalidate the cached citation index so the next
       * _refreshReferencesSection re-reads the new linked_drafts. */
      if (window.PaperEditor && window.PaperEditor.invalidateCitationIndex) {
        window.PaperEditor.invalidateCitationIndex();
      }
      await window.PaperEditor.loadCitationIndex();
      _refreshReferencesSection();
    } catch (e) {
      console.warn('[paper-equations] toggleLinkToDraft failed:', e);
      alert('Failed to update linked_drafts: ' + (e && e.message || e));
    }
  }

  /* ── Tables tab (V3.120, expanded V3.132) ──────────────────────────
   * V3.132 — split into unplaced (panel-authored, not yet placed) and
   * placed-in-doc lists. + Table button creates an unplaced row; the
   * doc-side + Add → Table picker is the placement mechanism. */
  function _refreshTablesSection() {
    _refreshTablesUnplacedList();
    _refreshTablesPlacedList();
  }
  function _refreshTablesUnplacedList() {
    var listEl = document.getElementById('pe-equations-tab-unplaced-list');
    if (!listEl) return;
    var entries = window.PaperEditor.getUnplacedTables
      ? window.PaperEditor.getUnplacedTables()
      : [];
    listEl.innerHTML = '';
    if (!entries.length) {
      var empty = document.createElement('div');
      empty.className = 'pe-equations-empty';
      empty.textContent = 'No unplaced tables. Click "+ Table" above to create one in the panel.';
      listEl.appendChild(empty);
      return;
    }
    entries.forEach(function (t) {
      var fakeTab = {
        blockId: t.blockId,
        label: t.label,
        rows: t.rows,
        cols: t.cols,
        captionPreview: t.caption,
        numbered: t.numbered,
        num: null,
      };
      listEl.appendChild(_buildTableRow(fakeTab, { placement: 'unplaced' }));
    });
  }
  function _refreshTablesPlacedList() {
    var listEl = document.getElementById('pe-equations-tab-list');
    if (!listEl) return;
    var tabs = (window.PaperEditor.getAllTables && window.PaperEditor.getAllTables()) || [];
    listEl.innerHTML = '';
    if (!tabs.length) {
      var empty = document.createElement('div');
      empty.className = 'pe-equations-empty';
      empty.textContent = 'No tables placed in the doc yet. Use + Add → Table in a section to place one.';
      listEl.appendChild(empty);
      return;
    }
    tabs.forEach(function (t) {
      listEl.appendChild(_buildTableRow(t, { placement: 'placed' }));
    });
  }

  function _onClickAddTable() {
    if (!window.PaperEditor || !window.PaperEditor.createUnplacedTable) return;
    var blockId = window.PaperEditor.createUnplacedTable();
    if (!blockId) return;
    setTimeout(function () {
      var listEl = document.getElementById('pe-equations-tab-unplaced-list');
      if (!listEl) return;
      var row = listEl.querySelector('.pe-tab-row[data-block-id="' + _escAttr(blockId) + '"]');
      if (!row) return;
      row.scrollIntoView({ behavior: 'smooth', block: 'center' });
      row.classList.add('pe-block-flash');
      setTimeout(function () { row.classList.remove('pe-block-flash'); }, 1200);
    }, 60);
  }

  function _buildTableRow(tab, opts) {
    opts = opts || {};
    var placement = opts.placement || 'placed';
    var row = document.createElement('div');
    row.className = 'pe-tab-row pe-tab-row-' + placement;
    row.dataset.blockId = tab.blockId;
    row.dataset.placement = placement;

    var head = document.createElement('div');
    head.className = 'pe-tab-row-head';
    if (tab.numbered && tab.num) {
      var badge = document.createElement('span');
      badge.className = 'pe-tab-num-badge';
      badge.textContent = 'Tab. ' + tab.num;
      head.appendChild(badge);
    } else if (placement === 'unplaced') {
      var unBadge = document.createElement('span');
      unBadge.className = 'pe-tab-num-badge pe-tab-num-badge-unplaced';
      unBadge.textContent = 'Unplaced';
      head.appendChild(unBadge);
    }
    var schema = document.createElement('span');
    schema.className = 'pe-tab-schema';
    var schemaParts = [(tab.rows || 0) + ' × ' + (tab.cols || 0)];
    if (tab.booktabs) schemaParts.push('booktabs');
    if (tab.header_row) schemaParts.push('header');
    schema.textContent = schemaParts.join(' · ');
    head.appendChild(schema);
    row.appendChild(head);

    var capPrev = document.createElement('div');
    capPrev.className = 'pe-tab-caption-preview';
    var capText = (tab.captionPreview || '').trim();
    capPrev.textContent = capText || '(no caption yet)';
    if (!capText) capPrev.classList.add('pe-tab-caption-preview-empty');
    row.appendChild(capPrev);

    /* Label input. */
    var labelRow = document.createElement('div');
    labelRow.className = 'pe-fig-label-row';
    var labelLbl = document.createElement('span');
    labelLbl.className = 'pe-fig-field-label';
    labelLbl.textContent = 'Label:';
    var labelInput = document.createElement('input');
    labelInput.type = 'text';
    labelInput.className = 'pe-fig-label-input';
    labelInput.value = tab.label || '';
    labelInput.placeholder = 'tab:cellcounts';
    labelInput.addEventListener('change', function () {
      var v = (labelInput.value || '').trim();
      if (v && !/^tab:/.test(v)) {
        v = 'tab:' + v.replace(/[^a-z0-9_-]+/gi, '-').replace(/^-+|-+$/g, '').toLowerCase();
      }
      labelInput.value = v;
      _updateTableAttrs(tab.blockId, function (attrs) { attrs.set('label', v); });
    });
    labelRow.appendChild(labelLbl);
    labelRow.appendChild(labelInput);
    row.appendChild(labelRow);

    /* Numbered checkbox. */
    var numRow = document.createElement('label');
    numRow.className = 'pe-fig-checkbox-row';
    var numCb = document.createElement('input');
    numCb.type = 'checkbox';
    numCb.checked = tab.numbered !== false;
    numCb.addEventListener('change', function () {
      _updateTableAttrs(tab.blockId, function (attrs) { attrs.set('numbered', !!numCb.checked); });
    });
    var numLbl = document.createElement('span');
    numLbl.textContent = 'Numbered';
    numRow.appendChild(numCb);
    numRow.appendChild(numLbl);
    row.appendChild(numRow);

    /* Actions. V3.132 — placed tables get Insert reference + Scroll +
     * Unplace + Delete; unplaced tables get Place + Delete. */
    var actions = document.createElement('div');
    actions.className = 'pe-fig-row-actions';
    if (placement === 'placed') {
      var insertBtn = document.createElement('button');
      insertBtn.type = 'button';
      insertBtn.className = 'pe-eq-library-insert-btn';
      insertBtn.textContent = 'Insert reference';
      insertBtn.title = 'Insert at the last paragraph caret position';
      insertBtn.addEventListener('click', function (e) {
        e.preventDefault();
        _insertTableReferenceAtSavedCaret(tab);
      });
      var openBtn = document.createElement('button');
      openBtn.type = 'button';
      openBtn.className = 'pe-eq-library-insert-btn';
      openBtn.textContent = 'Scroll to block';
      openBtn.addEventListener('click', function () { _scrollToBlock(tab.blockId); });
      var unplaceBtn = document.createElement('button');
      unplaceBtn.type = 'button';
      unplaceBtn.className = 'pe-eq-library-insert-btn';
      unplaceBtn.textContent = 'Unplace';
      unplaceBtn.title = 'Move this table back to the unplaced library (keep its content).';
      unplaceBtn.addEventListener('click', function () {
        var foundSecId = _findContainingSectionId(tab.blockId);
        if (foundSecId && window.PaperEditor && window.PaperEditor.unplaceBlock) {
          window.PaperEditor.unplaceBlock(foundSecId, tab.blockId);
        }
      });
      actions.appendChild(insertBtn);
      actions.appendChild(openBtn);
      actions.appendChild(unplaceBtn);
    } else {
      var placeBtn = document.createElement('button');
      placeBtn.type = 'button';
      placeBtn.className = 'pe-eq-library-insert-btn pe-fig-action-primary';
      placeBtn.textContent = 'Place in section…';
      placeBtn.addEventListener('click', function (e) {
        e.preventDefault();
        _openPlaceUnplacedPicker('table', tab.blockId, placeBtn);
      });
      actions.appendChild(placeBtn);
    }
    var delBtn = document.createElement('button');
    delBtn.type = 'button';
    delBtn.className = 'pe-eq-library-insert-btn pe-fig-action-danger';
    delBtn.textContent = 'Delete';
    delBtn.addEventListener('click', function () {
      var msg = (placement === 'unplaced')
        ? 'Delete this table from the panel library?'
        : 'Delete this table? The block will be removed from the document.';
      if (!confirm(msg)) return;
      if (placement === 'unplaced') {
        if (window.PaperEditor && window.PaperEditor.deleteUnplaced) {
          window.PaperEditor.deleteUnplaced('table', tab.blockId);
        }
        return;
      }
      var foundSecId = _findContainingSectionId(tab.blockId);
      if (foundSecId && window.PaperEditor && window.PaperEditor.deleteBlockAt) {
        window.PaperEditor.deleteBlockAt(foundSecId, tab.blockId);
      }
    });
    actions.appendChild(delBtn);
    row.appendChild(actions);

    /* V3.127 — full editor body in a <details>. Default open. */
    var editorDetails = document.createElement('details');
    editorDetails.className = 'pe-tab-editor';
    editorDetails.open = true;
    var editorSummary = document.createElement('summary');
    editorSummary.className = 'pe-tab-editor-summary';
    editorSummary.textContent = 'Editor';
    editorDetails.appendChild(editorSummary);
    var editorBody = document.createElement('div');
    editorBody.className = 'pe-tab-editor-body';
    _buildTableEditorBody(editorBody, tab);
    editorDetails.appendChild(editorBody);
    row.appendChild(editorDetails);

    return row;
  }

  /* V3.127 — full panel-side table editor body. Mirrors the doc-side
   * table block's V3.120 inline editor (now retired there in favor of
   * read-only preview). Includes the styling toolbar (booktabs /
   * header_row / per-column align), +Row / +Col buttons, the grid
   * itself (per-cell Y.Text contenteditables), and the caption Y.Text
   * editor. */
  function _buildTableEditorBody(rootEl, tab) {
    var blk = _findTableBlock(tab.blockId);
    if (!blk) {
      rootEl.innerHTML = '<div class="pe-equations-empty">Table block not found.</div>';
      return;
    }
    var Y = window.PaperEditor.getY();
    var attrs = blk.get('attrs');
    if (!attrs) return;

    /* Styling toolbar. */
    var styleBar = document.createElement('div');
    styleBar.className = 'pe-table-stylebar';
    function checkboxField(label, attrKey, defaultTrue) {
      var w = document.createElement('label');
      w.className = 'pe-table-style-cb';
      var cb = document.createElement('input');
      cb.type = 'checkbox';
      cb.checked = defaultTrue ? attrs.get(attrKey) !== false : !!attrs.get(attrKey);
      cb.addEventListener('change', function () {
        blk.doc.transact(function () { attrs.set(attrKey, !!cb.checked); }, 'tab-' + attrKey);
      });
      w.appendChild(cb);
      var sp = document.createElement('span');
      sp.textContent = label;
      w.appendChild(sp);
      return w;
    }
    styleBar.appendChild(checkboxField('booktabs', 'booktabs', true));
    styleBar.appendChild(checkboxField('header row', 'header_row', true));
    /* Tables II — multi-page table (\begin{longtable}: caption inside,
     * header repeats per page; NOT a float, so anchor/span/lock don't
     * apply; invalid in two-column classes — the export degrades it
     * there with a warning). */
    var ltField = checkboxField('multi-page (longtable)', 'longtable', false);
    ltField.title = 'Long tables break across pages with the header repeated. Not available in two-column journals (IEEE, PNAS) — those compile it as a regular table with a warning.';
    styleBar.appendChild(ltField);

    /* +Row / +Col buttons. */
    var addRowBtn = document.createElement('button');
    addRowBtn.type = 'button';
    addRowBtn.className = 'pe-section-kind pe-tbl-small-btn';
    addRowBtn.textContent = '+ Row';
    addRowBtn.addEventListener('click', function () {
      blk.doc.transact(function () {
        var r = (attrs.get('rows') || 0);
        var cells = attrs.get('cells');
        var cols = attrs.get('cols') || 0;
        for (var c = 0; c < cols; c++) cells.set(r + '-' + c, new Y.Text(''));
        attrs.set('rows', r + 1);
      }, 'table-add-row');
    });
    styleBar.appendChild(addRowBtn);

    var addColBtn = document.createElement('button');
    addColBtn.type = 'button';
    addColBtn.className = 'pe-section-kind pe-tbl-small-btn';
    addColBtn.textContent = '+ Col';
    addColBtn.addEventListener('click', function () {
      blk.doc.transact(function () {
        var c = (attrs.get('cols') || 0);
        var cells = attrs.get('cells');
        var rows = attrs.get('rows') || 0;
        for (var r = 0; r < rows; r++) cells.set(r + '-' + c, new Y.Text(''));
        attrs.set('cols', c + 1);
      }, 'table-add-col');
    });
    styleBar.appendChild(addColBtn);

    /* Tables II — merge / unmerge over the click(+shift-click) cell
     * selection. Merges live in the SCALAR attr `merges_json` (survives
     * every move path); covered cells keep their Y.Texts so unmerge
     * restores content. */
    function readMerges() {
      return (window.PaperLayout && window.PaperLayout.parseTableMerges)
        ? window.PaperLayout.parseTableMerges(attrs.get('merges_json'))
        : {};
    }
    function writeMerges(m) {
      var keys = Object.keys(m);
      blk.doc.transact(function () {
        if (keys.length) attrs.set('merges_json', JSON.stringify(m));
        else attrs.delete('merges_json');
      }, 'tab-merges');
    }
    var mergeBtn = document.createElement('button');
    mergeBtn.type = 'button';
    mergeBtn.className = 'pe-section-kind pe-tbl-small-btn';
    mergeBtn.textContent = '⧉ Merge';
    mergeBtn.title = 'Merge the selected cells (click a cell, shift-click another to select a block)';
    mergeBtn.addEventListener('click', function () {
      var sel = _tblSel && _tblSel.blockId === tab.blockId ? _tblSel : null;
      if (!sel) { alert('Select cells first: click a cell, then shift-click another corner.'); return; }
      var r0 = Math.min(sel.r0, sel.r1), r1 = Math.max(sel.r0, sel.r1);
      var c0 = Math.min(sel.c0, sel.c1), c1 = Math.max(sel.c0, sel.c1);
      var rs = r1 - r0 + 1, cs = c1 - c0 + 1;
      if (rs === 1 && cs === 1) { alert('Select more than one cell to merge.'); return; }
      var merges = readMerges();
      var cover = window.PaperLayout.tableCoverMap(merges, attrs.get('rows') || 0, attrs.get('cols') || 0);
      for (var r = r0; r <= r1; r++) {
        for (var c = c0; c <= c1; c++) {
          var k = r + '-' + c;
          if (cover.anchors[k] || cover.skip[k] || cover.cont[k] != null) {
            alert('The selection overlaps an existing merge — unmerge it first.');
            return;
          }
        }
      }
      merges[r0 + '-' + c0] = { rs: rs, cs: cs };
      _tblSel = null;
      writeMerges(merges);
    });
    styleBar.appendChild(mergeBtn);

    var unmergeBtn = document.createElement('button');
    unmergeBtn.type = 'button';
    unmergeBtn.className = 'pe-section-kind pe-tbl-small-btn';
    unmergeBtn.textContent = '⧉ Unmerge';
    unmergeBtn.title = 'Split the merged cell under the selection back into its cells';
    unmergeBtn.addEventListener('click', function () {
      var sel = _tblSel && _tblSel.blockId === tab.blockId ? _tblSel : null;
      if (!sel) { alert('Click a merged cell first.'); return; }
      var merges = readMerges();
      var cover = window.PaperLayout.tableCoverMap(merges, attrs.get('rows') || 0, attrs.get('cols') || 0);
      var hit = null;
      Object.keys(cover.anchors).forEach(function (k) {
        var parts = k.split('-');
        var ar = +parts[0], ac = +parts[1];
        var a = cover.anchors[k];
        if (sel.r0 >= ar && sel.r0 < ar + a.rs && sel.c0 >= ac && sel.c0 < ac + a.cs) hit = k;
      });
      if (!hit) { alert('The selected cell is not part of a merge.'); return; }
      delete merges[hit];
      _tblSel = null;
      writeMerges(merges);
    });
    styleBar.appendChild(unmergeBtn);
    rootEl.appendChild(styleBar);

    /* Per-column alignment. */
    var alignWrap = document.createElement('div');
    alignWrap.className = 'pe-table-align-wrap';
    var alignLbl = document.createElement('span');
    alignLbl.className = 'pe-table-style-label';
    alignLbl.textContent = 'columns:';
    alignWrap.appendChild(alignLbl);
    var cols = attrs.get('cols') || 0;
    var alignStr = (attrs.get('align') || '').slice(0, cols);
    while (alignStr.length < cols) alignStr += 'l';
    var widths = (window.PaperLayout && window.PaperLayout.parseTableWidths)
      ? window.PaperLayout.parseTableWidths(attrs.get('widths_json'), cols)
      : null;
    function writeWidth(col, w) {
      var arr = (window.PaperLayout && window.PaperLayout.parseTableWidths)
        ? window.PaperLayout.parseTableWidths(attrs.get('widths_json'), attrs.get('cols') || 0)
        : [];
      arr[col] = w;
      var any = arr.some(function (x) { return x && x.mode !== 'auto'; });
      blk.doc.transact(function () {
        if (any) attrs.set('widths_json', JSON.stringify(arr));
        else attrs.delete('widths_json');
      }, 'tab-widths');
    }
    for (var c = 0; c < cols; c++) {
      var col = c;
      var grp = document.createElement('span');
      grp.className = 'pe-table-align-col';
      ['l', 'c', 'r'].forEach(function (a) {
        var btn = document.createElement('button');
        btn.type = 'button';
        btn.className = 'pe-table-align-btn';
        btn.textContent = a.toUpperCase();
        if (alignStr[col] === a) btn.classList.add('active');
        btn.addEventListener('click', function () {
          var current = (attrs.get('align') || '').slice(0, attrs.get('cols') || 0);
          while (current.length < (attrs.get('cols') || 0)) current += 'l';
          var newStr = current.slice(0, col) + a + current.slice(col + 1);
          blk.doc.transact(function () { attrs.set('align', newStr); }, 'tab-align');
        });
        grp.appendChild(btn);
      });
      /* Column width — fixed p{} columns wrap text in the PDF. */
      (function (colIdx) {
        var wSel = document.createElement('select');
        wSel.className = 'pe-table-width-sel';
        wSel.title = 'Column width (auto = size to content; % of line width, or fixed mm)';
        var cur = (widths && widths[colIdx]) || { mode: 'auto' };
        var options = [
          { v: 'auto', label: 'auto' },
          { v: 'frac:0.15', label: '15%' }, { v: 'frac:0.2', label: '20%' },
          { v: 'frac:0.25', label: '25%' }, { v: 'frac:0.33', label: '33%' },
          { v: 'frac:0.4', label: '40%' }, { v: 'frac:0.5', label: '50%' },
          { v: 'mm', label: 'mm…' },
        ];
        var curVal = cur.mode === 'auto' ? 'auto'
          : cur.mode === 'frac' ? ('frac:' + cur.v) : 'mm';
        options.forEach(function (o) {
          var opt = document.createElement('option');
          opt.value = o.v;
          opt.textContent = o.v === 'mm' && cur.mode === 'mm' ? cur.v + 'mm' : o.label;
          if (o.v === curVal) opt.selected = true;
          wSel.appendChild(opt);
        });
        if (curVal.indexOf('frac:') === 0 && !options.some(function (o) { return o.v === curVal; })) {
          var extra = document.createElement('option');
          extra.value = curVal; extra.textContent = Math.round(cur.v * 100) + '%'; extra.selected = true;
          wSel.appendChild(extra);
        }
        wSel.addEventListener('change', function () {
          var v = wSel.value;
          if (v === 'auto') { writeWidth(colIdx, { mode: 'auto' }); return; }
          if (v === 'mm') {
            var mm = parseFloat(window.prompt('Column width in mm:', '30'));
            if (!(mm > 0)) { wSel.value = curVal; return; }
            writeWidth(colIdx, { mode: 'mm', v: mm });
            return;
          }
          writeWidth(colIdx, { mode: 'frac', v: parseFloat(v.split(':')[1]) });
        });
        grp.appendChild(wSel);
      })(col);
      alignWrap.appendChild(grp);
    }
    rootEl.appendChild(alignWrap);

    /* Grid editor — merge-aware: covered cells are not rendered (their
     * Y.Texts persist for unmerge); anchors carry row/colSpan. Click a
     * cell to select (outline), shift-click to extend the selection. */
    var hasCells = attrs.get('cells') instanceof Y.Map;
    if (hasCells) {
      var grid = document.createElement('div');
      grid.className = 'pe-table-body';
      var rowsN = attrs.get('rows') || 0;
      var colsN = attrs.get('cols') || 0;
      var cells = attrs.get('cells');
      var gMerges = readMerges();
      var gCover = (window.PaperLayout && window.PaperLayout.tableCoverMap)
        ? window.PaperLayout.tableCoverMap(gMerges, rowsN, colsN)
        : { anchors: {}, skip: {}, cont: {} };
      var table = document.createElement('table');
      table.className = 'pe-grid-table';
      function paintSelection() {
        var sel = _tblSel && _tblSel.blockId === tab.blockId ? _tblSel : null;
        table.querySelectorAll('td.pe-cell-selected').forEach(function (t) {
          t.classList.remove('pe-cell-selected');
        });
        if (!sel) return;
        var r0 = Math.min(sel.r0, sel.r1), r1 = Math.max(sel.r0, sel.r1);
        var c0 = Math.min(sel.c0, sel.c1), c1 = Math.max(sel.c0, sel.c1);
        table.querySelectorAll('td[data-r]').forEach(function (t) {
          var tr2 = +t.dataset.r, tc = +t.dataset.c;
          if (tr2 >= r0 && tr2 <= r1 && tc >= c0 && tc <= c1) t.classList.add('pe-cell-selected');
        });
      }
      for (var r = 0; r < rowsN; r++) {
        var tr = document.createElement('tr');
        for (var c2 = 0; c2 < colsN; c2++) {
          var key = r + '-' + c2;
          if (gCover.skip[key] || gCover.cont[key] != null) continue;   // merged away
          var td = document.createElement('td');
          td.dataset.r = String(r);
          td.dataset.c = String(c2);
          var anch = gCover.anchors[key];
          if (anch) {
            if (anch.cs > 1) td.colSpan = anch.cs;
            if (anch.rs > 1) td.rowSpan = anch.rs;
            td.classList.add('pe-cell-merged');
          }
          (function (rr, cc) {
            td.addEventListener('mousedown', function (ev) {
              if (ev.shiftKey && _tblSel && _tblSel.blockId === tab.blockId) {
                ev.preventDefault();   // keep the anchor cell's focus
                _tblSel.r1 = rr; _tblSel.c1 = cc;
              } else {
                _tblSel = { blockId: tab.blockId, r0: rr, c0: cc, r1: rr, c1: cc };
              }
              paintSelection();
            });
          })(r, c2);
          var cellY = cells.get(key);
          if (!(cellY instanceof Y.Text)) {
            cellY = new Y.Text('');
            blk.doc.transact(function () { cells.set(key, cellY); }, 'init-cell');
          }
          var cellEl = document.createElement('div');
          cellEl.className = 'pe-grid-cell';
          window.PaperEditor.bindYTextToContentEditable(cellY, cellEl, {
            readOnly: false,
            renderHtml: window.PaperEditor.renderParagraphHtml,
          });
          td.appendChild(cellEl);
          tr.appendChild(td);
        }
        table.appendChild(tr);
      }
      grid.appendChild(table);
      rootEl.appendChild(grid);
      paintSelection();
    }

    /* Caption editor. */
    var capLbl = document.createElement('div');
    capLbl.className = 'pe-table-caption-label';
    capLbl.textContent = 'Caption';
    rootEl.appendChild(capLbl);
    var captionY = attrs.get('caption');
    if (!(captionY instanceof Y.Text)) {
      blk.doc.transact(function () { attrs.set('caption', new Y.Text('')); }, 'init-table-caption');
      captionY = attrs.get('caption');
    }
    var capEl = document.createElement('div');
    capEl.className = 'pe-block-content pe-table-caption';
    capEl.dataset.placeholder = 'Table caption — supports $math$, [@cite], **bold**, etc.';
    window.PaperEditor.bindYTextToContentEditable(captionY, capEl, {
      readOnly: false,
      renderHtml: window.PaperEditor.renderParagraphHtml,
    });
    if (window.PaperEquations && window.PaperEquations.bindContextMenu) {
      window.PaperEquations.bindContextMenu(capEl);
    }
    rootEl.appendChild(capEl);

    /* Tables II — table notes (one per line; scalar attr). Regular
     * tables wrap in threeparttable + \begin{tablenotes}; longtables
     * emit them as full-width footnotesize rows. */
    var notesLbl = document.createElement('div');
    notesLbl.className = 'pe-table-caption-label';
    notesLbl.textContent = 'Notes (one per line — footnotes under the table)';
    rootEl.appendChild(notesLbl);
    var notesEl = document.createElement('textarea');
    notesEl.className = 'pe-table-notes';
    notesEl.rows = 2;
    notesEl.placeholder = 'e.g.  Values are mean ± SD (n = 3).';
    notesEl.value = String(attrs.get('notes') || '');
    notesEl.addEventListener('change', function () {
      var v = notesEl.value.replace(/\s+$/, '');
      blk.doc.transact(function () {
        if (v.trim()) attrs.set('notes', v); else attrs.delete('notes');
      }, 'tab-notes');
    });
    rootEl.appendChild(notesEl);
  }

  /* ── E4 — equation importers ─────────────────────────────────────
   * ⇪ Import modal: (a) paste a LaTeX block — split on blank lines into
   * entries with per-row names + KaTeX previews; (b) paste MathML from
   * Word/MathType/Google Docs into a <math-field>, which parses it
   * natively → getValue('latex'). */
  function _openEquationImportModal() {
    var old = document.getElementById('pe-eqimport-overlay');
    if (old) old.remove();
    var overlay = document.createElement('div');
    overlay.className = 'pe-eqviz-overlay';
    overlay.id = 'pe-eqimport-overlay';
    var card = document.createElement('div');
    card.className = 'pe-eqviz-card';
    overlay.appendChild(card);
    var head = document.createElement('div');
    head.className = 'pe-eqviz-head';
    head.textContent = 'Import equations';
    card.appendChild(head);

    var tabs = document.createElement('div');
    tabs.className = 'pe-visual-toggle';
    var tabLatex = document.createElement('button');
    tabLatex.type = 'button'; tabLatex.textContent = 'Paste LaTeX'; tabLatex.className = 'active';
    var tabMathml = document.createElement('button');
    tabMathml.type = 'button'; tabMathml.textContent = 'Paste from Word (MathML)';
    tabs.appendChild(tabLatex);
    tabs.appendChild(tabMathml);
    card.appendChild(tabs);

    var latexPane = document.createElement('div');
    var ta = document.createElement('textarea');
    ta.className = 'pe-eqimport-ta';
    ta.rows = 6;
    ta.placeholder = 'Paste LaTeX — one equation per blank-line-separated block:\n\n\\sigma = F/A\n\nE^* = \\left(\\frac{1-\\nu_1^2}{E_1}+\\frac{1-\\nu_2^2}{E_2}\\right)^{-1}';
    latexPane.appendChild(ta);
    var splitBtn = document.createElement('button');
    splitBtn.type = 'button'; splitBtn.className = 'btn btn-sm';
    splitBtn.textContent = 'Preview entries';
    latexPane.appendChild(splitBtn);
    var rowsHost = document.createElement('div');
    rowsHost.className = 'pe-eqimport-rows';
    latexPane.appendChild(rowsHost);
    card.appendChild(latexPane);

    var mathmlPane = document.createElement('div');
    mathmlPane.style.display = 'none';
    var mmHint = document.createElement('div');
    mmHint.className = 'pe-eqimport-hint';
    mmHint.textContent = 'Paste an equation copied from Word (MathML on the clipboard — works from MathType, Google Docs, and Word with "MathML for clipboard" on; plain Word copies may arrive as pictures, which cannot convert). Then name it and add.';
    mathmlPane.appendChild(mmHint);
    var mmHost = document.createElement('div');
    mathmlPane.appendChild(mmHost);
    var mmName = document.createElement('input');
    mmName.type = 'text'; mmName.className = 'eqcap-name'; mmName.placeholder = 'Name';
    mathmlPane.appendChild(mmName);
    card.appendChild(mathmlPane);

    tabLatex.addEventListener('click', function () {
      tabLatex.classList.add('active'); tabMathml.classList.remove('active');
      latexPane.style.display = ''; mathmlPane.style.display = 'none';
    });
    tabMathml.addEventListener('click', function () {
      tabMathml.classList.add('active'); tabLatex.classList.remove('active');
      latexPane.style.display = 'none'; mathmlPane.style.display = '';
      if (!mmHost.querySelector('math-field') && window.ensureMathlive) {
        window.ensureMathlive().then(function () {
          var mf = document.createElement('math-field');
          mf.className = 'pe-mathfield';
          mmHost.appendChild(mf);
          try { mf.focus(); } catch (e) {}
        }).catch(function (e) { mmHost.textContent = 'MathLive failed to load: ' + (e.message || e); });
      }
    });

    var pending = [];   // [{latex, nameInput}]
    splitBtn.addEventListener('click', function () {
      rowsHost.innerHTML = '';
      pending = [];
      var blocks = String(ta.value || '').split(/\n\s*\n/)
        .map(function (s) { return s.trim(); }).filter(Boolean);
      if (!blocks.length) { rowsHost.textContent = 'Nothing to import.'; return; }
      blocks.forEach(function (latex, i) {
        var row = document.createElement('div');
        row.className = 'pe-eqimport-row';
        var prev = document.createElement('div');
        prev.className = 'pe-eqimport-prev';
        prev.innerHTML = window.PaperEditor.renderEquationHtml(latex, true) || _escHtml(latex);
        row.appendChild(prev);
        var nameIn = document.createElement('input');
        nameIn.type = 'text';
        nameIn.placeholder = 'Name (entry ' + (i + 1) + ')';
        row.appendChild(nameIn);
        rowsHost.appendChild(row);
        pending.push({ latex: latex, nameInput: nameIn });
      });
    });

    var actions = document.createElement('div');
    actions.className = 'pe-eqviz-actions';
    var cancel = document.createElement('button');
    cancel.type = 'button'; cancel.className = 'btn btn-sm'; cancel.textContent = 'Close';
    var add = document.createElement('button');
    add.type = 'button'; add.className = 'btn btn-sm btn-primary'; add.textContent = 'Add to library';
    actions.appendChild(cancel);
    actions.appendChild(add);
    card.appendChild(actions);

    function close() { overlay.remove(); }
    cancel.addEventListener('click', close);
    overlay.addEventListener('mousedown', function (ev) { if (ev.target === overlay) close(); });
    add.addEventListener('click', function () {
      var made = 0;
      if (tabMathml.classList.contains('active')) {
        var mf = mmHost.querySelector('math-field');
        var latex = mf && (mf.getValue ? mf.getValue('latex') : mf.value);
        if (latex && latex.trim()) {
          _createEquationLibraryEntry({ name: mmName.value.trim(), latex: latex.trim(), type: 'main' });
          made = 1;
        }
      } else {
        pending.forEach(function (p) {
          if (!p.latex) return;
          _createEquationLibraryEntry({ name: p.nameInput.value.trim(), latex: p.latex, type: 'main' });
          made++;
        });
      }
      if (!made) { alert('Nothing to add — paste and preview first.'); return; }
      close();
      _refreshPanel();
    });

    document.body.appendChild(overlay);
  }
  function _escHtml(s) {
    return String(s || '').replace(/[&<>]/g, function (c) {
      return { '&': '&amp;', '<': '&lt;', '>': '&gt;' }[c];
    });
  }

  /* ── E4 — "From reading library": browse equation CAPTURES made in
   * the paper reader (papers/{itemId}/annotations, kind==='equation')
   * and insert one as a display-equation block. Items linked to THIS
   * draft sort first. Queries mirror annotation-sync's visibility model
   * (lab + own-private; equality-only → no composite index). */
  function _openCaptureBrowser(sectionId, idx) {
    var old = document.getElementById('pe-eqcapbrowse-overlay');
    if (old) old.remove();
    var overlay = document.createElement('div');
    overlay.className = 'pe-eqviz-overlay';
    overlay.id = 'pe-eqcapbrowse-overlay';
    var card = document.createElement('div');
    card.className = 'pe-eqviz-card';
    overlay.appendChild(card);
    var head = document.createElement('div');
    head.className = 'pe-eqviz-head';
    head.textContent = 'Insert a captured equation from your reading library';
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

    var draftId = window.PaperEditor.getPaperId();
    function renderItems() {
      var q = (search.value || '').trim().toLowerCase();
      var items = (window.PaperEditor.getCitationList() || []).slice();
      items.sort(function (a, b) {
        var al = (a.linkedDrafts || []).indexOf(draftId) >= 0 ? 0 : 1;
        var bl = (b.linkedDrafts || []).indexOf(draftId) >= 0 ? 0 : 1;
        return al - bl || a.key.localeCompare(b.key);
      });
      if (q) items = items.filter(function (it) { return it.searchHaystack.indexOf(q) >= 0; });
      listHost.innerHTML = '';
      if (!items.length) { listHost.textContent = 'No library papers found.'; return; }
      items.slice(0, 40).forEach(function (it) {
        var row = document.createElement('button');
        row.type = 'button';
        row.className = 'pe-doc-picker-row';
        row.innerHTML = '<span class="pe-doc-picker-row-title">' + _escHtml(it.shortLabel) +
          ((it.linkedDrafts || []).indexOf(draftId) >= 0 ? ' <span class="pe-eqcap-linked">linked</span>' : '') +
          '</span><span class="pe-doc-picker-row-subtitle">' + _escHtml((it.title || '').slice(0, 80)) + '</span>';
        row.addEventListener('click', function () { showCaptures(it); });
        listHost.appendChild(row);
      });
    }
    search.addEventListener('input', renderItems);
    renderItems();

    function showCaptures(item) {
      head.textContent = 'Captured equations — ' + item.shortLabel;
      search.style.display = 'none';
      listHost.innerHTML = 'Loading…';
      var db = firebase.firestore();
      var col = db.collection('papers').doc(item.itemId).collection('annotations');
      var me = firebase.auth().currentUser;
      var qs = [col.where('kind', '==', 'equation').where('visibility', '==', 'lab').get()];
      if (me) {
        qs.push(col.where('kind', '==', 'equation')
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
          listHost.innerHTML = '<div class="pe-eqimport-hint">No equation captures on this paper yet — capture one in the reader (select the equation → ƒ).</div>';
          return;
        }
        caps.forEach(function (cap) {
          var row = document.createElement('div');
          row.className = 'pe-eqcap-browse-row';
          var prev = document.createElement('div');
          prev.className = 'pe-eqimport-prev';
          prev.innerHTML = window.PaperEditor.renderEquationHtml(cap.latex || '', true) || _escHtml(cap.latex || '');
          if (cap.snip_data_uri) prev.title = 'Captured from the paper';
          row.appendChild(prev);
          var meta = document.createElement('div');
          meta.className = 'pe-eqcap-browse-meta';
          meta.textContent = (cap.name || '(unnamed)') + '  ·  source [@' + item.key + ']';
          row.appendChild(meta);
          var opts = document.createElement('label');
          opts.className = 'pe-eqcap-browse-copy';
          var copyCb = document.createElement('input');
          copyCb.type = 'checkbox'; copyCb.checked = true;
          opts.appendChild(copyCb);
          opts.appendChild(document.createTextNode(' also add to this paper’s equation library'));
          row.appendChild(opts);
          var insBtn = document.createElement('button');
          insBtn.type = 'button'; insBtn.className = 'btn btn-sm btn-primary';
          insBtn.textContent = 'Insert as block';
          insBtn.addEventListener('click', function () {
            window.PaperEditor.insertBlockAt(sectionId, idx, 'equation', {
              body: cap.latex || '', display: true,
            });
            if (copyCb.checked) {
              _createEquationLibraryEntry({ name: cap.name || '', latex: cap.latex || '', type: 'main' });
            }
            close();
            _refreshPanel();
          });
          row.appendChild(insBtn);
          listHost.appendChild(row);
        });
      }).catch(function (e) {
        listHost.textContent = 'Could not load captures: ' + (e.message || e);
      });
    }
  }

  function _findTableBlock(blockId) {
    var paperMap = window.PaperEditor.getPaperMap();
    if (!paperMap) return null;
    var sections = paperMap.get('sections');
    var hit = null;
    if (sections && typeof sections.forEach === 'function') {
      sections.forEach(function (secMap) {
        if (hit) return;
        var children = secMap && secMap.get && secMap.get('children');
        if (!children || typeof children.forEach !== 'function') return;
        children.forEach(function (blk) {
          if (hit) return;
          if (!blk || typeof blk.get !== 'function') return;
          if (blk.get('kind') !== 'table') return;
          if (blk.get('id') === blockId) hit = blk;
        });
      });
    }
    if (hit) return hit;
    /* V3.132 — also search the unplaced library so panel-side editors work
     * before the table is placed in the doc. */
    var unplaced = paperMap.get('table_unplaced');
    if (unplaced && typeof unplaced.forEach === 'function') {
      unplaced.forEach(function (blk) {
        if (hit) return;
        if (blk && typeof blk.get === 'function' && blk.get('id') === blockId) hit = blk;
      });
    }
    return hit;
  }

  function _updateTableAttrs(blockId, mutator) {
    var blk = _findTableBlock(blockId);
    if (!blk) return;
    var attrs = blk.get('attrs');
    if (!attrs) return;
    blk.doc.transact(function () { mutator(attrs); }, 'tab-row-update');
  }

  function _insertTableReferenceAtSavedCaret(tab) {
    /* V3.154 — drop stale savedRange gate; rely on savedEl/savedCaret
     * with PaperEditor.lastFocusedEditable fallback. */
    if (!_state.savedEl || !document.body.contains(_state.savedEl)) {
      _saveCaretFromCurrentFocus();
    }
    if (!_state.savedEl || !document.body.contains(_state.savedEl)) {
      alert('Place the cursor in a paragraph first, then click Insert reference.');
      return;
    }
    if (!tab.label) {
      /* V3.346 — auto-assign instead of dead-ending. */
      tab.label = _autoAssignFloatLabel(tab.blockId, 'tab:');
      if (!tab.label) return;
    }
    _insertAtSavedCaret('[!tab:' + tab.label + ']');
  }

  /* V3.346 — auto-assign a cross-reference label to a numbered float
   * that doesn't have one yet, so ref pickers never dead-end on an
   * alert. Slug from the caption's first words, else the block id.
   * Returns the assigned label (or null when the block isn't found). */
  function _autoAssignFloatLabel(blockId, prefix) {
    var paperMap = window.PaperEditor.getPaperMap && window.PaperEditor.getPaperMap();
    if (!paperMap || !blockId) return null;
    var sections = paperMap.get('sections');
    if (!sections || typeof sections.forEach !== 'function') return null;
    var label = null;
    sections.forEach(function (secMap) {
      if (label) return;
      var children = secMap && secMap.get && secMap.get('children');
      if (!children || typeof children.forEach !== 'function') return;
      children.forEach(function (blk) {
        if (label) return;
        if (!blk || typeof blk.get !== 'function' || blk.get('id') !== blockId) return;
        var attrs = blk.get('attrs');
        if (!attrs || typeof attrs.get !== 'function') return;
        if ((attrs.get('label') || '').trim()) { label = attrs.get('label'); return; }
        var capY = (prefix === 'tab:') ? attrs.get('caption') : blk.get('body');
        var cap = capY && capY.toString ? capY.toString() : '';
        var base = String(cap).trim().toLowerCase()
          .replace(/[^a-z0-9\s_-]+/g, '')
          .trim().split(/\s+/).slice(0, 4).join('-');
        if (!base) base = String(blockId).replace(/^p-/, '');
        label = prefix + base.slice(0, 40);
        blk.doc.transact(function () { attrs.set('label', label); }, 'auto-label');
      });
    });
    return label;
  }

  /* ── Figure block mutations ──────────────────────────────────────── */
  function _findFigureBlock(blockId) {
    var paperMap = window.PaperEditor.getPaperMap();
    if (!paperMap) return null;
    var sections = paperMap.get('sections');
    var hit = null;
    if (sections && typeof sections.forEach === 'function') {
      sections.forEach(function (secMap) {
        if (hit) return;
        var children = secMap && secMap.get && secMap.get('children');
        if (!children || typeof children.forEach !== 'function') return;
        children.forEach(function (blk) {
          if (hit) return;
          if (!blk || typeof blk.get !== 'function') return;
          if (blk.get('kind') !== 'figure') return;
          if (blk.get('id') === blockId) hit = blk;
        });
      });
    }
    if (hit) return hit;
    /* V3.132 — also search the unplaced library so panel-side editors work
     * before the figure is placed in the doc. */
    var unplaced = paperMap.get('figure_unplaced');
    if (unplaced && typeof unplaced.forEach === 'function') {
      unplaced.forEach(function (blk) {
        if (hit) return;
        if (blk && typeof blk.get === 'function' && blk.get('id') === blockId) hit = blk;
      });
    }
    return hit;
  }

  function _updateFigureAttrs(blockId, mutator) {
    var blk = _findFigureBlock(blockId);
    if (!blk) return;
    var attrs = blk.get('attrs');
    if (!attrs) return;
    blk.doc.transact(function () { mutator(attrs); }, 'fig-row-update');
  }

  function _addSubfigure(blockId, label) {
    var blk = _findFigureBlock(blockId);
    if (!blk) return;
    var Y = window.PaperEditor.getY();
    if (!Y) return;
    var attrs = blk.get('attrs');
    if (!attrs) return;
    var maxN = (window.PaperSchemas && window.PaperSchemas.MAX_SUBFIGURES) || 12;
    blk.doc.transact(function () {
      var sf = attrs.get('subfigures');
      if (!(sf instanceof Y.Array)) {
        attrs.set('subfigures', new Y.Array());
        sf = attrs.get('subfigures');
      }
      if (sf.length >= maxN) return;
      var m = new Y.Map();
      sf.push([m]);
      var mkId = (window.PaperSchemas && window.PaperSchemas.shortId)
        ? window.PaperSchemas.shortId('sf-')
        : 'sf-' + Math.random().toString(36).slice(2, 9);
      m.set('id', mkId);
      m.set('label', label || '');
    }, 'fig-add-subfigure');
  }

  function _removeSubfigure(blockId, subfigureId) {
    var blk = _findFigureBlock(blockId);
    if (!blk) return;
    var attrs = blk.get('attrs');
    if (!attrs) return;
    var sf = attrs.get('subfigures');
    if (!sf || typeof sf.forEach !== 'function') return;
    var idx = -1;
    sf.forEach(function (m, i) {
      if (idx >= 0) return;
      if (m && m.get && m.get('id') === subfigureId) idx = i;
    });
    if (idx < 0) return;
    blk.doc.transact(function () { sf.delete(idx, 1); }, 'fig-remove-subfigure');
  }

  function _scrollToBlock(blockId) {
    var el = document.querySelector('.pe-block[data-block-id="' + _escAttr(blockId) + '"]');
    if (!el) return;
    el.scrollIntoView({ behavior: 'smooth', block: 'center' });
    el.classList.add('pe-block-flash');
    setTimeout(function () { el.classList.remove('pe-block-flash'); }, 1200);
  }

  /* V3.132 — find which section contains a placed block id. Used by the
   * doc-side action buttons (Unplace, Delete) on placed figure/table
   * rows. Returns null if not found in any section. */
  function _findContainingSectionId(blockId) {
    var paperMap = window.PaperEditor.getPaperMap && window.PaperEditor.getPaperMap();
    if (!paperMap) return null;
    var sections = paperMap.get('sections');
    if (!sections || typeof sections.forEach !== 'function') return null;
    var found = null;
    sections.forEach(function (secMap) {
      if (found) return;
      var children = secMap && secMap.get && secMap.get('children');
      if (!children || typeof children.forEach !== 'function') return;
      children.forEach(function (b) {
        if (found) return;
        if (b && b.get && b.get('id') === blockId) found = secMap.get('id');
      });
    });
    return found;
  }

  /* V3.132 — popover that lets the user pick a section to place an
   * unplaced figure/table into (appended to the section's children).
   * Anchored to the click button. */
  function _openPlaceUnplacedPicker(kind, blockId, anchorBtn) {
    var existing = document.getElementById('pe-place-picker');
    if (existing) existing.remove();
    var paperMap = window.PaperEditor.getPaperMap && window.PaperEditor.getPaperMap();
    if (!paperMap) return;
    var sections = paperMap.get('sections');
    if (!sections) return;

    var pop = document.createElement('div');
    pop.className = 'pe-place-picker';
    pop.id = 'pe-place-picker';

    var head = document.createElement('div');
    head.className = 'pe-place-picker-head';
    head.textContent = 'Place at end of section…';
    pop.appendChild(head);

    var rows = document.createElement('div');
    rows.className = 'pe-place-picker-rows';

    sections.forEach(function (secMap) {
      var secId = secMap.get('id');
      var label = secMap.get('label');
      var labelStr = (label && typeof label.toString === 'function') ? label.toString() : String(label || '');
      var secKind = secMap.get('kind');
      /* Honor section style: skip sections that don't allow figures
       * (like References) when placing a figure. Tables are allowed
       * everywhere. */
      if (kind === 'figure' && window.PaperSchemas && window.PaperSchemas.styleFor) {
        var style = window.PaperSchemas.styleFor({ kind: secKind, style_overrides: {} });
        if (style && style.allowFigures === false) return;
      }
      var children = secMap.get('children');
      var endIdx = children ? children.length : 0;
      var btn = document.createElement('button');
      btn.type = 'button';
      btn.className = 'pe-place-picker-row';
      btn.textContent = labelStr || '(untitled section)';
      var meta = document.createElement('span');
      meta.className = 'pe-place-picker-row-meta';
      meta.textContent = '+ ' + (kind === 'figure' ? 'Fig.' : 'Tab.');
      btn.appendChild(meta);
      btn.addEventListener('click', function () {
        if (window.PaperEditor && window.PaperEditor.placeUnplacedAt) {
          window.PaperEditor.placeUnplacedAt(kind, blockId, secId, endIdx);
        }
        pop.remove();
      });
      rows.appendChild(btn);
    });
    if (!rows.children.length) {
      var empty = document.createElement('div');
      empty.className = 'pe-place-picker-empty';
      empty.textContent = (kind === 'figure')
        ? 'No sections allow figures yet — add a Methods/Results/Discussion/Background section first.'
        : 'No sections yet — add one first.';
      rows.appendChild(empty);
    }
    pop.appendChild(rows);

    var rect = anchorBtn.getBoundingClientRect();
    pop.style.left = rect.left + 'px';
    pop.style.top = (rect.bottom + 4) + 'px';
    document.body.appendChild(pop);

    /* Click-outside dismiss + ESC dismiss. */
    var dismiss = function (ev) {
      if (!pop.contains(ev.target) && ev.target !== anchorBtn) {
        pop.remove();
        document.removeEventListener('mousedown', dismiss, true);
      }
    };
    document.addEventListener('mousedown', dismiss, true);
    document.addEventListener('keydown', function escH(e) {
      if (e.key === 'Escape' && document.body.contains(pop)) {
        pop.remove();
        document.removeEventListener('keydown', escH);
      }
    });

    /* Clamp to viewport. */
    requestAnimationFrame(function () {
      var r = pop.getBoundingClientRect();
      if (r.right > window.innerWidth - 8) {
        pop.style.left = Math.max(8, window.innerWidth - r.width - 8) + 'px';
      }
      if (r.bottom > window.innerHeight - 8) {
        pop.style.top = Math.max(8, window.innerHeight - r.height - 8) + 'px';
      }
    });
  }

  /* V3.132 — doc-side + Add → Figure picker. Lists unplaced figures
   * (top), then placed figures (with "in §X" subtitle), with a "+ New
   * figure" row at the very top. Picking unplaced moves the figure to
   * the inserter position; picking placed re-positions; picking + New
   * creates a fresh unplaced + immediately places it. */
  function _openFigurePickerAt(sectionId, idx, anchorBtn) {
    _openPickerAt({
      kind: 'figure',
      sectionId: sectionId,
      idx: idx,
      anchorBtn: anchorBtn,
      title: 'Pick a figure (or create new)',
    });
  }
  function _openTablePickerAt(sectionId, idx, anchorBtn) {
    _openPickerAt({
      kind: 'table',
      sectionId: sectionId,
      idx: idx,
      anchorBtn: anchorBtn,
      title: 'Pick a table (or create new)',
    });
  }
  function _openEquationPickerAt(sectionId, idx, anchorBtn) {
    _openPickerAt({
      kind: 'equation',
      sectionId: sectionId,
      idx: idx,
      anchorBtn: anchorBtn,
      title: 'Pick a main equation (or create new)',
    });
  }

  function _openPickerAt(opts) {
    var existing = document.getElementById('pe-doc-picker');
    if (existing) existing.remove();
    var pop = document.createElement('div');
    pop.className = 'pe-doc-picker';
    pop.id = 'pe-doc-picker';

    var head = document.createElement('div');
    head.className = 'pe-doc-picker-head';
    head.textContent = opts.title;
    pop.appendChild(head);

    /* Search input. */
    var search = document.createElement('input');
    search.type = 'text';
    search.className = 'pe-doc-picker-search';
    search.placeholder = 'Filter by label or caption…';
    pop.appendChild(search);

    var rows = document.createElement('div');
    rows.className = 'pe-doc-picker-rows';
    pop.appendChild(rows);

    function refresh() {
      rows.innerHTML = '';
      var q = (search.value || '').trim().toLowerCase();
      /* "+ New …" row at the top, always visible. */
      var newRow = document.createElement('button');
      newRow.type = 'button';
      newRow.className = 'pe-doc-picker-row pe-doc-picker-row-new';
      newRow.innerHTML = '<span class="pe-doc-picker-row-title">+ New ' +
        (opts.kind === 'figure' ? 'figure'
          : opts.kind === 'table' ? 'table'
          : 'equation') + '</span>' +
        '<span class="pe-doc-picker-row-subtitle">Build in panel, place here</span>';
      newRow.addEventListener('click', function () {
        pop.remove();
        if (opts.kind === 'figure') {
          var blockId = window.PaperEditor.createUnplacedFigure();
          if (blockId) {
            window.PaperEditor.placeUnplacedAt('figure', blockId, opts.sectionId, opts.idx);
            _focusPanelOnBlock('figures', blockId);
          }
        } else if (opts.kind === 'table') {
          var blockIdT = window.PaperEditor.createUnplacedTable();
          if (blockIdT) {
            window.PaperEditor.placeUnplacedAt('table', blockIdT, opts.sectionId, opts.idx);
            _focusPanelOnBlock('tables', blockIdT);
          }
        } else if (opts.kind === 'equation') {
          openEquationCreateModalAt(opts.sectionId, opts.idx);
        }
      });
      rows.appendChild(newRow);

      /* E4 — captured equations from the reading library (papers read in
       * the reader; select the equation → ƒ to capture). */
      if (opts.kind === 'equation') {
        var capRow = document.createElement('button');
        capRow.type = 'button';
        capRow.className = 'pe-doc-picker-row pe-doc-picker-row-new';
        capRow.innerHTML = '<span class="pe-doc-picker-row-title">📚 From reading library…</span>' +
          '<span class="pe-doc-picker-row-subtitle">Equations captured while reading papers</span>';
        capRow.addEventListener('click', function () {
          pop.remove();
          _openCaptureBrowser(opts.sectionId, opts.idx);
        });
        rows.appendChild(capRow);
      }

      var unplaced = [];
      var placed = [];
      if (opts.kind === 'figure') {
        unplaced = window.PaperEditor.getUnplacedFigures
          ? window.PaperEditor.getUnplacedFigures()
          : [];
        placed = window.PaperEditor.getAllFigures
          ? window.PaperEditor.getAllFigures()
          : [];
      } else if (opts.kind === 'table') {
        unplaced = window.PaperEditor.getUnplacedTables
          ? window.PaperEditor.getUnplacedTables()
          : [];
        placed = window.PaperEditor.getAllTables
          ? window.PaperEditor.getAllTables()
          : [];
      } else if (opts.kind === 'equation') {
        var eqLib = (window.PaperEditor.getInlineEquationLibrary
          ? window.PaperEditor.getInlineEquationLibrary()
          : []).filter(function (e) { return e.type === 'main'; });
        eqLib.forEach(function (e) { unplaced.push(e); });
      }

      function rowMatches(textParts) {
        if (!q) return true;
        return textParts.some(function (t) {
          return (t || '').toLowerCase().indexOf(q) >= 0;
        });
      }

      /* Unplaced section. */
      if (unplaced.length) {
        var hdr = document.createElement('div');
        hdr.className = 'pe-doc-picker-section-head';
        hdr.textContent = 'Unplaced (built in panel)';
        rows.appendChild(hdr);
        unplaced.forEach(function (item) {
          var label, caption, id;
          if (opts.kind === 'equation') {
            label = item.name || '(unnamed)';
            caption = item.latex || '';
            id = item.id;
          } else {
            label = item.label || '(no label yet)';
            caption = item.caption || '';
            id = item.blockId;
          }
          if (!rowMatches([label, caption])) return;
          var btn = _makePickerRow({
            label: label,
            caption: caption,
            badge: 'Unplaced',
            kind: opts.kind,
            item: item,
          });
          btn.addEventListener('click', function () {
            pop.remove();
            if (opts.kind === 'figure' || opts.kind === 'table') {
              window.PaperEditor.placeUnplacedAt(opts.kind, id, opts.sectionId, opts.idx);
            } else if (opts.kind === 'equation') {
              /* Insert a numbered display equation block at position. */
              var label = '';
              if (item.name) {
                label = 'eq:' + item.name.replace(/[^a-z0-9_-]+/gi, '-')
                  .replace(/^-+|-+$/g, '').toLowerCase();
              }
              window.PaperEditor.insertBlockAt(opts.sectionId, opts.idx, 'equation', {
                body: item.latex,
                display: true,
                numbered: true,
                label: label,
              });
            }
          });
          rows.appendChild(btn);
        });
      }

      /* Placed section. */
      if (placed.length) {
        var hdr2 = document.createElement('div');
        hdr2.className = 'pe-doc-picker-section-head';
        hdr2.textContent = 'Already placed in document';
        rows.appendChild(hdr2);
        placed.forEach(function (item) {
          var label = item.label || '(no label)';
          var caption = item.caption || item.captionPreview || '';
          var num = item.num
            ? ((opts.kind === 'figure' ? 'Fig. ' : 'Tab. ') + item.num)
            : '(unnumbered)';
          if (!rowMatches([label, caption])) return;
          var btn = _makePickerRow({
            label: label,
            caption: caption,
            badge: num,
            kind: opts.kind,
            item: item,
          });
          btn.addEventListener('click', function () {
            pop.remove();
            /* Move from current section to the inserter target. */
            var srcSecId = _findContainingSectionId(item.blockId);
            if (!srcSecId) return;
            window.PaperEditor.moveBlockToPosition(
              srcSecId, item.blockId, opts.sectionId, opts.idx
            );
          });
          rows.appendChild(btn);
        });
      }

      if (!unplaced.length && !placed.length) {
        var empty = document.createElement('div');
        empty.className = 'pe-doc-picker-empty';
        empty.textContent = (opts.kind === 'equation')
          ? 'No main equations yet. Use "+ New equation" above.'
          : 'No ' + opts.kind + 's yet. Use "+ New ' + opts.kind + '" above.';
        rows.appendChild(empty);
      }
    }
    refresh();
    search.addEventListener('input', refresh);

    /* Position + dismiss + viewport clamping. */
    var rect = (opts.anchorBtn || document.body).getBoundingClientRect();
    pop.style.left = rect.left + 'px';
    pop.style.top = (rect.bottom + 4) + 'px';
    document.body.appendChild(pop);

    var dismiss = function (ev) {
      if (!pop.contains(ev.target) && ev.target !== opts.anchorBtn) {
        pop.remove();
        document.removeEventListener('mousedown', dismiss, true);
      }
    };
    document.addEventListener('mousedown', dismiss, true);
    document.addEventListener('keydown', function escH(e) {
      if (e.key === 'Escape' && document.body.contains(pop)) {
        pop.remove();
        document.removeEventListener('keydown', escH);
      }
    });
    requestAnimationFrame(function () {
      var r = pop.getBoundingClientRect();
      if (r.right > window.innerWidth - 8) {
        pop.style.left = Math.max(8, window.innerWidth - r.width - 8) + 'px';
      }
      if (r.bottom > window.innerHeight - 8) {
        pop.style.top = Math.max(8, window.innerHeight - r.height - 8) + 'px';
      }
    });
    setTimeout(function () { search.focus(); }, 30);
  }

  function _makePickerRow(o) {
    var btn = document.createElement('button');
    btn.type = 'button';
    btn.className = 'pe-doc-picker-row';
    var title = document.createElement('span');
    title.className = 'pe-doc-picker-row-title';
    title.textContent = o.label;
    var sub = document.createElement('span');
    sub.className = 'pe-doc-picker-row-subtitle';
    sub.textContent = (o.caption || '').slice(0, 90);
    var badge = document.createElement('span');
    badge.className = 'pe-doc-picker-row-badge';
    badge.textContent = o.badge || '';
    btn.appendChild(badge);
    btn.appendChild(title);
    btn.appendChild(sub);
    return btn;
  }

  function _focusPanelOnBlock(tab, blockId) {
    if (_currentPage() !== tab) { _gotoPage(tab, { focus: blockId }); return; }
    setTimeout(function () {
      if (tab === 'figures') scrollToFigureRow(blockId);
      else if (tab === 'tables') scrollToTableRow(blockId);
    }, 50);
  }

  /* ── Library CRUD (writes through paper-editor's state.paperMap) ──── */
  function _onAddInline() {
    var paperMap = window.PaperEditor.getPaperMap();
    var Y = window.PaperEditor.getY();
    if (!paperMap || !Y) return;
    var lib = paperMap.get('equation_library');
    if (!lib) return;
    paperMap.doc.transact(function () {
      var m = new Y.Map();
      lib.push([m]);
      m.set('id', window.PaperSchemas.shortId('eq-'));
      m.set('name', new Y.Text(''));
      m.set('latex', new Y.Text(''));
    }, 'eq-library-add');
    // Focus the new row's name input on next tick.
    setTimeout(function () {
      var listEl = document.getElementById('pe-equations-lib-list');
      if (!listEl) return;
      var rows = listEl.querySelectorAll('.pe-eq-library-row');
      var last = rows[rows.length - 1];
      if (last) {
        var input = last.querySelector('.pe-eq-library-name');
        if (input) input.focus();
      }
    }, 50);
  }

  function _updateLibraryEntry(id, patch) {
    var paperMap = window.PaperEditor.getPaperMap();
    var Y = window.PaperEditor.getY();
    if (!paperMap || !Y) return;
    var lib = paperMap.get('equation_library');
    if (!lib) return;
    var hit = null;
    lib.forEach(function (e) {
      if (hit) return;
      if (e && e.get && e.get('id') === id) hit = e;
    });
    if (!hit) return;
    paperMap.doc.transact(function () {
      if (typeof patch.name === 'string') {
        var n = hit.get('name');
        if (n && n.length) n.delete(0, n.length);
        if (patch.name) n.insert(0, patch.name);
      }
      if (typeof patch.latex === 'string') {
        var l = hit.get('latex');
        if (l && l.length) l.delete(0, l.length);
        if (patch.latex) l.insert(0, patch.latex);
      }
    }, 'eq-library-update');
  }

  function _deleteLibraryEntry(id) {
    var paperMap = window.PaperEditor.getPaperMap();
    if (!paperMap) return;
    var lib = paperMap.get('equation_library');
    if (!lib) return;
    var idx = -1;
    lib.forEach(function (e, i) {
      if (idx >= 0) return;
      if (e && e.get && e.get('id') === id) idx = i;
    });
    if (idx < 0) return;
    paperMap.doc.transact(function () { lib.delete(idx, 1); }, 'eq-library-delete');
  }

  /* ── Right-click context menu on paragraph bodies ────────────────── */
  function bindContextMenu(el) {
    if (!el || el.__paperEqContextBound) return;
    el.__paperEqContextBound = true;
    el.addEventListener('contextmenu', function (e) {
      _saveCaretFromEvent(e, el);
      _showContextMenu(e.clientX, e.clientY);
      e.preventDefault();
    });
  }

  function _saveCaretFromEvent(e, el) {
    _state.savedEl = el;
    var sel = window.getSelection();
    if (sel && sel.rangeCount && el.contains(sel.getRangeAt(0).endContainer)) {
      var live = sel.getRangeAt(0);
      _state.savedRange = live.cloneRange();
      _state.savedCaret = _readCharOffset(el, live.endContainer, live.endOffset);
    } else {
      _state.savedRange = null;
      _state.savedCaret = (el.textContent || '').length;
    }
  }

  function _showContextMenu(x, y) {
    _hideContextMenu();
    var menu = document.createElement('div');
    menu.className = 'pe-eq-context-menu';
    menu.style.left = x + 'px';
    menu.style.top = y + 'px';

    var item1 = _ctxMenuItem('📐 Insert inline equation', function () {
      _hideContextMenu();
      _openInlinePicker(x, y);
    });
    var item2 = _ctxMenuItem('Eq. # — Insert equation reference', function () {
      _hideContextMenu();
      _openRefPicker(x, y);
    });
    /* V3.115 — figure references + citation insert. */
    var item3 = _ctxMenuItem('🖼 Insert figure reference', function () {
      _hideContextMenu();
      _openFigRefPicker(x, y);
    });
    /* V3.120 — table references. */
    var item4 = _ctxMenuItem('📋 Insert table reference', function () {
      _hideContextMenu();
      _openTabRefPicker(x, y);
    });
    var item5 = _ctxMenuItem('📚 Insert citation (Cmd+K)', function () {
      _hideContextMenu();
      _openCitationPopoverFallback();
    });
    menu.appendChild(item1);
    menu.appendChild(item2);
    menu.appendChild(item3);
    menu.appendChild(item4);
    menu.appendChild(item5);

    document.body.appendChild(menu);
    _state.contextMenu = menu;

    // Clamp to viewport so the menu doesn't render off-screen.
    requestAnimationFrame(function () {
      var rect = menu.getBoundingClientRect();
      if (rect.right > window.innerWidth - 8) {
        menu.style.left = Math.max(8, window.innerWidth - rect.width - 8) + 'px';
      }
      if (rect.bottom > window.innerHeight - 8) {
        menu.style.top = Math.max(8, window.innerHeight - rect.height - 8) + 'px';
      }
    });

    var dismiss = function (ev) {
      if (!menu.contains(ev.target)) {
        _hideContextMenu();
        document.removeEventListener('mousedown', dismiss, true);
      }
    };
    setTimeout(function () {
      document.addEventListener('mousedown', dismiss, true);
    }, 0);
  }

  function _ctxMenuItem(label, onClick) {
    var item = document.createElement('button');
    item.type = 'button';
    item.className = 'pe-eq-context-menu-item';
    item.textContent = label;
    item.addEventListener('click', onClick);
    return item;
  }

  function _hideContextMenu() {
    if (_state.contextMenu && _state.contextMenu.parentElement) {
      _state.contextMenu.parentElement.removeChild(_state.contextMenu);
    }
    _state.contextMenu = null;
  }

  /* V3.144 — slugify an inline-equation name for use as a token key.
   * Tokens become `[!eqi:<slug>]` so authors see meaningful refs in
   * the source (e.g. `[!eqi:hookes-law]`) rather than the auto-generated
   * `eq-abc123` id. Falls back to the raw id when the entry has no
   * name. The renderer accepts either form (V3.144). */
  function _eqiSlugFromEntry(e) {
    var n = (e.name || '').trim();
    if (!n) return e.id;
    var slug = n.toLowerCase()
      .replace(/[^a-z0-9_-]+/g, '-')
      .replace(/^-+|-+$/g, '')
      .slice(0, 60);
    return slug || e.id;
  }

  /* ── Pickers ──────────────────────────────────────────────────────── */
  function _openInlinePicker(x, y) {
    var entries = window.PaperEditor.getInlineEquationLibrary();
    _openPicker(x, y, {
      title: 'Insert inline equation',
      emptyMsg: 'No inline equations yet. Open the Equations panel to add one.',
      rows: entries.map(function (e) {
        return {
          key: e.id,
          name: e.name || '(unnamed)',
          latex: e.latex,
          searchKey: ((e.name || '') + ' ' + (e.latex || '')).toLowerCase(),
          insert: '[!eqi:' + _eqiSlugFromEntry(e) + ']',
          renderDisplay: false,
        };
      }),
    });
  }

  function _openRefPicker(x, y) {
    var nums = window.PaperEditor.getNumberedEquations();
    _openPicker(x, y, {
      title: 'Insert equation reference',
      emptyMsg: 'No numbered equations yet. Add a numbered Equation block first.',
      rows: nums.map(function (n) {
        return {
          key: n.label,
          name: 'Eq. ' + n.num + ' — ' + n.label,
          latex: n.latex,
          searchKey: (n.label + ' ' + (n.latex || '')).toLowerCase(),
          insert: '[!eqr:' + n.label + ']',
          renderDisplay: true,
        };
      }),
    });
  }

  /* V3.120 — table reference picker. Single-step (no sub-panels). */
  function _openTabRefPicker(x, y) {
    var tabs = (window.PaperEditor.getNumberedTables && window.PaperEditor.getNumberedTables()) || [];
    var rows = tabs.map(function (t) {
      return {
        key: t.label || t.blockId,
        name: 'Tab. ' + t.num + ' — ' + (t.label || '(no label)'),
        searchKey: ((t.label || '') + ' ' + (t.captionPreview || '')).toLowerCase(),
        captionPreview: t.captionPreview || '',
        insert: t.label ? '[!tab:' + t.label + ']' : null,
        _tabRow: t,
      };
    });
    _openPicker(x, y, {
      title: 'Insert table reference',
      emptyMsg: 'No numbered tables yet. Add a Table block, set Numbered + a label.',
      rows: rows,
      renderRowMode: 'plain',
      onPick: function (row) {
        if (!row.insert) {
          /* V3.346 — auto-assign instead of dead-ending. */
          var newTabLabel = row._tabRow ? _autoAssignFloatLabel(row._tabRow.blockId, 'tab:') : null;
          if (!newTabLabel) return;
          row.insert = '[!tab:' + newTabLabel + ']';
        }
        _insertAtSavedCaret(row.insert);
      },
    });
  }

  /* V3.115 — figure reference picker. Two-step flow when the figure has
   * subfigures: first pick the figure, then pick the panel (or whole
   * figure / consecutive range). Single-step when the figure has no
   * subfigures — insert immediately. */
  function _openFigRefPicker(x, y) {
    var figs = (window.PaperEditor.getNumberedFigures && window.PaperEditor.getNumberedFigures()) || [];
    if (!figs.length) {
      _openPicker(x, y, {
        title: 'Insert figure reference',
        emptyMsg: 'No numbered figures yet. Add a Figure block in any section, set a label, and keep "Numbered" checked.',
        rows: [],
      });
      return;
    }
    /* First popover: list the figures. Each row's `insert` is null
     * because we hijack the click handler to open the sub-panel picker
     * (or insert immediately if no subfigures). */
    var rows = figs.map(function (f) {
      return {
        key: f.label,
        name: 'Fig. ' + f.num + ' — ' + (f.label || '(no label)'),
        thumbUrl: f.downloadUrl || '',
        captionPreview: f.captionPreview || '',
        searchKey: ((f.label || '') + ' ' + (f.captionPreview || '')).toLowerCase(),
        // No `insert` — handled by onPick below.
        _figRow: f,
      };
    });
    _openPicker(x, y, {
      title: 'Insert figure reference',
      emptyMsg: 'No figures yet.',
      rows: rows,
      renderRowMode: 'figure',  // tell _openPicker to use thumbnail not KaTeX
      onPick: function (row) {
        var fig = row._figRow;
        if (!fig.label) {
          /* V3.346 — auto-assign instead of dead-ending. */
          fig.label = _autoAssignFloatLabel(fig.blockId, 'fig:');
          if (!fig.label) return;
        }
        if (!fig.subfigures || fig.subfigures.length === 0) {
          _insertAtSavedCaret('[!fig:' + fig.label + ']');
          return;
        }
        // Subfigures present — open the panel picker.
        _openSubfigurePicker(x, y, fig);
      },
    });
  }

  /* Subfigure picker — opens after the user has chosen a figure. Shows
   * `[whole]`, each individual panel `(A)` `(B)`…, and auto-generated
   * consecutive ranges `(A-B)` `(A-C)` `(B-C)` etc. Inserts the
   * appropriate token. */
  function _openSubfigurePicker(x, y, fig) {
    var panels = (fig.subfigures || []).map(function (sf) { return sf.label || ''; }).filter(Boolean);
    var rows = [];
    rows.push({
      key: '__whole__',
      name: 'Whole figure (no panel)',
      searchKey: 'whole figure',
      insert: '[!fig:' + fig.label + ']',
    });
    panels.forEach(function (p) {
      rows.push({
        key: p,
        name: 'Fig. ' + fig.num + ' (' + p + ')',
        searchKey: p.toLowerCase(),
        insert: '[!fig:' + fig.label + ':' + p + ']',
      });
    });
    /* Auto-generated consecutive ranges: A-B, A-C, A-…, B-C, B-D, … */
    for (var i = 0; i < panels.length; i++) {
      for (var j = i + 1; j < panels.length; j++) {
        var range = panels[i] + '-' + panels[j];
        rows.push({
          key: range,
          name: 'Fig. ' + fig.num + ' (' + range + ')',
          searchKey: range.toLowerCase(),
          insert: '[!fig:' + fig.label + ':' + range + ']',
        });
      }
    }
    _openPicker(x, y, {
      title: 'Insert reference to ' + (fig.label || 'figure') + ' — pick panel(s)',
      emptyMsg: 'No panels.',
      rows: rows,
      renderRowMode: 'plain',
    });
  }

  /* V3.115 — wraps PaperEditor.openCitationPopover so the right-click
   * menu can offer "Insert citation" without requiring the user to know
   * Cmd+K. Restores caret first so the popover's onPick lands at the
   * right spot. */
  function _openCitationPopoverFallback() {
    if (!window.PaperEditor || !window.PaperEditor.openCitationPopover) {
      alert('Citation popover not available — try Cmd+K manually.');
      return;
    }
    /* V3.154 — restore caret via the live element + char-offset
     * (avoiding the stale-Range trap) so the popover's
     * insertCitationAtFocus has the right anchor. The popover uses its
     * own `lastFocusedEditable` tracker; focusing the saved element
     * with a fresh range below triggers PaperEditor's mouseup/keyup
     * listener chain to update that tracker. */
    if (_state.savedEl && document.body.contains(_state.savedEl)) {
      try {
        _state.savedEl.focus();
        var freshRange = _rangeFromCharOffset(_state.savedEl, _state.savedCaret || 0);
        if (freshRange) {
          var sel = window.getSelection();
          sel.removeAllRanges();
          sel.addRange(freshRange);
        }
      } catch (e) { /* best effort */ }
    }
    /* V3.157 — toolbar `+ Cite` uses the multi-pick popover so the
     * user can pick multiple citations and insert them as a single
     * `[@k1; @k2]` Pandoc citation group. Each row click toggles
     * selection; the popover's footer "Insert N" button (or
     * Cmd/Ctrl+Enter) commits all selected.
     * V3.158 — anchor the popover under the toolbar `+ Cite` button so
     * the picker has a consistent screen position regardless of which
     * paragraph the caret is in. */
    var citeBtn = document.getElementById('pe-gt-cite') || _state.savedEl;
    /* V3.192 — pass the source paragraph so the popover surfaces
     * claims and linked highlights for it. _state.savedEl is the
     * paragraph contenteditable the user just had the caret in
     * (mousedown caret-save records it). */
    var paragraphEl = (_state.savedEl && _state.savedEl.isContentEditable)
      ? _state.savedEl
      : (window.PaperEditor.getLastFocusedEditable
          ? window.PaperEditor.getLastFocusedEditable()
          : null);
    window.PaperEditor.openCitationPopover({
      anchorEl: citeBtn,
      paragraphEl: paragraphEl,
      onPickKeys: function (keys, narrative) {
        if (keys && keys.length && window.PaperEditor.insertCitationKeysAtFocus) {
          /* V3.344 — narrative flag from the popover checkbox. */
          window.PaperEditor.insertCitationKeysAtFocus(keys, { narrative: narrative });
        }
      },
    });
  }

  /* V3.115 — used by the Figures-tab "Insert reference" button. If the
   * figure has subfigures we'd ideally pop the panel picker, but the
   * panel button is on the row itself so we open the picker anchored
   * roughly at the row's center. Without a saved caret, fall back to
   * the currently-focused editable. */
  function _insertFigureReferenceAtSavedCaret(fig) {
    /* V3.154 — drop stale savedRange gate; rely on savedEl/savedCaret
     * with PaperEditor.lastFocusedEditable fallback. */
    if (!_state.savedEl || !document.body.contains(_state.savedEl)) {
      _saveCaretFromCurrentFocus();
    }
    if (!_state.savedEl || !document.body.contains(_state.savedEl)) {
      alert('Place the cursor in a paragraph first, then click Insert reference.');
      return;
    }
    if (!fig.label) {
      /* V3.346 — auto-assign instead of dead-ending. */
      fig.label = _autoAssignFloatLabel(fig.blockId, 'fig:');
      if (!fig.label) return;
    }
    if (!fig.subfigures || fig.subfigures.length === 0) {
      _insertAtSavedCaret('[!fig:' + fig.label + ']');
      return;
    }
    /* Subfigures — open the panel picker centered. */
    var x = window.innerWidth / 2 - 160;
    var y = window.innerHeight / 2 - 100;
    _openSubfigurePicker(x, y, fig);
  }

  function _openPicker(x, y, opts) {
    var pop = document.createElement('div');
    pop.className = 'pe-eq-picker';
    pop.style.left = x + 'px';
    pop.style.top = y + 'px';
    pop.innerHTML =
      '<div class="pe-eq-picker-title">' + _escHtml(opts.title) + '</div>' +
      '<input type="text" class="pe-eq-picker-search" placeholder="Search…" autocomplete="off">' +
      '<div class="pe-eq-picker-list"></div>' +
      '<div class="pe-eq-picker-hint">Esc to close</div>';
    document.body.appendChild(pop);

    var input = pop.querySelector('.pe-eq-picker-search');
    var listEl = pop.querySelector('.pe-eq-picker-list');
    var current = opts.rows.slice();
    var activeIdx = current.length ? 0 : -1;

    function renderList() {
      listEl.innerHTML = '';
      if (!current.length) {
        listEl.innerHTML = '<div class="pe-eq-picker-empty">' + _escHtml(opts.emptyMsg) + '</div>';
        return;
      }
      current.forEach(function (r, i) {
        var row = document.createElement('button');
        row.type = 'button';
        row.className = 'pe-eq-picker-row';
        if (i === activeIdx) row.classList.add('active');
        /* V3.115 — renderRowMode controls how the preview area is built:
         *   'figure' → thumbnail <img> + caption preview
         *   'plain'  → plain text (no preview area; for subfigure picker)
         *   default  → existing KaTeX preview */
        var preview = '';
        if (opts.renderRowMode === 'figure') {
          var thumb = r.thumbUrl
            ? '<img class="pe-eq-picker-figthumb" src="' + _escAttr(r.thumbUrl) + '" alt="">'
            : '<span class="pe-eq-picker-figthumb pe-eq-picker-figthumb-empty">(no image)</span>';
          var capLine = r.captionPreview
            ? '<div class="pe-eq-picker-figcap">' + _escHtml(r.captionPreview.slice(0, 100)) + (r.captionPreview.length > 100 ? '…' : '') + '</div>'
            : '';
          preview = thumb + capLine;
        } else if (opts.renderRowMode === 'plain') {
          preview = '';
        } else {
          preview = r.latex
            ? window.PaperEditor.renderEquationHtml(r.latex, !!r.renderDisplay)
            : '<span class="pe-eq-picker-empty-tex">(empty)</span>';
        }
        row.innerHTML =
          '<div class="pe-eq-picker-row-name">' + _escHtml(r.name) + '</div>' +
          (preview ? '<div class="pe-eq-picker-row-preview">' + preview + '</div>' : '');
        // V3.149 — same fix as V3.148: do NOT renderList() on mouseenter.
        // The destroy-and-rebuild was racing the click event so the
        // user's mousedown landed on the parent .pe-eq-picker-list
        // instead of the row button. Toggle .active in place.
        row.addEventListener('mouseenter', function () {
          if (activeIdx === i) return;
          activeIdx = i;
          Array.prototype.forEach.call(listEl.querySelectorAll('.pe-eq-picker-row'), function (r2, idx) {
            r2.classList.toggle('active', idx === i);
          });
        });
        row.addEventListener('click', function () { pickIdx(i); });
        listEl.appendChild(row);
      });
    }

    function refresh() {
      var q = (input.value || '').trim().toLowerCase();
      if (!q) {
        current = opts.rows.slice();
      } else {
        current = opts.rows.filter(function (r) { return r.searchKey.indexOf(q) >= 0; });
      }
      activeIdx = current.length ? 0 : -1;
      renderList();
    }

    function pickIdx(i) {
      var entry = current[i];
      if (!entry) return;
      _closePicker();
      /* V3.115 — opts.onPick override (used by figure picker so it can
       * branch into a subfigure picker rather than insert immediately).
       * Default behavior: insert the row's `insert` token at saved caret. */
      if (typeof opts.onPick === 'function') {
        opts.onPick(entry);
      } else if (entry.insert) {
        _insertAtSavedCaret(entry.insert);
      }
    }

    function _closePicker() {
      if (pop.parentElement) pop.parentElement.removeChild(pop);
      document.removeEventListener('mousedown', dismiss, true);
      document.removeEventListener('keydown', keyHandler, true);
      _state.pickerOpen = false;
    }
    function dismiss(ev) {
      if (!pop.contains(ev.target)) _closePicker();
    }
    function keyHandler(ev) {
      if (ev.key === 'Escape') { _closePicker(); ev.preventDefault(); return; }
      if (ev.key === 'Enter') {
        if (activeIdx >= 0 && activeIdx < current.length) {
          pickIdx(activeIdx);
          ev.preventDefault();
        }
        return;
      }
      if (ev.key === 'ArrowDown') {
        if (current.length) activeIdx = (activeIdx + 1) % current.length;
        renderList(); ev.preventDefault();
      }
      if (ev.key === 'ArrowUp') {
        if (current.length) activeIdx = (activeIdx - 1 + current.length) % current.length;
        renderList(); ev.preventDefault();
      }
    }
    input.addEventListener('input', refresh);
    document.addEventListener('mousedown', dismiss, true);
    document.addEventListener('keydown', keyHandler, true);

    // Clamp + render
    refresh();
    requestAnimationFrame(function () {
      var rect = pop.getBoundingClientRect();
      if (rect.right > window.innerWidth - 8) {
        pop.style.left = Math.max(8, window.innerWidth - rect.width - 8) + 'px';
      }
      if (rect.bottom > window.innerHeight - 8) {
        pop.style.top = Math.max(8, window.innerHeight - rect.height - 8) + 'px';
      }
    });
    setTimeout(function () { input.focus(); }, 30);
    _state.pickerOpen = true;
  }

  /* ── Insertion at saved caret position ─────────────────────────────
   *
   * V3.141 — always rebuild the Range fresh against the live DOM. The
   * cached `_state.savedRange` becomes stale the moment the
   * contenteditable blurs (e.g. the picker's search input grabs
   * focus): `applyRendered` does `el.innerHTML = renderFn(...)` which
   * swaps out the text nodes the Range references, leaving the Range
   * pointing at detached nodes. Applying that range silently fails and
   * `execCommand('insertText')` no-ops — the user sees "click button,
   * pick item, nothing happens." Instead we save (savedEl, savedCaret)
   * and walk the live DOM at insertion time to find the right text
   * node + offset.
   */
  function _insertAtSavedCaret(text) {
    /* Last-chance fallback to PaperEditor's tracker if nothing is
     * staged. */
    if (!_state.savedEl) {
      _saveCaretFromCurrentFocus();
    }
    var el = _state.savedEl;
    if (!el || !document.body.contains(el)) {
      console.warn('[paper-equations] insertAtSavedCaret: no saved caret');
      alert('Place your cursor in a paragraph first, then try again.');
      return;
    }
    /* V3.144 — focus FIRST so the contenteditable swaps from rendered
     * HTML back to source text (via the editor's focus handler that
     * does `el.textContent = yText.toString()`), THEN build the fresh
     * Range against the source-text DOM. The previous order built the
     * Range against the rendered DOM, then `el.focus()` immediately
     * destroyed that DOM by re-rendering source — so the Range pointed
     * at detached nodes by the time we applied selection, and the
     * caret silently snapped to position 0. */
    el.focus();
    var freshRange = _rangeFromCharOffset(el, _state.savedCaret || 0);
    if (!freshRange) {
      alert('Couldn’t restore the caret. Click into the paragraph and try again.');
      return;
    }
    try {
      var sel = window.getSelection();
      sel.removeAllRanges();
      sel.addRange(freshRange);
    } catch (e) {
      console.warn('[paper-equations] failed to restore caret:', e);
    }
    /* V3.159 — when inserting a bracket token (Pandoc citation or one
     * of the `[!eqi:…]`/`[!eqr:…]`/`[!fig:…]`/`[!tab:…]` reference
     * tokens), build the chip DOM element directly and insert via
     * range.insertNode rather than execCommand('insertText'). The
     * chip then appears as an atomic, rendered span immediately —
     * matching the V3.159 chip-mode focused-contenteditable invariant
     * that the user never sees raw `[@…]` text. Plain (non-token)
     * inserts still go through execCommand for the standard
     * insertText behavior. */
    var isBracketToken = (text.charAt(0) === '[' &&
                          text.charAt(text.length - 1) === ']' &&
                          /* V3.345 — `^` = footnote token. */
                          (text.charAt(1) === '@' || text.charAt(1) === '!' || text.charAt(1) === '^'));
    var chipInserted = false;
    if (isBracketToken && window.PaperEditor && window.PaperEditor.renderChipsOnlyHtml) {
      try {
        var chipHtml = window.PaperEditor.renderChipsOnlyHtml(text);
        var tpl = document.createElement('template');
        tpl.innerHTML = chipHtml;
        var chipNode = tpl.content.firstChild;
        if (chipNode && chipNode.dataset && chipNode.dataset.src) {
          var rangeForChip = window.getSelection().getRangeAt(0);
          rangeForChip.deleteContents();
          rangeForChip.insertNode(chipNode);
          /* Caret moves after the inserted chip. */
          var after = document.createRange();
          after.setStartAfter(chipNode);
          after.collapse(true);
          var sel2 = window.getSelection();
          sel2.removeAllRanges();
          sel2.addRange(after);
          /* Fire input event so the V3.159 chip-mode input handler
           * serializes the DOM (chip's data-src contributes the
           * token) and updates Y.Text. */
          el.dispatchEvent(new InputEvent('input', { bubbles: true }));
          chipInserted = true;
        }
      } catch (eChip) { /* fall through to execCommand path */ }
    }
    var ok = chipInserted;
    if (!ok) {
      try {
        ok = document.execCommand('insertText', false, text);
      } catch (e) { ok = false; }
    }
    if (!ok) {
      try {
        var s = window.getSelection();
        if (s && s.rangeCount) {
          var r = s.getRangeAt(0);
          r.deleteContents();
          r.insertNode(document.createTextNode(text));
          el.dispatchEvent(new InputEvent('input', { bubbles: true }));
        } else {
          /* Selection didn't take. Splice the text in at savedCaret
           * (source-space) so the inserted token lands at the user's
           * intended position rather than at the end. Dispatch input
           * so the Y.Text observer picks up the change. */
          var src = el.textContent || '';
          var pos = Math.max(0, Math.min(src.length, _state.savedCaret || 0));
          el.textContent = src.slice(0, pos) + text + src.slice(pos);
          el.dispatchEvent(new InputEvent('input', { bubbles: true }));
        }
      } catch (e2) { /* nothing */ }
    }
    /* Bump savedCaret past the inserted text so successive picks
     * stack rather than overwrite each other. */
    _state.savedCaret = (_state.savedCaret || 0) + text.length;
  }

  /* Used by the panel "Insert" button — falls back to a focus-based
   * lookup when there's no saved caret (i.e., user opened panel without
   * right-clicking first). V3.144 — emits the slug-based token (uses
   * the equation's name when available) instead of the raw id. */
  function _insertInlineEquationAtSavedCaret(eqId) {
    if (!_state.savedEl) {
      _saveCaretFromCurrentFocus();
    }
    if (!_state.savedEl) {
      alert('Place the cursor in a paragraph first, then click Insert.');
      return;
    }
    /* Resolve the entry to its name slug. */
    var entry = null;
    if (window.PaperEditor && window.PaperEditor.getInlineEquationById) {
      entry = window.PaperEditor.getInlineEquationById(eqId);
    }
    var slug = entry ? _eqiSlugFromEntry(entry) : eqId;
    _insertAtSavedCaret('[!eqi:' + slug + ']');
  }

  /* ── Misc ─────────────────────────────────────────────────────────── */
  function _installGlobalKeydown() {
    document.addEventListener('keydown', function (e) {
      if (e.key === 'Escape') {
        _hideContextMenu();
      }
    });
  }

  function _escHtml(s) {
    return String(s == null ? '' : s).replace(/[&<>"']/g, function (c) {
      return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c];
    });
  }
  function _escAttr(s) {
    return String(s == null ? '' : s).replace(/"/g, '&quot;');
  }

  /* V3.125 — public navigation helpers for the inline + Add inserter
   * and the doc-side "Edit in panel" links. These open the panel,
   * switch tabs, and flash matching rows so the user is dropped into
   * the relevant editor. */
  function setActiveTab(tabId) {
    /* Cross-page: selecting a tab that isn't this page navigates there.
     * On the write page this only RECORDS the tab — the deferred nav in
     * showPanel() (same tick) picks it up, so legacy
     * showPanel();setActiveTab(t) callers land on the right page. */
    if (_isToolPage() && tabId !== _currentPage()) { _gotoPage(tabId); return; }
    _activeTab = tabId;
    if (_isToolPage()) _setActiveTab(tabId);
  }
  function scrollToFigureRow(blockId) {
    if (_currentPage() !== 'figures') { _gotoPage('figures', { focus: blockId }); return; }
    var listEl = document.getElementById('pe-equations-fig-list');
    if (!listEl) return;
    var row = listEl.querySelector('.pe-fig-row[data-block-id="' + _escAttr(blockId) + '"]');
    if (!row) return;
    row.scrollIntoView({ behavior: 'smooth', block: 'center' });
    row.classList.add('pe-block-flash');
    setTimeout(function () { row.classList.remove('pe-block-flash'); }, 1200);
  }
  function scrollToTableRow(blockId) {
    if (_currentPage() !== 'tables') { _gotoPage('tables', { focus: blockId }); return; }
    var listEl = document.getElementById('pe-equations-tab-list');
    if (!listEl) return;
    var row = listEl.querySelector('.pe-tab-row[data-block-id="' + _escAttr(blockId) + '"]');
    if (!row) return;
    row.scrollIntoView({ behavior: 'smooth', block: 'center' });
    row.classList.add('pe-block-flash');
    setTimeout(function () { row.classList.remove('pe-block-flash'); }, 1200);
  }

  /* V3.125 — open the equation creation modal pre-targeted to insert
   * the resulting block at a specific position in a section, instead
   * of "in the section of the last-focused paragraph". Used by the
   * inline + Add → Equation menu choice. */
  function openEquationCreateModalAt(sectionId, idx) {
    /* Override _insertMainAsBlock for this single creation. We stash
     * the section + idx in a module-level "pending insert location"
     * that _insertMainAsBlock checks before falling back to its
     * V3.124 behavior. */
    _state.pendingInsertSectionId = sectionId;
    _state.pendingInsertIdx = idx;
    _openEquationCreateModal();
  }

  window.PaperEquations = {
    attach: attach,
    detach: detach,
    showPanel: showPanel,
    hidePanel: hidePanel,
    bindContextMenu: bindContextMenu,
    /* V3.125 — public nav helpers for the inline inserter + doc-side
     * "Edit in panel" links. */
    setActiveTab: setActiveTab,
    gotoPage: _gotoPage,           // pill-page navigation (opts.focus deep-link)
    scrollToFigureRow: scrollToFigureRow,
    scrollToTableRow: scrollToTableRow,
    openEquationCreateModalAt: openEquationCreateModalAt,
    /* V3.132 — doc-side + Add → Figure / Table / Equation pickers.
     * Each opens a popover that lists items already authored in the
     * panel + a "+ New …" row. Picking unplaced places the item; picking
     * placed re-positions; picking + New creates a fresh item and
     * places at the inserter position (or for equations, opens the
     * create modal). */
    openFigurePickerAt: _openFigurePickerAt,
    openTablePickerAt: _openTablePickerAt,
    openEquationPickerAt: _openEquationPickerAt,
  };
})();
