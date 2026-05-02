/* activity-summary.js — aggregated view of lab member activity from the website's tracker */

(function () {
  var content = document.getElementById('content');
  var rangeSelect = document.getElementById('range-select');
  var _sortKey = null;
  var _sortDir = 'asc';
  var CAT_COLUMNS = [
    { label: 'Category', key: 'category' },
    { label: 'Hours', key: 'hours', type: 'number' },
    { label: '% of Total', key: 'pct', type: 'number' },
  ];
  var MEMBER_COLUMNS = [
    { label: 'Name', key: 'name' },
    { label: 'Hours', key: 'totalHours', type: 'number' },
    { label: 'Entries', key: 'entries', type: 'number' },
    { label: 'Breakdown', key: null },
  ];

  function showNotConnected() {
    content.innerHTML =
      '<div class="empty-state">' +
        '<p>Not connected to the website.</p>' +
        '<p style="margin-top:8px"><a href="/rm/pages/settings.html">Go to Settings</a> to sign in.</p>' +
      '</div>';
  }

  async function loadAndRender() {
    if (typeof firebridge === 'undefined' || !firebridge.isReady()) {
      showNotConnected();
      return;
    }

    content.innerHTML = '<div class="empty-state">Loading activity data&hellip;</div>';

    var days = parseInt(rangeSelect.value) || 30;
    var cutoff = new Date();
    cutoff.setDate(cutoff.getDate() - days);
    var cutoffStr = cutoff.toISOString().slice(0, 10);

    try {
      var db = firebridge.db();

      // Load users via cached lab roster — only query activity for those who
      // opted in (shareActivity == true).
      var _r = await api.load('lab/users.json');
      var allUsers = ((_r && _r.users) || []).filter(function (u) { return u.role && u.role !== 'guest'; });

      var sharingUsers = allUsers.filter(function (u) { return u.shareActivity === true; });
      var notSharing = allUsers.filter(function (u) { return u.shareActivity !== true; });

      // Build user lookup
      var userMap = {};
      allUsers.forEach(function (u) {
        userMap[u.id] = u.name || u.email || u.id;
      });

      // Load activity entries only for users who opted in
      var byPerson = {};
      var byCategory = {};
      var totalHours = 0;
      var totalEntries = 0;

      var entryPromises = sharingUsers.map(function (u) {
        return db.collection('trackerEntries').doc(u.id).collection('entries')
          .where('date', '>=', cutoffStr)
          .get().then(function (snap) {
            snap.docs.forEach(function (d) {
              var e = d.data();
              var uid = u.id;
              var hrs = e.duration || e.hours || 0;
              var cat = e.category || 'Other';

              totalHours += hrs;
              totalEntries++;

              if (!byPerson[uid]) {
                byPerson[uid] = { name: userMap[uid] || uid, totalHours: 0, byCategory: {}, entries: 0 };
              }
              byPerson[uid].totalHours += hrs;
              byPerson[uid].entries++;
              byPerson[uid].byCategory[cat] = (byPerson[uid].byCategory[cat] || 0) + hrs;

              byCategory[cat] = (byCategory[cat] || 0) + hrs;
            });
          }).catch(function () {});
      });
      await Promise.all(entryPromises);
      var users = allUsers;

      // Render
      var html = '';

      // Summary bar
      html += '<div style="display:flex;gap:24px;margin-bottom:20px;flex-wrap:wrap;">';
      html += '<div class="card" style="flex:1;min-width:200px;"><div class="card-title">Total Hours</div><div class="card-count">' + totalHours.toFixed(1) + '</div><div class="card-body">' + totalEntries + ' entries over ' + days + ' days</div></div>';
      html += '<div class="card" style="flex:1;min-width:200px;"><div class="card-title">Active Members</div><div class="card-count">' + Object.keys(byPerson).length + '</div><div class="card-body">of ' + users.length + ' total</div></div>';
      var topCat = Object.entries(byCategory).sort(function (a, b) { return b[1] - a[1]; });
      html += '<div class="card" style="flex:1;min-width:200px;"><div class="card-title">Top Category</div><div class="card-count">' + (topCat.length ? topCat[0][0] : 'N/A') + '</div><div class="card-body">' + (topCat.length ? topCat[0][1].toFixed(1) + 'h' : '') + '</div></div>';
      html += '</div>';

      // Sharing status notice
      if (notSharing.length) {
        var notSharingNames = notSharing.map(function (u) { return u.name || u.email; }).join(', ');
        html += '<div style="background:var(--bg);border:1px solid var(--border);border-radius:var(--radius);padding:12px;margin-bottom:16px;font-size:13px;color:var(--text-muted);">';
        html += '<strong>' + sharingUsers.length + ' of ' + allUsers.length + ' members</strong> are sharing activity data. ';
        html += 'Not sharing: ' + notSharingNames + '. ';
        html += 'Members can enable sharing from their Activity Tracker settings on the website.';
        html += '</div>';
      }

      // Category breakdown
      if (topCat.length) {
        var catRows = topCat.map(function (kv) {
          return { category: kv[0], hours: kv[1], pct: totalHours > 0 ? (kv[1] / totalHours) * 100 : 0 };
        });
        catRows = sortItems(catRows, _sortKey, _sortDir, CAT_COLUMNS);
        html += '<h2 style="font-size:16px;margin-bottom:12px;">By Category</h2>';
        html += '<table class="data-table" style="margin-bottom:24px;">';
        html += sortableHeader(CAT_COLUMNS, _sortKey, _sortDir, 'onActivitySort') + '<tbody>';
        catRows.forEach(function (row) {
          html += '<tr><td><strong>' + row.category + '</strong></td><td>' + row.hours.toFixed(1) + '</td><td>' + row.pct.toFixed(1) + '%</td></tr>';
        });
        html += '</tbody></table>';
      }

      // Per-person breakdown
      var personList = Object.values(byPerson).sort(function (a, b) { return b.totalHours - a.totalHours; });

      html += '<h2 style="font-size:16px;margin-bottom:12px;">By Lab Member</h2>';
      if (personList.length === 0) {
        html += '<div class="empty-state">No activity entries in the last ' + days + ' days.</div>';
      } else {
        personList = sortItems(personList, _sortKey, _sortDir, MEMBER_COLUMNS);
        html += '<table class="data-table">' + sortableHeader(MEMBER_COLUMNS, _sortKey, _sortDir, 'onActivitySort') + '<tbody>';
        personList.forEach(function (p) {
          var breakdown = Object.entries(p.byCategory)
            .sort(function (a, b) { return b[1] - a[1]; })
            .map(function (kv) { return kv[0] + ': ' + kv[1].toFixed(1) + 'h'; })
            .join(', ');
          html += '<tr><td><strong>' + p.name + '</strong></td><td>' + p.totalHours.toFixed(1) + '</td><td>' + p.entries + '</td><td style="font-size:13px;color:var(--text-muted);">' + breakdown + '</td></tr>';
        });
        html += '</tbody></table>';
      }

      content.innerHTML = html;
    } catch (err) {
      content.innerHTML = '<div class="empty-state" style="color:var(--red);">Error loading activity data: ' + err.message + '</div>';
      console.error('[activity-summary]', err);
    }
  }

  window.onActivitySort = function (key) {
    if (_sortKey === key) { _sortDir = _sortDir === 'asc' ? 'desc' : 'asc'; }
    else { _sortKey = key; _sortDir = 'asc'; }
    loadAndRender();
  };

  // Wire range selector
  rangeSelect.onchange = function () { _sortKey = null; _sortDir = 'asc'; loadAndRender(); };

  // Wait for Firebase auth
  if (typeof firebridge !== 'undefined') {
    firebridge.onAuth(function () {
      loadAndRender();
    });
  } else {
    document.addEventListener('DOMContentLoaded', function () {
      showNotConnected();
    });
  }
})();
