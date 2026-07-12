/* paper-figures.js — Firebase Cloud Storage upload for paper-builder figure
 * blocks. V3.102.
 *
 * Mirrors the SHA-256 dedup pattern from rm/js/library-upload.js (which
 * handles paper PDFs under papers/{paperId}/). Figures live under a
 * separate prefix `paper-figures/{paperId}/` so the storage rule can allow
 * image content types without loosening the PDF-only rule on papers/.
 *
 * Public API (window.PAPER_FIGURES):
 *   uploadImage(paperId, blob)    → Promise<{storage_path, hash, full_hash,
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
      throw new Error('Firebase SDK not loaded — cannot upload figures.');
    }
    var user = firebase.auth().currentUser;
    if (!user) throw new Error('Sign in to upload figures.');
    return user;
  }

  function _requireStorage() {
    if (!firebase.storage) {
      throw new Error('Firebase Storage SDK not loaded — add firebase-storage-compat.js to the page.');
    }
  }

  /** Upload an image (or PDF) for use as a figure in the paper builder.
   * Skips the upload when the same byte-identical blob already exists at
   * paper-figures/{paperId}/{sha256-short}.{ext} so re-uploads don't
   * re-bill bytes. */
  async function uploadImage(paperId, blob) {
    if (!paperId) throw new Error('uploadImage: paperId required');
    if (!blob) throw new Error('uploadImage: blob required');
    var mime = blob.type || 'application/octet-stream';
    if (!ALLOWED_MIME[mime]) {
      throw new Error('Unsupported image type: ' + mime + ' (allowed: PNG, JPG, GIF, WebP, SVG, PDF).');
    }
    if (blob.size > 15 * 1024 * 1024) {
      throw new Error('Figure too large: ' + (blob.size / 1024 / 1024).toFixed(1) + ' MB (max 15 MB).');
    }

    _requireStorage();
    var user = _requireAuth();
    var hashHex = await sha256Hex(blob);
    var shortHash = hashHex.slice(0, 16);
    var ext = extForMime(mime);
    var storagePath = 'paper-figures/' + paperId + '/' + shortHash + '.' + ext;
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
          paperId: paperId,
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
      uploaded_at: new Date().toISOString().slice(0, 10),
      uploaded_by: user.email || user.uid,
      download_url: downloadUrl,
      already_existed: exists,
    };
  }

  async function downloadUrl(storagePath) {
    _requireStorage();
    return firebase.storage().ref().child(storagePath).getDownloadURL();
  }

  window.PAPER_FIGURES = {
    uploadImage: uploadImage,
    downloadUrl: downloadUrl,
    extForMime: extForMime,
    ALLOWED_MIME: ALLOWED_MIME,
  };
})();
