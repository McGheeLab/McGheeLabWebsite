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
        u.role && u.role !== 'guest' &&
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
  grid.appendChild(card('Email', emailCount, emailBody, '/rm/pages/email-review.html'));

  const upcomingBody = upcomingCount
    ? `${upcomingCount} ahead`
    : 'Connect Calendar in Settings';
  grid.appendChild(card('Calendar', upcomingCount, upcomingBody, '/rm/pages/calendar.html'));

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
      grid.appendChild(card('Year in Review', hrs.toFixed(0) + 'h', body, '/rm/pages/year-review.html'));
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
    grid.appendChild(card('Email Archive', s.total.toLocaleString(), body, '/rm/pages/email-review.html'));
  } catch (e) { /* email archive not yet built */ }

  // ---- Website integration cards (Firestore) ----
  // These only render when Firebase is connected.

  async function addFirestoreCards() {
    if (typeof firebridge === 'undefined' || !firebridge.isReady()) return;
    var db = firebridge.db();

    try {
      // Activity Tracker — hours logged this week (only users who opted in)
      var weekAgo = new Date();
      weekAgo.setDate(weekAgo.getDate() - 7);
      var cutoffStr = weekAgo.toISOString().slice(0, 10);
      // Phase D: use cached lab roster; filter client-side. The MAX(updatedAt)
      // probe means subsequent reads short-circuit when nothing changed —
      // the earlier uncached db.collection('users').get() ran on every load.
      var _ud2 = await api.load('lab/users.json');
      var sharingIds = ((_ud2 && _ud2.users) || []).filter(function (u) {
        return u.role && u.role !== 'guest' && u.shareActivity === true;
      }).map(function (u) { return u.id; });
      var totalHours = 0;
      var byCategory = {};
      var entryPromises = sharingIds.map(function (uid) {
        return db.collection('trackerEntries').doc(uid).collection('entries')
          .where('date', '>=', cutoffStr)
          .get().then(function (snap) {
            snap.docs.forEach(function (d) {
              var entry = d.data();
              var hrs = entry.duration || entry.hours || 0;
              totalHours += hrs;
              var cat = entry.category || 'Other';
              byCategory[cat] = (byCategory[cat] || 0) + hrs;
            });
          }).catch(function () {});
      });
      await Promise.all(entryPromises);
      var catStr = Object.entries(byCategory).slice(0, 3)
        .map(function (kv) { return kv[0] + ': ' + kv[1].toFixed(1) + 'h'; })
        .join(', ') || 'No entries';
      grid.appendChild(card('Lab Activity (7d)', totalHours.toFixed(1) + 'h',
        catStr, '/rm/pages/activity-summary.html'));
    } catch (e) {
      console.warn('[dashboard] Activity tracker read failed:', e.message);
    }

    try {
      // Meetings — next upcoming or recent
      var meetingsSnap = await db.collection('meetings')
        .orderBy('date', 'desc').limit(5).get();
      var meetings = meetingsSnap.docs.map(function (d) { return d.data(); });
      var upcoming = meetings.filter(function (m) {
        return m.date && m.date >= today();
      });
      var actionItems = 0;
      meetings.forEach(function (m) {
        if (m.actionItems) actionItems += m.actionItems.filter(function (a) { return !a.completed; }).length;
      });
      var meetBody = upcoming.length
        ? 'Next: ' + (upcoming[0].title || upcoming[0].topic || 'Lab Meeting')
        : (actionItems ? actionItems + ' open action items' : 'No upcoming meetings');
      grid.appendChild(card('Lab Meetings', meetings.length,
        meetBody, '#'));
    } catch (e) {
      console.warn('[dashboard] Meetings read failed:', e.message);
    }

    try {
      // Huddle — this week's plans
      var huddleSnap = await db.collection('huddlePlans')
        .orderBy('createdAt', 'desc').limit(10).get();
      var plans = huddleSnap.docs.map(function (d) { return d.data(); });
      var activePlans = plans.filter(function (p) {
        return p.status === 'active' || p.status === 'published';
      });
      var planStr = activePlans.slice(0, 2).map(function (p) {
        return (p.userName || 'Member') + ': ' + (p.title || p.protocol || 'Plan');
      }).join(', ') || 'No active plans';
      grid.appendChild(card('The Huddle', activePlans.length + ' plans',
        planStr, '#'));
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
        return u.role && u.role !== 'guest';
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
        cvBody, '/rm/pages/cv-overview.html'));
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
  if (typeof firebridge !== 'undefined' && firebridge.whenAuthResolved) await firebridge.whenAuthResolved();
  await _runDashboard();
  // No LIVE_SYNC.attach: the dashboard is a glance-and-go rollup, not an
  // editing surface. Subscribing to 27 paths opened 27 onSnapshot listeners
  // and 27 initial-state Firestore round trips on every page load. Cached
  // api.load (per-route TTLs in api-routes.js) gives the same data without
  // the listener overhead; reloading the page refreshes everything.
})();
