/* protocol-yjs.js — Yjs CRDT provider for the Protocols Builder.
 *
 * V3.113 — clone of paper-yjs.js with the Firestore collection swapped
 * from `papers/{id}/...` to `protocols/{id}/...`. (Tech debt: a follow-on
 * cleanup phase will parameterize paper-yjs.js so we can drop this file.)
 *
 * Persistence model in Firestore:
 *   protocols/{protocolId}/yjs_snapshot/state          — { stateBase64, seq, savedAt, savedBy }
 *   protocols/{protocolId}/yjs_updates/{seq}           — { bytes (b64), seq, originId, authorUid, ts }
 *   protocols/{protocolId}/presence/{uid}              — { name, color, lastSeen, focusBlockId }
 *
 * Same throttle/merge/heartbeat behavior as paper-yjs.
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
    return pad(Date.now(), 16) + '-' + clientId4 + '-' + shortNonce();
  }

  function colorForUid(uid) {
    var s = String(uid || 'anon');
    var h = 0;
    for (var i = 0; i < s.length; i++) h = (h * 31 + s.charCodeAt(i)) | 0;
    var hue = Math.abs(h) % 360;
    return 'hsl(' + hue + ' 70% 45%)';
  }

  var COMPACT_THRESHOLD = 200;
  var THROTTLE_MS = 200;
  var PRESENCE_HEARTBEAT_MS = 10000;
  var PRESENCE_STALE_MS = 30000;

  async function connect(protocolId, opts) {
    opts = opts || {};
    var Y = await ensureYjs();
    if (typeof firebridge === 'undefined' || !firebridge.getUser()) {
      throw new Error('protocol-yjs: firebridge user required');
    }

    var user = firebridge.getUser();
    var profile = firebridge.getProfile();
    var displayName = (profile && profile.name) || (user && (user.displayName || user.email)) || user.uid;

    var yDoc = new Y.Doc();
    var clientId4 = pad((Math.random() * 0xffff) | 0, 4).slice(-4);
    var originId = clientId4 + '-' + shortNonce();

    var db = firebridge.db();
    var protocolRef = db.collection('protocols').doc(protocolId);
    var snapshotRef = protocolRef.collection('yjs_snapshot').doc('state');
    var updatesRef  = protocolRef.collection('yjs_updates');

    var snapDoc = null;
    try {
      var s = await snapshotRef.get();
      snapDoc = s.exists ? s.data() : null;
    } catch (err) {
      console.warn('[protocol-yjs] snapshot read failed:', err.message);
    }
    var baseSeq = '';
    if (snapDoc && snapDoc.stateBase64) {
      Y.applyUpdate(yDoc, b64ToBytes(snapDoc.stateBase64), 'remote');
      baseSeq = snapDoc.seq || '';
    }

    var catchupQuery = baseSeq
      ? updatesRef.where('seq', '>', baseSeq).orderBy('seq')
      : updatesRef.orderBy('seq');
    var catchupSnap;
    try {
      catchupSnap = await catchupQuery.get();
    } catch (err) {
      if (err && err.code === 'permission-denied') {
        var e = new Error('Firestore rules block reads on protocols/' + protocolId +
          '/yjs_updates. Edit firestore.rules in McGheeLabWebsite and run ' +
          '`firebase deploy --only firestore:rules`.');
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
          console.warn('[protocol-yjs] failed to apply update', d.id, err.message);
        }
      }
    });
    if (catchupSnap.size > COMPACT_THRESHOLD) {
      console.warn('[protocol-yjs] ' + catchupSnap.size + ' updates loaded — compaction recommended.');
    }

    var subscribeStartSeq = lastSeq || makeSeq(clientId4);
    var subQuery = updatesRef.where('seq', '>', subscribeStartSeq).orderBy('seq');
    var unsubUpdates = subQuery.onSnapshot({
      next: function (snap) {
        snap.docChanges().forEach(function (change) {
          if (change.type !== 'added') return;
          var data = change.doc.data();
          if (!data) return;
          if (data.originId === originId) return;
          if (!data.bytes) return;
          try {
            Y.applyUpdate(yDoc, b64ToBytes(data.bytes), 'remote');
          } catch (err) {
            console.warn('[protocol-yjs] failed to apply remote update', change.doc.id, err.message);
          }
        });
      },
      error: function (err) {
        console.warn('[protocol-yjs] update subscription error:', err.message);
      },
    });

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
        console.warn('[protocol-yjs] failed to write update', seq, err.message);
      });
    }
    function onLocalUpdate(update, origin) {
      if (origin === 'remote') return;
      pendingUpdates.push(update);
      if (flushTimer) return;
      flushTimer = setTimeout(flushPending, THROTTLE_MS);
    }
    yDoc.on('update', onLocalUpdate);

    var presenceRef = db.collection('protocols').doc(protocolId).collection('presence').doc(user.uid);
    var presenceState = { focusBlockId: null };
    var presenceListeners = [];
    var presenceCache = [];
    var isPresenceLeader = false;
    var presenceTimer = null;
    var presenceLockReleaser = null;

    async function writePresence() {
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
        if (presenceState._loggedError !== err.message) {
          console.warn('[protocol-yjs] presence write failed:', err.message);
          presenceState._loggedError = err.message;
        }
      }
    }

    function startHeartbeatLoop() {
      isPresenceLeader = true;
      writePresence();
      if (!presenceTimer) presenceTimer = setInterval(writePresence, PRESENCE_HEARTBEAT_MS);
    }

    var lockName = 'rm-protocol-presence-' + protocolId + '-' + user.uid;
    if (navigator.locks && typeof navigator.locks.request === 'function') {
      navigator.locks.request(lockName, function (lock) {
        return new Promise(function (resolve) {
          presenceLockReleaser = resolve;
          startHeartbeatLoop();
        });
      }).catch(function (err) {
        console.warn('[protocol-yjs] presence lock failed; running heartbeat unilaterally:', err.message);
        startHeartbeatLoop();
      });
    } else {
      startHeartbeatLoop();
    }

    var presenceUnsub = db.collection('protocols').doc(protocolId).collection('presence')
      .onSnapshot({
        next: function (snap) {
          var now = Date.now();
          var arr = [];
          snap.docs.forEach(function (d) {
            var data = d.data();
            if (!data) return;
            var ts = data.lastSeen && data.lastSeen.toDate ? data.lastSeen.toDate().getTime() : 0;
            if (ts && (now - ts) > PRESENCE_STALE_MS) return;
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
          console.warn('[protocol-yjs] presence subscribe error:', err.message);
        },
      });

    function setFocusBlock(blockId) {
      if (presenceState.focusBlockId === blockId) return;
      presenceState.focusBlockId = blockId || null;
      writePresence();
    }
    function onPresence(cb) {
      presenceListeners.push(cb);
      try { cb(presenceCache); } catch (e) { console.error(e); }
      return function () {
        presenceListeners = presenceListeners.filter(function (x) { return x !== cb; });
      };
    }
    function getPresence() { return presenceCache.slice(); }

    function disconnect() {
      yDoc.off('update', onLocalUpdate);
      if (flushTimer) { clearTimeout(flushTimer); flushPending(); }
      try { unsubUpdates(); } catch (e) {}
      try { presenceUnsub(); } catch (e) {}
      if (presenceTimer) { clearInterval(presenceTimer); presenceTimer = null; }
      if (isPresenceLeader) {
        presenceRef.delete().catch(function () {});
      }
      isPresenceLeader = false;
      if (presenceLockReleaser) { try { presenceLockReleaser(); } catch (e) {} presenceLockReleaser = null; }
    }

    var beforeUnload = function () {
      if (flushTimer) { clearTimeout(flushTimer); flushPending(); }
      if (isPresenceLeader) {
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

  window.ProtocolYjs = {
    ensureYjs: ensureYjs,
    connect: connect,
    colorForUid: colorForUid,
    bytesToB64: bytesToB64,
    b64ToBytes: b64ToBytes,
  };
})();
