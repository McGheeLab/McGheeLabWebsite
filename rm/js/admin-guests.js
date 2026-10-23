/* admin-guests.js — V3.304 guest-oversight panel.
 *
 * Loads the whole users collection plus enrollments + teacher classes for
 * context, and buckets every profile by a derived taxonomy (first match
 * wins): lab member (role !== 'guest') → collaborator (category) →
 * teacher → student → guest (unclassified). Count tiles double as
 * filters; the table supports search, one-click recategorize, hide
 * toggle, and profile-doc deletion.
 *
 * This panel never touches `role` — promotion to lab member stays on the
 * website's admin page / admin-permissions. Admin-gated via
 * firebridge.gateAdmin(); direct firebridge.db() reads (admin-permissions
 * pattern, no api-routes). */

(function () {
  function escHtml(s) {
    return String(s == null ? '' : s)
      .replace(/&/g, '&amp;').replace(/</g, '&lt;')
      .replace(/>/g, '&gt;').replace(/"/g, '&quot;');
  }
  function db() { return firebridge.db(); }
  function fmtDate(v) {
    var d = v && v.toDate ? v.toDate() : (v ? new Date(v) : null);
    return d && !isNaN(d) ? d.toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric' }) : '';
  }

  var BUCKETS = [
    { key: 'all',          label: 'Everyone' },
    { key: 'member',       label: 'Lab members' },
    { key: 'collaborator', label: 'Collaborators' },
    { key: 'teacher',      label: 'Teachers' },
    { key: 'student',      label: 'Students' },
    { key: 'guest',        label: 'Unclassified guests' }
  ];
  // Categories the recategorize dropdown offers. Deliberately excludes
  // lab-member categories (pi/postdoc/grad/...) — those changes belong on
  // the website's user-management page where role is handled too.
  var RECAT_OPTIONS = ['guest', 'teacher', 'student', 'collaborator'];

  var users = [];        // users/*
  var enrollments = [];  // enrollments/* (student context)
  var classes = [];      // schedules kind teacher-class (titles)
  var bucketFilter = 'all';
  var search = '';

  function bucketOf(u) {
    if ((u.role || 'guest') !== 'guest') return 'member';
    if (u.category === 'collaborator') return 'collaborator';
    if (u.category === 'teacher') return 'teacher';
    if (u.category === 'student') return 'student';
    return 'guest';
  }

  function setStatus(msg, kind) {
    var el = document.getElementById('gst-status');
    if (!el) return;
    el.className = 'gst-status' + (kind ? ' ' + kind : '');
    el.textContent = msg || '';
  }

  async function boot() {
    var gateRes = await firebridge.gateAdmin('oversee guest users');
    if (!gateRes || !gateRes.allowed) return;
    document.getElementById('gst-gate').style.display = 'none';
    document.getElementById('gst-content').style.display = '';

    document.getElementById('gst-refresh').addEventListener('click', loadAndRender);
    document.getElementById('gst-search').addEventListener('input', function () {
      search = this.value.trim().toLowerCase();
      renderTable();
    });
    await loadAndRender();
  }

  async function loadAndRender() {
    setStatus('Loading…');
    try {
      await Promise.all([
        db().collection('users').get().then(function (s) {
          users = s.docs.map(function (d) { return Object.assign({ uid: d.id }, d.data()); });
        }),
        db().collection('enrollments').get().then(function (s) {
          enrollments = s.docs.map(function (d) { return Object.assign({ id: d.id }, d.data()); });
        }),
        db().collection('schedules').where('kind', '==', 'teacher-class').get().then(function (s) {
          classes = s.docs.map(function (d) { return Object.assign({ id: d.id }, d.data()); });
        })
      ]);
    } catch (err) {
      console.error('[admin-guests] load failed:', err);
      setStatus('Load failed: ' + err.message, 'err');
      return;
    }
    users.sort(function (a, b) {
      var tA = a.createdAt && a.createdAt.toMillis ? a.createdAt.toMillis() : 0;
      var tB = b.createdAt && b.createdAt.toMillis ? b.createdAt.toMillis() : 0;
      return tB - tA;
    });
    renderTiles();
    renderTable();
    setStatus('');
  }

  function renderTiles() {
    var el = document.getElementById('gst-tiles');
    el.innerHTML = BUCKETS.map(function (b) {
      var count = b.key === 'all' ? users.length
        : users.filter(function (u) { return bucketOf(u) === b.key; }).length;
      return '<div class="gst-tile' + (bucketFilter === b.key ? ' on' : '') + '" data-bucket="' + b.key + '">' +
        '<div class="n">' + count + '</div><div class="l">' + escHtml(b.label) + '</div></div>';
    }).join('');
    el.querySelectorAll('[data-bucket]').forEach(function (tile) {
      tile.addEventListener('click', function () {
        bucketFilter = tile.dataset.bucket;
        renderTiles();
        renderTable();
      });
    });
  }

  // V3.634 — name the inviting teacher, not just the class. The association
  // has to survive removal and class deletion, so it is read from every
  // enrollment regardless of status, with the denormalized
  // users/{uid}.teacherUids as the fallback when the enrollment is gone.
  function teachersOf(u) {
    var uids = enrollments
      .filter(function (e) { return e.studentUid === u.uid && e.teacherUid; })
      .map(function (e) { return e.teacherUid; })
      .concat(Array.isArray(u.teacherUids) ? u.teacherUids : []);
    var seen = {}, names = [];
    uids.forEach(function (uid) {
      if (seen[uid]) return;
      seen[uid] = 1;
      var t = users.find(function (x) { return x.uid === uid; });
      names.push(t ? (t.name || t.email || uid) : uid);
    });
    return names;
  }

  function contextFor(u) {
    var bucket = bucketOf(u);
    if (bucket === 'student') {
      var teachers = teachersOf(u);
      var via = teachers.length
        ? '<div class="gst-sub">invited by ' + escHtml(teachers.join(', ')) + '</div>'
        : '';
      var mine = enrollments.filter(function (e) { return e.studentUid === u.uid && e.status === 'active'; });
      if (!mine.length) return '<span class="gst-sub">no active class</span>' + via;
      return mine.map(function (e) {
        var cls = classes.find(function (c) { return c.id === e.scheduleId; });
        return escHtml(cls ? (cls.title || e.scheduleId) : e.scheduleId);
      }).join(', ') + via;
    }
    if (bucket === 'teacher') {
      var owned = classes.filter(function (c) { return c.ownerUid === u.uid; });
      var link = '<a href="/rm/pages/admin-teachers.html?tab=teachers">teacher panel →</a>';
      if (!owned.length) return '<span class="gst-sub">no class yet</span> · ' + link;
      return owned.map(function (c) { return escHtml(c.title || c.id); }).join(', ') + ' · ' + link;
    }
    return '';
  }

  function renderTable() {
    var tbody = document.querySelector('#gst-table tbody');
    var rows = users.filter(function (u) {
      if (bucketFilter !== 'all' && bucketOf(u) !== bucketFilter) return false;
      if (!search) return true;
      return ((u.name || '') + ' ' + (u.email || '')).toLowerCase().indexOf(search) >= 0;
    });
    if (!rows.length) {
      tbody.innerHTML = '<tr><td colspan="7" class="gst-empty">No users match.</td></tr>';
      return;
    }
    tbody.innerHTML = rows.map(function (u) {
      var bucket = bucketOf(u);
      var isMember = bucket === 'member';
      return '<tr data-uid="' + escHtml(u.uid) + '">' +
        '<td><div>' + escHtml(u.name || '—') + (u.hidden ? ' <span class="gst-sub">(hidden)</span>' : '') + '</div>' +
          '<div class="gst-sub">' + escHtml(u.email || u.uid) + '</div></td>' +
        '<td><span class="gst-chip ' + bucket + '">' + escHtml(BUCKETS.find(function (b) { return b.key === bucket; }).label) + '</span></td>' +
        '<td>' +
          (isMember
            ? escHtml(u.category || '')
            : '<select class="gst-cat-select" data-recat>' + RECAT_OPTIONS.map(function (c) {
                return '<option value="' + c + '"' + ((u.category || 'guest') === c ? ' selected' : '') + '>' + c + '</option>';
              }).join('') + '</select>') +
        '</td>' +
        '<td>' + escHtml(u.role || 'guest') + '</td>' +
        '<td>' + contextFor(u) + '</td>' +
        '<td class="gst-sub">' + fmtDate(u.createdAt) + '</td>' +
        '<td>' +
          '<button class="btn btn-sm" data-hide>' + (u.hidden ? 'Unhide' : 'Hide') + '</button> ' +
          (!isMember ? '<button class="btn btn-sm" data-del style="color:#dc2626;">Delete</button>' : '') +
        '</td>' +
      '</tr>';
    }).join('');

    tbody.querySelectorAll('[data-recat]').forEach(function (sel) {
      sel.addEventListener('change', async function () {
        var uid = sel.closest('tr').dataset.uid;
        try {
          await db().collection('users').doc(uid).set({ category: sel.value }, { merge: true });
          var u = users.find(function (x) { return x.uid === uid; });
          if (u) u.category = sel.value;
          renderTiles();
          renderTable();
          setStatus('Category updated.', 'ok');
        } catch (e) { setStatus('Update failed: ' + e.message, 'err'); }
      });
    });
    tbody.querySelectorAll('[data-hide]').forEach(function (btn) {
      btn.addEventListener('click', async function () {
        var uid = btn.closest('tr').dataset.uid;
        var u = users.find(function (x) { return x.uid === uid; });
        try {
          await db().collection('users').doc(uid).set({ hidden: !u.hidden }, { merge: true });
          u.hidden = !u.hidden;
          renderTable();
        } catch (e) { setStatus('Update failed: ' + e.message, 'err'); }
      });
    });
    tbody.querySelectorAll('[data-del]').forEach(function (btn) {
      btn.addEventListener('click', async function () {
        var uid = btn.closest('tr').dataset.uid;
        var u = users.find(function (x) { return x.uid === uid; });
        if (!confirm('Delete the profile doc for "' + (u.name || u.email || uid) + '"?\n\n' +
          'Their Firebase Auth account survives — if they sign in again they re-land as an unclassified guest. ' +
          'Any enrollments they have are kept for audit.')) return;
        try {
          await db().collection('users').doc(uid).delete();
          users = users.filter(function (x) { return x.uid !== uid; });
          renderTiles();
          renderTable();
          setStatus('Profile deleted.', 'ok');
        } catch (e) { setStatus('Delete failed: ' + e.message, 'err'); }
      });
    });
  }

  document.addEventListener('DOMContentLoaded', boot);
})();
