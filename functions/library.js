/* ================================================================
   library.js — Library item lifecycle (server-side)
   ================================================================
   Today this exposes a single HTTPS endpoint:

     deletePaper({ itemId })

   that fully removes a paper from the lab library. The cascade is
   wider than a single doc delete because a "paper" in RM is several
   pieces of state spread across Firestore + Cloud Storage + nested
   evidence refs in every user's task tree:

     - items/{itemId}                                  (the row)
     - Cloud Storage papers/{itemId}/<hash>.pdf        (the blob)
     - papers/{itemId}/annotations/*                   (highlights)
     - papers/{itemId}/yjs_snapshot/* + yjs_updates/*  (paper-builder collab state)
     - papers/{itemId}/presence/*                      (presence pings)
     - papers/{itemId}/snapshots/*                     (paper-builder snapshots)
     - papers/{itemId}/comments/*                      (block comments)
     - userData/{uid}/tasks/* — every nested
       project/bucket/subtask/children-of-subtask
       carries an evidence.item_ids[] that may
       reference this id

   We do all of this server-side under the Admin SDK so that:
     1. We don't need to relax storage.rules (which currently has no
        client-deletable path under papers/{paperId}/).
     2. Cross-user task scrubbing actually works (firestore.rules pin
        userData writes to the owning uid).
     3. The whole cascade is one request and easy to audit in logs.

   Authorization: caller must be authenticated AND either be a lab
   admin (users/{uid}.role == 'admin') OR be the original uploader
   (items/{itemId}.meta.library.pdf.uploaded_by matches caller email).
   The same gate is enforced (best-effort) in the client UI before the
   button is even shown — this server check is the trust boundary.
   ================================================================ */

const { onRequest } = require('firebase-functions/v2/https');
const { getFirestore } = require('firebase-admin/firestore');
const { getAuth } = require('firebase-admin/auth');
const { getStorage } = require('firebase-admin/storage');

const ALLOWED_ORIGINS = [
  'https://mcgheelab.com',
  'https://www.mcgheelab.com',
  'http://localhost:8000',
];

function setCors(req, res) {
  const origin = req.headers.origin || '';
  if (ALLOWED_ORIGINS.includes(origin)) res.set('Access-Control-Allow-Origin', origin);
  res.set('Access-Control-Allow-Methods', 'POST, OPTIONS');
  res.set('Access-Control-Allow-Headers', 'Authorization, Content-Type');
  res.set('Access-Control-Max-Age', '3600');
}

// Walk a tasks doc's tree (project → bucket → subtask → children) and
// remove `itemId` from every evidence.item_ids array we find. Returns
// `true` if any change was made, so the caller can decide whether to
// write the doc back.
function _scrubItemIdFromTasksDoc(data, itemId) {
  if (!data || !Array.isArray(data.projects)) return false;
  let changed = false;

  function pruneEvidence(node) {
    if (!node || !node.evidence || !Array.isArray(node.evidence.item_ids)) return;
    const before = node.evidence.item_ids.length;
    node.evidence.item_ids = node.evidence.item_ids.filter(x => x !== itemId);
    if (node.evidence.item_ids.length !== before) changed = true;
  }

  function walkSubtask(st) {
    pruneEvidence(st);
    if (Array.isArray(st.children)) st.children.forEach(walkSubtask);
  }

  for (const project of data.projects) {
    pruneEvidence(project);
    for (const bucket of project.buckets || []) {
      pruneEvidence(bucket);
      for (const st of bucket.subtasks || []) walkSubtask(st);
    }
  }
  return changed;
}

async function _scrubAllTasksDocs(db, itemId) {
  // Collection-group scan — we cannot index inside nested arrays, so
  // every tasks doc must be read and walked. Per-user task collections
  // are small (typically <50 docs/user), so this is acceptable for an
  // admin-tier action that happens at most a few times per day.
  const snap = await db.collectionGroup('tasks').get();
  let scanned = 0;
  let updated = 0;
  for (const doc of snap.docs) {
    scanned++;
    const data = doc.data();
    if (_scrubItemIdFromTasksDoc(data, itemId)) {
      data.updated_at = new Date().toISOString();
      await doc.ref.set(data);
      updated++;
    }
  }
  return { scanned, updated };
}

async function _deleteStorageBlob(storagePath) {
  if (!storagePath) return false;
  try {
    await getStorage().bucket().file(storagePath).delete({ ignoreNotFound: true });
    return true;
  } catch (err) {
    // ignoreNotFound covers 404; everything else is logged but not fatal —
    // we'd rather complete the rest of the cascade than abort and leave
    // the item half-deleted.
    console.warn('[deletePaper] storage delete failed for', storagePath, err.message);
    return false;
  }
}

const deletePaper = onRequest(
  { cors: false, timeoutSeconds: 120 },
  async (req, res) => {
    setCors(req, res);
    if (req.method === 'OPTIONS') { res.status(204).send(''); return; }
    if (req.method !== 'POST') { res.status(405).json({ error: 'POST only' }); return; }

    const authHeader = req.headers.authorization || '';
    if (!authHeader.startsWith('Bearer ')) {
      res.status(401).json({ error: 'Missing Authorization header' });
      return;
    }
    let uid, callerEmail;
    try {
      const decoded = await getAuth().verifyIdToken(authHeader.slice('Bearer '.length));
      uid = decoded.uid;
      callerEmail = (decoded.email || '').toLowerCase();
    } catch (err) {
      res.status(401).json({ error: 'Invalid ID token: ' + err.message });
      return;
    }

    const itemId = req.body && req.body.itemId;
    if (!itemId || typeof itemId !== 'string') {
      res.status(400).json({ error: 'itemId required (string)' });
      return;
    }

    const db = getFirestore();

    // Auth gate — admin OR original uploader.
    const userDoc = await db.collection('users').doc(uid).get();
    const role = userDoc.exists ? (userDoc.data().role || '') : '';
    const isAdmin = role === 'admin';

    const itemRef = db.collection('items').doc(itemId);
    const itemSnap = await itemRef.get();
    if (!itemSnap.exists) {
      // Idempotent — if the item is already gone, treat as success but
      // still try to clean any orphan papers/{id}/* subcollections (a
      // half-finished prior delete may have left them).
      try { await db.recursiveDelete(db.collection('papers').doc(itemId)); }
      catch (err) { console.warn('[deletePaper] orphan paper-tree cleanup failed:', err.message); }
      res.json({ ok: true, alreadyMissing: true });
      return;
    }

    const lib = (itemSnap.data().meta && itemSnap.data().meta.library) || {};
    const uploadedBy = ((lib.pdf && lib.pdf.uploaded_by) || '').toLowerCase();
    const isUploader = !!callerEmail && callerEmail === uploadedBy;
    if (!isAdmin && !isUploader) {
      res.status(403).json({ error: 'permission-denied: must be admin or original uploader' });
      return;
    }

    // 1. Storage blob(s). V3.621 — also the paper-figures/{itemId}/ prefix:
    //    reader figure captures upload there (figure-capture.js) and were
    //    orphaned by item deletion (only builder papers cleaned the prefix,
    //    via delete-builder-paper.js).
    const storagePath = (lib.pdf && lib.pdf.storage_path) || '';
    const blobDeleted = await _deleteStorageBlob(storagePath);
    try {
      await getStorage().bucket().deleteFiles({ prefix: 'paper-figures/' + itemId + '/' });
    } catch (err) {
      console.warn('[deletePaper] figure-prefix delete failed for', itemId, err.message);
    }

    // 2. Recursive delete of papers/{itemId} (annotations, yjs_*, snapshots,
    //    comments, presence, plus the doc itself if any). This is a single
    //    Admin SDK call that handles batching.
    try {
      await db.recursiveDelete(db.collection('papers').doc(itemId));
    } catch (err) {
      console.error('[deletePaper] recursiveDelete papers/' + itemId + ' failed:', err);
      res.status(500).json({ error: 'subcollection delete failed: ' + err.message });
      return;
    }

    // 3. Cross-user task evidence scrubbing.
    let taskScrub = { scanned: 0, updated: 0 };
    try {
      taskScrub = await _scrubAllTasksDocs(db, itemId);
    } catch (err) {
      console.warn('[deletePaper] task scrubbing partial failure:', err.message);
    }

    // 4. Delete the items/{itemId} doc last so partial failures upstream
    //    don't leave a row pointing at half-deleted state.
    try {
      await itemRef.delete();
    } catch (err) {
      console.error('[deletePaper] items/' + itemId + ' delete failed:', err);
      res.status(500).json({ error: 'item delete failed: ' + err.message });
      return;
    }

    console.log(`[deletePaper] ${itemId} by ${callerEmail || uid} ` +
      `(admin=${isAdmin}, uploader=${isUploader}) — ` +
      `blob=${blobDeleted}, taskDocs=${taskScrub.updated}/${taskScrub.scanned}`);

    res.json({
      ok: true,
      itemId,
      blobDeleted,
      tasksScanned: taskScrub.scanned,
      tasksUpdated: taskScrub.updated,
    });
  }
);

module.exports = { deletePaper };
