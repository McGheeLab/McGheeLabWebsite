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

  // Atomic-ish update against items.json — re-read, modify, write back.
  // Server.py's PUT /api/data/items.json overwrites the whole file, so a
  // concurrent edit between read and write would lose the other change;
  // for this repo's usage (one PI + a few students) it's an acceptable
  // race window.
  async function _patchItem(paperId, mutate) {
    const data = await api.load('items.json');
    const items = (data && data.items) || [];
    const idx = items.findIndex(it => it.id === paperId);
    if (idx < 0) throw new Error(`Paper ${paperId} no longer in items.json.`);
    mutate(items[idx]);
    await api.save('items.json', { items });
    return items[idx];
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
    const updated = await _patchItem(item.id, (it) => {
      it.meta = it.meta || {};
      it.meta.library = it.meta.library || {};
      it.meta.library.public = true;
      it.meta.library.public_url = publicUrl;
      it.meta.library.shared_at_iso = nowIso;
      it.meta.library.shared_by = user.email || user.uid || '';
    });

    // Mutate the in-memory item too so the caller sees the change without
    // an extra reload.
    item.meta = updated.meta;

    const shareUrl = buildShareUrl(item);
    // Best-effort clipboard copy. Permission failures are silently ignored
    // — the UI still shows the URL for manual copy.
    try { await navigator.clipboard.writeText(shareUrl); } catch (_) {}

    return { public_url: publicUrl, share_url: shareUrl };
  }

  async function unshare(item) {
    if (!item || item.type !== 'paper') throw new Error('Not a paper item.');
    _requireSignedIn();
    const updated = await _patchItem(item.id, (it) => {
      it.meta = it.meta || {};
      it.meta.library = it.meta.library || {};
      it.meta.library.public = false;
      it.meta.library.public_url = '';
      // Keep shared_at_iso / shared_by for audit — they show the prior
      // share window. Reset them only on an explicit "wipe" action.
    });
    item.meta = updated.meta;
  }

  window.LIBRARY_SHARE = { share, unshare, buildShareUrl };
})();
