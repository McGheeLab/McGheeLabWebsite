/* ================================================================
   huddle-badge.js — "new since last visit" count on the Huddle
   nav link (V3.511)
   ================================================================
   Loaded on rm/index.html and rm/pages/huddle.html only (each badge
   refresh costs two aggregate count() reads — don't put this on
   every RM page).

   Reads huddleSeen/{uid} (written by rm/js/huddle.js on tab enter /
   page hide) and runs two count() aggregates:
     huddlePlans        weekId == <current> && updatedAt > weekSeenAt
     huddleHelpRequests status == 'open'    && updatedAt > helpSeenAt
   Both need composite indexes (firestore.indexes.json); until those
   finish building the count queries throw and the badge silently
   no-ops. Counts include the user's own edits (excluding them would
   need a third filter Firestore can't index alongside the range) —
   treated as an acceptable overcount.
   ================================================================ */

(() => {
  'use strict';

  const NAV_HREF = '/rm/pages/huddle.html';
  const EPOCH = () => firebase.firestore.Timestamp.fromMillis(0);

  // Same ISO-week math as rm/js/huddle.js getMonday/getWeekId (offset 0),
  // including the Sunday→next-Monday quirk. Keep byte-identical semantics.
  function currentWeekId() {
    const mon = new Date();
    mon.setDate(mon.getDate() - mon.getDay() + 1);
    const tmp = new Date(mon.getTime());
    tmp.setDate(tmp.getDate() + 3 - ((tmp.getDay() + 6) % 7));
    const jan4 = new Date(tmp.getFullYear(), 0, 4);
    const weekNum = 1 + Math.round(((tmp - jan4) / 86400000 - 3 + ((jan4.getDay() + 6) % 7)) / 7);
    return tmp.getFullYear() + '-W' + String(weekNum).padStart(2, '0');
  }

  async function computeCount() {
    const user = firebridge.getUser && firebridge.getUser();
    if (!user) return 0;
    const db = firebridge.db();

    let weekSeen = EPOCH(), helpSeen = EPOCH();
    try {
      const seenDoc = await db.collection('huddleSeen').doc(user.uid).get();
      if (seenDoc.exists) {
        const d = seenDoc.data();
        if (d.weekSeenAt) weekSeen = d.weekSeenAt;
        if (d.helpSeenAt) helpSeen = d.helpSeenAt;
      }
    } catch (e) { /* first visit / rules not deployed yet */ }

    let total = 0;
    try {
      const planSnap = await db.collection('huddlePlans')
        .where('weekId', '==', currentWeekId())
        .where('updatedAt', '>', weekSeen)
        .count().get();
      total += planSnap.data().count;
    } catch (e) { /* index still building — skip */ }
    try {
      const helpSnap = await db.collection('huddleHelpRequests')
        .where('status', '==', 'open')
        .where('updatedAt', '>', helpSeen)
        .count().get();
      total += helpSnap.data().count;
    } catch (e) { /* index still building — skip */ }
    return total;
  }

  function decorate(count) {
    document.querySelectorAll(`a[href="${NAV_HREF}"]`).forEach(link => {
      let badge = link.querySelector('.huddle-nav-badge');
      if (!count) { if (badge) badge.remove(); return; }
      if (!badge) {
        badge = document.createElement('span');
        badge.className = 'huddle-nav-badge';
        link.appendChild(badge);
      }
      badge.textContent = count > 9 ? '9+' : String(count);
    });
  }

  async function refresh() {
    try {
      const count = await computeCount();
      // nav.js renders synchronously but early — retry until links exist.
      let tries = 0;
      const tryDecorate = () => {
        if (document.querySelector(`a[href="${NAV_HREF}"]`)) { decorate(count); return; }
        if (++tries < 10) setTimeout(tryDecorate, 500);
      };
      tryDecorate();
    } catch (e) { /* never break the host page over a badge */ }
  }

  function boot() {
    if (typeof firebridge === 'undefined' || !firebridge.onAuth) return;
    let ran = false;
    firebridge.onAuth(() => {
      if (ran || !firebridge.getUser || !firebridge.getUser()) return;
      ran = true;
      refresh();
    });
  }

  boot();
})();
