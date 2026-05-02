/* cv-overview.js — read-only view of all lab members' CV data from Firestore cvData collection */

(function () {
  var content = document.getElementById('content');
  var copyBtn = document.getElementById('copy-pubs-btn');
  var _allPubs = []; // for copy-to-clipboard
  var _sortKey = null;
  var _sortDir = 'asc';
  var CV_COLUMNS = [
    { label: 'Name', key: 'name' },
    { label: 'Category', key: 'category' },
    { label: 'Journals', key: 'journals', type: 'number' },
    { label: 'Conf.', key: 'conferences', type: 'number' },
    { label: 'Present.', key: 'presentations', type: 'number' },
    { label: 'Patents', key: 'patents', type: 'number' },
    { label: 'Grants', key: 'grants', type: 'number' },
    { label: 'Awards', key: 'awards', type: 'number' },
    { label: 'Last Updated', key: null },
  ];

  function showNotConnected() {
    content.innerHTML =
      '<div class="empty-state">' +
        '<p>Not connected to the website.</p>' +
        '<p style="margin-top:8px"><a href="/rm/pages/settings.html">Go to Settings</a> to sign in.</p>' +
      '</div>';
  }

  function stalenessChip(updatedAt) {
    if (!updatedAt) return '<span class="chip chip-muted">unknown</span>';
    var d = updatedAt.toDate ? updatedAt.toDate() : new Date(updatedAt);
    var days = Math.floor((Date.now() - d.getTime()) / 86400000);
    if (days > 120) return '<span class="chip chip-red">' + days + 'd ago</span>';
    if (days > 60)  return '<span class="chip chip-amber">' + days + 'd ago</span>';
    return '<span class="chip chip-green">' + days + 'd ago</span>';
  }

  async function loadAndRender() {
    if (typeof firebridge === 'undefined' || !firebridge.isReady()) {
      showNotConnected();
      return;
    }

    content.innerHTML = '<div class="empty-state">Loading CV data&hellip;</div>';

    try {
      var _d = await api.load('lab/users.json');
      var users = ((_d && _d.users) || []).filter(function (u) { return u.role && u.role !== 'guest'; });

      // Load CV data for each user
      var cvMap = {};
      var promises = users.map(function (u) {
        return firebridge.getDoc('cvData', u.id).then(function (cv) {
          if (cv) cvMap[u.id] = cv;
        }).catch(function () {});
      });
      await Promise.all(promises);

      // Aggregate lab-wide totals
      var totals = { journals: 0, conferences: 0, books: 0, patents: 0, presentations: 0, grants: 0, awards: 0, software: 0 };
      _allPubs = [];

      var rows = [];
      users.forEach(function (u) {
        var cv = cvMap[u.id];
        var row = {
          name: u.name || u.email || 'Unnamed',
          category: u.category || '',
          journals: 0, conferences: 0, books: 0, patents: 0,
          presentations: 0, grants: 0, awards: 0, software: 0,
          updatedAt: null,
          hasCV: false,
        };

        if (cv) {
          row.hasCV = true;
          row.journals = (cv.journals || []).length;
          row.conferences = (cv.conferences || []).length;
          row.books = (cv.books || []).length;
          row.patents = (cv.patents || []).length;
          row.presentations = (cv.presentations || []).length;
          row.grants = (cv.grants || []).length;
          row.awards = (cv.awards || []).length;
          row.software = (cv.software || []).length;
          row.updatedAt = cv.updatedAt;

          // Collect publications for export
          (cv.journals || []).forEach(function (j) {
            _allPubs.push({ type: 'Journal', title: j.title || '', authors: j.authors || '', year: j.year || '', journal: j.journal || '', member: row.name });
          });
          (cv.conferences || []).forEach(function (c) {
            _allPubs.push({ type: 'Conference', title: c.title || '', authors: c.authors || '', year: c.year || '', journal: c.conference || '', member: row.name });
          });
        }

        // Add to totals
        Object.keys(totals).forEach(function (k) { totals[k] += row[k]; });
        rows.push(row);
      });

      // Sort: has CV first, then by journals desc
      rows.sort(function (a, b) {
        if (a.hasCV !== b.hasCV) return b.hasCV - a.hasCV;
        return b.journals - a.journals;
      });

      // Render summary cards
      var html = '<div style="display:flex;gap:16px;margin-bottom:20px;flex-wrap:wrap;">';
      html += '<div class="card" style="flex:1;min-width:160px;"><div class="card-title">Total Publications</div><div class="card-count">' + (totals.journals + totals.conferences + totals.books) + '</div><div class="card-body">' + totals.journals + ' journal, ' + totals.conferences + ' conference, ' + totals.books + ' book</div></div>';
      html += '<div class="card" style="flex:1;min-width:160px;"><div class="card-title">Presentations</div><div class="card-count">' + totals.presentations + '</div></div>';
      html += '<div class="card" style="flex:1;min-width:160px;"><div class="card-title">Patents</div><div class="card-count">' + totals.patents + '</div></div>';
      html += '<div class="card" style="flex:1;min-width:160px;"><div class="card-title">Grants</div><div class="card-count">' + totals.grants + '</div></div>';
      html += '<div class="card" style="flex:1;min-width:160px;"><div class="card-title">Awards</div><div class="card-count">' + totals.awards + '</div></div>';
      html += '</div>';

      // Stale CVs warning
      var stale = rows.filter(function (r) {
        if (!r.updatedAt) return r.hasCV;
        var d = r.updatedAt.toDate ? r.updatedAt.toDate() : new Date(r.updatedAt);
        return (Date.now() - d.getTime()) / 86400000 > 60;
      });
      var noCV = rows.filter(function (r) { return !r.hasCV; });
      if (stale.length || noCV.length) {
        html += '<div style="background:var(--amber-bg);border:1px solid var(--amber);border-radius:var(--radius);padding:12px;margin-bottom:16px;font-size:14px;">';
        if (noCV.length) html += '<strong>' + noCV.length + ' member' + (noCV.length > 1 ? 's' : '') + ' with no CV data.</strong> ';
        if (stale.length) html += '<strong>' + stale.length + ' CV' + (stale.length > 1 ? 's' : '') + ' not updated in 60+ days.</strong>';
        html += '</div>';
      }

      // Per-member table
      rows = sortItems(rows, _sortKey, _sortDir, CV_COLUMNS);
      html += '<table class="data-table">';
      html += sortableHeader(CV_COLUMNS, _sortKey, _sortDir, 'onCVSort');
      html += '<tbody>';

      rows.forEach(function (r) {
        html += '<tr>';
        html += '<td><strong>' + r.name + '</strong></td>';
        html += '<td>' + r.category + '</td>';
        if (!r.hasCV) {
          html += '<td colspan="6" style="color:var(--text-muted);font-style:italic;">No CV data</td>';
          html += '<td><span class="chip chip-muted">none</span></td>';
        } else {
          html += '<td>' + r.journals + '</td>';
          html += '<td>' + r.conferences + '</td>';
          html += '<td>' + r.presentations + '</td>';
          html += '<td>' + r.patents + '</td>';
          html += '<td>' + r.grants + '</td>';
          html += '<td>' + r.awards + '</td>';
          html += '<td>' + stalenessChip(r.updatedAt) + '</td>';
        }
        html += '</tr>';
      });

      // Totals row
      html += '<tr style="font-weight:700;background:var(--bg);">';
      html += '<td>Lab Total</td><td></td>';
      html += '<td>' + totals.journals + '</td>';
      html += '<td>' + totals.conferences + '</td>';
      html += '<td>' + totals.presentations + '</td>';
      html += '<td>' + totals.patents + '</td>';
      html += '<td>' + totals.grants + '</td>';
      html += '<td>' + totals.awards + '</td>';
      html += '<td></td>';
      html += '</tr>';

      html += '</tbody></table>';
      content.innerHTML = html;
    } catch (err) {
      content.innerHTML = '<div class="empty-state" style="color:var(--red);">Error: ' + err.message + '</div>';
      console.error('[cv-overview]', err);
    }
  }

  window.onCVSort = function (key) {
    if (_sortKey === key) { _sortDir = _sortDir === 'asc' ? 'desc' : 'asc'; }
    else { _sortKey = key; _sortDir = 'asc'; }
    loadAndRender();
  };

  // Copy publication list to clipboard
  copyBtn.onclick = function () {
    if (!_allPubs.length) { alert('No publications loaded yet.'); return; }
    var text = 'Lab Publication List\n' + '='.repeat(40) + '\n\n';
    _allPubs.sort(function (a, b) { return (b.year || '').localeCompare(a.year || ''); });
    _allPubs.forEach(function (p, i) {
      text += (i + 1) + '. ' + p.authors + ' (' + p.year + '). ' + p.title + '. ' + p.journal + '. [' + p.type + ']\n\n';
    });
    navigator.clipboard.writeText(text).then(function () {
      copyBtn.textContent = 'Copied!';
      setTimeout(function () { copyBtn.textContent = 'Copy Publication List'; }, 2000);
    }).catch(function () {
      alert('Copy failed — check browser permissions.');
    });
  };

  // Wait for Firebase auth
  if (typeof firebridge !== 'undefined') {
    firebridge.onAuth(function () { loadAndRender(); });
  } else {
    document.addEventListener('DOMContentLoaded', function () { showNotConnected(); });
  }
})();
