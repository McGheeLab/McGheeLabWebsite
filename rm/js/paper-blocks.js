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
      case 'figure':    return renderFigure(yBlock, ctx);
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
    handle.title = 'Drag to reorder';
    handle.textContent = '⋮⋮';
    bar.appendChild(handle);
    /* V3.125 — drag-to-reorder + ↑/↓ buttons. */
    bar.appendChild(buildReorderControls(yBlock, ctx));
    wireDragHandle(handle, wrap, yBlock, ctx);

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

    /* V3.217 — soft section lock badge. Visible to both the holder
     * ("You are editing") and everyone else ("Locked by Alex"). Click
     * the self-badge to manually release the lock. */
    var lockBadge = document.createElement('span');
    lockBadge.className = 'pe-block-lock-badge';
    lockBadge.hidden = true;
    bar.appendChild(lockBadge);

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
    var onCountsChanged = function () {
      refreshCommentCount();
      /* V3.216 — re-overlay anchored highlights so adds / resolves /
       * deletes propagate without needing a render cycle. Skipped while
       * the body is focused so the caret isn't disturbed mid-edit;
       * highlights painted on focus by `onRendered` keep the in-edit
       * view consistent until blur picks up the latest comment state. */
      if (window.PaperComments && window.PaperComments.applyHighlights &&
          document.activeElement !== bdEl) {
        window.PaperComments.applyHighlights(bdEl, blockId);
      }
    };
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
    /* V3.104 — skeleton is now a Y.Array<Y.Map> outline, not a flat Y.Text.
     * Migrate legacy field on first render then mount the outline UI. */
    migrateSkeletonToItems(yBlock, Y);
    var skOutline = renderSkeletonOutline(yBlock, ctx);
    var skEl = skOutline.el;

    /* V3.120 — the V3.107 per-paragraph rich-text toolbar is retired in
     * favor of the single global toolbar at the top of the editor (see
     * paper-equations.js _installGlobalToolbar). The bdWrap container
     * stays so the skeleton/body view toggle has a single element to
     * show/hide; it just has no toolbar inside anymore. */
    var bdWrap = document.createElement('div');
    bdWrap.className = 'pe-paragraph-body-wrap';

    var bdEl = document.createElement('div');
    bdEl.className = 'pe-block-content';
    bdEl.dataset.placeholder = 'Write the full paragraph…';

    var bdUnbind = window.PaperEditor.bindYTextToContentEditable(yBlock.get('body'), bdEl, {
      readOnly: !ctx.editable,
      onLocalChange: function () { ctx.onFocusBlock && ctx.onFocusBlock(blockId); },
      renderHtml: window.PaperEditor.renderParagraphHtml,
      /* V3.216 — overlay anchored comment highlights after every full
       * render. Skipped while the element is focused (chip-mode is on
       * and the user is editing). */
      onRendered: function (el) {
        if (window.PaperComments && window.PaperComments.applyHighlights) {
          window.PaperComments.applyHighlights(el, blockId);
        }
      },
    });

    bdEl.addEventListener('focus', function () {
      if (ctx.onFocusBlock) ctx.onFocusBlock(blockId);
    });

    /* V3.217 — releasing the lock.
     *
     * On blur of any editable within this block: schedule a release
     * after 250ms. The delay covers normal intra-block interactions
     * (status-pill click, comment button, etc.) that briefly blur the
     * editable before focus returns. The skeleton-bullet binds (line
     * ~536) also live under `wrap`, so listening at wrap-level via
     * delegation gives one timer for the whole block.
     *
     * Idle release: any input event resets a 30s timer; when it fires
     * with no activity the lock auto-releases. Mirrors paper-yjs.js's
     * PRESENCE_STALE_MS so a forgotten browser tab eventually unsticks
     * — heartbeat keeps `lastSeen` fresh while the page is open, so
     * the per-block presence stale-check doesn't catch this case on
     * its own.
     */
    var _releaseTimer = null;
    var _idleTimer = null;
    var IDLE_RELEASE_MS = 30000;
    function _selfOwnsThisBlock() {
      /* Release only if my presence record still points at this block.
       * Guards against a stale closure: I may have moved focus to a
       * sibling block before this timer fired, and clearing the lock
       * now would wipe the sibling's claim. */
      var selfFocus = ctx.getSelfFocusBlockId ? ctx.getSelfFocusBlockId() : null;
      return selfFocus === blockId;
    }
    function _scheduleRelease() {
      if (_releaseTimer) clearTimeout(_releaseTimer);
      _releaseTimer = setTimeout(function () {
        _releaseTimer = null;
        if (_selfOwnsThisBlock() && ctx.releaseLock) ctx.releaseLock();
      }, 250);
    }
    function _cancelRelease() {
      if (_releaseTimer) { clearTimeout(_releaseTimer); _releaseTimer = null; }
    }
    function _bumpIdleTimer() {
      _cancelRelease();
      if (_idleTimer) clearTimeout(_idleTimer);
      _idleTimer = setTimeout(function () {
        _idleTimer = null;
        if (_selfOwnsThisBlock() && ctx.releaseLock) ctx.releaseLock();
      }, IDLE_RELEASE_MS);
    }
    /* Delegated at wrap-level so skeleton bullets (which mount later
     * inside `skEl`) share the same release / idle timers as `bdEl`. */
    wrap.addEventListener('focusin', function (e) {
      if (!e.target.matches || !e.target.matches('[contenteditable="true"]')) return;
      _bumpIdleTimer();
    });
    wrap.addEventListener('focusout', function (e) {
      if (!e.target.matches || !e.target.matches('[contenteditable]')) return;
      /* If focus is moving to another element inside the same block
       * (e.g. clicking the comment button to read replies), don't
       * release — the user is still actively working on this block. */
      if (e.relatedTarget && wrap.contains(e.relatedTarget)) return;
      _scheduleRelease();
    });
    wrap.addEventListener('input', function (e) {
      if (!e.target.closest || !e.target.closest('[contenteditable]')) return;
      /* If the idle timer fired and released the lock but the user
       * stayed focused in the editor, the next keystroke re-claims it.
       * Without this, the user would type into a released block with
       * no UI signal. */
      var holder = ctx.getLockHolderForBlock ? ctx.getLockHolderForBlock(blockId) : null;
      if (!holder && ctx.onFocusBlock) ctx.onFocusBlock(blockId);
      _bumpIdleTimer();
    });

    /* V3.107 — Cmd/Ctrl+B / I / E wrap the selection. Listener runs in
     * capture so the existing input handler still fires for the resulting
     * insertText. */
    if (ctx.editable && window.PaperEditor && window.PaperEditor.richTextKeydownHandler) {
      bdEl.addEventListener('keydown', function (e) {
        window.PaperEditor.richTextKeydownHandler(e);
      });
    }

    /* V3.109 — right-click in the paragraph body opens a small custom
     * context menu with "Insert inline equation" / "Insert equation
     * reference" entries. The Equations module saves the caret position
     * on right-click and restores it before token insertion. */
    if (ctx.editable && window.PaperEquations && window.PaperEquations.bindContextMenu) {
      window.PaperEquations.bindContextMenu(bdEl);
    }

    bdWrap.appendChild(bdEl);

    wrap.appendChild(skEl);
    wrap.appendChild(bdWrap);

    function applyMode(m) {
      blockMode = m;
      skBtn.classList.toggle('active', m === 'skeleton');
      bdBtn.classList.toggle('active', m === 'body');
      // Visibility based on view filter override.
      var effective = ctx.viewFilter === 'skeleton' ? 'skeleton' :
                      ctx.viewFilter === 'body'     ? 'body'     : m;
      skEl.style.display = (effective === 'skeleton') ? '' : 'none';
      bdWrap.style.display = (effective === 'body')   ? '' : 'none';
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
    var onPresenceChanged = function () {
      refreshBlockPresence(presenceWrap, ctx, blockId);
      refreshBlockLock(wrap, bdEl, lockBadge, ctx, blockId);
    };
    window.addEventListener('paper-presence-changed', onPresenceChanged);
    /* Apply initial lock state at render time too (presence is already
     * cached when the block mounts mid-session). */
    refreshBlockLock(wrap, bdEl, lockBadge, ctx, blockId);

    /* Cleanup: register unbind + unobserve. */
    if (ctx.registerSubscription) {
      ctx.registerSubscription(yBlock, function () {
        try { skOutline.unbind(); } catch (e) {}
        try { bdUnbind(); } catch (e) {}
        try { yBlock.unobserve(blockObserver); } catch (e) {}
        window.removeEventListener('paper-presence-changed', onPresenceChanged);
        window.removeEventListener('paper-comment-counts-changed', onCountsChanged);
        if (_releaseTimer) { clearTimeout(_releaseTimer); _releaseTimer = null; }
        if (_idleTimer) { clearTimeout(_idleTimer); _idleTimer = null; }
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

  /* V3.217 — render the soft-lock badge and gate contenteditable on
   * every contenteditable child of the block.
   *
   * Holder = the presence record whose `focusBlockId` matches; tie-break
   * by lowest uid. The badge is visible to both the holder ("You")
   * and everyone else ("Locked by Alex") so neither side wonders why
   * the other can't type. The `data-locked="other"` attribute on the
   * block wrapper is a hook for the CSS visual treatment (left-edge
   * accent bar, dimmed body) plus the click-to-toast handler. */
  function refreshBlockLock(blockWrap, bdEl, badgeEl, ctx, blockId) {
    var holder = ctx.getLockHolderForBlock ? ctx.getLockHolderForBlock(blockId) : null;
    if (!holder) {
      badgeEl.hidden = true;
      badgeEl.innerHTML = '';
      blockWrap.dataset.locked = '';
      blockWrap.style.removeProperty('--pe-lock-color');
      /* V3.222 — clear belt-and-suspenders inline styles too. */
      blockWrap.style.removeProperty('box-shadow');
      blockWrap.style.removeProperty('border-color');
      _setBlockEditablesLocked(blockWrap, ctx, false);
      return;
    }
    badgeEl.hidden = false;
    badgeEl.innerHTML = '';
    var dot = document.createElement('span');
    dot.className = 'pe-block-lock-dot';
    dot.style.background = holder.color;
    badgeEl.appendChild(dot);
    var name = document.createElement('span');
    name.className = 'pe-block-lock-name';
    name.textContent = holder.isSelf
      ? 'You'
      : (holder.name || holder.uid || 'Someone');
    badgeEl.appendChild(name);
    if (holder.isSelf) {
      badgeEl.classList.add('pe-block-lock-self');
      badgeEl.title = 'You are editing this paragraph — others see it as locked. Click to release.';
      badgeEl.style.cursor = 'pointer';
      blockWrap.dataset.locked = 'self';
      /* V3.219 — self-lock outline + badge use the holder's presence
       * color (the same hue rendered in the avatar dot) so each user
       * sees their own personal color around blocks they own.
       * V3.222 — also stamp `box-shadow` + `border-color` INLINE so the
       * visual change happens even if the CSS rule is somehow not in
       * effect (stale service worker cache, ancestor stacking context
       * clipping `outline`, etc.). The inline style wins over the CSS
       * rule unconditionally — no `!important` battle. */
      var color = holder.color || '#2563eb';
      blockWrap.style.setProperty('--pe-lock-color', color);
      blockWrap.style.boxShadow = '0 0 0 3px ' + color;
      blockWrap.style.borderColor = color;
      _setBlockEditablesLocked(blockWrap, ctx, false);
      /* Manual release: click the self-badge to drop the lock without
       * needing to blur the body. Useful when the holder wants the
       * coauthor to take over without sliding off the paragraph. */
      badgeEl.onclick = function () {
        if (ctx.releaseLock) ctx.releaseLock();
      };
    } else {
      badgeEl.classList.remove('pe-block-lock-self');
      badgeEl.title = 'Locked by ' + (holder.name || holder.uid || 'someone') + ' — wait until they move on.';
      badgeEl.style.cursor = 'default';
      badgeEl.onclick = null;
      blockWrap.dataset.locked = 'other';
      blockWrap.style.setProperty('--pe-lock-color', holder.color || '#9ca3af');
      /* V3.222 — clear the self-only inline styles so an "other holder"
       * state never bleeds the prior self ring. The CSS `data-locked="other"`
       * rule handles the visual for this case (left-edge accent + dim). */
      blockWrap.style.removeProperty('box-shadow');
      blockWrap.style.removeProperty('border-color');
      _setBlockEditablesLocked(blockWrap, ctx, true);
      /* Surface a transient toast on click attempts so the other user
       * understands why their cursor refuses to land. Installed once
       * per block via a flag on the wrapper. */
      if (!blockWrap._pe_lockClickInstalled) {
        blockWrap._pe_lockClickInstalled = true;
        blockWrap.addEventListener('click', function (ev) {
          if (blockWrap.dataset.locked !== 'other') return;
          /* Don't fire the toast for clicks on toolbar controls — only
           * for attempts on the editable surfaces. */
          var target = ev.target;
          if (target.closest('.pe-block-toolbar')) return;
          if (target.closest('.pe-block-actions')) return;
          var h = ctx.getLockHolderForBlock ? ctx.getLockHolderForBlock(blockId) : null;
          if (!h || h.isSelf) return;
          _showLockToast(ev.clientX, ev.clientY, h);
        });
      }
    }
  }

  function _setBlockEditablesLocked(blockWrap, ctx, locked) {
    if (!ctx.editable) return; // global read-only — already non-editable everywhere
    var nodes = blockWrap.querySelectorAll('[contenteditable]');
    for (var i = 0; i < nodes.length; i++) {
      nodes[i].contentEditable = locked ? 'false' : 'true';
    }
  }

  var _lockToastEl = null;
  var _lockToastTimer = null;
  function _showLockToast(x, y, holder) {
    if (!_lockToastEl) {
      _lockToastEl = document.createElement('div');
      _lockToastEl.className = 'pe-lock-toast';
      document.body.appendChild(_lockToastEl);
    }
    _lockToastEl.textContent = '🔒 Locked by ' + (holder.name || holder.uid || 'someone');
    _lockToastEl.style.borderColor = holder.color || '#f59e0b';
    _lockToastEl.style.left = (x + 12 + window.scrollX) + 'px';
    _lockToastEl.style.top = (y + 12 + window.scrollY) + 'px';
    _lockToastEl.hidden = false;
    if (_lockToastTimer) clearTimeout(_lockToastTimer);
    _lockToastTimer = setTimeout(function () {
      if (_lockToastEl) _lockToastEl.hidden = true;
    }, 1800);
  }

  /* V3.104 — skeleton schema migration. Each paragraph block historically
   * held its skeleton as a flat Y.Text (line-broken plain text). V3.104
   * promotes it to a Y.Array<Y.Map> outline where each item is a bullet
   * with its own depth, Y.Text, and optional claim_id. This function is
   * idempotent: if skeleton_items already exists and is non-empty, it
   * no-ops. Otherwise it parses the legacy Y.Text (split on \n, leading
   * spaces ÷ 2 → depth, capped at MAX_SKELETON_DEPTH, strip leading "- "
   * prefix) and seeds skeleton_items in a single Yjs transaction. The
   * legacy `skeleton` Y.Text field is preserved (not deleted) so a
   * one-version rollback to V3.102 still has data to read. */
  function migrateSkeletonToItems(yBlock, Y) {
    var existing = yBlock.get('skeleton_items');
    if (existing && typeof existing.length === 'number' && existing.length > 0) return;

    var legacy = yBlock.get('skeleton');
    var legacyText = (legacy && typeof legacy.toString === 'function')
      ? legacy.toString()
      : (typeof legacy === 'string' ? legacy : '');

    var maxDepth = (window.PaperSchemas && window.PaperSchemas.MAX_SKELETON_DEPTH) || 3;
    var shortId = (window.PaperSchemas && window.PaperSchemas.shortId) || function () { return 'sk-' + Math.random().toString(36).slice(2, 9); };

    yBlock.doc.transact(function () {
      if (!(yBlock.get('skeleton_items') instanceof Y.Array)) {
        yBlock.set('skeleton_items', new Y.Array());
      }
      var items = yBlock.get('skeleton_items');
      if (items.length > 0) return;  // race: another client filled it

      function pushItem(text, depth) {
        var m = new Y.Map();
        items.push([m]);
        m.set('id', shortId('sk-'));
        m.set('depth', Math.max(0, Math.min(maxDepth, depth || 0)));
        m.set('text', new Y.Text(text || ''));
        m.set('claim_id', null);
      }

      if (!legacyText || !legacyText.trim()) {
        pushItem('', 0);
        return;
      }

      legacyText.split('\n').forEach(function (line) {
        var m2 = /^( *)(?:- )?(.*)$/.exec(line);
        var leading = m2[1].length;
        var content = m2[2];
        var depth = Math.floor(leading / 2);
        if (!content && items.length > 0) return;  // skip blank line continuations
        pushItem(content, depth);
      });

      if (items.length === 0) pushItem('', 0);
    }, 'skeleton-migrate-v3.103');
  }

  /* Render the skeleton outline UI for a paragraph block (V3.104). Mounts
   * a flat list of bullet `<div>`s (depth → padding-left) and binds each
   * bullet's text Y.Text via the existing bindYTextToContentEditable
   * pipeline. Returns `{el, unbind}`; the caller mounts `el` into the
   * paragraph wrap and is responsible for calling `unbind()` on teardown.
   *
   * Keyboard handling on a bullet:
   *   Tab        → indent (cap at MAX_SKELETON_DEPTH)
   *   Shift+Tab  → outdent (floor at 0)
   *   Enter      → split bullet at caret; new item inherits depth
   *   Backspace at start of empty bullet → delete the item, focus prior
   *   Backspace at start of non-empty bullet → merge into prior bullet
   *
   * Each bullet shows a hover-only `⚑` flag-as-claim button when no
   * claim is attached. Once flagged, a status pill appears at right and
   * the flag button is hidden. */
  function renderSkeletonOutline(yBlock, ctx) {
    var Y = ctx.Y;
    var blockId = yBlock.get('id');
    var items = yBlock.get('skeleton_items');

    var container = document.createElement('div');
    container.className = 'pe-block-content skeleton pe-skeleton-outline';
    container.dataset.blockId = blockId;
    container.dataset.placeholder = 'Outline the argument…';

    var itemUnbinds = [];   // [{itemUnobserve, textUnbind, claimCleanup}]
    var pendingFocusId = null;

    function teardownItems() {
      itemUnbinds.forEach(function (u) {
        try { u.textUnbind && u.textUnbind(); } catch (e) {}
        try { u.itemUnobserve && u.itemUnobserve(); } catch (e) {}
        try { u.claimCleanup && u.claimCleanup(); } catch (e) {}
      });
      itemUnbinds = [];
    }

    function applyPendingFocus() {
      if (!pendingFocusId) return;
      var li = container.querySelector('[data-item-id="' + pendingFocusId + '"]');
      pendingFocusId = null;
      if (!li) return;
      var bullet = li.querySelector('.pe-skeleton-bullet');
      if (!bullet) return;
      bullet.focus();
      try {
        var range = document.createRange();
        range.selectNodeContents(bullet);
        range.collapse(false);
        var sel = window.getSelection();
        sel.removeAllRanges();
        sel.addRange(range);
      } catch (e) { /* selection failed, focus is enough */ }
    }

    function readCaretOffset(el) {
      var sel = window.getSelection();
      if (!sel || sel.rangeCount === 0) return null;
      var range = sel.getRangeAt(0);
      if (!el.contains(range.startContainer)) return null;
      var pre = range.cloneRange();
      pre.selectNodeContents(el);
      pre.setEnd(range.startContainer, range.startOffset);
      return pre.toString().length;
    }

    function handleKeydown(e, bulletEl, itemMap, idx) {
      if (!ctx.editable) return;
      // Cmd/Ctrl+Shift+L → flag this bullet as a claim (or open detail
      // panel if it's already flagged). Wired here so the handler has
      // closure access to itemMap + yBlock without a global lookup.
      if ((e.metaKey || e.ctrlKey) && e.shiftKey &&
          (e.key === 'L' || e.key === 'l' || e.code === 'KeyL')) {
        e.preventDefault();
        if (window.PaperBulletClaims && window.PaperBulletClaims.flagBullet) {
          window.PaperBulletClaims.flagBullet({
            yBlock: yBlock,
            itemMap: itemMap,
            paperId: ctx.paperId,
          });
        }
        return;
      }
      if (e.key === 'Tab') {
        e.preventDefault();
        var d = itemMap.get('depth') || 0;
        var max = (window.PaperSchemas && window.PaperSchemas.MAX_SKELETON_DEPTH) || 3;
        var nd = e.shiftKey ? Math.max(0, d - 1) : Math.min(max, d + 1);
        if (nd === d) return;
        yBlock.doc.transact(function () { itemMap.set('depth', nd); }, 'skeleton-indent');
        return;
      }
      if (e.key === 'Enter' && !e.shiftKey && !e.metaKey && !e.ctrlKey) {
        e.preventDefault();
        var caret = readCaretOffset(bulletEl);
        var src = itemMap.get('text').toString();
        var leftText = src.slice(0, caret == null ? src.length : caret);
        var rightText = src.slice(caret == null ? src.length : caret);
        var d = itemMap.get('depth') || 0;
        var newId = (window.PaperSchemas && window.PaperSchemas.shortId)
          ? window.PaperSchemas.shortId('sk-')
          : 'sk-' + Math.random().toString(36).slice(2, 9);
        yBlock.doc.transact(function () {
          var t = itemMap.get('text');
          if (t.length) t.delete(0, t.length);
          if (leftText) t.insert(0, leftText);
          var m = new Y.Map();
          items.insert(idx + 1, [m]);
          m.set('id', newId);
          m.set('depth', d);
          m.set('text', new Y.Text(rightText));
          m.set('claim_id', null);
        }, 'skeleton-split');
        pendingFocusId = newId;
        return;
      }
      if (e.key === 'Backspace') {
        var caret2 = readCaretOffset(bulletEl);
        var src2 = itemMap.get('text').toString();
        if (src2 === '' && items.length > 1) {
          e.preventDefault();
          var prevIdx = Math.max(0, idx - 1);
          var prevItem = items.get(prevIdx);
          var prevId = prevItem && prevItem.get && prevItem.get('id');
          yBlock.doc.transact(function () { items.delete(idx, 1); }, 'skeleton-delete-empty');
          pendingFocusId = prevId;
          return;
        }
        if (caret2 === 0 && idx > 0) {
          e.preventDefault();
          var prevItem2 = items.get(idx - 1);
          var prevText = prevItem2.get('text');
          var prevLen = prevText.length;
          var prevId2 = prevItem2.get('id');
          yBlock.doc.transact(function () {
            if (src2) prevText.insert(prevLen, src2);
            items.delete(idx, 1);
          }, 'skeleton-merge-prev');
          pendingFocusId = prevId2;
          return;
        }
      }
    }

    function buildClaimPill(claimId, itemMap) {
      var pill = document.createElement('button');
      pill.type = 'button';
      pill.className = 'pe-claim-pill';
      pill.dataset.claimId = claimId;
      pill.dataset.status = 'loading';
      pill.textContent = '⚑ …';

      function refresh() {
        var bc = window.PaperBulletClaims;
        var c = bc && bc.getClaim ? bc.getClaim(claimId) : null;
        if (c) {
          pill.dataset.status = c.status || 'developing';
          var n = ((c.supporting_evidence_ids || []).length) + ((c.counter_evidence_ids || []).length);
          pill.textContent = '⚑ ' + (c.status || 'developing') + (n ? ' · ' + n : '');
          pill.title = (c.statement || '').slice(0, 200) + (n ? '\n(' + n + ' evidence linked)' : '');
        } else {
          pill.dataset.status = bc ? 'unknown' : 'loading';
          pill.textContent = bc ? '⚑ ?' : '⚑ …';
        }
      }
      refresh();

      var listener = function () { refresh(); };
      window.addEventListener('paper-claims-changed', listener);

      pill.addEventListener('click', function (e) {
        e.preventDefault();
        if (window.PaperBulletClaims && window.PaperBulletClaims.openClaimDetail) {
          window.PaperBulletClaims.openClaimDetail(claimId);
        }
      });

      return {
        el: pill,
        cleanup: function () { window.removeEventListener('paper-claims-changed', listener); },
      };
    }

    function renderAll() {
      teardownItems();
      container.innerHTML = '';

      var itemArr = items.toArray();
      if (!itemArr.length) {
        if (ctx.editable) {
          // Always keep at least one bullet so the contenteditable shell is usable.
          yBlock.doc.transact(function () {
            var m = new Y.Map();
            items.push([m]);
            var mkId = (window.PaperSchemas && window.PaperSchemas.shortId)
              ? window.PaperSchemas.shortId('sk-')
              : 'sk-' + Math.random().toString(36).slice(2, 9);
            m.set('id', mkId);
            m.set('depth', 0);
            m.set('text', new Y.Text(''));
            m.set('claim_id', null);
          }, 'skeleton-seed-empty');
        }
        return;  // observer fires re-render after the seed
      }

      itemArr.forEach(function (itemMap, idx) {
        var itemId = itemMap.get('id');
        var depth = itemMap.get('depth') || 0;
        var claimId = itemMap.get('claim_id');
        var textY = itemMap.get('text');

        var li = document.createElement('div');
        li.className = 'pe-skeleton-item';
        li.dataset.itemId = itemId;
        li.dataset.depth = String(depth);
        li.style.paddingLeft = (depth * 22) + 'px';

        var marker = document.createElement('span');
        marker.className = 'pe-skeleton-marker';
        marker.textContent = '•';
        li.appendChild(marker);

        var bullet = document.createElement('div');
        bullet.className = 'pe-skeleton-bullet pe-block-content';
        bullet.dataset.placeholder = idx === 0 ? 'Outline the argument…' : 'Continue…';

        var textUnbind = window.PaperEditor.bindYTextToContentEditable(textY, bullet, {
          readOnly: !ctx.editable,
          onLocalChange: function () { ctx.onFocusBlock && ctx.onFocusBlock(blockId); },
          renderHtml: window.PaperEditor.renderParagraphHtml,
        });
        bullet.addEventListener('keydown', function (e) {
          handleKeydown(e, bullet, itemMap, idx);
        });
        bullet.addEventListener('focus', function () {
          if (ctx.onFocusBlock) ctx.onFocusBlock(blockId);
        });
        li.appendChild(bullet);

        var claimCleanup = null;
        if (claimId) {
          var pill = buildClaimPill(claimId, itemMap);
          li.appendChild(pill.el);
          claimCleanup = pill.cleanup;
        } else if (ctx.editable && window.PaperBulletClaims) {
          var flagBtn = document.createElement('button');
          flagBtn.type = 'button';
          flagBtn.className = 'pe-skeleton-flag-btn';
          flagBtn.title = 'Flag this bullet as a claim that needs literature review';
          flagBtn.textContent = '⚑';
          flagBtn.addEventListener('mousedown', function (e) {
            // mousedown not click — preserves caret position in the bullet
            e.preventDefault();
          });
          flagBtn.addEventListener('click', function (e) {
            e.preventDefault();
            if (window.PaperBulletClaims && window.PaperBulletClaims.flagBullet) {
              window.PaperBulletClaims.flagBullet({
                yBlock: yBlock,
                itemMap: itemMap,
                paperId: ctx.paperId,
              });
            }
          });
          li.appendChild(flagBtn);
        }

        // Per-item observer: depth or claim_id changes trigger re-render.
        // (text Y.Text is handled by bindYTextToContentEditable.)
        var itemObs = function (event) {
          var changed = event.changes && event.changes.keys;
          if (!changed) return;
          if (changed.has && (changed.has('depth') || changed.has('claim_id'))) {
            renderAll();
          } else if (typeof changed === 'object' && (changed.depth || changed.claim_id)) {
            renderAll();
          }
        };
        itemMap.observe(itemObs);

        itemUnbinds.push({
          itemUnobserve: function () { itemMap.unobserve(itemObs); },
          textUnbind: textUnbind,
          claimCleanup: claimCleanup,
        });

        container.appendChild(li);
      });

      applyPendingFocus();
    }

    var arrObserver = function () { renderAll(); };
    items.observe(arrObserver);

    renderAll();

    return {
      el: container,
      unbind: function () {
        teardownItems();
        try { items.unobserve(arrObserver); } catch (e) {}
      },
    };
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
    handle.title = 'Drag to reorder';
    handle.textContent = '⋮⋮';
    bar.appendChild(handle);
    /* V3.125 — drag-to-reorder + ↑/↓ buttons. */
    bar.appendChild(buildReorderControls(yBlock, ctx));
    wireDragHandle(handle, wrap, yBlock, ctx);

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

    /* V3.109 — Numbered toggle + label input. Numbering only applies
     * when display=true (inline equations have no number). The doc-order
     * walker in PaperEditor.getNumberedEquations assigns the actual
     * number; this block just renders the assigned number as a badge. */
    var numWrap = document.createElement('label');
    numWrap.className = 'pe-eq-num-toggle';
    numWrap.title = 'Number this equation so it can be referenced';
    var numCb = document.createElement('input');
    numCb.type = 'checkbox';
    numCb.checked = !!attrs.get('numbered');
    numCb.disabled = !ctx.editable;
    numCb.addEventListener('change', function () {
      yBlock.doc.transact(function () {
        attrs.set('numbered', !!numCb.checked);
        // Auto-flip to display when the user enables numbering — inline
        // equations can't be numbered.
        if (numCb.checked) attrs.set('display', true);
      }, 'eq-numbered-toggle');
    });
    var numLbl = document.createElement('span');
    numLbl.textContent = '#';
    numWrap.appendChild(numCb);
    numWrap.appendChild(numLbl);
    bar.appendChild(numWrap);

    var labelInput = document.createElement('input');
    labelInput.type = 'text';
    labelInput.className = 'pe-eq-label-input';
    labelInput.value = attrs.get('label') || '';
    labelInput.placeholder = 'eq:hookeslaw';
    labelInput.title = 'Label for cross-references — e.g. "eq:hookeslaw"';
    labelInput.disabled = !ctx.editable;
    var maxLen = (window.PaperSchemas && window.PaperSchemas.MAX_EQ_LABEL_LENGTH) || 64;
    labelInput.maxLength = maxLen;
    labelInput.addEventListener('change', function () {
      var v = (labelInput.value || '').trim();
      if (v && !/^eq:/.test(v)) {
        v = 'eq:' + v.replace(/[^a-z0-9_-]+/gi, '-').replace(/^-+|-+$/g, '').toLowerCase();
      }
      labelInput.value = v;
      yBlock.doc.transact(function () { attrs.set('label', v); }, 'eq-label');
    });
    bar.appendChild(labelInput);

    var numBadge = document.createElement('span');
    numBadge.className = 'pe-eq-num-badge';
    numBadge.hidden = true;
    bar.appendChild(numBadge);

    function reflectNumberBadge() {
      if (!attrs.get('numbered') || !attrs.get('display')) {
        numBadge.hidden = true;
        return;
      }
      var nums = (window.PaperEditor && window.PaperEditor.getNumberedEquations)
        ? window.PaperEditor.getNumberedEquations()
        : [];
      var hit = null;
      for (var i = 0; i < nums.length; i++) {
        if (nums[i].blockId === blockId) { hit = nums[i]; break; }
      }
      if (hit) {
        numBadge.hidden = false;
        numBadge.textContent = 'Eq. ' + hit.num;
      } else {
        numBadge.hidden = true;
      }
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
    var attrsObserver = function () {
      reflectMode();
      // V3.109 — keep the numbered checkbox + label + badge in sync
      // with remote changes (and our own writes since we don't use the
      // 'local-status' origin trick on these mutations).
      if (document.activeElement !== numCb) numCb.checked = !!attrs.get('numbered');
      if (document.activeElement !== labelInput) labelInput.value = attrs.get('label') || '';
      reflectNumberBadge();
    };
    attrs.observe(attrsObserver);

    /* V3.109 — re-render the number badge when the document order
     * changes (an equation block was added/deleted/reordered elsewhere
     * in the paper, shifting our number). */
    var onEquationsChanged = function () { reflectNumberBadge(); };
    window.addEventListener('paper-equations-changed', onEquationsChanged);

    if (ctx.registerSubscription) {
      ctx.registerSubscription(yBlock, function () {
        try { bodyUnbind(); } catch (e) {}
        try { yBlock.unobserve(blockObserver); } catch (e) {}
        try { attrs.unobserve(attrsObserver); } catch (e) {}
        window.removeEventListener('paper-equations-changed', onEquationsChanged);
      });
    }

    reflectMode();
    reflectNumberBadge();
    return wrap;
  }

  /* Figure block — image upload + caption + LaTeX render options (V3.102).
   *
   * Schema: yBlock has
   *   body: Y.Text      → caption (uses paragraph render contract: math + cite)
   *   attrs: Y.Map {
   *     storage_path,    // 'paper-figures/{paperId}/{shortHash}.{ext}'
   *     download_url,    // resolved Storage URL
   *     hash, mime,      // dedup metadata
   *     width,           // LaTeX width spec, e.g. '\\linewidth'
   *     placement,       // 'H' | 'h' | 't' | 'b' | 'p'
   *     centering,       // bool
   *     label,           // 'fig:foo'
   *     alt,             // accessibility text
   *     raw_tex,         // legacy: imported figures preserve their .tex
   *   }
   *
   * Upload uses window.PAPER_FIGURES.uploadImage which dedups by SHA-256 and
   * never re-bills bytes for the same content.
   */
  /* V3.127 — figure block is a thin doc-side preview. All editing
   * (upload, caption, layout, label, numbered toggle, subfigures)
   * lives in the panel's Figures tab. The Edit-in-panel ↗ link is the
   * only interactive entry point on this block (besides reorder + delete). */
  function renderFigure(yBlock, ctx) {
    var Y = ctx.Y;
    var blockId = yBlock.get('id');
    var attrs = yBlock.get('attrs');
    if (!attrs) {
      yBlock.doc.transact(function () { yBlock.set('attrs', new Y.Map()); }, 'init-fig-attrs');
      attrs = yBlock.get('attrs');
    }

    var wrap = document.createElement('div');
    wrap.className = 'pe-block pe-block-figure pe-figure-preview-only';
    wrap.dataset.blockId = blockId;
    wrap.dataset.kind = 'figure';

    /* Toolbar */
    var bar = document.createElement('div');
    bar.className = 'pe-block-toolbar';

    var handle = document.createElement('span');
    handle.className = 'pe-block-handle';
    handle.title = 'Drag to reorder';
    handle.textContent = '⋮⋮';
    bar.appendChild(handle);
    /* V3.125 — drag-to-reorder + ↑/↓ buttons. */
    bar.appendChild(buildReorderControls(yBlock, ctx));
    wireDragHandle(handle, wrap, yBlock, ctx);

    var kindTag = document.createElement('span');
    kindTag.className = 'pe-section-kind';
    kindTag.textContent = 'Figure';
    bar.appendChild(kindTag);

    /* V3.115 — Numbered toggle + label input + Fig. # badge in the
     * toolbar so the writer can opt out of numbering and reference the
     * figure from prose. Mirrors the V3.109 equation toolbar shape. */
    var numWrap = document.createElement('label');
    numWrap.className = 'pe-eq-num-toggle';
    numWrap.title = 'Number this figure (gives it a Fig. N badge that can be cross-referenced)';
    var numCb = document.createElement('input');
    numCb.type = 'checkbox';
    numCb.checked = attrs.get('numbered') !== false;
    numCb.disabled = !ctx.editable;
    numCb.addEventListener('change', function () {
      yBlock.doc.transact(function () {
        attrs.set('numbered', !!numCb.checked);
      }, 'fig-numbered-toggle');
    });
    var numLbl = document.createElement('span');
    numLbl.textContent = '#';
    numWrap.appendChild(numCb);
    numWrap.appendChild(numLbl);
    bar.appendChild(numWrap);

    var labelInput = document.createElement('input');
    labelInput.type = 'text';
    labelInput.className = 'pe-eq-label-input';
    labelInput.value = attrs.get('label') || '';
    labelInput.placeholder = 'fig:cellgrowth';
    labelInput.title = 'Label for cross-references — e.g. "fig:cellgrowth"';
    labelInput.disabled = !ctx.editable;
    labelInput.addEventListener('change', function () {
      var v = (labelInput.value || '').trim();
      if (v && !/^fig:/.test(v)) {
        v = 'fig:' + v.replace(/[^a-z0-9_-]+/gi, '-').replace(/^-+|-+$/g, '').toLowerCase();
      }
      labelInput.value = v;
      yBlock.doc.transact(function () { attrs.set('label', v); }, 'fig-label');
    });
    bar.appendChild(labelInput);

    var numBadge = document.createElement('span');
    numBadge.className = 'pe-fig-num-badge';
    numBadge.hidden = true;
    bar.appendChild(numBadge);

    /* V3.125 — "Edit in panel" link directs the user to the Figures
     * tab where the canonical editor lives. Inline editing of the
     * doc-side block still works (back-compat) but the panel is the
     * recommended surface. */
    if (ctx.editable) {
      var editPanelBtn = document.createElement('button');
      editPanelBtn.type = 'button';
      editPanelBtn.className = 'pe-edit-in-panel-btn';
      editPanelBtn.textContent = 'Edit in panel ↗';
      editPanelBtn.title = 'Open the Figures tab in the side panel and scroll to this figure';
      editPanelBtn.addEventListener('click', function (e) {
        e.preventDefault();
        if (!window.PaperEquations) return;
        window.PaperEquations.showPanel && window.PaperEquations.showPanel();
        window.PaperEquations.setActiveTab && window.PaperEquations.setActiveTab('figures');
        if (window.PaperEquations.scrollToFigureRow) {
          setTimeout(function () { window.PaperEquations.scrollToFigureRow(blockId); }, 50);
        }
      });
      bar.appendChild(editPanelBtn);
    }

    function reflectFigNumberBadge() {
      if (attrs.get('numbered') === false) {
        numBadge.hidden = true;
        return;
      }
      var nums = (window.PaperEditor && window.PaperEditor.getNumberedFigures)
        ? window.PaperEditor.getNumberedFigures()
        : [];
      var hit = null;
      for (var i = 0; i < nums.length; i++) {
        if (nums[i].blockId === blockId) { hit = nums[i]; break; }
      }
      if (hit) {
        numBadge.hidden = false;
        numBadge.textContent = 'Fig. ' + hit.num;
      } else {
        numBadge.hidden = true;
      }
    }
    reflectFigNumberBadge();

    /* Status pill */
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
    delBtn.title = 'Delete figure';
    delBtn.textContent = '✕';
    delBtn.addEventListener('click', function () {
      if (!ctx.editable) return;
      ctx.onDelete(blockId);
    });
    if (!ctx.editable) delBtn.disabled = true;
    actions.appendChild(delBtn);
    bar.appendChild(actions);

    wrap.appendChild(bar);

    /* Image preview frame + upload control */
    var preview = document.createElement('div');
    preview.className = 'pe-figure-preview';
    var img = document.createElement('img');
    img.className = 'pe-figure-img';
    img.alt = attrs.get('alt') || '';
    var emptyHint = document.createElement('div');
    emptyHint.className = 'pe-figure-empty';
    emptyHint.textContent = 'No image yet — click Upload to attach one.';
    preview.appendChild(img);
    preview.appendChild(emptyHint);

    function reflectImage() {
      var url = attrs.get('download_url') || '';
      if (url) {
        img.src = url;
        img.style.display = '';
        emptyHint.style.display = 'none';
      } else {
        img.removeAttribute('src');
        img.style.display = 'none';
        emptyHint.style.display = '';
      }
      img.alt = attrs.get('alt') || '';
    }
    reflectImage();

    /* Upload row */
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
    uploadBtn.addEventListener('click', function () {
      if (!ctx.editable) return;
      fileInput.click();
    });
    if (!ctx.editable) uploadBtn.disabled = true;

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
      if (!ctx.paperId) {
        statusEl.textContent = 'No paper id — cannot upload.';
        return;
      }
      uploadBtn.disabled = true;
      statusEl.textContent = 'Uploading…';
      try {
        var info = await window.PAPER_FIGURES.uploadImage(ctx.paperId, f);
        yBlock.doc.transact(function () {
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
        console.warn('[paper-figures] upload failed:', err);
        statusEl.textContent = 'Upload failed: ' + (err.message || err);
      } finally {
        uploadBtn.disabled = !ctx.editable;
      }
    });

    uploadRow.appendChild(fileInput);
    uploadRow.appendChild(uploadBtn);
    uploadRow.appendChild(statusEl);

    /* Layout (placement / width / centering / label / alt) — collapsible */
    var layoutDetails = document.createElement('details');
    layoutDetails.className = 'pe-figure-layout';
    var layoutSummary = document.createElement('summary');
    layoutSummary.textContent = 'Layout (LaTeX render options)';
    layoutDetails.appendChild(layoutSummary);

    var layoutGrid = document.createElement('div');
    layoutGrid.className = 'pe-figure-layout-grid';

    function mkField(labelText, control) {
      var row = document.createElement('label');
      row.className = 'pe-figure-field';
      var lbl = document.createElement('span');
      lbl.textContent = labelText;
      row.appendChild(lbl);
      row.appendChild(control);
      return row;
    }

    /* width — text input with common presets surfaced via datalist */
    var widthInput = document.createElement('input');
    widthInput.type = 'text';
    widthInput.value = attrs.get('width') || '\\linewidth';
    widthInput.placeholder = '\\linewidth';
    widthInput.disabled = !ctx.editable;
    var widthList = document.createElement('datalist');
    widthList.id = 'pe-fig-width-' + blockId;
    ['\\linewidth', '0.8\\linewidth', '0.5\\linewidth', '\\textwidth', '0.9\\textwidth', '\\columnwidth'].forEach(function (w) {
      var o = document.createElement('option');
      o.value = w;
      widthList.appendChild(o);
    });
    widthInput.setAttribute('list', widthList.id);
    widthInput.addEventListener('change', function () {
      yBlock.doc.transact(function () { attrs.set('width', widthInput.value || '\\linewidth'); }, 'fig-width');
    });

    /* placement select */
    var placeSel = document.createElement('select');
    placeSel.disabled = !ctx.editable;
    ['H', 'h', 't', 'b', 'p'].forEach(function (p) {
      var o = document.createElement('option');
      o.value = p;
      o.textContent = p + ({ H: ' — here, exactly', h: ' — here', t: ' — top', b: ' — bottom', p: ' — own page' }[p] || '');
      placeSel.appendChild(o);
    });
    placeSel.value = attrs.get('placement') || 'H';
    placeSel.addEventListener('change', function () {
      yBlock.doc.transact(function () { attrs.set('placement', placeSel.value); }, 'fig-placement');
    });

    /* centering checkbox */
    var centerWrap = document.createElement('label');
    centerWrap.className = 'pe-figure-checkbox';
    var centerCb = document.createElement('input');
    centerCb.type = 'checkbox';
    centerCb.checked = attrs.get('centering') !== false;
    centerCb.disabled = !ctx.editable;
    centerCb.addEventListener('change', function () {
      yBlock.doc.transact(function () { attrs.set('centering', !!centerCb.checked); }, 'fig-center');
    });
    var centerLbl = document.createElement('span');
    centerLbl.textContent = '\\centering';
    centerWrap.appendChild(centerCb);
    centerWrap.appendChild(centerLbl);

    /* label */
    var labelInput = document.createElement('input');
    labelInput.type = 'text';
    labelInput.value = attrs.get('label') || '';
    labelInput.placeholder = 'fig:cellgrowth';
    labelInput.disabled = !ctx.editable;
    labelInput.addEventListener('change', function () {
      var v = (labelInput.value || '').trim();
      // normalize: prepend 'fig:' if user typed bare slug
      if (v && !/^fig:/.test(v)) v = 'fig:' + v.replace(/[^a-z0-9_-]+/gi, '-').replace(/^-+|-+$/g, '').toLowerCase();
      labelInput.value = v;
      yBlock.doc.transact(function () { attrs.set('label', v); }, 'fig-label');
    });

    /* alt text */
    var altInput = document.createElement('input');
    altInput.type = 'text';
    altInput.value = attrs.get('alt') || '';
    altInput.placeholder = 'Brief description of the image';
    altInput.disabled = !ctx.editable;
    altInput.addEventListener('change', function () {
      yBlock.doc.transact(function () { attrs.set('alt', altInput.value || ''); }, 'fig-alt');
    });

    layoutGrid.appendChild(mkField('Width', widthInput));
    layoutGrid.appendChild(widthList);
    layoutGrid.appendChild(mkField('Placement', placeSel));
    layoutGrid.appendChild(mkField('', centerWrap));
    layoutGrid.appendChild(mkField('Label', labelInput));
    layoutGrid.appendChild(mkField('Alt text', altInput));
    layoutDetails.appendChild(layoutGrid);

    /* Caption (Y.Text body) */
    var captionLbl = document.createElement('div');
    captionLbl.className = 'pe-figure-caption-label';
    captionLbl.textContent = 'Caption';
    var captionEl = document.createElement('div');
    captionEl.className = 'pe-block-content pe-figure-caption';
    captionEl.dataset.placeholder = 'Figure caption — supports $math$ and [@cite] tokens.';
    var bodyY = yBlock.get('body');
    if (!(bodyY instanceof Y.Text)) {
      yBlock.doc.transact(function () { yBlock.set('body', new Y.Text('')); }, 'init-fig-body');
      bodyY = yBlock.get('body');
    }
    /* V3.127 — caption is read-only on the doc-side block; the panel
     * is the canonical editor. The bound Y.Text observer still updates
     * the rendered HTML when the panel-side editor edits flow through. */
    var captionUnbind = window.PaperEditor.bindYTextToContentEditable(bodyY, captionEl, {
      readOnly: true,
      renderHtml: window.PaperEditor.renderParagraphHtml,
    });

    /* Legacy raw_tex hint: when a figure was imported with attrs.raw_tex but
     * has no storage_path, surface the .tex source as read-only context so
     * the user can rebuild from it. */
    var rawTexNote = null;
    var rawTex = attrs.get('raw_tex');
    if (rawTex && !attrs.get('storage_path')) {
      rawTexNote = document.createElement('details');
      rawTexNote.className = 'pe-figure-rawtex';
      var s = document.createElement('summary');
      s.textContent = 'Imported LaTeX (read-only)';
      rawTexNote.appendChild(s);
      var pre = document.createElement('pre');
      pre.textContent = rawTex;
      rawTexNote.appendChild(pre);
    }

    wrap.appendChild(preview);
    wrap.appendChild(uploadRow);
    wrap.appendChild(layoutDetails);
    wrap.appendChild(captionLbl);
    wrap.appendChild(captionEl);
    if (rawTexNote) wrap.appendChild(rawTexNote);

    /* Observers */
    var blockObserver = function () {
      pill.dataset.status = yBlock.get('status') || 'draft';
      pill.textContent = labelForStatus(pill.dataset.status);
    };
    yBlock.observe(blockObserver);

    var attrsObserver = function () {
      reflectImage();
      // Reflect remote attr edits into the form fields (skip if user is
      // currently focused on that input to avoid clobbering in-flight typing).
      if (document.activeElement !== widthInput) widthInput.value = attrs.get('width') || '\\linewidth';
      if (document.activeElement !== placeSel)   placeSel.value = attrs.get('placement') || 'H';
      if (document.activeElement !== centerCb)   centerCb.checked = attrs.get('centering') !== false;
      if (document.activeElement !== labelInput) labelInput.value = attrs.get('label') || '';
      if (document.activeElement !== altInput)   altInput.value = attrs.get('alt') || '';
      uploadBtn.textContent = attrs.get('storage_path') ? 'Replace image' : 'Upload image';
      // V3.115 — also reflect the numbered checkbox + Fig. # badge.
      if (document.activeElement !== numCb) numCb.checked = attrs.get('numbered') !== false;
      reflectFigNumberBadge();
    };
    attrs.observe(attrsObserver);

    /* V3.115 — re-render the Fig. # badge when the document order
     * changes (a figure block was added/deleted/reordered elsewhere
     * shifting our number). Listens for both the legacy event name
     * and the new V3.115 name during the back-compat window. */
    var onPanelChanged = function () { reflectFigNumberBadge(); };
    window.addEventListener('paper-panel-changed', onPanelChanged);
    window.addEventListener('paper-equations-changed', onPanelChanged);

    if (ctx.registerSubscription) {
      ctx.registerSubscription(yBlock, function () {
        try { captionUnbind(); } catch (e) {}
        try { yBlock.unobserve(blockObserver); } catch (e) {}
        try { attrs.unobserve(attrsObserver); } catch (e) {}
        window.removeEventListener('paper-panel-changed', onPanelChanged);
        window.removeEventListener('paper-equations-changed', onPanelChanged);
      });
    }

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

    /* V3.120 — idempotent migration: caption used to be a string;
     * promote to Y.Text once so the writer can edit collaboratively. */
    var captionY = attrs.get('caption');
    if (captionY != null && !(captionY instanceof Y.Text)) {
      var oldCaption = String(captionY || '');
      yBlock.doc.transact(function () {
        var t = new Y.Text();
        if (oldCaption) t.insert(0, oldCaption);
        attrs.set('caption', t);
      }, 'table-caption-migrate-v3.119');
      captionY = attrs.get('caption');
    } else if (captionY == null) {
      yBlock.doc.transact(function () { attrs.set('caption', new Y.Text('')); }, 'init-table-caption');
      captionY = attrs.get('caption');
    }

    var wrap = document.createElement('div');
    wrap.className = 'pe-block pe-block-table pe-table-preview-only';
    wrap.dataset.blockId = blockId;
    wrap.dataset.kind = 'table';

    /* Toolbar */
    var bar = document.createElement('div');
    bar.className = 'pe-block-toolbar';
    var handle = document.createElement('span');
    handle.className = 'pe-block-handle';
    handle.title = 'Drag to reorder';
    handle.textContent = '⋮⋮';
    bar.appendChild(handle);
    /* V3.125 — drag-to-reorder + ↑/↓ buttons. */
    bar.appendChild(buildReorderControls(yBlock, ctx));
    wireDragHandle(handle, wrap, yBlock, ctx);
    var kindTag = document.createElement('span');
    kindTag.className = 'pe-section-kind';
    kindTag.textContent = 'Table';
    bar.appendChild(kindTag);

    /* V3.120 — Numbered toggle + label input + Tab. # badge mirroring
     * the V3.109 equation toolbar / V3.115 figure toolbar. */
    var numWrap = document.createElement('label');
    numWrap.className = 'pe-eq-num-toggle';
    numWrap.title = 'Number this table (gives it a Tab. N badge that can be cross-referenced)';
    var numCb = document.createElement('input');
    numCb.type = 'checkbox';
    numCb.checked = attrs.get('numbered') !== false;
    numCb.disabled = !ctx.editable;
    numCb.addEventListener('change', function () {
      yBlock.doc.transact(function () {
        attrs.set('numbered', !!numCb.checked);
      }, 'tab-numbered-toggle');
    });
    var numLbl = document.createElement('span');
    numLbl.textContent = '#';
    numWrap.appendChild(numCb);
    numWrap.appendChild(numLbl);
    bar.appendChild(numWrap);

    var labelInput = document.createElement('input');
    labelInput.type = 'text';
    labelInput.className = 'pe-eq-label-input';
    labelInput.value = attrs.get('label') || '';
    labelInput.placeholder = 'tab:cellcounts';
    labelInput.title = 'Label for cross-references — e.g. "tab:cellcounts"';
    labelInput.disabled = !ctx.editable;
    labelInput.addEventListener('change', function () {
      var v = (labelInput.value || '').trim();
      if (v && !/^tab:/.test(v)) {
        v = 'tab:' + v.replace(/[^a-z0-9_-]+/gi, '-').replace(/^-+|-+$/g, '').toLowerCase();
      }
      labelInput.value = v;
      yBlock.doc.transact(function () { attrs.set('label', v); }, 'tab-label');
    });
    bar.appendChild(labelInput);

    var numBadge = document.createElement('span');
    numBadge.className = 'pe-tab-num-badge';
    numBadge.hidden = true;
    bar.appendChild(numBadge);

    function reflectTabNumberBadge() {
      if (attrs.get('numbered') === false) {
        numBadge.hidden = true;
        return;
      }
      var nums = (window.PaperEditor && window.PaperEditor.getNumberedTables)
        ? window.PaperEditor.getNumberedTables()
        : [];
      var hit = null;
      for (var i = 0; i < nums.length; i++) {
        if (nums[i].blockId === blockId) { hit = nums[i]; break; }
      }
      if (hit) {
        numBadge.hidden = false;
        numBadge.textContent = 'Tab. ' + hit.num;
      } else {
        numBadge.hidden = true;
      }
    }
    reflectTabNumberBadge();

    /* V3.125 — "Edit in panel" link directs to the Tables tab where
     * the panel-side editor lives. */
    if (ctx.editable) {
      var tabEditPanelBtn = document.createElement('button');
      tabEditPanelBtn.type = 'button';
      tabEditPanelBtn.className = 'pe-edit-in-panel-btn';
      tabEditPanelBtn.textContent = 'Edit in panel ↗';
      tabEditPanelBtn.title = 'Open the Tables tab in the side panel and scroll to this table';
      tabEditPanelBtn.addEventListener('click', function (e) {
        e.preventDefault();
        if (!window.PaperEquations) return;
        window.PaperEquations.showPanel && window.PaperEquations.showPanel();
        window.PaperEquations.setActiveTab && window.PaperEquations.setActiveTab('tables');
        if (window.PaperEquations.scrollToTableRow) {
          setTimeout(function () { window.PaperEquations.scrollToTableRow(blockId); }, 50);
        }
      });
      bar.appendChild(tabEditPanelBtn);
    }

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

    /* V3.120 — styling toolbar (booktabs / header row / per-column align). */
    var styleBar = document.createElement('div');
    styleBar.className = 'pe-table-stylebar';
    if (ctx.editable) {
      var bookWrap = document.createElement('label');
      bookWrap.className = 'pe-table-style-cb';
      var bookCb = document.createElement('input');
      bookCb.type = 'checkbox';
      bookCb.checked = attrs.get('booktabs') !== false;
      bookCb.addEventListener('change', function () {
        yBlock.doc.transact(function () {
          attrs.set('booktabs', !!bookCb.checked);
        }, 'tab-booktabs');
      });
      bookWrap.appendChild(bookCb);
      var bookLbl = document.createElement('span');
      bookLbl.textContent = 'booktabs';
      bookWrap.appendChild(bookLbl);
      styleBar.appendChild(bookWrap);

      var headWrap = document.createElement('label');
      headWrap.className = 'pe-table-style-cb';
      var headCb = document.createElement('input');
      headCb.type = 'checkbox';
      headCb.checked = attrs.get('header_row') !== false;
      headCb.addEventListener('change', function () {
        yBlock.doc.transact(function () {
          attrs.set('header_row', !!headCb.checked);
        }, 'tab-header-row');
      });
      headWrap.appendChild(headCb);
      var headLbl = document.createElement('span');
      headLbl.textContent = 'header row';
      headWrap.appendChild(headLbl);
      styleBar.appendChild(headWrap);

      /* Per-column alignment buttons. attrs.align is a string of length
       * cols, each char in {l, c, r}. Default = all 'l' (left). When
       * cols mismatch (legacy table), regenerate as all-l on click. */
      var alignWrap = document.createElement('div');
      alignWrap.className = 'pe-table-align-wrap';
      var alignLbl = document.createElement('span');
      alignLbl.className = 'pe-table-style-label';
      alignLbl.textContent = 'columns:';
      alignWrap.appendChild(alignLbl);
      function buildAlignButtons() {
        // Clear existing column buttons (keep the label).
        var btns = alignWrap.querySelectorAll('.pe-table-align-col');
        btns.forEach(function (b) { b.parentElement && b.parentElement.removeChild(b); });
        var cols = attrs.get('cols') || 0;
        var alignStr = (attrs.get('align') || '').slice(0, cols);
        while (alignStr.length < cols) alignStr += 'l';
        for (var c = 0; c < cols; c++) {
          var col = c;
          var grp = document.createElement('span');
          grp.className = 'pe-table-align-col';
          ['l', 'c', 'r'].forEach(function (a) {
            var btn = document.createElement('button');
            btn.type = 'button';
            btn.className = 'pe-table-align-btn';
            btn.dataset.col = String(col);
            btn.dataset.align = a;
            btn.textContent = a.toUpperCase();
            if (alignStr[col] === a) btn.classList.add('active');
            btn.addEventListener('click', function () {
              var current = (attrs.get('align') || '').slice(0, attrs.get('cols') || 0);
              while (current.length < (attrs.get('cols') || 0)) current += 'l';
              var newStr = current.slice(0, col) + a + current.slice(col + 1);
              yBlock.doc.transact(function () { attrs.set('align', newStr); }, 'tab-align');
            });
            grp.appendChild(btn);
          });
          alignWrap.appendChild(grp);
        }
      }
      buildAlignButtons();
      styleBar.appendChild(alignWrap);
    }

    wrap.appendChild(styleBar);

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
          /* V3.127 — table cells are read-only on the doc-side block;
           * editing happens in the panel's Tables tab. */
          var unbind = window.PaperEditor.bindYTextToContentEditable(cellY, cellEl, {
            readOnly: true,
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

    /* V3.120 — caption editor below the grid. Bound to attrs.caption
     * Y.Text via the standard paragraph render contract so cite + math
     * + markdown all work in captions. */
    var capLabel = document.createElement('div');
    capLabel.className = 'pe-table-caption-label';
    capLabel.textContent = 'Caption';
    wrap.appendChild(capLabel);

    var capEl = document.createElement('div');
    capEl.className = 'pe-block-content pe-table-caption';
    capEl.dataset.placeholder = 'Table caption — supports $math$, [@cite], **bold**, etc.';
    /* V3.127 — table caption is read-only on the doc-side block. */
    var capUnbind = window.PaperEditor.bindYTextToContentEditable(captionY, capEl, {
      readOnly: true,
      renderHtml: window.PaperEditor.renderParagraphHtml,
    });
    wrap.appendChild(capEl);

    /* V3.120 — bind the right-click menu so users can insert references
     * from the caption text just like in paragraph bodies. */
    if (ctx.editable && window.PaperEquations && window.PaperEquations.bindContextMenu) {
      window.PaperEquations.bindContextMenu(capEl);
    }

    /* Observers */
    var blockObserver = function () {
      pill.dataset.status = yBlock.get('status') || 'draft';
      pill.textContent = labelForStatus(pill.dataset.status);
    };
    yBlock.observe(blockObserver);
    var attrsObserver = function () {
      // V3.120 — reflect Numbered / label / number badge / styling
      // remote edits without clobbering in-flight typing.
      if (document.activeElement !== numCb) numCb.checked = attrs.get('numbered') !== false;
      if (document.activeElement !== labelInput) labelInput.value = attrs.get('label') || '';
      reflectTabNumberBadge();
      // Otherwise full re-render (rows/cols/cells changes).
      ctx.requestRender && ctx.requestRender();
    };
    attrs.observe(attrsObserver);
    var cellsMap = attrs.get('cells');
    var cellsObserver = function () { ctx.requestRender && ctx.requestRender(); };
    if (cellsMap instanceof Y.Map) cellsMap.observe(cellsObserver);

    /* V3.120 — refresh the Tab. # badge when doc order shifts. */
    var onPanelChanged = function () { reflectTabNumberBadge(); };
    window.addEventListener('paper-panel-changed', onPanelChanged);

    if (ctx.registerSubscription) {
      ctx.registerSubscription(yBlock, function () {
        cellUnbinds.forEach(function (u) { try { u(); } catch (e) {} });
        try { capUnbind(); } catch (e) {}
        try { yBlock.unobserve(blockObserver); } catch (e) {}
        try { attrs.unobserve(attrsObserver); } catch (e) {}
        if (cellsMap instanceof Y.Map) {
          try { cellsMap.unobserve(cellsObserver); } catch (e) {}
        }
        window.removeEventListener('paper-panel-changed', onPanelChanged);
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

  /* V3.125 — shared reorder controls for any block toolbar. Returns a
   * fragment with ↑ / ↓ arrow buttons. The drag handle (`⋮⋮`) on the
   * existing toolbar is wired separately by `wireDragHandle(handle,
   * yBlock, ctx)` below — call from each renderXxx after creating the
   * handle. Both routes call PaperEditor.moveBlock* with ctx.sectionId. */
  function buildReorderControls(yBlock, ctx) {
    var frag = document.createDocumentFragment();
    if (!ctx.editable) return frag;
    var up = document.createElement('button');
    up.type = 'button';
    up.className = 'pe-block-arrow-btn';
    up.title = 'Move up';
    up.textContent = '↑';
    up.addEventListener('click', function (e) {
      e.preventDefault();
      if (window.PaperEditor && window.PaperEditor.moveBlockUp) {
        window.PaperEditor.moveBlockUp(ctx.sectionId, yBlock.get('id'));
      }
    });
    var down = document.createElement('button');
    down.type = 'button';
    down.className = 'pe-block-arrow-btn';
    down.title = 'Move down';
    down.textContent = '↓';
    down.addEventListener('click', function (e) {
      e.preventDefault();
      if (window.PaperEditor && window.PaperEditor.moveBlockDown) {
        window.PaperEditor.moveBlockDown(ctx.sectionId, yBlock.get('id'));
      }
    });
    frag.appendChild(up);
    frag.appendChild(down);
    return frag;
  }

  /* V3.125 — wire drag-and-drop on a `⋮⋮` handle so the user can drop
   * the block on another block in the same section to reorder. */
  function wireDragHandle(handle, blockEl, yBlock, ctx) {
    if (!ctx.editable) return;
    handle.draggable = true;
    handle.style.cursor = 'grab';
    var blockId = yBlock.get('id');
    var sectionId = ctx.sectionId;
    handle.addEventListener('dragstart', function (e) {
      e.dataTransfer.effectAllowed = 'move';
      e.dataTransfer.setData('text/x-pe-block', JSON.stringify({
        sectionId: sectionId,
        blockId: blockId,
      }));
      blockEl.classList.add('is-drag-source');
    });
    handle.addEventListener('dragend', function () {
      blockEl.classList.remove('is-drag-source');
    });
    /* The block itself accepts drops. */
    blockEl.addEventListener('dragover', function (e) {
      // Only accept our own drag type.
      var types = e.dataTransfer && e.dataTransfer.types;
      if (!types || !Array.prototype.indexOf.call(types, 'text/x-pe-block') >= 0) return;
      e.preventDefault();
      e.dataTransfer.dropEffect = 'move';
      blockEl.classList.add('is-drop-target');
    });
    blockEl.addEventListener('dragleave', function () {
      blockEl.classList.remove('is-drop-target');
    });
    blockEl.addEventListener('drop', function (e) {
      blockEl.classList.remove('is-drop-target');
      var raw;
      try { raw = e.dataTransfer.getData('text/x-pe-block'); } catch (er) { return; }
      if (!raw) return;
      var data;
      try { data = JSON.parse(raw); } catch (er) { return; }
      if (!data || data.sectionId !== sectionId) return;  // cross-section out of scope
      if (data.blockId === blockId) return;
      e.preventDefault();
      if (window.PaperEditor && window.PaperEditor.moveBlockBefore) {
        window.PaperEditor.moveBlockBefore(sectionId, data.blockId, blockId);
      }
    });
  }

  /* V3.107 buildRichToolbar() retired in V3.120 — the per-paragraph
   * rich-text toolbar is replaced by the single global toolbar at the
   * top of the editor (see paper-equations.js _installGlobalToolbar).
   * Cmd+B/I/E keybinds still work via richTextKeydownHandler bound on
   * the body contenteditable. */

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
