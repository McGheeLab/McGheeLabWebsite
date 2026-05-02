/* annotation-sync.js — Firestore-backed live sync for paper annotations.
 *
 * Path:   papers/{paperId}/annotations/{annId}
 *
 * Visibility model: each annotation has `visibility = "lab" | "private"`.
 * - "lab"     — readable by any authenticated lab member
 * - "private" — readable only by the creator
 * Firestore Security Rules enforce this; the client also runs two queries
 * (lab + own-private) and merges, because v8 compat doesn't support `or()`.
 *
 * Public API (window.ANNOTATION_SYNC):
 *   start({paperId, onChange, onError})  → unsubscribe()
 *   create(paperId, payload)             → annotation id
 *   update(paperId, annId, patch)
 *   remove(paperId, annId)
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

  /**
   * Subscribe to live annotation updates. Returns an unsubscribe fn.
   * Two listeners (lab + own-private) merged client-side.
   */
  function start(opts) {
    _ensureFirebase();
    const { paperId, onChange, onError } = opts;
    if (!paperId) throw new Error('paperId required');

    const u = _user();
    const labCol = firebase.firestore()
      .collection('papers').doc(paperId).collection('annotations')
      .where('visibility', '==', 'lab');
    const myCol = firebase.firestore()
      .collection('papers').doc(paperId).collection('annotations')
      .where('creator.uid', '==', u.uid)
      .where('visibility', '==', 'private');

    const state = { lab: [], mine: [], ready: { lab: false, mine: false } };

    function _emit() {
      // Merge: lab covers everyone's lab annotations (including mine);
      // mine adds my private ones. Dedupe by id just in case.
      const seen = new Set();
      const merged = [];
      for (const a of state.lab.concat(state.mine)) {
        if (seen.has(a.id)) continue;
        seen.add(a.id);
        merged.push(a);
      }
      // Sort by created time (oldest first).
      merged.sort((a, b) => {
        const ta = (a.created && a.created.toMillis) ? a.created.toMillis() : 0;
        const tb = (b.created && b.created.toMillis) ? b.created.toMillis() : 0;
        return ta - tb;
      });
      onChange(merged);
    }

    const unsubLab = labCol.onSnapshot({
      next: snap => {
        state.lab = snap.docs.map(d => Object.assign({ id: d.id }, d.data()));
        state.ready.lab = true;
        _emit();
      },
      error: err => {
        console.error('[ann-sync] lab listener error:', err);
        if (onError) onError(err);
      },
    });

    const unsubMine = myCol.onSnapshot({
      next: snap => {
        state.mine = snap.docs.map(d => Object.assign({ id: d.id }, d.data()));
        state.ready.mine = true;
        _emit();
      },
      error: err => {
        console.error('[ann-sync] private listener error:', err);
        if (onError) onError(err);
      },
    });

    return function unsubscribe() {
      try { unsubLab(); } catch (_) { /* ignore */ }
      try { unsubMine(); } catch (_) { /* ignore */ }
    };
  }

  async function create(paperId, payload) {
    _ensureFirebase();
    const u = _user();
    const profile = (window.firebridge && firebridge.getProfile()) || null;
    const stamp = firebase.firestore.FieldValue.serverTimestamp();
    const doc = Object.assign({
      paperId,
      type: 'Annotation',
      motivation: 'highlighting',
      visibility: 'lab',
      color_id: 'yellow',
      group: 'general',                     // organizational bucket (Phase 6 lit-review)
      comment: '',
      target: { pages: [] },
      marked_for_investigation: false,
      evidence_for_claim_ids: [],
      evidence_stance: null,
      cite_in_drafts: [],
      parent_id: null,
    }, payload, {
      creator: {
        uid: u.uid,
        email: u.email || '',
        displayName: (profile && profile.name) || u.displayName || u.email || '',
      },
      created: stamp,
      modified: stamp,
    });
    const ref = await firebase.firestore()
      .collection('papers').doc(paperId).collection('annotations')
      .add(doc);
    return ref.id;
  }

  async function update(paperId, annId, patch) {
    _ensureFirebase();
    const enriched = Object.assign({}, patch, {
      modified: firebase.firestore.FieldValue.serverTimestamp(),
    });
    return firebase.firestore()
      .collection('papers').doc(paperId).collection('annotations')
      .doc(annId).update(enriched);
  }

  async function remove(paperId, annId) {
    _ensureFirebase();
    return firebase.firestore()
      .collection('papers').doc(paperId).collection('annotations')
      .doc(annId).delete();
  }

  /** Atomically add or remove a draft from the annotation's cite_in_drafts
   *  array. Uses arrayUnion / arrayRemove so concurrent edits don't clobber. */
  async function toggleCiteInDraft(paperId, annId, draftId, op) {
    _ensureFirebase();
    const ref = firebase.firestore()
      .collection('papers').doc(paperId)
      .collection('annotations').doc(annId);
    const FV = firebase.firestore.FieldValue;
    const change = op === 'remove'
      ? FV.arrayRemove(draftId)
      : FV.arrayUnion(draftId);
    return ref.update({
      cite_in_drafts: change,
      modified: FV.serverTimestamp(),
    });
  }

  window.ANNOTATION_SYNC = { start, create, update, remove, toggleCiteInDraft };
})();
