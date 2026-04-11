/* ================================================================
   chat.js — Push notifications for Lab Chat messages
   ================================================================
   Trigger: chatMessages/{messageId} onCreate

   Notifies channel subscribers when a new message is posted.
   Respects muted channels, mentions-only preferences, and DMs.
   ================================================================ */

const { onDocumentCreated } = require('firebase-functions/v2/firestore');
const { getFirestore } = require('firebase-admin/firestore');
const { getMessaging } = require('firebase-admin/messaging');
const { sendToUsers } = require('./helpers/notify');

const APP_KEY = 'chat';
const TEXT_PREVIEW_LEN = 120;

const onChatMessageCreate = onDocumentCreated('chatMessages/{messageId}', async (event) => {
  const snap = event.data;
  if (!snap) return;

  const msg = snap.data();
  const { channelId, authorUid, authorName, text, type, deleted,
          mentions, mentionsChannel, threadParentId } = msg;

  // Skip deleted messages or file-only messages with no text
  if (deleted) return;
  if (type === 'file' && !text) return;

  const db = getFirestore();
  const messaging = getMessaging();

  // Look up channel info
  const channelDoc = await db.collection('chatChannels').doc(channelId).get();
  if (!channelDoc.exists) return;

  const channel = channelDoc.data();
  const channelName = channel.displayName || channel.name || channelId;
  const isDM = channel.type === 'dm';

  // Build notification content
  const bodyText = text
    ? (text.length > TEXT_PREVIEW_LEN ? text.substring(0, TEXT_PREVIEW_LEN) + '...' : text)
    : (type === 'file' ? 'sent a file' : 'sent a message');

  const notif = {
    title: isDM ? authorName : `#${channelName}`,
    body: isDM ? bodyText : `${authorName}: ${bodyText}`,
    url: `/#/apps/chat?channel=${channelId}`,
    tag: `chat-${channelId}`,
  };

  // For thread replies, adjust the notification
  if (threadParentId) {
    notif.title = isDM ? authorName : `#${channelName} (thread)`;
    notif.tag = `chat-thread-${threadParentId}`;
  }

  // Determine who to notify
  let targetUids = [];

  if (isDM) {
    // For DMs, notify all channel members except the sender.
    // DM channel names are typically formatted as dm_{uid1}_{uid2},
    // but we check the channel's member list if available.
    // Fall back to checking chatUserMeta for users subscribed to this DM channel.
    const metaSnap = await db.collection('chatUserMeta').get();
    metaSnap.forEach((doc) => {
      const meta = doc.data();
      const uid = doc.id;
      if (uid === authorUid) return;
      const dmChannels = meta.dmChannelIds || [];
      if (dmChannels.includes(channelId)) {
        targetUids.push(uid);
      }
    });
  } else {
    // For regular channels, query chatUserMeta for subscribers
    const metaSnap = await db.collection('chatUserMeta').get();
    const mentionSet = new Set(mentions || []);

    metaSnap.forEach((doc) => {
      const meta = doc.data();
      const uid = doc.id;

      // Skip the message author
      if (uid === authorUid) return;

      // Must be subscribed to this channel
      const subscribed = (meta.subscribedChannels || []).includes(channelId);
      if (!subscribed) return;

      // Skip if user muted this channel
      const muted = (meta.mutedChannels || []).includes(channelId);
      if (muted) return;

      // If user wants mentions only, check if they were mentioned
      const prefs = meta.notificationPrefs || {};
      if (prefs.mentionsOnly) {
        const isMentioned = mentionSet.has(uid) || mentionsChannel === true;
        if (!isMentioned) return;
      }

      targetUids.push(uid);
    });
  }

  if (targetUids.length === 0) return;

  await sendToUsers(db, messaging, targetUids, notif, APP_KEY);
});

module.exports = { onChatMessageCreate };
