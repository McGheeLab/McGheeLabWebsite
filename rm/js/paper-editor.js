/* paper-editor.js — Phase B controller backed by Yjs CRDT.
 *
 * State lives in a Y.Doc connected to Firestore by paper-yjs.js. Local
 * mutations happen inside `yDoc.transact()` and are sent to the server via
 * the throttled provider; remote updates arrive via Firestore onSnapshot and
 * are applied to the same Y.Doc. Two contracts hold the editor together:
 *
 *  - Structural observers re-render the affected subtree (add/remove block,
 *    status flag change, section reorder).
 *  - Y.Text bindings on paragraph skeleton/body/label update the bound DOM
 *    element in place; they do NOT trigger a re-render. This prevents
 *    typing-clobber when remote characters arrive mid-keystroke.
 *
 * Phase A → Phase B migration: on first connect by an admin or lead author,
 * if the Y.Doc is empty AND the legacy `papers/{paperId}/draft/tree` doc has
 * content, we replay the legacy tree into Y types in one transaction. The
 * legacy doc is left in place as a backup.
 */

(function () {
  /* ── State ── */

  // V3.60: paper id moved from ?id= to ?paper= when paper-editor.html
  // merged into paper-builder.html. Accept both for redirect-bookmark
  // survival; prefer the new ?paper= form.
  var _qp = new URLSearchParams(window.location.search);
  var paramId = _qp.get('paper') || _qp.get('id') || '';
  var state = {
    paperId: paramId,
    meta: null,
    conn: null,           // result of PaperYjs.connect (yDoc + presence)
    Y: null,              // Yjs module (cached after connect)
    paperMap: null,       // yDoc.getMap('paper')
    titleY: null,         // Y.Text under paperMap.get('meta')
    sectionsArr: null,    // Y.Array under paperMap.get('sections')
    editable: false,
    viewFilter: 'mixed',
    statusFilter: 'all',  // 'all' | 'draft' | 'needs-review' | 'complete' | 'not-complete'
    activeSectionId: null,
    presenceList: [],
    blockSubscriptions: [], // [{yMap, unobserve}] for cleanup on re-render
  };

  /* ── DOM refs ── */

  var titleInput     = document.getElementById('pe-title');
  var saveStateEl    = document.getElementById('pe-savestate');
  var readonlyBanner = document.getElementById('pe-readonly-banner');
  var outlineEl      = document.getElementById('pe-outline');
  /* V3.197 — sidebar paragraph-skeleton mirror lives in the second
   * tab; the tab nav lets the user flip between "Outline" (sections
   * list) and "Paragraph" (skeleton bullets of the focused block). */
  var paragraphSkelEl = document.getElementById('pe-paragraph-skel');
  var contentEl      = document.getElementById('pe-content');
  var addSectionBtn  = document.getElementById('pe-add-section-btn');
  var viewFilterSel  = document.getElementById('pe-view-filter');
  var statusFilterSel= document.getElementById('pe-status-filter');
  var topbarEl       = document.querySelector('.pe-topbar');

  /* Presence row + invite button + reset + export buttons live in the topbar; created on demand. */
  var presenceRowEl = null;
  var inviteBtnEl   = null;
  var resetBtnEl    = null;
  var exportBtnEl   = null;
  var versionsBtnEl = null;
  var commentsBtnEl = null;
  var hasImportFile = false;  // detected during connect

  /* ── Boot ── */

  if (!paramId) {
    contentEl.innerHTML = '<div class="empty-state">Missing paper id. <a href="/rm/pages/paper-builder.html">Back to papers</a>.</div>';
    return;
  }

  // V3.319 — first-edit-of-day activity event (FuturePlan 04 B1). Any
  // input inside the editor stamps one lightweight event per paper per
  // day (deterministic doc id = idempotent); no hours, no confirm.
  var _actStampedDate = '';
  document.addEventListener('input', function () {
    if (!window.ActivitySignals || !state.editable) return;
    var today = new Date().toISOString().slice(0, 10);
    if (_actStampedDate === today) return;
    _actStampedDate = today;
    ActivitySignals.recordWork({
      source: 'rm-paper-editor',
      sourceRef: { kind: 'paper', id: state.paperId },
      text: 'Paper: ' + ((state.meta && state.meta.title) || state.paperId),
      categoryPath: ['research', 'paper-writing'],
    });
  }, true);

  loadMeta().then(function () {
    if (typeof firebridge === 'undefined') {
      showReadonlyBanner('Firebase is not loaded — paper edits cannot be saved.');
      return;
    }
    firebridge.onAuth(function () {
      // Auth callback fires once with (null,null) and again once a user resolves.
      // Connect on the second fire (when we actually have a user); show a
      // "sign in to load" banner on the first.
      var user = firebridge.getUser();
      if (!user) {
        showReadonlyBanner('Sign in to the website (top-right avatar) to load and edit this paper.');
        renderPlaceholder();
        return;
      }
      // Already connected? Don't re-connect on subsequent auth fires.
      if (state.conn) return;
      connectAndRender().catch(function (err) {
        console.error('[paper-editor] connect failed:', err);
        var msg = err && err.message ? err.message : String(err);
        // Permission errors get a hint pointing at the rules workflow.
        if (/permission|insufficient/i.test(msg)) {
          showReadonlyBanner('Firestore permissions block this paper. Edit ' +
            'firestore.rules in the McGheeLabWebsite repo, then run ' +
            '`firebase deploy --only firestore:rules` and reload. ' +
            'Raw error: ' + msg);
        } else {
          showReadonlyBanner('Failed to load paper: ' + msg);
        }
        renderPlaceholder();
      });
    });
  });

  /* ── Load metadata ── */

  async function loadMeta() {
    try {
      var data = await api.load('projects/papers.json');
      var rows = (data && data.papers) || [];
      var found = rows.find(function (p) { return p.id === paramId; });
      if (!found) {
        contentEl.innerHTML = '<div class="empty-state">Paper "' + escapeHtml(paramId) +
          '" not found. <a href="/rm/pages/paper-builder.html">Back to papers</a>.</div>';
        return;
      }
      state.meta = found;
      titleInput.value = found.title || '';
      document.title = (found.title || 'Paper') + ' — Editor';
    } catch (err) {
      contentEl.innerHTML = '<div class="empty-state">Failed to load paper metadata: ' + escapeHtml(err.message) + '</div>';
    }
  }

  /* ── Connect ── */

  async function connectAndRender() {
    if (!state.meta) return;
    var canEdit = firebridge.canEditPaper(state.meta);
    state.editable = !!canEdit;

    // Diagnostic for the most common "I'm signed in as admin but the editor
    // says I'm not" case — surface exactly what firebridge thinks about
    // your profile in the banner so we can tell whether the issue is a
    // missing users/{uid} doc, a wrong role field, or a stale auth state.
    var user = firebridge.getUser();
    var profile = firebridge.getProfile();
    var who = user ? (profile && profile.name ? profile.name + ' <' + user.email + '>' : user.email) : 'nobody';
    var role = profile ? (profile.role || '(no role field)') : '(no users/' + (user ? user.uid : '?') + ' doc)';
    console.log('[paper-editor] auth state',
      { uid: user && user.uid, email: user && user.email, profile: profile,
        isAdmin: firebridge.isAdmin(),
        leadAuthorUid: state.meta.lead_author_uid,
        coauthorUids: state.meta.coauthor_uids,
        canEdit: canEdit });

    if (!canEdit) {
      if (user) {
        showReadonlyBanner('Read-only. Signed in as ' + who + ' (role: ' + role +
          '). To edit, you must be admin OR have your uid in this paper\'s ' +
          'lead_author_uid / coauthor_uids in data/projects/papers.json. ' +
          'Open the browser console for full auth diagnostics.');
      }
    } else {
      hideReadonlyBanner();
    }

    setSaveStatus('Connecting…', 'saving');
    // Kick off the citation index in parallel with the Yjs connect — items.json
    // can be ~MB-sized and the editor doesn't need it for first paint.
    loadCitationIndex();
    var conn = await window.PaperYjs.connect(state.paperId);
    state.conn = conn;
    state.Y = conn.Y;
    var paperMap = conn.yDoc.getMap('paper');
    state.paperMap = paperMap;

    // V3.104 — start the per-paper claims subscription so bullet pills
    // can render their status. Tolerates a missing PaperBulletClaims
    // module (script load order / standalone tests); pills then sit in
    // their loading state indefinitely, which is harmless.
    if (window.PaperBulletClaims && typeof window.PaperBulletClaims.attach === 'function') {
      try { window.PaperBulletClaims.attach(state.paperId); }
      catch (err) { console.warn('[paper-editor] PaperBulletClaims.attach failed:', err); }
    }

    // V3.109 — install the Equations panel button + library/numbering
    // Yjs subscriptions so token chips and the panel stay live. Must
    // run AFTER paperMap is set on state since attach() reads from it.
    if (window.PaperEquations && typeof window.PaperEquations.attach === 'function') {
      try { window.PaperEquations.attach(); }
      catch (err) { console.warn('[paper-editor] PaperEquations.attach failed:', err); }
    }

    // Initialize structure if empty. Attach-then-mutate pattern — Yjs
    // shared types must be integrated into the doc before you can set
    // nested shared types on them. Building unattached trees with
    // `new Y.Map()` + `m.set('foo', new Y.Text())` works for prelim
    // primitives but fails for nested-shared-type round-trips.
    conn.yDoc.transact(function () {
      if (!paperMap.has('meta')) {
        paperMap.set('meta', new conn.Y.Map());
        var metaMap = paperMap.get('meta');
        metaMap.set('title', new conn.Y.Text(state.meta.title || ''));
      }
      if (!paperMap.has('sections')) {
        paperMap.set('sections', new conn.Y.Array());
      }
      // V3.109 — paper-level equation library (inline equations only;
      // numbered/display equations remain block kind in sections.children).
      // Idempotent: only created on first connect after V3.109 deploy.
      if (!paperMap.has('equation_library')) {
        paperMap.set('equation_library', new conn.Y.Array());
      }
      // V3.132 — paper-level figure / table libraries for items authored in
      // the panel before being placed in the doc. The same Y.Map shape as
      // a section.children figure/table block; placement happens via
      // placeUnplacedAt() which moves the snapshot into a section.
      if (!paperMap.has('figure_unplaced')) {
        paperMap.set('figure_unplaced', new conn.Y.Array());
      }
      if (!paperMap.has('table_unplaced')) {
        paperMap.set('table_unplaced', new conn.Y.Array());
      }
    }, 'init');

    var metaY = paperMap.get('meta');
    var titleY = metaY.get('title');
    if (!(titleY instanceof conn.Y.Text)) {
      // Coerce — older docs might have stored a plain string here.
      var s = (titleY != null) ? String(titleY) : '';
      conn.yDoc.transact(function () {
        metaY.set('title', new conn.Y.Text(''));
        if (s) metaY.get('title').insert(0, s);
      }, 'coerce-title');
      titleY = metaY.get('title');
    }
    state.titleY = titleY;
    state.sectionsArr = paperMap.get('sections');

    // Always run — probes for the import file (sets hasImportFile for the
    // Reset button) AND migrates if Yjs is currently empty.
    await maybeMigrateLegacy();
    // If still empty (no legacy + first visit) and user can edit, seed the
    // template's starter sections so the editor isn't a wall of nothing.
    if (state.sectionsArr.length === 0 && state.editable) {
      seedFromTemplate();
    }

    // Bind the title input to titleY.
    bindYTextToInput(titleY, titleInput, {
      readOnly: !state.editable,
      onLocalChange: function () {
        // Keep tab title in sync.
        document.title = (titleY.toString() || 'Paper') + ' — Editor';
        // Also propagate to papers.json (debounced through a short timer).
        scheduleTitleSync();
      },
    });

    // Observe structural changes to refresh the outline + main pane.
    state.sectionsArr.observe(function () { render(); });
    // Watch the title for tab-title updates from remote edits.
    titleY.observe(function () {
      document.title = (titleY.toString() || 'Paper') + ' — Editor';
    });

    // Presence row + per-block presence dot refresh.
    state.conn.onPresence(function (arr) {
      state.presenceList = arr;
      renderPresenceRow();
      // Notify all rendered blocks so their presence dots update.
      window.dispatchEvent(new CustomEvent('paper-presence-changed'));
    });

    // Live comment subscription (Phase D).
    subscribeComments();

    setSaveStatus('Connected', 'saved');
    render();
  }

  function renderPlaceholder() {
    contentEl.innerHTML = '<div class="empty-state">Sign in to load this paper.</div>';
  }

  /* ── Migration (Phase A → Yjs) ── */

  async function maybeMigrateLegacy() {
    if (!firebridge.isAdmin() && !firebridge.isLeadAuthor(state.meta)) {
      // Non-admin coauthors wait for the lead author's migration to propagate.
      return;
    }

    // Always check for an import file from scripts/import_tex_paper.py —
    // independent of whether the Yjs doc is empty. This sets hasImportFile
    // for the "Reset & re-import" button regardless of current state.
    var importDoc = null;
    try {
      importDoc = await api.load('paper-imports/' + state.paperId + '.json');
      if (importDoc && importDoc.tree && Array.isArray(importDoc.tree.sections) && importDoc.tree.sections.length) {
        hasImportFile = true;
      }
    } catch (e) { /* no import file present */ }

    var legacy = null;

    // Source 1: legacy Phase A Firestore doc (`papers/{id}/draft/tree`).
    // V3.153 — `firestore.rules` doesn't grant read access to the
    // `/draft/` subpath (it predates the Yjs migration), so this read
    // throws permission-denied for every post-Phase A paper. That's
    // expected — the migration is dead code for new papers and only
    // relevant if someone is opening a paper authored before the Yjs
    // cutover. Silently swallow and fall through; never surface the
    // scary stack-trace warning that fires on every page load.
    try {
      legacy = await firebridge.getDoc('papers/' + state.paperId + '/draft', 'tree');
    } catch (err) { /* expected: legacy path is denied by rules + the doc usually doesn't exist */ }

    // Source 2: the import file we just probed.
    if (!legacy || !legacy.tree || !Array.isArray(legacy.tree.sections) || !legacy.tree.sections.length) {
      if (hasImportFile) {
        legacy = { tree: importDoc.tree };
        setSaveStatus('Importing from .tex…', 'saving');
      }
    }

    if (!legacy || !legacy.tree || !Array.isArray(legacy.tree.sections) || !legacy.tree.sections.length) {
      return;
    }
    // Don't overwrite an already-populated Yjs doc — the Reset button is
    // the only path that should clear and re-import.
    if (state.sectionsArr.length > 0) {
      return;
    }
    state.conn.yDoc.transact(function () {
      if (!state.titleY.toString() && legacy.tree.meta && legacy.tree.meta.title) {
        state.titleY.insert(0, legacy.tree.meta.title);
      }
      legacy.tree.sections.forEach(function (sec) {
        appendSectionFromTree(state.sectionsArr, sec);
      });
    }, 'migrate-from-phaseA');
    setSaveStatus('Migrated from Phase A', 'saved');
  }

  /* Push a section onto an attached Y.Array, then mutate the new Y.Map.
   * Attach-then-mutate is required: nested Y types only round-trip through
   * .get() once their parent is integrated into a Y.Doc.
   *
   * V3.230 — Y.Text is constructed with its initial content rather than
   * built empty and then `.insert(0, ...)`ed. The set-then-get-then-insert
   * pattern fails inside the same transact when the parent Y.Map was ALSO
   * freshly integrated in that transact (Yjs 13 quirk: the just-set Y.Text
   * isn't yet reachable via `m.get('label')`). Passing the string to the
   * constructor avoids the round-trip. Same fix on `skeleton` / `body` in
   * appendBlockFromTree below. */
  function appendSectionFromTree(sectionsArr, sec) {
    var Y = state.Y;
    var m = new Y.Map();
    sectionsArr.push([m]);
    m.set('id', sec.id || window.PaperSchemas.shortId('sec-'));
    m.set('kind', sec.kind || 'custom');
    m.set('label', new Y.Text(sec.label ? String(sec.label) : ''));
    m.set('order', typeof sec.order === 'number' ? sec.order : 0);
    m.set('status', sec.status || 'draft');
    var childrenArr = new Y.Array();
    m.set('children', childrenArr);
    (sec.children || []).forEach(function (blk) {
      appendBlockFromTree(childrenArr, blk);
    });
    return m;
  }

  function appendBlockFromTree(childrenArr, blk) {
    var Y = state.Y;
    var m = new Y.Map();
    childrenArr.push([m]);
    m.set('id', blk.id || window.PaperSchemas.shortId('p-'));
    m.set('kind', blk.kind || 'paragraph');
    m.set('status', blk.status || 'draft');
    m.set('skeleton', new Y.Text(blk.skeleton ? String(blk.skeleton) : ''));
    m.set('body', new Y.Text(blk.body ? String(blk.body) : ''));
    m.set('attrs', new Y.Map());
    return m;
  }

  function seedFromTemplate() {
    var schemas = window.PaperSchemas;
    var tpl = schemas.PAPER_TEMPLATES[state.meta.template_id] || schemas.PAPER_TEMPLATES['blank'];
    if (!tpl.sections.length) return;
    state.conn.yDoc.transact(function () {
      tpl.sections.forEach(function (s, i) {
        var sec = schemas.newSection(s.kind, s.label, i);
        sec.children.push(schemas.newParagraph());
        appendSectionFromTree(state.sectionsArr, sec);
      });
    }, 'seed-template');
  }

  /* ── Render ── */

  function render() {
    titleInput.disabled = !state.editable;
    addSectionBtn.disabled = !state.editable;

    var sections = state.sectionsArr.toArray();
    if (!state.activeSectionId && sections.length) {
      state.activeSectionId = sections[0].get('id');
    }

    teardownBlockSubscriptions();
    renderOutline(sections);
    renderMain(sections);
    renderPresenceRow();
    ensureInviteButton();
  }

  function renderOutline(sections) {
    outlineEl.innerHTML = '';
    sections.forEach(function (sec) {
      var li = document.createElement('li');
      li.className = 'pe-sidebar-item';
      var secId = sec.get('id');
      if (secId === state.activeSectionId) li.classList.add('active');
      var labelSpan = document.createElement('span');
      labelSpan.textContent = readSectionLabel(sec);
      li.appendChild(labelSpan);
      var meta = document.createElement('span');
      meta.style.cssText = 'font-size:11px;color:#9ca3af';
      meta.textContent = (sec.get('children') ? sec.get('children').length : 0) + 'p';
      li.appendChild(meta);
      li.addEventListener('click', function () {
        state.activeSectionId = secId;
        renderOutline(state.sectionsArr.toArray());
        var anchor = document.querySelector('[data-section-id="' + secId + '"]');
        if (anchor) anchor.scrollIntoView({ behavior: 'smooth', block: 'start' });
      });
      outlineEl.appendChild(li);
    });
  }

  function renderMain(sections) {
    contentEl.innerHTML = '';
    if (!sections.length) {
      var empty = document.createElement('div');
      empty.className = 'pe-empty';
      empty.innerHTML = state.editable
        ? 'No sections yet. <button class="btn" id="pe-empty-add">+ Add a section</button>'
        : 'No sections yet.';
      contentEl.appendChild(empty);
      var emptyAdd = document.getElementById('pe-empty-add');
      if (emptyAdd) emptyAdd.addEventListener('click', addSectionPrompt);
      return;
    }
    sections.forEach(function (sec) {
      contentEl.appendChild(renderSection(sec));
    });
  }

  function renderSection(secMap) {
    var schemas = window.PaperSchemas;
    var wrap = document.createElement('section');
    wrap.className = 'pe-section';
    var secId = secMap.get('id');
    wrap.dataset.sectionId = secId;

    var header = document.createElement('div');
    header.className = 'pe-section-header';

    /* Section label — bound to a Y.Text. */
    var labelEl = document.createElement('div');
    labelEl.className = 'pe-section-label';
    labelEl.contentEditable = state.editable ? 'true' : 'false';
    var labelY = secMap.get('label');
    if (labelY instanceof state.Y.Text) {
      bindYTextToContentEditable(labelY, labelEl, {
        readOnly: !state.editable,
        onLocalChange: function () {
          // Mirror to outline label without re-rendering everything.
          updateOutlineLabel(secId, labelY.toString());
        },
        onRemoteChange: function () { updateOutlineLabel(secId, labelY.toString()); },
      });
    } else {
      labelEl.textContent = String(labelY || '');
    }
    header.appendChild(labelEl);

    var kindTag = document.createElement('span');
    kindTag.className = 'pe-section-kind';
    kindTag.textContent = secMap.get('kind');
    header.appendChild(kindTag);

    if (state.editable) {
      var actions = document.createElement('div');
      actions.className = 'pe-section-actions';
      actions.appendChild(mkIconBtn('▲', 'Move section up',   function () { moveSection(secId, -1); }));
      actions.appendChild(mkIconBtn('▼', 'Move section down', function () { moveSection(secId,  1); }));
      actions.appendChild(mkIconBtn('✕', 'Delete section',    function () { deleteSection(secId); }));
      header.appendChild(actions);
    }
    wrap.appendChild(header);

    /* Render each block. */
    var ctx = {
      Y: state.Y,
      paperId: state.paperId,
      /* V3.125 — sectionId on ctx so block-side reorder controls can
       * call moveBlockUp/Down without re-walking sectionsArr. */
      sectionId: secId,
      editable: state.editable,
      viewFilter: state.viewFilter,
      onDelete: function (blockId) { deleteBlock(secId, blockId); },
      onFocusBlock: function (blockId) {
        if (state.conn) state.conn.setFocusBlock(blockId);
        /* V3.219 — keep the comments pane scoped to the currently
         * focused paragraph so all of that paragraph's comments show
         * by default as the writer moves through the document. No-op
         * when the pane is closed or already targeting this block. */
        _maybeRefocusCommentsPane(blockId);
      },
      registerSubscription: function (yMap, unobserve) {
        state.blockSubscriptions.push({ yMap: yMap, unobserve: unobserve });
      },
      getPresenceForBlock: function (blockId) {
        return state.presenceList.filter(function (p) {
          return !p.isSelf && p.focusBlockId === blockId;
        });
      },
      /* V3.217 — soft per-block lock. The first presence record with
       * `focusBlockId === blockId` (deterministic tie-break by lowest
       * uid) holds the lock. Returns the holder's full presence record
       * (with `isSelf` flag) so the block UI can render either a "You
       * are editing" self-badge or a "Locked by <name>" badge that
       * also disables the contenteditable for non-holders. The 30s
       * presence-stale check in paper-yjs.js already auto-clears locks
       * held by disconnected users. */
      getLockHolderForBlock: function (blockId) {
        if (!blockId) return null;
        var holders = (state.presenceList || []).filter(function (p) {
          return p.focusBlockId === blockId;
        });
        if (!holders.length) return null;
        holders.sort(function (a, b) {
          return (a.uid || '').localeCompare(b.uid || '');
        });
        return holders[0];
      },
      releaseLock: function () {
        if (state.conn) state.conn.setFocusBlock(null);
      },
      /* V3.217 — read self's current `focusBlockId` so blur/idle handlers
       * can avoid stomping on a lock acquired on a different block. */
      getSelfFocusBlockId: function () {
        var self = (state.presenceList || []).find(function (p) { return p.isSelf; });
        return self ? (self.focusBlockId || null) : null;
      },
      requestRender: render,
    };
    var childrenArr = secMap.get('children');
    var sf = state.statusFilter;
    var hiddenCount = 0;
    /* V3.125 — inline + Add buttons between every pair of blocks (and
     * at top + bottom of section). Replaces the legacy section-bottom
     * toolbar of `+ Paragraph / + Figure / + Table` buttons. */
    var visibleIdx = 0;
    var inserterAtTopAdded = false;
    childrenArr.forEach(function (blockMap, arrIdx) {
      var s = blockMap.get('status') || 'draft';
      var keep = (sf === 'all') ||
                 (sf === 'not-complete' && s !== 'complete') ||
                 (sf === s);
      if (!keep) { hiddenCount++; return; }
      if (state.editable) {
        if (!inserterAtTopAdded) {
          wrap.appendChild(_buildBlockInserter(secId, secMap, arrIdx));
          inserterAtTopAdded = true;
        }
      }
      wrap.appendChild(window.PaperBlocks.renderYBlock(blockMap, ctx));
      if (state.editable) {
        wrap.appendChild(_buildBlockInserter(secId, secMap, arrIdx + 1));
      }
      visibleIdx++;
    });
    /* If no blocks were visible, still show one inserter so the user
     * can add their first block. */
    if (state.editable && !inserterAtTopAdded) {
      wrap.appendChild(_buildBlockInserter(secId, secMap, 0));
    }
    if (hiddenCount > 0) {
      var note = document.createElement('div');
      note.className = 'pe-filter-note';
      note.textContent = hiddenCount + ' block' + (hiddenCount === 1 ? '' : 's') +
                         ' hidden by status filter';
      wrap.appendChild(note);
    }

    /* Re-render this section's blocks if children array changes. */
    var childrenObserver = function (event, transaction) {
      // Avoid a feedback loop with our own additions; the structural change
      // observer at sectionsArr level ALSO fires for nested changes via
      // observeDeep. We only care about the first event level.
      if (event.target === childrenArr) {
        render();
      }
    };
    childrenArr.observe(childrenObserver);
    state.blockSubscriptions.push({
      yMap: childrenArr,
      unobserve: function () { childrenArr.unobserve(childrenObserver); },
    });

    /* V3.125 — section-bottom "+ Paragraph / + Figure / + Table /
     * + Reagent / + Equation" toolbar retired in favor of the inline
     * + Add buttons between every pair of blocks. Inventory quick-insert
     * for Methods sections moves into the inserter menu as a fifth
     * choice (gated on section.kind === 'methods'). */

    return wrap;
  }

  /* V3.125 — inline block inserter. Renders a small "+ Add" button;
   * clicking opens a small popover menu of block kinds. Picking a kind
   * calls insertBlockAt(sectionId, idx, kind) and (for figure/table)
   * also opens the side panel on the matching tab. */
  function _buildBlockInserter(sectionId, secMap, idx) {
    var btn = document.createElement('button');
    btn.type = 'button';
    btn.className = 'pe-block-inserter';
    btn.title = 'Add a block here';
    btn.textContent = '+ Add';
    btn.addEventListener('click', function (e) {
      e.preventDefault();
      _openBlockInserterMenu(btn, sectionId, secMap, idx);
    });
    return btn;
  }

  function _openBlockInserterMenu(anchorBtn, sectionId, secMap, idx) {
    var existing = document.getElementById('pe-block-inserter-menu');
    if (existing) existing.remove();

    var menu = document.createElement('div');
    menu.className = 'pe-block-inserter-menu';
    menu.id = 'pe-block-inserter-menu';

    var sectionKind = secMap.get('kind');
    var secStyle = window.PaperSchemas.styleFor({
      kind: sectionKind,
      style_overrides: {},
    });
    var allowFigures = !secStyle || secStyle.allowFigures !== false;

    function mkItem(label, onClick, disabled) {
      var item = document.createElement('button');
      item.type = 'button';
      item.className = 'pe-block-inserter-item';
      if (disabled) item.classList.add('disabled');
      item.textContent = label;
      if (!disabled) item.addEventListener('click', function () {
        menu.remove();
        onClick();
      });
      return item;
    }

    menu.appendChild(mkItem('Paragraph', function () {
      insertBlockAt(sectionId, idx, 'paragraph');
    }));
    /* V3.132 — Equation / Figure / Table options now open a panel-side
     * picker rather than directly creating an in-doc block. The picker
     * lists items already authored in the panel (and a "+ New …" row).
     * All authoring happens in the side panel; the doc only carries
     * placement. */
    menu.appendChild(mkItem('Equation', function () {
      if (window.PaperEquations && window.PaperEquations.openEquationPickerAt) {
        window.PaperEquations.openEquationPickerAt(sectionId, idx, anchorBtn);
      } else if (window.PaperEquations && window.PaperEquations.openEquationCreateModalAt) {
        window.PaperEquations.openEquationCreateModalAt(sectionId, idx);
      } else {
        insertBlockAt(sectionId, idx, 'equation');
      }
    }));
    menu.appendChild(mkItem('Figure', function () {
      if (window.PaperEquations && window.PaperEquations.openFigurePickerAt) {
        window.PaperEquations.openFigurePickerAt(sectionId, idx, anchorBtn);
      } else {
        var blockId = insertBlockAt(sectionId, idx, 'figure');
        if (window.PaperEquations) {
          window.PaperEquations.showPanel && window.PaperEquations.showPanel();
          window.PaperEquations.setActiveTab && window.PaperEquations.setActiveTab('figures');
        }
      }
    }, !allowFigures));
    menu.appendChild(mkItem('Table', function () {
      if (window.PaperEquations && window.PaperEquations.openTablePickerAt) {
        window.PaperEquations.openTablePickerAt(sectionId, idx, anchorBtn);
      } else {
        var blockId = insertBlockAt(sectionId, idx, 'table');
        if (window.PaperEquations) {
          window.PaperEquations.showPanel && window.PaperEquations.showPanel();
          window.PaperEquations.setActiveTab && window.PaperEquations.setActiveTab('tables');
        }
      }
    }));
    /* Inventory quick-insert (Methods sections only) — V3.40-era
     * affordance retained as a fifth menu item. */
    if (sectionKind === 'methods') {
      menu.appendChild(mkItem('Reagent / equipment', function () {
        // V3.151 — pass the section's `+ Add` button as the anchor so
        // the popover opens next to it instead of top-center.
        openInventoryDialog(sectionId, anchorBtn);
      }));
    }

    /* Position the menu below the anchor button. */
    var rect = anchorBtn.getBoundingClientRect();
    menu.style.left = rect.left + 'px';
    menu.style.top = (rect.bottom + 2) + 'px';
    document.body.appendChild(menu);

    /* Click-outside dismiss. */
    var dismiss = function (ev) {
      if (!menu.contains(ev.target) && ev.target !== anchorBtn) {
        menu.remove();
        document.removeEventListener('mousedown', dismiss, true);
      }
    };
    setTimeout(function () {
      document.addEventListener('mousedown', dismiss, true);
    }, 0);
  }

  function teardownBlockSubscriptions() {
    state.blockSubscriptions.forEach(function (sub) {
      try { sub.unobserve(); } catch (e) {}
    });
    state.blockSubscriptions = [];
  }

  function updateOutlineLabel(secId, newLabel) {
    var items = outlineEl.querySelectorAll('.pe-sidebar-item');
    var sections = state.sectionsArr.toArray();
    sections.forEach(function (sec, i) {
      if (sec.get('id') === secId && items[i]) {
        var span = items[i].querySelector('span');
        if (span) span.textContent = newLabel || window.PaperSchemas.SECTION_KIND_LABELS[sec.get('kind')] || 'Untitled';
      }
    });
  }

  function readSectionLabel(secMap) {
    var lbl = secMap.get('label');
    var s = (lbl instanceof state.Y.Text) ? lbl.toString() : String(lbl || '');
    return s || window.PaperSchemas.SECTION_KIND_LABELS[secMap.get('kind')] || 'Untitled';
  }

  function mkIconBtn(label, title, onClick) {
    var b = document.createElement('button');
    b.type = 'button';
    b.className = 'pe-icon-btn';
    b.title = title;
    b.textContent = label;
    b.addEventListener('click', onClick);
    return b;
  }

  /* ── Mutations (operate on Y types inside transact) ── */

  function findSection(secId) {
    var arr = state.sectionsArr.toArray();
    for (var i = 0; i < arr.length; i++) {
      if (arr[i].get('id') === secId) return { idx: i, map: arr[i] };
    }
    return null;
  }

  function addParagraph(sectionId) {
    var hit = findSection(sectionId);
    if (!hit) return;
    state.conn.yDoc.transact(function () {
      appendBlockFromTree(hit.map.get('children'), window.PaperSchemas.newParagraph());
    }, 'add-paragraph');
  }

  function addTable(sectionId) {
    var hit = findSection(sectionId);
    if (!hit) return;
    var Y = state.Y;
    state.conn.yDoc.transact(function () {
      var children = hit.map.get('children');
      var m = new Y.Map();
      children.push([m]);
      m.set('id', window.PaperSchemas.shortId('p-'));
      m.set('kind', 'table');
      m.set('status', 'draft');
      m.set('skeleton', new Y.Text(''));
      m.set('body', new Y.Text(''));
      m.set('attrs', new Y.Map());
      var attrs = m.get('attrs');
      attrs.set('rows', 2);
      attrs.set('cols', 2);
      attrs.set('cells', new Y.Map());
      attrs.set('caption', new Y.Text(''));
      // Seed the four cells.
      var cells = attrs.get('cells');
      cells.set('0-0', new Y.Text(''));
      cells.set('0-1', new Y.Text(''));
      cells.set('1-0', new Y.Text(''));
      cells.set('1-1', new Y.Text(''));
    }, 'add-table');
  }

  function addEquation(sectionId, opts) {
    var hit = findSection(sectionId);
    if (!hit) return null;
    var Y = state.Y;
    opts = opts || {};
    var blockId = window.PaperSchemas.shortId('p-');
    state.conn.yDoc.transact(function () {
      // Attach-then-mutate pattern (see appendSectionFromTree).
      var children = hit.map.get('children');
      var m = new Y.Map();
      children.push([m]);
      m.set('id', blockId);
      m.set('kind', 'equation');
      m.set('status', 'draft');
      m.set('skeleton', new Y.Text(''));
      m.set('body', new Y.Text(opts.body || ''));
      m.set('attrs', new Y.Map());
      var attrs = m.get('attrs');
      // V3.124 — opts let panel-side "Insert as block" pre-populate
      // a numbered display equation directly. Defaults preserve the
      // pre-V3.124 behavior (display=true, no numbering).
      attrs.set('display', opts.display !== false);
      if (opts.numbered) attrs.set('numbered', true);
      if (opts.label) attrs.set('label', opts.label);
    }, 'add-equation');
    return blockId;
  }

  /* V3.102 — figure block. Body Y.Text holds the caption; attrs Y.Map holds
   * the Storage pointer and LaTeX render options. Image upload happens
   * lazily from the rendered toolbar (see renderFigure in paper-blocks.js). */
  function addFigure(sectionId) {
    var hit = findSection(sectionId);
    if (!hit) return;
    var Y = state.Y;
    state.conn.yDoc.transact(function () {
      var children = hit.map.get('children');
      var m = new Y.Map();
      children.push([m]);
      m.set('id', window.PaperSchemas.shortId('p-'));
      m.set('kind', 'figure');
      m.set('status', 'draft');
      m.set('skeleton', new Y.Text(''));
      m.set('body', new Y.Text(''));
      m.set('attrs', new Y.Map());
      var attrs = m.get('attrs');
      attrs.set('storage_path', '');
      attrs.set('download_url', '');
      attrs.set('hash', '');
      attrs.set('mime', '');
      attrs.set('width', '\\linewidth');
      attrs.set('placement', 'H');
      attrs.set('centering', true);
      attrs.set('label', '');
      attrs.set('alt', '');
      // V3.115 — seed numbered=true and an empty Y.Array of subfigures.
      attrs.set('numbered', true);
      attrs.set('subfigures', new Y.Array());
    }, 'add-figure');
  }

  function deleteBlock(sectionId, blockId) {
    var hit = findSection(sectionId);
    if (!hit) return;
    var children = hit.map.get('children');
    state.conn.yDoc.transact(function () {
      var arr = children.toArray();
      for (var i = 0; i < arr.length; i++) {
        if (arr[i].get('id') === blockId) {
          children.delete(i, 1);
          return;
        }
      }
    }, 'delete-block');
  }

  /* V3.125 — block reorder within a section. Snapshot → delete → re-insert
   * via the attach-then-mutate pattern (same shape as moveSection below).
   * Cross-section moves are out of scope for V3.125. */
  function _findBlockIdx(childrenArr, blockId) {
    var arr = childrenArr.toArray();
    for (var i = 0; i < arr.length; i++) {
      if (arr[i].get('id') === blockId) return i;
    }
    return -1;
  }

  /* V3.127 — recursively snapshot a Y type into a plain JS shape that
   * `_deepHydrateYValue` below can re-create as a fresh Y type. Used by
   * `moveBlockWithinSection` so figure subfigures, table cells, and
   * table caption Y.Texts survive a reorder. */
  function _snapshotYValue(v) {
    if (v == null) return v;
    if (typeof v === 'string' || typeof v === 'number' || typeof v === 'boolean') return v;
    var Y = state.Y;
    /* Y.Text duck-typed: has toString + length, no forEach/get pair. */
    if (v instanceof Y.Text) {
      return { __ytype: 'text', value: v.toString() };
    }
    if (v instanceof Y.Array) {
      var items = [];
      v.forEach(function (item) { items.push(_snapshotYValue(item)); });
      return { __ytype: 'array', items: items };
    }
    if (v instanceof Y.Map) {
      var entries = {};
      v.forEach(function (val, key) { entries[key] = _snapshotYValue(val); });
      return { __ytype: 'map', entries: entries };
    }
    /* Plain JS object/array (e.g. legacy attrs after extractAttrs). */
    if (Array.isArray(v)) return v.slice();
    if (typeof v === 'object') return Object.assign({}, v);
    return v;
  }

  function _hydrateYValue(snap) {
    if (snap == null) return snap;
    var Y = state.Y;
    if (typeof snap === 'string' || typeof snap === 'number' || typeof snap === 'boolean') return snap;
    if (snap.__ytype === 'text') return new Y.Text(snap.value || '');
    if (snap.__ytype === 'array') {
      var arr = new Y.Array();
      // Y.Array requires attach-then-mutate for nested shared types;
      // we push primitives or hydrated children into a fresh attached
      // array via the parent's transact context.
      return { _isYArraySnapshot: true, items: snap.items };
    }
    if (snap.__ytype === 'map') {
      return { _isYMapSnapshot: true, entries: snap.entries };
    }
    return snap;
  }

  /* Walks an attrs snapshot and writes each value into a fresh Y.Map.
   * Handles nested Y.Array<Y.Map> (subfigures) and Y.Map<Y.Text>
   * (table cells) by attach-then-mutate. */
  function _writeAttrsFromSnapshot(targetAttrs, snapshot) {
    var Y = state.Y;
    Object.keys(snapshot).forEach(function (key) {
      var v = snapshot[key];
      _writeAttrValue(targetAttrs, key, v, Y);
    });
  }

  function _writeAttrValue(parent, key, snap, Y) {
    if (snap == null) {
      parent.set(key, snap);
      return;
    }
    if (typeof snap === 'string' || typeof snap === 'number' || typeof snap === 'boolean') {
      parent.set(key, snap);
      return;
    }
    if (snap.__ytype === 'text') {
      parent.set(key, new Y.Text(snap.value || ''));
      return;
    }
    if (snap.__ytype === 'array') {
      parent.set(key, new Y.Array());
      var arr = parent.get(key);
      snap.items.forEach(function (item) {
        if (item && item.__ytype === 'map') {
          var m = new Y.Map();
          arr.push([m]);
          Object.keys(item.entries).forEach(function (k) {
            _writeAttrValue(m, k, item.entries[k], Y);
          });
        } else if (item && item.__ytype === 'array') {
          // Nested array — recurse via a temp Y.Map wrapper isn't possible.
          // For V3.127 we don't have nested Y.Array<Y.Array> in any block kind.
          var inner = new Y.Array();
          arr.push([inner]);
          // Best-effort recursive push of primitive items.
          item.items.forEach(function (it) {
            if (typeof it === 'string' || typeof it === 'number' || typeof it === 'boolean') {
              inner.push([it]);
            }
          });
        } else if (item && item.__ytype === 'text') {
          arr.push([new Y.Text(item.value || '')]);
        } else if (item != null && (typeof item === 'string' || typeof item === 'number' || typeof item === 'boolean')) {
          arr.push([item]);
        }
      });
      return;
    }
    if (snap.__ytype === 'map') {
      parent.set(key, new Y.Map());
      var m2 = parent.get(key);
      Object.keys(snap.entries).forEach(function (k) {
        _writeAttrValue(m2, k, snap.entries[k], Y);
      });
      return;
    }
    /* Fallback: plain JS object/array — just set as-is. */
    parent.set(key, snap);
  }

  function moveBlockWithinSection(sectionId, blockId, targetIdx) {
    var hit = findSection(sectionId);
    if (!hit) return;
    var children = hit.map.get('children');
    var idx = _findBlockIdx(children, blockId);
    if (idx < 0) return;
    if (targetIdx < 0) targetIdx = 0;
    if (targetIdx > children.length) targetIdx = children.length;
    if (targetIdx === idx || targetIdx === idx + 1) return;
    var Y = state.Y;
    state.conn.yDoc.transact(function () {
      var srcMap = children.get(idx);
      /* V3.127 — capture every Y type on the block recursively so the
       * destination clone faithfully reproduces subfigures (figure),
       * cells (table), caption Y.Text, etc. */
      var snapshot = {
        id: srcMap.get('id'),
        kind: srcMap.get('kind'),
        status: srcMap.get('status'),
        skeleton: _snapshotYValue(srcMap.get('skeleton')),
        skeleton_items: _snapshotYValue(srcMap.get('skeleton_items')),
        body: _snapshotYValue(srcMap.get('body')),
        attrs: _snapshotYValue(srcMap.get('attrs')),
      };
      children.delete(idx, 1);
      var insertAt = targetIdx > idx ? targetIdx - 1 : targetIdx;
      var m = new Y.Map();
      children.insert(insertAt, [m]);
      m.set('id', snapshot.id);
      m.set('kind', snapshot.kind);
      m.set('status', snapshot.status || 'draft');
      _writeAttrValue(m, 'skeleton', snapshot.skeleton, Y);
      if (snapshot.skeleton_items) {
        _writeAttrValue(m, 'skeleton_items', snapshot.skeleton_items, Y);
      }
      _writeAttrValue(m, 'body', snapshot.body, Y);
      m.set('attrs', new Y.Map());
      if (snapshot.attrs && snapshot.attrs.__ytype === 'map') {
        _writeAttrsFromSnapshot(m.get('attrs'), snapshot.attrs.entries);
      }
    }, 'move-block-within-section');
  }

  function moveBlockUp(sectionId, blockId) {
    var hit = findSection(sectionId);
    if (!hit) return;
    var children = hit.map.get('children');
    var idx = _findBlockIdx(children, blockId);
    if (idx <= 0) return;
    moveBlockWithinSection(sectionId, blockId, idx - 1);
  }

  function moveBlockDown(sectionId, blockId) {
    var hit = findSection(sectionId);
    if (!hit) return;
    var children = hit.map.get('children');
    var idx = _findBlockIdx(children, blockId);
    if (idx < 0 || idx >= children.length - 1) return;
    moveBlockWithinSection(sectionId, blockId, idx + 2);
  }

  function moveBlockBefore(sectionId, srcId, targetId) {
    if (srcId === targetId) return;
    var hit = findSection(sectionId);
    if (!hit) return;
    var children = hit.map.get('children');
    var targetIdx = _findBlockIdx(children, targetId);
    if (targetIdx < 0) return;
    moveBlockWithinSection(sectionId, srcId, targetIdx);
  }

  /* V3.132 — block snapshot/hydrate helpers shared by
   * moveBlockWithinSection, placeUnplacedAt, unplaceBlock, and any other
   * cross-container Y.Map move. Y types must be detached from one parent
   * before being attached to another, so a snapshot/hydrate clone is the
   * only safe path. */
  function _snapshotBlockMap(srcMap) {
    return {
      id: srcMap.get('id'),
      kind: srcMap.get('kind'),
      status: srcMap.get('status'),
      skeleton: _snapshotYValue(srcMap.get('skeleton')),
      skeleton_items: _snapshotYValue(srcMap.get('skeleton_items')),
      body: _snapshotYValue(srcMap.get('body')),
      attrs: _snapshotYValue(srcMap.get('attrs')),
    };
  }
  function _hydrateBlockFromSnapshot(m, snapshot) {
    var Y = state.Y;
    m.set('id', snapshot.id);
    m.set('kind', snapshot.kind);
    m.set('status', snapshot.status || 'draft');
    _writeAttrValue(m, 'skeleton', snapshot.skeleton, Y);
    if (snapshot.skeleton_items) {
      _writeAttrValue(m, 'skeleton_items', snapshot.skeleton_items, Y);
    }
    _writeAttrValue(m, 'body', snapshot.body, Y);
    m.set('attrs', new Y.Map());
    if (snapshot.attrs && snapshot.attrs.__ytype === 'map') {
      _writeAttrsFromSnapshot(m.get('attrs'), snapshot.attrs.entries);
    }
  }

  /* V3.132 — unplaced-figure / unplaced-table libraries. Authoring
   * happens in the side panel; the Y.Map block is identical to an
   * in-doc section.children figure/table block. placeUnplacedAt()
   * snapshots the block, deletes it from the library, and re-hydrates
   * inside the destination section's children. */
  function getUnplacedFiguresArr() {
    return state.paperMap ? state.paperMap.get('figure_unplaced') : null;
  }
  function getUnplacedTablesArr() {
    return state.paperMap ? state.paperMap.get('table_unplaced') : null;
  }
  function _findInArrById(arr, blockId) {
    if (!arr || typeof arr.length !== 'number') return -1;
    for (var i = 0; i < arr.length; i++) {
      var m = arr.get(i);
      if (m && m.get('id') === blockId) return i;
    }
    return -1;
  }
  function getUnplacedFigures() {
    var arr = getUnplacedFiguresArr();
    if (!arr) return [];
    var out = [];
    arr.forEach(function (m) { out.push(_figureRowSnapshot(m)); });
    return out;
  }
  function getUnplacedTables() {
    var arr = getUnplacedTablesArr();
    if (!arr) return [];
    var out = [];
    arr.forEach(function (m) { out.push(_tableRowSnapshot(m)); });
    return out;
  }
  function _figureRowSnapshot(m) {
    var attrs = m && m.get && m.get('attrs');
    var Y = state.Y;
    var bodyY = m.get('body');
    return {
      blockId: m.get('id'),
      label: (attrs && attrs.get('label')) || '',
      downloadUrl: (attrs && attrs.get('download_url')) || '',
      caption: (bodyY instanceof Y.Text) ? bodyY.toString() : '',
      numbered: !!(attrs && attrs.get('numbered')),
    };
  }
  function _tableRowSnapshot(m) {
    var attrs = m && m.get && m.get('attrs');
    var Y = state.Y;
    var captionY = attrs && attrs.get('caption');
    return {
      blockId: m.get('id'),
      label: (attrs && attrs.get('label')) || '',
      rows: (attrs && attrs.get('rows')) || 0,
      cols: (attrs && attrs.get('cols')) || 0,
      caption: (captionY instanceof Y.Text) ? captionY.toString() : '',
      numbered: !!(attrs && attrs.get('numbered')),
    };
  }

  function createUnplacedFigure() {
    var arr = getUnplacedFiguresArr();
    if (!arr) return null;
    var Y = state.Y;
    var blockId = window.PaperSchemas.shortId('p-');
    state.conn.yDoc.transact(function () {
      var m = new Y.Map();
      arr.push([m]);
      m.set('id', blockId);
      m.set('kind', 'figure');
      m.set('status', 'draft');
      m.set('skeleton', new Y.Text(''));
      m.set('body', new Y.Text(''));
      m.set('attrs', new Y.Map());
      var attrs = m.get('attrs');
      attrs.set('storage_path', '');
      attrs.set('download_url', '');
      attrs.set('hash', '');
      attrs.set('mime', '');
      attrs.set('width', '\\linewidth');
      attrs.set('placement', 'H');
      attrs.set('centering', true);
      attrs.set('label', '');
      attrs.set('alt', '');
      attrs.set('numbered', true);
      attrs.set('subfigures', new Y.Array());
    }, 'create-unplaced-figure');
    return blockId;
  }

  function createUnplacedTable() {
    var arr = getUnplacedTablesArr();
    if (!arr) return null;
    var Y = state.Y;
    var blockId = window.PaperSchemas.shortId('p-');
    state.conn.yDoc.transact(function () {
      var m = new Y.Map();
      arr.push([m]);
      m.set('id', blockId);
      m.set('kind', 'table');
      m.set('status', 'draft');
      m.set('skeleton', new Y.Text(''));
      m.set('body', new Y.Text(''));
      m.set('attrs', new Y.Map());
      var attrs = m.get('attrs');
      attrs.set('rows', 2);
      attrs.set('cols', 2);
      attrs.set('cells', new Y.Map());
      var cells = attrs.get('cells');
      cells.set('0-0', new Y.Text(''));
      cells.set('0-1', new Y.Text(''));
      cells.set('1-0', new Y.Text(''));
      cells.set('1-1', new Y.Text(''));
      attrs.set('caption', new Y.Text(''));
      attrs.set('numbered', true);
      attrs.set('label', '');
      attrs.set('booktabs', true);
      attrs.set('header_row', true);
      attrs.set('align', 'll');
    }, 'create-unplaced-table');
    return blockId;
  }

  function findUnplacedYMap(kind, blockId) {
    var arr = (kind === 'figure') ? getUnplacedFiguresArr() : getUnplacedTablesArr();
    if (!arr) return null;
    var i = _findInArrById(arr, blockId);
    if (i < 0) return null;
    return arr.get(i);
  }

  function deleteUnplaced(kind, blockId) {
    var arr = (kind === 'figure') ? getUnplacedFiguresArr() : getUnplacedTablesArr();
    if (!arr) return false;
    var i = _findInArrById(arr, blockId);
    if (i < 0) return false;
    state.conn.yDoc.transact(function () {
      arr.delete(i, 1);
    }, 'delete-unplaced-block');
    return true;
  }

  /* Place an unplaced figure/table at a doc position — snapshot, delete
   * from library, hydrate into section's children. */
  function placeUnplacedAt(kind, blockId, sectionId, idx) {
    var arr = (kind === 'figure') ? getUnplacedFiguresArr() : getUnplacedTablesArr();
    if (!arr) return false;
    var srcIdx = _findInArrById(arr, blockId);
    if (srcIdx < 0) return false;
    var hit = findSection(sectionId);
    if (!hit) return false;
    var children = hit.map.get('children');
    if (idx < 0) idx = 0;
    if (idx > children.length) idx = children.length;
    var Y = state.Y;
    state.conn.yDoc.transact(function () {
      var snapshot = _snapshotBlockMap(arr.get(srcIdx));
      arr.delete(srcIdx, 1);
      var m = new Y.Map();
      children.insert(idx, [m]);
      _hydrateBlockFromSnapshot(m, snapshot);
    }, 'place-unplaced-block');
    return true;
  }

  /* Send an in-doc figure/table block back to the unplaced library. */
  function unplaceBlock(sectionId, blockId) {
    var hit = findSection(sectionId);
    if (!hit) return false;
    var children = hit.map.get('children');
    var idx = _findBlockIdx(children, blockId);
    if (idx < 0) return false;
    var srcMap = children.get(idx);
    var kind = srcMap.get('kind');
    if (kind !== 'figure' && kind !== 'table') return false;
    var arr = (kind === 'figure') ? getUnplacedFiguresArr() : getUnplacedTablesArr();
    if (!arr) return false;
    var Y = state.Y;
    state.conn.yDoc.transact(function () {
      var snapshot = _snapshotBlockMap(srcMap);
      children.delete(idx, 1);
      var m = new Y.Map();
      arr.push([m]);
      _hydrateBlockFromSnapshot(m, snapshot);
    }, 'unplace-block');
    return true;
  }

  /* Move an in-doc block (figure/table/equation) to a new position,
   * possibly across sections. For same-section moves, defers to
   * moveBlockWithinSection. */
  function moveBlockToPosition(srcSectionId, blockId, dstSectionId, dstIdx) {
    if (srcSectionId === dstSectionId) {
      moveBlockWithinSection(srcSectionId, blockId, dstIdx);
      return true;
    }
    var srcHit = findSection(srcSectionId);
    var dstHit = findSection(dstSectionId);
    if (!srcHit || !dstHit) return false;
    var srcChildren = srcHit.map.get('children');
    var dstChildren = dstHit.map.get('children');
    var srcIdx = _findBlockIdx(srcChildren, blockId);
    if (srcIdx < 0) return false;
    if (dstIdx < 0) dstIdx = 0;
    if (dstIdx > dstChildren.length) dstIdx = dstChildren.length;
    var Y = state.Y;
    state.conn.yDoc.transact(function () {
      var snapshot = _snapshotBlockMap(srcChildren.get(srcIdx));
      srcChildren.delete(srcIdx, 1);
      var m = new Y.Map();
      dstChildren.insert(dstIdx, [m]);
      _hydrateBlockFromSnapshot(m, snapshot);
    }, 'move-block-cross-section');
    return true;
  }

  /* V3.125 — insert a new block of `kind` at position `idx` in section's
   * children array. Used by the inline + Add inserter. Returns the new
   * block id. Mirrors addParagraph / addEquation / addFigure / addTable
   * but at a specific position rather than push-to-end. */
  function insertBlockAt(sectionId, idx, kind, opts) {
    var hit = findSection(sectionId);
    if (!hit) return null;
    var Y = state.Y;
    var children = hit.map.get('children');
    if (idx < 0) idx = 0;
    if (idx > children.length) idx = children.length;
    var blockId = window.PaperSchemas.shortId('p-');
    opts = opts || {};
    state.conn.yDoc.transact(function () {
      var m = new Y.Map();
      children.insert(idx, [m]);
      m.set('id', blockId);
      m.set('kind', kind);
      m.set('status', 'draft');
      m.set('skeleton', new Y.Text(''));
      m.set('body', new Y.Text(opts.body || ''));
      m.set('attrs', new Y.Map());
      var attrs = m.get('attrs');
      if (kind === 'paragraph') {
        // Skeleton items list (V3.115). Leave empty; renderer migrates.
      } else if (kind === 'equation') {
        attrs.set('display', opts.display !== false);
        if (opts.numbered) attrs.set('numbered', true);
        if (opts.label) attrs.set('label', opts.label);
      } else if (kind === 'figure') {
        attrs.set('storage_path', '');
        attrs.set('download_url', '');
        attrs.set('hash', '');
        attrs.set('mime', '');
        attrs.set('width', '\\linewidth');
        attrs.set('placement', 'H');
        attrs.set('centering', true);
        attrs.set('label', '');
        attrs.set('alt', '');
        attrs.set('numbered', true);
        attrs.set('subfigures', new Y.Array());
      } else if (kind === 'table') {
        attrs.set('rows', 2);
        attrs.set('cols', 2);
        attrs.set('cells', new Y.Map());
        var cells = attrs.get('cells');
        cells.set('0-0', new Y.Text(''));
        cells.set('0-1', new Y.Text(''));
        cells.set('1-0', new Y.Text(''));
        cells.set('1-1', new Y.Text(''));
        attrs.set('caption', new Y.Text(''));
        attrs.set('numbered', true);
        attrs.set('label', '');
        attrs.set('booktabs', true);
        attrs.set('header_row', true);
        attrs.set('align', 'll');
      }
    }, 'insert-block-at');
    return blockId;
  }

  function moveSection(sectionId, delta) {
    var hit = findSection(sectionId);
    if (!hit) return;
    var idx = hit.idx;
    var target = idx + delta;
    if (target < 0 || target >= state.sectionsArr.length) return;
    state.conn.yDoc.transact(function () {
      // Snapshot the moving section into a plain JS tree, delete the old
      // Y.Map, then re-insert at target via attach-then-mutate.
      var snapshot = sectionMapToTree(hit.map);
      state.sectionsArr.delete(idx, 1);
      // insertSectionAt helps us insert at a specific index using attach-first.
      var Y = state.Y;
      var m = new Y.Map();
      state.sectionsArr.insert(target, [m]);
      hydrateSectionFromTree(m, snapshot);
    }, 'move-section');
  }

  /* Snapshot a Y.Map section to plain JS, used by move/reorder. */
  function sectionMapToTree(secMap) {
    var Y = state.Y;
    var label = secMap.get('label');
    var labelStr = (label instanceof Y.Text) ? label.toString() : String(label || '');
    var children = [];
    var src = secMap.get('children');
    if (src) src.forEach(function (b) { children.push(blockMapToTree(b)); });
    return {
      id: secMap.get('id'),
      kind: secMap.get('kind'),
      label: labelStr,
      order: secMap.get('order') || 0,
      status: secMap.get('status') || 'draft',
      children: children,
    };
  }
  function blockMapToTree(b) {
    var Y = state.Y;
    var sk = b.get('skeleton');
    var bd = b.get('body');
    return {
      id: b.get('id'),
      kind: b.get('kind'),
      status: b.get('status') || 'draft',
      skeleton: (sk instanceof Y.Text) ? sk.toString() : String(sk || ''),
      body:     (bd instanceof Y.Text) ? bd.toString() : String(bd || ''),
      attrs: {},
    };
  }

  /* Hydrate an attached Y.Map with a section tree. m must already be in the doc. */
  function hydrateSectionFromTree(m, sec) {
    var Y = state.Y;
    m.set('id', sec.id);
    m.set('kind', sec.kind);
    m.set('label', new Y.Text(''));
    if (sec.label) m.get('label').insert(0, sec.label);
    m.set('order', sec.order || 0);
    m.set('status', sec.status || 'draft');
    m.set('children', new Y.Array());
    var children = m.get('children');
    (sec.children || []).forEach(function (blk) {
      appendBlockFromTree(children, blk);
    });
  }

  function deleteSection(sectionId) {
    if (!confirm('Delete this section and all its paragraphs?')) return;
    var hit = findSection(sectionId);
    if (!hit) return;
    state.conn.yDoc.transact(function () {
      state.sectionsArr.delete(hit.idx, 1);
    }, 'delete-section');
    if (state.activeSectionId === sectionId) {
      var arr = state.sectionsArr.toArray();
      state.activeSectionId = arr[0] ? arr[0].get('id') : null;
    }
  }

  function addSectionPrompt() {
    if (!state.editable) return;
    var schemas = window.PaperSchemas;
    var kinds = schemas.PAPER_SECTION_KINDS;
    var kind = window.prompt('Section kind?\n\nOptions: ' + kinds.join(', '), 'introduction');
    if (!kind) return;
    if (kinds.indexOf(kind) < 0) kind = 'custom';
    var defaultLabel = schemas.SECTION_KIND_LABELS[kind] || 'New section';
    var label = window.prompt('Section title?', defaultLabel);
    if (label === null) return;
    var sec = schemas.newSection(kind, label || defaultLabel, state.sectionsArr.length);
    sec.children.push(schemas.newParagraph());
    var newSecId = sec.id;
    state.conn.yDoc.transact(function () {
      appendSectionFromTree(state.sectionsArr, sec);
    }, 'add-section');
    state.activeSectionId = newSecId;
  }

  /* ── View filter ── */

  viewFilterSel.addEventListener('change', function () {
    state.viewFilter = viewFilterSel.value;
    render();
  });
  if (statusFilterSel) {
    statusFilterSel.addEventListener('change', function () {
      state.statusFilter = statusFilterSel.value;
      render();
    });
  }
  addSectionBtn.addEventListener('click', addSectionPrompt);

  /* ── Title sync to papers.json (debounced) ── */

  var titleSyncTimer = null;
  function scheduleTitleSync() {
    if (titleSyncTimer) clearTimeout(titleSyncTimer);
    titleSyncTimer = setTimeout(syncTitleToPapersJson, 1500);
  }
  async function syncTitleToPapersJson() {
    titleSyncTimer = null;
    try {
      var data = await api.load('projects/papers.json');
      var rows = (data && data.papers) || [];
      var row = rows.find(function (p) { return p.id === state.paperId; });
      if (!row) return;
      var newTitle = state.titleY.toString();
      if (row.title === newTitle) return;
      row.title = newTitle;
      await api.save('projects/papers.json', { papers: rows });
      state.meta.title = newTitle;
    } catch (err) {
      console.warn('[paper-editor] Title sync to papers.json failed:', err.message);
    }
  }

  /* ── Save status (Yjs auto-syncs; we just surface "connected/error") ── */

  function setSaveStatus(msg, kind) {
    saveStateEl.textContent = msg;
    saveStateEl.className = 'pe-savestate' +
      (kind === 'saving' ? ' pe-savestate-saving' :
       kind === 'saved'  ? ' pe-savestate-saved'  :
       kind === 'err'    ? ' pe-savestate-err'    : '');
    if (kind === 'saved') {
      setTimeout(function () {
        if (saveStateEl.textContent === msg) {
          saveStateEl.textContent = '';
          saveStateEl.className = 'pe-savestate';
        }
      }, 2500);
    }
  }

  /* ── Banner ── */

  function showReadonlyBanner(msg) {
    readonlyBanner.textContent = msg;
    readonlyBanner.hidden = false;
  }
  function hideReadonlyBanner() {
    readonlyBanner.hidden = true;
  }

  /* ── Presence row ── */

  function ensurePresenceRow() {
    if (presenceRowEl) return presenceRowEl;
    presenceRowEl = document.createElement('div');
    presenceRowEl.className = 'pe-presence-row';
    // Insert before the savestate element so the row reads left-to-right
    // alongside the title.
    topbarEl.insertBefore(presenceRowEl, saveStateEl);
    return presenceRowEl;
  }

  function renderPresenceRow() {
    var row = ensurePresenceRow();
    row.innerHTML = '';
    var arr = state.presenceList.slice().sort(function (a, b) {
      // Self last (rightmost).
      if (a.isSelf !== b.isSelf) return a.isSelf ? 1 : -1;
      return (a.name || '').localeCompare(b.name || '');
    });
    arr.forEach(function (p) {
      var dot = document.createElement('span');
      dot.className = 'pe-presence-dot';
      dot.title = (p.isSelf ? '(you) ' : '') + (p.name || p.uid);
      dot.style.background = p.color;
      dot.textContent = initials(p.name || p.uid);
      if (p.isSelf) dot.classList.add('pe-presence-self');
      row.appendChild(dot);
    });
  }

  /* ── Coauthor invite UI (lead author only) ── */

  /* Recompute members[] and member_uids[] on a paper row from its
   * existing lead_author_uid + coauthor_uids fields. PMR's per-student
   * project rollup queries Firestore via
   * `where('member_uids','array-contains',uid)`, so this stamp must run
   * any time the legacy fields are mutated. Idempotent: existing
   * members[] entries with the same uid keep their role/dates/effort.
   */
  function syncPaperMembers(row) {
    if (!row || typeof row !== 'object') return;
    var existing = {};
    for (var i = 0; i < (row.members || []).length; i++) {
      var m = row.members[i];
      if (m && m.uid) existing[m.uid] = m;
    }
    var today = new Date().toISOString().slice(0, 10);
    var members = [];
    var seen = {};
    var lead = (row.lead_author_uid || '').trim();
    if (lead) {
      members.push(existing[lead] || { uid: lead, role: 'lead', start_date: today, end_date: null, effort_pct: null });
      seen[lead] = true;
    }
    var caUids = row.coauthor_uids || [];
    for (var j = 0; j < caUids.length; j++) {
      var u = (caUids[j] || '').trim();
      if (!u || seen[u]) continue;
      members.push(existing[u] || { uid: u, role: 'co-author', start_date: today, end_date: null, effort_pct: null });
      seen[u] = true;
    }
    row.members = members;
    row.member_uids = members.map(function (mm) { return mm.uid; });
  }

  function ensureInviteButton() {
    if (!firebridge.isLeadAuthor(state.meta) && !firebridge.isAdmin()) {
      if (inviteBtnEl) inviteBtnEl.remove();
      inviteBtnEl = null;
    } else if (!inviteBtnEl) {
      inviteBtnEl = document.createElement('button');
      inviteBtnEl.type = 'button';
      inviteBtnEl.className = 'btn pe-invite-btn';
      inviteBtnEl.textContent = 'Coauthors';
      inviteBtnEl.title = 'Manage paper coauthors';
      inviteBtnEl.addEventListener('click', openInviteDialog);
      topbarEl.insertBefore(inviteBtnEl, saveStateEl);
    }
    // "Reset & re-import" — only when an import file exists and user is admin.
    // Uses the data/paper-imports/<id>.json produced by import_tex_paper.py.
    if (firebridge.isAdmin() && hasImportFile) {
      if (!resetBtnEl) {
        resetBtnEl = document.createElement('button');
        resetBtnEl.type = 'button';
        resetBtnEl.className = 'btn pe-invite-btn';
        resetBtnEl.style.borderColor = '#b91c1c';
        resetBtnEl.style.color = '#b91c1c';
        resetBtnEl.textContent = 'Reset & re-import';
        resetBtnEl.title = 'Delete current Yjs state and re-import from data/paper-imports/' +
                           state.paperId + '.json';
        resetBtnEl.addEventListener('click', resetAndReimport);
        topbarEl.insertBefore(resetBtnEl, saveStateEl);
      }
    } else if (resetBtnEl) {
      resetBtnEl.remove();
      resetBtnEl = null;
    }
    /* Export to LaTeX — visible to anyone who can edit the paper. V3.231
     * opens the Paper Export Workspace page (template + addons + style
     * overrides + PDF preview). The legacy openExportDialog (local
     * Python dev-server in_place mode) is kept for the moment so admins
     * can fall back via the JS console, but the button no longer routes
     * there. */
    if (state.editable && !exportBtnEl) {
      exportBtnEl = document.createElement('button');
      exportBtnEl.type = 'button';
      exportBtnEl.className = 'btn pe-invite-btn';
      exportBtnEl.textContent = 'Export LaTeX';
      exportBtnEl.title = 'Open the export workspace: pick template + add-ons, compile to PDF, download .zip';
      exportBtnEl.addEventListener('click', openExportWorkspace);
      topbarEl.insertBefore(exportBtnEl, saveStateEl);
    }
    /* Versions — Phase D named snapshots (Save / Restore). Visible to
     * anyone who can edit; Restore is destructive and confirms first. */
    if (state.editable && !versionsBtnEl) {
      versionsBtnEl = document.createElement('button');
      versionsBtnEl.type = 'button';
      versionsBtnEl.className = 'btn pe-invite-btn';
      versionsBtnEl.textContent = 'Versions';
      versionsBtnEl.title = 'Save / restore named snapshots of this paper';
      versionsBtnEl.addEventListener('click', openVersionsDialog);
      topbarEl.insertBefore(versionsBtnEl, saveStateEl);
    }
    /* V3.234 — Linked files: external URLs (Synology share, Drive, etc.)
     * attached to the paper. Stored on the top-level papers/{paperId}
     * doc as `externalLinks[]`; the Yjs body is untouched. Visible to
     * lab readers; only editors can add / remove. */
    ensureExternalLinksBtn();
  }

  /* ── V3.234 External links topbar button + popover ───────────────────
   * Backed by direct firebridge.db() reads/writes on papers/{paperId}
   * (the field is additive on the existing meta doc; no new collection
   * or rule change). Popover uses .ext-links-popover styles from
   * rm/css/style.css. */
  var extLinksBtnEl = null;
  var extLinksPopoverEl = null;
  var extLinksLocal = null;
  var extLinksUnsub = null;

  function ensureExternalLinksBtn() {
    if (!topbarEl || !state.meta) return;
    if (extLinksBtnEl) return;
    extLinksBtnEl = document.createElement('button');
    extLinksBtnEl.type = 'button';
    extLinksBtnEl.className = 'btn pe-invite-btn';
    extLinksBtnEl.title = 'Linked files (Synology, Drive, etc.) attached to this paper';
    refreshExternalLinksBtnLabel();
    extLinksBtnEl.addEventListener('click', toggleExternalLinksPopover);
    topbarEl.insertBefore(extLinksBtnEl, saveStateEl);

    // Subscribe to the meta doc so the count badge stays live across
    // tabs and other collaborators' edits.
    try {
      var paperId = (state.meta && state.meta.id) || null;
      if (paperId && firebridge && firebridge.db) {
        extLinksUnsub = firebridge.db().collection('items').doc(paperId)
          .onSnapshot(function (snap) {
            var data = snap.exists ? (snap.data() || {}) : {};
            var arr = (window.EXTERNAL_LINKS && window.EXTERNAL_LINKS.hydrate)
              ? window.EXTERNAL_LINKS.hydrate(data.externalLinks)
              : (Array.isArray(data.externalLinks) ? data.externalLinks : []);
            extLinksLocal = arr;
            refreshExternalLinksBtnLabel();
            // Re-render the popover body if it's open.
            if (extLinksPopoverEl && extLinksPopoverEl.dataset.controller) {
              try { extLinksPopoverEl._controller && extLinksPopoverEl._controller.refresh(); }
              catch (e) {}
            }
          }, function (err) {
            console.warn('[paper-editor] externalLinks subscription failed:', err && err.message);
          });
      }
    } catch (e) {
      console.warn('[paper-editor] externalLinks subscribe error:', e && e.message);
    }
  }

  function refreshExternalLinksBtnLabel() {
    if (!extLinksBtnEl) return;
    var n = Array.isArray(extLinksLocal) ? extLinksLocal.length : 0;
    extLinksBtnEl.textContent = '🔗 Linked files' + (n ? ' (' + n + ')' : '');
  }

  function toggleExternalLinksPopover() {
    if (extLinksPopoverEl) {
      extLinksPopoverEl.remove();
      extLinksPopoverEl = null;
      document.removeEventListener('click', onExtLinksDocClick, true);
      return;
    }
    extLinksPopoverEl = document.createElement('div');
    extLinksPopoverEl.className = 'ext-links-popover';
    extLinksPopoverEl.dataset.controller = '1';
    // Position below the button.
    var rect = extLinksBtnEl.getBoundingClientRect();
    extLinksPopoverEl.style.top  = (window.scrollY + rect.bottom + 4) + 'px';
    extLinksPopoverEl.style.left = Math.max(8, (window.scrollX + rect.right - 420)) + 'px';
    document.body.appendChild(extLinksPopoverEl);

    var readOnly = !state.editable;
    extLinksPopoverEl._controller = window.EXTERNAL_LINKS.mount({
      container: extLinksPopoverEl,
      getLinks: function () { return extLinksLocal || []; },
      setLinks: function (next) {
        extLinksLocal = next;
        refreshExternalLinksBtnLabel();
        persistExternalLinks(next);
      },
      readOnly: readOnly,
    });
    setTimeout(function () {
      document.addEventListener('click', onExtLinksDocClick, true);
    }, 0);
  }

  function onExtLinksDocClick(e) {
    if (!extLinksPopoverEl) return;
    if (extLinksPopoverEl.contains(e.target)) return;
    if (extLinksBtnEl && extLinksBtnEl.contains(e.target)) return;
    extLinksPopoverEl.remove();
    extLinksPopoverEl = null;
    document.removeEventListener('click', onExtLinksDocClick, true);
  }

  function persistExternalLinks(arr) {
    var paperId = state.meta && state.meta.id;
    if (!paperId || !firebridge || !firebridge.db) return;
    firebridge.db().collection('items').doc(paperId)
      .set({ externalLinks: arr, updatedAt: new Date().toISOString() }, { merge: true })
      .catch(function (err) {
        console.warn('[paper-editor] externalLinks save failed:', err && err.message);
      });
  }

  /* ── Phase C: Inventory quick-insert (Methods sections) ───────────────
   *
   * Loads `data/inventory/items.json` once per session, opens a search
   * dialog when the user hits "+ Reagent / equipment" in a Methods section,
   * and inserts a new paragraph block with the chosen item formatted as:
   *
   *   "<name> (<vendor>, cat. <catalogue_number>) — <description>"
   *
   * The item id is preserved in attrs.item_ref so the paragraph can be
   * re-linked to inventory data later (e.g. price-history changes, vendor
   * renamed, etc.).
   */
  var inventoryState = { list: null, popover: null };

  async function ensureInventoryList() {
    if (inventoryState.list) return inventoryState.list;
    /* V3.108 — load BOTH equipment-class (`inventory/items.json`,
     * kind=item) AND reagent-class (`inventory/chemicals.json`,
     * kind=chemical) entries. Pre-V3.108 only loaded items.json, so
     * chemicals like agarose were unreachable from the popover. The
     * Firestore `inventory` collection is unified — these are just two
     * filtered views of the same collection, so a single merged
     * client-side list is the natural projection. */
    function projectEntry(it, kind) {
      var safety = (kind === 'chemical' && it.safety) || {};
      var cas = safety.cas_number || '';
      var formula = safety.formula || '';
      return {
        id: it.id,
        kind: kind,
        name: it.name || '',
        vendor: it.vendor || '',
        cat: it.catalogue_number || '',
        cas: cas,
        formula: formula,
        desc: it.description || '',
        category: it.category || '',
        subcategory: it.subcategory || '',
        // Haystack for substring search. Chemicals contribute CAS +
        // formula on top of the shared fields so the user can search
        // by either.
        search: ((it.name || '') + ' ' + (it.vendor || '') + ' ' +
                 (it.catalogue_number || '') + ' ' + cas + ' ' +
                 formula + ' ' + (it.description || '') + ' ' +
                 (it.category || '') + ' ' + (it.subcategory || '')).toLowerCase(),
      };
    }
    try {
      var both = await Promise.all([
        api.load('inventory/items.json').catch(function (e) {
          console.warn('[paper-editor] inventory items load failed:', e && e.message || e);
          return null;
        }),
        api.load('inventory/chemicals.json').catch(function (e) {
          console.warn('[paper-editor] inventory chemicals load failed:', e && e.message || e);
          return null;
        }),
      ]);
      var itemRows = ((both[0] && both[0].items) || []).map(function (it) {
        return projectEntry(it, 'item');
      });
      var chemRows = ((both[1] && both[1].chemicals) || []).map(function (it) {
        return projectEntry(it, 'chemical');
      });
      // Stable order: chemicals first (most-common Methods-section
      // lookup is a reagent), then equipment, alphabetical within each.
      function byName(a, b) {
        return (a.name || '').toLowerCase().localeCompare((b.name || '').toLowerCase());
      }
      chemRows.sort(byName);
      itemRows.sort(byName);
      inventoryState.list = chemRows.concat(itemRows);
      return inventoryState.list;
    } catch (err) {
      console.warn('[paper-editor] inventory load failed:', err.message);
      inventoryState.list = [];
      return inventoryState.list;
    }
  }

  /* V3.151 — inventory popover positioning. Anchored to the button
   * that opened it (the "+ Add → Reagent / equipment" menu item, whose
   * anchorBtn is the section's "+ Add" inserter). Clamped to the
   * viewport in a requestAnimationFrame after layout. Falls back to
   * top-center if no anchor was passed. */
  function _positionInvPopoverNearAnchor(popEl, anchorEl) {
    var marginPx = 8;
    var offsetY = 4;
    if (!anchorEl || typeof anchorEl.getBoundingClientRect !== 'function') {
      popEl.style.left = '50%';
      popEl.style.top = '120px';
      popEl.style.transform = 'translateX(-50%)';
      return;
    }
    popEl.style.transform = '';
    var aRect = anchorEl.getBoundingClientRect();
    popEl.style.left = aRect.left + 'px';
    popEl.style.top = (aRect.bottom + offsetY) + 'px';
    requestAnimationFrame(function () {
      var pRect = popEl.getBoundingClientRect();
      var leftPx = aRect.left;
      var topPx = aRect.bottom + offsetY;
      if (leftPx + pRect.width > window.innerWidth - marginPx) {
        leftPx = Math.max(marginPx, window.innerWidth - pRect.width - marginPx);
      }
      if (leftPx < marginPx) leftPx = marginPx;
      if (topPx + pRect.height > window.innerHeight - marginPx) {
        var topAlt = aRect.top - pRect.height - offsetY;
        if (topAlt >= marginPx) topPx = topAlt;
        else topPx = Math.max(marginPx, window.innerHeight - pRect.height - marginPx);
      }
      if (topPx < marginPx) topPx = marginPx;
      popEl.style.left = leftPx + 'px';
      popEl.style.top = topPx + 'px';
    });
  }

  async function openInventoryDialog(sectionId, anchorEl) {
    if (!state.editable) return;
    await ensureInventoryList();
    var pop = ensureInventoryPopover();
    pop._setSectionId(sectionId);
    _positionInvPopoverNearAnchor(pop, anchorEl);
    pop._refresh();
    pop.hidden = false;
    pop._focus();
  }

  function ensureInventoryPopover() {
    if (inventoryState.popover) return inventoryState.popover;
    var pop = document.createElement('div');
    pop.className = 'pe-cite-popover pe-inv-popover';
    pop.hidden = true;
    pop.innerHTML =
      '<div class="pe-cite-pop-title">Insert reagent / equipment</div>' +
      '<input type="text" class="pe-cite-pop-search" placeholder="Search by name, vendor, catalog #, category…" autocomplete="off">' +
      '<div class="pe-cite-pop-list" role="listbox"></div>' +
      '<div class="pe-cite-pop-hint">' +
        '<kbd>↑</kbd>/<kbd>↓</kbd> navigate · <kbd>Enter</kbd> insert · <kbd>Esc</kbd> close' +
      '</div>';
    document.body.appendChild(pop);
    // V3.151 — positioning moved to openInventoryDialog so the popover
    // anchors to the button that opened it (was hardcoded top-center).
    inventoryState.popover = pop;

    var input = pop.querySelector('.pe-cite-pop-search');
    var listEl = pop.querySelector('.pe-cite-pop-list');
    var activeIdx = 0;
    var current = [];
    var sectionId = null;

    pop._setSectionId = function (sid) { sectionId = sid; };
    pop._refresh = function () {
      var q = input.value.trim().toLowerCase();
      var src = inventoryState.list || [];
      var matched = q
        ? src.filter(function (e) { return e.search.indexOf(q) >= 0; })
        : src.slice(0, 30);
      current = matched.slice(0, 60);
      activeIdx = current.length ? 0 : -1;
      renderList();
    };
    function renderList() {
      listEl.innerHTML = '';
      if (!current.length) {
        listEl.innerHTML = '<div class="pe-cite-pop-empty">No matching inventory items.</div>';
        return;
      }
      current.forEach(function (e, i) {
        var row = document.createElement('button');
        row.type = 'button';
        row.className = 'pe-cite-pop-row';
        if (i === activeIdx) row.classList.add('active');
        // V3.108 — badge the kind (chemical vs item) so the user can
        // tell at a glance whether they're picking a reagent or
        // equipment. Chemicals also surface CAS / formula in the meta
        // line when available.
        var kindBadge = '<span class="pe-inv-kind-badge pe-inv-kind-' +
          (e.kind || 'item') + '">' +
          escapeHtmlForCE(e.kind === 'chemical' ? 'chemical' : 'item') +
          '</span>';
        var metaParts = [];
        if (e.vendor) metaParts.push(escapeHtmlForCE(e.vendor));
        if (e.cat) metaParts.push('cat. ' + escapeHtmlForCE(e.cat));
        if (e.cas) metaParts.push('CAS ' + escapeHtmlForCE(e.cas));
        if (e.formula) metaParts.push(escapeHtmlForCE(e.formula));
        if (e.category) metaParts.push(escapeHtmlForCE(e.category) + (e.subcategory ? ' / ' + escapeHtmlForCE(e.subcategory) : ''));
        row.innerHTML =
          '<div class="pe-cite-pop-key">' +
            kindBadge +
            '<span class="pe-inv-name">' + escapeHtmlForCE(e.name || '(no name)') + '</span>' +
          '</div>' +
          '<div class="pe-cite-pop-meta">' + metaParts.join(' · ') + '</div>' +
          (e.desc ? '<div class="pe-cite-pop-title-line">' + escapeHtmlForCE(e.desc.slice(0, 140)) + '</div>' : '');
        // V3.148 — DO NOT call renderList() on mouseenter. The full
        // rebuild was racing the click: when the cursor entered a row,
        // the row got destroyed-and-recreated synchronously, and the
        // user's mousedown landed on the parent .pe-cite-pop-list
        // instead of the row button. Just toggle the active class
        // in place.
        row.addEventListener('mouseenter', function () {
          if (activeIdx === i) return;
          activeIdx = i;
          Array.prototype.forEach.call(listEl.querySelectorAll('.pe-cite-pop-row'), function (r, idx) {
            r.classList.toggle('active', idx === i);
          });
        });
        row.addEventListener('click', function () { pickIndex(i); });
        listEl.appendChild(row);
      });
    }
    function pickIndex(i) {
      var entry = current[i];
      if (!entry || !sectionId) return;
      pop.hidden = true;
      insertInventoryItem(sectionId, entry);
    }
    input.addEventListener('input', pop._refresh);
    input.addEventListener('keydown', function (e) {
      if (e.key === 'Escape') { pop.hidden = true; e.preventDefault(); return; }
      if (e.key === 'Enter')  { pickIndex(activeIdx); e.preventDefault(); return; }
      if (e.key === 'ArrowDown') {
        if (current.length) activeIdx = (activeIdx + 1) % current.length;
        renderList(); e.preventDefault();
      }
      if (e.key === 'ArrowUp') {
        if (current.length) activeIdx = (activeIdx - 1 + current.length) % current.length;
        renderList(); e.preventDefault();
      }
    });
    document.addEventListener('mousedown', function (e) {
      if (!pop.hidden && !pop.contains(e.target)) pop.hidden = true;
    });
    pop._focus = function () { input.focus(); input.select(); };
    return pop;
  }

  function insertInventoryItem(sectionId, item) {
    var hit = findSection(sectionId);
    if (!hit) return;
    var Y = state.Y;
    // V3.108 — chemicals append CAS in the parenthetical so the
    // generated Methods sentence is publication-ready (CAS numbers are
    // a common journal requirement for reagents).
    var parenParts = [];
    if (item.vendor) parenParts.push(item.vendor);
    if (item.cat) parenParts.push('cat. ' + item.cat);
    if (item.kind === 'chemical' && item.cas) parenParts.push('CAS ' + item.cas);
    var bodyText = item.name +
                   (parenParts.length ? ' (' + parenParts.join(', ') + ')' : '') +
                   (item.desc ? ' — ' + item.desc : '');
    state.conn.yDoc.transact(function () {
      var children = hit.map.get('children');
      var m = new Y.Map();
      children.push([m]);
      m.set('id', window.PaperSchemas.shortId('p-'));
      m.set('kind', 'paragraph');
      m.set('status', 'draft');
      m.set('skeleton', new Y.Text(''));
      m.set('body', new Y.Text(''));
      m.get('body').insert(0, bodyText);
      m.set('attrs', new Y.Map());
      m.get('attrs').set('item_ref', item.id);
    }, 'add-inventory-paragraph');
  }

  /* ── Phase D: Comments ──────────────────────────────────────────────────
   *
   * Each comment is a doc at `papers/{paperId}/comments/{commentId}` with:
   *   { blockId, parentId, body, authorUid, authorName, createdAt, modifiedAt, resolved }
   *
   * Stored at the paper level (not nested under a block) so the side-pane
   * subscription is one query per paper. We index counts per block in
   * memory for the chip badge on each block toolbar.
   */
  var commentsState = {
    docs: [],                         // all current comments for this paper
    countsByBlock: Object.create(null),
    activeBlockId: null,              // block whose thread is open in the panel
    unsub: null,
    /* V3.204 — filter mode: 'block' shows comments for activeBlockId
     * only (legacy behavior); 'view' shows comments for every paragraph
     * currently visible in the viewport (computed on-demand from the
     * DOM). Persisted to localStorage `rm_paper_comments_filter`. */
    filter: 'block',
    /* V3.204 — when the floating "💬 Comment" button is clicked on a
     * text selection, the (anchorStart, anchorEnd, anchorText) for
     * that selection is staged here. submitComment includes it in the
     * Firestore doc as the comment's text-range anchor. Cleared after
     * submit OR after the user types in the composer without a staged
     * anchor (a regular block-level comment). */
    pendingAnchor: null,
    /* V3.216 — when the reader clicks an anchored-text highlight in the
     * body, the comment pane scopes to that exact set of comment IDs
     * (the union of all comments whose range overlapped the click).
     * Cleared when the user changes filter, opens a different block via
     * the toolbar button, or closes the pane. */
    anchorFilterIds: null,
  };
  var commentsPaneEl   = null;
  var commentsListEl   = null;
  var commentsInputEl  = null;
  var commentsCloseEl  = null;
  var commentsSubmitEl = null;
  var commentsCtxEl    = null;
  var commentsFilterEl = null;
  var commentsAnchorPreviewEl = null;
  var commentsFloatingBtnEl = null;
  var _commentScrollRefreshTimer = null;

  function ensureCommentsRefs() {
    commentsPaneEl   = document.getElementById('pe-comments-pane');
    commentsListEl   = document.getElementById('pe-comments-list');
    commentsInputEl  = document.getElementById('pe-comments-input');
    commentsCloseEl  = document.getElementById('pe-comments-close');
    commentsSubmitEl = document.getElementById('pe-comments-submit');
    commentsCtxEl    = document.getElementById('pe-comments-context');
    commentsFilterEl = document.getElementById('pe-comments-filter');
    commentsAnchorPreviewEl = document.getElementById('pe-comments-anchor-preview');
  }
  function subscribeComments() {
    ensureCommentsRefs();
    if (commentsState.unsub) return;
    var ref = firebridge.db().collection('papers').doc(state.paperId)
                .collection('comments').orderBy('createdAt', 'asc');
    commentsState.unsub = ref.onSnapshot({
      next: function (snap) {
        commentsState.docs = snap.docs.map(function (d) {
          return Object.assign({ id: d.id }, d.data());
        });
        recomputeCommentCounts();
        /* V3.204 — refresh whenever any filter has an active scope.
         * Block mode needs activeBlockId; view mode shows whatever
         * paragraphs are on-screen regardless. */
        if (commentsState.activeBlockId || commentsState.filter === 'view') {
          renderCommentsList();
        }
        // Notify each rendered block toolbar to refresh its chip.
        window.dispatchEvent(new CustomEvent('paper-comment-counts-changed'));
      },
      error: function (err) {
        console.warn('[paper-editor] comments subscription error:', err.message);
      },
    });
    commentsCloseEl.addEventListener('click', function () { closeComments(); });
    commentsSubmitEl.addEventListener('click', submitComment);
    commentsInputEl.addEventListener('keydown', function (e) {
      if (e.key === 'Enter' && (e.metaKey || e.ctrlKey)) submitComment();
    });
    /* V3.204 — filter dropdown + persisted setting. */
    try {
      var saved = localStorage.getItem('rm_paper_comments_filter');
      if (saved === 'view' || saved === 'block') commentsState.filter = saved;
    } catch (e) {}
    if (commentsFilterEl) {
      commentsFilterEl.value = commentsState.filter;
      commentsFilterEl.addEventListener('change', function () {
        commentsState.filter = commentsFilterEl.value;
        try { localStorage.setItem('rm_paper_comments_filter', commentsState.filter); } catch (e) {}
        /* V3.216 — switching filter mode clears any anchor-id scope so
         * the dropdown is the source of truth again. */
        commentsState.anchorFilterIds = null;
        _refreshCommentsComposerState();
        renderCommentsList();
      });
    }
    /* V3.204 — in-view filter needs to refresh as the user scrolls.
     * Debounced to avoid thrashing on every scroll event. */
    window.addEventListener('scroll', function () {
      if (commentsState.filter !== 'view') return;
      if (commentsPaneEl && commentsPaneEl.hidden) return;
      if (_commentScrollRefreshTimer) return;
      _commentScrollRefreshTimer = setTimeout(function () {
        _commentScrollRefreshTimer = null;
        renderCommentsList();
      }, 120);
    }, { passive: true });
    /* V3.204 — selection-driven floating "💬 Comment" button. */
    _installCommentSelectionWatcher();
  }

  function recomputeCommentCounts() {
    var c = Object.create(null);
    commentsState.docs.forEach(function (d) {
      if (d.resolved) return;
      c[d.blockId] = (c[d.blockId] || 0) + 1;
    });
    commentsState.countsByBlock = c;
    _updateMobileRightBadge();
  }

  /* V3.235 — Mobile right-drawer badge shows total open comments so a
   * phone user sees the count without sliding the drawer in. */
  function _updateMobileRightBadge() {
    var badge = document.getElementById('pe-mobile-right-toggle-badge');
    if (!badge) return;
    var total = commentsState.docs.reduce(function (n, d) {
      return n + (d.resolved ? 0 : 1);
    }, 0);
    if (total > 0) {
      badge.hidden = false;
      badge.textContent = total > 99 ? '99+' : String(total);
    } else {
      badge.hidden = true;
    }
  }

  function openCommentsForBlock(blockId, blockLabel, anchor) {
    ensureCommentsRefs();
    commentsState.activeBlockId = blockId;
    /* V3.216 — toolbar button entry-points clear any active anchor-id
     * scope from a prior highlight click so the pane returns to
     * block-mode behavior. */
    commentsState.anchorFilterIds = null;
    commentsCtxEl.textContent = blockLabel || ('Block ' + (blockId || '').slice(0, 8));
    /* V3.204 — stage an optional text-range anchor; submitComment
     * adds the anchor fields to the Firestore doc. */
    commentsState.pendingAnchor = anchor || null;
    _refreshAnchorPreview();
    commentsPaneEl.hidden = false;
    _refreshCommentsComposerState();
    renderCommentsList();
    commentsInputEl.value = '';
    commentsInputEl.focus();
  }
  /* V3.216 — entry-point used when a reader clicks an in-body highlight.
   * Opens the pane scoped to the union of comment IDs whose anchor
   * overlapped the clicked span. Filter mode forces to 'block' so the
   * scope is unambiguous; the visible list is further narrowed by
   * `anchorFilterIds`. */
  function openCommentsForBlockWithAnchorIds(blockId, blockLabel, commentIds) {
    ensureCommentsRefs();
    commentsState.activeBlockId = blockId;
    commentsState.anchorFilterIds = (commentIds || []).slice();
    commentsState.pendingAnchor = null;
    if (commentsState.filter !== 'block') {
      commentsState.filter = 'block';
      if (commentsFilterEl) commentsFilterEl.value = 'block';
      try { localStorage.setItem('rm_paper_comments_filter', 'block'); } catch (e) {}
    }
    commentsCtxEl.textContent = blockLabel || ('Block ' + (blockId || '').slice(0, 8));
    _refreshAnchorPreview();
    commentsPaneEl.hidden = false;
    _refreshCommentsComposerState();
    renderCommentsList();
    if (commentsInputEl) commentsInputEl.value = '';
  }
  /* V3.219 — when the user focuses a paragraph, retarget the open pane
   * to that paragraph so its comments show by default. No-op if the
   * pane is closed, the filter is in 'view' mode (handles itself), or
   * we're already on the same block. Clears any leftover anchor scope
   * from the prior block. */
  function _maybeRefocusCommentsPane(blockId) {
    if (!blockId) return;
    if (!commentsPaneEl || commentsPaneEl.hidden) return;
    if (commentsState.filter !== 'block') return;
    if (commentsState.activeBlockId === blockId) return;
    commentsState.activeBlockId = blockId;
    commentsState.pendingAnchor = null;
    commentsState.anchorFilterIds = null;
    if (commentsCtxEl) commentsCtxEl.textContent = _blockShortLabel(blockId);
    _refreshAnchorPreview();
    _refreshCommentsComposerState();
    renderCommentsList();
  }
  function closeComments() {
    commentsState.activeBlockId = null;
    commentsState.pendingAnchor = null;
    commentsState.anchorFilterIds = null;
    if (commentsPaneEl) commentsPaneEl.hidden = true;
    _hideCommentFloatingBtn();
    /* V3.235 — also retract the mobile right drawer if it was open;
     * otherwise data-drawer stays "right" with [hidden] hiding the
     * pane content and the backdrop sticks around with nothing behind it. */
    var host = document.querySelector('.pe-page.rm-mobile-drawer-host');
    if (host && host._rmMobileDrawersWired) host._rmMobileDrawersWired.close();
  }

  /* V3.204 — composer state depends on filter mode. In 'view' mode
   * (no single active block), the composer needs either an active
   * block from a recent click OR a staged text-anchor. When neither
   * is set, the textarea + Post button are disabled with a tooltip
   * hinting at "click a paragraph or highlight text first". */
  function _refreshCommentsComposerState() {
    if (!commentsInputEl) return;
    var canPost = !!commentsState.activeBlockId;
    commentsInputEl.disabled = !canPost;
    commentsSubmitEl.disabled = !canPost;
    commentsInputEl.placeholder = canPost
      ? 'Write a comment…'
      : 'Click a paragraph or highlight text to start a comment…';
  }

  function _refreshAnchorPreview() {
    if (!commentsAnchorPreviewEl) return;
    var a = commentsState.pendingAnchor;
    if (!a || !a.anchorText) {
      commentsAnchorPreviewEl.hidden = true;
      commentsAnchorPreviewEl.innerHTML = '';
      return;
    }
    commentsAnchorPreviewEl.hidden = false;
    commentsAnchorPreviewEl.innerHTML = '';
    var lbl = document.createElement('span');
    lbl.className = 'pe-comments-anchor-label';
    lbl.textContent = 'Commenting on: ';
    var snip = document.createElement('span');
    snip.className = 'pe-comments-anchor-snippet';
    var text = String(a.anchorText || '');
    snip.textContent = '“' + text.slice(0, 120) + (text.length > 120 ? '…' : '') + '”';
    var clearBtn = document.createElement('button');
    clearBtn.type = 'button';
    clearBtn.className = 'pe-comments-anchor-clear';
    clearBtn.title = 'Detach this highlight — comment will apply to the whole block';
    clearBtn.textContent = '×';
    clearBtn.addEventListener('click', function () {
      commentsState.pendingAnchor = null;
      _refreshAnchorPreview();
    });
    commentsAnchorPreviewEl.appendChild(lbl);
    commentsAnchorPreviewEl.appendChild(snip);
    commentsAnchorPreviewEl.appendChild(clearBtn);
  }

  /* V3.204 — compute the set of paragraph block IDs whose DOM rect
   * currently intersects the viewport. Used by the 'view' filter. */
  function _visibleBlockIds() {
    var blocks = document.querySelectorAll('.pe-block[data-block-id]');
    var vh = window.innerHeight;
    var set = Object.create(null);
    var order = [];
    Array.prototype.forEach.call(blocks, function (b) {
      var rect = b.getBoundingClientRect();
      if (rect.bottom > 0 && rect.top < vh) {
        var id = b.dataset.blockId;
        if (!set[id]) {
          set[id] = true;
          order.push(id);
        }
      }
    });
    return { set: set, order: order };
  }

  function renderCommentsList() {
    if (!commentsListEl) return;
    var filter = commentsState.filter || 'block';
    var rawList;
    var labelHtml = '';
    /* V3.216 — when an anchor-id scope is active (set by a highlight
     * click), narrow whatever the active filter produced down to just
     * those comment IDs. Renders a clearable scope chip above the
     * results so the reader knows the view is anchor-scoped. */
    var anchorIdSet = null;
    if (commentsState.anchorFilterIds && commentsState.anchorFilterIds.length) {
      anchorIdSet = Object.create(null);
      commentsState.anchorFilterIds.forEach(function (id) { anchorIdSet[id] = true; });
    }
    if (filter === 'view') {
      var vis = _visibleBlockIds();
      rawList = commentsState.docs.filter(function (c) {
        return c.blockId && vis.set[c.blockId];
      });
      labelHtml = '<div class="pe-comments-scope-label">Paragraphs currently in view — ' +
                  vis.order.length + ' block' + (vis.order.length === 1 ? '' : 's') +
                  ', ' + rawList.length + ' comment' + (rawList.length === 1 ? '' : 's') + '</div>';
    } else {
      if (!commentsState.activeBlockId) {
        commentsListEl.innerHTML = '<div class="pe-comments-empty">Click a paragraph to see its comments — or switch the filter above to "Paragraphs in view".</div>';
        return;
      }
      rawList = commentsState.docs.filter(function (c) {
        return c.blockId === commentsState.activeBlockId;
      });
    }
    if (anchorIdSet) {
      rawList = rawList.filter(function (c) { return anchorIdSet[c.id]; });
      labelHtml = '<div class="pe-comments-scope-label pe-comments-anchor-scope">Anchored to highlighted text — ' +
                  rawList.length + ' comment' + (rawList.length === 1 ? '' : 's') +
                  ' <button type="button" class="pe-comments-scope-clear" title="Clear anchor filter">×</button></div>';
    }
    /* V3.204 — when in view mode, group comments by block so the
     * reader can see which paragraph each comment is on. */
    commentsListEl.innerHTML = labelHtml;
    /* V3.216 — wire the anchor-scope clear-`×` button. Hoisted above
     * the empty-list early-return so the affordance is still
     * functional when an anchor filter narrows the list to zero. */
    var scopeClearEarly = commentsListEl.querySelector('.pe-comments-scope-clear');
    if (scopeClearEarly) {
      scopeClearEarly.addEventListener('click', function () {
        commentsState.anchorFilterIds = null;
        renderCommentsList();
      });
    }
    if (!rawList.length) {
      commentsListEl.innerHTML += '<div class="pe-comments-empty">No comments here yet.</div>';
      /* The empty-state innerHTML += wiped our scope-clear listener;
       * re-attach. */
      var scopeClearAfterEmpty = commentsListEl.querySelector('.pe-comments-scope-clear');
      if (scopeClearAfterEmpty) {
        scopeClearAfterEmpty.addEventListener('click', function () {
          commentsState.anchorFilterIds = null;
          renderCommentsList();
        });
      }
      return;
    }
    var lastBlockId = null;
    rawList.forEach(function (c) {
      if (filter === 'view' && c.blockId !== lastBlockId) {
        lastBlockId = c.blockId;
        var sep = document.createElement('div');
        sep.className = 'pe-comments-block-header';
        sep.textContent = _blockShortLabel(c.blockId);
        sep.title = 'Jump to this block';
        sep.addEventListener('click', function () {
          var blk = document.querySelector('.pe-block[data-block-id="' + c.blockId + '"]');
          if (blk) {
            blk.scrollIntoView({ behavior: 'smooth', block: 'center' });
            blk.classList.add('pe-block-flash');
            setTimeout(function () { blk.classList.remove('pe-block-flash'); }, 1200);
          }
        });
        commentsListEl.appendChild(sep);
      }
      commentsListEl.appendChild(_renderCommentCard(c));
    });
    commentsListEl.scrollTop = commentsListEl.scrollHeight;
  }

  function _blockShortLabel(blockId) {
    if (!blockId || !state.paperMap) return 'Block ' + (blockId || '').slice(0, 6);
    var blk = _findBlockMapById && _findBlockMapById(blockId);
    if (!blk) return 'Block ' + blockId.slice(0, 6);
    var kind = blk.get('kind') || 'block';
    return kind.charAt(0).toUpperCase() + kind.slice(1) + ' • ' + blockId.slice(0, 6);
  }

  function _renderCommentCard(c) {
    var div = document.createElement('div');
    div.className = 'pe-comment' + (c.resolved ? ' pe-comment-resolved' : '');
    /* V3.218 — two-way hover link. Stamp the comment id on the card so
     * the delegated body-highlight hover handler can find it; on
     * mouseenter/leave glow every matching anchor span in the body. */
    div.dataset.commentId = c.id;
    var when = '';
    if (c.createdAt && c.createdAt.toDate) {
      when = c.createdAt.toDate().toISOString().slice(0, 16).replace('T', ' ');
    }
    /* V3.204 — render the text-range anchor snippet ahead of the
     * comment body when the comment was tied to a specific selection
     * via the floating "💬 Comment" button. */
    var snippetHtml = '';
    if (c.anchorText) {
      var t = String(c.anchorText);
      snippetHtml = '<div class="pe-comment-anchor-snippet" title="Highlighted text the commenter targeted">' +
                    '“' + escapeHtmlForCE(t.length > 200 ? t.slice(0, 200) + '…' : t) + '”' +
                    '</div>';
    }
    div.innerHTML =
      snippetHtml +
      '<div class="pe-comment-meta">' +
        '<span class="pe-comment-author">' + escapeHtmlForCE(c.authorName || c.authorUid || 'Unknown') + '</span>' +
        '<span class="pe-comment-when">' + escapeHtmlForCE(when) + '</span>' +
      '</div>' +
      '<div class="pe-comment-body">' + escapeHtmlForCE(c.body || '') + '</div>';
    var actions = document.createElement('div');
    actions.className = 'pe-comment-actions';
    var resolveBtn = document.createElement('button');
    resolveBtn.type = 'button';
    resolveBtn.className = 'pe-comment-action';
    resolveBtn.textContent = c.resolved ? 'Reopen' : 'Resolve';
    resolveBtn.addEventListener('click', function () {
      firebridge.db().collection('papers').doc(state.paperId)
        .collection('comments').doc(c.id)
        .update({ resolved: !c.resolved, modifiedAt: firebase.firestore.FieldValue.serverTimestamp() });
    });
    actions.appendChild(resolveBtn);
    var user = firebridge.getUser();
    if (user && (user.uid === c.authorUid || firebridge.isAdmin())) {
      var delBtn = document.createElement('button');
      delBtn.type = 'button';
      delBtn.className = 'pe-comment-action pe-comment-action-danger';
      delBtn.textContent = 'Delete';
      delBtn.addEventListener('click', function () {
        if (!window.confirm('Delete this comment?')) return;
        firebridge.db().collection('papers').doc(state.paperId)
          .collection('comments').doc(c.id).delete();
      });
      actions.appendChild(delBtn);
    }
    div.appendChild(actions);
    /* V3.218 — hover the card → glow every body highlight whose
     * `data-comment-ids` includes this id. V3.220 — removal is deferred
     * by `HOVER_DECAY_MS` so the glow doesn't blink as the cursor
     * passes briefly over a card or highlight; re-entering during the
     * decay cancels the pending removal. */
    div.addEventListener('mouseenter', function () {
      _setBodyHighlightHover(c.id, true);
    });
    div.addEventListener('mouseleave', function () {
      _setBodyHighlightHover(c.id, false);
    });
    return div;
  }

  /* V3.220 — hover-glow decay. Each commentId carries a per-id removal
   * timer; mouseenter cancels it and applies the glow class; mouseleave
   * schedules removal after `HOVER_DECAY_MS`. The same map is used for
   * both glow directions (body span and panel card) because the
   * commentId is the natural key on either side. */
  var HOVER_DECAY_MS = 300;
  var _hoverDecayTimers = Object.create(null);

  function _setBodyHighlightHover(commentId, on) {
    if (!commentId) return;
    if (_hoverDecayTimers[commentId]) {
      clearTimeout(_hoverDecayTimers[commentId]);
      delete _hoverDecayTimers[commentId];
    }
    if (on) {
      _paintHoverForCommentId(commentId, true);
    } else {
      _hoverDecayTimers[commentId] = setTimeout(function () {
        delete _hoverDecayTimers[commentId];
        _paintHoverForCommentId(commentId, false);
      }, HOVER_DECAY_MS);
    }
  }

  /* Apply (or remove) both the body-span and panel-card glow classes
   * for every node tied to `commentId`. */
  function _paintHoverForCommentId(commentId, on) {
    var spans = document.querySelectorAll('.pe-comment-highlight, .pe-comment-highlight-resolved');
    for (var i = 0; i < spans.length; i++) {
      var sp = spans[i];
      var ids = (sp.dataset.commentIds || '').split(';');
      if (ids.indexOf(commentId) < 0) continue;
      sp.classList.toggle('pe-comment-highlight-hover', !!on);
    }
    if (commentsListEl) {
      var card = commentsListEl.querySelector('.pe-comment[data-comment-id="' + commentId + '"]');
      if (card) card.classList.toggle('pe-comment-anchor-hover', !!on);
    }
  }

  /* V3.218 — reverse direction: hovering a body highlight glows every
   * matching card. V3.220 — the same per-commentId decay timer is
   * reused so on/off transitions are smoothed in both directions. */
  var _commentHoverLinkInstalled = false;
  function _installCommentHoverLink() {
    if (_commentHoverLinkInstalled) return;
    _commentHoverLinkInstalled = true;
    document.addEventListener('mouseover', function (e) {
      var hl = e.target && e.target.closest && e.target.closest('.pe-comment-highlight, .pe-comment-highlight-resolved');
      if (!hl) return;
      var ids = (hl.dataset.commentIds || '').split(';').filter(Boolean);
      for (var i = 0; i < ids.length; i++) _setBodyHighlightHover(ids[i], true);
    });
    document.addEventListener('mouseout', function (e) {
      var hl = e.target && e.target.closest && e.target.closest('.pe-comment-highlight, .pe-comment-highlight-resolved');
      if (!hl) return;
      if (e.relatedTarget && hl.contains(e.relatedTarget)) return;
      var ids = (hl.dataset.commentIds || '').split(';').filter(Boolean);
      for (var i = 0; i < ids.length; i++) _setBodyHighlightHover(ids[i], false);
    });
  }
  _installCommentHoverLink();

  async function submitComment() {
    if (!commentsState.activeBlockId) return;
    var body = (commentsInputEl.value || '').trim();
    if (!body) return;
    var user = firebridge.getUser();
    var profile = firebridge.getProfile();
    /* V3.204 — fold in the staged anchor if there is one. */
    var anchor = commentsState.pendingAnchor;
    var doc = {
      blockId: commentsState.activeBlockId,
      body: body,
      authorUid: user.uid,
      authorName: (profile && profile.name) || user.email || user.uid,
      createdAt: firebase.firestore.FieldValue.serverTimestamp(),
      modifiedAt: firebase.firestore.FieldValue.serverTimestamp(),
      resolved: false,
    };
    if (anchor && typeof anchor.anchorStart === 'number' && typeof anchor.anchorEnd === 'number') {
      doc.anchorStart = anchor.anchorStart;
      doc.anchorEnd = anchor.anchorEnd;
      doc.anchorText = String(anchor.anchorText || '').slice(0, 500);
    }
    try {
      await firebridge.db().collection('papers').doc(state.paperId)
        .collection('comments').add(doc);
      commentsInputEl.value = '';
      commentsState.pendingAnchor = null;
      _refreshAnchorPreview();
    } catch (err) {
      alert('Failed to post comment: ' + err.message);
    }
  }

  /* V3.204 — floating "💬 Comment" button that follows the user's
   * text selection inside paragraph contenteditables. When clicked,
   * stages (anchorStart, anchorEnd, anchorText) and opens the
   * comments panel for that block with the snippet pre-filled in
   * the anchor preview. */
  function _ensureCommentFloatingBtn() {
    if (commentsFloatingBtnEl) return commentsFloatingBtnEl;
    var btn = document.createElement('button');
    btn.type = 'button';
    btn.className = 'pe-comment-floating-btn';
    btn.innerHTML = '💬 Comment';
    btn.hidden = true;
    /* Use mousedown so the selection isn't cleared before our
     * handler reads it. */
    btn.addEventListener('mousedown', function (e) {
      e.preventDefault();
      _startCommentOnSelection();
    });
    document.body.appendChild(btn);
    commentsFloatingBtnEl = btn;
    return btn;
  }
  function _hideCommentFloatingBtn() {
    if (commentsFloatingBtnEl) commentsFloatingBtnEl.hidden = true;
  }
  function _installCommentSelectionWatcher() {
    document.addEventListener('selectionchange', function () {
      var sel = window.getSelection();
      if (!sel || sel.rangeCount === 0 || sel.isCollapsed) {
        _hideCommentFloatingBtn();
        return;
      }
      var range = sel.getRangeAt(0);
      var common = range.commonAncestorContainer;
      var paragraph = (common.nodeType === Node.TEXT_NODE ? common.parentElement : common);
      if (!paragraph) { _hideCommentFloatingBtn(); return; }
      paragraph = paragraph.closest && paragraph.closest('.pe-block-content[contenteditable]');
      if (!paragraph) { _hideCommentFloatingBtn(); return; }
      /* Skeleton bullets are also contenteditable but we don't want
       * to attach range comments to them — block comments are the
       * right granularity for bullets. */
      if (paragraph.classList.contains('pe-skeleton-bullet')) { _hideCommentFloatingBtn(); return; }
      /* Only on paragraph blocks (the body), not on figure captions /
       * table cells / etc. Use the contenteditable's V3.107 class. */
      var blockEl = paragraph.closest('.pe-block[data-block-id]');
      if (!blockEl) { _hideCommentFloatingBtn(); return; }
      /* Source-space offsets via the V3.191 chip-aware walker. */
      var startOff = _charOffsetFromContainer(paragraph, range.startContainer, range.startOffset);
      var endOff = _charOffsetFromContainer(paragraph, range.endContainer, range.endOffset);
      var staged = {
        paragraphEl: paragraph,
        blockId: blockEl.dataset.blockId,
        anchorStart: Math.min(startOff, endOff),
        anchorEnd: Math.max(startOff, endOff),
        anchorText: sel.toString(),
      };
      /* V3.211 — when the comments pane is already open, skip the
       * floating button entirely and auto-stage the anchor in the
       * pane's "new comment" section above the composer. The user
       * just highlights → keeps typing in the textbox → the comment
       * is linked. If the highlight is in a different paragraph than
       * the active block, switch the active block to match. */
      var paneOpen = commentsPaneEl && !commentsPaneEl.hidden;
      if (paneOpen) {
        _hideCommentFloatingBtn();
        if (commentsState.activeBlockId !== staged.blockId) {
          commentsState.activeBlockId = staged.blockId;
          if (commentsCtxEl) {
            commentsCtxEl.textContent = _blockShortLabel(staged.blockId);
          }
          /* In view-mode the list keeps rendering all in-view comments;
           * in block-mode rerun the filter so the list shows the new
           * active block's thread. */
          if (commentsState.filter === 'block') renderCommentsList();
          _refreshCommentsComposerState();
        }
        commentsState.pendingAnchor = {
          anchorStart: staged.anchorStart,
          anchorEnd: staged.anchorEnd,
          anchorText: staged.anchorText,
        };
        _refreshAnchorPreview();
        return;
      }
      /* Pane closed — surface the floating "💬 Comment" button as the
       * entry point. Clicking it opens the pane + stages the anchor. */
      var btn = _ensureCommentFloatingBtn();
      btn.hidden = false;
      var rect = range.getBoundingClientRect();
      var left = Math.max(8, Math.min(window.innerWidth - 130, rect.left));
      var top = rect.bottom + window.scrollY + 6;
      btn.style.left = left + window.scrollX + 'px';
      btn.style.top = top + 'px';
      btn._stagedAnchor = staged;
    });
  }

  /* V3.191 chip-aware offset reader without dependency on a live
   * Selection. Counts text-node `nodeValue` chars and atomic chip
   * `data-src.length` bytes; uses parent-relative positions when
   * the target container is an element. */
  function _charOffsetFromContainer(rootEl, container, offset) {
    var count = 0;
    var done = false;
    function visit(parent) {
      for (var i = 0; i < parent.childNodes.length; i++) {
        if (done) return;
        var node = parent.childNodes[i];
        if (node === container && container.nodeType === Node.TEXT_NODE) {
          count += offset;
          done = true;
          return;
        }
        if (parent === container && i === offset) {
          done = true;
          return;
        }
        if (node.nodeType === Node.TEXT_NODE) {
          count += node.length;
        } else if (node.nodeType === Node.ELEMENT_NODE) {
          if (node.dataset && node.dataset.src) {
            count += node.dataset.src.length;
          } else if (node.tagName === 'BR') {
            count += 1;
          } else {
            visit(node);
          }
        }
      }
      if (parent === container && offset === parent.childNodes.length) {
        done = true;
      }
    }
    visit(rootEl);
    return count;
  }

  function _startCommentOnSelection() {
    var btn = commentsFloatingBtnEl;
    if (!btn || !btn._stagedAnchor) return;
    var staged = btn._stagedAnchor;
    btn._stagedAnchor = null;
    _hideCommentFloatingBtn();
    var blockLabel = _blockShortLabel(staged.blockId);
    /* If the current filter is "view", switch back to "block" so the
     * pane is scoped to the comment's paragraph — gives a clear focused
     * context for the new comment. */
    if (commentsState.filter !== 'block') {
      commentsState.filter = 'block';
      if (commentsFilterEl) commentsFilterEl.value = 'block';
      try { localStorage.setItem('rm_paper_comments_filter', 'block'); } catch (e) {}
    }
    openCommentsForBlock(staged.blockId, blockLabel, {
      anchorStart: staged.anchorStart,
      anchorEnd: staged.anchorEnd,
      anchorText: staged.anchorText,
    });
  }

  /* ── V3.216 — visual highlight on commented text ─────────────────
   *
   * Each anchored comment carries (anchorStart, anchorEnd) source-space
   * character offsets on its paragraph block (V3.204 schema). When a
   * paragraph is rendered (blur-mode, full HTML via renderParagraphHtml)
   * we wrap the matching text-node segments with
   * `<span class="pe-comment-highlight">`. Resolved-only comments get
   * `.pe-comment-highlight-resolved` (thin underline) instead of the
   * amber fill; open beats resolved when a segment is covered by both.
   *
   * Source-text offsets are counted the same way as the V3.191/V3.204
   * chip-aware walker: text-node `nodeValue` chars, chip
   * `data-src.length` bytes, `<br>` as 1. Highlights don't split chips —
   * if an anchor exactly straddles a chip, the highlight resumes after.
   *
   * Re-applied on every render of the bound contenteditable via the
   * V3.216 `onRendered` hook in `bindYTextToContentEditable`, and on
   * every `paper-comment-counts-changed` fire so adds / resolves / deletes
   * propagate live without re-render. Skipped while the element is
   * focused (the user is editing the source text and chip-mode is on). */

  /* Build a flat list of non-overlapping (start, end, ids, hasOpen) ranges
   * by merging the anchored comments for this block. Inputs whose
   * (start, end) pair are not numbers, or whose blockId doesn't match,
   * are silently dropped. */
  function _mergedAnchorRangesForBlock(blockId) {
    var anchors = [];
    var docs = commentsState.docs || [];
    for (var i = 0; i < docs.length; i++) {
      var d = docs[i];
      if (d.blockId !== blockId) continue;
      if (typeof d.anchorStart !== 'number' || typeof d.anchorEnd !== 'number') continue;
      if (d.anchorEnd <= d.anchorStart) continue;
      anchors.push({ start: d.anchorStart, end: d.anchorEnd, id: d.id, resolved: !!d.resolved });
    }
    if (!anchors.length) return [];
    anchors.sort(function (a, b) { return a.start - b.start; });
    var merged = [];
    for (var j = 0; j < anchors.length; j++) {
      var a = anchors[j];
      var last = merged.length ? merged[merged.length - 1] : null;
      if (last && a.start < last.end) {
        last.end = Math.max(last.end, a.end);
        last.ids.push(a.id);
        if (!a.resolved) last.hasOpen = true;
      } else {
        merged.push({ start: a.start, end: a.end, ids: [a.id], hasOpen: !a.resolved });
      }
    }
    return merged;
  }

  /* Apply (or re-apply) anchor highlights to a rendered `.pe-block-content`
   * element. Idempotent: existing `.pe-comment-highlight` wrappers from a
   * previous run are unwrapped first, then the merged ranges are walked
   * once and matching text-node segments are wrapped. */
  function applyCommentHighlightsToBlock(rootEl, blockId) {
    if (!rootEl) return;
    /* Tear down previous highlights — unwrap in place so the underlying
     * text/chip structure is restored. Adjacent text nodes are not
     * coalesced (the offset walk doesn't care). */
    var existing = rootEl.querySelectorAll('.pe-comment-highlight, .pe-comment-highlight-resolved');
    for (var k = 0; k < existing.length; k++) {
      var span = existing[k];
      var parent = span.parentNode;
      if (!parent) continue;
      while (span.firstChild) parent.insertBefore(span.firstChild, span);
      parent.removeChild(span);
    }
    /* V3.218 — keep highlights painted while the paragraph is focused
     * too. Chip-mode DOM is text-nodes + atomic `data-src` chips; our
     * highlight wrappers carry no `data-src` so `serializeChipDom`
     * recurses through them and reads their text losslessly on every
     * `input` event. We only repaint on focus / blur / comments-changed
     * (not per-keystroke), so the caret is never disturbed mid-edit. */
    var ranges = _mergedAnchorRangesForBlock(blockId);
    if (!ranges.length) return;
    var rangeIdx = 0;
    var charPos = 0;
    function nextRange() {
      while (rangeIdx < ranges.length && ranges[rangeIdx].end <= charPos) rangeIdx++;
      return rangeIdx < ranges.length ? ranges[rangeIdx] : null;
    }
    function walk(parent) {
      var i = 0;
      while (i < parent.childNodes.length) {
        var node = parent.childNodes[i];
        if (node.nodeType === Node.TEXT_NODE) {
          var len = node.length;
          var nodeStart = charPos;
          var nodeEnd = charPos + len;
          var range = nextRange();
          if (range && range.start < nodeEnd && range.end > nodeStart) {
            var relStart = Math.max(range.start - nodeStart, 0);
            var relEnd = Math.min(range.end - nodeStart, len);
            var text = node.nodeValue || '';
            var before = text.slice(0, relStart);
            var middle = text.slice(relStart, relEnd);
            var after = text.slice(relEnd);
            var wrap = document.createElement('span');
            wrap.className = range.hasOpen ? 'pe-comment-highlight' : 'pe-comment-highlight-resolved';
            wrap.dataset.commentIds = range.ids.join(';');
            wrap.dataset.blockId = blockId;
            wrap.title = range.ids.length + ' comment' + (range.ids.length === 1 ? '' : 's');
            wrap.textContent = middle;
            var frag = document.createDocumentFragment();
            if (before) frag.appendChild(document.createTextNode(before));
            frag.appendChild(wrap);
            if (after) frag.appendChild(document.createTextNode(after));
            parent.replaceChild(frag, node);
            /* Advance past the inserted nodes; the next iteration
             * picks up after the trailing text (if any). */
            var added = (before ? 1 : 0) + 1 + (after ? 1 : 0);
            i += added;
            charPos = nodeStart + relEnd;
            /* If this range extends past the current text node, leave
             * rangeIdx alone — next text/chip will resume it. */
            continue;
          }
          charPos = nodeEnd;
          i++;
        } else if (node.nodeType === Node.ELEMENT_NODE) {
          if (node.dataset && node.dataset.src) {
            charPos += node.dataset.src.length;
            i++;
          } else if (node.tagName === 'BR') {
            charPos += 1;
            i++;
          } else {
            walk(node);
            i++;
          }
        } else {
          i++;
        }
      }
    }
    walk(rootEl);
  }

  /* V3.219 — highlights are no longer click-to-filter. The hover-link
   * (V3.218) is the only interaction; clicking a highlight should
   * behave like clicking the prose around it (place caret, select
   * text). Earlier V3.216 `_installHighlightClickHandler` removed. */

  /* Public surface for paper-blocks.js — chip badge + open thread +
   * V3.216 highlight refresh. */
  window.PaperComments = {
    countFor: function (blockId) { return commentsState.countsByBlock[blockId] || 0; },
    open: openCommentsForBlock,
    /* V3.216 — paper-blocks.js calls this from its onRendered hook + on
     * `paper-comment-counts-changed` so highlights stay in sync with
     * the live `commentsState`. */
    applyHighlights: applyCommentHighlightsToBlock,
  };

  /* ── Phase D: Named snapshots ── */

  async function openVersionsDialog() {
    var paperRef = firebridge.db().collection('papers').doc(state.paperId);
    var snaps;
    try {
      snaps = await paperRef.collection('snapshots').orderBy('takenAt', 'desc').get();
    } catch (err) {
      alert('Failed to list snapshots: ' + err.message);
      return;
    }
    var rows = snaps.docs.map(function (d) {
      var data = d.data();
      var when = '';
      if (data.takenAt && data.takenAt.toDate) {
        when = data.takenAt.toDate().toISOString().slice(0, 16).replace('T', ' ');
      }
      return '  ' + (data.name || '(unnamed)') + '  [' + d.id.slice(0, 6) + ']  ' + when +
             (data.message ? '  — ' + data.message : '');
    });
    var msg =
      'Versions of "' + state.meta.title + '"\n\n' +
      (rows.length ? rows.join('\n') : '  (none yet)') + '\n\n' +
      'Choose:\n' +
      '  1. Save current version\n' +
      '  2. Restore a version (replaces current state — destructive)\n' +
      '  Cancel to dismiss\n\n' +
      'Type 1 or 2:';
    var pick = window.prompt(msg, '1');
    if (pick === '1') return promptSaveSnapshot();
    if (pick === '2') return promptRestoreSnapshot(snaps.docs);
  }

  async function promptSaveSnapshot() {
    var name = window.prompt('Version name (e.g. "v1 submitted"):', '');
    if (!name) return;
    var message = window.prompt('Optional note (or leave blank):', '');
    try {
      setSaveStatus('Saving snapshot…', 'saving');
      var Y = state.Y;
      var bytes = Y.encodeStateAsUpdate(state.conn.yDoc);
      var b64 = window.PaperYjs.bytesToB64(bytes);
      await firebridge.db().collection('papers').doc(state.paperId)
        .collection('snapshots').add({
          name: name,
          message: message || '',
          stateBase64: b64,
          takenBy: firebridge.getUser().uid,
          takenAt: firebase.firestore.FieldValue.serverTimestamp(),
          bytes: bytes.length,
        });
      setSaveStatus('Snapshot saved', 'saved');
    } catch (err) {
      setSaveStatus('Snapshot failed', 'err');
      alert('Save failed: ' + err.message);
    }
  }

  async function promptRestoreSnapshot(docs) {
    if (!docs.length) { alert('No snapshots to restore.'); return; }
    var lines = docs.map(function (d, i) {
      var data = d.data();
      return (i + 1) + '. ' + (data.name || '(unnamed)') + '  [' + d.id.slice(0, 6) + ']' +
             (data.message ? '  — ' + data.message : '');
    });
    var pick = window.prompt(
      'Restore which version?\n\n' + lines.join('\n') +
      '\n\nType the number (1, 2, …) or Cancel:',
      '1'
    );
    if (!pick) return;
    var idx = parseInt(pick, 10) - 1;
    if (isNaN(idx) || idx < 0 || idx >= docs.length) {
      alert('Invalid selection.');
      return;
    }
    var chosen = docs[idx];
    if (!window.confirm(
      'REPLACE current state with snapshot "' + (chosen.data().name || chosen.id) + '"?\n\n' +
      'This deletes every yjs_update doc and resets the rolling snapshot. ' +
      'Cannot be undone (but you CAN save another snapshot of current state ' +
      'first if you cancel here and do that).'
    )) return;
    try {
      setSaveStatus('Restoring…', 'saving');
      var data = chosen.data();
      var paperRef = firebridge.db().collection('papers').doc(state.paperId);
      var updatesSnap = await paperRef.collection('yjs_updates').get();
      var pending = updatesSnap.docs.slice();
      while (pending.length) {
        var chunk = pending.splice(0, 400);
        var batch = firebridge.db().batch();
        chunk.forEach(function (d) { batch.delete(d.ref); });
        await batch.commit();
      }
      await paperRef.collection('yjs_snapshot').doc('state').set({
        stateBase64: data.stateBase64,
        seq: '',
        savedAt: firebase.firestore.FieldValue.serverTimestamp(),
        savedBy: firebridge.getUser().uid,
        fromSnapshot: chosen.id,
      });
      try { state.conn.disconnect(); } catch (e) {}
      window.location.reload();
    } catch (err) {
      setSaveStatus('Restore failed', 'err');
      alert('Restore failed: ' + err.message);
    }
  }

  /* ── V3.231 Paper Export Workspace ── */
  function openExportWorkspace() {
    /* Navigate to the dedicated workspace page; the orchestrator there
     * picks up ?paper=<id> and loads the same Yjs doc read-only for
     * bundle building. */
    window.location.href = '/rm/pages/paper-export.html?paper=' +
                           encodeURIComponent(state.paperId);
  }

  /* ── LaTeX export dialog (Phase F1 — superseded by V3.231 workspace) ──
   * Kept reachable from the JS console for admin local-Python in_place
   * exports. Not wired to any button. */
  async function openExportDialog() {
    if (!state.meta.repo_path) {
      alert('This paper has no repo_path set in data/projects/papers.json. ' +
            'Add one (e.g. "../MEBP-Paper") and reload before exporting.');
      return;
    }
    var templateId = state.meta.template_id || 'mebp-journal';
    var defaultMode = 'preview'; // safer default; in-place overwrites existing files
    var msg =
      'Export "' + state.meta.title + '" to LaTeX.\n\n' +
      'Template: ' + templateId + '\n' +
      'Repo: ' + state.meta.repo_path + '\n\n' +
      'Output mode:\n' +
      '  preview  — write under <repo>/_generated/ for diffing first\n' +
      '  in_place — write directly under <repo>/ (overwrites existing!)\n\n' +
      'Type "preview" or "in_place" (or Cancel to abort):';
    var mode = window.prompt(msg, defaultMode);
    if (!mode) return;
    mode = mode.trim().toLowerCase();
    if (mode !== 'preview' && mode !== 'in_place') {
      alert('Output mode must be "preview" or "in_place".');
      return;
    }
    if (mode === 'in_place') {
      if (!window.confirm('In-place export will OVERWRITE existing .tex/.bib in ' +
                          state.meta.repo_path + '. Continue?')) return;
    }
    try {
      setSaveStatus('Exporting LaTeX…', 'saving');
      // Build a citation index that includes full items.json rows so the bib
      // gets all fields (authors, doi, etc.). state.citationByKey only has
      // the chip projection.
      var fullByKey = await loadFullCitationItems();
      var result = await window.PaperExportTex.runExport({
        paperId: state.paperId,
        repoPath: state.meta.repo_path,
        templateId: templateId,
        outputMode: mode,
        yDoc: state.conn.yDoc,
        leadAuthor: state.meta.lead_author || '',
        titleOverride: state.titleY ? state.titleY.toString() : '',
        fullItemsByKey: fullByKey,
      });
      setSaveStatus('Exported', 'saved');
      var lines = result.files_written.map(function (f) {
        return '  ' + f.relpath + '  (' + f.bytes + ' bytes)';
      });
      alert('Wrote ' + result.files_written.length + ' files to ' + result.target_dir + ':\n\n' +
            lines.join('\n') + '\n\n' +
            'Citations resolved: ' + (result.citationKeys || []).length);
    } catch (err) {
      setSaveStatus('Export failed', 'err');
      alert('Export failed: ' + err.message);
    }
  }

  /* Build a full citation lookup from items.json (including all bib fields)
   * for the export's BibTeX builder. Cached across exports in this session. */
  async function loadFullCitationItems() {
    if (state._fullCitationByKey) return state._fullCitationByKey;
    try {
      var data = await api.load('items.json');
      var byKey = {};
      (data && data.items || []).forEach(function (it) {
        if (it.type !== 'paper') return;
        var lib = it.meta && it.meta.library;
        if (!lib || !lib.is_library_entry || !lib.citation_key) return;
        byKey[lib.citation_key] = it;
      });
      state._fullCitationByKey = byKey;
      return byKey;
    } catch (e) {
      console.warn('[paper-editor] full items lookup failed:', e.message);
      return {};
    }
  }

  /* Wipe this paper's Yjs subcollections so the next page load re-runs
   * migration from data/paper-imports/<id>.json. Useful when the editor was
   * opened before the import file existed and template-seeded the Yjs doc. */
  async function resetAndReimport() {
    var confirmed = window.confirm(
      'This will DELETE the current Yjs state for "' + state.paperId + '" ' +
      '(snapshot + every update) and re-import from data/paper-imports/' +
      state.paperId + '.json on reload.\n\nThis cannot be undone. Continue?'
    );
    if (!confirmed) return;
    resetBtnEl.disabled = true;
    resetBtnEl.textContent = 'Resetting…';
    try {
      var db = firebridge.db();
      var paperRef = db.collection('papers').doc(state.paperId);
      // 1. Delete every doc in yjs_updates (in chunks to dodge batch limits).
      var updatesSnap = await paperRef.collection('yjs_updates').get();
      var docs = updatesSnap.docs.slice();
      while (docs.length) {
        var chunk = docs.splice(0, 400);
        var batch = db.batch();
        chunk.forEach(function (d) { batch.delete(d.ref); });
        await batch.commit();
      }
      // 2. Delete the snapshot doc.
      await paperRef.collection('yjs_snapshot').doc('state').delete().catch(function () {});
      // 3. Clear our own presence (others will time out via stale check).
      var uid = firebridge.getUser().uid;
      await paperRef.collection('presence').doc(uid).delete().catch(function () {});
      // 4. Disconnect so beforeunload doesn't re-write a flushed update on top.
      try { state.conn.disconnect(); } catch (e) {}
      // 5. Hard reload — re-runs the migration path against the import file.
      window.location.reload();
    } catch (err) {
      alert('Reset failed: ' + err.message);
      resetBtnEl.disabled = false;
      resetBtnEl.textContent = 'Reset & re-import';
    }
  }

  /* V3.223 — Coauthors button now opens a context-menu popover anchored
   * under the button instead of the legacy `window.prompt`-by-email
   * flow. The popover lists every visible lab member with a per-row
   * role select:
   *   None        — not on the paper
   *   Coauthor    — in `coauthor_uids[]`
   *   First       — `lead_author_uid` (primary first author)
   *   Co-first    — `co_first_author_uid` (optional second first author,
   *                 also added to `coauthor_uids[]` for read access)
   *
   * Only one user can hold each of First and Co-first. Picking First on
   * a new user demotes the prior first author to Coauthor; same rule
   * for Co-first. Changes save to `data/projects/papers.json`
   * immediately (no Save button — picker is its own UI commit).
   *
   * `syncPaperMembers` is still called after every change so PMR's
   * `member_uids[]` array-contains query stays in sync.
   */
  var _coauthorPopEl = null;
  function _closeCoauthorPop() {
    if (!_coauthorPopEl) return;
    _coauthorPopEl.remove();
    _coauthorPopEl = null;
    document.removeEventListener('mousedown', _coauthorPopOutside, true);
    document.removeEventListener('keydown', _coauthorPopEsc, true);
  }
  function _coauthorPopOutside(ev) {
    if (!_coauthorPopEl) return;
    if (_coauthorPopEl.contains(ev.target)) return;
    if (inviteBtnEl && inviteBtnEl.contains(ev.target)) return;
    _closeCoauthorPop();
  }
  function _coauthorPopEsc(ev) {
    if (ev.key === 'Escape') _closeCoauthorPop();
  }

  async function openInviteDialog() {
    // Toggle: clicking the button again with the popover open closes it.
    if (_coauthorPopEl) { _closeCoauthorPop(); return; }
    // Load lab users (canonical uid + name source).
    var labUsers = [];
    try {
      var d = await api.load('lab/users.json');
      labUsers = (d && d.users) || [];
    } catch (err) {
      alert('Failed to load lab members: ' + err.message);
      return;
    }
    var visible = typeof LAB_USERS !== 'undefined' && LAB_USERS.isVisible
      ? labUsers.filter(function (u) { return LAB_USERS.isVisible(u); })
      : labUsers;
    visible.sort(function (a, b) { return (a.name || '').localeCompare(b.name || ''); });

    /* V3.224 — match the citation/references popover style
     * (`pe-cite-popover` + `pe-cite-pop-*` rows) so the coauthor picker
     * feels like the rest of the editor. Same `position: fixed` +
     * anchor-rect positioning logic as `openCitationPopover`. */
    var pop = document.createElement('div');
    pop.className = 'pe-cite-popover pe-coauthor-popover';
    pop.innerHTML =
      '<div class="pe-cite-pop-title">Paper authors</div>' +
      '<div class="pe-coauthor-pop-hint">Pick one or two First authors. Everyone else can be a Coauthor.</div>' +
      '<div class="pe-cite-pop-list pe-coauthor-pop-list"></div>';
    document.body.appendChild(pop);
    _coauthorPopEl = pop;

    // Position under the Coauthors button — same math as openCitationPopover.
    var rect = inviteBtnEl.getBoundingClientRect();
    pop.style.left = Math.max(10, Math.min(window.innerWidth - 470, rect.left)) + 'px';
    pop.style.top  = Math.max(10, rect.bottom + 6) + 'px';

    var listEl = pop.querySelector('.pe-coauthor-pop-list');
    function repaint() {
      listEl.innerHTML = '';
      visible.forEach(function (u) {
        listEl.appendChild(_renderCoauthorRow(u));
      });
    }
    repaint();

    function _renderCoauthorRow(u) {
      var meta = state.meta || {};
      var uid = u.id;
      var isLead = meta.lead_author_uid === uid;
      var isCoFirst = meta.co_first_author_uid === uid;
      var isCoauthor = !isLead && !isCoFirst && (meta.coauthor_uids || []).indexOf(uid) >= 0;
      var current = isLead ? 'first' : isCoFirst ? 'cofirst' : isCoauthor ? 'coauthor' : 'none';

      // Build a `pe-cite-pop-row` so the picker matches the references
      // popover visually (hover tint, font weights, spacing, borders).
      var row = document.createElement('div');
      row.className = 'pe-cite-pop-row pe-coauthor-row';
      row.dataset.role = current;

      var av = document.createElement('span');
      av.className = 'pe-coauthor-avatar';
      av.style.background = (window.PaperYjs && window.PaperYjs.colorForUid)
        ? window.PaperYjs.colorForUid(uid)
        : '#9ca3af';
      av.textContent = (u.name || '?').slice(0, 1).toUpperCase();
      row.appendChild(av);

      var body = document.createElement('div');
      body.className = 'pe-cite-pop-row-body';
      var nameEl = document.createElement('div');
      nameEl.className = 'pe-cite-pop-key';
      nameEl.textContent = u.name || u.email || uid;
      body.appendChild(nameEl);
      if (u.email) {
        var emailEl = document.createElement('div');
        emailEl.className = 'pe-cite-pop-meta';
        emailEl.textContent = u.email;
        body.appendChild(emailEl);
      }
      row.appendChild(body);

      var sel = document.createElement('select');
      sel.className = 'pe-coauthor-role';
      [
        { v: 'none',     l: 'Not on paper' },
        { v: 'coauthor', l: 'Coauthor' },
        { v: 'first',    l: 'First author' },
        { v: 'cofirst',  l: 'Co-first author' },
      ].forEach(function (opt) {
        var o = document.createElement('option');
        o.value = opt.v;
        o.textContent = opt.l;
        sel.appendChild(o);
      });
      sel.value = current;
      sel.addEventListener('change', function () {
        _onCoauthorRoleChange(u, sel.value).then(function () {
          repaint();
        });
      });
      /* Click on the select shouldn't bubble through the row's
       * pe-cite-pop-row hover-only styling and trigger anything else. */
      sel.addEventListener('mousedown', function (e) { e.stopPropagation(); });
      row.appendChild(sel);

      return row;
    }

    document.addEventListener('mousedown', _coauthorPopOutside, true);
    document.addEventListener('keydown', _coauthorPopEsc, true);
  }

  async function _onCoauthorRoleChange(user, role) {
    var uid = user.id;
    try {
      var data = await api.load('projects/papers.json');
      var rows = (data && data.papers) || [];
      var row = rows.find(function (p) { return p.id === state.paperId; });
      if (!row) throw new Error('Paper row missing');

      row.coauthor_uids = row.coauthor_uids || [];
      row.coauthor_emails = row.coauthor_emails || [];

      // Strip this user from every prior position first.
      if (row.lead_author_uid === uid) row.lead_author_uid = '';
      if (row.co_first_author_uid === uid) row.co_first_author_uid = '';
      row.coauthor_uids = row.coauthor_uids.filter(function (x) { return x !== uid; });
      if (user.email) {
        row.coauthor_emails = row.coauthor_emails.filter(function (e) {
          return e.toLowerCase() !== String(user.email).toLowerCase();
        });
      }

      function _demoteToCoauthor(existingUid) {
        if (!existingUid || existingUid === uid) return;
        if (row.coauthor_uids.indexOf(existingUid) < 0) row.coauthor_uids.push(existingUid);
      }

      if (role === 'first') {
        _demoteToCoauthor(row.lead_author_uid);
        row.lead_author_uid = uid;
      } else if (role === 'cofirst') {
        _demoteToCoauthor(row.co_first_author_uid);
        row.co_first_author_uid = uid;
        // Co-first author is still in coauthor_uids so existing Firestore
        // rule (`coauthor_uids` array-contains) grants edit access.
        if (row.coauthor_uids.indexOf(uid) < 0) row.coauthor_uids.push(uid);
        if (user.email && row.coauthor_emails.indexOf(user.email) < 0) {
          row.coauthor_emails.push(user.email);
        }
      } else if (role === 'coauthor') {
        if (row.coauthor_uids.indexOf(uid) < 0) row.coauthor_uids.push(uid);
        if (user.email && row.coauthor_emails.indexOf(user.email) < 0) {
          row.coauthor_emails.push(user.email);
        }
      }
      // role === 'none' → already removed above.

      syncPaperMembers(row);
      await api.save('projects/papers.json', { papers: rows });
      state.meta = row;
    } catch (err) {
      alert('Failed to update author role: ' + err.message);
    }
  }

  /* ── Citation index ────────────────────────────────────────────────────
   *
   * One-shot fetch of `data/items.json` filtered to paper-library entries.
   * Used by:
   *   - renderCitationChip — tooltip/short label for [@key] tokens
   *   - openCitationPopover — search-as-you-type Cmd+K dialog
   *
   * This refreshes only on full editor reload. If the user adds papers to
   * the library while this tab is open, they'll appear after refresh. Phase
   * F's bib export reads items.json fresh, so a missing key here doesn't
   * affect output correctness — only the chip preview.
   */
  /* V3.122 — invalidate the cached citation index so the next call to
   * loadCitationIndex re-reads items.json. Used by the References tab
   * after writing meta.library.linked_drafts. */
  function invalidateCitationIndex() {
    state.citationByKey = null;
    state.citationList = null;
  }

  function loadCitationIndex() {
    if (state.citationByKey) return Promise.resolve(state.citationByKey);
    return api.load('items.json').then(function (data) {
      var byKey = {};
      var list = [];
      (data && data.items || []).forEach(function (it) {
        if (it.type !== 'paper') return;
        var lib = it.meta && it.meta.library;
        if (!lib || !lib.is_library_entry) return;
        var key = lib.citation_key;
        if (!key) return;
        var first = (lib.authors || [])[0];
        var firstAuthor = first ? (first.family || first.given || '') : '';
        var year = lib.year || '';
        var entry = {
          key: key,
          firstAuthor: firstAuthor,
          year: year,
          shortLabel: firstAuthor && year ? firstAuthor + ' ' + year : key,
          title: it.title || lib.title || '',
          journal: lib.journal || '',
          itemId: it.id,
          /* V3.122 — linkedDrafts mirrors meta.library.linked_drafts so the
           * References tab can filter "linked but not cited" without a
           * second items.json fetch. The array is a slice() copy so
           * panel-side mutations don't leak back into the cached entry. */
          linkedDrafts: Array.isArray(lib.linked_drafts) ? lib.linked_drafts.slice() : [],
          searchHaystack: (key + ' ' + firstAuthor + ' ' + year + ' ' +
                          (it.title || '') + ' ' + (lib.journal || '')).toLowerCase(),
        };
        byKey[key] = entry;
        list.push(entry);
      });
      list.sort(function (a, b) { return a.key.localeCompare(b.key); });
      state.citationByKey = byKey;
      state.citationList = list;
      // Re-render any already-displayed paragraphs so chips pick up tooltips.
      window.dispatchEvent(new CustomEvent('paper-citations-loaded'));
      return byKey;
    }).catch(function (err) {
      console.warn('[paper-editor] failed to load items.json for citation index:', err.message);
      state.citationByKey = {};
      state.citationList = [];
    });
  }

  /* ── Citation popover ──────────────────────────────────────────────────
   *
   * Floating search/list dialog that lets the user pick a citation key from
   * the lab paper library (data/items.json) and insert it as a Pandoc
   * `[@key]` token at the active contenteditable's caret.
   *
   * Triggered by:
   *   - Cmd+K / Ctrl+K when focused in any paragraph contenteditable
   *   - The "Cite" toolbar button (added to renderParagraph in paper-blocks.js)
   *
   * Uses the lastFocused paragraph's element + caret position. The token is
   * inserted via the same diff-and-update path local typing uses, so the
   * Y.Text observers fire normally and remote clients see the insert.
   */
  var lastFocusedEditable = null;        // Element ref — used by Cmd+K
  var lastFocusedCaret = 0;              // Char offset within that element
  var citationPopoverEl = null;          // Lazily-built DOM
  /* V3.157 — popover state extended for multi-pick + edit mode.
   *   onPick(entry)        legacy single-pick callback (kept for compat).
   *   onPickKeys(keys[])   commit-multi callback; receives the array of
   *                        selected keys; called when user clicks
   *                        "Insert N" or hits Cmd+Enter.
   *   onRemove()           edit-mode-only; called when user clicks
   *                        "Remove citation" to delete the entire token.
   *   selectedKeys         Set<string> currently checked rows.
   *   editing              true when the popover is editing an existing
   *                        chip (changes title + button labels).
   *   anchorEl             positioning anchor (any element with a
   *                        bounding rect). */
  var citationPopoverState = {
    onPick: null,
    onPickKeys: null,
    onRemove: null,
    anchorEl: null,
    selectedKeys: null,    // Set
    editing: false,
    /* V3.192 — claim context wired in by openCitationPopover when the
     * caller supplied a paragraphEl. The popover renders the loaded
     * tree as a "Claims for this paragraph" section above the search
     * results. expandedClaimEvidence tracks which (claimId|citationKey)
     * cells are expanded to show their highlight text. */
    paragraphEl: null,
    claimContext: null,     // null | [{ claim, papersByKey }]
    claimContextLoading: false,
    expandedClaimEvidence: null,  // Set<"claimId|citationKey">
  };

  function rememberFocus(el) {
    lastFocusedEditable = el;
    lastFocusedCaret = readCaretCharOffset(el) || 0;
    /* V3.197 — mirror the focused paragraph's skeleton in the sidebar. */
    _updateSidebarParagraphMirror(el);
  }

  /* V3.197 — sidebar tab switch + paragraph-skeleton mirror.
   *
   * The sidebar has two tabs ("Outline" and "Paragraph"). The Outline
   * tab is the legacy section list. The Paragraph tab is a read-only
   * mirror of the skeleton_items Y.Array on whichever paragraph block
   * the user last had focus in. Auto-updates on rememberFocus + via
   * a per-block observeDeep so live skeleton edits propagate to the
   * mirror instantly.
   *
   * Clicking a mirror bullet scrolls the doc to that bullet and
   * focuses the bullet contenteditable inside it.
   */
  var _sidebarMirror = {
    blockId: null,
    skItems: null,        // Y.Array<Y.Map>
    observer: null,       // observeDeep callback for skItems
  };
  function _setSidebarTab(name) {
    var tabs = document.querySelectorAll('.pe-sidebar-tab');
    var panels = document.querySelectorAll('.pe-sidebar-tab-content');
    tabs.forEach(function (t) {
      var on = t.dataset.sidebarTab === name;
      t.classList.toggle('active', on);
      t.setAttribute('aria-selected', on ? 'true' : 'false');
    });
    panels.forEach(function (p) {
      p.hidden = p.dataset.sidebarTab !== name;
    });
    try { localStorage.setItem('rm_paper_sidebar_tab', name); } catch (e) {}
  }
  (function _wireSidebarTabs() {
    var tabs = document.querySelectorAll('.pe-sidebar-tab');
    tabs.forEach(function (t) {
      t.addEventListener('click', function () { _setSidebarTab(t.dataset.sidebarTab); });
    });
    /* Restore last-selected tab. */
    try {
      var saved = localStorage.getItem('rm_paper_sidebar_tab');
      if (saved === 'paragraph') _setSidebarTab('paragraph');
    } catch (e) {}
  })();

  function _findBlockMapById(blockId) {
    if (!blockId || !state.paperMap) return null;
    var sections = state.paperMap.get('sections');
    if (!sections || typeof sections.forEach !== 'function') return null;
    var hit = null;
    sections.forEach(function (secMap) {
      if (hit) return;
      var children = secMap && secMap.get && secMap.get('children');
      if (!children || typeof children.forEach !== 'function') return;
      children.forEach(function (blk) {
        if (hit) return;
        if (blk && typeof blk.get === 'function' && blk.get('id') === blockId) {
          hit = blk;
        }
      });
    });
    return hit;
  }

  function _updateSidebarParagraphMirror(el) {
    if (!paragraphSkelEl) return;
    var blockId = null;
    if (el && el.closest) {
      var blk = el.closest('.pe-block[data-block-id]');
      if (blk) blockId = blk.dataset.blockId;
    }
    if (blockId === _sidebarMirror.blockId) return;
    /* Tear down previous observer. */
    if (_sidebarMirror.observer && _sidebarMirror.skItems) {
      try { _sidebarMirror.skItems.unobserveDeep(_sidebarMirror.observer); } catch (e) {}
    }
    _sidebarMirror.blockId = blockId;
    _sidebarMirror.skItems = null;
    _sidebarMirror.observer = null;
    if (!blockId) {
      _renderSidebarParagraphSkeleton(null, null);
      return;
    }
    var blockMap = _findBlockMapById(blockId);
    var skItems = blockMap && blockMap.get && blockMap.get('skeleton_items');
    if (!skItems) {
      _renderSidebarParagraphSkeleton(blockMap, null);
      return;
    }
    _sidebarMirror.skItems = skItems;
    _sidebarMirror.observer = function () {
      _renderSidebarParagraphSkeleton(blockMap, skItems);
    };
    try { skItems.observeDeep(_sidebarMirror.observer); } catch (e) {}
    _renderSidebarParagraphSkeleton(blockMap, skItems);
  }

  function _renderSidebarParagraphSkeleton(blockMap, skItems) {
    paragraphSkelEl.innerHTML = '';
    if (!blockMap) {
      var empty = document.createElement('div');
      empty.className = 'pe-sidebar-empty';
      empty.textContent = 'Click into a paragraph to see its skeleton.';
      paragraphSkelEl.appendChild(empty);
      return;
    }
    /* Block header — kind + first-bullet preview so the user can see
     * which paragraph they're mirroring. */
    var header = document.createElement('div');
    header.className = 'pe-sidebar-skel-header';
    var kind = blockMap.get('kind') || 'paragraph';
    header.textContent = kind.charAt(0).toUpperCase() + kind.slice(1);
    paragraphSkelEl.appendChild(header);

    if (!skItems || !skItems.length) {
      var emptyB = document.createElement('div');
      emptyB.className = 'pe-sidebar-empty';
      emptyB.textContent = (kind === 'paragraph')
        ? 'No skeleton bullets yet. Tab inside the paragraph to add one.'
        : 'This block has no skeleton.';
      paragraphSkelEl.appendChild(emptyB);
      return;
    }
    var ul = document.createElement('ul');
    ul.className = 'pe-sidebar-skel-list';
    skItems.forEach(function (item) {
      if (!item || typeof item.get !== 'function') return;
      var depth = item.get('depth') || 0;
      var text = '';
      try {
        var t = item.get('text');
        text = (t && t.toString) ? t.toString() : String(t || '');
      } catch (e) {}
      var claimId = item.get('claim_id');
      var itemId = null;
      try { itemId = item.get('id') || null; } catch (e2) {}
      var li = document.createElement('li');
      li.className = 'pe-sidebar-skel-item';
      li.style.paddingLeft = (8 + depth * 14) + 'px';
      if (claimId) li.classList.add('pe-sidebar-skel-item-claim');
      if (claimId) {
        var flag = document.createElement('span');
        flag.className = 'pe-sidebar-skel-flag';
        flag.textContent = '⚑';
        flag.title = 'Flagged as claim';
        li.appendChild(flag);
      }
      var txt = document.createElement('span');
      txt.className = 'pe-sidebar-skel-text';
      if (text) {
        txt.textContent = text;
      } else {
        txt.textContent = '(empty bullet)';
        txt.classList.add('pe-sidebar-skel-empty-bullet');
      }
      li.appendChild(txt);
      /* Click → scroll to the bullet in the doc + focus its contenteditable. */
      li.addEventListener('click', function () {
        if (!itemId) return;
        var bullet = document.querySelector(
          '.pe-block[data-block-id="' + blockMap.get('id') + '"] [data-item-id="' + itemId + '"] .pe-skeleton-bullet'
        );
        if (!bullet) return;
        bullet.scrollIntoView({ behavior: 'smooth', block: 'center' });
        bullet.focus();
      });
      ul.appendChild(li);
    });
    paragraphSkelEl.appendChild(ul);
  }

  function ensureCitationPopover() {
    if (citationPopoverEl) return citationPopoverEl;
    var pop = document.createElement('div');
    pop.className = 'pe-cite-popover';
    pop.hidden = true;
    pop.innerHTML =
      '<div class="pe-cite-pop-title">Insert citation</div>' +
      '<input type="text" class="pe-cite-pop-search" placeholder="Search by key, author, year, or title…" autocomplete="off">' +
      '<div class="pe-cite-pop-selected-bar" hidden></div>' +
      '<div class="pe-cite-pop-claims" hidden></div>' +
      '<div class="pe-cite-pop-list" role="listbox"></div>' +
      '<div class="pe-cite-pop-foot">' +
        '<button type="button" class="pe-cite-pop-remove" hidden>Remove citation</button>' +
        '<span class="pe-cite-pop-foot-spacer"></span>' +
        '<button type="button" class="pe-cite-pop-cancel">Cancel</button>' +
        '<button type="button" class="pe-cite-pop-commit" disabled>Insert</button>' +
      '</div>' +
      '<div class="pe-cite-pop-hint">' +
        '<kbd>↑</kbd>/<kbd>↓</kbd> navigate · <kbd>Space</kbd> toggle · <kbd>Cmd/Ctrl+Enter</kbd> insert · <kbd>Esc</kbd> close' +
      '</div>';
    document.body.appendChild(pop);
    citationPopoverEl = pop;
    var titleEl = pop.querySelector('.pe-cite-pop-title');
    var input = pop.querySelector('.pe-cite-pop-search');
    var listEl = pop.querySelector('.pe-cite-pop-list');
    var selectedBar = pop.querySelector('.pe-cite-pop-selected-bar');
    var claimsBar = pop.querySelector('.pe-cite-pop-claims');
    var commitBtn = pop.querySelector('.pe-cite-pop-commit');
    var removeBtn = pop.querySelector('.pe-cite-pop-remove');
    var cancelBtn = pop.querySelector('.pe-cite-pop-cancel');
    var activeIdx = 0;
    var current = [];

    function refresh() {
      var q = input.value.trim().toLowerCase();
      var src = state.citationList || [];
      var matched = q
        ? src.filter(function (e) { return e.searchHaystack.indexOf(q) >= 0; })
        : src.slice(0, 20);
      /* V3.157 — surface already-selected entries at the top so the
       * user sees what's checked even when they're searching for more.
       * Dedup by key. */
      var sel = citationPopoverState.selectedKeys;
      if (sel && sel.size) {
        var selectedEntries = [];
        sel.forEach(function (key) {
          var e = state.citationByKey ? state.citationByKey[key] : null;
          if (e) {
            selectedEntries.push(e);
          } else {
            /* Unknown-key fallback: synthesize a minimal row. */
            selectedEntries.push({ key: key, title: '', firstAuthor: '', year: '', searchHaystack: key });
          }
        });
        var seen = {};
        var ordered = [];
        selectedEntries.concat(matched).forEach(function (e) {
          if (e && e.key && !seen[e.key]) {
            seen[e.key] = true;
            ordered.push(e);
          }
        });
        current = ordered.slice(0, 80);
      } else {
        current = matched.slice(0, 50);
      }
      activeIdx = current.length ? 0 : -1;
      renderList();
      _refreshSelectedBar();
      _refreshCommitBtn();
      _refreshClaimsBar();
    }
    function renderList() {
      listEl.innerHTML = '';
      if (!current.length) {
        listEl.innerHTML = '<div class="pe-cite-pop-empty">No matching library entries. Add one in /pages/library.html first.</div>';
        return;
      }
      var sel = citationPopoverState.selectedKeys;
      current.forEach(function (e, i) {
        var row = document.createElement('button');
        row.type = 'button';
        row.className = 'pe-cite-pop-row';
        if (i === activeIdx) row.classList.add('active');
        var checked = sel && sel.has(e.key);
        if (checked) row.classList.add('checked');
        row.innerHTML =
          '<span class="pe-cite-pop-row-check" aria-hidden="true">' +
            (checked ? '✓' : '') +
          '</span>' +
          '<div class="pe-cite-pop-row-body">' +
            '<div class="pe-cite-pop-key">' + escapeHtmlForCE(e.key) + '</div>' +
            '<div class="pe-cite-pop-meta">' +
              escapeHtmlForCE(e.firstAuthor || '') +
              (e.year ? ' (' + escapeHtmlForCE(String(e.year)) + ')' : '') +
              (e.journal ? ' · <i>' + escapeHtmlForCE(e.journal) + '</i>' : '') +
            '</div>' +
            (e.title ? '<div class="pe-cite-pop-title-line">' + escapeHtmlForCE(e.title.slice(0, 140)) + '</div>' : '') +
          '</div>';
        /* V3.150 — same fix as V3.148/V3.149: do NOT renderList() on
         * mouseenter. Toggle .active in place to avoid the click race. */
        row.addEventListener('mouseenter', function () {
          if (activeIdx === i) return;
          activeIdx = i;
          Array.prototype.forEach.call(listEl.querySelectorAll('.pe-cite-pop-row'), function (r2, idx) {
            r2.classList.toggle('active', idx === i);
          });
        });
        row.addEventListener('click', function () { toggleIndex(i); });
        listEl.appendChild(row);
      });
    }

    /* Selected-bar shows checked keys as chips at the top of the list,
     * so the user can see "what will be inserted" at a glance even
     * after typing a new search query that filters them out of view. */
    function _refreshSelectedBar() {
      var sel = citationPopoverState.selectedKeys;
      if (!sel || sel.size === 0) {
        selectedBar.hidden = true;
        selectedBar.innerHTML = '';
        return;
      }
      selectedBar.hidden = false;
      selectedBar.innerHTML = '';
      var lbl = document.createElement('span');
      lbl.className = 'pe-cite-pop-selected-label';
      lbl.textContent = (citationPopoverState.editing ? 'Editing' : 'Selected') + ' (' + sel.size + '):';
      selectedBar.appendChild(lbl);
      sel.forEach(function (key) {
        var chip = document.createElement('button');
        chip.type = 'button';
        chip.className = 'pe-cite-pop-selected-chip';
        chip.textContent = key + ' ✕';
        chip.title = 'Remove ' + key + ' from selection';
        chip.addEventListener('click', function () {
          sel.delete(key);
          renderList();
          _refreshSelectedBar();
          _refreshCommitBtn();
        });
        selectedBar.appendChild(chip);
      });
    }
    function _refreshCommitBtn() {
      var sel = citationPopoverState.selectedKeys;
      var n = sel ? sel.size : 0;
      var editing = !!citationPopoverState.editing;
      if (editing) {
        commitBtn.textContent = n === 0 ? 'Save (remove)' : 'Save (' + n + ')';
        commitBtn.disabled = false;   /* edit mode allows zero = remove */
        removeBtn.hidden = false;
      } else {
        commitBtn.textContent = n === 0 ? 'Insert' : (n === 1 ? 'Insert' : 'Insert ' + n);
        commitBtn.disabled = n === 0;
        removeBtn.hidden = true;
      }
    }

    /* V3.192 — render the "Claims for this paragraph" section above
     * the search list. Each claim card lists every citation that has
     * been wired up as evidence for that claim (supporting or
     * counter), with checkboxes that route to the same multi-pick
     * selection set as the search list. Each citation row has an
     * expand arrow that toggles a sub-block showing the highlight
     * text(s) + stance pill from `papers/{paperId}/annotations/{annId}`. */
    function _refreshClaimsBar() {
      var ctx = citationPopoverState.claimContext;
      var loading = citationPopoverState.claimContextLoading;
      if (!citationPopoverState.paragraphEl) {
        claimsBar.hidden = true;
        claimsBar.innerHTML = '';
        return;
      }
      if (loading) {
        claimsBar.hidden = false;
        claimsBar.innerHTML = '<div class="pe-cite-pop-claims-loading">Loading claim context…</div>';
        return;
      }
      if (!ctx || !ctx.length) {
        claimsBar.hidden = true;
        claimsBar.innerHTML = '';
        return;
      }
      claimsBar.hidden = false;
      claimsBar.innerHTML = '';
      var header = document.createElement('div');
      header.className = 'pe-cite-pop-claims-header';
      header.textContent = 'Claims for this paragraph';
      claimsBar.appendChild(header);

      var sel = citationPopoverState.selectedKeys;
      var expanded = citationPopoverState.expandedClaimEvidence ||
                     (citationPopoverState.expandedClaimEvidence = new Set());

      ctx.forEach(function (entry) {
        var claim = entry.claim;
        var card = document.createElement('div');
        card.className = 'pe-cite-pop-claim-card';
        var ch = document.createElement('div');
        ch.className = 'pe-cite-pop-claim-statement';
        ch.textContent = claim.statement || '(empty claim)';
        if (claim.status) {
          var statusPill = document.createElement('span');
          statusPill.className = 'pe-cite-pop-claim-status pe-cite-pop-claim-status-' + escapeAttr(claim.status);
          statusPill.textContent = claim.status;
          ch.appendChild(statusPill);
        }
        card.appendChild(ch);

        var keys = Object.keys(entry.papersByKey || {});
        if (!keys.length) {
          var empty = document.createElement('div');
          empty.className = 'pe-cite-pop-claim-empty';
          empty.textContent = 'No evidence linked yet.';
          card.appendChild(empty);
          claimsBar.appendChild(card);
          return;
        }
        keys.sort();
        keys.forEach(function (key) {
          var paper = entry.papersByKey[key];
          var row = document.createElement('div');
          row.className = 'pe-cite-pop-claim-paper';
          var checked = sel && sel.has(key);
          if (checked) row.classList.add('checked');

          var head = document.createElement('div');
          head.className = 'pe-cite-pop-claim-paper-head';
          var checkbox = document.createElement('span');
          checkbox.className = 'pe-cite-pop-row-check';
          checkbox.textContent = checked ? '✓' : '';
          head.appendChild(checkbox);
          var meta = document.createElement('div');
          meta.className = 'pe-cite-pop-claim-paper-meta';
          var keyEl = document.createElement('div');
          keyEl.className = 'pe-cite-pop-key';
          keyEl.textContent = paper.citationKey;
          meta.appendChild(keyEl);
          var ml = document.createElement('div');
          ml.className = 'pe-cite-pop-meta';
          ml.textContent = (paper.firstAuthor || '') +
            (paper.year ? ' (' + paper.year + ')' : '') +
            (paper.title ? ' — ' + paper.title.slice(0, 90) : '');
          meta.appendChild(ml);
          head.appendChild(meta);

          var stanceCounts = { for: 0, against: 0 };
          (paper.evidence || []).forEach(function (e) {
            if (e.stance === 'for') stanceCounts.for++;
            else if (e.stance === 'against') stanceCounts.against++;
          });
          var stanceWrap = document.createElement('span');
          stanceWrap.className = 'pe-cite-pop-claim-stance';
          if (stanceCounts.for) {
            stanceWrap.innerHTML += '<span class="pe-cite-pop-claim-stance-for">' +
              stanceCounts.for + ' for</span>';
          }
          if (stanceCounts.against) {
            stanceWrap.innerHTML += '<span class="pe-cite-pop-claim-stance-against">' +
              stanceCounts.against + ' against</span>';
          }
          head.appendChild(stanceWrap);

          var expKey = claim.id + '|' + key;
          var arrow = document.createElement('button');
          arrow.type = 'button';
          arrow.className = 'pe-cite-pop-claim-expand';
          arrow.title = 'Show highlights for this paper + claim';
          arrow.textContent = expanded.has(expKey) ? '▼' : '▶';
          arrow.addEventListener('click', function (ev) {
            ev.stopPropagation();
            if (expanded.has(expKey)) expanded.delete(expKey);
            else expanded.add(expKey);
            _refreshClaimsBar();
          });
          head.appendChild(arrow);

          /* Clicking the row body (anywhere except the arrow) toggles
           * the citation in the multi-pick selection. */
          head.addEventListener('click', function () {
            var s = citationPopoverState.selectedKeys ||
                    (citationPopoverState.selectedKeys = new Set());
            if (s.has(key)) s.delete(key);
            else s.add(key);
            _refreshClaimsBar();
            _refreshSelectedBar();
            _refreshCommitBtn();
            renderList();
          });

          row.appendChild(head);

          if (expanded.has(expKey)) {
            var evWrap = document.createElement('div');
            evWrap.className = 'pe-cite-pop-claim-evidence';
            (paper.evidence || []).forEach(function (e) {
              var ev = document.createElement('div');
              ev.className = 'pe-cite-pop-claim-evrow pe-cite-pop-claim-evrow-' + escapeAttr(e.stance || 'for');
              var stancePill = document.createElement('span');
              stancePill.className = 'pe-cite-pop-claim-evrow-stance';
              stancePill.textContent = e.stance || '';
              ev.appendChild(stancePill);
              var textEl = document.createElement('div');
              textEl.className = 'pe-cite-pop-claim-evrow-text';
              textEl.textContent = (e.text ? '“' + e.text + '”' : '(no highlight text)');
              ev.appendChild(textEl);
              if (e.comment) {
                var cmt = document.createElement('div');
                cmt.className = 'pe-cite-pop-claim-evrow-comment';
                cmt.textContent = e.comment;
                ev.appendChild(cmt);
              }
              evWrap.appendChild(ev);
            });
            row.appendChild(evWrap);
          }

          card.appendChild(row);
        });
        claimsBar.appendChild(card);
      });
    }


    function toggleIndex(i) {
      var entry = current[i];
      if (!entry) return;
      /* V3.157 — backward-compat: if a legacy onPick callback is set
       * AND we're not in multi-pick / edit mode (no selectedKeys set),
       * preserve the V3.156 single-pick behavior — click row → close
       * + invoke onPick(entry) immediately. Cmd+K still uses this code
       * path until V3.158-or-later. */
      if (citationPopoverState.onPick && !citationPopoverState.onPickKeys && !citationPopoverState.editing) {
        var cb = citationPopoverState.onPick;
        hide();
        if (cb) cb(entry);
        return;
      }
      /* Multi-pick / edit: toggle in selectedKeys. */
      var sel = citationPopoverState.selectedKeys || (citationPopoverState.selectedKeys = new Set());
      if (sel.has(entry.key)) {
        sel.delete(entry.key);
      } else {
        sel.add(entry.key);
      }
      renderList();
      _refreshSelectedBar();
      _refreshCommitBtn();
    }

    function commit() {
      var cb = citationPopoverState.onPickKeys;
      var sel = citationPopoverState.selectedKeys;
      var keys = [];
      if (sel) sel.forEach(function (k) { keys.push(k); });
      hide();
      if (cb) cb(keys);
    }
    function removeEntirely() {
      var cb = citationPopoverState.onRemove;
      hide();
      if (cb) cb();
    }

    input.addEventListener('input', refresh);
    input.addEventListener('keydown', function (e) {
      if (e.key === 'Escape') { hide(); e.preventDefault(); return; }
      if (e.key === 'Enter') {
        if (e.metaKey || e.ctrlKey) {
          /* Cmd/Ctrl+Enter — commit multi-pick. */
          commit();
        } else {
          toggleIndex(activeIdx);
        }
        e.preventDefault();
        return;
      }
      if (e.key === ' ') {
        toggleIndex(activeIdx);
        e.preventDefault();
        return;
      }
      if (e.key === 'ArrowDown') {
        if (current.length) activeIdx = (activeIdx + 1) % current.length;
        renderList(); e.preventDefault();
      }
      if (e.key === 'ArrowUp') {
        if (current.length) activeIdx = (activeIdx - 1 + current.length) % current.length;
        renderList(); e.preventDefault();
      }
    });
    commitBtn.addEventListener('click', function (e) { e.preventDefault(); commit(); });
    cancelBtn.addEventListener('click', function (e) { e.preventDefault(); hide(); });
    removeBtn.addEventListener('click', function (e) { e.preventDefault(); removeEntirely(); });
    document.addEventListener('mousedown', function (e) {
      if (!pop.hidden && !pop.contains(e.target)) hide();
    });

    function hide() {
      pop.hidden = true;
      citationPopoverState.onPick = null;
      citationPopoverState.onPickKeys = null;
      citationPopoverState.onRemove = null;
      citationPopoverState.anchorEl = null;
      citationPopoverState.selectedKeys = null;
      citationPopoverState.editing = false;
      /* V3.192 — clear claim-context so a stale paragraphEl from the
       * previous open can't bleed into the next one. */
      citationPopoverState.paragraphEl = null;
      citationPopoverState.claimContext = null;
      citationPopoverState.claimContextLoading = false;
      citationPopoverState.expandedClaimEvidence = null;
    }
    pop._refresh = refresh;
    pop._focus = function () { input.focus(); input.select(); };
    pop._hide = hide;
    pop._setTitle = function (t) { titleEl.textContent = t; };
    return pop;
  }

  /* V3.192 — find the paragraph (paper block) that owns a
   * contenteditable element, by walking up to `.pe-block[data-block-id]`. */
  function _blockIdOfParagraph(paragraphEl) {
    if (!paragraphEl) return null;
    var blk = paragraphEl.closest && paragraphEl.closest('.pe-block[data-block-id]');
    return blk ? (blk.dataset.blockId || null) : null;
  }

  /* V3.192 — collect the `claim_id` values from a paragraph block's
   * `skeleton_items` Y.Array. Returns an array of non-null claim ids
   * in document order. */
  function _claimIdsForBlock(blockId) {
    if (!blockId || !state.paperMap) return [];
    var sections = state.paperMap.get('sections');
    if (!sections || typeof sections.forEach !== 'function') return [];
    var out = [];
    sections.forEach(function (secMap) {
      var children = secMap && secMap.get && secMap.get('children');
      if (!children || typeof children.forEach !== 'function') return;
      children.forEach(function (blk) {
        if (!blk || typeof blk.get !== 'function') return;
        if (blk.get('id') !== blockId) return;
        var skItems = blk.get('skeleton_items');
        if (!skItems || typeof skItems.forEach !== 'function') return;
        skItems.forEach(function (item) {
          if (!item || typeof item.get !== 'function') return;
          var cid = item.get('claim_id');
          if (cid && out.indexOf(cid) < 0) out.push(cid);
        });
      });
    });
    return out;
  }

  /* V3.192 — async loader for the V3.192 citation-popover claim
   * context. Returns a promise resolving to:
   *
   *   [{
   *     claim: { id, statement, status },
   *     papersByKey: {
   *       <citationKey>: {
   *         paperId, citationKey, title, firstAuthor, year,
   *         evidence: [{ annId, stance, text, comment }]
   *       },
   *       ...
   *     }
   *   }, ...]
   *
   * Pulls claims from the PaperBulletClaims local cache (already
   * subscribed via the editor mount), resolves each paperId to its
   * library citationKey via state.citationByKey, and Firestore-fetches
   * each annotation doc for the highlight text + stance. Annotations
   * are batched in one Promise.all so the popover renders quickly. */
  function _loadClaimContext(paragraphEl) {
    var blockId = _blockIdOfParagraph(paragraphEl);
    if (!blockId) return Promise.resolve([]);
    var claimIds = _claimIdsForBlock(blockId);
    if (!claimIds.length) return Promise.resolve([]);
    if (!window.PaperBulletClaims || !window.PaperBulletClaims.getClaim) {
      return Promise.resolve([]);
    }
    /* Build the (paperId → citationKey, libRow) lookup from items.json
     * via the cached citation list. */
    var libByPaperId = {};
    (state.citationList || []).forEach(function (e) {
      if (e && e.itemId) libByPaperId[e.itemId] = e;
    });
    var pending = []; /* annotation fetches */
    var output = claimIds.map(function (cid) {
      var claim = window.PaperBulletClaims.getClaim(cid);
      if (!claim) return { claim: { id: cid, statement: '', status: '' }, papersByKey: {} };
      var papersByKey = {};
      function addEvidence(list, stance) {
        (list || []).forEach(function (ref) {
          if (!ref || !ref.paperId || !ref.annId) return;
          var lib = libByPaperId[ref.paperId];
          if (!lib) return;   /* paper not in library — skip */
          var key = lib.key;
          if (!papersByKey[key]) {
            papersByKey[key] = {
              paperId: ref.paperId,
              citationKey: key,
              title: lib.title || '',
              firstAuthor: lib.firstAuthor || '',
              year: lib.year || '',
              evidence: [],
            };
          }
          var slot = { annId: ref.annId, stance: stance, text: '', comment: '' };
          papersByKey[key].evidence.push(slot);
          pending.push(_fetchAnnotation(ref.paperId, ref.annId).then(function (ann) {
            if (!ann) return;
            slot.text = (ann.target && ann.target.pages || [])
              .map(function (p) {
                return (p && p.selectors && p.selectors.textQuote && p.selectors.textQuote.exact) || '';
              })
              .filter(Boolean)
              .join(' / ');
            slot.comment = ann.comment || '';
          }).catch(function () { /* leave empty */ }));
        });
      }
      addEvidence(claim.supporting_evidence_ids, 'for');
      addEvidence(claim.counter_evidence_ids, 'against');
      return {
        claim: { id: claim.id, statement: claim.statement || '', status: claim.status || '' },
        papersByKey: papersByKey,
      };
    });
    return Promise.all(pending).then(function () { return output; });
  }

  function _fetchAnnotation(paperId, annId) {
    if (typeof firebase === 'undefined' || !firebase.firestore) return Promise.resolve(null);
    try {
      return firebase.firestore()
        .collection('papers').doc(paperId)
        .collection('annotations').doc(annId)
        .get()
        .then(function (snap) { return snap.exists ? snap.data() : null; });
    } catch (e) { return Promise.resolve(null); }
  }

  /** Open the citation popover.
   *
   * opts.anchorEl       positions the popover (default: centered).
   * opts.onPick(entry)  legacy single-pick callback (Cmd+K). Picks
   *                     close the popover immediately.
   * opts.onPickKeys(keys[])  multi-pick commit callback. Receives an
   *                     array of selected keys when the user clicks
   *                     "Insert N" or hits Cmd/Ctrl+Enter. When
   *                     supplied, every row click toggles selection
   *                     instead of immediately closing.
   * opts.onRemove()     edit-mode-only; called when "Remove citation"
   *                     is clicked.
   * opts.initialKeys    array of keys to pre-check (multi-pick / edit).
   * opts.editing        true to render in edit mode (changes title +
   *                     button labels + shows Remove button).
   * opts.title          override the popover title.
   * opts.paragraphEl    (V3.192) the paragraph contenteditable the
   *                     user invoked the popover from. When provided,
   *                     the popover surfaces a "Claims for this
   *                     paragraph" section at the top, listing each
   *                     claim's linked citations + expandable
   *                     highlight evidence. Lets the user pick
   *                     citations grounded in the claim work they've
   *                     already done.
   */
  function openCitationPopover(opts) {
    if (!state.citationList || !state.citationList.length) {
      // Index might still be loading. Wait briefly.
      loadCitationIndex().then(function () { openCitationPopover(opts); });
    }
    var pop = ensureCitationPopover();
    citationPopoverState.onPick = opts && opts.onPick || null;
    citationPopoverState.onPickKeys = opts && opts.onPickKeys || null;
    citationPopoverState.onRemove = opts && opts.onRemove || null;
    citationPopoverState.anchorEl = opts && opts.anchorEl || null;
    citationPopoverState.editing = !!(opts && opts.editing);
    /* V3.157 — pre-fill selection. Always create a Set when caller
     * passed onPickKeys so toggleIndex routes to multi-pick logic
     * even when initialKeys is empty. */
    if (citationPopoverState.onPickKeys || citationPopoverState.editing) {
      citationPopoverState.selectedKeys = new Set(
        (opts && opts.initialKeys) || []
      );
    } else {
      citationPopoverState.selectedKeys = null;
    }
    pop._setTitle(opts && opts.title
      ? opts.title
      : (citationPopoverState.editing ? 'Edit citation' : 'Insert citation'));
    /* V3.192 — kick off the claim-context load when the caller supplied
     * a paragraphEl. The popover renders a "Claims for this paragraph"
     * section above the search list once the data arrives. */
    citationPopoverState.paragraphEl = (opts && opts.paragraphEl) || null;
    citationPopoverState.claimContext = null;
    citationPopoverState.claimContextLoading = false;
    citationPopoverState.expandedClaimEvidence = new Set();
    if (citationPopoverState.paragraphEl) {
      citationPopoverState.claimContextLoading = true;
      var pendingParagraph = citationPopoverState.paragraphEl;
      _loadClaimContext(pendingParagraph).then(function (ctx) {
        /* Guard against a stale resolve after the popover was reused
         * for a different paragraph (or closed). */
        if (citationPopoverState.paragraphEl !== pendingParagraph) return;
        citationPopoverState.claimContext = ctx || [];
        citationPopoverState.claimContextLoading = false;
        if (!pop.hidden) pop._refresh();
      }).catch(function () {
        if (citationPopoverState.paragraphEl !== pendingParagraph) return;
        citationPopoverState.claimContext = [];
        citationPopoverState.claimContextLoading = false;
        if (!pop.hidden) pop._refresh();
      });
    }
    /* Position: just below the anchor's bounding rect, or center. */
    var anchor = opts && opts.anchorEl;
    pop.style.transform = '';
    if (anchor) {
      var rect = anchor.getBoundingClientRect();
      pop.style.left = Math.max(10, Math.min(window.innerWidth - 470, rect.left)) + 'px';
      pop.style.top  = Math.max(10, rect.bottom + 6) + 'px';
    } else {
      pop.style.left = '50%';
      pop.style.top  = '120px';
      pop.style.transform = 'translateX(-50%)';
    }
    pop.hidden = false;
    pop._refresh();
    pop._focus();
  }

  /* Insert a Pandoc citation token at the last-focused contenteditable's
   * caret. Operates through the Y.Text local-input path so collaborators
   * see the change. */
  function insertCitationAtFocus(citationKey) {
    insertCitationKeysAtFocus([citationKey]);
  }

  /* V3.157 — multi-key variant. Builds a single `[@k1; @k2]` Pandoc
   * group rather than separate brackets, since the latter renders as
   * separate inline citations whereas the former reads as one citation
   * group in academic style. */
  function insertCitationKeysAtFocus(citationKeys) {
    if (!lastFocusedEditable) return;
    var keys = (citationKeys || []).filter(Boolean);
    if (!keys.length) return;
    var el = lastFocusedEditable;
    el.focus();
    setCaretCharOffset(el, lastFocusedCaret);
    var token = '[@' + keys.join('; @') + ']';
    var ok = document.execCommand && document.execCommand('insertText', false, token);
    if (!ok) {
      var sel = window.getSelection();
      if (sel.rangeCount) {
        sel.getRangeAt(0).deleteContents();
        sel.getRangeAt(0).insertNode(document.createTextNode(token));
        el.dispatchEvent(new InputEvent('input', { bubbles: true }));
      }
    }
  }

  /* V3.157 — open the citation popover in edit mode for an existing
   * citation chip. The chip span carries data-cite-src-start/end (the
   * byte range in the paragraph's Y.Text source that produced this
   * group) plus data-cite-keys (semicolon-joined initial selection).
   * Commit replaces the byte range with a fresh `[@k1; @k2]` token
   * (or removes it entirely when no keys remain). */
  function _openCitationEditor(paragraphEl, yText, groupEl) {
    var srcStart = parseInt(groupEl.dataset.citeSrcStart, 10);
    var srcEnd = parseInt(groupEl.dataset.citeSrcEnd, 10);
    if (isNaN(srcStart) || isNaN(srcEnd)) return;
    var initialKeys = (groupEl.dataset.citeKeys || '').split(';').filter(Boolean);
    /* Stash the paragraph element on lastFocused so the commit path
     * (which routes through replaceParagraphRange + execCommand) lands
     * in the right contenteditable. */
    lastFocusedEditable = paragraphEl;
    openCitationPopover({
      anchorEl: groupEl,
      editing: true,
      initialKeys: initialKeys,
      title: 'Edit citation (' + initialKeys.length + ' key' + (initialKeys.length === 1 ? '' : 's') + ')',
      onPickKeys: function (keys) {
        /* Source-text offsets reflect the SOURCE state at render time.
         * Once the contenteditable focuses, its DOM is the source text
         * via the focus handler — so srcStart/srcEnd map directly to
         * positions in el.textContent. */
        var newToken = keys.length ? '[@' + keys.join('; @') + ']' : '';
        replaceParagraphRange(paragraphEl, srcStart, srcEnd, newToken);
      },
      onRemove: function () {
        replaceParagraphRange(paragraphEl, srcStart, srcEnd, '');
      },
    });
  }

  /* V3.157 / V3.159 — edit-mode helper. Replaces the source-text
   * range [srcStart, srcEnd) inside `paragraphEl` with `newText`.
   * Used by the click-on-citation-chip flow: the chip span carries
   * data-cite-src-start/end (render-time stamp) and the popover
   * replaces those bytes with the new `[@k1; @k2]` token.
   *
   * V3.159: walks BOTH text nodes (each char = 1 byte) AND atomic
   * chips (each chip's `data-src.length` = N bytes, range must align
   * to the chip's outer boundary since chips are contenteditable=false
   * and can't be split). When inserting non-empty newText, builds a
   * chip span via renderChipsOnlyHtml so the replacement renders as
   * an atomic chip immediately rather than as raw bracket text. */
  function replaceParagraphRange(paragraphEl, srcStart, srcEnd, newText) {
    if (!paragraphEl) return false;
    paragraphEl.focus();
    var startNode = null, startOff = 0, endNode = null, endOff = 0;
    var charCount = 0;
    function visit(parent) {
      for (var i = 0; i < parent.childNodes.length; i++) {
        if (startNode && endNode) return;
        var node = parent.childNodes[i];
        if (node.nodeType === Node.TEXT_NODE) {
          var len = node.length;
          var next = charCount + len;
          if (!startNode && srcStart >= charCount && srcStart <= next) {
            startNode = node; startOff = srcStart - charCount;
          }
          if (!endNode && srcEnd >= charCount && srcEnd <= next) {
            endNode = node; endOff = srcEnd - charCount;
          }
          charCount = next;
        } else if (node.nodeType === Node.ELEMENT_NODE) {
          if (node.dataset && node.dataset.src) {
            var chipLen = node.dataset.src.length;
            var nextC = charCount + chipLen;
            if (!startNode && srcStart >= charCount && srcStart <= nextC) {
              startNode = parent;
              startOff = (srcStart === charCount) ? i : i + 1;
            }
            if (!endNode && srcEnd >= charCount && srcEnd <= nextC) {
              endNode = parent;
              endOff = (srcEnd === charCount) ? i : i + 1;
            }
            charCount = nextC;
          } else if (node.tagName === 'BR') {
            var nextB = charCount + 1;
            if (!startNode && srcStart >= charCount && srcStart <= nextB) {
              startNode = parent;
              startOff = (srcStart === charCount) ? i : i + 1;
            }
            if (!endNode && srcEnd >= charCount && srcEnd <= nextB) {
              endNode = parent;
              endOff = (srcEnd === charCount) ? i : i + 1;
            }
            charCount = nextB;
          } else {
            visit(node);
          }
        }
      }
    }
    visit(paragraphEl);
    if (!startNode || !endNode) {
      console.warn('[paper-editor] replaceParagraphRange: source range not found');
      return false;
    }
    var range = document.createRange();
    range.setStart(startNode, startOff);
    range.setEnd(endNode, endOff);
    var sel = window.getSelection();
    sel.removeAllRanges();
    sel.addRange(range);
    range.deleteContents();
    if (newText) {
      try {
        var chipHtml = renderChipsOnlyHtml(newText);
        var tpl = document.createElement('template');
        tpl.innerHTML = chipHtml;
        var chipNode = tpl.content.firstChild;
        if (chipNode) {
          range.insertNode(chipNode);
          var after = document.createRange();
          after.setStartAfter(chipNode);
          after.collapse(true);
          sel.removeAllRanges();
          sel.addRange(after);
        } else {
          range.insertNode(document.createTextNode(newText));
        }
      } catch (e3) {
        try { range.insertNode(document.createTextNode(newText)); } catch (e4) {}
      }
    }
    paragraphEl.dispatchEvent(new InputEvent('input', { bubbles: true }));
    return true;
  }

  /* ── KaTeX lazy loader (Phase C preview) ───────────────────────────────
   *
   * Loads KaTeX from a CDN ESM bundle the first time we need to render
   * inline math. Until it's loaded, paragraph contenteditables show plain
   * source `$\alpha$`. After load, paragraphs that aren't focused get the
   * rendered version; focusing a paragraph reverts to plain source so the
   * user can edit. Blur re-renders.
   *
   * This is a Phase B+ preview of full Phase C math/citations support — only
   * inline `$...$` and `\(...\)` are recognized. Display equations remain
   * their own block kind (Phase C).
   */
  var KATEX_CDN = 'https://cdn.jsdelivr.net/npm/katex@0.16/+esm';
  var _katex = null;
  var _katexPromise = null;
  function ensureKatex() {
    if (_katex) return Promise.resolve(_katex);
    if (_katexPromise) return _katexPromise;
    _katexPromise = import(KATEX_CDN).then(function (mod) {
      _katex = mod.default || mod;
      return _katex;
    }).catch(function (err) {
      console.warn('[paper-editor] KaTeX load failed:', err.message);
      _katexPromise = null;
      throw err;
    });
    return _katexPromise;
  }

  /** Render inline content in a paragraph (math + citation chips + V3.107
   * markdown formatting) to HTML.
   *
   * - `$...$`, `\(...\)`            → KaTeX inline math
   * - `[@key]`, `[@k1; @k2]`        → citation chips (resolves authors from
   *                                   state.citationByKey when present)
   * - `` `code` ``                  → <code>code</code>          (V3.107)
   * - `**bold**`                    → <strong>bold</strong>      (V3.107)
   * - `*italic*`                    → <em>italic</em>            (V3.107)
   * - `~sub~`                       → <sub>sub</sub>             (V3.107)
   * - `^sup^`                       → <sup>sup</sup>             (V3.107)
   *
   * Formatting tokens recurse through this same scanner so wrapped content
   * can itself contain math / cite / nested formatting (e.g.
   * `**Smith [@smith2024] showed $x^2$**`). Tokens reject when the inner
   * content is empty, contains a newline, has whitespace at the boundary
   * (which is the markdown convention to avoid eating prose with `*` /
   * `~` / `^` characters in it), or contains another copy of the
   * delimiter (single-char tokens only).
   *
   * Plain characters are HTML-escaped. Newlines become <br>. Math falls
   * back to the raw delimiter-wrapped source on KaTeX error. */
  function renderParagraphHtml(text) {
    if (!text) return '';
    var out = '';
    var i = 0;
    var n = text.length;
    while (i < n) {
      var ch = text[i];

      // $...$  (KaTeX needed; if not yet loaded, fall back to literal)
      if (ch === '$' && (i === 0 || text[i - 1] !== '\\')) {
        var j = i + 1;
        while (j < n) {
          if (text[j] === '$' && text[j - 1] !== '\\') break;
          j++;
        }
        if (j < n && j > i + 1) {
          var src = text.slice(i + 1, j);
          out += _katex
            ? renderOneMath(src, false, '$' + src + '$')
            : escapeHtmlForCE('$' + src + '$');
          i = j + 1;
          continue;
        }
      }

      // \(...\)
      if (ch === '\\' && text[i + 1] === '(') {
        var k1 = text.indexOf('\\)', i + 2);
        if (k1 > i) {
          var src2 = text.slice(i + 2, k1);
          out += _katex
            ? renderOneMath(src2, false, '\\(' + src2 + '\\)')
            : escapeHtmlForCE('\\(' + src2 + '\\)');
          i = k1 + 2;
          continue;
        }
      }

      // V3.109 — [!eqi:<id>] inline equation from the paper's equation
      // library. Renders inline KaTeX of the entry's latex source. If
      // KaTeX hasn't loaded yet, falls back to a placeholder chip with
      // the entry's name. Unknown ids render as a faded `[?eq]` chip so
      // the writer notices broken references.
      if (ch === '[' && text[i + 1] === '!' && text.slice(i + 2, i + 6) === 'eqi:') {
        var endEqi = text.indexOf(']', i + 6);
        if (endEqi > i + 6) {
          var eqiId = text.slice(i + 6, endEqi).trim();
          if (/^[\w:.\-]+$/.test(eqiId)) {
            out += renderInlineEqLibraryChip(eqiId);
            i = endEqi + 1;
            continue;
          }
        }
      }
      // V3.109 — [!eqr:<label>] reference to a numbered equation block.
      // Renders as `Eq. <n>` chip where n is the document-order number.
      if (ch === '[' && text[i + 1] === '!' && text.slice(i + 2, i + 6) === 'eqr:') {
        var endEqr = text.indexOf(']', i + 6);
        if (endEqr > i + 6) {
          var eqrLabel = text.slice(i + 6, endEqr).trim();
          if (/^[\w:.\-]+$/.test(eqrLabel)) {
            out += renderEqRefChip(eqrLabel);
            i = endEqr + 1;
            continue;
          }
        }
      }

      // V3.120 — [!tab:<label>] reference to a numbered table block.
      // Renders as `Tab. <n>` chip. Same accept rule as eqr/figref.
      if (ch === '[' && text[i + 1] === '!' && text.slice(i + 2, i + 6) === 'tab:') {
        var endTab = text.indexOf(']', i + 6);
        if (endTab > i + 6) {
          var tabLabel = text.slice(i + 6, endTab).trim();
          if (/^[\w:.\-]+$/.test(tabLabel)) {
            out += renderTabRefChip(tabLabel);
            i = endTab + 1;
            continue;
          }
        }
      }

      // V3.115 — [!fig:<label>], [!fig:<label>:<panel>], or
      // [!fig:<label>:<a>-<b>] reference to a numbered figure block.
      // Renders as `Fig. <n>`, `Fig. <n> (A)`, or `Fig. <n> (A-B)` chip.
      if (ch === '[' && text[i + 1] === '!' && text.slice(i + 2, i + 6) === 'fig:') {
        var endFig = text.indexOf(']', i + 6);
        if (endFig > i + 6) {
          var figInner = text.slice(i + 6, endFig).trim();
          // Allow letters/digits/colon/dash/underscore in the label,
          // optional colon-separated panel which can be a single token
          // or `a-b` range.
          var figMatch = /^([\w:.\-]+?)(?::([\w]+(?:-[\w]+)?))?$/.exec(figInner);
          if (figMatch) {
            var figLabel = figMatch[1];
            var figPanel = figMatch[2] || '';
            out += renderFigRefChip(figLabel, figPanel);
            i = endFig + 1;
            continue;
          }
        }
      }

      // [@key] / [@k1; @k2]  (Pandoc citations)
      if (ch === '[' && text[i + 1] === '@') {
        var endBracket = text.indexOf(']', i + 2);
        if (endBracket > i) {
          var inner = text.slice(i + 2, endBracket);
          // Validate: each token starts with @ (after the first) and contains
          // only citation-key-friendly chars + a separator.
          if (/^[\w:.\-+/]+(\s*;\s*@[\w:.\-+/]+)*$/.test(inner)) {
            /* V3.157 — pass the source-text range so the rendered
             * .pe-cite-group can be clicked + edited later. The
             * paragraph's source text is the same string we're
             * scanning, so [i, endBracket+1) is the byte range in
             * yText that produced this group. */
            out += renderCitationChip(inner, i, endBracket + 1);
            i = endBracket + 1;
            continue;
          }
        }
      }

      // V3.107 — `code` (single backticks). Plain text inside (no recursion);
      // code spans deliberately render their content verbatim.
      if (ch === '`') {
        var endTick = text.indexOf('`', i + 1);
        if (endTick > i + 1) {
          var codeInner = text.slice(i + 1, endTick);
          if (codeInner.indexOf('\n') === -1 && codeInner.length > 0) {
            out += '<code>' + escapeHtmlForCE(codeInner) + '</code>';
            i = endTick + 1;
            continue;
          }
        }
      }

      // V3.107 — **bold** (must come before *italic*)
      if (ch === '*' && text[i + 1] === '*') {
        var endBold = text.indexOf('**', i + 2);
        if (endBold > i + 2) {
          var boldInner = text.slice(i + 2, endBold);
          if (boldInner.indexOf('\n') === -1 &&
              !/^\s|\s$/.test(boldInner)) {
            out += '<strong>' + renderParagraphHtml(boldInner) + '</strong>';
            i = endBold + 2;
            continue;
          }
        }
      }

      // V3.107 — *italic*
      if (ch === '*') {
        var endIt = text.indexOf('*', i + 1);
        if (endIt > i + 1) {
          var itInner = text.slice(i + 1, endIt);
          if (itInner.indexOf('\n') === -1 &&
              itInner.indexOf('*') === -1 &&
              !/^\s|\s$/.test(itInner)) {
            out += '<em>' + renderParagraphHtml(itInner) + '</em>';
            i = endIt + 1;
            continue;
          }
        }
      }

      // V3.107 — ~sub~
      if (ch === '~') {
        var endSub = text.indexOf('~', i + 1);
        if (endSub > i + 1) {
          var subInner = text.slice(i + 1, endSub);
          if (subInner.indexOf('\n') === -1 &&
              subInner.indexOf('~') === -1 &&
              !/^\s|\s$/.test(subInner)) {
            out += '<sub>' + renderParagraphHtml(subInner) + '</sub>';
            i = endSub + 1;
            continue;
          }
        }
      }

      // V3.107 — ^sup^
      if (ch === '^') {
        var endSup = text.indexOf('^', i + 1);
        if (endSup > i + 1) {
          var supInner = text.slice(i + 1, endSup);
          if (supInner.indexOf('\n') === -1 &&
              supInner.indexOf('^') === -1 &&
              !/^\s|\s$/.test(supInner)) {
            out += '<sup>' + renderParagraphHtml(supInner) + '</sup>';
            i = endSup + 1;
            continue;
          }
        }
      }

      out += escapeHtmlChar(ch);
      i++;
    }
    return out;
  }

  /* Render a Pandoc citation token. `inner` is the body between [@ and ],
   * e.g. "key1; @key2". Looks each key up in state.citationByKey for a
   * tooltip showing first author + year.
   *
   * V3.157 — also stamps `data-cite-src-start` / `-end` / `-keys` on
   * the wrapping `.pe-cite-group` so a delegated click handler on the
   * contenteditable can identify which source-range byte span the
   * group came from and open the popover in edit mode pre-filled with
   * the existing keys. */
  function renderCitationChip(inner, srcStart, srcEnd) {
    var keys = inner.split(/\s*;\s*@?/).map(function (s) { return s.trim(); }).filter(Boolean);
    var parts = keys.map(function (key) {
      var hit = state.citationByKey ? state.citationByKey[key] : null;
      var label = hit && hit.shortLabel ? hit.shortLabel : key;
      var tooltip = hit ? (hit.title || key) : ('Unknown citation key: ' + key);
      var cls = hit ? 'pe-cite-chip' : 'pe-cite-chip pe-cite-chip-unknown';
      return '<span class="' + cls + '" data-key="' + escapeAttr(key) +
             '" title="' + escapeAttr(tooltip) + '">' + escapeHtmlForCE(label) + '</span>';
    });
    var srcAttrs = '';
    /* V3.159 — atomic chip: contenteditable=false + data-src=[@k1; @k2]
     * so the chip-mode renderer treats it as a single non-editable
     * unit and the serializer reads the exact source token back. */
    var srcToken = '[@' + keys.join('; @') + ']';
    if (typeof srcStart === 'number' && typeof srcEnd === 'number') {
      srcAttrs = ' data-cite-src-start="' + srcStart +
                 '" data-cite-src-end="' + srcEnd +
                 '" data-cite-keys="' + escapeAttr(keys.join(';')) + '"' +
                 ' title="Click to edit citation"';
    }
    return '<span class="pe-cite-group" contenteditable="false" data-src="' + escapeAttr(srcToken) + '"' + srcAttrs + '>' +
             parts.join('<span class="pe-cite-sep">; </span>') +
           '</span>';
  }

  /* V3.109 — render an inline-library equation chip. Looks up the entry
   * by id; if found, renders KaTeX of its latex; otherwise emits a faded
   * placeholder chip so a missing-library reference doesn't crash the
   * paragraph render. */
  function renderInlineEqLibraryChip(id) {
    /* V3.159 — `id` here is whatever was between `[!eqi:` and `]` in
     * the source — could be the entry's raw id or a slugified name
     * (V3.152). Either way, `[!eqi:<id>]` is the exact source token
     * we stamp as data-src so the serializer round-trips losslessly. */
    var srcToken = '[!eqi:' + id + ']';
    var entry = getInlineEquationById(id);
    if (!entry) {
      return '<span class="pe-eqi-chip pe-eqi-chip-unknown" contenteditable="false" data-src="' + escapeAttr(srcToken) +
             '" title="Unknown equation library entry: ' + escapeAttr(id) +
             '" data-eqi-id="' + escapeAttr(id) + '">[?eq]</span>';
    }
    var name = entry.name || '';
    var latex = entry.latex || '';
    if (!latex) {
      return '<span class="pe-eqi-chip pe-eqi-chip-empty" contenteditable="false" data-src="' + escapeAttr(srcToken) +
             '" data-eqi-id="' + escapeAttr(id) + '" title="' + escapeAttr(name || id) + ' (empty)">[' +
             escapeHtmlForCE(name || id) + ']</span>';
    }
    if (!_katex) {
      // Fall back to plain LaTeX source while KaTeX is loading.
      return '<span class="pe-eqi-chip" contenteditable="false" data-src="' + escapeAttr(srcToken) +
             '" data-eqi-id="' + escapeAttr(id) + '" title="' + escapeAttr(name || id) + '">' +
             escapeHtmlForCE(latex) + '</span>';
    }
    var katexHtml = renderOneMath(latex, false, latex);
    return '<span class="pe-eqi-chip" contenteditable="false" data-src="' + escapeAttr(srcToken) +
           '" data-eqi-id="' + escapeAttr(id) + '" title="' + escapeAttr(name || id) + '">' +
           katexHtml + '</span>';
  }

  /* V3.109 — render a numbered-equation reference chip. Looks up the
   * label across the paper's numbered equations and renders `Eq. <n>`
   * where n is the doc-order number. Unknown labels render as a faded
   * `[?Eq. <label>]` chip. */
  function renderEqRefChip(label) {
    var srcToken = '[!eqr:' + label + ']';
    var hit = getNumberedEquationByLabel(label);
    if (!hit) {
      return '<span class="pe-eqref-chip pe-eqref-chip-unknown" contenteditable="false" data-src="' + escapeAttr(srcToken) +
             '" title="No numbered equation with label: ' +
             escapeAttr(label) + '" data-eqref-label="' + escapeAttr(label) + '">[?Eq. ' +
             escapeHtmlForCE(label) + ']</span>';
    }
    return '<span class="pe-eqref-chip" contenteditable="false" data-src="' + escapeAttr(srcToken) +
           '" data-eqref-label="' + escapeAttr(label) +
           '" data-block-id="' + escapeAttr(hit.blockId) + '" title="' +
           escapeAttr(label) + ' — click to scroll">Eq. ' + hit.num + '</span>';
  }

  /* V3.115 — render a figure reference chip. */
  function renderFigRefChip(label, panel) {
    var srcToken = '[!fig:' + label + (panel ? ':' + panel : '') + ']';
    var hit = getNumberedFigureByLabel(label);
    if (!hit) {
      return '<span class="pe-figref-chip pe-figref-chip-unknown" contenteditable="false" data-src="' + escapeAttr(srcToken) +
             '" title="No numbered figure with label: ' +
             escapeAttr(label) + '" data-figref-label="' + escapeAttr(label) + '">[?Fig. ' +
             escapeHtmlForCE(label) + (panel ? ' (' + escapeHtmlForCE(panel) + ')' : '') + ']</span>';
    }
    var panelSuffix = '';
    var panelClass = '';
    if (panel) {
      var validPanels = (hit.subfigures || []).map(function (s) { return (s.label || '').toUpperCase(); });
      var isRange = panel.indexOf('-') > 0;
      var ok;
      if (isRange) {
        var parts = panel.split('-');
        ok = parts.length === 2 &&
             validPanels.indexOf(parts[0].toUpperCase()) >= 0 &&
             validPanels.indexOf(parts[1].toUpperCase()) >= 0;
      } else {
        ok = validPanels.indexOf(panel.toUpperCase()) >= 0;
      }
      panelSuffix = ' (' + escapeHtmlForCE(panel) + ')';
      if (!ok) panelClass = ' pe-figref-chip-panel-unknown';
    }
    return '<span class="pe-figref-chip' + panelClass + '" contenteditable="false" data-src="' + escapeAttr(srcToken) +
           '" data-figref-label="' + escapeAttr(label) +
           '" data-figref-panel="' + escapeAttr(panel || '') +
           '" data-block-id="' + escapeAttr(hit.blockId) + '">Fig. ' + hit.num + panelSuffix + '</span>';
  }

  /* V3.120 — render a numbered-table reference chip. Same shape as
   * Eq./Fig. chips. Unknown labels render as a faded `[?Tab. label]`. */
  function renderTabRefChip(label) {
    var srcToken = '[!tab:' + label + ']';
    var hit = getNumberedTableByLabel(label);
    if (!hit) {
      return '<span class="pe-tabref-chip pe-tabref-chip-unknown" contenteditable="false" data-src="' + escapeAttr(srcToken) +
             '" data-tabref-label="' + escapeAttr(label) +
             '">[?Tab. ' + escapeHtmlForCE(label) + ']</span>';
    }
    return '<span class="pe-tabref-chip" contenteditable="false" data-src="' + escapeAttr(srcToken) +
           '" data-tabref-label="' + escapeAttr(label) +
           '" data-block-id="' + escapeAttr(hit.blockId) + '">Tab. ' + hit.num + '</span>';
  }

  function renderOneMath(src, displayMode, fallback) {
    try {
      return _katex.renderToString(src, {
        throwOnError: false,
        displayMode: !!displayMode,
        output: 'html',
        strict: 'ignore',
      });
    } catch (e) {
      // Mark as plain source on failure so the user sees the unparsed delimiter.
      return '<span class="pe-math-err" title="' + escapeAttr(e.message) + '">' +
             escapeHtmlForCE(fallback) + '</span>';
    }
  }

  function escapeHtmlChar(c) {
    if (c === '<') return '&lt;';
    if (c === '>') return '&gt;';
    if (c === '&') return '&amp;';
    if (c === '"') return '&quot;';
    if (c === '\n') return '<br>';
    return c;
  }
  function escapeHtmlForCE(s) {
    var out = '';
    for (var i = 0; i < s.length; i++) out += escapeHtmlChar(s[i]);
    return out;
  }
  function escapeAttr(s) {
    return String(s || '').replace(/"/g, '&quot;');
  }

  /* V3.159 — chip-mode HTML renderer for FOCUSED contenteditables.
   * Wraps every bracket-token ([@key], [!eqi:…], [!eqr:…], [!fig:…],
   * [!tab:…]) in an atomic contenteditable=false chip span stamped
   * with data-src so the serializer can round-trip back to source.
   * Everything else — including markdown source like **bold**, *italic*,
   * ~sub~, ^sup^, `code`, and $math$ — is left as escaped text so the
   * user can still type/edit those characters directly. Newlines
   * become <br> so line-break behavior matches the source. */
  function renderChipsOnlyHtml(text) {
    if (!text) return '';
    var out = '';
    var i = 0;
    while (i < text.length) {
      var ch = text[i];
      /* [@key] / [@k1; @k2] */
      if (ch === '[' && text[i + 1] === '@') {
        var endBracket = text.indexOf(']', i + 2);
        if (endBracket > i) {
          var inner = text.slice(i + 2, endBracket);
          if (/^[\w:.\-+/]+(\s*;\s*@[\w:.\-+/]+)*$/.test(inner)) {
            out += renderCitationChip(inner, i, endBracket + 1);
            i = endBracket + 1;
            continue;
          }
        }
      }
      /* [!eqi:…] */
      if (ch === '[' && text[i + 1] === '!' && text.slice(i + 2, i + 6) === 'eqi:') {
        var endEqi = text.indexOf(']', i + 6);
        if (endEqi > i + 6) {
          var eqiId = text.slice(i + 6, endEqi).trim();
          if (/^[\w:.\-]+$/.test(eqiId)) {
            out += renderInlineEqLibraryChip(eqiId);
            i = endEqi + 1;
            continue;
          }
        }
      }
      /* [!eqr:label] */
      if (ch === '[' && text[i + 1] === '!' && text.slice(i + 2, i + 6) === 'eqr:') {
        var endEqr = text.indexOf(']', i + 6);
        if (endEqr > i + 6) {
          var eqrLabel = text.slice(i + 6, endEqr).trim();
          if (/^[\w:.\-]+$/.test(eqrLabel)) {
            out += renderEqRefChip(eqrLabel);
            i = endEqr + 1;
            continue;
          }
        }
      }
      /* [!tab:label] */
      if (ch === '[' && text[i + 1] === '!' && text.slice(i + 2, i + 6) === 'tab:') {
        var endTab = text.indexOf(']', i + 6);
        if (endTab > i + 6) {
          var tabLabel = text.slice(i + 6, endTab).trim();
          if (/^[\w:.\-]+$/.test(tabLabel)) {
            out += renderTabRefChip(tabLabel);
            i = endTab + 1;
            continue;
          }
        }
      }
      /* [!fig:label[:panel]] */
      if (ch === '[' && text[i + 1] === '!' && text.slice(i + 2, i + 6) === 'fig:') {
        var endFig = text.indexOf(']', i + 6);
        if (endFig > i + 6) {
          var figInner = text.slice(i + 6, endFig).trim();
          var figMatch = /^([\w:.\-]+?)(?::([\w]+(?:-[\w]+)?))?$/.exec(figInner);
          if (figMatch) {
            out += renderFigRefChip(figMatch[1], figMatch[2] || null);
            i = endFig + 1;
            continue;
          }
        }
      }
      /* Everything else: pass through as escaped text. Markdown source
       * (**bold**, *italic*, ~sub~, ^sup^, `code`) and inline math
       * ($…$) stay as raw text so the user can edit them. */
      out += escapeHtmlChar(ch);
      i++;
    }
    return out;
  }

  /* V3.159 — read back source text from a chip-mode contenteditable.
   * Walks children: text nodes contribute their text; chip elements
   * (anything with a data-src attribute) contribute their data-src
   * (the original source token); <br> contributes '\n'; everything
   * else recurses for inner content. The serialized string MUST be
   * identical to what the user would see if the chip-mode renderer
   * were re-applied, so the binding's diff against lastValue produces
   * the correct Y.Text mutations. */
  function serializeChipDom(node) {
    if (!node) return '';
    if (node.nodeType === Node.TEXT_NODE) {
      return node.nodeValue || '';
    }
    if (node.nodeType !== Node.ELEMENT_NODE) return '';
    /* Atomic chip — its data-src is the canonical source token. */
    if (node.dataset && node.dataset.src) return node.dataset.src;
    if (node.tagName === 'BR') return '\n';
    /* Recurse for any other element (e.g. <span> wrappers Chrome
     * sometimes inserts around composed text). */
    var out = '';
    for (var i = 0; i < node.childNodes.length; i++) {
      out += serializeChipDom(node.childNodes[i]);
    }
    return out;
  }

  /* Render the source text into a contenteditable element using a callback.
   * If KaTeX hasn't loaded yet, shows plain text and re-renders once the
   * lazy import resolves.
   *
   * V3.216 — accepts an optional `onAfterRender` callback that fires
   * synchronously after each successful HTML render (and again once the
   * lazy KaTeX import resolves a fallback render). This is the hook
   * paper-blocks.js uses to wrap commented prose in highlight spans
   * after the binding has redone the innerHTML on focus/blur/observe. */
  function applyRendered(el, sourceText, renderFn, onAfterRender) {
    if (!sourceText) {
      el.textContent = '';
      el.dataset.empty = 'true';
      if (onAfterRender) try { onAfterRender(el); } catch (e) { console.error(e); }
      return;
    }
    el.dataset.empty = 'false';
    if (!_katex) {
      el.textContent = sourceText;
      if (onAfterRender) try { onAfterRender(el); } catch (e) { console.error(e); }
      ensureKatex().then(function () {
        if (document.activeElement !== el) {
          el.innerHTML = renderFn(sourceText);
          if (onAfterRender) try { onAfterRender(el); } catch (e) { console.error(e); }
        }
      }).catch(function () { /* leave plain */ });
      return;
    }
    el.innerHTML = renderFn(sourceText);
    if (onAfterRender) try { onAfterRender(el); } catch (e) { console.error(e); }
  }

  /* Render an entire equation source as one KaTeX block (display or inline). */
  function renderEquationHtml(text, displayMode) {
    if (!text) return '';
    if (!_katex) return escapeHtmlForCE(text);
    return renderOneMath(text, !!displayMode, text);
  }

  /* ── Y.Text bindings ── */

  /** Bind a Y.Text to a contenteditable element. Plain-text source under the
   * hood; when the element isn't focused, opts.renderHtml(text) → string is
   * called and the result is set as innerHTML. Click → revert to plain
   * source for editing → blur → re-render.
   *
   * opts.renderHtml defaults to renderParagraphHtml (math + citations). */
  function bindYTextToContentEditable(yText, el, opts) {
    opts = opts || {};
    var renderFn = opts.renderHtml || renderParagraphHtml;
    /* V3.216 — `onRendered(el)` fires after every full-HTML render
     * (initial bind, blur, remote update while unfocused, equation-
     * library refresh). Used by paper-blocks.js to overlay anchored
     * comment highlights on freshly rendered paragraph bodies. */
    var onRendered = opts.onRendered || null;
    function fireOnRendered() {
      if (!onRendered) return;
      try { onRendered(el); } catch (e) { console.error(e); }
    }
    el.contentEditable = opts.readOnly ? 'false' : 'true';
    el.spellcheck = true;
    var lastValue = yText.toString();
    if (document.activeElement === el) {
      el.textContent = lastValue;
      el.dataset.empty = lastValue ? 'false' : 'true';
    } else {
      applyRendered(el, lastValue, renderFn, fireOnRendered);
    }

    // Plain-text paste only.
    el.addEventListener('paste', function (e) {
      if (opts.readOnly) { e.preventDefault(); return; }
      e.preventDefault();
      var text = (e.clipboardData || window.clipboardData).getData('text/plain');
      document.execCommand('insertText', false, text);
    });

    el.addEventListener('focus', function () {
      /* V3.159 — show chip-mode HTML when focused so atomic
       * `[@cite]` / `[!eqi:…]` / `[!eqr:…]` / `[!fig:…]` / `[!tab:…]`
       * tokens render as their pretty chips even while editing. Source
       * is still tracked in `lastValue` (= yText.toString()); the
       * input handler reads source back via `serializeChipDom(el)`. */
      if (opts.readOnly) return;
      var src = yText.toString();
      el.innerHTML = renderChipsOnlyHtml(src);
      lastValue = src;
      el.dataset.empty = src ? 'false' : 'true';
      /* V3.218 — re-apply highlights on top of the chip-mode HTML so
       * commented spans stay visible while the user edits. */
      fireOnRendered();
    });

    /* V3.157 — click on a rendered citation group opens the popover
     * in edit mode pre-filled with the group's existing keys. We
     * intercept on `mousedown` capture phase so the contenteditable's
     * default click-to-focus behavior doesn't run (and thereby trigger
     * the focus handler that would swap the rendered chip back to
     * source text before we can read its data-cite-* attributes). */
    el.addEventListener('mousedown', function (ev) {
      if (opts.readOnly) return;
      var groupEl = ev.target && ev.target.closest && ev.target.closest('.pe-cite-group');
      if (!groupEl || !el.contains(groupEl)) return;
      if (groupEl.dataset.citeSrcStart == null) return;
      ev.preventDefault();
      ev.stopPropagation();
      _openCitationEditor(el, yText, groupEl);
    }, true);

    /* Track caret across blur so Cmd+K's citation popover can insert at the
     * right spot in the right element. The contenteditable loses native
     * selection on blur; we save the offset to a module-level var. */
    el.addEventListener('keyup',     function () { rememberFocus(el); });
    el.addEventListener('mouseup',   function () { rememberFocus(el); });
    el.addEventListener('input',     function () { rememberFocus(el); }, true);

    el.addEventListener('blur', function () {
      // Re-render on blur using the provided renderFn.
      var v = yText.toString();
      lastValue = v;
      applyRendered(el, v, renderFn, fireOnRendered);
    });

    el.addEventListener('input', function () {
      if (opts.readOnly) return;
      /* V3.159 — serialize via data-src so chips contribute their
       * original source token. `el.textContent` would return the
       * visible chip-label text (e.g. "Smith 2024" not "[@smith2024]"),
       * making the diff wrong. */
      var newVal = serializeChipDom(el);
      if (newVal === lastValue) return;
      var diff = textDiff(lastValue, newVal);
      lastValue = newVal;
      if (!diff) return;
      yText.doc.transact(function () {
        if (diff.removed > 0) yText.delete(diff.pos, diff.removed);
        if (diff.inserted) yText.insert(diff.pos, diff.inserted);
      }, 'local-input');
      el.dataset.empty = newVal ? 'false' : 'true';
      if (opts.onLocalChange) opts.onLocalChange();
    });

    var observer = function (event, transaction) {
      if (transaction.origin === 'local-input') return;
      var newVal = yText.toString();
      if (document.activeElement === el) {
        /* V3.159 — while focused with chip-mode rendering, remote
         * edits arriving via Yjs are rare in single-user editing.
         * Repaint chips to keep the visible state in sync with
         * remote source; caret position falls back to end-of-element
         * since we can't trivially preserve it across an innerHTML
         * swap with chip nodes. (Local typing never reaches this
         * branch — transaction.origin === 'local-input' returns
         * early above.) */
        if (newVal === lastValue) return;
        lastValue = newVal;
        el.innerHTML = renderChipsOnlyHtml(newVal);
        el.dataset.empty = newVal ? 'false' : 'true';
        fireOnRendered();
      } else {
        // Not focused — re-render via the provided renderFn (full
        // rendering with KaTeX, etc.).
        if (newVal === lastValue) return;
        lastValue = newVal;
        applyRendered(el, newVal, renderFn, fireOnRendered);
      }
      if (opts.onRemoteChange) opts.onRemoteChange();
    };
    yText.observe(observer);

    /* V3.109 — re-render the rendered HTML when the equation library
     * or document-order numbering changes, so [!eqi:] / [!eqr:] chips
     * stay in sync without requiring a focus blur on every binding.
     * Skipped while the element is focused (user is editing source). */
    var onEquationsChanged = function () {
      if (document.activeElement === el) return;
      var v = yText.toString();
      // Cheap optimization: only re-render if the source actually
      // contains an equation token. Saves work on prose without any.
      if (v.indexOf('[!eqi:') === -1 && v.indexOf('[!eqr:') === -1 && v.indexOf('[!fig:') === -1 && v.indexOf('[!tab:') === -1) return;
      applyRendered(el, v, renderFn, fireOnRendered);
    };
    window.addEventListener('paper-equations-changed', onEquationsChanged);

    return function unbind() {
      yText.unobserve(observer);
      window.removeEventListener('paper-equations-changed', onEquationsChanged);
    };
  }

  /** Bind a Y.Text to an <input type="text"> or <textarea>. */
  function bindYTextToInput(yText, el, opts) {
    opts = opts || {};
    el.disabled = !!opts.readOnly;
    var lastValue = yText.toString();
    el.value = lastValue;

    el.addEventListener('input', function () {
      if (opts.readOnly) return;
      var newVal = el.value;
      if (newVal === lastValue) return;
      var diff = textDiff(lastValue, newVal);
      lastValue = newVal;
      if (!diff) return;
      yText.doc.transact(function () {
        if (diff.removed > 0) yText.delete(diff.pos, diff.removed);
        if (diff.inserted) yText.insert(diff.pos, diff.inserted);
      }, 'local-input');
      if (opts.onLocalChange) opts.onLocalChange();
    });

    var observer = function (event, transaction) {
      if (transaction.origin === 'local-input') return;
      var newVal = yText.toString();
      if (newVal === lastValue && newVal === el.value) return;
      var caretStart = el.selectionStart, caretEnd = el.selectionEnd;
      if (caretStart != null) caretStart = applyDeltaToOffset(caretStart, event.delta);
      if (caretEnd   != null) caretEnd   = applyDeltaToOffset(caretEnd,   event.delta);
      el.value = newVal;
      lastValue = newVal;
      if (document.activeElement === el && caretStart != null) {
        try { el.setSelectionRange(caretStart, caretEnd != null ? caretEnd : caretStart); } catch (e) {}
      }
      if (opts.onRemoteChange) opts.onRemoteChange();
    };
    yText.observe(observer);
    return function unbind() { yText.unobserve(observer); };
  }

  /** Compute a minimal {pos, removed, inserted} diff between two strings. */
  function textDiff(oldStr, newStr) {
    var prefix = 0;
    var minLen = Math.min(oldStr.length, newStr.length);
    while (prefix < minLen && oldStr.charCodeAt(prefix) === newStr.charCodeAt(prefix)) prefix++;
    var suffix = 0;
    var maxSuffix = minLen - prefix;
    while (suffix < maxSuffix &&
           oldStr.charCodeAt(oldStr.length - 1 - suffix) === newStr.charCodeAt(newStr.length - 1 - suffix)) {
      suffix++;
    }
    var removed = oldStr.length - prefix - suffix;
    var inserted = newStr.slice(prefix, newStr.length - suffix);
    if (removed === 0 && !inserted) return null;
    return { pos: prefix, removed: removed, inserted: inserted };
  }

  /** Adjust a caret offset based on a Yjs delta (array of {retain,insert,delete}). */
  function applyDeltaToOffset(offset, delta) {
    var pos = 0;
    for (var i = 0; i < delta.length; i++) {
      var op = delta[i];
      if (op.retain != null) {
        pos += op.retain;
      } else if (op.insert != null) {
        var len = typeof op.insert === 'string' ? op.insert.length : 1;
        if (pos < offset) offset += len;
        pos += len;
      } else if (op.delete != null) {
        if (pos < offset) {
          offset = pos + Math.max(0, offset - pos - op.delete);
        }
      }
    }
    return offset;
  }

  /* V3.159 — chip-aware caret-offset helpers. The source-space char
   * offset must count chip `data-src.length` bytes (not the chip's
   * visible label text) so the saved offset round-trips correctly
   * when we restore the caret post-blur or post-rerender. */
  function readCaretCharOffset(el) {
    var sel = window.getSelection();
    if (!sel || !sel.rangeCount) return null;
    var range = sel.getRangeAt(0);
    if (!el.contains(range.endContainer)) return null;
    var target = range.endContainer;
    var targetOff = range.endOffset;
    var count = 0;
    var done = false;
    function visit(parent) {
      for (var i = 0; i < parent.childNodes.length; i++) {
        if (done) return;
        var node = parent.childNodes[i];
        /* When target === parent and i === targetOff, we've passed
         * the caret's parent-relative position. */
        if (node === target && target.nodeType === Node.TEXT_NODE) {
          count += targetOff;
          done = true;
          return;
        }
        if (parent === target && i === targetOff) {
          done = true;
          return;
        }
        if (node.nodeType === Node.TEXT_NODE) {
          count += node.length;
        } else if (node.nodeType === Node.ELEMENT_NODE) {
          if (node.dataset && node.dataset.src) {
            count += node.dataset.src.length;
          } else if (node.tagName === 'BR') {
            count += 1;
          } else {
            visit(node);
          }
        }
      }
      /* Caret is at end of `parent` (target === parent, targetOff === childCount). */
      if (parent === target && targetOff === parent.childNodes.length) {
        done = true;
      }
    }
    visit(el);
    return count;
  }
  function setCaretCharOffset(el, offset) {
    var sel = window.getSelection();
    var range = document.createRange();
    var found = false;
    var charCount = 0;
    function visit(parent) {
      for (var i = 0; i < parent.childNodes.length; i++) {
        if (found) return;
        var node = parent.childNodes[i];
        if (node.nodeType === Node.TEXT_NODE) {
          var next = charCount + node.length;
          if (offset >= charCount && offset <= next) {
            range.setStart(node, offset - charCount);
            range.collapse(true);
            found = true;
            return;
          }
          charCount = next;
        } else if (node.nodeType === Node.ELEMENT_NODE) {
          if (node.dataset && node.dataset.src) {
            var nextC = charCount + node.dataset.src.length;
            if (offset >= charCount && offset <= nextC) {
              range.setStart(parent, (offset === charCount) ? i : i + 1);
              range.collapse(true);
              found = true;
              return;
            }
            charCount = nextC;
          } else if (node.tagName === 'BR') {
            var nextB = charCount + 1;
            if (offset >= charCount && offset <= nextB) {
              range.setStart(parent, (offset === charCount) ? i : i + 1);
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
    sel.removeAllRanges();
    sel.addRange(range);
  }

  /* Expose the bindings + helpers to PaperBlocks for in-block use. */
  /* V3.107 — rich-text utilities. The paragraph block renders a small
   * toolbar above the body contenteditable; the toolbar's mousedown
   * handler calls these helpers to wrap the current selection in the
   * relevant markdown delimiters. Routes the insert through
   * `document.execCommand('insertText', ...)` so the contenteditable's
   * own input event fires and the existing Y.Text binding picks up the
   * diff — no special path. */
  function _findContenteditableAncestor(node) {
    var n = (node && node.nodeType === 1) ? node : (node && node.parentElement);
    while (n) {
      if (n.contentEditable === 'true' || n.isContentEditable) return n;
      n = n.parentElement;
    }
    return null;
  }

  function wrapSelectionInTokens(lhs, rhs) {
    rhs = (rhs == null) ? lhs : rhs;
    var sel = window.getSelection();
    if (!sel || !sel.rangeCount) return false;
    var range = sel.getRangeAt(0);
    var ce = _findContenteditableAncestor(range.startContainer);
    if (!ce) return false;
    var selText = sel.toString();
    var hadSelection = selText.length > 0;
    var replacement = hadSelection ? (lhs + selText + rhs) : (lhs + rhs);
    var ok = false;
    try {
      ok = document.execCommand('insertText', false, replacement);
    } catch (e) { ok = false; }
    if (!ok) {
      // Fallback: replace via Range API and dispatch input.
      try {
        range.deleteContents();
        range.insertNode(document.createTextNode(replacement));
        ce.dispatchEvent(new InputEvent('input', { bubbles: true }));
      } catch (e2) { return false; }
    }
    // If empty original selection, move caret back by rhs.length so user
    // can type inside the tokens immediately.
    if (!hadSelection) {
      try {
        var s2 = window.getSelection();
        if (s2 && s2.rangeCount) {
          var r2 = s2.getRangeAt(0);
          var startNode = r2.startContainer;
          var startOffset = r2.startOffset;
          if (startNode.nodeType === 3 && startOffset >= rhs.length) {
            r2.setStart(startNode, startOffset - rhs.length);
            r2.setEnd(startNode, startOffset - rhs.length);
            s2.removeAllRanges();
            s2.addRange(r2);
          }
        }
      } catch (e3) { /* caret reposition is best-effort */ }
    }
    return true;
  }

  /* Map Cmd/Ctrl+B/I/E to the corresponding markdown wrap. Returns true
   * when the event was consumed so callers can short-circuit other
   * handling. Doesn't fire on Shift/Alt to leave room for native browser
   * shortcuts (e.g. Cmd+Shift+I devtools). */
  function richTextKeydownHandler(e) {
    if (!(e.metaKey || e.ctrlKey)) return false;
    if (e.shiftKey || e.altKey) return false;
    var key = (e.key || '').toLowerCase();
    if (key === 'b') { e.preventDefault(); return wrapSelectionInTokens('**'); }
    if (key === 'i') { e.preventDefault(); return wrapSelectionInTokens('*'); }
    if (key === 'e') { e.preventDefault(); return wrapSelectionInTokens('`'); }
    return false;
  }

  /* V3.109 — equation library / numbering helpers. Both walkers read
   * directly from state.paperMap (the active Yjs paper map). They're
   * called from renderParagraphHtml (token expansion), from the
   * equation block renderer (number badge), and from the equations
   * panel UI. The cost is small per call (O(numEquations) for each)
   * and we don't bother caching — Y.Map subscribers in the consuming
   * UIs already debounce re-renders. */
  function getInlineEquationLibrary() {
    if (!state.paperMap) return [];
    var lib = state.paperMap.get('equation_library');
    if (!lib || typeof lib.forEach !== 'function') return [];
    var out = [];
    lib.forEach(function (entry) {
      if (!entry || typeof entry.get !== 'function') return;
      var nameY = entry.get('name');
      var latexY = entry.get('latex');
      // V3.124 — type defaults to 'inline' for legacy V3.109 entries
      // that predate the type field.
      var type = entry.get('type');
      out.push({
        id: entry.get('id') || '',
        name: (nameY && nameY.toString) ? nameY.toString() : String(nameY || ''),
        latex: (latexY && latexY.toString) ? latexY.toString() : String(latexY || ''),
        type: type === 'main' ? 'main' : 'inline',
      });
    });
    return out;
  }

  /* V3.144 — accepts either the raw id (legacy `[!eqi:eq-abc123]`) or
   * a slugified name (new `[!eqi:hookes-law]`). Tries id first, then
   * walks library entries looking for an entry whose slugified name
   * matches. Slug rule mirrors paper-equations.js's `_eqiSlugFromEntry`:
   * lowercase, non-`[a-z0-9_-]` → `-`, strip leading/trailing dashes,
   * cap at 60 chars. */
  function _slugifyEqName(name) {
    var s = (name || '').toLowerCase()
      .replace(/[^a-z0-9_-]+/g, '-')
      .replace(/^-+|-+$/g, '')
      .slice(0, 60);
    return s;
  }
  function getInlineEquationById(idOrName) {
    if (!idOrName || !state.paperMap) return null;
    var lib = state.paperMap.get('equation_library');
    if (!lib || typeof lib.forEach !== 'function') return null;
    var hit = null;
    /* Pass 1: id match (legacy + still produced when name is empty). */
    lib.forEach(function (entry) {
      if (hit) return;
      if (entry && typeof entry.get === 'function' && entry.get('id') === idOrName) {
        hit = entry;
      }
    });
    /* Pass 2: slugified name match. */
    if (!hit) {
      lib.forEach(function (entry) {
        if (hit) return;
        if (!entry || typeof entry.get !== 'function') return;
        var nm = entry.get('name');
        var s = (nm && nm.toString) ? nm.toString() : String(nm || '');
        if (s && _slugifyEqName(s) === idOrName) hit = entry;
      });
    }
    if (!hit) return null;
    var nameY = hit.get('name');
    var latexY = hit.get('latex');
    return {
      id: hit.get('id'),
      name: (nameY && nameY.toString) ? nameY.toString() : String(nameY || ''),
      latex: (latexY && latexY.toString) ? latexY.toString() : String(latexY || ''),
      _yMap: hit,
    };
  }

  /* Doc-order traversal of all equation blocks where attrs.numbered=true
   * AND attrs.display=true. Returns one entry per numbered equation:
   *   { blockId, label, num, latex }
   * Numbers are 1-based. label defaults to 'eq:<blockId>' when
   * attrs.label is unset, so the LaTeX export still compiles. */
  function getNumberedEquations() {
    if (!state.paperMap) return [];
    var sections = state.paperMap.get('sections');
    if (!sections || typeof sections.forEach !== 'function') return [];
    var out = [];
    sections.forEach(function (secMap) {
      var children = secMap && secMap.get && secMap.get('children');
      if (!children || typeof children.forEach !== 'function') return;
      children.forEach(function (blk) {
        if (!blk || typeof blk.get !== 'function') return;
        if (blk.get('kind') !== 'equation') return;
        var attrs = blk.get('attrs');
        if (!attrs || typeof attrs.get !== 'function') return;
        if (!attrs.get('numbered')) return;
        if (!attrs.get('display')) return;
        var blockId = blk.get('id');
        var bodyY = blk.get('body');
        out.push({
          blockId: blockId,
          label: attrs.get('label') || ('eq:' + blockId),
          num: out.length + 1,
          latex: (bodyY && bodyY.toString) ? bodyY.toString() : String(bodyY || ''),
        });
      });
    });
    return out;
  }

  function getNumberedEquationByLabel(label) {
    if (!label) return null;
    var all = getNumberedEquations();
    for (var i = 0; i < all.length; i++) {
      if (all[i].label === label) return all[i];
    }
    return null;
  }

  /* V3.115 — figure walkers. Doc-order traversal of `sections → children`
   * filtered to `kind === 'figure'`. Returns plain JS projections so
   * the caller can read without holding Y refs.
   *
   * getAllFigures() — every figure block in the doc, with `numbered`
   *                  reflecting attrs.numbered and `num` populated only
   *                  when numbered=true (1-based across numbered ones in
   *                  doc order).
   * getNumberedFigures() — filter to `numbered !== false` AND assign
   *                  sequential numbers. Used for [!fig:label] resolution.
   * getNumberedFigureByLabel(label) — lookup by label across numbered figs.
   */
  function getAllFigures() {
    if (!state.paperMap) return [];
    var sections = state.paperMap.get('sections');
    if (!sections || typeof sections.forEach !== 'function') return [];
    var out = [];
    var numCounter = 0;
    sections.forEach(function (secMap) {
      var children = secMap && secMap.get && secMap.get('children');
      if (!children || typeof children.forEach !== 'function') return;
      children.forEach(function (blk) {
        if (!blk || typeof blk.get !== 'function') return;
        if (blk.get('kind') !== 'figure') return;
        var attrs = blk.get('attrs');
        if (!attrs || typeof attrs.get !== 'function') return;
        var blockId = blk.get('id');
        var numbered = attrs.get('numbered') !== false;  // default true
        var num = numbered ? (++numCounter) : null;
        var bodyY = blk.get('body');
        var captionPreview = (bodyY && bodyY.toString) ? bodyY.toString() : '';
        // Trim to first line for the panel preview.
        var firstNewline = captionPreview.indexOf('\n');
        if (firstNewline >= 0) captionPreview = captionPreview.slice(0, firstNewline);
        var subfigures = [];
        var sf = attrs.get('subfigures');
        if (sf && typeof sf.forEach === 'function') {
          sf.forEach(function (m) {
            if (!m || typeof m.get !== 'function') return;
            subfigures.push({
              id: m.get('id') || '',
              label: m.get('label') || '',
            });
          });
        }
        out.push({
          blockId: blockId,
          label: attrs.get('label') || '',
          numbered: numbered,
          num: num,
          captionPreview: captionPreview,
          downloadUrl: attrs.get('download_url') || '',
          alt: attrs.get('alt') || '',
          subfigures: subfigures,
        });
      });
    });
    return out;
  }

  function getNumberedFigures() {
    return getAllFigures().filter(function (f) { return f.numbered === true; });
  }

  function getNumberedFigureByLabel(label) {
    if (!label) return null;
    var all = getNumberedFigures();
    for (var i = 0; i < all.length; i++) {
      if (all[i].label === label) return all[i];
    }
    return null;
  }

  /* V3.120 — table walkers. Same shape as figures but no subfigures.
   * Each entry: {blockId, label, num, captionPreview, rows, cols,
   *              booktabs, header_row}. */
  function getAllTables() {
    if (!state.paperMap) return [];
    var sections = state.paperMap.get('sections');
    if (!sections || typeof sections.forEach !== 'function') return [];
    var out = [];
    var numCounter = 0;
    sections.forEach(function (secMap) {
      var children = secMap && secMap.get && secMap.get('children');
      if (!children || typeof children.forEach !== 'function') return;
      children.forEach(function (blk) {
        if (!blk || typeof blk.get !== 'function') return;
        if (blk.get('kind') !== 'table') return;
        var attrs = blk.get('attrs');
        if (!attrs || typeof attrs.get !== 'function') return;
        var blockId = blk.get('id');
        var numbered = attrs.get('numbered') !== false;
        var num = numbered ? (++numCounter) : null;
        var captionY = attrs.get('caption');
        var captionPreview = '';
        if (captionY && captionY.toString) {
          captionPreview = captionY.toString();
          var firstNewline = captionPreview.indexOf('\n');
          if (firstNewline >= 0) captionPreview = captionPreview.slice(0, firstNewline);
        } else if (typeof captionY === 'string') {
          captionPreview = captionY;
        }
        out.push({
          blockId: blockId,
          label: attrs.get('label') || '',
          numbered: numbered,
          num: num,
          captionPreview: captionPreview,
          rows: attrs.get('rows') || 0,
          cols: attrs.get('cols') || 0,
          booktabs: attrs.get('booktabs') !== false,
          header_row: attrs.get('header_row') !== false,
        });
      });
    });
    return out;
  }

  function getNumberedTables() {
    return getAllTables().filter(function (t) { return t.numbered === true; });
  }

  function getNumberedTableByLabel(label) {
    if (!label) return null;
    var all = getNumberedTables();
    for (var i = 0; i < all.length; i++) {
      if (all[i].label === label) return all[i];
    }
    return null;
  }

  /* V3.122 — collect every Pandoc-style [@key] citation in the document.
   * Walks: paragraph bodies, paragraph skeleton bullet text, figure block
   * bodies (captions), table block attrs.caption Y.Text. Returns a unique
   * sorted array of citation keys. */
  function getCitedKeysInPaper() {
    if (!state.paperMap) return [];
    var sections = state.paperMap.get('sections');
    if (!sections || typeof sections.forEach !== 'function') return [];
    var keys = Object.create(null);

    function scanText(text) {
      if (!text) return;
      var re = /\[@([^\]\n]+)\]/g;
      var m;
      while ((m = re.exec(text))) {
        m[1].split(/\s*;\s*@?/).forEach(function (k) {
          k = (k || '').trim();
          if (k && /^[\w:.\-+/]+$/.test(k)) keys[k] = true;
        });
      }
    }
    function yTextStr(y) {
      if (!y) return '';
      if (typeof y === 'string') return y;
      if (typeof y.toString === 'function') return y.toString();
      return '';
    }

    sections.forEach(function (secMap) {
      var children = secMap && secMap.get && secMap.get('children');
      if (!children || typeof children.forEach !== 'function') return;
      children.forEach(function (blk) {
        if (!blk || typeof blk.get !== 'function') return;
        var kind = blk.get('kind');
        // body holds the prose for paragraphs / figure captions.
        if (kind === 'paragraph' || kind === 'figure') {
          scanText(yTextStr(blk.get('body')));
        }
        // V3.115 — skeleton bullets carry their own text Y.Texts.
        if (kind === 'paragraph') {
          var skItems = blk.get('skeleton_items');
          if (skItems && typeof skItems.forEach === 'function') {
            skItems.forEach(function (it) {
              if (it && typeof it.get === 'function') {
                scanText(yTextStr(it.get('text')));
              }
            });
          }
          // Legacy skeleton Y.Text fallback.
          var legacy = blk.get('skeleton');
          if (legacy) scanText(yTextStr(legacy));
        }
        // V3.120 — table caption is now a Y.Text inside attrs.
        if (kind === 'table') {
          var attrs = blk.get('attrs');
          if (attrs && typeof attrs.get === 'function') {
            scanText(yTextStr(attrs.get('caption')));
          }
        }
      });
    });

    var arr = Object.keys(keys);
    arr.sort();
    return arr;
  }

  window.PaperEditor = {
    bindYTextToContentEditable: bindYTextToContentEditable,
    bindYTextToInput: bindYTextToInput,
    textDiff: textDiff,
    renderParagraphHtml: renderParagraphHtml,
    /* V3.159 — chip-mode renderer for focused contenteditables.
     * Used by paper-equations.js's picker-insertion path so a freshly
     * picked citation/equation/figure/table chip appears in the
     * paragraph immediately as an atomic span (rather than as raw
     * `[@key]` text the user would see for a frame before the next
     * render cycle). */
    renderChipsOnlyHtml: renderChipsOnlyHtml,
    serializeChipDom: serializeChipDom,
    renderEquationHtml: renderEquationHtml,
    openCitationPopover: openCitationPopover,
    wrapSelectionInTokens: wrapSelectionInTokens,
    richTextKeydownHandler: richTextKeydownHandler,
    /* V3.109 — equation library / numbering. */
    getInlineEquationLibrary: getInlineEquationLibrary,
    getInlineEquationById: getInlineEquationById,
    getNumberedEquations: getNumberedEquations,
    getNumberedEquationByLabel: getNumberedEquationByLabel,
    /* V3.115 — figure walkers. */
    getAllFigures: getAllFigures,
    getNumberedFigures: getNumberedFigures,
    getNumberedFigureByLabel: getNumberedFigureByLabel,
    /* V3.120 — table walkers. */
    getAllTables: getAllTables,
    getNumberedTables: getNumberedTables,
    getNumberedTableByLabel: getNumberedTableByLabel,
    /* V3.122 — references tab helpers. */
    getCitedKeysInPaper: getCitedKeysInPaper,
    loadCitationIndex: loadCitationIndex,
    invalidateCitationIndex: invalidateCitationIndex,
    insertCitationAtFocus: insertCitationAtFocus,
    insertCitationKeysAtFocus: insertCitationKeysAtFocus,
    /* V3.124 — equation block creation from the panel. */
    addEquationToSection: addEquation,
    /* V3.125 — block reorder + position-aware insertion. */
    moveBlockUp: moveBlockUp,
    moveBlockDown: moveBlockDown,
    moveBlockBefore: moveBlockBefore,
    insertBlockAt: insertBlockAt,
    deleteBlockAt: deleteBlock,
    /* V3.132 — unplaced figure / table libraries (panel-first authoring,
     * doc-side picker placement). */
    getUnplacedFigures: getUnplacedFigures,
    getUnplacedTables: getUnplacedTables,
    getUnplacedFiguresArr: getUnplacedFiguresArr,
    getUnplacedTablesArr: getUnplacedTablesArr,
    findUnplacedYMap: findUnplacedYMap,
    createUnplacedFigure: createUnplacedFigure,
    createUnplacedTable: createUnplacedTable,
    deleteUnplaced: deleteUnplaced,
    placeUnplacedAt: placeUnplacedAt,
    unplaceBlock: unplaceBlock,
    moveBlockToPosition: moveBlockToPosition,
    /* Read-only accessor for the cached citation index. References tab
     * reads this; the editor's internal `state.citationByKey` stays
     * private. */
    getCitationByKey: function () { return state.citationByKey || null; },
    /* V3.137 — expose the last-focused contenteditable + caret offset
     * so paper-equations.js's toolbar buttons can fall back when their
     * own mousedown caret-save misses (e.g. user clicks the toolbar
     * button without first having clicked into a paragraph). The
     * PaperEditor tracker is robust — it's updated on keyup/mouseup/
     * input on every contenteditable bound through bindYTextToContentEditable. */
    getLastFocusedEditable: function () { return lastFocusedEditable; },
    getLastFocusedCaret: function () { return lastFocusedCaret; },
    getCitationList: function () { return state.citationList || []; },
    /* Expose state.paperMap for paper-equations.js — a tiny accessor
     * keeps that module from poking into the editor's private state. */
    getPaperMap: function () { return state.paperMap; },
    getY: function () { return state.Y; },
    isEditable: function () { return !!state.editable; },
    getPaperId: function () { return state.paperId; },
  };

  /* ── Misc ── */

  function escapeHtml(s) {
    return String(s || '').replace(/[&<>"']/g, function (c) {
      return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c];
    });
  }

  /* ── Global keybinds ── */

  document.addEventListener('keydown', function (e) {
    // Cmd+K / Ctrl+K → citation popover, anchored under the toolbar
    // `+ Cite` button so the picker has a consistent screen position
    // regardless of which paragraph the caret is in. Falls back to
    // lastFocusedEditable on pages where the toolbar isn't mounted.
    var meta = e.metaKey || e.ctrlKey;
    if (meta && (e.key === 'k' || e.key === 'K')) {
      if (!state.editable) return;
      e.preventDefault();
      /* V3.157 — Cmd+K uses the multi-pick popover so the user can
       * pick several citations at once + commit. Single-pick still
       * works (pick one row, then click "Insert" or hit
       * Cmd/Ctrl+Enter).
       * V3.158 — anchor under the toolbar `+ Cite` button (id
       * `pe-gt-cite`, stamped by paper-equations.js). The popover then
       * appears in the same screen position whether the user opens it
       * via Cmd+K, the toolbar, or any future surface that opens the
       * citation picker. Falls back to lastFocusedEditable when the
       * toolbar isn't on the page. */
      var citeBtn = document.getElementById('pe-gt-cite');
      openCitationPopover({
        anchorEl: citeBtn || lastFocusedEditable,
        /* V3.192 — pass the source paragraph so the popover can
         * surface its claims + linked highlights. */
        paragraphEl: lastFocusedEditable,
        onPickKeys: function (keys) { insertCitationKeysAtFocus(keys); },
      });
    }
  });

  // Re-render visible paragraphs once the citation index loads, so chips
  // get their author/year tooltip + label.
  window.addEventListener('paper-citations-loaded', function () {
    document.querySelectorAll('.pe-block-content[data-kind="paragraph-body"]').forEach(function () {
      // The Y.Text observers are the cleanest way; just dispatch a no-op
      // event the binding recognises.
    });
    // Simpler: trigger render() if no paragraph is focused.
    if (document.activeElement && document.activeElement.classList &&
        document.activeElement.classList.contains('pe-block-content')) {
      return;
    }
    if (state.sectionsArr) render();
  });

  /* ── V3.235 — Mobile side drawers ──
   * Wires the left toggle (☰ Outline) and right toggle (💬 Comments)
   * to the reusable .rm-mobile-drawer-host pattern. The right toggle
   * also ensures the comments pane is unhidden so the drawer has
   * content; defaults the filter to "view" so the drawer shows
   * paragraphs-in-view comments even when no block is focused. */
  function _wireMobileDrawers() {
    if (!window.MOBILE_DRAWERS) return;
    var host = document.querySelector('.pe-page.rm-mobile-drawer-host');
    if (!host) return;
    var leftBtn  = document.getElementById('pe-mobile-left-toggle');
    var rightBtn = document.getElementById('pe-mobile-right-toggle');
    window.MOBILE_DRAWERS.init(host, {
      leftToggle:  leftBtn,
      rightToggle: rightBtn,
      onOpen: function (side) {
        if (side !== 'right') return;
        ensureCommentsRefs();
        if (!commentsPaneEl) return;
        if (commentsPaneEl.hidden) {
          /* Default to view-mode so the drawer is never empty —
           * matches the V3.210 filter persistence behavior. */
          if (!commentsState.activeBlockId) commentsState.filter = 'view';
          if (commentsFilterEl) commentsFilterEl.value = commentsState.filter;
          commentsPaneEl.hidden = false;
          try { renderCommentsList(); } catch (e) {}
        }
      },
    });
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', _wireMobileDrawers);
  } else {
    _wireMobileDrawers();
  }

  /* ── Cleanup on unload ── */

  window.addEventListener('beforeunload', function () {
    if (state.conn) {
      try { state.conn.disconnect(); } catch (e) {}
    }
  });
})();
