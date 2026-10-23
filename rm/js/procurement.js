/* ================================================================
   procurement.js — V3.813 (rewrite of the V3.44 page)
   ----------------------------------------------------------------
   Rendering + wiring only. The state machine, validation, patch
   building, inbox logic and report math live in procurement-core.js
   (window.PROC_CORE) so the emulator E2E suite and the node fixtures
   exercise the same code the page runs.

   Rules of this file:
     • NO window.prompt / confirm / alert. Every action opens an inline
       form inside the ticket's own card; errors render beside the field.
     • Every Firestore write goes through writeTicket() / createTicket()
       which wrap the core's `appends` in arrayUnion, invalidate the
       route cache (the SHORT-cached list would otherwise serve the
       pre-write state) and suppress the live-sync echo.
     • Renders are deferred while an input inside the page has focus —
       a live-sync refresh must never wipe a half-typed form. The search
       box, status and sort selects live OUTSIDE #pt-body and only
       re-render the body, so they keep focus.

   URL params: ?ticket=ID (open one) · ?view=inbox|active|mine|archive|report
               ?new=1 (open composer) · ?reorder=INVENTORY_ID (composer
               prefilled from the inventory item — the "Request reorder"
               button on inventory.html lands here)

   V3.814: the composer asks one-time vs recurring and carries an optional
   price-comparison block with "Download AI prompt" (a .txt the person pastes
   into their own AI) and "Import AI results" (an inline paste box; the JSON
   fills the rows and the main fields). "Request again" on a finished ticket
   reopens the composer prefilled from it. Approvers get "Change funding" at
   every live stage; the function tells the requester.

   V3.816: two doors. "Reorder existing" opens a picker over the catalogue
   (inventory ∪ tickets that reached approval — C.catalogue) with search,
   category / vendor / stock / source filters, group-by and sort; picking a
   row opens the COMPACT reorder form (item details + comparison folded under
   a <details>). "New item" opens the full form. ?pick=1 opens the picker.

   V3.820: a price with a page is an observation on priceWatch/{watchIdFor(url)}
   (recordObservations after a submit; the extension writes captures and the
   quarterly re-scrape). Cards show a Price watch row; catalogue rows show
   "list $X (checked …)" beside the last paid price.

   V3.819: the Chrome extension's "+ Item" writes a capture to the person's
   own userData/{uid}/procurementCaptures. A strip above the composer lists
   unused captures; "Add to request" (or ?capture=ID from the extension)
   opens the full New-item form prefilled from it; submitting marks the
   capture used. Nothing reaches the catalogue until the ticket is approved.
   ================================================================ */
(function () {
  'use strict';

  var C = window.PROC_CORE;
  var root = document.getElementById('proc-root');
  if (!root || !C) { console.warn('[procurement] missing #proc-root or PROC_CORE'); return; }

  var VIEWS = [
    { key: 'inbox',   label: 'Inbox' },
    { key: 'active',  label: 'Active' },
    { key: 'mine',    label: 'Mine' },
    { key: 'archive', label: 'Archive' },
    { key: 'docs',    label: 'Receipts', gate: function () { return canFileDocs(); } },   // V3.881
    { key: 'report',  label: 'Report', gate: function () { return S.actor && (S.actor.canApprove || S.actor.canOrder); } },
  ];

  /* ─── State ─────────────────────────────────────────────── */
  var S = {
    user: null, profile: null, actor: null,
    tickets: [], users: [], fundedProjects: [], boxes: [], items: null,
    view: 'inbox', q: '', status: '', sort: 'updated',
    expanded: {},                // id → true
    form: null,                  // { id, action, values, error, field, busy, picked }
    composer: null,              // { values, error, field, busy, reorderOf, item, againOf }
    picker: null,                // V3.816 — { q, category, vendor, stock, kind, group, sort } while "Reorder existing" is open
    pickerEntries: [],           // the catalogue rows last rendered (what a Reorder click refers to)
    captures: [],                // V3.819 — this person's unused browser-extension captures (userData/{uid}/procurementCaptures)
    pendingCapture: null,        // capture id from ?capture=
    watches: [],                 // V3.820 — priceWatch docs: a list price per product URL, re-checked every 3 months by the extension
    report: { from: '', to: '', init: false },
    drafts: {},                  // 'ticketId:action' → { values, picked } — typed text survives switching forms
    live: null, deferred: false, loaded: false, loadError: null,
    pendingOpen: null,           // ticket id from ?ticket=
    docs: [],                    // V3.881 — procurementDocs: receipts, requisitions, invoices… (newest first)
    docUp: null,                 // V3.881 — the Receipts tab's upload form { files, kind, poNumber, vendor, docDate, note, sel, q, busy, error }
    docEdit: null,               // V3.881 — { id, values, sel, q, busy, error } while one document is edited
    docDel: null,                // V3.881 — the document id waiting on "Delete? / Keep it"
    attach: null,                // V3.881 — { id: ticketId, kind, files, note, linkSiblings, busy, error, progress } on a request card
  };

  /* ─── Small helpers ─────────────────────────────────────── */
  // Quotes too: esc() output lands inside value="…" and href="…" as well as
  // text, and a textContent→innerHTML round trip leaves " alone (found by the
  // V3.813 integration review: a product link could break out of its attribute).
  var ESC = { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' };
  function esc(s) { if (s == null) return ''; return String(s).replace(/[&<>"']/g, function (c) { return ESC[c]; }); }
  function icon(name) { return (window.ICON && ICON.svg) ? ICON.svg(name) : ''; }
  function db() { return (typeof firebridge !== 'undefined' && firebridge.db) ? firebridge.db() : firebase.firestore(); }
  function FV() { return firebase.firestore.FieldValue; }
  function stampNow() { return FV().serverTimestamp(); }
  function toast(msg, kind, detail) {
    if (window.TOAST) { (TOAST[kind === 'error' ? 'error' : kind === 'warn' ? 'warn' : kind === 'info' ? 'info' : 'success'])(msg, detail ? { detail: detail } : undefined); return; }
    console.log('[procurement] ' + msg);
  }
  function suppress(ms) { if (S.live) S.live.suppressUntil = Date.now() + (ms || 3000); }
  function userName(uid) {
    if (!uid) return '';
    var u = S.users.find(function (x) { return (x.id || x.uid) === uid; });
    return u ? (u.name || u.displayName || u.email || uid) : uid.slice(0, 6) + '…';
  }
  function ticketById(id) { return S.tickets.find(function (t) { return t.id === id; }); }
  function $(sel, el) { return (el || root).querySelector(sel); }
  function $$(sel, el) { return Array.prototype.slice.call((el || root).querySelectorAll(sel)); }
  function opt(value, label, selected) { return '<option value="' + esc(value) + '"' + (selected ? ' selected' : '') + '>' + esc(label) + '</option>'; }
  function ticketUrl(id) { return '/rm/pages/procurement.html?ticket=' + encodeURIComponent(id); }
  /* V3.881 — who files documents from the Receipts tab and a request's Attach: purchasers, approvers, admins. */
  function canFileDocs() { return !!(S.actor && (S.actor.canOrder || S.actor.canApprove)); }
  function viewAllowed(key) { var v = VIEWS.find(function (x) { return x.key === key; }); return !!v && (!v.gate || v.gate()); }

  /* ─── Boot ──────────────────────────────────────────────── */
  (async function boot() {
    if (typeof firebridge === 'undefined') { root.innerHTML = '<div class="empty-state">Sign-in bridge not loaded.</div>'; return; }
    if (firebridge.requireSignIn) await firebridge.requireSignIn('Sign in to use procurement.');
    // hasCapability() is sync — the grant must be loaded before the first
    // render or every approver/purchaser affordance renders as absent.
    if (firebridge.loadAccessGrant) { try { await firebridge.loadAccessGrant(); } catch (e) { /* no grant */ } }
    S.user = firebridge.getUser ? firebridge.getUser() : null;
    S.profile = firebridge.getProfile ? firebridge.getProfile() : null;
    if (!S.user) return;
    S.actor = C.actorFrom(S.user, S.profile, firebridge.hasCapability);
    parseUrl();

    try { await loadAndRender(); }
    catch (err) {
      console.warn('[procurement] initial load failed:', err);
      S.loadError = err && err.message || String(err);
      root.innerHTML = '<div class="empty-state">Failed to load procurement — ' + esc(S.loadError) + '</div>';
      return;
    }

    if (typeof LIVE_SYNC !== 'undefined' && LIVE_SYNC.attach) {
      S.live = LIVE_SYNC.attach({ paths: ['procurement/tickets.json', 'lab/users.json'], refresh: loadAndRender, tag: 'procurement' });
    }
    if (firebridge.onAuth) {
      firebridge.onAuth(function () {
        var prev = S.profile && S.profile.role;
        S.user = firebridge.getUser ? firebridge.getUser() : S.user;
        S.profile = firebridge.getProfile ? firebridge.getProfile() : S.profile;
        S.actor = C.actorFrom(S.user, S.profile, firebridge.hasCapability);
        if ((S.profile && S.profile.role) !== prev) render(true);
      });
    }
    if (S.composer && S.composer.reorderOf) await prefillReorder(S.composer.reorderOf);
  })();

  function parseUrl() {
    var p = new URLSearchParams(location.search);
    if (p.get('view') && viewAllowed(p.get('view'))) S.view = p.get('view');
    if (p.get('status') && C.STATUS[p.get('status')]) S.status = p.get('status');   // the daily sweep links ?view=active&status=ordered
    if (p.get('q')) S.q = p.get('q');
    if (p.get('ticket')) { S.pendingOpen = p.get('ticket'); S.expanded[p.get('ticket')] = true; }
    if (p.get('new') === '1') S.composer = { values: {}, error: null, busy: false };
    if (p.get('reorder')) S.composer = { values: {}, error: null, busy: false, reorderOf: p.get('reorder') };
    if (p.get('pick') === '1') S.picker = defaultPicker();   // V3.816 — open "Reorder existing"
    if (p.get('capture')) S.pendingCapture = p.get('capture');   // V3.819 — the extension's "Finish the request" link
  }
  function defaultPicker() { return { q: '', category: '', vendor: '', stock: '', kind: '', group: 'category', sort: 'name' }; }

  /* ─── Data ──────────────────────────────────────────────── */
  async function loadAndRender() {
    var quiet = function (p) { return p.catch(function (e) { console.warn('[procurement] optional load failed:', e && e.message); return null; }); };
    var res = await Promise.all([
      api.load('procurement/tickets.json'),
      quiet(api.load('lab/users.json')),
      quiet(db().collection('labConfig').doc('fundingSources').get()),
      quiet(db().collection('labConfig').doc('fundedProjects').get()),
      quiet(db().collection('inventoryLocations').get()),
      quiet(capturesRef().get()),   // V3.819 — owner-only subcollection; a guest or a rules refusal just yields none
      quiet(db().collection('priceWatch').get()),   // V3.820 — lab-wide, small (one doc per product page ever priced)
      // V3.881 — receipts, requisitions… (inside a then, so even a synchronous throw only costs this list, never the page)
      quiet(Promise.resolve().then(function () { return db().collection('procurementDocs').orderBy('uploadedAt', 'desc').limit(500).get(); })),
    ]);
    if (res[7]) S.docs = res[7].docs.map(function (d) { return Object.assign({ id: d.id }, d.data()); });
    S.watches = res[6] ? res[6].docs.map(function (d) { return Object.assign({ id: d.id }, d.data()); }) : [];
    S.captures = res[5] ? res[5].docs.map(function (d) { return Object.assign({ id: d.id }, d.data()); })
      .filter(function (c) { return c.status !== 'used' && c.status !== 'discarded'; })
      .sort(function (a, b) { return C.toMs(b.capturedAtIso) - C.toMs(a.capturedAtIso); }) : [];
    S.tickets = ((res[0] && res[0].tickets) || []).map(function (t) { return Object.assign({ status: 'requested' }, t); });
    var allUsers = (res[1] && res[1].users) || [];
    S.users = (window.LAB_USERS && LAB_USERS.isVisible) ? allUsers.filter(function (u) { return LAB_USERS.isVisible(u); }) : allUsers;
    var srcDoc = res[2], fpDoc = res[3];
    var sources = (srcDoc && srcDoc.exists && (srcDoc.data().sources || srcDoc.data().fundingSources)) || [];
    // Funded projects (published from Grant Accounts) decide the funding string;
    // the legacy fundingSources list stands in until an admin has published.
    S.fundedProjects = C.fundedProjectOptions((fpDoc && fpDoc.exists && fpDoc.data().projects) || [], sources);
    S.boxes = res[4] ? res[4].docs.map(function (d) { return Object.assign({ id: d.id }, d.data()); }) : [];
    S.loaded = true;
    if (S.pendingCapture) {   // V3.819 — arrived from the extension's "Finish the request" link
      var want = S.pendingCapture; S.pendingCapture = null;
      var cap = S.captures.find(function (c) { return c.id === want; });
      if (cap) { S.composer = null; render(true); startFromCapture(cap); return; }
      var usedDoc = res[5] && res[5].docs.find(function (d) { return d.id === want; });
      var used = usedDoc && usedDoc.data();
      if (used && used.ticketId && ticketById(used.ticketId)) { S.expanded[used.ticketId] = true; var ut = ticketById(used.ticketId); S.view = C.isActive(ut) ? 'mine' : 'archive'; render(true); toast('That captured item is already a request', 'info'); return; }
      render(true);
      toast(used ? 'That captured item was already used' : 'That captured item is not in your queue — it may have been discarded, or captured under another account', 'warn');
      return;
    }
    if (S.pendingOpen) {
      var want = S.pendingOpen; S.pendingOpen = null;
      var t = ticketById(want);
      if (!t) {   // a notification link to a deleted ticket must not take the page down
        delete S.expanded[want];
        render(true);
        toast('That ticket no longer exists — it may have been deleted', 'warn');
        return;
      }
      S.view = C.isActive(t) ? (C.isMine(t, S.actor.uid) ? 'mine' : 'active') : 'archive';
      render(true);
      var row = $('[data-id="' + t.id + '"]'); if (row && row.scrollIntoView) row.scrollIntoView({ block: 'start', behavior: 'smooth' });
      return;
    }
    render();
  }

  async function ensureInventory() {
    if (S.items) return S.items;
    try { var d = await api.load('inventory/items.json'); S.items = (d && d.items) || []; }
    catch (e) { console.warn('[procurement] inventory load failed:', e); S.items = []; }
    return S.items;
  }

  async function prefillReorder(invId) {
    var items = await ensureInventory();
    var item = items.find(function (i) { return i.id === invId; });
    if (!item) { toast('Inventory item not found — starting a blank request', 'warn'); S.composer = { values: {}, error: null, busy: false }; render(true); return; }
    var pre = C.prefillFromInventory(item);
    var pm = C.projectForAccount(S.fundedProjects, item.account_number) || (item.project_tag && S.fundedProjects.find(function (o) { return o.id === item.project_tag; }));
    if (pm) C.applyProject(pre, S.fundedProjects, pm.id);
    S.composer = { values: pre, error: null, busy: false, reorderOf: invId, item: item };
    S.picker = null;
    render(true);
    var box = $('#pt-composer-form'); if (box && box.scrollIntoView) box.scrollIntoView({ block: 'start', behavior: 'smooth' });
    var el = $('#pt-f-quantity'); if (el) el.focus();
  }
  /* ─── Price watch (V3.820) ──────────────────────────────── */
  /** A request's link + unit cost (and each priced comparison row) becomes an
   * observation on that page's watch: created here, appended otherwise. The
   * extension's quarterly re-scrape owns the schedule; a typed price never
   * moves it. Non-fatal: the ticket is already written. */
  async function recordObservations(obs) {
    if (!obs || !obs.length || !S.user) return;
    var now = new Date().toISOString();
    for (var i = 0; i < obs.length; i++) {
      var o = obs[i];
      try {
        var ref = db().collection('priceWatch').doc(o.id);
        var snap = await ref.get();
        var entry = { at: now, price: o.price, method: 'request', by: S.user.uid };
        var local = S.watches.find(function (w) { return w.id === o.id; });
        if (snap.exists) {
          var patch = { latest: entry, history: FV().arrayUnion(entry), lastActorUid: S.user.uid, updatedAt: now };
          if (o.ticketId) patch.ticketIds = FV().arrayUnion(o.ticketId);
          await ref.update(patch);
          if (local) { local.latest = entry; local.history = (local.history || []).concat([entry]); if (o.ticketId) local.ticketIds = (local.ticketIds || []).concat([o.ticketId]); }
          else S.watches.push(Object.assign({ id: o.id }, snap.data(), { latest: entry, history: (snap.data().history || []).concat([entry]) }));
        } else {
          var docData = C.newWatchDoc(o, now, S.user.uid);
          await ref.set(docData);
          S.watches.push(Object.assign({ id: o.id }, docData));
        }
      } catch (e) { console.warn('[procurement] price watch not recorded:', e && e.message); }
    }
  }
  function watchRowHTML(url) {
    var w = C.watchSummary(C.watchFor(S.watches, url));
    if (!w) return '';
    var hist = (C.watchFor(S.watches, url).history || []).slice(-4).map(function (h) { return esc(C.fmtMoney(h.price)) + ' <span class="pt-muted">(' + esc(C.fmtDateLong(h.at)) + ')</span>'; }).join(' → ');
    return '<strong>' + esc(C.fmtMoney(w.price)) + '</strong> list price <span class="pt-muted">· checked ' + esc(C.fmtDateLong(w.at)) + ' · ' + w.checks + ' check' + (w.checks === 1 ? '' : 's') +
      (w.status === 'error' ? ' · <span class="pt-flag pt-flag--late">page could not be read lately</span>' : (w.nextCheckAt ? ' · next ' + esc(C.fmtDateLong(w.nextCheckAt)) : '')) + '</span>' +
      (w.checks > 1 ? '<div class="pt-watch-hist">' + hist + '</div>' : '');
  }

  /* ─── Browser-extension captures (V3.819) ──────────────── */
  function capturesRef() { return db().collection('userData').doc(S.user.uid).collection('procurementCaptures'); }
  function renderCaptures() {
    var box = $('#pt-captures'); if (!box) return;
    if (!S.captures.length) { box.innerHTML = ''; return; }
    box.innerHTML =
      '<section class="pt-card pt-captures" id="pt-captures-card" aria-label="Items captured in your browser">' +
        '<div class="pt-card-head"><h2 class="pt-h2">' + icon('globe-alt') + ' Captured in your browser <span class="pt-tab-n">' + S.captures.length + '</span></h2></div>' +
        '<p class="pt-muted">Items you added with the McGhee Lab Capture extension. Add one to a request to finish it here; it joins the item catalogue only once the request is approved.</p>' +
        '<div class="pt-cap-rows">' + S.captures.map(function (c) {
          var price = typeof c.price === 'number' ? C.fmtMoney(c.price) : C.str(c.priceText);
          var bits = [c.vendor, c.catalogueNumber, price, c.quantity && c.quantity !== 1 ? c.quantity + '×' : '', c.packSize].filter(Boolean).map(esc);
          var host = C.str(c.sourceHost).replace(/^www\./, '');
          return '<div class="pt-cap-row" data-cap="' + esc(c.id) + '">' +
            '<div class="pt-pk-main"><div class="pt-pk-name">' + (c.url ? '<a href="' + esc(c.url) + '" target="_blank" rel="noopener">' + esc(c.name) + '</a>' : esc(c.name)) + '</div>' +
              '<div class="pt-pk-meta">' + bits.join(' · ') + (host ? (bits.length ? ' · ' : '') + 'from ' + esc(host) : '') + (c.capturedAtIso ? ' · ' + esc(C.ageLabel(c.capturedAtIso)) : '') + (c.note ? '<br>' + esc(c.note) : '') + '</div></div>' +
            '<span class="pt-cap-btns"><button type="button" class="btn btn-sm btn-primary" data-cap-use="' + esc(c.id) + '">' + icon('plus') + ' Add to request</button>' +
            '<button type="button" class="btn btn-sm pt-btn-ghost" data-cap-drop="' + esc(c.id) + '">Discard</button></span>' +
          '</div>';
        }).join('') + '</div>' +
      '</section>';
    $$('[data-cap-use]', box).forEach(function (b) { b.addEventListener('click', function () { var c = S.captures.find(function (x) { return x.id === b.dataset.capUse; }); if (c) startFromCapture(c); }); });
    $$('[data-cap-drop]', box).forEach(function (b) { b.addEventListener('click', async function () {
      var id = b.dataset.capDrop; b.disabled = true;
      try { await capturesRef().doc(id).delete(); } catch (e) { toast('Could not discard it: ' + (e && e.message || e), 'error'); b.disabled = false; return; }
      S.captures = S.captures.filter(function (x) { return x.id !== id; });
      if (S.composer && S.composer.captureOf && S.composer.captureOf.id === id) { S.composer = null; renderComposer(); }
      renderCaptures(); toast('Discarded');
    }); });
  }
  /** The New-item composer, prefilled from a capture (the full form — project, why and the rest are still to fill in). */
  function startFromCapture(c) {
    var pre = C.prefillFromCapture(c);
    S.composer = { values: pre, error: null, busy: false, captureOf: c };
    S.picker = null;
    renderPicker(); renderComposer();
    var box = $('#pt-composer-form'); if (box) { box.scrollIntoView({ block: 'start', behavior: 'smooth' }); var pf = $('#pt-f-projectId'); if (pf) pf.focus(); }
  }
  /** After the ticket is written: the capture is spent, nothing else changes until approval. */
  async function markCaptureUsed(c, ticketId) {
    try { await capturesRef().doc(c.id).update({ status: 'used', ticketId: ticketId, usedAtIso: new Date().toISOString() }); }
    catch (e) { console.warn('[procurement] could not mark the capture used:', e && e.message); }
    S.captures = S.captures.filter(function (x) { return x.id !== c.id; });
    renderCaptures();
  }

  /** V3.816 — "Request again" / a ticket-only catalogue row: the composer prefilled from a ticket. */
  function startRepeat(t) {
    var pre = C.prefillFromTicket(t);
    if (!pre.projectId && pre.fundingAccount) { var pma = C.projectForAccount(S.fundedProjects, pre.fundingAccount); if (pma) pre.projectId = pma.id; }
    if (!pre.projectId && pre.project) { pre.projectId = '__other'; pre.projectOther = pre.project; }
    S.composer = { values: pre, error: null, busy: false, againOf: t, reorderOf: t.inventoryItemId || null };
    S.picker = null;
    renderPicker(); renderComposer();
    var box = $('#pt-composer-form'); if (box) { box.scrollIntoView({ block: 'start', behavior: 'smooth' }); var qf = $('#pt-f-quantity'); if (qf) qf.focus(); }
  }

  /* ─── Writes ────────────────────────────────────────────── */
  function applyStampsLocally(obj, patch, stamp) {
    Object.keys(patch).forEach(function (k) { obj[k] = (patch[k] === stamp) ? new Date() : patch[k]; });
  }

  async function createTicket(values, extra) {
    var stamp = stampNow();
    var r = C.buildCreate(values, S.actor, Date.now(), stamp, extra);
    if (r.error) return r;
    suppress();
    var ref = await db().collection('procurementTickets').add(r.data);
    await api.invalidate('procurement/tickets.json');
    var local = Object.assign({ id: ref.id }, r.data);
    applyStampsLocally(local, { createdAt: stamp, updatedAt: stamp }, stamp);
    S.tickets.unshift(local);
    return { ticket: local };
  }

  /** Mirror a core patch into the in-memory ticket (after the server accepted it). */
  function mirrorTicket(t, r, stamp) {
    var ap = r.appends || { history: [], notes: [], watcherUids: [] };
    applyStampsLocally(t, r.patch, stamp);
    t.history = (t.history || []).concat(ap.history);
    t.notes = (t.notes || []).concat(ap.notes);
    t.watcherUids = (t.watcherUids || []).slice();
    ap.watcherUids.forEach(function (u) { if (t.watcherUids.indexOf(u) < 0) t.watcherUids.push(u); });
  }
  /** Apply a core patch to one ticket: arrayUnion the appends, write, mirror locally.
   * In batch mode nothing is mirrored here — the caller gets a function to run
   * AFTER batch.commit() resolves, so a refused commit leaves the cards truthful. */
  async function writeTicket(t, r, stamp, batch) {
    var patch = Object.assign({}, r.patch);
    var ap = r.appends || { history: [], notes: [], watcherUids: [] };
    if (ap.history.length)     patch.history     = FV().arrayUnion.apply(null, ap.history);
    if (ap.notes.length)       patch.notes       = FV().arrayUnion.apply(null, ap.notes);
    if (ap.watcherUids.length) patch.watcherUids = FV().arrayUnion.apply(null, ap.watcherUids);
    var ref = db().collection('procurementTickets').doc(t.id);
    if (batch) { batch.update(ref, patch); return function () { mirrorTicket(t, r, stamp); }; }
    suppress(); await ref.update(patch);
    mirrorTicket(t, r, stamp);
  }

  /* V3.881 — every file the page uploads (Receipts tab, a request's Attach, the
   * Order form's PO, the Receive form's receipt) goes to procurement/docs/{id}/
   * and gets a procurementDocs record, the one list a later step reads into the
   * inventory. The content type is told to Storage explicitly: a phone's HEIC
   * photo often arrives typeless, and storage.rules accepts only PDF / image/*.
   * meta: { kind, ticketIds, poNumber, vendor, docDate, note, source, keepFileOnFail }
   * → { url, path, id } (id null + recordError when the record failed and the file was kept). */
  async function uploadDoc(file, meta) {
    meta = meta || {};
    var chk = C.checkDocFile(file);
    if (chk.error) throw new Error(chk.error);
    if (typeof firebase === 'undefined' || !firebase.storage) throw new Error('Firebase Storage not loaded');
    var ref = db().collection('procurementDocs').doc();
    var path = C.docStoragePath(ref.id, file.name);
    var sref = firebase.storage().ref().child(path);
    var snap = await sref.put(file, { contentType: chk.contentType });
    var url = await snap.ref.getDownloadURL();
    var rec = C.buildDocRecord({ id: ref.id, kind: meta.kind, file: file, contentType: chk.contentType, url: url, ticketIds: meta.ticketIds,
      poNumber: meta.poNumber, vendor: meta.vendor, docDate: meta.docDate, note: meta.note, source: meta.source, actor: S.actor, stamp: stampNow(), tickets: S.tickets });
    try { await ref.set(rec); }
    catch (err) {
      if (meta.keepFileOnFail) return { url: url, path: path, id: null, recordError: err };
      try { await sref.delete(); } catch (e) { /* storage.rules has no delete path; the orphan is harmless */ }
      throw err;
    }
    var nowIso = new Date().toISOString();
    S.docs.unshift(Object.assign({ id: ref.id }, rec, { uploadedAt: nowIso, updatedAt: nowIso }));
    return { url: url, path: path, id: ref.id };
  }

  /* ─── Render: deferral while typing ─────────────────────── */
  function isTyping() {
    var ae = document.activeElement;
    if (!ae || !root.contains(ae)) return false;
    if (!/^(INPUT|TEXTAREA|SELECT)$/.test(ae.tagName)) return false;
    return !/^(checkbox|radio|file|button|submit)$/.test(ae.type || '');
  }
  root.addEventListener('focusout', function () {
    setTimeout(function () { if (S.deferred && !isTyping()) render(); }, 80);
  });

  function render(force) {
    if (!force && isTyping()) { S.deferred = true; return; }
    S.deferred = false;
    if (!S.loaded) return;
    var c = C.counts(S.tickets, S.actor.uid);
    var inbox = C.inboxFor(S.tickets, S.actor);
    var inboxN = inbox.reduce(function (n, s) { return n + (s.key === 'mine' ? 0 : s.items.length); }, 0);
    var tabs = VIEWS.filter(function (v) { return !v.gate || v.gate(); }).map(function (v) {
      var n = v.key === 'inbox' ? inboxN : v.key === 'active' ? c.active : v.key === 'mine' ? c.mine : v.key === 'archive' ? c.archive : null;
      return '<button type="button" class="pt-tab' + (S.view === v.key ? ' is-active' : '') + '" data-view="' + v.key + '">' +
        esc(v.label) + (n != null ? ' <span class="pt-tab-n">' + n + '</span>' : '') + '</button>';
    }).join('');
    var statusOpts = opt('', 'Any status', !S.status) + C.STATUS_IDS.map(function (s) { return opt(s, C.STATUS[s].label + ' (' + (c[s] || 0) + ')', S.status === s); }).join('');
    var sortOpts = [['updated', 'Latest activity'], ['created', 'Newest request'], ['urgency', 'Most urgent'], ['cost', 'Highest cost'], ['status', 'By stage']]
      .map(function (p) { return opt(p[0], p[1], S.sort === p[0]); }).join('');

    root.innerHTML =
      '<div class="pt-top">' +
        '<div class="pt-tabs" role="tablist">' + tabs + '</div>' +
        '<div class="pt-tools">' +
          '<label class="pt-search">' + icon('magnifying-glass') + '<input type="search" id="pt-q" placeholder="Search item, vendor, person, PO…" value="' + esc(S.q) + '" aria-label="Search tickets"></label>' +
          '<select id="pt-status" aria-label="Filter by status">' + statusOpts + '</select>' +
          '<select id="pt-sort" aria-label="Sort">' + sortOpts + '</select>' +
          // V3.816 — two doors: reorder something the lab already buys, or describe a new item in full.
          '<button type="button" class="btn pt-new pt-new--reorder" id="pt-reorder">' + icon('arrow-path') + ' Reorder existing</button>' +
          '<button type="button" class="btn btn-primary pt-new" id="pt-new">' + icon('plus') + ' New item</button>' +
        '</div>' +
      '</div>' +
      '<div id="pt-picker"></div>' +
      '<div id="pt-captures"></div>' +
      '<div id="pt-composer"></div>' +
      '<div id="pt-body"></div>';

    $$('[data-view]').forEach(function (b) { b.addEventListener('click', function () { S.view = b.dataset.view; renderAll(); }); });
    $('#pt-q').addEventListener('input', function (e) { S.q = e.target.value; renderBody(); });
    $('#pt-status').addEventListener('change', function (e) { S.status = e.target.value; renderBody(); });
    $('#pt-sort').addEventListener('change', function (e) { S.sort = e.target.value; renderBody(); });
    $('#pt-new').addEventListener('click', function () {
      // A prefilled reorder form is not "a new item": start a blank one in its place.
      if (!S.composer || S.composer.reorderOf || S.composer.againOf) { S.composer = { values: {}, error: null, busy: false }; renderComposer(); }
      var el = $('#pt-f-itemDescription'); if (el) { el.focus(); el.scrollIntoView({ block: 'center', behavior: 'smooth' }); }
    });
    $('#pt-reorder').addEventListener('click', function () {
      if (!S.picker) S.picker = defaultPicker();
      renderPicker();
      var q = $('#pt-pk-q'); if (q) { q.focus(); q.scrollIntoView({ block: 'center', behavior: 'smooth' }); }
    });
    renderPicker();
    renderCaptures();
    renderComposer();
    renderBody();
  }

  /* ─── Reorder picker (V3.816) ───────────────────────────── */
  function renderPicker() {
    var box = $('#pt-picker'); if (!box) return;
    if (!S.picker) { box.innerHTML = ''; return; }
    var pk = S.picker;
    var had = $('#pt-pk-q'), hadFocus = had && document.activeElement === had, hadValue = had ? had.value : pk.q;
    var all = S.items ? C.catalogue(S.items, S.tickets, S.watches) : [];
    var facets = C.catalogueFacets(all);
    var sel = function (key, label, options) {
      return '<label>' + esc(label) + '<select data-pk="' + key + '" aria-label="' + esc(label) + '">' + options.map(function (o) { return opt(o[0], o[1], pk[key] === o[0]); }).join('') + '</select></label>';
    };
    box.innerHTML =
      '<section class="pt-card pt-picker" id="pt-picker-card" aria-label="Reorder an existing item">' +
        '<div class="pt-card-head"><h2 class="pt-h2">' + icon('arrow-path') + ' Reorder an existing item</h2>' +
          '<button type="button" class="pt-x" id="pt-picker-close" aria-label="Close">' + icon('x-mark') + '</button></div>' +
        '<p class="pt-muted">Everything in Inventory, plus anything the lab has bought through procurement before. Pick one and the request is prefilled — you only confirm the quantity, the project and why.</p>' +
        '<div class="pt-picker-bar">' +
          '<label class="pt-search">' + icon('magnifying-glass') + '<input type="search" id="pt-pk-q" placeholder="Search name, vendor, catalogue #, location, project…" value="' + esc(hadValue) + '" aria-label="Search existing items"></label>' +
          sel('category', 'Category', [['', 'All categories (' + facets.total + ')']].concat(facets.categories.map(function (c) { return [c.id, c.label + ' (' + c.n + ')']; }))) +
          sel('vendor', 'Vendor', [['', 'All vendors']].concat(facets.vendors.map(function (v) { return [v.id, v.label + ' (' + v.n + ')']; }))) +
          sel('stock', 'Stock', [['', 'Any stock'], ['low', 'Low or out (' + facets.low + ')']]) +
          sel('kind', 'Source', [['', 'Inventory + past orders'], ['inventory', 'In Inventory (' + facets.inventory + ')'], ['ticket', 'Bought before, not in Inventory (' + facets.tickets + ')']]) +
          sel('group', 'Group by', [['category', 'Category'], ['vendor', 'Vendor'], ['location', 'Location'], ['none', 'No grouping']]) +
          sel('sort', 'Sort', [['name', 'Name'], ['recent', 'Recently bought'], ['often', 'Most often bought'], ['stock', 'Lowest stock first']]) +
        '</div>' +
        '<div id="pt-pk-results"></div>' +
      '</section>';
    $('#pt-picker-close').addEventListener('click', function () { S.picker = null; renderPicker(); });
    var q = $('#pt-pk-q');
    q.addEventListener('input', function () { pk.q = q.value; renderPickerResults(); });
    $$('[data-pk]', box).forEach(function (s) { s.addEventListener('change', function () { pk[s.dataset.pk] = s.value; renderPickerResults(); }); });
    box.addEventListener('keydown', function (e) { if (e.key === 'Escape') { S.picker = null; renderPicker(); } });
    if (hadFocus) { q.focus(); try { q.setSelectionRange(q.value.length, q.value.length); } catch (e) {} }
    if (!S.items) ensureInventory().then(function () { if (S.picker) renderPicker(); });   // the facets need the inventory: rebuild once it lands
    renderPickerResults();
  }
  function renderPickerResults() {
    var res = $('#pt-pk-results'); if (!res || !S.picker) return;
    if (!S.items) { res.innerHTML = '<div class="pt-muted">Loading inventory…</div>'; return; }
    var pk = S.picker;
    var all = C.catalogue(S.items, S.tickets, S.watches);
    var list = C.filterCatalogue(all, pk);
    var capped = list.length > 200; if (capped) list = list.slice(0, 200);
    S.pickerEntries = list;
    var filtering = !!(pk.q || pk.category || pk.vendor || pk.stock || pk.kind);
    var count = '<div class="pt-pk-count"><span>' + list.length + ' of ' + all.length + ' item' + (all.length === 1 ? '' : 's') + (capped ? ' · showing the first 200 — narrow the search' : '') + '</span>' +
      (filtering ? '<button type="button" class="pt-link" data-pk-clear>Clear filters</button>' : '') + '</div>';
    if (!list.length) {
      res.innerHTML = count + '<div class="empty-state">' + (all.length ? 'Nothing matches.' : 'Nothing in Inventory yet and nothing bought before.') + ' Use <strong>New item</strong> for something the lab has not bought before.</div>';
    } else {
      res.innerHTML = count + C.groupCatalogue(list, pk.group).map(function (g) {
        return '<div class="pt-pk-group"><div class="pt-pk-head">' + esc(g.label) + ' <span class="pt-tab-n">' + g.items.length + '</span></div>' + g.items.map(entryRowHTML).join('') + '</div>';
      }).join('');
    }
    var clear = $('[data-pk-clear]', res);
    if (clear) clear.addEventListener('click', function () { pk.q = ''; pk.category = ''; pk.vendor = ''; pk.stock = ''; pk.kind = ''; renderPicker(); var q = $('#pt-pk-q'); if (q) q.focus(); });
    $$('[data-pick-entry]', res).forEach(function (b) { b.addEventListener('click', function () { pickEntry(b.dataset.pickEntry); }); });
  }
  function entryRowHTML(e) {
    var badges = '';
    if (e.recurring) badges += '<span class="pt-pk-badge pt-pk-badge--rec">recurring</span>';
    if (e.stock === 'out_of_stock') badges += '<span class="pt-pk-badge pt-pk-badge--out">out of stock</span>';
    else if (e.stock === 'low') badges += '<span class="pt-pk-badge pt-pk-badge--low">low</span>';
    if (e.kind === 'ticket') badges += '<span class="pt-pk-badge pt-pk-badge--tkt">not in inventory' + (e.status && e.status !== 'placed' ? ' · ' + esc((C.STATUS[e.status] || {}).label || e.status).toLowerCase() : '') + '</span>';
    var bits = [];
    if (e.vendor) bits.push(esc(e.vendor) + (e.catalogueNumber ? ' · ' + esc(e.catalogueNumber) : ''));
    else if (e.catalogueNumber) bits.push(esc(e.catalogueNumber));
    if (e.lastPrice) bits.push('last paid ' + esc(C.fmtMoney(e.lastPrice)));
    if (e.watchPrice != null) bits.push('list ' + esc(C.fmtMoney(e.watchPrice)) + ' <span title="re-checked every three months by the Chrome extension">(checked ' + esc(C.fmtDateLong(e.watchAt)) + ')</span>');
    if (e.kind === 'inventory') {
      var have = e.qtyRemaining != null ? e.qtyRemaining + (e.qtyUnit ? ' ' + esc(e.qtyUnit) : '') + ' left' : (e.quantity ? e.quantity + ' on hand' : '');
      var where = e.locations.length ? ' at ' + esc(e.locations.join(', ')) : '';
      if (have || where) bits.push((have || 'in inventory') + where);
    }
    if (e.timesBought) bits.push('bought ' + e.timesBought + '×' + (e.lastBought ? ', last ' + esc(C.fmtDateLong(e.lastBought)) : ''));
    else if (e.lastBought) bits.push('since ' + esc(C.fmtDateLong(e.lastBought)));
    if (e.project) bits.push(esc(e.project));
    if (e.alternatives) bits.push(e.alternatives + ' source' + (e.alternatives === 1 ? '' : 's') + ' compared');
    return '<div class="pt-pk-row" data-entry="' + esc(e.id) + '">' +
      '<div class="pt-pk-main"><div class="pt-pk-name">' + (e.url ? '<a href="' + esc(e.url) + '" target="_blank" rel="noopener">' + esc(e.name) + '</a>' : esc(e.name)) + badges + '</div>' +
        '<div class="pt-pk-meta">' + bits.join(' · ') + '</div></div>' +
      '<button type="button" class="btn btn-sm btn-primary" data-pick-entry="' + esc(e.id) + '">' + icon('arrow-path') + ' Reorder</button>' +
    '</div>';
  }
  function pickEntry(id) {
    var e = S.pickerEntries.find(function (x) { return x.id === id; });
    if (!e) return;
    if (e.kind === 'inventory') { prefillReorder(e.invId); return; }
    var t = ticketById(e.ticketId);
    if (!t) { toast('That earlier request is no longer here — starting a blank request', 'warn'); S.composer = { values: {}, error: null, busy: false }; S.picker = null; render(true); return; }
    startRepeat(t);
  }
  function renderAll() { render(true); }

  /* ─── Composer (new request) ────────────────────────────── */
  function requestFields(v, idPrefix, opts) {
    var p = idPrefix || 'pt-f-';
    var compact = !!(opts && opts.compact);   // V3.816 — a reorder: the prefilled item details fold away
    // Project decides the funding string. Preselect: stored projectId, else the
    // project whose funding string matches the stored account (legacy / reorder),
    // else "Other" when a free-text project is present.
    var opts = S.fundedProjects;
    var pid = v.projectId;
    if (!pid && v.fundingAccount) { var m = C.projectForAccount(opts, v.fundingAccount); if (m) pid = m.id; }
    if (!pid && v.project) pid = '__other';
    var otherShown = pid === '__other';
    var chosen = opts.find(function (o) { return o.id === pid; });
    var charged = chosen ? chosen.label : (otherShown ? 'The approver will assign the funding string.' : '—');
    var qty = v.quantity == null ? 1 : v.quantity, unit = v.unitCost == null ? '' : v.unitCost;
    var est = (unit !== '' && isFinite(+unit)) ? (+unit * (+qty || 1)).toFixed(2) : '';
    var sourceRow =
      '<div class="pt-grid-3">' +
        field('vendor', 'Vendor', '<input type="text" id="' + p + 'vendor" data-f="vendor" placeholder="Sigma-Aldrich" value="' + esc(v.vendor) + '">') +
        field('catalogueNumber', 'Catalogue / part #', '<input type="text" id="' + p + 'catalogueNumber" data-f="catalogueNumber" value="' + esc(v.catalogueNumber) + '">') +
        field('productUrl', 'Product link', '<input type="url" id="' + p + 'productUrl" data-f="productUrl" placeholder="https://…" value="' + esc(v.productUrl) + '">') +
      '</div>';
    return (
      field('itemDescription', 'What do you need? *', '<input type="text" id="' + p + 'itemDescription" data-f="itemDescription" maxlength="300" placeholder="e.g. PEG 6000, 100 g bottle" value="' + esc(v.itemDescription) + '">') +
      (compact ? '' : sourceRow) +
      '<div class="pt-grid-3">' +
        field('quantity', 'Quantity', '<input type="number" min="1" step="1" id="' + p + 'quantity" data-f="quantity" value="' + esc(qty) + '">') +
        field('unitCost', 'Unit cost ($)', '<input type="number" min="0" step="0.01" id="' + p + 'unitCost" data-f="unitCost" placeholder="0.00" value="' + esc(unit) + '">') +
        field('estimatedCost', 'Estimated total', '<input type="text" id="' + p + 'estimatedCost" data-f="estimatedCost" readonly tabindex="-1" value="' + esc(est ? C.fmtMoney(est) : '') + '">') +
      '</div>' +
      '<div class="pt-grid-3">' +
        projectField(p, pid, otherShown, v, opts) +
        field('fundingAccount', 'Charged to', '<input type="text" id="' + p + 'charged" data-charged readonly tabindex="-1" value="' + esc(charged) + '">', 'The funding string purchasing uses — set by the project.') +
        field('category', 'Category', '<select id="' + p + 'category" data-f="category">' + C.CATEGORIES.map(function (cat) { return opt(cat.id, cat.label, (v.category || 'consumable') === cat.id); }).join('') + '</select>') +
      '</div>' +
      '<div class="pt-grid-3">' +
        field('urgency', 'Urgency', '<select id="' + p + 'urgency" data-f="urgency">' + Object.keys(C.URGENCY).map(function (u) { return opt(u, C.URGENCY[u].label, (v.urgency || 'routine') === u); }).join('') + '</select>') +
        field('neededBy', 'Needed by', '<input type="date" id="' + p + 'neededBy" data-f="neededBy" value="' + esc(v.neededBy) + '">') +
        field('purchaseType', 'One-time or recurring? *', '<select id="' + p + 'purchaseType" data-f="purchaseType">' + opt('', '— choose —', !v.purchaseType) + C.PURCHASE_TYPES.map(function (x) { return opt(x.id, x.label, v.purchaseType === x.id); }).join('') + '</select>' +
          '<select id="' + p + 'recurrence" data-f="recurrence" class="pt-other" aria-label="How often"' + (v.purchaseType === 'recurring' ? '' : ' hidden') + '>' + opt('', 'How often?', !v.recurrence) + C.RECURRENCE.map(function (x) { return opt(x.id, x.label, v.recurrence === x.id); }).join('') + '</select>') +
      '</div>' +
      field('reason', 'Why do you need it? *', '<textarea id="' + p + 'reason" data-f="reason" rows="2" placeholder="Which experiment or protocol step, and what is blocked without it">' + esc(v.reason) + '</textarea>') +
      (compact
        ? '<details class="pt-more" data-more><summary>Item details &amp; price comparison — prefilled from last time, open to change</summary>' + sourceRow + comparisonBlockHTML(v) + '</details>'
        : comparisonBlockHTML(v))
    );
  }

  /* ─── Price comparison + AI assist (V3.814) ─────────────── */
  function comparisonBlockHTML(v) {
    return '<div class="pt-cmp" data-cmp-block>' + comparisonInnerHTML(v) + '</div>';
  }
  function comparisonInnerHTML(v) {
    var rows = Array.isArray(v.comparisons) ? v.comparisons : (v.comparisons = []);
    var ai = v._aiOpen;
    var head = '<div class="pt-cmp-head"><div><span class="pt-label">Price comparison</span> <span class="pt-hint">Optional for small items — the approver sees it. Let an AI do the legwork: download the prompt, paste it into the AI you use, then import its answer.</span></div>' +
      '<div class="pt-cmp-tools">' +
        '<button type="button" class="btn btn-sm" data-ai-prompt title="Download a prompt built from this form">' + icon('arrow-down-tray') + ' Download AI prompt</button>' +
        '<button type="button" class="btn btn-sm' + (ai ? ' is-active' : '') + '" data-ai-open>' + icon('arrow-up-tray') + ' Import AI results</button>' +
      '</div></div>';
    var panel = !ai ? '' :
      '<div class="pt-ai" data-ai-panel>' +
        '<label class="pt-field" data-field="aiPaste"><span class="pt-label">Paste the AI’s answer (the JSON block)</span>' +
          '<textarea data-ai-paste rows="5" placeholder=\'{ "sources": [ { "vendor": "…", "unitPrice": 12.5, … } ], "recommended": 0, … }\'>' + esc(v._aiText || '') + '</textarea>' +
          '<span class="pt-field-err" hidden></span></label>' +
        '<div class="pt-actions-row"><button type="button" class="btn btn-sm btn-primary" data-ai-import>Import</button><button type="button" class="btn btn-sm" data-ai-cancel>Cancel</button></div>' +
      '</div>';
    var why = v._aiWhy ? '<div class="pt-hint pt-hint--block">' + icon('sparkles') + ' AI’s pick: ' + esc(v._aiWhy) + '</div>' : '';
    var table = rows.length ? '<div class="pt-cmp-rows">' + rows.map(function (r, i) { return comparisonRowHTML(r || {}, i); }).join('') + '</div>' : '';
    var add = rows.length < C.MAX_COMPARISONS ? '<button type="button" class="pt-link" data-cmp-add>+ Add a source' + (rows.length ? '' : ' by hand') + '</button>' : '';
    return head + panel + why + table + '<div class="pt-cmp-foot">' + add + '</div><span class="pt-field-err" data-cmp-err hidden></span>';
  }
  function comparisonRowHTML(r, i) {
    var price = r.unitPrice == null ? '' : r.unitPrice;
    return '<div class="pt-cmp-row' + (r.chosen ? ' is-chosen' : '') + '" data-cmp-row="' + i + '">' +
      '<input type="text" data-cmp="' + i + '" data-ck="vendor" placeholder="Vendor" value="' + esc(r.vendor || '') + '" aria-label="Vendor">' +
      '<input type="text" data-cmp="' + i + '" data-ck="catalogueNumber" placeholder="Cat #" value="' + esc(r.catalogueNumber || '') + '" aria-label="Catalogue number">' +
      '<input type="text" inputmode="decimal" data-cmp="' + i + '" data-ck="unitPrice" placeholder="Price $" value="' + esc(price) + '" aria-label="Unit price">' +
      '<input type="url" data-cmp="' + i + '" data-ck="url" placeholder="https://…" value="' + esc(r.url || '') + '" aria-label="Link">' +
      '<input type="text" data-cmp="' + i + '" data-ck="notes" placeholder="Pack size, lead time, notes" value="' + esc([r.packSize, r.leadTime, r.notes].filter(Boolean).join(' · ') === (r.notes || '') ? (r.notes || '') : [r.packSize, r.leadTime, r.notes].filter(Boolean).join(' · ')) + '" aria-label="Notes">' +
      '<span class="pt-cmp-btns">' +
        '<button type="button" class="pt-link" data-cmp-use="' + i + '" title="Copy this source into the request">' + (r.chosen ? '✓ using' : 'Use') + '</button>' +
        '<button type="button" class="pt-x" data-cmp-del="' + i + '" aria-label="Remove source">' + icon('x-mark') + '</button>' +
      '</span>' +
    '</div>';
  }
  /** The table an approver sees on the card. */
  function comparisonTableHTML(t) {
    var rows = C.cleanComparisons(t.comparisons, t);
    if (!rows.length) return '';
    return '<div class="pt-sub">Price comparison</div><div class="pt-table-wrap"><table class="pt-table pt-cmp-table"><thead><tr><th>Vendor</th><th>Cat #</th><th class="num">Price</th><th>Notes</th></tr></thead><tbody>' +
      rows.map(function (r) {
        var notes = [r.packSize, r.leadTime, r.notes].filter(Boolean).join(' · ');
        return '<tr' + (r.chosen ? ' class="is-chosen"' : '') + '><td>' + (r.chosen ? icon('check') + ' ' : '') + (r.url ? '<a href="' + esc(r.url) + '" target="_blank" rel="noopener">' + esc(r.vendor) + '</a>' : esc(r.vendor)) + '</td><td>' + esc(r.catalogueNumber) + '</td><td class="num">' + esc(typeof r.unitPrice === 'number' ? C.fmtMoney(r.unitPrice) : '') + '</td><td class="pt-muted">' + esc(notes) + '</td></tr>';
      }).join('') + '</tbody></table></div>';
  }
  function labName() { return (window.LAB_CONFIG && LAB_CONFIG.labName) || 'the McGhee Lab (University of Arizona)'; }
  function downloadText(name, text) {
    var blob = new Blob([text], { type: 'text/plain' });
    var a = document.createElement('a'); a.href = URL.createObjectURL(blob); a.download = name;
    document.body.appendChild(a); a.click(); setTimeout(function () { URL.revokeObjectURL(a.href); a.remove(); }, 500);
  }
  /** Push the main request inputs in `scope` to what `values` now says (after Use / import). */
  function syncMainFields(scope, values) {
    ['vendor', 'catalogueNumber', 'productUrl', 'unitCost', 'quantity', 'purchaseType', 'recurrence', 'reason'].forEach(function (k) {
      var el = $('[data-f="' + k + '"]', scope); if (el && values[k] != null) el.value = values[k];
    });
    var rec = $('[data-f="recurrence"]', scope); if (rec) rec.hidden = values.purchaseType !== 'recurring';
    var est = $('[data-f="estimatedCost"]', scope);
    if (est) { var u = parseFloat(values.unitCost), q = parseFloat(values.quantity) || 1; est.value = isFinite(u) ? C.fmtMoney(u * q) : ''; }
  }
  function rerenderComparison(scope, values) {
    var block = $('[data-cmp-block]', scope); if (!block) return;
    block.innerHTML = comparisonInnerHTML(values);
    wireComparison(scope, values);
  }
  function wireComparison(scope, values) {
    var block = $('[data-cmp-block]', scope); if (!block) return;
    values.comparisons = Array.isArray(values.comparisons) ? values.comparisons : [];
    $$('[data-cmp]', block).forEach(function (el) {
      var h = function () { var i = +el.dataset.cmp, k = el.dataset.ck; var row = values.comparisons[i] || (values.comparisons[i] = {}); row[k] = el.value; if (k === 'vendor' || k === 'unitPrice' || k === 'url' || k === 'catalogueNumber') { if (row.chosen) { /* keep the main fields in step with the chosen row */ C.applyComparison(values, i); syncMainFields(scope, values); } } };
      el.addEventListener('input', h); el.addEventListener('change', h);
    });
    var add = $('[data-cmp-add]', block);
    if (add) add.addEventListener('click', function () { values.comparisons.push({ vendor: '', catalogueNumber: '', url: '', unitPrice: '', notes: '' }); rerenderComparison(scope, values); var last = $$('[data-ck="vendor"]', scope).pop(); if (last) last.focus(); });
    $$('[data-cmp-use]', block).forEach(function (b) { b.addEventListener('click', function () {
      var i = +b.dataset.cmpUse;
      if (!C.str(values.comparisons[i] && values.comparisons[i].vendor)) { showCmpError(scope, 'Give this source a vendor name first.'); return; }
      C.applyComparison(values, i); syncMainFields(scope, values); rerenderComparison(scope, values);
      toast('Using ' + values.vendor + (values.unitCost !== '' && values.unitCost != null ? ' at ' + C.fmtMoney(values.unitCost) : ''), 'info');
    }); });
    $$('[data-cmp-del]', block).forEach(function (b) { b.addEventListener('click', function () { values.comparisons.splice(+b.dataset.cmpDel, 1); rerenderComparison(scope, values); }); });
    var dl = $('[data-ai-prompt]', block);
    if (dl) dl.addEventListener('click', function () {
      if (!C.str(values.itemDescription)) { showFieldError(scope, 'itemDescription', 'Say what you need first — the prompt is built from it.'); return; }
      var text = C.aiPrompt(values, { lab: labName(), today: C.todayStr() });
      var fname = 'procurement-prompt-' + C.str(values.itemDescription).toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '').slice(0, 40) + '.txt';
      downloadText(fname, text);
      var done = function () { toast('Prompt downloaded and copied — paste it into the AI you use, then press “Import AI results”', 'info'); };
      if (navigator.clipboard && navigator.clipboard.writeText) navigator.clipboard.writeText(text).then(done, function () { toast('Prompt downloaded — paste it into the AI you use, then press “Import AI results”', 'info'); });
      else toast('Prompt downloaded — paste it into the AI you use, then press “Import AI results”', 'info');
    });
    var open = $('[data-ai-open]', block);
    if (open) open.addEventListener('click', function () { values._aiOpen = !values._aiOpen; rerenderComparison(scope, values); var ta = $('[data-ai-paste]', scope); if (ta) ta.focus(); });
    var cancel = $('[data-ai-cancel]', block);
    if (cancel) cancel.addEventListener('click', function () { values._aiOpen = false; values._aiText = ''; rerenderComparison(scope, values); });
    var paste = $('[data-ai-paste]', block);
    if (paste) paste.addEventListener('input', function () { values._aiText = paste.value; });
    var imp = $('[data-ai-import]', block);
    if (imp) imp.addEventListener('click', function () {
      var r = C.parseAiResults(values._aiText || (paste && paste.value) || '');
      if (r.error) { var e = $('[data-field="aiPaste"] .pt-field-err', block); if (e) { e.textContent = r.error; e.hidden = false; } if (paste) paste.focus(); return; }
      var took = C.applyAiResults(values, r.results);
      values._aiOpen = false; values._aiText = '';
      syncMainFields(scope, values); rerenderComparison(scope, values);
      toast('Imported ' + took.sources + ' source' + (took.sources === 1 ? '' : 's') + (took.main ? ' — using ' + values.vendor + (values.unitCost !== '' ? ' at ' + C.fmtMoney(values.unitCost) : '') : '') + (took.purchaseType ? ' · marked ' + (values.purchaseType === 'recurring' ? 'recurring' : 'one-time') : ''), 'success');
    });
  }
  function showCmpError(scope, msg) { var e = $('[data-cmp-err]', scope); if (e) { e.textContent = msg; e.hidden = !msg; } }
  /** The Project select (+ the "Other" name field) — also used by the approve form. */
  function projectField(p, pid, otherShown, v, opts) {
    var sel = opt('', '— choose a project —', !pid) +
      opts.map(function (o) { return opt(o.id, o.label, pid === o.id); }).join('') +
      opt('__other', 'Other / not listed…', otherShown);
    return field('projectId', 'Project *', '<select id="' + p + 'projectId" data-f="projectId">' + sel + '</select>' +
      '<input type="text" id="' + p + 'projectOther" data-f="projectOther" class="pt-other" placeholder="Name the project — the approver assigns the funding string" value="' + esc(otherShown ? v.project : '') + '"' + (otherShown ? '' : ' hidden') + '>');
  }
  /* A <label> wrapper names its control for assistive tech (and a click on the
   * caption focuses the input) without needing ids on every inline form. */
  function field(key, label, control, hint) {
    return '<label class="pt-field" data-field="' + key + '"><span class="pt-label">' + esc(label) + '</span>' + control + (hint ? '<span class="pt-hint">' + esc(hint) + '</span>' : '') + '<span class="pt-field-err" hidden></span></label>';
  }
  /** Wire data-f inputs inside `scope` to write into `values`; keeps the derived total + Other field live. */
  function wireFields(scope, values) {
    $$('[data-f]', scope).forEach(function (el) {
      var h = function () {
        var k = el.dataset.f;
        if (k === 'projectOther') { values.projectOther = el.value; if (values.projectId === '__other') values.project = el.value; return; }
        if (k === 'projectId') {
          var other = $('[data-f="projectOther"]', scope), charged = $('[data-charged]', scope);
          C.applyProject(values, S.fundedProjects, el.value);
          if (el.value === '__other') { if (other) { other.hidden = false; other.focus(); } }
          else if (other) other.hidden = true;
          if (charged) charged.value = values.fundingLabel || (el.value === '__other' ? 'The approver will assign the funding string.' : '—');
          return;
        }
        if (k === 'estimatedCost') return;
        values[k] = el.value;
        if (k === 'purchaseType') {
          var rec = $('[data-f="recurrence"]', scope);
          if (rec) rec.hidden = el.value !== 'recurring';
          if (el.value !== 'recurring') values.recurrence = '';
        }
        if (k === 'quantity' || k === 'unitCost') {
          var est = $('[data-f="estimatedCost"]', scope);
          var u = parseFloat(values.unitCost), q = parseFloat(values.quantity) || 1;
          if (est) est.value = isFinite(u) ? C.fmtMoney(u * q) : '';
          delete values.estimatedCost;
        }
      };
      el.addEventListener('input', h); el.addEventListener('change', h);
    });
    wireComparison(scope, values);
  }
  /** A number input holding junk reports value '' but validity.badInput — the core cannot see that. */
  function badNumberField(scope) {
    var bad = $$('input[type=number]', scope).find(function (el) { return el.validity && el.validity.badInput; });
    return bad ? (bad.dataset.f || null) : null;
  }
  function showFieldError(scope, fieldKey, msg, rowIdx) {
    $$('.pt-field-err', scope).forEach(function (e) { e.hidden = true; e.textContent = ''; });
    var top = $('.pt-form-err', scope); if (top) { top.hidden = !msg || !!fieldKey; top.textContent = msg || ''; }
    if (!msg) return;
    // V3.816 — a reorder form folds the item details away; an error inside must unfold them first.
    var unfold = function (el) { var d = el && el.closest ? el.closest('details') : null; if (d && !d.open) d.open = true; };
    if (fieldKey === 'comparisons') {   // the block is not a <label data-field>; point at the row
      showCmpError(scope, msg);
      unfold($('[data-cmp-block]', scope));
      var r = $('[data-cmp-row="' + (rowIdx || 0) + '"] input', scope); if (r) r.focus();
      return;
    }
    var f = fieldKey && $('[data-field="' + fieldKey + '"]', scope);
    if (f) {
      var e = $('.pt-field-err', f); e.textContent = msg; e.hidden = false;
      unfold(f);
      var inp = $('input,textarea,select', f); if (inp && !inp.readOnly) inp.focus();
    } else if (top) { top.hidden = false; top.textContent = msg; }
  }

  function renderComposer() {
    var box = $('#pt-composer'); if (!box) return;
    if (!S.composer) { box.innerHTML = ''; return; }
    var cm = S.composer, v = cm.values;
    // V3.816 — a reorder (picker, ?reorder=, Request again) is the compact form: the
    // prefilled item details fold away and the person confirms quantity, project, why.
    var reorder = !!(cm.item || cm.againOf);
    var it = cm.item;
    var summary = '';
    if (it) {
      var r0 = it.reorder || {}, stock = C.stockOf(it), locs = (it.locations || []).map(function (l) { return l && l.name; }).filter(Boolean);
      var line = [it.vendor || r0.vendor ? esc(r0.vendor || it.vendor) + (r0.catalogue_number || it.catalogue_number ? ' · ' + esc(r0.catalogue_number || it.catalogue_number) : '') : '',
        (r0.last_price || it.unit_price) ? 'last ' + esc(C.fmtMoney(r0.last_price || it.unit_price)) : '',
        (typeof it.qty_remaining === 'number' ? it.qty_remaining + (it.qty_unit ? ' ' + esc(it.qty_unit) : '') + ' left' : (it.quantity ? it.quantity + ' on hand' : '')) + (locs.length ? ' at ' + esc(locs.join(', ')) : ''),
        stock === 'low' ? 'running low' : stock === 'out_of_stock' ? 'out of stock' : '',
        (function () { var ws = C.watchSummary(C.watchFor(S.watches, r0.url)); return ws ? 'list ' + esc(C.fmtMoney(ws.price)) + ' (checked ' + esc(C.fmtDateLong(ws.at)) + ')' : ''; })()].filter(Boolean).join(' · ');
      summary = '<div class="pt-reorder-item">' + icon('cube') + '<div><strong>' + esc(it.name) + '</strong><div class="pt-muted">' + line + '</div><div class="pt-muted">When it arrives, putting it away restocks this inventory item.' + (r0.alternatives && r0.alternatives.length ? ' The sources compared last time are under Item details.' : '') + '</div></div></div>';
    }
    var cap = cm.captureOf;   // V3.819 — from the browser extension: the full form, with the capture named
    if (cap) {
      var chost = C.str(cap.sourceHost).replace(/^www\./, '');
      summary = '<div class="pt-reorder-item pt-reorder-item--capture">' + icon('globe-alt') + '<div><strong>' + esc(cap.name) + '</strong><div class="pt-muted">Captured in your browser' + (chost ? ' from ' + esc(chost) : '') + (cap.capturedAtIso ? ' ' + esc(C.ageLabel(cap.capturedAtIso)) : '') + '. The vendor and price are filled in below and sit as the first row of the price comparison.</div></div></div>';
    }
    box.innerHTML =
      '<form class="pt-card pt-composer" id="pt-composer-form" novalidate data-mode="' + (reorder ? 'reorder' : 'new') + '"' + (cap ? ' data-capture="' + esc(cap.id) + '"' : '') + '>' +
        '<div class="pt-card-head"><h2 class="pt-h2">' + icon(reorder ? 'arrow-path' : 'shopping-cart') + ' ' + (reorder ? 'Reorder: ' + esc(it ? it.name : cm.againOf.itemDescription) : 'New item') + '</h2>' +
          '<button type="button" class="pt-x" id="pt-composer-close" aria-label="Close">' + icon('x-mark') + '</button></div>' +
        summary +
        (cm.againOf ? '<div class="pt-banner pt-banner--info">' + icon('arrow-path') + ' Again: <strong>' + esc(cm.againOf.itemDescription) + '</strong>, copied from the ' + esc(C.fmtDateLong(cm.againOf.createdAt) || 'earlier') + ' request' + (cm.reorderOf ? ' — putting it away will restock the same inventory item' : '') + '. Check the price and the date, then submit.</div>' : '') +
        '<p class="pt-muted">' + (reorder ? 'Confirm the quantity, the project and why; everything else is filled in from last time.' : 'Describe the item in full — vendor, link, price, and a price comparison if there is one — so the approver can decide from the ticket.') + ' The approver gets a notification, you get one at every step after that, and whoever unpacks the box records where it went.</p>' +
        requestFields(v, undefined, { compact: reorder }) +
        '<div class="pt-form-err" hidden></div>' +
        '<div class="pt-actions-row">' +
          '<button type="submit" class="btn btn-primary" id="pt-composer-submit"' + (cm.busy ? ' disabled' : '') + '>' + (cm.busy ? 'Submitting…' : 'Submit request') + '</button>' +
          '<button type="button" class="btn" id="pt-composer-cancel">Cancel</button>' +
        '</div>' +
      '</form>';
    var form = $('#pt-composer-form');
    wireFields(form, v);
    var close = function () { S.composer = null; renderComposer(); };
    $('#pt-composer-close').addEventListener('click', close);
    $('#pt-composer-cancel').addEventListener('click', close);
    form.addEventListener('keydown', function (e) { if (e.key === 'Escape') { e.preventDefault(); close(); } });
    form.addEventListener('submit', async function (e) {
      e.preventDefault();
      if (cm.busy) return;
      var badF = badNumberField(form);
      if (badF) { showFieldError(form, badF, 'That is not a number.'); return; }
      var check = C.validateRequest(v);
      if (check.error) { showFieldError(form, check.field, check.error, check.row); return; }
      cm.busy = true; $('#pt-composer-submit').disabled = true; $('#pt-composer-submit').textContent = 'Submitting…';
      try {
        var r = await createTicket(v, { inventoryItemId: cm.reorderOf || null, source: cm.captureOf ? 'extension' : cm.againOf ? 'repeat' : cm.reorderOf ? 'reorder' : 'form', repeatOf: cm.againOf ? cm.againOf.id : null, captureId: cm.captureOf ? cm.captureOf.id : null });
        if (r.error) { cm.busy = false; showFieldError(form, r.field, r.error, r.row); $('#pt-composer-submit').disabled = false; $('#pt-composer-submit').textContent = 'Submit request'; return; }
        if (cm.captureOf) await markCaptureUsed(cm.captureOf, r.ticket.id);
        await recordObservations(C.priceObservationsFrom(v, r.ticket.id));   // V3.820 — a price with a page is worth keeping
        S.composer = null;
        S.view = 'mine'; S.expanded[r.ticket.id] = true;
        toast('Request submitted — the approver has been notified');
        render(true);
      } catch (err) {
        cm.busy = false;
        showFieldError(form, null, 'Submit failed: ' + (err && err.message || err));
        $('#pt-composer-submit').disabled = false; $('#pt-composer-submit').textContent = 'Submit request';
      }
    });
    if (cm.error) showFieldError(form, cm.field, cm.error);
  }

  /* ─── Body: views ───────────────────────────────────────── */
  function renderBody() {
    var body = $('#pt-body'); if (!body) return;
    if (S.view === 'report') { renderReport(body); return; }
    if (S.view === 'docs') { renderDocs(body); return; }   // V3.881 — the top search box searches the documents here
    if (S.view === 'inbox' && !S.q && !S.status) { renderInbox(body); return; }
    // A search or status filter looks across EVERY ticket (the status counts in
    // the dropdown are global), whatever tab is lit; otherwise the tab decides.
    var filtering = !!(S.q || S.status);
    var view = filtering ? 'all' : S.view;
    var list = C.sortTickets(C.filterTickets(S.tickets, { view: view, uid: S.actor.uid, status: S.status, q: S.q }), S.sort);
    var note = filtering ? '<div class="pt-filter-note">' + icon('funnel') + ' Showing matches across all tickets' + (S.view === 'mine' ? '' : '') + ' — clear the search and status to go back to the tab.</div>' : '';
    if (!list.length) {
      var msg = S.q || S.status ? 'No tickets match.' :
        view === 'mine' ? 'You haven’t requested anything yet. Click “Reorder existing” for something the lab already buys, or “New item” for anything else.' :
        view === 'archive' ? 'Nothing archived yet — placed, denied and withdrawn tickets land here.' : 'No open tickets.';
      body.innerHTML = '<div class="empty-state">' + esc(msg) + '</div>';
      return;
    }
    body.innerHTML = note + '<div class="pt-list">' + list.map(rowHTML).join('') + '</div>';
    wireRows(body);
  }

  function renderInbox(body) {
    var sections = C.inboxFor(S.tickets, S.actor);
    if (!sections.length) {
      body.innerHTML = '<div class="empty-state">' + icon('check-circle') + ' Nothing needs you right now.' +
        '<div class="pt-muted" style="margin-top:6px">New requests, questions and arrivals will show up here' + (S.actor.canApprove ? ', and you get a notification for each' : '') + '.</div></div>';
      return;
    }
    body.innerHTML = sections.map(function (s) {
      return '<section class="pt-section" data-section="' + s.key + '">' +
        '<div class="pt-section-head"><h3>' + esc(s.title) + ' <span class="pt-tab-n">' + s.items.length + '</span></h3>' + (s.hint ? '<span class="pt-muted">' + esc(s.hint) + '</span>' : '') + '</div>' +
        '<div class="pt-list">' + C.sortTickets(s.items, 'urgency').map(rowHTML).join('') + '</div>' +
      '</section>';
    }).join('');
    wireRows(body);
  }

  /* ─── Ticket row + card ─────────────────────────────────── */
  function chip(status) { var s = C.STATUS[status] || C.STATUS.requested; return '<span class="pt-chip pt-chip--' + s.chip + '">' + esc(s.short) + '</span>'; }

  function rowHTML(t) {
    var open = !!S.expanded[t.id];
    var cost = t.actualCost != null ? C.fmtMoney(t.actualCost) : (t.estimatedCost ? '~' + C.fmtMoney(t.estimatedCost) : '');
    var flags = '';
    if (t.urgency === 'urgent') flags += '<span class="pt-flag pt-flag--urgent">' + icon('exclamation-triangle') + ' urgent</span>';
    else if (t.urgency === 'needed_soon') flags += '<span class="pt-flag pt-flag--soon">soon</span>';
    if (t.issue) flags += '<span class="pt-flag pt-flag--issue">' + icon('flag') + ' problem</span>';
    if (t.status === 'needs_info') flags += '<span class="pt-flag pt-flag--question">' + icon('question-mark-circle') + ' question</span>';
    if (t.status === 'ordered' && t.expectedDelivery) {
      var late = C.ageDays(t.expectedDelivery) > 0;
      flags += '<span class="pt-flag' + (late ? ' pt-flag--late' : '') + '">' + icon('clock') + ' ETA ' + esc(C.fmtDateLong(t.expectedDelivery)) + (late ? ' (late)' : '') + '</span>';
    }
    if (t.neededBy && (t.status === 'requested' || t.status === 'needs_info' || t.status === 'approved')) flags += '<span class="pt-flag">by ' + esc(C.fmtDateLong(t.neededBy)) + '</span>';
    return (
      '<article class="pt-row' + (open ? ' is-open' : '') + (t.urgency === 'urgent' ? ' is-urgent' : '') + (t.issue ? ' has-issue' : '') + '" data-id="' + esc(t.id) + '">' +
        '<div class="pt-row-head" role="button" tabindex="0" data-toggle aria-expanded="' + open + '">' +
          chip(t.status) +
          '<span class="pt-row-title"><strong>' + esc(t.itemDescription) + '</strong>' + (t.vendor ? ' <span class="pt-muted">· ' + esc(t.vendor) + '</span>' : '') + '</span>' +
          '<span class="pt-row-meta">' + esc(t.requesterName || userName(t.requestedBy)) + (cost ? ' · ' + esc(cost) : '') + (t.quantity > 1 ? ' · ' + esc(t.quantity) + '×' : '') + ' · ' + esc(C.ageLabel(C.lastActivityMs(t))) + '</span>' +
          (flags ? '<span class="pt-row-flags">' + flags + '</span>' : '') +
          '<span class="pt-caret">' + icon(open ? 'chevron-up' : 'chevron-down') + '</span>' +
        '</div>' +
        (open ? cardHTML(t) : '') +
      '</article>'
    );
  }

  function cardHTML(t) {
    var acts = C.availableActions(t, S.actor);
    var banner = '';
    if (t.status === 'needs_info' && t.question) {
      banner = '<div class="pt-banner pt-banner--question">' + icon('question-mark-circle') + ' <strong>' + esc(t.questionByName || userName(t.questionBy)) + ' asks:</strong> ' + esc(t.question) +
        (C.isRequester(t, S.actor) ? ' <span class="pt-muted">— answer below to send it back for approval.</span>' : ' <span class="pt-muted">— waiting for ' + esc(t.requesterName || 'the requester') + '.</span>') + '</div>';
    }
    if (t.issue) banner += '<div class="pt-banner pt-banner--issue">' + icon('flag') + ' <strong>Problem flagged by ' + esc(t.issueByName || userName(t.issueBy)) + ':</strong> ' + esc(t.issue) + '</div>';
    if (t.status === 'denied') banner += '<div class="pt-banner pt-banner--denied">' + icon('x-mark') + ' <strong>Denied</strong>' + (t.piNotes ? ' — ' + esc(t.piNotes) : '') + '</div>';
    if (t.status === 'cancelled') banner += '<div class="pt-banner">' + icon('arrow-uturn-left') + ' Withdrawn by the requester.</div>';

    var d = [];
    var add = function (k, v) { if (v !== '' && v != null) d.push('<div class="pt-d"><span class="pt-dk">' + k + '</span><span class="pt-dv">' + v + '</span></div>'); };
    add('Requested by', esc(t.requesterName || userName(t.requestedBy)) + (t.createdAt ? ' <span class="pt-muted">on ' + esc(C.fmtDateLong(t.createdAt)) + '</span>' : ''));
    add('Project', esc(t.project));
    add('Charged to', t.fundingAccount ? '<code>' + esc(t.fundingAccount) + '</code>' + (t.fundingLabel && t.fundingLabel !== t.fundingAccount && t.fundingLabel.indexOf(t.project || '\u0000') < 0 ? ' <span class="pt-muted">' + esc(t.fundingLabel) + '</span>' : '') : '<span class="pt-muted">not set — assigned at approval</span>');
    add('Category', esc(C.categoryLabel(t.category)));
    if (t.purchaseType) add('Purchase type', esc(t.purchaseType === 'recurring' ? 'Recurring' + (t.recurrence ? ' — ' + C.recurrenceLabel(t.recurrence).toLowerCase() : '') : 'One-time'));
    if (t.fundingChangedAt) add('Funding changed', esc(t.fundingChangedByName || userName(t.fundingChangedBy)) + ' <span class="pt-muted">' + esc(C.fmtDateLong(t.fundingChangedAt)) + (t.fundingChangedFrom ? ' · was ' + esc(t.fundingChangedFrom) : '') + '</span>');
    add('Quantity', esc(t.quantity));
    add('Unit cost', C.fmtMoney(t.unitCost));
    add('Estimated total', esc(C.fmtMoney(t.estimatedCost)));
    add('Needed by', esc(C.fmtDateLong(t.neededBy)));
    add('Urgency', esc((C.URGENCY[t.urgency] || C.URGENCY.routine).label));
    add('Catalogue #', esc(t.catalogueNumber));
    if (t.productUrl) add('Link', '<a href="' + esc(t.productUrl) + '" target="_blank" rel="noopener">' + icon('link') + ' product page</a>');
    if (t.productUrl) { var wr = watchRowHTML(t.productUrl); if (wr) add('Price watch', wr); }   // V3.820
    var stage = (C.STATUS[t.status] || C.STATUS.requested).order;
    // Decision / order rows show only while they are the ticket's current truth:
    // after Undo order the PO details would otherwise sit under an APPROVED chip.
    if (t.approvedAt && stage >= C.STATUS.approved.order && stage <= C.STATUS.placed.order) add('Approved', esc(t.approvedByName || userName(t.approvedBy)) + ' <span class="pt-muted">' + esc(C.fmtDateLong(t.approvedAt)) + '</span>' + (t.piNotes ? ' — ' + esc(t.piNotes) : ''));
    if ((t.orderedAt || t.orderDate || t.poNumber) && stage >= C.STATUS.ordered.order && stage <= C.STATUS.placed.order) add('Ordered', (t.poNumber ? 'PO ' + esc(t.poNumber) + ' · ' : '') + esc(C.methodLabel(t.purchaseMethod)) + (t.orderDate ? ' · ' + esc(C.fmtDateLong(t.orderDate)) : '') + (t.orderedByName ? ' <span class="pt-muted">by ' + esc(t.orderedByName) + '</span>' : '') +
      (t.orderedCost != null ? ' · ' + esc(C.fmtMoney(t.orderedCost)) : '') + (t.poUrl ? ' · <a href="' + esc(t.poUrl) + '" target="_blank" rel="noopener">' + icon('document-text') + ' PO file</a>' : ''));
    if (t.expectedDelivery && (t.status === 'ordered')) add('Expected', esc(C.fmtDateLong(t.expectedDelivery)));
    if (t.receivedAt && stage >= C.STATUS.received.order && stage <= C.STATUS.placed.order) add('Received', esc(t.receivedByName || userName(t.receivedBy)) + ' <span class="pt-muted">' + esc(C.fmtDateLong(t.receivedAt)) + '</span>' + (t.quantityReceived != null ? ' · ' + esc(t.quantityReceived) + ' received' : '') + (t.actualCost != null ? ' · ' + esc(C.fmtMoney(t.actualCost)) : '') + (t.receiptUrl ? ' · <a href="' + esc(t.receiptUrl) + '" target="_blank" rel="noopener">' + icon('paper-clip') + ' receipt</a>' : ''));
    if (t.location) add('Location', '<strong>' + esc(t.location) + '</strong>' + (t.placedByName ? ' <span class="pt-muted">by ' + esc(t.placedByName) + '</span>' : '') +
      (t.inventoryItemId ? ' · <a href="/rm/pages/inventory.html?item=' + esc(t.inventoryItemId) + '">' + icon('cube') + ' open in inventory</a>' : ''));
    else if (t.inventoryItemId && t.status !== 'placed') add('Restocks', '<a href="/rm/pages/inventory.html?item=' + esc(t.inventoryItemId) + '">' + icon('cube') + ' existing inventory item</a>');

    var tl = C.timelineOf(t).map(function (h) {
      return '<li><span class="pt-tl-when">' + esc(C.fmtDateLong(h.at)) + '</span> <span class="pt-tl-what">' + esc(C.ACTION_LABEL[h.action] || h.action) + (h.to ? ' → ' + esc((C.STATUS[h.to] || {}).short || h.to) : '') + '</span>' +
        (h.byName ? ' <span class="pt-muted">' + esc(h.byName) + '</span>' : '') + (h.note ? '<div class="pt-tl-note">' + esc(h.note) + '</div>' : '') + '</li>';
    }).join('');
    var notes = (t.notes || []).slice().sort(function (a, b) { return C.toMs(a.at) - C.toMs(b.at); }).map(function (n) {
      return '<li class="pt-note pt-note--' + esc(n.kind || 'note') + '"><div class="pt-note-head"><strong>' + esc(n.byName || userName(n.by)) + '</strong> <span class="pt-muted">' + esc(C.fmtDateLong(n.at)) + (n.kind && n.kind !== 'note' ? ' · ' + esc(n.kind) : '') + '</span></div><div>' + esc(n.text) + '</div></li>';
    }).join('');

    // "Request again" — a repeat request prefilled from this one (any member;
    // not while the ticket is still live before ordering, where it would duplicate).
    var again = (t.status === 'ordered' || t.status === 'received' || t.status === 'placed' || t.status === 'denied' || t.status === 'cancelled')
      ? '<button type="button" class="btn btn-sm" data-act="again">' + icon('arrow-path') + ' Request again</button>' : '';
    var attachBtn = canAttach(t) ? '<button type="button" class="btn btn-sm" data-act="attach">' + icon('paper-clip') + ' Attach receipt / requisition</button>' : '';   // V3.881
    var buttons = acts.map(function (a) {
      var cls = 'btn btn-sm' + (C.PRIMARY[a] ? ' btn-primary' : '') + (a === 'deny' || a === 'delete' || a === 'cancel' ? ' pt-btn-danger' : '');
      return '<button type="button" class="' + cls + '" data-act="' + a + '">' + esc(C.ACTION_LABEL[a]) + '</button>';
    }).join('') + attachBtn + again + '<button type="button" class="btn btn-sm pt-btn-ghost" data-act="link">' + icon('link') + ' Copy link</button>';
    var cmp = comparisonTableHTML(t);
    if (!cmp && (t.status === 'requested' || t.status === 'needs_info') && S.actor.canApprove) cmp = '<div class="pt-hint pt-hint--block">No price comparison was given.</div>';

    return (
      '<div class="pt-card-body">' +
        banner +
        '<div class="pt-details">' + d.join('') + '</div>' +
        (t.reason ? '<div class="pt-reason"><span class="pt-dk">Why</span> ' + esc(t.reason) + '</div>' : '') +
        cmp +
        ticketDocsHTML(t) +
        '<div class="pt-two">' +
          '<div><div class="pt-sub">Timeline</div><ol class="pt-timeline">' + (tl || '<li class="pt-muted">—</li>') + '</ol></div>' +
          '<div><div class="pt-sub">Notes</div><ul class="pt-notes">' + (notes || '<li class="pt-muted">No notes yet.</li>') + '</ul></div>' +
        '</div>' +
        '<div class="pt-actions">' + buttons + '</div>' +
        '<div class="pt-formwrap">' + ((S.form && S.form.id === t.id) ? formHTML(t) : '') + ((S.attach && S.attach.id === t.id) ? attachHTML(t) : '') + '</div>' +
      '</div>'
    );
  }

  function wireRows(scope) {
    $$('[data-toggle]', scope).forEach(function (h) {
      var go = function () { var id = h.closest('.pt-row').dataset.id; S.expanded[id] = !S.expanded[id]; if (!S.expanded[id] && S.form && S.form.id === id) { stashDraft(); S.form = null; } renderBody(); };
      h.addEventListener('click', go);
      h.addEventListener('keydown', function (e) { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); go(); } });
    });
    $$('[data-act]', scope).forEach(function (b) {
      b.addEventListener('click', function () { onAction(b.closest('.pt-row').dataset.id, b.dataset.act); });
    });
    $$('.pt-row', scope).forEach(function (row) {
      if (S.form && S.form.id === row.dataset.id) wireForm(row);
      if (S.attach && S.attach.id === row.dataset.id) wireAttach(row);   // V3.881
    });
  }

  function draftKey(f) { return f.id + ':' + f.action; }
  /** Keep what was typed in the open form so switching forms or collapsing a row never throws it away. */
  function stashDraft() { if (S.form && !S.form.busy) S.drafts[draftKey(S.form)] = { values: S.form.values, picked: S.form.picked }; }
  function dropDraft(f) { if (f) delete S.drafts[draftKey(f)]; }

  function onAction(id, act) {
    var t = ticketById(id); if (!t) return;
    if (act === 'link') {
      var url = location.origin + ticketUrl(id);
      var done = function () { toast('Link copied'); };
      if (navigator.clipboard && navigator.clipboard.writeText) navigator.clipboard.writeText(url).then(done, function () { toast(url, 'info'); });
      else toast(url, 'info');
      return;
    }
    if (act === 'again') { startRepeat(t); return; }   // V3.814 — repeat this request: the composer, prefilled
    if (act === 'attach') {   // V3.881 — not a transition: files linked to this request (and, ticked, the rest of its order)
      if (S.attach && S.attach.id === id) { S.attach = null; renderBody(); return; }
      if (S.form && S.form.id === id) { stashDraft(); S.form = null; }
      S.attach = { id: id, kind: t.status === 'approved' ? 'requisition' : 'receipt', files: [], note: '', linkSiblings: true, busy: false, error: '', progress: '' };
      S.expanded[id] = true;
      renderBody();
      return;
    }
    if (!C.can(act, t, S.actor)) { toast('That action isn’t available on this ticket', 'warn'); return; }
    if (S.form && S.form.id === id && S.form.action === act) { stashDraft(); S.form = null; renderBody(); return; }
    if (S.attach && S.attach.id === id) S.attach = null;   // V3.881 — one inline form per card
    stashDraft();
    var values = {};
    if (act === 'edit') { values = Object.assign({}, C.cleanRequest(t)); if (!values.projectId && values.fundingAccount) { var pm2 = C.projectForAccount(S.fundedProjects, values.fundingAccount); if (pm2) values.projectId = pm2.id; } if (!values.projectId && values.project) { values.projectId = '__other'; values.projectOther = values.project; } }
    if (act === 'approve' && !C.str(t.fundingAccount)) values = { projectId: '', projectOther: t.project || '' };
    if (act === 'reassign') {   // start from the ticket's current project so "nothing changed" is caught
      values = { projectId: t.projectId || '', project: t.project || '', fundingAccount: t.fundingAccount || '', fundingLabel: t.fundingLabel || '', projectOther: '' };
      if (!values.projectId && values.fundingAccount) { var pm3 = C.projectForAccount(S.fundedProjects, values.fundingAccount); if (pm3) values.projectId = pm3.id; }
      if (!values.projectId && values.project) { values.projectId = '__other'; values.projectOther = values.project; }
    }
    if (act === 'edit_order') values = { poNumber: t.poNumber || '', purchaseMethod: t.purchaseMethod || '', orderDate: t.orderDate || '', expectedDelivery: t.expectedDelivery || '', actualCost: t.orderedCost != null ? t.orderedCost : '' };
    if (act === 'order') values = { purchaseMethod: t.purchaseMethod || 'pcard', orderDate: C.todayStr(), expectedDelivery: '', poNumber: '', batch: {} };
    if (act === 'receive') values = { quantityReceived: t.quantity || 1, actualCost: t.orderedCost != null ? t.orderedCost : '' };
    if (act === 'place') {
      values = { mode: t.inventoryItemId ? 'restock' : 'new', location: '', quantity: t.quantityReceived != null ? t.quantityReceived : (t.quantity || 1),
                 unitPrice: (t.actualCost != null && (t.quantityReceived || t.quantity)) ? +(t.actualCost / (t.quantityReceived || t.quantity)).toFixed(2) : (t.unitCost || ''),
                 category: C.inventoryCategoryFor(t.category), notes: '', inventoryItemId: t.inventoryItemId || '', q: '' };
      ensureInventory().then(function (items) {
        if (S.form && S.form.id === id && S.form.action === 'place') {
          var it = t.inventoryItemId && items.find(function (i) { return i.id === t.inventoryItemId; });
          if (it) { S.form.picked = it; S.form.values.inventoryItemId = it.id; if (!S.form.values.location && it.locations && it.locations[0]) S.form.values.location = it.locations[0].name; }
          renderBody();
        }
      });
    }
    var draft = S.drafts[id + ':' + act];
    if (draft) { values = Object.assign(values, draft.values); }
    S.form = { id: id, action: act, values: values, error: null, field: null, busy: false, picked: draft ? draft.picked : null };
    S.expanded[id] = true;
    renderBody();
    var first = $('.pt-form [autofocus]') || $('.pt-form input:not([type=hidden]):not([readonly]), .pt-form textarea, .pt-form select');
    if (first) first.focus();
  }

  /* ─── Inline forms ──────────────────────────────────────── */
  var FORM_TITLE = {
    approve: 'Approve this request', ask: 'Ask the requester a question', answer: 'Answer the question', deny: 'Deny this request',
    unapprove: 'Undo the approval?', order: 'Record the order', edit_order: 'Edit the order', unorder: 'Undo “ordered”?',
    receive: 'Mark as received', unreceive: 'Undo “received”?', place: 'Put it away', cancel: 'Withdraw this request?',
    reopen: 'Reopen this request?', note: 'Add a note', flag: 'Flag a problem', clear_issue: 'Clear the flag?', delete: 'Delete this ticket permanently?', edit: 'Edit the request',
    reassign: 'Charge this to a different project',
  };
  var SUBMIT_LABEL = {
    approve: 'Approve', ask: 'Send question', answer: 'Send answer', deny: 'Deny request', unapprove: 'Undo approval', order: 'Mark ordered',
    edit_order: 'Save order', unorder: 'Undo order', receive: 'Mark received', unreceive: 'Undo received', place: 'Put away',
    cancel: 'Withdraw', reopen: 'Reopen', note: 'Add note', flag: 'Flag it', clear_issue: 'Clear flag', delete: 'Delete', edit: 'Save changes',
    reassign: 'Change funding',
  };
  var CONFIRM_ONLY = { unapprove: 1, unorder: 1, unreceive: 1, cancel: 1, reopen: 1, clear_issue: 1, delete: 1 };
  var NOTE_LABEL = { approve: 'Note to the requester (optional)', ask: 'Your question', answer: 'Your answer', deny: 'Reason (the requester sees this)', note: 'Note', flag: 'What’s wrong?' };

  function formHTML(t) {
    var f = S.form, v = f.values, a = f.action;
    var inner = '';
    if (a === 'edit') {
      var toS = C.targetStatus('edit', t, S.actor);
      var warn = toS !== t.status ? (t.status === 'approved' ? 'Saving sends this back to the approver — the approval is cleared.' : 'Saving counts as your answer to the open question and sends it back for approval.') : '';
      inner = (warn ? '<div class="pt-banner pt-banner--info">' + icon('exclamation-triangle') + ' ' + esc(warn) + '</div>' : '') + requestFields(v, 'pt-e-');
    } else if (a === 'order' || a === 'edit_order') {
      var cands = a === 'order' ? C.batchCandidates(S.tickets, t) : [];
      var group = a === 'edit_order' ? C.orderGroupSiblings(S.tickets, t) : [];
      inner = '<div class="pt-banner pt-banner--info">' + icon('banknotes') + ' Charge to <strong>' + esc(t.fundingLabel || t.fundingAccount || '— no funding string —') + '</strong>' + (t.project && !(t.fundingLabel || '').startsWith(t.project) ? ' <span class="pt-muted">(' + esc(t.project) + ')</span>' : '') + '</div>' +
        '<div class="pt-grid-3">' +
          field('purchaseMethod', 'Bought via', '<select data-f="purchaseMethod">' + C.METHODS.map(function (m) { return opt(m.id, m.label, v.purchaseMethod === m.id); }).join('') + '</select>') +
          field('poNumber', 'PO / order #', '<input type="text" data-f="poNumber" placeholder="PO-2026-014, iLab #, Amazon order…" value="' + esc(v.poNumber) + '" autofocus>') +
          field('actualCost', 'Cost of this item on the order ($, optional)', '<input type="number" min="0" step="0.01" data-f="actualCost" value="' + esc(v.actualCost) + '">', 'Per item — the other items on the same PO keep their own estimates.') +
        '</div>' +
        '<div class="pt-grid-3">' +
          field('orderDate', 'Order date', '<input type="date" data-f="orderDate" value="' + esc(v.orderDate) + '">') +
          field('expectedDelivery', 'Expected delivery', '<input type="date" data-f="expectedDelivery" value="' + esc(v.expectedDelivery) + '">') +
          field('poFile', 'PO / confirmation (PDF or image)', '<input type="file" data-file="po" accept="application/pdf,image/*">' + (v._poFile ? '<div class="pt-hint">Selected: ' + esc(v._poFile.name) + '</div>' : (t.poUrl ? '<div class="pt-hint">A file is already attached; choosing another replaces it.</div>' : ''))) +
        '</div>' +
        (cands.length ? '<div class="pt-batch"><div class="pt-sub">Also ordered on this PO from ' + esc(t.vendor) + '</div>' +
          cands.map(function (c) { return '<label class="pt-check"><input type="checkbox" data-batch="' + esc(c.id) + '"' + (v.batch && v.batch[c.id] ? ' checked' : '') + '> <strong>' + esc(c.itemDescription) + '</strong> <span class="pt-muted">' + esc(c.requesterName) + (c.estimatedCost ? ' · ~' + esc(C.fmtMoney(c.estimatedCost)) : '') + (c.fundingAccount ? ' · charge ' + esc(c.fundingAccount) : '') + '</span></label>'; }).join('') + '</div>' : '') +
        (group.length ? '<div class="pt-batch"><label class="pt-check"><input type="checkbox" data-f-group="1"' + (v.applyGroup ? ' checked' : '') + '> Apply the PO #, method, dates and file to the ' + group.length + ' other item' + (group.length > 1 ? 's' : '') + ' on this PO (' + esc(group.map(function (g) { return g.itemDescription; }).join(', ')) + ')</label></div>' : '') +
        field('note', 'Note (optional)', '<input type="text" data-f="note" value="' + esc(v.note) + '">');
    } else if (a === 'receive') {
      inner =
        '<div class="pt-grid-3">' +
          field('quantityReceived', 'Quantity received', '<input type="number" min="0" step="any" data-f="quantityReceived" value="' + esc(v.quantityReceived) + '" autofocus>', t.quantity ? 'Ordered: ' + t.quantity : '') +
          field('actualCost', 'Actual cost ($, optional)', '<input type="number" min="0" step="0.01" data-f="actualCost" value="' + esc(v.actualCost) + '">') +
          field('receiptFile', 'Receipt / packing slip (optional)', '<input type="file" data-file="receipt" accept="application/pdf,image/*">' + (v._receiptFile ? '<div class="pt-hint">Selected: ' + esc(v._receiptFile.name) + '</div>' : '')) +
        '</div>' +
        field('note', 'Note (optional — damaged, partial, wrong item…)', '<input type="text" data-f="note" value="' + esc(v.note) + '">');
    } else if (a === 'place') {
      var locs = C.locationOptions(S.boxes, S.tickets, S.items || []);
      var picked = f.picked;
      inner =
        '<div class="pt-mode">' +
          '<label class="pt-check"><input type="radio" name="pt-mode" data-mode="new"' + (v.mode !== 'restock' ? ' checked' : '') + '> New inventory item</label>' +
          '<label class="pt-check"><input type="radio" name="pt-mode" data-mode="restock"' + (v.mode === 'restock' ? ' checked' : '') + '> Restock an existing item</label>' +
        '</div>' +
        (v.mode === 'restock' ?
          '<div class="pt-field" data-field="inventoryItemId"><label class="pt-label">Which item?</label>' +
            (picked ? '<div class="pt-picked">' + icon('cube') + ' <strong>' + esc(picked.name) + '</strong> <span class="pt-muted">' + esc(picked.vendor || '') + (picked.catalogue_number ? ' · ' + esc(picked.catalogue_number) : '') + ' · ' + esc((picked.locations || []).map(function (l) { return l.name; }).join(', ') || 'no location') + '</span> <button type="button" class="pt-link" data-unpick>change</button></div>' :
              '<input type="search" data-f="q" placeholder="Search inventory by name, vendor or cat#" value="' + esc(v.q) + '" autofocus><div class="pt-results" id="pt-results">' + inventoryResultsHTML(v.q) + '</div>') +
            '<div class="pt-field-err" hidden></div></div>' : '') +
        '<div class="pt-grid-3">' +
          field('location', 'Location *', '<input type="text" data-f="location" list="pt-locs" placeholder="Freezer A drawer 2, Bench 4 cabinet…" value="' + esc(v.location) + '"' + (v.mode === 'restock' ? '' : ' autofocus') + '><datalist id="pt-locs">' + locs.map(function (l) { return '<option value="' + esc(l) + '">'; }).join('') + '</datalist>') +
          field('quantity', 'Quantity put away', '<input type="number" min="0" step="any" data-f="quantity" value="' + esc(v.quantity) + '">') +
          field('unitPrice', 'Unit price ($)', '<input type="number" min="0" step="0.01" data-f="unitPrice" value="' + esc(v.unitPrice) + '">') +
        '</div>' +
        (v.mode === 'restock' ? '' :
          '<div class="pt-grid-3">' +
            field('category', 'Inventory category', '<select data-f="category">' + ['equipment', 'infrastructure', 'consumable', 'computer', 'lab_furniture', 'office', 'research_analysis', 'research_cells', 'research_chem', 'research_gas', 'research_gels', 'research_reagents', 'software', 'other'].map(function (c) { return opt(c, c.replace(/_/g, ' '), v.category === c); }).join('') + '</select>') +
            field('notes', 'Inventory notes (optional)', '<input type="text" data-f="notes" placeholder="lot #, expiry, minimum stock…" value="' + esc(v.notes) + '">') +
            '<div></div>' +
          '</div>') +
        (v.mode === 'restock' && picked && picked.qty_tracked === true && !S.actor.isInvMgr ? '<div class="pt-hint pt-hint--block">' + (typeof picked.qty_remaining === 'number' ? 'This item’s count is tracked. Its location and quantity are updated now; the tracked count itself can only be raised by an inventory manager, so ask one to recount it.' : 'This item’s count is tracked but has never been counted, so only an inventory manager can restock it. Ask one, or put it away as a new item.') + '</div>' : '') +
        field('note', 'Note on the ticket (optional)', '<input type="text" data-f="note" value="' + esc(v.note) + '">');
    } else if (a === 'approve' && !C.str(t.fundingAccount)) {
      // An "Other" project (or a V3.44 ticket with only a tag) gets its funding
      // string here — the purchaser must know what to charge.
      var chosenA = S.fundedProjects.find(function (o) { return o.id === v.projectId; });
      inner = '<div class="pt-banner pt-banner--info">' + icon('banknotes') + ' This request has no funding string yet' + (t.project ? ' (the requester wrote “' + esc(t.project) + '”)' : '') + '. Pick the project it is charged to.</div>' +
        '<div class="pt-grid-3">' + projectField('pt-a-', v.projectId, v.projectId === '__other', { project: v.projectOther }, S.fundedProjects) +
        field('fundingAccount', 'Charged to', '<input type="text" data-charged readonly tabindex="-1" value="' + esc(chosenA ? chosenA.label : '—') + '">') + '<div></div></div>' +
        field('note', 'Note to the requester (optional)', '<textarea data-f="note" rows="2">' + esc(v.note) + '</textarea>');
    } else if (a === 'reassign') {
      // V3.814 — move the charge. The requester (and, past approval, the
      // purchasers) are told by the function; the note travels with the push.
      var chosenR = S.fundedProjects.find(function (o) { return o.id === v.projectId; });
      var cur = t.fundingLabel || t.fundingAccount || t.project || 'nothing yet';
      var late = t.status === 'ordered' || t.status === 'received' || t.status === 'placed';
      inner = '<div class="pt-banner pt-banner--info">' + icon('banknotes') + ' Currently charged to <strong>' + esc(cur) + '</strong>.' + (late ? ' This order has already been placed — the purchaser is told so the charge can be moved.' : '') + ' ' + esc(t.requesterName || 'The requester') + ' will be notified of the change.</div>' +
        '<div class="pt-grid-3">' + projectField('pt-r-', v.projectId, v.projectId === '__other', { project: v.projectOther }, S.fundedProjects) +
        field('fundingAccount', 'Will be charged to', '<input type="text" data-charged readonly tabindex="-1" value="' + esc(chosenR ? chosenR.label : (v.projectId === '__other' ? 'The approver will assign the funding string.' : '—')) + '">') + '<div></div></div>' +
        field('note', 'Why (optional — the requester sees it)', '<textarea data-f="note" rows="2" placeholder="e.g. the startup account is closing; this belongs on the ONR award">' + esc(v.note) + '</textarea>');
    } else if (CONFIRM_ONLY[a]) {
      var warn = { delete: 'This removes the ticket and its history for everyone. Attached files stay in storage.', cancel: 'The approver is told you no longer need it. You can reopen it later.',
                   unapprove: 'It goes back to “awaiting approval”.', unorder: 'It goes back to “approved — to order”.', unreceive: 'It goes back to “on order”.', reopen: 'It goes back to “awaiting approval”.', clear_issue: 'The flag is removed from the ticket.' }[a];
      inner = (warn ? '<p class="pt-muted">' + esc(warn) + '</p>' : '') + field('note', 'Note (optional)', '<input type="text" data-f="note" value="' + esc(v.note) + '" autofocus>');
    } else {
      inner = field('note', NOTE_LABEL[a] || 'Note', '<textarea data-f="note" rows="2" autofocus>' + esc(v.note) + '</textarea>');
    }
    var danger = a === 'deny' || a === 'delete' || a === 'cancel';
    return (
      '<form class="pt-form' + (danger ? ' pt-form--danger' : '') + '" data-form="' + a + '" novalidate>' +
        '<div class="pt-form-title">' + esc(FORM_TITLE[a] || C.ACTION_LABEL[a]) + '</div>' +
        inner +
        '<div class="pt-form-err"' + (f.error && !f.field ? '' : ' hidden') + '>' + esc(f.error || '') + '</div>' +
        '<div class="pt-actions-row">' +
          '<button type="submit" class="btn btn-sm ' + (danger ? 'pt-btn-danger-solid' : 'btn-primary') + '"' + (f.busy ? ' disabled' : '') + '>' + esc(f.busy ? 'Working…' : SUBMIT_LABEL[a]) + '</button>' +
          '<button type="button" class="btn btn-sm" data-form-cancel>Cancel</button>' +
          (f.progress ? '<span class="pt-muted">' + esc(f.progress) + '</span>' : '') +
        '</div>' +
      '</form>'
    );
  }

  function inventoryResultsHTML(q) {
    if (!S.items) return '<div class="pt-muted">Loading inventory…</div>';
    if (!C.str(q)) return '';
    var hits = C.searchInventory(S.items, q, 8);
    if (!hits.length) return '<div class="pt-muted">No matching items.</div>';
    return hits.map(function (it) {
      return '<button type="button" class="pt-result" data-pick="' + esc(it.id) + '"><strong>' + esc(it.name) + '</strong> <span class="pt-muted">' + esc(it.vendor || '') + (it.catalogue_number ? ' · ' + esc(it.catalogue_number) : '') + (it.locations && it.locations.length ? ' · ' + esc(it.locations.map(function (l) { return l.name; }).join(', ')) : '') + '</span></button>';
    }).join('');
  }

  function wireForm(row) {
    var form = $('.pt-form', row); if (!form || !S.form) return;
    var f = S.form, v = f.values, t = ticketById(f.id);
    wireFields(form, v);
    $$('[data-file]', form).forEach(function (inp) {
      inp.addEventListener('change', function () { v['_' + inp.dataset.file + 'File'] = inp.files && inp.files[0] || null; });
    });
    $$('[data-batch]', form).forEach(function (cb) { cb.addEventListener('change', function () { v.batch = v.batch || {}; v.batch[cb.dataset.batch] = cb.checked; }); });
    var grp = $('[data-f-group]', form); if (grp) grp.addEventListener('change', function () { v.applyGroup = grp.checked; });
    $$('[data-mode]', form).forEach(function (r) { r.addEventListener('change', function () { v.mode = r.dataset.mode; renderBody(); }); });
    var q = $('[data-f="q"]', form);
    if (q) q.addEventListener('input', function () { var res = $('#pt-results', form); if (res) { res.innerHTML = inventoryResultsHTML(q.value); wirePicks(form); } });
    wirePicks(form);
    var un = $('[data-unpick]', form); if (un) un.addEventListener('click', function () { f.picked = null; v.inventoryItemId = ''; v.q = ''; renderBody(); });
    $('[data-form-cancel]', form).addEventListener('click', function () { dropDraft(S.form); S.form = null; renderBody(); });
    form.addEventListener('submit', function (e) { e.preventDefault(); submitForm(t, form); });
    form.addEventListener('keydown', function (e) { if (e.key === 'Escape') { dropDraft(S.form); S.form = null; renderBody(); } });
    if (f.error && f.field) showFieldError(form, f.field, f.error);
  }
  function wirePicks(form) {
    $$('[data-pick]', form).forEach(function (b) {
      b.addEventListener('click', function () {
        var it = (S.items || []).find(function (i) { return i.id === b.dataset.pick; });
        if (!it) return;
        S.form.picked = it; S.form.values.inventoryItemId = it.id;
        if (!S.form.values.location && it.locations && it.locations[0]) S.form.values.location = it.locations[0].name;
        renderBody();
      });
    });
  }

  async function submitForm(t, form) {
    var f = S.form; if (!f || f.busy) return;
    // A live-sync refresh may have replaced S.tickets while this form was open
    // (renders defer, data does not) — act on the CURRENT object, not the one
    // captured when the form was wired.
    t = ticketById(f.id) || t; if (!t) return;
    var a = f.action, v = f.values;
    var setBusy = function (b, msg) { f.busy = b; f.progress = msg || ''; var btn = $('button[type=submit]', form); if (btn) { btn.disabled = b; btn.textContent = b ? (msg || 'Working…') : SUBMIT_LABEL[a]; } };
    var fail = function (msg, fieldKey, rowIdx) { setBusy(false); f.error = msg; f.field = fieldKey || null; showFieldError(form, fieldKey, msg, rowIdx); };
    var badF = badNumberField(form);
    if (badF) { fail('That is not a number.', badF); return; }
    if (a === 'edit') { var chk = C.validateRequest(Object.assign({}, v, { _legacyPurchaseType: !C.str(t.purchaseType) && !C.str(v.purchaseType) })); if (chk.error) { fail(chk.error, chk.field, chk.row); return; } }
    if (a === 'approve' && !C.str(t.fundingAccount) && !C.str(v.fundingAccount)) { fail('Pick the project this is charged to — the purchaser needs its funding string.', 'projectId'); return; }
    if (a === 'place' && v.mode === 'restock' && !f.picked) { fail('Pick the inventory item to restock.', 'inventoryItemId'); return; }
    if (a === 'place' && !C.str(v.location)) { fail('Where did it go? A location is required.', 'location'); return; }
    if (a === 'place') { var pq = C.placeQty(t, v), pp = C.placePrice(t, v); if (pq.error) { fail(pq.error, pq.field); return; } if (pp.error) { fail(pp.error, pp.field); return; } }
    if (a === 'place' && v.mode === 'restock' && f.picked.qty_tracked === true && typeof f.picked.qty_remaining !== 'number' && !S.actor.isInvMgr) {
      fail('This tracked item has never been counted, so only an inventory manager can restock it — ask one, or put it away as a new item.', 'inventoryItemId'); return;
    }
    setBusy(true);
    var stamp = stampNow();
    try {
      // V3.881 — the PO / receipt is filed in Receipts too, linked to every request it covers; the request keeps its link as before.
      if ((a === 'order' || a === 'edit_order') && v._poFile) {
        setBusy(true, 'Uploading PO…');
        var poIds = [t.id].concat(Object.keys(v.batch || {}).filter(function (k) { return v.batch[k]; }));
        var up = await uploadDoc(v._poFile, { kind: 'po', source: 'order', ticketIds: poIds, poNumber: v.poNumber || t.poNumber, keepFileOnFail: true });
        v.poUrl = up.url; v.poStoragePath = up.path;
        if (up.recordError) toast('The PO is attached to the request, but it could not be added to Receipts', 'warn', up.recordError.message);
      }
      if (a === 'receive' && v._receiptFile) {
        setBusy(true, 'Uploading receipt…');
        var rIds = [t.id].concat(C.orderSiblings(t, S.tickets).map(function (x) { return x.id; }));
        var up2 = await uploadDoc(v._receiptFile, { kind: 'receipt', source: 'receive', ticketIds: rIds, keepFileOnFail: true });
        v.receiptUrl = up2.url; v.receiptStoragePath = up2.path;
        if (up2.recordError) toast('The receipt is attached to the request, but it could not be added to Receipts', 'warn', up2.recordError.message);
      }
      var ledgerNote = '', afterPlace = null;
      // Put-away is ONE batch: the inventory write, the usage row and the ticket
      // move land together or not at all — so two people putting the same box
      // away, or a retry after a refused ticket move, cannot double the stock.
      var placeBatch = null;
      if (a === 'place') {
        setBusy(true, 'Updating inventory…');
        suppress(6000);
        placeBatch = db().batch();
        if (v.mode === 'restock') {
          var plan = C.restockPlan(f.picked, t, v, S.actor, stamp);
          placeBatch.update(db().collection('inventory').doc(f.picked.id), plan.patch);
          if (plan.usage) placeBatch.set(db().collection('inventoryUsage').doc(), plan.usage);
          v.inventoryItemId = f.picked.id;
          var pk = f.picked;
          afterPlace = function () { Object.keys(plan.patch).forEach(function (k) { if (plan.patch[k] !== stamp) pk[k] = plan.patch[k]; }); };
          ledgerNote = pk.qty_tracked === true && !plan.ledgerRaised ? ' (its tracked count was not raised — ask an inventory manager to recount)' : '';
        } else {
          var data = C.newInventoryItem(t, v, S.actor, stamp);
          var newRef = db().collection('inventory').doc();
          placeBatch.set(newRef, data);
          v.inventoryItemId = newRef.id;
          afterPlace = function () { if (S.items) S.items.push(Object.assign({ id: newRef.id }, data)); };
        }
      }
      var r = C.buildPatch(a, t, v, S.actor, Date.now(), stamp);
      if (r.error) { fail(r.error, r.field, r.row); return; }
      if (placeBatch) {
        var mirrorPlace = await writeTicket(t, r, stamp, placeBatch);
        suppress(); await placeBatch.commit();
        mirrorPlace(); if (afterPlace) afterPlace();
        try { await api.invalidate('inventory/items.json'); } catch (e) {}
        await api.invalidate('procurement/tickets.json');
        dropDraft(f); S.form = null;
        toast('Put away and recorded in inventory' + ledgerNote, ledgerNote ? 'warn' : 'success');
        render(true); return;
      }
      if (r.deleteDoc) {
        suppress();
        await db().collection('procurementTickets').doc(t.id).delete();
        await api.invalidate('procurement/tickets.json');
        S.tickets = S.tickets.filter(function (x) { return x.id !== t.id; });
        delete S.expanded[t.id]; dropDraft(f); S.form = null;
        toast('Ticket deleted'); render(true); return;
      }
      var siblings = a === 'order' ? Object.keys(v.batch || {}).filter(function (id) { return v.batch[id]; }).map(ticketById).filter(Boolean)
                   : (a === 'edit_order' && v.applyGroup) ? C.orderGroupSiblings(S.tickets, t) : [];
      if (siblings.length) {
        var groupId = a === 'order' ? C.genId() : (t.orderGroupId || C.genId());
        r = C.buildPatch(a, t, Object.assign({}, v, { orderGroupId: groupId }), S.actor, Date.now(), stamp);
        if (r.error) { fail(r.error, r.field); return; }
        var batch = db().batch(), mirrors = [];
        mirrors.push(await writeTicket(t, r, stamp, batch));
        for (var i = 0; i < siblings.length; i++) {
          var sv = { poNumber: v.poNumber, purchaseMethod: v.purchaseMethod, orderDate: v.orderDate, expectedDelivery: v.expectedDelivery, poUrl: v.poUrl, poStoragePath: v.poStoragePath, orderGroupId: groupId, note: v.note };
          var sr = C.buildPatch(a, siblings[i], sv, S.actor, Date.now(), stamp);
          if (sr.error) { fail(sr.error + ' (' + siblings[i].itemDescription + ')'); return; }
          mirrors.push(await writeTicket(siblings[i], sr, stamp, batch));
        }
        suppress(); await batch.commit();
        mirrors.forEach(function (m) { if (m) m(); });
      } else {
        await writeTicket(t, r, stamp);
      }
      await api.invalidate('procurement/tickets.json');
      dropDraft(f); S.form = null;
      var said = { approve: 'Approved — the requester has been notified', ask: 'Question sent', answer: 'Answer sent — back to the approver', deny: 'Denied — the requester has been notified',
        order: 'Marked ordered' + (siblings.length ? ' (' + (siblings.length + 1) + ' items on one PO)' : ''), receive: 'Marked received — now put it away',
        cancel: 'Request withdrawn', note: 'Note added', flag: 'Problem flagged — purchasers notified',
        edit: r.to === 'requested' && t.status !== 'requested' ? (t.status === 'needs_info' ? 'Updated — sent back as your answer' : 'Updated — sent back for approval') : 'Request updated',
        edit_order: 'Order updated' + (siblings.length ? ' on all ' + (siblings.length + 1) + ' items' : ''), unorder: 'Order undone — back to “approved”', unapprove: 'Approval undone — back to “awaiting approval”',
        unreceive: 'Receipt undone — back to “on order”', reopen: 'Reopened — back in the approval queue', clear_issue: 'Flag cleared',
        reassign: 'Funding changed — ' + (t.requesterName || 'the requester') + ' has been notified' }[a] || 'Done';
      toast(said, 'success');
      render(true);   // tabs and the status counts change with every move
    } catch (err) {
      console.warn('[procurement] ' + a + ' failed:', err);
      var msg = (err && err.code === 'permission-denied') ? 'The server refused this change — your role may not allow it, or the ticket moved on. Reload and try again.' : (err && err.message) || String(err);
      fail(msg);
    }
  }

  /* ─── Report ────────────────────────────────────────────── */
  /* ─── V3.881: receipts, requisitions and other order documents ───────
   * Alex: "a way for the person doing the procurement to load in the receipt
   * or requisition printout to the site, later we can collect these and use
   * them to auto injest the items into the inventory." Three doors, one list:
   * the Receipts tab (load any number, link them to requests), a request's
   * Attach, and the Order / Receive forms (uploadDoc above). Every form is
   * inline; delete asks in the row, never in a browser dialog. */
  function canAttach(t) { return canFileDocs() && ['approved', 'ordered', 'received', 'placed'].indexOf(t.status) >= 0; }
  function isImageDoc(d) { return /^image\//.test(d.contentType || '') || /\.(jpe?g|png|gif|webp|heic|heif|tiff?)$/i.test(d.fileName || ''); }
  function fileSize(n) { n = +n || 0; return n >= 1048576 ? (n / 1048576).toFixed(1) + ' MB' : Math.max(1, Math.round(n / 1024)) + ' KB'; }
  function kindOptions(sel) { return C.DOC_KIND_IDS.map(function (k) { return opt(k, C.docKindLabel(k), sel === k); }).join(''); }

  /** The request card's list of its documents (everyone who sees the request sees these). */
  function ticketDocsHTML(t) {
    var list = C.docsForTicket(S.docs, t.id);
    if (!list.length) return '';
    return '<div class="pt-docs-card"><div class="pt-sub">Receipts &amp; documents</div><ul class="pt-doc-mini">' + list.map(function (d) {
      return '<li><span class="pt-doc-kind">' + esc(C.docKindLabel(d.kind)) + '</span> <a class="pt-doc-file" href="' + esc(d.url) + '" target="_blank" rel="noopener">' +
        icon(isImageDoc(d) ? 'photo' : 'document-text') + ' ' + esc(d.fileName) + '</a> <span class="pt-muted">' + esc(C.fmtDateLong(d.uploadedAt)) +
        (d.uploadedByName ? ' · ' + esc(d.uploadedByName) : '') + (d.note ? ' · ' + esc(d.note) : '') + '</span></li>';
    }).join('') + '</ul></div>';
  }

  /** Chosen files, each checked before anything uploads (a red row explains itself). */
  function filesListHTML(files) {
    if (!files.length) return '';
    return '<ul class="pt-doc-files" data-files-list>' + files.map(function (f, i) {
      var chk = C.checkDocFile(f);
      return '<li' + (chk.error ? ' class="is-bad"' : '') + '>' + icon(/^image\//.test(chk.contentType || '') ? 'photo' : 'document-text') +
        '<span class="pt-doc-fname">' + esc(f.name) + '</span><span class="pt-muted">' + esc(chk.error || fileSize(f.size)) + '</span>' +
        '<button type="button" class="pt-doc-x" data-rm-file="' + i + '" aria-label="Remove ' + esc(f.name) + '" title="Remove">' + icon('x-mark') + '</button></li>';
    }).join('') + '</ul>';
  }
  function firstBadFile(files) { for (var i = 0; i < files.length; i++) { var c = C.checkDocFile(files[i]); if (c.error) return c.error; } return ''; }

  /* ── a request's Attach ── */
  function attachHTML(t) {
    var a = S.attach, sib = C.orderSiblings(t, S.tickets);
    return '<form class="pt-form pt-attach" data-attach-form novalidate>' +
      '<div class="pt-form-title">Attach a receipt or requisition</div>' +
      '<div class="pt-grid-3">' +
        field('kind', 'What is it?', '<select data-a="kind">' + kindOptions(a.kind) + '</select>') +
        field('files', 'File(s)', '<input type="file" multiple accept="application/pdf,image/*" data-a-files>', 'PDF or a photo, up to 20 MB each') +
        field('note', 'Note (optional)', '<input type="text" data-a="note" value="' + esc(a.note) + '" placeholder="e.g. box 1 of 2">') +
      '</div>' +
      '<div data-files-host>' + filesListHTML(a.files) + '</div>' +
      (sib.length ? '<label class="pt-check pt-attach-sib"><input type="checkbox" data-a-sib' + (a.linkSiblings ? ' checked' : '') + '> Also link the ' + sib.length + ' other request' + (sib.length === 1 ? '' : 's') +
        ' on this order: ' + esc(sib.slice(0, 3).map(function (x) { return x.itemDescription; }).join(', ') + (sib.length > 3 ? '…' : '')) + '</label>' : '') +
      '<div class="pt-form-err"' + (a.error ? '' : ' hidden') + '>' + esc(a.error || '') + '</div>' +
      '<div class="pt-actions-row">' +
        '<button type="submit" class="btn btn-sm btn-primary"' + (a.busy ? ' disabled' : '') + '>' + esc(a.busy ? (a.progress || 'Uploading…') : 'Upload') + '</button>' +
        '<button type="button" class="btn btn-sm" data-a-cancel>Cancel</button>' +
      '</div>' +
    '</form>';
  }
  function wireAttach(row) {
    var form = $('[data-attach-form]', row); if (!form || !S.attach) return;
    var a = S.attach;
    var paint = function () { $('[data-files-host]', form).innerHTML = filesListHTML(a.files); };
    $$('[data-a]', form).forEach(function (el) { el.addEventListener(el.tagName === 'SELECT' ? 'change' : 'input', function () { a[el.dataset.a] = el.value; }); });
    var fi = $('[data-a-files]', form);
    fi.addEventListener('change', function () { a.files = a.files.concat(Array.prototype.slice.call(fi.files || [])); fi.value = ''; a.error = ''; paint(); });
    form.addEventListener('click', function (e) { var rm = e.target.closest('[data-rm-file]'); if (rm) { a.files.splice(+rm.dataset.rmFile, 1); paint(); } });
    var sb = $('[data-a-sib]', form); if (sb) sb.addEventListener('change', function () { a.linkSiblings = sb.checked; });
    $('[data-a-cancel]', form).addEventListener('click', function () { S.attach = null; renderBody(); });
    form.addEventListener('keydown', function (e) { if (e.key === 'Escape') { S.attach = null; renderBody(); } });
    form.addEventListener('submit', async function (e) {
      e.preventDefault();
      if (a.busy) return;
      var t = ticketById(a.id); if (!t) return;
      var err = !a.files.length ? 'Choose a file to attach.' : firstBadFile(a.files);
      if (err) { a.error = err; showFieldError(form, null, err); return; }
      var ids = [t.id].concat(a.linkSiblings ? C.orderSiblings(t, S.tickets).map(function (x) { return x.id; }) : []);
      var btn = $('button[type=submit]', form), files = a.files.slice(), failed = [], done = 0;
      a.busy = true; btn.disabled = true;
      for (var i = 0; i < files.length; i++) {
        btn.textContent = a.progress = 'Uploading ' + (i + 1) + ' of ' + files.length + '…';
        try { await uploadDoc(files[i], { kind: a.kind, note: a.note, ticketIds: ids, source: 'upload' }); done++; }
        catch (x) { failed.push({ file: files[i], msg: (x && x.message) || String(x) }); }
      }
      if (failed.length) S.attach = Object.assign(a, { busy: false, progress: '', files: failed.map(function (f) { return f.file; }), error: 'Not uploaded: ' + failed.map(function (f) { return f.file.name + ' (' + f.msg + ')'; }).join('; ') });
      else S.attach = null;
      if (done) toast(done + (done === 1 ? ' file' : ' files') + ' attached' + (ids.length > 1 ? ' to ' + ids.length + ' requests' : ''));
      renderBody();
    });
  }

  /* ── the request picker (upload and edit) ── */
  function matchTicket(t, words) {
    var hay = [t.itemDescription, t.requesterName, t.vendor, t.poNumber, t.catalogueNumber].join(' ').toLowerCase();
    return words.every(function (w) { return hay.indexOf(w) >= 0; });
  }
  function linkListHTML(st) {
    var words = String(st.q || '').toLowerCase().split(/\s+/).filter(Boolean);
    var chosen = Object.keys(st.sel).filter(function (k) { return st.sel[k]; }).map(ticketById).filter(Boolean);
    var rest = C.docLinkCandidates(S.tickets).filter(function (t) { return !st.sel[t.id] && matchTicket(t, words); });
    var shown = rest.slice(0, 8);
    if (!chosen.length && !shown.length) return '<div class="pt-muted">' + (words.length ? 'No request matches.' : 'No approved, ordered or arrived requests.') + '</div>';
    return chosen.concat(shown).map(function (t) {
      var meta = [t.requesterName, t.vendor, t.poNumber ? 'PO ' + t.poNumber : '', (C.STATUS[t.status] || {}).short].filter(Boolean).join(' · ');
      return '<label class="pt-check pt-linkrow"><input type="checkbox" data-link="' + esc(t.id) + '"' + (st.sel[t.id] ? ' checked' : '') + '>' +
        '<span><strong>' + esc(t.itemDescription || '(no item)') + '</strong> <span class="pt-muted">' + esc(meta) + '</span></span></label>';
    }).join('') + (rest.length > shown.length ? '<div class="pt-muted">' + (rest.length - shown.length) + ' more; search to narrow.</div>' : '');
  }
  function linkPickerHTML(st) {
    return '<div class="pt-field pt-linkpick" data-field="links"><span class="pt-label">Which requests do they cover? <span class="pt-muted">(optional)</span></span>' +
      '<input type="search" data-link-q placeholder="Search requests by item, person, vendor or PO…" value="' + esc(st.q || '') + '" aria-label="Search requests to link">' +
      '<div class="pt-linklist" data-link-list>' + linkListHTML(st) + '</div></div>';
  }
  /* Choosing a request fills a blank PO # / vendor from it (inputs carry data-<prefix>="poNumber"/"vendor"). */
  function wireLinkPicker(scope, st, prefix) {
    var q = $('[data-link-q]', scope), list = $('[data-link-list]', scope);
    if (!q || !list) return;
    q.addEventListener('input', function () { st.q = q.value; list.innerHTML = linkListHTML(st); });
    list.addEventListener('change', function (e) {
      var cb = e.target.closest('[data-link]'); if (!cb) return;
      st.sel[cb.dataset.link] = cb.checked;
      var t = ticketById(cb.dataset.link);
      var vals = st.values || st;
      if (cb.checked && t) {
        ['poNumber', 'vendor'].forEach(function (k) {
          if (!C.str(vals[k]) && C.str(t[k])) { vals[k] = t[k]; var inp = $('[data-' + prefix + '="' + k + '"]', scope); if (inp) inp.value = t[k]; }
        });
      }
    });
  }

  /* ── the Receipts tab ── */
  function newDocUp() { return { files: [], kind: 'receipt', poNumber: '', vendor: '', docDate: '', note: '', sel: {}, q: '', busy: false, error: '' }; }
  function knownValues(key) {
    var seen = {}, out = [];
    S.tickets.concat(S.docs).forEach(function (x) { var v = C.str(x[key]); if (v && !seen[v.toLowerCase()]) { seen[v.toLowerCase()] = 1; out.push(v); } });
    return out.sort().slice(0, 300);
  }
  function datalist(id, vals) { return '<datalist id="' + id + '">' + vals.map(function (v) { return '<option value="' + esc(v) + '">'; }).join('') + '</datalist>'; }
  function upFormHTML(u) {
    var n = u.files.length;
    return '<form class="pt-form pt-docs-form" data-up-form novalidate>' +
      '<div data-files-host>' + filesListHTML(u.files) + '</div>' +
      '<div class="pt-grid-3">' +
        field('kind', 'What ' + (n === 1 ? 'is it' : 'are they') + '?', '<select data-u="kind">' + kindOptions(u.kind) + '</select>') +
        field('poNumber', 'PO / order # (optional)', '<input type="text" data-u="poNumber" list="pt-doc-pos" value="' + esc(u.poNumber) + '">' + datalist('pt-doc-pos', knownValues('poNumber'))) +
        field('vendor', 'Vendor (optional)', '<input type="text" data-u="vendor" list="pt-doc-vendors" value="' + esc(u.vendor) + '">' + datalist('pt-doc-vendors', knownValues('vendor'))) +
        field('docDate', 'Date on it (optional)', '<input type="date" data-u="docDate" value="' + esc(u.docDate) + '">') +
        field('note', 'Note (optional)', '<input type="text" data-u="note" value="' + esc(u.note) + '" placeholder="e.g. department requisition copy">') +
      '</div>' +
      linkPickerHTML(u) +
      '<div class="pt-form-err"' + (u.error ? '' : ' hidden') + '>' + esc(u.error || '') + '</div>' +
      '<div class="pt-actions-row">' +
        '<button type="submit" class="btn btn-sm btn-primary"' + (u.busy ? ' disabled' : '') + '>' + icon('arrow-up-tray') + ' Upload ' + n + (n === 1 ? ' file' : ' files') + '</button>' +
        '<button type="button" class="btn btn-sm" data-up-clear>Clear</button>' +
      '</div>' +
    '</form>';
  }
  function docRowHTML(d) {
    var linked = (d.ticketIds || []).map(ticketById).filter(Boolean);
    var meta = [d.docDate ? C.fmtDateLong(d.docDate) : '', d.vendor, d.poNumber ? 'PO ' + d.poNumber : ''].filter(Boolean).join(' · ');
    var mine = d.uploadedBy && d.uploadedBy === S.actor.uid;
    var canEdit = !d.legacy && (canFileDocs() || mine);
    var canDel = !d.legacy && (S.actor.isAdmin || mine);
    var h = '<div class="pt-doc' + (d.legacy ? ' is-legacy' : '') + '" data-doc="' + esc(d.id) + '">' +
      '<div class="pt-doc-main">' +
        '<span class="pt-doc-kind">' + esc(C.docKindLabel(d.kind)) + '</span>' +
        '<a class="pt-doc-file" href="' + esc(d.url) + '" target="_blank" rel="noopener">' + icon(isImageDoc(d) ? 'photo' : 'document-text') + ' ' + esc(d.fileName) + '</a>' +
        (meta ? '<span class="pt-muted">' + esc(meta) + '</span>' : '') +
        (d.ingestStatus === 'pending' ? '<span class="pt-doc-ingest">Not yet in inventory</span>' : '<span class="pt-doc-ingest is-done">In inventory</span>') +
      '</div>' +
      (linked.length ? '<div class="pt-doc-links">For ' + linked.map(function (t) {
        return '<a href="' + esc(ticketUrl(t.id)) + '">' + esc(t.itemDescription || '(no item)') + '</a>' + (t.requesterName ? ' <span class="pt-muted">(' + esc(t.requesterName) + ')</span>' : '');
      }).join(', ') + '</div>' : '<div class="pt-doc-links pt-muted">Not linked to a request</div>') +
      (d.note ? '<div class="pt-doc-note">' + esc(d.note) + '</div>' : '') +
      '<div class="pt-doc-foot"><span class="pt-muted">' + (d.legacy ? 'Attached to the request when it was ' + (d.kind === 'po' ? 'ordered' : 'received') : 'Uploaded') +
        (d.uploadedByName ? ' by ' + esc(d.uploadedByName) : '') + (C.toMs(d.uploadedAt) ? ' · ' + esc(C.fmtDateLong(d.uploadedAt)) : '') + '</span>' +
        (canEdit || canDel ? '<span class="pt-doc-btns">' +
          (canEdit ? '<button type="button" class="btn btn-sm pt-btn-ghost" data-doc-edit>' + icon('pencil-square') + ' Edit</button>' : '') +
          (canDel ? '<button type="button" class="btn btn-sm pt-btn-ghost" data-doc-del>' + icon('trash') + ' Delete</button>' : '') + '</span>' : '') +
      '</div>';
    if (S.docDel === d.id) {
      h += '<div class="pt-doc-confirm">Delete this document? It leaves this list and its requests.' +
        '<button type="button" class="btn btn-sm pt-btn-danger-solid" data-doc-del-yes>Delete</button><button type="button" class="btn btn-sm" data-doc-del-no>Keep it</button></div>';
    }
    if (S.docEdit && S.docEdit.id === d.id) h += docEditHTML(S.docEdit);
    return h + '</div>';
  }
  function docEditHTML(e) {
    var v = e.values;
    return '<form class="pt-form pt-doc-edit" data-doc-edit-form novalidate>' +
      '<div class="pt-grid-3">' +
        field('kind', 'What is it?', '<select data-e="kind">' + kindOptions(v.kind) + '</select>') +
        field('poNumber', 'PO / order #', '<input type="text" data-e="poNumber" list="pt-doc-pos-e" value="' + esc(v.poNumber) + '">' + datalist('pt-doc-pos-e', knownValues('poNumber'))) +
        field('vendor', 'Vendor', '<input type="text" data-e="vendor" list="pt-doc-vendors-e" value="' + esc(v.vendor) + '">' + datalist('pt-doc-vendors-e', knownValues('vendor'))) +
        field('docDate', 'Date on it', '<input type="date" data-e="docDate" value="' + esc(v.docDate) + '">') +
        field('note', 'Note', '<input type="text" data-e="note" value="' + esc(v.note) + '">') +
      '</div>' +
      linkPickerHTML(e) +
      '<div class="pt-form-err"' + (e.error ? '' : ' hidden') + '>' + esc(e.error || '') + '</div>' +
      '<div class="pt-actions-row"><button type="submit" class="btn btn-sm btn-primary"' + (e.busy ? ' disabled' : '') + '>Save</button><button type="button" class="btn btn-sm" data-doc-edit-cancel>Cancel</button></div>' +
    '</form>';
  }

  function renderDocs(body) {
    if (!S.docUp) S.docUp = newDocUp();
    var u = S.docUp;
    var all = C.docRows(S.docs, S.tickets);
    var rows = C.searchDocs(all, S.q, S.tickets);
    var pending = all.filter(function (d) { return d.ingestStatus === 'pending'; }).length;
    body.innerHTML =
      '<section class="pt-card pt-docs-up">' +
        '<div class="pt-docs-drop" data-drop>' +
          '<span class="pt-docs-drop-icon">' + icon('arrow-up-tray') + '</span>' +
          '<div><strong>Load receipts and requisition printouts</strong>' +
            '<div class="pt-muted">Drop them here, or <label class="pt-docs-pick">choose files<input type="file" multiple accept="application/pdf,image/*" data-up-files hidden></label>. ' +
            'PDF or a photo, up to 20 MB each; on a phone you can take the photo now. They are kept here to be read into the inventory later.</div></div>' +
        '</div>' +
        (u.files.length ? upFormHTML(u) : '') +
      '</section>' +
      '<div class="pt-docs-head"><span class="pt-sub">All documents</span><span class="pt-muted">' + all.length + (all.length === 1 ? ' document' : ' documents') +
        ' · ' + pending + ' not yet in inventory' + (S.q ? ' · ' + rows.length + ' match “' + esc(S.q) + '”' : '') + '</span></div>' +
      (rows.length ? '<div class="pt-docs-list">' + rows.map(docRowHTML).join('') + '</div>'
                   : '<div class="empty-state">' + (S.q ? 'No documents match.' : 'Nothing loaded yet.') + '</div>');
    wireDocs(body);
  }

  function wireDocs(body) {
    var u = S.docUp;
    var addFiles = function (list) { if (!list || !list.length) return; u.files = u.files.concat(Array.prototype.slice.call(list)); u.error = ''; renderDocs(body); };
    var pick = $('[data-up-files]', body); if (pick) pick.addEventListener('change', function () { addFiles(pick.files); });
    var drop = $('[data-drop]', body);
    if (drop) {
      ['dragenter', 'dragover'].forEach(function (ev) { drop.addEventListener(ev, function (e) { e.preventDefault(); drop.classList.add('is-over'); }); });
      drop.addEventListener('dragleave', function () { drop.classList.remove('is-over'); });
      drop.addEventListener('drop', function (e) { e.preventDefault(); drop.classList.remove('is-over'); addFiles(e.dataTransfer && e.dataTransfer.files); });
    }
    var form = $('[data-up-form]', body);
    if (form) {
      $$('[data-u]', form).forEach(function (el) { el.addEventListener(el.tagName === 'SELECT' ? 'change' : 'input', function () { u[el.dataset.u] = el.value; }); });
      wireLinkPicker(form, u, 'u');
      form.addEventListener('click', function (e) { var rm = e.target.closest('[data-rm-file]'); if (rm) { u.files.splice(+rm.dataset.rmFile, 1); renderDocs(body); } });
      $('[data-up-clear]', form).addEventListener('click', function () { S.docUp = newDocUp(); renderDocs(body); });
      form.addEventListener('submit', function (e) { e.preventDefault(); uploadAll(form, body); });
    }
    $$('[data-doc]', body).forEach(function (row) {
      var id = row.dataset.doc, d = S.docs.find(function (x) { return x.id === id; });
      var on = function (sel, fn) { var b = $(sel, row); if (b) b.addEventListener('click', fn); };
      on('[data-doc-edit]', function () {
        if (S.docEdit && S.docEdit.id === id) { S.docEdit = null; renderDocs(body); return; }
        var sel = {}; (d.ticketIds || []).forEach(function (t) { sel[t] = true; });
        S.docEdit = { id: id, values: { kind: d.kind, poNumber: d.poNumber || '', vendor: d.vendor || '', docDate: d.docDate || '', note: d.note || '' }, sel: sel, q: '', busy: false, error: '' };
        S.docDel = null; renderDocs(body);
      });
      on('[data-doc-del]', function () { S.docDel = S.docDel === id ? null : id; S.docEdit = null; renderDocs(body); });
      on('[data-doc-del-no]', function () { S.docDel = null; renderDocs(body); });
      on('[data-doc-del-yes]', function () { deleteDoc(d, body); });
      var ef = $('[data-doc-edit-form]', row);
      if (ef && S.docEdit) {
        var ed = S.docEdit;
        $$('[data-e]', ef).forEach(function (el) { el.addEventListener(el.tagName === 'SELECT' ? 'change' : 'input', function () { ed.values[el.dataset.e] = el.value; }); });
        wireLinkPicker(ef, ed, 'e');
        $('[data-doc-edit-cancel]', ef).addEventListener('click', function () { S.docEdit = null; renderDocs(body); });
        ef.addEventListener('submit', function (e) { e.preventDefault(); saveDocEdit(d, ef, body); });
      }
    });
  }

  async function uploadAll(form, body) {
    var u = S.docUp;
    if (u.busy) return;
    var err = !u.files.length ? 'Choose a file.' : (firstBadFile(u.files) ? 'Remove the files marked in red first: ' + firstBadFile(u.files) : '');
    if (err) { u.error = err; showFieldError(form, null, err); return; }
    var ids = Object.keys(u.sel).filter(function (k) { return u.sel[k]; });
    var btn = $('button[type=submit]', form), files = u.files.slice(), failed = [], done = 0;
    u.busy = true; btn.disabled = true;
    for (var i = 0; i < files.length; i++) {
      btn.textContent = 'Uploading ' + (i + 1) + ' of ' + files.length + '…';
      try { await uploadDoc(files[i], { kind: u.kind, poNumber: u.poNumber, vendor: u.vendor, docDate: u.docDate, note: u.note, ticketIds: ids, source: 'upload' }); done++; }
      catch (x) { failed.push({ file: files[i], msg: (x && x.message) || String(x) }); }
    }
    if (failed.length) S.docUp = Object.assign(u, { busy: false, files: failed.map(function (f) { return f.file; }), error: 'Not uploaded: ' + failed.map(function (f) { return f.file.name + ' (' + f.msg + ')'; }).join('; ') });
    else S.docUp = newDocUp();
    if (done) toast(done + (done === 1 ? ' document' : ' documents') + ' added' + (ids.length ? ', linked to ' + ids.length + (ids.length === 1 ? ' request' : ' requests') : ''));
    renderDocs(body);
  }

  async function saveDocEdit(d, form, body) {
    var e = S.docEdit; if (!e || e.busy) return;
    var patch = C.docEditPatch(Object.assign({}, e.values, { ticketIds: Object.keys(e.sel).filter(function (k) { return e.sel[k]; }) }), stampNow());
    e.busy = true;
    try {
      await db().collection('procurementDocs').doc(d.id).update(patch);
      Object.keys(patch).forEach(function (k) { if (k !== 'updatedAt') d[k] = patch[k]; });
      S.docEdit = null;
      toast('Document updated');
    } catch (x) {
      e.busy = false; e.error = 'Not saved: ' + ((x && x.message) || x);
    }
    renderDocs(body);
  }

  async function deleteDoc(d, body) {
    try {
      await db().collection('procurementDocs').doc(d.id).delete();
      // The file itself: storage.rules gives procurement/** no delete path, so this usually refuses; the record is what lists it.
      try { if (firebase.storage && d.storagePath) await firebase.storage().ref().child(d.storagePath).delete(); } catch (e) { /* kept in storage */ }
      S.docs = S.docs.filter(function (x) { return x.id !== d.id; });
      S.docDel = null;
      toast('Document deleted');
    } catch (x) {
      toast('Could not delete it', 'error', (x && x.message) || String(x));
    }
    renderDocs(body);
  }

  function renderReport(body) {
    if (!S.report.init) { S.report.init = true; S.report.from = C.fiscalYearStart(); S.report.to = C.todayStr(); }
    var inverted = S.report.from && S.report.to && S.report.from > S.report.to;
    var sum = C.summarize(S.tickets, { from: S.report.from, to: S.report.to });
    var row = function (r, k) { return '<tr><td>' + esc(k === 'label' ? (r.account + (r.label && r.label !== r.account ? ' — ' + r.label : '')) : r[k]) + '</td><td class="num">' + r.count + '</td><td class="num">' + esc(C.fmtMoney(r.committed)) + '</td><td class="num">' + esc(C.fmtMoney(r.spent)) + '</td><td class="num"><strong>' + esc(C.fmtMoney(r.committed + r.spent)) + '</strong></td></tr>'; };
    var table = function (title, rows, k) {
      return '<div class="pt-card"><div class="pt-sub">' + esc(title) + '</div>' + (rows.length ?
        '<div class="pt-table-wrap"><table class="pt-table"><thead><tr><th>' + esc(k === 'label' ? 'Funding string' : k === 'project' ? 'Project' : 'Category') + '</th><th class="num">Tickets</th><th class="num">Committed</th><th class="num">Spent</th><th class="num">Total</th></tr></thead><tbody>' +
        rows.map(function (r) { return row(r, k); }).join('') + '</tbody></table></div>' : '<div class="pt-muted">' + (inverted ? 'The From date is after the To date.' : 'Nothing in this period.') + '</div>') + '</div>';
    };
    body.innerHTML =
      '<div class="pt-report-bar">' +
        '<label>From <input type="date" id="pt-rep-from" value="' + esc(S.report.from) + '"></label>' +
        '<label>To <input type="date" id="pt-rep-to" value="' + esc(S.report.to) + '"></label>' +
        '<span class="pt-muted">' + sum.totals.count + ' tickets · committed ' + esc(C.fmtMoney(sum.totals.committed)) + ' · spent ' + esc(C.fmtMoney(sum.totals.spent)) + (sum.totals.pending ? ' · ' + sum.totals.pending + ' awaiting approval' : '') + '</span>' +
        '<button type="button" class="btn btn-sm" id="pt-rep-csv">' + icon('arrow-down-tray') + ' Export CSV</button>' +
      '</div>' +
      '<div class="pt-hint" style="margin:0 0 10px">Committed = requested, approved and on-order (estimates, or the order total when known). Spent = received and placed (actual cost when recorded). Denied and withdrawn tickets are excluded. Period is by request date.</div>' +
      table('By project', sum.byProject, 'project') + table('By funding string', sum.byAccount, 'label') + table('By category', sum.byCategory, 'category');
    var upd = function () { S.report.from = $('#pt-rep-from').value; S.report.to = $('#pt-rep-to').value; renderReport(body); };
    $('#pt-rep-from').addEventListener('change', upd); $('#pt-rep-to').addEventListener('change', upd);
    $('#pt-rep-csv').addEventListener('click', function () {
      var b = C.periodBounds(S.report.from, S.report.to);
      var rows = S.tickets.filter(function (t) { var c = C.toMs(t.createdAt); return !c || (c >= b.fromMs && c < b.toMs); });
      var blob = new Blob([C.toCSV(rows)], { type: 'text/csv' });
      var a = document.createElement('a'); a.href = URL.createObjectURL(blob); a.download = 'procurement-' + S.report.from + '-to-' + S.report.to + '.csv';
      document.body.appendChild(a); a.click(); setTimeout(function () { URL.revokeObjectURL(a.href); a.remove(); }, 500);
      toast('CSV exported (' + rows.length + ' tickets)');
    });
  }

  /* ─── Test / debug hook (read-only) ─────────────────────── */
  window.PROCUREMENT = {
    state: function () { return S; },
    render: function () { render(true); },
    liveRefresh: function () { return render(); },   // what a live-sync refresh does: deferred while typing
    open: function (id) { S.expanded[id] = true; renderBody(); },
  };
})();
