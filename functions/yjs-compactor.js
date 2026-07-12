/* ================================================================
   yjs-compactor.js — periodically compact papers/{id}/yjs_updates
   ================================================================
   The paper editor (RM /pages/paper-editor.html via paper-yjs.js)
   appends one Firestore doc to papers/{paperId}/yjs_updates per
   ~200ms-batched edit. Active drafts can accumulate hundreds or
   thousands of small docs over time. Each open of the editor must
   read the snapshot + the entire post-snapshot updates collection
   to reconstruct state, so unbounded growth slows cold-start.

   This scheduled function periodically:
     1. Lists every papers/{paperId} doc.
     2. For papers where yjs_updates count > COMPACT_THRESHOLD,
        loads the existing snapshot + every update past it, applies
        them to a fresh Y.Doc, and writes a single merged snapshot
        in a transaction.
     3. Batch-deletes the consumed updates (400 ops at a time, the
        Firestore batch cap).
     4. Stamps a `compaction_inflight` lock doc at runtime so an
        overlapping schedule does not double-compact (Cloud Scheduler
        retries on transient failures and could otherwise overlap).

   Schedule:
     onSchedule('every 6 hours')

   Deploy:
     cd McGheeLabWebsite/functions
     npm install yjs                                         # one-time
     firebase deploy --only functions:compactYjsUpdates

   Manual trigger (for testing):
     firebase functions:shell
     compactYjsUpdates({ scheduleTime: new Date().toISOString() })

   Manual trigger via HTTPS (also exported for ad-hoc compaction):
     curl -X POST -H "Authorization: Bearer $(gcloud auth print-identity-token)" \
       https://us-central1-mcgheelab-f56cc.cloudfunctions.net/compactYjsNow

   ================================================================ */

const { onSchedule } = require('firebase-functions/v2/scheduler');
const { onRequest } = require('firebase-functions/v2/https');
const { getFirestore, FieldValue } = require('firebase-admin/firestore');
const Y = require('yjs');

// Match the client-side threshold in js/paper-yjs.js. Active drafts that
// exceed this on cold-load already log a "compaction recommended" warning
// in the browser console; this function actually does the compaction.
const COMPACT_THRESHOLD = 200;
// Firestore batch cap is 500 ops; leave headroom for the snapshot write
// so a single transactional commit fits under the limit.
const DELETE_BATCH = 400;
// Lock TTL — if a previous run died mid-flight without releasing the
// lock, this is how long we wait before a fresh run preempts it.
const LOCK_TTL_MS = 10 * 60 * 1000;

function _b64ToBytes(b64) {
  return Buffer.from(b64, 'base64');
}
function _bytesToB64(uint8) {
  // Y.encodeStateAsUpdate returns a Uint8Array; Buffer.from copies it.
  return Buffer.from(uint8).toString('base64');
}

async function _compactPaper(db, paperId) {
  const paperRef = db.collection('papers').doc(paperId);
  const snapshotRef = paperRef.collection('yjs_snapshot').doc('state');
  const updatesRef = paperRef.collection('yjs_updates');
  const lockRef = paperRef.collection('yjs_snapshot').doc('compaction_inflight');

  // Lock check (best-effort; not strict). If a fresh-enough lock exists,
  // skip — another invocation is in flight.
  try {
    const lockDoc = await lockRef.get();
    if (lockDoc.exists) {
      const data = lockDoc.data() || {};
      const startedAt = data.startedAt && data.startedAt.toMillis ? data.startedAt.toMillis() : 0;
      if (startedAt && (Date.now() - startedAt) < LOCK_TTL_MS) {
        console.log('[yjs-compactor]', paperId, 'skipping — lock held since', new Date(startedAt).toISOString());
        return { paperId, skipped: 'locked' };
      }
    }
    await lockRef.set({
      startedAt: FieldValue.serverTimestamp(),
      runner: process.env.K_REVISION || 'local',
    });
  } catch (err) {
    console.warn('[yjs-compactor]', paperId, 'lock acquire failed:', err.message);
    return { paperId, skipped: 'lock-error', error: err.message };
  }

  try {
    // 1. Read the current snapshot (if any) and post-snapshot updates.
    const snapDoc = await snapshotRef.get();
    const baseSeq = (snapDoc.exists && snapDoc.data() && snapDoc.data().seq) || '';
    const updatesQuery = baseSeq
      ? updatesRef.where('seq', '>', baseSeq).orderBy('seq')
      : updatesRef.orderBy('seq');
    const updatesSnap = await updatesQuery.get();

    if (updatesSnap.size <= COMPACT_THRESHOLD) {
      // Nothing to do — keeps the function cheap on inactive papers.
      return { paperId, skipped: 'below-threshold', updateCount: updatesSnap.size };
    }

    // 2. Reconstruct the full state in a fresh Y.Doc.
    const yDoc = new Y.Doc();
    if (snapDoc.exists && snapDoc.data() && snapDoc.data().stateBase64) {
      try {
        Y.applyUpdate(yDoc, _b64ToBytes(snapDoc.data().stateBase64), 'compactor');
      } catch (err) {
        console.warn('[yjs-compactor]', paperId, 'snapshot apply failed:', err.message);
        return { paperId, error: 'snapshot-apply-failed: ' + err.message };
      }
    }
    let newSeq = baseSeq;
    let appliedCount = 0;
    const consumedDocs = [];
    updatesSnap.docs.forEach((d) => {
      const data = d.data();
      if (!data || !data.bytes) return;
      try {
        Y.applyUpdate(yDoc, _b64ToBytes(data.bytes), 'compactor');
        appliedCount++;
        consumedDocs.push(d.ref);
        if (data.seq && (!newSeq || data.seq > newSeq)) newSeq = data.seq;
      } catch (err) {
        console.warn('[yjs-compactor]', paperId, 'update apply failed for', d.id, ':', err.message);
        // Continue — best-effort; one bad update shouldn't abort the whole run.
      }
    });

    if (appliedCount === 0) {
      return { paperId, skipped: 'no-applicable-updates', updateCount: updatesSnap.size };
    }

    // 3. Encode the merged state and write the new snapshot atomically.
    const mergedBytes = Y.encodeStateAsUpdate(yDoc);
    await snapshotRef.set({
      stateBase64: _bytesToB64(mergedBytes),
      seq: newSeq,
      savedAt: FieldValue.serverTimestamp(),
      savedBy: 'compactor',
      compactedFrom: appliedCount,
    });

    // 4. Batch-delete the consumed updates. Firestore batch limit is 500;
    // we use 400 to leave headroom. Deletes after the snapshot write so
    // a partial failure mid-delete leaves the system in a recoverable
    // state (snapshot has the merged state; clients pick it up; the next
    // compactor run cleans up the leftover updates).
    let deleted = 0;
    for (let i = 0; i < consumedDocs.length; i += DELETE_BATCH) {
      const batch = db.batch();
      consumedDocs.slice(i, i + DELETE_BATCH).forEach((ref) => batch.delete(ref));
      await batch.commit();
      deleted += Math.min(DELETE_BATCH, consumedDocs.length - i);
    }

    return {
      paperId,
      compacted: appliedCount,
      deleted,
      newSeq,
      newStateBytes: mergedBytes.length,
    };
  } finally {
    // Release the lock.
    try { await lockRef.delete(); } catch (err) {
      console.warn('[yjs-compactor]', paperId, 'lock release failed:', err.message);
    }
  }
}

async function _runCompaction() {
  const db = getFirestore();
  const papersSnap = await db.collection('papers').select().get();
  console.log('[yjs-compactor] scanning', papersSnap.size, 'paper(s)');
  const results = [];
  for (const paperDoc of papersSnap.docs) {
    try {
      const r = await _compactPaper(db, paperDoc.id);
      if (r && (r.compacted || r.error)) {
        console.log('[yjs-compactor]', paperDoc.id, JSON.stringify(r));
      }
      results.push(r);
    } catch (err) {
      console.error('[yjs-compactor]', paperDoc.id, 'unexpected error:', err);
      results.push({ paperId: paperDoc.id, error: err.message || String(err) });
    }
  }
  const compactedCount = results.filter((r) => r && r.compacted).length;
  const totalSavedDocs = results.reduce((s, r) => s + ((r && r.deleted) || 0), 0);
  console.log('[yjs-compactor] done — compacted', compactedCount, 'paper(s); freed', totalSavedDocs, 'update doc(s)');
  return { papers: results.length, compacted: compactedCount, freedUpdates: totalSavedDocs };
}

const compactYjsUpdates = onSchedule(
  {
    schedule: 'every 6 hours',
    timeZone: 'America/Phoenix',
    timeoutSeconds: 540,
    memory: '512MiB',
  },
  async (_event) => { await _runCompaction(); }
);

// Optional admin-triggered HTTPS endpoint for ad-hoc compaction (e.g. before
// a demo). Gated by Firebase Auth ID token in the Authorization header; only
// admins (users/{uid}.role == 'admin') may invoke. Requires a recent token.
const compactYjsNow = onRequest(
  { timeoutSeconds: 540, memory: '512MiB', cors: true },
  async (req, res) => {
    try {
      const auth = req.headers.authorization || '';
      const m = auth.match(/^Bearer\s+(.+)$/i);
      if (!m) { res.status(401).json({ error: 'missing bearer token' }); return; }
      const { getAuth } = require('firebase-admin/auth');
      const decoded = await getAuth().verifyIdToken(m[1]);
      const profile = await getFirestore().collection('users').doc(decoded.uid).get();
      const role = profile.exists ? (profile.data() || {}).role : null;
      if (role !== 'admin') { res.status(403).json({ error: 'admin only' }); return; }
      const result = await _runCompaction();
      res.json({ ok: true, result });
    } catch (err) {
      console.error('[yjs-compactor] compactYjsNow failed:', err);
      res.status(500).json({ error: err.message || String(err) });
    }
  }
);

module.exports = { compactYjsUpdates, compactYjsNow };
