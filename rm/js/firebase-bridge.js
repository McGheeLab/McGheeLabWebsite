/* firebase-bridge.js — connects ResearchManagement to the McGheeLabWebsite Firebase project.
   Provides the `firebridge` namespace for auth, Firestore reads/writes, and connection status. */

const firebridge = (function () {
  const FIREBASE_CONFIG = {
    apiKey:            'AIzaSyAnkKivjCcjAS8_Lp-R2JSIG4wSDSJBFI0',
    // TODO(auth-branding): switch authDomain to 'auth.mcgheelab.com' once the
    // Firebase Hosting custom domain is fully Connected (DNS propagation).
    // The CNAME auth.mcgheelab.com → mcgheelab-f56cc.web.app is set at godaddy.
    // Firebase status was "Records not yet detected" as of 2026-05-01;
    // re-check at https://console.firebase.google.com/project/mcgheelab-f56cc/hosting/sites
    authDomain:        'mcgheelab-f56cc.firebaseapp.com',
    projectId:         'mcgheelab-f56cc',
    storageBucket:     'mcgheelab-f56cc.firebasestorage.app',
    messagingSenderId: '665438582202',
    appId:             '1:665438582202:web:57416863d588bcdeff9983',
  };

  let _ready = false;
  // _user is intentionally `undefined` until onAuthStateChanged fires for the
  // first time. After that it's either a Firebase user object (signed in) or
  // explicit `null` (signed out). The undefined-vs-null distinction is what
  // lets onAuth/whenAuthResolved tell "auth still resolving" from "auth
  // resolved to signed-out" — without it, the immediate-fire path in onAuth
  // would call back with a null user before Firebase finishes initializing,
  // and pages awaiting whenAuthResolved would proceed too early (rendering
  // empty data because firebridge.getUser() returns null at that moment).
  let _user;
  let _profile = null;
  let _authCallbacks = [];

  /* ── Initialization ── */

  let _initCalled = false;

  function init() {
    if (_initCalled) return;
    if (typeof firebase === 'undefined') {
      // Firebase SDK isn't ready yet — the script-load-time call from the
      // bottom of this file will silently retry on DOMContentLoaded.
      return;
    }
    _initCalled = true;
    try {
      // Co-host detection: if the McGhee Lab website's firebase-config.js
      // has already initialized Firebase (window.McgheeLab.auth/db are set),
      // reuse that instance so auth state is shared across the website +
      // RM under the same origin. Otherwise initialize standalone with our
      // own config (dev / pre-co-host).
      var coHosted = typeof window !== 'undefined'
                  && window.McgheeLab
                  && window.McgheeLab.auth
                  && window.McgheeLab.db;
      if (!coHosted && !firebase.apps.length) {
        firebase.initializeApp(FIREBASE_CONFIG);
      }
      /* Auth persistence: the SDK default (IndexedDB) is used. The Ourlab app
       * is a normal multi-page app — each tab is a top-level page navigation, so
       * auth restores per-page exactly as on the web (V3.574 retired the
       * persistent iframe shell, whose tab iframes could not see the top frame's
       * session — see sync-rm.mjs step 3). The `ourlab-authed` localStorage hint
       * below stays as a synchronous "a session likely exists" paint signal so
       * the app can skip its loading splash on navigation for a returning user. */
      /* Auto-fall-back to HTTP long-polling when the WebChannel stream
       * fails (Chrome's QUIC stack drops Firestore Listen long-polls
       * intermittently — emits a flood of `QUIC_PROTOCOL_ERROR` /
       * `WebChannelConnection RPC 'Listen' stream transport errored`
       * warnings even though Firestore eventually reconnects). Setting
       * this once before the first `.firestore()` call routes traffic
       * to long-polling when WebChannel is unhealthy and silences the
       * spam. `merge: true` keeps any defaults the SDK has already
       * staged. Wrapped in try/catch because calling .settings() twice
       * throws — if some other init path beat us to a Firestore
       * operation, we don't want to fail the whole bridge. */
      try {
        firebase.firestore().settings({
          experimentalAutoDetectLongPolling: true,
          merge: true,
        });
      } catch (e) {
        // Already configured (rare — co-hosted parent may have set it).
      }
      /* V3.580 — R1 (Firestore offline IndexedDB persistence), platform-GATED
       * to the WEB only. V3.578 enabled this everywhere and it blanked the
       * Ourlab phone app to a white screen (a real-device Release / in-place-
       * upgrade issue that did NOT reproduce in the simulator — reverted in
       * V3.579). It works well on the web and makes repeat reads serve from
       * the local mirror instantly, so we KEEP that win on the web and SKIP it
       * in the Capacitor app until the device blank is root-caused. Detection
       * mirrors mobile-shell.js isApp(): Capacitor injects window.Capacitor at
       * document-start, before this runs. Fail direction: if the global is
       * somehow absent in the app, we'd treat it as web and enable persistence
       * (the thing that blanked) — so re-verify on-device after any change
       * here. Not awaited; .catch degrades on failed-precondition/unimplemented. */
      try {
        var _isNativeApp = typeof window !== 'undefined' && window.Capacitor
          && typeof window.Capacitor.isNativePlatform === 'function'
          && window.Capacitor.isNativePlatform();
        if (!_isNativeApp) {
          firebase.firestore().enablePersistence({ synchronizeTabs: true })
            .catch(function (err) {
              var code = err && err.code;
              if (code === 'failed-precondition') {
                console.warn('[firebridge] Firestore persistence unavailable ' +
                  '(multiple tabs / conflicting mode) — reads hit the network.');
              } else if (code === 'unimplemented') {
                console.warn('[firebridge] Firestore persistence not supported here.');
              } else {
                console.warn('[firebridge] Firestore persistence failed:', err && err.message);
              }
            });
        } else {
          console.log('[firebridge] Ourlab app — Firestore persistence intentionally OFF (V3.580 gate).');
        }
      } catch (e) {
        // Best-effort; never block init on persistence setup.
      }
      firebase.auth().onAuthStateChanged(async function (user) {
        if (user) {
          _user = user;
          // Ourlab app: synchronous "a session exists" paint hint so the
          // mobile shell can skip its loading splash on tab navigation for a
          // returning user (Firebase's own restore is async). Written before
          // the profile read so it reflects the raw auth event. UI hint only.
          try { localStorage.setItem('ourlab-authed', '1'); } catch (e) {}
          await _loadProfile();
          // Multi-tenant: any signed-in user with a users/{uid} doc is "ready".
          // Admin-only writes are gated per-action via isAdmin(). The bootstrap
          // module (profile-bootstrap.js) auto-creates a guest profile on
          // first sign-in and calls refreshProfile() to flip _ready true.
          _ready = !!_profile;
          _notifyAuth(_user, _profile);
          _attachProfileLiveSync();
        } else {
          _detachProfileLiveSync();
          _user = null;
          _profile = null;
          _ready = false;
          // Clear the app's signed-in paint hint (covers sign-out AND an
          // expired/revoked session) so the next launch shows the sign-in gate.
          try { localStorage.removeItem('ourlab-authed'); } catch (e) {}
          _notifyAuth(null, null);
        }
        _updateIndicator();
        _updatePendingOverlay();
      });
    } catch (err) {
      console.warn('[firebridge] Firebase init failed:', err.message);
      _notifyAuth(null, null);
    }
  }

  // V3.338 — set when every _loadProfile attempt failed (transient network /
  // Firestore error). Cleared on success and on sign-out. Drives the nav
  // chip's "failed — retry" state and retryProfile().
  var _profileError = null;

  async function _loadProfile() {
    if (!_user) { _profile = null; _profileError = null; return; }
    var delays = [0, 800, 2400];
    for (var i = 0; i < delays.length; i++) {
      if (delays[i]) await new Promise(function (r) { setTimeout(r, delays[i]); });
      if (!_user) { _profile = null; _profileError = null; return; }
      try {
        var doc = await firebase.firestore().collection('users').doc(_user.uid).get();
        // doc missing is NOT an error — fresh sign-in before bootstrap runs.
        _profile = doc.exists ? Object.assign({ id: doc.id }, doc.data()) : null;
        _profileError = null;
        return;
      } catch (err) {
        console.warn('[firebridge] Could not load profile (attempt ' + (i + 1) + '):', err.message);
        _profileError = err;
        if (err && err.code === 'permission-denied') break; // retry won't help
      }
    }
    _profile = null;
  }

  /* Profile live subscription — re-fires onAuth callbacks and re-renders the
   * nav profile chip whenever users/{uid} changes (e.g. admin promotion).
   * Tracked so we can detach on sign-out. */
  var _profileUnsub = null;
  function _attachProfileLiveSync() {
    _detachProfileLiveSync();
    if (!_user) return;
    try {
      _profileUnsub = firebase.firestore().collection('users').doc(_user.uid)
        .onSnapshot(function (doc) {
          var nextProfile = doc.exists ? Object.assign({ id: doc.id }, doc.data()) : null;
          var changed = JSON.stringify(_profile) !== JSON.stringify(nextProfile);
          _profile = nextProfile;
          _ready = !!_profile;
          if (changed) {
            _removeAccessBanner(); // role change resolves the access-issue state
            _notifyAuth(_user, _profile);
            _updateIndicator();
            _updatePendingOverlay();
          }
        }, function (err) {
          console.warn('[firebridge] profile snapshot error:', err.message);
        });
    } catch (err) {
      console.warn('[firebridge] could not attach profile snapshot:', err.message);
    }
  }
  function _detachProfileLiveSync() {
    if (_profileUnsub) { try { _profileUnsub(); } catch (e) {} _profileUnsub = null; }
  }

  /* Re-fetch the signed-in user's profile and re-notify listeners. Called by
   * profile-bootstrap.js after it auto-creates a users/{uid} doc on first
   * sign-in so the rest of the app sees the new profile without a reload. */
  async function refreshProfile() {
    if (!_user) return;
    await _loadProfile();
    _ready = !!_profile;
    _notifyAuth(_user, _profile);
    _updateIndicator();
    _updatePendingOverlay();
  }

  /* V3.338 — user-triggered recovery after a failed profile load (nav chip /
   * dropdown Retry button). Re-runs the bootstrap (in case the users/{uid}
   * create itself failed) and then the profile read. */
  function retryProfile() {
    _profileError = null;
    _updateIndicator();
    if (window.PROFILE_BOOTSTRAP && window.PROFILE_BOOTSTRAP.retry) {
      window.PROFILE_BOOTSTRAP.retry();
    } else {
      refreshProfile();
    }
  }

  /* ── Auth ── */

  function signIn(email, password) {
    return firebase.auth().signInWithEmailAndPassword(email, password);
  }

  function signInWithGoogle() {
    // V3.565 (Ourlab m-v0.1) — inside the Capacitor app the browser popup
    // can't work; sign in with the NATIVE Google flow and hand the
    // credential to the web SDK so every rm/ page sees the same session.
    if (window.Capacitor && typeof Capacitor.isNativePlatform === 'function'
        && Capacitor.isNativePlatform()
        && Capacitor.Plugins && Capacitor.Plugins.FirebaseAuthentication) {
      return Capacitor.Plugins.FirebaseAuthentication.signInWithGoogle()
        .then(function (result) {
          var idToken = result && result.credential && result.credential.idToken;
          if (!idToken) throw new Error('Native Google sign-in returned no credential.');
          var cred = firebase.auth.GoogleAuthProvider.credential(idToken);
          return firebase.auth().signInWithCredential(cred);
        });
    }
    var provider = new firebase.auth.GoogleAuthProvider();
    return firebase.auth().signInWithPopup(provider);
  }

  function signOut() {
    // Clear the app's signed-in paint hint synchronously (before the async
    // onAuthStateChanged(null) fires) so a page load right after sign-out
    // never optimistically skips the sign-in gate. Covers all sign-out call
    // sites (nav dropdown, pending overlay, mobile-shell More sheet).
    try { localStorage.removeItem('ourlab-authed'); } catch (e) {}
    return firebase.auth().signOut();
  }

  // V3.338 — friendly copy for Firebase auth error codes (mirrors the parent
  // site's map in user-system.js; RM pages don't load that file). Sign-in
  // failures share one message so the form can't probe which emails exist.
  var AUTH_ERROR_MESSAGES = {
    'auth/invalid-email':             'That email address doesn’t look right. Please check it and try again.',
    'auth/user-disabled':             'This account has been disabled. Contact the lab administrator.',
    'auth/user-not-found':            'Incorrect email or password.',
    'auth/wrong-password':            'Incorrect email or password.',
    'auth/invalid-credential':        'Incorrect email or password.',
    'auth/invalid-login-credentials': 'Incorrect email or password.',
    'auth/too-many-requests':         'Too many attempts. Wait a few minutes and try again.',
    'auth/network-request-failed':    'Network error. Check your connection and try again.',
    'auth/popup-blocked':             'Your browser blocked the sign-in window. Allow popups for this site and try again.',
    'auth/cancelled-popup-request':   'Another sign-in attempt is already in progress.',
  };

  function _friendlyAuthError(err) {
    if (err && err.code && AUTH_ERROR_MESSAGES[err.code]) return AUTH_ERROR_MESSAGES[err.code];
    if (err && typeof err.code === 'string' && err.code.indexOf('auth/') === 0) return 'Sign-in failed. Please try again.';
    return (err && err.message) || 'Something went wrong. Please try again.';
  }

  function onAuth(callback) {
    _authCallbacks.push(callback);
    // Fire immediately if auth already resolved
    if (_user !== undefined) {
      callback(_user, _profile);
    }
  }

  function _notifyAuth(user, profile) {
    _authCallbacks.forEach(function (cb) {
      try { cb(user, profile); } catch (e) { console.error(e); }
    });
  }

  function isReady()  { return _ready; }
  function getUser()  { return _user; }
  function getProfile() { return _profile; }
  function isAdmin()  { return _profile && _profile.role === 'admin'; }

  /** True if the signed-in user has been admitted to the lab (i.e. has a
   * non-guest profile). Mirrors firestore.rules `isLabMember()` — Firestore
   * reads of lab-shared data fail for guests, so RM gates UX on this. */
  function isLabMember() {
    return !!_profile && _profile.role !== 'guest';
  }

  /* ── Paper-builder permission helpers ── */

  /** True if the signed-in user can edit the given paper metadata.
   * Admin always wins; otherwise the user must be the lead author or in
   * coauthor_uids. Used by paper-editor.js to gate write UI. The Firestore
   * security rules (in Firebase console) are the actual enforcement layer. */
  function canEditPaper(paperMeta) {
    if (!_user) return false;
    if (isAdmin()) return true;
    if (!paperMeta) return false;
    if (paperMeta.lead_author_uid === _user.uid) return true;
    var co = paperMeta.coauthor_uids || [];
    return co.indexOf(_user.uid) >= 0;
  }

  function isLeadAuthor(paperMeta) {
    return !!(_user && paperMeta && paperMeta.lead_author_uid === _user.uid);
  }

  /* ── V3.63 — Workflow page access ──
   *
   * canAccessPage(pageId) decides whether the current user can include a
   * page in a custom workflow / see it in a default workflow's chip strip.
   *
   * Admins always pass. Otherwise check `userPermissions/{uid}.allowedPageIds`:
   *   - present + non-empty: user sees only those pages
   *   - missing or empty:    implicit baseline = pages in any default workflow
   *
   * The first call lazily fetches userPermissions/{uid} and the default-
   * workflow set; both are cached for the life of the page. canAccessPage
   * is sync — callers that need to await the first fetch can call
   * `await loadAccessGrant()` first. */
  var _accessGrant = null;     // null = not yet fetched
  var _accessGrantPromise = null;

  async function loadAccessGrant() {
    if (_accessGrantPromise) return _accessGrantPromise;
    _accessGrantPromise = (async function () {
      // Wait for sign-in to resolve; otherwise the doc read 403s.
      if (!_user) await whenAuthResolved();
      if (!_user) { _accessGrant = { allowedPageIds: null, allowedCollections: null, caps: null }; return _accessGrant; }
      try {
        var snap = await firebase.firestore()
          .collection('userPermissions').doc(_user.uid).get();
        if (snap.exists) {
          var d = snap.data() || {};
          _accessGrant = {
            allowedPageIds: Array.isArray(d.allowedPageIds) ? d.allowedPageIds : null,
            // V3.212 — collaborator data-layer gate. Denormalized from
            // allowedPageIds via rm/js/page-collections.js at admin-
            // matrix-save time. firestore.rules' collabMay(coll)
            // reads this same array server-side; mirrored here for
            // client-side inspection / debugging.
            allowedCollections: Array.isArray(d.allowedCollections) ? d.allowedCollections : null,
            // V3.605 — per-user elevated capabilities ('<pageSlug>:<capId>'
            // strings, e.g. 'library-paper:annotate'). Granted from the
            // admin permissions page; firestore.rules' hasCap() enforces
            // the same array server-side.
            caps: Array.isArray(d.caps) ? d.caps : null,
          };
        } else {
          _accessGrant = { allowedPageIds: null, allowedCollections: null, caps: null };
        }
      } catch (err) {
        // Non-admin user without a grant doc gets PERMISSION_DENIED here.
        // That's fine — fall back to implicit baseline.
        _accessGrant = { allowedPageIds: null, allowedCollections: null, caps: null };
      }
      return _accessGrant;
    })();
    return _accessGrantPromise;
  }

  /* ── V3.605 — per-user elevated capabilities ──
   *
   * Caps are '<pageSlug>:<capId>' strings on userPermissions/{uid}.caps,
   * granted from the admin permissions page (see capability-registry.js
   * for the catalog). These helpers are sync like canAccessPage — call
   * `await loadAccessGrant()` once during boot. firestore.rules' hasCap()
   * is the enforcement layer; these only shape UI. */

  /** True if the user holds the exact capability (admin always passes). */
  function hasCapability(cap) {
    if (isAdmin()) return true;
    return !!(_accessGrant && _accessGrant.caps && _accessGrant.caps.indexOf(cap) >= 0);
  }

  /** True if the user holds ANY capability on the given page slug.
   * Deliberately does NOT return true for admins — used to decide whether
   * an explicit grant exists (overlay/nav bypass), not whether the action
   * is allowed. */
  function hasAnyCapabilityFor(pageSlug) {
    if (!_accessGrant || !_accessGrant.caps) return false;
    var prefix = pageSlug + ':';
    return _accessGrant.caps.some(function (c) { return c.indexOf(prefix) === 0; });
  }

  /** True if pageId appears verbatim in the user's allowedPageIds grant. */
  function hasExplicitPageGrant(pageId) {
    return !!(_accessGrant && _accessGrant.allowedPageIds &&
              _accessGrant.allowedPageIds.indexOf(pageId) >= 0);
  }

  /** Current page id from the URL, registry-free (page-registry.js isn't
   * loaded on non-nav pages like library-paper.html). Mirrors
   * PAGE_REGISTRY.pageIdFromHref: /rm/pages/<slug>.html → '<slug>', with
   * ?tab= producing '<slug>__tab__<tab>'; other params ignored. */
  function _currentPageId() {
    var p = location.pathname;
    if (p === '/rm/index.html' || p === '/rm/' || p === '/') return 'dashboard';
    var m = p.match(/^\/rm\/pages\/([a-z0-9-]+)\.html$/);
    if (!m) return '';
    var tab = new URLSearchParams(location.search).get('tab');
    return tab ? (m[1] + '__tab__' + tab) : m[1];
  }

  /* V3.613 — the Ourlab mobile library pages are phone SURFACES of the
   * desktop pages, not separately-granted pages: one admin grant (page ids
   * 'library' / 'library-paper', caps 'library-paper:*') covers both. Maps
   * mobile slug → {page: desktop page id, capPage: cap namespace}. */
  var PAGE_ALIASES = {
    'library-mobile': { page: 'library', capPage: 'library-paper' },
    'library-mobile-paper': { page: 'library-paper', capPage: 'library-paper' },
  };

  /** True if a guest's explicit grants (pages or caps) cover the page the
   * browser is currently on — the pending-access overlay is suppressed for
   * granted pages so cap-granted guests can actually use them. */
  function _guestHasCurrentPageAccess() {
    var id = _currentPageId();
    if (!id) return false;
    var slug = id.split('__tab__')[0];
    if (hasExplicitPageGrant(id) || hasExplicitPageGrant(slug) || hasAnyCapabilityFor(slug)) return true;
    var alias = PAGE_ALIASES[slug];
    return !!(alias && (hasExplicitPageGrant(alias.page) || hasAnyCapabilityFor(alias.capPage)));
  }

  /** Synchronous gate. Returns true if the user can access `pageId`.
   * Behavior:
   *   - admin → always true
   *   - signed-out / no profile → false (callers shouldn't ask before auth)
   *   - explicit grant doc → membership in allowedPageIds
   *   - any capability on the page (V3.605) → true
   *   - guests → false beyond explicit grants (no implicit baseline)
   *   - no grant doc → membership in the implicit baseline (union of
   *                    pageIds across all default workflows, sourced from
   *                    PAGE_REGISTRY.defaultPageIdSet)
   *
   * The first call before `await loadAccessGrant()` returns false (we
   * haven't fetched yet); call sites should await loadAccessGrant once
   * during their boot. */
  function canAccessPage(pageId) {
    if (isAdmin()) return true;
    if (!_user) return false;
    if (!_accessGrant) return false;       // not yet fetched
    var slug = String(pageId).split('__tab__')[0];
    var alias = PAGE_ALIASES[slug];
    if (_accessGrant.allowedPageIds && _accessGrant.allowedPageIds.length) {
      if (_accessGrant.allowedPageIds.indexOf(pageId) >= 0) return true;
      // V3.613 — a grant on the desktop page id covers its mobile surface.
      return !!(alias && _accessGrant.allowedPageIds.indexOf(alias.page) >= 0);
    }
    // V3.605 — a capability on the page implies access to the page itself.
    if (hasAnyCapabilityFor(slug)) return true;
    if (alias && hasAnyCapabilityFor(alias.capPage)) return true;   // V3.613
    // V3.605 — guests never inherit the default-workflow baseline: explicit
    // grants only (mirrors the collaborator rationale below; before caps
    // this was moot because the pending overlay blocked every page).
    if (_profile && _profile.role === 'guest') return false;
    // V3.209 — collaborators have no implicit baseline. Admin grants
    // every page explicitly via the page-allow matrix; no grant = no
    // access through workflow UIs and page-discovery surfaces. (This is
    // a UI gate, not a security boundary — see firestore.rules for the
    // data-layer policy.)
    if (_profile && _profile.category === 'collaborator') return false;
    // Implicit baseline. PAGE_REGISTRY may not be loaded on every page
    // (only nav-bearing pages load page-registry.js); be defensive.
    var REG = window.PAGE_REGISTRY;
    if (REG && REG.defaultPageIdSet) return REG.defaultPageIdSet.has(pageId);
    return true;  // page-registry not loaded → permissive default
  }

  /* ── Firestore helpers ── */

  function db() {
    return firebase.firestore();
  }

  function collection(name) {
    return firebase.firestore().collection(name);
  }

  async function getAll(collectionName, orderField, orderDir, limit) {
    var ref = firebase.firestore().collection(collectionName);
    if (orderField) ref = ref.orderBy(orderField, orderDir || 'desc');
    if (limit && limit > 0) ref = ref.limit(limit);
    var snap = await ref.get();
    return snap.docs.map(function (d) { return Object.assign({ id: d.id }, d.data()); });
  }

  // Cursor-based page fetch. Returns { rows, lastDoc, hasMore } so callers can
  // paginate via a "Load more" button: pass the previous result's lastDoc as
  // opts.startAfterDoc on the next call. lastDoc is the raw Firestore
  // QueryDocumentSnapshot — caller treats it as opaque.
  async function getPage(collectionName, opts) {
    opts = opts || {};
    var ref = firebase.firestore().collection(collectionName);
    if (opts.where) ref = ref.where(opts.where[0], opts.where[1], opts.where[2]);
    if (opts.orderField) ref = ref.orderBy(opts.orderField, opts.orderDir || 'desc');
    if (opts.startAfterDoc) ref = ref.startAfter(opts.startAfterDoc);
    var lim = opts.limit || 0;
    if (lim > 0) ref = ref.limit(lim);
    var snap = await ref.get();
    var rows = snap.docs.map(function (d) { return Object.assign({ id: d.id }, d.data()); });
    var lastDoc = snap.docs.length ? snap.docs[snap.docs.length - 1] : null;
    return { rows: rows, lastDoc: lastDoc, hasMore: lim > 0 && rows.length === lim };
  }

  async function getDoc(collectionName, docId) {
    var doc = await firebase.firestore().collection(collectionName).doc(docId).get();
    return doc.exists ? Object.assign({ id: doc.id }, doc.data()) : null;
  }

  async function queryWhere(collectionName, field, op, value, orderField, orderDir) {
    var ref = firebase.firestore().collection(collectionName).where(field, op, value);
    if (orderField) ref = ref.orderBy(orderField, orderDir || 'desc');
    var snap = await ref.get();
    return snap.docs.map(function (d) { return Object.assign({ id: d.id }, d.data()); });
  }

  async function updateDoc(collectionName, docId, data) {
    data.updatedAt = firebase.firestore.FieldValue.serverTimestamp();
    return firebase.firestore().collection(collectionName).doc(docId).update(data);
  }

  async function setDoc(collectionName, docId, data, merge) {
    data.updatedAt = firebase.firestore.FieldValue.serverTimestamp();
    return firebase.firestore().collection(collectionName).doc(docId).set(data, { merge: merge !== false });
  }

  async function addDoc(collectionName, data) {
    data.createdAt = firebase.firestore.FieldValue.serverTimestamp();
    data.updatedAt = firebase.firestore.FieldValue.serverTimestamp();
    var ref = await firebase.firestore().collection(collectionName).add(data);
    return ref.id;
  }

  async function deleteDoc(collectionName, docId) {
    return firebase.firestore().collection(collectionName).doc(docId).delete();
  }

  /* ── Realtime / sub-collection helpers (Phase 3 annotations) ── */

  /** Get a sub-collection reference, e.g. subCollection('papers', 'paper-id', 'annotations'). */
  function subCollection(parent, parentId, sub) {
    return firebase.firestore().collection(parent).doc(parentId).collection(sub);
  }

  /** Subscribe to a Firestore query.
   *
   * Pass either a `query` (a firestore Query) or a {collection, where, orderBy}
   * descriptor. Returns an unsubscribe function.
   */
  function onSnapshot(query, callback, errorCallback) {
    return query.onSnapshot({
      next: (snap) => {
        const docs = snap.docs.map(d => Object.assign({ id: d.id }, d.data()));
        callback(docs, snap);
      },
      error: (err) => {
        console.error('[firebridge] onSnapshot error:', err);
        // V3.338 — a listener that loses permission mid-session should be
        // visible, not just a console line.
        if (err && err.code === 'permission-denied' && _user) notifyAccessIssue('live updates');
        if (errorCallback) errorCallback(err);
      },
    });
  }

  /** Add a doc to a subcollection (Phase 3 annotations / claims).
   * Stamps creator, createdAt, updatedAt automatically. Returns the doc id. */
  async function addToSub(parent, parentId, sub, data) {
    const u = _user;
    const profile = _profile;
    const stamp = firebase.firestore.FieldValue.serverTimestamp();
    const enriched = Object.assign({}, data, {
      creator: data.creator || (u ? {
        uid: u.uid,
        email: u.email || '',
        displayName: (profile && profile.name) || u.displayName || u.email || '',
      } : null),
      created: stamp,
      modified: stamp,
    });
    const ref = await subCollection(parent, parentId, sub).add(enriched);
    return ref.id;
  }

  /** Update a doc in a subcollection. Stamps modified timestamp. */
  async function updateInSub(parent, parentId, sub, docId, data) {
    const enriched = Object.assign({}, data, {
      modified: firebase.firestore.FieldValue.serverTimestamp(),
    });
    return subCollection(parent, parentId, sub).doc(docId).update(enriched);
  }

  /** Delete a doc in a subcollection. */
  async function deleteInSub(parent, parentId, sub, docId) {
    return subCollection(parent, parentId, sub).doc(docId).delete();
  }

  /* ── Storage helpers ── */

  function storageRef(path) {
    return firebase.storage().ref().child(path);
  }

  /* ── Nav bar profile menu ── */

  function _initials() {
    var src = (_profile && _profile.name) || (_user && _user.email) || '';
    if (!src) return '?';
    var parts = src.replace(/@.*/, '').split(/[\s._-]+/).filter(Boolean);
    if (parts.length >= 2) return (parts[0][0] + parts[1][0]).toUpperCase();
    return src.slice(0, 2).toUpperCase();
  }

  function _statusClass() {
    if (_ready) return 'fb-profile-connected';
    if (_user)  return 'fb-profile-warn';
    return 'fb-profile-off';
  }

  function _statusTitle() {
    if (_ready) return 'Connected as ' + (_profile.name || _user.email);
    if (_user && _profileError) return 'Profile failed to load — open menu to retry';
    if (_user)  return 'Signed in — setting up profile…';
    return 'Not signed in';
  }

  function _renderProfileButton() {
    var btn = document.getElementById('fb-profile-btn');
    if (!btn) return;
    btn.className = 'fb-profile-btn ' + _statusClass();
    btn.title = _statusTitle();
    btn.textContent = _user ? _initials() : '';
    btn.setAttribute('aria-label', _statusTitle());
    if (!_user) {
      // Render a generic user glyph when signed out
      btn.innerHTML = '<svg viewBox="0 0 24 24" width="18" height="18" fill="currentColor" aria-hidden="true">' +
        '<path d="M12 12a4 4 0 1 0-4-4 4 4 0 0 0 4 4zm0 2c-3.3 0-8 1.7-8 5v2h16v-2c0-3.3-4.7-5-8-5z"/>' +
      '</svg>';
    }
  }

  /* ── Shared sign-in component (V3.338) ──
   *
   * ONE sign-in form used by both the nav dropdown and the page-body gate
   * card, so a logged-out deep link gets the same working sign-in as the
   * avatar menu. Class-based selectors (not ids) so two instances coexist.
   */
  function _signInFormHtml() {
    return (
      '<div class="fb-signin-error fb-panel-error" style="display:none;"></div>' +
      '<div class="fb-panel-actions">' +
        '<button class="btn btn-primary fb-signin-google" type="button">Sign In with Google</button>' +
      '</div>' +
      '<details class="fb-panel-details">' +
        '<summary>Sign in with email / password</summary>' +
        '<div class="form-group">' +
          '<label>Email</label>' +
          '<input type="email" class="fb-signin-email" placeholder="you@arizona.edu" autocomplete="email">' +
        '</div>' +
        '<div class="form-group">' +
          '<label>Password</label>' +
          '<input type="password" class="fb-signin-password" autocomplete="current-password">' +
        '</div>' +
        '<button class="btn btn-primary fb-signin-submit" type="button">Sign In</button>' +
      '</details>'
    );
  }

  function _wireSignInForm(rootEl) {
    if (!rootEl) return;
    var errEl = rootEl.querySelector('.fb-signin-error');
    function showErr(err) {
      if (!errEl) return;
      errEl.textContent = _friendlyAuthError(err);
      errEl.style.display = 'block';
    }
    function hideErr() { if (errEl) errEl.style.display = 'none'; }

    var googleBtn = rootEl.querySelector('.fb-signin-google');
    if (googleBtn) {
      googleBtn.onclick = async function () {
        googleBtn.disabled = true;
        googleBtn.textContent = 'Signing in...';
        hideErr();
        try {
          await signInWithGoogle();
        } catch (err) {
          if (err && err.code !== 'auth/popup-closed-by-user') showErr(err);
          googleBtn.disabled = false;
          googleBtn.textContent = 'Sign In with Google';
        }
      };
    }

    var signinBtn = rootEl.querySelector('.fb-signin-submit');
    if (signinBtn) {
      signinBtn.onclick = async function () {
        var emailEl = rootEl.querySelector('.fb-signin-email');
        var passEl  = rootEl.querySelector('.fb-signin-password');
        var email = (emailEl && emailEl.value || '').trim();
        var pass  = (passEl && passEl.value) || '';
        if (!email || !pass) {
          showErr({ message: 'Enter email and password.' });
          return;
        }
        signinBtn.disabled = true;
        signinBtn.textContent = 'Signing in...';
        hideErr();
        try {
          await signIn(email, pass);
        } catch (err) {
          showErr(err);
          signinBtn.disabled = false;
          signinBtn.textContent = 'Sign In';
        }
      };
      var passField = rootEl.querySelector('.fb-signin-password');
      if (passField) {
        passField.onkeydown = function (e) { if (e.key === 'Enter') signinBtn.click(); };
      }
    }
  }

  function _renderProfilePanel() {
    var panel = document.getElementById('fb-profile-panel');
    if (!panel) return;

    if (_ready) {
      var adminBtnHtml = isAdmin()
        ? '<button class="btn" id="fb-sync-config-btn">Sync Config to Website</button>'
        : '';
      // Migrate link is visible to everyone — admins manage shared rows,
      // non-admins manage their own personal rows.
      var migrateLink =
        '<a class="btn" href="/rm/pages/admin-migrate.html" style="text-decoration:none;text-align:center;">Firestore Migration…</a>';
      panel.innerHTML =
        '<div class="fb-panel-header">' +
          '<div class="fb-panel-avatar fb-profile-connected">' + _initials() + '</div>' +
          '<div>' +
            '<div class="fb-panel-name">' + (_profile.name || _user.email) + '</div>' +
            '<div class="fb-panel-sub">' + _user.email + ' · ' + (_profile.role || 'member') + '</div>' +
          '</div>' +
        '</div>' +
        '<div class="fb-panel-actions">' +
          adminBtnHtml +
          migrateLink +
          '<button class="btn btn-danger" id="fb-signout-btn">Sign Out</button>' +
        '</div>';
    } else if (_user) {
      // V3.338 — distinguish "bootstrap in flight" from "profile read failed".
      var subHtml = _profileError
        ? '<div class="fb-panel-sub" style="color:var(--red,#dc2626);">Profile failed to load</div>'
        : '<div class="fb-panel-sub" style="color:var(--amber);">Setting up profile…</div>';
      var retryBtnHtml = _profileError
        ? '<button class="btn" id="fb-retry-profile-btn">Retry</button>'
        : '';
      panel.innerHTML =
        '<div class="fb-panel-header">' +
          '<div class="fb-panel-avatar fb-profile-warn">' + _initials() + '</div>' +
          '<div>' +
            '<div class="fb-panel-name">' + _user.email + '</div>' +
            subHtml +
          '</div>' +
        '</div>' +
        '<div class="fb-panel-actions">' +
          retryBtnHtml +
          '<button class="btn btn-danger" id="fb-signout-btn">Sign Out</button>' +
        '</div>';
    } else {
      panel.innerHTML =
        '<div class="fb-panel-header" style="flex-direction:column;align-items:flex-start;gap:4px;">' +
          '<div class="fb-panel-name">Sign in to the McGhee Lab</div>' +
          '<div class="fb-panel-sub">Use your Google account or email/password.</div>' +
        '</div>' +
        _signInFormHtml();
    }

    _wireProfilePanel();
  }

  function _wireProfilePanel() {
    var panel = document.getElementById('fb-profile-panel');
    if (panel && !_user) _wireSignInForm(panel);

    var retryBtn = document.getElementById('fb-retry-profile-btn');
    if (retryBtn) {
      retryBtn.onclick = function () {
        retryBtn.disabled = true;
        retryBtn.textContent = 'Retrying...';
        retryProfile();
      };
    }

    var signoutBtn = document.getElementById('fb-signout-btn');
    if (signoutBtn) {
      signoutBtn.onclick = async function () {
        await signOut();
      };
    }

    var syncBtn = document.getElementById('fb-sync-config-btn');
    if (syncBtn) {
      syncBtn.onclick = async function () {
        syncBtn.disabled = true;
        syncBtn.textContent = 'Syncing...';
        try {
          // Active research tools become the project picker on lab-app forms.
          var toolsData = await api.load('projects/tools.json');
          var projects = (toolsData.tools || [])
            .filter(function (t) { return t.status === 'active'; })
            .map(function (t) { return { id: t.id, label: t.name }; });
          projects.push({ id: 'lab-general', label: 'Lab General' });
          await setDoc('labConfig', 'projects', { projects: projects });

          // Funding sources for purchase / procurement forms. Pull from the
          // migrated funding collection (awards + accounts) instead of a
          // hardcoded list — different lab setups have different account
          // numbers. Falls back to the prior hardcoded list when the
          // collection is empty so legacy behavior is preserved.
          var sources = [];
          try {
            var awardsData  = await api.load('funding/awards.json');
            var acctsData   = await api.load('funding/accounts.json');
            (awardsData.awards || []).forEach(function (a) {
              if (a.status && a.status !== 'active') return;
              var label = a.account_number ? (a.title || a.id) + ' (' + a.account_number + ')' : (a.title || a.id);
              sources.push({ id: a.account_number || a.id, label: label });
            });
            (acctsData.accounts || []).forEach(function (a) {
              if (sources.find(function (s) { return s.id === (a.account_number || a.id); })) return;
              var label = a.account_number ? (a.label || a.title || a.id) + ' (' + a.account_number + ')' : (a.label || a.title || a.id);
              sources.push({ id: a.account_number || a.id, label: label });
            });
          } catch (e) {
            console.warn('[firebridge] funding sync read failed; using fallback list:', e.message);
          }
          if (!sources.length) {
            sources = [
              { id: '1101935', label: 'Startup (1101935)' },
              { id: '3062920', label: 'ONR (3062920)' },
              { id: '3061792', label: 'BME Research (3061792)' },
            ];
          }
          await setDoc('labConfig', 'fundingSources', { sources: sources });

          syncBtn.textContent = 'Synced!';
          setTimeout(function () {
            syncBtn.textContent = 'Sync Config to Website';
            syncBtn.disabled = false;
          }, 2000);
        } catch (err) {
          alert('Sync failed: ' + err.message);
          syncBtn.disabled = false;
          syncBtn.textContent = 'Sync Config to Website';
        }
      };
    }
  }

  function _updateIndicator() {
    _renderProfileButton();
    var wrap = document.getElementById('fb-profile-wrap');
    if (wrap && wrap.classList.contains('open')) {
      _renderProfilePanel();
    }
  }

  /** Call after nav renders to inject the profile button + dropdown. */
  function injectIndicator() {
    var nav = document.querySelector('.top-nav');
    if (!nav || document.getElementById('fb-profile-wrap')) return;

    var wrap = document.createElement('div');
    wrap.id = 'fb-profile-wrap';
    wrap.className = 'fb-profile-wrap';

    var btn = document.createElement('button');
    btn.id = 'fb-profile-btn';
    btn.type = 'button';
    btn.className = 'fb-profile-btn fb-profile-off';

    var panel = document.createElement('div');
    panel.id = 'fb-profile-panel';
    panel.className = 'fb-profile-panel';

    wrap.appendChild(btn);
    wrap.appendChild(panel);
    nav.appendChild(wrap);

    btn.addEventListener('click', function (e) {
      e.stopPropagation();
      var wasOpen = wrap.classList.contains('open');
      document.querySelectorAll('.nav-dropdown.open').forEach(function (d) { d.classList.remove('open'); });
      if (wasOpen) {
        wrap.classList.remove('open');
      } else {
        _renderProfilePanel();
        wrap.classList.add('open');
      }
    });

    panel.addEventListener('click', function (e) { e.stopPropagation(); });
    document.addEventListener('click', function () { wrap.classList.remove('open'); });

    _renderProfileButton();
  }

  /* ── Pending-access overlay for guests ──
   *
   * Fresh Google sign-ins land as role:'guest'. Per project policy, guests
   * are NOT lab members until admin promotes them — they should not see RM
   * data. This overlay appears on every RM page when a guest is signed in;
   * it covers the page so even if a renderer started fetching, the user
   * can't interact. Once admin promotes (role !== 'guest') the live profile
   * snapshot fires and the overlay self-removes.
   *
   * This is layered on top of the firestore.rules gate (defense in depth):
   * even without the overlay, all lab-shared reads would fail for guests.
   */
  var _pendingOverlayId = 'fb-pending-access-overlay';
  var _pendingOverlayTimer = null;   // debounce — let the role settle before flashing

  function _renderPendingOverlay() {
    if (document.getElementById(_pendingOverlayId)) return;
    var ov = document.createElement('div');
    ov.id = _pendingOverlayId;
    ov.style.cssText =
      'position:fixed;inset:0;z-index:99999;background:rgba(11,13,18,0.92);' +
      'display:flex;align-items:center;justify-content:center;padding:24px;' +
      'backdrop-filter:blur(4px);';
    var name = (_profile && _profile.name) || (_user && _user.displayName) || (_user && _user.email) || 'there';
    var email = (_user && _user.email) || '';
    var pi = 'mcgheealex@gmail.com';  // Alex's Firebase admin account — where access requests should land
    ov.innerHTML =
      '<div style="background:#fff;color:#111;border-radius:14px;max-width:520px;width:100%;' +
        'padding:32px;box-shadow:0 24px 48px rgba(0,0,0,0.45);font-family:system-ui,sans-serif;">' +
        '<h1 style="margin:0 0 12px;font-size:22px;">Welcome, ' + _escapeHtml(name) + '</h1>' +
        '<p style="margin:0 0 12px;line-height:1.55;color:#374151;">' +
          'You\'re signed in as <strong>' + _escapeHtml(email) + '</strong>, but your account is ' +
          'still pending lab access. RM and the McGheeLab apps unlock once the PI ' +
          'adds you to the roster.' +
        '</p>' +
        '<p style="margin:0 0 20px;line-height:1.55;color:#374151;">' +
          'Reach out to <a href="mailto:' + pi + '?subject=' +
            encodeURIComponent('RM access request') +
            '&body=' + encodeURIComponent('Hi Alex, please add me (' + email + ') to the McGhee Lab roster.') +
          '">' + pi + '</a> and ask to be added. ' +
          'You can close the tab in the meantime — this page will refresh automatically once your access is granted.' +
        '</p>' +
        '<div style="display:flex;gap:8px;justify-content:flex-end;">' +
          '<button id="fb-pending-signout" style="padding:8px 14px;border:1px solid #d1d5db;background:#fff;border-radius:8px;cursor:pointer;">Sign out</button>' +
          '<a href="mailto:' + pi + '" style="padding:8px 14px;background:#5baed1;color:#fff;border-radius:8px;text-decoration:none;">Email the PI</a>' +
        '</div>' +
      '</div>';
    document.body.appendChild(ov);
    var btn = document.getElementById('fb-pending-signout');
    if (btn) btn.onclick = function () { signOut(); };
  }

  function _removePendingOverlay() {
    var ov = document.getElementById(_pendingOverlayId);
    if (ov && ov.parentNode) ov.parentNode.removeChild(ov);
  }

  function _clearPendingTimer() {
    if (_pendingOverlayTimer) { clearTimeout(_pendingOverlayTimer); _pendingOverlayTimer = null; }
  }

  function _updatePendingOverlay() {
    // Signed out → never show.
    if (!_user) { _clearPendingTimer(); _removePendingOverlay(); return; }
    // Profile still loading → decide later, don't flash.
    if (!_profile) { _clearPendingTimer(); return; }
    // Confirmed lab member / admin → remove the overlay (and cancel any
    // scheduled show). This is what fires when the settled server profile
    // arrives after a transient guest read, so no overlay ever appears.
    if (_profile.role !== 'guest') { _clearPendingTimer(); _removePendingOverlay(); return; }
    // role === 'guest'. Right after a fresh sign-in the profile can transiently
    // read 'guest' even for a real member — the live users/{uid} snapshot can
    // deliver a CACHED doc (a stale role from a prior session) before the
    // server copy, and the bootstrap create→refresh hop has a brief window.
    // Don't flash the "pending access" screen on that transient: wait for the
    // role to settle. If it's STILL guest after the grace window, it's a
    // genuine guest and the overlay renders. (firestore.rules is the real gate
    // meanwhile — a guest can't read any lab data regardless of this overlay.)
    if (document.getElementById(_pendingOverlayId)) return;   // already shown → keep it
    if (_pendingOverlayTimer) return;                          // already scheduled
    _pendingOverlayTimer = setTimeout(async function () {
      _pendingOverlayTimer = null;
      if (!(_user && _profile && _profile.role === 'guest')) return;
      // V3.605 — a guest with explicit grants (allowedPageIds or per-page
      // capabilities) may use the granted pages: suppress the overlay
      // there. Overlay is UI-only — firestore.rules stays the real gate,
      // and every other page still shows it.
      try { await loadAccessGrant(); } catch (e) { /* fall through → overlay */ }
      if (!(_user && _profile && _profile.role === 'guest')) return;  // role settled meanwhile
      if (_guestHasCurrentPageAccess()) return;
      _renderPendingOverlay();
    }, 3000);
  }

  function _escapeHtml(s) {
    return String(s == null ? '' : s)
      .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;').replace(/'/g, '&#39;');
  }

  /* ── Access-issue banner (V3.338) ──
   *
   * Mid-session permission-denied errors used to be silently converted to
   * empty data by the api adapter's catch-all. This banner makes them
   * visible: "your access may have changed". Singleton, rate-limited, only
   * shown while signed in (signed-out denials are the gate's job), and
   * auto-removed when the live profile snapshot changes (role promotion).
   */
  var _accessBannerDismissedAt = 0;

  function notifyAccessIssue(context) {
    if (!_user) return;
    if (Date.now() - _accessBannerDismissedAt < 20000) return;
    var existing = document.getElementById('fb-access-banner');
    if (existing) {
      var ctxEl = existing.querySelector('.fb-access-context');
      if (ctxEl && context && ctxEl.textContent.indexOf(context) === -1) {
        ctxEl.textContent += ', ' + context;
      }
      return;
    }
    var banner = document.createElement('div');
    banner.id = 'fb-access-banner';
    banner.innerHTML =
      '<span>Your access may have changed — data on this page may be incomplete' +
        (context ? ' <span class="fb-access-context">(' + _escapeHtml(context) + ')</span>' : '') +
      '.</span>' +
      '<button type="button" class="fb-access-retry">Retry</button>' +
      '<button type="button" class="fb-access-signout">Sign out</button>' +
      '<button type="button" class="fb-access-close" aria-label="Dismiss">✕</button>';
    banner.querySelector('.fb-access-retry').onclick = function () { location.reload(); };
    banner.querySelector('.fb-access-signout').onclick = function () { _removeAccessBanner(); signOut(); };
    banner.querySelector('.fb-access-close').onclick = function () {
      _accessBannerDismissedAt = Date.now();
      _removeAccessBanner();
    };
    document.body.appendChild(banner);
  }

  function _removeAccessBanner() {
    var b = document.getElementById('fb-access-banner');
    if (b && b.parentNode) b.parentNode.removeChild(b);
  }

  /* ── Page-level gating helpers ──
   *
   * gateAdmin / gateSignedIn replace a page's main render with a notice when
   * the signed-in user doesn't meet the bar. Used to keep features that still
   * read lab-shared data (email_archive, calendar_archive, etc.) from leaking
   * the PI's data to other lab members until per-user storage exists for those paths.
   *
   * Usage in a page's main JS:
   *   firebridge.gateAdmin('Email triage uses the lab inbox; per-user Gmail OAuth ships in Phase 7.');
   *
   * The gate runs after auth resolves. Returns a Promise<{allowed, user, profile}>
   * — pages can `if (!(await firebridge.gateAdmin(...)).allowed) return;` to bail out.
   */

  function _whenAuthResolved() {
    return new Promise(function (resolve) {
      var fired = false;
      var degradeTimer = null;
      function settle(result) {
        if (fired) return;
        fired = true;
        if (degradeTimer) { clearTimeout(degradeTimer); degradeTimer = null; }
        resolve(result);
      }
      onAuth(function (user, profile) {
        if (fired) return;
        // If user is signed in but profile is still loading, wait for the
        // refreshProfile hop (bootstrap) before deciding — but not forever.
        // V3.333: if the profile never arrives (read failed and bootstrap
        // gave up), resolve degraded after 10s so pages render with a retry
        // affordance instead of spinning permanently.
        if (user && !profile) {
          if (!degradeTimer) {
            degradeTimer = setTimeout(function () {
              settle({ user: _user, profile: _profile, degraded: !_profile });
            }, 10000);
          }
          return;
        }
        settle({ user: user, profile: profile });
      });
    });
  }

  /** Public Promise that resolves once Firebase auth has settled — either to
   * a signed-in user with a profile or to a definitive signed-out null. Use
   * this in page boot() functions BEFORE the first user-scope api.load:
   *
   *     await firebridge.whenAuthResolved();
   *     await loadDoc();   // adapter now has firebridge.getUser() to use
   *
   * Without this, user-scope reads on first paint hit the adapter while
   * getUser() is still null; the adapter's catch then falls through to the
   * legacy JSON fetch, which serves Alex's pre-migration data. */
  function whenAuthResolved() { return _whenAuthResolved(); }

  /* V3.338 — the gate no longer destroys the page: existing content is moved
   * into a hidden stash so an in-card sign-in can restore it and the page's
   * boot can continue WITHOUT a reload. level 'signin' renders the shared
   * sign-in form right in the card. */
  function _renderGateNotice(level, html) {
    var main = document.querySelector('main, #app, .page') || document.body;

    // Stash the page skeleton once; rebuild the card if level/reason changed.
    var stash = document.getElementById('fb-gate-stash');
    if (!stash) {
      stash = document.createElement('div');
      stash.id = 'fb-gate-stash';
      stash.style.display = 'none';
      while (main.firstChild) stash.appendChild(main.firstChild);
      main.appendChild(stash);
    }
    var old = document.getElementById('fb-gate-card');
    if (old && old.parentNode) old.parentNode.removeChild(old);

    var card = document.createElement('div');
    card.id = 'fb-gate-card';
    card.innerHTML =
      '<div class="card fb-gate-inner" style="border-left:4px solid ' +
        (level === 'admin' ? 'var(--amber,#d97706)' : 'var(--accent,#5baed1)') + ';">' +
        '<h2 style="margin-top:0;font-size:18px;">' +
          (level === 'admin' ? 'Admin only' : level === 'signin' ? 'Sign in to McGhee Lab RM' : 'Not authorized') +
        '</h2>' +
        '<div class="fb-gate-reason" style="color:var(--muted,#6b7280);font-size:14px;line-height:1.5;margin-bottom:12px;">' + html + '</div>' +
        (level === 'signin' ? _signInFormHtml() : '') +
        '<div style="margin-top:16px;"><a class="btn" href="/rm/index.html">Back to dashboard</a></div>' +
      '</div>';
    main.appendChild(card);
    if (level === 'signin') _wireSignInForm(card);
  }

  function _clearGateNotice() {
    var card = document.getElementById('fb-gate-card');
    if (card && card.parentNode) card.parentNode.removeChild(card);
    var stash = document.getElementById('fb-gate-stash');
    if (stash && stash.parentNode) {
      var parent = stash.parentNode;
      while (stash.firstChild) parent.appendChild(stash.firstChild);
      parent.removeChild(stash);
    }
  }

  /* Wait (indefinitely) for a signed-in auth state after the gate card is up.
   * Mirrors _whenAuthResolved's degraded timeout for the profile hop. */
  function _whenSignedIn() {
    return new Promise(function (resolve) {
      var fired = false;
      var degradeTimer = null;
      onAuth(function (user, profile) {
        if (fired) return;
        if (!user) return; // still signed out — keep waiting
        if (!profile) {
          if (!degradeTimer) {
            degradeTimer = setTimeout(function () {
              if (fired) return;
              fired = true;
              resolve({ user: _user, profile: _profile, degraded: !_profile });
            }, 10000);
          }
          return;
        }
        fired = true;
        if (degradeTimer) clearTimeout(degradeTimer);
        resolve({ user: user, profile: profile });
      });
    });
  }

  /* V3.338 — re-show the sign-in card if the user signs out mid-session,
   * hiding (stashing) the page content rather than leaving stale data up. */
  var _regateWatcherArmed = false;
  function _watchSignOutRegate(reason) {
    if (_regateWatcherArmed) return;
    _regateWatcherArmed = true;
    var wasSignedIn = !!_user;
    onAuth(function (user) {
      if (user) { wasSignedIn = true; return; }
      if (wasSignedIn && user === null) {
        _renderGateNotice('signin', reason || 'You need to sign in to view this page.');
      }
    });
  }

  /** V3.338 — the default gated entry for RM pages. Drop-in replacement for
   * `await firebridge.whenAuthResolved()`:
   *
   *     const s = await firebridge.requireSignIn('Sign in to view grants.');
   *
   * Signed out → renders an inline sign-in card (Google + email/password) in
   * the page body and resolves only after sign-in succeeds; the stashed page
   * DOM is restored so boot continues without a reload. Resolves
   * `{ allowed: true, user, profile, degraded }`; `degraded` means the
   * profile read failed (retry affordance lives in the nav chip). */
  async function requireSignIn(reason) {
    var s = await _whenAuthResolved();
    if (!s.user) {
      _renderGateNotice('signin', reason || 'You need to sign in to view this page.');
      s = await _whenSignedIn();
      _clearGateNotice();
      _updateIndicator();
    }
    _watchSignOutRegate(reason);
    return { allowed: true, user: s.user, profile: s.profile, degraded: !!s.degraded };
  }

  async function gateAdmin(reason) {
    var s = await requireSignIn('You need to sign in. ' + (reason || ''));
    if (!isAdmin()) {
      _renderGateNotice('admin', reason || 'This page reads lab-administrator data.');
      return { allowed: false, user: s.user, profile: s.profile };
    }
    return { allowed: true, user: s.user, profile: s.profile };
  }

  async function gateSignedIn(reason) {
    var s = await _whenAuthResolved();
    if (!s.user) {
      _renderGateNotice('signin', reason || 'You need to sign in to view this page.');
      return { allowed: false, user: null, profile: null };
    }
    return { allowed: true, user: s.user, profile: s.profile };
  }

  /* ── Public API ── */
  return {
    init: init,
    signIn: signIn,
    signInWithGoogle: signInWithGoogle,
    signOut: signOut,
    onAuth: onAuth,
    refreshProfile: refreshProfile,
    retryProfile: retryProfile,
    whenAuthResolved: whenAuthResolved,
    requireSignIn: requireSignIn,
    gateAdmin: gateAdmin,
    gateSignedIn: gateSignedIn,
    notifyAccessIssue: notifyAccessIssue,
    /* V3.585 — tab-lifecycle pause/resume of the users/{uid} profile
     * onSnapshot (Ourlab app multi-WebView shell: 1 listener × 5 warm
     * webviews is pure waste while hidden). _attachProfileLiveSync
     * self-guards on _user and diff-suppresses spurious _notifyAuth,
     * so re-attach on resume is safe and re-fires the current doc. */
    pauseProfileSync: _detachProfileLiveSync,
    resumeProfileSync: _attachProfileLiveSync,
    isReady: isReady,
    getUser: getUser,
    getProfile: getProfile,
    isAdmin: isAdmin,
    isLabMember: isLabMember,
    canEditPaper: canEditPaper,
    isLeadAuthor: isLeadAuthor,
    canAccessPage: canAccessPage,
    loadAccessGrant: loadAccessGrant,
    hasCapability: hasCapability,
    hasAnyCapabilityFor: hasAnyCapabilityFor,
    hasExplicitPageGrant: hasExplicitPageGrant,
    db: db,
    collection: collection,
    getAll: getAll,
    getPage: getPage,
    getDoc: getDoc,
    queryWhere: queryWhere,
    updateDoc: updateDoc,
    setDoc: setDoc,
    addDoc: addDoc,
    deleteDoc: deleteDoc,
    storageRef: storageRef,
    subCollection: subCollection,
    onSnapshot: onSnapshot,
    addToSub: addToSub,
    updateInSub: updateInSub,
    deleteInSub: deleteInSub,
    injectIndicator: injectIndicator,
  };
})();

// Initialize Firebase IMMEDIATELY at script-parse time (not DOMContentLoaded)
// so any page-level IIFE that calls api.load right after this script loads
// finds a ready Firebase. Without this, those IIFEs hit
//   "Firebase: No Firebase App '[DEFAULT]' has been created"
// and the adapter falls back to the slow legacy /api/data/ JSON fetch — the
// real cause of "save took 5 seconds on the local tab" on pages whose boot
// runs synchronously below their script tag. firebridge.init() is idempotent
// (re-calling it is a no-op since firebase.apps.length is checked), so we
// also keep a DOMContentLoaded fallback in case something racy delayed
// Firebase SDK availability.
try { firebridge.init(); } catch (e) { /* SDK may not be loaded yet — fallback below */ }
document.addEventListener('DOMContentLoaded', function () {
  firebridge.init();
  // Inject indicator once nav has rendered (nav.js also runs on DOMContentLoaded,
  // so use a short delay to ensure nav is in the DOM)
  setTimeout(function () { firebridge.injectIndicator(); }, 0);
});

// V3.208 — shared visibility predicate for every people-list in RM.
// V3.209 — collaborators are auto-hidden by category (no per-user flag
// needed). A user is visible iff they have a non-guest role AND they
// aren't hidden (either by the per-user `hidden` flag or by being a
// collaborator) — except admins always see everyone. Public-facing
// (parent SPA) callers inline their own filter since they don't load
// firebridge.
window.LAB_USERS = {
  isVisible: function (u) {
    if (!u || !u.role || u.role === 'guest') return false;
    var hideByCategory = u.category === 'collaborator';
    if ((u.hidden || hideByCategory) && !(typeof firebridge !== 'undefined' && firebridge.isAdmin && firebridge.isAdmin())) return false;
    return true;
  },
};
