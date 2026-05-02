/* library-share.js — public-share toggle for paper items.
 *
 * The flow:
 *   1. Lab member clicks "Share publicly".
 *   2. We confirm.
 *   3. Generate a long-lived signed download URL via the Storage SDK
 *      (`firebase.storage().ref(storage_path).getDownloadURL()` returns
 *      a token-bearing URL that bypasses Firestore/Storage rules — works
 *      for anyone with the URL, no auth required).
 *   4. Patch items.json: set meta.library.public=true, public_url, the
 *      shared_by email, shared_at_iso. We re-load items.json first so a
 *      concurrent edit elsewhere doesn't get clobbered.
 *   5. Display + auto-copy the public URL: /pages/library-public.html?id=<id>
 *
 * Un-share clears the flag and the URL on items.json. The previously-
 * handed-out signed URL keeps working unless the user manually rotates
 * the Storage object's download token via Firebase console — surfaced
 * to the user as a one-line warning when they un-share.
 *
 * Public API (window.LIBRARY_SHARE):
 *   share(item)    → Promise<{ public_url, share_url }>
 *   unshare(item)  → Promise<void>
 *   buildShareUrl(item) → string (the dashboard-relative URL recipients open)
 */

(function () {
  function _esc(s) {
    return String(s ?? '').replace(/[&<>"']/g, c =>
      ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c])
    );
  }

  function _requireSignedIn() {
    if (typeof firebase === 'undefined' || !firebase.auth || !firebase.auth().currentUser) {
      throw new Error('Sign in to share papers.');
    }
    return firebase.auth().currentUser;
  }

  // The recipient-facing URL. Same origin as the dashboard, since the
  // viewer page calls /api/public/paper/<id> on the server.
  //
  // Production deploy mounts RM under /rm/ (deploy_to_rm_subdir.py rewrites
  // root-absolute paths in HTML/CSS/JS, but its regex only matches "/rm/pages/
  // and '/rm/pages/ — NOT a `${origin}/pages/...` template literal). So we
  // detect the deploy base at runtime from the current pathname instead of
  // relying on the deploy-time rewrite. Works for both:
  //   local dev:   http://localhost:8000/pages/library.html
  //   production:  https://mcgheelab.com/rm/pages/library.html
  function _deployBase() {
    const path = window.location.pathname || '';
    return path.startsWith('/rm/') || path === '/rm' ? '/rm' : '';
  }

  function buildShareUrl(item) {
    const base = `${window.location.origin}${_deployBase()}/pages/library-public.html`;
    return `${base}?id=${encodeURIComponent(item.id)}`;
  }

  async function _getSignedDownloadUrl(storagePath) {
    if (!firebase.storage) throw new Error('Firebase Storage SDK not loaded.');
    const ref = firebase.storage().ref().child(storagePath);
    const url = await ref.getDownloadURL();
    return url;
  }

  // Targeted single-doc Firestore update via dotted-path syntax. Replaces
  // the previous pattern of `await api.load('items.json')` + mutate +
  // `await api.save('items.json', { items })`, which round-tripped all
  // ~3,500 items in the lab library through 9 batched commits per share
  // (10–30s in practice). This path is sub-second.
  //
  // The api adapter's cache stays correct: the cheap MAX(updatedAt) probe
  // sees the new timestamp on next load and triggers a full refresh.
  async function _patchLibraryFields(paperId, fields) {
    if (typeof firebridge === 'undefined' || !firebridge.updateDoc) {
      throw new Error('firebridge.updateDoc not available — page must load firebase-bridge.js.');
    }
    // firebridge.updateDoc stamps updatedAt automatically.
    return firebridge.updateDoc('items', paperId, fields);
  }

  async function share(item) {
    if (!item || item.type !== 'paper') throw new Error('Not a paper item.');
    const user = _requireSignedIn();
    const lib = (item.meta && item.meta.library) || {};
    if (!lib.pdf || !lib.pdf.storage_path) {
      throw new Error('This paper has no PDF attached — nothing to share.');
    }

    const publicUrl = await _getSignedDownloadUrl(lib.pdf.storage_path);
    const nowIso = new Date().toISOString();
    const sharedBy = user.email || user.uid || '';

    await _patchLibraryFields(item.id, {
      'meta.library.public': true,
      'meta.library.public_url': publicUrl,
      'meta.library.shared_at_iso': nowIso,
      'meta.library.shared_by': sharedBy,
    });

    // Mutate the in-memory item so the caller's UI updates immediately
    // without re-loading items.json.
    item.meta = item.meta || {};
    item.meta.library = item.meta.library || {};
    item.meta.library.public = true;
    item.meta.library.public_url = publicUrl;
    item.meta.library.shared_at_iso = nowIso;
    item.meta.library.shared_by = sharedBy;

    const shareUrl = buildShareUrl(item);
    // Best-effort clipboard copy. Permission failures are silently ignored
    // — the UI still shows the URL for manual copy.
    try { await navigator.clipboard.writeText(shareUrl); } catch (_) {}

    return { public_url: publicUrl, share_url: shareUrl };
  }

  async function unshare(item) {
    if (!item || item.type !== 'paper') throw new Error('Not a paper item.');
    _requireSignedIn();
    await _patchLibraryFields(item.id, {
      'meta.library.public': false,
      'meta.library.public_url': '',
      // Keep shared_at_iso / shared_by for audit — they show the prior
      // share window. Reset them only on an explicit "wipe" action.
    });
    if (item.meta && item.meta.library) {
      item.meta.library.public = false;
      item.meta.library.public_url = '';
    }
  }

  window.LIBRARY_SHARE = { share, unshare, buildShareUrl };
})();
