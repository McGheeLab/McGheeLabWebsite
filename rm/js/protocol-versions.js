/* protocol-versions.js — V3.119.
 *
 * Versioning + forking for the Protocols Builder. Operates on Firestore
 * directly (not via the api-routes adapter) because the data lives in
 * subcollections (`protocols/{id}/versions/{vN}`) and uses transactions
 * to keep `current_version` / `fork_count` monotonically consistent.
 *
 * Public surface:
 *   PROTOCOL_VERSIONS.saveVersion(protocolId, treeJson, opts) → Promise<v#>
 *   PROTOCOL_VERSIONS.listVersions(protocolId)               → Promise<[…]>
 *   PROTOCOL_VERSIONS.loadVersion(protocolId, vN)             → Promise<doc>
 *   PROTOCOL_VERSIONS.forkProtocol(srcId, opts)               → Promise<newId>
 *   PROTOCOL_VERSIONS.migrateForkToStandalone(forkId)         → Promise<void>
 *
 * `treeJson` is the dehydrated plain-JSON tree (call
 * window.ProtocolBlocks.dehydrateTree(yDoc) before passing in).
 */

(function () {
  function _db() {
    if (typeof firebridge === 'undefined' || !firebridge.db) {
      throw new Error('protocol-versions: firebridge not loaded');
    }
    return firebridge.db();
  }

  function _user() {
    if (typeof firebridge === 'undefined' || !firebridge.getUser) return null;
    return firebridge.getUser();
  }

  function _displayName() {
    var u = _user();
    if (!u) return '';
    var profile = firebridge.getProfile && firebridge.getProfile();
    return (profile && profile.name) || u.displayName || u.email || u.uid;
  }

  /* Deep-clone a JSON tree. The tree is plain JSON (no Y types) when
   * passed in from dehydrateTree, so JSON round-trip is safe. */
  function _cloneTree(tree) {
    return JSON.parse(JSON.stringify(tree || { meta: {}, sections: [] }));
  }

  /* ── Save a version snapshot ────────────────────────────────────
   *
   * Atomically: increment current_version on the parent doc, write a
   * new snapshot doc at versions/v{N}.
   *
   * @param protocolId  string
   * @param treeJson    plain JSON {meta, sections} (NOT a Y.Doc)
   * @param opts        { metaSnapshot, label, message }
   * @returns           Promise<{version, snapshotPath}>
   */
  async function saveVersion(protocolId, treeJson, opts) {
    opts = opts || {};
    if (!protocolId) throw new Error('saveVersion: protocolId required');
    if (!treeJson) throw new Error('saveVersion: treeJson required');
    var user = _user();
    if (!user) throw new Error('saveVersion: must be signed in');

    var db = _db();
    var protocolRef = db.collection('protocols').doc(protocolId);

    return db.runTransaction(async function (tx) {
      var snap = await tx.get(protocolRef);
      if (!snap.exists) throw new Error('Protocol not found: ' + protocolId);
      var doc = snap.data();
      var nextVersion = (typeof doc.current_version === 'number' ? doc.current_version : 0) + 1;
      var versionRef = protocolRef.collection('versions').doc('v' + nextVersion);

      var now = new Date().toISOString();
      var versionDoc = {
        version: nextVersion,
        tree: _cloneTree(treeJson),
        meta_snapshot: opts.metaSnapshot || {
          title: doc.title || '',
          summary: doc.summary || '',
          status: doc.status || 'draft',
          tags: doc.tags || [],
          category: doc.category || '',
        },
        snapshot_at: now,
        snapshot_by_uid: user.uid,
        snapshot_by_name: _displayName(),
        parent_version: nextVersion > 1 ? (nextVersion - 1) : null,
        label: opts.label || '',
        message: opts.message || '',
      };

      tx.set(versionRef, versionDoc);
      tx.update(protocolRef, {
        current_version: nextVersion,
        latest_snapshot_at: now,
        updated_at: now,
      });
      return { version: nextVersion, snapshotPath: versionRef.path };
    });
  }

  /* List versions newest-first. */
  async function listVersions(protocolId) {
    if (!protocolId) throw new Error('listVersions: protocolId required');
    var snap = await _db().collection('protocols').doc(protocolId)
      .collection('versions').orderBy('version', 'desc').get();
    return snap.docs.map(function (d) { return d.data(); });
  }

  /* Load one version snapshot by number. */
  async function loadVersion(protocolId, vN) {
    if (!protocolId) throw new Error('loadVersion: protocolId required');
    if (typeof vN !== 'number' || vN < 1) throw new Error('loadVersion: bad version: ' + vN);
    var snap = await _db().collection('protocols').doc(protocolId)
      .collection('versions').doc('v' + vN).get();
    if (!snap.exists) throw new Error('Version v' + vN + ' not found');
    return snap.data();
  }

  /* ── Fork ──────────────────────────────────────────────────────
   *
   * Reads the source protocol (and the chosen version snapshot, if any),
   * creates a new top-level protocols/{forkId} owned by the current
   * user, and increments the source's fork_count. Atomic via transaction.
   *
   * @param srcId   source protocol id
   * @param opts    {forkId, title, version} — version null = use live tree
   * @returns       Promise<forkId>
   */
  async function forkProtocol(srcId, opts) {
    opts = opts || {};
    var user = _user();
    if (!user) throw new Error('forkProtocol: must be signed in');
    if (!srcId) throw new Error('forkProtocol: srcId required');
    if (!opts.forkId) throw new Error('forkProtocol: forkId required');
    if (!/^[a-z0-9][a-z0-9-]*$/.test(opts.forkId)) {
      throw new Error('forkProtocol: forkId must be kebab-case');
    }

    var db = _db();
    var srcRef  = db.collection('protocols').doc(srcId);
    var forkRef = db.collection('protocols').doc(opts.forkId);

    // Fork from a specific version snapshot, or from the live tree.
    var sourceVersion = (typeof opts.version === 'number') ? opts.version : null;
    var sourceTree, sourceVersionForLineage;

    if (sourceVersion) {
      var versionSnap = await srcRef.collection('versions').doc('v' + sourceVersion).get();
      if (!versionSnap.exists) throw new Error('Source version v' + sourceVersion + ' not found');
      sourceTree = versionSnap.data().tree;
      sourceVersionForLineage = sourceVersion;
    }

    return db.runTransaction(async function (tx) {
      var srcSnap = await tx.get(srcRef);
      if (!srcSnap.exists) throw new Error('Source protocol not found: ' + srcId);
      var src = srcSnap.data();

      var forkSnap = await tx.get(forkRef);
      if (forkSnap.exists) throw new Error('A protocol with id "' + opts.forkId + '" already exists');

      var liveTree = sourceTree || src.tree || { meta: {}, sections: [] };
      var liveVersion = sourceVersionForLineage !== undefined
        ? sourceVersionForLineage
        : (typeof src.current_version === 'number' ? src.current_version : 0);

      var now = new Date().toISOString();
      var profile = firebridge.getProfile && firebridge.getProfile();
      var displayName = (profile && profile.name) || user.displayName || user.email || user.uid;

      var forkDoc = window.ProtocolSchemas.protocolEmptyDoc({
        id: opts.forkId,
        title: opts.title || ((src.title || 'Untitled') + ' (fork)'),
        ownerUid: user.uid,
        author_uid: user.uid,
        author_name: displayName,
        category: src.category || '',
        tags: Array.isArray(src.tags) ? src.tags.slice() : [],
        summary: src.summary || '',
        tree: _cloneTree(liveTree),
        forked_from: {
          protocol_id: srcId,
          protocol_title: src.title || srcId,
          version: liveVersion,                  // 0 if forking pre-snapshot
          forked_at: now,
          forked_by_uid: user.uid,
          migrated_to_standalone_at: null,
        },
      });
      // Override created_at / updated_at — protocolEmptyDoc set them but
      // we want the deterministic `now` for both writes in the txn.
      forkDoc.created_at = now;
      forkDoc.updated_at = now;

      tx.set(forkRef, forkDoc);
      tx.update(srcRef, {
        fork_count: (typeof src.fork_count === 'number' ? src.fork_count : 0) + 1,
      });

      return opts.forkId;
    });
  }

  /* List forks of a parent protocol. Used by the parent's editor topbar
   * to show "Forks (N)". */
  async function listForks(parentProtocolId) {
    if (!parentProtocolId) return [];
    try {
      var snap = await _db().collection('protocols')
        .where('forked_from.protocol_id', '==', parentProtocolId)
        .get();
      return snap.docs.map(function (d) { return d.data(); });
    } catch (err) {
      // Index may not be deployed yet — degrade gracefully.
      console.warn('[protocol-versions] listForks failed (index may be missing):', err.message);
      return [];
    }
  }

  /* ── Migrate a fork to standalone ───────────────────────────────
   *
   * Stamps `forked_from.migrated_to_standalone_at` with the current
   * timestamp. We deliberately DON'T null `forked_from` — keeping the
   * lineage record for analytics. The UI hides the fork-of badge once
   * `migrated_to_standalone_at` is non-null.
   */
  async function migrateForkToStandalone(forkId) {
    var user = _user();
    if (!user) throw new Error('migrateForkToStandalone: must be signed in');
    if (!forkId) throw new Error('migrateForkToStandalone: forkId required');

    var db = _db();
    var forkRef = db.collection('protocols').doc(forkId);
    var snap = await forkRef.get();
    if (!snap.exists) throw new Error('Protocol not found: ' + forkId);
    var doc = snap.data();
    if (!doc.forked_from || !doc.forked_from.protocol_id) {
      throw new Error('Protocol "' + forkId + '" is not a fork');
    }
    if (doc.forked_from.migrated_to_standalone_at) {
      throw new Error('Already migrated to standalone');
    }
    if (doc.ownerUid !== user.uid && !(firebridge.isAdmin && firebridge.isAdmin())) {
      throw new Error('Only the fork owner can migrate it to standalone');
    }

    var now = new Date().toISOString();
    var updatedFrom = Object.assign({}, doc.forked_from, { migrated_to_standalone_at: now });
    await forkRef.update({
      forked_from: updatedFrom,
      updated_at: now,
    });
  }

  /* True iff a fork's `forked_from` indicates active fork-of relation
   * (i.e. not migrated to standalone). */
  function isLinkedFork(doc) {
    return !!(doc && doc.forked_from && doc.forked_from.protocol_id
              && !doc.forked_from.migrated_to_standalone_at);
  }

  window.PROTOCOL_VERSIONS = {
    saveVersion: saveVersion,
    listVersions: listVersions,
    loadVersion: loadVersion,
    forkProtocol: forkProtocol,
    listForks: listForks,
    migrateForkToStandalone: migrateForkToStandalone,
    isLinkedFork: isLinkedFork,
  };
})();
