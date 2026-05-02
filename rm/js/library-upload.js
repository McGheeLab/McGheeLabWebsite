/* library-upload.js — Firebase Cloud Storage upload + SHA256 dedupe.
 *
 * Public API (window.LIBRARY_UPLOAD):
 *   sha256Hex(blob)            → Promise<hex string (full)>
 *   findDuplicate(hash, items) → existing paper item with that hash, or null
 *   uploadPdf(paperId, blob)   → Promise<{storage_path, hash, size_bytes,
 *                                          uploaded_at, uploaded_by, download_url}>
 *   downloadUrl(storage_path)  → Promise<string>
 *
 * The PDF blob never touches server.py — it goes straight to Firebase Cloud
 * Storage from the browser. Server.py only writes the metadata into
 * data/items.json (via PUT /api/data/items.json). See plan §A.
 */

(function () {
  async function sha256Hex(blob) {
    const buf = await blob.arrayBuffer();
    const hash = await crypto.subtle.digest('SHA-256', buf);
    return Array.from(new Uint8Array(hash))
      .map(b => b.toString(16).padStart(2, '0'))
      .join('');
  }

  function findDuplicate(hashHex, items) {
    if (!hashHex || !Array.isArray(items)) return null;
    const short = hashHex.slice(0, 16);
    for (const it of items) {
      const lib = it && it.meta && it.meta.library;
      const pdf = lib && lib.pdf;
      if (!pdf) continue;
      if (pdf.hash === hashHex || pdf.hash === short) return it;
    }
    return null;
  }

  function _requireAuth() {
    if (typeof firebase === 'undefined' || !firebase.auth) {
      throw new Error('Firebase SDK not loaded — cannot upload PDFs.');
    }
    const user = firebase.auth().currentUser;
    if (!user) throw new Error('Sign in to upload PDFs.');
    return user;
  }

  function _requireStorage() {
    if (!firebase.storage) {
      throw new Error('Firebase Storage SDK not loaded — add firebase-storage-compat.js to the page.');
    }
  }

  async function uploadPdf(paperId, blob) {
    _requireStorage();
    const user = _requireAuth();
    const hashHex = await sha256Hex(blob);
    const shortHash = hashHex.slice(0, 16);
    const storagePath = `papers/${paperId}/${shortHash}.pdf`;
    const ref = firebase.storage().ref().child(storagePath);

    // Skip the upload if the blob already exists at this path. Firebase's
    // resumable upload will overwrite by default, which would re-bill bytes
    // for the same content — check getMetadata first.
    let exists = false;
    try {
      await ref.getMetadata();
      exists = true;
    } catch (e) {
      // 404 = not found → proceed with upload. Anything else is a real error.
      if (e && e.code && e.code !== 'storage/object-not-found') throw e;
    }

    if (!exists) {
      await ref.put(blob, {
        contentType: 'application/pdf',
        customMetadata: {
          uploadedBy: user.email || user.uid,
          fullHash: hashHex,
        },
      });
    }

    const downloadUrl = await ref.getDownloadURL();
    return {
      storage_path: storagePath,
      hash: shortHash,
      full_hash: hashHex,
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

  window.LIBRARY_UPLOAD = {
    sha256Hex,
    findDuplicate,
    uploadPdf,
    downloadUrl,
  };
})();
