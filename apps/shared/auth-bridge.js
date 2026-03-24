/* ================================================================
   auth-bridge.js — Shared auth handshake for standalone lab apps
   ================================================================
   Works in two modes:

   1. EMBEDDED (inside iframe on main site)
      - Parent posts { type: 'mcgheelab-auth', token, user } via postMessage
      - Bridge verifies origin, signs into Firebase with custom token
      - Fires ready callback with user profile

   2. STANDALONE (opened directly via apps/{id}/index.html)
      - Loads Firebase SDK and config, uses onAuthStateChanged
      - If not logged in, shows a login form or redirects to main site

   Usage in each app:
     McgheeLab.AppBridge.onReady((user, profile) => { ... });
   ================================================================ */

window.McgheeLab = window.McgheeLab || {};

McgheeLab.AppBridge = (() => {
  let _readyCallbacks = [];
  let _user = null;
  let _profile = null;
  let _isEmbedded = window.parent !== window;
  let _ready = false;

  /* ─── Public API ────────────────────────────────────────── */

  function onReady(fn) {
    if (_ready) { fn(_user, _profile); return; }
    _readyCallbacks.push(fn);
  }

  function isEmbedded() { return _isEmbedded; }
  function getUser()    { return _user; }
  function getProfile() { return _profile; }
  function isAdmin()    { return _profile?.role === 'admin'; }

  /* ─── Notify listeners ──────────────────────────────────── */

  function _fireReady(user, profile) {
    _user = user;
    _profile = profile;
    _ready = true;
    _readyCallbacks.forEach(fn => fn(user, profile));
    _readyCallbacks = [];
  }

  function _fireAuthFailed() {
    _user = null;
    _profile = null;
    _ready = true;
    document.body.classList.add('app-auth-failed');
    const el = document.getElementById('app') || document.body;
    el.innerHTML = `
      <div class="app-auth-wall">
        <h2>Sign in required</h2>
        <p>This app requires a McGheeLab account.</p>
        <a href="${_isEmbedded ? '#' : '/'}#/login" target="${_isEmbedded ? '_parent' : '_self'}" class="app-auth-link">
          Go to Login
        </a>
      </div>`;
  }

  /* ─── Embedded mode: listen for parent token ────────────── */

  function _initEmbedded() {
    window.addEventListener('message', async (e) => {
      // Only accept messages from same origin (parent site)
      if (e.origin !== window.location.origin) return;
      if (e.data?.type !== 'mcgheelab-auth') return;

      const { token, user, profile } = e.data;
      if (user && profile) {
        // If parent sent a custom token, sign into Firebase
        if (token && McgheeLab.auth) {
          try {
            await McgheeLab.auth.signInWithCustomToken(token);
          } catch (err) {
            console.warn('[AppBridge] Custom token sign-in failed, using profile from parent:', err.message);
          }
        }
        _fireReady(user, profile);
      } else {
        _fireAuthFailed();
      }
    });

    // Tell parent we're ready to receive auth
    window.parent.postMessage({ type: 'mcgheelab-app-ready' }, window.location.origin);

    // Timeout: if parent doesn't respond in 5s, show auth wall
    setTimeout(() => {
      if (!_ready) _fireAuthFailed();
    }, 5000);
  }

  /* ─── Standalone mode: use Firebase directly ────────────── */

  function _initStandalone() {
    if (!McgheeLab.auth) {
      console.warn('[AppBridge] Firebase not available in standalone mode');
      _fireAuthFailed();
      return;
    }

    McgheeLab.auth.onAuthStateChanged(async (fbUser) => {
      if (fbUser) {
        try {
          const doc = await McgheeLab.db.collection('users').doc(fbUser.uid).get();
          const profile = doc.exists ? doc.data() : { role: 'guest' };
          _fireReady(
            { uid: fbUser.uid, email: fbUser.email, displayName: fbUser.displayName },
            profile
          );
        } catch (err) {
          console.warn('[AppBridge] Failed to load profile:', err);
          _fireReady(
            { uid: fbUser.uid, email: fbUser.email, displayName: fbUser.displayName },
            { role: 'guest' }
          );
        }
      } else {
        _fireAuthFailed();
      }
    });
  }

  /* ─── Init ──────────────────────────────────────────────── */

  function init() {
    document.body.classList.toggle('app-embedded', _isEmbedded);
    document.body.classList.toggle('app-standalone', !_isEmbedded);

    if (_isEmbedded) {
      _initEmbedded();
    } else {
      _initStandalone();
    }
  }

  return { init, onReady, isEmbedded, getUser, getProfile, isAdmin };
})();
