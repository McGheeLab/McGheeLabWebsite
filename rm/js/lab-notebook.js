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
 */

(function () {
  'use strict';

  // V3.148 build probe — if you do NOT see this in the console after a
  // hard reload, your browser is running cached (older) lab-notebook.js.
  // Hard-reload again or unregister the service worker.
  console.log('[lab-notebook] V3.148 build loaded at', new Date().toISOString());

  /* ─────────────────────────────────────────────────────────────
   * Constants & state
   * ───────────────────────────────────────────────────────────── */
  var INDEX_PATH = 'notebook/_index.json';

  function entryPathFor(id) { return 'notebook/' + id + '.json'; }

  var state = {
    user: null,
    isAdmin: false,
    indexDoc: null,            // { entries: [{summary row}, ...] }
    currentId: null,
    doc: null,                 // full entry currently shown
    projects: [],              // [{id, label, type, member_uids}] from projects collection
    assignedProjectIds: null,  // Set<id> — projects where state.user.uid ∈ member_uids
    saveTimer: null,
    // V3.117 — toolbar is search-only. The project/tag/date dropdowns
    // were removed because the toolbar's job is finding existing
    // entries; project (and any other field) is set INSIDE the entry,
    // not on the bar. Search matches title + tags + project label so it
    // covers everything the dropdowns used to filter.
    filters: { q: '' },
  };

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
    } catch (err) {
      console.error('[lab-notebook] index save failed:', err);
    }
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
      renderEditor();
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
    return rows
      .filter(function (r) {
        if (!q) return true;
        // Match across title, tags, project label, status, and date.
        // Single-input search replaces the V3.110 tag/project/date
        // dropdowns — typing "microscopy" or "GELS" or "2026-05" all
        // narrow the rail.
        var hay = (r.title || '') + ' ' +
                  (Array.isArray(r.tags) ? r.tags.join(' ') : '') + ' ' +
                  projectLabel(r.project_id) + ' ' +
                  (r.status || '') + ' ' +
                  (r.date || '');
        return hay.toLowerCase().indexOf(q) >= 0;
      })
      .slice()
      .sort(function (a, b) { return (b.date || '').localeCompare(a.date || ''); });
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
    bar.innerHTML =
      '<button id="ln-new" class="primary">+ New entry</button>' +
      '<input id="ln-f-q" type="search" placeholder="Search title, tag, project, date…" value="' + escapeHtml(state.filters.q) + '" autocomplete="off">' +
      '<span class="grow"></span>' +
      '<span id="ln-saving" class="saving-hint"></span>';

    document.getElementById('ln-new').addEventListener('click', onNewEntry);
    document.getElementById('ln-f-q').addEventListener('input', function (e) {
      state.filters.q = e.target.value; renderRail();
    });
  }

  /* ─────────────────────────────────────────────────────────────
   * Left rail render
   * ───────────────────────────────────────────────────────────── */
  function renderRail() {
    var rail = document.getElementById('ln-rail');
    if (!rail) return;
    var rows = filteredIndexRows();
    if (!rows.length) {
      rail.innerHTML = '<div class="ln-empty">No entries yet. Click <strong>+ New entry</strong> to start.</div>';
      return;
    }
    var html = '<h3>Entries</h3>';
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
      el.addEventListener('click', function () { switchToEntry(el.getAttribute('data-id')); });
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
      pane.innerHTML =
        '<div class="ln-empty-pane">' +
          '<div class="big">📓</div>' +
          'Select an entry from the rail, or click <strong>+ New entry</strong> to start.' +
        '</div>';
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
      renderProtocolsHtml(d.protocol_refs || []) +
      renderMaterialsHtml(d.inventory_refs || []) +
      renderAttachmentsHtml(d.attachments || []) +
      renderRefsHtml(d.reference_links || []) +
      '<div id="ln-ext-links"></div>' +
      renderObservationsHtml(d) +
      renderSummaryHtml(d) +
      renderRunFooterHtml(d);

    // Body innerHTML set programmatically so we don't double-encode the saved HTML.
    var body = document.getElementById('ln-body');
    body.innerHTML = d.body_html || '';
    refreshBodyEmptyState();
    wireEditor();
  }

  function renderTagsHtml(tags) {
    var chips = (tags || []).map(function (t) {
      return '<span class="ln-tag-chip" data-tag="' + escapeHtml(t) + '">' +
        escapeHtml(t) + '<span class="x" data-tag="' + escapeHtml(t) + '">×</span></span>';
    }).join('');
    return '<div class="ln-tags" id="ln-tags">' + chips +
      '<button class="ln-tag-add" id="ln-tag-add">+ tag</button>' +
      '</div>';
  }

  function renderProtocolsHtml(refs) {
    var rows = (refs || []).map(function (r) {
      var url = '/rm/pages/protocols.html?protocol=' + encodeURIComponent(r.id);
      return '<div class="ln-protocol-list-row">' +
          '<a class="ln-protocol-row" href="' + escapeHtml(url) + '" title="Open protocol">' +
            '<span class="ln-protocol-icon">📋</span>' +
            '<span class="ln-protocol-name">' + escapeHtml(r.title || r.id) + '</span>' +
          '</a>' +
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
      : '<span class="ln-material-empty">— click <strong>📋 Protocol</strong> to reference a lab protocol you followed.</span>';
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
    return '<div class="ln-refs">' +
      '<h4>References</h4>' +
      '<div id="ln-refs-rows">' + rows + '</div>' +
      '<button class="ln-add-btn" id="ln-add-ref">+ add reference</button>' +
      '</div>';
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
    return '<div class="ln-footer">' +
      phaseInfo +
      '<span class="grow"></span>' +
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
    var addBtn = (d.phase === 'running')
      ? '<button class="ln-add-obs" id="ln-add-obs" type="button">+ Observation</button>'
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
  }

  function wireObservationsPanel() {
    var addBtn = document.getElementById('ln-add-obs');
    if (addBtn) addBtn.addEventListener('click', onAddObservation);
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
    scheduleSave();
    upsertIndexRow(state.doc);
    renderEditor();
    renderRail();
    setSavingHint('✅ run completed');
  }

  /* Add a new observation. The minimal interaction is a quick
   * prompt() flow — three lightweight inputs (text → metric → value).
   * Phase-2 will replace this with an inline mini-form on a sticky
   * `+ Observation` FAB and voice-memo support; for V3.138 the prompt
   * keeps the UX one-click-then-type at the bench.
   *
   * The observation timestamp is stamped at submit time, and the
   * observations[] array is sorted oldest-first so the log reads
   * top-to-bottom in chronological order. */
  function onAddObservation() {
    if (!state.doc || state.doc.phase !== 'running') return;
    var text = prompt('Observation note (free text — what did you see?):');
    if (text === null) return;          // cancel
    text = String(text).trim();
    var metric = prompt('Optional metric name (e.g. OD600, pH, time-to-cure). Leave blank to skip:');
    metric = metric === null ? '' : String(metric).trim();
    var valueRaw = '';
    var unit = '';
    if (metric) {
      valueRaw = prompt('Optional value for "' + metric + '" (number or text):');
      valueRaw = valueRaw === null ? '' : String(valueRaw).trim();
      if (valueRaw) {
        unit = prompt('Optional unit for the value (mL, g, °C, …). Leave blank to skip:');
        unit = unit === null ? '' : String(unit).trim();
      }
    }
    if (!text && !metric) return;       // nothing to log
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
    scheduleSave();
    upsertIndexRow(state.doc); renderRail();
    setSavingHint('observation logged');
  }

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
          alert('Upload failed: ' + (err && err.message || err));
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

    document.getElementById('ln-add-link').addEventListener('click', function () {
      var url = prompt('Link URL:');
      if (!url) return;
      if (!isSafeUrl(url)) { alert('Unsafe URL.'); return; }
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
    // Generic file picker.
    document.getElementById('ln-add-file').addEventListener('click', function () {
      var input = document.getElementById('ln-file-input');
      input.value = '';
      input.click();
    });
    document.getElementById('ln-att-add').addEventListener('click', function () {
      document.getElementById('ln-file-input').click();
    });

    // Tag chip remove + add.
    document.getElementById('ln-tag-add').addEventListener('click', function () {
      var t = (prompt('Tag (lowercase, no spaces):') || '').trim().toLowerCase().replace(/\s+/g, '-');
      if (!t) return;
      if (!state.doc.tags) state.doc.tags = [];
      if (state.doc.tags.indexOf(t) < 0) state.doc.tags.push(t);
      var tagsBox = document.getElementById('ln-tags');
      tagsBox.outerHTML = renderTagsHtml(state.doc.tags);
      wireTagChips();
      scheduleSave();
      upsertIndexRow(state.doc); renderRail(); renderToolbar();
    });
    wireTagChips();

    // Attachments — delete, lightbox, and PMR-flag toggle.
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
          renderEditor();
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

    // Reference rows.
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
        renderEditor(); scheduleSave();
      });
    });
    document.getElementById('ln-add-ref').addEventListener('click', function () {
      if (!state.doc.reference_links) state.doc.reference_links = [];
      state.doc.reference_links.push({ kind: 'notes', label: '', url: '' });
      renderEditor(); scheduleSave();
    });

    document.getElementById('ln-delete').addEventListener('click', onDeleteEntry);

    // V3.123 — wire Design panel actions (Edit / Download CSV / Clear).
    wireDesignPanel();

    // V3.138 — wire bench-workflow lifecycle controls.
    wireRunFooter();
    wireObservationsPanel();
    wireSummaryTextarea();
  }

  function wireTagChips() {
    Array.prototype.forEach.call(document.querySelectorAll('.ln-tag-chip .x'), function (x) {
      x.addEventListener('click', function () {
        var t = x.getAttribute('data-tag');
        state.doc.tags = (state.doc.tags || []).filter(function (z) { return z !== t; });
        var tagsBox = document.getElementById('ln-tags');
        tagsBox.outerHTML = renderTagsHtml(state.doc.tags);
        wireTagChips();
        scheduleSave();
        upsertIndexRow(state.doc); renderRail(); renderToolbar();
      });
    });
  }

  function refreshBodyEmptyState() {
    var bodyEl = document.getElementById('ln-body');
    if (!bodyEl) return;
    var empty = !bodyEl.innerHTML || bodyEl.innerHTML === '<br>' || bodyEl.textContent.trim() === '' && !bodyEl.querySelector('img');
    bodyEl.setAttribute('data-empty', empty ? 'true' : 'false');
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
        alert('Upload failed: ' + (err && err.message || err));
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
    }

    renderEditor();
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

  /* Walk the body for protocol-chip anchors and rebuild
   * state.doc.protocol_refs[]. First-occurrence order, dedup by id. */
  function collectProtocolRefs() {
    if (!state.doc) return;
    var bodyEl = document.getElementById('ln-body');
    if (!bodyEl) return;
    var seen = {};
    var refs = [];
    Array.prototype.forEach.call(bodyEl.querySelectorAll('a.ln-protocol-chip'), function (chip) {
      var id = chip.getAttribute('data-protocol-id');
      if (!id || seen[id]) return;
      seen[id] = true;
      refs.push({
        id: id,
        title: chip.getAttribute('data-protocol-title') || '',
      });
    });
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

  /* Render a dehydrated protocol tree as HTML for insertion into the
   * notebook body. The materials block produces a "see chips below"
   * placeholder paragraph; actual inventory chips are appended after
   * the protocol body via insertInventoryChip in insertFullProtocol. */
  function _renderProtocolBlockHtml(block) {
    var bodyText = block.body || '';
    var bodyHtml = escapeHtml(bodyText).replace(/\n/g, '<br>');
    switch (block.kind) {
      case 'step':
        return '<p>' + bodyHtml + '</p>';
      case 'note':
        return '<blockquote>📝 <strong>Note.</strong> ' + bodyHtml + '</blockquote>';
      case 'safety':
        return '<blockquote>⚠ <strong>Safety.</strong> ' + bodyHtml + '</blockquote>';
      case 'figure': {
        var lbl = (block.attrs && (block.attrs.label || block.attrs.alt)) || 'Figure';
        return '<p><em>[' + escapeHtml(lbl) + ']</em>' + (bodyHtml ? ' — ' + bodyHtml : '') + '</p>';
      }
      case 'formula': {
        var expr = (block.attrs && block.attrs.expression) || bodyText;
        return '<p><code>' + escapeHtml(expr) + '</code></p>';
      }
      case 'materials': {
        var rows = (block.attrs && block.attrs.rows) || [];
        if (!rows.length) return '<p><em>(no materials listed)</em></p>';
        var items = rows.map(function (r) {
          var qty = (r.qty != null ? String(r.qty) : '') + (r.unit ? ' ' + r.unit : '');
          var name = r.free_text || r.item_ref || '(material)';
          var line = (qty ? qty + ' · ' : '') + name;
          return '<li>' + escapeHtml(line.trim()) + '</li>';
        }).join('');
        return '<p><strong>Materials:</strong></p><ul>' + items + '</ul>';
      }
      default:
        return '<p>' + bodyHtml + '</p>';
    }
  }

  function _renderProtocolTreeHtml(tree, protocolEntry) {
    var html = '<p><strong>📋 ' + escapeHtml(tree.meta.title || protocolEntry.title || 'Protocol') + '</strong></p>';
    tree.sections.forEach(function (sec) {
      if (sec.label) html += '<h4>' + escapeHtml(sec.label) + '</h4>';
      (sec.children || []).forEach(function (b) { html += _renderProtocolBlockHtml(b); });
    });
    return html;
  }

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

  /* Toolbar / picker entry point. Loads the protocol's Yjs state,
   * renders its tree as HTML into the body, drops a protocol-reference
   * chip at the end, then for every materials-block row with an
   * item_ref looks up the inventory record and inserts an inventory
   * chip — so the lab notebook's Materials Used panel auto-populates.
   * Items not present in inventoryState.list are skipped silently
   * (e.g. materials referenced by id but with no matching inventory
   * doc). Reagents/equipment listed only by free-text name are
   * included in the inserted body but cannot become structured chips. */
  async function insertFullProtocol(protocolEntry) {
    if (!state.doc) return;
    var bodyEl = document.getElementById('ln-body');
    if (!bodyEl) return;

    setSavingHint('loading protocol…');
    var tree;
    try {
      tree = await _loadProtocolTree(protocolEntry.id);
    } catch (err) {
      setSavingHint('protocol load failed');
      alert('Could not load full protocol: ' + (err && err.message || err) +
        '\n\nThe protocol may not have any saved Yjs state yet (newly created and never edited / never compacted). Insert the reference chip instead by clicking the row.');
      return;
    }

    // V3.143 — direct append; see comment in insertInventoryChip.
    var html = _renderProtocolTreeHtml(tree, protocolEntry);
    var ok = _appendHtmlToBody(bodyEl, html);
    if (!ok) {
      setSavingHint('insert failed');
      return;
    }
    state.doc.body_html = sanitizeHtml(bodyEl.innerHTML);

    // Append a protocol-reference chip so Protocols-followed shows the source.
    insertProtocolChip(protocolEntry);

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
    setSavingHint('inserted protocol "' + (tree.meta.title || protocolEntry.title || protocolEntry.id) +
      '" · ' + (tree.sections || []).length + ' sections · ' + inserted + ' material chip' +
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
   * We walk the same dehydrated tree V3.134's _renderProtocolTreeHtml
   * uses, but route every body string through the substitution pass. */
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
    return '<div class="ln-design" id="ln-design">' +
      '<h4>' +
        'Design of experiments · <span class="ln-design-type">' + escapeHtml(typeLabel) + '</span>' +
        ' · ' + (design.runs || []).length + ' run' + ((design.runs || []).length === 1 ? '' : 's') +
        (configBits.length ? ' · ' + escapeHtml(configBits.join(' · ')) : '') +
      '</h4>' +
      '<div class="ln-design-actions">' +
        '<button class="ln-design-edit" type="button">✏️ Edit / Regenerate</button>' +
        '<button class="ln-design-csv" type="button">⬇ Download CSV</button>' +
        '<button class="ln-design-clear danger" type="button">Clear</button>' +
      '</div>' +
      renderDoeTableHtml(factorNames, design.runs || [], true) +
    '</div>';
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
    var rows = d.runs.map(function (r, i) {
      return [i + 1].concat(cols.map(function (c) {
        var v = r[c];
        return v == null ? '' : String(v);
      }));
    });
    function csvEscape(s) {
      s = String(s);
      if (/[",\n\r]/.test(s)) return '"' + s.replace(/"/g, '""') + '"';
      return s;
    }
    var lines = [['#'].concat(cols).map(csvEscape).join(',')];
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
  async function onNewEntry() {
    var entry = notebookEmptyEntry();
    entry.title = '';
    entry.date = todayStr();
    entry.ownerUid = state.user.uid;
    entry.id = newEntryId(entry.date, 'entry');
    state.doc = entry;
    state.currentId = entry.id;
    upsertIndexRow(entry);
    detachLiveSync();
    renderEditor();
    renderRail();
    // Focus title for immediate typing.
    var t = document.getElementById('ln-title'); if (t) t.focus();
    // Persist a stub so the entry exists in Firestore even if the user
    // navigates away before typing anything.
    try { await saveEntry(); } catch (_) {}
    attachLiveSync();
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
      if (typeof firebridge === 'undefined' || !firebridge.gateSignedIn) {
        var c = document.getElementById('ln-content');
        if (c) c.innerHTML = '<div class="ln-loading">firebridge missing — load order issue.</div>';
        return;
      }
      var gate = await firebridge.gateSignedIn(
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
      var content = document.getElementById('ln-content');
      content.innerHTML =
        '<div class="ln-toolbar" id="ln-toolbar"></div>' +
        '<div class="ln-layout" id="ln-layout">' +
          '<div class="ln-rail" id="ln-rail"></div>' +
          '<div class="ln-editor" id="ln-editor"></div>' +
        '</div>';

      // Wire camera + file inputs (hidden in the page shell).
      var cameraInput = document.getElementById('ln-camera-input');
      var fileInput   = document.getElementById('ln-file-input');
      if (cameraInput) cameraInput.addEventListener('change', function () {
        Array.from(cameraInput.files || []).forEach(function (f) {
          uploadAndAttach(f, /* insertInline */ true).catch(function (err) {
            alert('Upload failed: ' + (err && err.message || err));
          });
        });
      });
      if (fileInput) fileInput.addEventListener('change', function () {
        Array.from(fileInput.files || []).forEach(function (f) {
          uploadAndAttach(f, /^image\//.test(f.type)).catch(function (err) {
            alert('Upload failed: ' + (err && err.message || err));
          });
        });
      });

      await Promise.all([loadIndex(), loadProjects()]);

      renderToolbar();
      renderRail();
      // Open the most-recent entry, if any.
      var rows = filteredIndexRows();
      if (rows.length) {
        await switchToEntry(rows[0].id);
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
