/* notebook-figures.js — Firebase Cloud Storage upload for Lab Notebook
 * (ELN) attachments. Mirrors paper-figures.js but writes under the
 * private prefix `notebook-figures/{uid}/` so storage.rules can enforce
 * owner-only reads (paper figures are lab-wide-readable; notebook
 * attachments are per-user private).
 *
 * SHA-256 dedup: re-uploading byte-identical photos (common when a grad
 * student snaps multiple shots of the same notebook page) skips the
 * Storage put and just returns the existing object's download URL.
 *
 * Public API (window.NOTEBOOK_FIGURES):
 *   uploadImage(blob)             → Promise<{storage_path, hash, full_hash,
 *                                            mime, size_bytes, uploaded_at,
 *                                            uploaded_by, download_url,
 *                                            already_existed}>
 *   downloadUrl(storage_path)     → Promise<string>
 *   extForMime(mime)              → 'png' | 'jpg' | 'svg' | 'pdf' | 'bin'
 */

(function () {
  var ALLOWED_MIME = {
    'image/png':       'png',
    'image/jpeg':      'jpg',
    'image/jpg':       'jpg',
    'image/gif':       'gif',
    'image/webp':      'webp',
    'image/svg+xml':   'svg',
    'image/heic':      'heic',
    'image/heif':      'heif',
    'application/pdf': 'pdf',
  };

  function extForMime(mime) {
    return ALLOWED_MIME[mime] || 'bin';
  }

  async function sha256Hex(blob) {
    var buf = await blob.arrayBuffer();
    var hash = await crypto.subtle.digest('SHA-256', buf);
    return Array.from(new Uint8Array(hash))
      .map(function (b) { return b.toString(16).padStart(2, '0'); })
      .join('');
  }

  function _requireAuth() {
    if (typeof firebase === 'undefined' || !firebase.auth) {
      throw new Error('Firebase SDK not loaded — cannot upload notebook attachments.');
    }
    var user = firebase.auth().currentUser;
    if (!user) throw new Error('Sign in to upload notebook attachments.');
    return user;
  }

  function _requireStorage() {
    if (!firebase.storage) {
      throw new Error('Firebase Storage SDK not loaded — add firebase-storage-compat.js to the page.');
    }
  }

  /** Upload an image (or PDF) attachment for a notebook entry. The
   * blob is keyed by SHA-256 so re-uploads of the same photo skip
   * Storage bytes. Path: notebook-figures/{uid}/{shortHash}.{ext}. */
  async function uploadImage(blob) {
    if (!blob) throw new Error('uploadImage: blob required');
    var mime = blob.type || 'application/octet-stream';
    if (!ALLOWED_MIME[mime]) {
      throw new Error('Unsupported attachment type: ' + mime
        + ' (allowed: PNG, JPG, GIF, WebP, SVG, HEIC, PDF).');
    }
    if (blob.size > 15 * 1024 * 1024) {
      throw new Error('Attachment too large: ' + (blob.size / 1024 / 1024).toFixed(1)
        + ' MB (max 15 MB).');
    }

    _requireStorage();
    var user = _requireAuth();
    var hashHex = await sha256Hex(blob);
    var shortHash = hashHex.slice(0, 16);
    var ext = extForMime(mime);
    var storagePath = 'notebook-figures/' + user.uid + '/' + shortHash + '.' + ext;
    var ref = firebase.storage().ref().child(storagePath);

    var exists = false;
    try {
      await ref.getMetadata();
      exists = true;
    } catch (e) {
      if (e && e.code && e.code !== 'storage/object-not-found') throw e;
    }

    if (!exists) {
      await ref.put(blob, {
        contentType: mime,
        customMetadata: {
          uploadedBy: user.email || user.uid,
          fullHash: hashHex,
          ownerUid: user.uid,
        },
      });
    }

    var downloadUrl = await ref.getDownloadURL();
    return {
      storage_path: storagePath,
      hash: shortHash,
      full_hash: hashHex,
      mime: mime,
      size_bytes: blob.size,
      uploaded_at: new Date().toISOString(),
      uploaded_by: user.email || user.uid,
      download_url: downloadUrl,
      already_existed: exists,
    };
  }

  async function downloadUrl(storagePath) {
    _requireStorage();
    return firebase.storage().ref().child(storagePath).getDownloadURL();
  }

  window.NOTEBOOK_FIGURES = {
    uploadImage: uploadImage,
    downloadUrl: downloadUrl,
    extForMime: extForMime,
    ALLOWED_MIME: ALLOWED_MIME,
  };
})();
