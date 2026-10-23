/* dashboard.js — renders summary cards and upcoming deadlines on index.html.
 * Wrapped in a re-entrant async function so live-sync can re-run it when
 * any of the rolled-up paths change in another tab. */

async function _runDashboard() {
  const [roster, alumni, proposals, awards, papers, courses, tools, infra,
         conferences, committees, reviews, outreach,
         daily, weekly, monthly, annual,
         deadlines, irb, iacuc, tenure, travel, receipts,
         importantPeople, importantDonors,
         inventory, chemicals] = await Promise.all([
    api.load('people/roster.json'),
    api.load('people/alumni.json'),
    api.load('funding/proposals.json'),
    api.load('funding/awards.json'),
    api.load('projects/papers.json'),
    api.load('projects/courses.json'),
    api.load('projects/tools.json'),
    api.load('projects/infrastructure.json'),
    api.load('service/conferences.json'),
    api.load('service/committees.json'),
    api.load('service/reviews.json'),
    api.load('service/outreach.json'),
    api.load('tasks/daily.json'),
    api.load('tasks/weekly.json'),
    api.load('tasks/monthly.json'),
    api.load('tasks/annual.json'),
    api.load('calendar/deadlines.json'),
    api.load('compliance/irb.json'),
    api.load('compliance/iacuc.json'),
    api.load('career/tenure_dossier.json'),
    api.load('finance/travel.json'),
    api.load('finance/receipts.json'),
    api.load('important-people/regents.json'),
    api.load('important-people/donors.json'),
    api.load('inventory/items.json'),
    api.load('inventory/chemicals.json'),
  ]);

  // Phase 13: counts come from the pre-aggregated stats docs
  // (userData/{uid}/stats/{kind}-{year}) rather than the full message/event
  // collections — pulling 8500+ emails + 1000+ events just to display two
  // numbers was the single biggest dashboard read cost. Cards still link
  // to the canonical Email and Calendar pages.
  let emailCount = 0, upcomingCount = 0;
  const _yr = String(new Date().getFullYear());
  const [emailStats, calStats, calEvents] = await Promise.all([
    api.load('stats/email-' + _yr + '.json').catch(() => null),
    api.load('stats/calendar-' + _yr + '.json').catch(() => null),
    // Upcoming-count needs per-event start_at filtering, which the stats
    // doc doesn't expose. Fall through to the full events list (now
    // LONG-cached, so subsequent loads are free).
    api.load('calendar_archive/events.json').catch(() => null),
  ]);
  emailCount = (emailStats && emailStats.totalCount) || 0;
  if (calEvents && Array.isArray(calEvents.events)) {
    const todayKey = new Date().toISOString().slice(0, 10);
    upcomingCount = calEvents.events.filter(ev => (ev.start_at || '').slice(0, 10) >= todayKey).length;
  } else if (calStats && calStats.totalCount) {
    // Fallback: if events fetch failed but stats exists, show year total.
    upcomingCount = calStats.totalCount;
  }

  const grid = document.getElementById('cards');
  // Clear prior render — supports re-entry from live-sync.
  grid.innerHTML = '';
  const dlTable = document.getElementById('deadlines-table');
  if (dlTable) dlTable.innerHTML = '';

  // Helper to build a card
  function card(title, count, body, link) {
    const div = document.createElement('div');
    div.className = 'card';
    div.innerHTML = `
      <div class="card-title">${title}</div>
      <div class="card-count">${count}</div>
      <div class="card-body">${body}</div>
      <a class="card-link" href="${link}">View details &rarr;</a>
    `;
    return div;
  }

  // 1. People — read from Firestore users/{uid} (the website's canonical
  // user collection). RM lab-management fields (effort, funding, etc.) live
  // inline on the same doc; legacy people/roster.json is no longer
  // authoritative. Falls back to roster.json if Firebase isn't ready (e.g.
  // signed out) so the dashboard still renders.
  const CAT_LABEL = { pi: 'PI', postdoc: 'Postdoc', grad: 'Grad', undergrad: 'Undergrad', highschool: 'HS', alumni: 'Alumni' };
  let activeMembers = [];
  if (typeof firebridge !== 'undefined' && firebridge.getAll && firebridge.isReady && firebridge.isReady()) {
    try {
      const d = await api.load('lab/users.json');
      const users = (d && d.users) || [];
      const todayStr = new Date().toISOString().slice(0, 10);
      activeMembers = users.filter(u =>
        LAB_USERS.isVisible(u) &&
        u.category !== 'alumni' &&
        (!u.end || u.end === '' || u.end === 'TBD' || u.end > todayStr)
      );
    } catch (err) {
      console.warn('[dashboard] users read failed; falling back to roster.json:', err.message);
    }
  }
  if (!activeMembers.length) {
    activeMembers = (roster.members || []).filter(m => !m.end || m.end === '');
  }
  const roleBreakdown = {};
  activeMembers.forEach(m => {
    const k = (m.category && CAT_LABEL[m.category]) || m.role || 'member';
    roleBreakdown[k] = (roleBreakdown[k] || 0) + 1;
  });
  const roleStr = Object.entries(roleBreakdown).map(([r, c]) => `${c} ${r}`).join(', ') || 'No members yet';
  grid.appendChild(card('People', activeMembers.length, roleStr, '/rm/pages/people.html'));

  // Phase 9: link to the canonical Email Review + Calendar pages.
  const emailBody = emailCount
    ? `${emailCount} synced`
    : 'Connect Gmail in Settings';
  grid.appendChild(card('Email', emailCount, emailBody, '/rm/pages/activity-overview.html?tab=email'));

  const upcomingBody = upcomingCount
    ? `${upcomingCount} ahead`
    : 'Connect Calendar in Settings';
  grid.appendChild(card('Calendar', upcomingCount, upcomingBody, '/rm/pages/calendar.html'));

  // 1b. Grant Drafts (V3.185) — in-progress proposals authored in the
  // V3.179 grant writer. Distinct from the `funding/{id}` Proposals card
  // below: this surfaces drafts still being written, while Proposals
  // surfaces the institutional accounting record post-submission.
  // Wrapped in try/catch — `grantDrafts` rules require lab-member; a
  // guest signin would 403 here and shouldn't break the dashboard.
  let grantDrafts = [];
  try {
    if (typeof firebridge !== 'undefined' && firebridge.db && firebridge.isLabMember && firebridge.isLabMember()) {
      const snap = await firebridge.db().collection('grantDrafts').get();
      grantDrafts = snap.docs.map(d => Object.assign({ id: d.id }, d.data()));
      const openDrafts = grantDrafts.filter(g => g.status === 'draft' || g.status === 'internal-review');
      const nextDraftDeadline = openDrafts
        .map(g => g.deadlineISO)
        .filter(d => d && d !== 'TBD')
        .sort()[0];
      grid.appendChild(card('Grant Drafts', openDrafts.length,
        nextDraftDeadline ? `Next deadline: ${formatDate(nextDraftDeadline)}` : 'No deadlines set',
        '/rm/pages/grant-builder.html'));
    }
  } catch (err) {
    console.warn('[dashboard] grant drafts card skipped:', err.message);
  }

  // 2. Proposals
  const openProposals = proposals.proposals.filter(p => p.status !== 'awarded' && p.status !== 'rejected');
  const nextDeadline = openProposals
    .map(p => p.submit_deadline)
    .filter(d => d && d !== 'TBD')
    .sort()[0];
  grid.appendChild(card('Proposals', openProposals.length,
    nextDeadline ? `Next deadline: ${formatDate(nextDeadline)}` : 'No deadlines set',
    '/rm/pages/grants.html'));

  // 3. Awards
  const activeAwards = awards.awards.filter(a => a.status === 'active');
  grid.appendChild(card('Awards', activeAwards.length,
    activeAwards.length ? activeAwards.map(a => a.title).slice(0, 2).join(', ') : 'No awards yet',
    '/rm/pages/grants.html'));

  // 4. Papers — links to the collaborative paper builder.
  const statusCount = {};
  papers.papers.forEach(p => { statusCount[p.status] = (statusCount[p.status] || 0) + 1; });
  const paperStr = Object.entries(statusCount).map(([s, c]) => `${c} ${s}`).join(', ') || 'No papers yet';
  grid.appendChild(card('Papers', papers.papers.length, paperStr, '/rm/pages/paper-builder.html'));

  // 4b. Library — paper items in items.json with library entry
  try {
    const itemsData = await api.load('items.json');
    const libraryPapers = (itemsData.items || []).filter(it =>
      it.type === 'paper' && it.meta && it.meta.library && it.meta.library.is_library_entry
    );
    const withPdf = libraryPapers.filter(it => it.meta.library.pdf).length;
    const body = libraryPapers.length
      ? `${withPdf} with PDF · ${libraryPapers.length - withPdf} stub`
      : 'Drop a PDF to get started';
    grid.appendChild(card('Library', libraryPapers.length, body, '/rm/pages/library.html'));
  } catch (err) {
    // items.json may not exist on first run — silently skip the card.
    console.warn('[dashboard] library card skipped:', err.message);
  }

  // 4c. Protocols (V3.113) — wrapped in try/catch because rules may not
  // be deployed when this card first appears.
  try {
    const protoData = await api.load('protocols/list.json');
    const protos = (protoData && protoData.protocols) || [];
    const byStatus = {};
    protos.forEach(p => { byStatus[p.status] = (byStatus[p.status] || 0) + 1; });
    const body = protos.length
      ? Object.entries(byStatus).map(([s, c]) => `${c} ${s}`).join(' · ')
      : 'No protocols yet';
    grid.appendChild(card('Protocols', protos.length, body, '/rm/pages/protocols.html'));
  } catch (err) {
    console.warn('[dashboard] protocols card skipped:', err.message);
  }

  // 4d. Scheduler (V3.342) — pending guest responses on schedulers you
  // own + slots assigned to you. Direct reads (schedules/participants
  // are public-read); wrapped in try/catch like the other optional cards.
  try {
    if (typeof firebridge !== 'undefined' && firebridge.db && firebridge.getUser && firebridge.getUser()) {
      const _uid = firebridge.getUser().uid;
      const db = firebridge.db();
      const [ownedSnap, mineSnap] = await Promise.all([
        db.collection('schedules').where('ownerUid', '==', _uid).get(),
        db.collection('participants').where('speakerUid', '==', _uid).get(),
      ]);
      const owned = ownedSnap.docs.map(d => Object.assign({ id: d.id }, d.data()));
      let pending = 0, guests = 0;
      await Promise.all(owned.map(async (s) => {
        const ps = await db.collection('participants').where('scheduleId', '==', s.id).get();
        guests += ps.size;
        ps.forEach(p => { if (!((p.data().availability || []).length)) pending++; });
      }));
      const myAssigned = mineSnap.docs.filter(d => d.data().assignedSlot).length;
      const bits = [];
      if (owned.length) bits.push(pending ? `${pending} of ${guests} guest${guests === 1 ? '' : 's'} not responded` : 'All guests responded');
      if (myAssigned) bits.push(`${myAssigned} slot${myAssigned === 1 ? '' : 's'} assigned to you`);
      grid.appendChild(card('Scheduler', owned.length,
        bits.join(' · ') || 'Create a scheduling link or paint your availability',
        '/rm/pages/scheduler.html'));
    }
  } catch (err) {
    console.warn('[dashboard] scheduler card skipped:', err.message);
  }

  // 5. Courses
  grid.appendChild(card('Courses', courses.courses.length,
    courses.courses.slice(0, 2).map(c => c.title).join(', ') || 'No courses yet',
    '/rm/pages/projects.html'));

  // 6. Deadlines (next 30 days)
  const upcoming = deadlines.deadlines
    .filter(d => { const du = daysUntil(d.date); return du !== null && du >= 0 && du <= 30; })
    .sort((a, b) => a.date.localeCompare(b.date));
  grid.appendChild(card('Deadlines (30d)', upcoming.length,
    upcoming.length ? upcoming.slice(0, 2).map(d => d.title).join(', ') : 'None in the next 30 days',
    '/rm/pages/calendar.html'));

  // 7. This Week's Tasks
  const weeklyTasks = weekly.tasks || [];
  const weekDone = weeklyTasks.filter(t => t.completed).length;
  grid.appendChild(card('Weekly Tasks', `${weekDone}/${weeklyTasks.length}`,
    weeklyTasks.filter(t => !t.completed).slice(0, 2).map(t => t.title).join(', ') || 'All done',
    '/rm/pages/tasks.html'));

  // 8. Receipts
  const allReceipts = receipts.receipts || [];
  const needsAttention = allReceipts.filter(r => r.status.startsWith('needs'));
  const receiptTotal = allReceipts.reduce((s, r) => s + (r.amount || 0), 0);
  grid.appendChild(card('Receipts', allReceipts.length,
    needsAttention.length ? `${needsAttention.length} need attention` : `$${receiptTotal.toFixed(0)} tracked`,
    '/rm/pages/receipts.html'));

  // 10. Important People (across all categories)
  const allIP = [...(importantPeople.contacts || []), ...(importantDonors.contacts || [])];
  const highRelevance = allIP.filter(c => c.cancer_engineering_relevance === 'high');
  const nextEvent = allIP.find(c => c.event_date && daysUntil(c.event_date) !== null && daysUntil(c.event_date) >= 0);
  const ipBody = nextEvent
    ? `Next: ${nextEvent.event} (${formatDate(nextEvent.event_date)})`
    : (highRelevance.length ? `${highRelevance.length} high-relevance contacts` : `${(importantPeople.contacts || []).length} regents, ${(importantDonors.contacts || []).length} donors`);
  grid.appendChild(card('Important People', allIP.length, ipBody, '/rm/pages/important-people.html'));

  // 11. Service
  const serviceCount = (conferences.conferences || []).length
    + (committees.committees || []).length
    + (reviews.reviews || []).length
    + (outreach.outreach || []).length;
  const activeConfs = (conferences.conferences || []).filter(c => c.status === 'active');
  grid.appendChild(card('Service', serviceCount,
    activeConfs.length ? activeConfs.map(c => `${c.role}: ${c.name}`).slice(0, 2).join(', ') : 'No active commitments',
    '/rm/pages/service.html'));

  // 9. Compliance
  const allProtocols = [...(irb.protocols || []), ...(iacuc.protocols || [])];
  const activeProtocols = allProtocols.filter(p => p.status === 'active');
  const expiringProtos = allProtocols.filter(p => {
    const d = daysUntil(p.expiration_date);
    return d !== null && d >= 0 && d <= 60;
  });
  grid.appendChild(card('Compliance', activeProtocols.length,
    expiringProtos.length ? `${expiringProtos.length} expiring within 60 days` : 'No upcoming renewals',
    '/rm/pages/compliance.html'));

  // 10. Career
  const nextMilestone = (tenure.milestones || []).find(m => m.status === 'upcoming');
  grid.appendChild(card('Career', (tenure.milestones || []).length + ' milestones',
    nextMilestone ? `Next: ${nextMilestone.title}` : 'No milestones set',
    '/rm/pages/career.html'));

  // 12. Inventory
  try {
    var invItems = inventory.items || [];
    var invTotal = invItems.reduce(function (s, i) { return s + (i.extended_price || i.unit_price || 0); }, 0);
    var lowStock = invItems.filter(function (i) { return i.stock_status === 'low' || i.stock_status === 'out_of_stock'; });
    var invBody = lowStock.length
      ? '<span style="color:var(--amber)">' + lowStock.length + ' low/out of stock</span>'
      : '$' + invTotal.toLocaleString(undefined, { maximumFractionDigits: 0 }) + ' total value';
    grid.appendChild(card('Inventory', invItems.length, invBody, '/rm/pages/inventory.html'));
  } catch (e) { /* inventory data not yet populated */ }

  // 12b. Procurement (V3.813) — what is waiting on someone right now.
  try {
    var procData = await api.load('procurement/tickets.json');
    var procTix = (procData && procData.tickets) || [];
    var pc = { requested: 0, needs_info: 0, approved: 0, ordered: 0, received: 0 };
    procTix.forEach(function (t) { var st = t.status || 'requested'; if (pc[st] != null) pc[st]++; });
    var procOpen = pc.requested + pc.needs_info + pc.approved + pc.ordered + pc.received;
    var procBits = [];
    if (pc.requested) procBits.push('<span style="color:var(--amber)">' + pc.requested + ' awaiting approval</span>');
    if (pc.needs_info) procBits.push(pc.needs_info + ' waiting on a question');
    if (pc.approved) procBits.push(pc.approved + ' to order');
    if (pc.ordered) procBits.push(pc.ordered + ' on order');
    if (pc.received) procBits.push('<span style="color:var(--green)">' + pc.received + ' to put away</span>');
    grid.appendChild(card('Procurement', procOpen, procBits.length ? procBits.join(' · ') : 'No open requests', '/rm/pages/procurement.html'));
  } catch (e) { /* procurement not readable (guest) — skip the card */ }

  // 13. Chemical Safety
  try {
    var chems = chemicals.chemicals || [];
    var missingMsds = chems.filter(function (c) { return c.safety && !c.safety.msds.url && !c.safety.msds.local_path; });
    var expiring = chems.filter(function (c) {
      if (!c.safety || !c.safety.expiration_date || c.safety.expiration_date === 'TBD') return false;
      var d = daysUntil(c.safety.expiration_date);
      return d !== null && d >= 0 && d <= 90;
    });
    var chemBody = [];
    if (missingMsds.length) chemBody.push('<span style="color:var(--red)">' + missingMsds.length + ' missing MSDS</span>');
    if (expiring.length) chemBody.push('<span style="color:var(--amber)">' + expiring.length + ' expiring</span>');
    if (!chemBody.length) chemBody.push('All current');
    grid.appendChild(card('Chemical Safety', chems.length, chemBody.join(' &middot; '), '/rm/pages/chemicals.html'));
  } catch (e) { /* chemicals data not yet populated */ }

  // 14. Year in Review (optional)
  try {
    const idx = await api.load('year_review/index.json');
    const year = (idx.years || []).slice().sort().reverse()[0];
    const doc = year ? await api.load(`year_review/${year}.json`) : null;
    if (doc) {
      const hrs = (doc.groups || []).reduce((s, g) => s + g.hours, 0);
      const ev = (doc.groups || []).reduce((s, g) => s + g.event_count, 0);
      const em = (doc.groups || []).reduce((s, g) => s + g.email_count, 0);
      const body = `${year}: ${ev} events, ${em} emails, ${hrs.toFixed(0)}h across ${doc.groups.length} groups`;
      grid.appendChild(card('Year in Review', hrs.toFixed(0) + 'h', body, '/rm/pages/activity-overview.html?tab=timeline'));
    }
  } catch (e) { /* year review not built yet */ }

  // 15. Email Archive (optional — only if the archive has been built)
  try {
    const emailSummary = await api.load('email_archive/summary.json');
    const s = emailSummary.summary;
    const latestYear = (s.years || []).slice().sort().reverse()[0];
    const latestInfo = latestYear ? s.by_year[latestYear] : null;
    const body = latestInfo
      ? `${latestYear}: ${latestInfo.total} emails · ` +
        Object.entries(latestInfo.by_category || {})
          .sort((a, b) => b[1] - a[1]).slice(0, 3)
          .map(([c, n]) => `${n} ${c}`).join(', ')
      : 'No classification yet';
    grid.appendChild(card('Email Archive', s.total.toLocaleString(), body, '/rm/pages/activity-overview.html?tab=email'));
  } catch (e) { /* email archive not yet built */ }

  // ---- Website integration cards (Firestore) ----
  // These only render when Firebase is connected.

  async function addFirestoreCards() {
    if (typeof firebridge === 'undefined' || !firebridge.isReady()) return;
    var db = firebridge.db();

    try {
      // V3.327 — My Activity: logged HOURS this week (from manual-entry
      // durations, consistent with the tracker + PMR) plus the presence
      // streak. One read of the signed-in user's last ~60 days.
      var me = firebridge.getUser && firebridge.getUser();
      if (me && me.uid) {
        var back60 = new Date();
        back60.setDate(back60.getDate() - 60);
        var snap60 = await db.collection('trackerEntries').doc(me.uid)
          .collection('entries')
          .where('date', '>=', back60.toISOString().slice(0, 10))
          .get();
        var dayHas = {};
        var weekMins = 0;
        var weekAgoStr = (function () {
          var d = new Date(); d.setDate(d.getDate() - 6);
          return d.toISOString().slice(0, 10);
        })();
        snap60.docs.forEach(function (d) {
          var e = d.data();
          if (e.status === 'dismissed') return;
          if (e.kind === 'schedule' || (!e.kind && e.scheduled_for && e.status === 'pending')) return;
          if (e.date) dayHas[e.date] = true;
          var mins = (e.duration != null && isFinite(e.duration) && e.status !== 'pending') ? Number(e.duration) : 0;
          if (e.date && e.date >= weekAgoStr && mins > 0) weekMins += mins;
        });
        var streak = 0;
        var cursor = new Date();
        function ds(d) { return d.toISOString().slice(0, 10); }
        if (!dayHas[ds(cursor)]) cursor.setDate(cursor.getDate() - 1); // empty today doesn't break it
        while (dayHas[ds(cursor)]) { streak++; cursor.setDate(cursor.getDate() - 1); }
        grid.appendChild(card('My Activity (7d)',
          (weekMins / 60).toFixed(1) + 'h',
          streak + (streak === 1 ? ' day' : ' days') + ' streak',
          '/rm/pages/activity-overview.html?tab=tracker'));
      }
    } catch (e) {
      console.warn('[dashboard] Activity tracker read failed:', e.message);
    }

    try {
      // Meetings — next upcoming or recent
      // Forward-looking: the 6 nearest meetings from today (the old
      // desc/limit-5 read the LAST five of the semester, so "next" was
      // December in September). Single-field range → no composite index.
      var meetingsSnap = await db.collection('meetings')
        .where('date', '>=', today()).orderBy('date').limit(6).get();
      var meetings = meetingsSnap.docs.map(function (d) { return d.data(); });
      // V3.743 — read the real schema: status/kind, presenters as a uid-keyed
      // map (legacy array tolerated), actionItems[].status === 'done'.
      var upcoming = meetings.filter(function (m) {
        return m.date && m.date >= today() && m.status !== 'cancelled' && m.kind !== 'break';
      }).sort(function (a, b) { return a.date.localeCompare(b.date); });
      var actionItems = 0;
      meetings.forEach(function (m) {
        if (m.actionItems) actionItems += m.actionItems.filter(function (a) { return a.status !== 'done'; }).length;
      });
      function presenterNames(m) {
        if (m.kind === 'flash') return 'flash talks';
        var p = m.presenters;
        var names = Array.isArray(p) ? p.map(function (x) { return x.name; })
          : (p && typeof p === 'object') ? Object.keys(p).map(function (uid) { return p[uid].name; }) : [];
        names = names.filter(Boolean).map(function (n) { return n.split(/\s+/)[0]; });
        return names.length ? names.join(' & ') : 'presenter TBD';
      }
      var meetBody = upcoming.length
        ? 'Next: ' + upcoming[0].date.slice(5).replace('-', '/') + ' · ' + presenterNames(upcoming[0])
        : (actionItems ? actionItems + ' open action items' : 'No upcoming meetings');
      grid.appendChild(card('Lab Meetings', upcoming.length,
        meetBody, '/rm/pages/meetings.html'));
    } catch (e) {
      console.warn('[dashboard] Meetings read failed:', e.message);
    }

    try {
      // Huddle — this week's plans + open help.
      // weekId math mirrors rm/js/huddle.js getMonday/getWeekId exactly
      // (including the Sunday→next-Monday quirk) so counts always agree.
      var hudMon = new Date();
      hudMon.setDate(hudMon.getDate() - hudMon.getDay() + 1);
      var hudTmp = new Date(hudMon.getTime());
      hudTmp.setDate(hudTmp.getDate() + 3 - ((hudTmp.getDay() + 6) % 7));
      var hudJan4 = new Date(hudTmp.getFullYear(), 0, 4);
      var hudWeekNum = 1 + Math.round(((hudTmp - hudJan4) / 86400000 - 3 + ((hudJan4.getDay() + 6) % 7)) / 7);
      var hudWeekId = hudTmp.getFullYear() + '-W' + String(hudWeekNum).padStart(2, '0');

      var huddleSnap = await db.collection('huddlePlans')
        .where('weekId', '==', hudWeekId).get();
      var plans = huddleSnap.docs.map(function (d) { return d.data(); });
      var activePlans = plans.filter(function (p) {
        return p.status === 'planned' || p.status === 'delayed';
      });
      var hudEsc = function (s) {
        return String(s).replace(/[&<>"']/g, function (c) {
          return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c];
        });
      };
      var planStr = activePlans.slice(0, 2).map(function (p) {
        return hudEsc((p.ownerName || 'Member') + ': ' + (p.text || 'Plan'));
      }).join(', ') || 'No plans yet this week';

      var openHelpCount = 0;
      try {
        var helpSnap = await db.collection('huddleHelpRequests')
          .where('status', '==', 'open').get();
        openHelpCount = helpSnap.size;
      } catch (helpErr) {
        console.warn('[dashboard] Huddle help read failed:', helpErr.message);
      }
      if (openHelpCount) planStr += ' · ' + openHelpCount + ' open help request' + (openHelpCount !== 1 ? 's' : '');

      grid.appendChild(card('The Huddle', activePlans.length + ' plans',
        planStr, '/rm/pages/huddle.html'));
    } catch (e) {
      console.warn('[dashboard] Huddle read failed:', e.message);
    }

    try {
      // Equipment — today's bookings
      var todayStr = today();
      var equipSnap = await db.collection('equipmentBookings')
        .where('date', '==', todayStr).get();
      var bookings = equipSnap.docs.map(function (d) { return d.data(); });
      var equipStr = bookings.slice(0, 3).map(function (b) {
        return (b.equipmentName || b.equipment || 'Equipment') + ' — ' + (b.userName || 'User');
      }).join(', ') || 'No bookings today';
      grid.appendChild(card('Equipment (Today)', bookings.length,
        equipStr, '#'));
    } catch (e) {
      console.warn('[dashboard] Equipment read failed:', e.message);
    }

    try {
      // CV Overview — stale CVs (uses cached lab roster from Phase B)
      var _ud3 = await api.load('lab/users.json');
      var userIds = ((_ud3 && _ud3.users) || []).filter(function (u) {
        return LAB_USERS.isVisible(u);
      }).map(function (u) { return u.id; });
      var staleCount = 0;
      var noCV = 0;
      var totalPubs = 0;
      var cvChecks = userIds.map(function (uid) {
        return db.collection('cvData').doc(uid).get().then(function (doc) {
          if (!doc.exists) { noCV++; return; }
          var cv = doc.data();
          totalPubs += (cv.journals || []).length + (cv.conferences || []).length;
          if (cv.updatedAt) {
            var d = cv.updatedAt.toDate ? cv.updatedAt.toDate() : new Date(cv.updatedAt);
            if ((Date.now() - d.getTime()) / 86400000 > 60) staleCount++;
          }
        }).catch(function () { noCV++; });
      });
      await Promise.all(cvChecks);
      var cvBody = totalPubs + ' total publications';
      if (staleCount) cvBody += ', <span style="color:var(--amber)">' + staleCount + ' stale</span>';
      if (noCV) cvBody += ', ' + noCV + ' no CV';
      grid.appendChild(card('CV Status', userIds.length + ' members',
        cvBody, '/rm/pages/cv-editor.html?tab=lab'));
    } catch (e) {
      console.warn('[dashboard] CV read failed:', e.message);
    }
  }

  // Fire Firestore cards after a short delay to allow Firebase auth to resolve
  if (typeof firebridge !== 'undefined') {
    firebridge.onAuth(function () {
      addFirestoreCards();
    });
  }

  // Deadlines table — show all future deadlines sorted
  var _dlSortKey = 'date';
  var _dlSortDir = 'asc';
  var DL_COLUMNS = [
    { label: 'Date', key: 'date', type: 'date' },
    { label: 'Title', key: 'title' },
    { label: 'Category', key: 'category' },
    { label: 'Urgency', key: null },
  ];

  const allDeadlines = deadlines.deadlines
    .filter(d => { const du = daysUntil(d.date); return du === null || du >= -7; });

  // V3.185 — inject grant draft deadlines so they surface alongside
  // calendar deadlines in the table. Only drafts in active states; once
  // submitted the deadlineISO is historical and shouldn't clutter the
  // upcoming view.
  grantDrafts.forEach(function (g) {
    if (!g.deadlineISO || g.deadlineISO === 'TBD') return;
    if (g.status !== 'draft' && g.status !== 'internal-review') return;
    var du = daysUntil(g.deadlineISO);
    if (du === null || du < -7) return;
    allDeadlines.push({
      date: g.deadlineISO,
      title: (g.title || '(untitled grant)') + (g.mechanism ? (' — ' + g.mechanism) : ''),
      category: 'grant',
    });
  });

  function renderDeadlines() {
    var sorted = sortItems(allDeadlines, _dlSortKey, _dlSortDir, DL_COLUMNS);
    if (!_dlSortKey) {
      sorted.sort((a, b) => {
        if (a.date === 'TBD') return 1;
        if (b.date === 'TBD') return -1;
        return a.date.localeCompare(b.date);
      });
    }
    var table = document.getElementById('deadlines-table');
    var html = sortableHeader(DL_COLUMNS, _dlSortKey, _dlSortDir, 'onDeadlineSort');
    html += '<tbody>';
    if (sorted.length === 0) {
      html += '<tr><td colspan="4" class="empty-state">No deadlines yet</td></tr>';
    } else {
      sorted.forEach(function (d) {
        html += '<tr><td>' + formatDate(d.date) + '</td><td>' + d.title + '</td><td>' + d.category + '</td><td>' + deadlineChip(d.date) + '</td></tr>';
      });
    }
    html += '</tbody>';
    table.innerHTML = html;
  }

  window.onDeadlineSort = function (key) {
    if (_dlSortKey === key) { _dlSortDir = _dlSortDir === 'asc' ? 'desc' : 'asc'; }
    else { _dlSortKey = key; _dlSortDir = 'asc'; }
    renderDeadlines();
  };

  renderDeadlines();
}

(async function () {
  if (typeof firebridge !== 'undefined' && firebridge.requireSignIn) await firebridge.requireSignIn('Sign in to view the lab overview.');
  await _runDashboard();
  // No LIVE_SYNC.attach: the dashboard is a glance-and-go rollup, not an
  // editing surface. Subscribing to 27 paths opened 27 onSnapshot listeners
  // and 27 initial-state Firestore round trips on every page load. Cached
  // api.load (per-route TTLs in api-routes.js) gives the same data without
  // the listener overhead; reloading the page refreshes everything.
})();
