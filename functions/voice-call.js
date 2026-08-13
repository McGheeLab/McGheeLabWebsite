/* ================================================================
   voice-call.js — Voice call (Slack-style huddle) server side
   ================================================================
   onVoiceCallCreate — voiceCalls/{channelId} onCreate

   "Ringing": when someone starts a call in a chat channel, push an
   FCM notification to that channel's recipients (same targeted
   lookup as chat messages: chatChannels.members for DMs,
   chatChannels.subscriberUids for channels), minus the starter.
   Muted channels are respected; mentionsOnly is NOT (a call can't
   mention anyone — it's inherently an @here).

   The call doc id IS the chat channel id, so the deep link reuses
   chat's ?channel= param — landing in the channel shows the live
   📞 button to join.

   Deploy: firebase deploy --only functions:onVoiceCallCreate
   ================================================================ */

const { onDocumentCreated } = require('firebase-functions/v2/firestore');
const { getFirestore } = require('firebase-admin/firestore');
const { getMessaging } = require('firebase-admin/messaging');
const { sendToUsers } = require('./helpers/notify');

const APP_KEY = 'chat'; // rides chat's per-user push toggle

const onVoiceCallCreate = onDocumentCreated('voiceCalls/{channelId}', async (event) => {
  const snap = event.data;
  if (!snap) return;
  const call = snap.data();
  if (call.active !== true) return;

  const channelId = event.params.channelId;
  const db = getFirestore();
  const messaging = getMessaging();

  const channelDoc = await db.collection('chatChannels').doc(channelId).get();
  if (!channelDoc.exists) return; // orphan call doc — nothing to ring
  const channel = channelDoc.data();
  const isDM = channel.type === 'dm';
  const channelName = channel.displayName || channel.name || channelId;

  // Targeted recipients (no self-heal here — chat.js's message trigger
  // owns that; a pre-backfill channel just doesn't ring this once).
  const candidateUids = (isDM ? channel.members : channel.subscriberUids) || [];
  let targetUids = candidateUids.filter((uid) => uid !== call.startedBy);

  // Respect muted channels (not for DMs — mute never applied to DMs).
  if (!isDM && targetUids.length) {
    const refs = targetUids.map((u) => db.collection('chatUserMeta').doc(u));
    const metas = [];
    for (let i = 0; i < refs.length; i += 100) {
      metas.push(...await db.getAll(...refs.slice(i, i + 100)));
    }
    targetUids = metas
      .filter((d) => !((d.data() || {}).mutedChannels || []).includes(channelId))
      .map((d) => d.id);
  }

  if (targetUids.length === 0) return;

  await sendToUsers(db, messaging, targetUids, {
    title: `📞 ${call.startedByName || 'Someone'} started a call`,
    body: isDM ? 'Tap to join the call.' : `In #${channelName} — tap to join.`,
    url: `/rm/pages/chat.html?channel=${encodeURIComponent(channelId)}`,
    tag: `voice-call-${channelId}`,
    // V3.596 — a ringing call is not a message: never presence-suppress it.
    // Being on the chat page is exactly when you can still answer.
    urgent: true,
  }, APP_KEY);
});

module.exports = { onVoiceCallCreate };
