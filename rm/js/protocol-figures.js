/* protocol-figures.js — Firebase Cloud Storage upload for protocol figure
 * blocks. V3.113.
 *
 * Clone of paper-figures.js with the Storage prefix swapped from
 * paper-figures/{paperId}/ to protocol-figures/{protocolId}/. (Tech debt:
 * a follow-on cleanup phase will parameterize paper-figures.js so we can
 * drop this file.)
 *
 * Public API (window.PROTOCOL_FIGURES):
 *   uploadImage(protocolId, blob)   → Promise<{storage_path, hash, ...}>
 *   downloadUrl(storage_path)       → Promise<string>
 *   extForMime(mime)                → 'png' | 'jpg' | 'svg' | 'pdf' | 'bin'
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

  async function uploadImage(protocolId, blob) {
    if (!protocolId) throw new Error('uploadImage: protocolId required');
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
    var storagePath = 'protocol-figures/' + protocolId + '/' + shortHash + '.' + ext;
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
          protocolId: protocolId,
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

  window.PROTOCOL_FIGURES = {
    uploadImage: uploadImage,
    downloadUrl: downloadUrl,
    extForMime: extForMime,
    ALLOWED_MIME: ALLOWED_MIME,
  };
})();
