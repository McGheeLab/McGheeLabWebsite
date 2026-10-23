/* library-links.js — V3.352 (+V3.366 cited flags, +V3.367 themes)
 *
 * THE single writer for the per-item association arrays under
 * items/{id}.meta.library:
 *
 *   linked_drafts    — library↔draft association (builder References tab,
 *                      reader overlays + sidebar pills, grant editor,
 *                      Evidence Inbox, library badge/popover)
 *   cited_in_drafts  — denormalized "cited in draft X" flag maintained by
 *                      the builder's CITED_SYNC (V3.366); consumed by the
 *                      association pills' uncited dot
 *   themes           — Lab Theme membership (V3.367 library Themes tab +
 *                      reader theme chips)
 *   roadmaps         — research-roadmap membership (V3.600); the reverse
 *                      index for researchFoci/{id}/refs
 *
 * Before this module, FOUR surfaces each did their own
 * api.load('items.json') → mutate → api.save(whole array). The adapter's
 * collection save is a full-collection batch replace, so two concurrent
 * writers (e.g. one student linking from the builder while another links
 * from the reader) silently lost one of the writes.
 *
 * Every write here is concurrency-safe by construction: a single-doc
 * update() with FieldValue.arrayUnion/arrayRemove — no read-modify-write
 * at all. Each stamps updatedAt (serverTimestamp) + updated_at so the api
 * adapter's MAX(updatedAt) staleness probe invalidates other clients'
 * cached items.json / library/papers.json (the V3.309 `_saveOne`
 * pattern). The items update rule's V3.309 branch already allows lab
 * members nested-field updates on library entries — no rules change.
 *
 * Public API (window.LIBRARY_LINKS):
 *   toggleDraftLink(itemId, draftId, makeLink) → Promise<string[]>
 *     Links (true) or unlinks (false) draftId on the library item and
 *     resolves with the fresh linked_drafts array.
 *   setCitedInDraft(itemId, draftId, makeCited) → Promise<void>
 *     Adds/removes draftId in cited_in_drafts. No read-back — the
 *     builder's sync loop applies these in batches and patches its own
 *     cache, so the extra get() per op would be wasted reads.
 *   toggleTheme(itemId, themeId, makeMember) → Promise<string[]>
 *     Adds/removes themeId in meta.library.themes and resolves with the
 *     fresh themes array. Removal also clears any theme_relevance entry.
 *   setThemeRelevance(itemId, themeId, weight) → Promise<void>
 *     Writes meta.library.theme_relevance[themeId] = 1|2|3 (falsy clears).
 *     The per-theme paper weight behind Lab Themes research-group ranking.
 */
(function () {
  'use strict';

  /* V3.631 — ONE definition of "which grant statuses count as a draft".
   *
   * This list was copy-pasted into FOUR files — paper-overlays.js (Set),
   * library-associations.js (object map, whose comment already admitted it was
   * "a mirror of paper-overlays.js"), library-paper.js and
   * library-mobile-paper.js (inline Sets inside their draft loaders). Four
   * places to edit means the pickers can disagree about what a draft is, and
   * "every picker shows a different list" is one of the things that made this
   * subsystem confusing in the first place.
   *
   * It lives here because library-links.js is the single writer for the
   * association arrays AND the only one of these modules loaded on all six
   * pages that need it — including library-mobile-paper.html, which does not
   * load library-associations.js. Consumers keep a local fallback so a module
   * that loads before this one can never crash.
   *
   * Awarded / active / completed grants are not drafts — they're post-award
   * work. Proposals are anything we'd still cite toward. */
  var GRANT_DRAFT_STATUSES = [
    'drafting', 'submitted', 'under_review', 'revising', 'rejected',
  ];

  function isGrantDraftStatus(status) {
    return GRANT_DRAFT_STATUSES.indexOf(status) !== -1;
  }

  function _db() {
    if (typeof firebase === 'undefined' || !firebase.firestore) {
      throw new Error('Firestore unavailable — cannot update library links.');
    }
    return firebase.firestore();
  }

  /* V3.627 — bust the route caches after every direct write.
   *
   * Every writer in this module updates `items/{id}` through the Firestore
   * SDK, entirely OUTSIDE api.save, so the adapter's stale-while-revalidate
   * route cache for items.json / library/papers.json keeps serving the
   * PRE-WRITE list. Consumers that refresh with api.load (paper-overlays'
   * _fetchLinkedDrafts, library-associations' loadDraftInfo,
   * library-paper's onChange handler) therefore re-derive from the old
   * array and paint the link away again — the write lands in Firestore but
   * the UI shows nothing, with no error anywhere. That's the "I link a
   * paper to a draft and it just doesn't work" report.
   *
   * The MEDIUM-cache MAX(updatedAt) probe does NOT save us: the write's
   * serverTimestamp has to land in the orderBy('updatedAt') index before a
   * QUERY can see it, so a probe fired immediately after the ack can still
   * read the previous top doc and conclude "nothing changed".
   *
   * api.invalidate (V3.485) exists for exactly this; library-upload.js,
   * library-fetch-pdfs.js and library-mobile.js all call it after their
   * direct writes — this module was the one that never did. Awaited so
   * callers that refresh immediately after us can't race the clear. */
  async function _bustItemCaches() {
    if (typeof api === 'undefined' || !api.invalidate) return;
    try {
      await Promise.all([
        api.invalidate('items.json'),
        api.invalidate('library/papers.json'),
      ]);
    } catch (e) {
      console.warn('[library-links] cache invalidate failed:', e.message || e);
    }
  }

  // Shared atomic single-doc array toggle. fieldPath is a dotted
  // Firestore field path under the item doc; readBackKey (optional) is
  // the meta.library array to return fresh after the write.
  async function _toggleArrayField(itemId, fieldPath, value, makePresent, readBackKey) {
    if (!itemId || !value) throw new Error('itemId and value are required.');
    var db = _db();
    var ref = db.collection('items').doc(itemId);
    var patch = {
      /* Cache-probe stamps — mirror library.js _saveOne so other
       * clients' cached items.json invalidates. */
      updated_at: new Date().toISOString().slice(0, 10),
      updatedAt: firebase.firestore.FieldValue.serverTimestamp(),
    };
    patch[fieldPath] = makePresent
      ? firebase.firestore.FieldValue.arrayUnion(value)
      : firebase.firestore.FieldValue.arrayRemove(value);
    await ref.update(patch);
    await _bustItemCaches();
    if (!readBackKey) return null;
    var snap = await ref.get();
    var data = snap.data() || {};
    var lib = (data.meta && data.meta.library) || {};
    return Array.isArray(lib[readBackKey]) ? lib[readBackKey].slice() : [];
  }

  async function toggleDraftLink(itemId, draftId, makeLink) {
    return _toggleArrayField(itemId, 'meta.library.linked_drafts', draftId, makeLink, 'linked_drafts');
  }

  /* V3.366 — cited flag, written by the builder's CITED_SYNC diff loop. */
  async function setCitedInDraft(itemId, draftId, makeCited) {
    await _toggleArrayField(itemId, 'meta.library.cited_in_drafts', draftId, makeCited, null);
  }

  /* V3.367 — Lab Theme membership. V3.496: dropping membership also clears
   * the paper's per-theme relevance weight in the same atomic update, so no
   * orphaned theme_relevance keys accumulate. (Not routed through
   * _toggleArrayField because of that extra field.) */
  async function toggleTheme(itemId, themeId, makeMember) {
    if (!itemId || !themeId) throw new Error('itemId and themeId are required.');
    var db = _db();
    var ref = db.collection('items').doc(itemId);
    var patch = {
      updated_at: new Date().toISOString().slice(0, 10),
      updatedAt: firebase.firestore.FieldValue.serverTimestamp(),
    };
    patch['meta.library.themes'] = makeMember
      ? firebase.firestore.FieldValue.arrayUnion(themeId)
      : firebase.firestore.FieldValue.arrayRemove(themeId);
    if (!makeMember) {
      // Theme ids are kebab slugs (dot-free) so the dotted map path is safe.
      patch['meta.library.theme_relevance.' + themeId] =
        firebase.firestore.FieldValue.delete();
    }
    await ref.update(patch);
    await _bustItemCaches();
    var snap = await ref.get();
    var data = snap.data() || {};
    var lib = (data.meta && data.meta.library) || {};
    return Array.isArray(lib.themes) ? lib.themes.slice() : [];
  }

  /* V3.496 — per-paper relevance weight within a theme, stored as the
   * parallel map meta.library.theme_relevance:{ [themeId]: 1|2|3 } (Core 3 /
   * Supporting 2 / Tangential 1). Boolean membership (themes[]) is left
   * untouched; an unset weight is read as Supporting (2) by consumers. Pass
   * a falsy weight to clear the entry. Single-doc update() → concurrency-safe,
   * no read-back. */
  /* V3.600 — research-roadmap membership. The authoritative record of an
   * attachment is researchFoci/{fociId}/refs/{refId} (it carries the note
   * saying why the paper belongs there); this array is the reverse index
   * so the library table and the reader sidebar can answer "which
   * roadmaps is this paper on?" with a field read instead of a
   * collectionGroup query across every card's refs. */
  async function toggleRoadmap(itemId, fociId, makePresent) {
    return _toggleArrayField(itemId, 'meta.library.roadmaps', fociId, makePresent, 'roadmaps');
  }

  async function setThemeRelevance(itemId, themeId, weight) {
    if (!itemId || !themeId) throw new Error('itemId and themeId are required.');
    var db = _db();
    var ref = db.collection('items').doc(itemId);
    var patch = {
      updated_at: new Date().toISOString().slice(0, 10),
      updatedAt: firebase.firestore.FieldValue.serverTimestamp(),
    };
    patch['meta.library.theme_relevance.' + themeId] = weight
      ? weight
      : firebase.firestore.FieldValue.delete();
    await ref.update(patch);
    await _bustItemCaches();
  }

  window.LIBRARY_LINKS = {
    GRANT_DRAFT_STATUSES: GRANT_DRAFT_STATUSES,   // V3.631 — the one copy
    isGrantDraftStatus: isGrantDraftStatus,
    toggleDraftLink: toggleDraftLink,
    setCitedInDraft: setCitedInDraft,
    toggleTheme: toggleTheme,
    setThemeRelevance: setThemeRelevance,
    toggleRoadmap: toggleRoadmap,
  };
})();
