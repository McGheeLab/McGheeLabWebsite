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

  /* V3.741 — the tool pages (Tables / Figures / …) bind cells and captions
   * with their own readOnly flags, which used to be hardcoded false — so a
   * paper that paper-editor considered read-only (viewer role, or checked out
   * as a .paperbundle.zip) still LOOKED editable here, and typing simply
   * vanished at the provider. Ask the editor instead. */
  function _toolEditable() {
    return !!(window.PaperEditor && window.PaperEditor.isEditable && window.PaperEditor.isEditable());
  }
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
    /* V3.649 — bullet / numbered lists inside the paragraph you are
     * writing. These are LINE toggles, not selection wraps: they mark
     * every line the selection touches, and pressing the same button
     * again strips the markers. Export emits itemize / enumerate. */
    [
      { label: '• List', title: 'Bullet list — marks every line the selection touches (press again to remove)', type: 'bullet', cls: 'pe-gt-ul', id: 'pe-gt-ul' },
      { label: '1. List', title: 'Numbered list — marks every line the selection touches (press again to remove)', type: 'number', cls: 'pe-gt-ol', id: 'pe-gt-ol' },
    ].forEach(function (b) {
      var btn = document.createElement('button');
      btn.type = 'button';
      btn.className = 'pe-gt-btn ' + b.cls;
      btn.title = b.title;
      btn.id = b.id;
      btn.textContent = b.label;
      btn.addEventListener('mousedown', function (e) {
        e.preventDefault();
        if (window.PaperEditor && window.PaperEditor.toggleListAtSelection) {
          window.PaperEditor.toggleListAtSelection(b.type);
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
      /* V3.645 — value keys / inventory refs. One button for both
       * namespaces: the picker lists defined keys and offers a live
       * inventory search, so defining and inserting are one action. */
      { label: '+ Value',     title: 'Insert a value key or inventory item',         action: _toolbarInsertValue,          id: 'pe-gt-value' },
      /* V3.346 — discoverability: a static shortcuts & tips card. */
      { label: '', icon: 'keyboard', title: 'Keyboard shortcuts & tips',                    action: _toolbarShowShortcuts,        id: 'pe-gt-shortcuts' },
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
      /* V3.649 — section / subheading cross-references. The [!sec:] token,
       * its chip, the Document view's "Section N" numbering and the
       * exporter's \\label{}/\\ref{} pair all shipped in V3.432, but the only
       * way to make one was to hand-type a ref_label into a section header
       * and then hand-type the token. This is the missing picker. */
      { label: '+ Section', title: 'Insert a cross-reference to a section or subheading', action: _toolbarInsertSectionRef, id: 'pe-gt-secref' },
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
    if (b.icon) ICON.label(btn, b.icon, b.label);
    else btn.textContent = b.label;
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

  /* V3.345 — footnote insert: the [^text] token goes in at the saved caret
   * and renders immediately as a † chip via the bracket-token chip path in
   * _insertAtSavedCaret.
   * V3.648 — the text is typed in the picker's inline form, not a
   * window.prompt box. */
  function _sanitizeFootnote(txt) {
    /* Newlines always break the token; unbalanced brackets would too. */
    txt = String(txt || '').replace(/\n/g, ' ').trim();
    var d = 0, bal = true;
    for (var ci = 0; ci < txt.length; ci++) {
      if (txt[ci] === '[') d++;
      else if (txt[ci] === ']') { d--; if (d < 0) { bal = false; break; } }
    }
    if (!bal || d !== 0) txt = txt.replace(/[\[\]]/g, ' ').replace(/\s+/g, ' ').trim();
    return txt;
  }
  function _toolbarInsertFootnote(anchorBtn) {
    if (!_ensureCaretOrAlert()) return;
    var r = anchorBtn && anchorBtn.getBoundingClientRect
      ? anchorBtn.getBoundingClientRect() : null;
    _openPicker(
      r ? r.left : (window.innerWidth / 2 - 160),
      r ? (r.bottom + 4) : (window.innerHeight / 2 - 100),
      {
        title: 'Footnote', emptyMsg: '', renderRowMode: 'plain', rows: [],
        form: {
          title: 'Footnote',
          fields: [{
            key: 'text', label: 'Note text', value: '',
            placeholder: 'Measured on the 2026-04 calibration.',
            hint: 'Prints as a numbered footnote; exports as \\footnote{}.',
          }],
          submitLabel: 'Insert',
          backLabel: 'Cancel',
          validate: function (vals) {
            if (!_sanitizeFootnote(vals.text)) {
              return { field: 'text', message: 'Type the note text first.' };
            }
            return null;
          },
          onSubmit: function (vals, handle) {
            handle.close();
            _insertAtSavedCaret('[^' + _sanitizeFootnote(vals.text) + ']');
          },
        },
      }
    );
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
          '<tr><td><code>- item</code> / <code>1. item</code></td><td>Bullet / numbered list in a paragraph (2 spaces to nest)</td></tr>' +
          '<tr><td>View selector</td><td>Mixed / all-skeleton / all-body reading modes</td></tr>' +
          '<tr><td>' + ICON.svg('pencil') + ' Guide pill</td><td>Section-aware writing guidance + live checks</td></tr>' +
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
     * icon (+ plainLabel) builds the legacy in-pane tab nav; a tab with
     * no icon name keeps a text `label` (∑ Symbols). The slide-out pane
     * no longer shows its own tab nav, so this is unused but harmless. */
    /* V3.334 — leftmost "Guide" tab: section-aware curated writing
     * guidance + live self-checks (rendered by paper-writing-guide.js). */
    { id: 'guide',      icon: 'pencil',         plainLabel: 'Guide' },
    { id: 'equations',  icon: 'variable',       plainLabel: 'Equations' },
    /* V3.459 — math symbol palette (rendered by paper-symbols.js;
     * copy-to-clipboard tiles, user-reorderable sections). */
    { id: 'symbols',    label: '∑ Symbols',     plainLabel: 'Symbols' },
    /* V3.645 — per-paper value keys + inventory refs (paper-values.js). */
    { id: 'values',     icon: 'key',            plainLabel: 'Values' },
    { id: 'figures',    icon: 'photo',          plainLabel: 'Figures' },
    /* V3.609 — freeform planning canvas: figure/experiment/reference/note
     * cards + arrows (rendered by paper-figure-board.js). */
    { id: 'figure-board', icon: 'compass',      plainLabel: 'Figure board' },
    { id: 'tables',     icon: 'table-cells',    plainLabel: 'Tables' },
    { id: 'references', icon: 'books',          plainLabel: 'References' },
    /* V3.466 — grant submission documents + checklist. `visibleFor`
     * limits the pill to grant papers; other tabs (no visibleFor) show
     * for every paper_type. */
    { id: 'grant-docs', icon: 'paper-clip',     plainLabel: 'Grant Docs', visibleFor: ['grant'] },
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
    ICON.label(title, 'variable', ' Panel');
    var close = document.createElement('button');
    close.type = 'button';
    close.className = 'pe-icon-btn';
    close.setAttribute('aria-label', 'Close');
    ICON.label(close, 'x-mark');
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
      if (t.icon) ICON.label(btn, t.icon, ' ' + t.plainLabel);
      else btn.textContent = t.label;
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

    /* V3.645 — Values tab content (same lazy-scaffold contract;
     * paper-values.js fills #pe-values-root). */
    var valTab = document.createElement('div');
    valTab.className = 'pe-tab-content';
    valTab.dataset.tab = 'values';
    var valRoot = document.createElement('div');
    valRoot.id = 'pe-values-root';
    valTab.appendChild(valRoot);
    panel.appendChild(valTab);

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
    fbCard.innerHTML = '<b>' + ICON.svg('construction') + ' Figure builder</b> — a guided workspace for assembling ' +
      'publication figures (plots, schematics, annotations) is planned here. For now, use ' +
      '<i>' + ICON.svg('puzzle-piece') + ' Compose panels…</i> on any figure to arrange panel images into one labeled composite.';
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
    ICON.label(refEvidenceRefresh, 'arrow-path');
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
    /* V3.841 — the figure board is a canvas: give it the whole width */
    try { document.documentElement.classList.toggle('pe-wide-tab', tabId === 'figure-board'); } catch (e) {}
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

  /* V3.647 — never rebuild a list out from under a live editor.
   *
   * The Figures and Tables pages mount REAL collaborative editors — table
   * cells and captions bound through `bindYTextToContentEditable` — inside
   * lists that the refreshers below replace wholesale with
   * `listEl.innerHTML = ''`. Every keystroke in one of those mutates a
   * Y.Text under `sections`, which fires the `observeDeep` registered in
   * _installSubscriptions, which calls _refreshPanel, which destroys the
   * contenteditable the caret is sitting in. That is the "I can only type
   * one letter at a time in a table cell" bug: one character in, DOM
   * rebuilt, focus gone, click back in, repeat.
   *
   * So when focus is inside a list this refresh would replace, park the
   * refresh on the list element and run it once focus leaves. Remote edits
   * still land — at the next natural pause instead of mid-word. */
  function _holdsFocus(el) {
    var a = document.activeElement;
    return !!(el && a && a !== document.body && el.contains(a));
  }
  function _deferWhileEditing(listIds, refreshFn) {
    for (var i = 0; i < listIds.length; i++) {
      var host = document.getElementById(listIds[i]);
      if (!host || !_holdsFocus(host)) continue;
      host.__peDeferredRefresh = refreshFn;
      if (!host.__peDeferWired) {
        host.__peDeferWired = true;
        host.addEventListener('focusout', function () {
          var self = this;
          /* focusout fires BEFORE the next element takes focus, so settle on
           * the next tick — otherwise tabbing from one table cell to the
           * next rebuilds the grid in the gap between them. */
          setTimeout(function () {
            if (_holdsFocus(self)) return;
            var fn = self.__peDeferredRefresh;
            self.__peDeferredRefresh = null;
            if (fn) fn();
          }, 0);
        });
      }
      return true;
    }
    return false;
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
    if (_activeTab === 'values') {
      /* V3.645 — rendered by paper-values.js (idempotent, like Guide). */
      if (window.PaperValues) {
        window.PaperValues.buildTabContent(document.getElementById('pe-values-root'));
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
    ICON.label(delBtn, 'trash');
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
    ICON.label(closeBtn, 'x-mark');
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
    ICON.label(delBtn, 'trash');
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
    /* V3.647 — figure captions are live Y.Text editors in these lists, so
     * they lose the caret to a rebuild exactly like table cells do. */
    if (_deferWhileEditing(
      ['pe-equations-fig-unplaced-list', 'pe-equations-fig-list'],
      _refreshFiguresSection)) return;
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
      readOnly: !_toolEditable(),   // V3.741 — was hardcoded false; honours the checkout lock
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
      readOnly: !_toolEditable(),   // V3.741 — was hardcoded false; honours the checkout lock
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
      ICON.label(composeBtn, 'puzzle-piece', ' Compose panels…');
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
      ICON.label(x, 'x-mark');
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
      pdfIcon.textContent = ' ';
      pdfIcon.appendChild(ICON.el('document-text'));
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
    ICON.label(closeBtn, 'x-mark');
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
      ICON.label(lookupBtn, 'magnifying-glass', ' Look up metadata');
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
          ICON.label(lookupBtn, 'magnifying-glass', ' Look up metadata');
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
    /* V3.647 — the table grid's per-cell contenteditables live in these two
     * lists. Rebuilding while one has the caret is the one-letter-at-a-time
     * bug; see _deferWhileEditing. */
    if (_deferWhileEditing(
      ['pe-equations-tab-unplaced-list', 'pe-equations-tab-list'],
      _refreshTablesSection)) return;
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

  /* ── Panel-side table editor (V3.127, rewritten V3.650) ───────────
   *
   * The Tables page owns table editing: the doc-side block has been a
   * read-only preview since V3.127. Three things were wrong with the
   * original panel editor and all three are fixed here.
   *
   * 1. STRUCTURE WAS APPEND-ONLY. `+ Row` / `+ Col` wrote cells[rows-c]
   *    and bumped the counter. Deleting — or inserting in the middle —
   *    means RE-KEYING the `cells` Y.Map ("<r>-<c>" string keys) and
   *    shifting `merges_json` / `align` / `widths_json` in step, which
   *    nothing did. `_tblStructOp` below does. The controls now live on
   *    the grid's borders (gutter row + gutter column) instead of in the
   *    style bar.
   *
   * 2. NOTHING RE-RENDERED UNTIL BLUR. A structural write fires the
   *    observeDeep in _installSubscriptions -> _refreshPanel ->
   *    _refreshTablesSection -> _deferWhileEditing, which PARKS the
   *    whole-list rebuild while focus is in the list — and clicking
   *    `+ Row` puts focus on a button inside that list. V3.647 is right
   *    to park a whole-list rebuild (that is the one-letter-at-a-time
   *    fix); what was missing is a cheap path for structure. So this
   *    editor watches its own block with a SHALLOW attrs.observe: typing
   *    mutates a Y.Text *inside* attrs.cells, which a shallow observe
   *    never sees, so the caret still survives, while rows/cols/merges
   *    repaint on the spot.
   *
   * 3. MERGE NEEDED SHIFT-CLICK AND ALERTED WHEN WRONG. Now: drag across
   *    cells, and the only actions that apply float over the selection.
   */

  /* attrs keys that change the SHAPE of the table. A change to any of
   * these re-renders the editor body; everything else (caption, notes,
   * label, numbered) is left alone so its field keeps focus. */
  var TBL_STRUCT_KEYS = {
    rows: 1, cols: 1, cells: 1, merges_json: 1,
    align: 1, widths_json: 1, header_row: 1, booktabs: 1,
    style_json: 1, cell_styles_json: 1, row_heights_json: 1,
  };

  var _tblObs = Object.create(null);   // blockId -> {attrs, handler, rootEl}
  var _tblRebuilding = false;          // re-entrancy guard for the observer
  var _tblDrag = null;                 // {blockId} while a cell drag is live
  var _tblColDrag = false;             // true while a column border is being dragged
  var _tblDocWired = false;

  /* Read every cell as a plain STRING. Cell source is plain text
   * (renderParagraphHtml parses the markdown-ish syntax at paint time),
   * and a Y.Text can only be integrated once — it cannot be moved to a
   * different key — so re-keying clones by string. */
  function _tblReadGrid(attrs, rows, cols) {
    var cells = attrs.get('cells');
    var grid = [];
    for (var r = 0; r < rows; r++) {
      var row = [];
      for (var c = 0; c < cols; c++) {
        var t = (cells && cells.get) ? cells.get(r + '-' + c) : null;
        row.push((t && t.toString) ? t.toString() : '');
      }
      grid.push(row);
    }
    return grid;
  }

  /* Rewrite the whole shape in one transact. The cells map is replaced
   * wholesale: a structural edit is an explicit click, the grid repaints
   * straight after, and targeted re-keying would have to walk the same
   * cells anyway at these sizes. */
  function _tblWriteGrid(blk, attrs, grid, merges, alignArr, widthsArr, origin, extras) {
    var Y = window.PaperEditor.getY();
    var rows = grid.length;
    var cols = rows ? grid[0].length : 0;
    blk.doc.transact(function () {
      attrs.set('rows', rows);
      attrs.set('cols', cols);
      var cells = new Y.Map();
      attrs.set('cells', cells);                 // integrate before filling
      for (var r = 0; r < rows; r++) {
        for (var c = 0; c < cols; c++) {
          var t = new Y.Text();
          cells.set(r + '-' + c, t);
          if (grid[r][c]) t.insert(0, grid[r][c]);
        }
      }
      if (merges && Object.keys(merges).length) {
        attrs.set('merges_json', JSON.stringify(merges));
      } else {
        attrs.delete('merges_json');
      }
      var al = (alignArr || []).join('');
      if (al) attrs.set('align', al); else attrs.delete('align');
      var anyW = (widthsArr || []).some(function (w) { return w && w.mode !== 'auto'; });
      if (anyW) attrs.set('widths_json', JSON.stringify(widthsArr));
      else attrs.delete('widths_json');
      /* V3.651 — cell styles and extra rules are separate scalars; they
       * have to be re-keyed in the SAME transact or the table repaints
       * with the formatting on the column that used to be there. */
      if (typeof extras === 'function') extras(attrs);
    }, origin || 'tab-struct');
  }

  /* Move merge anchors/spans across a row/column insert or delete.
   * axis 'r' | 'c'; op 'ins' | 'del'; `at` is the index the line is
   * inserted BEFORE / the index being deleted. This is the piece that
   * never existed, and it is why insert/delete were never built. */
  function _tblShiftMerges(merges, axis, op, at) {
    var out = {};
    Object.keys(merges || {}).forEach(function (k) {
      var p = k.split('-');
      var r = +p[0], c = +p[1];
      var m = merges[k];
      var rs = m.rs, cs = m.cs;
      var idx = (axis === 'r') ? r : c;
      var span = (axis === 'r') ? rs : cs;
      if (op === 'ins') {
        if (idx >= at) idx += 1;                  // pushed down / right
        else if (idx + span > at) span += 1;      // the merge straddles the new line
      } else {
        if (idx > at) idx -= 1;
        else if (idx === at) {
          if (span <= 1) return;                  // the anchor's own line is gone
          span -= 1;                              // anchor stays put, one line shorter
        } else if (idx + span > at) {
          span -= 1;                              // straddling merge loses a line
        }
      }
      if (axis === 'r') { r = idx; rs = span; } else { c = idx; cs = span; }
      if (rs <= 1 && cs <= 1) return;             // decayed to a normal cell
      out[r + '-' + c] = { rs: rs, cs: cs };
    });
    return out;
  }

  /* Insert or delete one row / column, keeping cells, merges, per-column
   * alignment and per-column widths in step. */
  function _tblStructOp(blk, attrs, axis, op, at) {
    var rows = attrs.get('rows') || 0;
    var cols = attrs.get('cols') || 0;
    if (op === 'del') {
      if (axis === 'r' && rows <= 1) return;
      if (axis === 'c' && cols <= 1) return;
      if (at < 0 || (axis === 'r' ? at >= rows : at >= cols)) return;
    } else {
      /* Degenerate imported table — seed a 1x1 so there is something to
       * splice into. _tblReadGrid fills missing keys with ''. */
      if (rows < 1) rows = 1;
      if (cols < 1) cols = 1;
    }
    var grid = _tblReadGrid(attrs, rows, cols);
    var PL = window.PaperLayout || {};
    var merges = PL.parseTableMerges ? PL.parseTableMerges(attrs.get('merges_json')) : {};
    var alignStr = String(attrs.get('align') || '').slice(0, cols);
    while (alignStr.length < cols) alignStr += 'l';
    var alignArr = alignStr.split('');
    var widths = PL.parseTableWidths ? PL.parseTableWidths(attrs.get('widths_json'), cols) : [];

    if (axis === 'r') {
      if (op === 'ins') {
        var blank = [];
        for (var c = 0; c < cols; c++) blank.push('');
        grid.splice(at, 0, blank);
      } else {
        grid.splice(at, 1);
      }
    } else {
      for (var r = 0; r < grid.length; r++) {
        if (op === 'ins') grid[r].splice(at, 0, '');
        else grid[r].splice(at, 1);
      }
      if (op === 'ins') {
        alignArr.splice(at, 0, 'l');
        widths.splice(at, 0, { mode: 'auto' });
      } else {
        alignArr.splice(at, 1);
        widths.splice(at, 1);
      }
    }
    /* V3.651 — the same splice applied to the styling scalars. */
    var cellStyles = PL.parseTableCellStyles
      ? PL.shiftTableCellStyles(PL.parseTableCellStyles(attrs.get('cell_styles_json')), axis, op, at)
      : {};
    var style = PL.parseTableStyle
      ? PL.parseTableStyle(attrs.get('style_json'), attrs.get('booktabs'))
      : null;
    if (style) style.rule_after = PL.shiftTableRuleAfter(style.rule_after, axis, op, at);
    var rowExtras = PL.parseTableRowExtras
      ? PL.shiftTableRowExtras(PL.parseTableRowExtras(attrs.get('row_heights_json')), axis, op, at)
      : {};

    _tblSel = null;
    _tblWriteGrid(blk, attrs, grid, _tblShiftMerges(merges, axis, op, at),
      alignArr, widths, 'tab-' + axis + '-' + op, function (a) {
        if (Object.keys(cellStyles).length) a.set('cell_styles_json', JSON.stringify(cellStyles));
        else a.delete('cell_styles_json');
        if (Object.keys(rowExtras).length) a.set('row_heights_json', JSON.stringify(rowExtras));
        else a.delete('row_heights_json');
        if (style) _tblStoreStyle(a, style);
      });
  }

  /* Write a normalized style back, deleting the attr when nothing is
   * off-default so an untouched table stays byte-identical on export.
   * `booktabs` is kept in sync because the export and Document view fall
   * back to it for tables authored before V3.651. */
  function _tblStoreStyle(attrs, st) {
    var PL = window.PaperLayout || {};
    if (PL.tableStyleIsDefault && PL.tableStyleIsDefault(st)) {
      attrs.delete('style_json');
    } else {
      attrs.set('style_json', JSON.stringify({
        rules: st.rules, size: st.size, density: st.density,
        zebra: !!st.zebra, wrap: st.wrap !== false, rule_after: st.rule_after,
      }));
    }
    /* The legacy flag means "emit booktabs rules", so grid and none both
     * clear it — a consumer that predates style_json then draws a full
     * grid, which is right for grid and the closest thing available for
     * none. Everything in this release reads style_json first. */
    attrs.set('booktabs', st.rules === 'booktabs');
  }

  function _tblReadStyle(attrs) {
    var PL = window.PaperLayout || {};
    return PL.parseTableStyle
      ? PL.parseTableStyle(attrs.get('style_json'), attrs.get('booktabs'))
      : { rules: 'booktabs', size: 'normal', density: 'normal', zebra: false,
          rule_after: [], stretch: 1, sizeTex: null, sizeCss: 1 };
  }
  function _tblReadCellStyles(attrs) {
    var PL = window.PaperLayout || {};
    return PL.parseTableCellStyles ? PL.parseTableCellStyles(attrs.get('cell_styles_json')) : {};
  }
  function _tblWriteCellStyles(blk, attrs, map) {
    blk.doc.transact(function () {
      if (Object.keys(map).length) attrs.set('cell_styles_json', JSON.stringify(map));
      else attrs.delete('cell_styles_json');
    }, 'tab-cell-styles');
  }

  /* Normalized selection rectangle. */
  function _tblRect(sel) {
    return {
      r0: Math.min(sel.r0, sel.r1), r1: Math.max(sel.r0, sel.r1),
      c0: Math.min(sel.c0, sel.c1), c1: Math.max(sel.c0, sel.c1),
    };
  }

  /* Grow the rect until it fully contains every merge it touches, so a
   * drag that clips half a merged cell is still a legal merge target
   * instead of the old "unmerge it first" dead end. */
  function _tblExpandRect(rect, cover) {
    var changed = true, guard = 0;
    while (changed && guard++ < 32) {
      changed = false;
      Object.keys(cover.anchors).forEach(function (k) {
        var p = k.split('-');
        var ar = +p[0], ac = +p[1];
        var a = cover.anchors[k];
        var br = ar + a.rs - 1, bc = ac + a.cs - 1;
        if (br < rect.r0 || ar > rect.r1 || bc < rect.c0 || ac > rect.c1) return;
        if (ar < rect.r0) { rect.r0 = ar; changed = true; }
        if (br > rect.r1) { rect.r1 = br; changed = true; }
        if (ac < rect.c0) { rect.c0 = ac; changed = true; }
        if (bc > rect.c1) { rect.c1 = bc; changed = true; }
      });
    }
    return rect;
  }

  /* Document-level drag/clear handlers, wired once. */
  function _tblEnsureDocHandlers() {
    if (_tblDocWired) return;
    _tblDocWired = true;
    document.addEventListener('mouseup', function () {
      if (!_tblDrag) return;
      _tblDrag = null;
      var tables = document.querySelectorAll('table.pe-tbl-dragging');
      for (var i = 0; i < tables.length; i++) tables[i].classList.remove('pe-tbl-dragging');
      _tblRepaintAll();
    });
    document.addEventListener('mousedown', function (e) {
      if (!_tblSel) return;
      if (e.target && e.target.closest && e.target.closest('.pe-tblgrid')) return;
      _tblSel = null;
      _tblRepaintAll();
    }, true);
    document.addEventListener('keydown', function (e) {
      if (e.key !== 'Escape' || !_tblSel) return;
      _tblSel = null;
      _tblRepaintAll();
    });
  }

  function _tblRepaintAll() {
    var grids = document.querySelectorAll('.pe-tblgrid');
    for (var i = 0; i < grids.length; i++) {
      if (typeof grids[i].__peRepaint === 'function') grids[i].__peRepaint();
    }
  }

  /* Delete buttons over a band that HAS content arm first rather than
   * raising a confirm() — Alex ruled browser popups out of this editor
   * (V3.647). Armed state auto-disarms after 4s or on any other click. */
  function _tblArmDelete(btn, doDelete, markFn) {
    if (btn.dataset.armed === '1') {
      clearTimeout(btn.__peArmTimer);
      doDelete();
      return;
    }
    var host = btn.closest('.pe-tblgrid');
    if (host) {
      var armed = host.querySelectorAll('.pe-tbl-linebtn[data-armed="1"]');
      for (var i = 0; i < armed.length; i++) _tblDisarm(armed[i]);
    }
    btn.dataset.armed = '1';
    btn.__peLabel = btn.textContent;
    btn.textContent = '✓';
    btn.title = 'Click again to delete — this ' + (btn.dataset.axis === 'r' ? 'row' : 'column') +
      ' has text in it';
    markFn(true);
    btn.__peArmTimer = setTimeout(function () { _tblDisarm(btn); markFn(false); }, 4000);
  }
  function _tblDisarm(btn) {
    clearTimeout(btn.__peArmTimer);
    if (btn.dataset.armed !== '1') return;
    btn.dataset.armed = '0';
    if (btn.__peLabel) btn.textContent = btn.__peLabel;
    btn.title = btn.dataset.baseTitle || '';
    var host = btn.closest('.pe-tblgrid');
    if (!host) return;
    var doomed = host.querySelectorAll('.pe-band-doomed');
    for (var i = 0; i < doomed.length; i++) doomed[i].classList.remove('pe-band-doomed');
  }

  /* Build the editable grid: a gutter row + gutter column carry the
   * +/- controls. They are real table cells, so they inherit the
   * browser's own column geometry — a `+` pinned to a head cell's left
   * edge sits exactly ON the border, with no measurement code and no
   * drift when a merge changes the column widths. */
  function _mountTableGrid(host, blk, attrs, tab) {
    var Y = window.PaperEditor.getY();
    var cells = attrs.get('cells');
    if (!(cells instanceof Y.Map)) return null;
    var rows = attrs.get('rows') || 0;
    var cols = attrs.get('cols') || 0;
    var PL = window.PaperLayout || {};
    var merges = PL.parseTableMerges ? PL.parseTableMerges(attrs.get('merges_json')) : {};
    var cover = PL.tableCoverMap
      ? PL.tableCoverMap(merges, rows, cols)
      : { anchors: {}, skip: {}, cont: {} };
    var headerRow = attrs.get('header_row') !== false;
    var style = _tblReadStyle(attrs);
    var cellStyles = _tblReadCellStyles(attrs);
    var rowExtras = PL.parseTableRowExtras
      ? PL.parseTableRowExtras(attrs.get('row_heights_json')) : {};
    var FILLS = PL.TABLE_FILLS || {};
    /* pt -> px at the CSS 96dpi reference, which is the same conversion the
     * mm column widths already use. Extra space goes on as padding under
     * the row, mirroring what \\[dim] does in the PDF: space after the row,
     * not a taller cell box. */
    var PT_PX = 96 / 72;

    _tblEnsureDocHandlers();

    var wrap = document.createElement('div');
    wrap.className = 'pe-tblgrid';
    var scroller = document.createElement('div');
    scroller.className = 'pe-tblgrid-scroll';
    var table = document.createElement('table');
    table.className = 'pe-grid-table pe-grid-table-edit pe-tbl-rules-' + style.rules +
      ' pe-tbl-dens-' + style.density + (style.zebra ? ' pe-tbl-zebra' : '') +
      (style.wrap ? ' pe-tbl-wrap' : '');
    /* The editor shows the styling as the PDF will read it — a table you
     * cannot see the formatting of is a table you style twice. */
    table.style.fontSize = (style.sizeCss * 12).toFixed(1) + 'px';

    /* V3.652 — a colgroup, always. `table-layout: fixed` (which is what
     * makes text WRAP instead of blowing the column out) reads its widths
     * from the first row or the colgroup, and the first row is exactly
     * where a merge can hide a column. The leading <col> is the gutter.
     * The shares come from the same helper the .tex export uses, so what
     * you drag here is what compiles. */
    var dragWidths = PL.parseTableWidths
      ? PL.parseTableWidths(attrs.get('widths_json'), cols) : null;
    var shares = (style.wrap && PL.tableColShares)
      ? PL.tableColShares(dragWidths, cols)
      : (dragWidths || []);
    var cgroup = document.createElement('colgroup');
    var gcol = document.createElement('col');
    gcol.className = 'pe-tbl-gutcol';
    cgroup.appendChild(gcol);
    for (var cw = 0; cw < cols; cw++) {
      var colEl = document.createElement('col');
      var wspec = shares[cw];
      if (wspec && wspec.mode === 'frac') colEl.style.width = (wspec.v * 100).toFixed(2) + '%';
      else if (wspec && wspec.mode === 'mm') colEl.style.width = (wspec.v * 96 / 25.4).toFixed(0) + 'px';
      cgroup.appendChild(colEl);
    }
    table.appendChild(cgroup);

    function bandHasText(axis, idx) {
      for (var i = 0; i < (axis === 'r' ? cols : rows); i++) {
        var k = (axis === 'r') ? (idx + '-' + i) : (i + '-' + idx);
        var t = cells.get(k);
        if (t && t.toString && t.toString().trim()) return true;
      }
      return false;
    }
    /* on: true = armed (this band is about to go), 'peek' = merely hovered
     * (so you can see WHICH band the − belongs to before pressing it),
     * false = clear. An armed band must not be downgraded by a stray
     * mouseleave, so 'peek' never clears an armed one. */
    function markBand(axis, idx, on) {
      var sel = (axis === 'r') ? 'td[data-r="' + idx + '"]' : 'td[data-c="' + idx + '"]';
      var nodes = [];
      var tds = table.querySelectorAll(sel);
      for (var i = 0; i < tds.length; i++) nodes.push(tds[i]);
      var head = table.querySelector(axis === 'r'
        ? 'td.pe-tbl-rowhead[data-rh="' + idx + '"]'
        : 'td.pe-tbl-colhead[data-ch="' + idx + '"]');
      if (head) nodes.push(head);
      nodes.forEach(function (n) {
        if (on === 'peek') { n.classList.add('pe-band-peek'); return; }
        n.classList.remove('pe-band-peek');
        n.classList.toggle('pe-band-doomed', !!on);
      });
    }

    /* ── Gutter row: one head per column ─────────────────────────── */
    var gutTr = document.createElement('tr');
    gutTr.className = 'pe-tbl-gutrow';
    var corner = document.createElement('td');
    corner.className = 'pe-tbl-corner';
    gutTr.appendChild(corner);
    for (var gc = 0; gc < cols; gc++) {
      (function (ci) {
        var th = document.createElement('td');
        th.className = 'pe-tbl-colhead';
        th.dataset.ch = String(ci);
        th.addEventListener('mousedown', function (ev) {
          if (ev.target !== th) return;                 // a gutter button was hit
          ev.preventDefault();
          _tblSel = { blockId: tab.blockId, r0: 0, c0: ci, r1: Math.max(0, rows - 1), c1: ci };
          repaint();
        });
        gutTr.appendChild(th);
      })(gc);
    }
    table.appendChild(gutTr);

    /* ── Body rows, each prefixed by its row head ────────────────── */
    for (var r = 0; r < rows; r++) {
      var tr = document.createElement('tr');
      if (headerRow && r === 0) tr.classList.add('pe-tbl-headerrow');
      /* First/last BODY row — the gutter row is tr:first-child, so CSS
       * cannot find them on its own. booktabs needs both. */
      if (r === 0) tr.classList.add('pe-tbl-r-first');
      if (r === rows - 1) tr.classList.add('pe-tbl-r-last');
      if (style.rule_after.indexOf(r) !== -1) tr.classList.add('pe-tbl-ruled');
      if (style.zebra && r % 2 === 1) tr.classList.add('pe-tbl-zebrarow');
      if (rowExtras[r] > 0) {
        tr.classList.add('pe-tbl-rowext');
        tr.dataset.extraPt = String(rowExtras[r]);
        tr.style.setProperty('--pe-row-extra', (rowExtras[r] * PT_PX).toFixed(1) + 'px');
      }
      (function (ri) {
        var rh = document.createElement('td');
        rh.className = 'pe-tbl-rowhead';
        rh.dataset.rh = String(ri);
        /* Clicking the head selects the whole band — which is what makes
         * "bold this row" / "rule under here" one gesture instead of a
         * drag the width of the table. */
        rh.addEventListener('mousedown', function (ev) {
          if (ev.target !== rh) return;                 // a gutter button was hit
          ev.preventDefault();
          _tblSel = { blockId: tab.blockId, r0: ri, c0: 0, r1: ri, c1: Math.max(0, cols - 1) };
          repaint();
        });
        tr.appendChild(rh);
      })(r);

      for (var c2 = 0; c2 < cols; c2++) {
        var key = r + '-' + c2;
        if (cover.skip[key] || cover.cont[key] != null) continue;   // merged away
        var td = document.createElement('td');
        td.dataset.r = String(r);
        td.dataset.c = String(c2);
        var anch = cover.anchors[key];
        if (anch) {
          if (anch.cs > 1) td.colSpan = anch.cs;
          if (anch.rs > 1) td.rowSpan = anch.rs;
          td.classList.add('pe-cell-merged');
        }
        /* V3.651 — per-cell styling. Column alignment is the default; a
         * per-cell `al` overrides it (that is exactly what it compiles to:
         * a \multicolumn{1}{c}{…} over one column). */
        var cst = cellStyles[key] || {};
        var colAlign = (attrs.get('align') || '').charAt(c2);
        var eff = cst.al || (colAlign === 'c' || colAlign === 'r' ? colAlign : 'l');
        td.style.textAlign = eff === 'c' ? 'center' : eff === 'r' ? 'right' : 'left';
        if (cst.b) td.classList.add('pe-cell-b');
        if (cst.i) td.classList.add('pe-cell-i');
        if (cst.bg && FILLS[cst.bg]) {
          td.classList.add('pe-cell-filled');
          td.style.background = FILLS[cst.bg].css;
        }
        (function (rr, cc) {
          /* Anchor on mousedown but do NOT preventDefault — the caret
           * still lands where you clicked. The drag only becomes a CELL
           * drag once the pointer reaches a different cell. */
          td.addEventListener('mousedown', function (ev) {
            if (ev.button !== 0) return;
            if (ev.shiftKey && _tblSel && _tblSel.blockId === tab.blockId) {
              ev.preventDefault();
              _tblSel.r1 = rr; _tblSel.c1 = cc;
            } else {
              _tblSel = { blockId: tab.blockId, r0: rr, c0: cc, r1: rr, c1: cc };
              _tblDrag = { blockId: tab.blockId };
            }
            repaint();
          });
          td.addEventListener('mouseenter', function () {
            if (!_tblDrag || _tblDrag.blockId !== tab.blockId) return;
            if (!_tblSel) return;
            if (_tblSel.r1 === rr && _tblSel.c1 === cc) return;
            _tblSel.r1 = rr; _tblSel.c1 = cc;
            /* Stop the browser painting a cross-cell TEXT selection on
             * top of the cell selection. */
            table.classList.add('pe-tbl-dragging');
            var s = window.getSelection && window.getSelection();
            if (s && s.removeAllRanges) s.removeAllRanges();
            repaint();
          });
        })(r, c2);

        var cellY = cells.get(key);
        if (!(cellY instanceof Y.Text)) {
          cellY = new Y.Text('');
          (function (k, v) {
            blk.doc.transact(function () { cells.set(k, v); }, 'init-cell');
          })(key, cellY);
        }
        var cellEl = document.createElement('div');
        cellEl.className = 'pe-grid-cell';
        window.PaperEditor.bindYTextToContentEditable(cellY, cellEl, {
          readOnly: !_toolEditable(),   // V3.741 — was hardcoded false; honours the checkout lock
          renderHtml: window.PaperEditor.renderParagraphHtml,
        });
        td.appendChild(cellEl);
        tr.appendChild(td);
      }
      table.appendChild(tr);
    }

    scroller.appendChild(table);
    wrap.appendChild(scroller);

    /* ── V3.652 — controls that belong to the LINE, not to a cell ─────
     *
     * Alex: *"the +- should only pop up when i mouse over the line. the +-
     * should be per line not per cell. in the middle of the +- shuld be a
     * ||| drag indicator."*
     *
     * So each grid line — every column border and every row border,
     * including the two outer edges — gets one invisible hit strip running
     * its full length, and hovering ANYWHERE along it reveals a single
     * cluster: ＋ insert a line here · ||| drag to resize · − delete the
     * band this line sits against.
     *
     * The strips are positioned from measured geometry rather than pinned
     * to a cell (V3.650's approach), because a hit zone has to span the
     * whole line, and because dragging a width is pixel maths anyway. The
     * measurements come off the GUTTER heads: there is exactly one per row
     * and one per column and they are never merged, so they are the only
     * cells whose edges are reliably the grid's lines.
     *
     * Only COLUMN lines carry the ||| grip. Row height in LaTeX is
     * \arraystretch — a property of the whole table, not of one row (it is
     * the "rows:" control in the style bar) — so a per-row drag would be a
     * handle for something that cannot be stored. */
    var lines = document.createElement('div');
    lines.className = 'pe-tbl-lines';
    wrap.appendChild(lines);

    function headRect(sel) {
      var el = table.querySelector(sel);
      return el ? el.getBoundingClientRect() : null;
    }
    /* x of column border i (0…cols), y of row border r (0…rows), relative
     * to the overlay. Returns null before the grid is laid out. */
    function colBorderX(i, base) {
      var r = headRect('td.pe-tbl-colhead[data-ch="' + Math.min(i, cols - 1) + '"]');
      if (!r) return null;
      return (i < cols ? r.left : r.right) - base.left;
    }
    function rowBorderY(i, base) {
      var r = headRect('td.pe-tbl-rowhead[data-rh="' + Math.min(i, rows - 1) + '"]');
      if (!r) return null;
      return (i < rows ? r.top : r.bottom) - base.top;
    }

    function mkLineBtn(cls, label, title, onClick) {
      var b = document.createElement('button');
      b.type = 'button';
      b.className = 'pe-tbl-linebtn ' + cls;
      b.textContent = label;
      b.title = title;
      b.dataset.baseTitle = title;
      b.tabIndex = -1;
      b.addEventListener('mousedown', function (ev) { ev.stopPropagation(); });
      b.addEventListener('click', function (ev) { ev.stopPropagation(); onClick(b); });
      return b;
    }

    /* The band a line's − would remove: the one after it, except on the
     * closing edge, where the only neighbour is the one before. */
    function bandFor(axis, i) {
      var n = axis === 'c' ? cols : rows;
      return i < n ? i : n - 1;
    }

    function buildLine(axis, i) {
      var n = axis === 'c' ? cols : rows;
      var strip = document.createElement('div');
      strip.className = 'pe-tbl-line pe-tbl-line-' + axis;
      strip.dataset.axis = axis;
      strip.dataset.i = String(i);
      var cluster = document.createElement('div');
      cluster.className = 'pe-tbl-lineclu pe-tbl-lineclu-' + axis;

      cluster.appendChild(mkLineBtn('pe-tbl-ins', '＋',
        i < n ? (axis === 'c' ? 'Insert a column here' : 'Insert a row here')
              : (axis === 'c' ? 'Add a column at the end' : 'Add a row at the end'),
        function () { _tblStructOp(blk, attrs, axis, 'ins', i); }));

      /* ||| — sits BETWEEN ＋ and −, on both axes, wherever there is a
       * band before the line to resize. A column line sizes the column on
       * its left; a row line adds height to the row above it. Line 0 has
       * nothing before it, so it gets no grip. */
      if (i > 0) {
        var grip = document.createElement('span');
        grip.className = 'pe-tbl-grip';
        grip.textContent = '|||';
        grip.title = axis === 'c'
          ? 'Drag to set the width of the column on the left'
          : 'Drag to add height to the row above';
        grip.addEventListener('mousedown', function (ev) {
          ev.preventDefault();
          ev.stopPropagation();
          if (axis === 'c') startColDrag(i - 1, ev.clientX);
          else startRowDrag(i - 1, ev.clientY);
        });
        cluster.appendChild(grip);
      }

      var band = bandFor(axis, i);
      if (n > 1) {
        var del = mkLineBtn('pe-tbl-del', '−',
          (axis === 'c' ? 'Delete column ' : 'Delete row ') + (band + 1),
          function (btn) {
            var run = function () { _tblStructOp(blk, attrs, axis, 'del', band); };
            if (!bandHasText(axis, band)) { run(); return; }
            _tblArmDelete(btn, run, function (on) { markBand(axis, band, on); });
          });
        del.dataset.axis = axis;
        cluster.appendChild(del);
      }
      strip.appendChild(cluster);
      strip.dataset.band = String(band);
      lines.appendChild(strip);
      return strip;
    }

    var colLines = [], rowLines = [];
    for (var li = 0; li <= cols; li++) colLines.push(buildLine('c', li));
    for (var lj = 0; lj <= rows; lj++) rowLines.push(buildLine('r', lj));

    /* ── Which line is the pointer on? ────────────────────────────────
     *
     * NOT CSS :hover. Row strips and column strips cross at every
     * intersection, so a plain hover lights up two lines at once — and
     * with the cluster now centred on its line (V3.653), a column line's
     * midpoint often lands right on a row line, which is exactly where
     * two clusters would both appear. Worse, strips that take pointer
     * events swallow clicks: every cell edge had a 5px dead band where a
     * click hit the strip instead of the cell.
     *
     * So the strips are inert, and one mousemove on the grid picks the
     * NEAREST line and activates only that one. A tie at an intersection
     * goes to the column, arbitrarily but consistently. */
    var activeLine = null;
    function setActiveLine(strip) {
      if (strip === activeLine) return;
      if (activeLine) {
        activeLine.classList.remove('is-active');
        markBand(activeLine.dataset.axis, +activeLine.dataset.band, false);
      }
      activeLine = strip;
      if (strip) {
        strip.classList.add('is-active');
        markBand(strip.dataset.axis, +strip.dataset.band, 'peek');
      }
    }
    var LINE_GRAB = 7;                    // px from a line that counts as "on" it
    function pickLine(ev) {
      if (_tblColDrag) return;             // never re-arbitrate mid-drag
      /* Once a cluster is up, the pointer moving ONTO it must not count as
       * leaving the line — the buttons stick out past the 11px strip. */
      if (activeLine) {
        var cb = activeLine.querySelector('.pe-tbl-lineclu').getBoundingClientRect();
        if (ev.clientX >= cb.left - 2 && ev.clientX <= cb.right + 2 &&
            ev.clientY >= cb.top - 2 && ev.clientY <= cb.bottom + 2) return;
      }
      var base = lines.getBoundingClientRect();
      if (!base.width) return;
      var px = ev.clientX - base.left, py = ev.clientY - base.top;
      var x0 = colBorderX(0, base), x1 = colBorderX(cols, base);
      var y0 = rowBorderY(0, base), y1 = rowBorderY(rows, base);
      if (x0 == null || y0 == null) return;
      var best = null, bestD = LINE_GRAB;
      if (py >= y0 - 2 && py <= y1 + 2) {
        colLines.forEach(function (strip, i) {
          var d = Math.abs(px - colBorderX(i, base));
          if (d < bestD) { bestD = d; best = strip; }
        });
      }
      if (px >= x0 - 2 && px <= x1 + 2) {
        rowLines.forEach(function (strip, i) {
          var d = Math.abs(py - rowBorderY(i, base));
          if (d < bestD) { bestD = d; best = strip; }
        });
      }
      setActiveLine(best);
    }
    wrap.addEventListener('mousemove', pickLine);
    wrap.addEventListener('mouseleave', function () {
      if (_tblColDrag) return;
      setActiveLine(null);
    });
    wrap.__peActiveLine = function () { return activeLine; };
    wrap.__pePickLine = pickLine;

    /* Geometry is re-read rather than cached: a wrapped cell changes row
     * heights as you type, and the panel itself resizes. */
    function layoutLines() {
      var base = lines.getBoundingClientRect();
      if (!base.width) return;
      var x0 = colBorderX(0, base), x1 = colBorderX(cols, base);
      var y0 = rowBorderY(0, base), y1 = rowBorderY(rows, base);
      if (x0 == null || y0 == null) return;
      colLines.forEach(function (strip, i) {
        var x = colBorderX(i, base);
        strip.style.left = (x - 5) + 'px';
        strip.style.top = y0 + 'px';
        strip.style.height = Math.max(8, y1 - y0) + 'px';
      });
      rowLines.forEach(function (strip, i) {
        var y = rowBorderY(i, base);
        strip.style.top = (y - 5) + 'px';
        strip.style.left = x0 + 'px';
        strip.style.width = Math.max(8, x1 - x0) + 'px';
      });
    }
    wrap.__peLayoutLines = layoutLines;
    if (typeof ResizeObserver === 'function') {
      var ro = new ResizeObserver(function () { layoutLines(); });
      ro.observe(table);
      wrap.__peRO = ro;
    }

    /* Drag a column border → a fraction of the table's width, which is the
     * same `widths_json` the width dropdown writes and the same thing the
     * export turns into p{…\linewidth}. Live-previewed on the colgroup so
     * the drag is visible before it is committed. */
    function startColDrag(col, startX) {
      var tRect = table.getBoundingClientRect();
      var gut = (headRect('td.pe-tbl-rowhead[data-rh="0"]') || { width: 0 }).width;
      var contentW = Math.max(1, tRect.width - gut);
      var cellRect = headRect('td.pe-tbl-colhead[data-ch="' + col + '"]');
      if (!cellRect) return;
      var startW = cellRect.width;
      var moved = false;
      _tblColDrag = true;
      table.classList.add('pe-tbl-colsizing');
      function onMove(ev) {
        moved = true;
        var frac = (startW + (ev.clientX - startX)) / contentW;
        frac = Math.max(0.05, Math.min(0.9, frac));
        applyPreviewWidth(col, frac);
      }
      function onUp(ev) {
        document.removeEventListener('mousemove', onMove);
        document.removeEventListener('mouseup', onUp);
        _tblColDrag = false;
        table.classList.remove('pe-tbl-colsizing');
        if (!moved) return;
        var frac = (startW + (ev.clientX - startX)) / contentW;
        frac = Math.max(0.05, Math.min(0.9, frac));
        writeWidthFrac(col, Math.round(frac * 1000) / 1000);
      }
      document.addEventListener('mousemove', onMove);
      document.addEventListener('mouseup', onUp);
    }
    /* Row height. `\arraystretch` is per-TABLE, so what a row line can
     * actually store is \\[dim] — extra space after that one row. Points,
     * because that is what the .tex needs. */
    function startRowDrag(row, startY) {
      /* A row that is entirely covered by a rowspan has no td[data-r] of
       * its own, so there is nothing to resize — bail rather than guess. */
      var firstCell = table.querySelector('td[data-r="' + row + '"]');
      var target = firstCell && firstCell.parentElement;
      if (!target) return;
      var startPt = rowExtras[row] > 0 ? rowExtras[row] : 0;
      var maxPt = PL.TABLE_ROW_EXTRA_MAX_PT || 60;
      var moved = false;
      _tblColDrag = true;                        // same "don't re-arbitrate" latch
      table.classList.add('pe-tbl-rowsizing');
      function ptAt(ev) {
        var pt = startPt + (ev.clientY - startY) / PT_PX;
        return Math.max(0, Math.min(maxPt, Math.round(pt * 10) / 10));
      }
      function onMove(ev) {
        moved = true;
        var pt = ptAt(ev);
        target.classList.toggle('pe-tbl-rowext', pt > 0);
        target.style.setProperty('--pe-row-extra', (pt * PT_PX).toFixed(1) + 'px');
        layoutLines();
      }
      function onUp(ev) {
        document.removeEventListener('mousemove', onMove);
        document.removeEventListener('mouseup', onUp);
        _tblColDrag = false;
        table.classList.remove('pe-tbl-rowsizing');
        if (!moved) return;
        writeRowExtra(row, ptAt(ev));
      }
      document.addEventListener('mousemove', onMove);
      document.addEventListener('mouseup', onUp);
    }
    function writeRowExtra(row, pt) {
      var next = {};
      Object.keys(rowExtras).forEach(function (k) { next[k] = rowExtras[k]; });
      if (pt > 0) next[row] = pt; else delete next[row];
      blk.doc.transact(function () {
        if (Object.keys(next).length) attrs.set('row_heights_json', JSON.stringify(next));
        else attrs.delete('row_heights_json');
      }, 'tab-row-drag');
    }

    function applyPreviewWidth(col, frac) {
      var cg = table.querySelector('colgroup');
      if (!cg) return;
      var el = cg.children[col + 1];              // +1 for the gutter column
      if (el) el.style.width = (frac * 100).toFixed(2) + '%';
      layoutLines();
    }
    function writeWidthFrac(col, frac) {
      var arr = (PL.parseTableWidths ? PL.parseTableWidths(attrs.get('widths_json'), cols) : []);
      arr[col] = { mode: 'frac', v: frac };
      var any = arr.some(function (x) { return x && x.mode !== 'auto'; });
      blk.doc.transact(function () {
        if (any) attrs.set('widths_json', JSON.stringify(arr));
        else attrs.delete('widths_json');
      }, 'tab-col-drag');
    }

    /* ── Floating action bar: only what applies, only when it does ── */
    var actbar = document.createElement('div');
    actbar.className = 'pe-tbl-actbar';
    actbar.hidden = true;
    wrap.appendChild(actbar);

    function currentRect() {
      var sel = (_tblSel && _tblSel.blockId === tab.blockId) ? _tblSel : null;
      if (!sel) return null;
      return _tblExpandRect(_tblRect(sel), cover);
    }
    function anchorsIn(rect) {
      return Object.keys(cover.anchors).filter(function (k) {
        var p = k.split('-');
        var ar = +p[0], ac = +p[1];
        return ar >= rect.r0 && ar <= rect.r1 && ac >= rect.c0 && ac <= rect.c1;
      });
    }
    function writeMerges(next) {
      blk.doc.transact(function () {
        if (Object.keys(next).length) attrs.set('merges_json', JSON.stringify(next));
        else attrs.delete('merges_json');
      }, 'tab-merges');
    }

    function repaint() {
      var tds = table.querySelectorAll('td.pe-cell-selected');
      for (var i = 0; i < tds.length; i++) tds[i].classList.remove('pe-cell-selected');
      actbar.hidden = true;
      actbar.innerHTML = '';
      var rect = currentRect();
      if (!rect) return;
      var picked = [];
      var body = table.querySelectorAll('td[data-r]');
      for (var j = 0; j < body.length; j++) {
        var tr2 = +body[j].dataset.r, tc = +body[j].dataset.c;
        if (tr2 >= rect.r0 && tr2 <= rect.r1 && tc >= rect.c0 && tc <= rect.c1) {
          body[j].classList.add('pe-cell-selected');
          picked.push(body[j]);
        }
      }
      if (!picked.length) return;

      var multi = (rect.r1 - rect.r0 > 0) || (rect.c1 - rect.c0 > 0);
      var inside = anchorsIn(rect);
      /* Clicking a merged cell expands the rect to the whole merge, which
       * would otherwise offer to "merge" it with itself. When the rect IS
       * exactly one existing merge, the only sane action is Unmerge. */
      var exact = inside.length === 1 && (function () {
        var p = inside[0].split('-');
        var ar = +p[0], ac = +p[1];
        var a = cover.anchors[inside[0]];
        return ar === rect.r0 && ac === rect.c0 &&
               ar + a.rs - 1 === rect.r1 && ac + a.cs - 1 === rect.c1;
      })();
      if (multi && !exact) {
        var mBtn = document.createElement('button');
        mBtn.type = 'button';
        mBtn.className = 'pe-tbl-actbtn';
        mBtn.textContent = '⧉ Merge ' + (rect.r1 - rect.r0 + 1) + '×' + (rect.c1 - rect.c0 + 1);
        mBtn.title = 'Merge the selected cells into one';
        mBtn.addEventListener('click', function () {
          var next = {};
          Object.keys(merges).forEach(function (k) {
            if (inside.indexOf(k) === -1) next[k] = merges[k];   // absorb the ones inside
          });
          next[rect.r0 + '-' + rect.c0] = {
            rs: rect.r1 - rect.r0 + 1, cs: rect.c1 - rect.c0 + 1,
          };
          _tblSel = null;
          writeMerges(next);
        });
        actbar.appendChild(mBtn);
      }
      if (inside.length) {
        var uBtn = document.createElement('button');
        uBtn.type = 'button';
        uBtn.className = 'pe-tbl-actbtn';
        uBtn.textContent = inside.length > 1 ? ('⤫ Unmerge ' + inside.length) : '⤫ Unmerge';
        uBtn.title = 'Split the merged cell back into its cells (their text is kept)';
        uBtn.addEventListener('click', function () {
          var next = {};
          Object.keys(merges).forEach(function (k) {
            if (inside.indexOf(k) === -1) next[k] = merges[k];
          });
          _tblSel = null;
          writeMerges(next);
        });
        actbar.appendChild(uBtn);
      }
      /* ── V3.651 — styling for the selected cells ──────────────────
       * The selection was built for merge; formatting is the other thing
       * you want a block of cells for, so it rides the same gesture
       * rather than growing a second surface. */
      var keysIn = [];
      for (var kr = rect.r0; kr <= rect.r1; kr++) {
        for (var kc = rect.c0; kc <= rect.c1; kc++) {
          var kk = kr + '-' + kc;
          if (cover.skip[kk] || cover.cont[kk] != null) continue;
          keysIn.push(kk);
        }
      }
      function allHave(fn) {
        return keysIn.length > 0 && keysIn.every(function (k) { return fn(cellStyles[k] || {}); });
      }
      function patchCells(mutate) {
        var next = {};
        Object.keys(cellStyles).forEach(function (k) { next[k] = Object.assign({}, cellStyles[k]); });
        keysIn.forEach(function (k) {
          var st = next[k] || {};
          mutate(st);
          if (Object.keys(st).length) next[k] = st; else delete next[k];
        });
        _tblWriteCellStyles(blk, attrs, next);
      }
      function styleBtn(label, title, active, onClick) {
        var b = document.createElement('button');
        b.type = 'button';
        b.className = 'pe-tbl-actbtn pe-tbl-actbtn-style' + (active ? ' active' : '');
        b.textContent = label;
        b.title = title;
        b.addEventListener('mousedown', function (ev) { ev.preventDefault(); });  // keep the selection
        b.addEventListener('click', onClick);
        actbar.appendChild(b);
      }

      var allBold = allHave(function (st) { return !!st.b; });
      styleBtn('B', allBold ? 'Remove bold' : 'Bold these cells', allBold, function () {
        patchCells(function (st) { if (allBold) delete st.b; else st.b = 1; });
      });
      var allIt = allHave(function (st) { return !!st.i; });
      styleBtn('I', allIt ? 'Remove italic' : 'Italicise these cells', allIt, function () {
        patchCells(function (st) { if (allIt) delete st.i; else st.i = 1; });
      });
      ['l', 'c', 'r'].forEach(function (a) {
        var on = allHave(function (st) { return st.al === a; });
        styleBtn(a === 'l' ? '⇤' : a === 'c' ? '↔' : '⇥',
          'Align ' + (a === 'l' ? 'left' : a === 'c' ? 'centre' : 'right') +
          ' (overrides the column)', on, function () {
            patchCells(function (st) { if (on) delete st.al; else st.al = a; });
          });
      });
      Object.keys(FILLS).forEach(function (name) {
        var on = allHave(function (st) { return st.bg === name; });
        var b = document.createElement('button');
        b.type = 'button';
        b.className = 'pe-tbl-actbtn pe-tbl-fillbtn' + (on ? ' active' : '');
        b.style.background = FILLS[name].css;
        b.title = (on ? 'Clear the ' : 'Shade these cells ') + FILLS[name].label.toLowerCase();
        b.addEventListener('mousedown', function (ev) { ev.preventDefault(); });
        b.addEventListener('click', function () {
          patchCells(function (st) { if (on) delete st.bg; else st.bg = name; });
        });
        actbar.appendChild(b);
      });
      var anyFill = keysIn.some(function (k) { return (cellStyles[k] || {}).bg; });
      if (anyFill) {
        styleBtn('⌫', 'Clear the shading', false, function () {
          patchCells(function (st) { delete st.bg; });
        });
      }
      /* A whole-row selection also gets the rule that goes under it —
       * the one piece of table formatting that belongs to a row, not a
       * cell, and the reason `rule_after` lives on the table style. */
      /* …except on the last row when a closing rule is already coming —
       * the export drops it there (it would double the \bottomrule), so
       * offering the button would promise something that never appears. */
      var lastRowClosed = rect.r1 === rows - 1 &&
        (style.rules === 'booktabs' || style.rules === 'grid');
      if (rect.c0 === 0 && rect.c1 === cols - 1 && !lastRowClosed) {
        var hasRule = style.rule_after.indexOf(rect.r1) !== -1;
        styleBtn(hasRule ? '⌦ rule' : '─ rule',
          hasRule ? 'Remove the line under this row' : 'Draw a line under this row',
          hasRule, function () {
            var next = style.rule_after.filter(function (x) { return x !== rect.r1; });
            if (!hasRule) next.push(rect.r1);
            next.sort(function (a, b) { return a - b; });
            blk.doc.transact(function () {
              _tblStoreStyle(attrs, Object.assign({}, style, { rule_after: next }));
            }, 'tab-rule-after');
          });
      }

      if (!actbar.children.length) return;

      /* Park the bar just above the selection's top-left, clamped into
       * the grid so it never hangs off the panel. */
      actbar.hidden = false;
      var wrapBox = wrap.getBoundingClientRect();
      var firstBox = picked[0].getBoundingClientRect();
      if (!wrapBox.width) return;                 // not laid out yet
      var top = firstBox.top - wrapBox.top - 26;
      var left = firstBox.left - wrapBox.left;
      if (top < 0) top = firstBox.bottom - wrapBox.top + 4;
      if (left < 0) left = 0;
      /* The bar carries the styling buttons now, so it is wide enough to
       * run off the panel from a right-hand column. */
      var maxLeft = wrapBox.width - actbar.offsetWidth - 2;
      if (maxLeft < 0) maxLeft = 0;
      if (left > maxLeft) left = maxLeft;
      actbar.style.top = Math.round(top) + 'px';
      actbar.style.left = Math.round(left) + 'px';
    }

    wrap.__peRepaint = repaint;
    host.appendChild(wrap);

    var hint = document.createElement('div');
    hint.className = 'pe-tblgrid-hint';
    hint.textContent = 'Hover any grid line for ＋ add · ||| drag to resize · − remove · ' +
      'drag across cells to merge or format them';
    host.appendChild(hint);

    /* Paint now so a rebuild (a format click restyles and re-renders)
     * never drops the action bar for a frame, AND again next frame:
     * geometry is only real once the grid is in the document, and the
     * FIRST build runs before _buildTableRow appends it. */
    repaint();
    layoutLines();
    if (typeof requestAnimationFrame === 'function') {
      requestAnimationFrame(function () { repaint(); layoutLines(); });
    }
    return wrap;
  }

  /* Re-render this editor body when the table's SHAPE changes, without
   * going through the parked whole-list refresh. Shallow observe: a
   * keystroke mutates a Y.Text inside attrs.cells and never reaches
   * here, so the caret is safe (V3.647). */
  function _watchTableAttrs(rootEl, blk, attrs, tab) {
    var prev = _tblObs[tab.blockId];
    if (prev) { try { prev.attrs.unobserve(prev.handler); } catch (e) { /* gone */ } }
    var handler = function (ev) {
      if (_tblRebuilding) return;
      if (!document.contains(rootEl)) {
        try { attrs.unobserve(handler); } catch (e) { /* gone */ }
        if (_tblObs[tab.blockId] && _tblObs[tab.blockId].handler === handler) {
          delete _tblObs[tab.blockId];
        }
        return;
      }
      var structural = true;
      var keys = ev && ev.keysChanged;
      if (keys && typeof keys.forEach === 'function') {
        structural = false;
        keys.forEach(function (k) { if (TBL_STRUCT_KEYS[k]) structural = true; });
      }
      if (!structural) return;
      _tblRebuilding = true;
      try { _buildTableEditorBody(rootEl, tab); } finally { _tblRebuilding = false; }
    };
    attrs.observe(handler);
    _tblObs[tab.blockId] = { attrs: attrs, handler: handler, rootEl: rootEl };
  }

  /* Full panel-side table editor body: styling toolbar (booktabs /
   * header_row / longtable), per-column align + width, the grid itself
   * (per-cell Y.Text contenteditables), caption and notes. */
  function _buildTableEditorBody(rootEl, tab) {
    var blk = _findTableBlock(tab.blockId);
    if (!blk) {
      rootEl.innerHTML = '<div class="pe-equations-empty">Table block not found.</div>';
      return;
    }
    var Y = window.PaperEditor.getY();
    var attrs = blk.get('attrs');
    if (!attrs) return;
    rootEl.innerHTML = '';

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
    /* ── V3.651 — table-level styling ────────────────────────────────
     * `booktabs` used to be a lone checkbox, which is a strange way to
     * ask "what should the lines look like" — the three real answers are
     * journal rules, a full grid, or nothing. The checkbox is still
     * written underneath (see _tblStoreStyle) so everything downstream
     * that predates this release keeps working. */
    var tstyle = _tblReadStyle(attrs);
    function styleGroup(labelText, title) {
      var g = document.createElement('span');
      g.className = 'pe-tbl-stylegrp';
      g.title = title || '';
      var l = document.createElement('span');
      l.className = 'pe-table-style-label';
      l.textContent = labelText;
      g.appendChild(l);
      styleBar.appendChild(g);
      return g;
    }
    function setStyle(patch) {
      blk.doc.transact(function () {
        _tblStoreStyle(attrs, Object.assign({}, tstyle, patch));
      }, 'tab-style');
    }
    var rulesGrp = styleGroup('lines:',
      'booktabs = the horizontal-rules-only look most journals require; ' +
      'grid = every cell boxed; none = no lines at all.');
    [['booktabs', 'booktabs'], ['grid', 'grid'], ['none', 'none']].forEach(function (pair) {
      var b = document.createElement('button');
      b.type = 'button';
      b.className = 'pe-table-align-btn' + (tstyle.rules === pair[0] ? ' active' : '');
      b.textContent = pair[1];
      b.addEventListener('click', function () { setStyle({ rules: pair[0] }); });
      rulesGrp.appendChild(b);
    });

    var textGrp = styleGroup('text:', 'Font size of the whole table.');
    var sizeSel = document.createElement('select');
    sizeSel.className = 'pe-table-width-sel pe-tbl-style-sel';
    [['normal', 'normal'], ['small', 'small'], ['footnote', 'footnotesize'],
     ['script', 'scriptsize']].forEach(function (o) {
      var opt = document.createElement('option');
      opt.value = o[0]; opt.textContent = o[1];
      if (tstyle.size === o[0]) opt.selected = true;
      sizeSel.appendChild(opt);
    });
    sizeSel.addEventListener('change', function () { setStyle({ size: sizeSel.value }); });
    textGrp.appendChild(sizeSel);

    var rowGrp = styleGroup('rows:', 'Row height (LaTeX \\arraystretch).');
    var densSel = document.createElement('select');
    densSel.className = 'pe-table-width-sel pe-tbl-style-sel';
    [['compact', 'compact'], ['normal', 'normal'], ['roomy', 'roomy'],
     ['airy', 'airy']].forEach(function (o) {
      var opt = document.createElement('option');
      opt.value = o[0]; opt.textContent = o[1];
      if (tstyle.density === o[0]) opt.selected = true;
      densSel.appendChild(opt);
    });
    densSel.addEventListener('change', function () { setStyle({ density: densSel.value }); });
    rowGrp.appendChild(densSel);

    var zebWrap = document.createElement('label');
    zebWrap.className = 'pe-table-style-cb';
    zebWrap.title = 'Shade alternate rows.';
    var zebCb = document.createElement('input');
    zebCb.type = 'checkbox';
    zebCb.checked = !!tstyle.zebra;
    zebCb.addEventListener('change', function () { setStyle({ zebra: !!zebCb.checked }); });
    zebWrap.appendChild(zebCb);
    var zebLbl = document.createElement('span');
    zebLbl.textContent = 'striped';
    zebWrap.appendChild(zebLbl);
    styleBar.appendChild(zebWrap);

    var wrapWrap = document.createElement('label');
    wrapWrap.className = 'pe-table-style-cb';
    wrapWrap.title = 'Wrap long cell text onto more lines instead of widening the column. ' +
      'On by default; turn it off for a narrow table of short values, which then sizes to its content.';
    var wrapCb = document.createElement('input');
    wrapCb.type = 'checkbox';
    wrapCb.checked = tstyle.wrap !== false;
    wrapCb.addEventListener('change', function () { setStyle({ wrap: !!wrapCb.checked }); });
    wrapWrap.appendChild(wrapCb);
    var wrapLbl = document.createElement('span');
    wrapLbl.textContent = 'wrap text';
    wrapWrap.appendChild(wrapLbl);
    styleBar.appendChild(wrapWrap);

    styleBar.appendChild(checkboxField('header row', 'header_row', true));
    /* Tables II — multi-page table (\begin{longtable}: caption inside,
     * header repeats per page; NOT a float, so anchor/span/lock don't
     * apply; invalid in two-column classes — the export degrades it
     * there with a warning). */
    var ltField = checkboxField('multi-page (longtable)', 'longtable', false);
    ltField.title = 'Long tables break across pages with the header repeated. Not available in two-column journals (IEEE, PNAS) — those compile it as a regular table with a warning.';
    styleBar.appendChild(ltField);
    var sizeTag = document.createElement('span');
    sizeTag.className = 'pe-table-style-label';
    sizeTag.textContent = (attrs.get('rows') || 0) + ' × ' + (attrs.get('cols') || 0);
    styleBar.appendChild(sizeTag);
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
            /* V3.648 — inline form, not a prompt box. The select is put back
             * to its previous value until the width is actually accepted, so
             * cancelling never leaves the dropdown lying about the column. */
            var wr = wSel.getBoundingClientRect();
            var curMm = (cur.mode === 'mm' && cur.v > 0) ? String(cur.v) : '30';
            wSel.value = curVal;
            _openPicker(wr.left, wr.bottom + 4, {
              title: 'Column width', emptyMsg: '', renderRowMode: 'plain', rows: [],
              form: {
                title: 'Column width',
                fields: [{
                  key: 'mm', label: 'Width in mm', value: curMm, placeholder: '30',
                  hint: 'A fixed width for this column.',
                }],
                submitLabel: 'Set width',
                backLabel: 'Cancel',
                validate: function (vals) {
                  var n = parseFloat(String(vals.mm).trim());
                  if (!(n > 0)) {
                    return { field: 'mm', message: 'Enter a width greater than 0.' };
                  }
                  return null;
                },
                onSubmit: function (vals, handle) {
                  handle.close();
                  writeWidth(colIdx, { mode: 'mm', v: parseFloat(String(vals.mm).trim()) });
                },
              },
            });
            return;
          }
          writeWidth(colIdx, { mode: 'frac', v: parseFloat(v.split(':')[1]) });
        });
        grp.appendChild(wSel);
      })(col);
      alignWrap.appendChild(grp);
    }
    rootEl.appendChild(alignWrap);

    /* Grid editor — merge-aware, with the +/- gutter on its borders. */
    if (attrs.get('cells') instanceof Y.Map) {
      _mountTableGrid(rootEl, blk, attrs, tab);
    } else {
      var seed = document.createElement('div');
      seed.className = 'pe-equations-empty';
      seed.textContent = 'This table has no grid yet.';
      rootEl.appendChild(seed);
      var seedBtn = document.createElement('button');
      seedBtn.type = 'button';
      seedBtn.className = 'pe-eq-library-insert-btn';
      seedBtn.textContent = 'Start a 2 × 2 grid';
      seedBtn.addEventListener('click', function () {
        _tblWriteGrid(blk, attrs, [['', ''], ['', '']], {}, ['l', 'l'],
          [{ mode: 'auto' }, { mode: 'auto' }], 'table-seed');
      });
      rootEl.appendChild(seedBtn);
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
      readOnly: !_toolEditable(),   // V3.741 — was hardcoded false; honours the checkout lock
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

    /* Registered LAST so the defensive caption/cell migrations above
     * cannot fire it during the build itself. */
    _watchTableAttrs(rootEl, blk, attrs, tab);
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
        capRow.innerHTML = '<span class="pe-doc-picker-row-title">' + ICON.svg('books') + ' From reading library…</span>' +
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

    var item1 = _ctxMenuItem('Insert inline equation', function () {
      _hideContextMenu();
      _openInlinePicker(x, y);
    }, 'variable');
    var item2 = _ctxMenuItem('Eq. # — Insert equation reference', function () {
      _hideContextMenu();
      _openRefPicker(x, y);
    });
    /* V3.115 — figure references + citation insert. */
    var item3 = _ctxMenuItem('Insert figure reference', function () {
      _hideContextMenu();
      _openFigRefPicker(x, y);
    }, 'photo');
    /* V3.120 — table references. */
    var item4 = _ctxMenuItem('Insert table reference', function () {
      _hideContextMenu();
      _openTabRefPicker(x, y);
    }, 'table-cells');
    var item5 = _ctxMenuItem('Insert citation (Cmd+K)', function () {
      _hideContextMenu();
      _openCitationPopoverFallback();
    }, 'books');
    /* V3.649 — section cross-reference, in the same family as the figure
     * and table reference items above it. */
    var itemSec = _ctxMenuItem('§ Insert section reference', function () {
      _hideContextMenu();
      _openSectionRefPicker(x, y);
    });
    /* V3.647 — values / inventory items, reachable from the paragraph you
     * are writing in. The picker's "＋ New …" rows define the key and
     * insert its token in one action, so a value can be introduced mid-
     * sentence without leaving for the Values page and losing the caret. */
    var item6 = _ctxMenuItem('Insert value or inventory item', function () {
      _hideContextMenu();
      if (!window.PaperValues) return;
      window.PaperValues.openInsertPicker(null, { x: x, y: y });
    }, 'key');
    menu.appendChild(item1);
    menu.appendChild(item2);
    menu.appendChild(item3);
    menu.appendChild(item4);
    menu.appendChild(itemSec);
    menu.appendChild(item5);
    menu.appendChild(item6);

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

  function _ctxMenuItem(label, onClick, icon) {
    var item = document.createElement('button');
    item.type = 'button';
    item.className = 'pe-eq-context-menu-item';
    if (icon) ICON.label(item, icon, ' ' + label);
    else item.textContent = label;
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

  /* ── V3.649 — section / subheading cross-references ───────────────
   *
   * Lists every anchor a [!sec:] token could point at, not just the ones
   * that already carry a ref_label, and mints the label on the way past —
   * so referencing a section is one click rather than "go invent a label
   * first". Subheadings render indented under their section.
   */
  function _toolbarInsertSectionRef(anchorBtn) {
    if (!_ensureCaretOrAlert()) return;
    var r = anchorBtn && anchorBtn.getBoundingClientRect
      ? anchorBtn.getBoundingClientRect() : null;
    _openSectionRefPicker(
      r ? r.left : (window.innerWidth / 2 - 160),
      r ? (r.bottom + 4) : (window.innerHeight / 2 - 100)
    );
  }

  function _openSectionRefPicker(x, y) {
    var PE = window.PaperEditor;
    if (!PE || !PE.getSectionRefChoices) return;
    var choices = PE.getSectionRefChoices();
    /* The section the caret is in is the one you are least likely to want
     * to point at, and "see Section 2" inside Section 2 is a mistake worth
     * making hard — so it is listed last, marked. */
    var hereId = _resolveSectionIdForInsert();

    var rows = choices.map(function (c) {
      var title = (c.title || '').trim() || '(untitled)';
      var isHere = (c.kind === 'section' && c.id === hereId);
      var prefix = c.kind === 'subheading' ? '    ↳ ' : '';
      var suffix = '';
      if (c.appendixBoundary) suffix += '  · appendix';
      if (isHere) suffix += '  · you are here';
      return {
        name: prefix + title + suffix,
        searchKey: (title + ' ' + (c.refLabel || '') + ' ' + c.kind).toLowerCase(),
        _anchorId: c.id,
        _here: isHere,
      };
    });
    /* Stable sort: everything in document order, the current section last. */
    rows.sort(function (a, b) { return (a._here ? 1 : 0) - (b._here ? 1 : 0); });

    _openPicker(x, y, {
      title: 'Reference a section',
      emptyMsg: 'This paper has no sections yet.',
      renderRowMode: 'plain',
      rows: rows,
      onPick: function (row) {
        if (!row || !row._anchorId) return;
        var label = PE.ensureSectionRefLabel(row._anchorId);
        if (!label) {
          if (window.TOAST) TOAST.error('Could not label that section — is the paper read-only?');
          return;
        }
        _insertAtSavedCaret('[!sec:' + label + ']');
      },
    });
  }

  /* V3.645 — hand off to paper-values.js, anchored under the button so
   * the picker appears where the user clicked. */
  function _toolbarInsertValue() {
    if (!window.PaperValues) return;
    var btn = document.getElementById('pe-gt-value');
    window.PaperValues.openInsertPicker(btn);
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

    var titleEl = pop.querySelector('.pe-eq-picker-title');
    var hintEl = pop.querySelector('.pe-eq-picker-hint');
    var input = pop.querySelector('.pe-eq-picker-search');
    var listEl = pop.querySelector('.pe-eq-picker-list');
    /* V3.648 — the picker can swap its list for an inline multi-field form,
     * so "create the thing you were looking for" happens INSIDE the dropdown
     * instead of in a chain of window.prompt() boxes. Alex: "i dont want the
     * options to be popups from the browser… never have an input popup". */
    var formEl = null;
    var formSpec = null;
    var formInputs = null;
    var current = opts.rows.slice();
    var activeIdx = current.length ? 0 : -1;
    /* V3.647 — the raw (un-lowercased) search text. Rows can render their
     * label from it (`name` as a function) and onPick receives it, so a
     * picker can offer "create what you just typed" instead of dead-ending
     * on "no match". */
    var lastQuery = '';

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
        var rowName = (typeof r.name === 'function') ? r.name(lastQuery) : r.name;
        row.innerHTML =
          '<div class="pe-eq-picker-row-name">' + (r.icon ? ICON.svg(r.icon) + ' ' : '') + _escHtml(rowName) + '</div>' +
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
      lastQuery = (input.value || '').trim();
      var q = lastQuery.toLowerCase();
      if (!q) {
        current = opts.rows.slice();
      } else {
        /* V3.647 — `always` rows survive filtering. They are the escapes
         * ("create what you typed", "search somewhere else"), and they
         * matter MOST at the moment the query matches nothing. */
        current = opts.rows.filter(function (r) {
          return r.always || r.searchKey.indexOf(q) >= 0;
        });
      }
      activeIdx = current.length ? 0 : -1;
      renderList();
    }

    function pickIdx(i) {
      var entry = current[i];
      if (!entry) return;
      /* V3.648 — a `keepOpen` row hands the popover to onPick instead of
       * dismissing it, so the handler can call handle.showForm(...) and the
       * user never leaves the dropdown they were already looking at. */
      if (!entry.keepOpen) _closePicker();
      /* V3.115 — opts.onPick override (used by figure picker so it can
       * branch into a subfigure picker rather than insert immediately).
       * Default behavior: insert the row's `insert` token at saved caret. */
      if (typeof opts.onPick === 'function') {
        opts.onPick(entry, lastQuery, handle);   // V3.647 query, V3.648 handle
      } else if (entry.insert) {
        _insertAtSavedCaret(entry.insert);
      }
    }

    /* ── V3.648 — inline form mode ───────────────────────────────────
     *
     * `spec` is declarative so the picker owns the chrome, the keyboard
     * (Enter saves, Esc goes back to the list) and the validation seam:
     *
     *   { title, fields: [{ key, label, value, placeholder, hint }],
     *     submitLabel, backLabel,
     *     validate(vals) -> null | { field, message },
     *     onSubmit(vals, handle) }
     */
    function showForm(spec) {
      formSpec = spec || {};
      formInputs = {};
      if (formEl) { formEl.remove(); formEl = null; }
      input.hidden = true;
      listEl.hidden = true;
      titleEl.textContent = formSpec.title || opts.title;
      hintEl.textContent = 'Enter to save · Esc to go back';

      formEl = document.createElement('div');
      formEl.className = 'pe-eq-picker-form';
      /* Only the FIELDS scroll. The error line and the buttons are pinned
       * below them — a five-field form is taller than the popover, and a
       * Save button you have to scroll an inner pane to find is a Save
       * button nobody presses. */
      var fieldsEl = document.createElement('div');
      fieldsEl.className = 'pe-eq-picker-form-fields';
      formEl.appendChild(fieldsEl);
      /* An explanatory line above the fields. With `fields: []` this is the
       * whole body — which is how a confirm-before-you-delete panel is built
       * out of the same primitive instead of window.confirm(). */
      if (formSpec.note) {
        var noteEl = document.createElement('div');
        noteEl.className = 'pe-eq-picker-form-note';
        noteEl.textContent = formSpec.note;
        fieldsEl.appendChild(noteEl);
      }
      (formSpec.fields || []).forEach(function (f) {
        var row = document.createElement('label');
        row.className = 'pe-eq-picker-field';
        var lab = document.createElement('span');
        lab.className = 'pe-eq-picker-field-label';
        lab.textContent = f.label;
        row.appendChild(lab);
        var inp = document.createElement('input');
        inp.type = 'text';   // text even for numbers: units, blanks, "as typed"
        inp.className = 'pe-eq-picker-field-input';
        inp.value = (f.value == null) ? '' : String(f.value);
        if (f.placeholder) inp.placeholder = f.placeholder;
        row.appendChild(inp);
        if (f.hint) {
          var h = document.createElement('span');
          h.className = 'pe-eq-picker-field-hint';
          h.textContent = f.hint;
          row.appendChild(h);
        }
        formInputs[f.key] = inp;
        fieldsEl.appendChild(row);
      });

      var err = document.createElement('div');
      err.className = 'pe-eq-picker-form-err';
      err.hidden = true;
      formEl.appendChild(err);
      formEl._err = err;

      var actions = document.createElement('div');
      actions.className = 'pe-eq-picker-form-actions';
      var back = document.createElement('button');
      back.type = 'button';
      back.className = 'pe-eq-picker-form-btn';
      back.textContent = formSpec.backLabel || 'Back';
      back.addEventListener('click', function () { showList(); });
      var save = document.createElement('button');
      save.type = 'button';
      save.className = 'pe-eq-picker-form-btn pe-eq-picker-form-btn-primary' +
        (formSpec.danger ? ' pe-eq-picker-form-btn-danger' : '');
      save.textContent = formSpec.submitLabel || 'Save';
      save.addEventListener('click', submitForm);
      actions.appendChild(back);
      actions.appendChild(save);
      formEl.appendChild(actions);

      pop.insertBefore(formEl, hintEl);
      var first = (formSpec.fields || [])[0];
      var firstEl = first && formInputs[first.key];
      if (firstEl) { firstEl.focus(); firstEl.select(); }
      else save.focus();   // fieldless panels (confirm) still take the keyboard
      hintEl.textContent = firstEl
        ? 'Enter to save · Esc to go back'
        : 'Enter to confirm · Esc to cancel';
    }

    function formValues() {
      var out = {};
      Object.keys(formInputs || {}).forEach(function (k) {
        out[k] = formInputs[k].value;
      });
      return out;
    }

    function submitForm() {
      if (!formSpec) return;
      var vals = formValues();
      var bad = formSpec.validate ? formSpec.validate(vals) : null;
      if (bad) {
        /* Errors land IN the form, next to the field that caused them —
         * the whole point of not being a browser alert. */
        formEl._err.textContent = bad.message || String(bad);
        formEl._err.hidden = false;
        var target = bad.field && formInputs[bad.field];
        if (target) { target.focus(); target.select(); }
        return;
      }
      formEl._err.hidden = true;
      if (formSpec.onSubmit) formSpec.onSubmit(vals, handle);
    }

    function showList() {
      formSpec = null;
      formInputs = null;
      if (formEl) { formEl.remove(); formEl = null; }
      input.hidden = false;
      listEl.hidden = false;
      titleEl.textContent = opts.title;
      hintEl.textContent = 'Esc to close';
      refresh();
      input.focus();
    }

    var handle = {
      close: function () { _closePicker(); },
      showForm: showForm,
      showList: showList,
      setError: function (msg) {
        if (!formEl) return;
        formEl._err.textContent = msg;
        formEl._err.hidden = !msg;
      },
    };

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
      /* V3.648 — while the inline form is up it owns the keyboard: Esc steps
       * BACK to the list rather than throwing away half-typed input, Enter
       * saves, and the arrow keys must not move a list the user can't see. */
      if (formSpec) {
        if (ev.key === 'Escape') { showList(); ev.preventDefault(); ev.stopPropagation(); return; }
        if (ev.key === 'Enter')  { submitForm(); ev.preventDefault(); ev.stopPropagation(); return; }
        if (ev.key === 'ArrowDown' || ev.key === 'ArrowUp') return;
        return;
      }
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
    /* V3.648 — `opts.form` opens the popover straight into form mode with no
     * list behind it. That is how page-level "add" buttons (the Values page)
     * get the same inline editor without a browser prompt. */
    if (opts.form) showForm(opts.form);
    requestAnimationFrame(function () {
      var rect = pop.getBoundingClientRect();
      if (rect.right > window.innerWidth - 8) {
        pop.style.left = Math.max(8, window.innerWidth - rect.width - 8) + 'px';
      }
      if (rect.bottom > window.innerHeight - 8) {
        pop.style.top = Math.max(8, window.innerHeight - rect.height - 8) + 'px';
      }
    });
    if (!opts.form) setTimeout(function () { input.focus(); }, 30);
    _state.pickerOpen = true;
    return handle;
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
    /* V3.645 — primitives paper-values.js builds its picker on, rather
     * than adding yet another popover implementation. */
    openPicker: _openPicker,
    insertAtCaret: _insertAtSavedCaret,
    /* V3.650 — test seam for scripts/tests/v3650-selftest.html. The table
     * grid is DOM-and-CRDT all the way down (there is no pure function to
     * assert against), so the selftest drives the real editor: it builds a
     * Y.Doc, mounts the body, and clicks the buttons. Not used in prod. */
    __tblTest: {
      buildTableEditorBody: function (rootEl, tab) { return _buildTableEditorBody(rootEl, tab); },
      shiftMerges: _tblShiftMerges,
      structOp: _tblStructOp,
      clearSelection: function () { _tblSel = null; },
      getSelection: function () { return _tblSel; },
    },
  };
})();
