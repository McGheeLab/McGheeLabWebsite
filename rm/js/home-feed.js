/* home-feed.js — V3.302 "My Lab Today" strip on the RM home page.
 *
 * A student-centric glance row rendered ABOVE the workflow chooser:
 *   ✅ tasks due within 7 days (personal buckets + tasks assigned to me)
 *   💬 unread chat @mentions
 *   📅 next lab meeting
 *   📰 status of my public-site story/news submissions (pending /
 *      changes-requested — reads the parent site's Firestore collections,
 *      same Firebase project)
 *
 * Each tile loads independently and fails silent: a permission error or
 * empty data hides that tile instead of breaking the strip. If no tile
 * has anything to say, the strip doesn't render at all.
 */

(function () {
  function esc(s) {
    return String(s == null ? '' : s)
      .replace(/&/g, '&amp;').replace(/</g, '&lt;')
      .replace(/>/g, '&gt;').replace(/"/g, '&quot;');
  }
  function todayStr() { return new Date().toISOString().slice(0, 10); }

  /* ── ☀️ My Day (V3.531) ────────────────────────────────────── */
  async function tileMyDay() {
    var u = firebridge.getUser();
    var today = todayStr();
    var weekAgo = new Date(Date.now() - 7 * 86400000).toISOString().slice(0, 10);
    var snap = await firebridge.db().collection('userData').doc(u.uid)
      .collection('dayPlans')
      .where('date', '>=', weekAgo).where('date', '<=', today).get();
    var todayCount = 0, unconfirmed = 0;
    snap.docs.forEach(function (d) {
      if (d.id === '_prefs') return;
      var it = d.data();
      if (it.date === today && it.status === 'planned') todayCount++;
      else if (it.date < today && it.status === 'planned') unconfirmed++;
    });
    if (!todayCount && !unconfirmed) return null;
    var bits = [];
    if (todayCount) bits.push(todayCount + ' planned today');
    if (unconfirmed) bits.push(unconfirmed + ' awaiting confirmation');
    return {
      href: '/rm/pages/my-day.html',
      icon: '☀️',
      label: 'My Day: ' + bits.join(', '),
      detail: unconfirmed ? 'Did yesterday’s plans happen? Tap to confirm' : 'Your plan for today',
      urgent: unconfirmed > 0
    };
  }

  /* ── 🔔 unread notifications (V3.598) ──────────────────────── */
  async function tileNotifications() {
    var u = firebridge.getUser();
    var snap = await firebridge.db().collection('userData').doc(u.uid)
      .collection('notifications')
      .where('readAt', '==', null).limit(20).get();
    if (snap.empty) return null;
    var n = snap.size;
    // Lead with the newest one's title — "3 unread" tells you nothing
    // about whether you need to be off the scope in 10 minutes.
    var newest = null;
    snap.docs.forEach(function (d) {
      var v = d.data();
      var ms = v.createdAt && v.createdAt.toMillis ? v.createdAt.toMillis() : 0;
      if (!newest || ms > newest.ms) newest = { ms: ms, title: v.title || '' };
    });
    // Titles carry other people's display names, so they must be escaped
    // here — boot() injects label/detail into innerHTML raw, leaving each
    // tile responsible for its own content (same as tileTasks/tileMeeting).
    var title = esc(newest.title || '');
    return {
      href: '/rm/pages/my-day.html',
      icon: '🔔',
      label: n === 1 ? (title || '1 new notification') : n + ' new notifications',
      detail: n === 1 ? 'Tap to read' : (title || 'Tap to read'),
      urgent: true
    };
  }

  /* ── ✅ tasks due soon ─────────────────────────────────────── */
  async function tileTasks() {
    var soon = [];
    var today = todayStr();
    var horizon = new Date(Date.now() + 7 * 86400000).toISOString().slice(0, 10);

    function scanSubtask(st) {
      if (!st.done && st.due_date && st.due_date !== 'TBD' && st.due_date <= horizon) {
        soon.push({ text: st.text || '', due: st.due_date, overdue: st.due_date < today });
      }
      (st.children || []).forEach(scanSubtask);
    }

    try {
      var doc = await api.load('tasks/buckets.json');
      (doc.taskBuilders || []).forEach(function (p) {
        (p.buckets || []).forEach(function (b) {
          if (b.archived) return;
          (b.subtasks || []).forEach(scanSubtask);
        });
      });
    } catch (e) { /* tile simply shows less */ }

    try {
      var assigned = await api.load('tasks/assigned.json');
      (assigned.tasks || []).forEach(function (t) {
        if (!t.done && t.due_date && t.due_date !== 'TBD' && t.due_date <= horizon) {
          soon.push({ text: t.text || t.title || '', due: t.due_date, overdue: t.due_date < today });
        }
      });
    } catch (e) { /* ignore */ }

    if (!soon.length) return null;
    soon.sort(function (a, b) { return a.due.localeCompare(b.due); });
    var overdue = soon.filter(function (s) { return s.overdue; }).length;
    return {
      href: '/rm/pages/tasks.html',
      icon: '✅',
      label: soon.length + ' task' + (soon.length === 1 ? '' : 's') + ' due this week'
        + (overdue ? ' — ' + overdue + ' overdue' : ''),
      detail: esc(soon[0].text) + ' · due ' + esc(soon[0].due),
      urgent: overdue > 0
    };
  }

  /* ── 💬 unread chat mentions ───────────────────────────────── */
  async function tileMentions() {
    var u = firebridge.getUser();
    var snap = await firebridge.db().collection('chatReadState')
      .where('uid', '==', u.uid).get();
    var mentions = 0;
    snap.docs.forEach(function (d) { mentions += d.data().mentionCount || 0; });
    if (!mentions) return null;
    return {
      href: '/rm/pages/chat.html',
      icon: '💬',
      label: mentions + ' unread mention' + (mentions === 1 ? '' : 's'),
      detail: 'Someone needs you in chat',
      urgent: false
    };
  }

  /* ── 📅 next lab meeting ───────────────────────────────────── */
  async function tileMeeting() {
    var today = todayStr();
    var snap = await firebridge.db().collection('meetings')
      .where('date', '>=', today).orderBy('date').limit(1).get();
    if (snap.empty) return null;
    var m = snap.docs[0].data();
    return {
      href: '/rm/pages/meetings.html',
      icon: '📅',
      label: m.date === today ? 'Lab meeting today' : 'Next meeting ' + esc(m.date),
      detail: esc(m.title || m.type || 'Lab meeting'),
      urgent: m.date === today
    };
  }

  /* ── 📰 my story/news review status (parent-site collections) ─ */
  async function tileContent() {
    var u = firebridge.getUser();
    var db = firebridge.db();
    // Single-field author query (no composite index needed); status is
    // filtered client-side.
    var snaps = await Promise.all(['stories', 'newsPosts'].map(function (coll) {
      return db.collection(coll).where('authorUid', '==', u.uid).get()
        .catch(function () { return { docs: [] }; });
    }));
    var pending = 0, changes = 0;
    snaps.forEach(function (snap) {
      snap.docs.forEach(function (d) {
        var st = d.data().status;
        if (st === 'pending') pending++;
        else if (st === 'changes-requested') changes++;
      });
    });
    if (!pending && !changes) return null;
    var bits = [];
    if (changes) bits.push(changes + ' need' + (changes === 1 ? 's' : '') + ' changes');
    if (pending) bits.push(pending + ' awaiting review');
    return {
      href: '/#/dashboard',
      icon: '📰',
      label: 'My stories & news: ' + bits.join(', '),
      detail: changes
        ? 'An admin left you a note — open the site dashboard'
        : 'Hang tight — an admin will review soon',
      urgent: changes > 0
    };
  }

  /* ── boot ──────────────────────────────────────────────────── */
  async function boot() {
    if (typeof firebridge === 'undefined') return;
    await firebridge.whenAuthResolved();
    if (!firebridge.getUser()) return;
    if (typeof firebridge.isLabMember === 'function' && !firebridge.isLabMember()) return;

    var root = document.getElementById('rm-home-root');
    if (!root) return;
    var strip = document.getElementById('rm-home-feed');
    if (!strip) {
      strip = document.createElement('div');
      strip.id = 'rm-home-feed';
      root.parentNode.insertBefore(strip, root);
    }

    var tiles = await Promise.all([tileNotifications, tileMyDay, tileTasks, tileMentions, tileMeeting, tileContent]
      .map(function (fn) {
        return fn().catch(function (e) {
          console.warn('[home-feed] tile skipped:', e && e.message);
          return null;
        });
      }));
    tiles = tiles.filter(Boolean);
    if (!tiles.length) { strip.remove(); return; }

    strip.innerHTML = '<div class="home-feed-strip">' + tiles.map(function (t) {
      return '<a class="home-feed-tile' + (t.urgent ? ' home-feed-urgent' : '') + '" href="' + t.href + '">'
        + '<span class="home-feed-icon">' + t.icon + '</span>'
        + '<span class="home-feed-main">'
        + '<span class="home-feed-label">' + t.label + '</span>'
        + '<span class="home-feed-detail">' + t.detail + '</span>'
        + '</span></a>';
    }).join('') + '</div>';
  }

  document.addEventListener('DOMContentLoaded', boot);
})();
