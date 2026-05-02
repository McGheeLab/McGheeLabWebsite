/* claims.js — Firestore-backed CRUD + live sync for paper-draft claims.
 *
 * Path: drafts/{draftId}/claims/{claimId}
 *
 * Each claim is a sentence-or-paragraph assertion the student plans to defend
 * in a draft paper. Highlights from source papers are linked to claims as
 * "evidence" (for or against). When evidence is added/removed the link is
 * written to BOTH sides atomically so the data stays consistent:
 *
 *   - The claim's `supporting_evidence_ids` / `counter_evidence_ids` array
 *     gets the {paperId, annId} entry added/removed.
 *   - The annotation's `evidence_for_claim_ids` array gets the claim id
 *     added/removed, and `evidence_stance` is updated.
 *
 * Both sides live in Firestore; we use a single transaction to update them.
 *
 * Public API (window.CLAIMS):
 *   subscribe(draftId, onChange, onError)  → unsubscribe()
 *   create(draftId, payload)                → claim id
 *   update(draftId, claimId, patch)
 *   remove(draftId, claimId)
 *   addEvidence(draftId, claimId, paperId, annId, stance)
 *   removeEvidence(draftId, claimId, paperId, annId)
 *
 * stance: "for" or "against".
 */
(function () {
  function _ensureFirebase() {
    if (typeof firebase === 'undefined' || !firebase.firestore) {
      throw new Error('Firebase Firestore SDK not loaded.');
    }
  }
  function _user() {
    if (!firebase.auth().currentUser) throw new Error('Sign in required.');
    return firebase.auth().currentUser;
  }
  function _claimsCol(draftId) {
    return firebase.firestore()
      .collection('drafts').doc(draftId)
      .collection('claims');
  }
  function _annDoc(paperId, annId) {
    return firebase.firestore()
      .collection('papers').doc(paperId)
      .collection('annotations').doc(annId);
  }

  function subscribe(draftId, onChange, onError) {
    _ensureFirebase();
    if (!draftId) throw new Error('draftId required');
    return _claimsCol(draftId).onSnapshot({
      next: snap => {
        const claims = snap.docs.map(d => Object.assign({ id: d.id }, d.data()));
        claims.sort((a, b) => {
          const ta = (a.created && a.created.toMillis) ? a.created.toMillis() : 0;
          const tb = (b.created && b.created.toMillis) ? b.created.toMillis() : 0;
          return ta - tb;
        });
        onChange(claims);
      },
      error: err => {
        console.error('[claims] subscribe error:', err);
        if (onError) onError(err);
      },
    });
  }

  async function create(draftId, payload) {
    _ensureFirebase();
    const u = _user();
    const profile = (window.firebridge && firebridge.getProfile()) || null;
    const stamp = firebase.firestore.FieldValue.serverTimestamp();
    const doc = Object.assign({
      draftPaperId: draftId,
      statement: '',
      status: 'developing',
      supporting_evidence_ids: [],
      counter_evidence_ids: [],
      tags: [],
    }, payload, {
      creator: {
        uid: u.uid,
        email: u.email || '',
        displayName: (profile && profile.name) || u.displayName || u.email || '',
      },
      created: stamp,
      modified: stamp,
    });
    const ref = await _claimsCol(draftId).add(doc);
    return ref.id;
  }

  async function update(draftId, claimId, patch) {
    _ensureFirebase();
    const enriched = Object.assign({}, patch, {
      modified: firebase.firestore.FieldValue.serverTimestamp(),
    });
    return _claimsCol(draftId).doc(claimId).update(enriched);
  }

  async function remove(draftId, claimId) {
    _ensureFirebase();
    return _claimsCol(draftId).doc(claimId).delete();
  }

  /**
   * Atomically link an annotation as evidence for a claim. Writes both
   * sides in a single transaction so the relationship can't get half-set.
   */
  async function addEvidence(draftId, claimId, paperId, annId, stance) {
    _ensureFirebase();
    if (!['for', 'against'].includes(stance)) {
      throw new Error(`stance must be "for" or "against" (got "${stance}")`);
    }
    const db = firebase.firestore();
    const claimRef = _claimsCol(draftId).doc(claimId);
    const annRef = _annDoc(paperId, annId);
    const stamp = firebase.firestore.FieldValue.serverTimestamp();

    await db.runTransaction(async (tx) => {
      const annSnap = await tx.get(annRef);
      const claimSnap = await tx.get(claimRef);
      if (!annSnap.exists) throw new Error('Annotation not found');
      if (!claimSnap.exists) throw new Error('Claim not found');

      const ann = annSnap.data();
      const claim = claimSnap.data();

      // Annotation side
      const annClaimIds = Array.isArray(ann.evidence_for_claim_ids)
        ? ann.evidence_for_claim_ids.slice() : [];
      if (!annClaimIds.includes(claimId)) annClaimIds.push(claimId);
      tx.update(annRef, {
        evidence_for_claim_ids: annClaimIds,
        evidence_stance: stance,
        modified: stamp,
      });

      // Claim side — pull the entry from the opposite stance list (in case
      // user is flipping for ↔ against), then add to the right one.
      const otherStance = stance === 'for' ? 'against' : 'for';
      const otherKey = otherStance === 'for' ? 'supporting_evidence_ids' : 'counter_evidence_ids';
      const thisKey = stance === 'for' ? 'supporting_evidence_ids' : 'counter_evidence_ids';

      const otherList = (Array.isArray(claim[otherKey]) ? claim[otherKey] : [])
        .filter(e => !(e.paperId === paperId && e.annId === annId));
      const thisList = (Array.isArray(claim[thisKey]) ? claim[thisKey] : []).slice();
      if (!thisList.some(e => e.paperId === paperId && e.annId === annId)) {
        thisList.push({ paperId, annId });
      }

      tx.update(claimRef, {
        [otherKey]: otherList,
        [thisKey]: thisList,
        modified: stamp,
      });
    });
  }

  async function removeEvidence(draftId, claimId, paperId, annId) {
    _ensureFirebase();
    const db = firebase.firestore();
    const claimRef = _claimsCol(draftId).doc(claimId);
    const annRef = _annDoc(paperId, annId);
    const stamp = firebase.firestore.FieldValue.serverTimestamp();

    await db.runTransaction(async (tx) => {
      const annSnap = await tx.get(annRef);
      const claimSnap = await tx.get(claimRef);
      if (!claimSnap.exists) return; // claim already gone — nothing to do
      const ann = annSnap.exists ? annSnap.data() : null;
      const claim = claimSnap.data();

      if (ann) {
        const annClaimIds = (Array.isArray(ann.evidence_for_claim_ids)
          ? ann.evidence_for_claim_ids : []).filter(id => id !== claimId);
        const patch = {
          evidence_for_claim_ids: annClaimIds,
          modified: stamp,
        };
        if (annClaimIds.length === 0) patch.evidence_stance = null;
        tx.update(annRef, patch);
      }

      const supporting = (Array.isArray(claim.supporting_evidence_ids) ? claim.supporting_evidence_ids : [])
        .filter(e => !(e.paperId === paperId && e.annId === annId));
      const counter = (Array.isArray(claim.counter_evidence_ids) ? claim.counter_evidence_ids : [])
        .filter(e => !(e.paperId === paperId && e.annId === annId));
      tx.update(claimRef, {
        supporting_evidence_ids: supporting,
        counter_evidence_ids: counter,
        modified: stamp,
      });
    });
  }

  window.CLAIMS = {
    subscribe,
    create,
    update,
    remove,
    addEvidence,
    removeEvidence,
  };
})();
