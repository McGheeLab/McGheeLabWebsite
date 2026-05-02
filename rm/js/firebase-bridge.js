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
      firebase.auth().onAuthStateChanged(async function (user) {
        if (user) {
          _user = user;
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

  async function _loadProfile() {
    if (!_user) { _profile = null; return; }
    try {
      var doc = await firebase.firestore().collection('users').doc(_user.uid).get();
      _profile = doc.exists ? Object.assign({ id: doc.id }, doc.data()) : null;
    } catch (err) {
      console.warn('[firebridge] Could not load profile:', err.message);
      _profile = null;
    }
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

  /* ── Auth ── */

  function signIn(email, password) {
    return firebase.auth().signInWithEmailAndPassword(email, password);
  }

  function signInWithGoogle() {
    var provider = new firebase.auth.GoogleAuthProvider();
    return firebase.auth().signInWithPopup(provider);
  }

  function signOut() {
    return firebase.auth().signOut();
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
      panel.innerHTML =
        '<div class="fb-panel-header">' +
          '<div class="fb-panel-avatar fb-profile-warn">' + _initials() + '</div>' +
          '<div>' +
            '<div class="fb-panel-name">' + _user.email + '</div>' +
            '<div class="fb-panel-sub" style="color:var(--amber);">Setting up profile…</div>' +
          '</div>' +
        '</div>' +
        '<div class="fb-panel-actions">' +
          '<button class="btn btn-danger" id="fb-signout-btn">Sign Out</button>' +
        '</div>';
    } else {
      panel.innerHTML =
        '<div class="fb-panel-header" style="flex-direction:column;align-items:flex-start;gap:4px;">' +
          '<div class="fb-panel-name">Sign in to the McGhee Lab</div>' +
          '<div class="fb-panel-sub">Use your Google account or email/password.</div>' +
        '</div>' +
        '<div id="fb-error" class="fb-panel-error" style="display:none;"></div>' +
        '<div class="fb-panel-actions">' +
          '<button class="btn btn-primary" id="fb-google-btn">Sign In with Google</button>' +
        '</div>' +
        '<details class="fb-panel-details">' +
          '<summary>Sign in with email / password</summary>' +
          '<div class="form-group">' +
            '<label>Email</label>' +
            '<input type="email" id="fb-email" placeholder="you@arizona.edu" autocomplete="email">' +
          '</div>' +
          '<div class="form-group">' +
            '<label>Password</label>' +
            '<input type="password" id="fb-password" autocomplete="current-password">' +
          '</div>' +
          '<button class="btn btn-primary" id="fb-signin-btn">Sign In</button>' +
        '</details>';
    }

    _wireProfilePanel();
  }

  function _wireProfilePanel() {
    var googleBtn = document.getElementById('fb-google-btn');
    if (googleBtn) {
      googleBtn.onclick = async function () {
        var errEl = document.getElementById('fb-error');
        googleBtn.disabled = true;
        googleBtn.textContent = 'Signing in...';
        if (errEl) errEl.style.display = 'none';
        try {
          await signInWithGoogle();
        } catch (err) {
          if (errEl) {
            errEl.textContent = err.message;
            errEl.style.display = 'block';
          }
          googleBtn.disabled = false;
          googleBtn.textContent = 'Sign In with Google';
        }
      };
    }

    var signinBtn = document.getElementById('fb-signin-btn');
    if (signinBtn) {
      signinBtn.onclick = async function () {
        var email = document.getElementById('fb-email').value.trim();
        var pass  = document.getElementById('fb-password').value;
        var errEl = document.getElementById('fb-error');
        if (!email || !pass) {
          if (errEl) { errEl.textContent = 'Enter email and password.'; errEl.style.display = 'block'; }
          return;
        }
        signinBtn.disabled = true;
        signinBtn.textContent = 'Signing in...';
        if (errEl) errEl.style.display = 'none';
        try {
          await signIn(email, pass);
        } catch (err) {
          if (errEl) { errEl.textContent = err.message; errEl.style.display = 'block'; }
          signinBtn.disabled = false;
          signinBtn.textContent = 'Sign In';
        }
      };
      var passField = document.getElementById('fb-password');
      if (passField) {
        passField.onkeydown = function (e) { if (e.key === 'Enter') signinBtn.click(); };
      }
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

  function _updatePendingOverlay() {
    if (!_user) { _removePendingOverlay(); return; }
    if (!_profile) return;            // bootstrap pending — don't flash overlay yet
    if (_profile.role === 'guest') _renderPendingOverlay();
    else _removePendingOverlay();
  }

  function _escapeHtml(s) {
    return String(s == null ? '' : s)
      .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;').replace(/'/g, '&#39;');
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
      onAuth(function (user, profile) {
        if (fired) return;
        // If user is signed in but profile is still loading, wait for the
        // refreshProfile hop (bootstrap) before deciding.
        if (user && !profile) return;
        fired = true;
        resolve({ user: user, profile: profile });
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

  function _renderGateNotice(level, html) {
    var main = document.querySelector('main, #app, .page') || document.body;
    main.innerHTML =
      '<div class="page" style="padding:32px;max-width:640px;margin:0 auto;">' +
        '<div class="card" style="padding:24px;border-left:4px solid ' +
          (level === 'admin' ? 'var(--amber,#d97706)' : 'var(--red,#dc2626)') + ';">' +
          '<h2 style="margin-top:0;font-size:18px;">' +
            (level === 'admin' ? 'Admin only' : level === 'signin' ? 'Sign-in required' : 'Not authorized') +
          '</h2>' +
          '<div style="color:var(--muted,#6b7280);font-size:14px;line-height:1.5;">' + html + '</div>' +
          '<div style="margin-top:16px;"><a class="btn" href="/rm/index.html">Back to dashboard</a></div>' +
        '</div>' +
      '</div>';
  }

  async function gateAdmin(reason) {
    var s = await _whenAuthResolved();
    if (!s.user) {
      _renderGateNotice('signin', 'You need to sign in. ' + (reason || ''));
      return { allowed: false, user: null, profile: null };
    }
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
    whenAuthResolved: whenAuthResolved,
    gateAdmin: gateAdmin,
    gateSignedIn: gateSignedIn,
    isReady: isReady,
    getUser: getUser,
    getProfile: getProfile,
    isAdmin: isAdmin,
    isLabMember: isLabMember,
    canEditPaper: canEditPaper,
    isLeadAuthor: isLeadAuthor,
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
