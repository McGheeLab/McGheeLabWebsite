/* admin-teachers.js — V3.304 external-teacher oversight.
 *
 * Six tabs (?tab=requests|teachers|catalog|engage|profiles|reviews on the URL):
 *   1. Class Requests — pending queue on top. Approve opens a modal
 *      (class title, doc id, granted-folder checkboxes prefilled from the
 *      request) and commits one batch: schedules/{tc-…} (kind:'teacher-class',
 *      modules[] expanded from /modules/manifest.json), joinCodes/{CODE},
 *      the request's status flip, and users/{teacherUid}.category:'teacher'.
 *      Also carries the V3.680 admin-issued teacher invite links.
 *   2. Teachers & Classes — every category:'teacher' user joined client-side
 *      with their schedules, join codes, and enrollment rosters. Edit granted
 *      folders, regenerate/disable codes, remove students, delete class.
 *   3. Module Catalog (V3.669, reworked V3.770) — teacherCatalog/*: tick which
 *      modules teachers may assign, open any module in a new tab to check it,
 *      and author the subjects / grades / description teachers choose by.
 *   4. Engagement Hub (V3.673) — listings, availability slots, visit requests.
 *   5. Featured Profiles — teacherProfiles moderation (approve / hide).
 *   6. Reviews — ALL reviews, every status; approve / reject / feature / delete.
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
  var catalog = [];         // teacherCatalog/* (V3.669 — global module catalog)
  var assignments = [];     // assignments/* (V3.671 — read-only summary)
  var submissions = [];     // submissions/* (V3.671 — read-only summary)
  var invites = [];         // teacherInvites/* (V3.680 — admin-issued setup links)
  var engageProfiles = [];  // engageProfiles/* (V3.673 — hub oversight)
  var engageOpps = [];      // engageOpportunities/* (V3.791 — replaced engageSlots)
  var engageRequests = [];  // engageRequests/*
  var engagePresenters = []; // engagePresenters/* (V3.785 — who signed up via #/presenters)
  var engageReviews = [];   // engageReviews/*    (V3.787 — presenters' visit reviews)
  var guestPosts = [];      // engageGuestPosts/* (V3.808 — visits posted with NO account)
  var guestDeclining = null; // V3.808 — the guest post whose inline decline note is open
  var GUEST_LINK_BASE = 'https://mcgheelab.com/#/invite-a-scientist/';
  var GUEST_FORM_LINK = 'https://mcgheelab.com/#/invite-a-scientist';
  var PRESENTER_LINK = 'https://mcgheelab.com/#/presenters';
  var manifest = null;      // /modules/manifest.json .folders
  var manifestFailed = false;   // V3.637 — true when the catalog can't be read
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
    wireCatalogBar();
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
    renderInvites();
    renderTeachers();
    renderCatalog();
    renderEngage();
    renderProfiles();
    renderReviews();
    setStatus(manifestFailed
      ? 'Module catalog unavailable — approving and re-granting are disabled on this device.'
      : '', manifestFailed ? 'err' : '');
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
      db().collection('teacherCatalog').get().then(function (s) {
        catalog = s.docs.map(function (d) { return Object.assign({ id: d.id }, d.data()); });
      }),
      db().collection('assignments').get().then(function (s) {
        assignments = s.docs.map(function (d) { return Object.assign({ id: d.id }, d.data()); });
      }),
      db().collection('submissions').get().then(function (s) {
        submissions = s.docs.map(function (d) { return Object.assign({ id: d.id }, d.data()); });
      }),
      db().collection('teacherInvites').get().then(function (s) {
        invites = s.docs.map(function (d) { return Object.assign({ token: d.id }, d.data()); });
        var rank = { pending: 0, redeemed: 1, revoked: 2 };
        invites.sort(function (a, b) {
          var r = (rank[a.status] != null ? rank[a.status] : 3) - (rank[b.status] != null ? rank[b.status] : 3);
          if (r !== 0) return r;
          return (b.createdAt && b.createdAt.toMillis ? b.createdAt.toMillis() : 0) -
                 (a.createdAt && a.createdAt.toMillis ? a.createdAt.toMillis() : 0);
        });
      }),
      db().collection('engageProfiles').get().then(function (s) {
        engageProfiles = s.docs.map(function (d) { return Object.assign({ id: d.id }, d.data()); });
        var rank = { pending: 0, approved: 1, draft: 2 };
        engageProfiles.sort(function (a, b) {
          return (rank[a.status] != null ? rank[a.status] : 3) - (rank[b.status] != null ? rank[b.status] : 3);
        });
      }),
      db().collection('engageOpportunities').get().then(function (s) {
        engageOpps = s.docs.map(function (d) { return Object.assign({ id: d.id }, d.data()); });
      }).catch(function () { engageOpps = []; }),
      db().collection('engagePresenters').get().then(function (s) {
        engagePresenters = s.docs.map(function (d) { return Object.assign({ id: d.id }, d.data()); });
        engagePresenters.sort(function (a, b) { return String(a.name || '').localeCompare(String(b.name || '')); });
      }).catch(function () { engagePresenters = []; }),
      db().collection('engageReviews').get().then(function (s) {
        engageReviews = s.docs.map(function (d) { return Object.assign({ id: d.id }, d.data()); });
        engageReviews.sort(function (a, b) { return String(b.visitDate || '').localeCompare(String(a.visitDate || '')); });
      }).catch(function () { engageReviews = []; }),
      db().collection('engageGuestPosts').get().then(function (s) {
        guestPosts = s.docs.map(function (d) { return Object.assign({ id: d.id }, d.data()); });
        var rank = { pending: 0, published: 1, declined: 2, withdrawn: 3 };
        guestPosts.sort(function (a, b) {
          var r = (rank[a.status] != null ? rank[a.status] : 4) - (rank[b.status] != null ? rank[b.status] : 4);
          if (r !== 0) return r;
          return (b.createdAt && b.createdAt.toMillis ? b.createdAt.toMillis() : 0) -
                 (a.createdAt && a.createdAt.toMillis ? a.createdAt.toMillis() : 0);
        });
      }).catch(function () { guestPosts = []; }),
      db().collection('engageRequests').get().then(function (s) {
        engageRequests = s.docs.map(function (d) { return Object.assign({ id: d.id }, d.data()); });
        var rank = { pending: 0, confirmed: 1, declined: 2, cancelled: 3 };
        engageRequests.sort(function (a, b) {
          var r = (rank[a.status] != null ? rank[a.status] : 4) - (rank[b.status] != null ? rank[b.status] : 4);
          return r !== 0 ? r : String(a.date || '').localeCompare(String(b.date || ''));
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
      // V3.637 — this is an absolute site-root path, which resolves on
      // mcgheelab.com but 404'd inside the Ourlab app until sync-rm.mjs
      // started bundling modules/manifest.json. The failure used to be
      // swallowed into an empty catalog, and an empty catalog renders an
      // approve modal with ZERO module checkboxes that then refuses to
      // submit — a dead end with no explanation. Now it is recorded and
      // surfaced (see approveBlockedReason).
      jobs.push(fetch('/modules/manifest.json')
        .then(function (r) { return r.ok ? r.json() : Promise.reject(new Error('HTTP ' + r.status)); })
        .then(function (j) {
          manifest = j.folders || {};
          manifestFailed = !Object.keys(manifest).length;
        })
        .catch(function (e) {
          console.warn('[admin-teachers] module catalog unavailable:', e);
          manifest = {}; manifestFailed = true;
        }));
    }
    await Promise.all(jobs);
  }

  // V3.773 — provisioning no longer builds a module list, so an unavailable
  // manifest cannot ruin a class: approving and inviting work regardless. The
  // only surface that still needs the manifest is the legacy folder-grant
  // modal, which is what this now guards.
  function approveBlockedReason() {
    if (!manifestFailed) return null;
    return 'The module manifest (/modules/manifest.json) could not be loaded on this device, ' +
           'so the legacy folder list cannot be shown. This is expected in an older Ourlab app ' +
           'build — open mcgheelab.com/rm/pages/admin-teachers.html in a browser instead. ' +
           '(Approving a class and issuing invites are unaffected: classes start empty and the ' +
           'teacher picks their own lessons.)';
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
    // V3.773 — a new class starts EMPTY. Module access flows from the global
    // teacherCatalog and the teacher chooses on #/teach → Modules, so
    // provisioning no longer pre-fills `modules[]` from folder grants: a
    // pre-filled list is 36 lessons the teacher never chose, sitting on their
    // students' class page. The folder checkboxes went with the pre-fill.
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
        '<p style="font-size:11.5px;color:#6b7280;line-height:1.5;margin:10px 0 0;">' +
          'The class is created <strong>empty</strong>. The teacher chooses lessons from the ' +
          'published catalog on their own dashboard (Modules tab), and those are what their ' +
          'students see.' +
          ((req.requestedFolders || []).length
            ? '<br>They asked about: ' + escHtml((req.requestedFolders || []).join(', '))
            : '') +
        '</p>' +
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
      if (!title || !scheduleId) { setStatus('Title and id are required.', 'err'); return; }
      if (!/^[a-z0-9-]+$/.test(scheduleId)) { setStatus('Id must be lowercase letters, digits, and dashes.', 'err'); return; }
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
          // V3.669 — grantedFolders is legacy (module access now flows from
          // the global teacherCatalog); new classes carry an empty pin.
          grantedFolders: [],
          // V3.773 — and an empty class. The teacher fills it from the library.
          modules: [],
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
        setStatus('Approve failed: ' + e.message, 'err');
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
     V3.669 — GLOBAL MODULE CATALOG (teacherCatalog/*)
     Doc id `${folder}--${basename}` matches schedules.modules[].id.
     ================================================================ */
  function catalogModuleId(folder, fileName) {
    return folder + '--' + String(fileName).replace(/\.html$/, '');
  }
  function catalogEntry(folder, fileName) {
    var id = catalogModuleId(folder, fileName);
    return catalog.find(function (c) { return c.id === id; }) || null;
  }
  function catalogCountForFolder(k) {
    var files = (manifest && manifest[k] && manifest[k].files) || [];
    if (!catalog.length) return files.length + ' modules';
    var pub = files.filter(function (f) {
      var c = catalogEntry(k, f.name);
      return c && c.published;
    }).length;
    return pub + ' of ' + files.length + ' available';
  }

  // Pre-fill for a newly approved class: published catalog modules in the
  // picked folders. While the catalog is still empty (not yet curated), fall
  // back to the full manifest expansion so approval behaves like V3.304.
  function buildModulesFromCatalog(folders) {
    if (!folders.length) return [];
    if (!catalog.length) return buildModules(folders);
    var out = [], order = 0;
    folders.forEach(function (folder) {
      var files = (manifest[folder] && manifest[folder].files) || [];
      files.forEach(function (f) {
        var c = catalogEntry(folder, f.name);
        if (!c || !c.published) return;
        out.push({
          id: c.id, folder: folder, htmlFile: f.name,
          title: c.title || f.title || f.name,
          order: order++, published: true
        });
      });
    });
    return out;
  }

  /* V3.770 — the catalog is 69 modules across 12 folders, so picking which
   * ones teachers may assign needs three things the first cut lacked: the
   * tick is the row's primary control (not a checkbox wedged between three
   * text inputs), every module carries a link that opens the real lesson,
   * and the list can be filtered/searched/collapsed. Metadata moved onto a
   * second line behind ✎ Details — it is authored once, the tick is used
   * constantly. Field name stays `published`; the label says "Available"
   * because that is what it does. */
  var catFilter = 'all';        // all | on | off
  var catSearch = '';
  var catShut = {};             // folder key → true when collapsed

  function moduleHref(folder, fileName) {
    return '/modules/' + encodeURIComponent(folder) + '/' + encodeURIComponent(fileName);
  }
  function folderCounts(k) {
    var files = (manifest && manifest[k] && manifest[k].files) || [];
    return {
      total: files.length,
      pub: files.filter(function (f) { var c = catalogEntry(k, f.name); return c && c.published; }).length
    };
  }
  function catRowMatches(folder, f) {
    var c = catalogEntry(folder, f.name);
    var pub = !!(c && c.published);
    if (catFilter === 'on' && !pub) return false;
    if (catFilter === 'off' && pub) return false;
    if (!catSearch) return true;
    var hay = [
      folder, (manifest[folder] || {}).label || '', f.name,
      (c && c.title) || f.title || '',
      ((c && c.subjects) || []).join(' '), ((c && c.gradeLevels) || []).join(' '),
      (c && c.description) || ''
    ].join(' ').toLowerCase();
    return hay.indexOf(catSearch) !== -1;
  }
  // Counts are repainted in place after a tick so the list doesn't rebuild
  // (and jump) under the cursor while curating. The filter is applied at
  // render time only, so a row that stops matching stays put until the next
  // render — deliberate: rows vanishing mid-click would be worse.
  function updateCatCounts() {
    var totalPub = 0, total = 0;
    Object.keys(manifest || {}).forEach(function (k) {
      var n = folderCounts(k); totalPub += n.pub; total += n.total;
    });
    document.querySelectorAll('.tcadm-cat-folder').forEach(function (sec) {
      var n = folderCounts(sec.dataset.folder);
      var cnt = sec.querySelector('.cnt');
      if (cnt) cnt.textContent = n.pub + ' of ' + n.total + ' available';
    });
    var sum = document.getElementById('tcadm-cat-summary');
    if (sum) {
      sum.innerHTML = manifestFailed ? 'Module manifest unavailable'
        : '<b>' + totalPub + '</b> of ' + total + ' modules available to teachers';
    }
  }

  function renderCatalog() {
    var el = document.getElementById('tcadm-catalog-list');
    if (!el) return;
    if (manifestFailed) {
      el.innerHTML = '<div class="tcadm-empty">Module manifest unavailable — open this page in a browser at mcgheelab.com to curate the catalog.</div>';
      updateCatCounts();
      return;
    }
    var folderKeys = Object.keys(manifest || {});
    if (!folderKeys.length) {
      el.innerHTML = '<div class="tcadm-empty">No modules in /modules/manifest.json.</div>';
      updateCatCounts();
      return;
    }
    var shown = 0;
    el.innerHTML = folderKeys.map(function (k) {
      var files = (manifest[k].files || []).filter(function (f) { return catRowMatches(k, f); });
      if (!files.length) return '';
      shown += files.length;
      var n = folderCounts(k);
      var shut = !!catShut[k];
      return '<div class="tcadm-cat-folder' + (shut ? ' shut' : '') + '" data-folder="' + escHtml(k) + '">' +
        '<div class="tcadm-cat-folder-head">' +
          '<span class="fold" data-fold title="Show or hide this folder">' +
            '<span class="caret">' + ICON.svg(shut ? 'chevron-right' : 'chevron-down') + '</span>' +
            '<span>' + escHtml(manifest[k].label || k) + '</span>' +
          '</span>' +
          '<span class="cnt">' + n.pub + ' of ' + n.total + ' available</span>' +
          '<span style="margin-left:auto;display:flex;gap:6px;">' +
            '<button class="btn btn-sm" data-folder-pub="1">Select all</button>' +
            '<button class="btn btn-sm" data-folder-pub="0">Clear all</button>' +
          '</span>' +
        '</div>' +
        files.map(function (f) {
          var c = catalogEntry(k, f.name) || {};
          var tags = (c.subjects || []).concat(c.gradeLevels || []).join(' · ');
          return '<div class="tcadm-cat-row' + (c.published ? ' on' : '') + '" data-file="' + escHtml(f.name) + '">' +
            '<label class="tcadm-cat-pick" title="Teachers can assign this module to their classes">' +
              '<input type="checkbox" data-cat-pub' + (c.published ? ' checked' : '') + '> Available' +
            '</label>' +
            '<span class="ttl">' + escHtml(c.title || f.title || f.name) +
              '<span class="fn">' + escHtml(f.name) + '</span></span>' +
            (tags ? '<span class="tags">' + escHtml(tags) + '</span>' : '') +
            '<a class="tcadm-cat-open" href="' + escHtml(moduleHref(k, f.name)) + '" target="_blank" rel="noopener"' +
              ' title="Open this module in a new tab — exactly what a student sees">↗ Open</a>' +
            '<button class="btn btn-sm" data-cat-edit>✎ Details</button>' +
            '<div class="tcadm-cat-details" hidden>' +
              '<input type="text" data-cat-subjects placeholder="subjects (comma-sep)" value="' + escHtml((c.subjects || []).join(', ')) + '">' +
              '<input type="text" data-cat-grades placeholder="grades (e.g. 9–12)" value="' + escHtml((c.gradeLevels || []).join(', ')) + '">' +
              '<input type="text" class="cat-desc" data-cat-desc placeholder="one-line description for teachers" value="' + escHtml(c.description || '') + '">' +
            '</div>' +
          '</div>';
        }).join('') +
      '</div>';
    }).join('');
    if (!shown) {
      el.innerHTML = '<div class="tcadm-empty">No modules match ' +
        (catSearch ? '“' + escHtml(catSearch) + '”' : 'this filter') + '.</div>';
    }
    updateCatCounts();

    function splitList(v) {
      return String(v || '').split(',').map(function (s) { return s.trim(); }).filter(Boolean);
    }
    async function saveRow(folder, fileName, patch, note) {
      var f = (manifest[folder].files || []).find(function (x) { return x.name === fileName; }) || {};
      var id = catalogModuleId(folder, fileName);
      var base = {
        folder: folder, file: fileName,
        title: (catalogEntry(folder, fileName) || {}).title || f.title || fileName,
        updatedAt: ts(), updatedBy: firebridge.getUser().uid
      };
      try {
        await db().collection('teacherCatalog').doc(id).set(Object.assign(base, patch), { merge: true });
        var local = catalog.find(function (c) { return c.id === id; });
        if (local) Object.assign(local, patch);
        else catalog.push(Object.assign({ id: id, published: false, subjects: [], gradeLevels: [] }, base, patch));
        setStatus(note || 'Catalog saved.', 'ok');
        return true;
      } catch (e) { setStatus('Catalog save failed: ' + e.message, 'err'); return false; }
    }

    el.querySelectorAll('.tcadm-cat-row').forEach(function (row) {
      var folder = row.closest('.tcadm-cat-folder').dataset.folder;
      var fileName = row.dataset.file;
      var title = (row.querySelector('.ttl') || {}).firstChild;
      title = (title && title.textContent || fileName).trim();
      row.querySelector('[data-cat-pub]').addEventListener('change', async function () {
        var want = this.checked;
        var box = this;
        row.classList.toggle('on', want);
        var ok = await saveRow(folder, fileName, { published: want },
          '“' + title + '” is ' + (want ? 'now in every teacher’s picker.' : 'no longer offered to teachers.'));
        if (!ok) { box.checked = !want; row.classList.toggle('on', !want); }   // save failed — don't lie about the state
        updateCatCounts();
      });
      var det = row.querySelector('.tcadm-cat-details');
      row.querySelector('[data-cat-edit]').addEventListener('click', function () {
        det.hidden = !det.hidden;
        this.classList.toggle('btn-primary', !det.hidden);
        if (!det.hidden) det.querySelector('input').focus();
      });
      row.querySelector('[data-cat-subjects]').addEventListener('change', function () {
        saveRow(folder, fileName, { subjects: splitList(this.value) });
      });
      row.querySelector('[data-cat-grades]').addEventListener('change', function () {
        saveRow(folder, fileName, { gradeLevels: splitList(this.value) });
      });
      row.querySelector('[data-cat-desc]').addEventListener('change', function () {
        saveRow(folder, fileName, { description: this.value.trim() });
      });
    });
    el.querySelectorAll('[data-fold]').forEach(function (h) {
      h.addEventListener('click', function () {
        var sec = h.closest('.tcadm-cat-folder');
        var shut = !sec.classList.contains('shut');
        sec.classList.toggle('shut', shut);
        catShut[sec.dataset.folder] = shut;
        ICON.label(h.querySelector('.caret'), shut ? 'chevron-right' : 'chevron-down');
      });
    });
    el.querySelectorAll('[data-folder-pub]').forEach(function (btn) {
      btn.addEventListener('click', async function () {
        var folder = btn.closest('.tcadm-cat-folder').dataset.folder;
        var pub = btn.dataset.folderPub === '1';
        btn.disabled = true;
        try {
          var batch = db().batch();
          var uid = firebridge.getUser().uid;
          var rows = [];
          (manifest[folder].files || []).forEach(function (f) {
            var id = catalogModuleId(folder, f.name);
            var c = catalogEntry(folder, f.name) || {};
            var doc = {
              folder: folder, file: f.name,
              title: c.title || f.title || f.name,
              published: pub, updatedAt: ts(), updatedBy: uid
            };
            rows.push({ id: id, doc: doc });
            batch.set(db().collection('teacherCatalog').doc(id), doc, { merge: true });
          });
          await batch.commit();
          // Patch the local catalog rather than re-reading all fourteen
          // collections — the batch we just committed IS the new truth.
          rows.forEach(function (r) {
            var local = catalog.find(function (c) { return c.id === r.id; });
            if (local) Object.assign(local, { published: pub, title: r.doc.title });
            else catalog.push(Object.assign({ id: r.id, subjects: [], gradeLevels: [] }, r.doc));
          });
          renderCatalog();
          setStatus((manifest[folder].label || folder) + ' — all ' + rows.length + ' modules ' +
            (pub ? 'are now available to teachers.' : 'removed from the teacher picker.'), 'ok');
        } catch (e) { btn.disabled = false; setStatus('Bulk update failed: ' + e.message, 'err'); }
      });
    });
  }

  // The filter/search/collapse controls are static markup in the page, wired
  // ONCE: re-rendering them would blow away focus and the half-typed query
  // on every keystroke.
  function wireCatalogBar() {
    var filters = document.getElementById('tcadm-cat-filters');
    if (filters) {
      filters.addEventListener('click', function (e) {
        var btn = e.target.closest('[data-cat-filter]');
        if (!btn) return;
        catFilter = btn.dataset.catFilter;
        filters.querySelectorAll('[data-cat-filter]').forEach(function (b) {
          b.classList.toggle('on', b === btn);
        });
        renderCatalog();
      });
    }
    var search = document.getElementById('tcadm-cat-search');
    if (search) {
      var t = null;
      search.addEventListener('input', function () {
        clearTimeout(t);
        var v = search.value.trim().toLowerCase();
        t = setTimeout(function () { catSearch = v; renderCatalog(); }, 150);
      });
    }
    var fold = document.getElementById('tcadm-cat-fold');
    if (fold) {
      fold.addEventListener('click', function () {
        var shutAll = fold.dataset.state !== 'shut';
        Object.keys(manifest || {}).forEach(function (k) { catShut[k] = shutAll; });
        fold.dataset.state = shutAll ? 'shut' : 'open';
        fold.textContent = shutAll ? 'Expand all' : 'Collapse all';
        renderCatalog();
      });
    }
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
            (function () { // V3.671 — read-only assignment/submission summary
              var asg = assignments.filter(function (a) { return a.scheduleId === c.id; });
              if (!asg.length) return '';
              var subs = submissions.filter(function (s) { return s.scheduleId === c.id; });
              var graded = subs.filter(function (s) { return s.grade; }).length;
              return ' · ' + asg.length + ' assignment' + (asg.length === 1 ? '' : 's') +
                     ' · ' + subs.length + ' submission' + (subs.length === 1 ? '' : 's') +
                     (subs.length ? ' (' + graded + ' graded)' : '');
            })() +
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
          // V3.635 — `removedBy` marks this as a teacher/admin removal, which
          // the enrollment rule reads to stop the student re-activating
          // themselves with the join code they already hold.
          await db().collection('enrollments').doc(btn.dataset.removeStudent)
            .update({ status: 'removed', removedBy: 'teacher', updatedAt: ts() });
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
    var blocked = approveBlockedReason();
    if (blocked) { alert(blocked); setStatus('Module catalog unavailable', 'err'); return; }
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
        // V3.773 — this legacy folder grant no longer rewrites `modules[]`.
        // It used to overwrite whatever the teacher had curated on #/teach
        // with a folder expansion, silently replacing their class.
        await db().collection('schedules').doc(cls.id).update({
          grantedFolders: granted, updatedAt: ts()
        });
        overlay.remove();
        await loadAndRender();
      } catch (e) { this.disabled = false; alert('Save failed: ' + e.message); }
    });
  }

  /* ================================================================
     V3.680 — TEACHER INVITES (top of ?tab=requests)
     Admin issues a setup link; the teacher signs in at
     /#/teachers?invite=TOKEN and redeemTeacherInvite provisions the
     class + join code + category:'teacher' — no approval round-trip.
     ================================================================ */
  function makeInviteToken() {
    var buf = new Uint8Array(18);
    crypto.getRandomValues(buf);
    var s = '';
    for (var i = 0; i < buf.length; i++) s += 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789'[buf[i] % 62];
    return s;
  }
  function inviteLink(token) {
    return 'https://mcgheelab.com/#/teachers?invite=' + token;
  }

  function renderInvites() {
    var listEl = document.getElementById('tcadm-invites-list');
    var formWrap = document.getElementById('tcadm-invite-form-wrap');
    var newBtn = document.getElementById('tcadm-invite-new');
    if (!listEl || !formWrap || !newBtn) return;

    listEl.innerHTML = invites.length ? invites.map(function (inv) {
      var expired = inv.status === 'pending' && inv.expiresAt &&
        inv.expiresAt.toMillis && inv.expiresAt.toMillis() < Date.now();
      var teacher = inv.redeemedBy ? teachers.find(function (t) { return t.uid === inv.redeemedBy; }) : null;
      return '<div class="tcadm-row" data-token="' + escHtml(inv.token) + '">' +
        '<div class="tcadm-row-main">' +
          '<div class="tcadm-name">' + chip(expired ? 'expired' : inv.status) + ' ' +
            escHtml(inv.teacherName || inv.email || '(open link)') +
            ' <span class="tcadm-sub">' + escHtml(inv.school || '') + '</span></div>' +
          '<div class="tcadm-sub">' + escHtml(inv.classTitle || '') +
            (inv.email ? ' · locked to ' + escHtml(inv.email) : ' · anyone with the link can redeem') +
            ' · created ' + fmtDate(inv.createdAt) +
            (inv.expiresAt ? ' · expires ' + fmtDate(inv.expiresAt) : '') + '</div>' +
          (inv.status === 'redeemed'
            ? '<div class="tcadm-sub">Redeemed ' + fmtDate(inv.redeemedAt) +
              (teacher ? ' by ' + escHtml(teacher.name || teacher.email || inv.redeemedBy) : '') +
              (inv.scheduleId ? ' · class <code>' + escHtml(inv.scheduleId) + '</code>' : '') + '</div>'
            : '') +
        '</div>' +
        '<div class="tcadm-row-actions">' +
          (inv.status === 'pending'
            ? '<button class="btn btn-sm" data-inv-copy="' + escHtml(inviteLink(inv.token)) + '">Copy link</button>' +
              '<a class="btn btn-sm" href="mailto:' + escHtml(inv.email || '') +
                '?subject=' + encodeURIComponent('Your McGhee Lab class is ready to set up') +
                '&body=' + encodeURIComponent(
                  'Hi' + (inv.teacherName ? ' ' + inv.teacherName : '') + ',\n\n' +
                  'We set aside a class for you on the McGhee Lab site. Open this link, ' +
                  'sign in with Google, and your class page + student join code are created ' +
                  'automatically:\n\n' + inviteLink(inv.token) + '\n\n— The McGhee Lab') +
                '">' + ICON.svg('envelope') + ' Compose email</a>' +
              '<button class="btn btn-sm" data-inv-revoke style="color:#dc2626;">Revoke</button>'
            : '') +
        '</div>' +
      '</div>';
    }).join('') : '<div class="tcadm-empty">No invites yet — “' + ICON.svg('envelope') + ' New invite…” creates a setup link you can email a teacher.</div>';

    if (!newBtn.dataset.wired) {
      newBtn.dataset.wired = '1';
      newBtn.addEventListener('click', function () {
        formWrap.style.display = formWrap.style.display === 'none' ? '' : 'none';
        if (formWrap.style.display !== 'none' && !formWrap.innerHTML) renderInviteForm(formWrap);
      });
    }

    listEl.querySelectorAll('[data-inv-copy]').forEach(function (btn) {
      btn.addEventListener('click', function () {
        navigator.clipboard && navigator.clipboard.writeText(btn.dataset.invCopy);
        var old = btn.textContent;
        btn.textContent = 'Copied!';
        setTimeout(function () { btn.textContent = old; }, 1500);
      });
    });
    listEl.querySelectorAll('[data-inv-revoke]').forEach(function (btn) {
      btn.addEventListener('click', async function () {
        // Two-step inline confirm — no window.confirm (project rule).
        if (!btn.dataset.armed) {
          btn.dataset.armed = '1';
          btn.textContent = 'Revoke — sure?';
          setTimeout(function () { delete btn.dataset.armed; btn.textContent = 'Revoke'; }, 5000);
          return;
        }
        try {
          await db().collection('teacherInvites')
            .doc(btn.closest('.tcadm-row').dataset.token)
            .update({ status: 'revoked', updatedAt: ts() });
          await loadAndRender();
        } catch (e) { setStatus('Revoke failed: ' + e.message, 'err'); }
      });
    });
  }

  function renderInviteForm(wrap) {
    wrap.innerHTML =
      '<div class="teach-af-row" style="display:flex;gap:12px;flex-wrap:wrap;">' +
        '<label style="font-size:12px;">Teacher name<br><input type="text" id="tci-name" style="width:160px;"></label>' +
        '<label style="font-size:12px;">Email (optional — locks the invite to that Google account)<br><input type="email" id="tci-email" style="width:230px;"></label>' +
        '<label style="font-size:12px;">School<br><input type="text" id="tci-school" style="width:200px;"></label>' +
        '<label style="font-size:12px;">Class title<br><input type="text" id="tci-title" style="width:260px;"></label>' +
      '</div>' +
      '<p style="margin-top:8px;font-size:11.5px;color:#6b7280;line-height:1.5;">' +
        'The class is created empty — the teacher chooses their lessons from the published ' +
        'catalog on their own dashboard.</p>' +
      '<div style="margin-top:10px;display:flex;gap:8px;align-items:center;">' +
        '<button class="btn btn-primary btn-sm" id="tci-create">Create invite link</button>' +
        '<span style="font-size:11.5px;color:#6b7280;">Link expires in 30 days. Without an email, anyone holding the link can redeem it.</span>' +
      '</div>' +
      '<div id="tci-result" style="margin-top:8px;font-size:12px;"></div>';

    wrap.querySelector('#tci-create').addEventListener('click', async function () {
      var school = wrap.querySelector('#tci-school').value.trim();
      var result = wrap.querySelector('#tci-result');
      if (!school) { result.innerHTML = '<span style="color:#dc2626;">School is required.</span>'; return; }
      this.disabled = true;
      var token = makeInviteToken();
      try {
        await db().collection('teacherInvites').doc(token).set({
          teacherName: wrap.querySelector('#tci-name').value.trim(),
          email: wrap.querySelector('#tci-email').value.trim().toLowerCase() || null,
          school: school,
          classTitle: wrap.querySelector('#tci-title').value.trim() || (school + ' — McGhee Lab Modules'),
          prefillFolders: [],   // V3.773 — classes start empty; kept for shape only
          status: 'pending',
          createdBy: firebridge.getUser().uid,
          createdAt: ts(),
          expiresAt: firebase.firestore.Timestamp.fromDate(new Date(Date.now() + 30 * 86400000))
        });
        result.innerHTML = 'Invite created: <code>' + escHtml(inviteLink(token)) + '</code>';
        await loadAndRender();
      } catch (e) {
        this.disabled = false;
        result.innerHTML = '<span style="color:#dc2626;">Create failed: ' + escHtml(e.message) + '</span>';
      }
    });
  }

  /* ================================================================
     V3.673 — ENGAGEMENT HUB OVERSIGHT (?tab=engage)
     Approve listings, watch every slot, intervene on any request.
     ================================================================ */
  var ENGAGE_ACTIVITY = { 'guest-talk': 'Guest talk', 'demo': 'Demo', 'lab-tour': 'Lab tour', 'career-chat': 'Career chat' };

  function wireEngageLinkBar(el) {
    var btn = el.querySelector('[data-copy-presenter-link]');
    if (!btn) return;
    btn.addEventListener('click', function () {
      (navigator.clipboard ? navigator.clipboard.writeText(PRESENTER_LINK) : Promise.reject())
        .then(function () { btn.textContent = 'Copied'; setTimeout(function () { btn.textContent = 'Copy link'; }, 1500); })
        .catch(function () { setStatus('Copy failed — select the link above and copy it.', 'err'); });
    });
  }

  /* ================================================================
     V3.808 — VISIT POSTS WITHOUT AN ACCOUNT (engageGuestPosts/*)
     A teacher posts at mcgheelab.com/#/invite-a-scientist with no sign-in
     and manages it from a private link (its manageToken). Nothing goes
     live until it is published HERE: Publish writes a normal approved
     listing engageProfiles/guest_{id} (+ private/contact for the address)
     and a normal open engageOpportunities doc with teacherUid
     'guest_{id}', so presenters see and sign up for it like any other.
     The site can't email the teacher, so every row carries an
     "Email the teacher" mailto worded for where the post stands, and the
     new-sign-up push to admins (engage-notify.js) points back here.
     ================================================================ */
  function guestLink(g) { return GUEST_LINK_BASE + (g.manageToken || ''); }
  function guestOpp(g) { return g.opportunityId ? engageOpps.find(function (o) { return o.id === g.opportunityId; }) : null; }

  function guestMailto(g) {
    var t = g.teacher || {}, op = g.opportunity || {};
    var opp = guestOpp(g);
    var title = op.title || 'your visit post';
    var link = guestLink(g);
    var hi = 'Hi ' + (String(t.name || '').trim() || 'there') + ',';
    var sign = ['', 'Thank you!', 'The McGhee Lab, University of Arizona'];
    var pend = opp ? (opp.pendingCount || 0) : 0;
    var subject, lines;
    if (g.status === 'declined') {
      subject = 'About your visit post "' + title + '"';
      lines = [hi, '', 'Thank you for posting "' + title + '". We weren’t able to put it live this time.' +
        (g.labNote ? ' ' + g.labNote : ''), '', 'Reply to this email if you have questions, or post again at ' + GUEST_FORM_LINK + '.'];
    } else if (g.status === 'published' && pend) {
      subject = (pend === 1 ? 'A presenter signed up' : pend + ' presenters signed up') + ' for "' + title + '"';
      lines = [hi, '', (pend === 1 ? 'A presenter has' : pend + ' presenters have') + ' signed up for your classroom visit, "' + title + '".',
        '', 'Open your private page to see who they are and accept one:', link, '',
        'When you accept, the page writes your confirmation email to the presenter. Copy it and send it from your own email.'];
    } else if (g.status === 'published') {
      subject = 'Your visit post is live: "' + title + '"';
      lines = [hi, '', '"' + title + '" is now live, so presenters can see it and sign up. We’ll let you know when someone does.',
        '', 'Your private page (keep this link; there’s no account):', link];
    } else {
      subject = 'Your McGhee Lab visit post: "' + title + '"';
      lines = [hi, '', 'Thank you for posting "' + title + '". Here is the private link to it. Keep it; there’s no account or password:',
        link, '', 'We’ll review it shortly and let you know when it’s live.'];
    }
    return 'mailto:' + encodeURIComponent(t.email || '') + '?subject=' + encodeURIComponent(subject) +
      '&body=' + encodeURIComponent(lines.concat(sign).join('\n'));
  }

  function renderGuestPosts() {
    var head = '<div class="tcadm-cat-folder-head">Visit posts without an account (' + guestPosts.length + ')</div>' +
      '<div class="tcadm-row tcadm-linkbar">' +
        '<div class="tcadm-row-main"><div class="tcadm-name">Teacher link, no sign-in needed</div>' +
          '<div class="tcadm-sub">Share it with teachers. They post a visit and the dates that work; it waits here until you publish it.</div>' +
          '<div class="tcadm-sub"><code>' + escHtml(GUEST_FORM_LINK) + '</code></div></div>' +
        '<div class="tcadm-row-actions"><button class="btn btn-sm" data-copy-guest-form>Copy link</button>' +
          '<a class="btn btn-sm" href="' + escHtml(GUEST_FORM_LINK) + '" target="_blank" rel="noopener">Open</a></div>' +
      '</div>';
    if (!guestPosts.length) return head + '<div class="tcadm-empty">No posts yet.</div>';
    var today = new Date(); today = today.getFullYear() + '-' + ('0' + (today.getMonth() + 1)).slice(-2) + '-' + ('0' + today.getDate()).slice(-2);
    return head + guestPosts.map(function (g) {
      var t = g.teacher || {}, L = g.listing || {}, O = g.opportunity || {}, loc = g.location || {};
      var opp = guestOpp(g);
      var dates = (O.dates || []).slice().sort(function (a, b) { return String(a.date).localeCompare(String(b.date)); });
      var allPast = dates.length && dates.every(function (d) { return d.date < today; });
      var pend = opp ? (opp.pendingCount || 0) : 0;
      var declining = guestDeclining === g.id;
      return '<div class="tcadm-row" data-guest="' + escHtml(g.id) + '">' +
        '<div class="tcadm-row-main">' +
          '<div class="tcadm-name">' + chip(g.status || 'pending') + (opp ? ' ' + chip(opp.status || 'open') : '') +
            ' <strong>' + escHtml(O.title || '(untitled)') + '</strong>' +
            ' <span class="tcadm-sub">' + escHtml([L.school, L.city, L.state].filter(Boolean).join(', ')) + '</span></div>' +
          '<div class="tcadm-sub">' + escHtml(t.name || '') + ' · <a href="mailto:' + escHtml(t.email || '') + '">' + escHtml(t.email || '') + '</a>' +
            (t.phone ? ' · ' + escHtml(t.phone) : '') + '</div>' +
          '<div class="tcadm-sub">' + escHtml([L.subject, L.grade ? 'grade ' + L.grade : '', L.classSize ? L.classSize + ' students' : ''].filter(Boolean).join(' · ')) +
            ' — ' + escHtml((O.activityTypes || []).map(function (a) { return ENGAGE_ACTIVITY[a] || a; }).join(', ')) +
            ' · ' + escHtml((O.formats || []).join(', ')) +
            ((O.presentersWanted || 1) > 1 ? ' · up to ' + O.presentersWanted + ' presenters' : '') + '</div>' +
          (O.topic ? '<div class="tcadm-sub">Topic: ' + escHtml(O.topic) + '</div>' : '') +
          '<div class="tcadm-sub">' + dates.map(function (d) {
            return (d.date < today ? '<s>' : '') + escHtml(d.date + ' ' + (d.startTime || '') + '–' + (d.endTime || '')) +
              (opp && opp.bookedDate === d.date ? ' ✓' : '') + (d.date < today ? '</s>' : '');
          }).join(' · ') + (allPast ? ' <strong>— every date has passed</strong>' : '') + '</div>' +
          (loc.address ? '<div class="tcadm-sub">Where (private): ' + escHtml([loc.address, loc.room].filter(Boolean).join(' · ')) +
            (loc.arrivalNotes ? ' — ' + escHtml(loc.arrivalNotes) : '') + '</div>' : '') +
          (g.noteToLab ? '<div class="tcadm-msg">Note to the lab: ' + escHtml(g.noteToLab) + '</div>' : '') +
          (g.labNote ? '<div class="tcadm-msg">Your decline note: ' + escHtml(g.labNote) + '</div>' : '') +
          (opp ? '<div class="tcadm-sub">' + pend + ' sign-up' + (pend === 1 ? '' : 's') + ' waiting on the teacher · ' +
            (opp.acceptedCount || 0) + ' accepted</div>' : '') +
          '<div class="tcadm-sub">Posted ' + fmtDate(g.createdAt) +
            (g.publishedAt ? ' · published ' + fmtDate(g.publishedAt) : '') +
            (g.lastViewedAt ? ' · teacher last opened their page ' + fmtDate(g.lastViewedAt) : ' · teacher hasn’t opened their page yet') + '</div>' +
          '<div class="tcadm-sub tcadm-guest-link">Teacher’s private page: <code>' + escHtml(guestLink(g)) + '</code></div>' +
          (declining ? '<div class="tcadm-guest-decline">' +
            '<input type="text" data-guest-decline-note maxlength="300" placeholder="Why, in a sentence (the teacher sees this)">' +
            '<button class="btn btn-sm" data-guest-decline-go style="color:#dc2626;">Decline post</button>' +
            '<button class="btn btn-sm" data-guest-decline-cancel>Cancel</button></div>' : '') +
        '</div>' +
        '<div class="tcadm-row-actions">' +
          (g.status === 'pending' ? '<button class="btn btn-primary btn-sm" data-guest-publish>Publish</button>' +
            (declining ? '' : '<button class="btn btn-sm" data-guest-decline>Decline…</button>') : '') +
          '<a class="btn btn-sm' + (pend ? ' btn-primary' : '') + '" href="' + escHtml(guestMailto(g)) + '">' +
            (g.status === 'published' && pend ? 'Tell the teacher (' + pend + ' sign-up' + (pend === 1 ? '' : 's') + ')' : 'Email the teacher') + '</a>' +
          '<button class="btn btn-sm" data-guest-copy>Copy their link</button>' +
          '<a class="btn btn-sm" href="' + escHtml(guestLink(g)) + '" target="_blank" rel="noopener">Open their page</a>' +
        '</div>' +
      '</div>';
    }).join('');
  }

  async function publishGuest(g) {
    var tUid = 'guest_' + g.id;
    var me = firebridge.getUser().uid;
    var t = g.teacher || {}, L = g.listing || {}, O = g.opportunity || {}, loc = g.location || {};
    var dates = (O.dates || []).slice().sort(function (a, b) { return String(a.date).localeCompare(String(b.date)); });
    var b = db().batch();
    b.set(db().collection('engageProfiles').doc(tUid), {
      teacherUid: tUid, guest: true, guestId: g.id, status: 'approved',
      displayName: t.name || '', school: L.school || '', schoolType: L.schoolType || '',
      city: [L.city, L.state].filter(Boolean).join(', '),
      gradeLevels: L.grade ? [L.grade] : [], subjects: L.subject ? [L.subject] : [],
      classSize: L.classSize || null, topics: [],
      activityTypes: O.activityTypes || [], formats: O.formats || [],
      approvedAt: ts(), approvedBy: me, updatedAt: ts()
    });
    b.set(db().collection('engageProfiles').doc(tUid).collection('private').doc('contact'), {
      address: loc.address || '', room: loc.room || '', phone: t.phone || '', arrivalNotes: loc.arrivalNotes || ''
    });
    var oppRef = db().collection('engageOpportunities').doc();
    b.set(oppRef, {
      teacherUid: tUid, guest: true, title: O.title || '',
      activityTypes: O.activityTypes || [], formats: O.formats || [], topic: O.topic || '',
      classContext: { subject: L.subject || '', grade: L.grade || '', size: L.classSize || '' },
      presentersWanted: O.presentersWanted || 1,
      dates: dates, dateKeys: dates.map(function (d) { return d.date; }),
      timezone: 'America/Phoenix', status: 'open', createdAt: ts(), updatedAt: ts()
    });
    b.update(db().collection('engageGuestPosts').doc(g.id), {
      status: 'published', opportunityId: oppRef.id, teacherUid: tUid,
      publishedAt: ts(), publishedBy: me, updatedAt: ts()
    });
    await b.commit();
  }

  function wireGuestPosts(el) {
    var formBtn = el.querySelector('[data-copy-guest-form]');
    formBtn && formBtn.addEventListener('click', function () {
      (navigator.clipboard ? navigator.clipboard.writeText(GUEST_FORM_LINK) : Promise.reject())
        .then(function () { formBtn.textContent = 'Copied'; setTimeout(function () { formBtn.textContent = 'Copy link'; }, 1500); })
        .catch(function () { setStatus('Copy failed — select the link above and copy it.', 'err'); });
    });
    el.querySelectorAll('[data-guest]').forEach(function (row) {
      var g = guestPosts.find(function (x) { return x.id === row.dataset.guest; });
      if (!g) return;
      var copy = row.querySelector('[data-guest-copy]');
      copy && copy.addEventListener('click', function () {
        (navigator.clipboard ? navigator.clipboard.writeText(guestLink(g)) : Promise.reject())
          .then(function () { copy.textContent = 'Copied'; setTimeout(function () { copy.textContent = 'Copy their link'; }, 1500); })
          .catch(function () { setStatus('Copy failed — select the link in the row and copy it.', 'err'); });
      });
      var pub = row.querySelector('[data-guest-publish]');
      pub && pub.addEventListener('click', async function () {
        pub.disabled = true;
        try {
          await publishGuest(g);
          // loadAndRender() ends by writing its own status line, so the
          // confirmation goes AFTER it or the admin never sees it.
          await loadAndRender();
          setStatus('Published. Presenters can see it now — use “Email the teacher” to tell them it’s live.', 'ok');
        } catch (e) { pub.disabled = false; setStatus('Publish failed: ' + e.message, 'err'); }
      });
      var dec = row.querySelector('[data-guest-decline]');
      dec && dec.addEventListener('click', function () {
        guestDeclining = g.id;
        renderEngage();
        var input = document.querySelector('[data-guest="' + g.id + '"] [data-guest-decline-note]');
        input && input.focus();
      });
      var cancel = row.querySelector('[data-guest-decline-cancel]');
      cancel && cancel.addEventListener('click', function () { guestDeclining = null; renderEngage(); });
      var go = row.querySelector('[data-guest-decline-go]');
      go && go.addEventListener('click', async function () {
        var note = String((row.querySelector('[data-guest-decline-note]') || {}).value || '').trim();
        go.disabled = true;
        try {
          await db().collection('engageGuestPosts').doc(g.id).update({
            status: 'declined', labNote: note, decidedAt: ts(), decidedBy: firebridge.getUser().uid, updatedAt: ts()
          });
          guestDeclining = null;
          await loadAndRender();
          setStatus('Declined. Use “Email the teacher” to let them know.', 'ok');
        } catch (e) { go.disabled = false; setStatus('Decline failed: ' + e.message, 'err'); }
      });
    });
  }

  function renderEngage() {
    var el = document.getElementById('tcadm-engage-list');
    if (!el) return;
    // V3.785 — the presenter page is linked from nowhere on the site; this
    // is where the link lives.
    var linkBar = '<div class="tcadm-row tcadm-linkbar">' +
      '<div class="tcadm-row-main"><div class="tcadm-name">Presenter sign-up link</div>' +
        '<div class="tcadm-sub">Share it with people who might visit a class. It isn\u2019t in any menu; anyone ' +
        'who opens it and signs in with Google can see openings and request a visit.</div>' +
        '<div class="tcadm-sub"><code>' + escHtml(PRESENTER_LINK) + '</code></div></div>' +
      '<div class="tcadm-row-actions"><button class="btn btn-primary btn-sm" data-copy-presenter-link>Copy link</button>' +
        '<a class="btn btn-sm" href="' + escHtml(PRESENTER_LINK) + '" target="_blank" rel="noopener">Open</a></div>' +
    '</div>';
    if (!engageProfiles.length && !engageRequests.length && !engagePresenters.length && !guestPosts.length) {
      el.innerHTML = linkBar + renderGuestPosts() + '<div class="tcadm-empty">Nothing on the engagement hub yet — teachers create listings from their teaching dashboard\u2019s Engagement tab, or post without an account at the link above.</div>';
      wireEngageLinkBar(el);
      wireGuestPosts(el);
      return;
    }

    var html = linkBar + renderGuestPosts();
    engageProfiles.forEach(function (pr) {
      var opps = engageOpps.filter(function (o) { return o.teacherUid === pr.id; });
      var reqs = engageRequests.filter(function (r) { return r.teacherUid === pr.id; });
      html += '<div class="tcadm-row" data-uid="' + escHtml(pr.id) + '">' +
        '<div class="tcadm-row-main">' +
          '<div class="tcadm-name">' + chip(pr.status || 'draft') + (pr.guest ? ' ' + chip('no account') : '') + ' ' + escHtml(pr.displayName || pr.id) +
            ' <span class="tcadm-sub">' + escHtml([pr.school, pr.city].filter(Boolean).join(', ')) + '</span></div>' +
          '<div class="tcadm-sub">' +
            escHtml([(pr.subjects || []).join(', '),
                     (pr.gradeLevels || []).length ? 'grades ' + pr.gradeLevels.join('/') : '',
                     pr.classSize ? pr.classSize + ' students' : ''].filter(Boolean).join(' · ')) + '</div>' +
          ((pr.topics || []).length ? '<div class="tcadm-sub">Topics: ' + pr.topics.map(escHtml).join(' · ') + '</div>' : '') +
          '<div class="tcadm-sub">' + opps.length + ' opportunit' + (opps.length === 1 ? 'y' : 'ies') +
            ' · ' + reqs.filter(function (r) { return r.status === 'pending'; }).length + ' sign-ups pending / ' +
            reqs.filter(function (r) { return r.status === 'confirmed'; }).length + ' accepted visits</div>' +
          opps.map(function (o) {
            var ds = (o.dates || []).slice().sort(function (a, b) { return String(a.date).localeCompare(String(b.date)); });
            return '<div class="tcadm-sub">' + chip(o.status || 'open') + ' <strong>' + escHtml(o.title || '') + '</strong>' +
              ((o.presentersWanted || 1) > 1 ? ' · up to ' + o.presentersWanted + ' presenters' : '') +
              ' · ' + ds.map(function (d) { return escHtml(d.date + ' ' + (d.startTime || '') + '–' + (d.endTime || '')) +
                (o.bookedDate === d.date ? ' ✓' : ''); }).join(' · ') +
              ((o.pendingCount || 0) ? ' · ' + o.pendingCount + ' pending' : '') +
              ((o.acceptedCount || 0) ? ' · ' + o.acceptedCount + ' accepted' : '') + '</div>';
          }).join('') +
        '</div>' +
        '<div class="tcadm-row-actions">' +
          (pr.status !== 'approved'
            ? '<button class="btn btn-primary btn-sm" data-eng-approve>Approve listing</button>' : '') +
          (pr.status === 'approved'
            ? '<button class="btn btn-sm" data-eng-hide>Pull listing</button>' : '') +
        '</div>' +
      '</div>';
    });

    if (engageRequests.length) {
      html += '<div class="tcadm-cat-folder-head">Visit requests</div>';
      engageRequests.forEach(function (r) {
        var teacher = engageProfiles.find(function (p) { return p.id === r.teacherUid; });
        html += '<div class="tcadm-row" data-req="' + escHtml(r.id) + '">' +
          '<div class="tcadm-row-main">' +
            '<div class="tcadm-name">' + chip(r.status) + ' ' +
              (r.date ? escHtml(r.date) + ' ' + escHtml((r.startTime || '') + '–' + (r.endTime || ''))
                      : 'could do ' + escHtml((r.dates || []).join(', ') || '?')) + ' — ' +
              escHtml(r.requesterName || '?') +
              ' <span class="tcadm-sub">' + escHtml(r.requesterAffiliation || '') + '</span></div>' +
            '<div class="tcadm-sub">→ ' + escHtml(teacher ? (teacher.displayName + ' · ' + (teacher.school || '')) : r.teacherUid) +
              (r.opportunityTitle ? ' · “' + escHtml(r.opportunityTitle) + '”' : '') +
              ' · ' + escHtml(ENGAGE_ACTIVITY[r.activityType] || r.activityType || '') +
              (r.topic ? ' · ' + escHtml(r.topic) : '') +
              (r.okWithOthers ? ' · happy to share the session' : '') + '</div>' +
            (r.status === 'confirmed' ? '<div class="tcadm-sub">' +
              (r.expectedStudents ? escHtml(String(r.expectedStudents)) + ' students expected · ' : '') +
              (r.emailedAt ? 'teacher emailed the presenter ' + fmtDate(r.emailedAt)
                           : '<strong>teacher has not emailed the presenter yet</strong>') + '</div>' : '') +
            (r.message ? '<div class="tcadm-msg">' + escHtml(r.message) + '</div>' : '') +
          '</div>' +
          '<div class="tcadm-row-actions">' +
            (r.status === 'pending' ? '<button class="btn btn-primary btn-sm" data-eng-req="confirmed">Confirm</button>' +
                                      '<button class="btn btn-sm" data-eng-req="declined">Decline</button>' : '') +
            (r.status === 'confirmed' ? '<button class="btn btn-sm" data-eng-req="cancelled" style="color:#dc2626;">Cancel visit</button>' : '') +
          '</div>' +
        '</div>';
      });
    }
    if (engagePresenters.length) {
      html += '<div class="tcadm-cat-folder-head">Presenters (' + engagePresenters.length + ')</div>';
      engagePresenters.forEach(function (pr) {
        var reqs = engageRequests.filter(function (r) { return r.requesterUid === pr.id; });
        var done = reqs.filter(function (r) { return r.status === 'confirmed'; }).length;
        html += '<div class="tcadm-row" data-presenter="' + escHtml(pr.id) + '">' +
          '<div class="tcadm-row-main">' +
            '<div class="tcadm-name">' + (pr.blocked ? chip('blocked') + ' ' : '') + escHtml(pr.name || pr.id) +
              ' <span class="tcadm-sub">' + escHtml([pr.title, pr.affiliation].filter(Boolean).join(', ')) + '</span></div>' +
            '<div class="tcadm-sub">' + escHtml(pr.email || '') + (pr.phone ? ' · ' + escHtml(pr.phone) : '') +
              ' · ' + reqs.length + ' request' + (reqs.length === 1 ? '' : 's') + ', ' + done + ' accepted</div>' +
            (pr.bring ? '<div class="tcadm-msg">' + escHtml(pr.bring) + '</div>' : '') +
          '</div>' +
          '<div class="tcadm-row-actions">' +
            (pr.blocked ? '<button class="btn btn-sm" data-presenter-block="0">Unblock</button>'
                        : '<button class="btn btn-sm" data-presenter-block="1" style="color:#dc2626;">Block</button>') +
          '</div>' +
        '</div>';
      });
    }

    if (engageReviews.length) {
      html += '<div class="tcadm-cat-folder-head">Visit reviews (' + engageReviews.length + ')</div>';
      engageReviews.forEach(function (rv) {
        var teacher = engageProfiles.find(function (p) { return p.id === rv.teacherUid; });
        html += '<div class="tcadm-row">' +
          '<div class="tcadm-row-main">' +
            '<div class="tcadm-name">' + escHtml(String(rv.rating || '?')) + '/5 overall · students ' +
              escHtml(String(rv.engagement || '?')) + '/5 engaged — ' + escHtml(rv.requesterName || '') +
              ' <span class="tcadm-sub">' + escHtml(rv.visitDate || '') + '</span></div>' +
            '<div class="tcadm-sub">→ ' + escHtml(teacher ? (teacher.displayName + ' · ' + (teacher.school || '')) : rv.teacherUid) +
              (rv.studentsReached ? ' · ' + escHtml(String(rv.studentsReached)) + ' students' : '') +
              ' · would return: ' + escHtml(rv.wouldReturn || '?') + '</div>' +
            (rv.wentWell ? '<div class="tcadm-msg">Went well: ' + escHtml(rv.wentWell) + '</div>' : '') +
            (rv.improve ? '<div class="tcadm-msg">Next time: ' + escHtml(rv.improve) + '</div>' : '') +
          '</div>' +
        '</div>';
      });
    }

    el.innerHTML = html;
    wireEngageLinkBar(el);
    wireGuestPosts(el);

    el.querySelectorAll('[data-presenter-block]').forEach(function (btn) {
      btn.addEventListener('click', async function () {
        var uid = btn.closest('.tcadm-row').dataset.presenter;
        var block = btn.dataset.presenterBlock === '1';
        try {
          await db().collection('engagePresenters').doc(uid).set(block
            ? { blocked: true, blockedAt: ts(), blockedBy: firebridge.getUser().uid }
            : { blocked: false }, { merge: true });
          setStatus(block ? 'Presenter blocked — they can no longer request visits.' : 'Presenter unblocked.', 'ok');
          await loadAndRender();
        } catch (e) { setStatus('Update failed: ' + e.message, 'err'); }
      });
    });

    el.querySelectorAll('[data-eng-approve]').forEach(function (btn) {
      btn.addEventListener('click', async function () {
        var uid = btn.closest('.tcadm-row').dataset.uid;
        try {
          await db().collection('engageProfiles').doc(uid).update({
            status: 'approved', approvedAt: ts(), approvedBy: firebridge.getUser().uid
          });
          await loadAndRender();
        } catch (e) { setStatus('Approve failed: ' + e.message, 'err'); }
      });
    });
    el.querySelectorAll('[data-eng-hide]').forEach(function (btn) {
      btn.addEventListener('click', async function () {
        var uid = btn.closest('.tcadm-row').dataset.uid;
        try {
          await db().collection('engageProfiles').doc(uid).update({ status: 'draft' });
          await loadAndRender();
        } catch (e) { setStatus('Update failed: ' + e.message, 'err'); }
      });
    });
    el.querySelectorAll('[data-eng-req]').forEach(function (btn) {
      btn.addEventListener('click', async function () {
        var id = btn.closest('.tcadm-row').dataset.req;
        var next = btn.dataset.engReq;
        try {
          var patch = { status: next, decidedAt: ts(), updatedAt: ts() };
          var r = engageRequests.find(function (x) { return x.id === id; });
          var opp = r && engageOpps.find(function (o) { return o.id === r.opportunityId; });
          // Admin confirm carries the teacher's private location, same as a
          // teacher confirm would — admin may read the subdoc. V3.791 — it
          // also has to pick the date: the opportunity's fixed date if a
          // presenter was accepted already, else the first date the presenter
          // ticked.
          if (next === 'confirmed' && r) {
            var cDoc = await db().collection('engageProfiles').doc(r.teacherUid)
              .collection('private').doc('contact').get();
            if (cDoc.exists && cDoc.data().address) patch.location = cDoc.data();
            var pick = (opp && opp.bookedDate) || (r.dates || [])[0] || r.date;
            var when = opp && (opp.dates || []).find(function (d) { return d.date === pick; });
            if (pick) { patch.date = pick; patch.startTime = (when && when.startTime) || r.startTime || ''; patch.endTime = (when && when.endTime) || r.endTime || ''; }
          }
          await db().collection('engageRequests').doc(id).update(patch);
          // V3.791 — book / un-book the opportunity the way a teacher accept does.
          if (opp) {
            var ids = (opp.acceptedRequestIds || []).filter(function (x) { return x !== id; });
            var oPatch = { updatedAt: ts() };
            if (next === 'confirmed') {
              ids.push(id);
              oPatch.acceptedRequestIds = ids;
              oPatch.bookedDate = opp.bookedDate || patch.date || null;
              if (ids.length >= (opp.presentersWanted || 1)) oPatch.status = 'booked';
            } else if (r.status === 'confirmed') {
              oPatch.acceptedRequestIds = ids;
              if (!ids.length) { oPatch.bookedDate = null; if (opp.status === 'booked') oPatch.status = 'open'; }
            }
            await db().collection('engageOpportunities').doc(opp.id).update(oPatch)
              .catch(function () { /* opportunity deleted — nothing to book */ });
          }
          await loadAndRender();
        } catch (e) { setStatus('Update failed: ' + e.message, 'err'); }
      });
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
