/* annotation-groups.js — lab-shared list of "groups" used to organize
 * non-evidence highlights (e.g. "general", "method", "background", "open
 * question"). Lives at Firestore labConfig/annotation_groups as a single
 * doc with shape:
 *
 *   { groups: [{ id: 'general', name: 'General', created_at?, created_by? }, ...] }
 *
 * "general" is the implicit default group seeded into the doc the first
 * time the page loads. Any lab member can add a group via the per-card
 * "+ New group..." action; deletes are admin-only (defer).
 *
 * Public API (window.ANNOTATION_GROUPS):
 *   subscribe(callback)              — onSnapshot listener; returns unsubscribe
 *   list()                           — last-known groups array (sync)
 *   create(name)                     — append a new group; returns the id
 *   ensureSeed()                     — write the default 'general' group if doc missing
 */
(function () {
  const DOC_PATH = ['labConfig', 'annotation_groups'];
  const DEFAULT_SEED = [
    { id: 'general', name: 'General' },
  ];

  let _groups = DEFAULT_SEED.slice();
  let _unsub = null;
  let _callbacks = [];

  function _ensureFirebase() {
    if (typeof firebase === 'undefined' || !firebase.firestore) {
      throw new Error('Firestore SDK not loaded');
    }
  }

  function _docRef() {
    return firebase.firestore().collection(DOC_PATH[0]).doc(DOC_PATH[1]);
  }

  function _slugify(s) {
    return String(s || '')
      .toLowerCase()
      .trim()
      .replace(/[^a-z0-9]+/g, '-')
      .replace(/^-|-$/g, '')
      .slice(0, 40)
      || `group-${Date.now()}`;
  }

  function list() { return _groups.slice(); }

  function _emit() {
    for (const cb of _callbacks) {
      try { cb(_groups); } catch (e) { console.error('[annotation-groups] callback failed:', e); }
    }
  }

  function subscribe(cb) {
    _callbacks.push(cb);
    if (!_unsub) {
      _ensureFirebase();
      _unsub = _docRef().onSnapshot({
        next: (doc) => {
          const data = doc.exists ? doc.data() : null;
          const groups = (data && Array.isArray(data.groups)) ? data.groups : [];
          // Always include 'general' so highlights with the default never
          // dangle. If the doc is missing or empty, use the seed.
          const ensured = groups.length ? groups : DEFAULT_SEED.slice();
          if (!ensured.some(g => g.id === 'general')) {
            ensured.unshift({ id: 'general', name: 'General' });
          }
          _groups = ensured;
          _emit();
        },
        error: (err) => {
          console.warn('[annotation-groups] subscribe error:', err.message);
        },
      });
    } else {
      // Already subscribed; fire immediately with cached value.
      cb(_groups);
    }
    // Return unsubscribe for THIS callback specifically.
    return () => {
      _callbacks = _callbacks.filter(c => c !== cb);
      if (_callbacks.length === 0 && _unsub) {
        _unsub();
        _unsub = null;
      }
    };
  }

  /** Add a new group; idempotent if a group with the same id already exists.
   *  Returns the resolved group id. */
  async function create(name) {
    _ensureFirebase();
    const trimmed = String(name || '').trim();
    if (!trimmed) throw new Error('Group name required');
    const id = _slugify(trimmed);
    const user = firebase.auth().currentUser;
    const profile = (window.firebridge && firebridge.getProfile()) || null;
    const stamp = firebase.firestore.FieldValue.serverTimestamp();

    // Skip if already present (avoid array duplicates).
    if (_groups.some(g => g.id === id)) return id;

    const newGroup = {
      id,
      name: trimmed,
      created_at: stamp,
      created_by: user ? {
        uid: user.uid,
        email: user.email || '',
        displayName: (profile && profile.name) || user.displayName || user.email || '',
      } : null,
    };
    await _docRef().set({
      groups: firebase.firestore.FieldValue.arrayUnion(newGroup),
    }, { merge: true });
    return id;
  }

  /** Write the default seed if the doc doesn't exist. Safe to call repeatedly. */
  async function ensureSeed() {
    _ensureFirebase();
    const ref = _docRef();
    const snap = await ref.get();
    if (snap.exists) return;
    await ref.set({ groups: DEFAULT_SEED.slice() });
  }

  window.ANNOTATION_GROUPS = { subscribe, list, create, ensureSeed };
})();
