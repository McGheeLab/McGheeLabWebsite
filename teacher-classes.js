/* ================================================================
   TEACHER CLASSES — external teacher/student platform (V3.304)
   ----------------------------------------------------------------
   Outside teachers request a class built from the lab's interactive
   modules; admin approves and provisions a teacher-owned schedules
   doc (kind:'teacher-class'); students join with a 6-char code.

   Teachers and students keep role:'guest' — RM and lab data stay
   sealed. All capabilities here flow from schedules.ownerUid and
   enrollments membership, enforced by firestore.rules.

   Collections: classRequests, joinCodes (doc id IS the code),
   enrollments (doc id `${scheduleId}_${uid}`), reviews,
   teacherProfiles. See CodeLog/ClaudesPlan/V3.304_*.md.

   Loaded after user-system.js and class-builder.js; depends on
   McgheeLab.{db, Auth, DB, uploadImageSet, processImage,
   openCropModal}.
   ================================================================ */
(function () {
  'use strict';

  const ML = window.McgheeLab = window.McgheeLab || {};

  function db() { return ML.db; }
  function ts() { return firebase.firestore.FieldValue.serverTimestamp(); }
  function esc(s) {
    return String(s ?? '').replace(/[&<>"']/g, c => ({
      '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;'
    }[c]));
  }
  function fmtDate(v) {
    const d = v?.toDate ? v.toDate() : (v ? new Date(v) : null);
    return d && !isNaN(d) ? d.toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric' }) : '';
  }

  // Auth state may not have resolved yet on a cold page load (the router
  // wires class pages before onAuthStateChanged fires). Resolve when the
  // first auth callback has run so signed-in users aren't shown the
  // sign-in CTA for a flash — or worse, permanently on direct links.
  function waitForAuth() {
    const Auth = ML.Auth;
    if (!Auth || Auth._authStateResolved) return Promise.resolve();
    return new Promise(resolve => {
      const once = () => { Auth.offChange(once); resolve(); };
      Auth.onChange(once);
    });
  }

  /* ================================================================
     DATA LAYER
     ================================================================ */

  // Unambiguous alphabet: no 0/O or 1/I lookalikes.
  const CODE_ALPHABET = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
  function generateJoinCode() {
    const buf = new Uint32Array(6);
    crypto.getRandomValues(buf);
    let out = '';
    for (let i = 0; i < 6; i++) out += CODE_ALPHABET[buf[i] % CODE_ALPHABET.length];
    return out;
  }

  let _manifestCache = null;
  async function manifestFolders() {
    if (_manifestCache) return _manifestCache;
    const res = await fetch('modules/manifest.json');
    if (!res.ok) throw new Error('Could not load module catalog.');
    const data = await res.json();
    _manifestCache = data.folders || {};
    return _manifestCache;
  }

  const TC_DB = {
    /* ---- class requests ---- */
    async createRequest(data) {
      data.createdAt = ts(); data.updatedAt = ts();
      const ref = await db().collection('classRequests').add(data);
      return ref.id;
    },
    async myRequests(uid) {
      const snap = await db().collection('classRequests').where('teacherUid', '==', uid).get();
      const rows = snap.docs.map(d => ({ id: d.id, ...d.data() }));
      rows.sort((a, b) => (b.createdAt?.toMillis?.() || 0) - (a.createdAt?.toMillis?.() || 0));
      return rows;
    },
    async withdrawRequest(id) {
      await db().collection('classRequests').doc(id).delete();
    },

    /* ---- teacher classes (schedules with kind:'teacher-class') ---- */
    async myTeacherClasses(uid) {
      const snap = await db().collection('schedules').where('ownerUid', '==', uid).get();
      return snap.docs.map(d => ({ id: d.id, ...d.data() }))
        .filter(s => s.kind === 'teacher-class');
    },
    async getSchedule(id) {
      const doc = await db().collection('schedules').doc(id).get();
      return doc.exists ? { id: doc.id, ...doc.data() } : null;
    },
    async setEnrollmentOpen(scheduleId, open) {
      await db().collection('schedules').doc(scheduleId).update({ enrollmentOpen: !!open, updatedAt: ts() });
    },

    /* ---- join codes (doc id IS the code) ---- */
    async myJoinCodes(uid) {
      const snap = await db().collection('joinCodes').where('teacherUid', '==', uid).get();
      return snap.docs.map(d => ({ code: d.id, ...d.data() }));
    },
    // Create a fresh active code for a class, retrying on the (rare)
    // collision with an existing code doc.
    async createJoinCode(scheduleId, teacherUid) {
      for (let attempt = 0; attempt < 5; attempt++) {
        const code = generateJoinCode();
        const ref = db().collection('joinCodes').doc(code);
        const existing = await ref.get();
        if (existing.exists) continue;
        await ref.set({ scheduleId, teacherUid, active: true, createdAt: ts(), createdBy: teacherUid });
        return code;
      }
      throw new Error('Could not generate a unique code — try again.');
    },
    async deactivateCode(code) {
      await db().collection('joinCodes').doc(code).update({ active: false });
    },

    /* ---- enrollments ---- */
    enrollmentId(scheduleId, uid) { return scheduleId + '_' + uid; },
    async getEnrollment(scheduleId, uid) {
      const doc = await db().collection('enrollments').doc(TC_DB.enrollmentId(scheduleId, uid)).get();
      return doc.exists ? { id: doc.id, ...doc.data() } : null;
    },
    async rosterForTeacher(uid) {
      const snap = await db().collection('enrollments').where('teacherUid', '==', uid).get();
      return snap.docs.map(d => ({ id: d.id, ...d.data() }));
    },
    async myEnrollments(uid) {
      const snap = await db().collection('enrollments').where('studentUid', '==', uid).get();
      return snap.docs.map(d => ({ id: d.id, ...d.data() }));
    },
    async setEnrollmentStatus(enrollmentId, status) {
      await db().collection('enrollments').doc(enrollmentId).update({ status, updatedAt: ts() });
    },

    /* ---- reviews ---- */
    async myReviews(uid) {
      const snap = await db().collection('reviews').where('authorUid', '==', uid).get();
      return snap.docs.map(d => ({ id: d.id, ...d.data() }));
    },
    async approvedReviews(limit) {
      const snap = await db().collection('reviews')
        .where('status', '==', 'approved')
        .orderBy('createdAt', 'desc')
        .limit(limit || 12).get();
      return snap.docs.map(d => ({ id: d.id, ...d.data() }));
    },
    async submitReview(data) {
      data.status = 'pending'; data.featured = false;
      data.createdAt = ts();
      const ref = await db().collection('reviews').add(data);
      return ref.id;
    },
    async updateReview(id, data) {
      data.status = 'pending'; // author edits stay in the moderation queue
      await db().collection('reviews').doc(id).update(data);
    },

    /* ---- teacher public profiles ---- */
    async getTeacherProfile(uid) {
      const doc = await db().collection('teacherProfiles').doc(uid).get();
      return doc.exists ? { id: doc.id, ...doc.data() } : null;
    },
    async saveTeacherProfile(uid, data, submit) {
      data.uid = uid;
      data.status = submit ? 'pending' : 'draft';
      data.updatedAt = ts();
      await db().collection('teacherProfiles').doc(uid).set(data, { merge: true });
    },
    async approvedTeacherProfiles() {
      const snap = await db().collection('teacherProfiles').where('status', '==', 'approved').get();
      return snap.docs.map(d => ({ id: d.id, ...d.data() }));
    }
  };

  /* ================================================================
     JOIN A CLASS (shared by student dashboard + class page)
     ================================================================ */
  async function joinClassWithCode(rawCode) {
    const Auth = ML.Auth;
    if (!Auth?.currentUser) throw new Error('Please sign in first.');
    const code = String(rawCode || '').trim().toUpperCase();
    if (!/^[A-Z0-9]{6}$/.test(code)) throw new Error('Class codes are 6 letters/numbers.');

    const codeDoc = await db().collection('joinCodes').doc(code).get();
    if (!codeDoc.exists || codeDoc.data().active !== true) {
      throw new Error('That code is not valid or is no longer active.');
    }
    const { scheduleId, teacherUid } = codeDoc.data();
    const sched = await TC_DB.getSchedule(scheduleId);
    if (!sched) throw new Error('Class not found.');
    if (sched.enrollmentOpen === false) throw new Error('Enrollment is currently closed for this class.');

    const uid = Auth.currentUser.uid;
    const p = Auth.currentProfile || {};
    const existing = await TC_DB.getEnrollment(scheduleId, uid);
    if (existing && existing.status === 'active') return scheduleId; // already in — idempotent
    if (existing) {
      // Re-join after leaving/removal still requires a live code (checked
      // above); the update stays inside the student-writable key set.
      await TC_DB.setEnrollmentStatus(existing.id, 'active');
    } else {
      await db().collection('enrollments').doc(TC_DB.enrollmentId(scheduleId, uid)).set({
        scheduleId,
        studentUid: uid,
        studentName: p.name || Auth.currentUser.displayName || '',
        studentEmail: p.email || Auth.currentUser.email || '',
        teacherUid,
        joinCode: code,
        status: 'active',
        createdAt: ts(),
        updatedAt: ts()
      });
    }
    // First join self-identifies a plain guest as a student. Never
    // reclassify teachers (a teacher can preview their own class).
    if ((p.category || 'guest') === 'guest') {
      try {
        await ML.DB.updateUser(uid, { category: 'student' });
        Auth.currentProfile = await ML.DB.getUser(uid);
      } catch (e) { console.warn('[TC] category update failed', e); }
    }
    return scheduleId;
  }

  // Soft gate for the module viewer: enrolled student, owning teacher,
  // or admin. Static module HTML remains fetchable by URL — accepted
  // trade-off recorded in the V3.304 plan.
  async function tcCanViewModules(classId, schedule) {
    await waitForAuth();
    const Auth = ML.Auth;
    if (!Auth?.currentUser) return false;
    if (Auth.currentProfile?.role === 'admin') return true;
    if (schedule.ownerUid === Auth.currentUser.uid) return true;
    const e = await TC_DB.getEnrollment(classId, Auth.currentUser.uid).catch(() => null);
    return !!(e && e.status === 'active');
  }

  /* ================================================================
     SHARED WIDGETS
     ================================================================ */

  function statusChip(status) {
    const map = {
      pending: ['tc-chip-pending', 'Pending review'],
      approved: ['tc-chip-approved', 'Approved'],
      denied: ['tc-chip-denied', 'Denied'],
      rejected: ['tc-chip-denied', 'Not published'],
      draft: ['tc-chip-draft', 'Draft'],
      hidden: ['tc-chip-denied', 'Hidden'],
      active: ['tc-chip-approved', 'Active'],
      removed: ['tc-chip-denied', 'Removed']
    };
    const [cls, label] = map[status] || ['tc-chip-draft', status || ''];
    return `<span class="tc-chip ${cls}">${esc(label)}</span>`;
  }

  function starsDisplay(n) {
    n = Math.max(0, Math.min(5, Number(n) || 0));
    return `<span class="tc-stars" aria-label="${n} out of 5 stars">${'★'.repeat(n)}${'☆'.repeat(5 - n)}</span>`;
  }

  function starsInput(current) {
    let html = '<div class="tc-star-input" role="radiogroup" aria-label="Rating">';
    for (let i = 1; i <= 5; i++) {
      html += `<button type="button" class="tc-star-btn${i <= current ? ' on' : ''}" data-star="${i}" aria-label="${i} star${i > 1 ? 's' : ''}">★</button>`;
    }
    return html + '</div>';
  }

  function wireStarsInput(rootEl) {
    let value = rootEl.querySelectorAll('.tc-star-btn.on').length;
    rootEl.querySelectorAll('.tc-star-btn').forEach(btn => {
      btn.addEventListener('click', () => {
        value = Number(btn.dataset.star);
        rootEl.querySelectorAll('.tc-star-btn').forEach(b =>
          b.classList.toggle('on', Number(b.dataset.star) <= value));
      });
    });
    return () => value;
  }

  // "My review" card — used on both dashboards. `classes` is
  // [{scheduleId, title}]; the author reviews one class at a time.
  function reviewCardHTML(myReviews, classes, authorRole) {
    if (!classes.length) return '';
    const reviewable = classes.filter(c => !myReviews.some(r => r.scheduleId === c.scheduleId));
    let html = `<div class="dash-card" id="tc-review-card"><h3>My Review</h3>
      <p class="tc-muted">Tell us about your experience using these class materials. Reviews are published after the lab approves them.</p>`;
    for (const r of myReviews) {
      const cls = classes.find(c => c.scheduleId === r.scheduleId);
      html += `<div class="tc-review-row">
        <div>${starsDisplay(r.rating)} ${statusChip(r.status)}</div>
        ${cls ? `<div class="tc-muted">${esc(cls.title)}</div>` : ''}
        <p>${esc(r.text)}</p>
        ${r.status === 'pending' ? `<button class="btn btn-secondary btn-small" data-edit-review="${esc(r.id)}">Edit</button>` : ''}
      </div>`;
    }
    if (reviewable.length) {
      html += `<form id="tc-review-form" data-role="${esc(authorRole)}">
        ${reviewable.length > 1 ? `
        <div class="form-group"><label for="tc-review-class">Class</label>
          <select id="tc-review-class">${reviewable.map(c =>
            `<option value="${esc(c.scheduleId)}">${esc(c.title)}</option>`).join('')}</select>
        </div>` : `<input type="hidden" id="tc-review-class" value="${esc(reviewable[0].scheduleId)}">`}
        ${starsInput(5)}
        <div class="form-group">
          <textarea id="tc-review-text" rows="3" required placeholder="What worked for you? What did your ${authorRole === 'teacher' ? 'students' : 'class'} think?"></textarea>
        </div>
        <button type="submit" class="btn btn-primary">Submit Review</button>
        <div id="tc-review-status" class="form-status" hidden></div>
      </form>`;
    }
    return html + '</div>';
  }

  function wireReviewCard(classes, refresh) {
    const Auth = ML.Auth;
    const form = document.getElementById('tc-review-form');
    if (form) {
      const getStars = wireStarsInput(form.querySelector('.tc-star-input'));
      form.addEventListener('submit', async (e) => {
        e.preventDefault();
        const st = document.getElementById('tc-review-status');
        const scheduleId = document.getElementById('tc-review-class').value;
        const cls = classes.find(c => c.scheduleId === scheduleId);
        try {
          await TC_DB.submitReview({
            authorUid: Auth.currentUser.uid,
            authorName: Auth.currentProfile?.name || '',
            authorRole: form.dataset.role,
            scheduleId,
            teacherUid: cls?.teacherUid || Auth.currentUser.uid,
            school: cls?.school || '',
            rating: getStars(),
            text: document.getElementById('tc-review-text').value.trim()
          });
          refresh();
        } catch (err) {
          st.textContent = 'Could not submit: ' + err.message; st.className = 'form-status error'; st.hidden = false;
        }
      });
    }
    document.querySelectorAll('[data-edit-review]').forEach(btn => {
      btn.addEventListener('click', async () => {
        const row = btn.closest('.tc-review-row');
        const text = prompt('Update your review:', row.querySelector('p')?.textContent || '');
        if (text === null) return;
        try {
          await TC_DB.updateReview(btn.dataset.editReview, { text: text.trim() });
          refresh();
        } catch (err) { alert('Could not update: ' + err.message); }
      });
    });
  }

  /* ================================================================
     TEACHER DASHBOARD
     ================================================================ */
  function renderTeacherDashboard(p) {
    return `
    <div class="dashboard-page">
      <div class="dash-header">
        <h2>Teacher Dashboard</h2>
        <button class="btn btn-secondary" id="dash-logout-btn">Sign Out</button>
      </div>
      <div class="dashboard-grid">
        ${ML.renderGuestProfileCard ? ML.renderGuestProfileCard(p) : ''}
        <div class="dash-card" id="tc-classes-card"><h3>My Classes</h3><p class="tc-muted">Loading…</p></div>
        <div class="dash-card" id="tc-request-card"><h3>Request a Class</h3><p class="tc-muted">Loading…</p></div>
        <div class="dash-card" id="tc-public-profile-card"><h3>Public Teacher Profile</h3><p class="tc-muted">Loading…</p></div>
        <div id="tc-review-slot"></div>
      </div>
    </div>`;
  }

  async function wireTeacherDashboard() {
    const Auth = ML.Auth;
    document.getElementById('dash-logout-btn')?.addEventListener('click', () => Auth.logout());
    if (ML.wireGuestProfileCard) ML.wireGuestProfileCard();
    const uid = Auth.currentUser.uid;

    // Fire the independent loads together.
    await Promise.all([
      loadTeacherClasses(uid).catch(e => panelError('tc-classes-card', e)),
      loadRequestCard(uid).catch(e => panelError('tc-request-card', e)),
      loadPublicProfileCard(uid).catch(e => panelError('tc-public-profile-card', e)),
      loadTeacherReviewSlot(uid).catch(e => console.warn('[TC] review slot', e))
    ]);
  }

  function panelError(id, e) {
    console.warn('[TC]', id, e);
    const el = document.getElementById(id);
    if (el) el.innerHTML += `<p class="error-text">Failed to load: ${esc(e.message || e)}</p>`;
  }

  async function loadTeacherClasses(uid) {
    const el = document.getElementById('tc-classes-card');
    if (!el) return;
    const [classes, codes, roster, folders] = await Promise.all([
      TC_DB.myTeacherClasses(uid),
      TC_DB.myJoinCodes(uid),
      TC_DB.rosterForTeacher(uid),
      manifestFolders().catch(() => ({}))
    ]);

    if (!classes.length) {
      el.innerHTML = `<h3>My Classes</h3>
        <p class="tc-muted">No classes yet. Once the lab approves your request, your class will appear here with a join code for your students.</p>`;
      return;
    }

    let html = '<h3>My Classes</h3>';
    for (const cls of classes) {
      const activeCode = codes.find(c => c.scheduleId === cls.id && c.active);
      const students = roster.filter(r => r.scheduleId === cls.id && r.status === 'active');
      const folderLabels = (cls.grantedFolders || []).map(f => folders[f]?.label || f);
      html += `
      <div class="tc-class-block" data-schedule="${esc(cls.id)}">
        <div class="tc-class-head">
          <a href="#/classes/${esc(cls.id)}"><strong>${esc(cls.title || cls.id)}</strong></a>
          <label class="tc-toggle"><input type="checkbox" data-enroll-toggle ${cls.enrollmentOpen !== false ? 'checked' : ''}> Enrollment open</label>
        </div>
        ${folderLabels.length ? `<p class="tc-muted">Modules: ${folderLabels.map(esc).join(' · ')}</p>` : ''}
        <div class="tc-code-box">
          ${activeCode
            ? `<span class="tc-code" id="tc-code-${esc(cls.id)}">${esc(activeCode.code)}</span>
               <button class="btn btn-secondary btn-small" data-copy-code="${esc(activeCode.code)}">Copy</button>
               <button class="btn btn-secondary btn-small" data-regen-code data-old="${esc(activeCode.code)}">Regenerate</button>
               <button class="btn btn-secondary btn-small" data-disable-code="${esc(activeCode.code)}">Disable</button>`
            : `<span class="tc-muted">No active join code.</span>
               <button class="btn btn-primary btn-small" data-new-code>Create join code</button>`}
        </div>
        <p class="tc-muted tc-code-hint">Students: sign in at mcgheelab.com, open this class under Classes, and enter the code.</p>
        <div class="tc-roster">
          <strong>Students (${students.length})</strong>
          ${students.length ? `<table class="tc-roster-table"><tbody>
            ${students.map(s => `<tr>
              <td>${esc(s.studentName || '—')}</td>
              <td class="tc-muted">${esc(s.studentEmail || '')}</td>
              <td class="tc-muted">${fmtDate(s.createdAt)}</td>
              <td><button class="btn btn-secondary btn-small" data-remove-student="${esc(s.id)}">Remove</button></td>
            </tr>`).join('')}
          </tbody></table>` : '<p class="tc-muted">No students have joined yet.</p>'}
        </div>
      </div>`;
    }
    el.innerHTML = html;

    el.querySelectorAll('[data-copy-code]').forEach(btn => {
      btn.addEventListener('click', () => {
        navigator.clipboard?.writeText(btn.dataset.copyCode);
        btn.textContent = 'Copied!';
        setTimeout(() => { btn.textContent = 'Copy'; }, 1500);
      });
    });
    el.querySelectorAll('[data-enroll-toggle]').forEach(input => {
      input.addEventListener('change', async () => {
        const scheduleId = input.closest('.tc-class-block').dataset.schedule;
        try { await TC_DB.setEnrollmentOpen(scheduleId, input.checked); }
        catch (e) { input.checked = !input.checked; alert('Could not update: ' + e.message); }
      });
    });
    el.querySelectorAll('[data-new-code]').forEach(btn => {
      btn.addEventListener('click', async () => {
        const scheduleId = btn.closest('.tc-class-block').dataset.schedule;
        btn.disabled = true;
        try { await TC_DB.createJoinCode(scheduleId, uid); await loadTeacherClasses(uid); }
        catch (e) { btn.disabled = false; alert('Could not create code: ' + e.message); }
      });
    });
    el.querySelectorAll('[data-regen-code]').forEach(btn => {
      btn.addEventListener('click', async () => {
        if (!confirm('Regenerate the join code? The old code will stop working immediately.')) return;
        const scheduleId = btn.closest('.tc-class-block').dataset.schedule;
        btn.disabled = true;
        try {
          await TC_DB.createJoinCode(scheduleId, uid);
          await TC_DB.deactivateCode(btn.dataset.old);
          await loadTeacherClasses(uid);
        } catch (e) { btn.disabled = false; alert('Could not regenerate: ' + e.message); }
      });
    });
    el.querySelectorAll('[data-disable-code]').forEach(btn => {
      btn.addEventListener('click', async () => {
        if (!confirm('Disable this join code? Students will not be able to join until you create a new one.')) return;
        try { await TC_DB.deactivateCode(btn.dataset.disableCode); await loadTeacherClasses(uid); }
        catch (e) { alert('Could not disable: ' + e.message); }
      });
    });
    el.querySelectorAll('[data-remove-student]').forEach(btn => {
      btn.addEventListener('click', async () => {
        if (!confirm('Remove this student from your class?')) return;
        try { await TC_DB.setEnrollmentStatus(btn.dataset.removeStudent, 'removed'); await loadTeacherClasses(uid); }
        catch (e) { alert('Could not remove: ' + e.message); }
      });
    });
  }

  async function loadRequestCard(uid) {
    const el = document.getElementById('tc-request-card');
    if (!el) return;
    const [requests, folders] = await Promise.all([
      TC_DB.myRequests(uid),
      manifestFolders().catch(() => ({}))
    ]);
    const hasPending = requests.some(r => r.status === 'pending');

    let html = '<h3>Request a Class</h3>';
    if (requests.length) {
      html += '<div class="tc-request-history">';
      for (const r of requests) {
        html += `<div class="tc-request-row">
          ${statusChip(r.status)}
          <span>${esc(r.school || '')} — ${(r.requestedFolders || []).map(f => esc(folders[f]?.label || f)).join(', ')}</span>
          <span class="tc-muted">${fmtDate(r.createdAt)}</span>
          ${r.status === 'denied' && r.denyReason ? `<p class="tc-muted">Reason: ${esc(r.denyReason)}</p>` : ''}
          ${r.status === 'pending' ? `<button class="btn btn-secondary btn-small" data-withdraw="${esc(r.id)}">Withdraw</button>` : ''}
        </div>`;
      }
      html += '</div>';
    }
    if (hasPending) {
      html += '<p class="tc-muted">Your request is being reviewed — you’ll see your class here once it’s approved.</p>';
    } else {
      const folderKeys = Object.keys(folders);
      html += `
      <form id="tc-request-form">
        <p class="tc-muted">Tell us about your class and which module sets you’d like to use. The lab reviews every request.</p>
        <div class="form-group"><label for="tcr-school">School</label>
          <input type="text" id="tcr-school" required placeholder="School name"></div>
        <div class="tc-form-row">
          <div class="form-group"><label for="tcr-city">City</label><input type="text" id="tcr-city"></div>
          <div class="form-group"><label for="tcr-state">State</label><input type="text" id="tcr-state"></div>
        </div>
        <div class="tc-form-row">
          <div class="form-group"><label for="tcr-grade">Grade level</label>
            <input type="text" id="tcr-grade" placeholder="e.g. 11–12"></div>
          <div class="form-group"><label for="tcr-size">Class size</label>
            <input type="number" id="tcr-size" min="1" max="500" placeholder="e.g. 28"></div>
        </div>
        <div class="form-group"><label for="tcr-subject">Subject area</label>
          <input type="text" id="tcr-subject" placeholder="e.g. AP Biology, Physics, Engineering"></div>
        <div class="form-group"><label>Module sets</label>
          <div class="tc-folder-list">
            ${folderKeys.map(k => `
              <label class="tc-folder-option">
                <input type="checkbox" value="${esc(k)}"> ${esc(folders[k].label || k)}
                <span class="tc-muted">(${(folders[k].files || []).length} modules)</span>
              </label>`).join('')}
          </div>
        </div>
        <div class="form-group"><label for="tcr-message">Anything else?</label>
          <textarea id="tcr-message" rows="3" placeholder="Timeline, goals, questions…"></textarea></div>
        <button type="submit" class="btn btn-primary">Submit Request</button>
        <div id="tc-request-status" class="form-status" hidden></div>
      </form>`;
    }
    el.innerHTML = html;

    el.querySelectorAll('[data-withdraw]').forEach(btn => {
      btn.addEventListener('click', async () => {
        if (!confirm('Withdraw this request?')) return;
        try { await TC_DB.withdrawRequest(btn.dataset.withdraw); await loadRequestCard(uid); }
        catch (e) { alert('Could not withdraw: ' + e.message); }
      });
    });
    const form = document.getElementById('tc-request-form');
    if (form) {
      form.addEventListener('submit', async (e) => {
        e.preventDefault();
        const st = document.getElementById('tc-request-status');
        const requested = [...form.querySelectorAll('.tc-folder-option input:checked')].map(i => i.value);
        if (!requested.length) {
          st.textContent = 'Pick at least one module set.'; st.className = 'form-status error'; st.hidden = false;
          return;
        }
        const Auth = ML.Auth;
        try {
          await TC_DB.createRequest({
            teacherUid: uid,
            teacherName: Auth.currentProfile?.name || Auth.currentUser.displayName || '',
            teacherEmail: Auth.currentProfile?.email || Auth.currentUser.email || '',
            school: document.getElementById('tcr-school').value.trim(),
            schoolCity: document.getElementById('tcr-city').value.trim(),
            schoolState: document.getElementById('tcr-state').value.trim(),
            gradeLevel: document.getElementById('tcr-grade').value.trim(),
            classSize: Number(document.getElementById('tcr-size').value) || null,
            subjectArea: document.getElementById('tcr-subject').value.trim(),
            requestedFolders: requested,
            message: document.getElementById('tcr-message').value.trim(),
            status: 'pending'
          });
          await loadRequestCard(uid);
        } catch (err) {
          st.textContent = 'Could not submit: ' + err.message; st.className = 'form-status error'; st.hidden = false;
        }
      });
    }
  }

  async function loadPublicProfileCard(uid) {
    const el = document.getElementById('tc-public-profile-card');
    if (!el) return;
    const prof = await TC_DB.getTeacherProfile(uid) || {};
    const Auth = ML.Auth;
    el.innerHTML = `
      <h3>Public Teacher Profile</h3>
      <p class="tc-muted">Featured teachers appear on our People page. Fill this out and submit it — nothing is shown publicly until the lab approves it.</p>
      ${prof.status ? `<p>Status: ${statusChip(prof.status)}${prof.status === 'approved' ? ' <span class="tc-muted">(editing will re-queue it for approval)</span>' : ''}</p>` : ''}
      <form id="tc-tprofile-form">
        <div class="profile-photo-section">
          <div class="profile-photo-preview" id="tc-tprofile-photo-preview">
            ${prof.photo?.medium ? `<img src="${esc(prof.photo.medium)}" alt="Teacher photo">` : '<div class="photo-placeholder">No photo</div>'}
          </div>
          <label class="btn btn-secondary btn-small upload-label">Upload Photo
            <input type="file" id="tc-tprofile-photo-input" accept="image/*" hidden></label>
        </div>
        <div class="form-group"><label for="tcp-name">Name</label>
          <input type="text" id="tcp-name" required value="${esc(prof.name || Auth.currentProfile?.name || '')}"></div>
        <div class="form-group"><label for="tcp-school">School</label>
          <input type="text" id="tcp-school" required value="${esc(prof.school || '')}"></div>
        <div class="form-group"><label for="tcp-subject">Subject area</label>
          <input type="text" id="tcp-subject" value="${esc(prof.subjectArea || '')}"></div>
        <div class="form-group"><label for="tcp-blurb">About you &amp; your class</label>
          <textarea id="tcp-blurb" rows="3">${esc(prof.blurb || '')}</textarea></div>
        <div class="tc-btn-row">
          <button type="button" class="btn btn-secondary" id="tcp-save-draft">Save Draft</button>
          <button type="submit" class="btn btn-primary">Submit for Approval</button>
        </div>
        <div id="tc-tprofile-status" class="form-status" hidden></div>
      </form>`;

    let photo = prof.photo || null;
    document.getElementById('tc-tprofile-photo-input')?.addEventListener('change', async (e) => {
      const file = e.target.files[0];
      if (!file) return;
      e.target.value = '';
      const st = document.getElementById('tc-tprofile-status');
      try {
        const cropped = await ML.openCropModal(file);
        st.textContent = 'Uploading photo…'; st.className = 'form-status'; st.hidden = false;
        const blobs = await ML.processImage(cropped);
        photo = await ML.uploadImageSet(blobs, `users/${uid}/teacher-photo`);
        document.getElementById('tc-tprofile-photo-preview').innerHTML =
          `<img src="${esc(photo.medium)}" alt="Teacher photo">`;
        st.textContent = 'Photo ready — save or submit to keep it.'; st.className = 'form-status success';
      } catch (err) {
        if (err.message === 'Crop cancelled') return;
        st.textContent = 'Upload failed: ' + err.message; st.className = 'form-status error'; st.hidden = false;
      }
    });

    async function save(submit) {
      const st = document.getElementById('tc-tprofile-status');
      try {
        await TC_DB.saveTeacherProfile(uid, {
          name: document.getElementById('tcp-name').value.trim(),
          school: document.getElementById('tcp-school').value.trim(),
          subjectArea: document.getElementById('tcp-subject').value.trim(),
          blurb: document.getElementById('tcp-blurb').value.trim(),
          photo
        }, submit);
        await loadPublicProfileCard(uid);
      } catch (err) {
        st.textContent = 'Save failed: ' + err.message; st.className = 'form-status error'; st.hidden = false;
      }
    }
    document.getElementById('tcp-save-draft')?.addEventListener('click', () => save(false));
    document.getElementById('tc-tprofile-form')?.addEventListener('submit', (e) => { e.preventDefault(); save(true); });
  }

  async function loadTeacherReviewSlot(uid) {
    const slot = document.getElementById('tc-review-slot');
    if (!slot) return;
    const [classes, myReviews] = await Promise.all([
      TC_DB.myTeacherClasses(uid),
      TC_DB.myReviews(uid)
    ]);
    const classRefs = classes.map(c => ({
      scheduleId: c.id, title: c.title || c.id, teacherUid: uid, school: c.school || ''
    }));
    slot.innerHTML = reviewCardHTML(myReviews, classRefs, 'teacher');
    wireReviewCard(classRefs, () => loadTeacherReviewSlot(uid));
  }

  /* ================================================================
     STUDENT DASHBOARD
     ================================================================ */
  function renderStudentDashboard(p) {
    return `
    <div class="dashboard-page">
      <div class="dash-header">
        <h2>Student Dashboard</h2>
        <button class="btn btn-secondary" id="dash-logout-btn">Sign Out</button>
      </div>
      <div class="dashboard-grid">
        ${ML.renderGuestProfileCard ? ML.renderGuestProfileCard(p) : ''}
        <div class="dash-card" id="tc-join-card">
          <h3>Join a Class</h3>
          <p class="tc-muted">Enter the 6-character code your teacher gave you.</p>
          <form id="tc-join-form" class="tc-join-form">
            <input type="text" id="tc-join-code" maxlength="6" autocomplete="off"
                   placeholder="ABC123" aria-label="Class code">
            <button type="submit" class="btn btn-primary">Join</button>
          </form>
          <div id="tc-join-status" class="form-status" hidden></div>
        </div>
        <div class="dash-card" id="tc-myclasses-card"><h3>My Classes</h3><p class="tc-muted">Loading…</p></div>
        <div id="tc-review-slot"></div>
      </div>
    </div>`;
  }

  async function wireStudentDashboard() {
    const Auth = ML.Auth;
    document.getElementById('dash-logout-btn')?.addEventListener('click', () => Auth.logout());
    if (ML.wireGuestProfileCard) ML.wireGuestProfileCard();
    const uid = Auth.currentUser.uid;

    document.getElementById('tc-join-form')?.addEventListener('submit', async (e) => {
      e.preventDefault();
      const st = document.getElementById('tc-join-status');
      const btn = e.target.querySelector('button');
      btn.disabled = true; st.hidden = true;
      try {
        await joinClassWithCode(document.getElementById('tc-join-code').value);
        st.textContent = 'You’re in!'; st.className = 'form-status success'; st.hidden = false;
        document.getElementById('tc-join-code').value = '';
        await loadStudentClasses(uid);
        await loadStudentReviewSlot(uid);
      } catch (err) {
        st.textContent = err.message; st.className = 'form-status error'; st.hidden = false;
      }
      btn.disabled = false;
    });

    await Promise.all([
      loadStudentClasses(uid).catch(e => panelError('tc-myclasses-card', e)),
      loadStudentReviewSlot(uid).catch(e => console.warn('[TC] review slot', e))
    ]);
  }

  async function loadStudentClasses(uid) {
    const el = document.getElementById('tc-myclasses-card');
    if (!el) return;
    const enrollments = (await TC_DB.myEnrollments(uid)).filter(e => e.status === 'active');
    if (!enrollments.length) {
      el.innerHTML = '<h3>My Classes</h3><p class="tc-muted">You haven’t joined a class yet.</p>';
      return;
    }
    const schedules = await Promise.all(enrollments.map(e => TC_DB.getSchedule(e.scheduleId).catch(() => null)));
    el.innerHTML = '<h3>My Classes</h3>' + enrollments.map((e, i) => {
      const s = schedules[i];
      return `<div class="tc-class-block">
        <a href="#/classes/${esc(e.scheduleId)}"><strong>${esc(s?.title || e.scheduleId)}</strong></a>
        ${s?.school ? `<span class="tc-muted"> — ${esc(s.school)}</span>` : ''}
        <p><a class="btn btn-small" href="#/classes/${esc(e.scheduleId)}">Open modules &rarr;</a></p>
      </div>`;
    }).join('');
  }

  async function loadStudentReviewSlot(uid) {
    const slot = document.getElementById('tc-review-slot');
    if (!slot) return;
    const [enrollments, myReviews] = await Promise.all([
      TC_DB.myEnrollments(uid),
      TC_DB.myReviews(uid)
    ]);
    const active = enrollments.filter(e => e.status === 'active');
    const schedules = await Promise.all(active.map(e => TC_DB.getSchedule(e.scheduleId).catch(() => null)));
    const classRefs = active.map((e, i) => ({
      scheduleId: e.scheduleId,
      title: schedules[i]?.title || e.scheduleId,
      teacherUid: e.teacherUid,
      school: schedules[i]?.school || ''
    }));
    slot.innerHTML = reviewCardHTML(myReviews, classRefs, 'student');
    wireReviewCard(classRefs, () => loadStudentReviewSlot(uid));
  }

  /* ================================================================
     TEACHER-CLASS PAGE (student-facing) — delegated from
     class-builder's wireClassPage when schedule.kind === 'teacher-class'
     ================================================================ */
  async function wireTeacherClassPage(scheduleId, schedule) {
    const titleEl = document.getElementById('sched-title');
    const subEl = document.getElementById('sched-subtitle');
    if (titleEl) titleEl.textContent = schedule.title || scheduleId;
    if (subEl) subEl.textContent = [schedule.school, schedule.semester].filter(Boolean).join(' — ');
    const content = document.getElementById('class-page-content');
    if (!content) return;

    await waitForAuth();
    const Auth = ML.Auth;

    if (!Auth?.currentUser) {
      content.innerHTML = `
        <div class="section card"><div class="tc-gate-card">
          <h3>Sign in to view this class</h3>
          <p class="tc-muted">This class is run by ${esc(schedule.teacherName || 'your teacher')}${schedule.school ? ' at ' + esc(schedule.school) : ''}. Sign in with Google, then enter your class code.</p>
          <button class="btn btn-primary" id="tc-gate-signin">Sign in with Google</button>
          <div id="tc-gate-status" class="form-status" hidden></div>
        </div></div>`;
      document.getElementById('tc-gate-signin')?.addEventListener('click', async () => {
        const st = document.getElementById('tc-gate-status');
        try {
          await Auth.googleLogin();
          await wireTeacherClassPage(scheduleId, schedule);
        } catch (e) {
          st.textContent = 'Sign-in failed: ' + e.message; st.className = 'form-status error'; st.hidden = false;
        }
      });
      return;
    }

    const canView = await tcCanViewModules(scheduleId, schedule);
    if (!canView) {
      content.innerHTML = `
        <div class="section card"><div class="tc-gate-card">
          <h3>Enter your class code</h3>
          <p class="tc-muted">Ask your teacher for the 6-character code for ${esc(schedule.title || 'this class')}.</p>
          <form id="tc-gate-join" class="tc-join-form">
            <input type="text" id="tc-gate-code" maxlength="6" autocomplete="off" placeholder="ABC123" aria-label="Class code">
            <button type="submit" class="btn btn-primary">Join Class</button>
          </form>
          <div id="tc-gate-status" class="form-status" hidden></div>
        </div></div>`;
      document.getElementById('tc-gate-join')?.addEventListener('submit', async (e) => {
        e.preventDefault();
        const st = document.getElementById('tc-gate-status');
        try {
          const joined = await joinClassWithCode(document.getElementById('tc-gate-code').value);
          if (joined !== scheduleId) {
            // Valid code, but for a different class — take them there.
            window.location.hash = '#/classes/' + joined;
            return;
          }
          await wireTeacherClassPage(scheduleId, schedule);
        } catch (err) {
          st.textContent = err.message; st.className = 'form-status error'; st.hidden = false;
        }
      });
      return;
    }

    // Enrolled student, owning teacher, or admin.
    const isOwner = schedule.ownerUid === Auth.currentUser.uid;
    const isAdmin = Auth.currentProfile?.role === 'admin';
    const modules = (schedule.modules || [])
      .filter(m => m.published !== false)
      .sort((a, b) => (a.order ?? 0) - (b.order ?? 0));

    content.innerHTML = `
      ${(isOwner || isAdmin) ? `
      <div class="section card tc-owner-strip">
        <span>${isOwner ? 'This is your class.' : 'Viewing as admin.'}</span>
        ${isOwner ? '<a href="#/dashboard" class="btn btn-secondary btn-small">Manage in your dashboard</a>' : ''}
      </div>` : ''}
      ${schedule.description ? `<div class="section card"><p>${esc(schedule.description)}</p></div>` : ''}
      <div class="section card">
        <h3>Modules</h3>
        ${modules.length ? `<div class="tc-module-list">
          ${modules.map((m, i) => `
            <a class="tc-module-item" href="#/classes/${esc(scheduleId)}/modules/${encodeURIComponent(m.htmlFile)}">
              <span class="tc-module-num">${i + 1}</span>
              <span class="tc-module-title">${esc(m.title || m.htmlFile)}</span>
              <span class="tc-module-arrow">&rarr;</span>
            </a>`).join('')}
        </div>` : '<p class="tc-muted">No modules published yet.</p>'}
      </div>
      <div class="section card">
        <h3>How was it?</h3>
        <p class="tc-muted">When you’ve worked through the materials, we’d love a short review — it helps other schools find these modules. Write one from <a href="#/dashboard">your dashboard</a>.</p>
      </div>`;
  }

  /* ================================================================
     PUBLIC SECTIONS — classes-page reviews strip + team-page teachers
     ================================================================ */
  async function renderClassReviewsSection(parentEl) {
    if (!parentEl || !db()) return;
    let reviews;
    try { reviews = await TC_DB.approvedReviews(12); } catch (e) { return; }
    if (!reviews.length) return;

    const section = document.createElement('div');
    section.className = 'section card reveal tc-reviews-section';
    section.innerHTML = `
      <h3>What teachers and students say</h3>
      <div class="tc-reviews-grid">
        ${reviews.map(r => `
          <div class="tc-review-quote">
            ${starsDisplay(r.rating)}
            <p>&ldquo;${esc(r.text)}&rdquo;</p>
            <div class="tc-review-byline">
              <strong>${esc(r.authorName || 'Anonymous')}</strong>
              <span class="badge">${r.authorRole === 'teacher' ? 'Teacher' : 'Student'}</span>
              ${r.school ? `<span class="tc-muted">${esc(r.school)}</span>` : ''}
            </div>
          </div>`).join('')}
      </div>`;
    parentEl.appendChild(section);
  }

  async function renderFeaturedTeachersSection(appEl) {
    if (!appEl || !db()) return;
    let profiles;
    try { profiles = await TC_DB.approvedTeacherProfiles(); } catch (e) { return; }
    if (!profiles.length) return;

    let featuredReviews = [];
    try {
      featuredReviews = (await TC_DB.approvedReviews(50)).filter(r => r.featured);
    } catch (e) { /* reviews are optional garnish */ }

    profiles.sort((a, b) => (a.name || '').localeCompare(b.name || ''));
    const section = document.createElement('section');
    section.className = 'section tc-teachers-section';
    section.innerHTML = `
      <h2>Teachers Using Our Materials</h2>
      <p class="tc-muted">Educators around the country bring our interactive modules into their classrooms.</p>
      <div class="grid grid-fit-250 team-grid">
        ${profiles.map(t => {
          const quotes = featuredReviews.filter(r => r.teacherUid === t.uid).slice(0, 2);
          return `
          <div class="card team-card tc-teacher-card">
            <div class="tc-teacher-photo">
              ${t.photo?.medium ? `<img src="${esc(t.photo.medium)}" alt="${esc(t.name || '')}" loading="lazy">`
                : `<div class="photo-placeholder">${esc((t.name || '?')[0])}</div>`}
            </div>
            <h3>${esc(t.name || '')}</h3>
            <p class="tc-teacher-school">${esc(t.school || '')}${t.subjectArea ? ' · ' + esc(t.subjectArea) : ''}</p>
            ${t.blurb ? `<p class="tc-muted">${esc(t.blurb)}</p>` : ''}
            ${quotes.map(q => `<blockquote class="tc-teacher-quote">${starsDisplay(q.rating)} &ldquo;${esc(q.text)}&rdquo;<footer>— ${esc(q.authorName || 'Student')}</footer></blockquote>`).join('')}
          </div>`;
        }).join('')}
      </div>`;
    appEl.appendChild(section);
  }

  /* ================================================================
     EXPORTS
     ================================================================ */
  ML.TC_DB = TC_DB;
  ML.renderTeacherDashboard = renderTeacherDashboard;
  ML.wireTeacherDashboard = wireTeacherDashboard;
  ML.renderStudentDashboard = renderStudentDashboard;
  ML.wireStudentDashboard = wireStudentDashboard;
  ML.wireTeacherClassPage = wireTeacherClassPage;
  ML.joinClassWithCode = joinClassWithCode;
  ML.tcCanViewModules = tcCanViewModules;
  ML.renderClassReviewsSection = renderClassReviewsSection;
  ML.renderFeaturedTeachersSection = renderFeaturedTeachersSection;
})();
