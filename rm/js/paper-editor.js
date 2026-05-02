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

  var paramId = new URLSearchParams(window.location.search).get('id') || '';
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
    try {
      legacy = await firebridge.getDoc('papers/' + state.paperId + '/draft', 'tree');
    } catch (err) {
      console.warn('[paper-editor] legacy Firestore read failed:', err.message);
    }

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
   * .get() once their parent is integrated into a Y.Doc. */
  function appendSectionFromTree(sectionsArr, sec) {
    var Y = state.Y;
    var m = new Y.Map();
    sectionsArr.push([m]);
    m.set('id', sec.id || window.PaperSchemas.shortId('sec-'));
    m.set('kind', sec.kind || 'custom');
    m.set('label', new Y.Text(''));
    if (sec.label) m.get('label').insert(0, String(sec.label));
    m.set('order', typeof sec.order === 'number' ? sec.order : 0);
    m.set('status', sec.status || 'draft');
    m.set('children', new Y.Array());
    var children = m.get('children');
    (sec.children || []).forEach(function (blk) {
      appendBlockFromTree(children, blk);
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
    m.set('skeleton', new Y.Text(''));
    if (blk.skeleton) m.get('skeleton').insert(0, String(blk.skeleton));
    m.set('body', new Y.Text(''));
    if (blk.body) m.get('body').insert(0, String(blk.body));
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
      editable: state.editable,
      viewFilter: state.viewFilter,
      onDelete: function (blockId) { deleteBlock(secId, blockId); },
      onFocusBlock: function (blockId) {
        if (state.conn) state.conn.setFocusBlock(blockId);
      },
      registerSubscription: function (yMap, unobserve) {
        state.blockSubscriptions.push({ yMap: yMap, unobserve: unobserve });
      },
      getPresenceForBlock: function (blockId) {
        return state.presenceList.filter(function (p) {
          return !p.isSelf && p.focusBlockId === blockId;
        });
      },
      requestRender: render,
    };
    var childrenArr = secMap.get('children');
    var sf = state.statusFilter;
    var hiddenCount = 0;
    childrenArr.forEach(function (blockMap) {
      var s = blockMap.get('status') || 'draft';
      var keep = (sf === 'all') ||
                 (sf === 'not-complete' && s !== 'complete') ||
                 (sf === s);
      if (!keep) { hiddenCount++; return; }
      wrap.appendChild(window.PaperBlocks.renderYBlock(blockMap, ctx));
    });
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

    /* Add-block buttons */
    if (state.editable) {
      var addRow = document.createElement('div');
      addRow.className = 'pe-add-block-row';
      var addP = document.createElement('button');
      addP.type = 'button';
      addP.className = 'pe-add-block';
      addP.textContent = '+ Paragraph';
      addP.addEventListener('click', function () { addParagraph(secId); });
      addRow.appendChild(addP);
      var addEq = document.createElement('button');
      addEq.type = 'button';
      addEq.className = 'pe-add-block';
      addEq.textContent = '+ Equation';
      addEq.addEventListener('click', function () { addEquation(secId); });
      addRow.appendChild(addEq);
      // Phase C: inventory quick-insert in Methods sections.
      if (secMap.get('kind') === 'methods') {
        var addInv = document.createElement('button');
        addInv.type = 'button';
        addInv.className = 'pe-add-block';
        addInv.textContent = '+ Reagent / equipment';
        addInv.addEventListener('click', function () { openInventoryDialog(secId); });
        addRow.appendChild(addInv);
      }
      var addTbl = document.createElement('button');
      addTbl.type = 'button';
      addTbl.className = 'pe-add-block';
      addTbl.textContent = '+ Table';
      addTbl.addEventListener('click', function () { addTable(secId); });
      addRow.appendChild(addTbl);
      wrap.appendChild(addRow);
    }

    return wrap;
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

  function addEquation(sectionId) {
    var hit = findSection(sectionId);
    if (!hit) return;
    var Y = state.Y;
    state.conn.yDoc.transact(function () {
      // Attach-then-mutate pattern (see appendSectionFromTree).
      var children = hit.map.get('children');
      var m = new Y.Map();
      children.push([m]);
      m.set('id', window.PaperSchemas.shortId('p-'));
      m.set('kind', 'equation');
      m.set('status', 'draft');
      m.set('skeleton', new Y.Text(''));
      m.set('body', new Y.Text(''));
      m.set('attrs', new Y.Map());
      m.get('attrs').set('display', true);
    }, 'add-equation');
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
    /* Export to LaTeX — visible to anyone who can edit the paper. Phase F1
     * supports the MEBP-journal template; future templates land in
     * data/paper-templates/. */
    if (state.editable && !exportBtnEl) {
      exportBtnEl = document.createElement('button');
      exportBtnEl.type = 'button';
      exportBtnEl.className = 'btn pe-invite-btn';
      exportBtnEl.textContent = 'Export LaTeX';
      exportBtnEl.title = 'Generate .tex + .bib files into the paper\'s sibling repo';
      exportBtnEl.addEventListener('click', openExportDialog);
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
    try {
      var data = await api.load('inventory/items.json');
      var items = (data && data.items) || [];
      inventoryState.list = items.map(function (it) {
        return {
          id: it.id,
          name: it.name || '',
          vendor: it.vendor || '',
          cat: it.catalogue_number || '',
          desc: it.description || '',
          category: it.category || '',
          subcategory: it.subcategory || '',
          search: ((it.name || '') + ' ' + (it.vendor || '') + ' ' +
                   (it.catalogue_number || '') + ' ' + (it.description || '') + ' ' +
                   (it.category || '') + ' ' + (it.subcategory || '')).toLowerCase(),
        };
      });
      return inventoryState.list;
    } catch (err) {
      console.warn('[paper-editor] inventory load failed:', err.message);
      inventoryState.list = [];
      return inventoryState.list;
    }
  }

  async function openInventoryDialog(sectionId) {
    if (!state.editable) return;
    await ensureInventoryList();
    var pop = ensureInventoryPopover();
    pop._setSectionId(sectionId);
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
    pop.style.left = '50%';
    pop.style.top  = '120px';
    pop.style.transform = 'translateX(-50%)';
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
        row.innerHTML =
          '<div class="pe-cite-pop-key">' + escapeHtmlForCE(e.name || '(no name)') + '</div>' +
          '<div class="pe-cite-pop-meta">' +
            escapeHtmlForCE(e.vendor || '') +
            (e.cat ? ' · cat. ' + escapeHtmlForCE(e.cat) : '') +
            (e.category ? ' · ' + escapeHtmlForCE(e.category) : '') +
            (e.subcategory ? ' / ' + escapeHtmlForCE(e.subcategory) : '') +
          '</div>' +
          (e.desc ? '<div class="pe-cite-pop-title-line">' + escapeHtmlForCE(e.desc.slice(0, 140)) + '</div>' : '');
        row.addEventListener('mouseenter', function () { activeIdx = i; renderList(); });
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
    var bodyText = item.name + ' (' + item.vendor +
                   (item.cat ? ', cat. ' + item.cat : '') + ')' +
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
  };
  var commentsPaneEl   = null;
  var commentsListEl   = null;
  var commentsInputEl  = null;
  var commentsCloseEl  = null;
  var commentsSubmitEl = null;
  var commentsCtxEl    = null;

  function ensureCommentsRefs() {
    commentsPaneEl   = document.getElementById('pe-comments-pane');
    commentsListEl   = document.getElementById('pe-comments-list');
    commentsInputEl  = document.getElementById('pe-comments-input');
    commentsCloseEl  = document.getElementById('pe-comments-close');
    commentsSubmitEl = document.getElementById('pe-comments-submit');
    commentsCtxEl    = document.getElementById('pe-comments-context');
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
        if (commentsState.activeBlockId) renderCommentsList();
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
  }

  function recomputeCommentCounts() {
    var c = Object.create(null);
    commentsState.docs.forEach(function (d) {
      if (d.resolved) return;
      c[d.blockId] = (c[d.blockId] || 0) + 1;
    });
    commentsState.countsByBlock = c;
  }

  function openCommentsForBlock(blockId, blockLabel) {
    ensureCommentsRefs();
    commentsState.activeBlockId = blockId;
    commentsCtxEl.textContent = blockLabel || ('Block ' + blockId.slice(0, 8));
    commentsPaneEl.hidden = false;
    renderCommentsList();
    commentsInputEl.value = '';
    commentsInputEl.focus();
  }
  function closeComments() {
    commentsState.activeBlockId = null;
    if (commentsPaneEl) commentsPaneEl.hidden = true;
  }

  function renderCommentsList() {
    if (!commentsState.activeBlockId) return;
    var list = commentsState.docs.filter(function (c) { return c.blockId === commentsState.activeBlockId; });
    commentsListEl.innerHTML = '';
    if (!list.length) {
      commentsListEl.innerHTML = '<div class="pe-comments-empty">No comments yet — be the first.</div>';
      return;
    }
    list.forEach(function (c) {
      var div = document.createElement('div');
      div.className = 'pe-comment' + (c.resolved ? ' pe-comment-resolved' : '');
      var when = '';
      if (c.createdAt && c.createdAt.toDate) {
        when = c.createdAt.toDate().toISOString().slice(0, 16).replace('T', ' ');
      }
      div.innerHTML =
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
      commentsListEl.appendChild(div);
    });
    commentsListEl.scrollTop = commentsListEl.scrollHeight;
  }

  async function submitComment() {
    if (!commentsState.activeBlockId) return;
    var body = (commentsInputEl.value || '').trim();
    if (!body) return;
    var user = firebridge.getUser();
    var profile = firebridge.getProfile();
    try {
      await firebridge.db().collection('papers').doc(state.paperId)
        .collection('comments').add({
          blockId: commentsState.activeBlockId,
          body: body,
          authorUid: user.uid,
          authorName: (profile && profile.name) || user.email || user.uid,
          createdAt: firebase.firestore.FieldValue.serverTimestamp(),
          modifiedAt: firebase.firestore.FieldValue.serverTimestamp(),
          resolved: false,
        });
      commentsInputEl.value = '';
    } catch (err) {
      alert('Failed to post comment: ' + err.message);
    }
  }

  /* Public surface for paper-blocks.js — chip badge + open thread. */
  window.PaperComments = {
    countFor: function (blockId) { return commentsState.countsByBlock[blockId] || 0; },
    open: openCommentsForBlock,
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

  /* ── LaTeX export dialog (Phase F1) ── */
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

  async function openInviteDialog() {
    var coAuthors = (state.meta.coauthor_emails || []).slice();
    var pending = coAuthors.length ? '\n\nCurrent coauthors:\n  ' + coAuthors.join('\n  ') : '';
    var email = window.prompt('Add a coauthor by email (or leave blank to cancel):' + pending, '');
    if (!email) return;
    email = email.trim().toLowerCase();
    if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) {
      alert('That does not look like a valid email.');
      return;
    }
    if (state.meta.coauthor_emails && state.meta.coauthor_emails.indexOf(email) >= 0) {
      alert(email + ' is already listed.');
      return;
    }
    try {
      // Look up uid in users collection.
      var users = await firebridge.queryWhere('users', 'email', '==', email);
      var uid = users && users[0] && users[0].id ? users[0].id : '';
      // Update papers.json.
      var data = await api.load('projects/papers.json');
      var rows = (data && data.papers) || [];
      var row = rows.find(function (p) { return p.id === state.paperId; });
      if (!row) throw new Error('Paper row missing');
      row.coauthor_emails = row.coauthor_emails || [];
      row.coauthor_uids = row.coauthor_uids || [];
      row.coauthor_emails.push(email);
      if (uid && row.coauthor_uids.indexOf(uid) < 0) row.coauthor_uids.push(uid);
      // Keep PMR's members[]/member_uids[] in sync with the legacy
      // lead_author_uid+coauthor_uids fields. PMR queries member_uids via
      // Firestore array-contains; without this stamp, newly invited
      // coauthors would be invisible to the per-student rollup.
      syncPaperMembers(row);
      await api.save('projects/papers.json', { papers: rows });
      state.meta = row;
      alert(uid
        ? 'Added ' + email + ' (uid resolved). They have edit access immediately.'
        : 'Added ' + email + ' (pending). They\'ll get edit access on their first sign-in (Firestore rules + auth callback resolution required).');
    } catch (err) {
      alert('Failed to add coauthor: ' + err.message);
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
  var citationPopoverState = { onPick: null, anchorEl: null };

  function rememberFocus(el) {
    lastFocusedEditable = el;
    lastFocusedCaret = readCaretCharOffset(el) || 0;
  }

  function ensureCitationPopover() {
    if (citationPopoverEl) return citationPopoverEl;
    var pop = document.createElement('div');
    pop.className = 'pe-cite-popover';
    pop.hidden = true;
    pop.innerHTML =
      '<div class="pe-cite-pop-title">Insert citation</div>' +
      '<input type="text" class="pe-cite-pop-search" placeholder="Search by key, author, year, or title…" autocomplete="off">' +
      '<div class="pe-cite-pop-list" role="listbox"></div>' +
      '<div class="pe-cite-pop-hint">' +
        '<kbd>↑</kbd>/<kbd>↓</kbd> navigate · <kbd>Enter</kbd> insert · <kbd>Esc</kbd> close' +
      '</div>';
    document.body.appendChild(pop);
    citationPopoverEl = pop;
    var input = pop.querySelector('.pe-cite-pop-search');
    var listEl = pop.querySelector('.pe-cite-pop-list');
    var activeIdx = 0;
    var current = [];

    function refresh() {
      var q = input.value.trim().toLowerCase();
      var src = state.citationList || [];
      var matched = q
        ? src.filter(function (e) { return e.searchHaystack.indexOf(q) >= 0; })
        : src.slice(0, 20);
      current = matched.slice(0, 50);
      activeIdx = current.length ? 0 : -1;
      renderList();
    }
    function renderList() {
      listEl.innerHTML = '';
      if (!current.length) {
        listEl.innerHTML = '<div class="pe-cite-pop-empty">No matching library entries. Add one in /pages/library.html first.</div>';
        return;
      }
      current.forEach(function (e, i) {
        var row = document.createElement('button');
        row.type = 'button';
        row.className = 'pe-cite-pop-row';
        if (i === activeIdx) row.classList.add('active');
        row.innerHTML =
          '<div class="pe-cite-pop-key">' + escapeHtmlForCE(e.key) + '</div>' +
          '<div class="pe-cite-pop-meta">' +
            escapeHtmlForCE(e.firstAuthor || '') +
            (e.year ? ' (' + escapeHtmlForCE(String(e.year)) + ')' : '') +
            (e.journal ? ' · <i>' + escapeHtmlForCE(e.journal) + '</i>' : '') +
          '</div>' +
          (e.title ? '<div class="pe-cite-pop-title-line">' + escapeHtmlForCE(e.title.slice(0, 140)) + '</div>' : '');
        row.addEventListener('mouseenter', function () { activeIdx = i; renderList(); });
        row.addEventListener('click', function () { pickIndex(i); });
        listEl.appendChild(row);
      });
    }
    function pickIndex(i) {
      var entry = current[i];
      if (!entry) return;
      hide();
      if (citationPopoverState.onPick) citationPopoverState.onPick(entry);
    }

    input.addEventListener('input', refresh);
    input.addEventListener('keydown', function (e) {
      if (e.key === 'Escape') { hide(); e.preventDefault(); return; }
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
      if (!pop.hidden && !pop.contains(e.target)) hide();
    });

    function hide() {
      pop.hidden = true;
      citationPopoverState.onPick = null;
      citationPopoverState.anchorEl = null;
    }
    pop._refresh = refresh;
    pop._focus = function () { input.focus(); input.select(); };
    pop._hide = hide;
    return pop;
  }

  /** Open the citation popover. opts.anchorEl positions it; opts.onPick(entry)
   * receives the chosen citation entry. If anchorEl is omitted, popover sits
   * centered. */
  function openCitationPopover(opts) {
    if (!state.citationList || !state.citationList.length) {
      // Index might still be loading. Wait briefly.
      loadCitationIndex().then(function () { openCitationPopover(opts); });
    }
    var pop = ensureCitationPopover();
    citationPopoverState.onPick = opts && opts.onPick || null;
    citationPopoverState.anchorEl = opts && opts.anchorEl || null;
    // Position: just below the anchor's bounding rect, or center.
    var anchor = opts && opts.anchorEl;
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
    if (!lastFocusedEditable) return;
    var el = lastFocusedEditable;
    // The element must still be in the DOM and tied to a Y.Text. We look up
    // the Y.Text via the binding's lastValue indirectly: we just compute the
    // diff against the current el.textContent. The bind's input handler
    // would normally do this, but we synthesize an insert.
    // Simplest path: focus el, set selection, document.execCommand('insertText').
    // The 'input' event then fires, our binding's diff runs, Y.Text updates.
    el.focus();
    setCaretCharOffset(el, lastFocusedCaret);
    var token = '[@' + citationKey + ']';
    var ok = document.execCommand && document.execCommand('insertText', false, token);
    if (!ok) {
      // Fallback: manually insert and dispatch input event.
      var sel = window.getSelection();
      if (sel.rangeCount) {
        sel.getRangeAt(0).deleteContents();
        sel.getRangeAt(0).insertNode(document.createTextNode(token));
        el.dispatchEvent(new InputEvent('input', { bubbles: true }));
      }
    }
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

  /** Render inline content in a paragraph (math + citation chips) to HTML.
   *
   * - `$...$`, `\(...\)`            → KaTeX inline math
   * - `[@key]`, `[@k1; @k2]`        → citation chips (resolves authors from
   *                                   state.citationByKey when present)
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

      // [@key] / [@k1; @k2]  (Pandoc citations)
      if (ch === '[' && text[i + 1] === '@') {
        var endBracket = text.indexOf(']', i + 2);
        if (endBracket > i) {
          var inner = text.slice(i + 2, endBracket);
          // Validate: each token starts with @ (after the first) and contains
          // only citation-key-friendly chars + a separator.
          if (/^[\w:.\-+/]+(\s*;\s*@[\w:.\-+/]+)*$/.test(inner)) {
            out += renderCitationChip(inner);
            i = endBracket + 1;
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
   * tooltip showing first author + year. */
  function renderCitationChip(inner) {
    var keys = inner.split(/\s*;\s*@?/).map(function (s) { return s.trim(); }).filter(Boolean);
    var parts = keys.map(function (key) {
      var hit = state.citationByKey ? state.citationByKey[key] : null;
      var label = hit && hit.shortLabel ? hit.shortLabel : key;
      var tooltip = hit ? (hit.title || key) : ('Unknown citation key: ' + key);
      var cls = hit ? 'pe-cite-chip' : 'pe-cite-chip pe-cite-chip-unknown';
      return '<span class="' + cls + '" data-key="' + escapeAttr(key) +
             '" title="' + escapeAttr(tooltip) + '">' + escapeHtmlForCE(label) + '</span>';
    });
    return '<span class="pe-cite-group">' + parts.join('<span class="pe-cite-sep">; </span>') + '</span>';
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

  /* Render the source text into a contenteditable element using a callback.
   * If KaTeX hasn't loaded yet, shows plain text and re-renders once the
   * lazy import resolves. */
  function applyRendered(el, sourceText, renderFn) {
    if (!sourceText) {
      el.textContent = '';
      el.dataset.empty = 'true';
      return;
    }
    el.dataset.empty = 'false';
    if (!_katex) {
      el.textContent = sourceText;
      ensureKatex().then(function () {
        if (document.activeElement !== el) {
          el.innerHTML = renderFn(sourceText);
        }
      }).catch(function () { /* leave plain */ });
      return;
    }
    el.innerHTML = renderFn(sourceText);
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
    el.contentEditable = opts.readOnly ? 'false' : 'true';
    el.spellcheck = true;
    var lastValue = yText.toString();
    if (document.activeElement === el) {
      el.textContent = lastValue;
      el.dataset.empty = lastValue ? 'false' : 'true';
    } else {
      applyRendered(el, lastValue, renderFn);
    }

    // Plain-text paste only.
    el.addEventListener('paste', function (e) {
      if (opts.readOnly) { e.preventDefault(); return; }
      e.preventDefault();
      var text = (e.clipboardData || window.clipboardData).getData('text/plain');
      document.execCommand('insertText', false, text);
    });

    el.addEventListener('focus', function () {
      // Show source for editing — the rendered KaTeX HTML can't be safely edited.
      if (opts.readOnly) return;
      el.textContent = yText.toString();
      lastValue = el.textContent;
      el.dataset.empty = lastValue ? 'false' : 'true';
    });

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
      applyRendered(el, v, renderFn);
    });

    el.addEventListener('input', function () {
      if (opts.readOnly) return;
      var newVal = el.textContent;
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
        // While focused, show plain source and preserve caret.
        if (newVal === lastValue && newVal === el.textContent) return;
        var caret = readCaretCharOffset(el);
        if (caret !== null) caret = applyDeltaToOffset(caret, event.delta);
        el.textContent = newVal;
        lastValue = newVal;
        el.dataset.empty = newVal ? 'false' : 'true';
        if (caret !== null) setCaretCharOffset(el, caret);
      } else {
        // Not focused — re-render via the provided renderFn.
        if (newVal === lastValue) return;
        lastValue = newVal;
        applyRendered(el, newVal, renderFn);
      }
      if (opts.onRemoteChange) opts.onRemoteChange();
    };
    yText.observe(observer);
    return function unbind() { yText.unobserve(observer); };
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

  function readCaretCharOffset(el) {
    var sel = window.getSelection();
    if (!sel || !sel.rangeCount) return null;
    var range = sel.getRangeAt(0);
    if (!el.contains(range.endContainer)) return null;
    var pre = range.cloneRange();
    pre.selectNodeContents(el);
    pre.setEnd(range.endContainer, range.endOffset);
    return pre.toString().length;
  }
  function setCaretCharOffset(el, offset) {
    var range = document.createRange();
    var sel = window.getSelection();
    var nodeStack = [el], node, foundStart = false, charCount = 0;
    while (!foundStart && (node = nodeStack.pop())) {
      if (node.nodeType === Node.TEXT_NODE) {
        var nextCount = charCount + node.length;
        if (offset >= charCount && offset <= nextCount) {
          range.setStart(node, offset - charCount);
          range.collapse(true);
          foundStart = true;
        }
        charCount = nextCount;
      } else {
        for (var i = node.childNodes.length - 1; i >= 0; i--) {
          nodeStack.push(node.childNodes[i]);
        }
      }
    }
    if (!foundStart) {
      // Fallback: place at end.
      range.selectNodeContents(el);
      range.collapse(false);
    }
    sel.removeAllRanges();
    sel.addRange(range);
  }

  /* Expose the bindings + helpers to PaperBlocks for in-block use. */
  window.PaperEditor = {
    bindYTextToContentEditable: bindYTextToContentEditable,
    bindYTextToInput: bindYTextToInput,
    textDiff: textDiff,
    renderParagraphHtml: renderParagraphHtml,
    renderEquationHtml: renderEquationHtml,
    openCitationPopover: openCitationPopover,
  };

  /* ── Misc ── */

  function escapeHtml(s) {
    return String(s || '').replace(/[&<>"']/g, function (c) {
      return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c];
    });
  }

  /* ── Global keybinds ── */

  document.addEventListener('keydown', function (e) {
    // Cmd+K / Ctrl+K → citation popover, anchored at last-focused paragraph.
    var meta = e.metaKey || e.ctrlKey;
    if (meta && (e.key === 'k' || e.key === 'K')) {
      if (!state.editable) return;
      e.preventDefault();
      openCitationPopover({
        anchorEl: lastFocusedEditable,
        onPick: function (entry) { insertCitationAtFocus(entry.key); },
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

  /* ── Cleanup on unload ── */

  window.addEventListener('beforeunload', function () {
    if (state.conn) {
      try { state.conn.disconnect(); } catch (e) {}
    }
  });
})();
