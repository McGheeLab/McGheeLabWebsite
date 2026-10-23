/* ================================================================
   chat-alert-watch.js — RM-wide corner alert for new chat messages
   ================================================================
   Loaded on every RM page EXCEPT chat (chat.js runs its own richer
   in-page version — this script bails when #chat-root exists).

   Watches chatChannels for lastMessage changes and pops ONE dismissible
   bottom-corner card per burst of new messages in channels the signed-in
   user subscribes to (or DMs they're in). Click → chat.html?channel=…
   (deep link handled by chat.js). Same burst semantics as the chat-page
   version: the visible card absorbs new channels instead of stacking,
   and after it hides a cooldown suppresses re-alerts. Alerts arriving
   while the tab is hidden queue until the tab is visible again.

   Self-contained: injects its own styles; silently no-ops when
   firebridge / the Firestore SDK aren't on the page or the user is a
   guest. Cost: one chatChannels listener + own chatUserMeta doc per
   open RM page — lab-scale cheap.
   ================================================================ */
(() => {
  'use strict';
  if (document.getElementById('chat-root')) return; // chat page has its own

  const COOLDOWN_MS = 3 * 60 * 1000;
  const AUTOFADE_MS = 8000;

  const ENTRY_FLAG = 'rmChatUnreadAlerted'; // sessionStorage: once per tab session

  let _user = null;
  let _meta = null;          // own chatUserMeta (subscriptions, mutes)
  let _readStates = {};      // channelId -> own chatReadState (entry unread check)
  let _seen = {};            // channelId -> millis of newest processed lastMessage
  let _init = false;         // first snapshot seeds baselines (+ entry check)
  let _queue = [];           // [{id, name}] accumulated for the current burst
  let _entryMode = false;    // card labeled "Unread…" instead of "New…"
  let _cooldownUntil = 0;
  let _fadeTimer = null;

  const CSS = `
#rm-chat-alert{position:fixed;right:16px;bottom:calc(16px + env(safe-area-inset-bottom,0px));z-index:1200;display:flex;align-items:stretch;background:var(--surface,#fff);border:1px solid var(--border,#e5e7eb);border-radius:10px;box-shadow:0 6px 24px rgba(0,0,0,.18);overflow:hidden;opacity:0;transform:translateY(8px);transition:opacity .2s,transform .2s;max-width:min(340px,calc(100vw - 32px));font-family:inherit}
#rm-chat-alert.rm-chat-alert--show{opacity:1;transform:translateY(0)}
#rm-chat-alert .rm-chat-alert-body{display:flex;align-items:center;gap:.5rem;border:none;background:none;color:var(--text,#111827);font-size:.8rem;font-weight:600;padding:.65rem .25rem .65rem .8rem;cursor:pointer;text-align:left;min-width:0}
#rm-chat-alert .rm-chat-alert-body span{overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
#rm-chat-alert .rm-chat-alert-x{border:none;background:none;color:var(--text-muted,#6b7280);cursor:pointer;padding:0 .6rem;font-size:.85rem}
#rm-chat-alert .rm-chat-alert-x:hover{color:var(--text,#111827)}`;

  function injectStyles() {
    if (document.getElementById('rm-chat-alert-css')) return;
    const s = document.createElement('style');
    s.id = 'rm-chat-alert-css';
    s.textContent = CSS;
    document.head.appendChild(s);
  }

  function channelLabel(ch) {
    if (ch.type === 'dm') {
      return (ch.lastMessage && ch.lastMessage.authorName) || 'Direct message';
    }
    return '#' + (ch.displayName || ch.name || 'channel');
  }

  // Would this channel's lastMessage alert the user at all?
  function alertEligible(ch) {
    const lm = ch.lastMessage;
    if (!lm || lm.authorUid === _user.uid) return false;
    if (((_meta && _meta.mutedChannels) || []).includes(ch.id)) return false;
    return ch.type === 'dm'
      ? (ch.members || []).includes(_user.uid)
      : ((_meta && _meta.subscribedChannels) || []).includes(ch.id);
  }

  // Entry check (Alex): on arriving in RM with UNREAD chats (lastMessage
  // newer than my chatReadState.lastReadAt), pop the card once per tab
  // session — sessionStorage-guarded so page-to-page navigation inside
  // RM doesn't re-alert on every load.
  function entryUnreadCheck(channels) {
    try { if (sessionStorage.getItem(ENTRY_FLAG)) return; } catch (e) {}
    const unread = [];
    for (const ch of channels) {
      if (!alertEligible(ch)) continue;
      const lm = ch.lastMessage;
      const t = (lm.timestamp && lm.timestamp.toMillis) ? lm.timestamp.toMillis() : 0;
      if (!t) continue;
      const rs = _readStates[ch.id];
      const lastRead = (rs && rs.lastReadAt && rs.lastReadAt.toMillis) ? rs.lastReadAt.toMillis() : 0;
      if (t > lastRead) unread.push({ id: ch.id, name: channelLabel(ch) });
    }
    if (!unread.length) return;
    try { sessionStorage.setItem(ENTRY_FLAG, String(Date.now())); } catch (e) {}
    _entryMode = true;
    unread.forEach(f => { if (!_queue.some(q => q.id === f.id)) _queue.push(f); });
    if (document.visibilityState === 'visible') show();
  }

  function process(channels) {
    const fresh = [];
    for (const ch of channels) {
      const lm = ch.lastMessage;
      const t = (lm && lm.timestamp && lm.timestamp.toMillis) ? lm.timestamp.toMillis() : 0;
      const prev = _seen[ch.id] || 0;
      if (t > prev) _seen[ch.id] = t;
      if (!_init || !lm || t <= prev) continue;
      if (!alertEligible(ch)) continue;
      fresh.push({ id: ch.id, name: channelLabel(ch) });
    }
    if (!_init) {
      _init = true;
      entryUnreadCheck(channels);
      return;
    }
    if (!fresh.length) return;
    const cardShowing = !!document.getElementById('rm-chat-alert');
    if (!cardShowing && Date.now() < _cooldownUntil) return;
    fresh.forEach(f => { if (!_queue.some(q => q.id === f.id)) _queue.push(f); });
    if (document.visibilityState === 'visible') show();
  }

  function show() {
    if (!_queue.length) return;
    injectStyles();
    const names = _queue.slice(0, 2).map(q => q.name);
    const extra = _queue.length > 2 ? ` +${_queue.length - 2}` : '';
    const prefix = _entryMode
      ? (_queue.length === 1 ? 'Unread message in ' : 'Unread messages in ')
      : (_queue.length === 1 ? 'New message in ' : 'New messages in ');
    const label = prefix + names.join(', ') + extra;
    let el = document.getElementById('rm-chat-alert');
    if (!el) {
      el = document.createElement('div');
      el.id = 'rm-chat-alert';
      el.innerHTML = `
        <button type="button" class="rm-chat-alert-body">${ICON.svg('chat-bubble-left-right')} <span></span></button>
        <button type="button" class="rm-chat-alert-x" title="Dismiss">✕</button>`;
      document.body.appendChild(el);
      el.querySelector('.rm-chat-alert-body').addEventListener('click', () => {
        const target = _queue[_queue.length - 1];
        hide();
        if (target) location.href = '/rm/pages/chat.html?channel=' + encodeURIComponent(target.id);
      });
      el.querySelector('.rm-chat-alert-x').addEventListener('click', hide);
    }
    el.querySelector('.rm-chat-alert-body > span:last-child').textContent = label;
    requestAnimationFrame(() => el.classList.add('rm-chat-alert--show'));
    clearTimeout(_fadeTimer);
    // The entry "you have unread chats" card lingers longer than the
    // live-message card — it's the only prompt the user will get.
    _fadeTimer = setTimeout(hide, _entryMode ? 15000 : AUTOFADE_MS);
  }

  function hide() {
    clearTimeout(_fadeTimer);
    const el = document.getElementById('rm-chat-alert');
    if (el) el.remove();
    _queue = [];
    _entryMode = false;
    _cooldownUntil = Date.now() + COOLDOWN_MS;
  }

  // V3.585 — unsubs captured so tab-lifecycle can detach/re-attach (they
  // were previously dropped on the floor).
  let _unsubMeta = null;
  let _unsubChannels = null;
  function attachAlertListeners(db) {
    _unsubMeta = db.collection('chatUserMeta').doc(_user.uid).onSnapshot(
      s => { if (s.exists) _meta = s.data(); }, () => {});
    _unsubChannels = db.collection('chatChannels').onSnapshot(
      snap => process(snap.docs.map(d => ({ id: d.id, ...d.data() }))),
      () => {});
  }

  function boot() {
    if (typeof firebridge === 'undefined' || !firebridge.whenAuthResolved) return;
    firebridge.whenAuthResolved().then(async () => {
      _user = firebridge.getUser ? firebridge.getUser() : null;
      const profile = firebridge.getProfile ? firebridge.getProfile() : null;
      if (!_user || !profile || profile.role === 'guest') return;
      let db;
      try { db = firebridge.db(); } catch (e) { return; }
      if (!db) return;
      // Load own meta + read states BEFORE the channels listener so the
      // first snapshot can run the entry unread check with real data.
      try {
        const [metaSnap, rsSnap] = await Promise.all([
          db.collection('chatUserMeta').doc(_user.uid).get(),
          db.collection('chatReadState').where('uid', '==', _user.uid).get()
        ]);
        if (metaSnap.exists) _meta = metaSnap.data();
        rsSnap.docs.forEach(d => {
          const x = d.data();
          if (x.channelId) _readStates[x.channelId] = x;
        });
      } catch (e) { /* entry check degrades gracefully */ }
      attachAlertListeners(db);
      document.addEventListener('visibilitychange', () => {
        if (document.visibilityState === 'visible' && _queue.length
            && !document.getElementById('rm-chat-alert')) {
          show();
        }
      });
      // V3.585 — tab-lifecycle (Ourlab app multi-WebView shell): this script
      // runs on EVERY page, so 4 hidden warm tabs would each hold these two
      // listeners. Detach while hidden; re-attach on visible with _init reset
      // so the first snapshot re-baselines _seen silently (missed-while-
      // hidden messages surface via unread affordances, not an alert storm).
      // Inert on web (events never fire). Raw events, not the page hook —
      // the page hook belongs to the page's own module (e.g. chat.js).
      document.addEventListener('ourlab:tab-hidden', () => {
        try { _unsubMeta && _unsubMeta(); } catch (e) {}
        try { _unsubChannels && _unsubChannels(); } catch (e) {}
        _unsubMeta = _unsubChannels = null;
      });
      document.addEventListener('ourlab:tab-visible', () => {
        if (_unsubChannels || !_user) return;
        _init = false;
        attachAlertListeners(db);
      });
    }).catch(() => {});
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', boot);
  } else {
    boot();
  }
})();
