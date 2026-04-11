/* ================================================================
   Lab Chat — McGheeLab Lab App
   Real-time messaging for the lab. Channels, DMs, threads, file
   sharing via Google Drive, reactions, @mentions, read receipts.
   ================================================================ */

(() => {
  'use strict';

  const appEl = document.getElementById('app');
  function db() {
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
  const READ_RECEIPT_BATCH = 20;
  const MAX_VISIBLE_RECEIPTS = 5;
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

  // Mobile tab state
  let _mobileTab = 'overview'; // 'overview' | 'chat' | 'files' | 'search'
  let _conversationFilter = 'newest';
  let _mobileFilterOpen = false;
  let _mobileHamburgerOpen = false;

  // Collapsed sections on mobile overview
  let _collapsedSections = new Set();

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

  let _toastTimer = null;
  let _autoScroll = true;
  let _isRendering = false; // Guard to prevent scroll events during innerHTML updates from resetting _autoScroll
  let _drafts = (() => { try { return JSON.parse(localStorage.getItem('chat-drafts') || '{}'); } catch { return {}; } })();
  let _draftSaveTimer = null;

  /* ═══════════════════════════════════════════════════════════
     BOOTSTRAP
     ═══════════════════════════════════════════════════════════ */
  // Prevent pinch-to-zoom on iOS
  document.addEventListener('gesturestart', (e) => e.preventDefault(), { passive: false });
  document.addEventListener('gesturechange', (e) => e.preventDefault(), { passive: false });

  document.addEventListener('DOMContentLoaded', () => {
    let booted = false;
    let _bridgeUser = null, _bridgeProfile = null, _fbAuthResolved = false;

    async function tryBoot() {
      if (booted || !_fbAuthResolved || !_bridgeUser) return;
      booted = true;
      _user = _bridgeUser;
      _profile = _bridgeProfile;

      // Check chat access for guests
      if (!canAccessChat(_bridgeProfile)) {
        appEl.innerHTML = `<div class="chat-access-denied">
          <h2>Chat Access Required</h2>
          <p>Guest accounts need admin approval to use Lab Chat.</p>
          <p>Please ask your lab administrator to enable chat access for your account.</p>
        </div>`;
        return;
      }

      await loadConfig();
      await loadUsers();
      await loadUserMeta();
      render();
      subscribeChannels();
      subscribeReadState();
      subscribeUsers();
      subscribeConfig();

      // Tab swipe for mobile
      initChatTabSwipe();
    }

    McgheeLab.AppBridge.init();
    McgheeLab.AppBridge.onReady((user, profile) => {
      if (!user) return;
      _bridgeUser = user;
      _bridgeProfile = profile;
      tryBoot();
    });

    if (typeof firebase !== 'undefined' && firebase.auth) {
      firebase.auth().onAuthStateChanged(async (fbUser) => {
        _fbAuthResolved = true;
        if (!_bridgeUser && fbUser) {
          _bridgeUser = { uid: fbUser.uid, email: fbUser.email, displayName: fbUser.displayName };
          const snap = await db().collection('users').doc(fbUser.uid).get();
          _bridgeProfile = snap.exists ? snap.data() : { role: 'contributor', name: fbUser.displayName || fbUser.email };
        }
        tryBoot();
      });
    } else {
      const check = setInterval(() => {
        if (typeof firebase !== 'undefined' && firebase.auth) {
          clearInterval(check);
          firebase.auth().onAuthStateChanged(async (fbUser) => {
            _fbAuthResolved = true;
            if (!_bridgeUser && fbUser) {
              _bridgeUser = { uid: fbUser.uid, email: fbUser.email, displayName: fbUser.displayName };
              const snap = await db().collection('users').doc(fbUser.uid).get();
              _bridgeProfile = snap.exists ? snap.data() : { role: 'contributor', name: fbUser.displayName || fbUser.email };
            }
            tryBoot();
          });
        }
      }, 100);
    }
  });

  /* ═══════════════════════════════════════════════════════════
     DATA LOADING
     ═══════════════════════════════════════════════════════════ */
  async function loadConfig() {
    const doc = await db().collection('chatConfig').doc('settings').get();
    if (doc.exists) {
      _config = doc.data();
    } else {
      // First boot — initialize config and default channels
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
          createdAt: TS()
        });
      }
    }
  }

  function subscribeConfig() {
    db().collection('chatConfig').doc('settings').onSnapshot(doc => {
      if (doc.exists) _config = doc.data();
    });
  }

  async function loadUsers() {
    const snap = await db().collection('users').get();
    _allUsers = snap.docs.map(d => ({ uid: d.id, ...d.data() }));
  }

  function subscribeUsers() {
    db().collection('users').onSnapshot(snap => {
      _allUsers = snap.docs.map(d => ({ uid: d.id, ...d.data() }));
    });
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
          }
        }
        // Auto-select most recent channel if none active (channels already sorted by lastActivityAt desc)
        if (!_activeChannelId && _channels.length > 0) {
          selectChannel(_channels[0].id);
        }
        renderSidebar();
      });
    subscribeUserMeta();
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

  /* ═══════════════════════════════════════════════════════════
     FIRESTORE — Message Listeners
     ═══════════════════════════════════════════════════════════ */
  function subscribeMessages(channelId) {
    if (_unsubMessages) _unsubMessages();
    _messages = [];
    _oldestLoaded = null;
    _hasMoreMessages = true;
    _autoScroll = true;

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
        console.error('Thread listener error:', err);
        // Fallback without orderBy
        if (_unsubThread) _unsubThread();
        _unsubThread = db().collection('chatMessages')
          .where('threadParentId', '==', parentId)
          .onSnapshot(snap => {
            _threadMessages = snap.docs.map(d => ({ id: d.id, ...d.data() }))
              .sort((a, b) => (a.createdAt?.toMillis?.() || 0) - (b.createdAt?.toMillis?.() || 0));
            renderThread();
          });
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
    _activeChannelId = channelId;
    _threadParentId = null;
    _threadMessages = [];
    if (_unsubThread) { _unsubThread(); _unsubThread = null; }
    _editingMessageId = null;
    _showEmojiPickerFor = null;
    _mentionQuery = null;
    if (isMobile()) _mobileTab = 'chat';
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
      readBy: [_user.uid],
      editedAt: null,
      deleted: false,
      pinned: false,
      createdAt: TS()
    };

    const ref = await db().collection('chatMessages').add(msgData);

    // Clear draft for this channel after successful send
    delete _drafts[_activeChannelId];
    localStorage.setItem('chat-drafts', JSON.stringify(_drafts));

    // Update channel lastMessage
    if (!threadParentId) {
      await db().collection('chatChannels').doc(_activeChannelId).update({
        lastMessage: {
          text: file ? `📎 ${file.name}` : text.trim().substring(0, 100),
          authorName: msgData.authorName,
          authorUid: _user.uid,
          timestamp: TS()
        },
        lastActivityAt: TS(),
        messageCount: firebase.firestore.FieldValue.increment(1)
      });
    }

    // Update thread parent if this is a reply
    if (threadParentId) {
      const parentRef = db().collection('chatMessages').doc(threadParentId);
      const parentSnap = await parentRef.get();
      if (parentSnap.exists) {
        const count = (parentSnap.data().threadReplyCount || 0) + 1;
        await parentRef.update({
          threadReplyCount: count,
          threadLastReplyAt: TS()
        });
      }
    }

    // Increment mention counts for mentioned users
    if (mentions.length > 0 || mentionsChannel) {
      const targetUids = mentionsChannel
        ? _allUsers.map(u => u.uid).filter(uid => uid !== _user.uid)
        : mentions.filter(uid => uid !== _user.uid);
      for (const uid of targetUids) {
        const stateId = `${uid}_${_activeChannelId}`;
        const stateRef = db().collection('chatReadState').doc(stateId);
        const stateSnap = await stateRef.get();
        if (stateSnap.exists) {
          await stateRef.update({ mentionCount: firebase.firestore.FieldValue.increment(1) });
        }
      }
    }

    return ref;
  }

  async function editMessage(messageId, newText) {
    await db().collection('chatMessages').doc(messageId).update({
      text: newText,
      editedAt: TS()
    });
    _editingMessageId = null;
    renderMessages();
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

    // Subscribe all members
    for (const uid of memberUids) {
      const metaRef = db().collection('chatUserMeta').doc(uid);
      const metaSnap = await metaRef.get();
      if (metaSnap.exists) {
        await metaRef.update({
          subscribedChannels: ARR_UNION(ref.id),
          dmChannelIds: ARR_UNION(ref.id)
        });
      }
    }

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

    // Increment member count
    const ch = _channels.find(c => c.id === channelId);
    if (ch) {
      await db().collection('chatChannels').doc(channelId).update({
        memberCount: firebase.firestore.FieldValue.increment(1)
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
      memberCount: firebase.firestore.FieldValue.increment(-1)
    });

    renderSidebar();
  }

  async function markChannelRead(channelId) {
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

    // Update read receipts on recent messages
    updateReadReceipts(channelId);
  }

  async function updateReadReceipts(channelId) {
    const recent = _messages.slice(-READ_RECEIPT_BATCH);
    const batch = db().batch();
    let count = 0;
    for (const msg of recent) {
      if (!msg.readBy || !msg.readBy.includes(_user.uid)) {
        batch.update(db().collection('chatMessages').doc(msg.id), {
          readBy: ARR_UNION(_user.uid)
        });
        count++;
      }
    }
    if (count > 0) await batch.commit();
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
     SEARCH
     ═══════════════════════════════════════════════════════════ */
  function searchMessages(query) {
    if (!query.trim()) return _messages;
    const q = query.toLowerCase();
    return _messages.filter(m =>
      (m.text || '').toLowerCase().includes(q) ||
      (m.authorName || '').toLowerCase().includes(q) ||
      (m.file && m.file.name && m.file.name.toLowerCase().includes(q))
    );
  }

  /* ═══════════════════════════════════════════════════════════
     RENDERING — Main Layout
     ═══════════════════════════════════════════════════════════ */
  // Desktop view tab: which panel the main area shows
  let _desktopView = 'chat'; // 'chat' | 'files'

  function render() {
    if (typeof McgheeLab !== 'undefined' && McgheeLab.MobileShell?.saveTabScroll) McgheeLab.MobileShell.saveTabScroll('chat-tab-bar');
    const channel = _channels.find(c => c.id === _activeChannelId);
    if (typeof McgheeLab !== 'undefined' && McgheeLab.MobileShell?.getHandPreference) {
      document.body.dataset.hand = McgheeLab.MobileShell.getHandPreference();
    }

    if (isMobile()) {
      appEl.innerHTML = `
        ${renderMobileTopBarHTML()}
        <nav class="chat-tab-bar" id="chat-tab-bar">
          ${['overview','chat','files','search'].map(t =>
            `<button class="chat-tab${_mobileTab === t ? ' chat-tab--active' : ''}" data-chat-tab="${t}">${({overview:'Overview',chat:'Chat',files:'Files',search:'Search'})[t]}</button>`
          ).join('')}
        </nav>
        <div class="chat-layout">
          ${renderMobileTabContent(channel)}
        </div>
        ${renderMobileBottomBarHTML()}
        ${_mobileHamburgerOpen ? renderMobileHamburgerMenuHTML() : ''}
        ${renderModals()}
      `;
    } else {
      // Classic desktop: sidebar + main + thread
      appEl.innerHTML = `
        <div class="chat-layout${_mobileSidebarOpen ? ' chat-sidebar-open' : ''}">
          <div class="chat-sidebar-overlay" id="chat-sidebar-overlay"></div>
          <aside class="chat-sidebar" id="chat-sidebar">
            ${renderSidebarHTML()}
          </aside>
          <section class="chat-main">
            ${renderHeaderHTML(channel)}
            ${renderDesktopViewTabs()}
            ${_desktopView === 'chat' ? `
              <div class="chat-feed" id="chat-feed">
                ${_messages.length === 0 ? '<div class="chat-empty">No messages yet. Start the conversation!</div>' : ''}
                ${_hasMoreMessages ? '<button class="chat-load-more" id="chat-load-more">Load older messages</button>' : ''}
                ${_loadingOlder ? '<div class="chat-loading">Loading...</div>' : ''}
                ${renderMessagesHTML()}
              </div>
              ${renderInputAreaHTML()}
            ` : ''}
            ${_desktopView === 'files' ? renderFilesTabHTML() : ''}
          </section>
          ${_threadParentId ? renderThreadHTML() : ''}
        </div>
        ${renderModals()}
      `;
    }
    wireAll();
    notifyResize();
    requestNotificationPermission();
  }

  function renderModals() {
    return `
      ${_showChannelDirectory ? renderChannelDirectoryHTML() : ''}
      ${_showCreateChannel ? renderCreateChannelHTML() : ''}
      ${_showSettings ? renderSettingsHTML() : ''}
      ${_showSearch ? renderSearchHTML() : ''}
      ${_showNewDM ? renderNewDMHTML() : ''}
      ${_showManageContacts ? renderManageContactsHTML() : ''}
      ${_showSeenBy ? renderSeenByHTML() : ''}`;
  }

  function renderDesktopViewTabs() {
    const tabs = [
      { id: 'chat', label: 'Messages' },
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
            ${_showPinned ? renderPinnedHTML() : ''}
            <div class="chat-feed" id="chat-feed">
              ${_messages.length === 0 ? '<div class="chat-empty">No messages yet. Start the conversation!</div>' : ''}
              ${_hasMoreMessages ? '<button class="chat-load-more" id="chat-load-more">Load older messages</button>' : ''}
              ${_loadingOlder ? '<div class="chat-loading">Loading...</div>' : ''}
              ${renderMessagesHTML()}
            </div>
            ${renderInputAreaHTML()}
          </section>
          ${_threadParentId ? renderThreadHTML() : ''}`;
      case 'files':
        return renderFilesTabHTML();
      case 'search':
        return `<section class="chat-main" style="display:flex;flex:1;flex-direction:column">
          <div class="chat-feed" id="chat-feed">
            <div class="chat-empty">Use the search modal to find messages.</div>
          </div>
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

    // DMs section — user-managed contact groups
    const contacts = _userMeta.dmContacts || [];
    const dmIds = _userMeta.dmChannelIds || [];
    html += `<div class="chat-sidebar-section-header">
      <span>People</span>
      <button class="chat-icon-btn chat-icon-btn--sm" id="chat-manage-contacts-btn" title="Manage contacts">${svgEdit()}</button>
    </div>`;

    if (contacts.length > 0) {
      for (let gi = 0; gi < contacts.length; gi++) {
        const group = contacts[gi];
        html += `<div class="chat-sidebar-dm-category">${escHTML(group.groupName)}</div>`;
        for (const uid of (group.uids || [])) {
          const u = _allUsers.find(a => a.uid === uid);
          if (!u) continue;
          const name = u.name || u.displayName || u.email;
          // Find existing DM channel for unread badge
          const dmCh = _channels.find(c => c.type === 'dm' && c.members && c.members.includes(uid) && c.members.includes(_user.uid));
          const active = dmCh && dmCh.id === _activeChannelId ? ' chat-sidebar-item--active' : '';
          const unread = dmCh ? getUnreadCount(dmCh.id) : 0;
          const photo = u.photo?.thumb;
          html += `<div class="chat-sidebar-item${active}" data-dm-contact="${uid}">
            ${photo ? `<img class="chat-dm-avatar" src="${escHTML(photo)}" alt="" />` : `<span class="chat-dm-avatar">${getInitials(name)}</span>`}
            <span class="chat-sidebar-item-name">${escHTML(name)}</span>
            ${unread > 0 ? `<span class="chat-sidebar-badge">${unread > 99 ? '99+' : unread}</span>` : ''}
          </div>`;
        }
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
    wireSidebar();
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

    return `<div class="chat-header">
      <button class="chat-hamburger" id="chat-hamburger">${svgMenu()}</button>
      <div class="chat-header-info">
        <h2 class="chat-header-name">${escHTML(name)}</h2>
        ${desc ? `<span class="chat-header-desc">${escHTML(desc)}</span>` : ''}
      </div>
      <div class="chat-header-actions">
        ${pinnedCount > 0 ? `<button class="chat-icon-btn" id="chat-pinned-btn" title="Pinned (${pinnedCount})">${svgPin()} <span class="chat-pin-count">${pinnedCount}</span></button>` : ''}
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
    const msgs = _showSearch && _searchQuery ? searchMessages(_searchQuery) : _messages;
    // Find the last message authored by current user (for read receipt eyeball)
    let lastOwnMsgId = null;
    for (let i = msgs.length - 1; i >= 0; i--) {
      if (msgs[i].authorUid === _user.uid) { lastOwnMsgId = msgs[i].id; break; }
    }
    return msgs.map(m => renderMessageHTML(m, false, m.id === lastOwnMsgId)).join('');
  }

  function renderMessageHTML(msg, isThread, isLastOwnMsg) {
    const isOwn = msg.authorUid === _user.uid;
    const isEditing = _editingMessageId === msg.id;
    const time = formatTimestamp(msg.createdAt);
    const photoUrl = msg.authorPhoto;
    const avatarHTML = photoUrl
      ? `<img class="chat-msg-avatar" src="${photoUrl}" alt="" />`
      : `<div class="chat-msg-avatar chat-msg-avatar--initials">${getInitials(msg.authorName)}</div>`;

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

    // Read receipts — Teams-style eyeball (open = seen by all, closed = unseen by some)
    let receiptsHTML = '';
    if (!isThread && isLastOwnMsg && msg.authorUid === _user.uid && msg.readBy) {
      const readers = msg.readBy.filter(uid => uid !== msg.authorUid);
      const totalOthers = _allUsers.filter(u => u.uid !== msg.authorUid && canAccessChat(u)).length;
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
    const wasAtBottom = feed.scrollHeight - feed.scrollTop - feed.clientHeight < 100;

    _isRendering = true;
    feed.innerHTML = `
      ${_hasMoreMessages ? `<button class="chat-load-more" id="chat-load-more">Load older messages</button>` : ''}
      ${_loadingOlder ? '<div class="chat-loading">Loading...</div>' : ''}
      ${_messages.length === 0 ? '<div class="chat-empty">No messages yet. Start the conversation!</div>' : ''}
      ${renderMessagesHTML()}
    `;
    wireMessages();
    if (wasAtBottom || _autoScroll) scrollToBottom();
    _isRendering = false;
    // Show new messages button if scrolled up
    if (!wasAtBottom && !_autoScroll) showNewMessagesButton();
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
      return `<div class="chat-input-area chat-input-area--locked">
        <span class="chat-muted">You have read-only access to this chat</span>
      </div>`;
    }
    const channel = _channels.find(c => c.id === _activeChannelId);
    if (channel && channel.isAnnouncement && !isAdmin()) {
      return `<div class="chat-input-area chat-input-area--locked">
        <span class="chat-muted">Only admins can post in announcement channels</span>
      </div>`;
    }
    return `<div class="chat-input-area" id="chat-input-area">
      <div class="chat-input-wrapper">
        <textarea class="chat-input" id="chat-input" placeholder="Type a message..." rows="1"></textarea>
        ${_mentionQuery !== null ? renderMentionPopupHTML() : ''}
      </div>
      <div class="chat-input-actions">
        <button class="chat-icon-btn" id="chat-attach-btn" title="Attach file">${svgPaperclip()}</button>
        <input type="file" id="chat-file-input" style="display:none" />
        <button class="chat-send-btn" id="chat-send-btn" title="Send">${svgSend()}</button>
      </div>
      ${_uploadingFile ? '<div class="chat-uploading">Uploading to Google Drive...</div>' : ''}
    </div>`;
  }

  function renderInputArea() {
    const el = document.getElementById('chat-input-area');
    if (!el) return;
    const parent = el.parentElement;
    if (!parent) return;
    // Re-render just the input area section
    const newHTML = renderInputAreaHTML();
    const wrapper = document.createElement('div');
    wrapper.innerHTML = newHTML;
    parent.replaceChild(wrapper.firstElementChild, el);
    wireInput();
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
  function renderThreadHTML() {
    const parent = _messages.find(m => m.id === _threadParentId);
    if (!parent) return '';
    return `<aside class="chat-thread" id="chat-thread">
      <div class="chat-thread-header">
        <h3>Thread</h3>
        <button class="chat-icon-btn" id="chat-thread-close">${svgX()}</button>
      </div>
      <div class="chat-thread-parent">
        ${renderMessageHTML(parent, true)}
      </div>
      <div class="chat-thread-divider">${_threadMessages.length} ${_threadMessages.length === 1 ? 'reply' : 'replies'}</div>
      <div class="chat-thread-feed" id="chat-thread-feed">
        ${_threadMessages.map(m => renderMessageHTML(m, true)).join('')}
      </div>
      <div class="chat-thread-input">
        <textarea class="chat-input" id="chat-thread-input" placeholder="Reply in thread..." rows="1"></textarea>
        <button class="chat-send-btn" id="chat-thread-send">${svgSend()}</button>
      </div>
    </aside>`;
  }

  function renderThread() {
    const el = document.getElementById('chat-thread');
    if (!el) { render(); return; }
    const feed = document.getElementById('chat-thread-feed');
    if (feed) {
      feed.innerHTML = _threadMessages.map(m => renderMessageHTML(m, true)).join('');
      feed.scrollTop = feed.scrollHeight;
    }
    const divider = el.querySelector('.chat-thread-divider');
    if (divider) divider.textContent = `${_threadMessages.length} ${_threadMessages.length === 1 ? 'reply' : 'replies'}`;
    wireThreadMessages();
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
      <div class="chat-modal chat-modal--directory" onclick="event.stopPropagation()">
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
      <div class="chat-modal" onclick="event.stopPropagation()">
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
      <div class="chat-modal chat-modal--settings" onclick="event.stopPropagation()">
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
                ${_allUsers.filter(u => !(_config?.chatAdmins || []).includes(u.uid) && u.role !== 'guest').map(u =>
                  `<option value="${u.uid}">${escHTML(u.name || u.displayName || u.email)}</option>`
                ).join('')}
              </select>
              <button class="app-btn app-btn--primary app-btn--sm" id="chat-add-admin-btn">${svgPlus()} Add</button>
            </div>
          ` : ''}

          <h4 style="margin-top:1.5rem">File Uploads</h4>
          <p class="chat-muted">Files are uploaded to Firebase Storage. Max file size: 50 MB.</p>
        </div>
        <div class="chat-modal-footer">
          <button class="app-btn app-btn--secondary" data-close-modal="settings">Cancel</button>
          <button class="app-btn app-btn--primary" id="chat-save-settings">Save Settings</button>
        </div>
      </div>
    </div>`;
  }

  function renderPinnedHTML() {
    const pinned = _messages.filter(m => m.pinned);
    return `<div class="chat-pinned-panel">
      <div class="chat-pinned-panel-header">
        <span class="chat-pinned-panel-title">${svgPin()} Pinned Messages <span class="chat-pin-count">${pinned.length}</span></span>
        <button class="chat-icon-btn" data-close-modal="pinned">${svgX()}</button>
      </div>
      <div class="chat-pinned-panel-body">
        ${pinned.length === 0 ? '<p class="chat-muted" style="padding:.5rem 1rem;font-size:.8rem">No pinned messages in this channel.</p>' : ''}
        ${pinned.map(m => renderMessageHTML(m, true)).join('')}
      </div>
    </div>`;
  }

  function renderSearchHTML() {
    const results = _searchQuery ? searchMessages(_searchQuery) : [];
    return `<div class="chat-modal-overlay" data-close-modal="search">
      <div class="chat-modal chat-modal--search" onclick="event.stopPropagation()">
        <div class="chat-modal-header">
          <h3>Search Messages</h3>
          <button class="chat-icon-btn" data-close-modal="search">${svgX()}</button>
        </div>
        <input class="app-input" id="chat-search-input" placeholder="Search..." value="${escHTML(_searchQuery)}" />
        <div class="chat-modal-body chat-search-results">
          ${_searchQuery && results.length === 0 ? '<p class="chat-muted">No results found.</p>' : ''}
          ${results.map(m => `<div class="chat-search-result" data-goto-msg="${m.id}">
            <span class="chat-msg-author">${escHTML(m.authorName)}</span>
            <span class="chat-msg-time">${formatTimestamp(m.createdAt)}</span>
            <div class="chat-msg-text">${parseMarkdown(m.text)}</div>
          </div>`).join('')}
        </div>
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
      <div class="chat-modal" onclick="event.stopPropagation()">
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
                  <span class="chat-dm-avatar">${getInitials(u.name || u.displayName || u.email)}</span>
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
      <div class="chat-modal chat-modal--directory" onclick="event.stopPropagation()">
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
    if (!msg || !msg.readBy) return '';
    const readers = msg.readBy.filter(uid => uid !== msg.authorUid);
    return `<div class="chat-modal-overlay" data-close-modal="seenby">
      <div class="chat-modal chat-modal--sm" onclick="event.stopPropagation()">
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

    // --- People / DMs section ---
    const contacts = _userMeta.dmContacts || [];
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
      if (contacts.length > 0) {
        for (let gi = 0; gi < contacts.length; gi++) {
          const group = contacts[gi];
          const contactKey = `dm-group-${gi}`;
          const collapsedContact = _collapsedSections.has(contactKey);

          html += `<div class="chat-overview-dm-group">
            <button class="chat-overview-dm-group-header" data-toggle-section="${contactKey}">
              <span class="chat-overview-chevron">${collapsedContact ? chevronRight : chevronDown}</span>
              <span>${escHTML(group.groupName)}</span>
            </button>`;

          if (!collapsedContact) {
            for (const uid of (group.uids || [])) {
              const u = _allUsers.find(a => a.uid === uid);
              if (!u) continue;
              const name = u.name || u.displayName || u.email;
              const dmCh = _channels.find(c => c.type === 'dm' && c.members && c.members.includes(uid) && c.members.includes(_user.uid));
              const active = dmCh && dmCh.id === _activeChannelId ? ' chat-overview-item--active' : '';
              const unread = dmCh ? getUnreadCount(dmCh.id) : 0;
              const photo = u.photo?.thumb;
              const preview = dmCh?.lastMessage ? dmCh.lastMessage.text : 'No messages yet';
              const time = dmCh?.lastMessage?.timestamp ? formatTimestamp(dmCh.lastMessage.timestamp) : '';

              html += `<div class="chat-overview-item${active}" data-overview-dm="${uid}">
                ${photo ? `<div class="chat-conv-icon"><img src="${escHTML(photo)}" alt="" /></div>` : `<div class="chat-conv-icon">${getInitials(name)}</div>`}
                <div class="chat-conv-body">
                  <div class="chat-conv-top">
                    <span class="chat-conv-name">${escHTML(name)}</span>
                    <span class="chat-conv-time">${time}</span>
                  </div>
                  <div class="chat-conv-preview">${escHTML(preview)}</div>
                </div>
                ${unread > 0 ? `<span class="chat-conv-badge">${unread > 99 ? '99+' : unread}</span>` : ''}
              </div>`;
            }
          }
          html += `</div>`;
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

    // Count unique readers across recent messages
    const readerSet = new Set();
    _messages.forEach(m => {
      if (m.readBy) m.readBy.forEach(uid => readerSet.add(uid));
    });
    const readerCount = readerSet.size;

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

  function initChatTabSwipe() {
    let swX = 0, swY = 0, swT = 0;
    document.addEventListener('touchstart', (e) => {
      swX = e.touches[0].clientX;
      swY = e.touches[0].clientY;
      swT = Date.now();
    }, { passive: true });

    document.addEventListener('touchend', (e) => {
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
    }, { passive: true });
  }

  /* ═══════════════════════════════════════════════════════════
     WIRING — Event Handlers
     ═══════════════════════════════════════════════════════════ */
  function wireAll() {
    if (isMobile()) {
      wireMobileTabBar();
      wireMobile();
      wireOverview();
    } else {
      wireSidebar();
      wireDesktopViewTabs();
    }
    wireMessages();
    wireInput();
    wireThread();
    wireModals();
    wireHeader();
    wireDragDrop();
    wireFileDrop();
    wireFeedScroll();
  }

  function wireMobileTabBar() {
    document.querySelectorAll('[data-chat-tab]').forEach(el => {
      el.addEventListener('click', () => {
        _mobileTab = el.dataset.chatTab;
        if (_mobileTab === 'search') { _showSearch = true; _searchQuery = ''; }
        render();
      });
    });

    // Center active tab (uses shared utility if available, else inline)
    const tabBar = document.getElementById('chat-tab-bar');
    if (tabBar && McgheeLab.MobileShell?.centerActiveTab) {
      McgheeLab.MobileShell.centerActiveTab(tabBar, '.chat-tab--active');
    }

    // Conversation list clicks
    document.querySelectorAll('[data-conv-channel]').forEach(el => {
      el.addEventListener('click', () => selectChannel(el.dataset.convChannel));
    });
  }

  function wireDesktopViewTabs() {
    document.querySelectorAll('[data-view-tab]').forEach(el => {
      el.addEventListener('click', () => {
        _desktopView = el.dataset.viewTab;
        render();
      });
    });

    const headerSearch = document.getElementById('chat-header-search');
    if (headerSearch) headerSearch.addEventListener('click', () => { _showSearch = true; _searchQuery = ''; render(); });
  }

  function wireSidebar() {
    // Channel selection
    document.querySelectorAll('.chat-sidebar-item[data-channel]').forEach(el => {
      el.addEventListener('click', () => {
        const chId = el.dataset.channel;
        _mobileSidebarOpen = false;
        selectChannel(chId);
      });
    });

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

    // Browse channels
    const browseBtn = document.getElementById('chat-browse-channels');
    if (browseBtn) browseBtn.addEventListener('click', () => { _showChannelDirectory = true; render(); });

    // DM contact clicks — open/create DM with that person
    document.querySelectorAll('[data-dm-contact]').forEach(el => {
      el.addEventListener('click', () => {
        _mobileSidebarOpen = false;
        createDM([el.dataset.dmContact]);
      });
    });

    // Manage contacts button
    const manageBtn = document.getElementById('chat-manage-contacts-btn');
    if (manageBtn) manageBtn.addEventListener('click', () => { _showManageContacts = true; render(); });

    // New DM button (quick DM from + icon, still available)
    const newDMBtn = document.getElementById('chat-new-dm-btn');
    if (newDMBtn) newDMBtn.addEventListener('click', () => { _showNewDM = true; render(); });

    // Search button
    const searchBtn = document.getElementById('chat-search-btn');
    if (searchBtn) searchBtn.addEventListener('click', () => { _showSearch = true; _searchQuery = ''; render(); });

    // Settings button
    const settingsBtn = document.getElementById('chat-settings-btn');
    if (settingsBtn) settingsBtn.addEventListener('click', () => { _showSettings = true; render(); });

    // Mobile close
    const closeBtn = document.getElementById('chat-sidebar-close');
    if (closeBtn) closeBtn.addEventListener('click', () => { _mobileSidebarOpen = false; render(); });

    const overlay = document.getElementById('chat-sidebar-overlay');
    if (overlay) overlay.addEventListener('click', () => { _mobileSidebarOpen = false; render(); });
  }

  function wireHeader() {
    const hamburger = document.getElementById('chat-hamburger');
    if (hamburger) hamburger.addEventListener('click', () => { _mobileSidebarOpen = true; render(); });

    const subToggle = document.getElementById('chat-sub-toggle');
    if (subToggle) {
      subToggle.addEventListener('click', async () => {
        const subscribed = _userMeta?.subscribedChannels?.includes(_activeChannelId);
        if (subscribed) {
          await unsubscribeFromChannel(_activeChannelId);
        } else {
          await subscribeToChannel(_activeChannelId);
        }
        render();
      });
    }

    const pinnedBtn = document.getElementById('chat-pinned-btn');
    if (pinnedBtn) pinnedBtn.addEventListener('click', () => { _showPinned = true; render(); });

    const headerSearch = document.getElementById('chat-header-search');
    if (headerSearch) headerSearch.addEventListener('click', () => { _showSearch = true; _searchQuery = ''; render(); });
  }

  function wireMessages() {
    // Message selection — tap to show action bar
    document.querySelectorAll('[data-msg-select]').forEach(el => {
      el.addEventListener('click', (e) => {
        // Don't select if clicking a link, button, or interactive element
        if (e.target.closest('a, button, textarea, input, .chat-reaction, .chat-thread-indicator, .chat-msg-receipt-eye')) return;
        const msgId = el.dataset.msgSelect;
        _selectedMsgId = _selectedMsgId === msgId ? null : msgId;
        // Update selection highlight
        document.querySelectorAll('.chat-msg--selected').forEach(m => m.classList.remove('chat-msg--selected'));
        if (_selectedMsgId) el.classList.add('chat-msg--selected');
        // Remove any existing floating action bar
        const oldBar = document.querySelector('.chat-action-bar');
        if (oldBar) oldBar.remove();
        // Show floating action bar above the selected message
        if (_selectedMsgId) {
          el.style.position = 'relative';
          el.insertAdjacentHTML('afterbegin', renderMsgActionBarHTML());
          wireActionBar();
        }
      });
    });

    // Action bar close + buttons
    wireActionBar();

    // Reactions
    document.querySelectorAll('[data-react]').forEach(el => {
      el.addEventListener('click', (e) => {
        e.stopPropagation();
        const msgId = el.dataset.react;
        const emoji = el.dataset.emoji;
        if (emoji) toggleReaction(msgId, emoji);
      });
    });

    // Emoji picker toggle — render as fixed-position body overlay
    document.querySelectorAll('[data-react-add]').forEach(el => {
      el.addEventListener('click', (e) => {
        e.stopPropagation();
        const msgId = el.dataset.reactAdd;
        // Close existing picker
        const existing = document.getElementById('chat-emoji-overlay');
        if (existing) { existing.remove(); _showEmojiPickerFor = null; if (_showEmojiPickerFor === msgId) return; }
        _showEmojiPickerFor = msgId;
        showEmojiPickerAt(el, msgId);
      });
    });

    // Thread start
    document.querySelectorAll('[data-thread-start], [data-thread]').forEach(el => {
      el.addEventListener('click', () => {
        const msgId = el.dataset.threadStart || el.dataset.thread;
        _threadParentId = msgId;
        subscribeThread(msgId);
        render();
      });
    });

    // Pin
    document.querySelectorAll('[data-pin]').forEach(el => {
      el.addEventListener('click', () => togglePin(el.dataset.pin));
    });

    // Edit
    document.querySelectorAll('[data-edit]').forEach(el => {
      el.addEventListener('click', () => {
        _editingMessageId = el.dataset.edit;
        renderMessages();
        const textarea = document.getElementById(`chat-edit-${el.dataset.edit}`);
        if (textarea) textarea.focus();
      });
    });

    // Save edit
    document.querySelectorAll('[data-save-edit]').forEach(el => {
      el.addEventListener('click', () => {
        const textarea = document.getElementById(`chat-edit-${el.dataset.saveEdit}`);
        if (textarea) editMessage(el.dataset.saveEdit, textarea.value);
      });
    });

    // Cancel edit
    document.querySelectorAll('[data-cancel-edit]').forEach(el => {
      el.addEventListener('click', () => {
        _editingMessageId = null;
        renderMessages();
      });
    });

    // Delete
    document.querySelectorAll('[data-delete]').forEach(el => {
      el.addEventListener('click', () => {
        if (confirm('Delete this message?')) deleteMessage(el.dataset.delete);
      });
    });

    // Seen by
    document.querySelectorAll('[data-seen-by]').forEach(el => {
      el.addEventListener('click', () => {
        _showSeenBy = el.dataset.seenBy;
        render();
      });
    });

    // Load more
    const loadMoreBtn = document.getElementById('chat-load-more');
    if (loadMoreBtn) loadMoreBtn.addEventListener('click', () => loadOlderMessages());

    // Search result navigation
    document.querySelectorAll('[data-goto-msg]').forEach(el => {
      el.addEventListener('click', () => {
        _showSearch = false;
        render();
        const target = document.getElementById(`msg-${el.dataset.gotoMsg}`);
        if (target) target.scrollIntoView({ behavior: 'smooth', block: 'center' });
      });
    });
  }

  function wireActionBar() {
    const bar = document.getElementById('chat-action-bar');
    if (!bar) return;

    const closeBtn = document.getElementById('chat-action-bar-close');
    if (closeBtn) closeBtn.addEventListener('click', () => {
      _selectedMsgId = null;
      document.querySelectorAll('.chat-msg--selected').forEach(m => m.classList.remove('chat-msg--selected'));
      bar.remove();
    });

    // Wire action buttons on the bar (react, thread, pin, edit, delete)
    bar.querySelectorAll('[data-react-add]').forEach(el => {
      el.addEventListener('click', (e) => {
        e.stopPropagation();
        _showEmojiPickerFor = el.dataset.reactAdd;
        showEmojiPickerAt(el, el.dataset.reactAdd);
      });
    });
    bar.querySelectorAll('[data-thread-start]').forEach(el => {
      el.addEventListener('click', () => {
        _threadParentId = el.dataset.threadStart;
        _selectedMsgId = null;
        subscribeThread(el.dataset.threadStart);
        render();
      });
    });
    bar.querySelectorAll('[data-pin]').forEach(el => {
      el.addEventListener('click', () => {
        togglePin(el.dataset.pin);
        _selectedMsgId = null;
        bar.remove();
        document.querySelectorAll('.chat-msg--selected').forEach(m => m.classList.remove('chat-msg--selected'));
      });
    });
    bar.querySelectorAll('[data-edit]').forEach(el => {
      el.addEventListener('click', () => {
        _editingMessageId = el.dataset.edit;
        _selectedMsgId = null;
        renderMessages();
        const textarea = document.getElementById(`chat-edit-${el.dataset.edit}`);
        if (textarea) textarea.focus();
      });
    });
    bar.querySelectorAll('[data-delete]').forEach(el => {
      el.addEventListener('click', () => {
        if (confirm('Delete this message?')) {
          deleteMessage(el.dataset.delete);
          _selectedMsgId = null;
          bar.remove();
          document.querySelectorAll('.chat-msg--selected').forEach(m => m.classList.remove('chat-msg--selected'));
        }
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

    // Send button
    const sendBtn = document.getElementById('chat-send-btn');
    if (sendBtn) sendBtn.addEventListener('click', () => handleSend(input));

    // File attach — no per-user auth needed (Apps Script handles Drive access)
    const attachBtn = document.getElementById('chat-attach-btn');
    const fileInput = document.getElementById('chat-file-input');
    if (attachBtn && fileInput) {
      attachBtn.addEventListener('click', () => fileInput.click());
      fileInput.addEventListener('change', async () => {
        const file = fileInput.files[0];
        if (!file) return;
        await handleFileUpload(file, input);
        fileInput.value = '';
      });
    }

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

  function wireThread() {
    const closeBtn = document.getElementById('chat-thread-close');
    if (closeBtn) closeBtn.addEventListener('click', () => {
      _threadParentId = null;
      if (_unsubThread) { _unsubThread(); _unsubThread = null; }
      render();
    });

    const threadInput = document.getElementById('chat-thread-input');
    const threadSend = document.getElementById('chat-thread-send');
    if (threadInput) {
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
    if (threadSend && threadInput) {
      threadSend.addEventListener('click', () => handleThreadSend(threadInput));
    }
    wireThreadMessages();
  }

  function wireThreadMessages() {
    // Wire reactions, edit, delete in thread panel
    const threadEl = document.getElementById('chat-thread');
    if (!threadEl) return;
    threadEl.querySelectorAll('[data-react]').forEach(el => {
      el.addEventListener('click', (e) => {
        e.stopPropagation();
        if (el.dataset.emoji) toggleReaction(el.dataset.react, el.dataset.emoji);
      });
    });
    threadEl.querySelectorAll('[data-react-add]').forEach(el => {
      el.addEventListener('click', (e) => {
        e.stopPropagation();
        _showEmojiPickerFor = _showEmojiPickerFor === el.dataset.reactAdd ? null : el.dataset.reactAdd;
        renderThread();
      });
    });
    threadEl.querySelectorAll('[data-edit]').forEach(el => {
      el.addEventListener('click', () => { _editingMessageId = el.dataset.edit; renderThread(); });
    });
    threadEl.querySelectorAll('[data-save-edit]').forEach(el => {
      el.addEventListener('click', () => {
        const ta = document.getElementById(`chat-edit-${el.dataset.saveEdit}`);
        if (ta) editMessage(el.dataset.saveEdit, ta.value);
      });
    });
    threadEl.querySelectorAll('[data-cancel-edit]').forEach(el => {
      el.addEventListener('click', () => { _editingMessageId = null; renderThread(); });
    });
    threadEl.querySelectorAll('[data-delete]').forEach(el => {
      el.addEventListener('click', () => { if (confirm('Delete this message?')) deleteMessage(el.dataset.delete); });
    });
  }

  function wireModals() {
    // Close modals
    document.querySelectorAll('[data-close-modal]').forEach(el => {
      el.addEventListener('click', () => {
        const which = el.dataset.closeModal;
        if (which === 'directory') _showChannelDirectory = false;
        if (which === 'create') _showCreateChannel = false;
        if (which === 'settings') _showSettings = false;
        if (which === 'pinned') _showPinned = false;
        if (which === 'search') _showSearch = false;
        if (which === 'newdm') _showNewDM = false;
        if (which === 'contacts') _showManageContacts = false;
        if (which === 'seenby') _showSeenBy = null;
        render();
      });
    });

    // Create channel from directory
    const createBtn = document.getElementById('chat-create-channel-btn');
    if (createBtn) createBtn.addEventListener('click', () => {
      _showChannelDirectory = false;
      _showCreateChannel = true;
      render();
    });

    // Do create channel
    const doCreate = document.getElementById('chat-do-create');
    if (doCreate) doCreate.addEventListener('click', () => {
      const name = document.getElementById('chat-new-name')?.value?.trim();
      const display = document.getElementById('chat-new-display')?.value?.trim();
      const desc = document.getElementById('chat-new-desc')?.value?.trim();
      const cat = document.getElementById('chat-new-category')?.value;
      const announce = document.getElementById('chat-new-announce')?.checked || false;
      if (!name) { showToast('Channel name is required'); return; }
      if (!cat) { showToast('Please select a category'); return; }
      createChannel(name, display, desc, cat, announce);
    });

    // Directory subscribe/unsubscribe
    document.querySelectorAll('[data-sub-dir]').forEach(el => {
      el.addEventListener('click', async (e) => {
        e.stopPropagation();
        await subscribeToChannel(el.dataset.subDir);
        render();
      });
    });
    document.querySelectorAll('[data-unsub-dir]').forEach(el => {
      el.addEventListener('click', async (e) => {
        e.stopPropagation();
        await unsubscribeFromChannel(el.dataset.unsubDir);
        render();
      });
    });

    // Directory channel click -> navigate
    document.querySelectorAll('[data-dir-channel]').forEach(el => {
      el.addEventListener('click', () => {
        _showChannelDirectory = false;
        selectChannel(el.dataset.dirChannel);
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

    // Settings save
    const saveSettings = document.getElementById('chat-save-settings');
    if (saveSettings) saveSettings.addEventListener('click', () => {
      const categories = [];
      document.querySelectorAll('[data-cat-idx]').forEach(el => {
        const val = el.value.trim();
        if (val) categories.push(val);
      });
      saveConfig({ categories });
      _showSettings = false;
      render();
    });

    // Add category
    const addCat = document.getElementById('chat-add-cat');
    if (addCat) addCat.addEventListener('click', () => {
      const list = document.getElementById('chat-categories-list');
      if (!list) return;
      const idx = list.children.length;
      const row = document.createElement('div');
      row.className = 'chat-settings-row';
      row.innerHTML = `<input class="app-input" value="" data-cat-idx="${idx}" placeholder="New category" />
        <button class="chat-icon-btn chat-icon-btn--danger" data-remove-cat="${idx}">${svgTrash()}</button>`;
      list.appendChild(row);
      row.querySelector('input').focus();
      row.querySelector('[data-remove-cat]').addEventListener('click', () => row.remove());
    });

    // Remove category
    document.querySelectorAll('[data-remove-cat]').forEach(el => {
      el.addEventListener('click', () => el.closest('.chat-settings-row')?.remove());
    });

    // Chat admin management
    const addAdminBtn = document.getElementById('chat-add-admin-btn');
    if (addAdminBtn) addAdminBtn.addEventListener('click', async () => {
      const select = document.getElementById('chat-add-admin-select');
      const uid = select?.value;
      if (!uid) return;
      const admins = [...(_config.chatAdmins || []), uid];
      await saveConfig({ chatAdmins: admins });
      _showSettings = true; // stay in settings
      render();
    });

    document.querySelectorAll('[data-remove-admin]').forEach(el => {
      el.addEventListener('click', async () => {
        const uid = el.dataset.removeAdmin;
        const admins = (_config.chatAdmins || []).filter(a => a !== uid);
        await saveConfig({ chatAdmins: admins });
        _showSettings = true;
        render();
      });
    });

    // DM user selection
    document.querySelectorAll('[data-dm-user]').forEach(el => {
      el.addEventListener('click', () => createDM([el.dataset.dmUser]));
    });

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

    // ── Manage Contacts modal wiring ──
    // Add contact group
    const addGroupBtn = document.getElementById('chat-add-contact-group');
    if (addGroupBtn) addGroupBtn.addEventListener('click', () => {
      if (!_userMeta.dmContacts) _userMeta.dmContacts = [];
      _userMeta.dmContacts.push({ groupName: 'New Group', uids: [] });
      saveDmContacts();
      render();
    });

    // Remove contact group
    document.querySelectorAll('[data-remove-contact-group]').forEach(el => {
      el.addEventListener('click', () => {
        const gi = parseInt(el.dataset.removeContactGroup);
        _userMeta.dmContacts.splice(gi, 1);
        saveDmContacts();
        render();
      });
    });

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

    // Remove individual contact
    document.querySelectorAll('[data-remove-contact]').forEach(el => {
      el.addEventListener('click', (e) => {
        e.stopPropagation();
        const uid = el.dataset.removeContact;
        for (const group of (_userMeta.dmContacts || [])) {
          group.uids = (group.uids || []).filter(id => id !== uid);
        }
        saveDmContacts();
        render();
      });
    });

    // Add contact from the people list
    document.querySelectorAll('[data-do-add-contact]').forEach(el => {
      el.addEventListener('click', (e) => {
        e.stopPropagation();
        const uid = el.dataset.doAddContact;
        if (!_userMeta.dmContacts) _userMeta.dmContacts = [];
        // Add to first group, or create one
        if (_userMeta.dmContacts.length === 0) {
          _userMeta.dmContacts.push({ groupName: 'Contacts', uids: [uid] });
        } else {
          if (!_userMeta.dmContacts[0].uids.includes(uid)) {
            _userMeta.dmContacts[0].uids.push(uid);
          }
        }
        saveDmContacts();
        render();
      });
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

    // Done button
    const saveContacts = document.getElementById('chat-save-contacts');
    if (saveContacts) saveContacts.addEventListener('click', () => {
      _showManageContacts = false;
      render();
    });

    // Search input
    const searchInput = document.getElementById('chat-search-input');
    if (searchInput) {
      searchInput.focus();
      searchInput.addEventListener('input', () => {
        _searchQuery = searchInput.value;
        const results = searchMessages(_searchQuery);
        const container = document.querySelector('.chat-search-results');
        if (container) {
          container.innerHTML = _searchQuery && results.length === 0
            ? '<p class="chat-muted">No results found.</p>'
            : results.map(m => `<div class="chat-search-result" data-goto-msg="${m.id}">
                <span class="chat-msg-author">${escHTML(m.authorName)}</span>
                <span class="chat-msg-time">${formatTimestamp(m.createdAt)}</span>
                <div class="chat-msg-text">${parseMarkdown(m.text)}</div>
              </div>`).join('');
          container.querySelectorAll('[data-goto-msg]').forEach(r => {
            r.addEventListener('click', () => {
              _showSearch = false;
              render();
              setTimeout(() => {
                const target = document.getElementById(`msg-${r.dataset.gotoMsg}`);
                if (target) target.scrollIntoView({ behavior: 'smooth', block: 'center' });
              }, 100);
            });
          });
        }
      });
    }
  }

  function wireDragDrop() {
    // Already handled in wireSidebar for channel organization
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
        const file = e.dataTransfer.files?.[0];
        if (file) {
          const input = document.getElementById('chat-input');
          await handleFileUpload(file, input);
        }
      });
    });
  }

  function wireFeedScroll() {
    const feed = document.getElementById('chat-feed');
    if (!feed) return;
    feed.addEventListener('scroll', () => {
      if (_isRendering) return; // Don't update scroll state during DOM rebuilds
      const atBottom = feed.scrollHeight - feed.scrollTop - feed.clientHeight < 100;
      _autoScroll = atBottom;
      // Remove new messages button if at bottom
      if (atBottom) {
        const btn = document.getElementById('chat-new-msgs-btn');
        if (btn) btn.remove();
      }
      // Load older on scroll to top
      if (feed.scrollTop < 50 && _hasMoreMessages && !_loadingOlder) {
        loadOlderMessages();
      }
    });
  }

  function wireMobile() {
    // Conversation list item clicks
    document.querySelectorAll('[data-conv-channel]').forEach(el => {
      el.addEventListener('click', () => {
        selectChannel(el.dataset.convChannel);
      });
    });

    // Tab bar clicks
    document.querySelectorAll('[data-chat-tab]').forEach(el => {
      el.addEventListener('click', () => {
        _mobileTab = el.dataset.chatTab;
        if (_mobileTab === 'search') { _showSearch = true; _searchQuery = ''; }
        render();
      });
    });

    // Center active tab
    const tabBar = document.getElementById('chat-mobile-tabs');
    if (tabBar) {
      const active = tabBar.querySelector('.chat-mobile-tab--active');
      if (active) {
        const containerW = tabBar.offsetWidth;
        const idealScroll = active.offsetLeft - (containerW / 2) + (active.offsetWidth / 2);
        const maxScroll = tabBar.scrollWidth - containerW;
        tabBar.scrollTo({ left: Math.max(0, Math.min(idealScroll, maxScroll)), behavior: 'smooth' });
      }
    }

    // Hamburger menu
    const hamburgerBtn = document.getElementById('mobile-hamburger-btn');
    if (hamburgerBtn) hamburgerBtn.addEventListener('click', () => { _mobileHamburgerOpen = true; render(); });

    const hamburgerClose = document.getElementById('mobile-hamburger-close');
    if (hamburgerClose) hamburgerClose.addEventListener('click', () => { _mobileHamburgerOpen = false; render(); });

    const hamburgerOverlay = document.getElementById('mobile-hamburger-overlay');
    if (hamburgerOverlay) hamburgerOverlay.addEventListener('click', () => { _mobileHamburgerOpen = false; render(); });

    // Hamburger menu items
    const menuBrowse = document.getElementById('mobile-menu-browse');
    if (menuBrowse) menuBrowse.addEventListener('click', () => { _mobileHamburgerOpen = false; _showChannelDirectory = true; render(); });

    const menuNewDM = document.getElementById('mobile-menu-new-dm');
    if (menuNewDM) menuNewDM.addEventListener('click', () => { _mobileHamburgerOpen = false; _showNewDM = true; render(); });

    const menuContacts = document.getElementById('mobile-menu-contacts');
    if (menuContacts) menuContacts.addEventListener('click', () => { _mobileHamburgerOpen = false; _showManageContacts = true; render(); });

    const menuSettings = document.getElementById('mobile-menu-settings');
    if (menuSettings) menuSettings.addEventListener('click', () => { _mobileHamburgerOpen = false; _showSettings = true; render(); });

    // "All Lab Apps" in embedded mode — navigate parent
    const menuAllApps = document.getElementById('mobile-menu-all-apps');
    if (menuAllApps) menuAllApps.addEventListener('click', (e) => { e.preventDefault(); window.parent.location.hash = '#/apps'; });

    // Bottom bar — prevent same-app navigation
    document.querySelectorAll('[data-app-nav]').forEach(el => {
      if (el.dataset.appNav === 'chat') {
        el.addEventListener('click', (e) => e.preventDefault());
      }
    });
  }

  function wireOverview() {
    // Collapsible section toggles
    document.querySelectorAll('[data-toggle-section]').forEach(el => {
      el.addEventListener('click', (e) => {
        // Don't toggle if clicking the manage-contacts button inside the header
        if (e.target.closest('#chat-overview-manage-contacts')) return;
        const key = el.dataset.toggleSection;
        if (_collapsedSections.has(key)) _collapsedSections.delete(key);
        else _collapsedSections.add(key);
        render();
      });
    });

    // Channel clicks
    document.querySelectorAll('[data-overview-channel]').forEach(el => {
      el.addEventListener('click', () => selectChannel(el.dataset.overviewChannel));
    });

    // DM contact clicks
    document.querySelectorAll('[data-overview-dm]').forEach(el => {
      el.addEventListener('click', () => {
        const uid = el.dataset.overviewDm;
        const dmCh = _channels.find(c => c.type === 'dm' && c.members && c.members.includes(uid) && c.members.includes(_user.uid));
        if (dmCh) {
          selectChannel(dmCh.id);
        } else {
          createDM([uid]);
        }
      });
    });

    // Action buttons
    const browseBtn = document.getElementById('chat-overview-browse');
    if (browseBtn) browseBtn.addEventListener('click', () => { _showChannelDirectory = true; render(); });

    const newDMBtn = document.getElementById('chat-overview-new-dm');
    if (newDMBtn) newDMBtn.addEventListener('click', () => { _showNewDM = true; render(); });

    const manageBtn = document.getElementById('chat-overview-manage-contacts');
    if (manageBtn) manageBtn.addEventListener('click', (e) => { e.stopPropagation(); _showManageContacts = true; render(); });

    const searchBtn = document.getElementById('chat-overview-search');
    if (searchBtn) searchBtn.addEventListener('click', () => { _showSearch = true; _searchQuery = ''; render(); });
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
      textInput.value = '';
      _autoScroll = true;
      await sendMessage(text || `Shared a file: ${file.name}`, fileData, null);
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

    // Wire mention clicks
    popup.querySelectorAll('[data-mention-uid]').forEach(el => {
      el.addEventListener('click', () => {
        const u = _allUsers.find(a => a.uid === el.dataset.mentionUid);
        if (u) {
          const input = document.getElementById('chat-input');
          const mentionText = `@${(u.name || u.displayName || u.email).replace(/\s+/g, '.')}`;
          insertMention(input, mentionText);
        }
        _mentionQuery = null;
        renderMentionPopup();
      });
    });
    popup.querySelectorAll('[data-mention-channel]').forEach(el => {
      el.addEventListener('click', () => {
        const input = document.getElementById('chat-input');
        insertMention(input, '@channel');
        _mentionQuery = null;
        renderMentionPopup();
      });
    });
  }

  function showEmojiPickerAt(triggerEl, msgId) {
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
        toggleReaction(msgId, btn.dataset.emoji);
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
    if (!str) return '';
    return str.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
  }

  function getInitials(name) {
    if (!name) return '?';
    return name.split(/\s+/).map(w => w[0]).slice(0, 2).join('').toUpperCase();
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

  function getCategoryLabel(cat) {
    const labels = {
      pi: 'PI', postdoc: 'Postdoc', grad: 'Grad', undergrad: 'Undergrad',
      highschool: 'High School', alumni: 'Alumni', guest: 'Guest'
    };
    return labels[(cat || '').toLowerCase()] || 'Other';
  }

  function scrollToBottom() {
    const feed = document.getElementById('chat-feed');
    if (feed) feed.scrollTop = feed.scrollHeight;
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
    if (McgheeLab.AppBridge.isEmbedded()) {
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
