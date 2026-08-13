/* ================================================================
   Lab Chat — RM-native port (V3.52)
   ================================================================
   Real-time messaging — channels, DMs, threads, reactions,
   @mentions, read receipts, browser push, Google Drive file
   sharing (via Apps Script — no per-user OAuth needed, see the
   "no per-user token needed" note at line ~114).

   Lifted from /apps/chat/app.js (3,630 LOC) with the same lift-
   and-patch playbook as V3.41 meetings + V3.49 activity-tracker
   + V3.50 huddle:
     1. window.McgheeLab guard at top so optional-chaining lookups
        for MobileShell? don't ReferenceError before any other
        lab-shared script initialises the namespace.
     2. Container id #app → #chat-root (avoids collision with
        other RM pages).
     3. db() prefers firebridge.db().
     4. Bootstrap rewrite — firebridge.gateSignedIn /
        whenAuthResolved replaces the dual AppBridge / direct-
        Firebase path. The canAccessChat() guest gate is preserved
        for the chat-specific permission check.
     5. notifyResize() hardened so the AppBridge.isEmbedded()
        call no-ops cleanly when AppBridge is undefined.

   No V3.51 deferral: Drive uploads go through the Apps Script
   web app at chatConfig.gdriveScriptUrl, not per-user Google
   OAuth — so chat ports cleanly while the OAuth refactor for
   Calendar/ScheduleService still cooks separately.

   firestore.rules: chatConfig (line 383), chatChannels
   (line 389), chatMessages (line 398), chatReadState (line 409),
   chatUserMeta (line 414) — all in place; no rule changes.

   V3.503 — incremental rendering foundation:
     - renderShell() mounts a stable skeleton once per layout mode
       (desktop 3-pane / mobile tabs); render() only refreshes region
       contents into `.chat-slot` containers (display: contents, so
       the CSS layout tree is unchanged).
     - ALL clicks flow through ONE delegated listener on #chat-root
       (CLICK_ROUTES, first-match-wins ordering). The old wireAll()
       re-wiring cascade is gone; only non-click wiring (inputs,
       drag-drop, scroll) re-attaches per region rebuild.
     - Composer text/focus survive render(); resize across the 700px
       breakpoint rebuilds the shell (previously required a reload).
   ================================================================ */

window.McgheeLab = window.McgheeLab || {};

(() => {
  'use strict';

  const appEl = document.getElementById('chat-root');
  if (!appEl) {
    console.warn('[Chat] #chat-root container missing');
    return;
  }
  function db() {
    if (typeof firebridge !== 'undefined' && firebridge.db) return firebridge.db();
    if (typeof firebase === 'undefined') throw new Error('Firebase SDK not loaded');
    return firebase.firestore();
  }
  const TS = () => firebase.firestore.FieldValue.serverTimestamp();
  const ARR_UNION = (...v) => firebase.firestore.FieldValue.arrayUnion(...v);
  const ARR_REMOVE = (...v) => firebase.firestore.FieldValue.arrayRemove(...v);

  /* ═══════════════════════════════════════════════════════════
     CONSTANTS & CONFIG
     ═══════════════════════════════════════════════════════════ */
  const MSG_PAGE_SIZE = 50;
  // R2 — one-time subscriberUids backfill endpoint (functions/chat.js).
  const BACKFILL_FN_URL = 'https://us-central1-mcgheelab-f56cc.cloudfunctions.net/chatBackfillSubscribers';
  // V3.582 — Slack-history import endpoint (Admin SDK; rules pin
  // authorUid == auth.uid on client creates, so cross-user attribution
  // must go server-side).
  const IMPORT_FN_URL = 'https://us-central1-mcgheelab-f56cc.cloudfunctions.net/chatImportSlackHistory';
  const EMOJI_SET = [
    { key: 'thumbsup', label: '👍' },
    { key: 'thumbsdown', label: '👎' },
    { key: 'heart', label: '❤️' },
    { key: 'laugh', label: '😂' },
    { key: 'surprise', label: '😮' },
    { key: 'sad', label: '😢' },
    { key: 'fire', label: '🔥' },
    { key: 'check', label: '✅' },
    { key: 'eyes', label: '👀' },
    { key: 'rocket', label: '🚀' },
    { key: 'clap', label: '👏' },
    { key: 'think', label: '🤔' },
    { key: 'hundred', label: '💯' },
    { key: 'pray', label: '🙏' },
    { key: 'tada', label: '🎉' },
    { key: 'plus1', label: '➕' },
    { key: 'minus1', label: '➖' },
    { key: 'wave', label: '👋' },
    { key: 'bulb', label: '💡' },
    { key: 'pin', label: '📌' }
  ];
  const DEFAULT_CATEGORIES = ['General', 'Projects', 'Courses', 'Lab Operations', 'Social'];
  const DEFAULT_CHANNELS = [
    { name: 'general', displayName: 'General', description: 'General lab chat', category: 'General', isDefault: true, isAnnouncement: false },
    { name: 'announcements', displayName: 'Announcements', description: 'Lab-wide announcements (admin only)', category: 'General', isDefault: true, isAnnouncement: true },
    { name: 'random', displayName: 'Random', description: 'Off-topic chat and fun stuff', category: 'Social', isDefault: true, isAnnouncement: false }
  ];

  /* ═══════════════════════════════════════════════════════════
     STATE
     ═══════════════════════════════════════════════════════════ */
  let _user = null;
  let _profile = null;
  let _allUsers = [];

  // Config
  let _config = null; // chatConfig/settings

  // Channels
  let _channels = [];
  let _activeChannelId = null;

  // User meta
  let _userMeta = null; // chatUserMeta/{uid}

  // Messages
  let _messages = [];
  let _oldestLoaded = null;
  let _hasMoreMessages = true;
  let _loadingOlder = false;

  /* R6 — feed mode. 'live' = newest-50 onSnapshot tail (the normal
   * state). 'history' = a detached window around a jumped-to message:
   * the live listener is off, upward pagination works as usual, and a
   * new downward pager (loadNewerMessages) walks back toward the tail.
   * Catching the tail (or the banner / sending a message) transitions
   * back to live. */
  let _feedMode = 'live';
  let _histNewestLoaded = null;  // doc SNAPSHOT cursor for the asc pager
  let _histHasNewer = false;
  let _loadingNewer = false;

  /* R6 — progressive full-history search. The scan pages backward
   * through chatMessages (200/batch) filtering client-side; scanned
   * docs are cached per scope+channel so query refinement re-filters
   * without re-reading. A generation counter cancels superseded scans. */
  let _searchScope = 'channel'; // 'channel' | 'all'
  let _searchScanGen = 0;
  let _searchDebounceTimer = null;
  let _searchCache = { scope: null, channelKey: null, docs: [], cursorSnap: null, exhausted: false };

  // Read state
  let _readStates = {}; // { channelId: { lastReadAt, lastReadMessageId, mentionCount } }

  // Thread
  let _threadParentId = null;
  let _threadMessages = [];

  // UI state
  let _showChannelDirectory = false;
  let _showCreateChannel = false;
  let _showSettings = false;
  let _showPinned = false;
  let _showSearch = false;
  let _searchQuery = '';
  let _editingMessageId = null;
  let _selectedMsgId = null; // tapped message for action bar
  let _mentionQuery = null;
  let _mentionIndex = 0;
  let _showEmojiPickerFor = null;
  let _mobileSidebarOpen = false;
  let _showNewDM = false;
  let _showManageContacts = false;
  let _showSeenBy = null;

  /* V3.582 — Slack-history import modal. step: 'input' → 'map' →
   * 'preview' → 'progress' → 'done'. parsed = CHAT_SLACK_IMPORT.parse
   * output; mapping = { slackName → {uid|null, displayName} | 'SKIP' };
   * batches = this channel's chatImports docs (previously-imported list). */
  let _showImport = false;
  let _importState = null;

  /* V3.86 — embed-mode detection. True when chat is loaded inside a
   * shell popout (rm/pages/workflow-shell.html or split-view.html).
   * In embed mode we:
   *   - default _mobileTab to 'chat' so the user lands on their last
   *     conversation instead of the Overview list (popout is narrow,
   *     so chat.js renders the mobile tabbed layout — but the user
   *     opened the chat popout because they wanted to chat, not to
   *     browse channels).
   *   - skip the mobile top bar (page title + hamburger) and bottom
   *     bar (other-app launcher), which are designed for full-screen
   *     mobile and just clutter the popout.
   *   - persist the active channel id in localStorage so reopening
   *     the popout returns to the same conversation. */
  const _IS_EMBED = (function () {
    try {
      if (window.parent !== window) {
        // The Ourlab app shell (app-shell.html, <body data-app-shell="1">)
        // hosts FULL-SCREEN tabs, not narrow split-view/workflow preview
        // panes — so it is NOT "embed": chat must render its normal
        // full-screen layout (Overview default, full channel list) and skip
        // the split-view parent integration (parent.location.hash /
        // postMessage) that only makes sense inside those shells. Other
        // iframe hosts still count as embed.
        var _appShellHost = false;
        try {
          _appShellHost = !!(window.parent.document && window.parent.document.body
            && window.parent.document.body.getAttribute('data-app-shell') === '1');
        } catch (e) { _appShellHost = false; }
        if (!_appShellHost) return true;
      }
      if (typeof window.name === 'string' && /^rm-(embed|shell)/.test(window.name)) return true;
      const sp = new URLSearchParams(location.search);
      if (sp.get('embed') === '1') return true;
    } catch (e) { /* ignore */ }
    return false;
  })();
  const _LAST_CHANNEL_LS_KEY = 'mcgheelab.chat.lastChannelId';

  /* V3.581 — restore the last conversation in ONE paint (Alex: opening the
   * chat tab rendered Overview, then the V3.86 auto-select swapped to the
   * remembered channel — three visible renders in series, wasted effort).
   * Resolve the restore target SYNCHRONOUSLY at parse time (?channel deep
   * link wins over the remembered channel, same precedence as the old
   * auto-select), start on the chat pane, and let init() pre-seed the
   * channel + message stream so the first content render IS the
   * conversation you left. Overview stays one tap away. */
  const _restoreChannelId = (() => {
    try {
      const req = new URLSearchParams(location.search).get('channel');
      if (req) return req;
    } catch (e) { /* ignore */ }
    try { return localStorage.getItem(_LAST_CHANNEL_LS_KEY) || null; } catch (e) { return null; }
  })();
  // True while the pre-seeded channel awaits validation against the real
  // channel list (it may have been deleted since last visit).
  let _pendingRestore = false;

  // Mobile tab state. In embed mode — or when restoring a remembered
  // conversation — default to 'chat' so the page opens straight into the
  // conversation pane (Overview is one tap away).
  let _mobileTab = (_IS_EMBED || _restoreChannelId) ? 'chat' : 'overview';
  let _conversationFilter = 'newest';
  let _mobileFilterOpen = false;
  let _mobileHamburgerOpen = false;

  // Collapsed sections on mobile overview ('alumni' starts collapsed —
  // the auto-sorted Alumni group is reference material, not daily chat)
  let _collapsedSections = new Set(['alumni']);

  // Drag state for sidebar organization
  let _dragChannelId = null;
  let _dragOverGroup = null;

  // Google Drive (via Apps Script — no per-user token needed)
  let _uploadingFile = false;

  // Listeners
  let _unsubChannels = null;
  let _unsubMessages = null;
  let _unsubReadState = null;
  let _unsubThread = null;
  let _unsubUserMeta = null;
  // R7 — per-channel read states (uid -> lastReadAt) powering DERIVED
  // read receipts: "seen by M" = lastReadAt >= msg.createdAt. Replaces
  // the old readBy[] arrayUnion batch (up to 20 message-doc writes per
  // user per channel open).
  let _unsubChannelReadStates = null;
  let _channelReadStates = {};
  // R2 lifecycle: registry for listeners whose unsubs were previously
  // dropped on the floor (config, users). destroy() drains it.
  const _unsubs = [];

  let _toastTimer = null;
  let _autoScroll = true;
  let _isRendering = false; // Guard to prevent scroll events during innerHTML updates from resetting _autoScroll
  let _drafts = (() => { try { return JSON.parse(localStorage.getItem('chat-drafts') || '{}'); } catch { return {}; } })();
  let _draftSaveTimer = null;

  // R3 — markdown hint bar under the composer (Aa button toggles;
  // choice persists per device).
  let _mdHintOpen = (() => { try { return localStorage.getItem('chat-md-hint') === 'open'; } catch { return false; } })();
  // V3.570 — compact inline formatting toolbar (app), toggled by Aa.
  let _formatBarOpen = false;

  /* Corner alert for new messages (Alex request) — an in-page popup
   * (bottom corner) when a message lands in a channel you're NOT
   * currently looking at. One popup per burst: while visible it updates
   * in place instead of stacking, and after it hides (dismissed,
   * clicked, or auto-faded) a cooldown suppresses re-alerts so a busy
   * conversation doesn't nag. Driven by the existing chatChannels
   * listener (lastMessage changes) — zero extra Firestore reads. */
  const ALERT_COOLDOWN_MS = 3 * 60 * 1000;
  const ALERT_AUTOFADE_MS = 8000;
  let _alertInit = false;        // first channels snapshot = baseline only
  let _lastMsgSeen = {};         // channelId -> millis of newest processed lastMessage
  let _alertChannels = [];       // channel ids accumulated while the popup is visible
  let _alertCooldownUntil = 0;
  let _alertTimer = null;

  // R5 — presence & typing (chatPresence/{uid}, one listener for both)
  const PRESENCE_ONLINE_MS = 5 * 60 * 1000;   // green dot
  const PRESENCE_AWAY_MS = 30 * 60 * 1000;    // amber dot
  const HEARTBEAT_INTERVAL_MS = 2 * 60 * 1000;
  const TYPING_THROTTLE_MS = 4000;            // max one typing write per 4s
  const TYPING_TTL_MS = 8000;                 // entry expires after 8s
  let _presence = {};            // uid -> { lastActiveAt, typingChannelId, typingAt }
  let _typingLastWriteAt = 0;
  let _typingClearTimer = null;
  let _typingRerenderTimer = null;
  let _heartbeatTimer = null;
  let _onVisibilityChange = null;
  // V3.585 — tab-lifecycle (Ourlab app multi-WebView shell): while this
  // WebView is a hidden background tab, listeners are detached but DOM +
  // state stay warm. See pauseChat()/resumeChat().
  let _paused = false;
  let _hadUserMeta = false;        // was subscribeUserMeta live at pause?
  let _suppressAutoSelect = false; // resume while parked on Overview: don't
                                   // let the V3.86 auto-select re-fire

  /* V3.503 — incremental-render state. The shell (stable containers +
   * one delegated click listener) builds once per layout mode; render()
   * only refreshes region contents after that. */
  let _shellMode = null;     // 'desktop' | 'mobile' — which skeleton is mounted
  let _mainContentKey = null; // signature of the content slot; rebuild only on change
  let _resizeTimer = null;

  /* ═══════════════════════════════════════════════════════════
     BOOTSTRAP
     ═══════════════════════════════════════════════════════════ */
  // Prevent pinch-to-zoom on iOS — named so destroy() can remove them
  // (chat runs inside split-view iframes / popouts, so document-level
  // listeners outlive the page unless explicitly detached).
  const _onGestureStart = (e) => e.preventDefault();
  const _onGestureChange = (e) => e.preventDefault();
  document.addEventListener('gesturestart', _onGestureStart, { passive: false });
  document.addEventListener('gesturechange', _onGestureChange, { passive: false });

  /* ═══════════════════════════════════════════════════════════
     RM bootstrap — replaces the dual AppBridge / direct-Firebase
     path. firebridge.gateSignedIn handles the pending-access
     overlay; whenAuthResolved promises a populated _user/_profile
     before any data load. canAccessChat() then runs as a chat-
     specific guest gate (admin can grant chat to a guest user
     without flipping their role in users/{uid}).
     ═══════════════════════════════════════════════════════════ */
  (async function () {
    if (typeof firebridge === 'undefined') {
      console.warn('[Chat] firebridge not available');
      return;
    }
    if (firebridge.requireSignIn) await firebridge.requireSignIn();

    _user = firebridge.getUser ? firebridge.getUser() : null;
    _profile = firebridge.getProfile ? firebridge.getProfile() : null;
    if (!_user) return; // pending-access overlay handles the guest case

    // Chat-specific access gate — admin can opt a guest into chat without
    // promoting their role.
    if (!canAccessChat(_profile)) {
      appEl.innerHTML = '<div class="chat-access-denied">' +
        '<h2>Chat Access Required</h2>' +
        '<p>Guest accounts need admin approval to use Lab Chat.</p>' +
        '<p>Please ask your lab administrator to enable chat access for your account.</p>' +
        '</div>';
      return;
    }

    await loadConfig();
    await loadUsers();
    await loadUserMeta();
    wireDelegatedClicks();
    wireLayoutResize();
    wirePageScroll();
    // V3.581 — pre-seed the remembered channel BEFORE the first content
    // render and subscribe its messages right after it (in PARALLEL with
    // the channel list) so the page comes back exactly as it was left, in
    // one paint, instead of Overview → auto-select → conversation.
    if (_restoreChannelId) {
      _activeChannelId = _restoreChannelId;
      _pendingRestore = true;
    }
    render();
    if (_restoreChannelId) subscribeMessages(_restoreChannelId);
    subscribeChannels();
    subscribeReadState();
    subscribeUsers();
    subscribeConfig();
    startPresence();

    // V3.585 — tab-lifecycle race guard: if the native shell hid this tab
    // while the awaits above were in flight, 'ourlab:tab-hidden' already
    // flipped _paused but there was nothing to detach yet. Re-run the pause
    // now so the freshly attached listeners are detached; resume re-attaches
    // when the tab is next shown. Simple and correct over clever.
    if (_paused) { _paused = false; pauseChat(); }

    // Tab swipe for mobile (no-ops without MobileShell loaded).
    initChatTabSwipe();

    // V3.525 — voice-call.js broadcasts active-call changes; re-render the
    // header so the 📞 button flips between start/join-live states. Named
    // handler so destroy() can detach it (tab-lifecycle re-inits in place).
    window.addEventListener('voice-call-change', _onVoiceCallChange);

    // Re-render on profile-role flips (admin promotion unlocks chat-admin
    // affordances; chatAdmins list updates flow through subscribeConfig).
    if (firebridge.onAuth) {
      firebridge.onAuth(function () {
        const prevRole = _profile && _profile.role;
        _user = firebridge.getUser ? firebridge.getUser() : _user;
        _profile = firebridge.getProfile ? firebridge.getProfile() : _profile;
        if ((_profile && _profile.role) !== prevRole) render();
      });
    }
  })();

  /* ═══════════════════════════════════════════════════════════
     DATA LOADING
     ═══════════════════════════════════════════════════════════ */
  async function loadConfig() {
    const doc = await db().collection('chatConfig').doc('settings').get();
    if (doc.exists) {
      _config = doc.data();
    } else if (_profile?.role === 'admin') {
      // First boot — initialize config and default channels. Admin only:
      // firestore.rules rejects this write for anyone else anyway, so a
      // non-admin first visitor previously just got a console permission
      // error here (R2 makes the gate explicit).
      _config = {
        categories: DEFAULT_CATEGORIES,
        defaultChannels: DEFAULT_CHANNELS.map(c => c.name),
        chatAdmins: [_user.uid],
        userRoles: { [_user.uid]: 'admin' },
        initialized: true,
        gdriveScriptUrl: ''
      };
      await db().collection('chatConfig').doc('settings').set(_config);
      // Create default channels
      for (const ch of DEFAULT_CHANNELS) {
        await db().collection('chatChannels').add({
          ...ch,
          createdBy: _user.uid,
          pinnedMessageIds: [],
          lastMessage: null,
          lastActivityAt: TS(),
          memberCount: 0,
          messageCount: 0,
          subscriberUids: [],
          createdAt: TS()
        });
      }
    } else {
      // Not initialized and we can't seed it — read-only defaults until
      // an admin visits chat for the first time.
      _config = {
        categories: DEFAULT_CATEGORIES,
        defaultChannels: [],
        chatAdmins: [],
        userRoles: {},
        initialized: false,
        gdriveScriptUrl: ''
      };
    }
  }

  function subscribeConfig() {
    _unsubs.push(db().collection('chatConfig').doc('settings').onSnapshot(doc => {
      if (doc.exists) _config = doc.data();
    }));
  }

  async function loadUsers() {
    const snap = await db().collection('users').get();
    _allUsers = snap.docs.map(d => ({ uid: d.id, ...d.data() }));
  }

  function subscribeUsers() {
    _unsubs.push(db().collection('users').onSnapshot(snap => {
      _allUsers = snap.docs.map(d => ({ uid: d.id, ...d.data() }));
    }));
  }

  async function loadUserMeta() {
    const doc = await db().collection('chatUserMeta').doc(_user.uid).get();
    if (doc.exists) {
      _userMeta = doc.data();
    } else {
      // First visit — subscribe to default channels
      const defaultIds = _channels
        .filter(c => c.isDefault)
        .map(c => c.id);
      _userMeta = {
        subscribedChannels: defaultIds,
        mutedChannels: [],
        sidebarLayout: [{ groupName: 'Channels', channelIds: defaultIds }],
        dmChannelIds: [],
        dmContacts: [], // [{ groupName: 'Lab', uids: ['uid1','uid2'] }, ...]
        lastActiveAt: TS(),
        notificationPrefs: { browser: true, mentionsOnly: false },
        gdriveConnected: false
      };
      await db().collection('chatUserMeta').doc(_user.uid).set(_userMeta);
    }
  }

  function subscribeUserMeta() {
    if (_unsubUserMeta) _unsubUserMeta();
    _unsubUserMeta = db().collection('chatUserMeta').doc(_user.uid)
      .onSnapshot(snap => {
        if (snap.exists) _userMeta = snap.data();
      });
  }

  /* ═══════════════════════════════════════════════════════════
     PRESENCE & TYPING (R5)
     One chatPresence/{uid} doc per user carries both the activity
     heartbeat and the typing state; one collection listener serves
     every dot and the typing row. Lab-scale (10–30 docs) so the
     listener is cheap; heartbeats only fire while the tab is visible.
     ═══════════════════════════════════════════════════════════ */
  function subscribePresence() {
    _unsubs.push(db().collection('chatPresence').onSnapshot(snap => {
      _presence = {};
      snap.docs.forEach(d => { _presence[d.id] = d.data(); });
      updatePresenceUI();
      updateTypingRow();
    }, err => console.warn('[Chat] presence listener error:', err)));
  }

  function writePresence(patch) {
    if (!_user) return;
    db().collection('chatPresence').doc(_user.uid)
      .set({ uid: _user.uid, ...patch }, { merge: true })
      .catch(() => {});
  }

  function heartbeatPresence() {
    writePresence({ lastActiveAt: TS() });
  }

  function startPresence() {
    subscribePresence();
    heartbeatPresence();
    _heartbeatTimer = setInterval(() => {
      if (document.visibilityState === 'visible') heartbeatPresence();
    }, HEARTBEAT_INTERVAL_MS);
    _onVisibilityChange = () => {
      if (document.visibilityState === 'visible') {
        heartbeatPresence();
        // Corner alerts queued while the tab was hidden show now
        if (_alertChannels.length && !document.getElementById('chat-corner-alert')) {
          showCornerAlert();
        }
      }
    };
    document.addEventListener('visibilitychange', _onVisibilityChange);
  }

  // channelId to declare "typing in this channel", null to clear.
  function writeTyping(channelId) {
    if (channelId) {
      const now = Date.now();
      if (now - _typingLastWriteAt < TYPING_THROTTLE_MS) return;
      _typingLastWriteAt = now;
      writePresence({ typingChannelId: channelId, typingAt: TS() });
    } else {
      _typingLastWriteAt = 0;
      writePresence({ typingChannelId: null, typingAt: null });
    }
  }

  function getPresenceBucket(uid) {
    const p = _presence[uid];
    const d = p && tsToDate(p.lastActiveAt);
    if (!d) return null;
    const age = Date.now() - d.getTime();
    if (age < PRESENCE_ONLINE_MS) return 'online';
    if (age < PRESENCE_AWAY_MS) return 'away';
    return null;
  }

  function renderPresenceDotHTML(uid, inline) {
    return `<span class="chat-presence-dot${inline ? ' chat-presence-dot--inline' : ''}" data-presence-uid="${escHTML(uid)}"></span>`;
  }

  // Toggle dot classes in place — no region re-render (R1's stable DOM
  // is what makes this cheap).
  function updatePresenceUI() {
    document.querySelectorAll('[data-presence-uid]').forEach(el => {
      const bucket = getPresenceBucket(el.dataset.presenceUid);
      el.classList.toggle('chat-presence-dot--online', bucket === 'online');
      el.classList.toggle('chat-presence-dot--away', bucket === 'away');
    });
  }

  function updateTypingRow() {
    const row = document.getElementById('chat-typing-row');
    if (!row) return;
    const now = Date.now();
    const names = [];
    for (const uid of Object.keys(_presence)) {
      if (uid === _user.uid) continue;
      const p = _presence[uid];
      if (!p.typingChannelId || p.typingChannelId !== _activeChannelId) continue;
      const t = tsToDate(p.typingAt);
      if (!t || now - t.getTime() > TYPING_TTL_MS) continue;
      const u = _allUsers.find(a => a.uid === uid);
      names.push(((u && (u.name || u.displayName || u.email)) || 'Someone').split(/\s+/)[0]);
    }
    let text = '';
    if (names.length === 1) text = `${names[0]} is typing…`;
    else if (names.length === 2) text = `${names[0]} and ${names[1]} are typing…`;
    else if (names.length > 2) text = `${names.length} people are typing…`;
    row.innerHTML = text
      ? `<span class="chat-typing-dots"><i></i><i></i><i></i></span> ${escHTML(text)}`
      : '';
    row.classList.toggle('chat-typing-row--active', !!text);
    // Re-evaluate while anyone is shown so stale entries expire without
    // needing another snapshot.
    clearTimeout(_typingRerenderTimer);
    if (text) _typingRerenderTimer = setTimeout(updateTypingRow, 3000);
  }

  /* ═══════════════════════════════════════════════════════════
     FIRESTORE — Channel Listeners
     ═══════════════════════════════════════════════════════════ */
  function subscribeChannels() {
    if (_unsubChannels) _unsubChannels();
    _unsubChannels = db().collection('chatChannels')
      .orderBy('lastActivityAt', 'desc')
      .onSnapshot(snap => {
        _channels = snap.docs.map(d => ({ id: d.id, ...d.data() }));
        // On first load with no userMeta subscriptions, subscribe to defaults
        if (_userMeta && _userMeta.subscribedChannels.length === 0) {
          const defaultIds = _channels.filter(c => c.isDefault).map(c => c.id);
          if (defaultIds.length > 0) {
            _userMeta.subscribedChannels = defaultIds;
            _userMeta.sidebarLayout = [{ groupName: 'Channels', channelIds: defaultIds }];
            db().collection('chatUserMeta').doc(_user.uid).update({
              subscribedChannels: defaultIds,
              sidebarLayout: _userMeta.sidebarLayout
            });
            // Mirror onto each channel's authoritative subscriber list (R2)
            defaultIds.forEach(id => {
              db().collection('chatChannels').doc(id)
                .update({ subscriberUids: ARR_UNION(_user.uid) })
                .catch(() => {});
            });
          }
        }
        // V3.581 — pre-seeded restore: the channel list just arrived.
        // If the remembered channel still exists, one re-render attaches
        // its real header/sidebar state (messages are already streaming).
        // If it was deleted since last visit, drop the pre-seed and let
        // the normal auto-select below pick a fallback.
        if (_pendingRestore) {
          _pendingRestore = false;
          if (_channels.some(c => c.id === _activeChannelId)) {
            render();
            restoreDraft();
          } else {
            _activeChannelId = null;
            if (_unsubMessages) { _unsubMessages(); _unsubMessages = null; }
            if (!_IS_EMBED && isMobile()) _mobileTab = 'overview';
          }
        }
        // V3.86 — auto-select last opened channel (from localStorage) if
        // it still exists; falls back to most recent channel. Skips
        // when an _activeChannelId is already set (e.g., the user
        // already navigated to a different channel during this session).
        // V3.585: also skipped right after a tab-lifecycle resume when the
        // user had parked on Overview — resuming must not yank them into a
        // conversation they deliberately left.
        if (!_activeChannelId && !_suppressAutoSelect && _channels.length > 0) {
          let pick = null;
          // ?channel= deep link (FCM push clicks + the RM-wide corner
          // alert) wins over the remembered channel. Never handled
          // before — push taps landed on whatever channel was last open.
          try {
            const requested = new URLSearchParams(location.search).get('channel');
            if (requested && _channels.some(c => c.id === requested)) pick = requested;
          } catch (e) { /* ignore */ }
          if (!pick) {
            try {
              const remembered = localStorage.getItem(_LAST_CHANNEL_LS_KEY);
              if (remembered && _channels.some(c => c.id === remembered)) pick = remembered;
            } catch (e) { /* ignore */ }
          }
          selectChannel(pick || _channels[0].id);
        }
        healDmMemberships();
        processChannelAlerts();
        renderSidebar();
      });
    subscribeUserMeta();
  }

  /* Am I actually watching the live feed of the active channel? "On the
     chat page" is not enough — scrolled up into history, or off on the
     files/pinned view, means a new message would slide past unseen.
     Deliberately excludes document.visibilityState: callers that need it
     add it (processChannelAlerts), and RM_PRESENCE owns visibility itself. */
  function isWatchingFeed() {
    return !!_activeChannelId
      && _feedMode === 'live'
      && _autoScroll
      && (_shellMode === 'mobile' ? _mobileTab === 'chat' : _desktopView === 'chat');
  }

  /* V3.596 — publish the active channel to userPresence/{uid} so the push
     pipeline can skip notifying me about a message I'm looking at, while
     still notifying me about every OTHER channel and every other app.
     `setContext` no-ops when unchanged, so calling this from render() is
     free; `[]` means "on the page but not watching" → notify normally. */
  function publishPresenceContext() {
    if (!window.RM_PRESENCE) return;
    window.RM_PRESENCE.setContext(isWatchingFeed() ? [_activeChannelId] : []);
  }

  /* ═══════════════════════════════════════════════════════════
     CORNER ALERT (Alex request) — see state block for the design.
     ═══════════════════════════════════════════════════════════ */
  function processChannelAlerts() {
    const fresh = [];
    for (const ch of _channels) {
      const lm = ch.lastMessage;
      const t = (lm && lm.timestamp && lm.timestamp.toMillis) ? lm.timestamp.toMillis() : 0;
      const prev = _lastMsgSeen[ch.id] || 0;
      if (t > prev) _lastMsgSeen[ch.id] = t;
      if (!_alertInit) continue;           // baseline pass — never alert on load
      if (!lm || t <= prev) continue;      // nothing new in this channel
      if (lm.authorUid === _user.uid) continue;
      if ((_userMeta?.mutedChannels || []).includes(ch.id)) continue;
      // Only channels I'm in: subscriptions, or DMs I'm a member of
      const isMine = ch.type === 'dm'
        ? (ch.members || []).includes(_user.uid)
        : (_userMeta?.subscribedChannels || []).includes(ch.id);
      if (!isMine) continue;
      // Suppress only when the message is actually IN VIEW: visible
      // tab + that channel's live feed on screen + following the tail
      // (scrolled up = you'd miss it, so alert anyway).
      const feedVisible = document.visibilityState === 'visible'
        && ch.id === _activeChannelId
        && isWatchingFeed();
      if (feedVisible) continue;
      fresh.push(ch.id);
    }
    _alertInit = true;
    if (!fresh.length) return;
    const cardShowing = !!document.getElementById('chat-corner-alert');
    // One popup per burst: a hidden popup respects the cooldown; a
    // visible one just absorbs the new channels.
    if (!cardShowing && Date.now() < _alertCooldownUntil) return;
    fresh.forEach(id => { if (!_alertChannels.includes(id)) _alertChannels.push(id); });
    // Hidden tab: queue instead of showing — otherwise the card fades
    // unseen and burns the cooldown. The visibilitychange handler shows
    // the queued alert the moment the tab returns.
    if (document.visibilityState === 'visible') showCornerAlert();
  }

  function showCornerAlert() {
    const names = _alertChannels.slice(0, 2).map(id => {
      const ch = _channels.find(c => c.id === id);
      return ch ? (ch.type === 'dm' ? getDMDisplayName(ch) : '#' + (ch.displayName || ch.name)) : '';
    }).filter(Boolean);
    const extra = _alertChannels.length > 2 ? ` +${_alertChannels.length - 2}` : '';
    const label = _alertChannels.length === 1
      ? `New message in ${names[0]}`
      : `New messages in ${names.join(', ')}${extra}`;

    let el = document.getElementById('chat-corner-alert');
    if (!el) {
      el = document.createElement('div');
      el.id = 'chat-corner-alert';
      el.className = 'chat-corner-alert';
      el.innerHTML = `
        <button class="chat-corner-alert-body" type="button"></button>
        <button class="chat-corner-alert-close" type="button" title="Dismiss">${svgX()}</button>`;
      document.body.appendChild(el);
      el.querySelector('.chat-corner-alert-body').addEventListener('click', () => {
        // Most recent alerting channel; selectChannel lands on the
        // newest message (open-at-bottom, V3.518)
        const target = _alertChannels[_alertChannels.length - 1];
        hideCornerAlert();
        if (target) selectChannel(target);
      });
      el.querySelector('.chat-corner-alert-close').addEventListener('click', () => hideCornerAlert());
    }
    el.querySelector('.chat-corner-alert-body').innerHTML =
      `${svgChat()} <span>${escHTML(label)}</span>`;
    requestAnimationFrame(() => el.classList.add('chat-corner-alert--show'));
    clearTimeout(_alertTimer);
    _alertTimer = setTimeout(hideCornerAlert, ALERT_AUTOFADE_MS);
  }

  function hideCornerAlert() {
    clearTimeout(_alertTimer);
    const el = document.getElementById('chat-corner-alert');
    if (el) el.remove();
    _alertChannels = [];
    _alertCooldownUntil = Date.now() + ALERT_COOLDOWN_MS;
  }

  // R4 — DM membership self-heal. chatUserMeta is owner-only, so a DM
  // created by someone ELSE can't stamp our dmChannelIds. When the
  // channels snapshot shows a DM listing us as a member that our own
  // meta doesn't track yet, adopt it into our meta ourselves.
  function healDmMemberships() {
    if (!_userMeta || !_user) return;
    const known = new Set(_userMeta.dmChannelIds || []);
    const missing = _channels.filter(c =>
      c.type === 'dm' && Array.isArray(c.members)
      && c.members.includes(_user.uid) && !known.has(c.id));
    if (!missing.length) return;
    const ids = missing.map(c => c.id);
    _userMeta.dmChannelIds = [...(_userMeta.dmChannelIds || []), ...ids];
    _userMeta.subscribedChannels = [...new Set([...(_userMeta.subscribedChannels || []), ...ids])];
    db().collection('chatUserMeta').doc(_user.uid).update({
      dmChannelIds: ARR_UNION(...ids),
      subscribedChannels: ARR_UNION(...ids)
    }).catch(() => {});
  }

  function subscribeReadState() {
    if (_unsubReadState) _unsubReadState();
    // Read all read states for this user
    _unsubReadState = db().collection('chatReadState')
      .where('uid', '==', _user.uid)
      .onSnapshot(snap => {
        _readStates = {};
        snap.docs.forEach(d => {
          const data = d.data();
          _readStates[data.channelId] = data;
        });
        renderSidebar();
      });
  }

  // R7 — everyone's read state for the ACTIVE channel (single-field
  // query, auto-indexed; readable by any signed-in user per the R4
  // rules). Receipts derive from lastReadAt, so a channel open costs
  // exactly ONE write (markChannelRead) instead of up to 21.
  function subscribeChannelReadStates(channelId) {
    if (_unsubChannelReadStates) _unsubChannelReadStates();
    _channelReadStates = {};
    _unsubChannelReadStates = db().collection('chatReadState')
      .where('channelId', '==', channelId)
      .onSnapshot(snap => {
        _channelReadStates = {};
        snap.docs.forEach(d => {
          const data = d.data();
          if (data.uid && data.lastReadAt) _channelReadStates[data.uid] = data.lastReadAt;
        });
        renderMessages(); // receipts update live as others read
      }, err => console.warn('[Chat] channel readState listener error:', err));
  }

  // Readers of msg = anyone (minus the author) whose lastReadAt in this
  // channel is at/after the message's createdAt. Slightly different
  // semantics than the old readBy[] ("read the channel since this
  // message" vs "had it in their last-20 window") — arguably more
  // correct, and it works for ALL historical messages.
  function getSeenByUids(msg) {
    const msgTime = tsToDate(msg.createdAt);
    if (!msgTime) return [];
    return Object.keys(_channelReadStates).filter(uid => {
      if (uid === msg.authorUid) return false;
      const last = tsToDate(_channelReadStates[uid]);
      return last && last >= msgTime;
    });
  }

  // "Seen by everyone" denominator: DM members / channel subscribers
  // (minus the author) — better than the old all-chat-users heuristic.
  function getSeenByDenominator(msg) {
    const ch = _channels.find(c => c.id === (msg.channelId || _activeChannelId));
    if (ch && ch.type === 'dm' && Array.isArray(ch.members)) {
      return ch.members.filter(u => u !== msg.authorUid).length;
    }
    if (ch && Array.isArray(ch.subscriberUids)) {
      return ch.subscriberUids.filter(u => u !== msg.authorUid).length;
    }
    return _allUsers.filter(u => u.uid !== msg.authorUid && canAccessChat(u)).length;
  }

  /* ═══════════════════════════════════════════════════════════
     FIRESTORE — Message Listeners
     ═══════════════════════════════════════════════════════════ */
  function subscribeMessages(channelId) {
    if (_unsubMessages) _unsubMessages();
    _feedMode = 'live';
    _histNewestLoaded = null;
    _histHasNewer = false;
    removeHistoryBanner();
    _messages = [];
    _oldestLoaded = null;
    _hasMoreMessages = true;
    _autoScroll = true;
    subscribeChannelReadStates(channelId); // R7 — receipts source

    _unsubMessages = db().collection('chatMessages')
      .where('channelId', '==', channelId)
      .orderBy('createdAt', 'desc')
      .limit(MSG_PAGE_SIZE)
      .onSnapshot(snap => {
        _messages = snap.docs
          .map(d => ({ id: d.id, ...d.data() }))
          .filter(m => !m.threadParentId) // filter thread replies client-side
          .reverse(); // oldest first for display
        if (_messages.length > 0) {
          _oldestLoaded = _messages[0].createdAt;
        }
        _hasMoreMessages = snap.docs.length >= MSG_PAGE_SIZE;
        renderMessages();
        if (_autoScroll) scrollToBottom();
        markChannelRead(channelId);
      }, err => {
        console.error('Message listener error:', err);
        // Firestore index missing — fall back to unordered query
        if (err.code === 'failed-precondition' || err.message.includes('index')) {
          console.warn('Composite index required. Falling back to unordered fetch. Check console for index creation link.');
          showToast('Creating index — messages may load slowly initially');
          subscribeMessagesFallback(channelId);
        }
      });
  }

  function subscribeMessagesFallback(channelId) {
    // Fallback: no orderBy — sort client-side, but cap to recent messages
    // Used when the composite index hasn't been created yet
    if (_unsubMessages) _unsubMessages();
    _unsubMessages = db().collection('chatMessages')
      .where('channelId', '==', channelId)
      .onSnapshot(snap => {
        let all = snap.docs
          .map(d => ({ id: d.id, ...d.data() }))
          .filter(m => !m.threadParentId)
          .sort((a, b) => {
            const ta = a.createdAt?.toMillis?.() || 0;
            const tb = b.createdAt?.toMillis?.() || 0;
            return ta - tb;
          });
        // Cap to most recent messages to prevent DOM thrashing on large channels
        const hasMore = all.length > MSG_PAGE_SIZE;
        if (hasMore) all = all.slice(-MSG_PAGE_SIZE);
        _messages = all;
        if (_messages.length > 0) {
          _oldestLoaded = _messages[0].createdAt;
        }
        _hasMoreMessages = hasMore;
        renderMessages();
        if (_autoScroll) scrollToBottom();
        markChannelRead(channelId);
      }, err => {
        console.error('Fallback listener also failed:', err);
      });
  }

  async function loadOlderMessages() {
    if (_loadingOlder || !_hasMoreMessages || !_oldestLoaded) return;
    _loadingOlder = true;
    renderMessages();

    const snap = await db().collection('chatMessages')
      .where('channelId', '==', _activeChannelId)
      .orderBy('createdAt', 'desc')
      .startAfter(_oldestLoaded)
      .limit(MSG_PAGE_SIZE)
      .get();

    const older = snap.docs.map(d => ({ id: d.id, ...d.data() })).filter(m => !m.threadParentId).reverse();
    _messages = [...older, ..._messages];
    if (older.length > 0) _oldestLoaded = older[0].createdAt;
    _hasMoreMessages = snap.docs.length >= MSG_PAGE_SIZE;
    _loadingOlder = false;
    renderMessages();
  }

  /* ═══════════════════════════════════════════════════════════
     R6 — JUMP TO MESSAGE + HISTORY MODE
     Single entry point for search results, pinned items, and any
     [data-goto-msg] affordance. Fast path scroll+flash when the target
     is already loaded; otherwise the live listener detaches and a
     window of messages around the target loads (25 before + 25 after).
     ═══════════════════════════════════════════════════════════ */
  const HIST_WINDOW = 25;

  async function jumpToMessage(msgId, channelId) {
    // Make sure the message feed view is what's showing
    if (isMobile()) { _mobileTab = 'chat'; _showPinned = false; }
    else if (_desktopView !== 'chat') _desktopView = 'chat';
    render();

    const inActive = !channelId || channelId === _activeChannelId;
    if (inActive && _messages.some(m => m.id === msgId)) {
      flashMessage(msgId);
      return;
    }

    let doc;
    try { doc = await db().collection('chatMessages').doc(msgId).get(); }
    catch (e) { console.error('jumpToMessage fetch failed', e); }
    if (!doc || !doc.exists) { showToast('Message not found'); return; }
    const target = doc.data();

    // Thread replies live in the side panel: jump to the parent in the
    // channel, then open its thread.
    if (target.threadParentId) {
      await jumpToMessage(target.threadParentId, target.channelId);
      _threadParentId = target.threadParentId;
      subscribeThread(_threadParentId);
      refreshThreadPanel();
      return;
    }

    // Switching channel context for a history jump — no live subscribe.
    if (target.channelId !== _activeChannelId) {
      saveDraft();
      clearTimeout(_typingClearTimer);
      writeTyping(null);
      _activeChannelId = target.channelId;
      _threadParentId = null;
      _threadMessages = [];
      if (_unsubThread) { _unsubThread(); _unsubThread = null; }
      _editingMessageId = null;
      _selectedMsgId = null;
      try { localStorage.setItem(_LAST_CHANNEL_LS_KEY, target.channelId); } catch (e) {}
    }

    await enterHistoryMode(doc);
  }

  async function enterHistoryMode(targetSnap) {
    if (_unsubMessages) { _unsubMessages(); _unsubMessages = null; }
    _feedMode = 'history';
    _autoScroll = false;
    const channelId = targetSnap.data().channelId;
    subscribeChannelReadStates(channelId); // receipts in the window too

    const base = db().collection('chatMessages').where('channelId', '==', channelId);
    let beforeSnap, afterSnap;
    try {
      [beforeSnap, afterSnap] = await Promise.all([
        base.orderBy('createdAt', 'desc').startAfter(targetSnap).limit(HIST_WINDOW).get(),
        base.orderBy('createdAt', 'asc').startAfter(targetSnap).limit(HIST_WINDOW).get()
      ]);
    } catch (e) {
      // Most likely the (channelId ASC, createdAt ASC) composite hasn't
      // finished building — fall back to live mode at the tail.
      console.error('history window query failed', e);
      showToast('Could not open message history');
      transitionToLive(true);
      return;
    }

    const before = beforeSnap.docs.map(d => ({ id: d.id, ...d.data() }))
      .filter(m => !m.threadParentId).reverse();
    const after = afterSnap.docs.map(d => ({ id: d.id, ...d.data() }))
      .filter(m => !m.threadParentId);
    _messages = [...before, { id: targetSnap.id, ...targetSnap.data() }, ...after];
    _oldestLoaded = _messages[0].createdAt;
    _hasMoreMessages = beforeSnap.docs.length >= HIST_WINDOW;
    _histNewestLoaded = afterSnap.docs.length
      ? afterSnap.docs[afterSnap.docs.length - 1] : targetSnap;
    _histHasNewer = afterSnap.docs.length >= HIST_WINDOW;

    _mainContentKey = null; // force the content slot to rebuild for the new context
    render();
    updateHistoryBanner();
    flashMessage(targetSnap.id, true);
  }

  async function loadNewerMessages() {
    if (_feedMode !== 'history' || _loadingNewer || !_histHasNewer || !_histNewestLoaded) return;
    _loadingNewer = true;
    renderMessages();
    let snap;
    try {
      snap = await db().collection('chatMessages')
        .where('channelId', '==', _activeChannelId)
        .orderBy('createdAt', 'asc')
        .startAfter(_histNewestLoaded)
        .limit(MSG_PAGE_SIZE)
        .get();
    } catch (e) {
      console.error('loadNewerMessages failed', e);
      _loadingNewer = false;
      transitionToLive(true);
      return;
    }
    const newer = snap.docs.map(d => ({ id: d.id, ...d.data() })).filter(m => !m.threadParentId);
    _messages = [..._messages, ...newer];
    if (snap.docs.length) _histNewestLoaded = snap.docs[snap.docs.length - 1];
    _histHasNewer = snap.docs.length >= MSG_PAGE_SIZE;
    _loadingNewer = false;
    if (!_histHasNewer) {
      // Caught the tail — hand back to the live listener (which resets
      // _messages to the newest page; visually identical at the tail).
      transitionToLive(false);
    } else {
      renderMessages();
    }
  }

  function transitionToLive(jumpToLatest) {
    removeHistoryBanner();
    _feedMode = 'live';
    _histNewestLoaded = null;
    _histHasNewer = false;
    _loadingNewer = false;
    subscribeMessages(_activeChannelId); // sets _autoScroll = true
    if (!jumpToLatest) _autoScroll = true; // at the tail either way
  }

  function updateHistoryBanner() {
    removeHistoryBanner();
    if (_feedMode !== 'history') return;
    const feed = document.getElementById('chat-feed');
    if (!feed || !feed.parentElement) return;
    const btn = document.createElement('button');
    btn.id = 'chat-history-banner';
    btn.className = 'chat-history-banner';
    btn.innerHTML = `Viewing message history &nbsp;·&nbsp; <strong>Jump to latest ↓</strong>`;
    btn.addEventListener('click', () => transitionToLive(true));
    feed.parentElement.insertBefore(btn, feed);
  }

  function removeHistoryBanner() {
    const b = document.getElementById('chat-history-banner');
    if (b) b.remove();
  }

  function flashMessage(msgId, instant) {
    requestAnimationFrame(() => {
      const el = document.getElementById(`msg-${msgId}`);
      if (!el) return;
      el.scrollIntoView({ behavior: instant ? 'auto' : 'smooth', block: 'center' });
      el.classList.add('chat-msg--jump-flash');
      setTimeout(() => el.classList.remove('chat-msg--jump-flash'), 2000);
    });
  }

  function subscribeThread(parentId) {
    if (_unsubThread) _unsubThread();
    _threadMessages = [];
    _unsubThread = db().collection('chatMessages')
      .where('threadParentId', '==', parentId)
      .orderBy('createdAt', 'asc')
      .onSnapshot(snap => {
        _threadMessages = snap.docs.map(d => ({ id: d.id, ...d.data() }));
        renderThread();
      }, err => {
        // The (threadParentId ASC, createdAt ASC) composite index ships
        // with V3.507 — the old unordered fallback branch is gone.
        console.error('Thread listener error:', err);
      });
  }

  /* ═══════════════════════════════════════════════════════════
     FIRESTORE — CRUD Operations
     ═══════════════════════════════════════════════════════════ */
  function isMobile() {
    return window.innerWidth <= 700;
  }

  function saveDraft() {
    if (!_activeChannelId) return;
    const input = document.getElementById('chat-input');
    if (input) {
      const text = input.value;
      if (text) _drafts[_activeChannelId] = text;
      else delete _drafts[_activeChannelId];
      localStorage.setItem('chat-drafts', JSON.stringify(_drafts));
    }
  }

  function restoreDraft() {
    const input = document.getElementById('chat-input');
    if (input) input.value = _drafts[_activeChannelId] || '';
  }

  function selectChannel(channelId) {
    saveDraft(); // Save draft for current channel before switching
    clearTimeout(_typingClearTimer);
    writeTyping(null); // R5 — don't stay "typing" in the channel we left
    _activeChannelId = channelId;
    _threadParentId = null;
    _threadMessages = [];
    if (_unsubThread) { _unsubThread(); _unsubThread = null; }
    _editingMessageId = null;
    _showEmojiPickerFor = null;
    _mentionQuery = null;
    if (isMobile()) _mobileTab = 'chat';
    // V3.86 — remember last opened channel so the popout (or any
    // chat session) reopens to the same conversation next time.
    try { localStorage.setItem(_LAST_CHANNEL_LS_KEY, channelId); } catch (e) {}
    subscribeMessages(channelId);
    render();
    restoreDraft();
  }

  async function sendMessage(text, file, threadParentId) {
    if (!text.trim() && !file) return;
    if (isChatReadOnly()) { showToast('You have read-only access'); return; }
    const channel = _channels.find(c => c.id === _activeChannelId);
    if (!channel) return;

    // Check announcement-only
    if (channel.isAnnouncement && !isAdmin()) {
      showToast('Only admins can post in announcement channels');
      return;
    }

    const mentions = extractMentions(text);
    const mentionsChannel = text.includes('@channel');
    const photoUrl = _profile?.photo?.thumb || null;

    const msgData = {
      channelId: threadParentId ? _messages.find(m => m.id === threadParentId)?.channelId || _activeChannelId : _activeChannelId,
      authorUid: _user.uid,
      authorName: _profile?.name || _user.displayName || _user.email,
      authorPhoto: photoUrl,
      text: text.trim(),
      type: file ? (file.isImage ? 'file' : 'file') : 'text',
      file: file || null,
      mentions: mentions,
      mentionsChannel: mentionsChannel,
      threadParentId: threadParentId || null,
      threadReplyCount: 0,
      threadLastReplyAt: null,
      reactions: {},
      editedAt: null,
      deleted: false,
      pinned: false,
      // R2 (server fan-out): tells functions/chat.js's onCreate trigger
      // that THIS client does no secondary writes — the function owns
      // mention-badge increments + channel/thread counters. Messages
      // without the flag (stale clients) keep their client-side writes
      // and the function skips them, so no double counting either way.
      fanout: 'v2',
      createdAt: TS()
    };

    // Send = ONE round trip. The channel lastMessage/messageCount bump,
    // thread parent reply counter, and mention fan-out (previously a
    // get+update loop over every mentioned user — @channel hit EVERY
    // lab user) all moved into onChatMessageCreate.
    const ref = await db().collection('chatMessages').add(msgData);

    // Clear draft for this channel after successful send
    delete _drafts[_activeChannelId];
    localStorage.setItem('chat-drafts', JSON.stringify(_drafts));

    return ref;
  }

  async function editMessage(messageId, newText) {
    await db().collection('chatMessages').doc(messageId).update({
      text: newText,
      editedAt: TS()
    });
    _editingMessageId = null;
    renderMessages();
    renderThread(); // exits edit mode when the message lives in the thread panel
  }

  async function deleteMessage(messageId) {
    // Also delete the file from Storage if it exists
    const msg = [..._messages, ..._threadMessages].find(m => m.id === messageId);
    if (msg?.file?.storagePath) {
      try { await firebase.storage().ref().child(msg.file.storagePath).delete(); }
      catch (e) { console.warn('File cleanup failed:', e); }
    }
    await db().collection('chatMessages').doc(messageId).delete();
  }

  async function toggleReaction(messageId, emojiKey) {
    const msg = [..._messages, ..._threadMessages].find(m => m.id === messageId);
    if (!msg) return;
    const reactions = msg.reactions || {};
    const users = reactions[emojiKey] || [];
    const ref = db().collection('chatMessages').doc(messageId);

    if (users.includes(_user.uid)) {
      await ref.update({ [`reactions.${emojiKey}`]: ARR_REMOVE(_user.uid) });
    } else {
      await ref.update({ [`reactions.${emojiKey}`]: ARR_UNION(_user.uid) });
    }
    _showEmojiPickerFor = null;
  }

  async function togglePin(messageId) {
    const msg = _messages.find(m => m.id === messageId);
    if (!msg) return;
    await db().collection('chatMessages').doc(messageId).update({
      pinned: !msg.pinned,
      pinnedBy: msg.pinned ? null : _user.uid,
      pinnedAt: msg.pinned ? null : TS()
    });
  }

  async function createChannel(name, displayName, description, category, isAnnouncement) {
    const slug = name.toLowerCase().replace(/[^a-z0-9-]/g, '-').replace(/-+/g, '-');
    const exists = _channels.find(c => c.name === slug);
    if (exists) { showToast('Channel name already exists'); return; }

    const ref = await db().collection('chatChannels').add({
      name: slug,
      displayName: displayName || slug,
      description: description || '',
      category: category,
      type: 'channel',
      createdBy: _user.uid,
      isDefault: false,
      isAnnouncement: isAnnouncement && isAdmin(),
      pinnedMessageIds: [],
      lastMessage: null,
      lastActivityAt: TS(),
      memberCount: 1,
      messageCount: 0,
      subscriberUids: [], // filled by subscribeToChannel below
      createdAt: TS()
    });

    // Subscribe creator to new channel
    await subscribeToChannel(ref.id);
    _showCreateChannel = false;
    selectChannel(ref.id);
    showToast(`#${slug} created`);
  }

  async function createDM(targetUids) {
    // Sort uids for consistent lookup
    const memberUids = [_user.uid, ...targetUids].sort();
    const dmName = memberUids.join('_');

    // Check if DM already exists
    const existing = _channels.find(c => c.type === 'dm' && c.name === dmName);
    if (existing) {
      selectChannel(existing.id);
      _showNewDM = false;
      return;
    }

    const memberNames = memberUids.map(uid => {
      const u = _allUsers.find(a => a.uid === uid);
      return u ? (u.name || u.displayName || u.email) : uid;
    });

    const ref = await db().collection('chatChannels').add({
      name: dmName,
      displayName: memberNames.filter(n => n !== (_profile?.name || _user.displayName)).join(', '),
      description: '',
      category: '',
      type: 'dm',
      createdBy: _user.uid,
      members: memberUids,
      isDefault: false,
      isAnnouncement: false,
      pinnedMessageIds: [],
      lastMessage: null,
      lastActivityAt: TS(),
      memberCount: memberUids.length,
      messageCount: 0,
      createdAt: TS()
    });

    // Subscribe SELF only — chatUserMeta is owner-only in rules, so the
    // old loop's cross-user get/update always failed for other members.
    // Each other member adopts the DM via healDmMemberships() when their
    // own channels snapshot delivers it (R4).
    await db().collection('chatUserMeta').doc(_user.uid).update({
      subscribedChannels: ARR_UNION(ref.id),
      dmChannelIds: ARR_UNION(ref.id)
    });

    // Update local meta
    if (!_userMeta.dmChannelIds) _userMeta.dmChannelIds = [];
    _userMeta.dmChannelIds.push(ref.id);
    _userMeta.subscribedChannels.push(ref.id);

    _showNewDM = false;
    selectChannel(ref.id);
  }

  async function subscribeToChannel(channelId) {
    if (_userMeta.subscribedChannels.includes(channelId)) return;
    _userMeta.subscribedChannels.push(channelId);

    // Add to first sidebar group or create ungrouped
    if (_userMeta.sidebarLayout.length > 0) {
      _userMeta.sidebarLayout[0].channelIds.push(channelId);
    } else {
      _userMeta.sidebarLayout = [{ groupName: 'Channels', channelIds: [channelId] }];
    }

    await db().collection('chatUserMeta').doc(_user.uid).update({
      subscribedChannels: ARR_UNION(channelId),
      sidebarLayout: _userMeta.sidebarLayout
    });

    // Increment member count + join the channel's authoritative
    // subscriber list (R2 — the Cloud Function reads subscriberUids to
    // target notifications/mentions instead of scanning chatUserMeta).
    const ch = _channels.find(c => c.id === channelId);
    if (ch) {
      await db().collection('chatChannels').doc(channelId).update({
        memberCount: firebase.firestore.FieldValue.increment(1),
        subscriberUids: ARR_UNION(_user.uid)
      });
    }

    renderSidebar();
  }

  async function unsubscribeFromChannel(channelId) {
    _userMeta.subscribedChannels = _userMeta.subscribedChannels.filter(id => id !== channelId);
    _userMeta.sidebarLayout.forEach(g => {
      g.channelIds = g.channelIds.filter(id => id !== channelId);
    });
    // Remove empty groups
    _userMeta.sidebarLayout = _userMeta.sidebarLayout.filter(g => g.channelIds.length > 0);

    await db().collection('chatUserMeta').doc(_user.uid).update({
      subscribedChannels: ARR_REMOVE(channelId),
      sidebarLayout: _userMeta.sidebarLayout
    });

    await db().collection('chatChannels').doc(channelId).update({
      memberCount: firebase.firestore.FieldValue.increment(-1),
      subscriberUids: ARR_REMOVE(_user.uid)
    });

    renderSidebar();
  }

  async function markChannelRead(channelId) {
    if (_feedMode !== 'live') return; // history windows never mark read
    const stateId = `${_user.uid}_${channelId}`;
    const ch = _channels.find(c => c.id === channelId);
    const currentCount = ch?.messageCount || 0;
    await db().collection('chatReadState').doc(stateId).set({
      uid: _user.uid,
      channelId: channelId,
      lastReadAt: TS(),
      lastReadMessageId: _messages.length > 0 ? _messages[_messages.length - 1].id : null,
      readMessageCount: currentCount,
      mentionCount: 0
    }, { merge: true });
    // R7 — that single write above IS the read receipt now. The old
    // updateReadReceipts() batch (readBy arrayUnion on up to 20 message
    // docs, per user, per channel open) is gone; receipts derive from
    // lastReadAt via getSeenByUids(). Historical readBy arrays are
    // simply ignored — no migration.
  }

  async function saveConfig(updates) {
    Object.assign(_config, updates);
    await db().collection('chatConfig').doc('settings').update(updates);
    showToast('Settings saved');
  }

  async function saveDmContacts() {
    await db().collection('chatUserMeta').doc(_user.uid).update({
      dmContacts: _userMeta.dmContacts || []
    });
  }

  async function saveSidebarLayout() {
    await db().collection('chatUserMeta').doc(_user.uid).update({
      sidebarLayout: _userMeta.sidebarLayout
    });
  }

  /* ═══════════════════════════════════════════════════════════
     MENTIONS
     ═══════════════════════════════════════════════════════════ */
  function extractMentions(text) {
    const mentions = [];
    const regex = /@(\w[\w.-]*)/g;
    let match;
    while ((match = regex.exec(text)) !== null) {
      const name = match[1].toLowerCase();
      if (name === 'channel') continue;
      const user = _allUsers.find(u =>
        (u.name || '').toLowerCase().replace(/\s+/g, '.') === name ||
        (u.name || '').toLowerCase().replace(/\s+/g, '') === name ||
        (u.displayName || '').toLowerCase().replace(/\s+/g, '.') === name ||
        (u.email || '').split('@')[0].toLowerCase() === name
      );
      if (user && !mentions.includes(user.uid)) mentions.push(user.uid);
    }
    return mentions;
  }

  function getMentionSuggestions(query) {
    if (!query) return _allUsers.filter(u => u.uid !== _user.uid).slice(0, 8);
    const q = query.toLowerCase();
    return _allUsers
      .filter(u => u.uid !== _user.uid && (
        (u.name || '').toLowerCase().includes(q) ||
        (u.displayName || '').toLowerCase().includes(q) ||
        (u.email || '').toLowerCase().includes(q)
      ))
      .slice(0, 8);
  }

  /* ═══════════════════════════════════════════════════════════
     MARKDOWN
     ═══════════════════════════════════════════════════════════ */
  function parseMarkdown(text) {
    if (!text) return '';
    let html = escHTML(text);
    // Code blocks (triple backtick)
    html = html.replace(/```([\s\S]*?)```/g, '<pre class="chat-code-block">$1</pre>');
    // Inline code
    html = html.replace(/`([^`]+)`/g, '<code class="chat-code-inline">$1</code>');
    // Bold
    html = html.replace(/\*([^*]+)\*/g, '<strong>$1</strong>');
    // Italic
    html = html.replace(/_([^_]+)_/g, '<em>$1</em>');
    // Links
    html = html.replace(/(https?:\/\/[^\s<]+)/g, '<a href="$1" target="_blank" rel="noopener">$1</a>');
    // @mentions highlighting
    html = html.replace(/@([\w.-]+)/g, (match, name) => {
      if (name === 'channel') return `<span class="chat-mention chat-mention--channel">@channel</span>`;
      const user = _allUsers.find(u =>
        (u.name || '').toLowerCase().replace(/\s+/g, '.') === name.toLowerCase() ||
        (u.name || '').toLowerCase().replace(/\s+/g, '') === name.toLowerCase()
      );
      if (user) return `<span class="chat-mention">@${escHTML(user.name || name)}</span>`;
      return match;
    });
    // Newlines
    html = html.replace(/\n/g, '<br>');
    return html;
  }

  /* ═══════════════════════════════════════════════════════════
     FILE UPLOAD (Firebase Storage)
     Any authenticated lab member can upload — no extra sign-in.
     Files stored at chat/{channelName}/{timestamp}_{filename}
     ═══════════════════════════════════════════════════════════ */
  async function uploadFile(file) {
    _uploadingFile = true;
    renderInputArea();
    showToast('Uploading file...');

    try {
      const channel = _channels.find(c => c.id === _activeChannelId);
      const folder = channel ? (channel.type === 'dm' ? 'direct-messages' : channel.name) : 'general';
      const safeName = file.name.replace(/[^a-zA-Z0-9._-]/g, '_');
      const path = `chat/${folder}/${Date.now()}_${safeName}`;
      const ref = firebase.storage().ref().child(path);

      const snap = await ref.put(file);
      const downloadUrl = await snap.ref.getDownloadURL();

      const isImage = (file.type || '').startsWith('image/');
      showToast('File uploaded');

      return {
        url: downloadUrl,
        storagePath: path,
        name: file.name,
        size: file.size,
        contentType: file.type,
        isImage: isImage
      };
    } catch (err) {
      console.error('Upload error:', err);
      showToast('File upload failed: ' + (err.message || 'Unknown error'));
      return null;
    } finally {
      _uploadingFile = false;
      renderInputArea();
    }
  }

  /* ═══════════════════════════════════════════════════════════
     NOTIFICATIONS
     ═══════════════════════════════════════════════════════════ */
  function requestNotificationPermission() {
    if ('Notification' in window && Notification.permission === 'default') {
      Notification.requestPermission();
    }
  }

  function showBrowserNotification(title, body) {
    if (!document.hidden) return;
    if ('Notification' in window && Notification.permission === 'granted') {
      new Notification(title, { body, icon: '../../Images/mission/logo.png' });
    }
  }

  /* ═══════════════════════════════════════════════════════════
     SEARCH (R6 — progressive full-history scan)
     The old search only substring-filtered the ≤50 loaded messages.
     This pages backward through chatMessages (200/batch, existing
     indexes: channel scope uses (channelId, createdAt DESC); all-
     channels is a plain orderBy), filters client-side, streams results
     into the modal, and caches scanned docs per scope so refining the
     query re-filters without re-reading. A full 2,000-message channel
     scan costs ~$0.001 — the right trade at lab scale vs. maintaining
     a keyword index on every write.
     ═══════════════════════════════════════════════════════════ */
  const SEARCH_BATCH = 200;
  const SEARCH_TARGET_RESULTS = 20;
  const SEARCH_MAX_DOCS_PER_RUN = 2000;

  function messageMatches(m, q) {
    return (m.text || '').toLowerCase().includes(q) ||
      (m.authorName || '').toLowerCase().includes(q) ||
      (m.file && m.file.name && m.file.name.toLowerCase().includes(q));
  }

  function searchCacheFor(scope) {
    const channelKey = scope === 'channel' ? _activeChannelId : '*';
    if (_searchCache.scope !== scope || _searchCache.channelKey !== channelKey) {
      _searchCache = { scope, channelKey, docs: [], cursorSnap: null, exhausted: false };
    }
    return _searchCache;
  }

  async function runProgressiveSearch(query, extend) {
    const gen = ++_searchScanGen;
    const q = (query || '').trim().toLowerCase();
    if (!q) { renderSearchResults([], '', false); return; }
    const cache = searchCacheFor(_searchScope);
    const results = cache.docs.filter(m => messageMatches(m, q));
    const target = extend ? results.length + SEARCH_TARGET_RESULTS
      : Math.max(results.length, SEARCH_TARGET_RESULTS);
    renderSearchResults(results, `Searched ${cache.docs.length} messages · ${results.length} results…`, !cache.exhausted);

    let scanned = 0;
    while (gen === _searchScanGen && !cache.exhausted
           && results.length < target && scanned < SEARCH_MAX_DOCS_PER_RUN) {
      let ref = db().collection('chatMessages');
      if (_searchScope === 'channel') ref = ref.where('channelId', '==', _activeChannelId);
      ref = ref.orderBy('createdAt', 'desc');
      if (cache.cursorSnap) ref = ref.startAfter(cache.cursorSnap);
      let snap;
      try { snap = await ref.limit(SEARCH_BATCH).get(); }
      catch (e) { console.error('search batch failed', e); break; }
      if (gen !== _searchScanGen) return; // superseded by a newer keystroke
      if (snap.docs.length) cache.cursorSnap = snap.docs[snap.docs.length - 1];
      if (snap.docs.length < SEARCH_BATCH) cache.exhausted = true;
      const batch = snap.docs.map(d => ({ id: d.id, ...d.data() }));
      cache.docs.push(...batch);
      scanned += batch.length;
      results.push(...batch.filter(m => messageMatches(m, q)));
      renderSearchResults(results, `Searched ${cache.docs.length} messages · ${results.length} results…`, !cache.exhausted);
    }
    if (gen === _searchScanGen) {
      const n = results.length;
      renderSearchResults(results,
        `Searched ${cache.docs.length} messages · ${n} result${n === 1 ? '' : 's'}${cache.exhausted ? ' · full history' : ''}`,
        !cache.exhausted);
    }
  }

  function renderSearchResults(results, status, hasMore) {
    const statusEl = document.getElementById('chat-search-status');
    if (statusEl) statusEl.textContent = status;
    const container = document.getElementById('chat-search-results');
    if (!container) return;
    const rows = results.map(m => {
      const ch = _channels.find(c => c.id === m.channelId);
      const chName = ch ? (ch.type === 'dm' ? getDMDisplayName(ch) : '#' + (ch.displayName || ch.name)) : '';
      const d = tsToDate(m.createdAt);
      const abs = d
        ? d.toLocaleDateString([], { month: 'short', day: 'numeric', year: 'numeric' }) + ' ' + formatClockTime(m.createdAt)
        : '';
      return `<div class="chat-search-result" data-goto-msg="${m.id}" data-goto-channel="${escHTML(m.channelId || '')}">
        <div class="chat-search-result-meta">
          <span class="chat-msg-author">${escHTML(m.authorName)}</span>
          ${chName ? `<span class="chat-search-result-channel">${escHTML(chName)}</span>` : ''}
          <span class="chat-msg-time">${abs}</span>
        </div>
        <div class="chat-msg-text">${parseMarkdown(m.text)}</div>
      </div>`;
    }).join('');
    container.innerHTML = `
      ${results.length === 0 && _searchQuery.trim() ? `<p class="chat-muted">No results${hasMore ? ' yet' : ''}.</p>` : ''}
      ${rows}
      ${hasMore && _searchQuery.trim() ? '<button class="chat-load-more" id="chat-search-older">Search older messages</button>' : ''}`;
  }

  /* ═══════════════════════════════════════════════════════════
     RENDERING — Main Layout
     ═══════════════════════════════════════════════════════════ */
  // Desktop view tab: which panel the main area shows
  let _desktopView = 'chat'; // 'chat' | 'files'

  /* V3.503 — incremental rendering. renderShell() mounts the stable
   * skeleton once per layout mode; render() only refreshes region
   * contents. All clicks are handled by ONE delegated listener
   * (wireDelegatedClicks), so updaters never re-wire click handlers —
   * only region-scoped non-click wiring (inputs, drag-drop, scroll)
   * re-attaches when its region rebuilds. Slot wrappers use
   * `display: contents` (.chat-slot) so the CSS layout tree is
   * unchanged from the pre-shell markup. */
  function renderShell() {
    _shellMode = isMobile() ? 'mobile' : 'desktop';
    _mainContentKey = null;
    if (_shellMode === 'mobile') {
      // V3.86 — in embed mode (rendering inside a shell popout), skip
      // the page-title top bar and the cross-app bottom bar; they're
      // designed for full-screen mobile and just steal vertical space.
      appEl.innerHTML = `
        <div id="chat-mobile-topbar-slot" class="chat-slot"></div>
        <nav class="chat-tab-bar" id="chat-tab-bar">
          ${['overview','chat','files','search'].map(t =>
            `<button class="chat-tab" data-chat-tab="${t}">${({overview:'Overview',chat:'Chat',files:'Files',search:'Search'})[t]}</button>`
          ).join('')}
        </nav>
        <div id="chat-callring-slot" class="chat-slot"></div>
        <div class="chat-layout" id="chat-mobile-content"></div>
        <div id="chat-mobile-bottombar-slot" class="chat-slot"></div>
        <div id="chat-hamburger-slot" class="chat-slot"></div>
        <div id="chat-modal-root" class="chat-slot"></div>
      `;
    } else {
      // Classic desktop: sidebar + main + thread
      appEl.innerHTML = `
        <div class="chat-layout" id="chat-layout">
          <div class="chat-sidebar-overlay" id="chat-sidebar-overlay"></div>
          <aside class="chat-sidebar" id="chat-sidebar"></aside>
          <section class="chat-main">
            <div class="chat-sticky-top">
              <div id="chat-callring-slot" class="chat-slot"></div>
              <div id="chat-header-slot" class="chat-slot"></div>
              <div id="chat-view-tabs-slot" class="chat-slot"></div>
            </div>
            <div id="chat-content-slot" class="chat-slot"></div>
          </section>
          <div id="chat-thread-slot" class="chat-slot"></div>
        </div>
        <div id="chat-modal-root" class="chat-slot"></div>
      `;
    }
  }

  function render() {
    if (typeof McgheeLab !== 'undefined' && McgheeLab.MobileShell?.saveTabScroll) McgheeLab.MobileShell.saveTabScroll('chat-tab-bar');
    if (typeof McgheeLab !== 'undefined' && McgheeLab.MobileShell?.getHandPreference) {
      document.body.dataset.hand = McgheeLab.MobileShell.getHandPreference();
    }
    const mode = isMobile() ? 'mobile' : 'desktop';
    if (mode !== _shellMode) renderShell();
    const channel = _channels.find(c => c.id === _activeChannelId);

    if (mode === 'mobile') {
      updateMobileTopBar();
      updateMobileTabBar();
      updateMobileContent(channel);
      updateMobileBottomBar();
      updateHamburger();
    } else {
      const layoutEl = document.getElementById('chat-layout');
      if (layoutEl) layoutEl.classList.toggle('chat-sidebar-open', _mobileSidebarOpen);
      renderSidebar();
      updateHeader(channel);
      updateViewTabs();
      updateMainContent();
      updateThread();
    }
    updateCallRing();
    updateModals();
    updatePresenceUI();
    updateStickyOffsets();
    notifyResize();
    requestNotificationPermission();
    // V3.599 — LAST, not first: isWatchingFeed() reads _shellMode, which
    // renderShell() assigns partway through this function. Publishing at the
    // top read a stale/null _shellMode on the first render of a mount.
    // Every state change that can flip isWatchingFeed() re-renders, and
    // setContext dedupes, so this one call covers all of them.
    publishPresenceContext();
  }

  /* Sticky chat chrome (Alex request) — the channel header + view tabs
   * (desktop) / tab bar + channel header (mobile) pin below RM's sticky
   * .top-nav while the DOCUMENT scrolls (the page's real scroller, see
   * pinFeedToBottom). Offsets are measured, not hardcoded: the nav is
   * absent in embed popouts and its height shifts across breakpoints.
   * --chat-chrome-b = bottom edge of all pinned chrome, used by the
   * date separators + history banner so they stack beneath it. */
  function updateStickyOffsets() {
    const navH = document.querySelector('.top-nav')?.offsetHeight || 0;
    const tabH = document.getElementById('chat-tab-bar')?.offsetHeight || 0;
    const style = document.documentElement.style;
    style.setProperty('--chat-nav-h', navH + 'px');
    style.setProperty('--chat-nav-tab-h', (navH + tabH) + 'px');
    const chromeBottom = _shellMode === 'mobile'
      ? navH + tabH + (appEl.querySelector('.chat-main .chat-header')?.offsetHeight || 0)
      : navH + (appEl.querySelector('.chat-sticky-top')?.offsetHeight || 0);
    style.setProperty('--chat-chrome-b', chromeBottom + 'px');
  }

  /* ── Desktop region updaters ── */
  function updateHeader(channel) {
    const slot = document.getElementById('chat-header-slot');
    if (!slot) return;
    const ch = channel !== undefined ? channel : _channels.find(c => c.id === _activeChannelId);
    slot.innerHTML = renderHeaderHTML(ch);
  }

  /* ── Incoming-call banner (V3.584) ──
   * The answer surface for a voice call: inline bar pinned with the chat
   * chrome (desktop sticky-top / above mobile content) with Join +
   * Decline. Pulses ("ringing") for the first RING window of a call,
   * then calms to a "call in progress" bar. VOICE_CALL owns which calls
   * are answerable (excludes own/joined/declined/dismissed); chat owns
   * membership — only ring for DMs I'm in / channels I subscribe to,
   * mirroring who the FCM push targets. */
  const CALL_RING_MS = 60000;
  let _callRingTimer = null;
  const _onVoiceCallChange = () => { updateHeader(); updateCallRing(); };

  /* Who the call's audience is — the SAME split functions/chat.js uses for
     push (DM: members[], channel: subscriberUids[]). Passed to
     VOICE_CALL.open so the call doc carries `memberUids`, which
     firestore.rules uses to scope the active-call watcher query. */
  function callMemberUids(ch) {
    if (!ch) return [];
    if (ch.type === 'dm') return (ch.members || []).slice();
    if (Array.isArray(ch.subscriberUids)) return ch.subscriberUids.slice();
    return (_userMeta?.subscribedChannels || []).includes(ch.id) && _user
      ? [_user.uid] : [];
  }

  function amRecipientOfCall(call) {
    const ch = _channels.find(c => c.id === call.id);
    if (!ch || !_user) return false;
    if (ch.type === 'dm') return (ch.members || []).includes(_user.uid);
    if (Array.isArray(ch.subscriberUids)) return ch.subscriberUids.includes(_user.uid);
    return (_userMeta?.subscribedChannels || []).includes(ch.id);
  }

  function channelLabelFor(channelId, call) {
    const ch = _channels.find(c => c.id === channelId);
    if (ch) return ch.type === 'dm' ? getDMDisplayName(ch) : `#${ch.displayName || ch.name}`;
    return (call && call.channelName) || channelId;
  }

  function renderCallRingHTML() {
    if (!window.VOICE_CALL?.getIncomingCalls) return '';
    const calls = VOICE_CALL.getIncomingCalls().filter(amRecipientOfCall);
    return calls.map(call => {
      const startMs = call.startedAt?.toMillis ? call.startedAt.toMillis() : Date.now();
      const ringing = Date.now() - startMs < CALL_RING_MS;
      const label = channelLabelFor(call.id, call);
      return `<div class="chat-callring${ringing ? ' chat-callring--ringing' : ''}">
        <span class="chat-callring-icon">📞</span>
        <span class="chat-callring-text"><strong>${escHTML(call.startedByName || 'Someone')}</strong>
          ${ringing ? 'is calling' : 'started a call'} · <strong>${escHTML(label)}</strong></span>
        <span class="chat-callring-actions">
          <button class="chat-callring-btn chat-callring-btn--join" data-vc-ring-join="${escHTML(call.id)}">Join</button>
          <button class="chat-callring-btn chat-callring-btn--decline" data-vc-ring-decline="${escHTML(call.id)}">Decline</button>
        </span>
      </div>`;
    }).join('');
  }

  function updateCallRing() {
    const slot = document.getElementById('chat-callring-slot');
    if (!slot) return;
    slot.innerHTML = renderCallRingHTML();
    updateStickyOffsets(); // banner changes the pinned-chrome height

    // One re-render at the moment the newest ringing banner calms down.
    clearTimeout(_callRingTimer);
    _callRingTimer = null;
    if (window.VOICE_CALL?.getIncomingCalls) {
      const now = Date.now();
      const remaining = VOICE_CALL.getIncomingCalls().filter(amRecipientOfCall)
        .map(c => (c.startedAt?.toMillis ? c.startedAt.toMillis() : now) + CALL_RING_MS - now)
        .filter(ms => ms > 0);
      if (remaining.length) {
        _callRingTimer = setTimeout(updateCallRing, Math.max(...remaining) + 250);
      }
    }
  }

  function updateViewTabs() {
    const slot = document.getElementById('chat-view-tabs-slot');
    if (slot) slot.innerHTML = renderDesktopViewTabs();
  }

  function updateMainContent() {
    const slot = document.getElementById('chat-content-slot');
    if (!slot) return;
    const key = `${_desktopView}:${_activeChannelId}`;
    if (key === _mainContentKey) {
      // Same view + channel — refresh contents in place (keeps scroll,
      // composer focus + text).
      if (_desktopView === 'chat') { renderMessages(); renderInputArea(); }
      else if (_desktopView === 'pinned') slot.innerHTML = renderPinnedPageHTML();
      else if (_desktopView === 'files') slot.innerHTML = renderFilesTabHTML();
      return;
    }
    _mainContentKey = key;
    if (_desktopView === 'chat') {
      slot.innerHTML = `
        <div class="chat-feed" id="chat-feed"></div>
        <div class="chat-typing-row" id="chat-typing-row"></div>
        ${renderInputAreaHTML()}`;
      renderMessages();
      wireInput();
      wireFeedScroll();
      wireFileDrop();
      updateTypingRow();
      if (_autoScroll) scrollToBottom();
    } else if (_desktopView === 'pinned') {
      slot.innerHTML = renderPinnedPageHTML();
    } else {
      slot.innerHTML = renderFilesTabHTML();
    }
  }

  function updateThread() {
    const slot = document.getElementById('chat-thread-slot');
    if (!slot) return;
    const html = _threadParentId ? renderThreadHTML() : '';
    slot.innerHTML = html;
    if (html) {
      wireThreadInput();
      const feed = document.getElementById('chat-thread-feed');
      if (feed) feed.scrollTop = feed.scrollHeight;
    }
  }

  // Thread lives in the desktop slot OR inside the mobile chat tab —
  // route the refresh to whichever shell is mounted. Desktop gets a
  // targeted slot update (feed scroll untouched — no save/restore hack).
  function refreshThreadPanel() {
    if (_shellMode === 'mobile') updateMobileContent();
    else updateThread();
  }

  /* ── Mobile region updaters ── */
  function updateMobileTopBar() {
    const slot = document.getElementById('chat-mobile-topbar-slot');
    if (slot) slot.innerHTML = _IS_EMBED ? '' : renderMobileTopBarHTML();
  }

  function updateMobileTabBar() {
    const bar = document.getElementById('chat-tab-bar');
    if (!bar) return;
    bar.querySelectorAll('[data-chat-tab]').forEach(btn => {
      btn.classList.toggle('chat-tab--active', btn.dataset.chatTab === _mobileTab);
    });
    if (McgheeLab.MobileShell?.centerActiveTab) {
      McgheeLab.MobileShell.centerActiveTab(bar, '.chat-tab--active');
    }
  }

  function updateMobileContent(channel) {
    const slot = document.getElementById('chat-mobile-content');
    if (!slot) return;
    const ch = channel !== undefined ? channel : _channels.find(c => c.id === _activeChannelId);
    // Preserve scroll when re-rendering the chat tab in place (e.g.
    // opening/closing a thread). V3.522: the DOCUMENT is the real
    // scroller, so capture/restore the page position, not the feed's.
    const oldFeed = document.getElementById('chat-feed');
    const keep = (_mobileTab === 'chat' && oldFeed)
      ? { top: pageScroller().scrollTop, auto: _autoScroll } : null;
    slot.innerHTML = renderMobileTabContent(ch);
    if (_mobileTab === 'chat') {
      wireInput();
      wireFeedScroll();
      wireFileDrop();
      wireThreadInput();
      updateTypingRow();
      const feed = document.getElementById('chat-feed');
      if (feed) {
        _isRendering = true;
        if (keep && !keep.auto) pageScroller().scrollTop = keep.top;
        else pinFeedToBottom();
        _isRendering = false;
      }
    }
  }

  function updateMobileBottomBar() {
    const slot = document.getElementById('chat-mobile-bottombar-slot');
    if (slot) slot.innerHTML = _IS_EMBED ? '' : renderMobileBottomBarHTML();
  }

  function updateHamburger() {
    const slot = document.getElementById('chat-hamburger-slot');
    if (slot) slot.innerHTML = _mobileHamburgerOpen ? renderMobileHamburgerMenuHTML() : '';
  }

  function updateModals() {
    const root = document.getElementById('chat-modal-root');
    if (!root) return;
    root.innerHTML = renderModals();
    wireModalsNonClick();
  }

  function renderModals() {
    return `
      ${_showChannelDirectory ? renderChannelDirectoryHTML() : ''}
      ${_showCreateChannel ? renderCreateChannelHTML() : ''}
      ${_showSettings ? renderSettingsHTML() : ''}
      ${(_showSearch && !isMobile()) ? renderSearchHTML() : ''}
      ${_showNewDM ? renderNewDMHTML() : ''}
      ${_showManageContacts ? renderManageContactsHTML() : ''}
      ${_showSeenBy ? renderSeenByHTML() : ''}
      ${_showImport ? renderImportHTML() : ''}`;
  }

  function renderDesktopViewTabs() {
    const pinnedCount = _messages.filter(m => m.pinned).length;
    const tabs = [
      { id: 'chat', label: 'Messages' },
      { id: 'pinned', label: `Pinned${pinnedCount > 0 ? ' (' + pinnedCount + ')' : ''}` },
      { id: 'files', label: 'Files' }
    ];
    return `<div class="chat-view-tabs" id="chat-view-tabs">
      ${tabs.map(t => `<button class="chat-view-tab${_desktopView === t.id ? ' chat-view-tab--active' : ''}" data-view-tab="${t.id}">${t.label}</button>`).join('')}
      <button class="chat-icon-btn" id="chat-header-search" title="Search">${svgSearch()}</button>
    </div>`;
  }

  function renderMobileTabContent(channel) {
    switch (_mobileTab) {
      case 'overview':
        return `<div class="chat-mobile-overview" id="chat-mobile-overview">
          ${renderMobileOverviewHTML()}
        </div>`;
      case 'chat':
        return `
          <section class="chat-main" style="display:flex;flex:1;flex-direction:column">
            ${renderHeaderHTML(channel)}
            ${_showPinned ? renderPinnedPageHTML() : `
              <div class="chat-feed" id="chat-feed">
                ${_messages.length === 0 ? '<div class="chat-empty">No messages yet. Start the conversation!</div>' : ''}
                ${_hasMoreMessages ? '<button class="chat-load-more" id="chat-load-more">Load older messages</button>' : ''}
                ${_loadingOlder ? '<div class="chat-loading">Loading...</div>' : ''}
                ${renderMessagesHTML()}
              </div>
              <div class="chat-typing-row" id="chat-typing-row"></div>
              ${renderInputAreaHTML()}
            `}
          </section>
          ${_threadParentId ? renderThreadHTML() : ''}`;
      case 'files':
        return renderFilesTabHTML();
      case 'search':
        // V3.569 — inline search in the tab (no modal). Uses the same ids
        // the search logic binds (chat-search-input / -status / -results).
        return `<section class="chat-main chat-mobile-search" style="display:flex;flex:1;flex-direction:column">
          <div class="chat-search-controls">
            <input class="app-input" id="chat-search-input" placeholder="Search all history…" value="${escHTML(_searchQuery)}" />
            <div class="chat-search-scope">
              <button class="chat-search-scope-btn${_searchScope === 'channel' ? ' chat-search-scope-btn--active' : ''}" data-search-scope="channel">This channel</button>
              <button class="chat-search-scope-btn${_searchScope === 'all' ? ' chat-search-scope-btn--active' : ''}" data-search-scope="all">All channels</button>
            </div>
          </div>
          <div class="chat-search-status" id="chat-search-status"></div>
          <div class="chat-search-results" id="chat-search-results"></div>
        </section>`;
      default:
        return '';
    }
  }

  function renderFilesTabHTML() {
    const filesInChannel = _messages.filter(m => m.file);
    const groups = { images: [], documents: [], other: [] };
    filesInChannel.forEach(m => {
      const f = m.file;
      const ext = (f.name || '').split('.').pop().toLowerCase();
      const imageExts = ['jpg', 'jpeg', 'png', 'gif', 'webp', 'svg', 'bmp'];
      const docExts = ['pdf', 'doc', 'docx', 'xls', 'xlsx', 'ppt', 'pptx', 'txt', 'csv'];
      if (f.isImage || imageExts.includes(ext)) groups.images.push({ file: f, msg: m });
      else if (docExts.includes(ext)) groups.documents.push({ file: f, msg: m });
      else groups.other.push({ file: f, msg: m });
    });

    const renderGroup = (title, items) => {
      if (items.length === 0) return '';
      return `<div class="chat-files-group">
        <div class="chat-files-group-title">${title} (${items.length})</div>
        ${items.map(({ file: f, msg }) => {
          const isImg = f.isImage || ['jpg','jpeg','png','gif','webp','svg'].includes((f.name||'').split('.').pop().toLowerCase());
          return `<a class="chat-files-item" href="${escHTML(f.url || f.driveUrl || '#')}" target="_blank" rel="noopener">
            <div class="chat-files-icon${isImg ? ' chat-files-icon--image' : ''}">${isImg && f.thumbnailUrl ? `<img src="${escHTML(f.thumbnailUrl)}" alt="" />` : svgFile()}</div>
            <div class="chat-files-info">
              <div class="chat-files-name">${escHTML(f.name || 'Untitled')}</div>
              <div class="chat-files-meta">${escHTML(msg.authorName)} &middot; ${formatTimestamp(msg.createdAt)}${f.size ? ' &middot; ' + formatFileSize(f.size) : ''}</div>
            </div>
          </a>`;
        }).join('')}
      </div>`;
    };

    const html = renderGroup('Images', groups.images) + renderGroup('Documents', groups.documents) + renderGroup('Other', groups.other);
    return `<div class="chat-files-view" style="display:flex;flex:1">
      ${html || '<div class="chat-files-empty">No files shared in this conversation yet.</div>'}
    </div>`;
  }

  /* ═══════════════════════════════════════════════════════════
     RENDERING — Sidebar
     ═══════════════════════════════════════════════════════════ */
  function renderSidebarHTML() {
    if (!_userMeta) return '<div class="chat-loading">Loading...</div>';

    const layout = _userMeta.sidebarLayout || [];
    const subscribedSet = new Set(_userMeta.subscribedChannels || []);

    let html = `<div class="chat-sidebar-header">
      <button class="chat-sidebar-close" id="chat-sidebar-close">${svgX()}</button>
      <span class="chat-sidebar-title">Lab Chat</span>
      ${isAdmin() ? `<button class="chat-icon-btn" id="chat-settings-btn" title="Settings">${svgSettings()}</button>` : ''}
    </div>`;

    // Subscribed channel groups
    for (let gi = 0; gi < layout.length; gi++) {
      const group = layout[gi];
      html += `<div class="chat-sidebar-group" data-group="${gi}">
        <div class="chat-sidebar-group-header">
          <span class="chat-sidebar-group-name" contenteditable="true" data-group="${gi}">${escHTML(group.groupName)}</span>
        </div>`;
      for (const chId of group.channelIds) {
        const ch = _channels.find(c => c.id === chId);
        if (!ch || ch.type === 'dm') continue;
        const active = chId === _activeChannelId ? ' chat-sidebar-item--active' : '';
        const unread = getUnreadCount(chId);
        const mentionCount = _readStates[chId]?.mentionCount || 0;
        const hasUnreadEdit = ch.lastMessage?.editedAt && _readStates[chId]?.lastReadAt && ch.lastMessage.editedAt.toDate && _readStates[chId].lastReadAt.toDate && ch.lastMessage.editedAt.toDate() > _readStates[chId].lastReadAt.toDate();
        html += `<div class="chat-sidebar-item${active}${hasUnreadEdit ? ' chat-sidebar-item--edited' : ''}" data-channel="${chId}" draggable="true">
          <span class="chat-channel-hash">#</span>
          <span class="chat-sidebar-item-name">${escHTML(ch.displayName || ch.name)}</span>
          ${mentionCount > 0 ? `<span class="chat-sidebar-badge chat-sidebar-badge--mention">${mentionCount}</span>` : ''}
          ${unread > 0 && mentionCount === 0 ? `<span class="chat-sidebar-badge">${unread > 99 ? '99+' : unread}</span>` : ''}
        </div>`;
      }
      html += `</div>`;
    }

    // Browse all channels button
    html += `<button class="chat-sidebar-browse" id="chat-browse-channels">
      ${svgGrid()} Browse All Channels
    </button>`;

    // DMs section — user-managed contact groups (alumni auto-sorted
    // out into their own collapsed section at render time)
    const { groups: contactGroups, alumni: alumniUids } = splitContactsForRender();
    const hasAnyContacts = contactGroups.some(g => g.uids.length > 0) || alumniUids.length > 0;
    html += `<div class="chat-sidebar-section-header">
      <span>People</span>
      <button class="chat-icon-btn chat-icon-btn--sm" id="chat-manage-contacts-btn" title="Manage contacts">${svgEdit()}</button>
    </div>`;

    const renderDmItemHTML = (uid) => {
      const u = _allUsers.find(a => a.uid === uid);
      if (!u) return '';
      const name = u.name || u.displayName || u.email;
      // Find existing DM channel for unread badge
      const dmCh = _channels.find(c => c.type === 'dm' && c.members && c.members.includes(uid) && c.members.includes(_user.uid));
      const active = dmCh && dmCh.id === _activeChannelId ? ' chat-sidebar-item--active' : '';
      const unread = dmCh ? getUnreadCount(dmCh.id) : 0;
      const photo = u.photo?.thumb;
      return `<div class="chat-sidebar-item${active}" data-dm-contact="${uid}">
        <span class="chat-avatar-wrap">${photo ? `<img class="chat-dm-avatar" src="${escHTML(photo)}" alt="" />` : `<span class="chat-dm-avatar">${getInitials(name)}</span>`}${renderPresenceDotHTML(uid)}</span>
        <span class="chat-sidebar-item-name">${escHTML(name)}</span>
        ${unread > 0 ? `<span class="chat-sidebar-badge">${unread > 99 ? '99+' : unread}</span>` : ''}
      </div>`;
    };

    if (hasAnyContacts) {
      for (const group of contactGroups) {
        if (group.uids.length === 0) continue; // e.g. everyone in it is alumni now
        html += `<div class="chat-sidebar-dm-category">${escHTML(group.groupName)}</div>`;
        html += group.uids.map(renderDmItemHTML).join('');
      }
      if (alumniUids.length > 0) {
        html += `<details class="chat-sidebar-alumni">
          <summary class="chat-sidebar-dm-category">Alumni (${alumniUids.length})</summary>
          ${alumniUids.map(renderDmItemHTML).join('')}
        </details>`;
      }
    } else {
      html += `<div class="chat-sidebar-empty">Click ${svgEdit()} to add people</div>`;
    }

    // Search button at bottom
    html += `<button class="chat-sidebar-action" id="chat-search-btn">${svgSearch()} Search Messages</button>`;

    return html;
  }

  function renderSidebar() {
    const el = document.getElementById('chat-sidebar');
    if (!el) return;
    el.innerHTML = renderSidebarHTML();
    wireSidebarNonClick();
    updatePresenceUI();
  }

  /* ═══════════════════════════════════════════════════════════
     RENDERING — Channel Header
     ═══════════════════════════════════════════════════════════ */
  function renderHeaderHTML(channel) {
    if (!channel) return '<div class="chat-header"></div>';
    const isDM = channel.type === 'dm';
    const name = isDM ? getDMDisplayName(channel) : `#${channel.displayName || channel.name}`;
    const desc = isDM ? '' : (channel.description || '');
    const subscribed = _userMeta?.subscribedChannels?.includes(channel.id);
    const pinnedCount = _messages.filter(m => m.pinned).length;

    const dmOther = isDM ? getDMOtherUser(channel) : null;
    return `<div class="chat-header">
      <button class="chat-hamburger" id="chat-hamburger">${svgMenu()}</button>
      <div class="chat-header-info">
        <h2 class="chat-header-name">${dmOther ? renderPresenceDotHTML(dmOther.uid, true) : ''}${escHTML(name)}</h2>
        ${desc ? `<span class="chat-header-desc">${escHTML(desc)}</span>` : ''}
      </div>
      <div class="chat-header-actions">
        ${pinnedCount > 0 ? `<button class="chat-icon-btn" id="chat-pinned-btn" title="Pinned (${pinnedCount})">${svgPin()} <span class="chat-pin-count">${pinnedCount}</span></button>` : ''}
        ${(() => {
          const live = !!window.VOICE_CALL?.getActiveCall?.(channel.id);
          const inIt = window.VOICE_CALL?.currentChannelId?.() === channel.id;
          const title = inIt ? 'You\'re in this call' : live ? 'Join the call in progress' : 'Start a voice call';
          return `<button class="chat-icon-btn${live ? ' chat-call-btn--live' : ''}" id="chat-call-btn" title="${title}">📞</button>`;
        })()}
        ${canImportHistory(channel) ? `<button class="chat-icon-btn" id="chat-import-btn" title="Import Slack history">📥</button>` : ''}
        <button class="chat-icon-btn" id="chat-header-search" title="Search">${svgSearch()}</button>
        ${!isDM ? `<button class="chat-sub-toggle${subscribed ? ' chat-sub-toggle--active' : ''}" id="chat-sub-toggle" title="${subscribed ? 'Unsubscribe from notifications' : 'Subscribe for notifications'}">
          ${subscribed ? svgBellOn() : svgBellOff()}
          <span>${subscribed ? 'Subscribed' : 'Subscribe'}</span>
        </button>` : ''}
      </div>
    </div>`;
  }

  /* ═══════════════════════════════════════════════════════════
     RENDERING — Messages
     ═══════════════════════════════════════════════════════════ */
  function renderMessagesHTML() {
    const msgs = _messages; // R6: search results live in the modal only
    // Find the last message authored by current user (for read receipt eyeball)
    let lastOwnMsgId = null;
    for (let i = msgs.length - 1; i >= 0; i--) {
      if (msgs[i].authorUid === _user.uid) { lastOwnMsgId = msgs[i].id; break; }
    }
    // R3 — walk with date separators + consecutive-message grouping.
    let html = '';
    let prev = null;
    for (const m of msgs) {
      const d = tsToDate(m.createdAt);
      const pd = prev ? tsToDate(prev.createdAt) : null;
      if (d && (!pd || !sameDay(pd, d))) {
        html += `<div class="chat-date-sep"><span>${formatDayLabel(d)}</span></div>`;
      }
      html += renderMessageHTML(m, false, m.id === lastOwnMsgId, isGroupedWith(prev, m));
      prev = m;
    }
    return html;
  }

  function renderMessageHTML(msg, isThread, isLastOwnMsg, grouped) {
    const isOwn = msg.authorUid === _user.uid;
    const isEditing = _editingMessageId === msg.id;
    const time = formatTimestamp(msg.createdAt);
    const photoUrl = msg.authorPhoto;
    // Grouped follow-up: no avatar/name row — a gutter placeholder shows
    // the absolute time on hover (and on tap-select via CSS).
    const avatarHTML = grouped
      ? `<div class="chat-msg-gutter"><span class="chat-msg-gutter-time">${formatClockTime(msg.createdAt)}</span></div>`
      : (photoUrl
        ? `<img class="chat-msg-avatar" src="${escHTML(photoUrl)}" alt="" />`
        : `<div class="chat-msg-avatar chat-msg-avatar--initials">${getInitials(msg.authorName)}</div>`);

    let bodyHTML = '';
    if (isEditing) {
      bodyHTML = `<div class="chat-msg-edit">
        <textarea class="app-input chat-edit-input" id="chat-edit-${msg.id}">${escHTML(msg.text)}</textarea>
        <div class="chat-msg-edit-actions">
          <button class="app-btn app-btn--primary app-btn--sm" data-save-edit="${msg.id}">Save</button>
          <button class="app-btn app-btn--secondary app-btn--sm" data-cancel-edit>Cancel</button>
        </div>
      </div>`;
    } else {
      bodyHTML = `<div class="chat-msg-text">${parseMarkdown(msg.text)}</div>`;
    }

    // File attachment (supports both Firebase Storage `url` and legacy Drive `driveUrl`)
    let fileHTML = '';
    if (msg.file) {
      const fileUrl = msg.file.url || msg.file.driveUrl || '#';
      if (msg.file.isImage) {
        fileHTML = `<div class="chat-msg-file chat-msg-file--image">
          <a href="${escHTML(fileUrl)}" target="_blank" rel="noopener">
            <img src="${escHTML(fileUrl)}" alt="${escHTML(msg.file.name)}" class="chat-file-thumbnail" />
          </a>
          <div class="chat-file-name"><a href="${escHTML(fileUrl)}" target="_blank" rel="noopener">${escHTML(msg.file.name)}</a></div>
        </div>`;
      } else {
        fileHTML = `<div class="chat-msg-file">
          <div class="chat-file-icon">${svgFile()}</div>
          <div class="chat-file-info">
            <a href="${escHTML(fileUrl)}" target="_blank" rel="noopener" class="chat-file-name">${escHTML(msg.file.name)}</a>
            <span class="chat-file-size">${formatFileSize(msg.file.size)}</span>
          </div>
        </div>`;
      }
    }

    // Reactions
    let reactionsHTML = '';
    const reactions = msg.reactions || {};
    const reactionKeys = Object.keys(reactions).filter(k => reactions[k] && reactions[k].length > 0);
    if (reactionKeys.length > 0) {
      reactionsHTML = `<div class="chat-msg-reactions">
        ${reactionKeys.map(k => {
          const emoji = EMOJI_SET.find(e => e.key === k);
          const users = reactions[k];
          const hasOwn = users.includes(_user.uid);
          return `<button class="chat-reaction${hasOwn ? ' chat-reaction--own' : ''}" data-react="${msg.id}" data-emoji="${k}">
            ${emoji ? emoji.label : k} <span class="chat-reaction-count">${users.length}</span>
          </button>`;
        }).join('')}
        <button class="chat-reaction chat-reaction--add" data-react-add="${msg.id}">+</button>
      </div>`;
    }

    // Read receipts — Teams-style eyeball (open = seen by all, closed =
    // unseen by some). R7: derived from chatReadState.lastReadAt, not
    // the old readBy[] arrays.
    let receiptsHTML = '';
    if (!isThread && isLastOwnMsg && msg.authorUid === _user.uid) {
      const readers = getSeenByUids(msg);
      const totalOthers = getSeenByDenominator(msg);
      const seenCount = readers.length;
      const allSeen = totalOthers > 0 && seenCount >= totalOthers;
      const someSeen = seenCount > 0;
      const eyeIcon = allSeen ? svgEyeOpen() : (someSeen ? svgEyeHalf() : svgEyeClosed());
      const label = seenCount === 0 ? 'Sent' : allSeen ? `Seen by everyone` : `Seen by ${seenCount}`;
      receiptsHTML = `<div class="chat-msg-receipt-eye${allSeen ? ' chat-receipt--all' : someSeen ? ' chat-receipt--some' : ''}" data-seen-by="${msg.id}" title="${label}">
        ${eyeIcon}
      </div>`;
    }

    // Thread indicator
    let threadHTML = '';
    if (!isThread && msg.threadReplyCount > 0) {
      const lastReply = msg.threadLastReplyAt ? formatTimestamp(msg.threadLastReplyAt) : '';
      threadHTML = `<button class="chat-thread-indicator" data-thread="${msg.id}">
        ${svgThread()} ${msg.threadReplyCount} ${msg.threadReplyCount === 1 ? 'reply' : 'replies'}
        ${lastReply ? `<span class="chat-muted"> — last ${lastReply}</span>` : ''}
      </button>`;
    }

    // Per-message actions removed — handled by action bar above input

    // System messages
    if (msg.type === 'system') {
      return `<div class="chat-msg chat-msg--system"><span class="chat-muted">${parseMarkdown(msg.text)}</span></div>`;
    }

    const selected = _selectedMsgId === msg.id ? ' chat-msg--selected' : '';

    return `<div class="chat-msg${msg.pinned ? ' chat-msg--pinned' : ''}${selected}" id="msg-${msg.id}" data-msg-select="${msg.id}">
      ${avatarHTML}
      <div class="chat-msg-body">
        <div class="chat-msg-meta">
          <span class="chat-msg-author">${escHTML(msg.authorName)}</span>
          <span class="chat-msg-time">${time}</span>
          ${msg.editedAt ? '<span class="chat-muted">(edited)</span>' : ''}
          ${msg.pinned ? `<span class="chat-badge-pin">${svgPin()} Pinned</span>` : ''}
          ${msg.importedFromSlack ? '<span class="chat-badge-imported">from Slack</span>' : ''}
        </div>
        ${bodyHTML}
        ${fileHTML}
        ${reactionsHTML}
        ${threadHTML}
        ${receiptsHTML}
      </div>
    </div>`;
  }

  function renderMessages() {
    const feed = document.getElementById('chat-feed');
    if (!feed) return;
    const wasAtBottom = feedAtBottom(); // document-scroll aware (V3.522)

    _isRendering = true;
    feed.innerHTML = `
      ${_hasMoreMessages ? `<button class="chat-load-more" id="chat-load-more">Load older messages</button>` : ''}
      ${_loadingOlder ? '<div class="chat-loading">Loading...</div>' : ''}
      ${_messages.length === 0 ? '<div class="chat-empty">No messages yet. Start the conversation!</div>' : ''}
      ${renderMessagesHTML()}
      ${_feedMode === 'history' && _histHasNewer ? '<button class="chat-load-more" id="chat-load-newer">Load newer messages</button>' : ''}
      ${_loadingNewer ? '<div class="chat-loading">Loading...</div>' : ''}
    `;
    if (_feedMode === 'live' && (wasAtBottom || _autoScroll)) scrollToBottom();
    _isRendering = false;
    // Show new messages button if scrolled up
    if (_feedMode === 'live' && !wasAtBottom && !_autoScroll) showNewMessagesButton();
  }

  function renderEmojiPickerHTML(msgId) {
    return `<div class="chat-emoji-picker" data-picker-for="${msgId}">
      ${EMOJI_SET.map(e => `<button class="chat-emoji-btn" data-react="${msgId}" data-emoji="${e.key}" title="${e.key}">${e.label}</button>`).join('')}
    </div>`;
  }

  /* ═══════════════════════════════════════════════════════════
     RENDERING — Message Action Bar (above input)
     ═══════════════════════════════════════════════════════════ */
  function renderMsgActionBarHTML() {
    if (!_selectedMsgId) return '';
    const msg = [..._messages, ..._threadMessages].find(m => m.id === _selectedMsgId);
    if (!msg) return '';
    const isOwn = msg.authorUid === _user.uid;
    const ro = isChatReadOnly();
    const authorName = msg.authorName || 'Message';
    const preview = (msg.text || '').substring(0, 40) + ((msg.text || '').length > 40 ? '...' : '');

    return `<div class="chat-action-bar" id="chat-action-bar">
      <div class="chat-action-bar-info">
        <span class="chat-action-bar-author">${escHTML(authorName)}</span>
        <span class="chat-action-bar-preview">${escHTML(preview)}</span>
      </div>
      <div class="chat-action-bar-btns">
        ${!ro ? `<button class="chat-action-btn" data-react-add="${msg.id}" title="React">${svgSmile()}</button>` : ''}
        <button class="chat-action-btn" data-thread-start="${msg.id}" title="Reply">${svgThread()}</button>
        ${!ro ? `<button class="chat-action-btn" data-pin="${msg.id}" title="${msg.pinned ? 'Unpin' : 'Pin'}">${svgPin()}</button>` : ''}
        ${isOwn && !ro ? `<button class="chat-action-btn" data-edit="${msg.id}" title="Edit">${svgEdit()}</button>` : ''}
        ${(isOwn || isSiteAdmin()) && !ro ? `<button class="chat-action-btn chat-action-btn--danger" data-delete="${msg.id}" title="Delete">${svgTrash()}</button>` : ''}
        <button class="chat-action-btn" id="chat-action-bar-close" title="Close">${svgX()}</button>
      </div>
    </div>`;
  }

  /* ═══════════════════════════════════════════════════════════
     RENDERING — Input Area
     ═══════════════════════════════════════════════════════════ */
  function renderInputAreaHTML() {
    if (isChatReadOnly()) {
      return `<div class="chat-input-area chat-input-area--locked" id="chat-input-area">
        <span class="chat-muted">You have read-only access to this chat</span>
      </div>`;
    }
    const channel = _channels.find(c => c.id === _activeChannelId);
    if (channel && channel.isAnnouncement && !isAdmin()) {
      return `<div class="chat-input-area chat-input-area--locked" id="chat-input-area">
        <span class="chat-muted">Only admins can post in announcement channels</span>
      </div>`;
    }
    return `<div class="chat-input-area" id="chat-input-area">
      <div class="chat-input-wrapper">
        <textarea class="chat-input" id="chat-input" placeholder="Type a message..." rows="1"></textarea>
        ${_mentionQuery !== null ? renderMentionPopupHTML() : ''}
      </div>
      ${_formatBarOpen ? renderFormatBarHTML() : ''}
      <div class="chat-input-actions">
        <button class="chat-icon-btn" id="chat-md-hint-toggle" title="Formatting help">Aa</button>
        <button class="chat-icon-btn" id="chat-composer-emoji" title="Emoji">${svgSmile()}</button>
        <button class="chat-icon-btn" id="chat-attach-btn" title="Attach files">${svgPaperclip()}</button>
        <input type="file" id="chat-file-input" multiple style="display:none" />
        <button class="chat-send-btn" id="chat-send-btn" title="Send">${svgSend()}</button>
      </div>
      ${_uploadingFile ? '<div class="chat-uploading">Uploading…</div>' : ''}
      ${_mdHintOpen ? `<div class="chat-md-hint">*bold* &nbsp;·&nbsp; _italic_ &nbsp;·&nbsp; \`code\` &nbsp;·&nbsp; \`\`\`code block\`\`\` &nbsp;·&nbsp; @mention &nbsp;·&nbsp; @channel</div>` : ''}
    </div>`;
  }

  function renderInputArea() {
    const el = document.getElementById('chat-input-area');
    if (!el) return;
    const parent = el.parentElement;
    if (!parent) return;
    // Preserve in-progress composer text + focus across the rebuild
    // (render() refreshes this region on every pass).
    const oldInput = document.getElementById('chat-input');
    const keep = oldInput ? {
      value: oldInput.value,
      focused: document.activeElement === oldInput,
      selStart: oldInput.selectionStart,
      selEnd: oldInput.selectionEnd
    } : null;
    // Re-render just the input area section
    const newHTML = renderInputAreaHTML();
    const wrapper = document.createElement('div');
    wrapper.innerHTML = newHTML;
    parent.replaceChild(wrapper.firstElementChild, el);
    wireInput();
    if (keep) {
      const input = document.getElementById('chat-input');
      if (input) {
        input.value = keep.value;
        if (keep.focused) {
          input.focus();
          try { input.setSelectionRange(keep.selStart, keep.selEnd); } catch (_) {}
        }
      }
    }
  }

  function renderMentionPopupHTML() {
    const suggestions = getMentionSuggestions(_mentionQuery);
    if (suggestions.length === 0) return '';
    return `<div class="chat-mention-popup">
      ${suggestions.map((u, i) => `<div class="chat-mention-item${i === _mentionIndex ? ' chat-mention-item--active' : ''}" data-mention-uid="${u.uid}">
        <span class="chat-mention-avatar">${getInitials(u.name || u.displayName || u.email)}</span>
        <span class="chat-mention-name">${escHTML(u.name || u.displayName || u.email)}</span>
      </div>`).join('')}
      <div class="chat-mention-item${_mentionIndex === suggestions.length ? ' chat-mention-item--active' : ''}" data-mention-channel>
        <span class="chat-mention-avatar">#</span>
        <span class="chat-mention-name">@channel (notify everyone)</span>
      </div>
    </div>`;
  }

  /* ═══════════════════════════════════════════════════════════
     RENDERING — Thread Panel
     ═══════════════════════════════════════════════════════════ */
  // R3 — thread replies render with the same consecutive-message
  // grouping as the main feed (no date separators — threads are short).
  function renderThreadFeedHTML() {
    let html = '';
    let prev = null;
    for (const m of _threadMessages) {
      html += renderMessageHTML(m, true, false, isGroupedWith(prev, m));
      prev = m;
    }
    return html;
  }

  function threadHeaderSubHTML() {
    const channel = _channels.find(c => c.id === _activeChannelId);
    const chName = channel
      ? (channel.type === 'dm' ? getDMDisplayName(channel) : `#${channel.displayName || channel.name}`)
      : '';
    const n = _threadMessages.length;
    return `${escHTML(chName)} · ${n} ${n === 1 ? 'reply' : 'replies'}`;
  }

  function renderThreadHTML() {
    const parent = _messages.find(m => m.id === _threadParentId);
    if (!parent) return '';
    const avatarHTML = parent.authorPhoto
      ? `<img class="chat-dm-avatar" src="${escHTML(parent.authorPhoto)}" alt="" />`
      : `<span class="chat-dm-avatar">${getInitials(parent.authorName)}</span>`;
    return `<aside class="chat-thread" id="chat-thread">
      <div class="chat-thread-header">
        <span class="chat-avatar-wrap">${avatarHTML}${renderPresenceDotHTML(parent.authorUid)}</span>
        <div class="chat-thread-header-info">
          <h3>Thread with ${escHTML(parent.authorName || '')}</h3>
          <span class="chat-thread-header-sub">${threadHeaderSubHTML()}</span>
        </div>
        <button class="chat-icon-btn" id="chat-thread-close">${svgX()}</button>
      </div>
      <div class="chat-thread-parent">
        ${renderMessageHTML(parent, true)}
      </div>
      <div class="chat-thread-divider">${_threadMessages.length} ${_threadMessages.length === 1 ? 'reply' : 'replies'}</div>
      <div class="chat-thread-feed" id="chat-thread-feed">
        ${renderThreadFeedHTML()}
      </div>
      <div class="chat-thread-input">
        <textarea class="chat-input" id="chat-thread-input" placeholder="Reply in thread..." rows="1"></textarea>
        <button class="chat-icon-btn" id="chat-thread-emoji" title="Emoji">${svgSmile()}</button>
        <button class="chat-send-btn" id="chat-thread-send">${svgSend()}</button>
      </div>
    </aside>`;
  }

  function renderThread() {
    const el = document.getElementById('chat-thread');
    if (!el) { refreshThreadPanel(); return; }
    const feed = document.getElementById('chat-thread-feed');
    if (feed) {
      feed.innerHTML = renderThreadFeedHTML();
      feed.scrollTop = feed.scrollHeight;
    }
    const divider = el.querySelector('.chat-thread-divider');
    if (divider) divider.textContent = `${_threadMessages.length} ${_threadMessages.length === 1 ? 'reply' : 'replies'}`;
    const sub = el.querySelector('.chat-thread-header-sub');
    if (sub) sub.innerHTML = threadHeaderSubHTML();
  }

  /* ═══════════════════════════════════════════════════════════
     RENDERING — Modals
     ═══════════════════════════════════════════════════════════ */
  function renderChannelDirectoryHTML() {
    const categories = _config?.categories || DEFAULT_CATEGORIES;
    const subscribedSet = new Set(_userMeta?.subscribedChannels || []);
    const channelsByCategory = {};
    for (const cat of categories) channelsByCategory[cat] = [];
    for (const ch of _channels) {
      if (ch.type === 'dm') continue;
      const cat = ch.category || 'General';
      if (!channelsByCategory[cat]) channelsByCategory[cat] = [];
      channelsByCategory[cat].push(ch);
    }

    return `<div class="chat-modal-overlay" data-close-modal="directory">
      <div class="chat-modal chat-modal--directory">
        <div class="chat-modal-header">
          <h3>Browse Channels</h3>
          <button class="chat-icon-btn" data-close-modal="directory">${svgX()}</button>
        </div>
        <input class="app-input chat-directory-search" id="chat-dir-search" placeholder="Search channels..." />
        <div class="chat-directory-list" id="chat-dir-list">
          ${categories.map(cat => {
            const chs = channelsByCategory[cat] || [];
            if (chs.length === 0) return '';
            return `<div class="chat-directory-category">
              <h4 class="chat-directory-category-name">${escHTML(cat)}</h4>
              ${chs.map(ch => `<div class="chat-directory-item" data-dir-channel="${ch.id}">
                <div class="chat-directory-item-info">
                  <span class="chat-channel-hash">#</span>
                  <strong>${escHTML(ch.displayName || ch.name)}</strong>
                  ${ch.description ? `<span class="chat-muted"> — ${escHTML(ch.description)}</span>` : ''}
                  ${ch.isAnnouncement ? '<span class="app-badge app-badge--admin">Announcement</span>' : ''}
                </div>
                <div class="chat-directory-item-actions">
                  <span class="chat-muted">${ch.memberCount || 0} subscribed</span>
                  ${subscribedSet.has(ch.id)
                    ? `<button class="app-btn app-btn--secondary app-btn--sm" data-unsub-dir="${ch.id}">Subscribed</button>`
                    : `<button class="app-btn app-btn--primary app-btn--sm" data-sub-dir="${ch.id}">Subscribe</button>`
                  }
                </div>
              </div>`).join('')}
            </div>`;
          }).join('')}
        </div>
        <div class="chat-modal-footer">
          <button class="app-btn app-btn--primary" id="chat-create-channel-btn">${svgPlus()} Create Channel</button>
        </div>
      </div>
    </div>`;
  }

  function renderCreateChannelHTML() {
    const categories = _config?.categories || DEFAULT_CATEGORIES;
    return `<div class="chat-modal-overlay" data-close-modal="create">
      <div class="chat-modal">
        <div class="chat-modal-header">
          <h3>Create Channel</h3>
          <button class="chat-icon-btn" data-close-modal="create">${svgX()}</button>
        </div>
        <div class="chat-modal-body">
          <label class="app-label">Channel Name</label>
          <input class="app-input" id="chat-new-name" placeholder="e.g. tfm-data" />
          <label class="app-label">Display Name</label>
          <input class="app-input" id="chat-new-display" placeholder="e.g. TFM Data Analysis" />
          <label class="app-label">Description</label>
          <input class="app-input" id="chat-new-desc" placeholder="What's this channel about?" />
          <label class="app-label">Category</label>
          <select class="app-input" id="chat-new-category">
            ${categories.map(c => `<option value="${escHTML(c)}">${escHTML(c)}</option>`).join('')}
          </select>
          ${isAdmin() ? `<label class="chat-checkbox-label">
            <input type="checkbox" id="chat-new-announce" /> Announcement-only (only admins can post)
          </label>` : ''}
        </div>
        <div class="chat-modal-footer">
          <button class="app-btn app-btn--secondary" data-close-modal="create">Cancel</button>
          <button class="app-btn app-btn--primary" id="chat-do-create">Create Channel</button>
        </div>
      </div>
    </div>`;
  }

  function renderSettingsHTML() {
    return `<div class="chat-modal-overlay" data-close-modal="settings">
      <div class="chat-modal chat-modal--settings">
        <div class="chat-modal-header">
          <h3>Chat Settings</h3>
          <button class="chat-icon-btn" data-close-modal="settings">${svgX()}</button>
        </div>
        <div class="chat-modal-body">
          <h4>Channel Categories</h4>
          <p class="chat-muted">Manage the categories users can assign to channels.</p>
          <div id="chat-categories-list">
            ${(_config?.categories || []).map((cat, i) => `<div class="chat-settings-row">
              <input class="app-input" value="${escHTML(cat)}" data-cat-idx="${i}" />
              <button class="chat-icon-btn chat-icon-btn--danger" data-remove-cat="${i}">${svgTrash()}</button>
            </div>`).join('')}
          </div>
          <button class="app-btn app-btn--secondary app-btn--sm" id="chat-add-cat">${svgPlus()} Add Category</button>

          <h4 style="margin-top:1.5rem">Chat Admins</h4>
          <p class="chat-muted">Chat admins can edit/delete any message, manage channels, and access all settings.</p>
          <div id="chat-admin-list">
            ${(_config?.chatAdmins || []).map(uid => {
              const u = _allUsers.find(a => a.uid === uid);
              const name = u ? (u.name || u.displayName || u.email) : uid;
              return `<div class="chat-settings-row">
                <span style="flex:1;font-size:.85rem">${escHTML(name)}</span>
                ${isSiteAdmin() ? `<button class="chat-icon-btn chat-icon-btn--danger" data-remove-admin="${uid}">${svgTrash()}</button>` : ''}
              </div>`;
            }).join('') || '<p class="chat-muted" style="font-size:.8rem">No chat admins assigned yet.</p>'}
          </div>
          ${isSiteAdmin() ? `
            <div class="chat-settings-row" style="margin-top:.5rem">
              <select class="app-input" id="chat-add-admin-select" style="flex:1">
                <option value="">Add a chat admin...</option>
                ${_allUsers.filter(u => !(_config?.chatAdmins || []).includes(u.uid) && LAB_USERS.isVisible(u)).map(u =>
                  `<option value="${u.uid}">${escHTML(u.name || u.displayName || u.email)}</option>`
                ).join('')}
              </select>
              <button class="app-btn app-btn--primary app-btn--sm" id="chat-add-admin-btn">${svgPlus()} Add</button>
            </div>
          ` : ''}

          <h4 style="margin-top:1.5rem">File Uploads</h4>
          <p class="chat-muted">Files are uploaded to Firebase Storage. Max file size: 50 MB.</p>

          <h4 style="margin-top:1.5rem">Maintenance</h4>
          <p class="chat-muted">Rebuild each channel's subscriber list from every user's
            subscriptions. Run once after the server fan-out deploy; safe to re-run.</p>
          <button class="app-btn app-btn--secondary app-btn--sm" id="chat-backfill-subs">Backfill subscriber lists</button>
        </div>
        <div class="chat-modal-footer">
          <button class="app-btn app-btn--secondary" data-close-modal="settings">Cancel</button>
          <button class="app-btn app-btn--primary" id="chat-save-settings">Save Settings</button>
        </div>
      </div>
    </div>`;
  }

  /* ═══════════════════════════════════════════════════════════
     V3.582 — Slack-history import modal
     Slack can't export DMs, so users paste the whole conversation
     into a .md/.txt file. Parse (chat-slack-import.js) → map Slack
     names to lab members → preview → POST to chatImportSlackHistory
     (Admin SDK writes backdated messages BEFORE the channel's oldest;
     rules block client-side cross-user attribution). The input step
     doubles as the undo surface: previously-imported batches list
     with a Remove button.
     ═══════════════════════════════════════════════════════════ */
  function canImportHistory(channel) {
    if (!channel || !_user || isChatReadOnly()) return false;
    if (channel.type === 'dm') return (channel.members || []).includes(_user.uid);
    return isChatAdmin();
  }

  function renderImportHTML() {
    const st = _importState || {};
    const bodyByStep = {
      input: renderImportInputHTML,
      map: renderImportMapHTML,
      preview: renderImportPreviewHTML,
      progress: () => `<div class="chat-import-progress"><div class="chat-loading">Importing ${CHAT_SLACK_IMPORT.applyMapping(st.parsed, st.mapping).length} messages…</div><p class="chat-muted">Keep this tab open — large histories take a few seconds.</p></div>`,
      done: () => `<div class="chat-import-done">✅ Imported ${st.result?.count ?? 0} messages.<p class="chat-muted">They sit above the existing history — use "Load older messages" to scroll up to them. Each one carries a "from Slack" badge.</p></div>`
    };
    const footByStep = {
      input: `<button class="app-btn app-btn--secondary" data-close-modal="import">Cancel</button>
              <button class="app-btn app-btn--primary" id="chat-import-next" ${st.busy ? 'disabled' : ''}>Next →</button>`,
      map: `<button class="app-btn app-btn--secondary" id="chat-import-back" data-back-to="input">← Back</button>
            <button class="app-btn app-btn--primary" id="chat-import-next">Next →</button>`,
      preview: `<button class="app-btn app-btn--secondary" id="chat-import-back" data-back-to="map">← Back</button>
                <button class="app-btn app-btn--primary" id="chat-import-run">Import</button>`,
      progress: '',
      done: `<button class="app-btn app-btn--primary" data-close-modal="import">Close</button>`
    };
    return `<div class="chat-modal-overlay" data-close-modal="import">
      <div class="chat-modal chat-modal--import">
        <div class="chat-modal-header">
          <h3>Import Slack history</h3>
          ${st.step !== 'progress' ? `<button class="chat-icon-btn" data-close-modal="import">${svgX()}</button>` : ''}
        </div>
        <div class="chat-modal-body">
          ${st.error ? `<div class="chat-import-error">${escHTML(st.error)}</div>` : ''}
          ${(bodyByStep[st.step] || bodyByStep.input)()}
        </div>
        ${footByStep[st.step] ? `<div class="chat-modal-footer">${footByStep[st.step]}</div>` : ''}
      </div>
    </div>`;
  }

  function renderImportInputHTML() {
    const st = _importState;
    const batches = st.batches || [];
    return `
      <p class="chat-muted">In Slack, select the whole conversation, copy it, and save it
        as a <b>.md</b> or <b>.txt</b> file — or paste it directly below. Slack copies
        carry no dates, so message <b>order</b> is kept but original timestamps are
        dropped; the imported block is inserted <b>before</b> this conversation's
        existing messages and marked as imported.</p>
      <input type="file" id="chat-import-file" accept=".md,.txt,text/plain,text/markdown" class="app-input" />
      ${st.fileName && st.parsed?.ok ? `<p class="chat-import-parsed">✅ ${escHTML(st.fileName)} — ${st.parsed.messages.length} messages, ${st.parsed.participants.length} participants${st.parsed.warnings.length ? ` <span class="chat-muted">(${escHTML(st.parsed.warnings.join(' '))})</span>` : ''}</p>` : ''}
      <details ${st.fileName ? '' : 'open'} style="margin-top:.6rem">
        <summary class="chat-muted">…or paste the copied chat here</summary>
        <textarea id="chat-import-paste" class="app-input chat-import-paste" rows="6" placeholder="Gabriel Leonard Galahad Declercq  [2:59 PM]&#10;Hello Dr. McGhee, …"></textarea>
      </details>
      ${batches.length ? `
        <h4 style="margin-top:1.2rem">Previously imported</h4>
        ${batches.map(b => `<div class="chat-settings-row chat-import-batch-row">
          <span style="flex:1;font-size:.85rem">${escHTML(formatTimestamp(b.importedAt) || '')} · ${b.count} messages · ${escHTML(b.sourceFilename || '')}<br>
            <span class="chat-muted">by ${escHTML(b.importedByName || '')}</span></span>
          ${(b.importedBy === _user.uid || isChatAdmin()) ? `<button class="app-btn app-btn--secondary app-btn--sm" data-import-remove="${b.id}">Remove</button>` : ''}
        </div>`).join('')}` : ''}`;
  }

  function importEligibleUsers() {
    const channel = _channels.find(c => c.id === _activeChannelId);
    let users = _allUsers.filter(u => canAccessChat(u) && LAB_USERS.isVisible(u));
    // DM: the Cloud Function only accepts attribution to DM members —
    // don't offer anyone else in the dropdown.
    if (channel?.type === 'dm') users = users.filter(u => (channel.members || []).includes(u.uid));
    return users;
  }

  function renderImportMapHTML() {
    const st = _importState;
    const users = importEligibleUsers();
    return `
      <p class="chat-muted">Match each Slack name to a lab member. "Name only" keeps the
        Slack name with no account link — use it for people who aren't in RM.</p>
      <div class="chat-import-map-table">
        ${st.parsed.participants.map(p => {
          const sel = st.mapping[p.name];
          const selUid = (sel && sel !== 'SKIP') ? sel.uid : null;
          return `<div class="chat-settings-row chat-import-map-row">
            <span class="chat-import-map-name" title="${escHTML(p.name)}">${escHTML(p.name)} <span class="chat-muted">(${p.count})</span></span>
            <select class="app-input" data-import-map="${escHTML(p.name)}">
              ${users.map(u => `<option value="${u.uid}" ${selUid === u.uid ? 'selected' : ''}>${escHTML(u.name || u.displayName || u.email)}</option>`).join('')}
              <option value="__nameonly__" ${sel && sel !== 'SKIP' && !sel.uid ? 'selected' : ''}>— Name only (no account) —</option>
              <option value="__skip__" ${sel === 'SKIP' ? 'selected' : ''}>✕ Don't import</option>
            </select>
          </div>`;
        }).join('')}
      </div>`;
  }

  function renderImportPreviewHTML() {
    const st = _importState;
    const msgs = CHAT_SLACK_IMPORT.applyMapping(st.parsed, st.mapping);
    const mapped = msgs.filter(m => m.authorUid).length;
    const nameOnly = msgs.length - mapped;
    const skipped = st.parsed.messages.length - msgs.length;
    const snip = t => escHTML(t.length > 120 ? t.slice(0, 120) + '…' : t);
    return `
      <div class="chat-import-summary">
        <div><b>${msgs.length}</b> messages will be imported (${mapped} linked to accounts, ${nameOnly} name-only${skipped ? `, ${skipped} skipped` : ''}).</div>
        ${msgs.length ? `<div class="chat-import-snippet"><span class="chat-muted">First:</span> ${escHTML(msgs[0].authorName)} — ${snip(msgs[0].text)}</div>
        <div class="chat-import-snippet"><span class="chat-muted">Last:</span> ${escHTML(msgs[msgs.length - 1].authorName)} — ${snip(msgs[msgs.length - 1].text)}</div>` : ''}
        <p class="chat-muted" style="margin-top:.6rem">The block is inserted before this conversation's existing
          history with a "History imported from Slack" divider at the boundary. No
          notifications are sent. You can remove the whole import later.</p>
      </div>`;
  }

  function openImportModal() {
    _showImport = true;
    _importState = { step: 'input', parsed: null, mapping: {}, fileName: null, busy: false, error: null, result: null, batches: [], };
    updateModals();
    loadImportBatches();
  }

  async function loadImportBatches() {
    try {
      const snap = await db().collection('chatImports')
        .where('channelId', '==', _activeChannelId).get();
      if (!_showImport || !_importState) return;
      _importState.batches = snap.docs
        .map(d => ({ id: d.id, ...d.data() }))
        .sort((a, b) => (b.importedAt?.toMillis?.() || 0) - (a.importedAt?.toMillis?.() || 0));
      if (_importState.step === 'input') updateModals();
    } catch (e) {
      console.warn('[chat] loadImportBatches failed', e);
    }
  }

  /* Preselect mapping: case-insensitive match on name / displayName /
     email local-part; Slack pseudo-authors (huddle notices) → skip. */
  function importDefaultMapping(parsed) {
    const users = importEligibleUsers();
    const mapping = {};
    for (const p of parsed.participants) {
      if (p.isPseudo) { mapping[p.name] = 'SKIP'; continue; }
      const needle = p.name.toLowerCase();
      const hit = users.find(u =>
        (u.name || '').toLowerCase() === needle ||
        (u.displayName || '').toLowerCase() === needle ||
        (u.email || '').toLowerCase().split('@')[0] === needle);
      mapping[p.name] = hit
        ? { uid: hit.uid, displayName: hit.name || hit.displayName || hit.email }
        : { uid: null, displayName: p.name };
    }
    return mapping;
  }

  function importHandleParsedText(text, fileName) {
    const st = _importState;
    const parsed = CHAT_SLACK_IMPORT.parse(text);
    if (!parsed.ok) {
      st.parsed = null; st.fileName = null;
      st.error = parsed.errors.join(' ');
    } else {
      st.parsed = parsed;
      st.fileName = fileName;
      st.mapping = importDefaultMapping(parsed);
      st.error = null;
    }
    updateModals();
  }

  function importGoNext() {
    const st = _importState;
    if (st.step === 'input') {
      if (!st.parsed?.ok) {
        const pasted = document.getElementById('chat-import-paste')?.value || '';
        if (!pasted.trim()) { st.error = 'Choose a file or paste the copied chat first.'; updateModals(); return; }
        const parsed = CHAT_SLACK_IMPORT.parse(pasted);
        if (!parsed.ok) { st.error = parsed.errors.join(' '); updateModals(); return; }
        st.parsed = parsed;
        st.fileName = '(pasted)';
        st.mapping = importDefaultMapping(parsed);
      }
      st.error = null;
      st.step = 'map';
    } else if (st.step === 'map') {
      st.error = null;
      st.step = 'preview';
    }
    updateModals();
  }

  async function runImport() {
    const st = _importState;
    const messages = CHAT_SLACK_IMPORT.applyMapping(st.parsed, st.mapping);
    if (!messages.length) { st.error = 'Every participant is set to "Don\'t import" — nothing to do.'; updateModals(); return; }
    st.step = 'progress'; st.busy = true; st.error = null;
    updateModals();
    try {
      const out = await callChatImportFn({
        mode: 'import',
        channelId: _activeChannelId,
        sourceFilename: st.fileName || '(pasted)',
        messages
      });
      st.result = out; st.step = 'done'; st.busy = false;
      // The block sits above everything already loaded — make sure the
      // "Load older messages" affordance is back even in a fully-loaded
      // small channel.
      _hasMoreMessages = true;
      showToast(`Imported ${out.count} messages from Slack`);
      loadImportBatches();
      renderMessages();
    } catch (e) {
      st.busy = false; st.step = 'preview';
      st.error = 'Import failed: ' + (e.message || e);
    }
    updateModals();
  }

  async function removeImportBatch(batchId) {
    const st = _importState;
    st.busy = true; updateModals();
    try {
      const out = await callChatImportFn({ mode: 'undo', batchId });
      showToast(`Removed ${out.deleted} imported messages`);
      _messages = _messages.filter(m => m.importBatchId !== batchId);
      renderMessages();
    } catch (e) {
      st.error = 'Remove failed: ' + (e.message || e);
    }
    st.busy = false;
    await loadImportBatches();
    updateModals();
  }

  async function callChatImportFn(body) {
    const user = (typeof firebridge !== 'undefined' && firebridge.getUser) ? firebridge.getUser() : null;
    if (!user) throw new Error('Not signed in');
    const idToken = await user.getIdToken();
    const resp = await fetch(IMPORT_FN_URL, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'Authorization': 'Bearer ' + idToken },
      body: JSON.stringify(body)
    });
    const out = await resp.json().catch(() => ({}));
    if (!resp.ok) throw new Error(out.error || resp.statusText);
    return out;
  }

  function renderPinnedPageHTML() {
    const pinned = _messages.filter(m => m.pinned);
    return `<div class="chat-pinned-page" id="chat-pinned-page">
      <div class="chat-pinned-page-header">
        ${svgPin()} <span class="chat-pinned-page-title">Pinned Messages</span>
        <span class="chat-pin-count">${pinned.length}</span>
      </div>
      ${pinned.length === 0
        ? '<div class="chat-pinned-page-empty"><p>No pinned messages in this channel yet.</p><p class="chat-muted">Pin important messages for quick reference.</p></div>'
        : `<div class="chat-pinned-page-list">${pinned.map(m => `
            <div class="chat-pinned-item-wrap">
              ${renderMessageHTML(m, true)}
              <button class="chat-pinned-jump" data-goto-msg="${m.id}" data-goto-channel="${escHTML(m.channelId || '')}">Jump to message ↗</button>
            </div>`).join('')}</div>`
      }
    </div>`;
  }

  function renderSearchHTML() {
    return `<div class="chat-modal-overlay" data-close-modal="search">
      <div class="chat-modal chat-modal--search">
        <div class="chat-modal-header">
          <h3>Search Messages</h3>
          <button class="chat-icon-btn" data-close-modal="search">${svgX()}</button>
        </div>
        <div class="chat-search-controls">
          <input class="app-input" id="chat-search-input" placeholder="Search all history..." value="${escHTML(_searchQuery)}" />
          <div class="chat-search-scope">
            <button class="chat-search-scope-btn${_searchScope === 'channel' ? ' chat-search-scope-btn--active' : ''}" data-search-scope="channel">This channel</button>
            <button class="chat-search-scope-btn${_searchScope === 'all' ? ' chat-search-scope-btn--active' : ''}" data-search-scope="all">All channels</button>
          </div>
        </div>
        <div class="chat-search-status" id="chat-search-status"></div>
        <div class="chat-modal-body chat-search-results" id="chat-search-results"></div>
      </div>
    </div>`;
  }

  function renderNewDMHTML() {
    // Group users by category
    const eligible = _allUsers.filter(u => u.uid !== _user.uid && canAccessChat(u));
    const byCategory = {};
    for (const u of eligible) {
      const cat = getCategoryLabel(u.category);
      if (!byCategory[cat]) byCategory[cat] = [];
      byCategory[cat].push(u);
    }
    const catOrder = ['PI', 'Postdoc', 'Grad', 'Undergrad', 'High School', 'Alumni', 'Guest', 'Other'];

    return `<div class="chat-modal-overlay" data-close-modal="newdm">
      <div class="chat-modal">
        <div class="chat-modal-header">
          <h3>New Direct Message</h3>
          <button class="chat-icon-btn" data-close-modal="newdm">${svgX()}</button>
        </div>
        <div class="chat-modal-body">
          <input class="app-input" id="chat-dm-search" placeholder="Search people..." style="margin-bottom:.75rem" />
          <div class="chat-dm-user-list" id="chat-dm-user-list">
            ${catOrder.map(cat => {
              const users = byCategory[cat];
              if (!users || users.length === 0) return '';
              return `<div class="chat-dm-category-label">${escHTML(cat)}</div>
                ${users.map(u => `<button class="chat-dm-user-item" data-dm-user="${u.uid}">
                  <span class="chat-avatar-wrap"><span class="chat-dm-avatar">${getInitials(u.name || u.displayName || u.email)}</span>${renderPresenceDotHTML(u.uid)}</span>
                  <span class="chat-dm-user-name">${escHTML(u.name || u.displayName || u.email)}</span>
                </button>`).join('')}`;
            }).join('')}
          </div>
        </div>
      </div>
    </div>`;
  }

  function renderManageContactsHTML() {
    const contacts = _userMeta?.dmContacts || [];
    const allContactUids = new Set(contacts.flatMap(g => g.uids || []));
    const eligible = _allUsers.filter(u => u.uid !== _user.uid && canAccessChat(u));
    const catOrder = ['PI', 'Postdoc', 'Grad', 'Undergrad', 'High School', 'Alumni', 'Guest', 'Other'];

    // Group eligible users by category for the "Add" section
    const byCategory = {};
    for (const u of eligible) {
      const cat = getCategoryLabel(u.category);
      if (!byCategory[cat]) byCategory[cat] = [];
      byCategory[cat].push(u);
    }

    return `<div class="chat-modal-overlay" data-close-modal="contacts">
      <div class="chat-modal chat-modal--directory">
        <div class="chat-modal-header">
          <h3>Manage People</h3>
          <button class="chat-icon-btn" data-close-modal="contacts">${svgX()}</button>
        </div>
        <div class="chat-modal-body">
          <div class="chat-contacts-layout">
            <div class="chat-contacts-groups">
              <h4>Your Groups</h4>
              <p class="chat-muted" style="font-size:.75rem">Drag people between groups. Click group names to rename.</p>
              ${contacts.length === 0 ? '<p class="chat-muted">No groups yet. Add a group to get started.</p>' : ''}
              ${contacts.map((group, gi) => `<div class="chat-contact-group" data-contact-group="${gi}">
                <div class="chat-contact-group-header">
                  <input class="chat-contact-group-name" value="${escHTML(group.groupName)}" data-contact-group-name="${gi}" />
                  <button class="chat-icon-btn chat-icon-btn--danger chat-icon-btn--sm" data-remove-contact-group="${gi}" title="Remove group">${svgTrash()}</button>
                </div>
                <div class="chat-contact-group-list" data-contact-drop="${gi}">
                  ${(group.uids || []).map(uid => {
                    const u = _allUsers.find(a => a.uid === uid);
                    if (!u) return '';
                    const name = u.name || u.displayName || u.email;
                    return `<div class="chat-contact-item" draggable="true" data-contact-uid="${uid}">
                      <span class="chat-dm-avatar">${getInitials(name)}</span>
                      <span>${escHTML(name)}</span>
                      <span class="chat-muted" style="margin-left:auto;font-size:.7rem">${getCategoryLabel(u.category)}</span>
                      <button class="chat-icon-btn chat-icon-btn--sm" data-remove-contact="${uid}" title="Remove">${svgX()}</button>
                    </div>`;
                  }).join('')}
                  ${(group.uids || []).length === 0 ? '<div class="chat-contact-drop-hint">Drag people here</div>' : ''}
                </div>
              </div>`).join('')}
              <button class="app-btn app-btn--secondary app-btn--sm" id="chat-add-contact-group" style="margin-top:.5rem">${svgPlus()} Add Group</button>
            </div>
            <div class="chat-contacts-people">
              <h4>Lab Members</h4>
              <input class="app-input" id="chat-contact-search" placeholder="Search people..." style="margin-bottom:.5rem" />
              <div class="chat-contacts-available" id="chat-contacts-available">
                ${catOrder.map(cat => {
                  const users = byCategory[cat];
                  if (!users || users.length === 0) return '';
                  return `<div class="chat-dm-category-label">${escHTML(cat)}</div>
                    ${users.map(u => {
                      const name = u.name || u.displayName || u.email;
                      const added = allContactUids.has(u.uid);
                      const chatRole = getChatRole(u.uid);
                      const canManageRoles = isChatAdmin();
                      return `<div class="chat-contact-add-item${added ? ' chat-contact-added' : ''}" data-add-contact="${u.uid}">
                        <span class="chat-dm-avatar">${getInitials(name)}</span>
                        <span class="chat-contact-add-name">${escHTML(name)}</span>
                        ${canManageRoles ? `<select class="chat-role-select" data-set-role="${u.uid}">
                          <option value="editor"${chatRole === 'editor' ? ' selected' : ''}>Editor</option>
                          <option value="readonly"${chatRole === 'readonly' ? ' selected' : ''}>Read-only</option>
                          <option value="admin"${chatRole === 'admin' ? ' selected' : ''}>Admin</option>
                        </select>` : `<span class="chat-role-badge chat-role-badge--${chatRole}">${chatRole}</span>`}
                        ${!added
                          ? `<button class="app-btn app-btn--primary app-btn--sm" data-do-add-contact="${u.uid}">Add</button>`
                          : ''
                        }
                      </div>`;
                    }).join('')}`;
                }).join('')}
              </div>
            </div>
          </div>
        </div>
        <div class="chat-modal-footer">
          <button class="app-btn app-btn--primary" id="chat-save-contacts">Done</button>
        </div>
      </div>
    </div>`;
  }

  function renderSeenByHTML() {
    const msg = [..._messages, ..._threadMessages].find(m => m.id === _showSeenBy);
    if (!msg) return '';
    const readers = getSeenByUids(msg); // R7 — derived from lastReadAt
    return `<div class="chat-modal-overlay" data-close-modal="seenby">
      <div class="chat-modal chat-modal--sm">
        <div class="chat-modal-header">
          <h3>Seen by</h3>
          <button class="chat-icon-btn" data-close-modal="seenby">${svgX()}</button>
        </div>
        <div class="chat-modal-body">
          ${readers.map(uid => {
            const u = _allUsers.find(a => a.uid === uid);
            const name = u ? (u.name || u.displayName || u.email) : uid;
            return `<div class="chat-seen-user">
              <span class="chat-dm-avatar">${getInitials(name)}</span>
              <span>${escHTML(name)}</span>
            </div>`;
          }).join('')}
          ${readers.length === 0 ? '<p class="chat-muted">No one else has read this yet.</p>' : ''}
        </div>
      </div>
    </div>`;
  }

  /* ═══════════════════════════════════════════════════════════
     RENDERING — Mobile Views
     ═══════════════════════════════════════════════════════════ */
  function getMobileViewClass() {
    if (!isMobile()) return '';
    return ' chat-layout--mobile-' + _mobileTab;
  }

  function getFilteredConversations() {
    if (!_userMeta) return [];
    const subscribedSet = new Set(_userMeta.subscribedChannels || []);
    const dmIds = new Set(_userMeta.dmChannelIds || []);
    // Collect all contact UIDs from dmContacts
    const contactUids = new Set();
    (_userMeta.dmContacts || []).forEach(g => (g.uids || []).forEach(u => contactUids.add(u)));

    let convos = _channels.filter(ch => {
      if (_mobileTab === 'overview') return subscribedSet.has(ch.id) || (ch.type === 'dm' && ch.members && ch.members.includes(_user.uid));
      // Default: all
      if (ch.type === 'dm') return ch.members && ch.members.includes(_user.uid);
      return subscribedSet.has(ch.id);
    });

    // Sort by filter
    switch (_conversationFilter) {
      case 'active':
        convos.sort((a, b) => {
          const ta = a.lastActivityAt?.toMillis?.() || 0;
          const tb = b.lastActivityAt?.toMillis?.() || 0;
          return tb - ta;
        });
        break;
      case 'unread':
        convos.sort((a, b) => {
          const ua = getUnreadCount(a.id);
          const ub = getUnreadCount(b.id);
          if (ub !== ua) return ub - ua;
          const ta = a.lastActivityAt?.toMillis?.() || 0;
          const tb = b.lastActivityAt?.toMillis?.() || 0;
          return tb - ta;
        });
        break;
      case 'alpha':
        convos.sort((a, b) => {
          const na = (a.type === 'dm' ? getDMDisplayName(a) : (a.displayName || a.name)).toLowerCase();
          const nb = (b.type === 'dm' ? getDMDisplayName(b) : (b.displayName || b.name)).toLowerCase();
          return na.localeCompare(nb);
        });
        break;
      default: // newest
        convos.sort((a, b) => {
          const ta = a.lastMessage?.timestamp?.toMillis?.() || a.lastActivityAt?.toMillis?.() || 0;
          const tb = b.lastMessage?.timestamp?.toMillis?.() || b.lastActivityAt?.toMillis?.() || 0;
          return tb - ta;
        });
    }
    return convos;
  }

  function renderMobileConversationListHTML() {
    const convos = getFilteredConversations();
    if (convos.length === 0) {
      return '<div class="chat-conv-empty">No conversations yet.<br>Browse channels to get started.</div>';
    }
    return convos.map(ch => {
      const isDM = ch.type === 'dm';
      const name = isDM ? getDMDisplayName(ch) : `# ${ch.displayName || ch.name}`;
      const preview = ch.lastMessage ? `${ch.lastMessage.authorName}: ${ch.lastMessage.text}` : 'No messages yet';
      const time = ch.lastMessage?.timestamp ? formatTimestamp(ch.lastMessage.timestamp) : '';
      const unread = getUnreadCount(ch.id);
      const mentionCount = _readStates[ch.id]?.mentionCount || 0;
      const otherUser = isDM ? getDMOtherUser(ch) : null;
      const photo = otherUser?.photo?.thumb;
      const iconHTML = isDM
        ? (photo
          ? `<div class="chat-conv-icon"><img src="${escHTML(photo)}" alt="" /></div>`
          : `<div class="chat-conv-icon">${getInitials(getDMDisplayName(ch))}</div>`)
        : `<div class="chat-conv-icon chat-conv-icon--channel">#</div>`;

      let badgeHTML = '';
      if (mentionCount > 0) {
        badgeHTML = `<div class="chat-conv-badge chat-conv-badge--mention">${mentionCount}</div>`;
      } else if (unread > 0) {
        badgeHTML = `<div class="chat-conv-badge">${unread > 99 ? '99+' : unread}</div>`;
      }

      return `<div class="chat-conv-item" data-conv-channel="${ch.id}">
        ${iconHTML}
        <div class="chat-conv-body">
          <div class="chat-conv-top">
            <span class="chat-conv-name">${escHTML(name)}</span>
            <span class="chat-conv-time">${time}</span>
          </div>
          <div class="chat-conv-preview">${escHTML(preview)}</div>
        </div>
        ${badgeHTML}
      </div>`;
    }).join('');
  }

  function renderMobileOverviewHTML() {
    if (!_userMeta) return '<div class="chat-loading">Loading...</div>';

    const layout = _userMeta.sidebarLayout || [];
    const chevronRight = `<svg viewBox="0 0 24 24" width="14" height="14" fill="none" stroke="currentColor" stroke-width="2"><polyline points="9 6 15 12 9 18"/></svg>`;
    const chevronDown = `<svg viewBox="0 0 24 24" width="14" height="14" fill="none" stroke="currentColor" stroke-width="2"><polyline points="6 9 12 15 18 9"/></svg>`;

    let html = '';

    // --- Channel groups (mirrors desktop sidebar groups) ---
    for (let gi = 0; gi < layout.length; gi++) {
      const group = layout[gi];
      const sectionKey = `group-${gi}`;
      const collapsed = _collapsedSections.has(sectionKey);
      const channelsInGroup = (group.channelIds || [])
        .map(id => _channels.find(c => c.id === id))
        .filter(ch => ch && ch.type !== 'dm');

      html += `<div class="chat-overview-section">
        <button class="chat-overview-section-header" data-toggle-section="${sectionKey}">
          <span class="chat-overview-chevron">${collapsed ? chevronRight : chevronDown}</span>
          <span class="chat-overview-section-title">${escHTML(group.groupName)}</span>
          <span class="chat-overview-section-count">${channelsInGroup.length}</span>
        </button>`;

      if (!collapsed) {
        html += `<div class="chat-overview-section-body">`;
        for (const ch of channelsInGroup) {
          const unread = getUnreadCount(ch.id);
          const mentionCount = _readStates[ch.id]?.mentionCount || 0;
          const active = ch.id === _activeChannelId ? ' chat-overview-item--active' : '';
          const preview = ch.lastMessage ? `${ch.lastMessage.authorName}: ${ch.lastMessage.text}` : (ch.description || 'No messages yet');
          const time = ch.lastMessage?.timestamp ? formatTimestamp(ch.lastMessage.timestamp) : '';

          let badgeHTML = '';
          if (mentionCount > 0) {
            badgeHTML = `<span class="chat-conv-badge chat-conv-badge--mention">${mentionCount}</span>`;
          } else if (unread > 0) {
            badgeHTML = `<span class="chat-conv-badge">${unread > 99 ? '99+' : unread}</span>`;
          }

          html += `<div class="chat-overview-item${active}" data-overview-channel="${ch.id}">
            <div class="chat-conv-icon chat-conv-icon--channel">#</div>
            <div class="chat-conv-body">
              <div class="chat-conv-top">
                <span class="chat-conv-name">${escHTML(ch.displayName || ch.name)}</span>
                <span class="chat-conv-time">${time}</span>
              </div>
              <div class="chat-conv-preview">${escHTML(preview)}</div>
            </div>
            ${badgeHTML}
          </div>`;
        }
        html += `</div>`;
      }
      html += `</div>`;
    }

    // --- Browse All Channels ---
    html += `<button class="chat-overview-browse" id="chat-overview-browse">
      ${svgGrid()} Browse All Channels
    </button>`;

    // --- People / DMs section (alumni auto-sorted into their own
    // collapsed group at render time) ---
    const { groups: contacts, alumni: alumniUids } = splitContactsForRender();
    const sectionKeyDM = 'people';
    const collapsedDM = _collapsedSections.has(sectionKeyDM);

    html += `<div class="chat-overview-section">
      <button class="chat-overview-section-header" data-toggle-section="${sectionKeyDM}">
        <span class="chat-overview-chevron">${collapsedDM ? chevronRight : chevronDown}</span>
        <span class="chat-overview-section-title">People</span>
        <button class="chat-icon-btn chat-icon-btn--sm chat-overview-action" id="chat-overview-manage-contacts" title="Manage contacts">${svgEdit()}</button>
      </button>`;

    if (!collapsedDM) {
      html += `<div class="chat-overview-section-body">`;
      const renderOverviewDmItemHTML = (uid) => {
        const u = _allUsers.find(a => a.uid === uid);
        if (!u) return '';
        const name = u.name || u.displayName || u.email;
        const dmCh = _channels.find(c => c.type === 'dm' && c.members && c.members.includes(uid) && c.members.includes(_user.uid));
        const active = dmCh && dmCh.id === _activeChannelId ? ' chat-overview-item--active' : '';
        const unread = dmCh ? getUnreadCount(dmCh.id) : 0;
        const photo = u.photo?.thumb;
        const preview = dmCh?.lastMessage ? dmCh.lastMessage.text : 'No messages yet';
        const time = dmCh?.lastMessage?.timestamp ? formatTimestamp(dmCh.lastMessage.timestamp) : '';
        return `<div class="chat-overview-item${active}" data-overview-dm="${uid}">
          <span class="chat-avatar-wrap">${photo ? `<div class="chat-conv-icon"><img src="${escHTML(photo)}" alt="" /></div>` : `<div class="chat-conv-icon">${getInitials(name)}</div>`}${renderPresenceDotHTML(uid)}</span>
          <div class="chat-conv-body">
            <div class="chat-conv-top">
              <span class="chat-conv-name">${escHTML(name)}</span>
              <span class="chat-conv-time">${time}</span>
            </div>
            <div class="chat-conv-preview">${escHTML(preview)}</div>
          </div>
          ${unread > 0 ? `<span class="chat-conv-badge">${unread > 99 ? '99+' : unread}</span>` : ''}
        </div>`;
      };
      const renderDmGroupHTML = (label, key, uids) => {
        const collapsedContact = _collapsedSections.has(key);
        return `<div class="chat-overview-dm-group">
          <button class="chat-overview-dm-group-header" data-toggle-section="${key}">
            <span class="chat-overview-chevron">${collapsedContact ? chevronRight : chevronDown}</span>
            <span>${escHTML(label)}</span>
          </button>
          ${collapsedContact ? '' : uids.map(renderOverviewDmItemHTML).join('')}
        </div>`;
      };

      const hasAnyContacts = contacts.some(g => g.uids.length > 0) || alumniUids.length > 0;
      if (hasAnyContacts) {
        for (let gi = 0; gi < contacts.length; gi++) {
          const group = contacts[gi];
          if (group.uids.length === 0) continue; // e.g. everyone in it is alumni now
          html += renderDmGroupHTML(group.groupName, `dm-group-${gi}`, group.uids);
        }
        // Alumni auto-sort: users whose category is now 'alumni',
        // regardless of which curated group they were saved in.
        if (alumniUids.length > 0) {
          html += renderDmGroupHTML(`Alumni (${alumniUids.length})`, 'alumni', alumniUids);
        }
      } else {
        html += `<div class="chat-overview-empty">Tap ${svgEdit()} to add people</div>`;
      }

      // New DM button
      html += `<button class="chat-overview-browse chat-overview-browse--sm" id="chat-overview-new-dm">
        ${svgPlus()} New Direct Message
      </button>`;
      html += `</div>`;
    }
    html += `</div>`;

    // --- Search ---
    html += `<button class="chat-overview-browse" id="chat-overview-search">
      ${svgSearch()} Search Messages
    </button>`;

    return html;
  }

  function renderMobileTopBarHTML() {
    if (!isMobile()) return '';
    const photoUrl = _profile?.photo?.thumb;
    const userBtnHTML = photoUrl
      ? `<button class="mobile-user-btn" id="mobile-user-btn"><img src="${escHTML(photoUrl)}" alt="" /></button>`
      : `<button class="mobile-user-btn" id="mobile-user-btn">${getInitials(_profile?.name || _user?.displayName || _user?.email || '')}</button>`;

    return `<div class="mobile-top-bar" id="mobile-top-bar">
      <div class="mobile-top-center" style="flex:0;white-space:nowrap;font-size:.85rem">Chat</div>
      <div class="mobile-top-right">
        ${userBtnHTML}
        <button class="mobile-hamburger-btn" id="mobile-hamburger-btn">${svgMenu()}</button>
      </div>
    </div>`;
  }

  function renderMobileStatsBarHTML() {
    if (!isMobile() || _mobileTab !== 'chat') return '';
    const channel = _channels.find(c => c.id === _activeChannelId);
    if (!channel) return '';

    // R7 — readers of this channel = users with a read state here
    const readerCount = Object.keys(_channelReadStates)
      .filter(uid => uid !== _user.uid).length;

    // Count files in current channel messages
    const fileCount = _messages.filter(m => m.file).length;

    return `<div class="chat-mobile-stats" id="chat-mobile-stats">
      <span class="chat-stat-item" id="mobile-stat-readers" title="Readers">
        ${svgEyeOpen()} <span class="chat-stat-count">${readerCount}</span>
      </span>
      <span class="chat-stat-item" id="mobile-stat-search" title="Search">
        ${svgSearch()} Search
      </span>
      <span class="chat-stat-item" id="mobile-stat-files" title="Files (${fileCount})">
        ${svgPaperclip()} <span class="chat-stat-count">${fileCount}</span>
      </span>
    </div>`;
  }

  function renderMobileFilesViewHTML() {
    if (_mobileTab !== 'files') return '';
    const filesInChannel = _messages.filter(m => m.file);

    // Group by type
    const groups = { images: [], documents: [], other: [] };
    filesInChannel.forEach(m => {
      const f = m.file;
      const ext = (f.name || '').split('.').pop().toLowerCase();
      const imageExts = ['jpg', 'jpeg', 'png', 'gif', 'webp', 'svg', 'bmp'];
      const docExts = ['pdf', 'doc', 'docx', 'xls', 'xlsx', 'ppt', 'pptx', 'txt', 'csv'];
      if (f.isImage || imageExts.includes(ext)) {
        groups.images.push({ file: f, msg: m });
      } else if (docExts.includes(ext)) {
        groups.documents.push({ file: f, msg: m });
      } else {
        groups.other.push({ file: f, msg: m });
      }
    });

    let html = '<div class="chat-files-view">';

    const renderGroup = (title, items) => {
      if (items.length === 0) return '';
      let h = `<div class="chat-files-group">
        <div class="chat-files-group-title">${title} (${items.length})</div>`;
      items.forEach(({ file: f, msg }) => {
        const isImg = f.isImage || ['jpg','jpeg','png','gif','webp','svg'].includes((f.name||'').split('.').pop().toLowerCase());
        h += `<a class="chat-files-item" href="${escHTML(f.url || f.driveUrl || '#')}" target="_blank" rel="noopener">
          <div class="chat-files-icon${isImg ? ' chat-files-icon--image' : ''}">
            ${isImg && f.thumbnailUrl ? `<img src="${escHTML(f.thumbnailUrl)}" alt="" />` : svgFile()}
          </div>
          <div class="chat-files-info">
            <div class="chat-files-name">${escHTML(f.name || 'Untitled')}</div>
            <div class="chat-files-meta">${escHTML(msg.authorName)} &middot; ${formatTimestamp(msg.createdAt)}${f.size ? ' &middot; ' + formatFileSize(f.size) : ''}</div>
          </div>
        </a>`;
      });
      h += '</div>';
      return h;
    };

    html += renderGroup('Images', groups.images);
    html += renderGroup('Documents', groups.documents);
    html += renderGroup('Other', groups.other);

    if (filesInChannel.length === 0) {
      html += '<div class="chat-files-empty">No files shared in this conversation yet.</div>';
    }
    html += '</div>';
    return html;
  }

  function renderMobileBottomBarHTML() {
    if (!isMobile()) return '';
    // Skip when embedded in parent iframe — parent provides bottom nav
    if (window.parent !== window) return '';
    const apps = [
      { id: 'chat', name: 'Chat', icon: svgChat() },
      { id: 'meetings', name: 'Meetings', icon: svgPeople() },
      { id: 'equipment', name: 'Equipment', icon: svgCalendar() },
      { id: 'activity-tracker', name: 'Activity', icon: svgChart() },
      { id: 'huddle', name: 'Huddle', icon: svgHuddle() }
    ];

    return `<div class="mobile-bottom-bar" id="mobile-bottom-bar">
      <div class="mobile-bottom-apps">
        ${apps.map(a => `<a class="mobile-bottom-app${a.id === 'chat' ? ' mobile-bottom-app--active' : ''}" href="../${a.id}/index.html" data-app-nav="${a.id}">
          ${a.icon}
          <span>${a.name}</span>
        </a>`).join('')}
      </div>
    </div>`;
  }

  function renderMobileHamburgerMenuHTML() {
    if (!_mobileHamburgerOpen) return '';
    return `<div class="mobile-hamburger-overlay mobile-hamburger-overlay--open" id="mobile-hamburger-overlay"></div>
    <div class="mobile-hamburger-menu mobile-hamburger-menu--open" id="mobile-hamburger-menu">
      <div class="mobile-hamburger-menu-header">
        <span style="font-weight:700;font-size:.95rem">Menu</span>
        <button class="chat-icon-btn" id="mobile-hamburger-close">${svgX()}</button>
      </div>
      <div class="mobile-hamburger-menu-item" id="mobile-menu-browse">${svgGrid()} Browse All Channels</div>
      <div class="mobile-hamburger-menu-item" id="mobile-menu-new-dm">${svgPlus()} New Direct Message</div>
      <div class="mobile-hamburger-menu-item" id="mobile-menu-contacts">${svgEdit()} Manage Contacts</div>
      <div class="mobile-hamburger-menu-item" id="mobile-menu-search">${svgSearch()} Search Messages</div>
      ${isAdmin() ? `<div class="mobile-hamburger-menu-item" id="mobile-menu-settings">${svgSettings()} Settings</div>` : ''}
      <a class="mobile-hamburger-menu-item" href="${window.parent !== window ? '#' : '../../#/apps'}" ${window.parent !== window ? 'id="mobile-menu-all-apps"' : ''} style="margin-top:auto;border-top:1px solid var(--border)">
        ${svgGrid()} All Lab Apps
      </a>
    </div>`;
  }

  function mobileGoBack() {
    if (_mobileTab === 'chat') {
      _mobileTab = 'overview';
    }
    render();
  }

  const CHAT_TABS = ['overview', 'chat', 'files', 'search'];

  // Named swipe handlers so destroy() can detach them.
  let _onSwipeStart = null;
  let _onSwipeEnd = null;

  function initChatTabSwipe() {
    let swX = 0, swY = 0, swT = 0;
    _onSwipeStart = (e) => {
      swX = e.touches[0].clientX;
      swY = e.touches[0].clientY;
      swT = Date.now();
    };
    _onSwipeEnd = (e) => {
      if (!isMobile()) return;
      const dx = e.changedTouches[0].clientX - swX;
      const dy = e.changedTouches[0].clientY - swY;
      const dt = Date.now() - swT;
      if (dt > 500 || Math.abs(dx) < 140 || Math.abs(dy) > Math.abs(dx) * 0.5) return;
      // Don't fire inside scrollable content
      const el = document.elementFromPoint(swX, swY);
      if (el && el.closest('.chat-feed, .chat-thread-feed, .chat-conv-list, .chat-mobile-overview, canvas, [data-no-tab-swipe]')) return;
      const idx = CHAT_TABS.indexOf(_mobileTab);
      if (idx < 0) return;
      const next = dx < 0
        ? Math.min(idx + 1, CHAT_TABS.length - 1)
        : Math.max(idx - 1, 0);
      if (next !== idx) {
        _mobileTab = CHAT_TABS[next];
        if (_mobileTab === 'search') { _showSearch = true; _searchQuery = ''; }
        render();
      }
    };
    document.addEventListener('touchstart', _onSwipeStart, { passive: true });
    document.addEventListener('touchend', _onSwipeEnd, { passive: true });
  }

  /* ═══════════════════════════════════════════════════════════
     WIRING — V3.503 delegated click dispatch
     One listener on #chat-root replaces the old per-render wiring
     loops (the wireAll() cascade). Routes are checked IN ORDER and
     the first selector whose closest() match exists wins — keep
     specific / inner elements ABOVE their containers (reactions
     above [data-msg-select], modal buttons above [data-close-modal]).
     Non-click wiring (inputs, drag-drop, scroll) stays region-scoped
     and re-attaches when its region rebuilds.
     ═══════════════════════════════════════════════════════════ */
  const CLICK_ROUTES = [
    /* ── message-level interactive bits ── */
    ['[data-react][data-emoji]', el => toggleReaction(el.dataset.react, el.dataset.emoji)],
    ['[data-react-add]', el => {
      const msgId = el.dataset.reactAdd;
      _showEmojiPickerFor = msgId;
      showEmojiPickerAt(el, key => toggleReaction(msgId, key));
    }],
    ['[data-thread-start], [data-thread]', el => {
      const msgId = el.dataset.threadStart || el.dataset.thread;
      _threadParentId = msgId;
      if (el.closest('#chat-action-bar')) clearMsgSelection();
      subscribeThread(msgId);
      refreshThreadPanel();
    }],
    ['[data-pin]', el => {
      togglePin(el.dataset.pin);
      if (el.closest('#chat-action-bar')) clearMsgSelection();
    }],
    ['[data-edit]', el => {
      _editingMessageId = el.dataset.edit;
      if (el.closest('#chat-action-bar')) clearMsgSelection();
      renderMessages();
      renderThread();
      const ta = document.getElementById(`chat-edit-${_editingMessageId}`);
      if (ta) ta.focus();
    }],
    ['[data-save-edit]', el => {
      const ta = document.getElementById(`chat-edit-${el.dataset.saveEdit}`);
      if (ta) editMessage(el.dataset.saveEdit, ta.value);
    }],
    ['[data-cancel-edit]', () => {
      _editingMessageId = null;
      renderMessages();
      renderThread();
    }],
    ['[data-delete]', el => {
      if (!confirm('Delete this message?')) return;
      deleteMessage(el.dataset.delete);
      if (el.closest('#chat-action-bar')) clearMsgSelection();
    }],
    ['[data-seen-by]', el => { _showSeenBy = el.dataset.seenBy; updateModals(); }],
    ['#chat-action-bar-close', () => clearMsgSelection()],
    ['#chat-load-more', () => loadOlderMessages()],
    ['[data-goto-msg]', el => {
      const msgId = el.dataset.gotoMsg;
      const channelId = el.dataset.gotoChannel || null;
      _showSearch = false;
      jumpToMessage(msgId, channelId);
    }],
    ['[data-search-scope]', el => {
      _searchScope = el.dataset.searchScope;
      updateModals(); // wireModalsNonClick re-kicks the scan for the new scope
    }],
    ['#chat-search-older', () => runProgressiveSearch(_searchQuery, true)],
    ['#chat-load-newer', () => loadNewerMessages()],

    /* ── composer / thread composer ── */
    ['#chat-send-btn', () => {
      const input = document.getElementById('chat-input');
      if (input) handleSend(input);
    }],
    ['#chat-attach-btn', () => {
      const fi = document.getElementById('chat-file-input');
      if (fi) fi.click();
    }],
    ['#chat-thread-send', () => {
      const input = document.getElementById('chat-thread-input');
      if (input) handleThreadSend(input);
    }],
    ['#chat-composer-emoji', el => {
      if (isOurlabApp() && window.APP_SHEET) { openComposerEmojiSheet(); return; }
      showEmojiPickerAt(el, key => {
        const input = document.getElementById('chat-input');
        const em = EMOJI_SET.find(x => x.key === key);
        if (input && em) insertAtCursor(input, em.label);
      });
    }],
    ['#chat-thread-emoji', el => {
      showEmojiPickerAt(el, key => {
        const input = document.getElementById('chat-thread-input');
        const em = EMOJI_SET.find(x => x.key === key);
        if (input && em) insertAtCursor(input, em.label);
      });
    }],
    ['#chat-md-hint-toggle', () => {
      if (isOurlabApp()) { _formatBarOpen = !_formatBarOpen; renderInputArea(); return; }
      _mdHintOpen = !_mdHintOpen;
      try { localStorage.setItem('chat-md-hint', _mdHintOpen ? 'open' : 'closed'); } catch (e) {}
      renderInputArea();
    }],
    ['[data-fmt]', el => { applyFormat(el.dataset.fmt); }],
    ['#chat-thread-close', () => {
      _threadParentId = null;
      if (_unsubThread) { _unsubThread(); _unsubThread = null; }
      refreshThreadPanel();
    }],

    /* ── mention popup ── */
    ['[data-mention-uid]', el => {
      const u = _allUsers.find(a => a.uid === el.dataset.mentionUid);
      const input = document.getElementById('chat-input');
      if (u && input) {
        insertMention(input, `@${(u.name || u.displayName || u.email).replace(/\s+/g, '.')}`);
      }
      _mentionQuery = null;
      renderMentionPopup();
    }],
    ['[data-mention-channel]', () => {
      const input = document.getElementById('chat-input');
      if (input) insertMention(input, '@channel');
      _mentionQuery = null;
      renderMentionPopup();
    }],

    /* ── header + view tabs ── */
    ['#chat-hamburger', () => { _mobileSidebarOpen = true; render(); }],
    ['#chat-sub-toggle', async () => {
      const subscribed = _userMeta?.subscribedChannels?.includes(_activeChannelId);
      if (subscribed) await unsubscribeFromChannel(_activeChannelId);
      else await subscribeToChannel(_activeChannelId);
      render();
    }],
    ['#chat-pinned-btn', () => {
      if (isMobile()) _showPinned = !_showPinned;
      else _desktopView = _desktopView === 'pinned' ? 'chat' : 'pinned';
      render();
    }],
    ['#chat-header-search', () => { _searchQuery = ''; if (isMobile()) _mobileTab = 'search'; else _showSearch = true; render(); }],
    ['#chat-call-btn', () => {
      // V3.525 — Slack-style huddle: start/join the channel's voice call
      const ch = _channels.find(c => c.id === _activeChannelId);
      if (!ch || !window.VOICE_CALL) return;
      VOICE_CALL.open(_activeChannelId, {
        channelName: channelLabelFor(ch.id),
        memberUids: callMemberUids(ch),
      });
    }],
    /* V3.584 — incoming-call banner: answer or decline */
    ['[data-vc-ring-join]', el => {
      const chId = el.dataset.vcRingJoin;
      if (!window.VOICE_CALL) return;
      if (_activeChannelId !== chId) selectChannel(chId); // land in the conversation too
      VOICE_CALL.open(chId, {
        channelName: channelLabelFor(chId, VOICE_CALL.getActiveCall(chId)),
        memberUids: callMemberUids(_channels.find(c => c.id === chId)),
      });
    }],
    ['[data-vc-ring-decline]', el => {
      window.VOICE_CALL?.decline(el.dataset.vcRingDecline);
    }],
    ['[data-view-tab]', el => { _desktopView = el.dataset.viewTab; render(); }],

    /* ── sidebar ── */
    ['#chat-sidebar-close', () => { _mobileSidebarOpen = false; render(); }],
    ['#chat-sidebar-overlay', () => { _mobileSidebarOpen = false; render(); }],
    ['#chat-browse-channels', () => { _showChannelDirectory = true; render(); }],
    ['#chat-manage-contacts-btn', () => { _showManageContacts = true; render(); }],
    ['#chat-new-dm-btn', () => { _showNewDM = true; render(); }],
    ['#chat-search-btn', () => { _showSearch = true; _searchQuery = ''; render(); }],
    ['#chat-settings-btn', () => { _showSettings = true; render(); }],
    ['[data-dm-contact]', el => { _mobileSidebarOpen = false; createDM([el.dataset.dmContact]); }],
    ['[data-channel]', el => { _mobileSidebarOpen = false; selectChannel(el.dataset.channel); }],

    /* ── mobile chrome ── */
    ['[data-chat-tab]', el => {
      _mobileTab = el.dataset.chatTab;
      if (_mobileTab === 'search') { _showSearch = true; _searchQuery = ''; }
      render();
    }],
    ['#mobile-hamburger-btn', () => { _mobileHamburgerOpen = true; render(); }],
    ['#mobile-hamburger-close', () => { _mobileHamburgerOpen = false; render(); }],
    ['#mobile-hamburger-overlay', () => { _mobileHamburgerOpen = false; render(); }],
    ['#mobile-menu-browse', () => { _mobileHamburgerOpen = false; _showChannelDirectory = true; render(); }],
    ['#mobile-menu-new-dm', () => { _mobileHamburgerOpen = false; _showNewDM = true; render(); }],
    ['#mobile-menu-contacts', () => { _mobileHamburgerOpen = false; _showManageContacts = true; render(); }],
    ['#mobile-menu-settings', () => { _mobileHamburgerOpen = false; _showSettings = true; render(); }],
    ['#mobile-menu-all-apps', (el, e) => { e.preventDefault(); window.parent.location.hash = '#/apps'; }],
    ['[data-app-nav="chat"]', (el, e) => e.preventDefault()],
    ['[data-conv-channel]', el => selectChannel(el.dataset.convChannel)],

    /* ── mobile overview ── */
    ['#chat-overview-manage-contacts', () => { _showManageContacts = true; render(); }],
    ['#chat-overview-browse', () => { _showChannelDirectory = true; render(); }],
    ['#chat-overview-new-dm', () => { _showNewDM = true; render(); }],
    ['#chat-overview-search', () => { _searchQuery = ''; if (isMobile()) _mobileTab = 'search'; else _showSearch = true; render(); }],
    ['[data-overview-channel]', el => selectChannel(el.dataset.overviewChannel)],
    ['[data-overview-dm]', el => {
      const uid = el.dataset.overviewDm;
      const dmCh = _channels.find(c => c.type === 'dm' && c.members && c.members.includes(uid) && c.members.includes(_user.uid));
      if (dmCh) selectChannel(dmCh.id);
      else createDM([uid]);
    }],
    ['[data-toggle-section]', el => {
      const key = el.dataset.toggleSection;
      if (_collapsedSections.has(key)) _collapsedSections.delete(key);
      else _collapsedSections.add(key);
      render();
    }],

    /* ── modals (inner controls BEFORE [data-close-modal]) ── */
    ['#chat-create-channel-btn', () => { _showChannelDirectory = false; _showCreateChannel = true; render(); }],
    ['#chat-do-create', () => {
      const name = document.getElementById('chat-new-name')?.value?.trim();
      const display = document.getElementById('chat-new-display')?.value?.trim();
      const desc = document.getElementById('chat-new-desc')?.value?.trim();
      const cat = document.getElementById('chat-new-category')?.value;
      const announce = document.getElementById('chat-new-announce')?.checked || false;
      if (!name) { showToast('Channel name is required'); return; }
      if (!cat) { showToast('Please select a category'); return; }
      createChannel(name, display, desc, cat, announce);
    }],
    ['[data-sub-dir]', async el => { await subscribeToChannel(el.dataset.subDir); render(); }],
    ['[data-unsub-dir]', async el => { await unsubscribeFromChannel(el.dataset.unsubDir); render(); }],
    ['[data-dir-channel]', el => { _showChannelDirectory = false; selectChannel(el.dataset.dirChannel); }],
    ['#chat-save-settings', () => {
      const categories = [];
      document.querySelectorAll('[data-cat-idx]').forEach(inp => {
        const val = inp.value.trim();
        if (val) categories.push(val);
      });
      saveConfig({ categories });
      _showSettings = false;
      render();
    }],
    ['#chat-add-cat', () => {
      const list = document.getElementById('chat-categories-list');
      if (!list) return;
      const idx = list.children.length;
      const row = document.createElement('div');
      row.className = 'chat-settings-row';
      row.innerHTML = `<input class="app-input" value="" data-cat-idx="${idx}" placeholder="New category" />
        <button class="chat-icon-btn chat-icon-btn--danger" data-remove-cat="${idx}">${svgTrash()}</button>`;
      list.appendChild(row);
      row.querySelector('input').focus();
    }],
    ['[data-remove-cat]', el => el.closest('.chat-settings-row')?.remove()],
    ['#chat-add-admin-btn', async () => {
      const select = document.getElementById('chat-add-admin-select');
      const uid = select?.value;
      if (!uid) return;
      await saveConfig({ chatAdmins: [...(_config.chatAdmins || []), uid] });
      _showSettings = true;
      render();
    }],
    ['[data-remove-admin]', async el => {
      const admins = (_config.chatAdmins || []).filter(a => a !== el.dataset.removeAdmin);
      await saveConfig({ chatAdmins: admins });
      _showSettings = true;
      render();
    }],
    ['[data-dm-user]', el => createDM([el.dataset.dmUser])],
    ['#chat-add-contact-group', () => {
      if (!_userMeta.dmContacts) _userMeta.dmContacts = [];
      _userMeta.dmContacts.push({ groupName: 'New Group', uids: [] });
      saveDmContacts();
      render();
    }],
    ['[data-remove-contact-group]', el => {
      _userMeta.dmContacts.splice(parseInt(el.dataset.removeContactGroup), 1);
      saveDmContacts();
      render();
    }],
    ['[data-remove-contact]', el => {
      const uid = el.dataset.removeContact;
      for (const group of (_userMeta.dmContacts || [])) {
        group.uids = (group.uids || []).filter(id => id !== uid);
      }
      saveDmContacts();
      render();
    }],
    ['[data-do-add-contact]', el => {
      const uid = el.dataset.doAddContact;
      if (!_userMeta.dmContacts) _userMeta.dmContacts = [];
      if (_userMeta.dmContacts.length === 0) {
        _userMeta.dmContacts.push({ groupName: 'Contacts', uids: [uid] });
      } else if (!_userMeta.dmContacts[0].uids.includes(uid)) {
        _userMeta.dmContacts[0].uids.push(uid);
      }
      saveDmContacts();
      render();
    }],
    ['#chat-save-contacts', () => { _showManageContacts = false; render(); }],
    ['#chat-backfill-subs', async el => {
      if (el.disabled) return;
      el.disabled = true;
      el.textContent = 'Backfilling…';
      try {
        const user = (typeof firebridge !== 'undefined' && firebridge.getUser) ? firebridge.getUser() : null;
        if (!user) throw new Error('Not signed in');
        const idToken = await user.getIdToken();
        const resp = await fetch(BACKFILL_FN_URL, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json', 'Authorization': 'Bearer ' + idToken },
          body: '{}'
        });
        const out = await resp.json().catch(() => ({}));
        if (!resp.ok) throw new Error(out.error || resp.statusText);
        showToast(`Subscriber lists rebuilt for ${out.channels} channels (${out.users} users scanned)`);
      } catch (e) {
        showToast('Backfill failed: ' + (e.message || e));
      } finally {
        el.disabled = false;
        el.textContent = 'Backfill subscriber lists';
      }
    }],
    /* ── V3.582 Slack-history import ── */
    ['#chat-import-btn', () => openImportModal()],
    ['#chat-import-next', () => importGoNext()],
    ['#chat-import-back', el => {
      _importState.step = el.dataset.backTo || 'input';
      _importState.error = null;
      updateModals();
    }],
    ['#chat-import-run', () => runImport()],
    ['[data-import-remove]', el => {
      if (_importState?.busy) return;
      if (!confirm('Remove this entire imported history from the conversation?')) return;
      removeImportBatch(el.dataset.importRemove);
    }],
    ['[data-close-modal]', (el, e) => {
      // Backdrop overlays carry data-close-modal too — only close when
      // the click is on the backdrop itself, not inside the dialog.
      // (Inline stopPropagation was removed so delegated routes fire.)
      if (el.classList.contains('chat-modal-overlay') && e.target.closest('.chat-modal')) return;
      const which = el.dataset.closeModal;
      if (which === 'directory') _showChannelDirectory = false;
      if (which === 'create') _showCreateChannel = false;
      if (which === 'settings') _showSettings = false;
      if (which === 'pinned') _showPinned = false;
      if (which === 'search') _showSearch = false;
      if (which === 'newdm') _showNewDM = false;
      if (which === 'contacts') _showManageContacts = false;
      if (which === 'seenby') _showSeenBy = null;
      if (which === 'import') {
        if (_importState?.busy) return; // no closing mid-import
        _showImport = false;
        _importState = null;
      }
      render();
    }],

    /* ── broad containers LAST ── */
    ['[data-msg-select]', (el, e) => {
      // Don't select when clicking a link/button/interactive element
      if (e.target.closest('a, button, textarea, input, select, .chat-reaction, .chat-thread-indicator, .chat-msg-receipt-eye')) return;
      const msgId = el.dataset.msgSelect;
      _selectedMsgId = _selectedMsgId === msgId ? null : msgId;
      document.querySelectorAll('.chat-msg--selected').forEach(m => m.classList.remove('chat-msg--selected'));
      const oldBar = document.querySelector('.chat-action-bar');
      if (oldBar) oldBar.remove();
      if (_selectedMsgId) {
        el.classList.add('chat-msg--selected');
        el.style.position = 'relative';
        el.insertAdjacentHTML('afterbegin', renderMsgActionBarHTML());
      }
    }]
  ];

  function wireDelegatedClicks() {
    appEl.addEventListener('click', (e) => {
      for (const [sel, fn] of CLICK_ROUTES) {
        const el = e.target.closest(sel);
        if (el && appEl.contains(el)) { fn(el, e); return; }
      }
    });
  }

  function clearMsgSelection() {
    _selectedMsgId = null;
    document.querySelectorAll('.chat-msg--selected').forEach(m => m.classList.remove('chat-msg--selected'));
    const bar = document.getElementById('chat-action-bar');
    if (bar) bar.remove();
  }

  let _onWindowResize = null;

  function wireLayoutResize() {
    _onWindowResize = () => {
      clearTimeout(_resizeTimer);
      _resizeTimer = setTimeout(() => {
        const mode = isMobile() ? 'mobile' : 'desktop';
        if (mode !== _shellMode) render(); // crossing 700px rebuilds the shell
        else updateStickyOffsets();        // nav/header heights shift with width
      }, 150);
    };
    window.addEventListener('resize', _onWindowResize);
  }

  /* ═══════════════════════════════════════════════════════════
     LIFECYCLE — destroy() (R2)
     Chat mounts inside split-view iframes and shell popouts, which
     detach/replace the page without a full navigation. Without an
     explicit teardown the Firestore listeners and document-level
     handlers leak across mounts. Convention per annotation-overlay.js:
     expose a window-level handle + self-hook on pagehide.
     ═══════════════════════════════════════════════════════════ */
  /* ═══════════════════════════════════════════════════════════
     TAB-LIFECYCLE PAUSE/RESUME (V3.585 — Ourlab app multi-WebView shell)
     While this WebView is a hidden background tab: detach EVERY Firestore
     listener but keep all state + DOM warm (_messages/_channels/
     _activeChannelId/_threadParentId/_mobileTab/_userMeta/_readStates and
     the rendered feed), so swapping back paints instantly and the
     re-attached snapshots repaint once with fresh data. destroy() remains
     the full teardown for real page unloads — a paused page can still be
     destroyed (all detaches are null-guarded).
     Accepted UX (by design): resume returns the feed to the live tail —
     a user parked deep in history-mode scrollback comes back to bottom.
     ═══════════════════════════════════════════════════════════ */
  function pauseChat() {
    if (_paused) return;
    _paused = true;
    try { saveDraft(); } catch (_) {}
    clearTimeout(_typingClearTimer);
    try { writeTyping(null); } catch (_) {}   // don't stay "typing…" while hidden
    // V3.596 — stop claiming the channel too, so chat pushes resume while
    // this tab sits in the background. Same "last write before detaching"
    // slot as writeTyping(null) above.
    try { window.RM_PRESENCE && window.RM_PRESENCE.setContext([]); } catch (_) {}
    clearInterval(_heartbeatTimer);
    _heartbeatTimer = null;                    // presence drifts to away — chosen policy
    if (_onVisibilityChange) {
      // startPresence() re-adds this on resume — MUST remove here or it
      // duplicates on every pause/resume cycle (listener leak).
      document.removeEventListener('visibilitychange', _onVisibilityChange);
      _onVisibilityChange = null;
    }
    clearTimeout(_typingRerenderTimer);
    clearTimeout(_alertTimer);
    _hadUserMeta = !!_unsubUserMeta;           // subscribeUserMeta isn't part of the
                                               // init sequence — only re-attach if live
    _unsubs.splice(0).forEach(u => { try { u(); } catch (_) {} });
    [_unsubChannels, _unsubMessages, _unsubReadState, _unsubThread, _unsubUserMeta, _unsubChannelReadStates]
      .forEach(u => { try { u && u(); } catch (_) {} });
    _unsubChannels = _unsubMessages = _unsubReadState = _unsubThread = _unsubUserMeta = _unsubChannelReadStates = null;
    // Deliberately NOT touched: DOM, message/channel caches, active channel,
    // thread id, gesture/swipe/resize/scroll wiring (document stays alive).
  }

  function resumeChat() {
    if (!_paused) return;
    _paused = false;
    if (!_user) return;            // hidden/visible arrived before init finished
    _alertInit = false;            // first resumed channels snapshot re-baselines
                                   // _lastMsgSeen — no alert storm for missed msgs
    _suppressAutoSelect = !_activeChannelId;  // parked on Overview: stay there
    if (_activeChannelId) {
      // REUSE the V3.581 validation only: the next channels snapshot
      // re-renders if the channel survived, or clears + falls back if it was
      // deleted while hidden. The parse-time pre-seed (_restoreChannelId)
      // is init-only and never re-runs.
      _pendingRestore = true;
      subscribeMessages(_activeChannelId);   // also re-attaches channel read
                                             // states; snapshot marks read
      if (_threadParentId) subscribeThread(_threadParentId);
    }
    subscribeChannels();
    subscribeReadState();
    subscribeUsers();
    subscribeConfig();
    if (_hadUserMeta) subscribeUserMeta();
    startPresence();               // subscribePresence + immediate heartbeat +
                                   // fresh visibilitychange listener (old one
                                   // was removed in pauseChat)
    publishPresenceContext();      // V3.596 — re-claim the channel we dropped
  }

  function destroy() {
    // V3.596 — unmounting (split-view swap, shell popout) fires no pagehide,
    // so drop the channel claim explicitly or it lingers for FRESH_MS.
    try { window.RM_PRESENCE && window.RM_PRESENCE.setContext([]); } catch (_) {}
    _unsubs.splice(0).forEach(u => { try { u(); } catch (_) {} });
    [_unsubChannels, _unsubMessages, _unsubReadState, _unsubThread, _unsubUserMeta, _unsubChannelReadStates]
      .forEach(u => { try { u && u(); } catch (_) {} });
    _unsubChannels = _unsubMessages = _unsubReadState = _unsubThread = _unsubUserMeta = _unsubChannelReadStates = null;
    document.removeEventListener('gesturestart', _onGestureStart);
    document.removeEventListener('gesturechange', _onGestureChange);
    if (_onSwipeStart) document.removeEventListener('touchstart', _onSwipeStart);
    if (_onSwipeEnd) document.removeEventListener('touchend', _onSwipeEnd);
    if (_onWindowResize) window.removeEventListener('resize', _onWindowResize);
    if (_onPageScroll) window.removeEventListener('scroll', _onPageScroll);
    if (_onVisibilityChange) document.removeEventListener('visibilitychange', _onVisibilityChange);
    clearInterval(_heartbeatTimer);
    clearTimeout(_typingClearTimer);
    clearTimeout(_typingRerenderTimer);
    clearTimeout(_searchDebounceTimer);
    _searchScanGen++; // cancel any in-flight progressive search loop
    clearTimeout(_alertTimer);
    const cornerAlert = document.getElementById('chat-corner-alert');
    if (cornerAlert) cornerAlert.remove();
    clearTimeout(_draftSaveTimer);
    clearTimeout(_toastTimer);
    clearTimeout(_resizeTimer);
    clearTimeout(_callRingTimer);
    window.removeEventListener('voice-call-change', _onVoiceCallChange);
    try { writeTyping(null); } catch (_) {} // best-effort typing clear
    try { saveDraft(); } catch (_) {} // don't lose in-progress text on teardown
  }

  window.CHAT_PAGE = { destroy, pause: pauseChat, resume: resumeChat };
  // V3.585 — page hook consumed by tab-lifecycle.js on 'ourlab:tab-hidden'/
  // 'ourlab:tab-visible' (Ourlab app shell). Inert on web (events never fire).
  window.OURLAB_TAB_LIFECYCLE = { pause: pauseChat, resume: resumeChat };
  window.addEventListener('pagehide', destroy, { once: true });

  // Sidebar non-click wiring: drag-drop channel organization +
  // contenteditable group names. Clicks are delegated (CLICK_ROUTES).
  function wireSidebarNonClick() {
    // Sidebar drag and drop for channel organization
    document.querySelectorAll('.chat-sidebar-item[draggable]').forEach(el => {
      el.addEventListener('dragstart', (e) => {
        _dragChannelId = el.dataset.channel;
        e.dataTransfer.effectAllowed = 'move';
        el.classList.add('chat-dragging');
      });
      el.addEventListener('dragend', () => {
        _dragChannelId = null;
        el.classList.remove('chat-dragging');
        document.querySelectorAll('.chat-drag-over').forEach(d => d.classList.remove('chat-drag-over'));
      });
    });

    document.querySelectorAll('.chat-sidebar-group').forEach(groupEl => {
      groupEl.addEventListener('dragover', (e) => {
        e.preventDefault();
        e.dataTransfer.dropEffect = 'move';
        groupEl.classList.add('chat-drag-over');
      });
      groupEl.addEventListener('dragleave', () => {
        groupEl.classList.remove('chat-drag-over');
      });
      groupEl.addEventListener('drop', (e) => {
        e.preventDefault();
        groupEl.classList.remove('chat-drag-over');
        if (!_dragChannelId) return;
        const targetGroupIdx = parseInt(groupEl.dataset.group);
        moveChannelToGroup(_dragChannelId, targetGroupIdx);
      });
    });

    // Group name editing
    document.querySelectorAll('.chat-sidebar-group-name[contenteditable]').forEach(el => {
      el.addEventListener('blur', () => {
        const gi = parseInt(el.dataset.group);
        const newName = el.textContent.trim();
        if (newName && _userMeta.sidebarLayout[gi]) {
          _userMeta.sidebarLayout[gi].groupName = newName;
          saveSidebarLayout();
        }
      });
      el.addEventListener('keydown', (e) => {
        if (e.key === 'Enter') { e.preventDefault(); el.blur(); }
      });
    });

  }

  function wireInput() {
    const input = document.getElementById('chat-input');
    if (!input) return;

    // Auto-grow textarea
    input.addEventListener('input', () => {
      input.style.height = 'auto';
      input.style.height = Math.min(input.scrollHeight, 150) + 'px';

      // Debounced draft save
      clearTimeout(_draftSaveTimer);
      _draftSaveTimer = setTimeout(() => saveDraft(), 500);

      // R5 — typing indicator: throttled declare + inactivity clear
      writeTyping(_activeChannelId);
      clearTimeout(_typingClearTimer);
      _typingClearTimer = setTimeout(() => writeTyping(null), TYPING_TTL_MS);

      // Mention detection
      const cursorPos = input.selectionStart;
      const textBefore = input.value.substring(0, cursorPos);
      const mentionMatch = textBefore.match(/@(\w*)$/);
      if (mentionMatch) {
        _mentionQuery = mentionMatch[1];
        _mentionIndex = 0;
        renderMentionPopup();
      } else if (_mentionQuery !== null) {
        _mentionQuery = null;
        renderMentionPopup();
      }
    });

    input.addEventListener('keydown', (e) => {
      if (_mentionQuery !== null) {
        const suggestions = getMentionSuggestions(_mentionQuery);
        const total = suggestions.length + 1; // +1 for @channel
        if (e.key === 'ArrowDown') {
          e.preventDefault();
          _mentionIndex = (_mentionIndex + 1) % total;
          renderMentionPopup();
          return;
        }
        if (e.key === 'ArrowUp') {
          e.preventDefault();
          _mentionIndex = (_mentionIndex - 1 + total) % total;
          renderMentionPopup();
          return;
        }
        if (e.key === 'Enter' || e.key === 'Tab') {
          e.preventDefault();
          if (_mentionIndex === suggestions.length) {
            insertMention(input, '@channel');
          } else if (suggestions[_mentionIndex]) {
            const u = suggestions[_mentionIndex];
            const mentionText = (u.name || u.displayName || u.email).replace(/\s+/g, '.');
            insertMention(input, `@${mentionText}`);
          }
          _mentionQuery = null;
          renderMentionPopup();
          return;
        }
        if (e.key === 'Escape') {
          _mentionQuery = null;
          renderMentionPopup();
          return;
        }
      }

      // Send on Enter (without Shift)
      if (e.key === 'Enter' && !e.shiftKey) {
        e.preventDefault();
        handleSend(input);
      }
    });

    // Send + attach button CLICKS are delegated (CLICK_ROUTES); only the
    // file input's change event needs re-wiring with the region.
    const fileInput = document.getElementById('chat-file-input');
    if (fileInput) {
      fileInput.addEventListener('change', async () => {
        const files = Array.from(fileInput.files || []);
        if (!files.length) return;
        await handleFilesUpload(files, input);
        fileInput.value = '';
      });
    }

    // R5 — leaving the composer clears the typing state
    input.addEventListener('blur', () => { clearTimeout(_typingClearTimer); writeTyping(null); });

    // Clipboard paste
    input.addEventListener('paste', async (e) => {
      const items = e.clipboardData?.items;
      if (!items) return;
      for (const item of items) {
        if (item.type.startsWith('image/')) {
          e.preventDefault();
          const file = item.getAsFile();
          if (file) await handleFileUpload(file, input);
          return;
        }
      }
    });
  }

  // Thread composer non-click wiring (send/close clicks are delegated).
  function wireThreadInput() {
    const threadInput = document.getElementById('chat-thread-input');
    if (!threadInput) return;
    threadInput.addEventListener('keydown', (e) => {
      if (e.key === 'Enter' && !e.shiftKey) {
        e.preventDefault();
        handleThreadSend(threadInput);
      }
    });
    threadInput.addEventListener('input', () => {
      threadInput.style.height = 'auto';
      threadInput.style.height = Math.min(threadInput.scrollHeight, 100) + 'px';
    });
  }

  // Modal non-click wiring: search filters, role selects, group-name
  // inputs, contact drag-drop. Button clicks are delegated (CLICK_ROUTES).
  function wireModalsNonClick() {
    // ── V3.582 Slack-history import modal ──
    // File pick → parse immediately (re-render shows the summary line).
    const importFile = document.getElementById('chat-import-file');
    if (importFile) {
      importFile.addEventListener('change', () => {
        const f = importFile.files && importFile.files[0];
        if (!f) return;
        const reader = new FileReader();
        reader.onload = () => importHandleParsedText(String(reader.result || ''), f.name);
        reader.onerror = () => { _importState.error = 'Could not read that file.'; updateModals(); };
        reader.readAsText(f);
      });
    }
    // Mapping selects → update mapping in place (no re-render needed).
    document.querySelectorAll('[data-import-map]').forEach(el => {
      el.addEventListener('change', () => {
        const slackName = el.dataset.importMap;
        const v = el.value;
        if (v === '__skip__') {
          _importState.mapping[slackName] = 'SKIP';
        } else if (v === '__nameonly__') {
          _importState.mapping[slackName] = { uid: null, displayName: slackName };
        } else {
          const u = _allUsers.find(x => x.uid === v);
          _importState.mapping[slackName] = { uid: v, displayName: u ? (u.name || u.displayName || u.email) : slackName };
        }
      });
    });

    // Directory search
    const dirSearch = document.getElementById('chat-dir-search');
    if (dirSearch) {
      dirSearch.addEventListener('input', () => {
        const q = dirSearch.value.toLowerCase();
        document.querySelectorAll('.chat-directory-item').forEach(item => {
          const text = item.textContent.toLowerCase();
          item.style.display = text.includes(q) ? '' : 'none';
        });
      });
    }

    // DM search filter
    const dmSearch = document.getElementById('chat-dm-search');
    if (dmSearch) {
      dmSearch.focus();
      dmSearch.addEventListener('input', () => {
        const q = dmSearch.value.toLowerCase();
        document.querySelectorAll('.chat-dm-user-item').forEach(item => {
          const name = item.querySelector('.chat-dm-user-name')?.textContent?.toLowerCase() || '';
          item.style.display = name.includes(q) ? '' : 'none';
        });
        // Hide empty category labels
        document.querySelectorAll('.chat-dm-category-label').forEach(label => {
          let next = label.nextElementSibling;
          let hasVisible = false;
          while (next && !next.classList.contains('chat-dm-category-label')) {
            if (next.style.display !== 'none') hasVisible = true;
            next = next.nextElementSibling;
          }
          label.style.display = hasVisible ? '' : 'none';
        });
      });
    }

    // ── Manage Contacts modal non-click wiring ──
    // Rename contact group
    document.querySelectorAll('[data-contact-group-name]').forEach(el => {
      el.addEventListener('blur', () => {
        const gi = parseInt(el.dataset.contactGroupName);
        const name = el.value.trim();
        if (name && _userMeta.dmContacts[gi]) {
          _userMeta.dmContacts[gi].groupName = name;
          saveDmContacts();
        }
      });
      el.addEventListener('keydown', (e) => { if (e.key === 'Enter') { e.preventDefault(); el.blur(); } });
    });

    // Contact search filter
    const contactSearch = document.getElementById('chat-contact-search');
    if (contactSearch) {
      contactSearch.addEventListener('input', () => {
        const q = contactSearch.value.toLowerCase();
        document.querySelectorAll('.chat-contact-add-item').forEach(item => {
          const name = item.querySelector('.chat-contact-add-name')?.textContent?.toLowerCase() || '';
          item.style.display = name.includes(q) ? '' : 'none';
        });
        document.querySelectorAll('.chat-contacts-available .chat-dm-category-label').forEach(label => {
          let next = label.nextElementSibling;
          let hasVisible = false;
          while (next && !next.classList.contains('chat-dm-category-label')) {
            if (next.style.display !== 'none') hasVisible = true;
            next = next.nextElementSibling;
          }
          label.style.display = hasVisible ? '' : 'none';
        });
      });
    }

    // Chat role changes
    document.querySelectorAll('[data-set-role]').forEach(el => {
      el.addEventListener('change', async () => {
        const uid = el.dataset.setRole;
        const role = el.value;
        const roles = Object.assign({}, _config.userRoles || {});
        if (role === 'editor') {
          delete roles[uid]; // editor is default, no need to store
        } else {
          roles[uid] = role;
        }
        await saveConfig({ userRoles: roles });
        // Also sync chatAdmins array for Firestore rules
        const admins = Object.entries(roles).filter(([, r]) => r === 'admin').map(([u]) => u);
        await saveConfig({ chatAdmins: admins });
        showToast(`Role updated to ${role}`);
      });
    });

    // Drag contacts between groups
    document.querySelectorAll('.chat-contact-item[draggable]').forEach(el => {
      el.addEventListener('dragstart', (e) => {
        e.dataTransfer.setData('text/plain', el.dataset.contactUid);
        el.classList.add('chat-dragging');
      });
      el.addEventListener('dragend', () => el.classList.remove('chat-dragging'));
    });
    document.querySelectorAll('[data-contact-drop]').forEach(dropZone => {
      dropZone.addEventListener('dragover', (e) => { e.preventDefault(); dropZone.classList.add('chat-drag-over'); });
      dropZone.addEventListener('dragleave', () => dropZone.classList.remove('chat-drag-over'));
      dropZone.addEventListener('drop', (e) => {
        e.preventDefault();
        dropZone.classList.remove('chat-drag-over');
        const uid = e.dataTransfer.getData('text/plain');
        const targetGi = parseInt(dropZone.dataset.contactDrop);
        if (!uid || isNaN(targetGi)) return;
        // Remove from all groups
        for (const group of (_userMeta.dmContacts || [])) {
          group.uids = (group.uids || []).filter(id => id !== uid);
        }
        // Add to target
        if (_userMeta.dmContacts[targetGi]) {
          _userMeta.dmContacts[targetGi].uids.push(uid);
        }
        saveDmContacts();
        render();
      });
    });

    // Search input — R6 progressive scan, 400ms debounce; result clicks
    // ([data-goto-msg]) and scope buttons are delegated.
    const searchInput = document.getElementById('chat-search-input');
    if (searchInput) {
      searchInput.focus();
      try { searchInput.setSelectionRange(searchInput.value.length, searchInput.value.length); } catch (e) {}
      searchInput.addEventListener('input', () => {
        _searchQuery = searchInput.value;
        clearTimeout(_searchDebounceTimer);
        _searchDebounceTimer = setTimeout(() => runProgressiveSearch(_searchQuery), 400);
      });
      // Re-opened (or scope-switched) with a query already present
      if (_searchQuery.trim()) runProgressiveSearch(_searchQuery);
    }
  }

  function wireFileDrop() {
    const feed = document.getElementById('chat-feed');
    const inputArea = document.getElementById('chat-input-area');
    [feed, inputArea].forEach(el => {
      if (!el) return;
      el.addEventListener('dragover', (e) => {
        e.preventDefault();
        e.dataTransfer.dropEffect = 'copy';
        el.classList.add('chat-file-drop-active');
      });
      el.addEventListener('dragleave', () => el.classList.remove('chat-file-drop-active'));
      el.addEventListener('drop', async (e) => {
        e.preventDefault();
        el.classList.remove('chat-file-drop-active');
        const files = Array.from(e.dataTransfer.files || []);
        if (files.length) {
          const input = document.getElementById('chat-input');
          await handleFilesUpload(files, input);
        }
      });
    });
  }

  // Shared scroll-state logic for BOTH scrollers (the document — the
  // real one today — and the feed element, future-proof).
  function handleFeedScrollState(scrollTopOfScroller) {
    if (_isRendering) return; // Don't update scroll state during DOM rebuilds
    if (!document.getElementById('chat-feed')) return; // feed not on screen
    const atBottom = feedAtBottom();
    if (_feedMode === 'live') _autoScroll = atBottom;
    // Scrolling up/down flips isWatchingFeed() without a re-render.
    publishPresenceContext();
    // Remove new messages button if at bottom
    if (atBottom) {
      const btn = document.getElementById('chat-new-msgs-btn');
      if (btn) btn.remove();
    }
    // Load older on scroll to top
    if (scrollTopOfScroller < 80 && _hasMoreMessages && !_loadingOlder) {
      loadOlderMessages();
    }
    // R6 — history mode: scroll near bottom walks toward the tail
    if (_feedMode === 'history' && atBottom) loadNewerMessages();
  }

  function wireFeedScroll() {
    const feed = document.getElementById('chat-feed');
    if (!feed) return;
    // Future-proof: fires only if the feed ever scrolls internally
    feed.addEventListener('scroll', () => handleFeedScrollState(feed.scrollTop));
    // Open-at-bottom fix — images/attachments finish loading AFTER the
    // initial scrollToBottom and grow the page, which used to strand
    // the view mid-history on open. `load` doesn't bubble, so a
    // capture-phase listener on the feed re-pins for every inner <img>
    // while the feed is in follow mode.
    feed.addEventListener('load', () => {
      if (_feedMode === 'live' && _autoScroll) pinFeedToBottom();
    }, true);
  }

  // V3.522 — the DOCUMENT is the real scroller (see pinFeedToBottom):
  // one window-level listener drives autoscroll tracking, load-older on
  // reaching the top, and history-mode load-newer. Attached once in
  // bootstrap; removed in destroy().
  let _onPageScroll = null;

  function wirePageScroll() {
    _onPageScroll = () => handleFeedScrollState(pageScroller().scrollTop);
    window.addEventListener('scroll', _onPageScroll, { passive: true });
  }

  /* ═══════════════════════════════════════════════════════════
     SEND HELPERS
     ═══════════════════════════════════════════════════════════ */
  async function handleSend(input) {
    const text = input.value.trim();
    if (!text) return;
    input.value = '';
    input.style.height = 'auto';
    _autoScroll = true;
    _selectedMsgId = null;
    clearTimeout(_typingClearTimer);
    writeTyping(null);
    // R6 — sending from a history window returns to the live tail first
    if (_feedMode === 'history') transitionToLive(true);
    await sendMessage(text, null, null);
  }

  async function handleThreadSend(input) {
    const text = input.value.trim();
    if (!text) return;
    input.value = '';
    input.style.height = 'auto';
    await sendMessage(text, null, _threadParentId);
  }

  async function handleFileUpload(file, textInput) {
    const fileData = await uploadFile(file);
    if (fileData) {
      const text = textInput?.value?.trim() || '';
      if (textInput) textInput.value = '';
      _autoScroll = true;
      await sendMessage(text || `Shared a file: ${file.name}`, fileData, null);
    }
  }

  // R3 — multi-file attach: sequential uploads, one message per file.
  // The composer text (if any) rides along as the first file's caption.
  async function handleFilesUpload(files, textInput) {
    for (let i = 0; i < files.length; i++) {
      if (files.length > 1) showToast(`Uploading ${i + 1} of ${files.length}…`);
      await handleFileUpload(files[i], textInput);
    }
  }

  function insertMention(input, mentionText) {
    const cursorPos = input.selectionStart;
    const textBefore = input.value.substring(0, cursorPos);
    const textAfter = input.value.substring(cursorPos);
    const atPos = textBefore.lastIndexOf('@');
    input.value = textBefore.substring(0, atPos) + mentionText + ' ' + textAfter;
    const newPos = atPos + mentionText.length + 1;
    input.setSelectionRange(newPos, newPos);
    input.focus();
  }

  function renderMentionPopup() {
    const existing = document.querySelector('.chat-mention-popup');
    if (existing) existing.remove();
    if (_mentionQuery === null) return;

    const wrapper = document.querySelector('.chat-input-wrapper');
    if (!wrapper) return;
    const html = renderMentionPopupHTML();
    if (!html) return;
    const div = document.createElement('div');
    div.innerHTML = html;
    const popup = div.firstElementChild;
    wrapper.appendChild(popup);
    // Item clicks ([data-mention-uid] / [data-mention-channel]) are
    // delegated — no per-popup wiring needed.
  }

  /* R3 — generalized emoji picker: callers pass an onPick(emojiKey)
     callback. Reaction sites pass toggleReaction; the composer buttons
     insert the glyph at the caret. */
  function showEmojiPickerAt(triggerEl, onPick) {
    // Remove any existing picker
    const old = document.getElementById('chat-emoji-overlay');
    if (old) old.remove();

    const rect = triggerEl.getBoundingClientRect();
    const picker = document.createElement('div');
    picker.id = 'chat-emoji-overlay';
    picker.className = 'chat-emoji-picker';
    picker.innerHTML = EMOJI_SET.map(e =>
      `<button class="chat-emoji-btn" data-emoji="${e.key}" title="${e.key}">${e.label}</button>`
    ).join('');

    // Position above the button, flip down if too close to top
    const top = rect.top - 10;
    const placeAbove = top > 200;
    picker.style.left = Math.min(rect.left, window.innerWidth - 290) + 'px';
    picker.style.top = placeAbove ? '' : (rect.bottom + 4) + 'px';
    picker.style.bottom = placeAbove ? (window.innerHeight - rect.top + 4) + 'px' : '';

    document.body.appendChild(picker);

    // Wire emoji clicks
    picker.querySelectorAll('.chat-emoji-btn').forEach(btn => {
      btn.addEventListener('click', (e) => {
        e.stopPropagation();
        onPick(btn.dataset.emoji);
        picker.remove();
        _showEmojiPickerFor = null;
      });
    });

    // Close on click outside
    const closeHandler = (e) => {
      if (!picker.contains(e.target)) {
        picker.remove();
        _showEmojiPickerFor = null;
        document.removeEventListener('click', closeHandler);
      }
    };
    setTimeout(() => document.addEventListener('click', closeHandler), 0);
  }

  // R3 — insert text at the caret of a textarea (generalizes the
  // @-anchored insertMention; used by the composer emoji buttons).
  function insertAtCursor(input, text) {
    const start = input.selectionStart != null ? input.selectionStart : input.value.length;
    const end = input.selectionEnd != null ? input.selectionEnd : start;
    input.value = input.value.slice(0, start) + text + input.value.slice(end);
    const pos = start + text.length;
    input.setSelectionRange(pos, pos);
    input.focus();
  }

  /* ── V3.569: Ourlab app — emoji + formatting as fold-up sheets ── */
  function isOurlabApp() {
    try {
      return (window.Capacitor && Capacitor.isNativePlatform && Capacitor.isNativePlatform())
        || document.body.classList.contains('ourlab-app');
    } catch (e) { return false; }
  }

  // Insert into the composer WITHOUT stealing focus (so a bottom sheet
  // stays open + the keyboard doesn't cover it while picking emoji).
  function insertIntoComposer(text, keepFocusOut) {
    const input = document.getElementById('chat-input');
    if (!input) return;
    const s = input.selectionStart != null ? input.selectionStart : input.value.length;
    const e = input.selectionEnd != null ? input.selectionEnd : s;
    input.value = input.value.slice(0, s) + text + input.value.slice(e);
    const pos = s + text.length;
    try { input.setSelectionRange(pos, pos); } catch (_) {}
    if (!keepFocusOut) input.focus();
  }

  function wrapComposerSelection(marker, markerEnd) {
    const input = document.getElementById('chat-input');
    if (!input) return;
    const s = input.selectionStart != null ? input.selectionStart : input.value.length;
    const e = input.selectionEnd != null ? input.selectionEnd : s;
    const sel = input.value.slice(s, e);
    const close = markerEnd || marker;
    input.value = input.value.slice(0, s) + marker + sel + close + input.value.slice(e);
    const pos = s + marker.length + sel.length;
    try { input.setSelectionRange(pos, pos); } catch (_) {}
    input.focus();
  }

  function openComposerEmojiSheet() {
    APP_SHEET.open({
      title: 'Emoji',
      build: (body) => {
        const grid = document.createElement('div');
        grid.className = 'chat-emoji-sheet';
        grid.innerHTML = EMOJI_SET.map(e =>
          `<button type="button" class="chat-emoji-sheet-btn" data-emoji="${e.label}">${e.label}</button>`
        ).join('');
        grid.addEventListener('click', (ev) => {
          const b = ev.target.closest('[data-emoji]');
          if (b) insertIntoComposer(b.getAttribute('data-emoji'), true); // keep sheet open
        });
        body.appendChild(grid);
      },
    });
  }

  // A compact horizontal formatting toolbar (standard rich-text-editor
  // style: B, I, S, <>, code block, @) shown above the composer.
  function renderFormatBarHTML() {
    return `<div class="chat-format-bar">
      <button type="button" class="chat-fmt-btn" data-fmt="bold" title="Bold"><b>B</b></button>
      <button type="button" class="chat-fmt-btn" data-fmt="italic" title="Italic"><i>I</i></button>
      <button type="button" class="chat-fmt-btn" data-fmt="strike" title="Strikethrough"><span style="text-decoration:line-through">S</span></button>
      <button type="button" class="chat-fmt-btn" data-fmt="code" title="Inline code">&lt;&gt;</button>
      <button type="button" class="chat-fmt-btn chat-fmt-btn--wide" data-fmt="codeblock" title="Code block">&lt;/&gt;</button>
      <button type="button" class="chat-fmt-btn" data-fmt="mention" title="Mention">@</button>
    </div>`;
  }

  function applyFormat(kind) {
    switch (kind) {
      case 'bold':      return wrapComposerSelection('*');
      case 'italic':    return wrapComposerSelection('_');
      case 'strike':    return wrapComposerSelection('~');
      case 'code':      return wrapComposerSelection('`');
      case 'codeblock': return wrapComposerSelection('```\n', '\n```');
      case 'mention':   return insertIntoComposer('@');
    }
  }

  function moveChannelToGroup(channelId, targetGroupIdx) {
    // Remove from current group
    _userMeta.sidebarLayout.forEach(g => {
      g.channelIds = g.channelIds.filter(id => id !== channelId);
    });
    // Add to target group
    if (_userMeta.sidebarLayout[targetGroupIdx]) {
      _userMeta.sidebarLayout[targetGroupIdx].channelIds.push(channelId);
    }
    // Remove empty groups (except target)
    _userMeta.sidebarLayout = _userMeta.sidebarLayout.filter(g => g.channelIds.length > 0);
    saveSidebarLayout();
    renderSidebar();
  }

  /* ═══════════════════════════════════════════════════════════
     HELPERS
     ═══════════════════════════════════════════════════════════ */
  function isSiteAdmin() {
    return _profile?.role === 'admin' || McgheeLab?.AppBridge?.isAdmin?.();
  }

  function getChatRole(uid) {
    if (!uid) return 'editor';
    const roles = _config?.userRoles || {};
    // Site admins always treated as admin
    const u = _allUsers.find(a => a.uid === uid);
    if (u?.role === 'admin') return 'admin';
    return roles[uid] || 'editor'; // default to editor
  }

  function isChatAdmin() {
    if (isSiteAdmin()) return true;
    if (!_config || !_user) return false;
    return getChatRole(_user.uid) === 'admin';
  }

  function isChatReadOnly() {
    if (isSiteAdmin()) return false;
    return getChatRole(_user?.uid) === 'readonly';
  }

  // isAdmin = chat admin (controls settings, announcements, channels)
  function isAdmin() { return isChatAdmin(); }

  // Guests need explicit chatAccess: true on their user profile (set by admin)
  function canAccessChat(userOrProfile) {
    if (!userOrProfile) return false;
    const cat = (userOrProfile.category || '').toLowerCase();
    const role = (userOrProfile.role || '').toLowerCase();
    // Non-guest users always have access
    if (cat !== 'guest' && role !== 'guest') return true;
    // Guests need explicit approval
    return userOrProfile.chatAccess === true;
  }

  function escHTML(str) {
    if (str == null || str === '') return '';
    // V3.593 — coerce, don't assume string. Firestore fields aren't
    // type-checked by rules, so a numeric/array value (e.g. a malformed
    // voiceCalls.startedByName) used to throw `.replace is not a function`
    // out of a renderer and abort the whole render() pass.
    return String(str).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;').replace(/'/g, '&#39;');
  }

  function getInitials(name) {
    if (!name) return '?';
    // Escaped at the source — output is interpolated raw into HTML at
    // ~11 call sites (avatars, seen-by modal, contact rows).
    return escHTML(name.split(/\s+/).map(w => w[0]).slice(0, 2).join('').toUpperCase());
  }

  function tsToDate(ts) {
    if (!ts) return null;
    return ts.toDate ? ts.toDate() : new Date(ts);
  }

  function sameDay(a, b) {
    return !!(a && b) && a.getFullYear() === b.getFullYear()
      && a.getMonth() === b.getMonth() && a.getDate() === b.getDate();
  }

  // R3 — date separator label: Today / Yesterday / weekday+date / +year
  function formatDayLabel(d) {
    const now = new Date();
    const yesterday = new Date(now);
    yesterday.setDate(now.getDate() - 1);
    if (sameDay(d, now)) return 'Today';
    if (sameDay(d, yesterday)) return 'Yesterday';
    if (d.getFullYear() === now.getFullYear()) {
      return d.toLocaleDateString([], { weekday: 'long', month: 'short', day: 'numeric' });
    }
    return d.toLocaleDateString([], { month: 'short', day: 'numeric', year: 'numeric' });
  }

  // R3 — absolute clock time for the grouped-message hover gutter
  function formatClockTime(ts) {
    const d = tsToDate(ts);
    return d ? d.toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' }) : '';
  }

  // R3 — consecutive-message grouping: same author, both non-system,
  // < 5 min apart, same calendar day (so a group never straddles a
  // date separator).
  const GROUP_WINDOW_MS = 5 * 60 * 1000;
  function isGroupedWith(prev, msg) {
    if (!prev || !msg) return false;
    // Identity falls back to authorName: imported name-only messages
    // all share authorUid null, and two DIFFERENT Slack authors 1s
    // apart must not merge into one avatar block (V3.582).
    if ((prev.authorUid || prev.authorName) !== (msg.authorUid || msg.authorName)) return false;
    if (prev.type === 'system' || msg.type === 'system') return false;
    const a = tsToDate(prev.createdAt);
    const b = tsToDate(msg.createdAt);
    if (!a || !b || !sameDay(a, b)) return false;
    return (b - a) < GROUP_WINDOW_MS;
  }

  function formatTimestamp(ts) {
    if (!ts) return '';
    const date = ts.toDate ? ts.toDate() : new Date(ts);
    const now = new Date();
    const diff = now - date;
    if (diff < 60000) return 'just now';
    if (diff < 3600000) return `${Math.floor(diff / 60000)}m ago`;
    if (diff < 86400000 && date.getDate() === now.getDate()) {
      return date.toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' });
    }
    if (diff < 604800000) {
      return date.toLocaleDateString([], { weekday: 'short' }) + ' ' +
             date.toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' });
    }
    return date.toLocaleDateString([], { month: 'short', day: 'numeric' }) + ' ' +
           date.toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' });
  }

  function formatFileSize(bytes) {
    if (!bytes) return '';
    if (bytes < 1024) return bytes + ' B';
    if (bytes < 1048576) return (bytes / 1024).toFixed(1) + ' KB';
    if (bytes < 1073741824) return (bytes / 1048576).toFixed(1) + ' MB';
    return (bytes / 1073741824).toFixed(1) + ' GB';
  }

  function getUnreadCount(channelId) {
    const state = _readStates[channelId];
    const ch = _channels.find(c => c.id === channelId);
    if (!ch || !ch.lastMessage || !ch.lastMessage.timestamp) return 0;
    // Don't show unread badge if the last message is from the current user
    if (ch.lastMessage.authorUid === _user.uid) return 0;
    const totalMessages = ch.messageCount || 0;

    // Counter-based: if we have a stored readMessageCount, compute the difference
    if (state && typeof state.readMessageCount === 'number') {
      return Math.max(0, totalMessages - state.readMessageCount);
    }

    // Fallback for legacy read states (no readMessageCount yet):
    // use timestamp comparison but show at least 1 if there are unread messages
    if (!state || !state.lastReadAt) return totalMessages > 0 ? totalMessages : 1;
    const lastRead = state.lastReadAt.toDate ? state.lastReadAt.toDate() : new Date(state.lastReadAt);
    const lastMsg = ch.lastMessage.timestamp.toDate ? ch.lastMessage.timestamp.toDate() : new Date(ch.lastMessage.timestamp);
    return lastMsg > lastRead ? 1 : 0;
  }

  function getDMDisplayName(dm) {
    if (!dm || !dm.members) return dm?.displayName || 'DM';
    const otherUids = dm.members.filter(uid => uid !== _user.uid);
    return otherUids.map(uid => {
      const u = _allUsers.find(a => a.uid === uid);
      return u ? (u.name || u.displayName || u.email) : 'Unknown';
    }).join(', ');
  }

  function getDMOtherUser(dm) {
    if (!dm || !dm.members) return null;
    const otherUid = dm.members.find(uid => uid !== _user.uid);
    return _allUsers.find(u => u.uid === otherUid) || null;
  }

  /* ── Alumni auto-sort (Alex request) ──
     Curated contact groups store raw uids and never re-check
     users/{uid}.category, so someone who moved to alumni stayed under
     their old grouping forever. At render time, current alumni are
     pulled out of every curated group and shown in an automatic
     collapsed "Alumni" section instead. Pure render-time regrouping —
     no data migration; if a category is corrected they pop back into
     the original group. The New DM / Manage Contacts modals already
     group by LIVE category, so they were never stale. */
  function isAlumniUid(uid) {
    const u = _allUsers.find(a => a.uid === uid);
    return !!u && (u.category || '').toLowerCase() === 'alumni';
  }

  function splitContactsForRender() {
    const groups = [];
    const alumni = [];
    for (const group of (_userMeta?.dmContacts || [])) {
      const active = [];
      for (const uid of (group.uids || [])) {
        (isAlumniUid(uid) ? alumni : active).push(uid);
      }
      groups.push({ groupName: group.groupName, uids: active });
    }
    return { groups, alumni: [...new Set(alumni)] };
  }

  function getCategoryLabel(cat) {
    const labels = {
      pi: 'PI', postdoc: 'Postdoc', grad: 'Grad', undergrad: 'Undergrad',
      highschool: 'High School', alumni: 'Alumni', guest: 'Guest'
    };
    return labels[(cat || '').toLowerCase()] || 'Other';
  }

  /* ── Open-at-bottom (V3.522) ──
     THE actual scroller on the RM chat page is the DOCUMENT, not
     #chat-feed: rm/pages/chat.html mounts into #chat-root (no height
     constraint — chat.css's viewport rule targets the legacy #app id),
     so .chat-feed grows to content height and its overflow-y never
     engages. Every feed.scrollTop assignment since the V3.52 port has
     been a no-op — which is why chat opened at the TOP of history.
     All scroll logic now targets the document, with the feed kept as
     the target too in case a future layout makes it a real scroller. */
  function pageScroller() {
    return document.scrollingElement || document.documentElement;
  }

  function pinFeedToBottom() {
    const feed = document.getElementById('chat-feed');
    if (feed) feed.scrollTop = feed.scrollHeight; // no-op today, future-proof
    const de = pageScroller();
    de.scrollTop = de.scrollHeight;
  }

  function feedAtBottom() {
    const feed = document.getElementById('chat-feed');
    if (feed && feed.scrollHeight > feed.clientHeight + 1) {
      return feed.scrollHeight - feed.scrollTop - feed.clientHeight < 100;
    }
    const de = pageScroller();
    return de.scrollHeight - de.scrollTop - de.clientHeight < 120;
  }

  function scrollToBottom() {
    // Double-rAF: the second pass catches layout that settles after the
    // first frame (fonts, late flex sizing). Image growth after this is
    // handled by the capture-phase load listener in wireFeedScroll.
    requestAnimationFrame(() => {
      pinFeedToBottom();
      requestAnimationFrame(pinFeedToBottom);
    });
  }

  function showNewMessagesButton() {
    if (document.getElementById('chat-new-msgs-btn')) return;
    const feed = document.getElementById('chat-feed');
    if (!feed) return;
    const btn = document.createElement('button');
    btn.id = 'chat-new-msgs-btn';
    btn.className = 'chat-new-msgs-btn';
    btn.textContent = 'New messages';
    btn.addEventListener('click', () => {
      _autoScroll = true;
      scrollToBottom();
      btn.remove();
    });
    feed.parentElement.insertBefore(btn, feed.nextSibling);
  }

  function showToast(msg) {
    clearTimeout(_toastTimer);
    let toast = document.getElementById('chat-toast');
    if (!toast) {
      toast = document.createElement('div');
      toast.id = 'chat-toast';
      toast.className = 'chat-toast';
      document.body.appendChild(toast);
    }
    toast.textContent = msg;
    toast.classList.add('chat-toast--show');
    _toastTimer = setTimeout(() => toast.classList.remove('chat-toast--show'), 3000);
  }

  function notifyResize() {
    // V3.52: RM is the parent window — no iframe-resize postMessage to fire.
    // Guard the AppBridge lookup so the no-op is safe even if
    // McgheeLab.AppBridge is undefined (which it is in RM).
    if (McgheeLab.AppBridge && McgheeLab.AppBridge.isEmbedded && McgheeLab.AppBridge.isEmbedded()) {
      window.parent.postMessage({
        type: 'mcgheelab-app-resize',
        height: Math.max(document.body.scrollHeight, 700)
      }, window.location.origin);
    }
  }

  /* ═══════════════════════════════════════════════════════════
     SVG ICONS
     ═══════════════════════════════════════════════════════════ */
  function svgX() {
    return '<svg viewBox="0 0 24 24" width="18" height="18" fill="none" stroke="currentColor" stroke-width="2"><line x1="18" y1="6" x2="6" y2="18"/><line x1="6" y1="6" x2="18" y2="18"/></svg>';
  }
  function svgPlus() {
    return '<svg viewBox="0 0 24 24" width="16" height="16" fill="none" stroke="currentColor" stroke-width="2"><line x1="12" y1="5" x2="12" y2="19"/><line x1="5" y1="12" x2="19" y2="12"/></svg>';
  }
  function svgSearch() {
    return '<svg viewBox="0 0 24 24" width="16" height="16" fill="none" stroke="currentColor" stroke-width="2"><circle cx="11" cy="11" r="8"/><line x1="21" y1="21" x2="16.65" y2="16.65"/></svg>';
  }
  function svgSettings() {
    return '<svg viewBox="0 0 24 24" width="16" height="16" fill="none" stroke="currentColor" stroke-width="2"><circle cx="12" cy="12" r="3"/><path d="M19.4 15a1.65 1.65 0 0 0 .33 1.82l.06.06a2 2 0 0 1-2.83 2.83l-.06-.06a1.65 1.65 0 0 0-1.82-.33 1.65 1.65 0 0 0-1 1.51V21a2 2 0 0 1-4 0v-.09A1.65 1.65 0 0 0 9 19.4a1.65 1.65 0 0 0-1.82.33l-.06.06a2 2 0 0 1-2.83-2.83l.06-.06A1.65 1.65 0 0 0 4.68 15a1.65 1.65 0 0 0-1.51-1H3a2 2 0 0 1 0-4h.09A1.65 1.65 0 0 0 4.6 9a1.65 1.65 0 0 0-.33-1.82l-.06-.06a2 2 0 0 1 2.83-2.83l.06.06A1.65 1.65 0 0 0 9 4.68a1.65 1.65 0 0 0 1-1.51V3a2 2 0 0 1 4 0v.09a1.65 1.65 0 0 0 1 1.51 1.65 1.65 0 0 0 1.82-.33l.06-.06a2 2 0 0 1 2.83 2.83l-.06.06A1.65 1.65 0 0 0 19.4 9a1.65 1.65 0 0 0 1.51 1H21a2 2 0 0 1 0 4h-.09a1.65 1.65 0 0 0-1.51 1z"/></svg>';
  }
  function svgGrid() {
    return '<svg viewBox="0 0 24 24" width="16" height="16" fill="none" stroke="currentColor" stroke-width="2"><rect x="3" y="3" width="7" height="7"/><rect x="14" y="3" width="7" height="7"/><rect x="14" y="14" width="7" height="7"/><rect x="3" y="14" width="7" height="7"/></svg>';
  }
  function svgMenu() {
    return '<svg viewBox="0 0 24 24" width="20" height="20" fill="none" stroke="currentColor" stroke-width="2"><line x1="3" y1="12" x2="21" y2="12"/><line x1="3" y1="6" x2="21" y2="6"/><line x1="3" y1="18" x2="21" y2="18"/></svg>';
  }
  function svgSend() {
    return '<svg viewBox="0 0 24 24" width="18" height="18" fill="none" stroke="currentColor" stroke-width="2"><line x1="22" y1="2" x2="11" y2="13"/><polygon points="22 2 15 22 11 13 2 9 22 2"/></svg>';
  }
  function svgPaperclip() {
    return '<svg viewBox="0 0 24 24" width="18" height="18" fill="none" stroke="currentColor" stroke-width="2"><path d="M21.44 11.05l-9.19 9.19a6 6 0 0 1-8.49-8.49l9.19-9.19a4 4 0 0 1 5.66 5.66l-9.2 9.19a2 2 0 0 1-2.83-2.83l8.49-8.48"/></svg>';
  }
  function svgSmile() {
    return '<svg viewBox="0 0 24 24" width="16" height="16" fill="none" stroke="currentColor" stroke-width="2"><circle cx="12" cy="12" r="10"/><path d="M8 14s1.5 2 4 2 4-2 4-2"/><line x1="9" y1="9" x2="9.01" y2="9"/><line x1="15" y1="9" x2="15.01" y2="9"/></svg>';
  }
  function svgThread() {
    return '<svg viewBox="0 0 24 24" width="16" height="16" fill="none" stroke="currentColor" stroke-width="2"><path d="M21 15a2 2 0 0 1-2 2H7l-4 4V5a2 2 0 0 1 2-2h14a2 2 0 0 1 2 2z"/></svg>';
  }
  function svgPin() {
    return '<svg viewBox="0 0 24 24" width="14" height="14" fill="none" stroke="currentColor" stroke-width="2"><path d="M12 17v5"/><path d="M9 11V3h6v8l3 3H6l3-3z"/></svg>';
  }
  function svgEdit() {
    return '<svg viewBox="0 0 24 24" width="14" height="14" fill="none" stroke="currentColor" stroke-width="2"><path d="M11 4H4a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h14a2 2 0 0 0 2-2v-7"/><path d="M18.5 2.5a2.121 2.121 0 0 1 3 3L12 15l-4 1 1-4 9.5-9.5z"/></svg>';
  }
  function svgTrash() {
    return '<svg viewBox="0 0 24 24" width="14" height="14" fill="none" stroke="currentColor" stroke-width="2"><polyline points="3 6 5 6 21 6"/><path d="M19 6v14a2 2 0 0 1-2 2H7a2 2 0 0 1-2-2V6m3 0V4a2 2 0 0 1 2-2h4a2 2 0 0 1 2 2v2"/></svg>';
  }
  function svgFile() {
    return '<svg viewBox="0 0 24 24" width="24" height="24" fill="none" stroke="currentColor" stroke-width="2"><path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z"/><polyline points="14 2 14 8 20 8"/></svg>';
  }
  function svgEyeOpen() {
    return '<svg viewBox="0 0 24 24" width="14" height="14" fill="none" stroke="currentColor" stroke-width="2"><path d="M1 12s4-8 11-8 11 8 11 8-4 8-11 8-11-8-11-8z"/><circle cx="12" cy="12" r="3"/></svg>';
  }
  function svgEyeHalf() {
    return '<svg viewBox="0 0 24 24" width="14" height="14" fill="none" stroke="currentColor" stroke-width="2"><path d="M1 12s4-8 11-8 11 8 11 8-4 8-11 8-11-8-11-8z"/><circle cx="12" cy="12" r="3" opacity=".5"/></svg>';
  }
  function svgEyeClosed() {
    return '<svg viewBox="0 0 24 24" width="14" height="14" fill="none" stroke="currentColor" stroke-width="2"><path d="M17.94 17.94A10.07 10.07 0 0 1 12 20c-7 0-11-8-11-8a18.45 18.45 0 0 1 5.06-5.94"/><path d="M9.9 4.24A9.12 9.12 0 0 1 12 4c7 0 11 8 11 8a18.5 18.5 0 0 1-2.16 3.19"/><line x1="1" y1="1" x2="23" y2="23"/></svg>';
  }
  function svgBellOn() {
    return '<svg viewBox="0 0 24 24" width="16" height="16" fill="none" stroke="currentColor" stroke-width="2"><path d="M18 8A6 6 0 0 0 6 8c0 7-3 9-3 9h18s-3-2-3-9"/><path d="M13.73 21a2 2 0 0 1-3.46 0"/></svg>';
  }
  function svgBellOff() {
    return '<svg viewBox="0 0 24 24" width="16" height="16" fill="none" stroke="currentColor" stroke-width="2"><path d="M13.73 21a2 2 0 0 1-3.46 0"/><path d="M18.63 13A17.89 17.89 0 0 1 18 8"/><path d="M6.26 6.26A5.86 5.86 0 0 0 6 8c0 7-3 9-3 9h14"/><path d="M18 8a6 6 0 0 0-9.33-5"/><line x1="1" y1="1" x2="23" y2="23"/></svg>';
  }

  /* ─── Mobile-specific SVG icons ─── */
  function svgFilter() {
    return '<svg viewBox="0 0 24 24" width="14" height="14" fill="none" stroke="currentColor" stroke-width="2"><polygon points="22 3 2 3 10 12.46 10 19 14 21 14 12.46 22 3"/></svg>';
  }
  function svgBackArrow() {
    return '<svg viewBox="0 0 24 24" width="20" height="20" fill="none" stroke="currentColor" stroke-width="2"><polyline points="15 18 9 12 15 6"/></svg>';
  }
  function svgChat() {
    return '<svg viewBox="0 0 24 24" width="20" height="20" fill="none" stroke="currentColor" stroke-width="1.5"><path d="M21 15a2 2 0 0 1-2 2H7l-4 4V5a2 2 0 0 1 2-2h14a2 2 0 0 1 2 2z"/></svg>';
  }
  function svgPeople() {
    return '<svg viewBox="0 0 24 24" width="20" height="20" fill="none" stroke="currentColor" stroke-width="1.5"><path d="M17 21v-2a4 4 0 0 0-4-4H5a4 4 0 0 0-4 4v2"/><circle cx="9" cy="7" r="4"/><path d="M23 21v-2a4 4 0 0 0-3-3.87"/><path d="M16 3.13a4 4 0 0 1 0 7.75"/></svg>';
  }
  function svgCalendar() {
    return '<svg viewBox="0 0 24 24" width="20" height="20" fill="none" stroke="currentColor" stroke-width="1.5"><rect x="3" y="4" width="18" height="18" rx="2" ry="2"/><line x1="16" y1="2" x2="16" y2="6"/><line x1="8" y1="2" x2="8" y2="6"/><line x1="3" y1="10" x2="21" y2="10"/></svg>';
  }
  function svgChart() {
    return '<svg viewBox="0 0 24 24" width="20" height="20" fill="none" stroke="currentColor" stroke-width="1.5"><path d="M12 20V10"/><path d="M18 20V4"/><path d="M6 20v-4"/></svg>';
  }
  function svgHuddle() {
    return '<svg viewBox="0 0 24 24" width="20" height="20" fill="none" stroke="currentColor" stroke-width="1.5"><path d="M17 21v-2a4 4 0 0 0-4-4H5a4 4 0 0 0-4 4v2"/><circle cx="9" cy="7" r="4"/><line x1="12" y1="17" x2="12" y2="21"/><line x1="10" y1="19" x2="14" y2="19"/></svg>';
  }
})();
