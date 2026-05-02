/* paper-yjs.js — Yjs CRDT provider for the paper builder (Phase B).
 *
 * Persistence model in Firestore:
 *   papers/{paperId}/yjs_snapshot/state          — { stateBase64, seq, savedAt, savedBy }
 *   papers/{paperId}/yjs_updates/{seq}           — { bytes (b64), seq, originId, authorUid, ts }
 *   papers/{paperId}/presence/{uid}              — { name, color, lastSeen, focusBlockId }
 *
 * Snapshot and updates live in separate subcollections so a `where('seq', '>', X)`
 * query against updates can't accidentally pick up the snapshot doc.
 *
 * Outgoing path: local Yjs updates are throttled (200ms), merged via
 * Y.mergeUpdates, and written as one document with `seq = Date.now()-padded +
 * '-' + clientId4`. The `originId` field lets remote clients skip their own
 * writes when they later observe them via onSnapshot.
 *
 * Incoming path: load `snapshot`, apply, then catch up on `updates` where
 * `seq > snapshot.seq`, then subscribe via onSnapshot for new updates.
 *
 * Compaction is opportunistic and stubbed in this phase: if updates exceed
 * COMPACT_THRESHOLD on open, we log a warning. A real compactor (transaction-
 * locked, lead-author-only) is a follow-up.
 */

(function () {
  /* ── Yjs lazy loader ── */

  var YJS_CDN = 'https://cdn.jsdelivr.net/npm/yjs@13/+esm';
  var _Y = null;
  var _yjsPromise = null;

  function ensureYjs() {
    if (_Y) return Promise.resolve(_Y);
    if (_yjsPromise) return _yjsPromise;
    _yjsPromise = import(YJS_CDN).then(function (mod) {
      _Y = mod;
      return mod;
    });
    return _yjsPromise;
  }

  /* ── helpers ── */

  function bytesToB64(uint8) {
    var s = '';
    var chunk = 0x8000;
    for (var i = 0; i < uint8.length; i += chunk) {
      s += String.fromCharCode.apply(null, uint8.subarray(i, i + chunk));
    }
    return btoa(s);
  }
  function b64ToBytes(b64) {
    var bin = atob(b64);
    var arr = new Uint8Array(bin.length);
    for (var i = 0; i < bin.length; i++) arr[i] = bin.charCodeAt(i);
    return arr;
  }
  function pad(n, w) { var s = String(n); while (s.length < w) s = '0' + s; return s; }
  function shortNonce() {
    var alphabet = '0123456789abcdefghjkmnpqrstvwxyz';
    var s = '';
    for (var i = 0; i < 6; i++) s += alphabet[Math.floor(Math.random() * alphabet.length)];
    return s;
  }
  function makeSeq(clientId4) {
    // Date.now is 13 digits as of 2026; pad to 16 for headroom past year ~5000.
    return pad(Date.now(), 16) + '-' + clientId4 + '-' + shortNonce();
  }

  /* Pick a stable color per uid (cheap hash → hue). */
  function colorForUid(uid) {
    var s = String(uid || 'anon');
    var h = 0;
    for (var i = 0; i < s.length; i++) h = (h * 31 + s.charCodeAt(i)) | 0;
    var hue = Math.abs(h) % 360;
    return 'hsl(' + hue + ' 70% 45%)';
  }

  /* ── Provider ── */

  var COMPACT_THRESHOLD = 200;
  var THROTTLE_MS = 200;
  var PRESENCE_HEARTBEAT_MS = 10000;
  var PRESENCE_STALE_MS = 30000;

  /** Connect a Yjs document to Firestore for the given paper.
   *
   * Returns a promise resolving to {
   *   yDoc: Y.Doc,
   *   ready: Promise<void>           // resolves when initial sync is done
   *   getPresence(): array of { uid, name, color, lastSeen, focusBlockId }
   *   onPresence(cb): listener; cb(presenceArray) on each change; returns unsubscribe
   *   setFocusBlock(blockId): updates this client's presence focus
   *   disconnect(): closes listeners and deletes own presence doc
   *   yClientId: short client tag used in seqs
   * }.
   */
  async function connect(paperId, opts) {
    opts = opts || {};
    var Y = await ensureYjs();
    if (typeof firebridge === 'undefined' || !firebridge.getUser()) {
      throw new Error('paper-yjs: firebridge user required');
    }

    var user = firebridge.getUser();
    var profile = firebridge.getProfile();
    var displayName = (profile && profile.name) || (user && (user.displayName || user.email)) || user.uid;

    var yDoc = new Y.Doc();
    var clientId4 = pad((Math.random() * 0xffff) | 0, 4).slice(-4);
    var originId = clientId4 + '-' + shortNonce();

    var db = firebridge.db();
    var paperRef    = db.collection('papers').doc(paperId);
    var snapshotRef = paperRef.collection('yjs_snapshot').doc('state');
    var updatesRef  = paperRef.collection('yjs_updates');

    /* 1. Load snapshot */
    var snapDoc = null;
    try {
      var s = await snapshotRef.get();
      snapDoc = s.exists ? s.data() : null;
    } catch (err) {
      console.warn('[paper-yjs] snapshot read failed:', err.message);
    }
    var baseSeq = '';
    if (snapDoc && snapDoc.stateBase64) {
      Y.applyUpdate(yDoc, b64ToBytes(snapDoc.stateBase64), 'remote');
      baseSeq = snapDoc.seq || '';
    }

    /* 2. Catch up on post-snapshot updates */
    var catchupQuery = baseSeq
      ? updatesRef.where('seq', '>', baseSeq).orderBy('seq')
      : updatesRef.orderBy('seq');
    var catchupSnap;
    try {
      catchupSnap = await catchupQuery.get();
    } catch (err) {
      // Surface a more actionable error for the common "rules not deployed"
      // case. Rules live in McGheeLabWebsite/firestore.rules — see
      // docs/firestore-rules.txt for the deploy command.
      if (err && err.code === 'permission-denied') {
        var e = new Error('Firestore rules block reads on papers/' + paperId +
          '/yjs_updates. Edit firestore.rules in McGheeLabWebsite and run ' +
          '`firebase deploy --only firestore:rules` (see docs/firestore-rules.txt).');
        e.cause = err;
        throw e;
      }
      throw err;
    }
    var lastSeq = baseSeq;
    catchupSnap.docs.forEach(function (d) {
      var data = d.data();
      if (data && data.bytes) {
        try {
          Y.applyUpdate(yDoc, b64ToBytes(data.bytes), 'remote');
          if (data.seq && (!lastSeq || data.seq > lastSeq)) lastSeq = data.seq;
        } catch (err) {
          console.warn('[paper-yjs] failed to apply update', d.id, err.message);
        }
      }
    });
    if (catchupSnap.size > COMPACT_THRESHOLD) {
      console.warn('[paper-yjs] ' + catchupSnap.size + ' updates loaded — compaction recommended (deferred to follow-up).');
    }

    /* 3. Subscribe to new updates */
    var subscribeStartSeq = lastSeq || makeSeq(clientId4);
    // We subscribe on > the latest seq we've seen so far.
    var subQuery = updatesRef.where('seq', '>', subscribeStartSeq).orderBy('seq');
    var unsubUpdates = subQuery.onSnapshot({
      next: function (snap) {
        snap.docChanges().forEach(function (change) {
          if (change.type !== 'added') return;
          var data = change.doc.data();
          if (!data) return;
          if (data.originId === originId) return; // skip own writes
          if (!data.bytes) return;
          try {
            Y.applyUpdate(yDoc, b64ToBytes(data.bytes), 'remote');
          } catch (err) {
            console.warn('[paper-yjs] failed to apply remote update', change.doc.id, err.message);
          }
        });
      },
      error: function (err) {
        console.warn('[paper-yjs] update subscription error:', err.message);
      },
    });

    /* 4. Outgoing: throttle local updates, merge, write as one doc */
    var pendingUpdates = [];
    var flushTimer = null;
    function flushPending() {
      flushTimer = null;
      if (!pendingUpdates.length) return;
      var merged = Y.mergeUpdates(pendingUpdates);
      pendingUpdates = [];
      var seq = makeSeq(clientId4);
      updatesRef.doc(seq).set({
        bytes: bytesToB64(merged),
        seq: seq,
        originId: originId,
        authorUid: user.uid,
        ts: firebase.firestore.FieldValue.serverTimestamp(),
      }).catch(function (err) {
        console.warn('[paper-yjs] failed to write update', seq, err.message);
      });
    }
    function onLocalUpdate(update, origin) {
      if (origin === 'remote') return;
      pendingUpdates.push(update);
      if (flushTimer) return;
      flushTimer = setTimeout(flushPending, THROTTLE_MS);
    }
    yDoc.on('update', onLocalUpdate);

    /* 5. Presence — heartbeat + listener.
     *
     * Phase F dedup: when the same user opens the same paper in two tabs of
     * the same browser, both used to write presence heartbeats every 10s
     * and both used to delete the presence doc on tab close. We use the
     * Web Locks API to elect ONE tab as leader per (paperId, uid). Only the
     * leader writes the heartbeat. When the leader closes, the lock auto-
     * releases, and another waiting tab promotes itself.
     *
     * Falls back to "every tab heartbeats" on browsers without
     * navigator.locks (pre-Safari 15.4). Yjs update listeners are NOT
     * deduped — each tab needs its own Y.Doc state, so the listener work
     * is not actually redundant across tabs.
     */
    var presenceRef = db.collection('papers').doc(paperId).collection('presence').doc(user.uid);
    var presenceState = { focusBlockId: null };
    var presenceListeners = [];
    var presenceCache = [];
    var isPresenceLeader = false;
    var presenceTimer = null;
    var presenceLockReleaser = null;

    async function writePresence() {
      // Only the leader tab writes — followers rely on the leader's heartbeat
      // appearing in the presence subcollection (which they observe via
      // their own onSnapshot listener regardless of leadership).
      if (!isPresenceLeader) return;
      try {
        await presenceRef.set({
          uid: user.uid,
          name: displayName,
          color: colorForUid(user.uid),
          lastSeen: firebase.firestore.FieldValue.serverTimestamp(),
          focusBlockId: presenceState.focusBlockId || null,
        });
      } catch (err) {
        // Permission denied or transient — log and continue.
        if (presenceState._loggedError !== err.message) {
          console.warn('[paper-yjs] presence write failed:', err.message);
          presenceState._loggedError = err.message;
        }
      }
    }

    function startHeartbeatLoop() {
      isPresenceLeader = true;
      writePresence();
      if (!presenceTimer) presenceTimer = setInterval(writePresence, PRESENCE_HEARTBEAT_MS);
    }

    var lockName = 'rm-paper-presence-' + paperId + '-' + user.uid;
    if (navigator.locks && typeof navigator.locks.request === 'function') {
      // Acquire-and-hold — the lock callback is held by a Promise that we
      // resolve only on disconnect. While held, this tab is leader. If the
      // tab closes, the browser releases the lock and a sibling tab's
      // pending request resolves, promoting that tab.
      navigator.locks.request(lockName, function (lock) {
        return new Promise(function (resolve) {
          presenceLockReleaser = resolve;
          startHeartbeatLoop();
        });
      }).catch(function (err) {
        // Lock request itself failed — fall back to unilateral leadership.
        console.warn('[paper-yjs] presence lock failed; running heartbeat unilaterally:', err.message);
        startHeartbeatLoop();
      });
    } else {
      // Older browser without Web Locks — every tab heartbeats. Same as
      // pre-Phase-F behavior; correctness preserved at the cost of
      // duplicate heartbeats when the user opens the same paper twice.
      startHeartbeatLoop();
    }

    var presenceUnsub = db.collection('papers').doc(paperId).collection('presence')
      .onSnapshot({
        next: function (snap) {
          var now = Date.now();
          var arr = [];
          snap.docs.forEach(function (d) {
            var data = d.data();
            if (!data) return;
            var ts = data.lastSeen && data.lastSeen.toDate ? data.lastSeen.toDate().getTime() : 0;
            if (ts && (now - ts) > PRESENCE_STALE_MS) return; // stale
            arr.push({
              uid: data.uid || d.id,
              name: data.name || '',
              color: data.color || colorForUid(data.uid || d.id),
              lastSeen: ts,
              focusBlockId: data.focusBlockId || null,
              isSelf: (data.uid || d.id) === user.uid,
            });
          });
          presenceCache = arr;
          presenceListeners.forEach(function (cb) { try { cb(arr); } catch (e) { console.error(e); } });
        },
        error: function (err) {
          console.warn('[paper-yjs] presence subscribe error:', err.message);
        },
      });

    function setFocusBlock(blockId) {
      if (presenceState.focusBlockId === blockId) return;
      presenceState.focusBlockId = blockId || null;
      writePresence(); // immediate flush for snappy UI
    }

    function onPresence(cb) {
      presenceListeners.push(cb);
      // Fire immediately with current state so subscribers don't wait.
      try { cb(presenceCache); } catch (e) { console.error(e); }
      return function () {
        presenceListeners = presenceListeners.filter(function (x) { return x !== cb; });
      };
    }

    function getPresence() { return presenceCache.slice(); }

    /* 6. Disconnect */
    function disconnect() {
      yDoc.off('update', onLocalUpdate);
      if (flushTimer) { clearTimeout(flushTimer); flushPending(); }
      try { unsubUpdates(); } catch (e) {}
      try { presenceUnsub(); } catch (e) {}
      if (presenceTimer) { clearInterval(presenceTimer); presenceTimer = null; }
      // Only the leader should delete the presence doc — a follower tab
      // closing while a sibling leader is still alive would erase the
      // leader's freshly-stamped doc. Releasing the lock will promote a
      // sibling, which will rewrite the doc on its next heartbeat.
      if (isPresenceLeader) {
        presenceRef.delete().catch(function () {});
      }
      isPresenceLeader = false;
      // Release the lock so a sibling tab can take over.
      if (presenceLockReleaser) { try { presenceLockReleaser(); } catch (e) {} presenceLockReleaser = null; }
    }

    // Best-effort flush + presence cleanup on tab close.
    var beforeUnload = function () {
      if (flushTimer) { clearTimeout(flushTimer); flushPending(); }
      if (isPresenceLeader) {
        // Cannot reliably await the delete on unload, so fire-and-forget.
        try { presenceRef.delete(); } catch (e) {}
      }
      if (presenceLockReleaser) { try { presenceLockReleaser(); } catch (e) {} presenceLockReleaser = null; }
    };
    window.addEventListener('beforeunload', beforeUnload);

    return {
      Y: Y,
      yDoc: yDoc,
      yClientId: clientId4,
      originId: originId,
      ready: Promise.resolve(),
      getPresence: getPresence,
      onPresence: onPresence,
      setFocusBlock: setFocusBlock,
      disconnect: function () {
        window.removeEventListener('beforeunload', beforeUnload);
        disconnect();
      },
    };
  }

  /* ── Public surface ── */
  window.PaperYjs = {
    ensureYjs: ensureYjs,
    connect: connect,
    colorForUid: colorForUid,
    /* Exposed for tests / Phase D snapshot UI */
    bytesToB64: bytesToB64,
    b64ToBytes: b64ToBytes,
  };
})();
