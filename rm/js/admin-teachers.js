/* admin-teachers.js — V3.304 external-teacher oversight.
 *
 * Four tabs (?tab=requests|teachers|profiles|reviews on the page URL):
 *   1. Class Requests — pending queue on top. Approve opens a modal
 *      (class title, doc id, granted-folder checkboxes prefilled from the
 *      request) and commits one batch: schedules/{tc-…} (kind:'teacher-class',
 *      modules[] expanded from /modules/manifest.json), joinCodes/{CODE},
 *      the request's status flip, and users/{teacherUid}.category:'teacher'.
 *   2. Teachers & Classes — every category:'teacher' user joined client-side
 *      with their schedules, join codes, and enrollment rosters. Edit granted
 *      folders, regenerate/disable codes, remove students, delete class.
 *   3. Featured Profiles — teacherProfiles moderation (approve / hide).
 *   4. Reviews — ALL reviews, every status; approve / reject / feature / delete.
 *
 * Admin-gated via firebridge.gateAdmin(); reads use direct firebridge.db()
 * refs (same pattern as admin-permissions.js — no api-routes involvement). */

(function () {
  function escHtml(s) {
    return String(s == null ? '' : s)
      .replace(/&/g, '&amp;').replace(/</g, '&lt;')
      .replace(/>/g, '&gt;').replace(/"/g, '&quot;');
  }
  function db() { return firebridge.db(); }
  function ts() { return firebase.firestore.FieldValue.serverTimestamp(); }
  function fmtDate(v) {
    var d = v && v.toDate ? v.toDate() : (v ? new Date(v) : null);
    return d && !isNaN(d) ? d.toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric' }) : '';
  }
  function chip(status) {
    return '<span class="tcadm-chip ' + escHtml(status) + '">' + escHtml(status) + '</span>';
  }
  function stars(n) {
    n = Math.max(0, Math.min(5, Number(n) || 0));
    return '<span class="tcadm-stars">' + '★'.repeat(n) + '☆'.repeat(5 - n) + '</span>';
  }

  var CODE_ALPHABET = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
  function generateJoinCode() {
    var buf = new Uint32Array(6); crypto.getRandomValues(buf);
    var out = '';
    for (var i = 0; i < 6; i++) out += CODE_ALPHABET[buf[i] % CODE_ALPHABET.length];
    return out;
  }
  function slugify(s) {
    return String(s || '').toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 32) || 'class';
  }

  /* ── state ── */
  var TAB = window.__TC_TAB || 'requests';
  var requests = [];        // classRequests/*
  var teachers = [];        // users/* with category 'teacher'
  var classes = [];         // schedules/* with kind 'teacher-class'
  var joinCodes = [];       // joinCodes/*
  var enrollments = [];     // enrollments/*
  var reviews = [];         // reviews/*
  var profiles = [];        // teacherProfiles/*
  var manifest = null;      // /modules/manifest.json .folders
  var reviewFilter = 'all';

  function setStatus(msg, kind) {
    var el = document.getElementById('tcadm-status');
    if (!el) return;
    el.className = 'tcadm-status' + (kind ? ' ' + kind : '');
    el.textContent = msg || '';
  }

  /* ── boot ── */
  async function boot() {
    var gateRes = await firebridge.gateAdmin('oversee external teachers');
    if (!gateRes || !gateRes.allowed) return;
    document.getElementById('tcadm-gate').style.display = 'none';
    document.getElementById('tcadm-content').style.display = '';
    document.getElementById('tcadm-refresh').addEventListener('click', loadAndRender);
    await loadAndRender();
  }

  async function loadAndRender() {
    setStatus('Loading…');
    try {
      await loadAll();
    } catch (err) {
      console.error('[admin-teachers] load failed:', err);
      setStatus('Load failed: ' + err.message, 'err');
      return;
    }
    renderRequests();
    renderTeachers();
    renderProfiles();
    renderReviews();
    setStatus('');
  }

  async function loadAll() {
    var jobs = [
      db().collection('classRequests').get().then(function (s) {
        requests = s.docs.map(function (d) { return Object.assign({ id: d.id }, d.data()); });
        requests.sort(function (a, b) {
          if ((a.status === 'pending') !== (b.status === 'pending')) return a.status === 'pending' ? -1 : 1;
          return (b.createdAt && b.createdAt.toMillis ? b.createdAt.toMillis() : 0) -
                 (a.createdAt && a.createdAt.toMillis ? a.createdAt.toMillis() : 0);
        });
      }),
      db().collection('users').where('category', '==', 'teacher').get().then(function (s) {
        teachers = s.docs.map(function (d) { return Object.assign({ uid: d.id }, d.data()); });
        teachers.sort(function (a, b) { return (a.name || '').localeCompare(b.name || ''); });
      }),
      db().collection('schedules').where('kind', '==', 'teacher-class').get().then(function (s) {
        classes = s.docs.map(function (d) { return Object.assign({ id: d.id }, d.data()); });
      }),
      db().collection('joinCodes').get().then(function (s) {
        joinCodes = s.docs.map(function (d) { return Object.assign({ code: d.id }, d.data()); });
      }),
      db().collection('enrollments').get().then(function (s) {
        enrollments = s.docs.map(function (d) { return Object.assign({ id: d.id }, d.data()); });
      }),
      db().collection('reviews').get().then(function (s) {
        reviews = s.docs.map(function (d) { return Object.assign({ id: d.id }, d.data()); });
        reviews.sort(function (a, b) {
          return (b.createdAt && b.createdAt.toMillis ? b.createdAt.toMillis() : 0) -
                 (a.createdAt && a.createdAt.toMillis ? a.createdAt.toMillis() : 0);
        });
      }),
      db().collection('teacherProfiles').get().then(function (s) {
        profiles = s.docs.map(function (d) { return Object.assign({ id: d.id }, d.data()); });
        profiles.sort(function (a, b) {
          var rank = { pending: 0, approved: 1, draft: 2, hidden: 3 };
          return (rank[a.status] != null ? rank[a.status] : 4) - (rank[b.status] != null ? rank[b.status] : 4);
        });
      })
    ];
    if (!manifest) {
      jobs.push(fetch('/modules/manifest.json')
        .then(function (r) { return r.ok ? r.json() : { folders: {} }; })
        .then(function (j) { manifest = j.folders || {}; })
        .catch(function () { manifest = {}; }));
    }
    await Promise.all(jobs);
  }

  function folderLabel(key) {
    return (manifest && manifest[key] && manifest[key].label) || key;
  }
  function folderChips(keys) {
    return '<div class="tcadm-folders">' + (keys || []).map(function (k) {
      return '<span class="tcadm-folder-chip">' + escHtml(folderLabel(k)) + '</span>';
    }).join('') + '</div>';
  }

  /* ================================================================
     TAB 1 — CLASS REQUESTS
     ================================================================ */
  function renderRequests() {
    var el = document.getElementById('tcadm-requests-list');
    if (!el) return;
    if (!requests.length) {
      el.innerHTML = '<div class="tcadm-empty">No class requests yet.</div>';
      return;
    }
    el.innerHTML = requests.map(function (r) {
      var meta = [r.school, [r.schoolCity, r.schoolState].filter(Boolean).join(', '),
                  r.gradeLevel ? 'Grades ' + r.gradeLevel : '',
                  r.classSize ? r.classSize + ' students' : '',
                  r.subjectArea].filter(Boolean).join(' · ');
      return '<div class="tcadm-row" data-id="' + escHtml(r.id) + '">' +
        '<div class="tcadm-row-main">' +
          '<div class="tcadm-name">' + chip(r.status) + ' ' + escHtml(r.teacherName || r.teacherEmail || r.teacherUid) + '</div>' +
          '<div class="tcadm-sub">' + escHtml(r.teacherEmail || '') + ' · requested ' + fmtDate(r.createdAt) + '</div>' +
          '<div class="tcadm-sub">' + escHtml(meta) + '</div>' +
          folderChips(r.requestedFolders) +
          (r.message ? '<div class="tcadm-msg">' + escHtml(r.message) + '</div>' : '') +
          (r.status === 'denied' && r.denyReason ? '<div class="tcadm-sub">Denied: ' + escHtml(r.denyReason) + '</div>' : '') +
          (r.status === 'approved' && r.scheduleId ? '<div class="tcadm-sub">Class: <code>' + escHtml(r.scheduleId) + '</code></div>' : '') +
        '</div>' +
        '<div class="tcadm-row-actions">' +
          (r.status === 'pending'
            ? '<button class="btn btn-primary btn-sm" data-approve>Approve…</button>' +
              '<button class="btn btn-sm" data-deny>Deny</button>'
            : '') +
        '</div>' +
      '</div>';
    }).join('');

    el.querySelectorAll('[data-approve]').forEach(function (btn) {
      btn.addEventListener('click', function () {
        var id = btn.closest('.tcadm-row').dataset.id;
        var req = requests.find(function (r) { return r.id === id; });
        if (req) openApproveModal(req);
      });
    });
    el.querySelectorAll('[data-deny]').forEach(function (btn) {
      btn.addEventListener('click', async function () {
        var id = btn.closest('.tcadm-row').dataset.id;
        var reason = prompt('Reason for denying (shown to the teacher):', '');
        if (reason === null) return;
        try {
          await db().collection('classRequests').doc(id).update({
            status: 'denied', denyReason: reason.trim(),
            decidedAt: ts(), decidedBy: firebridge.getUser().uid, updatedAt: ts()
          });
          await loadAndRender();
        } catch (e) { setStatus('Deny failed: ' + e.message, 'err'); }
      });
    });
  }

  function openApproveModal(req) {
    var folderKeys = Object.keys(manifest || {});
    var suggestedId = 'tc-' + slugify(req.school) + '-' + generateJoinCode().slice(0, 4).toLowerCase();
    var overlay = document.createElement('div');
    overlay.className = 'tcadm-modal-overlay';
    overlay.innerHTML =
      '<div class="tcadm-modal">' +
        '<h3>Approve class for ' + escHtml(req.teacherName || req.teacherEmail) + '</h3>' +
        '<label>Class title</label>' +
        '<input type="text" id="tcam-title" value="' + escHtml((req.school || 'Class') + ' — McGhee Lab Modules') + '">' +
        '<label>Class id (schedules doc — cannot change later)</label>' +
        '<input type="text" id="tcam-id" value="' + escHtml(suggestedId) + '">' +
        '<label>Granted module sets</label>' +
        folderKeys.map(function (k) {
          var checked = (req.requestedFolders || []).indexOf(k) >= 0 ? ' checked' : '';
          var count = (manifest[k].files || []).length;
          return '<label class="tcadm-folder-check"><input type="checkbox" value="' + escHtml(k) + '"' + checked + '> ' +
                 escHtml(manifest[k].label || k) + ' <span style="color:#9ca3af;">(' + count + ' modules)</span></label>';
        }).join('') +
        '<div class="tcadm-modal-actions">' +
          '<button class="btn" id="tcam-cancel">Cancel</button>' +
          '<button class="btn btn-primary" id="tcam-confirm">Approve &amp; provision</button>' +
        '</div>' +
      '</div>';
    document.body.appendChild(overlay);
    overlay.addEventListener('click', function (e) { if (e.target === overlay) overlay.remove(); });
    overlay.querySelector('#tcam-cancel').addEventListener('click', function () { overlay.remove(); });

    overlay.querySelector('#tcam-confirm').addEventListener('click', async function () {
      var btn = this;
      var title = overlay.querySelector('#tcam-title').value.trim();
      var scheduleId = overlay.querySelector('#tcam-id').value.trim();
      var granted = [].slice.call(overlay.querySelectorAll('.tcadm-folder-check input:checked'))
        .map(function (i) { return i.value; });
      if (!title || !scheduleId) { alert('Title and id are required.'); return; }
      if (!/^[a-z0-9-]+$/.test(scheduleId)) { alert('Id must be lowercase letters, digits, and dashes.'); return; }
      if (!granted.length) { alert('Grant at least one module set.'); return; }
      btn.disabled = true;
      try {
        var existing = await db().collection('schedules').doc(scheduleId).get();
        if (existing.exists) throw new Error('A schedule with id "' + scheduleId + '" already exists.');
        var code = generateJoinCode();
        var codeDoc = await db().collection('joinCodes').doc(code).get();
        if (codeDoc.exists) code = generateJoinCode(); // second draw; 1-in-10^9 double collision

        var adminUid = firebridge.getUser().uid;
        var batch = db().batch();
        batch.set(db().collection('schedules').doc(scheduleId), {
          kind: 'teacher-class',
          title: title,
          subtitle: req.school || '',
          semester: '',
          description: '',
          ownerUid: req.teacherUid,
          teacherUid: req.teacherUid,
          teacherName: req.teacherName || '',
          school: req.school || '',
          classAdminEmails: [],
          grantedFolders: granted,
          modules: buildModules(granted),
          enrollmentOpen: true,
          testMode: false,
          tabs: [],
          createdAt: ts(),
          updatedAt: ts()
        });
        batch.set(db().collection('joinCodes').doc(code), {
          scheduleId: scheduleId, teacherUid: req.teacherUid,
          active: true, createdAt: ts(), createdBy: adminUid
        });
        batch.update(db().collection('classRequests').doc(req.id), {
          status: 'approved', scheduleId: scheduleId,
          decidedAt: ts(), decidedBy: adminUid, updatedAt: ts()
        });
        batch.set(db().collection('users').doc(req.teacherUid), { category: 'teacher' }, { merge: true });
        await batch.commit();
        overlay.remove();
        setStatus('Approved — class ' + scheduleId + ' created with code ' + code, 'ok');
        await loadAndRender();
      } catch (e) {
        btn.disabled = false;
        alert('Approve failed: ' + e.message);
      }
    });
  }

  // Expand granted folders into the schedules.modules[] array the class
  // page + module viewer already consume (same shape as the lab's classes).
  function buildModules(grantedFolders) {
    var out = [], order = 0;
    grantedFolders.forEach(function (folder) {
      var files = (manifest[folder] && manifest[folder].files) || [];
      files.forEach(function (f) {
        out.push({
          id: folder + '--' + f.name.replace(/\.html$/, ''),
          folder: folder,
          htmlFile: f.name,
          title: f.title || f.name,
          order: order++,
          published: true
        });
      });
    });
    return out;
  }

  /* ================================================================
     TAB 2 — TEACHERS & CLASSES
     ================================================================ */
  function renderTeachers() {
    var el = document.getElementById('tcadm-teachers-list');
    if (!el) return;
    if (!teachers.length) {
      el.innerHTML = '<div class="tcadm-empty">No teachers yet — approve a class request first.</div>';
      return;
    }
    el.innerHTML = teachers.map(function (t) {
      var tClasses = classes.filter(function (c) { return c.ownerUid === t.uid; });
      var html = '<div class="tcadm-row" data-uid="' + escHtml(t.uid) + '">' +
        '<div class="tcadm-row-main">' +
          '<div class="tcadm-name">' + escHtml(t.name || t.email || t.uid) + '</div>' +
          '<div class="tcadm-sub">' + escHtml(t.email || '') + '</div>';
      if (!tClasses.length) html += '<div class="tcadm-sub" style="font-style:italic;">No provisioned classes.</div>';
      tClasses.forEach(function (c) {
        var activeCode = joinCodes.find(function (j) { return j.scheduleId === c.id && j.active; });
        var roster = enrollments.filter(function (e) { return e.scheduleId === c.id && e.status === 'active'; });
        html += '<div class="tcadm-class-block" data-schedule="' + escHtml(c.id) + '">' +
          '<div class="tcadm-name" style="font-size:12.5px;">' +
            '<a href="/#/classes/' + escHtml(c.id) + '" target="_blank" rel="noopener">' + escHtml(c.title || c.id) + '</a> ' +
            (c.enrollmentOpen !== false
              ? '<span class="tcadm-chip active">enrollment open</span>'
              : '<span class="tcadm-chip denied">enrollment closed</span>') +
          '</div>' +
          folderChips(c.grantedFolders) +
          '<div class="tcadm-sub" style="margin-top:6px;">Join code: ' +
            (activeCode ? '<span class="tcadm-code">' + escHtml(activeCode.code) + '</span>' : '<em>none active</em>') +
            ' · ' + roster.length + ' student' + (roster.length === 1 ? '' : 's') +
          '</div>' +
          (roster.length ? '<table class="tcadm-roster-table"><tbody>' + roster.map(function (s) {
            return '<tr><td>' + escHtml(s.studentName || '—') + '</td>' +
              '<td style="color:#6b7280;">' + escHtml(s.studentEmail || '') + '</td>' +
              '<td style="color:#6b7280;">' + fmtDate(s.createdAt) + '</td>' +
              '<td><button class="btn btn-sm" data-remove-student="' + escHtml(s.id) + '">Remove</button></td></tr>';
          }).join('') + '</tbody></table>' : '') +
          '<div class="tcadm-row-actions" style="margin-top:8px;">' +
            '<button class="btn btn-sm" data-edit-folders>Edit granted modules…</button>' +
            '<button class="btn btn-sm" data-regen-code' + (activeCode ? ' data-old="' + escHtml(activeCode.code) + '"' : '') + '>' +
              (activeCode ? 'Regenerate code' : 'Create code') + '</button>' +
            (activeCode ? '<button class="btn btn-sm" data-disable-code="' + escHtml(activeCode.code) + '">Disable code</button>' : '') +
            '<button class="btn btn-sm" data-delete-class style="color:#dc2626;">Delete class</button>' +
          '</div>' +
        '</div>';
      });
      return html + '</div></div>';
    }).join('');

    el.querySelectorAll('[data-remove-student]').forEach(function (btn) {
      btn.addEventListener('click', async function () {
        if (!confirm('Remove this student from the class?')) return;
        try {
          await db().collection('enrollments').doc(btn.dataset.removeStudent)
            .update({ status: 'removed', updatedAt: ts() });
          await loadAndRender();
        } catch (e) { setStatus('Remove failed: ' + e.message, 'err'); }
      });
    });
    el.querySelectorAll('[data-edit-folders]').forEach(function (btn) {
      btn.addEventListener('click', function () {
        var scheduleId = btn.closest('.tcadm-class-block').dataset.schedule;
        var cls = classes.find(function (c) { return c.id === scheduleId; });
        if (cls) openEditFoldersModal(cls);
      });
    });
    el.querySelectorAll('[data-regen-code]').forEach(function (btn) {
      btn.addEventListener('click', async function () {
        var scheduleId = btn.closest('.tcadm-class-block').dataset.schedule;
        var cls = classes.find(function (c) { return c.id === scheduleId; });
        if (btn.dataset.old && !confirm('Regenerate the join code? The old code stops working immediately.')) return;
        btn.disabled = true;
        try {
          var code = generateJoinCode();
          var exists = await db().collection('joinCodes').doc(code).get();
          if (exists.exists) code = generateJoinCode();
          await db().collection('joinCodes').doc(code).set({
            scheduleId: scheduleId, teacherUid: cls.ownerUid,
            active: true, createdAt: ts(), createdBy: firebridge.getUser().uid
          });
          if (btn.dataset.old) {
            await db().collection('joinCodes').doc(btn.dataset.old).update({ active: false });
          }
          await loadAndRender();
        } catch (e) { btn.disabled = false; setStatus('Code failed: ' + e.message, 'err'); }
      });
    });
    el.querySelectorAll('[data-disable-code]').forEach(function (btn) {
      btn.addEventListener('click', async function () {
        if (!confirm('Disable this join code?')) return;
        try {
          await db().collection('joinCodes').doc(btn.dataset.disableCode).update({ active: false });
          await loadAndRender();
        } catch (e) { setStatus('Disable failed: ' + e.message, 'err'); }
      });
    });
    el.querySelectorAll('[data-delete-class]').forEach(function (btn) {
      btn.addEventListener('click', async function () {
        var scheduleId = btn.closest('.tcadm-class-block').dataset.schedule;
        if (!confirm('Delete class "' + scheduleId + '"? Students lose access immediately. Enrollment records are kept for audit.')) return;
        try {
          var batch = db().batch();
          batch.delete(db().collection('schedules').doc(scheduleId));
          joinCodes.filter(function (j) { return j.scheduleId === scheduleId && j.active; })
            .forEach(function (j) {
              batch.update(db().collection('joinCodes').doc(j.code), { active: false });
            });
          await batch.commit();
          await loadAndRender();
        } catch (e) { setStatus('Delete failed: ' + e.message, 'err'); }
      });
    });
  }

  function openEditFoldersModal(cls) {
    var folderKeys = Object.keys(manifest || {});
    var overlay = document.createElement('div');
    overlay.className = 'tcadm-modal-overlay';
    overlay.innerHTML =
      '<div class="tcadm-modal">' +
        '<h3>Granted modules — ' + escHtml(cls.title || cls.id) + '</h3>' +
        folderKeys.map(function (k) {
          var checked = (cls.grantedFolders || []).indexOf(k) >= 0 ? ' checked' : '';
          return '<label class="tcadm-folder-check"><input type="checkbox" value="' + escHtml(k) + '"' + checked + '> ' +
                 escHtml(manifest[k].label || k) + '</label>';
        }).join('') +
        '<p style="font-size:11.5px;color:#6b7280;">Saving rebuilds the class module list from the manifest (order + published reset).</p>' +
        '<div class="tcadm-modal-actions">' +
          '<button class="btn" id="tcam-cancel">Cancel</button>' +
          '<button class="btn btn-primary" id="tcam-save">Save</button>' +
        '</div>' +
      '</div>';
    document.body.appendChild(overlay);
    overlay.addEventListener('click', function (e) { if (e.target === overlay) overlay.remove(); });
    overlay.querySelector('#tcam-cancel').addEventListener('click', function () { overlay.remove(); });
    overlay.querySelector('#tcam-save').addEventListener('click', async function () {
      var granted = [].slice.call(overlay.querySelectorAll('input:checked')).map(function (i) { return i.value; });
      if (!granted.length) { alert('Grant at least one module set.'); return; }
      this.disabled = true;
      try {
        await db().collection('schedules').doc(cls.id).update({
          grantedFolders: granted, modules: buildModules(granted), updatedAt: ts()
        });
        overlay.remove();
        await loadAndRender();
      } catch (e) { this.disabled = false; alert('Save failed: ' + e.message); }
    });
  }

  /* ================================================================
     TAB 3 — FEATURED PROFILES
     ================================================================ */
  function renderProfiles() {
    var el = document.getElementById('tcadm-profiles-list');
    if (!el) return;
    if (!profiles.length) {
      el.innerHTML = '<div class="tcadm-empty">No teacher profiles submitted yet.</div>';
      return;
    }
    el.innerHTML = profiles.map(function (p) {
      return '<div class="tcadm-row" data-uid="' + escHtml(p.id) + '">' +
        '<div class="tcadm-profile-preview">' +
          (p.photo && p.photo.medium
            ? '<img src="' + escHtml(p.photo.medium) + '" alt="">'
            : '<div class="ph">' + escHtml((p.name || '?')[0]) + '</div>') +
          '<div class="nm">' + escHtml(p.name || '') + '</div>' +
          '<div class="sc">' + escHtml(p.school || '') + (p.subjectArea ? ' · ' + escHtml(p.subjectArea) : '') + '</div>' +
          (p.blurb ? '<div class="bl">' + escHtml(p.blurb) + '</div>' : '') +
        '</div>' +
        '<div class="tcadm-row-main">' +
          '<div class="tcadm-name">' + chip(p.status || 'draft') + '</div>' +
          '<div class="tcadm-sub">Updated ' + fmtDate(p.updatedAt) +
            (p.approvedAt ? ' · approved ' + fmtDate(p.approvedAt) : '') + '</div>' +
        '</div>' +
        '<div class="tcadm-row-actions">' +
          (p.status !== 'approved' ? '<button class="btn btn-primary btn-sm" data-approve-profile>Approve</button>' : '') +
          (p.status === 'approved' ? '<button class="btn btn-sm" data-hide-profile>Hide</button>' : '') +
        '</div>' +
      '</div>';
    }).join('');

    el.querySelectorAll('[data-approve-profile]').forEach(function (btn) {
      btn.addEventListener('click', async function () {
        var uid = btn.closest('.tcadm-row').dataset.uid;
        try {
          await db().collection('teacherProfiles').doc(uid).update({
            status: 'approved', approvedAt: ts(), approvedBy: firebridge.getUser().uid
          });
          await loadAndRender();
        } catch (e) { setStatus('Approve failed: ' + e.message, 'err'); }
      });
    });
    el.querySelectorAll('[data-hide-profile]').forEach(function (btn) {
      btn.addEventListener('click', async function () {
        var uid = btn.closest('.tcadm-row').dataset.uid;
        try {
          await db().collection('teacherProfiles').doc(uid).update({ status: 'hidden' });
          await loadAndRender();
        } catch (e) { setStatus('Hide failed: ' + e.message, 'err'); }
      });
    });
  }

  /* ================================================================
     TAB 4 — REVIEWS
     ================================================================ */
  function renderReviews() {
    var filtersEl = document.getElementById('tcadm-review-filters');
    var el = document.getElementById('tcadm-reviews-list');
    if (!el || !filtersEl) return;

    var FILTERS = ['all', 'pending', 'approved', 'rejected', 'featured'];
    filtersEl.innerHTML = FILTERS.map(function (f) {
      var count = f === 'all' ? reviews.length
        : f === 'featured' ? reviews.filter(function (r) { return r.featured; }).length
        : reviews.filter(function (r) { return r.status === f; }).length;
      return '<button class="tcadm-filter-btn' + (reviewFilter === f ? ' on' : '') + '" data-filter="' + f + '">' +
        f + ' (' + count + ')</button>';
    }).join('');
    filtersEl.querySelectorAll('[data-filter]').forEach(function (btn) {
      btn.addEventListener('click', function () { reviewFilter = btn.dataset.filter; renderReviews(); });
    });

    var rows = reviews.filter(function (r) {
      if (reviewFilter === 'all') return true;
      if (reviewFilter === 'featured') return !!r.featured;
      return r.status === reviewFilter;
    });
    if (!rows.length) {
      el.innerHTML = '<div class="tcadm-empty">No reviews' + (reviewFilter !== 'all' ? ' in "' + reviewFilter + '"' : '') + '.</div>';
      return;
    }
    el.innerHTML = rows.map(function (r) {
      var cls = classes.find(function (c) { return c.id === r.scheduleId; });
      return '<div class="tcadm-row" data-id="' + escHtml(r.id) + '">' +
        '<div class="tcadm-row-main">' +
          '<div class="tcadm-name">' + chip(r.status) +
            (r.featured ? ' <span class="tcadm-chip featured">featured</span>' : '') +
            ' ' + stars(r.rating) + ' ' + escHtml(r.authorName || 'Anonymous') +
            ' <span class="tcadm-chip">' + escHtml(r.authorRole || '') + '</span></div>' +
          '<div class="tcadm-sub">' + escHtml(cls ? (cls.title || r.scheduleId) : (r.scheduleId || '')) +
            (r.school ? ' · ' + escHtml(r.school) : '') + ' · ' + fmtDate(r.createdAt) +
            (r.moderatedAt ? ' · moderated ' + fmtDate(r.moderatedAt) : '') + '</div>' +
          '<div class="tcadm-review-text">&ldquo;' + escHtml(r.text || '') + '&rdquo;</div>' +
        '</div>' +
        '<div class="tcadm-row-actions">' +
          (r.status !== 'approved' ? '<button class="btn btn-primary btn-sm" data-rv="approved">Approve</button>' : '') +
          (r.status !== 'rejected' ? '<button class="btn btn-sm" data-rv="rejected">Reject</button>' : '') +
          (r.status === 'approved'
            ? '<button class="btn btn-sm" data-feature>' + (r.featured ? 'Unfeature' : 'Feature') + '</button>'
            : '') +
          '<button class="btn btn-sm" data-rv-delete style="color:#dc2626;">Delete</button>' +
        '</div>' +
      '</div>';
    }).join('');

    el.querySelectorAll('[data-rv]').forEach(function (btn) {
      btn.addEventListener('click', async function () {
        var id = btn.closest('.tcadm-row').dataset.id;
        var patch = { status: btn.dataset.rv, moderatedAt: ts(), moderatedBy: firebridge.getUser().uid };
        if (btn.dataset.rv === 'rejected') patch.featured = false;
        try {
          await db().collection('reviews').doc(id).update(patch);
          await loadAndRender();
        } catch (e) { setStatus('Update failed: ' + e.message, 'err'); }
      });
    });
    el.querySelectorAll('[data-feature]').forEach(function (btn) {
      btn.addEventListener('click', async function () {
        var id = btn.closest('.tcadm-row').dataset.id;
        var r = reviews.find(function (x) { return x.id === id; });
        try {
          await db().collection('reviews').doc(id).update({ featured: !r.featured });
          await loadAndRender();
        } catch (e) { setStatus('Update failed: ' + e.message, 'err'); }
      });
    });
    el.querySelectorAll('[data-rv-delete]').forEach(function (btn) {
      btn.addEventListener('click', async function () {
        if (!confirm('Permanently delete this review?')) return;
        var id = btn.closest('.tcadm-row').dataset.id;
        try {
          await db().collection('reviews').doc(id).delete();
          await loadAndRender();
        } catch (e) { setStatus('Delete failed: ' + e.message, 'err'); }
      });
    });
  }

  document.addEventListener('DOMContentLoaded', boot);
})();
