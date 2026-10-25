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
  var statusSel      = document.getElementById('pe-status');   // V3.365
  var saveStateEl    = document.getElementById('pe-savestate');
  var readonlyBanner = document.getElementById('pe-readonly-banner');
  var outlineEl      = document.getElementById('pe-outline');
  /* V3.197 — sidebar paragraph-skeleton mirror lives in the second
   * tab; the tab nav lets the user flip between "Outline" (sections
   * list) and "Paragraph" (skeleton bullets of the focused block). */
  var paragraphSkelEl = document.getElementById('pe-paragraph-skel');
  var contentEl      = document.getElementById('pe-content');
  var addSectionBtn  = document.getElementById('pe-add-section-btn');
  var appendixBtn    = document.getElementById('pe-appendix-btn');   // V3.456
  var viewFilterSel  = document.getElementById('pe-view-filter');
  var statusFilterSel= document.getElementById('pe-status-filter');
  var topbarEl       = document.querySelector('.pe-topbar');

  /* Presence row + invite button + reset + export buttons live in the topbar; created on demand. */
  var presenceRowEl = null;
  var inviteBtnEl   = null;
  var resetBtnEl    = null;
  var exportBtnEl   = null;
  var docViewBtnEl  = null;   // V3.387 — Document view toggle
  var versionsBtnEl = null;
  var importRefsBtnEl = null; // V3.483 — import references → library + attach
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
      if (!found && typeof api.invalidate === 'function') {
        // V3.485 — a just-imported paper is written by a direct single-doc
        // set (bypassing api.save), so the stale-while-revalidate list can lag
        // one load and miss it → a spurious "not found"/blank page right after
        // import that only clears on a manual refresh. Bust the cache and
        // refetch ONCE before giving up.
        try {
          await api.invalidate('projects/papers.json');
          data = await api.load('projects/papers.json');
          rows = (data && data.papers) || [];
          found = rows.find(function (p) { return p.id === paramId; });
        } catch (e) { /* fall through to the not-found message */ }
      }
      if (!found) {
        contentEl.innerHTML = '<div class="empty-state">Paper "' + escapeHtml(paramId) +
          '" not found. <a href="/rm/pages/paper-builder.html">Back to papers</a>.</div>';
        return;
      }
      state.meta = found;
      titleInput.value = found.title || '';
      document.title = (found.title || 'Paper') + ' — Editor';
      populateStatusSelect(found.status || 'drafting');
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

    /* V3.741 — checked out as a .paperbundle.zip: canEditPaper is false for
     * everyone (admins included) and the provider drops local updates. The
     * banner says who has it and offers the two ways out. */
    var checkedOut = !!(firebridge.isPaperCheckedOut && firebridge.isPaperCheckedOut(state.meta));
    if (checkedOut) {
      showCheckoutBanner();
    } else if (!canEdit) {
      if (user) {
        showReadonlyBanner('Read-only. Signed in as ' + who + ' (role: ' + role +
          '). To edit, you must be admin OR have your uid in this paper\'s ' +
          'lead_author_uid / coauthor_uids in data/projects/papers.json. ' +
          'Open the browser console for full auth diagnostics.');
      }
    } else {
      hideReadonlyBanner();
    }

    /* V3.365 — status selector gate. projects/papers.json rows live in
     * the `projects` collection, whose write rule is admin-only — so the
     * select is only enabled for admins; author students see the current
     * status with a "ask the PI" tooltip instead of a save that would
     * die on permission-denied. */
    if (statusSel) {
      var canSetStatus = firebridge.isAdmin();
      statusSel.disabled = !canSetStatus;
      statusSel.title = canSetStatus
        ? 'Paper status — `published` marks this draft\'s library associations inactive'
        : 'Status: ' + (state.meta.status || 'drafting') +
          ' — only admins can change it (shared papers list is admin-write)';
    }

    setSaveStatus('Connecting…', 'saving');
    // Kick off the citation index in parallel with the Yjs connect — items.json
    // can be ~MB-sized and the editor doesn't need it for first paint.
    loadCitationIndex();
    /* V3.344 — load the paper's export-template citation style so chips
     * render as the journal will typeset them (superscript / [1] / (1) /
     * author-year). Non-blocking; falls back to Author-Year labels. */
    if (window.PaperCiteStyle) window.PaperCiteStyle.init(state.paperId);
    // V3.741 — `locked` is the belt-and-braces kill-switch: the server rule
    // refuses yjs_updates while checked out, this stops them being queued.
    var conn = await window.PaperYjs.connect(state.paperId, { locked: checkedOut });
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
      /* V3.645 — per-paper value keys ([!val:KEY] / [@item:KEY]). Same
       * idempotent create as equation_library above: only materializes
       * on the first connect after the V3.645 deploy, so existing
       * papers pick it up without a migration. */
      if (!paperMap.has('value_library')) {
        paperMap.set('value_library', new conn.Y.Array());
      }
    }, 'init');

    /* V3.389 — re-run the citation-style init now that the paper is
     * connected, THEN force a full re-render once the family resolves. The
     * family loads async (it polls for PaperExportTex + reads paperExports)
     * and almost always lands AFTER the blocks first render, so the chips
     * were built with no family = legacy "Author Year". The per-paragraph
     * 'paper-equations-changed' repaint proved unreliable here, so mirror
     * what the citation-index-loaded path does: render() the whole document
     * (unless the user is mid-edit in a block). This is the fix that makes
     * citations actually flip to the journal's numbering on load. */
    if (window.PaperCiteStyle && window.PaperCiteStyle.init) {
      window.PaperCiteStyle.init(state.paperId).then(function () {
        if (!(window.PaperCiteStyle.getFamily && window.PaperCiteStyle.getFamily())) return;
        if (document.activeElement && document.activeElement.classList &&
            document.activeElement.classList.contains('pe-block-content')) return;
        if (state.sectionsArr) render();
      });
    }

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
    // structure. V3.472 — a paper created by the grant importer carries
    // `import_seed`; hydrate the prepared section tree from its bundle
    // instead of the template's empty starter sections. Falls back to the
    // template if the bundle can't be fetched.
    if (state.sectionsArr.length === 0 && state.editable) {
      if (state.meta && state.meta.import_seed) {
        hydrateFromImport(state.meta.import_seed);
      } else {
        seedFromTemplate();
      }
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

    /* V3.366 — cited-in-drafts sync (library-cited-sync.js). Local edits
     * (origin ≠ 'remote', the provider's own convention) schedule a
     * debounced diff of the doc's [@key] set against each library item's
     * meta.library.cited_in_drafts. Read-only sessions never write —
     * CITED_SYNC.init gates on editable. */
    if (window.CITED_SYNC) {
      conn.yDoc.on('update', function (u, origin) {
        if (origin !== 'remote') window.CITED_SYNC.schedule();
      });
      window.CITED_SYNC.init({ editable: state.editable });
      window.addEventListener('pagehide', function () { window.CITED_SYNC.runNow(); });
    }
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
    /* V3.369 — section completion (lock + final form). Must round-trip
     * through all three tree functions or a section reorder drops it. */
    if (sec.completed_at) m.set('completed_at', sec.completed_at);
    if (sec.completed_by) m.set('completed_by', sec.completed_by);
    /* V3.455 — needs-revision flag metadata: same round-trip contract. */
    if (sec.revision_by) m.set('revision_by', sec.revision_by);
    if (sec.revision_at) m.set('revision_at', sec.revision_at);
    /* V3.465 — grant attached-doc upload pointer: same round-trip contract. */
    if (sec.uploaded_file) m.set('uploaded_file', sec.uploaded_file);
    /* V3.413 — section styles: same round-trip contract. */
    if (sec.special) m.set('special', sec.special);
    if (sec.special_render) m.set('special_render', sec.special_render);
    /* Appendix flag + cross-ref anchor — same round-trip contract. */
    if (sec.appendix) m.set('appendix', true);
    if (sec.ref_label) m.set('ref_label', sec.ref_label);
    /* V3.742 — per-section style overrides: same round-trip contract
     * (mirrors paper-tree-build.js appendSection). */
    if (sec.style_overrides && typeof sec.style_overrides === 'object' &&
        Object.keys(sec.style_overrides).length) m.set('style_overrides', sec.style_overrides);
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
    /* Restore ALL attrs — scalars fast-path; deep values (table `cells`
     * Y.Map of Y.Text, `caption` Y.Text, figure `subfigures` Y.Array)
     * rehydrate through the same _writeAttrValue used by within-section
     * moves. Before this fix a SECTION move silently destroyed table
     * cells/captions and figure panel labels (deep attrs were skipped).
     * Plain JS arrays from schema-factory trees (e.g. newFigure's
     * `subfigures: []`) convert to their live Y shapes. */
    var attrs = m.get('attrs');
    if (blk.attrs && typeof blk.attrs === 'object') {
      Object.keys(blk.attrs).forEach(function (k) {
        var v = blk.attrs[k];
        if (v === null || typeof v === 'string' || typeof v === 'number' || typeof v === 'boolean') {
          attrs.set(k, v);
        } else if (v && v.__ytype) {
          _writeAttrValue(attrs, k, v, Y);
        } else if (Array.isArray(v)) {
          _writeAttrValue(attrs, k, {
            __ytype: 'array',
            items: v.map(function (item) {
              if (item && typeof item === 'object' && !Array.isArray(item)) {
                var entries = {};
                Object.keys(item).forEach(function (ik) {
                  var iv = item[ik];
                  if (iv === null || typeof iv === 'string' || typeof iv === 'number' || typeof iv === 'boolean') entries[ik] = iv;
                });
                return { __ytype: 'map', entries: entries };
              }
              return item;
            }),
          }, Y);
        } else {
          attrs.set(k, v);   // plain object — stored as a JSON value (unchanged)
        }
      });
    }
    /* V3.742 — paragraph outline items (mirrors paper-tree-build.js
     * writeSkeletonItems). Accepts the bundle's plain [{id, depth, text,
     * claim_id}] array OR a {__ytype:'array'} snapshot. Before this, a
     * SECTION move (sectionMapToTree → hydrateSectionFromTree → here) silently
     * dropped every paragraph's skeleton_items. */
    var sk = blk.skeleton_items;
    if (sk && sk.__ytype) {
      _writeAttrValue(m, 'skeleton_items', sk, Y);
    } else if (Array.isArray(sk) && sk.length) {
      var skArr = new Y.Array();
      m.set('skeleton_items', skArr);
      sk.forEach(function (it) {
        if (!it || typeof it !== 'object') return;
        var im = new Y.Map();
        skArr.push([im]);
        im.set('id', it.id || window.PaperSchemas.shortId('sk-'));
        im.set('depth', typeof it.depth === 'number' ? it.depth : 0);
        im.set('text', new Y.Text(it.text ? String(it.text) : ''));
        im.set('claim_id', it.claim_id || null);
      });
    }
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

  /* V3.472 — hydrate a fresh paper from a prepared import bundle
   * (rm/data/grant-imports/<id>.json): the full section tree
   * (custom narrative sections, subheadings at their verbatim depth,
   * paragraphs, figure blocks with captions, a References Cited section).
   * Runs ONCE, only when the doc is empty (the seed guard), so it never
   * clobbers an edited paper. Figures import caption-only (empty
   * storage_path) — the author attaches each image via the normal figure
   * UI. Falls back to the template starter if the bundle can't be fetched.
   * This is the reusable paper-import seam (the GELS NSF CAREER bundle is
   * the first user; general markdown/JSON import-export builds on it). */
  function hydrateFromImport(importId) {
    if (!/^[a-z0-9][a-z0-9-]*$/.test(String(importId || ''))) { seedFromTemplate(); return; }
    _loadImportPackage(importId)
      .then(function (pkg) { return _hydrateBundle(pkg); })
      .catch(function (e) {
        console.warn('[paper-editor] import hydrate failed (' + (e && e.message) + '); using template.');
        if (state.sectionsArr.length === 0) seedFromTemplate();
      });
  }

  /* Source the bundle: an uploaded .paperbundle.zip was unzipped on the
   * list page and stashed in IndexedDB (import_source==='upload'); a
   * built-in grant bundle is a fixed server file. Returns
   * {bundle, assets:{relpath:base64}, comments:[], stashKey?}. */
  function _loadImportPackage(importId) {
    if (state.meta && state.meta.import_source === 'upload' && window.LOCAL_CACHE) {
      return window.LOCAL_CACHE.scope('paperImport::' + importId, 3600 * 1000).get().then(function (w) {
        if (!w || !w.data || !w.data.manifest) throw new Error('import stash missing (reload the Papers list and re-import)');
        return { bundle: w.data.manifest, assets: w.data.assets || {}, comments: w.data.comments || [], stashKey: importId };
      });
    }
    return fetch('/rm/data/grant-imports/' + importId + '.json', { cache: 'no-cache' })
      .then(function (r) { if (!r.ok) throw new Error('bundle ' + r.status); return r.json(); })
      .then(function (b) { return { bundle: b, assets: {}, comments: [] }; });
  }

  /* Full hydration: tree (ids preserved) + equation library + unplaced
   * figure/table libraries in one transact; then config → paperExports;
   * then figure bytes re-uploaded + attrs re-pointed; then the stash is
   * cleared. Tolerant of the older/minimal bundle shape (missing fields
   * are skipped), so the built-in GELS bundle still imports. */
  async function _hydrateBundle(pkg) {
    var bundle = pkg.bundle;
    var secs = bundle && bundle.tree && bundle.tree.sections;
    if (!Array.isArray(secs) || !secs.length) throw new Error('empty bundle');
    if (state.sectionsArr.length !== 0) return;   // double-hydrate guard
    var Y = state.Y;

    state.conn.yDoc.transact(function () {
      secs.forEach(function (sec, i) {
        appendSectionFromTree(state.sectionsArr, {
          id: sec.id,                              // V3.47x — PRESERVE (comments bind to block ids)
          kind: sec.kind || 'custom',
          label: sec.label || 'Untitled',
          order: (typeof sec.order === 'number') ? sec.order : i,
          status: sec.status,
          completed_at: sec.completed_at, completed_by: sec.completed_by,
          revision_by: sec.revision_by, revision_at: sec.revision_at,
          special: sec.special, special_render: sec.special_render,
          appendix: sec.appendix, ref_label: sec.ref_label,
          uploaded_file: sec.uploaded_file,
          style_overrides: sec.style_overrides,   // V3.742
          children: sec.children || [],
        });
      });
      // Inline equation library.
      var eqSrc = bundle.equation_library || [];
      var lib = state.paperMap && state.paperMap.get('equation_library');
      if (lib && eqSrc.length) {
        eqSrc.forEach(function (e) {
          var m = new Y.Map(); lib.push([m]);
          m.set('id', e.id || window.PaperSchemas.shortId('eq-'));
          m.set('name', new Y.Text(e.name || ''));
          m.set('latex', new Y.Text(e.latex || ''));
          m.set('type', e.type === 'main' ? 'main' : 'inline');
        });
      }
      /* V3.645 — value keys. Scalars only (no Y.Text): a value is
       * edited as a whole field on the Values page, never
       * character-by-character in prose, so per-char CRDT merge buys
       * nothing and costs a hydration branch. */
      var valSrc = bundle.value_library || [];
      var valLib = state.paperMap && state.paperMap.get('value_library');
      if (valLib && valSrc.length) {
        valSrc.forEach(function (v) {
          var e = window.PaperSchemas.newValueEntry(v || {});
          var m = new Y.Map(); valLib.push([m]);
          Object.keys(e).forEach(function (k) {
            if (k === 'snapshot') {
              var sm = new Y.Map();
              m.set('snapshot', sm);
              Object.keys(e.snapshot).forEach(function (sk) { sm.set(sk, e.snapshot[sk]); });
            } else {
              m.set(k, e[k]);
            }
          });
        });
      }
      // Unplaced figure/table libraries (same block shape).
      ['figure_unplaced', 'table_unplaced'].forEach(function (k) {
        var arr = bundle[k];
        var yarr = state.paperMap && state.paperMap.get(k);
        if (yarr && Array.isArray(arr)) arr.forEach(function (blk) { appendBlockFromTree(yarr, blk); });
      });
    }, 'seed-import');

    // Figures: re-upload the bundled bytes under this paper id, then patch
    // every block/GA/attachment storage pointer. Best-effort; the built-in
    // caption-only bundle has no assets, so this is a no-op there.
    var remap = await _reuploadImportedAssets(pkg);

    // Config → paperExports (after remap so graphicalAbstract points fresh).
    if (bundle.config && typeof firebridge !== 'undefined' && firebridge.db) {
      try {
        var cfg = Object.assign({}, bundle.config);
        if (cfg.graphicalAbstract && cfg.graphicalAbstract.storage_path && remap[cfg.graphicalAbstract.storage_path]) {
          cfg.graphicalAbstract = Object.assign({}, cfg.graphicalAbstract, remap[cfg.graphicalAbstract.storage_path]);
        }
        cfg.updatedAt = firebase.firestore.FieldValue.serverTimestamp();
        var u = firebridge.getUser();
        cfg.updatedBy = u ? (u.email || u.uid) : '';
        await firebridge.db().collection('paperExports').doc(state.paperId).set(cfg, { merge: true });
      } catch (e) { console.warn('[paper-editor] import config write failed', e); }
    }

    // Comments — restored via the E3 Cloud Function (skipped until live).
    if (pkg.comments && pkg.comments.length && typeof _restoreImportedComments === 'function') {
      try { await _restoreImportedComments(pkg.comments); } catch (e) { console.warn('[paper-editor] comment restore skipped', e); }
    }

    // V3.485 — bundled references run OFF the critical import path. They used
    // to be awaited here (V3.484), which entangled ~210 Firestore writes + a
    // whole-document marker-rewrite transact with the editor's first paint and
    // left a white page until a manual refresh. Now: hydrate resolves and the
    // sections paint first; the reference work is scheduled afterward, fully
    // isolated, so it can never blank or block the initial render.
    if (Array.isArray(bundle.references) && bundle.references.length) {
      setTimeout(function () {
        _materializeBundleReferences(bundle).catch(function (e) {
          console.warn('[paper-editor] deferred reference materialization failed', e);
        });
      }, 600);
    }

    if (pkg.stashKey && window.LOCAL_CACHE) {
      try { await window.LOCAL_CACHE.scope('paperImport::' + pkg.stashKey, 1).clear(); } catch (e) { /* ignore */ }
    }
    _importNumberingHint(bundle);
  }

  /* base64 → Blob (browser). */
  function _b64ToBlob(b64, mime) {
    var bin = atob(b64);
    var len = bin.length;
    var bytes = new Uint8Array(len);
    for (var i = 0; i < len; i++) bytes[i] = bin.charCodeAt(i);
    return new Blob([bytes], { type: mime || 'application/octet-stream' });
  }
  var MIME_BY_EXT = { png: 'image/png', jpg: 'image/jpeg', jpeg: 'image/jpeg', gif: 'image/gif',
    webp: 'image/webp', svg: 'image/svg+xml', pdf: 'application/pdf' };

  /* Re-upload each bundled asset under this paper id; return a map
   * {oldStoragePath → {storage_path, download_url, hash, mime}} and patch
   * the live Yjs attrs (figure/composed-panel/section-attachment). */
  async function _reuploadImportedAssets(pkg) {
    var remap = {};
    var assetList = (pkg.bundle && pkg.bundle.assets) || [];
    if (!assetList.length || !pkg.assets || !window.PAPER_FIGURES || !window.PAPER_FIGURES.uploadImage) return remap;
    for (var i = 0; i < assetList.length; i++) {
      var a = assetList[i];
      var b64 = pkg.assets[a.relpath];
      if (!b64 || !a.storage_path_original) continue;
      try {
        var blob = _b64ToBlob(b64, MIME_BY_EXT[a.ext] || 'application/octet-stream');
        var res = await window.PAPER_FIGURES.uploadImage(state.paperId, blob);
        remap[a.storage_path_original] = { storage_path: res.storage_path, download_url: res.download_url, hash: res.hash, mime: res.mime };
      } catch (e) { console.warn('[paper-editor] asset re-upload failed', a.relpath, e); }
    }
    if (Object.keys(remap).length) _patchStoragePointers(remap);
    return remap;
  }

  function _patchBlockStorage(b, remap) {
    var attrs = b && b.get && b.get('attrs');
    if (!attrs || !attrs.get) return;
    var sp = attrs.get('storage_path');
    if (sp && remap[sp]) { attrs.set('storage_path', remap[sp].storage_path); attrs.set('download_url', remap[sp].download_url); if (remap[sp].hash) attrs.set('hash', remap[sp].hash); }
    var pj = attrs.get('panels_json');
    if (pj) {
      try {
        var panels = JSON.parse(pj), changed = false;
        panels.forEach(function (p) {
          if (p && p.storage_path && remap[p.storage_path]) {
            var r = remap[p.storage_path];
            p.storage_path = r.storage_path; p.download_url = r.download_url; if (r.hash) p.hash = r.hash;
            changed = true;
          }
        });
        if (changed) attrs.set('panels_json', JSON.stringify(panels));
      } catch (e) { /* malformed panels_json — leave */ }
    }
  }
  function _patchStoragePointers(remap) {
    state.conn.yDoc.transact(function () {
      state.sectionsArr.forEach(function (secMap) {
        var uf = secMap.get('uploaded_file');
        if (uf && uf.storage_path && remap[uf.storage_path]) {
          secMap.set('uploaded_file', Object.assign({}, uf, remap[uf.storage_path]));
        }
        var kids = secMap.get('children');
        if (kids && kids.forEach) kids.forEach(function (b) { _patchBlockStorage(b, remap); });
      });
      ['figure_unplaced', 'table_unplaced'].forEach(function (k) {
        var yarr = state.paperMap && state.paperMap.get(k);
        if (yarr && yarr.forEach) yarr.forEach(function (b) { _patchBlockStorage(b, remap); });
      });
    }, 'import-figures');
  }

  /* V3.481 (E3) — faithful comment restore via the restorePaperComments
   * Cloud Function (Admin SDK preserves true authorUid + timestamps). The
   * function is health-gated: if it isn't deployed yet, comment restore is
   * silently skipped (the rest of the import already succeeded). The
   * editor's own comment subscription then picks up the restored docs. */
  var _RESTORE_COMMENTS_URL = 'https://us-central1-mcgheelab-f56cc.cloudfunctions.net/restorePaperComments';
  var _restoreCommentsHealth = null;
  function _commentRestoreAvailable() {
    if (_restoreCommentsHealth) return _restoreCommentsHealth;
    _restoreCommentsHealth = fetch(_RESTORE_COMMENTS_URL, { method: 'GET' })
      .then(function (r) { return r.ok; }).catch(function () { return false; });
    return _restoreCommentsHealth;
  }
  function _restoreImportedComments(comments) {
    return _commentRestoreAvailable().then(function (ok) {
      if (!ok) { console.info('[paper-editor] comment-restore function not live; skipping ' + comments.length + ' comments.'); return; }
      var user = (typeof firebridge !== 'undefined') ? firebridge.getUser() : null;
      return Promise.resolve(user ? user.getIdToken() : null).then(function (tok) {
        return fetch(_RESTORE_COMMENTS_URL, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json', 'Authorization': 'Bearer ' + (tok || '') },
          body: JSON.stringify({ paperId: state.paperId, comments: comments }),
        });
      }).then(function (r) {
        return r.json().catch(function () { return {}; }).then(function (j) {
          if (!r.ok) throw new Error(j.error || ('restore failed ' + r.status));
          console.info('[paper-editor] restored ' + (j.restored || 0) + ' comment(s).');
        });
      });
    });
  }

  /* The imported subheadings carry their own verbatim numbers ("3.1.1 …");
   * a one-time toast tells the author to set Numbering → Off on the Export
   * page if the auto section numbers double up. Non-blocking, best-effort. */
  function _importNumberingHint(bundle) {
    if (!bundle || bundle.sectionNumbering !== 'off') return;
    try {
      if (window.RM && window.RM.toast) {
        window.RM.toast('Imported. Tip: on the Export page set Numbering → Off — the headings already carry their numbers.');
      }
    } catch (e) { /* toast is optional */ }
  }

  /* ── Render ── */

  function render() {
    titleInput.disabled = !state.editable;
    addSectionBtn.disabled = !state.editable;

    var sections = state.sectionsArr.toArray();
    /* V3.456 — the § Appendices placer shows only while no divider
     * exists (and there is a section to place it before). */
    if (appendixBtn) {
      appendixBtn.disabled = !state.editable;
      appendixBtn.hidden = !state.editable || !sections.length ||
        _appendixBoundaryIdx(sections) >= 0;
    }
    if (!state.activeSectionId && sections.length) {
      state.activeSectionId = sections[0].get('id');
    }

    teardownBlockSubscriptions();
    renderOutline(sections);
    renderMain(sections);
    /* V3.346 — fill the section word-count badges on first paint (the
     * throttled paper-panel-changed listener keeps them fresh after). */
    setTimeout(_updateSectionWordBadges, 0);
    renderPresenceRow();
    ensureInviteButton();
  }

  /* V3.369 — manuscript numbering for a completed section's blocks.
   * The per-block number badges live in the (hidden) block toolbars, so
   * final form re-labels in place: the figure/table "Caption" label
   * becomes "Figure N." / "Table N.", and numbered display equations
   * get a right-aligned (N). Numbers come from the document-order
   * walkers, so they match the rest of the manuscript. */
  function _decorateFinalBlock(blockEl, blockMap) {
    if (!blockEl || !blockMap) return;
    try {
      var kind = blockMap.get('kind');
      var blockId = blockMap.get('id');
      if (kind === 'figure') {
        var fig = getNumberedFigures().find(function (f) { return f.blockId === blockId; });
        var figLbl = blockEl.querySelector('.pe-figure-caption-label');
        if (figLbl) figLbl.textContent = fig ? 'Figure ' + fig.num + '.' : 'Figure.';
      } else if (kind === 'table') {
        var tab = getNumberedTables().find(function (t) { return t.blockId === blockId; });
        var tabLbl = blockEl.querySelector('.pe-table-caption-label');
        if (tabLbl) tabLbl.textContent = tab ? 'Table ' + tab.num + '.' : 'Table.';
      } else if (kind === 'equation') {
        var eq = getNumberedEquations().find(function (e) { return e.blockId === blockId; });
        if (eq) {
          var num = document.createElement('span');
          num.className = 'pe-final-eqnum';
          num.textContent = '(' + eq.num + ')';
          blockEl.appendChild(num);
        }
      }
    } catch (e) { /* decoration is cosmetic — never break render */ }
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
      /* V3.369 — completed marker in the outline. */
      if (sec.get('completed_at')) {
        var doneMark = document.createElement('span');
        ICON.label(doneMark, 'check');
        doneMark.title = 'Section completed — final form';
        doneMark.style.cssText = 'color:#047857;font-weight:700;margin-left:4px;';
        li.appendChild(doneMark);
      }
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
    var boundaryIdx = _appendixBoundaryIdx(sections);
    sections.forEach(function (sec, i) {
      if (i === boundaryIdx) contentEl.appendChild(_renderAppendixDivider(i, sections.length));
      contentEl.appendChild(renderSection(sec));
    });
  }

  /* V3.456 — the appendix boundary: index of the FIRST appendix-flagged
   * section. Export emits \appendix once before it and the doc view
   * flips to A/B/C numbering there — both one-way — so a single divider
   * is the honest UI for the existing model. */
  function _appendixBoundaryIdx(sections) {
    for (var i = 0; i < sections.length; i++) {
      if (sections[i].get('appendix')) return i;
    }
    return -1;
  }

  /* Place (or clear) the divider: exactly ONE section keeps the
   * `appendix` flag — the boundary. Also normalizes legacy multi-flag
   * docs (harmless before: consumers stop reading flags after the
   * first). targetIdx null/out-of-range clears all flags. */
  function _setAppendixBoundary(targetIdx) {
    if (!state.editable || !state.conn) return;
    var sections = state.sectionsArr.toArray();
    if (typeof targetIdx !== 'number' || targetIdx < 0 || targetIdx >= sections.length) {
      targetIdx = -1;
    }
    state.conn.yDoc.transact(function () {
      sections.forEach(function (secMap, i) {
        if (i === targetIdx) secMap.set('appendix', true);
        else if (secMap.get('appendix')) secMap.delete('appendix');
      });
    }, 'appendix-divider');
  }

  function _renderAppendixDivider(idx, total) {
    var bar = document.createElement('div');
    bar.className = 'pe-appendix-divider';
    var label = document.createElement('span');
    label.className = 'pe-appendix-divider-label';
    label.textContent = '§ Appendices start here';
    label.title = 'Sections below compile after \\appendix and number as Appendix A, B, C in the document view. ' +
      'Moving a section across this divider moves it in or out of the appendices.';
    bar.appendChild(label);
    if (state.editable) {
      var ctrls = document.createElement('span');
      ctrls.className = 'pe-appendix-divider-ctrls';
      var up = document.createElement('button');
      up.type = 'button';
      ICON.label(up, 'chevron-up');
      up.title = 'Move the divider up — the section above becomes an appendix';
      up.disabled = idx <= 0;
      up.addEventListener('click', function () { _setAppendixBoundary(idx - 1); });
      ctrls.appendChild(up);
      var down = document.createElement('button');
      down.type = 'button';
      ICON.label(down, 'chevron-down');
      down.title = (idx + 1 < total)
        ? 'Move the divider down — the section below it leaves the appendices'
        : 'Move the divider past the last section — removes it';
      down.addEventListener('click', function () {
        _setAppendixBoundary(idx + 1 < total ? idx + 1 : null);
      });
      ctrls.appendChild(down);
      var clear = document.createElement('button');
      clear.type = 'button';
      ICON.label(clear, 'x-mark');
      clear.title = 'Remove the divider — all sections return to normal numbering';
      clear.addEventListener('click', function () { _setAppendixBoundary(null); });
      ctrls.appendChild(clear);
      bar.appendChild(ctrls);
    }
    return bar;
  }

  /* V3.465 — is this a grant attached-document kind (biosketch,
   * facilities, budget, …)? Reads PaperSchemas so there's one source of
   * truth. */
  function _isGrantAttachedKind(kind) {
    var list = (window.PaperSchemas && window.PaperSchemas.GRANT_ATTACHED_KINDS) || [];
    return list.indexOf(kind) >= 0;
  }

  /* Generic upload slot for a grant attached-doc section. Accepts a PDF
   * (matches the paper-figures Storage path + rules exactly — no
   * storage-rules change), stores the pointer on the section Y.Map as a
   * scalar object `uploaded_file`. Wholesale replace only (never mutated
   * in place), so a plain object leaf is safe in Yjs. */
  function _renderUploadSlot(secMap, secId) {
    var slot = document.createElement('div');
    slot.className = 'pe-upload-slot';
    var editable = !!state.editable;

    function render() {
      slot.innerHTML = '';
      var file = secMap.get('uploaded_file') || null;
      var label = document.createElement('span');
      label.className = 'pe-upload-label';
      ICON.label(label, 'paper-clip', ' Final document');
      slot.appendChild(label);

      if (file && file.download_url) {
        var link = document.createElement('a');
        link.className = 'pe-upload-file';
        link.href = file.download_url;
        link.target = '_blank';
        link.rel = 'noopener';
        link.textContent = (file.filename || 'attachment.pdf') +
          (file.size_bytes ? ' (' + (file.size_bytes / 1024 / 1024).toFixed(1) + ' MB)' : '');
        slot.appendChild(link);
        if (editable) {
          slot.appendChild(_uploadBtn(secMap, secId, render, 'Replace'));
          var rm = document.createElement('button');
          rm.type = 'button';
          rm.className = 'pe-upload-remove';
          rm.textContent = 'Remove';
          rm.addEventListener('click', function () {
            state.conn.yDoc.transact(function () { secMap.delete('uploaded_file'); }, 'section-upload');
            render();
          });
          slot.appendChild(rm);
        }
      } else {
        var empty = document.createElement('span');
        empty.className = 'pe-upload-empty';
        empty.textContent = editable ? 'No file attached yet.' : 'No file attached.';
        slot.appendChild(empty);
        if (editable) slot.appendChild(_uploadBtn(secMap, secId, render, 'Upload PDF…'));
      }
    }
    render();
    return slot;
  }

  function _uploadBtn(secMap, secId, onDone, text) {
    var wrap = document.createElement('label');
    wrap.className = 'pe-upload-btn';
    wrap.textContent = text;
    var input = document.createElement('input');
    input.type = 'file';
    input.accept = 'application/pdf,.pdf';
    input.style.display = 'none';
    wrap.appendChild(input);
    input.addEventListener('change', function () {
      var f = input.files && input.files[0];
      if (!f) return;
      if (f.type && f.type !== 'application/pdf') { alert('Please attach a PDF (the compiled final document).'); return; }
      if (!window.PAPER_FIGURES || !window.PAPER_FIGURES.uploadImage) { alert('Upload unavailable — file service not loaded.'); return; }
      wrap.classList.add('pe-upload-busy');
      wrap.textContent = 'Uploading…';
      window.PAPER_FIGURES.uploadImage(state.paperId, f).then(function (res) {
        state.conn.yDoc.transact(function () {
          secMap.set('uploaded_file', {
            filename: f.name || 'attachment.pdf',
            storage_path: res.storage_path,
            download_url: res.download_url,
            mime: res.mime,
            size_bytes: res.size_bytes,
            uploaded_at: res.uploaded_at,
          });
        }, 'section-upload');
        wrap.classList.remove('pe-upload-busy');
        onDone();
      }).catch(function (e) {
        wrap.classList.remove('pe-upload-busy');
        wrap.textContent = text;
        alert('Upload failed: ' + (e.message || e));
      });
    });
    return wrap;
  }

  function renderSection(secMap) {
    var schemas = window.PaperSchemas;
    var wrap = document.createElement('section');
    wrap.className = 'pe-section';
    var secId = secMap.get('id');
    wrap.dataset.sectionId = secId;
    /* V3.334 — expose the section kind on the DOM so the Writing Guide
     * tab can resolve the focused section's kind from the focused
     * contenteditable via closest('.pe-section'). */
    wrap.dataset.sectionKind = secMap.get('kind') || 'custom';

    /* V3.369 — completed sections lock out and render in final document
     * form: every block read-only in prose view (citations resolved via
     * the journal style, KaTeX, cross-refs), edit chrome hidden,
     * manuscript CSS. Derived from `completed_at` on the section map. */
    var sectionLocked = !!secMap.get('completed_at');
    if (sectionLocked) {
      wrap.classList.add('pe-section-final');
      wrap.dataset.completed = '1';
    }

    var header = document.createElement('div');
    header.className = 'pe-section-header';

    /* S-β — submission-document sections never render in the manuscript;
     * they compile as separate PDFs from the Export page. */
    var SUBMISSION_KINDS = { cover_letter: 1, suggested_reviewers: 1, rebuttal: 1 };
    if (SUBMISSION_KINDS[secMap.get('kind')]) {
      wrap.classList.add('pe-section-submission');
      var subBanner = document.createElement('div');
      subBanner.className = 'pe-submission-banner';
      ICON.label(subBanner, 'inbox-arrow-down', ' Not part of the manuscript — compiles as a separate PDF (Export page → Submission documents).');
      wrap.appendChild(subBanner);
    }

    /* Section label — bound to a Y.Text. */
    var labelEl = document.createElement('div');
    labelEl.className = 'pe-section-label';
    labelEl.contentEditable = (state.editable && !sectionLocked) ? 'true' : 'false';
    var labelY = secMap.get('label');
    if (labelY instanceof state.Y.Text) {
      bindYTextToContentEditable(labelY, labelEl, {
        readOnly: !state.editable || sectionLocked,
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

    /* V3.346 — live word-count badge (red when over the section kind's
     * advisory maxWords). Filled by _updateSectionWordBadges. */
    var wordsTag = document.createElement('span');
    wordsTag.className = 'pe-section-words';
    header.appendChild(wordsTag);

    /* Cross-reference label — the anchor a [!sec:label] token points at.
     * Scalar on the section map; set on blur so it doesn't re-render
     * mid-type (secMap.observe re-renders). */
    if (state.editable && !sectionLocked) {
      var refInput = document.createElement('input');
      refInput.type = 'text';
      refInput.className = 'pe-section-reflabel';
      refInput.placeholder = 'sec:label';
      refInput.title = 'Cross-reference label — reference this section elsewhere with [!sec:label]';
      refInput.value = secMap.get('ref_label') || '';
      refInput.addEventListener('change', function () {
        var v = refInput.value.trim();
        state.conn.yDoc.transact(function () {
          if (v) secMap.set('ref_label', v); else secMap.delete('ref_label');
        }, 'section-ref-label');
      });
      header.appendChild(refInput);
    }

    if (state.editable) {
      var actions = document.createElement('div');
      actions.className = 'pe-section-actions';
      actions.appendChild(mkIconBtn('▲', 'Move section up',   function () { moveSection(secId, -1); }));
      actions.appendChild(mkIconBtn('▼', 'Move section down', function () { moveSection(secId,  1); }));
      /* V3.456 — the per-section "§ Appendix" toggle is gone (header
       * clutter). Appendices are now marked by ONE movable divider bar
       * rendered between sections in renderMain; the model is unchanged
       * (first `appendix`-flagged section opens the zone — export and
       * doc view already read it that way). */
      /* V3.455 — section STATUS pill (was a "✓ Complete" action button
       * that read as an already-done state). Shows where the section IS:
       * amber "✎ Editing section" (draft) / green "✓ Completed section"
       * (locked, final form) / red "⚑ Needs revision" (unlocked, sent
       * back by the lead author or PI). Click advances: editing →
       * completed; needs-revision → completed (revision addressed);
       * completed → reopened for editing. Delete still requires the
       * unlocked state (a completed section shouldn't vanish on a
       * stray click). */
      var secStatus = String(secMap.get('status') || 'draft');
      if (secStatus !== 'complete' && sectionLocked) secStatus = 'complete';   // legacy: completed_at set, status stale
      var statusPill = document.createElement('button');
      statusPill.type = 'button';
      if (secStatus === 'complete') {
        statusPill.className = 'pe-section-status-pill pe-section-status-complete';
        ICON.label(statusPill, 'check', ' Completed section');
        statusPill.title = 'This section is complete (locked, final form). Click to reopen it for editing.';
        statusPill.addEventListener('click', function () { _setSectionStatus(secId, 'draft'); });
      } else if (secStatus === 'needs-review') {
        statusPill.className = 'pe-section-status-pill pe-section-status-revision';
        var _rBy = secMap.get('revision_by') || '';
        var _rWhen = String(secMap.get('revision_at') || '').slice(0, 10);
        ICON.label(statusPill, 'flag', ' Needs revision');
        statusPill.title = 'Sent back for revision' + (_rBy ? ' by ' + _rBy : '') +
          (_rWhen ? ' on ' + _rWhen : '') + '. Edit the section, then click to mark it complete.';
        statusPill.addEventListener('click', function () { _setSectionStatus(secId, 'complete'); });
      } else {
        statusPill.className = 'pe-section-status-pill pe-section-status-editing';
        ICON.label(statusPill, 'pencil', ' Editing section');
        statusPill.title = 'This section is being edited. Click to mark it complete — locks it and shows the final document form.';
        statusPill.addEventListener('click', function () { _setSectionStatus(secId, 'complete'); });
      }
      actions.appendChild(statusPill);
      /* ⚑ send-back — lead author / PI only. */
      if (secStatus !== 'needs-review' &&
          ((firebridge.isLeadAuthor && firebridge.isLeadAuthor(state.meta)) ||
           (firebridge.isAdmin && firebridge.isAdmin()))) {
        var flagBtn = document.createElement('button');
        flagBtn.type = 'button';
        flagBtn.className = 'pe-section-flag-btn';
        ICON.label(flagBtn, 'flag');
        flagBtn.title = 'Mark as "Needs revision" — sends the section back for editing (lead author / PI)';
        flagBtn.addEventListener('click', function () { _setSectionStatus(secId, 'needs-review'); });
        actions.appendChild(flagBtn);
      }
      if (!sectionLocked) {
        actions.appendChild(mkIconBtn('✕', 'Delete section', function () { deleteSection(secId); }));
      }
      header.appendChild(actions);
    }
    wrap.appendChild(header);

    /* V3.369 — completion banner. */
    if (sectionLocked) {
      var finalBanner = document.createElement('div');
      finalBanner.className = 'pe-final-banner';
      var _cBy = secMap.get('completed_by') || '';
      var _cWhen = String(secMap.get('completed_at') || '').slice(0, 10);
      ICON.label(finalBanner, 'lock-closed', ' Final form — completed' +
        (_cBy ? ' by ' + _cBy : '') + (_cWhen ? ' · ' + _cWhen : '') +
        (state.editable ? '. Click the green status pill to reopen.' : '.'));
      wrap.appendChild(finalBanner);
    } else if (String(secMap.get('status') || '') === 'needs-review') {
      /* V3.455 — send-back banner (visible to read-only viewers too). */
      var revBanner = document.createElement('div');
      revBanner.className = 'pe-revision-banner';
      var _rvBy = secMap.get('revision_by') || '';
      var _rvWhen = String(secMap.get('revision_at') || '').slice(0, 10);
      revBanner.textContent = '⚑ Needs revision' +
        (_rvBy ? ' — sent back by ' + _rvBy : '') + (_rvWhen ? ' · ' + _rvWhen : '');
      wrap.appendChild(revBanner);
    }

    /* V3.494 — the per-section PDF upload slot is RETIRED. Final grant PDFs
     * now live on the Grant Docs page (paperExports.grantDocs), not on the
     * manuscript section Y.Map. `_renderUploadSlot`/`_uploadBtn` remain defined
     * (a legacy `uploaded_file` on an old doc still renders its 📎 link via the
     * doc-view / export bundle) but are no longer mounted for new attachments.
     * See CodeLog/ClaudesPlan/V3.490_import_engine_grant_docs.md. */

    /* Render each block. */
    var ctx = {
      Y: state.Y,
      paperId: state.paperId,
      /* V3.125 — sectionId on ctx so block-side reorder controls can
       * call moveBlockUp/Down without re-walking sectionsArr. */
      sectionId: secId,
      /* V3.369 — a completed section renders every block read-only (the
       * blocks' readOnly path IS the final-form renderer: resolved
       * citations, KaTeX, cross-ref chips) and always in prose view. */
      editable: state.editable && !sectionLocked,
      viewFilter: sectionLocked ? 'body' : state.viewFilter,
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
      /* V3.369 — final form always shows every block, regardless of the
       * status filter: the document view must be complete. */
      var keep = sectionLocked ||
                 (sf === 'all') ||
                 (sf === 'not-complete' && s !== 'complete') ||
                 (sf === s);
      if (!keep) { hiddenCount++; return; }
      if (state.editable && !sectionLocked) {
        if (!inserterAtTopAdded) {
          wrap.appendChild(_buildBlockInserter(secId, secMap, arrIdx));
          inserterAtTopAdded = true;
        }
      }
      var blockEl = window.PaperBlocks.renderYBlock(blockMap, ctx);
      wrap.appendChild(blockEl);
      if (sectionLocked) _decorateFinalBlock(blockEl, blockMap);
      if (state.editable && !sectionLocked) {
        wrap.appendChild(_buildBlockInserter(secId, secMap, arrIdx + 1));
      }
      visibleIdx++;
    });
    /* If no blocks were visible, still show one inserter so the user
     * can add their first block. */
    if (state.editable && !sectionLocked && !inserterAtTopAdded) {
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
    /* V3.369 — the sectionsArr observer is shallow, so a completion
     * toggle (a scalar set on THIS map) never reaches it. Observe the
     * section map itself so both the local toggle and remote
     * collaborators' toggles re-render this section. */
    var secMetaObserver = function () { render(); };
    secMap.observe(secMetaObserver);
    state.blockSubscriptions.push({
      yMap: secMap,
      unobserve: function () { secMap.unobserve(secMetaObserver); },
    });

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
    var allowSubsections = !secStyle || secStyle.allowSubsections !== false;

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
    /* Subheading — a \subsection heading in the section flow. Gated by
     * the section style (abstract/keywords/references disallow them). */
    menu.appendChild(mkItem('Subheading', function () {
      insertBlockAt(sectionId, idx, 'subheading');
    }, !allowSubsections));
    /* List — itemize / enumerate block. */
    menu.appendChild(mkItem('List', function () {
      insertBlockAt(sectionId, idx, 'list');
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

  /* ONE table-attr seeder for all three creation paths (addTable /
   * createUnplacedTable / insertBlockAt) — they had drifted (addTable
   * was missing numbered/label/booktabs/header_row/align). Must run
   * inside a transact with `attrs` already attached to the doc. */
  function _seedTableAttrs(attrs) {
    var Y = state.Y;
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
    attrs.set('anchor', 'flow');        // V3.395 — layout intent
    attrs.set('span', 'column');
    attrs.set('lock', false);
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
      _seedTableAttrs(m.get('attrs'));
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
      attrs.set('span', 'column');   // V3.412 — layout span (page = both columns)
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
      // V3.395 — layout intent (Layout Mode); presence of `anchor` opts
      // the block into PaperLayout.resolveFloat at export.
      attrs.set('anchor', 'flow');
      attrs.set('span', 'column');
      attrs.set('lock', false);
      attrs.set('size_key', 'single');
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
      attrs.set('anchor', 'flow');        // V3.395 — layout intent
      attrs.set('span', 'column');
      attrs.set('lock', false);
      attrs.set('size_key', 'single');
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
      _seedTableAttrs(m.get('attrs'));
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
      } else if (kind === 'subheading') {
        attrs.set('level', opts.level === 3 ? 3 : 2);   // 2 = subsection
      } else if (kind === 'list') {
        attrs.set('list_type', opts.list_type === 'number' ? 'number' : 'bullet');
      } else if (kind === 'equation') {
        attrs.set('display', opts.display !== false);
        attrs.set('span', 'column');   // V3.412
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
        attrs.set('anchor', 'flow');      // V3.395 — layout intent
        attrs.set('span', 'column');
        attrs.set('lock', false);
        attrs.set('size_key', 'single');
      } else if (kind === 'table') {
        _seedTableAttrs(attrs);
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
      /* V3.369 — completion survives the snapshot→delete→rehydrate
       * dance of moveSection. */
      completed_at: secMap.get('completed_at') || null,
      completed_by: secMap.get('completed_by') || null,
      /* V3.455 — needs-revision flag metadata survives moves too. */
      revision_by: secMap.get('revision_by') || null,
      revision_at: secMap.get('revision_at') || null,
      /* V3.465 — grant attached-doc upload pointer survives moves too. */
      uploaded_file: secMap.get('uploaded_file') || null,
      /* V3.413 — section styles: survive the reorder snapshot. */
      special: secMap.get('special') || null,
      special_render: secMap.get('special_render') || null,
      appendix: !!secMap.get('appendix'),
      ref_label: secMap.get('ref_label') || null,
      style_overrides: secMap.get('style_overrides') || null,   // V3.742
      children: children,
    };
  }
  function blockMapToTree(b) {
    var Y = state.Y;
    var sk = b.get('skeleton');
    var bd = b.get('body');
    /* Snapshot ALL attrs so they survive moveSection — scalars as-is,
     * deep Y types (table cells/caption, subfigures) via _snapshotYValue
     * (the {__ytype} shapes appendBlockFromTree rehydrates). */
    var attrs = {};
    var ya = b.get('attrs');
    if (ya && typeof ya.forEach === 'function') {
      ya.forEach(function (v, k) {
        attrs[k] = _snapshotYValue(v);
      });
    }
    return {
      id: b.get('id'),
      kind: b.get('kind'),
      status: b.get('status') || 'draft',
      skeleton: (sk instanceof Y.Text) ? sk.toString() : String(sk || ''),
      /* V3.742 — outline items survive a section move (was dropped). */
      skeleton_items: _snapshotYValue(b.get('skeleton_items')),
      body:     (bd instanceof Y.Text) ? bd.toString() : String(bd || ''),
      attrs: attrs,
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
    /* V3.369 — completion round-trip (see sectionMapToTree). */
    if (sec.completed_at) m.set('completed_at', sec.completed_at);
    if (sec.completed_by) m.set('completed_by', sec.completed_by);
    /* V3.455 — needs-revision round-trip. */
    if (sec.revision_by) m.set('revision_by', sec.revision_by);
    if (sec.revision_at) m.set('revision_at', sec.revision_at);
    /* V3.465 — grant attached-doc upload pointer round-trip. */
    if (sec.uploaded_file) m.set('uploaded_file', sec.uploaded_file);
    /* V3.413 — section styles round-trip. */
    if (sec.special) m.set('special', sec.special);
    if (sec.special_render) m.set('special_render', sec.special_render);
    if (sec.appendix) m.set('appendix', true);
    if (sec.ref_label) m.set('ref_label', sec.ref_label);
    if (sec.style_overrides && typeof sec.style_overrides === 'object' &&
        Object.keys(sec.style_overrides).length) m.set('style_overrides', sec.style_overrides);   // V3.742
    m.set('children', new Y.Array());
    var children = m.get('children');
    (sec.children || []).forEach(function (blk) {
      appendBlockFromTree(children, blk);
    });
  }

  function deleteSection(sectionId, opts) {
    /* V3.416 — opts.skipConfirm lets the Document view's popover run its
     * own confirm (a nested browser confirm inside the overlay is fine,
     * but the caller owns the phrasing). */
    if (!(opts && opts.skipConfirm) &&
        !confirm('Delete this section and all its paragraphs?')) return;
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

  /* V3.369/V3.455 — set a section's workflow status. Status + completion
   * are section metadata on the Y.Map, so they sync to every
   * collaborator; the per-section map observer in renderSection
   * re-renders both locally and remotely. */
  function _setSectionStatus(sectionId, status) {
    /* V3.455 — three states: 'draft' (editing, unlocked), 'complete'
     * (locked + final form via completed_at), 'needs-review' (unlocked,
     * red pill — set by the lead author / PI's ⚑). 'needs-review' is
     * already in PaperSchemas.BLOCK_STATUSES, so normalizeTree passes it
     * and every tree round-trip copies it verbatim. */
    if (!state.editable || !state.conn) return;
    if (['draft', 'complete', 'needs-review'].indexOf(status) < 0) return;
    var hit = findSection(sectionId);
    if (!hit) return;
    var prof = firebridge.getProfile();
    var user = firebridge.getUser();
    var name = (prof && prof.name) || (user && user.email) || 'unknown';
    state.conn.yDoc.transact(function () {
      hit.map.set('status', status);
      if (status === 'complete') {
        hit.map.set('completed_at', new Date().toISOString());
        hit.map.set('completed_by', name);
      } else {
        hit.map.set('completed_at', null);
        hit.map.set('completed_by', null);
      }
      if (status === 'needs-review') {
        hit.map.set('revision_by', name);
        hit.map.set('revision_at', new Date().toISOString());
      } else {
        hit.map.delete('revision_by');
        hit.map.delete('revision_at');
      }
    }, 'section-status');
    /* Cite numbers / word badges refresh; the map observer already
     * triggered the re-render. */
    window.dispatchEvent(new CustomEvent('paper-panel-changed'));
  }

  /* V3.416 — headless section creation (the Document view's Insert menu
   * + the editor palette both funnel here). opts: {special,
   * special_render, atIndex, seedParagraph=true}. Appends, then walks
   * the new section into `atIndex` with the existing moveSection
   * machinery (append-then-reorder — sectionsArr has no insertAt). */
  function addSection(kind, label, opts) {
    if (!state.editable) return null;
    opts = opts || {};
    var schemas = window.PaperSchemas;
    var sec = schemas.newSection(kind, label, state.sectionsArr.length, {
      special: opts.special || null,
      special_render: opts.special_render || null,
    });
    if (opts.seedParagraph !== false) sec.children.push(schemas.newParagraph());
    var newSecId = sec.id;
    state.conn.yDoc.transact(function () {
      appendSectionFromTree(state.sectionsArr, sec);
    }, 'add-section');
    if (typeof opts.atIndex === 'number' && opts.atIndex >= 0 &&
        opts.atIndex < state.sectionsArr.length - 1) {
      var delta = opts.atIndex - (state.sectionsArr.length - 1);
      moveSection(newSecId, delta);
    }
    state.activeSectionId = newSecId;
    return newSecId;
  }

  /* V3.416 — light section listing for menus (singleton greying,
   * landing-position math) without handing out Y types. */
  function getSectionsSummary() {
    var out = [];
    state.sectionsArr.forEach(function (m, i) {
      var labelY = m.get('label');
      out.push({
        id: m.get('id'),
        kind: m.get('kind'),
        label: (labelY && labelY.toString) ? labelY.toString() : String(labelY || ''),
        special: m.get('special') || null,
        index: i,
      });
    });
    return out;
  }

  /* V3.457 — "+ Add section" opens a typed dropdown (was two stacked
   * window.prompt()s asking for a kind string). Body kinds + submission
   * documents come from PAPER_SECTION_KINDS/SECTION_KIND_LABELS; a
   * Custom row takes a free label. Kinds that only make sense once
   * (abstract, keywords, …) grey out when present. The function keeps
   * its old name — the toolbar button and the empty-state button both
   * already wire to it. */
  var _addSecMenuEl = null;
  function _closeAddSectionMenu() {
    if (_addSecMenuEl) { _addSecMenuEl.remove(); _addSecMenuEl = null; }
    document.removeEventListener('mousedown', _addSecMenuOutside, true);
    document.removeEventListener('keydown', _addSecMenuKey, true);
  }
  function _addSecMenuOutside(ev) {
    if (_addSecMenuEl && !_addSecMenuEl.contains(ev.target)) _closeAddSectionMenu();
  }
  function _addSecMenuKey(ev) {
    if (ev.key === 'Escape') _closeAddSectionMenu();
  }
  var ADDSEC_BODY_KINDS = ['abstract', 'keywords', 'introduction', 'background',
    'methods', 'results', 'discussion', 'conclusions', 'acknowledgements'];
  var ADDSEC_SUBMISSION_KINDS = ['cover_letter', 'suggested_reviewers', 'rebuttal'];
  /* V3.464 — grant attached-document kinds come from PaperSchemas (read
   * lazily so script eval-order can't leave them empty). Each is
   * normally one-per-paper → singleton. The grant NARRATIVE is authored
   * as plain custom sections (the Custom row below), matching how real
   * proposals are written. */
  var ADDSEC_GRANT_SUBMISSION_KINDS = ['cover_letter', 'suggested_reviewers'];
  var ADDSEC_SINGLETONS = { abstract: 1, keywords: 1, acknowledgements: 1,
    cover_letter: 1, suggested_reviewers: 1, rebuttal: 1 };
  function _grantAttachedKinds() {
    return (window.PaperSchemas && window.PaperSchemas.GRANT_ATTACHED_KINDS) || [];
  }
  function _isSingleton(kind) {
    return !!ADDSEC_SINGLETONS[kind] || _grantAttachedKinds().indexOf(kind) >= 0;
  }
  /* Groups shown in the Add Section menu, keyed by paper_type. Unknown /
   * editorial / book-chapter fall back to the journal groups (today's
   * behavior). */
  function _addSecGroups(paperType) {
    if (paperType === 'grant') {
      return [
        { head: 'Attached documents', kinds: _grantAttachedKinds() },
        { head: 'Submission documents', kinds: ADDSEC_GRANT_SUBMISSION_KINDS },
      ];
    }
    return [
      { head: 'Body sections', kinds: ADDSEC_BODY_KINDS },
      { head: 'Submission documents', kinds: ADDSEC_SUBMISSION_KINDS },
    ];
  }
  function addSectionPrompt(ev) {
    if (!state.editable) return;
    _closeAddSectionMenu();
    var schemas = window.PaperSchemas;
    var labels = schemas.SECTION_KIND_LABELS || {};
    var present = {};
    state.sectionsArr.toArray().forEach(function (s) { present[s.get('kind')] = true; });

    var menu = document.createElement('div');
    menu.className = 'pe-addsec-menu';
    var anchor = (ev && ev.currentTarget && ev.currentTarget.getBoundingClientRect)
      ? ev.currentTarget : addSectionBtn;
    var r = anchor.getBoundingClientRect();
    menu.style.left = Math.max(8, Math.min(r.left, window.innerWidth - 248)) + 'px';
    menu.style.top = Math.round(r.bottom + 6) + 'px';

    function pick(kind, label) {
      _closeAddSectionMenu();
      var id = addSection(kind, label);
      if (id) setTimeout(function () {
        var el = document.querySelector('[data-section-id="' + id + '"]');
        if (el) el.scrollIntoView({ behavior: 'smooth', block: 'start' });
      }, 60);
    }
    function head(text) {
      var h = document.createElement('div');
      h.className = 'pe-addsec-head';
      h.textContent = text;
      menu.appendChild(h);
    }
    function item(kind) {
      var taken = _isSingleton(kind) && present[kind];
      var b = document.createElement('button');
      b.type = 'button';
      b.className = 'pe-addsec-item';
      b.textContent = labels[kind] || kind;
      if (taken) {
        b.disabled = true;
        var note = document.createElement('span');
        note.className = 'pe-addsec-note';
        note.textContent = 'already added';
        b.appendChild(note);
      } else {
        b.addEventListener('click', function () { pick(kind, labels[kind] || kind); });
      }
      menu.appendChild(b);
    }

    var paperType = (state.meta && state.meta.paper_type) || 'journal';
    _addSecGroups(paperType).forEach(function (g) {
      if (!g.kinds || !g.kinds.length) return;
      head(g.head);
      g.kinds.forEach(item);
    });

    /* For grants the narrative (Overview, Background, Aims, …) is authored
     * as plain custom sections — make the Custom row's purpose explicit. */
    head(paperType === 'grant' ? 'Narrative / custom section' : 'Custom');
    var row = document.createElement('div');
    row.className = 'pe-addsec-custom';
    var input = document.createElement('input');
    input.type = 'text';
    input.placeholder = (paperType === 'grant') ? 'e.g. Research Plan, Background…' : 'Section title…';
    var go = document.createElement('button');
    go.type = 'button';
    go.textContent = 'Add';
    function submitCustom() {
      var v = input.value.trim();
      if (v) pick('custom', v);
    }
    go.addEventListener('click', submitCustom);
    input.addEventListener('keydown', function (e) {
      if (e.key === 'Enter') { e.preventDefault(); submitCustom(); }
    });
    row.appendChild(input);
    row.appendChild(go);
    menu.appendChild(row);

    document.body.appendChild(menu);
    _addSecMenuEl = menu;
    /* Keep the menu on-screen when the anchor sits near the bottom. */
    var mr = menu.getBoundingClientRect();
    if (mr.bottom > window.innerHeight - 8) {
      menu.style.top = Math.max(8, r.top - mr.height - 6) + 'px';
    }
    document.addEventListener('mousedown', _addSecMenuOutside, true);
    document.addEventListener('keydown', _addSecMenuKey, true);
    setTimeout(function () { input.focus(); }, 0);
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
  /* V3.456 — place the appendix divider before the last section; the
   * user then moves it with the ▲▼ on the bar. */
  if (appendixBtn) {
    appendixBtn.addEventListener('click', function () {
      var n = state.sectionsArr.length;
      if (n > 0) _setAppendixBoundary(n - 1);
    });
  }

  /* ── Status selector → papers.json (V3.365) ──
   * Statuses come from util.js ITEM_TYPES.paper. The save is the same
   * read-modify-write as the title sync below; on failure the select
   * reverts. Flipping to `published` is the association-lifecycle
   * transition — LIBRARY_ASSOC (reader/library pages) derives every pill
   * for this draft inactive from the new status. */

  function populateStatusSelect(current) {
    if (!statusSel) return;
    var statuses = (typeof ITEM_TYPES !== 'undefined' && ITEM_TYPES.paper && ITEM_TYPES.paper.statuses)
      ? ITEM_TYPES.paper.statuses
      : ['drafting', 'submitted', 'revising', 'rejected', 'published'];
    statusSel.innerHTML = statuses.map(function (s) {
      return '<option value="' + s + '"' + (s === current ? ' selected' : '') + '>' + s + '</option>';
    }).join('');
  }

  async function syncStatusToPapersJson(newStatus) {
    var prev = (state.meta && state.meta.status) || 'drafting';
    try {
      var data = await api.load('projects/papers.json');
      var rows = (data && data.papers) || [];
      var row = rows.find(function (p) { return p.id === state.paperId; });
      if (!row) throw new Error('paper row not found');
      if (row.status === newStatus) { state.meta.status = newStatus; return; }
      row.status = newStatus;
      await api.save('projects/papers.json', { papers: rows });
      state.meta.status = newStatus;
      if (window.LIBRARY_ASSOC && window.LIBRARY_ASSOC.invalidate) window.LIBRARY_ASSOC.invalidate();
      setSaveStatus(newStatus === 'published'
        ? 'Published — library associations to this draft are now inactive'
        : 'Status: ' + newStatus, 'saved');
    } catch (err) {
      console.warn('[paper-editor] Status sync to papers.json failed:', err.message);
      populateStatusSelect(prev);
      setSaveStatus('Status save failed: ' + (err.message || err), 'err');
    }
  }

  if (statusSel) {
    statusSel.addEventListener('change', function () {
      syncStatusToPapersJson(statusSel.value);
    });
  }

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
    readonlyBanner.className = 'pe-readonly-banner';   // V3.741 — drop any checkout variant
    readonlyBanner.textContent = msg;
    readonlyBanner.hidden = false;
  }
  function hideReadonlyBanner() {
    readonlyBanner.hidden = true;
  }

  /* V3.741 — checkout banner: who has the bundle, and the two ways back
   * (import it on the papers list, or unlock without it — admin / holder /
   * lead author). Unlock is a two-tap button, never a browser confirm. */
  function showCheckoutBanner() {
    var m = state.meta || {};
    var when = m.checked_out_at ? String(m.checked_out_at).slice(0, 16).replace('T', ' ') : '';
    readonlyBanner.innerHTML = '';
    readonlyBanner.className = 'pe-readonly-banner pe-checkout-banner';
    var txt = document.createElement('span');
    txt.className = 'pe-checkout-text';
    txt.innerHTML = ICON.svg('lock-closed') + ' <b>Checked out</b> by ' + escapeHtml(m.checked_out_by || 'someone') +
      (when ? ' on ' + escapeHtml(when) : '') +
      ' as a .paperbundle.zip — read-only for everyone until the updated bundle is imported back.';
    readonlyBanner.appendChild(txt);
    var acts = document.createElement('span');
    acts.className = 'pe-checkout-actions';
    var imp = document.createElement('a');
    imp.className = 'pe-checkout-btn';
    imp.href = '/rm/pages/paper-builder.html';
    imp.textContent = 'Import updated bundle';
    imp.title = 'Go to the papers list and use Import paper with the edited .paperbundle.zip';
    acts.appendChild(imp);
    var user = firebridge.getUser();
    var mayUnlock = firebridge.isAdmin() ||
      (user && m.checked_out_by_uid === user.uid) ||
      (firebridge.isLeadAuthor && firebridge.isLeadAuthor(m));
    if (mayUnlock) {
      var un = document.createElement('button');
      un.type = 'button';
      un.className = 'pe-checkout-btn pe-checkout-unlock';
      un.textContent = 'Unlock without importing';
      var armed = false, timer = null;
      un.addEventListener('click', async function () {
        if (!armed) {
          armed = true;
          un.textContent = 'Tap again to unlock — later importing the bundle will overwrite web edits';
          timer = setTimeout(function () { armed = false; un.textContent = 'Unlock without importing'; }, 5000);
          return;
        }
        clearTimeout(timer);
        un.disabled = true; un.textContent = 'Unlocking…';
        try {
          var del = firebase.firestore.FieldValue.delete();
          await firebridge.db().collection('projects').doc(state.paperId).set({
            checked_out_by_uid: del, checked_out_by: del, checked_out_at: del, checkout_token: del,
          }, { merge: true });
          try { if (typeof api !== 'undefined' && api.invalidate) await api.invalidate('projects/papers.json'); } catch (e) {}
          // The rule mirror (papers/{id}.checkedOutByUid) lands a moment later;
          // a reload re-evaluates editability against the fresh row.
          setTimeout(function () { window.location.reload(); }, 1200);
        } catch (e) {
          un.disabled = false; un.textContent = 'Unlock failed: ' + (e && e.message || e);
        }
      });
      acts.appendChild(un);
    }
    readonlyBanner.appendChild(acts);
    readonlyBanner.hidden = false;
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
    /* V3.387 — Document view: journal-styled page-sheet preview of the
     * paper (paper-doc-view.js). NOT gated on editable — read-only lab
     * members may look; the view gates its interactive pieces (template
     * switch, figure popover) on isEditable itself. */
    if (!docViewBtnEl && window.PaperDocView) {
      docViewBtnEl = document.createElement('button');
      docViewBtnEl.type = 'button';
      docViewBtnEl.className = 'btn pe-invite-btn';
      ICON.label(docViewBtnEl, 'document-text', ' Document');
      docViewBtnEl.title = 'Preview the paper as journal-styled pages — design figure layout and switch the target journal';
      docViewBtnEl.addEventListener('click', function () { window.PaperDocView.open(); });
      topbarEl.insertBefore(docViewBtnEl, saveStateEl);
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
    /* V3.483 — Import references: parse a BibTeX / DOI list into library
     * citation entries, link them to this draft, and (opt-in) rewrite
     * numeric [N] markers → [@key]. Editors only. */
    if (state.editable && !importRefsBtnEl && window.REFERENCE_IMPORT) {
      importRefsBtnEl = document.createElement('button');
      importRefsBtnEl.type = 'button';
      importRefsBtnEl.className = 'btn pe-invite-btn';
      importRefsBtnEl.textContent = 'Import refs';
      importRefsBtnEl.title = 'Import a reference list (BibTeX or DOIs) into the library, attach to this paper, and convert numeric [N] markers to [@key]';
      importRefsBtnEl.addEventListener('click', openImportReferences);
      topbarEl.insertBefore(importRefsBtnEl, saveStateEl);
    }
    /* V3.234 — Linked files: external URLs (Synology share, Drive, etc.)
     * attached to the paper. Stored on the top-level papers/{paperId}
     * doc as `externalLinks[]`; the Yjs body is untouched. Visible to
     * lab readers; only editors can add / remove. */
    ensureExternalLinksBtn();
  }

  /* ── V3.483 Import references (editor surface) ───────────────────────
   * Opens the shared REFERENCE_IMPORT dialog in editor mode. The dialog
   * commits new citation-only entries to the library; here we then link
   * each to this draft and offer a numeric-marker → [@key] rewrite. */
  function openImportReferences() {
    if (!window.REFERENCE_IMPORT) { window.alert('Reference importer not loaded on this page.'); return; }
    api.load('items.json').then(function (data) {
      var existing = (data && data.items) || [];
      REFERENCE_IMPORT.open({
        mode: 'editor',
        draftId: state.paperId,
        existingItems: existing,
        onCommit: function (r) {
          if (r.close) r.close();
          var chain = Promise.resolve();
          if (window.LIBRARY_LINKS && state.paperId) {
            r.builtItems.forEach(function (it) {
              chain = chain.then(function () { return LIBRARY_LINKS.toggleDraftLink(it.id, state.paperId, true); });
            });
          }
          chain
            .then(function () { return loadCitationIndex(); })
            .then(function () { _maybeRewriteMarkers(r.keyByOrder); })
            .catch(function (e) { console.warn('[paper-editor] reference import post-commit failed', e); });
        },
      });
    }).catch(function (e) { window.alert('Could not load the library: ' + (e && e.message)); });
  }

  function _docHasNumericMarkers() {
    var Y = state.Y, found = false;
    state.sectionsArr.forEach(function (secMap) {
      var kids = secMap.get('children');
      if (!kids || !kids.forEach) return;
      kids.forEach(function (blk) {
        var b = blk.get('body');
        if (b instanceof Y.Text && /\[\s*\d[\d\s,–-]*\]/.test(b.toString())) found = true;
      });
    });
    return found;
  }

  function _rewriteNumericCitations(keyByOrder) {
    var Y = state.Y, replaced = 0, unmapped = [];
    state.conn.yDoc.transact(function () {
      state.sectionsArr.forEach(function (secMap) {
        var kids = secMap.get('children');
        if (!kids || !kids.forEach) return;
        kids.forEach(function (blk) {
          try {
            var bodyY = blk.get('body');
            if (!(bodyY instanceof Y.Text)) return;
            var old = bodyY.toString();
            var rw = REFERENCE_IMPORT.rewriteNumericMarkers(old, keyByOrder);
            if (rw.text !== old) { bodyY.delete(0, bodyY.length); bodyY.insert(0, rw.text); replaced += rw.replaced; }
            rw.unmapped.forEach(function (u) { if (unmapped.indexOf(u) < 0) unmapped.push(u); });
          } catch (be) { /* one bad block never aborts the rest of the rewrite */ }
        });
      });
    }, 'ref-marker-rewrite');
    return { replaced: replaced, unmapped: unmapped };
  }

  function _maybeRewriteMarkers(keyByOrder) {
    if (!keyByOrder || !keyByOrder.length || !_docHasNumericMarkers()) return;
    if (!window.confirm('Rewrite this paper\'s numeric [N] citations to [@key] using the imported reference order?\n\nThis edits the section body text. Markers not covered by this import (out-of-range numbers) are left unchanged.')) return;
    var res = _rewriteNumericCitations(keyByOrder);
    var msg = 'Converted ' + res.replaced + ' citation group(s) to [@key].';
    if (res.unmapped.length) msg += '\n' + res.unmapped.length + ' marker(s) left unchanged (out of range / unresolved): ' + res.unmapped.slice(0, 12).join(' ');
    window.alert(msg);
  }

  /* V3.484 — materialize a bundle's baked `references[]` (unified metadata in
   * citation order) on paper import: create citation entries in the library
   * (deduped against the live library, collision-safe keys), attach each to
   * this draft, then rewrite the narrative's [N] markers to [@key] using the
   * resulting key order. Reuses the V3.483 reference-import core so keying is
   * consistent whether references arrive via the editor button or a bundle.
   * Best-effort: any failure is logged and the paper import still succeeds. */
  async function _materializeBundleReferences(bundle) {
    var refs = bundle && bundle.references;
    if (!Array.isArray(refs) || !refs.length) return;   // ordinary papers: silent no-op
    // Visible feedback (V3.488): this ran silently before, so a deploy gap /
    // empty references[] / runtime failure all looked identical ("nothing
    // happened"). Now every phase reports to the topbar and the finish (or any
    // failure) pops a summary so import is diagnosable at a glance.
    if (!window.REFERENCE_IMPORT) {
      window.alert('This paper carries ' + refs.length + ' references, but the reference importer ' +
        '(rm/js/reference-import.js) is not loaded on this page. Deploy the latest rm/ and reopen the paper.');
      return;
    }
    try {
      setSaveStatus('Importing ' + refs.length + ' references…', 'saving');
      var data = await api.load('items.json');
      var existing = (data && data.items) || [];
      var res = window.REFERENCE_IMPORT.dedupeAndKey(refs, existing);
      var fresh = window.REFERENCE_IMPORT.newItems(res);
      if (fresh.length) {
        setSaveStatus('Adding ' + fresh.length + ' references to the library…', 'saving');
        await window.REFERENCE_IMPORT.commitToLibrary(fresh);
      }
      // Attach every reference (new + already-in-library) to this draft.
      var linked = 0;
      if (window.LIBRARY_LINKS && state.paperId) {
        setSaveStatus('Linking references to this paper…', 'saving');
        for (var i = 0; i < res.entries.length; i++) {
          var e = res.entries[i];
          var id = e.status === 'existing' ? e.existingId : (e.item && e.item.id);
          if (id) { try { await LIBRARY_LINKS.toggleDraftLink(id, state.paperId, true); linked++; } catch (le) { /* keep going */ } }
        }
      }
      try { await loadCitationIndex(); } catch (ie) { /* live chips may lag until reload; compile reads fresh */ }
      // Fresh-import doc → rewrite markers without a confirm.
      var rw = _rewriteNumericCitations(res.keyByOrder);
      setSaveStatus('✓ ' + fresh.length + ' references added, ' + linked + ' linked', 'saved');
      window.alert('References imported:\n' +
        '• ' + fresh.length + ' added to the library\n' +
        '• ' + linked + ' linked to this paper\n' +
        '• ' + rw.replaced + ' [N] citation group(s) converted to [@key]' +
        (rw.unmapped.length ? '\n• ' + rw.unmapped.length + ' marker(s) left unchanged (out of range)' : '') +
        '\n\nOpen the Library to see them; the bibliography generates on compile.');
    } catch (e) {
      console.warn('[paper-editor] bundled reference materialization failed', e);
      setSaveStatus('Reference import failed', 'err');
      window.alert('Reference import failed: ' + (e && e.message || e) +
        '\n\n(The paper itself imported fine — this only affects the references.)');
    }
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
    ICON.label(extLinksBtnEl, 'link', ' Linked files' + (n ? ' (' + n + ')' : ''));
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
    ICON.label(clearBtn, 'x-mark');
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
                  ' <button type="button" class="pe-comments-scope-clear" title="Clear anchor filter">' + ICON.svg('x-mark') + '</button></div>';
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
    btn.innerHTML = ICON.svg('chat-bubble-left-right') + ' Comment';
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
          /* V3.345 — family names for the bibliography preview (capped;
           * the preview renders "A, B, C, et al."). */
          authors: (lib.authors || []).slice(0, 6).map(function (a) {
            return (a && (a.family || a.given)) || '';
          }).filter(Boolean),
          authorCount: (lib.authors || []).length,
          /* V3.388 — richer author + identifier fields for the Document
           * view's per-journal bibliography (initials, volume/issue/pages/
           * doi). Additive: the flat `authors`/`authorCount` above stay for
           * the other consumers (References-tab rows, cite chips). */
          /* V3.914 — every author: unsrtnat lists them all (the preview's
           * References Cited) */
          authorsFull: (lib.authors || []).slice(0, 80).map(function (a) {
            return { family: (a && a.family) || '', given: (a && a.given) || '' };
          }),
          volume: lib.volume || '',
          issue: lib.issue || '',
          pages: lib.pages || '',
          doi: lib.doi || '',
          /* V3.351 — light library richness for popover/ref rows. */
          hasPdf: !!(lib.pdf && (lib.pdf.storage_path || lib.pdf.download_url)),
          tags: Array.isArray(lib.tags) ? lib.tags.slice(0, 3) : [],
          shortLabel: firstAuthor && year ? firstAuthor + ' ' + year : key,
          title: it.title || lib.title || '',
          journal: lib.journal || '',
          itemId: it.id,
          /* V3.122 — linkedDrafts mirrors meta.library.linked_drafts so the
           * References tab can filter "linked but not cited" without a
           * second items.json fetch. The array is a slice() copy so
           * panel-side mutations don't leak back into the cached entry. */
          linkedDrafts: Array.isArray(lib.linked_drafts) ? lib.linked_drafts.slice() : [],
          /* V3.366 — citedInDrafts mirrors meta.library.cited_in_drafts so
           * CITED_SYNC can diff the doc's cited set against Firestore
           * without a second fetch. NOT a slice-protected copy on purpose:
           * CITED_SYNC patches it in place after each successful write. */
          citedInDrafts: Array.isArray(lib.cited_in_drafts) ? lib.cited_in_drafts.slice() : [],
          searchHaystack: (key + ' ' + firstAuthor + ' ' + year + ' ' +
                          (it.title || '') + ' ' + (lib.journal || '')).toLowerCase(),
        };
        byKey[key] = entry;
        list.push(entry);
      });
      list.sort(function (a, b) { return a.key.localeCompare(b.key); });
      state.citationByKey = byKey;
      state.citationList = list;
      state.citationIndexLoadedAt = Date.now();   // V3.351 — staleness window
      // Re-render any already-displayed paragraphs so chips pick up tooltips.
      window.dispatchEvent(new CustomEvent('paper-citations-loaded'));
      return byKey;
    }).catch(function (err) {
      console.warn('[paper-editor] failed to load items.json for citation index:', err.message);
      state.citationByKey = {};
      state.citationList = [];
    });
  }

  /* V3.351 — re-fetch the citation index when it has gone stale (papers
   * added to the library mid-session were invisible until reload). The
   * adapter's MAX(updatedAt) probe makes an unchanged re-fetch cheap.
   * Fire-and-forget: callers re-render on 'paper-citations-loaded'. */
  function ensureFreshCitationIndex(maxAgeMs) {
    var maxAge = typeof maxAgeMs === 'number' ? maxAgeMs : 5 * 60 * 1000;
    if (!state.citationByKey) return loadCitationIndex();
    if ((Date.now() - (state.citationIndexLoadedAt || 0)) < maxAge) {
      return Promise.resolve(state.citationByKey);
    }
    invalidateCitationIndex();
    return loadCitationIndex();
  }

  /* V3.351 — lazy, memoized abstract fetch for the References-tab rows.
   * Abstracts live in the extras subdoc items/{id}/details/main
   * (LIBRARY_EXTRAS); read rule is isLabMember(). */
  var _abstractCache = {};
  function fetchAbstract(itemId) {
    if (!itemId) return Promise.resolve('');
    if (_abstractCache[itemId]) return _abstractCache[itemId];
    _abstractCache[itemId] = (window.LIBRARY_EXTRAS && window.LIBRARY_EXTRAS.load
      ? window.LIBRARY_EXTRAS.load(itemId).then(function (x) { return (x && x.abstract) || ''; })
      : Promise.resolve('')
    ).catch(function () { return ''; });
    return _abstractCache[itemId];
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
    /* V3.366 — popover scope. Default = papers associated with this
     * draft (linkedDrafts ∋ paperId) or already cited; the "All library"
     * chip lifts it. Session-sticky (this object persists). citedNowSet
     * caches getCitedKeysInPaper() per popover open. */
    scopeAll: false,
    citedNowSet: null,
  };

  /* V3.346 — refresh every section header's word-count badge. Cheap
   * (one tree walk); throttled on paper-panel-changed. */
  function _updateSectionWordBadges() {
    if (!state.paperMap || !contentEl) return;
    var sections = state.paperMap.get('sections');
    if (!sections || typeof sections.forEach !== 'function') return;
    sections.forEach(function (secMap) {
      if (!secMap || typeof secMap.get !== 'function') return;
      var id = secMap.get('id');
      var el = contentEl.querySelector('.pe-section[data-section-id="' + id + '"] .pe-section-words');
      if (!el) return;
      var words = 0;
      var children = secMap.get('children');
      if (children && typeof children.forEach === 'function') {
        children.forEach(function (blk) {
          if (!blk || typeof blk.get !== 'function' || blk.get('kind') !== 'paragraph') return;
          var b = blk.get('body');
          var t = (b && b.toString) ? b.toString() : '';
          t = t.replace(/\$[^$]*\$/g, ' ')
               .replace(/\[[@!^][^\]\n]*\]/g, ' ')
               .replace(/[*~^`_]/g, ' ');
          var m = t.match(/\S+/g);
          words += m ? m.length : 0;
        });
      }
      var maxWords = null;
      try {
        var st = window.PaperSchemas.styleFor({ kind: secMap.get('kind'), style_overrides: {} });
        maxWords = st.maxWords || null;
      } catch (e) {}
      el.textContent = maxWords ? (words + ' / ' + maxWords + ' w') : (words + ' w');
      el.classList.toggle('over', !!(maxWords && words > maxWords));
    });
  }
  var _wordBadgeTimer = null;
  window.addEventListener('paper-panel-changed', function () {
    if (_wordBadgeTimer) return;
    _wordBadgeTimer = setTimeout(function () {
      _wordBadgeTimer = null;
      _updateSectionWordBadges();
    }, 1500);
  });

  function rememberFocus(el) {
    lastFocusedEditable = el;
    lastFocusedCaret = readCaretCharOffset(el) || 0;
    /* V3.197 — mirror the focused paragraph's skeleton in the sidebar. */
    _updateSidebarParagraphMirror(el);
    /* V3.334 — notify the Writing Guide tab of the focused section/block.
     * rememberFocus fires on every keystroke, so only dispatch when the
     * resolved section or block id actually changes. */
    _notifyFocusChanged(el);
  }

  /* V3.334 — resolve + broadcast the focus context for paper-writing-guide.js. */
  var _lastGuideFocusKey = null;
  function _notifyFocusChanged(el) {
    var sectionId = null, sectionKind = null, blockId = null, blockKind = null;
    if (el && el.closest) {
      var secEl = el.closest('.pe-section[data-section-id]');
      if (secEl) { sectionId = secEl.dataset.sectionId; sectionKind = secEl.dataset.sectionKind || null; }
      var blkEl = el.closest('.pe-block[data-block-id]');
      if (blkEl) { blockId = blkEl.dataset.blockId; blockKind = blkEl.dataset.kind || null; }
    }
    var key = sectionId + '|' + blockId;
    if (key === _lastGuideFocusKey) return;
    _lastGuideFocusKey = key;
    try {
      window.dispatchEvent(new CustomEvent('paper-focus-changed', {
        detail: { sectionId: sectionId, sectionKind: sectionKind, blockId: blockId, blockKind: blockKind },
      }));
    } catch (e) {}
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
        ICON.label(flag, 'flag');
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
      /* V3.366 — scope chips: associated-with-this-draft (default) vs
       * whole library. */
      '<div class="pe-cite-pop-scope"></div>' +
      '<div class="pe-cite-pop-selected-bar" hidden></div>' +
      '<div class="pe-cite-pop-claims" hidden></div>' +
      '<div class="pe-cite-pop-list" role="listbox"></div>' +
      '<div class="pe-cite-pop-foot">' +
        '<button type="button" class="pe-cite-pop-remove" hidden>Remove citation</button>' +
        /* V3.344 — narrative citation: "Smith et al. (2024) showed…".
         * Applies to single-key picks; writes a [@*key] token. */
        '<label class="pe-cite-pop-narrative" title="Author (Year) inline in the sentence — single citation only">' +
          '<input type="checkbox"> Narrative' +
        '</label>' +
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
    var narrativeCb = pop.querySelector('.pe-cite-pop-narrative input');  // V3.344
    var activeIdx = 0;
    var current = [];

    function refresh() {
      var q = input.value.trim().toLowerCase();
      var src = state.citationList || [];
      /* V3.366 — scope the pool to papers associated with this draft
       * (linked via meta.library.linked_drafts) or already cited in it,
       * unless the "All library" chip is on. Already-cited entries stay
       * in scope so the edit/remove flow always finds its own key. */
      var scoped = null;
      if (!citationPopoverState.scopeAll) {
        if (!citationPopoverState.citedNowSet) {
          try {
            citationPopoverState.citedNowSet = new Set(getCitedKeysInPaper());
          } catch (e) {
            citationPopoverState.citedNowSet = new Set();
          }
        }
        var citedNow = citationPopoverState.citedNowSet;
        scoped = src.filter(function (e) {
          return (Array.isArray(e.linkedDrafts) && e.linkedDrafts.indexOf(state.paperId) >= 0)
            || citedNow.has(e.key);
        });
      }
      _refreshScopeBar(scoped === null ? src.length : scoped.length, src.length);
      var pool = (scoped !== null) ? scoped : src;
      citationPopoverState._scopedEmpty = (scoped !== null && !scoped.length);
      var matched = q
        ? pool.filter(function (e) { return e.searchHaystack.indexOf(q) >= 0; })
        : pool.slice(0, 20);
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
    /* V3.366 — scope chip row (rendered fresh on every refresh; counts
     * track the live index). onclick assignment, not addEventListener —
     * refresh() runs per keystroke and must not stack handlers. */
    function _refreshScopeBar(scopedCount, allCount) {
      var scopeBar = pop.querySelector('.pe-cite-pop-scope');
      if (!scopeBar) return;
      var onAll = !!citationPopoverState.scopeAll;
      scopeBar.innerHTML =
        '<button type="button" class="pe-cite-scope-btn' + (onAll ? '' : ' on') + '" data-scope="draft" title="Only papers associated with this draft (or already cited in it)">Linked to this draft' + (onAll ? '' : ' (' + scopedCount + ')') + '</button>' +
        '<button type="button" class="pe-cite-scope-btn' + (onAll ? ' on' : '') + '" data-scope="all" title="Every paper in the lab library">All library (' + allCount + ')</button>';
      scopeBar.onclick = function (ev) {
        var btn = ev.target.closest('.pe-cite-scope-btn');
        if (!btn) return;
        var wantAll = btn.getAttribute('data-scope') === 'all';
        if (wantAll === citationPopoverState.scopeAll) return;
        citationPopoverState.scopeAll = wantAll;
        refresh();
        input.focus();
      };
    }

    function renderList() {
      listEl.innerHTML = '';
      if (!current.length) {
        listEl.innerHTML = citationPopoverState._scopedEmpty
          ? '<div class="pe-cite-pop-empty">No papers associated with this draft yet. Switch to <b>All library</b>, or associate papers via the References tab search / the library reader’s "Used in paper drafts" pills.</div>'
          : '<div class="pe-cite-pop-empty">No matching library entries. Add one in /pages/library.html first.</div>';
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
              /* V3.351 — light library richness. */
              (e.hasPdf ? ' <span class="pe-cite-pdf" title="PDF in the library">' + ICON.svg('document-text') + '</span>' : '') +
              (e.tags && e.tags.length
                ? ' ' + e.tags.map(function (t) {
                    return '<span class="pe-cite-tag">' + escapeHtmlForCE(t) + '</span>';
                  }).join(' ')
                : '') +
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
          ICON.label(arrow, expanded.has(expKey) ? 'chevron-down' : 'play');
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
      /* V3.344 — narrative flag rides along; consumers apply it only to
       * single-key picks. Read before hide() resets the checkbox. */
      var narrative = !!(narrativeCb && narrativeCb.checked);
      hide();
      if (cb) cb(keys, narrative);
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
      if (narrativeCb) narrativeCb.checked = false;   // V3.344
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
    /* V3.344 — pre-set the narrative checkbox (chip-edit flow re-opens
     * the popover on an existing [@*key] token). */
    pop._setNarrative = function (on) { if (narrativeCb) narrativeCb.checked = !!on; };
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
    } else {
      /* V3.351 — refresh a stale index in the background; the popover
       * re-renders via its own refresh() when rows change. */
      ensureFreshCitationIndex();
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
    /* V3.344 — restore the narrative state when editing a [@*key] chip. */
    if (pop._setNarrative) pop._setNarrative(!!(opts && opts.initialNarrative));
    /* V3.192 — kick off the claim-context load when the caller supplied
     * a paragraphEl. The popover renders a "Claims for this paragraph"
     * section above the search list once the data arrives. */
    citationPopoverState.paragraphEl = (opts && opts.paragraphEl) || null;
    citationPopoverState.claimContext = null;
    citationPopoverState.claimContextLoading = false;
    citationPopoverState.expandedClaimEvidence = new Set();
    /* V3.366 — recompute the cited set per popover open (scopeAll itself
     * is session-sticky by design). */
    citationPopoverState.citedNowSet = null;
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
  function insertCitationKeysAtFocus(citationKeys, opts) {
    if (!lastFocusedEditable) return;
    var keys = (citationKeys || []).filter(Boolean);
    if (!keys.length) return;
    var el = lastFocusedEditable;
    el.focus();
    setCaretCharOffset(el, lastFocusedCaret);
    /* V3.344 — opts.narrative + a single key writes the [@*key] narrative
     * token (renders "Smith et al. (2024)" inline / exports \citet). */
    var token = (opts && opts.narrative && keys.length === 1)
      ? '[@*' + keys[0] + ']'
      : '[@' + keys.join('; @') + ']';
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
    var initialNarrative = groupEl.dataset.citeNarrative === '1';   // V3.344
    /* Stash the paragraph element on lastFocused so the commit path
     * (which routes through replaceParagraphRange + execCommand) lands
     * in the right contenteditable. */
    lastFocusedEditable = paragraphEl;
    openCitationPopover({
      anchorEl: groupEl,
      editing: true,
      initialKeys: initialKeys,
      initialNarrative: initialNarrative,
      title: 'Edit citation (' + initialKeys.length + ' key' + (initialKeys.length === 1 ? '' : 's') + ')',
      onPickKeys: function (keys, narrative) {
        /* Source-text offsets reflect the SOURCE state at render time.
         * Once the contenteditable focuses, its DOM is the source text
         * via the focus handler — so srcStart/srcEnd map directly to
         * positions in el.textContent. */
        var newToken = '';
        if (keys.length) {
          newToken = (narrative && keys.length === 1)
            ? '[@*' + keys[0] + ']'
            : '[@' + keys.join('; @') + ']';
        }
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
        /* V3.649 — insert the WHOLE fragment. This used to insert
         * `tpl.content.firstChild` only, which was invisible while every
         * caller replaced a single token (a footnote or a citation group
         * renders to exactly one chip node). A multi-line replacement
         * renders to text/<br>/text/<br>/text, and all but the first node
         * was silently dropped — turning three lines into one. Capture
         * lastChild BEFORE inserting: insertNode empties the fragment. */
        var frag = tpl.content;
        var lastNode = frag.lastChild;
        if (lastNode) {
          range.insertNode(frag);
          var after = document.createRange();
          after.setStartAfter(lastNode);
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

      // [!sec:<label>] reference to a section / subheading. Renders as
      // the target's TITLE in the editor; the document viewer upgrades it
      // to the computed number ("Section 3.2"); export emits \ref/\cref.
      if (ch === '[' && text[i + 1] === '!' && text.slice(i + 2, i + 6) === 'sec:') {
        var endSec = text.indexOf(']', i + 6);
        if (endSec > i + 6) {
          var secLabel = text.slice(i + 6, endSec).trim();
          if (/^[\w:.\-]+$/.test(secLabel)) {
            out += renderSecRefChip(secLabel);
            i = endSec + 1;
            continue;
          }
        }
      }

      /* V3.645 — [!val:KEY] paper-local value. */
      if (ch === '[' && text[i + 1] === '!' && text.slice(i + 2, i + 6) === 'val:') {
        var endVal = text.indexOf(']', i + 6);
        if (endVal > i + 6) {
          var valKey = text.slice(i + 6, endVal).trim();
          if (/^[A-Za-z0-9][\w-]*$/.test(valKey)) {
            out += renderValChip(valKey);
            i = endVal + 1;
            continue;
          }
        }
      }

      /* V3.645 — [@item:KEY] lab inventory item. MUST be tested BEFORE
       * the [@key] citation branch below: the citation validator allows
       * colons, so `[@item:24WP]` would otherwise parse as a citation
       * with key "item:24WP" and compile to an undefined \cite{}. */
      if (ch === '[' && text[i + 1] === '@' && text.slice(i + 2, i + 7) === 'item:') {
        var endItem = text.indexOf(']', i + 7);
        if (endItem > i + 7) {
          var itemKey = text.slice(i + 7, endItem).trim();
          if (/^[A-Za-z0-9][\w-]*$/.test(itemKey)) {
            out += renderItemChip(itemKey);
            i = endItem + 1;
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
          if (/^\*?[\w:.\-+/]+(\s*;\s*@[\w:.\-+/]+)*$/.test(inner)) {  // V3.344 - optional leading * = narrative
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

      // V3.345 — [^text] footnote. Renders as a superscript dagger chip
      // whose tooltip shows the note text; exports as \footnote{}.
      if (ch === '[' && text[i + 1] === '^') {
        var endFn = findFootnoteEnd(text, i + 2);
        if (endFn > i + 2) {
          var fnInner = text.slice(i + 2, endFn);
          out += renderFootnoteChip(fnInner, i, endFn + 1);
          i = endFn + 1;
          continue;
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
    /* V3.344 — a leading `*` marks a NARRATIVE citation ("Smith et al.
     * (2024) showed…"), written by the popover's narrative checkbox.
     * Only meaningful for a single key; the `*` is not part of the key. */
    var narrative = inner.charAt(0) === '*';
    var keys = (narrative ? inner.slice(1) : inner)
      .split(/\s*;\s*@?/).map(function (s) { return s.trim().replace(/^\*/, ''); }).filter(Boolean);
    if (keys.length !== 1) narrative = false;

    /* V3.344 — chips follow the export template's citation family when
     * paper-cite-style.js has loaded one (superscript ¹ / [1] / (1) /
     * author-year); otherwise the legacy "Author Year" short label. */
    var family = (window.PaperCiteStyle && window.PaperCiteStyle.getFamily()) || null;
    var numericFamily = family === 'superscript' || family === 'numeric-bracket' || family === 'numeric-paren';

    /* One display span; may cover several keys (a collapsed range).
     * data-key carries every covered key ';'-joined (no other consumer
     * reads it — verified V3.393); the tooltip lists one "n. Title"
     * line per key. */
    function chipHtml(rs, label) {
      var known = rs.every(function (r) { return !!r.hit; });
      var tooltip = rs.map(function (r) {
        var t = r.hit ? (r.hit.title || r.key) : ('Unknown citation key: ' + r.key);
        return r.n != null ? (r.n + '. ' + t) : t;
      }).join('\n');
      var cls = known ? 'pe-cite-chip' : 'pe-cite-chip pe-cite-chip-unknown';
      return '<span class="' + cls + '" data-key="' +
             escapeAttr(rs.map(function (r) { return r.key; }).join(';')) +
             '" title="' + escapeAttr(tooltip) + '">' + escapeHtmlForCE(label) + '</span>';
    }

    var parts;
    if (numericFamily) {
      /* V3.393 — journal-style sort & compress (what natbib's
       * sort&compress / the cite package do at compile time): numbers
       * sort ascending and consecutive runs of 3+ collapse to an
       * en-dash range — [@a;@b;@c;@d] cited as 1,2,3,9 renders "1–3,9".
       * Runs of two stay "1,2". Only the DISPLAY is sorted/collapsed;
       * the source token (data-src below) keeps the author's key order
       * verbatim. Keys with no number yet (index still loading) render
       * as the bare key after the numbers. Duplicates dedupe. */
      var seenKeys = Object.create(null);
      var resolved = [];
      keys.forEach(function (key) {
        if (seenKeys[key]) return;
        seenKeys[key] = 1;
        resolved.push({
          key: key,
          hit: state.citationByKey ? state.citationByKey[key] : null,
          n: window.PaperCiteStyle.getNumber(key),
        });
      });
      var numbered = resolved.filter(function (r) { return r.n != null; })
        .sort(function (a, b) { return a.n - b.n; });
      var bare = resolved.filter(function (r) { return r.n == null; });
      parts = [];
      var ri = 0;
      while (ri < numbered.length) {
        var rj = ri;
        while (rj + 1 < numbered.length && numbered[rj + 1].n === numbered[rj].n + 1) rj++;
        if (rj - ri >= 2) {
          parts.push(chipHtml(numbered.slice(ri, rj + 1),
                              numbered[ri].n + '–' + numbered[rj].n));
          ri = rj + 1;
        } else {
          parts.push(chipHtml([numbered[ri]], String(numbered[ri].n)));
          ri++;
        }
      }
      bare.forEach(function (r) { parts.push(chipHtml([r], r.key)); });
    } else {
      parts = keys.map(function (key) {
        var hit = state.citationByKey ? state.citationByKey[key] : null;
        var label;
        if (narrative && hit) {
          label = (hit.firstAuthor || key) + ' (' + (hit.year || '?') + ')';
        } else {
          label = hit && hit.shortLabel ? hit.shortLabel : key;
        }
        return chipHtml([{ key: key, hit: hit, n: null }], label);
      });
    }
    var srcAttrs = '';
    /* V3.159 — atomic chip: contenteditable=false + data-src=[@k1; @k2]
     * so the chip-mode renderer treats it as a single non-editable
     * unit and the serializer reads the exact source token back. */
    var srcToken = narrative
      ? '[@*' + keys[0] + ']'
      : '[@' + keys.join('; @') + ']';
    if (typeof srcStart === 'number' && typeof srcEnd === 'number') {
      srcAttrs = ' data-cite-src-start="' + srcStart +
                 '" data-cite-src-end="' + srcEnd +
                 '" data-cite-keys="' + escapeAttr(keys.join(';')) + '"' +
                 (narrative ? ' data-cite-narrative="1"' : '') +
                 ' title="Click to edit citation"';
    }
    /* V3.344 — family wrapping: numeric families join with ", " and wrap
     * the whole group; author-year keeps "; " and wraps in parens
     * (except narrative, which reads inline in the sentence). */
    var sep, open = '', close = '', famCls = '';
    if (numericFamily) {
      /* V3.393 — packed, no space ("1–3,9" like the journals set it).
       * The old ", " separator contained a space that justified text
       * stretched into huge gaps between superscript numbers. */
      sep = '<span class="pe-cite-sep">,</span>';
      if (family === 'numeric-bracket') { open = '['; close = ']'; }
      if (family === 'numeric-paren')   { open = '('; close = ')'; }
      famCls = ' pe-cite-family-' + family;
    } else {
      /* V3.453 — no raw space in the separator: the doc view justifies
       * paragraphs, and a space here was a justification opportunity
       * that stretched into wide gaps (same bug V3.393 fixed for
       * numeric families). The visual gap is CSS now (editor:
       * .pe-cite-sep padding-right; sheet: margin, which justify can't
       * stretch). The <wbr> keeps the line-break opportunity a real
       * space used to provide, so long author-year clusters still wrap. */
      sep = '<span class="pe-cite-sep">;</span><wbr>';
      if (family === 'author-year' && !narrative) { open = '('; close = ')'; famCls = ' pe-cite-family-author-year'; }
    }
    return '<span class="pe-cite-group' + famCls + '" contenteditable="false" data-src="' + escapeAttr(srcToken) + '"' + srcAttrs + '>' +
             open + parts.join(sep) + close +
           '</span>';
  }

  /* V3.345 — render a [^text] footnote chip: a superscript dagger whose
   * tooltip shows the note text. Atomic (contenteditable=false) with the
   * exact source token in data-src so the chip serializer round-trips it.
   * data-fn-src-start/end let the delegated mousedown handler open a
   * prompt-based editor over the source byte range (same mechanism as
   * citation chips). */
  /* V3.345 — find the closing `]` of a [^…] footnote, allowing ONE
   * level of nested bracket tokens ([@cite] / [!fig:…]) inside the
   * note text. Returns -1 when unterminated or a newline intervenes. */
  function findFootnoteEnd(text, from) {
    var depth = 0;
    for (var j = from; j < text.length; j++) {
      var c = text[j];
      if (c === '\n') return -1;
      if (c === '[') depth++;
      else if (c === ']') {
        if (depth === 0) return j;
        depth--;
      }
    }
    return -1;
  }

  /* V3.345 — newlines always break the token; brackets are allowed when
   * balanced (nested [@cite]/[!fig:…] tokens), stripped otherwise. */
  function _sanitizeFootnoteText(txt) {
    txt = String(txt || '').replace(/\n/g, ' ').trim();
    var depth = 0, balanced = true;
    for (var i = 0; i < txt.length; i++) {
      if (txt[i] === '[') depth++;
      else if (txt[i] === ']') { depth--; if (depth < 0) { balanced = false; break; } }
    }
    if (!balanced || depth !== 0) txt = txt.replace(/[\[\]]/g, ' ').replace(/\s+/g, ' ').trim();
    return txt;
  }

  function renderFootnoteChip(inner, srcStart, srcEnd) {
    var srcToken = '[^' + inner + ']';
    var srcAttrs = '';
    if (typeof srcStart === 'number' && typeof srcEnd === 'number') {
      srcAttrs = ' data-fn-src-start="' + srcStart +
                 '" data-fn-src-end="' + srcEnd + '"';
    }
    return '<span class="pe-footnote-chip" contenteditable="false" data-src="' + escapeAttr(srcToken) + '"' +
           srcAttrs + ' title="Footnote: ' + escapeAttr(inner) + ' (click to edit)">†</span>';
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

  /* Section / subheading reference chip. Shows the target's TITLE in the
   * editor (the editor has no journal numbering); the document viewer
   * upgrades it to "Section N" post-mount via data-secref-label. Unknown
   * label → faded [?§ label]. */
  function renderSecRefChip(label) {
    var srcToken = '[!sec:' + label + ']';
    var tgt = getSectionRefTargets()[label];
    if (!tgt) {
      return '<span class="pe-secref-chip pe-secref-chip-unknown" contenteditable="false" data-src="' + escapeAttr(srcToken) +
             '" data-secref-label="' + escapeAttr(label) + '">[?§ ' + escapeHtmlForCE(label) + ']</span>';
    }
    return '<span class="pe-secref-chip" contenteditable="false" data-src="' + escapeAttr(srcToken) +
           '" data-secref-label="' + escapeAttr(label) +
           (tgt.id ? '" data-section-id="' + escapeAttr(tgt.id) : '') +
           '" title="' + escapeAttr(tgt.title) + '">§ ' + escapeHtmlForCE(tgt.title || label) + '</span>';
  }

  /* ── V3.645 — value keys ────────────────────────────────────────
   * [!val:KEY] (paper-local value) and [@item:KEY] (lab inventory item)
   * both read the ONE value_library table; they differ only in which
   * namespace they live in. See paper-schemas.js for why the table is
   * shared and why inventory entries carry a snapshot. */

  /* `[@item:…]` lives inside the citation namespace, so every consumer
   * that scans for `[@…]` MUST route through this predicate or item
   * keys leak into the bibliography as undefined \cite{} entries. The
   * six known consumers are listed in the V3.645 plan; this is the
   * single definition they all share. */
  var ITEM_TOKEN_PREFIX = 'item:';
  function isItemToken(inner) {
    if (!inner) return false;
    /* Narrative `*` is meaningless for items but strip it defensively
     * so `[@*item:x]` is still excluded from the bibliography. */
    return String(inner).replace(/^\*/, '').indexOf(ITEM_TOKEN_PREFIX) === 0;
  }
  function itemKeyFromToken(inner) {
    return String(inner || '').replace(/^\*/, '').slice(ITEM_TOKEN_PREFIX.length).trim();
  }

  /* Plain-JS projection of the value library, in table order. */
  function getValueEntries() {
    var out = [];
    if (!state.paperMap) return out;
    var lib = state.paperMap.get('value_library');
    if (!lib || typeof lib.forEach !== 'function') return out;
    lib.forEach(function (m) {
      if (!m || typeof m.get !== 'function') return;
      var snapY = m.get('snapshot');
      var snap = { name: '', vendor: '', catalogue_number: '' };
      if (snapY && typeof snapY.get === 'function') {
        snap.name = snapY.get('name') || '';
        snap.vendor = snapY.get('vendor') || '';
        snap.catalogue_number = snapY.get('catalogue_number') || '';
      }
      out.push({
        id: m.get('id') || '',
        key: m.get('key') || '',
        kind: window.PaperSchemas.normalizeValueKind(m.get('kind')),
        note: m.get('note') || '',
        value: m.get('value') || '',
        num: (typeof m.get('num') === 'number') ? m.get('num') : null,
        unit: m.get('unit') || '',
        sigfigs: (typeof m.get('sigfigs') === 'number') ? m.get('sigfigs') : null,
        inv_id: m.get('inv_id') || '',
        inv_kind: m.get('inv_kind') === 'chemical' ? 'chemical' : 'item',
        snapshot: snap,
        format: m.get('format') || window.PaperSchemas.DEFAULT_ITEM_FORMAT,
        refreshed_at: m.get('refreshed_at') || null,
      });
    });
    return out;
  }

  /* Key lookup is case-SENSITIVE and exact: `[!val:MRD]` and
   * `[!val:mrd]` are different keys, matching how citation keys behave.
   * On a duplicate key the first entry wins (the Values page flags the
   * collision rather than silently resolving it here). */
  function getValueByKey(key) {
    if (!key) return null;
    var all = getValueEntries();
    for (var i = 0; i < all.length; i++) {
      if (all[i].key === key) return all[i];
    }
    return null;
  }

  /* Resolve through the ONE shared formatter in paper-schemas so the
   * editor, the Document view and the .tex export can never disagree
   * about what the paper actually says. */
  function resolveValueText(key) {
    var e = getValueByKey(key);
    return e ? window.PaperSchemas.formatValueEntry(e) : null;
  }

  /* ── Value library mutators ──
   * All writes go through here so every caller gets the same transact
   * origin and the same repaint broadcast; a module writing the Y.Array
   * directly would leave stale chips on screen. */
  function _valueLibArr() {
    return state.paperMap ? state.paperMap.get('value_library') : null;
  }

  function _writeValueMap(m, obj, Y) {
    Object.keys(obj).forEach(function (k) {
      if (k === 'snapshot') {
        var sm = m.get('snapshot');
        if (!sm || typeof sm.set !== 'function') { sm = new Y.Map(); m.set('snapshot', sm); }
        Object.keys(obj.snapshot || {}).forEach(function (sk) { sm.set(sk, obj.snapshot[sk]); });
      } else {
        m.set(k, obj[k]);
      }
    });
  }

  function _broadcastValuesChanged() {
    window.dispatchEvent(new CustomEvent('paper-values-changed'));
  }

  function addValueEntry(opts) {
    var arr = _valueLibArr();
    if (!arr || !state.conn) return null;
    var Y = state.Y;
    var entry = window.PaperSchemas.newValueEntry(opts || {});
    state.conn.yDoc.transact(function () {
      var m = new Y.Map();
      arr.push([m]);
      _writeValueMap(m, entry, Y);
    }, 'local-values');
    _broadcastValuesChanged();
    return entry;
  }

  function updateValueEntry(id, patch) {
    var arr = _valueLibArr();
    if (!arr || !state.conn || !id) return false;
    var Y = state.Y;
    var found = false;
    state.conn.yDoc.transact(function () {
      arr.forEach(function (m) {
        if (found || !m || typeof m.get !== 'function') return;
        if (m.get('id') !== id) return;
        found = true;
        _writeValueMap(m, patch || {}, Y);
      });
    }, 'local-values');
    if (found) _broadcastValuesChanged();
    return found;
  }

  function deleteValueEntry(id) {
    var arr = _valueLibArr();
    if (!arr || !state.conn || !id) return false;
    var idx = -1, i = 0;
    arr.forEach(function (m) {
      if (idx < 0 && m && typeof m.get === 'function' && m.get('id') === id) idx = i;
      i++;
    });
    if (idx < 0) return false;
    state.conn.yDoc.transact(function () { arr.delete(idx, 1); }, 'local-values');
    _broadcastValuesChanged();
    return true;
  }

  function renderValChip(key) {
    var srcToken = '[!val:' + key + ']';
    var entry = getValueByKey(key);
    if (!entry) {
      return '<span class="pe-val-chip pe-val-chip-unknown" contenteditable="false" data-src="' + escapeAttr(srcToken) +
             '" data-val-key="' + escapeAttr(key) + '" title="No value defined for key: ' + escapeAttr(key) +
             '">[?' + escapeHtmlForCE(key) + ']</span>';
    }
    var txt = window.PaperSchemas.formatValueEntry(entry);
    var tip = key + (entry.note ? ' — ' + entry.note : '');
    if (!txt) {
      return '<span class="pe-val-chip pe-val-chip-empty" contenteditable="false" data-src="' + escapeAttr(srcToken) +
             '" data-val-key="' + escapeAttr(key) + '" title="' + escapeAttr(tip + ' (no value yet)') +
             '">[' + escapeHtmlForCE(key) + ']</span>';
    }
    return '<span class="pe-val-chip" contenteditable="false" data-src="' + escapeAttr(srcToken) +
           '" data-val-key="' + escapeAttr(key) + '" title="' + escapeAttr(tip) + '">' +
           escapeHtmlForCE(txt) + '</span>';
  }

  function renderItemChip(key) {
    var srcToken = '[@item:' + key + ']';
    var entry = getValueByKey(key);
    if (!entry || entry.kind !== 'inventory') {
      return '<span class="pe-item-chip pe-item-chip-unknown" contenteditable="false" data-src="' + escapeAttr(srcToken) +
             '" data-item-key="' + escapeAttr(key) + '" title="No inventory item defined for key: ' + escapeAttr(key) +
             '">[?' + escapeHtmlForCE(key) + ']</span>';
    }
    var txt = window.PaperSchemas.formatValueEntry(entry);
    var tip = (entry.snapshot && entry.snapshot.name) || key;
    if (entry.note) tip += ' — ' + entry.note;
    return '<span class="pe-item-chip" contenteditable="false" data-src="' + escapeAttr(srcToken) +
           '" data-item-key="' + escapeAttr(key) + '" title="' + escapeAttr(tip) + '">' +
           escapeHtmlForCE(txt || key) + '</span>';
  }

  /* V3.649 — every place a [!sec:] token COULD point at, in document
   * order, whether or not it has a ref_label yet.
   *
   * getSectionRefTargets (below) only knows about anchors that already
   * carry a hand-typed `ref_label`, which is why cross-references had no
   * picker: there was nothing to list until the writer had already gone to
   * each section header and invented a label. This walks the real
   * structure instead — sections, and the subheadings nested under them —
   * so the picker can offer everything and mint the label on the way past.
   *
   * Each choice: { id, kind:'section'|'subheading', title, refLabel|null,
   *                sectionId, appendixBoundary }
   */
  function getSectionRefChoices() {
    var out = [];
    var sections = state.sectionsArr;
    if (!sections || typeof sections.forEach !== 'function') return out;
    sections.forEach(function (sec) {
      if (!sec || typeof sec.get !== 'function') return;
      var secId = sec.get('id');
      out.push({
        id: secId,
        kind: 'section',
        title: readSectionLabel(sec),
        refLabel: sec.get('ref_label') || null,
        sectionId: secId,
        appendixBoundary: !!sec.get('appendix'),
      });
      var children = sec.get('children');
      if (!children || typeof children.forEach !== 'function') return;
      children.forEach(function (blk) {
        if (!blk || typeof blk.get !== 'function' || blk.get('kind') !== 'subheading') return;
        var a = blk.get('attrs');
        var bd = blk.get('body');
        out.push({
          id: blk.get('id'),
          kind: 'subheading',
          title: (bd && bd.toString) ? bd.toString() : String(bd || ''),
          refLabel: (a && typeof a.get === 'function' && a.get('ref_label')) || null,
          sectionId: secId,
          appendixBoundary: false,
        });
      });
    });
    return out;
  }

  /* V3.649 — return the anchor's ref_label, minting one from its title if
   * it has none. Mirrors paper-equations' _autoAssignFloatLabel for
   * figures/tables: the writer should never have to invent a label before
   * they can point at something.
   *
   * Slugs collide (two subheadings called "Statistics"), and a collision
   * would silently repoint an existing reference at the wrong heading, so
   * uniqueness is enforced against every label already in the document. */
  function ensureSectionRefLabel(anchorId) {
    if (!anchorId || !state.editable) return null;
    var sections = state.sectionsArr;
    if (!sections || typeof sections.forEach !== 'function') return null;

    var taken = {};
    getSectionRefChoices().forEach(function (c) {
      if (c.refLabel) taken[c.refLabel] = c.id;
    });

    function slugFor(title, id) {
      var base = String(title || '').trim().toLowerCase()
        .replace(/[^a-z0-9\s_-]+/g, '')
        .trim().split(/\s+/).filter(Boolean).slice(0, 5).join('-');
      if (!base) base = String(id || '').replace(/^[a-z]-/, '');
      base = 'sec:' + base.slice(0, 40);
      if (taken[base] == null || taken[base] === id) return base;
      var n = 2;
      while (taken[base + '-' + n] != null) n++;
      return base + '-' + n;
    }

    var result = null;
    sections.forEach(function (sec) {
      if (result || !sec || typeof sec.get !== 'function') return;
      if (sec.get('id') === anchorId) {
        var have = sec.get('ref_label');
        if (have) { result = have; return; }
        var lbl = slugFor(readSectionLabel(sec), anchorId);
        sec.doc.transact(function () { sec.set('ref_label', lbl); }, 'auto-sec-label');
        result = lbl;
        return;
      }
      var children = sec.get('children');
      if (!children || typeof children.forEach !== 'function') return;
      children.forEach(function (blk) {
        if (result || !blk || typeof blk.get !== 'function') return;
        if (blk.get('id') !== anchorId || blk.get('kind') !== 'subheading') return;
        var attrs = blk.get('attrs');
        if (!attrs || typeof attrs.get !== 'function') return;
        var had = attrs.get('ref_label');
        if (had) { result = had; return; }
        var bd = blk.get('body');
        var lbl2 = slugFor((bd && bd.toString) ? bd.toString() : '', anchorId);
        blk.doc.transact(function () { attrs.set('ref_label', lbl2); }, 'auto-sec-label');
        result = lbl2;
      });
    });
    return result;
  }

  /* Map of ref_label → {title, id} across sections + subheading blocks —
   * the anchors a [!sec:label] token can point at. */
  function getSectionRefTargets() {
    var map = {};
    var sections = state.sectionsArr;
    if (!sections || typeof sections.forEach !== 'function') return map;
    sections.forEach(function (sec) {
      if (!sec || typeof sec.get !== 'function') return;
      var rl = sec.get('ref_label');
      if (rl) map[String(rl)] = { title: readSectionLabel(sec), id: sec.get('id') };
      var children = sec.get('children');
      if (children && typeof children.forEach === 'function') {
        children.forEach(function (blk) {
          if (!blk || typeof blk.get !== 'function' || blk.get('kind') !== 'subheading') return;
          var a = blk.get('attrs');
          var brl = a && typeof a.get === 'function' && a.get('ref_label');
          if (brl) {
            var bd = blk.get('body');
            map[String(brl)] = { title: (bd && bd.toString) ? bd.toString() : String(bd || ''), id: blk.get('id') };
          }
        });
      }
    });
    return map;
  }

  /* V3.650 — the Write view shows REAL bullets, and Enter continues the
   * list. Alex: "it needs to display as bullet points. if i press enter at
   * the end the next bullet point shows up. All the standard rules apply."
   *
   * The trick that makes this safe: the marker is rendered as a **chip** —
   * `contenteditable="false"` with `data-src` holding its exact source
   * prefix ("  - " / "2. "). The editor already has one atomic-token
   * contract, and every source-mapping walker speaks it: `serializeChipDom`
   * contributes `data-src`, `readCaretCharOffset` counts `data-src.length`,
   * `setCaretCharOffset` / `_rangeFromCharOffset` treat it as an
   * indivisible unit, and `replaceParagraphRange` aligns ranges to it. So
   * the marker can look like a bullet, be uneditable, and still round-trip
   * to the exact source — with ZERO changes to the caret machinery, which
   * is the part of this editor least safe to touch.
   *
   * V3.649 showed the raw "- " instead; that read as loose prose, not a
   * list. */
  var _BULLET_GLYPHS = ['\u2022', '\u25E6', '\u25AA', '\u2023'];  // emoji-ok: a typographic list bullet, text presentation

  function renderChipsOnlyBodyHtml(text) {
    var PS = window.PaperSchemas;
    if (!PS || !PS.bodyHasList || !PS.listLineMatch || !PS.bodyHasList(text)) {
      return renderChipsOnlyHtml(text);
    }
    return String(text).split('\n').map(function (line) {
      var m = PS.listLineMatch(line);
      if (!m) return renderChipsOnlyHtml(line);
      var prefix = m.indent + line.slice(m.indent.length, m.indent.length + m.markerLength);
      var glyph = (m.listType === 'number')
        ? line.slice(m.indent.length, m.indent.length + m.markerLength).trim()
        : _BULLET_GLYPHS[Math.min(m.depth, _BULLET_GLYPHS.length - 1)];
      return '<span class="pe-src-li" data-list-depth="' + m.depth + '">' +
               '<span class="pe-li-mark" contenteditable="false" data-src="' +
                 escapeAttr(prefix) + '">' + escapeHtmlForCE(glyph) + '</span>' +
               renderChipsOnlyHtml(m.content) +
             '</span>';
    }).join('<br>');
  }

  /* V3.650 — the standard list keys, applied in SOURCE space and repainted,
   * rather than by mutating the live DOM: the source is the thing that has
   * to stay correct, and repainting through the same renderer guarantees
   * the DOM the caret walkers see is the one the renderer would produce.
   *
   * Enter        — new item at the same depth (empty item → leave the list)
   * Tab / S-Tab  — indent / outdent one level
   * Backspace    — at the very start of an item, outdent, then unlist
   *
   * Returns true when it handled the key. */
  function handleListKey(ev, el, repaint) {
    var PS = window.PaperSchemas;
    if (!PS || !PS.listLineMatch) return false;
    var key = ev.key;
    if (key !== 'Enter' && key !== 'Tab' && key !== 'Backspace') return false;
    if (ev.metaKey || ev.ctrlKey || ev.altKey) return false;
    if (key === 'Enter' && ev.shiftKey) return false;   // Shift+Enter = plain break

    var sel = window.getSelection();
    if (!sel || !sel.rangeCount) return false;
    if (!sel.getRangeAt(0).collapsed) return false;     // ranged edits: browser default

    var src = serializeChipDom(el);
    var caret = readCaretCharOffset(el);
    if (caret == null) return false;

    var lineStart = src.lastIndexOf('\n', Math.max(0, caret - 1)) + 1;
    var nlAt = src.indexOf('\n', caret);
    var lineEnd = (nlAt === -1) ? src.length : nlAt;
    var line = src.slice(lineStart, lineEnd);
    var m = PS.listLineMatch(line);
    if (!m) return false;                               // not in a list: default

    var head = src.slice(0, lineStart);
    var tail = src.slice(lineEnd);                      // starts with \n, or empty
    var next, nextLine, nextCol;
    /* Caret is tracked as (line index, column) across the renumber pass,
     * because renumbering can change the width of any marker ("9. " ->
     * "10. ") and a raw offset would drift. */
    var lineIdx = head ? head.split('\n').length - 1 : 0;

    if (key === 'Enter') {
      if (!m.content.trim()) {
        /* Empty item + Enter leaves the list — the item becomes a blank
         * prose line, exactly like every other editor. */
        next = head + tail;
        nextLine = lineIdx;
        nextCol = 0;
      } else {
        var marker = (m.listType === 'number') ? '1. ' : '- ';
        var carried = m.indent + marker;
        /* Split the item at the caret: text to the right of the caret moves
         * down to the new item, which is what Enter does mid-item. */
        var col = caret - lineStart;
        next = head + line.slice(0, col) + '\n' + carried + line.slice(col) + tail;
        nextLine = lineIdx + 1;
        nextCol = carried.length;
      }
    } else if (key === 'Tab') {
      if (ev.shiftKey && !m.indent.length) return false;   // already flush left
      if (!ev.shiftKey && m.depth >= 3) return false;      // parser caps nesting at 3
      var newIndent = ev.shiftKey ? m.indent.slice(2) : ('  ' + m.indent);
      next = head + newIndent + line.slice(m.indent.length) + tail;
      nextLine = lineIdx;
      nextCol = Math.max(0, (caret - lineStart) + (ev.shiftKey ? -2 : 2));
    } else {
      /* Backspace, only at the very start of the item's own text: outdent
       * one level, or strip the marker when already flush left. */
      if (caret !== lineStart + m.indent.length + m.markerLength) return false;
      if (m.indent.length) {
        next = head + m.indent.slice(2) + line.slice(m.indent.length) + tail;
        nextLine = lineIdx;
        nextCol = (caret - lineStart) - 2;
      } else {
        next = head + m.content + tail;
        nextLine = lineIdx;
        nextCol = 0;
      }
    }

    if (PS.renumberOrderedRuns) next = PS.renumberOrderedRuns(next);

    /* (line, col) -> absolute offset against the FINAL source. */
    var finalLines = next.split('\n');
    var offset = 0;
    for (var i = 0; i < Math.min(nextLine, finalLines.length - 1); i++) {
      offset += finalLines[i].length + 1;
    }
    offset += Math.min(nextCol, (finalLines[Math.min(nextLine, finalLines.length - 1)] || '').length);

    ev.preventDefault();
    repaint(next, offset);
    return true;
  }

  /* V3.649 — paragraph BODY renderer. `renderParagraphHtml` is the INLINE
   * contract (cites, math, markdown) and is reused for captions, table
   * cells, subheadings and list-block items — so list parsing must NOT go
   * in there: a list item's own text runs back through it and would
   * re-parse its own marker. This wrapper is the block-level layer, used
   * only where a paragraph body is rendered. Prose runs fall straight
   * through, so ordinary paragraphs are byte-identical to before. */
  function renderParagraphBodyHtml(text) {
    var PS = window.PaperSchemas;
    if (!PS || !PS.bodyHasList || !PS.bodyHasList(text)) {
      return renderParagraphHtml(text);
    }
    var runs = PS.parseBodyRuns(text);
    var out = '';
    runs.forEach(function (run) {
      if (run.type === 'prose') { out += renderParagraphHtml(run.text); return; }
      out += renderBodyListHtml(run);
    });
    return out;
  }

  /* Nested <ul>/<ol>; each item's text through the inline contract so
   * citations, math and chips work inside list items. */
  function renderBodyListHtml(run) {
    var tag = run.listType === 'number' ? 'ol' : 'ul';
    /* Both classes on purpose: `pe-body-list` is the editor's styling, and
     * `pdv-list` is what the Document view already styles AND names in its
     * SPLIT_GUARD_SEL — without it the column packer would be free to
     * break a page mid-list, which it deliberately avoids for the list
     * BLOCK. One renderer serves both surfaces, so it carries both hooks. */
    var cls = 'pe-body-list pdv-list';
    var html = '<' + tag + ' class="' + cls + '">';
    var depth = 0;
    run.items.forEach(function (it) {
      while (depth < it.depth) { html += '<' + tag + ' class="' + cls + '">'; depth++; }
      while (depth > it.depth) { html += '</' + tag + '>'; depth--; }
      html += '<li>' + renderParagraphHtml(it.text) + '</li>';
    });
    while (depth-- > 0) html += '</' + tag + '>';
    return html + '</' + tag + '>';
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
      /* V3.645 — [!val:KEY] paper-local value. */
      if (ch === '[' && text[i + 1] === '!' && text.slice(i + 2, i + 6) === 'val:') {
        var endValC = text.indexOf(']', i + 6);
        if (endValC > i + 6) {
          var valKeyC = text.slice(i + 6, endValC).trim();
          if (/^[A-Za-z0-9][\w-]*$/.test(valKeyC)) {
            out += renderValChip(valKeyC);
            i = endValC + 1;
            continue;
          }
        }
      }

      /* V3.645 — [@item:KEY] lab inventory item. MUST be tested BEFORE
       * the [@key] citation branch below: the citation validator allows
       * colons, so `[@item:24WP]` would otherwise parse as a citation
       * with key "item:24WP" and compile to an undefined \cite{}. */
      if (ch === '[' && text[i + 1] === '@' && text.slice(i + 2, i + 7) === 'item:') {
        var endItemC = text.indexOf(']', i + 7);
        if (endItemC > i + 7) {
          var itemKeyC = text.slice(i + 7, endItemC).trim();
          if (/^[A-Za-z0-9][\w-]*$/.test(itemKeyC)) {
            out += renderItemChip(itemKeyC);
            i = endItemC + 1;
            continue;
          }
        }
      }

      /* [@key] / [@k1; @k2] */
      if (ch === '[' && text[i + 1] === '@') {
        var endBracket = text.indexOf(']', i + 2);
        if (endBracket > i) {
          var inner = text.slice(i + 2, endBracket);
          if (/^\*?[\w:.\-+/]+(\s*;\s*@[\w:.\-+/]+)*$/.test(inner)) {  // V3.344 - optional leading * = narrative
            out += renderCitationChip(inner, i, endBracket + 1);
            i = endBracket + 1;
            continue;
          }
        }
      }
      /* V3.345 — [^text] footnote chip. */
      if (ch === '[' && text[i + 1] === '^') {
        var endFn = findFootnoteEnd(text, i + 2);
        if (endFn > i + 2) {
          var fnInner = text.slice(i + 2, endFn);
          out += renderFootnoteChip(fnInner, i, endFn + 1);
          i = endFn + 1;
          continue;
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
      /* [!sec:label] */
      if (ch === '[' && text[i + 1] === '!' && text.slice(i + 2, i + 6) === 'sec:') {
        var endSec2 = text.indexOf(']', i + 6);
        if (endSec2 > i + 6) {
          var secLabel2 = text.slice(i + 6, endSec2).trim();
          if (/^[\w:.\-]+$/.test(secLabel2)) {
            out += renderSecRefChip(secLabel2);
            i = endSec2 + 1;
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
  /* V3.649 — block elements are line breaks too.
   *
   * This used to recurse into every non-chip element with NO separator, so
   * `- a<div>- b</div>` serialized to `- a- b`. That matters because
   * pressing Enter in a contenteditable does not produce a <br> in Chrome
   * or Safari — it wraps the new line in a <div>. So every newline the
   * writer typed into a paragraph body was silently dropped on the way
   * back into the Y.Text: multi-line prose collapsed to one line, and a
   * typed list came back as "- a- b- c" all on one line, which is exactly
   * what Alex reported. (V3.649 also stops the divs being created at all —
   * see the Enter handler in bindYTextToContentEditable — but this has to
   * be correct anyway for content typed before that landed, and for paste.)
   */
  var _BLOCK_TAGS = {
    DIV: 1, P: 1, LI: 1, UL: 1, OL: 1, BLOCKQUOTE: 1, PRE: 1, SECTION: 1,
    ARTICLE: 1, H1: 1, H2: 1, H3: 1, H4: 1, H5: 1, H6: 1, TR: 1,
  };
  function serializeChipDom(node) {
    var acc = { s: '' };
    _serializeChipInto(node, acc, true);
    return acc.s;
  }
  function _serializeChipInto(node, acc, isRoot) {
    if (!node) return;
    if (node.nodeType === Node.TEXT_NODE) { acc.s += node.nodeValue || ''; return; }
    if (node.nodeType !== Node.ELEMENT_NODE) return;
    /* Atomic chip — its data-src is the canonical source token. */
    if (node.dataset && node.dataset.src) { acc.s += node.dataset.src; return; }
    if (node.tagName === 'BR') { acc.s += '\n'; return; }
    /* A block boundary starts a new line — unless we are at the very start
     * or the previous node already ended one (`text<br><div>x</div>` must
     * not produce a blank line). */
    if (!isRoot && _BLOCK_TAGS[node.tagName] &&
        acc.s && acc.s.charAt(acc.s.length - 1) !== '\n') {
      acc.s += '\n';
    }
    /* Recurse for any other element (e.g. <span> wrappers Chrome
     * sometimes inserts around composed text). */
    for (var i = 0; i < node.childNodes.length; i++) {
      _serializeChipInto(node.childNodes[i], acc, false);
    }
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
    /* V3.649 — chip mode (focused) has its own renderer so a paragraph body
     * can lay its list lines out while still showing editable source. */
    var chipFn = opts.renderChipsHtml || renderChipsOnlyHtml;
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

    /* V3.647 — survive the focus-time re-render with the caret where the
     * user actually clicked.
     *
     * The focus handler below replaces this element's innerHTML with
     * chip-mode HTML, which destroys the caret the browser had just placed
     * from the click. What's left is a selection collapsed at offset 0 —
     * or no selection at all, in which case paper-equations'
     * `_saveCaretFromCurrentFocus` falls back to the END of the paragraph.
     * Either way the next "Insert citation" lands somewhere the user never
     * pointed at: the "it bumps me off the location I'm trying to insert
     * at, and it happens when I click into the text the first time" half of
     * the bug. The click POINT survives the swap, so re-derive the caret
     * from it against the freshly rendered DOM. */
    var clickPt = null;    // last mousedown on this element
    var pendingPt = null;  // promoted by the focus handler; consumed on mouseup
    el.addEventListener('mousedown', function (ev) {
      if (opts.readOnly) return;
      clickPt = { x: ev.clientX, y: ev.clientY, t: Date.now() };
    });
    function applyCaretPoint(pt) {
      if (!pt || Date.now() - pt.t > 2000) return;
      var sel = window.getSelection();
      /* A drag-selection that survived the swap is the user's — leave it. */
      if (sel && sel.rangeCount && !sel.getRangeAt(0).collapsed &&
          el.contains(sel.getRangeAt(0).startContainer)) return;
      setCaretFromPoint(el, pt.x, pt.y);
    }

    el.addEventListener('focus', function () {
      /* V3.159 — show chip-mode HTML when focused so atomic
       * `[@cite]` / `[!eqi:…]` / `[!eqr:…]` / `[!fig:…]` / `[!tab:…]`
       * tokens render as their pretty chips even while editing. Source
       * is still tracked in `lastValue` (= yText.toString()); the
       * input handler reads source back via `serializeChipDom(el)`. */
      if (opts.readOnly) return;
      var src = yText.toString();
      el.innerHTML = chipFn(src);
      lastValue = src;
      el.dataset.empty = src ? 'false' : 'true';
      /* V3.218 — re-apply highlights on top of the chip-mode HTML so
       * commented spans stay visible while the user edits. */
      fireOnRendered();
      /* V3.647 — restore the caret the innerHTML above discarded, and
       * record the focus now instead of waiting for the first
       * keyup/mouseup (a Tab into the element never fires either). The
       * mouseup handler re-applies the same point afterwards, so the
       * browser's own default selection handling can't win the race. */
      pendingPt = clickPt;
      clickPt = null;
      applyCaretPoint(pendingPt);
      rememberFocus(el);
    });

    /* V3.157 — click on a rendered citation group opens the popover
     * in edit mode pre-filled with the group's existing keys. We
     * intercept on `mousedown` capture phase so the contenteditable's
     * default click-to-focus behavior doesn't run (and thereby trigger
     * the focus handler that would swap the rendered chip back to
     * source text before we can read its data-cite-* attributes). */
    el.addEventListener('mousedown', function (ev) {
      if (opts.readOnly) return;
      /* V3.345 — footnote chip → a text editor over the chip's source byte
       * range. Checked before the cite group since both are atomic chips
       * inside the same contenteditable.
       * V3.648 — edited in the picker's inline form anchored on the chip,
       * not a window.prompt box. */
      var fnEl = ev.target && ev.target.closest && ev.target.closest('.pe-footnote-chip');
      if (fnEl && el.contains(fnEl) && fnEl.dataset.fnSrcStart != null) {
        ev.preventDefault();
        ev.stopPropagation();
        var fnStart = parseInt(fnEl.dataset.fnSrcStart, 10);
        var fnEnd = parseInt(fnEl.dataset.fnSrcEnd, 10);
        var currentText = (fnEl.dataset.src || '').replace(/^\[\^/, '').replace(/\]$/, '');
        var fnRect = fnEl.getBoundingClientRect();
        if (!window.PaperEquations || !window.PaperEquations.openPicker) return;
        window.PaperEquations.openPicker(fnRect.left, fnRect.bottom + 6, {
          title: 'Footnote', emptyMsg: '', renderRowMode: 'plain', rows: [],
          form: {
            title: 'Edit footnote',
            fields: [{
              key: 'text', label: 'Note text', value: currentText,
              placeholder: 'Measured on the 2026-04 calibration.',
              hint: 'Clear the field and save to remove the footnote.',
            }],
            submitLabel: 'Save',
            backLabel: 'Cancel',
            onSubmit: function (vals, handle) {
              handle.close();
              var next = _sanitizeFootnoteText(vals.text);
              replaceParagraphRange(el, fnStart, fnEnd, next ? '[^' + next + ']' : '');
            },
          },
        });
        return;
      }
      /* V3.645 — value / inventory chip → the "where is this used"
       * fold-out. Same capture-phase reasoning as above: the chip's
       * data-* attributes are gone once focus swaps in chip-mode HTML. */
      var valEl = ev.target && ev.target.closest &&
        ev.target.closest('.pe-val-chip, .pe-item-chip');
      if (valEl && el.contains(valEl)) {
        var vKey = valEl.dataset.valKey || valEl.dataset.itemKey || '';
        if (vKey) {
          ev.preventDefault();
          ev.stopPropagation();
          window.dispatchEvent(new CustomEvent('paper-value-chip-click', {
            detail: { key: vKey, anchor: valEl },
          }));
          return;
        }
      }
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
    /* V3.649 — Enter must produce a <br>, not a <div>.
     *
     * Chrome and Safari wrap a new line in a <div>; the chip-mode renderer
     * emits <br>. Two things break when the DOM disagrees with the
     * renderer: `serializeChipDom` has to guess at block boundaries, and —
     * worse — `readCaretCharOffset` / `_rangeFromCharOffset` count a <br>
     * as one source character but a <div> boundary as zero, so every caret
     * offset past the first line was short by one per line. That silently
     * misplaced inserted citations and values in any multi-line paragraph.
     * Forcing the line break keeps the live DOM identical to what the
     * renderer would produce for the same source. */
    el.addEventListener('keydown', function (ev) {
      if (opts.readOnly) return;
      if (ev.defaultPrevented) return;
      /* V3.650 — Enter / Tab / Backspace inside a list line get the standard
       * list behaviour. Only bindings that opted into the body renderer have
       * lists at all, so the plain chip renderer is untouched. */
      if (opts.renderChipsHtml && handleListKey(ev, el, function (nextSrc, nextCaret) {
        el.innerHTML = chipFn(nextSrc);
        el.dataset.empty = nextSrc ? 'false' : 'true';
        setCaretCharOffset(el, nextCaret);
        /* The input handler diffs serializeChipDom(el) against lastValue and
         * writes the minimal Y.Text mutation — one path for every edit. */
        el.dispatchEvent(new InputEvent('input', { bubbles: true }));
        rememberFocus(el);
      })) return;
      if (ev.key !== 'Enter' || ev.shiftKey || ev.metaKey || ev.ctrlKey || ev.altKey) return;
      var ok = false;
      try { ok = document.execCommand('insertLineBreak'); } catch (e) { ok = false; }
      if (!ok) {
        try {
          var sel = window.getSelection();
          if (sel && sel.rangeCount) {
            var r = sel.getRangeAt(0);
            r.deleteContents();
            var br = document.createElement('br');
            r.insertNode(br);
            var after = document.createRange();
            after.setStartAfter(br);
            after.collapse(true);
            sel.removeAllRanges();
            sel.addRange(after);
            ok = true;
          }
        } catch (e2) { ok = false; }
      }
      if (!ok) return;                       // let the browser do its thing
      ev.preventDefault();
      el.dispatchEvent(new InputEvent('input', { bubbles: true }));
    });

    el.addEventListener('keyup',     function () { rememberFocus(el); });
    el.addEventListener('mouseup',   function () {
      /* V3.647 — the click that focused this element re-rendered it out
       * from under the browser's caret. Re-apply the click point here, once
       * the default mousedown/mouseup selection handling has finished. */
      if (pendingPt) { applyCaretPoint(pendingPt); pendingPt = null; }
      rememberFocus(el);
    });
    el.addEventListener('input',     function () { rememberFocus(el); }, true);

    el.addEventListener('blur', function () {
      // Re-render on blur using the provided renderFn.
      pendingPt = null;   // V3.647 — never replay a point into a later click
      clickPt = null;
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
        el.innerHTML = chipFn(newVal);
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
      /* V3.344 — `[@` included so numeric citation chips renumber when
       * citations are added/moved elsewhere in the doc. */
      /* V3.645 — `[!val:` added so a value edit repaints chips already
       * on screen. `[@item:` needs no entry: it is covered by the
       * `[@` test. Miss this and changing a value looks exactly like
       * the edit failed to save. */
      if (v.indexOf('[!eqi:') === -1 && v.indexOf('[!eqr:') === -1 && v.indexOf('[!fig:') === -1 && v.indexOf('[!tab:') === -1 && v.indexOf('[!val:') === -1 && v.indexOf('[@') === -1) return;
      applyRendered(el, v, renderFn, fireOnRendered);
    };
    window.addEventListener('paper-equations-changed', onEquationsChanged);
    /* V3.645 — the Values page fires its own event; same repaint. */
    window.addEventListener('paper-values-changed', onEquationsChanged);

    return function unbind() {
      yText.unobserve(observer);
      window.removeEventListener('paper-equations-changed', onEquationsChanged);
      window.removeEventListener('paper-values-changed', onEquationsChanged);
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

  /* V3.647 — place a collapsed caret at a viewport point inside `el`.
   *
   * Used to re-derive the caret after the focus-time chip-mode re-render
   * has thrown away the one the browser placed from the click. A point that
   * resolves inside an atomic chip is nudged to just after it: chips are
   * contenteditable=false and `readCaretCharOffset` counts them as
   * `data-src.length` without walking in, so a caret parked inside one
   * reads back as the wrong source offset. */
  function setCaretFromPoint(el, x, y) {
    var range = null;
    try {
      if (document.caretRangeFromPoint) {
        range = document.caretRangeFromPoint(x, y);
      } else if (document.caretPositionFromPoint) {
        var pos = document.caretPositionFromPoint(x, y);
        if (pos && pos.offsetNode) {
          range = document.createRange();
          range.setStart(pos.offsetNode, pos.offset);
        }
      }
    } catch (e) { return false; }
    if (!range || !el.contains(range.startContainer)) return false;
    range.collapse(true);
    var node = range.startContainer;
    var host = (node.nodeType === Node.ELEMENT_NODE) ? node : node.parentElement;
    var chip = (host && host.closest) ? host.closest('[data-src]') : null;
    if (chip && chip !== el && el.contains(chip)) {
      try { range.setStartAfter(chip); range.collapse(true); } catch (e) { return false; }
    }
    try {
      var sel = window.getSelection();
      sel.removeAllRanges();
      sel.addRange(range);
    } catch (e) { return false; }
    return true;
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

  /* V3.649 — bullet / numbered lists in a paragraph body.
   *
   * Unlike bold/italic this is a LINE operation, not a selection wrap: it
   * takes every line the selection touches, toggles the marker on all of
   * them, and writes the result back through `replaceParagraphRange` —
   * which already knows how to map source offsets across atomic chips, so
   * a line containing a citation survives being turned into a list item.
   *
   * Re-applying the same marker strips it, like every other toggle. */
  function toggleListAtSelection(type) {
    var PS = window.PaperSchemas;
    if (!PS || !PS.toggleListLines) return false;

    var el = null;
    var active = document.activeElement;
    if (active && active.isContentEditable) el = active;
    else if (lastFocusedEditable && document.body.contains(lastFocusedEditable)) el = lastFocusedEditable;
    if (!el) return false;

    var src = serializeChipDom(el);
    var off = readRangeCharOffsets(el);
    /* No live selection (the toolbar button was clicked after a blur) —
     * fall back to the remembered caret so the button still does something
     * sensible instead of silently no-opping. */
    var from = off ? off.start : (lastFocusedCaret || 0);
    var to = off ? off.end : from;
    if (to < from) { var tmp = from; from = to; to = tmp; }

    /* Grow the range to whole lines. */
    var lineStart = src.lastIndexOf('\n', Math.max(0, from - 1)) + 1;
    var nl = src.indexOf('\n', to);
    var lineEnd = (nl === -1) ? src.length : nl;

    var lines = src.slice(lineStart, lineEnd).split('\n');
    var next = PS.toggleListLines(lines, type).join('\n');
    if (next === src.slice(lineStart, lineEnd)) return false;

    replaceParagraphRange(el, lineStart, lineEnd, next);
    return true;
  }

  /* Both ends of the current selection as source-space char offsets, or
   * null when the selection isn't inside `el`. Mirrors
   * readCaretCharOffset's chip-aware walk for the START container too. */
  function readRangeCharOffsets(el) {
    var sel = window.getSelection();
    if (!sel || !sel.rangeCount) return null;
    var range = sel.getRangeAt(0);
    if (!el.contains(range.startContainer) || !el.contains(range.endContainer)) return null;
    function walk(target, targetOff) {
      var count = 0, done = false;
      function visit(parent) {
        for (var i = 0; i < parent.childNodes.length; i++) {
          if (done) return;
          var node = parent.childNodes[i];
          if (node === target && target.nodeType === Node.TEXT_NODE) {
            count += targetOff; done = true; return;
          }
          if (parent === target && i === targetOff) { done = true; return; }
          if (node.nodeType === Node.TEXT_NODE) {
            count += node.length;
          } else if (node.nodeType === Node.ELEMENT_NODE) {
            if (node.dataset && node.dataset.src) count += node.dataset.src.length;
            else if (node.tagName === 'BR') count += 1;
            else visit(node);
          }
        }
        if (parent === target && targetOff === parent.childNodes.length) done = true;
      }
      visit(el);
      return count;
    }
    return {
      start: walk(range.startContainer, range.startOffset),
      end: walk(range.endContainer, range.endOffset),
    };
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
  /* V3.645 — ONE traversal of every prose surface in the paper, shared
   * by getCitedKeysInPaper and getKeyUsages. Previously this walk was
   * inlined in getCitedKeysInPaper; a second hand-synced copy is
   * exactly how a key used in a table caption ends up invisible to the
   * usage panel while showing up fine in the bibliography.
   *
   * cb(text, meta) where meta = {sectionId, sectionLabel, blockId,
   * kind, field}. `field` distinguishes the several texts a single
   * block can own (body vs skeleton bullet vs table caption). */
  function walkProseTexts(cb) {
    if (!state.paperMap) return;
    var sections = state.paperMap.get('sections');
    if (!sections || typeof sections.forEach !== 'function') return;

    function yTextStr(y) {
      if (!y) return '';
      if (typeof y === 'string') return y;
      if (typeof y.toString === 'function') return y.toString();
      return '';
    }

    sections.forEach(function (secMap) {
      if (!secMap || typeof secMap.get !== 'function') return;
      var children = secMap.get('children');
      if (!children || typeof children.forEach !== 'function') return;
      var secKind = secMap.get('kind');
      var secLabel = secMap.get('label') ||
        (window.PaperSchemas.SECTION_KIND_LABELS || {})[secKind] || secKind || '';
      var secId = secMap.get('id') || '';

      children.forEach(function (blk) {
        if (!blk || typeof blk.get !== 'function') return;
        var kind = blk.get('kind');
        var blockId = blk.get('id') || '';
        function emit(text, field) {
          if (text) cb(text, {
            sectionId: secId, sectionLabel: secLabel,
            blockId: blockId, kind: kind, field: field,
          });
        }
        // body holds the prose for paragraphs / figure captions / subheadings / lists.
        if (kind === 'paragraph' || kind === 'figure' || kind === 'subheading' || kind === 'list') {
          emit(yTextStr(blk.get('body')), 'body');
        }
        // V3.115 — skeleton bullets carry their own text Y.Texts.
        if (kind === 'paragraph') {
          var skItems = blk.get('skeleton_items');
          if (skItems && typeof skItems.forEach === 'function') {
            skItems.forEach(function (it, idx) {
              if (it && typeof it.get === 'function') {
                emit(yTextStr(it.get('text')), 'skeleton:' + idx);
              }
            });
          }
          // Legacy skeleton Y.Text fallback.
          var legacy = blk.get('skeleton');
          if (legacy) emit(yTextStr(legacy), 'skeleton');
        }
        // V3.120 — table caption is now a Y.Text inside attrs.
        if (kind === 'table') {
          var attrs = blk.get('attrs');
          if (attrs && typeof attrs.get === 'function') {
            emit(yTextStr(attrs.get('caption')), 'caption');
          }
        }
      });
    });
  }

  function getCitedKeysInPaper() {
    var keys = Object.create(null);
    walkProseTexts(function (text) {
      var re = /\[@([^\]\n]+)\]/g;
      var m;
      while ((m = re.exec(text))) {
        /* V3.645 — `[@item:KEY]` is an inventory reference sharing the
         * citation namespace. Excluded here or it would show up on the
         * References page and in refs.bib as a phantom entry. */
        if (isItemToken(m[1])) continue;
        m[1].split(/\s*;\s*@?/).forEach(function (k) {
          /* V3.344 — a leading `*` (narrative citation) is not part of
           * the key. */
          k = (k || '').trim().replace(/^\*/, '');
          if (k && /^[\w:.\-+/]+$/.test(k)) keys[k] = true;
        });
      }
    });
    var arr = Object.keys(keys);
    arr.sort();
    return arr;
  }

  /* V3.645 — expand [start,end) out to the sentence containing it, in
   * the SOURCE text. Working on source (not rendered) text matters: a
   * resolved value like "0.5 µm" would otherwise create a false
   * sentence break at its decimal point. Bails to the whole paragraph
   * when no clean boundary is found. */
  function extractSentence(text, start, end) {
    var lo = 0, hi = text.length;
    var i;
    /* Backwards: a boundary is .!? followed by whitespace, where the
     * next non-space character starts a new sentence (uppercase, digit
     * or an opening bracket). The uppercase test is what keeps "e.g."
     * and "Fig." from splitting mid-sentence. */
    for (i = start - 1; i > 0; i--) {
      if (text[i] === '\n') { lo = i + 1; break; }
      if ('.!?'.indexOf(text[i]) >= 0 && /\s/.test(text[i + 1] || ' ')) {
        var j = i + 1;
        while (j < text.length && /\s/.test(text[j])) j++;
        var nxt = text[j];
        if (nxt && (nxt === nxt.toUpperCase()) && /[A-Za-z0-9[]/.test(nxt)) { lo = j; break; }
      }
    }
    /* Forwards: first .!? followed by whitespace or end of text. */
    for (i = end; i < text.length; i++) {
      if (text[i] === '\n') { hi = i; break; }
      if ('.!?'.indexOf(text[i]) >= 0) {
        var after = text[i + 1];
        if (after === undefined || /\s/.test(after)) { hi = i + 1; break; }
      }
    }
    var out = text.slice(lo, hi).trim();
    return out || text.trim();
  }

  /* V3.645 — every place each value key is used, for the fold-out
   * context panel. Returns { key: [ {sectionId, sectionLabel, blockId,
   * kind, field, offset, token, sentence} ] }. Both namespaces are
   * collected into one map because they share one table. */
  function getKeyUsages() {
    var byKey = Object.create(null);
    walkProseTexts(function (text, meta) {
      var re = /\[!val:([A-Za-z0-9][\w-]*)\]|\[@item:([A-Za-z0-9][\w-]*)\]/g;
      var m;
      while ((m = re.exec(text))) {
        var key = m[1] || m[2];
        if (!key) continue;
        (byKey[key] || (byKey[key] = [])).push({
          sectionId: meta.sectionId, sectionLabel: meta.sectionLabel,
          blockId: meta.blockId, kind: meta.kind, field: meta.field,
          offset: m.index, token: m[0],
          sentence: extractSentence(text, m.index, m.index + m[0].length),
        });
      }
    });
    return byKey;
  }

  window.PaperEditor = {
    bindYTextToContentEditable: bindYTextToContentEditable,
    bindYTextToInput: bindYTextToInput,
    textDiff: textDiff,
    renderParagraphHtml: renderParagraphHtml,
    renderParagraphBodyHtml: renderParagraphBodyHtml,   // V3.649
    renderChipsOnlyBodyHtml: renderChipsOnlyBodyHtml,   // V3.650
    serializeChipDom: serializeChipDom,                 // V3.649 (tests)
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
    toggleListAtSelection: toggleListAtSelection,   // V3.649
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
    /* V3.645 — value keys */
    isItemToken: isItemToken,
    itemKeyFromToken: itemKeyFromToken,
    getValueEntries: getValueEntries,
    getValueByKey: getValueByKey,
    resolveValueText: resolveValueText,
    getKeyUsages: getKeyUsages,
    walkProseTexts: walkProseTexts,
    addValueEntry: addValueEntry,
    updateValueEntry: updateValueEntry,
    deleteValueEntry: deleteValueEntry,
    loadCitationIndex: loadCitationIndex,
    invalidateCitationIndex: invalidateCitationIndex,
    ensureFreshCitationIndex: ensureFreshCitationIndex,   // V3.351
    fetchAbstract: fetchAbstract,                         // V3.351
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
    /* V3.416 — headless section API (Document-view Insert menu +
     * heading popover). Origins: add-section/delete-section/move-section. */
    addSection: addSection,
    deleteSection: deleteSection,
    moveSection: moveSection,
    getSectionsSummary: getSectionsSummary,
    /* V3.456 — appendix divider (Document view Insert menu uses these;
     * -1 = no divider). setAppendixBoundary(null) clears. */
    getAppendixBoundaryIdx: function () { return _appendixBoundaryIdx(state.sectionsArr ? state.sectionsArr.toArray() : []); },
    setAppendixBoundary: _setAppendixBoundary,
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
    /* V3.649 — section cross-reference picker data + label minting. */
    getSectionRefChoices: getSectionRefChoices,
    ensureSectionRefLabel: ensureSectionRefLabel,
    getLastFocusedEditable: function () { return lastFocusedEditable; },
    getLastFocusedCaret: function () { return lastFocusedCaret; },
    getCitationList: function () { return state.citationList || []; },
    /* Expose state.paperMap for paper-equations.js — a tiny accessor
     * keeps that module from poking into the editor's private state. */
    getPaperMap: function () { return state.paperMap; },
    /* V3.387 — Document view (paper-doc-view.js) dependencies: the
     * lazy KaTeX loader (math must be ready BEFORE page measurement)
     * and the papers.json row (default templateId fallback mirrors
     * paper-export.js _defaultConfig). */
    ensureKatex: ensureKatex,
    getPaperMeta: function () { return state.meta || {}; },
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
        onPickKeys: function (keys, narrative) { insertCitationKeysAtFocus(keys, { narrative: narrative }); },
      });
    }
  });

  // Re-render visible paragraphs once the citation index loads, so chips
  // get their author/year tooltip + label.
  //
  // V3.647 — repaint the chips IN PLACE; do not call render(). render()
  // tears down and rebuilds every section's DOM, so the paragraph the user
  // was about to cite into becomes a detached node: `lastFocusedEditable`
  // and paper-equations' `_state.savedEl` both point at it, the
  // `document.body.contains()` guard fails, and the next "Insert citation"
  // either alerts "place the cursor in a paragraph first" or silently goes
  // nowhere. That is the other half of the reported bug, and it fires
  // exactly when the user says it does — a just-placed citation is still in
  // key form precisely because the index hasn't loaded, so the load that
  // converts it to its short number form is the same load that used to
  // rebuild the document underneath them.
  //
  // Every binding already knows how to repaint itself for a changed
  // citation index (the `paper-equations-changed` listener re-renders any
  // source containing `[@`, and skips elements that are focused), so the
  // broadcast does the visible work without touching the DOM the caret
  // lives in.
  window.addEventListener('paper-citations-loaded', function () {
    try {
      window.dispatchEvent(new CustomEvent('paper-equations-changed'));
      window.dispatchEvent(new CustomEvent('paper-panel-changed'));
    } catch (e) { /* ignore */ }
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
