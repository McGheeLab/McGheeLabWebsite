/* ================================================================
   delete-builder-paper.js — Builder paper lifecycle (server-side)
   ================================================================
   Exposes one HTTPS endpoint:

     deleteBuilderPaper({ paperId })   (POST)
     GET → health probe

   that fully removes a *builder* paper — a discriminated row in the
   `projects` collection (`type=='paper'`) authored in the paper builder
   (manuscripts, grants). This is the sibling of `deletePaper`
   (functions/library.js), which handles *library* papers (`items/{id}`,
   the uploaded reader PDFs). The two live in different id namespaces but
   share the top-level `papers/{id}/*` subcollection tree.

   A builder paper is state spread across:
     - projects/{paperId}                              (the row)
     - paperExports/{paperId}                          (export/config doc)
     - papers/{paperId}/comments/*                     (block comments)
     - papers/{paperId}/annotations/*                  (reader highlights)
     - papers/{paperId}/yjs_snapshot/* + yjs_updates/* (collab state)
     - papers/{paperId}/presence/*                     (presence pings)
     - papers/{paperId}/snapshots/*                    (named versions)
     - drafts/{paperId}/claims/*                       (claims + evidence links)
     - Cloud Storage paper-figures/{paperId}/*         (figure blobs)
     - items (any).meta.library.linked_drafts[] / cited_in_drafts[]  (associations)
     - annotations (any library PDF) .cite_in_drafts[] and
       .evidence_for_claim_ids[]  (evidence highlights pointing at this paper)

   The owned state (rows 1-8) is deleted. The cross-collection references
   (associations + evidence highlights on library PDFs) are UNLINKED, not
   deleted — the highlight/annotation survives on its library PDF; only its
   link to this now-gone paper is arrayRemove'd.

   Admin SDK server-side so that: storage.rules needn't be relaxed
   (no client-deletable path under paper-figures/), cross-user annotation
   unlinks work (firestore.rules pin per-user writes), and the whole
   cascade is one auditable request.

   Authorization: caller must be authenticated AND either a lab admin
   (users/{uid}.role == 'admin') OR the paper's lead author
   (projects/{paperId}.lead_author_uid == caller uid).
   ================================================================ */

const { onRequest } = require('firebase-functions/v2/https');
const { getFirestore, FieldValue } = require('firebase-admin/firestore');
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
  res.set('Access-Control-Allow-Methods', 'POST, GET, OPTIONS');
  res.set('Access-Control-Allow-Headers', 'Authorization, Content-Type');
  res.set('Access-Control-Max-Age', '3600');
}

// Best-effort delete of the whole Storage prefix for a paper's figures.
async function _deleteFigurePrefix(paperId) {
  const prefix = 'paper-figures/' + paperId + '/';
  try {
    await getStorage().bucket().deleteFiles({ prefix });
    return true;
  } catch (err) {
    console.warn('[deleteBuilderPaper] storage prefix delete failed for', prefix, err.message);
    return false;
  }
}

async function _recursiveDelete(db, ref, label) {
  try {
    await db.recursiveDelete(ref);
    return true;
  } catch (err) {
    console.warn('[deleteBuilderPaper] recursiveDelete ' + label + ' failed:', err.message);
    return false;
  }
}

// Unlink `paperId` from every items/*.meta.library.{linked_drafts,cited_in_drafts}.
async function _unlinkAssociations(db, paperId) {
  let unlinked = 0;
  for (const field of ['meta.library.linked_drafts', 'meta.library.cited_in_drafts']) {
    try {
      const snap = await db.collection('items').where(field, 'array-contains', paperId).get();
      for (const doc of snap.docs) {
        await doc.ref.update({ [field]: FieldValue.arrayRemove(paperId) });
        unlinked++;
      }
    } catch (err) {
      console.warn('[deleteBuilderPaper] association unlink (' + field + ') failed:', err.message);
    }
  }
  return unlinked;
}

// Unlink evidence highlights on OTHER papers' readers that pointed at this
// paper (via cite_in_drafts) or at any of its claims (via evidence_for_claim_ids).
// The annotation doc survives; only the dangling links are removed.
async function _unlinkEvidenceHighlights(db, paperId, claimIds) {
  let touched = 0;

  // a) cite_in_drafts contains the builder paper id.
  try {
    const snap = await db.collectionGroup('annotations')
      .where('cite_in_drafts', 'array-contains', paperId).get();
    for (const doc of snap.docs) {
      await doc.ref.update({ cite_in_drafts: FieldValue.arrayRemove(paperId) });
      touched++;
    }
  } catch (err) {
    console.warn('[deleteBuilderPaper] cite_in_drafts unlink failed:', err.message);
  }

  // b) evidence_for_claim_ids referencing this paper's claims. array-contains-any
  //    caps at 10 values, so chunk the claim ids. De-dupe annotation refs across
  //    chunks; a doc that loses all its evidence claims also drops its stance.
  const chunks = [];
  for (let i = 0; i < claimIds.length; i += 10) chunks.push(claimIds.slice(i, i + 10));
  const seen = new Set();
  for (const chunk of chunks) {
    if (!chunk.length) continue;
    try {
      const snap = await db.collectionGroup('annotations')
        .where('evidence_for_claim_ids', 'array-contains-any', chunk).get();
      for (const doc of snap.docs) {
        if (seen.has(doc.ref.path)) continue;
        seen.add(doc.ref.path);
        const remaining = (doc.data().evidence_for_claim_ids || [])
          .filter(id => claimIds.indexOf(id) < 0);
        const patch = { evidence_for_claim_ids: remaining };
        if (!remaining.length) patch.evidence_stance = null;
        await doc.ref.update(patch);
        touched++;
      }
    } catch (err) {
      console.warn('[deleteBuilderPaper] evidence_for_claim_ids unlink failed:', err.message);
    }
  }
  return touched;
}

const deleteBuilderPaper = onRequest(
  { cors: false, timeoutSeconds: 120 },
  async (req, res) => {
    setCors(req, res);
    if (req.method === 'OPTIONS') { res.status(204).send(''); return; }
    if (req.method === 'GET') { res.json({ ok: true, service: 'deleteBuilderPaper' }); return; }
    if (req.method !== 'POST') { res.status(405).json({ error: 'POST only' }); return; }

    const authHeader = req.headers.authorization || '';
    if (!authHeader.startsWith('Bearer ')) {
      res.status(401).json({ error: 'Missing Authorization header' });
      return;
    }
    let uid;
    try {
      const decoded = await getAuth().verifyIdToken(authHeader.slice('Bearer '.length));
      uid = decoded.uid;
    } catch (err) {
      res.status(401).json({ error: 'Invalid ID token: ' + err.message });
      return;
    }

    const paperId = req.body && req.body.paperId;
    if (!paperId || typeof paperId !== 'string') {
      res.status(400).json({ error: 'paperId required (string)' });
      return;
    }

    const db = getFirestore();
    const projRef = db.collection('projects').doc(paperId);
    const projSnap = await projRef.get();

    if (!projSnap.exists) {
      // Idempotent — clean any orphan subtrees a prior partial delete left.
      await _recursiveDelete(db, db.collection('papers').doc(paperId), 'papers/' + paperId);
      await _recursiveDelete(db, db.collection('drafts').doc(paperId), 'drafts/' + paperId);
      res.json({ ok: true, alreadyMissing: true });
      return;
    }

    const data = projSnap.data() || {};
    if (data.type !== 'paper') {
      res.status(400).json({ error: 'projects/' + paperId + ' is not a paper (type=' + data.type + ')' });
      return;
    }

    // Auth gate — admin OR lead author.
    const userDoc = await db.collection('users').doc(uid).get();
    const isAdmin = userDoc.exists && (userDoc.data().role || '') === 'admin';
    const isLead = data.lead_author_uid === uid;
    if (!isAdmin && !isLead) {
      res.status(403).json({ error: 'permission-denied: must be admin or the paper lead author' });
      return;
    }

    // Collect claim ids before deleting drafts/{paperId}/claims (needed for
    // the evidence-highlight unlink sweep).
    let claimIds = [];
    try {
      const claimsSnap = await db.collection('drafts').doc(paperId).collection('claims').get();
      claimIds = claimsSnap.docs.map(d => d.id);
    } catch (err) {
      console.warn('[deleteBuilderPaper] claim id collection failed:', err.message);
    }

    // 1. Storage figure prefix.
    const figuresDeleted = await _deleteFigurePrefix(paperId);

    // 2-3. Owned subcollection trees.
    await _recursiveDelete(db, db.collection('papers').doc(paperId), 'papers/' + paperId);
    await _recursiveDelete(db, db.collection('drafts').doc(paperId), 'drafts/' + paperId);

    // 4. Export/config doc.
    try { await db.collection('paperExports').doc(paperId).delete(); }
    catch (err) { console.warn('[deleteBuilderPaper] paperExports delete failed:', err.message); }

    // 5. Unlink cross-collection references (keep the docs).
    const assocUnlinked = await _unlinkAssociations(db, paperId);
    const evidenceUnlinked = await _unlinkEvidenceHighlights(db, paperId, claimIds);

    // 6. Delete the projects row last.
    try {
      await projRef.delete();
    } catch (err) {
      console.error('[deleteBuilderPaper] projects/' + paperId + ' delete failed:', err);
      res.status(500).json({ error: 'paper row delete failed: ' + err.message });
      return;
    }

    console.log(`[deleteBuilderPaper] ${paperId} by ${uid} (admin=${isAdmin}, lead=${isLead}) — ` +
      `figures=${figuresDeleted}, claims=${claimIds.length}, assocUnlinked=${assocUnlinked}, ` +
      `evidenceUnlinked=${evidenceUnlinked}`);

    res.json({
      ok: true,
      paperId,
      figuresDeleted,
      claimsDeleted: claimIds.length,
      assocUnlinked,
      evidenceUnlinked,
    });
  }
);

module.exports = { deleteBuilderPaper };
/* Exported for the scratchpad cascade harness (test-delete-cascade.js). */
module.exports._unlinkAssociations = _unlinkAssociations;
module.exports._unlinkEvidenceHighlights = _unlinkEvidenceHighlights;
