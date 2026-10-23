/* profile-bootstrap.js — ensures a users/{uid} doc exists for every signed-in user.
 *
 * Runs once on every page after firebase-bridge.js initializes. Listens for
 * sign-in via firebridge.onAuth, and if Firestore has no users/{uid} doc for
 * the signed-in user, creates one with role:'guest'. Then asks firebridge to
 * re-read the profile so isReady() flips true and listeners re-fire with the
 * fresh profile.
 *
 * This is the gate for multi-tenant RM access: the firestore.rules helper
 * isLabMember() is `exists(/users/$(uid))`, so no users/{uid} doc = locked
 * out of every Firestore-backed feature. Bootstrap closes that gap on first
 * sign-in (Google popup, email/password, or any other provider).
 */

(function () {
  if (typeof firebridge === 'undefined') {
    console.warn('[profile-bootstrap] firebridge not loaded; skipping.');
    return;
  }

  var _bootstrapping = false;
  var _attemptedFor = null; // uid we last attempted bootstrap for

  firebridge.onAuth(async function (user, profile) {
    if (!user) { _attemptedFor = null; return; }
    if (profile) return; // already exists — nothing to do
    if (_bootstrapping) return;
    if (_attemptedFor === user.uid) return; // don't loop on persistent failure

    _bootstrapping = true;
    _attemptedFor = user.uid;
    try {
      // Default new users to 'guest'. Admin promotes via the website's user
      // management UI. The users/{uid} doc is publicly readable for the team
      // page — keep this payload to public-safe fields.
      var fb = (typeof firebase !== 'undefined') ? firebase : null;
      if (!fb) throw new Error('firebase SDK not loaded');
      var nowStamp = fb.firestore.FieldValue.serverTimestamp();
      var payload = {
        email: user.email || '',
        name: user.displayName || (user.email || '').split('@')[0] || 'New member',
        role: 'guest',
        category: 'guest',
        createdAt: nowStamp,
        updatedAt: nowStamp,
      };
      if (user.photoURL) {
        payload.photo = { thumb: user.photoURL, medium: user.photoURL, full: user.photoURL };
      }
      // V3.805 — CREATE-ONLY, confirmed by the server. `profile` is null not
      // just when the doc is missing but when firebridge's read FAILED
      // (offline, network blip) or a cached snapshot said exists:false. The
      // old `set(payload, {merge:true})` then stamped role:'guest' over a real
      // profile — rules let an admin rewrite their own role, so it demoted the
      // PI on 2026-10-13. A transaction reads from the server (never the
      // cache) and fails instead of queueing offline, so the write only
      // happens when the doc truly does not exist.
      var ref = fb.firestore().collection('users').doc(user.uid);
      // V3.338 — retry with backoff: a transient failure here used to strand
      // the user with no profile (and no overlay) until a full reload.
      var delays = [0, 800, 2400];
      var lastErr = null;
      for (var i = 0; i < delays.length; i++) {
        if (delays[i]) await new Promise(function (r) { setTimeout(r, delays[i]); });
        try {
          await fb.firestore().runTransaction(function (t) {
            return t.get(ref).then(function (snap) {
              if (!snap.exists) t.set(ref, payload);
            });
          });
          lastErr = null;
          break;
        } catch (err) {
          lastErr = err;
          if (err && err.code === 'permission-denied') break; // retry won't help
        }
      }
      if (lastErr) throw lastErr;
      await firebridge.refreshProfile();
    } catch (err) {
      console.warn('[profile-bootstrap] Failed to create users/' + user.uid + ' doc:', err.message);
    } finally {
      _bootstrapping = false;
    }
  });

  // V3.338 — manual retry hook for firebridge.retryProfile(): clears the
  // one-attempt-per-uid latch and re-fires the auth pipeline so the handler
  // above runs again (profile still null → bootstrap re-attempts, then
  // refreshProfile re-reads).
  window.PROFILE_BOOTSTRAP = {
    retry: function () {
      _attemptedFor = null;
      if (typeof firebridge !== 'undefined' && firebridge.refreshProfile) {
        firebridge.refreshProfile();
      }
    },
  };
})();
