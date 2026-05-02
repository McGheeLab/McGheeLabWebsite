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
      await fb.firestore().collection('users').doc(user.uid).set(payload, { merge: true });
      await firebridge.refreshProfile();
    } catch (err) {
      console.warn('[profile-bootstrap] Failed to create users/' + user.uid + ' doc:', err.message);
    } finally {
      _bootstrapping = false;
    }
  });
})();
