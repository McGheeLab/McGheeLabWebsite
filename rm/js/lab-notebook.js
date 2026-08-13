/* lab-notebook.js — Lab Notebook (ELN) page controller.
 *
 * Per-user, owner-only notebook stored at userData/{uid}/notebook/. The
 * `_index` doc holds a summary list for the left rail (single-read load);
 * full entries are loaded lazily on selection.
 *
 * Save recipe matches pmr.js:
 *   - 400ms debounce after every keystroke
 *   - _suppressUntil = now + 2500 to skip the user's own write echo
 *   - _savePending guards api.subscribe so a remote snapshot can't
 *     clobber an in-memory edit while the save is in flight
 *
 * Photo upload — three input paths all funnel through
 * NOTEBOOK_FIGURES.uploadImage(blob):
 *   1. Drag-drop anywhere over the editor pane.
 *   2. Paste — clipboard image MIME → upload → insert <img> at caret.
 *   3. Camera capture — hidden <input capture="environment"> opens the
 *      rear camera on phones; the killer feature for snapping a
 *      handwritten bench notebook page.
 *
 * Body images are always Firebase Storage URLs, never base64 — the
 * Firestore 1 MB doc limit would break otherwise. See the invariant
 * comment in notebook-schemas.js.
 *
 * V3.359–V3.362 (FuturePlan 10) — phone-native layout (rail drawer +
 * sticky action bar + keyboard handling + ＋Today), seamless input
 * (inline observation form + voice, tag autocomplete, slash menu,
 * surgical panel re-renders), experimental-design scaffolding (plan
 * panel, templates, ↻ next iteration, DOE results), and cross-entry
 * linking (entry picker, backlinks, excerpt search, rail phase chips).
 */

(function () {
  'use strict';

  // Build probe — if you do NOT see this in the console after a
  // hard reload, your browser is running cached (older) lab-notebook.js.
  // Hard-reload again or unregister the service worker.
  console.log('[lab-notebook] V3.362 build loaded at', new Date().toISOString());

  /* ─────────────────────────────────────────────────────────────
   * Constants & state
   * ───────────────────────────────────────────────────────────── */
  var INDEX_PATH = 'notebook/_index.json';
  var TEMPLATES_PATH = 'notebook/_templates.json';

  function entryPathFor(id) { return 'notebook/' + id + '.json'; }

  var state = {
    user: null,
    isAdmin: false,
    indexDoc: null,            // { entries: [{summary row}, ...] }
    templatesDoc: null,        // V3.361 — { templates: [{id,name,glyph,seed}] } (personal)
    currentId: null,
    doc: null,                 // full entry currently shown
    projects: [],              // [{id, label, type, member_uids}] from projects collection
    assignedProjectIds: null,  // Set<id> — projects where state.user.uid ∈ member_uids
    saveTimer: null,
    drawers: null,             // V3.359 — MOBILE_DRAWERS api (phone rail drawer)
    // V3.117 — toolbar is search-only. The project/tag/date dropdowns
    // were removed because the toolbar's job is finding existing
    // entries; project (and any other field) is set INSIDE the entry,
    // not on the bar. Search matches title + tags + project label so it
    // covers everything the dropdowns used to filter.
    // V3.362 — `phase` chips above the rail narrow by lifecycle stage.
    filters: { q: '', phase: '' },
  };

  /* V3.361 — built-in entry templates. Seeds are sanitizer-safe HTML
   * (p/h2/ul only) + tag sets + plan-panel prompts. Personal templates
   * saved from an entry live in the _templates doc (same shape) and are
   * sharable as .notebook-template.json files. */
  var NOTEBOOK_BUILTIN_TEMPLATES = [
    {
      id: 'tpl-cell-culture', name: 'Cell culture day', glyph: '🧫',
      seed: {
        tags: ['cell-culture', 'prep'],
        plan: { hypothesis: '', independent_vars: [], dependent_vars: ['confluence', 'viability'], controls: '', success_criteria: '' },
        body_html: '<h2>Cells</h2><p>Line / passage / vessel: </p><h2>Media &amp; feeds</h2><p></p><h2>Actions</h2><ul><li>Checked confluence: </li><li></li></ul>',
      },
    },
    {
      id: 'tpl-imaging', name: 'Imaging session', glyph: '🔬',
      seed: {
        tags: ['microscopy', 'imaging'],
        plan: { hypothesis: '', independent_vars: [], dependent_vars: [], controls: '', success_criteria: 'Usable images of all conditions' },
        body_html: '<h2>Scope &amp; settings</h2><p>Instrument / objective / channels / exposure: </p><h2>Samples</h2><ul><li></li></ul><h2>Notes during session</h2><p></p>',
      },
    },
    {
      id: 'tpl-synthesis', name: 'Synthesis / prep', glyph: '⚗️',
      seed: {
        tags: ['prep'],
        plan: { hypothesis: '', independent_vars: ['concentration'], dependent_vars: ['yield'], controls: '', success_criteria: '' },
        body_html: '<h2>Target</h2><p></p><h2>Reagents</h2><p>Insert inventory chips with 🧪 so hazards + locations attach.</p><h2>Procedure</h2><ul><li></li></ul>',
      },
    },
    {
      id: 'tpl-analysis', name: 'Analysis day', glyph: '📊',
      seed: {
        tags: ['analysis'],
        plan: { hypothesis: '', independent_vars: [], dependent_vars: [], controls: '', success_criteria: '' },
        body_html: '<h2>Dataset</h2><p>Source / date collected: </p><h2>Method</h2><p></p><h2>Results</h2><p></p><h2>Interpretation</h2><p></p>',
      },
    },
    {
      id: 'tpl-meeting', name: 'Meeting notes', glyph: '🗣',
      seed: {
        tags: ['meeting'],
        phase: 'complete',
        body_html: '<h2>Who / what</h2><p></p><h2>Decisions</h2><ul><li></li></ul><h2>Action items</h2><ul><li></li></ul>',
      },
    },
  ];

  // Inventory picker — lazily loaded on first click of the toolbar button.
  // Mirrors the paper-editor.js pattern: load BOTH inventory/items.json
  // (kind=item) and inventory/chemicals.json (kind=chemical), project into
  // a flat searchable list, build a single shared popover element.
  var inventoryState = { list: null, popover: null };

  // Protocol picker — same shape as inventoryState. Loaded lazily on
  // first toolbar click; chips render as <a> so clicking them jumps to
  // the protocol page (`/rm/pages/protocols.html?protocol=<id>`).
  var protocolState = { list: null, popover: null };

  // Live-sync gates (mirrors pmr.js / tasks-buckets.js recipe).
  var _suppressUntil = 0;
  var _liveUnsub = null;
  var _savePending = false;

  /* ─────────────────────────────────────────────────────────────
   * Helpers
   * ───────────────────────────────────────────────────────────── */
  function isoNow() { return new Date().toISOString(); }
  function todayStr() { return new Date().toISOString().slice(0, 10); }

  function escapeHtml(s) {
    return String(s == null ? '' : s)
      .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;').replace(/'/g, '&#39;');
  }

  function slugify(s, max) {
    var slug = String(s || '').toLowerCase()
      .replace(/[^a-z0-9\s-]+/g, ' ')
      .trim().split(/\s+/).slice(0, max || 4).join('-');
    return slug || 'untitled';
  }

  function newEntryId(date, title) {
    var base = 'nb-' + (date || todayStr()) + '-' + slugify(title || 'entry', 4);
    var taken = {};
    var entries = (state.indexDoc && state.indexDoc.entries) || [];
    entries.forEach(function (e) { taken[e.id] = true; });
    if (!taken[base]) return base;
    for (var i = 2; i < 99; i++) {
      var cand = base + '-' + i;
      if (!taken[cand]) return cand;
    }
    return base + '-' + Date.now().toString(36);
  }

  /* Lazy route registration for per-entry docs — entry IDs are unbounded. */
  function ensureEntryRoute(id) {
    var path = entryPathFor(id);
    if (api.getRoute && api.getRoute(path)) return;
    api.registerRoute(path, { scope: 'user', subcollection: 'notebook', doc: id });
  }

  function setSavingHint(text) {
    var el = document.getElementById('ln-saving');
    if (el) el.textContent = text || '';
  }

  /* V3.360 — TOAST when loaded, saving-hint fallback otherwise. Errors
   * fall back to alert so failures are never silent. */
  function lnNotify(kind, msg, detail) {
    if (window.TOAST && typeof TOAST[kind] === 'function') {
      TOAST[kind](msg, detail ? { detail: detail } : undefined);
      return;
    }
    if (kind === 'error') alert(msg + (detail ? '\n\n' + detail : ''));
    else setSavingHint(msg);
  }

  /* V3.360 — promise prompt: RM_DIALOG when loaded, window.prompt
   * fallback. Resolves null on cancel (both paths). */
  function lnPrompt(opts) {
    if (window.RM_DIALOG && RM_DIALOG.prompt) return RM_DIALOG.prompt(opts);
    var v = prompt((opts && opts.title) || 'Enter a value', (opts && opts.value) || '');
    return Promise.resolve(v === null ? null : String(v).trim() || null);
  }

  /* ─────────────────────────────────────────────────────────────
   * V3.361 — personal templates doc (userData/{uid}/notebook/_templates)
   * ───────────────────────────────────────────────────────────── */
  function ensureTemplatesRoute() {
    if (api.getRoute && api.getRoute(TEMPLATES_PATH)) return;
    api.registerRoute(TEMPLATES_PATH, { scope: 'user', subcollection: 'notebook', doc: '_templates' });
  }

  async function loadTemplatesDoc() {
    try {
      ensureTemplatesRoute();
      var d = await api.load(TEMPLATES_PATH);
      if (!d || !Array.isArray(d.templates)) d = { templates: [] };
      state.templatesDoc = d;
    } catch (err) {
      console.warn('[lab-notebook] templates load failed:', err && err.message);
      state.templatesDoc = { templates: [] };
    }
  }

  async function saveTemplatesDoc() {
    try {
      ensureTemplatesRoute();
      await api.save(TEMPLATES_PATH, state.templatesDoc || { templates: [] });
    } catch (err) {
      console.error('[lab-notebook] templates save failed:', err);
      lnNotify('error', 'Could not save template', err && err.message);
    }
  }

  /* ─────────────────────────────────────────────────────────────
   * Body HTML sanitizer — defensive allowlist, runs before save.
   * Keeps image src only when pointing at firebasestorage.googleapis.com
   * so a paste of a remote img can't bypass our Storage upload pipeline.
   * ───────────────────────────────────────────────────────────── */
  var ALLOWED_TAGS = {
    P: 1, BR: 1, DIV: 1, SPAN: 1,
    STRONG: 1, B: 1, EM: 1, I: 1, U: 1, S: 1,
    UL: 1, OL: 1, LI: 1,
    H1: 1, H2: 1, H3: 1, H4: 1, H5: 1, H6: 1,
    BLOCKQUOTE: 1, CODE: 1, PRE: 1,
    A: 1, IMG: 1,
    TABLE: 1, THEAD: 1, TBODY: 1, TR: 1, TD: 1, TH: 1,
  };
  var ALLOWED_ATTRS = {
    // V3.115 — `class` + `data-protocol-*` allowed on <a> so a protocol
    // chip can render as a real link (clickable; jumps to the protocol
    // page in the same tab) while still being sanitized like every
    // other anchor (href safety, javascript:/data: rejection). The
    // class attr is restricted to the literal value `ln-protocol-chip`
    // post-strip (see sanitizeNode A branch).
    A:    ['href', 'title', 'target', 'rel', 'class',
           'data-protocol-id', 'data-protocol-title', 'contenteditable'],
    IMG:  ['src', 'alt', 'data-storage-path', 'data-hash'],
    // Inline inventory mention chip — tracked by data-inv-id so post-save
    // we can rebuild the entry's inventory_refs[] list. `class` is kept
    // only when its exact value is `ln-inv-chip` (sanitized below).
    SPAN: ['class', 'data-inv-id', 'data-inv-kind', 'data-inv-name',
           'data-inv-vendor', 'data-inv-cat', 'data-inv-cas',
           // V3.119 — chemical hazard surface stamped onto chips
           'data-inv-hazard-signal', 'data-inv-hazard-pictos',
           'data-inv-locations', 'data-inv-storage',
           // V3.135 — `proto-var` calculator chip (class = proto-var
           // [+ proto-var-{computed,unknown,error}]); needs data-var
           // (variable name) and title (tooltip).
           'data-var',
           'contenteditable', 'title'],
    // V3.135 — DIV is the wrapper for inserted calculator blocks
    // (.ln-calc[ ln-calc-{snippet,table,steps}]). The block carries
    // data-calc-id so click-to-re-edit can find the matching
    // state.doc.calc_runs[] entry. contenteditable=false pins the
    // block as a single non-editable atom so the body doesn't
    // splinter when the user types around it.
    DIV:  ['class', 'data-calc-id', 'data-calc-protocol-id',
           'data-calc-format', 'contenteditable'],
  };

  function isSafeUrl(href) {
    if (!href) return false;
    var s = String(href).trim().toLowerCase();
    if (s.indexOf('javascript:') === 0) return false;
    if (s.indexOf('data:') === 0) return false;
    if (s.indexOf('vbscript:') === 0) return false;
    return true;
  }

  function isSafeImgSrc(src) {
    if (!src) return false;
    var s = String(src).trim().toLowerCase();
    if (s.indexOf('https://firebasestorage.googleapis.com/') === 0) return true;
    if (s.indexOf('blob:') === 0) return true; // transient — we replace with storage URL post-upload
    return false;
  }

  function sanitizeNode(node) {
    var children = Array.prototype.slice.call(node.childNodes);
    children.forEach(function (child) {
      if (child.nodeType === 8 /* comment */) {
        node.removeChild(child);
        return;
      }
      if (child.nodeType !== 1) return;
      if (!ALLOWED_TAGS[child.tagName]) {
        // Replace disallowed element with its children (preserves text)
        while (child.firstChild) node.insertBefore(child.firstChild, child);
        node.removeChild(child);
        return;
      }
      // Strip all attributes except those allowlisted for this tag.
      var keep = ALLOWED_ATTRS[child.tagName] || [];
      Array.prototype.slice.call(child.attributes).forEach(function (a) {
        if (keep.indexOf(a.name) < 0) child.removeAttribute(a.name);
      });
      // Per-attr URL safety.
      if (child.tagName === 'A') {
        if (!isSafeUrl(child.getAttribute('href'))) child.removeAttribute('href');
        // Force safe link rels for offsite hrefs.
        var href = child.getAttribute('href') || '';
        if (/^https?:/i.test(href)) {
          child.setAttribute('target', '_blank');
          child.setAttribute('rel', 'noopener noreferrer');
        }
        // Restrict class to the protocol-chip literal; drop anything else
        // a paste might leave behind. Pin contenteditable=false on chips.
        var aClass = child.getAttribute('class');
        if (aClass !== 'ln-protocol-chip') child.removeAttribute('class');
        if (child.getAttribute('class') === 'ln-protocol-chip') {
          child.setAttribute('contenteditable', 'false');
        } else {
          child.removeAttribute('contenteditable');
        }
      }
      if (child.tagName === 'IMG') {
        if (!isSafeImgSrc(child.getAttribute('src'))) child.removeAttribute('src');
      }
      // SPAN class is restricted to a small allowlist. Any other class
      // (e.g. one a paste of styled text leaves behind) is dropped so
      // arbitrary CSS can't bleed in. The allowlist covers:
      //   - ln-inv-chip                       (V3.114 chip)
      //   - ln-inv-hazard                     (V3.119 hazard sibling)
      //   - ln-hazard-signal …                (V3.119 Danger/Warning pill)
      //   - ln-ghs ln-ghs-ghsXX               (V3.119 pictogram badge)
      //   - proto-var [proto-var-{computed,unknown,error}]
      //                                       (V3.135 calc-result chip)
      //   - ln-calc-edit-hint                 (V3.135 hover affordance)
      if (child.tagName === 'SPAN') {
        var cls = child.getAttribute('class') || '';
        var allowed = false;
        if (cls === 'ln-inv-chip') allowed = true;
        else if (cls === 'ln-inv-hazard') allowed = true;
        else if (/^ln-hazard-signal ln-hazard-signal-(danger|warning)$/.test(cls)) allowed = true;
        else if (/^ln-ghs ln-ghs-ghs0[1-9]$/.test(cls)) allowed = true;
        else if (/^proto-var( proto-var-(computed|unknown|error))?$/.test(cls)) allowed = true;
        else if (cls === 'ln-calc-edit-hint') allowed = true;
        if (!allowed) child.removeAttribute('class');
        // Pin contenteditable=false on inventory chips + hazard
        // siblings + proto-var calc chips so the caret can't land
        // mid-element and corrupt their data attrs across edits.
        var clsNow = child.getAttribute('class') || '';
        if (clsNow === 'ln-inv-chip' || clsNow === 'ln-inv-hazard' ||
            /^proto-var( proto-var-(computed|unknown|error))?$/.test(clsNow)) {
          child.setAttribute('contenteditable', 'false');
        } else {
          child.removeAttribute('contenteditable');
        }
      }
      // V3.135 — DIV class is restricted to the calculator-block
      // wrapper. Any other class on a div (e.g. one left over from a
      // paste of styled HTML) is stripped. contenteditable=false is
      // force-pinned on .ln-calc containers so the body can't have
      // its inner content typed into mid-block.
      if (child.tagName === 'DIV') {
        var dcls = child.getAttribute('class') || '';
        if (!/^ln-calc( ln-calc-(snippet|table|steps))?$/.test(dcls)) {
          child.removeAttribute('class');
          child.removeAttribute('contenteditable');
          // Drop the calc-related data attrs too — without the class
          // they're meaningless and just clutter.
          child.removeAttribute('data-calc-id');
          child.removeAttribute('data-calc-protocol-id');
          child.removeAttribute('data-calc-format');
        } else {
          child.setAttribute('contenteditable', 'false');
        }
      }
      sanitizeNode(child);
    });
  }

  function sanitizeHtml(html) {
    var wrap = document.createElement('div');
    wrap.innerHTML = String(html || '');
    sanitizeNode(wrap);
    return wrap.innerHTML;
  }

  function plainTextFromHtml(html) {
    var wrap = document.createElement('div');
    wrap.innerHTML = String(html || '');
    return (wrap.textContent || wrap.innerText || '').replace(/\s+/g, ' ').trim();
  }

  /* ─────────────────────────────────────────────────────────────
   * Index doc + entry load/save
   * ───────────────────────────────────────────────────────────── */
  async function loadIndex() {
    try {
      var d = await api.load(INDEX_PATH);
      if (!d || !Array.isArray(d.entries)) d = { entries: [] };
      state.indexDoc = d;
    } catch (err) {
      console.warn('[lab-notebook] index load failed:', err && err.message);
      state.indexDoc = { entries: [] };
    }
  }

  async function saveIndex() {
    try {
      await api.save(INDEX_PATH, state.indexDoc);
      refreshPulse();
    } catch (err) {
      console.error('[lab-notebook] index save failed:', err);
    }
  }

  /* V3.362 — keep the toolbar pulse line fresh without re-rendering the
   * toolbar (which would eat the search box's focus). */
  function refreshPulse() {
    var el = document.querySelector('.ln-toolbar .ln-pulse');
    if (!el) return;
    var pulse = weeklyPulse();
    el.textContent = pulse.week + ' this week' + (pulse.streak > 1 ? ' · ' + pulse.streak + '-day streak' : '');
  }

  function upsertIndexRow(entry) {
    if (!state.indexDoc) state.indexDoc = { entries: [] };
    var row = notebookIndexRow(entry);
    var arr = state.indexDoc.entries;
    var i = arr.findIndex(function (e) { return e.id === entry.id; });
    if (i >= 0) arr[i] = row; else arr.push(row);
  }

  function removeIndexRow(id) {
    if (!state.indexDoc) return;
    state.indexDoc.entries = (state.indexDoc.entries || []).filter(function (e) {
      return e.id !== id;
    });
  }

  async function loadEntry(id) {
    ensureEntryRoute(id);
    try {
      var doc = await api.load(entryPathFor(id));
      if (!doc || !doc.id) return null;
      return notebookHydrate(doc);
    } catch (err) {
      console.warn('[lab-notebook] entry load failed:', err && err.message);
      return null;
    }
  }

  function scheduleSave() {
    if (state.saveTimer) clearTimeout(state.saveTimer);
    _savePending = true;
    state.saveTimer = setTimeout(function () {
      saveEntry().catch(function (err) {
        console.error('[lab-notebook] save failed:', err);
      });
    }, 400);
  }

  async function saveEntry() {
    if (!state.doc || !state.currentId) { _savePending = false; return; }
    state.doc.updated_at = isoNow();
    state.doc.body_text = plainTextFromHtml(state.doc.body_html);
    _suppressUntil = Date.now() + 2500;
    state.saveTimer = null;
    setSavingHint('saving…');
    try {
      ensureEntryRoute(state.currentId);
      await api.save(entryPathFor(state.currentId), state.doc);
      upsertIndexRow(state.doc);
      await saveIndex();
      _savePending = false;
      setSavingHint('saved ' + new Date().toLocaleTimeString());
      // V3.319 — lightweight activity event (FuturePlan 04 B1). One event
      // per entry per day, idempotent via the deterministic doc id; no
      // hours, no confirm. Reintroduces the producer V3.226 removed.
      if (window.ActivitySignals) {
        ActivitySignals.recordWork({
          source: 'rm-notebook',
          sourceRef: { kind: 'notebook', id: state.currentId },
          text: 'Notebook: ' + (state.doc.title || '(untitled)'),
          categoryPath: ['research', 'notebook'],
        });
      }
    } catch (err) {
      setSavingHint('save failed');
      _savePending = false;
      throw err;
    }
  }

  /* V3.161 — flag a notebook figure for review at the student's next PMR.
   * Dual-write: notebook.pmr_review_figures[] + pmr.{periodId}.figure_reviews[].
   * The student is the owner of both docs so cross-collection writes are
   * within their session's auth. Best-effort: failures surface a toast
   * but don't break the notebook edit flow. */
  async function togglePmrFlagOnFigure(idx) {
    try {
      if (!state.doc) return;
      var atts = state.doc.attachments || [];
      var att = atts[idx];
      if (!att || att.kind !== 'image' || !att.storage_path) return;

      state.doc.pmr_review_figures = state.doc.pmr_review_figures || [];
      var existingIdx = state.doc.pmr_review_figures.findIndex(function (f) {
        return f && f.storage_path === att.storage_path;
      });

      if (existingIdx >= 0) {
        // Unflag: remove from notebook + PMR.
        var gone = state.doc.pmr_review_figures.splice(existingIdx, 1)[0];
        if (gone && gone.period_id && gone.figure_review_id) {
          await removeFigureReviewFromPmr(gone.period_id, gone.figure_review_id);
        }
        setSavingHint('unflagged for PMR');
      } else {
        var period = await resolveNextPmrPeriod();
        if (!period) {
          alert('No PMR period found. Create one on the PMR page first, then try again.');
          return;
        }
        var frId = 'fr-' + Date.now().toString(36) + '-' + Math.random().toString(36).slice(2, 6);
        var flaggedAt = isoNow();
        // V3.161 — resolve the download URL now while the student is signed
        // in. Storage rules deny admin read on notebook-figures, but a
        // download URL carries a long-lived access token so the admin can
        // render the image when viewing the PMR. Trade-off: anyone with
        // the URL can fetch the bytes — acceptable for lab-internal usage.
        var imageUrl = null;
        try {
          imageUrl = await firebase.storage().ref(att.storage_path).getDownloadURL();
        } catch (urlErr) {
          console.warn('[lab-notebook] download URL resolve failed:', urlErr);
        }
        var fr = {
          id: frId,
          storage_path: att.storage_path,
          image_url: imageUrl,
          notebook_entry_id: state.doc.id,
          notebook_title: state.doc.title || '(untitled)',
          notebook_date: state.doc.date || todayStr(),
          caption: att.caption || '',
          flagged_at: flaggedAt,
        };
        state.doc.pmr_review_figures.push({
          storage_path: att.storage_path,
          period_id: period.id,
          flagged_at: flaggedAt,
          figure_review_id: frId,
        });
        await writeFigureReviewToPmr(period.id, fr);
        setSavingHint('flagged for PMR: ' + (period.label || period.id));
      }
      renderAttachmentsPanel();
      scheduleSave();
    } catch (err) {
      console.error('[lab-notebook] togglePmrFlagOnFigure failed:', err);
      setSavingHint('PMR flag failed');
    }
  }

  /* Drop any matching PMR figure-review when an attachment is deleted. */
  async function removePmrFlagForFigure(storagePath) {
    try {
      if (!state.doc || !state.doc.pmr_review_figures) return;
      var i = state.doc.pmr_review_figures.findIndex(function (f) {
        return f && f.storage_path === storagePath;
      });
      if (i < 0) return;
      var gone = state.doc.pmr_review_figures.splice(i, 1)[0];
      if (gone && gone.period_id && gone.figure_review_id) {
        await removeFigureReviewFromPmr(gone.period_id, gone.figure_review_id);
      }
    } catch (err) {
      console.warn('[lab-notebook] removePmrFlagForFigure failed:', err);
    }
  }

  /* Resolve the PMR period to flag into. Strategy:
   *   1. Most recent draft period in pmr/_index → that's the active 1:1.
   *   2. Else most recent period of any status (fallback for already-submitted).
   *   3. Else null — caller should prompt the user to create one.
   */
  async function resolveNextPmrPeriod() {
    try {
      var u = (typeof firebridge !== 'undefined' && firebridge.getUser) ? firebridge.getUser() : null;
      if (!u || !u.uid) return null;
      var snap = await firebridge.db()
        .collection('userData').doc(u.uid)
        .collection('pmr').doc('_index').get();
      if (!snap.exists) return null;
      var data = snap.data() || {};
      var periods = Array.isArray(data.periods) ? data.periods.slice() : [];
      if (!periods.length) return null;
      // Sort by updated_at descending.
      periods.sort(function (a, b) {
        return String(b.updated_at || '').localeCompare(String(a.updated_at || ''));
      });
      var draft = periods.find(function (p) { return p.status === 'draft'; });
      return draft || periods[0];
    } catch (err) {
      console.warn('[lab-notebook] resolveNextPmrPeriod failed:', err);
      return null;
    }
  }

  async function writeFigureReviewToPmr(periodId, fr) {
    var u = firebridge.getUser();
    if (!u || !u.uid) throw new Error('not signed in');
    var ref = firebridge.db()
      .collection('userData').doc(u.uid)
      .collection('pmr').doc(periodId);
    await ref.set({
      figure_reviews: firebase.firestore.FieldValue.arrayUnion(fr),
      updated_at: isoNow(),
    }, { merge: true });
  }

  async function removeFigureReviewFromPmr(periodId, figureReviewId) {
    var u = firebridge.getUser();
    if (!u || !u.uid) return;
    var ref = firebridge.db()
      .collection('userData').doc(u.uid)
      .collection('pmr').doc(periodId);
    // arrayRemove on a complex object requires the exact same shape — we
    // don't have it, so read-modify-write instead.
    var snap = await ref.get();
    if (!snap.exists) return;
    var data = snap.data();
    var arr = Array.isArray(data.figure_reviews) ? data.figure_reviews : [];
    var next = arr.filter(function (fr) { return fr && fr.id !== figureReviewId; });
    if (next.length === arr.length) return; // nothing matched
    await ref.set({
      figure_reviews: next,
      updated_at: isoNow(),
    }, { merge: true });
  }

  function attachLiveSync() {
    if (_liveUnsub || typeof api.subscribe !== 'function' || !state.currentId) return;
    try {
      _liveUnsub = api.subscribe(entryPathFor(state.currentId), function (data) {
        if (Date.now() < _suppressUntil) return;
        if (_savePending) return;
        if (!data || !data.id) return;
        state.doc = notebookHydrate(data);
        renderEditor();
      });
    } catch (err) {
      console.warn('[lab-notebook] live sync failed:', err && err.message);
    }
  }

  function detachLiveSync() {
    if (_liveUnsub) { try { _liveUnsub(); } catch (_) {} _liveUnsub = null; }
  }

  /* ─────────────────────────────────────────────────────────────
   * Projects (for the picker dropdown)
   * ───────────────────────────────────────────────────────────── */
  /* Each project source maps to a typed JSON path that the adapter shards
   * back into the same `projects` Firestore collection (discriminated by
   * `type`). We capture `member_uids[]` so the Lab Notebook can filter
   * the in-entry project picker to projects assigned to the current
   * user (V3.117 requirement: students should only see their own
   * projects). The path string is preserved so the admin Members modal
   * can save back to the right typed JSON. */
  var PROJECT_SOURCES = [
    { path: 'projects/papers.json',         key: 'papers',         label: 'paper' },
    { path: 'projects/courses.json',        key: 'courses',        label: 'course' },
    { path: 'projects/infrastructure.json', key: 'infrastructure', label: 'infra' },
    { path: 'projects/tools.json',          key: 'tools',          label: 'tool' },
  ];

  async function loadProjects() {
    var out = [];
    await Promise.all(PROJECT_SOURCES.map(async function (src) {
      try {
        var d = await api.load(src.path);
        var rows = (d && d[src.key]) || [];
        rows.forEach(function (r) {
          if (!r || !r.id) return;
          out.push({
            id: r.id,
            label: r.title || r.name || r.id,
            type: src.label,
            sourcePath: src.path,
            sourceKey: src.key,
            member_uids: Array.isArray(r.member_uids) ? r.member_uids.slice() : [],
          });
        });
      } catch (_) { /* missing JSON / permission shrug */ }
    }));
    out.sort(function (a, b) { return (a.label || '').localeCompare(b.label || ''); });
    state.projects = out;
    rebuildAssignedProjectIds();
  }

  function rebuildAssignedProjectIds() {
    var uid = state.user && state.user.uid;
    if (!uid) { state.assignedProjectIds = new Set(); return; }
    state.assignedProjectIds = new Set(
      state.projects
        .filter(function (p) { return (p.member_uids || []).indexOf(uid) >= 0; })
        .map(function (p) { return p.id; })
    );
  }

  /* Projects to show in the in-entry picker. Admin sees everything (so
   * they can pick any project for their own entries). Non-admin sees
   * only projects where their uid is in member_uids[]. The currently
   * selected project_id (if set) is always included even if the user
   * is no longer a member — so a stale assignment doesn't make their
   * already-saved selection vanish. */
  function visibleProjectsForPicker() {
    if (state.isAdmin) return state.projects;
    var assigned = state.assignedProjectIds || new Set();
    var current = state.doc && state.doc.project_id;
    return state.projects.filter(function (p) {
      return assigned.has(p.id) || (current && p.id === current);
    });
  }

  function projectLabel(id) {
    if (!id) return '';
    var p = state.projects.find(function (x) { return x.id === id; });
    return p ? p.label : id;
  }

  /* ─────────────────────────────────────────────────────────────
   * Filter pipeline
   * ───────────────────────────────────────────────────────────── */
  function filteredIndexRows() {
    var rows = (state.indexDoc && state.indexDoc.entries) || [];
    var q = (state.filters.q || '').toLowerCase().trim();
    var phase = state.filters.phase || '';
    return rows
      .filter(function (r) {
        // V3.362 — phase chip filter above the rail.
        if (phase && (r.phase || 'complete') !== phase) return false;
        if (!q) return true;
        // Match across title, tags, project label, status, date, and
        // (V3.362) the body excerpt — so searching content, not just
        // metadata, narrows the rail.
        var hay = (r.title || '') + ' ' +
                  (Array.isArray(r.tags) ? r.tags.join(' ') : '') + ' ' +
                  projectLabel(r.project_id) + ' ' +
                  (r.status || '') + ' ' +
                  (r.date || '') + ' ' +
                  (r.excerpt || '');
        return hay.toLowerCase().indexOf(q) >= 0;
      })
      .slice()
      .sort(function (a, b) { return (b.date || '').localeCompare(a.date || ''); });
  }

  /* V3.362 — weekly pulse: entries in the last 7 days + consecutive-day
   * streak ending today or yesterday. Computed from index dates only. */
  function weeklyPulse() {
    var rows = (state.indexDoc && state.indexDoc.entries) || [];
    var dates = {};
    rows.forEach(function (r) { if (r.date) dates[r.date] = true; });
    var now = new Date();
    var week = 0;
    for (var i = 0; i < 7; i++) {
      var d = new Date(now); d.setDate(now.getDate() - i);
      if (dates[d.toISOString().slice(0, 10)]) week++;
    }
    var streak = 0;
    var cursor = new Date(now);
    if (!dates[cursor.toISOString().slice(0, 10)]) cursor.setDate(cursor.getDate() - 1); // streak may end yesterday
    while (dates[cursor.toISOString().slice(0, 10)]) {
      streak++;
      cursor.setDate(cursor.getDate() - 1);
    }
    return { week: week, streak: streak };
  }

  /* ─────────────────────────────────────────────────────────────
   * Toolbar render
   * ───────────────────────────────────────────────────────────── */
  function renderToolbar() {
    var bar = document.getElementById('ln-toolbar');
    if (!bar) return;
    // V3.117 — toolbar is search-only. Tag / project / date inputs
    // moved INTO the entry editor (where they belong as data input).
    // The toolbar exists to find existing entries; one search box
    // covers title, tags, project name, status, and date substrings.
    // V3.126 — admin Members modal moved out: project membership
    // is now managed canonically on /rm/pages/projects.html so the
    // assignment propagates everywhere member_uids[] is read.
    // V3.359 — ☰ Entries (phone drawer toggle) + ＋ Today one-tap entry.
    // V3.361 — New is a split button: main click = blank entry, ▾ opens
    // the template menu (built-ins, personal, clone, save, import).
    // V3.362 — weekly pulse line.
    var pulse = weeklyPulse();
    var pulseHtml = (state.indexDoc && (state.indexDoc.entries || []).length)
      ? '<span class="ln-pulse" title="Entries in the last 7 days · consecutive-day streak">' +
          pulse.week + ' this week' + (pulse.streak > 1 ? ' · ' + pulse.streak + '-day streak' : '') +
        '</span>'
      : '';
    bar.innerHTML =
      '<button id="ln-drawer-toggle" class="ln-drawer-toggle" title="Show entries" aria-label="Show entries">☰</button>' +
      '<span class="ln-new-split">' +
        '<button id="ln-new" class="primary">+ New</button>' +
        '<button id="ln-new-menu-btn" class="primary ln-new-caret" title="New from template, clone, import…" aria-label="New entry options">▾</button>' +
      '</span>' +
      '<button id="ln-today" title="Jump to (or create) today\'s entry">＋ Today</button>' +
      '<input id="ln-f-q" type="search" placeholder="Search title, tag, project, content…" value="' + escapeHtml(state.filters.q) + '" autocomplete="off">' +
      '<span class="grow"></span>' +
      pulseHtml +
      '<span id="ln-saving" class="saving-hint"></span>';

    document.getElementById('ln-new').addEventListener('click', function () { onNewEntry(); });
    document.getElementById('ln-new-menu-btn').addEventListener('click', function (e) {
      openNewEntryMenu(e.currentTarget);
    });
    document.getElementById('ln-today').addEventListener('click', openTodayEntry);
    document.getElementById('ln-f-q').addEventListener('input', function (e) {
      state.filters.q = e.target.value; renderRail();
    });
    var drawerBtn = document.getElementById('ln-drawer-toggle');
    if (drawerBtn) drawerBtn.addEventListener('click', function () {
      if (state.drawers) state.drawers.toggle('left');
    });
  }

  /* V3.359 — one-tap today: open today's entry if it exists (most recent
   * one dated today), else create a fresh entry dated today. */
  async function openTodayEntry() {
    var today = todayStr();
    var rows = ((state.indexDoc && state.indexDoc.entries) || []).filter(function (r) { return r.date === today; });
    if (rows.length) {
      rows.sort(function (a, b) { return String(b.updated_at || '').localeCompare(String(a.updated_at || '')); });
      await switchToEntry(rows[0].id);
      if (state.drawers) state.drawers.close();
      return;
    }
    await onNewEntry();
  }

  /* ─────────────────────────────────────────────────────────────
   * V3.361 — New ▾ template menu + template machinery
   * ─────────────────────────────────────────────────────────────
   * Template shape: { id, name, glyph, seed }. A seed can carry
   * title, tags[], phase, plan{}, body_html (sanitized on apply),
   * project_id. Personal templates persist in the _templates doc;
   * built-ins ship in NOTEBOOK_BUILTIN_TEMPLATES. Sharing = export /
   * import of a .notebook-template.json file (protocol-importer UX).
   */
  var _newMenuEl = null;

  function closeNewEntryMenu() {
    if (_newMenuEl && _newMenuEl.parentNode) _newMenuEl.parentNode.removeChild(_newMenuEl);
    _newMenuEl = null;
  }

  function openNewEntryMenu(anchorEl) {
    closeNewEntryMenu();
    var menu = document.createElement('div');
    menu.className = 'ln-new-menu';
    var html = '<button type="button" class="ln-new-item" data-act="blank">📄 Blank entry</button>';
    html += '<div class="ln-new-sep">Templates</div>';
    NOTEBOOK_BUILTIN_TEMPLATES.forEach(function (t) {
      html += '<button type="button" class="ln-new-item" data-act="tpl" data-tpl="' + escapeHtml(t.id) + '">' +
        escapeHtml(t.glyph + ' ' + t.name) + '</button>';
    });
    var mine = (state.templatesDoc && state.templatesDoc.templates) || [];
    if (mine.length) {
      html += '<div class="ln-new-sep">My templates</div>';
      mine.forEach(function (t) {
        html += '<div class="ln-new-item-row">' +
          '<button type="button" class="ln-new-item" data-act="tpl" data-tpl="' + escapeHtml(t.id) + '">' +
            escapeHtml((t.glyph || '📄') + ' ' + t.name) + '</button>' +
          '<button type="button" class="ln-new-mini" data-act="export" data-tpl="' + escapeHtml(t.id) + '" title="Export as shareable file">⬇</button>' +
          '<button type="button" class="ln-new-mini" data-act="del" data-tpl="' + escapeHtml(t.id) + '" title="Delete template">×</button>' +
        '</div>';
      });
    }
    html += '<div class="ln-new-sep"></div>';
    html += '<button type="button" class="ln-new-item" data-act="clone">🧬 Clone last entry</button>';
    if (state.doc) {
      html += '<button type="button" class="ln-new-item" data-act="save-tpl">💾 Save current as template</button>';
    }
    html += '<button type="button" class="ln-new-item" data-act="import">📥 Import template…</button>';
    menu.innerHTML = html;
    document.body.appendChild(menu);
    _newMenuEl = menu;
    _positionPopoverNearAnchor(menu, anchorEl);

    menu.addEventListener('click', function (e) {
      var btn = e.target && e.target.closest && e.target.closest('[data-act]');
      if (!btn) return;
      var act = btn.getAttribute('data-act');
      var tplId = btn.getAttribute('data-tpl');
      if (act !== 'export' && act !== 'del') closeNewEntryMenu();
      if (act === 'blank') onNewEntry();
      else if (act === 'tpl') applyTemplateById(tplId);
      else if (act === 'clone') cloneLastEntry();
      else if (act === 'save-tpl') saveCurrentAsTemplate();
      else if (act === 'import') importTemplateFile();
      else if (act === 'export') { exportTemplate(tplId); closeNewEntryMenu(); }
      else if (act === 'del') { deleteTemplate(tplId); closeNewEntryMenu(); }
    });
    setTimeout(function () {
      document.addEventListener('mousedown', function onDoc(e) {
        if (_newMenuEl && !_newMenuEl.contains(e.target)) closeNewEntryMenu();
        if (!_newMenuEl) document.removeEventListener('mousedown', onDoc);
      });
    }, 0);
  }

  function findTemplate(id) {
    var mine = (state.templatesDoc && state.templatesDoc.templates) || [];
    return NOTEBOOK_BUILTIN_TEMPLATES.find(function (t) { return t.id === id; }) ||
           mine.find(function (t) { return t.id === id; }) || null;
  }

  async function applyTemplateById(id) {
    var t = findTemplate(id);
    if (!t) { lnNotify('error', 'Template not found'); return; }
    await onNewEntry({ seed: t.seed, slug: t.name });
    setSavingHint('template applied: ' + t.name);
  }

  /* Overlay a template seed onto a freshly created entry. body_html
   * runs through the sanitizer so an imported template can't smuggle
   * markup past the allowlist. */
  function applySeedToDoc(doc, seed) {
    if (!seed || typeof seed !== 'object') return;
    if (typeof seed.title === 'string' && seed.title) doc.title = seed.title;
    if (Array.isArray(seed.tags)) doc.tags = seed.tags.filter(function (t) { return typeof t === 'string' && t; }).slice(0, 12);
    if (typeof seed.phase === 'string' && NOTEBOOK_PHASES.indexOf(seed.phase) >= 0) doc.phase = seed.phase;
    if (seed.plan && typeof seed.plan === 'object') doc.plan = notebookHydratePlan(JSON.parse(JSON.stringify(seed.plan)));
    if (typeof seed.project_id === 'string' && seed.project_id) doc.project_id = seed.project_id;
    if (typeof seed.body_html === 'string' && seed.body_html) doc.body_html = sanitizeHtml(seed.body_html);
  }

  /* V3.361 — clone the most recent entry (or the open one) as a fresh
   * plan-phase entry: carries title, tags, project, body (chips ride
   * along), plan, design factors+runs (results cleared), calc_runs.
   * Observations / summary / run stamps / attachments / protocol_run
   * do NOT carry — those are records of the old run. */
  async function cloneLastEntry() {
    var src = state.doc;
    if (!src) {
      var rows = filteredIndexRows();
      if (!rows.length) { lnNotify('error', 'Nothing to clone yet'); return; }
      src = await loadEntry(rows[0].id);
      if (!src) { lnNotify('error', 'Could not load the last entry'); return; }
    }
    var seed = {
      title: (src.title || '(untitled)') + ' (copy)',
      tags: (src.tags || []).slice(),
      project_id: src.project_id || null,
      plan: JSON.parse(JSON.stringify(src.plan || {})),
      body_html: src.body_html || '',
      phase: 'plan',
    };
    await onNewEntry({ seed: seed, slug: src.title || 'copy' });
    if (src.design) {
      state.doc.design = JSON.parse(JSON.stringify(src.design));
      state.doc.design.run_results = (state.doc.design.runs || []).map(function () { return { value: '', note: '' }; });
    }
    if (Array.isArray(src.calc_runs) && src.calc_runs.length) {
      state.doc.calc_runs = JSON.parse(JSON.stringify(src.calc_runs));
    }
    collectInventoryRefs(); collectProtocolRefs();
    renderEditor(); scheduleSave();
    setSavingHint('cloned from: ' + (src.title || src.id));
  }

  async function saveCurrentAsTemplate() {
    if (!state.doc) return;
    var name = await lnPrompt({ title: 'Template name', placeholder: 'e.g. ELISA day', okText: 'Save template' });
    if (!name) return;
    if (!state.templatesDoc) state.templatesDoc = { templates: [] };
    var tpl = {
      id: 'utpl-' + Date.now().toString(36) + '-' + Math.random().toString(36).slice(2, 6),
      name: name,
      glyph: '📄',
      seed: {
        tags: (state.doc.tags || []).slice(),
        phase: 'plan',
        plan: JSON.parse(JSON.stringify(state.doc.plan || {})),
        body_html: state.doc.body_html || '',
        project_id: state.doc.project_id || null,
      },
      created_at: isoNow(),
    };
    state.templatesDoc.templates.push(tpl);
    await saveTemplatesDoc();
    lnNotify('success', 'Template saved: ' + name);
  }

  async function deleteTemplate(id) {
    if (!state.templatesDoc) return;
    var t = (state.templatesDoc.templates || []).find(function (x) { return x.id === id; });
    if (!t) return;
    if (!confirm('Delete template "' + t.name + '"?')) return;
    state.templatesDoc.templates = state.templatesDoc.templates.filter(function (x) { return x.id !== id; });
    await saveTemplatesDoc();
    setSavingHint('template deleted');
  }

  function exportTemplate(id) {
    var t = findTemplate(id);
    if (!t) return;
    var payload = { kind: 'notebook-template', version: 1, template: { name: t.name, glyph: t.glyph || '📄', seed: t.seed } };
    var blob = new Blob([JSON.stringify(payload, null, 2)], { type: 'application/json' });
    var url = URL.createObjectURL(blob);
    var a = document.createElement('a');
    a.href = url;
    a.download = slugify(t.name, 5) + '.notebook-template.json';
    document.body.appendChild(a);
    a.click();
    setTimeout(function () { document.body.removeChild(a); URL.revokeObjectURL(url); }, 0);
  }

  function importTemplateFile() {
    var input = document.createElement('input');
    input.type = 'file';
    input.accept = '.json,application/json';
    input.addEventListener('change', async function () {
      var f = input.files && input.files[0];
      if (!f) return;
      try {
        var text = await f.text();
        var payload = JSON.parse(text);
        var t = payload && payload.kind === 'notebook-template' && payload.template;
        if (!t || typeof t.name !== 'string' || !t.seed || typeof t.seed !== 'object') {
          throw new Error('Not a notebook-template file (expected {kind:"notebook-template", template:{name, seed}}).');
        }
        if (!state.templatesDoc) state.templatesDoc = { templates: [] };
        state.templatesDoc.templates.push({
          id: 'utpl-' + Date.now().toString(36) + '-' + Math.random().toString(36).slice(2, 6),
          name: String(t.name).slice(0, 80),
          glyph: (typeof t.glyph === 'string' && t.glyph) ? t.glyph.slice(0, 4) : '📄',
          // Seed body is sanitized at APPLY time (applySeedToDoc), so a
          // hostile import can't inject markup even if it sits stored.
          seed: t.seed,
          created_at: isoNow(),
        });
        await saveTemplatesDoc();
        lnNotify('success', 'Template imported: ' + t.name);
      } catch (err) {
        lnNotify('error', 'Template import failed', err && err.message);
      }
    });
    input.click();
  }

  /* ─────────────────────────────────────────────────────────────
   * Left rail render
   * ───────────────────────────────────────────────────────────── */
  function renderRail() {
    var rail = document.getElementById('ln-rail');
    if (!rail) return;
    // V3.360 — preserve scroll across re-renders (the rail refreshes on
    // every title keystroke; losing scroll position made long rails
    // unusable).
    var keepScroll = rail.scrollTop;
    var rows = filteredIndexRows();
    // V3.362 — phase filter chips. Rendered even when the filtered list
    // is empty so an active chip can always be un-clicked.
    var chips = '<div class="ln-rail-chips">' +
      [{ v: '', label: 'All' }].concat(NOTEBOOK_PHASES.map(function (p) {
        return { v: p, label: NOTEBOOK_PHASE_GLYPHS[p] + ' ' + NOTEBOOK_PHASE_LABELS[p] };
      })).map(function (c) {
        return '<button type="button" class="ln-rail-chip' + (state.filters.phase === c.v ? ' active' : '') +
          '" data-phase="' + escapeHtml(c.v) + '">' + escapeHtml(c.label) + '</button>';
      }).join('') +
      '</div>';
    if (!rows.length) {
      rail.innerHTML = chips + '<div class="ln-empty">' +
        (state.filters.q || state.filters.phase
          ? 'No entries match the current filter.'
          : 'No entries yet. Click <strong>+ New</strong> to start.') +
        '</div>';
      wireRailChips(rail);
      return;
    }
    var html = chips + '<h3>Entries</h3>';
    var lastDate = '';
    rows.forEach(function (r) {
      if (r.date !== lastDate) {
        html += '<div class="ln-date-header">' + escapeHtml(r.date || '—') + '</div>';
        lastDate = r.date;
      }
      var active = r.id === state.currentId ? ' active' : '';
      var atts = r.attachment_count ? '<span class="att">📎 ' + r.attachment_count + '</span>' : '';
      var inv  = r.inventory_count ? '<span class="att" title="materials used">🧪 ' + r.inventory_count + '</span>' : '';
      var prot = r.protocol_count ? '<span class="att" title="protocols followed">📋 ' + r.protocol_count + '</span>' : '';
      var obs  = r.obs_count ? '<span class="att" title="observations">📌 ' + r.obs_count + '</span>' : '';
      var proj = r.project_id ? '<span>' + escapeHtml(projectLabel(r.project_id)) + '</span>' : '';
      // V3.138 — phase glyph on every rail row. Running entries get a
      // pulsing amber accent class so a half-finished run is visually
      // obvious and the user goes back to close it.
      var phase = (r.phase && NOTEBOOK_PHASE_GLYPHS[r.phase]) ? r.phase : 'complete';
      var phaseGlyph = '<span class="ln-rail-phase ln-rail-phase-' + phase + '" title="' +
        escapeHtml(NOTEBOOK_PHASE_LABELS[phase] || phase) + '">' +
        NOTEBOOK_PHASE_GLYPHS[phase] + '</span>';
      var tags = (r.tags || []).slice(0, 2).map(function (t) {
        return '<span class="tag-dot" title="' + escapeHtml(t) + '"></span>';
      }).join('');
      html += '<div class="ln-entry-row' + active + '" data-id="' + escapeHtml(r.id) + '">' +
        '<div class="title">' + phaseGlyph + ' ' + escapeHtml(r.title || '(untitled)') + '</div>' +
        '<div class="meta">' + tags + proj + atts + inv + prot + obs + '</div>' +
        '</div>';
    });
    rail.innerHTML = html;
    Array.prototype.forEach.call(rail.querySelectorAll('.ln-entry-row'), function (el) {
      el.addEventListener('click', function () {
        switchToEntry(el.getAttribute('data-id'));
        // V3.359 — picking an entry from the phone drawer closes it.
        if (state.drawers) state.drawers.close();
      });
    });
    wireRailChips(rail);
    rail.scrollTop = keepScroll;
  }

  function wireRailChips(rail) {
    Array.prototype.forEach.call(rail.querySelectorAll('.ln-rail-chip'), function (chip) {
      chip.addEventListener('click', function () {
        state.filters.phase = chip.getAttribute('data-phase') || '';
        renderRail();
      });
    });
  }

  /* ─────────────────────────────────────────────────────────────
   * Editor render
   * ───────────────────────────────────────────────────────────── */
  function renderEditor() {
    var pane = document.getElementById('ln-editor');
    if (!pane) return;
    if (!state.doc) {
      pane.classList.remove('dragover');
      // V3.359 — the phone empty state leads with one-tap capture:
      // create today's entry and open the camera in a single gesture.
      pane.innerHTML =
        '<div class="ln-empty-pane">' +
          '<div class="big">📓</div>' +
          'Select an entry from the rail, or click <strong>+ New</strong> to start.' +
          '<button type="button" id="ln-empty-capture" class="ln-empty-capture">📷 Capture into today\'s entry</button>' +
        '</div>';
      var cap = document.getElementById('ln-empty-capture');
      if (cap) cap.addEventListener('click', async function () {
        await openTodayEntry();
        var input = document.getElementById('ln-camera-input');
        if (input) { input.value = ''; input.click(); }
      });
      refreshActionBar();
      return;
    }
    var d = state.doc;
    var statusOpts = NOTEBOOK_ENTRY_STATUSES.map(function (s) {
      return '<option value="' + s + '"' + (d.status === s ? ' selected' : '') + '>' + s + '</option>';
    }).join('');
    // V3.117 — non-admin users only see projects where their uid is
    // in member_uids[]. Admin sees everything. The current project_id
    // is always retained in the option list so a stale assignment
    // doesn't silently drop the saved selection.
    var pickable = visibleProjectsForPicker();
    var projOpts = '<option value="">— no project —</option>' + pickable.map(function (p) {
      return '<option value="' + escapeHtml(p.id) + '"' +
        (d.project_id === p.id ? ' selected' : '') + '>' +
        escapeHtml(p.label) + ' · ' + escapeHtml(p.type) + '</option>';
    }).join('');
    // V3.126 — when a non-admin has zero assignments, deep-link to the
    // Projects page where members are managed (rather than just "ask
    // an admin"). Admins see an inline link to the same page so they
    // can manage their own assignments without leaving the notebook.
    var noProjectsHint = '';
    if (!state.isAdmin && pickable.length === 0) {
      noProjectsHint = '<span class="ln-no-projects">No projects assigned to you. Ask an admin to add you on the <a href="/rm/pages/projects.html" target="_blank" rel="noopener">Projects page</a>.</span>';
    } else if (state.isAdmin) {
      noProjectsHint = '<span class="ln-no-projects-admin">Admin · manage members on the <a href="/rm/pages/projects.html" target="_blank" rel="noopener">Projects page</a>.</span>';
    }

    pane.innerHTML =
      '<input type="text" class="ln-title" id="ln-title" placeholder="Entry title" value="' +
        escapeHtml(d.title) + '">' +
      '<div class="ln-meta-row">' +
        '<label>Date <input type="date" id="ln-date" value="' + escapeHtml(d.date) + '"></label>' +
        '<label>Project <select id="ln-project">' + projOpts + '</select></label>' +
        '<label>Status <select id="ln-status">' + statusOpts + '</select></label>' +
        renderPhasePill(d.phase) +
        noProjectsHint +
      '</div>' +
      renderTagsHtml(d.tags) +
      renderPlanHtml(d) +
      '<div class="ln-body-toolbar">' +
        '<button data-cmd="bold" title="Bold (Cmd/Ctrl+B)"><strong>B</strong></button>' +
        '<button data-cmd="italic" title="Italic (Cmd/Ctrl+I)"><em>I</em></button>' +
        '<button data-cmd="underline" title="Underline"><u>U</u></button>' +
        '<span class="sep"></span>' +
        '<button data-cmd="insertUnorderedList" title="Bulleted list">• List</button>' +
        '<button data-cmd="insertOrderedList" title="Numbered list">1. List</button>' +
        '<span class="sep"></span>' +
        '<button data-cmd="formatBlock:H2" title="Heading">H</button>' +
        '<button data-cmd="formatBlock:BLOCKQUOTE" title="Quote">❝</button>' +
        '<button data-cmd="formatBlock:PRE" title="Code block">{ }</button>' +
        '<span class="sep"></span>' +
        '<button id="ln-add-link" title="Insert link">🔗 Link</button>' +
        '<button id="ln-add-inventory" title="Insert reagent or equipment from lab inventory">🧪 Inventory</button>' +
        '<button id="ln-add-protocol" title="Reference a lab protocol">📋 Protocol</button>' +
        '<button id="ln-add-doe" title="Plan a structured run matrix (LHS / Factorial / CCD)">🧮 DOE</button>' +
        '<button id="ln-add-camera" title="Capture photo (rear camera on phones)">📷 Capture</button>' +
        '<button id="ln-add-file" title="Attach image or PDF">📎 Attach</button>' +
      '</div>' +
      '<div class="ln-body" id="ln-body" contenteditable="true" data-placeholder="Type your entry. Drag, paste, or capture a photo to attach an image."></div>' +
      renderDesignHtml(d.design || null) +
      // FuturePlan 06 — live protocol run panel (filled by
      // mountProtocolRunPanel in wireEditor; rendered from
      // state.doc.protocol_run, outside the sanitized body).
      '<div id="ln-protocol-run" class="ln-protocol-run"></div>' +
      renderProtocolsHtml(d.protocol_refs || []) +
      renderMaterialsHtml(d.inventory_refs || []) +
      renderAttachmentsHtml(d.attachments || []) +
      renderRefsHtml(d.reference_links || []) +
      renderBacklinksHtml(d) +
      '<div id="ln-ext-links"></div>' +
      renderObservationsHtml(d) +
      renderSummaryHtml(d) +
      renderRunFooterHtml(d);

    // Body innerHTML set programmatically so we don't double-encode the saved HTML.
    var body = document.getElementById('ln-body');
    body.innerHTML = d.body_html || '';
    refreshBodyEmptyState();
    wireEditor();
    refreshActionBar();
  }

  /* V3.360 — the "+ tag" prompt() is replaced by an inline chip input
   * with datalist autocomplete seeded from NOTEBOOK_DEFAULT_TAGS plus
   * every tag the user has already used (harvested from index rows). */
  function knownTags() {
    var seen = {};
    NOTEBOOK_DEFAULT_TAGS.forEach(function (t) { seen[t] = true; });
    (((state.indexDoc || {}).entries) || []).forEach(function (r) {
      (r.tags || []).forEach(function (t) { if (t) seen[t] = true; });
    });
    return Object.keys(seen).sort();
  }

  function renderTagsHtml(tags) {
    var chips = (tags || []).map(function (t) {
      return '<span class="ln-tag-chip" data-tag="' + escapeHtml(t) + '">' +
        escapeHtml(t) + '<span class="x" data-tag="' + escapeHtml(t) + '">×</span></span>';
    }).join('');
    var options = knownTags().map(function (t) {
      return '<option value="' + escapeHtml(t) + '"></option>';
    }).join('');
    return '<div class="ln-tags" id="ln-tags">' + chips +
      '<input class="ln-tag-input" id="ln-tag-input" type="text" list="ln-tag-suggestions"' +
        ' placeholder="+ tag" autocomplete="off" enterkeyhint="done">' +
      '<datalist id="ln-tag-suggestions">' + options + '</datalist>' +
      '</div>';
  }

  /* ─────────────────────────────────────────────────────────────
   * V3.361 — 🧭 Plan panel (hypothesis / variables / controls /
   * success criteria). Expanded + emphasized in phase:plan, collapses
   * to a summary chip once the run starts. Gentle — never a gate.
   * ───────────────────────────────────────────────────────────── */
  function renderPlanHtml(d) {
    var p = d.plan || notebookHydratePlan(null);
    var open = d.phase === 'plan';
    var filled = notebookPlanHasContent(p);
    var summaryBits = [];
    if (p.hypothesis) summaryBits.push('hypothesis');
    if (p.independent_vars.length) summaryBits.push(p.independent_vars.length + ' IV');
    if (p.dependent_vars.length) summaryBits.push(p.dependent_vars.length + ' DV');
    if (p.controls) summaryBits.push('controls');
    if (p.success_criteria) summaryBits.push('success criteria');
    return '<details class="ln-plan' + (d.phase === 'plan' ? ' ln-plan-active' : '') + '" id="ln-plan"' + (open ? ' open' : '') + '>' +
      '<summary>🧭 Plan' +
        '<span class="ln-plan-summary">' +
          (filled ? escapeHtml(summaryBits.join(' · ')) : (d.phase === 'plan' ? 'sketch the experiment before you start' : 'not filled in')) +
        '</span>' +
      '</summary>' +
      '<div class="ln-plan-grid">' +
        '<label class="ln-plan-field ln-plan-wide">Hypothesis / question' +
          '<textarea id="ln-plan-hypothesis" rows="2" placeholder="What do you expect to happen, and why?">' + escapeHtml(p.hypothesis) + '</textarea>' +
        '</label>' +
        '<label class="ln-plan-field">What I\'m varying (independent)' +
          '<input id="ln-plan-iv" type="text" placeholder="comma-separated, e.g. stiffness, seeding density" value="' + escapeHtml(p.independent_vars.join(', ')) + '">' +
        '</label>' +
        '<label class="ln-plan-field">What I\'m measuring (dependent)' +
          '<input id="ln-plan-dv" type="text" placeholder="comma-separated, e.g. traction force, viability" value="' + escapeHtml(p.dependent_vars.join(', ')) + '">' +
        '</label>' +
        '<label class="ln-plan-field">Controls' +
          '<input id="ln-plan-controls" type="text" placeholder="positive / negative / vehicle…" value="' + escapeHtml(p.controls) + '">' +
        '</label>' +
        '<label class="ln-plan-field">Success criteria' +
          '<input id="ln-plan-success" type="text" placeholder="what result would make this a win?" value="' + escapeHtml(p.success_criteria) + '">' +
        '</label>' +
      '</div>' +
    '</details>';
  }

  function wirePlanPanel() {
    var box = document.getElementById('ln-plan');
    if (!box || !state.doc) return;
    function csv(v) {
      return String(v || '').split(',').map(function (s) { return s.trim(); }).filter(Boolean);
    }
    var map = [
      { id: 'ln-plan-hypothesis', set: function (v) { state.doc.plan.hypothesis = v; } },
      { id: 'ln-plan-iv',         set: function (v) { state.doc.plan.independent_vars = csv(v); } },
      { id: 'ln-plan-dv',         set: function (v) { state.doc.plan.dependent_vars = csv(v); } },
      { id: 'ln-plan-controls',   set: function (v) { state.doc.plan.controls = v; } },
      { id: 'ln-plan-success',    set: function (v) { state.doc.plan.success_criteria = v; } },
    ];
    map.forEach(function (m) {
      var el = document.getElementById(m.id);
      if (!el) return;
      el.addEventListener('input', function () {
        if (!state.doc.plan) state.doc.plan = notebookHydratePlan(null);
        m.set(el.value);
        scheduleSave();
      });
    });
  }

  /* ─────────────────────────────────────────────────────────────
   * V3.362 — 🔗 Linked from (backlinks). Computed from index rows'
   * linked_entry_ids so it costs zero extra reads.
   * ───────────────────────────────────────────────────────────── */
  function renderBacklinksHtml(d) {
    var rows = ((state.indexDoc && state.indexDoc.entries) || []).filter(function (r) {
      return r.id !== d.id && Array.isArray(r.linked_entry_ids) && r.linked_entry_ids.indexOf(d.id) >= 0;
    });
    if (!rows.length) return '';
    var items = rows.map(function (r) {
      return '<button type="button" class="ln-backlink" data-id="' + escapeHtml(r.id) + '">' +
        '↩ ' + escapeHtml(r.title || '(untitled)') + ' <span class="ln-backlink-date">' + escapeHtml(r.date || '') + '</span>' +
        '</button>';
    }).join('');
    return '<div class="ln-backlinks" id="ln-backlinks">' +
      '<h4>Linked from</h4>' +
      '<div class="ln-backlink-list">' + items + '</div>' +
      '</div>';
  }

  function wireBacklinks() {
    var box = document.getElementById('ln-backlinks');
    if (!box) return;
    Array.prototype.forEach.call(box.querySelectorAll('.ln-backlink'), function (btn) {
      btn.addEventListener('click', function () { switchToEntry(btn.getAttribute('data-id')); });
    });
  }

  function renderProtocolsHtml(refs) {
    // V3.506 correction — a protocol mounted LIVE in-situ (the run panel
    // right below the body) is not a link out to another page; it's this
    // entry's own copy. Its row is a jump-to-it control (data-protocol-jump,
    // handled by the pane's delegated click listener), not an <a href>.
    // Only a protocol referenced WITHOUT a live mount (the "ref only" quick
    // action) still opens the protocols page in a new tab — there's no
    // in-situ instance to jump to.
    var liveId = state.doc && state.doc.protocol_run && state.doc.protocol_run.protocol_id;
    var rows = (refs || []).map(function (r) {
      var head;
      if (liveId && r.id === liveId) {
        head = '<button type="button" class="ln-protocol-row ln-protocol-row-live"' +
            ' data-protocol-jump="' + escapeHtml(r.id) + '"' +
            ' title="Jump to the live protocol document in this entry">' +
            '<span class="ln-protocol-icon">📋</span>' +
            '<span class="ln-protocol-name">' + escapeHtml(r.title || r.id) + '</span>' +
            '<span class="ln-protocol-live-badge">used in this entry ↓</span>' +
          '</button>';
      } else {
        var url = '/rm/pages/protocols.html?protocol=' + encodeURIComponent(r.id);
        head = '<a class="ln-protocol-row" href="' + escapeHtml(url) + '" target="_blank" rel="noopener" title="Open protocol">' +
            '<span class="ln-protocol-icon">📋</span>' +
            '<span class="ln-protocol-name">' + escapeHtml(r.title || r.id) + '</span>' +
          '</a>';
      }
      return '<div class="ln-protocol-list-row">' + head +
          // V3.135 — per-row calculator button. Click → opens the
          // calc modal for this protocol. Pane-level click delegate
          // (search wireProtocolsCalcDelegate) reads data-protocol-id
          // and routes to openProtocolCalculator.
          '<button type="button" class="ln-protocol-calc-btn"' +
            ' data-protocol-id="' + escapeHtml(r.id) + '"' +
            ' title="Use as calculator">🧮 calc</button>' +
        '</div>';
    }).join('');
    var emptyHint = (refs && refs.length)
      ? ''
      : '<span class="ln-material-empty">— click <strong>📋 Protocol</strong> to use a lab protocol in this entry.</span>';
    return '<div class="ln-protocols" id="ln-protocols">' +
      '<h4>Protocols followed</h4>' +
      '<div class="ln-protocol-list">' + rows + emptyHint + '</div>' +
      '</div>';
  }

  function renderProtocolsPanel() {
    var box = document.getElementById('ln-protocols');
    if (!box || !state.doc) return;
    box.outerHTML = renderProtocolsHtml(state.doc.protocol_refs || []);
  }

  function renderMaterialsHtml(refs) {
    var rows = (refs || []).map(function (r) {
      var meta = [];
      if (r.vendor) meta.push(escapeHtml(r.vendor));
      if (r.cat) meta.push('cat. ' + escapeHtml(r.cat));
      if (r.kind === 'chemical' && r.cas) meta.push('CAS ' + escapeHtml(r.cas));

      // V3.119 — hazard column on chemicals: signal-word pill + GHS
      // pictograms. Click any of these → opens the safety-details
      // modal via the body-level click delegation in wireMaterialsClicks.
      var hazardCol = '';
      if (r.kind === 'chemical' && (r.hazard_signal || (r.hazard_pictos && r.hazard_pictos.length))) {
        hazardCol = '<span class="ln-material-hazard" data-inv-id="' + escapeHtml(r.id) + '" title="Click for safety details">' +
          renderSignalWordPill(r.hazard_signal) +
          renderGhsPictograms(r.hazard_pictos || []) +
          '</span>';
      }

      // V3.119 — location row. When `locations[]` is empty (the common
      // case today since 0/935 items have it populated), render a small
      // italic "location not set" hint with an admin-only "(set)" link
      // that jumps to the inventory page focused on this item id.
      var locLine = '';
      if (Array.isArray(r.locations) && r.locations.length) {
        locLine = '<span class="ln-material-loc">📍 ' +
          r.locations.map(function (l) { return escapeHtml(l.name || ''); }).filter(Boolean).join(' · ') +
          '</span>';
      } else {
        locLine = '<span class="ln-material-loc ln-loc-empty">📍 location not set' +
          (state.isAdmin
            ? ' <a class="ln-loc-set-link" href="/rm/pages/inventory.html?focus=' + escapeHtml(r.id) + '" target="_blank" rel="noopener">(set)</a>'
            : '') +
          '</span>';
      }

      // V3.119 — storage line for chemicals when populated.
      var storageLine = (r.kind === 'chemical' && r.storage_conditions)
        ? '<span class="ln-material-storage">🌡 ' + escapeHtml(r.storage_conditions) + '</span>'
        : '';

      return '<div class="ln-material-row">' +
          '<div class="ln-material-row-main">' +
            '<span class="ln-inv-kind-badge ln-inv-kind-' + escapeHtml(r.kind || 'item') + '">' +
              escapeHtml(r.kind === 'chemical' ? 'chemical' : 'item') +
            '</span>' +
            '<span class="ln-material-name">' + escapeHtml(r.name || r.id) + '</span>' +
            (meta.length ? '<span class="ln-material-meta">' + meta.join(' · ') + '</span>' : '') +
            hazardCol +
          '</div>' +
          '<div class="ln-material-row-sub">' +
            locLine +
            storageLine +
          '</div>' +
        '</div>';
    }).join('');
    var emptyHint = (refs && refs.length)
      ? ''
      : '<span class="ln-material-empty">— click <strong>🧪 Inventory</strong> to mention reagents/equipment from the lab inventory.</span>';
    return '<div class="ln-materials" id="ln-materials">' +
      '<h4>Materials used</h4>' +
      '<div class="ln-material-list">' + rows + emptyHint + '</div>' +
      '</div>';
  }

  function renderMaterialsPanel() {
    var box = document.getElementById('ln-materials');
    if (!box || !state.doc) return;
    box.outerHTML = renderMaterialsHtml(state.doc.inventory_refs || []);
  }

  function renderAttachmentsHtml(atts) {
    // V3.161 — index pmr_review_figures by storage_path so each image
    // thumbnail can render its flagged-state badge.
    var flagged = {};
    (state.doc && state.doc.pmr_review_figures || []).forEach(function (f) {
      if (f && f.storage_path) flagged[f.storage_path] = f;
    });
    var thumbs = (atts || []).map(function (a, i) {
      var path = escapeHtml(a.storage_path || '');
      if (a.kind === 'image') {
        var isFlagged = !!flagged[a.storage_path];
        var flagBtn = '<button type="button" class="pmr-flag-badge' + (isFlagged ? ' on' : '') +
          '" data-i="' + i + '" title="' +
          (isFlagged ? 'Flagged for next PMR — click to unflag' : 'Flag this image for review at the next PMR') +
          '">📌</button>';
        return '<div class="ln-att-thumb' + (isFlagged ? ' is-pmr-flagged' : '') +
          '" data-i="' + i + '" data-path="' + path + '">' +
          '<img alt="" data-storage-path="' + path + '">' +
          flagBtn +
          '<span class="del" data-i="' + i + '" title="Remove attachment">×</span>' +
          '</div>';
      }
      return '<div class="ln-att-thumb" data-i="' + i + '" data-path="' + path + '">' +
        '<span class="pdf-icon">📄</span>' +
        '<span class="pdf-label">' + escapeHtml((a.caption || a.storage_path || '').split('/').pop()) + '</span>' +
        '<span class="del" data-i="' + i + '" title="Remove attachment">×</span>' +
        '</div>';
    }).join('');
    return '<div class="ln-attachments">' +
      '<h4>Attachments</h4>' +
      '<div class="ln-att-strip" id="ln-att-strip">' + thumbs +
        '<button class="ln-att-add" id="ln-att-add" title="Add image or PDF">' +
          '<span class="icon">＋</span><span>drop / paste / 📷</span>' +
        '</button>' +
      '</div>' +
      '</div>';
  }

  function renderRefsHtml(refs) {
    var rows = (refs || []).map(function (r, i) {
      var kindOpts = NOTEBOOK_REF_KINDS.map(function (k) {
        return '<option value="' + k + '"' + (r.kind === k ? ' selected' : '') + '>' + k + '</option>';
      }).join('');
      return '<div class="ln-ref-row" data-i="' + i + '">' +
        '<select class="ref-kind">' + kindOpts + '</select>' +
        '<input class="ref-label" type="text" placeholder="Label" value="' + escapeHtml(r.label || '') + '">' +
        '<input class="ref-url" type="text" placeholder="URL or entry id" value="' + escapeHtml(r.url || '') + '">' +
        '<span class="del" data-i="' + i + '">×</span>' +
        '</div>';
    }).join('');
    return '<div class="ln-refs" id="ln-refs">' +
      '<h4>References</h4>' +
      '<div id="ln-refs-rows">' + rows + '</div>' +
      '<button class="ln-add-btn" id="ln-add-ref">+ add reference</button>' +
      // V3.362 — the Phase-2 entry picker finally lands: link a sibling
      // notebook entry (writes reciprocal reference_links both ways).
      '<button class="ln-add-btn" id="ln-link-entry">🔗 link another entry</button>' +
      '</div>';
  }

  /* V3.360 — surgical refresh for the refs section (replaces the old
   * whole-editor re-render on every add/delete, which blew away focus). */
  function renderRefsPanel() {
    var box = document.getElementById('ln-refs');
    if (!box || !state.doc) return;
    box.outerHTML = renderRefsHtml(state.doc.reference_links || []);
    wireRefs();
  }

  function wireRefs() {
    Array.prototype.forEach.call(document.querySelectorAll('.ln-ref-row'), function (row) {
      var i = +row.getAttribute('data-i');
      row.querySelector('.ref-kind').addEventListener('change', function (e) {
        state.doc.reference_links[i].kind = e.target.value; scheduleSave();
      });
      row.querySelector('.ref-label').addEventListener('input', function (e) {
        state.doc.reference_links[i].label = e.target.value; scheduleSave();
      });
      row.querySelector('.ref-url').addEventListener('input', function (e) {
        state.doc.reference_links[i].url = e.target.value; scheduleSave();
      });
      row.querySelector('.del').addEventListener('click', function () {
        state.doc.reference_links.splice(i, 1);
        renderRefsPanel(); scheduleSave();
      });
    });
    var addBtn = document.getElementById('ln-add-ref');
    if (addBtn) addBtn.addEventListener('click', function () {
      if (!state.doc.reference_links) state.doc.reference_links = [];
      state.doc.reference_links.push({ kind: 'notes', label: '', url: '' });
      renderRefsPanel(); scheduleSave();
      // Focus the fresh row's label input so add → type flows.
      var rows = document.querySelectorAll('.ln-ref-row');
      var last = rows[rows.length - 1];
      var lbl = last && last.querySelector('.ref-label');
      if (lbl) lbl.focus();
    });
    var linkBtn = document.getElementById('ln-link-entry');
    if (linkBtn) linkBtn.addEventListener('click', function (ev) {
      openEntryLinkPicker(ev.currentTarget);
    });
  }

  /* ─────────────────────────────────────────────────────────────
   * V3.362 — entry link picker. Reuses the inventory popover chrome.
   * Picking a sibling entry writes reference_links BOTH ways (this doc
   * via normal save; the sibling via a direct entry save + index-row
   * refresh) so backlinks light up immediately on either end.
   * ───────────────────────────────────────────────────────────── */
  var entryPickerState = { popover: null };

  function entryLinkUrl(id) {
    return '/rm/pages/lab-notebook.html?entry=' + encodeURIComponent(id);
  }

  function _ensureEntryPickerPopover() {
    if (entryPickerState.popover) return entryPickerState.popover;
    var pop = document.createElement('div');
    pop.className = 'ln-inv-popover ln-entry-popover';
    pop.hidden = true;
    pop.innerHTML =
      '<div class="ln-inv-pop-title">Link another entry</div>' +
      '<input type="text" class="ln-inv-pop-search" placeholder="Search entries by title, tag, date…" autocomplete="off">' +
      '<div class="ln-inv-pop-list" role="listbox"></div>' +
      '<div class="ln-inv-pop-hint"><kbd>↑</kbd>/<kbd>↓</kbd> navigate · <kbd>Enter</kbd> link · <kbd>Esc</kbd> close</div>';
    document.body.appendChild(pop);
    entryPickerState.popover = pop;

    var input = pop.querySelector('.ln-inv-pop-search');
    var listEl = pop.querySelector('.ln-inv-pop-list');
    var activeIdx = 0;
    var current = [];

    pop._refresh = function () {
      var q = input.value.trim().toLowerCase();
      var src = ((state.indexDoc && state.indexDoc.entries) || []).filter(function (r) {
        return r.id !== state.currentId;
      }).slice().sort(function (a, b) { return (b.date || '').localeCompare(a.date || ''); });
      var matched = q
        ? src.filter(function (r) {
            var hay = ((r.title || '') + ' ' + (r.tags || []).join(' ') + ' ' + (r.date || '')).toLowerCase();
            return hay.indexOf(q) >= 0;
          })
        : src;
      current = matched.slice(0, 60);
      activeIdx = current.length ? 0 : -1;
      renderList();
    };
    function renderList() {
      listEl.innerHTML = '';
      if (!current.length) {
        listEl.innerHTML = '<div class="ln-inv-pop-empty">No other entries to link.</div>';
        return;
      }
      current.forEach(function (r, i) {
        var row = document.createElement('button');
        row.type = 'button';
        row.className = 'ln-inv-pop-row';
        if (i === activeIdx) row.classList.add('active');
        var glyph = NOTEBOOK_PHASE_GLYPHS[r.phase] || '📓';
        row.innerHTML =
          '<div class="ln-inv-pop-key">' +
            '<span class="ln-inv-pop-name">' + escapeHtml(glyph + ' ' + (r.title || '(untitled)')) + '</span>' +
          '</div>' +
          '<div class="ln-inv-pop-meta">' + escapeHtml((r.date || '') + ((r.tags || []).length ? ' · ' + r.tags.slice(0, 3).join(' · ') : '')) + '</div>';
        row.addEventListener('mouseenter', function () {
          if (activeIdx === i) return;
          activeIdx = i;
          Array.prototype.forEach.call(listEl.querySelectorAll('.ln-inv-pop-row'), function (el, idx) {
            el.classList.toggle('active', idx === i);
          });
        });
        row.addEventListener('mousedown', function (ev) { ev.preventDefault(); });
        row.addEventListener('click', function () { pickIndex(i); });
        listEl.appendChild(row);
      });
    }
    function pickIndex(i) {
      var row = current[i];
      if (!row) return;
      pop.hidden = true;
      linkSiblingEntry(row).catch(function (err) {
        lnNotify('error', 'Could not link entry', err && err.message);
      });
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
    pop._focus = function () { input.value = ''; input.focus(); };
    return pop;
  }

  function openEntryLinkPicker(anchorEl) {
    if (!state.doc) return;
    var pop = _ensureEntryPickerPopover();
    _positionPopoverNearAnchor(pop, anchorEl);
    pop._refresh();
    pop.hidden = false;
    pop._focus();
  }

  function _hasEntryLink(refs, id) {
    return (refs || []).some(function (r) {
      return r && r.kind === 'notebook' && String(r.url || '').indexOf('entry=' + id) >= 0;
    });
  }

  async function linkSiblingEntry(row) {
    if (!state.doc) return;
    var d = state.doc;
    if (!Array.isArray(d.reference_links)) d.reference_links = [];
    if (!_hasEntryLink(d.reference_links, row.id)) {
      d.reference_links.push({
        kind: 'notebook',
        label: (row.title || '(untitled)') + ' (' + (row.date || '') + ')',
        url: entryLinkUrl(row.id),
      });
    }
    renderRefsPanel();
    scheduleSave();
    upsertIndexRow(d);
    // Reciprocal link on the sibling — best-effort; the link still
    // works one-way if this write fails.
    try {
      var other = await loadEntry(row.id);
      if (other) {
        if (!Array.isArray(other.reference_links)) other.reference_links = [];
        if (!_hasEntryLink(other.reference_links, d.id)) {
          other.reference_links.push({
            kind: 'notebook',
            label: (d.title || '(untitled)') + ' (' + (d.date || '') + ')',
            url: entryLinkUrl(d.id),
          });
          other.updated_at = isoNow();
          ensureEntryRoute(other.id);
          await api.save(entryPathFor(other.id), other);
        }
        upsertIndexRow(other);
        await saveIndex();
      }
    } catch (err) {
      console.warn('[lab-notebook] reciprocal link failed:', err && err.message);
    }
    renderRail();
    setSavingHint('linked: ' + (row.title || row.id));
  }

  /* ─────────────────────────────────────────────────────────────
   * V3.138 — bench workflow lifecycle render helpers
   * ───────────────────────────────────────────────────────────── */

  function renderPhasePill(phase) {
    var p = (NOTEBOOK_PHASES.indexOf(phase) >= 0) ? phase : 'plan';
    var glyph = NOTEBOOK_PHASE_GLYPHS[p];
    var label = NOTEBOOK_PHASE_LABELS[p];
    return '<span class="ln-phase-pill ln-phase-' + p + '" title="Entry phase: ' + escapeHtml(label) + '">' +
      escapeHtml(glyph) + ' ' + escapeHtml(label) +
      '</span>';
  }

  /* Phase-aware footer. Plan mode shows ▶ Start run as the primary
   * action. Running mode shows ⏹ End run + (read-only) "started at"
   * timestamp. Complete mode shows the summary timestamp + a
   * `↻ Convert back to plan` admin escape hatch (rare; typically the
   * entry stays complete forever once ended). The Delete button stays
   * available in every phase. */
  function renderRunFooterHtml(d) {
    var startBtn = '';
    var endBtn = '';
    var phaseInfo = '';
    if (d.phase === 'plan') {
      startBtn = '<button class="ln-start-run primary" id="ln-start-run" title="Start the run — freeze the plan and begin recording observations at the bench">▶ Start run</button>';
    } else if (d.phase === 'running') {
      endBtn = '<button class="ln-end-run primary" id="ln-end-run" title="End the run — locks the entry and surfaces the post-run summary">⏹ End run</button>';
      var started = d.run_started_at ? d.run_started_at.slice(0, 16).replace('T', ' ') : '?';
      phaseInfo = '<span class="ln-phase-info">▶ run started ' + escapeHtml(started) + '</span>';
    } else if (d.phase === 'complete') {
      var ended = d.run_ended_at ? d.run_ended_at.slice(0, 16).replace('T', ' ') : (d.run_started_at ? d.run_started_at.slice(0, 16).replace('T', ' ') : '');
      phaseInfo = '<span class="ln-phase-info">✅ run completed' + (ended ? ' ' + escapeHtml(ended) : '') + '</span>';
    }
    // V3.361 — spawn the follow-up experiment from a finished entry.
    var nextBtn = (d.phase === 'complete')
      ? '<button id="ln-next-iteration" title="Start the next iteration — carries the plan, tags, project, and design factors forward and links both entries">↻ Next iteration</button>'
      : '';
    return '<div class="ln-footer">' +
      phaseInfo +
      '<span class="grow"></span>' +
      nextBtn +
      startBtn +
      endBtn +
      '<button class="danger" id="ln-delete">Delete entry</button>' +
      '</div>';
  }

  /* Observations panel — chronological log of bench observations.
   * Surfaces in `running` and `complete` phases (in plan mode the
   * panel is hidden — the entry hasn't begun yet). Each row is a
   * structured record: timestamp + free text + optional metric / value
   * / unit. Inline `+ Observation` button at the bottom. Each row gets
   * a `×` delete affordance.
   *
   * The panel is also visible (read-only) in complete mode so the
   * post-run record stays scannable. */
  function renderObservationsHtml(d) {
    if (d.phase === 'plan') return '';
    var obs = Array.isArray(d.observations) ? d.observations : [];
    var rowsHtml;
    if (!obs.length) {
      rowsHtml = '<div class="ln-obs-empty">No observations yet. Click <strong>+ Observation</strong> below to log a bench observation.</div>';
    } else {
      rowsHtml = obs.map(function (o, i) {
        var when = o.at ? o.at.slice(0, 16).replace('T', ' ') : '';
        var metricStr = '';
        if (o.metric || (o.value !== undefined && o.value !== null && o.value !== '')) {
          metricStr = '<span class="ln-obs-metric">' +
            (o.metric ? '<strong>' + escapeHtml(o.metric) + '</strong>' : '') +
            (o.metric && (o.value !== undefined && o.value !== null && o.value !== '') ? ' = ' : '') +
            escapeHtml(o.value !== undefined && o.value !== null ? String(o.value) : '') +
            (o.unit ? ' <span class="ln-obs-unit">' + escapeHtml(o.unit) + '</span>' : '') +
            '</span>';
        }
        return '<div class="ln-obs-row" data-i="' + i + '">' +
          '<span class="ln-obs-when">' + escapeHtml(when) + '</span>' +
          metricStr +
          '<span class="ln-obs-text">' + escapeHtml(o.text || '') + '</span>' +
          (d.phase === 'running' ? '<span class="ln-obs-del" data-i="' + i + '" title="Delete observation">×</span>' : '') +
          '</div>';
      }).join('');
    }
    // V3.360 — the prompt() chain is replaced by an inline mini-form
    // (text + optional metric/value/unit) with a 🎙 dictation mic.
    var hasMic = !!(window.SpeechRecognition || window.webkitSpeechRecognition);
    var addBtn = (d.phase === 'running')
      ? '<button class="ln-add-obs" id="ln-add-obs" type="button">+ Observation</button>' +
        '<div class="ln-obs-form" id="ln-obs-form" hidden>' +
          '<div class="ln-obs-form-text-row">' +
            '<textarea id="ln-obs-text" rows="2" placeholder="What did you see?" enterkeyhint="done"></textarea>' +
            (hasMic ? '<button type="button" id="ln-obs-mic" class="ln-mic-btn" title="Dictate">🎙</button>' : '') +
          '</div>' +
          '<div class="ln-obs-form-metric-row">' +
            '<input id="ln-obs-metric" type="text" placeholder="metric (OD600, pH…)" autocomplete="off">' +
            '<input id="ln-obs-value" type="text" inputmode="decimal" placeholder="value" autocomplete="off">' +
            '<input id="ln-obs-unit" type="text" placeholder="unit" autocomplete="off">' +
          '</div>' +
          '<div class="ln-obs-form-actions">' +
            '<button type="button" id="ln-obs-save" class="primary">Log observation</button>' +
            '<button type="button" id="ln-obs-cancel">Cancel</button>' +
          '</div>' +
        '</div>'
      : '';
    return '<div class="ln-observations" id="ln-observations">' +
      '<h4>Observations <span class="ln-obs-count">' + obs.length + '</span></h4>' +
      '<div class="ln-obs-list">' + rowsHtml + '</div>' +
      addBtn +
      '</div>';
  }

  /* Summary textarea — surfaces in running + complete. In running it's
   * an in-progress note; in complete it's the post-run debrief that
   * shows up on diff exports + future ↻ Spawn next iteration. */
  function renderSummaryHtml(d) {
    if (d.phase === 'plan') return '';
    var label = (d.phase === 'complete') ? 'Post-run summary' : 'Summary (in progress)';
    return '<div class="ln-summary" id="ln-summary">' +
      '<h4>' + escapeHtml(label) + '</h4>' +
      '<textarea id="ln-summary-text" class="ln-summary-text" placeholder="Short debrief: what worked, what didn\'t, what to change next time.">' +
        escapeHtml(d.summary || '') +
      '</textarea>' +
      '</div>';
  }

  function wireRunFooter() {
    var startBtn = document.getElementById('ln-start-run');
    if (startBtn) startBtn.addEventListener('click', onStartRun);
    var endBtn = document.getElementById('ln-end-run');
    if (endBtn) endBtn.addEventListener('click', onEndRun);
    var nextBtn = document.getElementById('ln-next-iteration');
    if (nextBtn) nextBtn.addEventListener('click', function () {
      spawnNextIteration().catch(function (err) {
        lnNotify('error', 'Could not spawn next iteration', err && err.message);
      });
    });
  }

  /* V3.361 — ↻ Next iteration. New plan-phase entry carrying forward
   * the experiment's identity (project, tags, plan, design factors +
   * runs with results cleared) and cross-linked with the source entry
   * via reference_links kind:'notebook' both ways. */
  async function spawnNextIteration() {
    var src = state.doc;
    if (!src || src.phase !== 'complete') return;
    var srcId = src.id;
    var srcTitle = src.title || '(untitled)';
    // "Gel stiffness sweep — run 3" → base "Gel stiffness sweep", n=3.
    var m = srcTitle.match(/^(.*?)(?:\s+—\s+run\s+(\d+))?$/i);
    var base = (m && m[1] ? m[1] : srcTitle).trim() || '(untitled)';
    var nextN = (m && m[2]) ? (parseInt(m[2], 10) + 1) : 2;
    var seed = {
      title: base + ' — run ' + nextN,
      tags: (src.tags || []).slice(),
      project_id: src.project_id || null,
      plan: JSON.parse(JSON.stringify(src.plan || {})),
      phase: 'plan',
    };
    var srcRefLink = {
      kind: 'notebook',
      label: srcTitle + ' (' + (src.date || '') + ')',
      url: entryLinkUrl(srcId),
    };
    await onNewEntry({ seed: seed, slug: seed.title });
    var next = state.doc;
    if (src.design) {
      next.design = JSON.parse(JSON.stringify(src.design));
      next.design.run_results = (next.design.runs || []).map(function () { return { value: '', note: '' }; });
      next.design.created_at = isoNow();
    }
    if (!Array.isArray(next.reference_links)) next.reference_links = [];
    next.reference_links.push(srcRefLink);
    // Forward link on the finished entry (direct save — it's no longer
    // state.doc).
    try {
      var srcDoc = await loadEntry(srcId);
      if (srcDoc) {
        if (!Array.isArray(srcDoc.reference_links)) srcDoc.reference_links = [];
        if (!_hasEntryLink(srcDoc.reference_links, next.id)) {
          srcDoc.reference_links.push({
            kind: 'notebook',
            label: next.title + ' (' + (next.date || '') + ')',
            url: entryLinkUrl(next.id),
          });
          srcDoc.updated_at = isoNow();
          ensureEntryRoute(srcId);
          await api.save(entryPathFor(srcId), srcDoc);
          upsertIndexRow(srcDoc);
        }
      }
    } catch (err) {
      console.warn('[lab-notebook] next-iteration back-link failed:', err && err.message);
    }
    renderEditor();
    scheduleSave();
    upsertIndexRow(next);
    await saveIndex();
    renderRail();
    setSavingHint('↻ next iteration created');
  }

  function wireObservationsPanel() {
    var addBtn = document.getElementById('ln-add-obs');
    if (addBtn) addBtn.addEventListener('click', function () { openObservationForm(); });
    var box = document.getElementById('ln-observations');
    if (!box) return;
    Array.prototype.forEach.call(box.querySelectorAll('.ln-obs-del'), function (del) {
      del.addEventListener('click', function (ev) {
        ev.stopPropagation();
        var i = +del.getAttribute('data-i');
        if (isNaN(i) || i < 0) return;
        if (!confirm('Delete this observation?')) return;
        state.doc.observations.splice(i, 1);
        renderObservationsPanel();
        scheduleSave();
        upsertIndexRow(state.doc); renderRail();
      });
    });
    wireObservationForm();
  }

  /* V3.360 — inline observation mini-form wiring. Save commits the
   * observation; Enter in the metric row saves too; the 🎙 mic dictates
   * into the free-text field (activity-tracker SpeechRecognition
   * pattern — single-shot, cleans up on end/error). */
  var _lnRecognition = null;

  function wireVoiceMic(mic, target) {
    if (!mic || !target) return;
    var SpeechRec = window.SpeechRecognition || window.webkitSpeechRecognition;
    if (!SpeechRec) { mic.hidden = true; return; }
    mic.addEventListener('click', function () {
      if (_lnRecognition) {
        try { _lnRecognition.stop(); } catch (_) {}
        _lnRecognition = null;
        mic.classList.remove('recording');
        return;
      }
      var rec = new SpeechRec();
      rec.continuous = false;
      rec.interimResults = false;
      rec.lang = 'en-US';
      rec.onresult = function (ev) {
        var text = (ev.results[0] && ev.results[0][0] && ev.results[0][0].transcript) || '';
        if (text) {
          target.value = (target.value ? target.value + ' ' : '') + text;
          try { target.dispatchEvent(new Event('input', { bubbles: true })); } catch (_) {}
        }
        target.focus();
      };
      rec.onend = function () { _lnRecognition = null; mic.classList.remove('recording'); };
      rec.onerror = function () { _lnRecognition = null; mic.classList.remove('recording'); };
      try {
        rec.start();
        _lnRecognition = rec;
        mic.classList.add('recording');
      } catch (err) {
        _lnRecognition = null;
        lnNotify('error', 'Microphone unavailable', err && err.message);
      }
    });
  }

  function openObservationForm() {
    if (!state.doc || state.doc.phase !== 'running') {
      lnNotify('info', 'Observations log during a run — click ▶ Start run first');
      return;
    }
    var form = document.getElementById('ln-obs-form');
    var addBtn = document.getElementById('ln-add-obs');
    if (!form) return;
    form.hidden = false;
    if (addBtn) addBtn.hidden = true;
    form.scrollIntoView({ block: 'nearest', behavior: 'smooth' });
    var text = document.getElementById('ln-obs-text');
    if (text) text.focus();
  }

  function closeObservationForm() {
    var form = document.getElementById('ln-obs-form');
    var addBtn = document.getElementById('ln-add-obs');
    if (form) {
      form.hidden = true;
      ['ln-obs-text', 'ln-obs-metric', 'ln-obs-value', 'ln-obs-unit'].forEach(function (id) {
        var el = document.getElementById(id);
        if (el) el.value = '';
      });
    }
    if (addBtn) addBtn.hidden = false;
  }

  function wireObservationForm() {
    var form = document.getElementById('ln-obs-form');
    if (!form) return;
    var saveBtn = document.getElementById('ln-obs-save');
    var cancelBtn = document.getElementById('ln-obs-cancel');
    var textEl = document.getElementById('ln-obs-text');
    wireVoiceMic(document.getElementById('ln-obs-mic'), textEl);
    if (cancelBtn) cancelBtn.addEventListener('click', closeObservationForm);
    if (saveBtn) saveBtn.addEventListener('click', commitObservationForm);
    // Enter in the single-line metric inputs commits; Shift+Enter in the
    // textarea keeps newline behavior, plain Enter commits there too.
    ['ln-obs-metric', 'ln-obs-value', 'ln-obs-unit'].forEach(function (id) {
      var el = document.getElementById(id);
      if (el) el.addEventListener('keydown', function (e) {
        if (e.key === 'Enter') { e.preventDefault(); commitObservationForm(); }
      });
    });
    if (textEl) textEl.addEventListener('keydown', function (e) {
      if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); commitObservationForm(); }
    });
  }

  function commitObservationForm() {
    if (!state.doc || state.doc.phase !== 'running') return;
    var text   = (document.getElementById('ln-obs-text')   || {}).value || '';
    var metric = (document.getElementById('ln-obs-metric') || {}).value || '';
    var valueRaw = (document.getElementById('ln-obs-value') || {}).value || '';
    var unit   = (document.getElementById('ln-obs-unit')   || {}).value || '';
    text = text.trim(); metric = metric.trim(); valueRaw = valueRaw.trim(); unit = unit.trim();
    if (!text && !metric) { closeObservationForm(); return; }
    if (!Array.isArray(state.doc.observations)) state.doc.observations = [];
    var n = parseFloat(valueRaw);
    var value = (valueRaw !== '' && !isNaN(n) && isFinite(n)) ? n : valueRaw;
    state.doc.observations.push({
      id: 'obs-' + Date.now().toString(36) + '-' + Math.random().toString(36).slice(2, 6),
      at: isoNow(),
      text: text,
      metric: metric || null,
      value: value === '' ? null : value,
      unit: unit || null,
      attachment_paths: [],
    });
    renderObservationsPanel();
    // Re-open the form for rapid-fire logging at the bench.
    openObservationForm();
    scheduleSave();
    upsertIndexRow(state.doc); renderRail();
    setSavingHint('observation logged');
  }

  function wireSummaryTextarea() {
    var ta = document.getElementById('ln-summary-text');
    if (!ta) return;
    var dirty = false;
    ta.addEventListener('input', function () {
      state.doc.summary = ta.value;
      dirty = true;
      scheduleSave();
    });
    // On blur, force a save flush so the summary doesn't sit unsaved
    // when the user navigates away.
    ta.addEventListener('blur', function () {
      if (dirty && state.saveTimer) {
        clearTimeout(state.saveTimer);
        state.saveTimer = null;
        saveEntry().catch(function (err) {
          console.error('[lab-notebook] summary flush failed:', err);
        });
      }
    });
  }

  function renderObservationsPanel() {
    var box = document.getElementById('ln-observations');
    if (!box || !state.doc) return;
    box.outerHTML = renderObservationsHtml(state.doc);
    wireObservationsPanel();
  }

  /* Lifecycle transitions. Plan → Running stamps run_started_at;
   * Running → Complete stamps run_ended_at. Both re-render the
   * editor (not just the panel) because the meta-row pill, the
   * footer buttons, and the Observations / Summary panels all
   * change visibility on phase transition. */
  async function onStartRun() {
    if (!state.doc || state.doc.phase !== 'plan') return;
    if (!confirm('Start run? This freezes the planned section above ' +
        'and opens the bench-recording surfaces (Observations, post-run Summary). ' +
        'You can still edit the body, but the recording log starts now.')) return;
    // V3.361 — gentle nudge, never a gate: an empty hypothesis gets one
    // hint toast on the way into the run.
    if (!(state.doc.plan && state.doc.plan.hypothesis)) {
      lnNotify('info', 'Tip: jot a hypothesis in 🧭 Plan — future-you will thank you');
    }
    state.doc.phase = 'running';
    state.doc.run_started_at = isoNow();
    if (!Array.isArray(state.doc.observations)) state.doc.observations = [];
    scheduleSave();
    upsertIndexRow(state.doc);
    renderEditor();
    renderRail();
    setSavingHint('▶ run started');
  }

  async function onEndRun() {
    if (!state.doc || state.doc.phase !== 'running') return;
    if (!confirm('End run? The entry becomes a post-run record. ' +
        'You can still type in the Summary; observations stay editable for cleanup.')) return;
    state.doc.phase = 'complete';
    state.doc.run_ended_at = isoNow();
    // FuturePlan 06 — freeze the live protocol run into an immutable
    // snapshot so the notebook record can't drift after completion.
    freezeProtocolRun();
    scheduleSave();
    upsertIndexRow(state.doc);
    renderEditor();
    renderRail();
    setSavingHint('✅ run completed');
  }

  /* V3.360 — the V3.138 prompt()-chain observation flow is gone; adding
   * an observation goes through the inline mini-form above
   * (openObservationForm / commitObservationForm), which also carries
   * the 🎙 dictation mic. */

  /* ─────────────────────────────────────────────────────────────
   * Editor wiring
   * ───────────────────────────────────────────────────────────── */
  function wireEditor() {
    var titleEl   = document.getElementById('ln-title');
    var dateEl    = document.getElementById('ln-date');
    var projectEl = document.getElementById('ln-project');
    var statusEl  = document.getElementById('ln-status');
    var bodyEl    = document.getElementById('ln-body');
    var pane      = document.getElementById('ln-editor');

    // V3.234 — external links block (Synology share URLs etc).
    var extLinksHost = document.getElementById('ln-ext-links');
    if (extLinksHost && window.EXTERNAL_LINKS) {
      window.EXTERNAL_LINKS.mount({
        container: extLinksHost,
        getLinks: function () { return state.doc.externalLinks || []; },
        setLinks: function (next) {
          state.doc.externalLinks = next;
          scheduleSave();
        },
        readOnly: false,
      });
    }

    // FuturePlan 06 — mount the live protocol-run panel (async; loads
    // deps + protocol tree on demand).
    mountProtocolRunPanel();

    titleEl.addEventListener('input', function () {
      state.doc.title = titleEl.value;
      scheduleSave();
      // Reflect in rail row immediately for snappy feedback.
      upsertIndexRow(state.doc); renderRail();
    });
    dateEl.addEventListener('change', function () {
      state.doc.date = dateEl.value || todayStr();
      scheduleSave();
      upsertIndexRow(state.doc); renderRail();
    });
    projectEl.addEventListener('change', function () {
      state.doc.project_id = projectEl.value || null;
      scheduleSave();
      upsertIndexRow(state.doc); renderRail();
    });
    statusEl.addEventListener('change', function () {
      state.doc.status = statusEl.value;
      scheduleSave();
      upsertIndexRow(state.doc); renderRail();
    });

    // Body editing.
    bodyEl.addEventListener('input', function () {
      state.doc.body_html = sanitizeHtml(bodyEl.innerHTML);
      collectInventoryRefs();
      collectProtocolRefs();
      refreshBodyEmptyState();
      renderMaterialsPanel();
      renderProtocolsPanel();
      scheduleSave();
    });
    bodyEl.addEventListener('keydown', onBodyKeydown);
    bodyEl.addEventListener('paste', onBodyPaste);

    // V3.119 — delegated click on the editor pane: clicking any
    // hazard pill / pictogram (inside a chip's hazard sibling, the
    // Materials panel hazard column, or the picker popover) opens the
    // safety-details modal. We use one delegated listener on the pane
    // so dynamically-rendered children are handled without rebinding.
    pane.addEventListener('click', function (e) {
      var t = e.target;
      // Walk up looking for either a chip's hazard sibling or a
      // Materials panel hazard span. Both carry data-inv-id.
      var hazardEl = t && t.closest && t.closest('.ln-inv-hazard, .ln-material-hazard');
      if (hazardEl) {
        var invId = hazardEl.getAttribute('data-inv-id');
        if (invId) {
          e.preventDefault();
          e.stopPropagation();
          openSafetyDetailsModal(invId).catch(function (err) {
            alert('Could not open safety details: ' + (err && err.message || err));
          });
          return;
        }
      }
      // V3.506 — clicking a live-mounted protocol's row on the
      // Protocols-followed panel scrolls to its in-situ document below
      // (no navigation — see renderProtocolsHtml's data-protocol-jump).
      var jumpBtn = t && t.closest && t.closest('[data-protocol-jump]');
      if (jumpBtn) {
        e.preventDefault();
        e.stopPropagation();
        var runHost = document.getElementById('ln-protocol-run');
        if (runHost && runHost.scrollIntoView) {
          try { runHost.scrollIntoView({ behavior: 'smooth', block: 'start' }); } catch (err) {}
        }
        return;
      }
      // V3.135 — clicking the per-row "🧮 calc" button on the
      // Protocols-followed panel opens the calc modal for that
      // protocol. Caught BEFORE the .ln-calc check below so the
      // button click takes precedence over any accidental
      // bubbling.
      var calcBtn = t && t.closest && t.closest('.ln-protocol-calc-btn');
      if (calcBtn) {
        var calcBtnPid = calcBtn.getAttribute('data-protocol-id');
        if (calcBtnPid) {
          e.preventDefault();
          e.stopPropagation();
          openProtocolCalculator(calcBtnPid).catch(function (err) {
            alert('Could not open calculator: ' + (err && err.message || err));
          });
          return;
        }
      }
      // V3.135 — clicking anywhere inside an .ln-calc container
      // re-opens the calculator modal pre-filled with the saved
      // calc_run.inputs. The container is contenteditable=false, so
      // clicks inside it bubble cleanly to the pane (the body's
      // contentEditable wraps but doesn't intercept).
      var calcEl = t && t.closest && t.closest('.ln-calc');
      if (calcEl) {
        var calcId = calcEl.getAttribute('data-calc-id');
        var protocolId = calcEl.getAttribute('data-calc-protocol-id');
        if (calcId && protocolId) {
          e.preventDefault();
          e.stopPropagation();
          openProtocolCalculator(protocolId, { editingCalcId: calcId }).catch(function (err) {
            alert('Could not open calculator: ' + (err && err.message || err));
          });
        }
      }
    });

    // Drag-drop image upload anywhere over the pane.
    pane.addEventListener('dragover', function (e) {
      if (!Array.from(e.dataTransfer.types || []).includes('Files')) return;
      e.preventDefault();
      pane.classList.add('dragover');
    });
    pane.addEventListener('dragleave', function () { pane.classList.remove('dragover'); });
    pane.addEventListener('drop', function (e) {
      pane.classList.remove('dragover');
      var files = Array.from(e.dataTransfer.files || []);
      if (!files.length) return;
      e.preventDefault();
      files.forEach(function (f) {
        uploadAndAttach(f, /* insertInline */ true).catch(function (err) {
          lnNotify('error', 'Upload failed', err && err.message || String(err));
        });
      });
    });

    // Toolbar formatting buttons.
    Array.prototype.forEach.call(document.querySelectorAll('.ln-body-toolbar button[data-cmd]'), function (btn) {
      btn.addEventListener('mousedown', function (e) { e.preventDefault(); }); // keep caret
      btn.addEventListener('click', function () {
        var cmd = btn.getAttribute('data-cmd');
        if (cmd.indexOf('formatBlock:') === 0) {
          document.execCommand('formatBlock', false, cmd.split(':')[1]);
        } else {
          document.execCommand(cmd, false, null);
        }
        bodyEl.focus();
        state.doc.body_html = sanitizeHtml(bodyEl.innerHTML);
        scheduleSave();
      });
    });

    document.getElementById('ln-add-link').addEventListener('click', async function () {
      var url = await lnPrompt({ title: 'Link URL', placeholder: 'https://…', okText: 'Insert link' });
      if (!url) return;
      if (!isSafeUrl(url)) { lnNotify('error', 'Unsafe URL'); return; }
      bodyEl.focus();
      document.execCommand('createLink', false, url);
      state.doc.body_html = sanitizeHtml(bodyEl.innerHTML);
      scheduleSave();
    });

    document.getElementById('ln-add-inventory').addEventListener('click', function (ev) {
      // V3.151 — pass the button as anchor so the popover opens
      // adjacent to it instead of fixed at top-center.
      openInventoryPicker(ev.currentTarget).catch(function (err) {
        alert('Inventory load failed: ' + (err && err.message || err));
      });
    });

    document.getElementById('ln-add-protocol').addEventListener('click', function (ev) {
      openProtocolPicker(ev.currentTarget).catch(function (err) {
        alert('Protocol load failed: ' + (err && err.message || err));
      });
    });

    document.getElementById('ln-add-doe').addEventListener('click', openDoeModal);

    // Camera capture (rear camera on mobile).
    document.getElementById('ln-add-camera').addEventListener('click', function () {
      var input = document.getElementById('ln-camera-input');
      input.value = '';
      input.click();
    });
    // Generic file picker. (The strip's ＋ button is wired in
    // wireAttachments so the section stays self-contained.)
    document.getElementById('ln-add-file').addEventListener('click', function () {
      var input = document.getElementById('ln-file-input');
      input.value = '';
      input.click();
    });

    // Tag chips — V3.360 inline autocomplete input replaces prompt().
    wireTagChips();

    // Attachments — delete, lightbox, PMR-flag (extracted so uploads
    // and flag toggles can refresh just this section).
    wireAttachments();

    // Reference rows + entry-link picker (extracted for the same reason).
    wireRefs();

    // V3.361 — plan panel; V3.362 — backlinks.
    wirePlanPanel();
    wireBacklinks();

    // V3.360 — "/" slash-command insert menu in the body.
    wireSlashMenu(bodyEl);

    document.getElementById('ln-delete').addEventListener('click', onDeleteEntry);

    // V3.123 — wire Design panel actions (Edit / Download CSV / Clear).
    wireDesignPanel();

    // V3.138 — wire bench-workflow lifecycle controls.
    wireRunFooter();
    wireObservationsPanel();
    wireSummaryTextarea();
  }

  function commitTagInput(input) {
    var t = (input.value || '').trim().toLowerCase().replace(/\s+/g, '-');
    input.value = '';
    if (!t) return;
    if (!state.doc.tags) state.doc.tags = [];
    if (state.doc.tags.indexOf(t) < 0) state.doc.tags.push(t);
    renderTagsPanel(/* focusInput */ true);
    scheduleSave();
    upsertIndexRow(state.doc); renderRail();
  }

  function renderTagsPanel(focusInput) {
    var tagsBox = document.getElementById('ln-tags');
    if (!tagsBox || !state.doc) return;
    tagsBox.outerHTML = renderTagsHtml(state.doc.tags);
    wireTagChips();
    if (focusInput) {
      var input = document.getElementById('ln-tag-input');
      if (input) input.focus();
    }
  }

  function wireTagChips() {
    Array.prototype.forEach.call(document.querySelectorAll('.ln-tag-chip .x'), function (x) {
      x.addEventListener('click', function () {
        var t = x.getAttribute('data-tag');
        state.doc.tags = (state.doc.tags || []).filter(function (z) { return z !== t; });
        renderTagsPanel(false);
        scheduleSave();
        upsertIndexRow(state.doc); renderRail();
      });
    });
    var input = document.getElementById('ln-tag-input');
    if (input) {
      input.addEventListener('keydown', function (e) {
        if (e.key === 'Enter' || e.key === ',') {
          e.preventDefault();
          commitTagInput(input);
        } else if (e.key === 'Backspace' && !input.value && (state.doc.tags || []).length) {
          // Backspace on empty input removes the last chip — standard
          // chip-input affordance.
          state.doc.tags.pop();
          renderTagsPanel(true);
          scheduleSave();
          upsertIndexRow(state.doc); renderRail();
        }
      });
      // Datalist pick (mouse/tap) fires change without a keydown.
      input.addEventListener('change', function () { commitTagInput(input); });
      input.addEventListener('blur', function () { if (input.value.trim()) commitTagInput(input); });
    }
  }

  /* V3.360 — attachments section: surgical refresh + wiring extracted
   * from wireEditor so uploads / deletes / flag toggles no longer blow
   * away the whole editor (and the user's caret with it). */
  function renderAttachmentsPanel() {
    var box = document.querySelector('.ln-attachments');
    if (!box || !state.doc) return;
    box.outerHTML = renderAttachmentsHtml(state.doc.attachments || []);
    wireAttachments();
  }

  function wireAttachments() {
    Array.prototype.forEach.call(document.querySelectorAll('.ln-att-thumb'), function (el) {
      el.addEventListener('click', function (e) {
        if (e.target && e.target.classList.contains('del')) {
          var i = +e.target.getAttribute('data-i');
          // V3.161 — clean up any PMR figure-review entry tied to this attachment.
          var goneAtt = state.doc.attachments[i];
          if (goneAtt && goneAtt.storage_path) {
            removePmrFlagForFigure(goneAtt.storage_path);
          }
          state.doc.attachments.splice(i, 1);
          renderAttachmentsPanel();
          scheduleSave();
          upsertIndexRow(state.doc); renderRail();
          return;
        }
        // V3.161 — PMR flag toggle. Click bubbles before lightbox.
        if (e.target && e.target.classList.contains('pmr-flag-badge')) {
          e.stopPropagation();
          var idx = +e.target.getAttribute('data-i');
          togglePmrFlagOnFigure(idx);
          return;
        }
        var path = el.getAttribute('data-path');
        if (path) openLightbox(path);
      });
      // Resolve image thumbnail URL lazily (storage paths aren't URLs).
      var img = el.querySelector('img[data-storage-path]');
      if (img) {
        var sp = img.getAttribute('data-storage-path');
        if (sp && window.NOTEBOOK_FIGURES) {
          NOTEBOOK_FIGURES.downloadUrl(sp).then(function (url) { img.src = url; })
            .catch(function () { /* missing object — silent */ });
        }
      }
    });
    var addBtn = document.getElementById('ln-att-add');
    if (addBtn) addBtn.addEventListener('click', function () {
      document.getElementById('ln-file-input').click();
    });
  }

  function refreshBodyEmptyState() {
    var bodyEl = document.getElementById('ln-body');
    if (!bodyEl) return;
    var empty = !bodyEl.innerHTML || bodyEl.innerHTML === '<br>' || bodyEl.textContent.trim() === '' && !bodyEl.querySelector('img');
    bodyEl.setAttribute('data-empty', empty ? 'true' : 'false');
  }

  /* ─────────────────────────────────────────────────────────────
   * V3.360 — "/" slash-command insert menu.
   * ─────────────────────────────────────────────────────────────
   * Typing "/" at the start of a line (or after whitespace) pops a
   * small anchored menu of insert actions. Further letters filter it;
   * Enter/click runs the action after deleting the typed "/query"
   * from the body; Escape / clicking away dismisses. Every action
   * delegates to an existing toolbar handler — the menu is just a
   * faster path to them.
   */
  var SLASH_ITEMS = [
    { key: 'observation', label: '📌 Observation',   run: function () { openObservationForm(); } },
    { key: 'inventory',   label: '🧪 Inventory chip', run: function () { var b = document.getElementById('ln-add-inventory'); if (b) b.click(); } },
    { key: 'protocol',    label: '📋 Protocol',       run: function () { var b = document.getElementById('ln-add-protocol'); if (b) b.click(); } },
    { key: 'photo',       label: '📷 Photo / camera', run: function () { var i = document.getElementById('ln-camera-input'); if (i) { i.value = ''; i.click(); } } },
    { key: 'attach',      label: '📎 Attach file',    run: function () { var i = document.getElementById('ln-file-input'); if (i) { i.value = ''; i.click(); } } },
    { key: 'doe',         label: '🧮 DOE matrix',     run: function () { openDoeModal(); } },
    { key: 'heading',     label: 'H2 Heading',        run: function () { document.execCommand('formatBlock', false, 'H2'); } },
    { key: 'quote',       label: '❝ Quote',           run: function () { document.execCommand('formatBlock', false, 'BLOCKQUOTE'); } },
    { key: 'code',        label: '{ } Code block',    run: function () { document.execCommand('formatBlock', false, 'PRE'); } },
  ];

  var _slash = { open: false, query: '', menuEl: null, activeIdx: 0 };

  function _slashMatches() {
    var q = _slash.query.toLowerCase();
    return SLASH_ITEMS.filter(function (it) {
      return !q || it.key.indexOf(q) === 0 || it.label.toLowerCase().indexOf(q) >= 0;
    });
  }

  function _slashCaretRect(bodyEl) {
    var sel = window.getSelection();
    if (sel && sel.rangeCount) {
      var r = sel.getRangeAt(0).cloneRange();
      r.collapse(true);
      var rect = r.getBoundingClientRect();
      if (rect && (rect.top || rect.left)) return rect;
    }
    return bodyEl.getBoundingClientRect();
  }

  function closeSlashMenu() {
    _slash.open = false;
    _slash.query = '';
    _slash.activeIdx = 0;
    if (_slash.menuEl && _slash.menuEl.parentNode) _slash.menuEl.parentNode.removeChild(_slash.menuEl);
    _slash.menuEl = null;
  }

  function renderSlashMenu(bodyEl) {
    var matches = _slashMatches();
    if (!matches.length) { closeSlashMenu(); return; }
    if (_slash.activeIdx >= matches.length) _slash.activeIdx = matches.length - 1;
    if (!_slash.menuEl) {
      _slash.menuEl = document.createElement('div');
      _slash.menuEl.className = 'ln-slash-menu';
      document.body.appendChild(_slash.menuEl);
      var rect = _slashCaretRect(bodyEl);
      _slash.menuEl.style.left = Math.min(rect.left, window.innerWidth - 240) + 'px';
      _slash.menuEl.style.top = (rect.bottom + 4) + 'px';
    }
    _slash.menuEl.innerHTML = matches.map(function (it, i) {
      return '<button type="button" class="ln-slash-item' + (i === _slash.activeIdx ? ' active' : '') +
        '" data-key="' + escapeHtml(it.key) + '">' + it.label + '</button>';
    }).join('');
    Array.prototype.forEach.call(_slash.menuEl.querySelectorAll('.ln-slash-item'), function (btn) {
      btn.addEventListener('mousedown', function (ev) { ev.preventDefault(); });
      btn.addEventListener('click', function () {
        var it = SLASH_ITEMS.find(function (x) { return x.key === btn.getAttribute('data-key'); });
        _slashRun(bodyEl, it);
      });
    });
  }

  /* Delete the typed "/query" text immediately before the caret, then
   * run the picked action. */
  function _slashRun(bodyEl, item) {
    if (!item) { closeSlashMenu(); return; }
    var chars = _slash.query.length + 1; // "/", then the filter chars
    try {
      var sel = window.getSelection();
      if (sel && sel.rangeCount) {
        var range = sel.getRangeAt(0);
        var node = range.startContainer;
        if (node && node.nodeType === 3) {
          var end = range.startOffset;
          var start = Math.max(0, end - chars);
          node.deleteData(start, end - start);
        }
      }
    } catch (_) { /* text-node shape changed — leave the query text */ }
    closeSlashMenu();
    state.doc.body_html = sanitizeHtml(bodyEl.innerHTML);
    refreshBodyEmptyState();
    scheduleSave();
    item.run();
  }

  function wireSlashMenu(bodyEl) {
    if (!bodyEl) return;
    bodyEl.addEventListener('keydown', function (e) {
      if (_slash.open) {
        var matches = _slashMatches();
        if (e.key === 'Escape') { e.preventDefault(); closeSlashMenu(); return; }
        if (e.key === 'Enter') { e.preventDefault(); _slashRun(bodyEl, matches[_slash.activeIdx]); return; }
        if (e.key === 'ArrowDown') { e.preventDefault(); _slash.activeIdx = (_slash.activeIdx + 1) % matches.length; renderSlashMenu(bodyEl); return; }
        if (e.key === 'ArrowUp')   { e.preventDefault(); _slash.activeIdx = (_slash.activeIdx - 1 + matches.length) % matches.length; renderSlashMenu(bodyEl); return; }
        if (e.key === 'Backspace') {
          if (!_slash.query) { closeSlashMenu(); return; } // deleting the "/" itself
          _slash.query = _slash.query.slice(0, -1);
          setTimeout(function () { renderSlashMenu(bodyEl); }, 0);
          return;
        }
        if (e.key.length === 1 && /[a-z0-9]/i.test(e.key)) {
          _slash.query += e.key.toLowerCase();
          setTimeout(function () { renderSlashMenu(bodyEl); }, 0);
          return;
        }
        // Any other key (space, arrows out, punctuation) dismisses.
        closeSlashMenu();
        return;
      }
      if (e.key !== '/') return;
      // Only trigger at line start or after whitespace so typing URLs
      // and fractions doesn't pop the menu.
      var sel = window.getSelection();
      if (!sel || !sel.rangeCount) return;
      var range = sel.getRangeAt(0);
      if (!range.collapsed) return;
      var node = range.startContainer;
      var before = '';
      if (node.nodeType === 3) before = node.textContent.slice(0, range.startOffset);
      if (before && !/\s$/.test(before)) return;
      _slash.open = true;
      _slash.query = '';
      _slash.activeIdx = 0;
      setTimeout(function () { renderSlashMenu(bodyEl); }, 0);
    });
    bodyEl.addEventListener('blur', function () {
      // Delay so a menu click (mousedown-prevented) still lands.
      setTimeout(function () { if (_slash.open) closeSlashMenu(); }, 150);
    });
  }

  /* ─────────────────────────────────────────────────────────────
   * V3.359 — phone action bar + keyboard handling.
   * ─────────────────────────────────────────────────────────────
   * A fixed bottom bar (📷 · 🎙 · ➕ obs · 🏷 tag), visible only at
   * ≤640px via CSS. Lives OUTSIDE #ln-content so editor re-renders
   * never touch it; refreshActionBar() re-checks enablement per phase.
   * The visualViewport listener keeps the bar above the iOS/Android
   * keyboard by tracking the visual-viewport bottom gap.
   */
  function ensureActionBar() {
    if (document.getElementById('ln-action-bar')) return;
    var bar = document.createElement('div');
    bar.id = 'ln-action-bar';
    bar.className = 'ln-action-bar';
    bar.innerHTML =
      '<button type="button" id="ln-ab-camera" title="Capture photo">📷<span>Capture</span></button>' +
      '<button type="button" id="ln-ab-voice" title="Dictate an observation">🎙<span>Voice</span></button>' +
      '<button type="button" id="ln-ab-obs" title="Log an observation">➕<span>Observe</span></button>' +
      '<button type="button" id="ln-ab-tag" title="Add a tag">🏷<span>Tag</span></button>';
    document.body.appendChild(bar);

    async function ensureEntryThen(fn) {
      if (!state.doc) await openTodayEntry();
      if (state.doc) fn();
    }
    document.getElementById('ln-ab-camera').addEventListener('click', function () {
      ensureEntryThen(function () {
        var input = document.getElementById('ln-camera-input');
        if (input) { input.value = ''; input.click(); }
      });
    });
    document.getElementById('ln-ab-obs').addEventListener('click', function () {
      ensureEntryThen(function () { openObservationForm(); });
    });
    document.getElementById('ln-ab-voice').addEventListener('click', function () {
      ensureEntryThen(function () {
        openObservationForm();
        var mic = document.getElementById('ln-obs-mic');
        if (mic) mic.click();
        else lnNotify('info', 'Voice dictation needs a running entry and a supported browser');
      });
    });
    document.getElementById('ln-ab-tag').addEventListener('click', function () {
      ensureEntryThen(function () {
        var input = document.getElementById('ln-tag-input');
        if (input) { input.scrollIntoView({ block: 'center' }); input.focus(); }
      });
    });

    // Keyboard-aware positioning (visualViewport is the only reliable
    // cross-mobile signal for the keyboard height).
    if (window.visualViewport) {
      var vv = window.visualViewport;
      var onVv = function () {
        var gap = Math.max(0, window.innerHeight - vv.height - vv.offsetTop);
        bar.style.transform = gap > 0 ? 'translateY(-' + gap + 'px)' : '';
      };
      vv.addEventListener('resize', onVv);
      vv.addEventListener('scroll', onVv);
    }
  }

  /* Enable/disable per state: observation buttons need a running entry;
   * camera/tag need any entry (they self-create today's entry). */
  function refreshActionBar() {
    var bar = document.getElementById('ln-action-bar');
    if (!bar) return;
    var running = !!(state.doc && state.doc.phase === 'running');
    var obsBtn = document.getElementById('ln-ab-obs');
    var voiceBtn = document.getElementById('ln-ab-voice');
    if (obsBtn) obsBtn.classList.toggle('ln-ab-dim', !running);
    if (voiceBtn) voiceBtn.classList.toggle('ln-ab-dim', !running);
  }

  /* ─────────────────────────────────────────────────────────────
   * Body keyboard + paste handlers
   * ───────────────────────────────────────────────────────────── */
  function onBodyKeydown(e) {
    var cmdOrCtrl = e.metaKey || e.ctrlKey;
    if (!cmdOrCtrl || e.shiftKey || e.altKey) return;
    var key = (e.key || '').toLowerCase();
    var handled = true;
    if (key === 'b')      document.execCommand('bold', false, null);
    else if (key === 'i') document.execCommand('italic', false, null);
    else if (key === 'u') document.execCommand('underline', false, null);
    else handled = false;
    if (handled) {
      e.preventDefault();
      state.doc.body_html = sanitizeHtml(document.getElementById('ln-body').innerHTML);
      scheduleSave();
    }
  }

  async function onBodyPaste(e) {
    var items = e.clipboardData && e.clipboardData.items;
    if (!items) return;
    var imageBlobs = [];
    for (var i = 0; i < items.length; i++) {
      if (items[i].kind === 'file') {
        var f = items[i].getAsFile();
        if (f && /^image\//.test(f.type)) imageBlobs.push(f);
      }
    }
    if (!imageBlobs.length) return; // let default paste run for text/HTML
    e.preventDefault();
    for (var j = 0; j < imageBlobs.length; j++) {
      try {
        await uploadAndAttach(imageBlobs[j], /* insertInline */ true);
      } catch (err) {
        lnNotify('error', 'Upload failed', err && err.message || String(err));
      }
    }
  }

  /* ─────────────────────────────────────────────────────────────
   * Upload pipeline (drag-drop, paste, camera, file picker)
   * ───────────────────────────────────────────────────────────── */
  async function uploadAndAttach(blob, insertInline) {
    if (!window.NOTEBOOK_FIGURES) {
      throw new Error('Upload helper not loaded.');
    }
    setSavingHint('uploading…');
    var meta = await NOTEBOOK_FIGURES.uploadImage(blob);
    var kind = /^image\//.test(meta.mime) ? 'image' : 'pdf';
    var att = {
      kind: kind,
      storage_path: meta.storage_path,
      hash: meta.hash,
      mime: meta.mime,
      size_bytes: meta.size_bytes,
      caption: '',
      uploaded_at: meta.uploaded_at,
      uploaded_by: meta.uploaded_by,
    };
    if (!state.doc.attachments) state.doc.attachments = [];
    state.doc.attachments.push(att);

    if (insertInline && kind === 'image') {
      var bodyEl = document.getElementById('ln-body');
      var html = '<p><img src="' + escapeHtml(meta.download_url) +
        '" data-storage-path="' + escapeHtml(meta.storage_path) +
        '" data-hash="' + escapeHtml(meta.hash) + '" alt=""></p>';
      _insertHtmlAtCaret(bodyEl, html);
      state.doc.body_html = sanitizeHtml(bodyEl.innerHTML);
      refreshBodyEmptyState();
    }

    // V3.360 — refresh only the attachments strip. The old full
    // renderEditor() here blew away the caret mid-paste, so pasting a
    // screenshot while typing dumped you out of the body.
    renderAttachmentsPanel();
    scheduleSave();
    upsertIndexRow(state.doc); renderRail();
    setSavingHint(meta.already_existed ? 'attached (deduped)' : 'attached');
  }

  /* ─────────────────────────────────────────────────────────────
   * Inventory picker — search reagents/equipment, insert as chip
   * ─────────────────────────────────────────────────────────────
   * Inventory lives in the lab-shared `inventory` Firestore collection
   * (read by any signed-in lab member). Loaded once per session and
   * cached on `inventoryState.list`. Chip insertion writes a span with
   * data-inv-* attrs into the body; the post-save `collectInventoryRefs`
   * pass walks the body and rebuilds `state.doc.inventory_refs[]` so
   * the entry-level array is always derivable from chip presence.
   */
  /* GHS code → symbol + label map. Mirrors the values in
   * /rm/js/chemicals.js's GHS_PICTOGRAMS so the visual is consistent
   * with the chemicals page. We keep a local copy so the lab-notebook
   * page doesn't need to load chemicals.js for a 9-entry table. */
  var LN_GHS_MAP = {
    'GHS01': { symbol: '☠', label: 'Explosive' },
    'GHS02': { symbol: '☢', label: 'Flammable' },
    'GHS03': { symbol: '⚠', label: 'Oxidizer' },
    'GHS04': { symbol: '⛅', label: 'Compressed Gas' },
    'GHS05': { symbol: '☠', label: 'Corrosive' },
    'GHS06': { symbol: '☠', label: 'Acute Toxicity' },
    'GHS07': { symbol: '!',      label: 'Irritant' },
    'GHS08': { symbol: '♥', label: 'Health Hazard' },
    'GHS09': { symbol: '☀', label: 'Environmental' },
  };

  function renderGhsPictograms(codes) {
    if (!Array.isArray(codes) || !codes.length) return '';
    return codes.map(function (code) {
      var p = LN_GHS_MAP[code] || { symbol: '?', label: code };
      var cls = 'ln-ghs ln-ghs-' + escapeHtml(code.toLowerCase());
      return '<span class="' + cls + '" title="' + escapeHtml(code + ' — ' + p.label) + '">' +
        escapeHtml(p.symbol) + '</span>';
    }).join('');
  }

  function renderSignalWordPill(word) {
    if (!word) return '';
    var s = String(word).toLowerCase();
    if (s !== 'danger' && s !== 'warning') return '';
    return '<span class="ln-hazard-signal ln-hazard-signal-' + s + '">' +
      escapeHtml(word) + '</span>';
  }

  /* Hazard sibling rendered immediately after a chip. Empty string when
   * the chemical has no hazard data — caller can concatenate without a
   * conditional. */
  function renderChipHazardSibling(invRef) {
    if (!invRef || invRef.kind !== 'chemical') return '';
    var hasSignal = !!invRef.hazard_signal;
    var hasPictos = Array.isArray(invRef.hazard_pictos) && invRef.hazard_pictos.length > 0;
    if (!hasSignal && !hasPictos) return '';
    return '<span class="ln-inv-hazard" data-inv-id="' + escapeHtml(invRef.id) + '">' +
      renderSignalWordPill(invRef.hazard_signal) +
      renderGhsPictograms(invRef.hazard_pictos || []) +
      '</span>';
  }

  function _projectInventoryEntry(it, kind) {
    var safety = (kind === 'chemical' && it.safety) || {};
    var cas = safety.cas_number || '';
    var formula = safety.formula || '';
    // V3.119 — pull through hazard signals + GHS pictograms + storage
    // conditions + MSDS link from the chemical's safety object, plus the
    // free-text locations[] array (currently 0/935 populated, but the
    // ELN renders a "location not set" hint so the surface is ready).
    var pictos = Array.isArray(safety.ghs_pictograms) ? safety.ghs_pictograms.slice() : [];
    var locations = Array.isArray(it.locations) ? it.locations.slice() : [];
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
      // Safety surface (chemicals only). Empty/zero values for items.
      hazard_signal: (kind === 'chemical' ? (safety.signal_word || '') : ''),
      hazard_pictos: pictos,
      hazard_statements: Array.isArray(safety.hazard_statements) ? safety.hazard_statements.slice() : [],
      precautionary_statements: Array.isArray(safety.precautionary_statements) ? safety.precautionary_statements.slice() : [],
      exposure_routes: Array.isArray(safety.exposure_routes) ? safety.exposure_routes.slice() : [],
      ppe_required: Array.isArray(safety.ppe_required) ? safety.ppe_required.slice() : [],
      nfpa: safety.nfpa_ratings && typeof safety.nfpa_ratings === 'object' ? safety.nfpa_ratings : null,
      first_aid: safety.first_aid && typeof safety.first_aid === 'object' ? safety.first_aid : null,
      storage_conditions: safety.storage_conditions || '',
      msds_url: (safety.msds && safety.msds.url) || '',
      // Where the physical item lives (free-text rows).
      locations: locations,
      search: ((it.name || '') + ' ' + (it.vendor || '') + ' ' +
               (it.catalogue_number || '') + ' ' + cas + ' ' +
               formula + ' ' + (it.description || '') + ' ' +
               (it.category || '') + ' ' + (it.subcategory || '')).toLowerCase(),
    };
  }

  async function ensureInventoryList() {
    if (inventoryState.list) return inventoryState.list;
    try {
      var both = await Promise.all([
        api.load('inventory/items.json').catch(function (e) {
          console.warn('[lab-notebook] inventory items load failed:', e && e.message || e);
          return null;
        }),
        api.load('inventory/chemicals.json').catch(function (e) {
          console.warn('[lab-notebook] inventory chemicals load failed:', e && e.message || e);
          return null;
        }),
      ]);
      var items = ((both[0] && both[0].items) || []).map(function (it) {
        return _projectInventoryEntry(it, 'item');
      });
      var chems = ((both[1] && both[1].chemicals) || []).map(function (it) {
        return _projectInventoryEntry(it, 'chemical');
      });
      function byName(a, b) {
        return (a.name || '').toLowerCase().localeCompare((b.name || '').toLowerCase());
      }
      chems.sort(byName);
      items.sort(byName);
      // Chemicals first (more frequent at the bench) then equipment.
      inventoryState.list = chems.concat(items);
      return inventoryState.list;
    } catch (err) {
      console.warn('[lab-notebook] inventory load failed:', err && err.message);
      inventoryState.list = [];
      return inventoryState.list;
    }
  }

  function _ensureInventoryPopover() {
    if (inventoryState.popover) return inventoryState.popover;
    var pop = document.createElement('div');
    pop.className = 'ln-inv-popover';
    pop.hidden = true;
    pop.innerHTML =
      '<div class="ln-inv-pop-title">Insert reagent / equipment</div>' +
      '<input type="text" class="ln-inv-pop-search" placeholder="Search by name, vendor, catalog #, CAS, category…" autocomplete="off">' +
      '<div class="ln-inv-pop-list" role="listbox"></div>' +
      '<div class="ln-inv-pop-hint">' +
        '<kbd>↑</kbd>/<kbd>↓</kbd> navigate · <kbd>Enter</kbd> insert · <kbd>Esc</kbd> close' +
      '</div>';
    document.body.appendChild(pop);
    inventoryState.popover = pop;

    var input = pop.querySelector('.ln-inv-pop-search');
    var listEl = pop.querySelector('.ln-inv-pop-list');
    var activeIdx = 0;
    var current = [];

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
        listEl.innerHTML = '<div class="ln-inv-pop-empty">No matching inventory items.</div>';
        return;
      }
      current.forEach(function (e, i) {
        var row = document.createElement('button');
        row.type = 'button';
        row.className = 'ln-inv-pop-row';
        if (i === activeIdx) row.classList.add('active');
        var kindBadge = '<span class="ln-inv-kind-badge ln-inv-kind-' +
          (e.kind || 'item') + '">' +
          escapeHtml(e.kind === 'chemical' ? 'chemical' : 'item') +
          '</span>';
        // V3.119 — show the Danger/Warning pill + GHS pictograms in the
        // picker row meta. Most valuable place for the warning to live:
        // the student sees it BEFORE picking, not just after.
        var hazardInline = '';
        if (e.kind === 'chemical' && (e.hazard_signal || (e.hazard_pictos && e.hazard_pictos.length))) {
          hazardInline = '<span class="ln-inv-pop-hazard">' +
            renderSignalWordPill(e.hazard_signal) +
            renderGhsPictograms(e.hazard_pictos || []) +
            '</span>';
        }
        var metaParts = [];
        if (e.vendor) metaParts.push(escapeHtml(e.vendor));
        if (e.cat) metaParts.push('cat. ' + escapeHtml(e.cat));
        if (e.cas) metaParts.push('CAS ' + escapeHtml(e.cas));
        if (e.formula) metaParts.push(escapeHtml(e.formula));
        if (e.category) metaParts.push(escapeHtml(e.category) + (e.subcategory ? ' / ' + escapeHtml(e.subcategory) : ''));
        if (Array.isArray(e.locations) && e.locations.length) {
          metaParts.push('📍 ' + escapeHtml(e.locations.length + ' location' + (e.locations.length === 1 ? '' : 's')));
        }
        row.innerHTML =
          '<div class="ln-inv-pop-key">' +
            kindBadge +
            '<span class="ln-inv-pop-name">' + escapeHtml(e.name || '(no name)') + '</span>' +
            hazardInline +
          '</div>' +
          '<div class="ln-inv-pop-meta">' + metaParts.join(' · ') + '</div>' +
          (e.desc ? '<div class="ln-inv-pop-desc">' + escapeHtml(e.desc.slice(0, 140)) + '</div>' : '');
        // V3.148 — DO NOT call renderList() on mouseenter. The full
        // rebuild was racing the click event: when the cursor entered
        // a row, the row got destroyed-and-recreated synchronously,
        // and the user's mousedown landed on the parent .ln-inv-pop-list
        // instead of the row button. Bug confirmed via V3.147 console
        // output: target = DIV class=ln-inv-pop-list, never the row.
        // Just toggle the active class in place.
        row.addEventListener('mouseenter', function () {
          if (activeIdx === i) return;
          activeIdx = i;
          Array.prototype.forEach.call(listEl.querySelectorAll('.ln-inv-pop-row'), function (r, idx) {
            r.classList.toggle('active', idx === i);
          });
        });
        row.addEventListener('mousedown', function (ev) { ev.preventDefault(); });
        row.addEventListener('click', function () { pickIndex(i); });
        listEl.appendChild(row);
      });
    }
    function pickIndex(i) {
      var entry = current[i];
      if (!entry) return;
      pop.hidden = true;
      insertInventoryChip(entry);
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
    pop._focus = function () { input.value = ''; input.focus(); };
    return pop;
  }

  /* V3.151 — Position a popover next to the button that opened it,
   * clamped to the viewport with a small margin. Default placement is
   * directly below the anchor's bottom edge, left-aligned. If the
   * popover would overflow the right or bottom edge, slide it left
   * (or above the anchor) so it stays fully visible. Falls back to a
   * top-center position when no anchor is provided. The clamp runs in
   * a requestAnimationFrame so the popover's actual rendered size is
   * known before measuring. */
  function _positionPopoverNearAnchor(popEl, anchorEl) {
    if (!popEl) return;
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
      // Horizontal clamp.
      if (leftPx + pRect.width > window.innerWidth - marginPx) {
        leftPx = Math.max(marginPx, window.innerWidth - pRect.width - marginPx);
      }
      if (leftPx < marginPx) leftPx = marginPx;
      // Vertical clamp: if it overflows below, try placing above the
      // anchor; if that also overflows, top-clamp to viewport.
      if (topPx + pRect.height > window.innerHeight - marginPx) {
        var topAlt = aRect.top - pRect.height - offsetY;
        if (topAlt >= marginPx) {
          topPx = topAlt;
        } else {
          topPx = Math.max(marginPx, window.innerHeight - pRect.height - marginPx);
        }
      }
      if (topPx < marginPx) topPx = marginPx;
      popEl.style.left = leftPx + 'px';
      popEl.style.top = topPx + 'px';
    });
  }

  async function openInventoryPicker(anchorEl) {
    if (!state.doc) return;
    setSavingHint('loading inventory…');
    await ensureInventoryList();
    setSavingHint('');
    var pop = _ensureInventoryPopover();
    _positionPopoverNearAnchor(pop, anchorEl);
    pop._refresh();
    pop.hidden = false;
    pop._focus();
  }

  /* V3.139 — Robust caret + selection setup for HTML insertion.
   *
   * The V3.134 `_ensureBodyCaret` fixed the rangeCount=0 case for
   * `document.execCommand('insertHTML', …)`, but execCommand itself
   * is increasingly unreliable across browsers and silently no-ops in
   * cases where the body has been freshly re-rendered. V3.139 adds a
   * Selection-API-only fallback path so chip insertion works
   * regardless of execCommand quirks.
   *
   * Order of attempts in `_insertHtmlAtCaret`:
   *   1) Set range to end-of-body if not already inside the body.
   *   2) Try `document.execCommand('insertHTML', false, html)` (fast path,
   *      maintains undo history).
   *   3) Verify the HTML actually landed; if not, fall through to (4).
   *   4) Use `range.insertNode()` with a parsed DocumentFragment.
   *      Fire a synthetic `input` event so the autosave + ref-collect
   *      listeners run. */
  function _ensureBodyCaret(bodyEl) {
    if (!bodyEl) return;
    bodyEl.focus();
    var sel = window.getSelection();
    var insideBody = false;
    if (sel && sel.rangeCount) {
      var anchor = sel.getRangeAt(0).startContainer;
      var node = anchor.nodeType === 1 ? anchor : anchor.parentNode;
      insideBody = !!(node && bodyEl.contains(node));
    }
    if (!insideBody) {
      if (!sel) sel = window.getSelection();
      // If the body is empty, give it a placeholder so the caret has
      // something to land on. The browser's contentEditable normaliser
      // will collapse this back if a real chip is inserted.
      if (!bodyEl.firstChild) {
        bodyEl.appendChild(document.createElement('br'));
      }
      var range = document.createRange();
      range.selectNodeContents(bodyEl);
      range.collapse(false);   // place caret at end
      sel.removeAllRanges();
      sel.addRange(range);
    }
  }

  /* V3.143 — Direct append into the body, bypassing focus + selection
   * + execCommand entirely. Used for picker chip inserts where the
   * user's mental model is "pick → it goes into the entry"; preserving
   * the previous caret position in body has zero value (and lots of
   * cost — focus transfer from the popover input has been unreliable
   * across browsers in V3.134/V3.142).
   *
   * Fires an `input` event so the body's autosave + ref-collect +
   * panel re-render listeners still run. This is the path every
   * inventory-chip / protocol-chip / calc-block inserter now uses. */
  function _appendHtmlToBody(bodyEl, html) {
    if (!bodyEl || !html) return false;
    var template = document.createElement('template');
    template.innerHTML = html;
    while (template.content.firstChild) {
      bodyEl.appendChild(template.content.firstChild);
    }
    try { bodyEl.dispatchEvent(new Event('input', { bubbles: true })); } catch (_) {}
    return true;
  }

  /* Insert raw HTML at the current caret in the body. Returns true on
   * success, false if every fallback failed. Always fires an input event
   * so the body's input listener (autosave + ref-collect + panel re-render)
   * runs whether execCommand or the Selection-API path took. Used for
   * paste / drop image insertion where the caret position in body is
   * meaningful (the user is mid-typing). For picker inserts, prefer
   * `_appendHtmlToBody` which bypasses focus quirks. */
  function _insertHtmlAtCaret(bodyEl, html) {
    if (!bodyEl || !html) return false;
    _ensureBodyCaret(bodyEl);

    var beforeLen = bodyEl.innerHTML.length;
    var execOk = false;
    try {
      execOk = document.execCommand('insertHTML', false, html);
    } catch (_) { execOk = false; }
    var grew = bodyEl.innerHTML.length > beforeLen;
    if (execOk && grew) {
      // Fire input event manually because execCommand on contentEditable
      // sometimes doesn't trigger one for the lab-notebook's listener
      // (browser-version dependent). Idempotent — the listener handles
      // its own debounce.
      try { bodyEl.dispatchEvent(new Event('input', { bubbles: true })); } catch (_) {}
      return true;
    }

    // ── Selection-API fallback ──
    var sel = window.getSelection();
    if (!sel || !sel.rangeCount) {
      // No selection — nothing to anchor against. Append at end as a
      // last resort.
      var template = document.createElement('template');
      template.innerHTML = html;
      while (template.content.firstChild) {
        bodyEl.appendChild(template.content.firstChild);
      }
      try { bodyEl.dispatchEvent(new Event('input', { bubbles: true })); } catch (_) {}
      return true;
    }
    var range = sel.getRangeAt(0);
    range.deleteContents();
    var tmpl = document.createElement('template');
    tmpl.innerHTML = html;
    var frag = tmpl.content;
    var lastNode = frag.lastChild;
    range.insertNode(frag);
    if (lastNode) {
      var newRange = document.createRange();
      newRange.setStartAfter(lastNode);
      newRange.collapse(true);
      sel.removeAllRanges();
      sel.addRange(newRange);
    }
    try { bodyEl.dispatchEvent(new Event('input', { bubbles: true })); } catch (_) {}
    return true;
  }

  /* Insert a non-editable inventory chip at the current caret position
   * inside the body contentEditable. The chip carries the inventory id
   * + display fields as data attrs; collectInventoryRefs (post-save)
   * walks all chips and rebuilds the entry's inventory_refs[] array. */
  function insertInventoryChip(item) {
    var bodyEl = document.getElementById('ln-body');
    if (!bodyEl) return;
    _ensureBodyCaret(bodyEl);
    var label = item.name + (
      item.vendor || item.cat || item.cas
        ? ' (' + [
            item.vendor || null,
            item.cat ? 'cat. ' + item.cat : null,
            item.kind === 'chemical' && item.cas ? 'CAS ' + item.cas : null,
          ].filter(Boolean).join(', ') + ')'
        : ''
    );
    // V3.119 — stamp hazard signal + GHS codes + locations + storage
    // conditions onto the chip so collectInventoryRefs can rebuild the
    // entry-level inventory_refs[] from the body without re-fetching
    // the full inventory list. Locations are JSON-stringified into a
    // single attr; sanitizer treats it as opaque text.
    var pictosCsv = Array.isArray(item.hazard_pictos) ? item.hazard_pictos.join(',') : '';
    var locsJson  = Array.isArray(item.locations) ? JSON.stringify(item.locations) : '[]';
    var chipHtml =
      '<span class="ln-inv-chip" contenteditable="false"' +
        ' data-inv-id="'     + escapeHtml(item.id || '') + '"' +
        ' data-inv-kind="'   + escapeHtml(item.kind || 'item') + '"' +
        ' data-inv-name="'   + escapeHtml(item.name || '') + '"' +
        ' data-inv-vendor="' + escapeHtml(item.vendor || '') + '"' +
        ' data-inv-cat="'    + escapeHtml(item.cat || '') + '"' +
        ' data-inv-cas="'    + escapeHtml(item.cas || '') + '"' +
        ' data-inv-hazard-signal="' + escapeHtml(item.hazard_signal || '') + '"' +
        ' data-inv-hazard-pictos="' + escapeHtml(pictosCsv) + '"' +
        ' data-inv-locations="' + escapeHtml(locsJson) + '"' +
        ' data-inv-storage="'   + escapeHtml(item.storage_conditions || '') + '">' +
        escapeHtml(label) +
      '</span>' +
      // Hazard sibling renders immediately after the chip. The sibling
      // is itself contenteditable=false so it travels as one unit with
      // the chip during copy/paste/delete.
      (item.kind === 'chemical' ? renderChipHazardSibling(item) : '') +
      '&nbsp;';
    // V3.143 — direct append (no caret, no focus, no execCommand). The
    // picker stole focus from the body; transferring it back has been
    // unreliable across browsers, so we bypass focus + selection
    // entirely and append the chip to the end of the body. The user's
    // mental model is "pick → it goes into the entry"; preserving
    // their previous caret position in body has zero value.
    var ok = _appendHtmlToBody(bodyEl, chipHtml);
    if (!ok) {
      console.warn('[lab-notebook] inventory chip insert failed for', item.id);
      setSavingHint('insert failed');
      return;
    }
    state.doc.body_html = sanitizeHtml(bodyEl.innerHTML);
    collectInventoryRefs();
    refreshBodyEmptyState();
    renderMaterialsPanel();
    scheduleSave();
    upsertIndexRow(state.doc); renderRail();
    setSavingHint('inserted: ' + item.name);
  }

  /* Walk the body for chips and rebuild state.doc.inventory_refs[].
   * Order = first-occurrence order in the body; duplicate chip references
   * to the same inventory id collapse to a single ref. */
  function collectInventoryRefs() {
    if (!state.doc) return;
    var bodyEl = document.getElementById('ln-body');
    if (!bodyEl) return;
    var seen = {};
    var refs = [];
    Array.prototype.forEach.call(bodyEl.querySelectorAll('span.ln-inv-chip'), function (chip) {
      var id = chip.getAttribute('data-inv-id');
      if (!id || seen[id]) return;
      seen[id] = true;
      // V3.119 — also derive the hazard signal, GHS pictograms,
      // locations, and storage conditions from the chip's data attrs
      // so the entry-level inventory_refs[] reflects what's in the
      // body without needing the inventory list to still be loaded.
      var pictosCsv = chip.getAttribute('data-inv-hazard-pictos') || '';
      var locsRaw   = chip.getAttribute('data-inv-locations') || '[]';
      var locs = [];
      try { locs = JSON.parse(locsRaw); if (!Array.isArray(locs)) locs = []; }
      catch (_) { locs = []; }
      refs.push({
        id: id,
        kind: chip.getAttribute('data-inv-kind') || 'item',
        name: chip.getAttribute('data-inv-name') || '',
        vendor: chip.getAttribute('data-inv-vendor') || '',
        cat: chip.getAttribute('data-inv-cat') || '',
        cas: chip.getAttribute('data-inv-cas') || '',
        hazard_signal: chip.getAttribute('data-inv-hazard-signal') || '',
        hazard_pictos: pictosCsv ? pictosCsv.split(',').filter(Boolean) : [],
        locations: locs,
        storage_conditions: chip.getAttribute('data-inv-storage') || '',
      });
    });
    state.doc.inventory_refs = refs;
  }

  /* ─────────────────────────────────────────────────────────────
   * Safety details modal (V3.119)
   * ─────────────────────────────────────────────────────────────
   * Click any chip's hazard sibling, the Materials panel hazard
   * column, or the picker row hazard inline → open this read-only
   * modal showing the chemical's full safety sheet. Reuses the
   * V3.118 .ln-modal-* chrome unchanged. We look up the full record
   * from inventoryState.list (not just the chip data attrs) so the
   * modal can show H-codes / P-codes / PPE / NFPA / first aid / MSDS
   * link without bloating chip HTML beyond its current attrs.
   */
  async function openSafetyDetailsModal(invId) {
    if (!invId) return;
    setSavingHint('loading safety…');
    await ensureInventoryList();
    setSavingHint('');
    var rec = (inventoryState.list || []).find(function (e) { return e.id === invId; });
    if (!rec) {
      alert('Inventory record not found: ' + invId);
      return;
    }
    var back = document.createElement('div');
    back.className = 'ln-modal-back';
    back.innerHTML =
      '<div class="ln-modal ln-safety-modal" role="dialog" aria-label="Chemical safety details">' +
        '<div class="ln-modal-head">' +
          '<h2>' + escapeHtml(rec.name || invId) +
            '<span class="ln-modal-sub">' +
              (rec.cas ? 'CAS ' + escapeHtml(rec.cas) : '') +
              (rec.cas && rec.formula ? ' · ' : '') +
              (rec.formula ? escapeHtml(rec.formula) : '') +
            '</span>' +
          '</h2>' +
          '<button class="ln-modal-x" aria-label="Close">×</button>' +
        '</div>' +
        '<div class="ln-modal-body ln-safety-modal-body">' +
          renderSafetyModalBody(rec) +
        '</div>' +
        '<div class="ln-modal-foot">' +
          '<button class="ln-modal-cancel">Close</button>' +
        '</div>' +
      '</div>';
    document.body.appendChild(back);

    function close() {
      if (document.body.contains(back)) document.body.removeChild(back);
    }
    back.querySelector('.ln-modal-x').addEventListener('click', close);
    back.querySelector('.ln-modal-cancel').addEventListener('click', close);
    back.addEventListener('click', function (e) { if (e.target === back) close(); });
    document.addEventListener('keydown', function escClose(e) {
      if (e.key === 'Escape' && document.body.contains(back)) {
        close();
        document.removeEventListener('keydown', escClose);
      }
    });
  }

  function renderSafetyModalBody(rec) {
    var html = '';

    // Header strip: signal word + pictograms with full labels
    var headStrip = renderSignalWordPill(rec.hazard_signal);
    if (rec.hazard_pictos && rec.hazard_pictos.length) {
      headStrip += '<div class="ln-safety-pict-row">' + (rec.hazard_pictos || []).map(function (code) {
        var p = LN_GHS_MAP[code] || { symbol: '?', label: code };
        return '<span class="ln-safety-pict">' +
          '<span class="ln-ghs ln-ghs-' + escapeHtml(code.toLowerCase()) + '">' + escapeHtml(p.symbol) + '</span>' +
          '<span class="ln-safety-pict-label">' + escapeHtml(p.label) + '</span>' +
          '</span>';
      }).join('') + '</div>';
    }
    if (headStrip) html += '<div class="ln-safety-strip">' + headStrip + '</div>';

    if (!rec.hazard_signal && (!rec.hazard_pictos || !rec.hazard_pictos.length)) {
      html += '<p class="ln-safety-noted">No GHS hazard data on file. Treat as non-hazardous; ' +
        'still follow lab PPE guidance.</p>';
    }

    if (rec.hazard_statements && rec.hazard_statements.length) {
      html += '<dl><dt>Hazard statements (H-codes)</dt>' +
        '<dd><ul>' + rec.hazard_statements.map(function (h) {
          return '<li>' + escapeHtml(h) + '</li>';
        }).join('') + '</ul></dd></dl>';
    }
    if (rec.precautionary_statements && rec.precautionary_statements.length) {
      html += '<dl><dt>Precautionary statements (P-codes)</dt>' +
        '<dd><ul>' + rec.precautionary_statements.map(function (p) {
          return '<li>' + escapeHtml(p) + '</li>';
        }).join('') + '</ul></dd></dl>';
    }
    if (rec.exposure_routes && rec.exposure_routes.length) {
      html += '<dl><dt>Exposure routes</dt><dd>' + rec.exposure_routes.map(function (r) {
        return '<span class="ln-safety-chip">' + escapeHtml(r) + '</span>';
      }).join('') + '</dd></dl>';
    }
    if (rec.ppe_required && rec.ppe_required.length) {
      html += '<dl><dt>PPE required</dt><dd>' + rec.ppe_required.map(function (p) {
        return '<span class="ln-safety-chip ln-safety-chip-ppe">' + escapeHtml(p) + '</span>';
      }).join('') + '</dd></dl>';
    }
    if (rec.nfpa) {
      html += '<dl><dt>NFPA 704 ratings</dt><dd>' + renderNfpaDiamond(rec.nfpa) + '</dd></dl>';
    }
    if (rec.first_aid) {
      var fa = rec.first_aid;
      html += '<dl><dt>First aid</dt><dd>';
      if (fa.inhalation)  html += '<p><strong>Inhalation:</strong> '   + escapeHtml(fa.inhalation)   + '</p>';
      if (fa.skin_contact) html += '<p><strong>Skin contact:</strong> ' + escapeHtml(fa.skin_contact) + '</p>';
      if (fa.eye_contact) html += '<p><strong>Eye contact:</strong> '  + escapeHtml(fa.eye_contact)  + '</p>';
      if (fa.ingestion)   html += '<p><strong>Ingestion:</strong> '    + escapeHtml(fa.ingestion)    + '</p>';
      html += '</dd></dl>';
    }
    if (rec.storage_conditions) {
      html += '<dl><dt>Storage</dt><dd>🌡 ' + escapeHtml(rec.storage_conditions) + '</dd></dl>';
    }
    if (rec.locations && rec.locations.length) {
      html += '<dl><dt>Where to find it</dt><dd>' + rec.locations.map(function (l) {
        var qty = (l.quantity != null && l.quantity !== '') ? ' (' + escapeHtml(String(l.quantity)) + ')' : '';
        var notes = l.notes ? ' — ' + escapeHtml(l.notes) : '';
        return '<div>📍 ' + escapeHtml(l.name || '') + qty + notes + '</div>';
      }).join('') + '</dd></dl>';
    } else {
      html += '<dl><dt>Where to find it</dt><dd><em class="ln-loc-empty-mini">📍 location not set — admins can populate via ' +
        '<a href="/rm/pages/inventory.html" target="_blank" rel="noopener">Inventory</a>.</em></dd></dl>';
    }
    if (rec.msds_url) {
      html += '<dl><dt>SDS / MSDS</dt><dd><a href="' + escapeHtml(rec.msds_url) + '" target="_blank" rel="noopener noreferrer">' +
        escapeHtml(rec.msds_url) + '</a></dd></dl>';
    }
    return html;
  }

  function renderNfpaDiamond(n) {
    var h = (n && n.health != null) ? n.health : '';
    var f = (n && n.flammability != null) ? n.flammability : '';
    var i = (n && n.instability != null) ? n.instability : '';
    var s = (n && n.special) ? n.special : '';
    return '<div class="ln-nfpa">' +
      '<span class="ln-nfpa-q ln-nfpa-h" title="Health">' + escapeHtml(String(h)) + '</span>' +
      '<span class="ln-nfpa-q ln-nfpa-f" title="Flammability">' + escapeHtml(String(f)) + '</span>' +
      '<span class="ln-nfpa-q ln-nfpa-i" title="Instability">' + escapeHtml(String(i)) + '</span>' +
      '<span class="ln-nfpa-q ln-nfpa-s" title="Special">' + escapeHtml(String(s)) + '</span>' +
      '</div>';
  }

  /* ─────────────────────────────────────────────────────────────
   * Protocol picker — search lab protocols, insert as anchor chip
   * ─────────────────────────────────────────────────────────────
   * Protocols live in the lab-shared `protocols` Firestore collection
   * (V3.113 Protocols Builder); any signed-in lab member can read the
   * list. Loaded once per session, cached on `protocolState.list`.
   * Chip is an <a> so click → jumps to the protocol editor at
   *   /rm/pages/protocols.html?protocol=<id>
   * `collectProtocolRefs()` walks the body and rebuilds
   * state.doc.protocol_refs[] post-save (mirrors collectInventoryRefs).
   */
  function _projectProtocolEntry(p) {
    var summary = p.summary || '';
    var category = p.category || '';
    var tags = Array.isArray(p.tags) ? p.tags.join(' ') : '';
    return {
      id: p.id,
      title: p.title || '(untitled)',
      summary: summary,
      category: category,
      status: p.status || 'draft',
      tags: Array.isArray(p.tags) ? p.tags.slice() : [],
      updated_at: p.updated_at || '',
      search: ((p.title || '') + ' ' + summary + ' ' + category + ' ' + tags + ' ' +
               (p.id || '')).toLowerCase(),
    };
  }

  async function ensureProtocolList() {
    if (protocolState.list) return protocolState.list;
    try {
      var d = await api.load('protocols/list.json');
      var rows = (d && d.protocols) || [];
      protocolState.list = rows.map(_projectProtocolEntry).sort(function (a, b) {
        // Most-recently-updated first, then alphabetical fallback.
        if (a.updated_at && b.updated_at && a.updated_at !== b.updated_at) {
          return b.updated_at.localeCompare(a.updated_at);
        }
        return a.title.toLowerCase().localeCompare(b.title.toLowerCase());
      });
      return protocolState.list;
    } catch (err) {
      console.warn('[lab-notebook] protocol list load failed:', err && err.message);
      protocolState.list = [];
      return protocolState.list;
    }
  }

  function _ensureProtocolPopover() {
    if (protocolState.popover) return protocolState.popover;
    var pop = document.createElement('div');
    // Reuse the inventory popover styling — the layout is identical.
    pop.className = 'ln-inv-popover ln-protocol-popover';
    pop.hidden = true;
    pop.innerHTML =
      '<div class="ln-inv-pop-title">Insert a protocol <span class="ln-pop-subtitle">— click for full · "ref only" for chip · "🧮 calc" for calculator</span></div>' +
      '<input type="text" class="ln-inv-pop-search" placeholder="Search by title, summary, category, tag…" autocomplete="off">' +
      '<div class="ln-inv-pop-list" role="listbox"></div>' +
      '<div class="ln-inv-pop-hint">' +
        '<kbd>↑</kbd>/<kbd>↓</kbd> navigate · <kbd>Enter</kbd> full · <kbd>Shift</kbd>+<kbd>Enter</kbd> ref · <kbd>Alt</kbd>+<kbd>Enter</kbd> calc · <kbd>Esc</kbd> close · ' +
        '<a href="/rm/pages/protocols.html" target="_blank" rel="noopener">open protocols ↗</a>' +
      '</div>';
    document.body.appendChild(pop);
    protocolState.popover = pop;

    var input = pop.querySelector('.ln-inv-pop-search');
    var listEl = pop.querySelector('.ln-inv-pop-list');
    var activeIdx = 0;
    var current = [];

    pop._refresh = function () {
      var q = input.value.trim().toLowerCase();
      var src = protocolState.list || [];
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
        listEl.innerHTML = '<div class="ln-inv-pop-empty">No matching protocols. Create one in the Protocols builder, then come back.</div>';
        return;
      }
      current.forEach(function (e, i) {
        var row = document.createElement('button');
        row.type = 'button';
        row.className = 'ln-inv-pop-row ln-protocol-pop-row';
        if (i === activeIdx) row.classList.add('active');
        var statusBadge = '<span class="ln-protocol-status ln-protocol-status-' +
          escapeHtml(e.status) + '">' + escapeHtml(e.status) + '</span>';
        var metaParts = [];
        if (e.category) metaParts.push(escapeHtml(e.category));
        if (e.tags && e.tags.length) metaParts.push(e.tags.slice(0, 3).map(escapeHtml).join(' · '));
        if (e.updated_at) metaParts.push('updated ' + escapeHtml(e.updated_at.slice(0, 10)));
        // V3.127 — default action is "Insert full protocol" (the user
        // ask). V3.135 adds a third sub-action `🧮 calc` for "use this
        // protocol as a calculator." Reference-only stays as the
        // secondary path. Keyboard:
        //   Enter            → full insert
        //   Shift+Enter      → ref only
        //   Alt+Enter        → calc
        row.innerHTML =
          '<div class="ln-inv-pop-key">' +
            statusBadge +
            '<span class="ln-inv-pop-name">' + escapeHtml(e.title) + '</span>' +
            '<span class="ln-protocol-row-actions">' +
              '<span class="ln-protocol-row-calc" title="Open calculator for this protocol (Alt+Enter)">🧮 calc</span>' +
              '<span class="ln-protocol-row-ref" title="Insert reference chip only (Shift+Enter)">ref only</span>' +
            '</span>' +
          '</div>' +
          (metaParts.length ? '<div class="ln-inv-pop-meta">' + metaParts.join(' · ') + '</div>' : '') +
          (e.summary ? '<div class="ln-inv-pop-desc">' + escapeHtml(e.summary.slice(0, 140)) + '</div>' : '');
        // V3.148 — same mouseenter fix as inventory picker; see comment there.
        row.addEventListener('mouseenter', function () {
          if (activeIdx === i) return;
          activeIdx = i;
          Array.prototype.forEach.call(listEl.querySelectorAll('.ln-inv-pop-row'), function (r, idx) {
            r.classList.toggle('active', idx === i);
          });
        });
        row.addEventListener('mousedown', function (ev) { ev.preventDefault(); });
        row.addEventListener('click', function (ev) {
          // Sub-action routing: "🧮 calc" → calculator; "ref only" →
          // reference chip; rest of the row → full protocol body +
          // materials chips (V3.127).
          var classes = (ev.target && ev.target.classList) || { contains: function () { return false; } };
          var mode = classes.contains('ln-protocol-row-calc') ? 'calc'
                   : classes.contains('ln-protocol-row-ref')  ? 'ref'
                   : 'full';
          pickIndex(i, mode);
        });
        listEl.appendChild(row);
      });
    }
    function pickIndex(i, mode) {
      var entry = current[i];
      if (!entry) return;
      pop.hidden = true;
      if (mode === 'ref') {
        insertProtocolChip(entry);
      } else if (mode === 'calc') {
        // Add a reference chip first so Protocols-followed shows the
        // source — the user said "associated protocol" implies the
        // protocol is in the entry's protocol_refs[].
        insertProtocolChip(entry);
        openProtocolCalculator(entry.id).catch(function (err) {
          console.error('[lab-notebook] openProtocolCalculator failed:', err);
        });
      } else {
        insertFullProtocol(entry).catch(function (err) {
          console.error('[lab-notebook] insertFullProtocol failed:', err);
        });
      }
    }
    input.addEventListener('input', pop._refresh);
    input.addEventListener('keydown', function (e) {
      if (e.key === 'Escape') { pop.hidden = true; e.preventDefault(); return; }
      if (e.key === 'Enter')  {
        var mode = e.altKey ? 'calc' : (e.shiftKey ? 'ref' : 'full');
        pickIndex(activeIdx, mode);
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
    document.addEventListener('mousedown', function (e) {
      if (!pop.hidden && !pop.contains(e.target)) pop.hidden = true;
    });
    pop._focus = function () { input.value = ''; input.focus(); };
    return pop;
  }

  async function openProtocolPicker(anchorEl) {
    if (!state.doc) return;
    setSavingHint('loading protocols…');
    await ensureProtocolList();
    setSavingHint('');
    var pop = _ensureProtocolPopover();
    _positionPopoverNearAnchor(pop, anchorEl);
    pop._refresh();
    pop.hidden = false;
    pop._focus();
  }

  function insertProtocolChip(p) {
    var bodyEl = document.getElementById('ln-body');
    if (!bodyEl) return;
    var url = '/rm/pages/protocols.html?protocol=' + encodeURIComponent(p.id);
    var chipHtml =
      '<a class="ln-protocol-chip" contenteditable="false"' +
        ' href="' + escapeHtml(url) + '"' +
        ' data-protocol-id="' + escapeHtml(p.id) + '"' +
        ' data-protocol-title="' + escapeHtml(p.title || '') + '"' +
        ' title="Open protocol in a new tab">' +
        '📋 ' + escapeHtml(p.title || p.id) +
      '</a>&nbsp;';
    // V3.143 — direct append; see comment in insertInventoryChip.
    var ok = _appendHtmlToBody(bodyEl, chipHtml);
    if (!ok) {
      console.warn('[lab-notebook] protocol chip insert failed for', p.id);
      setSavingHint('insert failed');
      return;
    }
    state.doc.body_html = sanitizeHtml(bodyEl.innerHTML);
    collectProtocolRefs();
    refreshBodyEmptyState();
    renderProtocolsPanel();
    scheduleSave();
    upsertIndexRow(state.doc); renderRail();
    setSavingHint('referenced: ' + (p.title || p.id));
  }

  /* Rebuild state.doc.protocol_refs[] (the "Protocols followed" list).
   * Two sources, merged + deduped by id, first-occurrence order:
   *   1. The protocol mounted LIVE in-situ (state.doc.protocol_run) — always
   *      counted, with no body chip required. This is the primary path
   *      since V3.506 dropped the link-chip insert for the "full" action.
   *   2. Legacy `ref only` chips still in the body (a.ln-protocol-chip) —
   *      the lightweight quick-action that intentionally stays a link. */
  function collectProtocolRefs() {
    if (!state.doc) return;
    var seen = {};
    var refs = [];
    var run = state.doc.protocol_run;
    if (run && run.protocol_id && !seen[run.protocol_id]) {
      seen[run.protocol_id] = true;
      refs.push({ id: run.protocol_id, title: run.protocol_title || run.protocol_id });
    }
    var bodyEl = document.getElementById('ln-body');
    if (bodyEl) {
      Array.prototype.forEach.call(bodyEl.querySelectorAll('a.ln-protocol-chip'), function (chip) {
        var id = chip.getAttribute('data-protocol-id');
        if (!id || seen[id]) return;
        seen[id] = true;
        refs.push({
          id: id,
          title: chip.getAttribute('data-protocol-title') || '',
        });
      });
    }
    state.doc.protocol_refs = refs;
  }

  /* ─────────────────────────────────────────────────────────────
   * Insert FULL protocol — V3.127
   * ─────────────────────────────────────────────────────────────
   * Loads the protocol's Yjs state from Firestore (yjs_snapshot/state +
   * yjs_updates/* applied to a fresh Y.Doc), dehydrates the tree to
   * plain JSON, renders it as HTML into the entry body, and for every
   * materials-block row that carries an `item_ref` looks up the
   * inventory record and appends an inventory chip — so the lab
   * notebook's Materials Used panel auto-populates from the protocol's
   * materials block. The protocol-reference chip is also inserted (so
   * Protocols-followed shows the source).
   *
   * Yjs is loaded lazily on first use — adds ~50 KB to the lab notebook
   * page only when a student actually pulls a full protocol in. The
   * dehydrate helpers below mirror protocol-blocks.js's
   * dehydrateTree/Section/Block but stay self-contained so we don't
   * need to load protocol-blocks.js (which has render-side deps that
   * would fail on this page).
   */

  var _yjsModule = null;
  function _ensureYjs() {
    if (_yjsModule) return Promise.resolve(_yjsModule);
    return import('https://cdn.jsdelivr.net/npm/yjs@13/+esm').then(function (mod) {
      _yjsModule = mod;
      return mod;
    });
  }

  function _b64ToBytes(b64) {
    var bin = atob(b64);
    var arr = new Uint8Array(bin.length);
    for (var i = 0; i < bin.length; i++) arr[i] = bin.charCodeAt(i);
    return arr;
  }

  function _dehydrateBlock(yBlock) {
    var out = {
      id: yBlock.get('id'),
      kind: yBlock.get('kind'),
      status: yBlock.get('status') || 'draft',
      body: '',
      attrs: {},
    };
    var body = yBlock.get('body');
    if (body && typeof body.toString === 'function') out.body = body.toString();
    var yAttrs = yBlock.get('attrs');
    if (yAttrs && typeof yAttrs.forEach === 'function') {
      yAttrs.forEach(function (v, k) {
        if (v && typeof v.toArray === 'function') {
          out.attrs[k] = v.toArray().map(function (item) {
            if (item && typeof item.forEach === 'function') {
              var obj = {};
              item.forEach(function (mv, mk) {
                obj[mk] = (mv && typeof mv.toString === 'function' && typeof mv.forEach !== 'function')
                  ? mv.toString() : mv;
              });
              return obj;
            }
            return item;
          });
        } else if (v && typeof v.forEach === 'function' && typeof v.toString !== 'function') {
          var obj = {};
          v.forEach(function (mv, mk) { obj[mk] = mv; });
          out.attrs[k] = obj;
        } else if (v && typeof v.toString === 'function' && typeof v.forEach === 'function' && typeof v.length === 'number') {
          out.attrs[k] = v.toString();
        } else {
          out.attrs[k] = v;
        }
      });
    }
    return out;
  }

  function _dehydrateSection(ySec) {
    var children = [];
    var yChildren = ySec.get('children');
    if (yChildren && typeof yChildren.toArray === 'function') {
      yChildren.toArray().forEach(function (yBlock) {
        children.push(_dehydrateBlock(yBlock));
      });
    }
    return {
      id: ySec.get('id'),
      label: ySec.get('label') || '',
      order: ySec.get('order') || 0,
      children: children,
    };
  }

  function _dehydrateTree(yDoc) {
    var yTree = yDoc.getMap('tree');
    var meta = {};
    var yMeta = yTree.get('meta');
    if (yMeta && typeof yMeta.forEach === 'function') {
      yMeta.forEach(function (v, k) {
        meta[k] = (v && typeof v.toString === 'function') ? v.toString() : v;
      });
    }
    var sections = [];
    var ySections = yTree.get('sections');
    if (ySections && typeof ySections.toArray === 'function') {
      ySections.toArray().forEach(function (ySec) { sections.push(_dehydrateSection(ySec)); });
    }
    sections.sort(function (a, b) { return (a.order || 0) - (b.order || 0); });
    return { meta: meta, sections: sections };
  }

  async function _loadProtocolTree(protocolId) {
    var Y = await _ensureYjs();
    var db = firebridge.db();
    var protocolRef = db.collection('protocols').doc(protocolId);

    var snapDoc = null;
    try {
      var s = await protocolRef.collection('yjs_snapshot').doc('state').get();
      if (s.exists) snapDoc = s.data();
    } catch (err) {
      console.warn('[lab-notebook] protocol snapshot read failed:', err && err.message);
    }

    var yDoc = new Y.Doc();
    var baseSeq = '';
    if (snapDoc && snapDoc.stateBase64) {
      Y.applyUpdate(yDoc, _b64ToBytes(snapDoc.stateBase64), 'remote');
      baseSeq = snapDoc.seq || '';
    }

    var query = baseSeq
      ? protocolRef.collection('yjs_updates').where('seq', '>', baseSeq).orderBy('seq')
      : protocolRef.collection('yjs_updates').orderBy('seq');
    var updates;
    try {
      updates = await query.get();
    } catch (err) {
      throw new Error('Could not read protocol updates: ' + (err && err.message || err));
    }
    updates.docs.forEach(function (d) {
      var data = d.data();
      if (data && data.bytes) {
        try { Y.applyUpdate(yDoc, _b64ToBytes(data.bytes), 'remote'); }
        catch (err) { console.warn('[lab-notebook] failed to apply update', d.id, err.message); }
      }
    });

    return _dehydrateTree(yDoc);
  }

  /* V3.506 — the static `_renderProtocolBlockHtml` / `_renderProtocolTreeHtml`
   * "bunch of text" renderers were removed. The picker's "full" action now
   * mounts the protocol LIVE as its real output document via the shared
   * ProtocolDocRender path (see insertFullProtocol → loadProtocolIntoRun →
   * mountProtocolRunWidgets → _renderProtocolDocInto). */

  function _collectMaterialItemRefs(tree) {
    var ids = [];
    var seen = {};
    (tree.sections || []).forEach(function (sec) {
      (sec.children || []).forEach(function (block) {
        if (block.kind !== 'materials') return;
        ((block.attrs && block.attrs.rows) || []).forEach(function (row) {
          if (row && row.item_ref && !seen[row.item_ref]) {
            seen[row.item_ref] = true;
            ids.push(row.item_ref);
          }
        });
      });
    });
    return ids;
  }

  /* Toolbar / picker entry point. Loads the protocol's Yjs state and
   * mounts it LIVE in-situ in the run panel (loadProtocolIntoRun) — no
   * link/chip goes into the body. Then for every materials-block row with
   * an item_ref, looks up the inventory record and inserts an inventory
   * chip so the lab notebook's Materials Used panel auto-populates. Items
   * not present in inventoryState.list are skipped silently (e.g.
   * materials referenced by id but with no matching inventory doc).
   * Reagents/equipment listed only by free-text name are shown in the
   * live document but can't become structured chips. */
  async function insertFullProtocol(protocolEntry) {
    if (!state.doc) return;

    // V3.506 — "full" no longer dumps static text into the body, and (per
    // user correction) does NOT drop a link/chip into the body either. The
    // protocol is mounted LIVE, in-situ, directly on the notebook page (the
    // run panel right under the body) as its real output document — the
    // same ProtocolDocRender the ?view=doc page uses. That live instance IS
    // the record; there's nothing to link to. Protocols-followed reflects
    // it automatically (collectProtocolRefs reads state.doc.protocol_run,
    // no body chip required — see loadProtocolIntoRun).
    setSavingHint('loading protocol…');
    var tree;
    try {
      await _ensureProtocolRunDeps();
      tree = await _runGetTree(protocolEntry.id);
    } catch (err) {
      setSavingHint('protocol load failed');
      alert('Could not load protocol: ' + (err && err.message || err) +
        '\n\nThe protocol may not have any saved Yjs state yet (newly created and never edited / never compacted). Insert the reference chip instead with "ref only".');
      return;
    }

    var title = protocolEntry.title || tree.meta.title || protocolEntry.id;
    await loadProtocolIntoRun(protocolEntry.id, title);
    // User may have declined the "replace loaded protocol?" confirm.
    if (!state.doc.protocol_run || state.doc.protocol_run.protocol_id !== protocolEntry.id) {
      setSavingHint('');
      return;
    }

    // Append an inventory chip for every materials row carrying an item_ref.
    var itemIds = _collectMaterialItemRefs(tree);
    var inserted = 0;
    if (itemIds.length) {
      try {
        await ensureInventoryList();
      } catch (_) {}
      for (var i = 0; i < itemIds.length; i++) {
        var inv = (inventoryState.list || []).find(function (e) { return e.id === itemIds[i]; });
        if (inv) {
          insertInventoryChip(inv);
          inserted++;
        }
      }
    }

    refreshBodyEmptyState();
    renderMaterialsPanel();
    renderProtocolsPanel();
    scheduleSave();
    upsertIndexRow(state.doc);
    renderRail();

    // Bring the freshly-mounted document into view.
    var host = document.getElementById('ln-protocol-run');
    if (host && host.scrollIntoView) {
      try { host.scrollIntoView({ behavior: 'smooth', block: 'nearest' }); } catch (e) {}
    }
    setSavingHint('loaded "' + title + '" as a live document · ' + inserted + ' material chip' +
      (inserted === 1 ? '' : 's'));
  }

  /* ─────────────────────────────────────────────────────────────
   * Protocol Calculator (V3.135)
   * ─────────────────────────────────────────────────────────────
   * Treat a protocol as a calculator: the protocol's variable scope
   * (formula.variables[] and formula.output across every formula
   * block) defines the inputs + outputs; the user fills in the
   * inputs; mathjs evaluates the chained expressions; the result is
   * inserted into the entry body in one of three formats (steps with
   * substituted values / snippet / table).
   *
   * The architectural constraint per the user: the lab notebook only
   * READS the protocol's existing scaffold. Loading the protocol's
   * Yjs tree (V3.134's _loadProtocolTree) gives us the dehydrated
   * structure; lazy-loading protocol-formulas.js gives us the same
   * mathjs evaluator the protocols editor uses. No protocol-side
   * schema change.
   *
   * Inserts persist as state.doc.calc_runs[] entries keyed by a
   * `calc-XXX` id. The inserted block carries that id as
   * data-calc-id; clicking the block re-opens the modal pre-filled.
   */

  var _protocolFormulasPromise = null;
  function _ensureProtocolFormulas() {
    if (window.ProtocolFormulas) return Promise.resolve(window.ProtocolFormulas);
    if (_protocolFormulasPromise) return _protocolFormulasPromise;
    _protocolFormulasPromise = new Promise(function (resolve, reject) {
      var s = document.createElement('script');
      s.src = '/rm/js/protocol-formulas.js';
      s.onload = function () {
        if (window.ProtocolFormulas) resolve(window.ProtocolFormulas);
        else reject(new Error('protocol-formulas.js loaded but window.ProtocolFormulas missing'));
      };
      s.onerror = function () { reject(new Error('Failed to load /rm/js/protocol-formulas.js')); };
      document.head.appendChild(s);
    });
    return _protocolFormulasPromise;
  }

  /* ══════════════════════════════════════════════════════════════
   * FuturePlan 06 — live protocol RUN panel.
   *
   * A protocol definition, loaded into this entry, comes alive: its
   * inputs render as live controls, computed item lists recompute, the
   * user assigns items into grids, and prep totals aggregate from the
   * assignment. All state lives on state.doc.protocol_run (persisted via
   * the normal debounced save); the definition is never mutated. On
   * `⏹ End run` the state freezes into an immutable snapshot.
   *
   * Reuses the shared compute kernel (ProtocolFormulas) + widget module
   * (ProtocolWidgets), lazy-loaded on demand. The panel is rendered
   * OUTSIDE the sanitized body, so live widgets survive.
   * ══════════════════════════════════════════════════════════════ */

  var _runDepsPromise = null;
  function _loadScriptOnce(src, globalName) {
    if (window[globalName]) return Promise.resolve(window[globalName]);
    return new Promise(function (res, rej) {
      var s = document.createElement('script');
      s.src = src;
      s.onload = function () { window[globalName] ? res(window[globalName]) : rej(new Error(src + ' loaded but ' + globalName + ' missing')); };
      s.onerror = function () { rej(new Error('Failed to load ' + src)); };
      document.head.appendChild(s);
    });
  }
  function _ensureProtocolDocCss(id, href) {
    if (document.getElementById(id)) return;
    var l = document.createElement('link');
    l.rel = 'stylesheet'; l.id = id; l.href = href;
    document.head.appendChild(l);
  }
  function _ensureProtocolRunDeps() {
    if (_runDepsPromise) return _runDepsPromise;
    _runDepsPromise = _ensureProtocolFormulas().then(function () {
      // protocol-doc.css first (the .prd-doc base), then protocol-cheat.css
      // (its .prc-doc rules must win — loaded after) so both the document
      // and cheat-sheet views style correctly inside the run panel.
      _ensureProtocolDocCss('ln-protocol-doc-css', '/rm/css/protocol-doc.css');
      _ensureProtocolDocCss('ln-protocol-cheat-css', '/rm/css/protocol-cheat.css');
      return _loadScriptOnce('/rm/js/protocol-graph.js', 'ProtocolGraph');
    }).then(function () {
      return _loadScriptOnce('/rm/js/protocol-widgets.js', 'ProtocolWidgets');
    }).then(function () {
      // V3.506 — the shared read-only block renderer (single source of
      // truth with the output-document view) so the notebook run mounts
      // the protocol as its real document. protocol-inventory lets the
      // materials table resolve inventory labels (optional; renderers
      // guard on window.PROTOCOL_INVENTORY).
      return _loadScriptOnce('/rm/js/protocol-doc-render.js', 'ProtocolDocRender');
    }).then(function () {
      // V3.506 — shared cheat-sheet renderers (same module the ?view=cheat
      // page uses) so the notebook's 📋 Cheat sheet view matches it exactly.
      return _loadScriptOnce('/rm/js/protocol-cheat-render.js', 'ProtocolCheatRender');
    }).then(function () {
      return _loadScriptOnce('/rm/js/protocol-inventory.js', 'PROTOCOL_INVENTORY')
        .then(function (inv) {
          if (inv && inv.ensureList) { try { inv.ensureList(); } catch (e) {} }
        })
        .catch(function () { /* inventory labels are best-effort */ });
    });
    return _runDepsPromise;
  }

  function _runKeyOf(keyFields) {
    return function (row) {
      var k = {};
      (keyFields || []).forEach(function (f) { k[f] = row[f]; });
      return JSON.stringify(k, Object.keys(k).sort());
    };
  }

  /* Discover the item-list datasets a definition produces, with the
   * dim fields that key each. Scans builder blocks + compiles design
   * blocks. The first is the primary (drives assignment + totals). */
  function _runDatasetsFromTree(tree) {
    var out = [];
    ((tree && tree.sections) || []).forEach(function (sec) {
      (sec.children || []).forEach(function (b) {
        if (!b) return;
        if (b.kind === 'builder') {
          var dims = Array.isArray(b.attrs && b.attrs.dims) ? b.attrs.dims : [];
          out.push({ name: (b.attrs && b.attrs.dataset) || 'items', keyFields: dims.map(function (d) { return d.field; }) });
        } else if (b.kind === 'design' && window.ProtocolGraph) {
          try {
            var res = window.ProtocolGraph.compile(b.attrs || {});
            (res.datasets || []).forEach(function (d) {
              out.push({ name: d.name, keyFields: (d.spec.dims || []).map(function (x) { return x.field; }) });
            });
          } catch (e) {}
        }
      });
    });
    return out;
  }

  function _runGetTree(id) {
    if (state._runTreeCache && state._runTreeCache.id === id) {
      return Promise.resolve(state._runTreeCache.tree);
    }
    return _loadProtocolTree(id).then(function (tree) {
      state._runTreeCache = { id: id, tree: tree };
      return tree;
    });
  }

  function renderRunLoadAffordance() {
    var refs = (state.doc && state.doc.protocol_refs) || [];
    if (!refs.length) {
      return '<h4>Protocol run</h4>' +
        '<div class="ln-material-empty">Reference a protocol above (📋 Protocol), then load it here to run it live — inputs, computed item lists, grid assignment, and prep totals.</div>';
    }
    var btns = refs.map(function (r) {
      return '<button type="button" class="ln-run-load-btn" data-run-load="' + escapeHtml(r.id) +
        '" data-run-title="' + escapeHtml(r.title || r.id) + '">▶ Run “' + escapeHtml(r.title || r.id) + '”</button>';
    }).join('');
    return '<h4>Protocol run</h4>' +
      '<div>Load a referenced protocol to run it live in this entry:</div>' +
      '<div style="margin-top:8px">' + btns + '</div>';
  }

  function wireRunLoadButtons(host) {
    Array.prototype.forEach.call(host.querySelectorAll('[data-run-load]'), function (btn) {
      btn.addEventListener('click', function () {
        loadProtocolIntoRun(btn.getAttribute('data-run-load'), btn.getAttribute('data-run-title'));
      });
    });
  }

  async function loadProtocolIntoRun(id, title) {
    // V3.506 — if a different protocol is already loaded, confirm before
    // replacing it (one run slot per entry). Same protocol → no-op remount.
    var existing = state.doc && state.doc.protocol_run;
    if (existing && existing.protocol_id && existing.protocol_id !== id) {
      if (!confirm('This entry already has "' + (existing.protocol_title || existing.protocol_id) +
          '" loaded. Replace it with "' + (title || id) + '"? (its run state will be discarded)')) {
        return;
      }
    }
    try {
      await _ensureProtocolRunDeps();
      state.doc.protocol_run = {
        protocol_id: id, protocol_title: title || id, protocol_version: null,
        loaded_at: isoNow(), view: 'doc', inputs: {}, graph_state: {}, grids: [],
        assignment: {}, factor: 1, computed: null,
        frozen: false, frozen_at: null, snapshot: null,
      };
      // The live in-situ instance itself is what "Protocols followed" now
      // tracks — no body chip needed (see collectProtocolRefs).
      collectProtocolRefs(); renderProtocolsPanel();
      scheduleSave(); upsertIndexRow(state.doc); renderRail();
      await mountProtocolRunPanel();
    } catch (err) {
      alert('Could not load protocol into run: ' + (err && err.message || err));
    }
  }

  async function mountProtocolRunPanel() {
    var host = document.getElementById('ln-protocol-run');
    if (!host || !state.doc) return;
    // tear down any previous run context's event listener
    if (state._runUnlisten) { try { state._runUnlisten(); } catch (e) {} state._runUnlisten = null; }
    state._runCtx = null; state._runPrimaryDataset = null;

    var run = state.doc.protocol_run;
    if (!run) { host.innerHTML = renderRunLoadAffordance(); wireRunLoadButtons(host); return; }

    host.innerHTML = '<h4>Protocol run · ' + escapeHtml(run.protocol_title || run.protocol_id) +
      (run.frozen ? '<span class="ln-run-frozen-badge">🔒 frozen record</span>' : '') +
      '</h4><div class="ln-material-empty">Loading…</div>';
    try {
      await _ensureProtocolRunDeps();
      if (run.frozen) { await renderFrozenRun(host, run); return; }
      var tree = await _runGetTree(run.protocol_id);
      var math = await window.ProtocolFormulas.ensureMathjs();
      mountProtocolRunWidgets(host, tree, run, math);
    } catch (err) {
      host.innerHTML = '<h4>Protocol run</h4><div class="ln-material-empty">Could not load: ' +
        escapeHtml((err && err.message) || String(err)) + '</div>';
    }
  }

  /* V3.506 — the notebook's bespoke `_runMountDesign` was removed; design
   * blocks now render through window.ProtocolDocRender.renderBlock (its
   * renderDesign, with a recompute-fingerprint guard), the same path the
   * output-document view uses. */

  /* ── V3.506 — render the loaded protocol as its real output document ──
   * Shared by the live mount and the frozen (finalized) render. Uses the
   * SAME window.ProtocolDocRender the ?view=doc page uses, so a notebook
   * run looks and behaves like the published protocol document — masthead,
   * numbered stage headers, callout cards, materials tables, figures, and
   * (in a live ctx) working calculators / builders / plate maps.
   *
   * The Cheat-sheet view (run.view === 'cheat') collapses each `step` to
   * its one-line V3.503 `attrs.cheat` summary (falling back to the step
   * body's first line); every other block kind still renders in full so
   * the calculators + materials stay usable on the condensed sheet. */

  function _protocolHasCheat(tree) {
    return ((tree && tree.sections) || []).some(function (sec) {
      return (sec.children || []).some(function (b) {
        return b && b.kind === 'step' && ((b.attrs && b.attrs.cheat) || '').trim();
      });
    });
  }

  // V3.515 — the cheat view is now meaningful for ANY protocol with steps
  // (auto first-line fallback + user selection), not just ones with authored
  // cheat lines — so the Document/Cheat toggle is gated on this instead.
  function _protocolHasSteps(tree) {
    return ((tree && tree.sections) || []).some(function (sec) {
      return (sec.children || []).some(function (b) { return b && b.kind === 'step'; });
    });
  }

  // V3.515 — cheat-sheet selection (per user+protocol), loaded lazily on first
  // cheat render. NOT persisted on the run doc (it's per-protocol, not per-run);
  // see protocol-cheat-render.js loadPrefs/savePrefs.
  var _cheatState = { protocolId: null, prefs: null, customizing: false };

  function _renderProtocolMasthead(tree, run) {
    var el = document.createElement('header');
    el.className = 'prd-masthead ln-run-masthead';
    var brand = document.createElement('div');
    brand.className = 'prd-brand';
    var bn = document.createElement('span');
    bn.className = 'prd-brand-name';
    bn.textContent = 'McGhee Lab';
    brand.appendChild(bn);
    var tag = document.createElement('span');
    tag.className = 'prd-brand-tag';
    tag.textContent = run.view === 'cheat' ? 'PROTOCOL · CHEAT SHEET' : 'PROTOCOL';
    brand.appendChild(tag);
    el.appendChild(brand);
    var h1 = document.createElement('h1');
    h1.className = 'prd-title';
    h1.textContent = (tree.meta && tree.meta.title) || run.protocol_title || run.protocol_id;
    el.appendChild(h1);
    var row = document.createElement('div');
    row.className = 'prd-chips';
    function chip(txt) {
      var c = document.createElement('span');
      c.className = 'prd-chip prd-chip-meta';
      c.textContent = txt;
      row.appendChild(c);
    }
    if (run.frozen && run.frozen_at) chip('🔒 finalized ' + String(run.frozen_at).slice(0, 10));
    else chip('live — values editable');
    if (run.loaded_at) chip('loaded ' + String(run.loaded_at).slice(0, 10));
    el.appendChild(row);
    return el;
  }

  function _renderProtocolDocInto(card, tree, ctx, run) {
    // Cheat-sheet view — delegate to the shared ProtocolCheatRender module
    // (the SAME renderer the ?view=cheat page uses). The card carries the
    // dual `prd-doc prc-doc` class so protocol-cheat.css wins, exactly like
    // the cheat page's <article>.
    if (run.view === 'cheat' && window.ProtocolCheatRender) {
      var PCR = window.ProtocolCheatRender;
      card.classList.add('prc-doc');
      // Compact header, matching the ?view=cheat page's .prc-header (the
      // dark masthead is dropped on the cheat sheet).
      var head = document.createElement('header');
      head.className = 'prc-header';
      var h1 = document.createElement('h1');
      h1.className = 'prc-title';
      h1.textContent = (tree.meta && tree.meta.title) || run.protocol_title || run.protocol_id;
      head.appendChild(h1);
      var meta = document.createElement('div');
      meta.className = 'prc-meta';
      meta.textContent = (run.frozen && run.frozen_at
        ? '🔒 finalized ' + String(run.frozen_at).slice(0, 10)
        : 'live · values editable') + ' · cheat sheet';
      head.appendChild(meta);
      card.appendChild(head);

      // V3.515 — contents are user-selected at point of use, persisted per
      // (user, protocol). Load once into _cheatState (async); re-render when
      // ready. The selection lives in its own doc, never on the run.
      if (_cheatState.protocolId !== run.protocol_id) {
        _cheatState = { protocolId: run.protocol_id, prefs: null, customizing: false };
        PCR.loadPrefs(run.protocol_id).then(function (p) {
          if (_cheatState.protocolId !== run.protocol_id) return;   // stale
          _cheatState.prefs = p;
          mountProtocolRunPanel();
        });
      }
      if (!_cheatState.prefs) {
        var loading = document.createElement('div');
        loading.className = 'prc-configbar-loading';
        loading.textContent = 'Loading cheat-sheet options…';
        card.appendChild(loading);
        return;
      }
      var prefs = _cheatState.prefs;
      var pid = run.protocol_id;
      var handlers = {
        customizing: _cheatState.customizing,
        onToggleCategory: function (c, next) {
          prefs.categories[c] = next; PCR.savePrefs(pid, prefs); mountProtocolRunPanel();
        },
        onToggleBlock: function (id, stateVal) {
          prefs.overrides[id] = stateVal; PCR.savePrefs(pid, prefs); mountProtocolRunPanel();
        },
        onToggleCustomize: function (next) { _cheatState.customizing = next; mountProtocolRunPanel(); },
        onReset: function () {
          var d = PCR.defaultPrefs();
          prefs.categories = d.categories; prefs.overrides = d.overrides;
          PCR.savePrefs(pid, prefs); mountProtocolRunPanel();
        },
      };
      card.appendChild(PCR.buildConfigBar(prefs, handlers));
      if (_cheatState.customizing) PCR.renderChecklistInto(card, tree, prefs, handlers);
      else PCR.renderSectionsInto(card, tree, ctx, { prefs: prefs });
      return;
    }
    card.classList.remove('prc-doc');

    // Document view — masthead + every block through ProtocolDocRender.
    card.appendChild(_renderProtocolMasthead(tree, run));
    var stepCounter = 0;
    ((tree && tree.sections) || []).forEach(function (sec, i) {
      var secEl = document.createElement('section');
      secEl.className = 'prd-section';
      var code = String(i + 1);
      if (code.length < 2) code = '0' + code;
      var stage = document.createElement('div');
      stage.className = 'prd-stage';
      var h = document.createElement('h2');
      h.className = 'prd-stage-title';
      h.innerHTML = '<span class="prd-stage-code">' + code + '</span>' +
        escapeHtml(sec.label || 'Untitled section');
      stage.appendChild(h);
      secEl.appendChild(stage);

      (sec.children || []).forEach(function (b) {
        if (!b || b.kind === 'docHeader') return;
        if (b.kind === 'step') stepCounter++;
        var el = window.ProtocolDocRender.renderBlock(b, ctx, { stepNumber: stepCounter });
        if (el) secEl.appendChild(el);
      });
      card.appendChild(secEl);
    });
  }

  /* Toolbar shared by the live + frozen renders: view toggle (only when
   * the protocol carries cheat lines), Finalize / Reopen, and Unload. */
  function _buildRunToolbar(run, hasCheat) {
    var bar = document.createElement('div');
    bar.className = 'ln-run-toolbar';
    var title = document.createElement('div');
    title.className = 'ln-run-toolbar-title';
    title.textContent = '📋 ' + (run.protocol_title || run.protocol_id) +
      (run.frozen ? ' · finalized' : ' · live');
    bar.appendChild(title);
    var actions = document.createElement('div');
    actions.className = 'ln-run-toolbar-actions';

    if (hasCheat) {
      var toggle = document.createElement('div');
      toggle.className = 'ln-run-view-toggle';
      [['doc', '📄 Document'], ['cheat', '📋 Cheat sheet']].forEach(function (p) {
        var b = document.createElement('button');
        b.type = 'button';
        b.className = 'ln-run-view-btn' + ((run.view || 'doc') === p[0] ? ' active' : '');
        b.textContent = p[1];
        b.addEventListener('click', function () {
          if ((run.view || 'doc') === p[0]) return;
          run.view = p[0];
          scheduleSave();
          mountProtocolRunPanel();
        });
        toggle.appendChild(b);
      });
      actions.appendChild(toggle);
    }

    if (!run.frozen) {
      var fin = document.createElement('button');
      fin.type = 'button';
      fin.className = 'ln-run-finalize-btn';
      fin.textContent = '✅ Finalize';
      fin.title = 'Lock the input values you used into this entry as an immutable record';
      fin.addEventListener('click', function () {
        if (!confirm('Finalize this protocol? The values you used will be locked into this entry ' +
            'as an immutable record. You can Reopen later if you need to change them.')) return;
        freezeProtocolRun();
        scheduleSave(); upsertIndexRow(state.doc); renderRail();
        mountProtocolRunPanel();
        setSavingHint('🔒 protocol finalized');
      });
      actions.appendChild(fin);
    } else {
      var reopen = document.createElement('button');
      reopen.type = 'button';
      reopen.className = 'ln-run-reopen-btn';
      reopen.textContent = '✎ Reopen';
      reopen.title = 'Unlock this protocol to edit the values again';
      reopen.addEventListener('click', function () {
        if (!confirm('Reopen this finalized protocol for editing? It becomes live again — the ' +
            'locked values are preserved as the starting point.')) return;
        run.frozen = false; run.frozen_at = null;
        scheduleSave(); upsertIndexRow(state.doc); renderRail();
        mountProtocolRunPanel();
      });
      actions.appendChild(reopen);
    }

    var unload = document.createElement('button');
    unload.type = 'button';
    unload.className = 'ln-run-load-btn ln-run-unload-btn';
    unload.textContent = '✕ Unload';
    unload.title = 'Remove this protocol and its run state from the entry';
    unload.addEventListener('click', function () {
      if (!confirm('Remove the loaded protocol and its run state from this entry?')) return;
      state.doc.protocol_run = null;
      collectProtocolRefs(); renderProtocolsPanel();
      scheduleSave(); upsertIndexRow(state.doc); renderRail();
      mountProtocolRunPanel();
    });
    actions.appendChild(unload);

    bar.appendChild(actions);
    return bar;
  }

  function mountProtocolRunWidgets(host, tree, run, math) {
    var PF = window.ProtocolFormulas, PW = window.ProtocolWidgets;
    host.innerHTML = '';
    if (!run.view) run.view = 'doc';
    host.appendChild(_buildRunToolbar(run, _protocolHasSteps(tree)));

    var formulas = PF.collectFormulasFromPlainTree(tree);
    var ctx = PW.createContext({
      container: host, math: math, formulas: formulas,
      overrides: run.inputs, builderState: run.graph_state,
      onChange: function () { _syncRunComputed(); scheduleSave(); },
    });
    ctx.table = math ? PF.buildSymbolTable(formulas, math, run.inputs) : {};
    state._runCtx = ctx;

    // The protocol as its real output document — every block, live widgets
    // inline (single source of truth with ProtocolDocRender).
    var card = document.createElement('div');
    card.className = 'prd-doc ln-run-doc';
    host.appendChild(card);
    _renderProtocolDocInto(card, tree, ctx, run);

    // Run-only prep aids: assign computed items → grids → totals. Only when
    // a primary dataset exists AND there's no in-document plate planner
    // (assign-enabled layoutMap) — that block IS the assignment surface and
    // was rendered inline above.
    var datasets = _runDatasetsFromTree(tree);
    var primary = datasets.length ? datasets[0] : null;
    state._runPrimaryDataset = primary;
    state._runPlanner = primary ? _runPlannerBlock(tree, primary.name) : null;

    if (primary && !state._runPlanner) {
      var prep = document.createElement('div');
      prep.className = 'ln-run-prep';
      var prepHead = document.createElement('div');
      prepHead.className = 'ln-run-section-label ln-run-prep-head';
      prepHead.textContent = '🧮 Run: assign items & prep totals';
      prep.appendChild(prepHead);

      // factor multiplier
      var factorWrap = document.createElement('label');
      factorWrap.className = 'ln-run-factor';
      factorWrap.innerHTML = '<span>Prep excess / multiplier ×</span>';
      var fInp = document.createElement('input');
      fInp.type = 'number'; fInp.step = '0.05'; fInp.min = '0';
      fInp.value = String(run.factor || 1);
      fInp.addEventListener('input', function () {
        var n = parseFloat(fInp.value);
        run.factor = (isFinite(n) && n > 0) ? n : 1;
        PW.recompute(ctx); _syncRunComputed(); scheduleSave();
      });
      factorWrap.appendChild(fInp);
      prep.appendChild(factorWrap);

      var asnLabel = document.createElement('div');
      asnLabel.className = 'ln-run-section-label';
      asnLabel.textContent = 'Assign items to grids';
      prep.appendChild(asnLabel);
      prep.appendChild(PW.renderGridAssignment(ctx, {
        datasetName: primary.name,
        grids: run.grids,
        assignment: run.assignment,
        keyFields: primary.keyFields,
        colorField: primary.keyFields[0] || '',
        defaultRows: 4, defaultCols: 6,
        onAssignChange: function () { PW.recompute(ctx); _syncRunComputed(); scheduleSave(); },
      }));

      var totLabel = document.createElement('div');
      totLabel.className = 'ln-run-section-label';
      totLabel.textContent = 'Totals to prepare';
      prep.appendChild(totLabel);
      prep.appendChild(PW.renderPrepTotals(ctx, {
        datasetName: primary.name,
        grids: run.grids,
        assignment: run.assignment,
        keyFields: primary.keyFields,
        poolBy: primary.keyFields,
        factor: run.factor,
      }));
      host.appendChild(prep);
    }

    state._runUnlisten = PW.mountRefresherBus(ctx);
    PW.recompute(ctx);        // populate + register datasets, run all refreshers
    _syncRunComputed();
  }

  /* Cache the live computed items + totals onto protocol_run (non-
   * authoritative; feeds the rail index + the freeze snapshot). */
  function _syncRunComputed() {
    var run = state.doc && state.doc.protocol_run;
    if (!run || !window.ProtocolFormulas) return;
    var ds = state._runPrimaryDataset;
    var items = ds ? (window.ProtocolFormulas.getDataset(ds.name) || []) : [];
    run.computed = { items: items.slice(), totals: _computeRunTotals(run, ds, items) };
    upsertIndexRow(state.doc);
  }
  /* Find an assign-enabled layoutMap ("Plate planner") whose dataset is
   * the primary one, so run totals + freeze read ITS state (persisted in
   * run.graph_state[blockId]) rather than the legacy run.grids. */
  function _runPlannerBlock(tree, primaryName) {
    var found = null;
    ((tree && tree.sections) || []).forEach(function (sec) {
      (sec.children || []).forEach(function (b) {
        if (found || !b || b.kind !== 'layoutMap') return;
        var a = b.attrs || {};
        if (a.assign && a.dataset === primaryName) found = { blockId: b.id, attrs: a };
      });
    });
    return found;
  }

  function _computeRunTotals(run, ds, items) {
    if (!ds || !window.ProtocolWidgets || !window.ProtocolFormulas) return null;
    var pl = state._runPlanner;
    var grids, assignment, keyFields, poolBy, quantityFields, factor;
    if (pl) {
      var gs = (run.graph_state && run.graph_state[pl.blockId]) || {};
      grids = gs.grids || []; assignment = gs.assignment || {};
      keyFields = pl.attrs.keyFields || ds.keyFields;
      poolBy = pl.attrs.poolBy || ds.keyFields;
      quantityFields = pl.attrs.quantityFields;
      var fv = pl.attrs.factorVar;
      var sym = fv && state._runCtx && state._runCtx.table && state._runCtx.table[fv];
      factor = (sym && !sym.error && typeof sym.value === 'number') ? sym.value : (run.factor || 1);
      run.factor = factor;   // keep the frozen snapshot's factor label honest
    } else {
      grids = run.grids; assignment = run.assignment;
      keyFields = ds.keyFields; poolBy = ds.keyFields; quantityFields = undefined; factor = run.factor;
    }
    var counts = window.ProtocolWidgets.slotCounts(grids, assignment);
    var keyOf = _runKeyOf(keyFields);
    return window.ProtocolFormulas.aggregatePrep(items, {
      countOf: function (row) { return counts[keyOf(row)] || 0; },
      poolBy: poolBy,
      quantityFields: quantityFields,
      factor: factor,
    });
  }

  function freezeProtocolRun() {
    var run = state.doc && state.doc.protocol_run;
    if (!run || run.frozen) return;
    _syncRunComputed();
    try {
      run.snapshot = JSON.parse(JSON.stringify({
        inputs: run.inputs, graph_state: run.graph_state, grids: run.grids,
        assignment: run.assignment, factor: run.factor, computed: run.computed,
        protocol_id: run.protocol_id, protocol_title: run.protocol_title,
      }));
    } catch (e) { run.snapshot = null; }
    run.frozen = true;
    run.frozen_at = isoNow();
    if (state._runUnlisten) { try { state._runUnlisten(); } catch (e) {} state._runUnlisten = null; }
  }

  /* V3.506 — render a finalized (frozen) run as its locked output document:
   * the same ProtocolDocRender path, but a READ-ONLY ctx whose overrides are
   * the snapshot's inputs, so the document reads with the values-used baked
   * in and every widget disabled. The explicit recorded-values tables
   * (inputs / item list / totals) follow, in a collapsed <details>, as the
   * immutable numeric record. Falls back to just the record tables if the
   * tree can no longer be loaded. Async — awaited by mountProtocolRunPanel. */
  async function renderFrozenRun(host, run) {
    var PF = window.ProtocolFormulas, PW = window.ProtocolWidgets;
    var snap = run.snapshot || {};
    host.innerHTML = '';
    host.appendChild(_buildRunToolbar(run, false));

    try {
      var tree = await _runGetTree(run.protocol_id);
      var formulas = PF.collectFormulasFromPlainTree(tree);
      var needsMath = formulas.length > 0 || ((tree && tree.sections) || []).some(function (sec) {
        return (sec.children || []).some(function (b) {
          return b && (b.kind === 'builder' || b.kind === 'layoutMap' || b.kind === 'design');
        });
      });
      var math = null;
      if (needsMath) { try { math = await PF.ensureMathjs(); } catch (e) {} }

      // Re-add the view toggle now that the tree is loaded (the fall-through
      // toolbar above was built without it). V3.515 — gated on having steps,
      // so the cheat view is offered even without authored cheat lines.
      if (_protocolHasSteps(tree)) {
        host.innerHTML = '';
        host.appendChild(_buildRunToolbar(run, true));
      }

      var ctx = PW.createContext({
        container: host, math: math, formulas: formulas,
        overrides: snap.inputs || run.inputs || {},
        builderState: snap.graph_state || run.graph_state || {},
        readOnly: true,
      });
      ctx.table = math ? PF.buildSymbolTable(formulas, math, ctx.overrides) : {};
      state._runCtx = ctx;

      var card = document.createElement('div');
      card.className = 'prd-doc ln-run-doc ln-run-doc-frozen';
      host.appendChild(card);
      _renderProtocolDocInto(card, tree, ctx, run);
      PW.recompute(ctx);   // populate datasets/lists once (no live bus)
    } catch (err) {
      var note = document.createElement('div');
      note.className = 'ln-material-empty';
      note.textContent = 'Finalized record (the protocol document could not be re-rendered: ' +
        ((err && err.message) || String(err)) + ').';
      host.appendChild(note);
    }

    host.appendChild(_renderFrozenRecordTables(run));
  }

  /* The immutable numeric record — inputs used, computed item list, prep
   * totals — from the freeze snapshot, wrapped in a collapsed <details>. */
  function _renderFrozenRecordTables(run) {
    var snap = run.snapshot || {};
    var wrap = document.createElement('details');
    wrap.className = 'ln-run-record';
    var sum = document.createElement('summary');
    sum.textContent = '🔒 Recorded values (finalized ' + String(run.frozen_at || '').slice(0, 10) + ')';
    wrap.appendChild(sum);
    var box = document.createElement('div');
    box.className = 'ln-run-record-body';
    var html = '';

    // inputs
    var inputs = snap.inputs || {};
    var inKeys = Object.keys(inputs);
    if (inKeys.length) {
      html += '<div class="ln-run-section-label">Inputs used</div><table class="prd-table"><tbody>';
      inKeys.forEach(function (k) {
        html += '<tr><td>' + escapeHtml(k) + '</td><td class="prd-mono">' + escapeHtml(String(inputs[k])) + '</td></tr>';
      });
      html += '</tbody></table>';
    }

    // item list
    var items = (snap.computed && snap.computed.items) || [];
    if (items.length) {
      var cols = Object.keys(items[0]).filter(function (k) { return k.indexOf('_value') < 0; });
      html += '<div class="ln-run-section-label">Item list</div><table class="prd-table"><thead><tr><th>#</th>' +
        cols.map(function (c) { return '<th>' + escapeHtml(c.replace(/_label$/, '')) + '</th>'; }).join('') + '</tr></thead><tbody>';
      items.forEach(function (row, i) {
        html += '<tr><td class="prd-mono">' + (i + 1) + '</td>' +
          cols.map(function (c) {
            var v = row[c];
            return '<td>' + escapeHtml(v === null || v === undefined ? '' : String(v)) + '</td>';
          }).join('') + '</tr>';
      });
      html += '</tbody></table>';
    }

    // totals
    var totals = snap.computed && snap.computed.totals;
    if (totals && totals.quantityFields && totals.quantityFields.length) {
      html += '<div class="ln-run-section-label">Totals prepared (× ' + escapeHtml(String(snap.factor || 1)) + ')</div>' +
        '<table class="prd-table"><thead><tr><th>Pool</th>' +
        totals.quantityFields.map(function (q) { return '<th>' + escapeHtml(q) + '</th>'; }).join('') + '</tr></thead><tbody>';
      (totals.pools || []).forEach(function (p) {
        html += '<tr><td>' + escapeHtml(p.label) + '</td>' +
          totals.quantityFields.map(function (q) { return '<td class="prd-mono">' + escapeHtml(String(Math.round((p.totals[q] || 0) * 1000) / 1000)) + '</td>'; }).join('') + '</tr>';
      });
      html += '</tbody></table>';
    }

    box.innerHTML = html || '<div class="ln-material-empty">No numeric values were captured for this run.</div>';
    wrap.appendChild(box);
    return wrap;
  }

  /* Walk the V3.134-dehydrated plain protocol tree and return formula
   * entries in the same shape protocol-formulas.js's collectFormulas
   * returns from a yTree, so buildSymbolTable accepts them. */
  function _collectFormulasFromPlainTree(plainTree) {
    var formulas = [];
    if (!plainTree || !Array.isArray(plainTree.sections)) return formulas;
    plainTree.sections.forEach(function (sec) {
      (sec.children || []).forEach(function (block) {
        if (!block || block.kind !== 'formula') return;
        var attrs = block.attrs || {};
        formulas.push({
          blockId: block.id || '',
          label: attrs.label || '',
          description: attrs.description || '',
          expression: attrs.expression || '',
          variables: Array.isArray(attrs.variables) ? attrs.variables.slice() : [],
          output: (attrs.output && typeof attrs.output === 'object') ? Object.assign({}, attrs.output) : null,
        });
      });
    });
    return formulas;
  }

  /* Generate a calc id. Same shape as the V3.114 chip ids — short ts
   * + nonce, kebab-prefixed. */
  function _newCalcId() {
    return 'calc-' + Date.now().toString(36) + '-' + Math.random().toString(36).slice(2, 8);
  }

  /* Build a flat input descriptor list from the formulas. Each entry
   * is a single user-facing input row. Skips duplicates by name (a
   * variable referenced in two formula blocks shows up once). */
  function _flattenCalcInputs(formulas) {
    var seen = {};
    var rows = [];
    formulas.forEach(function (f) {
      (f.variables || []).forEach(function (v) {
        if (!v || !v.name || seen[v.name]) return;
        seen[v.name] = true;
        rows.push({
          name: v.name,
          label: v.label || v.name,
          unit: v.unit || '',
          default_raw: v.default,
          // Type: boolean default → checkbox; otherwise numeric (if
          // the default parses) or text. 'boolean' is the only
          // explicit branch; everything else is a number-or-text
          // input that the build pass will parseFloat.
          type: (v.default === true || v.default === false) ? 'boolean'
              : (v.unit ? 'numeric' : (typeof v.default === 'number' ? 'numeric' : 'text')),
        });
      });
    });
    return rows;
  }

  /* Build the mathjs symbol table by overlaying user-typed input
   * values onto the formula scaffold. We mutate a SHALLOW COPY of
   * each formula's variables[] so the protocol's persisted defaults
   * aren't disturbed. Then ProtocolFormulas.buildSymbolTable runs
   * the chained evaluation. */
  function _buildCalcSymbolTable(formulas, userInputs, math, ProtocolFormulas) {
    var clone = formulas.map(function (f) {
      var v2 = (f.variables || []).map(function (v) {
        if (!v || !v.name) return v;
        if (Object.prototype.hasOwnProperty.call(userInputs, v.name)) {
          return Object.assign({}, v, { default: userInputs[v.name] });
        }
        return v;
      });
      return Object.assign({}, f, { variables: v2 });
    });
    return ProtocolFormulas.buildSymbolTable(clone, math);
  }

  /* Open the calculator modal. opts.editingCalcId, when present,
   * means "re-edit an existing inserted block" — the modal pre-fills
   * inputs from state.doc.calc_runs[i] and on Insert replaces the
   * existing <div class="ln-calc"> in the body instead of appending
   * a new one. */
  async function openProtocolCalculator(protocolId, opts) {
    if (!state.doc) return;
    opts = opts || {};
    var editingCalcId = opts.editingCalcId || null;

    setSavingHint('loading calculator…');
    var PF, math, plainTree;
    try {
      PF = await _ensureProtocolFormulas();
      math = await PF.ensureMathjs();
      plainTree = await _loadProtocolTree(protocolId);
    } catch (err) {
      setSavingHint('calculator load failed');
      alert('Could not load protocol calculator: ' + (err && err.message || err));
      return;
    }
    setSavingHint('');

    var formulas = _collectFormulasFromPlainTree(plainTree);
    if (!formulas.length) {
      alert('This protocol has no formula blocks. Add a Formula block to the protocol first, then come back to use it as a calculator.');
      return;
    }

    var inputRows = _flattenCalcInputs(formulas);
    var protocolTitle = plainTree.meta && plainTree.meta.title || protocolId;

    // Working state — for a re-edit, pre-fill from the saved calc_run.
    var workingFormat = 'steps';
    var workingInputs = {};
    if (editingCalcId) {
      var prior = (state.doc.calc_runs || []).find(function (r) { return r.id === editingCalcId; });
      if (prior) {
        workingFormat = prior.format || 'steps';
        Object.keys(prior.inputs || {}).forEach(function (k) {
          workingInputs[k] = prior.inputs[k] && prior.inputs[k].value;
        });
      }
    }
    // Defaults for any input the prior calc_run didn't cover (e.g.
    // a new variable was added to the protocol since insert time).
    inputRows.forEach(function (row) {
      if (!Object.prototype.hasOwnProperty.call(workingInputs, row.name)) {
        workingInputs[row.name] = row.default_raw;
      }
    });

    var lastTable = null;   // mathjs symbol table after most recent compute

    // ── Build the modal ──
    var back = document.createElement('div');
    back.className = 'ln-modal-back';
    back.innerHTML =
      '<div class="ln-modal ln-calc-modal" role="dialog" aria-label="Protocol calculator">' +
        '<div class="ln-modal-head">' +
          '<h2>Calculator · ' + escapeHtml(protocolTitle) +
            '<span class="ln-modal-sub">' + (editingCalcId ? '— editing existing' : '— protocol-driven') + '</span>' +
          '</h2>' +
          '<button class="ln-modal-x" aria-label="Close">×</button>' +
        '</div>' +
        '<div class="ln-modal-body ln-calc-modal-body">' +
          '<div class="ln-calc-section">' +
            '<label class="ln-modal-label">Inputs <span class="ln-calc-section-hint">— protocol\'s variable scope</span></label>' +
            '<div id="ln-calc-inputs"></div>' +
          '</div>' +
          '<div class="ln-calc-compute-row">' +
            '<button class="ln-calc-compute" type="button">▶ Compute</button>' +
            '<span class="ln-calc-status" id="ln-calc-status"></span>' +
          '</div>' +
          '<div class="ln-calc-section">' +
            '<label class="ln-modal-label">Outputs</label>' +
            '<div id="ln-calc-outputs" class="ln-calc-outputs"></div>' +
          '</div>' +
          '<div class="ln-calc-section">' +
            '<label class="ln-modal-label">Output format</label>' +
            '<div class="ln-calc-format-row">' +
              '<label><input type="radio" name="ln-calc-fmt" value="steps">Steps with substituted values</label>' +
              '<label><input type="radio" name="ln-calc-fmt" value="snippet">Snippet (one-line)</label>' +
              '<label><input type="radio" name="ln-calc-fmt" value="table">Table</label>' +
            '</div>' +
            '<div class="ln-calc-format-help" id="ln-calc-format-help"></div>' +
          '</div>' +
        '</div>' +
        '<div class="ln-modal-foot">' +
          '<button class="ln-modal-cancel">Cancel</button>' +
          '<button class="ln-modal-save primary" disabled>' + (editingCalcId ? 'Update entry' : 'Insert into entry') + '</button>' +
        '</div>' +
      '</div>';
    document.body.appendChild(back);

    function close() { if (document.body.contains(back)) document.body.removeChild(back); }
    back.querySelector('.ln-modal-x').addEventListener('click', close);
    back.querySelector('.ln-modal-cancel').addEventListener('click', close);
    back.addEventListener('click', function (e) { if (e.target === back) close(); });
    document.addEventListener('keydown', function escClose(e) {
      if (e.key === 'Escape' && document.body.contains(back)) {
        close();
        document.removeEventListener('keydown', escClose);
      }
    });

    var inputsEl   = back.querySelector('#ln-calc-inputs');
    var outputsEl  = back.querySelector('#ln-calc-outputs');
    var statusEl   = back.querySelector('#ln-calc-status');
    var helpEl     = back.querySelector('#ln-calc-format-help');
    var computeBtn = back.querySelector('.ln-calc-compute');
    var saveBtn    = back.querySelector('.ln-modal-save');

    function renderInputs() {
      inputsEl.innerHTML = inputRows.map(function (row) {
        var val = workingInputs[row.name];
        if (row.type === 'boolean') {
          var checked = (val === true) ? ' checked' : '';
          return '<div class="ln-calc-input-row" data-name="' + escapeHtml(row.name) + '">' +
            '<label class="ln-calc-input-label">' + escapeHtml(row.label) + '</label>' +
            '<input type="checkbox" class="ln-calc-input"' + checked + '>' +
            '<span class="ln-calc-input-unit"></span>' +
            '<span class="ln-calc-input-name">' + escapeHtml(row.name) + '</span>' +
            '</div>';
        }
        var raw = (val === undefined || val === null) ? '' : String(val);
        return '<div class="ln-calc-input-row" data-name="' + escapeHtml(row.name) + '">' +
          '<label class="ln-calc-input-label">' + escapeHtml(row.label) + '</label>' +
          '<input type="' + (row.type === 'numeric' ? 'number' : 'text') + '" class="ln-calc-input" value="' + escapeHtml(raw) + '" step="any">' +
          '<span class="ln-calc-input-unit">' + escapeHtml(row.unit) + '</span>' +
          '<span class="ln-calc-input-name">' + escapeHtml(row.name) + '</span>' +
          '</div>';
      }).join('');
      Array.prototype.forEach.call(inputsEl.querySelectorAll('.ln-calc-input-row'), function (rowEl) {
        var name = rowEl.getAttribute('data-name');
        var input = rowEl.querySelector('.ln-calc-input');
        input.addEventListener('input', function () {
          if (input.type === 'checkbox') {
            workingInputs[name] = input.checked;
          } else {
            var v = input.value;
            var n = parseFloat(v);
            workingInputs[name] = (v !== '' && !isNaN(n) && isFinite(n)) ? n : v;
          }
          // An input change invalidates the previous compute — disable
          // Insert until the user re-runs Compute. Visual hint via the
          // status text.
          lastTable = null;
          statusEl.textContent = '';
          saveBtn.disabled = true;
        });
      });
    }

    function renderOutputs() {
      var formulasWithOutput = formulas.filter(function (f) { return f.output && f.output.name; });
      if (!formulasWithOutput.length) {
        outputsEl.innerHTML = '<div class="ln-calc-empty">— this protocol has formula blocks but none with an output. Compute will still run; nothing to display.</div>';
        return;
      }
      if (!lastTable) {
        outputsEl.innerHTML = formulasWithOutput.map(function (f) {
          return '<div class="ln-calc-output-row">' +
              '<span class="ln-calc-output-label">' + escapeHtml(f.output.label || f.output.name) + '</span>' +
              '<span class="ln-calc-output-value placeholder">—</span>' +
              '<span class="ln-calc-output-unit">' + escapeHtml(f.output.unit || '') + '</span>' +
              '<span class="ln-calc-input-name">' + escapeHtml(f.output.name) + '</span>' +
            '</div>';
        }).join('');
        return;
      }
      outputsEl.innerHTML = formulasWithOutput.map(function (f) {
        var sym = lastTable[f.output.name];
        var valHtml, valClass = 'ln-calc-output-value';
        if (!sym) { valHtml = '?'; valClass += ' placeholder'; }
        else if (sym.error) { valHtml = '⚠ ' + escapeHtml(sym.error); valClass += ' error'; }
        else if (sym.value === null || sym.value === undefined) { valHtml = '?'; valClass += ' placeholder'; }
        else { valHtml = escapeHtml(String(sym.value)); }
        return '<div class="ln-calc-output-row">' +
            '<span class="ln-calc-output-label">' + escapeHtml(f.output.label || f.output.name) + '</span>' +
            '<span class="' + valClass + '">' + valHtml + '</span>' +
            '<span class="ln-calc-output-unit">' + escapeHtml(f.output.unit || '') + '</span>' +
            '<span class="ln-calc-input-name">' + escapeHtml(f.output.name) + '</span>' +
          '</div>';
      }).join('');
    }

    function renderFormatRadio() {
      Array.prototype.forEach.call(back.querySelectorAll('input[name="ln-calc-fmt"]'), function (r) {
        r.checked = (r.value === workingFormat);
        r.addEventListener('change', function () {
          if (r.checked) { workingFormat = r.value; renderFormatHelp(); }
        });
      });
      renderFormatHelp();
    }

    function renderFormatHelp() {
      var helpText = {
        steps:   'Render the protocol body with [!var:name] tokens replaced by computed values + units.',
        snippet: 'One-line summary: protocol title, inputs, outputs.',
        table:   'A small HTML table — one row per input + output.',
      };
      helpEl.textContent = helpText[workingFormat] || '';
    }

    computeBtn.addEventListener('click', function () {
      try {
        lastTable = _buildCalcSymbolTable(formulas, workingInputs, math, PF);
        statusEl.textContent = 'computed ' + new Date().toLocaleTimeString();
        statusEl.classList.remove('error');
        saveBtn.disabled = false;
        renderOutputs();
      } catch (err) {
        statusEl.textContent = 'compute failed: ' + (err && err.message || err);
        statusEl.classList.add('error');
        saveBtn.disabled = true;
      }
    });

    saveBtn.addEventListener('click', function () {
      if (!lastTable) return;
      _commitCalcInsert({
        protocolId: protocolId,
        protocolTitle: protocolTitle,
        formulas: formulas,
        inputRows: inputRows,
        userInputs: workingInputs,
        symbolTable: lastTable,
        format: workingFormat,
        plainTree: plainTree,
        editingCalcId: editingCalcId,
      });
      close();
    });

    renderInputs();
    renderOutputs();
    renderFormatRadio();
  }

  /* Materialise the calc into the entry — render the chosen format,
   * persist a calc_runs[] entry, insert (or replace) the
   * <div class="ln-calc"> block in the body. */
  function _commitCalcInsert(spec) {
    var bodyEl = document.getElementById('ln-body');
    if (!bodyEl) return;
    _ensureBodyCaret(bodyEl);

    // Build the calc_run record (input + output snapshots).
    var inputsRecord = {};
    spec.inputRows.forEach(function (row) {
      var v = spec.userInputs[row.name];
      inputsRecord[row.name] = { value: v, unit: row.unit || '', label: row.label || row.name };
    });
    var outputsRecord = {};
    spec.formulas.forEach(function (f) {
      if (!f.output || !f.output.name) return;
      var sym = spec.symbolTable[f.output.name];
      if (!sym) return;
      outputsRecord[f.output.name] = {
        value: sym.value,
        unit: sym.unit || '',
        label: sym.label || f.output.name,
        error: sym.error || null,
      };
    });

    var calcId = spec.editingCalcId || _newCalcId();
    var nowIso = isoNow();

    // Render block HTML (V3.135 — three formats).
    var inner = '';
    if (spec.format === 'snippet') {
      inner = _renderCalcSnippetHtml(spec.protocolTitle, inputsRecord, outputsRecord);
    } else if (spec.format === 'table') {
      inner = _renderCalcTableHtml(spec.protocolTitle, inputsRecord, outputsRecord);
    } else {
      // Default — steps with substituted values.
      inner = _renderCalcStepsHtml(spec.plainTree, spec.symbolTable);
    }
    var blockHtml =
      '<div class="ln-calc ln-calc-' + escapeHtml(spec.format) + '" contenteditable="false"' +
        ' data-calc-id="' + escapeHtml(calcId) + '"' +
        ' data-calc-protocol-id="' + escapeHtml(spec.protocolId) + '"' +
        ' data-calc-format="' + escapeHtml(spec.format) + '">' +
        '<span class="ln-calc-edit-hint" contenteditable="false">click to re-edit</span>' +
        inner +
      '</div>';

    if (spec.editingCalcId) {
      // Replace the existing <div class="ln-calc" data-calc-id="..."> in the body.
      var existing = bodyEl.querySelector('.ln-calc[data-calc-id="' + spec.editingCalcId + '"]');
      if (existing) {
        existing.outerHTML = blockHtml;
      } else {
        // The block was deleted in the body but the calc_run still exists — append.
        _appendHtmlToBody(bodyEl, blockHtml + '<p><br></p>');
      }
    } else {
      _appendHtmlToBody(bodyEl, blockHtml + '<p><br></p>');
    }

    // Update / append calc_runs[] entry.
    if (!Array.isArray(state.doc.calc_runs)) state.doc.calc_runs = [];
    var idx = state.doc.calc_runs.findIndex(function (r) { return r.id === calcId; });
    var record = {
      id: calcId,
      protocol_id: spec.protocolId,
      protocol_title: spec.protocolTitle,
      inputs: inputsRecord,
      outputs: outputsRecord,
      format: spec.format,
      created_at: idx >= 0 ? state.doc.calc_runs[idx].created_at : nowIso,
      updated_at: nowIso,
    };
    if (idx >= 0) state.doc.calc_runs[idx] = record;
    else state.doc.calc_runs.push(record);

    state.doc.body_html = sanitizeHtml(bodyEl.innerHTML);
    refreshBodyEmptyState();
    scheduleSave();
    upsertIndexRow(state.doc);
    renderRail();
    setSavingHint('calc inserted · ' + Object.keys(outputsRecord).length + ' output' +
      (Object.keys(outputsRecord).length === 1 ? '' : 's'));
  }

  /* ── Three render formats. All three return an inner HTML string;
   * the caller wraps in <div class="ln-calc ln-calc-{kind}">. ── */

  function _renderCalcSnippetHtml(title, inputs, outputs) {
    var inputsStr = Object.keys(inputs).map(function (k) {
      var v = inputs[k];
      var raw = (v.value === null || v.value === undefined || v.value === '') ? '?' : String(v.value);
      return escapeHtml(k) + '=' + escapeHtml(raw) + (v.unit ? ' ' + escapeHtml(v.unit) : '');
    }).join(', ');
    var outputsStr = Object.keys(outputs).map(function (k) {
      var v = outputs[k];
      if (v.error) return escapeHtml(v.label || k) + ' ⚠';
      var raw = (v.value === null || v.value === undefined || v.value === '') ? '?' : String(v.value);
      return escapeHtml(v.label || k) + ' ' + escapeHtml(raw) + (v.unit ? ' ' + escapeHtml(v.unit) : '');
    }).join(' · ');
    return '<div class="ln-calc-snippet-line">' +
      '<strong>🧮 ' + escapeHtml(title) + '</strong>' +
      ' · <span class="ln-calc-snip-inputs">' + (inputsStr || '<em>no inputs</em>') + '</span>' +
      ' → <span class="ln-calc-snip-outputs">' + (outputsStr || '<em>no outputs</em>') + '</span>' +
      '</div>';
  }

  function _renderCalcTableHtml(title, inputs, outputs) {
    var inputRows = Object.keys(inputs).map(function (k) {
      var v = inputs[k];
      var raw = (v.value === null || v.value === undefined || v.value === '') ? '—' : String(v.value);
      return '<tr><td>' + escapeHtml(v.label || k) + '</td>' +
        '<td>' + escapeHtml(raw) + '</td>' +
        '<td>' + escapeHtml(v.unit || '') + '</td>' +
        '<td class="ln-calc-cell-input">input</td></tr>';
    }).join('');
    var outRows = Object.keys(outputs).map(function (k) {
      var v = outputs[k];
      var raw, cls = '';
      if (v.error) { raw = '⚠ ' + v.error; cls = ' class="error"'; }
      else if (v.value === null || v.value === undefined || v.value === '') { raw = '—'; }
      else raw = String(v.value);
      return '<tr' + cls + '><td>' + escapeHtml(v.label || k) + '</td>' +
        '<td>' + escapeHtml(raw) + '</td>' +
        '<td>' + escapeHtml(v.unit || '') + '</td>' +
        '<td class="ln-calc-cell-output">output</td></tr>';
    }).join('');
    return '<div class="ln-calc-table-title"><strong>🧮 ' + escapeHtml(title) + '</strong></div>' +
      '<table class="ln-calc-table-tbl"><thead><tr><th>Variable</th><th>Value</th><th>Unit</th><th></th></tr></thead>' +
      '<tbody>' + inputRows + outRows + '</tbody></table>';
  }

  /* Steps format — walk the protocol body and substitute [!var:name]
   * tokens with computed values via ProtocolFormulas.renderTextWithTokens.
   * We walk the same V3.134-dehydrated protocol tree, but route every
   * body string through the substitution pass. */
  function _renderCalcStepsHtml(plainTree, symbolTable) {
    var PF = window.ProtocolFormulas;
    function sub(text) {
      if (!PF || !PF.renderTextWithTokens) return escapeHtml(text || '');
      return PF.renderTextWithTokens(text || '', symbolTable || {});
    }
    var html = '<div class="ln-calc-steps-title"><strong>🧮 ' + escapeHtml(plainTree.meta && plainTree.meta.title || 'Protocol') + ' — calculator</strong></div>';
    (plainTree.sections || []).forEach(function (sec) {
      if (sec.label) html += '<h4>' + escapeHtml(sec.label) + '</h4>';
      (sec.children || []).forEach(function (block) {
        switch (block.kind) {
          case 'step':
            html += '<p>' + sub(block.body) + '</p>';
            break;
          case 'note':
            html += '<blockquote>📝 <strong>Note.</strong> ' + sub(block.body) + '</blockquote>';
            break;
          case 'safety':
            html += '<blockquote>⚠ <strong>Safety.</strong> ' + sub(block.body) + '</blockquote>';
            break;
          case 'figure': {
            var lbl = (block.attrs && (block.attrs.label || block.attrs.alt)) || 'Figure';
            html += '<p><em>[' + escapeHtml(lbl) + ']</em>' + (block.body ? ' — ' + sub(block.body) : '') + '</p>';
            break;
          }
          case 'materials': {
            var rows = (block.attrs && block.attrs.rows) || [];
            if (!rows.length) break;
            var lis = rows.map(function (r) {
              var qty = (r.qty != null ? String(r.qty) : '') + (r.unit ? ' ' + r.unit : '');
              var name = r.free_text || r.item_ref || '(material)';
              var line = (qty ? qty + ' · ' : '') + name;
              return '<li>' + sub(line.trim()) + '</li>';
            }).join('');
            html += '<p><strong>Materials:</strong></p><ul>' + lis + '</ul>';
            break;
          }
          case 'formula': {
            // Show the formula's output result inline so the steps render
            // includes the calc trail. Skip the LaTeX expression itself —
            // the value's what matters at the bench.
            if (block.attrs && block.attrs.output && block.attrs.output.name) {
              var sym = symbolTable && symbolTable[block.attrs.output.name];
              var lblText = (block.attrs.output.label || block.attrs.output.name);
              var valStr = sym ? PF.formatSymbolValue(sym) : '?';
              html += '<p><strong>' + escapeHtml(lblText) + ':</strong> ' + escapeHtml(valStr) + '</p>';
            }
            break;
          }
          default:
            html += '<p>' + sub(block.body) + '</p>';
        }
      });
    });
    return html;
  }

  /* V3.126 — admin Members modal removed from this page. Project
   * membership is the auth backbone for every page that gates by
   * `member_uids[]` (PMR's `array-contains` query, this page's
   * in-entry project picker filter, future page-level access
   * controls). Putting the editor here scoped it to one page; moving
   * it to /rm/pages/projects.html — the canonical "Projects" surface
   * — means the same assignment propagates everywhere automatically.
   * The Lab Notebook stays a read-only consumer of member_uids[] via
   * `state.assignedProjectIds`. */

  /* ─────────────────────────────────────────────────────────────
   * DOE builder (V3.123) — Latin Hypercube + Full Factorial + CCD
   * ─────────────────────────────────────────────────────────────
   * Toolbar 🧮 DOE button → modal: pick design type → enter factors
   * (name, low, high, levels) → generate matrix → preview → insert.
   * Stored as state.doc.design = {type, factors[], runs[], config, created_at}.
   * One design per entry (V1). Phase 3 will overlay actuals onto each run.
   * Algorithms in-house, no external library.
   */

  /* Full Factorial — cartesian product of factor levels.
   * Each factor's `levels` count divides [low, high] linearly. levels
   * defaults to 2 (just low + high) if not set. Total runs = product. */
  function _doeFullFactorial(factors) {
    function levelValues(f) {
      var n = Math.max(2, Math.floor(f.levels || 2));
      if (n === 2) return [+f.low, +f.high];
      var step = (+f.high - +f.low) / (n - 1);
      var out = [];
      for (var i = 0; i < n; i++) out.push(+(+f.low + i * step).toFixed(4));
      return out;
    }
    var levels = factors.map(levelValues);
    var runs = [{}];
    factors.forEach(function (f, i) {
      var nextRuns = [];
      levels[i].forEach(function (v) {
        runs.forEach(function (r) {
          var nr = Object.assign({}, r);
          nr[f.name] = v;
          nextRuns.push(nr);
        });
      });
      runs = nextRuns;
    });
    return runs;
  }

  /* Latin Hypercube Sampling — for k factors and n runs, divide each
   * factor's range into n equal strata, take one sample from each
   * stratum, and randomly permute the strata across runs so no two
   * runs share a stratum on any factor. We use the stratum center
   * (no jitter) for reproducibility — same factors + same n produce
   * the same matrix on regenerate so a student can re-derive without
   * surprise. */
  function _doeLatinHypercube(factors, nRuns) {
    nRuns = Math.max(1, Math.floor(nRuns || 0));
    if (!nRuns) return [];
    function shuffled(n) {
      var p = []; for (var i = 0; i < n; i++) p.push(i);
      for (var i = n - 1; i > 0; i--) {
        var j = Math.floor(Math.random() * (i + 1));
        var t = p[i]; p[i] = p[j]; p[j] = t;
      }
      return p;
    }
    var perms = factors.map(function () { return shuffled(nRuns); });
    var runs = [];
    for (var run = 0; run < nRuns; run++) {
      var r = {};
      factors.forEach(function (f, i) {
        var u = (perms[i][run] + 0.5) / nRuns;
        r[f.name] = +(+f.low + u * (+f.high - +f.low)).toFixed(4);
      });
      runs.push(r);
    }
    return runs;
  }

  /* Central Composite Design — factorial points (2^k corners) +
   * axial points (2k along each axis at ±α from center) + n0 center
   * replicates. α is the rotatability constant (2^k)^(1/4). Maps the
   * coded values back through (center, half-range) to factor units. */
  function _doeCentralComposite(factors, n0) {
    var k = factors.length;
    if (k < 2) throw new Error('Central Composite requires at least 2 factors.');
    n0 = Math.max(1, Math.floor(n0 || (k === 2 ? 5 : k === 3 ? 6 : 4)));
    var alpha = +Math.pow(Math.pow(2, k), 1 / 4).toFixed(4);
    var centers = factors.map(function (f) { return (+f.low + +f.high) / 2; });
    var halves  = factors.map(function (f) { return (+f.high - +f.low) / 2; });
    function code(coded) {
      var r = {};
      factors.forEach(function (f, i) {
        r[f.name] = +(centers[i] + coded[i] * halves[i]).toFixed(4);
      });
      return r;
    }
    var runs = [];
    // Factorial corners (2^k)
    for (var i = 0; i < (1 << k); i++) {
      var coded = [];
      for (var j = 0; j < k; j++) {
        coded.push((i & (1 << j)) ? 1 : -1);
      }
      runs.push(code(coded));
    }
    // Axial points (2k)
    for (var f = 0; f < k; f++) {
      [-1, 1].forEach(function (s) {
        var coded = factors.map(function () { return 0; });
        coded[f] = s * alpha;
        runs.push(code(coded));
      });
    }
    // Center replicates (n0)
    for (var c = 0; c < n0; c++) {
      runs.push(code(factors.map(function () { return 0; })));
    }
    return { runs: runs, alpha: alpha, n0: n0 };
  }

  function _doeGenerate(type, factors, config) {
    if (!Array.isArray(factors) || !factors.length) {
      throw new Error('Add at least one factor before generating.');
    }
    factors.forEach(function (f) {
      if (!f.name || !f.name.trim()) throw new Error('Every factor needs a name.');
      if (isNaN(+f.low) || isNaN(+f.high)) throw new Error('Factor "' + f.name + '" needs numeric low + high.');
      if (+f.low === +f.high) throw new Error('Factor "' + f.name + '" — low and high cannot match.');
    });
    if (type === 'lhs') {
      var nRuns = Math.max(factors.length + 1, Math.floor(config && config.nRuns || 0));
      if (nRuns > 200) throw new Error('LHS capped at 200 runs (got ' + nRuns + ').');
      return { runs: _doeLatinHypercube(factors, nRuns), config: { nRuns: nRuns } };
    }
    if (type === 'factorial') {
      var total = factors.reduce(function (a, f) { return a * Math.max(2, Math.floor(f.levels || 2)); }, 1);
      if (total > 256) throw new Error('Full factorial would generate ' + total + ' runs (capped at 256). Drop a factor or reduce levels.');
      return { runs: _doeFullFactorial(factors), config: {} };
    }
    if (type === 'ccd') {
      if (factors.length < 2) throw new Error('Central Composite requires at least 2 factors.');
      if (factors.length > 6) throw new Error('Central Composite capped at 6 factors (got ' + factors.length + ').');
      var ccd = _doeCentralComposite(factors, config && config.n0);
      return { runs: ccd.runs, config: { n0: ccd.n0, alpha: ccd.alpha } };
    }
    throw new Error('Unknown design type: ' + type);
  }

  /* ─────────────────────────────────────────────────────────────
   * DOE modal
   * ───────────────────────────────────────────────────────────── */
  function openDoeModal() {
    if (!state.doc) return;
    // Working state — start from existing design if present so "Edit" is
    // a real workflow, not a destructive overwrite.
    var existing = state.doc.design;
    var working = existing
      ? {
          type: existing.type,
          factors: (existing.factors || []).map(function (f) {
            return { name: f.name, low: f.low, high: f.high, levels: f.levels || 2 };
          }),
          config: Object.assign({}, existing.config || {}),
        }
      : {
          type: 'lhs',
          factors: [
            { name: 'factor1', low: 0, high: 1, levels: 2 },
            { name: 'factor2', low: 0, high: 1, levels: 2 },
          ],
          config: { nRuns: 10 },
        };
    var preview = null; // last generated { runs, config } or null

    var back = document.createElement('div');
    back.className = 'ln-modal-back';
    back.innerHTML =
      '<div class="ln-modal ln-doe-modal" role="dialog" aria-label="Design of experiments">' +
        '<div class="ln-modal-head">' +
          '<h2>Design of experiments' +
            '<span class="ln-modal-sub">— plan a structured run matrix</span>' +
          '</h2>' +
          '<button class="ln-modal-x" aria-label="Close">×</button>' +
        '</div>' +
        '<div class="ln-modal-body ln-doe-body">' +
          '<div class="ln-doe-section">' +
            '<label class="ln-modal-label">Design type</label>' +
            '<div class="ln-doe-type-row">' +
              NOTEBOOK_DOE_TYPES.map(function (t) {
                return '<label class="ln-doe-type"><input type="radio" name="ln-doe-type" value="' + t + '">' +
                  '<span>' + escapeHtml(NOTEBOOK_DOE_TYPE_LABELS[t]) + '</span></label>';
              }).join('') +
            '</div>' +
            '<div class="ln-doe-type-help" id="ln-doe-help"></div>' +
          '</div>' +
          '<div class="ln-doe-section">' +
            '<label class="ln-modal-label">Factors</label>' +
            '<div id="ln-doe-factors"></div>' +
            '<button class="ln-add-btn" id="ln-doe-add-factor">+ add factor</button>' +
          '</div>' +
          '<div class="ln-doe-section" id="ln-doe-config-section"></div>' +
          '<div class="ln-doe-section ln-doe-preview" id="ln-doe-preview"></div>' +
        '</div>' +
        '<div class="ln-modal-foot">' +
          '<button class="ln-modal-cancel">Cancel</button>' +
          '<button class="ln-doe-generate">Generate matrix</button>' +
          '<button class="ln-modal-save primary" disabled>Insert into entry</button>' +
        '</div>' +
      '</div>';
    document.body.appendChild(back);

    function close() { if (document.body.contains(back)) document.body.removeChild(back); }
    back.querySelector('.ln-modal-x').addEventListener('click', close);
    back.querySelector('.ln-modal-cancel').addEventListener('click', close);
    back.addEventListener('click', function (e) { if (e.target === back) close(); });
    document.addEventListener('keydown', function escClose(e) {
      if (e.key === 'Escape' && document.body.contains(back)) {
        close();
        document.removeEventListener('keydown', escClose);
      }
    });

    var typeRadios = back.querySelectorAll('input[name="ln-doe-type"]');
    Array.prototype.forEach.call(typeRadios, function (r) {
      r.checked = (r.value === working.type);
      r.addEventListener('change', function () {
        if (r.checked) { working.type = r.value; preview = null; renderConfig(); renderFactors(); renderPreview(); refreshSaveBtn(); }
      });
    });

    var helpEl = back.querySelector('#ln-doe-help');
    var factorsEl = back.querySelector('#ln-doe-factors');
    var configEl = back.querySelector('#ln-doe-config-section');
    var previewEl = back.querySelector('#ln-doe-preview');
    var generateBtn = back.querySelector('.ln-doe-generate');
    var saveBtn = back.querySelector('.ln-modal-save');

    function renderHelp() {
      var msgs = {
        lhs:       'Latin Hypercube — n stratified-random samples across continuous factors. Best for response-surface exploration with limited runs.',
        factorial: 'Full Factorial — every combination of factor levels. Use 2 levels for screening, 3+ levels for non-linear response. Total runs = product of levels.',
        ccd:       'Central Composite — factorial corners + axial (±α) + center replicates. Quadratic response-surface fit; needs ≥ 2 factors.',
      };
      helpEl.textContent = msgs[working.type] || '';
    }

    function renderFactors() {
      factorsEl.innerHTML = '';
      working.factors.forEach(function (f, i) {
        var row = document.createElement('div');
        row.className = 'ln-doe-factor-row';
        row.innerHTML =
          '<input class="ln-doe-fname"  type="text"   placeholder="name"  value="' + escapeHtml(f.name) + '">' +
          '<input class="ln-doe-flow"   type="number" placeholder="low"   value="' + escapeHtml(String(f.low))  + '" step="any">' +
          '<input class="ln-doe-fhigh"  type="number" placeholder="high"  value="' + escapeHtml(String(f.high)) + '" step="any">' +
          (working.type === 'factorial'
            ? '<input class="ln-doe-flevels" type="number" placeholder="levels" value="' + escapeHtml(String(f.levels || 2)) + '" min="2" max="8" step="1">'
            : '<span class="ln-doe-flevels-spacer"></span>') +
          '<span class="ln-doe-frm" data-i="' + i + '" title="remove factor">×</span>';
        factorsEl.appendChild(row);
        row.querySelector('.ln-doe-fname').addEventListener('input',  function (e) { f.name = e.target.value; preview = null; refreshSaveBtn(); });
        row.querySelector('.ln-doe-flow').addEventListener('input',   function (e) { f.low  = e.target.value; preview = null; refreshSaveBtn(); });
        row.querySelector('.ln-doe-fhigh').addEventListener('input',  function (e) { f.high = e.target.value; preview = null; refreshSaveBtn(); });
        var levelsInput = row.querySelector('.ln-doe-flevels');
        if (levelsInput) levelsInput.addEventListener('input', function (e) { f.levels = e.target.value; preview = null; refreshSaveBtn(); });
        row.querySelector('.ln-doe-frm').addEventListener('click', function () {
          working.factors.splice(i, 1); preview = null; renderFactors(); renderConfig(); refreshSaveBtn();
        });
      });
    }

    function renderConfig() {
      if (working.type === 'lhs') {
        configEl.innerHTML =
          '<label class="ln-modal-label">Number of runs ' +
            '<input type="number" id="ln-doe-nruns" min="' + (working.factors.length + 1) + '" max="200" value="' + escapeHtml(String(working.config.nRuns || 10)) + '">' +
          '</label>';
        configEl.querySelector('#ln-doe-nruns').addEventListener('input', function (e) {
          working.config.nRuns = +e.target.value; preview = null; refreshSaveBtn();
        });
      } else if (working.type === 'ccd') {
        var k = working.factors.length;
        var defaultN0 = k === 2 ? 5 : k === 3 ? 6 : 4;
        configEl.innerHTML =
          '<label class="ln-modal-label">Center-point replicates (n₀) ' +
            '<input type="number" id="ln-doe-n0" min="1" max="20" value="' + escapeHtml(String(working.config.n0 || defaultN0)) + '">' +
          '</label>' +
          '<div class="ln-doe-config-help">α = (2^k)^(1/4) is computed automatically.</div>';
        configEl.querySelector('#ln-doe-n0').addEventListener('input', function (e) {
          working.config.n0 = +e.target.value; preview = null; refreshSaveBtn();
        });
      } else {
        configEl.innerHTML = '<div class="ln-doe-config-help">Each factor\'s level count is set in the row above. Total runs = product of levels.</div>';
      }
    }

    function renderPreview() {
      if (!preview) {
        previewEl.innerHTML = '<div class="ln-doe-preview-empty">Click <strong>Generate matrix</strong> to preview the run table.</div>';
        return;
      }
      previewEl.innerHTML =
        '<label class="ln-modal-label">Preview · ' + preview.runs.length + ' run' + (preview.runs.length === 1 ? '' : 's') + '</label>' +
        renderDoeTableHtml(working.factors.map(function (f) { return f.name; }), preview.runs, /*showRowNum=*/true);
    }

    function refreshSaveBtn() {
      saveBtn.disabled = !preview;
    }

    back.querySelector('#ln-doe-add-factor').addEventListener('click', function () {
      working.factors.push({ name: 'factor' + (working.factors.length + 1), low: 0, high: 1, levels: 2 });
      preview = null;
      renderFactors(); renderConfig(); refreshSaveBtn();
    });

    generateBtn.addEventListener('click', function () {
      try {
        // Coerce numeric inputs.
        working.factors.forEach(function (f) {
          f.low = +f.low; f.high = +f.high; f.levels = Math.max(2, Math.floor(+f.levels || 2));
        });
        var result = _doeGenerate(working.type, working.factors, working.config);
        preview = result;
        renderPreview();
        refreshSaveBtn();
      } catch (err) {
        alert(err && err.message || err);
      }
    });

    saveBtn.addEventListener('click', function () {
      if (!preview) return;
      state.doc.design = {
        type: working.type,
        factors: working.factors.map(function (f) {
          return { name: f.name, low: +f.low, high: +f.high, levels: Math.max(2, Math.floor(+f.levels || 2)) };
        }),
        runs: preview.runs.slice(),
        // V3.361 — fresh matrix → fresh (empty) per-run results.
        run_results: preview.runs.map(function () { return { value: '', note: '' }; }),
        config: preview.config,
        created_at: isoNow(),
      };
      scheduleSave();
      upsertIndexRow(state.doc);
      renderEditor();   // re-render so the design panel appears
      renderRail();
      close();
      setSavingHint('design generated · ' + preview.runs.length + ' runs');
    });

    renderHelp();
    renderFactors();
    renderConfig();
    renderPreview();
    refreshSaveBtn();
  }

  /* Render a DOE matrix as an HTML table — shared between the modal
   * preview and the in-entry Design panel. */
  function renderDoeTableHtml(columnNames, runs, showRowNum) {
    if (!runs || !runs.length) return '<div class="ln-doe-preview-empty">(empty)</div>';
    var head = '<tr>' +
      (showRowNum ? '<th class="ln-doe-th-num">#</th>' : '') +
      columnNames.map(function (c) { return '<th>' + escapeHtml(c) + '</th>'; }).join('') +
      '</tr>';
    var body = runs.map(function (r, i) {
      return '<tr>' +
        (showRowNum ? '<td class="ln-doe-td-num">' + (i + 1) + '</td>' : '') +
        columnNames.map(function (c) {
          var v = r[c];
          return '<td>' + escapeHtml(v == null ? '' : String(v)) + '</td>';
        }).join('') +
        '</tr>';
    }).join('');
    return '<div class="ln-doe-table-scroll"><table class="ln-doe-table">' +
      '<thead>' + head + '</thead>' +
      '<tbody>' + body + '</tbody>' +
      '</table></div>';
  }

  /* In-entry Design panel — renders below "Protocols followed". */
  function renderDesignHtml(design) {
    if (!design) {
      return '<div class="ln-design" id="ln-design">' +
        '<h4>Design of experiments</h4>' +
        '<div class="ln-design-empty">' +
          '— click <strong>🧮 DOE</strong> in the toolbar to plan a structured run matrix (Latin Hypercube, Full Factorial, or Central Composite).' +
        '</div>' +
      '</div>';
    }
    var typeLabel = NOTEBOOK_DOE_TYPE_LABELS[design.type] || design.type;
    var factorNames = (design.factors || []).map(function (f) { return f.name; });
    var configBits = [];
    if (design.type === 'lhs' && design.config && design.config.nRuns) configBits.push(design.config.nRuns + ' runs');
    if (design.type === 'ccd') {
      if (design.config && design.config.n0)    configBits.push('n₀=' + design.config.n0);
      if (design.config && design.config.alpha) configBits.push('α=' + design.config.alpha);
    }
    // V3.361 — completed-runs progress chip closes the plan→result loop.
    var results = Array.isArray(design.run_results) ? design.run_results : [];
    var done = results.filter(function (r) { return r && (r.value || r.note); }).length;
    var resultChip = (design.runs || []).length
      ? '<span class="ln-design-results-chip' + (done === design.runs.length && done ? ' all-done' : '') + '">' +
          done + '/' + design.runs.length + ' results</span>'
      : '';
    return '<div class="ln-design" id="ln-design">' +
      '<h4>' +
        'Design of experiments · <span class="ln-design-type">' + escapeHtml(typeLabel) + '</span>' +
        ' · ' + (design.runs || []).length + ' run' + ((design.runs || []).length === 1 ? '' : 's') +
        (configBits.length ? ' · ' + escapeHtml(configBits.join(' · ')) : '') +
        resultChip +
      '</h4>' +
      '<div class="ln-design-actions">' +
        '<button class="ln-design-edit" type="button">✏️ Edit / Regenerate</button>' +
        '<button class="ln-design-csv" type="button">⬇ Download CSV</button>' +
        '<button class="ln-design-clear danger" type="button">Clear</button>' +
      '</div>' +
      renderDesignRunsTable(design) +
    '</div>';
  }

  /* V3.361 — the in-entry design table gains editable Result + note
   * columns bound to design.run_results[i] (a parallel array — factor
   * name collisions with "result" are impossible). The modal preview
   * keeps using the plain renderDoeTableHtml. */
  function renderDesignRunsTable(design) {
    var runs = design.runs || [];
    if (!runs.length) return '<div class="ln-doe-preview-empty">(empty)</div>';
    var cols = (design.factors || []).map(function (f) { return f.name; });
    var results = Array.isArray(design.run_results) ? design.run_results : [];
    var head = '<tr><th class="ln-doe-th-num">#</th>' +
      cols.map(function (c) { return '<th>' + escapeHtml(c) + '</th>'; }).join('') +
      '<th class="ln-doe-th-result">result</th><th class="ln-doe-th-result">note</th></tr>';
    var body = runs.map(function (r, i) {
      var res = results[i] || { value: '', note: '' };
      return '<tr>' +
        '<td class="ln-doe-td-num">' + (i + 1) + '</td>' +
        cols.map(function (c) {
          var v = r[c];
          return '<td>' + escapeHtml(v == null ? '' : String(v)) + '</td>';
        }).join('') +
        '<td class="ln-doe-td-result"><input type="text" class="ln-doe-result" data-i="' + i + '" data-k="value" placeholder="—" value="' + escapeHtml(res.value || '') + '"></td>' +
        '<td class="ln-doe-td-result"><input type="text" class="ln-doe-result" data-i="' + i + '" data-k="note" placeholder="" value="' + escapeHtml(res.note || '') + '"></td>' +
        '</tr>';
    }).join('');
    return '<div class="ln-doe-table-scroll"><table class="ln-doe-table ln-doe-table-results">' +
      '<thead>' + head + '</thead>' +
      '<tbody>' + body + '</tbody>' +
      '</table></div>';
  }

  function renderDesignPanel() {
    var box = document.getElementById('ln-design');
    if (!box || !state.doc) return;
    box.outerHTML = renderDesignHtml(state.doc.design);
    wireDesignPanel();
  }

  function wireDesignPanel() {
    var box = document.getElementById('ln-design');
    if (!box) return;
    var editBtn  = box.querySelector('.ln-design-edit');
    var csvBtn   = box.querySelector('.ln-design-csv');
    var clearBtn = box.querySelector('.ln-design-clear');
    if (editBtn) editBtn.addEventListener('click', openDoeModal);
    if (csvBtn) csvBtn.addEventListener('click', downloadDesignCsv);
    if (clearBtn) clearBtn.addEventListener('click', clearDesign);
    // V3.361 — per-run result / note inputs. Typing saves via the normal
    // debounce; the header progress chip refreshes on blur so the row
    // being typed in never re-renders under the caret.
    Array.prototype.forEach.call(box.querySelectorAll('.ln-doe-result'), function (input) {
      input.addEventListener('input', function () {
        var d = state.doc && state.doc.design;
        if (!d) return;
        if (!Array.isArray(d.run_results)) d.run_results = [];
        var i = +input.getAttribute('data-i');
        var k = input.getAttribute('data-k') === 'note' ? 'note' : 'value';
        while (d.run_results.length <= i) d.run_results.push({ value: '', note: '' });
        d.run_results[i][k] = input.value;
        scheduleSave();
        refreshDesignResultsChip();
      });
    });
  }

  function refreshDesignResultsChip() {
    var chip = document.querySelector('#ln-design .ln-design-results-chip');
    var d = state.doc && state.doc.design;
    if (!chip || !d) return;
    var results = Array.isArray(d.run_results) ? d.run_results : [];
    var done = results.filter(function (r) { return r && (r.value || r.note); }).length;
    chip.textContent = done + '/' + (d.runs || []).length + ' results';
    chip.classList.toggle('all-done', !!done && done === (d.runs || []).length);
  }

  function clearDesign() {
    if (!state.doc || !state.doc.design) return;
    if (!confirm('Clear this design? The matrix will be removed from the entry.')) return;
    state.doc.design = null;
    scheduleSave();
    upsertIndexRow(state.doc);
    renderDesignPanel();
    renderRail();
  }

  function downloadDesignCsv() {
    var d = state.doc && state.doc.design;
    if (!d || !Array.isArray(d.runs) || !d.runs.length) return;
    var cols = (d.factors || []).map(function (f) { return f.name; });
    var results = Array.isArray(d.run_results) ? d.run_results : [];
    var rows = d.runs.map(function (r, i) {
      var res = results[i] || { value: '', note: '' };
      return [i + 1].concat(cols.map(function (c) {
        var v = r[c];
        return v == null ? '' : String(v);
      })).concat([res.value || '', res.note || '']);
    });
    function csvEscape(s) {
      s = String(s);
      if (/[",\n\r]/.test(s)) return '"' + s.replace(/"/g, '""') + '"';
      return s;
    }
    var lines = [['#'].concat(cols).concat(['result', 'note']).map(csvEscape).join(',')];
    rows.forEach(function (r) { lines.push(r.map(csvEscape).join(',')); });
    var blob = new Blob([lines.join('\n') + '\n'], { type: 'text/csv;charset=utf-8' });
    var url = URL.createObjectURL(blob);
    var a = document.createElement('a');
    a.href = url;
    a.download = (state.doc.id || 'design') + '_' + d.type + '.csv';
    document.body.appendChild(a);
    a.click();
    setTimeout(function () { document.body.removeChild(a); URL.revokeObjectURL(url); }, 0);
  }

  /* ─────────────────────────────────────────────────────────────
   * Lightbox
   * ───────────────────────────────────────────────────────────── */
  async function openLightbox(storagePath) {
    if (!storagePath || !window.NOTEBOOK_FIGURES) return;
    var url;
    try { url = await NOTEBOOK_FIGURES.downloadUrl(storagePath); }
    catch (err) { alert('Could not load attachment: ' + err.message); return; }
    var back = document.createElement('div');
    back.className = 'ln-lightbox-back';
    back.innerHTML = '<img src="' + escapeHtml(url) + '" alt="">';
    back.addEventListener('click', function () { document.body.removeChild(back); });
    document.body.appendChild(back);
  }

  /* ─────────────────────────────────────────────────────────────
   * Entry lifecycle
   * ───────────────────────────────────────────────────────────── */
  /* V3.361 — opts.seed (template/clone/iteration payload, applied via
   * applySeedToDoc) and opts.slug (id slug source) are optional; a bare
   * onNewEntry() is the classic blank entry. */
  async function onNewEntry(opts) {
    opts = opts || {};
    var entry = notebookEmptyEntry();
    entry.title = '';
    entry.date = todayStr();
    entry.ownerUid = state.user.uid;
    if (opts.seed) applySeedToDoc(entry, opts.seed);
    entry.id = newEntryId(entry.date, opts.slug || entry.title || 'entry');
    state.doc = entry;
    state.currentId = entry.id;
    upsertIndexRow(entry);
    detachLiveSync();
    renderEditor();
    renderRail();
    if (state.drawers) state.drawers.close();
    // Focus title for immediate typing.
    var t = document.getElementById('ln-title'); if (t) t.focus();
    // Persist a stub so the entry exists in Firestore even if the user
    // navigates away before typing anything.
    try { await saveEntry(); } catch (_) {}
    attachLiveSync();
    // V3.530 — double-dip: offer to fan the new entry out (huddle plan,
    // tracker event, …). draft is a FUNCTION so the title the user is
    // typing right now is captured at tap time, not at creation time.
    if (window.DAY_DISTRIBUTE) DAY_DISTRIBUTE.renderChipsFloating({
      source: 'notebook',
      nativeDocPath: 'userData/' + state.user.uid + '/notebook/' + entry.id,
      draft: function () {
        var d = state.doc || entry;
        return {
          title: d.title || 'Notebook entry', date: d.date || entry.date,
          details: { projectId: d.project_id, protocolId: d.protocol_id },
        };
      },
    });
  }

  async function switchToEntry(id) {
    if (!id || id === state.currentId) return;
    detachLiveSync();
    state.currentId = id;
    state.doc = await loadEntry(id);
    if (!state.doc) {
      // Entry disappeared (deleted in another tab) — drop from index.
      removeIndexRow(id);
      state.currentId = null;
      await saveIndex();
      renderEditor();
      renderRail();
      return;
    }
    renderEditor();
    renderRail();
    attachLiveSync();
  }

  async function onDeleteEntry() {
    if (!state.doc || !state.currentId) return;
    if (!confirm('Delete this entry? Attachments stay in Storage (deduped uploads may be referenced by other entries).')) return;
    var id = state.currentId;
    detachLiveSync();
    try {
      ensureEntryRoute(id);
      // The adapter treats save({}) on a doc-route as a wipe; cleaner is a
      // dedicated delete in api-firestore-adapter.js, but we mirror the
      // existing PMR pattern (no explicit delete API) and rely on the
      // index to gate visibility.
      await api.save(entryPathFor(id), {});
    } catch (err) {
      console.error('[lab-notebook] delete failed:', err);
    }
    removeIndexRow(id);
    state.currentId = null;
    state.doc = null;
    await saveIndex();
    renderEditor();
    renderRail();
  }

  /* ─────────────────────────────────────────────────────────────
   * Boot
   * ───────────────────────────────────────────────────────────── */
  async function boot() {
    try {
      if (typeof firebridge === 'undefined' || !firebridge.requireSignIn) {
        var c = document.getElementById('ln-content');
        if (c) c.innerHTML = '<div class="ln-loading">firebridge missing — load order issue.</div>';
        return;
      }
      var gate = await firebridge.requireSignIn(
        'The lab notebook is for lab members. Sign in with your @arizona.edu (or admin Google) account.'
      );
      if (!gate.allowed) return;

      if (firebridge.isLabMember && !firebridge.isLabMember()) {
        document.getElementById('ln-content').innerHTML =
          '<div class="ln-empty-pane">Your account is pending lab-member approval. Ask the admin to grant access.</div>';
        return;
      }

      state.user = firebridge.getUser();
      state.isAdmin = !!(firebridge.isAdmin && firebridge.isAdmin());

      // Reveal layout (the page shell hides ln-content until boot succeeds).
      // V3.359 — the layout is a mobile-drawer host: at ≤640px the rail
      // becomes a left slide-in drawer (shared .rm-mobile-drawer-* CSS),
      // toggled by the toolbar ☰ button.
      // Drawer classes only go on when the helper actually loaded — a
      // missing mobile-drawers.js must degrade to the stacked layout,
      // never a rail stranded off-screen.
      var drawerable = !!window.MOBILE_DRAWERS;
      var content = document.getElementById('ln-content');
      content.innerHTML =
        '<div class="ln-toolbar" id="ln-toolbar"></div>' +
        '<div class="ln-layout' + (drawerable ? ' rm-mobile-drawer-host' : '') + '" id="ln-layout">' +
          '<div class="ln-rail' + (drawerable ? ' rm-mobile-drawer-left' : '') + '" id="ln-rail"></div>' +
          '<div class="ln-editor" id="ln-editor"></div>' +
        '</div>';
      if (drawerable) {
        state.drawers = MOBILE_DRAWERS.init(document.getElementById('ln-layout'), {});
      }
      // V3.359 — phone quick-capture bar (fixed, outside re-render churn).
      ensureActionBar();

      // Wire camera + file inputs (hidden in the page shell).
      var cameraInput = document.getElementById('ln-camera-input');
      var fileInput   = document.getElementById('ln-file-input');
      if (cameraInput) cameraInput.addEventListener('change', function () {
        Array.from(cameraInput.files || []).forEach(function (f) {
          uploadAndAttach(f, /* insertInline */ true).catch(function (err) {
            lnNotify('error', 'Upload failed', err && err.message || String(err));
          });
        });
      });
      if (fileInput) fileInput.addEventListener('change', function () {
        Array.from(fileInput.files || []).forEach(function (f) {
          uploadAndAttach(f, /^image\//.test(f.type)).catch(function (err) {
            lnNotify('error', 'Upload failed', err && err.message || String(err));
          });
        });
      });

      await Promise.all([loadIndex(), loadProjects(), loadTemplatesDoc()]);

      renderToolbar();
      renderRail();
      // V3.361 — ?entry=<id> deep link (used by cross-entry reference
      // links and ↻ next-iteration back-links). Falls through to the
      // most-recent entry when the id is unknown.
      var params = new URLSearchParams(location.search);
      var wanted = params.get('entry');
      var rows = filteredIndexRows();
      var target = wanted && rows.find(function (r) { return r.id === wanted; }) ? wanted
                 : (rows.length ? rows[0].id : null);
      if (target) {
        await switchToEntry(target);
      } else {
        renderEditor();
      }
    } catch (err) {
      console.error('[lab-notebook] boot failed:', err);
      var c2 = document.getElementById('ln-content');
      if (c2) c2.innerHTML = '<div class="ln-loading">Boot failed: ' + escapeHtml(err && err.message || err) + '</div>';
    }
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', boot);
  } else {
    boot();
  }
})();
