/* ================================================================
   chat.js — Lab Chat server side
   ================================================================
   1) onChatMessageCreate — chatMessages/{messageId} onCreate
      - FCM push to channel subscribers / DM members (muted +
        mentions-only prefs respected, author skipped).
      - Chat program R2: mention-badge fan-out and channel counters
        moved SERVER-side, gated on msg.fanout === 'v2' (messages
        from stale clients keep doing their own client-side writes,
        so there is no double counting in either direction).
      - Recipient lookup is TARGETED: `chatChannels.subscriberUids`
        for channels, `chatChannels.members` for DMs. The old code
        scanned the ENTIRE chatUserMeta collection on every message
        (twice the code paths, O(all users) reads per message).
        Channels created before the backfill self-heal: one legacy
        scan computes the list and persists it onto the channel doc.

   2) chatBackfillSubscribers — onRequest (Bearer ID token; site
      admin or chat admin). One-time inversion of every user's
      chatUserMeta.subscribedChannels into chatChannels.subscriberUids.
      GET is a health probe. Triggered from chat's admin settings
      modal ("Backfill subscriber lists" button).

   3) chatImportSlackHistory — onRequest (Bearer ID token). V3.582:
      bulk-imports a parsed Slack chat log into a channel/DM as
      backdated messages attributed to OTHER users — which client
      writes can't do (rules pin authorUid == auth.uid), hence Admin
      SDK. mode:'import' (DM member, or chat/site admin for channels)
      and mode:'undo' (importer or admin; deletes a whole batch).
      Imported docs carry imported:true so trigger (1) skips them —
      no counters, no mention fan-out, and above all no FCM push per
      imported message.

   Deploy: firebase deploy --only functions:onChatMessageCreate,functions:chatBackfillSubscribers,functions:chatImportSlackHistory
   ================================================================ */

const { onDocumentCreated } = require('firebase-functions/v2/firestore');
const { onRequest } = require('firebase-functions/v2/https');
const { getFirestore, FieldValue, Timestamp } = require('firebase-admin/firestore');
const { getMessaging } = require('firebase-admin/messaging');
const admin = require('firebase-admin');
const { sendToUsers } = require('./helpers/notify');

const APP_KEY = 'chat';
const TEXT_PREVIEW_LEN = 120;
const LAST_MSG_PREVIEW_LEN = 100;

/* Site admin (users/{uid}.role) OR listed chat admin
   (chatConfig/settings.chatAdmins). Shared by chatBackfillSubscribers
   and chatImportSlackHistory. */
async function isChatAdminUid(db, uid) {
  const userDoc = await db.collection('users').doc(uid).get();
  if (userDoc.exists && (userDoc.data() || {}).role === 'admin') return true;
  const cfg = await db.collection('chatConfig').doc('settings').get();
  return cfg.exists && ((cfg.data() || {}).chatAdmins || []).includes(uid);
}

/* ── Candidate recipients for a message's channel ──
   DM: the channel's members[]. Channel: subscriberUids[].
   Self-heal: a pre-backfill channel (field missing entirely) gets ONE
   legacy chatUserMeta scan whose result is persisted back onto the
   channel doc — so it never scans again. An empty array is a valid
   answer (nobody subscribed), NOT a trigger to heal. */
async function getCandidateUids(db, channelId, channel) {
  if (channel.type === 'dm') return channel.members || [];
  if (Array.isArray(channel.subscriberUids)) return channel.subscriberUids;
  const metaSnap = await db.collection('chatUserMeta').get();
  const uids = [];
  metaSnap.forEach((doc) => {
    const subs = (doc.data() || {}).subscribedChannels || [];
    if (subs.includes(channelId)) uids.push(doc.id);
  });
  await db.collection('chatChannels').doc(channelId)
    .set({ subscriberUids: uids }, { merge: true });
  console.log(`[chat] self-healed subscriberUids for ${channelId} (${uids.length} subscribers)`);
  return uids;
}

/* Batch-fetch chatUserMeta docs for ONLY the candidate uids
   (db.getAll chunked; no collection scans). Map<uid, meta|null>. */
async function getMetaForUids(db, uids) {
  const map = new Map();
  if (!uids.length) return map;
  const refs = uids.map((u) => db.collection('chatUserMeta').doc(u));
  for (let i = 0; i < refs.length; i += 100) {
    const docs = await db.getAll(...refs.slice(i, i + 100));
    docs.forEach((d) => map.set(d.id, d.exists ? d.data() : null));
  }
  return map;
}

/* Mention-badge fan-out (replaces the client's per-user get+update
   loop). Targets = (@channel ? candidates : mentions ∩ candidates)
   minus the author. set-merge also CREATES chatReadState docs for
   subscribers who've never opened the channel — the old client loop
   silently skipped those. Admin SDK bypasses rules, which lets R4
   lock chatReadState down to owner-only client writes. */
async function applyMentionFanout(db, msg, channelId, candidateUids) {
  const candidates = new Set(candidateUids);
  const targets = (msg.mentionsChannel === true
    ? candidateUids
    : (msg.mentions || []).filter((u) => candidates.has(u))
  ).filter((u) => u !== msg.authorUid);
  if (!targets.length) return;
  const batch = db.batch();
  targets.forEach((uid) => {
    batch.set(db.collection('chatReadState').doc(`${uid}_${channelId}`), {
      uid,
      channelId,
      mentionCount: FieldValue.increment(1),
    }, { merge: true });
  });
  await batch.commit();
}

/* Channel counters (replaces the client's secondary writes after
   every send): top-level message → channel lastMessage/lastActivityAt/
   messageCount; thread reply → parent threadReplyCount/threadLastReplyAt
   (blind increment — the old client did a read+write). */
async function applyChannelCounters(db, msg, channelId) {
  const ts = msg.createdAt || FieldValue.serverTimestamp();
  if (msg.threadParentId) {
    await db.collection('chatMessages').doc(msg.threadParentId).set({
      threadReplyCount: FieldValue.increment(1),
      threadLastReplyAt: ts,
    }, { merge: true });
    return;
  }
  const preview = msg.file
    ? `📎 ${msg.file.name || 'file'}`
    : String(msg.text || '').substring(0, LAST_MSG_PREVIEW_LEN);
  await db.collection('chatChannels').doc(channelId).set({
    lastMessage: {
      text: preview,
      authorName: msg.authorName || '',
      authorUid: msg.authorUid || '',
      timestamp: ts,
    },
    lastActivityAt: ts,
    messageCount: FieldValue.increment(1),
  }, { merge: true });
}

const onChatMessageCreate = onDocumentCreated('chatMessages/{messageId}', async (event) => {
  const snap = event.data;
  if (!snap) return;

  const msg = snap.data();
  const { channelId, authorUid, authorName, text, type, deleted,
          mentions, mentionsChannel, threadParentId } = msg;

  // Skip deleted messages or file-only messages with no text
  if (deleted) return;
  if (type === 'file' && !text) return;
  // Slack-history imports (chatImportSlackHistory): no counters, no
  // mention fan-out, no push — a 1500-message import must be silent.
  if (msg.imported) return;

  const db = getFirestore();
  const messaging = getMessaging();

  // Look up channel info
  const channelDoc = await db.collection('chatChannels').doc(channelId).get();
  if (!channelDoc.exists) return;

  const channel = channelDoc.data();
  const channelName = channel.displayName || channel.name || channelId;
  const isDM = channel.type === 'dm';

  // Targeted candidate list — no full-collection scans.
  const candidateUids = await getCandidateUids(db, channelId, channel);

  // R2 server-side writes — only for messages from upgraded clients
  // (fanout === 'v2'); stale clients still do these writes themselves.
  if (msg.fanout === 'v2') {
    await Promise.all([
      applyMentionFanout(db, msg, channelId, candidateUids),
      applyChannelCounters(db, msg, channelId),
    ]);
  }

  // Build notification content
  const bodyText = text
    ? (text.length > TEXT_PREVIEW_LEN ? text.substring(0, TEXT_PREVIEW_LEN) + '...' : text)
    : (type === 'file' ? 'sent a file' : 'sent a message');

  const notif = {
    title: isDM ? authorName : `#${channelName}`,
    body: isDM ? bodyText : `${authorName}: ${bodyText}`,
    url: `/rm/pages/chat.html?channel=${channelId}`,
    tag: `chat-${channelId}`,
  };

  // For thread replies, adjust the notification
  if (threadParentId) {
    notif.title = isDM ? authorName : `#${channelName} (thread)`;
    notif.tag = `chat-thread-${threadParentId}`;
  }

  // Determine who to notify — candidates minus author, then prefs.
  let targetUids = [];

  if (isDM) {
    // DMs: every member except the sender (mute/mentions-only prefs
    // have never applied to DMs — unchanged).
    targetUids = candidateUids.filter((uid) => uid !== authorUid);
  } else {
    const metaByUid = await getMetaForUids(
      db, candidateUids.filter((uid) => uid !== authorUid));
    const mentionSet = new Set(mentions || []);
    for (const [uid, meta] of metaByUid) {
      if (!meta) { targetUids.push(uid); continue; }
      if ((meta.mutedChannels || []).includes(channelId)) continue;
      const prefs = meta.notificationPrefs || {};
      if (prefs.mentionsOnly) {
        const isMentioned = mentionSet.has(uid) || mentionsChannel === true;
        if (!isMentioned) continue;
      }
      targetUids.push(uid);
    }
  }

  if (targetUids.length === 0) return;

  await sendToUsers(db, messaging, targetUids, notif, APP_KEY);
});

/* ── One-time backfill: chatUserMeta.subscribedChannels →
   chatChannels.subscriberUids. Safe to re-run (idempotent overwrite
   with the freshly computed truth). ── */
const chatBackfillSubscribers = onRequest({
  cors: true,
  maxInstances: 1,
  memory: '256MiB',
  timeoutSeconds: 120,
}, async (req, res) => {
  if (req.method === 'GET') {
    res.status(200).send('chatBackfillSubscribers ok');
    return;
  }
  if (req.method !== 'POST') {
    res.status(405).json({ error: 'Method not allowed' });
    return;
  }

  /* Verify Firebase ID token (same gate as restorePaperComments). */
  const authHeader = req.get('Authorization') || '';
  const m = authHeader.match(/^Bearer\s+(.+)$/i);
  if (!m) { res.status(401).json({ error: 'Missing Bearer token.' }); return; }
  let decoded;
  try {
    decoded = await admin.auth().verifyIdToken(m[1]);
  } catch (err) {
    res.status(401).json({ error: 'Invalid Firebase token: ' + err.message });
    return;
  }
  const uid = decoded.uid;
  const db = admin.firestore();

  /* Authorize: site admin OR listed chat admin. */
  if (!(await isChatAdminUid(db, uid))) {
    res.status(403).json({ error: 'Admin or chat-admin required.' });
    return;
  }

  /* Invert subscriptions: ONE chatUserMeta scan → per-channel uid lists. */
  const metaSnap = await db.collection('chatUserMeta').get();
  const byChannel = {}; // channelId -> uids[]
  metaSnap.forEach((doc) => {
    ((doc.data() || {}).subscribedChannels || []).forEach((chId) => {
      (byChannel[chId] = byChannel[chId] || []).push(doc.id);
    });
  });

  const chSnap = await db.collection('chatChannels').get();
  let channels = 0;
  let batch = db.batch();
  let ops = 0;
  for (const doc of chSnap.docs) {
    if ((doc.data() || {}).type === 'dm') continue; // DMs use members[]
    batch.set(doc.ref, { subscriberUids: byChannel[doc.id] || [] }, { merge: true });
    channels++;
    if (++ops >= 400) { await batch.commit(); batch = db.batch(); ops = 0; }
  }
  if (ops > 0) await batch.commit();

  res.status(200).json({ channels, users: metaSnap.size });
});

/* ── V3.582: Slack-history import ──
   Client parses the pasted Slack log (rm/js/chat-slack-import.js) and
   POSTs { mode:'import', channelId, sourceFilename, messages:[{
   authorUid|null, authorName, text }] }. Messages are written with
   synthetic backdated createdAt values (1s apart, strictly BEFORE the
   channel's oldest existing message) so the block reads as history;
   original Slack timestamps are clock-only (no dates) and are dropped
   by design. Every doc carries imported:true (trigger skip),
   importedFromSlack:true (renders the dormant "from Slack" badge) and
   importBatchId (undo handle). A chatImports/{batchId} metadata doc
   powers the "previously imported" list + undo UI.
   { mode:'undo', batchId } deletes the whole batch (importer/admin). */
const IMPORT_MAX_MESSAGES = 5000;
const IMPORT_MAX_TEXT_LEN = 20000;
const IMPORT_FLOOR_MS = Date.UTC(2000, 0, 1); // empty-channel anchor floor

const chatImportSlackHistory = onRequest({
  cors: true,
  maxInstances: 1,
  memory: '256MiB',
  timeoutSeconds: 300,
}, async (req, res) => {
  if (req.method === 'GET') {
    res.status(200).send('chatImportSlackHistory ok');
    return;
  }
  if (req.method !== 'POST') {
    res.status(405).json({ error: 'Method not allowed' });
    return;
  }

  /* Verify Firebase ID token (same gate as chatBackfillSubscribers). */
  const authHeader = req.get('Authorization') || '';
  const m = authHeader.match(/^Bearer\s+(.+)$/i);
  if (!m) { res.status(401).json({ error: 'Missing Bearer token.' }); return; }
  let decoded;
  try {
    decoded = await admin.auth().verifyIdToken(m[1]);
  } catch (err) {
    res.status(401).json({ error: 'Invalid Firebase token: ' + err.message });
    return;
  }
  const uid = decoded.uid;
  const db = admin.firestore();
  const body = req.body || {};

  try {
    if (body.mode === 'undo') {
      await handleImportUndo(db, uid, body, res);
    } else if (body.mode === 'import') {
      await handleImport(db, uid, body, res);
    } else {
      res.status(400).json({ error: "mode must be 'import' or 'undo'." });
    }
  } catch (err) {
    console.error('[chatImportSlackHistory]', err);
    res.status(500).json({ error: err.message || 'Internal error' });
  }
});

async function handleImport(db, uid, body, res) {
  const channelId = String(body.channelId || '');
  const messages = body.messages;
  if (!channelId) { res.status(400).json({ error: 'channelId required.' }); return; }
  if (!Array.isArray(messages) || messages.length === 0) {
    res.status(400).json({ error: 'messages must be a non-empty array.' });
    return;
  }
  if (messages.length > IMPORT_MAX_MESSAGES) {
    res.status(413).json({ error: `Too many messages (max ${IMPORT_MAX_MESSAGES}).` });
    return;
  }

  const channelDoc = await db.collection('chatChannels').doc(channelId).get();
  if (!channelDoc.exists) { res.status(404).json({ error: 'Channel not found.' }); return; }
  const channel = channelDoc.data() || {};
  const isDM = channel.type === 'dm';

  /* DM: any member may import. Channel: chat/site admin only. */
  if (isDM) {
    if (!(channel.members || []).includes(uid)) {
      res.status(403).json({ error: 'Not a member of this DM.' });
      return;
    }
  } else if (!(await isChatAdminUid(db, uid))) {
    res.status(403).json({ error: 'Chat admin required for channel imports.' });
    return;
  }

  /* Validate message shape. */
  for (const msg of messages) {
    const text = typeof msg.text === 'string' ? msg.text.trim() : '';
    if (!text) { res.status(400).json({ error: 'Every message needs non-empty text.' }); return; }
    if (text.length > IMPORT_MAX_TEXT_LEN) {
      res.status(400).json({ error: `Message text too long (max ${IMPORT_MAX_TEXT_LEN} chars).` });
      return;
    }
    if (!msg.authorName || String(msg.authorName).length > 200) {
      res.status(400).json({ error: 'Every message needs an authorName (≤200 chars).' });
      return;
    }
    if (msg.authorUid != null && typeof msg.authorUid !== 'string') {
      res.status(400).json({ error: 'authorUid must be a string or null.' });
      return;
    }
  }

  /* Resolve mapped authors: must be real users; inside a DM only the
     DM's own members may be attributed (no third-party forging).
     Bonus: stamp authorPhoto server-side from the user doc. */
  const mappedUids = [...new Set(messages.map((x) => x.authorUid).filter(Boolean))];
  const photoByUid = {};
  if (mappedUids.length) {
    const refs = mappedUids.map((u) => db.collection('users').doc(u));
    const docs = await db.getAll(...refs);
    for (const d of docs) {
      if (!d.exists) { res.status(400).json({ error: `Unknown user uid: ${d.id}` }); return; }
      if (isDM && !(channel.members || []).includes(d.id)) {
        res.status(403).json({ error: 'DM imports may only attribute messages to DM members.' });
        return;
      }
      photoByUid[d.id] = ((d.data() || {}).photo || {}).thumb || null;
    }
  }

  /* Synthetic timestamps: strictly before the oldest existing message,
     1s apart, source order preserved. Divider is the NEWEST of the
     batch (anchor − 1s) so scrolling up hits it before the block. */
  const oldest = await db.collection('chatMessages')
    .where('channelId', '==', channelId)
    .orderBy('createdAt', 'asc').limit(1).get();
  const N = messages.length;
  const anchorMs = oldest.empty
    ? IMPORT_FLOOR_MS + (N + 2) * 1000
    : oldest.docs[0].data().createdAt.toMillis();

  const importerDoc = await db.collection('users').doc(uid).get();
  const importerData = importerDoc.exists ? (importerDoc.data() || {}) : {};
  const importedByName = importerData.name || importerData.displayName || importerData.email || uid;

  const participants = [];
  const seenNames = new Set();
  for (const msg of messages) {
    if (seenNames.has(msg.authorName)) continue;
    seenNames.add(msg.authorName);
    participants.push({ slackName: msg.authorName, uid: msg.authorUid || null });
  }

  const batchRef = db.collection('chatImports').doc();
  const batchId = batchRef.id;
  const importDate = new Date().toISOString().slice(0, 10);

  await batchRef.set({
    channelId,
    channelType: channel.type || 'channel',
    importedBy: uid,
    importedByName,
    importedAt: FieldValue.serverTimestamp(),
    count: N,
    sourceFilename: String(body.sourceFilename || '(pasted)').slice(0, 300),
    participants,
    status: 'writing',
  });

  /* Chunked writes, 400 ops/commit. Full msgData field set so nothing
     downstream sees undefined. fanout deliberately OMITTED. */
  let batch = db.batch();
  let ops = 0;
  const commitIfFull = async () => {
    if (ops >= 400) { await batch.commit(); batch = db.batch(); ops = 0; }
  };
  for (let i = 0; i < N; i++) {
    const msg = messages[i];
    batch.set(db.collection('chatMessages').doc(), {
      channelId,
      authorUid: msg.authorUid || null,
      authorName: String(msg.authorName),
      authorPhoto: msg.authorUid ? (photoByUid[msg.authorUid] || null) : null,
      text: String(msg.text).trim(),
      type: 'text',
      file: null,
      mentions: [],
      mentionsChannel: false,
      threadParentId: null,
      threadReplyCount: 0,
      threadLastReplyAt: null,
      reactions: {},
      editedAt: null,
      deleted: false,
      pinned: false,
      imported: true,
      importedFromSlack: true,
      importBatchId: batchId,
      importedBy: uid,
      importedAt: FieldValue.serverTimestamp(),
      importIndex: i,
      createdAt: Timestamp.fromMillis(anchorMs - (N + 1 - i) * 1000),
    });
    ops++;
    await commitIfFull();
  }

  /* Boundary divider — newest doc of the batch. */
  batch.set(db.collection('chatMessages').doc(), {
    channelId,
    authorUid: null,
    authorName: 'system',
    authorPhoto: null,
    text: `History imported from Slack on ${importDate}`,
    type: 'system',
    file: null,
    mentions: [],
    mentionsChannel: false,
    threadParentId: null,
    threadReplyCount: 0,
    threadLastReplyAt: null,
    reactions: {},
    editedAt: null,
    deleted: false,
    pinned: false,
    imported: true,
    importedFromSlack: true,
    importBatchId: batchId,
    importedBy: uid,
    importedAt: FieldValue.serverTimestamp(),
    importIndex: N,
    createdAt: Timestamp.fromMillis(anchorMs - 1000),
  });
  ops++;
  await batch.commit();

  await batchRef.set({ status: 'complete' }, { merge: true });

  /* NOTE: chatChannels.lastMessage/lastActivityAt/messageCount are
     deliberately untouched — sidebar previews, unread badges, and the
     corner alert must not fire for imported history. */
  res.status(200).json({ batchId, count: N });
}

async function handleImportUndo(db, uid, body, res) {
  const batchId = String(body.batchId || '');
  if (!batchId) { res.status(400).json({ error: 'batchId required.' }); return; }
  const metaRef = db.collection('chatImports').doc(batchId);
  const metaDoc = await metaRef.get();
  if (!metaDoc.exists) { res.status(404).json({ error: 'Import batch not found.' }); return; }
  const meta = metaDoc.data() || {};

  if (meta.importedBy !== uid && !(await isChatAdminUid(db, uid))) {
    res.status(403).json({ error: 'Only the importer or an admin can remove this import.' });
    return;
  }

  /* Delete the batch in pages; collect parents that grew thread
     replies after import so we can orphan-clean those too. */
  let deleted = 0;
  const threadParents = [];
  for (;;) {
    const snap = await db.collection('chatMessages')
      .where('importBatchId', '==', batchId).limit(400).get();
    if (snap.empty) break;
    const batch = db.batch();
    snap.docs.forEach((d) => {
      if (((d.data() || {}).threadReplyCount || 0) > 0) threadParents.push(d.id);
      batch.delete(d.ref);
    });
    await batch.commit();
    deleted += snap.size;
  }

  let repliesDeleted = 0;
  for (let i = 0; i < threadParents.length; i += 30) {
    const chunk = threadParents.slice(i, i + 30);
    const snap = await db.collection('chatMessages')
      .where('threadParentId', 'in', chunk).get();
    for (let j = 0; j < snap.docs.length; j += 400) {
      const batch = db.batch();
      snap.docs.slice(j, j + 400).forEach((d) => batch.delete(d.ref));
      await batch.commit();
    }
    repliesDeleted += snap.size;
  }

  await metaRef.delete();
  res.status(200).json({ deleted, repliesDeleted });
}

module.exports = { onChatMessageCreate, chatBackfillSubscribers, chatImportSlackHistory };
