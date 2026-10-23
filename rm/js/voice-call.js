/* ================================================================
   voice-call.js — Slack-style huddle: group voice call in a chat
   channel. V3.525 MVP → V3.584 answer surface → V3.587 TURN →
   V3.593 security + correctness hardening.
   ================================================================
   Plans: CodeLog/ClaudesPlan/V3.525_voice_call_mvp.md,
          V3.584_voice_call_answer_surface.md,
          V3.587_voice_call_turn_relay.md,
          V3.593_voice_call_hardening.md

   - One live call per chat channel, keyed by the chatChannels doc id:
       voiceCalls/{channelId}                      call doc
       voiceCalls/{channelId}/participants/{uid}   in-call presence
                                                   (lastSeen heartbeat)
       voiceCalls/{channelId}/signals/{autoId}     addressed WebRTC
                                                   signaling (offer/answer/ICE)
   - Media is a WebRTC MESH: one RTCPeerConnection per other peer.
     Sized for 3-6 people; the per-candidate Firestore write volume is
     the practical ceiling, not the audio.
   - Signaling transport is Firestore onSnapshot — no vendor, no server.
   - Media path uses STUN + a TURN relay. STUN alone could not connect on
     university WiFi (client isolation + symmetric NAT), which is what
     V3.525 shipped with. TURN comes from voiceCallConfig/turn
     (admin-editable) or a free public fallback.
   - Glare avoidance: for each pair the peer with the lexicographically
     SMALLER uid is the initiator. Deterministic, no rollback dance.

   ── V3.593 invariants (each of these was a real defect) ──
   1. NEVER answer an offer from a uid that is not in the call's
      participant roster. createPeer attaches the microphone, so an
      unsolicited offer used to be a silent audio tap. Off-roster offers
      are buffered and replayed only if that uid legitimately appears.
   2. `_joining` is set BEFORE the first await and cleared in a finally,
      with a generation token — otherwise a second Join click while the
      first was awaiting duplicated the mic stream, the heartbeat, the
      level timer and BOTH Firestore listeners, permanently.
   3. Listeners are channel-scoped and every entry point re-checks
      `_channelId`, so a snapshot that lands after leave() can't
      resurrect a peer with a null stream (which left a zombie in _peers
      that silently muted that person in the NEXT call).
   4. Retry budget lives OUTSIDE the peer entry (teardown destroyed it),
      resets on a successful connect, and an exhausted peer is torn down
      AND recorded in _failedPeers so the roster loop won't rebuild it
      forever.
   5. Signals are processed once (`_handledSignals`) and serialized
      (`_sigChain`) — snapshots deliver the FULL result set, so an
      in-flight await meant the same offer got applied twice.
   6. A ghost call doc (every crashed tab leaves one) is purged and
      recreated on the next join, so the FCM push fires and the caller
      name / ring state are correct.

   Public API (used by chat.js):
     VOICE_CALL.open(channelId, { channelName, memberUids })
     VOICE_CALL.leave()
     VOICE_CALL.decline(channelId)
     VOICE_CALL.getIncomingCalls()        answerable calls
     VOICE_CALL.getActiveCall(channelId)  call doc | null
     VOICE_CALL.currentChannelId()        channel I'm in | null
     VOICE_CALL.testIce()                 console TURN diagnostic

   Emits window CustomEvent 'voice-call-change' when the set of active
   calls or my own in-call/declined state changes.
   ================================================================ */

(function () {
  'use strict';

  /* ── ICE configuration ──
   * Resolution order:
   *   1. voiceCallConfig/turn → { iceServers: [...] } (admin-editable in
   *      Firestore; paste credentials from Metered / Cloudflare / Twilio,
   *      takes effect with no redeploy)
   *   2. FALLBACK_TURN below — Open Relay Project's free public TURN (no
   *      signup; rate-limited and best-effort, so a stopgap only). Both
   *      published hostnames are listed because the static-credential
   *      endpoint has been documented under each; ICE simply tries all.
   *      Ports 443/TCP + turns: matter because campus firewalls routinely
   *      block UDP and the default 3478. */
  const STUN_SERVERS = [
    { urls: 'stun:stun.l.google.com:19302' },
    { urls: 'stun:stun1.l.google.com:19302' },
  ];
  const OPEN_RELAY_CRED = { username: 'openrelayproject', credential: 'openrelayproject' };
  const FALLBACK_TURN = [
    'turn:openrelay.metered.ca:80',
    'turn:openrelay.metered.ca:443',
    'turns:openrelay.metered.ca:443',
    'turn:staticauth.openrelay.metered.ca:80',
    'turn:staticauth.openrelay.metered.ca:443',
    'turns:staticauth.openrelay.metered.ca:443',
  ].map((urls) => Object.assign({ urls }, OPEN_RELAY_CRED));

  let _iceServers = STUN_SERVERS.concat(FALLBACK_TURN);
  let _iceConfigLoaded = null;      // cached promise — resolve once per page

  const MAX_PEER_RETRIES = 1;       // ICE-restart rebuilds per peer
  const HEARTBEAT_MS = 5000;        // own lastSeen refresh
  const STALE_MS = 25000;           // participant considered gone
  const GHOST_MS = 60000;           // call doc with no fresh peer => ghost
  const LEVEL_POLL_MS = 200;        // speaking-dot analyser poll
  const SPEAKING_RMS = 0.04;        // RMS threshold for "speaking"

  /* ── state ── */
  let _uid = null;
  let _name = '';
  let _sessionId = makeSessionId();  // per PAGE, not per user (see multi-tab)
  let _channelId = null;             // channel of the call I'm currently in
  let _channelName = '';
  let _localStream = null;
  let _muted = false;
  let _joining = false;
  let _gen = 0;                      // open()/leave() generation token

  let _peers = new Map();            // uid -> {pc, audioEl, pending[], analyser, src}
  let _peerRetries = new Map();      // uid -> retries used (survives teardown)
  let _failedPeers = new Set();      // uid -> gave up; don't auto-rebuild
  let _orphanCandidates = new Map(); // uid -> [candidate] (arrived pre-peer)
  let _pendingOffers = new Map();    // uid -> offer awaiting roster proof
  let _handledSignals = new Set();   // signal doc ids already processed
  let _sigChain = Promise.resolve(); // serializes onSignals invocations

  let _participants = [];            // fresh participant docs (incl. self)
  let _unsubParticipants = null;
  let _unsubSignals = null;
  let _heartbeat = null;
  let _levelTimer = null;
  let _audioCtx = null;
  let _activeCalls = new Map();      // channelId -> call doc
  let _unsubCalls = null;

  function makeSessionId() {
    try {
      if (window.crypto && crypto.randomUUID) return crypto.randomUUID();
    } catch (e) { /* fall through */ }
    return 's' + Date.now() + Math.random().toString(36).slice(2, 10);
  }

  function db() { return firebridge.db(); }
  function callRef(chId) { return db().collection('voiceCalls').doc(chId); }
  function stamp() { return firebase.firestore.FieldValue.serverTimestamp(); }

  function toast(level, msg, opts) {
    if (window.TOAST && TOAST[level]) TOAST[level](msg, opts);
    else console[level === 'error' ? 'error' : 'log']('[voice-call]', msg);
  }

  function millis(ts) {
    return ts && ts.toMillis ? ts.toMillis() : 0;
  }

  function isFresh(p) {
    const t = millis(p && p.lastSeen);
    // A just-written serverTimestamp reads back null on the WRITER's own
    // latency-compensated snapshot — treat as fresh. Other clients always
    // see a resolved timestamp.
    if (!t) return true;
    return Date.now() - t < STALE_MS;
  }

  /* Raw Firestore listener — deliberately NOT firebridge.onSnapshot.
     firebridge pops a page-level "your access may have changed" banner on
     permission-denied, which would fire for every lab member if the
     voiceCalls rules aren't deployed yet. A call feature losing
     visibility should degrade quietly to "no calls". */
  function listen(query, cb, label) {
    return query.onSnapshot({
      next: (snap) => cb(snap.docs.map((d) => Object.assign({ id: d.id }, d.data())), snap),
      error: (err) => console.warn('[voice-call] listener error (' + label + '):',
        (err && err.code) || err),
    });
  }

  function emitChange() {
    window.dispatchEvent(new CustomEvent('voice-call-change'));
  }

  /* Load admin-configured ICE servers once. Falls back to the built-in
     list on ANY error (missing doc, permission, offline) — a call must
     never fail to start because config lookup failed. */
  function loadIceConfig() {
    if (_iceConfigLoaded) return _iceConfigLoaded;
    _iceConfigLoaded = Promise.resolve()
      .then(() => db().collection('voiceCallConfig').doc('turn').get())
      .then((snap) => {
        const cfg = snap.exists ? (snap.data() || {}) : {};
        if (Array.isArray(cfg.iceServers) && cfg.iceServers.length) {
          // Admin list REPLACES the fallback TURN but keeps STUN (a direct
          // connection is still preferable when the network allows it).
          _iceServers = STUN_SERVERS.concat(cfg.iceServers);
          console.log('[voice-call] using admin-configured TURN (%d entries)',
            cfg.iceServers.length);
        }
      })
      .catch((e) => console.warn('[voice-call] ICE config lookup failed, using defaults:',
        e && e.message));
    return _iceConfigLoaded;
  }

  /* ═══════════════════════════════════════════════════════════
     Incoming calls + decline
     ═══════════════════════════════════════════════════════════ */
  const DISMISSED_LS_KEY = 'vcDismissed';   // sessionStorage: {channelId: startMillis}

  function loadDismissed() {
    try { return JSON.parse(sessionStorage.getItem(DISMISSED_LS_KEY)) || {}; }
    catch (e) { return {}; }
  }

  /* Key the dismissal to the call INSTANCE so a later call in the same
     channel rings again. Never store 0: a falsy key used to act as a
     match-anything wildcard, which silently muted that channel's ring for
     the rest of the session whenever the call doc wasn't loaded yet. */
  function dismissLocal(channelId, startMillis) {
    const map = loadDismissed();
    map[channelId] = startMillis || Date.now();
    try { sessionStorage.setItem(DISMISSED_LS_KEY, JSON.stringify(map)); }
    catch (e) { /* private mode — dismissal just won't survive reload */ }
  }

  function isDismissed(channelId, call) {
    const stored = loadDismissed()[channelId];
    if (stored === undefined) return false;
    const started = millis(call && call.startedAt);
    if (!started) return true;             // unknown instance: stay dismissed
    return stored >= started;              // dismissed this instance (or later)
  }

  /** Active calls I could answer: excludes the call I'm in, calls I
   *  started, calls I declined (server-recorded), and calls I dismissed
   *  this session. Channel-membership filtering is the CALLER's job
   *  (chat.js knows members/subscribers; this module doesn't). */
  function getIncomingCalls() {
    const out = [];
    if (!_uid) return out;
    _activeCalls.forEach((call, chId) => {
      if (chId === _channelId) return;
      if (call.startedBy === _uid) return;
      if ((call.declinedUids || []).includes(_uid)) return;
      if (isDismissed(chId, call)) return;
      out.push(call);
    });
    return out;
  }

  /** Decline = hide the banner for this call instance (session-local)
   *  + record it on the call doc so my other tabs/devices stop ringing. */
  function decline(channelId) {
    const call = _activeCalls.get(channelId);
    dismissLocal(channelId, millis(call && call.startedAt));
    if (_uid) {
      callRef(channelId).set({
        declinedUids: firebase.firestore.FieldValue.arrayUnion(_uid),
      }, { merge: true }).catch((e) => console.warn('[voice-call] decline:', e));
    }
    emitChange();
  }

  /* ═══════════════════════════════════════════════════════════
     Active-call watcher (runs on boot for everyone on the page)
     ═══════════════════════════════════════════════════════════ */
  function watchActiveCalls() {
    // Scoped by memberUids: the rules' `list` clause requires it (a query
    // whose rule needs a get() of another doc is rejected outright), and it
    // stops the client subscribing to every call in the lab.
    _unsubCalls = listen(
      db().collection('voiceCalls').where('memberUids', 'array-contains', _uid),
      (docs) => {
        _activeCalls = new Map(
          docs.filter((d) => d.active === true).map((d) => [d.id, d]));
        emitChange();
      },
      'activeCalls'
    );
  }

  /* ═══════════════════════════════════════════════════════════
     Join / start
     ═══════════════════════════════════════════════════════════ */
  async function open(channelId, opts) {
    opts = opts || {};
    if (!_uid) { toast('error', 'Sign in to use voice calls.'); return; }
    if (!navigator.mediaDevices || !navigator.mediaDevices.getUserMedia) {
      // Secure-context / webview capability check — distinguishes "this
      // environment can't do calls" from a user-denied mic (matters in the
      // Capacitor app, where a missing Info.plist key or an old webview
      // surfaces here rather than as a permission prompt).
      toast('error', 'Voice calls aren\'t available in this browser or app view.');
      return;
    }
    if (_joining) return;
    if (_channelId === channelId) { focusPanel(); return; }

    // Set BEFORE any await, cleared in the finally. The generation token
    // aborts this attempt if a newer open()/leave() supersedes it mid-await.
    _joining = true;
    const gen = ++_gen;
    const superseded = () => gen !== _gen;

    try {
      if (_channelId) await leave({ keepGen: true });
      if (superseded()) return;

      await loadIceConfig();
      if (superseded()) return;

      const memberUids = Array.isArray(opts.memberUids) && opts.memberUids.length
        ? opts.memberUids.slice() : [_uid];
      if (memberUids.indexOf(_uid) === -1) memberUids.push(_uid);

      // Refuse a second concurrent session for the same uid. Presence and
      // signaling are addressed by uid, so two tabs in one call fight over
      // the participant doc and cross-wire each other's SDP/ICE. Blocking
      // it is far better than the resulting one-way-audio confusion.
      const existingSelf = await callRef(channelId).collection('participants')
        .doc(_uid).get().catch(() => null);
      if (superseded()) return;
      if (existingSelf && existingSelf.exists) {
        const d = existingSelf.data() || {};
        if (isFresh(d) && d.sessionId && d.sessionId !== _sessionId) {
          toast('error', 'You\'re already in this call in another tab or on another device.');
          return;
        }
      }

      // 1) mic — before any Firestore write, so a denied mic never leaves a
      //    ghost call doc behind.
      const stream = await navigator.mediaDevices.getUserMedia({ audio: true });
      if (superseded()) { stream.getTracks().forEach((t) => t.stop()); return; }
      _localStream = stream;

      _channelId = channelId;
      _channelName = opts.channelName || channelId;
      _muted = false;

      // 2) call doc. A crashed tab leaves an `active` doc with no live
      //    participants; reviving that doc in place would keep the stale
      //    caller name / startedAt / declinedUids AND skip onCreate, so no
      //    FCM push would ever fire again for that channel. Purge and
      //    recreate instead.
      await ensureCallDoc(channelId, memberUids);
      if (superseded()) return;

      // 3) announce self + heartbeat
      await writeParticipant(true);
      _heartbeat = setInterval(() => writeParticipant(false), HEARTBEAT_MS);

      // 4) listeners — channel-scoped so a late snapshot after leave() is
      //    ignored rather than resurrecting a peer with a null stream.
      _unsubParticipants = listen(
        callRef(channelId).collection('participants'),
        (docs) => onParticipants(channelId, docs),
        'participants'
      );
      _unsubSignals = listen(
        callRef(channelId).collection('signals').where('to', '==', _uid),
        (docs) => queueSignals(channelId, docs),
        'signals'
      );

      startLevelMeter();
      renderPanel();
      window.addEventListener('pagehide', leaveOnUnload);
      emitChange();  // joining an EXISTING call doesn't touch the call doc —
                     // tell the ring banner to hide without a snapshot event
    } catch (err) {
      console.error('[voice-call] join failed:', err);
      toast('error', 'Could not join the call.', { detail: err && err.message });
      await leave({ keepGen: true });
    } finally {
      if (!superseded()) _joining = false;
    }
  }

  /* Create the call doc, or revive it if it's a ghost from a crashed tab.
     Returns nothing; throws on a genuine permission failure. */
  async function ensureCallDoc(channelId, memberUids) {
    const snap = await callRef(channelId).get().catch(() => null);
    const existing = snap && snap.exists ? (snap.data() || {}) : null;
    let fresh = !existing || existing.active !== true;

    if (existing && existing.active === true) {
      const parts = await callRef(channelId).collection('participants').get()
        .catch(() => null);
      const live = parts ? parts.docs.map((d) => d.data()).filter(isFresh) : [];
      const age = Date.now() - millis(existing.startedAt);
      if (!live.length && age > GHOST_MS) {
        await purgeCall(channelId);
        fresh = true;
      }
    }

    if (fresh) {
      await callRef(channelId).set({
        startedBy: _uid,
        startedByName: _name,
        channelName: _channelName,
        memberUids: memberUids,
        declinedUids: [],
        startedAt: stamp(),
        active: true,
      });
    } else {
      // Joining someone else's call: only widen the audience so the rules'
      // memberUids-scoped `list` query can see it.
      await callRef(channelId).set({
        memberUids: firebase.firestore.FieldValue.arrayUnion(_uid),
      }, { merge: true });
    }
  }

  /* Best-effort removal of a dead call and its leftovers. Stale
     participants/signals are deletable by any lab member per the rules'
     age clauses; anything still live is left alone (the delete just fails
     and is ignored). */
  async function purgeCall(channelId) {
    try {
      const [parts, sigs] = await Promise.all([
        callRef(channelId).collection('participants').get(),
        callRef(channelId).collection('signals').get(),
      ]);
      await Promise.all(
        parts.docs.concat(sigs.docs).map((d) => d.ref.delete().catch(() => {}))
      );
      await callRef(channelId).delete();
    } catch (e) {
      console.warn('[voice-call] purge ghost call:', e && e.message);
    }
  }

  function writeParticipant(initial) {
    if (!_channelId || !_uid) return Promise.resolve();
    const data = {
      uid: _uid,
      name: _name,
      muted: _muted,
      sessionId: _sessionId,
      lastSeen: stamp(),
    };
    if (initial) data.joinedAt = stamp();   // don't re-stamp every heartbeat
    return callRef(_channelId).collection('participants').doc(_uid)
      .set(data, { merge: true })
      .catch((e) => console.warn('[voice-call] heartbeat:', e && e.message));
  }

  /* ═══════════════════════════════════════════════════════════
     Mesh maintenance — roster snapshot drives peer connections
     ═══════════════════════════════════════════════════════════ */
  function onParticipants(chId, docs) {
    if (chId !== _channelId) return;        // stale listener after leave()
    _participants = docs.filter(isFresh);
    const liveOthers = new Set(
      _participants.map((p) => p.uid).filter((u) => u !== _uid));

    // Forget the retry budget for anyone who actually left, so a rejoin
    // gets a clean slate instead of inheriting an exhausted one.
    Array.from(_peerRetries.keys()).forEach((uid) => {
      if (!liveOthers.has(uid)) { _peerRetries.delete(uid); _failedPeers.delete(uid); }
    });
    _failedPeers.forEach((uid) => { if (!liveOthers.has(uid)) _failedPeers.delete(uid); });

    // Connect to newcomers (never to a peer we've given up on — that would
    // rebuild-loop forever against the roster heartbeat).
    liveOthers.forEach((uid) => {
      if (!_peers.has(uid) && !_failedPeers.has(uid)) createPeer(uid);
    });

    // Replay an offer that legitimately arrived before its sender showed up
    // in the roster (see handleSignal's authorization check).
    liveOthers.forEach((uid) => {
      if (!_pendingOffers.has(uid)) return;
      const payload = _pendingOffers.get(uid);
      _pendingOffers.delete(uid);
      applyOffer(uid, payload)
        .catch((e) => console.error('[voice-call] replayed offer:', e));
    });
    Array.from(_pendingOffers.keys()).forEach((uid) => {
      if (!liveOthers.has(uid)) _pendingOffers.delete(uid);   // never arrived
    });

    // Tear down leavers / stale peers.
    Array.from(_peers.keys()).forEach((uid) => {
      if (!liveOthers.has(uid)) teardownPeer(uid);
    });

    renderPanel();
  }

  function createPeer(peerUid) {
    // Preconditions FIRST — a snapshot landing after leave() used to insert
    // an entry and then throw on the null stream, leaving a zombie that
    // blocked that peer from ever connecting again.
    if (!_channelId || !_localStream || !_uid) return;
    if (_peers.has(peerUid)) return;

    const initiator = _uid < peerUid;  // glare avoidance: smaller uid offers
    const pc = new RTCPeerConnection({ iceServers: _iceServers });
    const entry = { pc, audioEl: null, pending: [], analyser: null, src: null, sawRelay: false };
    _peers.set(peerUid, entry);

    _localStream.getTracks().forEach((t) => pc.addTrack(t, _localStream));

    pc.onicecandidate = (e) => {
      if (!e.candidate) return;
      // Diagnostic: did TURN actually give us a relay candidate? Without
      // one, a symmetric-NAT peer can never connect.
      if (e.candidate.type === 'relay') entry.sawRelay = true;
      sendSignal(peerUid, 'candidate', e.candidate.toJSON());
    };
    pc.ontrack = (e) => {
      if (_peers.get(peerUid) !== entry) return;   // superseded pc
      const stream = e.streams[0];
      if (!entry.audioEl) {
        entry.audioEl = document.createElement('audio');
        entry.audioEl.autoplay = true;
        entry.audioEl.dataset.vcUid = peerUid;
        audioSink().appendChild(entry.audioEl);
      }
      entry.audioEl.srcObject = stream;
      attachAnalyser(entry, stream);
    };
    pc.onconnectionstatechange = () => {
      if (_peers.get(peerUid) !== entry) return;   // superseded pc
      if (pc.connectionState === 'connected') {
        // A mid-call hiccup shouldn't permanently spend the budget.
        _peerRetries.delete(peerUid);
        _failedPeers.delete(peerUid);
      } else if (pc.connectionState === 'failed') {
        onPeerFailed(peerUid, entry);
      }
      renderPanel();
    };

    // Candidates that raced ahead of this peer's creation.
    const orphans = _orphanCandidates.get(peerUid);
    if (orphans && orphans.length) {
      entry.pending.push.apply(entry.pending, orphans);
      _orphanCandidates.delete(peerUid);
    }

    if (initiator) {
      pc.createOffer()
        .then((offer) => pc.setLocalDescription(offer))
        .then(() => {
          if (_peers.get(peerUid) !== entry) return;
          sendSignal(peerUid, 'offer',
            { type: pc.localDescription.type, sdp: pc.localDescription.sdp });
        })
        .catch((e) => console.error('[voice-call] offer:', e));
    }
  }

  function teardownPeer(uid) {
    const entry = _peers.get(uid);
    if (!entry) return;
    _peers.delete(uid);
    try {
      entry.pc.onicecandidate = null;
      entry.pc.ontrack = null;
      entry.pc.onconnectionstatechange = null;
      entry.pc.close();
    } catch (e) { /* already closed */ }
    try { if (entry.src) entry.src.disconnect(); } catch (e) {}
    try { if (entry.analyser) entry.analyser.disconnect(); } catch (e) {}
    if (entry.audioEl) {
      try { entry.audioEl.pause(); entry.audioEl.srcObject = null; } catch (e) {}
      entry.audioEl.remove();
    }
  }

  /* ICE failed for one peer. Rebuild once (fresh candidate gathering often
     succeeds where the first attempt raced a slow TURN allocation); if the
     budget is spent, tear the dead pc down and record the give-up so the
     roster loop doesn't rebuild it on every heartbeat. */
  function onPeerFailed(peerUid, entry) {
    if (_peers.get(peerUid) !== entry) return;   // superseded pc
    const used = _peerRetries.get(peerUid) || 0;
    if (used < MAX_PEER_RETRIES) {
      _peerRetries.set(peerUid, used + 1);
      console.warn('[voice-call] peer %s failed — rebuilding (attempt %d)', peerUid, used + 1);
      teardownPeer(peerUid);
      // Only the initiator re-offers; the answerer rebuilds when that offer
      // arrives (applyOffer replaces a dead pc).
      if (_uid < peerUid) createPeer(peerUid);
      return;
    }
    const relayWorked = entry.sawRelay;
    _failedPeers.add(peerUid);
    teardownPeer(peerUid);
    renderPanel();
    toast('error', relayWorked
      ? `Couldn't connect audio with ${nameOf(peerUid)} — the relay was reachable but the connection still failed.`
      : `Couldn't connect audio with ${nameOf(peerUid)} — no TURN relay available on this network. ` +
        'An admin can add relay credentials in voiceCallConfig/turn.');
  }

  /* ═══════════════════════════════════════════════════════════
     Signaling — Firestore docs addressed peer-to-peer
     ═══════════════════════════════════════════════════════════ */
  function sendSignal(toUid, kind, payload) {
    if (!_channelId) return;
    callRef(_channelId).collection('signals').add({
      from: _uid,
      to: toUid,
      kind: kind,
      payload: JSON.stringify(payload),
      sessionId: _sessionId,
      createdAt: stamp(),
    }).catch((e) => console.error('[voice-call] sendSignal:', e));
  }

  /* Snapshots deliver the FULL result set, so an invocation that awaits
     mid-loop would let the next snapshot re-process the same docs
     concurrently. Serialize, and mark ids handled synchronously. */
  function queueSignals(chId, docs) {
    _sigChain = _sigChain
      .then(() => processSignals(chId, docs))
      .catch((e) => console.error('[voice-call] signal batch:', e));
  }

  async function processSignals(chId, docs) {
    if (chId !== _channelId) return;
    const fresh = [];
    docs.forEach((d) => {
      if (_handledSignals.has(d.id)) return;
      _handledSignals.add(d.id);          // sync, before any await
      fresh.push(d);
    });
    if (!fresh.length) return;

    fresh.sort((a, b) => millis(a.createdAt) - millis(b.createdAt));

    for (const sig of fresh) {
      if (chId !== _channelId) return;    // left mid-batch
      try {
        await handleSignal(sig);
      } catch (e) {
        console.error('[voice-call] signal ' + sig.kind + ':', e);
      }
      // Consume — delete regardless so a poison signal can't loop forever.
      callRef(chId).collection('signals').doc(sig.id).delete()
        .catch(() => { /* raced with another cleanup — fine */ });
    }
  }

  async function handleSignal(sig) {
    const peerUid = sig.from;
    const payload = JSON.parse(sig.payload);

    if (sig.kind === 'offer') {
      /* ★ SECURITY (V3.593): answering an offer attaches the microphone,
         so an offer from someone who is NOT in the call's roster used to
         be a silent audio tap — no tile, no count change, no trace. Only
         roster members may negotiate. A legitimate offer CAN beat the
         roster snapshot, so hold it and replay from onParticipants. */
      if (!_participants.some((p) => p.uid === peerUid)) {
        _pendingOffers.set(peerUid, payload);
        console.warn('[voice-call] offer from non-roster peer %s — held pending roster', peerUid);
        return;
      }
      await applyOffer(peerUid, payload);
      return;
    }

    const entry = _peers.get(peerUid);
    if (sig.kind === 'answer') {
      if (!entry) { console.warn('[voice-call] answer for unknown peer', peerUid); return; }
      if (entry.pc.signalingState !== 'have-local-offer') {
        console.warn('[voice-call] ignoring answer in state', entry.pc.signalingState);
        return;
      }
      await entry.pc.setRemoteDescription(new RTCSessionDescription(payload));
      await flushCandidates(entry);
    } else if (sig.kind === 'candidate') {
      if (!entry) {
        // A candidate can arrive BEFORE its peer exists (Firestore gives no
        // cross-document ordering guarantee). Dropping it silently discarded
        // candidate pairs and made ICE failure far more likely.
        const list = _orphanCandidates.get(peerUid) || [];
        list.push(payload);
        _orphanCandidates.set(peerUid, list);
        return;
      }
      if (entry.pc.remoteDescription) {
        await entry.pc.addIceCandidate(new RTCIceCandidate(payload));
      } else {
        entry.pending.push(payload);   // queue until remote description lands
      }
    }
  }

  async function applyOffer(peerUid, payload) {
    if (!_channelId || !_localStream) return;
    let entry = _peers.get(peerUid);
    // A re-offer against a dead pc is the initiator's ICE-restart rebuild;
    // setRemoteDescription on the corpse would throw.
    if (entry && (entry.pc.connectionState === 'failed'
                  || entry.pc.connectionState === 'closed')) {
      _peerRetries.set(peerUid, (_peerRetries.get(peerUid) || 0) + 1);
      teardownPeer(peerUid);
      entry = null;
    }
    if (!entry) {
      _failedPeers.delete(peerUid);   // an explicit offer overrides give-up
      createPeer(peerUid);
      entry = _peers.get(peerUid);
    }
    if (!entry) return;               // createPeer declined (left mid-flight)
    await entry.pc.setRemoteDescription(new RTCSessionDescription(payload));
    await flushCandidates(entry);
    const answer = await entry.pc.createAnswer();
    await entry.pc.setLocalDescription(answer);
    if (_peers.get(peerUid) !== entry) return;
    sendSignal(peerUid, 'answer',
      { type: entry.pc.localDescription.type, sdp: entry.pc.localDescription.sdp });
  }

  async function flushCandidates(entry) {
    const queued = entry.pending.splice(0);
    for (const c of queued) {
      try { await entry.pc.addIceCandidate(new RTCIceCandidate(c)); }
      catch (e) { console.warn('[voice-call] queued candidate:', e && e.message); }
    }
  }

  /* ═══════════════════════════════════════════════════════════
     Leave / teardown
     ═══════════════════════════════════════════════════════════ */
  async function leave(opts) {
    opts = opts || {};
    if (!opts.keepGen) _gen++;        // abort any in-flight open()
    const chId = _channelId;
    _channelId = null;

    // Don't re-ring the call I just hung up on — dismiss this instance
    // (the header 📞 stays live, so rejoining is still one click away).
    if (chId) {
      const call = _activeCalls.get(chId);
      dismissLocal(chId, millis(call && call.startedAt));
    }
    emitChange();

    window.removeEventListener('pagehide', leaveOnUnload);
    if (_heartbeat) { clearInterval(_heartbeat); _heartbeat = null; }
    if (_levelTimer) { clearInterval(_levelTimer); _levelTimer = null; }
    if (_unsubParticipants) { _unsubParticipants(); _unsubParticipants = null; }
    if (_unsubSignals) { _unsubSignals(); _unsubSignals = null; }

    Array.from(_peers.keys()).forEach(teardownPeer);
    _peers.clear();
    _peerRetries.clear();
    _failedPeers.clear();
    _orphanCandidates.clear();
    _pendingOffers.clear();
    _handledSignals.clear();
    _participants = [];

    if (_localStream) {
      _localStream.getTracks().forEach((t) => t.stop());
      _localStream = null;
    }
    if (_audioCtx) { _audioCtx.close().catch(() => {}); _audioCtx = null; }
    removePanel();

    if (!chId || !_uid) return;
    try {
      await callRef(chId).collection('participants').doc(_uid).delete();
      // NOTE: deliberately NOT deleting my outbound signals here. Doing so
      // raced a fast rejoin and deleted the NEW session's offers, leaving a
      // pair permanently stuck at "connecting". Unconsumed signals are tiny,
      // the recipient deletes them normally, and anything left behind is
      // reaped by purgeCall on the next join (rules allow deleting aged docs).
      const rest = await callRef(chId).collection('participants').get();
      const stillLive = rest.docs.map((d) => d.data()).filter(isFresh);
      if (stillLive.length === 0) await callRef(chId).delete();
    } catch (e) {
      console.warn('[voice-call] leave cleanup:', e && e.message);
    }
  }

  /* pagehide: best-effort fire-and-forget (the page is going away).
     Stale-peer filtering + purgeCall cover us if this doesn't land. */
  function leaveOnUnload() {
    if (!_channelId || !_uid) return;
    try {
      callRef(_channelId).collection('participants').doc(_uid).delete();
    } catch (e) { /* page is unloading */ }
  }

  /* ═══════════════════════════════════════════════════════════
     Mute + speaking detection
     ═══════════════════════════════════════════════════════════ */
  function toggleMute() {
    _muted = !_muted;
    if (_localStream) {
      _localStream.getAudioTracks().forEach((t) => { t.enabled = !_muted; });
    }
    writeParticipant(false);
    renderPanel();
  }

  function ensureAudioCtx() {
    if (!_audioCtx) {
      const Ctx = window.AudioContext || window.webkitAudioContext;
      if (!Ctx) return null;
      _audioCtx = new Ctx();
    }
    // Safari/WKWebView start suspended when the user gesture is already
    // consumed; resume so the speaking dots work. Audio itself is unaffected
    // (the analyser is never connected to a destination).
    if (_audioCtx.state === 'suspended') _audioCtx.resume().catch(() => {});
    return _audioCtx;
  }

  function attachAnalyser(entry, stream) {
    if (entry.analyser && entry.analyserStream === stream) return;  // already wired
    const ctx = ensureAudioCtx();
    if (!ctx) return;
    try { if (entry.src) entry.src.disconnect(); } catch (e) {}
    try {
      const src = ctx.createMediaStreamSource(stream);
      const analyser = ctx.createAnalyser();
      analyser.fftSize = 256;
      src.connect(analyser);
      entry.src = src;
      entry.analyser = analyser;
      entry.analyserStream = stream;
    } catch (e) { /* speaking dots are best-effort */ }
  }

  function startLevelMeter() {
    // local mic analyser rides on a pseudo-entry keyed by own uid
    const selfEntry = {};
    attachAnalyser(selfEntry, _localStream);
    const buf = new Uint8Array(128);

    function rms(analyser) {
      if (!analyser) return 0;
      analyser.getByteTimeDomainData(buf);
      let sum = 0;
      for (let i = 0; i < buf.length; i++) {
        const v = (buf[i] - 128) / 128;
        sum += v * v;
      }
      return Math.sqrt(sum / buf.length);
    }

    _levelTimer = setInterval(() => {
      setSpeaking(_uid, !_muted && rms(selfEntry.analyser) > SPEAKING_RMS);
      _peers.forEach((entry, uid) => {
        setSpeaking(uid, rms(entry.analyser) > SPEAKING_RMS);
      });
    }, LEVEL_POLL_MS);
  }

  function setSpeaking(uid, speaking) {
    // CSS.escape: the participant `uid` FIELD is client-written, so a value
    // containing a quote would make this an invalid selector and throw on
    // every tick.
    const key = window.CSS && CSS.escape ? CSS.escape(uid) : String(uid).replace(/["\\]/g, '');
    const tile = document.querySelector('.vc-tile[data-uid="' + key + '"]');
    if (tile) tile.classList.toggle('vc-tile--speaking', speaking);
  }

  /* ═══════════════════════════════════════════════════════════
     UI — fixed call panel (bottom-right)
     ═══════════════════════════════════════════════════════════ */
  function esc(s) {
    return String(s == null ? '' : s).replace(/[&<>"']/g, (c) => ({
      '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;',
    }[c]));
  }

  function nameOf(uid) {
    const p = _participants.find((x) => x.uid === uid);
    return (p && p.name) || 'someone';
  }

  function audioSink() {
    let el = document.getElementById('vc-audio-sink');
    if (!el) {
      el = document.createElement('div');
      el.id = 'vc-audio-sink';
      el.style.display = 'none';
      document.body.appendChild(el);
    }
    return el;
  }

  function connState(uid) {
    if (uid === _uid) return 'connected';
    if (_failedPeers.has(uid)) return 'failed';
    const entry = _peers.get(uid);
    if (!entry) return 'connecting';
    const s = entry.pc.connectionState;
    return s === 'connected' ? 'connected'
      : s === 'failed' ? 'failed' : 'connecting';
  }

  /* Signature of what the panel actually shows — lets renderPanel skip the
     innerHTML rebuild on the ~1/sec heartbeat snapshots, which otherwise
     wiped the speaking-dot classes the level meter had just set. */
  function panelSignature() {
    return _participants.map((p) => p.uid + ':' + (p.muted ? 1 : 0) + ':'
      + connState(p.uid) + ':' + (p.name || '')).join('|')
      + '|' + _muted + '|' + _channelName;
  }
  let _panelSig = null;

  function renderPanel() {
    if (!_channelId) return;
    let panel = document.getElementById('vc-panel');
    if (!panel) {
      panel = document.createElement('div');
      panel.id = 'vc-panel';
      document.body.appendChild(panel);
      panel.addEventListener('click', (e) => {
        const btn = e.target.closest('[data-vc-action]');
        if (!btn) return;
        if (btn.dataset.vcAction === 'mute') toggleMute();
        if (btn.dataset.vcAction === 'leave') leave();
      });
      _panelSig = null;
    }
    const sig = panelSignature();
    if (sig === _panelSig) return;
    _panelSig = sig;

    const tiles = _participants.map((p) => {
      const initial = (p.name || '?').trim().charAt(0).toUpperCase();
      const state = connState(p.uid);
      return `<div class="vc-tile vc-tile--${state}" data-uid="${esc(p.uid)}"
        title="${esc(p.name)}${state === 'failed' ? ' (connection failed)' : ''}">
        <span class="vc-avatar">${esc(initial)}</span>
        <span class="vc-tile-name">${esc(p.uid === _uid ? 'You' : p.name)}</span>
        ${p.muted ? '<span class="vc-muted-icon" title="Muted">' + ICON.svg('speaker-x-mark') + '</span>' : ''}
      </div>`;
    }).join('');

    panel.innerHTML = `
      <div class="vc-header">
        <span class="vc-live-dot"></span>
        <span class="vc-title">${esc(_channelName)}</span>
        <span class="vc-count">${_participants.length}</span>
      </div>
      <div class="vc-tiles">${tiles}</div>
      <div class="vc-controls">
        <button class="vc-btn${_muted ? ' vc-btn--active' : ''}" data-vc-action="mute">
          ${_muted ? ICON.svg('speaker-x-mark') + ' Unmute' : ICON.svg('microphone') + ' Mute'}
        </button>
        <button class="vc-btn vc-btn--danger" data-vc-action="leave">${ICON.svg('phone')} Leave</button>
      </div>`;
  }

  function removePanel() {
    const panel = document.getElementById('vc-panel');
    if (panel) panel.remove();
    const sink = document.getElementById('vc-audio-sink');
    if (sink) sink.remove();
    _panelSig = null;
  }

  function focusPanel() {
    const panel = document.getElementById('vc-panel');
    if (panel) {
      panel.classList.remove('vc-panel--pulse');
      void panel.offsetWidth;  // restart animation
      panel.classList.add('vc-panel--pulse');
    }
  }

  /* ═══════════════════════════════════════════════════════════
     Diagnostics
     ═══════════════════════════════════════════════════════════ */
  /** Proves whether THIS network can get a relay candidate, without needing
   *  a second person on a call. Run `await VOICE_CALL.testIce()` in the
   *  console on the problem network. relay:false ⇒ TURN is unreachable or
   *  the credentials are rejected (check `errors` to tell which) and calls
   *  off-LAN will fail. */
  async function testIce() {
    await loadIceConfig();
    const found = { relay: 0, srflx: 0, host: 0 };
    const errors = [];
    const pc = new RTCPeerConnection({ iceServers: _iceServers });
    pc.createDataChannel('probe');
    await new Promise((resolve) => {
      let done = false;
      let timer = null;
      const finish = () => {
        if (done) return;
        done = true;
        if (timer) clearTimeout(timer);
        resolve();
      };
      pc.onicecandidate = (e) => {
        if (!e.candidate) return finish();          // gathering complete
        if (found[e.candidate.type] !== undefined) found[e.candidate.type]++;
      };
      // 701 = server unreachable; 401/403 = credentials rejected. Without
      // this, "blocked" and "bad password" look identical.
      pc.onicecandidateerror = (e) => errors.push({
        url: e.url, code: e.errorCode, text: e.errorText,
      });
      pc.createOffer().then((o) => pc.setLocalDescription(o))
        .catch((err) => { console.error('[voice-call] testIce:', err); finish(); });
      timer = setTimeout(finish, 8000);             // hard cap
    });
    pc.close();
    const result = {
      relay: found.relay > 0, srflx: found.srflx > 0, host: found.host > 0,
      counts: found,
      errors: errors,
      servers: _iceServers.map((s) => s.urls),     // URLs only — no credentials
    };
    console.log(result.relay
      ? '[voice-call] TURN OK — relay candidates available, calls should connect.'
      : '[voice-call] NO relay candidate — TURN is blocked or rejecting credentials; '
        + 'off-network calls will fail. Set voiceCallConfig/turn.', result);
    return result;
  }

  /* ═══════════════════════════════════════════════════════════
     Boot
     ═══════════════════════════════════════════════════════════ */
  function tryInit() {
    if (_uid) return;  // already initialized
    const user = firebridge.getUser();
    if (!user || !firebridge.isLabMember()) return;
    _uid = user.uid;
    const profile = firebridge.getProfile();
    _name = (profile && profile.name) || user.displayName || user.email || 'Lab member';
    watchActiveCalls();
  }

  (async function boot() {
    if (typeof firebridge === 'undefined') return;
    if (firebridge.whenAuthResolved) await firebridge.whenAuthResolved();
    tryInit();
    // Late sign-in / role promotion (guest → member) arms the watcher too.
    if (!_uid && firebridge.onAuth) firebridge.onAuth(tryInit);
  })();

  window.VOICE_CALL = {
    open,
    leave,
    decline,
    testIce,
    getIncomingCalls,
    getActiveCall: (channelId) => _activeCalls.get(channelId) || null,
    currentChannelId: () => _channelId,
  };
})();
