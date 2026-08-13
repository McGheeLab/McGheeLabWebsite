/* ================================================================
   presence.js — "is this user already looking at it?" gate (V3.596)
   ================================================================
   Every push notification carries a target `url` (see the notif objects
   in chat.js / equipment.js / huddle.js / tasks.js / scheduler.js).
   Every RM page publishes what it is showing to `userPresence/{uid}`
   (written by rm/js/presence.js). This module joins the two so
   notify.js can drop a recipient who is already staring at the exact
   surface the notification points at.

   Slack-style and deliberately CROSS-DEVICE: presence is per-surface,
   but one active surface silences the push for ALL of the user's
   devices. That is the only thing that can keep a backgrounded iOS app
   quiet — it cannot suppress locally without a Notification Service
   Extension.

   ── FAIL OPEN ──────────────────────────────────────────────────
   Missing, stale, malformed, or unparseable presence always means
   "send the notification" (today's behaviour). A bug in here must
   never cost someone a notification they needed. Every predicate
   below is written so that the *only* way to reach `true` is a
   positive match on fresh data.
   ================================================================ */

// A surface must have heartbeat within this window to count as "here".
// rm/js/presence.js beats every 60s while visible AND non-idle, so 150s
// tolerates one dropped write without going stale.
const FRESH_MS = 150 * 1000;

// Query params that identify a sub-surface within a page, most specific
// first: chat's ?channel=, huddle's ?item=, generic ?id=.
const CONTEXT_PARAMS = ['channel', 'item', 'id'];

// Any origin works — notif urls are site-absolute paths ('/rm/pages/…').
const URL_BASE = 'https://mcgheelab.com';

// Matches the chunking voice-call.js already uses for batched getAll reads.
const GETALL_CHUNK = 100;

/**
 * Normalize a pathname so both sides of the comparison agree.
 * Directory forms of the RM root resolve to its real page.
 */
function normalizePath(path) {
  if (typeof path !== 'string' || !path) return null;
  let p = path.split('#')[0].split('?')[0].trim();
  if (!p) return null;
  if (p.length > 1 && p.endsWith('/')) p = p.slice(0, -1);
  if (p === '/rm' || p === '') return '/rm/index.html';
  return p;
}

/**
 * Reduce a notification's target url to the surface key we match on.
 *
 * @param {string} url - notif.url, e.g. '/rm/pages/chat.html?channel=abc'
 * @returns {{path: string, contextId: string|null}|null} null if unusable
 */
function surfaceKeyFromUrl(url) {
  if (typeof url !== 'string' || !url) return null;
  let parsed;
  try {
    parsed = new URL(url, URL_BASE);
  } catch (e) {
    return null;
  }
  const path = normalizePath(parsed.pathname);
  if (!path) return null;
  // Hash-routed marketing-SPA fallbacks ('/#/apps') carry no RM surface.
  if (!path.startsWith('/rm/')) return null;

  let contextId = null;
  for (const name of CONTEXT_PARAMS) {
    const v = parsed.searchParams.get(name);
    if (v) { contextId = v; break; }
  }
  return { path, contextId };
}

/** Firestore Timestamp | ISO string | epoch ms → epoch ms, or null. */
function toMillis(value) {
  if (!value) return null;
  if (typeof value.toMillis === 'function') {
    try { return value.toMillis(); } catch (e) { return null; }
  }
  if (typeof value === 'number') return Number.isFinite(value) ? value : null;
  if (typeof value === 'string') {
    const ms = Date.parse(value);
    return Number.isNaN(ms) ? null : ms;
  }
  return null;
}

/**
 * Batch-read presence docs for a set of uids in one round trip.
 *
 * @returns {Promise<Map<string, Object|null>>} uid → presence data (null if absent)
 */
async function loadPresence(db, uids) {
  const out = new Map();
  if (!uids || uids.length === 0) return out;
  const refs = uids.map((uid) => db.collection('userPresence').doc(uid));
  const snaps = [];
  try {
    // Chunked like voice-call.js's chatUserMeta read — a big channel can
    // have more recipients than one getAll should carry.
    for (let i = 0; i < refs.length; i += GETALL_CHUNK) {
      snaps.push(...await db.getAll(...refs.slice(i, i + GETALL_CHUNK)));
    }
  } catch (err) {
    // Fail open: a presence read failure must not block notifications.
    console.warn('[Presence] read failed, sending to everyone:', err && err.message);
    return new Map();
  }
  snaps.forEach((snap, i) => {
    out.set(uids[i], snap.exists ? snap.data() : null);
  });
  return out;
}

/**
 * Is any of this user's surfaces actively showing `key` right now?
 *
 * @param {Object|null} data  - a `userPresence/{uid}` document body
 * @param {{path,contextId}|null} key - from surfaceKeyFromUrl()
 * @param {number} nowMs
 * @returns {boolean} true ONLY on a positive, fresh match
 */
function isViewing(data, key, nowMs) {
  if (!data || !key || !key.path) return false;
  const surfaces = data.surfaces;
  if (!surfaces || typeof surfaces !== 'object') return false;

  for (const sid of Object.keys(surfaces)) {
    const s = surfaces[sid];
    if (!s || typeof s !== 'object') continue;
    if (s.visible !== true) continue;

    const last = toMillis(s.lastActiveAt);
    if (last === null || nowMs - last >= FRESH_MS) continue;
    // Guard a client clock / sentinel landing in the future.
    if (last - nowMs > FRESH_MS) continue;

    const paths = Array.isArray(s.paths) ? s.paths : [];
    if (!paths.some((p) => normalizePath(p) === key.path)) continue;

    // A context-less notification (equipment, tasks, scheduler) matches
    // any surface on that path. A context-ful one (chat channel, huddle
    // item) needs the surface to claim that context, or the '*' wildcard
    // that every page publishes unless it opts into finer grain.
    if (key.contextId !== null) {
      const ctx = Array.isArray(s.contextIds) ? s.contextIds : [];
      if (!ctx.includes('*') && !ctx.includes(key.contextId)) continue;
    }
    return true;
  }
  return false;
}

/**
 * Split uids into those to notify and those already looking at the
 * notification's target surface.
 *
 * @param {Firestore} db
 * @param {string[]} uids   - already filtered by per-app prefs
 * @param {Object} notif    - { url, urgent?, ... }
 * @returns {Promise<{send: string[], suppressed: string[]}>}
 */
async function filterByPresence(db, uids, notif) {
  const all = { send: uids, suppressed: [] };
  // Urgent notifications (a ringing voice call) always go through.
  if (!uids || uids.length === 0 || !notif || notif.urgent === true) return all;

  const key = surfaceKeyFromUrl(notif.url);
  if (!key) return all; // no usable target surface → nothing to suppress

  const presence = await loadPresence(db, uids);
  if (presence.size === 0) return all;

  const now = Date.now();
  const send = [];
  const suppressed = [];
  for (const uid of uids) {
    if (isViewing(presence.get(uid), key, now)) suppressed.push(uid);
    else send.push(uid);
  }
  return { send, suppressed };
}

module.exports = {
  filterByPresence,
  // exported for tests / reuse
  surfaceKeyFromUrl,
  isViewing,
  loadPresence,
  normalizePath,
  FRESH_MS,
};
